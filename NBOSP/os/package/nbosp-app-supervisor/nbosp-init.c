#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <selinux/selinux.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define SELINUX_READY_FILE "/run/nbosp-selinux-loaded"

static int mount_early_filesystems(void)
{
	if (mkdir("/proc", 0555) < 0 && errno != EEXIST)
		return -1;
	if (mount("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC,
		  NULL) < 0 && errno != EBUSY)
		return -1;
	if (mkdir("/sys", 0555) < 0 && errno != EEXIST)
		return -1;
	if (mount("sysfs", "/sys", "sysfs", MS_NOSUID | MS_NODEV | MS_NOEXEC,
		  NULL) < 0 && errno != EBUSY)
		return -1;
	if (mkdir("/run", 0755) < 0 && errno != EEXIST)
		return -1;
	return 0;
}

static int run_setfiles(void)
{
	static char *const arguments[] = {
		(char *)"setfiles",
		(char *)"-e",
		(char *)"/proc",
		(char *)"-e",
		(char *)"/sys",
		(char *)"-e",
		(char *)"/dev",
		(char *)"-F",
		(char *)"/etc/selinux/targeted/contexts/files/file_contexts",
		(char *)"/",
		NULL,
	};
	pid_t child;
	int status;
	pid_t waited;

	child = fork();
	if (child < 0)
		return -1;
	if (child == 0) {
		execv("/sbin/setfiles", arguments);
		if (errno == ENOENT)
			execv("/usr/sbin/setfiles", arguments);
		perror("NBOSP init: cannot execute setfiles");
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

static void halt_on_error(const char *operation)
{
	perror(operation);
	for (;;)
		pause();
}

static int selinux_ready(void)
{
	int fd = open(SELINUX_READY_FILE, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
	if (fd >= 0) {
		close(fd);
		return 1;
	}
	if (errno == ENOENT)
		return 0;
	return -1;
}

static int mark_selinux_ready(void)
{
	int fd = open(SELINUX_READY_FILE,
		      O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
		      0600);
	size_t offset = 0;
	static const char content[] = "loaded\n";

	if (fd < 0)
		return -1;
	while (offset < sizeof(content) - 1) {
		ssize_t count = write(fd, content + offset,
				      sizeof(content) - 1 - offset);
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
	if (fsync(fd) < 0) {
		int saved_errno = errno;
		close(fd);
		errno = saved_errno;
		return -1;
	}
	return close(fd);
}

int main(void)
{
	int enforcing = 0;
	int ready;
	char *const init_arguments[] = {
		(char *)"/sbin/nbosp-init",
		NULL,
	};
	char *const busybox_arguments[] = {
		(char *)"init",
		NULL,
	};

	if (mount_early_filesystems() < 0)
		halt_on_error("NBOSP init: mounting early filesystems failed");

	ready = selinux_ready();
	if (ready < 0)
		halt_on_error("NBOSP init: checking SELinux load state failed");
	if (!ready) {
		if (selinux_init_load_policy(&enforcing) < 0)
			halt_on_error("NBOSP init: loading SELinux policy failed");
		if (run_setfiles() < 0)
			halt_on_error("NBOSP init: labeling initramfs failed");
		if (mark_selinux_ready() < 0)
			halt_on_error("NBOSP init: recording SELinux load state failed");
		execv("/sbin/nbosp-init", init_arguments);
		halt_on_error("NBOSP init: SELinux re-exec failed");
	}

	execv("/sbin/nbosp-busybox-init", busybox_arguments);
	halt_on_error("NBOSP init: starting BusyBox init failed");
	return 1;
}
