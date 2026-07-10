import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';

// ── Mock globals for WM ─────────────────────────────────────────────────────
globalThis.OS = {
  apps: {
    nook: { id: 'nook', name: 'Settings', defaultSize: [700, 500], minSize: [500, 400] },
  },
  windows: new Map(),
  windowZCounter: 0,
  settings: { get: vi.fn(() => null), set: vi.fn() },
  events: { emit: vi.fn() },
};

globalThis.WM = undefined;

globalThis.generateId = () => 'id-' + Math.random().toString(36).slice(2);
globalThis.throttleRAF = (fn) => fn;
globalThis.createEl = (tag, attrs = {}, children = null) => {
  const el = {
    tagName: tag.toUpperCase(),
    className: attrs.className || '',
    style: typeof attrs.style === 'object' ? attrs.style : {},
    dataset: {},
    children: [],
    textContent: attrs.textContent || '',
    innerHTML: '',
    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: vi.fn(() => false) },
    appendChild: vi.fn(),
    append: vi.fn(),
    addEventListener: vi.fn(),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    getAttribute: vi.fn(),
    querySelector: vi.fn(),
    querySelectorAll: vi.fn(() => []),
    closest: vi.fn(),
    remove: vi.fn(),
  };
  return el;
};

globalThis.svgIcon = (name, size) => `<svg width="${size}" height="${size}"></svg>`;

globalThis.document = {
  getElementById: vi.fn((id) => {
    const els = {
      windows: { appendChild: vi.fn(), replaceChildren: vi.fn() },
      snapPreview: { classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false) }, style: {} },
      snapCompass: { classList: { add: vi.fn(), remove: vi.fn() }, querySelectorAll: vi.fn(() => []), dataset: {} },
      taskbar: { classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false) }, style: {}, getBoundingClientRect: () => ({ top: 0, bottom: 48, left: 0, right: 1920 }) },
    };
    return els[id] || {
      appendChild: vi.fn(),
      replaceChildren: vi.fn(),
      classList: { add: vi.fn(), remove: vi.fn() },
      style: {},
      addEventListener: vi.fn(),
    };
  }),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  createElement: globalThis.createElement,
  createDocumentFragment: () => ({
    appendChild: vi.fn(),
    querySelectorAll: vi.fn(() => []),
  }),
  body: { appendChild: vi.fn(), classList: { add: vi.fn() }, style: { cursor: '' } },
  documentElement: { style: {}, classList: {}, querySelectorAll: vi.fn(() => []) },
  activeElement: null,
};

globalThis.window = {
  innerHeight: 800,
  innerWidth: 1920,
  scrollX: 0,
  scrollY: 0,
  scrollTo: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  getComputedStyle: vi.fn(() => ({
    left: '0px', right: 'auto', top: '0px', bottom: 'auto',
  })),
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

if (typeof globalThis.MutationObserver === 'undefined') {
  globalThis.MutationObserver = class MockMutationObserver {
    constructor() {}
    observe() {}
    disconnect() {}
  };
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class MockResizeObserver {
    constructor() {}
    observe() {}
    disconnect() {}
  };
}

// ── Mock FS ─────────────────────────────────────────────────────────────
globalThis.FS = {
  rootId: 'root',
  files: new Map([['root', { id: 'root', name: '/', type: 'folder', parentId: null }]]),
  _childrenByParent: new Map([['root', new Map()]]),
  specialFolders: { desktop: 'desktop-id' },
  getPath: vi.fn((id) => '/' + id),
  listDir: vi.fn(() => []),
  getByPath: vi.fn(),
};

describe('WM (js/core/ui/wm.js)', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.clearAllMocks();
    OS.windows = new Map();
    OS.windowZCounter = 0;
    OS.focusedWindowId = null;
  });

  it('returns null for a nonexistent app', () => {
    vi.resetModules();
    require('../../js/core/ui/wm.js');
    const result = window.WM.createWindow?.('nonexistent-app');
    expect(result === null || result === undefined).toBe(true);
  });

  it('creates a window for a registered app and tracks state', () => {
    vi.resetModules();
    require('../../js/core/ui/wm.js');
    window.WM.init();
    const state = window.WM.createWindow('nook');
    expect(state).toBeDefined();
    expect(state.appId).toBe('nook');
    expect(state.element).toBeDefined();
    expect(OS.windows.has(state.id)).toBe(true);
    expect(OS.focusedWindowId).toBe(state.id);
  });

  it('focusWindow brings a window to the front', () => {
    vi.resetModules();
    require('../../js/core/ui/wm.js');
    window.WM.init();
    const state = window.WM.createWindow('nook');
    const firstZ = Number(state.element.style.zIndex);
    window.WM.focusWindow(state.id);
    expect(Number(state.element.style.zIndex)).toBeGreaterThan(firstZ);
    expect(OS.focusedWindowId).toBe(state.id);
  });

  it('closeWindow removes the window and emits app:closed', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    require('../../js/core/ui/wm.js');
    window.WM.init();
    const state = window.WM.createWindow('nook');
    const id = state.id;
    window.WM.closeWindow(id);
    await vi.advanceTimersByTimeAsync(300);
    expect(OS.windows.has(id)).toBe(false);
    vi.useRealTimers();
  });

  it('minimizeWindow then restoreWindow toggles display', () => {
    vi.resetModules();
    require('../../js/core/ui/wm.js');
    window.WM.init();
    const state = window.WM.createWindow('nook');
    window.WM.minimizeWindow(state.id);
    expect(state.minimized).toBe(true);
    window.WM.restoreWindow(state.id);
    expect(state.minimized).toBe(false);
  });

  it('getWorkArea returns an object with positive dimensions', () => {
    vi.resetModules();
    require('../../js/core/ui/wm.js');
    const area = window.WM.getWorkArea();
    expect(area).toHaveProperty('left');
    expect(area).toHaveProperty('top');
    expect(area).toHaveProperty('right');
    expect(area).toHaveProperty('bottom');
    expect(area.width).toBeGreaterThan(0);
    expect(area.height).toBeGreaterThan(0);
  });

  it('getSnapZone returns a zone name for screen corners', () => {
    vi.resetModules();
    require('../../js/core/ui/wm.js');
    expect(window.WM.getSnapZone(0, 0)).toBe('top-left');
    expect(window.WM.getSnapZone(1920, 0)).toBe('top-right');
    expect(window.WM.getSnapZone(0, 800)).toBe('bottom-left');
    expect(window.WM.getSnapZone(1920, 800)).toBe('bottom-right');
  });

  it('getSnapZone returns null for the middle of the screen', () => {
    vi.resetModules();
    require('../../js/core/ui/wm.js');
    expect(window.WM.getSnapZone(960, 400)).toBeNull();
  });

  it('clampWindowRect enforces minimum dimensions', () => {
    vi.resetModules();
    require('../../js/core/ui/wm.js');
    const state = { minWidth: 300, minHeight: 200, maxWidth: null, maxHeight: null };
    const clamped = window.WM.clampWindowRect(state, 0, 0, 50, 50);
    expect(clamped.w).toBeGreaterThanOrEqual(300);
    expect(clamped.h).toBeGreaterThanOrEqual(200);
  });

  it('toggleMaximize switches maximized state', () => {
    vi.resetModules();
    require('../../js/core/ui/wm.js');
    window.WM.init();
    const state = window.WM.createWindow('nook');
    window.WM.toggleMaximize(state.id);
    expect(state.maximized).toBe(true);
    window.WM.toggleMaximize(state.id);
    expect(state.maximized).toBe(false);
  });

  it('applyWindowFlags adds CSS classes for transparent, frameless, and no-resize', () => {
    vi.resetModules();
    require('../../js/core/ui/wm.js');
    window.WM.init();
    const state = window.WM.createWindow('nook');
    const app = { ...OS.apps['nook'], transparent: true, frame: false, resizable: false, alwaysOnTop: false };
    OS.apps['nook'] = app;
    state.element.classList.add = vi.fn();
    window.WM.applyWindowFlags(state);
    expect(state.element.classList.add).toHaveBeenCalledWith('app-window--transparent');
    expect(state.element.classList.add).toHaveBeenCalledWith('app-window--frameless');
    expect(state.element.classList.add).toHaveBeenCalledWith('app-window--no-resize');
  });
});

describe('server/middleware.js — setupMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SESSION_SECRET = 'test-secret-key-for-session-encryption';
  });

  it('registers middleware on the app without throwing', () => {
    const { setupMiddleware } = require('../../server/middleware.js');
    const mockApp = { use: vi.fn() };
    expect(() => setupMiddleware(mockApp)).not.toThrow();
    expect(mockApp.use).toHaveBeenCalled();
  });
});

describe('server/favicons.js — setupFaviconRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers favicon GET routes on the app', () => {
    const { setupFaviconRoutes } = require('../../server/favicons.js');
    const mockApp = { get: vi.fn() };
    expect(() => setupFaviconRoutes(mockApp)).not.toThrow();
    expect(mockApp.get).toHaveBeenCalled();
  });
});

describe('server/routes.js — mountRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SESSION_SECRET = 'test-secret-key-for-session-encryption';
  });

  it('mounts routes on the app without throwing', () => {
    const { mountRoutes } = require('../../server/routes.js');
    const mockApp = { use: vi.fn() };
    expect(() => mountRoutes(mockApp)).not.toThrow();
    expect(mockApp.use).toHaveBeenCalled();
  });
});
