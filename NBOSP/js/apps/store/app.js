(function () {
  const STORE_ID = 'com.nbosp.store';
  const STORE_BASE_URL = 'https://novabyteteam.github.io/novabyte-os/';
  const STORE_URL = new URL('apps.json', STORE_BASE_URL).href;
  const APPS_KEY = 'nova_installed_apps';
  const packageIconCache = new Map();
  const packageCache = new Map();
  const verificationCache = new Map();
  let rerenderCurrentView = null;

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
        const pkg = await fetchPackage(app);
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

  function fetchPackage(app) {
    if (!packageCache.has(app.id)) {
      const packagePromise = (async () => {
        const response = await fetch(new URL(app.file, STORE_BASE_URL).href);
        if (!response.ok) throw new Error(`Package request failed (${response.status})`);
        const pkg = await response.json();
        if (!pkg || pkg.novabyte_app !== true || pkg.manifest?.id !== app.id) {
          throw new Error(`The package identity does not match catalog entry "${app.id}".`);
        }
        return pkg;
      })();
      packageCache.set(app.id, packagePromise);
      packagePromise.catch(() => packageCache.delete(app.id));
    }
    return packageCache.get(app.id);
  }

  async function verifyCatalogPackage(app) {
    const pkg = await fetchPackage(app);
    if (
      !pkg.signature ||
      typeof AppPackage === 'undefined' ||
      typeof AppPackage.verifyAgainstTrustStore !== 'function' ||
      typeof TrustStore === 'undefined' ||
      typeof TrustStore.list !== 'function'
    ) {
      return { verified: false, signer: null, revoked: false };
    }

    const revocationCheck = typeof TrustStore.isRevoked === 'function'
      ? signature => TrustStore.isRevoked(signature)
      : null;
    const result = await AppPackage.verifyAgainstTrustStore(
      pkg,
      TrustStore.list(),
      revocationCheck
    );
    if (result.revoked) return { verified: false, signer: null, revoked: true };
    if (!result.trusted) return { verified: false, signer: null, revoked: false };

    if (pkg.integrity) {
      if (typeof AppPackage.verifyIntegrity !== 'function') {
        return { verified: false, signer: null, revoked: false };
      }
      const integrityValid = await AppPackage.verifyIntegrity(pkg);
      if (!integrityValid) return { verified: false, signer: null, revoked: false };
    }

    return { verified: true, signer: result.signer || null, revoked: false };
  }

  function getCatalogVerification(app) {
    if (!verificationCache.has(app.id)) {
      const result = verifyCatalogPackage(app).catch(error => {
        console.warn(`[AppStore] Could not verify ${app.id}:`, error);
        return { verified: false, signer: null, revoked: false };
      });
      verificationCache.set(app.id, result);
    }
    return verificationCache.get(app.id);
  }

  function addVerificationBadge(parent, app, className) {
    const badge = document.createElement('span');
    badge.className = `verified-badge ${className}`;
    badge.hidden = true;
    badge.setAttribute('aria-label', 'Signature verified by a trusted NovaByte publisher');
    parent.appendChild(badge);

    getCatalogVerification(app).then(result => {
      if (!result.verified) {
        badge.remove();
        return;
      }
      badge.textContent = '✓ Verified';
      badge.title = result.signer
        ? `Signature verified: ${result.signer}`
        : 'Signature verified by a trusted NovaByte publisher';
      badge.hidden = false;
    });
    return badge;
  }

  function packageMediaUrl(source, pkg) {
    if (typeof source === 'string' && pkg?.files?.[source]) {
      const extension = source.split('.').pop()?.toLowerCase();
      const mime = extension === 'svg' ? 'image/svg+xml'
        : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
        : extension === 'gif' ? 'image/gif'
        : extension === 'webp' ? 'image/webp'
        : extension === 'png' ? 'image/png'
        : null;
      if (mime) return `data:${mime};base64,${pkg.files[source]}`;
    }
    return resolveIconUrl(source);
  }

  function createDetailPanel(title, className) {
    const panel = document.createElement('section');
    panel.className = `detail-panel ${className}`;
    const heading = document.createElement('h2');
    heading.textContent = title;
    panel.appendChild(heading);
    return panel;
  }

  function appendPermissionPanel(parent, manifest) {
    const required = Array.isArray(manifest.permissions)
      ? manifest.permissions.filter(permission => typeof permission === 'string')
      : [];
    const optional = Array.isArray(manifest.optionalPermissions)
      ? manifest.optionalPermissions.filter(permission => typeof permission === 'string')
      : [];
    if (!required.length && !optional.length) return;

    const panel = createDetailPanel('Permissions', 'detail-permissions');
    const note = document.createElement('p');
    note.className = 'detail-metadata-note';
    note.textContent = 'Requested by the package. The OS still controls and prompts for access.';
    panel.appendChild(note);

    for (const [label, permissions] of [['Required', required], ['Optional', optional]]) {
      if (!permissions.length) continue;
      const group = document.createElement('div');
      group.className = 'permission-group';
      const groupTitle = document.createElement('h3');
      groupTitle.textContent = label;
      const list = document.createElement('ul');
      list.className = 'detail-permission-list';
      for (const permission of permissions) {
        const item = document.createElement('li');
        item.textContent = permission;
        list.appendChild(item);
      }
      group.append(groupTitle, list);
      panel.appendChild(group);
    }
    parent.appendChild(panel);
  }

  function getAppLinks(app, manifest) {
    const labels = {
      homepage: 'Website',
      website: 'Website',
      support: 'Support',
      supportUrl: 'Support',
      source: 'Source code',
      sourceUrl: 'Source code',
      repository: 'Source code',
      repositoryUrl: 'Source code',
      privacyPolicy: 'Privacy policy',
      privacyPolicyUrl: 'Privacy policy',
      documentation: 'Documentation',
      docs: 'Documentation',
      issues: 'Report an issue',
      issuesUrl: 'Report an issue',
    };
    const candidates = [
      ...(Array.isArray(app.links) ? app.links : Object.entries(app.links || {}).map(([label, url]) => ({ label, url }))),
      ...(Array.isArray(manifest.links) ? manifest.links : Object.entries(manifest.links || {}).map(([label, url]) => ({ label, url }))),
      ...Object.keys(labels).flatMap(key => [app[key], manifest[key]]
        .filter(Boolean)
        .map(url => ({ label: labels[key], url }))),
    ];
    const seen = new Set();
    return candidates.flatMap(candidate => {
      if (!candidate || typeof candidate !== 'object') return [];
      const rawUrl = candidate.url || candidate.href;
      if (typeof rawUrl !== 'string') return [];
      try {
        const url = new URL(rawUrl, STORE_BASE_URL);
        if (url.protocol !== 'https:' || seen.has(url.href)) return [];
        seen.add(url.href);
        const key = candidate.label || candidate.title || '';
        return [{ label: labels[key] || key || 'More information', url: url.href }];
      } catch {
        return [];
      }
    });
  }

  function appendLinksPanel(parent, app, manifest) {
    const links = getAppLinks(app, manifest);
    if (!links.length) return;

    const panel = createDetailPanel('Links', 'detail-links');
    const list = document.createElement('div');
    list.className = 'detail-links-list';
    for (const link of links) {
      const anchor = document.createElement('a');
      anchor.href = link.url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = link.label;
      list.appendChild(anchor);
    }
    panel.appendChild(list);
    parent.appendChild(panel);
  }

  function appendScreenshots(parent, app, pkg) {
    const screenshots = Array.isArray(app.screenshots)
      ? app.screenshots
      : Array.isArray(pkg.manifest?.screenshots) ? pkg.manifest.screenshots : [];
    if (!screenshots.length) return;

    const panel = createDetailPanel('Screenshots', 'detail-screenshots');
    const strip = document.createElement('div');
    strip.className = 'screenshot-strip';
    for (const source of screenshots) {
      const url = packageMediaUrl(source, pkg);
      if (!url) continue;
      const image = document.createElement('img');
      image.src = url;
      image.alt = `${app.name} screenshot`;
      image.loading = 'lazy';
      strip.appendChild(image);
    }
    if (strip.childElementCount) {
      panel.appendChild(strip);
      parent.appendChild(panel);
    }
  }

  function renderAppIcon(container, app) {
    container.replaceChildren();
    const iconUrl = resolveIconUrl(app.icon);

    function showFallback() {
      if (typeof svgIcon === 'function') {
        try {
          container.innerHTML = svgIcon('package', 40);
          return;
        } catch (_) {}
      }
      container.textContent = (app.name || '?')[0].toUpperCase();
    }

    if (!iconUrl) {
      showFallback();
      return;
    }

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
      showFallback();
    };
    container.appendChild(image);
  }

  async function fetchAppList() {
    const res = await fetch(STORE_URL);
    if (!res.ok) throw new Error(`Failed to fetch app list (${res.status})`);
    const apps = await res.json();
    if (!Array.isArray(apps)) throw new Error('App catalog must contain a list of apps.');
    return apps.filter(app =>
      app &&
      typeof app.id === 'string' &&
      typeof app.name === 'string' &&
      typeof app.file === 'string'
    );
  }

  async function fetchAndVerify(app) {
    const pkg = await fetchPackage(app);

    if (!pkg || pkg.novabyte_app !== true) {
      throw new Error('Not a valid .novaapp package.');
    }
    const result = await verifyCatalogPackage(app);

    if (result.revoked) {
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

    return { pkg, verified: result.verified, signer: result.signer };
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
    const card = document.createElement('article');
    card.className = 'app-card';
    card.dataset.id = app.id;

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'app-card-open';
    openButton.setAttribute('aria-label', `View ${app.name} details`);

    const iconWrap = document.createElement('div');
    iconWrap.className = 'app-icon';
    renderAppIcon(iconWrap, app);

    const info = document.createElement('div');
    info.className = 'app-info';

    const titleRow = document.createElement('div');
    titleRow.className = 'app-title-row';

    const name = document.createElement('div');
    name.className = 'app-name';
    name.textContent = app.name;
    titleRow.appendChild(name);
    addVerificationBadge(titleRow, app, 'verified-badge-card');

    const meta = document.createElement('div');
    meta.className = 'app-meta';
    meta.textContent = [app.author, app.version ? `v${app.version}` : '', app.size || '']
      .filter(Boolean)
      .join(' · ');

    const desc = document.createElement('div');
    desc.className = 'app-desc';
    desc.textContent = app.description || 'No description provided.';

    const categories = document.createElement('div');
    categories.className = 'app-card-categories';
    (Array.isArray(app.categories) ? app.categories : []).slice(0, 3).forEach(category => {
      const chip = document.createElement('span');
      chip.className = 'category-chip';
      chip.textContent = formatCategory(category);
      categories.appendChild(chip);
    });

    info.appendChild(titleRow);
    info.appendChild(meta);
    info.appendChild(desc);
    info.appendChild(categories);
    openButton.appendChild(iconWrap);
    openButton.appendChild(info);
    openButton.addEventListener('click', () => showDetails(app));

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'app-btn';
    bindInstallButton(app, btn);
    card.appendChild(openButton);
    card.appendChild(btn);

    return card;
  }

  function formatCategory(category) {
    return String(category || '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, letter => letter.toUpperCase());
  }

  function bindInstallButton(app, button) {
    const installed = isInstalled(app.id);
    button.classList.toggle('btn-uninstall', installed);
    button.classList.toggle('btn-install', !installed);
    button.textContent = installed ? 'Uninstall' : 'Get';
    button.onclick = () => installed
      ? uninstallApp(app, button)
      : installApp(app, button);
  }

  function showDetails(app) {
    if (typeof rerenderCurrentView === 'function') rerenderCurrentView({ detail: app.id });
  }

  registerApp({
    id: STORE_ID,
    name: 'Store',
    version: '3.0.2',
    icon: 'store',
    description: 'Browse, verify, and install apps for NovaByte OS.',
    defaultSize: [1020, 680],
    minSize: [720, 480],

    async init(content) {
      content.replaceChildren();
      content.className = 'store-root';
      content.setAttribute('data-store-app', STORE_ID);
      let allApps = [];
      let activeCategory = 'all';
      let query = '';
      let selectedAppId = null;

      const header = document.createElement('header');
      header.className = 'store-header';
      const brand = document.createElement('div');
      brand.className = 'store-brand';
      brand.innerHTML = '<span class="store-brand-mark" aria-hidden="true">N</span><span><span class="store-title">NovaByte</span><span class="store-brand-subtitle">Store</span></span>';
      const searchWrap = document.createElement('label');
      searchWrap.className = 'store-search-wrap';
      searchWrap.setAttribute('aria-label', 'Search apps');
      searchWrap.innerHTML = '<span class="store-search-icon" aria-hidden="true">⌕</span>';
      const search = document.createElement('input');
      search.type = 'search';
      search.placeholder = 'Search apps and creators';
      search.className = 'store-search';
      search.autocomplete = 'off';
      searchWrap.appendChild(search);
      header.append(brand, searchWrap);

      const page = document.createElement('main');
      page.className = 'store-page';
      const loading = document.createElement('div');
      loading.className = 'store-loading';
      loading.innerHTML = '<span class="store-spinner" aria-hidden="true"></span><span>Loading the app catalog…</span>';
      page.appendChild(loading);
      content.append(header, page);

      function makeCategoryBar() {
        const categories = [...new Set(allApps.flatMap(app =>
          Array.isArray(app.categories) ? app.categories : []
        ))].sort((a, b) => a.localeCompare(b));
        const bar = document.createElement('nav');
        bar.className = 'category-bar';
        bar.setAttribute('aria-label', 'Filter apps by category');
        const entries = [['all', 'Explore', allApps.length], ...categories.map(category => [
          category,
          formatCategory(category),
          allApps.filter(app => app.categories?.includes(category)).length,
        ])];
        for (const [id, label, count] of entries) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = `category-button${activeCategory === id ? ' is-active' : ''}`;
          button.setAttribute('aria-pressed', String(activeCategory === id));
          button.textContent = label;
          const countNode = document.createElement('span');
          countNode.className = 'category-count';
          countNode.textContent = String(count);
          button.appendChild(countNode);
          button.addEventListener('click', () => {
            activeCategory = id;
            renderView();
          });
          bar.appendChild(button);
        }
        return bar;
      }

      function makeSectionHeading(title, subtitle) {
        const wrap = document.createElement('div');
        wrap.className = 'section-heading';
        const text = document.createElement('div');
        const heading = document.createElement('h1');
        heading.textContent = title;
        const note = document.createElement('p');
        note.textContent = subtitle;
        text.append(heading, note);
        wrap.appendChild(text);
        return wrap;
      }

      function renderBrowse() {
        header.classList.remove('detail-header');
        searchWrap.hidden = false;
        page.replaceChildren();
        page.appendChild(makeCategoryBar());

        const normalizedQuery = query.trim().toLowerCase();
        const filtered = allApps.filter(app => {
          const categories = Array.isArray(app.categories) ? app.categories : [];
          const matchesCategory = activeCategory === 'all' || categories.includes(activeCategory);
          const searchable = [app.name, app.description, app.author, app.id, ...categories]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return matchesCategory && (!normalizedQuery || searchable.includes(normalizedQuery));
        });
        const appCount = filtered.length;
        const heading = normalizedQuery
          ? `Results for “${query.trim()}”`
          : activeCategory === 'all'
            ? 'Discover apps'
            : formatCategory(activeCategory);
        page.appendChild(makeSectionHeading(
          heading,
          `${appCount} ${appCount === 1 ? 'app' : 'apps'}${activeCategory === 'all' ? ' available' : ' in this category'}`
        ));

        if (filtered.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'store-empty';
          empty.innerHTML = '<span class="empty-mark" aria-hidden="true">⌕</span>';
          const title = document.createElement('h2');
          title.textContent = allApps.length ? 'No apps found' : 'The catalog is empty';
          const note = document.createElement('p');
          note.textContent = allApps.length
            ? 'Try a different search or choose another category.'
            : 'There are no apps available in the store yet.';
          empty.append(title, note);
          page.appendChild(empty);
          return;
        }

        if (activeCategory === 'all' && !normalizedQuery) {
          const featured = filtered.find(app => app.featured === true) || filtered[0];
          const hero = document.createElement('section');
          hero.className = 'featured-app';
          hero.setAttribute('aria-label', 'Featured app');
          const copy = document.createElement('div');
          copy.className = 'featured-copy';
          const eyebrow = document.createElement('span');
          eyebrow.className = 'featured-eyebrow';
          eyebrow.textContent = 'Featured app';
          const titleRow = document.createElement('div');
          titleRow.className = 'featured-title-row';
          const title = document.createElement('h2');
          title.textContent = featured.name;
          titleRow.appendChild(title);
          addVerificationBadge(titleRow, featured, 'verified-badge-featured');
          const description = document.createElement('p');
          description.textContent = featured.description || 'Discover this app for NovaByte OS.';
          const meta = document.createElement('div');
          meta.className = 'featured-meta';
          meta.textContent = [featured.author, featured.version && `Version ${featured.version}`]
            .filter(Boolean)
            .join(' · ');
          const actions = document.createElement('div');
          actions.className = 'featured-actions';
          const detailsButton = document.createElement('button');
          detailsButton.type = 'button';
          detailsButton.className = 'app-btn btn-install';
          detailsButton.textContent = 'View app';
          detailsButton.addEventListener('click', () => showDetails(featured));
          const featuredIcon = document.createElement('div');
          featuredIcon.className = 'featured-icon';
          renderAppIcon(featuredIcon, featured);
          copy.append(eyebrow, titleRow, description, meta, actions);
          actions.appendChild(detailsButton);
          hero.append(featuredIcon, copy);
          page.appendChild(hero);
        }

        const gridHeading = document.createElement('div');
        gridHeading.className = 'catalog-heading';
        const listTitle = document.createElement('h2');
        listTitle.textContent = normalizedQuery ? 'Apps' : 'All apps';
        const listCount = document.createElement('span');
        listCount.textContent = String(filtered.length);
        gridHeading.append(listTitle, listCount);
        page.appendChild(gridHeading);

        const grid = document.createElement('section');
        grid.className = 'store-grid';
        grid.setAttribute('aria-label', 'Available apps');
        filtered.forEach(app => grid.appendChild(renderCard(app)));
        page.appendChild(grid);
      }

      function renderDetails(app) {
        header.classList.add('detail-header');
        searchWrap.hidden = true;
        page.replaceChildren();

        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'back-button';
        back.innerHTML = '<span aria-hidden="true">←</span> All apps';
        back.addEventListener('click', () => {
          selectedAppId = null;
          renderView();
        });
        page.appendChild(back);

        const detail = document.createElement('article');
        detail.className = 'app-detail';
        const hero = document.createElement('section');
        hero.className = 'detail-hero';
        const icon = document.createElement('div');
        icon.className = 'detail-icon';
        renderAppIcon(icon, app);

        const identity = document.createElement('div');
        identity.className = 'detail-identity';
        const titleRow = document.createElement('div');
        titleRow.className = 'detail-title-row';
        const name = document.createElement('h1');
        name.textContent = app.name;
        titleRow.appendChild(name);
        addVerificationBadge(titleRow, app, 'verified-badge-detail');
        const author = document.createElement('p');
        author.className = 'detail-author';
        author.textContent = app.author ? `by ${app.author}` : 'NovaByte app';
        const categories = document.createElement('div');
        categories.className = 'detail-categories';
        (Array.isArray(app.categories) ? app.categories : []).forEach(category => {
          const chip = document.createElement('span');
          chip.className = 'category-chip';
          chip.textContent = formatCategory(category);
          categories.appendChild(chip);
        });
        identity.append(titleRow, author, categories);

        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'app-btn detail-install';
        bindInstallButton(app, action);
        hero.append(icon, identity, action);
        detail.appendChild(hero);

        const contentGrid = document.createElement('div');
        contentGrid.className = 'detail-content-grid';
        const about = document.createElement('section');
        about.className = 'detail-panel detail-about';
        const aboutTitle = document.createElement('h2');
        aboutTitle.textContent = 'About this app';
        const description = document.createElement('p');
        description.className = 'detail-description';
        description.textContent = app.description || 'The publisher has not provided a description for this app.';
        about.append(aboutTitle, description);

        if (app.releaseNotes) {
          const notesTitle = document.createElement('h3');
          notesTitle.textContent = 'What’s new';
          const notes = document.createElement('p');
          notes.className = 'detail-release-notes';
          notes.textContent = app.releaseNotes;
          about.append(notesTitle, notes);
        }
        contentGrid.appendChild(about);

        const sidebar = document.createElement('aside');
        sidebar.className = 'detail-panel detail-facts';
        const factsTitle = document.createElement('h2');
        factsTitle.textContent = 'App information';
        sidebar.appendChild(factsTitle);
        const facts = [
          ['Version', app.version || '—'],
          ['Publisher', app.author || '—'],
          ['Package', '.novaapp'],
          ['Download size', app.size || 'Shown during download'],
        ];
        if (app.updatedAt) facts.push(['Updated', app.updatedAt]);
        if (app.license) facts.push(['License', app.license]);
        const factsList = document.createElement('dl');
        for (const [label, value] of facts) {
          const row = document.createElement('div');
          row.className = 'detail-fact';
          const term = document.createElement('dt');
          term.textContent = label;
          const descriptionNode = document.createElement('dd');
          descriptionNode.textContent = String(value);
          row.append(term, descriptionNode);
          factsList.appendChild(row);
        }
        sidebar.appendChild(factsList);
        const trustNote = document.createElement('p');
        trustNote.className = 'detail-trust-note';
        trustNote.textContent = 'The package signature, revocation status, and integrity are checked before installation.';
        sidebar.appendChild(trustNote);
        contentGrid.appendChild(sidebar);
        detail.appendChild(contentGrid);

        page.appendChild(detail);
        page.scrollTop = 0;
        fetchPackage(app).then(pkg => {
          if (!detail.isConnected) return;
          const manifest = pkg.manifest || {};
          const releaseNotes = app.releaseNotes || manifest.releaseNotes;
          if (!app.releaseNotes && typeof releaseNotes === 'string' && releaseNotes.trim()) {
            const notes = document.createElement('section');
            notes.className = 'detail-panel detail-release-notes-panel';
            const heading = document.createElement('h2');
            heading.textContent = 'What’s new';
            const content = document.createElement('p');
            content.className = 'detail-release-notes';
            content.textContent = releaseNotes;
            notes.append(heading, content);
            detail.appendChild(notes);
          }
          appendPermissionPanel(detail, manifest);
          appendLinksPanel(detail, app, manifest);
          appendScreenshots(detail, app, pkg);
        }).catch(error => {
          console.warn(`[AppStore] Could not load details for ${app.id}:`, error);
        });
      }

      function renderView(options = {}) {
        if (options.detail !== undefined) selectedAppId = options.detail;
        const selectedApp = allApps.find(app => app.id === selectedAppId);
        if (selectedApp) renderDetails(selectedApp);
        else {
          selectedAppId = null;
          renderBrowse();
        }
      }

      rerenderCurrentView = renderView;
      search.addEventListener('input', () => {
        query = search.value;
        selectedAppId = null;
        renderView();
      });

      // keep install/uninstall buttons in sync if another window (e.g.
      // appmanager) installs or removes something while we're open
      window.addEventListener('storage', event => {
        if (event.key === APPS_KEY) renderView();
      });

      try {
        allApps = await fetchAppList();
        renderView();
      } catch (error) {
        page.replaceChildren();
        const failure = document.createElement('div');
        failure.className = 'store-empty store-error';
        const title = document.createElement('h2');
        title.textContent = 'Could not load the app catalog';
        const message = document.createElement('p');
        message.textContent = error.message;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'app-btn btn-install';
        retry.textContent = 'Try again';
        retry.addEventListener('click', async () => {
          retry.disabled = true;
          retry.textContent = 'Loading…';
          try {
            allApps = await fetchAppList();
            renderView();
          } catch (retryError) {
            message.textContent = retryError.message;
            retry.disabled = false;
            retry.textContent = 'Try again';
          }
        });
        failure.append(title, message, retry);
        page.appendChild(failure);
      }
    },
  });
})();
