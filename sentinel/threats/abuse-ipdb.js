/**
 * NovaSentinel AbuseIPDB Module
 * 
 * This module integrates with AbuseIPDB to check IP reputation
 * and detect malicious IPs.
 * 
 * SECURITY REQUIREMENTS:
 * - Never expose API key in logs
 * - Call auditService.logEvent() for security events
 * - Cache results with 1-hour TTL
 * - Implement rate limiting for API calls
 * - Skip private/loopback IPs automatically
 * 
 * @module sentinel/threats/abuse-ipdb
 */

'use strict';

// =============================================================================
// DEPENDENCIES
// =============================================================================

/** Try to load audit service for security event logging */
let auditService;
try {
    auditService = require('../audit-service');
} catch (e) {
    console.warn('[AbuseIPDB] Audit service not available, using console logging');
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** AbuseIPDB API v2 base URL */
const ABUSEIPDB_API_BASE = 'https://api.abuseipdb.com/api/v2';

/** Cache TTL: 1 hour in milliseconds */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Default abuse threshold (0-100) */
const DEFAULT_THRESHOLD = 25;

/** Rate limit: requests per minute (AbuseIPDB free tier: 1000/day = ~1/min) */
const RATE_LIMIT_REQUESTS = 1;

/** Rate limit window: 60 seconds */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

/** IP address categories for reporting */
const ABUSE_CATEGORIES = {
    DNS_COMPROMISE: 1,
    DDoS_ATTACK: 5,
    WEB_ATTACK: 6,
    BRUTE_FORCE: 7,
    WEB_SPAM: 8,
    PORT_SCAN: 9,
    HACKING: 10,
    MALWARE: 11,
    PHISHING: 12,
    FRAUD: 14,
    VPN_PROXY: 15,
    TOR_EXIT: 17,
    BOT: 18,
    WEBSHELL: 19,
    MALICIOUS_AUTONOMOUS_SYSTEM: 20,
    MALICIOUS_CLOUD_COMPUTE: 21,
    OPEN_PROXY: 22,
    SPAM_COMMENT: 23,
    SPAM_CONTENT: 24,
    FAKE_CRAWLER: 25,
    VULNERABILITY_SCAN: 26,
    ADWARE: 27,
    CRAWLER_BOT: 28,
    EXPLOIT: 29,
    IoT_THREAT: 30
};

// =============================================================================
// PRIVATE IP RANGES
// =============================================================================

/** Private IP ranges that should be skipped */
const PRIVATE_IP_RANGES = [
    /^127\./,                           // Loopback (127.0.0.0/8)
    /^10\./,                            // Private (10.0.0.0/8)
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,   // Private (172.16.0.0/12)
    /^192\.168\./,                      // Private (192.168.0.0/16)
    /^169\.254\./,                      // Link-local
    /^0\./,                             // Current network
    /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./  // Carrier-grade NAT
];

// =============================================================================
// STATE
// =============================================================================

/** API key from environment */
let apiKey = null;

/** Whether the module is configured */
let isConfigured = false;

/** Result cache: Map<ip, { result, timestamp }> */
let ipCache = new Map();

/** Blocked IPs set for quick lookup */
let blockedIPs = new Set();

/** Rate limiting: queue of request timestamps */
let requestTimestamps = [];

/** Statistics tracking */
let stats = {
    ipsChecked: 0,
    ipsAbusive: 0,
    ipsSafe: 0,
    cacheHits: 0,
    apiRequests: 0,
    reportsSubmitted: 0,
    lastCheck: null,
    lastError: null,
    rateLimited: 0
};

// =============================================================================
// INITIALISATION
// =============================================================================

/**
 * Initialise the AbuseIPDB module
 */
function initialise() {
    apiKey = process.env.ABUSEIPDB_API_KEY;
    
    if (!apiKey) {
        console.warn('[AbuseIPDB] API key not configured - ABUSEIPDB_API_KEY environment variable required');
        isConfigured = false;
        return;
    }
    
    // Mask API key in logs (never expose)
    const maskedKey = apiKey.substring(0, 4) + '...' + apiKey.substring(apiKey.length - 4);
    console.log(`[AbuseIPDB] Initialised with API key: ${maskedKey}`);
    
    isConfigured = true;
    cleanExpiredCache();
}

/**
 * Check if an IP is private or loopback
 * @param {string} ip - IP address to check
 * @returns {boolean} - True if IP is private/loopback
 */
function isPrivateOrLoopback(ip) {
    if (!ip || typeof ip !== 'string') {
        return true;
    }
    
    for (const pattern of PRIVATE_IP_RANGES) {
        if (pattern.test(ip)) {
            return true;
        }
    }
    
    return false;
}

/**
 * Clean expired entries from cache
 */
function cleanExpiredCache() {
    const now = Date.now();
    let expiredCount = 0;
    let blockedExpired = 0;
    
    for (const [ip, entry] of ipCache) {
        if (now - entry.timestamp > CACHE_TTL_MS) {
            ipCache.delete(ip);
            expiredCount++;
            
            // Remove from blocked set if present
            if (blockedIPs.has(ip)) {
                blockedIPs.delete(ip);
                blockedExpired++;
            }
        }
    }
    
    if (expiredCount > 0) {
        console.log(`[AbuseIPDB] Cleaned ${expiredCount} expired cache entries (${blockedExpired} blocked)`);
    }
}

// =============================================================================
// RATE LIMITING
// =============================================================================

/**
 * Check if we can make a request (rate limiting)
 * @returns {boolean} - True if request is allowed
 */
function canMakeRequest() {
    const now = Date.now();
    
    // Remove old timestamps outside the window
    requestTimestamps = requestTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
    
    if (requestTimestamps.length >= RATE_LIMIT_REQUESTS) {
        stats.rateLimited++;
        return false;
    }
    
    return true;
}

/**
 * Wait for rate limit to clear
 * @returns {Promise<void>}
 */
async function waitForRateLimit() {
    const now = Date.now();
    requestTimestamps = requestTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
    
    if (requestTimestamps.length >= RATE_LIMIT_REQUESTS) {
        const oldestTimestamp = requestTimestamps[0];
        const waitTime = RATE_LIMIT_WINDOW_MS - (now - oldestTimestamp);
        
        if (waitTime > 0) {
            logSecurityEvent('rate_limit_wait', { waitTimeMs: waitTime });
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
    
    requestTimestamps.push(Date.now());
}

// =============================================================================
// API HELPERS
// =============================================================================

/**
 * Make an authenticated request to AbuseIPDB API
 * @param {string} endpoint - API endpoint
 * @param {object} options - Request options
 * @returns {Promise<object>} - API response
 */
async function makeRequest(endpoint, options = {}) {
    if (!isConfigured) {
        throw new Error('AbuseIPDB API key not configured');
    }
    
    // Wait for rate limit
    await waitForRateLimit();
    
    const url = `${ABUSEIPDB_API_BASE}${endpoint}`;
    
    const fetchOptions = {
        method: options.method || 'GET',
        headers: {
            'Accept': 'application/json',
            'Key': apiKey,
            'Content-Type': options.contentType || 'application/json'
        }
    };
    
    if (options.body) {
        fetchOptions.body = typeof options.body === 'string' 
            ? options.body 
            : JSON.stringify(options.body);
    }
    
    // Never log API key
    stats.apiRequests++;
    
    const response = await fetch(url, fetchOptions);
    
    if (!response.ok) {
        const errorText = await response.text();
        stats.lastError = {
            code: response.status,
            message: errorText,
            endpoint
        };
        
        throw new Error(`AbuseIPDB API error: ${response.status} - ${errorText}`);
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
        return await response.json();
    }
    
    return await response.text();
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
        source: 'abuse-ipdb',
        timestamp: new Date().toISOString(),
        ...details
    };
    
    if (auditService && typeof auditService.logEvent === 'function') {
        try {
            auditService.logEvent(eventData);
        } catch (e) {
            console.error('[AbuseIPDB] Failed to log security event:', e.message);
        }
    } else {
        // Fallback: log without exposing sensitive data
        console.log(`[AbuseIPDB] Security Event: ${eventType}`, {
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
 * Check an IP address against AbuseIPDB
 * @param {string} ip - IP address to check
 * @returns {Promise<object>} - Check result with abuse confidence score
 */
async function checkIP(ip) {
    if (!ip || typeof ip !== 'string') {
        throw new Error('Invalid IP address');
    }
    
    // Skip private/loopback IPs (even without API key configured)
    if (isPrivateOrLoopback(ip)) {
        logSecurityEvent('ip_check_skipped_private', { ip });
        
        return {
            ip,
            cached: false,
            skipped: true,
            reason: 'private_or_loopback',
            abuseConfidenceScore: 0,
            isp: null,
            countryCode: null,
            domain: null,
            isTor: false,
            isProxy: false,
            isVpn: false,
            totalReports: 0,
            numDistinctUsers: 0,
            lastReportedAt: null,
            isPublic: false
        };
    }
    
    // Now check if API is configured
    if (!isConfigured) {
        throw new Error('AbuseIPDB not configured');
    }
    
    // Check cache first
    const cached = ipCache.get(ip);
    if (cached) {
        const age = Date.now() - cached.timestamp;
        if (age < CACHE_TTL_MS) {
            stats.cacheHits++;
            logSecurityEvent('ip_check_cache_hit', {
                ip,
                cached: true,
                ageMs: age
            });
            
            return {
                ...cached.result,
                cached: true,
                ip
            };
        }
    }
    
    logSecurityEvent('ip_check_start', { ip });
    
    try {
        // Make API request
        const response = await makeRequest(`/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90&verbose=true`);
        
        // Parse response
        const data = response.data || {};
        const abuseConfidenceScore = data.abuseConfidenceScore || 0;
        const isAbusiveScore = abuseConfidenceScore >= DEFAULT_THRESHOLD;
        
        const result = {
            ip: data.ipAddress || ip,
            cached: false,
            skipped: false,
            abuseConfidenceScore,
            isp: data.isp || null,
            domain: data.domain || null,
            countryCode: data.countryCode || null,
            countryName: data.countryName || null,
            isTor: data.isTor || false,
            isProxy: data.isProxy || false,
            isVpn: data.isVpn || false,
            isCloudProvider: data.isCloudProvider || false,
            isResidentialProxy: data.isResidentialProxy || false,
            totalReports: data.totalReports || 0,
            numDistinctUsers: data.numDistinctUsers || 0,
            lastReportedAt: data.lastReportedAt || null,
            reportedBy: data.reportedBy || [],
            isPublic: true,
            isWhitelisted: data.isWhitelisted || false,
            isAbusive: isAbusiveScore
        };
        
        // Cache the result
        ipCache.set(ip, {
            result,
            timestamp: Date.now()
        });
        
        // Update blocked set if abusive
        if (isAbusiveScore) {
            blockedIPs.add(ip);
        } else {
            blockedIPs.delete(ip);
        }
        
        stats.ipsChecked++;
        stats.ipsAbusive += isAbusiveScore ? 1 : 0;
        stats.ipsSafe += isAbusiveScore ? 0 : 1;
        stats.lastCheck = new Date().toISOString();
        
        logSecurityEvent('ip_check_complete', {
            ip,
            abuseConfidenceScore,
            isAbusive: isAbusiveScore,
            totalReports: result.totalReports,
            isTor: result.isTor,
            isProxy: result.isProxy,
            isVpn: result.isVpn
        });
        
        return result;
        
    } catch (error) {
        stats.lastError = {
            message: error.message,
            ip
        };
        
        logSecurityEvent('ip_check_error', {
            ip,
            error: error.message
        });
        
        throw error;
    }
}

/**
 * Check if an IP is abusive (convenience wrapper)
 * @param {string} ip - IP address to check
 * @param {number} threshold - Abuse confidence threshold (default 25)
 * @returns {Promise<boolean>} - True if IP is abusive
 */
async function isAbusive(ip, threshold = DEFAULT_THRESHOLD) {
    // Handle private IPs without requiring API key
    if (isPrivateOrLoopback(ip)) {
        return false;
    }
    
    // Check API configuration for public IPs
    if (!isConfigured) {
        throw new Error('AbuseIPDB not configured');
    }
    
    const result = await checkIP(ip);
    
    // Return true if the IP was skipped (private) but still mark as not abusive
    if (result.skipped) {
        return false;
    }
    
    return result.abuseConfidenceScore >= threshold;
}

/**
 * Report an abusive IP to AbuseIPDB
 * @param {string} ip - IP address to report
 * @param {number[]} categories - Array of category IDs (1-30)
 * @param {string} comment - Description of the abuse
 * @returns {Promise<object>} - Report result
 */
async function reportIP(ip, categories, comment) {
    if (!ip || typeof ip !== 'string') {
        throw new Error('Invalid IP address');
    }
    
    if (!Array.isArray(categories) || categories.length === 0) {
        throw new Error('Categories must be a non-empty array');
    }
    
    // Validate categories
    for (const cat of categories) {
        if (typeof cat !== 'number' || cat < 1 || cat > 30) {
            throw new Error(`Invalid category: ${cat}. Must be between 1 and 30.`);
        }
    }
    
    if (!comment || typeof comment !== 'string' || comment.trim().length === 0) {
        throw new Error('Comment is required');
    }
    
    // Skip private/loopback IPs (even without API key)
    if (isPrivateOrLoopback(ip)) {
        logSecurityEvent('ip_report_skipped_private', { ip });
        
        return {
            ip,
            success: false,
            message: 'Private/loopback IP addresses cannot be reported'
        };
    }
    
    // Check API configuration for public IPs
    if (!isConfigured) {
        throw new Error('AbuseIPDB not configured');
    }
    
    // Truncate comment if too long (AbuseIPDB limit is 4000 chars)
    const truncatedComment = comment.trim().substring(0, 4000);
    
    logSecurityEvent('ip_report_start', {
        ip,
        categories,
        commentLength: truncatedComment.length
    });
    
    try {
        // Make API request to report endpoint
        const response = await makeRequest('/report', {
            method: 'POST',
            body: {
                ip: ip,
                categories: categories.join(','),
                comment: truncatedComment
            }
        });
        
        stats.reportsSubmitted++;
        
        logSecurityEvent('ip_report_complete', {
            ip,
            categories,
            success: true
        });
        
        // Invalidate cache for this IP
        ipCache.delete(ip);
        blockedIPs.delete(ip);
        
        return {
            ip,
            success: true,
            message: 'IP reported successfully',
            response: response
        };
        
    } catch (error) {
        logSecurityEvent('ip_report_error', {
            ip,
            categories,
            error: error.message
        });
        
        throw error;
    }
}

// =============================================================================
// STATUS AND STATISTICS
// =============================================================================

/**
 * Get IP reputation status for dashboard
 * @returns {object} - Status object with blocked IPs count and statistics
 */
function getIPReputationStatus() {
    return {
        blockedIPsCount: blockedIPs.size,
        cacheSize: ipCache.size,
        ipsChecked: stats.ipsChecked,
        ipsAbusive: stats.ipsAbusive,
        ipsSafe: stats.ipsSafe,
        cacheHits: stats.cacheHits,
        apiRequests: stats.apiRequests,
        reportsSubmitted: stats.reportsSubmitted,
        rateLimited: stats.rateLimited,
        lastCheck: stats.lastCheck,
        lastError: stats.lastError,
        configured: isConfigured
    };
}

/**
 * Get module status
 * @returns {object} - Module status for health checks
 */
function getStatus() {
    return {
        active: isConfigured,
        healthy: isConfigured && !stats.lastError,
        details: {
            configured: isConfigured,
            blockedCount: blockedIPs.size,
            cacheSize: ipCache.size,
            lastCheck: stats.lastCheck,
            lastError: stats.lastError ? stats.lastError.message : null
        }
    };
}

// =============================================================================
// INITIALISE MODULE
// =============================================================================

initialise();

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    checkIP,
    isAbusive,
    reportIP,
    getIPReputationStatus,
    getStatus,
    
    // Export constants for external use
    ABUSE_CATEGORIES,
    DEFAULT_THRESHOLD,
    
    // Internal functions exposed for testing
    _isPrivateOrLoopback: isPrivateOrLoopback,
    _canMakeRequest: canMakeRequest,
    _cleanExpiredCache: cleanExpiredCache
};
