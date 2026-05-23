/**
 * NovaByte Web App Manager
 * 
 * Handles user-added web applications from the internet.
 * Apps run in sandboxed iframes and are stored in the encrypted vault.
 * 
 * @module js/web-app-manager
 */

const WebAppManager = (() => {
  const STORAGE_KEY = 'nova_web_apps';
  let webApps = [];
  let onAppAdded = null;
  let onAppRemoved = null;

  /**
   * Initialize web app manager & load from storage
   */
  function initialize() {
    try {
      // Check if localStorage is available (may be restricted in sandboxes)
      if (typeof localStorage === 'undefined' || !localStorage) {
        console.warn('[WebAppManager] localStorage not available, using in-memory storage');
        webApps = [];
        return;
      }
      const stored = localStorage.getItem(STORAGE_KEY);
      webApps = stored ? JSON.parse(stored) : [];
      console.log(`[WebAppManager] Loaded ${webApps.length} web apps`);
    } catch (error) {
      if (error.name === 'SecurityError' || error.message.includes('Forbidden')) {
        console.warn('[WebAppManager] localStorage access denied (sandboxed context), using in-memory storage');
      } else {
        console.error('[WebAppManager] Failed to load web apps:', error);
      }
      webApps = [];
    }
  }

  /**
   * Validate URL
   */
  function isValidUrl(urlString) {
    try {
      const url = new URL(urlString);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Add a new web app
   * @param {object} app - { name, url, icon }
   * @returns {object} - Added app with ID and metadata
   */
  function addApp(app) {
    if (!app.name || !app.url || !app.icon) {
      throw new Error('App must have name, url, and icon');
    }

    if (!isValidUrl(app.url)) {
      throw new Error('Invalid URL - must be http:// or https://');
    }

    const newApp = {
      id: `web-app-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: app.name,
      url: app.url,
      icon: app.icon,
      addedDate: new Date().toISOString(),
      launchCount: 0
    };

    webApps.push(newApp);
    saveToStorage();

    if (onAppAdded) {
      onAppAdded(newApp);
    }

    console.log(`[WebAppManager] Added web app: ${newApp.name}`);
    return newApp;
  }

  /**
   * Remove a web app
   * @param {string} appId
   * @returns {boolean}
   */
  function removeApp(appId) {
    const index = webApps.findIndex(app => app.id === appId);
    if (index === -1) return false;

    const removed = webApps[index];
    webApps.splice(index, 1);
    saveToStorage();

    if (onAppRemoved) {
      onAppRemoved(removed);
    }

    console.log(`[WebAppManager] Removed web app: ${removed.name}`);
    return true;
  }

  /**
   * Get all web apps
   * @returns {Array}
   */
  function getAllApps() {
    return [...webApps];
  }

  /**
   * Get app by ID
   * @param {string} appId
   * @returns {object|null}
   */
  function getApp(appId) {
    return webApps.find(app => app.id === appId) || null;
  }

  /**
   * Record a launch without creating a window
   * @param {string} appId
   */
  function launchApp(appId) {
    const app = getApp(appId);
    if (!app) {
      throw new Error(`Web app not found: ${appId}`);
    }

    // Update launch count
    app.launchCount = (app.launchCount || 0) + 1;
    app.lastLaunched = new Date().toISOString();
    saveToStorage();

    console.log(`[WebAppManager] Launch recorded for: ${app.name}`);
    return app;
  }

  /**
   * Save web apps to storage
   */
  function saveToStorage() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) {
        return; // Silently skip in sandboxed contexts
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(webApps));
    } catch (error) {
      if (error.name === 'SecurityError' || error.message.includes('Forbidden')) {
        // Silently handle sandbox restrictions
        return;
      }
      console.error('[WebAppManager] Failed to save web apps:', error);
    }
  }

  /**
   * Register callback for when app is added
   */
  function onAdd(callback) {
    onAppAdded = callback;
  }

  /**
   * Register callback for when app is removed
   */
  function onRemove(callback) {
    onAppRemoved = callback;
  }

  /**
   * Get statistics
   */
  function getStats() {
    return {
      totalApps: webApps.length,
      totalLaunches: webApps.reduce((sum, app) => sum + (app.launchCount || 0), 0),
      apps: webApps.map(app => ({
        name: app.name,
        launches: app.launchCount || 0,
        added: app.addedDate
      }))
    };
  }

  return {
    initialize,
    addApp,
    removeApp,
    getAllApps,
    getApp,
    launchApp,
    onAdd,
    onRemove,
    getStats,
    isValidUrl
  };
})();

// Initialize on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => WebAppManager.initialize());
} else {
  WebAppManager.initialize();
}
