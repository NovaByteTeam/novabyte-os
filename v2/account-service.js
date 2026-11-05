/**
 * NovaByte Bridge - Account Service
 * Handles email account management, credential storage, and encryption
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

// Data directory for persistence
const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-memory storage
const accounts = new Map(); // accountId -> account data
const userAccounts = new Map(); // userId -> Set of accountIds

// Load accounts from disk on startup
const loadAccounts = () => {
    try {
        if (fs.existsSync(ACCOUNTS_FILE)) {
            const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
            if (Array.isArray(data)) {
                data.forEach(account => {
                    accounts.set(account.id, account);
                    if (!userAccounts.has(account.userId)) {
                        userAccounts.set(account.userId, new Set());
                    }
                    userAccounts.get(account.userId).add(account.id);
                });
                console.log(`[AccountService] Loaded ${accounts.size} accounts from disk`);
            }
        }
    } catch (error) {
        console.error('[AccountService] Failed to load accounts:', error.message);
    }
};

// Save accounts to disk
const saveAccounts = () => {
    try {
        const accountsArray = Array.from(accounts.values());
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accountsArray, null, 2));
    } catch (error) {
        console.error('[AccountService] Failed to save accounts:', error.message);
    }
};

// Load on startup
loadAccounts();

// Encryption configuration
const CONFIG = {
    ENCRYPTION_KEY: process.env.ACCOUNT_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex'),
    TOKEN_LENGTH: 32,
    SALT: crypto.randomBytes(16).toString('hex')
};

/**
 * Encryption utilities for stored credentials
 */
const encrypt = (text) => {
    if (!text) return null;
    try {
        const iv = crypto.randomBytes(16);
        const key = crypto.scryptSync(CONFIG.ENCRYPTION_KEY, CONFIG.SALT, 32);
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return iv.toString('hex') + ':' + encrypted;
    } catch (error) {
        console.error('[AccountService] Encryption failed:', error.message);
        return null;
    }
};

const decrypt = (encryptedText) => {
    if (!encryptedText) return null;
    try {
        const [ivHex, encrypted] = encryptedText.split(':');
        if (!ivHex || !encrypted) return encryptedText;
        const iv = Buffer.from(ivHex, 'hex');
        const key = crypto.scryptSync(CONFIG.ENCRYPTION_KEY, CONFIG.SALT, 32);
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        console.error('[AccountService] Decryption failed:', error.message);
        return null;
    }
};

/**
 * Mask sensitive data for API responses
 */
const maskAccount = (account) => {
    if (!account) return null;
    const masked = { ...account };
    
    // Mask sensitive fields
    if (masked.password) {
        masked.password = '********';
    }
    if (masked.accessToken) {
        masked.accessToken = masked.accessToken.substring(0, 10) + '...';
    }
    if (masked.refreshToken) {
        masked.refreshToken = masked.refreshToken.substring(0, 10) + '...';
    }
    if (masked.smtpPassword) {
        masked.smtpPassword = '********';
    }
    
    // Remove encrypted versions
    delete masked._encryptedPassword;
    delete masked._encryptedAccessToken;
    delete masked._encryptedRefreshToken;
    delete masked._encryptedSmtpPassword;
    
    return masked;
};

/**
 * Account Service Module
 */
const AccountService = {
    /**
     * Add a new email account for a user
     * @param {string} userId - User ID from auth-service
     * @param {object} accountData - Account configuration
     * @returns {Promise<object>} Created account
     */
    async addAccount(userId, accountData) {
        const accountId = uuidv4();
        const createdAt = new Date().toISOString();
        
        // Validate required fields
        if (!accountData.email && !accountData.emailAddress) {
            throw new Error('Email address is required');
        }
        if (!accountData.providerId) {
            throw new Error('Provider ID is required');
        }
        
        // Encrypt sensitive credentials
        const encryptedPassword = accountData.password ? encrypt(accountData.password) : null;
        const encryptedAccessToken = accountData.accessToken ? encrypt(accountData.accessToken) : null;
        const encryptedRefreshToken = accountData.refreshToken ? encrypt(accountData.refreshToken) : null;
        const encryptedSmtpPassword = accountData.smtpPassword ? encrypt(accountData.smtpPassword) : null;
        
        const account = {
            id: accountId,
            userId,
            email: accountData.email || accountData.emailAddress,
            emailAddress: accountData.email || accountData.emailAddress,
            providerId: accountData.providerId,
            authMethod: accountData.authMethod || 'password',
            accountName: accountData.accountName || accountData.email?.split('@')[0] || 'Email Account',
            
            // IMAP settings (from provider or custom)
            imapHost: accountData.imapHost || null,
            imapPort: accountData.imapPort || null,
            imapSsl: accountData.imapSsl !== undefined ? accountData.imapSsl : true,
            
            // SMTP settings (from provider or custom)
            smtpHost: accountData.smtpHost || null,
            smtpPort: accountData.smtpPort || null,
            smtpSsl: accountData.smtpSsl !== undefined ? accountData.smtpSsl : true,
            smtpTls: accountData.smtpTls !== undefined ? accountData.smtpTls : true,
            
            // Encrypted credentials
            _encryptedPassword: encryptedPassword,
            _encryptedAccessToken: encryptedAccessToken,
            _encryptedRefreshToken: encryptedRefreshToken,
            _encryptedSmtpPassword: encryptedSmtpPassword,
            
            // OAuth tokens (encrypted)
            accessToken: encryptedAccessToken ? '***encrypted***' : null,
            refreshToken: encryptedRefreshToken ? '***encrypted***' : null,
            tokenExpiry: accountData.tokenExpiry || null,
            
            // App password (encrypted)
            password: encryptedPassword ? '***encrypted***' : null,
            smtpPassword: encryptedSmtpPassword ? '***encrypted***' : null,
            
            // Settings
            syncEnabled: accountData.syncEnabled !== false,
            syncInterval: accountData.syncInterval || 5, // minutes
            lastSyncAt: null,
            syncStatus: 'idle', // idle, syncing, error
            syncError: null,
            
            // Folder settings
            folders: accountData.folders || [],
            folderSyncEnabled: accountData.folderSyncEnabled !== false,
            
            // Metadata
            createdAt,
            updatedAt: createdAt,
            isActive: true,
            
            // Custom provider settings
            isCustomProvider: accountData.isCustomProvider || false,
            customSettings: accountData.customSettings || {}
        };
        
        // Store account
        accounts.set(accountId, account);
        
        // Link to user
        if (!userAccounts.has(userId)) {
            userAccounts.set(userId, new Set());
        }
        userAccounts.get(userId).add(accountId);
        
        // Persist to disk
        saveAccounts();
        
        console.log(`[AccountService] Account created: ${accountId} for user: ${userId}`);
        
        return maskAccount(account);
    },

    /**
     * Remove an email account
     * @param {string} accountId - Account ID
     * @param {string} userId - User ID for ownership validation
     * @returns {Promise<boolean>} Success status
     */
    async removeAccount(accountId, userId) {
        const account = accounts.get(accountId);
        
        if (!account) {
            throw new Error('Account not found');
        }
        
        // Validate ownership
        if (account.userId !== userId) {
            throw new Error('Unauthorized: Account does not belong to user');
        }
        
        // Remove from user's account set
        const userAccountSet = userAccounts.get(userId);
        if (userAccountSet) {
            userAccountSet.delete(accountId);
            if (userAccountSet.size === 0) {
                userAccounts.delete(userId);
            }
        }
        
        // Remove account
        accounts.delete(accountId);
        
        // Persist to disk
        saveAccounts();
        
        console.log(`[AccountService] Account removed: ${accountId}`);
        
        return true;
    },

    /**
     * Get all accounts for a user
     * @param {string} userId - User ID
     * @returns {Promise<object[]>} Array of accounts (masked)
     */
    async getAccounts(userId) {
        const accountIds = userAccounts.get(userId);
        
        if (!accountIds) {
            return [];
        }
        
        const userAccountList = [];
        for (const accountId of accountIds) {
            const account = accounts.get(accountId);
            if (account && account.isActive) {
                userAccountList.push(maskAccount(account));
            }
        }
        
        return userAccountList;
    },

    /**
     * Get account by ID with full credentials (internal use)
     * @param {string} accountId - Account ID
     * @returns {Promise<object|null>} Account with decrypted credentials
     */
    async getAccountById(accountId) {
        const account = accounts.get(accountId);
        
        if (!account) {
            return null;
        }
        
        // Decrypt credentials for internal use
        const decryptedAccount = { ...account };
        
        if (decryptedAccount._encryptedPassword) {
            decryptedAccount.password = decrypt(decryptedAccount._encryptedPassword);
        }
        if (decryptedAccount._encryptedAccessToken) {
            decryptedAccount.accessToken = decrypt(decryptedAccount._encryptedAccessToken);
        }
        if (decryptedAccount._encryptedRefreshToken) {
            decryptedAccount.refreshToken = decrypt(decryptedAccount._encryptedRefreshToken);
        }
        if (decryptedAccount._encryptedSmtpPassword) {
            decryptedAccount.smtpPassword = decrypt(decryptedAccount._encryptedSmtpPassword);
        }
        
        return decryptedAccount;
    },

    /**
     * Get account by ID (masked, for API responses)
     * @param {string} accountId - Account ID
     * @returns {Promise<object|null>} Masked account
     */
    async getAccountByIdMasked(accountId) {
        const account = accounts.get(accountId);
        return account ? maskAccount(account) : null;
    },

    /**
     * Validate account ownership
     * @param {string} accountId - Account ID
     * @param {string} userId - User ID
     * @returns {Promise<boolean>} True if user owns account
     */
    async validateOwnership(accountId, userId) {
        const account = accounts.get(accountId);
        
        if (!account) {
            return false;
        }
        
        return account.userId === userId;
    },

    /**
     * Update an email account
     * @param {string} accountId - Account ID
     * @param {string} userId - User ID for ownership validation
     * @param {object} updates - Fields to update
     * @returns {Promise<object>} Updated account
     */
    async updateAccount(accountId, userId, updates) {
        const account = accounts.get(accountId);
        
        if (!account) {
            throw new Error('Account not found');
        }
        
        // Validate ownership
        if (account.userId !== userId) {
            throw new Error('Unauthorized: Account does not belong to user');
        }
        
        // Fields that can be updated
        const updatableFields = [
            'accountName', 'imapHost', 'imapPort', 'imapSsl',
            'smtpHost', 'smtpPort', 'smtpSsl', 'smtpTls',
            'syncEnabled', 'syncInterval', 'folderSyncEnabled',
            'customSettings', 'isActive'
        ];
        
        // Handle credential updates
        if (updates.password !== undefined) {
            updates._encryptedPassword = updates.password ? encrypt(updates.password) : null;
            updates.password = updates.password ? '***encrypted***' : null;
        }
        if (updates.accessToken !== undefined) {
            updates._encryptedAccessToken = updates.accessToken ? encrypt(updates.accessToken) : null;
            updates.accessToken = updates.accessToken ? '***encrypted***' : null;
        }
        if (updates.refreshToken !== undefined) {
            updates._encryptedRefreshToken = updates.refreshToken ? encrypt(updates.refreshToken) : null;
            updates.refreshToken = updates.refreshToken ? '***encrypted***' : null;
        }
        if (updates.smtpPassword !== undefined) {
            updates._encryptedSmtpPassword = updates.smtpPassword ? encrypt(updates.smtpPassword) : null;
            updates.smtpPassword = updates.smtpPassword ? '***encrypted***' : null;
        }
        
        // Apply updates
        for (const field of updatableFields) {
            if (updates[field] !== undefined) {
                account[field] = updates[field];
            }
        }
        
        // Apply encrypted fields
        if (updates._encryptedPassword !== undefined) {
            account._encryptedPassword = updates._encryptedPassword;
        }
        if (updates._encryptedAccessToken !== undefined) {
            account._encryptedAccessToken = updates._encryptedAccessToken;
        }
        if (updates._encryptedRefreshToken !== undefined) {
            account._encryptedRefreshToken = updates._encryptedRefreshToken;
        }
        if (updates._encryptedSmtpPassword !== undefined) {
            account._encryptedSmtpPassword = updates._encryptedSmtpPassword;
        }
        
        account.updatedAt = new Date().toISOString();
        
        console.log(`[AccountService] Account updated: ${accountId}`);
        
        return maskAccount(account);
    },

    /**
     * Update account sync status
     * @param {string} accountId - Account ID
     * @param {string} status - Sync status
     * @param {string} error - Error message if failed
     */
    async updateSyncStatus(accountId, status, error = null) {
        const account = accounts.get(accountId);
        
        if (account) {
            account.syncStatus = status;
            account.syncError = error;
            if (status === 'complete') {
                account.lastSyncAt = new Date().toISOString();
            }
            account.updatedAt = new Date().toISOString();
        }
    },

    /**
     * Get decrypted credentials for mail operations
     * @param {string} accountId - Account ID
     * @returns {Promise<object|null>} Decrypted credentials
     */
    async getDecryptedCredentials(accountId) {
        const account = await this.getAccountById(accountId);
        
        if (!account) {
            return null;
        }
        
        return {
            userId: account.userId,
            accountId: account.id,
            email: account.email,
            emailAddress: account.emailAddress,
            password: account.password,
            accessToken: account.accessToken,
            refreshToken: account.refreshToken,
            tokenExpiry: account.tokenExpiry,
            smtpPassword: account.smtpPassword,
            providerId: account.providerId,
            authMethod: account.authMethod,
            imapHost: account.imapHost,
            imapPort: account.imapPort,
            imapSsl: account.imapSsl,
            smtpHost: account.smtpHost,
            smtpPort: account.smtpPort,
            smtpSsl: account.smtpSsl,
            smtpTls: account.smtpTls
        };
    },

    /**
     * Refresh OAuth token
     * @param {string} accountId - Account ID
     * @param {string} newAccessToken - New access token
     * @param {string} newRefreshToken - New refresh token
     * @param {string} tokenExpiry - Token expiry timestamp
     */
    async refreshToken(accountId, newAccessToken, newRefreshToken, tokenExpiry) {
        const account = accounts.get(accountId);
        
        if (!account) {
            throw new Error('Account not found');
        }
        
        // Encrypt and store new tokens
        account._encryptedAccessToken = newAccessToken ? encrypt(newAccessToken) : null;
        account._encryptedRefreshToken = newRefreshToken ? encrypt(newRefreshToken) : null;
        account.accessToken = newAccessToken ? '***encrypted***' : null;
        account.refreshToken = newRefreshToken ? '***encrypted***' : null;
        account.tokenExpiry = tokenExpiry;
        account.updatedAt = new Date().toISOString();
        
        console.log(`[AccountService] Token refreshed for account: ${accountId}`);
    },

    /**
     * Get all active accounts (for sync jobs)
     * @returns {Promise<object[]>} All active accounts
     */
    async getAllActiveAccounts() {
        const activeAccounts = [];
        for (const [accountId, account] of accounts) {
            if (account.isActive && account.syncEnabled) {
                activeAccounts.push(account);
            }
        }
        return activeAccounts;
    },

    /**
     * Get account count for a user
     * @param {string} userId - User ID
     * @returns {number} Number of accounts
     */
    getAccountCount(userId) {
        const accountIds = userAccounts.get(userId);
        return accountIds ? accountIds.size : 0;
    }
};

module.exports = AccountService;
