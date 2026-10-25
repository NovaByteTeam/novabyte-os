import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const packageDir = new URL('.', import.meta.url);
const read = (name) => readFileSync(new URL(name, packageDir), 'utf8');

describe('Weston multi-process windowing proof of concept', () => {
  it('keeps Cage as the default and builds Weston desktop with XWayland', () => {
    const config = read('../../configs/nbosp_x86_64_defconfig');
    const build = read('../../build-iso.sh');
    assert.match(config, /BR2_PACKAGE_CAGE=y/);
    assert.match(config, /BR2_PACKAGE_WESTON=y/);
    assert.match(config, /BR2_PACKAGE_WESTON_DEFAULT_DRM=y/);
    assert.match(config, /BR2_PACKAGE_WESTON_XWAYLAND=y/);
    assert.match(config, /BR2_PACKAGE_WESTON_SHELL_DESKTOP=y/);
    assert.match(build, /target\/usr\/bin\/weston-terminal/);
    assert.match(build, /target\/usr\/bin\/Xwayland/);
  });

  it('selects Weston only by an explicit local setting and launches two clients', () => {
    const init = read('../../board/nbosp/S99nbosp');
    const poc = read('nbosp-weston-poc-session');
    assert.match(init, /compositor_mode=cage/);
    assert.match(init, /cage\|weston-poc/);
    assert.match(init, /--shell=desktop/);
    assert.match(init, /--xwayland/);
    assert.match(init, /nbosp-weston-poc-session/);
    assert.match(poc, /\/usr\/bin\/weston-terminal &/);
    assert.match(poc, /exec "\$APP_SESSION"/);
    assert.doesNotMatch(init, /NovaByte --kiosk/);
  });

  it('uses a windowed NovaByte host in Weston desktop mode', () => {
    const prepare = read('prepare-kiosk.mjs');
    assert.match(prepare, /fullscreen: false/);
    assert.match(prepare, /kiosk: false/);
    assert.match(prepare, /frame: true/);
  });
});
