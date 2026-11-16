import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CJS modules under test are loaded through createRequire so their execution
// is counted by vitest's v8 coverage (same pattern the original suite used).
const require = createRequire(import.meta.url);

const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const nodeCrypto = require('node:crypto');

const { bootstrap, createServerEnv, getMainWindowOptions, closeRequestIgnored } = require('../../scripts/startup.js');

// ── fixtures ────────────────────────────────────────────────────────────────

// tests/setup.js replaces globalThis.crypto with a stub whose `.subtle` lacks
// generateKey/exportKey. @peculiar/x509 — used by scripts/certs.js — resolves
// its default crypto provider from that global at import time, which would
// make REAL certificate generation silently fail inside bootstrap(). The
// library exposes an official provider-configuration hook; point it back at
// Node's real webcrypto so the genuine cert generation code runs for real.
require(path.join(REPO, 'node_modules', 'reflect-metadata'));
require(path.join(REPO, 'node_modules', '@peculiar', 'x509'))
  .cryptoProvider.set('default', nodeCrypto.webcrypto);

const tmpRoots = [];
function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

let envSnapshot;
function snapshotEnv() { envSnapshot = { ...process.env }; }
function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(envSnapshot)) process.env[key] = value;
}

function setEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
}

function waitFor(predicate, { timeout = 10_000, step = 25, label = 'condition' } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let result;
      try { result = predicate(); } catch (err) { return reject(err); }
      if (result) return resolve(result);
      if (Date.now() - started > timeout) {
        return reject(new Error(`waitFor(${label}) timed out after ${timeout}ms`));
      }
      setTimeout(tick, step);
    };
    tick();
  });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

async function killPid(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch (_) { /* already gone */ }
  const dead = await waitFor(() => !pidAlive(pid), { timeout: 4_000, label: `server ${pid} exit` })
    .then(() => true)
    .catch(() => false);
  if (!dead) {
    try { process.kill(pid, 'SIGKILL'); } catch (_) { /* already gone */ }
  }
}

function captureConsole() {
  const calls = { log: [], warn: [], error: [] };
  const spies = {};
  for (const level of Object.keys(calls)) {
    spies[level] = vi.spyOn(console, level).mockImplementation((...args) => {
      calls[level].push(args.map((a) => String(a)).join(' '));
    });
  }
  return {
    calls,
    restore() { for (const spy of Object.values(spies)) spy.mockRestore(); },
  };
}

function captureNewRejectionHandler() {
  const before = process.listeners('unhandledRejection');
  return {
    added() {
      return process.listeners('unhandledRejection').filter((fn) => !before.includes(fn));
    },
    cleanup() {
      for (const fn of process.listeners('unhandledRejection')) {
        if (!before.includes(fn)) process.removeListener('unhandledRejection', fn);
      }
    },
  };
}

// A real node script that plays the part of server/core/index.js. It reports
// its pid, optionally dumps the environment the parent handed it, and then
// behaves according to FAKE_SERVER_MODE so every readiness/exit branch of
// startup.js can be driven through a REAL spawned child process.
const FAKE_SERVER_SCRIPT = [
  "'use strict';",
  'const fs = require("fs");',
  'const mode = process.env.FAKE_SERVER_MODE || "listening";',
  'const write = (file, data) => { try { fs.writeFileSync(file, data); } catch (_) {} };',
  'if (process.env.FAKE_SERVER_PIDFILE) write(process.env.FAKE_SERVER_PIDFILE, String(process.pid));',
  'if (process.env.FAKE_SERVER_ENV_DUMP) {',
  '  write(process.env.FAKE_SERVER_ENV_DUMP, JSON.stringify({',
  '    cwd: process.cwd(),',
  '    script: process.argv[1],',
  '    argv: process.argv.slice(2),',
  '    NWJS_RUN_AS_NODE: process.env.NWJS_RUN_AS_NODE,',
  '    NODE_OPTIONS: process.env.NODE_OPTIONS,',
  '    SECRET: process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET,',
  '  }));',
  '}',
  'const emit = (s) => process.stdout.write(s);',
  'if (mode === "exit5") { process.exit(5); }',
  'else if (mode === "selfkill") { process.kill(process.pid, "SIGKILL"); }',
  'else if (mode === "listening") { emit("Listening on https://localhost:" + (process.env.PORT || "3003") + "\\n"); }',
  'else if (mode === "url") { emit("server ready at https://localhost:3003 for requests\\n"); }',
  'else if (mode === "address") { emit("Server Address: https://localhost listening\\n"); }',
  'else if (mode === "split") { emit("List"); setTimeout(() => emit("ening chunk-split\\n"), 150); }',
  'else if (mode === "junk") { emit("x".repeat(5000) + "\\n"); setTimeout(() => emit("Listening after junk\\n"), 400); }',
  'else if (mode === "double") { emit("Listening first\\n"); setTimeout(() => emit("Listening second\\n"), 150); }',
  'else if (mode === "stderr") { process.stderr.write("fake server stderr warning\\n"); emit("Listening with stderr\\n"); }',
  '// mode === "silent": stays alive printing nothing',
  'if (mode !== "exit5" && mode !== "selfkill") setInterval(() => {}, 1 << 30);',
  '',
].join('\n');

function envSecrets() {
  return {
    SESSION_SECRET: nodeCrypto.randomBytes(64).toString('hex'), // 128 hex chars
    NBOSP_CRED_KEY: nodeCrypto.randomBytes(32).toString('hex'), // 64 hex chars
  };
}

function validEnvContent(overrides = {}) {
  const secrets = envSecrets();
  const lines = [
    `PORT="${overrides.PORT ?? '3003'}"`,
    'RATE_LIMIT_WINDOW_MS="60000"',
    'RATE_LIMIT_MAX_REQUESTS="100"',
    'CORS_ORIGIN="https://localhost"',
    `SESSION_SECRET="${overrides.SESSION_SECRET ?? secrets.SESSION_SECRET}"`,
    `NBOSP_CRED_KEY="${overrides.NBOSP_CRED_KEY ?? secrets.NBOSP_CRED_KEY}"`,
    ...(overrides.extraLines ?? []),
  ];
  return lines.join('\n') + '\n';
}

// .env.example that still needs secrets generated — used for the cold-start flow.
const COLD_START_EXAMPLE = [
  'PORT="3003"',
  'RATE_LIMIT_WINDOW_MS="60000"',
  'RATE_LIMIT_MAX_REQUESTS="100"',
  'CORS_ORIGIN="https://localhost"',
].join('\n') + '\n';

// Real certificates generated once through the real ensureCerts() and copied
// into each test's runtime data dir, so bootstrap() exercises the
// "certs are fresh" path without paying RSA keygen per test.
let certTemplateDir;
beforeAll(async () => {
  certTemplateDir = mkTmp('nbosp-startup-certs-');
  fs.writeFileSync(path.join(certTemplateDir, 'package.json'), '{}');
  const { ensureCerts } = require('../../scripts/certs.js');
  await ensureCerts(certTemplateDir, () => true);
  for (const file of ['ca.key', 'ca.crt', 'cert.key', 'cert.crt']) {
    if (!fs.existsSync(path.join(certTemplateDir, file))) {
      throw new Error(`cert template generation failed: ${file} missing`);
    }
  }
}, 30_000);

function copyCertsInto(dataDir) {
  for (const file of ['ca.key', 'ca.crt', 'cert.key', 'cert.crt']) {
    fs.copyFileSync(path.join(certTemplateDir, file), path.join(dataDir, file));
  }
}

function makeWorkspace(opts = {}) {
  const tmp = mkTmp('nbosp-startup-');
  const appDir = path.join(tmp, 'app');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(path.join(appDir, 'server', 'core'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'nbosp-startup-test' }));
  fs.writeFileSync(path.join(appDir, 'server', 'core', 'index.js'), FAKE_SERVER_SCRIPT);
  if (opts.envExample !== null) {
    fs.writeFileSync(path.join(appDir, '.env.example'), opts.envExample ?? COLD_START_EXAMPLE);
  }
  if (opts.envFile !== null) {
    fs.writeFileSync(path.join(dataDir, '.env'), opts.envFile ?? validEnvContent({ PORT: opts.port }));
  }
  if (opts.certs !== false) copyCertsInto(dataDir);
  return { tmp, appDir, dataDir };
}

function makeNwStub(cfg = {}) {
  const stub = {
    calls: { windowOpen: [], quitCount: 0, quitHandlers: [] },
    windows: [],
  };
  stub.Window = {
    open(url, options, callback) {
      stub.calls.windowOpen.push({ url, options });
      if (cfg.nullWindow) { callback(null); return; }
      const fakeWin = {
        url,
        options,
        handlers: {},
        closeCalls: [],
        on(event, handler) { fakeWin.handlers[event] = handler; },
        close(arg) { fakeWin.closeCalls.push(arg); },
      };
      stub.windows.push(fakeWin);
      callback(fakeWin);
    },
  };
  stub.App = {
    quit() { stub.calls.quitCount += 1; },
    on(event, handler) { if (event === 'quit') stub.calls.quitHandlers.push(handler); },
  };
  return stub;
}

const livePids = new Set();
const activePidFiles = new Set();
let activeCap = null;
let activeRej = null;

async function runBootstrap(opts = {}) {
  const ws = makeWorkspace(opts);
  const pidFile = path.join(ws.tmp, 'server.pid');
  const envDump = path.join(ws.tmp, 'server-env.json');
  const nw = makeNwStub(opts.nw ?? {});
  globalThis.nw = nw;

  setEnv({
    NBOSP_DATA_DIR: ws.dataDir,
    // nodeBin: null → deliberately unset (spawn plain "node" from PATH)
    NODE_BIN_PATH: opts.nodeBin === null ? undefined : (opts.nodeBin ?? process.execPath),
    NODE_OPTIONS: undefined, // deterministic NODE_OPTIONS assertions
    FAKE_SERVER_PIDFILE: pidFile,
    FAKE_SERVER_ENV_DUMP: envDump,
    FAKE_SERVER_MODE: opts.serverMode ?? 'listening',
    NBOSP_KIOSK: opts.kiosk,
    NBOSP_ALLOW_WINDOW_CLOSE: opts.allowWindowClose,
    SERVER_HEAP_MB: opts.serverHeapMb,
    HTTPS: opts.httpsEnv,
    ...(opts.env ?? {}),
  });

  activeCap = captureConsole();
  activeRej = captureNewRejectionHandler();
  activePidFiles.add(pidFile);
  await bootstrap(ws.appDir);
  return { ...ws, nw, pidFile, envDump, cap: activeCap, rej: activeRej };
}

async function serverPid(ctx) {
  await waitFor(() => fs.existsSync(ctx.pidFile), { timeout: 5_000, label: 'server pid file' });
  const pid = Number(fs.readFileSync(ctx.pidFile, 'utf8').trim());
  livePids.add(pid);
  return pid;
}

function readLog(ctx) {
  const logPath = path.join(ctx.dataDir, 'server.log');
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

beforeEach(() => {
  snapshotEnv();
  // leftover NODE_OPTIONS from the outer runner would leak into every
  // spawned server child; drop it for deterministic assertions.
  delete process.env.NODE_OPTIONS;
});

afterEach(async () => {
  // Kill every server this test spawned (registered via its pid file) and
  // wait for the deaths so the module's exit handlers (log stream teardown)
  // run before the next test starts.
  const pids = new Set(livePids);
  for (const file of activePidFiles) {
    try {
      const pid = Number(fs.readFileSync(file, 'utf8').trim());
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    } catch (_) { /* pid file never written — server never started */ }
  }
  for (const pid of pids) await killPid(pid).catch(() => {});
  livePids.clear();
  activePidFiles.clear();
  activeRej?.cleanup();
  activeRej = null;
  activeCap?.restore();
  activeCap = null;
  restoreEnv();
  // Keep an inert nw global installed: a late readiness/fallback callback
  // from a server that died a tick ago must never crash the worker with
  // "nw is not defined". The next test installs its own recording stub.
  globalThis.nw = makeNwStub();
});

afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

// ── createServerEnv ─────────────────────────────────────────────────────────

describe('startup.createServerEnv', () => {
  const restoreAfter = () => restoreEnv();

  it('generates a fresh 64-hex-char API rate-limit secret per call and exports it on process.env', () => {
    const first = createServerEnv();
    const second = createServerEnv();
    expect(first.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET).toMatch(/^[a-f0-9]{64}$/);
    expect(second.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET).toMatch(/^[a-f0-9]{64}$/);
    expect(first.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET)
      .not.toBe(second.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET);
    // The secret is shared with the host renderer/server child via process.env
    expect(process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET)
      .toBe(second.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET);
    restoreAfter();
  });

  it('leaves NWJS_RUN_AS_NODE unset for the plain "node" binary and sets it for anything else', () => {
    expect(createServerEnv('node').NWJS_RUN_AS_NODE).toBeUndefined();
    expect(createServerEnv('/usr/bin/nwjs').NWJS_RUN_AS_NODE).toBe('1');
    restoreAfter();
  });

  it('honours the NODE_BIN_PATH environment variable as the default binary', () => {
    setEnv({ NODE_BIN_PATH: '/opt/nwjs/nw' });
    const env = createServerEnv();
    expect(env.NWJS_RUN_AS_NODE).toBe('1');
    restoreAfter();
  });

  it('uses SERVER_HEAP_MB when it is a plain digit string', () => {
    setEnv({ SERVER_HEAP_MB: '512' });
    const env = createServerEnv();
    expect(env.NODE_OPTIONS).toContain('--max-old-space-size=512');
    expect(env.NODE_OPTIONS).toContain('--expose-gc');
    restoreAfter();
  });

  it.each([
    ['letters', 'abc'],
    ['empty', ''],
    ['negative', '-5'],
    ['decimal', '1024.5'],
    ['scientific', '1e3'],
    ['flag injection attempt', '1024 --permissive'],
  ])('falls back to a 1024MB heap for SERVER_HEAP_MB that is %s (%j)', (_label, raw) => {
    setEnv({ SERVER_HEAP_MB: raw });
    const env = createServerEnv();
    // exact match also proves no fragment of the raw value leaked through
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=1024 --expose-gc');
    restoreAfter();
  });

  it('prepends to an existing NODE_OPTIONS value without duplicating it', () => {
    setEnv({ NODE_OPTIONS: '--foo' });
    expect(createServerEnv().NODE_OPTIONS).toBe('--foo --max-old-space-size=1024 --expose-gc');
    restoreAfter();
  });

  it('produces a clean NODE_OPTIONS when the inherited one is unset or empty', () => {
    setEnv({ NODE_OPTIONS: undefined });
    expect(createServerEnv().NODE_OPTIONS).toBe('--max-old-space-size=1024 --expose-gc');
    setEnv({ NODE_OPTIONS: '' });
    expect(createServerEnv().NODE_OPTIONS).toBe('--max-old-space-size=1024 --expose-gc');
    restoreAfter();
  });

  it('returns a detached copy — mutating it never mutates process.env', () => {
    const env = createServerEnv();
    const secret = env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET;
    env.NODE_OPTIONS = 'tampered';
    env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET = 'tampered';
    expect(process.env.NODE_OPTIONS ?? '').not.toBe('tampered');
    expect(process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET).toBe(secret);
    // arbitrary inherited entries survive the spread
    setEnv({ NBOSP_STARTUP_TEST_MARKER: 'here' });
    expect(createServerEnv().NBOSP_STARTUP_TEST_MARKER).toBe('here');
    restoreAfter();
  });
});

// ── getMainWindowOptions ────────────────────────────────────────────────────

describe('startup.getMainWindowOptions', () => {
  it('returns the exact kiosk window configuration', () => {
    expect(getMainWindowOptions(true)).toEqual({
      title: 'NovaByte',
      width: 1280,
      height: 720,
      frame: false,
      fullscreen: true,
      kiosk: true,
      resizable: false,
    });
  });

  it('returns the exact framed development window configuration', () => {
    expect(getMainWindowOptions(false)).toEqual({
      title: 'NovaByte',
      width: 1280,
      height: 720,
      frame: true,
      fullscreen: false,
      kiosk: false,
      resizable: true,
    });
  });

  it('defaults to the NBOSP_KIOSK environment variable', () => {
    setEnv({ NBOSP_KIOSK: '1' });
    expect(getMainWindowOptions().kiosk).toBe(true);
    expect(getMainWindowOptions().frame).toBe(false);
    setEnv({ NBOSP_KIOSK: '0' });
    expect(getMainWindowOptions().kiosk).toBe(false);
    expect(getMainWindowOptions().resizable).toBe(true);
    setEnv({ NBOSP_KIOSK: undefined });
    expect(getMainWindowOptions().kiosk).toBe(false);
  });
});

// ── closeRequestIgnored ─────────────────────────────────────────────────────

describe('startup.closeRequestIgnored — Alt+F4 guard decision', () => {
  it('ignores close requests for every window shape and kiosk mode', () => {
    expect(closeRequestIgnored({}, {})).toBe(true);
    expect(closeRequestIgnored({ NBOSP_KIOSK: '1' }, { NBOSP_KIOSK: '1' })).toBe(true);
    expect(closeRequestIgnored(null, {})).toBe(true);
    expect(closeRequestIgnored(undefined, undefined)).toBe(true);
  });

  it('treats falsy force flags as "not forced"', () => {
    for (const falsy of [false, 0, '', undefined, null]) {
      expect(closeRequestIgnored({ __nbospForceClose: falsy }, {})).toBe(true);
    }
  });

  it('lets the OS shutdown flow force the close programmatically', () => {
    expect(closeRequestIgnored({ __nbospForceClose: true }, {})).toBe(false);
    expect(closeRequestIgnored({ __nbospForceClose: true }, { NBOSP_ALLOW_WINDOW_CLOSE: '1' })).toBe(false);
  });

  it('lets developers opt out with NBOSP_ALLOW_WINDOW_CLOSE=1', () => {
    expect(closeRequestIgnored({}, { NBOSP_ALLOW_WINDOW_CLOSE: '1' })).toBe(false);
  });

  it('reads process.env when no explicit env is passed, and an explicit env wins', () => {
    setEnv({ NBOSP_ALLOW_WINDOW_CLOSE: '1' });
    // default env argument is process.env
    expect(closeRequestIgnored({})).toBe(false);
    // explicit env object takes precedence over process.env
    expect(closeRequestIgnored({}, {})).toBe(true);
    // ...and an explicit null env is tolerated (optional chaining branch)
    expect(closeRequestIgnored({ __nbospForceClose: true }, null)).toBe(false);
    setEnv({ NBOSP_ALLOW_WINDOW_CLOSE: undefined });
    expect(closeRequestIgnored({})).toBe(true);
  });
});

// ── bootstrap() — environment preparation ───────────────────────────────────

describe('startup.bootstrap — environment preparation', () => {
  it('boots end to end: env loaded, real server spawned, readiness detected, window opened', { timeout: 30_000 }, async () => {
    const ctx = await runBootstrap({});
    const pid = await serverPid(ctx);
    expect(pidAlive(pid)).toBe(true);

    await waitFor(() => ctx.nw.calls.windowOpen.length > 0, { timeout: 8_000, label: 'window open' });
    expect(ctx.nw.calls.windowOpen[0].url).toBe('https://localhost:3003');
    expect(ctx.nw.calls.windowOpen[0].options).toEqual(getMainWindowOptions(false));

    // exactly one safety-net rejection listener and one NW quit hook registered
    expect(ctx.rej.added()).toHaveLength(1);
    expect(ctx.nw.calls.quitHandlers).toHaveLength(1);

    // the real child's stdout was tee'd into the runtime data dir log
    await waitFor(() => readLog(ctx).includes('Listening on https://localhost:3003'), {
      timeout: 5_000, label: 'server stdout in server.log',
    });

    // server teardown emits the exit line into the same log
    await killPid(pid);
    livePids.delete(pid);
    await waitFor(() => readLog(ctx).includes('Server exited (code=null, signal=SIGTERM)'), {
      timeout: 5_000, label: 'exit line in server.log',
    });
  });

  it('applies kiosk window options and a custom PORT from the runtime .env', { timeout: 30_000 }, async () => {
    const ctx = await runBootstrap({ kiosk: '1', port: '8443' });
    await waitFor(() => ctx.nw.calls.windowOpen.length > 0, { timeout: 8_000, label: 'window open' });
    expect(ctx.nw.calls.windowOpen[0].url).toBe('https://localhost:8443');
    expect(ctx.nw.calls.windowOpen[0].options).toEqual(getMainWindowOptions(true));
  });

  it('detects readiness from the "https://localhost" output token', { timeout: 30_000 }, async () => {
    const ctx = await runBootstrap({ serverMode: 'url' });
    await waitFor(() => ctx.nw.calls.windowOpen.length > 0, { timeout: 8_000, label: 'window open' });
    expect(ctx.nw.calls.windowOpen[0].url).toBe('https://localhost:3003');
  });

  it('detects readiness from the "Address" output token', { timeout: 30_000 }, async () => {
    const ctx = await runBootstrap({ serverMode: 'address' });
    await waitFor(() => ctx.nw.calls.windowOpen.length > 0, { timeout: 8_000, label: 'window open' });
    expect(ctx.nw.calls.windowOpen.length).toBe(1);
  });

  it('reassembles readiness tokens split across stdout chunks', { timeout: 30_000 }, async () => {
    const ctx = await runBootstrap({ serverMode: 'split' });
    await waitFor(() => ctx.nw.calls.windowOpen.length > 0, { timeout: 8_000, label: 'window open' });
    expect(ctx.nw.calls.windowOpen.length).toBe(1);
  });

  it('trims the rolling stdout buffer past 4KB without losing a later readiness marker', { timeout: 30_000 }, async () => {
    const ctx = await runBootstrap({ serverMode: 'junk' });
    const pid = await serverPid(ctx);
    // The 5000 junk bytes arrive immediately; the marker comes 400ms later.
    // Give the junk time to be consumed while asserting no premature window.
    await new Promise((r) => setTimeout(r, 250));
    expect(ctx.nw.calls.windowOpen.length).toBe(0);
    await waitFor(() => ctx.nw.calls.windowOpen.length > 0, { timeout: 8_000, label: 'window open after junk' });
    // the junk itself still went through the tee into the log file
    expect(readLog(ctx).length).toBeGreaterThan(4096);
    expect(pidAlive(pid)).toBe(true);
  });

  it('passes server stderr through the tee into server.log', { timeout: 30_000 }, async () => {
    const ctx = await runBootstrap({ serverMode: 'stderr' });
    await waitFor(() => readLog(ctx).includes('fake server stderr warning'), {
      timeout: 8_000, label: 'stderr in server.log',
    });
    await waitFor(() => ctx.nw.calls.windowOpen.length > 0, { timeout: 8_000, label: 'window open' });
  });

  it('opens the window exactly once even when readiness is announced twice', { timeout: 30_000 }, async () => {
    const ctx = await runBootstrap({ serverMode: 'double' });
    await waitFor(() => ctx.nw.calls.windowOpen.length > 0, { timeout: 8_000, label: 'first window' });
    await new Promise((r) => setTimeout(r, 400));
    expect(ctx.nw.calls.windowOpen.length).toBe(1);
  });

  it('falls back to opening the window after 8s when the server never announces readiness', { timeout: 30_000 }, async () => {
    const started = Date.now();
    const ctx = await runBootstrap({ serverMode: 'silent' });
    await serverPid(ctx);
    await waitFor(() => ctx.nw.calls.windowOpen.length > 0, { timeout: 12_000, label: 'fallback window' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(7_800);
    expect(ctx.nw.calls.windowOpen[0].url).toBe('https://localhost:3003');
  });

  it('logs a spawn error for a missing node binary and still opens the window via the 8s fallback', { timeout: 30_000 }, async () => {
    const ctx = await runBootstrap({ nodeBin: '/nonexistent/nw-node-binary' });
    await waitFor(() => readLog(ctx).includes('Server spawn error:'), {
      timeout: 8_000, label: 'spawn error logged',
    });
    // ENOENT fires 'error' (and 'close') but never 'exit', so the fallback
    // timer survives and must still open a window to the configured URL.
    await waitFor(() => ctx.nw.calls.windowOpen.length > 0, { timeout: 12_000, label: 'fallback window' });
    expect(ctx.nw.calls.windowOpen[0].url).toBe('https://localhost:3003');
  });

  it('records a non-zero server exit, tears down the log stream and never opens a window', { timeout: 30_000 }, async () => {
    const ctx = await runBootstrap({ serverMode: 'exit5' });
    const pid = await serverPid(ctx);
    await waitFor(() => !pidAlive(pid), { timeout: 8_000, label: 'server exit' });
    livePids.delete(pid);
    await waitFor(() => readLog(ctx).includes('Server exited (code=5, signal=null)'), {
      timeout: 5_000, label: 'exit(5) line in server.log',
    });
    // the exit handler cleared the fallback timer — no window may appear
    await new Promise((r) => setTimeout(r, 600));
    expect(ctx.nw.calls.windowOpen.length).toBe(0);
  });

  it('records a server death by signal before readiness and suppresses the fallback window', { timeout: 30_000 }, async () => {
    const ctx = await runBootstrap({ serverMode: 'selfkill' });
    const pid = await serverPid(ctx);
    await waitFor(() => !pidAlive(pid), { timeout: 8_000, label: 'server self-kill' });
    livePids.delete(pid);
    await waitFor(() => readLog(ctx).includes('Server exited (code=null, signal=SIGKILL)'), {
      timeout: 5_000, label: 'SIGKILL line in server.log',
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(ctx.nw.calls.windowOpen.length).toBe(0);
  });

  it('records an externally signalled server shutdown', { timeout: 30_000 }, async () => {
    const ctx = await runBootstrap({});
    const pid = await serverPid(ctx);
    await waitFor(() => ctx.nw.calls.windowOpen.length > 0, { timeout: 8_000, label: 'window open' });
    await killPid(pid);
    livePids.delete(pid);
    await waitFor(() => readLog(ctx).includes('Server exited (code=null, signal=SIGTERM)'), {
      timeout: 5_000, label: 'SIGTERM line in server.log',
    });
  });

  it('hands the prepared server environment and spawn layout to the real server child', { timeout: 30_000 }, async () => {
    const ctx = await runBootstrap({ serverMode: 'listening', serverHeapMb: '256' });
    await waitFor(() => fs.existsSync(ctx.envDump), { timeout: 8_000, label: 'env dump written' });
    const dump = JSON.parse(fs.readFileSync(ctx.envDump, 'utf8'));
    // spawn ran the absolute server script path with cwd = appDir and no extra args
    expect(dump.script).toBe(path.join(ctx.appDir, 'server', 'core', 'index.js'));
    expect(dump.argv).toEqual([]);
    expect(dump.cwd).toBe(ctx.appDir);
    // createServerEnv wiring reached the real child process
    expect(dump.NWJS_RUN_AS_NODE).toBe('1'); // NODE_BIN_PATH was not plain 'node'
    expect(dump.NODE_OPTIONS).toContain('--max-old-space-size=256');
    expect(dump.NODE_OPTIONS).toContain('--expose-gc');
    expect(dump.SECRET).toMatch(/^[a-f0-9]{64}$/);
    expect(dump.SECRET).toBe(process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET);
    await waitFor(() => ctx.nw.calls.windowOpen.length > 0, { timeout: 8_000, label: 'window open' });
  });
});

// ── bootstrap() — HTTPS enforcement ─────────────────────────────────────────

describe('startup.bootstrap — HTTPS enforcement in the runtime .env', () => {
  it('appends HTTPS=true to a .env that has no HTTPS line at all', { timeout: 30_000 }, async () => {
    const envFile = validEnvContent({});
    const ctx = await runBootstrap({ envFile, httpsEnv: undefined });
    const envPath = path.join(ctx.dataDir, '.env');
    const after = fs.readFileSync(envPath, 'utf8');
    expect(after.startsWith(envFile)).toBe(true);
    expect(after.endsWith('\nHTTPS=true\n')).toBe(true);
    expect(process.env.HTTPS).toBe('true');
  });

  it('leaves the .env untouched when process.env.HTTPS is already true', { timeout: 30_000 }, async () => {
    const envFile = validEnvContent({});
    const ctx = await runBootstrap({ envFile, httpsEnv: 'true' });
    expect(fs.readFileSync(path.join(ctx.dataDir, '.env'), 'utf8')).toBe(envFile);
    expect(process.env.HTTPS).toBe('true');
  });

  it('does not append when an HTTPS= line already exists (even HTTPS="false")', { timeout: 30_000 }, async () => {
    const envFile = validEnvContent({ extraLines: ['HTTPS="false"'] });
    const ctx = await runBootstrap({ envFile, httpsEnv: undefined });
    expect(fs.readFileSync(path.join(ctx.dataDir, '.env'), 'utf8')).toBe(envFile);
    // the in-memory flag is still forced to true for this launch
    expect(process.env.HTTPS).toBe('true');
  });
});

// ── bootstrap() — failure paths ─────────────────────────────────────────────

describe('startup.bootstrap — failure paths', () => {
  it('rejects with the fatal env error when .env and .env.example are both missing', { timeout: 30_000 }, async () => {
    const ws = makeWorkspace({ envExample: null, envFile: null });
    setEnv({ NBOSP_DATA_DIR: ws.dataDir });
    await expect(bootstrap(ws.appDir))
      .rejects.toThrow('.env and .env.example are both missing or empty');
  });

  it('rejects with schema violations from .env.example before spawning anything', { timeout: 30_000 }, async () => {
    const ws = makeWorkspace({
      envExample: COLD_START_EXAMPLE.replace('PORT="3003"', 'PORT="not-a-port"'),
      envFile: null,
    });
    setEnv({ NBOSP_DATA_DIR: ws.dataDir });
    const cap = captureConsole();
    try {
      await expect(bootstrap(ws.appDir)).rejects.toThrow('PORT: must be integer 1–65535');
    } finally { cap.restore(); }
    // the cold-start flow ran for real before validation failed
    expect(cap.calls.log.join('\n')).toContain('[NovaByte] No .env found — bootstrapping from .env.example...');
    expect(cap.calls.log.join('\n')).toContain('[NovaByte] Generating missing SESSION_SECRET...');
    expect(cap.calls.log.join('\n')).toContain('[NovaByte] .env updated with generated secrets (atomic write).');
    // ...and the generated .env really is on disk with fresh secrets
    const written = fs.readFileSync(path.join(ws.dataDir, '.env'), 'utf8');
    expect(written).toContain('PORT="not-a-port"');
    expect(written).toMatch(/SESSION_SECRET="[a-f0-9]{128}"/);
    expect(written).toMatch(/NBOSP_CRED_KEY="[a-f0-9]{64}"/);
  });

  it('bootstraps a cold start from .env.example end to end (secrets generated, server up, window open)', { timeout: 30_000 }, async () => {
    const ctx = await runBootstrap({ envFile: null }); // only .env.example exists
    const envPath = path.join(ctx.dataDir, '.env');
    expect(fs.existsSync(envPath)).toBe(true);
    const written = fs.readFileSync(envPath, 'utf8');
    expect(written).toMatch(/SESSION_SECRET="[a-f0-9]{128}"/);
    expect(written).toMatch(/NBOSP_CRED_KEY="[a-f0-9]{64}"/);
    await waitFor(() => ctx.nw.calls.windowOpen.length > 0, { timeout: 8_000, label: 'window open' });
    // HTTPS=true was appended to the freshly generated .env
    expect(written.includes('HTTPS=') || fs.readFileSync(envPath, 'utf8').endsWith('\nHTTPS=true\n')).toBe(true);
  });
});

// ── bootstrap() — window lifecycle through the nw stub ──────────────────────

describe('startup.bootstrap — window lifecycle', () => {
  async function openWindowCtx(opts = {}) {
    const ctx = await runBootstrap(opts);
    await waitFor(() => ctx.nw.windows.length > 0, { timeout: 8_000, label: 'window open' });
    const pid = await serverPid(ctx);
    expect(pidAlive(pid)).toBe(true);
    return { ctx, pid, win: ctx.nw.windows[0] };
  }

  it('ignores a WM close request in every mode: warns, keeps the server, never closes', { timeout: 30_000 }, async () => {
    const { ctx, pid, win } = await openWindowCtx();
    win.handlers.close.call(win);
    expect(ctx.cap.calls.warn).toContain(
      '[NovaByte] Close request ignored (Alt+F4 is disabled for the NovaByte app).'
    );
    // nothing was torn down
    await new Promise((r) => setTimeout(r, 300));
    expect(pidAlive(pid)).toBe(true);
    expect(win.closeCalls).toEqual([]);
    expect(ctx.nw.calls.quitCount).toBe(0);
  });

  it('honours win.__nbospForceClose: kills the server, force-closes, quits NW', { timeout: 30_000 }, async () => {
    const { ctx, pid, win } = await openWindowCtx();
    win.__nbospForceClose = true;
    win.handlers.close.call(win);
    expect(ctx.cap.calls.warn.filter((w) => w.includes('Close request ignored'))).toEqual([]);
    await waitFor(() => !pidAlive(pid), { timeout: 5_000, label: 'server killed by close handler' });
    livePids.delete(pid);
    expect(win.closeCalls).toEqual([true]);
    expect(ctx.nw.calls.quitCount).toBe(1);
  });

  it('honours the NBOSP_ALLOW_WINDOW_CLOSE=1 developer opt-out', { timeout: 30_000 }, async () => {
    const { ctx, pid, win } = await openWindowCtx({ allowWindowClose: '1' });
    win.handlers.close.call(win); // no force flag needed
    expect(ctx.cap.calls.warn.filter((w) => w.includes('Close request ignored'))).toEqual([]);
    await waitFor(() => !pidAlive(pid), { timeout: 5_000, label: 'server killed by close handler' });
    livePids.delete(pid);
    expect(win.closeCalls).toEqual([true]);
    expect(ctx.nw.calls.quitCount).toBe(1);
  });

  it('nw quit handler kills the server, and a later forced close skips the redundant kill', { timeout: 30_000 }, async () => {
    const { ctx, pid, win } = await openWindowCtx();
    const quitHandler = ctx.nw.calls.quitHandlers[0];
    quitHandler(); // NW.js is exiting — server must be terminated
    await waitFor(() => !pidAlive(pid), { timeout: 5_000, label: 'server killed by quit handler' });
    livePids.delete(pid);
    // App.quit is not called by the quit handler itself
    expect(ctx.nw.calls.quitCount).toBe(0);
    // a forced close afterwards must not attempt a second kill of a killed child
    win.__nbospForceClose = true;
    expect(() => win.handlers.close.call(win)).not.toThrow();
    expect(win.closeCalls).toEqual([true]);
    expect(ctx.nw.calls.quitCount).toBe(1);
    // re-invoking quit after everything is dead stays harmless
    expect(() => quitHandler()).not.toThrow();
  });

  it('survives a null createdWindow from nw.Window.open', { timeout: 30_000 }, async () => {
    const ctx = await runBootstrap({ nw: { nullWindow: true } });
    const pid = await serverPid(ctx);
    await waitFor(() => ctx.nw.calls.windowOpen.length > 0, { timeout: 8_000, label: 'window open attempted' });
    expect(ctx.nw.windows).toHaveLength(0);
    expect(ctx.nw.calls.quitCount).toBe(0);
    // the readiness already fired, so no second open is attempted
    await new Promise((r) => setTimeout(r, 300));
    expect(ctx.nw.calls.windowOpen.length).toBe(1);
    expect(pidAlive(pid)).toBe(true);
  });
});

// ── bootstrap() — unhandledRejection safety net ─────────────────────────────

describe('startup.bootstrap — unhandledRejection safety net', () => {
  it('prints the stack for Error reasons and the stringified value for anything else', { timeout: 30_000 }, async () => {
    const ctx = await runBootstrap({});
    await waitFor(() => ctx.nw.calls.windowOpen.length > 0, { timeout: 8_000, label: 'window open' });
    const [handler] = ctx.rej.added();
    expect(typeof handler).toBe('function');

    const reason = new Error('boom-rejection');
    handler(reason);
    const errorLog = ctx.cap.calls.error.join('\n');
    expect(errorLog).toContain('[NovaByte] Unhandled rejection:');
    expect(errorLog).toContain('boom-rejection');
    expect(errorLog).toMatch(/at /); // full stack observability

    ctx.cap.calls.error.length = 0;
    handler('plain string reason');
    expect(ctx.cap.calls.error.join('\n')).toContain('[NovaByte] Unhandled rejection: plain string reason');

    // an Error whose stack was stripped falls back to .message
    ctx.cap.calls.error.length = 0;
    const stackless = Object.assign(new Error('stackless reason'), { stack: '' });
    handler(stackless);
    expect(ctx.cap.calls.error.join('\n')).toContain('Unhandled rejection: stackless reason');
  });
});

describe('startup.bootstrap — port and binary resolution fallbacks', () => {
  it('spawns plain "node" from PATH when NODE_BIN_PATH is unset', { timeout: 30_000 }, async () => {
    const ctx = await runBootstrap({ serverMode: 'listening', nodeBin: null });
    const pid = await serverPid(ctx); // the fake server really booted
    await waitFor(() => ctx.nw.calls.windowOpen.length > 0, { timeout: 8_000, label: 'window open' });
    expect(pidAlive(pid)).toBe(true);
  });

  it('ends the Windows console stream when the server exits', { timeout: 30_000 }, async () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const cwd = process.cwd();
    const scratch = mkTmp('nbosp-startup-conout-');
    process.chdir(scratch); // the CONOUT$-named scratch file lands here
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const ctx = await runBootstrap({ serverMode: 'exit5', env: { NW_SHOW_CONSOLE: 'true' } });
      const pid = await serverPid(ctx);
      await waitFor(() => !pidAlive(pid), { timeout: 8_000, label: 'server exit' });
      livePids.delete(pid);
      await waitFor(() => readLog(ctx).includes('Server exited (code=5, signal=null)'), {
        timeout: 5_000, label: 'exit(5) line in server.log',
      });
    } finally {
      Object.defineProperty(process, 'platform', origPlatform);
      process.chdir(cwd);
    }
  });
});
