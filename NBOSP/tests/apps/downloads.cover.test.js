// tests/apps/downloads.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/downloads/app.js. The real app is
// require()d against a real JSDOM window (cover-loader) and driven like a
// user: a live in-memory Downloads History service feeds getAll/remove/
// clearCompleted/subscribe, rows are clicked, the toolbar is used, locale
// switches replay the render, and every formatting branch (sizes, dates,
// statuses, names, tooltips) is exercised through the rendered DOM.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { coverLoadWindowApp, initCoveredApp, settle } from '../helpers/cover-loader.js';

// Builds a fake Downloads History system service with an in-memory store so
// the app's real subscribe/render/remove code paths run against live data
// (same contract the OS service exposes to the app).
function makeDownloadsService(initial = []) {
  const items = [...initial];
  const svc = {
    listeners: new Set(),
    getAll: () => [...items],
    remove: (id) => {
      const idx = items.findIndex((x) => String(x.id) === String(id));
      if (idx > -1) items.splice(idx, 1);
      svc.emit();
    },
    clearCompleted: () => {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].status === 'done') items.splice(i, 1);
      }
      svc.emit();
    },
    subscribe: (cb) => {
      svc.listeners.add(cb);
      return () => svc.listeners.delete(cb);
    },
    emit: () => { for (const cb of [...svc.listeners]) cb(); },
  };
  return svc;
}

// Event-bus stub the OS facade exposes; captured handlers let tests fire
// languageChanged exactly like the shell does.
function makeEventBus() {
  const handlers = {};
  return {
    on: vi.fn((t, h) => { handlers[t] = h; return () => delete handlers[t]; }),
    off: vi.fn(),
    handlers,
  };
}

async function mountDownloads({ svc, state, os, init = true } = {}) {
  // OS is mirrored onto globalThis for the Node-realm app; without this the
  // previous test's OS stub would leak into "no OS" mounts.
  if (!os) { delete globalThis.OS; delete globalThis.window?.OS; }
  const ctx = await coverLoadWindowApp('downloads', {
    stubs: { extra: { ...(svc ? { Downloads: svc } : {}), ...(os ? { OS: os } : {}) } },
  });
  // base-utils installs its helpers on the jsdom window; mirror the couple
  // the app resolves as bare globals in the Node realm (same job the
  // cover-loader's mirrorI18nGlobals does for _t/createEl/formatBytes).
  for (const key of ['svgIcon']) {
    if (ctx.window[key] && !globalThis[key]) globalThis[key] = ctx.window[key];
  }
  const content = init ? initCoveredApp(ctx.app, { state: state ?? {} }) : null;
  return { ...ctx, content };
}

describe('Downloads app (js/apps/downloads/app.js) — e2e coverage', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.resetModules();
  });
  afterEach(() => vi.restoreAllMocks());

  it('registers a full app descriptor with the host', async () => {
    const { app } = await mountDownloads({ svc: makeDownloadsService([]) });
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.nbosp.downloads');
    expect(app.name).toBe('Downloads');
    expect(app.version).toBe('3.0.2');
    expect(app.description).toBe('Download Manager');
    expect(app.icon).toBe('download');
    expect(app.defaultSize).toEqual([580, 460]);
    expect(app.minSize).toEqual([400, 300]);
    expect(typeof app.init).toBe('function');
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const ctx = await coverLoadWindowApp('downloads', { stubs: { AppDirs: null, extra: { Downloads: makeDownloadsService([]) } } });
    const content = initCoveredApp(ctx.app, { state: {} });
    expect(content.textContent).toContain('App data directory missing.');
    expect(content.textContent).toContain('com.nbosp.downloads');
    expect(content.textContent).toContain('This app requires NovaByte OS.');
    // The fallback path returns before any list UI is built.
    expect(content.querySelector('[role="list"]')).toBeNull();
  });

  it('hard-fails at init when the Downloads History service is unavailable', async () => {
    const { app } = await mountDownloads({ init: false }); // no window.Downloads installed
    // The Error class inside app.js is the mirrored jsdom one, so match the
    // message rather than the class (same trick the legacy suite uses).
    let caught = null;
    try { initCoveredApp(app, { state: {} }); } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(String(caught?.message)).toBe('Downloads History system service is unavailable');
  });

  it('renders the empty state and the toolbar with a Clear button', async () => {
    const { content } = await mountDownloads({ svc: makeDownloadsService([]) });
    const toolbar = content.querySelector('[style*="border-bottom"]');
    expect(toolbar.textContent).toContain('Downloads');
    const buttons = [...content.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toContain('Clear completed');
    expect(content.querySelector('[role="list"]').getAttribute('aria-label')).toBe('Downloads');
    expect(content.textContent).toContain('No downloads yet');
    expect(content.textContent).toContain('Files saved from the browser appear here');
    expect(content.querySelector('.dl-row')).toBeNull();
  });

  it('renders one row per download: statuses, sizes, dates, tooltips and aria labels', async () => {
    const ts = new Date('2024-03-01T12:00:00Z').getTime();
    const svc = makeDownloadsService([
      { id: 'd1', name: 'report.pdf', size: 2048, status: 'done', ts, url: 'https://example.com/report.pdf' },
      { id: 'd2', name: 'installer.exe', size: 5 * 1024 * 1024, status: 'failed', ts },
      { id: 'd3', name: 'stream.bin', size: 512, status: 'downloading', ts },
      { id: 'd4', name: 'weird.iso', size: 1024, status: 'corrupted', ts }, // unknown status → done styling
      { id: 'd5', name: 'no-size.txt', status: 'done', ts: 0 },             // !ts → size-only meta line
    ]);
    const { content } = await mountDownloads({
      svc,
      os: { settings: { get: (k) => (k === 'region' ? 'en-US' : k === 'timezone' ? 'UTC' : undefined) } },
    });
    const rows = [...content.querySelectorAll('.dl-row')];
    expect(rows).toHaveLength(5);

    const [pdf, exe, bin, iso, txt] = rows;
    expect(pdf.textContent).toContain('report.pdf');
    expect(pdf.textContent).toContain('2.0 KB');
    expect(pdf.textContent).toContain('done');
    expect(pdf.title).toBe('https://example.com/report.pdf');
    const del = pdf.querySelector('[data-del]');
    expect(del.dataset.del).toBe('d1');
    expect(del.getAttribute('aria-label')).toBe('Remove report.pdf');

    expect(exe.textContent).toContain('5.0 MB');
    expect(exe.textContent).toContain('failed');
    expect(exe.title).toBe(''); // no url → no tooltip

    expect(bin.textContent).toContain('512 B');
    expect(bin.textContent).toContain('downloading');

    // Unknown statuses fall back to the "done" style but keep their label.
    expect(iso.textContent).toContain('corrupted');
    expect(iso.textContent).toContain('1.0 KB');

    // ts:0 is falsy → no date in the meta line, size still rendered.
    expect(txt.textContent).toContain('no-size.txt');
    expect(txt.textContent).toContain('—'); // missing size → placeholder
    expect(txt.textContent).not.toContain('12:00');

    // Every row renders a date through the cached en-US/UTC formatter
    // (first row builds it, the rest hit the cache).
    expect(pdf.textContent).toMatch(/Mar 1/);
  });

  it('falls back to the navigator locale when the OS reports no region, and survives corrupt timestamps', async () => {
    const svc = makeDownloadsService([
      // region unset → navigator.language; timezone unset → no timeZone option.
      { id: 'n1', name: 'nav-locale.bin', size: 8, status: 'done', ts: 1710000000000 },
      // A truthy-but-unparseable timestamp → Invalid Date → formatter throws
      // → fmtDate catch returns '' (no date in the meta line).
      { id: 'n2', name: 'corrupt-ts.bin', size: 9, status: 'done', ts: 'not-a-date' },
      // No status at all → badge falls back to the "done" label.
      { id: 'n3', name: 'no-status.bin', size: 7 },
    ]);
    const { content } = await mountDownloads({
      svc,
      os: { settings: { get: () => undefined } },
    });
    const rows = [...content.querySelectorAll('.dl-row')];
    expect(rows[0].textContent).toMatch(/Mar/); // navigator.language formatter
    expect(rows[1].textContent).toContain('corrupt-ts.bin');
    expect(rows[1].textContent).not.toMatch(/Mar/); // corrupt date swallowed
    expect(rows[2].textContent).toContain('done');   // status ?? 'done'
  });

  it('uses the navigator locale and no timezone when no OS is present at all', async () => {
    const svc = makeDownloadsService([
      { id: 'x1', name: 'plain.bin', size: 3, status: 'failed', ts: 1710000000000 },
      { id: 'x2', name: 'plain2.bin', size: 4, status: 'failed', ts: 1710000000000 },
    ]);
    const { content } = await mountDownloads({ svc }); // no OS global
    const rows = [...content.querySelectorAll('.dl-row')];
    expect(rows[0].textContent).toMatch(/Mar/);
    expect(rows[1].textContent).toMatch(/Mar/); // second row hits the formatter cache
  });

  it('caps oversized URLs in the row tooltip at 2048 characters', async () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(4000);
    const svc = makeDownloadsService([{ id: 'big', name: 'big.zip', size: 10, status: 'done', url: longUrl }]);
    const { content } = await mountDownloads({ svc });
    const row = content.querySelector('.dl-row');
    expect(row.title).toHaveLength(2048);
    expect(row.title.startsWith('https://example.com/')).toBe(true);
  });

  it('formats edge-case sizes and names: 0 B shows, nullish names fall back, invalid locales fall back', async () => {
    const svc = makeDownloadsService([
      { id: 'z0', name: null, size: 0, status: 'done', ts: 1710000000000 },
      { id: 'z1', name: '', size: -5, status: 'done', ts: 1710000000000 },
      { id: 'z2', name: 'no-size', status: 'done' },
    ]);
    const { content } = await mountDownloads({
      svc,
      // Invalid region → Intl.DateTimeFormat throws → the catch rebuilds a
      // default-locale formatter; undefined timezone → opts.timeZone omitted.
      os: { settings: { get: (k) => (k === 'region' ? 'not-a-locale!' : undefined) } },
    });
    const rows = [...content.querySelectorAll('.dl-row')];
    expect(rows[0].textContent).toContain('(unnamed)'); // nullish → fallback
    expect(rows[0].textContent).toContain('0 B');        // 0 is a number
    expect(rows[1].textContent).not.toContain('(unnamed)'); // '' is not nullish
    expect(rows[1].textContent).toContain('—');          // negative size → placeholder
    expect(rows[2].textContent).toContain('no-size');
    expect(rows[2].textContent).toContain('—');          // missing size → placeholder
    // The fallback formatter still renders a date for ts items.
    expect(rows[0].textContent).toMatch(/, /); // "Mar 9, 6:40 PM" shape
  });

  it('deletes a download via the row button and keeps clicks on the row itself inert', async () => {
    const svc = makeDownloadsService([
      { id: 'keep-me', name: 'keep.txt', size: 10, status: 'downloading' },
      { id: 'gone-1', name: 'a.zip', size: 10, status: 'done' },
      { id: 'gone-2', name: 'b.zip', size: 10, status: 'done' },
    ]);
    const { content } = await mountDownloads({ svc });

    // A click that resolves to no [data-del] ancestor is a no-op.
    content.querySelectorAll('.dl-row')[0].click();

    const rowA = [...content.querySelectorAll('.dl-row')].find((r) => r.textContent.includes('a.zip'));
    rowA.querySelector('[data-del]').click();
    expect(content.querySelectorAll('.dl-row')).toHaveLength(2);
    expect([...content.querySelectorAll('.dl-row')].some((r) => r.textContent.includes('a.zip'))).toBe(false);
    expect([...content.querySelectorAll('.dl-row')].some((r) => r.textContent.includes('keep.txt'))).toBe(true);

    // "Clear completed" removes every done item but keeps the active one.
    const clearBtn = [...content.querySelectorAll('button')].find((b) => b.textContent === 'Clear completed');
    clearBtn.click();
    await settle();
    const remaining = [...content.querySelectorAll('.dl-row')];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].textContent).toContain('keep.txt');
    expect(remaining[0].textContent).toContain('downloading');
  });

  it('live-renders when the service notifies subscribers and unsubscribes on cleanup', async () => {
    const svc = makeDownloadsService([]);
    const state = { cleanups: [] };
    const { content } = await mountDownloads({ svc, state });
    expect(content.textContent).toContain('No downloads yet');

    // External service change → subscribe callback → re-render.
    svc.getAll = () => [{ id: 'live', name: 'live-file.iso', size: 4096, status: 'downloading' }];
    svc.emit();
    expect(content.querySelectorAll('.dl-row')).toHaveLength(1);
    expect(content.textContent).toContain('live-file.iso');

    // The subscription was registered as a window-manager cleanup.
    const unsubscribe = state.cleanups[0];
    expect(typeof unsubscribe).toBe('function');
    unsubscribe(); // app window closed — listener removed
    expect(svc.listeners.size).toBe(0);
    // After unsubscribing the app no longer re-renders: the store is emptied
    // and the service emits, but the DOM keeps showing the stale last render.
    svc.getAll = () => [];
    svc.emit();
    expect(content.querySelectorAll('.dl-row')).toHaveLength(1);
    expect(content.textContent).toContain('live-file.iso');
  });

  it('creates its own cleanups array when the state arrives without one', async () => {
    const svc = makeDownloadsService([]);
    const state = {};
    await mountDownloads({ svc, state });
    expect(Array.isArray(state.cleanups)).toBe(true);
    expect(state.cleanups.length).toBeGreaterThanOrEqual(1);
  });

  it('relabels the toolbar and re-renders when the OS language changes', async () => {
    const events = makeEventBus();
    const svc = makeDownloadsService([{ id: 'x', name: 'x.bin', size: 1, status: 'done' }]);
    const { content, window } = await mountDownloads({
      svc,
      os: { events, settings: { get: () => undefined } },
    });
    expect(events.on).toHaveBeenCalledWith('languageChanged', expect.any(Function));

    // Re-render succeeds: labels are re-derived and the list rebuilt.
    events.handlers.languageChanged();
    expect(content.querySelector('[role="list"]').getAttribute('aria-label')).toBe('Downloads');
    expect(content.querySelectorAll('.dl-row')).toHaveLength(1);
    expect(content.textContent).toContain('Clear completed');

    // A broken i18n engine must not take the window down — warn and continue.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const apply = window.NovaI18n.applyStaticDom;
    window.NovaI18n.applyStaticDom = () => { throw new Error('boom'); };
    try {
      events.handlers.languageChanged();
      expect(warn).toHaveBeenCalledWith('[Downloads] Language change re-render failed:', expect.any(Error));
    } finally {
      window.NovaI18n.applyStaticDom = apply;
    }

    // Window teardown unregisters the locale listener.
    events.handlers.languageChanged(); // still healthy path after restore
    expect(events.off).not.toHaveBeenCalled();
  });

  it('unregisters the locale handler on cleanup, and registers none without an OS event bus', async () => {
    const events = makeEventBus();
    const svc = makeDownloadsService([]);
    const state = { cleanups: [] };
    await mountDownloads({ svc, state, os: { events } });
    // First cleanup is the service unsubscribe; the second is the locale off().
    state.cleanups.forEach((c) => c());
    expect(events.off).toHaveBeenCalledWith('languageChanged', expect.any(Function));
    expect(svc.listeners.size).toBe(0);

    // Without an OS at all the app still works; the locale registration is
    // skipped and cleanup is a no-op.
    const bare = await mountDownloads({ svc });
    expect(bare.content.textContent).toContain('No downloads yet');
  });
});
