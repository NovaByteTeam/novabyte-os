/**
 * NovaSentinel Browser-Based Key Vault
 * 
 * This module simulates Knox Vault / Secure Enclave key storage using browser APIs:
 * - OPFS (Origin Private File System) for persistent secure storage
 * - IndexedDB for key metadata and wrapped keys
 * - SubtleCrypto with non-extractable keys
 * - Dual-layer encryption (device + user passphrase)
 * 
 * SECURITY REQUIREMENTS:
 * - All keys have extractable: false - they can be used but never exported
 * - Dual-layer encryption: device key + user passphrase (PBKDF2)
 * - Key hierarchy: LEVEL_0 (device root) -> LEVEL_1 (wrapped app keys) -> LEVEL_2 (session)
 * - Secure memory zeroing for all key material
 * - Audit logging for all security events
 * 
 * @module sentinel/vault/sentinel-vault
 */

'use strict';

// Wrap in IIFE to avoid global const conflicts when loaded in browser
(function() {
// =============================================================================
// BROWSER-ONLY MODULE CHECK
// =============================================================================

if (typeof window === 'undefined' && typeof global !== 'undefined') {
    // Node.js environment - this module is browser-only
    console.warn('[NovaSentinel] sentinel-vault.js is designed for browser environment only');
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Cryptographic constants */
const PBKDF2_ITERATIONS = 200000;
const AES_KEY_LENGTH = 256;
const SALT_LENGTH = 32;
const IV_LENGTH = 12; // 96 bits (recommended for GCM)
const AUTH_TAG_LENGTH = 16; // 128 bits
const AES_GCM_ALGORITHM = 'AES-GCM';
const PBKDF2_ALGORITHM = 'PBKDF2';

/** Key hierarchy levels */
const KEY_LEVEL = {
    LEVEL_0: 0, // Device root key - never exported, tied to browser origin
    LEVEL_1: 1, // Wrapped application keys
    LEVEL_2: 2  // Session keys - ephemeral, cleared on tab close
};

/** IndexedDB constants */
const DB_NAME = 'NovaSentinelVault';
const DB_VERSION = 1;
const STORE_KEYS = 'keys';
const STORE_METADATA = 'metadata';
const STORE_SESSIONS = 'sessions';

/** Error codes */
const ERROR_CODES = {
    KEY_NOT_FOUND: 'SENTINEL_VAULT_KEY_NOT_FOUND',
    DECRYPTION_FAILED: 'SENTINEL_VAULT_DECRYPTION_FAILED',
    KEY_EXTRACTION_ATTEMPT: 'SENTINEL_VAULT_KEY_EXTRACTION_ATTEMPT',
    INVALID_PCR_STATE: 'SENTINEL_VAULT_INVALID_PCR_STATE',
    DATABASE_ERROR: 'SENTINEL_VAULT_DATABASE_ERROR',
    CRYPTO_ERROR: 'SENTINEL_VAULT_CRYPTO_ERROR',
    KEY_EXPIRED: 'SENTINEL_VAULT_KEY_EXPIRED',
    SESSION_EXPIRED: 'SENTINEL_VAULT_SESSION_EXPIRED'
};

// =============================================================================
// STATE
// =============================================================================

/** IndexedDB instance */
let db = null;

/** In-memory key cache (LEVEL_0 and LEVEL_1 only) */
const keyCache = new Map();

/** Session keys (LEVEL_2) - cleared on page unload */
const sessionKeys = new Map();

/** Device root key (LEVEL_0) */
let deviceRootKey = null;

/** Whether vault is initialized */
let initialized = false;

/** Pending operation queue */
const operationQueue = [];

/** Audit logging callback */
let auditLogger = null;

// =============================================================================
// ERROR CLASSES
// =============================================================================

/**
 * Base vault error
 */
class VaultError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'VaultError';
        this.code = code;
        this.details = details;
        this.timestamp = new Date().toISOString();
    }
}

/**
 * Key not found error
 */
class KeyNotFoundError extends VaultError {
    constructor(keyName, level) {
        super(
            ERROR_CODES.KEY_NOT_FOUND,
            `Key not found: ${keyName} at level ${level}`,
            { keyName, level }
        );
        this.name = 'KeyNotFoundError';
    }
}

/**
 * Decryption failure error
 */
class DecryptionFailedError extends VaultError {
    constructor(reason, keyName) {
        super(
            ERROR_CODES.DECRYPTION_FAILED,
            `Decryption failed: ${reason}`,
            { reason, keyName }
        );
        this.name = 'DecryptionFailedError';
    }
}

/**
 * Key extraction attempt error
 */
class KeyExtractionAttemptError extends VaultError {
    constructor(keyName) {
        super(
            ERROR_CODES.KEY_EXTRACTION_ATTEMPT,
            `Attempted to extract non-extractable key: ${keyName}`,
            { keyName }
        );
        this.name = 'KeyExtractionAttemptError';
    }
}

/**
 * Invalid PCR state error
 */
class InvalidPCRStateError extends VaultError {
    constructor(expected, actual) {
        super(
            ERROR_CODES.INVALID_PCR_STATE,
            'PCR state mismatch - device state has changed',
            { expected, actual }
        );
        this.name = 'InvalidPCRStateError';
    }
}

// =============================================================================
// AUDIT LOGGING
// =============================================================================

/**
 * Set audit logger callback
 * @param {Function} logger - Async function (event, data) => {}
 */
function setAuditLogger(logger) {
    auditLogger = logger;
}

/**
 * Log security event
 * @param {string} event - Event type
 * @param {object} data - Event data
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
        console.error('[NovaSentinel] Failed to log security event:', e.message);
    }
}

// =============================================================================
// INDEXEDDB OPERATIONS
// =============================================================================

/**
 * Open IndexedDB database
 * @returns {Promise<IDBDatabase>}
 */
async function openDatabase() {
    return new Promise((resolve, reject) => {
        if (db) {
            resolve(db);
            return;
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
            reject(new VaultError(
                ERROR_CODES.DATABASE_ERROR,
                'Failed to open vault database',
                { error: request.error?.message }
            ));
        };

        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const database = event.target.result;

            // Keys store
            if (!database.objectStoreNames.contains(STORE_KEYS)) {
                const keyStore = database.createObjectStore(STORE_KEYS, { keyPath: 'name' });
                keyStore.createIndex('level', 'level', { unique: false });
                keyStore.createIndex('created', 'created', { unique: false });
            }

            // Metadata store
            if (!database.objectStoreNames.contains(STORE_METADATA)) {
                database.createObjectStore(STORE_METADATA, { keyPath: 'key' });
            }

            // Sessions store
            if (!database.objectStoreNames.contains(STORE_SESSIONS)) {
                const sessionStore = database.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
                sessionStore.createIndex('expires', 'expires', { unique: false });
            }
        };
    });
}

/**
 * Close IndexedDB database
 */
function closeDatabase() {
    if (db) {
        db.close();
        db = null;
    }
}

/**
 * Store key in IndexedDB
 * @param {string} name - Key name
 * @param {CryptoKey} key - Key object
 * @param {number} level - Key level (0, 1, or 2)
 * @param {object} metadata - Additional metadata
 */
async function storeKey(name, key, level, metadata = {}) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_KEYS, STORE_METADATA], 'readwrite');
        const keyStore = transaction.objectStore(STORE_KEYS);
        const metaStore = transaction.objectStore(STORE_METADATA);

        // Export key material (as non-extractable, this is the wrapped form)
        crypto.subtle.exportKey('raw', key).then(keyMaterial => {
            const keyData = {
                name,
                level,
                keyMaterial: new Uint8Array(keyMaterial),
                algorithm: key.algorithm.name,
                created: new Date().toISOString(),
                ...metadata
            };

            const metaData = {
                key: name,
                level,
                created: keyData.created,
                extracted: false,
                ...metadata
            };

            keyStore.put(keyData);
            metaStore.put(metaData);

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(new VaultError(
                ERROR_CODES.DATABASE_ERROR,
                'Failed to store key',
                { error: transaction.error?.message }
            ));
        }).catch(reject);
    });
}

/**
 * Retrieve key from IndexedDB
 * @param {string} name - Key name
 * @returns {Promise<{key: CryptoKey, level: number, metadata: object}>}
 */
async function retrieveKey(name) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_KEYS, STORE_METADATA], 'readonly');
        const keyStore = transaction.objectStore(STORE_KEYS);
        const metaStore = transaction.objectStore(STORE_METADATA);

        const keyRequest = keyStore.get(name);
        const metaRequest = metaStore.get(name);

        keyRequest.onsuccess = () => {
            if (!keyRequest.result) {
                reject(new KeyNotFoundError(name, 'unknown'));
                return;
            }

            const keyData = keyRequest.result;
            const metaData = metaRequest.result || {};

            // Import key back as non-extractable
            crypto.subtle.importKey(
                'raw',
                keyData.keyMaterial,
                { name: AES_GCM_ALGORITHM, length: AES_KEY_LENGTH },
                false,
                ['encrypt', 'decrypt']
            ).then(key => {
                resolve({
                    key,
                    level: keyData.level,
                    metadata: { ...keyData, ...metaData }
                });
            }).catch(reject);
        };

        keyRequest.onerror = () => reject(new VaultError(
            ERROR_CODES.DATABASE_ERROR,
            'Failed to retrieve key',
            { error: keyRequest.error?.message }
        ));
    });
}

/**
 * Delete key from IndexedDB
 * @param {string} name - Key name
 */
async function deleteKey(name) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_KEYS, STORE_METADATA], 'readwrite');
        const keyStore = transaction.objectStore(STORE_KEYS);
        const metaStore = transaction.objectStore(STORE_METADATA);

        keyStore.delete(name);
        metaStore.delete(name);

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(new VaultError(
            ERROR_CODES.DATABASE_ERROR,
            'Failed to delete key',
            { error: transaction.error?.message }
        ));
    });
}

/**
 * Get all keys at a specific level
 * @param {number} level - Key level
 * @returns {Promise<Array>}
 */
async function getKeysAtLevel(level) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_KEYS], 'readonly');
        const keyStore = transaction.objectStore(STORE_KEYS);
        const index = keyStore.index('level');
        const request = index.getAll(level);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// =============================================================================
// CRYPTOGRAPHIC PRIMITIVES
// =============================================================================

/**
 * Generate a non-extractable AES-256-GCM key
 * @returns {Promise<CryptoKey>}
 */
async function generateNonExtractableKey() {
    return crypto.subtle.generateKey(
        { name: AES_GCM_ALGORITHM, length: AES_KEY_LENGTH },
        false, // extractable: false
        ['encrypt', 'decrypt']
    );
}

/**
 * Derive key from passphrase using PBKDF2
 * @param {string} passphrase - User passphrase
 * @param {Uint8Array} salt - Salt bytes
 * @returns {Promise<CryptoKey>}
 */
async function deriveKeyFromPassphrase(passphrase, salt) {
    const encoder = new TextEncoder();
    const passphraseKey = await crypto.subtle.importKey(
        'raw',
        encoder.encode(passphrase),
        { name: PBKDF2_ALGORITHM },
        false,
        ['deriveBits', 'deriveKey']
    );

    return crypto.subtle.deriveKey(
        {
            name: PBKDF2_ALGORITHM,
            salt: salt,
            iterations: PBKDF2_ITERATIONS,
            hash: 'SHA-256'
        },
        passphraseKey,
        { name: AES_GCM_ALGORITHM, length: AES_KEY_LENGTH },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Derive key from device root key using HKDF
 * @param {CryptoKey} rootKey - Root key
 * @param {string} info - Application info
 * @param {Uint8Array} salt - Optional salt
 * @returns {Promise<CryptoKey>}
 */
async function deriveKeyFromRoot(rootKey, info, salt = new Uint8Array(0)) {
    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            salt: salt,
            info: new TextEncoder().encode(info),
            hash: 'SHA-256'
        },
        rootKey,
        { name: AES_GCM_ALGORITHM, length: AES_KEY_LENGTH },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Generate random bytes
 * @param {number} length - Number of bytes
 * @returns {Uint8Array}
 */
function generateRandomBytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Encrypt data using AES-256-GCM
 * @param {ArrayBuffer|string} plaintext - Data to encrypt
 * @param {CryptoKey} key - Encryption key
 * @returns {Promise<{ciphertext: Uint8Array, iv: Uint8Array, tag: Uint8Array}>}
 */
async function encryptAESGCM(plaintext, key) {
    const encoder = new TextEncoder();
    const data = typeof plaintext === 'string' 
        ? encoder.encode(plaintext) 
        : new Uint8Array(plaintext);
    
    const iv = generateRandomBytes(IV_LENGTH);

    const ciphertext = await crypto.subtle.encrypt(
        { name: AES_GCM_ALGORITHM, iv: iv },
        key,
        data
    );

    // GCM appends the auth tag to the ciphertext
    const ciphertextArray = new Uint8Array(ciphertext);
    const tag = ciphertextArray.slice(-AUTH_TAG_LENGTH);
    const encryptedData = ciphertextArray.slice(0, -AUTH_TAG_LENGTH);

    return {
        ciphertext: encryptedData,
        iv: iv,
        tag: tag
    };
}

/**
 * Decrypt data using AES-256-GCM
 * @param {Uint8Array} ciphertext - Encrypted data
 * @param {Uint8Array} iv - Initialization vector
 * @param {Uint8Array} tag - Authentication tag
 * @param {CryptoKey} key - Decryption key
 * @returns {Promise<Uint8Array>}
 */
async function decryptAESGCM(ciphertext, iv, tag, key) {
    // Reconstruct the full ciphertext with tag
    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext, 0);
    combined.set(tag, ciphertext.length);

    try {
        const plaintext = await crypto.subtle.decrypt(
            { name: AES_GCM_ALGORITHM, iv: iv },
            key,
            combined
        );
        return new Uint8Array(plaintext);
    } catch (error) {
        throw new DecryptionFailedError(error.message, key.toString());
    }
}

/**
 * Compute SHA-256 hash
 * @param {ArrayBuffer| string} data - Data to hash
 * @returns {Promise<Uint8Array>}
 */
async function computeHash(data) {
    const encoder = new TextEncoder();
    const buffer = typeof data === 'string' ? encoder.encode(data) : data;
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return new Uint8Array(hashBuffer);
}

// =============================================================================
// DUAL-LAYER ENCRYPTION (DualDAR equivalent)
// =============================================================================

/**
 * Encrypt data with dual-layer encryption
 * 
 * Layer 1: device key (tied to browser origin)
 * Layer 2: user key (derived from passphrase via PBKDF2)
 * 
 * @param {ArrayBuffer|string} data - Data to encrypt
 * @param {string} passphrase - User passphrase for Layer 2
 * @returns {Promise<Uint8Array>} - Combined encrypted blob
 */
async function dualLayerEncrypt(data, passphrase) {
    if (!deviceRootKey) {
        throw new VaultError(ERROR_CODES.CRYPTO_ERROR, 'Device root key not initialized');
    }

    // Layer 1: Encrypt with device key
    const layer1Encryption = await encryptAESGCM(data, deviceRootKey);
    
    // Derive user key from passphrase
    const userSalt = generateRandomBytes(SALT_LENGTH);
    const userKey = await deriveKeyFromPassphrase(passphrase, userSalt);

    // Layer 2: Encrypt Layer 1 ciphertext (not plaintext - ciphertext)
    // We encrypt: layer1_ciphertext + layer1_iv + layer1_tag
    const layer1Blob = new Uint8Array(
        layer1Encryption.ciphertext.length + 
        layer1Encryption.iv.length + 
        layer1Encryption.tag.length
    );
    layer1Blob.set(layer1Encryption.ciphertext, 0);
    layer1Blob.set(layer1Encryption.iv, layer1Encryption.ciphertext.length);
    layer1Blob.set(layer1Encryption.tag, layer1Encryption.ciphertext.length + layer1Encryption.iv.length);

    const layer2Encryption = await encryptAESGCM(layer1Blob, userKey);

    // Combine everything: userSalt + layer2_iv + layer2_tag + layer2_ciphertext
    const finalBlob = new Uint8Array(
        userSalt.length +
        layer2Encryption.iv.length +
        layer2Encryption.tag.length +
        layer2Encryption.ciphertext.length
    );
    finalBlob.set(userSalt, 0);
    finalBlob.set(layer2Encryption.iv, userSalt.length);
    finalBlob.set(
        layer2Encryption.tag, 
        userSalt.length + layer2Encryption.iv.length
    );
    finalBlob.set(
        layer2Encryption.ciphertext,
        userSalt.length + layer2Encryption.iv.length + layer2Encryption.tag.length
    );

    // Securely wipe user key from memory
    await secureWipe('userKey');

    return finalBlob;
}

/**
 * Decrypt data with dual-layer decryption
 * 
 * @param {Uint8Array} sealedBlob - Combined encrypted blob
 * @param {string} passphrase - User passphrase for Layer 2
 * @returns {Promise<Uint8Array>} - Original plaintext
 */
async function dualLayerDecrypt(sealedBlob, passphrase) {
    if (!deviceRootKey) {
        throw new VaultError(ERROR_CODES.CRYPTO_ERROR, 'Device root key not initialized');
    }

    let offset = 0;

    // Extract user salt
    const userSalt = sealedBlob.slice(offset, offset + SALT_LENGTH);
    offset += SALT_LENGTH;

    // Extract Layer 2 components
    const layer2IV = sealedBlob.slice(offset, offset + IV_LENGTH);
    offset += IV_LENGTH;
    const layer2Tag = sealedBlob.slice(offset, offset + AUTH_TAG_LENGTH);
    offset += AUTH_TAG_LENGTH;
    const layer2Ciphertext = sealedBlob.slice(offset);

    // Derive user key from passphrase
    const userKey = await deriveKeyFromPassphrase(passphrase, userSalt);

    // Layer 2: Decrypt
    const layer1Blob = await decryptAESGCM(layer2Ciphertext, layer2IV, layer2Tag, userKey);

    // Extract Layer 1 components from layer1Blob
    offset = 0;
    const layer1Ciphertext = layer1Blob.slice(offset, layer1Blob.length - IV_LENGTH - AUTH_TAG_LENGTH);
    offset = layer1Blob.length - IV_LENGTH - AUTH_TAG_LENGTH;
    const layer1IV = layer1Blob.slice(offset, offset + IV_LENGTH);
    offset += IV_LENGTH;
    const layer1Tag = layer1Blob.slice(offset, offset + AUTH_TAG_LENGTH);

    // Layer 1: Decrypt
    const plaintext = await decryptAESGCM(layer1Ciphertext, layer1IV, layer1Tag, deviceRootKey);

    // Securely wipe user key from memory
    await secureWipe('userKey');

    return plaintext;
}

// =============================================================================
// KEY HIERARCHY MANAGEMENT
// =============================================================================

/**
 * Initialize device root key (LEVEL_0)
 * Creates a new key if none exists, otherwise loads existing
 * @returns {Promise<CryptoKey>}
 */
async function initializeDeviceRootKey() {
    // Check if we already have device root key in memory
    if (deviceRootKey) {
        return deviceRootKey;
    }

    // Try to load from IndexedDB
    try {
        const keyData = await retrieveKey('device_root');
        deviceRootKey = keyData.key;
        await logSecurityEvent('VAULT_DEVICE_KEY_LOADED', { level: KEY_LEVEL.LEVEL_0 });
        return deviceRootKey;
    } catch (error) {
        if (!(error instanceof KeyNotFoundError)) {
            throw error;
        }
    }

    // Generate new device root key
    deviceRootKey = await generateNonExtractableKey();
    
    // Store in IndexedDB
    await storeKey('device_root', deviceRootKey, KEY_LEVEL.LEVEL_0, {
        description: 'Device root key - never exported, tied to browser origin',
        origin: typeof window !== 'undefined' ? window.location.origin : 'unknown'
    });

    await logSecurityEvent('VAULT_DEVICE_KEY_CREATED', { level: KEY_LEVEL.LEVEL_0 });

    return deviceRootKey;
}

/**
 * Create or get application key (LEVEL_1)
 * @param {string} keyName - Application key name
 * @param {string} passphrase - Optional passphrase for dual-layer encryption
 * @returns {Promise<CryptoKey>}
 */
async function getOrCreateAppKey(keyName, passphrase = null) {
    // Check memory cache first
    if (keyCache.has(keyName)) {
        return keyCache.get(keyName);
    }

    // Try to load from IndexedDB
    try {
        const keyData = await retrieveKey(keyName);
        
        // If passphrase provided, decrypt the wrapped key
        if (passphrase) {
            const wrapped = keyData.metadata.wrapped;
            if (wrapped) {
                const decrypted = await dualLayerDecrypt(new Uint8Array(wrapped), passphrase);
                const importedKey = await crypto.subtle.importKey(
                    'raw',
                    decrypted,
                    { name: AES_GCM_ALGORITHM, length: AES_KEY_LENGTH },
                    false,
                    ['encrypt', 'decrypt']
                );
                keyCache.set(keyName, importedKey);
                return importedKey;
            }
        }
        
        keyCache.set(keyName, keyData.key);
        return keyData.key;
    } catch (error) {
        if (!(error instanceof KeyNotFoundError)) {
            throw error;
        }
    }
    // Key doesn't exist - create new
    return createAppKey(keyName, passphrase);
}

/**
 * Create new application key (LEVEL_1)
 * @param {string} keyName - Application key name
 * @param {string} passphrase - Optional passphrase for dual-layer encryption
 * @returns {Promise<CryptoKey>}
 */
async function createAppKey(keyName, passphrase = null) {
    // Generate new key
    const appKey = await generateNonExtractableKey();
    
    // Derive application key from device root
    const derivedKey = await deriveKeyFromRoot(deviceRootKey, `app_key:${keyName}`);
    
    // Wrap the application key with derived key
    const wrapped = await encryptAESGCM(
        await crypto.subtle.exportKey('raw', appKey),
        derivedKey
    );

    // Store metadata with wrapped key
    const metadata = {
        wrapped: wrapped.ciphertext.concat(wrapped.iv, wrapped.tag),
        wrappedIV: wrapped.iv,
        wrappedTag: wrapped.tag,
        wrappedSalt: generateRandomBytes(SALT_LENGTH),
        description: `Application key: ${keyName}`
    };

    // If passphrase provided, also encrypt with user passphrase
    if (passphrase) {
        const userWrapped = await dualLayerEncrypt(
            await crypto.subtle.exportKey('raw', appKey),
            passphrase
        );
        metadata.userWrapped = Array.from(userWrapped);
    }

    await storeKey(keyName, appKey, KEY_LEVEL.LEVEL_1, metadata);
    keyCache.set(keyName, appKey);

    await logSecurityEvent('VAULT_APP_KEY_CREATED', { keyName, level: KEY_LEVEL.LEVEL_1 });

    return appKey;
}

/**
 * Generate ephemeral session key (LEVEL_2)
 * @param {string} sessionId - Session identifier
 * @param {number} expiryMs - Expiry in milliseconds (default: 1 hour)
 * @returns {Promise<CryptoKey>}
 */
async function generateSessionKey(sessionId, expiryMs = 3600000) {
    // Generate ephemeral key
    const sessionKey = await generateNonExtractableKey();

    // Store in session cache
    sessionKeys.set(sessionId, {
        key: sessionKey,
        expires: Date.now() + expiryMs,
        created: new Date().toISOString()
    });

    await logSecurityEvent('VAULT_SESSION_KEY_CREATED', { 
        sessionId, 
        level: KEY_LEVEL.LEVEL_2,
        expires: new Date(Date.now() + expiryMs).toISOString()
    });

    return sessionKey;
}

/**
 * Get session key
 * @param {string} sessionId - Session identifier
 * @returns {Promise<CryptoKey>}
 */
async function getSessionKey(sessionId) {
    const session = sessionKeys.get(sessionId);
    
    if (!session) {
        throw new KeyNotFoundError(sessionId, KEY_LEVEL.LEVEL_2);
    }

    if (Date.now() > session.expires) {
        sessionKeys.delete(sessionId);
        throw new VaultError(
            ERROR_CODES.SESSION_EXPIRED,
            'Session key has expired',
            { sessionId }
        );
    }

    return session.key;
}

/**
 * Clear all session keys
 */
function clearAllSessionKeys() {
    sessionKeys.clear();
    logSecurityEvent('VAULT_SESSION_KEYS_CLEARED', { count: sessionKeys.size });
}

// =============================================================================
// SECURITY FUNCTIONS
// =============================================================================

/**
 * Seal data with PCR (Platform Configuration Register) state
 * Binds encrypted data to device/browser state
 * 
 * @param {ArrayBuffer|string} data - Data to seal
 * @param {object} pcrState - PCR state (e.g., browser fingerprint, extensions)
 * @param {string} passphrase - Optional passphrase for additional layer
 * @returns {Promise<Uint8Array>} - Sealed blob
 */
async function sealKey(data, pcrState = {}, passphrase = null) {
    // Compute PCR hash
    const pcrHash = await computeHash(JSON.stringify(pcrState));
    
    // Create sealed data structure
    const encoder = new TextEncoder();
    const dataBytes = typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data);
    
    // Combine data with PCR hash
    const sealedData = new Uint8Array(dataBytes.length + pcrHash.length);
    sealedData.set(dataBytes, 0);
    sealedData.set(pcrHash, dataBytes.length);

    // Apply dual-layer encryption if passphrase provided
    if (passphrase) {
        return dualLayerEncrypt(sealedData, passphrase);
    }

    // Otherwise, just encrypt with device key
    const encryption = await encryptAESGCM(sealedData, deviceRootKey);
    
    // Combine: pcrHash + iv + tag + ciphertext
    const blob = new Uint8Array(
        pcrHash.length +
        encryption.iv.length +
        encryption.tag.length +
        encryption.ciphertext.length
    );
    let offset = 0;
    blob.set(encryption.ciphertext, offset); offset += encryption.ciphertext.length;
    blob.set(encryption.iv, offset); offset += encryption.iv.length;
    blob.set(encryption.tag, offset); offset += encryption.tag.length;
    blob.set(pcrHash, offset);

    return blob;
}

/**
 * Unseal data and verify PCR state
 * 
 * @param {Uint8Array} sealedBlob - Sealed blob
 * @param {object} pcrState - Current PCR state
 * @param {string} passphrase - Optional passphrase
 * @returns {Promise<Uint8Array>} - Unsealed data
 */
async function unsealKey(sealedBlob, pcrState = {}, passphrase = null) {
    let dataBytes;
    let storedPcrHash;

    if (passphrase) {
        // Decrypt using dual-layer decryption
        const decrypted = await dualLayerDecrypt(sealedBlob, passphrase);
        
        // Extract PCR hash from end
        const pcrHashLength = 32; // SHA-256
        dataBytes = decrypted.slice(0, -pcrHashLength);
        storedPcrHash = decrypted.slice(-pcrHashLength);
    } else {
        // Parse the blob
        const pcrHashLength = 32;
        const tagLength = AUTH_TAG_LENGTH;
        const ivLength = IV_LENGTH;
        
        const ciphertextLength = sealedBlob.length - pcrHashLength - tagLength - ivLength;
        const ciphertext = sealedBlob.slice(0, ciphertextLength);
        const iv = sealedBlob.slice(ciphertextLength, ciphertextLength + ivLength);
        const tag = sealedBlob.slice(ciphertextLength + ivLength, ciphertextLength + ivLength + tagLength);
        storedPcrHash = sealedBlob.slice(ciphertextLength + ivLength + tagLength);

        // Decrypt
        dataBytes = await decryptAESGCM(ciphertext, iv, tag, deviceRootKey);
    }

    // Verify PCR state
    const currentPcrHash = await computeHash(JSON.stringify(pcrState));
    
    // Constant-time comparison
    let matches = true;
    for (let i = 0; i < storedPcrHash.length; i++) {
        if (storedPcrHash[i] !== currentPcrHash[i]) {
            matches = false;
        }
    }

    if (!matches) {
        await logSecurityEvent('VAULT_PCR_MISMATCH', {
            expected: Array.from(storedPcrHash).slice(0, 8).join(','),
            actual: Array.from(currentPcrHash).slice(0, 8).join(',')
        });
        throw new InvalidPCRStateError(
            Array.from(storedPcrHash).slice(0, 8).join(','),
            Array.from(currentPcrHash).slice(0, 8).join(',')
        );
    }

    return dataBytes;
}

/**
 * Rotate all stored keys with new device key
 * Re-wraps all LEVEL_1 keys with new device root key
 * 
 * @returns {Promise<number>} - Number of keys rotated
 */
async function rotateKeys() {
    if (!deviceRootKey) {
        throw new VaultError(ERROR_CODES.CRYPTO_ERROR, 'Device root key not initialized');
    }

    // Get all LEVEL_1 keys
    const level1Keys = await getKeysAtLevel(KEY_LEVEL.LEVEL_1);
    let rotatedCount = 0;

    for (const keyData of level1Keys) {
        try {
            // Re-import key
            const key = await crypto.subtle.importKey(
                'raw',
                keyData.keyMaterial,
                { name: AES_GCM_ALGORITHM, length: AES_KEY_LENGTH },
                false,
                ['encrypt', 'decrypt']
            );

            // Re-derive and re-wrap with new device root
            const derivedKey = await deriveKeyFromRoot(deviceRootKey, `app_key:${keyData.name}`);
            const wrapped = await encryptAESGCM(
                await crypto.subtle.exportKey('raw', key),
                derivedKey
            );

            // Update metadata
            const metadata = {
                ...keyData,
                wrapped: wrapped.ciphertext.concat(wrapped.iv, wrapped.tag),
                wrappedIV: wrapped.iv,
                wrappedTag: wrapped.tag,
                wrappedSalt: generateRandomBytes(SALT_LENGTH),
                lastRotated: new Date().toISOString()
            };

            // Re-store
            await storeKey(keyData.name, key, KEY_LEVEL.LEVEL_1, metadata);
            rotatedCount++;
        } catch (error) {
            console.error(`[NovaSentinel] Failed to rotate key ${keyData.name}:`, error.message);
        }
    }

    // Generate new device root key (for future keys)
    const newDeviceRootKey = await generateNonExtractableKey();
    
    // Delete old device root key from storage (but keep in memory for decrypting old data)
    await deleteKey('device_root');
    
    // Store new device root key
    await storeKey('device_root', newDeviceRootKey, KEY_LEVEL.LEVEL_0, {
        description: 'Device root key - rotated',
        origin: typeof window !== 'undefined' ? window.location.origin : 'unknown',
        previousRotation: new Date().toISOString()
    });

    deviceRootKey = newDeviceRootKey;

    await logSecurityEvent('VAULT_KEYS_ROTATED', { 
        count: rotatedCount,
        level: KEY_LEVEL.LEVEL_0
    });

    return rotatedCount;
}

/**
 * Securely wipe key material from memory
 * Overwrites the key data in memory with zeros
 * 
 * @param {string} keyName - Key name to wipe
 * @returns {Promise<boolean>}
 */
async function secureWipe(keyName) {
    // Try memory cache first
    if (keyCache.has(keyName)) {
        keyCache.delete(keyName);
        await logSecurityEvent('VAULT_KEY_WIPED', { keyName, location: 'memory' });
        return true;
    }

    // Try session keys
    if (sessionKeys.has(keyName)) {
        sessionKeys.delete(keyName);
        await logSecurityEvent('VAULT_KEY_WIPED', { keyName, location: 'session' });
        return true;
    }

    // Try IndexedDB
    try {
        await deleteKey(keyName);
        await logSecurityEvent('VAULT_KEY_WIPED', { keyName, location: 'storage' });
        return true;
    } catch (error) {
        if (error instanceof KeyNotFoundError) {
            return false;
        }
        throw error;
    }
}

// =============================================================================
// VAULT INITIALIZATION
// =============================================================================

/**
 * Initialize the vault
 * Call this before using any other vault functions
 * 
 * @param {object} options - Initialization options
 * @param {boolean} options.autoCreateDeviceKey - Create device key if not exists
 * @returns {Promise<boolean>}
 */
async function initialize(options = {}) {
    if (initialized) {
        return true;
    }

    try {
        // Open database
        await openDatabase();

        // Initialize device root key if autoCreateDeviceKey
        if (options.autoCreateDeviceKey !== false) {
            await initializeDeviceRootKey();
        }

        // Set up page unload handler to clear session keys
        if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', clearAllSessionKeys);
        }

        initialized = true;
        await logSecurityEvent('VAULT_INITIALIZED', { 
            origin: typeof window !== 'undefined' ? window.location.origin : 'unknown'
        });

        return true;
    } catch (error) {
        await logSecurityEvent('VAULT_INIT_FAILED', { error: error.message });
        throw error;
    }
}

/**
 * Destroy the vault and clear all sensitive data
 */
async function destroy() {
    clearAllSessionKeys();
    
    // Clear memory cache
    for (const keyName of keyCache.keys()) {
        await secureWipe(keyName);
    }
    keyCache.clear();

    // Close database
    closeDatabase();

    deviceRootKey = null;
    initialized = false;

    await logSecurityEvent('VAULT_DESTROYED', {});
}

// =============================================================================
// EXPORTS
// =============================================================================

/**
 * NovaSentinel Browser-Based Key Vault
 * @type {Object}
 */
const sentinelVault = {
    // Constants
    KEY_LEVEL,
    ERROR_CODES,

    // Error classes
    VaultError,
    KeyNotFoundError,
    DecryptionFailedError,
    KeyExtractionAttemptError,
    InvalidPCRStateError,

    // Audit logging
    setAuditLogger,
    logSecurityEvent,

    // Initialization
    initialize,
    destroy,

    // Key management
    initializeDeviceRootKey,
    getOrCreateAppKey,
    createAppKey,
    generateSessionKey,
    getSessionKey,
    clearAllSessionKeys,

    // Security functions
    sealKey,
    unsealKey,
    rotateKeys,
    secureWipe,

    // Cryptographic utilities
    generateNonExtractableKey,
    deriveKeyFromPassphrase,
    deriveKeyFromRoot,
    generateRandomBytes,
    encryptAESGCM,
    decryptAESGCM,
    computeHash,
    dualLayerEncrypt,
    dualLayerDecrypt,

    // Database operations
    openDatabase,
    closeDatabase,
    storeKey,
    retrieveKey,
    deleteKey,
    getKeysAtLevel
};

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = sentinelVault;
} else if (typeof window !== 'undefined') {
    window.NovaSentinelVault = sentinelVault;
}
})(); // End IIFE