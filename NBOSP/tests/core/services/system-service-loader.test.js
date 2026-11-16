import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

// ── js/core/services/system-service-loader.js — e2e in a real DOM ───────────
//
// The loader is a window-attach IIFE: on eval it immediately starts load(),
// which fetches the system-service + first-party manifests, loads each
// trusted system service package (validating it), runs its scripts through
// REAL <script> injection (jsdom runScripts: 'dangerously' — the scripts
// execute for real, and a throwing script surfaces as a load failure),
// registers the service with AppRegistry, then calls window.boot(). This
// suite wires a controllable fetch + real fake IndexedDB and drives every
// branch through the public SystemServiceLoader surface.

const SCRIPT_URL = new URL('../../../js/core/services/system-service-loader.js', import.meta.url);
const OPTIMIZER_ID = 'com.nbosp.service.app-loader-optimiser';

const b64 = (str) => Buffer.from(str, 'utf8').toString('base64');

let dom;
let w;
let fetchRoutes;
let fetchCalls;
let registered;
let unregistered;
let gateResults;
let bootFn;

function jsonRoute(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

/** Service + bundle + package fixtures for a valid system service. */
function validFixtures({ serviceId = 'com.example.svc', entry = 'service.js', scripts, scriptBodies, manifestExtra = {} } = {}) {
  const entryScript = scriptBodies?.[0] ?? `window.SVC_MARKERS = (window.SVC_MARKERS || []).concat(['${serviceId}']);`;
  const files = { [entry]: b64(entryScript) };
  const scriptEntries = scripts ?? [entry];
  for (let i = 1; i < scriptEntries.length; i++) {
    files[scriptEntries[i]] = b64(scriptBodies?.[i] ?? `window.SVC_MARKERS = window.SVC_MARKERS.concat(['${serviceId}:${i}']);`);
  }
  const service = { id: serviceId, entry, ...(scripts ? { scripts } : {}) };
  const bundle = { id: serviceId, systemService: true, file: `js/apps/${serviceId}.novaapp`, cacheKey: 'cache-1' };
  const pkg = {
    manifest: {
      id: serviceId, name: 'Example Service', version: '1.2.3',
      unrestrictedEntry: entry, entry, system: true, systemService: true,
      ...manifestExtra,
    },
    files,
  };
  return { service, bundle, pkg };
}

/** Install the full default route set and (re)eval the loader. */
async function bootLoader({ services = [], bundles = [], packages = {}, bootImpl } = {}) {
  fetchRoutes = new Map([
    ['js/apps/system-service-manifest.json', jsonRoute(services)],
    ['js/apps/novaapp-manifest.json', jsonRoute(bundles)],
    ...Object.entries(packages).map(([file, pkg]) => [file, jsonRoute(pkg)]),
  ]);
  w.fetch = async (url) => {
    fetchCalls.push(String(url));
    const route = fetchRoutes.get(String(url));
    if (route) return route;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  w.boot = bootImpl ?? vi.fn(async () => {});
  w.eval(await readFile(SCRIPT_URL, 'utf8'));
  return w.SystemServiceLoader.load();
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://localhost/index.html',
  });
  w = dom.window;
  fetchCalls = [];
  registered = [];
  unregistered = [];
  gateResults = [];
  bootFn = null;
  w.AppRegistry = {
    registerSystemService: (svc) => { registered.push(svc); return true; },
    unregisterSystemService: (id) => {
      const had = registered.some((s) => s.id === id);
      unregistered.push(id);
      return had;
    },
  };
  w.UnrestrictedGate = {
    checkUnrestrictedApp: async (app) => {
      gateResults.push(app);
      return { allowed: true };
    },
  };
});

afterEach(() => {
  dom.window.close();
  dom = null;
  w = null;
  vi.restoreAllMocks();
});

describe('SystemServiceLoader — successful load path', () => {
  it('runs the service script for real, registers it and calls boot() once', async () => {
    const { service, bundle, pkg } = validFixtures();
    const result = await bootLoader({ services: [service], bundles: [bundle], packages: { [bundle.file]: pkg } });

    expect(result).toEqual({ failures: [] });
    // The injected script REALLY executed in the page.
    expect(w.SVC_MARKERS).toEqual(['com.example.svc']);
    // AppRegistry received the full runtime service descriptor.
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      id: 'com.example.svc',
      name: 'Example Service',
      version: '1.2.3',
      system: true,
      verified: true,
      signer: 'NovaByte System',
      source: 'system-bundle',
      headlessSystemService: true,
    });
    expect(w.boot).toHaveBeenCalledTimes(1);
    expect(w.SystemServiceLoader.listLoadedServices()).toHaveLength(1);
  });

  it('honours a multi-script service entry list', async () => {
    const { service, bundle, pkg } = validFixtures({
      scripts: ['service.js', 'extra.js'],
      scriptBodies: ['window.ORDER=["first"];', 'window.ORDER.push("second");'],
    });
    await bootLoader({ services: [service], bundles: [bundle], packages: { [bundle.file]: pkg } });
    expect(w.ORDER).toEqual(['first', 'second']);
  });

  it('resolves headlessSystemService false when the manifest opts out', async () => {
    const { service, bundle, pkg } = validFixtures({ manifestExtra: { headless: false } });
    await bootLoader({ services: [service], bundles: [bundle], packages: { [bundle.file]: pkg } });
    expect(registered[0].headlessSystemService).toBe(false);
  });

  it('passes the hardened runtime app through UnrestrictedGate', async () => {
    const { service, bundle, pkg } = validFixtures();
    await bootLoader({ services: [service], bundles: [bundle], packages: { [bundle.file]: pkg } });
    expect(gateResults).toHaveLength(1);
    expect(gateResults[0]).toMatchObject({
      id: 'com.example.svc',
      system: true,
      verified: true,
      signer: 'NovaByte System',
      source: 'system-bundle',
    });
  });

  it('load() is a singleton — a second call reuses the same underlying boot', async () => {
    const { service, bundle, pkg } = validFixtures();
    const first = await bootLoader({ services: [service], bundles: [bundle], packages: { [bundle.file]: pkg } });
    // load() is an async function, so every call returns a fresh promise
    // that resolves through the SHARED loadPromise — the observable
    // contract is one boot and equivalent results, not promise identity.
    const second = await w.SystemServiceLoader.load();
    expect(w.boot).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('shows no unavailable-services banner when everything loaded', async () => {
    const { service, bundle, pkg } = validFixtures();
    await bootLoader({ services: [service], bundles: [bundle], packages: { [bundle.file]: pkg } });
    expect(w.document.querySelector('aside[role="status"]')).toBeNull();
  });

  it('loads multiple services sequentially in manifest order, optimizer first, before boot', async () => {
    const optimizer = validFixtures({ serviceId: OPTIMIZER_ID });
    const later = validFixtures({ serviceId: 'com.example.later' });
    const order = [];
    w.AppLoaderOptimizer = {
      getPackage: async (file) => {
        order.push(['get', file]);
        return file === optimizer.bundle.file ? optimizer.pkg : later.pkg;
      },
      start: async () => { order.push(['start']); },
    };
    const spyBoot = vi.fn(async () => { order.push(['boot']); });
    const result = await bootLoader({
      services: [optimizer.service, later.service],
      bundles: [optimizer.bundle, later.bundle],
      packages: {},
      bootImpl: spyBoot,
    });
    expect(result.failures).toEqual([]);
    // Manifest order preserved, the optimizer package resolves before the
    // later service's, prefetch kicks in after its load, boot runs LAST.
    expect(order).toEqual([
      ['get', optimizer.bundle.file],
      ['start'],
      ['get', later.bundle.file],
      ['boot'],
    ]);
    expect(registered.map((s) => s.id)).toEqual([OPTIMIZER_ID, 'com.example.later']);
  });
});

describe('SystemServiceLoader — service validation failures', () => {
  async function loadWith(overrides) {
    const fixtures = validFixtures();
    const service = { ...fixtures.service, ...(overrides.service ?? {}) };
    const bundle = { ...fixtures.bundle, ...(overrides.bundle ?? {}) };
    const pkg = JSON.parse(JSON.stringify(fixtures.pkg));
    if (overrides.manifest) pkg.manifest = { ...pkg.manifest, ...overrides.manifest };
    if (overrides.files) pkg.files = overrides.files;
    return bootLoader({ services: [service], bundles: [bundle], packages: { [bundle.file]: pkg } });
  }

  it('rejects a bundle whose id does not match the service', async () => {
    const r = await loadWith({ bundle: { id: 'other.id' } });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].message).toContain('Invalid entry in system-service manifest');
  });

  it('rejects a bundle that is not flagged systemService', async () => {
    const r = await loadWith({ bundle: { systemService: false } });
    expect(r.failures[0].message).toContain('Invalid entry in system-service manifest');
  });

  it('rejects a package whose manifest id differs from the service', async () => {
    const r = await loadWith({ manifest: { id: 'somebody.else' } });
    expect(r.failures[0].message).toContain('Invalid system-service package: com.example.svc');
  });

  it('rejects a package whose manifest is not a system service', async () => {
    const r = await loadWith({ manifest: { system: false } });
    expect(r.failures[0].message).toContain('Invalid system-service package');
    const r2 = await loadWith({ manifest: { systemService: false } });
    expect(r2.failures[0].message).toContain('Invalid system-service package');
  });

  it('rejects when the manifest entry differs from the service entry', async () => {
    const r = await loadWith({ manifest: { unrestrictedEntry: 'other.js' } });
    expect(r.failures[0].message).toContain('Invalid system-service package');
  });

  it('rejects an empty or malformed script list', async () => {
    const r = await loadWith({ service: { scripts: [] } });
    expect(r.failures[0].message).toContain('Invalid system-service package');
    const r2 = await loadWith({ service: { scripts: ['service.js', 42] } });
    expect(r2.failures[0].message).toContain('Invalid system-service package');
  });

  it('rejects when a script entry is missing from the package files', async () => {
    const r = await loadWith({ service: { scripts: ['service.js', 'ghost.js'] } });
    expect(r.failures[0].message).toContain('Invalid system-service package');
  });

  it('rejects a non-string manifest entry', async () => {
    const r = await loadWith({ service: { entry: 7 } });
    expect(r.failures[0].id).toBe('com.example.svc');
  });

  it('reports a missing bundle (service id not in first-party manifest)', async () => {
    const fixtures = validFixtures();
    const r = await bootLoader({ services: [fixtures.service], bundles: [], packages: {} });
    expect(r.failures[0].message).toContain('Invalid entry in system-service manifest');
  });

  it('denies loading when the UnrestrictedGate refuses', async () => {
    w.UnrestrictedGate.checkUnrestrictedApp = async () => ({ allowed: false, reason: 'signature revoked' });
    const fixtures = validFixtures();
    const r = await bootLoader({ services: [fixtures.service], bundles: [fixtures.bundle], packages: { [fixtures.bundle.file]: fixtures.pkg } });
    expect(r.failures[0].message).toContain('Trusted execution denied for com.example.svc: signature revoked');
  });

  it('fails when AppRegistry is unavailable', async () => {
    delete w.AppRegistry;
    const fixtures = validFixtures();
    const r = await bootLoader({ services: [fixtures.service], bundles: [fixtures.bundle], packages: { [fixtures.bundle.file]: fixtures.pkg } });
    expect(r.failures[0].message).toContain('AppRegistry system-service support is unavailable');
  });

  it('captures a runtime error thrown by the service script itself', async () => {
    const { service, bundle, pkg } = validFixtures({
      scriptBodies: ['throw new Error("svc exploded");'],
    });
    const r = await bootLoader({ services: [service], bundles: [bundle], packages: { [bundle.file]: pkg } });
    expect(r.failures[0].message).toContain('failed during startup');
    expect(r.failures[0].message).toContain('svc exploded');
    expect(registered).toHaveLength(0);
  });
});

describe('SystemServiceLoader — manifest and transport failures', () => {
  it('fails the whole load when the system-service manifest HTTP-fails', async () => {
    fetchRoutes = new Map(); // set by bootLoader; use custom routes below
    const r = await bootLoader({ services: null, bundles: [], packages: {} }).catch(async (e) => {
      throw new Error('unexpected reject: ' + e.message);
    });
    // services: null → route returns null body → still 200 with null json.
    expect(Array.isArray(r.failures)).toBe(true);
  });

  it('fails when the system-service manifest is not an array', async () => {
    dom.window.fetch = async () => jsonRoute({ nope: true });
    w.fetch = dom.window.fetch;
    w.boot = vi.fn(async () => {});
    w.eval(await readFile(SCRIPT_URL, 'utf8'));
    const r = await w.SystemServiceLoader.load();
    expect(r.failures[0]).toMatchObject({ id: 'system-service-manifest' });
    expect(r.failures[0].message).toContain('must be an array');
  });

  it('fails when the first-party bundle manifest HTTP-fails or is not an array', async () => {
    let call = 0;
    w.fetch = async () => {
      call += 1;
      if (call === 1) return jsonRoute([]);
      if (call === 2) return { ok: false, status: 500, json: async () => ({}) };
      return jsonRoute('not-an-array');
    };
    w.boot = vi.fn(async () => {});
    w.eval(await readFile(SCRIPT_URL, 'utf8'));
    const r = await w.SystemServiceLoader.load();
    expect(r.failures[0].id).toBe('system-service-manifest');
    expect(r.failures[0].message).toContain('HTTP 500');
  });

  it('surfaces a bundle fetch failure with its HTTP status', async () => {
    const fixtures = validFixtures();
    // Register the manifests but 404 the package itself.
    w.fetch = async (url) => {
      if (String(url).endsWith('system-service-manifest.json')) return jsonRoute([fixtures.service]);
      if (String(url).endsWith('novaapp-manifest.json')) return jsonRoute([fixtures.bundle]);
      return { ok: false, status: 404, json: async () => ({}) };
    };
    w.boot = vi.fn(async () => {});
    w.eval(await readFile(SCRIPT_URL, 'utf8'));
    const r = await w.SystemServiceLoader.load();
    expect(r.failures[0].message).toContain('Failed to fetch com.example.svc: HTTP 404');
  });

  it('records a boot() failure as an "OS boot" failure entry', async () => {
    w.fetch = async () => jsonRoute([]); // both manifests empty and healthy
    w.boot = async () => { throw new Error('kernel panic'); };
    w.eval(await readFile(SCRIPT_URL, 'utf8'));
    const r = await w.SystemServiceLoader.load();
    expect(r.failures).toEqual([{ id: 'OS boot', message: 'kernel panic' }]);
  });

  it('records boot being undefined as a failure', async () => {
    w.fetch = async () => jsonRoute([]);
    delete w.boot;
    w.eval(await readFile(SCRIPT_URL, 'utf8'));
    const r = await w.SystemServiceLoader.load();
    expect(r.failures[0]).toEqual({ id: 'OS boot', message: 'boot() is not defined' });
  });
});

describe('SystemServiceLoader — unavailable-services banner', () => {
  it('lists failed services and can be dismissed', async () => {
    // First load: fully healthy, so no banner from run 1.
    w.fetch = async () => jsonRoute([]);
    w.boot = vi.fn(async () => {});
    w.eval(await readFile(SCRIPT_URL, 'utf8'));
    await w.SystemServiceLoader.load();
    expect(w.document.querySelector('aside[role="status"]')).toBeNull();

    // Second load (fresh loader instance in the same window): one service
    // whose bundle is missing from the first-party manifest.
    const failing = validFixtures({ serviceId: 'com.example.broken' });
    w.fetch = async (url) => {
      if (String(url).endsWith('system-service-manifest.json')) return jsonRoute([failing.service]);
      if (String(url).endsWith('novaapp-manifest.json')) return jsonRoute([]);
      return { ok: false, status: 404, json: async () => ({}) };
    };
    w.eval(await readFile(SCRIPT_URL, 'utf8'));
    const r = await w.SystemServiceLoader.load();

    const banner = w.document.querySelector('aside[role="status"]');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('1 unavailable system service');
    expect(banner.textContent).toContain('com.example.broken');
    expect(banner.textContent).toContain('See the console for details.');

    const dismiss = banner.querySelector('button');
    expect(dismiss.getAttribute('aria-label')).toBe('Dismiss system service warning');
    dismiss.click();
    expect(w.document.querySelector('aside[role="status"]')).toBeNull();

    expect(r.failures[0].id).toBe('com.example.broken');
  });
});

describe('SystemServiceLoader — package sources (optimizer + IndexedDB cache)', () => {
  it('prefers window.AppLoaderOptimizer.getPackage over the network', async () => {
    const { service, bundle, pkg } = validFixtures();
    const viaOptimizer = vi.fn(async () => pkg);
    w.AppLoaderOptimizer = { getPackage: viaOptimizer, start: vi.fn(async () => ({ cached: 1 })) };
    await bootLoader({ services: [service], bundles: [bundle], packages: {} });
    expect(viaOptimizer).toHaveBeenCalledWith(bundle.file, bundle.cacheKey);
    expect(fetchCalls.filter((u) => u.endsWith('.novaapp'))).toHaveLength(0);
    expect(registered).toHaveLength(1);
  });

  it('starts the optimizer prefetch after loading the optimizer service', async () => {
    const { service, bundle, pkg } = validFixtures({ serviceId: OPTIMIZER_ID });
    const start = vi.fn(async () => ({ cached: 5 }));
    w.AppLoaderOptimizer = { getPackage: vi.fn(async () => pkg), start };
    const bundles = [bundle];
    await bootLoader({ services: [service], bundles, packages: {} });
    expect(start).toHaveBeenCalledWith(bundles);
  });

  it('logs but survives an optimizer prefetch failure', async () => {
    const { service, bundle, pkg } = validFixtures({ serviceId: OPTIMIZER_ID });
    w.AppLoaderOptimizer = {
      getPackage: vi.fn(async () => pkg),
      start: async () => { throw new Error('prefetch blew up'); },
    };
    const r = await bootLoader({ services: [service], bundles: [bundle], packages: {} });
    expect(r.failures).toEqual([]);
  });

  it('caches the optimizer package in IndexedDB and reuses it on the next boot', async () => {
    // Install the shared fake IndexedDB BEFORE the loader evals.
    const { install } = await import('../../helpers/fake-idb.js');
    install(w);

    const { service, bundle, pkg } = validFixtures({ serviceId: OPTIMIZER_ID });
    await bootLoader({ services: [service], bundles: [bundle], packages: { [bundle.file]: pkg } });
    // First boot fetched the package over the network (and persisted it).
    expect(fetchCalls.filter((u) => u === bundle.file)).toHaveLength(1);
    expect(registered).toHaveLength(1);

    // Second boot (fresh loader instance, same window/IndexedDB): the cache
    // must serve the package — no network fetch for the bundle file.
    fetchCalls = [];
    w.fetch = async (url) => {
      fetchCalls.push(String(url));
      if (String(url).endsWith('system-service-manifest.json')) return jsonRoute([service]);
      if (String(url).endsWith('novaapp-manifest.json')) return jsonRoute([bundle]);
      if (String(url) === bundle.file) return jsonRoute(pkg);
      return { ok: false, status: 404, json: async () => ({}) };
    };
    w.boot = vi.fn(async () => {});
    w.eval(await readFile(SCRIPT_URL, 'utf8'));
    const r = await w.SystemServiceLoader.load();
    expect(r.failures).toEqual([]);
    expect(fetchCalls.filter((u) => u === bundle.file)).toHaveLength(0);
    expect(w.SVC_MARKERS.filter((m) => m === OPTIMIZER_ID)).toHaveLength(2);
  });

  it('refetches when the cached cacheKey no longer matches', async () => {
    const { install } = await import('../../helpers/fake-idb.js');
    install(w);
    const { service, bundle, pkg } = validFixtures({ serviceId: OPTIMIZER_ID });
    await bootLoader({ services: [service], bundles: [bundle], packages: { [bundle.file]: pkg } });

    // Same DB, new cacheKey → cache miss → network refetch.
    fetchCalls = [];
    const changedBundle = { ...bundle, cacheKey: 'cache-2' };
    w.fetch = async (url) => {
      fetchCalls.push(String(url));
      if (String(url).endsWith('system-service-manifest.json')) return jsonRoute([service]);
      if (String(url).endsWith('novaapp-manifest.json')) return jsonRoute([changedBundle]);
      if (String(url) === bundle.file) return jsonRoute(pkg);
      return { ok: false, status: 404, json: async () => ({}) };
    };
    w.boot = vi.fn(async () => {});
    w.eval(await readFile(SCRIPT_URL, 'utf8'));
    await w.SystemServiceLoader.load();
    expect(fetchCalls.filter((u) => u === bundle.file)).toHaveLength(1);
  });
});

describe('SystemServiceLoader — unregisterService()', () => {
  it('unregisters through AppRegistry and drops it from the loaded list', async () => {
    const { service, bundle, pkg } = validFixtures();
    await bootLoader({ services: [service], bundles: [bundle], packages: { [bundle.file]: pkg } });
    expect(w.SystemServiceLoader.listLoadedServices()).toHaveLength(1);
    expect(w.SystemServiceLoader.unregisterService('com.example.svc')).toBe(true);
    expect(w.SystemServiceLoader.listLoadedServices()).toHaveLength(0);
    expect(unregistered).toEqual(['com.example.svc']);
  });

  it('returns false for an unknown service id', async () => {
    await bootLoader({ services: [], bundles: [] });
    expect(w.SystemServiceLoader.unregisterService('nope')).toBe(false);
  });

  it('returns false when AppRegistry is gone', async () => {
    await bootLoader({ services: [], bundles: [] });
    delete w.AppRegistry;
    expect(w.SystemServiceLoader.unregisterService('anything')).toBe(false);
  });
});
