// tests/apps/network-activity-log.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/network-activity-log/service.js.
// The real service is require()d against a live JSDOM window (cover-loader),
// then the ring buffer is driven through its public surface: push (with and
// without a render hook, below and above MAX_ENTRIES), getAll and clear.
// A second require() in the same window covers the `window.NetworkLog || …`
// short-circuit on the already-initialised side.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { coverLoadServiceApp, requireFresh } from '../helpers/cover-loader.js';

describe('NetworkLog service (js/apps/network-activity-log/service.js) — e2e coverage', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.resetModules();
  });

  it('attaches the log facade and pushes entries below MAX_ENTRIES without trimming', async () => {
    const { window } = await coverLoadServiceApp('network-activity-log');
    const log = window.NetworkLog;
    expect(log).toBeTruthy();
    expect(log.MAX_ENTRIES).toBe(500);
    log.push({ app: 'browser', message: 'GET /a' });
    log.push({ app: 'email', message: 'login' });
    expect(log.entries.length).toBe(2);
    expect(log.getAll()[0].message).toBe('login');
    expect(log.getAll()).toBe(log.entries);
  });

  it('trims to MAX_ENTRIES once the buffer overflows', async () => {
    const { window } = await coverLoadServiceApp('network-activity-log');
    const log = window.NetworkLog;
    for (let i = 0; i < 501; i += 1) log.push({ app: 'x', message: `m${i}` });
    expect(log.entries.length).toBe(500);
    // most recent first, oldest evicted
    expect(log.entries[0].message).toBe('m500');
    expect(log.entries.find((e) => e.message === 'm0')).toBeUndefined();
    expect(log.entries.at(-1).message).toBe('m1');
  });

  it('invokes the render hook on push and clear when one is installed', async () => {
    const { window } = await coverLoadServiceApp('network-activity-log');
    const log = window.NetworkLog;
    const renders = [];
    log._renderFn = () => renders.push(log.entries.length);
    log.push({ app: 'x', message: 'boom' });
    log.clear();
    expect(renders).toEqual([1, 0]);
    expect(log.entries).toHaveLength(0);
  });

  it('skips the render hook when none is installed', async () => {
    const { window } = await coverLoadServiceApp('network-activity-log');
    const log = window.NetworkLog;
    expect(log._renderFn).toBeNull();
    log.push({ app: 'x', message: 'quiet' }); // ?.() skip side
    log.clear();
    expect(log.entries).toHaveLength(0);
  });

  it('re-require keeps the existing instance (|| short-circuit)', async () => {
    const { window } = await coverLoadServiceApp('network-activity-log');
    const first = window.NetworkLog;
    first.push({ app: 'x', message: 'persist' });
    requireFresh('js/apps/network-activity-log/service.js');
    expect(window.NetworkLog).toBe(first);
    expect(window.NetworkLog.getAll()[0].message).toBe('persist');
  });
});
