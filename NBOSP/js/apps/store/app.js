(function () {
  const STORE_ID = 'com.nbosp.store';
  const STORE_BASE_URL = 'https://novabyteteam.github.io/novabyte-os/';
  const STORE_URL = new URL('apps.json', STORE_BASE_URL).href;
  const APPS_KEY = 'nova_installed_apps';
  const packageIconCache = new Map();

  // reads from the same localStorage key appmanager writes —
  // installed state is shared between the two
  function getInstalledApps() {
    try {
      const PackageStore = window.NovaAppPackageStore || null;
      return PackageStore?.loadRegistry
        ? PackageStore.loadRegistry()
        : JSON.parse(localStorage.getItem(APPS_KEY) || '[]');
    } catch { return []; }
  }

  function saveInstalledApps(list) {
    try {
      const PackageStore = window.NovaAppPackageStore || null;
      if (PackageStore?.saveRegistry) {
        PackageStore.saveRegistry(list);
      } else {
        localStorage.setItem(APPS_KEY, JSON.stringify(list));
      }
    } catch (e) {
      console.warn('[AppStore] Failed to save:', e);
    }
  }

  function isInstalled(appId) {
    return getInstalledApps().some(a => a.id === appId);
  }

  function notify(title, body, type = 'info') {
    if (typeof Notify !== 'undefined' && typeof Notify.show === 'function') {
      Notify.show({ title, body, type, appName: 'App Store', appId: STORE_ID });
    }
  }

  function resolveIconUrl(icon) {
    if (typeof icon !== 'string') return null;
    if (/^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,/i.test(icon)) return icon;
    try {
      const url = new URL(icon, STORE_BASE_URL);
      return url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function packageIconUrl(app) {
    if (!packageIconCache.has(app.id)) {
      const iconPromise = (async () => {
        const response = await fetch(new URL(app.file, STORE_BASE_URL).href);
        if (!response.ok) throw new Error(`Package icon request failed (${response.status})`);
        const pkg = await response.json();
        const icon = pkg?.manifest?.icon;
        if (typeof icon !== 'string') return null;
        if (/^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,/i.test(icon)) return icon;
        if (/^https:\/\//i.test(icon)) return icon;

        const encoded = pkg.files?.[icon];
        if (typeof encoded !== 'string') return null;
        const extension = icon.split('.').pop()?.toLowerCase();
        const mime = extension === 'svg' ? 'image/svg+xml'
          : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
          : extension === 'gif' ? 'image/gif'
          : extension === 'webp' ? 'image/webp'
          : 'image/png';
        return `data:${mime};base64,${encoded}`;
      })();
      packageIconCache.set(app.id, iconPromise);
    }
    return packageIconCache.get(app.id);
  }

  async function fetchAppList() {
    const res = await fetch(STORE_URL);
    if (!res.ok) throw new Error(`Failed to fetch app list (${res.status})`);
    return res.json();
  }

  async function fetchAndVerify(app) {
    const pkgUrl = new URL(app.file, STORE_BASE_URL).href;
    const res = await fetch(pkgUrl);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);

    let pkg;
    try {
      pkg = JSON.parse(await res.text());
    } catch {
      throw new Error('Package is not valid JSON.');
    }

    if (!pkg || pkg.novabyte_app !== true) {
      throw new Error('Not a valid .novaapp package.');
    }

    let verified = false;
    let signer = null;
    let revoked = false;

    if (pkg.signature) {
      if (
        typeof AppPackage !== 'undefined' &&
        typeof AppPackage.verifyAgainstTrustStore === 'function' &&
        typeof TrustStore !== 'undefined' &&
        typeof TrustStore.list === 'function'
      ) {
        const revocationCheck = typeof TrustStore.isRevoked === 'function'
          ? (sig) => TrustStore.isRevoked(sig)
          : null;
        const result = await AppPackage.verifyAgainstTrustStore(
          pkg, TrustStore.list(), revocationCheck
        );
        verified = result.trusted === true;
        signer = result.signer || null;
        revoked = result.revoked === true;
      }
    }

    if (revoked) {
      throw new Error(`"${pkg.manifest?.name}" has a revoked signature and cannot be installed.`);
    }

    // integrity — blake3, sha256, sha512, whatever the package declares
    if (pkg.integrity) {
      if (
        typeof AppPackage !== 'undefined' &&
        typeof AppPackage.verifyIntegrity === 'function'
      ) {
        const ok = await AppPackage.verifyIntegrity(pkg);
        if (!ok) {
          throw new Error(`"${pkg.manifest?.name}" failed its integrity check — contents don't match the build-time hash.`);
        }
      }
    }

    return { pkg, verified, signer };
  }

  async function installApp(app, btn) {
    btn.disabled = true;
    btn.textContent = 'Downloading…';

    try {
      const { pkg, verified, signer } = await fetchAndVerify(app);
      btn.textContent = 'Installing…';

      const system = verified === true &&
        signer === 'NovaByte System' &&
        pkg.manifest?.system === true;

      const appData = {
        novabyte_app: pkg.novabyte_app,
        compiled_at: pkg.compiled_at,
        ...pkg.manifest,
        manifest: pkg.manifest,
        files: pkg.files,
        signature: pkg.signature || null,
        integrity: pkg.integrity || null,
        verified,
        signer,
        system,
        source: 'store',
        installedAt: Date.now(),
        revoked: false,
        tampered: false,
      };

      const PackageStore = window.NovaAppPackageStore || null;
      if (PackageStore?.installApp) {
        Object.assign(appData, await PackageStore.installApp(appData));
      }

      const installed = getInstalledApps();
      const idx = installed.findIndex(a => a.id === appData.id);
      if (idx > -1) installed.splice(idx, 1);
      installed.push(appData);
      saveInstalledApps(installed);

      // register into the live OS registry so it's immediately launchable
      if (typeof buildNovaAppConfig === 'function') {
        const cfg = buildNovaAppConfig(appData);
        if (typeof OS !== 'undefined') OS.apps[appData.id] = cfg;
        if (typeof APP_REGISTRY !== 'undefined') {
          const ri = APP_REGISTRY.findIndex(a => a.id === appData.id);
          if (ri > -1) APP_REGISTRY[ri] = cfg;
          else APP_REGISTRY.push(cfg);
        }
      }

      try { await window.AppDirs?.ensureAppDataFolder?.(appData.id); } catch (_) {}

      if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
      if (typeof WM !== 'undefined' && WM.updateTaskbar) WM.updateTaskbar();

      notify('App Installed', `${appData.name} v${appData.version} installed successfully.`, 'success');

      btn.textContent = 'Uninstall';
      btn.className = 'app-btn btn-uninstall';
      btn.disabled = false;
      btn.onclick = () => uninstallApp(app, btn);

    } catch (err) {
      notify('Install Failed', err.message || String(err), 'error');
      btn.textContent = 'Install';
      btn.disabled = false;
    }
  }

  async function uninstallApp(app, btn) {
    btn.disabled = true;
    btn.textContent = 'Removing…';

    try {
      const appId = app.id;

      // close any open windows before pulling the rug out from under them
      if (typeof WM !== 'undefined' && WM.closeWindow && typeof OS !== 'undefined') {
        const toClose = [];
        for (const [wid, wstate] of OS.windows) {
          if (wstate.appId === appId) toClose.push(wid);
        }
        await Promise.all(toClose.map(wid => WM.closeWindow(wid)));
      }

      try {
        const PackageStore = window.NovaAppPackageStore || null;
        if (PackageStore?.removeApp) await PackageStore.removeApp(appId, { updateRegistry: false });
      } catch (e) { console.warn('[AppStore] PackageStore.removeApp:', e); }

      try {
        if (typeof AppSandbox !== 'undefined' && AppSandbox.clearAppPartition) {
          await AppSandbox.clearAppPartition(appId);
        }
      } catch (e) { console.warn('[AppStore] clearAppPartition:', e); }

      try {
        if (typeof AppSandbox !== 'undefined' && AppSandbox.storageClear) {
          await AppSandbox.storageClear(appId);
        }
      } catch (e) { console.warn('[AppStore] storageClear:', e); }

      try {
        if (typeof AppDirs !== 'undefined' && AppDirs.removeAppData) {
          await AppDirs.removeAppData(appId);
        }
      } catch (e) { console.warn('[AppStore] removeAppData:', e); }

      saveInstalledApps(getInstalledApps().filter(a => a.id !== appId));

      if (typeof OS !== 'undefined') delete OS.apps[appId];
      if (typeof APP_REGISTRY !== 'undefined') {
        const ri = APP_REGISTRY.findIndex(a => a.id === appId);
        if (ri > -1) APP_REGISTRY.splice(ri, 1);
      }

      if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
      if (typeof WM !== 'undefined' && WM.updateTaskbar) WM.updateTaskbar();

      notify('App Removed', `${app.name} has been uninstalled.`, 'success');

      btn.textContent = 'Install';
      btn.className = 'app-btn btn-install';
      btn.disabled = false;
      btn.onclick = () => installApp(app, btn);

    } catch (err) {
      notify('Uninstall Failed', err.message || String(err), 'error');
      btn.textContent = 'Uninstall';
      btn.disabled = false;
    }
  }

  function renderCard(app) {
    const installed = isInstalled(app.id);

    const card = document.createElement('div');
    card.className = 'app-card';
    card.dataset.id = app.id;

    const iconWrap = document.createElement('div');
    iconWrap.className = 'app-icon';
    const iconUrl = resolveIconUrl(app.icon);
    if (iconUrl) {
      const image = document.createElement('img');
      image.src = iconUrl;
      image.alt = `${app.name} icon`;
      image.loading = 'lazy';
      image.onerror = async () => {
        image.onerror = null;
        try {
          const packageIcon = await packageIconUrl(app);
          if (packageIcon) {
            image.src = packageIcon;
            return;
          }
        } catch (error) {
          console.warn(`[AppStore] Could not load packaged icon for ${app.id}:`, error);
        }
        if (typeof svgIcon === 'function') {
          try {
            iconWrap.innerHTML = svgIcon('package', 40);
            return;
          } catch (_) {}
        }
        iconWrap.textContent = (app.name || '?')[0].toUpperCase();
      };
      iconWrap.appendChild(image);
    } else if (typeof svgIcon === 'function') {
      try {
        iconWrap.innerHTML = svgIcon(app.icon || 'package', 40);
      } catch (_) {
        iconWrap.textContent = (app.name || '?')[0].toUpperCase();
      }
    } else {
      iconWrap.textContent = (app.name || '?')[0].toUpperCase();
    }

    const info = document.createElement('div');
    info.className = 'app-info';

    const name = document.createElement('div');
    name.className = 'app-name';
    name.textContent = app.name;

    const meta = document.createElement('div');
    meta.className = 'app-meta';
    meta.textContent = `${app.author} · v${app.version} · ${app.size}`;

    const desc = document.createElement('div');
    desc.className = 'app-desc';
    desc.textContent = app.description;

    info.appendChild(name);
    info.appendChild(meta);
    info.appendChild(desc);

    const btn = document.createElement('button');
    btn.className = `app-btn ${installed ? 'btn-uninstall' : 'btn-install'}`;
    btn.textContent = installed ? 'Uninstall' : 'Install';
    btn.onclick = installed
      ? () => uninstallApp(app, btn)
      : () => installApp(app, btn);

    card.appendChild(iconWrap);
    card.appendChild(info);
    card.appendChild(btn);

    return card;
  }

  registerApp({
    id: STORE_ID,
    name: 'App Store',
    version: '3.0.2',
    icon: 'store',
    description: 'Browse, verify, and install apps for NovaByte OS.',
    defaultSize: [1020, 680],
    minSize: [720, 480],

    async init(content) {
      content.innerHTML = '';
      content.className = 'store-root';

      const header = document.createElement('div');
      header.className = 'store-header';
      header.innerHTML = '<span class="store-title">App Store</span>';

      const searchWrap = document.createElement('div');
      searchWrap.className = 'store-search-wrap';
      const search = document.createElement('input');
      search.type = 'text';
      search.placeholder = 'Search apps…';
      search.className = 'store-search';
      search.autocomplete = 'off';
      searchWrap.appendChild(search);

      const grid = document.createElement('div');
      grid.className = 'store-grid';

      const empty = document.createElement('div');
      empty.className = 'store-empty hidden';
      empty.textContent = 'No apps found.';

      const loading = document.createElement('div');
      loading.className = 'store-loading';
      loading.textContent = 'Loading…';

      content.appendChild(header);
      content.appendChild(searchWrap);
      content.appendChild(loading);
      content.appendChild(grid);
      content.appendChild(empty);

      let allApps = [];

      function render(query) {
        const q = (query || '').trim().toLowerCase();
        const filtered = q
          ? allApps.filter(a =>
              a.name.toLowerCase().includes(q) ||
              a.description.toLowerCase().includes(q) ||
              (a.author || '').toLowerCase().includes(q)
            )
          : allApps;

        grid.innerHTML = '';
        if (filtered.length === 0) {
          empty.classList.remove('hidden');
        } else {
          empty.classList.add('hidden');
          filtered.forEach(app => grid.appendChild(renderCard(app)));
        }
      }

      try {
        allApps = await fetchAppList();
        loading.remove();
        render();
      } catch (err) {
        loading.textContent = `Failed to load apps: ${err.message}`;
        return;
      }

      search.addEventListener('input', () => render(search.value));

      // keep install/uninstall buttons in sync if another window (e.g.
      // appmanager) installs or removes something while we're open
      window.addEventListener('storage', (e) => {
        if (e.key === APPS_KEY) render(search.value);
      });
    },
  });
})();
