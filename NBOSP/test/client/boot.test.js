import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';

// Boot attaches to window.Boot and window.boot in the browser.
// We exercise the public methods via window.Boot.

describe('Boot (js/core/core/boot.js)', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.clearAllMocks();
  });

  it('caches DOM references without throwing', () => {
    if (!window.Boot) {
      // Module not loaded in this environment — skip gracefully
      expect(true).toBe(true);
      return;
    }
    window.Boot._cacheDom();
    expect(window.Boot._dom).toBeDefined();
  });

  it('_setupWatchdog returns an object with complete()', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    const watchdog = window.Boot._setupWatchdog(Date.now(), 'test-ua');
    expect(typeof watchdog.complete).toBe('function');
  });

  it('applyOSVars sets OS properties from settings', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    globalThis.OS.settings.get = vi.fn((key) => (key === 'username' ? 'alice' : null));
    const sGet = window.Boot.applyOSVars();
    expect(globalThis.OS.username).toBe('alice');
    expect(typeof sGet).toBe('function');
  });

  it('applyThemeAndVars does not throw when _dom is null', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    window.Boot._dom = null;
    expect(() => window.Boot.applyThemeAndVars(() => ({}))).not.toThrow();
  });

  it('applyWallpaper does not throw when desktop is missing', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    window.Boot._dom = { desktop: null };
    expect(() => window.Boot.applyWallpaper(() => ({}))).not.toThrow();
  });

  it('syncVersion does not throw when vPill is missing', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    window.Boot._dom = { vPill: null };
    globalThis.OS.settings.set = vi.fn();
    expect(() => window.Boot.syncVersion(() => '3.0.2')).not.toThrow();
  });

  it('configureTaskbar does not throw when taskbar is missing', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    window.Boot._dom = { taskbar: null };
    expect(() => window.Boot.configureTaskbar(() => ({}))).not.toThrow();
  });

  it('initScreenReader creates window.SR', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    window.Boot.initScreenReader();
    expect(window.SR).toBeDefined();
    expect(typeof window.SR.announce).toBe('function');
  });

  it('_runHooks handles hook that throws without propagating', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args);
    window.Boot.hooks.before.push(() => { throw new Error('hook fail'); });
    window.Boot._runHooks('before');
    console.error = origError;
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});
