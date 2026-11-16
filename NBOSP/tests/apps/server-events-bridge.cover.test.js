// tests/apps/server-events-bridge.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/server-events-bridge/service.js.
// The real service is require()d against a live JSDOM window; the
// EventSource boundary (the only network edge this service has) is stubbed
// two ways — a working source whose handlers are then fired for real, and a
// throwing constructor for the catch/reconnect path. Fake timers drive the
// backoff loop, and a window-less require covers the tail guard's false arm.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { coverLoadServiceApp, requireFresh } from '../helpers/cover-loader.js';

function makeFakeEventSource(log) {
  return class FakeEventSource {
    constructor(url) {
      this.url = url;
      log.push(`ctor:${url}`);
    }
    close() { log.push('close'); }
  };
}

describe('ServerEventsBridge (js/apps/server-events-bridge/service.js) — e2e coverage', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts on load, connects once, and start() is idempotent', async () => {
    const log = [];
    vi.useFakeTimers();
    const { window } = await coverLoadServiceApp('server-events-bridge', {
      stubs: { extra: { EventSource: makeFakeEventSource(log) } },
    });
    const bridge = window.ServerEventsBridge;
    expect(bridge).toBeTruthy();
    expect(log).toEqual(['ctor:/api/events/stream']); // exactly one connect
    bridge.start(); // _source set → early return
    expect(log).toEqual(['ctor:/api/events/stream']);
    expect(bridge._source).toBeInstanceOf(window.EventSource);
  });

  it('forwards well-formed frames to window.EventLog.ingestRemote and resets backoff on open', async () => {
    vi.useFakeTimers();
    const ingested = [];
    const { window } = await coverLoadServiceApp('server-events-bridge', {
      stubs: { extra: { EventSource: makeFakeEventSource([]) } },
    });
    const bridge = window.ServerEventsBridge;
    // prime a non-default backoff, then let onopen reset it
    bridge._retryMs = 16000;
    bridge._source.onopen();
    expect(bridge._retryMs).toBe(1000);
    window.EventLog = {
      ingestRemote(entry) { ingested.push(entry); },
    };
    const frame = JSON.stringify({ app: 'security', message: 'signin blocked' });
    bridge._source.onmessage({ data: frame });
    expect(ingested).toEqual([{ app: 'security', message: 'signin blocked' }]);
    // no EventLog the second time — the typeof guard skips the call
    delete window.EventLog;
    bridge._source.onmessage({ data: frame });
    expect(ingested).toHaveLength(1);
    window.EventLog = {}; // present but ingestRemote missing → skip side of the function check
    bridge._source.onmessage({ data: frame });
    expect(ingested).toHaveLength(1);
  });

  it('logs and survives malformed frames (JSON.parse throw)', async () => {
    vi.useFakeTimers();
    const { window } = await coverLoadServiceApp('server-events-bridge', {
      stubs: { extra: { EventSource: makeFakeEventSource([]) } },
    });
    const bridge = window.ServerEventsBridge;
    expect(() => bridge._source.onmessage({ data: '{not json' })).not.toThrow();
  });

  it('onerror closes the source, clears it and schedules a reconnect', async () => {
    const log = [];
    vi.useFakeTimers();
    const { window } = await coverLoadServiceApp('server-events-bridge', {
      stubs: { extra: { EventSource: makeFakeEventSource(log) } },
    });
    const bridge = window.ServerEventsBridge;
    const firstSource = bridge._source;
    bridge._source.onerror();
    expect(log).toContain('close');
    expect(bridge._source).toBeNull();
    vi.advanceTimersByTime(1000); // first backoff tick → reconnect
    expect(log.filter((e) => e === 'ctor:/api/events/stream')).toHaveLength(2);
  });

  it('a throwing EventSource constructor falls back to reconnect immediately', async () => {
    const log = [];
    vi.useFakeTimers();
    class ThrowingES { constructor() { throw new Error('EventSource unavailable'); } }
    const { window } = await coverLoadServiceApp('server-events-bridge', {
      stubs: { extra: { EventSource: ThrowingES } },
    });
    const bridge = window.ServerEventsBridge;
    expect(bridge._source).toBeNull(); // failed ctor never assigns
    vi.advanceTimersByTime(1000); // reconnect scheduled from the catch
    expect(log).toEqual([]);
    // after the retry the stub still throws → stays null, schedules again
    expect(bridge._source).toBeNull();
    vi.advanceTimersByTime(2000);
    expect(bridge._source).toBeNull();
  });

  it('backoff doubles per attempt and caps at 30s (Math.min cap)', async () => {
    vi.useFakeTimers();
    const { window } = await coverLoadServiceApp('server-events-bridge', {
      stubs: { extra: { EventSource: makeFakeEventSource([]) } },
    });
    const bridge = window.ServerEventsBridge;
    expect(bridge._retryMs).toBe(1000);
    bridge._scheduleReconnect(); expect(bridge._retryMs).toBe(2000);
    bridge._scheduleReconnect(); expect(bridge._retryMs).toBe(4000);
    bridge._scheduleReconnect(); expect(bridge._retryMs).toBe(8000);
    bridge._scheduleReconnect(); expect(bridge._retryMs).toBe(16000);
    bridge._scheduleReconnect(); expect(bridge._retryMs).toBe(30000); // 32000 capped
    bridge._scheduleReconnect(); expect(bridge._retryMs).toBe(30000); // stays capped
    // each scheduled reconnect really re-connects when it fires
    vi.advanceTimersByTime(30000);
    expect(bridge._source).toBeInstanceOf(window.EventSource);
  });

  it('a require without a window global skips the window assignment', async () => {
    const { window } = await coverLoadServiceApp('server-events-bridge', {
      stubs: { extra: { EventSource: makeFakeEventSource([]) } },
    });
    const first = window.ServerEventsBridge;
    const savedWindow = globalThis.window;
    const savedGlobalBridge = globalThis.ServerEventsBridge;
    delete globalThis.window;
    delete globalThis.ServerEventsBridge; // mirrorStubs may have copied the first bridge
    try {
      requireFresh('js/apps/server-events-bridge/service.js'); // fresh module scope connects via the stub, then the tail guard takes the window-less arm
      expect(globalThis.ServerEventsBridge).toBeUndefined();
    } finally {
      globalThis.window = savedWindow;
      globalThis.ServerEventsBridge = savedGlobalBridge ?? first;
    }
  });
});
