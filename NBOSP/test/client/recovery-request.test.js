import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const initSource = readFileSync(new URL('../../js/core/core/init.js', import.meta.url), 'utf8');

const REQUEST_FILE = '/home/nbosp/.config/novabyte/recovery-request';

function load({ platform = 'linux', home = '/home/nbosp', store = {}, hasPower = true } = {}) {
  const writes = [];
  const execs = [];
  const fs = {
    existsSync: (p) => (p === '/usr/bin/nbosp-power' ? hasPower : false),
    mkdirSync: vi.fn(),
    writeFileSync: (p, data) => writes.push([p, data]),
  };
  const modules = {
    fs,
    os: { homedir: () => home },
    path: { dirname: (p) => p.slice(0, p.lastIndexOf('/')) },
    child_process: { execFile: (file, args, cb) => { execs.push([file, args]); cb(null); } },
  };
  const bootScreen = { style: {}, replaceChildren: vi.fn() };
  const listeners = {};
  const context = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    process: { platform },
    require: (name) => modules[name],
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    document: {
      addEventListener() {},
      getElementById: (id) => (id === 'boot-screen' ? bootScreen : null),
      createElement: () => ({ style: {} }),
      body: { classList: { contains: () => false } },
    },
    setInterval: () => 1,
    clearInterval() {},
    Date,
    Object,
    JSON,
  };
  context.window = context;
  context.window.addEventListener = (type, fn) => { listeners[type] = fn; };
  runInNewContext(initSource, context);
  return { context, store, writes, execs, bootScreen, listeners };
}

describe('Linux recovery request', () => {
  it('writes the one-shot request file and restarts through nbosp-power', () => {
    const { context, writes, execs } = load();
    context.NovaRecovery.request('manual');
    expect(writes).toEqual([[REQUEST_FILE, 'manual\n']]);
    expect(execs).toEqual([['/usr/bin/nbosp-power', ['restart']]]);
  });

  it('only restarts once however many failures fire', () => {
    const { context, execs } = load();
    context.NovaRecovery.request('syntax_error');
    context.NovaRecovery.request('boot_timeout');
    expect(execs).toHaveLength(1);
  });

  it('acts on the Settings "Boot to Recovery" flag at startup and clears boot flags', () => {
    const { store, writes, execs } = load({
      store: { nova_manual_recovery: '1', nova_boot_attempts: '[{}]' },
    });
    expect(writes).toEqual([[REQUEST_FILE, 'manual\n']]);
    expect(execs).toHaveLength(1);
    expect(store.nova_manual_recovery).toBeUndefined();
    expect(store.nova_boot_attempts).toBeUndefined();
  });

  it('acts on a forced-recovery flag left by a failed boot', () => {
    const { writes } = load({ store: { nova_force_recovery: '1' } });
    expect(writes).toEqual([[REQUEST_FILE, 'boot_failure\n']]);
  });

  it('treats a syntax error in a core script as a recovery trigger', () => {
    const { listeners, writes } = load();
    listeners.error({ message: 'SyntaxError: Unexpected token', filename: '/js/core/core/boot.js' });
    expect(writes).toEqual([[REQUEST_FILE, 'syntax_error\n']]);
  });

  it('only disables the app, not the OS, when an app script has a syntax error', () => {
    const { listeners, writes, store } = load();
    listeners.error({ message: 'SyntaxError: x', filename: '/js/apps/foo.js' });
    expect(writes).toHaveLength(0);
    expect(JSON.parse(store.nova_disabled_apps)[0].id).toBe('foo');
  });
});

describe('recovery off NBOSP Linux', () => {
  it('shows the failure instead of restarting or looping', () => {
    const { context, writes, execs, bootScreen } = load({ platform: 'darwin' });
    context.NovaRecovery.request('boot_timeout');
    expect(writes).toHaveLength(0);
    expect(execs).toHaveLength(0);
    expect(bootScreen.replaceChildren).toHaveBeenCalledTimes(1);
  });

  it('is unavailable when the power helper is missing', () => {
    const { context } = load({ hasPower: false });
    expect(context.NovaRecovery.isAvailable()).toBe(false);
  });
});
