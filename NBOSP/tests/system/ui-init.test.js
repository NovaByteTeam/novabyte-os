import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// ── ui-init.js — tray fallback + developer keyboard shortcuts, e2e ──────────
//
// ui-init.js is a plain browser script (no exports): it registers one
// DOMContentLoaded listener that wires tray <img> error fallbacks and the
// global keydown handler (F12/Ctrl+Shift+I devtools, F5/Ctrl+R reload, F11
// fullscreen, Ctrl+F5 blocked, and the fullscreen-Setup key shield). This
// suite evals the REAL script into a real JSDOM document and drives it with
// real DOM events — exactly the browser surface it runs against.

const SCRIPT_URL = new URL('../../ui-init.js', import.meta.url);

const TRAY_HTML = `<!doctype html>
<html>
  <head><title>shell</title></head>
  <body>
    <img id="tray-volume-img" src="/assets/icons8-sound-94.png" alt="vol">
    <img id="tray-wifi-img" src="/assets/icons8-wi-fi-94.png" alt="wifi">
    <img id="tray-bell-img" src="/assets/icons8-bell-94.png" alt="bell">
  </body>
</html>`;

function makeNw() {
  const calls = [];
  return {
    calls,
    nw: {
      Window: {
        get: () => ({
          showDevTools: () => calls.push('showDevTools'),
          reload: () => calls.push('reload'),
          toggleFullscreen: () => calls.push('toggleFullscreen'),
        }),
      },
    },
  };
}

/** Build a JSDOM env with the script loaded and DOMContentLoaded dispatched. */
async function boot(html = TRAY_HTML, extra = {}) {
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://localhost/index.html',
  });
  const nwBag = makeNw();
  dom.window.nw = nwBag.nw;
  if (extra.os) dom.window.OS = extra.os;
  dom.window.eval(await readFile(SCRIPT_URL, 'utf8'));
  // The script registered on DOMContentLoaded; with outside-only scripts the
  // document is already complete, so dispatch the event for real.
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));
  return { dom, calls: nwBag.calls };
}

/** Dispatch a real keydown event on the window. */
function key(dom, init) {
  const event = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  dom.window.dispatchEvent(event);
  return event;
}

describe('ui-init.js — tray icon error fallback', () => {
  it('hides a tray image when its src fails to load', async () => {
    const { dom } = await boot();
    const img = dom.window.document.getElementById('tray-volume-img');
    expect(img.style.visibility).toBe('');
    img.dispatchEvent(new dom.window.Event('error', { bubbles: true }));
    expect(img.style.visibility).toBe('hidden');
    dom.window.close();
  });

  it('hides each tray image independently', async () => {
    const { dom } = await boot();
    const wifi = dom.window.document.getElementById('tray-wifi-img');
    const bell = dom.window.document.getElementById('tray-bell-img');
    wifi.dispatchEvent(new dom.window.Event('error', { bubbles: true }));
    expect(wifi.style.visibility).toBe('hidden');
    expect(bell.style.visibility).toBe('');
    bell.dispatchEvent(new dom.window.Event('error', { bubbles: true }));
    expect(bell.style.visibility).toBe('hidden');
    dom.window.close();
  });

  it('tolerates a document without the tray image ids', async () => {
    const { dom } = await boot('<!doctype html><html><body></body></html>');
    // No throw, and the keydown handler still installed below:
    key(dom, { key: 'F12' });
    dom.window.close();
  });
});

describe('ui-init.js — developer keyboard shortcuts', () => {
  it('F12 opens devtools', async () => {
    const { dom, calls } = await boot();
    const e = key(dom, { key: 'F12' });
    expect(e.defaultPrevented).toBe(true);
    expect(calls).toEqual(['showDevTools']);
    dom.window.close();
  });

  it('Ctrl+Shift+I opens devtools', async () => {
    const { dom, calls } = await boot();
    key(dom, { key: 'I', ctrlKey: true, shiftKey: true });
    expect(calls).toEqual(['showDevTools']);
    dom.window.close();
  });

  it('F5 and Ctrl+R hot-reload the page', async () => {
    const { dom, calls } = await boot();
    key(dom, { key: 'F5' });
    key(dom, { key: 'r', ctrlKey: true });
    expect(calls).toEqual(['reload', 'reload']);
    dom.window.close();
  });

  it('F11 toggles fullscreen', async () => {
    const { dom, calls } = await boot();
    const e = key(dom, { key: 'F11' });
    expect(e.defaultPrevented).toBe(true);
    expect(calls).toEqual(['toggleFullscreen']);
    dom.window.close();
  });

  it('Ctrl+F5 is blocked outright and never reloads', async () => {
    const { dom, calls } = await boot();
    const e = key(dom, { key: 'F5', ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(calls).toEqual([]);
    dom.window.close();
  });

  it('Ctrl+Shift+F5 is blocked the same way', async () => {
    const { dom, calls } = await boot();
    const e = key(dom, { key: 'F5', ctrlKey: true, shiftKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(calls).toEqual([]);
    dom.window.close();
  });

  it('ignores unrelated keys entirely', async () => {
    const { dom, calls } = await boot();
    const e = key(dom, { key: 'a' });
    expect(e.defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
    dom.window.close();
  });
});

describe('ui-init.js — fullscreen Setup key shield', () => {
  function setupFullscreenOs(fullscreen = true) {
    return {
      windows: new Map([
        ['w-1', { appId: 'com.nbosp.setup', fullscreen }],
        ['w-2', { appId: 'com.nbosp.settings', fullscreen: true }],
      ]),
    };
  }

  it('swallows every shortcut-shaped key while the Setup app is fullscreen', async () => {
    const { dom, calls } = await boot(TRAY_HTML, { os: setupFullscreenOs(true) });
    for (const init of [
      { key: 'F12' },
      { key: 'I', ctrlKey: true, shiftKey: true },
      { key: 'F5' },
      { key: 'r', ctrlKey: true },
      { key: 'F11' },
      { key: 'Escape' },
      { key: 'PrintScreen' },
    ]) {
      const e = key(dom, init);
      expect(e.defaultPrevented).toBe(true);
    }
    expect(calls).toEqual([]); // nothing reached nw.Window at all
    dom.window.close();
  });

  it('passes plain typing keys through while Setup is fullscreen', async () => {
    const { dom } = await boot(TRAY_HTML, { os: setupFullscreenOs(true) });
    const e = key(dom, { key: 'a' });
    expect(e.defaultPrevented).toBe(false);
    dom.window.close();
  });

  it('does not shield once Setup is no longer fullscreen', async () => {
    const { dom, calls } = await boot(TRAY_HTML, { os: setupFullscreenOs(false) });
    key(dom, { key: 'F12' });
    expect(calls).toEqual(['showDevTools']);
    dom.window.close();
  });

  it('does not shield when OS.windows is absent', async () => {
    const { dom, calls } = await boot(TRAY_HTML, { os: {} });
    key(dom, { key: 'F5' });
    expect(calls).toEqual(['reload']);
    dom.window.close();
  });
});
