/**
 * NovaSentinel Service Worker
 * 
 * Browser-based Service Worker that mirrors sentinel-middleware.js functionality.
 * Intercepts all fetch() calls and applies the full security pipeline.
 * 
 * SECURITY REQUIREMENTS:
 * - Intercept ALL fetch() calls via self.addEventListener('fetch', event => {...})
 * - Port existing pipeline: zero-trust, session-guard, behavioral-ai, anomaly detection,
 *   risk-scorer, abuse-ipdb, safe-browsing, anti-fingerprint, tracking-prevention, tamper-detect
 * - Preserve exact check ordering and update/repair path bypass
 * - Use crypto.subtle for all crypto operations (SHA-256 for hashing, etc.)
 * - Build rolling 60-second request window in a Map keyed by session ID
 * - Flag anomalies: request rate > 30/min, unique endpoints > 20, failed auth count > 3
 * - Accumulate risk score as req.sentinelRiskScore
 * - Return appropriate responses (403 for blocked, add protection headers, etc.)
 * - Use BroadcastChannel API for cross-tab communication
 * - Include proper error handling - allow request through on error but log
 * 
 * @module sentinel/sentinel-service-worker
 */

// Service Worker global scope
const SW_VERSION = '1.0.0';
const SW_NAME = 'NovaSentinel Service Worker';

// =============================================================================
// CRYPTO UTILITIES (using crypto.subtle)
// =============================================================================

/**
 * Compute SHA-256 hash using crypto.subtle
 * @param {string|ArrayBuffer} data - Data to hash
 * @returns {Promise<string>} Hex-encoded hash
 */
async function sha256(data) {
    const encoder = new TextEncoder();
    const dataBuffer = typeof data === 'string' ? encoder.encode(data) : data;
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate random tokens using crypto.subtle
 * @param {number} length - Token length in bytes
 * @returns {Promise<string>} Hex-encoded token
 */
async function generateToken(length = 32) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Timing-safe string comparison
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} True if equal
 */
function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
}

// =============================================================================
// PROTECTION STATES
// Managed via BroadcastChannel for cross-tab sync
// =============================================================================

const protectionStates = new Map([
    ['zero-trust', true],
    ['session-guard', true],
    ['behavioral-ai', true],
    ['anomaly', true],
    ['risk-scorer', true],
    ['abuse-ipdb', true],
    ['safe-browsing', true],
    ['anti-fingerprint', true],
    ['tracking-prevention', true],
    ['tamper-detect', true]
]);

/**
 * Get protection state
 * @param {string} protectionId - The protection ID
 * @returns {boolean} Whether the protection is enabled
 */
function isProtectionEnabled(protectionId) {
    return protectionStates.get(protectionId) ?? true;
}

/**
 * Set protection state (called from main thread via postMessage)
 * @param {string} protectionId - Protection ID
 * @param {boolean} enabled - Enabled state
 */
function setProtectionState(protectionId, enabled) {
    protectionStates.set(protectionId, enabled);
    broadcastState();
}

/**
 * Broadcast current state to all tabs
 */
function broadcastState() {
    if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel('sentinel-state');
        channel.postMessage({
            type: 'state-update',
            states: Object.fromEntries(protectionStates)
        });
    }
}

// =============================================================================
// SESSION MANAGEMENT
// =============================================================================

/**
 * Session data structure
 * @typedef {Object} SessionData
 * @property {string} sessionId - Unique session identifier
 * @property {string} userId - User identifier
 * @property {string} ip - Client IP address
 * @property {string} userAgent - User agent string
 * @property {number} createdAt - Session creation timestamp
 * @property {number} lastActivity - Last activity timestamp
 * @property {string} fingerprint - Session fingerprint hash
 */

/** Active sessions Map<sessionId, SessionData> */
const sessions = new Map();

/**
 * Create or update session
 * @param {Object} data - Session data
 * @returns {SessionData} Session object
 */
async function createSession(data) {
    const { sessionId, userId, ip, userAgent } = data;
    const fingerprint = await sha256(`${ip}:${userAgent}`);
    const now = Date.now();
    
    const session = {
        sessionId,
        userId: userId || ip,
        ip,
        userAgent,
        createdAt: now,
        lastActivity: now,
        fingerprint
    };
    
    sessions.set(sessionId, session);
    return session;
}

/**
 * Get session by ID
 * @param {string} sessionId - Session ID
 * @returns {SessionData|undefined} Session data
 */
function getSession(sessionId) {
    return sessions.get(sessionId);
}

/**
 * Validate session integrity
 * @param {string} sessionId - Session ID
 * @param {Object} currentData - Current request data
 * @returns {Object} { valid: boolean, reason?: string }
 */
async function validateSessionIntegrity(sessionId, currentData) {
    const session = sessions.get(sessionId);
    if (!session) {
        return { valid: true }; // New session, allow
    }
    
    // Check IP binding
    if (session.ip !== currentData.ip) {
        const ipChangeCount = (session.ipChanges || 0) + 1;
        session.ipChanges = ipChangeCount;
        
        if (ipChangeCount > 3) {
            return { valid: false, reason: 'Excessive IP changes' };
        }
    }
    
    // Check User-Agent binding
    const currentFingerprint = await sha256(`${currentData.ip}:${currentData.userAgent}`);
    if (session.fingerprint && session.fingerprint !== currentFingerprint) {
        return { valid: false, reason: 'Device changed' };
    }
    
    // Update last activity
    session.lastActivity = Date.now();
    
    return { valid: true };
}

// =============================================================================
// ZERO TRUST
// =============================================================================

const DEFAULT_TRUST_SCORE = 50;
const DEFAULT_REVERIFICATION_THRESHOLD = 60;
const TRUST_DECAY_INTERVAL = 5 * 60 * 1000;
const TRUST_DECAY_AMOUNT = 2;

/** User trust profiles Map<userId, trustProfile> */
const trustProfiles = new Map();

/**
 * Verify request using Zero Trust principles
 * @param {Object} requestData - Request data
 * @returns {Promise<{ verified: boolean, reason?: string }>}
 */
async function verifyRequest(requestData) {
    const { sessionId, userId, ip, path, method } = requestData;
    const userKey = userId || sessionId || ip;
    
    let profile = trustProfiles.get(userKey);
    if (!profile) {
        profile = {
            trustScore: DEFAULT_TRUST_SCORE,
            lastVerified: Date.now(),
            lastPath: path,
            failedAuths: 0
        };
        trustProfiles.set(userKey, profile);
    }
    
    // Trust decay
    const timeSinceLastVerified = Date.now() - profile.lastVerified;
    if (timeSinceVerified > TRUST_DECAY_INTERVAL) {
        const decayIntervals = Math.floor(timeSinceVerified / TRUST_DECAY_INTERVAL);
        profile.trustScore = Math.max(0, profile.trustScore - (decayIntervals * TRUST_DECAY_AMOUNT));
    }
    
    // Check re-verification threshold
    if (profile.trustScore < DEFAULT_REVERIFICATION_THRESHOLD - 10) {
        return {
            verified: false,
            reason: `Trust score too low: ${profile.trustScore}`
        };
    }
    
    // Check for high-risk methods without proper authentication
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
        if (!sessionId && !userId) {
            profile.trustScore -= 10;
        }
    }
    
    // Record path
    profile.lastPath = path;
    profile.lastVerified = Date.now();
    
    return { verified: true };
}

// =============================================================================
// ROLLING REQUEST WINDOW (60-second window per session)
// =============================================================================

const REQUEST_WINDOW_MS = 60 * 1000;
const ANOMALY_REQUEST_RATE = 30; // requests per minute
const ANOMALY_UNIQUE_ENDPOINTS = 20;
const ANOMALY_FAILED_AUTH = 3;

/** Request window: Map<sessionId, { requests: Array, endpoints: Set, failedAuths: number }> */
const requestWindows = new Map();

/**
 * Record request in rolling window
 * @param {string} sessionId - Session ID
 * @param {string} endpoint - Request endpoint
 * @param {boolean} authFailed - Whether authentication failed
 */
function recordRequest(sessionId, endpoint, authFailed = false) {
    const now = Date.now();
    let window = requestWindows.get(sessionId);
    
    if (!window) {
        window = {
            requests: [],
            endpoints: new Set(),
            failedAuths: 0
        };
        requestWindows.set(sessionId, window);
    }
    
    // Clean old requests outside window
    window.requests = window.requests.filter(t => now - t < REQUEST_WINDOW_MS);
    
    // Record new request
    window.requests.push(now);
    window.endpoints.add(endpoint);
    
    if (authFailed) {
        window.failedAuths++;
    }
    
    return window;
}

/**
 * Check for anomalies in request pattern
 * @param {string} sessionId - Session ID
 * @returns {Object} { isAnomaly: boolean, reasons: string[] }
 */
function checkAnomalies(sessionId) {
    const window = requestWindows.get(sessionId);
    if (!window) {
        return { isAnomaly: false, reasons: [] };
    }
    
    const reasons = [];
    const now = Date.now();
    const recentRequests = window.requests.filter(t => now - t < REQUEST_WINDOW_MS).length;
    
    // Check request rate
    if (recentRequests > ANOMALY_REQUEST_RATE) {
        reasons.push(`Request rate: ${recentRequests}/min > ${ANOMALY_REQUEST_RATE}/min`);
    }
    
    // Check unique endpoints
    if (window.endpoints.size > ANOMALY_UNIQUE_ENDPOINTS) {
        reasons.push(`Unique endpoints: ${window.endpoints.size} > ${ANOMALY_UNIQUE_ENDPOINTS}`);
    }
    
    // Check failed auths
    if (window.failedAuths > ANOMALY_FAILED_AUTH) {
        reasons.push(`Failed auths: ${window.failedAuths} > ${ANOMALY_FAILED_AUTH}`);
    }
    
    return {
        isAnomaly: reasons.length > 0,
        reasons,
        requestRate: recentRequests,
        uniqueEndpoints: window.endpoints.size,
        failedAuths: window.failedAuths
    };
}

// =============================================================================
// BEHAVIORAL AI (Statistical fallback for browser)
// =============================================================================

const FEATURES = {
    HOUR: 0,
    DAY_OF_WEEK: 1,
    REQUEST_RATE: 2,
    UNIQUE_ENDPOINTS: 3,
    FAILED_AUTHS: 4,
    DATA_VOLUME: 5,
    IP_CHANGES: 6
};

/** Feature mean for statistical baseline */
const BASELINE_MEANS = [12, 3.5, 5, 3, 0, 1000, 0];
const BASELINE_STDS = [5, 2, 3, 2, 1, 500, 0.5];

/**
 * Analyze behavior for anomalies (statistical fallback)
 * @param {string} userId - User ID
 * @param {Object} behavior - Behavior data
 * @returns {Promise<{ isAnomaly: boolean, confidence: number, score: number }>}
 */
async function isAnomaly(userId, behavior) {
    const { timestamp, hour, dayOfWeek, requestRate, uniqueEndpoints, failedAuths, dataVolume, ipChanges } = behavior;
    
    // Build feature vector
    const hourOfDay = hour !== undefined ? hour : new Date(timestamp).getHours();
    const dayNum = dayOfWeek !== undefined ? dayOfWeek : new Date(timestamp).getDay();
    
    const features = [
        hourOfDay,
        dayNum,
        requestRate || 1,
        uniqueEndpoints || 1,
        failedAuths || 0,
        dataVolume || 0,
        ipChanges || 0
    ];
    
    // Calculate Mahalanobis-like distance
    let score = 0;
    for (let i = 0; i < features.length; i++) {
        const z = (features[i] - BASELINE_MEANS[i]) / BASELINE_STDS[i];
        score += z * z;
    }
    
    // Normalize to 0-1
    score = Math.sqrt(score / features.length);
    
    // Score > 1.5 means anomaly (roughly 1.5 std deviations)
    const isAnomalyResult = score > 1.5;
    const confidence = Math.min(0.99, score / 2);
    
    return {
        isAnomaly: isAnomalyResult,
        confidence,
        score
    };
}

// =============================================================================
// ANOMALY DETECTION (Attack patterns)
// =============================================================================

const ATTACK_PATTERNS = {
    sqlInjection: [
        /\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE|TRUNCATE)\b.*\b(FROM|TABLE|DATABASE)\b/i,
        /--/,
        /;/,
        /\/\*/,
        /\*\//,
        /xp_/i,
        /sp_/i,
        /\bexec\b/i,
        /\bexecute\b/i,
        /\bscript\b/i,
        /\bOR\b.*\b=\b/i,
        /\bAND\b.*\b=\b/i,
        /union.*select/i,
        /select.*from.*where/i,
        /1=1/,
        /2=2/,
        /'1'='1'/
    ],
    pathTraversal: [
        /\.\.[\/\\]/,
        /\.\.%2f/i,
        /\.\.%5c/i,
        /%2e%2e[\/\\]/i,
        /etc\/passwd/i,
        /boot\.ini/i,
        /windows\/system32/i,
        /\/etc\/\./i,
        /\/proc\/\./i,
        /\/sys\/\./i
    ],
    portScanning: [
        /^[\d]+\/[\d]+$/,
        /port\s*:\s*\d+/i,
        /\b(21|22|23|25|53|80|110|143|443|445|3306|3389|5432|8080|8443)\b/
    ]
};

/**
 * Detect known attack patterns
 * @param {string} data - Data to check
 * @returns {Object} { detected: boolean, types: string[] }
 */
function detectPatterns(data) {
    if (!data) {
        return { detected: false, types: [] };
    }
    
    const dataStr = String(data);
    const types = [];
    
    // Check each pattern category
    for (const [category, patterns] of Object.entries(ATTACK_PATTERNS)) {
        for (const pattern of patterns) {
            if (pattern.test(dataStr)) {
                types.push(category);
                break;
            }
        }
    }
    
    return {
        detected: types.length > 0,
        types
    };
}

// =============================================================================
// RISK SCORING
// =============================================================================

const RISK_WEIGHTS = {
    behavioural: 30,
    geoVelocity: 20,
    device: 15,
    timeOfDay: 10,
    authFailures: 15,
    ipReputation: 10
};

const RISK_THRESHOLDS = {
    LOW: { min: 0, max: 30, label: 'low' },
    MEDIUM: { min: 31, max: 60, label: 'medium' },
    HIGH: { min: 61, max: 80, label: 'high' },
    CRITICAL: { min: 81, max: 100, label: 'critical' }
};

/** User risk profiles */
const userRiskProfiles = new Map();

/**
 * Calculate dynamic risk score
 * @param {string} userId - User ID
 * @param {Object} context - Risk context
 * @returns {Promise<{ score: number, level: string }>}
 */
async function calculateRisk(userId, context) {
    const { ip, userAgent, path, method, timestamp } = context;
    let profile = userRiskProfiles.get(userId);
    
    if (!profile) {
        profile = {
            currentScore: 0,
            factors: {},
            lastUpdated: Date.now()
        };
        userRiskProfiles.set(userId, profile);
    }
    
    let score = 0;
    const factors = {};
    
    // Behavioral factor (placeholder - would integrate with behavioral AI)
    factors.behavioural = 0;
    score += factors.behavioural * RISK_WEIGHTS.behavioural / 100;
    
    // Time-of-day factor
    const hour = new Date(timestamp || Date.now()).getHours();
    factors.timeOfDay = (hour < 6 || hour > 22) ? 20 : 0;
    score += factors.timeOfDay * RISK_WEIGHTS.timeOfDay / 100;
    
    // Method risk
    if (['DELETE', 'PUT'].includes(method)) {
        factors.methodRisk = 15;
        score += factors.methodRisk;
    }
    
    // Path risk (sensitive paths)
    const sensitivePaths = ['/admin', '/api/admin', '/auth', '/api/auth', '/account', '/api/account'];
    if (sensitivePaths.some(p => path.startsWith(p))) {
        factors.pathRisk = 10;
        score += factors.pathRisk;
    }
    
    // Failed auths factor
    const window = requestWindows.get(userId);
    if (window && window.failedAuths > 0) {
        factors.authFailures = Math.min(30, window.failedAuths * 10);
        score += factors.authFailures * RISK_WEIGHTS.authFailures / 100;
    }
    
    // Cap at 100
    score = Math.min(100, Math.round(score));
    
    profile.currentScore = score;
    profile.factors = factors;
    profile.lastUpdated = Date.now();
    
    let level = RISK_THRESHOLDS.LOW.label;
    if (score > RISK_THRESHOLDS.CRITICAL.min) level = RISK_THRESHOLDS.CRITICAL.label;
    else if (score > RISK_THRESHOLDS.HIGH.min) level = RISK_THRESHOLDS.HIGH.label;
    else if (score > RISK_THRESHOLDS.MEDIUM.min) level = RISK_THRESHOLDS.MEDIUM.label;
    
    return { score, level };
}

// =============================================================================
// ABUSE IPDB (Browser simulation - uses cached data)
// =============================================================================

/** Known bad IP prefixes (simulated) */
const KNOWN_BAD_IPS = new Set([
    '192.0.2.',
    '198.51.100.',
    '203.0.113.',
    '100.64.',
    '10.',
    '172.16.',
    '169.254.'
]);

/**
 * Check IP reputation (simplified browser version)
 * @param {string} ip - IP address
 * @returns {Promise<{ isAbusive: boolean, score?: number }>}
 */
async function checkIP(ip) {
    if (!ip) {
        return { isAbusive: false };
    }
    
    // Check if private IP (not actually abusive)
    for (const prefix of KNOWN_BAD_IPS) {
        if (ip.startsWith(prefix)) {
            return { isAbusive: false }; // Private IP, not abusive
        }
    }
    // Simulate check - in real implementation would call API
    return { isAbusive: false };
}

// =============================================================================
// SAFE BROWSING (URL checking)
// =============================================================================

/** Known malicious patterns */
const MALICIOUS_PATTERNS = [
    /javascript:/i,
    /data:/i,
    /vbscript:/i,
    /on\w+\s*=/i,
    /eval\s*\(/i,
    /expression\s*\(/i
];

/**
 * Check URL for threats
 * @param {string} url - URL to check
 * @returns {Promise<{ threat: boolean, reason?: string }>}
 */
async function checkUrl(url) {
    if (!url) {
        return { threat: false };
    }
    
    try {
        // Check for malicious patterns
        for (const pattern of MALICIOUS_PATTERNS) {
            if (pattern.test(url)) {
                return { threat: true, reason: 'Malicious pattern detected' };
            }
        }
        
        // Check for suspicious TLDs
        const urlObj = new URL(url);
        const suspiciousTlds = ['.xyz', '.top', '.click', '.gq', '.cf', '.tk'];
        if (suspiciousTlds.some(t => urlObj.hostname.endsWith(t))) {
            return { threat: true, reason: 'Suspicious TLD' };
        }
    } catch (e) {
        // Invalid URL, might be attack attempt
        return { threat: true, reason: 'Invalid URL' };
    }
    
    return { threat: false };
}

/**
 * Detect malicious patterns in file content (HTML/JS)
 * @param {string} content - File content to scan
 * @returns {Object} { threat: boolean, threats: [], patterns: [] }
 */
function detectMaliciousPatterns(content) {
    const threats = [];
    const matchedPatterns = [];
    
    if (!content || typeof content !== 'string') {
        return { threat: false, threats: [], patterns: [] };
    }
    
    // XSS patterns
    const xssPatterns = [
        { regex: /<script[\s\S]*?<\/script>/gi, name: 'script-tag' },
        { regex: /on\w+\s*=\s*["'][^"']*["']/gi, name: 'event-handler' },
        { regex: /javascript:/gi, name: 'javascript-url' },
        { regex: /eval\s*\(/gi, name: 'eval-call' },
        { regex: /innerHTML\s*=/gi, name: 'innerHTML-assign' },
        { regex: /document\.write\s*\(/gi, name: 'document-write' }
    ];
    
    // Code injection patterns
    const injectionPatterns = [
        { regex: /new\s+Function\s*\(/gi, name: 'function-constructor' },
        { regex: /setTimeout\s*\(\s*["']/gi, name: 'setTimeout-string' },
        { regex: /setInterval\s*\(\s*["']/gi, name: 'setInterval-string' }
    ];
    
    // Malware indicators
    const malwarePatterns = [
        { regex: /\.exe|\.dll|\.scr|\.vbs|\.bat|\.cmd/gi, name: 'executable' },
        { regex: /eval\(.*atob/gi, name: 'encoded-eval' },
        { regex: /fetch\s*\(\s*["']https?:\/\/(?!localhost|127\.0\.0\.1)/i, name: 'external-fetch' }
    ];
    
    // Check all patterns
    const allPatterns = [...xssPatterns, ...injectionPatterns, ...malwarePatterns];
    
    for (const { regex, name } of allPatterns) {
        if (regex.test(content)) {
            matchedPatterns.push(name);
            threats.push({
                type: name,
                severity: name.includes('executable') ? 'critical' : 'high'
            });
        }
    }
    
    return {
        threat: matchedPatterns.length > 0,
        threats,
        patterns: matchedPatterns
    };
}

// =============================================================================
// ANTI-FINGERPRINT (Protection headers)
// =============================================================================

const PROTECTION_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp'
};

/**
 * Get anti-fingerprint protection headers
 * @returns {Object} Headers object
 */
function getProtectionHeaders() {
    return { ...PROTECTION_HEADERS };
}

// =============================================================================
// TRACKING PREVENTION
// =============================================================================

const TRACKING_PARAMS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'utm_id', 'utm_cid', 'fbclid', 'gclid', 'gclsrc', 'dclid',
    'msclkid', 'twclid', 'ref', 'source', 'affiliate', 'aff_id'
]);

/**
 * Strip tracking parameters from URL
 * @param {string} url - URL to clean
 * @returns {string} Cleaned URL
 */
function stripTrackingParams(url) {
    if (!url) return url;
    
    try {
        const urlObj = new URL(url);
        const params = urlObj.searchParams;
        
        for (const param of TRACKING_PARAMS) {
            params.delete(param);
        }
        
        return urlObj.toString();
    } catch {
        return url;
    }
}

// =============================================================================
// TAMPER DETECTION (Browser version)-d
// =============================================================================

/**
 * Verify integrity of Service Worker
 * @returns {Promise<{ tampered: [], missing: [], ok: [], errors: [] }>}
 */
async function verifyIntegrity() {
    // In browser, we can only verify the SW is loaded
    // Full file integrity would need server cooperation
    const errors = [];
    
    // Check SW is active
    if (!self.registration || !self.registration.active) {
        errors.push('Service Worker not active');
    }
    
    return {
        tampered: [],
        missing: [],
        ok: ['sentinel-service-worker.js'],
        errors
    };
}

// =============================================================================
// BROADCAST CHANNEL (Cross-tab communication)
// =============================================================================

let broadcastChannel = null;

function initBroadcastChannel() {
    if (typeof BroadcastChannel !== 'undefined') {
        try {
            broadcastChannel = new BroadcastChannel('sentinel-events');
            broadcastChannel.onmessage = handleBroadcastMessage;
        } catch (e) {
            console.warn('[Sentinel] BroadcastChannel not available');
        }
    }
}

function handleBroadcastMessage(event) {
    const { type, data } = event.data;
    
    switch (type) {
        case 'anomaly-detected':
            // Log anomaly from another tab
            logSecurityEvent('anomaly-detected', data);
            break;
        case 'risk-update':
            // Update risk profile from another tab
            if (data.userId && data.score !== undefined) {
                userRiskProfiles.set(data.userId, data.profile);
            }
            break;
        case 'state-sync':
            // Sync protection states
            if (data.states) {
                for (const [id, enabled] of Object.entries(data.states)) {
                    protectionStates.set(id, enabled);
                }
            }
            break;
    }
}

function broadcastAnomaly(data) {
    if (broadcastChannel) {
        broadcastChannel.postMessage({
            type: 'anomaly-detected',
            data
        });
    }
}

function broadcastRiskUpdate(userId, profile) {
    if (broadcastChannel) {
        broadcastChannel.postMessage({
            type: 'risk-update',
            data: { userId, profile }
        });
    }
}

// =============================================================================
// SECURITY EVENT LOGGING
// =============================================================================

/**
 * Log security event
 * @param {string} event - Event type
 * @param {Object} data - Event data
 */
function logSecurityEvent(event, data = {}) {
    const logEntry = {
        event,
        data,
        timestamp: Date.now(),
        swVersion: SW_VERSION
    };
    
    console.log(`[Sentinel ${event}]`, JSON.stringify(logEntry));
    
    // Also send to server if endpoint available
    if (typeof fetch !== 'undefined') {
        // Async fire-and-forget
        fetch('/api/audit/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(logEntry)
        }).catch(() => {}); // Ignore errors
    }
}

// =============================================================================
// SERVICE WORKER INSTALLATION
// =============================================================================

self.addEventListener('install', (event) => {
    console.log(`[${SW_NAME}] Installing v${SW_VERSION}`);
    self.skipWaiting(); // Activate immediately
});

self.addEventListener('activate', (event) => {
    console.log(`[${SW_NAME}] Activated v${SW_VERSION}`);
    initBroadcastChannel();
    
    // Take control immediately
    event.waitUntil(self.clients.claim());
});

// =============================================================================
// FETCH INTERCEPTOR
// The core of the Service Worker - intercepts ALL fetch() calls
// =============================================================================

self.addEventListener('fetch', (event) => {
    const startTime = Date.now();
    const url = event.request.url;
    const method = event.request.method;
    
    // Extract session from cookies or headers
    const cookies = parseCookies(event.request.headers.get('Cookie') || '');
    const sessionId = cookies['nova.sid'] || event.request.headers.get('X-Session-ID');
    const userId = event.request.headers.get('X-User-ID');
    
    // Build request context
    const requestData = {
        url,
        method,
        path: new URL(url).pathname,
        sessionId,
        userId,
        ip: event.request.headers.get('X-Forwarded-For') || 
           event.request.headers.get('CF-Connecting-IP') || 
           'unknown',
        userAgent: event.request.headers.get('User-Agent') || 'unknown',
        headers: Object.fromEntries(event.request.headers.entries())
    };
    
    // Check if update/repair path (skip heavy AI checks)
    const isUpdateOrRepair = requestData.path.startsWith('/update/') || 
                           requestData.path.startsWith('/api/update/') ||
                           requestData.path.startsWith('/repair/') || 
                           requestData.path.startsWith('/api/repair/');
    
    // Initialize risk score
    let riskScore = 0;
    
    // Process request through security pipeline
    event.respondWith(processRequest(event.request, requestData, isUpdateOrRepair, startTime, riskScore));
});

/**
 * Process request through security pipeline
 * @param {Request} request - Original request
 * @param {Object} requestData - Parsed request data
 * @param {boolean} isUpdateOrRepair - Whether this is an update/repair path
 * @param {number} startTime - Start timestamp
 * @param {number} riskScore - Initial risk score
 * @returns {Promise<Response>} Processed response
 */
async function processRequest(request, requestData, isUpdateOrRepair, startTime, riskScore) {
    const { sessionId, userId, path, method, ip, userAgent } = requestData;
    const userKey = userId || sessionId || ip;
    
    try {
        // ------------------------------------------------------------------
        // 1. Zero Trust - Verify every request
        // ------------------------------------------------------------------
        if (!isUpdateOrRepair && isProtectionEnabled('zero-trust')) {
            const verification = await verifyRequest(requestData);
            if (!verification.verified) {
                logSecurityEvent('zero-trust-blocked', { path, reason: verification.reason });
                return createBlockedResponse('Zero Trust Verification Failed', verification.reason);
            }
        }
        
        // ------------------------------------------------------------------
        // 2. Session Guard - Validate session integrity
        // ------------------------------------------------------------------
        if (!isUpdateOrRepair && isProtectionEnabled('session-guard') && sessionId) {
            const sessionResult = await validateSessionIntegrity(sessionId, { ip, userAgent });
            if (!sessionResult.valid) {
                logSecurityEvent('session-guard-blocked', { sessionId, reason: sessionResult.reason });
                riskScore += 20;
            }
        }
        
        // ------------------------------------------------------------------
        // 3-5 skipped for update/repair paths (heavy AI checks)
        // ------------------------------------------------------------------
        
        // ------------------------------------------------------------------
        // 3. Behavioral AI - Analyze request patterns
        // ------------------------------------------------------------------
        if (!isUpdateOrRepair && isProtectionEnabled('behavioral-ai') && !isUpdateOrRepair) {
            const currentBehavior = {
                timestamp: Date.now(),
                hour: new Date().getHours(),
                dayOfWeek: new Date().getDay(),
                requestRate: 1,
                uniqueEndpoints: 1,
                failedAuths: 0,
                ipChanges: 0
            };
            
            const behaviorResult = await isAnomaly(userKey, currentBehavior);
            if (behaviorResult.isAnomaly) {
                logSecurityEvent('behavioral-ai-flagged', { 
                    userId: userKey, 
                    score: behaviorResult.score,
                    confidence: behaviorResult.confidence 
                });
                riskScore += 30;
                broadcastAnomaly({ userId: userKey, type: 'behavioral', ...behaviorResult });
            }
        }
        
        // ------------------------------------------------------------------
        // 4. Anomaly Detection - Attack pattern detection
        // ------------------------------------------------------------------
        if (!isUpdateOrRepair && isProtectionEnabled('anomaly')) {
            // Check URL params and body
            const url = new URL(request.url);
            const searchData = url.search.slice(1) + 
                (request.clone ? (await request.clone().text()).slice(0, 1000) : '');
            
            const patternResult = detectPatterns(searchData);
            if (patternResult.detected) {
                logSecurityEvent('anomaly-detected', { path, types: patternResult.types });
                riskScore += 25;
            }
        }
        
        // ------------------------------------------------------------------
        // 5. Risk Scoring
        // ------------------------------------------------------------------
        if (!isUpdateOrRepair && isProtectionEnabled('risk-scorer')) {
            const riskResult = await calculateRisk(userKey, {
                ip,
                userAgent,
                path,
                method,
                timestamp: Date.now()
            });
            
            riskScore += riskResult.score;
            
            if (riskResult.score > 80) {
                logSecurityEvent('high-risk-blocked', { 
                    userId: userKey, 
                    score: riskResult.score,
                    level: riskResult.level 
                });
                broadcastRiskUpdate(userKey, userRiskProfiles.get(userKey));
                return createBlockedResponse('Request Blocked', `High risk score: ${riskResult.score}`);
            }
        }
        
        // ------------------------------------------------------------------
        // 6. AbuseIPDB - Check IP reputation
        // ------------------------------------------------------------------
        if (isProtectionEnabled('abuse-ipdb')) {
            const ipResult = await checkIP(ip);
            if (ipResult.isAbusive) {
                logSecurityEvent('abuse-ipdb-blocked', { ip });
                return createBlockedResponse('IP Blocked', 'Poor IP reputation');
            }
        }
        
        // ------------------------------------------------------------------
        // 7. Safe Browsing - Check URLs in request
        // ------------------------------------------------------------------
        if (isProtectionEnabled('safe-browsing')) {
            const url = new URL(request.url);
            const urlParam = url.searchParams.get('url');
            if (urlParam) {
                const sbResult = await checkUrl(urlParam);
                if (sbResult.threat) {
                    logSecurityEvent('safe-browsing-blocked', { url: urlParam, reason: sbResult.reason });
                    return createBlockedResponse('Malicious URL Detected', sbResult.reason);
                }
            }
        }
        
        // ------------------------------------------------------------------
        // 7.5. FILE CONTENT SCANNING - Scan HTML/JS files for malicious content
        // ------------------------------------------------------------------
        // Scan static files (.html, .js, .json) when accessed
        const fileUrl = new URL(request.url);
        const pathname = fileUrl.pathname;
        const isSuspiciousFile = /\.(html|js|json)$/.test(pathname) && 
                               (pathname.startsWith('/public/') || pathname.startsWith('/js/'));
        
        if (isSuspiciousFile && request.method === 'GET' && isProtectionEnabled('dom-purify')) {
            try {
                // Clone the request to peek at response
                const preCheckResponse = await fetch(request.clone());
                
                if (preCheckResponse.status === 200 && isSuspiciousFile) {
                    const contentType = preCheckResponse.headers.get('content-type');
                    
                    // Scan HTML and JavaScript files
                    if (contentType && (contentType.includes('text/html') || contentType.includes('javascript'))) {
                        const fileContent = await preCheckResponse.clone().text();
                        
                        // Check for malicious patterns
                        const threatCheck = detectMaliciousPatterns(fileContent);
                        if (threatCheck.threat) {
                            logSecurityEvent('malicious-file-blocked', { 
                                file: pathname,
                                threats: threatCheck.threats,
                                patterns: threatCheck.patterns
                            });
                            
                            // Block access to malicious file
                            return createBlockedResponse(
                                'Malicious File Blocked', 
                                `File contains malicious patterns: ${threatCheck.patterns.join(', ')}`
                            );
                        }
                    }
                }
                
                // File is safe, return original response
                response = preCheckResponse;
            } catch (e) {
                // If scan fails, continue with original fetch
                logSecurityEvent('file-scan-error', { file: pathname, error: e.message });
            }
        }
        
        // Record request in window (for anomaly detection)
        if (sessionId) {
            recordRequest(sessionId, path, false);
            
            // Check for anomalies
            const anomalyCheck = checkAnomalies(sessionId);
            if (anomalyCheck.isAnomaly) {
                logSecurityEvent('request-anomaly', { sessionId, reasons: anomalyCheck.reasons });
                riskScore += 15;
            }
        }
        
        // ------------------------------------------------------------------
        // 8. Anti-Fingerprint - Add protection headers
        // ------------------------------------------------------------------
        // (Applied to response, not request)
        
        // ------------------------------------------------------------------
        // 9. Tracking Prevention - Strip tracking params
        // ------------------------------------------------------------------
        // (Applied to outgoing response URLs if needed)
        
        // ------------------------------------------------------------------
        // 10. Tamper Detection - Verify SW integrity
        // ------------------------------------------------------------------
        if (isProtectionEnabled('tamper-detect')) {
            const integrityResult = await verifyIntegrity();
            if (integrityResult.errors.length > 0) {
                logSecurityEvent('integrity-error', { errors: integrityResult.errors });
            }
        }
        
        // Make the actual request
        let response;
        try {
            response = await fetch(request);
        } catch (error) {
            // Network error - try again or return error
            logSecurityEvent('fetch-error', { error: error.message, url: request.url });
            return new Response('Network error', { 
                status: 502,
                statusText: 'Bad Gateway'
            });
        }
        
        // Clone response to add headers
        const responseHeaders = new Headers(response.headers);
        
        // Add anti-fingerprint headers
        if (isProtectionEnabled('anti-fingerprint')) {
            const fpHeaders = getProtectionHeaders();
            for (const [key, value] of Object.entries(fpHeaders)) {
                responseHeaders.set(key, value);
            }
        }
        
        // Add processing time header
        const processingTime = Date.now() - startTime;
        responseHeaders.set('X-Sentinel-Processing-Time', `${processingTime}ms`);
        responseHeaders.set('X-Sentinel-Risk-Score', String(riskScore));
        responseHeaders.set('X-Sentinel-Version', SW_VERSION);
        
        // Return modified response
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders
        });
        
    } catch (error) {
        // Error in pipeline - log and allow request through
        logSecurityEvent('pipeline-error', { 
            error: error.message,
            stack: error.stack,
            path 
        });
        
        // Still try to fetch the request
        try {
            return await fetch(request);
        } catch {
            return new Response('Service error', { status: 500 });
        }
    }
}

/**
 * Parse cookies from header
 * @param {string} cookieHeader - Cookie header string
 * @returns {Object} Parsed cookies
 */
function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;
    
    cookieHeader.split(';').forEach(cookie => {
        const [name, ...rest] = cookie.split('=');
        if (name) {
            cookies[name.trim()] = rest.join('=').trim();
        }
    });
    
    return cookies;
}

/**
 * Create blocked response
 * @param {string} error - Error type
 * @param {string} reason - Reason message
 * @returns {Response} 403 response
 */
function createBlockedResponse(error, reason) {
    return new Response(JSON.stringify({ error, reason }), {
        status: 403,
        statusText: 'Forbidden',
        headers: {
            'Content-Type': 'application/json',
            'X-Sentinel-Blocked': 'true',
            'X-Sentinel-Risk-Score': '100'
        }
    });
}

// =============================================================================
// MESSAGE HANDLER (Communication from main thread)
// =============================================================================

self.addEventListener('message', (event) => {
    const { type, data } = event.data || event;
    
    switch (type) {
        case 'set-protection':
            if (data && data.id !== undefined && data.enabled !== undefined) {
                setProtectionState(data.id, data.enabled);
            }
            break;
            
        case 'get-state':
            // Return current state
            if (event.ports && event.ports[0]) {
                event.ports[0].postMessage({
                    type: 'state',
                    states: Object.fromEntries(protectionStates),
                    version: SW_VERSION
                });
            }
            break;
            
        case 'log-event':
            logSecurityEvent(data.event, data.data);
            break;
            
        case 'sync-state':
            // Sync state from main thread
            if (data && data.states) {
                for (const [id, enabled] of Object.entries(data.states)) {
                    protectionStates.set(id, enabled);
                }
            }
            break;
    }
});

console.log(`[${SW_NAME}] Loaded v${SW_VERSION}`);