/**
 * NovaSentinel Anomaly Detection Module
 * 
 * This module detects known attack patterns in incoming requests using regex
 * pattern matching and rate-based detection. It tracks request history per
 * user to identify suspicious behaviour patterns.
 * 
 * SECURITY REQUIREMENTS:
 * - Call auditService.log() for all detections
 * - Use regex for pattern matching (carefully crafted to avoid ReDoS)
 * - Track request history per user in memory Map
 * - Rate-based detection: >10 failed auths in 60s = credential stuffing flag
 * - Detect: credential stuffing, port scanning, SQL injection, path traversal, token replay
 * 
 * @module sentinel/ai/anomaly
 */

'use strict';

// =============================================================================
// TRY TO LOAD DEPENDENCIES
// =============================================================================

let auditService;
try {
    auditService = require('../../audit-service');
} catch (err) {
    console.error('[Anomaly] audit-service not available, using console logging');
    auditService = {
        log: (event) => console.log('[Anomaly Audit]', JSON.stringify(event))
    };
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Rate limiting threshold for credential stuffing detection */
const FAILED_AUTH_THRESHOLD = 10;
const FAILED_AUTH_WINDOW_MS = 60 * 1000; // 60 seconds

/** Attack pattern types */
const ATTACK_TYPES = {
    CREDENTIAL_STUFFING: 'credential_stuffing',
    PORT_SCANNING: 'port_scanning',
    SQL_INJECTION: 'sql_injection',
    PATH_TRAVERSAL: 'path_traversal',
    TOKEN_REPLAY: 'token_replay'
};

/** Default detection patterns (using RegExp constructor to avoid escaping issues) */
function createDefaultPatterns() {
    return {
        sqlInjection: [
            /\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE|TRUNCATE)\b.*\b(FROM|TABLE|DATABASE)\b/i,
            /--/,
            /;/,
            /\/\*/,
            /\*\//,
            /xp_/i,
            /sp_/i,
            /\bexec\b/i,
            /\bexecute\b/i,
            /\bscript\b/i,
            /\bOR\b.*\b=\b/i,
            /\bAND\b.*\b=\b/i,
            /union.*select/i,
            /select.*from.*where/i,
            /1=1/,
            /2=2/,
            /'1'='1/
        ],
        pathTraversal: [
            /\.\.[\/\\]/,
            /\.\.%2f/i,
            /\.\.%5c/i,
            /%2e%2e[\/\\]/i,
            /etc\/passwd/i,
            /boot\.ini/i,
            /windows\/system32/i,
            /\/etc\/\./i,
            /\/proc\/\./i,
            /\/sys\/\./i
        ],
        portScanning: [
            /^[\d]+\/[\d]+$/,
            /port\s*:\s*\d+/i,
            /\b(21|22|23|25|53|80|110|143|443|445|3306|3389|5432|8080|8443)\b/
        ]
    };
}

// =============================================================================
// STATE
// =============================================================================

/** Active detection patterns */
let activePatterns = createDefaultPatterns();

/** Request history per user: Map<userId, Array<{timestamp, type, details}>> */
const userRequestHistory = new Map();

/** Failed authentication attempts per user: Map<userId, Array<timestamp>> */
const failedAuthAttempts = new Map();

/** Detected anomalies: Map<userId, Array<{timestamp, userId, type, details, severity}>> */
const anomalyLog = new Map();

/** Token replay tracking: Set<string> */
const seenTokens = new Set();

// =============================================================================
// PATTERN DETECTION FUNCTIONS
// =============================================================================

/**
 * Detect SQL injection patterns in input
 * @param {string} input - Input to check
 * @returns {Object|null} - Detection result or null
 */
function detectSqlInjection(input) {
    if (!input || typeof input !== 'string') return null;
    
    for (const pattern of activePatterns.sqlInjection) {
        const match = input.match(pattern);
        if (match) {
            return {
                type: ATTACK_TYPES.SQL_INJECTION,
                matched: match[0],
                index: match.index,
                severity: 'high'
            };
        }
    }
    return null;
}

/**
 * Detect path traversal patterns in input
 * @param {string} input - Input to check
 * @returns {Object|null} - Detection result or null
 */
function detectPathTraversal(input) {
    if (!input || typeof input !== 'string') return null;
    
    for (const pattern of activePatterns.pathTraversal) {
        const match = input.match(pattern);
        if (match) {
            return {
                type: ATTACK_TYPES.PATH_TRAVERSAL,
                matched: match[0],
                index: match.index,
                severity: 'high'
            };
        }
    }
    return null;
}

/**
 * Detect port scanning attempts
 * @param {string} input - Input to check
 * @returns {Object|null} - Detection result or null
 */
function detectPortScanning(input) {
    if (!input || typeof input !== 'string') return null;
    
    for (const pattern of activePatterns.portScanning) {
        const match = input.match(pattern);
        if (match) {
            return {
                type: ATTACK_TYPES.PORT_SCANNING,
                matched: match[0],
                index: match.index,
                severity: 'medium'
            };
        }
    }
    return null;
}

/**
 * Detect token replay attempts
 * @param {string} token - Token to check
 * @returns {Object|null} - Detection result or null
 */
function detectTokenReplay(token) {
    if (!token || typeof token !== 'string') return null;
    
    if (seenTokens.has(token)) {
        return {
            type: ATTACK_TYPES.TOKEN_REPLAY,
            matched: token.substring(0, 20) + '...',
            severity: 'critical'
        };
    }
    return null;
}

/**
 * Detect credential stuffing (rate-based detection)
 * @param {string} userId - User ID to check
 * @returns {Object|null} - Detection result or null
 */
function detectCredentialStuffing(userId) {
    const now = Date.now();
    const attempts = failedAuthAttempts.get(userId) || [];
    
    // Filter to only attempts within the time window
    const recentAttempts = attempts.filter(ts => now - ts < FAILED_AUTH_WINDOW_MS);
    
    if (recentAttempts.length > FAILED_AUTH_THRESHOLD) {
        return {
            type: ATTACK_TYPES.CREDENTIAL_STUFFING,
            attemptCount: recentAttempts.length,
            timeWindow: FAILED_AUTH_WINDOW_MS / 1000,
            severity: 'critical'
        };
    }
    return null;
}

// =============================================================================
// CORE DETECTION FUNCTIONS
// =============================================================================

/**
 * Record a failed authentication attempt for rate-based detection
 * @param {string} userId - User ID
 */
function recordFailedAuth(userId) {
    const now = Date.now();
    const attempts = failedAuthAttempts.get(userId) || [];
    attempts.push(now);
    
    // Clean up old attempts
    const recentAttempts = attempts.filter(ts => now - ts < FAILED_AUTH_WINDOW_MS);
    failedAuthAttempts.set(userId, recentAttempts);
}

/**
 * Record a token for replay detection
 * @param {string} token - Token to record
 */
function recordToken(token) {
    if (token && typeof token === 'string') {
        seenTokens.add(token);
    }
}

/**
 * Log an anomaly to the anomaly log
 * @param {string} userId - User ID
 * @param {Object} detection - Detection result
 * @param {Object} request - Original request context
 */
function logAnomaly(userId, detection, request) {
    const anomaly = {
        id: 'anomaly-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
        timestamp: new Date().toISOString(),
        userId: userId || 'unknown',
        type: detection.type,
        details: {
            matched: detection.matched,
            requestPath: request?.path || 'unknown',
            requestMethod: request?.method || 'unknown',
            sourceIp: request?.ip || request?.connection?.remoteAddress || 'unknown'
        },
        severity: detection.severity
    };
    
    // Store in anomaly log
    const userAnomalies = anomalyLog.get(userId) || [];
    userAnomalies.push(anomaly);
    anomalyLog.set(userId, userAnomalies);
    
    // Also store in request history
    const history = userRequestHistory.get(userId) || [];
    history.push({
        timestamp: anomaly.timestamp,
        type: 'anomaly',
        details: anomaly
    });
    userRequestHistory.set(userId, history);
    
    // Log to audit service
    auditService.log({
        level: detection.severity === 'critical' ? 'critical' : 
               detection.severity === 'high' ? 'error' : 'warning',
        action: 'ANOMALY_DETECTED',
        userId: userId || 'unknown',
        details: anomaly,
        source: 'anomaly-detection'
    });
}

/**
 * Detect patterns in a single request
 * @param {Object} request - Request object to analyse
 * @returns {Array} - Array of detections
 */
function analyseRequest(request) {
    const detections = [];
    const userId = request?.session?.userId || request?.userId || request?.body?.userId || 'anonymous';
    
    // Check query parameters
    const queryParams = request?.query ? JSON.stringify(request.query) : '';
    if (queryParams) {
        const sqlResult = detectSqlInjection(queryParams);
        if (sqlResult) detections.push(sqlResult);
        
        const pathResult = detectPathTraversal(queryParams);
        if (pathResult) detections.push(pathResult);
    }
    
    // Check request body
    const body = request?.body;
    if (body) {
        const bodyStr = JSON.stringify(body);
        const sqlResult = detectSqlInjection(bodyStr);
        if (sqlResult) detections.push(sqlResult);
        
        const pathResult = detectPathTraversal(bodyStr);
        if (pathResult) detections.push(pathResult);
    }
    
    // Check URL/path
    const path = request?.path || request?.url || '';
    const pathResult = detectPathTraversal(path);
    if (pathResult) detections.push(pathResult);
    
    // Check for port scanning in headers or params
    const headers = request?.headers || {};
    for (const headerValue of Object.values(headers)) {
        if (typeof headerValue === 'string') {
            const portResult = detectPortScanning(headerValue);
            if (portResult) detections.push(portResult);
        }
    }
    
    // Check for token replay
    const token = request?.headers?.authorization || request?.headers?.['x-api-key'] || 
                 request?.body?.token || request?.query?.token;
    if (token) {
        const tokenResult = detectTokenReplay(token);
        if (tokenResult) detections.push(tokenResult);
        recordToken(token);
    }
    
    // Log all detections
    for (const detection of detections) {
        logAnomaly(userId, detection, request);
    }
    
    return detections;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Detect attack patterns in an array of requests
 * @param {Array} requests - Array of request objects to analyse
 * @returns {Object} - Detection results
 */
function detectPatterns(requests) {
    if (!Array.isArray(requests)) {
        return {
            success: false,
            error: 'Requests must be an array',
            detections: []
        };
    }
    
    const results = [];
    
    for (const request of requests) {
        const detections = analyseRequest(request);
        
        // Also check for credential stuffing if this is an auth failure
        const userId = request?.session?.userId || request?.userId || request?.body?.userId;
        if (request?.failedAuth) {
            recordFailedAuth(userId);
            const stuffingResult = detectCredentialStuffing(userId);
            if (stuffingResult) {
                detections.push(stuffingResult);
                logAnomaly(userId, stuffingResult, request);
            }
        }
        
        if (detections.length > 0) {
            results.push({
                request: request,
                detections: detections,
                hasAnomalies: true
            });
        }
    }
    
    return {
        success: true,
        totalRequests: requests.length,
        requestsWithAnomalies: results.length,
        detections: results
    };
}

/**
 * Update the pattern library with new attack signatures
 * @param {Array} newPatterns - Array of new patterns to add
 * @returns {Object} - Update result
 */
function updatePatternLibrary(newPatterns) {
    if (!Array.isArray(newPatterns)) {
        return {
            success: false,
            error: 'newPatterns must be an array'
        };
    }
    
    let added = 0;
    
    for (const pattern of newPatterns) {
        if (!pattern || !pattern.type || !pattern.regex) {
            continue;
        }
        
        let regex;
        try {
            regex = new RegExp(pattern.regex, pattern.flags || 'i');
        } catch (err) {
            console.error('[Anomaly] Invalid regex pattern:', pattern.regex);
            continue;
        }
        
        switch (pattern.type) {
            case 'sqlInjection':
                activePatterns.sqlInjection.push(regex);
                added++;
                break;
            case 'pathTraversal':
                activePatterns.pathTraversal.push(regex);
                added++;
                break;
            case 'portScanning':
                activePatterns.portScanning.push(regex);
                added++;
                break;
            default:
                console.warn('[Anomaly] Unknown pattern type:', pattern.type);
        }
    }
    
    // Log pattern library update
    auditService.log({
        level: 'info',
        action: 'PATTERN_LIBRARY_UPDATED',
        details: { patternsAdded: added },
        source: 'anomaly-detection'
    });
    
    return {
        success: true,
        patternsAdded: added,
        totalSqlPatterns: activePatterns.sqlInjection.length,
        totalPathPatterns: activePatterns.pathTraversal.length,
        totalPortPatterns: activePatterns.portScanning.length
    };
}

/**
 * Get anomaly report for a user within a time window
 * @param {string} userId - User ID to query
 * @param {number} timeWindow - Time window in milliseconds (default: 1 hour)
 * @returns {Object} - Anomaly report
 */
function getAnomalyReport(userId, timeWindow = 3600000) {
    const now = Date.now();
    const windowStart = now - timeWindow;
    
    // Get anomalies for user
    const userAnomalies = anomalyLog.get(userId) || [];
    
    // Filter by time window
    const recentAnomalies = userAnomalies.filter(a => {
        const anomalyTime = new Date(a.timestamp).getTime();
        return anomalyTime >= windowStart;
    });
    
    // Get request history
    const history = userRequestHistory.get(userId) || [];
    const recentHistory = history.filter(h => {
        const itemTime = new Date(h.timestamp).getTime();
        return itemTime >= windowStart;
    });
    
    // Get failed auth attempts
    const attempts = failedAuthAttempts.get(userId) || [];
    const recentAttempts = attempts.filter(ts => now - ts < FAILED_AUTH_WINDOW_MS);
    
    // Calculate severity counts
    const severityCounts = {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0
    };
    
    for (const anomaly of recentAnomalies) {
        if (severityCounts.hasOwnProperty(anomaly.severity)) {
            severityCounts[anomaly.severity]++;
        }
    }
    
    // Determine if credential stuffing is active
    const isCredentialStuffing = recentAttempts.length > FAILED_AUTH_THRESHOLD;
    
    return {
        userId: userId,
        timeWindowMs: timeWindow,
        timeWindowSeconds: timeWindow / 1000,
        generatedAt: new Date().toISOString(),
        summary: {
            totalAnomalies: recentAnomalies.length,
            severityBreakdown: severityCounts,
            requestHistoryCount: recentHistory.length,
            recentFailedAuths: recentAttempts.length,
            credentialStuffingActive: isCredentialStuffing
        },
        anomalies: recentAnomalies,
        recommendations: generateRecommendations(recentAnomalies, isCredentialStuffing)
    };
}

/**
 * Generate security recommendations based on detected anomalies
 * @param {Array} anomalies - Array of anomalies
 * @param {boolean} isCredentialStuffing - Whether credential stuffing is active
 * @returns {Array} - Array of recommendations
 */
function generateRecommendations(anomalies, isCredentialStuffing) {
    const recommendations = [];
    
    if (isCredentialStuffing) {
        recommendations.push({
            priority: 'critical',
            action: 'BLOCK_USER',
            reason: 'Credential stuffing attack detected - multiple failed auths in short timeframe'
        });
        recommendations.push({
            priority: 'high',
            action: 'NOTIFY_USER',
            reason: 'Notify user of suspicious login attempts'
        });
    }
    
    const sqlCount = anomalies.filter(a => a.type === ATTACK_TYPES.SQL_INJECTION).length;
    if (sqlCount > 0) {
        recommendations.push({
            priority: 'high',
            action: 'RATE_LIMIT',
            reason: 'SQL injection attempts detected (' + sqlCount + ') - apply strict rate limiting'
        });
    }
    
    const pathCount = anomalies.filter(a => a.type === ATTACK_TYPES.PATH_TRAVERSAL).length;
    if (pathCount > 0) {
        recommendations.push({
            priority: 'high',
            action: 'SANITISE_INPUT',
            reason: 'Path traversal attempts detected (' + pathCount + ') - review input sanitisation'
        });
    }
    
    const tokenReplayCount = anomalies.filter(a => a.type === ATTACK_TYPES.TOKEN_REPLAY).length;
    if (tokenReplayCount > 0) {
        recommendations.push({
            priority: 'critical',
            action: 'INVALIDATE_TOKENS',
            reason: 'Token replay detected - invalidate all user tokens and force re-authentication'
        });
    }
    
    return recommendations;
}

/**
 * Get system status
 * @returns {Object} - Status object
 */
function getStatus() {
    return {
        active: true,
        healthy: true,
        details: {
            patternCounts: {
                sqlInjection: activePatterns.sqlInjection.length,
                pathTraversal: activePatterns.pathTraversal.length,
                portScanning: activePatterns.portScanning.length
            },
            trackedUsers: userRequestHistory.size,
            anomalyLogs: anomalyLog.size,
            seenTokens: seenTokens.size,
            credentialStuffingThreshold: FAILED_AUTH_THRESHOLD,
            credentialStuffingWindow: FAILED_AUTH_WINDOW_MS
        }
    };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    detectPatterns,
    updatePatternLibrary,
    getAnomalyReport,
    getStatus
};
