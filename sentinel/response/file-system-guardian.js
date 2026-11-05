/**
 * Nova Guardian
 * 
Sentinel File System * Real-time file system monitoring and threat detection.
 * Automatically scans and removes malicious files.
 * 
 * @module sentinel/response/file-system-guardian
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Try to load DOMPurify for HTML sanitization
let DOMPurify;
try {
    const DOMPurifyFactory = require('dompurify');
    const { JSDOM } = require('jsdom');
    const window = new JSDOM('').window;
    DOMPurify = DOMPurifyFactory(window);
} catch (e) {
    console.warn('[FileSystemGuardian] DOMPurify not available, using fallback mode');
}

// Try to load VirusTotal for malware scanning
let virusTotal;
try {
    virusTotal = require('../threats/virustotal');
    console.log('[FileSystemGuardian] VirusTotal module loaded');
} catch (e) {
    console.warn('[FileSystemGuardian] VirusTotal module not available - malware scanning disabled');
}

// Threat patterns to detect
const THREAT_PATTERNS = {
    // XSS patterns
    xssScript: /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    xssOnEvent: /\s+on\w+\s*=\s*(["']?)[^"'>]*\1/gi,
    xssJavaScript: /javascript:/gi,
    xssIframe: /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi,
    xssObject: /<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi,
    xssEmbed: /<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi,
    
    // Other malicious patterns
    evalUsage: /\beval\s*\(/gi,
    setTimeoutEval: /setTimeout\s*\(\s*["']/gi,
    innerHTML: /\.innerHTML\s*=/gi,
    outerHTML: /\.outerHTML\s*=/gi,
    
    // Suspicious URLs
    suspiciousURL: /(?:http|https|ftp|file):\/\/[^\s<>"]+\.(exe|bat|cmd|vbs|js|jar|scr|pif|msi)/gi,
    
    // Base64 encoded payloads
    base64Eval: /atob\s*\(\s*["']/gi,
    
    // Remote script loading
    remoteScript: /<script\s+src\s*=\s*["']https?:/gi
};

// File extensions to monitor
const MONITORED_EXTENSIONS = ['.html', '.htm', '.js', '.jsx', '.ts', '.tsx', '.php', '.asp', '.aspx', '.jsp'];

// Extensions that indicate immediate threat
const DANGEROUS_EXTENSIONS = ['.exe', '.bat', '.cmd', '.vbs', '.js', '.jar', '.scr', '.pif', '.msi', '.com', '.hta'];

// State
let watcher = null;
let isMonitoring = false;
let watchPaths = [];
let scanInterval = null;
let threatsDetected = [];
let filesScanned = 0;
let threatsRemoved = 0;

// Statistics
let stats = {
    filesMonitored: 0,
    filesScanned: 0,
    threatsDetected: 0,
    threatsRemoved: 0,
    lastScan: null,
    active: false,
    // VirusTotal statistics
    vtScans: 0,
    vtThreatsDetected: 0,
    vtErrors: 0,
    vtRateLimited: 0
};

/**
 * Initialize the File System Guardian
 */
function initialize() {
    console.log('[FileSystemGuardian] Initializing...');
    
    // Load configuration
    const config = loadConfig();
    
    // Set watch paths
    watchPaths = config.watchPaths || [
        path.join(__dirname, '../../public'),
        path.join(__dirname, '../../data'),
        path.join(__dirname, '../../js')
    ];
    
    // Start monitoring
    startMonitoring();
    
    // Start periodic full scans
    startPeriodicScans(config.scanInterval || 60000); // Default: every minute
    
    console.log('[FileSystemGuardian] Initialized successfully');
    console.log('[FileSystemGuardian] Monitoring paths:', watchPaths.join(', '));
}

/**
 * Load configuration
 */
function loadConfig() {
    try {
        const configPath = path.join(__dirname, '../../data/sentinel-config.json');
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (e) {
        console.warn('[FileSystemGuardian] Could not load config, using defaults');
    }
    
    return {
        watchPaths: [],
        scanInterval: 60000,
        autoRemove: true,
        quarantinePath: path.join(__dirname, '../../data/quarantine'),
        maxFileSize: 10 * 1024 * 1024, // 10MB
        // VirusTotal integration
        enableVirusTotal: false,
        virustotalAutoQuarantine: true,
        virustotalScanAllFiles: false,
        virustotalMinFileSize: 1024, // 1KB minimum
        // Protected paths that should never be scanned or deleted
        protectedPaths: [
            path.join(__dirname, '../../data/certs'),
            path.join(__dirname, '../../data/keys'),
            path.join(__dirname, '../../node_modules'),
            path.join(__dirname, '../../.git'),
            path.join(__dirname, '../../cert.crt'),
            path.join(__dirname, '../../ca.crt'),
            path.join(__dirname, '../../cert.key'),
            path.join(__dirname, '../../ca.key')
        ]
    };
}

/**
 * Start file system monitoring
 */
function startMonitoring() {
    if (isMonitoring) {
        console.log('[FileSystemGuardian] Already monitoring');
        return;
    }
    
    try {
        // Create watchers for each path
        watchPaths.forEach(watchPath => {
            if (fs.existsSync(watchPath)) {
                const stat = fs.statSync(watchPath);
                if (stat.isDirectory()) {
                    startWatcher(watchPath);
                }
            }
        });
        
        isMonitoring = true;
        stats.active = true;
        console.log('[FileSystemGuardian] File system monitoring started');
    } catch (error) {
        console.error('[FileSystemGuardian] Failed to start monitoring:', error.message);
    }
}

/**
 * Start a file watcher for a specific path
 */
function startWatcher(watchPath) {
    try {
        // Watch for file changes
        fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
            if (!filename) return;
            
            const fullPath = path.join(watchPath, filename);
            
            // Check if it's a monitored extension
            const ext = path.extname(filename).toLowerCase();
            if (MONITORED_EXTENSIONS.includes(ext)) {
                console.log(`[FileSystemGuardian] File change detected: ${filename}`);
                
                // Scan the file
                setTimeout(() => scanFile(fullPath), 100);
            }
        });
        
        console.log(`[FileSystemGuardian] Watching: ${watchPath}`);
    } catch (error) {
        console.error(`[FileSystemGuardian] Error watching ${watchPath}:`, error.message);
    }
}

/**
 * Stop file system monitoring
 */
function stopMonitoring() {
    if (watcher) {
        watcher.close();
        watcher = null;
    }
    isMonitoring = false;
    stats.active = false;
    console.log('[FileSystemGuardian] File system monitoring stopped');
}

/**
 * Start periodic full system scans
 */
function startPeriodicScans(interval) {
    if (scanInterval) {
        clearInterval(scanInterval);
    }
    
    // Run initial scan
    performFullScan();
    
    // Set up periodic scans
    scanInterval = setInterval(() => {
        performFullScan();
    }, interval);
    
    console.log(`[FileSystemGuardian] Periodic scans started (every ${interval/1000}s)`);
}

/**
 * Perform a full system scan
 */
async function performFullScan() {
    console.log('[FileSystemGuardian] Starting full system scan...');
    stats.lastScan = new Date().toISOString();
    
    for (const watchPath of watchPaths) {
        if (fs.existsSync(watchPath)) {
            await scanDirectory(watchPath);
        }
    }
    
    console.log(`[FileSystemGuardian] Full scan complete. Files scanned: ${stats.filesScanned}, Threats: ${stats.threatsDetected}`);
}

/**
 * Recursively scan a directory
 */
async function scanDirectory(dirPath) {
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            
            if (entry.isDirectory()) {
                // Skip node_modules and hidden directories
                if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    await scanDirectory(fullPath);
                }
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (MONITORED_EXTENSIONS.includes(ext)) {
                    await scanFile(fullPath);
                }
            }
        }
    } catch (error) {
        console.error(`[FileSystemGuardian] Error scanning directory ${dirPath}:`, error.message);
    }
}

/**
 * Scan a single file for threats
 */
async function scanFile(filePath) {
    try {
        const config = loadConfig();
        
        // Check if file is in a protected path
        for (const protectedPath of config.protectedPaths) {
            if (filePath.startsWith(protectedPath)) {
                console.log(`[FileSystemGuardian] Skipping protected path: ${filePath}`);
                return;
            }
        }
        
        // Check file size
        const stat = fs.statSync(filePath);
        if (stat.size > config.maxFileSize) {
            console.log(`[FileSystemGuardian] Skipping large file: ${filePath}`);
            return;
        }
        
        // Skip very small files if configured
        if (stat.size < config.virustotalMinFileSize && !config.virustotalScanAllFiles) {
            console.log(`[FileSystemGuardian] Skipping small file (use virustotalScanAllFiles to override): ${filePath}`);
            return;
        }
        
        // Read file content
        const content = fs.readFileSync(filePath, 'utf8');
        stats.filesScanned++;
        filesScanned++;
        
        // Check for threats using pattern detection
        let threats = detectThreats(content, filePath);
        
        // Optionally scan with VirusTotal
        if (config.enableVirusTotal && virusTotal) {
            try {
                const vtResult = await scanWithVirusTotal(filePath, stat.size);
                if (vtResult && vtResult.malicious) {
                    threats.push({
                        type: 'virustotal_malicious',
                        detail: `VirusTotal detection: ${vtResult.detections || 'unknown'} engines flagged as malicious`,
                        count: vtResult.detections || 0,
                        severity: 'critical',
                        vtData: vtResult
                    });
                    stats.vtThreatsDetected++;
                }
                stats.vtScans++;
            } catch (vtError) {
                stats.vtErrors++;
                console.warn(`[FileSystemGuardian] VirusTotal scan failed for ${filePath}:`, vtError.message);
                // Continue with pattern-based results only
            }
        }
        
        if (threats.length > 0) {
            console.log(`[FileSystemGuardian] THREAT DETECTED in ${filePath}:`);
            threats.forEach(threat => {
                console.log(`  - ${threat.type}: ${threat.detail}`);
            });
            
            stats.threatsDetected += threats.length;
            threatsDetected.push({
                file: filePath,
                threats: threats,
                timestamp: new Date().toISOString()
            });
            
            // Auto-remove if enabled (but skip for protected paths)
            if (config.autoRemove) {
                // Double-check protected paths before deletion
                let canDelete = true;
                for (const protectedPath of config.protectedPaths) {
                    if (filePath.startsWith(protectedPath)) {
                        canDelete = false;
                        console.warn(`[FileSystemGuardian] Refusing to delete protected file: ${filePath}`);
                        break;
                    }
                }
                
                if (canDelete) {
                    await removeThreat(filePath, threats);
                } else {
                    logSecurityEvent('PROTECTED_FILE_SKIPPED', {
                        file: filePath,
                        threats: threats.map(t => t.type)
                    });
                }
            }
            
            // Log security event
            logSecurityEvent('THREAT_DETECTED', {
                file: filePath,
                threats: threats.map(t => t.type),
                action: config.autoRemove ? (canDelete ? 'removed' : 'skipped_protected') : 'detected'
            });
        }
    } catch (error) {
        console.error(`[FileSystemGuardian] Error scanning file ${filePath}:`, error.message);
    }
}

/**
 * Detect threats in file content
 */
function detectThreats(content, filePath) {
    const threats = [];
    
    // Check each threat pattern
    for (const [type, pattern] of Object.entries(THREAT_PATTERNS)) {
        const matches = content.match(pattern);
        if (matches) {
            threats.push({
                type: type,
                detail: matches[0].substring(0, 100),
                count: matches.length,
                severity: getThreatSeverity(type)
            });
        }
    }
    
    // Check file extension for dangerous types
    const ext = path.extname(filePath).toLowerCase();
    if (DANGEROUS_EXTENSIONS.includes(ext)) {
        threats.push({
            type: 'dangerous_extension',
            detail: `Dangerous file extension: ${ext}`,
            count: 1,
            severity: 'HIGH'
        });
    }
    
    return threats;
}

/**
 * Get threat severity level
 */
function getThreatSeverity(type) {
    const severityMap = {
        xssScript: 'HIGH',
        xssOnEvent: 'MEDIUM',
        xssJavaScript: 'HIGH',
        xssIframe: 'HIGH',
        xssObject: 'HIGH',
        xssEmbed: 'HIGH',
        evalUsage: 'MEDIUM',
        setTimeoutEval: 'MEDIUM',
        innerHTML: 'LOW',
        outerHTML: 'LOW',
        suspiciousURL: 'HIGH',
        base64Eval: 'HIGH',
        remoteScript: 'MEDIUM'
    };
    
    return severityMap[type] || 'LOW';
}

/**
 * Remove a threat file
 */
async function removeThreat(filePath, threats) {
    try {
        const config = loadConfig();
        
        // Create quarantine directory if it doesn't exist
        if (!fs.existsSync(config.quarantinePath)) {
            fs.mkdirSync(config.quarantinePath, { recursive: true });
        }
        
        // Move to quarantine
        const fileName = path.basename(filePath);
        const timestamp = Date.now();
        const quarantineName = `${timestamp}_${fileName}`;
        const quarantinePath = path.join(config.quarantinePath, quarantineName);
        
        fs.renameSync(filePath, quarantinePath);
        
        // Create quarantine log
        const logEntry = {
            originalPath: filePath,
            quarantinePath: quarantinePath,
            threats: threats,
            timestamp: new Date().toISOString()
        };
        
        const logPath = path.join(config.quarantinePath, 'quarantine-log.json');
        let quarantineLog = [];
        try {
            if (fs.existsSync(logPath)) {
                quarantineLog = JSON.parse(fs.readFileSync(logPath, 'utf8'));
            }
        } catch (e) {}
        
        quarantineLog.push(logEntry);
        fs.writeFileSync(logPath, JSON.stringify(quarantineLog, null, 2));
        
        stats.threatsRemoved++;
        threatsRemoved++;
        
        console.log(`[FileSystemGuardian] THREAT REMOVED: ${filePath} -> ${quarantinePath}`);
        
        // Notify via WebSocket if available
        notifyThreatRemoved(filePath, threats);
        
        return true;
    } catch (error) {
        console.error(`[FileSystemGuardian] Failed to remove threat:`, error.message);
        return false;
    }
}

/**
 * Notify about removed threat via WebSocket
 */
function notifyThreatRemoved(filePath, threats) {
    try {
        // Try to get Socket.io from server
        const server = require('../../server');
        if (server.io) {
            server.io.emit('sentinel:threat-removed', {
                file: filePath,
                threats: threats,
                timestamp: new Date().toISOString()
            });
        }
    } catch (e) {
        // Silently fail if server.io not available
    }
}

/**
 * Log security event
 */
function logSecurityEvent(eventType, details) {
    try {
        const auditService = require('../../audit-service');
        if (auditService && typeof auditService.logEvent === 'function') {
            auditService.logEvent({
                action: eventType,
                source: 'file-system-guardian',
                timestamp: new Date().toISOString(),
                ...details
            });
        }
    } catch (e) {
        console.log(`[FileSystemGuardian] Security event: ${eventType}`, details);
    }
}

/**
 * Scan a file with VirusTotal
 * @param {string} filePath - Path to the file
 * @param {number} fileSize - Size of the file in bytes
 * @returns {Promise<Object|null>} VirusTotal result or null if skipped
 */
async function scanWithVirusTotal(filePath, fileSize) {
    const config = loadConfig();
    
    // Check if VT is enabled and module is available
    if (!config.enableVirusTotal || !virusTotal) {
        return null;
    }
    
    // Check file size limits
    if (fileSize > 32 * 1024 * 1024) { // VT API limit is 32MB
        console.log(`[FileSystemGuardian] Skipping VT for file exceeding 32MB limit: ${filePath}`);
        return null;
    }
    
    // Perform VT scan
    const result = await virusTotal.scanFile(filePath);
    
    if (result && result.malicious) {
        console.log(`[FileSystemGuardian] VirusTotal detected threat in ${filePath}: ${result.detections} engines`);
        return {
            malicious: true,
            detections: result.detections,
            scanId: result.scanId,
            permalink: result.permalink,
            engines: result.engines
        };
    }
    
    return { malicious: false };
}

/**
 * Get guardian status
 */
function getStatus() {
    return {
        active: isMonitoring,
        monitoring: isMonitoring,
        watchPaths: watchPaths,
        stats: {
            filesScanned: stats.filesScanned,
            threatsDetected: stats.threatsDetected,
            threatsRemoved: stats.threatsRemoved,
            lastScan: stats.lastScan,
            // VirusTotal stats
            vtScans: stats.vtScans,
            vtThreatsDetected: stats.vtThreatsDetected,
            vtErrors: stats.vtErrors,
            vtRateLimited: stats.vtRateLimited
        },
        recentThreats: threatsDetected.slice(-10)
    };
}

/**
 * Get recent threats
 */
function getRecentThreats(count = 10) {
    return threatsDetected.slice(-count);
}

/**
 * Add a path to monitor
 */
function addWatchPath(newPath) {
    if (!watchPaths.includes(newPath)) {
        watchPaths.push(newPath);
        if (isMonitoring) {
            startWatcher(newPath);
        }
    }
}

/**
 * Remove a path from monitoring
 */
function removeWatchPath(removePath) {
    watchPaths = watchPaths.filter(p => p !== removePath);
}

/**
 * Manual scan trigger
 */
async function triggerScan() {
    stats.filesScanned = 0;
    stats.threatsDetected = 0;
    await performFullScan();
    return getStatus();
}

/**
 * Clean up on shutdown
 */
function shutdown() {
    stopMonitoring();
    if (scanInterval) {
        clearInterval(scanInterval);
    }
    console.log('[FileSystemGuardian] Shutdown complete');
}

/**
 * Get VirusTotal-specific statistics
 * @returns {Object} VirusTotal scan statistics
 */
function getVirusTotalStats() {
    const config = loadConfig();
    return {
        vtScans: stats.vtScans,
        vtThreatsDetected: stats.vtThreatsDetected,
        vtErrors: stats.vtErrors,
        vtRateLimited: stats.vtRateLimited,
        enabled: config.enableVirusTotal || false,
        moduleAvailable: !!virusTotal
    };
}

/**
 * Manually scan a specific file with VirusTotal
 * @param {string} filePath - Path to the file to scan
 * @returns {Promise<Object>} Scan result
 */
async function scanFileWithVirusTotal(filePath) {
    const config = loadConfig();
    
    if (!config.enableVirusTotal) {
        throw new Error('VirusTotal integration is disabled');
    }
    
    if (!virustotalModule) {
        throw new Error('VirusTotal module not available');
    }
    
    try {
        const stat = fs.statSync(filePath);
        const result = await scanWithVirusTotal(filePath, stat.size);
        return result;
    } catch (error) {
        console.error(`[FileSystemGuardian] Manual VT scan failed for ${filePath}:`, error.message);
        throw error;
    }
}

// Export functions
module.exports = {
    initialize,
    startMonitoring,
    stopMonitoring,
    triggerScan,
    getStatus,
    getRecentThreats,
    addWatchPath,
    removeWatchPath,
    shutdown,
    scanFile,
    detectThreats,
    removeThreat,
    // VirusTotal integration
    getVirusTotalStats,
    scanFileWithVirusTotal
};

// Auto-initialize if run directly
if (require.main === module) {
    initialize();
}
