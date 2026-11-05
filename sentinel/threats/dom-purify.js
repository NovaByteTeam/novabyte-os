/**
 * NovaSentinel DOMPurify Email Sanitisation Module
 * 
 * This module provides HTML sanitisation for emails using DOMPurify with a
 * strict email-specific configuration. It prevents XSS attacks in email content.
 * 
 * SECURITY REQUIREMENTS:
 * - Never allow script execution
 * - Force safe link attributes on anchor tags
 * - Proxy external images to prevent tracking
 * - Call auditService.logEvent() for security-relevant events
 * - Configurable allowed tags/attributes
 * - Track sanitisation statistics
 * 
 * @module sentinel/threats/dom-purify
 */

'use strict';

// =============================================================================
// OPTIONAL DEPENDENCIES
// =============================================================================

/** Try to load jsdom and DOMPurify, fall back gracefully if not available */
let JSDOM;
let DOMPurifyFactory;

try {
    JSDOM = require('jsdom').JSDOM;
    DOMPurifyFactory = require('dompurify');
} catch (e) {
    // Dependencies not available - will use fallback mode
    console.warn('[DOMPurify] jsdom/dompurify not available, using fallback mode');
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Allowed HTML tags for email content */
const ALLOWED_TAGS = [
    'p', 'br', 'b', 'i', 'u', 'em', 'strong', 'a', 'img',
    'table', 'tr', 'td', 'th', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'span', 'div'
];

/** Elements that must be completely stripped */
const STRICT_ELEMENTS = [
    'script', 'style', 'iframe', 'object', 'embed',
    'form', 'input', 'link', 'meta'
];

/** Allowed attributes per tag */
const ALLOWED_ATTR = [
    'href', 'src', 'alt', 'title', 'width', 'height',
    'style', 'class', 'id', 'border', 'cellpadding', 'cellspacing',
    'colspan', 'rowspan', 'target', 'rel'
];

/** Image proxy URL prefix */
const IMAGE_PROXY_PREFIX = '/api/sentinel/proxy/image?url=';

// =============================================================================
// STATE
// =============================================================================

/** Whether DOMPurify is properly initialised */
let isInitialised = false;

/** The DOMPurify instance */
let purify = null;

/** The JSDOM window object */
let window = null;

/** Statistics tracking */
let stats = {
    emailsSanitised: 0,
    subjectsSanitised: 0,
    headersSanitised: 0,
    threatsBlocked: 0,
    imagesProxied: 0,
    lastSanitization: null
};

// =============================================================================
// INITIALISATION
// =============================================================================

/**
 * Initialise DOMPurify with strict email configuration
 */
function initialise() {
    if (isInitialised) {
        return;
    }

    if (!JSDOM || !DOMPurifyFactory) {
        console.warn('[DOMPurify] Cannot initialise - dependencies not available');
        isInitialised = false;
        return;
    }

    try {
        // Create JSDOM instance with minimal features
        const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
            runScripts: 'outside-only',
            pretendToBeVisual: true
        });

        window = dom.window;
        purify = DOMPurifyFactory(window);

        // Configure DOMPurify with strict email settings
        purify.setConfig({
            ALLOWED_TAGS: ALLOWED_TAGS,
            ALLOWED_ATTR: ALLOWED_ATTR,
            ALLOW_DATA_ATTR: false,
            ADD_ATTR: ['target', 'rel'],
            FORBID_TAGS: STRICT_ELEMENTS,
            FORBID_ATTR: [/^on.*/i], // Block all event handlers
            SANITIZE_DOM: true
        });

        isInitialised = true;
        console.log('[DOMPurify] Initialised successfully with strict email config');
    } catch (e) {
        console.error('[DOMPurify] Failed to initialise:', e.message);
        isInitialised = false;
    }
}

// Try to initialise on module load
initialise();

// =============================================================================
// AUDIT LOGGING
// =============================================================================

/**
 * Log a security event to the audit service.
 * Handles case where auditService may not be available yet.
 * 
 * @param {string} event - Event type
 * @param {object} data - Event data (sanitized)
 */
function logSecurityEvent(event, data = {}) {
    try {
        if (typeof auditService !== 'undefined' && auditService && typeof auditService.logEvent === 'function') {
            const sanitized = {
                action: event,
                metadata: {
                    timestamp: new Date().toISOString(),
                    ...data
                }
            };
            auditService.logEvent(sanitized);
        }
    } catch (e) {
        // Silently fail if audit service is unavailable
    }
}

// =============================================================================
// CORE SANITISATION FUNCTIONS
// =============================================================================

/**
 * Post-process sanitised HTML to apply email-specific security measures
 * - Force safe link attributes on anchor tags
 * - Proxy all image sources through the image proxy
 * 
 * @param {string} html - The sanitised HTML
 * @returns {string} - HTML with security measures applied
 */
function applyEmailSecurityMeasures(html) {
    if (!html || typeof html !== 'string') {
        return html;
    }

    let processed = html;

    // Force target="_blank" rel="noopener noreferrer" on all anchor tags
    // Match <a> tags and ensure they have safe attributes
    processed = processed.replace(/<a\s+([^>]*?)>/gi, (match, attrs) => {
        // Check if target is already set
        if (/target\s*=\s*["']?_blank/i.test(attrs)) {
            // Ensure rel includes noopener noreferrer
            if (!/rel\s*=\s*["']?[^"']*noopener[^"']*noreferrer/i.test(attrs)) {
                return `<a ${attrs} rel="noopener noreferrer">`;
            }
            return match;
        }
        // Add target="_blank" rel="noopener noreferrer"
        return `<a target="_blank" rel="noopener noreferrer" ${attrs}>`;
    });

    // Proxy all img src through the image proxy
    // Match src attributes in img tags
    processed = processed.replace(/<img\s+([^>]*?)>/gi, (match, attrs) => {
        // Extract existing src if any
        const srcMatch = attrs.match(/src\s*=\s*["']([^"']+)["']/i) || 
                         attrs.match(/src\s*=\s*([^>\s]+)/i);
        
        if (srcMatch) {
            const originalSrc = srcMatch[1];
            // Skip data URLs and already proxied images
            if (originalSrc.startsWith('data:') || originalSrc.startsWith(IMAGE_PROXY_PREFIX)) {
                return match;
            }

            // Encode the URL and proxy it
            const proxiedSrc = IMAGE_PROXY_PREFIX + encodeURIComponent(originalSrc);
            const newAttrs = attrs.replace(/src\s*=\s*["'][^"']*["']/i, `src="${proxiedSrc}"`)
                                   .replace(/src\s*=\s*[^>\s]+/i, `src="${proxiedSrc}"`);

            stats.imagesProxied++;
            return `<img ${newAttrs}>`;
        }

        return match;
    });

    return processed;
}

/**
 * Sanitise email HTML content using DOMPurify with strict email config
 * 
 * @param {string} html - The raw HTML content from email
 * @returns {string} - Sanitised HTML safe for rendering
 */
function sanitizeEmail(html) {
    if (!html || typeof html !== 'string') {
        return '';
    }

    const startTime = Date.now();

    try {
        let sanitised;

        if (isInitialised && purify) {
            // Use DOMPurify for sanitisation
            sanitised = purify.sanitize(html);
        } else {
            // Fallback: basic HTML stripping
            sanitised = fallbackSanitize(html);
        }

        // Apply email-specific security measures
        sanitised = applyEmailSecurityMeasures(sanitised);

        // Update statistics
        stats.emailsSanitised++;
        stats.lastSanitization = new Date().toISOString();

        const duration = Date.now() - startTime;
        
        // Log security event for potentially dangerous content
        if (html.includes('<script') || html.includes('javascript:') || html.includes('onerror=')) {
            stats.threatsBlocked++;
            logSecurityEvent('EMAIL_XSS_BLOCKED', {
                inputLength: html.length,
                outputLength: sanitised.length,
                duration
            });
        }

        return sanitised;
    } catch (e) {
        // On error, return empty string for safety
        stats.threatsBlocked++;
        logSecurityEvent('SANITIZATION_ERROR', {
            error: e.message,
            inputLength: html.length
        });
        return '';
    }
}

/**
 * Sanitise email subject line - strip all HTML
 * 
 * @param {string} text - The raw subject text
 * @returns {string} - Plain text subject safe for display
 */
function sanitizeSubject(text) {
    if (!text || typeof text !== 'string') {
        return '';
    }

    try {
        let sanitised;

        // Always use fallback for subject lines - regex stripping is more reliable
        // than trying to override DOMPurify's config per-call
        sanitised = text.replace(/<[^>]*>/g, '');

        // Additional cleanup for subject lines
        sanitised = sanitised
            .replace(/javascript:/gi, '')
            .replace(/on\w+\s*=/gi, '')
            .trim();

        stats.subjectsSanitised++;
        stats.lastSanitization = new Date().toISOString();

        return sanitised;
    } catch (e) {
        // Return empty on error
        return '';
    }
}

/**
 * Sanitise email header values
 * 
 * @param {object} headers - Object with header key-value pairs
 * @returns {object} - Object with sanitised header values
 */
function sanitizeHeaders(headers) {
    if (!headers || typeof headers !== 'object') {
        return {};
    }

    const sanitised = {};

    try {
        for (const [key, value] of Object.entries(headers)) {
            if (typeof value === 'string') {
                // Strip HTML and dangerous content from header values
                let clean = value;

                if (isInitialised && purify) {
                    clean = purify.sanitize(clean, { ALLOWED_TAGS: [] });
                } else {
                    clean = clean.replace(/<[^>]*>/g, '');
                }

                // Remove javascript: and event handlers
                clean = clean
                    .replace(/javascript:/gi, '')
                    .replace(/on\w+\s*=/gi, '')
                    .trim();

                sanitised[key] = clean;
            } else if (Array.isArray(value)) {
                // Handle array values (e.g., multiple Received headers)
                sanitised[key] = value.map(v => {
                    if (typeof v !== 'string') return v;
                    let clean = v;
                    if (isInitialised && purify) {
                        clean = purify.sanitize(clean, { ALLOWED_TAGS: [] });
                    } else {
                        clean = clean.replace(/<[^>]*>/g, '');
                    }
                    return clean.replace(/javascript:/gi, '').replace(/on\w+\s*=/gi, '').trim();
                });
            } else {
                sanitised[key] = value;
            }
        }

        stats.headersSanitised++;
        stats.lastSanitization = new Date().toISOString();

    } catch (e) {
        logSecurityEvent('HEADER_SANITIZATION_ERROR', { error: e.message });
    }

    return sanitised;
}

/**
 * Fallback sanitisation when DOMPurify is not available
 * Basic HTML tag stripping
 * 
 * @param {string} html - The raw HTML
 * @returns {string} - Basic sanitised HTML
 */
function fallbackSanitize(html) {
    if (!html || typeof html !== 'string') {
        return '';
    }

    let result = html;

    // Strip all script tags and content
    result = result.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

    // Strip style tags and content
    result = result.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

    // Strip iframe tags
    result = result.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');

    // Strip object and embed tags
    result = result.replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '');
    result = result.replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '');

    // Strip form tags
    result = result.replace(/<form\b[^<]*(?:(?!<\/form>)<[^<]*)*<\/form>/gi, '');

    // Strip input tags
    result = result.replace(/<input\b[^>]*>/gi, '');

    // Strip link tags
    result = result.replace(/<link\b[^>]*>/gi, '');

    // Strip meta tags
    result = result.replace(/<meta\b[^>]*>/gi, '');

    // Remove all event handler attributes
    result = result.replace(/\s*on\w+\s*=\s*(["']?)[^"'>]*\1/gi, '');

    // Remove javascript: URLs
    result = result.replace(/javascript:/gi, '');

    // Remove data: URLs (except images that we'll proxy)
    // Note: We keep data: in the output but they'll be handled by applyEmailSecurityMeasures

    // Strip any remaining dangerous attributes
    result = result.replace(/\s*onclick\s*=\s*/gi, '')
                    .replace(/\s*onerror\s*=\s*/gi, '')
                    .replace(/\s*onload\s*=\s*/gi, '');

    return result;
}

// =============================================================================
// STATISTICS AND STATUS
// =============================================================================

/**
 * Get sanitisation statistics
 * 
 * @returns {object} - Statistics object
 */
function getSanitizationStats() {
    return {
        emailsSanitised: stats.emailsSanitised,
        subjectsSanitised: stats.subjectsSanitised,
        headersSanitised: stats.headersSanitised,
        threatsBlocked: stats.threatsBlocked,
        imagesProxied: stats.imagesProxied,
        lastSanitization: stats.lastSanitization,
        isHealthy: isInitialised,
        active: isInitialised
    };
}

/**
 * Get module status
 * 
 * @returns {object} - Status object
 */
function getStatus() {
    return {
        active: isInitialised,
        healthy: isInitialised,
        details: {
            initialised: isInitialised,
            dependenciesAvailable: !!(JSDOM && DOMPurifyFactory),
            stats: getSanitizationStats()
        }
    };
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Get the current configuration
 * 
 * @returns {object} - Current configuration
 */
function getConfig() {
    return {
        allowedTags: ALLOWED_TAGS,
        strictElements: STRICT_ELEMENTS,
        allowedAttributes: ALLOWED_ATTR,
        imageProxyPrefix: IMAGE_PROXY_PREFIX
    };
}

/**
 * Reinitialise DOMPurify (useful if dependencies were loaded after module init)
 * 
 * @returns {boolean} - Whether reinitialisation was successful
 */
function reinitialise() {
    isInitialised = false;
    initialise();
    return isInitialised;
}

// =============================================================================
// MODULE EXPORTS
// =============================================================================

module.exports = {
    sanitizeEmail,
    sanitizeSubject,
    sanitizeHeaders,
    getSanitizationStats,
    getStatus,
    getConfig,
    reinitialise
};
