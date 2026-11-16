import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── scripts/bootstrap.js — dependency gate + vendor sync, e2e ───────────────
//
// bootstrap.js decides between "deps up to date" and running npm ci/install,
// then syncs the DOMPurify vendor file. The existing bootstrap.test.js covers
// the real-repo happy path; this suite drives EVERY branch by running the
// REAL script inside temp workspaces:
//   - shouldInstall: missing node_modules / stale .package-lock mtime /
//     fallback-with-missing-dep / fallback-all-present
//   - runInstall: npm ci vs npm install selection, npm_execpath handling,
//     failure exit codes, spawn failure
//   - readPkg failure on invalid package.json
//   - syncVendor: copy + mtime sync, no-op when mtimes match, failure exit
// The real npm is replaced by a recording stub via the npm_execpath env var
// — the exact mechanism the script itself uses inside npm lifecycles.

const NBOSP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(NBOSP_ROOT, 'scripts', 'bootstrap.js');

const tempDirs = [];
afterAll(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

/** A fake npm that records its argv and exits with the configured code. */
function makeStubNpm(dir, exitCode = 0) {
  const npmDir = path.join(dir, 'stub-npm');
  mkdirSync(npmDir, { recursive: true });
  const record = path.join(npmDir, 'argv.json');
  const script = path.join(npmDir, 'npm.js');
  writeFileSync(script, `
    require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));
    console.log('STUB-NPM-RAN');
    process.exit(${exitCode});
  `);
  return { npmExec: script, record };
}

/**
 * Assemble a workspace shaped like NBOSP and run the real bootstrap script.
 * layout: { packageJson, packageLock, nmLock, nodeModules: {dirs, files},
 *           dompurify: bool, vendored: 'missing'|'same-mtime'|'stale' }
 */
function runBootstrap(layout, { npmExit = 0, npmStub = true, pathEnv } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nbosp-bootstrap-'));
  tempDirs.push(dir);
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  copyFileSync(SCRIPT, path.join(dir, 'scripts', 'bootstrap.js'));

  if (layout.packageJson !== null) {
    writeFileSync(path.join(dir, 'package.json'), layout.packageJson ?? '{}');
  }
  if (layout.packageLock) {
    writeFileSync(path.join(dir, 'package-lock.json'), layout.packageLock);
  }
  const nm = path.join(dir, 'node_modules');
  if (layout.nodeModules) {
    mkdirSync(nm, { recursive: true });
    for (const d of layout.nodeModules.dirs ?? []) mkdirSync(path.join(nm, d), { recursive: true });
    for (const [f, content] of Object.entries(layout.nodeModules.files ?? {})) {
      const target = path.join(nm, f);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
  if (layout.nmLock) {
    writeFileSync(path.join(nm, '.package-lock.json'), layout.nmLock);
  }
  // Deterministic lockfile freshness: whole-second timestamps (float mtimeMs
  // rounding makes sub-second comparisons flaky).
  if (layout.lockTimes === 'stale') {
    // Root lockfile NEWER than node_modules/.package-lock.json → reinstall.
    const t = new Date(Math.floor(Date.now() / 1000) * 1000);
    utimesSync(path.join(nm, '.package-lock.json'), t, new Date(t.getTime() - 10_000));
    utimesSync(path.join(dir, 'package-lock.json'), t, t);
  } else if (layout.lockTimes === 'fresh') {
    // Root lockfile OLDER than node_modules/.package-lock.json → up to date.
    const t = new Date(Math.floor(Date.now() / 1000) * 1000);
    utimesSync(path.join(dir, 'package-lock.json'), t, new Date(t.getTime() - 10_000));
    utimesSync(path.join(nm, '.package-lock.json'), t, t);
  }
  if (layout.dompurify) {
    const dist = path.join(nm, 'dompurify', 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, 'purify.min.js'), 'real purify bytes');
  }
  const dest = path.join(dir, 'js', 'purify.min.js');
  if (layout.vendored === 'same-mtime') {
    mkdirSync(path.join(dir, 'js'), { recursive: true });
    writeFileSync(dest, 'real purify bytes');
    // Whole-second mtime on BOTH files → the script's mtime(src) ===
    // mtime(dest) comparison holds without float-precision flakiness.
    const t = new Date(Math.floor(Date.now() / 1000) * 1000);
    utimesSync(dest, t, t);
    utimesSync(path.join(nm, 'dompurify', 'dist', 'purify.min.js'), t, t);
  } else if (layout.vendored === 'stale') {
    mkdirSync(path.join(dir, 'js'), { recursive: true });
    writeFileSync(dest, 'stale vendored copy');
    const old = new Date(Date.now() - 60_000);
    utimesSync(dest, old, old);
  }

  const stub = makeStubNpm(dir, npmExit);
  const env = {
    ...process.env,
    ...(npmStub ? { npm_execpath: stub.npmExec } : {}),
    ...(pathEnv !== undefined ? { PATH: pathEnv } : {}),
  };
  // Clean inherited lifecycle vars that would point at a REAL npm.
  if (!npmStub) delete env.npm_execpath;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, 'scripts', 'bootstrap.js')], { cwd: dir, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('exit', (code, signal) => resolve({ code, signal, out, err, dir, stub }));
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 30_000).unref();
  });
}

const PKG = JSON.stringify({
  name: 't', version: '1.0.0',
  dependencies: { leftpad: '^1.0.0' },
  devDependencies: { vitest: '^5.0.0' },
}, null, 2);
const LOCK = JSON.stringify({ name: 't', version: '1.0.0', lockfileVersion: 3, packages: { '': {} } });

describe('scripts/bootstrap.js — shouldInstall decision tree', () => {
  it('installs when node_modules does not exist (npm ci when a lockfile exists)', async () => {
    const r = await runBootstrap({ packageJson: PKG, packageLock: LOCK });
    expect(r.code).toBe(0);
    expect(r.out).toContain('[bootstrap] Running npm ci...');
    expect(r.out).toContain('STUB-NPM-RAN');
    expect(JSON.parse(readFileSync(r.stub.record, 'utf8'))).toEqual(['ci', '--no-audit', '--no-fund', '--loglevel=error']);
  }, 40_000);

  it('falls back to npm install when there is no lockfile', async () => {
    const r = await runBootstrap({ packageJson: PKG });
    expect(r.code).toBe(0);
    expect(r.out).toContain('[bootstrap] Running npm install...');
    expect(JSON.parse(readFileSync(r.stub.record, 'utf8'))).toEqual(['install', '--no-audit', '--no-fund', '--loglevel=error']);
  }, 40_000);

  it('reports up to date when the lockfile is not newer than node_modules/.package-lock.json', async () => {
    const r = await runBootstrap({
      packageJson: PKG,
      packageLock: LOCK,
      nodeModules: { dirs: ['leftpad', 'vitest'] },
      nmLock: LOCK,
      lockTimes: 'fresh',
      dompurify: true,
      vendored: 'same-mtime',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('[bootstrap] Dependencies up to date.');
    expect(existsSync(r.stub.record)).toBe(false); // npm never ran
  }, 40_000);

  it('re-installs when package-lock.json is newer than node_modules/.package-lock.json', async () => {
    const r = await runBootstrap({
      packageJson: PKG,
      packageLock: LOCK,
      nodeModules: { dirs: ['leftpad', 'vitest'] },
      nmLock: LOCK,
      lockTimes: 'stale',
      dompurify: true,
      vendored: 'same-mtime',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('[bootstrap] Running npm ci...');
  }, 40_000);

  it('re-installs via the fallback path when a declared dependency folder is missing', async () => {
    const r = await runBootstrap({
      packageJson: PKG,
      // No package-lock → fallback path inspects dependency folders.
      nodeModules: { dirs: ['leftpad'] }, // vitest missing
      dompurify: true,
      vendored: 'same-mtime',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('[bootstrap] Running npm install...');
  }, 40_000);

  it('is up to date via the fallback path when every dependency folder exists', async () => {
    const r = await runBootstrap({
      packageJson: PKG,
      nodeModules: { dirs: ['leftpad', 'vitest'] },
      dompurify: true,
      vendored: 'same-mtime',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('[bootstrap] Dependencies up to date.');
  }, 40_000);
});

describe('scripts/bootstrap.js — npm invocation and failures', () => {
  it('exits with the npm failure code when npm fails', async () => {
    const r = await runBootstrap({ packageJson: PKG, packageLock: LOCK }, { npmExit: 3 });
    expect(r.code).toBe(3);
  }, 40_000);

  it('exits 1 with a spawn-failure message when npm cannot be launched', async () => {
    // No npm_execpath and an empty PATH → plain `npm` cannot be spawned.
    const r = await runBootstrap(
      { packageJson: PKG, packageLock: LOCK },
      { npmStub: false, pathEnv: '' },
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain('[bootstrap] npm spawn failed:');
  }, 40_000);

  // NOTE: the readPkg failure branch ("[bootstrap] Failed to read
  // package.json") is unreachable from a black-box process run: node itself
  // refuses to load ANY script whose nearest package.json is unreadable or
  // unparseable (it needs the file for module-type detection), so the child
  // dies in run_main before bootstrap.js's own readPkg could report the
  // error. Verified empirically. Documented rather than faked.
});

describe('scripts/bootstrap.js — DOMPurify vendor sync', () => {
  it('copies the vendor file and synchronises mtimes when it is stale', async () => {
    const r = await runBootstrap({
      packageJson: PKG,
      nodeModules: { dirs: ['leftpad', 'vitest'] },
      dompurify: true,
      vendored: 'stale',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('[bootstrap] Synced vendor: purify.min.js');
    const dest = path.join(r.dir, 'js', 'purify.min.js');
    expect(readFileSync(dest, 'utf8')).toBe('real purify bytes');
    // mtimes now match the source (within filesystem float rounding), so a
    // follow-up run would be a no-op.
    const src = path.join(r.dir, 'node_modules', 'dompurify', 'dist', 'purify.min.js');
    expect(Math.abs(statSync(dest).mtimeMs - statSync(src).mtimeMs)).toBeLessThan(2);
  }, 40_000);

  it('skips the copy entirely when mtimes already match', async () => {
    const r = await runBootstrap({
      packageJson: PKG,
      nodeModules: { dirs: ['leftpad', 'vitest'] },
      dompurify: true,
      vendored: 'same-mtime',
    });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('Synced vendor');
  }, 40_000);

  it('exits 1 when the DOMPurify source is missing from node_modules', async () => {
    // Up-to-date deps but no dompurify installed → copyFileSync throws.
    const r = await runBootstrap({
      packageJson: PKG,
      nodeModules: { dirs: ['leftpad', 'vitest'] },
      dompurify: false,
      vendored: 'stale',
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('[bootstrap] Failed to sync DOMPurify:');
  }, 40_000);

  it('syncs the vendor file even right after a fresh install', async () => {
    // Fresh-install path: stub npm "installs" (creates nothing), then the
    // vendor source exists → sync happens after install.
    const r = await runBootstrap({ packageJson: PKG, packageLock: LOCK, dompurify: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Running npm ci');
    expect(r.out).toContain('Synced vendor: purify.min.js');
  }, 40_000);
});
