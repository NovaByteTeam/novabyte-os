// tests/apps/app-loader-optimiser.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/app-loader-optimiser/service.js.
// The real service runs against a live JSDOM window. The IndexedDB boundary
// uses the in-memory fake-idb helper for the happy paths, and a scripted
// open/get/put/delete stub for the error arms (open rejection with the
// promise-reset, read rejection falling back to fetch, persist failure
// logging, evict delete failure). No-IDB runs cover the null-database arms.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { coverLoadServiceApp, requireFresh } from '../helpers/cover-loader.js';
import { install as installFakeIdb } from '../helpers/fake-idb.js';
import { settle } from '../helpers/app-harness.js';

const SELF_ID = 'com.nbosp.service.app-loader-optimiser';

function fetchRouter(routes) {
  return async (url) => {
    const hit = routes[String(url)];
    if (hit) {
      if (hit.throws) throw new Error(`network down for ${url}`);
      return { ok: hit.ok ?? true, status: hit.status ?? 200, json: async () => hit.json };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

// Mount the prelude without the service; the test installs the IDB flavour
// and requireFresh()s the service so module state resets per scenario.
async function mount({ routes = {}, idb = 'none' } = {}) {
  const ctx = await coverLoadServiceApp('app-loader-optimiser', {
    scripts: [],
    stubs: { fetch: fetchRouter(routes) },
  });
  if (idb === 'fake') installFakeIdb(globalThis);
  else if (typeof idb === 'object' || typeof idb === 'function') globalThis.indexedDB = idb;
  // 'none': leave globalThis.indexedDB undefined
  return ctx;
}

async function load(ctx) {
  requireFresh('js/apps/app-loader-optimiser/service.js');
  await settle(40);
  return ctx.window.AppLoaderOptimizer;
}

// A scripted indexedDB whose requests behave per scenario. Each
// transaction() call returns a dedicated tx object and remembers it, so
// oncomplete/onerror fire on the very object the service assigned them to.
function scriptedIDB({ openRejects = false, getRejects = false, putRejects = false, deleteRejects = false } = {}) {
  const store = new Map();
  const settleReq = (fire) => {
    const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result: undefined, error: null };
    setImmediate(() => fire(req));
    return req;
  };
  const db = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const tx = { oncomplete: null, onerror: null, onabort: null };
      tx.objectStore = () => ({
        get: (file) => settleReq((req) => {
          if (getRejects) req.onerror({ target: { error: new Error('get failed') } });
          else req.onsuccess({ target: { result: store.get(file) ?? null } });
        }),
        put: (rec) => {
          store.set(rec.file, rec);
          setImmediate(() => {
            if (putRejects) {
              if (tx.onerror) tx.onerror({ target: { error: new Error('put failed') } });
              if (tx.onabort) tx.onabort({ target: { error: new Error('put aborted') } });
            }
            else if (tx.oncomplete) tx.oncomplete();
          });
          return { onsuccess: null, onerror: null };
        },
        delete: (file) => settleReq((req) => {
          if (deleteRejects) req.onerror({ target: { error: new Error('delete failed') } });
          else { store.delete(file); req.onsuccess({ target: {} }); }
        }),
      });
      return tx;
    },
  };
  return {
    open: () => settleReq((req) => {
      if (openRejects) req.onerror({ target: { error: new Error('open failed') } });
      else {
        req.result = db; // the service reads event.target.result in both handlers
        if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
        req.onsuccess({ target: req });
      }
    }),
  };
}

describe('AppLoaderOptimizer (js/apps/app-loader-optimiser/service.js) — e2e coverage', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.resetModules();
    delete globalThis.indexedDB;
    delete globalThis.IDBKeyRange;
  });

  it('validates inputs and memoises getPackage promises', async () => {
    const ctx = await mount({ routes: { 'a.novaapp': { json: { manifest: { id: 'A' } } } } });
    const opt = await load(ctx);
    await expect(opt.getPackage(123)).rejects.toThrow(TypeError);
    await expect(opt.getPackage('')).rejects.toThrow(TypeError);
    const p1 = opt.getPackage('a.novaapp');
    const p2 = opt.getPackage('a.novaapp');
    expect(p1).toBe(p2); // memoised: same promise instance
    await expect(p1).resolves.toMatchObject({ manifest: { id: 'A' } });
    // no cacheKey → read cache skipped (null), fetch used, persist skipped
    const bare = await opt.getPackage('a.novaapp', null);
    expect(bare.manifest.id).toBe('A');
  });

  it('fetch failures propagate (with status) and feed start() failed counts', async () => {
    const ctx = await mount({ routes: {
      'bad.novaapp': { ok: false, status: 500, json: {} },
      'good.novaapp': { json: { manifest: { id: 'G' } } },
    } });
    const opt = await load(ctx);
    await expect(opt.getPackage('bad.novaapp')).rejects.toMatchObject({ status: 500 });
    const res = await opt.start([
      { id: 'x', file: 'bad.novaapp' },
      { id: 'y', file: 'good.novaapp' },
    ]);
    expect(res.packages).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.finishedAt).toBeGreaterThan(0);
    expect(res.cachedPackages).toBe(2); // bad (memoised, rejected) + good
  });

  it('start validates the bundle list and is idempotent until clear()', async () => {
    const ctx = await mount({ routes: {} });
    const opt = await load(ctx);
    expect(() => opt.start('nope')).toThrow(TypeError);
    expect(() => opt.start(null)).toThrow(TypeError);
    const first = await opt.start([
      null, // skipped
      { id: 5, file: 'x' }, // non-string id → skipped
      { id: 'ok', file: 7 }, // non-string file → skipped
      { id: SELF_ID, file: 'self.novaapp' }, // self → skipped
      { id: 'ok2', file: 'fine.novaapp' }, // valid → prefetched
    ]);
    expect(first.packages).toBe(1);
    const stats = opt.getStats();
    expect(stats.startedAt).toBeGreaterThan(0);
    expect(stats.packages).toBe(1);
    // second start while prefetch state exists → early return of stats only
    const again = await opt.start([{ id: 'ok3', file: 'other.novaapp' }]);
    expect(again.packages).toBe(1); // unchanged — prefetch not restarted
    opt.clear();
    expect(opt.getStats()).toMatchObject({ startedAt: null, finishedAt: null, packages: 0, cachedPackages: 0 });
    const fresh = await opt.start([]);
    expect(fresh.packages).toBe(0);
    expect(fresh.failed).toBe(0);
  });

  it('with fake IDB: miss persists, cache hit serves without fetch, evict drops both', async () => {
    const routes = { 'p.novaapp': { json: { manifest: { id: 'P' } } } };
    const ctx = await mount({ routes, idb: 'fake' });
    const opt = await load(ctx);
    // v1: store empty → miss → fetch + persist
    const one = await opt.getPackage('p.novaapp', 'v1');
    expect(one.manifest.id).toBe('P');
    // v2: stored record is stale (cacheKey v1) → miss → refetch + persist v2
    const stale = await opt.getPackage('p.novaapp', 'v2');
    expect(stale.manifest.id).toBe('P');
    // same key again: in-flight memo returns the identical promise object
    const memoA = opt.getPackage('p.novaapp', 'v2');
    const memoB = opt.getPackage('p.novaapp', 'v2');
    expect(memoA).toBe(memoB);
    await memoA;
    // switch fetch to a distinguishable marker, then load a fresh module:
    // a served package must come from the persistent cache, not the network
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ manifest: { id: 'FETCHED' } }) });
    requireFresh('js/apps/app-loader-optimiser/service.js');
    await settle(40);
    const opt2 = ctx.window.AppLoaderOptimizer;
    const hit = await opt2.getPackage('p.novaapp', 'v2');
    expect(hit.manifest.id).toBe('P'); // cache hit (L76 early return), not FETCHED
    // evict clears in-flight promises and the persistent record
    expect(await opt2.evict('p.novaapp')).toBe(true);
    // after evict a fresh load must go back to the network
    requireFresh('js/apps/app-loader-optimiser/service.js');
    await settle(40);
    const opt3 = ctx.window.AppLoaderOptimizer;
    const refetched = await opt3.getPackage('p.novaapp', 'v2');
    expect(refetched.manifest.id).toBe('FETCHED');
    // evict guards
    await expect(opt3.evict(123)).rejects.toThrow(TypeError);
    await expect(opt3.evict('')).rejects.toThrow(TypeError);
    expect(await opt3.evict('never-loaded.novaapp')).toBe(true); // nothing cached → still true
  });

  it('scripted IDB: open rejection resets the promise; get rejection falls back to fetch', async () => {
    const ctx = await mount({ routes: { 'q.novaapp': { json: { manifest: { id: 'Q' } } } }, idb: scriptedIDB({ openRejects: true }) });
    const opt = await load(ctx);
    // openPackageCache rejected → readCachedPackage awaited inside loadBundledPackage
    // rejects → .catch → null → falls back to fetch
    const out = await opt.getPackage('q.novaapp', 'v1');
    expect(out.manifest.id).toBe('Q');
  });

  it('scripted IDB: read/get error logs and continues via fetch', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = await mount({ routes: { 'r.novaapp': { json: { manifest: { id: 'R' } } } }, idb: scriptedIDB({ getRejects: true }) });
    const opt = await load(ctx);
    const out = await opt.getPackage('r.novaapp', 'v1');
    expect(out.manifest.id).toBe('R');
    expect(err).toHaveBeenCalled(); // the read failure was reported
    err.mockRestore();
  });

  it('scripted IDB: persist failure logs but still returns the package', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = await mount({ routes: { 's.novaapp': { json: { manifest: { id: 'S' } } } }, idb: scriptedIDB({ putRejects: true }) });
    const opt = await load(ctx);
    const out = await opt.getPackage('s.novaapp', 'v1');
    expect(out.manifest.id).toBe('S');
    expect(err).toHaveBeenCalled(); // persist failure reported
    err.mockRestore();
  });

  it('scripted IDB: evict delete failure resolves false (best-effort)', async () => {
    const ctx = await mount({ routes: { 't.novaapp': { json: { manifest: { id: 'T' } } } }, idb: scriptedIDB({ deleteRejects: true }) });
    const opt = await load(ctx);
    await opt.getPackage('t.novaapp', 'v1');
    expect(await opt.evict('t.novaapp')).toBe(false);
  });

  it('no IDB at all: null database arms (read null, persist skipped, evict true)', async () => {
    const ctx = await mount({ routes: { 'u.novaapp': { json: { manifest: { id: 'U' } } } } });
    const opt = await load(ctx);
    const out = await opt.getPackage('u.novaapp', 'v1');
    expect(out.manifest.id).toBe('U');
    expect(await opt.evict('u.novaapp')).toBe(true);
  });
});
