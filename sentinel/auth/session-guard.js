/**
 * NovaSentinel Session Guard
 * 
 * This module provides hardened session management for NovaByte OS.
 * It wraps express-session with additional security features including:
 * - Session ID rotation on privilege escalation
 * - IP and User-Agent binding to detect session hijacking
 * - Fingerprinting for session integrity verification
 * - Absolute session timeout enforcement
 * - CSRF token rotation on mutating requests
 * 
 * SECURITY REQUIREMENTS:
 * - httpOnly: true, secure: true (production), sameSite: 'strict'
 * - rolling: true — extend session on activity
 * - Absolute timeout enforced regardless of activity
 * - Timing-safe comparisons for all sensitive operations
 * - Call auditService.logEvent() for security events
 * - Never log session IDs or sensitive session data
 * 
 * @module sentinel/auth/session-guard
 */

'use strict';

const crypto = require('crypto');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default session absolute timeout (24 hours in milliseconds) */
const DEFAULT_ABSOLUTE_TIMEOUT = 24 * 60 * 60 * 1000;

/** Default session idle timeout (30 minutes in milliseconds) */
const DEFAULT_IDLE_TIMEOUT = 30 * 60 * 1000;

/** CSRF token length (256 bits = 32 bytes hex) */
const CSRF_TOKEN_LENGTH = 32;

/** Fingerprint components to include */
const FINGERPRINT_COMPONENTS = ['ip', 'userAgent', 'acceptLanguage'];

// =============================================================================
// STATE
// =============================================================================

/** In-memory session store (Map<sessionId, sessionData>) */
const sessionStore = new Map();

/** Session configuration */
let sessionConfig = {
    absoluteTimeout: DEFAULT_ABSOLUTE_TIMEOUT,
    idleTimeout: DEFAULT_IDLE_TIMEOUT,
    cookieName: 'nova.sid',
    isProduction: process.env.NODE_ENV === 'production'
};

/** Active session counters */
let activeSessionCount = 0;

// =============================================================================
// AUDIT LOGGING
// =============================================================================

/**
 * Log a security event to the audit service.
 * Handles case where auditService may not be available yet.
 * 
 * @param {string} event - Event type
 * @param {object} data - Event data (sanitized)
 */
function logSecurityEvent(event, data = {}) {
    try {
        // Sanitize data to avoid leaking sensitive information
        const sanitized = {
            ...data,
            sessionId: data.sessionId ? '[REDACTED]' : undefined,
            fingerprint: data.fingerprint ? '[REDACTED]' : undefined
        };
        
        if (typeof auditService !== 'undefined' && auditService && typeof auditService.logEvent === 'function') {
            auditService.logEvent(event, sanitized);
        }
    } catch (e) {
        // Silently fail - audit logging should never break functionality
    }
}

// =============================================================================
// TIMING-SAFE COMPARISON
// =============================================================================

/**
 * Perform a timing-safe comparison of two strings.
 * Uses crypto.timingSafeEqual to prevent timing attacks.
 * 
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} True if strings are equal
 */
function timingSafeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        return false;
    }
    
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    
    if (bufA.length !== bufB.length) {
        // Still timing-safe: comparison fails on length mismatch
        // We need to create equal-length buffers to not leak length info
        const len = Math.max(bufA.length, bufB.length);
        const padA = Buffer.alloc(len);
        const padB = Buffer.alloc(len);
        bufA.copy(padA);
        bufB.copy(padB);
        try {
            crypto.timingSafeEqual(padA, padB);
        } catch (e) {
            // timingSafeEqual throws on length mismatch
        }
        return false;
    }
    
    try {
        return crypto.timingSafeEqual(bufA, bufB);
    } catch (e) {
        return false;
    }
}

// =============================================================================
// FINGERPRINTING
// =============================================================================

/**
 * Create a session fingerprint from request properties.
 * Uses SHA-256 hash of IP + User-Agent + Accept-Language.
 * 
 * @param {object} req - Express request object
 * @returns {string} SHA-256 hash of fingerprint components
 */
function createSessionFingerprint(req) {
    const ip = req.ip || req.connection?.remoteAddress || 
               req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    const acceptLanguage = req.headers['accept-language'] || 'unknown';
    
    const fingerprintData = `${ip}|${userAgent}|${acceptLanguage}`;
    const hash = crypto.createHash('sha256').update(fingerprintData).digest('hex');
    
    return hash;
}

/**
 * Check if the current request fingerprint matches the stored fingerprint.
 * Uses timing-safe comparison to prevent timing attacks.
 * 
 * @param {object} req - Express request object
 * @param {string} storedFingerprint - Previously stored fingerprint
 * @returns {boolean} True if fingerprints match
 */
function checkSessionFingerprint(req, storedFingerprint) {
    if (!storedFingerprint || typeof storedFingerprint !== 'string') {
        return false;
    }
    
    const currentFingerprint = createSessionFingerprint(req);
    return timingSafeCompare(currentFingerprint, storedFingerprint);
}

// =============================================================================
// SESSION INTEGRITY
// =============================================================================

/**
 * Validate session integrity by checking IP and User-Agent binding.
 * Detects potential session hijacking attempts.
 * 
 * @param {object} req - Express request object
 * @returns {object} Validation result { valid: boolean, reason?: string }
 */
function validateSessionIntegrity(req) {
    if (!req.session || !req.session.fingerprint) {
        return { valid: false, reason: 'no_session_fingerprint' };
    }
    
    const storedFingerprint = req.session.fingerprint;
    const isValid = checkSessionFingerprint(req, storedFingerprint);
    
    if (!isValid) {
        logSecurityEvent('session_hijack_detected', {
            reason: 'fingerprint_mismatch',
            ip: req.ip || req.headers['x-forwarded-for'],
            userAgent: req.headers['user-agent']?.substring(0, 50)
        });
        
        return { valid: false, reason: 'fingerprint_mismatch' };
    }
    
    return { valid: true };
}

// =============================================================================
// SESSION TIMEOUT
// =============================================================================

/**
 * Enforce absolute session timeout regardless of activity.
 * Destroys session if absolute timeout has been exceeded.
 * 
 * @param {object} req - Express request object
 * @param {number} maxAge - Maximum session age in milliseconds (optional)
 * @returns {boolean} True if session is still valid
 */
function enforceSessionTimeout(req, maxAge) {
    if (!req.session || !req.session.createdAt) {
        return false;
    }
    
    const timeout = maxAge || sessionConfig.absoluteTimeout;
    const sessionAge = Date.now() - req.session.createdAt;
    
    if (sessionAge > timeout) {
        logSecurityEvent('session_timeout', {
            reason: 'absolute_timeout_exceeded',
            sessionAge: sessionAge,
            timeout: timeout
        });
        
        if (req.session.destroy) {
            req.session.destroy();
        }
        
        return false;
    }
    
    return true;
}

// =============================================================================
// SESSION ROTATION
// =============================================================================

/**
 * Rotate session ID while preserving session data.
 * Called on privilege escalation (e.g., login, role change).
 * 
 * @param {object} req - Express request object
 * @returns {Promise<boolean>} True if rotation successful
 */
async function rotateSession(req) {
    if (!req.session || !req.sessionID) {
        return false;
    }
    
    try {
        // Store current session data
        const sessionData = { ...req.session };
        
        // Regenerate session ID
        await new Promise((resolve, reject) => {
            req.session.regenerate((err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
        
        // Restore session data (excluding internal properties)
        const internalProps = ['cookie', 'fingerprint', 'createdAt'];
        for (const key of internalProps) {
            delete sessionData[key];
        }
        
        Object.assign(req.session, sessionData);
        
        // Update fingerprint for new session
        req.session.fingerprint = createSessionFingerprint(req);
        req.session.createdAt = Date.now();
        
        logSecurityEvent('session_rotated', {
            reason: 'privilege_escalation'
        });
        
        return true;
    } catch (error) {
        logSecurityEvent('session_rotation_failed', {
            error: error.message
        });
        
        return false;
    }
}

// =============================================================================
// CSRF TOKEN
// =============================================================================

/**
 * Generate a new CSRF token.
 * 
 * @returns {string} Random CSRF token (hex encoded)
 */
function generateCsrfToken() {
    return crypto.randomBytes(CSRF_TOKEN_LENGTH).toString('hex');
}

/**
 * Middleware to generate and validate CSRF tokens.
 * Generates new token on GET requests, validates on mutating requests.
 * 
 * @param {object} options - Middleware options
 * @param {string} options.header - Custom header name for CSRF token
 * @returns {Function} Express middleware
 */
function csrfTokenMiddleware(options = {}) {
    const headerName = options.header || 'x-csrf-token';
    
    return (req, res, next) => {
        // Skip for non-API routes
        if (!req.path.startsWith('/api/')) {
            return next();
        }
        
        // Generate new token on GET requests
        if (req.method === 'GET') {
            if (!req.session.csrfToken) {
                req.session.csrfToken = generateCsrfToken();
            }
            
            // Set token in response header for client
            res.setHeader('X-CSRF-Token', req.session.csrfToken);
            return next();
        }
        
        // Validate token on mutating requests (POST, PUT, DELETE, PATCH)
        const clientToken = req.headers[headerName.toLowerCase()] || 
                           req.body?._csrf || 
                           req.query?._csrf;
        
        const serverToken = req.session.csrfToken;
        
        // Allow requests without token in development for easier testing
        if (!sessionConfig.isProduction) {
            if (!clientToken) {
                // Generate new token for future requests
                req.session.csrfToken = generateCsrfToken();
                return next();
            }
        }
        
        // Validate token
        if (!clientToken || !serverToken || !timingSafeCompare(clientToken, serverToken)) {
            logSecurityEvent('csrf_validation_failed', {
                method: req.method,
                path: req.path,
                hasClientToken: !!clientToken,
                hasServerToken: !!serverToken
            });
            
            return res.status(403).json({
                error: 'CSRF token validation failed'
            });
        }
        
        // Rotate token after successful validation (mutating request)
        req.session.csrfToken = generateCsrfToken();
        res.setHeader('X-CSRF-Token', req.session.csrfToken);
        
        next();
    };
}

// =============================================================================
// SESSION MIDDLEWARE
// =============================================================================

/**
 * Create session guard middleware with custom configuration.
 * 
 * @param {object} config - Session configuration
 * @param {number} config.absoluteTimeout - Absolute session timeout in ms
 * @param {number} config.idleTimeout - Idle session timeout in ms
 * @param {boolean} config.isProduction - Whether running in production
 * @returns {Function} Express middleware
 */
function sessionGuard(config = {}) {
    // Merge configuration
    sessionConfig = {
        ...sessionConfig,
        ...config
    };
    
    return (req, res, next) => {
        // Skip for non-API routes
        if (!req.path.startsWith('/api/')) {
            return next();
        }
        
        // Initialize session if it doesn't exist
        if (!req.session) {
            return next();
        }
        
        // Skip validation for unauthenticated sessions
        if (!req.session.fingerprint) {
            return next();
        }
        
        // Validate session integrity (IP + UA binding)
        const integrityResult = validateSessionIntegrity(req);
        if (!integrityResult.valid) {
            if (req.session.destroy) {
                req.session.destroy();
            }
            
            return res.status(401).json({
                error: 'Session integrity check failed'
            });
        }
        
        // Enforce absolute timeout
        if (!enforceSessionTimeout(req)) {
            if (req.session.destroy) {
                req.session.destroy();
            }
            
            return res.status(401).json({
                error: 'Session has expired'
            });
        }
        
        // Update session last activity timestamp
        req.session.lastActivity = Date.now();
        
        next();
    };
}

// =============================================================================
// SESSION INITIALIZATION
// =============================================================================

/**
 * Initialize session with security features.
 * Call after express-session middleware.
 * 
 * @param {object} req - Express request object
 */
function initializeSession(req) {
    if (req.session) {
        // Set fingerprint on first request
        if (!req.session.fingerprint) {
            req.session.fingerprint = createSessionFingerprint(req);
            req.session.createdAt = Date.now();
            req.session.lastActivity = Date.now();
            req.session.csrfToken = generateCsrfToken();
            
            activeSessionCount++;
        }
    }
}

// =============================================================================
// STATUS
// =============================================================================

/**
 * Get the current status of the session guard.
 * 
 * @returns {object} Status object
 */
function getStatus() {
    return { active: true, healthy: true, details: {} };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    sessionGuard,
    rotateSession,
    validateSessionIntegrity,
    createSessionFingerprint,
    checkSessionFingerprint,
    enforceSessionTimeout,
    csrfTokenMiddleware,
    initializeSession,
    getStatus,
    // Configuration setters
    setConfig: (config) => {
        sessionConfig = { ...sessionConfig, ...config };
    },
    getConfig: () => ({ ...sessionConfig })
};
