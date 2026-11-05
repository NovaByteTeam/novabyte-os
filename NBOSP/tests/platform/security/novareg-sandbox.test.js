import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AppSandbox from '../../../js/platform/security/app-sandbox.js';
import NovaRegistry from '../../../js/platform/core/nova-registry.js';

// Drives the nova:reg:* handlers through the REAL dispatcher
// (AppSandbox._internal.handleAPICall) with the REAL registry engine over a
// memory store, and asserts the guest-facing bridge contract + the per-hive
// security rules. Complements tests/test_ipc_matrix.js (which proves the MAC
// front-door grants) by covering the context-dependent half in the handlers.

function memStorage() {
  const map = new Map();
  return {
    loadAll() {
      const out = {};
      for (const hive of NovaRegistry.HIVES) {
        out[hive] = map.has(hive) ? JSON.parse(map.get(hive)) : null;
      }
      return out;
    },
    save(hive, data) { map.set(hive, JSON.stringify(data)); },
  };
}

function makeBus() {
  const listeners = {};
  return {
    events: [],
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    off() {},
    emit(name, data) {
      this.events.push({ name, data });
      for (const fn of (listeners[name] || []).slice()) fn(data);
    },
  };
}

const code = (r) => r?.error?.code ?? null;

describe('nova:reg:* sandbox handlers', () => {
  let grants, bus, settingsSet, devMode;

  beforeEach(() => {
    bus = makeBus();
    settingsSet = vi.fn();
    devMode = false;
    grants = new Set();
    NovaRegistry._internal.resetState();
    NovaRegistry.init({ storage: memStorage(), events: bus, logger: console });
    // setup.js aliases window to globalThis; the handlers resolve the engine
    // off window at call time.
    globalThis.window.NovaRegistry = NovaRegistry;

    vi.stubGlobal('AppPermissionManager', {
      isGranted: (permission) => grants.has(permission),
    });
    vi.stubGlobal('OS', {
      settings: {
        get: (key) => (key === 'devMode' ? devMode : undefined),
        set: settingsSet,
      },
      events: bus,
      logger: console,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function call(type, payload, app) {
    const guestWindow = {};
    const webview = {
      executeScript: ({ code: script }, callback) => {
        const delivered = new Function('window', `return ${script}`)(guestWindow);
        callback([delivered]);
      },
    };
    await AppSandbox._internal.handleAPICall(type, payload, 'req-1', app, webview, { appId: app.id });
    return guestWindow.__novaInbox?.[0] ?? null;
  }

  const plainApp = { id: 'com.probe.app', system: false };
  const systemApp = { id: 'com.nbosp.shell', system: true };

  it('denies reads without registry.read (MAC front door)', async () => {
    const r = await call('nova:reg:get', { path: 'HKNU/probe/color' }, plainApp);
    expect(code(r)).toBe('PERMISSION_DENIED');
  });

  it('reads seeded values with registry.read and reports absent ones', async () => {
    grants.add('registry.read');
    NovaRegistry.set('HKNU/probe/color', 'blue');

    const hit = await call('nova:reg:get', { path: 'HKNU/probe/color' }, plainApp);
    expect(hit.result).toMatchObject({ found: true, type: 'REG_SZ', data: 'blue' });

    const miss = await call('nova:reg:get', { path: 'HKNU/probe/nope' }, plainApp);
    expect(miss.result).toMatchObject({ found: false, path: 'HKNU/probe/nope' });
  });

  it('blocks the HKNS/security subtree without registry.system, allows it with', async () => {
    grants.add('registry.read');
    NovaRegistry.set('HKNS/security/policy/prohibitWallpaperChange', false, { type: 'REG_BOOL' });

    const denied = await call('nova:reg:get', { path: 'HKNS/security/policy/prohibitWallpaperChange' }, plainApp);
    expect(code(denied)).toBe('PERMISSION_DENIED');

    const listed = await call('nova:reg:list', { path: 'HKNS/security' }, plainApp);
    expect(code(listed)).toBe('PERMISSION_DENIED');

    grants.add('registry.system');
    const allowed = await call('nova:reg:get', { path: 'HKNS/security/policy/prohibitWallpaperChange' }, plainApp);
    expect(allowed.result).toMatchObject({ found: true, data: false });
  });

  it('denies writes without registry.write', async () => {
    grants.add('registry.read'); // having read must not grant write
    const r = await call('nova:reg:set', { path: 'HKNA/com.probe.app/volume', value: 5 }, plainApp);
    expect(code(r)).toBe('PERMISSION_DENIED');
  });

  it('lets an app write only its OWN HKNA subtree', async () => {
    grants.add('registry.write');

    const own = await call('nova:reg:set', { path: 'HKNA/com.probe.app/volume', value: 80, type: 'REG_DWORD' }, plainApp);
    expect(own.result).toMatchObject({ success: true, type: 'REG_DWORD' });
    expect(NovaRegistry.get('HKNA/com.probe.app/volume')).toBe(80);

    const foreign = await call('nova:reg:set', { path: 'HKNA/com.other.app/volume', value: 1 }, plainApp);
    expect(code(foreign)).toBe('PERMISSION_DENIED');

    const root = await call('nova:reg:set', { path: 'HKNA/rooted-by-probe', value: 1 }, plainApp);
    expect(code(root)).toBe('PERMISSION_DENIED');
  });

  it('blocks HKNS writes for non-system apps, allows system apps and live-applies mapped keys', async () => {
    grants.add('registry.write');

    const denied = await call('nova:reg:set', { path: 'HKNS/shell/theme', value: 'dracula' }, plainApp);
    expect(code(denied)).toBe('PERMISSION_DENIED');
    expect(settingsSet).not.toHaveBeenCalled();

    const allowed = await call('nova:reg:set', { path: 'HKNS/shell/theme', value: 'dracula' }, systemApp);
    expect(allowed.result.success).toBe(true);
    // The registry→settings mirror applies the change through OS.settings so
    // the existing settings:changed fan-out repaints the shell live.
    expect(settingsSet).toHaveBeenCalledWith('theme', 'dracula');
    expect(NovaRegistry.get('HKNS/shell/theme')).toBe('dracula');
  });

  it('requires Developer Mode for the HKND dev hive', async () => {
    grants.add('registry.write');
    const payload = { path: 'HKND/scratch/note', value: 'x' };

    devMode = false;
    const denied = await call('nova:reg:set', payload, plainApp);
    expect(code(denied)).toBe('PERMISSION_DENIED');
    expect(denied.error.message).toMatch(/Developer Mode/i);

    devMode = true;
    const allowed = await call('nova:reg:set', payload, plainApp);
    expect(allowed.result.success).toBe(true);
  });

  it('rejects malformed paths with INVALID_ARGS before permission work', async () => {
    grants.add('registry.read');
    for (const path of ['BOGUS/x', 'HKNS/a/']) {
      const r = await call('nova:reg:get', { path }, plainApp);
      expect(code(r), path).toBe('INVALID_ARGS');
    }
  });

  it('surfaces engine error codes over the bridge (SUBTREE_NOT_EMPTY on delete)', async () => {
    grants.add('registry.write');
    NovaRegistry.set('HKNA/com.probe.app/key/a', '1');
    NovaRegistry.set('HKNA/com.probe.app/key/b', '2');

    const blocked = await call('nova:reg:delete', { path: 'HKNA/com.probe.app/key' }, plainApp);
    expect(code(blocked)).toBe('SUBTREE_NOT_EMPTY');

    const ok = await call('nova:reg:delete', { path: 'HKNA/com.probe.app/key', recursive: true }, plainApp);
    expect(ok.result).toMatchObject({ success: true, removed: 'key' });
  });

  it('exports and imports through the bridge', async () => {
    grants.add('registry.read');
    grants.add('registry.write');
    NovaRegistry.set('HKNA/com.probe.app/a/one', '1');

    const dump = await call('nova:reg:export', { path: 'HKNA/com.probe.app' }, plainApp);
    expect(dump.result.path).toBe('HKNA/com.probe.app');
    // 'one' is a value under the subtree's 'a' KEY.
    expect(dump.result.data.keys.a.values.one.data).toBe('1');

    NovaRegistry._internal.resetState();
    NovaRegistry.init({ storage: memStorage(), events: bus, logger: console });
    globalThis.window.NovaRegistry = NovaRegistry;
    // grants survive the re-init (they live in the stub, not the engine)

    const back = await call('nova:reg:import', { path: 'HKNA/com.probe.app/restored', data: dump.result.data }, plainApp);
    expect(back.result).toMatchObject({ success: true, merged: 1 });
    expect(NovaRegistry.get('HKNA/com.probe.app/restored/a/one')).toBe('1');
  });

  it('answers UNAVAILABLE when the engine is not loaded', async () => {
    grants.add('registry.read'); // MAC front door passes; the handler then reports
    vi.stubGlobal('window', {});
    const r = await call('nova:reg:get', { path: 'HKNU/x' }, plainApp);
    expect(code(r)).toBe('UNAVAILABLE');
  });

  it('emits nova:reg:changed to the event bus on committed writes', async () => {
    grants.add('registry.write');
    await call('nova:reg:set', { path: 'HKNA/com.probe.app/seen', value: true, type: 'REG_BOOL' }, plainApp);
    const event = bus.events.find((e) => e.name === 'nova:reg:changed');
    expect(event.data).toMatchObject({
      path: 'HKNA/com.probe.app/seen',
      type: 'REG_BOOL',
      value: true,
      appId: 'com.probe.app',
    });
  });
});
