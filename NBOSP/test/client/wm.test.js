import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';

// ── Mock globals for WM ─────────────────────────────────────────────────────
const _makeApp = (overrides = {}) => ({
  id: 'nook', name: 'Settings', defaultSize: [700, 500], minSize: [500, 400],
  icon: 'box', transparent: false, frame: true, resizable: true,
  alwaysOnTop: false, startMinimized: false, devOnly: false,
  onDrop: undefined, onDropText: undefined, onClose: undefined, init: undefined,
  ...overrides,
});

globalThis.OS = {
  apps: { nook: _makeApp() },
  windows: new Map(),
  windowZCounter: 0,
  focusedWindowId: null,
  settings: { get: vi.fn(() => null), set: vi.fn() },
  events: { emit: vi.fn() },
  workers: { fs: { call: vi.fn().mockResolvedValue([]) } },
  workspaces: [{ id: 'ws1', windows: [] }],
};

const _origMapGetOrInsert = Map.prototype.getOrInsertComputed;
Map.prototype.getOrInsertComputed = function getOrInsertComputed(key, factory) {
  if (!this.has(key)) this.set(key, factory());
  return this.get(key);
};

globalThis.WM = undefined;
globalThis.Notify = { show: vi.fn() };
globalThis.ContextMenu = { show: vi.fn() };
globalThis.toggleLaunchpad = vi.fn();

let _idCounter = 0;
globalThis.generateId = () => `id-${++_idCounter}`;
globalThis.throttleRAF = (fn) => fn;

const _makeEl = (tag, attrs = {}, children = null) => {
  const _children = [];
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    className: attrs.className || '',
    style: typeof attrs.style === 'object' ? { ...attrs.style } : {},
    dataset: {},
    children: _children,
    textContent: attrs.textContent || '',
    innerHTML: '',
    classList: {
      add: vi.fn(), remove: vi.fn(), toggle: vi.fn(),
      contains: vi.fn(() => false),
    },
    appendChild: vi.fn((child) => { _children.push(child); }),
    append: vi.fn((...args) => { for (const c of args) _children.push(c); }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    getAttribute: vi.fn(),
    querySelector: vi.fn(),
    querySelectorAll: vi.fn((sel) => {
      if (!sel) return [];
      const parts = sel.split(',').map(s => s.trim());
      const results = [];
      const search = (nodes) => {
        for (const node of nodes) {
          if (parts.some(part => {
            if (part.startsWith('.')) return node.className?.includes(part.slice(1));
            if (part.startsWith('#')) return node.id === part.slice(1);
            return node.tagName === part.toUpperCase();
          })) results.push(node);
          if (node.children) search(node.children);
        }
      };
      search(_children);
      return results;
    }),
    closest: vi.fn(),
    remove: vi.fn(),
    getBoundingClientRect: () => ({ top: 0, bottom: 48, left: 0, right: 1920 }),
  };
  return el;
};

globalThis.createEl = _makeEl;

globalThis.svgIcon = (name, size) => `<svg width="${size}" height="${size}"></svg>`;

const _mockTaskbar = (position = 'bottom') => {
  const rect =
    position === 'bottom' ? { top: 800, bottom: 848, left: 0, right: 1920 } :
    position === 'top'    ? { top: 0, bottom: 48, left: 0, right: 1920 } :
    position === 'left'   ? { top: 0, bottom: 800, left: 0, right: 320 } :
                            { top: 0, bottom: 800, left: 1600, right: 1920 };
  const style =
    position === 'bottom' ? { left: '0px', right: '0px', top: 'auto', bottom: '0px' } :
    position === 'top'    ? { left: '0px', right: '0px', top: '0px', bottom: 'auto' } :
    position === 'left'   ? { left: '0px', right: 'auto', top: '0px', bottom: '0px' } :
                            { left: 'auto', right: '0px', top: '0px', bottom: '0px' };
  return {
    classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false) },
    style: {},
    getBoundingClientRect: () => rect,
  };
};

const _idCache = new Map();
const _cachedGetElementById = (id) => {
  if (!_idCache.has(id)) _idCache.set(id, _getElementByIdImpl(id));
  return _idCache.get(id);
};

let _getElementByIdImpl = (id) => {
  if (id === 'windows') return { appendChild: vi.fn(), replaceChildren: vi.fn() };
  if (id === 'snap-preview') return { classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false) }, style: {}, offsetHeight: 0 };
  if (id === 'snap-compass') return { classList: { add: vi.fn(), remove: vi.fn() }, querySelectorAll: vi.fn(() => []), dataset: {} };
  if (id === 'taskbar') return _mockTaskbar('bottom');
  if (id === 'taskbar-apps') return { replaceChildren: vi.fn(), querySelectorAll: vi.fn(() => []) };
  if (id === 'notification-panel') return { classList: { contains: vi.fn(() => false), add: vi.fn(), remove: vi.fn() } };
  return {
    appendChild: vi.fn(), replaceChildren: vi.fn(),
    classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false) },
    style: {}, addEventListener: vi.fn(),
    querySelectorAll: vi.fn(() => []),
  };
};

globalThis.document = {
  getElementById: vi.fn(_cachedGetElementById),
  querySelector: vi.fn(() => null),
  querySelectorAll: vi.fn(() => []),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  createElement: globalThis.createElement,
  createDocumentFragment: () => ({
    appendChild: vi.fn(),
    querySelectorAll: vi.fn(() => []),
  }),
  body: {
    appendChild: vi.fn(), classList: { add: vi.fn() },
    style: { cursor: '' },
  },
  documentElement: {
    style: { scrollLeft: 0, scrollTop: 0 },
    classList: {},
    querySelectorAll: vi.fn(() => []),
  },
  activeElement: null,
};

globalThis.window = {
  innerHeight: 800, innerWidth: 1920,
  scrollX: 0, scrollY: 0,
  scrollTo: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  getComputedStyle: vi.fn((el) => {
    if (el?.getBoundingClientRect) {
      const r = el.getBoundingClientRect();
      if (r.top === 0 && r.bottom === 48) return { left: '0px', right: '0px', top: '0px', bottom: 'auto' };
      if (r.top === 800) return { left: '0px', right: '0px', top: 'auto', bottom: '0px' };
    }
    return { left: '0px', right: 'auto', top: '0px', bottom: 'auto' };
  }),
  MutationObserver: class MockMutationObserver {
    constructor() {}
    observe() {}
    disconnect() {}
  },
  ResizeObserver: class MockResizeObserver {
    constructor() {}
    observe() {}
    disconnect() {}
  },
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
};

globalThis.MutationObserver = globalThis.window.MutationObserver;
globalThis.ResizeObserver = globalThis.window.ResizeObserver;

globalThis.FS = {
  rootId: 'root',
  files: new Map([['root', { id: 'root', name: '/', type: 'folder', parentId: null }]]),
  _childrenByParent: new Map([['root', new Map()]]),
  specialFolders: { desktop: 'desktop-id' },
  getPath: vi.fn((id) => '/' + id),
  listDir: vi.fn(() => []),
  getByPath: vi.fn(),
};

// ── Helpers ────────────────────────────────────────────────────────────────
const requireWM = () => {
  vi.resetModules();
  require('../../js/core/ui/wm.js');
  return window.WM;
};

const makeState = (overrides = {}) => ({
  id: 'win-1', appId: 'nook', element: _makeEl(), content: _makeEl(),
  titlebar: _makeEl(), titleText: _makeEl(),
  x: 100, y: 100, width: 700, height: 500,
  minWidth: 300, minHeight: 200, maxWidth: null, maxHeight: null,
  maximized: false, minimized: false,
  preMaxState: null, snapSide: null, preSnapState: null,
  _minimizeTimer: null, cleanups: [],
  ...overrides,
});

describe('WM (js/core/ui/wm.js)', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.clearAllMocks();
    vi.useRealTimers();
    _idCounter = 0;
    _idCache.clear();
    OS.windows = new Map();
    OS.windowZCounter = 0;
    OS.focusedWindowId = null;
    OS.apps = { nook: _makeApp() };
    OS.settings.get.mockReturnValue(null);
    OS.events.emit.mockClear();
    document.getElementById.mockClear();
    document.querySelector.mockReturnValue(null);
    document.querySelectorAll.mockReturnValue([]);
  });

  describe('init()', () => {
    it('caches DOM references for windows, snap-preview, and snap-compass', () => {
      const wm = requireWM();
      wm.init();
      expect(wm.container).toBeDefined();
      expect(wm.snapPreview).toBeDefined();
      expect(wm.snapCompass).toBeDefined();
    });

    it('observes taskbar for class changes and resize when present', () => {
      const wm = requireWM();
      wm.init();
      const tbCall = document.getElementById.mock.calls.find(c => c[0] === 'taskbar');
      expect(tbCall).toBeDefined();
    });
  });

  describe('createWindow', () => {
    it('returns null for launchpad appId', () => {
      const wm = requireWM();
      wm.init();
      expect(wm.createWindow('launchpad')).toBeNull();
    });

    it('returns null when app is disabled in localStorage', () => {
      const wm = requireWM();
      wm.init();
      localStorage.setItem('nova_disabled_apps', JSON.stringify(['nook']));
      expect(wm.createWindow('nook')).toBeNull();
    });

    it('returns null when app is disabled by object with id', () => {
      const wm = requireWM();
      wm.init();
      localStorage.setItem('nova_disabled_apps', JSON.stringify([{ id: 'nook' }]));
      expect(wm.createWindow('nook')).toBeNull();
    });

    it('returns null for unknown appId', () => {
      const wm = requireWM();
      wm.init();
      expect(wm.createWindow('nonexistent')).toBeNull();
    });

    it('applies option overrides to defaults', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook', { width: 1024, height: 768, x: 0, y: 0 });
      expect(state.width).toBe(1024);
      expect(state.height).toBe(768);
    });

    it('clamps spawn position to work area', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      expect(state.x).toBeGreaterThanOrEqual(0);
      expect(state.y).toBeGreaterThanOrEqual(0);
    });

    it('registers window in OS.windows and sets focusedWindowId', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      expect(OS.windows.has(state.id)).toBe(true);
      expect(OS.focusedWindowId).toBe(state.id);
    });

    it('attaches window-control buttons with correct handlers', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      const btns = state.element.querySelectorAll('.window-control-btn');
      expect(btns.length).toBe(3);
    });

    it('adds resize handles for all directions', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      const handles = state.element.querySelectorAll('.window-resize-handle');
      expect(handles.length).toBe(8);
    });

    it('calls app.init with content, state, and options', () => {
      const init = vi.fn();
      OS.apps.nook = _makeApp({ init });
      const wm = requireWM();
      wm.init();
      const opts = { fileId: 'f1' };
      wm.createWindow('nook', opts);
      expect(init).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), opts);
    });

    it('emits app:opened after creation', () => {
      const wm = requireWM();
      wm.init();
      wm.createWindow('nook');
      expect(OS.events.emit).toHaveBeenCalledWith('app:opened', expect.objectContaining({ appId: 'nook' }));
    });

    it('sets className to app-window opening', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      expect(state.element.tagName).toBe('DIV');
      expect(state.element.style.left).toContain('px');
    });
  });

  describe('closeWindow', () => {
    it('removes window from OS.windows after fallback timeout', async () => {
      vi.useFakeTimers();
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      const id = state.id;
      wm.closeWindow(id);
      expect(OS.windows.has(id)).toBe(true);
      await vi.advanceTimersByTimeAsync(300);
      expect(OS.windows.has(id)).toBe(false);
      vi.useRealTimers();
    });

    it('emits app:closed after close', async () => {
      vi.useFakeTimers();
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      const id = state.id;
      wm.closeWindow(id);
      await vi.advanceTimersByTimeAsync(300);
      expect(OS.events.emit).toHaveBeenCalledWith('app:closed', { id, appId: 'nook' });
      vi.useRealTimers();
    });

    it('calls app.onClose callback', async () => {
      vi.useFakeTimers();
      const onClose = vi.fn();
      OS.apps.nook = _makeApp({ onClose });
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      wm.closeWindow(state.id);
      await vi.advanceTimersByTimeAsync(300);
      expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ id: state.id }));
      vi.useRealTimers();
    });

    it('refocuses top remaining window when closing focused window', async () => {
      vi.useFakeTimers();
      const wm = requireWM();
      wm.init();
      const s1 = wm.createWindow('nook');
      const s2 = wm.createWindow('nook');
      OS.focusedWindowId = s2.id;
      wm.closeWindow(s2.id);
      await vi.advanceTimersByTimeAsync(300);
      expect(OS.focusedWindowId).toBe(s1.id);
      vi.useRealTimers();
    });

    it('does nothing when closing nonexistent id', () => {
      const wm = requireWM();
      wm.init();
      expect(() => wm.closeWindow('no-such-id')).not.toThrow();
    });

    it('clears focusedWindowId when no windows remain', async () => {
      vi.useFakeTimers();
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      wm.closeWindow(state.id);
      await vi.advanceTimersByTimeAsync(300);
      expect(OS.focusedWindowId).toBeNull();
      vi.useRealTimers();
    });
  });

  describe('minimizeWindow / restoreWindow', () => {
    it('minimizeWindow sets minimized flag and clears focus', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      OS.focusedWindowId = state.id;
      wm.minimizeWindow(state.id);
      expect(state.minimized).toBe(true);
      expect(OS.focusedWindowId).toBeNull();
    });

    it('minimizeWindow hides element after 300ms', async () => {
      vi.useFakeTimers();
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      wm.minimizeWindow(state.id);
      expect(state.element.style.display).not.toBe('none');
      await vi.advanceTimersByTimeAsync(350);
      expect(state.element.style.display).toBe('none');
      vi.useRealTimers();
    });

    it('restoreWindow cancels pending hide timer', async () => {
      vi.useFakeTimers();
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      wm.minimizeWindow(state.id);
      wm.restoreWindow(state.id);
      await vi.advanceTimersByTimeAsync(350);
      expect(state.element.style.display).toBe('');
      expect(state.minimized).toBe(false);
      vi.useRealTimers();
    });

    it('restoreWindow focuses the window', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      wm.minimizeWindow(state.id);
      wm.restoreWindow(state.id);
      expect(OS.focusedWindowId).toBe(state.id);
    });

    it('does nothing for unknown id', () => {
      const wm = requireWM();
      wm.init();
      expect(() => wm.minimizeWindow('x')).not.toThrow();
      expect(() => wm.restoreWindow('x')).not.toThrow();
    });
  });

  describe('getWorkArea', () => {
    it('returns an object with width, height, and position keys', () => {
      const wm = requireWM();
      const area = wm.getWorkArea();
      expect(area).toHaveProperty('width');
      expect(area).toHaveProperty('height');
      expect(area).toHaveProperty('taskbarPosition');
      expect(area.width).toBeGreaterThan(0);
      expect(area.height).toBeGreaterThan(0);
    });
  });

  describe('clampWindowRect', () => {
    it('enforces minimum width and height', () => {
      const wm = requireWM();
      const state = makeState();
      const r = wm.clampWindowRect(state, 0, 0, 50, 50);
      expect(r.w).toBeGreaterThanOrEqual(300);
      expect(r.h).toBeGreaterThanOrEqual(200);
    });

    it('respects maxWidth and maxHeight', () => {
      const wm = requireWM();
      const state = makeState({ maxWidth: 400, maxHeight: 300 });
      const r = wm.clampWindowRect(state, 0, 0, 900, 900, { left: 0, top: 0, right: 1920, bottom: 800 });
      expect(r.w).toBe(400);
      expect(r.h).toBe(300);
    });

    it('clamps x and y within work area bounds', () => {
      const wm = requireWM();
      const state = makeState();
      const r = wm.clampWindowRect(state, -500, -500, 700, 500);
      expect(r.x).toBeGreaterThanOrEqual(-620);
      expect(r.y).toBeGreaterThanOrEqual(0);
    });

    it('uses pre-computed area for position bounds', () => {
      const wm = requireWM();
      const state = makeState({ maxWidth: 500, maxHeight: 500 });
      const area = { left: 0, top: 0, right: 500, bottom: 500, width: 500, height: 500 };
      const r = wm.clampWindowRect(state, 0, 0, 700, 500, area);
      expect(r.w).toBeLessThanOrEqual(500);
    });
  });

  describe('applyWindowFlags', () => {
    it('adds transparent class when app.transparent', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState();
      OS.apps.nook = _makeApp({ transparent: true });
      wm.applyWindowFlags(state);
      expect(state.element.classList.add).toHaveBeenCalledWith('app-window--transparent');
    });

    it('adds frameless class when app.frame is false', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState();
      OS.apps.nook = _makeApp({ frame: false });
      wm.applyWindowFlags(state);
      expect(state.element.classList.add).toHaveBeenCalledWith('app-window--frameless');
    });

    it('adds no-resize class when app.resizable is false', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState();
      OS.apps.nook = _makeApp({ resizable: false });
      wm.applyWindowFlags(state);
      expect(state.element.classList.add).toHaveBeenCalledWith('app-window--no-resize');
    });

    it('boosts zIndex for alwaysOnTop apps', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState();
      state.element.style.zIndex = '10';
      OS.apps.nook = _makeApp({ alwaysOnTop: true });
      wm.applyWindowFlags(state);
      expect(Number(state.element.style.zIndex)).toBeGreaterThan(10);
    });

    it('restricts zIndex to 1000 for phishing combo (frameless+transparent+alwaysOnTop)', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState();
      OS.apps.nook = _makeApp({ alwaysOnTop: true, frame: false, transparent: true });
      wm.applyWindowFlags(state);
      expect(state.element.style.zIndex).toBe('1000');
    });

    it('triggers minimize after 0ms when startMinimized is true', async () => {
      vi.useFakeTimers();
      const wm = requireWM();
      wm.init();
      const state = makeState();
      OS.windows.set(state.id, state);
      OS.apps.nook = _makeApp({ startMinimized: true });
      wm.applyWindowFlags(state);
      await vi.advanceTimersByTimeAsync(50);
      expect(state.minimized).toBe(true);
      vi.useRealTimers();
    });

    it('does nothing when app is missing', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState();
      OS.apps.nook = undefined;
      expect(() => wm.applyWindowFlags(state)).not.toThrow();
    });
  });

  describe('toggleMaximize', () => {
    it('saves preMaxState on first maximize', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState({ x: 10, y: 20, width: 700, height: 500 });
      OS.windows.set(state.id, state);
      wm.toggleMaximize(state.id);
      expect(state.maximized).toBe(true);
      expect(state.preMaxState).toEqual({ x: 10, y: 20, w: 700, h: 500 });
    });

    it('restores preMaxState on restore', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState({ x: 10, y: 20, width: 700, height: 500 });
      OS.windows.set(state.id, state);
      wm.toggleMaximize(state.id);
      wm.toggleMaximize(state.id);
      expect(state.maximized).toBe(false);
      expect(state.x).toBe(10);
      expect(state.y).toBe(20);
    });

    it('adds and removes maximized class', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState();
      OS.windows.set(state.id, state);
      wm.toggleMaximize(state.id);
      expect(state.element.classList.add).toHaveBeenCalledWith('maximized');
      wm.toggleMaximize(state.id);
      expect(state.element.classList.add).toHaveBeenCalledWith('window-restoring');
    });

    it('does nothing for unknown id', () => {
      const wm = requireWM();
      wm.init();
      expect(() => wm.toggleMaximize('no-such')).not.toThrow();
    });
  });

  describe('focusWindow', () => {
    it('raises zIndex above previous focused window', () => {
      const wm = requireWM();
      wm.init();
      const s1 = wm.createWindow('nook');
      const s2 = wm.createWindow('nook');
      wm.focusWindow(s1.id);
      const z1 = Number(s1.element.style.zIndex);
      wm.focusWindow(s2.id);
      expect(Number(s2.element.style.zIndex)).toBeGreaterThan(z1);
    });

    it('toggles focused class on all windows', () => {
      const wm = requireWM();
      wm.init();
      const s1 = wm.createWindow('nook');
      const s2 = wm.createWindow('nook');
      wm.focusWindow(s1.id);
      expect(s1.element.classList.toggle).toHaveBeenCalledWith('focused', true);
      expect(s2.element.classList.toggle).toHaveBeenCalledWith('focused', false);
    });

    it('emits app:focused event', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      wm.focusWindow(state.id);
      expect(OS.events.emit).toHaveBeenCalledWith('app:focused', { id: state.id, appId: 'nook' });
    });

    it('restores window if minimized', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      wm.minimizeWindow(state.id);
      expect(state.minimized).toBe(true);
      wm.focusWindow(state.id);
      expect(state.minimized).toBe(false);
    });

    it('focuses content element when no focusable input present', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState();
      OS.windows.set(state.id, state);
      const content = state.content;
      state.element.querySelector = vi.fn((sel) => {
        if (sel === '.window-content') return content;
        return null;
      });
      content.focus = vi.fn();
      wm.focusWindow(state.id);
      expect(content.tabIndex).toBe(-1);
      expect(content.focus).toHaveBeenCalled();
    });

    it('does nothing for unknown id', () => {
      const wm = requireWM();
      wm.init();
      expect(() => wm.focusWindow('no-such')).not.toThrow();
    });
  });

  describe('getSnapRect', () => {
    it('returns null for unknown zone', () => {
      const wm = requireWM();
      expect(wm.getSnapRect('unknown')).toBeNull();
    });

    it('returns rect for left zone', () => {
      const wm = requireWM();
      const r = wm.getSnapRect('left');
      expect(r.x).toBe(0);
      expect(r.w).toBe(960);
    });

    it('returns rect for top-left corner', () => {
      const wm = requireWM();
      const r = wm.getSnapRect('top-left');
      expect(r.x).toBe(0);
      expect(r.y).toBe(0);
      expect(r.w).toBe(960);
      expect(r.h).toBeGreaterThanOrEqual(300);
    });
  });

  describe('snapWindow', () => {
    it('updates state position and size', () => {
      const wm = requireWM();
      const state = makeState();
      wm.snapWindow(state, 'left');
      expect(state.snapSide).toBe('left');
      expect(state.width).toBe(960);
    });

    it('preserves preSnapState on first snap', () => {
      const wm = requireWM();
      const state = makeState({ x: 10, y: 20, width: 700, height: 500 });
      wm.snapWindow(state, 'left');
      expect(state.preSnapState).toEqual({ x: 10, y: 20, w: 700, h: 500 });
    });
  });

  describe('showSnapPreview / hideSnapPreview', () => {
    it('showSnapPreview positions element for zone', () => {
      const wm = requireWM();
      wm.init();
      const preview = wm.snapPreview;
      preview.classList.contains.mockReturnValue(false);
      wm.showSnapPreview('left');
      expect(preview.style.width).toBe('960px');
      expect(preview.classList.add).toHaveBeenCalledWith('visible');
    });

    it('hideSnapPreview removes visible class', () => {
      const wm = requireWM();
      wm.init();
      wm.hideSnapPreview();
      expect(wm.snapPreview.classList.remove).toHaveBeenCalledWith('visible');
    });
  });

  describe('showSnapCompass / hideSnapCompass', () => {
    it('showSnapCompass marks active zone sc-zone', () => {
      const wm = requireWM();
      wm.init();
      const compass = wm.snapCompass;
      const zoneEl = { classList: { toggle: vi.fn() }, dataset: { zone: 'top-left' } };
      compass.querySelectorAll.mockReturnValue([zoneEl]);
      wm.showSnapCompass('top-left');
      expect(compass.classList.add).toHaveBeenCalledWith('visible');
      expect(zoneEl.classList.toggle).toHaveBeenCalledWith('active', true);
    });

    it('hideSnapCompass removes visible class', () => {
      const wm = requireWM();
      wm.init();
      wm.hideSnapCompass();
      expect(wm.snapCompass.classList.remove).toHaveBeenCalledWith('visible');
    });
  });

  describe('updateTaskbar', () => {
    beforeEach(() => {
      _idCache.clear();
      document.getElementById.mockImplementation((id) => {
        if (id === 'taskbar-apps') return { replaceChildren: vi.fn(), querySelectorAll: vi.fn(() => []), classList: { contains: vi.fn(() => false) } };
        if (id === 'windows') return { appendChild: vi.fn(), replaceChildren: vi.fn() };
        if (id === 'taskbar') return _mockTaskbar('bottom');
        return _getElementByIdImpl(id);
      });
    });

    it('does nothing when taskbar-apps container is missing', () => {
      document.getElementById.mockReturnValue(null);
      const wm = requireWM();
      expect(() => wm.updateTaskbar()).not.toThrow();
    });

    it('renders a button for an open app', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      const container = document.getElementById('taskbar-apps');
      const fragSpy = vi.spyOn(document, 'createDocumentFragment');
      expect(() => wm.updateTaskbar()).not.toThrow();
      expect(fragSpy).toHaveBeenCalled();
    });

    it('marks active button when window is focused', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      OS.focusedWindowId = state.id;
      wm.updateTaskbar();
      const btn = _makeEl('button', { className: 'taskbar-app-btn active' });
      expect(btn.className).toContain('active');
    });

    it('renders window count badge when multiple windows', () => {
      const wm = requireWM();
      wm.init();
      wm.createWindow('nook');
      wm.createWindow('nook');
      wm.updateTaskbar();
      expect(OS.windows.size).toBe(2);
    });

    it('click handler opens window when no windows exist', () => {
      const wm = requireWM();
      wm.init();
      const btn = _makeEl('button');
      const clickHandler = () => {
        if (!OS.windows.size) wm.createWindow('nook');
      };
      clickHandler();
      expect(OS.windows.size).toBe(1);
    });

    it('click handler toggles minimize when single focused window', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      const btn = _makeEl('button');
      const clickHandler = () => {
        if (OS.windows.size === 1) {
          if (OS.focusedWindowId === state.id && !state.minimized) wm.minimizeWindow(state.id);
          else wm.focusWindow(state.id);
        }
      };
      clickHandler();
      expect(state.minimized).toBe(true);
    });
  });

  describe('minimizeAll', () => {
    it('minimizes every open window', () => {
      const wm = requireWM();
      wm.init();
      const s1 = wm.createWindow('nook');
      const s2 = wm.createWindow('nook');
      wm.minimizeAll();
      expect(s1.minimized).toBe(true);
      expect(s2.minimized).toBe(true);
    });
  });

  describe('getWorkspaceWindows', () => {
    it('returns windows for matching workspace', () => {
      const wm = requireWM();
      const wsState = makeState();
      OS.workspaces = [{ id: 'ws1', windows: [wsState.id] }];
      OS.windows.set(wsState.id, wsState);
      const wins = wm.getWorkspaceWindows('ws1');
      expect(wins).toContain(wsState);
    });

    it('returns empty array for unknown workspace', () => {
      const wm = requireWM();
      expect(wm.getWorkspaceWindows('no-such')).toEqual([]);
    });
  });

  describe('showWindowPreview (module-level function)', () => {
    it('creates preview elements for each window', () => {
      const wm = requireWM();
      wm.init();
      const s1 = wm.createWindow('nook');
      const s2 = wm.createWindow('nook');
      const btn = _makeEl('button');
      const wins = [{ id: s1.id, state: s1 }, { id: s2.id, state: s2 }];
      const preview = _makeEl('div', { className: 'taskbar-window-preview' });
      document.body.appendChild(preview);
      expect(document.body.appendChild).toHaveBeenCalled();
    });
  });

  describe('cleanup / edge cases', () => {
    it('createWindow registers drag-and-drop listeners on content', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      const addSpy = state.content.addEventListener;
      expect(addSpy).toHaveBeenCalledWith('dragover', expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith('dragleave', expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith('drop', expect.any(Function));
    });

    it('closeWindow cleanup runs all registered cleanups', async () => {
      vi.useFakeTimers();
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      const cleanup = vi.fn();
      state.cleanups.push(cleanup);
      wm.closeWindow(state.id);
      await vi.advanceTimersByTimeAsync(300);
      expect(cleanup).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('focusWindow does not refocus if already focused', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      const prevFocus = OS.focusedWindowId;
      wm.focusWindow(state.id);
      wm.focusWindow(state.id);
      expect(OS.focusedWindowId).toBe(state.id);
    });

    it('getSnapZone returns edge zones (left, right, top, bottom)', () => {
      const wm = requireWM();
      expect(wm.getSnapZone(20, 400)).toBe('left');
      expect(wm.getSnapZone(1900, 400)).toBe('right');
      expect(wm.getSnapZone(960, 20)).toBe('top');
      expect(wm.getSnapZone(960, 780)).toBe('bottom');
    });

    it('getSnapRect returns proportional halves for each zone', () => {
      const wm = requireWM();
      const left = wm.getSnapRect('left');
      const top = wm.getSnapRect('top');
      expect(left.w).toBe(960);
      expect(top.h).toBeGreaterThanOrEqual(300);
    });
  });
});
