/**
 * NovaByte - App Registry
 * ────────────────────────────────────────────────────────────
 * Manages installed applications, registration with OS.apps,
 * and app lifecycle (install, uninstall, update).
 * 
 * @module js/app-registry
 */

const AppRegistry = (() => {
  const STORAGE_KEY = 'nova_installed_apps';
  let installedApps = new Map();
  let onAppInstalled = null;
  let onAppUninstalled = null;

  /**
   * Initialize app registry
   */
  function initialize() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) {
        console.warn('[AppRegistry] localStorage not available, using in-memory storage');
        installedApps = new Map();
        return;
      }
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const apps = JSON.parse(stored);
        apps.forEach(app => installedApps.set(app.id, app));
      }
      console.log(`[AppRegistry] Loaded ${installedApps.size} installed apps`);
    } catch (error) {
      if (error.name === 'SecurityError' || error.message.includes('Forbidden')) {
        console.warn('[AppRegistry] localStorage access denied (sandboxed context), using in-memory storage');
      } else {
        console.error('[AppRegistry] Failed to initialize:', error);
      }
      installedApps = new Map();
    }
  }

  /**
   * Register an app with the OS
   * @param {object} appConfig - App configuration object
   * @returns {object} Registered app
   */
  function registerApp(appConfig) {
    if (!appConfig.id || !appConfig.name) {
      throw new Error('App must have id and name');
    }

    const app = {
      id: appConfig.id,
      name: appConfig.name,
      icon: appConfig.icon || 'app-window',
      description: appConfig.description || '',
      version: appConfig.version || '1.0.0',
      author: appConfig.author || 'Unknown',
      type: appConfig.type || 'webapp',
      entry: appConfig.entry || 'index.html',
      permissions: appConfig.permissions || [],
      optionalPermissions: appConfig.optionalPermissions || [],
      defaultSize: appConfig.defaultSize || [800, 600],
      minSize: appConfig.minSize || [400, 300],
      maxSize: appConfig.maxSize || null,
      resizable: appConfig.resizable !== false,
      frame: appConfig.frame !== false,
      sandbox: appConfig.sandbox || {
        allowSameOrigin: true,
        allowScripts: true,
        allowForms: true,
        allowPopups: false
      },
      categories: appConfig.categories || ['other'],
      installedDate: appConfig.installedDate || new Date().toISOString(),
      lastLaunched: appConfig.lastLaunched || null,
      launchCount: appConfig.launchCount || 0,
      source: appConfig.source || 'local',
      signature: appConfig.signature || null,
      verified: appConfig.verified || false,
      ...appConfig
    };

    // Register with OS.apps if available
    if (typeof OS !== 'undefined' && OS.apps) {
      OS.apps[app.id] = {
        id: app.id,
        name: app.name,
        icon: app.icon,
        description: app.description,
        defaultSize: app.defaultSize,
        minSize: app.minSize,
        init: (content, state, options) => {
          return AppRegistry.launchApp(app.id, content, state, options);
        },
        onDrop: appConfig.onDrop,
        onClose: appConfig.onClose
      };
    }

    installedApps.set(app.id, app);
    saveToStorage();
    console.log(`[AppRegistry] Registered app: ${app.name} (${app.id}) v${app.version}`);

    if (onAppInstalled) {
      onAppInstalled(app);
    }

    return app;
  }

  /**
   * Unregister an app
   * @param {string} appId - App ID to unregister
   * @returns {boolean} Success status
   */
  function unregisterApp(appId) {
    const app = installedApps.get(appId);
    if (!app) {
      return false;
    }

    if (typeof OS !== 'undefined' && OS.apps) {
      delete OS.apps[appId];
    }

    installedApps.delete(appId);
    saveToStorage();
    console.log(`[AppRegistry] Unregistered app: ${appId}`);

    if (onAppUninstalled) {
      onAppUninstalled(app);
    }

    return true;
  }

  /**
   * Launch an app
   * @param {string} appId - App ID to launch
   * @param {HTMLElement} content - Content container
   * @param {object} state - Window state
   * @param {object} options - Launch options
   * @returns {object} Launch result
   */
  function launchApp(appId, content, state, options) {
    const app = installedApps.get(appId);
    if (!app) {
      throw new Error(`App not found: ${appId}`);
    }

    if (!checkPermissions(app)) {
      throw new Error(`Missing required permissions for ${appId}`);
    }

    app.launchCount = (app.launchCount || 0) + 1;
    app.lastLaunched = new Date().toISOString();
    saveToStorage();

    console.log(`[AppRegistry] Launching app: ${app.name} (${appId})`);

    return AppSandbox.launch(app, content, state, options);
  }

  /**
   * Check if app has required permissions
   * @param {object} app - App object
   * @returns {boolean} Has permissions
   */
  function checkPermissions(app) {
    for (const perm of app.permissions) {
      if (!AppPermissionManager.isGranted(perm, app.id)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get app by ID
   * @param {string} appId - App ID
   * @returns {object|null} App object or null
   */
  function getApp(appId) {
    return installedApps.get(appId) || null;
  }

  /**
   * Get all installed apps
   * @returns {Array} Array of app objects
   */
  function getAllApps() {
    return Array.from(installedApps.values());
  }

  /**
   * Get apps by category
   * @param {string} category - Category name
   * @returns {Array} Filtered apps
   */
  function getAppsByCategory(category) {
    return Array.from(installedApps.values()).filter(
      app => app.categories.includes(category)
    );
  }

  /**
   * Save registry to storage
   */
  function saveToStorage() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) {
        return; // Silently skip in sandboxed contexts
      }
      const apps = Array.from(installedApps.values());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(apps));
    } catch (error) {
      if (error.name === 'SecurityError' || error.message.includes('Forbidden')) {
        return; // Silently skip in sandboxed contexts
      }
      console.error('[AppRegistry] Failed to save:', error);
    }
  }

  /**
   * Register callback for app installed
   * @param {function} callback - Callback function
   */
  function onInstall(callback) {
    onAppInstalled = callback;
  }

  /**
   * Register callback for app uninstalled
   * @param {function} callback - Callback function
   */
  function onUninstall(callback) {
    onAppUninstalled = callback;
  }

  /**
   * Get app statistics
   * @returns {object} Statistics object
   */
  function getStats() {
    const apps = Array.from(installedApps.values());
    return {
      totalApps: apps.length,
      totalLaunches: apps.reduce((sum, app) => sum + (app.launchCount || 0), 0),
      byCategory: apps.reduce((cats, app) => {
        app.categories.forEach(cat => {
          cats[cat] = (cats[cat] || 0) + 1;
        });
        return cats;
      }, {}),
      verifiedApps: apps.filter(app => app.verified).length
    };
  }

  return {
    initialize,
    registerApp,
    unregisterApp,
    launchApp,
    getApp,
    getAllApps,
    getAppsByCategory,
    checkPermissions,
    onInstall,
    onUninstall,
    getStats
  };
})();

// Auto-initialize on load
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AppRegistry.initialize());
  } else {
    AppRegistry.initialize();
  }
}

// Export for Node.js/CommonJS
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AppRegistry;
}
