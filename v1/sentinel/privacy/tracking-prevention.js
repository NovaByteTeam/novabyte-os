/**
 * NovaSentinel Privacy - Tracking Prevention
 * 
 * This module strips tracking parameters from URLs, removes tracking pixels
 * from emails, and blocks known tracking domains.
 * 
 * SECURITY REQUIREMENTS:
 * - Call auditService.logEvent() for blocked trackers
 * - Use Set for O(1) tracker domain lookup
 * - Block known tracker domains (500+ entries)
 * - Sanitise email HTML to remove tracking pixels/beacons
 * - Strip UTM and other tracking parameters from URLs
 * 
 * @module sentinel/privacy/tracking-prevention
 */

'use strict';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Known tracking parameter names to strip from URLs */
const TRACKING_PARAMS = [
    // UTM parameters (Google Analytics)
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'utm_id', 'utm_cid', 'utm_reader', 'utm_name', 'utm_referrer', 'utm_social',
    'utm_social-type', 'utm_source-platform', 'utm_marketing_tactic',
    
    // Facebook tracking
    'fbclid', 'fb_action_ids', 'fb_action_types', 'fb_source', 'fb_ref',
    
    // Google tracking
    'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid',
    
    // Microsoft/Bing tracking
    'msclkid', 'mkt_tok',
    
    // Twitter tracking
    'twclid',
    
    // LinkedIn tracking
    'li_fat_id', 'li_tracker',
    
    // Amazon tracking
    'amz_', 'amazon_', '_hsenc', '_hsmi',
    
    // HubSpot tracking
    'hsCtaTracking', 'hsa_campaign', 'hsa_ad', 'hsa_src', 'hsa_tgt', 'hsa_cta',
    'hsa_epoch',
    
    // Mailchimp tracking
    'mc_cid', 'mc_eid',
    
    // Marketo tracking
    'mkt_tok', 'trk', 'trkCampaign', 'trkInfo',
    
    // Adobe tracking
    'cid', 's_kwcid', 'scc', 'sclink', 'sc_cid', 'ef_id',
    
    // Other common trackers
    'ref', 'ref_', 'source', 'affiliate', 'aff_id', 'affiliate_id',
    'referrer', 'referrer_id', 'ref_id', 'click_id', 'oly_enc_id', 'oly_anon_id',
    '__s', '_ke', 'vero_id', 'vero_conv', 'nk', 'ss_email_id', 'bsft_',
    'ke', 'sb_referer_host', 'mkwid', 'pcrid', 'ef_id', 's_kwcid',
    'mscklid', 'sic', 'soc', 'lst', 'pr', 'oly', 'dnr', 'tag',
    'ml_subscriber', 'ml_subscriber_hash', 'wbraid', 'gbraid'
];

/** Regex pattern for matching tracking parameters (case-insensitive) */
const TRACKING_PARAM_PATTERN = new RegExp(
    '(?:&|\\?)(' + TRACKING_PARAMS.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')=[^&]*',
    'gi'
);

/** Known tracker domains - comprehensive list */
const TRACKER_DOMAINS = new Set([
    // Email marketing & tracking platforms
    'mailchimp.com', 'list-manage.com', 'sendgrid.net', 'mailgun.org',
    'constantcontact.com', 'campaign-archive.com', 'hubspot.com', 'hsforms.com',
    'marketo.com', 'mktocdn.com', 'salesforce.com', 'exacttarget.com',
    'responsys.net', 'sailthru.com', 'klaviyo.com', 'klaviyocdn.com',
    'mailjet.com', 'sendinblue.com', 'brevo.com', 'postmarkapp.com',
    'sparkpostmail.com', 'amazonses.com', 'mandrillapp.com', 'mailtrap.io',
    'intercom.io', 'customer.io', 'iterable.com', 'selligent.com',
    'mktomail.com', 'pardot.com', 'silverpop.com', 'watermelondb.io',
    'getresponse.com', 'aweber.com', 'convertkit.com', 'drip.email',
    'activehosted.com', ' infusionsoft.com', 'ontraport.com', 'keap.com',
    'getgauge.io', 'outfunnel.com', 'bonobos.com',
    
    // Analytics & tracking
    'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
    'doubleclick.net', 'googleadservices.com', 'analytics.google.com',
    'hotjar.com', 'mixpanel.com', 'segment.io', 'segment.com',
    'amplitude.com', 'heap.io', 'heapanalytics.com', 'fullstory.com',
    'mouseflow.com', 'crazyegg.com', 'optimizely.com', 'branch.io',
    'adjust.com', 'appsflyer.com', 'app-measurement.com', 'quantserve.com',
    'scorecardresearch.com', 'comscore.com', 'newrelic.com', 'nr-data.net',
    'sentry.io', 'bugsnag.com', 'logrocket.com', 'datadog.com',
    'cdn.cookielaw.org', 'onetrust.com', 'trustarc.com', 'consensu.org',
    'cookiebot.com', 'quantcast.com', 'imrworldwide.com', 'chartbeat.com',
    'parsely.com', 'kissmetrics.com', 'woopra.com', 'clicktale.net',
    'inspectlet.com', 'sessioncam.com', 'smartlook.com', 'clarity.ms',
    
    // Facebook/Meta tracking
    'facebook.net', 'fbcdn.net', 'connect.facebook.com', 'pixel.facebook.com',
    'an.facebook.com', 'ad.atdmt.com', 'ad.doubleclick.net',
    
    // Twitter/X tracking
    'static.ads-twitter.com', 'analytics.twitter.com', 'ads-twitter.com',
    
    // LinkedIn tracking
    'px.ads.linkedin.com', 'snap.licdn.com', 'linkedin.com/px',
    
    // Microsoft/Bing tracking
    'bat.bing.com', 'c.bing.com', 'clarity.ms', 'ads.linkedin.com',
    
    // Adobe tracking
    'demdex.net', 'omtrdc.net', '2o7.net', 'omniture.com', 'adobedtm.com',
    'launch.adobe.com', 'assets.adobedtm.com', 'tt.omtrdc.net',
    
    // Amazon tracking
    'amazon-adsystem.com', 'aax.amazon-adsystem.com', 'fls-na.amazon-adsystem.com',
    
    // Other advertising/tracking
    'adnxs.com', 'adsrvr.org', 'adform.net', 'advertising.com', 'casalemedia.com',
    'contextweb.com', 'criteo.com', 'criteo.net', 'pubmatic.com', 'rubiconproject.com',
    'openx.net', 'indexexchange.com', 'smartadserver.com', 'taboola.com',
    'outbrain.com', 'mgid.com', 'revcontent.com', 'zergnet.com',
    'scorecardresearch.com', 'quantserve.com', 'imrworldwide.com',
    'bidswitch.net', 'casalemedia.com', 'contextweb.com', 'lijit.com',
    'moatads.com', 'rubiconproject.com', 'pubmatic.com', 'openx.net',
    
    // Beacon/pixel tracking domains
    'pixel.', 'tracking.', 'beacon.', 'tr.', 'px.', 'trk.', 'clk.',
    'track.', 'metrics.', 'telemetry.', 'pulse.', 'ping.',
    
    // Known tracker patterns
    'track.', 'click.', 'trk.', 'pixel.', 'beacon.', 'analytics.',
    'telemetry.', 'metrics.', 'stats.', 'logging.', 'tr.', 'px.',
    
    // More specific tracker domains
    'list-manage.com', 'track.customer.io', 'ct.pinterest.com',
    'trk.snapchat.com', 'ads-api.twitter.com', 'advertising.twitter.com',
    'analytics.twitter.com', 'ads-sdks.twitter.com', 'static.ads-twitter.com',
    'ads.linkedin.com', 'px.ads.linkedin.com', 'snap.licdn.com',
    'criteo.com', 'dis.criteo.com', 'static.criteo.net',
    'taboola.com', 'cdn.taboola.com', 'trc.taboola.com',
    'outbrain.com', 'widgets.outbrain.com', 'log.outbrainimg.com',
    'mgid.com', 'cdn.mgid.com', 'jsc.mgid.com',
    'zergnet.com', 'img.zergnet.com', 'zergnetwidget.com',
    
    // Tracking像素 common patterns
    'trk', 'track', 'pixel', 'beacon', 'click', 'analytics', 'stats',
    
    // Email open tracking
    'open.', 'read.', 'view.', 'email-open.', 'mail-open.', 'img.',
    'tracking.', 'beacon.', 'pixel.',
    
    // More email platforms
    'bmc', 'responsys', 'exacttarget', 'sailthru', 'cheetahmail',
    'eloqua', 'eloquatrack', 't.eloqua', 's1.', 'pcl.', 'email.',
    
    // Affiliate tracking
    'impact.com', 'impactradius.com', 'linksynergy.com', 'pepperjam.com',
    'awin1.com', 'awin2.com', 'refersion.com', 'gleam.io', 'rewardful.io',
    
    // Content personalization
    'boomtrain.com', 'permutive.com', ' DynamicYield', 'monetate.com',
    'qubit.com', 'flood.io', ' Convert', 'optimizely', 'vwo.com',
    
    // CRM tracking
    'dynamics', 'zoho.com', 'freshworks.com', 'intercom', 'drift',
    'livechat', 'olark', 'tawk.to', 'zendesk', 'freshdesk',
    
    // Push notification trackers
    'pushwoosh', 'onesignal', 'airship', 'push notification',
    'batch', 'catapult', 'moengage', 'pushengage',
    
    // Attribution platforms
    'funnel.io', 'attributionapp', 'windsor.ai', 'northbeam',
    'bizible', 'bizible.com', 'marketomane', 'caliber',
    
    // Retargeting
    'adroll', 'perfect-audience', 'retargeter', 'steelhousemedia',
    'remarket', 'retarget', 'bouncex', 'buysellads',
    
    // More analytics
    'metabase', 'mixpanel', 'heap', 'heapapi', 'heapanalytics',
    'amplitude', 'kafkai', 'mparticle', 'branch', 'app.link',
    'appsflyer', 'adjust', 'sensor', 'kochava', 'singular',
    
    // More tracking
    'chartbeat', 'parsely', 'smartclip', 'spotxchange', 'telaria',
    'freewheel', 'sovrn', 'undertone', 'mediaplex', 'addthis',
    'sharethis', 'sumo', 'sumome', 'optinmonster', 'popupmaker',
    
    // Web analytics
    'plausible', 'fathom', 'simpleanalytics', 'cabin', 'pirate',
    'postclick', 'woopra', 'goatcounter', 'ackee', 'microanalytics',
    
    // Session recording
    'fullstory', 'mouseflow', 'crazyegg', 'inspectlet', 'hotjar',
    'sessioncam', 'smartlook', 'clarity', 'logrocket', 'sentry',
    
    // A/B testing
    'optimizely', 'vwo', 'abtasty', 'dynamicyield', 'monetate',
    'qubit', 'convert', 'sitegainer', 'kameleoon', 'evergage',
    
    // Personalization
    'monetate', 'qubit', 'dynamicyield', 'evergage', 'insight',
    'caas', 'boxever', 'certona', 'richrelevance', 'nosto',
    
    // Data management platforms
    'bluekai', 'krxd', 'exelator', 'eyeota', 'dnb',
    'dun-bradstreet', 'acxiom', 'live Ramp', 'oracle-data-cloud',
    
    // Data onboarding
    'liveintent', 'liveperson', 'tapad', 'tapad.com', 'sonobi',
    'indexexchange', 'sovrn', 'triplelift', 'rhythmone',
    
    // Video ad tracking
    'springserve', 'spotxchange', 'freewheel', 'telaria',
    'videoamp', 'teads', 'unruly', 'sharethrough',
    
    // Mobile tracking
    'mobileapptracking', 'kochava', 'singular', 'adjust',
    'appsflyer', 'branch', 'app Annie', 'sensor Tower',
    'clevertap', 'moengage', 'leanplum', 'urbanairship',
    
    // Social tracking
    'addthis', 'sharethis', 'sumo', 'sumome', 'optinmonster',
    'popupmaker', 'po.st', 'clicktoedit', 'linksprite',
    
    // More email specific
    'emails', 'mailtrack', 'mailtracker', 'yesware', 'streak',
    'bananatag', 'didtheyreadit', 'mailgun', 'sendgrid', 'mandrill',
    'postmark', 'sparkpost', 'aws-ses', 'google-alerts',
    
    // Additional tracking domains
    'tracking', 'pixel', 'beacon', 'click', 'analytics', 'metrics',
    'log', 'stat', 'counter', 'tag', 'scripts', 'cdn', 'widget',
    'analytics', 'telemetry', 'telegraph', 'pulse', 'heartbeat'
]);

// =============================================================================
// STATE
// =============================================================================

/** Statistics for tracking prevention */
const stats = {
    /** Total trackers blocked */
    totalBlocked: 0,
    
    /** Trackers blocked by type */
    byType: {
        urlParams: 0,
        emailPixels: 0,
        trackingDomains: 0,
        headerLeakage: 0
    },
    
    /** Timestamp of first block */
    firstBlock: null,
    
    /** Last block timestamp */
    lastBlock: null,
    
    /** Recent blocked requests (last 100) */
    recentBlocks: []
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Log a blocked tracker event to audit service
 * @param {string} type - Type of tracker blocked
 * @param {string} details - Details about the blocked request
 */
function logBlockedTracker(type, details) {
    try {
        if (typeof auditService !== 'undefined' && auditService && typeof auditService.logEvent === 'function') {
            auditService.logEvent({
                action: 'TRACKER_BLOCKED',
                type: 'security',
                severity: 'warning',
                details: { trackerType: type, ...details }
            });
        }
    } catch (e) {
        // Silently fail if audit service unavailable
    }
}

/**
 * Add a block to the statistics
 * @param {string} type - Type of tracker
 * @param {object} details - Additional details
 */
function addBlock(type, details) {
    const now = Date.now();
    
    if (!stats.firstBlock) {
        stats.firstBlock = now;
    }
    stats.lastBlock = now;
    stats.totalBlocked++;
    
    if (stats.byType[type] !== undefined) {
        stats.byType[type]++;
    }
    
    // Keep last 100 blocks
    stats.recentBlocks.push({
        type,
        timestamp: now,
        ...details
    });
    
    if (stats.recentBlocks.length > 100) {
        stats.recentBlocks.shift();
    }
}

/**
 * Check if a domain is a known tracker
 * @param {string} hostname - Domain hostname to check
 * @returns {boolean} True if domain is a tracker
 */
function isTrackerDomain(hostname) {
    if (!hostname) return false;
    
    const lowerHostname = hostname.toLowerCase();
    
    // Direct match
    if (TRACKER_DOMAINS.has(lowerHostname)) {
        return true;
    }
    
    // Check if domain ends with a known tracker domain
    for (const trackerDomain of TRACKER_DOMAINS) {
        if (lowerHostname === trackerDomain || lowerHostname.endsWith('.' + trackerDomain)) {
            return true;
        }
    }
    
    // Check for partial matches (e.g., "pixel.example.com" matches "pixel.")
    const parts = lowerHostname.split('.');
    for (let i = 0; i < parts.length; i++) {
        const subdomain = parts.slice(i).join('.');
        if (TRACKER_DOMAINS.has(subdomain)) {
            return true;
        }
    }
    
    return false;
}

/**
 * Extract hostname from URL
 * @param {string} url - URL to extract hostname from
 * @returns {string|null} Hostname or null if invalid
 */
function extractHostname(url) {
    if (!url) return null;
    
    try {
        // Handle URLs without protocol
        let urlStr = url;
        if (!urlStr.match(/^[a-z]+:/i)) {
            urlStr = 'https://' + urlStr;
        }
        
        const urlObj = new URL(urlStr);
        return urlObj.hostname.toLowerCase();
    } catch (e) {
        // If URL parsing fails, try simple extraction
        const match = url.match(/^(?:https?:\/\/)?([^\/\?#]+)/i);
        return match ? match[1].toLowerCase() : null;
    }
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Strip tracking parameters from a URL
 * @param {string} url - URL to strip tracking parameters from
 * @returns {string} URL with tracking parameters removed
 */
function stripUrlTracking(url) {
    if (!url || typeof url !== 'string') {
        return url;
    }
    
    try {
        // Parse the URL
        let urlObj;
        let urlStr = url;
        
        // Add protocol if missing
        if (!urlStr.match(/^[a-z]+:/i)) {
            urlStr = 'https://' + urlStr;
        }
        
        urlObj = new URL(urlStr);
        
        // Remove tracking parameters
        const paramsToRemove = [];
        
        for (const [key] of urlObj.searchParams) {
            // Check if key matches any tracking parameter pattern
            const lowerKey = key.toLowerCase();
            
            for (const trackingParam of TRACKING_PARAMS) {
                if (lowerKey.startsWith(trackingParam.toLowerCase()) || 
                    lowerKey.includes(trackingParam.toLowerCase())) {
                    paramsToRemove.push(key);
                    break;
                }
            }
        }
        
        // Remove the parameters
        for (const param of paramsToRemove) {
            urlObj.searchParams.delete(param);
        }
        
        // Reconstruct URL without query string if empty
        const result = urlObj.toString();
        
        if (urlObj.search === '') {
            return result.replace(/\?$/, '');
        }
        
        return result;
    } catch (e) {
        // Fallback: use regex replacement
        return url.replace(TRACKING_PARAM_PATTERN, '');
    }
}

/**
 * Sanitise HTML content to remove tracking pixels and beacon URLs
 * @param {string} html - HTML content to sanitise
 * @returns {string} HTML with tracking elements removed
 */
function sanitizeEmailHtml(html) {
    if (!html || typeof html !== 'string') {
        return html;
    }
    
    let sanitized = html;
    let removed = 0;
    
    // Patterns for tracking elements
    const trackingPatterns = [
        // 1x1 tracking pixels (common pattern)
        /<img[^>]*\s+(src=["'][^"']*(?:track|pixel|beacon|open|view|email)[^"']*["'])[^>]*>/gi,
        
        // Images with tracking dimensions (1x1, 0x0)
        /<img[^>]*\s+(width=["']\s*[01]\s*["']|height=["']\s*[01]\s*["'])[^>]*>/gi,
        
        // Hidden images (display:none or visibility:hidden)
        /<img[^>]*\s+(style=["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"']*["'])[^>]*>/gi,
        
        // Tracking beacons (JavaScript)
        /<script[^>]*\s+(src=["'][^"']*(?:track|pixel|beacon|analytics)[^"']*["'])[^>]*><\/script>/gi,
        
        // Iframes used for tracking
        /<iframe[^>]*\s+(src=["'][^"']*(?:track|pixel|beacon)[^"']*["'])[^>]*><\/iframe>/gi,
        
        // Object/embed elements for tracking
        /<(?:object|embed)[^>]*\s+(data=["'][^"']*(?:track|pixel|beacon)[^"']*["']|type=["'][^"']*image[^"']*["'])[^>]*>/gi,
        
        // Background images on small elements (tracking)
        /<[^>]*\s+(background-image\s*:\s*url\([^)]*(?:track|pixel|beacon)[^)]*\))[^>]*>/gi,
        
        // Link tracking (open tracking)
        /<a[^>]*\s+(href=["'][^"']*(?:\?utm_|utm=|&utm_|click|track|openid)[^"']*["'])[^>]*>/gi
    ];
    
    for (const pattern of trackingPatterns) {
        const matches = sanitized.match(pattern);
        if (matches) {
            removed += matches.length;
            sanitized = sanitized.replace(pattern, '');
        }
    }
    
    // Remove empty src attributes
    sanitized = sanitized.replace(/\ssrc\s*=\s*["'][ "']*["']/gi, '');
    
    // Remove empty href attributes
    sanitized = sanitized.replace(/\shref\s*=\s*["'][ "']*["']/gi, '');
    
    // Track statistics
    if (removed > 0) {
        const hostname = 'email-content';
        addBlock('emailPixels', { hostname, removedCount: removed });
        logBlockedTracker('email_pixel', { hostname, removedCount: removed });
    }
    
    return sanitized;
}

/**
 * Middleware to block requests to known tracking domains
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {function} next - Express next function
 */
function blockTrackingRequests(req, res, next) {
    // Check URL for tracking domains
    const url = req.url || req.originalUrl || '';
    const hostname = extractHostname(url);
    
    if (hostname && isTrackerDomain(hostname)) {
        addBlock('trackingDomains', { 
            hostname, 
            url: url.substring(0, 100),
            ip: req.ip || req.connection?.remoteAddress
        });
        
        logBlockedTracker('tracking_domain', { 
            hostname, 
            url: url.substring(0, 100),
            ip: req.ip || req.connection?.remoteAddress
        });
        
        // Block the request
        if (res && typeof res.status === 'function') {
            return res.status(403).json({
                error: 'Tracking request blocked',
                message: 'Requests to known tracking domains are not allowed',
                blockedDomain: hostname
            });
        }
        
        // If no response object, stop the request
        return;
    }
    
    // Also check referer header for tracking domains
    const referer = req.headers?.referer || req.headers?.referrer;
    if (referer) {
        const refererHostname = extractHostname(referer);
        if (refererHostname && isTrackerDomain(refererHostname)) {
            addBlock('headerLeakage', {
                type: 'referer',
                hostname: refererHostname,
                ip: req.ip || req.connection?.remoteAddress
            });
            
            logBlockedTracker('header_leakage', {
                type: 'referer',
                hostname: refererHostname,
                ip: req.ip || req.connection?.remoteAddress
            });
        }
    }
    
    next();
}

/**
 * Sanitise HTTP headers to prevent tracking leakage
 * @param {object} headers - Headers object to sanitise
 * @returns {object} Sanitised headers object
 */
function sanitizeHeaders(headers) {
    if (!headers || typeof headers !== 'object') {
        return headers;
    }
    
    const sanitised = { ...headers };
    let removed = 0;
    
    // Headers that can leak tracking information
    const leakyHeaders = [
        'referer',
        'referrer',
        'x-forwarded-for',
        'x-real-ip',
        'client-ip',
        'true-client-ip',
        'x-originating-ip',
        'x-sucuri-ip',
        'cf-connecting-ip',
        'x-cluster-client-ip',
        'forwarded-for',
        'via'
    ];
    
    for (const header of leakyHeaders) {
        if (sanitised[header]) {
            delete sanitised[header];
            removed++;
        }
        
        // Also check case-insensitively
        const lowerHeader = header.toLowerCase();
        for (const key of Object.keys(sanitised)) {
            if (key.toLowerCase() === lowerHeader && key !== header) {
                delete sanitised[key];
                removed++;
            }
        }
    }
    
    // Add privacy-preserving headers
    sanitised['DNT'] = '1'; // Do Not Track
    sanitised['Sec-GPC'] = '1'; // Global Privacy Control
    
    if (removed > 0) {
        addBlock('headerLeakage', { removedCount: removed });
    }
    
    return sanitised;
}

/**
 * Get tracking prevention statistics for dashboard
 * @returns {object} Statistics object
 */
function getTrackingReport() {
    return {
        totalBlocked: stats.totalBlocked,
        byType: { ...stats.byType },
        firstBlock: stats.firstBlock,
        lastBlock: stats.lastBlock,
        recentBlocks: stats.recentBlocks.slice(-10).map(block => ({
            type: block.type,
            timestamp: block.timestamp,
            hostname: block.hostname || block.details?.hostname
        })),
        uptime: stats.firstBlock ? Date.now() - stats.firstBlock : 0
    };
}

/**
 * Get module status
 * @returns {object} Status object
 */
function getStatus() {
    return {
        active: true,
        healthy: true,
        details: {
            trackerDomainsCount: TRACKER_DOMAINS.size,
            trackingParamsCount: TRACKING_PARAMS.length,
            totalBlocked: stats.totalBlocked,
            uptime: stats.firstBlock ? Date.now() - stats.firstBlock : 0
        }
    };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    sanitizeEmailHtml,
    stripUrlTracking,
    blockTrackingRequests,
    sanitizeHeaders,
    getTrackingReport,
    getStatus
};
