// tests/apps/wallpaper.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/wallpaper/service.js.
// The real service is require()d against a live JSDOM window, then
// styleFor/apply/getPresets are driven against a real document whose
// #wallpaper / #desktop nodes are created per scenario (absent, one,
// both), the way the shell mounts them.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { coverLoadServiceApp } from '../helpers/cover-loader.js';

async function mount() {
  const ctx = await coverLoadServiceApp('wallpaper');
  return ctx;
}

describe('WallpaperService (js/apps/wallpaper/service.js) — e2e coverage', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.resetModules();
  });

  it('exposes a frozen facade with apply/styleFor/getPresets', async () => {
    const { window } = await mount();
    const svc = window.WallpaperService;
    expect(Object.isFrozen(svc)).toBe(true);
    expect(typeof svc.apply).toBe('function');
    expect(typeof svc.styleFor).toBe('function');
    expect(typeof svc.getPresets).toBe('function');
  });

  it('styleFor maps every preset id to its gradient without a custom wallpaper', async () => {
    const { window } = await mount();
    for (const preset of window.WallpaperService.getPresets()) {
      const look = window.WallpaperService.styleFor(preset.id);
      expect(look.backgroundImage).toBe(preset.gradient);
      expect(look.backgroundSize).toBe('');
      expect(look.backgroundPosition).toBe('');
      expect(look.backgroundRepeat).toBe('');
    }
  });

  it('styleFor falls back to stock-blue for an unknown id', async () => {
    const { window } = await mount();
    const look = window.WallpaperService.styleFor('does-not-exist');
    const blue = window.WallpaperService.styleFor('stock-blue');
    expect(look.backgroundImage).toBe(blue.backgroundImage);
  });

  it('styleFor uses the custom wallpaper URL when one is supplied', async () => {
    const { window } = await mount();
    const dataUri = 'data:image/png;base64,AAA';
    const look = window.WallpaperService.styleFor('stock-dark', dataUri);
    expect(look.backgroundImage).toBe(`url(${JSON.stringify(dataUri)})`);
    expect(look.backgroundSize).toBe('cover');
    expect(look.backgroundPosition).toBe('center');
    expect(look.backgroundRepeat).toBe('no-repeat');
    // falsy custom values (null and '') must keep the preset gradient
    const viaNull = window.WallpaperService.styleFor('stock-dark', null);
    expect(viaNull.backgroundImage).toBe(window.WallpaperService.styleFor('stock-dark').backgroundImage);
    const viaEmpty = window.WallpaperService.styleFor('stock-teal', '');
    expect(viaEmpty.backgroundImage).toBe(window.WallpaperService.styleFor('stock-teal').backgroundImage);
  });

  it('apply rejects a non-function settings reader', async () => {
    const { window } = await mount();
    expect(() => window.WallpaperService.apply(null)).toThrow(TypeError);
    expect(() => window.WallpaperService.apply({ wallpaperId: 'stock-blue' })).toThrow(TypeError);
  });

  it('apply returns false when neither #wallpaper nor #desktop exists', async () => {
    const { window } = await mount();
    expect(window.WallpaperService.apply(() => 'stock-blue')).toBe(false);
  });

  it('apply styles only #wallpaper when #desktop is absent', async () => {
    const { window } = await mount();
    const wallpaper = window.document.createElement('div');
    wallpaper.id = 'wallpaper';
    window.document.body.append(wallpaper);
    expect(window.WallpaperService.apply((key) => (key === 'wallpaperId' ? 'stock-purple' : undefined))).toBe(true);
    // jsdom re-serialises assigned CSS; compare against a reference element
    // styled with the same look rather than the raw preset string.
    const ref = window.document.createElement('div');
    Object.assign(ref.style, window.WallpaperService.styleFor('stock-purple'));
    expect(wallpaper.style.backgroundImage).toBe(ref.style.backgroundImage);
    expect(wallpaper.style.backgroundImage).toContain('radial-gradient');
  });

  it('apply styles only #desktop when #wallpaper is absent', async () => {
    const { window } = await mount();
    const desktop = window.document.createElement('section');
    desktop.id = 'desktop';
    window.document.body.append(desktop);
    const reads = [];
    expect(window.WallpaperService.apply((key) => { reads.push(key); return key === 'customWallpaper' ? 'pic.webp' : 'stock-gray'; })).toBe(true);
    expect(reads).toEqual(['wallpaperId', 'customWallpaper']);
    expect(desktop.style.backgroundImage).toBe('url("pic.webp")');
    expect(desktop.style.backgroundSize).toBe('cover');
  });

  it('apply styles both nodes when both exist', async () => {
    const { window } = await mount();
    const wallpaper = window.document.createElement('div');
    wallpaper.id = 'wallpaper';
    const desktop = window.document.createElement('section');
    desktop.id = 'desktop';
    window.document.body.append(wallpaper, desktop);
    expect(window.WallpaperService.apply((key) => (key === 'wallpaperId' ? 'stock-red' : null))).toBe(true);
    const ref = window.document.createElement('div');
    Object.assign(ref.style, window.WallpaperService.styleFor('stock-red'));
    expect(wallpaper.style.backgroundImage).toBe(ref.style.backgroundImage);
    expect(desktop.style.backgroundImage).toBe(ref.style.backgroundImage);
  });

  it('getPresets lists every preset with id, name and gradient', async () => {
    const { window } = await mount();
    const presets = window.WallpaperService.getPresets();
    expect(presets).toHaveLength(8);
    expect(presets.map((p) => p.id)).toEqual(expect.arrayContaining(['stock-blue', 'stock-red']));
    for (const p of presets) {
      expect(typeof p.name).toBe('string');
      expect(p.gradient).toMatch(/gradient/);
    }
  });
});
