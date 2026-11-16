// tests/apps/system-events.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/system-events/service.js.
// The service binds its panel/keyboard/resize wiring at load time against
// a real DOM (cover-loader html option), then the handlers are driven with
// real DOM events exactly like the shell would.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { coverLoadServiceApp, settle } from '../helpers/cover-loader.js';

const PANEL_HTML = `<!doctype html><html><body>
  <div id="notification-panel" class="active"><div id="panel-inner">panel</div></div>
  <button id="tray-bell">bell</button>
  <button id="notif-close">close</button>
  <button id="notif-mark-all">mark all</button>
  <button id="notif-mark-read">mark read</button>
  <span id="notif-badge" class="hidden">0</span>
  <div id="launchpad" class="active">launchpad</div>
  <div class="window-content" id="app-surface" tabindex="-1">
    <input id="editor" placeholder="type here" />
  </div>
</body></html>`;

function makeStubs({ notifications = [], windows = new Map(), focusedWindowId = null, events = { on: vi.fn() } } = {}) {
  return {
    Notify: {
      loadPersisted: vi.fn(),
      renderPanel: vi.fn(),
      updateBadge: vi.fn(),
      togglePanel: vi.fn(),
      clearAll: vi.fn(),
      markAllRead: vi.fn(),
      show: vi.fn(),
    },
    OS: {
      notifications,
      windows,
      focusedWindowId,
      events,
    },
    WM: {
      getWorkArea: vi.fn(() => ({ left: 0, top: 0, width: 1024, height: 768 })),
      clampWindowRect: vi.fn((s, x, y, w, h) => ({ x: Math.max(0, x), y: Math.max(0, y), w, h })),
      hideSnapPreview: vi.fn(),
      createWindow: vi.fn(),
      minimizeAll: vi.fn(),
      closeWindow: vi.fn(),
      updateTaskbar: vi.fn(),
    },
    throttleRAF: vi.fn((fn) => fn),
    ContextMenu: { hide: vi.fn() },
    renderLaunchpad: vi.fn(),
    LockScreenService: { lockScreen: vi.fn() },
    ScreenshotService: { capture: vi.fn() },
    LauncherShell: { showAppSwitcher: vi.fn(), switchWorkspace: vi.fn() },
    DebugOverlay: { toggle: vi.fn(), _copyDebugInfo: vi.fn() },
    resetShellScroll: vi.fn(),
  };
}

async function mount(overrides = {}) {
  // reset globals that a previous test's extras may have left behind
  delete globalThis.__NBOSP_BG;
  const stubs = makeStubs(overrides);
  const { extra = {}, html = PANEL_HTML } = overrides;
  const ctx = await coverLoadServiceApp('system-events', {
    html,
    stubs: { extra: { ...asExtra(stubs), ...extra } },
    withBaseUtils: true,
  });
  return { ...ctx, stubs };
}

// place each stub on the window/cover realm under the name the source uses
function asExtra(stubs) {
  return {
    Notify: stubs.Notify,
    OS: stubs.OS,
    WM: stubs.WM,
    throttleRAF: stubs.throttleRAF,
    ContextMenu: stubs.ContextMenu,
    renderLaunchpad: stubs.renderLaunchpad,
    'LockScreenService': stubs.LockScreenService,
    'ScreenshotService': stubs.ScreenshotService,
    'LauncherShell': stubs.LauncherShell,
    'DebugOverlay': stubs.DebugOverlay,
    resetShellScroll: stubs.resetShellScroll,
  };
}

const key = (window, init) =>
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
const fire = (window, el, type, init = {}) =>
  el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...init }));

afterEach(() => { vi.restoreAllMocks(); });

describe('System events (js/apps/system-events/service.js) — e2e coverage', () => {
  it('boots the notification panel and binds every panel control', async () => {
    const { window, stubs, document } = await mount();
    expect(stubs.Notify.loadPersisted).toHaveBeenCalledTimes(1);
    expect(stubs.Notify.renderPanel).toHaveBeenCalledTimes(1);
    expect(stubs.Notify.updateBadge).toHaveBeenCalledTimes(1);
    // load-time updateNotificationBadge with zero unread → badge hidden
    expect(document.getElementById('notif-badge').classList.contains('hidden')).toBe(true);

    // tray bell → Notify.togglePanel
    document.getElementById('tray-bell').click();
    expect(stubs.Notify.togglePanel).toHaveBeenCalledTimes(1);

    // panel background click (target === panel) closes it and resets scroll
    document.getElementById('notification-panel').click();
    expect(document.getElementById('notification-panel').classList.contains('active')).toBe(false);
    // inner content click: not the panel itself → no close
    document.getElementById('notification-panel').classList.add('active');
    document.getElementById('panel-inner').click();
    expect(document.getElementById('notification-panel').classList.contains('active')).toBe(true);

    // close button
    document.getElementById('notif-close').click();
    expect(document.getElementById('notification-panel').classList.contains('active')).toBe(false);

    // resetShellScrollTwice: sync call + rAF-scheduled second call
    await settle(80);
    expect(stubs.resetShellScroll.mock.calls.length).toBeGreaterThanOrEqual(4); // panel + close, each twice
  });

  it('mark-all / mark-read drive Notify and the tray badge', async () => {
    const { window, stubs, document } = await mount({ notifications: [
      { read: false }, { read: false }, { read: false },
    ] });
    // badge shows the unread count and drops hidden
    const badge = document.getElementById('notif-badge');
    expect(badge.textContent).toBe('3');
    expect(badge.classList.contains('hidden')).toBe(false);

    document.getElementById('notif-mark-all').click();
    expect(stubs.Notify.clearAll).toHaveBeenCalledTimes(1);
    document.getElementById('notif-mark-read').click();
    expect(stubs.Notify.markAllRead).toHaveBeenCalledTimes(1);

    // 15 unread → capped at 9+
    stubs.OS.notifications = Array.from({ length: 15 }, () => ({ read: false }));
    document.getElementById('notif-mark-read').click();
    expect(badge.textContent).toBe('9+');

    // null notifications → the || [] fallback keeps the badge hidden
    stubs.OS.notifications = null;
    document.getElementById('notif-mark-read').click();
    expect(badge.classList.contains('hidden')).toBe(true);

    // badge missing → updateNotificationBadge returns early (no throw)
    badge.remove();
    document.getElementById('notif-mark-read').click();
    expect(stubs.Notify.markAllRead).toHaveBeenCalledTimes(4);
  });

  it('hijacks keys while the setup window is fullscreen, then releases', async () => {
    const setupState = { appId: 'com.nbosp.setup', fullscreen: true, element: null };
    // w2: same app id but NOT fullscreen → the &&'s fullscreen side is false
    const partSetup = { appId: 'com.nbosp.setup', fullscreen: false, element: null };
    const { window, stubs, document } = await mount({ windows: new Map([['w2', partSetup], ['w1', setupState]]) });
    // swallowed: no files window, no context-menu close, no lock
    key(window, { key: 'e', ctrlKey: true });
    key(window, { key: 'Escape' });
    expect(stubs.WM.createWindow).not.toHaveBeenCalled();
    expect(stubs.ContextMenu.hide).not.toHaveBeenCalled();
    // plain letters flow through the setup guard untouched
    key(window, { key: 'a' });
    expect(stubs.WM.createWindow).not.toHaveBeenCalled();
    // once the real setup window closes, the same keys flow again (w2 is
    // same-app but not fullscreen → some() stays false)
    stubs.OS.windows.delete('w1');
    key(window, { key: 'e', ctrlKey: true });
    expect(stubs.WM.createWindow).toHaveBeenCalledWith('com.nbosp.files');
  });

  it('routes the full keyboard shortcut map', async () => {
    const { window, stubs, document } = await mount();
    const WM = stubs.WM;
    key(window, { key: 'e', ctrlKey: true }); expect(WM.createWindow).toHaveBeenLastCalledWith('com.nbosp.files');
    key(window, { key: 't', ctrlKey: true, altKey: true }); expect(WM.createWindow).toHaveBeenLastCalledWith('com.nbosp.terminal');
    key(window, { key: 'l', ctrlKey: true }); expect(stubs.LockScreenService.lockScreen).toHaveBeenCalledTimes(1);
    key(window, { key: 'd', ctrlKey: true }); expect(WM.minimizeAll).toHaveBeenCalledTimes(1);
    key(window, { key: 'PrintScreen' }); expect(stubs.ScreenshotService.capture).toHaveBeenLastCalledWith('desktop');
    key(window, { key: 'PrintScreen', altKey: true }); expect(stubs.ScreenshotService.capture).toHaveBeenLastCalledWith('window');
    key(window, { key: 's', ctrlKey: true, shiftKey: true }); expect(stubs.ScreenshotService.capture).toHaveBeenLastCalledWith('region');
    key(window, { key: 'Tab', altKey: true }); expect(stubs.LauncherShell.showAppSwitcher).toHaveBeenCalledTimes(1);
    key(window, { key: 'ArrowLeft', ctrlKey: true }); expect(stubs.LauncherShell.switchWorkspace).toHaveBeenLastCalledWith(-1);
    key(window, { key: 'ArrowRight', ctrlKey: true }); expect(stubs.LauncherShell.switchWorkspace).toHaveBeenLastCalledWith(1);
    key(window, { key: 'Escape' }); expect(stubs.ContextMenu.hide).toHaveBeenCalledTimes(1);
    key(window, { key: 'F3' }); expect(stubs.DebugOverlay.toggle).toHaveBeenCalledTimes(1);
    key(window, { key: 'D', ctrlKey: true, shiftKey: true });
    expect(stubs.DebugOverlay._copyDebugInfo).toHaveBeenCalledTimes(1);
    expect(stubs.Notify.show).toHaveBeenCalledTimes(1);
  });

  it('alt+F4 closes the focused window when one exists', async () => {
    const { window, stubs, document } = await mount({ focusedWindowId: 'w-9' });
    key(window, { key: 'F4', altKey: true });
    expect(stubs.WM.closeWindow).toHaveBeenCalledWith('w-9');
    // no focused window: guard skips without throwing
    stubs.OS.focusedWindowId = null;
    key(window, { key: 'F4', altKey: true });
    expect(stubs.WM.closeWindow).toHaveBeenCalledTimes(1);
  });

  it('does not hijack editor shortcuts while typing in an app', async () => {
    const { window, stubs, document } = await mount();
    const editor = document.getElementById('editor');
    editor.focus(); // activeElement inside .window-content
    expect(document.activeElement === editor).toBe(true);
    // conflicting editor shortcut → returned untouched
    key(window, { key: 'l', ctrlKey: true });
    expect(stubs.LockScreenService.lockScreen).not.toHaveBeenCalled();
    // non-conflicting ctrl+t (terminal) still flows from inside the app
    key(window, { key: 't', ctrlKey: true, altKey: true });
    expect(stubs.WM.createWindow).toHaveBeenLastCalledWith('com.nbosp.terminal');
    // meta+l conflicts the same way ctrl+l does
    key(window, { key: 'l', metaKey: true });
    expect(stubs.LockScreenService.lockScreen).toHaveBeenCalledTimes(0);
    // always-allowed keys flow even inside content
    key(window, { key: 'F4', altKey: true });
    expect(stubs.WM.closeWindow).not.toHaveBeenCalled(); // no focused window in this mount
    key(window, { key: 'Escape' });
    expect(stubs.ContextMenu.hide).toHaveBeenCalledTimes(1);
  });

  it('resizes maximized and normal windows to the work area', async () => {
    // state.element only needs a style object for the assignment path
    const { window, stubs, document } = await mount({ windows: new Map([
      ['max', { maximized: true, x: 0, y: 0, width: 100, height: 100, element: { style: {} } }],
      ['norm', { maximized: false, x: -50, y: -50, width: 2000, height: 2000, element: { style: {} } }],
    ]) });
    window.dispatchEvent(new window.Event('resize'));
    const max = stubs.OS.windows.get('max');
    const norm = stubs.OS.windows.get('norm');
    expect(max.width).toBe(1024); expect(max.height).toBe(768); // work area
    expect(max.element.style.width).toBe('1024px');
    expect(norm.x).toBe(0); expect(norm.y).toBe(0); // clampWindowRect stub clamps
    expect(stubs.WM.getWorkArea).toHaveBeenCalledTimes(1);
    expect(stubs.WM.hideSnapPreview).toHaveBeenCalledTimes(1);
    // no OS.windows → early return (no throw)
    stubs.OS.windows = null;
    window.dispatchEvent(new window.Event('resize'));
    expect(stubs.WM.hideSnapPreview).toHaveBeenCalledTimes(1); // unchanged
  });

  it('reschedules on settings:changed; relabels the launchpad and refreshes the taskbar', async () => {
    const handlers = {};
    const events = { on: vi.fn((t, h) => { handlers[t] = h; }) };
    const { window, stubs, document } = await mount({ events });
    expect(events.on).toHaveBeenCalledWith('settings:changed', expect.any(Function));
    const handler = handlers['settings:changed'];

    // devMode change with launchpad active → relabel + taskbar refresh
    handler({ key: 'devMode' });
    expect(stubs.renderLaunchpad).toHaveBeenCalledTimes(1);
    expect(stubs.WM.updateTaskbar).toHaveBeenCalledTimes(1);

    // devMode change with launchpad closed → taskbar only
    document.getElementById('launchpad').classList.remove('active');
    handler({ key: 'devMode' });
    expect(stubs.renderLaunchpad).toHaveBeenCalledTimes(1); // unchanged
    expect(stubs.WM.updateTaskbar).toHaveBeenCalledTimes(2);

    // unrelated key → early return
    handler({ key: 'wallpaper' });
    expect(stubs.WM.updateTaskbar).toHaveBeenCalledTimes(2);
  });

  it('bootstraps the background email service exactly once per context', async () => {
    // first boot: patches the startup flag and calls ensureBooted
    const ensureBooted = vi.fn();
    const { window } = await mount({ extra: { __NBOSP_BG: { email: { ensureBooted } } } });
    expect(ensureBooted).toHaveBeenCalledTimes(1);
    expect(window.__NBOSP_BG.email.__patchedStartup).toBe(true);

    // already patched → skipped
    const ensure2 = vi.fn();
    const second = await mount({ extra: { __NBOSP_BG: { email: { __patchedStartup: true, ensureBooted: ensure2 } } } });
    expect(ensure2).not.toHaveBeenCalled();

    // a frozen context makes the bootstrap throw → silently swallowed
    const third = await mount({ extra: { __NBOSP_BG: Object.freeze({}) } });
    // the initial assignment kept the frozen object; bg.email = … threw
    expect(third.window.__NBOSP_BG).toEqual({});
    expect(third.window.__NBOSP_BG.email).toBeUndefined();
    // without any bg object: created empty, ensureBooted absent → optional call skipped
    const fourth = await mount();
    expect(fourth.window.__NBOSP_BG.email.__patchedStartup).toBe(true);
  });

  it('resetShellScrollTwice is a no-op without a scroll function', async () => {
    const { window, stubs, document } = await mount();
    // hide the window function → the guard returns early (no throw, no rAF)
    delete window.resetShellScroll;
    delete globalThis.resetShellScroll;
    document.getElementById('notification-panel').click();
    expect(document.getElementById('notification-panel').classList.contains('active')).toBe(false);
  });

  it('ctrl+shift+D without the debug overlay is silent', async () => {
    const { window, stubs, document } = await mount();
    delete window.DebugOverlay; // the whole overlay absent (optional-chain null side)
    delete globalThis.window.DebugOverlay;
    key(window, { key: 'D', ctrlKey: true, shiftKey: true });
    expect(stubs.Notify.show).not.toHaveBeenCalled();
    // and a ctrl+D without shift is not the copy shortcut either
    key(window, { key: 'D', ctrlKey: true });
    expect(stubs.Notify.show).not.toHaveBeenCalled();
    expect(stubs.DebugOverlay._copyDebugInfo).not.toHaveBeenCalled();
  });

  it('shortcuts flow when OS.windows is null, and a missing launchpad skips the relabel', async () => {
    const handlers = {};
    const events = { on: vi.fn((t, h) => { handlers[t] = h; }) };
    const html = PANEL_HTML.replace('<div id="launchpad" class="active">launchpad</div>', '');
    const { window, stubs, document } = await mount({ events, html });
    // no OS.windows at all → the keydown guard falls back to []
    stubs.OS.windows = null;
    key(window, { key: 'e', ctrlKey: true });
    expect(stubs.WM.createWindow).toHaveBeenCalledWith('com.nbosp.files');
    // devMode change with no #launchpad element → relabel skipped, taskbar still refreshed
    handlers['settings:changed']({ key: 'devMode' });
    expect(stubs.renderLaunchpad).not.toHaveBeenCalled();
    expect(stubs.WM.updateTaskbar).toHaveBeenCalledTimes(1);
    // and with WM gone entirely, the optional chain skips the taskbar call
    globalThis.WM = undefined; // present-but-undefined: ?. short-circuits
    handlers['settings:changed']({ key: 'devMode' });
    expect(stubs.WM.updateTaskbar).toHaveBeenCalledTimes(1); // unchanged
  });
});
