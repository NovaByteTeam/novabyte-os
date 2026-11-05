import { describe, it, expect, vi, beforeEach } from 'vitest';
import NovaRegistry from '../../../js/platform/core/nova-registry.js';

// The engine is a UMD module with injectable storage/events — every test
// runs against a memory store and a tiny event recorder so nothing touches
// disk or the shared localStorage stub in setup.js.

function memStorage() {
  const map = new Map();
  return {
    _map: map,
    loadAll() {
      const out = {};
      for (const hive of NovaRegistry.HIVES) {
        out[hive] = map.has(hive) ? JSON.parse(map.get(hive)) : null;
      }
      return out;
    },
    save(hive, data) { map.set(hive, JSON.stringify(data)); },
  };
}

function makeBus() {
  const listeners = {};
  const events = [];
  return {
    events,
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    off() {},
    emit(name, data) {
      events.push({ name, data });
      for (const fn of (listeners[name] || []).slice()) fn(data);
    },
  };
}

function freshRegistry() {
  NovaRegistry._internal.resetState();
  const bus = makeBus();
  NovaRegistry.init({ storage: memStorage(), events: bus, logger: console });
  return { bus, Reg: NovaRegistry };
}

describe('NovaByte Registry engine (js/platform/core/nova-registry.js)', () => {
  let Reg, bus;
  beforeEach(() => {
    ({ Reg, bus } = freshRegistry());
  });

  it('parses paths with / and \\ separators into one canonical form', () => {
    Reg.set('HKNS\\shell\\taskbar', 'top');
    expect(Reg.get('HKNS/shell/taskbar')).toBe('top');
    expect(Reg.stat('HKNS\\shell\\taskbar').path).toBe('HKNS/shell/taskbar');
    // The hive is case-insensitive; segments keep their case.
    expect(Reg.stat('hkns/shell/taskbar').data).toBe('top');
  });

  it('rejects malformed paths with INVALID_ARGS', () => {
    const bad = ['', 'NOPE/x', 'HKNS', 'HKNS/a/', 'HKNS/../etc', 'HKNS/a/../b', 'HKNS/' + 'x'.repeat(65)];
    for (const path of bad) {
      expect(() => Reg.get(path), path).toThrow();
      try { Reg.get(path); } catch (err) { expect(err.code).toBe('INVALID_ARGS'); }
    }
    // A bare hive root has no default value to read.
    try { Reg.get('HKNS'); expect.unreachable(); } catch (err) { expect(err.code).toBe('INVALID_ARGS'); }
  });

  it('stores and returns every value type', () => {
    const cases = [
      ['HKNU/a/sz', 'hello', 'REG_SZ', 'hello'],
      ['HKNU/a/flag', true, 'REG_BOOL', true],
      ['HKNU/a/dword', 42, 'REG_DWORD', 42],
      ['HKNU/a/qword', 9007199254740991, 'REG_QWORD', 9007199254740991],
      ['HKNU/a/json', { list: [1, 2, 3] }, 'REG_JSON', { list: [1, 2, 3] }],
      ['HKNU/a/bin', 'aGVsbG8=', 'REG_BINARY', 'aGVsbG8='],
      ['HKNU/a/null', null, 'REG_JSON', null],
    ];
    for (const [path, value, type, expected] of cases) {
      Reg.set(path, value, { type });
      const entry = Reg.stat(path);
      expect(entry.type).toBe(type);
      expect(entry.data).toEqual(expected);
      expect(Reg.get(path)).toEqual(expected);
    }
  });

  it('auto-detects types when none is given', () => {
    expect(Reg.set('HKNU/d/b', true).type).toBe('REG_BOOL');
    expect(Reg.set('HKNU/d/small', 7).type).toBe('REG_DWORD');
    expect(Reg.set('HKNU/d/big', 4294967296).type).toBe('REG_QWORD');
    expect(Reg.set('HKNU/d/str', 'x').type).toBe('REG_SZ');
    expect(Reg.set('HKNU/d/obj', { a: 1 }).type).toBe('REG_JSON');
  });

  it('rejects values that do not fit the declared type', () => {
    const bad = [
      ['HKNU/b/sz', 42, 'REG_SZ'],
      ['HKNU/b/bool', 'true', 'REG_BOOL'],
      ['HKNU/b/dword', -1, 'REG_DWORD'],
      ['HKNU/b/dword', 4294967296, 'REG_DWORD'],
      ['HKNU/b/dword', 1.5, 'REG_DWORD'],
      ['HKNU/b/qword', -1, 'REG_QWORD'],
      ['HKNU/b/bin', 'not base64!!', 'REG_BINARY'],
      ['HKNU/b/unknown', 'x', 'REG_NOPE'],
    ];
    for (const [path, value, type] of bad) {
      try { Reg.set(path, value, { type }); expect.unreachable(`${path}`); }
      catch (err) { expect(err.code).toBe('INVALID_VALUE'); }
    }
    // Negative numbers cannot auto-detect to any type either.
    try { Reg.set('HKNU/b/neg', -5); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('INVALID_VALUE'); }
  });

  it('dedupes identical writes (one event, not two)', () => {
    Reg.set('HKNU/c/k', 'same');
    Reg.set('HKNU/c/k', 'same');
    const changed = bus.events.filter((e) => e.name === 'nova:reg:changed');
    expect(changed).toHaveLength(1);
    expect(Reg.set('HKNU/c/k', 'different').changed).toBe(true);
    expect(bus.events.filter((e) => e.name === 'nova:reg:changed')).toHaveLength(2);
  });

  it('emits nova:reg:changed with path, type, value, appId and source', () => {
    Reg.set('HKNA/com.example.game/score', 10, { appId: 'com.example.game' });
    const event = bus.events.find((e) => e.name === 'nova:reg:changed');
    expect(event.data).toMatchObject({
      path: 'HKNA/com.example.game/score',
      type: 'REG_DWORD',
      value: 10,
      appId: 'com.example.game',
      source: 'app',
    });
  });

  it('deletes values, and keys only with recursive: true', () => {
    Reg.set('HKNU/del/leaf', 'v');
    expect(Reg.remove('HKNU/del/leaf').removed).toBe('value');

    Reg.set('HKNU/del/key/a', '1');
    Reg.set('HKNU/del/key/b', '2');
    try { Reg.remove('HKNU/del/key'); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('SUBTREE_NOT_EMPTY'); }
    expect(Reg.remove('HKNU/del/key', { recursive: true }).removed).toBe('key');
    expect(Reg.list('HKNU/del').keys).toEqual([]);

    try { Reg.remove('HKNU/del/ghost'); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('NOT_FOUND'); }
  });

  it('lists sorted keys and value entries; unknown keys return null', () => {
    Reg.set('HKNU/list/zebra', '1');
    Reg.set('HKNU/list/alpha', '2');
    Reg.set('HKNU/list/sub/inner', '3');
    const listing = Reg.list('HKNU/list');
    // 'sub' is a child KEY; 'alpha' and 'zebra' are VALUES of this key.
    expect(listing.keys).toEqual(['sub']);
    expect(Object.keys(listing.values).sort()).toEqual(['alpha', 'zebra']);
    expect(Reg.list('HKNU/missing')).toBeNull();
  });

  it('exports and imports subtrees (merge semantics, imported wins)', () => {
    Reg.set('HKNA/com.a/src/one', '1');
    Reg.set('HKNA/com.a/src/two', '2');
    Reg.set('HKNA/com.a/src/deep/three', '3');
    const dump = Reg.export('HKNA/com.a/src');

    // Import under a different app's subtree — host policy decides who may
    // do that; the engine only merges what it is told to merge.
    Reg.set('HKNA/com.b/dst/one', 'OLD');
    const result = Reg.import('HKNA/com.b/dst', dump);
    expect(result.merged).toBe(3);
    expect(Reg.get('HKNA/com.b/dst/one')).toBe('1'); // imported wins
    expect(Reg.get('HKNA/com.b/dst/deep/three')).toBe('3');

    try { Reg.import('HKNA/com.b/x', 'not-an-object'); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('INVALID_ARGS'); }
    try { Reg.import('HKNA/com.b/x', { values: { bad: { type: 'REG_SZ', data: 42 } } }); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('INVALID_VALUE'); }
  });

  it('enforces quotas (depth, value size)', () => {
    const deep = ['HKNU', ...Array.from({ length: 17 }, (_, i) => 'k' + i)].join('/');
    try { Reg.set(deep, 'x'); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('INVALID_ARGS'); }

    try { Reg.set('HKNU/q/big', 'x'.repeat(256 * 1024 + 1)); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('QUOTA_EXCEEDED'); }
  });

  it('starts fresh from corrupt stored hives instead of crashing', () => {
    NovaRegistry._internal.resetState();
    const broken = {
      loadAll() {
        return { HKNS: '{not json', HKNU: { keys: null }, HKNA: null, HKND: undefined };
      },
      save() { return true; },
    };
    NovaRegistry.init({ storage: broken, events: bus, logger: console });
    expect(Reg.get('HKNS/shell/theme')).toBeUndefined();
    expect(() => Reg.set('HKNS/shell/theme', 'nord')).not.toThrow();
    expect(Reg.get('HKNS/shell/theme')).toBe('nord');
    Reg = NovaRegistry; // keep the alias valid for later tests
  });

  it('seeds defaults once and never clobbers existing values', () => {
    const seeded = Reg.ensureDefaults(Reg.BOOT_DEFAULTS);
    expect(seeded).toBeGreaterThan(0);
    expect(Reg.get('HKNS/shell/theme')).toBe('nova-dark');
    Reg.set('HKNS/shell/theme', 'nord');
    expect(Reg.ensureDefaults(Reg.BOOT_DEFAULTS)).toBe(0);
    expect(Reg.get('HKNS/shell/theme')).toBe('nord');
  });

  it('mirrors mapped settings changes into the registry and ignores the rest', () => {
    expect(Reg.attachSettingsMirror(
      { get: () => undefined, set: () => {} },
      bus,
    )).toBe(true);
    bus.emit('settings:changed', { key: 'theme', value: 'dracula' });
    bus.emit('settings:changed', { key: 'wallpaperId', value: 'dark' });
    bus.emit('settings:changed', { key: 'clockFormat', value: '24h' }); // unmapped
    expect(Reg.get('HKNS/shell/theme')).toBe('dracula');
    expect(Reg.get('HKNS/shell/wallpaper')).toBe('dark');
    expect(Reg.stat('HKNS/clockFormat')).toBeNull();
  });

  it('keeps mutating writes persisted through the storage adapter', () => {
    const storage = memStorage();
    NovaRegistry._internal.resetState();
    NovaRegistry.init({ storage, events: bus, logger: console });
    NovaRegistry.set('HKNU/persist/k', 'v');
    expect(storage._map.get('HKNU')).toContain('"k"');
  });
});
