// tests/apps/downloads-history.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/downloads-history/service.js.
// The real service runs against a live JSDOM window; the store is driven
// through its public API (add/setStatus/remove/clearCompleted/subscribe),
// the native-chrome downloads bridge through scripted listener callbacks,
// and id generation through all three crypto arms.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { coverLoadServiceApp, requireFresh } from '../helpers/cover-loader.js';

const KEY = 'nova_downloads';

async function mount({ lsSave, chromeDownloads } = {}) {
  // chrome must be in place BEFORE the service require (the bridge attaches
  // at load time through the top-level guard).
  if (chromeDownloads !== undefined) {
    globalThis.chrome = chromeDownloads === null ? undefined : { downloads: chromeDownloads };
  }
  const ctx = await coverLoadServiceApp('downloads-history', {
    stubs: { extra: {} },
  });
  if (lsSave !== undefined) ctx.window.lsSave = lsSave;
  return ctx;
}

afterEach(() => {
  delete globalThis.chrome;
  vi.restoreAllMocks();
});

describe('DownloadsHistory (js/apps/downloads-history/service.js) — e2e coverage', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.resetModules();
    delete globalThis.chrome;
  });

  it('add() stores entries with defaults and explicit fields', async () => {
    const { window } = await mount();
    const d = window.Downloads;
    const full = d.add('report.pdf', 'https://x/r.pdf', 1024, 'application/pdf');
    expect(full).toMatchObject({ name: 'report.pdf', url: 'https://x/r.pdf', size: 1024, mimeType: 'application/pdf', status: 'done' });
    expect(typeof full.id).toBe('string');
    const defaults = d.add();
    expect(defaults).toMatchObject({ name: 'Unknown file', url: '', size: 0, mimeType: '', status: 'done' });
    const explicit = d.add('x', 'u', 5, 'text', 'downloading');
    expect(explicit.status).toBe('downloading');
    expect(d.getAll().map((e) => e.name)).toEqual(['x', 'Unknown file', 'report.pdf']);
  });

  it('save uses window.lsSave when available, localStorage otherwise', async () => {
    const lsSaveCalls = [];
    const a = await mount({ lsSave: (k, v) => { lsSaveCalls.push([k, v]); } });
    a.window.Downloads.add('a', 'u');
    expect(lsSaveCalls).toHaveLength(1);
    expect(lsSaveCalls[0][0]).toBe(KEY);
    expect(lsSaveCalls[0][1][0].name).toBe('a'); // bounded array payload
    const b = await mount(); // no lsSave — plain localStorage channel
    b.window.Downloads.add('b', 'u');
    expect(JSON.parse(b.window.localStorage.getItem(KEY))[0].name).toBe('b');
  });

  it('load tolerates missing/invalid/non-array storage', async () => {
    const a = await mount();
    a.window.localStorage.setItem(KEY, '{bad json');
    expect(a.window.Downloads.getAll()).toEqual([]);
    const b = await mount();
    b.window.localStorage.setItem(KEY, JSON.stringify({ nope: 1 }));
    expect(b.window.Downloads.getAll()).toEqual([]);
  });

  it('history is bounded at 500 entries', async () => {
    const { window } = await mount();
    for (let i = 0; i < 502; i += 1) window.Downloads.add(`f${i}`, 'u');
    expect(window.Downloads.getAll()).toHaveLength(500);
    expect(window.Downloads.getAll()[0].name).toBe('f501');
  });

  it('setStatus updates and reports misses', async () => {
    const { window } = await mount();
    const d = window.Downloads;
    const e = d.add('f', 'u', 1, 't', 'downloading');
    expect(d.setStatus(e.id, 'done', 99)).toBe(true);
    const stored = d.getAll().find((i) => i.id === e.id);
    expect(stored.status).toBe('done');
    expect(stored.size).toBe(99);
    expect(d.setStatus('missing', 'done')).toBe(false);
    // size skipped when null (entry keeps its size)
    d.setStatus(e.id, 'failed', null);
    expect(d.getAll().find((i) => i.id === e.id).size).toBe(99);
  });

  it('remove deletes only what exists; clearCompleted keeps downloading', async () => {
    const { window } = await mount();
    const d = window.Downloads;
    const keep = d.add('active', 'u', 1, 't', 'downloading');
    const done = d.add('finished', 'u', 2, 't', 'done');
    expect(d.remove('nope')).toBe(false);
    expect(d.remove(done.id)).toBe(true);
    expect(d.getAll().map((i) => i.id)).toEqual([keep.id]);
    expect(d.clearCompleted()).toBe(false); // only downloading left → nothing to clear
    d.add('done2', 'u', 3, 't', 'done');
    expect(d.clearCompleted()).toBe(true);
    expect(d.getAll().map((i) => i.status)).toEqual(['downloading']);
  });

  it('subscribe validates, fans out, and unsubscribes; throwing listeners isolated', async () => {
    const { window } = await mount();
    const d = window.Downloads;
    expect(() => d.subscribe('nope')).toThrow(TypeError);
    const seen = [];
    d.subscribe((items, change) => seen.push([items.length, change]));
    d.subscribe(() => { throw new Error('listener bug'); });
    d.add('f', 'u'); // notify('add') — the bad listener must not break it
    expect(seen[0]).toEqual([1, 'add']);
    const off = d.subscribe(() => {});
    off();
    expect(d.getAll().length).toBeGreaterThan(0);
  });

  it('storage events notify listeners for our key and null', async () => {
    const { window } = await mount();
    const seen = [];
    window.Downloads.subscribe((items, change) => seen.push(change));
    window.dispatchEvent(new window.StorageEvent('storage', { key: KEY }));
    window.dispatchEvent(new window.StorageEvent('storage', { key: 'other' }));
    window.dispatchEvent(new window.StorageEvent('storage', { key: null }));
    expect(seen).toEqual(['storage', 'storage']);
  });

  it('native bridge: unavailable API warns and returns false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { window } = await mount({ chromeDownloads: {} }); // missing listeners
    expect(warn).toHaveBeenCalled();
    // service still functions
    window.Downloads.add('f', 'u');
    expect(window.Downloads.getAll().length).toBe(1);
    warn.mockRestore();
  });

  it('native bridge: full API wires determining-filename, onCreated, onChanged', async () => {
    const handlers = {};
    const api = {
      onDeterminingFilename: { addListener: (fn) => { handlers.determine = fn; } },
      onCreated: { addListener: (fn) => { handlers.created = fn; } },
      onChanged: { addListener: (fn) => { handlers.changed = fn; } },
    };
    const { window } = await mount({ chromeDownloads: api });
    const d = window.Downloads;
    const suggest = vi.fn();
    // filename present → split basename; illegal chars sanitised
    handlers.determine({ filename: 'dir/sub/bad:name?.txt', url: 'https://x' }, suggest);
    expect(suggest).toHaveBeenCalledWith({ filename: 'bad_name_.txt', conflictAction: 'uniquify' });
    // filename absent → URL pathname decoded
    handlers.determine({ url: 'https://x/files/f%20ile.txt' }, suggest);
    expect(suggest).toHaveBeenLastCalledWith({ filename: 'f ile.txt', conflictAction: 'uniquify' });
    // unparseable URL → warn + timestamped fallback name
    handlers.determine({ url: 'not-a-url' }, suggest);
    expect(suggest).toHaveBeenLastCalledWith(expect.objectContaining({ filename: expect.stringMatching(/^download_\d+$/) }));
    // whitespace-only filename sanitises to the timestamped fallback
    handlers.determine({ filename: '   ', url: 'https://x' }, suggest);
    expect(suggest).toHaveBeenLastCalledWith(expect.objectContaining({ filename: expect.stringMatching(/^download_\d+$/) }));
    // a completed onCreated entry is NOT tracked for onChanged
    handlers.created({ id: 'natC', filename: 'c.txt', url: 'u', totalBytes: 3, mime: 't', state: 'complete' });
    expect(d.getAll().find((i) => i.name === 'c.txt').status).toBe('done');
    // an entry without a mime field normalises to the empty mime
    handlers.created({ id: 'natM', filename: 'no-mime.bin', url: 'u', totalBytes: 1, state: 'complete' });
    expect(d.getAll().find((i) => i.name === 'no-mime.bin')).toMatchObject({ mimeType: '', status: 'done' });
    // a live (non-complete) native download is tracked for onChanged
    handlers.created({ id: 'nat1', filename: 'n.txt', url: 'u', totalBytes: 10, mime: 't', state: 'in_progress' });
    const tracked = d.getAll().find((i) => i.name === 'n.txt');
    expect(tracked.status).toBe('downloading');
    // change to complete with a size → setStatus through the map
    handlers.changed({ state: { current: 'complete' }, totalBytes: { current: 77 } }, 'nat1');
    expect(d.getAll().find((i) => i.name === 'n.txt')).toMatchObject({ status: 'done', size: 77 });
    // unknown native id → early return
    expect(() => handlers.changed({ state: { current: 'complete' } }, 'unknown')).not.toThrow();
    // no state, size from bytesReceived → keeps current status
    handlers.created({ id: 'nat2', filename: 'm.txt', url: 'u', totalBytes: 0, mime: 't', state: 'in_progress' });
    handlers.changed({ totalBytes: { current: 0 }, bytesReceived: { current: 5 } }, 'nat2');
    expect(d.getAll().find((i) => i.name === 'm.txt').size).toBe(5);
    // size-only change for an entry removed from the store → current undefined → skipped
    handlers.created({ id: 'nat3', filename: 'z.txt', url: 'u', totalBytes: 0, mime: 't', state: 'in_progress' });
    const z = d.getAll().find((i) => i.name === 'z.txt');
    d.remove(z.id);
    expect(() => handlers.changed({ bytesReceived: { current: 8 } }, 'nat3')).not.toThrow();
    expect(d.getAll().find((i) => i.name === 'z.txt')).toBeUndefined();
    // empty delta → nothing happens, no crash
    expect(() => handlers.changed({}, 'nat2')).not.toThrow();
    expect(d.getAll().find((i) => i.name === 'm.txt').status).toBe('downloading');
    // interrupting deletes the mapping
    handlers.changed({ state: { current: 'interrupted' } }, 'nat2');
    expect(d.getAll().find((i) => i.name === 'm.txt').status).toBe('failed');
    // further changes for the deleted mapping are a no-op
    expect(() => handlers.changed({ state: { current: 'complete' } }, 'nat2')).not.toThrow();
  });

  it('id generation: getRandomValues arm and the no-crypto throw', async () => {
    const { window } = await mount();
    const d = window.Downloads;
    const savedCrypto = globalThis.crypto;
    try {
      // arm 2 — randomUUID missing, getRandomValues present
      let next = 0;
      globalThis.crypto = {
        getRandomValues: (arr) => { for (let i = 0; i < arr.length; i += 1) arr[i] = (next++ % 256); return arr; },
      };
      const viaValues = d.add('v', 'u');
      expect(viaValues.id).toMatch(/^[0-9a-f]{32}$/);
      // arm 3 — no secure source at all
      globalThis.crypto = {};
      expect(() => d.add('w', 'u')).toThrow('secure random source');
    } finally {
      globalThis.crypto = savedCrypto;
    }
  });

  it('chrome absent at load skips the bridge (guard arms)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = await mount({ chromeDownloads: null }); // typeof chrome undefined arm
    a.window.Downloads.add('f', 'u');
    expect(warn).not.toHaveBeenCalled();
    const b = await mount({ chromeDownloads: {} }); // chrome.downloads falsy arm
    expect(warn).toHaveBeenCalled(); // from the attach attempt inside
    warn.mockRestore();
  });
});
