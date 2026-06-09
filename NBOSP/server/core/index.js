const path = require('path');
const fs = require('fs');
const express = require('express');

/**
 * NovaByte Modular Server Entry
 */
require('dotenv').config();

const app = express();

const { validateEnvironment } = require('./env');
const { configureSSL } = require('./ssl');
const { setupMiddleware } = require('../middleware');
const { mountRoutes } = require('../routes');
const { setupFaviconRoutes } = require('../favicons');
const { setupSuggestProxy, setupEmailImageProxy } = require('../proxies');

// Global error handlers
process.on('uncaughtException', (error) => {
    process.stderr.write(`[uncaughtException] ${error?.stack || error}\n`);
});

process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[unhandledRejection] ${reason?.stack || reason}\n`);
});

// 1. Env validation
try { 
    validateEnvironment(); 
} catch(e) { 
    console.error(e); 
    process.exit(1); 
}

// 2. Setup middleware
setupMiddleware(app);

// 2.5. Index.html caching and nonce injection (MUST come before static middleware)
let _indexHtmlRaw = null;
async function getIndexHtml() {
    if (!_indexHtmlRaw) {
        _indexHtmlRaw = await fs.promises.readFile(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
    }
    return _indexHtmlRaw;
}
fs.watch(path.join(__dirname, '..', '..', 'index.html'), () => { _indexHtmlRaw = null; });

// GET / with nonce injection (MUST come before static middleware!)
app.get('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    // res.locals.nonce is unreliable (often empty due to middleware order).
    // Helmet already set the CSP header with the real nonce — extract it from there.
    const cspHeader = res.getHeader('Content-Security-Policy') || '';
    const nonceMatch = cspHeader.match(/'nonce-([^']+)'/);
    const nonce = nonceMatch ? nonceMatch[1] : (res.locals.nonce || '');
    let html = await getIndexHtml();

    // 1. Inject __cspNonce script and CSRF meta BEFORE stamping nonces,
    //    so the injected <script> tag is included in the nonce-stamping pass below.
    const csrfToken = req.session?.csrfToken || res.locals.csrfToken || '';
    html = html.replace('</head>', `<meta name="csrf-token" content="${csrfToken}"><script>window.__cspNonce="${nonce}";</script></head>`);

    // 2. Strip any hard-coded CSP meta tag (server header takes precedence)
    html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, '');

    // 3. Stamp nonce onto every <script> and <style> tag (including the one injected above)
    html = html.replace(/<script([\s>])/g, `<script nonce="${nonce}"$1`);
    html = html.replace(/<style([\s>])/g, `<style nonce="${nonce}"$1`);

    res.send(html);
});

// 3. Static asset delivery with caching
const isDevelopment = process.env.NODE_ENV !== 'production';
const cacheOptions = {
    maxAge: isDevelopment ? '1m' : '1d',
    etag: true,
    immutable: !isDevelopment
};

const jsCacheOptions = {
    maxAge: isDevelopment ? 0 : '1d',
    etag: true,
    immutable: !isDevelopment
};

// Serve static assets (but NOT index.html — handled by GET / route above)
app.use(express.static(path.resolve(__dirname, '..', '..'), { ignore: ['index.html'] }));
app.use('/assets', express.static(path.join(__dirname, '..', '..', 'assets'), cacheOptions));
app.use('/js', express.static(path.join(__dirname, '..', '..', 'js'), jsCacheOptions));
app.use('/css', express.static(path.join(__dirname, '..', '..', 'css'), cacheOptions));

// 4. Setup icon/proxy routes
setupFaviconRoutes(app);
setupSuggestProxy(app);
setupEmailImageProxy(app);

// 5. Manifest and version endpoints
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

app.get('/version.json', async (req, res) => {
    const versionPath = path.join(__dirname, '..', '..', 'version.json');
    try {
        await fs.promises.access(versionPath);
        return res.sendFile(versionPath);
    } catch {
        res.status(404).json({ error: 'version.json not found' });
    }
});

// 6. Serve split files from project root
app.get('/app.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, '..', '..', 'app.js'));
});

app.get('/ui-init.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, '..', '..', 'ui-init.js'));
});

app.get('/trackers.js', async (req, res) => {
    const p = path.join(__dirname, '..', '..', 'trackers.js');
    try {
        await fs.promises.access(p);
    } catch {
        return res.status(404).json({ error: 'trackers.js not found — run the generator script' });
    }
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(p);
});

app.get('/style.css', (req, res) => {
    res.setHeader('Content-Type', 'text/css');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, '..', '..', 'style.css'));
});

// 7. Memory monitoring
setInterval(() => {
    const m = process.memoryUsage();
    const mb = v => Math.round(v / 1024 / 1024);
    process.stdout.write(
        `[Memory] heapUsed=${mb(m.heapUsed)}MB heapTotal=${mb(m.heapTotal)}MB rss=${mb(m.rss)}MB external=${mb(m.external)}MB\n`
    );
    if (typeof global.gc === 'function' && m.heapUsed / m.heapTotal > 0.85 && m.heapUsed > 100 * 1024 * 1024) {
        global.gc();
        process.stdout.write('[Memory] gc() triggered - heap was above 85%\n');
    }
}, 60_000).unref();

// 8. Health checks
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// 11. Strip tracking parameters
app.get('/api/security/strip-tracking', (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'url parameter is required' });
    }

    let urlObj;
    try {
        urlObj = new URL(decodeURIComponent(url));
    } catch (_) {
        return res.status(400).json({ error: 'Invalid URL' });
    }

    if (!['http:', 'https:'].includes(urlObj.protocol)) {
        return res.status(400).json({ error: 'Only http and https URLs are supported' });
    }

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

// 12. Mount all API routes
mountRoutes(app);

// 13. Stub API endpoints for prefetch-manager
app.get('/api/apps/list', (req, res) => res.json([]));
app.get('/api/apps/registry', (req, res) => res.json({}));
app.get('/api/apps/permissions', (req, res) => res.json([]));
app.get('/api/security/status', (req, res) => res.json({ ok: true }));
app.get('/api/security/sandbox-check', (req, res) => res.json({ sandboxed: true }));
app.get('/api/user/profile', (req, res) => res.json({}));
app.get('/api/user/preferences', (req, res) => res.json({}));
app.get('/api/user/sessions', (req, res) => res.json([]));
app.get('/api/files/list', (req, res) => res.json([]));
app.get('/api/files/search', (req, res) => res.json([]));
app.get('/api/files/metadata', (req, res) => res.json({}));

// 14. 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not Found', message: `Cannot ${req.method} ${req.path}`, timestamp: new Date().toISOString() });
});

// 15. Global error handler
app.use((err, req, res, next) => {
    console.error('[Error]', err);
    const message = process.env.NODE_ENV === 'production'
        ? 'An internal server error occurred'
        : err.message;
    res.status(err.status || 500).json({
        error: message || err.message || 'Internal Server Error',
        timestamp: new Date().toISOString()
    });
});

// 16. SSL Configuration
const { server } = configureSSL(app);

const PORT = process.env.PORT || 3003;
const HOST = process.env.HOST || '127.0.0.1';

// 17. Server error handling
server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`[Server] Port ${PORT} is already in use.`);
        console.error(`  Stop the existing process, or set a different port: PORT=3001 npm start`);
    } else {
        console.error('Server error:', error.message);
    }
});

// 18. Graceful shutdown
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

// 19. Start server
server.listen(PORT, HOST, () => {
    const isHttps = process.env.HTTPS === 'true';
    const protocol = isHttps ? 'https' : 'http';
    try {
        const pkg = require('../../package.json');
        console.log('');
        console.log(`  NovaByte v${pkg.version}`);
    } catch {
        console.log('');
        console.log(`  NovaByte`);
    }
    console.log('  ──────────────────────────────────');
    console.log(`  ● Address      ${protocol}://${HOST}:${PORT}`);
    console.log(`  ● Environment  ${process.env.NODE_ENV || 'development'}`);
    console.log(`  ● TLS          ${isHttps ? 'enabled (HTTPS)' : 'disabled (HTTP)'}`);
    console.log('  ──────────────────────────────────');
    console.log('');
});

// 20. Performance tuning
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.maxRequestsPerSocket = 1000;

module.exports = { app, server };