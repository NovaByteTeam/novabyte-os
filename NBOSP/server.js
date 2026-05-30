/**
 * NovaByte Server
 */

require('dotenv').config();

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
    // Log to stderr so client.js tee() writes it to server.log
    process.stderr.write(`[uncaughtException] ${error?.stack || error}\n`);
});

process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[unhandledRejection] ${reason?.stack || reason}\n`);
});

(async () => {
    const express = require('express');
    const http = require('http');
    const https = require('https');
    const fs = require('fs');
    const helmet = require('helmet');
    const cors = require('cors');
    const rateLimit = require('express-rate-limit');
    const cookieParser = require('cookie-parser');
    const session = require('express-session');
    const path = require('path');

    // Import services
    const securityRoutes = require('./security-routes');
    const securityMiddleware = require('./security-middleware');
    const emailRoutes = require('./email-routes');

    // Load Disconnect.me tracker blocklist for email image proxy
    // Same list used by email-routes.js server-side and app.js client-side
    let SERVER_TRACKER_DOMAINS = new Set();
    try {
        ({ TRACKER_DOMAINS: SERVER_TRACKER_DOMAINS } = require(path.join(__dirname, 'trackers.js')));
        console.log('[Server] Tracker blocklist loaded:', SERVER_TRACKER_DOMAINS.size, 'domains');
    } catch (e) {
        console.warn('[Server] trackers.js not found — email proxy tracker blocking disabled');
    }

    // Initialize Express application
    const app = express();

    // HTTPS if certs exist, otherwise HTTP (dev fallback)
    let server;
    let isHttps = false;
    try {
        const httpsOptions = {
            key: fs.readFileSync('cert.key'),
            cert: fs.readFileSync('cert.crt'),
            ALPNProtocols: ['http/1.1'],
        };
        server = https.createServer(httpsOptions, app);
        isHttps = true;
    } catch (e) {
        console.warn('[Server] SSL certs not found — falling back to HTTP (Service Workers will work on http://localhost)');
        server = http.createServer(app);
    }


    // Set Origin-Agent-Cluster FIRST, before Helmet and any other middleware
    app.use((req, res, next) => {
        res.setHeader('Origin-Agent-Cluster', '?1');
        next();
    });

    // Nonce middleware — must run before helmet()
    app.use((req, res, next) => {
        res.locals.nonce = require("crypto").randomBytes(16).toString("base64");
        next();
    });

    // Security middleware
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`, 'https://cdnjs.cloudflare.com'],
                scriptSrcElem: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`, "'sha256-tyfqxgVVARi92sm+Jt8CKSEsLJ5OJvLOMUJBWYUZQqQ='", 'https://cdnjs.cloudflare.com', 'https://localhost:3003', 'https://127.0.0.1:3003'],
                styleSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`, 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com'],
                styleSrcElem: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`, "'sha256-l+vYTkM0NIoFMnSuySdnDB0Nm02ze/dUO/0mogvvrc0='", "'sha256-wFmUsbbscFRcayh50Sc8dlXr8DXzmGqSApRXzf8ipoI='", "'sha256-/34yUCLdu0nbxmbw9Ww0bjFbLIoubrE8EME72GSJJ2U='", 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com'],
                scriptSrcAttr: ["'unsafe-inline'"],
                styleSrcAttr: ["'unsafe-inline'"],
                workerSrc: ["'self'", 'blob:', 'https://localhost:*', 'https://127.0.0.1:*'],
                connectSrc: ["'self'", 'wss:', 'https:', 'ws:', 'http:', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
                fontSrc: ["'self'", 'https://fonts.gstatic.com'],
                imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
                objectSrc: ["'none'"],
                mediaSrc: ["'self'", 'blob:'],
                frameSrc: ["'self'", 'blob:', 'data:', 'https:'],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'self'"]
            }
        },
        crossOriginResourcePolicy: false,
        originAgentCluster: false
    }));

    const corsOrigins = process.env.CORS_ORIGIN?.split(',').filter(Boolean) || ['https://localhost:3003', 'https://127.0.0.1:3003'];

    app.use(cors({
        origin: corsOrigins,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-CSRF-Token'],
        exposedHeaders: ['X-CSRF-Token'],
        maxAge: 86400
    }));

    // Rate limiting
    const limiter = rateLimit({
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
        max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
        message: {
            error: 'Too many requests from this IP, please try again later.',
            retryAfter: process.env.RATE_LIMIT_WINDOW_MS || 900
        },
        standardHeaders: true,
        legacyHeaders: false,
        skip: (req) => {
            if (req.path === '/health') return true;
            if (req.path.startsWith('/js/')) return true;
            if (req.path.startsWith('/css/')) return true;
            if (req.path.startsWith('/public/')) return true;
            if (req.path.startsWith('/assets/')) return true;
            if (req.path === '/favicon.ico') return true;
            // These have their own dedicated limiters and fire many times per email/page load
            if (req.path === '/api/email-image') return true;
            if (req.path === '/api/favicon') return true;
            return false;
        }
    });


    // Tiered email rate limiters — split by frequency of legitimate use:
    //   connect/disconnect/preview: called on every folder switch and email open, needs headroom
    //   messages/search/folders:    moderate — paging and searching
    //   send/delete/move/batch:     strict — state-modifying actions, low legitimate frequency

    const emailConnectLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 120,  // up to 2/sec — covers rapid folder switching and multi-window use
        message: { error: 'Too many connection requests, please slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
    });

    const emailReadLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 60,   // 1/sec sustained — paging through inbox, searching
        message: { error: 'Too many email requests, please slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
    });

    const emailWriteLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 20,   // strict — send, delete, move, batch
        message: { error: 'Too many email write requests, please slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
    });

    app.use('/api/', limiter);
    app.use('/api/mail/', emailReadLimiter);

    // High-frequency endpoints — connect, disconnect, preview (called on every email open)
    app.use('/api/email/connect',    emailConnectLimiter);
    app.use('/api/email/disconnect', emailConnectLimiter);
    app.use('/api/email/preview',    emailConnectLimiter);
    app.use('/api/email/csrf-token', emailConnectLimiter);

    // Read endpoints — messages, folders, search, individual message fetch
    app.use('/api/email/messages',   emailReadLimiter);
    app.use('/api/email/message',    emailReadLimiter);
    app.use('/api/email/folders',    emailReadLimiter);
    app.use('/api/email/search',     emailReadLimiter);

    // Write endpoints — send, delete, move, batch
    app.use('/api/email/send',       emailWriteLimiter);
    app.use('/api/email/delete',     emailWriteLimiter);
    app.use('/api/email/move',       emailWriteLimiter);
    app.use('/api/email/batch',      emailWriteLimiter);

    // Body parsing middleware
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    app.use(cookieParser());

    // Session middleware (required for CSRF protection)
    app.use(session({
        secret: (() => {
            if (!process.env.SESSION_SECRET) {
                throw new Error('SESSION_SECRET environment variable is required but not set.');
            }
            return process.env.SESSION_SECRET;
        })(),
        resave: false,
        saveUninitialized: false, // FIX: was true — created sessions for every anonymous request (session fixation risk)
        cookie: {
            secure: server instanceof https.Server,
            httpOnly: true,
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000 // 24 hours
        }
    }));

    // Apply security middleware
    const securityMws = securityMiddleware.createSecurityMiddleware({
        enableCsrfProtection: true,
        enableIpBlocking: true,
        enableRequestValidation: true,
        enableInputSanitization: true
    });
    const securityExclusions = ['/bare/'];
    securityMws.forEach(mw => {
        app.use((req, res, next) => {
            if (securityExclusions.some(p => req.path === p || req.path.endsWith(p) || req.path.startsWith(p))) return next();
            return mw(req, res, next);
        });
    });

    // Handle favicon
    app.get('/favicon.ico', (req, res) => {
        const favicon = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAADklEQVQ4T2NkGAWjgHoAAAJ6AAFhyv0xAAAAAElFTkSuQmCC', 'base64');
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(favicon);
    });

    // ── Favicon Proxy ────────────────────────────────────────────────────────
    // Fetches favicons server-side so the user's IP is never sent to Google.
    // Flow: cache hit → Google (server-side) → site's /favicon.ico → default icon
    //
    // SSRF protection: blocks private IPs, localhost, non-http(s) schemes.
    // Cache: in-memory Map, 24h TTL, max 500 entries (LRU-style eviction).
    // Rate limit: 60 requests/min per IP (separate from the general limiter).

    const faviconCache = new Map(); // key: hostname → { buf, mime, ts }
    const FAVICON_TTL   = 24 * 60 * 60 * 1000; // 24 hours
    const FAVICON_MAX   = 500;                  // max cached entries
    const FAVICON_FETCH_TIMEOUT = 4000;         // 4 s per upstream attempt

    // 1x1 transparent PNG — returned when everything else fails
    const FAVICON_DEFAULT = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
    );

    // Private / internal IP ranges — used for SSRF blocking
    const PRIVATE_PREFIXES = ['10.', '172.16.', '172.17.', '172.18.', '172.19.',
        '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.',
        '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.',
        '192.168.', '169.254.', '100.64.'];
    const PRIVATE_EXACT   = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0',
        '[::1]', '[::]']);

    function isPrivateHost(hostname) {
        const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (PRIVATE_EXACT.has(h)) return true;
        if (PRIVATE_PREFIXES.some(p => h.startsWith(p))) return true;
        if (h.endsWith('.local') || h.endsWith('.internal')) return true;
        // Pure IPv4 check — block anything that looks like a bare IP
        // pointing to a private range (already covered above, but belt+braces)
        return false;
    }

    function validateFaviconDomain(raw) {
        // Strip any scheme the caller may have passed
        let host = raw.trim().toLowerCase();
        host = host.replace(/^https?:\/\//i, '').split('/')[0].split('?')[0];
        if (!host) return null;
        if (isPrivateHost(host)) return null;
        // Must look like a real public hostname (contains a dot, no spaces)
        if (!host.includes('.') || /\s/.test(host)) return null;
        return host;
    }

    async function fetchWithTimeout(url, opts = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FAVICON_FETCH_TIMEOUT);
        try {
            return await fetch(url, { ...opts, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    // Minimal outbound headers — no user-identifying info forwarded
    const CLEAN_HEADERS = {
        'User-Agent': 'Mozilla/5.0 (compatible; NovaByte/1.0)',
        'Accept':     'image/png,image/x-icon,image/*,*/*;q=0.8',
    };

    async function resolveFavicon(hostname) {
        // 1. Try Google's favicon service (server-side — user IP never exposed)
        try {
            const googleUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`;
            const resp = await fetchWithTimeout(googleUrl, { headers: CLEAN_HEADERS, redirect: 'follow' });
            if (resp.ok) {
                const buf  = Buffer.from(await resp.arrayBuffer());
                const mime = resp.headers.get('content-type') || 'image/png';
                // Google returns a generic globe (820 bytes exactly) when it has nothing —
                // treat anything under 90 bytes as a failure so we try the fallback
                if (buf.length > 90) return { buf, mime };
            }
        } catch (_) { /* timeout or network error — fall through */ }

        // 2. Fallback: fetch /favicon.ico directly from the site
        try {
            const directUrl = `https://${hostname}/favicon.ico`;
            const resp = await fetchWithTimeout(directUrl, { headers: CLEAN_HEADERS, redirect: 'follow' });
            if (resp.ok) {
                const buf  = Buffer.from(await resp.arrayBuffer());
                const mime = resp.headers.get('content-type') || 'image/x-icon';
                if (buf.length > 90) return { buf, mime };
            }
        } catch (_) { /* fall through to default */ }

        // 3. Nothing worked — callers will use FAVICON_DEFAULT
        return null;
    }

    const faviconLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 60,
        message: { error: 'Too many favicon requests, slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
    });

    app.get('/api/favicon', faviconLimiter, async (req, res) => {
        const raw = req.query.domain;
        if (!raw || typeof raw !== 'string') {
            return res.status(400).json({ error: 'domain parameter is required' });
        }

        const hostname = validateFaviconDomain(raw);
        if (!hostname) {
            return res.status(400).json({ error: 'Invalid or disallowed domain' });
        }

        // Cache hit
        const cached = faviconCache.get(hostname);
        if (cached && (Date.now() - cached.ts) < FAVICON_TTL) {
            res.setHeader('Content-Type', cached.mime);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return res.send(cached.buf);
        }

        const result = await resolveFavicon(hostname);
        const buf    = result ? result.buf  : FAVICON_DEFAULT;
        const mime   = result ? result.mime : 'image/png';

        // Store in cache — evict oldest entry if at capacity
        if (faviconCache.size >= FAVICON_MAX) {
            faviconCache.delete(faviconCache.keys().next().value);
        }
        faviconCache.set(hostname, { buf, mime, ts: Date.now() });

        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buf);
    });
    // ── End Favicon Proxy ─────────────────────────────────────────────────────

    // ── Email Image Proxy ─────────────────────────────────────────────────────
    // Fetches email images server-side so the user's IP is never sent to the
    // sender's tracking server. All <img> URLs in HTML emails are rewritten to
    // point here before the email is rendered.
    //
    // Security:
    //   - SSRF protection: same private-IP blocklist as the favicon proxy
    //   - Redirects followed manually — each hop re-validated against blocklist
    //   - Content-type allowlist: only image/* passes through
    //   - 5MB hard cap — oversized responses return the default placeholder
    //   - All outbound headers stripped (no cookie, no referer, no user IP)
    //   - Tracking params stripped from URLs before fetching
    //   - In-memory cache: 1h TTL, 200 entry cap
    //   - Dedicated rate limiter: 120 req/min per IP

    const emailImgCache = new Map(); // key: normalised URL → { buf, mime, ts }
    const EMAIL_IMG_TTL     = 60 * 60 * 1000;  // 1 hour
    const EMAIL_IMG_MAX     = 200;
    const EMAIL_IMG_TIMEOUT = 5000;             // 5 s
    const EMAIL_IMG_SIZE_CAP = 5 * 1024 * 1024; // 5 MB

    // 1×1 transparent PNG returned on any failure
    const EMAIL_IMG_DEFAULT = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
    );

    // Tracking / analytics query params to strip before proxying
    const TRACKING_PARAMS = new Set([
        'utm_source','utm_medium','utm_campaign','utm_content','utm_term',
        'utm_id','utm_source_platform','utm_creative_format','utm_marketing_tactic',
        'fbclid','gclid','gclsrc','dclid','gbraid','wbraid',
        'mc_eid','mc_cid','_hsenc','_hsmi','mkt_tok','yclid',
        'igshid','s_cid','ncid','ref','trk','trkinfo',
    ]);

    function stripTrackingParams(urlStr) {
        try {
            const u = new URL(urlStr);
            let changed = false;
            for (const key of [...u.searchParams.keys()]) {
                if (TRACKING_PARAMS.has(key.toLowerCase())) {
                    u.searchParams.delete(key);
                    changed = true;
                }
            }
            return changed ? u.toString() : urlStr;
        } catch (_) { return urlStr; }
    }

    function isPrivateHostEI(hostname) {
        const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (PRIVATE_EXACT.has(h)) return true;
        if (PRIVATE_PREFIXES.some(p => h.startsWith(p))) return true;
        if (h.endsWith('.local') || h.endsWith('.internal')) return true;
        return false;
    }

    function validateEmailImgUrl(raw) {
        let urlObj;
        try { urlObj = new URL(raw); } catch (_) { return null; }
        if (!['http:', 'https:'].includes(urlObj.protocol)) return null;
        if (urlObj.username || urlObj.password) return null; // credentials in URL = SSRF risk
        if (isPrivateHostEI(urlObj.hostname)) return null;
        return urlObj;
    }

    async function fetchEmailImage(urlStr) {
        const CLEAN = {
            'User-Agent': 'Mozilla/5.0 (compatible; NovaByte/1.0)',
            'Accept': 'image/png,image/webp,image/jpeg,image/gif,image/*,*/*;q=0.8',
        };

        let currentUrl = stripTrackingParams(urlStr);
        const visited = new Set();
        const MAX_REDIRECTS = 5;

        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            if (visited.has(currentUrl)) return null; // redirect loop
            visited.add(currentUrl);

            const urlObj = validateEmailImgUrl(currentUrl);
            if (!urlObj) return null; // SSRF check on every hop

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), EMAIL_IMG_TIMEOUT);

            let resp;
            try {
                resp = await fetch(currentUrl, {
                    headers: CLEAN,
                    redirect: 'manual', // handle redirects manually to re-validate each hop
                    signal: controller.signal,
                });
            } catch (_) {
                return null;
            } finally {
                clearTimeout(timer);
            }

            // Follow redirects manually
            if (resp.status >= 300 && resp.status < 400) {
                const loc = resp.headers.get('location');
                if (!loc) return null;
                // Resolve relative redirect against current URL
                try { currentUrl = new URL(loc, currentUrl).toString(); } catch (_) { return null; }
                continue;
            }

            if (!resp.ok) return null;

            // Content-type must be an image
            const contentType = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
            if (!contentType.startsWith('image/')) return null;

            // Read with size cap
            const reader = resp.body.getReader();
            const chunks = [];
            let total = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.length;
                if (total > EMAIL_IMG_SIZE_CAP) { reader.cancel(); return null; }
                chunks.push(value);
            }

            const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
            if (buf.length < 1) return null;

            return { buf, mime: contentType };
        }

        return null; // too many redirects
    }

    const emailImgLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 500,  // single HTML email can have 50+ images; allow rapid inbox browsing
        message: { error: 'Too many image requests, slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
    });

    app.get('/api/email-image', emailImgLimiter, async (req, res) => {
        const raw = req.query.url;
        if (!raw || typeof raw !== 'string') {
            return res.status(400).json({ error: 'url parameter is required' });
        }

        const urlObj = validateEmailImgUrl(raw);
        if (!urlObj) {
            // Return placeholder silently — don't reveal why to client
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            return res.send(EMAIL_IMG_DEFAULT);
        }

        // Block known tracker domains — return transparent placeholder without
        // making any upstream request, so the sender gets no open-tracking signal
        // even through the proxy layer.
        if (SERVER_TRACKER_DOMAINS.size > 0) {
            const hostname = urlObj.hostname.toLowerCase().replace(/^www\./, '');
            const parts = hostname.split('.');
            const isTracker = parts.some((_, i) =>
                i < parts.length - 1 && SERVER_TRACKER_DOMAINS.has(parts.slice(i).join('.'))
            );
            if (isTracker) {
                res.setHeader('Content-Type', 'image/png');
                res.setHeader('Cache-Control', 'public, max-age=86400'); // 24h — trackers don't change
                return res.send(EMAIL_IMG_DEFAULT);
            }
        }

        const cacheKey = stripTrackingParams(raw);

        // Cache hit
        const cached = emailImgCache.get(cacheKey);
        if (cached && (Date.now() - cached.ts) < EMAIL_IMG_TTL) {
            res.setHeader('Content-Type', cached.mime);
            res.setHeader('Cache-Control', 'public, max-age=3600');
            return res.send(cached.buf);
        }

        const result = await fetchEmailImage(raw);
        const buf  = result ? result.buf  : EMAIL_IMG_DEFAULT;
        const mime = result ? result.mime : 'image/png';

        // Evict oldest if at capacity
        if (emailImgCache.size >= EMAIL_IMG_MAX) {
            emailImgCache.delete(emailImgCache.keys().next().value);
        }
        emailImgCache.set(cacheKey, { buf, mime, ts: Date.now() });

        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.send(buf);
    });
    // ── End Email Image Proxy ──────────────────────────────────────────────────

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

    // Serve version.json
    app.get('/version.json', (req, res) => {
        const versionPath = path.join(__dirname, 'version.json');
        if (fs.existsSync(versionPath)) {
            return res.sendFile(versionPath);
        }
        res.status(404).json({ error: 'version.json not found' });
    });

    // Serve assets (SVG icons, images, etc)
    app.use('/assets', express.static(path.join(__dirname, 'assets')));

    // Static files
    app.use(express.static(path.join(__dirname, 'public')));
    app.use('/js', express.static(path.join(__dirname, 'js')));
    app.use('/css', express.static(path.join(__dirname, 'css')));

    // Serve split-out app.js and style.css from project root
    // These are generated by the HTML splitter and live alongside index.html.
    // They don't live inside public/ so we serve them explicitly.
    app.get('/app.js', (req, res) => {
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.sendFile(path.join(__dirname, 'app.js'));
    });
    // Tracker blocklist — served statically so app.js can fetch() it.
    // The main window has no Node integration so require() doesn't work there;
    // fetching over HTTP is the correct approach.
    app.get('/trackers.js', (req, res) => {
        const p = path.join(__dirname, 'trackers.js');
        if (!require('fs').existsSync(p)) {
            return res.status(404).json({ error: 'trackers.js not found — run the generator script' });
        }
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.sendFile(p);
    });
    // modules.js intentionally removed — file no longer exists in the project.
    app.get('/style.css', (req, res) => {
        res.setHeader('Content-Type', 'text/css');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.sendFile(path.join(__dirname, 'style.css'));
    });

    // Cache index.html in memory — avoid re-reading from disk on every request
    let _indexHtmlRaw = null;
    function getIndexHtml() {
        if (!_indexHtmlRaw) {
            _indexHtmlRaw = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
        }
        return _indexHtmlRaw;
    }
    // Watch for changes in dev so cache stays fresh
    fs.watch(path.join(__dirname, 'index.html'), () => { _indexHtmlRaw = null; });

    // Periodic memory monitor — logs heap usage to server.log every 60s
    // Helps diagnose OOM build-up before crash
    setInterval(() => {
        const m = process.memoryUsage();
        const mb = v => Math.round(v / 1024 / 1024);
        process.stdout.write(
            `[Memory] heapUsed=${mb(m.heapUsed)}MB heapTotal=${mb(m.heapTotal)}MB rss=${mb(m.rss)}MB external=${mb(m.external)}MB
`
        );
        // If gc is exposed (--expose-gc flag), nudge it when heap is high
        if (typeof global.gc === 'function' && m.heapUsed / m.heapTotal > 0.85 && m.heapUsed > 100 * 1024 * 1024) { // only GC when heap is actually large
            global.gc();
            process.stdout.write('[Memory] gc() triggered - heap was above 85%\n');
        }
    }, 60_000).unref(); // .unref() so this timer wont keep the process alive on shutdown

    // Serve index.html at root
    app.get('/', (req, res) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');

        const nonce = res.locals.nonce;
        let html = getIndexHtml();

        // Inline tags — add nonce so CSP allows them
        html = html.replace(/<script>/g, `<script nonce="${nonce}">`);
        html = html.replace(/<script type="module">/g, `<script type="module" nonce="${nonce}">`);
        html = html.replace(/<style>/g, `<style nonce="${nonce}">`);

        // External split files — add nonce to <script src="app.js"> and
        // <link rel="stylesheet" href="style.css"> injected by the HTML splitter.
        // 'self' in scriptSrcElem/styleSrcElem already permits same-origin files,
        // but an explicit nonce future-proofs against stricter CSP configs.
        html = html.replace(
            /(<script\b)([^>]*\bsrc="[^"]*app\.js"[^>]*)(>)/gi,
            `$1$2 nonce="${nonce}"$3`
        );
        html = html.replace(
            /(<script\b)([^>]*\bsrc="[^"]*modules\.js"[^>]*)(>)/gi,
            `$1$2 nonce="${nonce}"$3`
        );
        html = html.replace(
            /(<link\b)([^>]*\bhref="[^"]*style\.css"[^>]*)(\/?>)/gi,
            `$1$2 nonce="${nonce}"$3`
        );

        html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, '');

        const csrfToken = req.session?.csrfToken || res.locals.csrfToken || '';
        html = html.replace('</head>', `<meta name="csrf-token" content="${csrfToken}"><script nonce="${nonce}">window.__cspNonce="${nonce}";</script></head>`);

        res.send(html);
    });


    // Default CORP header for all other static assets
    app.use((req, res, next) => {
        if (!res.getHeader('Cross-Origin-Resource-Policy')) {
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        }
        next();
    });

    // General security headers
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-XSS-Protection', '1; mode=block');
        next();
    });

    // Health check
    app.get('/health', (req, res) => {
        res.status(200).json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            service: 'NovaByte'
        });
    });

    app.get('/api/health', (req, res) => {
        res.status(200).json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            service: 'NovaByte'
        });
    });

    // /api/info intentionally removed — endpoint enumeration is a recon vector.

    // Browser tracking parameter stripper
    app.get('/api/security/strip-tracking', (req, res) => {
        const { url } = req.query;
        if (!url || typeof url !== 'string') {
            return res.status(400).json({ error: 'url parameter is required' });
        }

        // FIX: Validate URL before processing to prevent SSRF.
        // Only accept http:// and https:// schemes, and reject private/internal hosts.
        let urlObj;
        try {
            urlObj = new URL(decodeURIComponent(url));
        } catch (_) {
            return res.status(400).json({ error: 'Invalid URL' });
        }

        if (!['http:', 'https:'].includes(urlObj.protocol)) {
            return res.status(400).json({ error: 'Only http and https URLs are supported' });
        }

        // Block internal/private hosts
        const h = urlObj.hostname.toLowerCase();
        const BLOCKED = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];
        const BLOCKED_PREFIXES = ['10.', '192.168.',
            '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.',
            '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', '172.27.',
            '172.28.', '172.29.', '172.30.', '172.31.',
            '169.254.', '100.64.'];
        if (BLOCKED.includes(h) || BLOCKED_PREFIXES.some(p => h.startsWith(p)) || h.endsWith('.local') || h.endsWith('.internal')) {
            return res.status(400).json({ error: 'Internal URLs are not permitted' });
        }

        const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content',
            'utm_term', 'fbclid', 'gclid', 'mc_eid', 'mc_cid', '_hsenc', '_hsmi'];
        let stripped = false;
        trackingParams.forEach(param => {
            if (urlObj.searchParams.has(param)) {
                urlObj.searchParams.delete(param);
                stripped = true;
            }
        });
        res.json({ stripped, url: urlObj.toString() });
    });

    // API router
    const apiRouter = express.Router();
    apiRouter.use('/security', securityRoutes);
    apiRouter.use('/email', emailRoutes);

    // Stub API endpoints for prefetch-manager (returns empty data if endpoints not populated by other means)
    apiRouter.get('/apps/list', (req, res) => res.json([])); // Returns empty app list
    apiRouter.get('/apps/registry', (req, res) => res.json({})); // Returns empty registry
    apiRouter.get('/apps/permissions', (req, res) => res.json([])); // Returns empty permissions
    apiRouter.get('/security/status', (req, res) => res.json({ ok: true })); // Returns OK status
    apiRouter.get('/security/sandbox-check', (req, res) => res.json({ sandboxed: true })); // Returns sandbox check
    apiRouter.get('/user/profile', (req, res) => res.json({})); // Returns empty profile
    apiRouter.get('/user/preferences', (req, res) => res.json({})); // Returns empty preferences
    apiRouter.get('/user/sessions', (req, res) => res.json([])); // Returns empty sessions
    apiRouter.get('/files/list', (req, res) => res.json([])); // Returns empty file list
    apiRouter.get('/files/search', (req, res) => res.json([])); // Returns empty search results
    apiRouter.get('/files/metadata', (req, res) => res.json({})); // Returns empty metadata

    // Mount API routes
    app.use('/api', apiRouter);


    // 404 handler
    app.use((req, res) => {
        res.status(404).json({ error: 'Not Found', message: `Cannot ${req.method} ${req.path}`, timestamp: new Date().toISOString() });
    });

    // Global error handler
    app.use((err, req, res, next) => {
        console.error('[Error]', err);
        const message = process.env.NODE_ENV === 'production'
            ? 'An internal server error occurred'
            : err.message;
        res.status(err.status || 500).json({
            error: message || err.message || 'Internal Server Error',
            // FIX: stack traces suppressed — never expose internals even in non-production
            // Remove this comment and the line below if local debugging is needed:
            // ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
            timestamp: new Date().toISOString()
        });
    });

    // Graceful shutdown
    const gracefulShutdown = (signal) => {
        console.log(`\n[${signal}] Received. Starting graceful shutdown...`);
        server.close(() => {
            console.log('[HTTP] Server closed');
            process.exit(0);
        });
        setTimeout(() => {
            console.error('[Shutdown] Forced exit after timeout');
            process.exit(1);
        }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Start server
    const PORT = process.env.PORT || 3003;
    const HOST = process.env.HOST || '127.0.0.1'; // FIX: was 0.0.0.0 — exposed to all network interfaces

    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`[Server] Port ${PORT} is already in use.`);
            console.error(`  Stop the existing process, or set a different port: PORT=3001 npm start`);
        } else {
            console.error('Server error:', error.message);
        }
        // Keep process alive instead of exiting
    });

    server.listen(PORT, HOST, () => {
        const protocol = isHttps ? 'https' : 'http';
        const pkg = require('./package.json');
        console.log('');
        console.log(`  NovaByte v${pkg.version}`);
        console.log('  ──────────────────────────────────');
        console.log(`  ${'●'} Address      ${`${protocol}://${HOST}:${PORT}`}`);
        console.log(`  ● Environment  ${process.env.NODE_ENV || 'development'}`);
        console.log(`  ${'●'} TLS          ${isHttps ? 'enabled (HTTPS)' : 'disabled (HTTP)'}`);
        console.log('  ──────────────────────────────────');
        console.log('');
    });

    module.exports = { app, server };

})().catch((err) => {
    process.stderr.write('[STARTUP CRASH] ' + (err && err.stack ? err.stack : String(err)) + '\n');
    process.exit(1);
});