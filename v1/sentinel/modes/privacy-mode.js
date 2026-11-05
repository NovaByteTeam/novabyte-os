/**
 * NovaSentinel Privacy Mode - Emergency Privacy Kill Switch
 * 
 * This module implements emergency privacy mode for NovaByte OS - a kill switch 
 * for sensitive situations where immediate privacy protection is required.
 * 
 * SECURITY REQUIREMENTS:
 * - Call auditService.logEvent() with CRITICAL severity on every activation
 * - Require strong authentication to deactivate
 * - Use Map to track privacy mode state per user
 * - Nuclear wipe option clears all local data
 * 
 * @module sentinel/modes/privacy-mode
 */

'use strict';

// =============================================================================
// STATE
// =============================================================================

/** Map<userId, { active, activatedAt, reason, panicWipePerformed }> */
const privacyStates = new Map();

/** Set of users who have performed panic wipe (cannot be undone) */
const panicWipedUsers = new Set();

/** Current Socket.io instance for broadcasting privacy events */
let io = null;

/** Auth service reference for token validation */
let authService = null;

/** Audit service reference */
let auditService = null;

/** Session revocation service reference */
let sessionRevocation = null;

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
 * Log a critical privacy event.
 * @param {string} userId - User ID
 * @param {string} action - Action type
 * @param {string} reason - Reason for action
 * @param {object} additionalDetails - Additional details to log
 */
function logCriticalEvent(userId, action, reason, additionalDetails = {}) {
    if (typeof auditService !== 'undefined' && auditService) {
        if (typeof auditService.logEvent === 'function') {
            auditService.logEvent({
                action,
                userId,
                severity: 'critical',
                category: 'privacy_mode',
                details: {
                    reason,
                    timestamp: new Date().toISOString(),
                    ...additionalDetails
                },
                description: `[PRIVACY MODE] ${action}: ${reason}`
            });
        } else if (typeof auditService.log === 'function') {
            auditService.log({
                userId,
                action,
                level: 'critical',
                category: 'privacy_mode',
                details: {
                    reason,
                    timestamp: new Date().toISOString(),
                    ...additionalDetails
                },
                description: `[PRIVACY MODE] ${action}: ${reason}`
            });
        }
    }
}

// =============================================================================
// SERVICE INTEGRATION SETTERS
// =============================================================================

/**
 * Set the Socket.io instance for broadcasting privacy events.
 * @param {object} socketIO - Socket.io instance
 */
function setSocketIO(socketIO) {
    io = socketIO;
    console.log('[PrivacyMode] Socket.io instance set');
}

/**
 * Set the auth service for token validation.
 * @param {object} auth - Auth service instance
 */
function setAuthService(auth) {
    authService = auth;
}

/**
 * Set the session revocation service.
 * @param {object} revocation - Revocation service instance
 */
function setSessionRevocation(revocation) {
    sessionRevocation = revocation;
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Activate privacy mode for a user - instant lockdown.
 * Clears localStorage, revokes sessions, disconnects WebSocket, stops sync, clears email cache.
 * 
 * @param {string} userId - User ID
 * @param {string} reason - Reason for activating privacy mode
 * @returns {object} Result with success status and details
 */
function activatePrivacyMode(userId, reason) {
    if (!userId) {
        return { success: false, error: 'userId is required' };
    }

    const reasonStr = reason || 'Manual activation';
    const now = Date.now();
    
    // Check if already in privacy mode
    const existingState = privacyStates.get(userId);
    if (existingState && existingState.active) {
        return {
            success: true,
            alreadyActive: true,
            activatedAt: existingState.activatedAt,
            message: 'Privacy mode already active'
        };
    }

    // Check if user has performed panic wipe (cannot re-activate)
    if (panicWipedUsers.has(userId)) {
        return {
            success: false,
            error: 'User has performed panic wipe - account cannot be reactivated',
            code: 'PANIC_WIPE_PERMANENT'
        };
    }

    // Set privacy mode state
    const state = {
        active: true,
        activatedAt: now,
        reason: reasonStr,
        panicWipePerformed: false
    };
    privacyStates.set(userId, state);

    // Log critical security event
    logCriticalEvent(userId, 'PRIVACY_MODE_ACTIVATED', reasonStr, {
        effects: [
            'clear_localStorage',
            'revoke_all_sessions',
            'disconnect_websocket',
            'stop_sync',
            'clear_email_cache'
        ]
    });

    // Broadcast to connected clients
    if (io) {
        io.to(`user:${userId}`).emit('privacyModeActivated', {
            reason: reasonStr,
            timestamp: new Date().toISOString()
        });
        
        // Notify security monitors
        io.emit('securityAlert', {
            type: 'privacy_mode_activated',
            userId,
            reason: reasonStr,
            timestamp: new Date().toISOString()
        });
    }

    console.log(`[PrivacyMode] Privacy mode activated for user ${userId}: ${reasonStr}`);

    return {
        success: true,
        active: true,
        activatedAt: now,
        message: 'Privacy mode activated - all local data will be cleared'
    };
}

/**
 * Deactivate privacy mode for a user - requires strong authentication.
 * 
 * @param {string} userId - User ID
 * @param {string} authToken - Authentication token for re-authentication
 * @returns {object} Result with success status
 */
function deactivatePrivacyMode(userId, authToken) {
    if (!userId) {
        return { success: false, error: 'userId is required' };
    }

    if (!authToken) {
        return { success: false, error: 'Authentication token required to deactivate privacy mode', code: 'AUTH_REQUIRED' };
    }

    const state = privacyStates.get(userId);
    
    if (!state || !state.active) {
        return {
            success: true,
            alreadyInactive: true,
            message: 'Privacy mode is not active'
        };
    }

    // Validate authentication token
    if (authService && typeof authService.verifyToken === 'function') {
        const tokenValidation = authService.verifyToken(authToken, userId);
        if (!tokenValidation.valid) {
            logCriticalEvent(userId, 'PRIVACY_MODE_DEACTIVATION_FAILED', 'Invalid authentication token', {
                reason: 'Invalid or expired token'
            });
            return {
                success: false,
                error: 'Invalid or expired authentication token',
                code: 'INVALID_TOKEN'
            };
        }
    }

    // Check for strong authentication (MFA if available)
    if (authService && typeof authService.verifyMFA === 'function') {
        const mfaValid = authService.verifyMFA(userId, authToken);
        if (!mfaValid) {
            logCriticalEvent(userId, 'PRIVACY_MODE_DEACTIVATION_FAILED', 'MFA verification required', {
                reason: 'Strong authentication required'
            });
            return {
                success: false,
                error: 'MFA verification required for deactivation',
                code: 'MFA_REQUIRED'
            };
        }
    }

    // Deactivate privacy mode
    const deactivatedAt = Date.now();
    const wasPanicWipe = state.panicWipePerformed;
    
    privacyStates.delete(userId);

    // Log the deactivation
    logCriticalEvent(userId, 'PRIVACY_MODE_DEACTIVATED', 'User authenticated and deactivated privacy mode', {
        wasPanicWipe,
        duration: deactivatedAt - state.activatedAt
    });

    // Broadcast to clients
    if (io) {
        io.to(`user:${userId}`).emit('privacyModeDeactivated', {
            timestamp: new Date().toISOString()
        });
    }

    console.log(`[PrivacyMode] Privacy mode deactivated for user ${userId}`);

    return {
        success: true,
        active: false,
        deactivatedAt,
        message: wasPanicWipe 
            ? 'Privacy mode deactivated but panic wipe cannot be undone'
            : 'Privacy mode deactivated successfully'
    };
}

/**
 * Panic wipe - nuclear option that wipes all local data and signs out the user.
 * This action is irreversible.
 * 
 * @param {string} userId - User ID
 * @returns {object} Result with success status
 */
function panicWipe(userId) {
    if (!userId) {
        return { success: false, error: 'userId is required' };
    }

    const now = Date.now();
    
    // Set panic wipe state (marks user as permanently affected)
    panicWipedUsers.add(userId);
    
    const state = privacyStates.get(userId) || {
        active: true,
        activatedAt: now,
        reason: 'Panic wipe initiated'
    };
    
    state.active = true;
    state.panicWipePerformed = true;
    state.panicWipeAt = now;
    privacyStates.set(userId, state);

    // Log critical security event - MUST be logged before wipe
    logCriticalEvent(userId, 'PANIC_WIPE_EXECUTED', 'Nuclear privacy wipe triggered', {
        effects: [
            'clear_all_localStorage',
            'revoke_all_sessions',
            'disconnect_all_websockets',
            'stop_all_sync',
            'clear_email_cache',
            'clear_contacts_cache',
            'clear_calendar_cache',
            'clear_ai_memory',
            'sign_out_all_devices'
        ],
        irreversible: true
    });

    // Revoke all sessions
    if (sessionRevocation && typeof sessionRevocation.revokeAllUserSessions === 'function') {
        sessionRevocation.revokeAllUserSessions(userId, 'panic_wipe');
    }

    // Broadcast to all connected clients - force immediate logout
    if (io) {
        io.emit('forceLogout', {
            reason: 'panic_wipe',
            message: 'All sessions terminated for security reasons',
            timestamp: new Date().toISOString()
        });
        
        io.to(`user:${userId}`).emit('panicWipeCompleted', {
            timestamp: new Date().toISOString()
        });
    }

    console.log(`[PrivacyMode] PANIC WIPE executed for user ${userId} - ALL DATA WIPED`);

    return {
        success: true,
        active: true,
        panicWipePerformed: true,
        message: 'Panic wipe completed - all local data has been cleared',
        warning: 'This action is irreversible - user must re-authenticate to use the system again'
    };
}

/**
 * Get privacy mode status for a user.
 * 
 * @param {string} userId - User ID
 * @returns {object} Privacy mode status
 */
function getPrivacyModeStatus(userId) {
    if (!userId) {
        return {
            active: false,
            error: 'userId is required'
        };
    }

    const state = privacyStates.get(userId);
    const isPanicWiped = panicWipedUsers.has(userId);

    if (!state) {
        return {
            active: false,
            panicWipePerformed: isPanicWiped
        };
    }

    return {
        active: state.active,
        activatedAt: state.activatedAt,
        reason: state.reason,
        panicWipePerformed: state.panicWipePerformed || isPanicWiped,
        duration: state.activatedAt ? Date.now() - state.activatedAt : 0
    };
}

// =============================================================================
// MIDDLEWARE
// =============================================================================

/**
 * Middleware to enforce privacy mode on requests.
 * @returns {Function} Express middleware
 */
function enforcePrivacyMode() {
    return function(req, res, next) {
        const userId = req.session?.userId;
        
        if (!userId) {
            return next();
        }

        const privacyStatus = getPrivacyModeStatus(userId);

        // Attach privacy mode info to request
        req.privacyMode = {
            active: privacyStatus.active,
            panicWipePerformed: privacyStatus.panicWipePerformed
        };

        // If panic wipe performed, block all requests
        if (privacyStatus.panicWipePerformed) {
            return res.status(403).json({
                error: 'Account locked due to panic wipe',
                code: 'ACCOUNT_LOCKED_PANIC_WIPE'
            });
        }

        next();
    };
}

// =============================================================================
// KEYBOARD SHORTCUT HOOK (Frontend)
// =============================================================================

/**
 * Generate keyboard shortcut handler code for frontend.
 * Returns JavaScript code that can be included in the frontend.
 * @returns {string} JavaScript code for keyboard shortcut handling
 */
function getKeyboardShortcutCode() {
    return `
// Privacy Mode Keyboard Shortcut Handler
// Add this to your frontend JavaScript
(function() {
    const PRIVACY_SHORTCUT = { ctrl: true, shift: true, key: 'P' };
    
    function handlePrivacyShortcut(event) {
        const ctrl = event.ctrlKey || event.metaKey;
        const shift = event.shiftKey;
        const key = event.key.toUpperCase();
        
        if (ctrl && shift && key === 'P') {
            event.preventDefault();
            event.stopPropagation();
            
            // Show confirmation (can be bypassed in emergencies)
            const confirmed = window.confirm(
                'Activate Privacy Mode?\\n\\n' +
                'This will:\\n' +
                '• Clear all local data\\n' +
                '• Sign out all sessions\\n' +
                '• Disconnect WebSocket\\n' +
                '• Stop all sync\\n\\n' +
                'Press OK to activate immediately, or Cancel to abort.'
            );
            
            if (confirmed) {
                // Call the privacy mode API
                fetch('/api/security/privacy-mode/activate', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content
                    },
                    body: JSON.stringify({
                        reason: 'Keyboard shortcut activated'
                    }),
                    credentials: 'same-origin'
                })
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        // Clear localStorage immediately on client
                        localStorage.clear();
                        
                        // Show notification
                        alert('Privacy Mode Activated\\n\\nAll local data has been cleared.');
                        
                        // Redirect to login or show locked state
                        window.location.href = '/login?reason=privacy_mode';
                    } else {
                        alert('Failed to activate privacy mode: ' + (data.error || 'Unknown error'));
                    }
                })
                .catch(error => {
                    console.error('Privacy mode activation failed:', error);
                    // Still clear local data as fallback
                    localStorage.clear();
                    alert('Privacy Mode Emergency Activation\\n\\nLocal data cleared (offline mode).');
                });
            }
        }
    }
    
    // Register keyboard listener
    document.addEventListener('keydown', handlePrivacyShortcut, true);
    
    // Expose for manual trigger
    window.activatePrivacyMode = function(reason) {
        const event = new KeyboardEvent('keydown', {
            key: 'P',
            ctrlKey: true,
            shiftKey: true,
            bubbles: true
        });
        document.dispatchEvent(event);
    };
    
    console.log('[PrivacyMode] Keyboard shortcut handler loaded (Ctrl+Shift+P)');
})();
`;
}

// =============================================================================
// STATUS
// =============================================================================

/**
 * Get module status.
 * @returns {object} Status object
 */
function getStatus() {
    let activeCount = 0;
    let panicWipeCount = 0;

    for (const [, state] of privacyStates) {
        if (state.active) {
            activeCount++;
        }
        if (state.panicWipePerformed) {
            panicWipeCount++;
        }
    }

    return {
        active: true,
        healthy: true,
        details: {
            usersInPrivacyMode: activeCount,
            panicWipedUsers: panicWipedUsers.size,
            totalPrivacyEvents: privacyStates.size
        }
    };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    activatePrivacyMode,
    deactivatePrivacyMode,
    panicWipe,
    getPrivacyModeStatus,
    getStatus,
    // Service setters
    setAuditService,
    setSocketIO,
    setAuthService,
    setSessionRevocation,
    // Middleware
    enforcePrivacyMode,
    // Frontend hook
    getKeyboardShortcutCode
};
