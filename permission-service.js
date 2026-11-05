/**
 * NovaByte OS - Permission Service
 * App permission system for managing application access controls
 * Handles manifest parsing, permission checking, and user consent tracking
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Permission types constants
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

// Default permission categories
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

// In-memory storage (would be replaced with database in production)
const appManifests = new Map();
const permissionQueue = new Map();
const userConsents = new Map();
const appWhitelist = new Set();
const appBlacklist = new Set();

/**
 * Parse app manifest and extract permissions
 * @param {object} manifest - App manifest object
 * @returns {object} Parsed manifest with permissions
 */
function parseManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') {
        throw new Error('Invalid manifest: must be an object');
    }

    const parsed = {
        id: manifest.id || uuidv4(),
        name: manifest.name || 'Unknown App',
        version: manifest.version || '1.0.0',
        description: manifest.description || '',
        developer: manifest.developer || 'Unknown',
        permissions: [],
        optionalPermissions: [],
        requiredPermissions: [],
        metadata: {}
    };

    // Parse required permissions
    if (Array.isArray(manifest.permissions)) {
        parsed.requiredPermissions = manifest.permissions.filter(p => 
            Object.values(PERMISSION_TYPES).includes(p)
        );
        parsed.permissions = [...parsed.requiredPermissions];
    }

    // Parse optional permissions
    if (Array.isArray(manifest.optionalPermissions)) {
        parsed.optionalPermissions = manifest.optionalPermissions.filter(p =>
            Object.values(PERMISSION_TYPES).includes(p)
        );
    }

    // Parse metadata
    parsed.metadata = {
        homepage: manifest.homepage || '',
        icon: manifest.icon || '',
        bundleId: manifest.bundleId || '',
        platform: manifest.platform || ['web'],
        minOsVersion: manifest.minOsVersion || '1.0.0'
    };

    return parsed;
}

/**
 * Register an app with its manifest
 * @param {object} manifest - App manifest
 * @returns {object} Registered app
 */
function registerApp(manifest) {
    const parsed = parseManifest(manifest);
    
    // Check if app is blacklisted
    if (appBlacklist.has(parsed.id)) {
        throw new Error(`App ${parsed.id} is blacklisted`);
    }

    // If whitelist is not empty, check if app is whitelisted
    if (appWhitelist.size > 0 && !appWhitelist.has(parsed.id)) {
        throw new Error(`App ${parsed.id} is not whitelisted`);
    }

    appManifests.set(parsed.id, {
        ...parsed,
        registeredAt: new Date().toISOString(),
        status: 'active'
    });

    return parsed;
}

/**
 * Get app manifest by ID
 * @param {string} appId - App ID
 * @returns {object|null}
 */
function getAppManifest(appId) {
    return appManifests.get(appId) || null;
}

/**
 * Check if app has a specific permission
 * @param {string} appId - App ID
 * @param {string} permission - Permission type
 * @returns {boolean}
 */
function hasPermission(appId, permission) {
    const app = appManifests.get(appId);
    if (!app) {
        return false;
    }

    return app.permissions.includes(permission);
}

/**
 * Check if app can access a resource with a specific action
 * @param {string} appId - App ID
 * @param {string} resource - Resource type (e.g., 'mail', 'filesystem')
 * @param {string} action - Action (e.g., 'read', 'write')
 * @returns {boolean}
 */
function canAccess(appId, resource, action) {
    const permission = `${resource}:${action}`;
    return hasPermission(appId, permission);
}

/**
 * Request a permission for an app (adds to queue)
 * @param {string} userId - User ID
 * @param {string} appId - App ID
 * @param {string} permission - Permission being requested
 * @param {string} reason - Reason for request
 * @returns {object} Permission request
 */
function requestPermission(userId, appId, permission, reason = '') {
    const request = {
        id: uuidv4(),
        userId,
        appId,
        permission,
        reason,
        status: 'pending',
        requestedAt: new Date().toISOString()
    };

    if (!permissionQueue.has(userId)) {
        permissionQueue.set(userId, []);
    }
    permissionQueue.get(userId).push(request);

    return request;
}

/**
 * Get pending permission requests for a user
 * @param {string} userId - User ID
 * @returns {array}
 */
function getPendingRequests(userId) {
    return permissionQueue.get(userId) || [];
}

/**
 * Approve or deny a permission request
 * @param {string} requestId - Request ID
 * @param {boolean} approved - Whether to approve
 * @param {string} deniedBy - Admin user who denied (if applicable)
 * @returns {object}
 */
function resolveRequest(requestId, approved, deniedBy = null) {
    for (const [userId, requests] of permissionQueue.entries()) {
        const request = requests.find(r => r.id === requestId);
        if (request) {
            request.status = approved ? 'approved' : 'denied';
            request.resolvedAt = new Date().toISOString();
            request.resolvedBy = deniedBy;

            if (approved) {
                // Add permission to app
                const app = appManifests.get(request.appId);
                if (app && !app.permissions.includes(request.permission)) {
                    app.permissions.push(request.permission);
                }
                
                // Record consent
                recordConsent(userId, request.appId, request.permission, true);
            }

            return request;
        }
    }
    return null;
}

/**
 * Record user consent for a permission
 * @param {string} userId - User ID
 * @param {string} appId - App ID
 * @param {string} permission - Permission granted
 * @param {boolean} granted - Whether granted or revoked
 */
function recordConsent(userId, appId, permission, granted) {
    const key = `${userId}:${appId}:${permission}`;
    
    if (!userConsents.has(userId)) {
        userConsents.set(userId, new Map());
    }
    
    userConsents.get(userId).set(`${appId}:${permission}`, {
        granted,
        timestamp: new Date().toISOString(),
        appId,
        permission
    });
}

/**
 * Check if user has given consent for a permission
 * @param {string} userId - User ID
 * @param {string} appId - App ID
 * @param {string} permission - Permission to check
 * @returns {boolean}
 */
function hasConsent(userId, appId, permission) {
    const userConsentMap = userConsents.get(userId);
    if (!userConsentMap) {
        return false;
    }
    
    const consent = userConsentMap.get(`${appId}:${permission}`);
    return consent ? consent.granted : false;
}

/**
 * Get all consents for a user
 * @param {string} userId - User ID
 * @returns {array}
 */
function getUserConsents(userId) {
    const userConsentMap = userConsents.get(userId);
    if (!userConsentMap) {
        return [];
    }
    
    return Array.from(userConsentMap.values());
}

/**
 * Revoke consent for a permission
 * @param {string} userId - User ID
 * @param {string} appId - App ID
 * @param {string} permission - Permission to revoke
 */
function revokeConsent(userId, appId, permission) {
    recordConsent(userId, appId, permission, false);
}

/**
 * Add app to whitelist
 * @param {string} appId - App ID
 */
function addToWhitelist(appId) {
    appWhitelist.add(appId);
}

/**
 * Remove app from whitelist
 * @param {string} appId - App ID
 */
function removeFromWhitelist(appId) {
    appWhitelist.delete(appId);
}

/**
 * Add app to blacklist
 * @param {string} appId - App ID
 */
function addToBlacklist(appId) {
    appBlacklist.add(appId);
    // Remove from whitelist if present
    appWhitelist.delete(appId);
}

/**
 * Remove app from blacklist
 * @param {string} appId - App ID
 */
function removeFromBlacklist(appId) {
    appBlacklist.delete(appId);
}

/**
 * Get app permission summary
 * @param {string} appId - App ID
 * @returns {object}
 */
function getAppPermissionSummary(appId) {
    const app = appManifests.get(appId);
    if (!app) {
        return null;
    }

    const permissions = app.permissions.map(p => ({
        name: p,
        category: PERMISSION_CATEGORIES[p]?.category || 'other',
        risk: PERMISSION_CATEGORIES[p]?.risk || 'unknown'
    }));

    return {
        appId: app.id,
        appName: app.name,
        permissions,
        totalPermissions: permissions.length,
        highRiskCount: permissions.filter(p => p.risk === 'high' || p.risk === 'critical').length
    };
}

/**
 * Validate permission request against security policy
 * @param {string} appId - App ID
 * @param {string} permission - Permission to validate
 * @returns {object} Validation result
 */
function validatePermissionRequest(appId, permission) {
    const app = appManifests.get(appId);
    
    if (!app) {
        return { valid: false, reason: 'App not registered' };
    }

    // Check if permission exists
    if (!Object.values(PERMISSION_TYPES).includes(permission)) {
        return { valid: false, reason: 'Invalid permission type' };
    }

    // Check for dangerous permission combinations
    const dangerousCombinations = [
        [PERMISSION_TYPES.DEVICE_CAMERA, PERMISSION_TYPES.DEVICE_MICROPHONE],
        [PERMISSION_TYPES.MAIL_WRITE, PERMISSION_TYPES.MAIL_SEND],
        [PERMISSION_TYPES.ADMIN_SYSTEM, PERMISSION_TYPES.ADMIN_USERS]
    ];

    for (const combo of dangerousCombinations) {
        if (combo.includes(permission)) {
            const hasCombo = combo.some(p => app.permissions.includes(p));
            if (hasCombo) {
                return { 
                    valid: true, 
                    warning: `This permission is often requested together with: ${combo.join(', ')}` 
                };
            }
        }
    }

    return { valid: true };
}

/**
 * Get all registered apps
 * @returns {array}
 */
function getAllApps() {
    return Array.from(appManifests.values()).map(app => ({
        id: app.id,
        name: app.name,
        version: app.version,
        developer: app.developer,
        permissionCount: app.permissions.length,
        registeredAt: app.registeredAt,
        status: app.status
    }));
}

/**
 * Uninstall/remove an app
 * @param {string} appId - App ID
 * @returns {boolean}
 */
function uninstallApp(appId) {
    const app = appManifests.get(appId);
    if (!app) {
        return false;
    }

    app.status = 'uninstalled';
    app.uninstalledAt = new Date().toISOString();
    
    return true;
}

/**
 * Clear all permission data (for testing)
 */
function clearAllData() {
    appManifests.clear();
    permissionQueue.clear();
    userConsents.clear();
    appWhitelist.clear();
    appBlacklist.clear();
}

module.exports = {
    // Permission types
    PERMISSION_TYPES,
    
    // Core functions
    parseManifest,
    registerApp,
    getAppManifest,
    hasPermission,
    canAccess,
    
    // Permission requests
    requestPermission,
    getPendingRequests,
    resolveRequest,
    
    // Consent management
    recordConsent,
    hasConsent,
    getUserConsents,
    revokeConsent,
    
    // Whitelist/Blacklist
    addToWhitelist,
    removeFromWhitelist,
    addToBlacklist,
    removeFromBlacklist,
    
    // Utilities
    getAppPermissionSummary,
    validatePermissionRequest,
    getAllApps,
    uninstallApp,
    clearAllData,
    
    // Permission categories
    PERMISSION_CATEGORIES
};
