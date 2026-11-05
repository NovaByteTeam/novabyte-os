/**
 * NovaSentinel Isolation - Per-Module Access Control
 * 
 * This module implements per-module access control for NovaSentinel,
 * following the principle of least privilege.
 * 
 * SECURITY REQUIREMENTS:
 * - Default deny all - explicit grants required
 * - Call auditService.logEvent() for all permission changes
 * - Use Map for storing permission matrix
 * - Resource categories: crypto, auth, storage, network, system
 * 
 * @module sentinel/isolation/permissions
 */

'use strict';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Resource categories */
const RESOURCE_CATEGORIES = {
    CRYPTO: 'crypto',
    AUTH: 'auth',
    STORAGE: 'storage',
    NETWORK: 'network',
    SYSTEM: 'system'
};

/** Valid actions */
const VALID_ACTIONS = ['read', 'write', 'execute', 'delete', 'admin'];

// =============================================================================
// STATE
// =============================================================================

/** Permission matrix: Map<module, Map<resource, Set<action>>> */
const permissionMatrix = new Map();

/** Permission audit log for tracking all checks */
const permissionAuditLog = [];

/** Maximum audit log entries to retain */
const MAX_AUDIT_ENTRIES = 1000;

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Validate module name
 * @param {string} module - Module name
 * @returns {boolean}
 */
function isValidModule(module) {
    return typeof module === 'string' && module.length > 0 && module.length <= 64;
}

/**
 * Validate resource name
 * @param {string} resource - Resource name
 * @returns {boolean}
 */
function isValidResource(resource) {
    return typeof resource === 'string' && resource.length > 0 && resource.length <= 128;
}

/**
 * Validate action
 * @param {string} action - Action name
 * @returns {boolean}
 */
function isValidAction(action) {
    return VALID_ACTIONS.includes(action);
}

/**
 * Get or create module permission map
 * @param {string} module - Module name
 * @returns {Map}
 */
function getModulePermissions(module) {
    if (!permissionMatrix.has(module)) {
        permissionMatrix.set(module, new Map());
    }
    return permissionMatrix.get(module);
}

/**
 * Get or create resource action set
 * @param {Map} modulePerms - Module permission map
 * @param {string} resource - Resource name
 * @returns {Set}
 */
function getResourceActions(modulePerms, resource) {
    if (!modulePerms.has(resource)) {
        modulePerms.set(resource, new Set());
    }
    return modulePerms.get(resource);
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Check if a module has permission for a resource action
 * Implements principle of least privilege - default deny all
 * 
 * @param {string} module - Module name requesting access
 * @param {string} resource - Resource being accessed
 * @param {string} action - Action being performed
 * @returns {string} 'allow' or 'deny'
 */
function checkPermission(module, resource, action) {
    // Validate inputs
    if (!isValidModule(module) || !isValidResource(resource) || !isValidAction(action)) {
        return 'deny';
    }

    const modulePerms = permissionMatrix.get(module);
    if (!modulePerms) {
        // No permissions defined for this module - default deny
        return 'deny';
    }

    const resourceActions = modulePerms.get(resource);
    if (!resourceActions) {
        // No permissions defined for this resource - default deny
        return 'deny';
    }

    const result = resourceActions.has(action) ? 'allow' : 'deny';
    return result;
}

/**
 * Grant a permission to a module at runtime
 * 
 * @param {string} module - Module to grant permission to
 * @param {string} resource - Resource to grant access to
 * @param {string} action - Action to grant
 * @returns {object} Result with success status
 */
function grantPermission(module, resource, action) {
    // Validate inputs
    if (!isValidModule(module)) {
        return { success: false, error: 'Invalid module name' };
    }
    if (!isValidResource(resource)) {
        return { success: false, error: 'Invalid resource name' };
    }
    if (!isValidAction(action)) {
        return { success: false, error: 'Invalid action' };
    }

    const modulePerms = getModulePermissions(module);
    const resourceActions = getResourceActions(modulePerms, resource);
    
    const wasGranted = resourceActions.has(action);
    resourceActions.add(action);

    // Log the permission change
    logPermissionChange('grant', module, resource, action);

    return { 
        success: true, 
        granted: !wasGranted,
        module,
        resource,
        action
    };
}

/**
 * Revoke a permission from a module at runtime
 * 
 * @param {string} module - Module to revoke permission from
 * @param {string} resource - Resource to revoke access to
 * @param {string} action - Action to revoke
 * @returns {object} Result with success status
 */
function revokePermission(module, resource, action) {
    // Validate inputs
    if (!isValidModule(module)) {
        return { success: false, error: 'Invalid module name' };
    }
    if (!isValidResource(resource)) {
        return { success: false, error: 'Invalid resource name' };
    }
    if (!isValidAction(action)) {
        return { success: false, error: 'Invalid action' };
    }

    const modulePerms = permissionMatrix.get(module);
    if (!modulePerms) {
        return { success: false, error: 'Module not found' };
    }

    const resourceActions = modulePerms.get(resource);
    if (!resourceActions) {
        return { success: false, error: 'Resource not found' };
    }

    const wasRevoked = resourceActions.has(action);
    resourceActions.delete(action);

    // Log the permission change
    logPermissionChange('revoke', module, resource, action);

    return { 
        success: true, 
        revoked: wasRevoked,
        module,
        resource,
        action
    };
}

/**
 * Log all permission checks for audit trail
 * 
 * @param {string} module - Module making the request
 * @param {string} resource - Resource being accessed
 * @param {string} action - Action being performed
 * @param {string} result - 'allow' or 'deny'
 */
function auditPermissionCheck(module, resource, action, result) {
    const entry = {
        timestamp: new Date().toISOString(),
        module,
        resource,
        action,
        result,
        type: 'permission_check'
    };

    // Add to audit log
    permissionAuditLog.push(entry);

    // Trim if exceeds max entries
    while (permissionAuditLog.length > MAX_AUDIT_ENTRIES) {
        permissionAuditLog.shift();
    }
}

/**
 * Log permission changes to audit service
 * 
 * @param {string} type - 'grant' or 'revoke'
 * @param {string} module - Module name
 * @param {string} resource - Resource name
 * @param {string} action - Action name
 */
function logPermissionChange(type, module, resource, action) {
    // eslint-disable-next-line no-undef
    if (typeof auditService !== 'undefined' && auditService && typeof auditService.logEvent === 'function') {
        // eslint-disable-next-line no-undef
        auditService.logEvent({
            action: type === 'grant' ? 'permission_grant' : 'permission_revoke',
            module,
            resource,
            action,
            timestamp: new Date().toISOString()
        }, {
            type,
            module,
            resource,
            action
        });
    }
}

/**
 * Get the full permission matrix for dashboard display
 * 
 * @returns {object} Permission matrix
 */
function getPermissionMatrix() {
    const matrix = {};
    
    for (const [module, modulePerms] of permissionMatrix.entries()) {
        matrix[module] = {};
        for (const [resource, actions] of modulePerms.entries()) {
            matrix[module][resource] = Array.from(actions);
        }
    }

    return {
        matrix,
        categories: RESOURCE_CATEGORIES,
        actions: VALID_ACTIONS,
        totalModules: permissionMatrix.size,
        timestamp: new Date().toISOString()
    };
}

/**
 * Get status information for health checks
 * 
 * @returns {object} Status object
 */
function getStatus() {
    return {
        active: true,
        healthy: true,
        details: {
            modulesCount: permissionMatrix.size,
            auditLogEntries: permissionAuditLog.length,
            categories: Object.keys(RESOURCE_CATEGORIES).length,
            supportedActions: VALID_ACTIONS.length
        }
    };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    // Core functions
    checkPermission,
    grantPermission,
    revokePermission,
    auditPermissionCheck,
    getPermissionMatrix,
    
    // Status
    getStatus,
    
    // Constants
    RESOURCE_CATEGORIES,
    VALID_ACTIONS
};
