import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const readWorkspaceFile = path => readFileSync(
  fileURLToPath(new URL(path, import.meta.url)),
  'utf8'
);

describe('built-in service boundaries', () => {
  it('lists each extracted service in both runtime manifests', () => {
    const serviceIds = [
      'com.nbosp.service.wallpaper',
      'com.nbosp.service.lock-screen',
      'com.nbosp.service.tray',
      'com.nbosp.service.screenshots',
    ];
    const runtimeServices = JSON.parse(readWorkspaceFile('../../js/apps/system-service-manifest.json'));
    const packageManifest = JSON.parse(readWorkspaceFile('../../js/apps/novaapp-manifest.json'));
    const systemEventsIndex = runtimeServices.findIndex(service => service.id === 'com.nbosp.service.system-events');

    for (const id of serviceIds) {
      expect(runtimeServices).toContainEqual({ id, entry: 'service.js' });
      expect(runtimeServices.findIndex(service => service.id === id)).toBeLessThan(systemEventsIndex);
      expect(packageManifest).toContainEqual({
        id,
        file: `js/apps/${id}.novaapp`,
        systemService: true,
      });
    }
  });

  it('applies preset and custom wallpapers through the wallpaper service', () => {
    const serviceSource = readWorkspaceFile('../../js/apps/wallpaper/service.js');
    const wallpaperStyle = {};
    const desktopStyle = {};
    const elements = {
      wallpaper: { style: wallpaperStyle },
      desktop: { style: desktopStyle },
    };
    const context = {
      document: { getElementById: id => elements[id] || null },
      window: {},
    };
    runInNewContext(serviceSource, context);

    const service = context.window.WallpaperService;
    const settings = { wallpaperId: 'stock-teal', customWallpaper: null };
    const get = key => settings[key];

    expect(service.getPresets()).toHaveLength(8);
    expect(service.apply(get)).toBe(true);
    expect(wallpaperStyle.backgroundImage).toContain('linear-gradient');
    expect(desktopStyle.backgroundImage).toBe(wallpaperStyle.backgroundImage);

    settings.customWallpaper = 'data:image/png;base64,abc';
    expect(service.apply(get)).toBe(true);
    expect(wallpaperStyle.backgroundImage).toContain('data:image/png;base64,abc');
    expect(desktopStyle.backgroundSize).toBe('cover');
  });

  it('loads extracted services before System Events without global declaration collisions', () => {
    const document = {
      getElementById: () => null,
      addEventListener() {},
      removeEventListener() {},
      querySelectorAll: () => [],
    };
    const window = {
      addEventListener() {},
      removeEventListener() {},
    };
    const context = {
      window,
      document,
      OS: {
        windows: new Map(),
        settings: { get: () => null },
        events: { on() {}, emit() {} },
      },
      Notify: {
        loadPersisted() {},
        renderPanel() {},
        updateBadge() {},
        togglePanel() {},
      },
      EventLog: { log() {} },
      navigator: { getBattery: async () => null },
      throttleRAF: callback => callback,
      setInterval: () => 1,
      clearInterval() {},
      requestAnimationFrame() {},
      TextEncoder,
      TextDecoder,
      Uint8Array,
      atob,
      console,
    };
    const servicePaths = [
      '../../js/apps/wallpaper/service.js',
      '../../js/apps/lock-screen/service.js',
      '../../js/apps/tray/service.js',
      '../../js/apps/screenshots/service.js',
      '../../js/apps/system-events/service.js',
    ];

    for (const servicePath of servicePaths) {
      runInNewContext(readWorkspaceFile(servicePath), context);
    }

    expect(window.WallpaperService).toBeDefined();
    expect(window.LockScreenService).toBeDefined();
    expect(window.TrayService).toBeDefined();
    expect(window.ScreenshotService).toBeDefined();
  });

  it('uses the existing Scanner API for executable and active-content checks', async () => {
    const serviceSource = readWorkspaceFile('../../js/apps/scanner/service.js');
    const context = {
      TextEncoder,
      TextDecoder,
      Uint8Array,
      atob,
      window: {},
    };
    runInNewContext(serviceSource, context);

    const scanner = context.window.Scanner;
    await expect(scanner.scanText('payload.exe', '')).resolves.toMatchObject({ safe: false });
    await expect(scanner.scanText('page.html', '<script>alert(1)</script>'))
      .resolves.toMatchObject({ safe: false });
    await expect(scanner.scanText('notes.txt', 'A normal plain-text note.'))
      .resolves.toMatchObject({ safe: true });
  });
});
