/**
 * NovaByte NBOSP - Proxy Routes
 * Browser proxy endpoint for the NBOSP Browser app
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// Rate limiter for browser proxy — higher limits for browsing
const proxyRateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 120,            // 120 requests per minute
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        return req.ip + (req.query.url || '').substring(0, 50);
    }
});

// Fallback fetch using Node's https module (for older Node versions)
const fetchWithHttps = function(targetUrl) {
    return new Promise((resolve, reject) => {
        const protocol = targetUrl.protocol === 'https:' ? require('https') : require('http');
        const options = {
            hostname: targetUrl.hostname,
            port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
            path: targetUrl.pathname + targetUrl.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            },
            timeout: 15000
        };

        const req = protocol.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    ok: res.statusCode >= 200 && res.statusCode < 400,
                    headers: new Map(Object.entries(res.headers)),
                    text: () => Promise.resolve(body),
                    json: () => Promise.resolve(JSON.parse(body))
                });
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.end();
    });
};

/**
 * GET /api/mail/proxy?url=<encoded-url>
 * Fetches an external URL on behalf of the NBOSP Browser, bypassing CORS.
 */
router.get('/proxy', proxyRateLimiter, async (req, res) => {
    let { url } = req.query;

    try { url = decodeURIComponent(url); } catch {}

    url = url
        .replace(/&#x2F;/gi, '/')
        .replace(/&#x3A;/gi, ':')
        .replace(/&amp;/gi, '&')
        .replace(/&#x26;/gi, '&');

    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    let targetUrl;
    try {
        targetUrl = new URL(url);
        if (!['http:', 'https:'].includes(targetUrl.protocol)) {
            return res.status(400).json({ error: 'Only HTTP and HTTPS URLs are allowed' });
        }
    } catch (e) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }

    try {
        console.log('[Proxy] Fetching:', targetUrl.toString());
        let response;
        try {
            response = await fetch(targetUrl.toString(), {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                },
                signal: AbortSignal.timeout(15000)
            });
        } catch (fetchErr) {
            console.log('[Proxy] Native fetch failed, trying https module:', fetchErr.message);
            response = await fetchWithHttps(targetUrl);
        }
        console.log('[Proxy] Response status:', response.status);

        const corsOrigin = response.headers.get('access-control-allow-origin') || '*';
        res.setHeader('Access-Control-Allow-Origin', corsOrigin);

        const corsMethods = response.headers.get('access-control-allow-methods');
        res.setHeader('Access-Control-Allow-Methods', corsMethods || 'GET, POST, OPTIONS');

        const corsHeaders = response.headers.get('access-control-allow-headers');
        res.setHeader('Access-Control-Allow-Headers', corsHeaders || 'Content-Type, Authorization');

        res.setHeader('Access-Control-Max-Age', '86400');
        res.setHeader('Origin-Agent-Cluster', '?1');

        let contentType = '';
        if (typeof response.headers.get === 'function') {
            contentType = response.headers.get('content-type') || '';
        } else if (response.headers instanceof Map) {
            contentType = response.headers.get('content-type') || response.headers.get('Content-Type') || '';
        } else if (response.headers && typeof response.headers === 'object') {
            contentType = response.headers['content-type'] || response.headers['Content-Type'] || '';
        }

        const setCookie = response.headers.get('set-cookie');
        if (setCookie) {
            const sanitizedCookie = setCookie.replace('HttpOnly', '').replace('; Secure', '').trim();
            res.setHeader('Set-Cookie', sanitizedCookie);
        }

        let body = await response.text();

        if (contentType.includes('text/html')) {
            res.removeHeader('X-Frame-Options');
            res.removeHeader('x-frame-options');
            res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");

            const baseTag = `<base href="${targetUrl.origin}/">`;
            if (body.includes('<head>')) {
                body = body.replace('<head>', '<head>' + baseTag);
            } else if (body.includes('<body>')) {
                body = body.replace('<body>', baseTag + '<body>');
            } else {
                body = baseTag + body;
            }

            res.setHeader('Content-Type', 'text/html; charset=utf-8');
        } else {
            res.setHeader('Content-Type', contentType || 'application/octet-stream');
        }

        res.status(response.status).send(body);

    } catch (error) {
        console.error('[Proxy] Fetch error:', error.message);
        res.status(502).json({ error: 'Failed to fetch URL: ' + error.message });
    }
});

/**
 * OPTIONS /api/mail/proxy - CORS preflight
 */
router.options('/proxy', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
});

module.exports = { router };