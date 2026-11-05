/**
 * NovaSentinel Zero Trust Module
 * 
 * This module implements Zero Trust architecture for NovaByte OS.
 * Never trust, always verify - continuously scores every request and can
 * force re-authentication based on risk assessment.
 * 
 * SECURITY REQUIREMENTS:
 * - All trust scores start at neutral (50)
 * - Call auditService.logEvent() for re-verification triggers
 * - Never cache sensitive verification results
 * - Implement trust decay - reduce trust over time without activity
 * - Use crypto.randomBytes for trust token generation
 * - Track request history in memory Map
 * - Calculate risk using weighted factors
 * - Configurable thresholds for re-verification
 * 
 * @module sentinel/auth/zero-trust
 */

'use strict';

const crypto = require('crypto');

// =============================================================================
// TRY TO LOAD DEPENDENCIES
// =============================================================================

let auditService;
try {
    auditService = require('../../audit-service');
} catch (err) {
    console.error('[ZeroTrust] audit-service not available, using console logging');
    auditService = {
        logEvent: (event) => console.log('[ZeroTrust Audit]', JSON.stringify(event))
    };
}

let riskScorer;
try {
    riskScorer = require('../ai/risk-scorer'); // FIX: was './risk-scorer' — file lives at ai/risk-scorer.js
} catch (err) {
    // Placeholder for ML-assisted scoring
    riskScorer = null;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default neutral trust score */
const DEFAULT_TRUST_SCORE = 50;

/** Maximum trust score */
const MAX_TRUST_SCORE = 100;

/** Minimum trust score */
const MIN_TRUST_SCORE = 0;

/** Default re-verification threshold (risk score above this triggers re-auth) */
const DEFAULT_REVERIFICATION_THRESHOLD = 60;

/** Default minimum trust level for protected routes */
const DEFAULT_MIN_TRUST_LEVEL = 40;

/** Trust decay interval in milliseconds (5 minutes) */
const TRUST_DECAY_INTERVAL = 5 * 60 * 1000;

/** Trust decay amount per interval */
const TRUST_DECAY_AMOUNT = 2;

/** Request rate window in milliseconds (1 minute) */
const RATE_LIMIT_WINDOW = 60 * 1000;

/** High request rate threshold (requests per minute) */
const HIGH_REQUEST_RATE_THRESHOLD = 100;

/** Unusual hours configuration */
const UNUSUAL_HOURS = { start: 22, end: 6 };

// Risk factor weights (sum to 100 for normalisation)
const RISK_WEIGHTS = {
    newIp: 25,
    newDevice: 25,
    unusualTime: 15,
    highRequestRate: 20,
    failedAuth: 15
};

// =============================================================================
// STATE
// =============================================================================

/** User trust profiles Map<userId, trustProfile> */
const trustProfiles = new Map();

/** Request history Map<userId, requestHistory[]> */
const requestHistory = new Map();

/** Trust token storage for reverification Map<token, { userId, expiresAt }> */
const trustTokens = new Map();

/** Configuration */
const config = {
    reverificationThreshold: DEFAULT_REVERIFICATION_THRESHOLD,
    minTrustLevel: DEFAULT_MIN_TRUST_LEVEL,
    trustDecayEnabled: true,
    decayInterval: TRUST_DECAY_INTERVAL,
    decayAmount: TRUST_DECAY_AMOUNT
};

// =============================================================================
// TRUST PROFILE MANAGEMENT
// =============================================================================

/**
 * Creates a new trust profile for a user
 * @param {string} userId - User identifier
 * @returns {Object} Trust profile object
 */
function createTrustProfile(userId) {
    return {
        userId,
        trustScore: DEFAULT_TRUST_SCORE,
        lastActivity: Date.now(),
        knownIps: new Set(),
        knownDevices: new Set(),
        failedAttempts: 0,
        successfulAttempts: 0,
        riskFactors: {
            newIp: false,
            newDevice: false,
            unusualTime: false,
            highRequestRate: false,
            failedAuth: false
        },
        createdAt: Date.now(),
        lastVerified: Date.now()
    };
}

/**
 * Gets or creates a trust profile for a user
 * @param {string} userId - User identifier
 * @returns {Object} Trust profile
 */
function getOrCreateProfile(userId) {
    if (!trustProfiles.has(userId)) {
        trustProfiles.set(userId, createTrustProfile(userId));
    }
    return trustProfiles.get(userId);
}

/**
 * Applies trust decay to all profiles
 */
function applyTrustDecay() {
    const now = Date.now();
    
    for (const [userId, profile] of trustProfiles) {
        const timeSinceActivity = now - profile.lastActivity;
        
        if (timeSinceActivity > config.decayInterval) {
            const decayCycles = Math.floor(timeSinceActivity / config.decayInterval);
            const decayTotal = decayCycles * config.decayAmount;
            
            profile.trustScore = Math.max(MIN_TRUST_SCORE, profile.trustScore - decayTotal);
            profile.lastActivity = now;
        }
    }
}

// Start decay interval if enabled
if (config.trustDecayEnabled) {
    setInterval(applyTrustDecay, config.decayInterval);
}

// =============================================================================
// RISK SCORING
// =============================================================================

/**
 * Extracts client identifiers from request
 * @param {Object} req - Express request object
 * @returns {Object} Client info
 */
function extractClientInfo(req) {
    const ip = req.ip || 
               req.headers['x-forwarded-for'] || 
               req.connection?.remoteAddress || 
               'unknown';
    
    const userAgent = req.headers['user-agent'] || 'unknown';
    const deviceId = req.headers['x-device-id'] || 
                     generateDeviceFingerprint(req);
    
    return { ip, userAgent, deviceId };
}

/**
 * Generates a simple device fingerprint from request headers
 * @param {Object} req - Express request object
 * @returns {string} Device fingerprint
 */
function generateDeviceFingerprint(req) {
    const headers = req.headers || {};
    const fingerprintData = [
        headers['user-agent'],
        headers['accept-language'],
        headers['accept-encoding'],
        headers['sec-ch-ua'],
        headers['sec-ch-ua-mobile'],
        headers['sec-ch-ua-platform']
    ].join('|');
    
    return crypto.createHash('sha256').update(fingerprintData).digest('hex').substring(0, 16);
}

/**
 * Checks if request is from unusual time
 * @returns {boolean} True if unusual time
 */
function isUnusualTime() {
    const hour = new Date().getHours();
    return hour < UNUSUAL_HOURS.start && hour >= UNUSUAL_HOURS.end;
}

/**
 * Checks for high request rate
 * @param {string} userId - User identifier
 * @returns {boolean} True if rate is high
 */
function checkRequestRate(userId) {
    const now = Date.now();
    const history = requestHistory.get(userId) || [];
    
    // Filter to requests within the time window
    const recentRequests = history.filter(t => now - t.timestamp < RATE_LIMIT_WINDOW);
    requestHistory.set(userId, recentRequests);
    
    return recentRequests.length > HIGH_REQUEST_RATE_THRESHOLD;
}

/**
 * Calculates risk score based on factors
 * @param {Object} profile - Trust profile
 * @param {Object} clientInfo - Client information
 * @returns {number} Risk score 0-100
 */
function calculateRiskScore(profile, clientInfo) {
    let riskScore = 0;
    const riskFactors = profile.riskFactors;
    
    // Reset risk factors for this check
    riskFactors.newIp = false;
    riskFactors.newDevice = false;
    riskFactors.unusualTime = false;
    riskFactors.highRequestRate = false;
    riskFactors.failedAuth = false;
    
    // Check new IP
    if (!profile.knownIps.has(clientInfo.ip)) {
        riskScore += RISK_WEIGHTS.newIp;
        riskFactors.newIp = true;
    }
    
    // Check new device
    if (!profile.knownDevices.has(clientInfo.deviceId)) {
        riskScore += RISK_WEIGHTS.newDevice;
        riskFactors.newDevice = true;
    }
    
    // Check unusual time
    if (isUnusualTime()) {
        riskScore += RISK_WEIGHTS.unusualTime;
        riskFactors.unusualTime = true;
    }
    
    // Check high request rate
    if (checkRequestRate(profile.userId)) {
        riskScore += RISK_WEIGHTS.highRequestRate;
        riskFactors.highRequestRate = true;
    }
    
    // Check failed auth attempts (recent)
    if (profile.failedAttempts > 0) {
        const failedAuthWeight = Math.min(RISK_WEIGHTS.failedAuth, profile.failedAttempts * 5);
        riskScore += failedAuthWeight;
        riskFactors.failedAuth = true;
    }
    
    // If ML scorer is available, use it as a modifier
    if (riskScorer && typeof riskScorer.calculateScore === 'function') {
        const mlScore = riskScorer.calculateScore(profile, clientInfo);
        // Blend ML score with heuristic (70% heuristic, 30% ML)
        riskScore = Math.round(riskScore * 0.7 + mlScore * 0.3);
    }
    
    return Math.min(100, Math.max(0, riskScore));
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Verifies an incoming request and returns risk score
 * @param {Object} req - Express request object
 * @returns {Object} Verification result with score and details
 */
function verifyRequest(req) {
    const userId = req.session?.userId || req.headers['x-user-id'];
    
    if (!userId) {
        return {
            verified: false,
            riskScore: 100,
            requiresReverification: true,
            reason: 'No user identity',
            userId: null
        };
    }
    
    const profile = getOrCreateProfile(userId);
    const clientInfo = extractClientInfo(req);
    
    // Update last activity
    profile.lastActivity = Date.now();
    
    // Add to request history
    const history = requestHistory.get(userId) || [];
    history.push({ timestamp: Date.now(), ip: clientInfo.ip });
    requestHistory.set(userId, history);
    
    // Calculate risk score
    const riskScore = calculateRiskScore(profile, clientInfo);
    
    // Determine if re-verification is required
    const requiresReverification = riskScore > config.reverificationThreshold;
    
    // Update known IPs and devices if request is legitimate
    if (!requiresReverification) {
        profile.knownIps.add(clientInfo.ip);
        profile.knownDevices.add(clientInfo.deviceId);
    }
    
    return {
        verified: !requiresReverification,
        riskScore,
        requiresReverification,
        trustScore: profile.trustScore,
        riskFactors: { ...profile.riskFactors },
        userId,
        clientInfo: {
            ip: clientInfo.ip,
            deviceId: clientInfo.deviceId
        }
    };
}

/**
 * Forces re-verification for a request if risk is too high
 * @param {Object} req - Express request object
 * @returns {Object} Re-verification requirement result
 */
function requireReverification(req) {
    const verification = verifyRequest(req);
    
    if (verification.requiresReverification) {
        // Generate a trust token for re-verification
        const token = generateTrustToken(verification.userId);
        
        // Log the re-verification trigger
        if (auditService && typeof auditService.logEvent === 'function') {
            auditService.logEvent({
                action: 'REVERIFICATION_REQUIRED',
                userId: verification.userId,
                riskScore: verification.riskScore,
                riskFactors: verification.riskFactors,
                ip: verification.clientInfo?.ip,
                timestamp: new Date().toISOString(),
                severity: verification.riskScore > 80 ? 'critical' : 'warning'
            });
        }
        
        return {
            required: true,
            token,
            riskScore: verification.riskScore,
            trustScore: verification.trustScore,
            riskFactors: verification.riskFactors,
            message: 'Re-verification required due to elevated risk'
        };
    }
    
    return {
        required: false,
        riskScore: verification.riskScore,
        trustScore: verification.trustScore
    };
}

/**
 * Updates trust score for a user based on an event
 * @param {string} userId - User identifier
 * @param {Object} event - Event details
 * @returns {Object} Updated trust profile
 */
function updateTrustScore(userId, event) {
    const profile = getOrCreateProfile(userId);
    const eventType = event?.type || 'unknown';
    
    switch (eventType) {
        case 'successful_auth':
            profile.successfulAttempts++;
            profile.trustScore = Math.min(MAX_TRUST_SCORE, profile.trustScore + 10);
            profile.failedAttempts = 0;
            profile.lastVerified = Date.now();
            break;
            
        case 'failed_auth':
            profile.failedAttempts++;
            profile.trustScore = Math.max(MIN_TRUST_SCORE, profile.trustScore - 15);
            break;
            
        case 'trusted_action':
            profile.trustScore = Math.min(MAX_TRUST_SCORE, profile.trustScore + 5);
            profile.lastActivity = Date.now();
            break;
            
        case 'untrusted_action':
            profile.trustScore = Math.max(MIN_TRUST_SCORE, profile.trustScore - 10);
            break;
            
        case 'ip_confirmed':
            if (event.ip) {
                profile.knownIps.add(event.ip);
            }
            break;
            
        case 'device_confirmed':
            if (event.deviceId) {
                profile.knownDevices.add(event.deviceId);
            }
            break;
            
        case 'verification_completed':
            profile.trustScore = Math.min(MAX_TRUST_SCORE, profile.trustScore + 5);
            profile.lastVerified = Date.now();
            profile.lastActivity = Date.now();
            break;
            
        case 'verification_failed':
            profile.trustScore = Math.max(MIN_TRUST_SCORE, profile.trustScore - 20);
            profile.failedAttempts++;
            break;
            
        case 'manual_review':
            // Reduce trust pending manual review
            profile.trustScore = Math.max(MIN_TRUST_SCORE, profile.trustScore - 25);
            break;
            
        default:
            // Unknown event type, no change
            break;
    }
    
    // Update last activity timestamp
    profile.lastActivity = Date.now();
    
    return {
        userId: profile.userId,
        trustScore: profile.trustScore,
        previousTrustScore: profile.trustScore,
        event: eventType
    };
}

/**
 * Gets the current trust profile for a user
 * @param {string} userId - User identifier
 * @returns {Object} Trust profile with risk factors
 */
function getTrustProfile(userId) {
    const profile = getOrCreateProfile(userId);
    
    // Get recent request count
    const history = requestHistory.get(userId) || [];
    const now = Date.now();
    const recentRequests = history.filter(t => now - t.timestamp < RATE_LIMIT_WINDOW);
    
    return {
        userId: profile.userId,
        trustScore: profile.trustScore,
        trustLevel: getTrustLevel(profile.trustScore),
        riskFactors: {
            newIp: profile.riskFactors.newIp,
            newDevice: profile.riskFactors.newDevice,
            unusualTime: profile.riskFactors.unusualTime,
            highRequestRate: profile.riskFactors.highRequestRate,
            failedAuth: profile.riskFactors.failedAuth
        },
        statistics: {
            knownIpCount: profile.knownIps.size,
            knownDeviceCount: profile.knownDevices.size,
            failedAttempts: profile.failedAttempts,
            successfulAttempts: profile.successfulAttempts,
            recentRequestCount: recentRequests.length,
            lastActivity: profile.lastActivity,
            lastVerified: profile.lastVerified,
            profileAge: Date.now() - profile.createdAt
        },
        isActive: (Date.now() - profile.lastActivity) < (config.decayInterval * 2)
    };
}

/**
 * Converts numeric trust score to categorical level
 * @param {number} score - Trust score
 * @returns {string} Trust level
 */
function getTrustLevel(score) {
    if (score >= 80) return 'high';
    if (score >= 60) return 'medium-high';
    if (score >= 40) return 'medium';
    if (score >= 20) return 'medium-low';
    return 'low';
}

// =============================================================================
// TRUST TOKENS
// =============================================================================

/**
 * Generates a cryptographically secure trust token
 * @param {string} userId - User identifier
 * @returns {string} Trust token
 */
function generateTrustToken(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + (15 * 60 * 1000); // 15 minute expiry
    
    trustTokens.set(token, {
        userId,
        expiresAt,
        used: false
    });
    
    // Clean up expired tokens periodically
    cleanupExpiredTokens();
    
    return token;
}

/**
 * Validates a trust token
 * @param {string} token - Trust token
 * @returns {Object} Validation result
 */
function validateTrustToken(token) {
    const tokenData = trustTokens.get(token);
    
    if (!tokenData) {
        return { valid: false, reason: 'Token not found' };
    }
    
    if (tokenData.used) {
        return { valid: false, reason: 'Token already used' };
    }
    
    if (Date.now() > tokenData.expiresAt) {
        return { valid: false, reason: 'Token expired' };
    }
    
    // Mark as used
    tokenData.used = true;
    trustTokens.set(token, tokenData);
    
    return {
        valid: true,
        userId: tokenData.userId
    };
}

/**
 * Cleans up expired trust tokens
 */
function cleanupExpiredTokens() {
    const now = Date.now();
    
    for (const [token, data] of trustTokens) {
        if (now > data.expiresAt) {
            trustTokens.delete(token);
        }
    }
}

// Run cleanup every 5 minutes
setInterval(cleanupExpiredTokens, 5 * 60 * 1000);

// =============================================================================
// MIDDLEWARE
// =============================================================================

/**
 * Zero Trust middleware for protecting routes
 * @param {number} minTrustLevel - Minimum trust level required (0-100)
 * @returns {Function} Express middleware
 */
function zeroTrustMiddleware(minTrustLevel = DEFAULT_MIN_TRUST_LEVEL) {
    return (req, res, next) => {
        // Skip if no user session
        if (!req.session?.userId) {
            return res.status(401).json({
                error: 'Authentication required',
                code: 'NO_SESSION'
            });
        }
        
        const userId = req.session.userId;
        const profile = getOrCreateProfile(userId);
        
        // Check if trust score meets minimum
        if (profile.trustScore < minTrustLevel) {
            // Log the blocked request
            if (auditService && typeof auditService.logEvent === 'function') {
                auditService.logEvent({
                    action: 'ACCESS_DENIED_LOW_TRUST',
                    userId,
                    trustScore: profile.trustScore,
                    requiredLevel: minTrustLevel,
                    path: req.path,
                    ip: req.ip,
                    timestamp: new Date().toISOString(),
                    severity: 'warning'
                });
            }
            
            return res.status(403).json({
                error: 'Insufficient trust level for this operation',
                code: 'LOW_TRUST',
                trustScore: profile.trustScore,
                requiredLevel: minTrustLevel,
                message: 'Please complete additional verification to proceed'
            });
        }
        
        // Perform full verification check
        const reverification = requireReverification(req);
        
        if (reverification.required) {
            // Log the re-verification requirement
            if (auditService && typeof auditService.logEvent === 'function') {
                auditService.logEvent({
                    action: 'REVERIFICATION_BLOCKED',
                    userId,
                    riskScore: reverification.riskScore,
                    path: req.path,
                    ip: req.ip,
                    timestamp: new Date().toISOString(),
                    severity: 'warning'
                });
            }
            
            return res.status(429).json({
                error: 'Re-verification required',
                code: 'REVERIFICATION_REQUIRED',
                riskScore: reverification.riskScore,
                trustScore: reverification.trustScore,
                token: reverification.token,
                message: reverification.message
            });
        }
        
        // Update last activity
        profile.lastActivity = Date.now();
        
        // Continue to next middleware
        next();
    };
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Updates Zero Trust configuration
 * @param {Object} newConfig - New configuration options
 */
function configure(newConfig) {
    if (newConfig.reverificationThreshold !== undefined) {
        config.reverificationThreshold = Math.min(100, Math.max(0, newConfig.reverificationThreshold));
    }
    
    if (newConfig.minTrustLevel !== undefined) {
        config.minTrustLevel = Math.min(100, Math.max(0, newConfig.minTrustLevel));
    }
    
    if (newConfig.trustDecayEnabled !== undefined) {
        config.trustDecayEnabled = newConfig.trustDecayEnabled;
    }
    
    if (newConfig.decayInterval !== undefined) {
        config.decayInterval = newConfig.decayInterval;
    }
    
    if (newConfig.decayAmount !== undefined) {
        config.decayAmount = newConfig.decayAmount;
    }
}

/**
 * Gets current configuration
 * @returns {Object} Current configuration
 */
function getConfig() {
    return { ...config };
}

// =============================================================================
// STATUS
// =============================================================================

/**
 * Gets the status of the Zero Trust module
 * @returns {Object} Status object
 */
function getStatus() {
    const profileCount = trustProfiles.size;
    const tokenCount = trustTokens.size;
    const totalRequests = Array.from(requestHistory.values()).reduce((sum, arr) => sum + arr.length, 0);
    
    // Calculate average trust score
    let avgTrustScore = 0;
    if (trustProfiles.size > 0) {
        let total = 0;
        for (const profile of trustProfiles.values()) {
            total += profile.trustScore;
        }
        avgTrustScore = Math.round(total / trustProfiles.size);
    }
    
    return {
        active: true,
        healthy: true,
        details: {
            profiles: profileCount,
            activeTokens: tokenCount,
            totalRequests,
            averageTrustScore: avgTrustScore,
            configuration: config,
            riskWeights: RISK_WEIGHTS
        }
    };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    verifyRequest,
    requireReverification,
    updateTrustScore,
    getTrustProfile,
    zeroTrustMiddleware,
    getStatus,
    configure,
    getConfig,
    validateTrustToken,
    generateTrustToken
};