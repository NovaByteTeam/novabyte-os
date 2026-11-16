// tests/apps/search-index.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/search-index/service.js.
// The real service runs against a live JSDOM window: the trigram engine is
// driven through its public surface (build/search), the FS walker through a
// scripted in-memory tree, and the localStorage watchers through the real
// patched setItem plus real StorageEvents.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { coverLoadServiceApp, requireFresh } from '../helpers/cover-loader.js';

const ITEMS = [
  { id: 'x1', title: 'foo bar' },
  { id: 'x2', title: 'foo baz' },
  { id: 'x3', title: 'qux' },
];

async function mount() {
  return coverLoadServiceApp('search-index', { withBaseUtils: true });
}

describe('SearchIndex (js/apps/search-index/service.js) — e2e coverage', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes a frozen facade with build/search/collectFiles/watchStorage', async () => {
    const { window } = await mount();
    const idx = window.SearchIndex;
    expect(Object.isFrozen(idx)).toBe(true);
    for (const k of ['build', 'search', 'collectFiles', 'watchStorage']) {
      expect(typeof idx[k]).toBe('function');
    }
  });

  it('build rejects non-array items and non-function selectors', async () => {
    const { window } = await mount();
    expect(() => window.SearchIndex.build(null, (i) => i)).toThrow(TypeError);
    expect(() => window.SearchIndex.build([], 'nope')).toThrow(TypeError);
  });

  it('build indexes array and single keys, skips short/empty values, shares buckets', async () => {
    const { window } = await mount();
    const built = window.SearchIndex.build(ITEMS, (item) => [item.title, item.id, null, '']);
    // searching hits both the title and the id key channels
    const byTitle = window.SearchIndex.search(built, 'foo', () => true);
    // 'x1' is 2 chars — the <3 linear-filter path with a per-item verifier
    const byId = window.SearchIndex.search(built, 'x1', (item) => item.id === 'x1');
    expect(byTitle).toEqual([ITEMS[0], ITEMS[1]]);
    expect(byId).toEqual([ITEMS[0]]);
    // values shorter than 3 chars contribute no grams: any 3+ query misses
    const short = window.SearchIndex.build([{ id: 's1', title: 'ab' }], (i) => i.title);
    expect(window.SearchIndex.search(short, 'abx', () => true)).toEqual([]);
  });

  it('search rejects invalid indexes and verifiers', async () => {
    const { window } = await mount();
    const { search, build } = window.SearchIndex;
    expect(() => search(null, 'q', () => true)).toThrow(TypeError);
    expect(() => search({ items: [] }, 'q', () => true)).toThrow(TypeError); // no index Map
    expect(() => search({ index: new Map() }, 'q', () => true)).toThrow(TypeError); // no items array
    const built = build(ITEMS, (i) => i.title);
    expect(() => search(built, 'q', null)).toThrow(TypeError);
  });

  it('search: empty query, short query filter path, missing gram, verify arms', async () => {
    const { window } = await mount();
    const { build, search } = window.SearchIndex;
    const built = build(ITEMS, (i) => i.title);
    expect(search(built, '', () => true)).toEqual([]);
    expect(search(built, null, () => true)).toEqual([]);
    // <3 chars → linear filter, verifier decides per item
    expect(search(built, 'fo', (item) => item.id === 'x1')).toEqual([ITEMS[0]]);
    // a gram the index never saw → no results
    expect(search(built, 'zzz', () => true)).toEqual([]);
    // ≥3 chars: rarest bucket + verifier true/false arms
    expect(search(built, 'foo', (item) => item.id === 'x1')).toEqual([ITEMS[0]]);
    expect(search(built, 'foo', () => false)).toEqual([]);
  });

  it('search picks the rarest bucket across grams (min selection)', async () => {
    const { window } = await mount();
    const { build, search } = window.SearchIndex;
    const built = build(ITEMS, (i) => i.title);
    // grams: foo→{x1,x2} (2), oo →{x1,x2} (2), o b→{x1,x2}, ' ba'→{x1,x2},
    // bar→{x1} (1) — the 'bar' bucket is rarest, so only x1 can match
    const out = search(built, 'foo bar', (item) => true);
    expect(out).toEqual([ITEMS[0]]);
    // equal-size buckets keep the first (no update on `size < size` false arm)
    const equal = search(built, 'foo ba', () => true);
    expect(equal).toEqual([ITEMS[0], ITEMS[1]]);
  });

  it('collectFiles guards and walks the tree', async () => {
    const { window } = await mount();
    const { collectFiles } = window.SearchIndex;
    // fs missing / no files / no listDir
    expect(collectFiles(undefined)).toEqual([]);
    expect(collectFiles({ files: new Map(), rootId: 'r' })).toEqual([]); // listDir not a function
    expect(collectFiles({ files: null, listDir() {}, rootId: 'r' })).toEqual([]);
    // real walk: dot folders skipped, dup folders visited once, non-file nodes ignored
    const tree = {
      r: [
        { id: 'sub', name: 'sub', type: 'folder' },
        { id: 'dot', name: '.hidden', type: 'folder' },
        { id: 'sub', name: 'sub-again', type: 'folder' },
        { id: 'weird', name: 'odd', type: 'mount' },
        { id: 'f1', name: 'a.txt', type: 'file' },
      ],
      sub: [{ id: 'f2', name: 'b.txt', type: 'file' }],
      dot: [{ id: 'f3', name: 'c.txt', type: 'file' }],
      'data-dir': [{ id: 'f4', name: 'd.txt', type: 'file' }],
    };
    const fs = {
      files: new Map(),
      rootId: 'r',
      specialFolders: { data: 'data-dir' },
      listDir: (id) => tree[id] ?? [],
    };
    const out = collectFiles(fs);
    // LIFO pending: data-dir pops first (f4), then root (f1), then sub (f2)
    expect(out.map((f) => f.id)).toEqual(['f4', 'f1', 'f2']);
    // no rootId / no data folder → pending filter(Boolean) arms
    const noRoot = collectFiles({ ...fs, rootId: null });
    expect(noRoot.map((f) => f.id)).toEqual(['f4']);
    const neither = collectFiles({ ...fs, rootId: null, specialFolders: {} });
    expect(neither).toEqual([]); // walk found nothing → fallback over fs.files
    // empty walk falls back to fs.files values (file entries only)
    const fallback = collectFiles({
      files: new Map([
        ['k1', { id: 'g1', type: 'file' }],
        ['k2', { id: 'g2', type: 'folder' }],
      ]),
      rootId: 'empty',
      listDir: () => [],
    });
    expect(fallback.map((f) => f.id)).toEqual(['g1']);
  });

  it('watchStorage validates args and fires on patched setItem', async () => {
    // jsdom's Storage is a Proxy that silently drops the service's setItem
    // patch, so the storage boundary is a plain object the service can patch
    // for real (same class of limitation as the jsdom canvas context).
    const plain = { _m: new Map(), setItem(k, v) { this._m.set(k, String(v)); }, getItem(k) { return this._m.get(k) ?? null; }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };
    const { window } = await coverLoadServiceApp('search-index', { scripts: [] });
    const savedLS = globalThis.localStorage;
    globalThis.localStorage = plain;
    try {
      requireFresh('js/apps/search-index/service.js');
    } finally {
      globalThis.localStorage = savedLS;
    }
    const { watchStorage } = window.SearchIndex;
    expect(() => watchStorage('nope', () => {})).toThrow(TypeError);
    expect(() => watchStorage(['k'], 'nope')).toThrow(TypeError);
    const seen = [];
    const unwatch = watchStorage(['nova_key'], (key) => seen.push(key));
    plain.setItem('nova_key', 'v1'); // patched setItem → watcher hit
    plain.setItem('other_key', 'v'); // keys.has false arm
    expect(plain._m.get('nova_key')).toBe('v1'); // original setItem still ran
    expect(seen).toEqual(['nova_key']);
    // a throwing listener is caught (console.error arm) and survives
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    watchStorage(['nova_key'], () => { throw new Error('listener bug'); });
    expect(() => plain.setItem('nova_key', 'v2')).not.toThrow();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    unwatch();
    plain.setItem('nova_key', 'v3');
    // watcher1 fired on v2 (before unwatch) but not on v3 (after unwatch);
    // the throwing watcher never pushes — it throws before seen.push.
    expect(seen).toEqual(['nova_key', 'nova_key']);
  });

  it('storage events fan out to watchers (null key hits all)', async () => {
    const { window } = await mount();
    const seen = [];
    window.SearchIndex.watchStorage(['k2'], (key) => seen.push(`k2:${key}`));
    window.SearchIndex.watchStorage(['other'], (key) => seen.push(`other:${key}`));
    window.dispatchEvent(new window.StorageEvent('storage', { key: 'k2' }));
    window.dispatchEvent(new window.StorageEvent('storage', { key: 'k9' })); // no watcher has k9
    window.dispatchEvent(new window.StorageEvent('storage', { key: null })); // hits every watcher
    expect(seen).toEqual(['k2:k2', 'k2:null', 'other:null']);
    // a throwing listener inside the event fan-out is isolated (catch arm)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.SearchIndex.watchStorage(['k2'], () => { throw new Error('watcher bug'); });
    expect(() => window.dispatchEvent(new window.StorageEvent('storage', { key: 'k2' }))).not.toThrow();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
