import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const tempDirs = [];
const envSnapshot = { ...process.env };

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbosp-admin-'));
  tempDirs.push(dir);
  return dir;
}

describe('server/security/admin-state.js — read/write cycle', () => {
  let adminState;
  let dataDir;

  beforeAll(() => {
    dataDir = tmp();
    process.env.NBOSP_DATA_DIR = dataDir; // DATA_DIR is resolved at module load
    adminState = require('../../server/security/admin-state.js');
  });

  afterAll(() => {
    // leave the shared admin state file in its default position
    try { adminState.setAdminEnabled(false); } catch (_) {}
  });

  it('defaults to admin disabled when no state file exists yet', () => {
    expect(adminState.isAdminEnabled()).toBe(false);
  });

  it('persists enabled state atomically and reads it back', () => {
    const returned = adminState.setAdminEnabled(true);
    expect(returned).toEqual({ adminEnabled: true });
    expect(adminState.isAdminEnabled()).toBe(true);

    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'admin-state.json'), 'utf8'));
    expect(raw).toEqual({ adminEnabled: true });
  });

  it('coerces non-boolean values through Boolean()', () => {
    expect(adminState.writeState({ adminEnabled: 'yes' })).toEqual({ adminEnabled: true });
    expect(adminState.writeState({ adminEnabled: 0 })).toEqual({ adminEnabled: false });
    expect(adminState.writeState({ adminEnabled: undefined })).toEqual({ adminEnabled: false });
    expect(adminState.isAdminEnabled()).toBe(false);
  });

  it('caches reads in memory (no disk hit on every call)', () => {
    adminState.setAdminEnabled(false);
    const first = adminState.readState();
    // mutate the file behind the cache's back — readState must still serve cache
    fs.writeFileSync(path.join(dataDir, 'data', 'admin-state.json'), JSON.stringify({ adminEnabled: true }));
    expect(adminState.readState()).toBe(first);
    expect(adminState.readState().adminEnabled).toBe(false);
    // a write refreshes the cache
    adminState.setAdminEnabled(true);
    expect(adminState.readState().adminEnabled).toBe(true);
    adminState.setAdminEnabled(false);
  });

  it('leaves no temp files behind after atomic writes', () => {
    adminState.setAdminEnabled(true);
    adminState.setAdminEnabled(false);
    const leftovers = fs.readdirSync(path.join(dataDir, 'data')).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('falls back to the default state when the file is corrupt (fresh module instance)', async () => {
    const dir2 = tmp();
    fs.mkdirSync(path.join(dir2, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir2, 'data', 'admin-state.json'), '{ not json !!');
    process.env.NBOSP_DATA_DIR = dir2;
    // eval-free fresh instance via a subprocess — the module caches state in
    // memory at first read, so the corrupt-file path needs a clean process
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath, ['-e', `
      const m = require(${JSON.stringify(path.join(process.cwd(), 'server/security/admin-state.js'))});
      console.log(JSON.stringify(m.readState()));
    `], { cwd: process.cwd(), env: { ...process.env, NBOSP_DATA_DIR: dir2 }, encoding: 'utf8' });
    expect(JSON.parse(out.trim())).toEqual({ adminEnabled: false });
  });

  it('reads a boolean adminEnabled from disk and coerces non-booleans (fresh in-worker instances)', () => {
    const modulePath = require.resolve('../../server/security/admin-state.js');
    const dataDirFor = (content) => {
      const dir = tmp();
      fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'data', 'admin-state.json'), content);
      return dir;
    };

    const freshWith = (dir) => {
      process.env.NBOSP_DATA_DIR = dir;
      delete require.cache[modulePath];
      return require(modulePath);
    };

    try {
      // valid boolean on disk → cond-expr keeps the stored value
      const booleanState = freshWith(dataDirFor(JSON.stringify({ adminEnabled: true })));
      expect(booleanState.readState()).toEqual({ adminEnabled: true });

      // non-boolean payload → falls back to the default (false)
      const junkState = freshWith(dataDirFor(JSON.stringify({ adminEnabled: 'definitely' })));
      expect(junkState.readState()).toEqual({ adminEnabled: false });
    } finally {
      delete require.cache[modulePath]; // restore the shared instance next require
    }
  });

  it('logs and keeps the in-memory state when the atomic write fails', () => {
    const modulePath = require.resolve('../../server/security/admin-state.js');
    const dataDir2 = tmp();
    process.env.NBOSP_DATA_DIR = dataDir2;
    delete require.cache[modulePath];
    const fresh = require(modulePath);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('EACCES: read-only file system');
    });
    try {
      expect(() => fresh.writeState({ adminEnabled: true })).not.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(
        '[AdminState] Atomic state write failed:',
        'EACCES: read-only file system',
      );
      // the cache is still updated even though nothing hit the disk
      expect(fresh.readState()).toEqual({ adminEnabled: true });
    } finally {
      writeSpy.mockRestore();
      errorSpy.mockRestore();
      delete require.cache[modulePath];
    }
  });
});
