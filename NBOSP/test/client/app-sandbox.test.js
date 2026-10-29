import { describe, it, expect, vi } from 'vitest';
import AppSandbox from '../../js/platform/security/app-sandbox.js';

describe('AppSandbox (js/platform/security/app-sandbox.js)', () => {
  it('preserves Unicode in host-to-app filesystem responses', () => {
    const guestWindow = {};
    const webview = {
      executeScript: ({ code }, callback) => {
        const delivered = new Function('window', `return ${code}`)(guestWindow);
        callback([delivered]);
      },
    };
    const content = 'A — café — 日本語 😀';

    AppSandbox._internal.respond(webview, 'nova:dialog:open', 'unicode-file-open', {
      success: true,
      file: { name: 'notes.txt', content },
    });

    expect(guestWindow.__novaInbox[0]).toMatchObject({
      type: 'nova:dialog:open:response',
      requestId: 'unicode-file-open',
      result: { file: { content } },
    });
  });

  it('runs a root-enabled Home app in the host instead of forcing it into a sandbox', async () => {
    AppSandbox._internal._resetState();
    const init = vi.fn();
    const app = {
      id: 'com.example.root-home',
      name: 'Root Home',
      permissions: ['system:root'],
      unrestrictedEntry: 'root.js',
      files: { 'root.js': Buffer.from('// root Home entry').toString('base64') },
      handles: { roles: ['home'] },
    };
    const container = { innerHTML: '', style: {} };
    const appendedScripts = [];
    vi.stubGlobal('DefaultApps', {
      getAppsForCategory: () => [{ id: app.id }],
    });
    vi.stubGlobal('AppPermissionManager', {
      isGranted: permission => permission === 'system:root',
    });
    vi.stubGlobal('OS', {
      apps: { [app.id]: { init } },
      settings: {
        get: key => key === 'devMode' || key === 'rootAccessEnabled',
      },
    });
    vi.stubGlobal('document', {
      createElement: () => ({ dataset: {}, textContent: '', type: '' }),
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { appendChild: script => appendedScripts.push(script) },
    });

    try {
      const result = await AppSandbox.launchHome(app, container);

      expect(result).toMatchObject({
        success: true,
        unrestricted: true,
        hostRendered: true,
        appId: app.id,
      });
      expect(result.webview).toBeNull();
      expect(appendedScripts).toHaveLength(1);
      expect(appendedScripts[0].dataset.novaUnrestrictedApp).toBe(app.id);
      expect(init).toHaveBeenCalledWith(
        container,
        expect.objectContaining({ homeSurface: true }),
        { homeSurface: true }
      );
    } finally {
      vi.unstubAllGlobals();
      AppSandbox._internal._resetState();
    }
  });

  it('runs a trusted system Home app in the host after the unrestricted gate approves it', async () => {
    AppSandbox._internal._resetState();
    const init = vi.fn();
    const app = {
      id: 'com.nbosp.trusted-home',
      name: 'Trusted Home',
      system: true,
      verified: true,
      signer: 'NovaByte System',
      source: 'system-bundle',
      integrity: { method: 'sha256', payloadHash: 'verified-integrity' },
      manifest: { id: 'com.nbosp.trusted-home', system: true },
      unrestrictedEntry: 'home.js',
      entry: 'index.html',
      files: {
        'home.js': Buffer.from('// trusted Home entry').toString('base64'),
        'index.html': Buffer.from('<!doctype html><body>Home</body>').toString('base64'),
      },
    };
    const container = { innerHTML: '', style: {}, replaceChildren: vi.fn(), appendChild: vi.fn() };
    const appendedScripts = [];
    vi.stubGlobal('DefaultApps', {
      getAppsForCategory: () => [{ id: app.id }],
    });
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('UnrestrictedGate', {
      checkUnrestrictedApp: vi.fn(async () => ({ allowed: true })),
    });
    vi.stubGlobal('OS', {
      apps: { [app.id]: { init } },
      settings: { get: () => false },
    });
    vi.stubGlobal('document', {
      createElement: () => ({ dataset: {}, textContent: '', type: '' }),
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { appendChild: script => appendedScripts.push(script) },
    });

    try {
      const result = await AppSandbox.launchHome(app, container);

      expect(result).toMatchObject({
        success: true,
        unrestricted: true,
        hostRendered: true,
        appId: app.id,
      });
      expect(result.webview).toBeNull();
      expect(UnrestrictedGate.checkUnrestrictedApp).toHaveBeenCalledWith(app);
      expect(appendedScripts).toHaveLength(1);
      expect(init).toHaveBeenCalledWith(
        container,
        expect.objectContaining({ homeSurface: true }),
        { homeSurface: true }
      );
    } finally {
      vi.unstubAllGlobals();
      AppSandbox._internal._resetState();
    }
  });

  it('runs an approved first-party system package in the host launch path', async () => {
    AppSandbox._internal._resetState();
    const init = vi.fn();
    const app = {
      id: 'com.nbosp.trusted-package',
      name: 'Trusted Package',
      system: true,
      verified: true,
      signer: 'NovaByte System',
      source: 'system-bundle',
      integrity: { method: 'sha256', payloadHash: 'verified-integrity' },
      manifest: { id: 'com.nbosp.trusted-package', system: true },
      unrestrictedEntry: 'app.js',
      files: { 'app.js': Buffer.from('// trusted app entry').toString('base64') },
    };
    const container = { innerHTML: '', style: {} };
    const appendedScripts = [];
    vi.stubGlobal('OS', {
      apps: { [app.id]: { init } },
      settings: { get: () => false },
    });
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('UnrestrictedGate', {
      checkUnrestrictedApp: vi.fn(async () => ({ allowed: true })),
    });
    vi.stubGlobal('document', {
      createElement: () => ({ dataset: {}, textContent: '', type: '' }),
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { appendChild: script => appendedScripts.push(script) },
    });

    try {
      const result = await AppSandbox.launch(app, container, {}, {});

      expect(result).toMatchObject({
        success: true,
        unrestricted: true,
        hostRendered: true,
        appId: app.id,
      });
      expect(result.webview).toBeNull();
      expect(UnrestrictedGate.checkUnrestrictedApp).toHaveBeenCalledWith(app);
      expect(appendedScripts).toHaveLength(1);
      expect(init).toHaveBeenCalledWith(container, {}, {});
    } finally {
      vi.unstubAllGlobals();
      AppSandbox._internal._resetState();
    }
  });

  it('exposes additive novaOS API v2 storage with normalized results', async () => {
    const legacyApi = { ipc: vi.fn() };
    const sandboxWindow = { nova: legacyApi };
    const calls = [];
    const fakeIpc = vi.fn((type, payload) => {
      calls.push({ type, payload });
      if (type === 'nova:storage:get') {
        return Promise.resolve(payload.key === 'theme'
          ? { success: true, value: 'dark' }
          : { success: true, value: null });
      }
      if (type === 'nova:storage:keys') {
        return Promise.resolve({ success: true, keys: ['theme', 'layout'] });
      }
      return Promise.resolve({ success: true });
    });

    const source = AppSandbox._internal.buildNovaOSFacadeSource();
    expect(() => new Function('window', 'ipc', source)).not.toThrow();
    new Function('window', 'ipc', source)(sandboxWindow, fakeIpc);

    const api = sandboxWindow.novaOS;
    expect(sandboxWindow.nova).toBe(legacyApi);
    expect(api.apiVersion).toBe(2);
    expect(api.capabilities.has('storage.v2')).toBe(true);
    expect(api.capabilities.has('networking.v2')).toBe(false);
    expect(api.capabilities.has(undefined)).toBe(false);
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.storage)).toBe(true);

    expect(await api.storage.get('theme')).toBe('dark');
    expect(await api.storage.get('missing')).toBeNull();
    expect(await api.storage.set('theme', 'light')).toBeUndefined();
    expect(await api.storage.remove('draft')).toBeUndefined();
    expect(await api.storage.clear()).toBeUndefined();
    expect(await api.storage.keys()).toEqual(['theme', 'layout']);

    expect(calls).toEqual([
      { type: 'nova:storage:get', payload: { key: 'theme' } },
      { type: 'nova:storage:get', payload: { key: 'missing' } },
      { type: 'nova:storage:set', payload: { key: 'theme', value: 'light' } },
      { type: 'nova:storage:delete', payload: { key: 'draft' } },
      { type: 'nova:storage:clear', payload: {} },
      { type: 'nova:storage:keys', payload: {} },
    ]);
  });

  it('preserves storage bridge errors through novaOS v2', async () => {
    const hostError = Object.assign(new Error('Storage quota exceeded'), { code: 'STORAGE_FULL' });
    const fakeIpc = vi.fn(() => Promise.reject(hostError));
    const sandboxWindow = { nova: { ipc: vi.fn() } };
    new Function('window', 'ipc', AppSandbox._internal.buildNovaOSFacadeSource())(sandboxWindow, fakeIpc);

    await expect(sandboxWindow.novaOS.storage.set('large', 'value')).rejects.toBe(hostError);
    expect(fakeIpc).toHaveBeenCalledWith('nova:storage:set', { key: 'large', value: 'value' });
  });

  it('mediates permitted nested webviews through the host sibling bridge', () => {
    const shim = AppSandbox._internal.buildCapabilityShim(true);
    const script = shim.slice(shim.indexOf('<script>') + 8, shim.lastIndexOf('</script>'));

    expect(shim).toContain('nova-nested-webview');
    expect(shim).toContain("action: 'create'");
    expect(shim).toContain("action: 'bounds'");
    expect(shim).toContain("customElements.define('nova-nested-webview'");
    expect(shim).toContain('nova-nested-webview{display:block;width:100%;height:100%;}');
    expect(shim).toContain('nova-nested-webview[hidden]{display:none!important;}');
    expect(shim).toContain("attributeFilter: ['class', 'style', 'hidden']");
    expect(shim).toContain('visible: !proxy.hidden && style.display !== \'none\'');
    expect(shim).toContain('window.nova.browser = Object.freeze({');
    expect(shim).toContain('window.novaOS = Object.freeze({');
    expect(shim).toContain("'storage.v2': true");
    expect(shim).toContain("ipc('nova:storage:delete', { key: key })");

    expect(shim).toContain("ipc('nova:home:openDefaultAppsSettings', {})");
    expect(shim).toContain("ipc('nova:home:apps:list', {})");
    expect(shim).toContain("ipc('nova:home:apps:launch', { appId: appId })");
    expect(shim).toContain('files: {');
    expect(shim).toContain('openWith: function(fileId)');
    expect(shim).toContain('appearance: {');
    expect(shim).toContain('set: function(appearance)');
    expect(shim).toContain('contextMenu: {');
    expect(shim).toContain("ipc('nova:context-menu:show'");
    expect(shim).toContain('overlay: {');
    expect(shim).toContain("ipc('nova:overlay:show'");
    expect(shim).toContain('launch: function(appId, options)');
    expect(shim).toContain('onStateChange: function(callback)');
    expect(shim).toContain('share: function(data)');
    expect(shim).toContain("this._emit('navigation-commit'");
    expect(shim).toContain("this._emit('url-change'");
    expect(shim).toContain('let __NOVA_PENDING_INITIAL_URL__ = null;');
    expect(shim).not.toContain('NESTED_WEBVIEW_NAV_DELAY_MS');
    expect(() => new Function(script)).not.toThrow();
    expect(AppSandbox._internal.API_HANDLERS['nova:nested-webview']).toBeTypeOf('function');
    expect(AppSandbox._internal.API_HANDLERS['nova:files:open']).toBeTypeOf('function');
    expect(AppSandbox._internal.API_HANDLERS['nova:open-with']).toBeTypeOf('function');
    expect(AppSandbox._internal.API_HANDLERS['nova:share']).toBeTypeOf('function');
    expect(AppSandbox._internal.API_HANDLERS['nova:appearance:get']).toBeTypeOf('function');
    expect(AppSandbox._internal.API_HANDLERS['nova:appearance:set']).toBeTypeOf('function');
    expect(AppSandbox._internal.API_HANDLERS['nova:home:openDefaultAppsSettings']).toBeTypeOf('function');
    expect(AppSandbox._internal.API_HANDLERS['nova:home:apps:list']).toBeTypeOf('function');
    expect(AppSandbox._internal.API_HANDLERS['nova:home:apps:launch']).toBeTypeOf('function');
  });

  it('lets only the active sandboxed Home app open Home defaults in Settings', async () => {
    const responses = [];
    const createWindow = vi.fn(() => ({ id: 'settings-window' }));
    vi.stubGlobal('DefaultApps', { getDefault: () => 'com.test.home' });
    vi.stubGlobal('WM', { createWindow });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      await AppSandbox._internal.handleAPICall(
        'nova:home:openDefaultAppsSettings',
        {},
        'active-home',
        { id: 'com.test.home' },
        webview,
        { homeSurface: true }
      );
      await AppSandbox._internal.handleAPICall(
        'nova:home:openDefaultAppsSettings',
        {},
        'not-home',
        { id: 'com.test.other' },
        webview,
        { homeSurface: false }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(createWindow).toHaveBeenCalledWith('com.nbosp.settings', {
      section: 'default-apps',
      highlightCategory: 'home',
      requestingAppId: 'com.test.home',
    });
    expect(responses[0].result.success).toBe(true);
    expect(responses[1].error.code).toBe('PERMISSION_DENIED');
  });

  it('limits Home app listing to Settings and App Manager without system:apps', async () => {
    const responses = [];
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('window', { confirm: vi.fn(() => true) });
    vi.stubGlobal('APP_REGISTRY', [
      { id: 'com.nbosp.settings', name: 'Settings', icon: 'settings' },
      { id: 'com.nbosp.appmanager', name: 'App Manager', icon: 'apps' },
      { id: 'com.test.other', name: 'Other App', icon: 'box' },
    ]);
    vi.stubGlobal('DefaultApps', { getDefault: () => 'com.test.home' });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:home:apps:list',
        {},
        'home-app-list',
        { id: 'com.test.home' },
        { __directResponder: message => responses.push(message) },
        { homeSurface: true }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(responses[0].result.fullAccess).toBe(false);
    expect(responses[0].result.apps.map(entry => entry.id)).toEqual([
      'com.nbosp.settings',
      'com.nbosp.appmanager',
    ]);
  });

  it('always lets the active Home app launch Settings and App Manager, but gates other apps', async () => {
    const responses = [];
    const createWindow = vi.fn(appId => ({ id: `${appId}-window` }));
    let hasLaunchPermission = false;
    vi.stubGlobal('AppPermissionManager', { isGranted: permission => permission === 'system:app-launch' && hasLaunchPermission });
    vi.stubGlobal('APP_REGISTRY', [
      { id: 'com.nbosp.settings', name: 'Settings' },
      { id: 'com.nbosp.appmanager', name: 'App Manager' },
      { id: 'com.test.other', name: 'Other App' },
    ]);
    vi.stubGlobal('DefaultApps', { getDefault: () => 'com.test.home' });
    vi.stubGlobal('OS', {
      settings: { get: () => false },
      apps: {
        'com.nbosp.settings': {},
        'com.nbosp.appmanager': {},
        'com.test.other': {},
      },
    });
    vi.stubGlobal('WM', { createWindow });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      const call = (appId, sandbox = { homeSurface: true }) => AppSandbox._internal.handleAPICall(
        'nova:home:apps:launch',
        { appId },
        `launch-${appId}`,
        { id: 'com.test.home' },
        webview,
        sandbox
      );
      await call('com.nbosp.settings');
      await call('com.nbosp.appmanager');
      await call('com.test.other');
      hasLaunchPermission = true;
      await call('com.test.other');
      await call('com.nbosp.settings', { homeSurface: false });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(createWindow.mock.calls.map(([appId]) => appId)).toEqual([
      'com.nbosp.settings',
      'com.nbosp.appmanager',
      'com.test.other',
    ]);
    expect(responses[0].result.success).toBe(true);
    expect(responses[1].result.success).toBe(true);
    expect(responses[2].error.code).toBe('PERMISSION_DENIED');
    expect(responses[3].result.success).toBe(true);
    expect(responses[4].error.code).toBe('PERMISSION_DENIED');
  });

  it('returns renderable app icon URLs when listing installed apps', async () => {
    const responses = [];
    vi.stubGlobal('AppPermissionManager', { isGranted: () => true });
    vi.stubGlobal('APP_REGISTRY', [
      { id: 'com.test.svg', name: 'SVG App', icon: 'settings' },
      { id: 'com.test.asset', name: 'Asset App', icon: 'mail' },
      { id: 'com.test.image', name: 'Image App', icon: 'data:image/png;base64,aGVsbG8=' },
      { id: 'com.test.bad', name: 'Bad App', icon: '/assets/../private.png' },
    ]);
    vi.stubGlobal('svgIcon', icon => icon === 'settings'
      ? '<svg viewBox="0 0 24 24"><path d="M1 1"></path></svg>'
      : '<img src="/assets/icons8-mail-94.png">');

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:app:list',
        {},
        'list-apps',
        { id: 'com.test.launcher' },
        { __directResponder: message => responses.push(message) },
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    const listed = responses[0].result.apps;
    expect(listed[0].icon).toBe('settings');
    expect(listed[0].iconUrl).toContain('data:image/svg+xml;charset=utf-8,');
    expect(decodeURIComponent(listed[0].iconUrl.split(',')[1])).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(listed[1].iconUrl).toBe('/assets/icons8-mail-94.png');
    expect(listed[2].iconUrl).toBe('data:image/png;base64,aGVsbG8=');
    expect(listed[3].iconUrl).toBeNull();
  });

  it('does not expose host-mediated webview creation when permission is absent', () => {
    const shim = AppSandbox._internal.buildCapabilityShim(false);
    const script = shim.slice(shim.indexOf('<script>') + 8, shim.lastIndexOf('</script>'));

    expect(shim).toContain('const __NOVA_NESTED_WEBVIEW_OPTED_IN__ = false;');
    expect(() => new Function(script)).not.toThrow();
    expect(AppSandbox._internal.API_HANDLERS['nova:nested-webview']).toBeTypeOf('function');
  });

  it('limits a user-opened file grant to the exact file id', async () => {
    const responses = [];
    const selected = { id: 'selected-file', name: 'note.txt', type: 'file', content: 'hello', mimeType: 'text/plain' };
    const other = { id: 'other-file', name: 'secret.txt', type: 'file', content: 'secret', mimeType: 'text/plain' };
    const files = new Map([[selected.id, selected], [other.id, other]]);
    const writeFile = vi.fn(async (id, content) => {
      const node = files.get(id);
      if (!node) return null;
      node.content = content;
      return node;
    });
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('FS', { files, getPath: id => `/${id}`, writeFile });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      const sandbox = { openFile: { id: selected.id, node: selected } };
      await AppSandbox._internal.handleAPICall(
        'nova:fs:read', { id: selected.id }, 'selected-read',
        { id: 'com.example.editor' }, webview, sandbox
      );
      await AppSandbox._internal.handleAPICall(
        'nova:fs:write', { id: selected.id, content: 'updated' }, 'selected-write',
        { id: 'com.example.editor' }, webview, sandbox
      );
      await AppSandbox._internal.handleAPICall(
        'nova:fs:read', { id: other.id }, 'other-read',
        { id: 'com.example.editor' }, webview, sandbox
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(responses[0].result.data).toBe('hello');
    expect(responses[1].result.success).toBe(true);
    expect(writeFile).toHaveBeenCalledWith(selected.id, 'updated');
    expect(responses[2].error.code).toBe('PERMISSION_DENIED');
  });

  it('strips file intents from app-requested cross-app launches', async () => {
    const responses = [];
    const createWindow = vi.fn(() => ({ id: 'new-window' }));
    vi.stubGlobal('AppPermissionManager', { isGranted: () => true });
    vi.stubGlobal('OS', {
      settings: { get: () => false },
      apps: { 'com.example.viewer': {} },
    });
    vi.stubGlobal('WM', { createWindow });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:app:launch',
        { appId: 'com.example.viewer', options: { fileId: 'selected-file', folderId: 'private-folder', fileIntent: { action: 'open', file: { id: 'selected-file' } } } },
        'app-launch',
        { id: 'com.example.launcher' },
        { __directResponder: message => responses.push(message) },
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(createWindow).toHaveBeenCalledWith('com.example.viewer', {});
    expect(responses[0].result.success).toBe(true);
  });

  it('brokers declared service and content-provider calls between active, authorized apps', async () => {
    const callerResponses = [];
    const targetResponses = [];
    const endpoint = 'provider:com.example.contacts.lookup';
    const targetSandboxId = 'ipc-target-sandbox';
    const targetWebview = {
      dataset: { sandboxId: targetSandboxId },
      __directResponder: message => targetResponses.push(message),
    };
    const targetSandbox = {
      appId: 'com.example.contacts',
      webview: targetWebview,
      appIpcEndpoints: new Set([endpoint]),
    };
    vi.stubGlobal('AppPermissionManager', {
      isGranted: (permission, appId) =>
        permission === 'apps:communicate'
        && ['com.example.client', 'com.example.contacts'].includes(appId),
    });
    vi.stubGlobal('OS', {
      apps: {
        'com.example.contacts': {
          manifest: { ipc: { exports: [endpoint] } },
        },
      },
    });
    AppSandbox._internal._activeSandboxes.set(targetSandboxId, targetSandbox);

    try {
      const invoke = AppSandbox._internal.handleAPICall(
        'nova:ipc:invoke',
        {
          targetAppId: 'com.example.contacts',
          endpoint,
          data: { query: 'Ada' },
        },
        'provider-call',
        { id: 'com.example.client' },
        {
          dataset: { sandboxId: 'ipc-caller-sandbox' },
          __directResponder: message => callerResponses.push(message),
        },
        {}
      );

      expect(targetResponses[0]).toMatchObject({
        type: 'nova:ipc:request:response',
        result: {
          endpoint,
          sourceAppId: 'com.example.client',
          data: { query: 'Ada' },
        },
      });

      await AppSandbox._internal.handleAPICall(
        'nova:ipc:reply',
        { callId: targetResponses[0].requestId, result: { id: 'contact-1' } },
        'provider-reply',
        { id: 'com.example.contacts' },
        targetWebview,
        targetSandbox
      );
      await invoke;
    } finally {
      AppSandbox._internal._activeSandboxes.delete(targetSandboxId);
      vi.unstubAllGlobals();
    }

    expect(callerResponses[0].result).toEqual({ result: { id: 'contact-1' } });
  });

  it('requires exported endpoints and receiver actions to be declared before registration', async () => {
    const responses = [];
    const sandboxId = 'ipc-manifest-sandbox';
    const sandbox = {
      appId: 'com.example.provider',
      webview: { dataset: { sandboxId } },
      appIpcEndpoints: new Set(),
      ipcBroadcastActions: new Set(),
    };
    vi.stubGlobal('AppPermissionManager', { isGranted: () => true });
    vi.stubGlobal('OS', {
      apps: {
        'com.example.provider': {
          manifest: {
            ipc: {
              exports: ['service:com.example.provider.status'],
              receives: ['com.example.provider.refresh'],
            },
          },
        },
      },
    });
    AppSandbox._internal._activeSandboxes.set(sandboxId, sandbox);

    try {
      const webview = {
        dataset: { sandboxId },
        __directResponder: message => responses.push(message),
      };
      await AppSandbox._internal.handleAPICall(
        'nova:ipc:register',
        { endpoint: 'service:com.example.provider.status' },
        'register-declared-endpoint',
        { id: sandbox.appId },
        webview,
        sandbox
      );
      await AppSandbox._internal.handleAPICall(
        'nova:ipc:register',
        { endpoint: 'service:com.example.provider.admin' },
        'register-undeclared-endpoint',
        { id: sandbox.appId },
        webview,
        sandbox
      );
      await AppSandbox._internal.handleAPICall(
        'nova:ipc:broadcast:subscribe',
        { action: 'com.example.provider.refresh' },
        'subscribe-declared-action',
        { id: sandbox.appId },
        webview,
        sandbox
      );
      await AppSandbox._internal.handleAPICall(
        'nova:ipc:broadcast:subscribe',
        { action: 'com.example.provider.delete-all' },
        'subscribe-undeclared-action',
        { id: sandbox.appId },
        webview,
        sandbox
      );
    } finally {
      AppSandbox._internal._activeSandboxes.delete(sandboxId);
      vi.unstubAllGlobals();
    }

    expect(responses[0].result.success).toBe(true);
    expect(responses[1].error.code).toBe('PERMISSION_DENIED');
    expect(responses[2].result.success).toBe(true);
    expect(responses[3].error.code).toBe('PERMISSION_DENIED');
  });

  it('delivers app broadcasts only to declared, subscribed, authorized sandboxes', async () => {
    const senderResponses = [];
    const recipientResponses = [];
    const action = 'com.example.notes.changed';
    const recipientSandboxId = 'broadcast-recipient-sandbox';
    const recipientSandbox = {
      appId: 'com.example.notes',
      webview: {
        dataset: { sandboxId: recipientSandboxId },
        __directResponder: message => recipientResponses.push(message),
      },
      ipcBroadcastActions: new Set([action]),
    };
    vi.stubGlobal('AppPermissionManager', {
      isGranted: (permission, appId) =>
        permission === 'apps:communicate'
        && ['com.example.editor', 'com.example.notes'].includes(appId),
    });
    AppSandbox._internal._activeSandboxes.set(recipientSandboxId, recipientSandbox);

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:ipc:broadcast',
        { action, data: { noteId: 'note-1' } },
        'broadcast',
        { id: 'com.example.editor' },
        { __directResponder: message => senderResponses.push(message) },
        {}
      );
    } finally {
      AppSandbox._internal._activeSandboxes.delete(recipientSandboxId);
      vi.unstubAllGlobals();
    }

    expect(recipientResponses[0]).toMatchObject({
      type: 'nova:ipc:broadcast:response',
      result: {
        action,
        sourceAppId: 'com.example.editor',
        data: { noteId: 'note-1' },
      },
    });
    expect(senderResponses[0].result.delivered).toBe(1);
  });

  it('opens the host Open with chooser only for files in the calling app scope', async () => {
    const responses = [];
    const selected = { id: 'selected', name: 'note.txt', type: 'file', mimeType: 'text/plain' };
    const privateFile = { id: 'private', name: 'secret.txt', type: 'file', mimeType: 'text/plain' };
    const paths = new Map([
      ['selected', '/Documents/note.txt'],
      ['private', '/data/other.app/secret.txt'],
      ['trash', '/Trash'],
    ]);
    const files = new Map([[selected.id, selected], [privateFile.id, privateFile]]);
    const choose = vi.fn(async () => ({ cancelled: false, success: true, appId: 'com.example.editor', windowId: 'opened-window' }));
    vi.stubGlobal('FS', {
      files,
      specialFolders: { trash: 'trash' },
      getPath: id => paths.get(id) || '/',
    });
    vi.stubGlobal('window', { showOpenWithDialog: choose });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      await AppSandbox._internal.handleAPICall(
        'nova:open-with', { fileId: selected.id }, 'open-shared',
        { id: 'com.example.filemanager' }, webview, {}
      );
      await AppSandbox._internal.handleAPICall(
        'nova:open-with', { fileId: privateFile.id }, 'open-private',
        { id: 'com.example.filemanager' }, webview, {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose).toHaveBeenCalledWith(selected);
    expect(responses[0].result).toMatchObject({ success: true, appId: 'com.example.editor' });
    expect(responses[1].error.code).toBe('NOT_FOUND');
  });

  it('allows openWith for the file already granted to this sandbox', async () => {
    const responses = [];
    const selected = { id: 'selected', name: 'note.txt', type: 'file', mimeType: 'text/plain' };
    const privateFile = { id: 'private', name: 'secret.txt', type: 'file', mimeType: 'text/plain' };
    const choose = vi.fn(async node => ({ cancelled: false, success: true, appId: 'com.example.viewer', receivedId: node.id }));
    vi.stubGlobal('FS', {
      rootId: 'root',
      files: new Map([[selected.id, selected], [privateFile.id, privateFile]]),
      specialFolders: { trash: 'trash' },
      getPath: id => id === 'root' ? '/' : id === selected.id ? '/data/another.app/note.txt' : '/data/other.app/secret.txt',
    });
    vi.stubGlobal('window', { showOpenWithDialog: choose });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      const sandbox = { openFile: { id: selected.id, node: selected } };
      await AppSandbox._internal.handleAPICall(
        'nova:open-with', { fileId: selected.id }, 'open-granted',
        { id: 'com.example.viewer' }, webview, sandbox
      );
      await AppSandbox._internal.handleAPICall(
        'nova:open-with', { fileId: privateFile.id }, 'open-ungranted',
        { id: 'com.example.viewer' }, webview, sandbox
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose).toHaveBeenCalledWith(selected);
    expect(responses[0].result).toMatchObject({ success: true, receivedId: selected.id });
    expect(responses[1].error.code).toBe('NOT_FOUND');
  });

  it('rejects host-side nested webview requests without the permission grant', async () => {
    const responses = [];
    const webview = { __directResponder: message => responses.push(message) };

    await AppSandbox._internal.handleAPICall(
      'nova:nested-webview',
      { action: 'create', id: 'nvw_test' },
      'request-test',
      { id: 'third-party.app', manifest: { permissions: ['sandbox:nested-webview'] } },
      webview,
      { nestedWebviewOptedIn: false }
    );

    expect(responses).toHaveLength(1);
    expect(responses[0].error.code).toBe('PERMISSION_DENIED');
  });

  it('exposes opted-in browser APIs before consent but enforces the grant on the host', async () => {
    const responses = [];
    const app = {
      id: 'com.novabrowser.app',
      manifest: { permissions: ['net:external', 'sandbox:nested-webview'] },
    };
    vi.stubGlobal('AppPermissionManager', { isGranted: vi.fn(() => false) });

    try {
      const html = AppSandbox._internal.injectCapabilityShim('<!doctype html><html></html>', app);
      expect(html).toContain('const __NOVA_NESTED_WEBVIEW_OPTED_IN__ = true;');
      expect(AppSandbox._internal.isNestedWebviewPermitted(app)).toBe(false);

      await AppSandbox._internal.handleAPICall(
        'nova:nested-webview',
        { action: 'create', id: 'nvw_consent' },
        'nested-webview-before-consent',
        app,
        { __directResponder: message => responses.push(message) },
        { nestedWebviewOptedIn: true, nestedWebviews: new Map() }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(responses[0].error.code).toBe('PERMISSION_DENIED');
  });

  it('removes live nested views when their permission is revoked', () => {
    const cleanup = vi.fn();
    const remove = vi.fn();
    const discard = vi.fn();
    const sandboxId = 'permission-revoke-test';
    AppSandbox._internal._activeSandboxes.set(sandboxId, {
      appId: 'com.novabrowser.app',
      nestedWebviews: new Map([['view', { cleanups: [cleanup], view: { remove } }]]),
      pendingNewWindows: new Map([['popup', { discard }]]),
    });

    try {
      expect(AppSandbox.handlePermissionRevoked('sandbox:nested-webview', 'com.novabrowser.app')).toBe(true);
    } finally {
      AppSandbox._internal._activeSandboxes.delete(sandboxId);
    }

    expect(cleanup).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
  });

  it('gives nested sites a separate stable partition without inheriting the app sandbox', async () => {
    const responses = [];
    const attributes = new Map();
    const child = {
      style: {},
      setAttribute: vi.fn((name, value) => attributes.set(name, value)),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const parent = {
      isConnected: true,
      style: {},
      appendChild: vi.fn(),
    };
    vi.stubGlobal('document', { createElement: vi.fn(() => child) });
    vi.stubGlobal('AppPermissionManager', { isGranted: vi.fn(() => true) });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:nested-webview',
        { action: 'create', id: 'nvw_persistent' },
        'nested-webview-create',
        { id: 'com.example.browser' },
        {
          getAttribute: vi.fn(() => 'allow-scripts allow-forms'),
          __directResponder: message => responses.push(message),
        },
        { nestedWebviewOptedIn: true, nestedWebviews: new Map(), state: { content: parent } }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(attributes.get('partition')).toBe('persist:app_com.example.browser_webcontent');
    expect(attributes.has('sandbox')).toBe(false);
    expect(parent.appendChild).toHaveBeenCalledWith(child);
    expect(responses[0].result).toEqual({ success: true });
  });

  it('passes an authorized open-url launch target to the browser webview proxy', () => {
    vi.stubGlobal('window', { location: { origin: 'https://novabyte.test' } });
    vi.stubGlobal('AppPermissionManager', {
      isGranted: vi.fn(permission => permission === 'sandbox:nested-webview' || permission === 'net:external'),
    });

    try {
      const html = AppSandbox._internal.injectCapabilityShim(
        '<!doctype html><html><body></body></html>',
        {
          id: 'com.example.browser',
          allowNestedWebview: true,
          permissions: ['sandbox:nested-webview', 'net:external'],
        },
        { url: 'https://www.google.com/search?q=nova' }
      );
      expect(html).toContain('let __NOVA_PENDING_INITIAL_URL__ = "https://www.google.com/search?q=nova";');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('defers packaged app scripts until parsing completes without requiring DOMContentLoaded guards', () => {
    const html = AppSandbox._internal.injectCapabilityShim(
      '<!doctype html><!-- <script src="comment.js"></script> --><html><head><script src="app.js"></script><script src="async.js" async></script><script type="module" src="module.js"></script><script>inline()</script></head><body><button id="pad"></button></body></html>',
      { id: 'com.example.app', permissions: [] }
    );

    expect(html).toContain('<script src="app.js" defer>');
    expect(html).toContain('<script src="async.js" defer>');
    expect(html).toContain('<script type="module" src="module.js" defer>');
    expect(html).toContain('<!-- <script src="comment.js"></script> -->');
    expect(html).toContain('<script>inline()</script>');
    expect(html).toContain('<button id="pad"></button>');
  });

  it('blocks direct nested-webview navigation unless the app has matching network permission', async () => {
    const responses = [];
    const child = { setAttribute: vi.fn(), removeAttribute: vi.fn() };
    vi.stubGlobal('window', { location: { origin: 'https://novabyte.test' } });
    vi.stubGlobal('AppPermissionManager', {
      isGranted: vi.fn(permission => permission === 'sandbox:nested-webview'),
    });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:nested-webview',
        { action: 'attribute', id: 'nvw_network', name: 'src', value: 'https://www.google.com/' },
        'nested-network-denied',
        { id: 'third-party.app', manifest: { permissions: ['sandbox:nested-webview'] } },
        { __directResponder: message => responses.push(message) },
        {
          nestedWebviewOptedIn: true,
          nestedWebviews: new Map([['nvw_network', { view: child }]]),
        }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(child.setAttribute).not.toHaveBeenCalled();
    expect(responses[0].error.code).toBe('PERMISSION_DENIED');
  });

  it('exposes host-validated history and page-find operations for nested browsers', async () => {
    const responses = [];
    const child = {
      canGoBack: vi.fn(() => true),
      canGoForward: vi.fn(() => false),
      find: vi.fn((_query, _options, callback) => callback({ activeMatchOrdinal: 1, numberOfMatches: 3 })),
    };
    const webview = { __directResponder: message => responses.push(message) };
    const sandbox = {
      nestedWebviewOptedIn: true,
      nestedWebviews: new Map([['nvw_api', { view: child }]]),
    };
    vi.stubGlobal('AppPermissionManager', { isGranted: vi.fn(() => true) });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:nested-webview',
        { action: 'command', id: 'nvw_api', command: 'canGoBack' },
        'browser-can-go-back',
        { id: 'com.example.browser' },
        webview,
        sandbox
      );
      expect(responses.at(-1).result).toEqual({ value: true });

      await AppSandbox._internal.handleAPICall(
        'nova:nested-webview',
        {
          action: 'command', id: 'nvw_api', command: 'find',
          query: 'Nova', options: { matchCase: false, backward: true },
        },
        'browser-find',
        { id: 'com.example.browser' },
        webview,
        sandbox
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(child.find).toHaveBeenCalledWith('Nova', { matchCase: false, backward: true }, expect.any(Function));
    expect(responses.at(-1).result).toEqual({ activeMatchOrdinal: 1, numberOfMatches: 3 });
  });

  it('opens a user-picked file without a filesystem permission and grants scoped access', async () => {
    const responses = [];
    const pickedNode = {
      id: 'picked-file',
      name: 'notes.txt',
      type: 'file',
      content: 'selected text',
      mimeType: 'text/plain',
    };
    const privateNode = { id: 'private-file', name: 'private.txt', type: 'file' };
    const paths = new Map([
      ['picked-file', '/Documents/notes.txt'],
      ['private-file', '/data/another.app/private.txt'],
    ]);
    const open = vi.fn(async options => {
      expect(options.canAccess(pickedNode)).toBe(true);
      expect(options.canAccess(privateNode)).toBe(false);
      return pickedNode;
    });
    vi.stubGlobal('window', {
      SystemDialogs: {
        open,
      },
    });
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('FS', {
      rootId: 'root',
      files: new Map([
        ['picked-file', { ...pickedNode, size: 'selected text'.length }],
        ['private-file', privateNode],
      ]),
      getPath: vi.fn(id => paths.get(id)),
    });

    const sandbox = {};
    try {
      await AppSandbox._internal.handleAPICall(
        'nova:files:open',
        { accept: ['text/plain'] },
        'scoped-file-open',
        { id: 'com.example.app' },
        { __directResponder: message => responses.push(message) },
        sandbox
      );
      await AppSandbox._internal.handleAPICall(
        'nova:fs:read',
        { id: 'picked-file' },
        'picked-file-read',
        { id: 'com.example.app' },
        { __directResponder: message => responses.push(message) },
        sandbox
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(responses[0].result.file).toMatchObject({
      name: 'notes.txt',
      path: '/Documents/notes.txt',
      content: 'selected text',
      size: 'selected text'.length,
      id: 'picked-file',
    });
    expect(responses[1].result.data).toBe('selected text');
    expect(open).toHaveBeenCalledOnce();
  });

  it('saves content only to the destination chosen in the filesystem picker', async () => {
    const responses = [];
    const writeFile = vi.fn(async () => ({
      id: 'existing-file',
      name: 'notes.txt',
      mimeType: 'text/plain',
    }));
    vi.stubGlobal('window', {
      confirm: vi.fn(() => true),
      SystemDialogs: {
        save: vi.fn(async () => ({ folderId: 'documents', name: 'notes.txt' })),
      },
    });
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('FS', {
      files: new Map([
        ['documents', { id: 'documents', type: 'folder' }],
        ['existing-file', { id: 'existing-file', type: 'file', name: 'notes.txt' }],
      ]),
      listDir: vi.fn(() => [{ id: 'existing-file', name: 'notes.txt', type: 'file' }]),
      writeFile,
      createFile: vi.fn(),
      getPath: vi.fn(id => id === 'documents' ? '/Documents' : '/Documents/notes.txt'),
    });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:files:save',
        { filename: 'suggested.txt', content: 'exported text' },
        'scoped-file-save',
        { id: 'com.example.app' },
        { __directResponder: message => responses.push(message) },
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(writeFile).toHaveBeenCalledWith('existing-file', 'exported text', 'text/plain');
    expect(responses[0].result.file).toMatchObject({
      name: 'notes.txt',
      path: '/Documents/notes.txt',
      size: 'exported text'.length,
    });
  });

  it('allows permission-free access to app-owned files', async () => {
    const responses = [];
    const ownFile = { id: 'own-note', name: 'note.txt', type: 'file', content: 'before' };
    const pathMap = new Map([
      ['root', '/home/user'],
      ['own-note', '/home/user/data/editor_app/note.txt'],
    ]);
    const writeFile = vi.fn(async (id, content) => {
      ownFile.content = content;
      return ownFile;
    });
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('FS', {
      rootId: 'root',
      files: new Map([['own-note', ownFile]]),
      getPath: id => pathMap.get(id),
      getByPath: path => path === '/data/editor_app/note.txt' ? ownFile : null,
      writeFile,
    });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      await AppSandbox._internal.handleAPICall(
        'nova:fs:read',
        { id: 'own-note' },
        'own-file-read',
        { id: 'editor_app' },
        webview,
        {}
      );
      await AppSandbox._internal.handleAPICall(
        'nova:fs:write',
        { path: '/data/note.txt', content: 'after' },
        'own-file-write',
        { id: 'editor_app' },
        webview,
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(responses[0].result.data).toBe('before');
    expect(responses[1].result.success).toBe(true);
    expect(writeFile).toHaveBeenCalledWith('own-note', 'after');
  });

  it('limits shared-media reads to the matching media permission', async () => {
    const responses = [];
    const image = { id: 'image', name: 'photo.png', type: 'file', content: 'image', mimeType: 'image/png' };
    const audio = { id: 'audio', name: 'song.mp3', type: 'file', content: 'audio', mimeType: 'audio/mpeg' };
    const document = { id: 'document', name: 'report.pdf', type: 'file', content: 'document', mimeType: 'application/pdf' };
    const pathMap = new Map([
      ['root', '/'],
      ['image', '/Pictures/photo.png'],
      ['audio', '/Music/song.mp3'],
      ['document', '/Documents/report.pdf'],
    ]);
    vi.stubGlobal('AppPermissionManager', {
      isGranted: permission => permission === 'fs:read:images',
    });
    vi.stubGlobal('FS', {
      rootId: 'root',
      files: new Map([['image', image], ['audio', audio], ['document', document]]),
      getPath: id => pathMap.get(id),
    });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      for (const id of ['image', 'audio', 'document']) {
        await AppSandbox._internal.handleAPICall(
          'nova:fs:read',
          { id },
          `read-${id}`,
          { id: 'media_app' },
          webview,
          {}
        );
      }
    } finally {
      vi.unstubAllGlobals();
    }

    expect(responses[0].result.data).toBe('image');
    expect(responses[1].error.code).toBe('PERMISSION_DENIED');
    expect(responses[2].error.code).toBe('PERMISSION_DENIED');
  });

  it('requires user confirmation before deleting a picker-selected shared file', async () => {
    const responses = [];
    const selected = { id: 'shared-note', name: 'note.txt', type: 'file' };
    const deleteToTrash = vi.fn();
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('window', { confirm });
    vi.stubGlobal('FS', {
      rootId: 'root',
      specialFolders: { trash: 'trash' },
      files: new Map([['shared-note', selected]]),
      getPath: id => id === 'root' ? '/' : '/Documents/note.txt',
      deleteToTrash,
    });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      const sandbox = { pickedFileIds: new Set(['shared-note']) };
      for (let i = 0; i < 2; i++) {
        await AppSandbox._internal.handleAPICall(
          'nova:fs:delete',
          { id: 'shared-note' },
          `delete-shared-${i}`,
          { id: 'reader_app', name: 'Reader' },
          webview,
          sandbox
        );
      }
    } finally {
      vi.unstubAllGlobals();
    }

    expect(responses[0].result.cancelled).toBe(true);
    expect(responses[1].result.success).toBe(true);
    expect(deleteToTrash).toHaveBeenCalledOnce();
  });

  it('lets fs:access edit shared files but not another app private data', async () => {
    const responses = [];
    const sharedFile = { id: 'shared-note', name: 'note.txt', type: 'file', content: 'before' };
    const privateFile = { id: 'private-note', name: 'private.txt', type: 'file', content: 'private' };
    const trashedPrivateFile = {
      id: 'trashed-private-note', name: 'private.txt', type: 'file', content: 'private',
      parentId: 'trash', _originalParent: 'other-app-data',
    };
    const trashedOwnFile = {
      id: 'trashed-own-note', name: 'own.txt', type: 'file', content: 'own data',
      parentId: 'trash', _originalParent: 'own-app-data',
    };
    const legacyTrashedFile = {
      id: 'legacy-trashed-note', name: 'legacy.txt', type: 'file', content: 'unknown owner',
      parentId: 'trash',
    };
    const paths = new Map([
      ['shared-note', '/Documents/note.txt'],
      ['private-note', '/data/another.app/private.txt'],
      ['trashed-private-note', '/Trash/private.txt'],
      ['trashed-own-note', '/Trash/own.txt'],
      ['legacy-trashed-note', '/Trash/legacy.txt'],
      ['trash', '/Trash'],
      ['other-app-data', '/data/another.app'],
      ['own-app-data', '/data/editor_app'],
    ]);
    const files = new Map([[sharedFile.id, sharedFile], [privateFile.id, privateFile]]);
    const writeFile = vi.fn(async (_id, content) => { sharedFile.content = content; });
    vi.stubGlobal('AppPermissionManager', { isGranted: permission => permission === 'fs:access' });
    vi.stubGlobal('FS', {
      files,
      specialFolders: { trash: 'trash' },
      getByPath: vi.fn(path => path === '/Documents/note.txt' ? sharedFile : null),
      getPath: vi.fn(id => paths.get(id)),
      writeFile,
    });
    files.set(trashedPrivateFile.id, trashedPrivateFile);
    files.set(trashedOwnFile.id, trashedOwnFile);
    files.set(legacyTrashedFile.id, legacyTrashedFile);
    files.set('trash', { id: 'trash', name: 'Trash', type: 'folder' });
    files.set('other-app-data', { id: 'other-app-data', name: 'another.app', type: 'folder' });
    files.set('own-app-data', { id: 'own-app-data', name: 'editor_app', type: 'folder' });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      await AppSandbox._internal.handleAPICall(
        'nova:fs:write',
        { path: '/Documents/note.txt', content: 'edited' },
        'shared-file-edit',
        { id: 'editor.app' },
        webview,
        {}
      );
      await AppSandbox._internal.handleAPICall(
        'nova:fs:read',
        { id: 'private-note' },
        'private-file-read',
        { id: 'editor.app' },
        webview,
        {}
      );
      await AppSandbox._internal.handleAPICall(
        'nova:fs:read',
        { id: 'trashed-private-note' },
        'trashed-private-file-read',
        { id: 'editor.app' },
        webview,
        {}
      );
      await AppSandbox._internal.handleAPICall(
        'nova:fs:read',
        { id: 'trashed-own-note' },
        'trashed-own-file-read',
        { id: 'editor.app' },
        webview,
        {}
      );
      await AppSandbox._internal.handleAPICall(
        'nova:fs:read',
        { id: 'legacy-trashed-note' },
        'legacy-trashed-file-read',
        { id: 'editor.app' },
        webview,
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(writeFile).toHaveBeenCalledWith('shared-note', 'edited');
    expect(responses[0].result.success).toBe(true);
    expect(responses[1].error.code).toBe('NOT_FOUND');
    expect(responses[2].error.code).toBe('NOT_FOUND');
    expect(responses[3].result.data).toBe('own data');
    expect(responses[4].error.code).toBe('NOT_FOUND');
  });

  it('prevents permissionless apps from deleting filesystem roots', async () => {
    const responses = [];
    const deleteToTrash = vi.fn();
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('FS', {
      rootId: 'root',
      specialFolders: { trash: 'trash' },
      files: new Map([['root', { id: 'root', type: 'folder' }]]),
      getPath: vi.fn(() => '/'),
      deleteToTrash,
      permanentDelete: vi.fn(),
    });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:fs:delete',
        { id: 'root' },
        'delete-root',
        { id: 'editor.app' },
        { __directResponder: message => responses.push(message) },
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(deleteToTrash).not.toHaveBeenCalled();
    expect(responses[0].error.code).toBe('PROTECTED_LOCATION');
  });

  it('allows user-picked shared save folders without a broad filesystem grant', async () => {
    const responses = [];
    const sharedFolder = { id: 'documents', name: 'Documents', type: 'folder' };
    const ownFolder = { id: 'own-data', name: 'editor_app', type: 'folder' };
    const foreignFolder = { id: 'foreign-data', name: 'other.app', type: 'folder' };
    const paths = new Map([
      ['documents', '/Documents'],
      ['own-data', '/data/editor_app'],
      ['foreign-data', '/data/other.app'],
      ['root', '/'],
      ['data', '/data'],
    ]);
    const save = vi.fn(async options => {
      expect(options.canAccess(sharedFolder)).toBe(true);
      expect(options.canAccess(ownFolder)).toBe(true);
      expect(options.canAccess(foreignFolder)).toBe(false);
      return { folderId: 'documents', name: 'notes.txt' };
    });
    const createFile = vi.fn(async () => ({ id: 'saved-note', name: 'notes.txt' }));
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('window', { SystemDialogs: { save } });
    vi.stubGlobal('FS', {
      rootId: 'root',
      specialFolders: {},
      files: new Map([
        ['documents', sharedFolder],
        ['own-data', ownFolder],
        ['foreign-data', foreignFolder],
        ['root', { id: 'root', type: 'folder' }],
        ['data', { id: 'data', type: 'folder' }],
      ]),
      getPath: vi.fn(id => paths.get(id)),
      listDir: vi.fn(() => []),
      createFile,
    });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:sysdialog:save',
        { suggestedName: 'notes.txt', content: 'hello' },
        'picked-shared-save',
        { id: 'editor.app' },
        { __directResponder: message => responses.push(message) },
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(createFile).toHaveBeenCalledWith('documents', 'notes.txt', 'hello', 'text/plain');
    expect(responses[0].result.success).toBe(true);
  });

  it('allows validated appearance changes without system:settings', async () => {
    const responses = [];
    const values = new Map([['theme', 'nova-dark']]);
    vi.stubGlobal('OS', {
      settings: {
        get: key => values.get(key),
        set: vi.fn((key, value) => { values.set(key, value); return true; }),
      },
    });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      await AppSandbox._internal.handleAPICall(
        'nova:appearance:set',
        { appearance: { theme: 'nord', highContrast: true, transparentSurfaces: false } },
        'appearance-set-valid',
        { id: 'theme.app' },
        webview,
        {}
      );
      await AppSandbox._internal.handleAPICall(
        'nova:appearance:set',
        { appearance: { username: 'changed' } },
        'appearance-set-invalid',
        { id: 'theme.app' },
        webview,
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(values.get('theme')).toBe('nord');
    expect(values.get('removeTransparency')).toBe(true);
    expect(responses[0].result.appearance.highContrast).toBe(true);
    expect(responses[1].error.code).toBe('INVALID_ARGS');
  });

  it('renders sandbox app context menus in the host layer and returns the selected item', async () => {
    const responses = [];
    let dismissMenu;
    const show = vi.fn((_x, _y, _items, onDismiss) => {
      dismissMenu = onDismiss;
      return { id: 'host-menu' };
    });
    vi.stubGlobal('AppPermissionManager', {
      isGranted: permission => permission === 'sandbox:nested-webview',
    });
    vi.stubGlobal('window', { ContextMenu: { show, hide: vi.fn() } });

    try {
      const request = AppSandbox._internal.handleAPICall(
        'nova:context-menu:show',
        {
          x: 24,
          y: 38,
          items: [
            { label: 'Open', icon: 'folder' },
            { separator: true },
            { label: 'Delete', danger: true },
          ],
        },
        'context-menu-select',
        { id: 'third-party.app' },
        {
          getBoundingClientRect: () => ({ left: 100, top: 50 }),
          __directResponder: message => responses.push(message),
        },
        {}
      );
      dismissMenu(2);
      await request;
    } finally {
      vi.unstubAllGlobals();
    }

    expect(show).toHaveBeenCalledWith(
      124,
      88,
      [
        { label: 'Open', icon: 'folder', shortcut: undefined, disabled: false, danger: false, _selectionIndex: 0 },
        { separator: true },
        { label: 'Delete', icon: undefined, shortcut: undefined, disabled: false, danger: true, _selectionIndex: 2 },
      ],
      expect.any(Function)
    );
    expect(responses[0].result).toEqual({ cancelled: false, index: 2 });
  });

  it('resolves a pending context-menu request when a newer menu replaces it', async () => {
    const dismissers = new Map();
    const menus = [];
    const responses = [];
    let nextMenuId = 0;
    vi.stubGlobal('AppPermissionManager', {
      isGranted: permission => permission === 'sandbox:nested-webview',
    });
    vi.stubGlobal('window', {
      ContextMenu: {
        show: vi.fn((_x, _y, _items, onDismiss) => {
          const menu = { id: ++nextMenuId };
          menus.push(menu);
          dismissers.set(menu, onDismiss);
          return menu;
        }),
        hide: vi.fn(menu => dismissers.get(menu)?.(null)),
      },
    });

    const sandbox = {};
    const app = { id: 'third-party.app', manifest: { permissions: ['sandbox:nested-webview'] } };
    const webview = {
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      __directResponder: message => responses.push(message),
    };
    try {
      const firstRequest = AppSandbox._internal.handleAPICall(
        'nova:context-menu:show',
        { x: 1, y: 2, items: [{ label: 'First' }] },
        'context-menu-first',
        app,
        webview,
        sandbox
      );
      const secondRequest = AppSandbox._internal.handleAPICall(
        'nova:context-menu:show',
        { x: 3, y: 4, items: [{ label: 'Second' }] },
        'context-menu-second',
        app,
        webview,
        sandbox
      );

      await firstRequest;
      expect(responses[0].result).toEqual({ cancelled: true, index: null });
      expect(sandbox.contextMenuCleanup).toBeTypeOf('function');

      dismissers.get(menus[1])?.(null);
      await secondRequest;
      expect(responses[1].result).toEqual({ cancelled: true, index: null });
      expect(sandbox.contextMenuCleanup).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cancels a host-rendered context menu when the sandbox closes', async () => {
    let dismissMenu;
    const hide = vi.fn((_menu) => dismissMenu(null));
    const sandbox = {};
    vi.stubGlobal('AppPermissionManager', {
      isGranted: permission => permission === 'sandbox:nested-webview',
    });
    vi.stubGlobal('window', {
      ContextMenu: {
        show: vi.fn((_x, _y, _items, onDismiss) => {
          dismissMenu = onDismiss;
          return { id: 'host-menu' };
        }),
        hide,
      },
    });

    const request = AppSandbox._internal.handleAPICall(
      'nova:context-menu:show',
      { x: 1, y: 2, items: [{ label: 'Open' }] },
      'context-menu-cancel',
      { id: 'third-party.app' },
      { getBoundingClientRect: () => ({ left: 0, top: 0 }), __directResponder: vi.fn() },
      sandbox
    );
    try {
      AppSandbox._internal.cleanupSandboxRecord(sandbox);
      await request;
      expect(hide).toHaveBeenCalledOnce();
      expect(sandbox.contextMenuCleanup).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders sanitized app overlays above browser views and forwards marked interactions', async () => {
    const responses = [];
    const documentListeners = new Map();
    const frameListeners = new Map();
    const overlayDocument = {
      body: { innerHTML: '' },
      head: { appendChild: vi.fn() },
      createElement: vi.fn(() => ({ textContent: '' })),
      addEventListener: (type, listener) => documentListeners.set(type, listener),
      removeEventListener: vi.fn(),
    };
    const frame = {
      style: {},
      contentDocument: overlayDocument,
      isConnected: false,
      setAttribute: vi.fn(),
      addEventListener: (type, listener) => frameListeners.set(type, listener),
      remove: vi.fn(function() { this.isConnected = false; }),
    };
    const sanitize = vi.fn(html => `sanitized:${html}`);
    const hostWindow = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const appWindow = {
      isConnected: true,
      appendChild: vi.fn(element => {
        element.isConnected = true;
        frameListeners.get('load')();
      }),
      getBoundingClientRect: () => ({ left: 30, top: 40 }),
    };
    vi.stubGlobal('AppPermissionManager', {
      isGranted: permission => permission === 'sandbox:nested-webview',
    });
    vi.stubGlobal('DOMPurify', { sanitize });
    vi.stubGlobal('window', hostWindow);
    vi.stubGlobal('document', {
      createElement: vi.fn(() => frame),
      body: { appendChild: vi.fn() },
    });

    const sandbox = { state: { element: appWindow } };
    const webview = {
      clientWidth: 320,
      clientHeight: 200,
      getBoundingClientRect: () => ({ left: 40, top: 60, width: 320, height: 200 }),
      __directResponder: message => responses.push(message),
    };
    try {
      await AppSandbox._internal.handleAPICall(
        'nova:overlay:show',
        {
          html: '<button data-nova-action="dismiss">Close</button>',
          css: '.panel { color: white; }',
          bounds: { left: 10, top: 20, width: 120, height: 80 },
        },
        'overlay-show',
        { id: 'third-party.app', name: 'Third Party', manifest: { permissions: ['sandbox:nested-webview'] } },
        webview,
        sandbox
      );

      expect(sanitize).toHaveBeenCalledWith(
        '<button data-nova-action="dismiss">Close</button>',
        expect.objectContaining({ FORBID_TAGS: expect.arrayContaining(['script', 'iframe']) })
      );
      expect(frame.setAttribute).toHaveBeenCalledWith('sandbox', 'allow-same-origin');
      expect(frame.srcdoc).toContain("script-src 'none'");
      expect(frame.style.position).toBe('absolute');
      expect(frame.style.left).toBe('20px');
      expect(frame.style.top).toBe('40px');
      expect(frame.style.width).toBe('120px');
      expect(frame.style.height).toBe('80px');
      expect(appWindow.appendChild).toHaveBeenCalledOnce();
      expect(document.body.appendChild).not.toHaveBeenCalled();
      expect(overlayDocument.body.innerHTML).toBe('sanitized:<button data-nova-action="dismiss">Close</button>');
      expect(overlayDocument.head.appendChild.mock.calls[0][0].textContent).toBe('.panel { color: white; }');
      expect(responses[0].result.success).toBe(true);

      const eventTarget = {
        nodeType: 1,
        value: '',
        checked: false,
        closest: selector => selector === 'a' ? null : eventTarget,
        getAttribute: name => name === 'data-nova-action' ? 'dismiss' : null,
      };
      documentListeners.get('click')({
        type: 'click',
        target: eventTarget,
        preventDefault: vi.fn(),
      });
      expect(responses[1].type).toBe('nova:overlay:event:response');
      expect(responses[1].result).toMatchObject({ type: 'click', action: 'dismiss', field: null });

      await AppSandbox._internal.handleAPICall(
        'nova:overlay:hide',
        {},
        'overlay-hide',
        { id: 'third-party.app' },
        webview,
        sandbox
      );
      expect(frame.remove).toHaveBeenCalledOnce();
      expect(sandbox.overlayCleanup).toBeNull();
      expect(responses[2].result).toMatchObject({ success: true, wasOpen: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('allows low-risk app launch and rate-limits repeated launches', async () => {
    const responses = [];
    const createWindow = vi.fn(() => ({ id: 'target-window' }));
    vi.stubGlobal('AppPermissionManager', {
      isGranted: permission => permission === 'system:app-launch',
    });
    vi.stubGlobal('OS', { apps: {}, settings: { get: () => false } });
    vi.stubGlobal('WM', { createWindow });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      for (let i = 0; i < 7; i++) {
        await AppSandbox._internal.handleAPICall(
          'nova:app:launch',
          { appId: 'target-app' },
          `app-launch-${i}`,
          { id: 'launcher.app' },
          webview,
          {}
        );
      }
    } finally {
      vi.unstubAllGlobals();
    }

    expect(createWindow).toHaveBeenCalledTimes(6);
    expect(responses.slice(0, 6).every(response => response.result.success)).toBe(true);
    expect(responses[6].error.code).toBe('RATE_LIMITED');
  });

  it('allows benign system events without system:events but protects app inventory events', async () => {
    const responses = [];
    const on = vi.fn();
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('OS', { events: { on, off: vi.fn() } });

    try {
      const webview = {
        dataset: { sandboxId: 'theme-sandbox' },
        __directResponder: message => responses.push(message),
      };
      await AppSandbox._internal.handleAPICall(
        'nova:events:subscribe',
        { event: 'system:themeChanged' },
        'safe-event',
        { id: 'theme.app' },
        webview,
        {}
      );
      await AppSandbox._internal.handleAPICall(
        'nova:events:subscribe',
        { event: 'app:launched' },
        'sensitive-event',
        { id: 'theme.app' },
        webview,
        {}
      );
    } finally {
      vi.unstubAllGlobals();
      AppSandbox._internal._eventSubscriptions.delete('theme-sandbox');
    }

    expect(on).toHaveBeenCalledWith('system:themeChanged', expect.any(Function));
    expect(responses[0].result.subscribed).toBe('system:themeChanged');
    expect(responses[1].error.code).toBe('PERMISSION_DENIED');
  });

  it('guards only cancellable top-level navigation, not post-commit or subframe loads', async () => {
    const eventListeners = new Map();
    const child = {
      style: {},
      setAttribute: vi.fn(),
      addEventListener: vi.fn((name, callback) => eventListeners.set(name, callback)),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    };
    const parent = { isConnected: true, style: {}, appendChild: vi.fn() };
    vi.stubGlobal('document', { createElement: vi.fn(() => child) });
    vi.stubGlobal('window', { location: { origin: 'https://novabyte.test' } });
    vi.stubGlobal('AppPermissionManager', {
      isGranted: vi.fn(permission => permission === 'sandbox:nested-webview'),
    });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:nested-webview',
        { action: 'create', id: 'nvw_navigation' },
        'nested-navigation-create',
        { id: 'third-party.app' },
        { getAttribute: () => null, __directResponder: vi.fn() },
        { nestedWebviewOptedIn: true, nestedWebviews: new Map(), state: { content: parent } }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(eventListeners.has('loadcommit')).toBe(true);
    eventListeners.get('loadcommit')({
      isTopLevel: true,
      url: 'https://www.google.com/search?q=test',
    });
    expect(child.stop).not.toHaveBeenCalled();

    const preventDefault = vi.fn();
    eventListeners.get('will-navigate')({
      isTopLevel: true,
      url: 'https://www.google.com/search?q=test',
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(child.stop).not.toHaveBeenCalled();

    const subframePreventDefault = vi.fn();
    eventListeners.get('will-navigate')({
      isTopLevel: false,
      url: 'https://accounts.google.com/',
      preventDefault: subframePreventDefault,
    });
    expect(subframePreventDefault).not.toHaveBeenCalled();
  });

  it('clears both app and nested-site partitions for explicit app data removal', async () => {
    const partitions = [];
    const childViews = [];
    vi.stubGlobal('window', { location: { origin: 'https://novabyte.test' } });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ baseUrl: '/api/apps/serve/sandbox-clear' }),
    })));
    vi.stubGlobal('document', {
      createElement: vi.fn(() => {
        let src = '';
        const listeners = new Map();
        const view = {
          style: {},
          setAttribute: (name, value) => {
            if (name === 'partition') partitions.push(value);
          },
          addEventListener: (name, callback) => listeners.set(name, callback),
          remove: vi.fn(),
          clearData: vi.fn((_options, _types, callback) => callback()),
          set src(value) {
            src = value;
            if (src) queueMicrotask(() => listeners.get('loadstop')?.());
          },
          get src() { return src; },
        };
        childViews.push(view);
        return view;
      }),
      body: { appendChild: vi.fn() },
    });

    try {
      await AppSandbox.clearAppPartition('com.example.browser');
    } finally {
      vi.unstubAllGlobals();
    }

    expect(partitions).toEqual([
      'persist:app_com.example.browser',
      'persist:app_com.example.browser_webcontent',
    ]);
    expect(childViews).toHaveLength(2);
    expect(childViews.every(view => view.clearData.mock.calls.length === 1)).toBe(true);
  });

  it('honors nested-webview manifest opt-in or permission declaration while requiring the grant', () => {
    vi.stubGlobal('AppPermissionManager', { isGranted: vi.fn(() => true) });
    try {
      expect(AppSandbox._internal.isNestedWebviewPermitted({
        id: 'third-party.app',
        manifest: { allowNestedWebview: true },
      })).toBe(true);
      expect(AppSandbox._internal.isNestedWebviewPermitted({
        id: 'third-party.browser',
        manifest: { permissions: ['net:external', 'sandbox:nested-webview'] },
      })).toBe(true);
      expect(AppSandbox._internal.injectCapabilityShim(
        '<!doctype html><html></html>',
        {
          id: 'third-party.browser',
          manifest: { permissions: ['sandbox:nested-webview'] },
        }
      )).toContain('const __NOVA_NESTED_WEBVIEW_OPTED_IN__ = true;');
      expect(AppSandbox._internal.isNestedWebviewPermitted({
        id: 'third-party.app',
        manifest: { allowNestedWebview: false },
      })).toBe(false);

      AppPermissionManager.isGranted.mockReturnValue(false);
      expect(AppSandbox._internal.isNestedWebviewPermitted({
        id: 'third-party.app',
        manifest: { allowNestedWebview: true },
      })).toBe(false);
      expect(AppSandbox._internal.isNestedWebviewPermitted({
        id: 'third-party.browser',
        manifest: { permissions: ['sandbox:nested-webview'] },
      })).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('provides a wallpaper IPC route without exposing OS to the app', async () => {
    const responses = [];
    const set = vi.fn(() => true);
    vi.stubGlobal('OS', { settings: { set } });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:wallpaper:set',
        { key: 'wallpaperId', value: 'stock-blue' },
        'wallpaper-test',
        { id: 'third-party.app' },
        { __directResponder: message => responses.push(message) }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    const shim = AppSandbox._internal.buildCapabilityShim(false);
    expect(AppSandbox._internal.API_HANDLERS['nova:wallpaper:set']).toBeTypeOf('function');
    expect(shim).toContain("ipc('nova:wallpaper:set'");
    expect(set).toHaveBeenCalledWith('wallpaperId', 'stock-blue');
    expect(responses[0].type).toBe('nova:wallpaper:set:response');
    expect(responses[0].result).toEqual({ success: true });
  });

  it('reports the wallpaper policy block to sandboxed callers', async () => {
    const responses = [];
    const set = vi.fn(() => false);
    vi.stubGlobal('OS', { settings: { set } });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:wallpaper:set',
        { key: 'customWallpaper', value: 'data:image/png;base64,abc' },
        'wallpaper-locked-test',
        { id: 'third-party.app' },
        { __directResponder: message => responses.push(message) }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(set).toHaveBeenCalledWith('customWallpaper', 'data:image/png;base64,abc');
    expect(responses[0].error.code).toBe('POLICY_BLOCKED');
  });

  it('opens validated HTTP(S) URLs using the OS default browser app', async () => {
    const responses = [];
    const openUrl = vi.fn(() => ({ id: 'window-1' }));
    vi.stubGlobal('OS', { openUrl });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:open-url',
        { url: 'https://example.com/path?q=hello' },
        'open-url-test',
        { id: 'third-party.app' },
        { __directResponder: message => responses.push(message) }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(openUrl).toHaveBeenCalledWith('https://example.com/path?q=hello');
    expect(responses[0].result).toEqual({ success: true, windowId: 'window-1' });
  });

  it('rejects non-HTTP(S) URLs from nova:open-url', async () => {
    const responses = [];
    const openUrl = vi.fn();
    vi.stubGlobal('OS', { openUrl });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:open-url',
        { url: 'javascript:alert(1)' },
        'open-url-invalid-test',
        { id: 'third-party.app' },
        { __directResponder: message => responses.push(message) }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(openUrl).not.toHaveBeenCalled();
    expect(responses[0].error.code).toBe('INVALID_ARGS');
  });

  it('preserves proxied image bytes for apps calling fetch().blob()', async () => {
    const responses = [];
    const binaryBody = 'iVBORw0KGgo=';
    vi.stubGlobal('AppPermissionManager', { isGranted: () => true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'image/png' },
      body: binaryBody,
      bodyEncoding: 'base64',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:net:fetch',
        { url: 'https://images.example/image.png' },
        'binary-fetch-test',
        { id: 'third-party.app' },
        { __directResponder: message => responses.push(message) }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    const shim = AppSandbox._internal.buildCapabilityShim(false);
    expect(responses[0].result).toMatchObject({ body: binaryBody, bodyEncoding: 'base64' });
    expect(shim).toContain("res.bodyEncoding === 'base64'");
    expect(shim).toContain('new Response(responseBody, responseInit)');
  });

  it('updates an existing file selected in the system Save dialog', async () => {
    const existing = { id: 'file-1', name: 'notes.txt', type: 'file' };
    const responses = [];
    const writeFile = vi.fn(async () => existing);
    const createFile = vi.fn();
    vi.stubGlobal('AppPermissionManager', { isGranted: () => true });
    vi.stubGlobal('window', {
      SystemDialogs: { save: async () => ({ folderId: 'documents', name: 'notes.txt' }) },
    });
    vi.stubGlobal('FS', {
      rootId: 'root',
      files: new Map([
        ['root', { id: 'root', type: 'folder' }],
        ['documents', { id: 'documents', type: 'folder' }],
        [existing.id, existing],
      ]),
      listDir: () => [existing],
      writeFile,
      createFile,
      getPath: id => id === 'root' ? '/' : id === 'documents' ? '/Documents' : '/Documents/notes.txt',
    });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:sysdialog:save',
        { content: 'updated text', mimeType: 'text/plain' },
        'save-test',
        { id: 'com.nbosp.textedit' },
        { __directResponder: message => responses.push(message) }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(writeFile).toHaveBeenCalledWith('file-1', 'updated text', 'text/plain');
    expect(createFile).not.toHaveBeenCalled();
    expect(responses[0].result.file.path).toBe('/Documents/notes.txt');
  });

  it('saves Base64 image data URLs as filesystem binary content with the right MIME type', async () => {
    const responses = [];
    const folder = { id: 'app-data', type: 'folder' };
    const createFile = vi.fn(async (folderId, name, content, mimeType) => ({
      id: 'saved-image',
      name,
      content,
      mimeType,
    }));
    vi.stubGlobal('AppPermissionManager', {
      isGranted: () => false,
    });
    vi.stubGlobal('window', {
      SystemDialogs: { save: async () => ({ folderId: folder.id, name: 'wallhaven.jpg' }) },
    });
    vi.stubGlobal('FS', {
      rootId: 'root',
      files: new Map([[folder.id, folder]]),
      getPath: id => id === folder.id ? '/data/example_app' : '/data/example_app/wallhaven.jpg',
      listDir: () => [],
      createFile,
    });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:sysdialog:save',
        {
          suggestedName: 'wallhaven.jpg',
          content: 'data:image/jpeg;base64,/9j/2Q==',
          mimeType: 'text/plain',
        },
        'save-jpeg-test',
        { id: 'example.app' },
        { __directResponder: message => responses.push(message) },
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(createFile).toHaveBeenCalledWith(folder.id, 'wallhaven.jpg', '/9j/2Q==', 'image/jpeg');
    expect(responses[0].result.file.name).toBe('wallhaven.jpg');
  });

  it('infers image MIME types from file extensions for raw Base64 content', () => {
    expect(AppSandbox._internal.normalizeFsSavePayload({
      content: '/9j/2Q==',
    }, 'wallhaven.jpg')).toEqual({
      content: '/9j/2Q==',
      mimeType: 'image/jpeg',
    });
  });

  it('blocks system-only Settings and Clock IPC before any handler side effect', async () => {
    const responses = [];
    const forbidden = [...AppSandbox._internal.GUEST_FORBIDDEN_IPC_APIS];
    const grantPermission = vi.fn();
    const saveItem = vi.fn();
    vi.stubGlobal('AppPermissionManager', {
      isGranted: () => true,
      grantPermission,
      revokePermission: vi.fn(),
      resetPermission: vi.fn(),
    });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: saveItem, removeItem: vi.fn() });

    try {
      for (let i = 0; i < forbidden.length; i++) {
        const api = forbidden[i];
        expect(AppSandbox._internal.API_HANDLERS[api]).toBeUndefined();
        await AppSandbox._internal.handleAPICall(
          api,
          { appId: 'com.victim.other-app', permission: 'system:root', granted: true, mode: 'factory-reset' },
          'forbidden-' + i,
          { id: 'third-party.malicious' },
          { __directResponder: message => responses.push(message) },
          {}
        );
      }
    } finally {
      vi.unstubAllGlobals();
    }

    expect(responses).toHaveLength(forbidden.length);
    expect(responses.every(message => message.error?.code === 'PERMISSION_DENIED')).toBe(true);
    expect(grantPermission).not.toHaveBeenCalled();
    expect(saveItem).not.toHaveBeenCalled();
  });

  it('escapes script-breaking launch option values as literal unicode escapes', () => {
    const options = {
      note: '</script><script>window.pwned=true</script> & suffix',
      separator: '\u2028 and \u2029',
    };
    const html = AppSandbox._internal.injectCapabilityShim(
      '<!doctype html><html><body>entry</body></html>',
      { id: 'com.example.options' },
      options
    );
    const match = html.match(/window\.__NOVA_APP_OPTIONS__=([\s\S]*?);<\/script>/);
    expect(match).not.toBeNull();
    expect(match[1]).toContain('\\u003c/script\\u003e');
    expect(match[1]).toContain('\\u0026');
    expect(match[1]).toContain('\\u2028');
    expect(match[1]).toContain('\\u2029');
    expect(JSON.parse(match[1])).toEqual(options);
    expect(html).not.toContain('</script><script>window.pwned=true');
  });

  it('injects transparent-root CSS even when entry HTML has no head element', () => {
    const html = AppSandbox._internal.injectCapabilityShim(
      '<main id="app">fragment entry</main>',
      { id: 'com.example.transparent', transparent: true },
      {}
    );
    expect(html).toContain('<style id="novaapp-transparent-root">html,body{background:transparent;}</style>');
    expect(html.indexOf('novaapp-transparent-root')).toBeLessThan(html.indexOf('window.__NOVA_APP_OPTIONS__'));
  });

  it('emits syntactically valid XHR bridge code with callbacks, binary bodies, and CRLF headers', () => {
    const shim = AppSandbox._internal.buildCapabilityShim(false);
    const script = shim.slice(shim.indexOf('<script>') + 8, shim.lastIndexOf('</script>'));

    expect(() => new Function(script)).not.toThrow();
    expect(shim).toContain("const propertyHandler = xhr['on' + type]");
    expect(shim).toContain('headerLines.join(\'\\r\\n\')');
    expect(shim).toContain("responseType === 'arraybuffer'");
    expect(shim).toContain('XHR request body exceeds the 6 MiB limit');
    expect(shim).toContain("bodyEncoding: encodedBody.bodyEncoding");
  });

  it('classifies WebSocket URLs and requires net:internal for private destinations', async () => {
    const classify = AppSandbox._internal.resolveAndClassifyWebSocketUrl;
    expect(classify('wss://socket.example.com/events')).toMatchObject({ valid: true, isInternal: false });
    expect(classify('ws://127.0.0.1:9000/events')).toMatchObject({ valid: true, isInternal: true });
    expect(classify('ws://192.168.1.4:9000')).toMatchObject({ valid: true, isInternal: true });
    expect(classify('ws://[::1]:9000')).toMatchObject({ valid: true, isInternal: true });
    expect(classify('ws://router.local:9000')).toMatchObject({ valid: true, isInternal: true });
    expect(classify('ws://printer:9000')).toMatchObject({ valid: true, isInternal: true });
    expect(classify('wss://169.254.169.254/metadata')).toMatchObject({ valid: false });
    expect(classify('https://socket.example.com')).toMatchObject({ valid: false });

    const responses = [];
    const WebSocketMock = vi.fn(function() {});
    vi.stubGlobal('WebSocket', WebSocketMock);
    vi.stubGlobal('AppPermissionManager', { isGranted: permission => permission === 'net:websocket' });
    try {
      await AppSandbox._internal.handleAPICall(
        'nova:net:websocket',
        { url: 'ws://127.0.0.1:9000/private' },
        'internal-ws-denied',
        { id: 'third-party.app' },
        { __directResponder: message => responses.push(message) },
        { wsConnections: new Map() }
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(WebSocketMock).not.toHaveBeenCalled();
    expect(responses[0].error.code).toBe('PERMISSION_DENIED');
  });

  it('cleans nested views, popups, and subscriptions using the captured sandbox record', () => {
    const removeNestedCleanup = vi.fn();
    const removeView = vi.fn();
    const unsubscribeAppearance = vi.fn();
    const discardPopup = vi.fn();
    const record = {
      nestedWebviews: new Map([['nested-1', { cleanups: [removeNestedCleanup], view: { remove: removeView } }]]),
      appearanceSubscription: unsubscribeAppearance,
      pendingNewWindows: new Map([['popup-1', { discard: discardPopup }]]),
    };
    const sandboxes = AppSandbox._internal._activeSandboxes;
    sandboxes.set('record-cleanup-test', record);
    sandboxes.delete('record-cleanup-test'); // destroy() deletes before running cleanup
    AppSandbox._internal.cleanupSandboxRecord(record, []);

    expect(removeNestedCleanup).toHaveBeenCalledOnce();
    expect(removeView).toHaveBeenCalledOnce();
    expect(unsubscribeAppearance).toHaveBeenCalledOnce();
    expect(discardPopup).toHaveBeenCalledOnce();
    expect(record.nestedWebviews.size).toBe(0);
    expect(record.pendingNewWindows.size).toBe(0);
  });

  it('closes sandbox WebSockets after the registry entry has already been removed', () => {
    const socket = { close: vi.fn() };
    const record = { wsConnections: new Map([['ws-1', { ws: socket }]]) };
    const listeners = new Map();
    const webview = {
      addEventListener: vi.fn((name, handler) => listeners.set(name, handler)),
      removeEventListener: vi.fn(name => listeners.delete(name)),
    };
    const sandboxId = 'websocket-cleanup-test';
    const teardown = AppSandbox._internal.setupAPIBridge(webview, { id: 'com.example.cleanup' }, sandboxId, record);
    AppSandbox._internal._activeSandboxes.set(sandboxId, record);
    AppSandbox._internal._activeSandboxes.delete(sandboxId);
    teardown();

    expect(socket.close).toHaveBeenCalledWith(1000, 'sandbox closed');
    expect(record.wsConnections.size).toBe(0);
    expect(listeners.size).toBe(0);
  });

  it('blocks relaunch cleanup while a sandbox still uses the shared app partition', async () => {
    const appId = 'com.example.partition-active';
    AppSandbox._internal._activeSandboxes.set('active-partition-user', { appId });
    AppSandbox._internal.partitionCleanupRequired.add(appId);
    try {
      await expect(AppSandbox._internal.ensureExecutionPartitionClean(appId))
        .rejects.toThrow(/close all existing windows before relaunching/);
    } finally {
      AppSandbox._internal._activeSandboxes.delete('active-partition-user');
      AppSandbox._internal.partitionCleanupRequired.delete(appId);
    }
  });

  it('does not report partition cleanup success if the partition cannot be cleared', async () => {
    const listeners = new Map();
    const webview = {
      style: {},
      setAttribute: vi.fn(),
      addEventListener: vi.fn((name, handler) => listeners.set(name, handler)),
      removeEventListener: vi.fn(name => listeners.delete(name)),
      remove: vi.fn(),
      clearData: vi.fn(),
      set src(_value) { queueMicrotask(() => listeners.get('loadabort')?.({ reason: 'blocked' })); },
    };
    vi.stubGlobal('document', { createElement: () => webview, body: { appendChild: vi.fn() } });
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    vi.stubGlobal('fetch', vi.fn(async url => url === '/api/apps/serve/register'
      ? { ok: true, json: async () => ({ baseUrl: '/api/apps/serve/cleanup-test' }) }
      : { ok: true }));
    try {
      await expect(AppSandbox._internal.clearAppPartitionsByName('com.example.cleanup', ['app_com.example.cleanup']))
        .rejects.toThrow(/navigation failed/);
      expect(webview.clearData).not.toHaveBeenCalled();
      expect(webview.remove).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/apps\/serve\/unregister\/sandbox_clr_com\.example\.cleanup_\d+$/), expect.objectContaining({ method: 'DELETE' }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

});
