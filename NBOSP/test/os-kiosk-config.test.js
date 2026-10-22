import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('NBOSP VMware kiosk device configuration', () => {
  it('keeps XWayland GLX GPU acceleration and checks render-node access', () => {
    const prepareKiosk = readFileSync(
      new URL('../os/package/nbosp-kiosk/prepare-kiosk.mjs', import.meta.url),
      'utf8',
    );
    const startup = readFileSync(new URL('../os/board/nbosp/S99nbosp', import.meta.url), 'utf8');
    const users = readFileSync(new URL('../os/board/nbosp/users.table', import.meta.url), 'utf8');

    for (const content of [prepareKiosk, startup]) {
      expect(content).toContain('--ozone-platform=x11');
      expect(content).toContain('--use-gl=desktop');
      expect(content).toContain('--enable-gpu-rasterization');
      expect(content).toContain('--enable-zero-copy');
      expect(content).not.toContain('--disable-gpu');
    }
    expect(users).toContain('video,input,seat');
    expect(startup).toContain('/dev/dri/renderD*');
    expect(startup).toContain('hardware acceleration would fail');
  });

  it('builds ALSA drivers, utilities, device permissions, and mixer initialization', () => {
    const defconfig = readFileSync(new URL('../os/configs/nbosp_x86_64_defconfig', import.meta.url), 'utf8');
    const kernel = readFileSync(new URL('../os/board/nbosp/linux.fragment', import.meta.url), 'utf8');
    const startup = readFileSync(new URL('../os/board/nbosp/S99nbosp', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../os/build-iso.sh', import.meta.url), 'utf8');
    const udevRules = readFileSync(
      new URL('../os/board/nbosp/rootfs-overlay/etc/udev/rules.d/70-nbosp-device-groups.rules', import.meta.url),
      'utf8',
    );

    expect(defconfig).toContain('BR2_PACKAGE_ALSA_UTILS=y');
    expect(defconfig).toContain('BR2_PACKAGE_ALSA_UTILS_ALSACTL=y');
    expect(defconfig).toContain('BR2_PACKAGE_ALSA_UTILS_APLAY=y');
    expect(build).toContain('BR2_PACKAGE_ALSA_UTILS_ALSACTL');
    expect(build).toContain('BR2_PACKAGE_ALSA_UTILS_APLAY');
    expect(build).toContain('alsa-utils-dirclean nbosp-kiosk-dirclean');
    expect(build).toContain('target/usr/sbin/alsactl');
    expect(build).toContain('target/usr/bin/aplay');
    expect(build).toContain('OWNER="nbosp", GROUP="render"');
    expect(build).toContain('OWNER="nbosp", GROUP="audio"');
    expect(kernel).toContain('CONFIG_SND_HDA_INTEL=y');
    expect(kernel).toContain('CONFIG_SND_HDA_GENERIC=y');
    expect(kernel).toContain('CONFIG_SND_ENS1371=y');
    expect(udevRules).toContain('KERNEL=="renderD*", OWNER="nbosp", GROUP="render", MODE="0660"');
    expect(udevRules).toContain('SUBSYSTEM=="sound", OWNER="nbosp", GROUP="audio", MODE="0660"');
    expect(startup).toContain('alsactl init');
    expect(startup).toContain('no ALSA sound card detected');
  });
});
