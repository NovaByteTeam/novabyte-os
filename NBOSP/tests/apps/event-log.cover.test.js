// tests/apps/event-log.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/event-log/service.js.
// The real service runs against a live JSDOM window; its global console
// patch and ring buffer are driven end-to-end (console.log/warn/error
// capture incl. [Tag] parsing, object serialisation and the circular
// fallback), persistence through the real localStorage, and the tail guard
// is exercised with a window-less require.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { coverLoadServiceApp } from '../helpers/cover-loader.js';

let savedConsole;
beforeEach(() => {
  resetTestStorage();
  vi.resetModules();
  // the service patches the shared Node console once per module instance —
  // snapshot and restore it around every test so wrappers never chain.
  savedConsole = { log: console.log, warn: console.warn, error: console.error };
});

afterEach(() => {
  console.log = savedConsole.log;
  console.warn = savedConsole.warn;
  console.error = savedConsole.error;
  vi.restoreAllMocks();
});

async function mount() {
  return coverLoadServiceApp('event-log', { withBaseUtils: true });
}

describe('EventLog (js/apps/event-log/service.js) — e2e coverage', () => {
  it('exposes the service, category list and patch idempotency', async () => {
    const { window } = await mount();
    const log = window.EventLog;
    expect(typeof log.log).toBe('function');
    const cats = log.getCategories();
    expect(cats).toEqual(expect.arrayContaining(['window', 'filesystem', 'security']));
    cats.push('bogus'); // slice() — the internal list must not change
    expect(log.getCategories()).not.toContain('bogus');
    // idempotent: patching twice must not double-capture
    log.patchConsole();
    const before = log.getAll().length;
    console.log('once only');
    expect(log.getAll().length - before).toBe(1);
  });

  it('log() applies defaults and keeps explicit fields', async () => {
    const { window } = await mount();
    const log = window.EventLog;
    const full = log.log({ app: 'AppPermissionManager', category: 'permissions', severity: 'warn', message: 'Denied', data: { appId: 'x' } });
    expect(full).toMatchObject({ app: 'AppPermissionManager', category: 'permissions', severity: 'warn', message: 'Denied', data: { appId: 'x' } });
    expect(typeof full.id).toBe('string');
    expect(full.id.length).toBeGreaterThan(0);
    expect(typeof full.timestamp).toBe('number');
    const defaults = log.log({});
    expect(defaults).toMatchObject({ app: 'system', category: 'system', severity: 'info', message: '', data: null });
  });

  it('falls back to Date/Math ids when generateId is unavailable', async () => {
    const { window } = await mount();
    const saved = globalThis.generateId;
    globalThis.generateId = undefined; // typeof check takes the else arm
    try {
      const log = window.EventLog;
      const entry = log.log({ message: 'no generateId' });
      expect(typeof entry.id).toBe('string');
      expect(entry.id.length).toBeGreaterThan(5);
    } finally {
      globalThis.generateId = saved;
    }
  });

  it('ring buffer caps at 500 entries', async () => {
    const { window } = await mount();
    const log = window.EventLog;
    for (let i = 0; i < 501; i += 1) log.log({ message: `m${i}` });
    const all = log.getAll();
    expect(all).toHaveLength(500);
    expect(all[0].message).toBe('m500');
    expect(all.find((e) => e.message === 'm0')).toBeUndefined();
  });

  it('persists through localStorage and reloads once (_loaded guard)', async () => {
    const { window } = await mount();
    const log = window.EventLog;
    log.log({ app: 'a', message: 'persisted' });
    const saved = JSON.parse(window.localStorage.getItem('novaOS_eventlog'));
    expect(saved[0].message).toBe('persisted');
    // mutate storage AFTER the first read — the guard must not re-read
    window.localStorage.setItem('novaOS_eventlog', JSON.stringify([{ message: 'should not load' }]));
    expect(log.getAll()[0].message).toBe('persisted');
  });

  it('loadPersisted tolerates invalid JSON and non-array payloads', async () => {
    // loadPersisted is lazy — seed the window's storage AFTER mount but
    // BEFORE the first getAll/log so the service reads the poisoned payload.
    const a = await mount();
    a.window.localStorage.setItem('novaOS_eventlog', '{not json');
    expect(a.window.EventLog.getAll()).toEqual([]);
    const b = await mount();
    b.window.localStorage.setItem('novaOS_eventlog', JSON.stringify({ nope: true }));
    expect(b.window.EventLog.getAll()).toEqual([]);
    // an array payload is accepted and sliced to the cap
    const arr = Array.from({ length: 520 }, (_, i) => ({ message: `e${i}` }));
    const c = await mount();
    c.window.localStorage.setItem('novaOS_eventlog', JSON.stringify(arr));
    expect(c.window.EventLog.getAll()).toHaveLength(500);
  });

  it('a throwing localStorage cannot break logging (persist catch arm)', async () => {
    const { window } = await mount();
    const log = window.EventLog;
    const key = window.localStorage.setItem;
    window.localStorage.setItem = () => { throw new Error('quota full'); };
    try {
      expect(() => log.log({ message: 'still works' })).not.toThrow();
      expect(log.getAll()[0].message).toBe('still works');
    } finally {
      window.localStorage.setItem = key;
    }
  });

  it('subscribers receive entries; a throwing one is isolated', async () => {
    const { window } = await mount();
    const log = window.EventLog;
    const got = [];
    log.subscribe((entry) => got.push(entry.message));
    log.subscribe(() => { throw new Error('bad subscriber'); }); // try/catch arm
    const entry = log.log({ message: 'fanout' });
    expect(got).toEqual(['fanout']);
    expect(entry.message).toBe('fanout');
    // unsubscribe
    const seen = [];
    const off = log.subscribe((e) => seen.push(e.message));
    off();
    log.log({ message: 'after off' });
    expect(seen).toEqual([]);
  });

  it('ingestRemote always tags category server', async () => {
    const { window } = await mount();
    const entry = window.EventLog.ingestRemote({ app: 'proxies', category: 'network', message: 'blocked' });
    expect(entry.category).toBe('server');
    expect(entry.app).toBe('proxies');
  });

  it('clear() empties the buffer and storage', async () => {
    const { window } = await mount();
    const log = window.EventLog;
    log.log({ message: 'one' });
    log.clear();
    expect(log.getAll()).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem('novaOS_eventlog'))).toEqual([]);
  });

  it('console capture: [Tag] parsing, objects, circular fallback, empty skip', async () => {
    const { window } = await mount();
    const log = window.EventLog;
    const count = () => log.getAll().length;
    const before = count();
    console.log('[AppPermissionManager] Denied fs:write', { appId: 'x' });
    console.warn('no tag here', 42);
    console.error('plain error');
    const circular = {}; circular.self = circular;
    console.log('circ', circular); // JSON.stringify throws → String() fallback
    console.log(99, 'units'); // non-string first arg → app stays system, rest = args
    console.log(''); // empty message → skipped entirely
    const entries = log.getAll().slice(0, count() - before).reverse();
    expect(entries.map((e) => [e.app, e.severity, e.message])).toEqual([
      ['AppPermissionManager', 'info', 'Denied fs:write {"appId":"x"}'],
      ['system', 'warn', 'no tag here 42'],
      ['system', 'error', 'plain error'],
      ['system', 'info', 'circ [object Object]'],
      ['system', 'info', '99 units'],
    ]);
    expect(log.getAll().length - before).toBe(5); // the empty call added nothing
  });

});
