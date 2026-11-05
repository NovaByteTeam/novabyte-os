/**
 * NovaSentinel VirusTotal Integration Module
 * 
 * This module integrates with VirusTotal API v3 to scan files and URLs for malware.
 * 
 * SECURITY REQUIREMENTS:
 * - Never expose API key in logs
 * - Call auditService.logEvent() for security events
 * - Cache malicious results to prevent repeated API calls
 * - Rate limit requests to respect API limits (4/minute free tier)
 * - Use SHA-256 for file hashing
 * 
 * @module sentinel/threats/virustotal
 */

'use strict';

// =============================================================================
// DEPENDENCIES
// =============================================================================

/** Try to load crypto for SHA-256 hashing */
let crypto;
try {
    crypto = require('crypto');
} catch (e) {
    console.error('[VirusTotal] Crypto module not available');
}

/** Try to load audit service for security event logging */
let auditService;
try {
    auditService = require('../audit-service');
} catch (e) {
    // Audit service not available - will log to console
    console.warn('[VirusTotal] Audit service not available, using console logging');
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** VirusTotal API v3 base URL */
const VT_API_BASE = 'https://www.virustotal.com/api/v3';

/** Rate limit: 4 requests per minute for free tier */
const RATE_LIMIT_REQUESTS = 4;
const RATE_LIMIT_WINDOW_MS = 60000;

/** Cache TTL: 24 hours in milliseconds */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Threshold for malicious verdict (>3 engines flagged) */
const MALICIOUS_THRESHOLD = 3;

/** Maximum file size for upload (32MB) */
const MAX_FILE_SIZE = 32 * 1024 * 1024;

// =============================================================================
// STATE
// =============================================================================

/** API key from environment */
let apiKey = null;

/** Whether the module is configured */
let isConfigured = false;

/** Rate limiting queue */
let requestQueue = [];
let isProcessingQueue = false;

/** Result cache: Map<hash, { report, timestamp, malicious }> */
let resultCache = new Map();

/** Statistics tracking */
let stats = {
    filesScanned: 0,
    urlsScanned: 0,
    threatsDetected: 0,
    cacheHits: 0,
    apiRequests: 0,
    lastScan: null,
    lastError: null
};

// =============================================================================
// INITIALISATION
// =============================================================================

/**
 * Initialise the VirusTotal module
 */
function initialise() {
    apiKey = process.env.VIRUSTOTAL_API_KEY;
    
    if (!apiKey) {
        console.warn('[VirusTotal] API key not configured - VIRUSTOTAL_API_KEY environment variable required');
        isConfigured = false;
        return;
    }
    
    // Mask API key in logs (never expose)
    const maskedKey = apiKey.substring(0, 4) + '...' + apiKey.substring(apiKey.length - 4);
    console.log(`[VirusTotal] Initialised with API key: ${maskedKey}`);
    
    isConfigured = true;
    cleanExpiredCache();
}

/**
 * Clean expired entries from cache
 */
function cleanExpiredCache() {
    const now = Date.now();
    let expiredCount = 0;
    
    for (const [hash, entry] of resultCache) {
        if (now - entry.timestamp > CACHE_TTL_MS) {
            resultCache.delete(hash);
            expiredCount++;
        }
    }
    
    if (expiredCount > 0) {
        console.log(`[VirusTotal] Cleaned ${expiredCount} expired cache entries`);
    }
}

// =============================================================================
// RATE LIMITING
// =============================================================================

/**
 * Add request to rate limit queue
 * @returns {Promise} - Resolves when request can proceed
 */
function enqueueRequest() {
    return new Promise((resolve) => {
        requestQueue.push({
            timestamp: Date.now(),
            resolve
        });
        
        processQueue();
    });
}

/**
 * Process the request queue
 */
function processQueue() {
    if (isProcessingQueue || requestQueue.length === 0) {
        return;
    }
    
    isProcessingQueue = true;
    
    const now = Date.now();
    
    // Remove requests outside the current window
    requestQueue = requestQueue.filter(req => now - req.timestamp < RATE_LIMIT_WINDOW_MS);
    
    // Check if we can process a request
    if (requestQueue.length < RATE_LIMIT_REQUESTS) {
        const req = requestQueue.shift();
        isProcessingQueue = false;
        req.resolve();
        
        // Check if more requests can be processed
        setTimeout(() => processQueue(), 100);
    } else {
        // Wait until a slot opens up
        const oldestRequest = requestQueue[0];
        const waitTime = RATE_LIMIT_WINDOW_MS - (now - oldestRequest.timestamp);
        
        setTimeout(() => {
            isProcessingQueue = false;
            processQueue();
        }, Math.max(waitTime, 1000));
    }
}

// =============================================================================
// API HELPERS
// =============================================================================

/**
 * Make an authenticated request to VirusTotal API
 * @param {string} endpoint - API endpoint
 * @param {string} method - HTTP method
 * @param {object} body - Request body (optional)
 * @returns {Promise<object>} - API response
 */
async function makeRequest(endpoint, method = 'GET', body = null) {
    if (!isConfigured) {
        throw new Error('VirusTotal API key not configured');
    }
    
    // Wait for rate limit
    await enqueueRequest();
    
    const url = `${VT_API_BASE}${endpoint}`;
    const headers = {
        'x-apikey': apiKey,
        'Accept': 'application/json'
    };
    
    const options = {
        method,
        headers
    };
    
    if (body) {
        options.body = typeof body === 'string' ? body : JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
    }
    
    // Never log API key
    stats.apiRequests++;
    
    const response = await fetch(url, options);
    
    if (!response.ok) {
        const errorText = await response.text();
        stats.lastError = {
            code: response.status,
            message: errorText
        };
        
        throw new Error(`VirusTotal API error: ${response.status} - ${errorText}`);
    }
    
    return await response.json();
}

// =============================================================================
// HASHING
// =============================================================================

/**
 * Calculate SHA-256 hash of a buffer
 * @param {Buffer} buffer - File buffer
 * @returns {string} - SHA-256 hash in hex
 */
function calculateSHA256(buffer) {
    if (!crypto) {
        throw new Error('Crypto module not available');
    }
    
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// =============================================================================
// SECURITY EVENT LOGGING
// =============================================================================

/**
 * Log a security event
 * @param {string} eventType - Type of event
 * @param {object} details - Event details
 */
function logSecurityEvent(eventType, details) {
    const eventData = {
        type: eventType,
        source: 'virustotal',
        timestamp: new Date().toISOString(),
        ...details
    };
    
    if (auditService && typeof auditService.logEvent === 'function') {
        try {
            auditService.logEvent(eventData);
        } catch (e) {
            console.error('[VirusTotal] Failed to log security event:', e.message);
        }
    } else {
        // Fallback: log without exposing sensitive data
        console.log(`[VirusTotal] Security Event: ${eventType}`, {
            ...details,
            // Never log API key
            apiKey: details.apiKey ? '[MASKED]' : undefined
        });
    }
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Scan a file for malware
 * @param {Buffer} fileBuffer - File content as buffer
 * @param {string} filename - Original filename
 * @returns {Promise<object>} - Scan result with verdict
 */
async function scanFile(fileBuffer, filename) {
    if (!isConfigured) {
        throw new Error('VirusTotal not configured');
    }
    
    if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
        throw new Error('Invalid file buffer');
    }
    
    if (fileBuffer.length > MAX_FILE_SIZE) {
        throw new Error(`File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`);
    }
    
    // Calculate SHA-256 hash
    const sha256 = calculateSHA256(fileBuffer);
    
    // Check cache first
    const cached = resultCache.get(sha256);
    if (cached) {
        stats.cacheHits++;
        logSecurityEvent('file_scan_cache_hit', {
            filename,
            sha256: sha256.substring(0, 16) + '...',
            malicious: cached.malicious
        });
        
        return {
            cached: true,
            sha256,
            malicious: cached.malicious,
            report: cached.report
        };
    }
    
    // Upload file for scanning
    logSecurityEvent('file_scan_start', {
        filename,
        sha256: sha256.substring(0, 16) + '...',
        size: fileBuffer.length
    });
    
    try {
        // First, try to get existing report by hash
        let report;
        try {
            report = await makeRequest(`/files/${sha256}`, 'GET');
        } catch (e) {
            // File not found in VT database - need to upload
            if (e.message.includes('404') || e.message.includes('Not Found')) {
                // Upload the file
                const uploadResponse = await makeRequest('/files', 'POST', fileBuffer);
                
                // Get the analysis ID
                const analysisId = uploadResponse.data?.id;
                
                if (!analysisId) {
                    throw new Error('Failed to get analysis ID from upload');
                }
                
                // Poll for results
                report = await pollForReport(analysisId);
            } else {
                throw e;
            }
        }
        
        // Determine verdict
        const malicious = isMalicious(report);
        
        // Cache the result
        resultCache.set(sha256, {
            report,
            timestamp: Date.now(),
            malicious
        });
        
        stats.filesScanned++;
        stats.threatsDetected += malicious ? 1 : 0;
        stats.lastScan = new Date().toISOString();
        
        logSecurityEvent('file_scan_complete', {
            filename,
            sha256: sha256.substring(0, 16) + '...',
            malicious,
            enginesFlagged: report.data?.attributes?.last_analysis_stats?.malicious || 0
        });
        
        return {
            cached: false,
            sha256,
            malicious,
            report,
            filename
        };
        
    } catch (error) {
        stats.lastError = {
            message: error.message,
            filename
        };
        
        logSecurityEvent('file_scan_error', {
            filename,
            error: error.message
        });
        
        throw error;
    }
}

/**
 * Submit a URL for scanning
 * @param {string} url - URL to scan
 * @returns {Promise<object>} - Scan result
 */
async function scanUrl(url) {
    if (!isConfigured) {
        throw new Error('VirusTotal not configured');
    }
    
    if (!url || typeof url !== 'string') {
        throw new Error('Invalid URL');
    }
    
    // Validate URL format
    try {
        new URL(url);
    } catch (e) {
        throw new Error('Invalid URL format');
    }
    
    // Create URL identifier (URL-encoded)
    const urlId = Buffer.from(url).toString('base64').replace(/[/+=]/g, '_').slice(0, 64);
    
    // Check cache
    const cached = resultCache.get(urlId);
    if (cached) {
        stats.cacheHits++;
        logSecurityEvent('url_scan_cache_hit', {
            url: url.substring(0, 50) + '...',
            malicious: cached.malicious
        });
        
        return {
            cached: true,
            url,
            malicious: cached.malicious,
            report: cached.report
        };
    }
    
    logSecurityEvent('url_scan_start', {
        url: url.substring(0, 50) + '...'
    });
    
    try {
        // Submit URL for scanning
        const submitResponse = await makeRequest('/urls', 'POST', `url=${encodeURIComponent(url)}`);
        
        // Get the analysis ID
        const analysisId = submitResponse.data?.id;
        
        if (!analysisId) {
            throw new Error('Failed to get analysis ID from URL submission');
        }
        
        // Poll for results
        const report = await pollForReport(analysisId);
        
        // Determine verdict
        const malicious = isMalicious(report);
        
        // Cache the result
        resultCache.set(urlId, {
            report,
            timestamp: Date.now(),
            malicious
        });
        
        stats.urlsScanned++;
        stats.threatsDetected += malicious ? 1 : 0;
        stats.lastScan = new Date().toISOString();
        
        logSecurityEvent('url_scan_complete', {
            url: url.substring(0, 50) + '...',
            malicious,
            enginesFlagged: report.data?.attributes?.last_analysis_stats?.malicious || 0
        });
        
        return {
            cached: false,
            url,
            malicious,
            report
        };
        
    } catch (error) {
        stats.lastError = {
            message: error.message,
            url: url.substring(0, 50)
        };
        
        logSecurityEvent('url_scan_error', {
            url: url.substring(0, 50) + '...',
            error: error.message
        });
        
        throw error;
    }
}

/**
 * Poll for scan report
 * @param {string} analysisId - Analysis ID
 * @param {number} maxAttempts - Maximum polling attempts
 * @param {number} delayMs - Delay between attempts
 * @returns {Promise<object>} - Scan report
 */
async function pollForReport(analysisId, maxAttempts = 5, delayMs = 2000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const report = await makeRequest(`/analyses/${analysisId}`, 'GET');
        
        const status = report.data?.attributes?.status;
        
        if (status === 'completed') {
            return report;
        }
        
        if (status === 'failed') {
            throw new Error('Analysis failed on VirusTotal');
        }
        
        // Still in progress, wait and retry
        if (attempt < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    
    throw new Error('Analysis timeout - maximum attempts reached');
}

/**
 * Get a scan report by resource ID (SHA-256 or URL ID)
 * @param {string} resourceId - SHA-256 hash or URL ID
 * @returns {Promise<object>} - Scan report
 */
async function getReport(resourceId) {
    if (!isConfigured) {
        throw new Error('VirusTotal not configured');
    }
    
    if (!resourceId || typeof resourceId !== 'string') {
        throw new Error('Invalid resource ID');
    }
    
    // Check cache first
    const cached = resultCache.get(resourceId);
    if (cached) {
        stats.cacheHits++;
        return cached.report;
    }
    
    // Determine if it's a file hash or URL
    const isFileHash = /^[a-f0-9]{64}$/i.test(resourceId);
    
    let report;
    try {
        if (isFileHash) {
            report = await makeRequest(`/files/${resourceId}`, 'GET');
        } else {
            report = await makeRequest(`/urls/${resourceId}`, 'GET');
        }
        
        // Cache the result
        const malicious = isMalicious(report);
        resultCache.set(resourceId, {
            report,
            timestamp: Date.now(),
            malicious
        });
        
        return report;
        
    } catch (error) {
        if (error.message.includes('404') || error.message.includes('Not Found')) {
            throw new Error('Resource not found in VirusTotal database - file has not been previously scanned');
        }
        throw error;
    }
}

/**
 * Determine if a report indicates malicious content
 * @param {object} report - VirusTotal report
 * @returns {boolean} - True if malicious (>3 engines flagged)
 */
function isMalicious(report) {
    if (!report || !report.data || !report.data.attributes) {
        return false;
    }
    
    const stats = report.data.attributes.last_analysis_stats;
    
    if (!stats) {
        return false;
    }
    
    // Count engines that flagged as malicious
    const maliciousCount = stats.malicious || 0;
    
    return maliciousCount > MALICIOUS_THRESHOLD;
}

/**
 * Get VirusTotal status and statistics
 * @returns {object} - Status object with quota and cache stats
 */
function getVTStatus() {
    return {
        configured: isConfigured,
        apiKeyPresent: !!apiKey,
        rateLimit: {
            maxRequests: RATE_LIMIT_REQUESTS,
            windowMs: RATE_LIMIT_WINDOW_MS,
            queuedRequests: requestQueue.length
        },
        cache: {
            entries: resultCache.size,
            ttlHours: CACHE_TTL_MS / (1000 * 60 * 60),
            hitRate: stats.cacheHits > 0 && (stats.filesScanned + stats.urlsScanned) > 0
                ? (stats.cacheHits / (stats.filesScanned + stats.urlsScanned + stats.cacheHits) * 100).toFixed(1) + '%'
                : '0%'
        },
        stats: {
            filesScanned: stats.filesScanned,
            urlsScanned: stats.urlsScanned,
            threatsDetected: stats.threatsDetected,
            cacheHits: stats.cacheHits,
            apiRequests: stats.apiRequests,
            lastScan: stats.lastScan,
            lastError: stats.lastError
        }
    };
}

/**
 * Get module status for NovaSentinel health check
 * @returns {object} - Status object
 */
function getStatus() {
    return {
        active: isConfigured,
        healthy: isConfigured && !stats.lastError,
        details: {
            configured: isConfigured,
            apiKeyConfigured: !!apiKey,
            cacheEntries: resultCache.size,
            stats: getVTStatus().stats
        }
    };
}

/**
 * Clear the result cache
 * @returns {number} - Number of entries cleared
 */
function clearCache() {
    const size = resultCache.size;
    resultCache.clear();
    
    logSecurityEvent('cache_cleared', {
        entriesCleared: size
    });
    
    return size;
}

/**
 * Get cache entry by hash
 * @param {string} hash - SHA-256 or URL ID
 * @returns {object|null} - Cached entry or null
 */
function getCachedResult(hash) {
    return resultCache.get(hash) || null;
}

// =============================================================================
// MODULE EXPORTS
// =============================================================================

module.exports = {
    scanFile,
    scanUrl,
    getReport,
    isMalicious,
    getVTStatus,
    getStatus,
    clearCache,
    getCachedResult,
    initialise,
    // Constants for external use
    MALICIOUS_THRESHOLD,
    MAX_FILE_SIZE,
    CACHE_TTL_MS
};

// Auto-initialize on module load
initialise();
