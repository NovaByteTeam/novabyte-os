/**
 * NovaSentinel File Integrity Monitor
 * 
 * This module provides real-time file integrity monitoring for critical NovaByte OS
 * server files. It detects unauthorized modifications that may indicate tampering,
 * compromise, or malicious activity.
 * 
 * SECURITY REQUIREMENTS:
 * - Baseline hashes stored in memory only (never written to disk)
 * - All file reads wrapped in try/catch with graceful error handling
 * - Missing files treated as potential tamper events
 * - Critical audit logging on tamper detection
 * - Configurable file list and monitoring interval
 * 
 * @module sentinel/integrity/tamper-detect
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default monitoring interval in milliseconds (30 seconds) */
const DEFAULT_MONITOR_INTERVAL = 30000;

/** Maximum time to wait for file read (ms) */
const FILE_READ_TIMEOUT = 5000;

/** Critical files to monitor by default */
const DEFAULT_CRITICAL_FILES = [
    'server.js',
    'auth-routes.js',
    'auth-service.js',
    'security-middleware.js',
    'account-service.js'
];

// =============================================================================
// STATE
// =============================================================================

/** Baseline hash map: filePath -> hash */
const baselineHashes = new Map();

/** Current file status: filePath -> { hash, lastChecked, status } */
const fileStatus = new Map();

/** Background monitoring interval ID */
let monitorInterval = null;

/** Whether integrity monitoring is active */
let isMonitoring = false;

/** Last integrity check timestamp */
let lastCheckTime = null;

/** Overall system health status */
let systemHealthy = true;

/** Event emitter for real-time updates */
const integrityEmitter = new EventEmitter();

/** Files currently being monitored */
let monitoredFiles = [];

// =============================================================================
// AUDIT LOGGING
// =============================================================================

/**
 * Log a security event to the audit service.
 * Handles case where auditService may not be available yet.
 * 
 * @param {string} action - Event action type
 * @param {string} level - Log level (info, warning, error, critical)
 * @param {string} message - Event message
 * @param {object} metadata - Additional metadata
 */
function logSecurityEvent(action, level, message, metadata = {}) {
    try {
        if (typeof auditService !== 'undefined' && auditService && typeof auditService.log === 'function') {
            auditService.log({
                action: action,
                resource: 'integrity-monitor',
                level: level,
                success: level !== 'critical',
                metadata: {
                    message: message,
                    ...metadata
                }
            });
        }
    } catch (e) {
        // Audit logging should never break functionality
        console.error('[NovaSentinel] Failed to log audit event:', e.message);
    }
}

// =============================================================================
// FILE HASHING
// =============================================================================

/**
 * Compute SHA-256 hash of a file's contents.
 * 
 * @param {string} filePath - Absolute or relative path to file
 * @returns {Promise<string>} Hex-encoded SHA-256 hash
 * @throws {Error} If file cannot be read
 */
async function computeFileHash(filePath) {
    try {
        // Resolve relative paths against project root
        const resolvedPath = path.isAbsolute(filePath) 
            ? filePath 
            : path.resolve(process.cwd(), filePath);
        
        // Check if file exists
        await fs.promises.access(resolvedPath, fs.constants.R_OK);
        
        // Read file contents
        const fileContent = await fs.promises.readFile(resolvedPath);
        
        // Compute SHA-256 hash
        const hash = crypto.createHash('sha256');
        hash.update(fileContent);
        
        return hash.digest('hex');
    } catch (error) {
        throw new Error(`Failed to hash file ${filePath}: ${error.message}`);
    }
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Measure and hash all critical files, establishing the integrity baseline.
 * This must be called on server startup before any integrity checks.
 * 
 * @param {string[]} fileList - Optional custom file list to monitor
 * @returns {Promise<Map<string, string>>} Map of file paths to their hashes
 * @throws {Error} If baseline measurement fails
 */
async function measureFiles(fileList = null) {
    const filesToMeasure = fileList || DEFAULT_CRITICAL_FILES;
    
    // Add sentinel/* files to monitoring list
    const sentinelFiles = [
        'sentinel/crypto/entropy.js',
        'sentinel/crypto/virtual-tpm.js',
        'sentinel/vault/encryption.js'
    ];
    
    // Combine and deduplicate file list
    const allFiles = [...new Set([...filesToMeasure, ...sentinelFiles])];
    
    console.log('[NovaSentinel] Measuring integrity baseline for', allFiles.length, 'files');
    
    // Clear existing baseline
    baselineHashes.clear();
    fileStatus.clear();
    monitoredFiles = allFiles;
    
    const errors = [];
    
    // Hash each file and store baseline
    for (const filePath of allFiles) {
        try {
            const hash = await computeFileHash(filePath);
            baselineHashes.set(filePath, hash);
            fileStatus.set(filePath, {
                hash: hash,
                baselineHash: hash,
                lastChecked: new Date().toISOString(),
                status: 'ok',
                error: null
            });
        } catch (error) {
            // File read error - treat as potential tamper or deletion
            console.error('[NovaSentinel] Failed to measure file:', filePath, error.message);
            baselineHashes.set(filePath, null);
            fileStatus.set(filePath, {
                hash: null,
                baselineHash: null,
                lastChecked: new Date().toISOString(),
                status: 'error',
                error: error.message
            });
            errors.push({ file: filePath, error: error.message });
        }
    }
    
    lastCheckTime = new Date().toISOString();
    
    // Log baseline creation
    if (errors.length > 0) {
        logSecurityEvent('integrity_baseline_warning', 'warning', 
            'Some files could not be hashed during baseline creation', 
            { failedFiles: errors.map(e => e.file) }
        );
    } else {
        logSecurityEvent('integrity_baseline', 'info', 
            'Integrity baseline established', 
            { fileCount: allFiles.length }
        );
    }
    
    console.log('[NovaSentinel] Integrity baseline established for', 
        allFiles.length - errors.length, 'files');
    
    return new Map(baselineHashes);
}

/**
 * Verify integrity of all monitored files against the baseline.
 * Compares current hashes to baseline and detects any modifications.
 * 
 * @returns {Promise<{tampered: string[], missing: string[], ok: string[], errors: string[]}>}
 *          Object containing arrays of tampered, missing, ok, and error files
 */
async function verifyIntegrity() {
    if (baselineHashes.size === 0) {
        throw new Error('Integrity baseline not established. Call measureFiles() first.');
    }
    
    console.log('[NovaSentinel] Verifying file integrity...');
    
    const result = {
        tampered: [],
        missing: [],
        ok: [],
        errors: []
    };
    
    lastCheckTime = new Date().toISOString();
    systemHealthy = true;
    
    for (const [filePath, baselineHash] of baselineHashes) {
        try {
            const currentHash = await computeFileHash(filePath);
            const status = fileStatus.get(filePath);
            
            if (currentHash === baselineHash) {
                // File is intact
                result.ok.push(filePath);
                status.hash = currentHash;
                status.lastChecked = lastCheckTime;
                status.status = 'ok';
                status.error = null;
            } else {
                // File has been modified
                result.tampered.push(filePath);
                status.hash = currentHash;
                status.lastChecked = lastCheckTime;
                status.status = 'tampered';
                status.error = 'Hash mismatch - file modified';
                
                console.error('[NovaSentinel] TAMPER DETECTED:', filePath);
                
                // Emit tamper event
                integrityEmitter.emit('tamper', {
                    filePath,
                    baselineHash,
                    currentHash,
                    timestamp: lastCheckTime
                });
                
                // Log critical security event
                logSecurityEvent('security_event', 'critical',
                    `File integrity violation detected: ${filePath}`,
                    {
                        filePath,
                        baselineHash: baselineHash?.substring(0, 16) + '...',
                        currentHash: currentHash?.substring(0, 16) + '...',
                        eventType: 'tamper_detected'
                    }
                );
                
                systemHealthy = false;
            }
            
            fileStatus.set(filePath, status);
        } catch (error) {
            // File read error - could be missing or inaccessible
            const status = fileStatus.get(filePath);
            
            if (error.code === 'ENOENT') {
                // File is missing
                result.missing.push(filePath);
                status.status = 'missing';
                status.error = 'File not found';
                
                console.error('[NovaSentinel] FILE MISSING:', filePath);
                
                // Emit missing event
                integrityEmitter.emit('missing', {
                    filePath,
                    baselineHash,
                    timestamp: lastCheckTime
                });
                
                // Log critical security event
                logSecurityEvent('security_event', 'critical',
                    `Critical file missing: ${filePath}`,
                    {
                        filePath,
                        eventType: 'file_missing'
                    }
                );
                
                systemHealthy = false;
            } else {
                // Other error
                result.errors.push(filePath);
                status.status = 'error';
                status.error = error.message;
                
                console.error('[NovaSentinel] Error checking file:', filePath, error.message);
                
                logSecurityEvent('integrity_check_error', 'warning',
                    `Error verifying file integrity: ${filePath}`,
                    { filePath, error: error.message }
                );
            }
            
            status.lastChecked = lastCheckTime;
            fileStatus.set(filePath, status);
        }
    }
    
    // Emit overall status event
    integrityEmitter.emit('verifyComplete', {
        timestamp: lastCheckTime,
        healthy: systemHealthy,
        summary: result
    });
    
    console.log('[NovaSentinel] Integrity check complete:', 
        result.ok.length, 'ok,',
        result.tampered.length, 'tampered,',
        result.missing.length, 'missing,',
        result.errors.length, 'errors');
    
    return result;
}

/**
 * Start periodic background integrity monitoring.
 * 
 * @param {number} intervalMs - Check interval in milliseconds (default: 30000)
 * @returns {boolean} True if monitor started successfully
 */
function startIntegrityMonitor(intervalMs = DEFAULT_MONITOR_INTERVAL) {
    if (isMonitoring) {
        console.log('[NovaSentinel] Integrity monitor already running');
        return false;
    }
    
    if (baselineHashes.size === 0) {
        console.error('[NovaSentinel] Cannot start monitor: baseline not established');
        return false;
    }
    
    console.log('[NovaSentinel] Starting integrity monitor with interval:', intervalMs, 'ms');
    
    // Run initial check immediately
    verifyIntegrity().catch(err => {
        console.error('[NovaSentinel] Initial integrity check failed:', err.message);
    });
    
    // Set up periodic monitoring
    monitorInterval = setInterval(async () => {
        try {
            await verifyIntegrity();
        } catch (error) {
            console.error('[NovaSentinel] Scheduled integrity check failed:', error.message);
        }
    }, intervalMs);
    
    isMonitoring = true;
    
    logSecurityEvent('integrity_monitor_start', 'info',
        'File integrity monitoring started',
        { intervalMs }
    );
    
    return true;
}

/**
 * Stop background integrity monitoring.
 * 
 * @returns {boolean} True if monitor stopped successfully
 */
function stopIntegrityMonitor() {
    if (!isMonitoring) {
        console.log('[NovaSentinel] Integrity monitor not running');
        return false;
    }
    
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
    }
    
    isMonitoring = false;
    
    console.log('[NovaSentinel] Integrity monitor stopped');
    
    logSecurityEvent('integrity_monitor_stop', 'info',
        'File integrity monitoring stopped'
    );
    
    return true;
}

/**
 * Get current integrity status for all monitored files.
 * Returns status suitable for dashboard display.
 * 
 * @returns {object} Status object with active, healthy, and per-file details
 */
function getIntegrityStatus() {
    const details = {};
    
    for (const [filePath, status] of fileStatus) {
        details[filePath] = {
            status: status.status,
            baselineHash: status.baselineHash ? status.baselineHash.substring(0, 16) + '...' : null,
            currentHash: status.hash ? status.hash.substring(0, 16) + '...' : null,
            lastChecked: status.lastChecked,
            error: status.error
        };
    }
    
    return {
        active: isMonitoring,
        healthy: systemHealthy,
        lastCheck: lastCheckTime,
        monitoredFiles: monitoredFiles.length,
        details
    };
}

/**
 * Get the integrity event emitter for subscribing to events.
 * 
 * @returns {EventEmitter} The integrity event emitter
 */
function getIntegrityEmitter() {
    return integrityEmitter;
}

/**
 * Get overall system status (for module export).
 * 
 * @returns {object} Status object with active and healthy flags
 */
function getStatus() {
    return {
        active: isMonitoring,
        healthy: systemHealthy,
        details: {
            monitoredFiles: monitoredFiles.length,
            lastCheck: lastCheckTime,
            baselineEstablished: baselineHashes.size > 0
        }
    };
}

// =============================================================================
// MODULE EXPORTS
// =============================================================================

module.exports = {
    measureFiles,
    verifyIntegrity,
    startIntegrityMonitor,
    stopIntegrityMonitor,
    getIntegrityStatus,
    getStatus,
    getIntegrityEmitter,
    // Event emitter for real-time updates
    emitter: integrityEmitter
};
