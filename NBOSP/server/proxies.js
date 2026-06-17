// ── Search Suggest Proxy ──────────────────────────────────────────────────
// Direct engine URLs
// Cache: in-memory Map, 60s TTL, 2000 entry cap.
// Rate limit: 120 req/min per IP.

const rateLimit = require('express-rate-limit');

const suggestCache = new Map(); // key: `${engine}:${q}` → { data, ts }
const SUGGEST_TTL     = 60 * 1000; // 60 seconds
const SUGGEST_MAX     = 2000;
const SUGGEST_TIMEOUT = 5000;

// Direct engine URLs
const SUGGEST_ENGINES_DIRECT = {
    google:     q => `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`,
    duckduckgo: q => `https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list&no-datr=1`,
    bing:       q => `https://api.bing.com/qsonhs.aspx?q=${encodeURIComponent(q)}`,
    brave:      q => `https://search.brave.com/api/suggest?q=${encodeURIComponent(q)}`,
    ecosia:     q => `https://ac.ecosia.org/autocomplete?q=${encodeURIComponent(q)}&type=list`,
    yahoo:      q => `https://search.yahoo.com/sugg/gossip/gossip-us-ura/?appid=vs&output=json&command=${encodeURIComponent(q)}`,
};

// Normalise every engine's response format to a plain string[].
function parseSuggestions(engine, json) {
    try {
        if (engine === 'bing') {
            return (json?.AS?.Results?.[0]?.Suggests || []).map(s => s.Txt).filter(Boolean).slice(0, 8);
        }
        if (engine === 'yahoo') {
            return (json?.gossip?.results || []).map(s => s.key).filter(Boolean).slice(0, 8);
        }
        // google / duckduckgo / brave / ecosia → ["query", ["s1","s2",...]]
        return (Array.isArray(json?.[1]) ? json[1] : []).filter(Boolean).slice(0, 8);
    } catch { return []; }
}

async function fetchDirect(engine, q, signal) {
    if (!SUGGEST_ENGINES_DIRECT[engine]) throw new Error('Unknown engine');
    const r = await fetch(SUGGEST_ENGINES_DIRECT[engine](q), {
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; NovaByte/1.0)',
            'Accept':     'application/json, */*;q=0.8',
        },
        signal,
    });
    if (!r.ok) throw new Error(`Direct ${r.status}`);
    return await r.json();
}

const suggestLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { error: 'Too many suggest requests, slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
});

function setupSuggestProxy(app) {
    app.get('/api/suggest', suggestLimiter, async (req, res) => {
        const q      = (req.query.q      || '').trim();
        const engine = (req.query.engine || 'google').toLowerCase();

        if (!q)                                  return res.status(400).json({ error: 'q parameter is required' });
        if (q.length > 200)                      return res.status(400).json({ error: 'Query too long' });
        if (!SUGGEST_ENGINES_DIRECT[engine])     return res.status(400).json({ error: 'Unknown engine' });

        const cacheKey = `${engine}:${q}`;
        const cached   = suggestCache.get(cacheKey);
        if (cached && (Date.now() - cached.ts) < SUGGEST_TTL) {
            res.setHeader('Cache-Control', 'private, max-age=60');
            return res.json({ suggestions: cached.data });
        }

        const controller = new AbortController();
        const timer      = setTimeout(() => controller.abort(), SUGGEST_TIMEOUT);

        let json;
        let usedFallback = false;

        try {
            json = await fetchDirect(engine, q, controller.signal);
        } catch {
            clearTimeout(timer);
            usedFallback = true;
            const fallbackEngines = engine === 'brave' ? ['duckduckgo', 'google'] : ['duckduckgo'];
            const fallback = fallbackEngines.find(e => SUGGEST_ENGINES_DIRECT[e]);
            if (!fallback) {
                return res.status(502).json({ suggestions: [] });
            }
            try {
                json = await fetchDirect(fallback, q, controller.signal);
            } catch {
                return res.status(502).json({ suggestions: [] });
            }
        }

        clearTimeout(timer);

        const suggestions = parseSuggestions(engine, json);

        // Evict oldest entry if at capacity
        if (suggestCache.size >= SUGGEST_MAX) {
            suggestCache.delete(suggestCache.keys().next().value);
        }
        suggestCache.set(cacheKey, { data: suggestions, ts: Date.now() });

        res.setHeader('Cache-Control', 'private, max-age=60');
        res.json({ suggestions });
    });
}
// ── End Search Suggest Proxy ──────────────────────────────────────────────

// ── Email Image Proxy ─────────────────────────────────────────────────────
// Fetches email images through the local server.

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

function isPrivateHostEI(hostname) {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const PRIVATE_EXACT   = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0',
        '[::1]', '[::]']);
    const PRIVATE_PREFIXES = ['10.', '172.16.', '172.17.', '172.18.', '172.19.',
        '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.',
        '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.',
        '192.168.', '169.254.', '100.64.'];
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

    let currentUrl = urlStr;
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

function setupEmailImageProxy(app) {
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

        const cacheKey = urlObj.toString();
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
}
// ── End Email Image Proxy ──────────────────────────────────────────────────

module.exports = {
    setupSuggestProxy,
    setupEmailImageProxy,
};