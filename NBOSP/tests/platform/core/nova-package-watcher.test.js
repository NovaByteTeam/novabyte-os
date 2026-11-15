// tests/platform/core/nova-package-watcher.test.js — runtime hot-reload of
// physically replaced system .novaapp bundles (verify → close → reinstall →
// evict → background relaunch).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../../setup.js';

globalThis.window = globalThis;

const mockOS = {
  apps: {},
  windows: new Map(),
  events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
};
globalThis.OS = mockOS;
globalThis.Notify = { show: vi.fn(), unpin: vi.fn() };
globalThis.EventLog = { log: vi.fn() };
globalThis.AppRegistry = { getApp: () => null };

const closeCalls = [];
const createdWindows = [];
const minimizedWindows = [];
globalThis.WM = {
  closeWindow: (id, opts) => { closeCalls.push([id, opts]); return true; },
  createWindow: (appId) => { createdWindows.push(appId); return { id: `win-${createdWindows.length}` }; },
  minimizeWindow: (id) => { minimizedWindows.push(id); },
  updateTaskbar: vi.fn(),
};
const terminatedSandboxes = [];
globalThis.AppSandbox = {
  getAllSandboxes: () => [{ sandboxId: 'sb-1', appId: 'com.test.app', backgrounded: true }],
  terminateBackground: (sid) => { terminatedSandboxes.push(sid); },
};
const evictedFiles = [];
globalThis.AppLoaderOptimizer = {
  evict: vi.fn(async (file) => { evictedFiles.push(file); return true; }),
  clear: vi.fn(),
};

const APP_DIR = '/nbosp/js/apps';
const BUNDLE = { id: 'com.test.app', file: 'js/apps/com.test.app.novaapp' };

const fakePath = {
  join: (...parts) => parts.filter(Boolean).join('/'),
  dirname: (p) => p.split('/').slice(0, -1).join('/'),
};

function makePackage({ version = '3.1.0' } = {}) {
  return {
    novabyte_app: true,
    compiled_at: '2026-11-16T00:00:00Z',
    manifest: { id: BUNDLE.id, name: 'Test App', version, system: true },
    files: { 'app.js': 'bmV3IGNvZGU=' },
    signature: `sig-${version}`,
    integrity: { payloadHash: `hash-${version}` },
  };
}

function makeDeps({ watchers, pkg = makePackage(), verify = async () => true } = {}) {
  const fs = watchers
    ? {
        existsSync: () => true,
        watch: (dir, opts, cb) => { watchers.push({ dir, cb }); return { close: () => {} }; },
      }
    : {};
  const installCalls = [];
  let savedRegistry = null;
  const store = {
    loadRegistry: () => [{ id: BUNDLE.id, version: '3.0.0', signature: 'sig-old' }],
    saveRegistry: (r) => { savedRegistry = r; },
    toMetadata: (app) => ({ id: app.id, version: app.version, signature: app.signature, source: app.source, system: true }),
  };
  const AppPackage = {
    verifyIntegrity: async () => verify('integrity'),
    verifyAgainstTrustStore: async () => verify('trust'),
    installPackage: async (p, opts) => { installCalls.push([p, opts]); return { ok: true }; },
  };
  const fetchImpl = vi.fn(async (url) => {
    if (url === BUNDLE.file) return { ok: true, json: async () => pkg };
    return { ok: false };
  });
  return {
    deps: {
      fs, path: fakePath, appDir: APP_DIR,
      bundles: [BUNDLE, { id: 'com.test.service', file: 'js/apps/com.test.service.novaapp', systemService: true }],
      fetchImpl, AppPackage, PackageStore: store,
    },
    installCalls,
    readSavedRegistry: () => savedRegistry,
  };
}

// The watcher is a singleton script (dual window/module export) — require
// once per file and read the export; vi.resetModules does not clear the
// CJS require cache, so re-requiring returns the same live object.
const watcher = require('../../../js/platform/core/nova-package-watcher.js');

describe('NovaPackageWatcher (js/platform/core/nova-package-watcher.js)', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.useFakeTimers();
    closeCalls.length = 0;
    createdWindows.length = 0;
    minimizedWindows.length = 0;
    terminatedSandboxes.length = 0;
    evictedFiles.length = 0;
    mockOS.windows.clear();
    globalThis.Notify.show.mockClear?.();
    watcher.stop();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('hot-reloads a replaced system package: verify → close → reinstall → evict → background relaunch', async () => {
    const watchers = [];
    const pkg = makePackage();
    const ctx = makeDeps({ watchers, pkg });
    // the app is currently running (window + backgrounded sandbox)
    mockOS.windows.set('win-1', { appId: BUNDLE.id });

    const handle = await watcher.start(ctx.deps);
    expect(handle).toBeTruthy();
    expect(handle.appDir).toBe(APP_DIR);
    expect(watchers).toHaveLength(1);

    // the physical .novaapp file is replaced on disk
    watchers[0].cb('rename', 'com.test.app.novaapp');
    watchers[0].cb('change', 'com.test.app.novaapp'); // debounced into one reload
    await vi.advanceTimersByTimeAsync(800);

    // re-read with cache bypass
    expect(ctx.deps.fetchImpl).toHaveBeenCalledWith(BUNDLE.file, { cache: 'no-store' });
    // verified BEFORE anything is torn down, then force-reinstalled
    expect(ctx.installCalls).toHaveLength(1);
    expect(ctx.installCalls[0][0]).toBe(pkg);
    expect(ctx.installCalls[0][1]).toMatchObject({ force: true, source: 'system-bundle' });
    // the running window was closed with forceKill, the backgrounded sandbox terminated
    expect(closeCalls).toEqual([['win-1', { forceKill: true }]]);
    expect(terminatedSandboxes).toEqual(['sb-1']);
    // registry metadata refreshed with the new version
    expect(ctx.readSavedRegistry().find(a => a.id === BUNDLE.id))
      .toMatchObject({ version: '3.1.0', signature: 'sig-3.1.0', source: 'system-bundle' });
    // the optimizer's stale copy is evicted so the next boot reconcile reads fresh bytes
    expect(evictedFiles).toEqual([BUNDLE.file]);
    // relaunched in the background (minimized)
    expect(createdWindows).toEqual([BUNDLE.id]);
    expect(minimizedWindows).toHaveLength(1);

    handle.stop();
  });

  it('fails closed on a tampered replacement: no close, no reinstall, old code stays live', async () => {
    const watchers = [];
    const pkg = makePackage();
    const ctx = makeDeps({
      watchers, pkg,
      verify: async (kind) => kind === 'trust', // integrity fails, trust passes → not both
    });
    mockOS.windows.set('win-9', { appId: BUNDLE.id });

    const handle = await watcher.start(ctx.deps);
    watchers[0].cb('rename', 'com.test.app.novaapp');
    await vi.advanceTimersByTimeAsync(800);

    expect(ctx.installCalls).toHaveLength(0);
    expect(closeCalls).toEqual([]);           // the running app was NOT torn down
    expect(terminatedSandboxes).toEqual([]);
    expect(createdWindows).toEqual([]);
    // the user learns why nothing happened
    expect(globalThis.Notify.show).toHaveBeenCalled();
    handle.stop();
  });

  it('ignores system-service bundles, non-.novaapp files, and unknown ids', async () => {
    const watchers = [];
    const ctx = makeDeps({ watchers });
    const handle = await watcher.start(ctx.deps);

    watchers[0].cb('rename', 'com.test.service.novaapp'); // systemService bundle
    watchers[0].cb('change', 'novaapp-manifest.json');    // registry write
    watchers[0].cb('rename', 'unknown.novaapp');           // not in the manifest
    await vi.advanceTimersByTimeAsync(900);

    expect(ctx.installCalls).toHaveLength(0);
    expect(ctx.deps.fetchImpl).not.toHaveBeenCalled();
    handle.stop();
  });

  it('start() is a no-op on hosts without native fs.watch', async () => {
    const handle = await watcher.start({ fs: {}, path: fakePath, bundles: [BUNDLE] });
    expect(handle).toBeNull();
  });

  it('debounces repeated watch events into a single reload', async () => {
    const watchers = [];
    const ctx = makeDeps({ watchers });
    const handle = await watcher.start(ctx.deps);

    watchers[0].cb('rename', 'com.test.app.novaapp');
    await vi.advanceTimersByTimeAsync(200);
    watchers[0].cb('change', 'com.test.app.novaapp');
    await vi.advanceTimersByTimeAsync(200);
    watchers[0].cb('rename', 'com.test.app.novaapp');
    await vi.advanceTimersByTimeAsync(700); // last debounce window elapses

    expect(ctx.installCalls).toHaveLength(1);
    handle.stop();
  });
});
