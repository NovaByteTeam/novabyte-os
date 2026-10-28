import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const root = new URL('../../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

describe('NBOSP SELinux init integration contract', () => {
  it('builds the standalone policy-loading init wrapper', () => {
    const config = read('os/package/nbosp-selinux-init/Config.in');
    const makefile = read('os/package/nbosp-selinux-init/nbosp-selinux-init.mk');
    const defconfig = read('os/configs/nbosp_x86_64_defconfig');
    const policy = read('os/package/nbosp-selinux-init/selinux/nbosp_boot.fc');
    const policyInterface = read('os/package/nbosp-selinux-init/selinux/nbosp_boot.if');

    assert.match(config, /config BR2_PACKAGE_NBOSP_SELINUX_INIT/);
    assert.match(config, /select BR2_PACKAGE_LIBSELINUX/);
    assert.match(makefile, /nbosp-init\.c -lselinux/);
    assert.match(makefile, /TARGET_DIR\)\/sbin\/nbosp-init/);
    assert.match(defconfig, /BR2_PACKAGE_NBOSP_SELINUX_INIT=y/);
    assert.match(defconfig, /package\/nbosp-selinux-init\/selinux/);
    assert.match(policy, /\/sbin\/nbosp-init.*init_exec_t/);
    assert.match(policy, /\/sbin\/nbosp-busybox-init.*init_exec_t/);
    assert.match(policyInterface, /^## <summary>[\s\S]*## <\/summary>/);
    assert.match(policyInterface, /intentionally exports no public interfaces/);
  });

  it('loads and labels SELinux before handing off to standalone BusyBox init', () => {
    const init = read('os/package/nbosp-selinux-init/nbosp-init.c');
    const postBuild = read('os/board/nbosp/post-build.sh');
    const inittab = read('os/board/nbosp/rootfs-overlay/etc/inittab');
    const rcS = read('os/board/nbosp/rootfs-overlay/etc/init.d/rcS');
    const busybox = read('os/board/nbosp/busybox.fragment');
    const buildScript = read('os/build-iso.sh');

    assert.match(init, /selinux_init_load_policy/);
    assert.match(init, /run_setfiles/);
    assert.match(init, /mount\("devtmpfs", "\/dev", "devtmpfs"/);
    assert.match(init, /\/sbin\/nbosp-busybox-init/);
    assert.match(init, /initramfs labeling complete/);
    assert.match(postBuild, /cp -L "\$INIT_APPLET" "\$PRESERVED_INIT"/);
    assert.match(postBuild, /ln -sfn sbin\/nbosp-init/);
    assert.match(inittab, /::sysinit:\/bin\/sh \/etc\/init\.d\/rcS/);
    assert.match(inittab, /::shutdown:\/bin\/sh \/etc\/init\.d\/rcK/);
    assert.match(rcS, /for script in \/etc\/init\.d\/S\[0-9\]\[0-9\]\*/);
    assert.match(busybox, /^CONFIG_ASH=y$/m);
    assert.match(busybox, /^CONFIG_INSTALL_SH_APPLET_SYMLINK=y$/m);
    assert.match(buildScript, /The SELinux init wrapper and BusyBox init applet/);
    assert.match(buildScript, /BusyBox \/bin\/sh is missing from the generated rootfs/);
    assert.match(buildScript, /rootfs\.cpio\.gz[\s\S]*cpio -it/);
  });

  it('keeps NovaByte’s existing desktop app sandbox and scheduler enabled', () => {
    const html = read('index.html');
    const registry = read('js/platform/core/app-registry.js');

    assert.match(html, /security\/app-sandbox\.js/);
    assert.match(html, /security\/app-scheduler\.js/);
    assert.match(registry, /return AppSandbox\.launch\(app, content, state, options\)/);
    assert.doesNotMatch(html, /isolated-app-broker/);
    assert.doesNotMatch(registry, /linuxIsolated|IsolatedAppBroker/);
  });
});
