/**
 * NovaByte Bridge - Authentication Service
 * Core authentication logic with user management, sessions, and security features
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

// Use in-memory storage initially, with optional file persistence
const DATA_DIR = path.join(__dirname, 'data');

// In-memory storage
const users = new Map();
const sessions = new Map();
const oauthTokens = new Map();
const appPasswords = new Map();

// Helper functions for in-memory storage
const generateToken = (length = 64) => {
    return crypto.randomBytes(length).toString('hex');
};

const CONFIG = {
    SESSION_EXPIRY_HOURS: parseInt(process.env.SESSION_EXPIRY_HOURS) || 24,
    SESSION_REFRESH_HOURS: parseInt(process.env.SESSION_REFRESH_HOURS) || 168,
    MAX_FAILED_ATTEMPTS: parseInt(process.env.MAX_FAILED_ATTEMPTS) || 5,
    LOCKOUT_DURATION_MINUTES: parseInt(process.env.LOCKOUT_DURATION_MINUTES) || 15,
    PASSWORD_MIN_LENGTH: 8,
    SALT_ROUNDS: 12,
    TOKEN_LENGTH: 64,
    ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex')
};

// Encryption utilities for OAuth tokens at rest
const SALT = crypto.randomBytes(16).toString('hex');
const encryptToken = (token) => {
    const iv = crypto.randomBytes(16);
    const key = crypto.scryptSync(CONFIG.ENCRYPTION_KEY, SALT, 32);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(token, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
};

const decryptToken = (encryptedToken) => {
    try {
        const [ivHex, encrypted] = encryptedToken.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const key = crypto.scryptSync(CONFIG.ENCRYPTION_KEY, SALT, 32);
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        console.error('[Auth] Token decryption failed:', error.message);
        return null;
    }
};

// Password hashing
const hashPassword = async (password) => {
    const bcrypt = require('bcryptjs');
    return bcrypt.hash(password, CONFIG.SALT_ROUNDS);
};

const verifyPassword = async (password, hash) => {
    const bcrypt = require('bcryptjs');
    return bcrypt.compare(password, hash);
};

/**
 * User operations
 */
const User = {
    /**
     * Create a new user
     */
    async create({ email, password, displayName, oauthProvider, oauthId }) {
        const id = uuidv4();
        const createdAt = new Date().toISOString();
        let passwordHash = null;

        if (password) {
            passwordHash = await hashPassword(password);
        }

        // Check if email already exists
        for (const [key, user] of users) {
            if (user.email === email.toLowerCase()) {
                throw new Error('Email already registered');
            }
        }

        const user = {
            id,
            email: email.toLowerCase(),
            passwordHash,
            displayName: displayName || email.split('@')[0],
            createdAt,
            lastLogin: null,
            mfaEnabled: false,
            mfaSecret: null,
            mfaBackupCodes: null,
            oauthProvider,
            oauthId,
            profileImage: null,
            settings: {},
            failedAttempts: 0,
            lockedUntil: null,
            verified: true,
            verificationToken: null
        };

        users.set(id, user);

        return {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            createdAt: user.createdAt
        };
    },

    /**
     * Find user by email
     */
    findByEmail(email) {
        for (const [key, user] of users) {
            if (user.email === email.toLowerCase()) {
                return { ...user };
            }
        }
        return null;
    },

    /**
     * Find user by ID
     */
    findById(id) {
        const user = users.get(id);
        if (!user) return null;
        
        const { passwordHash, mfaSecret, mfaBackupCodes, verificationToken, ...safeUser } = user;
        return safeUser;
    },

    /**
     * Find or create OAuth user
     */
    findOrCreateOAuth(provider, profile) {
        // Find existing user
        for (const [key, user] of users) {
            if (user.oauthProvider === provider && user.oauthId === profile.id) {
                return user;
            }
        }

        // Create new user
        const id = uuidv4();
        const createdAt = new Date().toISOString();
        
        const user = {
            id,
            email: profile.email.toLowerCase(),
            passwordHash: null,
            displayName: profile.displayName || profile.email.split('@')[0],
            createdAt,
            lastLogin: null,
            mfaEnabled: false,
            mfaSecret: null,
            mfaBackupCodes: null,
            oauthProvider: provider,
            oauthId: profile.id,
            profileImage: profile.profileImage || null,
            settings: {},
            failedAttempts: 0,
            lockedUntil: null,
            verified: true,
            verificationToken: null
        };

        users.set(id, user);
        return user;
    },

    /**
     * Update user's last login
     */
    updateLastLogin(id) {
        const user = users.get(id);
        if (user) {
            user.lastLogin = new Date().toISOString();
            users.set(id, user);
        }
    },

    /**
     * Update user password
     */
    async updatePassword(id, newPassword) {
        const user = users.get(id);
        if (user) {
            user.passwordHash = await hashPassword(newPassword);
            user.failedAttempts = 0;
            user.lockedUntil = null;
            users.set(id, user);
        }
    },

    /**
     * Record failed login attempt
     */
    recordFailedAttempt(email) {
        const user = User.findByEmail(email);
        if (!user) return;

        const actualUser = users.get(user.id);
        if (!actualUser) return;

        actualUser.failedAttempts += 1;
        
        if (actualUser.failedAttempts >= CONFIG.MAX_FAILED_ATTEMPTS) {
            const lockoutTime = new Date();
            lockoutTime.setMinutes(lockoutTime.getMinutes() + CONFIG.LOCKOUT_DURATION_MINUTES);
            actualUser.lockedUntil = lockoutTime.toISOString();
        }

        users.set(actualUser.id, actualUser);

        return {
            attempts: actualUser.failedAttempts,
            lockedUntil: actualUser.lockedUntil,
            locked: actualUser.failedAttempts >= CONFIG.MAX_FAILED_ATTEMPTS
        };
    },

    /**
     * Reset failed attempts on successful login
     */
    resetFailedAttempts(id) {
        const user = users.get(id);
        if (user) {
            user.failedAttempts = 0;
            user.lockedUntil = null;
            users.set(id, user);
        }
    },

    /**
     * Check if user is locked out
     */
    isLockedOut(email) {
        const user = User.findByEmail(email);
        if (!user) return false;

        if (user.lockedUntil) {
            const lockoutTime = new Date(user.lockedUntil);
            if (lockoutTime > new Date()) {
                return {
                    locked: true,
                    lockedUntil: user.lockedUntil,
                    remainingSeconds: Math.ceil((lockoutTime - new Date()) / 1000)
                };
            }
            // Lockout expired, reset
            User.resetFailedAttempts(user.id);
        }
        return { locked: false };
    },

    /**
     * Setup MFA for user
     */
    async setupMFA(id) {
        const otplib = require('otplib');
        const secret = otplib.authenticator.generateSecret();
        
        const user = users.get(id);
        if (!user) throw new Error('User not found');

        user.mfaEnabled = true;
        user.mfaSecret = secret;
        
        // Generate backup codes
        const backupCodes = [];
        for (let i = 0; i < 10; i++) {
            backupCodes.push(generateToken(8));
        }
        user.mfaBackupCodes = backupCodes;

        users.set(id, user);

        const otpauth = otplib.authenticator.keyuri(user.email, 'NovaByte Bridge', secret);

        return {
            secret,
            otpauth,
            backupCodes
        };
    },

    /**
     * Verify MFA code
     */
    verifyMFA(id, code) {
        const user = users.get(id);
        if (!user || !user.mfaSecret) {
            return { valid: false, error: 'MFA not configured' };
        }

        const otplib = require('otplib');
        
        // Check TOTP code
        if (otplib.authenticator.verify({ token: code, secret: user.mfaSecret })) {
            return { valid: true };
        }

        // Check backup code
        if (user.mfaBackupCodes) {
            const codeIndex = user.mfaBackupCodes.indexOf(code);
            if (codeIndex !== -1) {
                // Remove used backup code
                user.mfaBackupCodes.splice(codeIndex, 1);
                users.set(id, user);
                return { valid: true, usedBackupCode: true };
            }
        }

        return { valid: false, error: 'Invalid MFA code' };
    },

    /**
     * Disable MFA
     */
    disableMFA(id) {
        const user = users.get(id);
        if (user) {
            user.mfaEnabled = false;
            user.mfaSecret = null;
            user.mfaBackupCodes = null;
            users.set(id, user);
        }
    },

    /**
     * Update user settings
     */
    updateSettings(id, settings) {
        const user = users.get(id);
        if (user) {
            user.settings = { ...user.settings, ...settings };
            users.set(id, user);
        }
    }
};

/**
 * Session operations
 */
const Session = {
    /**
     * Create a new session
     */
    create({ userId, deviceInfo, ipAddress, userAgent, refreshToken }) {
        const id = uuidv4();
        const token = generateToken(64);
        const createdAt = new Date();
        const expiresAt = new Date(createdAt.getTime() + CONFIG.SESSION_EXPIRY_HOURS * 60 * 60 * 1000);

        const session = {
            id,
            userId,
            token,
            refreshToken: refreshToken || null,
            deviceInfo: deviceInfo || null,
            ipAddress: ipAddress || null,
            userAgent: userAgent || null,
            createdAt: createdAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            lastActivity: createdAt.toISOString()
        };

        sessions.set(id, session);

        return {
            id,
            userId,
            token,
            refreshToken,
            expiresAt: expiresAt.toISOString()
        };
    },

    /**
     * Validate session token
     */
    validate(token) {
        for (const [id, session] of sessions) {
            if (session.token === token) {
                const expiresAt = new Date(session.expiresAt);
                if (expiresAt < new Date()) {
                    // Session expired, clean up
                    sessions.delete(id);
                    return { valid: false, error: 'Session expired' };
                }

                // Update last activity
                session.lastActivity = new Date().toISOString();
                sessions.set(id, session);

                // Get user info
                const user = User.findById(session.userId);
                if (!user) {
                    return { valid: false, error: 'User not found' };
                }

                return {
                    valid: true,
                    session,
                    user,
                    refreshToken: session.refreshToken
                };
            }
        }
        
        return { valid: false, error: 'Session not found' };
    },

    /**
     * Refresh session (extend expiry)
     */
    refresh(token) {
        for (const [id, session] of sessions) {
            if (session.token === token) {
                const newExpiresAt = new Date();
                newExpiresAt.setHours(newExpiresAt.getHours() + CONFIG.SESSION_EXPIRY_HOURS);
                
                session.expiresAt = newExpiresAt.toISOString();
                session.lastActivity = newExpiresAt.toISOString();
                sessions.set(id, session);

                return session;
            }
        }
        
        return null;
    },

    /**
     * Delete session
     */
    delete(sessionId) {
        sessions.delete(sessionId);
    },

    /**
     * Delete session by token
     */
    deleteByToken(token) {
        for (const [id, session] of sessions) {
            if (session.token === token) {
                sessions.delete(id);
                break;
            }
        }
    },

    /**
     * Delete all user sessions (except current)
     */
    deleteAllUserSessions(userId, exceptToken = null) {
        for (const [id, session] of sessions) {
            if (session.userId === userId && session.token !== exceptToken) {
                sessions.delete(id);
            }
        }
    },

    /**
     * Get all user sessions
     */
    getUserSessions(userId) {
        const result = [];
        for (const [id, session] of sessions) {
            if (session.userId === userId) {
                const { token, refreshToken, ...safeSession } = session;
                result.push(safeSession);
            }
        }
        return result;
    },

    /**
     * Clean up expired sessions
     */
    cleanup() {
        const now = new Date();
        let cleaned = 0;
        
        for (const [id, session] of sessions) {
            if (new Date(session.expiresAt) < now) {
                sessions.delete(id);
                cleaned++;
            }
        }
        
        console.log(`[Auth] Cleaned up ${cleaned} expired sessions`);
    }
};

/**
 * OAuth Token management
 */
const OAuthTokens = {
    /**
     * Store OAuth tokens
     */
    store({ userId, provider, accessToken, refreshToken, expiresAt, scope }) {
        const id = uuidv4();
        const now = new Date().toISOString();

        // Encrypt tokens at rest
        const encryptedAccessToken = encryptToken(accessToken);
        const encryptedRefreshToken = refreshToken ? encryptToken(refreshToken) : null;

        // Delete existing tokens for this provider
        for (const [key, token] of oauthTokens) {
            if (token.userId === userId && token.provider === provider) {
                oauthTokens.delete(key);
            }
        }

        const tokenRecord = {
            id,
            userId,
            provider,
            accessToken: encryptedAccessToken,
            refreshToken: encryptedRefreshToken,
            expiresAt,
            scope,
            createdAt: now,
            updatedAt: now
        };

        oauthTokens.set(id, tokenRecord);

        return id;
    },

    /**
     * Get OAuth tokens
     */
    get(userId, provider) {
        for (const [id, token] of oauthTokens) {
            if (token.userId === userId && token.provider === provider) {
                // Decrypt tokens
                return {
                    ...token,
                    accessToken: decryptToken(token.accessToken),
                    refreshToken: token.refreshToken ? decryptToken(token.refreshToken) : null
                };
            }
        }
        return null;
    },

    /**
     * Delete OAuth tokens
     */
    delete(userId, provider) {
        for (const [id, token] of oauthTokens) {
            if (token.userId === userId && token.provider === provider) {
                oauthTokens.delete(id);
                break;
            }
        }
    }
};

/**
 * App-specific passwords
 */
const AppPassword = {
    /**
     * Create app password
     */
    async create({ userId, name }) {
        const id = uuidv4();
        const password = generateToken(16);
        const passwordHash = await hashPassword(password);
        const createdAt = new Date().toISOString();

        const appPassword = {
            id,
            userId,
            name,
            passwordHash,
            lastUsed: null,
            createdAt
        };

        appPasswords.set(id, appPassword);

        return { id, name, password, createdAt };
    },

    /**
     * Verify app password
     */
    async verify(userId, password) {
        for (const [id, appPassword] of appPasswords) {
            if (appPassword.userId === userId) {
                const valid = await verifyPassword(password, appPassword.passwordHash);
                if (valid) {
                    // Update last used
                    appPassword.lastUsed = new Date().toISOString();
                    appPasswords.set(id, appPassword);
                    return { valid: true, appPasswordId: appPassword.id };
                }
            }
        }

        return { valid: false };
    },

    /**
     * List app passwords
     */
    list(userId) {
        const result = [];
        for (const [id, appPassword] of appPasswords) {
            if (appPassword.userId === userId) {
                const { passwordHash, ...safePassword } = appPassword;
                result.push(safePassword);
            }
        }
        return result;
    },

    /**
     * Delete app password
     */
    delete(id, userId) {
        const appPassword = appPasswords.get(id);
        if (appPassword && appPassword.userId === userId) {
            appPasswords.delete(id);
        }
    }
};

/**
 * Authentication service main functions
 */
const AuthService = {
    /**
     * Register a new user
     */
    async register({ email, password, displayName }) {
        // Validate password
        if (password && password.length < CONFIG.PASSWORD_MIN_LENGTH) {
            throw new Error(`Password must be at least ${CONFIG.PASSWORD_MIN_LENGTH} characters`);
        }

        const user = await User.create({ email, password, displayName });

        return {
            user: User.findById(user.id),
            message: 'Registration successful'
        };
    },

    /**
     * Login with email/password
     */
    async login({ email, password, deviceInfo, ipAddress, userAgent, mfaCode }) {
        // Check if account is locked out
        const lockStatus = User.isLockedOut(email);
        if (lockStatus.locked) {
            throw new Error(`Account locked. Try again in ${lockStatus.remainingSeconds} seconds`);
        }

        const user = User.findByEmail(email);
        if (!user) {
            throw new Error('Invalid email or password');
        }

        // Verify password
        if (!user.passwordHash) {
            throw new Error('Please login with OAuth provider');
        }

        const actualUser = users.get(user.id);
        const passwordValid = await verifyPassword(password, actualUser.passwordHash);
        
        if (!passwordValid) {
            const attemptResult = User.recordFailedAttempt(email);
            if (attemptResult.locked) {
                throw new Error('Too many failed attempts. Account locked for 15 minutes');
            }
            throw new Error('Invalid email or password');
        }

        // Check if MFA is enabled
        if (actualUser.mfaEnabled) {
            if (!mfaCode) {
                return {
                    mfaRequired: true,
                    message: 'MFA code required'
                };
            }

            const mfaResult = User.verifyMFA(user.id, mfaCode);
            if (!mfaResult.valid) {
                throw new Error(mfaResult.error || 'Invalid MFA code');
            }
        }

        // Reset failed attempts and update last login
        User.resetFailedAttempts(user.id);
        User.updateLastLogin(user.id);

        // Create session
        const session = Session.create({ userId: user.id, deviceInfo, ipAddress, userAgent });

        const userData = User.findById(user.id);
        
        return {
            user: userData,
            session,
            message: 'Login successful'
        };
    },

    /**
     * Login with app password
     */
    async loginWithAppPassword({ email, password, deviceInfo, ipAddress, userAgent }) {
        const user = User.findByEmail(email);
        if (!user) {
            throw new Error('Invalid email or password');
        }

        const result = await AppPassword.verify(user.id, password);
        if (!result.valid) {
            throw new Error('Invalid app password');
        }

        User.updateLastLogin(user.id);
        const session = Session.create({ userId: user.id, deviceInfo, ipAddress, userAgent });

        return {
            user: User.findById(user.id),
            session,
            message: 'Login successful'
        };
    },

    /**
     * OAuth login/registration
     */
    async oauthLogin({ provider, profile, deviceInfo, ipAddress, userAgent }) {
        let user = User.findOrCreateOAuth(provider, profile);

        User.updateLastLogin(user.id);

        const session = Session.create({ 
            userId: user.id, 
            deviceInfo, 
            ipAddress, 
            userAgent,
            refreshToken: profile.refreshToken
        });

        return {
            user: User.findById(user.id),
            session,
            isNewUser: !user.lastLogin
        };
    },

    /**
     * Logout
     */
    logout(token) {
        if (token) {
            Session.deleteByToken(token);
        }
        return { message: 'Logged out successfully' };
    },

    /**
     * Validate session
     */
    validateSession(token) {
        return Session.validate(token);
    },

    /**
     * Refresh session
     */
    refreshSession(token) {
        const session = Session.refresh(token);
        if (!session) {
            throw new Error('Invalid session');
        }
        return { session };
    },

    /**
     * Change password
     */
    async changePassword(userId, currentPassword, newPassword) {
        const user = User.findById(userId);
        
        if (!user || !users.get(userId)?.passwordHash) {
            throw new Error('No password set');
        }

        const actualUser = users.get(userId);
        
        // Verify current password
        const valid = await verifyPassword(currentPassword, actualUser.passwordHash);
        if (!valid) {
            throw new Error('Current password is incorrect');
        }

        // Validate new password
        if (newPassword.length < CONFIG.PASSWORD_MIN_LENGTH) {
            throw new Error(`Password must be at least ${CONFIG.PASSWORD_MIN_LENGTH} characters`);
        }

        await User.updatePassword(userId, newPassword);

        // Invalidate all other sessions for security
        Session.deleteAllUserSessions(userId);

        return { message: 'Password changed successfully' };
    },

    /**
     * Get user sessions
     */
    getSessions(userId) {
        return Session.getUserSessions(userId);
    },

    /**
     * Revoke session
     */
    revokeSession(userId, sessionId) {
        const session = sessions.get(sessionId);
        if (session && session.userId === userId) {
            Session.delete(sessionId);
        }
        return { message: 'Session revoked' };
    },

    /**
     * Revoke all sessions
     */
    revokeAllSessions(userId) {
        Session.deleteAllUserSessions(userId);
        return { message: 'All sessions revoked' };
    }
};

// Run session cleanup every hour
setInterval(() => {
    Session.cleanup();
}, 60 * 60 * 1000);

// Initial cleanup
Session.cleanup();

console.log('[Auth] Service initialized with in-memory storage');

module.exports = {
    User,
    Session,
    OAuthTokens,
    AppPassword,
    AuthService,
    CONFIG
};
