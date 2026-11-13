import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const packageDir = new URL('.', import.meta.url);
const read = (name) => readFileSync(new URL(name, packageDir), 'utf8');

describe('NBOSP labwc kiosk configuration', () => {
  it('builds labwc and XWayland without the Weston desktop experiment', () => {
    const config = read('../../configs/nbosp_x86_64_defconfig');
    const build = read('../../build-iso.sh');

    assert.match(config, /^BR2_PACKAGE_LABWC=y$/m);
    assert.match(config, /^BR2_PACKAGE_WLROOTS_XWAYLAND=y$/m);
    assert.match(config, /^BR2_PACKAGE_XWAYLAND=y$/m);
    assert.doesNotMatch(config, /BR2_PACKAGE_CAGE/);
    assert.doesNotMatch(config, /BR2_PACKAGE_WESTON/);
    assert.doesNotMatch(build, /target\/usr\/bin\/weston/);
  });

  it('uses the Buildroot 2026.08.1 release and the 7.3.4 kernel', () => {
    const build = read('../../build-iso.sh');
    const config = read('../../configs/nbosp_x86_64_defconfig');

    assert.match(build, /^BUILDROOT_VERSION="2026\.08\.1"$/m);
    assert.match(config, /^BR2_LINUX_KERNEL_CUSTOM_VERSION_VALUE="7\.3\.4"$/m);
  });

  it('overrides wlroots to 0.20.2 for labwc 0.20.3 and keeps no fixed-upstream patches', () => {
    const wlrootsMk = read('../../overrides/wlroots/wlroots.mk');
    const wlrootsHash = read('../../overrides/wlroots/wlroots.hash');
    const build = read('../../build-iso.sh');

    assert.match(wlrootsMk, /^WLROOTS_VERSION = 0\.20\.2$/m);
    assert.match(wlrootsHash, /80c567d2ed4efb2cfa6b077f22c7a710d9c78ba4e185a75e8694001114af0733/);
    assert.match(build, /overrides\/wlroots/);
    // The retired overrides (Xwayland glamor fix, host-m4 gnulib fix) are
    // fixed upstream in Buildroot 2026.08 and must not come back.
    assert.doesNotMatch(build, /overrides\/xwayland/);
    assert.doesNotMatch(build, /overrides\/host-m4/);
  });

  it('carries the labwc package recipe with stacking-compositor rationale', () => {
    const mk = read('../labwc/labwc.mk');
    const configIn = read('../labwc/Config.in');
    const hash = read('../labwc/labwc.hash');

    assert.match(mk, /^LABWC_VERSION = 0\.20\.3$/m);
    assert.match(mk, /-Dxwayland=enabled/);
    assert.match(mk, /-Dsvg=disabled/);
    assert.match(mk, /-Dicon=disabled/);
    assert.match(mk, /-Dlabnag=disabled/);
    assert.match(configIn, /window-stacking compositor/);
    assert.match(configIn, /layer-shell/);
    assert.match(hash, /^sha256  1e70a5b74f149c5b47da76063dbdf967c44b2d7b6e94d3fdf65f70fc252f65c9  labwc-0\.20\.3\.tar\.gz$/m);
  });

  it('starts the kiosk session under labwc with -S session supervision', () => {
    const init = read('../../board/nbosp/S99nbosp');
    const mounts = read('../../board/nbosp/rootfs-overlay/etc/init.d/S01mounts');
    const prepare = read('prepare-kiosk.mjs');
    const packageMakefile = read('nbosp-kiosk.mk');

    assert.match(init, /exec \/usr\/bin\/labwc \$labwc_debug_flag -C \/etc\/labwc -S \/run\/nbosp-kiosk-session\.sh/);
    assert.match(init, /XDG_CURRENT_DESKTOP=labwc/);
    assert.doesNotMatch(init, /cage/i);
    assert.doesNotMatch(init, /weston|compositor_mode|NBOSP_COMPOSITOR_MODE/i);
    assert.match(prepare, /frame: false/);
    assert.match(prepare, /fullscreen: true/);
    assert.match(prepare, /kiosk: true/);
    assert.match(mounts, /mkdir -p [^\n]*\/var\/lock\/subsys/);
    assert.match(packageMakefile, /chmod 0755 \$\(TARGET_DIR\)\/opt\/nbosp\/package\.nw \\/);
    assert.match(packageMakefile, /package\.nw\/js \\/);
    assert.match(packageMakefile, /package\.nw\/js\/apps/);
    assert.match(packageMakefile, /chmod 0644 \$\(TARGET_DIR\)\/opt\/nbosp\/package\.nw\/js\/apps\/novaapp-manifest\.json/);
  });

  it('ships the kiosk rc.xml with ZERO compositor bindings (full cage-parity lockdown)', () => {
    const rc = read('../../board/nbosp/rootfs-overlay/etc/labwc/rc.xml');

    // No default keybinds: A-Tab focus cycling, A-F4 close and the A-Space
    // window menu are compositor actions the kiosk must never expose. Every
    // shortcut is owned inside the NovaByte app window; PrintScreen is
    // handled in-page (ScreenshotService), not by the compositor.
    // Comments are stripped first so explanatory prose cannot satisfy the
    // structural assertions.
    const keyboardSection = (rc.match(/<keyboard>[\s\S]*?<\/keyboard>/)?.[0] ?? '')
      .replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(keyboardSection.includes('<keyboard>'), 'keyboard section present');
    assert.doesNotMatch(keyboardSection, /<default\s*\/>/);
    assert.doesNotMatch(keyboardSection, /<keybind/);
    // Pointer events must keep flowing to the fullscreen app like under cage.
    assert.match(rc, /<mouse>\s*<default \/>/);
    // No titlebar or borders on any window. Comments are stripped so the
    // explanation above cannot satisfy this.
    const rules = rc.replace(/<!--[\s\S]*?-->/g, '');
    assert.match(rules, /<windowRule identifier="\*" serverDecoration="no" \/>/);
  });

  it('keeps the machine home clean: session logs under /var/log/nbosp, cache under /var/cache/nbosp', () => {
    const init = read('../../board/nbosp/S99nbosp');
    const vmusr = read('../../board/nbosp/rootfs-overlay/usr/bin/nbosp-vmusr');

    // Session logs never land in the kiosk user's home.
    assert.match(init, /nbosp_log_dir=\/var\/log\/nbosp/);
    assert.match(init, /GL_DEBUG_LOG="\$nbosp_log_dir\/gl-debug\.log"/);
    assert.match(init, /tee -a \/var\/log\/nbosp\/kiosk\.log/);
    assert.match(init, /XDG_CACHE_HOME=\/var\/cache\/nbosp/);
    assert.match(vmusr, /LOG="\$LOG_DIR\/vmusr\.log"/);
    assert.match(vmusr, /LOG_DIR=\/var\/log\/nbosp/);
    // Nothing writes to the home root anymore — and the boot janitor sweeps
    // whatever older builds left there (legacy logs + the old ~/.cache).
    assert.doesNotMatch(init, />\/?home\/nbosp\/[^ ]*\.log/);
    assert.doesNotMatch(init, /tee -a \/home\/nbosp\//);
    assert.match(init, /mv -f "\/home\/nbosp\/\$f" "\$nbosp_log_dir\/\$f"/);
    assert.match(init, /rm -rf \/home\/nbosp\/.cache/);
  });

  it('boots without SELinux policy, boot wrapper, or kernel configuration', () => {
    const config = read('../../configs/nbosp_x86_64_defconfig');
    const kernel = read('../../board/nbosp/linux.fragment');
    const grub = read('../../board/nbosp/grub.cfg');
    const postBuild = read('../../board/nbosp/post-build.sh');
    const build = read('../../build-iso.sh');

    assert.doesNotMatch(config, /SELINUX|REfpolicy|LIBSELINUX/i);
    assert.doesNotMatch(kernel, /SELINUX|AUDIT|NETFILTER|IP_NF|IP6_NF/);
    assert.doesNotMatch(grub, /selinux|enforcing=/i);
    assert.doesNotMatch(postBuild, /selinux|nbosp-init/i);
    assert.doesNotMatch(build, /nbosp-selinux-init|SELINUX_POLICY_ENTRY|CONFIG_SECURITY_SELINUX/);
  });
});
