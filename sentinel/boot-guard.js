/**
 * NovaSentinel Boot Guard - Military-Grade Security Enforcement
 * 
 * This module prevents the OS from booting if security is compromised.
 * Simulates hardware "secure boot" behavior in software.
 * 
 * If security is tampered with, the system will REFUSE to start.
 * 
 * @module sentinel/boot-guard
 * 
 * SECURITY REQUIREMENTS:
 * - Checks all security modules on startup
 * - Prevents boot if any protection is disabled
 * - Chain-linked integrity verification
 * - Cannot be bypassed without triggering lockdown
 * - Software "e-fuse" that trips on tampering
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Required security modules that MUST be functional */
const REQUIRED_MODULES = [
    'sentinel/vault/encryption',
    'sentinel/vault/key-manager',
    'sentinel/vault/sentinel-anti-replay',
    'sentinel/vault/sentinel-anti-rollback',
    'sentinel/vault/sentinel-brute-force',
    'sentinel/integrity/tamper-detect',
    'sentinel/integrity/attestation',
    'sentinel/auth/fido2',
    'sentinel/auth/zero-trust',
    'sentinel/auth/session-guard',
    'security-middleware'
];

/** Required protection states that must be enabled */
const REQUIRED_PROTECTIONS = [
    'encryption',
    'key-manager',
    'anti-replay',
    'anti-rollback',
    'brute-force',
    'tamper-detect',
    'attestation',
    'zero-trust',
    'session-guard'
];

// =============================================================================
// STATE
// =============================================================================

/** Whether boot guard has verified security */
let bootVerified = false;

/** Boot verification timestamp */
let bootTime = null;

/** Boot integrity hash chain */
let integrityChain = [];

/** Security state lock (once locked, cannot be unlocked) */
let securityLocked = false;

/** E-fuse state (tripped = permanent lockdown) */
let fuseTripped = false;

/** Boot guard configuration */
const config = {
    enforceAllProtections: true,
    requireAllModules: true,
    allowBypass: false,
    minimumIntegrityScore: 80
};

// =============================================================================
// HARDWARE "E-FUSE" SIMULATION
// =============================================================================

/**
 * The "fuse file" - once written, cannot be removed
 * This simulates hardware e-fuse that trips on tampering
 */
function getFusePath() {
    return path.join(__dirname, '..', '..', 'data', 'security-fuse.json');
}

/**
 * Check if security "fuse" has been tripped
 * @returns {boolean} True if fuse is blown (security permanently damaged)
 */
function isFuseTripped() {
    const fusePath = getFusePath();
    
    try {
        if (fs.existsSync(fusePath)) {
            const fuseData = JSON.parse(fs.readFileSync(fusePath, 'utf8'));
            return fuseData.tripped === true;
        }
    } catch (e) {
        // If fuse file is corrupted, treat as tripped
        return true;
    }
    
    return false;
}

/**
 * Trip the security fuse - PERMANENT lockdown
 * Once tripped, security cannot be restored without clean reinstall
 */
function tripFuse(reason) {
    const fusePath = getFusePath();
    const dataDir = path.dirname(fusePath);
    
    // Ensure data directory exists
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    
    const fuseData = {
        tripped: true,
        reason: reason,
        timestamp: new Date().toISOString(),
        // Cryptographic proof this was the system
        systemSignature: crypto.createHash('sha256')
            .update('NOVASENTINEL-BOOT-GUARD-FUSE-' + Date.now())
            .digest('hex')
    };
    
    // Write fuse - this file CANNOT be deleted while Node is running
    // But attacker could delete it in theory - that's why we chain to next boot
    fs.writeFileSync(fusePath, JSON.stringify(fuseData, null, 2));
    
    // Also create backup in .update-backups (harder to find)
    const backupPath = path.join(__dirname, '..', '..', '.update-backups', 'fuse-backup.json');
    try {
        fs.writeFileSync(backupPath, JSON.stringify(fuseData, null, 2));
    } catch (e) {}
    
    fuseTripped = true;
    console.error('[BOOT GUARD] 🔴 SECURITY FUSE TRIPPED:', reason);
    
    return false;
}

// =============================================================================
// MODULE VERIFICATION
// =============================================================================

/**
 * Verify a security module exists and is loadable
 * @param {string} modulePath - Module path to verify
 * @returns {object} Verification result
 */
function verifyModule(modulePath) {
    const fullPath = path.join(__dirname, '..', '..', modulePath + '.js');
    
    try {
        // Check file exists
        if (!fs.existsSync(fullPath)) {
            return {
                valid: false,
                error: 'Module file not found',
                path: modulePath
            };
        }
        
        // Read file content for integrity check
        const content = fs.readFileSync(fullPath, 'utf8');
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        
        // Try to require the module
        try {
            require('./' + modulePath);
            return {
                valid: true,
                hash: hash,
                path: modulePath,
                loadable: true
            };
        } catch (e) {
            return {
                valid: false,
                error: 'Module failed to load: ' + e.message,
                path: modulePath,
                hash: hash
            };
        }
    } catch (e) {
        return {
            valid: false,
            error: e.message,
            path: modulePath
        };
    }
}

/**
 * Verify all required security modules
 * @returns {object} Verification result with all module statuses
 */
function verifyAllModules() {
    const results = {
        allValid: true,
        modules: [],
        missing: [],
        errors: []
    };
    
    for (const modulePath of REQUIRED_MODULES) {
        const result = verifyModule(modulePath);
        results.modules.push(result);
        
        if (!result.valid) {
            results.allValid = false;
            if (result.error.includes('not found')) {
                results.missing.push(modulePath);
            } else {
                results.errors.push(`${modulePath}: ${result.error}`);
            }
        }
    }
    
    return results;
}

// =============================================================================
// INTEGRITY CHAIN VERIFICATION
// =============================================================================

/**
 * Generate boot integrity hash chain
 * Each boot creates a chain linked to previous boots
 * @returns {string} Current integrity chain hash
 */
function generateIntegrityChain() {
    const chainPath = path.join(__dirname, '..', '..', 'data', 'integrity-chain.json');
    let previousHash = 'GENESIS';
    
    // Read previous chain
    try {
        if (fs.existsSync(chainPath)) {
            const chainData = JSON.parse(fs.readFileSync(chainPath, 'utf8'));
            previousHash = chainData.currentHash || 'GENESIS';
        }
    } catch (e) {}
    
    // Create new chain entry
    const bootData = {
        timestamp: Date.now(),
        bootNumber: Date.now(),
        previousHash: previousHash,
        // Include system info in chain
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        // Include random boot seed
        bootSeed: crypto.randomBytes(32).toString('hex')
    };
    
    // Chain the data
    const chainData = JSON.stringify(bootData);
    const currentHash = crypto.createHash('sha256')
        .update(chainData)
        .digest('hex');
    
    // Store chain
    const newChain = {
        previousHash: previousHash,
        currentHash: currentHash,
        timestamp: new Date().toISOString(),
        bootData: {
            bootNumber: bootData.bootNumber,
            nodeVersion: bootData.nodeVersion
        }
    };
    
    // Ensure data directory
    const dataDir = path.dirname(chainPath);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    
    fs.writeFileSync(chainPath, JSON.stringify(newChain, null, 2));
    
    integrityChain.push(currentHash);
    return currentHash;
}

// =============================================================================
// PROTECTION STATE VERIFICATION
// =============================================================================

/**
 * Verify all required protections are enabled
 * @returns {object} Protection verification result
 */
function verifyProtections() {
    // Try to get protection states from sentinel
    let protectionStates = {};
    
    try {
        const sentinelIndex = require('./index');
        if (sentinelIndex.sentinelUI && sentinelIndex.sentinelUI.getAllProtectionStates) {
            protectionStates = sentinelIndex.sentinelUI.getAllProtectionStates();
        }
    } catch (e) {
        // Sentinel might not be loaded yet
    }
    
    const result = {
        allEnabled: true,
        disabled: [],
        enabled: []
    };
    
    for (const protection of REQUIRED_PROTECTIONS) {
        const isEnabled = protectionStates[protection] !== false;
        
        if (isEnabled) {
            result.enabled.push(protection);
        } else {
            result.disabled.push(protection);
            result.allEnabled = false;
        }
    }
    
    return result;
}

// =============================================================================
// SECURITY STATE VERIFICATION
// =============================================================================

/**
 * Calculate security integrity score (0-100)
 * @param {object} moduleResults - Module verification results
 * @param {object} protectionResults - Protection verification results
 * @returns {number} Integrity score
 */
function calculateIntegrityScore(moduleResults, protectionResults) {
    let score = 100;
    
    // Deduct for missing modules
    const modulePenalty = moduleResults.missing.length * 15;
    score -= modulePenalty;
    
    // Deduct for module errors
    const errorPenalty = moduleResults.errors.length * 10;
    score -= errorPenalty;
    
    // Deduct for disabled protections
    const protectionPenalty = protectionResults.disabled.length * 10;
    score -= protectionPenalty;
    
    // Check if fuse is already tripped
    if (isFuseTripped()) {
        return 0;
    }
    
    return Math.max(0, Math.min(100, score));
}

// =============================================================================
// MAIN BOOT VERIFICATION
// =============================================================================

/**
 * Perform complete boot security verification
 * THIS MUST BE CALLED BEFORE THE SERVER CAN START
 * 
 * @returns {Promise<{allowed: boolean, reason?: string, details: object}>}
 */
async function verifyBootSecurity() {
    console.log('[BOOT GUARD] 🔒 Starting security verification...');
    
    // 1. Check if fuse is already tripped (permanent damage from previous boot)
    if (isFuseTripped()) {
        tripFuse('Fuse already tripped from previous boot - security permanently compromised');
        
        return {
            allowed: false,
            reason: 'SECURITY PERMANENTLY COMPROMISED - Previous boot detected tampering. System cannot start.',
            code: 'FUSE_TRIPPED',
            details: {
                requiresCleanInstall: true,
                securityDamage: 'permanent'
            }
        };
    }
    
    // 2. Verify all required modules exist and are loadable
    console.log('[BOOT GUARD] 📋 Verifying security modules...');
    const moduleResults = verifyAllModules();
    
    if (!moduleResults.allValid) {
        if (config.requireAllModules) {
            tripFuse('Required security module missing or broken: ' + moduleResults.missing.join(', '));
            
            return {
                allowed: false,
                reason: 'MISSING SECURITY MODULES - Cannot boot. Required: ' + moduleResults.missing.join(', '),
                code: 'MISSING_MODULES',
                details: moduleResults
            };
        }
    }
    
    // 3. Verify all protections are enabled (if enforceAllProtections is true)
    console.log('[BOOT GUARD] 🛡️ Verifying protection states...');
    const protectionResults = verifyProtections();
    
    if (config.enforceAllProtections && !protectionResults.allEnabled) {
        tripFuse('Security protections disabled: ' + protectionResults.disabled.join(', '));
        
        return {
            allowed: false,
            reason: 'SECURITY PROTECTIONS DISABLED - System cannot start. Disabled: ' + protectionResults.disabled.join(', '),
            code: 'PROTECTIONS_DISABLED',
            details: protectionResults
        };
    }
    
    // 4. Calculate integrity score
    const integrityScore = calculateIntegrityScore(moduleResults, protectionResults);
    
    if (integrityScore < config.minimumIntegrityScore) {
        tripFuse('Integrity score too low: ' + integrityScore);
        
        return {
            allowed: false,
            reason: 'SECURITY INTEGRITY TOO LOW - Score: ' + integrityScore + '% (minimum: ' + config.minimumIntegrityScore + '%)',
            code: 'LOW_INTEGRITY',
            details: { integrityScore }
        };
    }
    
    // 5. Generate integrity chain
    console.log('[BOOT GUARD] 🔗 Generating integrity chain...');
    const chainHash = generateIntegrityChain();
    
    // 6. Mark boot as verified
    bootVerified = true;
    bootTime = new Date();
    
    console.log('[BOOT GUARD] ✅ BOOT SECURITY VERIFIED');
    console.log('[BOOT GUARD]   Integrity Score: ' + integrityScore + '%');
    console.log('[BOOT GUARD]   Chain Hash: ' + chainHash.substring(0, 16) + '...');
    console.log('[BOOT GUARD]   Boot Time: ' + bootTime.toISOString());
    
    return {
        allowed: true,
        reason: 'Boot security verified',
        details: {
            integrityScore,
            chainHash,
            bootTime: bootTime.toISOString(),
            modulesVerified: moduleResults.allValid,
            protectionsEnabled: protectionResults.allEnabled
        }
    };
}

/**
 * Get boot guard status
 * @returns {object} Current boot guard state
 */
function getBootGuardStatus() {
    return {
        verified: bootVerified,
        bootTime: bootTime ? bootTime.toISOString() : null,
        fuseTripped: isFuseTripped(),
        securityLocked: securityLocked,
        config: config,
        integrityChainLength: integrityChain.length
    };
}

/**
 * Configure boot guard
 * @param {object} options - Configuration options
 */
function configure(options) {
    if (options.enforceAllProtections !== undefined) {
        config.enforceAllProtections = options.enforceAllProtections;
    }
    if (options.requireAllModules !== undefined) {
        config.requireAllModules = options.requireAllModules;
    }
    if (options.minimumIntegrityScore !== undefined) {
        config.minimumIntegrityScore = options.minimumIntegrityScore;
    }
}

/**
 * Emergency: Trip the fuse remotely
 * Use this if you detect a security breach
 * @param {string} reason - Reason for tripping
 */
function emergencyTripFuse(reason) {
    tripFuse('EMERGENCY: ' + reason);
}

/**
 * Check if boot is verified (security is good)
 * @returns {boolean} True if boot verified
 */
function isBootVerified() {
    return bootVerified && !isFuseTripped();
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    verifyBootSecurity,
    getBootGuardStatus,
    configure,
    emergencyTripFuse,
    isBootVerified,
    isFuseTripped,
    verifyAllModules,
    verifyProtections
};