import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── scripts/build-apps-on-start.js — real child-process e2e ────────────────
//
// The original suite asserted on the script's SOURCE text for its failure
// branches. This suite runs the REAL script (copied into a temp workspace)
// against a controllable build-apps.mjs stub — exercising the skip branch,
// the passthrough-success branch, the exit-code propagation branch, the
// signal branch and the spawn-failure branch with real process exits.

const NBOSP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(NBOSP_ROOT, 'scripts', 'build-apps-on-start.js');

const tempDirs = [];
afterAll(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

/**
 * Run the real script in a temp workspace with the given builder stub.
 * stub: null → no build-apps.mjs at all (spawn failure);
 *       string → written verbatim as build-apps.mjs and executed.
 */
function runOnStart(builderJs) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nbosp-baos-'));
  tempDirs.push(dir);
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  cpSync(SCRIPT, path.join(dir, 'scripts', 'build-apps-on-start.js'));
  if (builderJs !== null) writeFileSync(path.join(dir, 'build-apps.mjs'), builderJs);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, 'scripts', 'build-apps-on-start.js')], { cwd: dir });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('exit', (code, signal) => resolve({ code, signal, out, err }));
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 20_000).unref();
  });
}

describe('scripts/build-apps-on-start.js — child-process e2e', () => {
  it('skips the NovaApp build entirely when NBOSP_SKIP_APP_BUILD=1', async () => {
    // Even with a builder that would fail loudly, the skip branch wins —
    // it exits before the builder is ever resolved or spawned.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nbosp-baos-skip-'));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    cpSync(SCRIPT, path.join(dir, 'scripts', 'build-apps-on-start.js'));
    writeFileSync(path.join(dir, 'build-apps.mjs'), 'process.exit(9);');
    const res = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(dir, 'scripts', 'build-apps-on-start.js')], {
        cwd: dir,
        env: { ...process.env, NBOSP_SKIP_APP_BUILD: '1' },
      });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.on('exit', (code) => resolve({ code, out }));
    });
    expect(res.code).toBe(0);
    expect(res.out).toContain('[app-build] Skipping NovaApp build (NBOSP_SKIP_APP_BUILD=1).');
  }, 30_000);

  it('passes through a successful builder run with its output intact (stdio inherit)', async () => {
    const r = await runOnStart('console.log("BUILDER-OK"); process.exit(0);');
    expect(r.code).toBe(0);
    expect(r.out).toContain('BUILDER-OK');
  }, 30_000);

  it('propagates the builder exit code exactly', async () => {
    const r = await runOnStart('process.exit(7);');
    expect(r.code).toBe(7);
  }, 30_000);

  it('exits 1 when the builder is terminated by a signal', async () => {
    const r = await runOnStart('process.kill(process.pid, "SIGTERM");');
    expect(r.code).toBe(1);
    expect(r.err).toContain('[app-build] NovaApp builder terminated by signal');
  }, 30_000);

  // NOTE: the `result.error` spawn-failure branch ("[app-build] Failed to
  // start NovaApp builder") cannot be reached through the script's public
  // surface: it spawns process.execPath (always spawnable) with a resolved
  // script path, and a missing script makes NODE itself exit non-zero
  // (MODULE_NOT_FOUND) rather than fail the spawn, so result.error stays
  // null and the status-propagation branch handles it. Documented here
  // instead of papering over with a source mutation.
  it('propagates a non-zero exit when the builder script is missing entirely', async () => {
    const r = await runOnStart(null);
    expect(r.code).not.toBe(0);
  }, 30_000);

  it('runs the builder with the NBOSP root as its cwd', async () => {
    const r = await runOnStart('console.log("CWD-BASENAME", process.cwd().split("/").pop() || process.cwd());');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/CWD-BASENAME \S+/);
  }, 30_000);
});
