(function () {
  'use strict';

  const APPS_KEY = 'nova_installed_apps';
  const APP_ROOT = 'apps';
  const STORAGE_VERSION = 1;

  // The installed-apps inventory lives in the NovaByte Registry
  // (HKNS/apps/installed — Windows keeps the same inventory under
  // HKLM\...\Uninstall) through RegistrySystemState. The localStorage key
  // stays only as the pre-registry adoption source and the fail-soft
  // fallback when the engine is unavailable.
  function sysState() {
    return typeof window !== 'undefined' && window && window.RegistrySystemState;
  }

  function parseJSON(raw, fallback) {
    try { return raw ? JSON.parse(raw) : fallback; }
    catch { return fallback; }
  }

  function loadRegistry() {
    const state = sysState();
    if (state && typeof state.installedApps === 'function') {
      try { return state.installedApps(); }
      catch { /* fall through to legacy */ }
    }
    try { return parseJSON(localStorage.getItem(APPS_KEY), []); }
    catch { return []; }
  }

  function safeAppId(id) {
    return String(id || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  // Multi-user: a person's installed apps get their own file tree, so two
  // accounts installing the same app don't share (or wipe) each other's copy.
  // '@' can't come out of safeAppId(), so the segment never collides with an
  // app id. Bundled system packages are machine-wide and stay at apps/<id>.
  // `app` is optional; lookups by bare id fall back to the account's tree.
  function storagePathForApp(id, app) {
    const appId = safeAppId(id);
    if (!appId || appId === '.' || appId === '..') {
      throw new Error('Invalid app id for package storage');
    }
    const state = sysState();
    const machineWide = app && typeof state?.isMachineApp === 'function' && state.isMachineApp(app);
    const owner = machineWide || typeof state?.scopedUid !== 'function'
      ? ''
      : String(state.scopedUid() || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    if (owner === '.' || owner === '..') throw new Error('Invalid account id for package storage');
    const root = owner ? `${APP_ROOT}/@users/${owner}` : APP_ROOT;
    return `${root}/${appId}`;
  }

  function resolveStoragePath(app) {
    const id = app?.id;
    const appId = safeAppId(id);
    if (!appId || appId === '.' || appId === '..') {
      throw new Error('Invalid app id for package storage');
    }

    const expected = storagePathForApp(id, app);
    const stored = app.storagePath;
    if (!stored || stored === expected) return expected;

    // The original single-user installs lived at apps/<id>. Only the legacy
    // owner may clean up that location after moving to per-user storage.
    const state = sysState();
    const userScope = typeof window !== 'undefined' ? window.NovaUserScope : null;
    const currentUid = typeof state?.scopedUid === 'function' ? state.scopedUid() : '';
    const legacyOwnerUid = typeof userScope?.legacyOwnerUid === 'function'
      ? userScope.legacyOwnerUid()
      : '';
    const legacyPath = `${APP_ROOT}/${appId}`;
    if (stored === legacyPath && currentUid && currentUid === legacyOwnerUid &&
        !(typeof state?.isMachineApp === 'function' && state.isMachineApp(app))) {
      return legacyPath;
    }

    throw new Error(`Package storage path is outside the app's account scope: ${stored}`);
  }

  function normalizePackagePath(path) {
    const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length || parts.some(part => part === '.' || part === '..')) {
      throw new Error(`Invalid package file path: ${path}`);
    }
    return parts.join('/');
  }

  function guessMime(path) {
    const lower = String(path || '').toLowerCase();
    if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
    if (lower.endsWith('.css')) return 'text/css';
    if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'text/javascript';
    if (lower.endsWith('.json')) return 'application/json';
    if (lower.endsWith('.svg')) return 'image/svg+xml';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.txt') || lower.endsWith('.md')) return 'text/plain';
    if (lower.endsWith('.wasm')) return 'application/wasm';
    return 'application/octet-stream';
  }

  function toMetadata(app, extra = {}) {
    // SECURITY (2026-11-15 audit, finding M3): a .novaapp JSON can carry an
    // own '__proto__' key (JSON.parse uses CreateDataProperty, and the
    // { ...manifest } spreads preserve it) — plain `meta[key] = value` then
    // invokes the inherited __proto__ SETTER and swaps the fresh object's
    // prototype to attacker-chosen data, after which meta.system /
    // meta.verified / meta.storagePath reads resolve through the injected
    // prototype. Skip the dangerous names so they never reach the store
    // (they are not meaningful package fields).
    const UNSAFE_META_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
    const meta = {};
    for (const [key, value] of Object.entries(app || {})) {
      if (key === 'files' || key === '_cachedHtml') continue;
      if (UNSAFE_META_KEYS.has(key)) continue;
      if (typeof value === 'function') continue;
      meta[key] = value;
    }
    meta.storageVersion = extra.storageVersion || meta.storageVersion || STORAGE_VERSION;
    meta.storagePath = extra.storagePath || storagePathForApp(meta.id, meta);
    if (Number.isFinite(extra.fileCount)) meta.fileCount = extra.fileCount;
    if (Number.isFinite(extra.packageSize)) meta.packageSize = extra.packageSize;
    return meta;
  }

  function toMetadataList(list) {
    return (Array.isArray(list) ? list : []).filter(app => app && app.id).map(app => toMetadata(app));
  }

  function saveRegistry(list) {
    const metadata = toMetadataList(list);
    const state = sysState();
    if (state && typeof state.setInstalledApps === 'function') {
      try { state.setInstalledApps(metadata); }
      catch { localStorage.setItem(APPS_KEY, JSON.stringify(metadata)); }
    } else {
      localStorage.setItem(APPS_KEY, JSON.stringify(metadata));
    }
    if (window.AppDirs?.syncKey) AppDirs.syncKey(APPS_KEY, metadata).catch(() => {});
    return metadata;
  }

  async function ensureReady() {
    if (typeof OPFS === 'undefined') throw new Error('OPFS service is not available yet');
    if (typeof OPFS.init === 'function') await OPFS.init();
  }

  function base64ToBlob(encoded, type) {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  async function readFileIndex(storagePath) {
    await ensureReady();
    const raw = await OPFS.readText(`${storagePath}/files.index.json`);
    return raw ? JSON.parse(raw) : null;
  }

  async function removeStoredFiles(appOrMeta) {
    await ensureReady();
    const storagePath = resolveStoragePath(appOrMeta);

    const index = await readFileIndex(storagePath);

    if (Array.isArray(index?.files)) {
      for (const file of index.files) {
        let relPath;
        try {
          relPath = normalizePackagePath(file?.path);
        } catch {
          // Ignore malformed index entries; never let them choose a deletion path.
          continue;
        }
        await OPFS.deleteBlob(`${storagePath}/files/${relPath}`);
      }
    }

    await OPFS.deleteBlob(`${storagePath}/files.index.json`);
    await OPFS.deleteBlob(`${storagePath}/app.json`);
    await OPFS.deleteBlob(`${storagePath}/manifest.json`);
    await OPFS.deletePath(storagePath, true);
    return true;
  }

  function preparePackageFiles(appData) {
    const files = [];
    for (const [rawPath, encoded] of Object.entries(appData.files)) {
      if (typeof encoded !== 'string') continue;
      const relPath = normalizePackagePath(rawPath);
      const blob = base64ToBlob(encoded, guessMime(relPath));
      files.push({ relPath, blob });
    }
    return files;
  }

  async function writePackageFiles(appData, storagePath, preparedFiles) {
    await OPFS.ensureDirectory(`${storagePath}/files`);

    const fileIndex = [];
    let packageSize = 0;
    for (const { relPath, blob } of preparedFiles) {
      const filePath = `${storagePath}/files/${relPath}`;
      await OPFS.writeBlob(filePath, blob, blob.type || 'application/octet-stream');
      packageSize += blob.size || 0;
      fileIndex.push({
        path: relPath,
        storagePath: filePath,
        type: blob.type || '',
        size: blob.size || 0
      });
    }

    const metadata = toMetadata(appData, {
      storagePath,
      storageVersion: STORAGE_VERSION,
      fileCount: fileIndex.length,
      packageSize
    });

    await OPFS.writeText(`${storagePath}/files.index.json`, JSON.stringify({
      version: STORAGE_VERSION,
      files: fileIndex
    }, null, 2), 'application/json');
    await OPFS.writeText(`${storagePath}/manifest.json`, JSON.stringify(appData.manifest || metadata, null, 2), 'application/json');
    await OPFS.writeText(`${storagePath}/app.json`, JSON.stringify(metadata, null, 2), 'application/json');
    return metadata;
  }

  async function installApp(appData) {
    if (!appData?.id) throw new Error('App id is required');
    if (!appData.files || typeof appData.files !== 'object') throw new Error('Package files are required');

    await ensureReady();

    const storagePath = storagePathForApp(appData.id, appData);
    const preparedFiles = preparePackageFiles(appData);
    const previous = loadRegistry().find(app => app.id === appData.id);
    let previousPackage = null;
    let previousStoragePath = null;
    let previousFiles = null;
    if (previous) {
      previousStoragePath = resolveStoragePath(previous);
      previousPackage = await hydrateApp(previous, { migrateLegacy: false });
      if (!previousPackage?.files || typeof previousPackage.files !== 'object') {
        throw new Error(`Cannot safely replace ${appData.id}: the previous package contents are unavailable`);
      }
      previousFiles = preparePackageFiles(previousPackage);
    }

    try {
      await removeStoredFiles({ id: appData.id, storagePath });
      const metadata = await writePackageFiles(appData, storagePath, preparedFiles);

      // Reinstalling an app that predates per-account storage (legacy owner
      // upgrading it) moves it to the new tree; remove the old copy only after
      // the replacement has been fully written.
      if (previous && previousStoragePath !== storagePath) {
        try { await removeStoredFiles(previous); }
        catch (error) {
          console.warn('[NovaAppPackageStore] Could not remove legacy package storage for', appData.id, error);
        }
      }
      return metadata;
    } catch (error) {
      let rollbackError = null;
      try {
        await removeStoredFiles({ id: appData.id, storagePath });
        if (previousPackage) {
          await writePackageFiles(previousPackage, previousStoragePath, previousFiles);
        }
      } catch (failure) {
        rollbackError = failure;
      }
      if (rollbackError) {
        throw new Error(`Failed to persist ${appData.id}; restoring its previous package also failed: ${rollbackError.message}`, { cause: error });
      }
      throw error;
    }
  }

  async function hydrateApp(app, options = {}) {
    if (!app?.id) return null;

    if (app.files && typeof app.files === 'object') {
      let metadata = toMetadata(app);
      if (options.migrateLegacy !== false) {
        try { metadata = await installApp(app); }
        catch (error) { console.warn('[NovaAppPackageStore] Legacy package migration failed for', app.id, error); }
      }
      return { ...app, ...metadata, files: app.files };
    }

    try {
      const storagePath = resolveStoragePath(app);
      const index = await readFileIndex(storagePath);
      if (!Array.isArray(index?.files)) throw new Error('Stored package file index is missing');

      const files = {};
      for (const file of index.files) {
        const relPath = normalizePackagePath(file.path);
        const blob = await OPFS.getBlob(`${storagePath}/files/${relPath}`);
        if (!blob) throw new Error(`Stored package file is missing: ${relPath}`);
        files[relPath] = await blobToBase64(blob);
      }
      return { ...app, storagePath, files };
    } catch (error) {
      console.warn('[NovaAppPackageStore] Failed to hydrate package', app.id, error);
      return { ...app, _loadError: error?.message || String(error) };
    }
  }

  async function hydrateApps(list, options = {}) {
    const source = Array.isArray(list) ? list : [];
    const hydrated = [];
    let registryChanged = false;

    for (const app of source) {
      const full = await hydrateApp(app, options);
      if (!full) continue;
      hydrated.push(full);
      if (app.files || !app.storagePath || app.storagePath !== full.storagePath) registryChanged = true;
    }

    if (registryChanged && options.saveMigrated !== false) {
      try { saveRegistry(hydrated); }
      catch (error) { console.warn('[NovaAppPackageStore] Failed to save migrated registry:', error); }
    }

    return hydrated;
  }

  async function removeApp(appOrId, options = {}) {
    const id = typeof appOrId === 'string' ? appOrId : appOrId?.id;
    if (!id) return false;

    const registry = loadRegistry();
    const meta = typeof appOrId === 'string'
      ? registry.find(app => app.id === id) || { id, storagePath: storagePathForApp(id) }
      : appOrId;

    // System apps are not user-removable, matching the original bundled-.js
    // behavior before these were repackaged as .novaapp. Enforced HERE
    // rather than only in individual UI call sites (App Manager, desktop
    // right-click, Launchpad right-click, the nova:app:uninstall IPC
    // handler) — every one of those funnels through this function, so a
    // single check here holds regardless of which surface triggered it.
    // options.force exists only for internal callers that need to replace
    // a system app's own files during a legitimate re-install/upgrade of
    // that same signed package — never wire this to anything user-facing.
    if (meta.system === true && !options.force) {
      console.warn(`[NovaAppPackageStore] Refusing to remove system app "${id}" — system apps cannot be uninstalled.`);
      return false;
    }

    await removeStoredFiles(meta);

    if (options.updateRegistry !== false) {
      saveRegistry(registry.filter(app => app.id !== id));
    }

    return true;
  }

  // Deletes every package file an account installed. Guests are the caller:
  // their inventory is volatile, so without this their files outlive them.
  async function purgeUserFiles(uid) {
    const owner = String(uid || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!owner) return false;
    await ensureReady();
    await OPFS.deletePath(`${APP_ROOT}/@users/${owner}`, true);
    return true;
  }

  window.NovaAppPackageStore = Object.freeze({
    APPS_KEY,
    loadRegistry,
    saveRegistry,
    toMetadata,
    toMetadataList,
    storagePathForApp,
    installApp,
    hydrateApp,
    hydrateApps,
    removeApp,
    purgeUserFiles
  });
})();