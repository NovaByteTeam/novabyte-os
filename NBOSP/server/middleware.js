const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const SqliteStore = require('better-sqlite3-session-store')(session);
const { isTrustedSystemAppRequest } = require('./rate-limit-auth');
const { getRuntimeDataDir } = require('../scripts/runtime-data-dir');

// Sessions persist to disk here so they survive server restarts —
// without this, express-session falls back to MemoryStore, which is
// wiped every time the process dies (refresh survives, restart doesn't).
// Uses better-sqlite3 (already a dependency, via the favicon cache) instead
// of session-file-store: SQLite's own locking avoids the Windows EPERM-on-
// rename failures that file-based session storage hit in this project.
const SESSION_DB_DIR = path.join(getRuntimeDataDir(path.resolve(__dirname, '..')), 'data');
const SESSION_DB_PATH = path.join(SESSION_DB_DIR, 'sessions.db');

const EXACT_SKIP_PATHS = new Set([
    '/health',
    '/favicon.ico',
    '/api/favicon',
    '/api/events/stream',
    // App sandbox registration is local bookkeeping performed during every
    // packaged-app launch, not a user-facing API request.
    '/api/apps/serve/register',
]);
const PREFIX_SKIP_PATHS = [
    '/js/',
    '/css/',
    '/public/',
    '/assets/',
    '/api/apps/serve/unregister/',
];

function shouldSkipGlobalApiRateLimit(req) {
    if (isTrustedSystemAppRequest(req)) return true;
    // Express removes the mounted `/api/` prefix from req.path. Check both
    // forms so full API routes match without breaking existing mounted-path
    // exemptions.
    const fullPath = (req.originalUrl || req.path).split('?')[0];
    const mountedPath = req.path || fullPath;
    return EXACT_SKIP_PATHS.has(fullPath) ||
        EXACT_SKIP_PATHS.has(mountedPath) ||
        PREFIX_SKIP_PATHS.some(p => fullPath.startsWith(p) || mountedPath.startsWith(p));
}

// This used to work only because favicons.js happened to create ../data
// first and index.js requires favicons.js before setupMiddleware() runs —
// an ordering coincidence, not a guarantee. Ensuring the dir exists here
// too means this file no longer depends on another module having run first.
fs.mkdirSync(SESSION_DB_DIR, { recursive: true });

// Body size limit for express.json/urlencoded. The original had this set to
// '4gb', which meant a single request could buffer up to 4GB in memory
// before parsing even started — one request from anywhere could eat the
// whole heap. Configurable via env for deployments that genuinely need
// large payloads (e.g. bulk import), defaulting to something sane.
const BODY_SIZE_LIMIT = process.env.BODY_SIZE_LIMIT || '10mb';

let sessionDb = null;

function setupMiddleware(app) {
    app.use((req, res, next) => {
        res.setHeader('Origin-Agent-Cluster', '?1');
        next();
    });

    // Security middleware
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net'],
                scriptSrcElem: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'blob:', 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://localhost:3003', 'https://127.0.0.1:3003'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com'],
                styleSrcElem: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com'],
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
            },
            setAllHeaders: false,
            disableFloc: true
        },
        crossOriginResourcePolicy: false,
        originAgentCluster: false
    }));

    // .filter(Boolean) can leave an empty array (e.g. CORS_ORIGIN="," or a
    // stray trailing comma), and `[] || fallback` doesn't trigger since []
    // is truthy — that silently locked out every origin including the dev
    // default. Check length explicitly instead of relying on truthiness.
    const envOrigins = process.env.CORS_ORIGIN?.split(',').map(o => o.trim()).filter(Boolean);
    const corsOrigins = envOrigins?.length ? envOrigins : ['https://localhost:3003', 'https://127.0.0.1:3003'];

    app.use(cors({
        origin: corsOrigins,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
            'Content-Type', 'Authorization', 'X-Requested-With', 'X-CSRF-Token',
            'X-Nova-System-App', 'X-Nova-System-Time', 'X-Nova-System-Signature',
        ],
        exposedHeaders: ['X-CSRF-Token'],
        maxAge: 86400
    }));

    // Optimize static asset delivery speed with aggressive browser caching
    // In development, use short TTL to allow faster iteration; in production, cache for 24h
    const isDevelopment = process.env.NODE_ENV !== 'production';
    const cacheOptions = {
        maxAge: isDevelopment ? '1m' : '1d', // 1 min in dev, 24 hours in production
        etag: true,
        immutable: !isDevelopment // Only immutable in production
    };

    // JS files need no-cache in development for fresh loads
    const jsCacheOptions = {
        maxAge: isDevelopment ? 0 : '1d', // No cache in dev, 24h in production
        etag: true,
        immutable: !isDevelopment
    };

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
        skip: shouldSkipGlobalApiRateLimit
    });

    // Tiered email rate limiters — split by frequency of legitimate use:
    //   connect/disconnect/preview: called on every folder switch and email open, needs headroom
    //   messages/search/folders:    moderate — paging and searching
    //   send/batch:                 strict — state-modifying actions, low legitimate frequency

    const emailConnectLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 120,  // up to 2/sec — covers rapid folder switching and multi-window use
        message: { error: 'Too many connection requests, please slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
        skip: isTrustedSystemAppRequest,
    });

    const emailReadLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 60,   // 1/sec sustained — paging through inbox, searching
        message: { error: 'Too many email requests, please slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
        skip: isTrustedSystemAppRequest,
    });

    const emailWriteLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 20,   // strict — send, delete, move, batch
        message: { error: 'Too many email write requests, please slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
        skip: isTrustedSystemAppRequest,
    });

    const faviconLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 60,   // 60 requests/min per IP
        message: { error: 'Too many favicon requests, please slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
        skip: isTrustedSystemAppRequest,
    });

    // The SSE stream is long-lived, but reconnects (tab backgrounding,
    // sleep/wake, brief network blips) mean a fresh connect can happen
    // several times a minute under normal use. Window is short and max
    // is generous specifically so a reconnect burst can never get stuck
    // rate-limited against itself.
    const eventsStreamLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 30,   // up to 1 connect attempt every 2 sec, sustained
        message: { error: 'Too many event stream connections, please slow down.' },
        standardHeaders: true,
        legacyHeaders: false,
        skip: isTrustedSystemAppRequest,
    });

    app.use('/api/', limiter);
    app.use('/api/email/connect', emailConnectLimiter);
    app.use('/api/email/disconnect', emailConnectLimiter);
    app.use('/api/email/preview', emailConnectLimiter);
    app.use('/api/email/csrf-token', emailConnectLimiter);
    app.use('/api/email/messages', emailReadLimiter);
    app.use('/api/email/message', emailReadLimiter);
    app.use('/api/email/folders', emailReadLimiter);
    app.use('/api/email/search', emailReadLimiter);
    app.use('/api/email/send', emailWriteLimiter);
    app.use('/api/email/batch', emailWriteLimiter);
    app.use('/api/favicon', faviconLimiter);
    app.use('/api/events/stream', eventsStreamLimiter);

    app.use(express.json({ limit: BODY_SIZE_LIMIT }));
    app.use(express.urlencoded({ extended: true, limit: BODY_SIZE_LIMIT }));
    app.use(cookieParser());

    // Session middleware (required for CSRF protection)
    sessionDb = new Database(SESSION_DB_PATH);
    // WAL mode lets reads and writes proceed without blocking each other —
    // matters once multiple requests touch the session table concurrently.
    sessionDb.pragma('journal_mode = WAL');

    app.use(session({
        store: new SqliteStore({
            client: sessionDb,
            expired: {
                clear: true,
                intervalMs: 15 * 60 * 1000 // sweep expired sessions every 15 min
            }
        }),
        secret: (() => {
            if (!process.env.SESSION_SECRET) {
                throw new Error('SESSION_SECRET environment variable is required but not set.');
            }
            return process.env.SESSION_SECRET;
        })(),
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: process.env.HTTPS === 'true',
            httpOnly: true,
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000 // 24 hours
        }
    }));

    // Populate req.user for the local single-user OS. There's no login/
    // account system anywhere in this codebase — req.user was previously
    // never assigned at all, which meant every `req.user?.role === 'admin'`
    // check in security/routes.js was permanently false, and every
    // `req.user?.id` was permanently undefined. This derives an identity
    // from the existing Express session (already persisted via SqliteStore
    // above) plus the local admin-state flag, so those checks mean
    // something real instead of being dead branches.
    const { isAdminEnabled } = require('./security/admin-state');
    app.use((req, res, next) => {
        req.user = {
            id: req.sessionID,
            role: isAdminEnabled() ? 'admin' : 'user'
        };
        // Stamped onto the session itself (not just req.user) so the
        // /api/security/sessions listing — which reads the SQLite session
        // store directly, not live request objects — can show which
        // role/IP/UA each stored session belongs to.
        if (req.session) {
            req.session.user = req.user;
            req.session.lastIp = req.ip;
            req.session.lastUserAgent = req.get('user-agent') || null;
        }
        next();
    });

    // Apply security middleware from security-middleware.js if available.
    // One middleware that loops over all of them and checks the exclusion
    // once, instead of the previous N wrapper layers (one per security
    // middleware, each re-running its own identical exclusion check) —
    // same behavior, fewer middleware hops per request.
    try {
        const securityMiddleware = require('../security/middleware');
        if (securityMiddleware?.createSecurityMiddleware) {
            const securityMws = securityMiddleware.createSecurityMiddleware({
                enableCsrfProtection: true,
                enableIpBlocking: true,
                enableRequestValidation: true,
                enableInputSanitization: true
            });
            const securityExclusions = ['/bare/'];
            const isExcluded = (reqPath) => securityExclusions.some(
                p => reqPath === p || reqPath.endsWith(p) || reqPath.startsWith(p)
            );

            app.use((req, res, next) => {
                if (isExcluded(req.path)) return next();
                const runFrom = (i) => {
                    if (i >= securityMws.length) return next();
                    securityMws[i](req, res, (err) => {
                        if (err) return next(err);
                        runFrom(i + 1);
                    });
                };
                runFrom(0);
            });
        }
    } catch (e) {
        console.warn('[Middleware] Security middleware not available:', e.message);
    }

    // General security headers
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-XSS-Protection', '1; mode=block');
        if (!res.getHeader('Cross-Origin-Resource-Policy')) {
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        }
        next();
    });
}

// Lets index.js close the session DB cleanly during graceful shutdown.
// Note: this closes the DB handle, but the SqliteStore's own internal
// setInterval (its 15-min expired-session sweep) isn't unref'd by that
// library and isn't something this file can reach to fix — it's why
// index.js's shutdown handler still needs its hard-exit timeout fallback.
function closeSessionDb() {
    if (!sessionDb) return;
    try { sessionDb.close(); } catch (_) { /* already closed or never opened */ }
    sessionDb = null;
}

module.exports = { setupMiddleware, closeSessionDb, shouldSkipGlobalApiRateLimit };