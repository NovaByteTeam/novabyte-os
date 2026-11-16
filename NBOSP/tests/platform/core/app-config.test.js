// tests/platform/core/app-config.test.js — the HKNA per-app config
// accessor built-in apps use instead of ad-hoc localStorage keys.
//
// NovaAppConfig resolves HKNA/<appId>/<relPath>, adopts each legacy
// localStorage key exactly once (guarded per path under
// HKND/_migration/appConfig), coerces legacy strings to the REG_* value
// shape, and falls back to localStorage when no engine is up.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import NovaRegistry from '../../../js/platform/core/nova-registry.js';
import NovaAppConfig from '../../../js/platform/core/app-config.js';
import { resetTestStorage } from '../../setup.js';

function memStorage() {
  const map = new Map();
  return {
    loadAll() {
      const out = {};
      for (const name of [...NovaRegistry.HIVES, 'AUDIT', 'SNAPSHOTS']) {
        out[name] = map.has(name) ? JSON.parse(map.get(name)) : null;
      }
      return out;
    },
    save(hive, data) { map.set(hive, JSON.stringify(data)); },
  };
}

function freshRegistry() {
  NovaRegistry._internal.resetState();
  NovaRegistry.init({ storage: memStorage(), events: null, logger: console });
  return NovaRegistry;
}

function withWindowRegistry(Reg) {
  globalThis.window = globalThis.window || {};
  window.NovaRegistry = Reg;
  window.NovaAppConfig = NovaAppConfig;
}

beforeEach(() => {
  resetTestStorage();
  withWindowRegistry(freshRegistry());
  NovaAppConfig._internal.resetAdoption(NovaRegistry);
});

// The UMD modules assign window.* globals at import time and the suite
// re-assigns them per test — clear them so later suites sharing this
// vitest worker (isolate:false) never see a stale engine.
afterAll(() => {
  delete window.NovaRegistry;
  delete window.NovaAppConfig;
});

describe('app config (js/platform/core/app-config.js)', () => {
  it('resolves HKNA paths from appId + relative path', () => {
    expect(NovaAppConfig.resolvePath('com.nbosp.music', 'prefs')).toBe('HKNA/com.nbosp.music/prefs');
    expect(NovaAppConfig.resolvePath('com.nbosp.clock', 'alarms/deep')).toBe('HKNA/com.nbosp.clock/alarms/deep');
  });

  it('rejects malformed app ids and relative paths', () => {
    expect(() => NovaAppConfig.resolvePath('', 'prefs')).toThrow(TypeError);
    expect(() => NovaAppConfig.resolvePath('com/a', 'prefs')).toThrow(TypeError);
    expect(() => NovaAppConfig.resolvePath('com.a', '../escape')).toThrow(TypeError);
    expect(() => NovaAppConfig.resolvePath('com.a', '')).toThrow(TypeError);
  });

  it('adopts the legacy localStorage key exactly once and keeps it as fallback', () => {
    localStorage.setItem('nova_music_prefs', JSON.stringify({ volume: 0.5, shuffle: true }));

    expect(NovaAppConfig.get('com.nbosp.music', 'prefs', { legacyKey: 'nova_music_prefs', fallback: {} }))
      .toEqual({ volume: 0.5, shuffle: true });
    expect(NovaRegistry.get('HKNA/com.nbosp.music/prefs')).toEqual({ volume: 0.5, shuffle: true });
    expect(NovaRegistry.stat('HKND/_migration/appConfig')).not.toBeNull();

    // A later legacy edit never leaks into the hive — the guard holds.
    localStorage.setItem('nova_music_prefs', JSON.stringify({ volume: 0.9 }));
    expect(NovaAppConfig.get('com.nbosp.music', 'prefs', { legacyKey: 'nova_music_prefs', fallback: {} }))
      .toEqual({ volume: 0.5, shuffle: true });
  });

  it('never clobbers an existing hive value during adoption', () => {
    NovaRegistry.set('HKNA/com.nbosp.music/prefs', { volume: 0.7 }, { type: 'REG_JSON', source: 'test' });
    localStorage.setItem('nova_music_prefs', JSON.stringify({ volume: 0.1 }));

    expect(NovaAppConfig.get('com.nbosp.music', 'prefs', { legacyKey: 'nova_music_prefs', fallback: {} }))
      .toEqual({ volume: 0.7 });
  });

  it('round-trips values of every scalar type', () => {
    expect(NovaAppConfig.set('com.nbosp.textedit', 'wordWrap', true, { type: 'REG_BOOL' })).toBe(true);
    expect(NovaAppConfig.get('com.nbosp.textedit', 'wordWrap')).toBe(true);
    expect(NovaRegistry.get('HKNA/com.nbosp.textedit/wordWrap')).toBe(true);

    expect(NovaAppConfig.set('com.a', 'level', 3, { type: 'REG_DWORD' })).toBe(true);
    expect(NovaAppConfig.get('com.a', 'level')).toBe(3);

    expect(NovaAppConfig.set('com.a', 'label', 'hello', { type: 'REG_SZ' })).toBe(true);
    expect(NovaAppConfig.get('com.a', 'label')).toBe('hello');
  });

  it('coerces legacy strings to the REG_* value shape on fallback reads', () => {
    localStorage.setItem('nbosp.textedit.wordWrap', 'true');
    expect(NovaAppConfig.get('com.nbosp.textedit', 'wordWrap', { type: 'REG_BOOL', legacyKey: 'nbosp.textedit.wordWrap', fallback: false }))
      .toBe(true);

    localStorage.setItem('nbosp.level', '42');
    expect(NovaAppConfig.get('com.a', 'level', { type: 'REG_DWORD', legacyKey: 'nbosp.level', fallback: 0 })).toBe(42);

    localStorage.setItem('nbosp.corrupt', '{not json');
    expect(NovaAppConfig.get('com.a', 'obj', { type: 'REG_JSON', legacyKey: 'nbosp.corrupt', fallback: { safe: 1 } }))
      .toEqual({ safe: 1 });
  });

  it('returns the fallback when nothing is stored anywhere', () => {
    expect(NovaAppConfig.get('com.nbosp.music', 'prefs', { fallback: { volume: 1 } })).toEqual({ volume: 1 });
  });

  it('falls back to the legacy localStorage channel when no registry exists', () => {
    delete window.NovaRegistry;

    expect(NovaAppConfig.set('com.nbosp.music', 'prefs', { volume: 0.25 }, { legacyKey: 'nova_music_prefs' })).toBe(false);
    expect(JSON.parse(localStorage.getItem('nova_music_prefs'))).toEqual({ volume: 0.25 });
    expect(NovaAppConfig.get('com.nbosp.music', 'prefs', { legacyKey: 'nova_music_prefs', fallback: {} }))
      .toEqual({ volume: 0.25 });

    expect(NovaAppConfig.set('com.nbosp.textedit', 'wordWrap', true, { type: 'REG_BOOL', legacyKey: 'nbosp.textedit.wordWrap', legacyRaw: 'true' })).toBe(false);
    expect(localStorage.getItem('nbosp.textedit.wordWrap')).toBe('true');
  });

  it('removes both the hive value and the legacy shadow on remove()', () => {
    NovaAppConfig.set('com.nbosp.music', 'prefs', { volume: 0.5 }, { legacyKey: 'nova_music_prefs' });
    expect(NovaAppConfig.remove('com.nbosp.music', 'prefs', { legacyKey: 'nova_music_prefs' })).toBe(true);
    expect(NovaRegistry.stat('HKNA/com.nbosp.music/prefs')).toBeNull();
    expect(localStorage.getItem('nova_music_prefs')).toBeNull();
  });

  it('rejects reserved key names and dot-segment relative paths', () => {
    for (const reserved of ['__proto__', 'constructor', 'prototype']) {
      expect(() => NovaAppConfig.get(reserved, 'x')).toThrow(`"${reserved}" is reserved`);
    }
    expect(() => NovaAppConfig.get('com.a', 'foo/../bar')).toThrow('invalid relPath');
    expect(() => NovaAppConfig.get('com.a', './here')).toThrow('invalid relPath');
    expect(() => NovaAppConfig.set('com.a', 'a/./b', 1)).toThrow('invalid relPath');
  });

  it('coerces every legacy BOOL / DWORD / QWORD / SZ shape on fallback reads', () => {
    const cases = [
      ['bool-1', 'REG_BOOL', '1', true],
      ['bool-false', 'REG_BOOL', 'false', false],
      ['bool-0', 'REG_BOOL', '0', false],
      ['qword', 'REG_QWORD', '7', 7],
      ['sz', 'REG_SZ', 'plain text', 'plain text'],
    ];
    for (const [rel, type, raw, expected] of cases) {
      localStorage.setItem(`legacy.${rel}`, raw);
      expect(NovaAppConfig.get('com.legacy', rel, { type, legacyKey: `legacy.${rel}`, fallback: 'UNUSED' }))
        .toBe(expected);
    }
    // unparseable legacy values fall through to the caller's fallback
    localStorage.setItem('legacy.badbool', 'maybe');
    expect(NovaAppConfig.get('com.legacy', 'badbool', { type: 'REG_BOOL', legacyKey: 'legacy.badbool', fallback: false }))
      .toBe(false);
    localStorage.setItem('legacy.baddword', 'not-a-number');
    expect(NovaAppConfig.get('com.legacy', 'baddword', { type: 'REG_DWORD', legacyKey: 'legacy.baddword', fallback: 0 }))
      .toBe(0);
  });

  it('set() without a legacyKey never touches localStorage', () => {
    expect(NovaAppConfig.set('com.a', 'plain', 'v')).toBe(true);
    expect(NovaAppConfig.get('com.a', 'plain')).toBe('v');
    expect(localStorage.length).toBe(0);
  });

  it('remove() degrades without a registry and without a legacyKey', () => {
    delete window.NovaRegistry; // no engine at all
    localStorage.setItem('legacy-gone', 'x');
    expect(NovaAppConfig.remove('com.a', 'gone', { legacyKey: 'legacy-gone' })).toBe(true);
    expect(localStorage.getItem('legacy-gone')).toBeNull();
    // neither registry nor legacyKey: nothing to do, reported honestly
    expect(NovaAppConfig.remove('com.a', 'gone')).toBe(false);
  });

  it('get() still serves the legacy channel with no window at all (headless tooling)', () => {
    const savedWindow = globalThis.window;
    delete globalThis.window;
    try {
      localStorage.setItem('headless-key', '"legacy-value"');
      expect(NovaAppConfig.get('com.a', 'x', { legacyKey: 'headless-key', fallback: null })).toBe('legacy-value');
    } finally {
      globalThis.window = savedWindow;
    }
  });

  it('a quota-blowing localStorage write is swallowed during legacy shadowing', () => {
    const original = globalThis.localStorage;
    const bomb = { ...original, setItem: () => { throw new Error('QuotaExceededError'); } };
    Object.defineProperty(globalThis, 'localStorage', { value: bomb, configurable: true });
    try {
      delete window.NovaRegistry;
      expect(() => NovaAppConfig.set('com.a', 'k', 'v', { legacyKey: 'quota-key' })).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true });
    }
  });

  it('a throwing localStorage read degrades to "no legacy value"', () => {
    const original = globalThis.localStorage;
    const bomb = { ...original, getItem: () => { throw new Error('SecurityError'); } };
    Object.defineProperty(globalThis, 'localStorage', { value: bomb, configurable: true });
    try {
      delete window.NovaRegistry; // no registry → the legacy channel is the only one
      expect(NovaAppConfig.get('com.a', 'x', { legacyKey: 'anything', fallback: 'safe' })).toBe('safe');
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true });
    }
  });

  it('set() with neither registry nor legacyKey reports the miss', () => {
    delete window.NovaRegistry;
    expect(NovaAppConfig.set('com.a', 'k', 'v')).toBe(false);
    expect(localStorage.length).toBe(0); // nothing shadowed either
  });

  it('an unreadable adoption guard map never blocks the read', () => {
    // registry.get on the guard path throws → adoptedMap degrades to {} and
    // adoption simply proceeds (or skips) without surfacing the error
    const guarded = {
      get: (p) => {
        if (p === 'HKND/_migration/appConfig') throw new Error('hive locked');
        return NovaRegistry.get(p);
      },
      stat: (p) => NovaRegistry.stat(p),
      set: (...a) => NovaRegistry.set(...a),
    };
    window.NovaRegistry = guarded;
    localStorage.setItem('guard-legacy', '"imported"');
    expect(NovaAppConfig.get('com.guard', 'opt', { legacyKey: 'guard-legacy', fallback: null })).toBe('imported');
  });
});
