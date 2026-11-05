/**
 * NovaSentinel Dual Mode - Personal/Secure Mode Switching
 * 
 * This module manages Personal Mode vs Secure Mode switching for NovaByte OS.
 * Personal Mode: normal operation, standard security
 * Secure Mode: elevated security — stricter CSP, no external requests, full encryption enforced, FIDO2 required
 * 
 * SECURITY REQUIREMENTS:
 * - Call auditService.log() for mode switches
 * - Mode persists in session, resets to Personal on logout
 * - Secure Mode auto-enables after 3 failed auth attempts
 * - Track mode history for each user
 * 
 * @module sentinel/modes/dual-mode
 */

'use strict';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Mode constants */
const MODES = {
    PERSONAL: 'personal',
    SECURE: 'secure'
};

/** Number of failed auth attempts before auto-enabling Secure Mode */
const FAILED_AUTH_THRESHOLD = 3;

/** Mode constraint keys */
const CONSTRAINT_KEYS = {
    CSP: 'csp',
    EXTERNAL_REQUESTS: 'externalRequests',
    ENCRYPTION: 'encryption',
    FIDO2: 'fido2',
    SESSION_TIMEOUT: 'sessionTimeout',
    DATA_EXPORT: 'dataExport'
};

// =============================================================================
// STATE
// =============================================================================

/** Map<userId, { mode, modeStartedAt, failedAuthAttempts }> */
const userModes = new Map();

/** Map<userId, Array<{ mode, switchedAt, reason }>> */
const modeHistory = new Map();

/** Current Socket.io instance for broadcasting mode changes */
let io = null;

/** Audit service reference */
let auditService = null;

// =============================================================================
// MODE CONSTRAINTS
// =============================================================================

/** Mode constraint definitions */
const MODE_CONSTRAINTS = {
    [MODES.PERSONAL]: {
        [CONSTRAINT_KEYS.CSP]: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'none'"]
        },
        [CONSTRAINT_KEYS.EXTERNAL_REQUESTS]: {
            allowed: true,
            blockedDomains: []
        },
        [CONSTRAINT_KEYS.ENCRYPTION]: {
            required: false,
            minAlgorithm: 'AES-256-GCM',
            enforceInTransit: true,
            enforceAtRest: false
        },
        [CONSTRAINT_KEYS.FIDO2]: {
            required: false,
            alternativeAuth: ['password', 'totp']
        },
        [CONSTRAINT_KEYS.SESSION_TIMEOUT]: {
            idleTimeout: 30 * 60 * 1000,
            absoluteTimeout: 24 * 60 * 60 * 1000
        },
        [CONSTRAINT_KEYS.DATA_EXPORT]: {
            allowed: true,
            maxSize: 100 * 1024 * 1024
        }
    },
    [MODES.SECURE]: {
        [CONSTRAINT_KEYS.CSP]: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'none'"],
            upgradeInsecureRequests: true
        },
        [CONSTRAINT_KEYS.EXTERNAL_REQUESTS]: {
            allowed: false,
            blockedDomains: ['*']
        },
        [CONSTRAINT_KEYS.ENCRYPTION]: {
            required: true,
            minAlgorithm: 'AES-256-GCM',
            enforceInTransit: true,
            enforceAtRest: true,
            requireHardwareKey: false
        },
        [CONSTRAINT_KEYS.FIDO2]: {
            required: true,
            alternativeAuth: [],
            attestationLevel: 'direct'
        },
        [CONSTRAINT_KEYS.SESSION_TIMEOUT]: {
            idleTimeout: 5 * 60 * 1000,
            absoluteTimeout: 8 * 60 * 60 * 1000
        },
        [CONSTRAINT_KEYS.DATA_EXPORT]: {
            allowed: false,
            maxSize: 0,
            requireAdminApproval: true
        }
    }
};

// =============================================================================
// AUDIT SERVICE INTEGRATION
// =============================================================================

/**
 * Set the audit service instance.
 * @param {object} audit - Audit service instance
 */
function setAuditService(audit) {
    auditService = audit;
}

/**
 * Log a mode switch event.
 * @param {string} userId - User ID
 * @param {string} fromMode - Previous mode
 * @param {string} toMode - New mode
 * @param {string} reason - Reason for switch
 */
function logModeSwitch(userId, fromMode, toMode, reason) {
    if (auditService && typeof auditService.log === 'function') {
        auditService.log({
            userId,
            action: 'security_event',
            level: toMode === MODES.SECURE ? 'warning' : 'info',
            category: 'mode_switch',
            details: {
                fromMode,
                toMode,
                reason,
                timestamp: new Date().toISOString()
            },
            description: `Mode switched from ${fromMode} to ${toMode}: ${reason}`
        });
    }
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Switch user mode with audit logging.
 * @param {string} userId - User ID
 * @param {string} mode - Target mode ('personal' or 'secure')
 * @param {string} reason - Reason for mode switch
 * @returns {object} Result with success status and mode info
 */
function switchMode(userId, mode, reason) {
    if (!userId) {
        return { success: false, error: 'userId is required' };
    }

    if (mode !== MODES.PERSONAL && mode !== MODES.SECURE) {
        return { success: false, error: `Invalid mode: ${mode}. Must be 'personal' or 'secure'` };
    }

    const fromMode = userModes.get(userId)?.mode || MODES.PERSONAL;
    
    if (fromMode === mode) {
        return { 
            success: true, 
            mode, 
            modeStartedAt: userModes.get(userId)?.modeStartedAt,
            message: `Already in ${mode} mode` 
        };
    }

    const now = Date.now();
    const userModeData = {
        mode,
        modeStartedAt: now,
        failedAuthAttempts: userModes.get(userId)?.failedAuthAttempts || 0
    };

    userModes.set(userId, userModeData);

    // Update mode history
    if (!modeHistory.has(userId)) {
        modeHistory.set(userId, []);
    }
    modeHistory.get(userId).push({
        mode,
        switchedAt: now,
        reason,
        fromMode
    });

    // Log the mode switch
    logModeSwitch(userId, fromMode, mode, reason);

    // Broadcast mode change via Socket.io
    if (io) {
        io.to(`user:${userId}`).emit('modeChanged', {
            mode,
            reason,
            timestamp: new Date().toISOString()
        });
    }

    console.log(`[DualMode] User ${userId} switched from ${fromMode} to ${mode}: ${reason}`);

    return {
        success: true,
        mode,
        modeStartedAt: now,
        previousMode: fromMode,
        message: `Successfully switched to ${mode} mode`
    };
}

/**
 * Get current mode for a user.
 * @param {string} userId - User ID
 * @returns {object} Current mode and time in mode
 */
function getCurrentMode(userId) {
    if (!userId) {
        return { 
            mode: MODES.PERSONAL, 
            timeInMode: 0,
            error: 'userId is required' 
        };
    }

    const userModeData = userModes.get(userId);
    
    if (!userModeData) {
        return {
            mode: MODES.PERSONAL,
            timeInMode: 0,
            isDefault: true
        };
    }

    const timeInMode = Date.now() - userModeData.modeStartedAt;

    return {
        mode: userModeData.mode,
        modeStartedAt: userModeData.modeStartedAt,
        timeInMode,
        failedAuthAttempts: userModeData.failedAuthAttempts,
        constraints: getModeConstraints(userModeData.mode)
    };
}

/**
 * Get mode constraints.
 * @param {string} mode - Mode to get constraints for
 * @returns {object} Mode constraints
 */
function getModeConstraints(mode) {
    if (mode !== MODES.PERSONAL && mode !== MODES.SECURE) {
        return null;
    }
    return MODE_CONSTRAINTS[mode];
}

/**
 * Record a failed authentication attempt.
 * @param {string} userId - User ID
 * @returns {object} Result with whether Secure Mode was auto-enabled
 */
function recordFailedAuth(userId) {
    if (!userId) {
        return { success: false, error: 'userId is required' };
    }

    let userModeData = userModes.get(userId);
    
    if (!userModeData) {
        userModeData = {
            mode: MODES.PERSONAL,
            modeStartedAt: Date.now(),
            failedAuthAttempts: 0
        };
    }

    userModeData.failedAuthAttempts += 1;
    userModes.set(userId, userModeData);

    // Auto-enable Secure Mode after threshold
    if (userModeData.failedAuthAttempts >= FAILED_AUTH_THRESHOLD && 
        userModeData.mode !== MODES.SECURE) {
        
        switchMode(userId, MODES.SECURE, `Auto-enabled after ${FAILED_AUTH_THRESHOLD} failed auth attempts`);
        
        return {
            success: true,
            secureModeEnabled: true,
            failedAttempts: userModeData.failedAuthAttempts,
            message: `Secure Mode auto-enabled after ${userModeData.failedAuthAttempts} failed attempts`
        };
    }

    return {
        success: true,
        secureModeEnabled: false,
        failedAttempts: userModeData.failedAuthAttempts,
        attemptsRemaining: FAILED_AUTH_THRESHOLD - userModeData.failedAuthAttempts
    };
}

/**
 * Reset failed auth attempts on successful login.
 * @param {string} userId - User ID
 */
function resetFailedAuthAttempts(userId) {
    if (!userId) {
        return;
    }

    const userModeData = userModes.get(userId);
    if (userModeData) {
        userModeData.failedAuthAttempts = 0;
        userModes.set(userId, userModeData);
    }
}

/**
 * Reset mode to Personal on logout.
 * @param {string} userId - User ID
 */
function resetModeOnLogout(userId) {
    if (!userId) {
        return { success: false, error: 'userId is required' };
    }

    const userModeData = userModes.get(userId);
    const currentMode = userModeData?.mode || MODES.PERSONAL;

    if (currentMode !== MODES.PERSONAL) {
        switchMode(userId, MODES.PERSONAL, 'User logged out');
    }

    // Clear failed auth attempts on logout
    resetFailedAuthAttempts(userId);

    return {
        success: true,
        message: 'Mode reset to Personal on logout'
    };
}

/**
 * Get mode history for a user.
 * @param {string} userId - User ID
 * @returns {Array} Mode history
 */
function getModeHistory(userId) {
    if (!userId) {
        return [];
    }
    return modeHistory.get(userId) || [];
}

// =============================================================================
// MIDDLEWARE
// =============================================================================

/**
 * Middleware to enforce mode constraints on requests.
 * @returns {Function} Express middleware
 */
function enforceMode() {
    return function(req, res, next) {
        const userId = req.session?.userId;
        
        if (!userId) {
            return next();
        }

        const { mode, constraints } = getCurrentMode(userId);

        // Attach mode info to request
        req.securityMode = {
            mode,
            constraints,
            isSecure: mode === MODES.SECURE
        };

        // Check Secure Mode specific restrictions
        if (mode === MODES.SECURE) {
            // Check external requests
            if (constraints[CONSTRAINT_KEYS.EXTERNAL_REQUESTS]?.allowed === false) {
                const externalDomains = ['api.external.com', 'thirdparty.com', 'cdn.jsdelivr.net'];
                const url = req.url || '';
                
                for (const domain of externalDomains) {
                    if (url.includes(domain)) {
                        console.log(`[DualMode] Blocked external request in Secure Mode: ${url}`);
                        return res.status(403).json({
                            error: 'External requests are blocked in Secure Mode',
                            code: 'SECURE_MODE_EXTERNAL_BLOCKED'
                        });
                    }
                }
            }

            // Check data export
            if (constraints[CONSTRAINT_KEYS.DATA_EXPORT]?.allowed === false) {
                if (req.path?.includes('/export') || req.path?.includes('/download')) {
                    return res.status(403).json({
                        error: 'Data export is not allowed in Secure Mode',
                        code: 'SECURE_MODE_EXPORT_BLOCKED'
                    });
                }
            }

            // Add Secure Mode headers
            res.setHeader('X-Security-Mode', 'secure');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        } else {
            res.setHeader('X-Security-Mode', 'personal');
        }

        next();
    };
}

// =============================================================================
// SOCKET.IO INTEGRATION
// =============================================================================

/**
 * Set the Socket.io instance for broadcasting mode changes.
 * @param {object} socketIO - Socket.io instance
 */
function setSocketIO(socketIO) {
    io = socketIO;
    console.log('[DualMode] Socket.io instance set');
}

// =============================================================================
// STATUS
// =============================================================================

/**
 * Get module status.
 * @returns {object} Status object
 */
function getStatus() {
    const userCount = userModes.size;
    let secureModeCount = 0;
    let personalModeCount = 0;

    for (const [, data] of userModes) {
        if (data.mode === MODES.SECURE) {
            secureModeCount++;
        } else {
            personalModeCount++;
        }
    }

    return {
        active: true,
        healthy: true,
        details: {
            totalUsers: userCount,
            personalModeUsers: personalModeCount,
            secureModeUsers: secureModeCount,
            modeHistoryEntries: modeHistory.size,
            failedAuthThreshold: FAILED_AUTH_THRESHOLD
        }
    };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    // Constants
    MODES,
    CONSTRAINT_KEYS,
    
    // Core functions
    switchMode,
    getCurrentMode,
    getModeConstraints,
    getModeHistory,
    
    // Auth tracking
    recordFailedAuth,
    resetFailedAuthAttempts,
    resetModeOnLogout,
    
    // Middleware
    enforceMode,
    
    // Integration
    setSocketIO,
    setAuditService,
    
    // Status
    getStatus
};
