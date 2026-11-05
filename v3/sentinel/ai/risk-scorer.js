/**
 * NovaSentinel Dynamic Risk Scoring Module
 * 
 * This module calculates dynamic risk scores combining multiple signals including
 * behavioural anomaly, geo-velocity, device fingerprint, time-of-day, failed auth
 * count, and IP reputation.
 * 
 * SECURITY REQUIREMENTS:
 * - Call auditService.logEvent() for high/critical risk events
 * - Use Map for storing user risk profiles
 * - Track historical scores for trend analysis (rolling 30-day history)
 * - Risk thresholds: 0-30=low, 31-60=medium, 61-80=high, 81-100=critical
 * 
 * @module sentinel/ai/risk-scorer
 */

'use strict';

// =============================================================================
// TRY TO LOAD DEPENDENCIES
// =============================================================================

let auditService;
try {
    auditService = require('../../audit-service');
} catch (err) {
    console.error('[RiskScorer] audit-service not available, using console logging');
    auditService = {
        logEvent: (event) => console.log('[RiskScorer Audit]', JSON.stringify(event)),
        log: (event) => console.log('[RiskScorer Audit]', JSON.stringify(event))
    };
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Risk score weights (must sum to 100) */
const WEIGHTS = {
    behavioural: 30,   // 30% - behavioural anomaly
    geoVelocity: 20,   // 20% - geo-velocity
    device: 15,        // 15% - device fingerprint
    timeOfDay: 10,     // 10% - time-of-day
    authFailures: 15,  // 15% - failed auth count
    ipReputation: 10   // 10% - IP reputation
};

/** Risk thresholds */
const RISK_THRESHOLDS = {
    LOW: { min: 0, max: 30, label: 'low' },
    MEDIUM: { min: 31, max: 60, label: 'medium' },
    HIGH: { min: 61, max: 80, label: 'high' },
    CRITICAL: { min: 81, max: 100, label: 'critical' }
};

/** History retention period (30 days in milliseconds) */
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Maximum history entries per user */
const MAX_HISTORY_ENTRIES = 100;

// =============================================================================
// STATE
// =============================================================================

/** User risk profiles: Map<userId, {currentScore, factors, lastUpdated}> */
const userRiskProfiles = new Map();

/** User risk history: Map<userId, Array<{timestamp, score, factors}>> */
const userRiskHistory = new Map();

/** Known user locations for geo-velocity: Map<userId, {country, city, lastLocation, lastTimestamp}> */
const userLocations = new Map();

/** Known devices: Map<userId, Set<deviceFingerprint>> */
const userDevices = new Map();

/** Failed authentication tracking: Map<userId, Array<{timestamp, count}>> */
const userFailedAuths = new Map();

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get the risk level label for a given score
 * @param {number} score - Risk score (0-100)
 * @returns {string} - Risk level label
 */
function getRiskLevel(score) {
    if (score <= RISK_THRESHOLDS.LOW.max) return RISK_THRESHOLDS.LOW.label;
    if (score <= RISK_THRESHOLDS.MEDIUM.max) return RISK_THRESHOLDS.MEDIUM.label;
    if (score <= RISK_THRESHOLDS.HIGH.max) return RISK_THRESHOLDS.HIGH.label;
    return RISK_THRESHOLDS.CRITICAL.label;
}

/**
 * Get the risk level for logging
 * @param {number} score - Risk score
 * @returns {string} - Log level
 */
function getLogLevel(score) {
    if (score >= RISK_THRESHOLDS.HIGH.min) return 'critical';
    if (score >= RISK_THRESHOLDS.MEDIUM.min) return 'warning';
    return 'info';
}

/**
 * Clean up old history entries (rolling 30-day window)
 * @param {string} userId - User ID
 */
function cleanupHistory(userId) {
    const history = userRiskHistory.get(userId);
    if (!history) return;
    
    const now = Date.now();
    const cutoff = now - HISTORY_RETENTION_MS;
    
    // Filter to only recent entries
    const recentHistory = history.filter(entry => {
        const entryTime = new Date(entry.timestamp).getTime();
        return entryTime >= cutoff;
    });
    
    // Also limit to max entries
    if (recentHistory.length > MAX_HISTORY_ENTRIES) {
        recentHistory.splice(0, recentHistory.length - MAX_HISTORY_ENTRIES);
    }
    
    userRiskHistory.set(userId, recentHistory);
}

/**
 * Clean up old failed auth entries
 * @param {string} userId - User ID
 */
function cleanupFailedAuths(userId) {
    const auths = userFailedAuths.get(userId);
    if (!auths) return;
    
    const now = Date.now();
    const oneDayAgo = now - (24 * 60 * 60 * 1000);
    
    // Keep only entries from the last 24 hours
    const recentAuths = auths.filter(entry => entry.timestamp >= oneDayAgo);
    userFailedAuths.set(userId, recentAuths);
}

// =============================================================================
// SIGNAL CALCULATION FUNCTIONS
// =============================================================================

/**
 * Calculate behavioural anomaly score (0-100)
 * @param {Object} context - Request context
 * @returns {number} - Risk score contribution
 */
function calculateBehaviouralScore(context) {
    const { behaviouralAnomaly } = context;
    
    // behaviouralAnomaly should be 0-100 where 100 is most anomalous
    if (behaviouralAnomaly === undefined || behaviouralAnomaly === null) {
        return 50; // Neutral if not provided
    }
    
    // Clamp to valid range
    const score = Math.max(0, Math.min(100, behaviouralAnomaly));
    
    // Weight by how anomalous it is
    return score;
}

/**
 * Calculate geo-velocity score (0-100)
 * @param {string} userId - User ID
 * @param {Object} context - Request context
 * @returns {number} - Risk score contribution
 */
function calculateGeoVelocityScore(userId, context) {
    const { country, city, ip } = context;
    
    if (!country) {
        return 30; // Moderate risk if no location data
    }
    
    const userLocation = userLocations.get(userId);
    
    if (!userLocation) {
        // First time seeing this user from this location - low initial risk
        userLocations.set(userId, {
            country: country,
            city: city || 'unknown',
            lastLocation: `${country}${city ? '-' + city : ''}`,
            lastTimestamp: Date.now()
        });
        return 20;
    }
    
    // Check if location changed significantly
    const now = Date.now();
    const timeDiff = now - userLocation.lastTimestamp;
    const locationChanged = userLocation.country !== country || 
                           (city && userLocation.city !== city);
    
    if (!locationChanged) {
        // Same location - very low risk
        return 5;
    }
    
    // Location changed - calculate risk based on time
    // Very fast travel (impossible) = high risk
    // Within same country = medium risk
    // Different country but reasonable time = low-medium risk
    
    if (userLocation.country !== country) {
        // International travel
        if (timeDiff < 60 * 60 * 1000) { // Less than 1 hour
            // Impossible travel - very high risk
            return 90;
        } else if (timeDiff < 6 * 60 * 60 * 1000) { // Less than 6 hours
            // Unlikely but possible
            return 60;
        }
    }
    
    // Update location
    userLocations.set(userId, {
        country: country,
        city: city || 'unknown',
        lastLocation: `${country}${city ? '-' + city : ''}`,
        lastTimestamp: now
    });
    
    return locationChanged ? 30 : 5;
}

/**
 * Calculate device fingerprint score (0-100)
 * @param {string} userId - User ID
 * @param {Object} context - Request context
 * @returns {number} - Risk score contribution
 */
function calculateDeviceScore(userId, context) {
    const { deviceFingerprint, userAgent } = context;
    
    if (!deviceFingerprint && !userAgent) {
        return 50; // Unknown device - moderate risk
    }
    
    // Use device fingerprint or hash of user agent
    const deviceId = deviceFingerprint || (userAgent ? 
        'ua-' + hashString(userAgent) : 'unknown');
    
    const knownDevices = userDevices.get(userId);
    
    if (!knownDevices) {
        // First device
        const newSet = new Set([deviceId]);
        userDevices.set(userId, newSet);
        return 20;
    }
    
    if (knownDevices.has(deviceId)) {
        // Known device - very low risk
        return 5;
    }
    
    // New device - add to known devices
    knownDevices.add(deviceId);
    
    // Risk increases with number of devices (potential account sharing)
    const deviceCount = knownDevices.size;
    if (deviceCount <= 2) return 30;
    if (deviceCount <= 4) return 50;
    return 70;
}

/**
 * Calculate time-of-day score (0-100)
 * @param {Object} context - Request context
 * @returns {number} - Risk score contribution
 */
function calculateTimeScore(context) {
    const { timestamp } = context;
    
    const date = timestamp ? new Date(timestamp) : new Date();
    const hour = date.getHours();
    
    // Night hours in user's timezone (assuming UTC for now) are higher risk
    // 0-5am = high risk (unusual hours)
    // 5-7am = medium risk
    // 7am-10pm = low risk
    // 10pm-12am = medium risk
    
    if (hour >= 0 && hour < 5) return 70;
    if (hour >= 5 && hour < 7) return 40;
    if (hour >= 7 && hour < 22) return 10;
    return 40;
}

/**
 * Calculate failed authentication score (0-100)
 * @param {string} userId - User ID
 * @param {Object} context - Request context
 * @returns {number} - Risk score contribution
 */
function calculateAuthFailureScore(userId, context) {
    const { failedAuthCount, failedAuth } = context;
    
    // First, record this attempt if it's a failure
    if (failedAuth) {
        const auths = userFailedAuths.get(userId) || [];
        auths.push({ timestamp: Date.now(), count: 1 });
        userFailedAuths.set(userId, auths);
    }
    
    // Clean up old entries
    cleanupFailedAuths(userId);
    
    // Get recent failed auths
    const auths = userFailedAuths.get(userId) || [];
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    
    // Count failed auths in the last hour
    let recentFailures = 0;
    for (const auth of auths) {
        if (auth.timestamp >= oneHourAgo) {
            recentFailures += auth.count;
        }
    }
    
    // Use explicit count if provided
    const failureCount = failedAuthCount !== undefined ? failedAuthCount : recentFailures;
    
    // Calculate score based on failure count
    if (failureCount === 0) return 0;
    if (failureCount === 1) return 20;
    if (failureCount === 2) return 40;
    if (failureCount === 3) return 60;
    if (failureCount <= 5) return 80;
    return 100;
}

/**
 * Calculate IP reputation score (0-100)
 * @param {Object} context - Request context
 * @returns {number} - Risk score contribution
 */
function calculateIpReputationScore(context) {
    const { ip, ipReputation } = context;
    
    if (!ip) {
        return 50; // Unknown IP - moderate risk
    }
    
    // If IP reputation is explicitly provided
    if (ipReputation !== undefined) {
        // ipReputation is 0-100 where 100 is bad
        return Math.max(0, Math.min(100, ipReputation));
    }
    
    // Default scoring based on IP characteristics
    // Private IP ranges are lower risk
    if (ip.startsWith('10.') || ip.startsWith('192.168.') || 
        ip.startsWith('172.16.') || ip.startsWith('127.')) {
        return 10;
    }
    
    // localhost
    if (ip === '::1' || ip === '127.0.0.1') {
        return 5;
    }
    
    // Unknown external IP - moderate risk
    return 40;
}

/**
 * Simple string hash for device fingerprinting
 * @param {string} str - String to hash
 * @returns {string} - Hash
 */
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Calculate the composite risk score for a user
 * @param {string} userId - User ID
 * @param {Object} context - Context containing risk signals
 * @returns {number} - Composite risk score (0-100)
 */
function calculateRisk(userId, context = {}) {
    // Calculate individual signal scores
    const behaviouralScore = calculateBehaviouralScore(context);
    const geoVelocityScore = calculateGeoVelocityScore(userId, context);
    const deviceScore = calculateDeviceScore(userId, context);
    const timeScore = calculateTimeScore(context);
    const authFailureScore = calculateAuthFailureScore(userId, context);
    const ipReputationScore = calculateIpReputationScore(context);
    
    // Calculate weighted composite score
    const compositeScore = Math.round(
        (behaviouralScore * WEIGHTS.behavioural / 100) +
        (geoVelocityScore * WEIGHTS.geoVelocity / 100) +
        (deviceScore * WEIGHTS.device / 100) +
        (timeScore * WEIGHTS.timeOfDay / 100) +
        (authFailureScore * WEIGHTS.authFailures / 100) +
        (ipReputationScore * WEIGHTS.ipReputation / 100)
    );
    
    // Ensure score is in valid range
    const finalScore = Math.max(0, Math.min(100, compositeScore));
    
    // Store or update user risk profile
    const profile = userRiskProfiles.get(userId) || {
        userId: userId,
        currentScore: finalScore,
        factors: {
            behavioural: behaviouralScore,
            geoVelocity: geoVelocityScore,
            device: deviceScore,
            timeOfDay: timeScore,
            authFailures: authFailureScore,
            ipReputation: ipReputationScore
        },
        lastUpdated: new Date().toISOString()
    };
    
    profile.currentScore = finalScore;
    profile.factors = {
        behavioural: behaviouralScore,
        geoVelocity: geoVelocityScore,
        device: deviceScore,
        timeOfDay: timeScore,
        authFailures: authFailureScore,
        ipReputation: ipReputationScore
    };
    profile.lastUpdated = new Date().toISOString();
    
    userRiskProfiles.set(userId, profile);
    
    // Update history
    updateRiskHistory(userId, finalScore);
    
    // Log high/critical risk events
    const riskLevel = getRiskLevel(finalScore);
    if (riskLevel === 'high' || riskLevel === 'critical') {
        // Use logEvent if available, fallback to log, or console
        const logFn = (auditService && typeof auditService.logEvent === 'function') ?
            auditService.logEvent.bind(auditService) :
            (auditService && typeof auditService.log === 'function') ?
                auditService.log.bind(auditService) :
                console.log;
        
        logFn({
            level: getLogLevel(finalScore),
            action: 'HIGH_RISK_DETECTED',
            userId: userId,
            details: {
                score: finalScore,
                level: riskLevel,
                factors: profile.factors,
                ip: context.ip,
                timestamp: new Date().toISOString()
            },
            source: 'risk-scorer'
        });
    }
    
    return finalScore;
}

/**
 * Get the risk factors breakdown for a user
 * @param {string} userId - User ID
 * @returns {Object} - Risk factors breakdown
 */
function getRiskFactors(userId) {
    const profile = userRiskProfiles.get(userId);
    
    if (!profile) {
        return {
            userId: userId,
            score: 0,
            level: 'low',
            factors: {
                behavioural: 0,
                geoVelocity: 0,
                device: 0,
                timeOfDay: 0,
                authFailures: 0,
                ipReputation: 0
            },
            weights: WEIGHTS,
            lastUpdated: null
        };
    }
    
    return {
        userId: userId,
        score: profile.currentScore,
        level: getRiskLevel(profile.currentScore),
        factors: profile.factors,
        weights: WEIGHTS,
        lastUpdated: profile.lastUpdated
    };
}

/**
 * Update the risk history for a user with a new score
 * @param {string} userId - User ID
 * @param {number} score - Risk score
 */
function updateRiskHistory(userId, score) {
    const history = userRiskHistory.get(userId) || [];
    
    history.push({
        timestamp: new Date().toISOString(),
        score: score,
        factors: userRiskProfiles.get(userId)?.factors || {}
    });
    
    userRiskHistory.set(userId, history);
    
    // Clean up old entries
    cleanupHistory(userId);
}

/**
 * Get the risk history for a user
 * @param {string} userId - User ID
 * @param {number} days - Number of days to look back (default: 30)
 * @returns {Array} - Risk history entries
 */
function getRiskHistory(userId, days = 30) {
    const history = userRiskHistory.get(userId) || [];
    
    if (days === 30 && history.length > 0) {
        // Already cleaned up to 30 days
        return history;
    }
    
    // Filter by days if different window requested
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    return history.filter(entry => {
        const entryTime = new Date(entry.timestamp).getTime();
        return entryTime >= cutoff;
    });
}

/**
 * Get the current status of the risk scorer
 * @returns {Object} - Status object
 */
function getStatus() {
    return {
        active: true,
        healthy: true,
        details: {
            trackedUsers: userRiskProfiles.size,
            totalHistoryEntries: Array.from(userRiskHistory.values())
                .reduce((sum, history) => sum + history.length, 0),
            weights: WEIGHTS,
            thresholds: RISK_THRESHOLDS
        }
    };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    calculateRisk,
    getRiskFactors,
    updateRiskHistory,
    getRiskHistory,
    getStatus
};
