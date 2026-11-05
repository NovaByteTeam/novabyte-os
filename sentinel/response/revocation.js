/**
 * NovaSentinel Response - Token/Session Revocation
 * 
 * This module provides instant token/session revocation with blacklist management.
 * Implements O(1) lookup via Set for fast revocation checks.
 * Persists blacklist to JSON file for crash/restart resilience.
 * 
 * SECURITY REQUIREMENTS:
 * - Broadcast revocation events via Socket.io to force client logout
 * - Call auditService.logEvent() for security events
 * - Use Set for O(1) revocation lookup
 * - Track expiry times for automatic cleanup
 * - Auto-expire entries older than max session lifetime
 * - Persist blacklist to file for crash resilience
 * 
 * @module sentinel/response/revocation
 */

'use strict';

const fs = require('fs');
const path = require('path');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default maximum session lifetime in milliseconds (24 hours) */
const DEFAULT_MAX_SESSION_LIFETIME = 24 * 60 * 60 * 1000;

/** Cleanup interval in milliseconds (5 minutes) */
const CLEANUP_INTERVAL = 5 * 60 * 1000;

/** Path to blacklist persistence file */
const BLACKLIST_FILE = path.join(__dirname, '..', '..', 'data', 'revocation-blacklist.json');

// =============================================================================
// STATE
// =============================================================================

/** Token blacklist - Set for O(1) lookup */
const tokenBlacklist = new Set();

/** Map of token to expiry time */
const tokenExpiry = new Map();

/** Map of userId to set of tokens (for bulk revocation) */
const userTokens = new Map();

/** Session blacklist - Map<sessionId, expiryTime> */
const sessionBlacklist = new Map();

/** Current Socket.io instance */
let io = null;

/** Maximum session lifetime */
let maxSessionLifetime = DEFAULT_MAX_SESSION_LIFETIME;

/** Cleanup timer */
let cleanupTimer = null;

/** Debounce timer for file persistence */
let persistDebounceTimer = null;

// =============================================================================
// SOCKET.IO INTEGRATION
// =============================================================================

/**
 * Set the Socket.io instance for broadcasting revocation events.
 * Called by server.js after io is initialised.
 * 
 * @param {object} socketIO - Socket.io instance
 */
function setSocketIO(socketIO) {
    io = socketIO;
    console.log('[Revocation] Socket.io instance set');
}

/**
 * Broadcast revocation event to force client logout.
 * 
 * @param {string} userId - User ID whose session was revoked
 * @param {string} reason - Reason for revocation
 */
function broadcastRevocation(userId, reason) {
    if (io) {
        // Emit to specific user's room if they have one
        io.to(`user:${userId}`).emit('session:revoked', {
            reason: reason || 'Session revoked by administrator',
            timestamp: Date.now()
        });
        
        // Also broadcast globally for any connected clients
        io.emit('token:revoked', {
            userId: userId,
            reason: reason || 'Token has been revoked',
            timestamp: Date.now()
        });
    }
}

// =============================================================================
// PERSISTENCE
// =============================================================================

/**
 * Ensure data directory exists.
 */
function ensureDataDirectory() {
    const dataDir = path.dirname(BLACKLIST_FILE);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
}

/**
 * Save blacklist to file (debounced).
 */
function persistBlacklist() {
    if (persistDebounceTimer) {
        clearTimeout(persistDebounceTimer);
    }
    
    persistDebounceTimer = setTimeout(() => {
        try {
            ensureDataDirectory();
            
            const data = {
                version: 1,
                savedAt: new Date().toISOString(),
                tokens: {},
                sessions: {}
            };
            
            // Save token expiry data (only non-expired)
            const now = Date.now();
            for (const [token, expiry] of tokenExpiry.entries()) {
                if (expiry > now) {
                    data.tokens[token] = expiry;
                }
            }
            
            // Save session expiry data (only non-expired)
            for (const [sessionId, expiry] of sessionBlacklist.entries()) {
                if (expiry > now) {
                    data.sessions[sessionId] = expiry;
                }
            }
            
            fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(data, null, 2), 'utf8');
            console.log(`[Revocation] Persisted ${Object.keys(data.tokens).length} tokens and ${Object.keys(data.sessions).length} sessions`);
        } catch (e) {
            console.error('[Revocation] Failed to persist blacklist:', e.message);
        }
    }, 1000); // Debounce 1 second
}

/**
 * Load blacklist from file.
 */
function loadBlacklist() {
    try {
        if (fs.existsSync(BLACKLIST_FILE)) {
            const content = fs.readFileSync(BLACKLIST_FILE, 'utf8');
            const data = JSON.parse(content);
            
            const now = Date.now();
            let tokenCount = 0;
            let sessionCount = 0;
            
            // Load tokens
            if (data.tokens) {
                for (const [token, expiry] of Object.entries(data.tokens)) {
                    if (expiry > now) {
                        tokenBlacklist.add(token);
                        tokenExpiry.set(token, expiry);
                        tokenCount++;
                    }
                }
            }
            
            // Load sessions
            if (data.sessions) {
                for (const [sessionId, expiry] of Object.entries(data.sessions)) {
                    if (expiry > now) {
                        sessionBlacklist.set(sessionId, expiry);
                        sessionCount++;
                    }
                }
            }
            
            console.log(`[Revocation] Loaded ${tokenCount} tokens and ${sessionCount} sessions from blacklist`);
        }
    } catch (e) {
        console.error('[Revocation] Failed to load blacklist:', e.message);
    }
}

// =============================================================================
// AUDIT LOGGING
// =============================================================================

/**
 * Log security event to audit service.
 * 
 * @param {object} event - Event data
 * @param {object} data - Additional data
 */
function logAuditEvent(event, data) {
    try {
        // eslint-disable-next-line no-undef
        if (typeof auditService !== 'undefined' && auditService && typeof auditService.logEvent === 'function') {
            // eslint-disable-next-line no-undef
            auditService.logEvent(event, data);
        }
    } catch (e) {
        console.error('[Revocation] Failed to log audit event:', e.message);
    }
}

// =============================================================================
// TOKEN REVOCATION
// =============================================================================

/**
 * Revoke a token immediately by adding it to the blacklist.
 * 
 * @param {string} token - The token to revoke
 * @param {string} [userId] - Optional user ID for audit logging
 * @param {string} [reason] - Optional reason for revocation
 * @returns {boolean} True if token was added to blacklist
 */
function revokeToken(token, userId, reason) {
    if (!token || typeof token !== 'string') {
        return false;
    }
    
    const now = Date.now();
    const expiryTime = now + maxSessionLifetime;
    
    // Add to blacklist
    tokenBlacklist.add(token);
    tokenExpiry.set(token, expiryTime);
    
    // Track user tokens if userId provided
    if (userId) {
        if (!userTokens.has(userId)) {
            userTokens.set(userId, new Set());
        }
        userTokens.get(userId).add(token);
    }
    
    // Log audit event
    logAuditEvent({
        action: 'TOKEN_REVOKED',
        severity: 'warning',
        resource: 'token',
        timestamp: new Date().toISOString()
    }, {
        userId: userId || 'unknown',
        reason: reason || 'Manual revocation',
        tokenPrefix: token.substring(0, 8) + '...'
    });
    
    // Broadcast revocation event
    if (userId) {
        broadcastRevocation(userId, reason || 'Token revoked');
    }
    
    // Persist to file
    persistBlacklist();
    
    return true;
}

/**
 * Check if a token has been revoked.
 * Performs O(1) lookup via Set.
 * 
 * @param {string} token - The token to check
 * @returns {boolean} True if token is revoked
 */
function isRevoked(token) {
    if (!token || typeof token !== 'string') {
        return false;
    }
    return tokenBlacklist.has(token);
}

/**
 * Revoke all tokens for a specific user.
 * 
 * @param {string} userId - User ID whose tokens should be revoked
 * @param {string} [reason] - Optional reason for revocation
 * @returns {number} Number of tokens revoked
 */
function revokeAllUserTokens(userId, reason) {
    if (!userId) {
        return 0;
    }
    
    const userTokenSet = userTokens.get(userId);
    if (!userTokenSet || userTokenSet.size === 0) {
        return 0;
    }
    
    const now = Date.now();
    const expiryTime = now + maxSessionLifetime;
    let revokedCount = 0;
    
    // Revoke each token
    for (const token of userTokenSet) {
        tokenBlacklist.add(token);
        tokenExpiry.set(token, expiryTime);
        revokedCount++;
    }
    
    // Log audit event
    logAuditEvent({
        action: 'ALL_USER_TOKENS_REVOKED',
        severity: 'warning',
        resource: 'token',
        timestamp: new Date().toISOString()
    }, {
        userId: userId,
        reason: reason || 'Bulk revocation',
        tokenCount: revokedCount
    });
    
    // Broadcast revocation event
    broadcastRevocation(userId, reason || 'All sessions terminated');
    
    // Persist to file
    persistBlacklist();
    
    return revokedCount;
}

// =============================================================================
// SESSION REVOCATION
// =============================================================================

/**
 * Revoke a specific session by session ID.
 * 
 * @param {string} sessionId - Session ID to revoke
 * @param {string} [userId] - Optional user ID for audit logging
 * @param {string} [reason] - Optional reason for revocation
 * @returns {boolean} True if session was added to blacklist
 */
function revokeSession(sessionId, userId, reason) {
    if (!sessionId || typeof sessionId !== 'string') {
        return false;
    }
    
    const now = Date.now();
    const expiryTime = now + maxSessionLifetime;
    
    // Add to session blacklist
    sessionBlacklist.set(sessionId, expiryTime);
    
    // Also revoke associated user tokens if userId provided
    if (userId) {
        revokeAllUserTokens(userId, reason || 'Session terminated');
    }
    
    // Log audit event
    logAuditEvent({
        action: 'SESSION_REVOKED',
        severity: 'warning',
        resource: 'session',
        timestamp: new Date().toISOString()
    }, {
        userId: userId || 'unknown',
        reason: reason || 'Manual session revocation',
        sessionIdPrefix: sessionId.substring(0, 8) + '...'
    });
    
    // Broadcast revocation event
    if (userId) {
        broadcastRevocation(userId, reason || 'Session terminated');
    }
    
    // Persist to file
    persistBlacklist();
    
    return true;
}

// =============================================================================
// MIDDLEWARE
// =============================================================================

/**
 * Express middleware to check token/session revocation on each request.
 * 
 * @returns {Function} Express middleware function
 */
function checkRevocation() {
    return function(req, res, next) {
        // Skip if no session
        if (!req.session) {
            return next();
        }
        
        // Check session revocation
        if (req.session.id && sessionBlacklist.has(req.session.id)) {
            // Destroy session
            if (req.session.destroy) {
                req.session.destroy();
            }
            
            // Log audit event
            logAuditEvent({
                action: 'REVOKED_SESSION_ACCESS',
                severity: 'error',
                resource: 'session',
                timestamp: new Date().toISOString()
            }, {
                sessionIdPrefix: req.session.id?.substring(0, 8) + '...',
                ip: req.ip || req.connection?.remoteAddress,
                userAgent: req.headers?.['user-agent']
            });
            
            return res.status(401).json({
                error: 'Session has been revoked',
                code: 'SESSION_REVOKED'
            });
        }
        
        // Check token revocation (from Authorization header)
        const authHeader = req.headers?.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            
            if (isRevoked(token)) {
                // Log audit event
                logAuditEvent({
                    action: 'REVOKED_TOKEN_ACCESS',
                    severity: 'error',
                    resource: 'token',
                    timestamp: new Date().toISOString()
                }, {
                    tokenPrefix: token.substring(0, 8) + '...',
                    ip: req.ip || req.connection?.remoteAddress,
                    userAgent: req.headers?.['user-agent']
                });
                
                return res.status(401).json({
                    error: 'Token has been revoked',
                    code: 'TOKEN_REVOKED'
                });
            }
        }
        
        next();
    };
}

// =============================================================================
// CLEANUP
// =============================================================================

/**
 * Clean up expired entries from blacklists.
 * Called periodically to prevent memory leaks.
 */
function cleanupExpiredEntries() {
    const now = Date.now();
    let tokenCleanupCount = 0;
    let sessionCleanupCount = 0;
    
    // Clean up expired tokens
    for (const [token, expiryTime] of tokenExpiry.entries()) {
        if (expiryTime < now) {
            tokenBlacklist.delete(token);
            tokenExpiry.delete(token);
            tokenCleanupCount++;
        }
    }
    
    // Clean up expired sessions
    for (const [sessionId, expiryTime] of sessionBlacklist.entries()) {
        if (expiryTime < now) {
            sessionBlacklist.delete(sessionId);
            sessionCleanupCount++;
        }
    }
    
    if (tokenCleanupCount > 0 || sessionCleanupCount > 0) {
        console.log(`[Revocation] Cleanup: ${tokenCleanupCount} tokens, ${sessionCleanupCount} sessions removed`);
        // Persist after cleanup to remove expired entries
        persistBlacklist();
    }
}

/**
 * Start automatic cleanup timer.
 */
function startCleanupTimer() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
    }
    
    cleanupTimer = setInterval(cleanupExpiredEntries, CLEANUP_INTERVAL);
    console.log('[Revocation] Cleanup timer started');
}

/**
 * Stop automatic cleanup timer.
 */
function stopCleanupTimer() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
}

// =============================================================================
// STATUS
// =============================================================================

/**
 * Get current blacklist size for dashboard.
 * 
 * @returns {number} Current number of revoked tokens
 */
function getRevokedCount() {
    return tokenBlacklist.size;
}

/**
 * Get the current status of the revocation service.
 * 
 * @returns {object} Status object
 */
function getStatus() {
    return {
        active: true,
        healthy: true,
        details: {
            revokedTokens: tokenBlacklist.size,
            revokedSessions: sessionBlacklist.size,
            maxSessionLifetime: maxSessionLifetime,
            cleanupInterval: CLEANUP_INTERVAL
        }
    };
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Set the maximum session lifetime.
 * 
 * @param {number} lifetime - Lifetime in milliseconds
 */
function setMaxSessionLifetime(lifetime) {
    if (typeof lifetime === 'number' && lifetime > 0) {
        maxSessionLifetime = lifetime;
    }
}

/**
 * Get current maximum session lifetime.
 * 
 * @returns {number} Current max session lifetime in milliseconds
 */
function getMaxSessionLifetime() {
    return maxSessionLifetime;
}

// =============================================================================
// INITIALISATION
// =============================================================================

// Load persisted blacklist
loadBlacklist();

// Auto-start cleanup timer
startCleanupTimer();

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    revokeToken,
    revokeAllUserTokens,
    isRevoked,
    checkRevocation,
    revokeSession,
    getRevokedCount,
    getStatus,
    setSocketIO,
    setMaxSessionLifetime,
    getMaxSessionLifetime
};
