/**
 * NovaSentinel Brute Force Protection
 * 
 * This module provides OPFS-based brute force attack protection.
 * Tracks failed authentication attempts and implements progressive
 * lockout with exponential backoff. Uses IndexedDB for persistent
 * storage of attempt counters.
 * 
 * SECURITY REQUIREMENTS:
 * - Progressive lockout (more attempts = longer lockout)
 * - Secure timestamp and attempt storage
 * - IP/identifier based blocking
 * - Audit logging for all lockout events
 * - Automatic cleanup of old entries
 * 
 * @module sentinel/vault/sentinel-brute-force
 */

'use strict';

// Wrap in IIFE to avoid global const conflicts when loaded in browser
(function() {
// =============================================================================
// BROWSER-ONLY MODULE CHECK
// =============================================================================

if (typeof window === 'undefined' && typeof global !== 'undefined') {
    console.warn('[NovaSentinel] sentinel-brute-force.js is designed for browser environment only');
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** IndexedDB database name */
const DB_NAME = 'NovaSentinelBruteForceDB';
const DB_VERSION = 1;
const STORE_ATTEMPTS = 'attempts';
const STORE_BLOCKS = 'blocks';

/** Lockout status */
const LOCKOUT_STATUS = {
    NORMAL: 'normal',
    WARNING: 'warning',
    LOCKED: 'locked',
    BLOCKED: 'blocked'
};

/** Default configuration */
const DEFAULT_CONFIG = {
    maxAttempts: 5,              // Max attempts before warning
    maxAttemptsBeforeLockout: 10, // Max attempts before full lockout
    lockoutDuration: 15 * 60 * 1000, // 15 minutes in ms
    warningDuration: 5 * 60 * 1000, // 5 minutes in ms
    blockDuration: 60 * 60 * 1000,   // 1 hour in ms
    cleanupInterval: 60 * 60 * 1000,  // 1 hour
    enableIPBlocking: true,
    enableProgressiveLockout: true
};

/** Error codes */
const ERROR_CODES = {
    TOO_MANY_ATTEMPTS: 'SENTINEL_BRUTE_FORCE_TOO_MANY_ATTEMPTS',
    ACCOUNT_LOCKED: 'SENTINEL_BRUTE_FORCE_ACCOUNT_LOCKED',
    IP_BLOCKED: 'SENTINEL_BRUTE_FORCE_IP_BLOCKED',
    RATE_LIMIT_EXCEEDED: 'SENTINEL_BRUTE_FORCE_RATE_LIMIT_EXCEEDED'
};

// =============================================================================
// STATE
// =============================================================================

/** IndexedDB instance */
let db = null;

/** Configuration */
let config = { ...DEFAULT_CONFIG };

/** In-memory attempt cache */
const attemptCache = new Map();

/** Active blocks cache */
const blockCache = new Map();

/** Cleanup timer */
let cleanupTimer = null;

/** Audit logging callback */
let auditLogger = null;

// =============================================================================
// ERROR CLASSES
// =============================================================================

class BruteForceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'BruteForceError';
        this.code = code;
        this.details = details;
    }
}

class TooManyAttemptsError extends BruteForceError {
    constructor(identifier, attempts, maxAttempts, lockoutUntil) {
        super(
            ERROR_CODES.TOO_MANY_ATTEMPTS,
            `Too many attempts for ${identifier}`,
            { identifier, attempts, maxAttempts, lockoutUntil }
        );
    }
}

class AccountLockedError extends BruteForceError {
    constructor(identifier, reason, lockoutUntil) {
        super(
            ERROR_CODES.ACCOUNT_LOCKED,
            `Account ${identifier} is locked: ${reason}`,
            { identifier, reason, lockoutUntil }
        );
    }
}

class IPBlockedError extends BruteForceError {
    constructor(ip, reason, blockUntil) {
        super(
            ERROR_CODES.IP_BLOCKED,
            `IP ${ip} is blocked: ${reason}`,
            { ip, reason, blockUntil }
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
        console.error('[NovaSentinel] Failed to log brute force event:', e.message);
    }
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Configure brute force protection
 * @param {object} options - Configuration options
 * @param {number} options.maxAttempts - Max attempts before warning
 * @param {number} options.maxAttemptsBeforeLockout - Max attempts before lockout
 * @param {number} options.lockoutDuration - Lockout duration in ms
 * @param {number} options.warningDuration - Warning duration in ms
 * @param {number} options.blockDuration - IP block duration in ms
 * @param {number} options.cleanupInterval - Cleanup interval in ms
 * @param {boolean} options.enableIPBlocking - Enable IP-based blocking
 * @param {boolean} options.enableProgressiveLockout - Enable progressive lockout
 */
function configure(options = {}) {
    if (options.maxAttempts !== undefined) {
        config.maxAttempts = Math.max(1, options.maxAttempts);
    }
    if (options.maxAttemptsBeforeLockout !== undefined) {
        config.maxAttemptsBeforeLockout = Math.max(1, options.maxAttemptsBeforeLockout);
    }
    if (options.lockoutDuration !== undefined) {
        config.lockoutDuration = Math.max(0, options.lockoutDuration);
    }
    if (options.warningDuration !== undefined) {
        config.warningDuration = Math.max(0, options.warningDuration);
    }
    if (options.blockDuration !== undefined) {
        config.blockDuration = Math.max(0, options.blockDuration);
    }
    if (options.cleanupInterval !== undefined) {
        config.cleanupInterval = Math.max(0, options.cleanupInterval);
    }
    if (options.enableIPBlocking !== undefined) {
        config.enableIPBlocking = options.enableIPBlocking;
    }
    if (options.enableProgressiveLockout !== undefined) {
        config.enableProgressiveLockout = options.enableProgressiveLockout;
    }
}

// =============================================================================
// INDEXEDDB OPERATIONS
// =============================================================================

/**
 * Open brute force database
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

            // Attempts store
            if (!database.objectStoreNames.contains(STORE_ATTEMPTS)) {
                const attemptStore = database.createObjectStore(STORE_ATTEMPTS, { keyPath: 'identifier' });
                attemptStore.createIndex('timestamp', 'timestamp', { unique: false });
                attemptStore.createIndex('expires', 'expires', { unique: false });
            }

            // Blocks store
            if (!database.objectStoreNames.contains(STORE_BLOCKS)) {
                const blockStore = database.createObjectStore(STORE_BLOCKS, { keyPath: 'identifier' });
                blockStore.createIndex('expires', 'expires', { unique: false });
            }
        };
    });
}

/**
 * Store attempt record
 * @param {object} record - Attempt record
 */
async function storeAttemptRecord(record) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_ATTEMPTS], 'readwrite');
        const store = transaction.objectStore(STORE_ATTEMPTS);
        
        store.put({
            ...record,
            timestamp: new Date().toISOString()
        });

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

/**
 * Get attempt record
 * @param {string} identifier - User identifier
 * @returns {Promise<object>}
 */
async function getAttemptRecord(identifier) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_ATTEMPTS], 'readonly');
        const store = transaction.objectStore(STORE_ATTEMPTS);
        const request = store.get(identifier);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Delete attempt record
 * @param {string} identifier - User identifier
 */
async function deleteAttemptRecord(identifier) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_ATTEMPTS], 'readwrite');
        const store = transaction.objectStore(STORE_ATTEMPTS);
        store.delete(identifier);

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

/**
 * Store block record
 * @param {object} record - Block record
 */
async function storeBlockRecord(record) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_BLOCKS], 'readwrite');
        const store = transaction.objectStore(STORE_BLOCKS);
        
        store.put({
            ...record,
            timestamp: new Date().toISOString()
        });

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

/**
 * Get block record
 * @param {string} identifier - User identifier or IP
 * @returns {Promise<object>}
 */
async function getBlockRecord(identifier) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_BLOCKS], 'readonly');
        const store = transaction.objectStore(STORE_BLOCKS);
        const request = store.get(identifier);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Delete block record
 * @param {string} identifier - User identifier or IP
 */
async function deleteBlockRecord(identifier) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_BLOCKS], 'readwrite');
        const store = transaction.objectStore(STORE_BLOCKS);
        store.delete(identifier);

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

/**
 * Get all active blocks
 * @returns {Promise<Array>}
 */
async function getActiveBlocks() {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_BLOCKS], 'readonly');
        const store = transaction.objectStore(STORE_BLOCKS);
        const request = store.getAll();

        request.onsuccess = () => {
            const now = Date.now();
            const active = request.result.filter(b => !b.expires || b.expires > now);
            resolve(active);
        };
        request.onerror = () => reject(request.error);
    });
}

// =============================================================================
// ATTEMPT TRACKING
// =============================================================================

/**
 * Record a failed attempt
 * @param {string} identifier - User identifier
 * @param {object} options - Options
 * @returns {Promise<object>} - Attempt status
 */
async function recordFailedAttempt(identifier, options = {}) {
    const now = Date.now();
    let record = await getAttemptRecord(identifier);
    
    if (!record) {
        record = {
            identifier,
            attempts: 0,
            firstAttempt: now,
            lastAttempt: now,
            failures: []
        };
    }
    
    // Add new failure
    record.attempts++;
    record.lastAttempt = now;
    record.failures.push({
        timestamp: now,
        ip: options.ip,
        userAgent: options.userAgent,
        reason: options.reason || 'unknown'
    });
    
    // Keep only recent failures
    const recentCutoff = now - (config.lockoutDuration * 2);
    record.failures = record.failures.filter(f => f.timestamp > recentCutoff);
    record.attempts = record.failures.length;
    
    // Determine status
    let status = LOCKOUT_STATUS.NORMAL;
    let lockoutUntil = null;
    
    if (record.attempts >= config.maxAttemptsBeforeLockout) {
        status = LOCKOUT_STATUS.LOCKED;
        // Exponential backoff: base duration * 2^(attempts - maxAttemptsBeforeLockout)
        const backoffFactor = Math.pow(2, record.attempts - config.maxAttemptsBeforeLockout);
        lockoutUntil = now + (config.lockoutDuration * backoffFactor);
    } else if (record.attempts >= config.maxAttempts) {
        status = LOCKOUT_STATUS.WARNING;
        lockoutUntil = now + config.warningDuration;
    }
    
    record.status = status;
    record.lockoutUntil = lockoutUntil;
    
    // Store record
    await storeAttemptRecord(record);
    attemptCache.set(identifier, record);
    
    // Log event
    await logSecurityEvent('BRUTE_FORCE_ATTEMPT_FAILED', {
        identifier,
        attempts: record.attempts,
        status,
        ip: options.ip
    });
    
    // Check if we should block IP
    if (config.enableIPBlocking && options.ip) {
        await recordFailedIPAttempt(options.ip, record.attempts);
    }
    
    return {
        identifier,
        attempts: record.attempts,
        status,
        lockoutUntil,
        maxAttempts: config.maxAttemptsBeforeLockout
    };
}

/**
 * Record successful authentication
 * @param {string} identifier - User identifier
 * @returns {Promise<boolean>}
 */
async function recordSuccess(identifier) {
    const record = await getAttemptRecord(identifier);
    
    if (record) {
        // Clear attempts on success
        await deleteAttemptRecord(identifier);
        attemptCache.delete(identifier);
        
        await logSecurityEvent('BRUTE_FORCE_ATTEMPT_SUCCESS', {
            identifier,
            previousAttempts: record.attempts
        });
    }
    
    return true;
}

/**
 * Check if identifier is locked out
 * @param {string} identifier - User identifier
 * @returns {Promise<{locked: boolean, status: string, lockoutUntil: number|null}>}
 */
async function checkLockout(identifier) {
    // Check cache first
    const cached = attemptCache.get(identifier);
    if (cached) {
        if (cached.lockoutUntil && cached.lockoutUntil > Date.now()) {
            return {
                locked: true,
                status: cached.status,
                lockoutUntil: cached.lockoutUntil,
                attempts: cached.attempts
            };
        }
    }
    
    // Check database
    const record = await getAttemptRecord(identifier);
    
    if (!record || !record.lockoutUntil) {
        return {
            locked: false,
            status: LOCKOUT_STATUS.NORMAL,
            lockoutUntil: null,
            attempts: 0
        };
    }
    
    const now = Date.now();
    const isLocked = record.lockoutUntil > now;
    
    return {
        locked: isLocked,
        status: record.status,
        lockoutUntil: record.lockoutUntil,
        attempts: record.attempts
    };
}

/**
 * Get attempt count for identifier
 * @param {string} identifier - User identifier
 * @returns {Promise<number>}
 */
async function getAttemptCount(identifier) {
    const record = await getAttemptRecord(identifier);
    return record?.attempts || 0;
}

// =============================================================================
// IP BLOCKING
// =============================================================================

/**
 * Record failed IP attempt
 * @param {string} ip - IP address
 * @param {number} userAttempts - Total user attempts
 * @returns {Promise<object>}
 */
async function recordFailedIPAttempt(ip, userAttempts) {
    const now = Date.now();
    let record = await getBlockRecord(`ip:${ip}`);
    
    if (!record) {
        record = {
            identifier: `ip:${ip}`,
            failures: 0,
            firstFailure: now,
            lastFailure: now
        };
    }
    
    record.failures++;
    record.lastFailure = now;
    
    // Calculate block duration based on failure count
    let blockUntil = null;
    
    if (record.failures >= 10) {
        // Block for extended period after 10+ failures
        const extraBlocks = Math.floor((record.failures - 10) / 5);
        blockUntil = now + (config.blockDuration * (1 + extraBlocks));
    }
    
    record.blocked = !!blockUntil;
    record.blockUntil = blockUntil;
    
    await storeBlockRecord(record);
    blockCache.set(`ip:${ip}`, record);
    
    if (blockUntil) {
        await logSecurityEvent('BRUTE_FORCE_IP_BLOCKED', {
            ip,
            failures: record.failures,
            blockUntil
        });
    }
    
    return record;
}

/**
 * Check if IP is blocked
 * @param {string} ip - IP address
 * @returns {Promise<{blocked: boolean, blockUntil: number|null}>}
 */
async function checkIPBlocked(ip) {
    // Check cache first
    const cached = blockCache.get(`ip:${ip}`);
    if (cached && cached.blocked) {
        if (!cached.blockUntil || cached.blockUntil > Date.now()) {
            return {
                blocked: true,
                blockUntil: cached.blockUntil,
                failures: cached.failures
            };
        }
    }
    
    // Check database
    const record = await getBlockRecord(`ip:${ip}`);
    
    if (!record || !record.blocked) {
        return {
            blocked: false,
            blockUntil: null,
            failures: 0
        };
    }
    
    const now = Date.now();
    const isBlocked = record.blockUntil && record.blockUntil > now;
    
    return {
        blocked: isBlocked,
        blockUntil: record.blockUntil,
        failures: record.failures
    };
}

/**
 * Unblock IP address
 * @param {string} ip - IP address
 * @returns {Promise<boolean>}
 */
async function unblockIP(ip) {
    await deleteBlockRecord(`ip:${ip}`);
    blockCache.delete(`ip:${ip}`);
    
    await logSecurityEvent('BRUTE_FORCE_IP_UNBLOCKED', { ip });
    
    return true;
}

// =============================================================================
// PROGRESSIVE LOCKOUT
// =============================================================================

/**
 * Calculate lockout duration based on attempts
 * @param {number} attempts - Number of failed attempts
 * @returns {number} - Duration in ms
 */
function calculateLockoutDuration(attempts) {
    if (!config.enableProgressiveLockout) {
        return config.lockoutDuration;
    }
    
    // Exponential backoff: base * 2^(attempts/max)
    const baseDuration = config.warningDuration;
    const maxDuration = config.lockoutDuration * 8; // Cap at 2 hours
    
    const factor = Math.pow(2, attempts / config.maxAttempts);
    const duration = baseDuration * factor;
    
    return Math.min(duration, maxDuration);
}

/**
 * Get lockout status for identifier
 * @param {string} identifier - User identifier
 * @returns {Promise<object>}
 */
async function getLockoutStatus(identifier) {
    const lockout = await checkLockout(identifier);
    
    if (config.enableIPBlocking) {
        // Try to get client IP
        const clientIP = getClientIP();
        if (clientIP) {
            const ipBlock = await checkIPBlocked(clientIP);
            if (ipBlock.blocked) {
                return {
                    locked: true,
                    status: LOCKOUT_STATUS.BLOCKED,
                    lockoutUntil: ipBlock.blockUntil,
                    reason: 'ip_blocked',
                    blockedIP: clientIP
                };
            }
        }
    }
    
    return lockout;
}

// =============================================================================
// CLIENT IP UTILITIES
// =============================================================================

/**
 * Get client IP address (best effort)
 * @returns {string|null}
 */
function getClientIP() {
    // In a real implementation, this would get from server headers
    // For browser-side, we can only get approximate location
    if (typeof navigator !== 'undefined' && navigator.connection) {
        return navigator.connection.effectiveType || 'unknown';
    }
    return null;
}

// =============================================================================
// CLEANUP
// =============================================================================

/**
 * Clean up expired attempts and blocks
 * @returns {Promise<{attemptsRemoved: number, blocksRemoved: number}>}
 */
async function cleanup() {
    const now = Date.now();
    let attemptsRemoved = 0;
    let blocksRemoved = 0;
    
    // Clean up attempts
    const database = await openDatabase();
    
    await new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_ATTEMPTS], 'readwrite');
        const store = transaction.objectStore(STORE_ATTEMPTS);
        const request = store.openCursor();
        
        const toDelete = [];
        
        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                const record = cursor.value;
                if (record.lockoutUntil && record.lockoutUntil < now) {
                    toDelete.push(record.identifier);
                }
                cursor.continue();
            }
        };
        
        transaction.oncomplete = async () => {
            if (toDelete.length > 0) {
                const deleteTransaction = database.transaction([STORE_ATTEMPTS], 'readwrite');
                const deleteStore = deleteTransaction.objectStore(STORE_ATTEMPTS);
                
                for (const id of toDelete) {
                    deleteStore.delete(id);
                    attemptsRemoved++;
                }
            }
            resolve();
        };
    });
    
    // Clean up blocks
    await new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_BLOCKS], 'readwrite');
        const store = transaction.objectStore(STORE_BLOCKS);
        const request = store.openCursor();
        
        const toDelete = [];
        
        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                const record = cursor.value;
                if (record.blockUntil && record.blockUntil < now) {
                    toDelete.push(record.identifier);
                }
                cursor.continue();
            }
        };
        
        transaction.oncomplete = async () => {
            if (toDelete.length > 0) {
                const deleteTransaction = database.transaction([STORE_BLOCKS], 'readwrite');
                const deleteStore = deleteTransaction.objectStore(STORE_BLOCKS);
                
                for (const id of toDelete) {
                    deleteStore.delete(id);
                    blocksRemoved++;
                }
            }
            resolve();
        };
    });
    
    // Clear caches for removed entries
    for (const id of attemptCache.keys()) {
        const record = attemptCache.get(id);
        if (record?.lockoutUntil && record.lockoutUntil < now) {
            attemptCache.delete(id);
        }
    }
    
    for (const id of blockCache.keys()) {
        const record = blockCache.get(id);
        if (record?.blockUntil && record.blockUntil < now) {
            blockCache.delete(id);
        }
    }
    
    await logSecurityEvent('BRUTE_FORCE_CLEANUP', {
        attemptsRemoved,
        blocksRemoved
    });
    
    return { attemptsRemoved, blocksRemoved };
}

/**
 * Start automatic cleanup
 */
function startCleanupTimer() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
    }
    
    if (config.cleanupInterval > 0) {
        cleanupTimer = setInterval(cleanup, config.cleanupInterval);
    }
}

/**
 * Stop automatic cleanup
 */
function stopCleanupTimer() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
}

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize brute force protection module
 * @returns {Promise<boolean>}
 */
async function initialize() {
    try {
        await openDatabase();
        
        // Start cleanup timer
        startCleanupTimer();
        
        await logSecurityEvent('BRUTE_FORCE_INITIALIZED', {
            config: {
                maxAttempts: config.maxAttempts,
                maxAttemptsBeforeLockout: config.maxAttemptsBeforeLockout,
                lockoutDuration: config.lockoutDuration,
                enableIPBlocking: config.enableIPBlocking,
                enableProgressiveLockout: config.enableProgressiveLockout
            }
        });
        
        return true;
    } catch (error) {
        await logSecurityEvent('BRUTE_FORCE_INIT_FAILED', {
            error: error.message
        });
        return false;
    }
}

/**
 * Destroy brute force protection module
 */
async function destroy() {
    stopCleanupTimer();
    attemptCache.clear();
    blockCache.clear();
    
    await logSecurityEvent('BRUTE_FORCE_DESTROYED', {});
}

// =============================================================================
// EXPORTS
// =============================================================================

const sentinelBruteForce = {
    // Constants
    LOCKOUT_STATUS,
    DEFAULT_CONFIG,
    ERROR_CODES,

    // Error classes
    BruteForceError,
    TooManyAttemptsError,
    AccountLockedError,
    IPBlockedError,

    // Configuration
    configure,

    // Audit
    setAuditLogger,
    logSecurityEvent,

    // Attempt tracking
    recordFailedAttempt,
    recordSuccess,
    checkLockout,
    getAttemptCount,

    // IP blocking
    checkIPBlocked,
    unblockIP,

    // Status
    getLockoutStatus,
    calculateLockoutDuration,

    // Cleanup
    cleanup,

    // Lifecycle
    initialize,
    destroy
};

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = sentinelBruteForce;
} else if (typeof window !== 'undefined') {
    window.NovaSentinelBruteForce = sentinelBruteForce;
}
})(); // End IIFE