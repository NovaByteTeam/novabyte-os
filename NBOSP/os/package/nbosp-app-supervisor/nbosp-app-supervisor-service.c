#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <sys/time.h>
#include <unistd.h>

#define SOCKET_PATH "/run/nbosp-app-supervisor.sock"
#define HELPER_PATH "/usr/sbin/nbosp-app-supervisor"
#define DESKTOP_UID 1000
#define MAX_REQUEST 1024
#define MAX_HELPER_OUTPUT 32
#define IO_TIMEOUT_MS 120000

static bool valid_app_id(const char *id)
{
	size_t i;

	if (!id || !id[0] || strlen(id) > 63)
		return false;
	if (!((id[0] >= 'a' && id[0] <= 'z') ||
	      (id[0] >= '0' && id[0] <= '9')))
		return false;
	for (i = 0; id[i]; i++) {
		char c = id[i];
		if (!((c >= 'a' && c <= 'z') ||
		      (c >= '0' && c <= '9') ||
		      c == '.' || c == '_' || c == '-'))
			return false;
		if (c == '.' && id[i + 1] == '.')
			return false;
	}
	return true;
}

static int send_response(int fd, const char *message)
{
	size_t length = strlen(message);
	ssize_t sent;

	do {
		sent = send(fd, message, length, MSG_NOSIGNAL);
	} while (sent < 0 && errno == EINTR);
	return sent == (ssize_t)length ? 0 : -1;
}

static int provision_app(const char *app_id, unsigned int *uid_out)
{
	char output[MAX_HELPER_OUTPUT];
	char *end = NULL;
	char *const child_argv[] = {
		(char *)HELPER_PATH,
		(char *)"provision-uid",
		(char *)app_id,
		NULL,
	};
	char *const child_env[] = {
		(char *)"PATH=/usr/sbin:/usr/bin:/sbin:/bin",
		(char *)"LANG=C",
		NULL,
	};
	struct pollfd pollfd;
	size_t used = 0;
	size_t i;
	unsigned long parsed_uid;
	int output_pipe[2];
	pid_t child;
	int child_status;
	pid_t waited;

	if (pipe2(output_pipe, O_CLOEXEC) < 0)
		return -1;
	child = fork();
	if (child < 0) {
		close(output_pipe[0]);
		close(output_pipe[1]);
		return -1;
	}
	if (child == 0) {
		close(output_pipe[0]);
		if (dup2(output_pipe[1], STDOUT_FILENO) < 0)
			_exit(126);
		close(output_pipe[1]);
		execve(HELPER_PATH, child_argv, child_env);
		_exit(127);
	}

	close(output_pipe[1]);
	pollfd.fd = output_pipe[0];
	pollfd.events = POLLIN | POLLHUP;
	while (used < sizeof(output) - 1) {
		int ready;
		ssize_t count;

		do {
			ready = poll(&pollfd, 1, IO_TIMEOUT_MS);
		} while (ready < 0 && errno == EINTR);
		if (ready <= 0) {
			if (ready == 0)
				errno = ETIMEDOUT;
			goto fail_child;
		}
		do {
			count = read(output_pipe[0], output + used,
				     sizeof(output) - 1 - used);
		} while (count < 0 && errno == EINTR);
		if (count < 0)
			goto fail_child;
		if (count == 0)
			break;
		used += (size_t)count;
	}
	if (used == sizeof(output) - 1) {
		errno = EOVERFLOW;
		goto fail_child;
	}
	close(output_pipe[0]);
	output[used] = '\0';
	do {
		waited = waitpid(child, &child_status, 0);
	} while (waited < 0 && errno == EINTR);
	if (waited != child || !WIFEXITED(child_status) ||
	    WEXITSTATUS(child_status) != 0) {
		errno = EIO;
		return -1;
	}
	if (used < 2 || output[used - 1] != '\n') {
		errno = EPROTO;
		return -1;
	}
	for (i = 0; i < used - 1; i++) {
		if (output[i] < '0' || output[i] > '9') {
			errno = EPROTO;
			return -1;
		}
	}
	output[used - 1] = '\0';
	errno = 0;
	parsed_uid = strtoul(output, &end, 10);
	if (errno || end == output || *end ||
	    parsed_uid < 20000 || parsed_uid >= 60000) {
		errno = EPROTO;
		return -1;
	}
	*uid_out = (unsigned int)parsed_uid;
	return 0;

fail_child:
	{
		int saved_errno = errno;
		close(output_pipe[0]);
		kill(child, SIGKILL);
		while (waitpid(child, NULL, 0) < 0 && errno == EINTR)
			;
		errno = saved_errno;
		return -1;
	}
}

static int run_helper(char *const child_argv[], char *output,
		      size_t output_size, size_t *used_out)
{
	char *const child_env[] = {
		(char *)"PATH=/usr/sbin:/usr/bin:/sbin:/bin",
		(char *)"LANG=C",
		NULL,
	};
	struct pollfd pollfd;
	size_t used = 0;
	int output_pipe[2], child_status;
	pid_t child, waited;

	if (pipe2(output_pipe, O_CLOEXEC) < 0)
		return -1;
	child = fork();
	if (child < 0) {
		close(output_pipe[0]);
		close(output_pipe[1]);
		return -1;
	}
	if (child == 0) {
		close(output_pipe[0]);
		if (dup2(output_pipe[1], STDOUT_FILENO) < 0)
			_exit(126);
		close(output_pipe[1]);
		execve(HELPER_PATH, child_argv, child_env);
		_exit(127);
	}
	close(output_pipe[1]);
	pollfd.fd = output_pipe[0];
	pollfd.events = POLLIN | POLLHUP;
	while (used < output_size - 1) {
		int ready;
		ssize_t count;

		do {
			ready = poll(&pollfd, 1, IO_TIMEOUT_MS);
		} while (ready < 0 && errno == EINTR);
		if (ready <= 0) {
			if (ready == 0)
				errno = ETIMEDOUT;
			goto fail;
		}
		do {
			count = read(output_pipe[0], output + used,
				     output_size - 1 - used);
		} while (count < 0 && errno == EINTR);
		if (count < 0)
			goto fail;
		if (count == 0)
			break;
		used += (size_t)count;
	}
	if (used == output_size - 1) {
		errno = EOVERFLOW;
		goto fail;
	}
	close(output_pipe[0]);
	output[used] = '\0';
	do {
		waited = waitpid(child, &child_status, 0);
	} while (waited < 0 && errno == EINTR);
	if (waited != child || !WIFEXITED(child_status) ||
	    WEXITSTATUS(child_status) != 0) {
		errno = EIO;
		return -1;
	}
	*used_out = used;
	return 0;

fail:
	{
		int saved_errno = errno;
		close(output_pipe[0]);
		kill(child, SIGKILL);
		while (waitpid(child, NULL, 0) < 0 && errno == EINTR)
			;
		errno = saved_errno;
		return -1;
	}
}

static int install_app(const char *app_id, const char *entry)
{
	char output[MAX_HELPER_OUTPUT];
	char *const child_argv[] = {
		(char *)HELPER_PATH, (char *)"install", (char *)app_id,
		(char *)entry, NULL,
	};
	size_t used;

	if (run_helper(child_argv, output, sizeof(output), &used) < 0)
		return -1;
	if (!used || output[used - 1] != '\n') {
		errno = EPROTO;
		return -1;
	}
	return 0;
}

static int uninstall_app(const char *app_id)
{
	char output[MAX_HELPER_OUTPUT];
	char *const child_argv[] = {
		(char *)HELPER_PATH, (char *)"uninstall", (char *)app_id, NULL,
	};
	size_t used;

	if (run_helper(child_argv, output, sizeof(output), &used) < 0)
		return -1;
	if (!used || output[used - 1] != '\n') {
		errno = EPROTO;
		return -1;
	}
	return 0;
}

static int launch_app(const char *app_id, const char *port, const char *token,
		      unsigned long *pid_out)
{
	char output[MAX_HELPER_OUTPUT];
	char *end = NULL;
	char *const child_argv[] = {
		(char *)HELPER_PATH, (char *)"launch", (char *)app_id,
		(char *)port, (char *)token, NULL,
	};
	size_t used, i;
	unsigned long parsed_pid;

	if (run_helper(child_argv, output, sizeof(output), &used) < 0)
		return -1;
	if (used < 2 || output[used - 1] != '\n') {
		errno = EPROTO;
		return -1;
	}
	for (i = 0; i < used - 1; i++)
		if (output[i] < '0' || output[i] > '9') {
			errno = EPROTO;
			return -1;
		}
	output[used - 1] = '\0';
	parsed_pid = strtoul(output, &end, 10);
	if (end == output || *end || parsed_pid < 2) {
		errno = EPROTO;
		return -1;
	}
	*pid_out = parsed_pid;
	return 0;
}

static int terminate_app(const char *app_id, const char *pid)
{
	char output[MAX_HELPER_OUTPUT];
	char *const child_argv[] = {
		(char *)HELPER_PATH, (char *)"terminate", (char *)app_id,
		(char *)pid, NULL,
	};
	size_t used;

	if (!pid || !pid[0] || strlen(pid) > 10)
		return -1;
	for (size_t i = 0; pid[i]; i++)
		if (pid[i] < '0' || pid[i] > '9')
			return -1;
	if (run_helper(child_argv, output, sizeof(output), &used) < 0)
		return -1;
	if (used != sizeof("terminated\n") - 1 ||
	    memcmp(output, "terminated\n", used) != 0) {
		errno = EPROTO;
		return -1;
	}
	return 0;
}

static bool valid_entry(const char *entry)
{
	const char *part;
	const char *cursor;

	if (!entry || !entry[0] || entry[0] == '/' || strlen(entry) > 512)
		return false;
	part = entry;
	for (cursor = entry; ; cursor++) {
		unsigned char c = (unsigned char)*cursor;
		if (c == '/' || c == '\0') {
			size_t length = (size_t)(cursor - part);
			if (!length || (length == 1 && part[0] == '.') ||
			    (length == 2 && part[0] == '.' && part[1] == '.'))
				return false;
			if (!c)
				break;
			part = cursor + 1;
		} else if (!((c >= 'a' && c <= 'z') ||
			     (c >= 'A' && c <= 'Z') ||
			     (c >= '0' && c <= '9') || c == '.' ||
			     c == '_' || c == '-')) {
			return false;
		}
	}
	return true;
}

static bool valid_token(const char *token)
{
	size_t i;

	if (!token || strlen(token) != 64)
		return false;
	for (i = 0; i < 64; i++)
		if (!((token[i] >= '0' && token[i] <= '9') ||
		      (token[i] >= 'a' && token[i] <= 'f')))
			return false;
	return true;
}

static void handle_client(int fd)
{
	struct ucred credentials;
	socklen_t credentials_size = sizeof(credentials);
	struct timeval receive_timeout = { .tv_sec = 5, .tv_usec = 0 };
	char request[MAX_REQUEST + 1];
	char response[64];
	size_t used = 0;
	ssize_t length;
	unsigned int uid;
	unsigned long pid;

	if (setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &receive_timeout,
		       sizeof(receive_timeout)) < 0 ||
	    getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials,
		       &credentials_size) < 0 ||
	    credentials_size != sizeof(credentials) ||
	    credentials.uid != DESKTOP_UID) {
		send_response(fd, "ERR unauthorized\n");
		return;
	}

	while (used < MAX_REQUEST) {
		do {
			length = recv(fd, request + used, MAX_REQUEST - used, 0);
		} while (length < 0 && errno == EINTR);
		if (length <= 0)
			break;
		if (memchr(request + used, '\0', (size_t)length) != NULL) {
			send_response(fd, "ERR invalid-request\n");
			return;
		}
		used += (size_t)length;
		if (memchr(request, '\n', used))
			break;
	}
	if (!used || used >= MAX_REQUEST || request[used - 1] != '\n' ||
	    memchr(request, '\n', used - 1) != NULL) {
		send_response(fd, "ERR invalid-request\n");
		return;
	}
	request[--used] = '\0';
	{
		char *save = NULL;
		char *operation = strtok_r(request, " ", &save);
		char *app_id = strtok_r(NULL, " ", &save);
		char *arg3 = strtok_r(NULL, " ", &save);
		char *arg4 = strtok_r(NULL, " ", &save);
		char *extra = strtok_r(NULL, " ", &save);
		if (!operation || !app_id || !valid_app_id(app_id) || extra) {
			send_response(fd, "ERR invalid-request\n");
			return;
		}
		if (strcmp(operation, "PROVISION") == 0 && !arg3 && !arg4) {
			if (provision_app(app_id, &uid) < 0) {
				send_response(fd, "ERR provisioning-failed\n");
				return;
			}
			snprintf(response, sizeof(response), "OK %u\n", uid);
		} else if (strcmp(operation, "INSTALL") == 0 && arg3 && !arg4 &&
			   valid_entry(arg3)) {
			if (install_app(app_id, arg3) < 0) {
				send_response(fd, "ERR installation-failed\n");
				return;
			}
			snprintf(response, sizeof(response), "OK installed\n");
		} else if (strcmp(operation, "UNINSTALL") == 0 && !arg3 && !arg4) {
			if (uninstall_app(app_id) < 0) {
				send_response(fd, "ERR uninstallation-failed\n");
				return;
			}
			snprintf(response, sizeof(response), "OK uninstalled\n");
		} else if (strcmp(operation, "LAUNCH") == 0 && arg3 && arg4) {
			if (!valid_token(arg4)) {
				send_response(fd, "ERR invalid-request\n");
				return;
			}
			if (launch_app(app_id, arg3, arg4, &pid) < 0) {
				send_response(fd, "ERR launch-failed\n");
				return;
			}
			snprintf(response, sizeof(response), "OK %lu\n", pid);
		} else if (strcmp(operation, "TERMINATE") == 0 && arg3 && !arg4) {
			if (terminate_app(app_id, arg3) < 0) {
				send_response(fd, "ERR termination-failed\n");
				return;
			}
			snprintf(response, sizeof(response), "OK terminated\n");
		} else {
			send_response(fd, "ERR unsupported-request\n");
			return;
		}
	}
	send_response(fd, response);
}

static int prepare_socket_path(void)
{
	struct stat st;

	if (lstat(SOCKET_PATH, &st) < 0) {
		if (errno == ENOENT)
			return 0;
		return -1;
	}
	if (!S_ISSOCK(st.st_mode) || st.st_uid != 0 ||
	    (st.st_mode & 0022) != 0) {
		errno = EPERM;
		return -1;
	}
	return unlink(SOCKET_PATH);
}

int main(void)
{
	struct sockaddr_un address = { .sun_family = AF_UNIX };
	int server_fd;

#if !defined(__linux__) || !defined(__x86_64__)
	fprintf(stderr, "NBOSP app supervisor service supports Linux x86_64 only\n");
	return 1;
#endif
	if (geteuid() != 0) {
		fprintf(stderr, "NBOSP app supervisor service must run as root\n");
		return 1;
	}
	umask(0077);
	if (prepare_socket_path() < 0) {
		perror("prepare app supervisor socket");
		return 1;
	}
	server_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (server_fd < 0) {
		perror("create app supervisor socket");
		return 1;
	}
	if (strlen(SOCKET_PATH) >= sizeof(address.sun_path)) {
		errno = ENAMETOOLONG;
		perror("app supervisor socket path");
		close(server_fd);
		return 1;
	}
	memcpy(address.sun_path, SOCKET_PATH, strlen(SOCKET_PATH) + 1);
	if (bind(server_fd, (struct sockaddr *)&address, sizeof(address)) < 0 ||
	    chown(SOCKET_PATH, 0, DESKTOP_UID) < 0 ||
	    chmod(SOCKET_PATH, 0660) < 0 ||
	    listen(server_fd, 8) < 0) {
		perror("bind app supervisor socket");
		close(server_fd);
		unlink(SOCKET_PATH);
		return 1;
	}
	for (;;) {
		int client_fd = accept4(server_fd, NULL, NULL, SOCK_CLOEXEC);
		if (client_fd < 0) {
			if (errno == EINTR)
				continue;
			perror("accept app supervisor request");
			continue;
		}
		handle_client(client_fd);
		close(client_fd);
	}
}
