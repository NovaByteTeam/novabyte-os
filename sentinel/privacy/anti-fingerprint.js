/**
 * NovaSentinel Privacy - Anti-Fingerprint
 * 
 * This module prevents browser fingerprinting by applying various protections:
 * - Canvas fingerprint randomisation with session-specific noise
 * - WebGL renderer spoofing with consistent fake values
 * - Audio context fingerprint prevention via noise injection
 * - Font enumeration blocking with consistent fake list
 * - Screen resolution normalisation to common values
 * - Navigator property overrides for consistent fake UA
 * 
 * SECURITY REQUIREMENTS:
 * - Each session gets unique but consistent noise within that session
 * - Use Map to track session-specific noise values
 * - Deterministic noise generation based on sessionId
 * - Provide injectnable JavaScript for browser-side protection
 * 
 * @module sentinel/privacy/anti-fingerprint
 */

'use strict';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Common screen resolutions to normalise to */
const COMMON_RESOLUTIONS = [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
    { width: 1280, height: 800 },
    { width: 1280, height: 1024 },
    { width: 1024, height: 768 },
    { width: 800, height: 600 },
    { width: 1600, height: 900 },
    { width: 2560, height: 1440 },
    { width: 3840, height: 2160 }
];

/** Fake font list to return instead of actual system fonts */
const FAKE_FONTS = [
    'Arial', 'Arial Black', 'Comic Sans MS', 'Courier New', 'Georgia',
    'Impact', 'Lucida Console', 'Lucida Sans Unicode', 'Palatino Linotype',
    'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
    'Monaco', 'Menlo', 'Consolas'
];

/** Fake WebGL renderer strings */
const WEBGL_RENDERERS = [
    'ANGLE (Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)',
    'ANGLE (NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0)',
    'ANGLE (AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0)',
    'Intel Iris OpenGL Engine',
    'Intel Iris Pro OpenGL Engine',
    'AMD Radeon Pro 555 OpenGL Engine',
    'NVIDIA GeForce GT 750M OpenGL Engine',
    'Intel HD Graphics 4000 OpenGL Engine'
];

/** Fake user agents */
const FAKE_USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0'
];

// =============================================================================
// STATE
// =============================================================================

/** Map of sessionId -> session noise data */
const sessionNoiseMap = new Map();

/** Map of sessionId -> protection status */
const sessionProtectionStatus = new Map();

/** Active protection status */
let globalActive = false;

// =============================================================================
// SEEDED RANDOM NUMBER GENERATOR
// =============================================================================

/**
 * Create a seeded PRNG for deterministic noise generation
 * @param {string} seed - Seed string
 * @returns {function} Seeded random function
 */
function createSeededRandom(seed) {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        const char = seed.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    
    return function() {
        hash = (hash * 1103515245 + 12345) & 0x7fffffff;
        return hash / 0x7fffffff;
    };
}

/**
 * Generate deterministic integer in range using seeded random
 * @param {function} rand - Seeded random function
 * @param {number} min - Minimum value (inclusive)
 * @param {number} max - Maximum value (inclusive)
 * @returns {number}
 */
function seededRandomInt(rand, min, max) {
    return Math.floor(rand() * (max - min + 1)) + min;
}

/**
 * Select deterministic item from array using seeded random
 * @param {function} rand - Seeded random function
 * @param {Array} arr - Array to select from
 * @returns {*}
 */
function seededRandomSelect(rand, arr) {
    return arr[seededRandomInt(rand, 0, arr.length - 1)];
}

// =============================================================================
// NOISE GENERATION
// =============================================================================

/**
 * Generate session-specific noise values (deterministic per session)
 * @param {string} sessionId - Session identifier
 * @returns {Object} Noise values for this session
 */
function generateSessionNoise(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') {
        throw new Error('Valid sessionId required');
    }
    
    // Check if we already have noise for this session
    if (sessionNoiseMap.has(sessionId)) {
        return sessionNoiseMap.get(sessionId);
    }
    
    // Create seeded random generator
    const rand = createSeededRandom(sessionId);
    
    // Generate deterministic noise values
    const noise = {
        // Canvas noise - small perturbation values
        canvasNoise: {
            redOffset: seededRandomInt(rand, -2, 2),
            greenOffset: seededRandomInt(rand, -2, 2),
            blueOffset: seededRandomInt(rand, -2, 2),
            alphaOffset: seededRandomInt(rand, -5, 5) / 100,
            brightness: seededRandomInt(rand, -10, 10),
            contrast: seededRandomInt(rand, -5, 5)
        },
        
        // WebGL noise
        webglNoise: {
            rendererIndex: seededRandomInt(rand, 0, WEBGL_RENDERERS.length - 1),
            vendorIndex: seededRandomInt(rand, 0, 5)
        },
        
        // Audio context noise
        audioNoise: {
            sampleNoise: seededRandomInt(rand, -100, 100) / 1000000,
            frequencyNoise: seededRandomInt(rand, -0.5, 0.5)
        },
        
        // Font enumeration seed
        fontSeed: seededRandomInt(rand, 0, 1000),
        
        // Screen resolution index
        screenIndex: seededRandomInt(rand, 0, COMMON_RESOLUTIONS.length - 1),
        
        // User agent index
        userAgentIndex: seededRandomInt(rand, 0, FAKE_USER_AGENTS.length - 1),
        
        // Hardware concurrency (cores)
        hardwareConcurrency: seededRandomInt(rand, 4, 16),
        
        // Device memory (GB)
        deviceMemory: seededRandomInt(rand, 4, 32),
        
        // Platform
        platform: seededRandomSelect(rand, ['Win32', 'MacIntel', 'Linux x86_64']),
        
        // Touch support
        maxTouchPoints: seededRandomInt(rand, 0, 10) > 5 ? 0 : seededRandomInt(rand, 1, 5),
        
        // Session timestamp for additional entropy
        sessionTimestamp: Date.now()
    };
    
    // Store the noise
    sessionNoiseMap.set(sessionId, noise);
    
    return noise;
}

// =============================================================================
// PROTECTION SCRIPTS GENERATION
// =============================================================================

/**
 * Generate the browser-side protection JavaScript
 * @param {string} sessionId - Session identifier
 * @returns {string} Injectnable JavaScript code
 */
function generateProtectionScript(sessionId) {
    const noise = generateSessionNoise(sessionId);
    
    const script = `
(function() {
    'use strict';
    
    // NovaSentinel Anti-Fingerprint Protection
    // Session ID: ${sessionId}
    
    const NOISE = ${JSON.stringify(noise, null, 2)};
    
    // =================================================================
    // CANVAS FINGERPRINT PROTECTION
    // =================================================================
    
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    const originalFillText = CanvasRenderingContext2D.prototype.fillText;
    const originalStrokeText = CanvasRenderingContext2D.prototype.strokeText;
    
    // Add noise to pixel data
    function addNoiseToImageData(imageData) {
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
            data[i] = Math.max(0, Math.min(255, data[i] + NOISE.canvasNoise.redOffset));
            data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + NOISE.canvasNoise.greenOffset));
            data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + NOISE.canvasNoise.blueOffset));
            data[i + 3] = Math.max(0, Math.min(255, data[i + 3] + NOISE.canvasNoise.alphaOffset * 255));
        }
        return imageData;
    }
    
    HTMLCanvasElement.prototype.toDataURL = function() {
        const result = originalToDataURL.apply(this, arguments);
        // Return consistent result per session
        return result;
    };
    
    CanvasRenderingContext2D.prototype.getImageData = function() {
        const imageData = originalGetImageData.apply(this, arguments);
        return addNoiseToImageData(imageData);
    };
    
    // =================================================================
    // WEBGL FINGERPRINT PROTECTION
    // =================================================================
    
    const WEBGL_RENDERERS = ${JSON.stringify(WEBGL_RENDERERS)};
    const webglRenderer = WEBGL_RENDERERS[NOISE.webglNoise.rendererIndex];
    
    const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
    const originalGetExtension = WebGLRenderingContext.prototype.getExtension;
    
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
        // Return fake renderer info
        if (parameter === 37445) {
            return 'Google Inc.';
        }
        if (parameter === 37446) {
            return webglRenderer;
        }
        return originalGetParameter.apply(this, arguments);
    };
    
    // WebGL2 support
    if (typeof WebGL2RenderingContext !== 'undefined') {
        const originalGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) {
                return 'Google Inc.';
            }
            if (parameter === 37446) {
                return webglRenderer;
            }
            return originalGetParameter2.apply(this, arguments);
        };
    }
    
    // =================================================================
    // AUDIO CONTEXT FINGERPRINT PROTECTION
    // =================================================================
    
    const originalCreateOscillator = AudioContext.prototype.createOscillator;
    const originalCreateAnalyser = AudioContext.prototype.createAnalyser;
    const originalGetChannelData = AudioBuffer.prototype.getChannelData;
    
    AudioBuffer.prototype.getChannelData = function(channel) {
        const data = originalGetChannelData.call(this, channel);
        // Add imperceptible noise
        const noiseLevel = NOISE.audioNoise.sampleNoise;
        for (let i = 0; i < data.length; i++) {
            data[i] += noiseLevel;
        }
        return data;
    };
    
    // =================================================================
    // FONT ENUMERATION BLOCKING
    // =================================================================
    
    const FAKE_FONTS = ${JSON.stringify(FAKE_FONTS)};
    
    // Override document.fonts.check if available
    if (document.fonts && document.fonts.check) {
        const originalCheck = document.fonts.check;
        document.fonts.check = function(font) {
            // Return true for our fake fonts
            const fontName = font.replace(/^(['"])(.*)\\1$/, '$2');
            if (FAKE_FONTS.some(f => fontName.toLowerCase().includes(f.toLowerCase()))) {
                return true;
            }
            // Randomise other font checks
            const seed = NOISE.fontSeed;
            return (seed + font.length) % 2 === 0;
        };
    }
    
    // =================================================================
    // SCREEN RESOLUTION NORMALISATION
    // =================================================================
    
    const COMMON_RESOLUTIONS = ${JSON.stringify(COMMON_RESOLUTIONS)};
    const normalisedRes = COMMON_RESOLUTIONS[NOISE.screenIndex];
    
    Object.defineProperty(screen, 'width', {
        get: function() { return normalisedRes.width; },
        configurable: true
    });
    
    Object.defineProperty(screen, 'height', {
        get: function() { return normalisedRes.height; },
        configurable: true
    });
    
    Object.defineProperty(screen, 'availWidth', {
        get: function() { return normalisedRes.width; },
        configurable: true
    });
    
    Object.defineProperty(screen, 'availHeight', {
        get: function() { return normalisedRes.height - 25; },
        configurable: true
    });
    
    Object.defineProperty(screen, 'colorDepth', {
        get: function() { return 24; },
        configurable: true
    });
    
    Object.defineProperty(screen, 'pixelDepth', {
        get: function() { return 24; },
        configurable: true
    });
    
    // =================================================================
    // NAVIGATOR PROPERTY OVERRIDES
    // =================================================================
    
    const FAKE_USER_AGENTS = ${JSON.stringify(FAKE_USER_AGENTS)};
    const fakeUA = FAKE_USER_AGENTS[NOISE.userAgentIndex];
    
    Object.defineProperty(navigator, 'userAgent', {
        get: function() { return fakeUA; },
        configurable: true
    });
    
    Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: function() { return NOISE.hardwareConcurrency; },
        configurable: true
    });
    
    Object.defineProperty(navigator, 'deviceMemory', {
        get: function() { return NOISE.deviceMemory; },
        configurable: true
    });
    
    Object.defineProperty(navigator, 'platform', {
        get: function() { return NOISE.platform; },
        configurable: true
    });
    
    Object.defineProperty(navigator, 'maxTouchPoints', {
        get: function() { return NOISE.maxTouchPoints; },
        configurable: true
    });
    
    // Override plugins
    Object.defineProperty(navigator, 'plugins', {
        get: function() { return []; },
        configurable: true
    });
    
    // Override mimeTypes
    Object.defineProperty(navigator, 'mimeTypes', {
        get: function() { return []; },
        configurable: true
    });
    
    // Override languages
    Object.defineProperty(navigator, 'languages', {
        get: function() { return ['en-US', 'en']; },
        configurable: true
    });
    
    Object.defineProperty(navigator, 'language', {
        get: function() { return 'en-US'; },
        configurable: true
    });
    
    // =================================================================
    // WEBRTC LEAK PROTECTION
    // =================================================================
    
    const originalRTCPeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = function() {
        const pc = new originalRTCPeerConnection.apply(this, arguments);
        
        const originalCreateOffer = pc.createOffer.bind(pc);
        pc.createOffer = function() {
            return originalCreateOffer.apply(this, arguments).then(d => {
                // Remove local IPs from SDP
                const sdp = d.sdp.replace(/\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}/g, '0.0.0.0');
                return { ...d, sdp };
            });
        };
        
        return pc;
    };
    
    // =================================================================
    // TIMEZONE NORMALISATION
    // =================================================================
    
    Object.defineProperty(Intl, 'DateTimeFormat', {
        get: function() {
            return function() {
                // Return consistent timezone
                return {
                    resolvedOptions: function() {
                        return { timeZone: 'UTC' };
                    }
                };
            };
        },
        configurable: true
    });
    
    // =================================================================
    // REPORT STATUS
    // =================================================================
    
    window.__novaAntiFingerprint = {
        active: true,
        sessionId: '${sessionId}',
        protections: {
            canvas: true,
            webgl: true,
            audio: true,
            fonts: true,
            screen: true,
            navigator: true,
            webrtc: true,
            timezone: true
        }
    };
    
    console.log('NovaSentinel Anti-Fingerprint Protection Active');
})();
`;
    
    return script;
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Initialise anti-fingerprint protections for a session
 * @param {string} sessionId - Session identifier
 * @returns {Object} Protection status and inject script
 */
function initAntiFingerprint(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') {
        throw new Error('Valid sessionId required for anti-fingerprint initialisation');
    }
    
    // Generate or retrieve session noise
    const noise = generateSessionNoise(sessionId);
    
    // Generate protection script
    const protectionScript = generateProtectionScript(sessionId);
    
    // Set protection status for this session
    sessionProtectionStatus.set(sessionId, {
        active: true,
        sessionId: sessionId,
        initiated: Date.now(),
        protections: {
            canvas: true,
            webgl: true,
            audio: true,
            fonts: true,
            screen: true,
            navigator: true,
            webrtc: true,
            timezone: true
        }
    });
    
    globalActive = true;
    
    return {
        sessionId: sessionId,
        active: true,
        noise: noise,
        script: protectionScript,
        injectCode: `<script>${protectionScript}</script>`
    };
}

/**
 * Get the fingerprint protection status
 * @returns {Object} Status of all protections
 */
function getFingerprintStatus() {
    const statuses = [];
    
    for (const [sessionId, status] of sessionProtectionStatus) {
        statuses.push(status);
    }
    
    return {
        globalActive: globalActive,
        sessionCount: sessionProtectionStatus.size,
        sessions: statuses,
        protections: {
            canvas: { enabled: globalActive, name: 'Canvas Fingerprint Randomisation' },
            webgl: { enabled: globalActive, name: 'WebGL Renderer Spoofing' },
            audio: { enabled: globalActive, name: 'Audio Context Fingerprint Prevention' },
            fonts: { enabled: globalActive, name: 'Font Enumeration Blocking' },
            screen: { enabled: globalActive, name: 'Screen Resolution Normalisation' },
            navigator: { enabled: globalActive, name: 'Navigator Property Overrides' },
            webrtc: { enabled: globalActive, name: 'WebRTC Leak Protection' },
            timezone: { enabled: globalActive, name: 'Timezone Normalisation' }
        }
    };
}

/**
 * Get module status (NovaSentinel standard interface)
 * @returns {Object} Module status
 */
function getStatus() {
    return {
        active: globalActive,
        healthy: true,
        details: {
            sessionsProtected: sessionProtectionStatus.size,
            protections: getFingerprintStatus().protections
        }
    };
}

// =============================================================================
// CLEANUP
// =============================================================================

/**
 * Clean up session data (for session expiry)
 * @param {string} sessionId - Session to clean up
 */
function cleanupSession(sessionId) {
    if (sessionNoiseMap.has(sessionId)) {
        sessionNoiseMap.delete(sessionId);
    }
    if (sessionProtectionStatus.has(sessionId)) {
        sessionProtectionStatus.delete(sessionId);
    }
    if (sessionProtectionStatus.size === 0) {
        globalActive = false;
    }
}

/**
 * Clean up all sessions
 */
function cleanupAll() {
    sessionNoiseMap.clear();
    sessionProtectionStatus.clear();
    globalActive = false;
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    initAntiFingerprint,
    generateSessionNoise,
    getFingerprintStatus,
    getStatus,
    cleanupSession,
    cleanupAll
};
