// tests/apps/localisation.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/localisation/service.js.
// The service is an async IIFE at require-time; it is loaded with
// scripts:[] (prelude only) and then requireFresh()d once per scenario
// against a scripted window (engine / i18next / AppLoaderOptimizer / fetch
// router), so every channel runs exactly once and observably: optimizer
// hit, every manifest-arm miss, the direct fallback, HTTP failure, identity
// mismatch, missing-en, engine-absent and vendored-i18next variants.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { coverLoadServiceApp, requireFresh } from '../helpers/cover-loader.js';
import { settle } from '../helpers/app-harness.js';

const APP_ID = 'com.nbosp.localisation';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

// A minimal but real-shaped package: vendored i18next + en/fr catalogues.
function packageWith(files, manifestId = APP_ID) {
  return { manifest: { id: manifestId }, files };
}
function happyFiles({ vendor = true, en = true, fr = true } = {}) {
  const files = {};
  if (vendor) files['vendor/i18next.min.js'] = b64('(window.i18next={createInstance:()=>({})});');
  if (en) files['locales/en.json'] = b64(JSON.stringify({ ok: { 'Save': 'Save' } }));
  if (fr) files['locales/fr.json'] = b64(JSON.stringify({ ok: { 'Save': 'Enregistrer' } }));
  return files;
}

// Router-style fetch stub: manifest URL and .novaapp URL behave per scenario.
// `manifest.json` / `novaapp.json` are DATA (what json() resolves to).
function fetchStub({ manifest, novaapp }) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('novaapp-manifest.json')) {
      if (manifest.throws) throw new Error('manifest network down');
      return { ok: manifest.ok ?? true, status: manifest.status ?? 200, json: async () => manifest.json };
    }
    if (String(url).endsWith('.novaapp')) {
      if (novaapp.throws) throw new Error('novaapp network down');
      return { ok: novaapp.ok ?? true, status: novaapp.status ?? 200, json: async () => novaapp.json };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

// Mount the app dir WITHOUT running the service; per-test stubs installed.
async function mount({ manifest, novaapp, optimizer, i18next } = {}) {
  const extras = {};
  if (optimizer !== undefined) extras.AppLoaderOptimizer = optimizer;
  const ctx = await coverLoadServiceApp('localisation', {
    scripts: [],
    stubs: { fetch: fetchStub({ manifest, novaapp }), extra: extras },
  });
  if (i18next !== undefined) ctx.window.i18next = i18next;
  return ctx;
}

function scriptEngine({ languages = [{ code: 'en' }, { code: 'fr' }, { code: 'de' }] } = {}) {
  const calls = { resources: [], library: [] };
  return {
    calls,
    registerResources(res) { calls.resources.push(res); },
    getLanguages: () => languages,
    setLibrary(lib) { calls.library.push(lib); },
  };
}

// The manifest listing that points at our own bundle via the optimizer.
const SELF_LISTING = [{ id: APP_ID, file: 'js/apps/com.nbosp.localisation.novaapp', cacheKey: 'v1' }];

async function run(ctx) {
  requireFresh('js/apps/localisation/service.js');
  await settle(50);
}

describe('com.nbosp.localisation (js/apps/localisation/service.js) — e2e coverage', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.resetModules();
  });

  it('goes silent when the NovaI18n engine is absent', async () => {
    const ctx = await mount({
      manifest: { json: SELF_LISTING },
      novaapp: { json: packageWith(happyFiles()) },
    });
    delete ctx.window.NovaI18n;
    await run(ctx);
    expect(ctx.window.fetch.calls).toEqual([]); // the IIFE returned before any fetch
  });

  it('goes silent when the engine lacks registerResources', async () => {
    const ctx = await mount({
      manifest: { json: SELF_LISTING },
      novaapp: { json: packageWith(happyFiles()) },
    });
    ctx.window.NovaI18n = { getLanguages: () => [] }; // no registerResources
    await run(ctx);
    expect(ctx.window.fetch.calls).toEqual([]);
  });

  it('happy path via the AppLoaderOptimizer cache: injects vendored i18next, registers decoded catalogues', async () => {
    const ctx = await mount({
      manifest: { json: SELF_LISTING },
      novaapp: { json: packageWith(happyFiles()) },
      optimizer: { getPackage: async () => packageWith(happyFiles()) },
    });
    const engine = scriptEngine();
    ctx.window.NovaI18n = engine;
    const appended = [];
    const realAppend = ctx.window.document.head.appendChild.bind(ctx.window.document.head);
    ctx.window.document.head.appendChild = (el) => { appended.push(el); return realAppend(el); };
    await run(ctx);
    // vendored library injected via a <script> node (removed right after)
    expect(appended).toHaveLength(1);
    expect(appended[0].dataset.novaVendored).toBe('i18next');
    expect(appended[0].textContent).toContain('window.i18next');
    // window.i18next stays undefined in JSDOM (no script execution) → library null → setLibrary skipped
    expect(engine.calls.library).toEqual([]);
    // de has no catalogue → skipped; en+fr registered as decoded JSON
    expect(engine.calls.resources).toEqual([{
      en: { ok: { Save: 'Save' } },
      fr: { ok: { Save: 'Enregistrer' } },
    }]);
    // the optimizer channel was used — the .novaapp URL was never fetched
    expect(ctx.window.fetch.calls).toEqual(['js/apps/novaapp-manifest.json']);
  });

  it('reuses an existing window.i18next and calls setLibrary (no injection)', async () => {
    const fakeLib = { createInstance: () => ({}) };
    const ctx = await mount({
      manifest: { json: SELF_LISTING },
      novaapp: { json: packageWith(happyFiles()) },
      optimizer: { getPackage: async () => packageWith(happyFiles()) },
      i18next: fakeLib,
    });
    const engine = scriptEngine();
    ctx.window.NovaI18n = engine;
    const headSpy = vi.spyOn(ctx.window.document.head, 'appendChild');
    await run(ctx);
    expect(headSpy).not.toHaveBeenCalled();
    expect(engine.calls.library).toEqual([fakeLib]);
    expect(engine.calls.resources.length).toBe(1);
  });

  it('skips injection when the package has no vendored library file', async () => {
    const ctx = await mount({
      manifest: { json: SELF_LISTING },
      novaapp: { json: packageWith(happyFiles()) },
      optimizer: { getPackage: async () => packageWith(happyFiles({ vendor: false })) },
    });
    const engine = scriptEngine();
    ctx.window.NovaI18n = engine;
    const headSpy = vi.spyOn(ctx.window.document.head, 'appendChild');
    await run(ctx);
    expect(headSpy).not.toHaveBeenCalled();
    expect(engine.calls.library).toEqual([]); // library stayed null
    expect(engine.calls.resources.length).toBe(1);
  });

  it('optimizer/manifest miss arms all fall through to the direct static fetch', async () => {
    const scenarios = [
      ['getPackage returns a foreign package', { getPackage: async () => packageWith(happyFiles(), 'com.other.app') }],
      ['getPackage returns null', { getPackage: async () => null }],
      ['getPackage throws', { getPackage: async () => { throw new Error('cache read failed'); } }],
      ['optimizer present without getPackage', { optimizerOnly: true }],
      ['manifest is not an array', { notArray: true }],
      ['manifest has no self entry', { noSelf: true }],
      ['self entry has no file string', { noFile: true }],
      ['manifest response not ok', { notOk: true }],
      ['manifest fetch rejects', { throws: true }],
    ];
    for (const [name, s] of scenarios) {
      const manifest = s.notArray
        ? { json: { note: 'object' } }
        : s.noSelf
          ? { json: [{ id: 'com.other.app', file: 'x', cacheKey: 'k' }] }
          : s.noFile
            ? { json: [{ id: APP_ID, cacheKey: 'k' }] }
            : { json: SELF_LISTING, ...(s.notOk ? { ok: false, status: 503 } : {}), ...(s.throws ? { throws: true } : {}) };
      const ctx = await mount({
        manifest,
        novaapp: { json: packageWith(happyFiles()) },
        optimizer: s.getPackage ? { getPackage: s.getPackage } : (s.optimizerOnly ? {} : { getPackage: async () => packageWith(happyFiles()) }),
      });
      const engine = scriptEngine();
      ctx.window.NovaI18n = engine;
      await run(ctx);
      expect(ctx.window.fetch.calls.some((u) => u.endsWith('.novaapp')), name).toBe(true);
      expect(engine.calls.resources.length, name).toBe(1);
      expect(engine.calls.resources[0].en, name).toEqual({ ok: { Save: 'Save' } });
    }
  });

  it('direct fetch HTTP failure fails soft: registerResources({})', async () => {
    const ctx = await mount({
      manifest: { json: SELF_LISTING },
      novaapp: { ok: false, status: 500, json: {} },
      optimizer: {},
    });
    const engine = scriptEngine();
    ctx.window.NovaI18n = engine;
    await run(ctx);
    expect(engine.calls.resources).toEqual([{}]);
  });

  it('direct fetch identity mismatch fails soft too', async () => {
    const ctx = await mount({
      manifest: { throws: true, json: SELF_LISTING },
      novaapp: { json: packageWith(happyFiles(), 'com.someone.else') },
      optimizer: {},
    });
    const engine = scriptEngine();
    ctx.window.NovaI18n = engine;
    await run(ctx);
    expect(engine.calls.resources).toEqual([{}]);
  });

  it('a package without the en catalogue fails soft (bundles.en guard)', async () => {
    const ctx = await mount({
      manifest: { json: SELF_LISTING },
      novaapp: { json: packageWith(happyFiles({ en: false })) },
      optimizer: { getPackage: async () => packageWith(happyFiles({ en: false })) },
    });
    const engine = scriptEngine();
    ctx.window.NovaI18n = engine;
    await run(ctx);
    expect(engine.calls.resources).toEqual([{}]);
  });

  it('engine with zero languages hits the missing-en guard (empty loop)', async () => {
    const ctx = await mount({
      manifest: { json: SELF_LISTING },
      novaapp: { json: packageWith(happyFiles()) },
      optimizer: { getPackage: async () => packageWith(happyFiles()) },
    });
    const engine = scriptEngine({ languages: [] });
    ctx.window.NovaI18n = engine;
    await run(ctx);
    expect(engine.calls.resources).toEqual([{}]);
  });
});
