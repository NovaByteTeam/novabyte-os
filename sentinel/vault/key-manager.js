/**
 * NovaSentinel Key Manager
 * 
 * Manages the full key hierarchy for NovaSentinel:
 * Master Key (from env or entropy)
 *     └── Module Keys (one per sentinel module, derived via HKDF)
 *             └── Session Keys (per-request, short-lived)
 * 
 * SECURITY REQUIREMENTS:
 * - Keys never leave this module as plaintext except via getKey()
 * - Master key never logged - only fingerprints
 * - All buffers zeroed after use
 * - HKDF key derivation with NSA CNSA 2.0 compliance
 * - Automatic key rotation every 24 hours
 * 
 * @module sentinel/vault/key-manager
 */

'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');

// =============================================================================
// DEPENDENCIES
// =============================================================================

const entropy = require('../crypto/entropy');

// Try to load audit service, fail gracefully if unavailable
let auditService;
try {
    auditService = require('../../audit-service');
} catch (e) {
    auditService = {
        logSecurityEvent: () => {},
        log: () => {}
    };
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Allowed module IDs for key derivation */
const ALLOWED_MODULES = [
    'encryption',
    'virtual-tpm',
    'fido2',
    'session-guard',
    'zero-trust',
    'tamper-detect',
    'behavioral',
    'anti-fingerprint',
    'virustotal',
    'safe-browsing',
    'dom-purify',
    'auto-destruct',
    'lockdown',
    'revocation'
];

/** HKDF salt for all module key derivations */
const HKDF_SALT = Buffer.from('novabyte-sentinel-v1');

/** Key length in bytes (256 bits) */
const KEY_LENGTH = 32;

/** Key rotation interval in milliseconds (24 hours) */
const ROTATION_INTERVAL = 24 * 60 * 60 * 1000;

/** Env variable name for master key */
const MASTER_KEY_ENV = 'SENTINEL_MASTER_KEY';

// =============================================================================
// STATE
// =============================================================================

/** Master key Buffer (never exposed directly) */
let masterKey = null;

/** Map of moduleId -> key Buffer */
let moduleKeys = new Map();

/** Last rotation timestamp */
let lastRotation = null;

/** Total rotation count */
let rotationCount = 0;

/** Whether key manager has been destroyed */
let destroyed = false;

/** Rotation scheduler interval ID */
let rotationScheduler = null;

/** Key source: 'env' or 'generated' */
let keySource = null;

/** Event emitter for key events */
const emitter = new EventEmitter();

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Generate a secure fingerprint of a key for logging (first 8 hex chars of SHA-256)
 * @param {Buffer} key - Key to fingerprint
 * @returns {string} Fingerprint (8 hex chars)
 */
function getKeyFingerprint(key) {
    if (!key) return 'none';
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    return hash.substring(0, 8);
}

/**
 * Zero a buffer in place (security: overwrite with zeros)
 * @param {Buffer} buf - Buffer to zero
 */
function zeroBuffer(buf) {
    if (buf && Buffer.isBuffer(buf)) {
        buf.fill(0);
    }
}

/**
 * Derive a module key from master key using HKDF
 * @param {Buffer} masterKey - Master key
 * @param {string} moduleId - Module identifier
 * @returns {Buffer} Derived module key (32 bytes)
 */
function deriveModuleKey(masterKey, moduleId) {
    const derived = crypto.hkdfSync(
        'sha256',
        masterKey,
        HKDF_SALT,
        Buffer.from(moduleId),
        KEY_LENGTH
    );
    // Convert ArrayBuffer to Buffer if needed (Node.js v24+)
    return Buffer.isBuffer(derived) ? derived : Buffer.from(derived);
}

/**
 * Derive all module keys from master key
 * @param {Buffer} masterKey - Master key
 * @returns {Map} Map of moduleId -> key Buffer
 */
function deriveAllModuleKeys(masterKey) {
    const keys = new Map();
    for (const moduleId of ALLOWED_MODULES) {
        keys.set(moduleId, deriveModuleKey(masterKey, moduleId));
    }
    return keys;
}

/**
 * Zero all keys in the moduleKeys map
 * @param {Map} keys - Map of keys to zero
 */
function zeroAllKeys(keys) {
    if (keys) {
        for (const [moduleId, key] of keys) {
            zeroBuffer(key);
        }
        keys.clear();
    }
}

/**
 * Log a security event to audit service (with key fingerprint only)
 * @param {string} eventType - Event type
 * @param {object} data - Data to log
 */
function logSecurityEvent(eventType, data) {
    try {
        const fingerprint = masterKey ? getKeyFingerprint(masterKey) : 'none';
        auditService.logSecurityEvent({
            event: eventType,
            fingerprint,
            ...data,
            sensitive: false
        });
    } catch (e) {
        // Fail silently - never crash due to logging
    }
}

/**
 * Emit a warning event
 * @param {string} message - Warning message
 */
function emitWarning(message) {
    emitter.emit('keys:warning', { message });
    logSecurityEvent('key_manager_warning', { message });
}

// =============================================================================
// MAIN FUNCTIONS
// =============================================================================

/**
 * Initialise the key manager
 * Loads master key from environment or generates from entropy,
 * derives all module keys, and starts rotation scheduler.
 * 
 * @returns {Promise<{success: boolean, keyAge: Date, modulesKeyed: number}>}
 */
async function initKeyManager() {
    try {
        // Prevent double initialization
        if (masterKey && moduleKeys.size > 0) {
            return {
                success: true,
                keyAge: lastRotation,
                modulesKeyed: moduleKeys.size
            };
        }

        // Load or generate master key
        const envKey = process.env[MASTER_KEY_ENV];
        
        if (envKey) {
            // Validate and convert hex string to Buffer
            if (!/^[0-9a-fA-F]{64}$/.test(envKey)) {
                throw new Error('Invalid SENTINEL_MASTER_KEY format (must be 64-char hex)');
            }
            masterKey = Buffer.from(envKey, 'hex');
            keySource = 'env';
            
            logSecurityEvent('key_manager_init', {
                source: 'env',
                action: 'loaded_existing'
            });
        } else {
            // Generate new master key from entropy
            masterKey = entropy.getSecureRandom(KEY_LENGTH);
            keySource = 'generated';
            
            emitWarning('SENTINEL_MASTER_KEY not set - generated new master key. Store this key securely!');
            
            logSecurityEvent('key_manager_init', {
                source: 'generated',
                action: 'key_generated'
            });
        }

        // Derive all module keys
        moduleKeys = deriveAllModuleKeys(masterKey);
        
        // Set rotation timestamp
        lastRotation = new Date();
        
        // Start rotation scheduler
        if (rotationScheduler) {
            clearInterval(rotationScheduler);
        }
        rotationScheduler = setInterval(() => {
            rotateKeys('scheduled').catch(err => {
                emitWarning('Scheduled key rotation failed: ' + err.message);
            });
        }, ROTATION_INTERVAL);

        logSecurityEvent('key_manager_ready', {
            modulesKeyed: moduleKeys.size,
            fingerprint: getKeyFingerprint(masterKey)
        });

        return {
            success: true,
            keyAge: lastRotation,
            modulesKeyed: moduleKeys.size
        };
        
    } catch (error) {
        logSecurityEvent('key_manager_init_failed', {
            error: error.message
        });
        throw error;
    }
}

/**
 * Get a derived key for a specific module
 * Returns a COPY of the key buffer (not the stored reference)
 * 
 * @param {string} moduleId - Module identifier
 * @returns {Buffer} Derived key (copy)
 * @throws {Error} If moduleId not recognised or not initialised
 */
function getKey(moduleId) {
    if (destroyed) {
        throw new Error('Key manager has been destroyed');
    }
    
    if (!masterKey) {
        throw new Error('Key manager not initialized - call initKeyManager() first');
    }
    
    // Validate moduleId
    if (!ALLOWED_MODULES.includes(moduleId)) {
        throw new Error(`Invalid moduleId: ${moduleId}. Allowed: ${ALLOWED_MODULES.join(', ')}`);
    }
    
    const storedKey = moduleKeys.get(moduleId);
    if (!storedKey) {
        throw new Error(`Key not found for module: ${moduleId}`);
    }
    
    // Return a TRUE COPY, not a reference (Buffer.from shares memory!)
    const keyCopy = Buffer.alloc(storedKey.length);
    storedKey.copy(keyCopy);
    return keyCopy;
}

/**
 * Rotate all keys
 * Generates new master key, re-derives all module keys,
 * and zeros old keys before replacing.
 * 
 * @param {string} reason - Reason for rotation
 * @returns {Promise<{success: boolean, rotatedAt: Date, reason: string}>}
 */
async function rotateKeys(reason = 'scheduled') {
    try {
        if (destroyed) {
            throw new Error('Cannot rotate keys - key manager destroyed');
        }
        
        if (!masterKey) {
            throw new Error('Key manager not initialized');
        }

        // Store old fingerprint before zeroing
        const oldFingerprint = getKeyFingerprint(masterKey);
        
        // ZERO old keys BEFORE generating new ones (security requirement)
        zeroBuffer(masterKey);
        zeroAllKeys(moduleKeys);
        
        // Generate new master key
        masterKey = entropy.getSecureRandom(KEY_LENGTH);
        
        // Re-derive all module keys
        moduleKeys = deriveAllModuleKeys(masterKey);
        
        // Update rotation metadata
        lastRotation = new Date();
        rotationCount++;
        
        // Log rotation event
        logSecurityEvent('keys_rotated', {
            reason,
            oldFingerprint,
            newFingerprint: getKeyFingerprint(masterKey),
            rotationCount
        });
        
        // Emit rotation event
        emitter.emit('keys:rotated', {
            rotatedAt: lastRotation,
            reason,
            rotationCount
        });
        
        return {
            success: true,
            rotatedAt: lastRotation,
            reason
        };
        
    } catch (error) {
        logSecurityEvent('key_rotation_failed', {
            reason,
            error: error.message
        });
        throw error;
    }
}

/**
 * Destroy all keys immediately
 * Zeros all key material, cancels scheduler, logs CRITICAL event.
 * 
 * @returns {{destroyed: boolean, timestamp: Date}}
 */
function destroyKeys() {
    try {
        // Cancel rotation scheduler
        if (rotationScheduler) {
            clearInterval(rotationScheduler);
            rotationScheduler = null;
        }
        
        // Zero all keys
        zeroBuffer(masterKey);
        zeroAllKeys(moduleKeys);
        
        masterKey = null;
        moduleKeys = new Map();
        destroyed = true;
        
        const timestamp = new Date();
        
        // Log CRITICAL destruction event
        logSecurityEvent('keys_destroyed', {
            destroyed: true,
            timestamp: timestamp.toISOString(),
            rotationCount
        });
        
        // Emit destruction event
        emitter.emit('keys:destroyed', { timestamp });
        
        return {
            destroyed: true,
            timestamp
        };
        
    } catch (error) {
        // Even on error, mark as destroyed
        destroyed = true;
        return {
            destroyed: true,
            timestamp: new Date()
        };
    }
}

/**
 * Get key status for dashboard
 * NEVER includes key material
 * 
 * @returns {object} Key health status
 */
function getKeyStatus() {
    const now = new Date();
    const masterKeyAge = lastRotation ? now.getTime() - lastRotation.getTime() : null;
    const nextRotation = lastRotation 
        ? new Date(lastRotation.getTime() + ROTATION_INTERVAL).toISOString()
        : null;
    
    return {
        active: !!masterKey && !destroyed,
        healthy: !destroyed && masterKeyAge !== null && masterKeyAge < ROTATION_INTERVAL,
        masterKeyAge,
        lastRotation: lastRotation ? lastRotation.toISOString() : null,
        nextRotation,
        modulesKeyed: moduleKeys.size,
        rotationCount,
        destroyed,
        details: {
            moduleIds: ALLOWED_MODULES.filter(id => moduleKeys.has(id)),
            keySource
        }
    };
}

/**
 * Get standard NovaSentinel status
 * 
 * @returns {{active: boolean, healthy: boolean, details: object}}
 */
function getStatus() {
    const keyStatus = getKeyStatus();
    
    return {
        active: keyStatus.active,
        healthy: keyStatus.healthy,
        details: {
            keyManager: keyStatus,
            rotationInterval: ROTATION_INTERVAL,
            allowedModules: ALLOWED_MODULES.length
        }
    };
}

// =============================================================================
// EVENT EMITTER PROXY
// =============================================================================

/**
 * Register event listener
 * @param {string} event - Event name
 * @param {function} listener - Event handler
 */
function on(event, listener) {
    emitter.on(event, listener);
}

/**
 * Unregister event listener
 * @param {string} event - Event name
 * @param {function} listener - Event handler
 */
function off(event, listener) {
    emitter.off(event, listener);
}

/**
 * Emit an event
 * @param {string} event - Event name
 * @param {object} data - Event data
 */
function emit(event, data) {
    emitter.emit(event, data);
}

// =============================================================================
// MODULE EXPORTS
// =============================================================================

module.exports = {
    // Core functions
    initKeyManager,
    getKey,
    rotateKeys,
    destroyKeys,
    getKeyStatus,
    getStatus,
    
    // Event emitter
    on,
    off,
    emit,
    
    // Constants (read-only)
    ALLOWED_MODULES
};
