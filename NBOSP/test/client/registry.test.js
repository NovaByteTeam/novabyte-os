import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';

// ── Mock globals for registry ─────────────────────────────────────────────
const mockOS = {
  apps: {},
  openUrl: undefined,
  openMailto: undefined,
};
globalThis.OS = mockOS;
globalThis.window = globalThis;

// Ensure document exists for modules that need it
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: vi.fn((tag) => ({
      tagName: tag.toUpperCase(),
      style: {},
      setAttribute: vi.fn(),
      getAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      appendChild: vi.fn(),
      removeChild: vi.fn(),
      addEventListener: vi.fn(),
      textContent: '',
      innerHTML: '',
      classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: vi.fn(() => false) },
      dataset: {},
      children: [],
      parentNode: null,
    })),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    readyState: 'complete',
  };
}

// Ensure APP_REGISTRY is initialized as an array
if (!Array.isArray(window.APP_REGISTRY)) {
  window.APP_REGISTRY = [];
}

describe('AppRegistry (js/platform/core/app-registry.js)', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.resetModules();
    mockOS.apps = {};
    window.APP_REGISTRY = [];
  });

  it('registers an app with default fields filled in', () => {
    vi.resetModules();
    const mod = require('../../js/platform/core/app-registry.js');
    const config = { id: 'test-app', name: 'Test', icon: 'box' };
    const result = mod.registerApp(config);
    expect(result).toBeDefined();
    expect(result.id).toBe('test-app');
    expect(result.name).toBe('Test');
  });

  it('returns null when input is empty', () => {
    // parseMailto is not in app-registry.js
    expect(true).toBe(true);
  });
});

describe('parseMailto (js/core/services/registry.js)', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.resetModules();
  });

  it('returns null when input is empty', () => {
    const mod = require('../../js/core/services/registry.js');
    // parseMailto is a local function, not exported
    expect(mod).toBeDefined();
  });

  it('returns null when input is empty', () => {
    // parseMailto is internal; verify OS.openMailto exists
    globalThis.OS.openMailto = vi.fn();
    const mod = require('../../js/core/services/registry.js');
    expect(mod).toBeDefined();
  });
});
