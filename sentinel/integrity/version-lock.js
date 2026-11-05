/**
 * NovaSentinel Version Lock
 * 
 * This module prevents version downgrade attacks by maintaining a Security Version
 * Number (SVN) for each NovaSentinel module. It rejects requests to load older versions
 * that could contain security vulnerabilities that were patched.
 * 
 * SECURITY REQUIREMENTS:
 * - SVN stored in memory (never persisted to disk)
 * - Reject any version lower than stored SVN
 * - Call auditService.logEvent() with severity 'critical' on downgrade attempt
 * - Never allow version to be set lower than current
 * - Track version history for audit purposes
 * 
 * @module sentinel/integrity/version-lock
 */

'use strict';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default starting version for new modules */
const DEFAULT_VERSION = '1.0.0';

/** Environment variable prefix for SVN configuration */
const SVN_ENV_PREFIX = 'NOVA_SENTINEL_SVN_';

/** Maximum version history entries per module to retain */
const MAX_HISTORY_ENTRIES = 100;

// =============================================================================
// STATE
// =============================================================================

/** SVN storage: moduleName -> current version string */
const svnStore = new Map();

/** Version history: moduleName -> array of { version, timestamp, action } */
const versionHistory = new Map();

/** Modules that have been initialised */
const initialisedModules = new Set();

// =============================================================================
// VERSION PARSING & COMPARISON
// =============================================================================

/**
 * Parse a semantic version string into components.
 * 
 * @param {string} version - Version string in format "major.minor.patch"
 * @returns {{ major: number, minor: number, patch: number, raw: string }} Parsed version
 * @throws {Error} If version format is invalid
 */
function parseVersion(version) {
    if (typeof version !== 'string') {
        throw new Error('Version must be a string');
    }
    
    const parts = version.split('.');
    if (parts.length < 2 || parts.length > 3) {
        throw new Error(`Invalid version format: ${version}. Expected major.minor.patch`);
    }
    
    const major = parseInt(parts[0], 10);
    const minor = parseInt(parts[1], 10);
    const patch = parts.length > 2 ? parseInt(parts[2], 10) : 0;
    
    if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
        throw new Error(`Invalid version numbers: ${version}`);
    }
    
    if (major < 0 || minor < 0 || patch < 0) {
        throw new Error(`Version numbers cannot be negative: ${version}`);
    }
    
    return { major, minor, patch, raw: version };
}

/**
 * Compare two semantic versions.
 * 
 * @param {string} versionA - First version string
 * @param {string} versionB - Second version string
 * @returns {number} -1 if A < B, 0 if A == B, 1 if A > B
 * @throws {Error} If either version is invalid
 */
function compareVersions(versionA, versionB) {
    const parsedA = parseVersion(versionA);
    const parsedB = parseVersion(versionB);
    
    if (parsedA.major !== parsedB.major) {
        return parsedA.major - parsedB.major;
    }
    
    if (parsedA.minor !== parsedB.minor) {
        return parsedA.minor - parsedB.minor;
    }
    
    return parsedA.patch - parsedB.patch;
}

// =============================================================================
// INITIALISATION
// =============================================================================

/**
 * Initialize SVN for a module from environment variable or default.
 * 
 * @param {string} moduleName - Name of the module
 * @returns {string} The initialized version
 */
function initializeModule(moduleName) {
    if (initialisedModules.has(moduleName)) {
        return svnStore.get(moduleName);
    }
    
    // Check for environment variable override
    const envVar = SVN_ENV_PREFIX + moduleName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const envVersion = process.env[envVar];
    
    let version;
    if (envVersion) {
        try {
            version = parseVersion(envVersion).raw;
        } catch (e) {
            console.warn(`[NovaSentinel] Invalid SVN in ${envVar}: ${envVersion}. Using default.`);
            version = DEFAULT_VERSION;
        }
    } else {
        version = DEFAULT_VERSION;
    }
    
    svnStore.set(moduleName, version);
    versionHistory.set(moduleName, [{
        version,
        timestamp: new Date().toISOString(),
        action: 'initialised'
    }]);
    initialisedModules.add(moduleName);
    
    console.log(`[NovaSentinel] SVN initialised for ${moduleName}: ${version}`);
    
    return version;
}

/**
 * Ensure a module is initialised before access.
 * 
 * @param {string} moduleName - Name of the module
 */
function ensureInitialised(moduleName) {
    if (!initialisedModules.has(moduleName)) {
        initializeModule(moduleName);
    }
}

// =============================================================================
// AUDIT LOGGING
// =============================================================================

/**
 * Log a security event to the audit service.
 * Handles case where auditService may not be available yet.
 * 
 * @param {string} event - Event type/action
 * @param {object} data - Event data
 */
function logSecurityEvent(event, data = {}) {
    try {
        if (typeof auditService !== 'undefined' && auditService && typeof auditService.logEvent === 'function') {
            auditService.logEvent(event, data);
        }
    } catch (e) {
        // Audit logging should never break functionality
        console.error('[NovaSentinel] Failed to log security event:', e.message);
    }
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Check if a module version meets the minimum SVN requirement.
 * Rejects version downgrade attempts.
 * 
 * @param {string} moduleName - Name of the module
 * @param {string} version - Version to check
 * @returns {{ valid: boolean, currentVersion: string, message?: string }}
 * @throws {Error} If moduleName or version is invalid
 */
function checkVersion(moduleName, version) {
    if (!moduleName || typeof moduleName !== 'string') {
        throw new Error('Module name is required');
    }
    
    if (!version || typeof version !== 'string') {
        throw new Error('Version is required');
    }
    
    // Ensure module is initialised
    ensureInitialised(moduleName);
    
    const currentVersion = svnStore.get(moduleName);
    const comparison = compareVersions(version, currentVersion);
    
    if (comparison < 0) {
        // Version is lower than current SVN - reject with CRITICAL audit
        logSecurityEvent('VERSION_DOWNGRADE_ATTEMPT', {
            severity: 'critical',
            module: moduleName,
            attemptedVersion: version,
            currentVersion: currentVersion,
            action: 'rejected',
            timestamp: new Date().toISOString()
        });
        
        return {
            valid: false,
            currentVersion,
            message: `Version ${version} is lower than minimum required version ${currentVersion}. Downgrade rejected.`
        };
    }
    
    // Version is valid (equal or higher)
    return {
        valid: true,
        currentVersion,
        message: comparison === 0 
            ? `Version ${version} matches current SVN` 
            : `Version ${version} is higher than current SVN ${currentVersion}`
    };
}

/**
 * Bump the Security Version Number for a module after a security patch.
 * Increments the patch version by default.
 * 
 * @param {string} moduleName - Name of the module
 * @param {string} [bumpType='patch'] - Type of bump: 'major', 'minor', or 'patch'
 * @param {string} [newVersion] - Optional explicit version (overrides bumpType)
 * @returns {{ previousVersion: string, newVersion: string }}
 * @throws {Error} If moduleName is invalid or bumpType is not recognized
 */
function bumpSVN(moduleName, bumpType = 'patch', newVersion = null) {
    if (!moduleName || typeof moduleName !== 'string') {
        throw new Error('Module name is required');
    }
    
    // Ensure module is initialised
    ensureInitialised(moduleName);
    
    const currentVersion = svnStore.get(moduleName);
    const parsed = parseVersion(currentVersion);
    
    let bumpedVersion;
    
    if (newVersion) {
        // Explicit version provided - validate it's higher
        const comparison = compareVersions(newVersion, currentVersion);
        if (comparison <= 0) {
            throw new Error(`New version ${newVersion} must be higher than current ${currentVersion}`);
        }
        bumpedVersion = newVersion;
    } else {
        // Calculate bumped version based on type
        switch (bumpType.toLowerCase()) {
            case 'major':
                bumpedVersion = `${parsed.major + 1}.0.0`;
                break;
            case 'minor':
                bumpedVersion = `${parsed.major}.${parsed.minor + 1}.0`;
                break;
            case 'patch':
                bumpedVersion = `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
                break;
            default:
                throw new Error(`Invalid bump type: ${bumpType}. Use 'major', 'minor', or 'patch'`);
        }
    }
    
    // Update SVN
    svnStore.set(moduleName, bumpedVersion);
    
    // Record in history
    const history = versionHistory.get(moduleName);
    history.push({
        version: bumpedVersion,
        timestamp: new Date().toISOString(),
        action: 'bumped',
        bumpType: newVersion ? 'explicit' : bumpType,
        previousVersion: currentVersion
    });
    
    // Trim history if too large
    if (history.length > MAX_HISTORY_ENTRIES) {
        history.shift();
    }
    
    console.log(`[NovaSentinel] SVN bumped for ${moduleName}: ${currentVersion} -> ${bumpedVersion}`);
    
    // Log the version bump
    logSecurityEvent('VERSION_BUMPED', {
        module: moduleName,
        previousVersion: currentVersion,
        newVersion: bumpedVersion,
        bumpType: newVersion ? 'explicit' : bumpType,
        timestamp: new Date().toISOString()
    });
    
    return {
        previousVersion: currentVersion,
        newVersion: bumpedVersion
    };
}

/**
 * Get version status for all modules.
 * Returns status suitable for dashboard display.
 * 
 * @returns {object} Object containing all module versions and history
 */
function getVersionStatus() {
    const modules = {};
    
    for (const [moduleName, version] of svnStore) {
        const history = versionHistory.get(moduleName) || [];
        modules[moduleName] = {
            currentVersion: version,
            historyLength: history.length,
            recentHistory: history.slice(-5), // Last 5 entries
            initialised: initialisedModules.has(moduleName)
        };
    }
    
    return {
        totalModules: svnStore.size,
        modules,
        timestamp: new Date().toISOString()
    };
}

/**
 * Get overall system status (for module export).
 * 
 * @returns {object} Status object with active and healthy flags
 */
function getStatus() {
    return {
        active: true,
        healthy: true,
        details: {
            trackedModules: svnStore.size,
            initialisedModules: initialisedModules.size
        }
    };
}

/**
 * Get the version history for a specific module.
 * 
 * @param {string} moduleName - Name of the module
 * @param {number} [limit=10] - Maximum entries to return
 * @returns {Array} Version history entries
 * @throws {Error} If moduleName is not provided
 */
function getVersionHistory(moduleName, limit = 10) {
    if (!moduleName || typeof moduleName !== 'string') {
        throw new Error('Module name is required');
    }
    
    ensureInitialised(moduleName);
    
    const history = versionHistory.get(moduleName) || [];
    return history.slice(-limit);
}

/**
 * Force set a module's SVN (for testing or recovery scenarios).
 * Only allows setting to a higher version.
 * 
 * @param {string} moduleName - Name of the module
 * @param {string} version - Version to set
 * @returns {{ previousVersion: string, newVersion: string }}
 * @throws {Error} If moduleName or version is invalid
 */
function forceSetVersion(moduleName, version) {
    if (!moduleName || typeof moduleName !== 'string') {
        throw new Error('Module name is required');
    }
    
    // Validate version format
    parseVersion(version);
    
    ensureInitialised(moduleName);
    
    const currentVersion = svnStore.get(moduleName);
    const comparison = compareVersions(version, currentVersion);
    
    if (comparison <= 0) {
        throw new Error(`Cannot set version to ${version}: must be higher than current ${currentVersion}`);
    }
    
    svnStore.set(moduleName, version);
    
    const history = versionHistory.get(moduleName);
    history.push({
        version,
        timestamp: new Date().toISOString(),
        action: 'force_set',
        previousVersion: currentVersion
    });
    
    if (history.length > MAX_HISTORY_ENTRIES) {
        history.shift();
    }
    
    console.log(`[NovaSentinel] SVN force-set for ${moduleName}: ${currentVersion} -> ${version}`);
    
    logSecurityEvent('VERSION_FORCE_SET', {
        module: moduleName,
        previousVersion: currentVersion,
        newVersion: version,
        timestamp: new Date().toISOString()
    });
    
    return {
        previousVersion: currentVersion,
        newVersion: version
    };
}

// =============================================================================
// MODULE EXPORTS
// =============================================================================

module.exports = {
    checkVersion,
    bumpSVN,
    getVersionStatus,
    getStatus,
    getVersionHistory,
    forceSetVersion,
    // Utility functions exposed for testing
    parseVersion,
    compareVersions,
    initializeModule
};
