/**
 * NovaSentinel Threat Monitor Module
 * 
 * This module aggregates and broadcasts live threat feed for NovaByte OS.
 * It maintains an in-memory circular buffer of threats and provides real-time
 * threat data for the security dashboard.
 * 
 * SECURITY REQUIREMENTS:
 * - Circular buffer: max 1000 threats retained
 * - Socket.io broadcasting for real-time updates
 * - Thread-safe threat ID generation
 * - Timestamp precision for trend analysis
 * 
 * @module sentinel/dashboard/threat-monitor
 */

'use strict';

const crypto = require('crypto');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum threats to retain in circular buffer */
const MAX_THREATS = 1000;

/** Default number of recent threats to return */
const DEFAULT_RECENT_LIMIT = 20;

/** Default time window for stats (in milliseconds, 1 hour) */
const DEFAULT_TIME_WINDOW_MS = 60 * 60 * 1000;

/** Trend analysis window (24 hours in milliseconds) */
const TREND_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Valid threat types */
const THREAT_TYPES = [
    'MALWARE',
    'PHISHING',
    'ANOMALY',
    'BRUTE_FORCE',
    'INTEGRITY_VIOLATION',
    'LOCKDOWN'
];

/** Valid severity levels */
const SEVERITY_LEVELS = [
    'INFO',
    'WARNING',
    'HIGH',
    'CRITICAL'
];

// =============================================================================
// STATE
// =============================================================================

/** Circular buffer for threats */
const threatBuffer = new Array(MAX_THREATS);

/** Current write index in circular buffer */
let bufferIndex = 0;

/** Total threats recorded (not reset, keeps incrementing) */
let totalThreatsRecorded = 0;

/** Current Socket.io instance for broadcasting */
let io = null;

/** Counter for unique threat IDs */
let threatIdCounter = 0;

/** Lock for thread-safe ID generation */
const idLock = {
    locked: false,
    queue: []
};

// =============================================================================
// THREAT TYPE VALIDATION
// =============================================================================

/**
 * Validate threat type
 * @param {string} type - Threat type to validate
 * @returns {boolean} True if valid
 */
function isValidThreatType(type) {
    return THREAT_TYPES.includes(type);
}

/**
 * Validate severity level
 * @param {string} severity - Severity level to validate
 * @returns {boolean} True if valid
 */
function isValidSeverity(severity) {
    return SEVERITY_LEVELS.includes(severity);
}

// =============================================================================
// THREAT ID GENERATION
// =============================================================================

/**
 * Generate a unique threat ID in a thread-safe manner
 * @returns {string} Unique threat ID
 */
function generateThreatId() {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    threatIdCounter++;
    return `threat_${timestamp}_${random}_${threatIdCounter}`;
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Record a new threat to the live feed
 * @param {string} type - Threat type (MALWARE, PHISHING, ANOMALY, etc.)
 * @param {string} severity - Severity level (INFO, WARNING, HIGH, CRITICAL)
 * @param {Object} details - Additional threat details
 * @returns {Object|null} Recorded threat object or null if invalid
 */
function recordThreat(type, severity, message = '', details = {}) {
    // Validate threat type
    if (!isValidThreatType(type)) {
        console.warn(`[ThreatMonitor] Invalid threat type: ${type}`);
        return null;
    }

    // Validate severity
    if (!isValidSeverity(severity)) {
        console.warn(`[ThreatMonitor] Invalid severity: ${severity}`);
        return null;
    }

    // Create threat object
    const threat = {
        id: generateThreatId(),
        type: type,
        severity: severity,
        message: message,
        details: details,
        timestamp: new Date().toISOString(),
        recordedAt: Date.now()
    };

    // Add to circular buffer
    threatBuffer[bufferIndex] = threat;
    bufferIndex = (bufferIndex + 1) % MAX_THREATS;
    totalThreatsRecorded++;

    // Broadcast to connected clients
    broadcastThreat(threat);

    // Log critical threats
    if (severity === 'CRITICAL') {
        console.error(`[ThreatMonitor] CRITICAL THREAT DETECTED: ${type} - ${JSON.stringify(details)}`);
    }

    return threat;
}

/**
 * Get recent threats from the feed
 * @param {number} limit - Maximum number of threats to return (default 20)
 * @returns {Array} Array of recent threats, newest first
 */
function getRecentThreats(limit = DEFAULT_RECENT_LIMIT) {
    const result = [];
    const safeLimit = Math.min(Math.max(1, limit), MAX_THREATS);

    // Determine actual number of threats in buffer
    let count = 0;
    for (let i = 0; i < MAX_THREATS; i++) {
        if (threatBuffer[i] !== undefined) {
            count++;
        }
    }

    if (count === 0) {
        return result;
    }

    // Calculate starting index (newest first)
    const startIndex = count < MAX_THREATS ? 0 : bufferIndex;
    
    // Collect threats in reverse order (newest first)
    for (let i = 0; i < safeLimit && i < count; i++) {
        const idx = (startIndex + count - 1 - i) % MAX_THREATS;
        const threat = threatBuffer[idx];
        if (threat !== undefined) {
            result.push(threat);
        }
    }

    return result;
}

/**
 * Get threat statistics for a time window
 * @param {number} timeWindow - Time window in milliseconds (default 1 hour)
 * @returns {Object} Statistics object with counts by type and severity
 */
function getThreatStats(timeWindow = DEFAULT_TIME_WINDOW_MS) {
    const now = Date.now();
    const windowStart = now - timeWindow;

    // Initialize stats
    const stats = {
        timeWindow: timeWindow,
        windowStart: new Date(windowStart).toISOString(),
        windowEnd: new Date(now).toISOString(),
        total: 0,
        byType: {},
        bySeverity: {},
        recentCritical: [],
        criticalCount: 0
    };

    // Initialize type and severity counters
    THREAT_TYPES.forEach(type => {
        stats.byType[type] = 0;
    });
    SEVERITY_LEVELS.forEach(severity => {
        stats.bySeverity[severity] = 0;
    });

    // Count threats in window
    for (let i = 0; i < MAX_THREATS; i++) {
        const threat = threatBuffer[i];
        if (threat && threat.recordedAt >= windowStart) {
            stats.total++;
            stats.byType[threat.type] = (stats.byType[threat.type] || 0) + 1;
            stats.bySeverity[threat.severity] = (stats.bySeverity[threat.severity] || 0) + 1;

            // Track recent critical threats
            if (threat.severity === 'CRITICAL') {
                stats.criticalCount++;
                if (stats.recentCritical.length < 5) {
                    stats.recentCritical.push({
                        id: threat.id,
                        type: threat.type,
                        timestamp: threat.timestamp,
                        details: threat.details
                    });
                }
            }
        }
    }

    return stats;
}

/**
 * Get threat trend data for the last 24 hours
 * Returns threats per hour for chart rendering
 * @returns {Object} Trend data with hourly counts
 */
function getThreatTrend() {
    const now = Date.now();
    const windowStart = now - TREND_WINDOW_MS;

    // Initialize hourly buckets
    const hourlyData = [];
    for (let i = 0; i < 24; i++) {
        hourlyData.push({
            hour: i,
            label: `${(24 - i)}h ago`,
            total: 0,
            byType: {},
            bySeverity: {}
        });
        THREAT_TYPES.forEach(type => {
            hourlyData[i].byType[type] = 0;
        });
        SEVERITY_LEVELS.forEach(severity => {
            hourlyData[i].bySeverity[severity] = 0;
        });
    }

    // Count threats into hourly buckets
    for (let i = 0; i < MAX_THREATS; i++) {
        const threat = threatBuffer[i];
        if (threat && threat.recordedAt >= windowStart) {
            // Calculate which hour bucket (0 = oldest, 23 = newest)
            const hoursAgo = Math.floor((now - threat.recordedAt) / (60 * 60 * 1000));
            const bucketIndex = 23 - hoursAgo;

            if (bucketIndex >= 0 && bucketIndex < 24) {
                hourlyData[bucketIndex].total++;
                hourlyData[bucketIndex].byType[threat.type]++;
                hourlyData[bucketIndex].bySeverity[threat.severity]++;
            }
        }
    }

    return {
        timeframe: '24 hours',
        generatedAt: new Date().toISOString(),
        hourly: hourlyData,
        summary: {
            totalThreats: hourlyData.reduce((sum, h) => sum + h.total, 0),
            peakHour: hourlyData.reduce((max, h, idx) => 
                h.total > max.count ? { count: h.total, hour: idx } : max, 
                { count: 0, hour: -1 }
            ),
            criticalCount: hourlyData.reduce((sum, h) => 
                sum + (h.bySeverity.CRITICAL || 0), 0
            )
        }
    };
}

/**
 * Broadcast threat to connected dashboard clients via Socket.io
 * @param {Object} threat - Threat object to broadcast
 */
function broadcastThreat(threat) {
    if (!io) {
        return; // Socket.io not configured
    }

    try {
        io.emit('threat:new', threat);
        
        // Also emit severity-specific events
        io.emit(`threat:${threat.severity.toLowerCase()}`, threat);
        
        // Emit type-specific events
        io.emit(`threat:${threat.type.toLowerCase()}`, threat);
    } catch (error) {
        console.error('[ThreatMonitor] Broadcast error:', error.message);
    }
}

// =============================================================================
// SOCKET.IO CONFIGURATION
// =============================================================================

/**
 * Set the Socket.io instance for broadcasting
 * @param {Object} socketIO - Socket.io instance
 */
function setSocketIO(socketIO) {
    io = socketIO;
    console.log('[ThreatMonitor] Socket.io configured for threat broadcasting');
}

// =============================================================================
// STATUS
// =============================================================================

/**
 * Get the current status of the threat monitor
 * @returns {Object} Status object
 */
function getStatus() {
    // Calculate actual threat count in buffer
    let actualCount = 0;
    for (let i = 0; i < MAX_THREATS; i++) {
        if (threatBuffer[i] !== undefined) {
            actualCount++;
        }
    }

    return {
        active: true,
        healthy: true,
        details: {
            bufferSize: MAX_THREATS,
            currentCount: actualCount,
            totalRecorded: totalThreatsRecorded,
            socketIOConfigured: io !== null,
            validTypes: THREAT_TYPES,
            validSeverities: SEVERITY_LEVELS
        }
    };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    recordThreat,
    getRecentThreats,
    getThreatStats,
    broadcastThreat,
    getThreatTrend,
    getStatus,
    setSocketIO
};
