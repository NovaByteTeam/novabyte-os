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
    const { default: chalk } = await import('chalk');
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
        console.warn(chalk.yellow('[Server] SSL certs not found — falling back to HTTP (Service Workers will work on http://localhost)'));
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
            // FIX: /api/mail/ and /api/email/ are no longer skipped — they have their own limiter
            if (req.path === '/favicon.ico') return true;
            return false;
        }
    });


    // FIX: Email endpoints were completely exempt from rate limiting.
    // Apply a strict dedicated limiter — mail routes are prime targets for abuse.
    const emailLimiter = rateLimit({
        windowMs: 60 * 1000,         // 1 minute window
        max: 10,                      // max 10 requests per minute per IP
        message: { error: 'Too many email requests, please slow down.' },
        standardHeaders: true,
        legacyHeaders: false
    });

    app.use('/api/', limiter);
    app.use('/api/mail/', emailLimiter);
    app.use('/api/email/', emailLimiter); // FIX: email routes now have their own strict limiter

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
    app.get('/modules.js', (req, res) => {
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.sendFile(path.join(__dirname, 'modules.js'));
    });
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
            uptime: process.uptime(),
            service: 'NovaByte'
        });
    });

    app.get('/api/health', (req, res) => {
        res.status(200).json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            service: 'NovaByte'
        });
    });

    // API info
    app.get('/api/info', (req, res) => {
        res.json({
            name: 'NovaByte NBOSP API',
            version: '1.0.0',
            baseUrl: '/api',
            endpoints: {
                security: '/api/security - Security settings',
                mail: '/api/mail/proxy - Browser proxy'
            },
            docs: 'All endpoints accept JSON, authentication via session cookie'
        });
    });

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
        const BLOCKED_PREFIXES = ['10.', '192.168.', '172.'];
        if (BLOCKED.includes(h) || BLOCKED_PREFIXES.some(p => h.startsWith(p)) || h.endsWith('.local')) {
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
            console.error(chalk.red(`[Server] Port ${PORT} is already in use.`));
            console.error(chalk.gray(`  Stop the existing process, or set a different port: PORT=3001 npm start`));
        } else {
            console.error(chalk.red('Server error:'), error.message);
        }
        // Keep process alive instead of exiting
    });

    server.listen(PORT, HOST, () => {
        const protocol = isHttps ? 'https' : 'http';
        const pkg = require('./package.json');
        console.log('');
        console.log(`  ${chalk.bold.cyan('NovaByte')} ${chalk.gray('v' + pkg.version)}`);
        console.log(chalk.gray('  ──────────────────────────────────'));
        console.log(`  ${chalk.green('●')} Address      ${chalk.white(`${protocol}://${HOST}:${PORT}`)}`);
        console.log(`  ${chalk.green('●')} Environment  ${chalk.white(process.env.NODE_ENV || 'development')}`);
        console.log(`  ${chalk.green('●')} TLS          ${isHttps ? chalk.green('enabled (HTTPS)') : chalk.yellow('disabled (HTTP)')}`);
        console.log(chalk.gray('  ──────────────────────────────────'));
        console.log('');
    });

    module.exports = { app, server };

})().catch(() => {
    // Startup error caught by global handler
});