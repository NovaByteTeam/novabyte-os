/**
 * NovaByte OS - Audit Service
 * Security audit logging for tracking system events and user activity
 * Implements log schema, query methods, and suspicious activity detection
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// Log levels
const LOG_LEVELS = {
    DEBUG: 'debug',
    INFO: 'info',
    WARNING: 'warning',
    ERROR: 'error',
    CRITICAL: 'critical'
};

// Action types
const ACTION_TYPES = {
    LOGIN: 'login',
    LOGOUT: 'logout',
    LOGIN_FAILED: 'login_failed',
    PASSWORD_CHANGE: 'password_change',
    PERMISSION_GRANT: 'permission_grant',
    PERMISSION_DENY: 'permission_deny',
    DATA_ACCESS: 'data_access',
    DATA_MODIFY: 'data_modify',
    DATA_DELETE: 'data_delete',
    CONFIG_CHANGE: 'config_change',
    ADMIN_ACTION: 'admin_action',
    SECURITY_EVENT: 'security_event',
    API_REQUEST: 'api_request',
    SESSION_CREATE: 'session_create',
    SESSION_REVOKE: 'session_revoke'
};

// Suspicious activity patterns
const SUSPICIOUS_PATTERNS = {
    BRUTE_FORCE: { maxAttempts: 5, windowMs: 5 * 60 * 1000 }, // 5 attempts in 5 minutes
    UNUSUAL_LOCATION: { enabled: true },
    AFTER_HOURS: { enabled: true, startHour: 22, endHour: 6 },
    DATA_EXFILTRATION: { threshold: 1000 } // Large data access
};

// Default retention policy (in days)
const DEFAULT_RETENTION_DAYS = 90;

// In-memory log storage (would be replaced with database/file in production)
const auditLogs = [];
const failedLoginAttempts = new Map();
const suspiciousActivities = [];
const sessionActivity = new Map();

// Configuration
let config = {
    retentionDays: DEFAULT_RETENTION_DAYS,
    enableSuspiciousDetection: true,
    logApiRequests: true,
    logDataAccess: true,
    maxLogsInMemory: 10000,
    logFilePath: null
};

/**
 * Set audit service configuration
 * @param {object} options - Configuration options
 */
function configure(options) {
    config = { ...config, ...options };
}

/**
 * Create an audit log entry
 * @param {object} params - Log parameters
 * @returns {object} Created log entry
 */
function createLogEntry(params) {
    const entry = {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        
        // User identification
        userId: params.userId || null,
        sessionId: params.sessionId || null,
        ipAddress: params.ipAddress || null,
        userAgent: params.userAgent || null,
        
        // Action details
        action: params.action || ACTION_TYPES.API_REQUEST,
        resource: params.resource || null,
        resourceId: params.resourceId || null,
        
        // Result
        success: params.success !== false,
        failureReason: params.failureReason || null,
        
        // Additional context
        metadata: params.metadata || {},
        level: params.level || (params.success !== false ? LOG_LEVELS.INFO : LOG_LEVELS.WARNING)
    };

    // Add hash for integrity
    entry.hash = crypto
        .createHash('sha256')
        .update(JSON.stringify({ ...entry, hash: undefined }))
        .digest('hex');

    return entry;
}

/**
 * Log an audit event
 * @param {object} params - Log parameters
 * @returns {object} Created log entry
 */
function log(params) {
    const entry = createLogEntry(params);
    
    // Store in memory
    auditLogs.push(entry);
    
    // Trim if exceeds max
    if (auditLogs.length > config.maxLogsInMemory) {
        auditLogs.shift();
    }

    // Track failed logins
    if (params.action === ACTION_TYPES.LOGIN_FAILED) {
        trackFailedLogin(params);
    }

    // Check for suspicious activity
    if (config.enableSuspiciousDetection) {
        checkSuspiciousActivity(entry);
    }

    // Write to file if configured
    if (config.logFilePath) {
        writeToFile(entry);
    }

    return entry;
}

/**
 * Track failed login attempts for brute force detection
 * @param {object} params - Login params
 */
function trackFailedLogin(params) {
    const key = params.userId || params.ipAddress;
    if (!key) return;

    const attempts = failedLoginAttempts.get(key) || [];
    const now = Date.now();
    
    // Filter out old attempts
    const recentAttempts = attempts.filter(
        t => now - t.timestamp < SUSPICIOUS_PATTERNS.BRUTE_FORCE.windowMs
    );
    
    recentAttempts.push({ timestamp: now, ipAddress: params.ipAddress });
    failedLoginAttempts.set(key, recentAttempts);

    // Check if suspicious
    if (recentAttempts.length >= SUSPICIOUS_PATTERNS.BRUTE_FORCE.maxAttempts) {
        logSuspiciousActivity({
            type: 'brute_force',
            userId: params.userId,
            ipAddress: params.ipAddress,
            attempts: recentAttempts.length,
            windowMs: SUSPICIOUS_PATTERNS.BRUTE_FORCE.windowMs
        });
    }
}

/**
 * Check for suspicious activity patterns
 * @param {object} entry - Audit log entry
 */
function checkSuspiciousActivity(entry) {
    // Check for multiple failed logins
    if (entry.action === ACTION_TYPES.LOGIN_FAILED) {
        const key = entry.userId || entry.ipAddress;
        const attempts = failedLoginAttempts.get(key) || [];
        if (attempts.length >= SUSPICIOUS_PATTERNS.BRUTE_FORCE.maxAttempts) {
            logSuspiciousActivity({
                type: 'brute_force_detected',
                userId: entry.userId,
                ipAddress: entry.ipAddress,
                details: entry
            });
        }
    }

    // Check for after-hours activity
    if (SUSPICIOUS_PATTERNS.AFTER_HOURS.enabled && entry.action === ACTION_TYPES.LOGIN) {
        const hour = new Date(entry.timestamp).getHours();
        if (hour >= SUSPICIOUS_PATTERNS.AFTER_HOURS.startHour || 
            hour < SUSPICIOUS_PATTERNS.AFTER_HOURS.endHour) {
            logSuspiciousActivity({
                type: 'after_hours_login',
                userId: entry.userId,
                ipAddress: entry.ipAddress,
                hour
            });
        }
    }

    // Check for data exfiltration (large data access)
    if (SUSPICIOUS_PATTERNS.DATA_EXFILTRATION.enabled && 
        entry.action === ACTION_TYPES.DATA_ACCESS) {
        const dataSize = entry.metadata?.size || 0;
        if (dataSize > SUSPICIOUS_PATTERNS.DATA_EXFILTRATION.threshold) {
            logSuspiciousActivity({
                type: 'data_exfiltration',
                userId: entry.userId,
                ipAddress: entry.ipAddress,
                resource: entry.resource,
                size: dataSize
            });
        }
    }
}

/**
 * Log suspicious activity
 * @param {object} params - Suspicious activity details
 */
function logSuspiciousActivity(params) {
    const activity = {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        type: params.type,
        userId: params.userId,
        ipAddress: params.ipAddress,
        details: params,
        status: 'investigating',
        alertsSent: false
    };

    suspiciousActivities.push(activity);
    
    // Also create audit log
    log({
        action: ACTION_TYPES.SECURITY_EVENT,
        userId: params.userId,
        ipAddress: params.ipAddress,
        resource: 'security',
        success: false,
        metadata: { suspiciousActivity: activity },
        level: LOG_LEVELS.WARNING
    });
}

/**
 * Query audit logs with filters
 * @param {object} filters - Query filters
 * @returns {array} Matching log entries
 */
function query(filters = {}) {
    let results = [...auditLogs];

    // Filter by userId
    if (filters.userId) {
        results = results.filter(e => e.userId === filters.userId);
    }

    // Filter by action
    if (filters.action) {
        results = results.filter(e => e.action === filters.action);
    }

    // Filter by resource
    if (filters.resource) {
        results = results.filter(e => e.resource === filters.resource);
    }

    // Filter by IP address
    if (filters.ipAddress) {
        results = results.filter(e => e.ipAddress === filters.ipAddress);
    }

    // Filter by success/failure
    if (filters.success !== undefined) {
        results = results.filter(e => e.success === filters.success);
    }

    // Filter by date range
    if (filters.startDate) {
        const start = new Date(filters.startDate);
        results = results.filter(e => new Date(e.timestamp) >= start);
    }

    if (filters.endDate) {
        const end = new Date(filters.endDate);
        results = results.filter(e => new Date(e.timestamp) <= end);
    }

    // Filter by level
    if (filters.level) {
        results = results.filter(e => e.level === filters.level);
    }

    // Sort by timestamp (newest first)
    results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Limit results
    if (filters.limit) {
        results = results.slice(0, filters.limit);
    }

    // Offset for pagination
    if (filters.offset) {
        results = results.slice(filters.offset);
    }

    return results;
}

/**
 * Get user activity summary
 * @param {string} userId - User ID
 * @param {object} options - Query options
 * @returns {object} User activity summary
 */
function getUserActivity(userId, options = {}) {
    const userLogs = query({ userId, ...options });
    
    const summary = {
        userId,
        totalActions: userLogs.length,
        successfulActions: userLogs.filter(l => l.success).length,
        failedActions: userLogs.filter(l => !l.success).length,
        actionsByType: {},
        firstActivity: null,
        lastActivity: null,
        ipAddresses: new Set(),
        resources: new Set()
    };

    for (const entry of userLogs) {
        // Count by action type
        summary.actionsByType[entry.action] = (summary.actionsByType[entry.action] || 0) + 1;
        
        // Track IPs
        if (entry.ipAddress) {
            summary.ipAddresses.add(entry.ipAddress);
        }

        // Track resources
        if (entry.resource) {
            summary.resources.add(entry.resource);
        }
    }

    // Get first and last activity
    if (userLogs.length > 0) {
        summary.firstActivity = userLogs[userLogs.length - 1].timestamp;
        summary.firstActivity = userLogs[0].timestamp;
    }

    summary.ipAddresses = Array.from(summary.ipAddresses);
    summary.resources = Array.from(summary.resources);

    return summary;
}

/**
 * Get suspicious activities
 * @param {object} filters - Filter options
 * @returns {array}
 */
function getSuspiciousActivities(filters = {}) {
    let results = [...suspiciousActivities];

    if (filters.status) {
        results = results.filter(a => a.status === filters.status);
    }

    if (filters.type) {
        results = results.filter(a => a.type === filters.type);
    }

    if (filters.userId) {
        results = results.filter(a => a.userId === filters.userId);
    }

    results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return results;
}

/**
 * Update suspicious activity status
 * @param {string} activityId - Activity ID
 * @param {string} status - New status
 * @param {string} notes - Admin notes
 */
function updateSuspiciousActivity(activityId, status, notes = '') {
    const activity = suspiciousActivities.find(a => a.id === activityId);
    if (activity) {
        activity.status = status;
        activity.notes = notes;
        activity.resolvedAt = new Date().toISOString();
    }
    return activity;
}

/**
 * Get failed login attempts for a user or IP
 * @param {string} identifier - User ID or IP address
 * @returns {array}
 */
function getFailedLoginAttempts(identifier) {
    const attempts = failedLoginAttempts.get(identifier) || [];
    const now = Date.now();
    
    // Filter to recent attempts
    return attempts.filter(t => now - t.timestamp < SUSPICIOUS_PATTERNS.BRUTE_FORCE.windowMs);
}

/**
 * Check if account is locked due to failed attempts
 * @param {string} identifier - User ID or IP address
 * @returns {boolean}
 */
function isAccountLocked(identifier) {
    const attempts = getFailedLoginAttempts(identifier);
    return attempts.length >= SUSPICIOUS_PATTERNS.BRUTE_FORCE.maxAttempts;
}

/**
 * Clear failed login attempts (after successful login)
 * @param {string} identifier - User ID or IP address
 */
function clearFailedLoginAttempts(identifier) {
    failedLoginAttempts.delete(identifier);
}

/**
 * Export logs to file
 * @param {string} format - Export format ('json', 'csv')
 * @param {object} filters - Export filters
 * @returns {string} Exported data
 */
function exportLogs(format = 'json', filters = {}) {
    const logs = query(filters);
    
    if (format === 'json') {
        return JSON.stringify(logs, null, 2);
    }
    
    if (format === 'csv') {
        if (logs.length === 0) return '';
        
        const headers = [
            'timestamp', 'userId', 'sessionId', 'ipAddress', 
            'action', 'resource', 'success', 'level'
        ];
        
        const rows = logs.map(log => 
            headers.map(h => {
                const val = log[h];
                return typeof val === 'string' ? `"${val.replace(/"/g, '""')}"` : val;
            }).join(',')
        );
        
        return [headers.join(','), ...rows].join('\n');
    }
    
    throw new Error(`Unsupported format: ${format}`);
}

/**
 * Write log entry to file
 * @param {object} entry - Log entry
 */
function writeToFile(entry) {
    if (!config.logFilePath) return;
    
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(config.logFilePath, line);
}

/**
 * Get log statistics
 * @returns {object}
 */
function getStatistics() {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    
    const recentLogs = auditLogs.filter(e => new Date(e.timestamp).getTime() > oneDayAgo);
    const weekLogs = auditLogs.filter(e => new Date(e.timestamp).getTime() > oneWeekAgo);
    
    return {
        totalLogs: auditLogs.length,
        logsLast24h: recentLogs.length,
        logsLast7Days: weekLogs.length,
        failedActions: auditLogs.filter(e => !e.success).length,
        suspiciousActivities: suspiciousActivities.filter(a => a.status === 'investigating').length,
        uniqueUsers: new Set(auditLogs.map(e => e.userId).filter(Boolean)).size,
        uniqueIPs: new Set(auditLogs.map(e => e.ipAddress).filter(Boolean)).size
    };
}

/**
 * Apply log retention policy
 * @returns {number} Number of logs removed
 */
function applyRetentionPolicy() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - config.retentionDays);
    
    const beforeCount = auditLogs.length;
    const filtered = auditLogs.filter(e => new Date(e.timestamp) > cutoff);
    
    // Also clean up old suspicious activities
    const filteredSuspicious = suspiciousActivities.filter(
        a => new Date(a.timestamp) > cutoff
    );
    
    // Update arrays
    auditLogs.length = 0;
    auditLogs.push(...filtered);
    suspiciousActivities.length = 0;
    suspiciousActivities.push(...filteredSuspicious);
    
    return beforeCount - auditLogs.length;
}

/**
 * Clear all audit data (for testing)
 */
function clearAllData() {
    auditLogs.length = 0;
    failedLoginAttempts.clear();
    suspiciousActivities.length = 0;
    sessionActivity.clear();
}

module.exports = {
    // Constants
    LOG_LEVELS,
    ACTION_TYPES,
    DEFAULT_RETENTION_DAYS,
    
    // Core functions
    configure,
    log,
    query,
    
    // User activity
    getUserActivity,
    
    // Suspicious activity
    getSuspiciousActivities,
    updateSuspiciousActivity,
    
    // Failed login tracking
    getFailedLoginAttempts,
    isAccountLocked,
    clearFailedLoginAttempts,
    
    // Export
    exportLogs,
    
    // Utilities
    getStatistics,
    applyRetentionPolicy,
    clearAllData,
    
    // Legacy exports for compatibility
    logSecurityEvent: (params) => log({ ...params, action: ACTION_TYPES.SECURITY_EVENT }),
    logLoginAttempt: (params) => log({ ...params, action: params.success ? ACTION_TYPES.LOGIN : ACTION_TYPES.LOGIN_FAILED })
};
