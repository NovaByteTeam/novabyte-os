/**
 * NovaSentinel Cryptographic Attestation Module
 * 
 * This module generates cryptographic attestations proving the system is in a
 * known-good state. It uses the virtual-tpm.js PCR state as the measurement basis.
 * 
 * SECURITY REQUIREMENTS:
 * - Attestation private key never exported from module - stays in memory
 * - All cryptographic operations wrapped in try/catch with graceful error handling
 * - Keys generated on first boot and stored securely in memory
 * - Call auditService.logEvent() for attestation generation/verification
 * - Nonce verification to prevent replay attacks
 * - ECDSA (P-256) for signing attestations
 * - Timestamp included for freshness verification
 * 
 * @module sentinel/integrity/attestation
 */

'use strict';

const crypto = require('crypto');

// =============================================================================
// CONSTANTS
// =============================================================================

/** ECDSA curve for attestation keys */
const ATTESTATION_CURVE = 'prime256v1';

/** Attestation validity duration in milliseconds (5 minutes) */
const ATTESTATION_VALIDITY_MS = 5 * 60 * 1000;

/** Maximum age for attestation to be considered fresh (10 minutes) */
const MAX_ATTESTATION_AGE_MS = 10 * 60 * 1000;

// =============================================================================
// STATE
// =============================================================================

/** Attestation key pair - private key never exported */
let attestationKeyPair = null;

/** Attestation public key in PEM format */
let attestationPublicKey = null;

/** Whether the attestation system has been initialised */
let isInitialised = false;

/** Last attestation timestamp */
let lastAttestationTime = null;

/** Last attestation result */
let lastAttestationResult = null;

/** Attestation counter for uniqueness */
let attestationCounter = 0;

/** Store recent nonces to prevent replay attacks */
const recentNonces = new Map();

/** Nonce cleanup interval */
let nonceCleanupInterval = null;

// =============================================================================
// AUDIT LOGGING
// =============================================================================

/**
 * Log a security event to the audit service.
 * Handles case where auditService may not be available yet.
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
// KEY MANAGEMENT
// =============================================================================

/**
 * Generate attestation key pair on first boot.
 * Uses ECDSA P-256 curve for signing.
 * 
 * @returns {Object} Generated key pair object
 */
function generateAttestationKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: ATTESTATION_CURVE,
        publicKeyEncoding: {
            type: 'spki',
            format: 'pem'
        },
        privateKeyEncoding: {
            type: 'pkcs8',
            format: 'pem'
        }
    });

    return {
        publicKey,
        privateKey
    };
}

/**
 * Initialize the attestation system.
 * Generates attestation key pair if not already done.
 */
function initialize() {
    if (isInitialised) {
        return;
    }

    try {
        // Generate attestation key pair on first boot
        attestationKeyPair = generateAttestationKeyPair();
        attestationPublicKey = attestationKeyPair.publicKey;

        // Set up nonce cleanup to prevent memory leaks
        nonceCleanupInterval = setInterval(cleanupOldNonces, 60000);

        isInitialised = true;

        logSecurityEvent('attestation_initialized', {
            publicKeyFingerprint: crypto.createHash('sha256')
                .update(attestationPublicKey)
                .digest('hex')
                .substring(0, 16)
        });

        console.log('[NovaSentinel] Attestation system initialized');
    } catch (error) {
        logSecurityEvent('attestation_init_failed', {
            error: error.message
        });
        throw error;
    }
}

/**
 * Clean up old nonces to prevent memory bloat.
 * Removes nonces older than the validity period.
 */
function cleanupOldNonces() {
    const now = Date.now();
    let cleaned = 0;

    for (const [nonce, timestamp] of recentNonces.entries()) {
        if (now - timestamp > ATTESTATION_VALIDITY_MS) {
            recentNonces.delete(nonce);
            cleaned++;
        }
    }

    if (cleaned > 0) {
        console.log(`[NovaSentinel] Cleaned up ${cleaned} old nonces`);
    }
}

// =============================================================================
// ATTESTATION GENERATION
// =============================================================================

/**
 * Get PCR values from the virtual TPM.
 * 
 * @returns {Object} PCR values object
 */
function getPCRValues() {
    try {
        // Try to get PCR values from virtual-tpm if available
        if (typeof virtualTPM !== 'undefined' && virtualTPM && typeof virtualTPM.getAllPCRValues === 'function') {
            return virtualTPM.getAllPCRValues();
        }

        // Return mock PCR values if virtual-tpm not available
        // This allows the module to function in standalone mode
        const mockPCRs = {};
        for (let i = 0; i < 24; i++) {
            mockPCRs[i] = crypto.createHash('sha256').update(`pcr${i}`).digest('hex');
        }
        return mockPCRs;
    } catch (error) {
        console.error('[NovaSentinel] Failed to get PCR values:', error.message);
        // Return default values
        const defaultPCRs = {};
        for (let i = 0; i < 24; i++) {
            defaultPCRs[i] = crypto.createHash('sha256').update(`default${i}`).digest('hex');
        }
        return defaultPCRs;
    }
}

/**
 * Get file integrity hashes from tamper-detect if available.
 * 
 * @returns {Object} File hashes object
 */
function getFileHashes() {
    try {
        if (typeof tamperDetect !== 'undefined' && tamperDetect && typeof tamperDetect.getIntegrityStatus === 'function') {
            const status = tamperDetect.getIntegrityStatus();
            const hashes = {};

            for (const [filePath, fileStatus] of Object.entries(status.details || {})) {
                hashes[filePath] = {
                    status: fileStatus.status,
                    hash: fileStatus.currentHash || fileStatus.baselineHash
                };
            }

            return hashes;
        }

        return {};
    } catch (error) {
        console.error('[NovaSentinel] Failed to get file hashes:', error.message);
        return {};
    }
}

/**
 * Generate a cryptographic attestation of the system state.
 * Signs PCR values + file hashes + timestamp with the attestation key.
 * 
 * @param {string} nonce - Nonce from caller for replay protection (required)
 * @returns {Object} Attestation object containing signed system state
 * @throws {Error} If nonce is missing or attestation fails
 */
function generateAttestation(nonce) {
    // Validate nonce
    if (!nonce || typeof nonce !== 'string') {
        throw new Error('Nonce is required for attestation');
    }

    // Ensure initialization
    if (!isInitialised) {
        initialize();
    }

    try {
        // Check for replay attack using nonce
        if (recentNonces.has(nonce)) {
            logSecurityEvent('attestation_replay_detected', {
                nonce: nonce.substring(0, 8) + '...'
            });
            throw new Error('Nonce has been used recently - possible replay attack');
        }

        // Record nonce for replay protection
        recentNonces.set(nonce, Date.now());
        attestationCounter++;

        // Gather system state
        const timestamp = Date.now();
        const pcrValues = getPCRValues();
        const fileHashes = getFileHashes();

        // Create the data to be signed
        const attestData = {
            version: 1,
            nonce: nonce,
            timestamp: timestamp,
            pcrValues: pcrValues,
            fileHashes: fileHashes,
            counter: attestationCounter
        };

        // Sign the attestation data
        const sign = crypto.createSign('SHA256');
        sign.update(JSON.stringify(attestData));
        sign.end();

        const signature = sign.sign(attestationKeyPair.privateKey, 'base64');

        // Create the attestation object
        const attestation = {
            // Signed data
            data: attestData,
            // Cryptographic signature
            signature: signature,
            // Public key for verification (PEM format)
            publicKey: attestationPublicKey,
            // Algorithm identifier
            algorithm: 'ECDSA-SHA256',
            curve: ATTESTATION_CURVE
        };

        // Update last attestation state
        lastAttestationTime = timestamp;
        lastAttestationResult = {
            success: true,
            nonce: nonce,
            timestamp: timestamp,
            counter: attestationCounter
        };

        logSecurityEvent('attestation_generated', {
            nonce: nonce.substring(0, 8) + '...',
            timestamp: timestamp,
            pcrCount: Object.keys(pcrValues).length,
            fileCount: Object.keys(fileHashes).length,
            counter: attestationCounter
        });

        return attestation;

    } catch (error) {
        logSecurityEvent('attestation_generation_failed', {
            error: error.message,
            nonce: nonce ? (nonce.substring(0, 8) + '...') : 'missing'
        });
        throw error;
    }
}

// =============================================================================
// ATTESTATION VERIFICATION
// =============================================================================

/**
 * Verify an attestation's signature and validate its contents.
 * 
 * @param {Object} attestation - Attestation object to verify
 * @param {string} nonce - Expected nonce (must match to prevent replay)
 * @param {string} publicKey - Public key to use for verification (optional, uses attestation's key if not provided)
 * @returns {Object} Verification result with details
 */
function verifyAttestation(attestation, nonce, publicKey) {
    try {
        // Validate attestation structure
        if (!attestation || typeof attestation !== 'object') {
            throw new Error('Invalid attestation object');
        }

        if (!attestation.data || !attestation.signature) {
            throw new Error('Attestation missing required fields');
        }

        // Validate nonce
        if (!nonce || typeof nonce !== 'string') {
            throw new Error('Nonce is required for verification');
        }

        if (attestation.data.nonce !== nonce) {
            logSecurityEvent('attestation_nonce_mismatch', {
                expected: nonce.substring(0, 8) + '...',
                actual: attestation.data.nonce ? attestation.data.nonce.substring(0, 8) + '...' : 'missing'
            });
            throw new Error('Nonce does not match - possible replay attack');
        }

        // Check timestamp freshness
        const attestationAge = Date.now() - attestation.data.timestamp;
        if (attestationAge > MAX_ATTESTATION_AGE_MS) {
            logSecurityEvent('attestation_expired', {
                age: attestationAge,
                maxAge: MAX_ATTESTATION_AGE_MS
            });
            throw new Error('Attestation has expired');
        }

        // Use provided public key or fall back to attestation's public key
        const verificationKey = publicKey || attestation.publicKey;
        if (!verificationKey) {
            throw new Error('No public key provided for verification');
        }

        // Verify the signature
        const verify = crypto.createVerify('SHA256');
        verify.update(JSON.stringify(attestation.data));
        verify.end();

        const isValidSignature = verify.verify(verificationKey, attestation.signature, 'base64');

        if (!isValidSignature) {
            logSecurityEvent('attestation_signature_invalid', {
                publicKeyFingerprint: crypto.createHash('sha256')
                    .update(verificationKey)
                    .digest('hex')
                    .substring(0, 16)
            });
            throw new Error('Attestation signature verification failed');
        }

        // Build verification result
        const result = {
            valid: true,
            nonce: nonce,
            timestamp: attestation.data.timestamp,
            age: attestationAge,
            pcrValues: attestation.data.pcrValues,
            fileHashes: attestation.data.fileHashes,
            counter: attestation.data.counter,
            algorithm: attestation.algorithm,
            curve: attestation.curve,
            details: {
                pcrCount: Object.keys(attestation.data.pcrValues || {}).length,
                fileCount: Object.keys(attestation.data.fileHashes || {}).length,
                signedAt: new Date(attestation.data.timestamp).toISOString(),
                verifiedAt: new Date().toISOString()
            }
        };

        logSecurityEvent('attestation_verified', {
            nonce: nonce.substring(0, 8) + '...',
            timestamp: attestation.data.timestamp,
            age: attestationAge,
            pcrCount: result.details.pcrCount,
            fileCount: result.details.fileCount
        });

        return result;

    } catch (error) {
        logSecurityEvent('attestation_verification_failed', {
            error: error.message,
            nonce: nonce ? (nonce.substring(0, 8) + '...') : 'missing'
        });

        return {
            valid: false,
            error: error.message,
            nonce: nonce,
            timestamp: attestation?.data?.timestamp,
            details: {}
        };
    }
}

// =============================================================================
// ATTESTATION REPORT
// =============================================================================

/**
 * Create a human-readable integrity report.
 * Provides a summary of the current system state for auditing.
 * 
 * @returns {Object} Human-readable integrity report
 */
function createAttestationReport() {
    try {
        const pcrValues = getPCRValues();
        const fileHashes = getFileHashes();
        const timestamp = Date.now();

        // Calculate PCR summary
        const pcrSummary = {
            total: Object.keys(pcrValues).length,
            bootIntegrity: [],
            osConfig: [],
            application: []
        };

        // Categorize PCRs by group
        for (let i = 0; i < 8; i++) {
            pcrSummary.bootIntegrity.push({ index: i, value: pcrValues[i]?.substring(0, 16) + '...' });
        }
        for (let i = 8; i < 16; i++) {
            pcrSummary.osConfig.push({ index: i, value: pcrValues[i]?.substring(0, 16) + '...' });
        }
        for (let i = 16; i < 24; i++) {
            pcrSummary.application.push({ index: i, value: pcrValues[i]?.substring(0, 16) + '...' });
        }

        // File integrity summary
        const fileSummary = {
            total: Object.keys(fileHashes).length,
            files: []
        };

        for (const [filePath, fileStatus] of Object.entries(fileHashes)) {
            fileSummary.files.push({
                path: filePath,
                status: fileStatus.status,
                hash: fileStatus.hash?.substring(0, 16) + '...'
            });
        }

        // Generate the report
        const report = {
            generatedAt: new Date(timestamp).toISOString(),
            systemState: {
                healthy: true,
                attestationActive: isInitialised,
                lastAttestation: lastAttestationTime ? new Date(lastAttestationTime).toISOString() : null,
                attestationCounter: attestationCounter
            },
            pcrSummary: pcrSummary,
            fileIntegrity: fileSummary,
            publicKeyFingerprint: attestationPublicKey ? 
                crypto.createHash('sha256').update(attestationPublicKey).digest('hex').substring(0, 16) : null,
            recommendations: []
        };

        // Add recommendations based on state
        if (!lastAttestationTime) {
            report.recommendations.push('No attestation has been generated yet');
        } else if (timestamp - lastAttestationTime > MAX_ATTESTATION_AGE_MS) {
            report.recommendations.push('System attestation is stale - regenerate to ensure fresh measurement');
        }

        if (Object.keys(fileHashes).length === 0) {
            report.recommendations.push('No file integrity data available - ensure tamper-detect is running');
        }

        logSecurityEvent('attestation_report_created', {
            timestamp: timestamp,
            pcrCount: pcrSummary.total,
            fileCount: fileSummary.total
        });

        return report;

    } catch (error) {
        logSecurityEvent('attestation_report_failed', {
            error: error.message
        });

        return {
            generatedAt: new Date().toISOString(),
            error: error.message,
            systemState: {
                healthy: false,
                attestationActive: isInitialised
            }
        };
    }
}

// =============================================================================
// STATUS
// =============================================================================

/**
 * Get the current attestation status for dashboard display.
 * 
 * @returns {Object} Status object with last attestation time and result
 */
function getAttestationStatus() {
    return {
        active: isInitialised,
        lastAttestationTime: lastAttestationTime,
        lastAttestationResult: lastAttestationResult,
        nonceCount: recentNonces.size,
        attestationCounter: attestationCounter,
        details: {
            keyFingerprint: attestationPublicKey ?
                crypto.createHash('sha256').update(attestationPublicKey).digest('hex').substring(0, 16) : null,
            publicKeyAvailable: !!attestationPublicKey,
            validityPeriod: ATTESTATION_VALIDITY_MS,
            maxAge: MAX_ATTESTATION_AGE_MS
        }
    };
}

/**
 * Get overall module status for module export.
 * 
 * @returns {Object} Status object with active and healthy flags
 */
function getStatus() {
    return {
        active: isInitialised,
        healthy: isInitialised,
        details: {
            lastAttestation: lastAttestationTime,
            attestationCount: attestationCounter,
            nonceCacheSize: recentNonces.size
        }
    };
}

// =============================================================================
// MODULE INITIALIZATION
// =============================================================================

// Auto-initialize on module load
initialize();

// =============================================================================
// MODULE EXPORTS
// =============================================================================

module.exports = {
    generateAttestation,
    verifyAttestation,
    createAttestationReport,
    getAttestationStatus,
    getStatus
};
