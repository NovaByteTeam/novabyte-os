import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const loaderSource = readFileSync(
  new URL('../../js/core/services/system-service-loader.js', import.meta.url),
  'utf8'
);

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function encode(source) {
  return Buffer.from(source, 'utf8').toString('base64');
}

function createLoaderContext({
  services = [{ id: 'com.nbosp.service.event-log', entry: 'service.js' }],
  packages = {},
  missingPackages = [],
} = {}) {
  const launches = [];
  const statusElements = [];
  const boot = vi.fn();
  const headAppend = vi.fn();
  const makeElement = () => ({
    dataset: {},
    style: {},
    setAttribute() {},
    append() {},
    addEventListener() {},
    remove() {},
  });
  const appSandbox = {
    launch: vi.fn(async (app, container, state, options) => {
      launches.push({ app, container, state, options });
      return {
        success: true,
        sandboxId: `sandbox-${app.id}`,
        webview: makeWebview(),
      };
    }),
  };
  const context = {
    launches,
    boot,
    console: { info: vi.fn(), error: vi.fn() },
    AppSandbox: appSandbox,
    AppPackage: {
      verifyAgainstTrustStore: vi.fn(async pkg => pkg.signature === 'valid-system-signature'
        ? { trusted: true, signer: 'NovaByte System' }
        : { trusted: false, signer: null }),
      verifyIntegrity: vi.fn(async () => true),
    },
    TrustStore: { list: vi.fn(() => []), isRevoked: vi.fn(() => false) },
    localStorage: { setItem: vi.fn() },
    setTimeout,
    clearTimeout,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    TextEncoder,
    fetch: vi.fn(async url => {
      if (url === 'js/apps/system-service-manifest.json') return response(services);
      if (url === 'js/apps/novaapp-manifest.json') {
        return response(Object.keys(packages).map(id => ({
          id,
          file: `js/apps/${id}.novaapp`,
          cacheKey: `cache-${id}`,
        })));
      }
      const packageId = Object.keys(packages).find(id => url === `js/apps/${id}.novaapp`);
      if (packageId && !missingPackages.includes(packageId)) return response(packages[packageId]);
      return response('not found', 404);
    }),
  };
  context.window = context;
  context.document = {
    createElement: makeElement,
    head: { appendChild: headAppend },
    body: {
      appendChild(element) {
        if (element.getAttribute?.('role') === 'status') statusElements.push(element);
      },
    },
  };
  return { context, statusElements, launches, boot, appSandbox, headAppend };
}

function servicePackage(id, files) {
  const entry = Object.keys(files)[0];
  return {
    signature: 'valid-system-signature',
    manifest: {
      id,
      name: id,
      version: '1.0.0',
      guestEntry: entry,
      system: true,
      systemService: true,
      headless: true,
    },
    files: Object.fromEntries(
      Object.entries(files).map(([name, source]) => [name, encode(source)])
    ),
  };
}

function makeWebview() {
  const listeners = new Map();
  return {
    addEventListener: vi.fn((type, listener) => {
      listeners.set(type, listener);
      if (type === 'loadstop') queueMicrotask(() => listeners.get(type)?.({}));
    }),
    removeEventListener: vi.fn(type => listeners.delete(type)),
    executeScript: vi.fn((_script, callback) => callback([null])),
  };
}

describe('SystemServiceLoader', () => {
  it('launches packaged service code through AppSandbox without host script injection', async () => {
    const services = [
      { id: 'com.nbosp.service.event-log', entry: 'service.js' },
      {
        id: 'com.nbosp.shell-ui',
        entry: 'wm.js',
        scripts: ['wm.js', 'menu.js'],
        required: true,
        headless: false,
      },
    ];
    const packages = {
      'com.nbosp.service.event-log': servicePackage('com.nbosp.service.event-log', {
        'service.js': 'window.eventLogStarted = true;',
      }),
      'com.nbosp.shell-ui': servicePackage('com.nbosp.shell-ui', {
        'wm.js': 'window.wmStarted = true;',
        'menu.js': 'window.menuStarted = true;',
      }),
    };
    packages['com.nbosp.shell-ui'].manifest.headless = false;
    const { context, launches, boot, appSandbox, headAppend } = createLoaderContext({ services, packages });
    runInNewContext(loaderSource, context);

    await context.SystemServiceLoader.load();

    expect(appSandbox.launch).toHaveBeenCalledTimes(2);
    expect(headAppend).not.toHaveBeenCalled();
    expect(launches[0].app).toMatchObject({
      id: 'com.nbosp.service.event-log',
      entry: '__nova_service_bootstrap.html',
      system: true,
      source: 'system-bundle',
    });
    expect(launches[1].app.manifest).toBe(packages['com.nbosp.shell-ui'].manifest);
    expect(launches[1].app.files).toBe(packages['com.nbosp.shell-ui'].files);
    expect(launches[1].app.signature).toBe(packages['com.nbosp.shell-ui'].signature);
    const bootstrap = launches[1].options.entryHtml;
    expect(bootstrap).toContain('<script src="wm.js"></script>');
    expect(bootstrap).toContain('<script src="menu.js"></script>');
    expect(launches[1].app.files).not.toHaveProperty('__nova_service_bootstrap.html');
    expect(context.SystemServiceLoader.listLoadedServices()[1]).toMatchObject({
      id: 'com.nbosp.shell-ui',
      source: 'system-bundle',
      headlessSystemService: false,
      sandboxId: 'sandbox-com.nbosp.shell-ui',
    });
    expect(boot).toHaveBeenCalledOnce();
  });

  it('rejects invalid service identifiers before fetching their package', async () => {
    const id = 'com.nbosp.service.../escape';
    const { context, appSandbox, boot } = createLoaderContext({
      services: [{ id, entry: 'service.js', required: true }],
    });
    runInNewContext(loaderSource, context);

    const result = await context.SystemServiceLoader.load();

    expect(result.failures[0].id).toBe(id);
    expect(context.fetch.mock.calls.some(([url]) => String(url).includes(id))).toBe(false);
    expect(appSandbox.launch).not.toHaveBeenCalled();
    expect(context.localStorage.setItem).toHaveBeenCalledWith('nova_force_recovery', '1');
    expect(boot).toHaveBeenCalledOnce();
  });

  it('continues OS startup when an optional packaged service is unavailable', async () => {
    const services = [
      { id: 'com.nbosp.service.event-log', entry: 'service.js' },
      { id: 'com.nbosp.service.downloads-history', entry: 'service.js' },
    ];
    const packages = {
      'com.nbosp.service.event-log': servicePackage('com.nbosp.service.event-log', {
        'service.js': 'window.eventLogStarted = true;',
      }),
      'com.nbosp.service.downloads-history': servicePackage('com.nbosp.service.downloads-history', {
        'service.js': 'window.downloadsStarted = true;',
      }),
    };
    const { context, launches, boot } = createLoaderContext({
      services,
      packages,
      missingPackages: ['com.nbosp.service.downloads-history'],
    });

    runInNewContext(loaderSource, context);

    const result = await context.SystemServiceLoader.load();

    expect(launches).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].id).toBe('com.nbosp.service.downloads-history');
    expect(boot).toHaveBeenCalledOnce();
  });

  it('does not trust a package that only claims the system identity', async () => {
    const id = 'com.nbosp.service.event-log';
    const pkg = servicePackage(id, { 'service.js': 'window.eventLogStarted = true;' });
    pkg.signature = 'invalid-signature';
    const { context, appSandbox, boot } = createLoaderContext({
      services: [{ id, entry: 'service.js', required: true }],
      packages: { [id]: pkg },
    });
    runInNewContext(loaderSource, context);

    const result = await context.SystemServiceLoader.load();

    expect(result.failures[0].message).toContain('does not have a valid NovaByte System signature');
    expect(appSandbox.launch).not.toHaveBeenCalled();
    expect(context.localStorage.setItem).toHaveBeenCalledWith('nova_force_recovery', '1');
    expect(boot).toHaveBeenCalledOnce();
  });

  it('continues startup after a sandbox launch failure', async () => {
    const services = [
      { id: 'com.nbosp.service.event-log', entry: 'service.js' },
      { id: 'com.nbosp.service.downloads-history', entry: 'service.js' },
    ];
    const packages = Object.fromEntries(services.map(service => [
      service.id,
      servicePackage(service.id, { 'service.js': 'window.started = true;' }),
    ]));
    const { context, appSandbox, boot } = createLoaderContext({ services, packages });
    appSandbox.launch
      .mockRejectedValueOnce(new Error('sandbox startup failed'))
      .mockResolvedValueOnce({
        success: true,
        sandboxId: 'sandbox-next',
        webview: makeWebview(),
      });
    runInNewContext(loaderSource, context);

    const result = await context.SystemServiceLoader.load();

    expect(result.failures[0].id).toBe('com.nbosp.service.event-log');
    expect(context.SystemServiceLoader.listLoadedServices()).toHaveLength(1);
    expect(boot).toHaveBeenCalledOnce();
  });
});
