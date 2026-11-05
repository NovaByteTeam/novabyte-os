/**
 * NovaByte OS - Client-Side Crypto Helpers
 * Web Crypto API wrapper for client-side encryption (Vault/E2EE)
 * Provides key derivation, encryption/decryption, and secure token generation
 */

// Crypto configuration
const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits for GCM
const SALT_LENGTH = 16;
const ITERATIONS = 100000;
const HASH_ALGORITHM = 'SHA-256';

/**
 * Convert ArrayBuffer to Base64 string
 * @param {ArrayBuffer} buffer 
 * @returns {string}
 */
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Convert Base64 string to ArrayBuffer
 * @param {string} base64 
 * @returns {ArrayBuffer}
 */
function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

/**
 * Convert ArrayBuffer to Hex string
 * @param {ArrayBuffer} buffer 
 * @returns {string}
 */
function arrayBufferToHex(buffer) {
    const bytes = new Uint8Array(buffer);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate cryptographically secure random bytes
 * @param {number} length 
 * @returns {Uint8Array}
 */
function generateRandomBytes(length = 32) {
    return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Generate a secure random token
 * @param {number} length - Token length in bytes
 * @returns {string} Base64URL encoded token
 */
function generateSecureToken(length = 32) {
    const bytes = generateRandomBytes(length);
    return arrayBufferToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a salt for key derivation
 * @returns {Uint8Array}
 */
function generateSalt() {
    return generateRandomBytes(SALT_LENGTH);
}

/**
 * Derive a key from password using PBKDF2
 * @param {string} password - User password
 * @param {Uint8Array} salt - Salt bytes
 * @returns {CryptoKey}
 */
async function deriveKeyFromPassword(password, salt) {
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);

    // Import password as key
    const passwordKey = await crypto.subtle.importKey(
        'raw',
        passwordBuffer,
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
    );

    // Derive key using PBKDF2
    const key = await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: ITERATIONS,
            hash: HASH_ALGORITHM
        },
        passwordKey,
        {
            name: ALGORITHM,
            length: KEY_LENGTH
        },
        false,
        ['encrypt', 'decrypt']
    );

    return key;
}

/**
 * Encrypt data using AES-GCM
 * @param {string|object} data - Data to encrypt
 * @param {CryptoKey} key - Encryption key
 * @returns {Promise<{encrypted: string, iv: string}>}
 */
async function encrypt(data, key) {
    const encoder = new TextEncoder();
    
    // Convert data to bytes
    const dataString = typeof data === 'string' ? data : JSON.stringify(data);
    const dataBuffer = encoder.encode(dataString);

    // Generate IV
    const iv = generateRandomBytes(IV_LENGTH);

    // Encrypt
    const encryptedBuffer = await crypto.subtle.encrypt(
        {
            name: ALGORITHM,
            iv: iv
        },
        key,
        dataBuffer
    );

    return {
        encrypted: arrayBufferToBase64(encryptedBuffer),
        iv: arrayBufferToBase64(iv)
    };
}

/**
 * Decrypt data using AES-GCM
 * @param {string} encryptedData - Base64 encoded encrypted data
 * @param {string} iv - Base64 encoded IV
 * @param {CryptoKey} key - Decryption key
 * @returns {Promise<string>}
 */
async function decrypt(encryptedData, iv, key) {
    const encryptedBuffer = base64ToArrayBuffer(encryptedData);
    const ivBuffer = base64ToArrayBuffer(iv);

    // Decrypt
    const decryptedBuffer = await crypto.subtle.decrypt(
        {
            name: ALGORITHM,
            iv: ivBuffer
        },
        key,
        encryptedBuffer
    );

    const decoder = new TextDecoder();
    return decoder.decode(decryptedBuffer);
}

/**
 * Encrypt data with password (convenience function)
 * @param {string|object} data - Data to encrypt
 * @param {string} password - User password
 * @returns {Promise<{encrypted: string, iv: string, salt: string}>}
 */
async function encryptWithPassword(data, password) {
    const salt = generateSalt();
    const key = await deriveKeyFromPassword(password, salt);
    const result = await encrypt(data, key);
    
    return {
        ...result,
        salt: arrayBufferToBase64(salt)
    };
}

/**
 * Decrypt data with password (convenience function)
 * @param {string} encryptedData - Base64 encoded encrypted data
 * @param {string} iv - Base64 encoded IV
 * @param {string} salt - Base64 encoded salt
 * @param {string} password - User password
 * @returns {Promise<string>}
 */
async function decryptWithPassword(encryptedData, iv, salt, password) {
    const saltBuffer = base64ToArrayBuffer(salt);
    const key = await deriveKeyFromPassword(password, saltBuffer);
    return decrypt(encryptedData, iv, key);
}

/**
 * Generate an AES-GCM key for symmetric encryption
 * @returns {Promise<CryptoKey>}
 */
async function generateKey() {
    return crypto.subtle.generateKey(
        {
            name: ALGORITHM,
            length: KEY_LENGTH
        },
        true,
        ['encrypt', 'decrypt']
    );
}

/**
 * Export key to raw bytes
 * @param {CryptoKey} key 
 * @returns {Promise<string>} Base64 encoded key
 */
async function exportKey(key) {
    const exported = await crypto.subtle.exportKey('raw', key);
    return arrayBufferToBase64(exported);
}

/**
 * Import key from raw bytes
 * @param {string} keyData - Base64 encoded key
 * @returns {Promise<CryptoKey>}
 */
async function importKey(keyData) {
    const keyBuffer = base64ToArrayBuffer(keyData);
    return crypto.subtle.importKey(
        'raw',
        keyBuffer,
        { name: ALGORITHM, length: KEY_LENGTH },
        true,
        ['encrypt', 'decrypt']
    );
}

/**
 * Hash data using SHA-256
 * @param {string|object} data - Data to hash
 * @returns {Promise<string>} Hex encoded hash
 */
async function hashData(data) {
    const encoder = new TextEncoder();
    const dataString = typeof data === 'string' ? data : JSON.stringify(data);
    const dataBuffer = encoder.encode(dataString);
    
    const hashBuffer = await crypto.subtle.digest(HASH_ALGORITHM, dataBuffer);
    return arrayBufferToHex(hashBuffer);
}

/**
 * Create HMAC for message authentication
 * @param {string|object} data - Data to authenticate
 * @param {CryptoKey} key - HMAC key
 * @returns {Promise<string>} Hex encoded HMAC
 */
async function createHMAC(data, key) {
    const encoder = new TextEncoder();
    const dataString = typeof data === 'string' ? data : JSON.stringify(data);
    const dataBuffer = encoder.encode(dataString);
    
    const signature = await crypto.subtle.sign('HMAC', key, dataBuffer);
    return arrayBufferToHex(signature);
}

/**
 * Generate HMAC key from password
 * @param {string} password - Password
 * @returns {Promise<CryptoKey>}
 */
async function generateHMACKey(password) {
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);
    
    return crypto.subtle.importKey(
        'raw',
        passwordBuffer,
        { name: 'HMAC', hash: HASH_ALGORITHM },
        false,
        ['sign', 'verify']
    );
}

/**
 * Verify HMAC signature
 * @param {string|object} data - Original data
 * @param {string} signature - Expected signature (hex)
 * @param {CryptoKey} key - HMAC key
 * @returns {Promise<boolean>}
 */
async function verifyHMAC(data, signature, key) {
    const encoder = new TextEncoder();
    const dataString = typeof data === 'string' ? data : JSON.stringify(data);
    const dataBuffer = encoder.encode(dataString);
    
    return crypto.subtle.verify('HMAC', key, dataBuffer, base64ToArrayBuffer(signature));
}

/**
 * Generate RSA-OAEP key pair
 * @param {number} keySize - Key size in bits (2048 or 4096)
 * @returns {Promise<{publicKey: CryptoKey, privateKey: CryptoKey}>}
 */
async function generateKeyPair(keySize = 2048) {
    const keyPair = await crypto.subtle.generateKey(
        {
            name: 'RSA-OAEP',
            modulusLength: keySize,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: HASH_ALGORITHM
        },
        true,
        ['encrypt', 'decrypt']
    );

    return {
        publicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey
    };
}

/**
 * Export public key to SPKI format
 * @param {CryptoKey} publicKey 
 * @returns {Promise<string>} Base64 encoded public key
 */
async function exportPublicKey(publicKey) {
    const exported = await crypto.subtle.exportKey('spki', publicKey);
    return arrayBufferToBase64(exported);
}

/**
 * Export private key to PKCS8 format
 * @param {CryptoKey} privateKey 
 * @returns {Promise<string>} Base64 encoded private key
 */
async function exportPrivateKey(privateKey) {
    const exported = await crypto.subtle.exportKey('pkcs8', privateKey);
    return arrayBufferToBase64(exported);
}

/**
 * Import public key from SPKI format
 * @param {string} keyData - Base64 encoded public key
 * @returns {Promise<CryptoKey>}
 */
async function importPublicKey(keyData) {
    const keyBuffer = base64ToArrayBuffer(keyData);
    return crypto.subtle.importKey(
        'spki',
        keyBuffer,
        { name: 'RSA-OAEP', hash: HASH_ALGORITHM },
        true,
        ['encrypt']
    );
}

/**
 * Import private key from PKCS8 format
 * @param {string} keyData - Base64 encoded private key
 * @returns {Promise<CryptoKey>}
 */
async function importPrivateKey(keyData) {
    const keyBuffer = base64ToArrayBuffer(keyData);
    return crypto.subtle.importKey(
        'pkcs8',
        keyBuffer,
        { name: 'RSA-OAEP', hash: HASH_ALGORITHM },
        true,
        ['decrypt']
    );
}

/**
 * Encrypt data with RSA public key
 * @param {string|object} data - Data to encrypt
 * @param {CryptoKey} publicKey - RSA public key
 * @returns {Promise<string>} Base64 encoded encrypted data
 */
async function encryptWithPublicKey(data, publicKey) {
    const encoder = new TextEncoder();
    const dataString = typeof data === 'string' ? data : JSON.stringify(data);
    const dataBuffer = encoder.encode(dataString);
    
    const encryptedBuffer = await crypto.subtle.encrypt(
        { name: 'RSA-OAEP' },
        publicKey,
        dataBuffer
    );
    
    return arrayBufferToBase64(encryptedBuffer);
}

/**
 * Decrypt data with RSA private key
 * @param {string} encryptedData - Base64 encoded encrypted data
 * @param {CryptoKey} privateKey - RSA private key
 * @returns {Promise<string>}
 */
async function decryptWithPrivateKey(encryptedData, privateKey) {
    const encryptedBuffer = base64ToArrayBuffer(encryptedData);
    
    const decryptedBuffer = await crypto.subtle.decrypt(
        { name: 'RSA-OAEP' },
        privateKey,
        encryptedBuffer
    );
    
    const decoder = new TextDecoder();
    return decoder.decode(decryptedBuffer);
}

/**
 * Securely wipe sensitive data from memory
 * @param {Uint8Array} data 
 */
function secureWipe(data) {
    crypto.getRandomValues(data);
    data.fill(0);
}

// Export for different environments
const NovaByteCrypto = {
    // Core encryption
    encrypt,
    decrypt,
    encryptWithPassword,
    decryptWithPassword,
    
    // Key management
    generateKey,
    generateSalt,
    deriveKeyFromPassword,
    exportKey,
    importKey,
    
    // Key pairs
    generateKeyPair,
    exportPublicKey,
    exportPrivateKey,
    importPublicKey,
    importPrivateKey,
    encryptWithPublicKey,
    decryptWithPrivateKey,
    
    // Hashing
    hashData,
    
    // HMAC
    createHMAC,
    generateHMACKey,
    verifyHMAC,
    
    // Utilities
    generateRandomBytes,
    generateSecureToken,
    arrayBufferToBase64,
    base64ToArrayBuffer,
    arrayBufferToHex,
    secureWipe,
    
    // Constants
    ALGORITHM,
    KEY_LENGTH,
    IV_LENGTH,
    SALT_LENGTH,
    ITERATIONS,
    HASH_ALGORITHM
};

// Browser environment
if (typeof window !== 'undefined') {
    window.NovaByteCrypto = NovaByteCrypto;
}

// Node.js/CommonJS environment
if (typeof module !== 'undefined' && module.exports) {
    module.exports = NovaByteCrypto;
}
