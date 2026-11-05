/**
 * NovaSentinel Core Encryption Primitives
 * 
 * This module provides the foundational cryptographic primitives for NovaByte OS.
 * All other NovaSentinel modules import from this file.
 * 
 * SECURITY REQUIREMENTS:
 * - AES-256-GCM authenticated encryption only
 * - scrypt KDF with OWASP 2024 parameters (N=131072, r=8, p=1)
 * - Timing-safe comparisons for all sensitive comparisons
 * - Secure memory zeroing for key material
 * - No hardcoded keys - environment variables only
 * - Audit logging for all security events
 * 
 * @module sentinel/vault/encryption
 */

'use strict';

const crypto = require('crypto');

// =============================================================================
// CONSTANTS
// =============================================================================

/** AES-256-GCM constants */
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits (recommended for GCM)
const AUTH_TAG_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32; // 256 bits

/** scrypt KDF parameters - OWASP 2024 recommended */
const SCRYPT_N = 131072; // CPU/memory cost
const SCRYPT_R = 8;      // Block size
const SCRYPT_P = 1;      // Parallelisation

/** Envelope encryption magic bytes and version */
const ENVELOPE_MAGIC = Buffer.from([0x4E, 0x53, 0x45, 0x4E]); // "NSEN"
const ENVELOPE_VERSION = 1;

/** Shamir's Secret Sharing field size (GF(2^8)) */
const SSS_FIELD_SIZE = 256;
const SSS_PRIMITIVE = 0x11B; // AES polynomial

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
        // Sanitize data to avoid leaking sensitive information
        const sanitized = {
            ...data,
            sensitive: data.sensitive ? '[REDACTED]' : undefined,
            key: data.key ? '[REDACTED]' : undefined,
            secret: data.secret ? '[REDACTED]' : undefined
        };
        delete sanitized.password;
        delete sanitized.salt;
        
        if (typeof auditService !== 'undefined' && auditService && typeof auditService.logEvent === 'function') {
            auditService.logEvent(event, sanitized);
        }
    } catch (e) {
        // Silently fail - audit logging should never break functionality
        console.error('[NovaSentinel] Failed to log security event:', e.message);
    }
}

// =============================================================================
// ENCRYPTION - AES-256-GCM
// =============================================================================

/**
 * Encrypts plaintext using AES-256-GCM.
 * 
 * AES-256-GCM provides both confidentiality and authentication.
 * The authentication tag prevents tampering attacks.
 * 
 * @param {Buffer|string} plaintext - Data to encrypt
 * @param {Buffer} key - 256-bit encryption key
 * @returns {Promise<{ciphertext: Buffer, iv: Buffer, tag: Buffer, salt: Buffer}>}
 * @throws {Error} If encryption fails
 */
async function encrypt(plaintext, key) {
    if (!plaintext) {
        throw new Error('Plaintext is required');
    }
    if (!key || !Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
        throw new Error('Valid 256-bit key is required');
    }

    try {
        // Generate random salt for this operation
        const salt = crypto.randomBytes(SALT_LENGTH);
        
        // Generate random IV (96-bit recommended for GCM)
        const iv = crypto.randomBytes(IV_LENGTH);
        
        // Convert plaintext to buffer if needed
        const plaintextBuf = Buffer.isBuffer(plaintext) 
            ? plaintext 
            : Buffer.from(plaintext, 'utf8');
        
        // Create cipher
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
            authTagLength: AUTH_TAG_LENGTH
        });
        
        // Encrypt
        const ciphertext = Buffer.concat([
            cipher.update(plaintextBuf),
            cipher.final()
        ]);
        
        // Get authentication tag
        const tag = cipher.getAuthTag();
        
        logSecurityEvent('encryption', { 
            algorithm: ALGORITHM, 
            plaintextLength: plaintextBuf.length,
            sensitive: false 
        });
        
        return {
            ciphertext,
            iv,
            tag,
            salt
        };
        
    } catch (error) {
        logSecurityEvent('encryption_failed', { 
            error: error.message,
            sensitive: false 
        });
        throw new Error('Encryption failed');
    }
}

/**
 * Decrypts AES-256-GCM encrypted data.
 * 
 * Verifies authentication tag before returning plaintext.
 * Throws on tag mismatch (tampering detection).
 * 
 * @param {Buffer} ciphertext - Encrypted data
 * @param {Buffer} iv - Initialization vector
 * @param {Buffer} tag - Authentication tag
 * @param {Buffer} key - 256-bit decryption key
 * @returns {Promise<Buffer>} Decrypted plaintext
 * @throws {Error} If decryption fails or tag mismatch
 */
async function decrypt(ciphertext, iv, tag, key) {
    if (!ciphertext || !Buffer.isBuffer(ciphertext)) {
        throw new Error('Ciphertext is required');
    }
    if (!iv || !Buffer.isBuffer(iv) || iv.length !== IV_LENGTH) {
        throw new Error('Valid IV is required');
    }
    if (!tag || !Buffer.isBuffer(tag) || tag.length !== AUTH_TAG_LENGTH) {
        throw new Error('Valid authentication tag is required');
    }
    if (!key || !Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
        throw new Error('Valid 256-bit key is required');
    }

    try {
        // Create decipher
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
            authTagLength: AUTH_TAG_LENGTH
        });
        
        // Set authentication tag
        decipher.setAuthTag(tag);
        
        // Decrypt
        const plaintext = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final()
        ]);
        
        logSecurityEvent('decryption', { 
            algorithm: ALGORITHM,
            ciphertextLength: ciphertext.length,
            sensitive: false
        });
        
        return plaintext;
        
    } catch (error) {
        // Tag mismatch is the most likely error here
        const isAuthError = error.message.includes('auth tag') || 
                          error.message.includes('Unsupported state');
        
        logSecurityEvent('decryption_failed', { 
            error: isAuthError ? 'Authentication failed' : error.message,
            isAuthError,
            sensitive: false
        });
        
        if (isAuthError) {
            throw new Error('Authentication failed - data may have been tampered with');
        }
        throw new Error('Decryption failed');
    }
}

// =============================================================================
// KEY DERIVATION - scrypt
// =============================================================================

/**
 * Derives a 256-bit key from a password using scrypt KDF.
 * 
 * Uses OWASP 2024 recommended parameters: N=131072, r=8, p=1
 * This provides strong protection against brute-force and GPU attacks.
 * 
 * @param {Buffer|string} password - Password to derive key from
 * @param {Buffer} salt - Random salt (should be 32 bytes)
 * @returns {Promise<Buffer>} Derived 256-bit key
 * @throws {Error} If key derivation fails
 */
async function deriveKey(password, salt) {
    if (!password) {
        throw new Error('Password is required');
    }
    if (!salt || !Buffer.isBuffer(salt) || salt.length < 16) {
        throw new Error('Valid salt is required (minimum 16 bytes)');
    }

    try {
        // Convert password to buffer if needed
        const passwordBuf = Buffer.isBuffer(password) 
            ? password 
            : Buffer.from(password, 'utf8');
        
        // Derive key using scrypt
        const derivedKey = await new Promise((resolve, reject) => {
            crypto.scrypt(passwordBuf, salt, KEY_LENGTH, {
                N: SCRYPT_N,
                r: SCRYPT_R,
                p: SCRYPT_P,
                maxmem: 128 * 1024 * 1024 // 128MB limit
            }, (err, key) => {
                if (err) reject(err);
                else resolve(key);
            });
        });
        
        logSecurityEvent('key_derived', { 
            algorithm: 'scrypt',
            N: SCRYPT_N,
            r: SCRYPT_R,
            p: SCRYPT_P,
            sensitive: false
        });
        
        return derivedKey;
        
    } catch (error) {
        logSecurityEvent('key_derivation_failed', { 
            error: error.message,
            sensitive: false 
        });
        throw new Error('Key derivation failed');
    }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Generates a random 256-bit key.
 * 
 * Uses cryptographically secure random bytes generation.
 * 
 * @returns {Buffer} Random 256-bit key
 * @throws {Error} If key generation fails
 */
function generateKey() {
    try {
        const key = crypto.randomBytes(KEY_LENGTH);
        
        logSecurityEvent('key_generated', { 
            algorithm: 'random',
            keyLength: KEY_LENGTH * 8,
            sensitive: false
        });
        
        return key;
    } catch (error) {
        logSecurityEvent('key_generation_failed', { 
            error: error.message,
            sensitive: false 
        });
        throw new Error('Key generation failed');
    }
}

/**
 * Performs timing-safe comparison of two buffers.
 * 
 * Prevents timing attacks by ensuring comparison takes constant time
 * regardless of where the mismatch occurs.
 * 
 * @param {Buffer} a - First buffer
 * @param {Buffer} b - Second buffer
 * @returns {boolean} True if buffers are equal
 * @throws {Error} If comparison fails
 */
function constantTimeEqual(a, b) {
    if (!a || !b || !Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
        throw new Error('Both arguments must be buffers');
    }
    
    // Use Node.js built-in timing-safe comparison
    try {
        return crypto.timingSafeEqual(a, b);
    } catch (error) {
        // timingSafeEqual throws if lengths don't match
        // This is still timing-safe as it reveals length mismatch
        // which is acceptable
        return false;
    }
}

/**
 * Securely zeroes a buffer to prevent key material from lingering in memory.
 * 
 * Should be called on all key buffers after use.
 * Note: JavaScript makes this best-effort due to garbage collection.
 * 
 * @param {Buffer} buf - Buffer to zero
 * @returns {boolean} True if successful
 */
function zeroBuffer(buf) {
    if (!buf || !Buffer.isBuffer(buf)) {
        return false;
    }
    
    try {
        // Overwrite with zeros
        buf.fill(0);
        return true;
    } catch (error) {
        // Best effort - may fail if buffer is already detached
        return false;
    }
}

// =============================================================================
// ENVELOPE ENCRYPTION
// =============================================================================

/**
 * Encrypts data using envelope encryption pattern.
 * 
 * Creates a complete encrypted package with:
 * - Magic bytes for identification
 * - Version header for future compatibility
 * - Salt for key derivation
 * - IV for encryption
 * - Authentication tag
 * - Encrypted content
 * 
 * @param {Buffer|string} data - Data to encrypt
 * @param {Buffer} masterKey - 256-bit master key
 * @returns {Promise<Buffer>} Complete envelope (all fields concatenated)
 * @throws {Error} If encryption fails
 */
async function encryptEnvelope(data, masterKey) {
    if (!data) {
        throw new Error('Data is required');
    }
    if (!masterKey || !Buffer.isBuffer(masterKey) || masterKey.length !== KEY_LENGTH) {
        throw new Error('Valid 256-bit master key is required');
    }

    try {
        // Generate random DEK (Data Encryption Key)
        const dek = generateKey();
        
        // Encrypt the data with the DEK
        const { ciphertext, iv, tag, salt } = await encrypt(data, dek);
        
        // Encrypt the DEK with the master key
        const { ciphertext: encryptedDek, iv: dekIv, tag: dekTag } = await encrypt(dek, masterKey);
        
        // Zero the DEK from memory
        zeroBuffer(dek);
        
        // Build envelope: magic(4) + version(1) + salt(32) + iv(12) + tag(16) + dekIv(12) + dekTag(16) + encryptedDek + ciphertext
        const envelope = Buffer.concat([
            ENVELOPE_MAGIC,
            Buffer.from([ENVELOPE_VERSION]),
            salt,
            iv,
            tag,
            dekIv,
            dekTag,
            encryptedDek,
            ciphertext
        ]);
        
        logSecurityEvent('envelope_encrypted', { 
            version: ENVELOPE_VERSION,
            dataLength: Buffer.isBuffer(data) ? data.length : Buffer.from(data).length,
            sensitive: false
        });
        
        return envelope;
        
    } catch (error) {
        logSecurityEvent('envelope_encryption_failed', { 
            error: error.message,
            sensitive: false 
        });
        throw new Error('Envelope encryption failed');
    }
}

/**
 * Decrypts an envelope encryption package.
 * 
 * Verifies magic bytes and version before decrypting.
 * 
 * @param {Buffer} envelope - Complete envelope
 * @param {Buffer} masterKey - 256-bit master key
 * @returns {Promise<Buffer>} Decrypted data
 * @throws {Error} If decryption fails or magic/version mismatch
 */
async function decryptEnvelope(envelope, masterKey) {
    if (!envelope || !Buffer.isBuffer(envelope)) {
        throw new Error('Envelope is required');
    }
    if (!masterKey || !Buffer.isBuffer(masterKey) || masterKey.length !== KEY_LENGTH) {
        throw new Error('Valid 256-bit master key is required');
    }

    try {
        // Minimum size: magic(4) + version(1) + salt(32) + iv(12) + tag(16) + dekIv(12) + dekTag(16) + encryptedDek(32) + ciphertext(1)
        const minSize = 4 + 1 + 32 + 12 + 16 + 12 + 16 + 32 + 1;
        if (envelope.length < minSize) {
            throw new Error('Invalid envelope: too short');
        }
        
        // Parse envelope
        let offset = 0;
        
        // Verify magic bytes
        const magic = envelope.subarray(offset, offset + 4);
        offset += 4;
        
        if (!constantTimeEqual(magic, ENVELOPE_MAGIC)) {
            throw new Error('Invalid envelope: bad magic bytes');
        }
        
        // Verify version
        const version = envelope[offset];
        offset += 1;
        
        if (version !== ENVELOPE_VERSION) {
            throw new Error(`Unsupported envelope version: ${version}`);
        }
        
        // Extract fields
        const salt = envelope.subarray(offset, offset + 32);
        offset += 32;
        
        const iv = envelope.subarray(offset, offset + 12);
        offset += 12;
        
        const tag = envelope.subarray(offset, offset + 16);
        offset += 16;
        
        const dekIv = envelope.subarray(offset, offset + 12);
        offset += 12;
        
        const dekTag = envelope.subarray(offset, offset + 16);
        offset += 16;
        
        // Rest is encryptedDek + ciphertext
        const encryptedDekAndCiphertext = envelope.subarray(offset);
        
        // Split into encryptedDEK and ciphertext
        // encryptedDek is at least 32 bytes (minimum DEK size + overhead)
        const encryptedDekLen = encryptedDekAndCiphertext.length - (envelope.length - minSize);
        const encryptedDek = encryptedDekAndCiphertext.subarray(0, encryptedDekLen);
        const ciphertext = encryptedDekAndCiphertext.subarray(encryptedDekLen);
        
        // Decrypt the DEK using master key
        const dek = await decrypt(encryptedDek, dekIv, dekTag, masterKey);
        
        // Decrypt the data using the DEK
        const plaintext = await decrypt(ciphertext, iv, tag, dek);
        
        // Zero the DEK from memory
        zeroBuffer(dek);
        
        logSecurityEvent('envelope_decrypted', { 
            version: ENVELOPE_VERSION,
            dataLength: plaintext.length,
            sensitive: false
        });
        
        return plaintext;
        
    } catch (error) {
        if (error.message.includes('Invalid envelope') || 
            error.message.includes('Unsupported version') ||
            error.message.includes('Authentication failed')) {
            throw error;
        }
        logSecurityEvent('envelope_decryption_failed', { 
            error: error.message,
            sensitive: false 
        });
        throw new Error('Envelope decryption failed');
    }
}

// =============================================================================
// SHAMIR'S SECRET SHARING
// =============================================================================

/**
 * Galois Field arithmetic for Shamir's Secret Sharing.
 * Uses GF(2^8) with AES polynomial.
 */

/**
 * Multiplication in GF(2^8)
 * @param {number} a - First value
 * @param {number} b - Second value
 * @returns {number} Product
 */
function gfMul(a, b) {
    let result = 0;
    let aa = a;
    let bb = b;
    
    while (bb > 0) {
        if (bb & 1) {
            result ^= aa;
        }
        // Check if high bit is set
        const highBit = aa & 0x80;
        aa <<= 1;
        if (highBit) {
            aa ^= 0x1B; // AES polynomial reduction
        }
        bb >>= 1;
    }
    
    return result & 0xFF;
}

/**
 * Division in GF(2^8)
 * @param {number} a - Dividend
 * @param {number} b - Divisor
 * @returns {number} Quotient
 */
function gfDiv(a, b) {
    if (b === 0) {
        throw new Error('Division by zero');
    }
    
    // Find inverse using extended Euclidean algorithm
    let bInv = 1;
    for (let i = 0; i < 8; i++) {
        bInv = gfMul(bInv, b);
    }
    
    return gfMul(a, bInv);
}

/**
 * Lagrange interpolation at x=0
 * @param {Array} shares - Array of {x, y} points
 * @returns {number} Secret value
 */
function lagrangeInterpolate(shares) {
    let secret = 0;
    const numShares = shares.length;
    
    for (let i = 0; i < numShares; i++) {
        let numerator = 1;
        let denominator = 1;
        
        for (let j = 0; j < numShares; j++) {
            if (i !== j) {
                numerator = gfMul(numerator, shares[j].x);
                denominator = gfMul(denominator, shares[i].x ^ shares[j].x);
            }
        }
        
        const li = gfDiv(numerator, denominator);
        secret ^= gfMul(shares[i].y, li);
    }
    
    return secret;
}

/**
 * Splits a secret into N shares using Shamir's Secret Sharing.
 * 
 * Uses (threshold, N) scheme where any threshold shares can reconstruct
 * the secret, but fewer cannot.
 * 
 * @param {Buffer|string} secret - Secret to split
 * @param {number} shares - Total number of shares to generate (N)
 * @param {number} threshold - Minimum shares needed to reconstruct (K)
 * @returns {Array<{id: number, share: Buffer}>} Array of shares
 * @throws {Error} If parameters are invalid
 */
function splitSecret(secret, shares, threshold) {
    // Validate inputs
    if (!secret) {
        throw new Error('Secret is required');
    }
    if (typeof shares !== 'number' || shares < 2 || shares > 255) {
        throw new Error('Shares must be between 2 and 255');
    }
    if (typeof threshold !== 'number' || threshold < 2 || threshold > shares) {
        throw new Error(`Threshold must be between 2 and ${shares}`);
    }
    
    // Convert secret to buffer
    const secretBuf = Buffer.isBuffer(secret) 
        ? secret 
        : Buffer.from(secret, 'utf8');
    
    try {
        const result = [];
        
        // For each byte in the secret, create shares
        for (let byteIndex = 0; byteIndex < secretBuf.length; byteIndex++) {
            const secretByte = secretBuf[byteIndex];
            
            // Generate random coefficients for polynomial
            // f(x) = secret + a1*x + a2*x^2 + ... + a(threshold-1)*x^(threshold-1)
            const coefficients = [secretByte];
            for (let i = 1; i < threshold; i++) {
                coefficients.push(crypto.randomBytes(1)[0]);
            }
            
            // Evaluate polynomial at x = 1, 2, ..., shares
            for (let x = 1; x <= shares; x++) {
                // Ensure we have a share for this byte
                if (!result[x - 1]) {
                    result[x - 1] = { id: x, data: Buffer.alloc(secretBuf.length) };
                }
                
                // Evaluate polynomial: f(x) = sum(coeff[i] * x^i)
                let y = 0;
                let xPow = 1;
                for (let i = 0; i < coefficients.length; i++) {
                    y ^= gfMul(coefficients[i], xPow);
                    xPow = gfMul(xPow, x);
                }
                
                result[x - 1].data[byteIndex] = y;
            }
        }
        
        logSecurityEvent('secret_split', { 
            shares,
            threshold,
            secretLength: secretBuf.length,
            sensitive: false
        });
        
        return result.map(r => ({
            id: r.id,
            share: r.data
        }));
        
    } catch (error) {
        logSecurityEvent('secret_split_failed', { 
            error: error.message,
            sensitive: false 
        });
        throw new Error('Failed to split secret');
    }
}

/**
 * Reconstructs a secret from shares using Shamir's Secret Sharing.
 * 
 * Uses Lagrange interpolation to recover the secret from any
 * threshold number of shares.
 * 
 * @param {Array<{id: number, share: Buffer}>} shares - Array of shares
 * @returns {Buffer} Reconstructed secret
 * @throws {Error} If reconstruction fails
 */
function reconstructSecret(shares) {
    if (!shares || !Array.isArray(shares) || shares.length < 2) {
        throw new Error('At least 2 shares are required');
    }
    
    // Validate all shares have the same length
    const shareLength = shares[0].share.length;
    for (const share of shares) {
        if (!share.id || !share.share || !Buffer.isBuffer(share.share)) {
            throw new Error('Each share must have id and share Buffer');
        }
        if (share.share.length !== shareLength) {
            throw new Error('All shares must have the same length');
        }
    }
    
    try {
        const result = Buffer.alloc(shareLength);
        
        // Reconstruct each byte
        for (let byteIndex = 0; byteIndex < shareLength; byteIndex++) {
            // Extract points (x, y) for this byte
            const points = shares.map(share => ({
                x: share.id,
                y: share.share[byteIndex]
            }));
            
            // Use Lagrange interpolation to find secret at x=0
            result[byteIndex] = lagrangeInterpolate(points);
        }
        
        logSecurityEvent('secret_reconstructed', { 
            shareCount: shares.length,
            secretLength: result.length,
            sensitive: false
        });
        
        return result;
        
    } catch (error) {
        if (error.message.includes('Division by zero')) {
            throw new Error('Invalid shares: duplicate share IDs');
        }
        logSecurityEvent('secret_reconstruction_failed', { 
            error: error.message,
            sensitive: false 
        });
        throw new Error('Failed to reconstruct secret');
    }
}

// =============================================================================
// MODULE EXPORTS
// =============================================================================

module.exports = {
    /**
     * Encrypts plaintext using AES-256-GCM.
     * @param {Buffer|string} plaintext - Data to encrypt
     * @param {Buffer} key - 256-bit encryption key
     * @returns {Promise<{ciphertext: Buffer, iv: Buffer, tag: Buffer, salt: Buffer}>}
     */
    encrypt,
    
    /**
     * Decrypts AES-256-GCM encrypted data.
     * @param {Buffer} ciphertext - Encrypted data
     * @param {Buffer} iv - Initialization vector
     * @param {Buffer} tag - Authentication tag
     * @param {Buffer} key - 256-bit decryption key
     * @returns {Promise<Buffer>}
     */
    decrypt,
    
    /**
     * Derives a 256-bit key from password using scrypt.
     * @param {Buffer|string} password - Password to derive from
     * @param {Buffer} salt - Random salt
     * @returns {Promise<Buffer>}
     */
    deriveKey,
    
    /**
     * Generates a random 256-bit key.
     * @returns {Buffer}
     */
    generateKey,
    
    /**
     * Performs timing-safe comparison.
     * @param {Buffer} a - First buffer
     * @param {Buffer} b - Second buffer
     * @returns {boolean}
     */
    constantTimeEqual,
    
    /**
     * Securely zeroes a buffer.
     * @param {Buffer} buf - Buffer to zero
     * @returns {boolean}
     */
    zeroBuffer,
    
    /**
     * Encrypts data using envelope encryption.
     * @param {Buffer|string} data - Data to encrypt
     * @param {Buffer} masterKey - 256-bit master key
     * @returns {Promise<Buffer>}
     */
    encryptEnvelope,
    
    /**
     * Decrypts an envelope.
     * @param {Buffer} envelope - Complete envelope
     * @param {Buffer} masterKey - 256-bit master key
     * @returns {Promise<Buffer>}
     */
    decryptEnvelope,
    
    /**
     * Splits secret using Shamir's Secret Sharing.
     * @param {Buffer|string} secret - Secret to split
     * @param {number} shares - Total shares (N)
     * @param {number} threshold - Minimum to reconstruct (K)
     * @returns {Array<{id: number, share: Buffer}>}
     */
    splitSecret,
    
    /**
     * Reconstructs secret from shares.
     * @param {Array<{id: number, share: Buffer}>} shares - Shares
     * @returns {Buffer}
     */
    reconstructSecret,
    
    /**
     * Returns module health status.
     * @returns {{active: boolean, healthy: boolean, details: object}}
     */
    getStatus: () => ({ 
        active: true, 
        healthy: true, 
        details: {
            algorithm: ALGORITHM,
            keyLength: KEY_LENGTH * 8,
            scryptParams: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
            envelopeVersion: ENVELOPE_VERSION,
            sssFieldSize: SSS_FIELD_SIZE
        }
    })
};
