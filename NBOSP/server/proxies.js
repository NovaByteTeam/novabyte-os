const rateLimit = require('express-rate-limit');
const dns = require('dns');
const ServerEventLog = require('./core/server-event-log');

// ── Frame-Embed Check Proxy ────────────────────────────────────────────────
// Resolves whether a URL can be embedded in an <iframe> by inspecting the
// response headers server-side (X-Frame-Options / CSP frame-ancestors).
// Doing this client-side is unreliable: cross-origin frames throw on
// contentDocument access (so genuine blocks are never detected) and same-origin
// frames pass through an about:blank state mid-load (so embeddable sites are
// false-positive flagged as blocked).

const frameCheckCache = new Map(); // key: origin → { embeddable, ts }
const FRAME_CHECK_TTL     = 10 * 60 * 1000; // 10 min — XFO/CSP headers rarely change
const FRAME_CHECK_MAX     = 500;
const FRAME_CHECK_TIMEOUT = 5000;

/**
 * Evaluate a frame-ancestors source list against our embedding origin.
 * Returns true if embedding is allowed by THIS directive.
 */
function _frameAncestorsAllows(cspValue, embedOrigin) {
    if (!cspValue) return true;
    // CSP may have multiple frame-ancestors directives; allow if ANY permits.
    const directives = cspValue.split(';');
    let sawDirective = false;
    for (const raw of directives) {
        const parts = raw.trim().split(/\s+/);
        if (parts[0].toLowerCase() !== 'frame-ancestors') continue;
        sawDirective = true;
        const sources = parts.slice(1).map(s => s.toLowerCase());
        if (sources.includes('*')) return true;
        if (sources.includes("'self'") || sources.includes('self')) return true;
        for (const s of sources) {
            if (s === "'none'" || s === 'none') continue;
            if (s === "'self'" || s === 'self') return true;
            // Match 'scheme://host' or 'scheme://host:port' or '*.host' patterns
            try {
                const m = s.match(/^([\w-]+:\/\/)?([^/]+)/);
                if (!m) continue;
                const pattern = m[2];
                if (pattern.startsWith('*.')) {
                    const suffix = pattern.slice(1); // ".example.com"
                    if (embedOrigin.endsWith(suffix)) return true;
                    // also match apex domain itself
                    if (embedOrigin === pattern.slice(2)) return true;
                } else if (embedOrigin === pattern) {
                    return true;
                } else {
                    // host without scheme — compare host:port portion of origin
                    const embedHost = embedOrigin.replace(/^[\w.-]+:\/\//, '');
                    if (embedHost === pattern) return true;
                }
            } catch (_) {}
        }
    }
    // If the page had a frame-ancestors directive at all and none matched, blocked.
    return !sawDirective;
}

function _isBlockedByHeaders(resp, embedOrigin) {
    // X-Frame-Options (case-insensitive). DENY/SAMEORIGIN block cross-origin.
    const xfo = (resp.headers.get('x-frame-options') || '').trim().toLowerCase();
    if (xfo === 'deny') return true;
    if (xfo === 'sameorigin') {
        // We're never same-origin with the framed site (browser origin ≠ target).
        return true;
    }
    if (xfo.startsWith('allow-from')) return true; // legacy; we never match

    // Content-Security-Policy frame-ancestors
    const csp = resp.headers.get('content-security-policy') || resp.headers.get('content-security-policy-report-only');
    if (csp && /frame-ancestors/i.test(csp)) {
        return !_frameAncestorsAllows(csp, embedOrigin.toLowerCase());
    }
    return false;
}

const frameCheckLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { error: 'Too many frame-check requests, slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
});

async function _probeFrameEmbeddable(targetUrl, embedOrigin) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FRAME_CHECK_TIMEOUT);
    try {
        // HEAD first — cheapest; many servers echo the same security headers.
        let resp = await fetch(targetUrl, {
            method: 'HEAD',
            redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NovaByte/1.0)' },
            signal: controller.signal,
        });
        // Some servers don't send XFO/CSP on HEAD (or reject it). Fall back to GET.
        const hasSecurityHdr = resp.headers.get('x-frame-options') ||
            /frame-ancestors/i.test(resp.headers.get('content-security-policy') || '');
        if (!hasSecurityHdr && resp.ok) return false;
        if (resp.status === 405 || resp.status === 501 || resp.status === 400 || !resp.ok) {
            resp = await fetch(targetUrl, {
                method: 'GET',
                redirect: 'follow',
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NovaByte/1.0)' },
                signal: controller.signal,
            });
            // Stream bodies are expensive; we only need headers, so cancel it.
            try { resp.body?.cancel(); } catch (_) {}
        }
        return _isBlockedByHeaders(resp, embedOrigin);
    } finally {
        clearTimeout(timer);
    }
}

function setupFrameCheckProxy(app) {
    app.get('/api/frame-check', frameCheckLimiter, requireSession, async (req, res) => {
        const raw = req.query.url;
        if (!raw || typeof raw !== 'string') {
            return res.status(400).json({ error: 'url parameter is required' });
        }

        let urlObj;
        try { urlObj = new URL(raw); }
        catch (_) { return res.status(400).json({ error: 'Invalid URL' }); }

        if (!['http:', 'https:'].includes(urlObj.protocol)) {
            return res.status(400).json({ error: 'Only http and https URLs are supported' });
        }

        const isPrivate = await _dnsCheckPrivate(urlObj.hostname);
        if (isPrivate) {
            return res.status(400).json({ error: 'Internal URLs are not permitted' });
        }

        const cacheKey = urlObj.origin; // headers are origin-scoped
        const cached = frameCheckCache.get(cacheKey);
        if (cached && (Date.now() - cached.ts) < FRAME_CHECK_TTL) {
            return res.json({ embeddable: cached.embeddable, cached: true });
        }

        let blocked;
        try {
            blocked = await _probeFrameEmbeddable(urlObj.toString(), urlObj.origin);
        } catch (_) {
            // Network error / timeout → assume embeddable so we don't false-block.
            blocked = false;
        }

        if (frameCheckCache.size >= FRAME_CHECK_MAX) {
            frameCheckCache.delete(frameCheckCache.keys().next().value);
        }
        frameCheckCache.set(cacheKey, { embeddable: !blocked, ts: Date.now() });

        res.setHeader('Cache-Control', 'private, max-age=300');
        res.json({ embeddable: !blocked });
    });
}
// ── End Frame-Embed Check Proxy ────────────────────────────────────────────

// ── App Network Proxy ──────────────────────────────────────────────────────
// Used by app-sandbox.js handleNetFetch to make outbound requests server-side,
// bypassing browser CORS restrictions for apps with the net:external permission.
//
// Security model:
//   - Only reachable from the same origin (enforced by the sandbox's IPC flow;
//     the sandbox calls /api/proxy, not the iframe directly).
//   - Private/internal IPs blocked (SSRF prevention).
//   - Allowlisted HTTP methods only.
//   - Response size capped to prevent memory exhaustion.
//   - Rate limited per IP.

const APP_PROXY_TIMEOUT    = 30 * 1000;      // 30 s — match IPC timeout
const APP_PROXY_SIZE_CAP   = 10 * 1024 * 1024; // 10 MB
const APP_PROXY_METHODS    = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function requireSession(req, res, next) {
    if (!req.session || !req.session.id) {
        return res.status(401).json({ error: 'Unauthorized — session required' });
    }
    next();
}

const _PRIVATE_EXACT = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]', '[::]']);
const _PRIVATE_PREFIXES = ['10.', '172.16.', '172.17.', '172.18.', '172.19.',
    '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.',
    '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.',
    '192.168.', '169.254.', '100.64.'];

function _isPrivateHost(hostname) {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (_PRIVATE_EXACT.has(h)) return true;
    if (_PRIVATE_PREFIXES.some(p => h.startsWith(p))) return true;
    if (h.endsWith('.local') || h.endsWith('.internal')) return true;
    return false;
}

function _isPrivateIpAddr(ip) {
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return false;
    const parts = ip.split('.').map(Number);
    return parts[0] === 10 ||
           (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
           (parts[0] === 192 && parts[1] === 168) ||
           (parts[0] === 169 && parts[1] === 254) ||
           (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

const _dnsPrivateCache = new Map();
const _DNS_TTL = 30_000;
async function _dnsCheckPrivate(hostname) {
    if (!hostname || typeof hostname !== 'string') return true;
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (_isPrivateHost(h)) return true;

    const cached = _dnsPrivateCache.get(h);
    if (cached && Date.now() - cached.ts < _DNS_TTL) return cached.private;

    let private_ = false;
    try {
        const { address } = await dns.promises.lookup(h);
        private_ = _isPrivateIpAddr(address);
    } catch {
        private_ = true; // fail closed on DNS error
    }

    _dnsPrivateCache.set(h, { private: private_, ts: Date.now() });
    if (_dnsPrivateCache.size > 500) {
        const first = _dnsPrivateCache.keys().next().value;
        _dnsPrivateCache.delete(first);
    }
    return private_;
}

const appProxyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,  // generous — chat apps can send many messages per minute
    message: { error: 'Too many proxy requests, slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
});

function setupAppNetworkProxy(app) {
    app.post('/api/proxy', appProxyLimiter, requireSession, async (req, res) => {
        const { url: rawUrl, method: rawMethod, headers: reqHeaders, body: reqBody } = req.body ?? {};

        // Validate URL
        if (!rawUrl || typeof rawUrl !== 'string') {
            return res.status(400).json({ error: 'url is required' });
        }
        let urlObj;
        try { urlObj = new URL(rawUrl); }
        catch (_) { return res.status(400).json({ error: 'Invalid URL' }); }

        if (!['http:', 'https:'].includes(urlObj.protocol)) {
            return res.status(400).json({ error: 'Only http and https URLs are supported' });
        }
        if (_isPrivateHost(urlObj.hostname)) {
            ServerEventLog.log({
                app: 'AppNetworkProxy',
                severity: 'warn',
                message: `Blocked proxy request to private host: ${urlObj.hostname}`,
                data: { hostname: urlObj.hostname, reason: 'private_host' },
            });
            return res.status(403).json({ error: 'Internal URLs are not permitted' });
        }
        if (await _dnsCheckPrivate(urlObj.hostname)) {
            ServerEventLog.log({
                app: 'AppNetworkProxy',
                severity: 'warn',
                message: `Blocked proxy request to private host (DNS-resolved): ${urlObj.hostname}`,
                data: { hostname: urlObj.hostname, reason: 'dns_private' },
            });
            return res.status(403).json({ error: 'Internal URLs are not permitted' });
        }

        // Validate method
        const method = (rawMethod || 'GET').toUpperCase();
        if (!APP_PROXY_METHODS.has(method)) {
            return res.status(400).json({ error: `Method not allowed: ${method}` });
        }

        // Strip hop-by-hop headers that must not be forwarded
        const HOP_BY_HOP = new Set([
            'host', 'connection', 'keep-alive', 'proxy-authenticate',
            'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade',
        ]);
        const outHeaders = {};
        if (reqHeaders && typeof reqHeaders === 'object') {
            for (const [k, v] of Object.entries(reqHeaders)) {
                if (!HOP_BY_HOP.has(k.toLowerCase())) {
                    outHeaders[k] = v;
                }
            }
        }

        // Follow redirects manually so each hop gets re-validated against the
        // private-host check (mirrors the pattern used by fetchEmailImage above).
        // Without this, a public URL that 302s to an internal/metadata address
        // would sail through the initial check and still reach it via fetch's
        // own automatic redirect handling.
        const MAX_PROXY_REDIRECTS = 5;
        let currentUrl = urlObj.toString();
        const visitedUrls = new Set();
        let resp;

        for (let hop = 0; hop <= MAX_PROXY_REDIRECTS; hop++) {
            if (visitedUrls.has(currentUrl)) {
                ServerEventLog.log({
                    app: 'AppNetworkProxy',
                    severity: 'warn',
                    message: `Redirect loop detected proxying ${urlObj.hostname}`,
                    data: { hostname: urlObj.hostname },
                });
                return res.status(400).json({ error: 'Redirect loop detected' });
            }
            visitedUrls.add(currentUrl);

            let hopUrlObj;
            try { hopUrlObj = new URL(currentUrl); }
            catch (_) { return res.status(400).json({ error: 'Invalid redirect URL' }); }

            if (!['http:', 'https:'].includes(hopUrlObj.protocol)) {
                return res.status(400).json({ error: 'Only http and https URLs are supported' });
            }
            if (await _dnsCheckPrivate(hopUrlObj.hostname)) {
                return res.status(403).json({ error: 'Internal URLs are not permitted' });
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), APP_PROXY_TIMEOUT);

            let hopResp;
            try {
                hopResp = await fetch(currentUrl, {
                    method,
                    headers: outHeaders,
                    body: (method === 'GET' || method === 'HEAD') ? undefined : (reqBody ?? null),
                    redirect: 'manual',
                    signal: controller.signal,
                });
            } catch (err) {
                clearTimeout(timer);
                ServerEventLog.log({
                    app: 'AppNetworkProxy',
                    severity: 'error',
                    message: `Network error proxying ${urlObj.hostname}: ${err.message}`,
                    data: { hostname: urlObj.hostname, error: err.message },
                });
                return res.status(502).json({ error: `Network error: ${err.message}` });
            } finally {
                clearTimeout(timer);
            }

            if (hopResp.status >= 300 && hopResp.status < 400) {
                const loc = hopResp.headers.get('location');
                if (!loc) return res.status(502).json({ error: 'Redirect with no Location header' });
                try { currentUrl = new URL(loc, currentUrl).toString(); }
                catch (_) { return res.status(400).json({ error: 'Invalid redirect target' }); }
                continue;
            }

            resp = hopResp;
            break;
        }

        if (!resp) {
            return res.status(502).json({ error: 'Too many redirects' });
        }

        // Read response body with size cap
        const chunks = [];
        let total = 0;
        try {
            const reader = resp.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.length;
                if (total > APP_PROXY_SIZE_CAP) {
                    reader.cancel();
                    return res.status(502).json({ error: 'Response too large' });
                }
                chunks.push(value);
            }
        } catch (err) {
            return res.status(502).json({ error: `Read error: ${err.message}` });
        }

        const bodyText = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');

        // Forward a safe subset of response headers
        const SAFE_RESPONSE_HEADERS = new Set([
            'content-type', 'content-language', 'cache-control',
            'etag', 'last-modified', 'x-request-id',
        ]);
        const outRespHeaders = {};
        for (const [k, v] of resp.headers.entries()) {
            if (SAFE_RESPONSE_HEADERS.has(k.toLowerCase())) {
                outRespHeaders[k] = v;
            }
        }

        res.json({
            status:     resp.status,
            statusText: resp.statusText,
            headers:    outRespHeaders,
            body:       bodyText,
        });
    });
}
// ── End App Network Proxy ──────────────────────────────────────────────────

module.exports = {
    setupFrameCheckProxy,
    setupAppNetworkProxy,
};