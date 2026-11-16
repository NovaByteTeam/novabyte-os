// tests/helpers/cover-loader.js
//
// Coverage-attributed end-to-end app loader.
//
// Problem: tests/helpers/app-harness.js evals app sources inside a JSDOM
// window (dom.window.eval). That runs the real code against a real DOM, but
// Node's V8 coverage cannot attribute the executed script back to the source
// file, so js/apps/** files showed as "never loaded" in coverage even though
// e2e tests exercised them.
//
// Solution: build the JSDOM exactly like app-harness does (same stubs, same
// i18n/base-utils prelude), then MIRROR the JSDOM window's globals onto the
// Node global object and require() the app source. The code executes in the
// Node realm — so v8 coverage attributes every line to the real file — while
// every DOM object it touches (document, HTMLElement, Event, ...) comes from
// the live JSDOM instance. Tests drive the same real DOM as before, and the
// file gets coverage credit.
//
// The prelude modules (js/core/utils/base-utils.js, js/platform/core/
// registry-prefs.js, js/core/core/i18n.js) are require()d the same way, so
// they receive coverage from every app test that loads them.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { installCommonStubs } from './app-harness.js';

const nodeRequire = createRequire(import.meta.url);

const APPS_BASE = new URL('../../js/apps/', import.meta.url);
const NBOSP_BASE = new URL('../../', import.meta.url);
const BASE_UTILS_PATH = new URL('../../js/core/utils/base-utils.js', import.meta.url).pathname;
const REGISTRY_PREFS_PATH = new URL('../../js/platform/core/registry-prefs.js', import.meta.url).pathname;
const I18N_CORE_PATH = new URL('../../js/core/core/i18n.js', import.meta.url).pathname;
const EN_LOCALE_URL = new URL('../../js/apps/localisation/locales/en.json', import.meta.url);

// Window properties where the Node global must keep its own (more capable or
// vitest-managed) implementation. Everything else on the JSDOM window is
// mirrored onto globalThis so bare references inside require()d app code
// resolve into the live DOM.
const KEEP_NODE = new Set([
  'window', 'self', 'top', 'parent', 'frames', 'globalThis', 'undefined', 'NaN', 'Infinity',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'performance', 'console', 'crypto', 'structuredClone',
  'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams',
  // atob/btoa: jsdom's window wrappers internally call the *global* atob —
  // mirroring them over Node's natives makes the wrapper resolve to itself
  // (infinite recursion surfaced as InvalidCharacterError). Node's own
  // atob/btoa are correct for both realms.
  'atob', 'btoa',
  'Buffer', 'process', 'global', 'require', 'module', 'exports', '__dirname', '__filename',
  'navigator', 'origin', 'onmessage', 'onerror', 'onunhandledrejection',
]);

let enCataloguePromise = null;
function enCatalogue() {
  enCataloguePromise ??= readFile(EN_LOCALE_URL, 'utf8').then((raw) => JSON.parse(raw));
  return enCataloguePromise;
}

/** Mirror every own property of the JSDOM window onto globalThis. */
function mirrorWindowGlobals(w) {
  for (const key of Object.getOwnPropertyNames(w)) {
    if (KEEP_NODE.has(key)) continue;
    try {
      const val = w[key];
      if (val === undefined) continue;
      Object.defineProperty(globalThis, key, {
        value: val, writable: true, configurable: true, enumerable: true,
      });
    } catch { /* some accessors throw — skip them */ }
  }
  globalThis.window = w;
  globalThis.self = w;
  // Node 21+ ships a global navigator; app code wants the same one the window
  // has so feature checks match — but jsdom's navigator lacks clipboard etc.
  // Keep whichever globalThis already carries (setup.js stub), but expose the
  // jsdom one under window.navigator automatically (it already is).
}

/** Copy the harness stubs (nova, AppDirs, nw, OS, …) onto globalThis too. */
function mirrorStubs(w, extraKeys = []) {
  const keys = ['AppDirs', 'nova', 'novaOS', 'nw', 'OS', 'WM', 'registerApp', 'fetch', ...extraKeys];
  for (const key of keys) {
    if (key in w) {
      try {
        Object.defineProperty(globalThis, key, {
          value: w[key], writable: true, configurable: true,
        });
      } catch { /* non-configurable — ignore */ }
    }
  }
}

/** Mirror i18n globals exposed by the prelude onto globalThis. */
function mirrorI18nGlobals(w) {
  for (const key of ['NovaI18n', '_t', 'RegistryPrefs', 'generateId', 'sanitiseHTML', 'escapeText', 'escapeHtml', 'safeEvaluateArithmetic', 'ArithmeticError', 'detectBrowser', 'formatBytes', 'createEl']) {
    if (key in w) globalThis[key] = w[key];
  }
}

/**
 * require() a source file fresh (no cache), Node realm → v8 coverage.
 * Accepts an NBOSP-root-relative spec ('js/apps/x/app.js'), an apps-relative
 * spec ('x/app.js'), or an absolute filesystem path.
 */
export function requireFresh(spec) {
  let path;
  if (spec.startsWith('/')) {
    path = spec;
  } else if (spec.startsWith('js/') || spec.startsWith('scripts/') || spec.startsWith('server/') || spec.startsWith('security/') || spec.startsWith('email/')) {
    path = new URL(spec, NBOSP_BASE).pathname;
  } else {
    path = new URL(spec, APPS_BASE).pathname;
  }
  delete nodeRequire.cache[nodeRequire.resolve(path)];
  return nodeRequire(path);
}

/**
 * Load a window app (index.html + app.js) with full coverage attribution.
 * Same contract as app-harness.loadWindowApp(): returns
 * { dom, window, document, registered, app }.
 */
export async function coverLoadWindowApp(appName, opts = {}) {
  const { scripts = ['app.js'], html = 'index.html', stubs = {}, withBaseUtils = true } = opts;
  const appBase = new URL(`${appName}/`, APPS_BASE);
  const dom = new JSDOM(await readFile(new URL(html, appBase), 'utf8'), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: `https://localhost/js/apps/${appName}/${html}`,
  });
  installCommonStubs(dom.window, stubs);
  const registered = [];
  dom.window.registerApp = (config) => registered.push(config);
  mirrorWindowGlobals(dom.window);
  mirrorStubs(dom.window, Object.keys(stubs.extra ?? {}));
  globalThis.registerApp = dom.window.registerApp;

  // Prelude — required in the Node realm so these get coverage too.
  if (withBaseUtils) requireFresh(BASE_UTILS_PATH);
  requireFresh(REGISTRY_PREFS_PATH);
  requireFresh(I18N_CORE_PATH);
  mirrorI18nGlobals(dom.window);
  if (dom.window.NovaI18n) {
    dom.window.NovaI18n.registerResources({ en: await enCatalogue() });
  }

  for (const script of scripts) {
    requireFresh(new URL(script, appBase).pathname);
  }
  mirrorStubs(dom.window, Object.keys(stubs.extra ?? {}));
  return {
    dom, window: dom.window, document: dom.window.document,
    registered, app: registered[0] ?? null,
  };
}

/**
 * Load a service app (service.js, no html) with coverage attribution.
 * Same contract as app-harness.loadServiceApp().
 */
export async function coverLoadServiceApp(appName, opts = {}) {
  const { scripts = ['service.js'], stubs = {}, withBaseUtils = false } = opts;
  const appBase = new URL(`${appName}/`, APPS_BASE);
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: `https://localhost/js/apps/${appName}/service.js`,
  });
  installCommonStubs(dom.window, stubs);
  const registered = [];
  dom.window.registerApp = (config) => registered.push(config);
  mirrorWindowGlobals(dom.window);
  mirrorStubs(dom.window, Object.keys(stubs.extra ?? {}));
  globalThis.registerApp = dom.window.registerApp;

  if (withBaseUtils) requireFresh(BASE_UTILS_PATH);
  requireFresh(REGISTRY_PREFS_PATH);
  requireFresh(I18N_CORE_PATH);
  mirrorI18nGlobals(dom.window);
  if (dom.window.NovaI18n) {
    dom.window.NovaI18n.registerResources({ en: await enCatalogue() });
  }

  for (const script of scripts) {
    requireFresh(new URL(script, appBase).pathname);
  }
  mirrorStubs(dom.window, Object.keys(stubs.extra ?? {}));
  return { dom, window: dom.window, document: dom.window.document, registered };
}

/** Run a registered app's init() the way the window manager does. */
export function initCoveredApp(app, { state = {}, window: w } = {}) {
  if (!app || typeof app.init !== 'function') {
    throw new TypeError('registerApp descriptor has no init()');
  }
  const doc = (w ?? globalThis.window).document;
  const content = doc.createElement('div');
  app.init(content, state);
  return content;
}

export { settle } from './app-harness.js';
