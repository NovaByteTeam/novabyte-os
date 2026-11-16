// tests/apps/novabyte-system.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/novabyte-system/service.js.
// The service is require()d with a stubbed OS facade; validators, admin
// gates, import/export, the connectivity proxy and power actions are all
// driven through the frozen window.NovaByteSystem api.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { coverLoadServiceApp } from '../helpers/cover-loader.js';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

beforeEach(() => { resetTestStorage(); });
afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.NovaUserScope;
  delete globalThis.window?.NovaUserScope;
  delete globalThis.window?.NovaConnectivity;
  delete globalThis.window?.DebugOverlay;
});

function settingsStore({ setFalseFor = [] } = {}) {
  const defaults = {
    theme: 'nova-dark', language: 'en', wallpaperId: 'stock-blue', volume: 50,
    username: 'owner', keyboardLayout: 'us', clockFormat: '24h',
    someUnvalidatedKey: 'default-value',
  };
  const _cache = { theme: 'nord', username: 'owner', devMode: false, rootAccessEnabled: false };
  return {
    defaults, _cache,
    get: vi.fn((k) => _cache[k]),
    set: vi.fn((k, v) => {
      if (setFalseFor.includes(k)) return false;
      _cache[k] = v;
      return true;
    }),
  };
}

async function mount({ settings, userScope, debugOverlay, connectivity } = {}) {
  delete globalThis.NovaUserScope;
  const store = settings ?? settingsStore();
  const OS = {
    settings: store,
    events: { emit: vi.fn() },
    username: 'owner',
    lockPin: null,
  };
  const extra = {
    OS,
    ...(userScope ? { NovaUserScope: userScope } : {}),
    ...(debugOverlay ? { DebugOverlay: debugOverlay } : {}),
    ...(connectivity ? { NovaConnectivity: connectivity } : {}),
  };
  const ctx = await coverLoadServiceApp('novabyte-system', {
    stubs: { extra },
    withBaseUtils: false, // the service never uses createEl
    i18n: true,
  });
  return { ...ctx, api: ctx.window.NovaByteSystem, store, OS };
}

describe('NovaByteSystem (js/apps/novabyte-system/service.js) — e2e coverage', () => {
  it('exposes a frozen, namespaced api and throws without an OS settings store', async () => {
    const { api } = await mount({});
    expect(api).toBeTruthy();
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api).sort()).toEqual(['developer', 'hardware', 'id', 'security', 'settings']);
    // a load without OS.settings blows up at require time
    delete globalThis.OS;
    await expect(coverLoadServiceApp('novabyte-system', {
      stubs: { extra: { OS: { settings: null, events: { emit: vi.fn() } } } },
    })).rejects.toThrow('OS settings store is unavailable');
  });

  it('settings.get enforces the readable key set', async () => {
    const { api } = await mount({});
    expect(api.settings.get('theme')).toBe('nord');
    expect(() => api.settings.get('nope')).toThrow(TypeError);
    expect(() => api.settings.get(42)).toThrow(TypeError);
    expect(() => api.settings.get('lockPin')).toThrow(TypeError); // not readable through this api
  });

  it('settings.set validates every system key', async () => {
    const { api, store } = await mount({});
    const S = api.settings;
    expect(S.set('theme', 'dracula')).toBe(true);
    expect(() => S.set('theme', 'not-a-theme')).toThrow(TypeError);
    expect(S.set('accentColor', null)).toBe(true);
    expect(S.set('accentColor', '#aabbcc')).toBe(true);
    expect(() => S.set('accentColor', 'red')).toThrow(TypeError);
    expect(S.set('clockFormat', '12h')).toBe(true);
    expect(() => S.set('clockFormat', '13h')).toThrow(TypeError);
    expect(S.set('username', '  Grace  ')).toBe(true);
    expect(store._cache.username).toBe('Grace'); // trimmed before persist
    expect(() => S.set('username', '   ')).toThrow(TypeError);
    expect(() => S.set('username', 'a'.repeat(65))).toThrow(TypeError);
    expect(() => S.set('username', 'bad\u0007name')).toThrow(TypeError);
    expect(S.set('timezone', 'Europe/London')).toBe(true);
    expect(() => S.set('timezone', 123)).toThrow(TypeError); // non-string
    expect(() => S.set('timezone', 'Not/AZone')).toThrow(TypeError);
    expect(() => S.set('timezone', 'x'.repeat(129))).toThrow(TypeError);
    expect(S.set('region', 'GB')).toBe(true);
    expect(() => S.set('region', 123)).toThrow(TypeError); // non-string
    expect(() => S.set('region', 'not a locale!')).toThrow(TypeError);
    expect(S.set('keyboardLayout', 'gb')).toBe(true);
    expect(() => S.set('keyboardLayout', 'dv')).toThrow(TypeError);
    expect(S.set('language', 'en')).toBe(true);
    expect(() => S.set('language', 'xx')).toThrow(TypeError);
    expect(S.set('wallpaperId', null)).toBe(true);
    expect(() => S.set('wallpaperId', 'stock-rainbow')).toThrow(TypeError);
    expect(S.set('customWallpaper', null)).toBe(true);
    expect(S.set('customWallpaper', 'data:image/png;base64,QUJD')).toBe(true);
    expect(() => S.set('customWallpaper', 'data:image/tiff;base64,QUJD')).toThrow(TypeError);
    expect(() => S.set('customWallpaper', 'x'.repeat(5_500_001))).toThrow(TypeError);
    expect(S.set('customWallpaperName', null)).toBe(true);
    expect(S.set('customWallpaperName', 'holiday')).toBe(true);
    expect(() => S.set('customWallpaperName', 'bad\u0001char')).toThrow(TypeError);
    expect(S.set('doNotDisturb', true)).toBe(true);
    expect(() => S.set('doNotDisturb', 'yes')).toThrow(TypeError);
    expect(S.set('showTaskbarClock', false)).toBe(true);
    expect(() => S.set('showTaskbarClock', 'yes')).toThrow(TypeError);
    expect(S.set('taskbarSize', 'compact')).toBe(true);
    expect(S.set('taskbarSize', 'large')).toBe(true);
    expect(() => S.set('taskbarSize', 'huge')).toThrow(TypeError);
    expect(S.set('reduceMotion', true)).toBe(true);
    expect(() => S.set('reduceMotion', 'yes')).toThrow(TypeError);
    expect(S.set('removeTransparency', true)).toBe(true);
    expect(S.set('removeTransparency', false)).toBe(true);
    expect(() => S.set('removeTransparency', 1)).toThrow(TypeError);
    expect(S.set('highContrast', true)).toBe(true);
    expect(S.set('highContrast', false)).toBe(true);
    expect(() => S.set('highContrast', 'nope')).toThrow(TypeError);
    expect(S.set('cursorSize', 'xlarge')).toBe(true);
    expect(S.set('cursorSize', 'normal')).toBe(true);
    expect(() => S.set('cursorSize', 'giant')).toThrow(TypeError);
    expect(S.set('volume', 0)).toBe(true);
    expect(S.set('volume', 100)).toBe(true);
    expect(() => S.set('volume', 101)).toThrow(TypeError);
    expect(() => S.set('volume', Number.NaN)).toThrow(TypeError);
    expect(() => S.set('unknownKey', 1)).toThrow(TypeError);
  });

  it('settings.set returns false when the store refuses a write', async () => {
    const { api } = await mount({ settings: settingsStore({ setFalseFor: ['theme'] }) });
    expect(api.settings.set('theme', 'nord')).toBe(false);
  });

  it('keyboard layout persistence writes <home>/.config/novabyte on linux, skipped elsewhere', async () => {
    // os.homedir() honours $HOME at call time, so redirect it into the
    // project tree — nothing ever touches the real HOME.
    const fakeHome = mkdtempSync(join('/home/z/my-project', 'tmp-home-'));
    const realHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const { api } = await mount({});
      expect(api.settings.set('keyboardLayout', 'de')).toBe(true);
      const written = readFileSync(join(fakeHome, '.config', 'novabyte', 'keyboard-layout'), 'utf8');
      expect(written.trim()).toBe('de');
      // non-linux host: persist is skipped (set still succeeds)
      const realPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        expect(api.settings.set('keyboardLayout', 'fr')).toBe(true);
      } finally {
        Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      }
      // the layout file still holds the last linux write
      expect(readFileSync(join(fakeHome, '.config', 'novabyte', 'keyboard-layout'), 'utf8').trim()).toBe('de');
    } finally {
      if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('security.setLockPin validates shape and syncs OS.lockPin', async () => {
    const { api, OS, store } = await mount({});
    expect(api.security.setLockPin(null)).toBe(true);
    expect(OS.lockPin).toBe(null);
    expect(api.security.setLockPin('1234')).toBe(true);
    expect(OS.lockPin).toBe('1234');
    expect(store.set).toHaveBeenCalledWith('lockPin', '1234');
    expect(() => api.security.setLockPin('')).toThrow(TypeError);
    expect(() => api.security.setLockPin('x'.repeat(1025))).toThrow(TypeError);
  });

  it('developer.setMode: boolean check, admin gate, debug overlay wiring', async () => {
    const mkOverlay = () => ({ enable: vi.fn(), disable: vi.fn() });
    const nonAdmin = { enabled: () => true, isActiveAdmin: () => false };
    const admin = { enabled: () => true, isActiveAdmin: () => true };

    const lockedOverlay = mkOverlay();
    const locked = await mount({ userScope: nonAdmin, debugOverlay: lockedOverlay });
    expect(() => locked.api.developer.setMode(true)).toThrow('administrator accounts');
    expect(locked.api.developer.setMode(false)).toBe(true); // turning OFF stays open
    expect(() => locked.api.developer.setMode('yes')).toThrow(TypeError);
    expect(lockedOverlay.enable).not.toHaveBeenCalled();

    const adminOverlay = mkOverlay();
    const asAdmin = await mount({ userScope: admin, debugOverlay: adminOverlay });
    expect(asAdmin.api.developer.setMode(true)).toBe(true);
    expect(adminOverlay.enable).toHaveBeenCalledTimes(1);
    expect(asAdmin.api.developer.setMode(false)).toBe(true);
    expect(adminOverlay.disable).toHaveBeenCalledTimes(1);

    // scope disabled (single-user legacy machine) → ungated
    const legacyOverlay = mkOverlay();
    const legacy = await mount({ userScope: { enabled: () => false, isActiveAdmin: () => false }, debugOverlay: legacyOverlay });
    expect(legacy.api.developer.setMode(true)).toBe(true);
    expect(legacyOverlay.enable).toHaveBeenCalledTimes(1);
    // without a DebugOverlay: optional wiring skipped, no throw
    const bare = await mount({});
    expect(bare.api.developer.setMode(true)).toBe(true);
  });

  it('developer.setRootAccess: order and admin gates', async () => {
    const nonAdmin = { enabled: () => true, isActiveAdmin: () => false };
    const admin = { enabled: () => true, isActiveAdmin: () => true };
    const devOff = settingsStore();
    devOff.get.mockImplementation(() => false); // devMode false
    const devOn = settingsStore();
    devOn.get.mockImplementation((k) => k === 'devMode' ? true : undefined);

    const locked = await mount({ userScope: nonAdmin, settings: devOff });
    expect(() => locked.api.developer.setRootAccess(true)).toThrow('administrator accounts');
    expect(() => locked.api.developer.setRootAccess('yes')).toThrow(TypeError);

    const noDev = await mount({ userScope: admin, settings: devOff });
    expect(() => noDev.api.developer.setRootAccess(true)).toThrow('Developer Mode must be enabled');

    const ok = await mount({ userScope: admin, settings: devOn });
    expect(ok.api.developer.setRootAccess(true)).toBe(true);
    expect(ok.api.developer.setRootAccess(false)).toBe(true); // revoking stays open
  });

  it('settings.exportSnapshot strips protected keys', async () => {
    const { api } = await mount({});
    const snap = api.settings.exportSnapshot();
    expect(snap.theme).toBe('nord');
    for (const k of ['devMode', 'rootAccessEnabled', 'lockPin', 'pinSalt', 'osVersion']) {
      expect(snap).not.toHaveProperty(k);
    }
    // a store without _cache exports an empty object
    const bare = await mount({ settings: { get: vi.fn(), set: vi.fn(), defaults: {} } });
    expect(bare.api.settings.exportSnapshot()).toEqual({});
  });

  it('settings.import: accepts valid keys, skips protected/unknown/invalid/oversized', async () => {
    const { api, store } = await mount({});
    const res = await api.settings.import({
      theme: 'gruvbox',                 // accepted
      volume: 88,                       // accepted
      someUnvalidatedKey: 'hello',      // accepted (no validator)
      devMode: true,                    // protected → skipped
      lockPin: '9999',                  // protected → skipped
      notARealKey: 1,                   // unknown → skipped
      'bad key!': 1,                    // fails the key regex → skipped
      theme2: 'x',                      // unknown (regex ok) → skipped
      language: 'klingon',              // validator fails → skipped
      someUnvalidatedKey3: 'x'.repeat(5_500_001), // >5.5MB serialized → skipped
    });
    expect(res.imported.sort()).toEqual(['someUnvalidatedKey', 'theme', 'volume']);
    expect(res.skipped.sort()).toEqual(['bad key!', 'devMode', 'language', 'lockPin', 'notARealKey', 'someUnvalidatedKey3', 'theme2']);
    expect(store._cache.theme).toBe('gruvbox');
    expect(store._cache.volume).toBe(88);
    // bulk change event fanned out
    expect(store).toBeTruthy();
    // non-object inputs throw
    await expect(api.settings.import(null)).rejects.toThrow(TypeError);
    await expect(api.settings.import([1])).rejects.toThrow(TypeError);
    // a store.set returning false during import moves the key to skipped
    const picky = await mount({ settings: settingsStore({ setFalseFor: ['theme'] }) });
    const r2 = await picky.api.settings.import({ theme: 'nord', volume: 10 });
    expect(r2.imported).toEqual(['volume']);
    expect(r2.skipped).toEqual(['theme']);
  });

  it('settings.import skips values that cannot be serialized or are undefined', async () => {
    const { api } = await mount({});
    const circular = {};
    circular.self = circular;
    const res = await api.settings.import({
      someUnvalidatedKey: circular,      // JSON.stringify throws → skipped
      someUnvalidatedKey2: undefined,    // serialized === undefined → skipped
    });
    expect(res.imported).toEqual([]);
    expect(res.skipped.sort()).toEqual(['someUnvalidatedKey', 'someUnvalidatedKey2']);
  });

  it('settings.import: known keys whose value serializes to undefined or is oversized are skipped', async () => {
    const { api } = await mount({});
    // someUnvalidatedKey is a known key WITHOUT a validator, so the value
    // reaches the serialization gate itself
    const res = await api.settings.import({
      someUnvalidatedKey: () => 'never serialized',   // JSON.stringify(fn) → undefined
    });
    expect(res.skipped).toEqual(['someUnvalidatedKey']);
    expect(res.imported).toEqual([]);

    // oversized payload for the same known key → serialized.length gate
    const big = await api.settings.import({
      someUnvalidatedKey: 'x'.repeat(5_500_001),
    });
    expect(big.skipped).toEqual(['someUnvalidatedKey']);
    expect(big.imported).toEqual([]);
  });

  it('hardware.getInventory reports supported on linux and a reason elsewhere', async () => {
    const { api } = await mount({});
    const inv = api.hardware.getInventory();
    expect(inv.supported).toBe(true);
    expect(inv.platform).toBe('linux');
    expect(Array.isArray(inv.graphics)).toBe(true);
    expect(inv).toHaveProperty('cpu');
    expect(inv).toHaveProperty('memory');
    // non-linux: unsupported with a reason (guarded early return)
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const inv2 = api.hardware.getInventory();
      expect(inv2.supported).toBe(false);
      expect(inv2.reason).toBeTruthy();
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }
  });

  it('hardware.network proxies to the connectivity backend or throws', async () => {
    // backend absent → every method throws the unavailable error
    const bare = await mount({});
    expect(() => bare.api.hardware.network.getStatus()).toThrow('backend is unavailable');
    // backend present but method missing
    const partial = await mount({ connectivity: { getStatus: vi.fn(() => 'online') } });
    expect(partial.api.hardware.network.getStatus()).toBe('online');
    expect(() => partial.api.hardware.network.connectWifi('ssid', 'pw')).toThrow('does not support connectWifi');
    // full backend proxies arguments through
    const full = {
      getStatus: vi.fn(() => 'online'),
      getWifiNetworks: vi.fn(async () => []),
      setNetworkingEnabled: vi.fn(async () => true),
      setWifiEnabled: vi.fn(async () => true),
      connectWifi: vi.fn(async (ssid, pw) => ({ ok: ssid === 'home' })),
      disconnectWifi: vi.fn(async () => true),
      setBluetoothEnabled: vi.fn(async () => true),
      scanBluetooth: vi.fn(async () => []),
      pairBluetooth: vi.fn(async () => true),
      connectBluetooth: vi.fn(async () => true),
      disconnectBluetooth: vi.fn(async () => true),
      forgetBluetooth: vi.fn(async () => true),
    };
    const proxied = await mount({ connectivity: full });
    await expect(proxied.api.hardware.network.connectWifi('home', 'secret')).resolves.toMatchObject({ ok: true });
    expect(full.connectWifi).toHaveBeenCalledWith('home', 'secret');
    await expect(proxied.api.hardware.network.disconnectWifi()).resolves.toBe(true);
  });

  it('hardware.power: validates platform, resolves or rejects via the guest helper', async () => {
    // patch the CJS child_process module object (ESM namespaces are read-only)
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const cp = req('child_process');
    const realExecFile = cp.execFile;
    const calls = [];
    let impl = (bin, args, opts, cb) => cb(null, '', '');
    cp.execFile = (bin, args, opts, cb) => { calls.push([bin, args, opts]); impl(bin, args, opts, cb); };
    try {
      const { api } = await mount({});
      const power = api.hardware.power;

      // success path
      await expect(power.restart()).resolves.toBe(true);
      await expect(power.powerOff()).resolves.toBe(true);
      expect(calls).toEqual([
        ['/usr/bin/nbosp-power', ['restart'], { timeout: 15000 }],
        ['/usr/bin/nbosp-power', ['poweroff'], { timeout: 15000 }],
      ]);

      // failure with stderr detail
      impl = (bin, args, opts, cb) => cb(new Error('exit 1'), '', 'helper exploded');
      await expect(power.restart()).rejects.toThrow('helper exploded');

      // failure with no detail anywhere → the generic message
      impl = (bin, args, opts, cb) => cb({ message: '' }, '', '');
      await expect(power.powerOff()).rejects.toThrow('System poweroff failed');

      // non-linux host refuses before spawning
      const realPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        await expect(power.restart()).rejects.toThrow('available only in the NBOSP Linux guest');
      } finally {
        Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      }
    } finally {
      cp.execFile = realExecFile;
    }
  });

  it('language validation works from the engine list and the stripped-down fallback', async () => {
    // i18n:false — no window.NovaI18n at load: the inline fallback list applies
    const Module = { skip: true };
    const ctx = await coverLoadServiceApp('novabyte-system', {
      stubs: { extra: { OS: { settings: settingsStore(), events: { emit: vi.fn() }, username: 'o', lockPin: null } } },
      withBaseUtils: false,
      i18n: false,
    });
    const fallback = ctx.window.NovaByteSystem;
    expect(fallback.settings.set('language', 'en')).toBe(true); // in the fallback list
    expect(() => fallback.settings.set('language', 'klingon')).toThrow(TypeError);
  });

  it('hardware inventory drives every fs probe branch deterministically', async () => {
    // patch the CJS fs module object (the service captured it at require time)
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const fsMod = req('fs');
    const real = { readFileSync: fsMod.readFileSync, readdirSync: fsMod.readdirSync, realpathSync: fsMod.realpathSync, existsSync: fsMod.existsSync };
    const files = {
      '/sys/class/dmi/id/sys_vendor': 'VMware, Inc.',
      '/sys/class/drm/card0/device/vendor': '0x15AD',
      '/sys/class/drm/card0/device/device': '0x0710',
      '/sys/class/drm/card0/device/driver': '/real/driver/vmwgfx',
      '/sys/class/net/eth0/operstate': 'up',
      '/sys/class/net/eth0/device/driver': '/real/driver/e1000',
      '/proc/asound/cards': ' 0 [HDMI      ]: HDA-Intel - HDMI 0\n 1 [Analogue ]: HDA-Intel - Analogue',
      '/run/vmtoolsd.pid': '4242',
      '/proc/4242/comm': 'vmtoolsd',
      '/sys/class/net/wlan0/operstate': 'down', // wlan0 exists as a wireless adapter
      '/sys/class/net/wlan0/device/driver': '/real/driver/ath9k',
      // deliberate ENOTDIR: a file used as a path component
      '/sys/class/drm/card1/device/vendor': null,
    };
    const dirThrows = {
      '/sys/class/drm/notacard/device': { code: 'ENOTDIR' }, // listDir? no — realpath
    };
    fsMod.readFileSync = (path, opts) => {
      if (path in files) {
        const v = files[path];
        if (v === null) { const e = new Error('not a directory'); e.code = 'ENOTDIR'; throw e; }
        if (v === 'ENOENT') { const e = new Error('no such file'); e.code = 'ENOENT'; throw e; }
        if (v === 'EACCES') { const e = new Error('denied'); e.code = 'EACCES'; throw e; }
        return v;
      }
      if (path === '/sys/class/drm/card2/device/vendor') { const e = new Error('no such file'); e.code = 'ENOENT'; throw e; }
      return real.readFileSync(path, opts);
    };
    fsMod.readdirSync = (dir) => {
      if (dir === '/sys/class/drm') return ['card0', 'card1', 'card2', 'notacard', 'controlD1'];
      if (dir === '/sys/class/net') return ['lo', 'eth0', 'wlan0'];
      if (dir === '/gone/dir') { const e = new Error('no such dir'); e.code = 'ENOENT'; throw e; }
      if (dir === '/busy/dir') { const e = new Error('denied'); e.code = 'EACCES'; throw e; }
      return real.readdirSync(dir);
    };
    fsMod.realpathSync = (p) => {
      if (p === '/sys/class/net/eth0/device/driver') return '/real/driver/e1000';
      if (p === '/sys/class/net/wlan0/device/driver') return '/real/driver/ath9k';
      if (p === '/sys/class/drm/card0/device/driver') return '/real/driver/vmwgfx';
      if (p === '/sys/class/drm/card1/device/driver') { const e = new Error('no such file'); e.code = 'ENOENT'; throw e; }
      if (p === '/sys/class/drm/card2/device/driver') { const e = new Error('not a directory'); e.code = 'ENOTDIR'; throw e; }
      if (p === '/sys/class/drm/notacard/device/driver') { const e = new Error('denied'); e.code = 'EACCES'; throw e; }
      return real.realpathSync(p);
    };
    fsMod.existsSync = (p) => {
      if (p === '/usr/bin/vmtoolsd' || p === '/usr/bin/vmware-checkvm') return true;
      if (p === '/sys/class/net/wlan0/wireless') return true; // eth0 falls through
      if (p === '/sys/class/net/eth0/wireless') return false;
      return real.existsSync(p);
    };
    try {
      const { api } = await mount({});
      const inv = api.hardware.getInventory();
      expect(inv.supported).toBe(true);
      // graphics: card0 (vendor 0x15AD → VMware, driver vmwgfx), card1 (ENOTDIR vendor
      // → null), card2 (ENOENT vendor → null, ENOTDIR driver → null)
      const g = inv.graphics;
      expect(g).toHaveLength(3); // 'controlD1' and 'notacard' filtered out
      expect(g.find((x) => x.id === 'card0')).toMatchObject({ vendor: 'VMware', driver: 'vmwgfx', vendorId: '0x15AD', deviceId: '0x0710' });
      expect(g.find((x) => x.id === 'card1')).toMatchObject({ vendorId: null, driver: null });
      expect(g.find((x) => x.id === 'card2')).toMatchObject({ vendorId: null, driver: null });
      // network: eth0 ethernet + wlan0 wifi
      const n = inv.network;
      expect(n.find((x) => x.name === 'eth0')).toMatchObject({ type: 'ethernet-or-other', state: 'up', driver: 'e1000' });
      expect(n.find((x) => x.name === 'wlan0')).toMatchObject({ type: 'wifi', state: 'down', driver: 'ath9k' });
      expect(n.find((x) => x.name === 'lo')).toBeUndefined(); // loopback filtered
      // audio: two cards parsed from /proc/asound/cards
      expect(inv.audio.map((a) => a.id).sort()).toEqual([0, 1]);
      expect(inv.audio.find((a) => a.id === 1).name).toBe('HDA-Intel - Analogue');
      // vmware detection via the vendor string; tools installed + running
      expect(inv.virtualization).toMatchObject({ detected: true, vendor: 'VMware' });
      expect(inv.vmwareTools).toMatchObject({ installed: true, running: true });

      // audio with no /proc/asound/cards → []
      files['/proc/asound/cards'] = 'ENOENT';
      const inv2 = api.hardware.getInventory();
      expect(inv2.audio).toEqual([]);

      // vmware detected via graphics vendor even when the DMI vendor is absent
      files['/sys/class/dmi/id/sys_vendor'] = 'ENOENT';
      const inv3 = api.hardware.getInventory();
      expect(inv3.virtualization.detected).toBe(true); // card0 is a VMware device
      // and with neither signal: not detected
      files['/sys/class/drm/card0/device/vendor'] = '0x10de';
      const inv4 = api.hardware.getInventory();
      expect(inv4.virtualization.detected).toBe(false);
      expect(inv4.vmwareTools).toMatchObject({ installed: false, running: false, displayResize: false });
      // non-numeric pid → processName null → not running (via the isVmware path)
      files['/run/vmtoolsd.pid'] = 'not-a-pid';
      files['/sys/class/drm/card0/device/vendor'] = '0x15AD';
      const inv5 = api.hardware.getInventory();
      expect(inv5.vmwareTools.running).toBe(false);
      // pid file missing entirely → pid null
      files['/run/vmtoolsd.pid'] = 'ENOENT';
      const inv6 = api.hardware.getInventory();
      expect(inv6.vmwareTools.running).toBe(false);
      // tools not installed
      fsMod.existsSync = (p) => (p === '/usr/bin/vmtoolsd' ? false : real.existsSync(p));
      const inv7 = api.hardware.getInventory();
      expect(inv7.vmwareTools.installed).toBe(false);

      // listDirectory: ENOENT → empty graphics list; EACCES → propagates
      fsMod.readdirSync = (dir) => {
        if (dir === '/sys/class/drm') { const e = new Error('no such dir'); e.code = 'ENOENT'; throw e; }
        return real.readdirSync(dir);
      };
      const inv8 = api.hardware.getInventory();
      expect(inv8.graphics).toEqual([]);
      fsMod.readdirSync = (dir) => {
        if (dir === '/sys/class/drm') { const e = new Error('denied'); e.code = 'EACCES'; throw e; }
        return real.readdirSync(dir);
      };
      expect(() => api.hardware.getInventory()).toThrow('denied');
      // readOptionalFile EACCES → propagates out of the inventory probe
      files['/sys/class/dmi/id/sys_vendor'] = 'EACCES';
      fsMod.readdirSync = (dir) => real.readdirSync(dir);
      expect(() => api.hardware.getInventory()).toThrow('denied');
      files['/sys/class/dmi/id/sys_vendor'] = 'VMware, Inc.';
    } finally {
      fsMod.readFileSync = real.readFileSync;
      fsMod.readdirSync = real.readdirSync;
      fsMod.realpathSync = real.realpathSync;
      fsMod.existsSync = real.existsSync;
    }
  });

  it('network driver probing rethrows unexpected realpath errors', async () => {
    const { api } = await mount({});
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const fsMod = req('fs');
    const realRealpath = fsMod.realpathSync;
    try {
      // only the NET driver probe blows up — every other realpath is real
      fsMod.realpathSync = (p, ...rest) => {
        if (String(p).startsWith('/sys/class/net/')) {
          const e = new Error('denied');
          e.code = 'EACCES';
          throw e;
        }
        return realRealpath.call(fsMod, p, ...rest);
      };
      expect(() => api.hardware.getInventory()).toThrow('denied');
    } finally {
      fsMod.realpathSync = realRealpath;
    }
  });

  it('reports a null cpu model and zero cores when os.cpus() is empty', async () => {
    const { api } = await mount({});
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const osMod = req('os');
    const spy = vi.spyOn(osMod, 'cpus').mockReturnValue([]);
    try {
      const inv = api.hardware.getInventory();
      expect(inv.cpu).toEqual({ model: null, logicalCores: 0 });
    } finally {
      spy.mockRestore();
    }
  });
});
