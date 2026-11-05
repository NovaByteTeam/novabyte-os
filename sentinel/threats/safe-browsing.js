/**
 * NovaSentinel Google Safe Browsing Module
 * 
 * This module integrates with Google Safe Browsing API v4 to check URLs
 * against known threat lists.
 * 
 * SECURITY REQUIREMENTS:
 * - Never expose API key in logs
 * - Call auditService.logEvent() for security events
 * - Cache results with 30-minute TTL
 * - Implement request batching for efficiency (up to 500 URLs)
 * 
 * @module sentinel/threats/safe-browsing
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
    console.warn('[SafeBrowsing] Audit service not available, using console logging');
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Google Safe Browsing API v4 base URL */
const SB_API_BASE = 'https://safebrowsing.googleapis.com/v4';

/** Cache TTL: 30 minutes in milliseconds */
const CACHE_TTL_MS = 30 * 60 * 1000;

/** Maximum URLs per batch request (API limit) */
const MAX_BATCH_SIZE = 500;

/** Threat types supported by Google Safe Browsing */
const THREAT_TYPES = {
    MALWARE: 'MALWARE',
    SOCIAL_ENGINEERING: 'SOCIAL_ENGINEERING',
    UNWANTED_SOFTWARE: 'UNWANTED_SOFTWARE',
    POTENTIALLY_HARMFUL_APPLICATION: 'POTENTIALLY_HARMFUL_APPLICATION'
};

/** Platform types */
const PLATFORM_TYPES = {
    ANY_PLATFORM: 'ANY_PLATFORM'
};

// =============================================================================
// STATE
// =============================================================================

/** API key from environment */
let apiKey = null;

/** Whether the module is configured */
let isConfigured = false;

/** Result cache: Map<url, { result, timestamp }> */
let urlCache = new Map();

/** Statistics tracking */
let stats = {
    urlsChecked: 0,
    urlsSafe: 0,
    threatsDetected: 0,
    cacheHits: 0,
    apiRequests: 0,
    lastCheck: null,
    lastError: null
};

// =============================================================================
// INITIALISATION
// =============================================================================

/**
 * Initialise the Safe Browsing module
 */
function initialise() {
    apiKey = process.env.SAFE_BROWSING_API_KEY;
    
    if (!apiKey) {
        console.warn('[SafeBrowsing] API key not configured - SAFE_BROWSING_API_KEY environment variable required');
        isConfigured = false;
        return;
    }
    
    // Mask API key in logs (never expose)
    const maskedKey = apiKey.substring(0, 4) + '...' + apiKey.substring(apiKey.length - 4);
    console.log(`[SafeBrowsing] Initialised with API key: ${maskedKey}`);
    
    isConfigured = true;
    cleanExpiredCache();
}

/**
 * Clean expired entries from cache
 */
function cleanExpiredCache() {
    const now = Date.now();
    let expiredCount = 0;
    
    for (const [url, entry] of urlCache) {
        if (now - entry.timestamp > CACHE_TTL_MS) {
            urlCache.delete(url);
            expiredCount++;
        }
    }
    
    if (expiredCount > 0) {
        console.log(`[SafeBrowsing] Cleaned ${expiredCount} expired cache entries`);
    }
}

// =============================================================================
// API HELPERS
// =============================================================================

/**
 * Make an authenticated request to Google Safe Browsing API
 * @param {string} endpoint - API endpoint
 * @param {object} body - Request body
 * @returns {Promise<object>} - API response
 */
async function makeRequest(endpoint, body) {
    if (!isConfigured) {
        throw new Error('Safe Browsing API key not configured');
    }
    
    const url = `${SB_API_BASE}${endpoint}?key=${apiKey}`;
    
    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    };
    
    // Never log API key
    stats.apiRequests++;
    
    const response = await fetch(url, options);
    
    if (!response.ok) {
        const errorText = await response.text();
        stats.lastError = {
            code: response.status,
            message: errorText
        };
        
        throw new Error(`Safe Browsing API error: ${response.status} - ${errorText}`);
    }
    
    return await response.json();
}

/**
 * Build the threat matching request body
 * @param {string[]} urls - URLs to check
 * @returns {object} - API request body
 */
function buildThreatRequest(urls) {
    return {
        client: {
            clientId: 'novabyte-os',
            clientVersion: '1.0.0'
        },
        threatInfo: {
            threatTypes: Object.values(THREAT_TYPES),
            platformTypes: [PLATFORM_TYPES.ANY_PLATFORM],
            threatEntryTypes: ['URL'],
            threatEntries: urls.map(url => ({ url }))
        }
    };
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
        source: 'safe-browsing',
        timestamp: new Date().toISOString(),
        ...details
    };
    
    if (auditService && typeof auditService.logEvent === 'function') {
        try {
            auditService.logEvent(eventData);
        } catch (e) {
            console.error('[SafeBrowsing] Failed to log security event:', e.message);
        }
    } else {
        // Fallback: log without exposing sensitive data
        console.log(`[SafeBrowsing] Security Event: ${eventType}`, {
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
 * Check a single URL against Safe Browsing threat lists
 * @param {string} url - URL to check
 * @returns {Promise<object>} - Check result with threat details
 */
async function checkUrl(url) {
    if (!isConfigured) {
        throw new Error('Safe Browsing not configured');
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
    
    // Check cache first
    const cached = urlCache.get(url);
    if (cached) {
        const age = Date.now() - cached.timestamp;
        if (age < CACHE_TTL_MS) {
            stats.cacheHits++;
            logSecurityEvent('url_check_cache_hit', {
                url: url.substring(0, 50) + '...',
                cached: true,
                ageMs: age
            });
            
            return {
                cached: true,
                url,
                safe: cached.result.safe,
                threats: cached.result.threats
            };
        }
    }
    
    logSecurityEvent('url_check_start', {
        url: url.substring(0, 50) + '...'
    });
    
    try {
        // Make API request
        const requestBody = buildThreatRequest([url]);
        const response = await makeRequest('/threatMatches:find', requestBody);
        
        // Parse response
        const matches = response.matches || [];
        const threats = matches.map(match => ({
            threatType: match.threatType,
            platformType: match.platformType,
            threatEntryType: match.threatEntryType
        }));
        
        const safe = threats.length === 0;
        
        // Cache the result
        urlCache.set(url, {
            result: { safe, threats },
            timestamp: Date.now()
        });
        
        stats.urlsChecked++;
        stats.urlsSafe += safe ? 1 : 0;
        stats.threatsDetected += safe ? 0 : 1;
        stats.lastCheck = new Date().toISOString();
        
        logSecurityEvent('url_check_complete', {
            url: url.substring(0, 50) + '...',
            safe,
            threatCount: threats.length
        });
        
        return {
            cached: false,
            url,
            safe,
            threats
        };
        
    } catch (error) {
        stats.lastError = {
            message: error.message,
            url: url.substring(0, 50)
        };
        
        logSecurityEvent('url_check_error', {
            url: url.substring(0, 50) + '...',
            error: error.message
        });
        
        throw error;
    }
}

/**
 * Check multiple URLs against Safe Browsing threat lists (batch)
 * @param {string[]} urls - Array of URLs to check
 * @returns {Promise<object[]>} - Array of check results
 */
async function checkUrls(urls) {
    if (!isConfigured) {
        throw new Error('Safe Browsing not configured');
    }
    
    if (!Array.isArray(urls) || urls.length === 0) {
        throw new Error('Invalid URLs array');
    }
    
    // Validate all URLs
    for (const url of urls) {
        if (!url || typeof url !== 'string') {
            throw new Error('Invalid URL in array');
        }
        try {
            new URL(url);
        } catch (e) {
            throw new Error(`Invalid URL format: ${url}`);
        }
    }
    
    const results = [];
    const urlsToCheck = [];
    const cachedResults = [];
    
    // Check cache first for each URL
    for (const url of urls) {
        const cached = urlCache.get(url);
        if (cached) {
            const age = Date.now() - cached.timestamp;
            if (age < CACHE_TTL_MS) {
                stats.cacheHits++;
                cachedResults.push({
                    url,
                    cached: true,
                    safe: cached.result.safe,
                    threats: cached.result.threats
                });
                continue;
            }
        }
        urlsToCheck.push(url);
    }
    
    // Add cached results
    results.push(...cachedResults);
    
    // Process in batches
    const batchSize = MAX_BATCH_SIZE;
    for (let i = 0; i < urlsToCheck.length; i += batchSize) {
        const batch = urlsToCheck.slice(i, i + batchSize);
        const batchResults = await processBatch(batch);
        results.push(...batchResults);
    }
    
    // Sort results to maintain original order
    const urlOrder = urls.map((url, index) => ({ url, index }));
    const orderMap = new Map(urlOrder.map(x => [x.url, x.index]));
    
    results.sort((a, b) => orderMap.get(a.url) - orderMap.get(b.url));
    
    return results;
}

/**
 * Process a batch of URLs
 * @param {string[]} urls - Batch of URLs to check
 * @returns {Promise<object[]>} - Batch results
 */
async function processBatch(urls) {
    logSecurityEvent('batch_check_start', {
        urlCount: urls.length,
        batchSize: urls.length
    });
    
    try {
        const requestBody = buildThreatRequest(urls);
        const response = await makeRequest('/threatMatches:find', requestBody);
        
        const matches = response.matches || [];
        
        // Group matches by URL
        const threatMap = new Map();
        for (const match of matches) {
            const threatUrl = match.threat?.url;
            if (!threatUrl) continue;
            
            if (!threatMap.has(threatUrl)) {
                threatMap.set(threatUrl, []);
            }
            threatMap.get(threatUrl).push({
                threatType: match.threatType,
                platformType: match.platformType,
                threatEntryType: match.threatEntryType
            });
        }
        
        const results = urls.map(url => {
            const threats = threatMap.get(url) || [];
            const safe = threats.length === 0;
            
            // Cache the result
            urlCache.set(url, {
                result: { safe, threats },
                timestamp: Date.now()
            });
            
            stats.urlsChecked++;
            stats.urlsSafe += safe ? 1 : 0;
            stats.threatsDetected += safe ? 0 : 1;
            
            return {
                cached: false,
                url,
                safe,
                threats
            };
        });
        
        stats.lastCheck = new Date().toISOString();
        
        const threatsFound = results.filter(r => !r.safe).length;
        logSecurityEvent('batch_check_complete', {
            urlCount: urls.length,
            threatsFound
        });
        
        return results;
        
    } catch (error) {
        stats.lastError = {
            message: error.message,
            batchSize: urls.length
        };
        
        logSecurityEvent('batch_check_error', {
            batchSize: urls.length,
            error: error.message
        });
        
        throw error;
    }
}

/**
 * Convenience wrapper - check if a URL is safe
 * @param {string} url - URL to check
 * @returns {Promise<boolean>} - True if URL is safe
 */
async function isSafe(url) {
    const result = await checkUrl(url);
    return result.safe;
}

// =============================================================================
// STATUS AND STATISTICS
// =============================================================================

/**
 * Get Safe Browsing status for dashboard
 * @returns {object} - Status object with cache size and API calls
 */
function getSafeBrowsingStatus() {
    return {
        cacheSize: urlCache.size,
        apiRequests: stats.apiRequests,
        urlsChecked: stats.urlsChecked,
        urlsSafe: stats.urlsSafe,
        threatsDetected: stats.threatsDetected,
        cacheHits: stats.cacheHits,
        lastCheck: stats.lastCheck,
        lastError: stats.lastError
    };
}

/**
 * Get module status
 * @returns {object} - Status object
 */
function getStatus() {
    return {
        active: isConfigured,
        healthy: isConfigured && !stats.lastError,
        details: {
            configured: isConfigured,
            cacheSize: urlCache.size,
            stats: getSafeBrowsingStatus()
        }
    };
}

// =============================================================================
// INITIALISE ON MODULE LOAD
// =============================================================================

initialise();

// =============================================================================
// MODULE EXPORTS
// =============================================================================

module.exports = {
    checkUrl,
    checkUrls,
    isSafe,
    getSafeBrowsingStatus,
    getStatus
};
