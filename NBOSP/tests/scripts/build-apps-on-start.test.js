import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const NBOSP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(NBOSP_ROOT, 'scripts', 'build-apps-on-start.js');

describe('scripts/build-apps-on-start.js', () => {
  it('skips the NovaApp build entirely when NBOSP_SKIP_APP_BUILD=1', () => {
    const out = execFileSync(process.execPath, [SCRIPT], {
      cwd: NBOSP_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, NBOSP_SKIP_APP_BUILD: '1' },
    });
    expect(out).toContain('[app-build] Skipping NovaApp build (NBOSP_SKIP_APP_BUILD=1).');
  });

  it('points the spawned builder at build-apps.mjs next to the NBOSP root', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).toContain("'..', 'build-apps.mjs'");
    expect(fs.existsSync(path.join(NBOSP_ROOT, 'build-apps.mjs'))).toBe(true);
  });
});

describe('scripts/build-apps-on-start.js — outcome branches (in-process)', () => {
  // The script's whole body runs at require time and ends in process.exit,
  // so each outcome is driven by patching spawnSync + process.exit around a
  // fresh require — the same module the NW.js main thread executes on boot.
  const cp = require('node:child_process');
  const realSpawnSync = cp.spawnSync;
  const realExit = process.exit;

  function runScript({ env = {}, spawnResult = null } = {}) {
    const envSnapshot = { ...process.env };
    const resolved = require.resolve(SCRIPT);
    const exits = [];
    let spawnCalls = 0;
    cp.spawnSync = () => { spawnCalls += 1; return spawnResult; };
    process.exit = ((code) => { exits.push(code); throw new Error(`__script_exit:${code}`); });
    try {
      for (const [k, v] of Object.entries(env)) process.env[k] = v;
      delete require.cache[resolved];
      let completionError = null;
      try {
        require(resolved);
      } catch (e) {
        completionError = e;
      }
      return { exits, spawnCalls, completionError };
    } finally {
      cp.spawnSync = realSpawnSync;
      process.exit = realExit;
      for (const key of Object.keys(process.env)) {
        if (!(key in envSnapshot)) delete process.env[key];
        else process.env[key] = envSnapshot[key];
      }
      delete require.cache[resolved];
    }
  }

  it('exits 0 immediately when NBOSP_SKIP_APP_BUILD=1 (builder never spawns)', () => {
    const r = runScript({ env: { NBOSP_SKIP_APP_BUILD: '1' } });
    expect(r.exits).toEqual([0]);
    expect(r.spawnCalls).toBe(0);
    expect(r.completionError?.message).toBe('__script_exit:0');
  });

  it('exits 1 when the builder process cannot even be spawned', () => {
    const r = runScript({ spawnResult: { error: new Error('spawn ENOENT') } });
    expect(r.exits).toEqual([1]);
    expect(r.spawnCalls).toBe(1);
  });

  it('exits 1 when the builder is killed by a signal', () => {
    const r = runScript({ spawnResult: { signal: 'SIGKILL' } });
    expect(r.exits).toEqual([1]);
  });

  it('propagates the builder exit status, and defaults a missing status to 1', () => {
    const seven = runScript({ spawnResult: { status: 7 } });
    expect(seven.exits).toEqual([7]);

    const missing = runScript({ spawnResult: {} });
    expect(missing.exits).toEqual([1]);
  });

  it('a clean builder run completes without exiting', () => {
    const r = runScript({ spawnResult: { status: 0 } });
    expect(r.exits).toEqual([]);
    expect(r.completionError).toBeNull();
  });
});
