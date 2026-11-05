
/**
 * NovaByte OS - App Permission Manager
 * ────────────────────────────────────────────────────────────
 * Manages app permission requests, user consent, and
 * permission enforcement.
 * 
 * @module js/app-permission-manager
 */

const AppPermissionManager = (() => {
  const PERMISSION_TYPES = {
    // File system permissions
    FS_READ: 'fs:read',
    FS_WRITE: 'fs:write',
    FS_DELETE: 'fs:delete',
    FS_METADATA: 'fs:metadata',
    
    // Network permissions
    NET_INTERNAL: 'net:internal',
    NET_EXTERNAL: 'net:external',
    NET_WEBSOCKET: 'net:websocket',
    
    // Email permissions
    MAIL_READ: 'mail:read',
    MAIL_WRITE: 'mail:write',
    MAIL_SEND: 'mail:send',
    MAIL_DELETE: 'mail:delete',
    
    // Calendar permissions
    CALENDAR_READ: 'calendar:read',
    CALENDAR_WRITE: 'calendar:write',
    CALENDAR_DELETE: 'calendar:delete',
    
    // Contacts permissions
    CONTACTS_READ: 'contacts:read',
    CONTACTS_WRITE: 'contacts:write',
    
    // Device permissions
    DEVICE_NOTIFICATIONS: 'device:notifications',
    DEVICE_GEOLOCATION: 'device:geolocation',
    DEVICE_CAMERA: 'device:camera',
    DEVICE_MICROPHONE: 'device:microphone',
    
    // System permissions
    SYSTEM_INFO: 'system:info',
    SYSTEM_SETTINGS: 'system:settings',
    SYSTEM_APPS: 'system:apps',
    
    // Data permissions
    DATA_EXPORT: 'data:export',
    DATA_BACKUP: 'data:backup',
    
    // Admin permissions
    ADMIN_USERS: 'admin:users',
    ADMIN_SYSTEM: 'admin:system',
    ADMIN_AUDIT: 'admin:audit'
  };

  const PERMISSION_CATEGORIES = {
    [PERMISSION_TYPES.FS_READ]: { category: 'filesystem', risk: 'medium' },
    [PERMISSION_TYPES.FS_WRITE]: { category: 'filesystem', risk: 'high' },
    [PERMISSION_TYPES.FS_DELETE]: { category: 'filesystem', risk: 'critical' },
    [PERMISSION_TYPES.NET_INTERNAL]: { category: 'network', risk: 'low' },
    [PERMISSION_TYPES.NET_EXTERNAL]: { category: 'network', risk: 'medium' },
    [PERMISSION_TYPES.MAIL_READ]: { category: 'email', risk: 'high' },
    [PERMISSION_TYPES.MAIL_WRITE]: { category: 'email', risk: 'critical' },
    [PERMISSION_TYPES.DEVICE_CAMERA]: { category: 'device', risk: 'critical' },
    [PERMISSION_TYPES.DEVICE_MICROPHONE]: { category: 'device', risk: 'critical' },
    [PERMISSION_TYPES.ADMIN_SYSTEM]: { category: 'admin', risk: 'critical' }
  };

  const STORAGE_KEY = 'nova_app_permissions';
  const consentLog = [];
  let permissionGrants = new Map();

  /**
   * Initialize permission manager
   */
  function initialize() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) {
        console.warn('[AppPermissionManager] localStorage not available, using in-memory storage');
        permissionGrants = new Map();
        return;
      }
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const grants = JSON.parse(stored);
        grants.forEach(grant => {
          const key = `${grant.appId}:${grant.permission}`;
          permissionGrants.set(key, grant);
        });
      }
      console.log('[AppPermissionManager] Initialized');
    } catch (error) {
      if (error.name === 'SecurityError' || error.message.includes('Forbidden')) {
        console.warn('[AppPermissionManager] localStorage access denied (sandboxed context), using in-memory storage');
      } else {
        console.error('[AppPermissionManager] Failed to initialize:', error);
      }
      permissionGrants = new Map();
    }
  }

  /**
   * Check if a permission is granted for an app
   * @param {string} permission - Permission type
   * @param {string} appId - App ID
   * @returns {boolean} Is granted
   */
  function isGranted(permission, appId) {
    const key = `${appId}:${permission}`;
    const grant = permissionGrants.get(key);
    
    if (!grant) {
      return false;
    }
    
    // Check if grant has expired
    if (grant.expiresAt && new Date(grant.expiresAt) < new Date()) {
      permissionGrants.delete(key);
      saveToStorage();
      return false;
    }
    
    return grant.granted;
  }

  /**
   * Request a permission from the user
   * @param {string} permission - Permission type
   * @param {string} appId - App ID
   * @param {object} options - Request options
   * @returns {Promise<boolean>} Whether permission was granted
   */
  async function requestPermission(permission, appId, options = {}) {
    // Check if already granted
    if (isGranted(permission, appId)) {
      return true;
    }
    
    // Get app info
    const app = AppRegistry?.getApp(appId);
    const appName = app?.name || appId;
    
    // Get permission info
    const category = PERMISSION_CATEGORIES[permission];
    const riskLevel = category?.risk || 'low';
    
    // Show permission dialog
    const granted = await showPermissionDialog({
      permission,
      appId,
      appName,
      riskLevel,
      reason: options.reason,
      permanent: options.permanent !== false
    });
    
    if (granted) {
      grantPermission(permission, appId, {
        permanent: options.permanent !== false,
        reason: options.reason
      });
    }
    
    return granted;
  }

  /**
   * Grant a permission to an app
   * @param {string} permission - Permission type
   * @param {string} appId - App ID
   * @param {object} options - Grant options
   */
  function grantPermission(permission, appId, options = {}) {
    const key = `${appId}:${permission}`;
    const grant = {
      appId,
      permission,
      granted: true,
      grantedAt: new Date().toISOString(),
      grantedBy: 'user',
      permanent: options.permanent !== false,
      expiresAt: options.permanent === false 
        ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours for temporary
        : null,
      reason: options.reason || null
    };
    
    permissionGrants.set(key, grant);
    saveToStorage();
    
    // Log consent
    consentLog.push({
      ...grant,
      timestamp: new Date().toISOString()
    });
    
    console.log(`[AppPermissionManager] Granted ${permission} to ${appId}`);
  }

  /**
   * Revoke a permission from an app
   * @param {string} permission - Permission type
   * @param {string} appId - App ID
   */
  function revokePermission(permission, appId) {
    const key = `${appId}:${permission}`;
    permissionGrants.delete(key);
    saveToStorage();
    console.log(`[AppPermissionManager] Revoked ${permission} from ${appId}`);
  }

  /**
   * Revoke all permissions for an app
   * @param {string} appId - App ID
   */
  function revokeAllPermissions(appId) {
    for (const [key] of permissionGrants) {
      if (key.startsWith(`${appId}:`)) {
        permissionGrants.delete(key);
      }
    }
    saveToStorage();
    console.log(`[AppPermissionManager] Revoked all permissions for ${appId}`);
  }

  /**
   * Get all permissions for an app
   * @param {string} appId - App ID
   * @returns {Array} Array of permission grants
   */
  function getAppPermissions(appId) {
    const permissions = [];
    for (const [key, grant] of permissionGrants) {
      if (key.startsWith(`${appId}:`)) {
        permissions.push(grant);
      }
    }
    return permissions;
  }

  /**
   * Show permission consent dialog
   * @param {object} options - Dialog options
   * @returns {Promise<boolean>} Whether permission was granted
   */
  function showPermissionDialog(options) {
    return new Promise((resolve) => {
      // Create dialog overlay
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100000;
        backdrop-filter: blur(4px);
      `;
      
      // Risk color
      const riskColors = {
        low: '#3fb950',
        medium: '#d29922',
        high: '#f0883e',
        critical: '#f85149'
      };
      const riskColor = riskColors[options.riskLevel] || riskColors.low;
      
      // Dialog content
      overlay.innerHTML = `
        <div style="
          background: #0e121c;
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 12px;
          padding: 24px;
          max-width: 480px;
          width: 90%;
          box-shadow: 0 32px 80px rgba(0,0,0,0.6);
        ">
          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
            <div style="
              width: 40px;
              height: 40px;
              border-radius: 8px;
              background: ${riskColor}22;
              display: flex;
              align-items: center;
              justify-content: center;
              font-size: 20px;
            ">
              ${options.riskLevel === 'critical' ? '⚠' : 
                options.riskLevel === 'high' ? '🔒' : 
                options.riskLevel === 'medium' ? '🛡' : '✅'}
            </div>
            <div>
              <h3 style="color: #e6edf3; font-size: 16px; margin: 0;">Permission Request</h3>
              <p style="color: #8b949e; font-size: 12px; margin: 0;">${options.appName}</p>
            </div>
          </div>
          
          <div style="margin-bottom: 16px;">
            <p style="color: #e6edf3; font-size: 14px; margin-bottom: 8px;">
              <strong>${options.permission}</strong>
            </p>
            <p style="color: #8b949e; font-size: 13px; margin: 0;">
              ${options.reason || 'This app wants to access this permission.'}
            </p>
          </div>
          
          <div style="
            background: rgba(255,255,255,0.05);
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 16px;
          ">
            <p style="color: #8b949e; font-size: 12px; margin: 0;">
              <strong>Risk Level:</strong> 
              <span style="color: ${riskColor}">${options.riskLevel.toUpperCase()}</span>
            </p>
            <p style="color: #8b949e; font-size: 12px; margin: 0;">
              <strong>Category:</strong> ${PERMISSION_CATEGORIES[options.permission]?.category || 'general'}
            </p>
          </div>
          
          <div style="display: flex; gap: 12px;">
            <button id="denyBtn" style="
              flex: 1;
              padding: 12px 20px;
              border: 1px solid rgba(255,255,255,0.1);
              border-radius: 8px;
              background: transparent;
              color: #8b949e;
              font-size: 14px;
              cursor: pointer;
              transition: all 0.15s;
            ">Deny</button>
            <button id="grantBtn" style="
              flex: 1;
              padding: 12px 20px;
              border: none;
              border-radius: 8px;
              background: #58a6ff;
              color: white;
              font-size: 14px;
              font-weight: 600;
              cursor: pointer;
              transition: all 0.15s;
            ">Grant Permission</button>
          </div>
        </div>
      `;
      
      document.body.appendChild(overlay);
      
      const cleanup = () => {
        document.body.removeChild(overlay);
      };
      
      overlay.querySelector('#denyBtn').addEventListener('click', () => {
        cleanup();
        resolve(false);
      });
      
      overlay.querySelector('#grantBtn').addEventListener('click', () => {
        cleanup();
        resolve(true);
      });
    });
  }

  /**
   * Save permissions to storage
   */
  function saveToStorage() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) {
        return; // Silently skip in sandboxed contexts
      }
      const grants = Array.from(permissionGrants.values());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(grants));
    } catch (error) {
      if (error.name === 'SecurityError' || error.message.includes('Forbidden')) {
        return; // Silently skip in sandboxed contexts
      }
      console.error('[AppPermissionManager] Failed to save:', error);
    }
  }

  /**
   * Get consent log
   * @returns {Array} Consent log entries
   */
  function getConsentLog() {
    return [...consentLog];
  }

  /**
   * Get permission statistics
   * @returns {object} Statistics
   */
  function getStats() {
    const grants = Array.from(permissionGrants.values());
    return {
      totalGrants: grants.length,
      byCategory: grants.reduce((cats, grant) => {
        const cat = PERMISSION_CATEGORIES[grant.permission]?.category || 'other';
        cats[cat] = (cats[cat] || 0) + 1;
        return cats;
      }, {}),
      byRisk: grants.reduce((risks, grant) => {
        const risk = PERMISSION_CATEGORIES[grant.permission]?.risk || 'low';
        risks[risk] = (risks[risk] || 0) + 1;
        return risks;
      }, {})
    };
  }

  return {
    initialize,
    isGranted,
    requestPermission,
    grantPermission,
    revokePermission,
    revokeAllPermissions,
    getAppPermissions,
    getConsentLog,
    getStats,
    PERMISSION_TYPES,
    PERMISSION_CATEGORIES
  };
})();

// Auto-initialize on load
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AppPermissionManager.initialize());
  } else {
    AppPermissionManager.initialize();
  }
}

// Export for Node.js/CommonJS
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AppPermissionManager;
}
