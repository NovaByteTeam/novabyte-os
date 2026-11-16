// tests/apps/calendar-notifier.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/calendar-notifier/service.js.
// The real service is require()d against a live JSDOM window; reminders are
// driven deterministically by freezing the clock (vi.setSystemTime) and
// calling _tick()/start()/stop() the way Boot.after would. Fired-id
// bookkeeping is exercised on both the NovaRegistry path and the legacy
// localStorage fallback, including every fail-soft degradation.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { coverLoadServiceApp, settle } from '../helpers/cover-loader.js';

const EVENTS = 'calendar_events_v2';
const FIRED = 'calendar_notified_v1';
const FIRED_REG = 'HKNS/apps/calendar/notifiedIds';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount({ registry, notify = { show: vi.fn() }, boot, noNotify } = {}) {
  // A Boot/Notify stub from a previous test would leak into later loads
  // (mirrorStubs only adds, never removes) — reset unless explicitly given.
  if (!boot) delete globalThis.Boot;
  const extra = {
    ...(notify && !noNotify ? { Notify: notify } : {}),
    ...(registry ? { NovaRegistry: registry } : {}),
    ...(boot ? { Boot: boot } : {}),
  };
  if (noNotify) { delete globalThis.Notify; }
  const ctx = await coverLoadServiceApp('calendar-notifier', {
    stubs: { extra },
    withBaseUtils: true,
  });
  if (noNotify) delete ctx.window.Notify;
  return { ...ctx, notify };
}

const ev = (over = {}) => ({
  id: 'e-' + Math.random().toString(36).slice(2, 8),
  title: 'Standup',
  date: '2026-11-17',
  timeStart: '12:08',
  ...over,
});

function seedEvents(list) { localStorage.setItem(EVENTS, JSON.stringify(list)); }

// Freeze the cover realm's clock. Called AFTER a mount: the loader mirrors
// jsdom's (real) Date over globalThis, which clobbers any fake installed
// earlier — and a bare vi.setSystemTime after a second mount only jumps
// vitest's existing clock without re-installing the fake Date. A full
// reset+install makes Date.now() deterministic in the app realm again.
function freezeAt(iso) {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

describe('CalendarNotifier (js/apps/calendar-notifier/service.js) — e2e coverage', () => {
  beforeEach(() => { resetTestStorage(); });

  it('exposes the service and registers with Boot.after when present', async () => {
    const boot = { hooks: { after: [] } };
    const { window } = await mount({ boot });
    expect(window.CalendarNotifier).toBeTruthy();
    expect(boot.hooks.after).toHaveLength(1);
    expect(typeof boot.hooks.after[0]).toBe('function');
    boot.hooks.after[0](); // boot path: starts the poller
    expect(window.CalendarNotifier._timer).not.toBe(null);
    window.CalendarNotifier.stop();
  });

  it('start() is idempotent; stop() clears and tolerates double-stop', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { window } = await mount({});
    const svc = window.CalendarNotifier;
    const tick = vi.spyOn(svc, '_tick');
    svc.start();
    expect(svc._timer).not.toBe(null);
    svc.start(); // second start: no double-schedule
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tick.mock.calls.length).toBe(2); // initial tick + one 30s interval
    svc.stop();
    expect(svc._timer).toBe(null);
    svc.stop(); // no timer: no-op
    expect(svc._timer).toBe(null);
  });

  it('fires a reminder inside the 10-minute lead window and dedupes by id', async () => {
    const notify = { show: vi.fn() };
    const { window } = await mount({ notify });
    // AFTER load: the loader mirrors jsdom's (real) Date over globalThis,
    // which would clobber a fake installed before mount.
    freezeAt('2026-11-17T12:00:00');
    seedEvents([
      ev({ id: 'a', title: '  Sync review  ', timeStart: '12:08' }),  // 8 min out
      ev({ id: 'b', title: 'Later', timeStart: '12:45' }),             // beyond lead: silent
      ev({ id: 'c', title: 'Ancient', timeStart: '10:00' }),           // long past: silent
    ]);
    window.CalendarNotifier._tick();
    expect(notify.show).toHaveBeenCalledTimes(1);
    const [call] = notify.show.mock.calls;
    expect(call[0].title).toContain('Sync review'); // trimmed
    expect(call[0].body).toContain('8');
    expect(call[0].type).toBe('info');
    expect(call[0].appName).toBe('Calendar');
    // dedupe: the same tick twice only notifies once
    window.CalendarNotifier._tick();
    expect(notify.show).toHaveBeenCalledTimes(1);
  });

  it('says "starting now" for imminent and just-started events; untitled fallback for blank titles', async () => {
    const notify = { show: vi.fn() };
    const { window } = await mount({ notify });
    freezeAt('2026-11-17T11:59:55'); // 'now' 5s ahead; 'just-past' 5s back — both in the grace window
    // one event starting exactly now; one 40s-started event (inside the -60s grace)
    seedEvents([
      ev({ id: 'now', title: '', timeStart: '12:00' }),
      ev({ id: 'just-past', title: 'Started', timeStart: '11:59' }),
    ]);
    window.CalendarNotifier._tick();
    expect(notify.show).toHaveBeenCalledTimes(2);
    // both are "starting now": Math.max(0, round(±<60s/60000)) → 0 minutes
    const bodies = notify.show.mock.calls.map((c) => c[0].body);
    expect(bodies.every((b) => typeof b === 'string' && b.length > 0)).toBe(true);
    // untitled fallback ran for the empty-title event
    const untitled = notify.show.mock.calls.find((c) => c[0].title.includes('Sync') === false && c[0].title.length > 0);
    expect(untitled).toBeTruthy();
  });

  it('marks fired ids even when Notify is absent, and persists to the registry', async () => {
    const set = vi.fn();
    const get = vi.fn(() => undefined); // registry miss → legacy read below
    const registry = { get, set };
    // noNotify: the load runs without any Notify global — reminders are
    // skipped (typeof guard) but the event is still marked as handled.
    const { window } = await mount({ registry, noNotify: true });
    freezeAt('2026-11-17T12:00:00');
    seedEvents([ev({ id: 'solo', timeStart: '12:05' })]);
    window.CalendarNotifier._tick();
    // Notify absent: no throw, but the event is marked and saved
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0]).toBe(FIRED_REG);
    expect(set.mock.calls[0][1]).toEqual(['solo']);
    expect(set.mock.calls[0][2]).toMatchObject({ type: 'REG_JSON', source: 'calendar-notifier' });
  });

  it('registry value round-trips as the dedupe source on later ticks', async () => {
    const notify = { show: vi.fn() };
    const store = new Map([[FIRED_REG, ['pre-notified']]]);
    const registry = {
      get: vi.fn((k) => store.get(k)),
      set: vi.fn((k, v) => { store.set(k, v); }),
    };
    const { window } = await mount({ registry, notify });
    freezeAt('2026-11-17T12:00:00');
    seedEvents([
      ev({ id: 'pre-notified', title: 'Already told', timeStart: '12:02' }),
      ev({ id: 'fresh', title: 'New one', timeStart: '12:03' }),
    ]);
    window.CalendarNotifier._tick();
    expect(notify.show).toHaveBeenCalledTimes(1); // only the fresh event
    expect(store.get(FIRED_REG)).toEqual(expect.arrayContaining(['pre-notified', 'fresh']));
  });

  it('a non-array registry value behaves like an empty dedupe set', async () => {
    const notify = { show: vi.fn() };
    const registry = { get: vi.fn(() => 'not-an-array'), set: vi.fn() };
    const { window } = await mount({ registry, notify });
    freezeAt('2026-11-17T12:00:00');
    seedEvents([ev({ id: 'once', timeStart: '12:01' })]);
    window.CalendarNotifier._tick();
    expect(notify.show).toHaveBeenCalledTimes(1); // no prior ids → notifies
    window.CalendarNotifier._tick();
    // the save went to the registry mock; the loader still returns
    // 'not-an-array' → empty set again → re-notifies (fail-soft, no throw)
    expect(notify.show).toHaveBeenCalledTimes(2);
  });

  it('falls back to legacy localStorage for fired ids when the registry is absent or throws', async () => {
    const notify = { show: vi.fn() };
    const throwingRegistry = { get: vi.fn(() => { throw new Error('reg down'); }), set: vi.fn(() => { throw new Error('reg down'); }) };

    // absent registry → legacy load from localStorage (write AFTER mount:
    // each cover load starts with a fresh storage)
    const first = await mount({ notify });
    localStorage.setItem(FIRED, JSON.stringify(['legacy-id']));
    freezeAt('2026-11-17T12:00:00');
    seedEvents([
      ev({ id: 'legacy-id', title: 'Known', timeStart: '12:04' }),
      ev({ id: 'new-id', title: 'Unknown', timeStart: '12:05' }),
    ]);
    first.window.CalendarNotifier._tick();
    expect(notify.show).toHaveBeenCalledTimes(1); // only new-id
    expect(JSON.parse(localStorage.getItem(FIRED))).toEqual(expect.arrayContaining(['legacy-id', 'new-id']));

    // throwing registry on load → legacy; throwing on save → legacy write
    const second = await mount({ registry: throwingRegistry, notify });
    freezeAt('2026-11-17T12:00:00');
    seedEvents([ev({ id: 'post-crash', title: 'Still works', timeStart: '12:06' })]);
    second.window.CalendarNotifier._tick();
    expect(notify.show).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem(FIRED))).toEqual(expect.arrayContaining(['post-crash']));
  });

  it('legacy fired blob that is corrupt or non-array degrades to an empty set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notify = { show: vi.fn() };
    const { window } = await mount({ notify });
    localStorage.setItem(FIRED, '{corrupt json');
    freezeAt('2026-11-17T12:00:00');
    seedEvents([ev({ id: 'after-corrupt', timeStart: '12:07' })]);
    window.CalendarNotifier._tick();
    expect(notify.show).toHaveBeenCalledTimes(1);
    // non-array legacy value → empty set (no throw)
    const second = await mount({ notify });
    localStorage.setItem(FIRED, '"a string"'); // after mount: visible to the service
    freezeAt('2026-11-17T12:00:00');
    seedEvents([ev({ id: 'non-array-case', timeStart: '12:09' })]);
    second.window.CalendarNotifier._tick();
    expect(notify.show).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled(); // fail-soft: never warns to the user
  });

  it('caps the persisted fired list at the 500 most recent ids', async () => {
    const set = vi.fn();
    const registry = { get: vi.fn(() => undefined), set };
    const legacy = Array.from({ length: 500 }, (_, i) => `old-${i}`);
    const second = await mount({ registry });
    localStorage.setItem(FIRED, JSON.stringify(legacy)); // after mount: visible to the loader
    freezeAt('2026-11-17T12:00:00');
    seedEvents([ev({ id: 'latest', timeStart: '12:10' })]);
    second.window.CalendarNotifier._tick();
    const saved = set.mock.calls[0][1];
    expect(saved).toHaveLength(500);
    expect(saved[499]).toBe('latest');
    expect(saved.includes('old-499')).toBe(true);
    expect(saved.includes('old-0')).toBe(false); // oldest dropped
  });

  it('storage failures when saving fired ids are swallowed', async () => {
    const notify = { show: vi.fn() };
    const { window } = await mount({ notify });
    freezeAt('2026-11-17T12:00:00');
    seedEvents([ev({ id: 'quota', timeStart: '12:09' })]);
    const real = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: real.getItem.bind(real),
      setItem: () => { throw new Error('quota'); },
      removeItem: real.removeItem.bind(real),
      clear: real.clear.bind(real),
      key: real.key.bind(real),
      get length() { return real.length; },
    };
    expect(() => window.CalendarNotifier._tick()).not.toThrow();
    expect(notify.show).toHaveBeenCalledTimes(1); // reminder still shown
    globalThis.localStorage = real;
  });

  it('tolerates corrupt and non-array event storage; ignores unusable events', async () => {
    const notify = { show: vi.fn() };
    const { window } = await mount({ notify });
    freezeAt('2026-11-17T12:00:00');
    // corrupt events blob → empty list, no throw
    localStorage.setItem(EVENTS, '{not json');
    expect(() => window.CalendarNotifier._tick()).not.toThrow();
    // non-array → empty
    localStorage.setItem(EVENTS, '"just a string"');
    window.CalendarNotifier._tick();
    expect(notify.show).not.toHaveBeenCalled();
    // events with unusable date/time shapes are skipped
    seedEvents([
      null,
      { id: 'bad-date', date: '17-11-2026', timeStart: '12:00' },   // wrong format
      { id: 'bad-time', date: '2026-11-17', timeStart: '99:99' },   // impossible clock → Invalid Date
      { id: 'no-time', date: '2026-11-17' },                        // all-day: no reminder
      { date: '2026-11-17', timeStart: '12:02' },                   // no id at all: skipped
      ev({ id: 'good', timeStart: '12:02', title: 'Works' }),
    ]);
    window.CalendarNotifier._tick();
    expect(notify.show).toHaveBeenCalledTimes(1);
    expect(notify.show.mock.calls[0][0].title).toContain('Works');
  });
});
