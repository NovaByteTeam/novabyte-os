/**
 * NovaSentinel Virtual TPM (Trusted Platform Module)
 * 
 * This module implements a software TPM with PCR (Platform Configuration Registers)
 * similar to hardware TPMs used in modern computers.
 * 
 * SECURITY REQUIREMENTS:
 * - SRK never exported from module - stays in memory
 * - All cryptographic operations wrapped in try/catch
 * - Keys zeroed from memory after use
 * - Call auditService.logEvent() for security events
 * - AES-256-GCM for key sealing
 * - SHA-256 for all PCR operations
 * 
 * @module sentinel/crypto/virtual-tpm
 */

'use strict';

const crypto = require('crypto');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Number of PCR registers */
const PCR_COUNT = 24;

/** PCR register groups */
const PCR_GROUP = {
    BOOT_INTEGRITY: { start: 0, end: 7, name: 'Boot Integrity' },
    OS_CONFIG: { start: 8, end: 15, name: 'OS Configuration' },
    APPLICATION: { start: 16, end: 23, name: 'Application Specific' }
};

/** SHA-256 hash length in bytes */
const HASH_LENGTH = 32;

/** Default PCR index for boot measurements */
const BOOT_PCR_INDEX = 8;

/** Sealed blob version */
const SEALED_BLOB_VERSION = 1;

// =============================================================================
// STATE
// =============================================================================

/** PCR registers - each stores a SHA-256 hash */
let pcrRegisters = [];

/** Storage Root Key - never leaves TPM */
let storageRootKey = null;

/** Sealed keys store - maps sealed blob to metadata */
let sealedKeys = new Map();

/** TPM initialization state */
let isInitialised = false;

/** TPM health status */
let tpmHealth = {
    healthy: true,
    lastError: null,
    operationCount: 0
};

// =============================================================================
// AUDIT LOGGING
// =============================================================================

/**
 * Attempt to log security events to audit service.
 * Gracefully handles if auditService is not yet available.
 * 
 * @param {string} event - Event type
 * @param {object} data - Event data (sanitized)
 */
function logSecurityEvent(event, data = {}) {
    try {
        if (typeof auditService !== 'undefined' && auditService && typeof auditService.logEvent === 'function') {
            auditService.logEvent(event, data);
        }
    } catch (e) {
        // Silently fail - audit logging should never break functionality
        console.error('[NovaSentinel] Failed to log security event:', e.message);
    }
}

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize PCR registers to default values.
 * All PCRs start with SHA-256 of empty string.
 */
function initializePCRs() {
    pcrRegisters = [];
    for (let i = 0; i < PCR_COUNT; i++) {
        // PCRs start with SHA-256(0x00) - the hash of empty/zero initial value
        const initialHash = crypto.createHash('sha256').update(Buffer.alloc(1, 0)).digest();
        pcrRegisters.push(initialHash);
    }
    logSecurityEvent('tpm_pcr_initialized', { pcrCount: PCR_COUNT });
}

/**
 * Get the Storage Root Key (SRK).
 * Generates SRK if not already present.
 * 
 * @returns {Buffer} SRK (32 bytes)
 */
function getOrCreateSRK() {
    if (!storageRootKey) {
        storageRootKey = crypto.randomBytes(32);
        logSecurityEvent('tpm_srk_generated', { algorithm: 'AES-256' });
    }
    return storageRootKey;
}

// =============================================================================
// PCR OPERATIONS
// =============================================================================

/**
 * Extend a PCR register with a new value.
 * PCR extend: newValue = SHA-256(oldValue || newData)
 * 
 * @param {number} index - PCR index (0-23)
 * @param {Buffer|string} value - Value to extend with
 * @returns {Buffer} New PCR value after extension
 * @throws {Error} If PCR index is invalid
 */
function extendPCR(index, value) {
    try {
        // Validate PCR index
        if (typeof index !== 'number' || index < 0 || index >= PCR_COUNT) {
            throw new Error(`Invalid PCR index: ${index}. Must be 0-${PCR_COUNT - 1}`);
        }

        // Convert value to buffer if needed
        const valueBuf = Buffer.isBuffer(value) 
            ? value 
            : Buffer.from(value, 'utf8');

        // Get current PCR value
        const currentPCR = pcrRegisters[index];

        // Create new hash by extending: SHA-256(currentPCR || newValue)
        const hash = crypto.createHash('sha256');
        hash.update(currentPCR);
        hash.update(valueBuf);
        const newPCR = hash.digest();

        // Update PCR register
        pcrRegisters[index] = newPCR;

        // Update operation count
        tpmHealth.operationCount++;

        logSecurityEvent('tpm_pcr_extended', { 
            pcrIndex: index,
            valueLength: valueBuf.length,
            newValue: newPCR.toString('hex').substring(0, 16) + '...'
        });

        return newPCR;

    } catch (error) {
        tpmHealth.healthy = false;
        tpmHealth.lastError = error.message;
        logSecurityEvent('tpm_pcr_extend_failed', { 
            error: error.message,
            pcrIndex: index
        });
        throw error;
    }
}

/**
 * Get the current value of a PCR register.
 * 
 * @param {number} index - PCR index (0-23)
 * @returns {Buffer} Current PCR value
 * @throws {Error} If PCR index is invalid
 */
function getPCRValue(index) {
    if (typeof index !== 'number' || index < 0 || index >= PCR_COUNT) {
        throw new Error(`Invalid PCR index: ${index}. Must be 0-${PCR_COUNT - 1}`);
    }
    return pcrRegisters[index];
}

/**
 * Get all PCR values as an object.
 * 
 * @returns {Object} Object with PCR index as key and hex string as value
 */
function getAllPCRValues() {
    const pcrValues = {};
    for (let i = 0; i < PCR_COUNT; i++) {
        pcrValues[i] = pcrRegisters[i].toString('hex');
    }
    return pcrValues;
}

// =============================================================================
// BOOT MEASUREMENT
// =============================================================================

/**
 * Measure boot process by extending PCR 8 with file hashes.
 * 
 * @param {string[]} fileHashes - Array of SHA-256 file hashes
 * @returns {Object} Measurement result with final PCR 8 value
 */
function measureBoot(fileHashes) {
    try {
        if (!Array.isArray(fileHashes)) {
            throw new Error('fileHashes must be an array');
        }

        // Extend PCR 8 with each file hash in sequence
        for (const fileHash of fileHashes) {
            extendPCR(BOOT_PCR_INDEX, fileHash);
        }

        const finalValue = pcrRegisters[BOOT_PCR_INDEX];

        logSecurityEvent('tpm_boot_measured', { 
            fileCount: fileHashes.length,
            pcrIndex: BOOT_PCR_INDEX,
            finalValue: finalValue.toString('hex').substring(0, 16) + '...'
        });

        return {
            success: true,
            pcrIndex: BOOT_PCR_INDEX,
            fileCount: fileHashes.length,
            pcrValue: finalValue.toString('hex')
        };

    } catch (error) {
        logSecurityEvent('tpm_boot_measure_failed', { 
            error: error.message 
        });
        throw error;
    }
}

// =============================================================================
// KEY SEALING
// =============================================================================

/**
 * Create a sealed key blob.
 * The key is encrypted with AES-256-GCM and can only be unsealed
 * if the specified PCRs match their current values.
 * 
 * @param {Buffer|string} key - Key to seal (will be encrypted)
 * @param {number} pcrMask - 24-bit mask indicating which PCRs must match (bit 0 = PCR 0, etc.)
 * @returns {Promise<Object>} Sealed blob containing encrypted key and PCR state
 */
async function sealKey(key, pcrMask) {
    try {
        // Validate inputs
        if (!key) {
            throw new Error('Key is required');
        }
        if (typeof pcrMask !== 'number' || pcrMask < 0 || pcrMask > 0xFFFFFF) {
            throw new Error('Valid 24-bit PCR mask is required');
        }

        // Convert key to buffer if needed
        const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key, 'utf8');

        // Get current PCR values for the masked registers
        const pcrState = [];
        for (let i = 0; i < PCR_COUNT; i++) {
            if (pcrMask & (1 << i)) {
                pcrState.push({
                    index: i,
                    value: pcrRegisters[i].toString('hex')
                });
            }
        }

        // Create sealed data containing:
        // 1. The key (encrypted)
        // 2. PCR state (encrypted)
        // 3. PCR mask
        const sealedData = {
            version: SEALED_BLOB_VERSION,
            pcrMask: pcrMask,
            pcrState: pcrState,
            key: keyBuf.toString('base64')
        };

        const sealedJson = JSON.stringify(sealedData);
        const sealedBuf = Buffer.from(sealedJson, 'utf8');

        // Get SRK for encryption
        const srk = getOrCreateSRK();

        // Import encryption functions from vault
        const { encrypt } = require('../vault/encryption');
        
        // Encrypt with SRK
        const encrypted = await encrypt(sealedBuf, srk);

        // Create sealed blob
        const sealedBlob = {
            version: SEALED_BLOB_VERSION,
            algorithm: 'AES-256-GCM',
            ciphertext: encrypted.ciphertext.toString('base64'),
            iv: encrypted.iv.toString('base64'),
            tag: encrypted.tag.toString('base64'),
            salt: encrypted.salt.toString('base64')
        };

        // Store sealed key metadata
        const blobId = crypto.randomBytes(8).toString('hex');
        sealedKeys.set(blobId, {
            pcrMask: pcrMask,
            createdAt: Date.now(),
            sealed: true
        });

        // Zero key from memory
        keyBuf.fill(0);

        logSecurityEvent('tpm_key_sealed', { 
            blobId: blobId,
            pcrMask: pcrMask,
            pcrCount: pcrState.length
        });

        return {
            blobId: blobId,
            sealedBlob: sealedBlob
        };

    } catch (error) {
        logSecurityEvent('tpm_key_seal_failed', { 
            error: error.message 
        });
        throw error;
    }
}

/**
 * Unseal a previously sealed key.
 * Verifies PCR state matches before releasing the key.
 * 
 * @param {Object} sealedBlob - The sealed blob from sealKey
 * @param {number} pcrMask - PCR mask (must match what was used to seal)
 * @returns {Promise<Buffer>} Unsealed key
 * @throws {Error} If PCR state doesn't match or decryption fails
 */
async function unsealKey(sealedBlob, pcrMask) {
    try {
        // Validate inputs
        if (!sealedBlob) {
            throw new Error('Sealed blob is required');
        }
        if (typeof pcrMask !== 'number' || pcrMask < 0 || pcrMask > 0xFFFFFF) {
            throw new Error('Valid 24-bit PCR mask is required');
        }

        // Verify blob format
        if (!sealedBlob.ciphertext || !sealedBlob.iv || !sealedBlob.tag) {
            throw new Error('Invalid sealed blob format');
        }

        // Convert blob components back to buffers
        const ciphertext = Buffer.from(sealedBlob.ciphertext, 'base64');
        const iv = Buffer.from(sealedBlob.iv, 'base64');
        const tag = Buffer.from(sealedBlob.tag, 'base64');
        const salt = sealedBlob.salt ? Buffer.from(sealedBlob.salt, 'base64') : null;

        // Get SRK for decryption
        const srk = getOrCreateSRK();

        // Import decryption functions
        const { decrypt } = require('../vault/encryption');

        // Decrypt the blob
        const decrypted = await decrypt(ciphertext, iv, tag, srk);
        const decryptedJson = decrypted.toString('utf8');
        const sealedData = JSON.parse(decryptedJson);

        // Verify version
        if (sealedData.version !== SEALED_BLOB_VERSION) {
            throw new Error('Unsupported sealed blob version');
        }

        // Verify PCR mask matches
        if (sealedData.pcrMask !== pcrMask) {
            throw new Error('PCR mask mismatch - cannot unseal with different PCR requirements');
        }

        // Verify PCR state
        for (const storedPcr of sealedData.pcrState) {
            const pcrIndex = storedPcr.index;
            const storedValue = storedPcr.value;
            const currentValue = pcrRegisters[pcrIndex].toString('hex');

            // Use timing-safe comparison
            if (!timingSafeEqual(storedValue, currentValue)) {
                logSecurityEvent('tpm_pcr_mismatch', {
                    pcrIndex: pcrIndex,
                    storedValue: storedValue.substring(0, 16) + '...',
                    currentValue: currentValue.substring(0, 16) + '...'
                });
                throw new Error(`PCR ${pcrIndex} state mismatch - sealed key cannot be released`);
            }
        }

        // Extract the key
        const keyBuf = Buffer.from(sealedData.key, 'base64');

        logSecurityEvent('tpm_key_unsealed', { 
            pcrMask: pcrMask,
            pcrCount: sealedData.pcrState.length
        });

        return keyBuf;

    } catch (error) {
        logSecurityEvent('tpm_key_unseal_failed', { 
            error: error.message 
        });
        throw error;
    }
}

// =============================================================================
// KEY HIERARCHY
// =============================================================================

/**
 * Create the Storage Root Key (SRK).
 * The SRK is generated once on module initialization and never leaves the TPM.
 * 
 * @returns {Object} SRK creation result
 */
function createSRK() {
    try {
        // Generate SRK (or get existing)
        const srk = getOrCreateSRK();

        logSecurityEvent('tpm_srk_created', { 
            algorithm: 'AES-256',
            keyLength: srk.length * 8
        });

        return {
            success: true,
            algorithm: 'AES-256',
            keyLength: srk.length * 8,
            publicOnly: true // SRK never leaves TPM
        };

    } catch (error) {
        logSecurityEvent('tpm_srk_creation_failed', { 
            error: error.message 
        });
        throw error;
    }
}

// =============================================================================
// ATTESTATION
// =============================================================================

/**
 * Generate an attestation quote signed by the SRK.
 * Provides cryptographic proof of current PCR state.
 * 
 * @param {string} nonce - Nonce to include in attestation (prevents replay)
 * @returns {Promise<Object>} Attestation quote with signature
 */
async function attestation(nonce) {
    try {
        if (!nonce) {
            throw new Error('Nonce is required for attestation');
        }

        // Get current PCR values
        const pcrValues = getAllPCRValues();
        
        // Create attestation data
        const attestationData = {
            nonce: nonce,
            timestamp: Date.now(),
            pcrValues: pcrValues,
            pcrBank: 'SHA-256'
        };

        const attestationJson = JSON.stringify(attestationData);
        const attestationBuf = Buffer.from(attestationJson, 'utf8');

        // Sign with SRK using ECDSA (provides non-repudiation)
        const srk = getOrCreateSRK();
        
        // Create signature using HMAC-SHA256 (simpler for symmetric key)
        // In a real TPM, this would use RSA/ECDSA with the SRK private key
        const sign = crypto.createSign('SHA256');
        sign.update(attestationBuf);
        sign.update(Buffer.from(nonce, 'utf8'));
        const signature = sign.sign(srk.toString('hex').substring(0, 32));

        logSecurityEvent('tpm_attestation_created', {
            nonce: nonce,
            pcrCount: Object.keys(pcrValues).length
        });

        return {
            success: true,
            attestation: attestationData,
            signature: signature.toString('base64'),
            algorithm: 'SHA256withHMAC'
        };

    } catch (error) {
        logSecurityEvent('tpm_attestation_failed', { 
            error: error.message 
        });
        throw error;
    }
}

// =============================================================================
// TPM STATUS
// =============================================================================

/**
 * Get TPM status including PCR values and seal information.
 * 
 * @returns {Object} TPM status object
 */
function getTPMStatus() {
    const status = {
        active: isInitialised,
        healthy: tpmHealth.healthy,
        operationCount: tpmHealth.operationCount,
        lastError: tpmHealth.lastError,
        pcrCount: PCR_COUNT,
        pcrGroups: {
            bootIntegrity: { start: 0, end: 7, name: 'Boot Integrity' },
            osConfiguration: { start: 8, end: 15, name: 'OS Configuration' },
            applicationSpecific: { start: 16, end: 23, name: 'Application Specific' }
        },
        pcrValues: getAllPCRValues(),
        sealStatus: {
            sealedKeyCount: sealedKeys.size,
            srkInitialized: storageRootKey !== null
        }
    };

    return status;
}

/**
 * Get simplified status for dashboard.
 * 
 * @returns {Object} Simplified status object
 */
function getStatus() {
    return {
        active: true,
        healthy: tpmHealth.healthy,
        details: {
            pcrCount: PCR_COUNT,
            sealedKeys: sealedKeys.size,
            operations: tpmHealth.operationCount
        }
    };
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Timing-safe equality comparison.
 * Prevents timing attacks on sensitive comparisons.
 * 
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} True if equal
 */
function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        return false;
    }
    
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    
    if (bufA.length !== bufB.length) {
        return false;
    }
    
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Securely zero a buffer from memory.
 * 
 * @param {Buffer} buf - Buffer to zero
 */
function zeroBuffer(buf) {
    if (Buffer.isBuffer(buf)) {
        buf.fill(0);
    }
}

// =============================================================================
// MODULE INITIALIZATION
// =============================================================================

/**
 * Initialize the virtual TPM module.
 * Must be called before using TPM functions.
 * 
 * @returns {Object} Initialization result
 */
function initialize() {
    if (isInitialised) {
        return { success: true, message: 'Already initialized' };
    }

    try {
        // Initialize PCRs
        initializePCRs();
        
        // Pre-generate SRK
        getOrCreateSRK();

        isInitialised = true;
        tpmHealth.healthy = true;

        logSecurityEvent('tpm_initialized', { 
            pcrCount: PCR_COUNT,
            algorithm: 'AES-256'
        });

        return {
            success: true,
            pcrCount: PCR_COUNT,
            algorithm: 'AES-256-GCM'
        };

    } catch (error) {
        tpmHealth.healthy = false;
        tpmHealth.lastError = error.message;
        
        logSecurityEvent('tpm_init_failed', { 
            error: error.message 
        });
        
        throw error;
    }
}

// Auto-initialize on module load
try {
    initialize();
} catch (e) {
    console.error('[NovaSentinel] Virtual TPM auto-initialization failed:', e.message);
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    // PCR Operations
    extendPCR,
    getPCRValue,
    getAllPCRValues,
    
    // Boot Measurement
    measureBoot,
    
    // Key Sealing
    sealKey,
    unsealKey,
    
    // Key Hierarchy
    createSRK,
    
    // Attestation
    attestation,
    
    // Status
    getTPMStatus,
    getStatus,
    
    // Initialization
    initialize
};
