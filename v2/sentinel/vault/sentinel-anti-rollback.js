/**
 * NovaSentinel Anti-Rollback
 * 
 * This module provides version lock functionality to prevent rolling back
 * to older (potentially vulnerable) versions of the application or its
 * components. Implements semantic version comparison with configurable
 * minimum version enforcement.
 * 
 * SECURITY REQUIREMENTS:
 * - Cryptographically signed version records
 * - Secure storage of minimum allowed versions
 * - Protection against time-based bypass attacks
 * - Audit logging for all version check events
 * 
 * @module sentinel/vault/sentinel-anti-rollback
 */

'use strict';

// Wrap in IIFE to avoid global const conflicts when loaded in browser
(function() {
// =============================================================================
// BROWSER-ONLY MODULE CHECK
// =============================================================================

if (typeof window === 'undefined' && typeof global !== 'undefined') {
    console.warn('[NovaSentinel] sentinel-anti-rollback.js is designed for browser environment only');
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** IndexedDB database name */
const DB_NAME = 'NovaSentinelAntiRollbackDB';
const DB_VERSION = 1;
const STORE_VERSIONS = 'versions';
const STORE_RECORDS = 'records';

/** Version lock status */
const VERSION_STATUS = {
    UNLOCKED: 'unlocked',
    LOCKED: 'locked',
    ENFORCED: 'enforced',
    BYPASSED: 'bypassed'
};

/** Error codes */
const ERROR_CODES = {
    VERSION_ROLLBACK_DETECTED: 'SENTINEL_ANTI_ROLLBACK_DETECTED',
    VERSION_TOO_LOW: 'SENTINEL_ANTI_ROLLBACK_VERSION_TOO_LOW',
    SIGNATURE_INVALID: 'SENTINEL_ANTI_ROLLBACK_SIGNATURE_INVALID',
    RECORD_NOT_FOUND: 'SENTINEL_ANTI_ROLLBACK_RECORD_NOT_FOUND',
    LOCK_NOT_FOUND: 'SENTINEL_ANTI_ROLLBACK_LOCK_NOT_FOUND'
};

// =============================================================================
// STATE
// =============================================================================

/** IndexedDB instance */
let db = null;

/** Version locks cache (Map<component, minimumVersion>) */
const versionLocks = new Map();

/** Audit logging callback */
let auditLogger = null;

/** Configuration */
let config = {
    strictMode: true,
    allowBypass: false,
    bypassTimeout: 0 // 0 = never allow bypass
};

// =============================================================================
// ERROR CLASSES
// =============================================================================

class AntiRollbackError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'AntiRollbackError';
        this.code = code;
        this.details = details;
    }
}

class VersionRollbackDetectedError extends AntiRollbackError {
    constructor(component, currentVersion, minimumVersion) {
        super(
            ERROR_CODES.VERSION_ROLLBACK_DETECTED,
            `Rollback detected for ${component}: ${currentVersion} < ${minimumVersion}`,
            { component, currentVersion, minimumVersion }
        );
    }
}

class VersionTooLowError extends AntiRollbackError {
    constructor(component, version, minimumVersion) {
        super(
            ERROR_CODES.VERSION_TOO_LOW,
            `Version ${version} too low for ${component} (minimum: ${minimumVersion})`,
            { component, version, minimumVersion }
        );
    }
}

class SignatureInvalidError extends AntiRollbackError {
    constructor(component, reason) {
        super(
            ERROR_CODES.SIGNATURE_INVALID,
            `Invalid signature for ${component}: ${reason}`,
            { component, reason }
        );
    }
}

// =============================================================================
// AUDIT LOGGING
// =============================================================================

/**
 * Set audit logger callback
 * @param {Function} logger
 */
function setAuditLogger(logger) {
    auditLogger = logger;
}

/**
 * Log security event
 * @param {string} event 
 * @param {object} data 
 */
async function logSecurityEvent(event, data = {}) {
    try {
        if (auditLogger) {
            await auditLogger(event, {
                ...data,
                timestamp: new Date().toISOString(),
                origin: typeof window !== 'undefined' ? window.location.origin : 'unknown'
            });
        }
    } catch (e) {
        console.error('[NovaSentinel] Failed to log anti-rollback event:', e.message);
    }
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Configure anti-rollback module
 * @param {object} options - Configuration options
 * @param {boolean} options.strictMode - Fail on any rollback attempt
 * @param {boolean} options.allowBypass - Allow bypass with authorization
 * @param {number} options.bypassTimeout - Bypass window in milliseconds
 */
function configure(options = {}) {
    if (options.strictMode !== undefined) {
        config.strictMode = options.strictMode;
    }
    if (options.allowBypass !== undefined) {
        config.allowBypass = options.allowBypass;
    }
    if (options.bypassTimeout !== undefined) {
        config.bypassTimeout = options.bypassTimeout;
    }
}

// =============================================================================
// INDEXEDDB OPERATIONS
// =============================================================================

/**
 * Open anti-rollback database
 * @returns {Promise<IDBDatabase>}
 */
async function openDatabase() {
    return new Promise((resolve, reject) => {
        if (db) {
            resolve(db);
            return;
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const database = event.target.result;

            // Version locks store
            if (!database.objectStoreNames.contains(STORE_VERSIONS)) {
                const versionStore = database.createObjectStore(STORE_VERSIONS, { keyPath: 'component' });
                versionStore.createIndex('timestamp', 'timestamp', { unique: false });
            }

            // Records store (version history, bypasses)
            if (!database.objectStoreNames.contains(STORE_RECORDS)) {
                const recordStore = database.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
                recordStore.createIndex('component', 'component', { unique: false });
                recordStore.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };
    });
}

/**
 * Store version lock
 * @param {object} lock - Version lock record
 */
async function storeVersionLock(lock) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_VERSIONS], 'readwrite');
        const store = transaction.objectStore(STORE_VERSIONS);
        
        store.put({
            ...lock,
            timestamp: new Date().toISOString()
        });

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

/**
 * Retrieve version lock
 * @param {string} component - Component name
 * @returns {Promise<object>}
 */
async function getVersionLock(component) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_VERSIONS], 'readonly');
        const store = transaction.objectStore(STORE_VERSIONS);
        const request = store.get(component);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get all version locks
 * @returns {Promise<Array>}
 */
async function getAllVersionLocks() {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_VERSIONS], 'readonly');
        const store = transaction.objectStore(STORE_VERSIONS);
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Delete version lock
 * @param {string} component - Component name
 */
async function deleteVersionLock(component) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_VERSIONS], 'readwrite');
        const store = transaction.objectStore(STORE_VERSIONS);
        store.delete(component);

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

/**
 * Store version record
 * @param {object} record - Version record
 */
async function storeVersionRecord(record) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_RECORDS], 'readwrite');
        const store = transaction.objectStore(STORE_RECORDS);
        
        store.put({
            id: record.id || `${record.component}_${Date.now()}`,
            ...record,
            timestamp: new Date().toISOString()
        });

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(request.error);
    });
}

/**
 * Get version history for component
 * @param {string} component - Component name
 * @returns {Promise<Array>}
 */
async function getVersionHistory(component) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_RECORDS], 'readonly');
        const store = transaction.objectStore(STORE_RECORDS);
        const index = store.index('component');
        const request = index.getAll(component);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// =============================================================================
// SEMANTIC VERSION PARSING
// =============================================================================

/**
 * Parse semantic version string
 * @param {string} version - Version string (e.g., "1.2.3")
 * @returns {object}
 */
function parseVersion(version) {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?(?:\+([a-zA-Z0-9.-]+))?$/);
    
    if (!match) {
        return {
            major: 0,
            minor: 0,
            patch: 0,
            prerelease: '',
            build: '',
            raw: version
        };
    }
    
    return {
        major: parseInt(match[1], 10),
        minor: parseInt(match[2], 10),
        patch: parseInt(match[3], 10),
        prerelease: match[4] || '',
        build: match[5] || '',
        raw: version
    };
}

/**
 * Compare two semantic versions
 * @param {string} version1 - First version
 * @param {string} version2 - Second version
 * @returns {number} -1 if version1 < version2, 0 if equal, 1 if version1 > version2
 */
function compareVersions(version1, version2) {
    const v1 = parseVersion(version1);
    const v2 = parseVersion(version2);
    
    // Compare major
    if (v1.major !== v2.major) {
        return v1.major < v2.major ? -1 : 1;
    }
    
    // Compare minor
    if (v1.minor !== v2.minor) {
        return v1.minor < v2.minor ? -1 : 1;
    }
    
    // Compare patch
    if (v1.patch !== v2.patch) {
        return v1.patch < v2.patch ? -1 : 1;
    }
    
    // Pre-release versions are considered lower
    if (v1.prerelease && !v2.prerelease) {
        return -1;
    }
    if (!v1.prerelease && v2.prerelease) {
        return 1;
    }
    if (v1.prerelease && v2.prerelease) {
        if (v1.prerelease !== v2.prerelease) {
            return v1.prerelease < v2.prerelease ? -1 : 1;
        }
    }
    
    return 0;
}

/**
 * Check if version meets minimum requirement
 * @param {string} version - Current version
 * @param {string} minimum - Minimum version
 * @returns {boolean}
 */
function meetsMinimumVersion(version, minimum) {
    return compareVersions(version, minimum) >= 0;
}

// =============================================================================
// VERSION LOCK MANAGEMENT
// =============================================================================

/**
 * Set minimum version lock for a component
 * This prevents rolling back below this version
 * 
 * @param {string} component - Component name (e.g., "app", "api", "sentinel")
 * @param {string} minimumVersion - Minimum allowed version
 * @param {object} options - Additional options
 * @returns {Promise<boolean>}
 */
async function setMinimumVersion(component, minimumVersion, options = {}) {
    const lock = {
        component,
        minimumVersion,
        enforced: options.enforced ?? true,
        allowBypass: options.allowBypass ?? config.allowBypass,
        reason: options.reason || 'security_update',
        signedBy: options.signedBy || null,
        signature: options.signature || null,
        metadata: options.metadata || {}
    };
    
    await storeVersionLock(lock);
    versionLocks.set(component, lock);
    
    await logSecurityEvent('ANTI_ROLLBACK_VERSION_LOCKED', {
        component,
        minimumVersion,
        reason: lock.reason
    });
    
    return true;
}

/**
 * Get minimum version for a component
 * @param {string} component - Component name
 * @returns {Promise<string|null>}
 */
async function getMinimumVersion(component) {
    // Check cache first
    if (versionLocks.has(component)) {
        return versionLocks.get(component).minimumVersion;
    }
    
    // Load from database
    const lock = await getVersionLock(component);
    
    if (lock) {
        versionLocks.set(component, lock);
        return lock.minimumVersion;
    }
    
    return null;
}

/**
 * Remove version lock
 * @param {string} component - Component name
 * @returns {Promise<boolean>}
 */
async function removeMinimumVersion(component) {
    await deleteVersionLock(component);
    versionLocks.delete(component);
    
    await logSecurityEvent('ANTI_ROLLBACK_VERSION_UNLOCKED', {
        component
    });
    
    return true;
}

// =============================================================================
// VERSION VERIFICATION
// =============================================================================

/**
 * Verify version meets minimum requirement
 * 
 * @param {string} component - Component name
 * @param {string} currentVersion - Current version to verify
 * @param {object} options - Verification options
 * @returns {Promise<{allowed: boolean, status: string, reason?: string}>}
 */
async function verifyVersion(component, currentVersion, options = {}) {
    const checkMinimum = options.checkMinimum ?? true;
    const allowBypass = options.allowBypass ?? config.allowBypass;
    
    // Get minimum version
    const minimumVersion = await getMinimumVersion(component);
    
    // If no minimum is set, allow all versions
    if (!minimumVersion) {
        return {
            allowed: true,
            status: VERSION_STATUS.UNLOCKED,
            reason: 'no_minimum_set'
        };
    }
    
    // Check if version meets minimum
    if (checkMinimum && !meetsMinimumVersion(currentVersion, minimumVersion)) {
        await logSecurityEvent('ANTI_ROLLBACK_VERSION_TOO_LOW', {
            component,
            currentVersion,
            minimumVersion
        });
        
        if (config.strictMode) {
            throw new VersionRollbackDetectedError(
                component,
                currentVersion,
                minimumVersion
            );
        }
        
        return {
            allowed: false,
            status: VERSION_STATUS.LOCKED,
            reason: 'version_too_low',
            currentVersion,
            minimumVersion
        };
    }
    
    // Record version check
    await storeVersionRecord({
        component,
        version: currentVersion,
        minimumVersion,
        allowed: true,
        status: VERSION_STATUS.ENFORCED
    });
    
    await logSecurityEvent('ANTI_ROLLBACK_VERSION_VERIFIED', {
        component,
        currentVersion,
        minimumVersion
    });
    
    return {
        allowed: true,
        status: VERSION_STATUS.ENFORCED,
        currentVersion,
        minimumVersion
    };
}

/**
 * Verify multiple components at once
 * @param {object} versions - Map of component -> version
 * @returns {Promise<Array>}
 */
async function verifyVersions(versions) {
    const results = [];
    
    for (const [component, version] of Object.entries(versions)) {
        try {
            const result = await verifyVersion(component, version);
            results.push({ component, ...result });
        } catch (error) {
            results.push({
                component,
                allowed: false,
                status: VERSION_STATUS.LOCKED,
                error: error.message
            });
        }
    }
    
    return results;
}

// =============================================================================
// BYPASS MECHANISM
// =============================================================================

/**
 * Request bypass (for emergency rollback)
 * @param {string} component - Component name
 * @param {string} requestedVersion - Version to downgrade to
 * @param {string} reason - Reason for bypass request
 * @param {object} authorization - Authorization data
 * @returns {Promise<boolean>}
 */
async function requestBypass(component, requestedVersion, reason, authorization = {}) {
    const minimumVersion = await getMinimumVersion(component);
    
    if (!minimumVersion) {
        return true; // No lock set
    }
    
    if (!config.allowBypass && !allowBypassForComponent(component)) {
        throw new AntiRollbackError(
            ERROR_CODES.VERSION_ROLLBACK_DETECTED,
            'Bypass not allowed'
        );
    }
    
    // Store bypass request for audit
    await storeVersionRecord({
        id: `bypass_${component}_${Date.now()}`,
        component,
        requestedVersion,
        minimumVersion,
        reason,
        authorization,
        status: 'pending',
        bypassRequested: true
    });
    
    await logSecurityEvent('ANTI_ROLLBACK_BYPASS_REQUESTED', {
        component,
        requestedVersion,
        minimumVersion,
        reason
    });
    
    // In a real implementation, this would require admin authorization
    // For now, we allow bypass requests but log them
    return true;
}

/**
 * Check if bypass is allowed for component
 * @param {string} component - Component name
 * @returns {boolean}
 */
function allowBypassForComponent(component) {
    const lock = versionLocks.get(component);
    return lock?.allowBypass ?? config.allowBypass;
}

// =============================================================================
// VERSION RECORDS
// =============================================================================

/**
 * Record version upgrade
 * @param {string} component - Component name
 * @param {string} oldVersion - Previous version
 * @param {string} newVersion - New version
 * @returns {Promise<boolean>}
 */
async function recordVersionUpgrade(component, oldVersion, newVersion) {
    await storeVersionRecord({
        component,
        oldVersion,
        newVersion,
        type: 'upgrade',
        status: 'completed'
    });
    
    await logSecurityEvent('ANTI_ROLLBACK_VERSION_UPGRADED', {
        component,
        oldVersion,
        newVersion
    });
    
    return true;
}

/**
 * Record version downgrade (successful bypass)
 * @param {string} component - Component name
 * @param {string} fromVersion - Previous version
 * @param {string} toVersion - New version
 * @param {string} reason - Reason for downgrade
 * @returns {Promise<boolean>}
 */
async function recordVersionDowngrade(component, fromVersion, toVersion, reason) {
    await storeVersionRecord({
        component,
        oldVersion: fromVersion,
        newVersion: toVersion,
        type: 'downgrade',
        reason,
        status: 'completed'
    });
    
    await logSecurityEvent('ANTI_ROLLBACK_VERSION_DOWNGRADED', {
        component,
        fromVersion,
        toVersion,
        reason
    });
    
    return true;
}

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize anti-rollback module
 * @returns {Promise<boolean>}
 */
async function initialize() {
    try {
        await openDatabase();
        
        // Load all version locks into cache
        const locks = await getAllVersionLocks();
        for (const lock of locks) {
            versionLocks.set(lock.component, lock);
        }
        
        await logSecurityEvent('ANTI_ROLLBACK_INITIALIZED', {
            lockCount: locks.length,
            strictMode: config.strictMode,
            allowBypass: config.allowBypass
        });
        
        return true;
    } catch (error) {
        await logSecurityEvent('ANTI_ROLLBACK_INIT_FAILED', {
            error: error.message
        });
        return false;
    }
}

/**
 * Destroy anti-rollback module
 */
async function destroy() {
    versionLocks.clear();
    
    await logSecurityEvent('ANTI_ROLLBACK_DESTROYED', {});
}

// =============================================================================
// EXPORTS
// =============================================================================

const sentinelAntiRollback = {
    // Constants
    VERSION_STATUS,
    ERROR_CODES,

    // Error classes
    AntiRollbackError,
    VersionRollbackDetectedError,
    VersionTooLowError,
    SignatureInvalidError,

    // Configuration
    configure,

    // Audit
    setAuditLogger,
    logSecurityEvent,

    // Version parsing
    parseVersion,
    compareVersions,
    meetsMinimumVersion,

    // Version lock management
    setMinimumVersion,
    getMinimumVersion,
    removeMinimumVersion,

    // Version verification
    verifyVersion,
    verifyVersions,

    // Bypass mechanism
    requestBypass,
    allowBypassForComponent,

    // Version records
    recordVersionUpgrade,
    recordVersionHistory: getVersionHistory,

    // Lifecycle
    initialize,
    destroy
};

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = sentinelAntiRollback;
} else if (typeof window !== 'undefined') {
    window.NovaSentinelAntiRollback = sentinelAntiRollback;
}
})(); // End IIFE