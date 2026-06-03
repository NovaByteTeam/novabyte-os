/**
 * NovaByte - App Permission Manager
 * ────────────────────────────────────────────────────────────
 *
 * SECURITY FIXES applied:
 *  [1] Permission grants are HMAC-signed before writing to localStorage.
 *      On load, the HMAC is verified; tampered entries are discarded.
 *      The HMAC key is derived once per session from crypto.getRandomValues
 *      and stored only in memory — so grants cannot be pre-forged across
 *      sessions without the session key.
 *
 * @module js/app-permission-manager
 */

const AppPermissionManager = (() => {
  // ─── Permission catalogue (unchanged) ──────────────────────────────────────
  const PERMISSION_TYPES = {
    FS_READ: 'fs:read', FS_WRITE: 'fs:write', FS_DELETE: 'fs:delete',
    FS_METADATA: 'fs:metadata',
    NET_INTERNAL: 'net:internal', NET_EXTERNAL: 'net:external',
    NET_WEBSOCKET: 'net:websocket',
    MAIL_READ: 'mail:read', MAIL_WRITE: 'mail:write',
    MAIL_SEND: 'mail:send', MAIL_DELETE: 'mail:delete',
    CALENDAR_READ: 'calendar:read', CALENDAR_WRITE: 'calendar:write',
    CALENDAR_DELETE: 'calendar:delete',
    CONTACTS_READ: 'contacts:read', CONTACTS_WRITE: 'contacts:write',
    DEVICE_NOTIFICATIONS: 'device:notifications',
    DEVICE_GEOLOCATION: 'device:geolocation',
    DEVICE_CAMERA: 'device:camera',
    DEVICE_MICROPHONE: 'device:microphone',
    SYSTEM_INFO: 'system:info', SYSTEM_SETTINGS: 'system:settings',
    SYSTEM_APPS: 'system:apps',
    DATA_EXPORT: 'data:export', DATA_BACKUP: 'data:backup',
    ADMIN_USERS: 'admin:users', ADMIN_SYSTEM: 'admin:system',
    ADMIN_AUDIT: 'admin:audit'
  };

  const PERMISSION_CATEGORIES = {
    'fs:read':              { category: 'filesystem', risk: 'medium' },
    'fs:write':             { category: 'filesystem', risk: 'high' },
    'fs:delete':            { category: 'filesystem', risk: 'critical' },
    'net:internal':         { category: 'network',    risk: 'low' },
    'net:external':         { category: 'network',    risk: 'medium' },
    'mail:read':            { category: 'email',      risk: 'high' },
    'mail:write':           { category: 'email',      risk: 'critical' },
    'device:camera':        { category: 'device',     risk: 'critical' },
    'device:microphone':    { category: 'device',     risk: 'critical' },
    'admin:system':         { category: 'admin',      risk: 'critical' }
  };

  const STORAGE_KEY = 'nova_app_permissions';
  const consentLog = [];
  let permissionGrants = new Map();

  // ─── FIX [1]: Per-session HMAC key ──────────────────────────────────────────
  // Generated fresh on every page load, never written to disk.
  // Grants signed with a previous session's key are rejected on reload,
  // which is the correct behaviour: grants should be re-requested each session
  // unless the app chooses to persist them with a server-side mechanism.
  let _hmacKey = null;

  async function _getHmacKey() {
    if (_hmacKey) return _hmacKey;
    _hmacKey = await crypto.subtle.generateKey(
      { name: 'HMAC', hash: 'SHA-256' },
      false,   // not extractable
      ['sign', 'verify']
    );
    return _hmacKey;
  }

  async function _sign(grant) {
    const key  = await _getHmacKey();
    const data = new TextEncoder().encode(JSON.stringify({
      appId:      grant.appId,
      permission: grant.permission,
      granted:    grant.granted,
      grantedAt:  grant.grantedAt,
      permanent:  grant.permanent,
      expiresAt:  grant.expiresAt
    }));
    const sig = await crypto.subtle.sign('HMAC', key, data);
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  async function _verify(grant) {
    try {
      const expected = await _sign(grant);
      return grant._sig === expected;
    } catch (_) {
      return false;
    }
  }

  // ─── Storage helpers ─────────────────────────────────────────────────────────

  async function saveToStorage() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return;
      const grants = [];
      for (const grant of permissionGrants.values()) {
        const sig = await _sign(grant);
        grants.push({ ...grant, _sig: sig });
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(grants));
    } catch (error) {
      if (error.name === 'SecurityError') return;
      console.error('[AppPermissionManager] Failed to save:', error);
    }
  }

  async function initialize() {
    try {
      await _getHmacKey(); // warm up key
      if (typeof localStorage === 'undefined' || !localStorage) {
        console.warn('[AppPermissionManager] localStorage not available, using in-memory storage');
        return;
      }
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return;

      const grants = JSON.parse(stored);
      let rejected = 0;
      for (const grant of grants) {
        // FIX [1]: Verify HMAC before trusting stored grant.
        // Grants from a previous session will fail (different key) and are
        // silently dropped — the app will re-request them as needed.
        const valid = await _verify(grant);
        if (!valid) { rejected++; continue; }
        const key = `${grant.appId}:${grant.permission}`;
        // Remove the signature before storing in memory (it was only for verification)
        const { _sig, ...cleanGrant } = grant;
        permissionGrants.set(key, cleanGrant);
      }
      if (rejected > 0) {
        console.warn(`[AppPermissionManager] Discarded ${rejected} tampered/stale grant(s)`);
      }
      console.log('[AppPermissionManager] Initialized');
    } catch (error) {
      if (error.name === 'SecurityError') {
        console.warn('[AppPermissionManager] localStorage access denied (sandboxed), using in-memory storage');
      } else {
        console.error('[AppPermissionManager] Failed to initialize:', error);
      }
      permissionGrants = new Map();
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  function isGranted(permission, appId) {
    const key   = `${appId}:${permission}`;
    const grant = permissionGrants.get(key);
    if (!grant) return false;
    if (grant.expiresAt && new Date(grant.expiresAt) < new Date()) {
      permissionGrants.delete(key);
      saveToStorage();
      return false;
    }
    return grant.granted;
  }

  async function requestPermission(permission, appId, options = {}) {
    if (isGranted(permission, appId)) return true;
    const app     = AppRegistry?.getApp(appId);
    const appName = app?.name || appId;
    const category  = PERMISSION_CATEGORIES[permission];
    const riskLevel = category?.risk || 'low';

    const granted = await showPermissionDialog({
      permission, appId, appName, riskLevel,
      reason:    options.reason,
      permanent: options.permanent !== false
    });

    if (granted) {
      await grantPermission(permission, appId, {
        permanent: options.permanent !== false,
        reason:    options.reason
      });
    }
    return granted;
  }

  async function grantPermission(permission, appId, options = {}) {
    const key   = `${appId}:${permission}`;
    const grant = {
      appId, permission,
      granted:    true,
      grantedAt:  new Date().toISOString(),
      grantedBy:  'user',
      permanent:  options.permanent !== false,
      expiresAt:  options.permanent === false
        ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        : null,
      reason: options.reason || null
    };
    permissionGrants.set(key, grant);
    await saveToStorage(); // FIX [1]: sign before persisting
    consentLog.push({ ...grant, timestamp: new Date().toISOString() });
    console.log(`[AppPermissionManager] Granted ${permission} to ${appId}`);
  }

  async function revokePermission(permission, appId) {
    const key = `${appId}:${permission}`;
    permissionGrants.delete(key);
    await saveToStorage();
    console.log(`[AppPermissionManager] Revoked ${permission} from ${appId}`);
  }

  async function revokeAllPermissions(appId) {
    for (const key of [...permissionGrants.keys()]) {
      if (key.startsWith(`${appId}:`)) permissionGrants.delete(key);
    }
    await saveToStorage();
    console.log(`[AppPermissionManager] Revoked all permissions for ${appId}`);
  }

  function getAppPermissions(appId) {
    return [...permissionGrants.entries()]
      .filter(([k]) => k.startsWith(`${appId}:`))
      .map(([, v]) => v);
  }

  function getConsentLog() { return [...consentLog]; }

  function getStats() {
    const grants = [...permissionGrants.values()];
    return {
      totalGrants: grants.length,
      byCategory: grants.reduce((acc, g) => {
        const cat = PERMISSION_CATEGORIES[g.permission]?.category || 'other';
        acc[cat] = (acc[cat] || 0) + 1; return acc;
      }, {}),
      byRisk: grants.reduce((acc, g) => {
        const risk = PERMISSION_CATEGORIES[g.permission]?.risk || 'low';
        acc[risk] = (acc[risk] || 0) + 1; return acc;
      }, {})
    };
  }

  function showPermissionDialog(options) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position:fixed;inset:0;background:rgba(0,0,0,0.7);
        display:flex;align-items:center;justify-content:center;
        z-index:100000;backdrop-filter:blur(4px);`;

      const riskColors = { low:'#3fb950', medium:'#d29922', high:'#f0883e', critical:'#f85149' };
      const riskColor  = riskColors[options.riskLevel] || riskColors.low;
      
      // Sanitize user-provided strings
      const escapeHtml = (str) => {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return String(str).replace(/[&<>"']/g, c => map[c]);
      };
      const safeAppName = escapeHtml(options.appName);
      const safePermission = escapeHtml(options.permission);
      const safeReason = escapeHtml(options.reason || 'This app wants to access this permission.');

      overlay.innerHTML = `
        <div style="background:#0e121c;border:1px solid rgba(255,255,255,0.1);
          border-radius:12px;padding:24px;max-width:480px;width:90%;
          box-shadow:0 32px 80px rgba(0,0,0,0.6);">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
            <div style="width:40px;height:40px;border-radius:8px;
              background:${riskColor}22;display:flex;align-items:center;
              justify-content:center;font-size:20px;">
              ${options.riskLevel==='critical'?'⚠':options.riskLevel==='high'?'🔒':options.riskLevel==='medium'?'🛡':'✅'}
            </div>
            <div>
              <h3 style="color:#e6edf3;font-size:16px;margin:0;">Permission Request</h3>
              <p style="color:#8b949e;font-size:12px;margin:0;">${safeAppName}</p>
            </div>
          </div>
          <div style="margin-bottom:16px;">
            <p style="color:#e6edf3;font-size:14px;margin-bottom:8px;">
              <strong>${safePermission}</strong></p>
            <p style="color:#8b949e;font-size:13px;margin:0;">
              ${safeReason}</p>
          </div>
          <div style="background:rgba(255,255,255,0.05);border-radius:8px;
            padding:12px;margin-bottom:16px;">
            <p style="color:#8b949e;font-size:12px;margin:0;">
              <strong>Risk Level:</strong>
              <span style="color:${riskColor}">${options.riskLevel.toUpperCase()}</span></p>
            <p style="color:#8b949e;font-size:12px;margin:0;">
              <strong>Category:</strong>
              ${PERMISSION_CATEGORIES[options.permission]?.category || 'general'}</p>
          </div>
          <div style="display:flex;gap:12px;">
            <button id="denyBtn" style="flex:1;padding:12px 20px;
              border:1px solid rgba(255,255,255,0.1);border-radius:8px;
              background:transparent;color:#8b949e;font-size:14px;cursor:pointer;">
              Deny</button>
            <button id="grantBtn" style="flex:1;padding:12px 20px;border:none;
              border-radius:8px;background:#58a6ff;color:white;font-size:14px;
              font-weight:600;cursor:pointer;">
              Grant Permission</button>
          </div>
        </div>`;

      document.body.appendChild(overlay);
      const cleanup = () => document.body.removeChild(overlay);
      overlay.querySelector('#denyBtn').addEventListener('click',  () => { cleanup(); resolve(false); });
      overlay.querySelector('#grantBtn').addEventListener('click', () => { cleanup(); resolve(true);  });
    });
  }

  return {
    initialize, isGranted, requestPermission, grantPermission,
    revokePermission, revokeAllPermissions, getAppPermissions,
    getConsentLog, getStats,
    PERMISSION_TYPES, PERMISSION_CATEGORIES
  };
})();

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AppPermissionManager.initialize());
  } else {
    AppPermissionManager.initialize();
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = AppPermissionManager;