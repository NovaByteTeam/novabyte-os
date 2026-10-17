import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const loaderSource = readFileSync(
  new URL('../../js/core/services/system-service-loader.js', import.meta.url),
  'utf8'
);

function response(data) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
  };
}

function createLoaderContext({
  trusted = true,
  integrityValid = true,
  missingPackage = null,
  services: configuredServices,
  firstServiceScripts = ['service.js'],
} = {}) {
  const services = [
    {
      id: 'com.example.first',
      entry: firstServiceScripts[0],
      ...(firstServiceScripts.length === 1 && firstServiceScripts[0] === 'service.js'
        ? {}
        : { scripts: firstServiceScripts }),
    },
    { id: 'com.example.second', entry: 'service.js' },
  ];
  if (configuredServices) {
    services.splice(0, services.length, ...configuredServices);
  }
  const bundles = services.map(({ id }) => ({
    id,
    file: `js/apps/${id}.novaapp`,
    systemService: true,
  }));
  const packages = new Map(services.map(({ id, entry, scripts }, index) => [
    `js/apps/${id}.novaapp`,
    {
      manifest: {
        id,
        system: true,
        systemService: true,
        unrestrictedEntry: entry,
      },
      files: Object.fromEntries(
        (scripts || [entry]).map((scriptEntry, scriptIndex) => [
          scriptEntry,
          btoa(`window.started.push(${index + 1}${scriptIndex === 0 ? '' : ' + 99'})`),
        ])
      ),
      integrity: { method: 'sha512' },
    },
  ]));
  const started = [];
  const statusElements = [];
  const boot = vi.fn();
  const eventListeners = new Map();
  const context = {
    atob,
    TextDecoder,
    started,
    boot,
    addEventListener: vi.fn((type, listener) => eventListeners.set(type, listener)),
    removeEventListener: vi.fn((type, listener) => {
      if (eventListeners.get(type) === listener) eventListeners.delete(type);
    }),
    console: { info: vi.fn(), error: vi.fn() },
    fetch: vi.fn(async url => {
      if (url === 'js/apps/system-service-manifest.json') return response(services);
      if (url === 'js/apps/novaapp-manifest.json') return response(bundles);
      if (url === `js/apps/${missingPackage}.novaapp`) return { ok: false, status: 404 };
      if (packages.has(url)) return response(packages.get(url));
      return { ok: false, status: 404 };
    }),
    AppPackage: {
      verifyIntegrity: vi.fn(async () => integrityValid),
    },
    UnrestrictedGate: {
      checkUnrestrictedApp: vi.fn(async () => ({
        allowed: trusted,
        reason: 'test denial',
      })),
    },
    localStorage: { setItem: vi.fn() },
  };
  context.window = context;
  context.document = {
    createElement: () => ({
      dataset: {},
      style: {},
      append() {},
      addEventListener() {},
      remove() {},
    }),
    head: {
      appendChild(script) {
        try {
          runInNewContext(script.textContent, context);
        } catch (error) {
          eventListeners.get('error')?.({ error, message: error.message });
        }
      },
    },
    body: {
      appendChild(element) {
        statusElements.push(element);
      },
    },
  };

  return { context, statusElements, packages, started, boot };
}

describe('SystemServiceLoader', () => {
  it('verifies and starts trusted services sequentially in manifest order', async () => {
    const { context, statusElements, started, boot } = createLoaderContext();
    runInNewContext(loaderSource, context);

    await context.SystemServiceLoader.load();

    expect(started).toEqual([1, 2]);
    expect(context.UnrestrictedGate.checkUnrestrictedApp).toHaveBeenCalledTimes(2);
    expect(context.console.info).toHaveBeenCalledTimes(2);
    expect(boot).toHaveBeenCalledOnce();
    expect(statusElements).toHaveLength(0);
    expect(context.SystemServiceLoader.listLoadedServices()).toHaveLength(2);
    expect(context.SystemServiceLoader.listLoadedServices()[0]).toMatchObject({
      id: 'com.example.first',
      system: true,
      headlessSystemService: true,
    });
  });

  it('continues startup when an individual service package is missing', async () => {
    const { context, statusElements, started, boot } = createLoaderContext({
      missingPackage: 'com.example.first',
    });
    runInNewContext(loaderSource, context);

    const result = await context.SystemServiceLoader.load();

    expect(started).toEqual([2]);
    expect(result.failures).toEqual([
      { id: 'com.example.first', message: 'Failed to fetch com.example.first: HTTP 404' },
    ]);
    expect(boot).toHaveBeenCalledOnce();
    expect(statusElements).toHaveLength(1);
  });

  it('continues OS boot if an untrusted or tampered service is rejected', async () => {
    const { context, statusElements, started, boot } = createLoaderContext({ trusted: false });
    runInNewContext(loaderSource, context);

    const result = await context.SystemServiceLoader.load();

    expect(started).toEqual([]);
    expect(result.failures).toHaveLength(2);
    expect(boot).toHaveBeenCalledOnce();
    expect(statusElements).toHaveLength(1);
  });

  it('still runs OS boot if a service entry throws during execution', async () => {
    const { context, statusElements, started, boot } = createLoaderContext();
    const originalFetch = context.fetch.getMockImplementation();
    context.fetch.mockImplementation(async url => {
      const result = await originalFetch(url);
      if (url === 'js/apps/com.example.first.novaapp') {
        const pkg = await result.json();
        pkg.files['service.js'] = btoa('throw new Error("service failed")');
        return response(pkg);
      }
      return result;
    });
    runInNewContext(loaderSource, context);

    const result = await context.SystemServiceLoader.load();

    expect(started).toEqual([2]);
    expect(result.failures).toHaveLength(1);
    expect(boot).toHaveBeenCalledOnce();
    expect(statusElements).toHaveLength(1);
  });

  it('loads multiple package entries sequentially and reports non-headless packages accurately', async () => {
    const { context, started } = createLoaderContext({
      firstServiceScripts: ['wm.js', 'menu.js', 'modals.js', 'desktop.js'],
    });
    const pkg = {
      manifest: {
        id: 'com.example.first',
        system: true,
        systemService: true,
        unrestrictedEntry: 'wm.js',
        headless: false,
      },
      files: Object.fromEntries(
        ['wm.js', 'menu.js', 'modals.js', 'desktop.js'].map((entry, index) => [
          entry,
          btoa(`window.started.push(${index + 1})`),
        ])
      ),
      integrity: { method: 'sha512' },
    };
    context.fetch.mockImplementation(async url => {
      if (url === 'js/apps/system-service-manifest.json') {
        return response([
          { id: 'com.example.first', entry: 'wm.js', scripts: ['wm.js', 'menu.js', 'modals.js', 'desktop.js'] },
          { id: 'com.example.second', entry: 'service.js' },
        ]);
      }
      if (url === 'js/apps/novaapp-manifest.json') {
        return response([
          { id: 'com.example.first', file: 'js/apps/com.example.first.novaapp', systemService: true },
          { id: 'com.example.second', file: 'js/apps/com.example.second.novaapp', systemService: true },
        ]);
      }
      if (url === 'js/apps/com.example.first.novaapp') return response(pkg);
      if (url === 'js/apps/com.example.second.novaapp') {
        return response({
          manifest: { id: 'com.example.second', system: true, systemService: true, unrestrictedEntry: 'service.js' },
          files: { 'service.js': btoa('window.started.push(5)') },
        });
      }
      return { ok: false, status: 404 };
    });
    runInNewContext(loaderSource, context);

    await context.SystemServiceLoader.load();

    expect(started).toEqual([1, 2, 3, 4, 5]);
    expect(context.SystemServiceLoader.listLoadedServices()[0]).toMatchObject({
      id: 'com.example.first',
      headlessSystemService: false,
    });
  });

  it('routes to built-in recovery instead of booting after a required package fails', async () => {
    const { context, started, boot } = createLoaderContext({
      missingPackage: 'com.example.first',
      services: [
        { id: 'com.example.first', entry: 'service.js', required: true },
        { id: 'com.example.second', entry: 'service.js' },
      ],
    });
    runInNewContext(loaderSource, context);

    await context.SystemServiceLoader.load();

    expect(started).toEqual([]);
    expect(context.localStorage.setItem).toHaveBeenCalledWith('nova_force_recovery', '1');
    expect(boot).toHaveBeenCalledOnce();
  });
});
