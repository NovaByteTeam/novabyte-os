#define _GNU_SOURCE

#include <errno.h>
#include <endian.h>
#include <dirent.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/magic.h>
#include <linux/seccomp.h>
#include <limits.h>
#include <pwd.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/file.h>
#include <sys/prctl.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/types.h>
#include <sys/xattr.h>
#include <sys/wait.h>
#include <stddef.h>
#include <sys/syscall.h>
#include <unistd.h>

#define UID_FIRST 20000U
#define UID_LIMIT 60000U
#define APP_ID_MAX 63
#define APP_MAP_MAX (UID_LIMIT - UID_FIRST)
#define STATE_DIR "nbosp-apps"
#define DATA_DIR "nbosp-app-data"
#define PACKAGE_DIR "nbosp-app-packages"
#define DESKTOP_UID 1000
#define WAYLAND_GROUP "nbosp-wayland"
#define BROKER_PORT 49173U
#define MAX_PACKAGE_FILES 4096U
#define MAX_PACKAGE_BYTES (256U * 1024U * 1024U)

extern char **environ;

struct app_record {
	char id[APP_ID_MAX + 1];
	uid_t uid;
};

struct app_map {
	struct app_record *records;
	size_t count;
};

struct copy_limits {
	size_t files;
	uint64_t bytes;
};

static int set_app_resource_limits(void)
{
	static const struct {
		int resource;
		rlim_t limit;
	} limits[] = {
		{ RLIMIT_CORE, 0 },
		{ RLIMIT_FSIZE, 512ULL * 1024ULL * 1024ULL },
		{ RLIMIT_NOFILE, 512 },
		{ RLIMIT_NPROC, 256 },
		{ RLIMIT_MEMLOCK, 0 },
		{ RLIMIT_STACK, 64ULL * 1024ULL * 1024ULL },
	};
	struct rlimit limit;
	size_t i;

	for (i = 0; i < sizeof(limits) / sizeof(limits[0]); i++) {
		limit.rlim_cur = limits[i].limit;
		limit.rlim_max = limits[i].limit;
		if (setrlimit(limits[i].resource, &limit) < 0)
			return -1;
	}
	return 0;
}

#define DENY_SYSCALL(number) \
	BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1), \
	BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA))

#define APP_DENIED_CLONE_FLAGS 0x7e020080U

static int install_app_seccomp_filter(void)
{
	static const struct sock_filter filter[] = {
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
			 offsetof(struct seccomp_data, arch)),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
			 offsetof(struct seccomp_data, nr)),
#ifdef __NR_clone3
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1),
		BPF_STMT(BPF_RET | BPF_K,
			 SECCOMP_RET_ERRNO | (ENOSYS & SECCOMP_RET_DATA)),
#endif
#ifdef __NR_clone
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 4),
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
			 offsetof(struct seccomp_data, args[0])),
		BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K,
			 APP_DENIED_CLONE_FLAGS, 0, 1),
		BPF_STMT(BPF_RET | BPF_K,
			 SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
			 offsetof(struct seccomp_data, nr)),
#endif
#ifdef __X32_SYSCALL_BIT
		BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, __X32_SYSCALL_BIT, 0, 1),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO |
			 (EPERM & SECCOMP_RET_DATA)),
#endif
#ifdef __NR_add_key
		DENY_SYSCALL(__NR_add_key),
#endif
#ifdef __NR_acct
		DENY_SYSCALL(__NR_acct),
#endif
#ifdef __NR_bpf
		DENY_SYSCALL(__NR_bpf),
#endif
#ifdef __NR_delete_module
		DENY_SYSCALL(__NR_delete_module),
#endif
#ifdef __NR_finit_module
		DENY_SYSCALL(__NR_finit_module),
#endif
#ifdef __NR_fsconfig
		DENY_SYSCALL(__NR_fsconfig),
#endif
#ifdef __NR_fsopen
		DENY_SYSCALL(__NR_fsopen),
#endif
#ifdef __NR_fspick
		DENY_SYSCALL(__NR_fspick),
#endif
#ifdef __NR_fsmount
		DENY_SYSCALL(__NR_fsmount),
#endif
#ifdef __NR_init_module
		DENY_SYSCALL(__NR_init_module),
#endif
#ifdef __NR_io_uring_enter
		DENY_SYSCALL(__NR_io_uring_enter),
#endif
#ifdef __NR_io_uring_register
		DENY_SYSCALL(__NR_io_uring_register),
#endif
#ifdef __NR_io_uring_setup
		DENY_SYSCALL(__NR_io_uring_setup),
#endif
#ifdef __NR_iopl
		DENY_SYSCALL(__NR_iopl),
#endif
#ifdef __NR_ioperm
		DENY_SYSCALL(__NR_ioperm),
#endif
#ifdef __NR_kexec_file_load
		DENY_SYSCALL(__NR_kexec_file_load),
#endif
#ifdef __NR_kexec_load
		DENY_SYSCALL(__NR_kexec_load),
#endif
#ifdef __NR_keyctl
		DENY_SYSCALL(__NR_keyctl),
#endif
#ifdef __NR_mount
		DENY_SYSCALL(__NR_mount),
#endif
#ifdef __NR_mount_setattr
		DENY_SYSCALL(__NR_mount_setattr),
#endif
#ifdef __NR_move_mount
		DENY_SYSCALL(__NR_move_mount),
#endif
#ifdef __NR_name_to_handle_at
		DENY_SYSCALL(__NR_name_to_handle_at),
#endif
#ifdef __NR_open_by_handle_at
		DENY_SYSCALL(__NR_open_by_handle_at),
#endif
#ifdef __NR_open_tree
		DENY_SYSCALL(__NR_open_tree),
#endif
#ifdef __NR_perf_event_open
		DENY_SYSCALL(__NR_perf_event_open),
#endif
#ifdef __NR_pivot_root
		DENY_SYSCALL(__NR_pivot_root),
#endif
#ifdef __NR_process_vm_readv
		DENY_SYSCALL(__NR_process_vm_readv),
#endif
#ifdef __NR_process_vm_writev
		DENY_SYSCALL(__NR_process_vm_writev),
#endif
#ifdef __NR_ptrace
		DENY_SYSCALL(__NR_ptrace),
#endif
#ifdef __NR_reboot
		DENY_SYSCALL(__NR_reboot),
#endif
#ifdef __NR_request_key
		DENY_SYSCALL(__NR_request_key),
#endif
#ifdef __NR_setns
		DENY_SYSCALL(__NR_setns),
#endif
#ifdef __NR_swapon
		DENY_SYSCALL(__NR_swapon),
#endif
#ifdef __NR_swapoff
		DENY_SYSCALL(__NR_swapoff),
#endif
#ifdef __NR_unshare
		DENY_SYSCALL(__NR_unshare),
#endif
#ifdef __NR_userfaultfd
		DENY_SYSCALL(__NR_userfaultfd),
#endif
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
	};
	struct sock_fprog program = {
		.len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
		.filter = (struct sock_filter *)filter,
	};

	return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}

#undef DENY_SYSCALL
#undef APP_DENIED_CLONE_FLAGS

static int write_cgroup_control(int cgroupfd, const char *name,
				const char *value)
{
	int fd = openat(cgroupfd, name, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
	size_t length = strlen(value);
	size_t offset = 0;

	if (fd < 0)
		return -1;
	while (offset < length) {
		ssize_t count = write(fd, value + offset, length - offset);
		if (count < 0 && errno == EINTR)
			continue;
		if (count <= 0) {
			int saved_errno = count == 0 ? EIO : errno;
			close(fd);
			errno = saved_errno;
			return -1;
		}
		offset += (size_t)count;
	}
	if (close(fd) < 0)
		return -1;
	return 0;
}

static int open_app_cgroup(uid_t uid, bool configure)
{
	char uid_name[16];
	struct stat st;
	struct statfs fs;
	int rootfd = -1, appsfd = -1, cgroupfd = -1, result = -1;

	if (snprintf(uid_name, sizeof(uid_name), "%u", (unsigned int)uid) >=
	    (int)sizeof(uid_name)) {
		errno = EOVERFLOW;
		return -1;
	}
	rootfd = open("/sys/fs/cgroup",
		      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (rootfd < 0)
		goto out;
	if (fstatfs(rootfd, &fs) < 0)
		goto out;
	if ((unsigned long)fs.f_type != (unsigned long)CGROUP2_SUPER_MAGIC) {
		errno = ENODEV;
		goto out;
	}
	appsfd = openat(rootfd, "nbosp-apps",
			O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (appsfd < 0)
		goto out;
	if (fstat(appsfd, &st) < 0)
		goto out;
	if (!S_ISDIR(st.st_mode) || st.st_uid != 0 ||
	    (st.st_mode & 0022) != 0) {
		errno = EPERM;
		goto out;
	}
	if (mkdirat(appsfd, uid_name, 0755) < 0 && errno != EEXIST)
		goto out;
	cgroupfd = openat(appsfd, uid_name,
			  O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (cgroupfd < 0)
		goto out;
	if (fstat(cgroupfd, &st) < 0)
		goto out;
	if (!S_ISDIR(st.st_mode) || st.st_uid != 0 ||
	    (st.st_mode & 0022) != 0) {
		errno = EPERM;
		goto out;
	}
	if (configure &&
	    (write_cgroup_control(cgroupfd, "memory.max", "2147483648\n") < 0 ||
	     write_cgroup_control(cgroupfd, "pids.max", "256\n") < 0 ||
	     write_cgroup_control(cgroupfd, "cpu.max", "200000 100000\n") < 0 ||
	     write_cgroup_control(cgroupfd, "memory.oom.group", "1\n") < 0)) {
		goto out;
	}
	result = cgroupfd;
	cgroupfd = -1;
out:
	if (cgroupfd >= 0)
		close(cgroupfd);
	if (appsfd >= 0)
		close(appsfd);
	if (rootfd >= 0)
		close(rootfd);
	return result;
}

static int remove_app_cgroup(uid_t uid)
{
	char uid_name[16];
	struct statfs fs;
	int rootfd, appsfd, result = -1;

	if (snprintf(uid_name, sizeof(uid_name), "%u", (unsigned int)uid) >=
	    (int)sizeof(uid_name)) {
		errno = EOVERFLOW;
		return -1;
	}
	rootfd = open("/sys/fs/cgroup",
		      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (rootfd < 0)
		return -1;
	if (fstatfs(rootfd, &fs) < 0) {
		int saved_errno = errno;
		close(rootfd);
		errno = saved_errno;
		return -1;
	}
	if ((unsigned long)fs.f_type != (unsigned long)CGROUP2_SUPER_MAGIC) {
		close(rootfd);
		errno = ENODEV;
		return -1;
	}
	appsfd = openat(rootfd, "nbosp-apps",
			O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	close(rootfd);
	if (appsfd < 0)
		return -1;
	if (unlinkat(appsfd, uid_name, AT_REMOVEDIR) < 0 && errno != ENOENT)
		goto out;
	result = 0;
out:
	close(appsfd);
	return result;
}

static int relabel_path(const char *path)
{
	char *const arguments[] = {
		(char *)"setfiles",
		(char *)"-F",
		(char *)"-r",
		(char *)"/",
		(char *)"/etc/selinux/targeted/contexts/files/file_contexts",
		(char *)path,
		NULL,
	};
	char *const environment[] = {
		(char *)"PATH=/usr/sbin:/usr/bin:/sbin:/bin",
		(char *)"LANG=C",
		NULL,
	};
	pid_t child = fork();
	int status;
	pid_t waited;

	if (child < 0)
		return -1;
	if (child == 0) {
		execve("/sbin/setfiles", arguments, environment);
		if (errno == ENOENT)
			execve("/usr/sbin/setfiles", arguments, environment);
		_exit(127);
	}
	do {
		waited = waitpid(child, &status, 0);
	} while (waited < 0 && errno == EINTR);
	if (waited != child)
		return -1;
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
		errno = EIO;
		return -1;
	}
	return 0;
}

static void report_errno(const char *operation)
{
	fprintf(stderr, "%s: %s\n", operation, strerror(errno));
}

static bool valid_app_id(const char *id)
{
	size_t i;

	if (!id || !id[0] || strlen(id) > APP_ID_MAX)
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

static int open_var_lib(void)
{
	struct stat st;
	int fd = open("/var/lib", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);

	if (fd < 0)
		return -1;
	if (fstat(fd, &st) < 0 || !S_ISDIR(st.st_mode) || st.st_uid != 0 ||
	    (st.st_mode & 0022) != 0) {
		errno = EPERM;
		close(fd);
		return -1;
	}
	return fd;
}

static int ensure_root_dir(int parentfd, const char *name, mode_t mode)
{
	struct stat st;
	int created = 0;
	int fd;

	if (mkdirat(parentfd, name, mode) == 0)
		created = 1;
	else if (errno != EEXIST)
		return -1;
	fd = openat(parentfd, name,
		    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (fd < 0)
		return -1;
	if (created && fchmod(fd, mode) < 0) {
		int saved_errno = errno;
		close(fd);
		unlinkat(parentfd, name, AT_REMOVEDIR);
		errno = saved_errno;
		return -1;
	}
	if (fstat(fd, &st) < 0 || !S_ISDIR(st.st_mode) || st.st_uid != 0 ||
	    (st.st_mode & 07777) != mode) {
		errno = EPERM;
		close(fd);
		return -1;
	}
	return fd;
}

static int require_persistent_fs(int fd)
{
	struct statfs fs;

	if (fstatfs(fd, &fs) < 0)
		return -1;
	if ((unsigned long)fs.f_type == (unsigned long)TMPFS_MAGIC ||
	    (unsigned long)fs.f_type == (unsigned long)RAMFS_MAGIC) {
		errno = EROFS;
		return -1;
	}
	return 0;
}

static int valid_root_file(int fd, mode_t mode)
{
	struct stat st;

	if (fstat(fd, &st) < 0)
		return -1;
	if (!S_ISREG(st.st_mode) || st.st_uid != 0 ||
	    (st.st_mode & 07777) != mode || st.st_nlink != 1) {
		errno = EPERM;
		return -1;
	}
	return 0;
}

static int clear_directory_acls(int fd)
{
	static const char *const acl_names[] = {
		"system.posix_acl_access",
		"system.posix_acl_default",
	};
	size_t i;

	for (i = 0; i < sizeof(acl_names) / sizeof(acl_names[0]); i++) {
		if (fremovexattr(fd, acl_names[i]) < 0 &&
		    errno != ENODATA && errno != ENOTSUP && errno != EOPNOTSUPP)
			return -1;
	}
	return 0;
}

struct acl_xattr_entry {
	uint16_t tag;
	uint16_t permissions;
	uint32_t id;
} __attribute__((packed));

struct acl_xattr {
	uint32_t version;
	struct acl_xattr_entry entries[5];
} __attribute__((packed));

static int set_anchor_acl(int fd, uid_t uid)
{
	struct acl_xattr acl = {
		.version = htole32(0x0002),
		.entries = {
			{ htole16(0x01), htole16(7), htole32(0xffffffff) },
			{ htole16(0x02), htole16(1), htole32((uint32_t)uid) },
			{ htole16(0x04), htole16(0), htole32(0xffffffff) },
			{ htole16(0x10), htole16(1), htole32(0xffffffff) },
			{ htole16(0x20), htole16(0), htole32(0xffffffff) },
		},
	};

	if (clear_directory_acls(fd) < 0)
		return -1;
	return fsetxattr(fd, "system.posix_acl_access", &acl, sizeof(acl), 0);
}

static ssize_t find_app(const struct app_map *map, const char *id)
{
	size_t i;

	for (i = 0; i < map->count; i++)
		if (strcmp(map->records[i].id, id) == 0)
			return (ssize_t)i;
	return -1;
}

static bool uid_in_map(const struct app_map *map, uid_t uid)
{
	size_t i;

	for (i = 0; i < map->count; i++)
		if (map->records[i].uid == uid)
			return true;
	return false;
}

static int append_record(struct app_map *map, const char *id, uid_t uid)
{
	struct app_record *records;

	if (map->count >= APP_MAP_MAX) {
		errno = ENOSPC;
		return -1;
	}
	records = realloc(map->records, (map->count + 1) * sizeof(*records));
	if (!records)
		return -1;
	map->records = records;
	memcpy(records[map->count].id, id, strlen(id) + 1);
	records[map->count].uid = uid;
	map->count++;
	return 0;
}

static int load_map(int statefd, struct app_map *map)
{
	char *line = NULL;
	size_t capacity = 0;
	ssize_t length;
	FILE *file;
	int fd;

	memset(map, 0, sizeof(*map));
	fd = openat(statefd, "mapping",
		    O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
	if (fd < 0 && errno == ENOENT)
		return 0;
	if (fd < 0)
		return -1;
	if (valid_root_file(fd, 0600) < 0) {
		close(fd);
		return -1;
	}
	file = fdopen(fd, "r");
	if (!file) {
		close(fd);
		return -1;
	}
	while ((length = getline(&line, &capacity, file)) >= 0) {
		char *separator, *uid_text, *end;
		unsigned long value;
		size_t i;

		if (length == 0 || length > 128 || line[length - 1] != '\n') {
			errno = EINVAL;
			goto fail;
		}
		line[--length] = '\0';
		separator = strpbrk(line, " \t");
		if (!separator) {
			errno = EINVAL;
			goto fail;
		}
		*separator++ = '\0';
		while (*separator == ' ' || *separator == '\t')
			separator++;
		if (!valid_app_id(line) || !*separator) {
			errno = EINVAL;
			goto fail;
		}
		uid_text = separator;
		for (end = uid_text; *end >= '0' && *end <= '9'; end++)
			;
		if (end == uid_text || (*end && *end != ' ' && *end != '\t' &&
					*end != '\r')) {
			errno = EINVAL;
			goto fail;
		}
		value = strtoul(uid_text, &end, 10);
		if (end == uid_text || value < UID_FIRST || value >= UID_LIMIT) {
			errno = EINVAL;
			goto fail;
		}
		while (*end == ' ' || *end == '\t' || *end == '\r')
			end++;
		if (*end) {
			errno = EINVAL;
			goto fail;
		}
		for (i = 0; i < map->count; i++) {
			if (strcmp(map->records[i].id, line) == 0 ||
			    map->records[i].uid == (uid_t)value) {
				errno = EINVAL;
				goto fail;
			}
		}
		if (getpwuid((uid_t)value) || getgrgid((gid_t)value)) {
			errno = EEXIST;
			goto fail;
		}
		if (append_record(map, line, (uid_t)value) < 0)
			goto fail;
	}
	if (ferror(file)) {
		errno = EIO;
		goto fail;
	}
	free(line);
	fclose(file);
	return 0;

fail:
	free(line);
	fclose(file);
	free(map->records);
	memset(map, 0, sizeof(*map));
	return -1;
}

static int save_map(int statefd, const struct app_map *map)
{
	char temp_name[64];
	FILE *file;
	size_t i;
	int fd, saved_errno;
	uint64_t nonce;
	ssize_t random_bytes;

	do {
		random_bytes = getrandom(&nonce, sizeof(nonce), 0);
	} while (random_bytes < 0 && errno == EINTR);
	if (random_bytes != (ssize_t)sizeof(nonce)) {
		if (random_bytes >= 0)
			errno = EIO;
		return -1;
	}
	if (snprintf(temp_name, sizeof(temp_name), ".mapping.%016llx",
		     (unsigned long long)nonce) >= (int)sizeof(temp_name)) {
		errno = ENAMETOOLONG;
		return -1;
	}
	fd = openat(statefd, temp_name,
		    O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
	if (fd < 0)
		return -1;
	if (fchmod(fd, 0600) < 0 || valid_root_file(fd, 0600) < 0) {
		saved_errno = errno;
		close(fd);
		unlinkat(statefd, temp_name, 0);
		errno = saved_errno;
		return -1;
	}
	file = fdopen(fd, "w");
	if (!file) {
		saved_errno = errno;
		close(fd);
		unlinkat(statefd, temp_name, 0);
		errno = saved_errno;
		return -1;
	}
	for (i = 0; i < map->count; i++) {
		if (fprintf(file, "%s %u\n", map->records[i].id,
			    (unsigned int)map->records[i].uid) < 0)
			goto write_fail;
	}
	if (fflush(file) < 0 || fsync(fileno(file)) < 0)
		goto write_fail;
	if (fclose(file) < 0) {
		file = NULL;
		goto write_fail;
	}
	file = NULL;
	if (renameat(statefd, temp_name, statefd, "mapping") < 0)
		goto write_fail;
	if (fsync(statefd) < 0)
		return -1;
	return 0;

write_fail:
	saved_errno = errno;
	if (file)
		fclose(file);
	unlinkat(statefd, temp_name, 0);
	errno = saved_errno;
	return -1;
}

static uint32_t app_hash(const char *id)
{
	uint32_t hash = 2166136261U;

	while (*id) {
		hash ^= (unsigned char)*id++;
		hash *= 16777619U;
	}
	return hash;
}

static int allocate_uid(const struct app_map *map, const char *id, uid_t *uid)
{
	unsigned int offset, i;

	offset = app_hash(id) % APP_MAP_MAX;
	for (i = 0; i < APP_MAP_MAX; i++) {
		uid_t candidate = UID_FIRST + ((offset + i) % APP_MAP_MAX);

		if (uid_in_map(map, candidate) || getpwuid(candidate) ||
		    getgrgid(candidate))
			continue;
		*uid = candidate;
		return 0;
	}
	errno = ENOSPC;
	return -1;
}

static int ensure_private_data(int datafd, const char *id, uid_t uid)
{
	struct stat st;
	int anchorfd = -1, appfd = -1, runtimefd = -1;
	int anchor_created = 0, data_created = 0;

	if (mkdirat(datafd, id, 0700) == 0)
		anchor_created = 1;
	else if (errno != EEXIST)
		return -1;
	anchorfd = openat(datafd, id,
			  O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (anchorfd < 0)
		return -1;
	if (fstat(anchorfd, &st) < 0)
		goto fail;
	if (!S_ISDIR(st.st_mode) || st.st_uid != 0) {
		errno = EPERM;
		goto fail;
	}
	if (fchown(anchorfd, 0, 0) < 0 || fchmod(anchorfd, 0700) < 0 ||
	    set_anchor_acl(anchorfd, uid) < 0 || fstat(anchorfd, &st) < 0)
		goto fail;
	if (!S_ISDIR(st.st_mode) || st.st_uid != 0 || st.st_gid != 0 ||
	    (st.st_mode & 07777) != 0710) {
		errno = EPERM;
		goto fail;
	}
	if (mkdirat(anchorfd, "data", 0700) == 0)
		data_created = 1;
	else if (errno != EEXIST)
		goto fail;
	appfd = openat(anchorfd, "data",
		       O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (appfd < 0)
		goto fail;
	if (fstat(appfd, &st) < 0)
		goto fail;
	if (data_created) {
		if (fchown(appfd, uid, uid) < 0 || fchmod(appfd, 0700) < 0)
			goto fail;
		if (fstat(appfd, &st) < 0)
			goto fail;
	}
	if (!S_ISDIR(st.st_mode) || st.st_uid != uid || st.st_gid != uid ||
	    (st.st_mode & 07777) != 0700) {
		errno = EPERM;
		goto fail;
	}
	if (mkdirat(appfd, "runtime", 0700) < 0 && errno != EEXIST)
		goto fail;
	runtimefd = openat(appfd, "runtime",
			   O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (runtimefd < 0 || fstat(runtimefd, &st) < 0)
		goto fail;
	if (st.st_uid == 0) {
		if (fchown(runtimefd, uid, uid) < 0 ||
		    fchmod(runtimefd, 0700) < 0 || fstat(runtimefd, &st) < 0)
			goto fail;
	}
	if (!S_ISDIR(st.st_mode) || st.st_uid != uid || st.st_gid != uid ||
	    (st.st_mode & 07777) != 0700) {
		errno = EPERM;
		goto fail;
	}
	if (fsync(appfd) < 0 || fsync(anchorfd) < 0)
		goto fail;
	close(runtimefd);
	runtimefd = -1;
	close(appfd);
	appfd = -1;
	close(anchorfd);
	anchorfd = -1;
	return 0;

fail:
	{
		int saved_errno = errno;
		if (runtimefd >= 0)
			close(runtimefd);
		if (appfd >= 0)
			close(appfd);
		if (anchorfd >= 0)
			close(anchorfd);
		if (data_created) {
			int cleanupfd = openat(datafd, id,
					      O_RDONLY | O_DIRECTORY | O_CLOEXEC |
						      O_NOFOLLOW);
			if (cleanupfd >= 0) {
				unlinkat(cleanupfd, "data", AT_REMOVEDIR);
				close(cleanupfd);
			}
		}
		if (anchor_created)
			unlinkat(datafd, id, AT_REMOVEDIR);
		errno = saved_errno;
	}
	return -1;
}

static int provision(const char *id, uid_t *provisioned_uid)
{
	struct app_map map = {0};
	char data_path[160];
	uid_t uid;
	ssize_t existing;
	int varfd = -1, statefd = -1, datafd = -1, lockfd = -1, result = -1;

	varfd = open_var_lib();
	if (varfd < 0)
		goto out;
	statefd = ensure_root_dir(varfd, STATE_DIR, 0700);
	if (statefd < 0 || require_persistent_fs(statefd) < 0)
		goto out;
	datafd = ensure_root_dir(varfd, DATA_DIR, 0711);
	if (datafd < 0 || require_persistent_fs(datafd) < 0)
		goto out;
	if (fsync(varfd) < 0)
		goto out;
	lockfd = openat(statefd, "mapping.lock",
			O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
	if (lockfd < 0 || valid_root_file(lockfd, 0600) < 0)
		goto out;
	if (flock(lockfd, LOCK_EX) < 0)
		goto out;
	if (load_map(statefd, &map) < 0)
		goto out;
	existing = find_app(&map, id);
	if (existing >= 0) {
		uid = map.records[existing].uid;
		if (getpwuid(uid) || getgrgid(uid)) {
			errno = EEXIST;
			goto out;
		}
	} else {
		if (allocate_uid(&map, id, &uid) < 0 ||
		    append_record(&map, id, uid) < 0 ||
		    save_map(statefd, &map) < 0)
			goto out;
	}
	if (ensure_private_data(datafd, id, uid) < 0 ||
	    snprintf(data_path, sizeof(data_path), "/var/lib/%s/%s/data",
		     DATA_DIR, id) >= (int)sizeof(data_path) ||
	    relabel_path(data_path) < 0)
		goto out;
	if (fsync(datafd) < 0)
		goto out;
	if (provisioned_uid)
		*provisioned_uid = uid;
	else
		printf("Provisioned app %s with UID %u\n", id, (unsigned int)uid);
	result = 0;

out:
	if (result < 0)
		report_errno("App provisioning failed");
	free(map.records);
	if (lockfd >= 0)
		close(lockfd);
	if (datafd >= 0)
		close(datafd);
	if (statefd >= 0)
		close(statefd);
	if (varfd >= 0)
		close(varfd);
	return result;
}

static bool valid_entry_path(const char *path)
{
	const char *part;
	const char *cursor;

	if (!path || !path[0] || path[0] == '/' || strlen(path) > 512)
		return false;
	part = path;
	for (cursor = path; ; cursor++) {
		unsigned char c = (unsigned char)*cursor;

		if (c == '/' || c == '\0') {
			size_t length = (size_t)(cursor - part);
			if (!length || (length == 1 && part[0] == '.') ||
			    (length == 2 && part[0] == '.' && part[1] == '.'))
				return false;
			if (c == '\0')
				break;
			part = cursor + 1;
			continue;
		}
		if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
		      (c >= '0' && c <= '9') || c == '.' || c == '_' ||
		      c == '-' ))
			return false;
	}
	return true;
}

static int open_owned_directory(int parentfd, const char *name, uid_t owner)
{
	struct stat st;
	int fd = openat(parentfd, name,
			O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);

	if (fd < 0)
		return -1;
	if (fstat(fd, &st) < 0 || !S_ISDIR(st.st_mode) ||
	    (st.st_uid != owner && st.st_uid != 0) ||
	    (st.st_mode & 0022) != 0) {
		close(fd);
		errno = EPERM;
		return -1;
	}
	return fd;
}

static int open_staging_app(const char *id)
{
	struct stat st;
	int fd = -1, nextfd = -1;
	const char *components[] = {
		"home", "nbosp", ".local", "share", "novabyte",
		"isolation-staging", id,
	};
	size_t i;

	fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	if (fd < 0)
		return -1;
	for (i = 0; i < sizeof(components) / sizeof(components[0]); i++) {
		uid_t expected = i < 2 ? (i == 0 ? 0 : DESKTOP_UID) : DESKTOP_UID;
		nextfd = open_owned_directory(fd, components[i], expected);
		close(fd);
		if (nextfd < 0)
			return -1;
		fd = nextfd;
	}
	if (fstat(fd, &st) < 0 || st.st_uid != DESKTOP_UID) {
		close(fd);
		errno = EPERM;
		return -1;
	}
	return fd;
}

static bool valid_package_name(const char *name)
{
	const unsigned char *p = (const unsigned char *)name;

	if (!name || !name[0] || strlen(name) > 200 ||
	    strcmp(name, ".") == 0 || strcmp(name, "..") == 0)
		return false;
	for (; *p; p++) {
		if (*p < 0x20 || *p == 0x7f || *p == '/' || *p == '\\')
			return false;
	}
	return true;
}

static int copy_package_tree(int sourcefd, int targetfd,
			     struct copy_limits *limits)
{
	DIR *directory;
	struct dirent *item;
	int scanfd = dup(sourcefd);
	int result = -1;

	if (scanfd < 0)
		return -1;
	directory = fdopendir(scanfd);
	if (!directory) {
		close(scanfd);
		return -1;
	}
	for (;;) {
		struct stat st;

		errno = 0;
		item = readdir(directory);
		if (!item) {
			if (errno != 0)
				goto out;
			break;
		}
		if (strcmp(item->d_name, ".") == 0 ||
		    strcmp(item->d_name, "..") == 0)
			continue;
		if (++limits->files > MAX_PACKAGE_FILES) {
			errno = EFBIG;
			goto out;
		}
		if (!valid_package_name(item->d_name) ||
		    fstatat(sourcefd, item->d_name, &st, AT_SYMLINK_NOFOLLOW) < 0)
			goto out;
		if (S_ISDIR(st.st_mode)) {
			int child_source, child_target;

			if (mkdirat(targetfd, item->d_name, 0700) < 0)
				goto out;
			child_source = openat(sourcefd, item->d_name,
					      O_RDONLY | O_DIRECTORY | O_CLOEXEC |
						      O_NOFOLLOW);
			child_target = openat(targetfd, item->d_name,
					      O_RDONLY | O_DIRECTORY | O_CLOEXEC |
						      O_NOFOLLOW);
			if (child_source < 0 || child_target < 0) {
				if (child_source >= 0)
					close(child_source);
				if (child_target >= 0)
					close(child_target);
				goto out;
			}
			if (copy_package_tree(child_source, child_target, limits) < 0 ||
			    fchmod(child_target, 0555) < 0) {
				close(child_source);
				close(child_target);
				goto out;
			}
			close(child_source);
			close(child_target);
		} else if (S_ISREG(st.st_mode)) {
			char buffer[16384];
			ssize_t count;
			int input, output;

			struct stat opened_stat;
			if (st.st_size < 0 ||
			    (uint64_t)st.st_size > MAX_PACKAGE_BYTES - limits->bytes) {
				errno = EFBIG;
				goto out;
			}
			input = openat(sourcefd, item->d_name,
				       O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
			if (input < 0)
				goto out;
			if (fstat(input, &opened_stat) < 0 ||
			    !S_ISREG(opened_stat.st_mode) ||
			    opened_stat.st_dev != st.st_dev ||
			    opened_stat.st_ino != st.st_ino) {
				close(input);
				errno = EPERM;
				goto out;
			}
			output = openat(targetfd, item->d_name,
					O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC |
						O_NOFOLLOW,
					0600);
			if (output < 0) {
				close(input);
				goto out;
			}
			while ((count = read(input, buffer, sizeof(buffer))) > 0) {
				size_t offset = 0;
				while (offset < (size_t)count) {
					ssize_t written = write(output, buffer + offset,
								(size_t)count - offset);
					if (written < 0 && errno == EINTR)
						continue;
					if (written <= 0) {
						close(input);
						close(output);
						goto out;
					}
					offset += (size_t)written;
				}
				limits->bytes += (uint64_t)count;
				if (limits->bytes > MAX_PACKAGE_BYTES) {
					close(input);
					close(output);
					errno = EFBIG;
					goto out;
				}
			}
			if (count < 0 || fchmod(output, 0444) < 0 ||
			    fsync(output) < 0) {
				close(input);
				close(output);
				goto out;
			}
			close(input);
			if (close(output) < 0)
				goto out;
		} else {
			errno = EPERM;
			goto out;
		}
	}
	result = 0;
out:
	{
		int saved_errno = errno;
		closedir(directory);
		errno = saved_errno;
	}
	return result;
}

static int remove_package_tree(int parentfd, const char *name)
{
	DIR *directory;
	struct dirent *item;
	struct stat st;
	int rootfd = openat(parentfd, name,
			    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	int scanfd;
	int result = -1;

	if (rootfd < 0)
		return -1;
	if (fstat(rootfd, &st) < 0 || !S_ISDIR(st.st_mode) ||
	    st.st_uid != 0 || (st.st_mode & 0022) != 0) {
		errno = EPERM;
		goto out;
	}
	scanfd = dup(rootfd);
	if (scanfd < 0)
		goto out;
	directory = fdopendir(scanfd);
	if (!directory) {
		close(scanfd);
		goto out;
	}
	for (;;) {
		errno = 0;
		item = readdir(directory);
		if (!item) {
			if (errno != 0)
				goto close_directory;
			break;
		}
		if (strcmp(item->d_name, ".") == 0 ||
		    strcmp(item->d_name, "..") == 0)
			continue;
		if (fstatat(rootfd, item->d_name, &st, AT_SYMLINK_NOFOLLOW) < 0 ||
		    st.st_uid != 0 || (st.st_mode & 0022) != 0) {
			errno = EPERM;
			goto close_directory;
		}
		if (S_ISDIR(st.st_mode)) {
			if (remove_package_tree(rootfd, item->d_name) < 0)
				goto close_directory;
		} else if (S_ISREG(st.st_mode)) {
			if (unlinkat(rootfd, item->d_name, 0) < 0)
				goto close_directory;
		} else {
			errno = EPERM;
			goto close_directory;
		}
	}
	result = 0;

close_directory:
	closedir(directory);
out:
	{
		int saved_errno = errno;
		close(rootfd);
		if (result == 0 && unlinkat(parentfd, name, AT_REMOVEDIR) < 0) {
			result = -1;
			saved_errno = errno;
		}
		errno = saved_errno;
	}
	return result;
}

static int remove_user_tree_contents(int directoryfd, uid_t uid)
{
	DIR *directory;
	struct dirent *item;
	struct stat st;
	int scanfd = dup(directoryfd);
	int result = -1;

	if (scanfd < 0)
		return -1;
	directory = fdopendir(scanfd);
	if (!directory) {
		close(scanfd);
		return -1;
	}
	for (;;) {
		int childfd;
		errno = 0;
		item = readdir(directory);
		if (!item) {
			if (errno != 0)
				goto out;
			break;
		}
		if (strcmp(item->d_name, ".") == 0 ||
		    strcmp(item->d_name, "..") == 0)
			continue;
		if (fstatat(directoryfd, item->d_name, &st, AT_SYMLINK_NOFOLLOW) < 0 ||
		    st.st_uid != uid) {
			errno = EPERM;
			goto out;
		}
		if (S_ISDIR(st.st_mode)) {
			childfd = openat(directoryfd, item->d_name,
					 O_RDONLY | O_DIRECTORY | O_CLOEXEC |
						 O_NOFOLLOW);
			if (childfd < 0)
				goto out;
			if (remove_user_tree_contents(childfd, uid) < 0) {
				close(childfd);
				goto out;
			}
			close(childfd);
			if (unlinkat(directoryfd, item->d_name, AT_REMOVEDIR) < 0)
				goto out;
		} else {
			if (unlinkat(directoryfd, item->d_name, 0) < 0)
				goto out;
		}
	}
	result = 0;
out:
	closedir(directory);
	return result;
}

static int app_uid_has_process(uid_t uid)
{
	DIR *proc = opendir("/proc");
	struct dirent *item;

	if (!proc)
		return -1;
	for (;;) {
		char *end = NULL;
		unsigned long pid;
		struct stat st;
		int processfd;

		errno = 0;
		item = readdir(proc);
		if (!item) {
			if (errno != 0) {
				closedir(proc);
				return -1;
			}
			break;
		}
		pid = strtoul(item->d_name, &end, 10);
		if (end == item->d_name || *end || pid < 2)
			continue;
		processfd = openat(dirfd(proc), item->d_name,
				   O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
		if (processfd < 0)
			continue;
		if (fstat(processfd, &st) == 0 && st.st_uid == uid) {
			close(processfd);
			closedir(proc);
			return 1;
		}
		close(processfd);
	}
	closedir(proc);
	return 0;
}

static int remove_app_data(int datafd, const char *id, uid_t uid)
{
	struct stat st;
	int anchorfd = -1, appfd = -1, result = -1;

	anchorfd = openat(datafd, id,
			  O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (anchorfd < 0) {
		if (errno == ENOENT)
			return 0;
		return -1;
	}
	if (fstat(anchorfd, &st) < 0 || st.st_uid != 0 ||
	    (st.st_mode & 07777) != 0710) {
		errno = EPERM;
		goto out;
	}
	appfd = openat(anchorfd, "data",
		       O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (appfd < 0) {
		if (errno == ENOENT)
			result = 0;
		goto out;
	}
	if (fstat(appfd, &st) < 0 || !S_ISDIR(st.st_mode) || st.st_uid != uid) {
		errno = EPERM;
		goto out;
	}
	if (remove_user_tree_contents(appfd, uid) < 0)
		goto out;
	close(appfd);
	appfd = -1;
	if (unlinkat(anchorfd, "data", AT_REMOVEDIR) < 0)
		goto out;
	result = 0;
out:
	if (appfd >= 0)
		close(appfd);
	if (anchorfd >= 0)
		close(anchorfd);
	if (result == 0 && unlinkat(datafd, id, AT_REMOVEDIR) < 0 &&
	    errno != ENOENT)
		result = -1;
	return result;
}

static int open_relative_regular_file(int rootfd, const char *path)
{
	char copy[513];
	char *part, *next;
	int current = dup(rootfd);

	if (current < 0 || !valid_entry_path(path)) {
		if (current >= 0)
			close(current);
		errno = EINVAL;
		return -1;
	}
	memcpy(copy, path, strlen(path) + 1);
	part = copy;
	for (;;) {
		struct stat st;
		next = strchr(part, '/');
		if (next)
			*next = '\0';
		if (next) {
			struct stat child_stat;
			int child = openat(current, part,
					   O_RDONLY | O_DIRECTORY | O_CLOEXEC |
						   O_NOFOLLOW);
			close(current);
			if (child < 0)
				return -1;
			if (fstat(child, &child_stat) < 0 ||
			    !S_ISDIR(child_stat.st_mode) || child_stat.st_uid != 0 ||
			    (child_stat.st_mode & 0022) != 0) {
				close(child);
				errno = EPERM;
				return -1;
			}
			current = child;
			part = next + 1;
			continue;
		}
		{
			int file = openat(current, part,
					  O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
			close(current);
			if (file < 0)
				return -1;
			if (fstat(file, &st) < 0 || !S_ISREG(st.st_mode) ||
			    st.st_uid != 0 || (st.st_mode & 0022) != 0) {
				close(file);
				errno = EPERM;
				return -1;
			}
			return file;
		}
	}
}

static int install_app(const char *id, const char *entry)
{
	struct app_map map = {0};
	struct copy_limits limits = {0};
	struct passwd *desktop = NULL;
	char temp_name[96] = {0}, backup_name[96], installed_path[160];
	uid_t uid;
	int varfd = -1, statefd = -1, packagesfd = -1, lockfd = -1;
	int sourcefd = -1, tempfd = -1, entryfd = -1, result = -1;
	int backup_exists = 0, package_committed = 0;
	ssize_t existing;
	struct stat package_stat;
	int current_package_exists;

	if (!valid_app_id(id) || !valid_entry_path(entry)) {
		errno = EINVAL;
		goto out;
	}
	desktop = getpwuid(DESKTOP_UID);
	if (!desktop) {
		errno = ENOENT;
		goto out;
	}
	sourcefd = open_staging_app(id);
	if (sourcefd < 0)
		goto out;
	varfd = open_var_lib();
	if (varfd < 0)
		goto out;
	statefd = ensure_root_dir(varfd, STATE_DIR, 0700);
	packagesfd = ensure_root_dir(varfd, PACKAGE_DIR, 0711);
	if (statefd < 0 || packagesfd < 0 ||
	    require_persistent_fs(statefd) < 0 ||
	    require_persistent_fs(packagesfd) < 0)
		goto out;
	lockfd = openat(statefd, "mapping.lock",
			O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
	if (lockfd < 0 || valid_root_file(lockfd, 0600) < 0 ||
	    flock(lockfd, LOCK_EX) < 0 || load_map(statefd, &map) < 0)
		goto out;
	existing = find_app(&map, id);
	if (existing < 0) {
		if (allocate_uid(&map, id, &uid) < 0 ||
		    append_record(&map, id, uid) < 0 ||
		    save_map(statefd, &map) < 0)
			goto out;
	} else {
		uid = map.records[existing].uid;
	}
	{
		int active = app_uid_has_process(uid);
		if (active != 0) {
			if (active > 0)
				errno = EBUSY;
			goto out;
		}
	}
	if (snprintf(temp_name, sizeof(temp_name), ".%s.installing.%ld", id,
		     (long)getpid()) >=
	    (int)sizeof(temp_name) ||
	    snprintf(backup_name, sizeof(backup_name), ".%s.previous", id) >=
	    (int)sizeof(backup_name) ||
	    snprintf(installed_path, sizeof(installed_path),
		     "/var/lib/%s/%s", PACKAGE_DIR, id) >=
	    (int)sizeof(installed_path)) {
		errno = ENAMETOOLONG;
		goto out;
	}
	current_package_exists =
		fstatat(packagesfd, id, &package_stat, AT_SYMLINK_NOFOLLOW) == 0;
	if (!current_package_exists && errno != ENOENT)
		goto out;
	if (current_package_exists &&
	    (!S_ISDIR(package_stat.st_mode) || package_stat.st_uid != 0 ||
	     (package_stat.st_mode & 0022) != 0)) {
		errno = EPERM;
		goto out;
	}
	if (fstatat(packagesfd, backup_name, &package_stat,
		    AT_SYMLINK_NOFOLLOW) == 0) {
		if (!S_ISDIR(package_stat.st_mode) || package_stat.st_uid != 0 ||
		    (package_stat.st_mode & 0022) != 0) {
			errno = EPERM;
			goto out;
		}
		if (!current_package_exists) {
			if (renameat(packagesfd, backup_name, packagesfd, id) < 0)
				goto out;
			current_package_exists = 1;
		} else if (remove_package_tree(packagesfd, backup_name) < 0) {
			goto out;
		}
	} else if (errno != ENOENT) {
		goto out;
	}
	if (mkdirat(packagesfd, temp_name, 0700) < 0)
		goto out;
	tempfd = openat(packagesfd, temp_name,
			O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (tempfd < 0 || copy_package_tree(sourcefd, tempfd, &limits) < 0)
		goto out;
	entryfd = open_relative_regular_file(tempfd, entry);
	if (entryfd < 0)
		goto out;
	close(entryfd);
	entryfd = -1;
	{
		int descriptor = openat(tempfd, ".nbosp-entry",
					O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC |
						O_NOFOLLOW,
					0444);
		if (descriptor < 0)
			goto out;
		if (dprintf(descriptor, "%s\n", entry) < 0 ||
		    fchmod(descriptor, 0444) < 0 || fsync(descriptor) < 0) {
			int saved_errno = errno;
			close(descriptor);
			errno = saved_errno;
			goto out;
		}
		if (close(descriptor) < 0)
			goto out;
	}
	if (fchmod(tempfd, 0555) < 0 || fsync(tempfd) < 0 ||
	    fsync(packagesfd) < 0)
		goto out;
	if (faccessat(packagesfd, id, F_OK, AT_SYMLINK_NOFOLLOW) == 0) {
		int oldfd = openat(packagesfd, id,
				   O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
		struct stat oldstat;
		if (oldfd < 0 || fstat(oldfd, &oldstat) < 0 ||
		    oldstat.st_uid != 0 || (oldstat.st_mode & 0022) != 0) {
			if (oldfd >= 0)
				close(oldfd);
			errno = EPERM;
			goto out;
		}
		close(oldfd);
		if (renameat(packagesfd, id, packagesfd, backup_name) < 0)
			goto out;
		backup_exists = 1;
	} else if (errno != ENOENT) {
		goto out;
	}
	if (renameat(packagesfd, temp_name, packagesfd, id) < 0)
		goto rollback_package;
	package_committed = 1;
	if (relabel_path(installed_path) < 0 || fsync(packagesfd) < 0)
		goto rollback_package;
	if (backup_exists) {
		if (remove_package_tree(packagesfd, backup_name) < 0)
			fprintf(stderr, "Warning: unable to remove previous package for %s\n", id);
		else
			backup_exists = 0;
	}
	printf("Installed app %s with UID %u\n", id, (unsigned int)uid);
	result = 0;
	goto out;

rollback_package:
	{
		int saved_errno = errno;
		if (package_committed)
			(void)remove_package_tree(packagesfd, id);
		if (backup_exists)
			(void)renameat(packagesfd, backup_name, packagesfd, id);
		errno = saved_errno;
	}

out:
	if (result < 0)
		report_errno("App installation failed");
	if (packagesfd >= 0 && temp_name[0])
		(void)remove_package_tree(packagesfd, temp_name);
	if (tempfd >= 0)
		close(tempfd);
	if (entryfd >= 0)
		close(entryfd);
	if (sourcefd >= 0)
		close(sourcefd);
	if (lockfd >= 0)
		close(lockfd);
	if (packagesfd >= 0)
		close(packagesfd);
	if (statefd >= 0)
		close(statefd);
	if (varfd >= 0)
		close(varfd);
	free(map.records);
	return result;
}

static int uninstall_app(const char *id)
{
	struct app_map map = {0};
	ssize_t record;
	uid_t uid;
	int varfd = -1, statefd = -1, packagesfd = -1, datafd = -1;
	int lockfd = -1, active, result = -1;
	struct stat st;

	if (!valid_app_id(id)) {
		errno = EINVAL;
		goto out;
	}
	varfd = open_var_lib();
	if (varfd < 0)
		goto out;
	statefd = ensure_root_dir(varfd, STATE_DIR, 0700);
	packagesfd = ensure_root_dir(varfd, PACKAGE_DIR, 0711);
	datafd = ensure_root_dir(varfd, DATA_DIR, 0711);
	if (statefd < 0 || packagesfd < 0 || datafd < 0)
		goto out;
	lockfd = openat(statefd, "mapping.lock",
			O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
	if (lockfd < 0 || valid_root_file(lockfd, 0600) < 0 ||
	    flock(lockfd, LOCK_EX) < 0 || load_map(statefd, &map) < 0)
		goto out;
	record = find_app(&map, id);
	if (record < 0) {
		errno = ENOENT;
		goto out;
	}
	uid = map.records[record].uid;
	active = app_uid_has_process(uid);
	if (active != 0) {
		if (active > 0)
			errno = EBUSY;
		goto out;
	}
	if (remove_app_cgroup(uid) < 0)
		goto out;
	if (fstatat(packagesfd, id, &st, AT_SYMLINK_NOFOLLOW) == 0) {
		if (!S_ISDIR(st.st_mode) || st.st_uid != 0 ||
		    (st.st_mode & 0022) != 0 ||
		    remove_package_tree(packagesfd, id) < 0)
			goto out;
	} else if (errno != ENOENT) {
		goto out;
	}
	if (remove_app_data(datafd, id, uid) < 0)
		goto out;
	{
		char legacy_entry[72];
		if (snprintf(legacy_entry, sizeof(legacy_entry), "%s.entry", id) <
		    (int)sizeof(legacy_entry))
			(void)unlinkat(statefd, legacy_entry, 0);
	}
	if (fsync(packagesfd) < 0 || fsync(datafd) < 0)
		goto out;
	printf("Uninstalled app %s\n", id);
	result = 0;
out:
	if (result < 0)
		report_errno("App uninstall failed");
	free(map.records);
	if (lockfd >= 0)
		close(lockfd);
	if (datafd >= 0)
		close(datafd);
	if (packagesfd >= 0)
		close(packagesfd);
	if (statefd >= 0)
		close(statefd);
	if (varfd >= 0)
		close(varfd);
	return result;
}

static int launch_app(const char *id, const char *port_text, const char *token)
{
	char package_path[160], data_path[160], runtime_path[192];
	char wayland_socket[128];
	char broker_url[128], port_copy[8];
	char *end = NULL;
	unsigned long port;
	struct app_map map = {0};
	struct group *wayland_group;
	struct stat runtime_stat, socket_stat;
	struct passwd *desktop = getpwuid(DESKTOP_UID);
	uid_t uid;
	ssize_t record;
	int varfd = -1, statefd = -1, packagesfd = -1, packagefd = -1;
	int datafd = -1, lockfd = -1, entryfd = -1, error_pipe[2] = {-1, -1};
	int start_pipe[2] = {-1, -1}, cgroupfd = -1;
	pid_t child;
	int child_error = 0;
	ssize_t error_count;

	if (!valid_app_id(id) || !port_text || strlen(port_text) > 5 ||
	    !token || strlen(token) != 64 || !desktop) {
		errno = EINVAL;
		goto fail;
	}
	for (size_t i = 0; i < 64; i++)
		if (!((token[i] >= '0' && token[i] <= '9') ||
		      (token[i] >= 'a' && token[i] <= 'f'))) {
			errno = EINVAL;
			goto fail;
		}
	port = strtoul(port_text, &end, 10);
	if (!end || *end || port != BROKER_PORT) {
		errno = EINVAL;
		goto fail;
	}
	wayland_group = getgrnam(WAYLAND_GROUP);
	if (!wayland_group) {
		errno = ENOENT;
		goto fail;
	}
	if (snprintf(package_path, sizeof(package_path),
		     "/var/lib/%s/%s", PACKAGE_DIR, id) >=
	    (int)sizeof(package_path) ||
	    snprintf(data_path, sizeof(data_path),
		     "/var/lib/%s/%s/data", DATA_DIR, id) >=
	    (int)sizeof(data_path) ||
	    snprintf(runtime_path, sizeof(runtime_path), "%s/runtime",
		     data_path) >= (int)sizeof(runtime_path) ||
	    snprintf(wayland_socket, sizeof(wayland_socket),
		     "/run/nbosp-wayland/wayland-0") >=
	    (int)sizeof(wayland_socket) ||
	    snprintf(broker_url, sizeof(broker_url),
		     "http://127.0.0.1:%lu/v1/rpc", port) >=
	    (int)sizeof(broker_url)) {
		errno = ENAMETOOLONG;
		goto fail;
	}
	if (stat("/run/nbosp-wayland", &runtime_stat) < 0 ||
	    lstat(wayland_socket, &socket_stat) < 0)
		goto fail;
	if (!S_ISDIR(runtime_stat.st_mode) || runtime_stat.st_uid != DESKTOP_UID ||
	    runtime_stat.st_gid != wayland_group->gr_gid ||
	    (runtime_stat.st_mode & 07777) != 02710 ||
	    !S_ISSOCK(socket_stat.st_mode) ||
	    socket_stat.st_uid != DESKTOP_UID ||
	    socket_stat.st_gid != wayland_group->gr_gid ||
	    (socket_stat.st_mode & 0060) != 0060 ||
	    (socket_stat.st_mode & 0007) != 0) {
		errno = EPERM;
		goto fail;
	}
	if (relabel_path(wayland_socket) < 0)
		goto fail;
	memcpy(port_copy, port_text, strlen(port_text) + 1);
	varfd = open_var_lib();
	if (varfd < 0)
		goto fail;
	statefd = ensure_root_dir(varfd, STATE_DIR, 0700);
	packagesfd = ensure_root_dir(varfd, PACKAGE_DIR, 0711);
	datafd = ensure_root_dir(varfd, DATA_DIR, 0711);
	if (statefd < 0 || packagesfd < 0 || datafd < 0)
		goto fail;
	lockfd = openat(statefd, "mapping.lock",
			O_RDWR | O_CLOEXEC | O_NOFOLLOW);
	if (lockfd < 0 || valid_root_file(lockfd, 0600) < 0 ||
	    flock(lockfd, LOCK_EX) < 0 || load_map(statefd, &map) < 0)
		goto fail;
	record = find_app(&map, id);
	if (record < 0) {
		errno = ENOENT;
		goto fail;
	}
	uid = map.records[record].uid;
	if (getpwuid(uid) || getgrgid(uid)) {
		errno = EEXIST;
		goto fail;
	}
	{
		int active = app_uid_has_process(uid);
		if (active != 0) {
			if (active > 0)
				errno = EBUSY;
			goto fail;
		}
	}
	cgroupfd = open_app_cgroup(uid, true);
	if (cgroupfd < 0)
		goto fail;
	packagefd = openat(packagesfd, id,
			   O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (packagefd < 0)
		goto fail;
	entryfd = openat(packagefd, ".nbosp-entry",
			 O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
	if (entryfd < 0 || valid_root_file(entryfd, 0444) < 0)
		goto fail;
	{
		char entry[513];
		ssize_t length = read(entryfd, entry, sizeof(entry) - 1);
		if (length <= 1 || length >= (ssize_t)sizeof(entry) - 1 ||
		    entry[length - 1] != '\n') {
			errno = EINVAL;
			goto fail;
		}
		entry[length - 1] = '\0';
		if (!valid_entry_path(entry)) {
			errno = EINVAL;
			goto fail;
		}
		int targetfd = open_relative_regular_file(packagefd, entry);
		if (targetfd < 0)
			goto fail;
		close(targetfd);
	}
	if (ensure_private_data(datafd, id, uid) < 0)
		goto fail;
	if (pipe2(error_pipe, O_CLOEXEC) < 0 ||
	    pipe2(start_pipe, O_CLOEXEC) < 0)
		goto fail;
	child = fork();
	if (child < 0)
		goto fail;
	if (child == 0) {
		char *const child_argv[] = {
			(char *)"/opt/nbosp/NovaByte",
			package_path,
			NULL,
		};
		int nullfd = open("/dev/null", O_RDWR | O_CLOEXEC);
		gid_t supplementary_groups[1] = { wayland_group->gr_gid };
		int failure = 0;
		char start_signal;
		ssize_t start_count;

		close(error_pipe[0]);
		close(start_pipe[1]);
		close(cgroupfd);
		do {
			start_count = read(start_pipe[0], &start_signal,
					   sizeof(start_signal));
		} while (start_count < 0 && errno == EINTR);
		close(start_pipe[0]);
		if (start_count != 1 || start_signal != 'G') {
			failure = start_count < 0 ? errno : ECANCELED;
			(void)write(error_pipe[1], &failure, sizeof(failure));
			_exit(126);
		}
		if (set_app_resource_limits() < 0 || setpgid(0, 0) < 0 ||
		    nullfd < 0 || dup2(nullfd, STDIN_FILENO) < 0 ||
		    dup2(nullfd, STDOUT_FILENO) < 0 ||
		    dup2(nullfd, STDERR_FILENO) < 0 ||
		    chdir(package_path) < 0 ||
		    setgroups(1, supplementary_groups) < 0 ||
		    setgid(uid) < 0 || setuid(uid) < 0 ||
		    prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0 ||
		    clearenv() < 0 ||
		    setenv("PATH", "/usr/bin:/bin", 1) < 0 ||
		    setenv("LANG", "C.UTF-8", 1) < 0 ||
		    setenv("NODE_ENV", "production", 1) < 0 ||
		    setenv("HOME", data_path, 1) < 0 ||
		    setenv("XDG_CONFIG_HOME", data_path, 1) < 0 ||
		    setenv("XDG_CACHE_HOME", data_path, 1) < 0 ||
		    setenv("XDG_DATA_HOME", data_path, 1) < 0 ||
		    setenv("XDG_RUNTIME_DIR", runtime_path, 1) < 0 ||
		    setenv("WAYLAND_DISPLAY", wayland_socket, 1) < 0 ||
		    setenv("GDK_BACKEND", "wayland", 1) < 0 ||
		    setenv("XDG_SESSION_TYPE", "wayland", 1) < 0 ||
		    setenv("XDG_CURRENT_DESKTOP", "Weston", 1) < 0 ||
		    setenv("NODE_PATH", "/opt/nbosp/package.nw/node_modules", 1) < 0 ||
		    setenv("LD_LIBRARY_PATH", "/opt/nbosp/lib:/opt/nbosp", 1) < 0 ||
		    setenv("NBOSP_APP_ID", id, 1) < 0 ||
		    setenv("NBOSP_BROKER_URL", broker_url, 1) < 0 ||
		    setenv("NBOSP_BROKER_TOKEN", token, 1) < 0 ||
		    install_app_seccomp_filter() < 0) {
			failure = errno ? errno : EIO;
			(void)write(error_pipe[1], &failure, sizeof(failure));
			_exit(126);
		}
		close(nullfd);
		execve("/opt/nbosp/NovaByte", child_argv, environ);
		failure = errno;
		(void)write(error_pipe[1], &failure, sizeof(failure));
		_exit(127);
	}
	close(start_pipe[0]);
	start_pipe[0] = -1;
	{
		char pid_text[32], start_signal = 'G';
		if (snprintf(pid_text, sizeof(pid_text), "%ld\n", (long)child) >=
			(int)sizeof(pid_text) ||
		    write_cgroup_control(cgroupfd, "cgroup.procs", pid_text) < 0) {
			int saved_errno = errno;
			close(start_pipe[1]);
			start_pipe[1] = -1;
			(void)kill(child, SIGKILL);
			while (waitpid(child, NULL, 0) < 0 && errno == EINTR)
				;
			errno = saved_errno;
			goto fail;
		}
		if (write(start_pipe[1], &start_signal, sizeof(start_signal)) != 1) {
			int saved_errno = errno ? errno : EIO;
			close(start_pipe[1]);
			start_pipe[1] = -1;
			(void)kill(child, SIGKILL);
			while (waitpid(child, NULL, 0) < 0 && errno == EINTR)
				;
			errno = saved_errno;
			goto fail;
		}
		close(start_pipe[1]);
		start_pipe[1] = -1;
	}
	close(error_pipe[1]);
	error_pipe[1] = -1;
	do {
		error_count = read(error_pipe[0], &child_error, sizeof(child_error));
	} while (error_count < 0 && errno == EINTR);
	close(error_pipe[0]);
	error_pipe[0] = -1;
	if (error_count != 0) {
		if (error_count > 0)
			errno = child_error;
		(void)waitpid(child, NULL, 0);
		goto fail;
	}
	printf("%ld\n", (long)child);
	free(map.records);
	close(entryfd);
	close(lockfd);
	close(datafd);
	close(cgroupfd);
	close(packagefd);
	close(packagesfd);
	close(statefd);
	close(varfd);
	return 0;

fail:
	report_errno("App launch failed");
	if (error_pipe[0] >= 0)
		close(error_pipe[0]);
	if (error_pipe[1] >= 0)
		close(error_pipe[1]);
	if (start_pipe[0] >= 0)
		close(start_pipe[0]);
	if (start_pipe[1] >= 0)
		close(start_pipe[1]);
	if (cgroupfd >= 0)
		close(cgroupfd);
	if (entryfd >= 0)
		close(entryfd);
	if (lockfd >= 0)
		close(lockfd);
	if (datafd >= 0)
		close(datafd);
	if (packagefd >= 0)
		close(packagefd);
	if (packagesfd >= 0)
		close(packagesfd);
	if (statefd >= 0)
		close(statefd);
	if (varfd >= 0)
		close(varfd);
	free(map.records);
	return -1;
}

static int terminate_app(const char *id, const char *pid_text)
{
	char proc_path[64];
	char expected_package[160];
	char executable[256];
	char command[512];
	char *end = NULL;
	unsigned long parsed_pid;
	struct stat process_stat;
	struct app_map map = {0};
	ssize_t record;
	uid_t uid;
	int varfd = -1, statefd = -1, lockfd = -1, cmdfd = -1, cgroupfd = -1;
	ssize_t length;

	if (!valid_app_id(id) || !pid_text || strlen(pid_text) > 10) {
		errno = EINVAL;
		goto fail;
	}
	parsed_pid = strtoul(pid_text, &end, 10);
	if (end == pid_text || *end || parsed_pid < 2 || parsed_pid > INT_MAX) {
		errno = EINVAL;
		goto fail;
	}
	varfd = open_var_lib();
	if (varfd < 0)
		goto fail;
	statefd = ensure_root_dir(varfd, STATE_DIR, 0700);
	if (statefd < 0)
		goto fail;
	lockfd = openat(statefd, "mapping.lock",
			O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
	if (lockfd < 0 || valid_root_file(lockfd, 0600) < 0 ||
	    flock(lockfd, LOCK_SH) < 0 || load_map(statefd, &map) < 0)
		goto fail;
	record = find_app(&map, id);
	if (record < 0) {
		errno = ENOENT;
		goto fail;
	}
	uid = map.records[record].uid;
	cgroupfd = open_app_cgroup(uid, false);
	if (cgroupfd < 0)
		goto fail;
	if (snprintf(proc_path, sizeof(proc_path), "/proc/%lu",
		     parsed_pid) >= (int)sizeof(proc_path) ||
	    snprintf(expected_package, sizeof(expected_package),
		     "/var/lib/%s/%s", PACKAGE_DIR, id) >=
		     (int)sizeof(expected_package)) {
		errno = ENAMETOOLONG;
		goto fail;
	}
	if (stat(proc_path, &process_stat) < 0) {
		if (errno == ENOENT) {
			int active = app_uid_has_process(uid);
			if (active != 0) {
				if (active < 0 ||
				    write_cgroup_control(cgroupfd, "cgroup.kill", "1\n") < 0)
					goto fail;
				for (unsigned int attempt = 0; attempt < 50; attempt++) {
					active = app_uid_has_process(uid);
					if (active == 0)
						break;
					if (active < 0)
						goto fail;
					usleep(100000);
				}
				active = app_uid_has_process(uid);
				if (active != 0) {
					if (active > 0)
						errno = EBUSY;
					goto fail;
				}
			}
			printf("terminated\n");
			free(map.records);
			close(cgroupfd);
			close(lockfd);
			close(statefd);
			close(varfd);
			return 0;
		}
		goto fail;
	}
	if (process_stat.st_uid != uid) {
		errno = EPERM;
		goto fail;
	}
	{
		char exe_path[80];
		ssize_t exe_length;
		if (snprintf(exe_path, sizeof(exe_path), "%s/exe", proc_path) >=
		    (int)sizeof(exe_path)) {
			errno = ENAMETOOLONG;
			goto fail;
		}
		exe_length = readlink(exe_path, executable, sizeof(executable) - 1);
		if (exe_length < 0)
			goto fail;
		executable[exe_length] = '\0';
		if (strcmp(executable, "/opt/nbosp/NovaByte") != 0) {
			errno = EPERM;
			goto fail;
		}
	}
	if (snprintf(proc_path, sizeof(proc_path), "/proc/%lu/cmdline",
		     parsed_pid) >= (int)sizeof(proc_path)) {
		errno = ENAMETOOLONG;
		goto fail;
	}
	cmdfd = open(proc_path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
	if (cmdfd < 0)
		goto fail;
	length = read(cmdfd, command, sizeof(command) - 1);
	close(cmdfd);
	cmdfd = -1;
	if (length <= 0) {
		errno = EIO;
		goto fail;
	}
	command[length] = '\0';
	{
		size_t offset = 0;
		size_t argument_index = 0;
		bool runtime_argument = false, package_argument = false;
		while (offset < (size_t)length) {
			size_t argument_length =
				strnlen(command + offset, (size_t)length - offset);
			if (argument_index == 0)
				runtime_argument =
					argument_length == strlen("/opt/nbosp/NovaByte") &&
					memcmp(command + offset, "/opt/nbosp/NovaByte",
					       argument_length) == 0;
			if (argument_index > 0 &&
			    argument_length == strlen(expected_package) &&
			    memcmp(command + offset, expected_package,
				   argument_length) == 0)
				package_argument = true;
			offset += argument_length + 1;
			argument_index++;
		}
		if (!runtime_argument || !package_argument) {
			errno = EPERM;
			goto fail;
		}
	}
	if (kill(-((pid_t)parsed_pid), SIGTERM) < 0 && errno != ESRCH)
		goto fail;
	for (unsigned int attempt = 0; attempt < 50; attempt++) {
		if (kill(-((pid_t)parsed_pid), 0) < 0 && errno == ESRCH)
			break;
		usleep(100000);
	}
	if (kill(-((pid_t)parsed_pid), 0) == 0)
		(void)kill(-((pid_t)parsed_pid), SIGKILL);
	if (write_cgroup_control(cgroupfd, "cgroup.kill", "1\n") < 0)
		goto fail;
	for (unsigned int attempt = 0; attempt < 50; attempt++) {
		int active = app_uid_has_process(uid);
		if (active == 0)
			break;
		if (active < 0)
			goto fail;
		usleep(100000);
	}
	{
		int active = app_uid_has_process(uid);
		if (active != 0) {
			if (active > 0)
				errno = EBUSY;
			goto fail;
		}
	}
	printf("terminated\n");
	free(map.records);
	close(cgroupfd);
	close(lockfd);
	close(statefd);
	close(varfd);
	return 0;

fail:
	report_errno("App termination failed");
	if (cmdfd >= 0)
		close(cmdfd);
	if (cgroupfd >= 0)
		close(cgroupfd);
	if (lockfd >= 0)
		close(lockfd);
	if (statefd >= 0)
		close(statefd);
	if (varfd >= 0)
		close(varfd);
	free(map.records);
	return -1;
}

int main(int argc, char **argv)
{
#if !defined(__linux__) || !defined(__x86_64__)
	(void)argc;
	(void)argv;
	fprintf(stderr, "nbosp-app-supervisor supports Linux x86_64 only\n");
	return 1;
#else
	if (geteuid() != 0) {
		fprintf(stderr, "nbosp-app-supervisor must be invoked by root\n");
		return 1;
	}
	if (argc == 3 && strcmp(argv[1], "provision-uid") == 0) {
		uid_t uid;
		if (!valid_app_id(argv[2])) {
			fprintf(stderr, "Invalid app ID\n");
			return 2;
		}
		if (provision(argv[2], &uid) < 0)
			return 1;
		printf("%u\n", (unsigned int)uid);
		return 0;
	}
	if (argc == 4 && strcmp(argv[1], "install") == 0) {
		if (!valid_app_id(argv[2]) || !valid_entry_path(argv[3])) {
			fprintf(stderr, "Invalid app ID or entry path\n");
			return 2;
		}
		return install_app(argv[2], argv[3]) == 0 ? 0 : 1;
	}
	if (argc == 5 && strcmp(argv[1], "launch") == 0) {
		if (!valid_app_id(argv[2])) {
			fprintf(stderr, "Invalid app ID\n");
			return 2;
		}
		return launch_app(argv[2], argv[3], argv[4]) == 0 ? 0 : 1;
	}
	if (argc == 3 && strcmp(argv[1], "uninstall") == 0) {
		if (!valid_app_id(argv[2])) {
			fprintf(stderr, "Invalid app ID\n");
			return 2;
		}
		return uninstall_app(argv[2]) == 0 ? 0 : 1;
	}
	if (argc == 4 && strcmp(argv[1], "terminate") == 0) {
		if (!valid_app_id(argv[2])) {
			fprintf(stderr, "Invalid app ID\n");
			return 2;
		}
		return terminate_app(argv[2], argv[3]) == 0 ? 0 : 1;
	}
	if (argc != 3) {
		fprintf(stderr,
			"Usage: nbosp-app-supervisor {provision|provision-uid} APP_ID\n"
			"       nbosp-app-supervisor install APP_ID ENTRY\n"
			"       nbosp-app-supervisor uninstall APP_ID\n"
			"       nbosp-app-supervisor launch APP_ID PORT TOKEN\n"
			"       nbosp-app-supervisor terminate APP_ID PID\n");
		return 2;
	}
	if (!valid_app_id(argv[2])) {
		fprintf(stderr, "Invalid app ID\n");
		return 2;
	}
	if (strcmp(argv[1], "provision") == 0)
		return provision(argv[2], NULL) == 0 ? 0 : 1;
	fprintf(stderr, "Unsupported operation\n");
	return 2;
#endif
}
