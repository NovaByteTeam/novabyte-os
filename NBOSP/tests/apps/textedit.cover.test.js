// tests/apps/textedit.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/textedit/app.js.
//
// The app has two personalities and both are driven end-to-end here against
// a real JSDOM document through the cover-loader:
//
//  • initLinuxTextEdit() — the trusted-host (NW.js/Linux) path. It runs by
//    default in the Node realm because `process` exists there and
//    process.platform === 'linux' on this box. Its file I/O is the REAL
//    node fs module, so saves/opens hit real temp files; SystemDialogs and
//    Notify are stubbed at the OS boundary only.
//
//  • the main browser path (lines 145-681) — reachable only when
//    process.platform !== 'linux', so these mounts temporarily override
//    process.platform ('win32') for the duration of the init call. The
//    textarea is a REAL jsdom textarea; every keystroke is a real
//    KeyboardEvent. Two host-API gaps are accommodated (not mocked app
//    logic): document.execCommand is absent in jsdom, and jsdom's
//    setRangeText rejects the app's non-standard 'ignore' SelectionMode —
//    a wrapper maps 'ignore'→'preserve' and delegates everything else to
//    the real implementation.
//
//  • onDrop() — both branches (linux fs write + fs/WM import), including
//    the real EEXIST failure from a second 'wx' write.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { coverLoadWindowApp, settle } from '../helpers/cover-loader.js';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeOs from 'node:os';

const REAL_PLATFORM = process.platform;
// Node 24 ships process.platform as writable:false (configurable:true), so a
// plain assignment throws — swap it with defineProperty instead.
function setPlatform(p) {
  Object.defineProperty(process, 'platform', { value: p, writable: true, configurable: true, enumerable: true });
}
async function withPlatform(p, fn) {
  const prev = process.platform;
  setPlatform(p);
  try { return await fn(); } finally { setPlatform(prev); }
}
const WRAP_KEY = 'nbosp.textedit.wordWrap';
const HOME_DROP_NAME = 'nv-w2-textedit-drop.txt';

// ── OS-boundary stubs ──────────────────────────────────────────────────────
function makeNotify() {
  const calls = [];
  return { calls, show: vi.fn((n) => { calls.push(n); }) };
}

// Linux-style dialogs resolve { path } (the NW.js host hands back paths).
function makeLinuxDialogs({ saveResult, openResult, saveImpl, openImpl } = {}) {
  return {
    saveCalls: [],
    save: vi.fn(async (opts) => { void opts; return saveResult ?? null; }),
    open: vi.fn(async (opts) => { void opts; return openResult ?? null; }),
  };
}

// Main-path dialogs resolve file nodes.
function makeDialogs({ saveResult, openResult } = {}) {
  return {
    save: vi.fn(async (opts) => {
      if (saveResult instanceof Error) throw saveResult;
      return saveResult ?? null;
    }),
    open: vi.fn(async (opts) => {
      if (openResult instanceof Error) throw openResult;
      return openResult ?? null;
    }),
  };
}

function makeFS() {
  const writes = [];
  const created = [];
  const writeErrors = [];
  const createErrors = [];
    const files = new Map([
      ['f1', { id: 'f1', name: 'hello.txt', type: 'file', content: 'seeded file body', mimeType: 'text/plain' }],
      ['f2', { id: 'f2', name: 'no-content.txt', type: 'file', mimeType: 'text/plain' }],
    ]);
      return {
    writes, created, files, writeErrors, createErrors,
    specialFolders: { documents: 'docs-folder' },
    writeFile: vi.fn((id, content) => {
      writes.push([id, content]);
      const e = writeErrors.shift();
      if (e) return Promise.reject(e);
      return Promise.resolve(true);
    }),
    createFile: vi.fn(async (folderId, name, content, mime) => {
      created.push([folderId, name, content, mime]);
      const e = createErrors.shift();
      if (e) throw e;
      return { id: 'new-' + (created.length), name };
    }),
  };
}

function makeEventBus() {
  const handlers = {};
  return {
    on: vi.fn((t, h) => { handlers[t] = h; return () => delete handlers[t]; }),
    off: vi.fn(),
    handlers,
  };
}

function makeResizeObserverStub() {
  const calls = { disconnect: 0 };
  class RO {
    constructor(cb) { this.cb = cb; cb(); } // fire once at observe-time, like a real layout pass
    observe() { this.cb(); }
    unobserve() {}
    disconnect() { calls.disconnect++; }
  }
  return { RO, calls };
}

// Bare globals in the Node realm leak between mounts (mirrorStubs only
// mirrors keys the current mount passed); purge them after every test.
const PURGE_KEYS = ['OS', 'WM', 'FS', 'SystemDialogs', 'Notify', 'ContextMenu', 'renderDesktopIcons', 'NovaAppConfig', 'renderLaunchpad'];
function purgeGlobals() {
  for (const k of PURGE_KEYS) { try { delete globalThis[k]; } catch { /* non-configurable */ } }
}

async function mountTextedit({
  platform, // undefined = real platform (linux on this box)
  state,
  options,
  dialogs, notify, fs, os, wm, contextMenu, novaAppConfig, renderDesktopIcons,
  appDirs, // extra.AppDirs override (see the getFilesDir fallback test)
  noAppDirs = false, // stubs: { AppDirs: null }
  seedWrap,
  resizeObserver,
} = {}) {
  if (platform) setPlatform(platform);
  const stubs = {};
  if (noAppDirs) stubs.AppDirs = null;
  const ctx = await coverLoadWindowApp('textedit', {
    stubs: {
      ...stubs,
      extra: {
        SystemDialogs: dialogs ?? makeLinuxDialogs(),
        Notify: notify ?? makeNotify(),
        ...(fs ? { FS: fs } : {}),
        ...(os ? { OS: os } : {}),
        ...(wm ? { WM: wm } : {}),
        ...(contextMenu ? { ContextMenu: contextMenu } : {}),
        ...(novaAppConfig ? { NovaAppConfig: novaAppConfig } : {}),
        ...(renderDesktopIcons ? { renderDesktopIcons } : {}),
        ...(appDirs ? { AppDirs: appDirs } : {}),
        ...(resizeObserver ? { ResizeObserver: resizeObserver.RO } : {}),
      },
    },
  });
  // jsdom has no execCommand at all — the host API the app falls back to.
  if (typeof ctx.document.execCommand !== 'function') {
    ctx.document.execCommand = vi.fn(() => false);
  }
  // The Node-realm app reads the bare (setup.js) localStorage, so seed there.
  if (seedWrap) localStorage.setItem(WRAP_KEY, seedWrap);
  return ctx;
}

// Run a registered app's init() the way the window manager does, with the
// launch options (3rd arg) the harness' initCoveredApp cannot forward.
function launch(ctx, { state, options } = {}) {
  const content = ctx.document.createElement('div');
  ctx.app.init(content, state ?? { cleanups: [] }, options);
  return content;
}

// jsdom's setRangeText rejects the app's non-standard 'ignore' mode; map it
// onto 'preserve' and delegate everything else to the real implementation.
function tolerateIgnoreMode(textarea) {
  const orig = textarea.setRangeText.bind(textarea);
  textarea.setRangeText = (text, start, end, mode) =>
    orig(text, start, end, mode === 'ignore' ? 'preserve' : mode);
  return textarea;
}

const linuxStatusOf = (content) => content.querySelector('[role="status"]');
const linuxEditorOf = (content) => content.querySelector('textarea');
const btnOf = (content, text) =>
  [...content.querySelectorAll('button')].find((b) => b.textContent === text);

function typeKey(ctx, target, init) {
  target.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

describe('TextEdit app (js/apps/textedit/app.js) — e2e coverage', () => {
  let TMP = '';
  beforeEach(() => {
    resetTestStorage();
    vi.resetModules();
    TMP = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'nv-te-cover-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setPlatform(REAL_PLATFORM);
    purgeGlobals();
    nodeFs.rmSync(TMP, { recursive: true, force: true });
    nodeFs.rmSync(nodePath.join(nodeOs.homedir(), HOME_DROP_NAME), { force: true });
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText?.mockReset?.();
      navigator.clipboard.readText?.mockReset?.();
    }
  });

  // ── descriptor + linux host path ────────────────────────────────────────
  it('registers a full app descriptor with the host', async () => {
    const { app } = await mountTextedit();
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.nbosp.textedit');
    expect(app.name).toBe('TextEdit');
    expect(app.version).toBe('3.0.2');
    expect(app.description).toBe('Text Editor');
    expect(app.icon).toBe('pen-tool');
    expect(app.defaultSize).toEqual([680, 500]);
    expect(app.minSize).toEqual([360, 260]);
    expect(typeof app.init).toBe('function');
    expect(typeof app.onDrop).toBe('function');
  });

  it('linux host: renders toolbar, editor and untitled status; typing marks modified', async () => {
    const ctx = await mountTextedit();
    const content = launch(ctx, {});
    const editor = linuxEditorOf(content);
    expect(editor).toBeTruthy();
    expect(editor.getAttribute('aria-label')).toBe('Text editor');
    expect([...content.querySelectorAll('button')].map((b) => b.textContent))
      .toEqual(['Open…', 'Save', 'Save As…']);
    expect(linuxStatusOf(content).textContent).toBe('Untitled');

    editor.value = 'hello';
    editor.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
    expect(linuxStatusOf(content).textContent).toBe('Untitled • Modified');
  });

  it('linux host: resolves launch options path/filePath/absolute fileId to the status name', async () => {
    // Real files so the async initial read settles within the test; the
    // status name is the basename once the load completes.
    const a = nodePath.join(TMP, 'a.txt');
    const b = nodePath.join(TMP, 'b.txt');
    const c = nodePath.join(TMP, 'c.txt');
    nodeFs.writeFileSync(a, 'a', 'utf8');
    nodeFs.writeFileSync(b, 'b', 'utf8');
    nodeFs.writeFileSync(c, 'c', 'utf8');
    const cases = [
      [{ path: a }, 'a.txt'],
      [{ filePath: b }, 'b.txt'],
      [{ fileId: c }, 'c.txt'],
      [{ fileId: 'folder-node' }, 'Untitled'],
      [{}, 'Untitled'],
    ];
    for (const [options, expected] of cases) {
      const ctx = await mountTextedit();
      const content = launch(ctx, { options });
      await settle();
      expect(linuxStatusOf(content).textContent).toContain(expected);
    }
  });

  it('linux host: initialContent branch seeds the editor (string and null)', async () => {
    const ctx = await mountTextedit();
    const content = launch(ctx, { options: { initialContent: 'seed text' } });
    expect(linuxEditorOf(content).value).toBe('seed text');

    const ctx2 = await mountTextedit();
    const content2 = launch(ctx2, { options: { initialContent: null } });
    expect(linuxEditorOf(content2).value).toBe('');
    expect(linuxStatusOf(content2).textContent).toBe('Untitled');
  });

  it('linux host: initial load by currentPath — real fs read, and failure warns + notifies', async () => {
    const file = nodePath.join(TMP, 'initial.txt');
    nodeFs.writeFileSync(file, 'loaded from disk', 'utf8');
    const ctx = await mountTextedit({ dialogs: makeLinuxDialogs() });
    const content = launch(ctx, { options: { path: file } });
    await settle();
    expect(linuxEditorOf(content).value).toBe('loaded from disk');
    expect(linuxStatusOf(content).textContent).toBe('initial.txt');

    const notify = makeNotify();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx2 = await mountTextedit({
      notify,
      dialogs: makeLinuxDialogs(),
    });
    const content2 = launch(ctx2, { options: { path: nodePath.join(TMP, 'missing.txt') } });
    await settle();
    expect(linuxEditorOf(content2).value).toBe('');
    // NOTE: the Node-realm `Error` global is the mirrored jsdom class after a
    // mount, so match shape (code/message) rather than the class identity.
    expect(errSpy).toHaveBeenCalledWith('[TextEdit] Could not open requested file:',
      expect.objectContaining({ code: 'ENOENT' }));
    expect(notify.calls.some((n) => n.title === 'Open failed' && n.body)).toBe(true);
  });

  it('linux host: save with no path opens Save dialog, writes a real file, clears modified', async () => {
    const target = nodePath.join(TMP, 'saved.txt');
    const dialogs = makeLinuxDialogs({ saveResult: { path: target } });
    const notify = makeNotify();
    const ctx = await mountTextedit({ dialogs, notify });
    const content = launch(ctx, {});
    const editor = linuxEditorOf(content);

    editor.value = 'linux body';
    editor.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
    expect(linuxStatusOf(content).textContent).toContain('• Modified');

    btnOf(content, 'Save').click();
    await settle();
    expect(dialogs.save).toHaveBeenCalledWith({
      title: 'Save As', suggestedName: 'untitled.txt', startPath: nodeOs.homedir(),
    });
    expect(nodeFs.readFileSync(target, 'utf8')).toBe('linux body');
    expect(linuxStatusOf(content).textContent).toBe('saved.txt');
    expect(notify.calls).toContainEqual(expect.objectContaining({ title: 'Saved', body: 'saved.txt', type: 'success' }));

    // Second save goes straight to the current path — no new dialog.
    editor.value = 'linux body v2';
    editor.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
    typeKey(ctx, editor, { key: 's', ctrlKey: true }); // Ctrl+S keyboard save
    await settle();
    expect(dialogs.save).toHaveBeenCalledTimes(1);
    expect(nodeFs.readFileSync(target, 'utf8')).toBe('linux body v2');
  });

  it('linux host: save failures — ENOENT write surfaces Save failed; dialog cancel is a no-op', async () => {
    const notify = makeNotify();
    const dialogs = makeLinuxDialogs({
      saveResult: { path: nodePath.join(TMP, 'no-such-dir', 'x.txt') },
    });
    const ctx = await mountTextedit({ dialogs, notify });
    const content = launch(ctx, {});
    linuxEditorOf(content).value = 'will fail';
    btnOf(content, 'Save').click();
    await settle();
    const fail = notify.calls.find((n) => n.title === 'Save failed');
    expect(fail).toBeTruthy();
    expect(fail.body).toMatch(/ENOENT|no such file/i);
    expect(fail.type).toBe('error');

    // User cancels the dialog → target null → nothing happens.
    const cancelDialogs = makeLinuxDialogs({ saveResult: null });
    const ctx2 = await mountTextedit({ dialogs: cancelDialogs, notify });
    const content2 = launch(ctx2, {});
    btnOf(content2, 'Save').click();
    await settle();
    expect(cancelDialogs.save).toHaveBeenCalledTimes(1);
    expect(linuxStatusOf(content2).textContent).toBe('Untitled');
    expect(notify.calls.filter((n) => n.title === 'Saved')).toHaveLength(0);
  });

  it('linux host: Save As… after a save re-uses dialog with basename + dirname', async () => {
    const first = nodePath.join(TMP, 'one.txt');
    const second = nodePath.join(TMP, 'two.txt');
    const dialogs = makeLinuxDialogs({ saveResult: { path: first } });
    const notify = makeNotify();
    const ctx = await mountTextedit({ dialogs, notify });
    const content = launch(ctx, {});
    linuxEditorOf(content).value = 'v1';
    btnOf(content, 'Save').click();
    await settle();

    dialogs.save.mockImplementation(async () => ({ path: second }));
    btnOf(content, 'Save As…').click();
    await settle();
    expect(dialogs.save).toHaveBeenLastCalledWith({
      title: 'Save As', suggestedName: 'one.txt', startPath: TMP,
    });
    expect(nodeFs.readFileSync(second, 'utf8')).toBe('v1');
    expect(linuxStatusOf(content).textContent).toBe('two.txt');
    expect(notify.calls.filter((n) => n.title === 'Saved')).toHaveLength(2);
  });

  it('linux host: open via dialog — real fs read; failure + cancel', async () => {
    const file = nodePath.join(TMP, 'openable.txt');
    nodeFs.writeFileSync(file, 'opened content', 'utf8');
    const dialogs = makeLinuxDialogs({ openResult: { path: file } });
    const notify = makeNotify();
    const ctx = await mountTextedit({ dialogs, notify });
    const content = launch(ctx, {});
    btnOf(content, 'Open…').click();
    await settle();
    expect(dialogs.open).toHaveBeenCalledWith({ title: 'Open File', startPath: nodeOs.homedir() });
    expect(linuxEditorOf(content).value).toBe('opened content');
    expect(linuxStatusOf(content).textContent).toBe('openable.txt');

    // Read failure → Open failed notification.
    const failDialogs = makeLinuxDialogs({ openResult: { path: nodePath.join(TMP, 'gone.txt') } });
    const ctx2 = await mountTextedit({ dialogs: failDialogs, notify });
    const content2 = launch(ctx2, {});
    btnOf(content2, 'Open…').click();
    await settle();
    expect(notify.calls.some((n) => n.title === 'Open failed' && n.body)).toBe(true);
    expect(linuxEditorOf(content2).value).toBe('');

    // Cancel → returns before any read.
    const cancelDialogs = makeLinuxDialogs({ openResult: null });
    const ctx3 = await mountTextedit({ dialogs: cancelDialogs, notify });
    const content3 = launch(ctx3, {});
    btnOf(content3, 'Open…').click();
    await settle();
    expect(cancelDialogs.open).toHaveBeenCalledTimes(1);
    expect(notify.calls.filter((n) => n.title === 'Open failed')).toHaveLength(1);
  });

  it('linux host: keyboard save (Ctrl/Cmd+S, Ctrl+Shift+S) and inert keys', async () => {
    const target = nodePath.join(TMP, 'kbd.txt');
    const dialogs = makeLinuxDialogs({ saveResult: { path: target } });
    const ctx = await mountTextedit({ dialogs });
    const content = launch(ctx, {});
    const editor = linuxEditorOf(content);
    editor.value = 'kbd';

    typeKey(ctx, editor, { key: 'S', ctrlKey: true }); // 'S'.toLowerCase() === 's'
    await settle();
    expect(nodeFs.readFileSync(target, 'utf8')).toBe('kbd');

    editor.value = 'kbd2';
    typeKey(ctx, editor, { key: 's', metaKey: true, shiftKey: true }); // Save As via Cmd+Shift+S
    await settle();
    expect(dialogs.save).toHaveBeenCalledTimes(2);
    expect(linuxStatusOf(content).textContent).toBe('kbd.txt');

    // Plain keys with no modifiers do nothing.
    const before = dialogs.save.mock.calls.length;
    typeKey(ctx, editor, { key: 's' });
    typeKey(ctx, editor, { key: 'x', ctrlKey: true });
    await settle();
    expect(dialogs.save.mock.calls.length).toBe(before);
  });

  it('linux host: language change relabels; broken/absent i18n warn; cleanup offs + aborts listeners', async () => {
    const events = makeEventBus();
    const os = { events };
    const state = { cleanups: [] };
    const ctx = await mountTextedit({ os });
    const content = launch(ctx, { state });
    expect(events.on).toHaveBeenCalledWith('languageChanged', expect.any(Function));

    events.handlers.languageChanged();
    expect(btnOf(content, 'Open…').textContent).toBe('Open…');
    expect(linuxEditorOf(content).getAttribute('aria-label')).toBe('Text editor');

    // applyStaticDom throwing must not take the window down.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const apply = ctx.window.NovaI18n.applyStaticDom;
    ctx.window.NovaI18n.applyStaticDom = () => { throw new Error('boom'); };
    events.handlers.languageChanged();
    expect(warn).toHaveBeenCalledWith('[TextEdit] Language change re-render failed:', expect.any(Error));
    ctx.window.NovaI18n.applyStaticDom = apply;

    // NovaI18n/applyStaticDom absent → optional chaining skips, relabel still runs.
    ctx.window.NovaI18n = null;
    events.handlers.languageChanged();
    ctx.window.NovaI18n = { applyStaticDom: apply, registerResources() {} };
    events.handlers.languageChanged();
    expect(warn).toHaveBeenCalledTimes(1);

    state.cleanups.forEach((c) => c());
    expect(events.off).toHaveBeenCalledWith('languageChanged', expect.any(Function));

    // controller.abort() removed the button and keyboard listeners: a save
    // attempt no longer reaches the dialog.
    const deadDialogs = makeLinuxDialogs({ saveResult: { path: nodePath.join(TMP, 'dead.txt') } });
    ctx.window.SystemDialogs = deadDialogs;
    globalThis.SystemDialogs = deadDialogs;
    linuxEditorOf(content).value = 'after abort';
    btnOf(content, 'Save').click();
    typeKey(ctx, linuxEditorOf(content), { key: 's', ctrlKey: true });
    await settle();
    expect(deadDialogs.save).not.toHaveBeenCalled();
    expect(linuxStatusOf(content).textContent).not.toContain('dead.txt');
  });

  it('linux host: no OS event bus → registration and cleanup are skipped silently', async () => {
    const ctx = await mountTextedit(); // no OS passed → typeof OS undefined after purge
    // state WITHOUT a cleanups array → the `: []` arm of the ternary creates one.
    const state = {};
    const content = launch(ctx, { state });
    expect(linuxStatusOf(content).textContent).toBe('Untitled');
    state.cleanups.forEach((c) => c()); // off() no-op path
    expect(Array.isArray(state.cleanups)).toBe(true);
    expect(state.cleanups.length).toBeGreaterThanOrEqual(2);
    expect(linuxEditorOf(content).value).toBe('');
  });

  // ── main browser path (process.platform overridden) ─────────────────────
  it('main path: shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const ctx = await mountTextedit({ platform: 'win32', noAppDirs: true });
    const content = launch(ctx, {});
    expect(content.textContent).toContain('App data directory missing.');
    expect(content.textContent).toContain('This app requires NovaByte OS.');
    expect(content.querySelector('b').textContent).toBe('com.nbosp.textedit');
    expect(typeof content._destroy).toBe('function');
    expect(() => content._destroy()).not.toThrow();
  });

  it('main path: renders editor shell, gutter, status bar and toolbar', async () => {
    const ro = makeResizeObserverStub();
    const ctx = await mountTextedit({ platform: 'win32', resizeObserver: ro });
    const content = launch(ctx, {});
    const editor = tolerateIgnoreMode(content.querySelector('#quill-text-editor'));
    expect(btnOf(content, 'Save')).toBeTruthy();
    expect(btnOf(content, 'Save As…')).toBeTruthy();
    expect(btnOf(content, 'Open…')).toBeTruthy();
    expect(btnOf(content, 'Word Wrap')).toBeTruthy();
    expect(editor.getAttribute('aria-label')).toBe('Text editor');
    expect(editor.getAttribute('wrap')).toBe('off');
    expect(btnOf(content, 'Word Wrap').getAttribute('aria-pressed')).toBe('false');
    expect(content.querySelector('.quill-statusbar').textContent).toBe('Ln 1, Col 1  ·  0 words');
    expect(content.querySelector('.quill-gutter').textContent).toBe('1');
    await settle(60);
  });

  it('main path: typing updates status/gutter via rAF; click and keyup move the caret', async () => {
    const ctx = await mountTextedit({ platform: 'win32' });
    const content = launch(ctx, {});
    const editor = tolerateIgnoreMode(content.querySelector('#quill-text-editor'));

    editor.value = 'alpha beta\ngamma\ndelta';
    editor.setSelectionRange(17, 17);
    editor.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
    await settle(60);
    expect(content.querySelector('.quill-statusbar').textContent).toBe('Ln 3, Col 1  ·  4 words');
    expect(content.querySelector('.quill-gutter').textContent).toBe('1\n2\n3');

    editor.setSelectionRange(6, 6);
    editor.dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
    expect(content.querySelector('.quill-statusbar').textContent).toBe('Ln 1, Col 7  ·  4 words');

    editor.setSelectionRange(12, 12);
    editor.dispatchEvent(new ctx.window.Event('keyup', { bubbles: true }));
    expect(content.querySelector('.quill-statusbar').textContent).toBe('Ln 2, Col 2  ·  4 words');

    // Scroll syncs the gutter.
    editor.dispatchEvent(new ctx.window.Event('scroll', { bubbles: true }));
    expect(content.querySelector('.quill-gutter').scrollTop).toBe(editor.scrollTop);
  });

  it('main path: word wrap toggles and persists through localStorage', async () => {
    const ro = makeResizeObserverStub();
    const ctx = await mountTextedit({ platform: 'win32', resizeObserver: ro });
    const content = launch(ctx, {});
    const editor = content.querySelector('#quill-text-editor');
    const wrapBtn = btnOf(content, 'Word Wrap');

    wrapBtn.click();
    expect(editor.getAttribute('wrap')).toBe('soft');
    expect(wrapBtn.getAttribute('aria-pressed')).toBe('true');
    expect(wrapBtn.classList.contains('btn-primary')).toBe(true);
    // The Node-realm app resolves bare `localStorage` to the setup.js storage
    // (mirrorWindowGlobals cannot replace the non-configurable setup binding),
    // so assert through the same bare reference the app uses.
    expect(localStorage.getItem(WRAP_KEY)).toBe('true');

    // Toggle off again — covers the wrapped→unwrapped gutter rebuild.
    editor.value = 'a\nb';
    editor.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
    await settle(60);
    wrapBtn.click();
    expect(editor.getAttribute('wrap')).toBe('off');
    expect(localStorage.getItem(WRAP_KEY)).toBe('false');
    await settle(60);
    expect(content.querySelector('.quill-gutter').textContent).toBe('1\n2');

    // A mount seeded 'true' starts wrapped.
    const ctx2 = await mountTextedit({ platform: 'win32', seedWrap: 'true' });
    const content2 = launch(ctx2, {});
    expect(content2.querySelector('#quill-text-editor').getAttribute('wrap')).toBe('soft');
    expect(btnOf(content2, 'Word Wrap').getAttribute('aria-pressed')).toBe('true');
  });

  it('main path: word wrap via NovaAppConfig get/set, with read/save failures warned', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = {
      get: vi.fn(() => true),
      set: vi.fn(),
    };
    const ctx = await mountTextedit({ platform: 'win32', novaAppConfig: cfg });
    const content = launch(ctx, {});
    expect(content.querySelector('#quill-text-editor').getAttribute('wrap')).toBe('soft');

    const wrapBtn = btnOf(content, 'Word Wrap');
    wrapBtn.click();
    expect(cfg.set).toHaveBeenCalledWith('com.nbosp.textedit', 'wordWrap', false, {
      type: 'REG_BOOL', legacyKey: WRAP_KEY, legacyRaw: 'false',
    });
    // With NovaAppConfig present the registry branch runs and localStorage
    // is not written — the toggle is still visible in the DOM.
    expect(content.querySelector('#quill-text-editor').getAttribute('wrap')).toBe('off');

    // get() returning non-true keeps wrap off.
    const cfg2 = { get: vi.fn(() => false), set: vi.fn() };
    const ctx2 = await mountTextedit({ platform: 'win32', novaAppConfig: cfg2 });
    const content2 = launch(ctx2, {});
    expect(content2.querySelector('#quill-text-editor').getAttribute('wrap')).toBe('off');

    // get() throwing → caught, warned, wrap stays off.
    const cfg3 = { get: vi.fn(() => { throw new Error('registry down'); }), set: vi.fn() };
    const ctx3 = await mountTextedit({ platform: 'win32', novaAppConfig: cfg3 });
    launch(ctx3, {});
    expect(warn).toHaveBeenCalledWith('[TextEdit] Could not read the word-wrap preference:', expect.any(Error));

    // set() throwing → caught, warned.
    const cfg4 = { get: vi.fn(() => false), set: vi.fn(() => { throw new Error('read-only'); }) };
    const ctx4 = await mountTextedit({ platform: 'win32', novaAppConfig: cfg4 });
    const content4 = launch(ctx4, {});
    btnOf(content4, 'Word Wrap').click();
    expect(warn).toHaveBeenCalledWith('[TextEdit] Could not save the word-wrap preference:', expect.any(Error));
  });

  it('main path: brackets auto-pair, wrap selections, skip over closers and quotes', async () => {
    const ctx = await mountTextedit({ platform: 'win32' });
    const content = launch(ctx, {});
    const editor = tolerateIgnoreMode(content.querySelector('#quill-text-editor'));

    typeKey(ctx, editor, { key: '(' });
    expect(editor.value).toBe('()');
    expect(editor.selectionStart).toBe(1);

    typeKey(ctx, editor, { key: '{' });
    expect(editor.value).toBe('({})');
    expect(editor.selectionStart).toBe(2);

    // Typing an asymmetric closer directly in front of its twin skips over.
    typeKey(ctx, editor, { key: '}' });
    expect(editor.value).toBe('({})');
    expect(editor.selectionStart).toBe(3);

    // A closer NOT in front of its twin is a no-op (falls through the chain).
    editor.value = 'ab';
    editor.setSelectionRange(1, 1);
    typeKey(ctx, editor, { key: ')' });
    expect(editor.value).toBe('ab');
    expect(editor.selectionStart).toBe(1);

    // Quote skip-over inside handleBracket: value "''", cursor between them.
    editor.value = "''";
    editor.setSelectionRange(1, 1);
    typeKey(ctx, editor, { key: "'" });
    expect(editor.value).toBe("''");
    expect(editor.selectionStart).toBe(2);

    // Selection + opener wraps the selected text.
    editor.value = 'x';
    editor.setSelectionRange(0, 1);
    typeKey(ctx, editor, { key: '"' });
    expect(editor.value).toBe('"x"');
    expect(editor.selectionStart).toBe(1);
    expect(editor.selectionEnd).toBe(2);
    await settle(60);
  });

  it('main path: Tab indents, outdents (collapsed and over selections), last-empty-line skip', async () => {
    const ctx = await mountTextedit({ platform: 'win32' });
    const content = launch(ctx, {});
    const editor = tolerateIgnoreMode(content.querySelector('#quill-text-editor'));

    // Collapsed Tab → two spaces ('end' mode).
    editor.value = 'ab';
    editor.setSelectionRange(1, 1);
    typeKey(ctx, editor, { key: 'Tab' });
    expect(editor.value).toBe('a  b');
    expect(editor.selectionStart).toBe(3);

    // Collapsed Shift+Tab with no leading spaces → early return, untouched.
    editor.value = 'ab';
    editor.setSelectionRange(1, 1);
    typeKey(ctx, editor, { key: 'Tab', shiftKey: true });
    expect(editor.value).toBe('ab');
    expect(editor.selectionStart).toBe(1);

    // Collapsed Shift+Tab with leading spaces → outdent.
    editor.value = '  ab';
    editor.setSelectionRange(2, 2);
    typeKey(ctx, editor, { key: 'Tab', shiftKey: true });
    expect(editor.value).toBe('ab');
    expect(editor.selectionStart).toBe(0);
    expect(editor.selectionEnd).toBe(0);

    // Selection Tab → indent every line, selection tracks the edits.
    editor.value = 'a\nb';
    editor.setSelectionRange(0, 3);
    typeKey(ctx, editor, { key: 'Tab' });
    expect(editor.value).toBe('  a\n  b');
    expect(editor.selectionStart).toBe(2);
    expect(editor.selectionEnd).toBe(7);

    // Selection Shift+Tab → outdent back.
    editor.setSelectionRange(0, 7);
    typeKey(ctx, editor, { key: 'Tab', shiftKey: true });
    expect(editor.value).toBe('a\nb');
    expect(editor.selectionStart).toBe(0);
    expect(editor.selectionEnd).toBe(3);

    // Selection ending on a trailing newline: last (empty) line is skipped.
    editor.value = 'a\n';
    editor.setSelectionRange(0, 2);
    typeKey(ctx, editor, { key: 'Tab' });
    expect(editor.value).toBe('  a\n');

    editor.value = '  a\n';
    editor.setSelectionRange(0, 4);
    typeKey(ctx, editor, { key: 'Tab', shiftKey: true });
    expect(editor.value).toBe('a\n');
    await settle(60);
  });

  it('main path: context menu cut/copy/paste/select-all/word-count actions', async () => {
    const menu = { shows: [] };
    const contextMenu = { show: (x, y, items) => { menu.shows.push({ x, y, items }); } };
    const notify = makeNotify();
    const ctx = await mountTextedit({ platform: 'win32', contextMenu, notify });
    const content = launch(ctx, {});
    const editor = tolerateIgnoreMode(content.querySelector('#quill-text-editor'));
    const wrap = content.querySelector('.quill-editor-wrap');

    wrap.dispatchEvent(new ctx.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 11, clientY: 13 }));
    expect(menu.shows).toHaveLength(1);
    expect(menu.shows[0].x).toBe(11);
    const items = menu.shows[0].items;
    const byLabel = (label) => items.find((i) => i.label === label);
    expect(byLabel('Select All')).toBeTruthy();

    navigator.clipboard.writeText.mockImplementation(() => Promise.resolve());
    navigator.clipboard.readText.mockImplementation(() => Promise.resolve('PASTED'));

    // Cut with a selection: copies then deletes the range.
    editor.value = 'hello world';
    editor.setSelectionRange(0, 5);
    await byLabel('Cut').action();
    expect(editor.value).toBe(' world');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello');

    // Copy with an empty selection returns false and changes nothing.
    editor.setSelectionRange(0, 0);
    const copiedEmpty = await byLabel('Copy').action();
    expect(copiedEmpty).toBe(false);

    // Copy falling back to execCommand when the clipboard write rejects.
    ctx.document.execCommand = vi.fn(() => true);
    navigator.clipboard.writeText.mockRejectedValueOnce(new Error('denied'));
    editor.setSelectionRange(0, 3);
    const copiedFallback = await byLabel('Copy').action();
    expect(copiedFallback).toBe(true);
    expect(ctx.document.execCommand).toHaveBeenCalledWith('copy');
    expect(editor.value).toBe(' world'); // focus() happened; the text is intact

    // Cut with a collapsed caret returns before copying anything.
    editor.setSelectionRange(1, 1);
    await byLabel('Cut').action();
    expect(editor.value).toBe(' world');

    // Cut whose copy fails (clipboard rejects, execCommand false) → no splice.
    ctx.document.execCommand = vi.fn(() => false);
    navigator.clipboard.writeText.mockRejectedValueOnce(new Error('denied again'));
    editor.setSelectionRange(0, 3);
    await byLabel('Cut').action();
    expect(editor.value).toBe(' world');

    // Paste with a working clipboard splices the text in at the caret.
    editor.setSelectionRange(0, 0);
    await byLabel('Paste').action();
    expect(editor.value).toBe('PASTED world');

    // Paste with a rejecting clipboard falls back to execCommand('paste').
    ctx.document.execCommand = vi.fn(() => false);
    navigator.clipboard.readText.mockRejectedValueOnce(new Error('locked'));
    await byLabel('Paste').action();
    expect(ctx.document.execCommand).toHaveBeenCalledWith('paste');

    // Select All focuses and selects the whole document.
    await byLabel('Select All').action();
    expect(editor.selectionStart).toBe(0);
    expect(editor.selectionEnd).toBe(editor.value.length);

    // Word count: one word vs many.
    editor.value = 'one';
    await byLabel('Word Count').action();
    expect(notify.calls).toContainEqual(expect.objectContaining({ title: 'Word Count', body: '1 word' }));
    editor.value = 'one two three';
    await byLabel('Word Count').action();
    expect(notify.calls).toContainEqual(expect.objectContaining({ title: 'Word Count', body: '3 words' }));
  });

  it('main path: gutter click focuses the editor; textarea click only syncs status', async () => {
    const ctx = await mountTextedit({ platform: 'win32' });
    const content = launch(ctx, {});
    const editor = tolerateIgnoreMode(content.querySelector('#quill-text-editor'));
    const gutter = content.querySelector('.quill-gutter');

    editor.value = 'line one\nline two';
    editor.setSelectionRange(11, 11);
    // focus() only moves activeElement for elements attached to the document.
    ctx.document.body.appendChild(content);
    gutter.dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true }));
    expect(ctx.document.activeElement).toBe(editor);

    editor.dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true }));
    expect(content.querySelector('.quill-statusbar').textContent).toBe('Ln 2, Col 3  ·  4 words');
  });

  it('main path: saves a seeded file via FS.writeFile; errors notify; unknown-error fallback', async () => {
    const fs = makeFS();
    const notify = makeNotify();
    const ctx = await mountTextedit({ platform: 'win32', fs, notify });
    const content = launch(ctx, { options: { fileId: 'f1' } });
    const editor = tolerateIgnoreMode(content.querySelector('#quill-text-editor'));
    expect(editor.value).toBe('seeded file body');

    btnOf(content, 'Save').click();
    await settle();
    expect(fs.writes).toContainEqual(['f1', 'seeded file body']);
    expect(notify.calls).toContainEqual(expect.objectContaining({ title: 'Saved', body: 'hello.txt' }));

    editor.value = 'seeded file body v2';
    editor.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
    typeKey(ctx, editor, { key: 's', ctrlKey: true });
    await settle();
    expect(fs.writes).toContainEqual(['f1', 'seeded file body v2']);

    // FS.writeFile failure → Save Failed notification with the message…
    fs.writeErrors.push(new Error('disk full'));
    btnOf(content, 'Save').click();
    await settle();
    expect(notify.calls).toContainEqual(expect.objectContaining({ title: 'Save Failed', body: 'disk full', type: 'error' }));

    // …and the no-message variant falls back to the unknown-error string.
    fs.writeErrors.push({});
    btnOf(content, 'Save').click();
    await settle();
    expect(notify.calls).toContainEqual(expect.objectContaining({
      title: 'Save Failed', body: 'Unknown error occurred while saving.',
    }));
  });

  it('main path: Save As… creates through FS.createFile, refreshes desktop icons; dialog/validation failures', async () => {
    const fs = makeFS();
    const dialogs = makeDialogs({ saveResult: { name: 'notes.txt', folderId: 'docdir' } });
    const renderDesktopIcons = vi.fn();
    const notify = makeNotify();
    const ctx = await mountTextedit({ platform: 'win32', fs, dialogs, notify, renderDesktopIcons });
    const content = launch(ctx, {});
    const editor = tolerateIgnoreMode(content.querySelector('#quill-text-editor'));
    editor.value = 'fresh content';

    btnOf(content, 'Save As…').click();
    await settle();
    expect(dialogs.save).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Save As', suggestedName: 'untitled.txt', startFolderId: '/data/com.nbosp.textedit/files',
    }));
    expect(fs.created).toContainEqual(['docdir', 'notes.txt', 'fresh content', 'text/plain']);
    expect(renderDesktopIcons).toHaveBeenCalled();
    expect(notify.calls).toContainEqual(expect.objectContaining({ title: 'Saved', body: 'notes.txt' }));

    // Whitespace-only name → trimmed to '' → refused before createFile.
    dialogs.save.mockImplementation(async () => ({ name: '   ', folderId: 'docdir' }));
    const createdBefore = fs.created.length;
    btnOf(content, 'Save As…').click();
    await settle();
    expect(fs.created.length).toBe(createdBefore);

    // Missing name (null) → refused.
    dialogs.save.mockImplementation(async () => null);
    btnOf(content, 'Save As…').click();
    await settle();
    expect(fs.created.length).toBe(createdBefore);

    // createFile failure → Save Failed + message / unknown fallback.
    dialogs.save.mockImplementation(async () => ({ name: 'boom.txt', folderId: 'docdir' }));
    fs.createErrors.push(new Error('quota'));
    btnOf(content, 'Save As…').click();
    await settle();
    expect(notify.calls).toContainEqual(expect.objectContaining({ title: 'Save Failed', body: 'quota' }));
    fs.createErrors.push({});
    btnOf(content, 'Save As…').click();
    await settle();
    expect(notify.calls).toContainEqual(expect.objectContaining({
      title: 'Save Failed', body: 'Unknown error occurred while saving.',
    }));

    // Without a global renderDesktopIcons the save still succeeds (typeof skip).
    delete globalThis.renderDesktopIcons;
    delete ctx.window.renderDesktopIcons;
    dialogs.save.mockImplementation(async () => ({ name: 'again.txt', folderId: 'docdir' }));
    const before = renderDesktopIcons.mock.calls.length;
    btnOf(content, 'Save As…').click();
    await settle();
    expect(renderDesktopIcons.mock.calls.length).toBe(before);
    expect(fs.created.length).toBe(createdBefore + 3); // quota + {} + final
  });

  it('main path: Save As startFolder falls back to FS.specialFolders.documents when AppDirs has no path', async () => {
    let calls = 0;
    const appDirs = { getAppDataPath: vi.fn(() => (++calls === 1 ? '/data/com.nbosp.textedit/files' : null)) };
    const fs = makeFS();
    const dialogs = makeDialogs({ saveResult: { name: 'x.txt', folderId: 'docdir' } });
    const ctx = await mountTextedit({ platform: 'win32', appDirs, fs, dialogs });
    const content = launch(ctx, {});
    const editor = tolerateIgnoreMode(content.querySelector('#quill-text-editor'));
    editor.value = 'fallback body';
    btnOf(content, 'Save As…').click();
    await settle();
    expect(dialogs.save).toHaveBeenCalledWith(expect.objectContaining({ startFolderId: 'docs-folder' }));
    expect(fs.created).toContainEqual(['docdir', 'x.txt', 'fallback body', 'text/plain']);
  });

  it('main path: opens a file through the dialog; cancel and failure variants', async () => {
    const fs = makeFS();
    const notify = makeNotify();
    const dialogs = makeDialogs({ openResult: { id: 'f9', name: 'readme.md', content: '# Hi' } });
    const ctx = await mountTextedit({ platform: 'win32', fs, dialogs, notify });
    const content = launch(ctx, {});
    const editor = tolerateIgnoreMode(content.querySelector('#quill-text-editor'));

    btnOf(content, 'Open…').click();
    await settle();
    expect(editor.value).toBe('# Hi');
    expect(content.querySelector('.quill-statusbar').textContent).toBe('Ln 1, Col 5  ·  2 words');
    expect(notify.calls).toContainEqual(expect.objectContaining({ title: 'Opened', body: 'readme.md' }));

    // Picked node without content → '' (?? branch).
    dialogs.open.mockImplementation(async () => ({ id: 'f10', name: 'empty.txt' }));
    btnOf(content, 'Open…').click();
    await settle();
    expect(editor.value).toBe('');

    // Dialog rejecting → Open Failed + message / unknown fallback.
    dialogs.open.mockRejectedValueOnce(new Error('permission denied'));
    btnOf(content, 'Open…').click();
    await settle();
    expect(notify.calls).toContainEqual(expect.objectContaining({ title: 'Open Failed', body: 'permission denied' }));
    dialogs.open.mockRejectedValueOnce({});
    btnOf(content, 'Open…').click();
    await settle();
    expect(notify.calls).toContainEqual(expect.objectContaining({
      title: 'Open Failed', body: 'Unknown error occurred while opening.',
    }));

    // Cancel (null) → returns before touching the editor.
    dialogs.open.mockImplementation(async () => null);
    editor.value = 'keep me';
    btnOf(content, 'Open…').click();
    await settle();
    expect(editor.value).toBe('keep me');
  });

  it('main path: open dialog applies the mimeType filter; Save with no file id falls through to Save As', async () => {
    const fs = makeFS();
    const filterResults = [];
    const dialogs = makeDialogs();
    dialogs.open.mockImplementation(async (opts) => {
      // A real dialog filters its candidate list before showing it.
      if (opts.filter) {
        for (const node of [
          { mimeType: 'text/plain' },
          { mimeType: 'application/json' },
          { mimeType: 'image/png' },
          {},
        ]) filterResults.push(opts.filter(node));
      }
      return { id: 'f-filtered', name: 'filtered.txt', content: 'x' };
    });
    dialogs.save.mockImplementation(async () => null); // Save As dialog cancelled
    const notify = makeNotify();
    const ctx = await mountTextedit({ platform: 'win32', fs, dialogs, notify });
    const content = launch(ctx, {});
    const editor = tolerateIgnoreMode(content.querySelector('#quill-text-editor'));

    // file.id is null (fresh editor) → plain Save routes through saveFileAs
    // (dialog cancelled → nothing saved, no notification).
    btnOf(content, 'Save').click();
    await settle();
    expect(dialogs.save).toHaveBeenCalledTimes(1);
    expect(fs.created).toEqual([]);
    expect(notify.calls.filter((n) => n.title === 'Saved')).toHaveLength(0);

    // Then the filter-driving open.
    btnOf(content, 'Open…').click();
    await settle();
    expect(filterResults).toEqual([true, true, false, false]);
    expect(editor.value).toBe('x');
  });

  it('main path: host without ResizeObserver, empty options and a cleanups-less state', async () => {
    const ctx = await mountTextedit({ platform: 'win32' });
    // A host with no ResizeObserver at all skips the observer wiring entirely.
    delete globalThis.ResizeObserver;
    // options present but with no fileId, and state without a cleanups array.
    const state = {};
    const content = launch(ctx, { state, options: {} });
    expect(Array.isArray(state.cleanups)).toBe(true);
    expect(content.querySelector('#quill-text-editor').value).toBe('');
    expect(content.querySelector('.quill-statusbar').textContent).toBe('Ln 1, Col 1  ·  0 words');
  });

  it('main path: init seeds the editor from options.fileId via FS.files.get (hit and miss)', async () => {
    const fs = makeFS();
    const ctx = await mountTextedit({ platform: 'win32', fs });
    const content = launch(ctx, { options: { fileId: 'f2' } }); // hit, no content field
    const editor = tolerateIgnoreMode(content.querySelector('#quill-text-editor'));
    expect(editor.value).toBe(''); // f.content ?? ''

    const ctx2 = await mountTextedit({ platform: 'win32', fs: makeFS() });
    const content2 = launch(ctx2, { options: { fileId: 'missing' } }); // miss
    expect(content2.querySelector('#quill-text-editor').value).toBe('');
  });

  it('main path: _destroy aborts listeners, cancels pending rAF and disconnects the ResizeObserver', async () => {
    const ro = makeResizeObserverStub();
    const fs = makeFS();
    const ctx = await mountTextedit({ platform: 'win32', resizeObserver: ro, fs });
    const state = { cleanups: [] };
    const content = launch(ctx, { state });
    const editor = tolerateIgnoreMode(content.querySelector('#quill-text-editor'));

    // Fire an input then destroy before the rAF runs → rafId is pending.
    editor.value = 'about to die';
    editor.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
    content._destroy();
    expect(ro.calls.disconnect).toBeGreaterThanOrEqual(1);

    // Listeners are gone: clicks/keys do nothing.
    btnOf(content, 'Save').click();
    await settle();
    expect(fs.writes).toEqual([]);
    typeKey(ctx, editor, { key: 's', ctrlKey: true });
    await settle();
    expect(fs.writes).toEqual([]);

    // Destroy after the rAF flushed → the rafId guard skips cancel.
    const ctx2 = await mountTextedit({ platform: 'win32', resizeObserver: makeResizeObserverStub(), fs: makeFS() });
    const content2 = launch(ctx2, {});
    await settle(80); // let the initial rAF run to completion
    expect(() => content2._destroy()).not.toThrow();
    await settle(40);
  });

  it('main path: language change relabels toolbar; cleanup offs; ResizeObserver wrapped path', async () => {
    const events = makeEventBus();
    const os = { events };
    const ro = makeResizeObserverStub();
    const ctx = await mountTextedit({ platform: 'win32', os, resizeObserver: ro, seedWrap: 'true' });
    const state = { cleanups: [] };
    const content = launch(ctx, { state });
    expect(events.on).toHaveBeenCalledWith('languageChanged', expect.any(Function));

    // Seeded wrap=true at init means the observer callback took the syncGutter branch.
    events.handlers.languageChanged();
    expect(btnOf(content, 'Save').textContent).toBe('Save');
    expect(btnOf(content, 'Save').title).toBe('Save (Ctrl+S)');
    expect(content.querySelector('#quill-text-editor').getAttribute('aria-label')).toBe('Text editor');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const apply = ctx.window.NovaI18n.applyStaticDom;
    ctx.window.NovaI18n.applyStaticDom = () => { throw new Error('boom'); };
    events.handlers.languageChanged();
    expect(warn).toHaveBeenCalledWith('[TextEdit] Language change re-render failed:', expect.any(Error));
    ctx.window.NovaI18n.applyStaticDom = apply;
    ctx.window.NovaI18n = null; // optional-chaining skip path
    events.handlers.languageChanged();
    expect(warn).toHaveBeenCalledTimes(1);

    state.cleanups.forEach((c) => c());
    expect(events.off).toHaveBeenCalledWith('languageChanged', expect.any(Function));
  });

  // ── onDrop ──────────────────────────────────────────────────────────────
  it('onDrop (linux host): writes the file to home, EEXIST + invalid names surface errors', async () => {
    const wm = { createWindow: vi.fn() };
    const notify = makeNotify();
    const ctx = await mountTextedit({ wm, notify });
    const destination = nodePath.join(nodeOs.homedir(), HOME_DROP_NAME);
    nodeFs.rmSync(destination, { force: true });

    await ctx.app.onDrop({ name: HOME_DROP_NAME, size: 7, type: 'text/plain', text: async () => 'dropped linux' }, {});
    await settle();
    expect(nodeFs.readFileSync(destination, 'utf8')).toBe('dropped linux');
    expect(wm.createWindow).toHaveBeenCalledWith('com.nbosp.textedit', { path: destination });
    expect(notify.calls).toContainEqual(expect.objectContaining({ title: 'File Opened', body: HOME_DROP_NAME }));

    // Second drop with the same name → real EEXIST from the 'wx' flag.
    await ctx.app.onDrop({ name: HOME_DROP_NAME, size: 7, type: 'text/plain', text: async () => 'again' }, {});
    const eexist = notify.calls.find((n) => n.title === 'Error' && /EEXIST|exists/i.test(String(n.body)));
    expect(eexist).toBeTruthy();

    // Empty name → invalid-drop-name rejection.
    await ctx.app.onDrop({ name: '', text: async () => 'x' }, {});
    expect(notify.calls).toContainEqual(expect.objectContaining({
      title: 'Error', body: 'Dropped file name is not valid.',
    }));

    // A path-shaped name is rejected by the basename check.
    await ctx.app.onDrop({ name: 'sub/dir.txt', text: async () => 'x' }, {});
    expect(notify.calls.filter((n) => n.body === 'Dropped file name is not valid.')).toHaveLength(2);

    // A rejecting .text() with no message falls back to failedToOpen.
    await ctx.app.onDrop({ name: 'ok.txt', text: () => Promise.reject({}) }, {});
    expect(notify.calls).toContainEqual(expect.objectContaining({
      title: 'Error', body: 'Failed to open file.',
    }));
  });

  it('onDrop (browser path): imports into FS + WM; randomUUID fallback; rejection', async () => {
    const wm = { createWindow: vi.fn() };
    const fs = makeFS();
    const notify = makeNotify();
    const ctx = await mountTextedit({ wm, fs, notify });
    await withPlatform('win32', () => ctx.app.onDrop({ name: 'dropped.txt', size: 7, type: 'text/plain', text: async () => 'dropped browser' }, {}));
    await settle();
    const stored = [...fs.files.values()].find((f) => f.name === 'dropped.txt');
    expect(stored.content).toBe('dropped browser');
    expect(stored.mimeType).toBe('text/plain');
    expect(wm.createWindow).toHaveBeenCalledWith('com.nbosp.textedit', { fileId: stored.id });
    expect(notify.calls).toContainEqual(expect.objectContaining({ title: 'File Opened', body: 'dropped.txt' }));

    // crypto.randomUUID when generateId is unavailable.
    delete globalThis.generateId;
    await withPlatform('win32', () => ctx.app.onDrop({ name: 'uuid.txt', size: 3, type: 'text/plain', text: async () => 'uuid body' }, {}));
    const uuidEntry = [...fs.files.values()].find((f) => f.name === 'uuid.txt');
    expect(uuidEntry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); // setup.js's scripted uuid shape
    expect(wm.createWindow).toHaveBeenLastCalledWith('com.nbosp.textedit', { fileId: uuidEntry.id });

    // A rejecting .text() surfaces the error notification instead of throwing.
    await withPlatform('win32', () => ctx.app.onDrop({ name: 'bad.txt', text: () => Promise.reject(new Error('unreadable')) }, {}));
    expect(notify.calls).toContainEqual(expect.objectContaining({ title: 'Error', body: 'unreadable' }));

    // A drop with no MIME type falls back to text/plain in the FS node.
    await withPlatform('win32', () => ctx.app.onDrop({ name: 'no-type.txt', size: 2, text: async () => 'nt' }, {}));
    const noType = [...fs.files.values()].find((f) => f.name === 'no-type.txt');
    expect(noType.mimeType).toBe('text/plain');
    expect(noType.type).toBe('text/plain');
  });
});
