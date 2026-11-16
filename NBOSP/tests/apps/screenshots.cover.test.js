// tests/apps/screenshots.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/screenshots/service.js.
// jsdom has no real canvas/video pipeline, so the prototypes are patched to
// deterministic recorders (the same trick the easter-egg suite uses for its
// canvas); the region picker is driven with real pointer/key events over the
// real overlay DOM.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { coverLoadServiceApp, settle } from '../helpers/cover-loader.js';

const DATA_URL = 'data:image/png;base64,QUJD';

afterEach(() => { vi.restoreAllMocks(); });

function makeStream() {
  const stops = vi.fn();
  return { getTracks: () => [{ stop: stops }], _stops: stops };
}

async function mount({ fs, eventLog, notify, events } = {}) {
  delete globalThis.window?.NovaI18n?.applyStaticDom;
  const extra = {
    Notify: notify ?? { show: vi.fn() },
    EventLog: eventLog ?? { log: vi.fn() },
    OS: { events: events ?? { on: vi.fn(), off: vi.fn() } },
    ...(fs ? { FS: fs } : {}),
  };
  const ctx = await coverLoadServiceApp('screenshots', {
    stubs: { extra },
    withBaseUtils: true, // createEl + _t
  });

  const w = ctx.window;
  // deterministic canvas/video pipeline
  const draws = [];
  w.HTMLCanvasElement.prototype.getContext = function () {
    return new Proxy({}, {
      get: (t, p) => {
        if (p === 'drawImage') return function (...args) { draws.push(args); };
        return function () {};
      },
    });
  };
  w.HTMLCanvasElement.prototype.toDataURL = function () { return DATA_URL; };
  Object.defineProperty(w.HTMLVideoElement.prototype, 'videoWidth', { get: () => 1280, configurable: true });
  Object.defineProperty(w.HTMLVideoElement.prototype, 'videoHeight', { get: () => 720, configurable: true });
  w.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };

  return { ...ctx, draws, Notify: extra.Notify, EventLog: extra.EventLog };
}

function shotsFS({ existing = true, pictures = 'pic-1' } = {}) {
  const calls = { listDir: 0, createFolder: 0, createFile: [], uniqueName: 0 };
  const fs = {
    files: { has: () => true },
    specialFolders: { pictures },
    listDir: vi.fn(() => {
      calls.listDir++;
      return existing
        ? [{ type: 'folder', name: 'Screenshots', id: 'shot-folder' }]
        : [{ type: 'folder', name: 'Other', id: 'other' }];
    }),
    createFolder: vi.fn(async () => { calls.createFolder++; return { id: 'created-1' }; }),
    uniqueName: vi.fn((dir, name) => { calls.uniqueName++; return name; }),
    createFile: vi.fn(async (dir, name, data, mime) => { calls.createFile.push([dir, name, data, mime]); }),
    calls,
  };
  return fs;
}

// drive the region overlay: real pointer events over the real DOM
const ptr = (w, el, type, init = {}) =>
  el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));

describe('ScreenshotService (js/apps/screenshots/service.js) — e2e coverage', () => {
  it('captures the desktop, stores base64 in Pictures/Screenshots and notifies', async () => {
    const stream = makeStream();
    globalThis.navigator.mediaDevices.getDisplayMedia = vi.fn(() => Promise.resolve(stream));
    const fs = shotsFS();
    const { window, document, draws, Notify, EventLog } = await mount({ fs });
    await window.ScreenshotService.capture('desktop');
    expect(globalThis.navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledWith({
      video: { displaySurface: 'monitor' },
    });
    expect(draws).toHaveLength(1); // full-frame drawImage
    expect(stream._stops).toHaveBeenCalledTimes(1); // released before the picker; finally skips (stream nulled)
    expect(fs.calls.createFile).toEqual([
      ['shot-folder', expect.any(String), 'QUJD', 'image/png'], // _dataUrlToBase64 stripped the wrapper
    ]);
    expect(fs.calls.createFolder).toBe(0); // existing folder reused
    expect(Notify.show).toHaveBeenCalledTimes(1);
    expect(Notify.show.mock.calls[0][0].type).toBe('success');
    expect(EventLog.log).toHaveBeenCalledTimes(1);
    expect(EventLog.log.mock.calls[0][0].severity).toBe('info');
  });

  it('window mode asks for a window surface; reuses the cached folder id', async () => {
    const stream = makeStream();
    globalThis.navigator.mediaDevices.getDisplayMedia = vi.fn(() => Promise.resolve(stream));
    const fs = shotsFS();
    const { window } = await mount({ fs });
    await window.ScreenshotService.capture('window');
    expect(globalThis.navigator.mediaDevices.getDisplayMedia).toHaveBeenLastCalledWith({
      video: { displaySurface: 'window' },
    });
    const listDirAfterFirst = fs.calls.listDir;
    // second capture: the cached folder id short-circuits the Pictures scan
    await window.ScreenshotService.capture('window');
    expect(fs.calls.listDir).toBe(listDirAfterFirst);
    expect(fs.calls.createFile).toHaveLength(2);
  });

  it('creates the Screenshots folder when Pictures does not have one', async () => {
    const stream = makeStream();
    globalThis.navigator.mediaDevices.getDisplayMedia = vi.fn(() => Promise.resolve(stream));
    const fs = shotsFS({ existing: false });
    const { window } = await mount({ fs });
    await window.ScreenshotService.capture('desktop');
    expect(fs.calls.createFolder).toBe(1);
    expect(fs.calls.createFile[0][0]).toBe('created-1');
  });

  it('fails softly when the Pictures folder is unavailable', async () => {
    const stream = makeStream();
    globalThis.navigator.mediaDevices.getDisplayMedia = vi.fn(() => Promise.resolve(stream));
    const fs = shotsFS({ pictures: null }); // no special folder
    const { window, Notify, EventLog } = await mount({ fs });
    await window.ScreenshotService.capture('desktop');
    expect(fs.calls.createFile).toHaveLength(0);
    expect(Notify.show).toHaveBeenCalledTimes(1);
    expect(Notify.show.mock.calls[0][0].type).toBe('error');
    expect(EventLog.log).toHaveBeenCalledTimes(1);
    expect(EventLog.log.mock.calls[0][0].severity).toBe('error');
    expect(EventLog.log.mock.calls[0][0].message).toContain('Pictures folder not found');
  });

  it('reports capture failures without throwing', async () => {
    globalThis.navigator.mediaDevices.getDisplayMedia = vi.fn(() => Promise.reject(new Error('denied')));
    const fs = shotsFS();
    const { window, Notify, EventLog } = await mount({ fs });
    await expect(window.ScreenshotService.capture('desktop')).resolves.toBeUndefined();
    expect(Notify.show).toHaveBeenCalledTimes(1);
    expect(Notify.show.mock.calls[0][0].type).toBe('error');
    expect(EventLog.log.mock.calls[0][0].message).toContain('denied');
    // a rejection that carries no .message (non-Error) logs the raw value
    globalThis.navigator.mediaDevices.getDisplayMedia = vi.fn(() => Promise.reject('boom-string'));
    await expect(window.ScreenshotService.capture('desktop')).resolves.toBeUndefined();
    expect(EventLog.log.mock.calls.at(-1)[0].message).toContain('boom-string');
  });

  it('still releases the stream when the video pipeline throws mid-capture', async () => {
    const stream = makeStream();
    globalThis.navigator.mediaDevices.getDisplayMedia = vi.fn(() => Promise.resolve(stream));
    const fs = shotsFS();
    const { window, Notify } = await mount({ fs });
    // play() rejects AFTER the stream was granted → the finally clause must
    // stop the tracks so no capture indicator is left dangling
    window.HTMLMediaElement.prototype.play = function () {
      return Promise.reject(new Error('autoplay blocked'));
    };
    await expect(window.ScreenshotService.capture('desktop')).resolves.toBeUndefined();
    expect(stream._stops).toHaveBeenCalledTimes(1); // released by finally
    expect(Notify.show.mock.calls[0][0].type).toBe('error');
    expect(fs.calls.createFile).toHaveLength(0); // nothing persisted
  });

  it('region mode: drags a selection, crops and persists it', async () => {
    const stream = makeStream();
    globalThis.navigator.mediaDevices.getDisplayMedia = vi.fn(() => Promise.resolve(stream));
    const fs = shotsFS();
    const { window, document, draws } = await mount({ fs });
    const pending = window.ScreenshotService.capture('region');
    await settle(20); // let the async chain reach the picker

    const overlay = document.getElementById('screenshot-region-overlay');
    expect(overlay).toBeTruthy();
    const frame = overlay.firstChild;
    // viewport math: scale = min(921.6/1280, 691.2/720, 1) = 0.72
    // drag 100,80 → 400,280 (jsdom rects are 0×0 so clientX/Y map straight in)
    ptr(window, overlay, 'pointerdown', { clientX: 100, clientY: 80 });
    // a move before the drag started is ignored
    const box = frame.children[1];
    expect(box.style.display).toBe('block');
    ptr(window, overlay, 'pointermove', { clientX: 400, clientY: 280 });
    expect(box.style.width).toBe('300px');
    ptr(window, overlay, 'pointerup', { clientX: 400, clientY: 280 });
    await pending;

    expect(draws).toHaveLength(2); // full frame + cropped
    expect(fs.calls.createFile[0][2]).toBe('QUJD');
    // region numbers: left/scale 100/0.72=138.9 → 139; 200/0.72=277.8 → 278
    const cropArgs = draws[1];
    expect(cropArgs[1]).toBe(139); // x
    expect(cropArgs[2]).toBe(111); // y = 80/0.72
    expect(cropArgs[3]).toBe(417); // width = 300/0.72
    expect(cropArgs[4]).toBe(278); // height = 200/0.72
  });

  it('region mode: Escape and right-click cancel; tiny drags keep waiting', async () => {
    const stream = makeStream();
    globalThis.navigator.mediaDevices.getDisplayMedia = vi.fn(() => Promise.resolve(stream));
    const fs = shotsFS();
    const { window, document } = await mount({ fs });
    const pending = window.ScreenshotService.capture('region');
    await settle(20);
    const overlay = document.getElementById('screenshot-region-overlay');

    // non-primary button does not start a drag
    ptr(window, overlay, 'pointerdown', { button: 2, clientX: 50, clientY: 50 });
    // pointermove/pointerup while not dragging: ignored
    ptr(window, overlay, 'pointermove', { clientX: 60, clientY: 60 });
    ptr(window, overlay, 'pointerup', { clientX: 60, clientY: 60 });
    // a non-Escape key is not a cancel
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    // start, drag small, release → too small, keeps waiting
    ptr(window, overlay, 'pointerdown', { clientX: 100, clientY: 80 });
    ptr(window, overlay, 'pointermove', { clientX: 102, clientY: 81 });
    ptr(window, overlay, 'pointerup', { clientX: 102, clientY: 81 });
    const box = overlay.firstChild.children[1];
    expect(box.style.display).toBe('none'); // treated as a click
    // Escape finishes with null
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await expect(pending).resolves.toBeUndefined();
    expect(document.getElementById('screenshot-region-overlay')).toBe(null); // cleaned up

    // a second region capture cancelled via contextmenu
    const pending2 = window.ScreenshotService.capture('region');
    await settle(20);
    const overlay2 = document.getElementById('screenshot-region-overlay');
    ptr(window, overlay2, 'pointerdown', { clientX: 100, clientY: 80 });
    overlay2.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await expect(pending2).resolves.toBeUndefined();
    // finish is idempotent: a late contextmenu on the detached overlay is a no-op
    overlay2.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });

  it('relacles the region hint when the OS language flips mid-pick, and survives a broken engine', async () => {
    const stream = makeStream();
    globalThis.navigator.mediaDevices.getDisplayMedia = vi.fn(() => Promise.resolve(stream));
    const fs = shotsFS();
    const handlers = {};
    const events = { on: vi.fn((t, h) => { handlers[t] = h; }), off: vi.fn() };
    const { window, document } = await mount({ fs, events });
    const pending = window.ScreenshotService.capture('region');
    await settle(20);
    const overlay = document.getElementById('screenshot-region-overlay');
    const hint = overlay.firstChild.children[2];

    // healthy engine: hint relabels in place
    window.NovaI18n = { applyStaticDom: vi.fn() };
    handlers['languageChanged']();
    expect(window.NovaI18n.applyStaticDom).toHaveBeenCalledWith(overlay);
    expect(hint.textContent.length).toBeGreaterThan(0);

    // broken engine: warned, picker survives
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.NovaI18n = { applyStaticDom: () => { throw new Error('i18n down'); } };
    expect(() => handlers['languageChanged']()).not.toThrow();
    expect(warn).toHaveBeenCalledWith('[Screenshots] Language change re-render failed:', expect.anything());

    // finish: the languageChanged listener is unregistered
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await expect(pending).resolves.toBeUndefined();
    expect(events.off).toHaveBeenCalledWith('languageChanged', expect.any(Function));
  });

  it('works without EventLog and without OS.events', async () => {
    const stream = makeStream();
    globalThis.navigator.mediaDevices.getDisplayMedia = vi.fn(() => Promise.resolve(stream));
    const fs = shotsFS();
    const { window, document } = await mount({ fs, eventLog: undefined });
    delete globalThis.window.EventLog;
    const events = { on: vi.fn() }; // no off: optional call skipped
    const ctx2 = { ...globalThis };
    globalThis.OS = { events };
    await window.ScreenshotService.capture('desktop');
    // success path without EventLog: no throw (optional-chained log skipped)
    expect(document.body.querySelector('.ctx-item')).toBe(null); // sanity: nothing stray
  });

  it('degrades when the canvas pipeline yields empty or unwrapped payloads', async () => {
    const stream = makeStream();
    globalThis.navigator.mediaDevices.getDisplayMedia = vi.fn(() => Promise.resolve(stream));
    const fs = shotsFS();
    const { window } = await mount({ fs });
    // toDataURL returning '' → _dataUrlToBase64 guard returns ''
    window.HTMLCanvasElement.prototype.toDataURL = function () { return ''; };
    await window.ScreenshotService.capture('desktop');
    expect(fs.calls.createFile[0][2]).toBe('');

    // a payload without a comma is stored as-is (no wrapper to strip)
    window.HTMLCanvasElement.prototype.toDataURL = function () { return 'RAWBASE64'; };
    await window.ScreenshotService.capture('desktop');
    expect(fs.calls.createFile[1][2]).toBe('RAWBASE64');
  });

  it('region cancel path with the OS events bus absent', async () => {
    const stream = makeStream();
    globalThis.navigator.mediaDevices.getDisplayMedia = vi.fn(() => Promise.resolve(stream));
    const fs = shotsFS();
    const { window, document } = await mount({ fs });
    delete globalThis.OS; // no bus at all: register/unregister skipped silently
    const pending = window.ScreenshotService.capture('region');
    await settle(20);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await expect(pending).resolves.toBeUndefined();
  });
});
