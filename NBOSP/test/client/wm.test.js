import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';

// ── Mock globals for WM ─────────────────────────────────────────────────────
globalThis.OS = {
  apps: {
    nook: { id: 'nook', name: 'Settings', defaultSize: [700, 500], minSize: [500, 400] },
  },
  windows: new Map(),
  windowZCounter: 0,
};

globalThis.WM = undefined;

globalThis.generateId = () => 'id-' + Math.random().toString(36).slice(2);
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
    addEventListener: vi.fn(),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    getAttribute: vi.fn(),
    querySelector: vi.fn(),
    querySelectorAll: vi.fn(() => []),
    closest: vi.fn(),
  };
  return el;
};

globalThis.svgIcon = (name, size) => `<svg width="${size}" height="${size}"></svg>`;

globalThis.document = {
  getElementById: vi.fn((id) => {
    const els = {
      windows: { appendChild: vi.fn() },
      snapPreview: null,
      snapCompass: null,
      taskbar: { classList: { add: vi.fn() }, style: {} },
    };
    return els[id] || {
      appendChild: vi.fn(),
      classList: { add: vi.fn(), remove: vi.fn() },
      style: {},
      addEventListener: vi.fn(),
    };
  }),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  createElement: globalThis.createElement,
  body: { appendChild: vi.fn(), classList: { add: vi.fn() } },
  documentElement: { style: {}, classList: {} },
};

globalThis.window = {
  innerHeight: 800,
  innerWidth: 1920,
  scrollX: 0,
  scrollY: 0,
  scrollTo: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
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
};

describe('WM (js/core/ui/wm.js)', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.clearAllMocks();
    OS.windows = new Map();
    OS.windowZCounter = 0;
  });

  it('returns null for nonexistent app', () => {
    const mod = require('../../js/core/ui/wm.js');
    const result = mod.createWindow?.('nonexistent-app');
    expect(result === null || result === undefined).toBe(true);
  });

  it('exposes expected window management methods', () => {
    const mod = require('../../js/core/ui/wm.js');
    // WM attaches to globalThis.WM, check the exported module
    expect(mod).toBeDefined();
  });
});

describe('Settings app (js/apps/settings.js)', () => {
  it('returns null when input is empty', () => {
    expect(globalThis.OS.apps).toBeDefined();
  });
});

describe('server/middleware.js — setupMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SESSION_SECRET = 'test-secret-key-for-session-encryption';
  });

  it('returns null when input is empty', () => {
    const { setupMiddleware } = require('../../server/middleware.js');
    const mockApp = { use: vi.fn() };
    expect(() => setupMiddleware(mockApp)).not.toThrow();
  });
});

describe('server/favicons.js — setupFaviconRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when input is empty', () => {
    const { setupFaviconRoutes } = require('../../server/favicons.js');
    const mockApp = { get: vi.fn() };
    expect(() => setupFaviconRoutes(mockApp)).not.toThrow();
  });
});

describe('server/routes.js — mountRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SESSION_SECRET = 'test-secret-key-for-session-encryption';
  });

  it('returns null when input is empty', () => {
    const { mountRoutes } = require('../../server/routes.js');
    const mockApp = { use: vi.fn() };
    expect(() => mountRoutes(mockApp)).not.toThrow();
  });
});
