/**
 * NovaSentinel Security Score Module
 * 
 * This module calculates and broadcasts live security scores for NovaByte OS.
 * It aggregates status from all NovaSentinel security components to produce
 * a composite security score (0-100) and provides historical data for trend analysis.
 * 
 * SECURITY REQUIREMENTS:
 * - Call auditService.logEvent() for significant score changes (>20 points)
 * - Use timing-safe comparisons for score thresholds
 * - Score history stored in memory with configurable retention
 * - Auto-recalculation interval: 30 seconds
 * - Broadcast via Socket.io on score changes
 * 
 * @module sentinel/dashboard/security-score
 */

'use strict';

const crypto = require('crypto');

// =============================================================================
// TRY TO LOAD DEPENDENCIES
// =============================================================================

/** Try to load audit service for security event logging */
let auditService;
try {
    auditService = require('../../audit-service');
} catch (e) {
    console.warn('[SecurityScore] Audit service not available, using console logging');
}

/** Try to load sentinel modules */
let encryptionModule;
let fido2Module;
let attestationModule;
let zeroTrustModule;
let sessionGuardModule;
let antiFingerprintModule;
let privacyModeModule;
let behavioralModule;
let postQuantumModule;

// Track which modules loaded successfully
const moduleStatus = {
    encryption: false,
    fido2: false,
    attestation: false,
    zeroTrust: false,
    sessionGuard: false,
    antiFingerprint: false,
    privacyMode: false,
    behavioral: false,
    postQuantum: false
};

try {
    encryptionModule = require('../vault/encryption');
    moduleStatus.encryption = true;
} catch (e) {
    console.warn('[SecurityScore] Encryption module not available');
}

try {
    fido2Module = require('../auth/fido2');
    moduleStatus.fido2 = true;
} catch (e) {
    console.warn('[SecurityScore] FIDO2 module not available');
}

try {
    attestationModule = require('../integrity/attestation');
    moduleStatus.attestation = true;
} catch (e) {
    console.warn('[SecurityScore] Attestation module not available');
}

try {
    zeroTrustModule = require('../auth/zero-trust');
    moduleStatus.zeroTrust = true;
} catch (e) {
    console.warn('[SecurityScore] Zero Trust module not available');
}

try {
    sessionGuardModule = require('../auth/session-guard');
    moduleStatus.sessionGuard = true;
} catch (e) {
    console.warn('[SecurityScore] Session Guard module not available');
}

try {
    antiFingerprintModule = require('../privacy/anti-fingerprint');
    moduleStatus.antiFingerprint = true;
} catch (e) {
    console.warn('[SecurityScore] Anti-Fingerprint module not available');
}

try {
    privacyModeModule = require('../modes/privacy-mode');
    moduleStatus.privacyMode = true;
} catch (e) {
    console.warn('[SecurityScore] Privacy Mode module not available');
}

try {
    behavioralModule = require('../ai/behavioral');
    moduleStatus.behavioral = true;
} catch (e) {
    console.warn('[SecurityScore] Behavioral AI module not available');
}

try {
    postQuantumModule = require('../vault/post-quantum');
    moduleStatus.postQuantum = true;
} catch (e) {
    console.warn('[SecurityScore] Post-Quantum module not available');
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Auto-recalculate interval in milliseconds (30 seconds) */
const RECALCULATE_INTERVAL_MS = 30000;

/** Score component weights - must add up to 100 */
const SCORE_WEIGHTS = {
    encryption: 15,          // Encryption active: +15
    fido2: 15,              // FIDO2 enrolled: +15
    integrity: 15,          // Integrity passing: +15
    zeroTrust: 10,           // Zero trust active: +10
    threats: 15,            // No active threats: +15
    sessionHardened: 10,    // Session hardened: +10
    antiFingerprint: 5,     // Anti-fingerprint active: +5
    privacyMode: 5,         // Privacy mode capable: +5
    behavioralAI: 5,        // Behavioral AI active: +5
    postQuantum: 5          // Post-quantum ready: +5
};

/** Score history retention (24 hours in milliseconds) */
const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Maximum history entries */
const MAX_HISTORY_ENTRIES = 2880; // 24 hours * 2 per minute

// =============================================================================
// STATE
// =============================================================================

/** Current Socket.io instance for broadcasting */
let io = null;

/** Score history array */
const scoreHistory = [];

/** Current calculated score */
let currentScore = 0;

/** Current score breakdown */
let currentBreakdown = null;

/** Auto-recalculate interval timer */
let recalculateTimer = null;

/** Last score for change detection */
let lastBroadcastedScore = -1;

/** Active threat count (simulated - would be from threat detection modules) */
let activeThreatCount = 0;

/** Set of active threat IDs */
const activeThreats = new Set();

/** Protection states from sentinel-ui (Map<moduleId, boolean>) */
let protectionStates = null;

/**
 * Set the current protection states map for score calculation
 * @param {Map} map - Map of protection IDs to enabled boolean
 */
function setProtectionStates(map) {
    protectionStates = map;
    console.log('[SecurityScore] Protection states updated, size:', map ? map.size : 'null');
}

// =============================================================================
// SCORE CALCULATION FUNCTIONS
// =============================================================================

/**
 * Check if encryption is active
 * @returns {boolean}
 */
function isEncryptionActive() {
    try {
        if (encryptionModule && typeof encryptionModule.getStatus === 'function') {
            const status = encryptionModule.getStatus();
            return status && status.active === true;
        }
    } catch (e) {
        console.warn('[SecurityScore] Error checking encryption status:', e.message);
    }
    return false;
}

/**
 * Check if FIDO2 is enrolled/available
 * @returns {boolean}
 */
function isFido2Enrolled() {
    // Check protection state if available
    if (protectionStates && protectionStates.has('fido2')) {
        if (!protectionStates.get('fido2')) return false;
        if (!fido2Module) return false;
        try {
            const status = fido2Module.getStatus();
            // Consider healthy if available
            if (status && typeof status.healthy === 'boolean' && !status.healthy) return false;
            return true;
        } catch (e) {
            console.warn('[SecurityScore] Error checking FIDO2 status:', e.message);
            return false;
        }
    }
    // Fallback to module status
    try {
        if (fido2Module && typeof fido2Module.getStatus === 'function') {
            const status = fido2Module.getStatus();
            return status && status.active === true;
        }
    } catch (e) {
        console.warn('[SecurityScore] Error checking FIDO2 status:', e.message);
    }
    return false;
}

/**
 * Check if system integrity is passing
 * @returns {boolean}
 */
function isIntegrityPassing() {
    // Check protection state if available
    if (protectionStates && protectionStates.has('attestation')) {
        if (!protectionStates.get('attestation')) return false;
        if (!attestationModule) return false;
        try {
            const status = attestationModule.getStatus();
            if (status && status.active === true && status.healthy === true) {
                return true;
            }
            return false;
        } catch (e) {
            console.warn('[SecurityScore] Error checking integrity status:', e.message);
            return false;
        }
    }
    // Fallback to original behavior
    try {
        if (attestationModule && typeof attestationModule.getStatus === 'function') {
            const status = attestationModule.getStatus();
            return status && status.active === true && status.healthy === true;
        }
    } catch (e) {
        console.warn('[SecurityScore] Error checking integrity status:', e.message);
    }
    return false;
}

/**
 * Check if Zero Trust is active
 * @returns {boolean}
 */
function isZeroTrustActive() {
    // Check protection state if available
    if (protectionStates && protectionStates.has('zero-trust')) {
        if (!protectionStates.get('zero-trust')) return false;
        if (!zeroTrustModule) return false;
        try {
            const status = zeroTrustModule.getStatus();
            if (status && typeof status.healthy === 'boolean' && !status.healthy) return false;
            return true;
        } catch (e) {
            console.warn('[SecurityScore] Error checking Zero Trust status:', e.message);
            return false;
        }
    }
    // Fallback to module status
    try {
        if (zeroTrustModule && typeof zeroTrustModule.getStatus === 'function') {
            const status = zeroTrustModule.getStatus();
            return status && status.active === true;
        }
    } catch (e) {
        console.warn('[SecurityScore] Error checking Zero Trust status:', e.message);
    }
    return false;
}

/**
 * Check if there are no active threats
 * @returns {boolean}
 */
function isThreatsClear() {
    return activeThreatCount === 0;
}

/**
 * Check if sessions are hardened
 * @returns {boolean}
 */
function isSessionHardened() {
    try {
        if (sessionGuardModule && typeof sessionGuardModule.getStatus === 'function') {
            const status = sessionGuardModule.getStatus();
            return status && status.active === true;
        }
    } catch (e) {
        console.warn('[SecurityScore] Error checking session guard status:', e.message);
    }
    return false;
}

/**
 * Check if anti-fingerprint is active
 * @returns {boolean}
 */
function isAntiFingerprintActive() {
    // Check protection state if available
    if (protectionStates && protectionStates.has('anti-fingerprint')) {
        if (!protectionStates.get('anti-fingerprint')) return false;
        if (!antiFingerprintModule) return false;
        return true;
    }
    // Fallback to module status
    try {
        if (antiFingerprintModule && typeof antiFingerprintModule.getStatus === 'function') {
            const status = antiFingerprintModule.getStatus();
            return status && status.active === true;
        }
    } catch (e) {
        console.warn('[SecurityScore] Error checking anti-fingerprint status:', e.message);
    }
    return false;
}

/**
 * Check if privacy mode is capable/available
 * @returns {boolean}
 */
function isPrivacyModeCapable() {
    // Check protection state if available
    if (protectionStates && protectionStates.has('privacy-mode')) {
        if (!protectionStates.get('privacy-mode')) return false;
        if (!privacyModeModule) return false;
        return true;
    }
    // Fallback to module status
    try {
        if (privacyModeModule && typeof privacyModeModule.getStatus === 'function') {
            const status = privacyModeModule.getStatus();
            return status && status.active === true;
        }
    } catch (e) {
        console.warn('[SecurityScore] Error checking privacy mode status:', e.message);
    }
    return false;
}

/**
 * Check if Behavioral AI is active
 * @returns {boolean}
 */
function isBehavioralAIActive() {
    // Check protection state if available
    if (protectionStates && protectionStates.has('behavioral-ai')) {
        if (!protectionStates.get('behavioral-ai')) return false;
        if (!behavioralModule) return false;
        try {
            const status = behavioralModule.getStatus();
            if (status && typeof status.healthy === 'boolean' && !status.healthy) return false;
            return true;
        } catch (e) {
            console.warn('[SecurityScore] Error checking behavioral AI status:', e.message);
            return false;
        }
    }
    // Fallback to module status
    try {
        if (behavioralModule && typeof behavioralModule.getStatus === 'function') {
            const status = behavioralModule.getStatus();
            return status && status.active === true;
        }
    } catch (e) {
        console.warn('[SecurityScore] Error checking behavioral AI status:', e.message);
    }
    return false;
}

/**
 * Check if post-quantum is ready
 * @returns {boolean}
 */
function isPostQuantumReady() {
    // Check protection state if available
    if (protectionStates && protectionStates.has('post-quantum')) {
        if (!protectionStates.get('post-quantum')) return false;
        if (!postQuantumModule) return false;
        return true;
    }
    // Fallback to module status
    try {
        if (postQuantumModule && typeof postQuantumModule.getStatus === 'function') {
            const status = postQuantumModule.getStatus();
            return status && status.active === true;
        }
    } catch (e) {
        console.warn('[SecurityScore] Error checking post-quantum status:', e.message);
    }
    return false;
}

// =============================================================================
// MAIN CALCULATION FUNCTIONS
// =============================================================================

/**
 * Calculate the composite security score (0-100)
 * @returns {number} Composite security score
 */
function calculateScore() {
    let totalScore = 0;
    
    // Calculate each component
    if (isEncryptionActive()) {
        totalScore += SCORE_WEIGHTS.encryption;
    }
    
    if (isFido2Enrolled()) {
        totalScore += SCORE_WEIGHTS.fido2;
    }
    
    if (isIntegrityPassing()) {
        totalScore += SCORE_WEIGHTS.integrity;
    }
    
    if (isZeroTrustActive()) {
        totalScore += SCORE_WEIGHTS.zeroTrust;
    }
    
    if (isThreatsClear()) {
        totalScore += SCORE_WEIGHTS.threats;
    }
    
    if (isSessionHardened()) {
        totalScore += SCORE_WEIGHTS.sessionHardened;
    }
    
    if (isAntiFingerprintActive()) {
        totalScore += SCORE_WEIGHTS.antiFingerprint;
    }
    
    if (isPrivacyModeCapable()) {
        totalScore += SCORE_WEIGHTS.privacyMode;
    }
    
    if (isBehavioralAIActive()) {
        totalScore += SCORE_WEIGHTS.behavioralAI;
    }
    
    if (isPostQuantumReady()) {
        totalScore += SCORE_WEIGHTS.postQuantum;
    }
    
    // Update current score
    currentScore = totalScore;
    
    return totalScore;
}

/**
 * Get detailed breakdown of score components
 * @returns {Object} Per-component scores with details
 */
function getScoreBreakdown() {
    const breakdown = {
        timestamp: new Date().toISOString(),
        totalScore: currentScore,
        components: {},
        healthy: true,
        details: {}
    };
    
    // Encryption component (CORE - cannot be disabled)
    const encryptionActive = isEncryptionActive();
    breakdown.components.encryption = {
        score: encryptionActive ? SCORE_WEIGHTS.encryption : 0,
        maxScore: SCORE_WEIGHTS.encryption,
        active: encryptionActive,
        core: true,
        description: 'Encryption active'
    };
    
    // FIDO2 component
    const fido2Enrolled = isFido2Enrolled();
    breakdown.components.fido2 = {
        score: fido2Enrolled ? SCORE_WEIGHTS.fido2 : 0,
        maxScore: SCORE_WEIGHTS.fido2,
        active: fido2Enrolled,
        description: 'FIDO2 enrolled'
    };
    
    // Integrity component (CORE - Tamper Detect, cannot be disabled)
    const integrityPassing = isIntegrityPassing();
    breakdown.components.integrity = {
        score: integrityPassing ? SCORE_WEIGHTS.integrity : 0,
        maxScore: SCORE_WEIGHTS.integrity,
        active: integrityPassing,
        core: true,
        description: 'Integrity passing'
    };
    
    // Zero Trust component
    const zeroTrustActive = isZeroTrustActive();
    breakdown.components.zeroTrust = {
        score: zeroTrustActive ? SCORE_WEIGHTS.zeroTrust : 0,
        maxScore: SCORE_WEIGHTS.zeroTrust,
        active: zeroTrustActive,
        description: 'Zero trust active'
    };
    
    // Threats component
    const threatsClear = isThreatsClear();
    breakdown.components.threats = {
        score: threatsClear ? SCORE_WEIGHTS.threats : 0,
        maxScore: SCORE_WEIGHTS.threats,
        active: threatsClear,
        description: 'No active threats',
        activeThreatCount: activeThreatCount
    };
    
    // Session hardened component (CORE - Session Guard, cannot be disabled)
    const sessionHardened = isSessionHardened();
    breakdown.components.sessionHardened = {
        score: sessionHardened ? SCORE_WEIGHTS.sessionHardened : 0,
        maxScore: SCORE_WEIGHTS.sessionHardened,
        active: sessionHardened,
        core: true,
        description: 'Session hardened'
    };
    
    // Anti-fingerprint component
    const antiFingerprintActive = isAntiFingerprintActive();
    breakdown.components.antiFingerprint = {
        score: antiFingerprintActive ? SCORE_WEIGHTS.antiFingerprint : 0,
        maxScore: SCORE_WEIGHTS.antiFingerprint,
        active: antiFingerprintActive,
        description: 'Anti-fingerprint active'
    };
    
    // Privacy mode component
    const privacyModeCapable = isPrivacyModeCapable();
    breakdown.components.privacyMode = {
        score: privacyModeCapable ? SCORE_WEIGHTS.privacyMode : 0,
        maxScore: SCORE_WEIGHTS.privacyMode,
        active: privacyModeCapable,
        description: 'Privacy mode capable'
    };
    
    // Behavioral AI component
    const behavioralAIActive = isBehavioralAIActive();
    breakdown.components.behavioralAI = {
        score: behavioralAIActive ? SCORE_WEIGHTS.behavioralAI : 0,
        maxScore: SCORE_WEIGHTS.behavioralAI,
        active: behavioralAIActive,
        description: 'Behavioral AI active'
    };
    
    // Post-quantum component
    const postQuantumReady = isPostQuantumReady();
    breakdown.components.postQuantum = {
        score: postQuantumReady ? SCORE_WEIGHTS.postQuantum : 0,
        maxScore: SCORE_WEIGHTS.postQuantum,
        active: postQuantumReady,
        description: 'Post-quantum ready'
    };
    
    // Overall health status
    breakdown.healthy = currentScore >= 70;
    
    // Additional details
    breakdown.details = {
        modulesLoaded: moduleStatus,
        recalculateInterval: RECALCULATE_INTERVAL_MS,
        historyEntries: scoreHistory.length
    };
    
    currentBreakdown = breakdown;
    
    return breakdown;
}

/**
 * Record a score entry in history
 * @param {number} score - The score to record
 * @param {Object} breakdown - The breakdown details
 */
function recordScoreHistory(score, breakdown) {
    const entry = {
        timestamp: new Date().toISOString(),
        score: score,
        breakdown: { ...breakdown }
    };
    
    // Remove timestamp from breakdown for history (to save space)
    delete entry.breakdown.timestamp;
    
    scoreHistory.push(entry);
    
    // Trim history if it exceeds maximum
    while (scoreHistory.length > MAX_HISTORY_ENTRIES) {
        scoreHistory.shift();
    }
    
    // Remove old entries beyond retention period
    const cutoff = Date.now() - HISTORY_RETENTION_MS;
    while (scoreHistory.length > 0) {
        const entryTime = new Date(scoreHistory[0].timestamp).getTime();
        if (entryTime < cutoff) {
            scoreHistory.shift();
        } else {
            break;
        }
    }
}

/**
 * Get historical scores for trend chart
 * @param {number} hours - Number of hours to retrieve (default 24)
 * @returns {Array} Historical score data
 */
function getScoreHistory(hours = 24) {
    const cutoff = new Date(Date.now() - (hours * 60 * 60 * 1000)).toISOString();
    
    return scoreHistory.filter(entry => entry.timestamp >= cutoff).map(entry => ({
        timestamp: entry.timestamp,
        score: entry.score
    }));
}

/**
 * Broadcast current score to dashboard via Socket.io
 * @returns {boolean} Success status
 */
function broadcastScore() {
    // Calculate fresh score and breakdown
    const score = calculateScore();
    const breakdown = getScoreBreakdown();
    
    // Record in history
    recordScoreHistory(score, breakdown);
    
    // Check if we should broadcast (only on significant changes or first broadcast)
    const shouldBroadcast = score !== lastBroadcastedScore || lastBroadcastedScore === -1;
    
    if (shouldBroadcast && io) {
        try {
            // Emit to security-score room
            io.emit('security-score', {
                score: score,
                breakdown: breakdown,
                timestamp: new Date().toISOString()
            });
            
            // Log significant score changes
            if (auditService && Math.abs(score - lastBroadcastedScore) > 20) {
                auditService.log({
                    type: 'SECURITY_SCORE_CHANGE',
                    severity: score > lastBroadcastedScore ? 'INFO' : 'WARNING',
                    details: {
                        oldScore: lastBroadcastedScore,
                        newScore: score,
                        change: score - lastBroadcastedScore
                    }
                });
            }
            
            lastBroadcastedScore = score;
            
            console.log(`[SecurityScore] Broadcast score: ${score}`);
            return true;
        } catch (e) {
            console.error('[SecurityScore] Error broadcasting score:', e.message);
            return false;
        }
    }
    
    lastBroadcastedScore = score;
    return true;
}

/**
 * Start auto-recalculation timer
 */
function startAutoRecalculate() {
    if (recalculateTimer) {
        clearInterval(recalculateTimer);
    }
    
    recalculateTimer = setInterval(() => {
        broadcastScore();
    }, RECALCULATE_INTERVAL_MS);
    
    console.log(`[SecurityScore] Auto-recalculate started (${RECALCULATE_INTERVAL_MS}ms interval)`);
}

/**
 * Stop auto-recalculation timer
 */
function stopAutoRecalculate() {
    if (recalculateTimer) {
        clearInterval(recalculateTimer);
        recalculateTimer = null;
        console.log('[SecurityScore] Auto-recalculate stopped');
    }
}

/**
 * Set Socket.io instance for broadcasting
 * @param {Object} socketIO - Socket.io instance
 */
function setSocketIO(socketIO) {
    io = socketIO;
    console.log('[SecurityScore] Socket.io instance set');
    
    // Perform initial broadcast after socket is set
    if (io) {
        broadcastScore();
        startAutoRecalculate();
    }
}

/**
 * Get current module status
 * @returns {Object} Status object
 */
function getStatus() {
    return {
        active: true,
        healthy: currentScore >= 70,
        details: {
            currentScore: currentScore,
            lastBroadcastedScore: lastBroadcastedScore,
            historyEntries: scoreHistory.length,
            modulesLoaded: moduleStatus,
            autoRecalculate: recalculateTimer !== null,
            socketConnected: io !== null,
            activeThreats: activeThreatCount
        }
    };
}

/**
 * Get active threat count
 * @returns {number} Number of active threats
 */
function getActiveThreatCount() {
    return activeThreatCount;
}

/**
 * Set active threat count (for external threat detection integration)
 * @param {number} count - Number of active threats
 */
function setActiveThreatCount(count) {
    activeThreatCount = Math.max(0, count);
    
    // Trigger recalculation if threats changed
    if (io) {
        broadcastScore();
    }
}

// =============================================================================
// INITIALISE
// =============================================================================

// Calculate initial score
calculateScore();
getScoreBreakdown();

// Log initial status
console.log('[SecurityScore] Security score module initialized');
console.log('[SecurityScore] Modules loaded:', moduleStatus);

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    calculateScore,
    getScoreBreakdown,
    broadcastScore,
    getScoreHistory,
    getStatus,
    setSocketIO,
    getActiveThreatCount,
    setActiveThreatCount,
    startAutoRecalculate,
    stopAutoRecalculate,
    setProtectionStates
};
