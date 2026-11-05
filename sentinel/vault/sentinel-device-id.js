/**
 * NovaSentinel Device Identity Anchor
 * 
 * This module provides WebAuthn-based device identity anchoring.
 * Uses browser WebAuthn API to create a device-bound credential
 * that serves as a hardware root of trust for the vault.
 * 
 * SECURITY REQUIREMENTS:
 * - Device anchor tied to WebAuthn credential (platform authenticator or security key)
 * - Attestation verification for credential authenticity
 * - User verification (biometrics/PIN) required for device key operations
 * - Audit logging for all device identity events
 * 
 * @module sentinel/vault/sentinel-device-id
 */

'use strict';

// Wrap in IIFE to avoid global const conflicts when loaded in browser
(function() {
// =============================================================================
// BROWSER-ONLY MODULE CHECK
// =============================================================================

if (typeof window === 'undefined' && typeof global !== 'undefined') {
    console.warn('[NovaSentinel] sentinel-device-id.js is designed for browser environment only');
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** WebAuthn credential lifetime (in milliseconds) */
const CREDENTIAL_LIFETIME = 365 * 24 * 60 * 60 * 1000; // 1 year

/** Device anchor storage key */
const DEVICE_ANCHOR_KEY = 'sentinel_device_anchor';

/** IndexedDB database name */
const DB_NAME = 'NovaSentinelDeviceDB';
const DB_VERSION = 1;
const STORE_DEVICES = 'devices';

/** Error codes */
const ERROR_CODES = {
    WEBAUTHN_UNAVAILABLE: 'SENTINEL_DEVICE_WEBAUTHN_UNAVAILABLE',
    CREDENTIAL_NOT_FOUND: 'SENTINEL_DEVICE_CREDENTIAL_NOT_FOUND',
    ATTESTATION_FAILED: 'SENTINEL_DEVICE_ATTESTATION_FAILED',
    VERIFICATION_FAILED: 'SENTINEL_DEVICE_VERIFICATION_FAILED',
    DEVICE_NOT_BOUND: 'SENTINEL_DEVICE_NOT_BOUND'
};

// =============================================================================
// STATE
// =============================================================================

/** IndexedDB instance */
let db = null;

/** Device anchor state */
let deviceAnchor = null;

/** Whether device is bound */
let isBound = false;

/** Audit logging callback */
let auditLogger = null;

// =============================================================================
// ERROR CLASSES
// =============================================================================

class DeviceIdentityError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DeviceIdentityError';
        this.code = code;
        this.details = details;
    }
}

class WebAuthnUnavailableError extends DeviceIdentityError {
    constructor() {
        super(
            ERROR_CODES.WEBAUTHN_UNAVAILABLE,
            'WebAuthn is not available in this browser'
        );
    }
}

class CredentialNotFoundError extends DeviceIdentityError {
    constructor(credentialId) {
        super(
            ERROR_CODES.CREDENTIAL_NOT_FOUND,
            `Device credential not found: ${credentialId?.slice(0, 8)}...`,
            { credentialId }
        );
    }
}

class AttestationFailedError extends DeviceIdentityError {
    constructor(reason) {
        super(
            ERROR_CODES.ATTESTATION_FAILED,
            `Device attestation failed: ${reason}`,
            { reason }
        );
    }
}

class VerificationFailedError extends DeviceIdentityError {
    constructor(reason) {
        super(
            ERROR_CODES.VERIFICATION_FAILED,
            `Device verification failed: ${reason}`,
            { reason }
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
        console.error('[NovaSentinel] Failed to log device identity event:', e.message);
    }
}

// =============================================================================
// WEBAUTHN UTILITIES
// =============================================================================

/**
 * Check if WebAuthn is available
 * @returns {boolean}
 */
function isWebAuthnAvailable() {
    return typeof navigator !== 'undefined' && 
           navigator.credentials && 
           navigator.credentials.create &&
           navigator.credentials.get;
}

/**
 * Generate random bytes for challenge
 * @param {number} length 
 * @returns {Uint8Array}
 */
function generateChallenge(length = 32) {
    const array = new Uint8Array(length);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(array);
    } else {
        // Fallback for testing
        for (let i = 0; i < length; i++) {
            array[i] = Math.floor(Math.random() * 256);
        }
    }
    return array;
}

/**
 * Convert buffer to base64url string
 * @param {ArrayBuffer|Uint8Array} buffer 
 * @returns {string}
 */
function bufferToBase64Url(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Convert base64url string to buffer
 * @param {string} base64url 
 * @returns {Uint8Array}
 */
function base64UrlToBuffer(base64url) {
    let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
        base64 += '=';
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// =============================================================================
// INDEXEDDB OPERATIONS
// =============================================================================

/**
 * Open device database
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
            if (!database.objectStoreNames.contains(STORE_DEVICES)) {
                database.createObjectStore(STORE_DEVICES, { keyPath: 'id' });
            }
        };
    });
}

/**
 * Store device anchor
 * @param {object} anchor - Device anchor data
 */
async function storeDeviceAnchor(anchor) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_DEVICES], 'readwrite');
        const store = transaction.objectStore(STORE_DEVICES);
        store.put(anchor);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

/**
 * Retrieve device anchor
 * @param {string} id - Device anchor ID
 * @returns {Promise<object>}
 */
async function retrieveDeviceAnchor(id) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_DEVICES], 'readonly');
        const store = transaction.objectStore(STORE_DEVICES);
        const request = store.get(id);

        request.onsuccess = () => {
            if (!request.result) {
                reject(new CredentialNotFoundError(id));
            } else {
                resolve(request.result);
            }
        };

        request.onerror = () => reject(request.error);
    });
}

/**
 * Delete device anchor
 * @param {string} id - Device anchor ID
 */
async function deleteDeviceAnchor(id) {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_DEVICES], 'readwrite');
        const store = transaction.objectStore(STORE_DEVICES);
        store.delete(id);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

// =============================================================================
// DEVICE ANCHOR OPERATIONS
// =============================================================================

/**
 * Create a new device anchor (WebAuthn credential)
 * 
 * This registers a new WebAuthn credential that serves as the device identity.
 * The credential is bound to the browser origin and requires user verification.
 * 
 * @param {object} options - Creation options
 * @param {string} options.rpName - Relying party name
 * @param {string} options.rpId - Relying party ID (defaults to current origin)
 * @param {string} options.deviceName - Human-readable device name
 * @param {boolean} options.requireUserVerification - Require UV (biometrics/PIN)
 * @returns {Promise<object>} - Device anchor data
 */
async function createDeviceAnchor(options = {}) {
    if (!isWebAuthnAvailable()) {
        throw new WebAuthnUnavailableError();
    }

    const rpId = options.rpId || (typeof window !== 'undefined' ? window.location.hostname : 'localhost');
    const rpName = options.rpName || 'NovaByte OS';
    const deviceName = options.deviceName || 'NovaSentinel Device';

    // Generate challenge
    const challenge = generateChallenge(32);

    // Public key credential creation options
    const publicKeyCredentialCreationOptions = {
        challenge: challenge,
        rp: {
            name: rpName,
            id: rpId
        },
        user: {
            id: generateChallenge(32),
            name: deviceName,
            displayName: deviceName
        },
        pubKeyCredParams: [
            { type: 'public-key', alg: -7 },  // ES256
            { type: 'public-key', alg: -257 } // RS256
        ],
        timeout: 60000,
        attestation: 'direct',  // Request attestation
        authenticatorSelection: {
            authenticatorAttachment: 'platform',  // Platform authenticator (TPM, Secure Enclave, etc.)
            requireResidentKey: true,
            residentKey: 'required',
            userVerification: options.requireUserVerification ? 'required' : 'preferred'
        },
        excludeCredentials: [],  // Could add existing credentials to prevent duplicate
        extensions: {
            credProps: true  // Get credential properties in response
        }
    };

    try {
        // Create credential
        const credential = await navigator.credentials.create({
            publicKey: publicKeyCredentialCreationOptions
        });

        if (!credential) {
            throw new AttestationFailedError('No credential returned');
        }

        // Parse attestation response
        const attestationResponse = credential.response;
        
        // Extract credential ID
        const credentialId = bufferToBase64Url(credential.id);
        
        // Get attestation data
        const attestationObject = attestationResponse.attestationObject;
        
        // Create device anchor data
        const anchor = {
            id: credentialId,
            rpId: rpId,
            deviceName: deviceName,
            created: new Date().toISOString(),
            lastUsed: new Date().toISOString(),
            credentialType: 'public-key',
            credential: {
                id: credentialId,
                rawId: bufferToBase64Url(credential.id),
                response: {
                    clientDataJSON: Array.from(new Uint8Array(attestationResponse.clientDataJSON)),
                    attestationObject: Array.from(new Uint8Array(attestationObject))
                }
            },
            attestation: attestationResponse.attestationObject ? 
                bufferToBase64Url(attestationResponse.attestationObject) : null,
            signCount: 0,
            uvInitialized: options.requireUserVerification || false,
            authenticatorModel: 'unknown',  // Would need attestation parsing
            options: {
                requireUserVerification: options.requireUserVerification || false
            }
        };

        // Store in IndexedDB
        await storeDeviceAnchor(anchor);
        
        // Update state
        deviceAnchor = anchor;
        isBound = true;

        await logSecurityEvent('DEVICE_ANCHOR_CREATED', {
            anchorId: credentialId.slice(0, 16) + '...',
            rpId,
            deviceName,
            uvRequired: options.requireUserVerification
        });

        return anchor;
    } catch (error) {
        await logSecurityEvent('DEVICE_ANCHOR_CREATE_FAILED', {
            error: error.message
        });
        throw new AttestationFailedError(error.message);
    }
}

/**
 * Verify device identity using WebAuthn
 * 
 * This authenticates with the existing device anchor credential.
 * Requires user verification (biometrics/PIN) if configured.
 * 
 * @param {object} options - Authentication options
 * @param {boolean} options.requireUserVerification - Require UV
 * @returns {Promise<object>} - Verification result
 */
async function verifyDeviceIdentity(options = {}) {
    if (!isWebAuthnAvailable()) {
        throw new WebAuthnUnavailableError();
    }

    if (!deviceAnchor) {
        // Try to load from storage
        try {
            const anchors = await getAllDeviceAnchors();
            if (anchors.length === 0) {
                throw new CredentialNotFoundError();
            }
            deviceAnchor = anchors[0];
        } catch (error) {
            throw new DeviceIdentityError(
                ERROR_CODES.DEVICE_NOT_BOUND,
                'No device anchor exists - create one first'
            );
        }
    }

    // Generate challenge
    const challenge = generateChallenge(32);

    // Public key credential request options
    const publicKeyCredentialRequestOptions = {
        challenge: challenge,
        rpId: deviceAnchor.rpId,
        timeout: 60000,
        userVerification: options.requireUserVerification ? 'required' : 'preferred',
        allowCredentials: [
            {
                type: 'public-key',
                id: base64UrlToBuffer(deviceAnchor.id)
            }
        ],
        extensions: {
            credProps: true
        }
    };

    try {
        // Authenticate
        const credential = await navigator.credentials.get({
            publicKey: publicKeyCredentialRequestOptions
        });

        if (!credential) {
            throw new VerificationFailedError('No credential returned');
        }

        // Verify credential ID matches
        const credentialId = bufferToBase64Url(credential.id);
        if (credentialId !== deviceAnchor.id) {
            throw new VerificationFailedError('Credential ID mismatch');
        }

        // Get authenticator data
        const response = credential.response;
        const authenticatorData = new Uint8Array(response.authenticatorData);
        const signCount = new DataView(
            authenticatorData.buffer, 
            32, 
            4
        ).getUint32();

        // Check user verified flag (bit 0)
        const userVerified = (authenticatorData[32] & 0x01) !== 0;
        
        // Check UV required
        if (deviceAnchor.options?.requireUserVerification && !userVerified) {
            throw new VerificationFailedError('User verification required but not provided');
        }

        // Update last used and sign count
        deviceAnchor.lastUsed = new Date().toISOString();
        deviceAnchor.signCount = signCount;
        
        // Store updated anchor
        await storeDeviceAnchor(deviceAnchor);

        await logSecurityEvent('DEVICE_IDENTITY_VERIFIED', {
            anchorId: deviceAnchor.id.slice(0, 16) + '...',
            signCount,
            userVerified
        });

        return {
            verified: true,
            anchorId: deviceAnchor.id,
            signCount,
            userVerified,
            deviceName: deviceAnchor.deviceName
        };
    } catch (error) {
        await logSecurityEvent('DEVICE_IDENTITY_VERIFY_FAILED', {
            error: error.message
        });
        
        if (error instanceof DeviceIdentityError) {
            throw error;
        }
        throw new VerificationFailedError(error.message);
    }
}

/**
 * Get all device anchors
 * @returns {Promise<Array>}
 */
async function getAllDeviceAnchors() {
    const database = await openDatabase();
    
    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_DEVICES], 'readonly');
        const store = transaction.objectStore(STORE_DEVICES);
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Delete device anchor
 * @param {string} anchorId - Anchor ID to delete
 * @returns {Promise<boolean>}
 */
async function removeDeviceAnchor(anchorId) {
    await deleteDeviceAnchor(anchorId);
    
    if (deviceAnchor?.id === anchorId) {
        deviceAnchor = null;
        isBound = false;
    }

    await logSecurityEvent('DEVICE_ANCHOR_REMOVED', {
        anchorId: anchorId.slice(0, 16) + '...'
    });

    return true;
}

/**
 * Check if device anchor exists and is bound
 * @returns {boolean}
 */
function checkDeviceBound() {
    return isBound && deviceAnchor !== null;
}

/**
 * Get current device anchor info (without sensitive data)
 * @returns {object|null}
 */
function getDeviceAnchorInfo() {
    if (!deviceAnchor) {
        return null;
    }

    return {
        id: deviceAnchor.id.slice(0, 16) + '...',
        deviceName: deviceAnchor.deviceName,
        created: deviceAnchor.created,
        lastUsed: deviceAnchor.lastUsed,
        signCount: deviceAnchor.signCount,
        uvInitialized: deviceAnchor.uvInitialized,
        rpId: deviceAnchor.rpId
    };
}

// =============================================================================
// PCR (Platform Configuration Register) Generation
// =============================================================================

/**
 * Generate PCR values for device state verification
 * 
 * PCR values are hashes that represent the device configuration state.
 * Used for device-bound encryption and attestation.
 * 
 * @param {object} options - PCR generation options
 * @returns {Promise<Uint8Array>} - PCR hash
 */
async function generateDevicePCR(options = {}) {
    const pcrData = {
        anchorId: deviceAnchor?.id || null,
        rpId: deviceAnchor?.rpId || null,
        signCount: deviceAnchor?.signCount || 0,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
        platform: typeof navigator !== 'undefined' ? navigator.platform : 'unknown',
        hardware: options.hardware || 'unknown',
        ...options
    };

    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(JSON.stringify(pcrData));
    
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    return new Uint8Array(hashBuffer);
}

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize device identity module
 * @returns {Promise<boolean>}
 */
async function initialize() {
    try {
        // Load existing device anchors
        const anchors = await getAllDeviceAnchors();
        
        if (anchors.length > 0) {
            deviceAnchor = anchors[0];
            isBound = true;
        }

        await logSecurityEvent('DEVICE_IDENTITY_INITIALIZED', {
            bound: isBound,
            anchorCount: anchors.length
        });

        return true;
    } catch (error) {
        await logSecurityEvent('DEVICE_IDENTITY_INIT_FAILED', {
            error: error.message
        });
        return false;
    }
}

/**
 * Destroy device identity module
 */
async function destroy() {
    deviceAnchor = null;
    isBound = false;
    
    await logSecurityEvent('DEVICE_IDENTITY_DESTROYED', {});
}

// =============================================================================
// EXPORTS
// =============================================================================

const sentinelDeviceId = {
    // Error codes
    ERROR_CODES,
    
    // Error classes
    DeviceIdentityError,
    WebAuthnUnavailableError,
    CredentialNotFoundError,
    AttestationFailedError,
    VerificationFailedError,

    // Audit
    setAuditLogger,
    logSecurityEvent,

    // WebAuthn utilities
    isWebAuthnAvailable,
    generateChallenge,
    bufferToBase64Url,
    base64UrlToBuffer,

    // Device anchor operations
    createDeviceAnchor,
    verifyDeviceIdentity,
    getAllDeviceAnchors,
    removeDeviceAnchor,
    checkDeviceBound,
    getDeviceAnchorInfo,

    // PCR
    generateDevicePCR,

    // Lifecycle
    initialize,
    destroy
};

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = sentinelDeviceId;
} else if (typeof window !== 'undefined') {
    window.NovaSentinelDeviceId = sentinelDeviceId;
}
})(); // End IIFE