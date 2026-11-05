/**
 * NovaSentinel FIDO2/WebAuthn Passwordless Authentication
 * 
 * This module implements FIDO2/WebAuthn passwordless authentication using
 * @simplewebauthn/server. It provides cryptographic authentication using
 * hardware security keys or platform authenticators.
 * 
 * SECURITY REQUIREMENTS:
 * - All challenges must be cryptographically random (crypto.randomBytes)
 * - Verify attestation if provided
 * - Call auditService.logEvent() for all FIDO2 events
 * - Never store raw credential data - only verified credentials
 * - Validate all inputs before processing
 * 
 * @module sentinel/auth/fido2
 */

'use strict';

const crypto = require('crypto');
const express = require('express');

// Import SimpleWebAuthn for WebAuthn operations - will be loaded dynamically
let _generateRegistrationOptions;
let _verifyRegistrationResponse;
let _generateAuthenticationOptions;
let _verifyAuthenticationResponse;

// Try to load @simplewebauthn/server, provide helpful error if not available
try {
    const simplewebauthn = require('@simplewebauthn/server');
    
    _generateRegistrationOptions = simplewebauthn.generateRegistrationOptions;
    _verifyRegistrationResponse = simplewebauthn.verifyRegistrationResponse;
    _generateAuthenticationOptions = simplewebauthn.generateAuthenticationOptions;
    _verifyAuthenticationResponse = simplewebauthn.verifyAuthenticationResponse;
} catch (err) {
    console.error('[FIDO2] @simplewebauthn/server not installed. Run: npm install @simplewebauthn/server');
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default RP ID if not configured */
const DEFAULT_RP_ID = 'localhost';

/** RP Name for NovaByte OS */
const RP_NAME = 'NovaByte OS';

/** Challenge timeout in milliseconds (5 minutes) */
const CHALLENGE_TIMEOUT = 5 * 60 * 1000;

/** Supported credential algorithms */
const CREDENTIAL_ALGORITHMS = [
    { alg: -7, name: 'RS256' },  // ES256
    { alg: -257, name: 'RS384' } // RS384
];

// =============================================================================
// STATE
// =============================================================================

/** In-memory credential store (Map<userId, credentials[]>) */
const credentialStore = new Map();

/** Pending challenges store (Map<userId, challengeData>) */
const challengeStore = new Map();

/** RP ID from environment */
const RP_ID = process.env.FIDO2_RP_ID || DEFAULT_RP_ID;

// =============================================================================
// INPUT VALIDATION
// =============================================================================

/**
 * Validate userId input.
 * @param {string} userId - User identifier
 * @throws {Error} If validation fails
 */
function validateUserId(userId) {
    if (!userId || typeof userId !== 'string') {
        throw new Error('Invalid userId: must be a non-empty string');
    }
    if (userId.length > 256) {
        throw new Error('Invalid userId: exceeds maximum length');
    }
}

/**
 * Validate username input.
 * @param {string} username - Username
 * @throws {Error} If validation fails
 */
function validateUsername(username) {
    if (!username || typeof username !== 'string') {
        throw new Error('Invalid username: must be a non-empty string');
    }
    if (username.length > 64) {
        throw new Error('Invalid username: exceeds maximum length');
    }
}

/**
 * Validate registration response.
 * @param {object} response - Registration response
 * @throws {Error} If validation fails
 */
function validateRegistrationResponse(response) {
    if (!response || typeof response !== 'object') {
        throw new Error('Invalid response: must be an object');
    }
    if (!response.id || !response.rawId || !response.response) {
        throw new Error('Invalid response: missing required fields');
    }
}

/**
 * Validate authentication response.
 * @param {object} response - Authentication response
 * @throws {Error} If validation fails
 */
function validateAuthenticationResponse(response) {
    if (!response || typeof response !== 'object') {
        throw new Error('Invalid response: must be an object');
    }
    if (!response.id && !response.rawId) {
        throw new Error('Invalid response: missing credential ID');
    }
}

// =============================================================================
// AUDIT LOGGING
// =============================================================================

/**
 * Log a FIDO2 security event to the audit service.
 * Handles case where auditService may not be available yet.
 * 
 * @param {string} event - Event type
 * @param {object} data - Event data (sanitized)
 */
function logFido2Event(event, data = {}) {
    try {
        // Sanitize data to avoid leaking sensitive information
        const sanitized = {
            ...data,
            credentialId: data.credentialId ? '[REDACTED]' : undefined,
            clientDataJSON: data.clientDataJSON ? '[REDACTED]' : undefined,
            attestionObject: data.attestionObject ? '[REDACTED]' : undefined,
            userId: data.userId ? data.userId.substring(0, 8) + '...' : undefined
        };
        
        if (typeof auditService !== 'undefined' && auditService && typeof auditService.logEvent === 'function') {
            auditService.logEvent(event, sanitized);
        }
    } catch (e) {
        // Silently fail - audit logging should never break functionality
    }
}

// =============================================================================
// CHALLENGE MANAGEMENT
// =============================================================================

/**
 * Generate a cryptographically secure challenge.
 * @returns {Buffer} Random challenge bytes
 */
function generateChallenge() {
    return crypto.randomBytes(32);
}

/**
 * Store a challenge for later verification.
 * @param {string} userId - User identifier
 * @param {object} challengeData - Challenge data to store
 * @param {number} timeoutMs - Challenge timeout in milliseconds
 */
function storeChallenge(userId, challengeData, timeoutMs = CHALLENGE_TIMEOUT) {
    challengeStore.set(userId, {
        ...challengeData,
        storedAt: Date.now(),
        expiresAt: Date.now() + timeoutMs
    });
    
    // Set up automatic cleanup
    setTimeout(() => {
        const stored = challengeStore.get(userId);
        if (stored && stored.challenge === challengeData.challenge) {
            challengeStore.delete(userId);
        }
    }, timeoutMs);
}

/**
 * Retrieve and validate a stored challenge.
 * @param {string} userId - User identifier
 * @param {Buffer} challenge - Challenge to verify
 * @returns {object|null} Stored challenge data or null if invalid
 */
function getAndValidateChallenge(userId, challenge) {
    const stored = challengeStore.get(userId);
    
    if (!stored) {
        return null;
    }
    
    if (Date.now() > stored.expiresAt) {
        challengeStore.delete(userId);
        return null;
    }
    
    // Verify challenge matches
    if (!crypto.timingSafeEqual(Buffer.from(stored.challenge), challenge)) {
        return null;
    }
    
    return stored;
}

/**
 * Clear a stored challenge.
 * @param {string} userId - User identifier
 */
function clearChallenge(userId) {
    challengeStore.delete(userId);
}

// =============================================================================
// CREDENTIAL MANAGEMENT
// =============================================================================

/**
 * Get credentials for a user.
 * @param {string} userId - User identifier
 * @returns {array} Array of stored credentials
 */
function getCredentials(userId) {
    return credentialStore.get(userId) || [];
}

/**
 * Store a verified credential for a user.
 * @param {string} userId - User identifier
 * @param {object} credential - Verified credential data
 */
function storeCredential(userId, credential) {
    const credentials = getCredentials(userId);
    
    // Check if credential already exists (by credential ID)
    const existingIndex = credentials.findIndex(c => c.credentialID === credential.credentialID);
    
    if (existingIndex >= 0) {
        // Update existing credential
        credentials[existingIndex] = {
            ...credential,
            updatedAt: Date.now()
        };
    } else {
        // Add new credential
        credentials.push({
            ...credential,
            createdAt: Date.now(),
            updatedAt: Date.now()
        });
    }
    
    credentialStore.set(userId, credentials);
}

/**
 * Remove a credential for a user.
 * @param {string} userId - User identifier
 * @param {string} credentialId - Credential ID to remove
 * @returns {boolean} True if credential was removed
 */
function removeCredential(userId, credentialId) {
    const credentials = getCredentials(userId);
    const filtered = credentials.filter(c => c.credentialID !== credentialId);
    
    if (filtered.length !== credentials.length) {
        credentialStore.set(userId, filtered);
        return true;
    }
    
    return false;
}

/**
 * Get a specific credential by ID.
 * @param {string} userId - User identifier
 * @param {string} credentialId - Credential ID
 * @returns {object|null} Credential or null if not found
 */
function getCredentialById(userId, credentialId) {
    const credentials = getCredentials(userId);
    return credentials.find(c => c.credentialID === credentialId) || null;
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Generate registration options for a new credential.
 * Creates a challenge for the user to register a new FIDO2 authenticator.
 * 
 * @param {string} userId - Unique user identifier
 * @param {string} username - User's display name
 * @returns {Promise<object>} Registration options with challenge
 */
async function generateRegistrationOptions(userId, username) {
    validateUserId(userId);
    validateUsername(username);
    
    // Generate cryptographically random challenge
    const challenge = generateChallenge();
    
    // Get existing credentials to avoid duplicates
    const existingCredentials = getCredentials(userId);
    
    // Configure attestation conveyance
    const attestationConveyance = process.env.FIDO2_ATTESTATION === 'none' ? 'none' : 'direct';
    
    // Generate registration options
    const options = _generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: RP_ID,
        userID: userId,
        userName: username,
        challenge: challenge,
        timeout: CHALLENGE_TIMEOUT,
        attestationType: attestationConveyance,
        // Support for discoverable credentials (resident keys)
        authenticatorSelection: {
            residentKey: 'preferred',
            requireResidentKey: false,
            userVerification: 'preferred',
            authenticatorAttachment: 'platform'
        },
        supportedAlgorithms: CREDENTIAL_ALGORITHMS,
        // Exclude credentials if this is not the first registration
        excludeCredentials: existingCredentials.map(cred => ({
            id: cred.credentialID,
            type: 'public-key',
            transports: cred.transports || ['usb', 'nfc', 'ble', 'internal']
        }))
    });
    
    // Store challenge for later verification
    storeChallenge(userId, {
        challenge: options.challenge,
        type: 'registration',
        username: username
    });
    
    // Audit logging
    logFido2Event('FIDO2_REGISTRATION_OPTIONS_GENERATED', {
        userId: userId,
        username: username,
        rpId: RP_ID,
        attestationType: attestationConveyance,
        hasExistingCredentials: existingCredentials.length > 0
    });
    
    return options;
}

/**
 * Verify a registration response and store the credential.
 * Validates the attestation from the authenticator and stores the credential.
 * 
 * @param {string} userId - Unique user identifier
 * @param {object} response - Registration response from authenticator
 * @returns {Promise<object>} Verification result
 */
async function verifyRegistration(userId, response) {
    validateUserId(userId);
    validateRegistrationResponse(response);
    
    // Get and validate the stored challenge
    const expectedChallenge = challengeStore.get(userId);
    
    if (!expectedChallenge || expectedChallenge.type !== 'registration') {
        logFido2Event('FIDO2_REGISTRATION_VERIFICATION_FAILED', {
            userId: userId,
            reason: 'No pending registration challenge'
        });
        
        throw new Error('No pending registration challenge found');
    }
    
    // Verify attestation if provided
    const attestationVerification = process.env.FIDO2_ATTESTATION === 'none' ? 'none' : 'direct';
    
    let verification;
    
    try {
        verification = await _verifyRegistrationResponse(response, {
            expectedChallenge: expectedChallenge.challenge,
            expectedOrigin: getExpectedOrigins(),
            expectedRPID: RP_ID,
            requireUserVerification: true,
            // For now, be permissive on attestation to support more authenticators
            attestationType: attestationVerification
        });
    } catch (err) {
        logFido2Event('FIDO2_REGISTRATION_VERIFICATION_FAILED', {
            userId: userId,
            reason: err.message
        });
        
        clearChallenge(userId);
        throw new Error('Registration verification failed: ' + err.message);
    }
    
    // Verify registration was successful
    if (!verification || !verification.verified) {
        logFido2Event('FIDO2_REGISTRATION_VERIFICATION_FAILED', {
            userId: userId,
            reason: 'Verification returned not verified'
        });
        
        clearChallenge(userId);
        throw new Error('Registration verification failed');
    }
    
    // Extract and store only verified credential data (never raw data)
    const credential = {
        credentialID: verification.credentialID,
        credentialPublicKey: verification.credentialPublicKey,
        counter: verification.counter,
        transports: response.response.transports || ['internal'],
        // Store attestation type for audit purposes
        attestationType: verification.attestationType || 'unknown',
        // Store a truncated credential ID for identification
        credentialIdHex: Buffer.from(verification.credentialID).toString('hex').substring(0, 16)
    };
    
    // Store the verified credential
    storeCredential(userId, credential);
    
    // Clear the challenge
    clearChallenge(userId);
    
    // Audit logging
    logFido2Event('FIDO2_REGISTRATION_COMPLETED', {
        userId: userId,
        credentialId: credential.credentialIdHex,
        attestationType: credential.attestationType,
        transports: credential.transports
    });
    
    return {
        verified: true,
        credentialId: credential.credentialID,
        credentialIdHex: credential.credentialIdHex
    };
}

/**
 * Generate authentication options for login.
 * Creates a challenge for the user to authenticate with an existing credential.
 * 
 * @param {string} userId - Unique user identifier
 * @returns {Promise<object>} Authentication options with challenge
 */
async function generateAuthenticationOptions(userId) {
    validateUserId(userId);
    
    // Get user's registered credentials
    const credentials = getCredentials(userId);
    
    // If no credentials, we can't authenticate
    if (credentials.length === 0) {
        logFido2Event('FIDO2_AUTHENTICATION_OPTIONS_FAILED', {
            userId: userId,
            reason: 'No credentials registered'
        });
        
        throw new Error('No credentials registered for this user');
    }
    
    // Generate cryptographically random challenge
    const challenge = generateChallenge();
    
    // Generate authentication options
    const options = _generateAuthenticationOptions({
        timeout: CHALLENGE_TIMEOUT,
        rpID: RP_ID,
        // Allow any of the user's credentials to be used (discoverable)
        allowCredentials: credentials.map(cred => ({
            id: cred.credentialID,
            type: 'public-key',
            transports: cred.transports || ['usb', 'nfc', 'ble', 'internal']
        })),
        userVerification: 'preferred'
    });
    
    // Store challenge for later verification
    storeChallenge(userId, {
        challenge: options.challenge,
        type: 'authentication',
        credentials: credentials.map(c => c.credentialID)
    });
    
    // Audit logging
    logFido2Event('FIDO2_AUTHENTICATION_OPTIONS_GENERATED', {
        userId: userId,
        credentialCount: credentials.length,
        rpId: RP_ID
    });
    
    return options;
}

/**
 * Verify an authentication response and complete login.
 * Validates the assertion from the authenticator.
 * 
 * @param {string} userId - Unique user identifier
 * @param {object} response - Authentication response from authenticator
 * @returns {Promise<object>} Verification result
 */
async function verifyAuthentication(userId, response) {
    validateUserId(userId);
    validateAuthenticationResponse(response);
    
    // Get the stored challenge
    const expectedChallenge = challengeStore.get(userId);
    
    if (!expectedChallenge || expectedChallenge.type !== 'authentication') {
        logFido2Event('FIDO2_AUTHENTICATION_VERIFICATION_FAILED', {
            userId: userId,
            reason: 'No pending authentication challenge'
        });
        
        throw new Error('No pending authentication challenge found');
    }
    
    // Find the credential that was used
    const credentialId = response.id || Buffer.from(response.rawId, 'base64').toString('base64');
    const credential = getCredentialById(userId, credentialId);
    
    if (!credential) {
        logFido2Event('FIDO2_AUTHENTICATION_VERIFICATION_FAILED', {
            userId: userId,
            reason: 'Credential not found'
        });
        
        clearChallenge(userId);
        throw new Error('Credential not found for this user');
    }
    
    let verification;
    
    try {
        verification = await _verifyAuthenticationResponse(response, {
            expectedChallenge: expectedChallenge.challenge,
            expectedOrigin: getExpectedOrigins(),
            expectedRPID: RP_ID,
            credential: {
                publicKey: credential.credentialPublicKey,
                counter: credential.counter,
                transports: credential.transports
            },
            requireUserVerification: true
        });
    } catch (err) {
        logFido2Event('FIDO2_AUTHENTICATION_VERIFICATION_FAILED', {
            userId: userId,
            credentialId: credential.credentialIdHex,
            reason: err.message
        });
        
        clearChallenge(userId);
        throw new Error('Authentication verification failed: ' + err.message);
    }
    
    // Verify authentication was successful
    if (!verification || !verification.verified) {
        logFido2Event('FIDO2_AUTHENTICATION_VERIFICATION_FAILED', {
            userId: userId,
            credentialId: credential.credentialIdHex,
            reason: 'Verification returned not verified'
        });
        
        clearChallenge(userId);
        throw new Error('Authentication verification failed');
    }
    
    // Update credential counter
    if (verification.newCounter !== undefined) {
        const credentials = getCredentials(userId);
        const credIndex = credentials.findIndex(c => c.credentialID === credentialId);
        
        if (credIndex >= 0) {
            credentials[credIndex].counter = verification.newCounter;
            credentials[credIndex].updatedAt = Date.now();
            credentialStore.set(userId, credentials);
        }
    }
    
    // Clear the challenge
    clearChallenge(userId);
    
    // Audit logging
    logFido2Event('FIDO2_AUTHENTICATION_COMPLETED', {
        userId: userId,
        credentialId: credential.credentialIdHex,
        newCounter: verification.newCounter
    });
    
    return {
        verified: true,
        userId: userId,
        credentialId: credential.credentialIdHex
    };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get expected origins for WebAuthn operations.
 * @returns {array} Array of expected origins
 */
function getExpectedOrigins() {
    const origins = [];
    
    // Add configured origin if available
    if (process.env.FIDO2_ORIGIN) {
        origins.push(process.env.FIDO2_ORIGIN);
    }
    
    // Add common development origins
    if (process.env.NODE_ENV !== 'production') {
        origins.push('http://localhost:3000');
        origins.push('http://localhost:8080');
        origins.push('http://127.0.0.1:3000');
        origins.push('http://127.0.0.1:8080');
    }
    
    // Add production origin if available
    if (process.env.PUBLIC_URL) {
        origins.push(process.env.PUBLIC_URL);
    }
    
    return origins.length > 0 ? origins : ['http://localhost:3000'];
}

// =============================================================================
// EXPRESS ROUTER
// =============================================================================

/** Express router for FIDO2 endpoints */
const fido2Router = express.Router();

// Parse JSON bodies
fido2Router.use(express.json());

// POST /register - Generate registration options
fido2Router.post('/register', async (req, res) => {
    try {
        const { userId, username } = req.body;
        
        if (!userId || !username) {
            return res.status(400).json({
                success: false,
                error: 'userId and username are required'
            });
        }
        
        const options = await generateRegistrationOptions(userId, username);
        
        res.json({
            success: true,
            options: options
        });
    } catch (err) {
        console.error('[FIDO2] Register error:', err.message);
        
        res.status(400).json({
            success: false,
            error: err.message
        });
    }
});

// POST /verify-registration - Verify registration response
fido2Router.post('/verify-registration', async (req, res) => {
    try {
        const { userId, response } = req.body;
        
        if (!userId || !response) {
            return res.status(400).json({
                success: false,
                error: 'userId and response are required'
            });
        }
        
        const result = await verifyRegistration(userId, response);
        
        res.json({
            success: true,
            verified: result.verified,
            credentialId: result.credentialIdHex
        });
    } catch (err) {
        console.error('[FIDO2] Verify registration error:', err.message);
        
        res.status(400).json({
            success: false,
            error: err.message
        });
    }
});

// POST /authenticate - Generate authentication options
fido2Router.post('/authenticate', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'userId is required'
            });
        }
        
        const options = await generateAuthenticationOptions(userId);
        
        res.json({
            success: true,
            options: options
        });
    } catch (err) {
        console.error('[FIDO2] Authenticate error:', err.message);
        
        res.status(400).json({
            success: false,
            error: err.message
        });
    }
});

// POST /verify-authentication - Verify authentication response
fido2Router.post('/verify-authentication', async (req, res) => {
    try {
        const { userId, response } = req.body;
        
        if (!userId || !response) {
            return res.status(400).json({
                success: false,
                error: 'userId and response are required'
            });
        }
        
        const result = await verifyAuthentication(userId, response);
        
        res.json({
            success: true,
            verified: result.verified,
            userId: result.userId
        });
    } catch (err) {
        console.error('[FIDO2] Verify authentication error:', err.message);
        
        res.status(400).json({
            success: false,
            error: err.message
        });
    }
});

// GET /status - Get FIDO2 service status
fido2Router.get('/status', (req, res) => {
    res.json(getStatus());
});

// =============================================================================
// STATUS
// =============================================================================

/**
 * Get FIDO2 service status.
 * @returns {object} Status object
 */
function getStatus() {
    const isHealthy = typeof _generateRegistrationOptions === 'function';
    
    // Count total credentials
    let totalCredentials = 0;
    for (const credentials of credentialStore.values()) {
        totalCredentials += credentials.length;
    }
    
    return {
        active: true,
        healthy: isHealthy,
        details: {
            rpId: RP_ID,
            rpName: RP_NAME,
            registeredUsers: credentialStore.size,
            totalCredentials: totalCredentials,
            pendingChallenges: challengeStore.size,
            attestationConfigured: !!process.env.FIDO2_ATTESTATION,
            webauthnLibrary: isHealthy ? '@simplewebauthn/server' : 'NOT INSTALLED'
        }
    };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    generateRegistrationOptions,
    verifyRegistration,
    generateAuthenticationOptions,
    verifyAuthentication,
    fido2Router,
    getStatus
};
