import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── client.js — the NW.js main entry, e2e via real child processes ──────────
//
// client.js requires ./scripts/startup and runs bootstrap() inside a guarded
// async IIFE, with process-level uncaughtException / unhandledRejection
// handlers that log with the [NovaByte] prefix and exit 1. Instead of loading
// NW.js, each test copies the REAL client.js into a temp directory together
// with a controllable stub scripts/startup.js — the stub is the only stand-in
// (it represents the NW-dependent bootstrap, which cannot run under Node) —
// and drives every one of client.js's own code paths through a real process.

const NBOSP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLIENT_SRC = path.join(NBOSP_ROOT, 'client.js');

const tempDirs = [];
afterAll(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

/** Spawn node on a copy of client.js with the given stub startup module. */
function runClient(stubStartupJs) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nbosp-client-'));
  tempDirs.push(dir);
  cpSync(CLIENT_SRC, path.join(dir, 'client.js'));
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  writeFileSync(path.join(dir, 'scripts', 'startup.js'), stubStartupJs);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['client.js'], { cwd: dir });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('exit', (code, signal) => resolve({ code, signal, out, err }));
    // Safety net: never hang the suite on a stuck child.
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 20_000).unref();
  });
}

describe('client.js — startup entry point', () => {
  it('runs bootstrap to completion and exits 0', async () => {
    const r = await runClient(`
      const path = require('path');
      module.exports = { bootstrap: async (root) => {
        console.log('BOOT-CALLED', path.basename(root));
      } };
    `);
    expect(r.code).toBe(0);
    expect(r.out).toContain('BOOT-CALLED');
  }, 30_000);

  it('reports a fatal startup error and exits 1 when bootstrap throws', async () => {
    const r = await runClient(`
      module.exports = { bootstrap: async () => { throw new Error('window gone'); } };
    `);
    expect(r.code).toBe(1);
    expect(r.err).toContain('[NovaByte] Fatal startup error:');
    expect(r.err).toContain('window gone');
    // The full stack is preserved, not just the message.
    expect(r.err).toContain('at ');
  }, 30_000);

  it('preserves non-Error rejections via String() in the fatal path', async () => {
    const r = await runClient(`
      module.exports = { bootstrap: async () => { throw 'just a string'; } };
    `);
    expect(r.code).toBe(1);
    expect(r.err).toContain('[NovaByte] Fatal startup error: just a string');
  }, 30_000);

  it('captures uncaught exceptions thrown after startup and exits 1', async () => {
    const r = await runClient(`
      module.exports = { bootstrap: async () => {
        setTimeout(() => { throw new Error('late boom'); }, 20);
      } };
    `);
    expect(r.code).toBe(1);
    expect(r.err).toContain('[NovaByte] Uncaught exception during startup:');
    expect(r.err).toContain('late boom');
  }, 30_000);

  it('captures unhandled promise rejections and exits 1', async () => {
    const r = await runClient(`
      module.exports = { bootstrap: async () => {
        setTimeout(() => { Promise.reject(new Error('orphaned rejection')); }, 20);
      } };
    `);
    expect(r.code).toBe(1);
    expect(r.err).toContain('[NovaByte] Unhandled rejection during startup:');
    expect(r.err).toContain('orphaned rejection');
  }, 30_000);

  it('stringifies non-Error uncaught values', async () => {
    const r = await runClient(`
      module.exports = { bootstrap: async () => {
        setTimeout(() => { throw { weird: true }; }, 20);
      } };
    `);
    expect(r.code).toBe(1);
    expect(r.err).toContain('[NovaByte] Uncaught exception during startup:');
  }, 30_000);
});
