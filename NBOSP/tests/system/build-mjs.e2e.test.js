import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── build.mjs — the desktop bundle pipeline, e2e against a temp tree ────────
//
// build.mjs is an ESM script that runs main() at import: validate platform +
// build type, rebuild all .novaapp packages (REAL build-apps.mjs), stage a
// clean copy (copyClean with its exclusion rules), generate the bundled-app
// manifest, patch/harden the staged package.json, npm ci --omit=dev in the
// staged copy, then import nw-builder (resolved through node_modules'
// package.json "main") and bundle NW.js (~150MB download — the ONLY stubbed
// step, replaced by a stub installed at the exact path the real resolver
// reads).
//
// The temp tree contains two fixture apps: a system one (bundled into
// novaapp-manifest.json) and a regular one (excluded from it).

const NBOSP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const tempDirs = [];
afterAll(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

/** npm's cli entry — used to generate the lockfile offline (file: deps). */
const requireFromHere = createRequire(import.meta.url);
function require_npm_execpath() {
  return process.env.npm_execpath || requireFromHere.resolve('npm/bin/npm-cli.js', { paths: [NBOSP_ROOT] });
}

function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nbosp-buildmjs-'));
  tempDirs.push(dir);
  return dir;
}

// The staged package.json mirrors the shape build.mjs patches: window.icon,
// window.icons, dev_tools and the dev chromium-args that release hardening
// must strip.
const PKG_WITH_DEV_FLAGS = {
  name: 'novabyte-server',
  version: '3.0.2',
  // Offline dependency: a locally packed tarball (see runBuild) outside the
  // nbosp tree, so the staged `npm ci --omit=dev` installs a REAL
  // node_modules/dompurify/dist/purify.min.js without touching the network.
  dependencies: { dompurify: 'file:../vtar/dompurify-3.4.18.tgz' },
  window: {
    title: 'NovaByte',
    icon: 'assets/icon.png',
    icons: { '128': 'assets/icon.png' },
    dev_tools: true,
    'chromium-args': '--no-first-run --remote-debugging-port=9222 --auto-open-devtools-for-tabs --disable-web-security --allow-file-access-from-files --js-flags="--expose-gc" --password-store=basic',
  },
};

function writeApp(appsDir, id, { system = false, systemService = false } = {}) {
  const dir = path.join(appsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id, name: id, version: '1.0.0', entry: 'index.html', system, systemService,
  }, null, 2));
  writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><head><title>${id}</title></head><body>${id}</body></html>`);
}

/** Assemble the temp NBOSP tree and run build.mjs in it. */
async function runBuild({ platform = 'linux', buildType, keepDevFlags, nwFlavor } = {}) {
  const root = tmp();                       // <tmp>/            (projectRoot)
  const nbosp = path.join(root, 'nbosp');   // <tmp>/nbosp       (script __dirname)
  mkdirSync(nbosp, { recursive: true });

  cpSync(path.join(NBOSP_ROOT, 'build.mjs'), path.join(nbosp, 'build.mjs'));
  cpSync(path.join(NBOSP_ROOT, 'build-apps.mjs'), path.join(nbosp, 'build-apps.mjs'));
  mkdirSync(path.join(nbosp, 'keys'), { recursive: true });
  cpSync(path.join(NBOSP_ROOT, 'keys', 'test-system-key.json'), path.join(nbosp, 'keys', 'test-system-key.json'));

  const appsDir = path.join(nbosp, 'js', 'apps');
  writeApp(appsDir, 'com.example.regular');
  writeApp(appsDir, 'com.example.systemapp', { system: true, systemService: true });

  // A test-suite folder, to pin the staging exclusion behavior around it
  // (see the exclusion assertion below for the documented source finding).
  mkdirSync(path.join(nbosp, 'tests', 'syntax', 'fixtures'), { recursive: true });
  writeFileSync(path.join(nbosp, 'tests', 'marker.test.js'), 'it("ships?", () => {});\n');
  writeFileSync(path.join(nbosp, 'tests', 'syntax', 'fixtures', 'broken.json'), '{');

  mkdirSync(path.join(nbosp, 'assets'), { recursive: true });
  for (const icon of ['icon.png', 'icon.ico', 'icon.icns']) {
    writeFileSync(path.join(nbosp, 'assets', icon), 'fake-icon-bytes');
  }

  const pkg = JSON.parse(JSON.stringify(PKG_WITH_DEV_FLAGS));
  writeFileSync(path.join(nbosp, 'package.json'), JSON.stringify(pkg, null, 2));

  // Pack a local dompurify tarball OUTSIDE the nbosp tree (copyClean's
  // blanket "dist" exclusion would strip a vendored dist/ folder during
  // staging; a tarball sidesteps that AND mirrors a real registry install).
  const packDir = path.join(root, 'vtar', 'dompurify-pkg');
  mkdirSync(path.join(packDir, 'dist'), { recursive: true });
  writeFileSync(path.join(packDir, 'package.json'), JSON.stringify({ name: 'dompurify', version: '3.4.18', main: 'dist/purify.min.js' }));
  writeFileSync(path.join(packDir, 'dist', 'purify.min.js'), 'stub purify');
  execFileSync(process.execPath, [
    require_npm_execpath(), 'pack', '--pack-destination', path.join(root, 'vtar'),
  ], { cwd: packDir, stdio: 'ignore' });

  // Generate the lockfile the way npm itself would (offline for file: deps),
  // so the staged `npm ci --omit=dev` is in sync and network-free.
  execFileSync(process.execPath, [
    require_npm_execpath(), 'install', '--package-lock-only', '--no-audit', '--no-fund', '--loglevel=error',
  ], { cwd: nbosp, stdio: 'ignore' });

  // nw-builder stub installed at the exact path build.mjs resolves through
  // package.json "main" — the resolution itself is real code under test.
  const nwBuilderDir = path.join(nbosp, 'node_modules', 'nw-builder');
  mkdirSync(nwBuilderDir, { recursive: true });
  writeFileSync(path.join(nwBuilderDir, 'package.json'), JSON.stringify({ name: 'nw-builder', version: '0.0.0-stub', main: 'stub.mjs', type: 'module' }));
  writeFileSync(path.join(nwBuilderDir, 'stub.mjs'), `
    import fs from 'node:fs';
    import path from 'node:path';
    export default async function nwbuild(options) {
      fs.writeFileSync(process.env.NBOSP_STUB_RECORD, JSON.stringify(options));
      // Emulate the one post-build artifact build.mjs checks on linux.
      if (options.platform === 'linux') {
        const lib = path.join(options.outDir, 'lib');
        fs.mkdirSync(lib, { recursive: true });
        fs.writeFileSync(path.join(lib, 'libffmpeg.so'), 'stub-ffmpeg');
      }
    }
  `);
  // nw runtime package: only its version string is read.
  const nwDir = path.join(nbosp, 'node_modules', 'nw');
  mkdirSync(nwDir, { recursive: true });
  writeFileSync(path.join(nwDir, 'package.json'), JSON.stringify({ name: 'nw', version: '0.120.0-sdk' }));

  const recordPath = path.join(root, 'stub-record.json');
  const env = {
    ...process.env,
    NBOSP_STUB_RECORD: recordPath,
    NBOSP_BUILD_PLATFORM: platform,
    ...(buildType ? { NBOSP_BUILD_TYPE: buildType } : {}),
    ...(keepDevFlags ? { NBOSP_KEEP_DEV_FLAGS: '1' } : {}),
    ...(nwFlavor ? { NBOSP_NW_FLAVOR: nwFlavor } : {}),
  };

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['build.mjs'], { cwd: nbosp, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('exit', (code, signal) => resolve({ code, signal, out, err }));
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 120_000).unref();
  });

  const stageDir = path.join(root, '.build-stage');
  const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : null;
  return { root, nbosp, stageDir, result, record, out: result.out };
}

describe('build.mjs — argument and environment validation', () => {
  it('rejects an unknown platform argument with exit 1', async () => {
    const { result } = await runBuild({ platform: 'solaris' });
    expect(result.code).toBe(1);
    expect(result.err).toContain('Unknown platform "solaris"');
    expect(result.err).toContain('win, linux, osx');
  }, 150_000);

  it('rejects an unknown NBOSP_BUILD_TYPE with exit 1', async () => {
    const { result } = await runBuild({ buildType: 'nightly' });
    expect(result.code).toBe(1);
    expect(result.err).toContain('Unknown NBOSP_BUILD_TYPE "nightly"');
    expect(result.err).toContain('"release" or "development"');
  }, 150_000);
});

describe('build.mjs — full pipeline (nw-builder stubbed at the resolved path)', () => {
  it('stages, hardens, records and completes a linux release build', async () => {
    const { result, stageDir, record, out, root } = await runBuild({ platform: 'linux' });

    expect(result.code).toBe(0);
    expect(out).toContain('Build type: release');

    // ── step 1a: real .novaapp packages were built from source ──
    expect(existsSync(path.join(stageDir, 'js', 'apps', 'com.example.regular.novaapp'))).toBe(true);
    expect(existsSync(path.join(stageDir, 'js', 'apps', 'com.example.systemapp.novaapp'))).toBe(true);

    // ── step 2: staged manifest lists ONLY system packages ──
    const bundleManifest = JSON.parse(readFileSync(path.join(stageDir, 'js', 'apps', 'novaapp-manifest.json'), 'utf8'));
    expect(bundleManifest).toEqual([
      { id: 'com.example.systemapp', file: 'js/apps/com.example.systemapp.novaapp', systemService: true },
    ]);

    // ── step 2: staging exclusions — secrets and tooling never ship ──
    expect(existsSync(path.join(stageDir, 'keys', 'test-system-key.json'))).toBe(false);
    expect(existsSync(path.join(stageDir, 'build.mjs'))).toBe(false);
    expect(existsSync(path.join(stageDir, 'vitest.config.js'))).toBe(false);
    // js/purify.min.js was excluded from the STAGED copy, then deliberately
    // RECREATED from the staged production dependency after npm ci (asserted
    // below) — by this point in the finished build it exists again.
    // DOCUMENTED SOURCE FINDING: the exclusion list contains "test" but the
    // suite folder is named "tests/", so the ENTIRE test tree (fixtures and
    // deliberately-broken files included) is staged into release bundles.
    // Asserting the current behavior so a future fix flips this assertion
    // deliberately instead of silently.
    expect(existsSync(path.join(stageDir, 'tests', 'marker.test.js'))).toBe(true);
    expect(existsSync(path.join(stageDir, 'tests', 'syntax', 'fixtures', 'broken.json'))).toBe(true);

    // ── step 2b/3: release hardening stripped the dev flags ──
    const stagedPkg = JSON.parse(readFileSync(path.join(stageDir, 'package.json'), 'utf8'));
    expect(stagedPkg.window.dev_tools).toBe(false);
    expect(stagedPkg.window['chromium-args']).not.toContain('--remote-debugging-port=9222');
    expect(stagedPkg.window['chromium-args']).not.toContain('--auto-open-devtools-for-tabs');
    expect(stagedPkg.window['chromium-args']).not.toContain('--disable-web-security');
    expect(stagedPkg.window['chromium-args']).not.toContain('--allow-file-access-from-files');
    expect(stagedPkg.window['chromium-args']).toContain('--password-store=basic');
    expect(out).toContain('Stripped dev-only chromium-args');

    // ── step 3: npm ci ran in the staged copy (its node_modules exists) ──
    expect(existsSync(path.join(stageDir, 'node_modules'))).toBe(true);
    // ── step 3b: the purify vendor file was recreated from the staged dep ──
    expect(readFileSync(path.join(stageDir, 'js', 'purify.min.js'), 'utf8')).toBe('stub purify');

    // ── step 4/5: nw-builder was driven with the expected options ──
    expect(record).toMatchObject({
      mode: 'build',
      version: '0.120.0',       // -sdk suffix stripped
      flavor: 'normal',         // release build
      platform: 'linux',
      arch: 'x64',
      glob: false,
      ffmpeg: true,
      srcDir: stageDir,
    });
    expect(record.outDir).toBe(path.join(root, 'build', 'linux-x64'));
    expect(record.app.name).toBe('NovaByte');

    expect(out).toContain('Built for linux-x64 -> build/linux-x64');
    // The linux libffmpeg.so post-build check passed against the stub's file.
    expect(existsSync(path.join(root, 'build', 'linux-x64', 'lib', 'libffmpeg.so'))).toBe(true);
  }, 180_000);

  it('keeps dev flags and selects the sdk flavor for development builds', async () => {
    const { result, stageDir, record } = await runBuild({ platform: 'linux', buildType: 'development' });
    expect(result.code).toBe(0);
    const stagedPkg = JSON.parse(readFileSync(path.join(stageDir, 'package.json'), 'utf8'));
    expect(stagedPkg.window.dev_tools).toBe(true);
    expect(stagedPkg.window['chromium-args']).toContain('--remote-debugging-port=9222');
    expect(record.flavor).toBe('sdk');
  }, 180_000);

  it('honours NBOSP_KEEP_DEV_FLAGS=1 even on release builds', async () => {
    const { result, stageDir, record } = await runBuild({ platform: 'linux', keepDevFlags: true });
    expect(result.code).toBe(0);
    const stagedPkg = JSON.parse(readFileSync(path.join(stageDir, 'package.json'), 'utf8'));
    expect(stagedPkg.window['chromium-args']).toContain('--remote-debugging-port=9222');
    expect(record.flavor).toBe('normal');
  }, 180_000);

  it('honours a valid NBOSP_NW_FLAVOR override and warns on an invalid one', async () => {
    const forced = await runBuild({ platform: 'linux', nwFlavor: 'sdk' });
    expect(forced.result.code).toBe(0);
    expect(forced.record.flavor).toBe('sdk');

    const bogus = await runBuild({ platform: 'linux', nwFlavor: 'deluxe' });
    expect(bogus.result.code).toBe(0);
    // The ignore-notice is a console.warn → stderr.
    expect(bogus.result.err).toContain('NBOSP_NW_FLAVOR="deluxe" ignored');
    expect(bogus.record.flavor).toBe('normal'); // release default
  }, 300_000);

  it('patches the staged window icon to .ico for win builds', async () => {
    const { result, stageDir, record } = await runBuild({ platform: 'win' });
    expect(result.code).toBe(0);
    const stagedPkg = JSON.parse(readFileSync(path.join(stageDir, 'package.json'), 'utf8'));
    expect(stagedPkg.window.icon).toBe('assets/icon.ico');
    expect(Object.values(stagedPkg.window.icons)).toEqual(['assets/icon.ico']);
    expect(record.platform).toBe('win');
    expect(record.ffmpeg).toBe(false);
    expect(record.app.icon).toBe(path.join(stageDir, 'assets', 'icon.ico'));
  }, 180_000);

  it('completes an osx arm64 build (no ffmpeg check on that platform)', async () => {
    const { result, record } = await runBuild({ platform: 'osx' });
    expect(result.code).toBe(0);
    expect(result.out).toContain('Built for osx-arm64 -> build/osx-arm64');
    expect(record.platform).toBe('osx');
    expect(record.arch).toBe('arm64');
    expect(record.ffmpeg).toBe(false);
  }, 180_000);
});
