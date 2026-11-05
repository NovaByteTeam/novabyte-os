/**
 * NovaByte OS - Crypto Service
 * Encryption utilities for data at rest and in transit
 * Implements AES-256-GCM encryption, PBKDF2 key derivation, and secure token generation
 */

const crypto = require('crypto');
const { promisify } = require('util');

// Configuration constants
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32; // 256 bits
const PBKDF2_ITERATIONS = 100000;
const TOKEN_LENGTH = 32;
const HASH_ALGORITHM = 'sha256';

/**
 * Generate cryptographically secure random bytes
 * @param {number} length - Number of bytes to generate
 * @returns {Buffer} Random bytes
 */
function generateRandomBytes(length = TOKEN_LENGTH) {
    return crypto.randomBytes(length);
}

/**
 * Generate a secure token (URL-safe base64)
 * @param {number} length - Token length in bytes
 * @returns {string} Base64URL encoded token
 */
function generateSecureToken(length = TOKEN_LENGTH) {
    return crypto.randomBytes(length).toString('base64url');
}

/**
 * Generate a hex-encoded token
 * @param {number} length - Token length in bytes
 * @returns {string} Hex encoded token
 */
function generateHexToken(length = TOKEN_LENGTH) {
    return crypto.randomBytes(length).toString('hex');
}

/**
 * Derive a key from password using PBKDF2
 * @param {string} password - User password
 * @param {Buffer|string} salt - Salt (will be generated if not provided)
 * @returns {Promise<{key: Buffer, salt: Buffer}>} Derived key and salt
 */
async function deriveKeyFromPassword(password, salt = null) {
    if (!password || typeof password !== 'string') {
        throw new Error('Password must be a non-empty string');
    }

    const actualSalt = salt ? Buffer.from(salt) : generateRandomBytes(SALT_LENGTH);
    
    const key = await promisify(crypto.pbkdf2)(
        password,
        actualSalt,
        PBKDF2_ITERATIONS,
        KEY_LENGTH,
        HASH_ALGORITHM
    );

    return { key, salt: actualSalt };
}

/**
 * Encrypt data using AES-256-GCM
 * @param {string|Buffer} data - Data to encrypt
 * @param {Buffer} key - Encryption key (32 bytes)
 * @returns {Promise<{encrypted: string, iv: string, authTag: string}>} Base64 encoded encrypted data
 */
async function encrypt(data, key) {
    if (!key || key.length !== KEY_LENGTH) {
        throw new Error(`Key must be ${KEY_LENGTH} bytes`);
    }

    const iv = generateRandomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH
    });

    const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    
    const encrypted = Buffer.concat([
        cipher.update(dataBuffer),
        cipher.final()
    ]);

    const authTag = cipher.getAuthTag();

    return {
        encrypted: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64')
    };
}

/**
 * Decrypt data using AES-256-GCM
 * @param {string} encryptedData - Base64 encoded encrypted data
 * @param {string} iv - Base64 encoded IV
 * @param {string} authTag - Base64 encoded auth tag
 * @param {Buffer} key - Decryption key (32 bytes)
 * @returns {Promise<Buffer>} Decrypted data
 */
async function decrypt(encryptedData, iv, authTag, key) {
    if (!key || key.length !== KEY_LENGTH) {
        throw new Error(`Key must be ${KEY_LENGTH} bytes`);
    }

    const decipher = crypto.createDecipheriv(
        ENCRYPTION_ALGORITHM,
        key,
        Buffer.from(iv, 'base64'),
        { AUTH_TAG_LENGTH }
    );

    decipher.setAuthTag(Buffer.from(authTag, 'base64'));

    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedData, 'base64')),
        decipher.final()
    ]);

    return decrypted;
}

/**
 * Encrypt data with password-derived key
 * @param {string|Buffer} data - Data to encrypt
 * @param {string} password - User password
 * @returns {Promise<{encrypted: string, iv: string, authTag: string, salt: string}>}
 */
async function encryptWithPassword(data, password) {
    const { key, salt } = await deriveKeyFromPassword(password);
    const result = await encrypt(data, key);
    result.salt = salt.toString('base64');
    return result;
}

/**
 * Decrypt data with password-derived key
 * @param {string} encryptedData - Base64 encoded encrypted data
 * @param {string} iv - Base64 encoded IV
 * @param {string} authTag - Base64 encoded auth tag
 * @param {string} salt - Base64 encoded salt
 * @param {string} password - User password
 * @returns {Promise<Buffer>}
 */
async function decryptWithPassword(encryptedData, iv, authTag, salt, password) {
    const { key } = await deriveKeyFromPassword(password, salt);
    return decrypt(encryptedData, iv, authTag, key);
}

/**
 * Hash a password using PBKDF2 with SHA-256
 * @param {string} password - Password to hash
 * @returns {Promise<{hash: string, salt: string}>}
 */
async function hashPassword(password) {
    const salt = generateRandomBytes(SALT_LENGTH);
    const hash = await promisify(crypto.pbkdf2)(
        password,
        salt,
        PBKDF2_ITERATIONS,
        KEY_LENGTH,
        HASH_ALGORITHM
    );

    return {
        hash: hash.toString('base64'),
        salt: salt.toString('base64')
    };
}

/**
 * Verify a password against a stored hash
 * @param {string} password - Password to verify
 * @param {string} storedHash - Stored hash (base64)
 * @param {string} storedSalt - Stored salt (base64)
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, storedHash, storedSalt) {
    const { key } = await deriveKeyFromPassword(password, storedSalt);
    const hash = await promisify(crypto.pbkdf2)(
        password,
        Buffer.from(storedSalt, 'base64'),
        PBKDF2_ITERATIONS,
        KEY_LENGTH,
        HASH_ALGORITHM
    );

    return crypto.timingSafeEqual(hash, Buffer.from(storedHash, 'base64'));
}

/**
 * Create a hash of arbitrary data (one-way)
 * @param {string|Buffer} data - Data to hash
 * @returns {string} SHA-256 hash (hex)
 */
function hashData(data) {
    const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    return crypto.createHash(HASH_ALGORITHM).update(dataBuffer).digest('hex');
}

/**
 * Encrypt OAuth/token data for storage
 * @param {object} tokenData - Token data to encrypt
 * @param {Buffer} key - Encryption key
 * @returns {Promise<string>} Encrypted token (base64)
 */
async function encryptToken(tokenData, key) {
    const data = JSON.stringify(tokenData);
    const { encrypted, iv, authTag } = await encrypt(data, key);
    
    // Combine all parts into single string
    const combined = JSON.stringify({ encrypted, iv, authTag });
    return Buffer.from(combined).toString('base64');
}

/**
 * Decrypt OAuth/token data
 * @param {string} encryptedToken - Encrypted token (base64)
 * @param {Buffer} key - Decryption key
 * @returns {Promise<object>}
 */
async function decryptToken(encryptedToken, key) {
    const { encrypted, iv, authTag } = JSON.parse(Buffer.from(encryptedToken, 'base64').toString('utf8'));
    const decrypted = await decrypt(encrypted, iv, authTag, key);
    return JSON.parse(decrypted.toString('utf8'));
}

/**
 * Generate key pair for asymmetric encryption (RSA-OAEP)
 * @param {number} keySize - Key size in bits (2048 or 4096)
 * @returns {Promise<{publicKey: string, privateKey: string}>}
 */
async function generateKeyPair(keySize = 2048) {
    return promisify(crypto.generateKeyPair)('rsa', {
        modulusLength: keySize,
        publicKeyEncoding: {
            type: 'spki',
            format: 'pem'
        },
        privateKeyEncoding: {
            type: 'pkcs8',
            format: 'pem'
        }
    });
}

/**
 * Encrypt data with public key (RSA-OAEP)
 * @param {string|Buffer} data - Data to encrypt
 * @param {string} publicKey - PEM encoded public key
 * @returns {string} Base64 encoded encrypted data
 */
function encryptWithPublicKey(data, publicKey) {
    const encrypted = crypto.publicEncrypt(
        {
            key: publicKey,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: HASH_ALGORITHM
        },
        Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    );
    return encrypted.toString('base64');
}

/**
 * Decrypt data with private key (RSA-OAEP)
 * @param {string} encryptedData - Base64 encoded encrypted data
 * @param {string} privateKey - PEM encoded private key
 * @returns {Buffer}
 */
function decryptWithPrivateKey(encryptedData, privateKey) {
    return crypto.privateDecrypt(
        {
            key: privateKey,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: HASH_ALGORITHM
        },
        Buffer.from(encryptedData, 'base64')
    );
}

/**
 * Create HMAC for message authentication
 * @param {string|Buffer} data - Data to authenticate
 * @param {Buffer} key - HMAC key
 * @returns {string} Hex encoded HMAC
 */
function createHMAC(data, key) {
    const hmac = crypto.createHmac('sha256', key);
    hmac.update(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
    return hmac.digest('hex');
}

/**
 * Verify HMAC
 * @param { data - Data tostring|Buffer} verify
 * @param {string} signature - Expected HMAC (hex)
 * @param {Buffer} key - HMAC key
 * @returns {boolean}
 */
function verifyHMAC(data, signature, key) {
    const expected = createHMAC(data, key);
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

/**
 * Constant-time string comparison
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean}
 */
function constantTimeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        return false;
    }
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Generate CSRF token
 * @returns {string}
 */
function generateCSRFToken() {
    return generateSecureToken(32);
}

/**
 * Verify CSRF token
 * @param {string} token - Token to verify
 * @param {string} secret - Secret used to generate token
 * @returns {boolean}
 */
function verifyCSRFToken(token, secret) {
    const expected = createHMAC(secret, Buffer.from('csrf-secret', 'utf8'));
    return constantTimeCompare(token, expected);
}

// Export all functions
module.exports = {
    // Core encryption
    encrypt,
    decrypt,
    encryptWithPassword,
    decryptWithPassword,
    
    // Key management
    generateRandomBytes,
    deriveKeyFromPassword,
    generateKeyPair,
    encryptWithPublicKey,
    decryptWithPrivateKey,
    
    // Password handling
    hashPassword,
    verifyPassword,
    
    // Hashing
    hashData,
    
    // Tokens
    generateSecureToken,
    generateHexToken,
    encryptToken,
    decryptToken,
    generateCSRFToken,
    verifyCSRFToken,
    
    // HMAC
    createHMAC,
    verifyHMAC,
    
    // Utilities
    constantTimeCompare,
    
    // Constants
    ENCRYPTION_ALGORITHM,
    KEY_LENGTH,
    IV_LENGTH,
    AUTH_TAG_LENGTH,
    SALT_LENGTH,
    PBKDF2_ITERATIONS
};
