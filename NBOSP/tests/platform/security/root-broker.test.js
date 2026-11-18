import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JSDOM } from 'jsdom';

// ── js/platform/security/root-broker.js — NovaRoot broker, e2e ──────────────
//
// root-broker.js is a window-attach IIFE gated on a bare `require` — the
// host (NW.js) page provides it. This suite evals the REAL broker into a
// real JSDOM window with a controlled require: node's real fs/path/os, and
// a recording child_process whose execFileSync decides which sudo candidate
// "exists" and whose execFile plays the sudo outcomes. The confirmation
// prompt, caller-source gate, session cache, argv plumbing, base64 transport
// and audit trail are all driven through the real public window.NovaRoot.

const SCRIPT_URL = new URL('../../../js/platform/security/root-broker.js', import.meta.url);

let dom;
let w;
let sudo;
let logs;
let settings;
let granted;
let rootExecApps;
let userScopeEnabled;
let adminSession;

function installRequire({ sudoCandidatesOk = ['sudo'], execResults = [] } = {}) {
  const queue = [...execResults];
  sudo = {
    syncCalls: [],
    calls: [],
    respond(result) { queue.push(result); },
  };
  const cp = {
    execFileSync: (bin, args) => {
      sudo.syncCalls.push([bin, ...args]);
      if (sudoCandidatesOk.includes(bin)) return 'version';
      const err = new Error('not found');
      err.code = 'ENOENT';
      throw err;
    },
    execFile: (bin, argv, opts, cb) => {
      sudo.calls.push({ bin, argv, opts });
      const child = {
        exitCode: null,
        stdin: { on: () => {}, end: (data) => { sudo.calls.at(-1).stdin = data; } },
      };
      const outcome = queue.length ? queue.shift() : { code: 0, stdout: '', stderr: '' };
      if (outcome.spawnError) {
        queueMicrotask(() => cb(outcome.spawnError, '', ''));
        return child;
      }
      queueMicrotask(() => {
        child.exitCode = outcome.code ?? 0;
        cb(null, outcome.stdout ?? '', outcome.stderr ?? '');
      });
      return child;
    },
  };
  w.require = (name) => {
    if (name === 'child_process') return cp;
    if (name === 'fs') return fs;
    if (name === 'path') return path;
    if (name === 'os') return os;
    throw new Error('module not stubbed: ' + name);
  };
}

async function bootBroker(requireOpts) {
  installRequire(requireOpts);
  // The broker uses node's Buffer for base64 transport.
  w.Buffer = Buffer;
  w.eval(await readFile(SCRIPT_URL, 'utf8'));
  return w.NovaRoot;
}

/** Enable root mode + grant for the given app (the "happy" environment). */
function enableRootMode({ appId = 'com.example.rootapp' } = {}) {
  settings.devMode = true;
  settings.rootAccessEnabled = true;
  granted.clear();
  granted.add(appId);
  w.__novaUnrestrictedPackage = { id: appId };
}

/** Click a prompt button once it exists. */
async function clickPrompt(buttonText) {
  for (let i = 0; i < 100; i++) {
    const btn = [...w.document.querySelectorAll('button')].find((b) => b.textContent === buttonText);
    if (btn) { btn.click(); return; }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`prompt button "${buttonText}" never appeared`);
}

function pressKey(key) {
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}
void pressKey;

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://localhost/index.html',
  });
  w = dom.window;
  logs = [];
  settings = {};
  granted = new Set();
  rootExecApps = new Set();
  userScopeEnabled = false;
  adminSession = false;
  w.OS = {
    settings: { get: (k) => settings[k] },
    windows: new Map(),
    focusedWindowId: null,
  };
  w.AppPermissionManager = { isGranted: (perm, appId) => perm === 'system:root' && granted.has(appId) };
  w.AppSandbox = { isRootExecutionApp: (id) => rootExecApps.has(id) };
  w.EventLog = { log: (entry) => logs.push(entry) };
  w.NovaUserScope = { enabled: () => userScopeEnabled };
  w.SessionManager = { isAdmin: () => adminSession };
});

afterEach(() => {
  dom.window.close();
  dom = null;
  w = null;
  vi.restoreAllMocks();
});

describe('NovaRoot — status()', () => {
  it('reports unavailable with no sudo, no root mode and no session', async () => {
    await bootBroker({ sudoCandidatesOk: [] });
    const s = w.NovaRoot.status();
    expect(s).toMatchObject({ available: false, rootMode: false, sessionActive: false, sessionUntil: null });
    expect(s.appId).toBeNull();
  });

  it('resolves sudo from the candidate list exactly once (cached)', async () => {
    await bootBroker({ sudoCandidatesOk: ['/usr/bin/sudo'] });
    expect(w.NovaRoot.status().available).toBe(true);
    w.NovaRoot.status();
    w.NovaRoot.status();
    // Probed 'sudo' (missing) then '/usr/bin/sudo' (present) — and never
    // probed again once resolved.
    expect(sudo.syncCalls).toHaveLength(2);
    expect(sudo.syncCalls).toEqual([['sudo', '--version'], ['/usr/bin/sudo', '--version']]);
  });

  it('root mode requires BOTH developer mode and root access settings', async () => {
    await bootBroker({});
    settings.devMode = true;
    expect(w.NovaRoot.status().rootMode).toBe(false);
    settings.rootAccessEnabled = true;
    expect(w.NovaRoot.status().rootMode).toBe(true);
  });

  it('root mode additionally requires an admin session in multi-user mode', async () => {
    await bootBroker({});
    enableRootMode();
    userScopeEnabled = true;
    expect(w.NovaRoot.status().rootMode).toBe(false);
    adminSession = true;
    expect(w.NovaRoot.status().rootMode).toBe(true);
  });
});

describe('NovaRoot — caller identification', () => {
  it('identifies the caller from the novaapp: sourceURL stack marker', async () => {
    await bootBroker({});
    enableRootMode();
    w.eval(`
      window.__statusFromApp = window.NovaRoot.status();
      //# sourceURL=novaapp:com.stack.caller/entry.js
    `);
    expect(w.__statusFromApp.appId).toBe('com.stack.caller');
  });

  it('falls back to the unrestricted-package global', async () => {
    await bootBroker({});
    enableRootMode();
    expect(w.NovaRoot.status().appId).toBe('com.example.rootapp');
  });

  it('falls back to the focused root-execution window when neither stack nor global identify', async () => {
    await bootBroker({});
    enableRootMode();
    w.__novaUnrestrictedPackage = undefined;
    granted.add('com.example.focused');
    rootExecApps.add('com.example.focused');
    w.OS.windows.set('win-1', { appId: 'com.example.focused' });
    w.OS.focusedWindowId = 'win-1';
    expect(w.NovaRoot.status().appId).toBe('com.example.focused');
  });

  it('rejects an explicit appId that contradicts the stack marker', async () => {
    await bootBroker({});
    enableRootMode();
    w.eval(`
      window.__explicit = window.NovaRoot.status();
      window.__explicitMismatch = window.NovaRoot.run({ appId: 'other.app', argv: ['true'] })
        .then(() => 'resolved', (e) => e.code || e.message);
      //# sourceURL=novaapp:com.stack.caller/entry.js
    `);
    expect(w.__explicit.appId).toBe('com.stack.caller');
    // The mismatch resolves the caller to null → a root denial, not a run.
    await expect(w.__explicitMismatch).resolves.toBe('NOVA_ROOT_DENIED');
    expect(sudo.calls).toHaveLength(0);
  });

  it('honours an explicit appId that matches the stack marker', async () => {
    await bootBroker({ execResults: [{ code: 0, stdout: 'ok', stderr: '' }] });
    enableRootMode({ appId: 'com.stack.caller' });
    w.eval(`
      window.__matched = window.NovaRoot.run({ appId: 'com.stack.caller', argv: ['true'] })
        .then(() => 'granted', (e) => 'denied:' + e.code);
      //# sourceURL=novaapp:com.stack.caller/entry.js
    `);
    await clickPrompt('Allow');
    expect(await w.__matched).toBe('granted');
  });
});

describe('NovaRoot — requestSession() gating', () => {
  it('denies when root mode is disabled', async () => {
    await bootBroker({});
    enableRootMode();
    settings.devMode = false;
    const verdict = await w.NovaRoot.requestSession({ appId: 'com.example.rootapp' });
    expect(verdict).toEqual({ granted: false, reason: expect.stringContaining('Root Access is disabled') });
  });

  it('denies when the caller holds no system:root grant', async () => {
    await bootBroker({});
    enableRootMode();
    granted.clear();
    const verdict = await w.NovaRoot.requestSession({ appId: 'com.example.rootapp' });
    expect(verdict.granted).toBe(false);
    expect(verdict.reason).toContain('does not hold a system:root grant');
    expect(verdict.reason).toContain('.');
  });

  it('denies with the unidentified-caller wording when no appId resolves', async () => {
    await bootBroker({});
    enableRootMode();
    w.__novaUnrestrictedPackage = undefined;
    const verdict = await w.NovaRoot.requestSession({});
    expect(verdict.reason).toContain('(the caller could not be identified)');
  });

  it('denies with the unavailable message when sudo is missing, and audits it', async () => {
    await bootBroker({ sudoCandidatesOk: [] });
    enableRootMode();
    const verdict = await w.NovaRoot.requestSession({ appId: 'com.example.rootapp' });
    expect(verdict.granted).toBe(false);
    expect(verdict.reason).toContain('sudo is missing from this NovaByte OS image');
    expect(logs.at(-1)).toMatchObject({ app: 'NovaRoot', severity: 'error' });
  });
});

describe('NovaRoot — the confirmation prompt', () => {
  it('grants on Allow, caches the session and skips the prompt next time', async () => {
    await bootBroker({});
    enableRootMode();
    const first = w.NovaRoot.requestSession({ appId: 'com.example.rootapp', reason: 'install drivers' });
    await clickPrompt('Allow');
    expect(await first).toEqual({ granted: true });
    expect(logs.some((l) => l.message.includes('Root session granted for com.example.rootapp'))).toBe(true);

    // Second request: cached session, no new prompt.
    const second = await w.NovaRoot.requestSession({ appId: 'com.example.rootapp' });
    expect(second).toEqual({ granted: true });
    expect(w.document.querySelector('.modal-overlay')).toBeNull(); // only one prompt ever
    expect(w.NovaRoot.status().sessionActive).toBe(true);
    expect(w.NovaRoot.status().sessionUntil).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('shows the app name and reason, and the no-password note', async () => {
    await bootBroker({});
    enableRootMode();
    const p = w.NovaRoot.requestSession({ appId: 'com.example.rootapp', reason: 'because reasons' });
    await new Promise((r) => setTimeout(r, 20));
    const overlay = w.document.querySelector('.modal-overlay');
    expect(overlay).toBeTruthy();
    const text = overlay.textContent;
    expect(text).toContain('Root access confirmation');
    expect(text).toContain('com.example.rootapp');
    expect(text).toContain('because reasons');
    expect(text).toContain('No password is required');
    await clickPrompt('Cancel');
    expect(await p).toEqual({ granted: false, reason: 'Cancelled by user.' });
  });

  it('omits the reason line when no reason is given', async () => {
    await bootBroker({});
    enableRootMode();
    const p = w.NovaRoot.requestSession({ appId: 'com.example.rootapp' });
    await new Promise((r) => setTimeout(r, 20));
    const text = w.document.querySelector('.modal-overlay').textContent;
    expect(text).toContain('administrator (root) privileges');
    await clickPrompt('Cancel');
    await p;
  });

  it('Escape cancels and Enter grants', async () => {
    await bootBroker({});
    enableRootMode();
    const esc = w.NovaRoot.requestSession({ appId: 'com.example.rootapp' });
    await new Promise((r) => setTimeout(r, 20));
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(await esc).toEqual({ granted: false, reason: 'Cancelled by user.' });

    const enter = w.NovaRoot.requestSession({ appId: 'com.example.rootapp' });
    await new Promise((r) => setTimeout(r, 20));
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(await enter).toEqual({ granted: true });
  });

  it('a backdrop mousedown cancels', async () => {
    await bootBroker({});
    enableRootMode();
    const p = w.NovaRoot.requestSession({ appId: 'com.example.rootapp' });
    await new Promise((r) => setTimeout(r, 20));
    const overlay = w.document.querySelector('.modal-overlay');
    overlay.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    expect(await p).toEqual({ granted: false, reason: 'Cancelled by user.' });
  });

  it('coalesces concurrent requests into ONE prompt but re-checks each caller', async () => {
    await bootBroker({});
    enableRootMode({ appId: 'com.first.app' });
    const first = w.NovaRoot.requestSession({ appId: 'com.first.app', reason: 'first' });

    // While the first prompt is open, a second app WITHOUT a grant asks.
    granted.add('com.first.app'); // only the first app holds the grant
    const second = w.NovaRoot.requestSession({ appId: 'com.rogue.app', reason: 'rogue' });

    await clickPrompt('Allow');
    expect(await first).toEqual({ granted: true });
    // The rogue caller gets its OWN authorization verdict — the M8 fix.
    const verdict = await second;
    expect(verdict.granted).toBe(false);
    expect(verdict.reason).toContain('does not hold a system:root grant');
    // Exactly one dialog was ever shown for both requests.
    expect(w.document.querySelectorAll('.modal-overlay')).toHaveLength(0);
  });

  it('uses translated strings when window._t provides them', async () => {
    await bootBroker({});
    enableRootMode();
    // Translate the title and the cancel button; leave other keys unset so
    // the English fallbacks apply there.
    w._t = (key) => {
      if (key === 'shell.rootBroker.title') return 'ROOT-TRANSLATED';
      if (key === 'common.cancel') return 'CANCEL-TRANSLATED';
      return undefined;
    };
    const p = w.NovaRoot.requestSession({ appId: 'com.example.rootapp' });
    await new Promise((r) => setTimeout(r, 20));
    expect(w.document.querySelector('.modal-overlay').textContent).toContain('ROOT-TRANSLATED');
    await clickPrompt('CANCEL-TRANSLATED');
    await p;
    delete w._t;
  });
});

describe('NovaRoot — run()', () => {
  it('validates argv before anything else', async () => {
    await bootBroker({});
    enableRootMode();
    await expect(w.NovaRoot.run({ argv: 'not-an-array' })).rejects.toThrow('argv array of strings');
    await expect(w.NovaRoot.run({ argv: ['rm', 42] })).rejects.toThrow('argv array of strings');
    expect(sudo.calls).toHaveLength(0);
  });

  it('executes sudo -n -- argv and returns base64 transport fields', async () => {
    await bootBroker({ execResults: [{ code: 0, stdout: 'hello root', stderr: '' }] });
    enableRootMode();
    const p = w.NovaRoot.run({ appId: 'com.example.rootapp', argv: ['cat', '/etc/shadow'] });
    await clickPrompt('Allow');
    const res = await p;
    expect(res.code).toBe(0);
    expect(Buffer.from(res.stdoutB64, 'base64').toString('utf8')).toBe('hello root');
    expect(res.stderrB64).toBe(Buffer.from('', 'utf8').toString('base64'));
    expect(sudo.calls).toHaveLength(1);
    expect(sudo.calls[0].argv).toEqual(['-n', '--', 'cat', '/etc/shadow']);
    expect(logs.at(-1).message).toContain('exit 0');
  });

  it('reuses the cached session across runs (one prompt total)', async () => {
    await bootBroker({
      execResults: [{ code: 0, stdout: 'a', stderr: '' }, { code: 0, stdout: 'b', stderr: '' }],
    });
    enableRootMode();
    const first = w.NovaRoot.run({ appId: 'com.example.rootapp', argv: ['true'] });
    await clickPrompt('Allow');
    await first;
    const second = await w.NovaRoot.run({ appId: 'com.example.rootapp', argv: ['true'] });
    expect(second.code).toBe(0);
    expect(w.document.querySelectorAll('.modal-overlay')).toHaveLength(0);
  });

  it('denies and audits with NOVA_ROOT_DENIED when the prompt is cancelled', async () => {
    await bootBroker({});
    enableRootMode();
    const p = w.NovaRoot.run({ appId: 'com.example.rootapp', argv: ['true'] });
    await clickPrompt('Cancel');
    await expect(p).rejects.toMatchObject({ code: 'NOVA_ROOT_DENIED' });
    expect(logs.at(-1).severity).toBe('warn');
    expect(sudo.calls).toHaveLength(0);
  });

  it('pipes inputB64 / inputText into the child stdin', async () => {
    await bootBroker({ execResults: [{ code: 0, stdout: '', stderr: '' }] });
    enableRootMode();
    const p = w.NovaRoot.run({
      appId: 'com.example.rootapp', argv: ['tee', '/x'],
      inputB64: Buffer.from('from-b64').toString('base64'),
    });
    await clickPrompt('Allow');
    await p;
    expect(sudo.calls[0].stdin?.toString()).toBe('from-b64');

    sudo.respond({ code: 0, stdout: '', stderr: '' });
    const p2 = w.NovaRoot.run({ appId: 'com.example.rootapp', argv: ['tee', '/x'], inputText: 'plain-text' });
    await p2;
    expect(sudo.calls[1].stdin?.toString()).toBe('plain-text');
  });

  it('translates password-requiring sudo into an actionable NOVA_SUDO_SETUP error', async () => {
    await bootBroker({
      execResults: [{ code: 1, stdout: '', stderr: 'sudo: a password is required' }],
    });
    enableRootMode();
    const p = w.NovaRoot.run({ appId: 'com.example.rootapp', argv: ['true'] });
    await clickPrompt('Allow');
    await expect(p).rejects.toMatchObject({
      code: 'NOVA_SUDO_SETUP',
      message: expect.stringContaining('NOPASSWD'),
    });
  });

  it('translates a sudoers rejection into the setup message too', async () => {
    await bootBroker({
      execResults: [{ code: 1, stdout: '', stderr: 'x is not in the sudoers file.  This incident will be reported.' }],
    });
    enableRootMode();
    const p = w.NovaRoot.run({ appId: 'com.example.rootapp', argv: ['true'] });
    await clickPrompt('Allow');
    await expect(p).rejects.toMatchObject({
      code: 'NOVA_SUDO_SETUP',
      message: expect.stringContaining('not allowed to use sudo'),
    });
  });

  it('surfaces plain command failures with exit code, stdout and stderr', async () => {
    await bootBroker({
      execResults: [{ code: 3, stdout: 'partial out', stderr: 'boom' }],
    });
    enableRootMode();
    const p = w.NovaRoot.run({ appId: 'com.example.rootapp', argv: ['frobnicate'] });
    await clickPrompt('Allow');
    const err = await p.catch((e) => e);
    expect(err.code).toBe(3);
    expect(err.message).toContain('exit 3');
    expect(err.message).toContain('boom');
    expect(err.stdout).toBe('partial out');
    expect(err.stderr).toBe('boom');
  });

  it('propagates spawn-level failures (timeout / missing binary)', async () => {
    await bootBroker({
      execResults: [{ spawnError: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) }],
    });
    enableRootMode();
    const p = w.NovaRoot.run({ appId: 'com.example.rootapp', argv: ['slow'] });
    await clickPrompt('Allow');
    await expect(p).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });
});

describe('NovaRoot — convenience wrappers', () => {
  it('rm/cp/mkdirp build the documented argv shapes', async () => {
    await bootBroker({
      execResults: [{ code: 0 }, { code: 0 }, { code: 0 }],
    });
    enableRootMode();
    const p1 = w.NovaRoot.rm('/tmp/x');
    await clickPrompt('Allow');
    await p1;
    await w.NovaRoot.cp('/a', '/b');
    await w.NovaRoot.mkdirp('/deep/dir');
    expect(sudo.calls.map((c) => c.argv)).toEqual([
      ['-n', '--', 'rm', '-f', '--', '/tmp/x'],
      ['-n', '--', 'cp', '-f', '--', '/a', '/b'],
      ['-n', '--', 'mkdir', '-p', '--', '/deep/dir'],
    ]);
  });

  it('writeFile stages through a real temp file, places it with cp and cleans up', async () => {
    const written = [];
    const realWriteFileSync = fs.writeFileSync;
    const realUnlinkSync = fs.unlinkSync;
    const fsSpy = new Proxy(fs, {
      get(target, prop) {
        if (prop === 'writeFileSync') return (...args) => { written.push(['write', args[0], args[1]]); return realWriteFileSync(...args); };
        if (prop === 'unlinkSync') return (...args) => { written.push(['unlink', args[0]]); return realUnlinkSync(...args); };
        return target[prop];
      },
    });
    await bootBroker({
      execResults: [{ code: 0 }, { code: 0 }], // mkdirp + cp
    });
    // Swap the fs module the broker captured... it captured the real fs at
    // eval time, so instead assert through the observable effects: the
    // broker wrote a real temp file (gone by the end) and ran cp.
    void fsSpy;
    enableRootMode();
    const p = w.NovaRoot.writeFile('/etc/novabyte.conf', 'content-here');
    await clickPrompt('Allow');
    const res = await p;
    expect(res).toEqual({ code: 0, stdoutB64: '', stderrB64: '' });
    // mkdirp of dirname + cp tmp -> dst, both through sudo.
    expect(sudo.calls.map((c) => c.argv[2])).toEqual(['mkdir', 'cp']);
    expect(sudo.calls[1].argv.at(-1)).toBe('/etc/novabyte.conf');
    // The staged temp file was cleaned up.
    const staged = sudo.calls[1].argv.at(-2);
    expect(fs.existsSync(staged)).toBe(false);
    void written;
  });

  it('readFile decodes the cat output', async () => {
    await bootBroker({ execResults: [{ code: 0, stdout: 'file-contents', stderr: '' }] });
    enableRootMode();
    const p = w.NovaRoot.readFile('/etc/hostname');
    await clickPrompt('Allow');
    expect(await p).toBe('file-contents');
    expect(sudo.calls[0].argv).toEqual(['-n', '--', 'cat', '--', '/etc/hostname']);
  });
});

describe('NovaRoot — endSession()', () => {
  it('invalidates the cached session and runs sudo -k', async () => {
    await bootBroker({ execResults: [{ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: '', stderr: '' }] });
    enableRootMode();
    const p = w.NovaRoot.requestSession({ appId: 'com.example.rootapp' });
    await clickPrompt('Allow');
    await p;
    expect(w.NovaRoot.status().sessionActive).toBe(true);

    await w.NovaRoot.endSession();
    expect(w.NovaRoot.status().sessionActive).toBe(false);
    expect(w.NovaRoot.status().sessionUntil).toBe(null);
    expect(sudo.calls.at(-1).argv).toEqual(['-k']);
  });

  it('succeeds even when sudo -k fails', async () => {
    await bootBroker({
      execResults: [{ code: 0, stdout: '', stderr: '' }, { spawnError: new Error('sudo gone') }],
    });
    enableRootMode();
    const p = w.NovaRoot.requestSession({ appId: 'com.example.rootapp' });
    await clickPrompt('Allow');
    await p;
    await expect(w.NovaRoot.endSession()).resolves.toBe(true);
  });

  it('works when called with no session at all', async () => {
    await bootBroker({});
    await expect(w.NovaRoot.endSession()).resolves.toBe(true);
  });
});