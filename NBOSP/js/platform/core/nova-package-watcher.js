// js/platform/core/nova-package-watcher.js
//
// Hot-reload for physically replaced system .novaapp bundles.
//
// Design (2026-11-16):
//   Replacing a system package's .novaapp on disk used to take effect only at
//   the NEXT boot (the boot reconciler compares stored vs bundled
//   signature/version/compiled_at and reinstalls). Worse, the
//   AppLoaderOptimizer's IndexedDB cache kept serving the OLD package bytes
//   even after that, because a manual swap never changes the cacheKey that
//   novaapp-manifest.json pins.
//
//   This watcher bridges runtime: fs.watch on the bundled apps directory,
//   debounced per file. For a changed <id>.novaapp it
//     1. looks the id up in novaapp-manifest.json (GUI system bundles only —
//        systemService packages are injected pre-boot and need a reload),
//     2. re-reads the package with cache:'no-store' (bypassing the
//        optimizer) and validates the shape (novabyte_app, id match,
//        manifest.system),
//     3. verifies signature + integrity + trust FIRST — a tampered or
//        untrusted replacement is refused and the old code keeps running
//        (fail closed),
//     4. closes the app's open windows and backgrounded sandboxes, then
//     5. reinstalls with force (AppPackage.installPackage, source
//        'system-bundle', exactly like the boot reconciler), updates the
//        package-store registry metadata, evicts the optimizer's cached
//        copies for that file, and
//     6. relaunches the app minimized ("in the background") if it had a
//        window open before the swap, so the new code is live immediately
//        while the desktop stays undisturbed.
//
//   Everything is dependency-injectable for tests; on hosts without Node
//   require/fs.watch (pure web builds) start() is a no-op.

(() => {
  'use strict';

  const DEBOUNCE_MS = 600;
  const MANIFEST_URL = 'js/apps/novaapp-manifest.json';

  function log(...args) { try { console.info('[NovaPackageWatcher]', ...args); } catch (_) { /* stripped host */ } }
  function warn(...args) { try { console.warn('[NovaPackageWatcher]', ...args); } catch (_) { /* stripped host */ } }

  function notify(titleKey, body, type) {
    try {
      if (typeof Notify !== 'undefined' && typeof Notify.show === 'function') {
        Notify.show({ title: titleKey, body: String(body || ''), type, appName: 'App Manager' });
      }
    } catch (_) { /* notifications are cosmetic */ }
  }

  function eventLog(message, data) {
    try { if (typeof EventLog !== 'undefined' && EventLog.log) EventLog.log({ app: 'NovaPackageWatcher', category: 'apps', severity: 'info', message, data }); } catch (_) { /* best-effort */ }
  }

  const NovaPackageWatcher = {
    _handle: null,

    /**
     * Start watching the bundled apps directory. No-op on hosts without
     * Node require/fs.watch. Returns (a promise for) the watcher handle.
     */
    async start(deps = {}) {
      if (this._handle) return this._handle;
      const fs = deps.fs ?? (typeof require === 'function' ? safeRequire('fs') : null);
      const path = deps.path ?? (typeof require === 'function' ? safeRequire('path') : null);
      if (!fs?.watch || !path?.join) {
        log('host without native fs.watch — runtime package reload disabled (boot reconcile still covers swaps)');
        return null;
      }
      const appDir = deps.appDir ?? resolveBundledAppsDir(fs, path);
      if (!appDir) {
        log('bundled apps directory not found — runtime package reload disabled');
        return null;
      }

      const bundles = deps.bundles ?? await fetchBundles(deps.fetchImpl);
      if (!Array.isArray(bundles) || !bundles.length) {
        warn('bundled NovaApp manifest unavailable — runtime package reload disabled');
        return null;
      }
      const byFile = new Map(bundles.filter(b => b && typeof b.id === 'string' && typeof b.file === 'string')
        .map(b => [b.file.split('/').pop().toLowerCase(), b]));

      const timers = new Map();
      const handle = {
        appDir,
        stopped: false,
        rawWatcher: null,
        stop() {
          this.stopped = true;
          for (const t of timers.values()) clearTimeout(t);
          timers.clear();
          try { this.rawWatcher?.close?.(); } catch (_) { /* already closed */ }
          if (NovaPackageWatcher._handle === handle) NovaPackageWatcher._handle = null;
        },
      };

      const onChange = (filename) => {
        if (handle.stopped) return;
        const name = String(filename || '').split('/').pop().toLowerCase();
        if (!name.endsWith('.novaapp')) return;            // manifest/cache writes are none of ours
        const bundle = byFile.get(name);
        if (!bundle || bundle.systemService === true) return; // services are pre-boot injected
        // Debounce per file: editors that rewrite in place fire rename+change.
        if (timers.has(name)) clearTimeout(timers.get(name));
        timers.set(name, setTimeout(() => {
          timers.delete(name);
          reloadBundle(bundle, deps).catch(err => warn('reload failed for', bundle.id, err));
        }, DEBOUNCE_MS));
      };

      try {
        handle.rawWatcher = fs.watch(appDir, { persistent: false }, (event, filename) => {
          if (event === 'change' || event === 'rename') onChange(filename);
        });
      } catch (err) {
        warn('fs.watch failed on', appDir, err);
        return null;
      }

      log('watching', appDir, `(${byFile.size} GUI bundles)`);
      this._handle = handle;
      return handle;
    },

    stop() {
      this._handle?.stop?.();
    },
  };

  function safeRequire(moduleName) {
    try { return require(moduleName); } catch (_) { return null; }
  }

  /** Locate <NBOSP root>/js/apps — the directory the page's URL space serves. */
  function resolveBundledAppsDir(fs, path) {
    const candidates = [];
    try {
      if (typeof process !== 'undefined' && typeof process.cwd === 'function') {
        candidates.push(process.cwd());
        candidates.push(path.dirname(process.cwd()));
      }
    } catch (_) { /* NW.js host quirks */ }
    for (const root of candidates) {
      try {
        const dir = path.join(root, 'js', 'apps');
        if (fs.existsSync(path.join(dir, 'novaapp-manifest.json'))) return dir;
      } catch (_) { /* try the next candidate */ }
    }
    return null;
  }

  async function fetchBundles(fetchImpl) {
    const fetchFn = fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!fetchFn) return null;
    try {
      const response = await fetchFn(MANIFEST_URL, { cache: 'no-store' });
      if (!response.ok) return null;
      const parsed = await response.json();
      return Array.isArray(parsed) ? parsed : null;
    } catch (_) { return null; }
  }

  /** The full verify → close → reinstall → evict → relaunch pipeline. */
  async function reloadBundle(bundle, deps) {
    const AppPackage = deps.AppPackage ?? (typeof window !== 'undefined' ? window.AppPackage : null);
    const store = deps.PackageStore ?? (typeof window !== 'undefined' ? window.NovaAppPackageStore : null);
    const fetchFn = deps.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!AppPackage?.installPackage || !store?.loadRegistry || !fetchFn) {
      warn('package pipeline unavailable — skipping reload of', bundle.id);
      return;
    }

    // 1) Re-read the physical file, bypassing every cache.
    let pkg;
    try {
      const response = await fetchFn(bundle.file, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      pkg = await response.json();
    } catch (err) {
      warn('re-fetch of', bundle.file, 'failed:', err?.message || err);
      return;
    }

    // 2) Shape validation — same rules the boot reconciler applies.
    if (!pkg?.novabyte_app || pkg?.manifest?.id !== bundle.id || pkg?.manifest?.system !== true) {
      warn('replaced package for', bundle.id, 'failed bundle validation — old code stays live');
      notify(_tw('apps.appmanager.errorCannotReplaceSystem', 'Cannot replace a system app'),
        `${bundle.id}: invalid package shape`, 'error');
      return;
    }

    // 3) Trust + integrity FIRST (fail closed — the old code keeps running).
    //    The watcher is autonomous: unlike the App Manager dialog there is no
    //    user consent step for a mismatched/tampered swap, so BOTH gates must
    //    pass (a hot-swap must never be the weaker link next to the App
    //    Manager flow).
    const trustStore = deps.trustStore ?? (typeof TrustStore !== 'undefined' && typeof TrustStore.list === 'function' ? TrustStore.list() : []);
    const revocationCheck = deps.revocationCheck ?? (typeof TrustStore !== 'undefined' && typeof TrustStore.isRevoked === 'function' ? TrustStore.isRevoked : undefined);
    try {
      const integrityOk = await AppPackage.verifyIntegrity(pkg);
      const trustOk = await AppPackage.verifyAgainstTrustStore(pkg, trustStore, revocationCheck);
      if (!integrityOk || !trustOk) {
        throw new Error('integrity or trust verification failed');
      }
    } catch (err) {
      warn('verification failed for the replaced', bundle.id, '— refusing to hot-swap:', err?.message || err);
      notify(_tw('apps.appmanager.errorCannotReplaceSystem', 'Cannot replace a system app'),
        `${bundle.id}: ${err?.message || 'verification failed'}`, 'error');
      return;
    }

    // 4) Close-before-update: every open window and backgrounded sandbox of
    //    this app goes down BEFORE the registry/store swap.
    const hadWindows = closeAppEverything(bundle.id);

    // 5) Reinstall + re-register (the boot reconciler's exact call), then
    //    refresh the registry metadata and evict the optimizer caches.
    try {
      await AppPackage.installPackage(pkg, {
        force: true,
        source: 'system-bundle',
        trustStore,
        revocationCheck,
      });
      const runtimeApp = typeof AppRegistry !== 'undefined' && AppRegistry.getApp ? AppRegistry.getApp(bundle.id) : null;
      let registry = store.loadRegistry();
      const metadata = store.toMetadata(runtimeApp || {
        ...pkg.manifest,
        files: pkg.files,
        signature: pkg.signature,
        verified: true,
        signer: 'NovaByte System',
        system: true,
        source: 'system-bundle',
        manifest: pkg.manifest,
        novabyte_app: pkg.novabyte_app,
        compiled_at: pkg.compiled_at,
      });
      registry = registry.filter(a => a.id !== bundle.id);
      registry.push(metadata);
      store.saveRegistry(registry);
    } catch (err) {
      warn('reinstall of', bundle.id, 'failed:', err?.message || err);
      notify(_tw('apps.appmanager.installFailedTitle', 'Installation failed'),
        `${bundle.id}: ${err?.message || err}`, 'error');
      return;
    }

    try { await window.AppLoaderOptimizer?.evict?.(bundle.file); } catch (_) { /* best-effort eviction */ }

    // 6) Relaunch in the background when the app was open before the swap,
    //    so the new code is running (and persisted) immediately.
    if (hadWindows && typeof WM !== 'undefined' && typeof WM.createWindow === 'function') {
      try {
        const wstate = WM.createWindow(bundle.id);
        if (wstate?.id && typeof WM.minimizeWindow === 'function') WM.minimizeWindow(wstate.id);
      } catch (err) { warn('background relaunch of', bundle.id, 'failed:', err?.message || err); }
    }

    eventLog(`Hot-reloaded system package ${bundle.id} v${pkg.manifest.version}`, { appId: bundle.id, version: pkg.manifest.version });
    notify(_tw('apps.appmanager.appInstalledTitle', 'App Installed'),
      `${pkg.manifest.name} v${pkg.manifest.version}`, 'success');
    log('hot-reloaded', bundle.id, pkg.manifest.version);
  }

  /** Close every window + backgrounded sandbox for one app id. Returns whether any window was open. */
  function closeAppEverything(appId) {
    let hadWindows = false;
    try {
      if (typeof WM !== 'undefined' && WM.closeWindow && typeof OS !== 'undefined' && OS.windows) {
        const openWindowIds = [];
        for (const [wid, wstate] of OS.windows) {
          if (wstate.appId === appId) openWindowIds.push(wid);
        }
        hadWindows = openWindowIds.length > 0;
        for (const wid of openWindowIds) WM.closeWindow(wid, { forceKill: true });
      }
    } catch (_) { /* WM unavailable in stripped hosts */ }
    try {
      if (typeof AppSandbox !== 'undefined' && AppSandbox.getAllSandboxes) {
        for (const sandbox of AppSandbox.getAllSandboxes()) {
          if (sandbox.appId === appId && sandbox.backgrounded) {
            AppSandbox.terminateBackground(sandbox.sandboxId);
            if (typeof Notify !== 'undefined' && Notify.unpin) Notify.unpin(`pin_bg_${appId}`);
          }
        }
      }
    } catch (_) { /* sandbox registry unavailable */ }
    return hadWindows;
  }

  // Localisation shim: the watcher runs before the i18n catalogues in some
  // stripped hosts; fall back to the English literal.
  function _tw(key, fallback) {
    try {
      if (typeof _t === 'function') {
        const value = _t(key);
        if (typeof value === 'string' && value !== key) return value;
      }
    } catch (_) { /* catalogue unavailable */ }
    return fallback;
  }

  window.NovaPackageWatcher = NovaPackageWatcher;
  if (typeof module !== 'undefined' && module.exports) module.exports = NovaPackageWatcher;

  // Attach after the boot reconcile (same lifecycle slot the calendar
  // notifier uses) — never in tests, where start() is driven explicitly.
  try {
    if (typeof Boot !== 'undefined' && Boot?.hooks?.after && !window.__NOVA_PACKAGE_WATCHER_DISABLED__) {
      Boot.hooks.after.push(() => {
        NovaPackageWatcher.start().catch(err => warn('start failed:', err?.message || err));
      });
    }
  } catch (_) { /* boot hooks unavailable */ }
})();
