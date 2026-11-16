// tests/apps/store-updates.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/store-updates/service.js.
// The catalog is served through a controllable fetch stub; the version
// comparator matrix (prerelease semantics, numeric vs lexical identifiers,
// missing segments) is driven through real checkNow() calls, and the
// scheduler is exercised with fake timers so no real 15-60min timers fire.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { coverLoadServiceApp, settle } from '../helpers/cover-loader.js';

const INSTALLED = 'nova_installed_apps';
const SETTINGS = 'nova_store_update_interval_minutes';
const NOTIFIED = 'nova_store_update_notified';
const SETTINGS_EVENT = 'nova-store-update-settings-changed';

beforeEach(() => { resetTestStorage(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function mount({ fetchImpl, notify, registry, packageStore, boot, catalog } = {}) {
  // reset globals that a previous test's extras may have left behind
  delete globalThis.Boot;
  delete globalThis.Notify;
  delete globalThis.RegistrySystemState;
  delete globalThis.NovaAppPackageStore;
  const extra = {
    ...(notify ? { Notify: notify } : {}),
    ...(registry ? { RegistrySystemState: registry } : {}),
    ...(packageStore ? { NovaAppPackageStore: packageStore } : {}),
    ...(boot ? { Boot: boot } : {}),
  };
  const ctx = await coverLoadServiceApp('store-updates', {
    stubs: {
      extra,
      fetch: fetchImpl ?? vi.fn(async () => ({
        ok: true,
        json: async () => catalog ?? [],
      })),
    },
    withBaseUtils: true, // _t
  });
  return { ...ctx, svc: ctx.window.StoreUpdateService };
}

const app = (over = {}) => ({
  app_id: 'com.x', name: 'X', version: '2.0.0',
  release_notes: '', version_history: [],
  ...over,
});
const installed = (over = {}) => ({
  id: 'com.x', version: '1.9.9', name: 'X',
  ...over,
});

describe('StoreUpdateService (js/apps/store-updates/service.js) — e2e coverage', () => {
  it('exposes a frozen service and registers with Boot.after when present', async () => {
    const boot = { hooks: { after: [] } };
    const { window, svc } = await mount({ boot });
    expect(svc).toBeTruthy();
    expect(Object.isFrozen(svc)).toBe(true);
    expect(Object.keys(svc).sort()).toEqual(['checkNow', 'getIntervalMinutes', 'setIntervalMinutes', 'start']);
    expect(boot.hooks.after).toHaveLength(1);
  });

  it('compares the full version matrix and only flags real upgrades', async () => {
    const catalog = [
      app({ app_id: 'up-core', version: '2.0.0', release_notes: 'big one' }),
      app({ app_id: 'num-less', version: '1.2.4-rc.1' }),          // numeric prerelease a<b → −1
      app({ app_id: 'lex-less', version: '1.2.4-a' }),             // lexical prerelease a<b → −1
      app({ app_id: 'older-cat', version: '1.0.0' }),              // catalog older than installed → −1
      app({ app_id: 'num-version', version: '2.0.0' }),            // vs non-string version → null
      app({ app_id: 'hist-bad2', version: '2.2.0', version_history: 'not-an-array' }),
      app({ app_id: 'same', version: '1.2.3' }),
      app({ app_id: 'pre-lower', version: '1.2.3-rc.1' }),        // prerelease < release → no
      app({ app_id: 'pre-vs-rel', version: '1.2.4' }),            // release vs prerelease → yes
      app({ app_id: 'lex', version: '1.2.4-b' }),                 // 'b' > 'a' → yes
      app({ app_id: 'num-vs-lex', version: '1.2.4-rc' }),         // rc (non-numeric) vs 1 (numeric) → yes
      app({ app_id: 'lex-vs-num', version: '1.2.4-1' }),          // 1 (numeric) vs rc → −1 → no
      app({ app_id: 'short-pre', version: '1.2.4-rc' }),          // rc vs rc.2: missing segment → −1 → no
      app({ app_id: 'long-pre', version: '1.2.4-rc.2' }),         // rc.2 vs rc → +1 → yes
      app({ app_id: 'num-pre', version: '1.2.4-rc.3' }),          // 3 > 2 → yes
      app({ app_id: 'bad-parse', version: '2.0' }),               // unparseable → skip
      app({ app_id: 'v-prefix', version: 'v1.2.5' }),             // v= prefix parses → yes
      app({ app_id: 'build-meta', version: '1.2.3-beta+x' }),     // build ignored → equals beta → 0 vs beta → no
      app({ app_id: 'no-notes', version: '2.1.0', release_notes: '', version_history: [] }),
    ];
    const { window, svc } = await mount({ catalog });
    localStorage.setItem(INSTALLED, JSON.stringify([
      installed({ id: 'up-core', version: '1.9.9' }),
      installed({ id: 'same', version: '1.2.3' }),
      installed({ id: 'pre-lower', version: '1.2.3' }),
      installed({ id: 'pre-vs-rel', version: '1.2.4-rc.1' }),
      installed({ id: 'lex', version: '1.2.4-a' }),
      installed({ id: 'num-vs-lex', version: '1.2.4-1' }),
      installed({ id: 'lex-vs-num', version: '1.2.4-rc' }),
      installed({ id: 'short-pre', version: '1.2.4-rc.2' }),
      installed({ id: 'long-pre', version: '1.2.4-rc' }),
      installed({ id: 'num-pre', version: '1.2.4-rc.2' }),
      installed({ id: 'bad-parse', version: '1.9.9' }),
      installed({ id: 'v-prefix', version: '1.2.4' }),
      installed({ id: 'build-meta', version: '1.2.3-beta' }),
      installed({ id: 'no-notes', version: '2.0.9', system: false }),
      installed({ id: 'hist-bad2', version: '2.1.0' }),
      null,
      { version: '1.0', system: false },        // non-string id → skip
      { id: 'sys-app', version: '0.1', system: true }, // system app → skip
      { id: 'num-version', version: 42 },        // non-string version → parse null → skip
      { id: 'older-cat', version: '3.0.0' },      // catalog older (core −1) → skip
      { id: 'num-less', version: '1.2.4-rc.2' },  // numeric prerelease a<b → −1
      { id: 'lex-less', version: '1.2.4-b' },     // lexical prerelease a<b → −1
    ]));
    const updates = await svc.checkNow();
    const ids = updates.map((u) => u.id).sort();
    expect(ids).toEqual([
      'hist-bad2', 'long-pre', 'no-notes', 'num-pre', 'num-vs-lex', 'pre-vs-rel', 'up-core', 'v-prefix', 'lex',
    ].sort());
    // hist-bad2's non-array version history falls back to '' notes
    expect(updates.find((u) => u.id === 'hist-bad2').releaseNotes).toBe('');
    // release notes flow through (direct + version-history fallback)
    const upCore = updates.find((u) => u.id === 'up-core');
    expect(upCore.releaseNotes).toBe('big one');
    const noNotes = updates.find((u) => u.id === 'no-notes');
    expect(noNotes.releaseNotes).toBe('');
    expect(upCore.installedVersion).toBe('1.9.9');
    expect(upCore.version).toBe('2.0.0');
  });

  it('reads release notes from version history when the field is absent', async () => {
    const catalog = [
      app({
        app_id: 'hist', version: '2.2.0', release_notes: '',
        version_history: [
          { version: '2.2.0', notes: '  fresh notes  ' },
          { version: '2.1.0', notes: 'old' },
        ],
      }),
      app({
        app_id: 'hist-bad', version: '2.2.0', release_notes: undefined,
        version_history: [{ version: '2.2.0', notes: 42 }], // notes not a string → ''
      }),
    ];
    const { svc } = await mount({ catalog });
    localStorage.setItem(INSTALLED, JSON.stringify([
      installed({ id: 'hist', version: '2.1.0' }),
      installed({ id: 'hist-bad', version: '2.1.0' }),
    ]));
    const updates = await svc.checkNow();
    expect(updates.find((u) => u.id === 'hist').releaseNotes).toBe('fresh notes');
    expect(updates.find((u) => u.id === 'hist-bad').releaseNotes).toBe('');
  });

  it('surfaces catalog errors: bad status and non-list payloads', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { svc } = await mount({ fetchImpl: vi.fn(async () => ({ ok: false, status: 500, json: async () => [] })) });
    await expect(svc.checkNow()).rejects.toThrow('App catalog request failed (500)');
    const second = await mount({ catalog: { not: 'a list' } });
    await expect(second.svc.checkNow()).rejects.toThrow('App catalog must contain a list.');
    expect(warn).not.toHaveBeenCalled();
  });

  it('notifies once per version and remembers through the registry', async () => {
    const show = vi.fn();
    const notify = { show };
    const saved = {};
    const registry = {
      installedApps: () => [installed({ id: 'com.x', version: '1.0.0' })],
      storeNotified: vi.fn(() => (saved.value ?? null)),
      setStoreNotified: vi.fn((v) => { saved.value = v; }),
      storeUpdateInterval: () => 60,
      setStoreUpdateInterval: vi.fn(),
    };
    const catalog = [app({ app_id: 'com.x', version: '2.0.0', release_notes: 'notes!' })];
    const { svc } = await mount({ notify, registry, catalog });
    const first = await svc.checkNow();
    expect(first).toHaveLength(1);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0].body).toContain('notes!'); // whats-new suffix
    expect(show.mock.calls[0][0].appId).toBe('com.nbosp.store');
    // same version again: update listed, no second toast
    const second = await svc.checkNow();
    expect(second).toHaveLength(1);
    expect(show).toHaveBeenCalledTimes(1);
    // a NEW version notifies again
    catalog[0].version = '2.1.0';
    const third = await svc.checkNow();
    expect(third[0].version).toBe('2.1.0');
    expect(show).toHaveBeenCalledTimes(2);
    expect(saved.value['com.x']).toBe('2.1.0');
  });

  it('falls back to legacy localStorage for the notified map', async () => {
    const show = vi.fn();
    const notify = { show };
    const catalog = [app({ app_id: 'com.x', version: '2.0.0' })];
    const { svc } = await mount({ notify, catalog });
    localStorage.setItem(INSTALLED, JSON.stringify([installed({ id: 'com.x', version: '1.0.0' })]));
    localStorage.setItem(NOTIFIED, JSON.stringify({ 'com.x': '2.0.0' })); // already told
    const first = await svc.checkNow();
    expect(first).toHaveLength(1);
    expect(show).not.toHaveBeenCalled(); // dedupe: no toast
    // corrupt legacy blob → {} (warn) → notifies
    localStorage.setItem(NOTIFIED, '{corrupt');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await svc.checkNow();
    expect(show).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // array-shaped blob → not usable as a map → {}
    localStorage.setItem(NOTIFIED, JSON.stringify(['x']));
    await svc.checkNow();
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('warns and skips the toast when Notify is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const catalog = [app({ app_id: 'com.x', version: '2.0.0' })];
    const { svc } = await mount({ catalog });
    localStorage.setItem(INSTALLED, JSON.stringify([installed({ id: 'com.x', version: '1.0.0' })]));
    const updates = await svc.checkNow();
    expect(updates).toHaveLength(1); // still reported in the list
    expect(warn).toHaveBeenCalledWith('[StoreUpdateService] Notifications are unavailable; update notification will be retried.');
    // not marked → a later check with Notify present notifies
    expect(localStorage.getItem(NOTIFIED)).toBe(null);
  });

  it('reads installed apps through the package store when the system state throws', async () => {
    const catalog = [app({ app_id: 'com.x', version: '2.0.0' })];
    const registry = {
      installedApps: () => { throw new Error('down'); },
    };
    const packageStore = {
      loadRegistry: () => [installed({ id: 'com.x', version: '1.0.0' })],
    };
    const { svc } = await mount({ catalog, registry, packageStore });
    const updates = await svc.checkNow();
    expect(updates).toHaveLength(1);

    // package store also throws → localStorage
    const second = await mount({
      catalog,
      registry: { installedApps: () => { throw new Error('down'); } },
      packageStore: { loadRegistry: () => { throw new Error('down too'); } },
    });
    localStorage.setItem(INSTALLED, '"not an array"'); // readArray non-array → []
    expect(await second.svc.checkNow()).toEqual([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(INSTALLED, '{corrupt'); // readArray throws → warn → []
    expect(await second.svc.checkNow()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    // inventory helpers that resolve null (not throw) fall back to the empty
    // list instead of returning null — the || [] arms in readInstalledApps.
    const nullish = await mount({
      catalog,
      registry: { installedApps: () => null },
      packageStore: { loadRegistry: () => null },
    });
    localStorage.setItem(INSTALLED, '"not an array"');
    expect(await nullish.svc.checkNow()).toEqual([]);
  });

  it('interval settings: registry first, legacy fallback, validation', async () => {
    const { svc } = await mount({});
    // no registry, no legacy value → default 60
    expect(svc.getIntervalMinutes()).toBe(60);
    localStorage.setItem(SETTINGS, '30');
    expect(svc.getIntervalMinutes()).toBe(30); // allowed legacy value
    localStorage.setItem(SETTINGS, '45');
    expect(svc.getIntervalMinutes()).toBe(60); // disallowed → default
    // registry answers
    const second = await mount({ registry: { storeUpdateInterval: () => 120 } });
    expect(second.svc.getIntervalMinutes()).toBe(120);
    const third = await mount({ registry: { storeUpdateInterval: () => 45 } }); // not allowed → legacy/default
    expect(third.svc.getIntervalMinutes()).toBe(60);
    const fourth = await mount({ registry: { storeUpdateInterval: () => { throw new Error('x'); } } });
    expect(fourth.svc.getIntervalMinutes()).toBe(60); // throws → legacy

    // validation + persistence
    expect(() => svc.setIntervalMinutes(45)).toThrow(RangeError);
    svc.setIntervalMinutes(15); // no registry in this mount → localStorage + event
    expect(localStorage.getItem(SETTINGS)).toBe('15');
    // registry-backed set
    const setStoreUpdateInterval = vi.fn();
    const fifth = await mount({ registry: { setStoreUpdateInterval } });
    fifth.svc.setIntervalMinutes(720);
    expect(setStoreUpdateInterval).toHaveBeenCalledWith(720);
    expect(localStorage.getItem(SETTINGS)).toBe(null); // registry path: localStorage untouched
  });

  it('schedules checks on the configured cadence and reschedules on changes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0;
    const fetchImpl = vi.fn(async () => { calls++; return { ok: true, json: async () => [] }; });
    let interval = 15; // mutable so setIntervalMinutes(0) is observed by the scheduler
    const setStoreUpdateInterval = vi.fn((m) => { interval = m; });
    const storeUpdateInterval = vi.fn(() => interval);
    const registry = { storeUpdateInterval, setStoreUpdateInterval };
    const { svc, window } = await mount({ fetchImpl, registry });
    const boot = null;
    await svc.start(); // startup check
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(calls).toBe(2); // cadence fired
    // a storage event for the settings key reschedules; other keys do not
    const before = calls;
    window.dispatchEvent(new window.StorageEvent('storage', { key: 'unrelated' }));
    window.dispatchEvent(new window.StorageEvent('storage', { key: SETTINGS }));
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(calls).toBe(before + 1); // rescheduled timer fired
    // the settings event triggers reschedule too (clearTimeout + re-set)
    svc.setIntervalMinutes(0); // interval 0 → no future timer
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(calls).toBe(before + 1); // nothing more
  });

  it('checkNow is reentrant: concurrent calls share one in-flight promise', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const fetchImpl = vi.fn(() => gate.then(() => ({ ok: true, json: async () => [] })));
    const { svc } = await mount({ fetchImpl });
    const p1 = svc.checkNow();
    const p2 = svc.checkNow();
    // both calls collapse onto the one in-flight request
    release();
    await expect(p1).resolves.toEqual([]);
    await expect(p2).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // after settling, a fresh call starts a new request
    const p3 = svc.checkNow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    release();
    await p3;
  });

  it('a failing scheduled check logs and keeps the cadence', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 2) throw new Error('network gone');
      return { ok: true, json: async () => [] };
    });
    const registry = { storeUpdateInterval: () => 15 };
    const { svc } = await mount({ fetchImpl, registry });
    await svc.start();
    expect(errorSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(errorSpy).toHaveBeenCalledWith('[StoreUpdateService] Update check failed:', expect.objectContaining({ message: 'network gone' }));
    // the finally reschedules
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(calls).toBe(3);
  });

  it('saving the notified history degrades loudly when storage fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const show = vi.fn();
    const notify = { show };
    const catalog = [app({ app_id: 'com.x', version: '2.0.0' })];
    const { svc } = await mount({ notify, catalog });
    localStorage.setItem(INSTALLED, JSON.stringify([installed({ id: 'com.x', version: '1.0.0' })]));
    await svc.checkNow();
    expect(show).toHaveBeenCalledTimes(1);
    // make the legacy write fail on the next check (new version)
    catalog[0].version = '3.0.0';
    const real = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: real.getItem.bind(real),
      setItem: () => { throw new Error('quota full'); },
      removeItem: real.removeItem.bind(real),
      clear: real.clear.bind(real),
      key: real.key.bind(real),
      get length() { return real.length; },
    };
    await svc.checkNow();
    expect(errorSpy).toHaveBeenCalledWith(
      '[StoreUpdateService] Could not save update notification history:',
      expect.objectContaining({ message: 'quota full' }),
    );
    expect(show).toHaveBeenCalledTimes(2); // the toast still went out
    globalThis.localStorage = real;
  });

  it('startup check failures are logged, not thrown', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => { throw new Error('offline at boot'); });
    const registry = { storeUpdateInterval: () => 60 };
    const { svc } = await mount({ fetchImpl, registry });
    await svc.start();
    await settle(10); // the .catch logger runs on a microtask
    expect(errorSpy).toHaveBeenCalledWith(
      '[StoreUpdateService] Startup update check failed:',
      expect.objectContaining({ message: 'offline at boot' }),
    );
  });

  it('reads the interval even when localStorage throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { svc } = await mount({});
    const real = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: () => { throw new Error('locked'); },
      setItem: real.setItem.bind(real),
      removeItem: real.removeItem.bind(real),
      clear: real.clear.bind(real),
      key: real.key.bind(real),
      get length() { return real.length; },
    };
    expect(svc.getIntervalMinutes()).toBe(60);
    expect(warn).toHaveBeenCalledWith('[StoreUpdateService] Could not read update interval:', expect.anything());
    globalThis.localStorage = real;
  });

  it('works on a windowless host (typeof window guards take the bare side)', async () => {
    const catalog = [app({ app_id: 'com.x', version: '2.0.0' })];
    const show = vi.fn();
    const { svc, window } = await mount({ catalog, notify: { show } });
    localStorage.setItem(INSTALLED, JSON.stringify([installed({ id: 'com.x', version: '1.0.0' })]));
    // drop the window mid-flight: readInstalledApps/getNotifiedVersions/save
    // all take their `typeof window !== 'undefined'` bare paths
    const realWindow = globalThis.window;
    delete globalThis.window;
    const updates = await svc.checkNow();
    expect(updates).toHaveLength(1);
    expect(show).toHaveBeenCalledTimes(1);
    // the notified map round-tripped through bare localStorage
    expect(JSON.parse(localStorage.getItem(NOTIFIED))['com.x']).toBe('2.0.0');
    globalThis.window = realWindow;
  });

  it('start() is idempotent: a second start does not re-check', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => { calls++; return { ok: true, json: async () => [] }; });
    const registry = { storeUpdateInterval: () => 60 };
    const { svc } = await mount({ fetchImpl, registry });
    await svc.start();
    await settle(10);
    const afterFirst = calls;
    await svc.start(); // started already true → early return
    await settle(10);
    expect(calls).toBe(afterFirst);
  });
});
