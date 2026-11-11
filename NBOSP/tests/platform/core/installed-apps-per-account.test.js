// Installed apps are per account in multi-user mode: what alice installs
// must not appear for bob, her package files must not be shared with (or
// wiped by) his, and bundled system packages stay machine-wide.
//
// Wires the real registry, RegistrySystemState and NovaAppPackageStore
// together; only OPFS and the active-account scope are stubbed.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import NovaRegistry from '../../../js/platform/core/nova-registry.js';
import RegistrySystemState from '../../../js/platform/core/registry-system-state.js';
import { resetTestStorage } from '../../setup.js';

const LEGACY_OWNER = 'owner1';
const SYSTEM_PKG = { id: 'com.nbosp.settings', system: true, source: 'system-bundle' };

function userStorage() {
  const map = new Map();
  return {
    read(name) { return map.has(name) ? map.get(name) : null; },
    loadAll() {
      const out = {};
      for (const name of [...NovaRegistry.HIVES, 'AUDIT', 'SNAPSHOTS']) {
        out[name] = map.has(name) ? JSON.parse(map.get(name)) : null;
      }
      return out;
    },
    save(name, data) { map.set(name, JSON.stringify(data)); return true; },
    quarantine() {},
  };
}

const opfsFiles = new Map();
globalThis.OPFS = {
  async init() {},
  async readText(path) { return opfsFiles.get(path) ?? null; },
  async writeText(path, content) { opfsFiles.set(path, content); },
  async getBlob(path) { return opfsFiles.has(path) ? new Blob([opfsFiles.get(path)]) : null; },
  async writeBlob(path, blob) { opfsFiles.set(path, await blob.text()); },
  async deleteBlob(path) { opfsFiles.delete(path); },
  async deletePath(path) {
    for (const key of [...opfsFiles.keys()]) {
      if (key === path || key.startsWith(path + '/')) opfsFiles.delete(key);
    }
  },
  async ensureDirectory() {},
};

const ids = list => list.map(app => app.id);
const pkg = (id, extra = {}) => ({ id, name: id, version: '1.0.0', files: { 'index.html': btoa('<html></html>') }, ...extra });

let Store;

beforeEach(() => {
  resetTestStorage();
  opfsFiles.clear();
  RegistrySystemState._internal.resetAdopted();
  NovaRegistry._internal.resetState();
  NovaRegistry.init({ storage: userStorage(), events: null, logger: console });
  globalThis.window = globalThis.window || {};
  window.NovaRegistry = NovaRegistry;
  window.RegistrySystemState = RegistrySystemState;
  globalThis.NovaUserScope = { enabled: () => true, legacyOwnerUid: () => LEGACY_OWNER };
  require('../../../js/platform/core/nova-app-package-store.js');
  Store = window.NovaAppPackageStore;
});

afterEach(() => {
  delete globalThis.NovaUserScope;
});

afterAll(() => {
  delete window.NovaRegistry;
  delete window.RegistrySystemState;
  delete window.NovaAppPackageStore;
});

describe('installed-app inventory per account', () => {
  it('an app one account installs is not visible to another', () => {
    NovaRegistry.mountUserHives('alice');
    RegistrySystemState.setInstalledApps([{ id: 'com.example.notes' }]);
    expect(ids(RegistrySystemState.installedApps())).toEqual(['com.example.notes']);

    NovaRegistry.mountUserHives('bob');
    expect(RegistrySystemState.installedApps()).toEqual([]);

    RegistrySystemState.setInstalledApps([{ id: 'com.example.chess' }]);
    NovaRegistry.mountUserHives('alice');
    expect(ids(RegistrySystemState.installedApps())).toEqual(['com.example.notes']);
  });

  it('system packages stay machine-wide: every account and the login picker see them', () => {
    NovaRegistry.mountUserHives('alice');
    RegistrySystemState.setInstalledApps([SYSTEM_PKG, { id: 'com.example.notes' }]);
    expect(ids(NovaRegistry.get('HKNS/apps/installed'))).toEqual(['com.nbosp.settings']);

    NovaRegistry.mountUserHives('bob');
    expect(ids(RegistrySystemState.installedApps())).toEqual(['com.nbosp.settings']);

    NovaRegistry.unmountUserHives();
    expect(ids(RegistrySystemState.installedApps())).toEqual(['com.nbosp.settings']);
  });

  it('a write with no account mounted (boot, login picker) saves system packages and leaves user hives alone', () => {
    NovaRegistry.unmountUserHives();
    expect(RegistrySystemState.setInstalledApps([SYSTEM_PKG, { id: 'com.example.notes' }])).toBe(true);
    expect(ids(NovaRegistry.get('HKNS/apps/installed'))).toEqual(['com.nbosp.settings']);
  });

  it('single-user mode keeps one flat machine list', () => {
    globalThis.NovaUserScope = { enabled: () => false };
    RegistrySystemState.setInstalledApps([SYSTEM_PKG, { id: 'com.example.notes' }]);
    expect(ids(NovaRegistry.get('HKNS/apps/installed'))).toEqual(['com.nbosp.settings', 'com.example.notes']);
    expect(ids(RegistrySystemState.installedApps())).toEqual(['com.nbosp.settings', 'com.example.notes']);
  });
});

describe('upgrading a machine that already has a shared app list', () => {
  beforeEach(() => {
    NovaRegistry.set('HKNS/apps/installed', [SYSTEM_PKG, { id: 'com.legacy.app' }], { source: 'test' });
  });

  it('only the legacy owner inherits the old apps, and a stranger\'s write does not erase them', () => {
    NovaRegistry.mountUserHives('bob');
    expect(ids(RegistrySystemState.installedApps())).toEqual(['com.nbosp.settings']);

    RegistrySystemState.setInstalledApps(RegistrySystemState.installedApps());
    expect(ids(NovaRegistry.get('HKNS/apps/installed'))).toContain('com.legacy.app');

    NovaRegistry.mountUserHives(LEGACY_OWNER);
    expect(ids(RegistrySystemState.installedApps())).toEqual(['com.nbosp.settings', 'com.legacy.app']);
  });

  it('the owner\'s first write moves their apps into their own hive for good', () => {
    NovaRegistry.mountUserHives(LEGACY_OWNER);
    RegistrySystemState.setInstalledApps(RegistrySystemState.installedApps());

    expect(ids(NovaRegistry.get('HKNS/apps/installed'))).toEqual(['com.nbosp.settings']);
    expect(ids(NovaRegistry.get('HKNU/apps/installed'))).toEqual(['com.legacy.app']);

    NovaRegistry.mountUserHives('bob');
    expect(ids(RegistrySystemState.installedApps())).toEqual(['com.nbosp.settings']);
  });

  it('uninstalling everything does not bring the old shared list back', () => {
    NovaRegistry.mountUserHives(LEGACY_OWNER);
    RegistrySystemState.setInstalledApps(RegistrySystemState.installedApps());
    RegistrySystemState.setInstalledApps([SYSTEM_PKG]);

    NovaRegistry.mountUserHives('bob');
    NovaRegistry.mountUserHives(LEGACY_OWNER);
    expect(ids(RegistrySystemState.installedApps())).toEqual(['com.nbosp.settings']);
  });
});

describe('package files per account', () => {
  it('two accounts installing the same app get separate file trees', async () => {
    NovaRegistry.mountUserHives('alice');
    const alice = await Store.installApp(pkg('com.example.notes'));
    Store.saveRegistry([alice]);

    NovaRegistry.mountUserHives('bob');
    const bob = await Store.installApp(pkg('com.example.notes'));
    Store.saveRegistry([bob]);

    expect(alice.storagePath).not.toBe(bob.storagePath);
    expect(alice.storagePath).toContain('alice');
    expect(bob.storagePath).toContain('bob');
  });

  it('bob uninstalling an app leaves alice\'s copy intact', async () => {
    NovaRegistry.mountUserHives('alice');
    const alice = await Store.installApp(pkg('com.example.notes'));
    Store.saveRegistry([alice]);

    NovaRegistry.mountUserHives('bob');
    const bob = await Store.installApp(pkg('com.example.notes'));
    Store.saveRegistry([bob]);
    await Store.removeApp('com.example.notes');

    expect(Store.loadRegistry()).toEqual([]);

    NovaRegistry.mountUserHives('alice');
    const [restored] = Store.loadRegistry();
    const hydrated = await Store.hydrateApp(restored);
    expect(hydrated._loadError).toBeUndefined();
    expect(Object.keys(hydrated.files)).toEqual(['index.html']);
  });

  it('system packages keep the machine-wide apps/<id> path', async () => {
    NovaRegistry.mountUserHives('alice');
    const system = await Store.installApp(pkg('com.nbosp.settings', { system: true, source: 'system-bundle' }));
    expect(system.storagePath).toBe('apps/com.nbosp.settings');
  });

  it('reinstalling an app that predates per-account storage clears the old copy', async () => {
    NovaRegistry.mountUserHives(LEGACY_OWNER);
    opfsFiles.set('apps/com.legacy.app/files/index.html', '<old/>');
    opfsFiles.set('apps/com.legacy.app/files.index.json', '{}');
    Store.saveRegistry([{ id: 'com.legacy.app', storagePath: 'apps/com.legacy.app' }]);

    const upgraded = await Store.installApp(pkg('com.legacy.app'));

    expect(upgraded.storagePath).toContain(LEGACY_OWNER);
    expect(opfsFiles.has('apps/com.legacy.app/files/index.html')).toBe(false);
  });
});
