'use strict';

const packagePromises = new Map();
const PACKAGE_CACHE_DB = 'NovaByte_AppLoaderOptimizer';
const PACKAGE_CACHE_STORE = 'packages';
let packageCacheDbPromise = null;
let prefetchStartedAt = null;
let prefetchFinishedAt = null;
let prefetchCount = 0;

function openPackageCache() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (packageCacheDbPromise) return packageCacheDbPromise;

  packageCacheDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(PACKAGE_CACHE_DB, 1);
    request.onupgradeneeded = event => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(PACKAGE_CACHE_STORE)) {
        db.createObjectStore(PACKAGE_CACHE_STORE, { keyPath: 'file' });
      }
    };
    request.onsuccess = event => resolve(event.target.result);
    request.onerror = event => reject(event.target.error);
  });
  packageCacheDbPromise.catch(() => {
    packageCacheDbPromise = null;
  });
  return packageCacheDbPromise;
}

async function readCachedPackage(file, cacheKey) {
  if (!cacheKey) return null;
  const db = await openPackageCache();
  if (!db) return null;

  return new Promise((resolve, reject) => {
    const request = db.transaction(PACKAGE_CACHE_STORE, 'readonly')
      .objectStore(PACKAGE_CACHE_STORE)
      .get(file);
    request.onsuccess = event => {
      const record = event.target.result;
      resolve(record?.cacheKey === cacheKey ? record.pkg : null);
    };
    request.onerror = event => reject(event.target.error);
  });
}

async function persistPackage(file, cacheKey, pkg) {
  if (!cacheKey) return;
  const db = await openPackageCache();
  if (!db) return;

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(PACKAGE_CACHE_STORE, 'readwrite');
    transaction.objectStore(PACKAGE_CACHE_STORE).put({ file, cacheKey, pkg });
    transaction.oncomplete = () => resolve();
    transaction.onerror = event => reject(event.target.error);
    transaction.onabort = event => reject(event.target.error);
  });
}

function loadBundledPackage(file, cacheKey) {
  if (typeof file !== 'string' || !file) {
    return Promise.reject(new TypeError('A bundled package path is required'));
  }
  const requestKey = `${file}\n${cacheKey || ''}`;
  if (packagePromises.has(requestKey)) return packagePromises.get(requestKey);

  const packagePromise = (async () => {
    const cachedPackagePromise = readCachedPackage(file, cacheKey).catch(error => {
      console.error(`[AppLoaderOptimizer] Could not read persistent package cache for ${file}:`, error);
      return null;
    });
    const cachedPackage = await cachedPackagePromise;
    if (cachedPackage) return cachedPackage;

    try {
      const response = await fetch(file, { cache: 'no-cache' });
      if (!response.ok) {
        const error = new Error(`Failed to fetch bundled NovaApp ${file}: HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }

      const pkg = await response.json();
      try {
        await persistPackage(file, cacheKey, pkg);
      } catch (error) {
        console.error(`[AppLoaderOptimizer] Could not persist package cache for ${file}:`, error);
      }
      return pkg;
    } catch (error) {
      throw error;
    }
  })();
  packagePromises.set(requestKey, packagePromise);
  return packagePromise;
}

const AppLoaderOptimizer = Object.freeze({
  start(bundles) {
    if (!Array.isArray(bundles)) throw new TypeError('Bundled NovaApp list must be an array');
    if (prefetchStartedAt !== null) return Promise.resolve(this.getStats());

    prefetchStartedAt = Date.now();
    const pending = [];
    for (const bundle of bundles) {
      if (!bundle || typeof bundle.id !== 'string' || typeof bundle.file !== 'string' ||
          bundle.id === 'com.nbosp.service.app-loader-optimiser') {
        continue;
      }
      pending.push(loadBundledPackage(bundle.file, bundle.cacheKey));
    }
    prefetchCount = pending.length;

    return Promise.allSettled(pending).then(results => {
      prefetchFinishedAt = Date.now();
      return {
        ...this.getStats(),
        failed: results.filter(result => result.status === 'rejected').length,
      };
    });
  },

  getPackage(file, cacheKey) {
    return loadBundledPackage(file, cacheKey);
  },

  getStats() {
    return {
      startedAt: prefetchStartedAt,
      finishedAt: prefetchFinishedAt,
      packages: prefetchCount,
      cachedPackages: packagePromises.size,
    };
  },

  clear() {
    packagePromises.clear();
    prefetchStartedAt = null;
    prefetchFinishedAt = null;
    prefetchCount = 0;
  },

  /**
   * Drop every cached copy of one bundled package (in-flight promises AND
   * the persistent IndexedDB record). The runtime package watcher calls this
   * when a system .novaapp is physically replaced on disk: the manifest's
   * cacheKey never changes for a manual swap, so a stale record would keep
   * serving the OLD package at the next boot reconcile.
   */
  async evict(file) {
    if (typeof file !== 'string' || !file) throw new TypeError('A bundled package path is required');
    const prefix = `${file}\n`;
    for (const key of [...packagePromises.keys()]) {
      if (key.startsWith(prefix)) packagePromises.delete(key);
    }
    const db = await openPackageCache();
    if (!db) return true;
    return new Promise((resolve) => {
      const request = db.transaction(PACKAGE_CACHE_STORE, 'readwrite')
        .objectStore(PACKAGE_CACHE_STORE).delete(file);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false); // best-effort — refetch on miss
    });
  },
});

window.AppLoaderOptimizer = AppLoaderOptimizer;
