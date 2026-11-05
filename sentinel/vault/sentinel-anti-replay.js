/**
 * NovaSentinel Anti-Replay
 * 
 * This module provides nonce-based versioning to prevent replay attacks.
 * Implements sequence number tracking, timestamp validation, and
 * sliding window replay protection for security-critical operations.
 * 
 * SECURITY REQUIREMENTS:
 * - Monotonically increasing sequence numbers
 * - Timestamp validation with acceptable window
 * - Sliding window for replay attack detection
 * - Secure storage of nonce state
 * - Audit logging for all replay protection events
 * 
 * @module sentinel/vault/sentinel-anti-replay
 */

'use strict';

// Wrap in IIFE to avoid global const conflicts when loaded in browser
(function() {
// =============================================================================
// BROWSER-ONLY MODULE CHECK
// =============================================================================

if (typeof window === 'undefined' && typeof global !== 'undefined') {
    console.warn('[NovaSentinel] sentinel-anti-replay.js is designed for browser environment only');
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default replay window size (number of accepted old nonces) */
const DEFAULT_REPLAY_WINDOW = 100;

/** Timestamp validity window in milliseconds (5 minutes) */
const DEFAULT_TIMESTAMP_WINDOW = 5 * 60 * 1000;

/** Maximum sequence number (wrap-around protection) */
const MAX_SEQUENCE_NUMBER = Number.MAX_SAFE_INTEGER;

/** Nonce storage key prefix */
const NONCE_STORAGE_PREFIX = 'sentinel_nonce_';

/** IndexedDB database name */
const DB_NAME = 'NovaSentinelAntiReplayDB';
const DB_VERSION = 1;
const STORE_NONCES = 'nonces';
const STORE_SEQUENCES = 'sequences';

/** Error codes */
const ERROR_CODES = {
    REPLAY_DETECTED: 'SENTINEL_ANTI_REPLAY_REPLAY_DETECTED',
    INVALID_TIMESTAMP: 'SENTINEL_ANTI_REPLAY_INVALID_TIMESTAMP',
    SEQUENCE_WRAP: 'SENTINEL_ANTI_REPLAY_SEQUENCE_WRAP',
    STORAGE_ERROR: 'SENTINEL_ANTI_REPLAY_STORAGE_ERROR',
    NONCE_NOT_FOUND: 'SENTINEL_ANTI_REPLAY_NONCE_NOT_FOUND'
};

// =============================================================================
// STATE
// =============================================================================

/** IndexedDB instance */
let db = null;

/** In-memory cache of recent nonces (Map<keyName, Set<nonce>>) */
const recentNonces = new Map();

/** Sequence number cache (Map<keyName, number>) */
const sequenceCache = new Map();

/** Configuration */
let config = {
    replayWindow: DEFAULT_REPLAY_WINDOW,
    timestampWindow: DEFAULT_TIMESTAMP_WINDOW,
    enableTimestampCheck: true
};

/** Audit logging callback */
let auditLogger = null;

// =============================================================================
// ERROR CLASSES
// =============================================================================

class AntiReplayError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'AntiReplayError';
        this.code = code;
        this.details = details;
    }
}

class ReplayDetectedError extends AntiReplayError {
    constructor(keyName, nonce, reason) {
        super(
            ERROR_CODES.REPLAY_DETECTED,
            `Replay attack detected for ${keyName}`,
            { keyName, nonce, reason }
        );
    }
}

class InvalidTimestampError extends AntiReplayError {
    constructor(keyName, timestamp, currentTime) {
        super(
            ERROR_CODES.INVALID_TIMESTAMP,
            `Timestamp outside valid window`,
            { keyName, timestamp, currentTime, window: config.timestampWindow }
        );
    }
}

class SequenceWrapError extends AntiReplayError {
    constructor(keyName) {
        super(
            ERROR_CODES.SEQUENCE_WRAP,
            `Sequence number wrap-around for ${keyName}`,
            { keyName }
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
        console.error('[NovaSentinel] Failed to log anti-replay event:', e.message);
    }
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Configure anti-replay module
 * @param {object} options - Configuration options
 * @param {number} options.replayWindow - Number of old nonces to track
 * @param {number} options.timestampWindow - Timestamp validity window in ms
 * @param {boolean} options.enableTimestampCheck - Enable timestamp validation
 */
function configure(options = {}) {
    if (options.replayWindow !== undefined) {
        config.replayWindow = Math.max(1, Math.min(1000, options.replayWindow));
    }
    if (options.timestampWindow !== undefined) {
        config.timestampWindow = Math.max(0, options.timestampWindow);
    }
    if (options.enableTimestampCheck !== undefined) {
        config.enableTimestampCheck = options.enableTimestampCheck;
    }
}

// =============================================================================
// INDEXEDDB OPERATIONS
// =============================================================================

/**
 * Open anti-replay database
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

            // Nonces store
            if (!database.objectStoreNames.contains(STORE_NONCES)) {
                const nonceStore = database.createObjectStore(STORE_NONCES, { keyPath: ['keyName', 'nonce'] });
                nonceStore.createIndex('keyName', 'keyName', { unique: false });
                nonceStore.createIndex('timestamp', 'timestamp', { unique: false });
            }

            // Sequences store
            if (!database.objectStoreNames.contains(STORE_SEQUENCES)) {
                database.createObjectStore(STORE_SEQUENCES, { keyPath: 'keyName' });
            }
        };
    });
}

/**
 * Store nonce in database
 * @param {string} keyName - Key name
 * @param {string} nonce - Nonce value
 * @param {number} timestamp - Timestamp
 */
async function storeNonce(keyName, nonce, timestamp) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_NONCES], 'readwrite');
        const store = transaction.objectStore(STORE_NONCES);

        store.put({
            keyName,
            nonce,
            timestamp,
            sequence: sequenceCache.get(keyName) || 0
        });

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

/**
 * Check if nonce exists in database
 * @param {string} keyName - Key name
 * @param {string} nonce - Nonce value
 * @returns {Promise<boolean>}
 */
async function hasNonce(keyName, nonce) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_NONCES], 'readonly');
        const store = transaction.objectStore(STORE_NONCES);
        const request = store.get([keyName, nonce]);

        request.onsuccess = () => resolve(!!request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get sequence number for key
 * @param {string} keyName - Key name
 * @returns {Promise<number>}
 */
async function getSequence(keyName) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_SEQUENCES], 'readonly');
        const store = transaction.objectStore(STORE_SEQUENCES);
        const request = store.get(keyName);

        request.onsuccess = () => {
            resolve(request.result?.sequence || 0);
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Set sequence number for key
 * @param {string} keyName - Key name
 * @param {number} sequence - Sequence number
 */
async function setSequence(keyName, sequence) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_SEQUENCES], 'readwrite');
        const store = transaction.objectStore(STORE_SEQUENCES);

        store.put({ keyName, sequence });

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

/**
 * Clean up old nonces beyond replay window
 * @param {string} keyName - Key name
 */
async function cleanupOldNonces(keyName) {
    const database = await openDatabase();
    const cutoffTime = Date.now() - (config.timestampWindow * 2);
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_NONCES], 'readwrite');
        const store = transaction.objectStore(STORE_NONCES);
        const index = store.index('keyName');
        
        const range = IDBKeyRange.bound(
            [keyName, ''],
            [keyName, '\uffff']
        );

        const request = index.openCursor(range);
        
        const toDelete = [];
        
        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                if (cursor.primaryKey[1] < cutoffTime) {
                    toDelete.push(cursor.primaryKey);
                }
                cursor.continue();
            }
        };

        transaction.oncomplete = () => {
            if (toDelete.length > 0) {
                const deleteTransaction = database.transaction([STORE_NONCES], 'readwrite');
                const deleteStore = deleteTransaction.objectStore(STORE_NONCES);
                
                for (const key of toDelete) {
                    deleteStore.delete(key);
                }
            }
            resolve();
        };
    });
}

// =============================================================================
// NONCE GENERATION
// =============================================================================

/**
 * Generate a cryptographically secure nonce
 * @param {string} keyName - Key name for context
 * @returns {Promise<string>}
 */
async function generateNonce(keyName) {
    const timestamp = Date.now();
    const sequence = await getNextSequence(keyName);
    
    // Combine timestamp, sequence, and random bytes
    const randomBytes = crypto.getRandomValues(new Uint8Array(16));
    
    const nonceData = new Uint8Array(4 + 4 + 16); // timestamp + sequence + random
    const timestampView = new DataView(nonceData.buffer, 0, 4);
    const sequenceView = new DataView(nonceData.buffer, 4, 4);
    
    timestampView.setUint32(0, timestamp);
    sequenceView.setUint32(0, sequence);
    nonceData.set(randomBytes, 8);
    
    // Convert to base64url
    return btoa(String.fromCharCode(...nonceData))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Get next sequence number
 * @param {string} keyName - Key name
 * @returns {Promise<number>}
 */
async function getNextSequence(keyName) {
    let sequence = sequenceCache.get(keyName) || 0;
    
    // Load from database if not in cache
    if (!sequenceCache.has(keyName)) {
        sequence = await getSequence(keyName);
    }
    
    // Check for wrap-around
    if (sequence >= MAX_SEQUENCE_NUMBER) {
        throw new SequenceWrapError(keyName);
    }
    
    sequence++;
    sequenceCache.set(keyName, sequence);
    await setSequence(keyName, sequence);
    
    return sequence;
}

// =============================================================================
// NONCE VALIDATION
// =============================================================================

/**
 * Validate a nonce
 * Checks for replay attacks and timestamp validity
 * 
 * @param {string} keyName - Key name
 * @param {string} nonce - Nonce to validate
 * @param {object} options - Validation options
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
async function validateNonce(keyName, nonce, options = {}) {
    const checkTimestamp = options.checkTimestamp ?? config.enableTimestampCheck;
    const timestamp = options.timestamp || Date.now();
    
    try {
        // Check if nonce exists (replay attack)
        const nonceExists = await hasNonce(keyName, nonce);
        
        if (nonceExists) {
            await logSecurityEvent('ANTI_REPLAY_REPLAY_DETECTED', {
                keyName,
                nonce: nonce.slice(0, 16) + '...'
            });
            
            return {
                valid: false,
                reason: 'Replay attack detected'
            };
        }

        // Validate timestamp if enabled
        if (checkTimestamp) {
            // Extract timestamp from nonce
            try {
                const decoded = atob(nonce.replace(/-/g, '+').replace(/_/g, '/'));
                const nonceBytes = new Uint8Array(decoded.length);
                for (let i = 0; i < decoded.length; i++) {
                    nonceBytes[i] = decoded.charCodeAt(i);
                }
                
                const nonceTimestamp = new DataView(nonceBytes.buffer, 0, 4).getUint32();
                const timeDiff = Math.abs(timestamp - nonceTimestamp);
                
                if (timeDiff > config.timestampWindow) {
                    await logSecurityEvent('ANTI_REPLAY_INVALID_TIMESTAMP', {
                        keyName,
                        nonceTimestamp,
                        currentTime: timestamp,
                        timeDiff
                    });
                    
                    return {
                        valid: false,
                        reason: 'Timestamp outside valid window'
                    };
                }
            } catch (e) {
                // If we can't parse timestamp, still allow (backwards compatibility)
            }
        }

        // Store nonce for future replay checking
        await storeNonce(keyName, nonce, timestamp);
        
        // Update in-memory cache
        if (!recentNonces.has(keyName)) {
            recentNonces.set(keyName, new Set());
        }
        recentNonces.get(keyName).add(nonce);
        
        // Trim old nonces from memory cache
        if (recentNonces.get(keyName).size > config.replayWindow) {
            const oldest = recentNonces.get(keyName).values().next().value;
            recentNonces.get(keyName).delete(oldest);
        }

        await logSecurityEvent('ANTI_REPLAY_NONCE_VALIDATED', {
            keyName,
            nonce: nonce.slice(0, 16) + '...'
        });

        return { valid: true };
        
    } catch (error) {
        await logSecurityEvent('ANTI_REPLAY_VALIDATION_ERROR', {
            keyName,
            error: error.message
        });
        
        return {
            valid: false,
            reason: error.message
        };
    }
}

/**
 * Mark nonce as used
 * @param {string} keyName - Key name
 * @param {string} nonce - Nonce
 * @returns {Promise<boolean>}
 */
async function markNonceUsed(keyName, nonce) {
    const timestamp = Date.now();
    await storeNonce(keyName, nonce, timestamp);
    
    // Add to memory cache
    if (!recentNonces.has(keyName)) {
        recentNonces.set(keyName, new Set());
    }
    recentNonces.get(keyName).add(nonce);
    
    return true;
}

// =============================================================================
// VERSIONED DATA
// =============================================================================

/**
 * Create versioned data with nonce and timestamp
 * @param {string} keyName - Key name
 * @param {object} data - Data to version
 * @returns {Promise<object>}
 */
async function createVersionedData(keyName, data) {
    const nonce = await generateNonce(keyName);
    const timestamp = Date.now();
    const sequence = sequenceCache.get(keyName) || await getSequence(keyName);
    
    return {
        data,
        nonce,
        timestamp,
        sequence,
        version: 1
    };
}

/**
 * Validate and consume versioned data
 * @param {string} keyName - Key name
 * @param {object} versionedData - Versioned data
 * @returns {Promise<object>}
 */
async function consumeVersionedData(keyName, versionedData) {
    if (!versionedData.nonce) {
        throw new AntiReplayError(
            ERROR_CODES.NONCE_NOT_FOUND,
            'Versioned data missing nonce'
        );
    }

    const validation = await validateNonce(keyName, versionedData.nonce, {
        timestamp: versionedData.timestamp,
        checkTimestamp: true
    });

    if (!validation.valid) {
        throw new ReplayDetectedError(
            keyName,
            versionedData.nonce,
            validation.reason
        );
    }

    return versionedData.data;
}

// =============================================================================
// SLIDING WINDOW
// =============================================================================

/**
 * Get current sequence window info
 * @param {string} keyName - Key name
 * @returns {Promise<object>}
 */
async function getSequenceWindow(keyName) {
    const currentSequence = sequenceCache.get(keyName) || await getSequence(keyName);
    const windowStart = Math.max(0, currentSequence - config.replayWindow);
    
    return {
        keyName,
        currentSequence,
        windowStart,
        windowSize: config.replayWindow
    };
}

/**
 * Reset sequence for key (use with caution - security implications)
 * @param {string} keyName - Key name
 * @returns {Promise<boolean>}
 */
async function resetSequence(keyName) {
    sequenceCache.set(keyName, 0);
    await setSequence(keyName, 0);
    
    // Clear nonces
    const database = await openDatabase();
    const transaction = database.transaction([STORE_NONCES], 'readwrite');
    const store = transaction.objectStore(STORE_NONCES);
    
    const index = store.index('keyName');
    const request = index.openCursor(IDBKeyRange.bound(keyName, keyName + '\uffff'));
    
    request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
            cursor.delete();
            cursor.continue();
        }
    };
    
    // Clear memory cache
    recentNonces.delete(keyName);
    
    await logSecurityEvent('ANTI_REPLAY_SEQUENCE_RESET', {
        keyName
    });
    
    return true;
}

// =============================================================================
// BATCH OPERATIONS
// =============================================================================

/**
 * Validate multiple nonces
 * @param {string} keyName - Key name
 * @param {string[]} nonces - Array of nonces
 * @returns {Promise<Array<{nonce: string, valid: boolean, reason?: string}>>}
 */
async function validateNonces(keyName, nonces) {
    const results = [];
    
    for (const nonce of nonces) {
        const result = await validateNonce(keyName, nonce);
        results.push({
            nonce,
            ...result
        });
    }
    
    return results;
}

/**
 * Get recent nonce count
 * @param {string} keyName - Key name
 * @returns {number}
 */
function getRecentNonceCount(keyName) {
    const set = recentNonces.get(keyName);
    return set ? set.size : 0;
}

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize anti-replay module
 * @returns {Promise<boolean>}
 */
async function initialize() {
    try {
        await openDatabase();
        
        await logSecurityEvent('ANTI_REPLAY_INITIALIZED', {
            replayWindow: config.replayWindow,
            timestampWindow: config.timestampWindow
        });
        
        return true;
    } catch (error) {
        await logSecurityEvent('ANTI_REPLAY_INIT_FAILED', {
            error: error.message
        });
        return false;
    }
}

/**
 * Destroy anti-replay module
 */
async function destroy() {
    recentNonces.clear();
    sequenceCache.clear();
    
    await logSecurityEvent('ANTI_REPLAY_DESTROYED', {});
}

// =============================================================================
// EXPORTS
// =============================================================================

const sentinelAntiReplay = {
    // Constants
    DEFAULT_REPLAY_WINDOW,
    DEFAULT_TIMESTAMP_WINDOW,
    ERROR_CODES,

    // Error classes
    AntiReplayError,
    ReplayDetectedError,
    InvalidTimestampError,
    SequenceWrapError,

    // Configuration
    configure,

    // Audit
    setAuditLogger,
    logSecurityEvent,

    // Nonce operations
    generateNonce,
    validateNonce,
    markNonceUsed,

    // Versioned data
    createVersionedData,
    consumeVersionedData,

    // Sequence operations
    getNextSequence,
    getSequence,
    setSequence,
    getSequenceWindow,
    resetSequence,

    // Batch operations
    validateNonces,
    getRecentNonceCount,

    // Lifecycle
    initialize,
    destroy
};

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = sentinelAntiReplay;
} else if (typeof window !== 'undefined') {
    window.NovaSentinelAntiReplay = sentinelAntiReplay;
}
})(); // End IIFE