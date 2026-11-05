/**
 * NovaSentinel Isolation - Sandbox Manager
 * 
 * This module manages iframe sandboxing for OS applications to provide
 * isolation between apps in NovaByte OS.
 * 
 * SECURITY REQUIREMENTS:
 * - Track violations when apps attempt disallowed actions
 * - Call auditService.logEvent() for security events
 * - Use Map for tracking sandbox instances
 * - Generate CSP headers per app based on granted permissions
 * 
 * @module sentinel/isolation/sandbox-manager
 */

'use strict';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Valid sandbox permissions */
const SANDBOX_PERMISSIONS = {
    SCRIPTS: 'allow-scripts',
    SAME_ORIGIN: 'allow-same-origin',
    FORMS: 'allow-forms',
    POPUPS: 'allow-popups',
    MODALS: 'allow-modals',
    ORIENTATION_LOCK: 'allow-orientation-lock',
    POINTER_LOCK: 'allow-pointer-lock',
    PRESENTATION: 'allow-presentation',
    TOP_NAVIGATION: 'allow-top-navigation'
};

/** Permission levels with predefined permission sets */
const PERMISSION_LEVELS = {
    NONE: [],
    MINIMAL: [SANDBOX_PERMISSIONS.SCRIPTS],
    STANDARD: [
        SANDBOX_PERMISSIONS.SCRIPTS,
        SANDBOX_PERMISSIONS.FORMS,
        SANDBOX_PERMISSIONS.POPUPS
    ],
    ELEVATED: [
        SANDBOX_PERMISSIONS.SCRIPTS,
        SANDBOX_PERMISSIONS.SAME_ORIGIN,
        SANDBOX_PERMISSIONS.FORMS,
        SANDBOX_PERMISSIONS.POPUPS,
        SANDBOX_PERMISSIONS.MODALS
    ],
    FULL: [
        SANDBOX_PERMISSIONS.SCRIPTS,
        SANDBOX_PERMISSIONS.SAME_ORIGIN,
        SANDBOX_PERMISSIONS.FORMS,
        SANDBOX_PERMISSIONS.POPUPS,
        SANDBOX_PERMISSIONS.MODALS,
        SANDBOX_PERMISSIONS.ORIENTATION_LOCK,
        SANDBOX_PERMISSIONS.POINTER_LOCK,
        SANDBOX_PERMISSIONS.PRESENTATION,
        SANDBOX_PERMISSIONS.TOP_NAVIGATION
    ]
};

/** Default app origin pattern */
const DEFAULT_ORIGIN_PATTERN = /^https?:\/\/localhost:\d+|^https?:\/\/novabyte\.local/;

/** Maximum violations before auto-revocation */
const MAX_VIOLATIONS_BEFORE_REVOKE = 10;

// =============================================================================
// STATE
// =============================================================================

/** Sandbox instances: Map<appId, SandboxInstance> */
const sandboxInstances = new Map();

/** Violation logs: Map<appId, Array<Violation>> */
const violationLogs = new Map();

/** Maximum violation entries to retain per app */
const MAX_VIOLATION_ENTRIES = 100;

// =============================================================================
// DATA STRUCTURES
// =============================================================================

/**
 * @typedef {Object} SandboxInstance
 * @property {string} appId
 * @property {string[]} permissions
 * @property {string} origin
 * @property {RegExp} originPattern
 * @property {string} cspHeader
 * @property {string} sandboxAttribute
 * @property {number} violationCount
 * @property {string} createdAt
 * @property {string} lastActivityAt
 * @property {boolean} active
 */

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Validate app ID
 * @param {string} appId - Application identifier
 * @returns {boolean}
 */
function isValidAppId(appId) {
    return typeof appId === 'string' && appId.length > 0 && appId.length <= 64;
}

/**
 * Validate permission
 * @param {string} permission - Permission string
 * @returns {boolean}
 */
function isValidPermission(permission) {
    return Object.values(SANDBOX_PERMISSIONS).includes(permission);
}

/**
 * Validate origin
 * @param {string} origin - Origin URL
 * @returns {boolean}
 */
function isValidOrigin(origin) {
    if (typeof origin !== 'string' || origin.length === 0) {
        return false;
    }
    try {
        new URL(origin);
        return true;
    } catch {
        return false;
    }
}

/**
 * Generate sandbox attribute string from permissions
 * @param {string[]} permissions - Array of permissions
 * @returns {string}
 */
function generateSandboxAttribute(permissions) {
    if (!permissions || permissions.length === 0) {
        return '';
    }
    return permissions.join(' ');
}

/**
 * Generate CSP header for the sandbox
 * @param {string[]} permissions - Array of permissions
 * @param {string} appId - Application ID
 * @returns {string}
 */
function generateCSPHeader(permissions, appId) {
    const directives = ['frame-ancestors \'none\''];
    
    if (permissions.includes(SANDBOX_PERMISSIONS.SCRIPTS)) {
        directives.push('script-src \'self\'');
    } else {
        directives.push('script-src \'none\'');
    }
    
    if (permissions.includes(SANDBOX_PERMISSIONS.FORMS)) {
        directives.push('form-action \'self\'');
    }
    
    if (permissions.includes(SANDBOX_PERMISSIONS.POPUPS)) {
        directives.push('popups-to-secure \'self\'');
    }
    
    // Default directives
    directives.push('default-src \'self\'');
    directives.push('object-src \'none\'');
    directives.push('base-uri \'self\'');
    
    return directives.join('; ');
}

/**
 * Log a security violation
 * @param {string} appId - Application ID
 * @param {string} violationType - Type of violation
 * @param {string} details - Additional details
 */
function logViolation(appId, violationType, details) {
    const violation = {
        timestamp: new Date().toISOString(),
        type: violationType,
        details,
        appId
    };
    
    if (!violationLogs.has(appId)) {
        violationLogs.set(appId, []);
    }
    
    const appViolations = violationLogs.get(appId);
    appViolations.push(violation);
    
    // Trim if exceeds max entries
    while (appViolations.length > MAX_VIOLATION_ENTRIES) {
        appViolations.shift();
    }
    
    // Update violation count in sandbox instance
    const sandbox = sandboxInstances.get(appId);
    if (sandbox) {
        sandbox.violationCount++;
        sandbox.lastActivityAt = new Date().toISOString();
    }
    
    // Log to audit service
    if (typeof auditService !== 'undefined' && auditService && typeof auditService.logEvent === 'function') {
        auditService.logEvent({
            action: 'sandbox_violation',
            appId,
            violationType,
            timestamp: new Date().toISOString()
        }, {
            type: violationType,
            appId,
            details
        });
    }
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Create a sandbox for an application
 * 
 * @param {string} appId - Application identifier
 * @param {string[]} permissions - Array of sandbox permissions
 * @returns {object} Result with sandbox configuration
 */
function createSandbox(appId, permissions) {
    // Validate app ID
    if (!isValidAppId(appId)) {
        return { success: false, error: 'Invalid app ID' };
    }
    
    // Check if sandbox already exists
    if (sandboxInstances.has(appId)) {
        return { success: false, error: 'Sandbox already exists for this app' };
    }
    
    // Validate permissions array
    if (!Array.isArray(permissions)) {
        return { success: false, error: 'Permissions must be an array' };
    }
    
    // Filter to valid permissions
    const validPermissions = permissions.filter(p => isValidPermission(p));
    
    // Generate sandbox configuration
    const sandboxAttribute = generateSandboxAttribute(validPermissions);
    const cspHeader = generateCSPHeader(validPermissions, appId);
    
    // Create sandbox instance
    const sandbox = {
        appId,
        permissions: validPermissions,
        origin: null,
        originPattern: DEFAULT_ORIGIN_PATTERN,
        cspHeader,
        sandboxAttribute,
        violationCount: 0,
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        active: true
    };
    
    sandboxInstances.set(appId, sandbox);
    
    // Log sandbox creation
    if (typeof auditService !== 'undefined' && auditService && typeof auditService.logEvent === 'function') {
        auditService.logEvent({
            action: 'sandbox_create',
            appId,
            permissions: validPermissions,
            timestamp: new Date().toISOString()
        }, {
            appId,
            permissions: validPermissions
        });
    }
    
    return {
        success: true,
        appId,
        sandboxAttribute: sandboxAttribute || 'allow-scripts',
        cspHeader,
        permissions: validPermissions
    };
}

/**
 * Validate the origin of a postMessage source
 * 
 * @param {string} origin - Origin URL from postMessage
 * @param {string} appId - Application ID to validate against
 * @returns {object} Validation result
 */
function validateSandboxOrigin(origin, appId) {
    // Validate inputs
    if (!isValidOrigin(origin)) {
        return { valid: false, error: 'Invalid origin format' };
    }
    
    if (!isValidAppId(appId)) {
        return { valid: false, error: 'Invalid app ID' };
    }
    
    const sandbox = sandboxInstances.get(appId);
    
    if (!sandbox) {
        logViolation(appId || 'unknown', 'unknown_app', 'Attempted validation from ' + origin);
        return { valid: false, error: 'No sandbox exists for this app' };
    }
    
    if (!sandbox.active) {
        logViolation(appId, 'inactive_sandbox', 'Attempted validation from ' + origin + ' on inactive sandbox');
        return { valid: false, error: 'Sandbox is not active' };
    }
    
    // Parse the incoming origin
    let parsedOrigin;
    try {
        parsedOrigin = new URL(origin);
    } catch {
        return { valid: false, error: 'Could not parse origin' };
    }
    
    // Check against origin pattern
    const isValidOriginPattern = sandbox.originPattern.test(origin);
    
    // Update sandbox origin on first valid message
    if (isValidOriginPattern && !sandbox.origin) {
        sandbox.origin = origin;
        sandbox.lastActivityAt = new Date().toISOString();
    }
    
    // Check if origin matches previously recorded origin
    if (sandbox.origin && origin !== sandbox.origin) {
        logViolation(appId, 'origin_mismatch', 'Origin changed from ' + sandbox.origin + ' to ' + origin);
        return { valid: false, error: 'Origin mismatch - possible attack' };
    }
    
    if (!isValidOriginPattern) {
        logViolation(appId, 'invalid_origin', 'Invalid origin: ' + origin);
    }
    
    return {
        valid: isValidOriginPattern,
        appId,
        origin: sandbox.origin,
        permissions: sandbox.permissions
    };
}

/**
 * Revoke and clean up a sandbox
 * 
 * @param {string} appId - Application ID to revoke
 * @returns {object} Revocation result
 */
function revokeSandbox(appId) {
    // Validate app ID
    if (!isValidAppId(appId)) {
        return { success: false, error: 'Invalid app ID' };
    }
    
    const sandbox = sandboxInstances.get(appId);
    
    if (!sandbox) {
        return { success: false, error: 'No sandbox exists for this app' };
    }
    
    // Mark as inactive
    sandbox.active = false;
    sandbox.lastActivityAt = new Date().toISOString();
    
    // Store violation count for reporting
    const finalViolationCount = sandbox.violationCount;
    
    // Log revocation
    if (typeof auditService !== 'undefined' && auditService && typeof auditService.logEvent === 'function') {
        auditService.logEvent({
            action: 'sandbox_revoke',
            appId,
            violations: finalViolationCount,
            timestamp: new Date().toISOString()
        }, {
            appId,
            violations: finalViolationCount,
            permissions: sandbox.permissions
        });
    }
    
    // Clean up - remove from active instances
    sandboxInstances.delete(appId);
    
    return {
        success: true,
        appId,
        violationsDetected: finalViolationCount,
        revokedAt: new Date().toISOString()
    };
}

/**
 * Get the status of a sandbox
 * 
 * @param {string} appId - Application ID to check
 * @returns {object} Sandbox status
 */
function getSandboxStatus(appId) {
    // Validate app ID
    if (!isValidAppId(appId)) {
        return { 
            exists: false, 
            error: 'Invalid app ID',
            permissions: [],
            violationCount: 0 
        };
    }
    
    const sandbox = sandboxInstances.get(appId);
    
    if (!sandbox) {
        return {
            exists: false,
            error: 'No sandbox exists for this app',
            permissions: [],
            violationCount: 0
        };
    }
    
    // Get violations for this app
    const violations = violationLogs.get(appId) || [];
    
    return {
        exists: true,
        appId: sandbox.appId,
        active: sandbox.active,
        permissions: sandbox.permissions,
        origin: sandbox.origin,
        violationCount: sandbox.violationCount,
        violations: violations.slice(-10),
        createdAt: sandbox.createdAt,
        lastActivityAt: sandbox.lastActivityAt,
        cspHeader: sandbox.cspHeader,
        sandboxAttribute: sandbox.sandboxAttribute
    };
}

/**
 * Create sandbox with a permission level preset
 * 
 * @param {string} appId - Application identifier
 * @param {string} level - Permission level (NONE, MINIMAL, STANDARD, ELEVATED, FULL)
 * @returns {object} Result with sandbox configuration
 */
function createSandboxWithLevel(appId, level) {
    const permissions = PERMISSION_LEVELS[level] || PERMISSION_LEVELS.STANDARD;
    return createSandbox(appId, permissions);
}

/**
 * Update permissions for an existing sandbox
 * 
 * @param {string} appId - Application ID
 * @param {string[]} newPermissions - New permissions array
 * @returns {object} Update result
 */
function updateSandboxPermissions(appId, newPermissions) {
    if (!isValidAppId(appId)) {
        return { success: false, error: 'Invalid app ID' };
    }
    
    const sandbox = sandboxInstances.get(appId);
    
    if (!sandbox) {
        return { success: false, error: 'No sandbox exists for this app' };
    }
    
    if (!Array.isArray(newPermissions)) {
        return { success: false, error: 'Permissions must be an array' };
    }
    
    const validPermissions = newPermissions.filter(p => isValidPermission(p));
    
    sandbox.permissions = validPermissions;
    sandbox.sandboxAttribute = generateSandboxAttribute(validPermissions);
    sandbox.cspHeader = generateCSPHeader(validPermissions, appId);
    sandbox.lastActivityAt = new Date().toISOString();
    
    if (typeof auditService !== 'undefined' && auditService && typeof auditService.logEvent === 'function') {
        auditService.logEvent({
            action: 'sandbox_permissions_update',
            appId,
            permissions: validPermissions,
            timestamp: new Date().toISOString()
        }, {
            appId,
            permissions: validPermissions
        });
    }
    
    return {
        success: true,
        appId,
        permissions: validPermissions,
        sandboxAttribute: sandbox.sandboxAttribute,
        cspHeader: sandbox.cspHeader
    };
}

/**
 * Get all active sandboxes
 * @returns {Array} Array of active sandbox info
 */
function getAllSandboxes() {
    const sandboxes = [];
    const entries = sandboxInstances.entries();
    for (const [appId, sandbox] of entries) {
        sandboxes.push({
            appId: appId,
            active: sandbox.active,
            permissions: sandbox.permissions,
            violationCount: sandbox.violationCount,
            createdAt: sandbox.createdAt,
            lastActivityAt: sandbox.lastActivityAt
        });
    }
    return sandboxes;
}

/**
 * Get violation statistics
 * @returns {object} Violation statistics
 */
function getViolationStatistics() {
    let totalViolations = 0;
    const byType = {};
    
    const logEntries = violationLogs.entries();
    for (const [appId, violations] of logEntries) {
        totalViolations += violations.length;
        
        for (let i = 0; i < violations.length; i++) {
            const v = violations[i];
            const type = v.type;
            byType[type] = (byType[type] || 0) + 1;
        }
    }
    
    return {
        totalViolations: totalViolations,
        appsWithViolations: violationLogs.size,
        byType: byType,
        timestamp: new Date().toISOString()
    };
}

// =============================================================================
// STATUS
// =============================================================================

/**
 * Get module status for health checks
 * @returns {object} Status object
 */
function getStatus() {
    let totalViolations = 0;
    const allViolations = violationLogs.values();
    for (const violations of allViolations) {
        totalViolations += violations.length;
    }
    
    return {
        active: true,
        healthy: true,
        details: {
            activeSandboxes: sandboxInstances.size,
            totalViolations: totalViolations,
            availablePermissions: Object.keys(SANDBOX_PERMISSIONS).length,
            permissionLevels: Object.keys(PERMISSION_LEVELS).length
        }
    };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    // Core functions
    createSandbox: createSandbox,
    createSandboxWithLevel: createSandboxWithLevel,
    validateSandboxOrigin: validateSandboxOrigin,
    revokeSandbox: revokeSandbox,
    getSandboxStatus: getSandboxStatus,
    updateSandboxPermissions: updateSandboxPermissions,
    
    // Utility functions
    getAllSandboxes: getAllSandboxes,
    getViolationStatistics: getViolationStatistics,
    
    // Status
    getStatus: getStatus,
    
    // Constants
    SANDBOX_PERMISSIONS: SANDBOX_PERMISSIONS,
    PERMISSION_LEVELS: PERMISSION_LEVELS
};
