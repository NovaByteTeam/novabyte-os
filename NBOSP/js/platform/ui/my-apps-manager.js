/**
 * NovaByte - My Apps Manager
 * ────────────────────────────────────────────────────────────
 * User interface for managing installed applications.
 * Similar to web-app-manager.js but for packaged apps.
 * 
 * @module js/my-apps-manager
 */

const MyAppsManager = (() => {
  let onAppAdded = null;
  let onAppRemoved = null;
  let onAppLaunched = null;

  /**
   * Escape HTML entities to prevent XSS
   */
  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Localised lookup with an inline English fallback.
   *
   * The trusted host installs window._t (NovaI18n) before platform UI loads,
   * so live lookups resolve through the OS catalogues. This module is also
   * consumed in DOM-less environments (Node tooling / unit tests) where no
   * engine exists, and before catalogues are registered (when _t echoes the
   * key) — in both cases the exact original English is rendered from the
   * inline fallback so the output is unchanged.
   */
  function t(key, english, vars) {
    try {
      if (typeof window !== 'undefined' && typeof window._t === 'function') {
        const out = window._t(key, vars);
        if (typeof out === 'string' && out && out !== key) return out;
      }
    } catch (_) { /* fall back to the inline English */ }
    if (!vars) return english;
    return english.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name) => (
      vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : match
    ));
  }

  /**
   * Initialize the manager
   */
  function initialize() {
    console.log('[MyAppsManager] Initialized');

    // Register for app installation events
    if (AppRegistry) {
      AppRegistry.onInstall((app) => {
        if (onAppAdded) onAppAdded(app);
        showInstallNotification(app);
      });

      AppRegistry.onUninstall((app) => {
        if (onAppRemoved) onAppRemoved(app);
        showUninstallNotification(app);
      });
    }
  }

  /**
   * Show install notification
   * @param {object} app - Installed app
   */
  function showInstallNotification(app) {
    if (typeof Notify !== 'undefined') {
      Notify.show({
        title: t('apps.myApps.appInstalledTitle', 'App Installed'),
        body: t('apps.myApps.appInstalledBody', '{{app}} has been installed successfully', { app: app.name }),
        type: 'success',
        appName: 'My Apps'
      });
    }
  }

  /**
   * Show uninstall notification
   * @param {object} app - Uninstalled app
   */
  function showUninstallNotification(app) {
    if (typeof Notify !== 'undefined') {
      Notify.show({
        title: t('apps.myApps.appRemovedTitle', 'App Removed'),
        body: t('apps.myApps.appRemovedBody', '{{app}} has been uninstalled', { app: app.name }),
        type: 'info',
        appName: 'My Apps'
      });
    }
  }

  /**
   * Add a new app (install)
   * @param {object} appData - App data
   * @returns {object} Added app
   */
  function addApp(appData) {
    try {
      const app = AppRegistry?.registerApp(appData);
      return app;
    } catch (error) {
      console.error('[MyAppsManager] Failed to add app:', error);
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'MyAppsManager', category: 'apps', severity: 'error', message: `Failed to add app: ${error?.message || error}` });
      }
      throw error;
    }
  }

  /**
   * Remove an app (uninstall)
   * @param {string} appId - App ID
   * @returns {boolean} Success
   */
  async function removeApp(appId) {
    try {
      if (typeof WM !== 'undefined' && WM.closeWindow && typeof OS !== 'undefined' && OS.windows) {
        const openWindowIds = [];
        for (const [wid, wstate] of OS.windows) {
          if (wstate.appId === appId) openWindowIds.push(wid);
        }
        await Promise.all(openWindowIds.map(wid => WM.closeWindow(wid)));
      }
      try {
        if (typeof AppSandbox !== 'undefined' && AppSandbox.clearAppPartition) {
          await AppSandbox.clearAppPartition(appId);
        }
      } catch (err) {
        console.warn('[MyAppsManager] Failed to clear storage partition for', appId, err);
      }
      try {
        if (typeof AppSandbox !== 'undefined' && AppSandbox.storageClear) {
          await AppSandbox.storageClear(appId);
        }
      } catch (err) {
        console.warn('[MyAppsManager] Failed to clear nova:storage for', appId, err);
      }
      try {
        if (typeof AppSandbox !== 'undefined' && AppSandbox.storageLedger?.removeApp) {
          AppSandbox.storageLedger.removeApp(appId);
        }
      } catch (err) {
        console.warn('[MyAppsManager] Failed to clear storage ledger for', appId, err);
      }
      try {
        if (typeof AppDirs !== 'undefined' && AppDirs.removeAppData) {
          await AppDirs.removeAppData(appId);
        }
      } catch (err) {
        console.warn('[MyAppsManager] Failed to clear app data for', appId, err);
      }
      return AppRegistry?.uninstallApp
        ? await AppRegistry.uninstallApp(appId)
        : false;
    } catch (error) {
      console.error('[MyAppsManager] Failed to remove app:', error);
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'MyAppsManager', category: 'apps', severity: 'error', message: `Failed to remove app ${appId}: ${error?.message || error}`, data: { appId } });
      }
      return false;
    }
  }

  /**
   * Get all installed apps
   * @returns {Array} Array of app objects
   */
  function getAllApps() {
    return (AppRegistry?.getAllApps() || [])
      .filter(app => app.systemService !== true && app.headlessSystemService !== true);
  }

  /**
   * Get app by ID
   * @param {string} appId - App ID
   * @returns {object|null} App object or null
   */
  function getApp(appId) {
    return AppRegistry?.getApp(appId) || null;
  }

  /**
   * Launch an app
   * @param {string} appId - App ID
   * @param {object} options - Launch options
   * @returns {object} Launch result
   */
  function launchApp(appId, options = {}) {
    try {
      const app = AppRegistry?.getApp(appId);
      if (!app) {
        throw new Error(`App not found: ${appId}`);
      }

      // Create window via WM if available
      if (typeof WM !== 'undefined' && !options.noWindow) {
        const window = WM.createWindow(appId, options.windowOptions);
        if (window && onAppLaunched) {
          onAppLaunched({ app, window });
        }
        return { app, window };
      }

      // Otherwise just register launch
      app.launchCount = (app.launchCount || 0) + 1;
      app.lastLaunched = new Date().toISOString();

      if (onAppLaunched) {
        onAppLaunched({ app });
      }

      return { app };
    } catch (error) {
      console.error('[MyAppsManager] Failed to launch app:', error);
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'MyAppsManager', category: 'apps', severity: 'error', message: `Failed to launch ${appId}: ${error?.message || error}`, data: { appId } });
      }
      throw error;
    }
  }

  /**
   * Install app from .novaapp file
   * @param {File|Blob|object} file - Package file or object
   * @param {object} options - Install options
   * @returns {Promise<object>} Installation result
   */
  async function installFromFile(file, options = {}) {
    try {
      let pkg;

      if (typeof file === 'object' && file.novabyte_app) {
        // Already a package object
        pkg = file;
      } else if (typeof File !== 'undefined' && file instanceof File) {
        // File object from input
        const text = await file.text();
        pkg = JSON.parse(text);
      } else if (typeof file === 'string') {
        // JSON string
        pkg = JSON.parse(file);
      } else {
        throw new Error('Invalid package format');
      }

      const mergedOptions = {
        trustStore: (typeof TrustStore !== 'undefined' && TrustStore.list) ? TrustStore.list() : [],
        revocationCheck: (typeof TrustStore !== 'undefined' && TrustStore.isRevoked) ? TrustStore.isRevoked : undefined,
        ...options,
      };
      const result = AppPackage?.installPackage(pkg, mergedOptions);
      return result;
    } catch (error) {
      console.error('[MyAppsManager] Installation failed:', error);
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'MyAppsManager', category: 'apps', severity: 'error', message: `Install from file failed: ${error?.message || error}` });
      }
      throw error;
    }
  }

  /**
   * Install app from URL
   * @param {string} url - Package URL
   * @param {object} options - Install options
   * @returns {Promise<object>} Installation result
   */
  async function installFromUrl(url, options = {}) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const pkg = await response.json();
      const mergedOptions = {
        trustStore: (typeof TrustStore !== 'undefined' && TrustStore.list) ? TrustStore.list() : [],
        revocationCheck: (typeof TrustStore !== 'undefined' && TrustStore.isRevoked) ? TrustStore.isRevoked : undefined,
        ...options,
      };
      const result = AppPackage?.installPackage(pkg, mergedOptions);
      return result;
    } catch (error) {
      console.error('[MyAppsManager] Installation from URL failed:', error);
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'MyAppsManager', category: 'apps', severity: 'error', message: `Install from URL failed: ${error?.message || error}`, data: { url } });
      }
      throw error;
    }
  }

  /**
   * Create a package from app folder
   * @param {string} folderPath - Path to app folder
   * @param {object} options - Package options
   * @returns {Promise<object>} Package object
   */
  /**
   * Show installation UI
   * @param {HTMLElement} container - Container element
   */
  function showInstallUI(container) {
    const html = `
      <div style="padding: 20px;">
        <h2 style="color: #e6edf3; margin-bottom: 20px;">${t('apps.myApps.installTitle', 'Install Application')}</h2>
        
        <div style="margin-bottom: 20px;">
          <label style="color: #8b949e; display: block; margin-bottom: 8px;">
            ${t('apps.myApps.installFromFileLabel', 'Install from .novaapp file:')}
          </label>
          <div style="display: flex; align-items: center; gap: 10px;">
            <button type="button" id="installFileBtn" style="
              background: var(--bg-sunken);
              border: 1px solid var(--border-default);
              border-radius: 6px;
              padding: 8px 12px;
              color: #e6edf3;
              cursor: pointer;
            ">${t('apps.myApps.chooseFile', 'Choose file…')}</button>
            <span id="installFileName" style="color: #8b949e; font-size: 13px;">${t('apps.myApps.noFileSelected', 'No file selected')}</span>
          </div>
        </div>
        
        <div style="margin-bottom: 20px;">
          <label style="color: #8b949e; display: block; margin-bottom: 8px;">
            ${t('apps.myApps.installFromUrlLabel', 'Or install from URL:')}
          </label>
          <input type="text" id="installUrlInput" placeholder="https://example.com/app.novaapp" style="
            background: var(--bg-sunken);
            border: 1px solid var(--border-default);
            border-radius: 6px;
            padding: 8px 12px;
            color: #e6edf3;
            width: 100%;
          ">
        </div>
        
        <button id="installBtn" style="
          background: #58a6ff;
          color: white;
          border: none;
          border-radius: 6px;
          padding: 10px 20px;
          font-size: 14px;
          cursor: pointer;
        ">${t('apps.myApps.install', 'Install')}</button>
        
        <div id="installStatus" style="margin-top: 15px;"></div>
      </div>
    `;

    container.innerHTML = html;

    const installBtn = container.querySelector('#installBtn');
    const fileBtn = container.querySelector('#installFileBtn');
    const fileNameEl = container.querySelector('#installFileName');
    let pickedPackage = null; // JSON text of the chosen .novaapp

    fileBtn.addEventListener('click', async () => {
      const picked = await SystemDialogs.open({
        title: t('apps.myApps.chooseNovaapp', 'Choose .novaapp'),
        filter: (name, isDir) => isDir || /\.(novaapp|json)$/i.test(name),
      });
      if (!picked) return;
      pickedPackage = typeof picked.content === 'string' ? picked.content : picked.content.toString('utf8');
      fileNameEl.textContent = picked.name;
    });
    const urlInput = container.querySelector('#installUrlInput');
    const statusDiv = container.querySelector('#installStatus');

    installBtn.addEventListener('click', async () => {
      statusDiv.innerHTML = '<p style="color: #8b949e;">' + t('apps.myApps.installing', 'Installing...') + '</p>';

      try {
        let result;

        if (pickedPackage) {
          result = await installFromFile(pickedPackage);
        } else if (urlInput.value) {
          result = await installFromUrl(urlInput.value);
        } else {
          throw new Error(t('apps.myApps.selectFileOrUrl', 'Please select a file or enter a URL'));
        }

        statusDiv.innerHTML = `
          <p style="color: #3fb950;">
            ${t('apps.myApps.installedSuccessfully', '✓ Successfully installed {{app}}', { app: escapeHtml(result.app.name) })}
          </p>
        `;

        // Clear inputs
        pickedPackage = null;
        fileNameEl.textContent = t('apps.myApps.noFileSelected', 'No file selected');
        urlInput.value = '';
      } catch (error) {
        statusDiv.innerHTML = `
          <p style="color: #f85149;">
            ${t('apps.myApps.installFailed', '✗ Installation failed: {{message}}', { message: escapeHtml(error.message) })}
          </p>
        `;
      }
    });
  }

  /**
   * Show app list UI
   * @param {HTMLElement} container - Container element
   * @param {object} options - Display options
   */
  function showAppList(container, options = {}) {
    const apps = getAllApps();

    const html = `
      <div style="padding: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
          <h2 style="color: #e6edf3; margin: 0;">${t('apps.myApps.myApps', 'My Apps')}</h2>
          <button id="installAppBtn" style="
            background: #238636;
            color: white;
            border: none;
            border-radius: 6px;
            padding: 8px 16px;
            font-size: 14px;
            cursor: pointer;
          ">${t('apps.myApps.installApp', 'Install App')}</button>
        </div>
        
        ${apps.length === 0 ? `
          <div style="text-align: center; padding: 40px; color: #8b949e;">
            <p>${t('apps.myApps.noAppsInstalled', 'No apps installed yet')}</p>
            <button id="installFirstAppBtn" style="
              margin-top: 15px;
              background: #58a6ff;
              color: white;
              border: none;
              border-radius: 6px;
              padding: 10px 20px;
              cursor: pointer;
            ">${t('apps.myApps.installFirstApp', 'Install Your First App')}</button>
          </div>
        ` : `
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 15px;">
            ${apps.map(app => `
              <div style="
                background: var(--bg-elevated);
                border: 1px solid var(--border-default);
                border-radius: 8px;
                padding: 15px;
              ">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 10px;">
                  <div style="
                    width: 40px;
                    height: 40px;
                    border-radius: 8px;
                    background: var(--accent-muted);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 20px;
                  " data-app-id="${escapeHtml(app.id)}" data-app-icon="${escapeHtml(app.icon || '')}">${/^data:|^https?:\/\//i.test(app.icon || '') ? '' : escapeHtml(app.icon || '📱')}</div>
                  <div>
                    <h3 style="color: #e6edf3; font-size: 14px; margin: 0;">${escapeHtml(app.name)}</h3>
                    <p style="color: #8b949e; font-size: 12px; margin: 0;">v${escapeHtml(app.version)}</p>
                  </div>
                </div>
                
                <p style="color: #8b949e; font-size: 12px; margin-bottom: 15px;">
                  ${escapeHtml(app.description || t('apps.myApps.noDescription', 'No description'))}
                </p>
                
                <div style="display: flex; gap: 8px;">
                  <button class="launch-app-btn" data-app-id="${app.id}" style="
                    flex: 1;
                    background: #58a6ff;
                    color: white;
                    border: none;
                    border-radius: 6px;
                    padding: 8px;
                    font-size: 12px;
                    cursor: pointer;
                  ">${t('apps.myApps.launch', 'Launch')}</button>
                  
                  <button class="app-details-btn" data-app-id="${app.id}" style="
                    background: transparent;
                    color: #8b949e;
                    border: 1px solid var(--border-default);
                    border-radius: 6px;
                    padding: 8px;
                    font-size: 12px;
                    cursor: pointer;
                  ">${t('apps.myApps.details', 'Details')}</button>
                  
                  <button class="uninstall-app-btn" data-app-id="${app.id}" style="
                    background: transparent;
                    color: #f85149;
                    border: 1px solid #f8514944;
                    border-radius: 6px;
                    padding: 8px;
                    font-size: 12px;
                    cursor: pointer;
                  ">${t('apps.myApps.uninstall', 'Uninstall')}</button>
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    `;

    container.innerHTML = html;

    container.querySelectorAll('[data-app-icon]').forEach(el => {
      const raw = el.getAttribute('data-app-icon') || '';
      const files = (function() {
        try {
          // Registry-backed inventory (HKNS/apps/installed) with the legacy
          // localStorage key as fail-soft fallback.
          const apps = (window.NovaAppPackageStore?.loadRegistry?.())
            ?? JSON.parse(localStorage.getItem('nova_installed_apps') || '[]');
          return Array.isArray(apps) ? (apps.find(a => a.id === el.getAttribute('data-app-id'))?.files || {}) : {};
        } catch (_) { return {}; }
      })();
      const encoded = files[raw];
      if (encoded && typeof encoded === 'string') {
        const ext = (raw.split('.').pop() || '').toLowerCase();
        const mime = ext === 'svg' ? 'image/svg+xml'
          : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
          : ext === 'gif' ? 'image/gif'
          : ext === 'webp' ? 'image/webp'
          : ext === 'ico' ? 'image/x-icon'
          : 'image/png';
        // base64 bodies cannot break out of the attribute, and `raw` is
        // HTML-escaped when written into data-app-icon above, but never
        // interpolate package-controlled strings raw into innerHTML:
        // build the node through the DOM API instead of a template.
        const img = document.createElement('img');
        img.src = `data:${mime};base64,${encoded}`;
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:8px;pointer-events:none;';
        img.draggable = false;
        img.alt = '';
        el.replaceChildren(img);
      }
    });

    // Event listeners
    const installAppBtn = container.querySelector('#installAppBtn');
    const installFirstAppBtn = container.querySelector('#installFirstAppBtn');

    if (installAppBtn) {
      installAppBtn.addEventListener('click', () => {
        MyAppsManager.showInstallUI(container);
      });
    }

    if (installFirstAppBtn) {
      installFirstAppBtn.addEventListener('click', () => {
        MyAppsManager.showInstallUI(container);
      });
    }

    container.querySelectorAll('.launch-app-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const appId = e.target.dataset.appId;
        MyAppsManager.launchApp(appId);
      });
    });

    container.querySelectorAll('.app-details-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const appId = e.target.dataset.appId;
        MyAppsManager.showAppDetails(container, appId);
      });
    });

    container.querySelectorAll('.uninstall-app-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const appId = e.target.dataset.appId;
        const uninstallResult = await showModal(
          t('apps.myApps.uninstallAppTitle', 'Uninstall App'),
          t('apps.myApps.uninstallAppBody', 'Uninstall {{app}}?', { app: MyAppsManager.getApp(appId)?.name }),
          [{ label: t('common.cancel', 'Cancel') }, { label: t('apps.myApps.uninstall', 'Uninstall'), value: 'confirm', danger: true }]
        );
        if (uninstallResult === 'confirm') {
          await MyAppsManager.removeApp(appId);
          MyAppsManager.showAppList(container);
        }
      });
    });
  }

  /**
   * Show app details
   * @param {HTMLElement} container - Container element
   * @param {string} appId - App ID
   */
  function showAppDetails(container, appId) {
    const app = getApp(appId);
    if (!app) return;

    const permissions = AppPermissionManager?.getAppPermissions(appId) || [];

    const html = `
      <div style="padding: 20px;">
        <button id="backToListBtn" style="
          background: transparent;
          color: #58a6ff;
          border: 1px solid #58a6ff;
          border-radius: 6px;
          padding: 8px 16px;
          font-size: 14px;
          cursor: pointer;
          margin-bottom: 20px;
        ">${t('apps.myApps.backToList', '← Back to List')}</button>
        
        <div style="display: flex; gap: 20px; margin-bottom: 20px;">
          <div style="
            width: 80px;
            height: 80px;
            border-radius: 12px;
            background: var(--accent-muted);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 40px;
            flex-shrink: 0;
          ">${escapeHtml(app.icon || '📱')}</div>
          
          <div>
            <h1 style="color: #e6edf3; font-size: 24px; margin: 0 0 8px 0;">${escapeHtml(app.name)}</h1>
            <p style="color: #8b949e; font-size: 14px; margin: 0 0 16px 0;">${escapeHtml(app.description || t('apps.myApps.noDescription', 'No description'))}</p>
            
            <div style="display: flex; gap: 15px; font-size: 13px;">
              <span style="color: #8b949e;">${t('apps.myApps.versionLabel', 'Version: ')}<span style="color: #e6edf3;">${escapeHtml(app.version)}</span></span>
              <span style="color: #8b949e;">${t('apps.myApps.authorLabel', 'Author: ')}<span style="color: #e6edf3;">${escapeHtml(app.author)}</span></span>
              <span style="color: #8b949e;">${t('apps.myApps.launchesLabel', 'Launches: ')}<span style="color: #e6edf3;">${app.launchCount || 0}</span></span>
            </div>
          </div>
        </div>
        
        <div style="display: flex; gap: 10px; margin-bottom: 20px;">
          <button id="launchAppBtn" style="
            background: #58a6ff;
            color: white;
            border: none;
            border-radius: 6px;
            padding: 10px 20px;
            font-size: 14px;
            cursor: pointer;
          ">${t('apps.myApps.launchApp', 'Launch App')}</button>
          
          <button id="uninstallAppBtn" style="
            background: transparent;
            color: #f85149;
            border: 1px solid #f8514944;
            border-radius: 6px;
            padding: 10px 20px;
            font-size: 14px;
            cursor: pointer;
          ">${t('apps.myApps.uninstall', 'Uninstall')}</button>
        </div>
        
        <div style="margin-bottom: 20px;">
          <h3 style="color: #e6edf3; font-size: 16px; margin-bottom: 10px;">${t('apps.myApps.permissions', 'Permissions')}</h3>
          ${permissions.length > 0 ? `
            <div style="display: flex; flex-wrap: gap: 8px;">
              ${permissions.map(p => `
                <span style="
                  background: rgba(88, 166, 255, 0.1);
                  color: #58a6ff;
                  padding: 4px 8px;
                  border-radius: 4px;
                  font-size: 12px;
                ">${escapeHtml(p.permission)}</span>
              `).join('')}
            </div>
          ` : `<p style="color: #8b949e;">${t('apps.myApps.noPermissions', 'No permissions requested')}</p>`}
        </div>
        
        <div style="background: var(--bg-sunken); border-radius: 8px; padding: 15px;">
          <h3 style="color: #e6edf3; font-size: 16px; margin-bottom: 10px;">${t('apps.myApps.details', 'Details')}</h3>
          <div style="font-size: 13px; color: #8b949e;">
            <p><strong>${t('apps.myApps.typeLabel', 'Type:')}</strong> <span style="color: #e6edf3;">${escapeHtml(app.type)}</span></p>
            <p><strong>${t('apps.myApps.entryLabel', 'Entry:')}</strong> <span style="color: #e6edf3;">${escapeHtml(app.entry)}</span></p>
            <p><strong>${t('apps.myApps.installedLabel', 'Installed:')}</strong> <span style="color: #e6edf3;">${new Date(app.installedDate).toLocaleDateString()}</span></p>
            ${app.lastLaunched ? `<p><strong>${t('apps.myApps.lastLaunchedLabel', 'Last Launched:')}</strong> <span style="color: #e6edf3;">${new Date(app.lastLaunched).toLocaleDateString()}</span></p>` : ''}
            <p><strong>${t('apps.myApps.verifiedLabel', 'Verified:')}</strong> <span style="color: ${app.verified ? '#3fb950' : '#d29922'}">${app.verified ? t('apps.myApps.yes', 'Yes') : t('apps.myApps.no', 'No')}</span></p>
          </div>
        </div>
      </div>
    `;

    container.innerHTML = html;

    container.querySelector('#backToListBtn').addEventListener('click', () => {
      MyAppsManager.showAppList(container);
    });

    container.querySelector('#launchAppBtn').addEventListener('click', () => {
      MyAppsManager.launchApp(appId);
    });

    container.querySelector('#uninstallAppBtn').addEventListener('click', async () => {
      const uninstallResult = await showModal(
        t('apps.myApps.uninstallAppTitle', 'Uninstall App'),
        t('apps.myApps.uninstallAppBody', 'Uninstall {{app}}?', { app: app.name }),
        [{ label: t('common.cancel', 'Cancel') }, { label: t('apps.myApps.uninstall', 'Uninstall'), value: 'confirm', danger: true }]
      );
      if (uninstallResult === 'confirm') {
        await MyAppsManager.removeApp(appId);
        MyAppsManager.showAppList(container);
      }
    });
  }

  /**
   * Register callback for app added
   * @param {function} callback - Callback function
   */
  function onAdd(callback) {
    onAppAdded = callback;
  }

  /**
   * Register callback for app removed
   * @param {function} callback - Callback function
   */
  function onRemove(callback) {
    onAppRemoved = callback;
  }

  /**
   * Register callback for app launched
   * @param {function} callback - Callback function
   */
  function onLaunch(callback) {
    onAppLaunched = callback;
  }

  /**
   * Get app statistics
   * @returns {object} Statistics
   */
  function getStats() {
    return AppRegistry?.getStats() || {
      totalApps: 0,
      totalLaunches: 0,
      byCategory: {},
      verifiedApps: 0
    };
  }

  return {
    initialize,
    addApp,
    removeApp,
    getApp,
    getAllApps,
    launchApp,
    installFromFile,
    installFromUrl,
    showInstallUI,
    showAppList,
    showAppDetails,
    onAdd,
    onRemove,
    onLaunch,
    getStats
  };
})();

// Auto-initialize on load
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => MyAppsManager.initialize());
  } else {
    MyAppsManager.initialize();
  }
}

// Export for Node.js/CommonJS
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MyAppsManager;
}