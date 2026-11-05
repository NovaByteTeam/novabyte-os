/**
 * NovaSentinel Secure Folder
 * 
 * This module provides OPFS (Origin Private File System) based app silos
 * for secure data isolation between different applications/domains.
 * Each app gets its own isolated storage directory within OPFS.
 * 
 * SECURITY REQUIREMENTS:
 * - OPFS provides origin-isolated storage
 * - Files encrypted with app-specific keys before storage
 * - Each app silo has its own encryption key hierarchy
 * - Secure deletion (overwrite before delete)
 * - Audit logging for all file operations
 * 
 * @module sentinel/vault/sentinel-secure-folder
 */

'use strict';

// Wrap in IIFE to avoid global const conflicts when loaded in browser
(function() {
// =============================================================================
// BROWSER-ONLY MODULE CHECK
// =============================================================================

if (typeof window === 'undefined' && typeof global !== 'undefined') {
    console.warn('[NovaSentinel] sentinel-secure-folder.js is designed for browser environment only');
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Storage quota constants */
const STORAGE_QUOTA = {
    DEFAULT: 100 * 1024 * 1024, // 100 MB default
    MAX: 1024 * 1024 * 1024     // 1 GB max
};

/** File operation constants */
const FILE_OPERATIONS = {
    READ: 'read',
    WRITE: 'write',
    DELETE: 'delete',
    LIST: 'list'
};

/** Error codes */
const ERROR_CODES = {
    OPFS_UNAVAILABLE: 'SENTINEL_FOLDER_OPFS_UNAVAILABLE',
    SILO_NOT_FOUND: 'SENTINEL_FOLDER_SILO_NOT_FOUND',
    FILE_NOT_FOUND: 'SENTINEL_FOLDER_FILE_NOT_FOUND',
    QUOTA_EXCEEDED: 'SENTINEL_FOLDER_QUOTA_EXCEEDED',
    ENCRYPTION_FAILED: 'SENTINEL_FOLDER_ENCRYPTION_FAILED',
    DECRYPTION_FAILED: 'SENTINEL_FOLDER_DECRYPTION_FAILED'
};

// =============================================================================
// STATE
// =============================================================================

/** OPFS root handle */
let opfsRoot = null;

/** Mounted app silos (Map<appId, Silo>) */
const appSilos = new Map();

/** Audit logging callback */
let auditLogger = null;

/** Whether OPFS is available */
let isOPFSAvailable = false;

// =============================================================================
// ERROR CLASSES
// =============================================================================

class SecureFolderError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'SecureFolderError';
        this.code = code;
        this.details = details;
    }
}

class OPFSUnavailableError extends SecureFolderError {
    constructor() {
        super(
            ERROR_CODES.OPFS_UNAVAILABLE,
            'OPFS (Origin Private File System) is not available in this browser'
        );
    }
}

class SiloNotFoundError extends SecureFolderError {
    constructor(appId) {
        super(
            ERROR_CODES.SILO_NOT_FOUND,
            `App silo not found: ${appId}`,
            { appId }
        );
    }
}

class FileNotFoundError extends SecureFolderError {
    constructor(fileName, appId) {
        super(
            ERROR_CODES.FILE_NOT_FOUND,
            `File not found: ${fileName} in ${appId}`,
            { fileName, appId }
        );
    }
}

class QuotaExceededError extends SecureFolderError {
    constructor(appId, requested, available) {
        super(
            ERROR_CODES.QUOTA_EXCEEDED,
            `Storage quota exceeded for ${appId}`,
            { appId, requested, available }
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
        console.error('[NovaSentinel] Failed to log secure folder event:', e.message);
    }
}

// =============================================================================
// OPFS UTILITIES
// =============================================================================

/**
 * Check if OPFS is available
 * @returns {Promise<boolean>}
 */
async function checkOPFSAvailability() {
    try {
        if (typeof navigator === 'undefined' || !navigator.storage) {
            return false;
        }

        if (!navigator.storage.getDirectory) {
            return false;
        }

        // Try to get the root directory
        const root = await navigator.storage.getDirectory();
        isOPFSAvailable = !!root;
        return isOPFSAvailable;
    } catch (error) {
        console.error('[NovaSentinel] OPFS availability check failed:', error);
        return false;
    }
}

/**
 * Get OPFS root directory
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
async function getOPFSRoot() {
    if (opfsRoot) {
        return opfsRoot;
    }

    if (!isOPFSAvailable) {
        throw new OPFSUnavailableError();
    }

    opfsRoot = await navigator.storage.getDirectory();
    return opfsRoot;
}

/**
 * Create directory in OPFS
 * @param {FileSystemDirectoryHandle} parent - Parent directory
 * @param {string} name - Directory name
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
async function createDirectory(parent, name) {
    try {
        return await parent.getDirectoryHandle(name, { create: true });
    } catch (error) {
        // Already exists
        return await parent.getDirectoryHandle(name);
    }
}

/**
 * Get directory in OPFS
 * @param {FileSystemDirectoryHandle} parent - Parent directory
 * @param {string} name - Directory name
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
async function getDirectory(parent, name) {
    try {
        return await parent.getDirectoryHandle(name);
    } catch (error) {
        return null;
    }
}

/**
 * Delete directory in OPFS
 * @param {FileSystemDirectoryHandle} parent - Parent directory
 * @param {string} name - Directory name
 */
async function deleteDirectory(parent, name) {
    try {
        await parent.removeEntry(name, { recursive: true });
    } catch (error) {
        // Ignore if doesn't exist
    }
}

// =============================================================================
// CRYPTO UTILITIES
// =============================================================================

/**
 * Generate app-specific encryption key
 * @param {string} appId - Application ID
 * @param {Uint8Array} salt - Salt bytes
 * @returns {Promise<CryptoKey>}
 */
async function generateAppKey(appId, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(appId),
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
    );

    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: 100000,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypt data using AES-GCM
 * @param {ArrayBuffer|Uint8Array} data - Data to encrypt
 * @param {CryptoKey} key - Encryption key
 * @returns {Promise<{ciphertext: Uint8Array, iv: Uint8Array, tag: Uint8Array}>}
 */
async function encryptData(data, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        data instanceof Uint8Array ? data : new Uint8Array(data)
    );

    const encryptedArray = new Uint8Array(encrypted);
    const ciphertext = encryptedArray.slice(0, -16);
    const tag = encryptedArray.slice(-16);

    return { ciphertext, iv, tag };
}

/**
 * Decrypt data using AES-GCM
 * @param {Uint8Array} ciphertext - Encrypted data
 * @param {Uint8Array} iv - Initialization vector
 * @param {Uint8Array} tag - Authentication tag
 * @param {CryptoKey} key - Decryption key
 * @returns {Promise<Uint8Array>}
 */
async function decryptData(ciphertext, iv, tag, key) {
    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext, 0);
    combined.set(tag, ciphertext.length);

    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        combined
    );

    return new Uint8Array(decrypted);
}

/**
 * Securely wipe data from memory
 * @param {Uint8Array} data - Data to wipe
 */
function secureWipe(data) {
    if (data && data.fill) {
        data.fill(0);
    }
}

// =============================================================================
// SILO CLASS
// =============================================================================

/**
 * App Silo - Isolated storage for an application
 */
class AppSilo {
    constructor(appId, rootHandle) {
        this.appId = appId;
        this.rootHandle = rootHandle;
        this.encryptionKey = null;
        this.created = new Date().toISOString();
        this.fileCount = 0;
    }

    /**
     * Initialize encryption key for this silo
     * @param {string} keyMaterial - Key material or passphrase
     */
    async initializeKey(keyMaterial) {
        const salt = crypto.getRandomValues(new Uint8Array(32));
        
        if (keyMaterial) {
            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey(
                'raw',
                encoder.encode(keyMaterial),
                { name: 'PBKDF2' },
                false,
                ['deriveKey']
            );
            
            this.encryptionKey = await crypto.subtle.deriveKey(
                {
                    name: 'PBKDF2',
                    salt: salt,
                    iterations: 100000,
                    hash: 'SHA-256'
                },
                key,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt', 'decrypt']
            );
        } else {
            // Generate random key
            this.encryptionKey = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt', 'decrypt']
            );
        }

        this.salt = salt;
        return this.encryptionKey;
    }

    /**
     * Write encrypted file to silo
     * @param {string} fileName - File name
     * @param {ArrayBuffer|Uint8Array|string} data - Data to store
     * @returns {Promise<boolean>}
     */
    async writeFile(fileName, data) {
        if (!this.encryptionKey) {
            throw new SecureFolderError(
                ERROR_CODES.ENCRYPTION_FAILED,
                'Silo encryption key not initialized'
            );
        }

        const encoder = new TextEncoder();
        const dataBytes = typeof data === 'string' 
            ? encoder.encode(data) 
            : data instanceof ArrayBuffer 
                ? new Uint8Array(data) 
                : data;

        // Encrypt data
        const { ciphertext, iv, tag } = await encryptData(dataBytes, this.encryptionKey);

        // Create file handle
        const fileHandle = await this.rootHandle.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();

        // Write: salt + iv + tag + ciphertext
        const fileData = new Uint8Array(
            this.salt.length + iv.length + tag.length + ciphertext.length
        );
        let offset = 0;
        fileData.set(this.salt, offset); offset += this.salt.length;
        fileData.set(iv, offset); offset += iv.length;
        fileData.set(tag, offset); offset += tag.length;
        fileData.set(ciphertext, offset);

        await writable.write(fileData);
        await writable.close();

        this.fileCount++;

        await logSecurityEvent('SECURE_FOLDER_FILE_WRITTEN', {
            appId: this.appId,
            fileName,
            size: fileData.length
        });

        return true;
    }

    /**
     * Read encrypted file from silo
     * @param {string} fileName - File name
     * @returns {Promise<Uint8Array>}
     */
    async readFile(fileName) {
        if (!this.encryptionKey) {
            throw new SecureFolderError(
                ERROR_CODES.DECRYPTION_FAILED,
                'Silo encryption key not initialized'
            );
        }

        let fileHandle;
        try {
            fileHandle = await this.rootHandle.getFileHandle(fileName);
        } catch (error) {
            throw new FileNotFoundError(fileName, this.appId);
        }

        const file = await fileHandle.getFile();
        const fileData = new Uint8Array(await file.arrayBuffer());

        // Parse: salt + iv + tag + ciphertext
        const saltLength = 32;
        const ivLength = 12;
        const tagLength = 16;

        let offset = 0;
        const salt = fileData.slice(offset, offset + saltLength); offset += saltLength;
        const iv = fileData.slice(offset, offset + ivLength); offset += ivLength;
        const tag = fileData.slice(offset, offset + tagLength); offset += tagLength;
        const ciphertext = fileData.slice(offset);

        // Decrypt data
        const decrypted = await decryptData(ciphertext, iv, tag, this.encryptionKey);

        await logSecurityEvent('SECURE_FOLDER_FILE_READ', {
            appId: this.appId,
            fileName,
            size: file.length
        });

        return decrypted;
    }

    /**
     * Delete file from silo (secure delete)
     * @param {string} fileName - File name
     * @returns {Promise<boolean>}
     */
    async deleteFile(fileName) {
        try {
            // First, try to overwrite with zeros (if file exists)
            try {
                const fileHandle = await this.rootHandle.getFileHandle(fileName);
                const file = await fileHandle.getFile();
                const size = file.size;
                
                if (size > 0) {
                    const writable = await fileHandle.createWritable();
                    await writable.write(new Uint8Array(size));
                    await writable.close();
                }
            } catch (e) {
                // File might not exist
            }

            // Then delete
            await this.rootHandle.removeEntry(fileName);
            this.fileCount--;

            await logSecurityEvent('SECURE_FOLDER_FILE_DELETED', {
                appId: this.appId,
                fileName
            });

            return true;
        } catch (error) {
            if (error.name === 'NotFoundError') {
                return false;
            }
            throw error;
        }
    }

    /**
     * List all files in silo
     * @returns {Promise<Array<string>>}
     */
    async listFiles() {
        const files = [];
        
        for await (const entry of this.rootHandle.values()) {
            if (entry.kind === 'file') {
                files.push(entry.name);
            }
        }

        await logSecurityEvent('SECURE_FOLDER_FILES_LISTED', {
            appId: this.appId,
            count: files.length
        });

        return files;
    }

    /**
     * Get storage usage for this silo
     * @returns {Promise<number>}
     */
    async getStorageUsage() {
        let totalSize = 0;
        
        for await (const entry of this.rootHandle.values()) {
            if (entry.kind === 'file') {
                const file = await entry.getFile();
                totalSize += file.size;
            }
        }

        return totalSize;
    }

    /**
     * Delete entire silo
     * @returns {Promise<boolean>}
     */
    async destroy() {
        // Delete all files first
        const files = await this.listFiles();
        
        for (const fileName of files) {
            await this.deleteFile(fileName);
        }

        this.encryptionKey = null;
        this.fileCount = 0;

        await logSecurityEvent('SECURE_FOLDER_SILO_DESTROYED', {
            appId: this.appId
        });

        return true;
    }
}

// =============================================================================
// SILO MANAGEMENT
// =============================================================================

/**
 * Create a new app silo
 * @param {string} appId - Application ID
 * @param {string} keyMaterial - Optional key material or passphrase
 * @returns {Promise<AppSilo>}
 */
async function createAppSilo(appId, keyMaterial = null) {
    const root = await getOPFSRoot();
    
    // Create app-specific directory
    const appDir = await createDirectory(root, `app_${appId}`);
    
    // Create silo instance
    const silo = new AppSilo(appId, appDir);
    
    // Initialize encryption key
    await silo.initializeKey(keyMaterial);
    
    // Store in memory
    appSilos.set(appId, silo);

    await logSecurityEvent('SECURE_FOLDER_SILO_CREATED', {
        appId,
        fileCount: 0
    });

    return silo;
}

/**
 * Get existing app silo
 * @param {string} appId - Application ID
 * @returns {Promise<AppSilo>}
 */
async function getAppSilo(appId) {
    // Check memory cache first
    if (appSilos.has(appId)) {
        return appSilos.get(appId);
    }

    // Try to load from OPFS
    const root = await getOPFSRoot();
    const appDir = await getDirectory(root, `app_${appId}`);
    
    if (!appDir) {
        throw new SiloNotFoundError(appId);
    }

    const silo = new AppSilo(appId, appDir);
    
    // Note: keyMaterial needs to be re-provided for decryption
    // The silo won't be functional until initializeKey is called
    appSilos.set(appId, silo);

    return silo;
}

/**
 * Open existing or create new app silo
 * @param {string} appId - Application ID
 * @param {string} keyMaterial - Optional key material or passphrase
 * @returns {Promise<AppSilo>}
 */
async function openAppSilo(appId, keyMaterial = null) {
    try {
        const silo = await getAppSilo(appId);
        
        // Re-initialize key for decryption
        if (keyMaterial) {
            await silo.initializeKey(keyMaterial);
        }
        
        return silo;
    } catch (error) {
        if (error instanceof SiloNotFoundError) {
            return createAppSilo(appId, keyMaterial);
        }
        throw error;
    }
}

/**
 * Delete app silo
 * @param {string} appId - Application ID
 * @returns {Promise<boolean>}
 */
async function deleteAppSilo(appId) {
    const silo = await getAppSilo(appId);
    
    // Destroy silo (delete all files)
    await silo.destroy();
    
    // Remove from OPFS
    const root = await getOPFSRoot();
    await deleteDirectory(root, `app_${appId}`);
    
    // Remove from cache
    appSilos.delete(appId);

    await logSecurityEvent('SECURE_FOLDER_SILO_DELETED', {
        appId
    });

    return true;
}

/**
 * List all app silos
 * @returns {Promise<Array<string>>}
 */
async function listAppSilos() {
    const root = await getOPFSRoot();
    const silos = [];
    
    for await (const entry of root.values()) {
        if (entry.kind === 'directory' && entry.name.startsWith('app_')) {
            silos.push(entry.name.substring(4)); // Remove 'app_' prefix
        }
    }

    return silos;
}

// =============================================================================
// STORAGE QUOTA
// =============================================================================

/**
 * Get overall storage usage
 * @returns {Promise<{used: number, quota: number}>}
 */
async function getStorageInfo() {
    if (!navigator.storage || !navigator.storage.estimate) {
        return { used: 0, quota: STORAGE_QUOTA.DEFAULT };
    }

    const estimate = await navigator.storage.estimate();
    return {
        used: estimate.usage || 0,
        quota: estimate.quota || STORAGE_QUOTA.DEFAULT
    };
}

/**
 * Check if storage quota would be exceeded
 * @param {number} bytes - Additional bytes to check
 * @returns {Promise<boolean>}
 */
async function wouldExceedQuota(bytes) {
    const { used, quota } = await getStorageInfo();
    return (used + bytes) > quota;
}

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize secure folder module
 * @returns {Promise<boolean>}
 */
async function initialize() {
    // Check OPFS availability
    const available = await checkOPFSAvailability();
    
    if (!available) {
        console.warn('[NovaSentinel] OPFS not available - secure folder functionality limited');
    }

    await logSecurityEvent('SECURE_FOLDER_INITIALIZED', {
        opfsAvailable: available
    });

    return available;
}

/**
 * Destroy secure folder module
 */
async function destroy() {
    // Destroy all silos
    for (const appId of appSilos.keys()) {
        const silo = appSilos.get(appId);
        await silo.destroy();
    }
    appSilos.clear();

    opfsRoot = null;

    await logSecurityEvent('SECURE_FOLDER_DESTROYED', {});
}

// =============================================================================
// EXPORTS
// =============================================================================

const sentinelSecureFolder = {
    // Error codes
    ERROR_CODES,
    
    // Error classes
    SecureFolderError,
    OPFSUnavailableError,
    SiloNotFoundError,
    FileNotFoundError,
    QuotaExceededError,

    // Audit
    setAuditLogger,
    logSecurityEvent,

    // OPFS utilities
    checkOPFSAvailability,
    isOPFSAvailable: () => isOPFSAvailable,

    // Silo management
    createAppSilo,
    getAppSilo,
    openAppSilo,
    deleteAppSilo,
    listAppSilos,

    // Storage
    getStorageInfo,
    wouldExceedQuota,

    // Lifecycle
    initialize,
    destroy,

    // Export AppSilo for direct manipulation
    AppSilo
};

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = sentinelSecureFolder;
} else if (typeof window !== 'undefined') {
    window.NovaSentinelSecureFolder = sentinelSecureFolder;
}
})(); // End IIFE