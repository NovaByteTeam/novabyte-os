import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';

const source = readFileSync(new URL('../../js/apps/vpn-service/service.js', import.meta.url), 'utf8');

function installVpnService({ installedApps = [] } = {}) {
  const appId = 'com.example.vpntest';
  const registry = {
    getApp: vi.fn(() => null),
    onUninstall: vi.fn(),
  };
  const permissionManager = { isGranted: vi.fn(() => true) };
  const windowObject = {
    NovaAppPackageStore: { loadRegistry: () => installedApps },
  };
  const spawn = vi.fn((_helper, args) => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stdin = { on: vi.fn(), end: vi.fn() };
    queueMicrotask(() => {
      child.stdout.emit('data', args[0] === 'register'
        ? JSON.stringify({ registered: true, providerId: args[1] })
        : args[0] === 'list'
          ? JSON.stringify([appId])
        : JSON.stringify({ active: false }));
      child.emit('close', 0, null);
    });
    return child;
  });
  const fakeRequire = (name) => {
    if (name === 'child_process') return { spawn };
    throw new Error(`Unexpected require: ${name}`);
  };
  new Function('window', 'AppRegistry', 'AppPermissionManager', 'Buffer', 'require', source)(
    windowObject,
    registry,
    permissionManager,
    Buffer,
    fakeRequire
  );
  return { appId, service: windowObject.NovaVPNService, registry, spawn };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VPN provider registration', () => {
  it('resolves an installed package from the package store when AppRegistry has not hydrated it yet', async () => {
    const { appId, service, registry, spawn } = installVpnService({
      installedApps: [{ id: 'com.example.vpntest', name: 'VPN Test', type: 'package' }],
    });

    await expect(service.registerProvider(appId, '[Interface]')).resolves.toEqual({
      registered: true,
      providerId: appId,
    });
    expect(registry.getApp).toHaveBeenCalledWith(appId);
    expect(spawn).toHaveBeenCalledWith('/usr/bin/nbosp-vpn', ['register', appId], expect.any(Object));
  });

  it('lists registered providers from the installed package store before AppRegistry hydration', async () => {
    const { appId, service } = installVpnService({
      installedApps: [{ id: 'com.example.vpntest', name: 'VPN Test', type: 'package' }],
    });

    await expect(service.getProviders()).resolves.toEqual([
      { id: appId, name: 'VPN Test', granted: true },
    ]);
  });

  it('still rejects uninstalled apps, web apps, and trusted system apps', async () => {
    const { appId, service } = installVpnService({
      installedApps: [
        { id: 'com.example.web', type: 'webapp' },
        { id: 'com.example.system', system: true },
      ],
    });

    await expect(service.registerProvider(appId, '[Interface]')).rejects.toThrow(/Only installed sandboxed/);
    await expect(service.registerProvider('com.example.web', '[Interface]')).rejects.toThrow(/Only installed sandboxed/);
    await expect(service.registerProvider('com.example.system', '[Interface]')).rejects.toThrow(/Only installed sandboxed/);
  });
});
