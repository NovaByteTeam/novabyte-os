import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const packageDir = new URL('.', import.meta.url);
const read = (name) => readFileSync(new URL(name, packageDir), 'utf8');

describe('NBOSP app supervisor integration contract', () => {
  it('is enabled only for the supported x86_64 Buildroot target', () => {
    assert.match(read('Config.in'), /depends on BR2_x86_64/);
    assert.match(read('../../configs/nbosp_x86_64_defconfig'),
      /BR2_PACKAGE_NBOSP_APP_SUPERVISOR=y/);
  });

  it('uses a fixed runtime and accepts only validated app identifiers and entries', () => {
    const source = read('nbosp-app-supervisor.c');
    assert.match(source, /provision-uid/);
    assert.match(source, /install APP_ID ENTRY/);
    assert.match(source, /launch APP_ID PORT TOKEN/);
    assert.match(source, /terminate APP_ID PID/);
    assert.match(source, /uninstall APP_ID/);
    assert.match(source, /valid_app_id\(argv\[2\]\)/);
    assert.match(source, /execve\("\/opt\/nbosp\/NovaByte", child_argv, environ\)/);
    assert.match(source, /PR_SET_NO_NEW_PRIVS/);
    assert.match(source, /PR_SET_SECCOMP, SECCOMP_MODE_FILTER/);
    assert.match(source, /SECCOMP_RET_KILL_PROCESS/);
    assert.match(source, /RLIMIT_NPROC/);
    assert.match(source, /RLIMIT_FSIZE/);
    assert.match(source, /"memory.max", "2147483648\\n"/);
    assert.match(source, /"cgroup.kill", "1\\n"/);
    assert.match(source, /setgroups\(1, supplementary_groups\)/);
    assert.doesNotMatch(source, /\b(system|popen)\s*\(/);
  });

  it('authenticates the desktop peer and dispatches only bounded supervisor operations', () => {
    const source = read('nbosp-app-supervisor-service.c');
    assert.match(source, /SO_PEERCRED/);
    assert.match(source, /credentials\.uid != DESKTOP_UID/);
    assert.match(source, /"PROVISION"/);
    assert.match(source, /"INSTALL"/);
    assert.match(source, /"LAUNCH"/);
    assert.match(source, /"TERMINATE"/);
    assert.match(source, /"UNINSTALL"/);
    assert.match(source, /HELPER_PATH "\/usr\/sbin\/nbosp-app-supervisor"/);
    assert.match(source, /execve\(HELPER_PATH, child_argv, child_env\)/);
    assert.match(source, /SOCK_STREAM/);
    assert.doesNotMatch(source, /\b(system|popen)\s*\(/);
    assert.match(read('S12nbosp-app-supervisor'), /start-stop-daemon --start/);
    assert.match(read('S12nbosp-app-supervisor'), /policyvers/);
  });

  it('builds and verifies both supervisor executables and starts the service at boot', () => {
    const makefile = read('nbosp-app-supervisor.mk');
    const buildScript = read('../../build-iso.sh');
    assert.match(makefile, /nbosp-app-supervisor-service\.c/);
    assert.match(makefile, /nbosp-init\.c -lselinux/);
    assert.match(makefile, /isolated-app-node-main\.js/);
    assert.match(makefile, /S12nbosp-app-supervisor/);
    assert.match(read('isolated-app-node-main.js'), /nbosp-api-call/);
    assert.match(buildScript, /BR2_PACKAGE_NBOSP_APP_SUPERVISOR/);
    assert.match(buildScript, /nbosp-app-supervisor-service/);
  });

  it('loads and labels the permissive SELinux policy before BusyBox init', () => {
    const defconfig = read('../../configs/nbosp_x86_64_defconfig');
    const kernel = read('../../board/nbosp/linux.fragment');
    const grub = read('../../board/nbosp/grub.cfg');
    const postBuild = read('../../board/nbosp/post-build.sh');
    const init = read('nbosp-init.c');
    const policy = read('selinux/nbosp_app.te');
    const interfaces = read('selinux/nbosp_app.if');
    const fileContexts = read('selinux/nbosp_app.fc');
    assert.match(defconfig, /BR2_PACKAGE_REFPOLICY=y/);
    assert.match(defconfig, /BR2_PACKAGE_REFPOLICY_POLICY_STATE_PERMISSIVE=y/);
    assert.match(kernel, /CONFIG_SECURITY_SELINUX=y/);
    assert.match(grub, /selinux=1 enforcing=0/);
    assert.match(postBuild, /ln -sfn sbin\/nbosp-init/);
    assert.match(init, /selinux_init_load_policy/);
    assert.match(init, /run_setfiles/);
    assert.match(init, /\/bin\/busybox/);
    assert.match(policy, /domain_auto_trans\(nbosp_app_supervisor_t, nbosp_app_runtime_exec_t/);
    assert.match(interfaces, /exports no interfaces/);
    assert.match(fileContexts, /nbosp_app_runtime_exec_t/);
    assert.match(fileContexts, /nbosp_app_data_t/);
  });

  it('restricts app UID network egress to the authenticated loopback broker', () => {
    const defconfig = read('../../configs/nbosp_x86_64_defconfig');
    const kernel = read('../../board/nbosp/linux.fragment');
    const init = read('../../board/nbosp/S99nbosp');
    const broker = read('../../../js/platform/security/isolated-app-broker.js');
    assert.match(defconfig, /BR2_PACKAGE_IPTABLES=y/);
    assert.match(kernel, /CONFIG_NETFILTER_XT_MATCH_OWNER=y/);
    assert.match(kernel, /CONFIG_SECCOMP_FILTER=y/);
    assert.match(kernel, /CONFIG_CGROUP2_FS=y/);
    assert.match(kernel, /CONFIG_MEMCG=y/);
    assert.match(kernel, /CONFIG_CGROUP_PIDS=y/);
    assert.match(init, /--uid-owner 20000-59999/);
    assert.match(init, /nbosp_app_resource_setup/);
    assert.match(init, /--dport 49173 -j ACCEPT/);
    assert.match(broker, /BROKER_PORT = 49173/);
    assert.match(broker, /nodejs: false/);
  });

  it('keeps state root-owned and denies desktop access to private app directories', () => {
    const source = read('nbosp-app-supervisor.c');
    assert.match(source, /STATE_DIR "nbosp-apps"/);
    assert.match(source, /DATA_DIR "nbosp-app-data"/);
    assert.match(source, /ensure_root_dir\(varfd, STATE_DIR, 0700\)/);
    assert.match(source, /fchown\(anchorfd, 0, 0\)/);
    assert.match(source, /fchmod\(anchorfd, 0700\)/);
    assert.match(source, /set_anchor_acl\(anchorfd, uid\)/);
    assert.match(source, /fsetxattr\(fd, "system\.posix_acl_access"/);
    assert.match(source, /fchown\(appfd, uid, uid\)/);
    assert.match(source, /fchmod\(appfd, 0700\)/);
    assert.match(source, /flock\(lockfd, LOCK_EX\)/);
    assert.match(source, /renameat\(statefd, temp_name, statefd, "mapping"\)/);
  });
});
