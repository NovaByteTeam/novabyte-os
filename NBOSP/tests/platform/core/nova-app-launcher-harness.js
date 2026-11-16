// Shared harness for the nova-app-launcher test suites.
//
// js/platform/core/nova-app-launcher.js is a window-attach script (no
// module.exports): an IIFE that reads window.__novaUnrestrictedPackage /
// window.svgIcon at load time and publishes window.buildNovaAppConfig. It
// also talks to bare globals the real OS page provides (document, AppDirs,
// AppSandbox, AppPermissionManager, AppPackage, FrameSecurity, createEl,
// fetch). This harness wires a REAL JSDOM window/document onto the Node
// global scope (the same pattern tests/apps/*.test.js use through
// tests/helpers/app-harness.js), re-requires the launcher fresh each time
// (vitest's vi.resetModules() does not bust the CJS require cache), and
// provides realistic fixtures derived from the real shipped apps
// (js/apps/terminal/manifest.json, js/apps/notifications/manifest.json) and
// the real installed-record shape written by js/apps/store/app.js.
//
// This file lives beside the suites that import it (tests/platform/core/)
// and is NOT collected by vitest (include: tests/**/*.test.js).

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);

export const LAUNCHER_PATH = require.resolve('../../../js/platform/core/nova-app-launcher.js');

// vi.resetModules() does not bust the CJS require() cache in vitest.
export function requireFreshLauncher() {
  delete require.cache[LAUNCHER_PATH];
  require(LAUNCHER_PATH);
  return globalThis.window.buildNovaAppConfig;
}

// ── Real platform/security neighbours, loaded for real (not mocked) ────────
// The launcher treats these as external surfaces; the suites exercise them
// exactly as the OS page does: the REAL AppPackage (real BLAKE3 integrity
// via @noble/hashes) and the REAL AppPermissionManager (real grant table in
// the setup.js localStorage, real consent dialogs in the jsdom document).
export const RealAppPackage = require('../../../js/platform/core/app-package.js');
export const RealAppPermissionManager = require('../../../js/platform/security/app-permission-manager.js');

// ── base64 helpers matching the .novaapp encoding (build-apps.mjs) ─────────
export const b64 = (str) => Buffer.from(str, 'utf8').toString('base64');
export const unb64 = (b) => Buffer.from(b, 'base64').toString('utf8');

// ── Real manifest fixtures, copied from the shipped apps ───────────────────
const readJson = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
export const TERMINAL_MANIFEST = readJson('../../../js/apps/terminal/manifest.json');
export const NOTIFICATIONS_MANIFEST = readJson('../../../js/apps/notifications/manifest.json');
export const LAUNCHER_APP_MANIFEST = readJson('../../../js/apps/launcher/manifest.json');

// ── Realistic package entry documents (modelled on js/apps/clock/index.html)
export const ENTRY_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '  <meta charset="utf-8">',
  '  <title>Packaged Fixture</title>',
  '  <link rel="stylesheet" href="style.css">',
  '</head>',
  '<body>',
  '  <main id="fixture-root">Packaged app entry document.</main>',
  '  <script src="app.js"><\/script>',
  '</body>',
  '</html>',
].join('\n');

// Entry with no <head> element at all (drives the prepend branches).
export const HEADLESS_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<body>',
  '  <main>Headless fixture.</main>',
  '</body>',
  '</html>',
].join('\n');

// Entry whose <head> carries attributes (drives the <head(\s[^>]*)?> arm).
export const HEAD_ATTRS_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<head lang="en" data-theme="dark">',
  '  <title>Attr Head Fixture</title>',
  '</head>',
  '<body>',
  '  <main>Attribute-head fixture.</main>',
  '</body>',
  '</html>',
].join('\n');

export const STYLE_CSS = 'body{font-family:system-ui;margin:0}#fixture-root{color:var(--text-primary)}';
export const APP_JS = 'console.log("fixture app boot");';
export const ICON_PNG_B64 = 'iVBORw0KGgo='; // 1x1 PNG prefix, valid base64

export function makeFiles({ entryHtml = ENTRY_HTML, extra = {} } = {}) {
  return {
    'index.html': b64(entryHtml),
    'style.css': b64(STYLE_CSS),
    'app.js': b64(APP_JS),
    'icons/app.png': ICON_PNG_B64,
    ...extra,
  };
}

/**
 * Realistic installed-record fixture: the exact shape js/apps/store/app.js
 * writes after installing a .novaapp — manifest fields spread to the top
 * level (real terminal manifest values), the manifest kept under `manifest`,
 * bundled files, and package lifecycle/trust metadata.
 */
export function makePackageApp(overrides = {}) {
  return {
    // ...pkg.manifest spread, exactly as store/app.js installs it:
    id: 'com.example.packaged',
    name: 'Terminal',
    version: TERMINAL_MANIFEST.version,
    description: TERMINAL_MANIFEST.description,
    entry: 'index.html',
    unrestrictedEntry: 'app.js',
    defaultSize: TERMINAL_MANIFEST.defaultSize,
    minSize: TERMINAL_MANIFEST.minSize,
    resizable: TERMINAL_MANIFEST.resizable,
    frame: TERMINAL_MANIFEST.frame,
    // record-only fields:
    manifest: { ...TERMINAL_MANIFEST, id: 'com.example.packaged' },
    novabyte_app: true,
    compiled_at: '2026-11-20T12:00:00.000Z',
    source: 'store',
    files: makeFiles(),
    signature: null,
    integrity: null,
    verified: false,
    signer: null,
    revoked: false,
    tampered: false,
    ...overrides,
  };
}

/** Service-app record (real js/apps/notifications/manifest.json shape). */
export function makeServiceApp(overrides = {}) {
  return {
    id: 'com.example.svc',
    name: NOTIFICATIONS_MANIFEST.name,
    version: NOTIFICATIONS_MANIFEST.version,
    description: NOTIFICATIONS_MANIFEST.description,
    entry: 'service.js',
    type: 'service',
    manifest: { ...NOTIFICATIONS_MANIFEST, id: 'com.example.svc' },
    files: { 'service.js': b64('// service fixture\n') },
    verified: false,
    signer: null,
    ...overrides,
  };
}

/**
 * Stamps a REAL BLAKE3 integrity block onto a record using the REAL
 * AppPackage.computeIntegrity (real @noble/hashes blake3 over the real
 * bundled file bytes).
 *
 * nonEnumerable: true attaches the block with Object.defineProperty so it
 * stays OUT of JSON.stringify(record) — i.e. it models the payload boot.js
 * verifies against (manifest: appData.manifest + integrity held separately).
 * nonEnumerable: false attaches it as a plain enumerable property — exactly
 * what js/apps/store/app.js writes — which the launcher's pkgLike
 * (manifest: appData, line 987) then serialises INTO the signing payload,
 * so genuine records can never re-verify at launch (documented as a source
 * bug by the suite; see the "genuine record" test).
 */
export async function stampIntegrity(appData, { nonEnumerable = true } = {}) {
  // Remove any enumerable `integrity` placeholder first (makePackageApp
  // defaults it to null). Otherwise the placeholder is serialised into the
  // signing payload at stamp time, while the verify-time payload (where the
  // property is the non-enumerable block) omits it — the two payloads then
  // differ by one JSON key and EVERY record, tampered or not, verifies as
  // failed. (For the same reason, records whose integrity block is attached
  // ENUMERABLE — exactly what js/apps/store/app.js writes — can never pass
  // the launcher's launch-time re-verification: the launcher builds its
  // pkgLike with `manifest: appData` (the whole record, integrity embedded),
  // not `manifest: appData.manifest`, so its payload always differs from the
  // install-time one. That is a real source bug in nova-app-launcher.js:987
  // — documented here and covered by the legacy suite, not fixed in source.)
  if (nonEnumerable) delete appData.integrity;
  const pkgLike = { manifest: appData, files: appData.files, signature: appData.signature ?? null, integrity: null };
  const block = await RealAppPackage.computeIntegrity(pkgLike, 'blake3');
  if (nonEnumerable) {
    Object.defineProperty(appData, 'integrity', { value: block, enumerable: false, configurable: true, writable: true });
  } else {
    appData.integrity = block;
  }
  return block;
}

/** Replace one bundled file's content after the integrity block was stamped. */
export function tamperFile(appData, relPath, content) {
  appData.files[relPath] = b64(content);
}

// ── DOM env: real JSDOM window wired onto the Node global scope ────────────

// Faithful port of the host's element builder (js/core/utils/base-utils.js
// createEl) for the attribute shapes the launcher passes ({ partition,
// style }); optionally reports tagName in lowercase for the one NW.js
// situation the launcher guards against (non-WEBVIEW-tagged guests).
function installCreateEl({ lowercaseWebviewTag = false } = {}) {
  globalThis.createEl = function createEl(tag, attrs) {
    const el = document.createElement(tag);
    if (lowercaseWebviewTag && String(tag).toLowerCase() === 'webview') {
      Object.defineProperty(el, 'tagName', { value: 'webview', configurable: true });
    }
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null) continue;
      if (key === 'className' || key === 'class') el.setAttribute('class', value);
      else if (key === 'textContent') el.textContent = value;
      else if (key === 'innerHTML') el.innerHTML = value;
      else if (key === 'style') {
        if (typeof value === 'object') Object.assign(el.style, value);
        else el.style.cssText = String(value);
      } else {
        el.setAttribute(key, value);
      }
    }
    return el;
  };
}

export function createEnv(opts = {}) {
  const dom = new JSDOM(opts.html ?? '<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: opts.url ?? 'https://localhost/index.html',
  });
  const w = dom.window;

  const saved = {
    window: globalThis.window,
    hadWindow: 'window' in globalThis,
    document: globalThis.document,
    hadDocument: 'document' in globalThis,
    createEl: globalThis.createEl,
    hadCreateEl: 'createEl' in globalThis,
    Blob: globalThis.Blob,
    fetch: globalThis.fetch,
    AbortController: globalThis.AbortController,
  };

  globalThis.window = w;
  globalThis.document = w.document;
  // tests/setup.js swaps the global AbortController for a plain fake whose
  // .signal is not a real AbortSignal — jsdom's addEventListener validates
  // options.signal and rejects it. Point the global at the jsdom window's
  // real AbortController so the launcher (and the real permission manager's
  // dialog) get genuine, jsdom-compatible signals.
  if (typeof w.AbortController === 'function') {
    globalThis.AbortController = w.AbortController;
  }

  if (opts.unrestrictedPackage) w.__novaUnrestrictedPackage = opts.unrestrictedPackage;
  if (opts.svgIcon) w.svgIcon = opts.svgIcon;
  if (opts.appDirs) w.AppDirs = opts.appDirs;
  if (opts._t) w._t = opts._t;
  if (opts.windowFlags) Object.assign(w, opts.windowFlags);

  // Fresh platform-neighbour baseline per env; tests opt in (real or stub)
  // after createEnv.
  delete globalThis.AppSandbox;
  delete globalThis.AppPermissionManager;
  delete globalThis.AppPackage;
  delete globalThis.FrameSecurity;

  installCreateEl({ lowercaseWebviewTag: opts.lowercaseWebviewTag });

  const env = {
    dom,
    window: w,
    document: w.document,
    blobs: null,
    saved,
    teardown() {
      try { dom.window.close(); } catch { /* already closed */ }
      if (saved.hadWindow) globalThis.window = saved.window; else delete globalThis.window;
      if (saved.hadDocument) globalThis.document = saved.document; else delete globalThis.document;
      if (saved.hadCreateEl) globalThis.createEl = saved.createEl; else delete globalThis.createEl;
      globalThis.Blob = saved.Blob;
      globalThis.fetch = saved.fetch;
      globalThis.AbortController = saved.AbortController;
      delete globalThis.AppSandbox;
      delete globalThis.AppPermissionManager;
      delete globalThis.AppPackage;
      delete globalThis.FrameSecurity;
    },
  };

  if (opts.captureBlob) {
    const RealBlob = saved.Blob;
    const blobs = [];
    class CapturingBlob extends RealBlob {
      constructor(parts, init) {
        super(parts, init);
        blobs.push(this);
      }
    }
    globalThis.Blob = CapturingBlob;
    env.blobs = blobs;
  }

  return env;
}

// ── fetch router for the launcher's real network surface ──────────────────
// The launcher's only network call on the tested paths is
// POST /api/apps/serve/register (and, in dead code, the first-party manifest
// fetch). Routes are matched by exact href or prefix, longest first.
export function installFetch(routes = {}) {
  const calls = [];
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  globalThis.fetch = async (url, opts) => {
    const href = String(url);
    calls.push({ url: href, opts });
    const key = keys.find((k) => href === k || href.startsWith(k));
    const route = key !== undefined ? routes[key] : undefined;
    if (typeof route === 'function') return route(href, opts, calls);
    if (route) return route;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { calls };
}

export function serveRegisterResponse({ baseUrl = '/api/apps/serve/sb-fixture-1', ok = true } = {}) {
  return () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => ({ baseUrl, stableBaseUrl: baseUrl + '/stable' }),
  });
}

// ── timing helpers ─────────────────────────────────────────────────────────
export function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until fn() returns truthy, failing after timeoutMs. */
export async function waitFor(fn, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await tick(intervalMs);
  }
}

/** Resolve to false if the promise is still pending after ms. */
export async function isPending(promise, ms = 120) {
  return await Promise.race([
    promise.then(() => false, () => false),
    tick(ms).then(() => true),
  ]);
}
