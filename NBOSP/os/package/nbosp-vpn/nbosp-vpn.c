#define _GNU_SOURCE
#include <arpa/inet.h>
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define PROFILE_DIR "/etc/novabyte-vpn"
#define PROFILE_PATH_FMT PROFILE_DIR "/%s.conf"
#define ACTIVE_PATH PROFILE_DIR "/active"
#define RUNTIME_DIR "/run/novabyte-vpn"
#define RUNTIME_CONFIG RUNTIME_DIR "/wg0.conf"
#define RUNTIME_STATUS RUNTIME_DIR "/status"
#define MAX_CONFIG 16384
#define MAX_CANONICAL 8192
/* BusyBox ip rejects routing table IDs above 1023, so 51820 cannot be used. */
#define VPN_ROUTE_TABLE "820"

struct profile {
	char canonical[MAX_CANONICAL];
	char address[INET_ADDRSTRLEN];
};

struct active_state {
	char app_id[129];
	char address[INET_ADDRSTRLEN];
};

static void report(const char *format, ...)
{
	va_list args;

	va_start(args, format);
	vfprintf(stderr, format, args);
	fputc('\n', stderr);
	va_end(args);
}

static int ensure_directory(const char *path, mode_t mode)
{
	struct stat st;

	if (mkdir(path, mode) == -1 && errno != EEXIST) {
		report("Cannot create %s: %s", path, strerror(errno));
		return -1;
	}
	if (lstat(path, &st) == -1 || !S_ISDIR(st.st_mode) ||
	    st.st_uid != 0 || (st.st_mode & 0022) != 0) {
		report("Unsafe directory: %s", path);
		return -1;
	}
	return 0;
}

static int ensure_directories(void)
{
	if (ensure_directory(PROFILE_DIR, 0700) == -1)
		return -1;
	if (ensure_directory(RUNTIME_DIR, 0755) == -1)
		return -1;
	return 0;
}

static bool valid_app_id(const char *app_id)
{
	size_t i, length;

	if (!app_id)
		return false;
	length = strlen(app_id);
	if (length == 0 || length > 128 ||
	    !isalnum((unsigned char)app_id[0]))
		return false;
	for (i = 0; i < length; i++) {
		unsigned char c = (unsigned char)app_id[i];
		if (!isalnum(c) && c != '.' && c != '-' && c != '_')
			return false;
	}
	return true;
}

static int read_stdin(char *buffer, size_t capacity)
{
	size_t used = 0;
	ssize_t count;

	while (used < capacity) {
		count = read(STDIN_FILENO, buffer + used, capacity - used);
		if (count < 0) {
			if (errno == EINTR)
				continue;
			report("Cannot read VPN profile: %s", strerror(errno));
			return -1;
		}
		if (count == 0)
			break;
		used += (size_t)count;
	}
	if (used == capacity) {
		report("VPN profile exceeds the size limit");
		return -1;
	}
	if (memchr(buffer, '\0', used)) {
		report("VPN profile contains a NUL byte");
		return -1;
	}
	buffer[used] = '\0';
	return (int)used;
}

static char *trim(char *value)
{
	char *end;

	while (isspace((unsigned char)*value))
		value++;
	end = value + strlen(value);
	while (end > value && isspace((unsigned char)end[-1]))
		*--end = '\0';
	return value;
}

static bool valid_key(const char *value)
{
	size_t i;

	if (strlen(value) != 44 || value[43] != '=')
		return false;
	for (i = 0; i < 43; i++) {
		if (!isalnum((unsigned char)value[i]) &&
		    value[i] != '+' && value[i] != '/')
			return false;
	}
	return true;
}

static bool valid_cidr(char *value, bool ipv4_only, char *host_out,
		       size_t host_capacity)
{
	char *slash = strchr(value, '/');
	char *end = NULL;
	unsigned long prefix;
	unsigned char address[16];
	int family;
	size_t address_length;

	if (!slash || !slash[1] || strchr(slash + 1, '/'))
		return false;
	*slash = '\0';
	errno = 0;
	prefix = strtoul(slash + 1, &end, 10);
	if (errno || !end || *end != '\0')
		return false;

	if (inet_pton(AF_INET, value, address) == 1) {
		family = AF_INET;
		address_length = INET_ADDRSTRLEN;
		if (prefix > 32)
			return false;
	} else if (!ipv4_only && inet_pton(AF_INET6, value, address) == 1) {
		family = AF_INET6;
		address_length = INET6_ADDRSTRLEN;
		if (prefix > 128)
			return false;
	} else {
		return false;
	}
	if (host_out && (!inet_ntop(family, address, host_out, host_capacity) ||
			 address_length > host_capacity))
		return false;
	*slash = '/';
	return true;
}

static bool valid_allowed_ips(char *value)
{
	char copy[2048];
	char *save = NULL, *part;
	bool found = false;

	if (strlen(value) >= sizeof(copy))
		return false;
	strcpy(copy, value);
	for (part = strtok_r(copy, ",", &save); part;
	     part = strtok_r(NULL, ",", &save)) {
		if (!valid_cidr(part, false, NULL, 0))
			return false;
		found = true;
	}
	return found && value[0] != ',' && value[strlen(value) - 1] != ',' &&
	       strstr(value, ",,") == NULL;
}

static bool valid_endpoint(const char *value)
{
	const char *host = value, *port_text;
	char host_buffer[256];
	char *end = NULL;
	unsigned long port;
	size_t host_length;

	if (*value == '[') {
		const char *close = strchr(value, ']');
		if (!close || close[1] != ':')
			return false;
		host = value + 1;
		host_length = (size_t)(close - host);
		if (host_length >= sizeof(host_buffer))
			return false;
		memcpy(host_buffer, host, host_length);
		host_buffer[host_length] = '\0';
		{
			struct in6_addr address;
			if (inet_pton(AF_INET6, host_buffer, &address) != 1)
				return false;
		}
		port_text = close + 2;
	} else {
		const char *colon = strrchr(value, ':');
		size_t i;
		if (!colon || strchr(value, ':') != colon)
			return false;
		host_length = (size_t)(colon - value);
		if (host_length == 0 || host_length >= sizeof(host_buffer))
			return false;
		memcpy(host_buffer, value, host_length);
		host_buffer[host_length] = '\0';
		if (host_buffer[0] == '.' || host_buffer[host_length - 1] == '.')
			return false;
		for (i = 0; i < host_length; i++) {
			unsigned char c = (unsigned char)host_buffer[i];
			if (!isalnum(c) && c != '.' && c != '-')
				return false;
		}
		port_text = colon + 1;
	}
	if (!*port_text)
		return false;
	errno = 0;
	port = strtoul(port_text, &end, 10);
	return !errno && end && *end == '\0' && port > 0 && port <= 65535;
}

static int append_config(struct profile *profile, const char *format, ...)
{
	va_list args;
	size_t used = strlen(profile->canonical);
	int written;

	va_start(args, format);
	written = vsnprintf(profile->canonical + used,
			    sizeof(profile->canonical) - used, format, args);
	va_end(args);
	if (written < 0 || (size_t)written >=
	    sizeof(profile->canonical) - used) {
		report("VPN profile exceeds the canonical size limit");
		return -1;
	}
	return 0;
}

static int parse_profile(char *input, struct profile *profile)
{
	enum { SECTION_NONE, SECTION_INTERFACE, SECTION_PEER } section = SECTION_NONE;
	bool have_private = false, have_address = false;
	bool have_public = false, have_allowed = false, have_endpoint = false;
	bool have_psk = false, have_keepalive = false;
	char private_key[64] = "", address_cidr[64] = "";
	char public_key[64] = "", allowed_ips[2048] = "";
	char endpoint[320] = "", preshared_key[64] = "";
	char keepalive[8] = "";
	char *save = NULL, *line;

	for (line = strtok_r(input, "\n", &save); line;
	     line = strtok_r(NULL, "\n", &save)) {
		char *key, *value, *equals;

		if (strchr(line, '\r'))
			*strchr(line, '\r') = '\0';
		line = trim(line);
		if (!*line || *line == '#' || *line == ';')
			continue;
		if (strcmp(line, "[Interface]") == 0 && section == SECTION_NONE) {
			section = SECTION_INTERFACE;
			continue;
		}
		if (strcmp(line, "[Peer]") == 0 &&
		    section == SECTION_INTERFACE && have_private && have_address) {
			section = SECTION_PEER;
			continue;
		}
		equals = strchr(line, '=');
		if (!equals || section == SECTION_NONE) {
			report("Invalid WireGuard profile syntax");
			return -1;
		}
		*equals = '\0';
		key = trim(line);
		value = trim(equals + 1);
		if (!*value || strchr(value, '\n') || strchr(value, '\r')) {
			report("Invalid empty or multiline WireGuard setting");
			return -1;
		}

		if (section == SECTION_INTERFACE) {
			if (!strcasecmp(key, "PrivateKey") && !have_private &&
			    valid_key(value)) {
				strcpy(private_key, value);
				have_private = true;
			} else if (!strcasecmp(key, "Address") && !have_address) {
				char address_copy[64];
				if (strlen(value) >= sizeof(address_copy))
					return -1;
				strcpy(address_copy, value);
				if (!valid_cidr(address_copy, true, profile->address,
						sizeof(profile->address))) {
					report("WireGuard Address must be one IPv4 CIDR");
					return -1;
				}
				strcpy(address_cidr, value);
				have_address = true;
			} else {
				report("Unsupported or duplicate [Interface] setting: %s", key);
				return -1;
			}
		} else {
			if (!strcasecmp(key, "PublicKey") && !have_public &&
			    valid_key(value)) {
				strcpy(public_key, value);
				have_public = true;
			} else if (!strcasecmp(key, "PresharedKey") && !have_psk &&
				   valid_key(value)) {
				strcpy(preshared_key, value);
				have_psk = true;
			} else if (!strcasecmp(key, "AllowedIPs") && !have_allowed &&
				   valid_allowed_ips(value)) {
				strcpy(allowed_ips, value);
				have_allowed = true;
			} else if (!strcasecmp(key, "Endpoint") && !have_endpoint &&
				   strlen(value) < sizeof(endpoint) &&
				   valid_endpoint(value)) {
				strcpy(endpoint, value);
				have_endpoint = true;
			} else if (!strcasecmp(key, "PersistentKeepalive") &&
				   !have_keepalive) {
				char *end = NULL;
				long number = strtol(value, &end, 10);
				if (!end || *end || number < 0 || number > 65535) {
					report("Invalid PersistentKeepalive value");
					return -1;
				}
				snprintf(keepalive, sizeof(keepalive), "%ld", number);
				have_keepalive = true;
			} else {
				report("Unsupported or duplicate [Peer] setting: %s", key);
				return -1;
			}
		}
	}

	if (section != SECTION_PEER || !have_private || !have_address ||
	    !have_public || !have_allowed || !have_endpoint) {
		report("WireGuard profile is missing a required Interface or Peer setting");
		return -1;
	}
	if (append_config(profile,
			  "[Interface]\nPrivateKey = %s\nAddress = %s\nTable = off\n\n"
			  "[Peer]\nPublicKey = %s\nAllowedIPs = %s\nEndpoint = %s\n",
			  private_key, address_cidr, public_key, allowed_ips,
			  endpoint) == -1)
		return -1;
	if (have_psk &&
	    append_config(profile, "PresharedKey = %s\n", preshared_key) == -1)
		return -1;
	if (have_keepalive &&
	    append_config(profile, "PersistentKeepalive = %s\n", keepalive) == -1)
		return -1;
	return 0;
}

static int write_atomic(const char *path, const char *contents, mode_t mode)
{
	char temporary[PATH_MAX];
	int fd, result = -1;
	size_t length = strlen(contents), offset = 0;
	ssize_t written;

	if (snprintf(temporary, sizeof(temporary), "%s.tmp.%ld", path,
		     (long)getpid()) >= (int)sizeof(temporary))
		return -1;
	fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
	if (fd == -1) {
		report("Cannot create temporary file: %s", strerror(errno));
		return -1;
	}
	while (offset < length) {
		written = write(fd, contents + offset, length - offset);
		if (written < 0) {
			if (errno == EINTR)
				continue;
			report("Cannot write profile: %s", strerror(errno));
			goto cleanup;
		}
		offset += (size_t)written;
	}
	if (fchmod(fd, mode) == -1 || fsync(fd) == -1) {
		report("Cannot secure profile: %s", strerror(errno));
		goto cleanup;
	}
	if (close(fd) == -1) {
		fd = -1;
		goto cleanup;
	}
	fd = -1;
	if (rename(temporary, path) == -1) {
		report("Cannot install profile: %s", strerror(errno));
		goto cleanup;
	}
	result = 0;
cleanup:
	if (fd != -1)
		close(fd);
	if (result != 0)
		unlink(temporary);
	return result;
}

static int run_command(const char *program, char *const argv[])
{
	pid_t child;
	int status;

	child = fork();
	if (child == -1) {
		report("Cannot start %s: %s", program, strerror(errno));
		return -1;
	}
	if (child == 0) {
		if (setuid(0) == -1) {
			report("Cannot retain root privileges for %s: %s", program,
			       strerror(errno));
			_exit(126);
		}
		clearenv();
		setenv("PATH", "/usr/sbin:/usr/bin:/sbin:/bin", 1);
		setenv("WG_ENDPOINT_RESOLUTION_RETRIES", "3", 1);
		umask(077);
		execvp(program, argv);
		_exit(127);
	}
	while (waitpid(child, &status, 0) == -1) {
		if (errno != EINTR) {
			report("Cannot wait for %s: %s", program, strerror(errno));
			return -1;
		}
	}
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
		report("%s failed", program);
		return -1;
	}
	return 0;
}

static int run_ip(char *const argv[])
{
	return run_command("ip", argv);
}

static bool rule_uses_vpn_table(const char *line)
{
	static const char needle[] = "lookup " VPN_ROUTE_TABLE;
	const char *hit = strstr(line, needle);
	char after;

	if (!hit)
		return false;
	after = hit[sizeof(needle) - 1];
	return after == '\0' || after == ' ' || after == '\t';
}

static int ip_rule_exists(const char *address)
{
	int pipe_fds[2], status;
	char output[8192];
	char prefix[INET_ADDRSTRLEN + 32];
	char *save = NULL, *line;
	size_t used = 0;
	bool overflow = false;
	pid_t child;
	ssize_t count;

	if (pipe(pipe_fds) == -1) {
		report("Cannot inspect VPN routing rules: %s", strerror(errno));
		return -1;
	}
	child = fork();
	if (child == -1) {
		report("Cannot inspect VPN routing rules: %s", strerror(errno));
		close(pipe_fds[0]);
		close(pipe_fds[1]);
		return -1;
	}
	if (child == 0) {
		close(pipe_fds[0]);
		if (dup2(pipe_fds[1], STDOUT_FILENO) == -1)
			_exit(126);
		close(pipe_fds[1]);
		clearenv();
		setenv("PATH", "/usr/sbin:/usr/bin:/sbin:/bin", 1);
		execlp("ip", "ip", "-4", "rule", "show", (char *)NULL);
		_exit(127);
	}
	close(pipe_fds[1]);
	while ((count = read(pipe_fds[0], output + used,
			     sizeof(output) - 1 - used)) != 0) {
		if (count < 0) {
			if (errno == EINTR)
				continue;
			report("Cannot read VPN routing rules: %s", strerror(errno));
			close(pipe_fds[0]);
			while (waitpid(child, &status, 0) == -1 && errno == EINTR)
				;
			return -1;
		}
		used += (size_t)count;
		if (used == sizeof(output) - 1) {
			char discard[256];
			overflow = true;
			while ((count = read(pipe_fds[0], discard,
					     sizeof(discard))) != 0) {
				if (count < 0 && errno == EINTR)
					continue;
				if (count < 0)
					break;
			}
			break;
		}
	}
	close(pipe_fds[0]);
	while (waitpid(child, &status, 0) == -1) {
		if (errno != EINTR) {
			report("Cannot wait for routing-rule query: %s",
			       strerror(errno));
			return -1;
		}
	}
	if (overflow || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
		report("Cannot verify VPN routing rules");
		return -1;
	}
	output[used] = '\0';
	if (snprintf(prefix, sizeof(prefix), "1000: from %s", address) >=
	    (int)sizeof(prefix))
		return -1;
	for (line = strtok_r(output, "\n", &save); line;
	     line = strtok_r(NULL, "\n", &save)) {
		size_t prefix_length = strlen(prefix);
		size_t line_length = strlen(line);
		char next;
		if (line_length <= prefix_length ||
		    strncmp(line, prefix, prefix_length) != 0)
			continue;
		next = line[prefix_length];
		if ((next == ' ' || next == '/') && rule_uses_vpn_table(line))
			return 1;
	}
	return 0;
}

static int profile_path(const char *app_id, char *path, size_t capacity)
{
	int length = snprintf(path, capacity, PROFILE_PATH_FMT, app_id);
	return length > 0 && (size_t)length < capacity ? 0 : -1;
}

static int read_active(struct active_state *state)
{
	FILE *file;
	int extra;

	file = fopen(ACTIVE_PATH, "r");
	if (!file)
		return -1;
	if (!fgets(state->app_id, sizeof(state->app_id), file) ||
	    !fgets(state->address, sizeof(state->address), file) ||
	    (extra = fgetc(file)) != EOF || ferror(file)) {
		fclose(file);
		return -1;
	}
	fclose(file);
	state->app_id[strcspn(state->app_id, "\r\n")] = '\0';
	state->address[strcspn(state->address, "\r\n")] = '\0';
	{
		struct in_addr address;
		if (!valid_app_id(state->app_id) ||
		    inet_pton(AF_INET, state->address, &address) != 1)
			return -1;
	}
	return 0;
}

static int remove_runtime_state(void)
{
	int result = 0;

	if (unlink(RUNTIME_STATUS) == -1 && errno != ENOENT) {
		report("Cannot remove VPN status: %s", strerror(errno));
		result = -1;
	}
	if (unlink(RUNTIME_CONFIG) == -1 && errno != ENOENT) {
		report("Cannot remove runtime VPN config: %s", strerror(errno));
		result = -1;
	}
	return result;
}

static int bring_down(void)
{
	struct active_state state;
	struct stat interface_stat, active_stat;
	bool has_active = read_active(&state) == 0;
	bool cleanup_failed = false;
	char source[INET_ADDRSTRLEN + 4];
	char *rule_argv[11];
	char *route_argv[] = { "ip", "-4", "route", "flush", "table", VPN_ROUTE_TABLE, NULL };
	char *down_argv[] = { "wg-quick", "down", RUNTIME_CONFIG, NULL };

	if (!has_active && lstat(ACTIVE_PATH, &active_stat) == 0) {
		report("Invalid VPN active-state file; refusing to discard it");
		return -1;
	}
	if (has_active) {
		int rule_exists;
		if (snprintf(source, sizeof(source), "%s/32", state.address) >=
		    (int)sizeof(source)) {
			report("Invalid VPN source address in active state");
			return -1;
		}
		rule_argv[0] = "ip";
		rule_argv[1] = "-4";
		rule_argv[2] = "rule";
		rule_argv[3] = "del";
		rule_argv[4] = "priority";
		rule_argv[5] = "1000";
		rule_argv[6] = "from";
		rule_argv[7] = source;
		rule_argv[8] = "table";
		rule_argv[9] = VPN_ROUTE_TABLE;
		rule_argv[10] = NULL;
		rule_exists = ip_rule_exists(state.address);
		if (rule_exists == -1 ||
		    (rule_exists == 1 && run_ip(rule_argv) == -1))
			cleanup_failed = true;
	}
	if (run_ip(route_argv) == -1)
		cleanup_failed = true;
	if (stat("/sys/class/net/wg0", &interface_stat) == 0) {
		if (run_command("/usr/bin/wg-quick", down_argv) == -1)
			cleanup_failed = true;
	} else if (errno != ENOENT) {
		report("Cannot inspect WireGuard interface: %s", strerror(errno));
		cleanup_failed = true;
	}
	if (cleanup_failed) {
		report("VPN cleanup incomplete; preserving active-state metadata");
		return -1;
	}
	if (remove_runtime_state() == -1)
		cleanup_failed = true;
	if (unlink(ACTIVE_PATH) == -1 && errno != ENOENT) {
		report("Cannot remove VPN active state: %s", strerror(errno));
		cleanup_failed = true;
	}
	return cleanup_failed ? -1 : 0;
}

static int shutdown_tunnel(void)
{
	struct active_state state;
	char active_text[256];
	bool had_active = read_active(&state) == 0;

	if (bring_down() == -1)
		return -1;
	if (!had_active)
		return 0;
	if (snprintf(active_text, sizeof(active_text), "%s\n%s\n", state.app_id,
		     state.address) >= (int)sizeof(active_text))
		return -1;
	return write_atomic(ACTIVE_PATH, active_text, 0600);
}

static int bring_up(const char *app_id)
{
	char path[PATH_MAX], profile[MAX_CONFIG + 1];
	char source[INET_ADDRSTRLEN + 4];
	const char *address_start, *address_end;
	char source_rule[INET_ADDRSTRLEN + 5];
	char *route_argv[] = { "ip", "-4", "route", "replace", "default",
			       "dev", "wg0", "table", VPN_ROUTE_TABLE, NULL };
	char *rule_argv[] = { "ip", "-4", "rule", "add", "priority", "1000",
			       "from", source_rule, "table", VPN_ROUTE_TABLE, NULL };
	char *delete_rule_argv[] = { "ip", "-4", "rule", "del", "priority",
				     "1000", "from", source_rule, "table",
				     VPN_ROUTE_TABLE, NULL };
	char active_text[256];
	bool rule_added = false, active_written = false;
	FILE *file;
	size_t read_count;
	char *up_argv[] = { "wg-quick", "up", RUNTIME_CONFIG, NULL };

	if (profile_path(app_id, path, sizeof(path)) == -1)
		return -1;
	file = fopen(path, "r");
	if (!file) {
		report("No VPN profile is registered for %s", app_id);
		return -1;
	}
	read_count = fread(profile, 1, sizeof(profile) - 1, file);
	if (ferror(file) || !feof(file) || read_count == 0) {
		fclose(file);
		report("Cannot read registered VPN profile");
		return -1;
	}
	fclose(file);
	profile[read_count] = '\0';

	address_start = strstr(profile, "Address = ");
	address_start = address_start ? address_start + strlen("Address = ") : NULL;
	address_end = address_start ? strchr(address_start, '\n') : NULL;
	if (!address_start || !address_end ||
	    (size_t)(address_end - address_start) >= sizeof(source)) {
		report("Invalid VPN source address");
		return -1;
	}
	memcpy(source, address_start, (size_t)(address_end - address_start));
	source[address_end - address_start] = '\0';
	source[strcspn(source, "\r\n")] = '\0';
	{
		char *slash = strchr(source, '/');
		if (slash)
			*slash = '\0';
	}
	{
		struct in_addr address;
		if (inet_pton(AF_INET, source, &address) != 1) {
			report("Invalid VPN source address");
			return -1;
		}
	}
	if (snprintf(source_rule, sizeof(source_rule), "%s/32", source) >=
	    (int)sizeof(source_rule)) {
		report("Invalid VPN source address");
		return -1;
	}

	if (bring_down() == -1) {
		report("Cannot start VPN while previous routing state is present");
		return -1;
	}
	if (write_atomic(RUNTIME_CONFIG, profile, 0600) == -1)
		return -1;
	if (run_command("/usr/bin/wg-quick", up_argv) == -1)
		goto failed;
	if (run_ip(route_argv) == -1)
		goto failed;

	if (run_ip(rule_argv) == -1)
		goto failed;
	rule_added = true;

	if (snprintf(active_text, sizeof(active_text), "%s\n%s\n", app_id,
		     source) >= (int)sizeof(active_text))
		goto failed;
	if (write_atomic(ACTIVE_PATH, active_text, 0600) == -1)
		goto failed;
	active_written = true;
	if (snprintf(active_text, sizeof(active_text), "%s\n%s\n", app_id,
		     source) >= (int)sizeof(active_text) ||
	    write_atomic(RUNTIME_STATUS, active_text, 0600) == -1)
		goto failed;
	return 0;

failed:
	if (active_written) {
		(void)bring_down();
	} else {
		bool cleanup_failed = false;
		bool rule_cleanup_failed = false;
		struct stat interface_stat;

		if (rule_added) {
			int rule_exists = ip_rule_exists(source);
			if (rule_exists == -1 ||
			    (rule_exists == 1 && run_ip(delete_rule_argv) == -1)) {
				cleanup_failed = true;
				rule_cleanup_failed = true;
			}
		}
		if (run_ip((char *const[]){"ip", "-4", "route", "flush",
					    "table", VPN_ROUTE_TABLE, NULL}) == -1)
			cleanup_failed = true;
		if (stat("/sys/class/net/wg0", &interface_stat) == 0) {
			if (run_command("/usr/bin/wg-quick",
					(char *const[]){"wg-quick", "down",
							RUNTIME_CONFIG, NULL}) == -1)
				cleanup_failed = true;
		} else if (errno != ENOENT) {
			report("Cannot inspect WireGuard interface: %s",
			       strerror(errno));
			cleanup_failed = true;
		}
		if (rule_cleanup_failed) {
			if (snprintf(active_text, sizeof(active_text), "%s\n%s\n",
				     app_id, source) < (int)sizeof(active_text) &&
			    write_atomic(ACTIVE_PATH, active_text, 0600) == -1)
				report("Cannot preserve VPN cleanup metadata: %s",
				       strerror(errno));
		}
		if (cleanup_failed)
			report("VPN activation cleanup incomplete; retry shutdown before reconnecting");
		else
			(void)remove_runtime_state();
	}
	return -1;
}

static int write_profile(const char *app_id)
{
	char input[MAX_CONFIG + 1], path[PATH_MAX];
	struct profile parsed = { { 0 }, { 0 } };
	int bytes;

	bytes = read_stdin(input, sizeof(input));
	if (bytes < 0 || parse_profile(input, &parsed) == -1 ||
	    profile_path(app_id, path, sizeof(path)) == -1)
		return -1;
	if (write_atomic(path, parsed.canonical, 0600) == -1)
		return -1;
	printf("{\"registered\":true,\"providerId\":\"%s\"}\n", app_id);
	return 0;
}

static int list_profiles(void)
{
	DIR *directory = opendir(PROFILE_DIR);
	struct dirent *entry;
	bool first = true;

	if (!directory)
		return -1;
	printf("[");
	while ((entry = readdir(directory)) != NULL) {
		size_t length = strlen(entry->d_name);
		char app_id[129];
		struct stat st;
		char path[PATH_MAX];
		if (length < 6 || strcmp(entry->d_name + length - 5, ".conf") != 0)
			continue;
		if (length - 5 > 128)
			continue;
		memcpy(app_id, entry->d_name, length - 5);
		app_id[length - 5] = '\0';
		if (!valid_app_id(app_id) ||
		    profile_path(app_id, path, sizeof(path)) == -1 ||
		    lstat(path, &st) == -1 || !S_ISREG(st.st_mode) ||
		    st.st_uid != 0 || (st.st_mode & 0077) != 0)
			continue;
		printf("%s\"%s\"", first ? "" : ",", app_id);
		first = false;
	}
	closedir(directory);
	printf("]\n");
	return 0;
}

static int print_status(void)
{
	struct active_state state;
	struct stat interface_stat, runtime_status_stat;

	if (read_active(&state) != 0 ||
	    stat("/sys/class/net/wg0", &interface_stat) == -1 ||
	    lstat(RUNTIME_STATUS, &runtime_status_stat) == -1 ||
	    !S_ISREG(runtime_status_stat.st_mode) ||
	    runtime_status_stat.st_uid != 0 ||
	    (runtime_status_stat.st_mode & 0077) != 0) {
		puts("{\"active\":false}");
		return 0;
	}
	printf("{\"active\":true,\"providerId\":\"%s\",\"address\":\"%s\"}\n",
	       state.app_id, state.address);
	return 0;
}

int main(int argc, char **argv)
{
	char path[PATH_MAX];
	int result = 2;

	if (geteuid() != 0) {
		report("nbosp-vpn must be installed as a root-owned setuid binary");
		return 1;
	}
	if (ensure_directories() == -1)
		return 1;
	umask(077);

	if (argc == 2 && strcmp(argv[1], "status") == 0)
		return print_status();
	if (argc == 2 && strcmp(argv[1], "list") == 0)
		return list_profiles();
	if (argc == 2 && strcmp(argv[1], "down") == 0)
		return bring_down() == 0 ? 0 : 1;
	if (argc == 2 && strcmp(argv[1], "shutdown") == 0)
		return shutdown_tunnel() == 0 ? 0 : 1;
	if (argc == 2 && strcmp(argv[1], "restore") == 0) {
		struct active_state state;
		struct stat active_stat;
		if (read_active(&state) != 0) {
			if (lstat(ACTIVE_PATH, &active_stat) == 0 || errno != ENOENT) {
				report("Invalid VPN active-state file; refusing restore");
				return 1;
			}
			return 0;
		}
		return bring_up(state.app_id) == 0 ? 0 : 1;
	}
	if (argc == 3 && strcmp(argv[1], "register") == 0 &&
	    valid_app_id(argv[2]))
		return write_profile(argv[2]) == 0 ? 0 : 1;
	if (argc == 3 && strcmp(argv[1], "up") == 0 &&
	    valid_app_id(argv[2]))
		return bring_up(argv[2]) == 0 ? 0 : 1;
	if (argc == 3 && strcmp(argv[1], "remove") == 0 &&
	    valid_app_id(argv[2])) {
		struct active_state state;
		int active_result = read_active(&state);
		struct stat active_stat;
		if (active_result != 0 &&
		    (lstat(ACTIVE_PATH, &active_stat) == 0 || errno != ENOENT)) {
			report("Invalid VPN active-state file; refusing profile removal");
			return 1;
		}
		if (active_result == 0 && strcmp(state.app_id, argv[2]) == 0 &&
		    bring_down() == -1)
			return 1;
		if (profile_path(argv[2], path, sizeof(path)) == -1 ||
		    unlink(path) == -1) {
			report("Cannot remove VPN profile: %s", strerror(errno));
			return 1;
		}
		printf("{\"removed\":true,\"providerId\":\"%s\"}\n", argv[2]);
		return 0;
	}
	report("Usage: nbosp-vpn {status|list|down|restore|register ID|up ID|remove ID}");
	return result;
}
