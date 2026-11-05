/**
 * NovaSentinel Response - Emergency Lockdown
 * 
 * This module implements emergency lockdown mode to restrict all operations
 * during security incidents. Provides multiple lockdown levels with automatic
 * trigger detection.
 * 
 * SECURITY REQUIREMENTS:
 * - Call auditService.logEvent() for all lockdown events
 * - Use Map to track lockdown state
 * - Support auto-lockdown triggers (failed auths, integrity failure, breach)
 * - Require admin token to lift lockdown
 * 
 * @module sentinel/response/lockdown
 */

'use strict';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Lockdown levels */
const LOCKDOWN_LEVELS = {
    NONE: 0,
    AUTH_ONLY: 1,
    READ_ONLY: 2,
    NO_ACCESS: 3
};

/** Auto-lockdown trigger thresholds */
const AUTO_LOCKDOWN_THRESHOLDS = {
    FAILED_AUTH_COUNT: 50,
    FAILED_AUTH_WINDOW_MS: 5 * 60 * 1000, // 5 minutes
    INTEGRITY_FAILURE: 'integrity_failure',
    BREACH_DETECTED: 'breach_detected'
};

/** Admin token for lifting lockdown - should be configured via environment */
const DEFAULT_ADMIN_TOKEN = 'nova-sentinel-lockdown-admin-token-2024';

/** Path to admin token configuration */
const ADMIN_TOKEN_FILE = require('path').join(__dirname, '..', '..', 'data', 'lockdown-admin.json');

// =============================================================================
// STATE
// =============================================================================

/** Current lockdown state - Map<key, value> */
const lockdownState = new Map();

/** Failed authentication attempts tracker - Map<ip, timestamp[]> */
const failedAuthAttempts = new Map();

/** Auto-lockdown trigger listeners */
const autoLockdownTriggers = new Map();

/** Socket.io instance for broadcasting */
let io = null;

// Initialize lockdown state
lockdownState.set('active', false);
lockdownState.set('level', LOCKDOWN_LEVELS.NONE);
lockdownState.set('reason', null);
lockdownState.set('startTime', null);
lockdownState.set('initiatedBy', null);

// =============================================================================
// SOCKET.IO INTEGRATION
// =============================================================================

/**
 * Set the Socket.io instance for broadcasting lockdown events.
 * Called by server.js after io is initialised.
 * 
 * @param {object} socketIO - Socket.io instance
 */
function setSocketIO(socketIO) {
    io = socketIO;
    console.log('[Lockdown] Socket.io instance set');
}

/**
 * Broadcast lockdown event to all connected clients.
 * 
 * @param {string} event - Event type
 * @param {object} data - Event data
 */
function broadcastLockdownEvent(event, data) {
    if (io) {
        io.emit('lockdown:event', {
            type: event,
            data: data,
            timestamp: Date.now()
        });
    }
}

// =============================================================================
// AUDIT LOGGING
// =============================================================================

/**
 * Log security event to audit service.
 * 
 * @param {string} action - Action type
 * @param {object} data - Event data
 */
function logAuditEvent(action, data) {
    try {
        // eslint-disable-next-line no-undef
        if (typeof auditService !== 'undefined' && auditService && typeof auditService.logEvent === 'function') {
            // eslint-disable-next-line no-undef
            auditService.logEvent({
                action: action,
                severity: 'critical',
                ...data
            });
        }
    } catch (e) {
        console.error('[Lockdown] Audit log error:', e.message);
    }
}

// =============================================================================
// ADMIN TOKEN MANAGEMENT
// =============================================================================

/**
 * Get the configured admin token.
 * Reads from file if available, otherwise uses default.
 * 
 * @returns {string} Admin token
 */
function getAdminToken() {
    const fs = require('fs');
    try {
        if (fs.existsSync(ADMIN_TOKEN_FILE)) {
            const data = JSON.parse(fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8'));
            return data.adminToken || DEFAULT_ADMIN_TOKEN;
        }
    } catch (e) {
        console.warn('[Lockdown] Could not load admin token file, using default');
    }
    return DEFAULT_ADMIN_TOKEN;
}

/**
 * Set a new admin token.
 * 
 * @param {string} newToken - New admin token
 * @returns {boolean} Success
 */
function setAdminToken(newToken) {
    if (!newToken || typeof newToken !== 'string' || newToken.length < 16) {
        return false;
    }
    
    const fs = require('fs');
    const dataDir = require('path').dirname(ADMIN_TOKEN_FILE);
    
    try {
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        fs.writeFileSync(ADMIN_TOKEN_FILE, JSON.stringify({ adminToken: newToken }));
        return true;
    } catch (e) {
        console.error('[Lockdown] Failed to save admin token:', e.message);
        return false;
    }
}

// =============================================================================
// LOCKDOWN INITIATION
// =============================================================================

/**
 * Initiate emergency lockdown.
 * 
 * @param {string} reason - Reason for lockdown
 * @param {number} level - Lockdown level (1=auth-only, 2=read-only, 3=no-access)
 * @param {string} [initiatedBy] - Who/what initiated the lockdown
 * @returns {object} Result with success status and details
 */
function initiateLockdown(reason, level, initiatedBy) {
    // Validate level
    const validLevels = [LOCKDOWN_LEVELS.AUTH_ONLY, LOCKDOWN_LEVELS.READ_ONLY, LOCKDOWN_LEVELS.NO_ACCESS];
    if (!level || !validLevels.includes(level)) {
        return {
            success: false,
            error: 'Invalid lockdown level. Must be 1 (auth-only), 2 (read-only), or 3 (no-access)'
        };
    }
    
    // If already in lockdown, escalate if level is higher
    const currentLevel = lockdownState.get('level');
    if (lockdownState.get('active') && level <= currentLevel) {
        return {
            success: false,
            error: 'Lockdown already active at same or higher level',
            currentLevel: currentLevel
        };
    }
    
    // Set lockdown state
    lockdownState.set('active', true);
    lockdownState.set('level', level);
    lockdownState.set('reason', reason || 'Unspecified security incident');
    lockdownState.set('startTime', Date.now());
    lockdownState.set('initiatedBy', initiatedBy || 'system');
    
    // Log to audit
    logAuditEvent('LOCKDOWN_INITIATED', {
        level: level,
        reason: reason,
        initiatedBy: initiatedBy,
        timestamp: Date.now()
    });
    
    // Broadcast to clients
    broadcastLockdownEvent('lockdown_started', {
        level: level,
        reason: reason,
        startTime: lockdownState.get('startTime')
    });
    
    console.log(`[Lockdown] INITIATED - Level ${level}: ${reason}`);
    
    return {
        success: true,
        level: level,
        reason: reason,
        startTime: lockdownState.get('startTime')
    };
}

// =============================================================================
// LOCKDOWN LIFTING
// =============================================================================

/**
 * Lift emergency lockdown.
 * Requires valid admin token.
 * 
 * @param {string} adminToken - Admin token to authorize lifting
 * @param {string} [reason] - Reason for lifting
 * @returns {object} Result with success status
 */
function liftLockdown(adminToken, reason) {
    // Verify admin token
    if (!adminToken || adminToken !== getAdminToken()) {
        // Log failed attempt
        logAuditEvent('LOCKDOWN_LIFT_FAILED', {
            reason: 'Invalid admin token',
            attemptedBy: reason || 'unknown'
        });
        
        return {
            success: false,
            error: 'Invalid admin token'
        };
    }
    
    // Check if lockdown is active
    if (!lockdownState.get('active')) {
        return {
            success: false,
            error: 'No lockdown is currently active'
        };
    }
    
    const previousLevel = lockdownState.get('level');
    const previousReason = lockdownState.get('reason');
    const duration = Date.now() - lockdownState.get('startTime');
    
    // Clear lockdown state
    lockdownState.set('active', false);
    lockdownState.set('level', LOCKDOWN_LEVELS.NONE);
    lockdownState.set('reason', null);
    lockdownState.set('startTime', null);
    lockdownState.set('initiatedBy', null);
    
    // Log to audit
    logAuditEvent('LOCKDOWN_LIFTED', {
        previousLevel: previousLevel,
        previousReason: previousReason,
        duration: duration,
        liftedBy: reason || 'administrator'
    });
    
    // Broadcast to clients
    broadcastLockdownEvent('lockdown_lifted', {
        previousLevel: previousLevel,
        duration: duration
    });
    
    console.log(`[Lockdown] LIFTED - Was level ${previousLevel} for ${duration}ms`);
    
    return {
        success: true,
        previousLevel: previousLevel,
        duration: duration
    };
}

// =============================================================================
// LOCKDOWN STATUS
// =============================================================================

/**
 * Get current lockdown status.
 * 
 * @returns {object} Current lockdown status
 */
function getLockdownStatus() {
    const active = lockdownState.get('active');
    const level = lockdownState.get('level');
    
    return {
        active: active,
        level: active ? level : 0,
        levelName: active ? getLevelName(level) : 'none',
        reason: lockdownState.get('reason'),
        startTime: lockdownState.get('startTime'),
        initiatedBy: lockdownState.get('initiatedBy'),
        duration: active ? Date.now() - lockdownState.get('startTime') : 0
    };
}

/**
 * Get human-readable lockdown level name.
 * 
 * @param {number} level - Lockdown level
 * @returns {string} Level name
 */
function getLevelName(level) {
    switch (level) {
        case LOCKDOWN_LEVELS.AUTH_ONLY:
            return 'auth-only';
        case LOCKDOWN_LEVELS.READ_ONLY:
            return 'read-only';
        case LOCKDOWN_LEVELS.NO_ACCESS:
            return 'no-access';
        default:
            return 'none';
    }
}

// =============================================================================
// AUTO-LOCKDOWN TRIGGERS
// =============================================================================

/**
 * Record a failed authentication attempt.
 * Triggers auto-lockdown if threshold exceeded.
 * 
 * @param {string} ip - Client IP address
 */
function recordFailedAuth(ip) {
    const now = Date.now();
    const attempts = failedAuthAttempts.get(ip) || [];
    
    // Add current attempt
    attempts.push(now);
    
    // Clean old attempts outside the window
    const cutoff = now - AUTO_LOCKDOWN_THRESHOLDS.FAILED_AUTH_WINDOW_MS;
    const recentAttempts = attempts.filter(t => t > cutoff);
    
    // Store back
    failedAuthAttempts.set(ip, recentAttempts);
    
    // Check if threshold exceeded
    const totalRecentAttempts = Array.from(failedAuthAttempts.values())
        .flat()
        .filter(t => t > cutoff).length;
    
    if (totalRecentAttempts >= AUTO_LOCKDOWN_THRESHOLDS.FAILED_AUTH_COUNT) {
        // Trigger auto-lockdown
        triggerAutoLockdown(AUTO_LOCKDOWN_THRESHOLDS.BREACH_DETECTED, {
            trigger: 'failed_auth_threshold',
            attempts: totalRecentAttempts,
            windowMs: AUTO_LOCKDOWN_THRESHOLDS.FAILED_AUTH_WINDOW_MS
        });
    }
}

/**
 * Trigger auto-lockdown from system events.
 * 
 * @param {string} triggerType - Type of trigger (integrity_failure, breach_detected)
 * @param {object} triggerData - Additional trigger data
 */
function triggerAutoLockdown(triggerType, triggerData) {
    // Determine lockdown level based on trigger
    let level = LOCKDOWN_LEVELS.READ_ONLY;
    let reason = triggerType;
    
    if (triggerType === AUTO_LOCKDOWN_THRESHOLDS.BREACH_DETECTED) {
        level = LOCKDOWN_LEVELS.NO_ACCESS;
    } else if (triggerType === AUTO_LOCKDOWN_THRESHOLDS.INTEGRITY_FAILURE) {
        level = LOCKDOWN_LEVELS.NO_ACCESS;
    }
    
    // Only trigger if not already at this level or higher
    const currentLevel = lockdownState.get('level');
    if (lockdownState.get('active') && level <= currentLevel) {
        return;
    }
    
    initiateLockdown(
        `${triggerType}: ${JSON.stringify(triggerData)}`,
        level,
        'auto-trigger'
    );
    
    // Notify registered triggers
    const callbacks = autoLockdownTriggers.get(triggerType);
    if (callbacks) {
        callbacks.forEach(cb => {
            try {
                cb(triggerType, triggerData);
            } catch (e) {
                console.error('[Lockdown] Trigger callback error:', e.message);
            }
        });
    }
}

/**
 * Register a callback for auto-lockdown triggers.
 * 
 * @param {string} triggerType - Trigger type to listen for
 * @param {function} callback - Callback function
 */
function onAutoLockdownTrigger(triggerType, callback) {
    const callbacks = autoLockdownTriggers.get(triggerType) || [];
    callbacks.push(callback);
    autoLockdownTriggers.set(triggerType, callbacks);
}

// =============================================================================
// LOCKDOWN MIDDLEWARE
// =============================================================================

/**
 * Create Express middleware to enforce lockdown rules.
 * 
 * @returns {function} Express middleware
 */
function lockdownMiddleware() {
    return function(req, res, next) {
        // If no lockdown, allow through
        if (!lockdownState.get('active')) {
            return next();
        }
        
        const level = lockdownState.get('level');
        const path = req.path || req.url || '';
        const method = (req.method || '').toUpperCase();
        
        // Level 3: No access - return 503 for everything
        if (level === LOCKDOWN_LEVELS.NO_ACCESS) {
            logAuditEvent('LOCKDOWN_ACCESS_DENIED', {
                path: path,
                method: method,
                ip: req.ip || req.connection?.remoteAddress || 'unknown',
                level: level
            });
            
            return res.status(503).json({
                error: 'Service Unavailable',
                message: 'System is in emergency lockdown',
                lockdownLevel: level,
                retryAfter: 60
            });
        }
        
        // Level 2: Read-only - allow GET, deny writes
        if (level === LOCKDOWN_LEVELS.READ_ONLY) {
            const writeMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
            
            if (writeMethods.includes(method)) {
                logAuditEvent('LOCKDOWN_WRITE_DENIED', {
                    path: path,
                    method: method,
                    ip: req.ip || req.connection?.remoteAddress || 'unknown'
                });
                
                return res.status(503).json({
                    error: 'Service Unavailable',
                    message: 'Write operations disabled during lockdown',
                    lockdownLevel: level,
                    allowedMethods: ['GET', 'HEAD', 'OPTIONS']
                });
            }
            
            return next();
        }
        
        // Level 1: Auth-only - only allow /api/auth/* routes
        if (level === LOCKDOWN_LEVELS.AUTH_ONLY) {
            const isAuthRoute = path.startsWith('/api/auth/') || path === '/api/auth';
            
            if (!isAuthRoute) {
                logAuditEvent('LOCKDOWN_NON_AUTH_DENIED', {
                    path: path,
                    method: method,
                    ip: req.ip || req.connection?.remoteAddress || 'unknown'
                });
                
                return res.status(503).json({
                    error: 'Service Unavailable',
                    message: 'Only authentication endpoints available during lockdown',
                    lockdownLevel: level,
                    allowedPaths: ['/api/auth/*']
                });
            }
            
            return next();
        }
        
        // Unknown level - default deny
        return next();
    };
}

// =============================================================================
// STATUS
// =============================================================================

/**
 * Get module status for health checks.
 * 
 * @returns {object} Status object
 */
function getStatus() {
    const status = getLockdownStatus();
    return {
        active: true,
        healthy: true,
        details: {
            lockdownActive: status.active,
            lockdownLevel: status.level,
            lockdownLevelName: status.levelName,
            lockdownReason: status.reason,
            lockdownDuration: status.duration,
            failedAuthAttemptsWindow: AUTO_LOCKDOWN_THRESHOLDS.FAILED_AUTH_WINDOW_MS,
            failedAuthThreshold: AUTO_LOCKDOWN_THRESHOLDS.FAILED_AUTH_COUNT
        }
    };
}

// =============================================================================
// MODULE EXPORTS
// =============================================================================

module.exports = {
    initiateLockdown,
    liftLockdown,
    getLockdownStatus,
    lockdownMiddleware,
    getStatus,
    setSocketIO,
    recordFailedAuth,
    triggerAutoLockdown,
    onAutoLockdownTrigger,
    setAdminToken,
    
    // Constants for external use
    LOCKDOWN_LEVELS: LOCKDOWN_LEVELS,
    AUTO_LOCKDOWN_THRESHOLDS: AUTO_LOCKDOWN_THRESHOLDS
};
