// tests/apps/media-store.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/media-store/service.js.
// The real service is require()d against a live JSDOM window; the NovaByte
// FS boundary is a scripted in-memory tree (listDir/getPath/specialFolders
// shaped per scenario) so every rebuildIndex branch runs: invalid-FS throws,
// excluded folders, visited dedupe, hidden files, non-file nodes, the
// 5000-entry cap break, root-relative path normalisation (forward and
// backslash), and the media-type detection by mime and by extension.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { coverLoadServiceApp } from '../helpers/cover-loader.js';

// The main tree: mixed mime/extension media, a non-media file, a hidden
// file, a non-file node, a trash and a data folder (both excluded), a
// duplicate folder id (visited dedupe), and a normal subfolder.
function mainTree() {
  return {
    root: [
      { id: 'trashid', name: 'Trash', type: 'folder' },
      { id: 'dataid', name: 'Data', type: 'folder' },
      { id: 'sub', name: 'stuff', type: 'folder' },
      { id: 'sub', name: 'stuff-again', type: 'folder' }, // same id → visited hit
      { id: 'mount-x', name: 'odd', type: 'mount' }, // neither folder nor file
      { id: 'f1', name: '.hidden.png', type: 'file', mimeType: 'image/png', size: 10, created: 5, modified: 5 },
      { id: 'f2', name: 'readme.txt', type: 'file', mimeType: 'text/plain', size: 3, created: 1, modified: 1 },
      { id: 'f3', name: 'photo', type: 'file', mimeType: 'IMAGE/PNG', size: 200, created: 2, modified: 200 },
      { id: 'f4', name: 'tone', type: 'file', mimeType: 'audio/ogg', size: 40, created: 2, modified: 100 },
      { id: 'f5', name: 'clip', type: 'file', mimeType: 'video/webm', size: 900, created: 2, modified: 100 },
      { id: 'f6', name: 'song.mp3', type: 'file', size: 60, created: 2, modified: 50 }, // mime absent, extension hit
      { id: 'f7', name: 'x', type: 'file', size: 1, created: 1, modified: 1 }, // no mime, no media ext
      { id: 'f12', name: '', type: 'file', size: 1, created: 1, modified: 1 }, // empty name → String(file.name || '') falsy arm
      // media item with no timestamps at all → created/modified fall back to 0
      { id: 'f13', name: 'stale.jpg', type: 'file', mimeType: 'image/jpeg', size: 5 },
    ],
    trashid: [{ id: 't1', name: 'deleted.png', type: 'file', mimeType: 'image/png', size: 1, created: 1, modified: 1 }],
    dataid: [{ id: 'd1', name: 'db.sqlite', type: 'file', size: 1, created: 1, modified: 1 }],
    sub: [
      { id: 'f8', name: 'wallpaper.webp', type: 'file', mimeType: 'image/webp', size: 300, created: 3, modified: 300 },
      { id: 'f9', name: 'empty-size.png', type: 'file', mimeType: 'image/png', created: 3, modified: 3 }, // size not finite → 0
    ],
  };
}

function mainPaths() {
  return {
    root: '/root/',
    trashid: '/root/.trash',
    dataid: '/root/.data',
    sub: '/root/stuff',
    f3: '/root/photo',
    f4: '/root/tone',
    f5: '/root/clip',
    f6: '/root/song.mp3',
    f8: '/root/stuff/wallpaper.webp',
    f9: '/root/stuff/empty-size.png',
    // the file whose absolute path equals the stripped root path → '/'
    f10: '/root',
    // a path that does not start with the root prefix after slicing (no leading slash)
    f11: '/rootmedia/odd.mp4',
  };
}

function mainTreeWithRootEdgeNodes() {
  const tree = mainTree();
  tree.root.push({ id: 'f10', name: 'at-root', type: 'file', mimeType: 'video/mp4', size: 1, created: 1, modified: 1 });
  tree.root.push({ id: 'f11', name: 'odd', type: 'file', mimeType: 'video/mp4', size: 1, created: 1, modified: 1 });
  return tree;
}

async function mountWithFS({ tree, paths, specialFolders }, opts = {}) {
  const subs = {};
  const ctx = await coverLoadServiceApp('media-store', {
    stubs: {
      extra: {
        ...(opts.noOS ? {} : { OS: { events: { on: (event, cb) => { subs[event] = cb; } } } }),
      },
    },
  });
  if (tree !== undefined) {
    ctx.window.FS = {
      rootId: 'root',
      listDir: (id) => (tree[id] ?? []),
      getPath: (id) => (paths[id] ?? ''),
      ...(specialFolders ? { specialFolders } : {}),
    };
  }
  return { ...ctx, subs };
}

describe('NovaByteMediaStore (js/apps/media-store/service.js) — e2e coverage', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.resetModules();
  });

  it('rejects query options that are not plain objects', async () => {
    const { window } = await mountWithFS({});
    const query = window.NovaByteMediaStore.query;
    expect(() => query(null)).toThrow(TypeError);
    expect(() => query('filters')).toThrow(TypeError);
    expect(() => query(['array'])).toThrow(TypeError);
  });

  it('rejects unknown media types and bad offset/limit values', async () => {
    const { window } = await mountWithFS({ tree: mainTree(), paths: mainPaths() });
    const query = window.NovaByteMediaStore.query;
    expect(() => query({ type: 'document' })).toThrow(TypeError);
    expect(() => query({ offset: -1 })).toThrow(TypeError);
    expect(() => query({ offset: 1.5 })).toThrow(TypeError);
    expect(() => query({ limit: 0 })).toThrow(TypeError);
    expect(() => query({ limit: 2.5 })).toThrow(TypeError);
  });

  it('throws when the FS boundary is unusable (each guard arm)', async () => {
    const badFSs = [
      undefined, // !fs
      { rootId: null, listDir() {}, getPath() {} }, // !fs.rootId
      { rootId: 'r', listDir: 1, getPath() {} }, // listDir not a function
      { rootId: 'r', listDir() {}, getPath: 1 }, // getPath not a function
    ];
    for (const fs of badFSs) {
      const { window } = await mountWithFS({});
      if (fs !== undefined) window.FS = fs;
      else delete window.FS;
      expect(() => window.NovaByteMediaStore.query()).toThrow('NovaByte filesystem is not ready');
    }
  });

  it('indexes the tree, excludes trash/data, dedupes visits, skips hidden and non-file nodes', async () => {
    const { window } = await mountWithFS({
      tree: mainTreeWithRootEdgeNodes(),
      paths: mainPaths(),
      specialFolders: { trash: 'trashid', data: 'dataid' },
    });
    const files = window.NovaByteMediaStore.query();
    const ids = files.map((f) => f.id);
    // trash/data contents and hidden/non-media/odd nodes are all excluded
    expect(ids).not.toContain('t1');
    expect(ids).not.toContain('d1');
    expect(ids).not.toContain('f1');
    expect(ids).not.toContain('f2');
    expect(ids).not.toContain('f7');
    expect(ids).not.toContain('mount-x');
    expect(ids).not.toContain('f12');
    // the real media files are in, newest modified first; ties broken by name
    // (modified: f8=300, f3=200, {f5 clip,f4 tone}=100, f6=50, f9=3, {f10 at-root,f11 odd}=1, f13=0 fallback)
    expect(files.map((f) => f.id)).toEqual(['f8', 'f3', 'f5', 'f4', 'f6', 'f9', 'f10', 'f11', 'f13']);
    // mime-based typing kept the case-insensitive match
    expect(files.find((f) => f.id === 'f3').type).toBe('image');
    expect(files.find((f) => f.id === 'f4').type).toBe('audio');
    expect(files.find((f) => f.id === 'f5').type).toBe('video');
    // extension-only match (no mimeType on the node)
    expect(files.find((f) => f.id === 'f6').type).toBe('audio');
    expect(files.find((f) => f.id === 'f6').mimeType).toBe('');
    // non-finite size fell back to 0
    expect(files.find((f) => f.id === 'f9').size).toBe(0);
    // absent timestamps fell back to 0 in the index snapshot
    expect(files.find((f) => f.id === 'f13').created).toBe(0);
    expect(files.find((f) => f.id === 'f13').modified).toBe(0);
    // paths normalised: root-equal → '/', no-leading-slash → prefixed
    expect(files.find((f) => f.id === 'f10').path).toBe('media:/');
    expect(files.find((f) => f.id === 'f11').path).toBe('media:/media/odd.mp4');
    expect(files.find((f) => f.id === 'f8').path).toBe('media:/stuff/wallpaper.webp');
  });

  it('normalises backslash paths and strips trailing separators from the root', async () => {
    const { window } = await mountWithFS({
      tree: {
        root: [
          { id: 'sub', name: 'music', type: 'folder' },
          { id: 'a', name: 'track.flac', type: 'file', size: 1, created: 1, modified: 2 },
        ],
        sub: [
          { id: 'b', name: 'film.mkv', type: 'file', mimeType: 'video/x-matroska', size: 2, created: 1, modified: 1 },
        ],
      },
      paths: { root: '\\root\\', sub: '\\root\\music', a: '\\root\\music\\track.flac', b: '\\root\\music\\film.mkv' },
    });
    const files = window.NovaByteMediaStore.query({ type: 'all' });
    expect(files.map((f) => f.id)).toEqual(['a', 'b']);
    expect(files.find((f) => f.id === 'a').path).toBe('media:/music/track.flac');
    expect(files.find((f) => f.id === 'b').path).toBe('media:/music/film.mkv');
  });

  it('runs without specialFolders and without OS events (optional chains take the absent arm)', async () => {
    const { window, subs } = await mountWithFS({ tree: mainTree(), paths: mainPaths() }, { noOS: true });
    expect(Object.keys(subs)).toEqual([]); // OS?.events?.on?. never registered anything
    const files = window.NovaByteMediaStore.query();
    expect(files.length).toBeGreaterThan(0);
  });

  it('capped break: stops at MAX_RESULTS with pending folders still queued', async () => {
    const nodes = [{ id: 'sub', name: 'sub', type: 'folder' }];
    for (let i = 0; i < 5000; i += 1) {
      nodes.push({ id: `m${i}`, name: `file${i}.png`, type: 'file', mimeType: 'image/png', size: 1, created: 1, modified: i });
    }
    const { window } = await mountWithFS({
      tree: { root: nodes, sub: [] },
      paths: { root: '/r', sub: '/r/sub', dummy: '/r/dummy' },
    });
    const get = (id) => nodes.find((n) => n.id === id);
    window.FS.getPath = (id) => (id === 'root' ? '/r' : id === 'sub' ? '/r/sub' : `/r/${get(id)?.name ?? id}`);
    // query() can return at most 500 rows (Math.min cap), so pin the index
    // size at exactly 5000 through offsets: 4999 → 1 row, 5000 → 0 rows.
    const store = window.NovaByteMediaStore;
    expect(store.query({ limit: 500 })).toHaveLength(500);
    expect(store.query({ offset: 4999, limit: 500 })).toHaveLength(1);
    expect(store.query({ offset: 5000, limit: 500 })).toHaveLength(0);
    // newest first → the last-seen files (modified=i ascending) made the cap
    expect(store.query({ offset: 0, limit: 1 })[0].name).toBe('file4999.png');
    expect(store.query({ offset: 4999, limit: 1 })[0].name).toBe('file0.png');
  });

  it('applies offset/limit, the default limit of 100, and the 500 hard cap', async () => {
    const nodes = [];
    for (let i = 0; i < 600; i += 1) {
      nodes.push({ id: `m${i}`, name: `song${i}.mp3`, type: 'file', size: 1, created: 1, modified: i });
    }
    const { window } = await mountWithFS({
      tree: { root: nodes },
      paths: { root: '/r' },
    });
    window.FS.getPath = (id) => (id === 'root' ? '/r' : `/r/${nodes.find((n) => n.id === id)?.name ?? id}`);
    const store = window.NovaByteMediaStore;
    expect(store.query({ limit: 600 })).toHaveLength(500); // Math.min cap
    expect(store.query({})).toHaveLength(100); // default limit 100 (600 available)
    expect(store.query({ offset: 598, limit: 10 })).toHaveLength(2); // offset near the end
    // desc order is song599..song0, so offset 598 lands on song1, song0
    expect(store.query({ offset: 598, limit: 10 }).map((f) => f.name)).toEqual(['song1.mp3', 'song0.mp3']);
  });

  it('filters by type through the all short-circuit and the per-file match', async () => {
    const { window } = await mountWithFS({ tree: mainTree(), paths: mainPaths() });
    const store = window.NovaByteMediaStore;
    const images = store.query({ type: 'image' });
    for (const f of images) expect(f.type).toBe('image');
    expect(store.query({ type: 'audio' }).every((f) => f.type === 'audio')).toBe(true);
    expect(store.query({ type: 'video' }).length).toBeGreaterThan(0);
  });

  it('rebuilds on the stale-index clock and on fs event callbacks', async () => {
    let listCalls = 0;
    const { window, subs } = await mountWithFS({ tree: mainTree(), paths: mainPaths(), specialFolders: { trash: 'trashid', data: 'dataid' } });
    const realListDir = window.FS.listDir;
    window.FS.listDir = (id) => { listCalls += 1; return realListDir(id); };
    const store = window.NovaByteMediaStore;

    store.query(); // first build (uses the live clock — the service realm's Date
    // is the mirrored jsdom Date, so spy THAT one, not the test realm's)
    const callsAfterFirst = listCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    store.query(); // fresh — no rebuild
    expect(listCalls).toBe(callsAfterFirst);

    // push the service realm's clock past MAX_INDEX_AGE_MS
    const realmNow = window.Date.now();
    const dateSpy = vi.spyOn(window.Date, 'now').mockImplementation(() => realmNow + 31000);
    store.query(); // clock-stale → rebuild
    expect(listCalls).toBeGreaterThan(callsAfterFirst);
    const callsAfterStale = listCalls;
    dateSpy.mockRestore();

    subs['fs:created'](); // real callback marks the index dirty
    store.query(); // dirty → rebuild despite fresh clock
    expect(listCalls).toBeGreaterThan(callsAfterStale);
  });
});
