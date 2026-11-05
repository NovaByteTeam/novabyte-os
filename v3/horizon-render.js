/**
 * Horizon Render — Full Rewriting Web Proxy
 * ============================================
 * Instead of just slapping a <base> tag on HTML and hoping for the best,
 * this module does a proper job:
 *
 *   1. Strips X-Frame-Options and CSP frame-ancestors so iframes load
 *   2. Rewrites every URL in HTML (src, href, action, srcset, poster, etc.)
 *   3. Rewrites CSS url() references
 *   4. Injects a JS runtime shim into every HTML page that:
 *        - Intercepts fetch() and XMLHttpRequest
 *        - Intercepts link clicks and form submits
 *        - Intercepts history.pushState / replaceState
 *        - Kills frame-busting by overriding window.top / window.parent
 *   5. Handles redirects by rewriting Location headers through the proxy
 *   6. Passes binary content (images, fonts, video) straight through
 */

'use strict';

const http  = require('http');
const https = require('https');
const zlib  = require('zlib');

/* ─── Constants ────────────────────────────────────────────────────────────── */

const PROXY_PATH   = '/api/horizon/render?url=';
const MAX_BODY_SIZE = 12 * 1024 * 1024; // 12 MB max response body

// Headers from the target we always strip before forwarding
const STRIP_RESPONSE_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'strict-transport-security',
  'public-key-pins',
  'public-key-pins-report-only',
  'transfer-encoding',   // we re-encode ourselves
  'content-encoding',    // we decompress then re-serve
  'connection',
  'keep-alive',
  'upgrade',
]);

/* ─── URL Helpers ───────────────────────────────────────────────────────────── */

/**
 * Turn any URL (possibly relative) into a fully proxied absolute URL.
 * Skips data:, blob:, #anchors, javascript:, mailto:, tel:
 */
function toProxyUrl(url, baseUrl, origin) {
  if (!url || typeof url !== 'string') return url;
  const trimmed = url.trim();
  if (!trimmed) return url;

  const skip = ['data:', 'blob:', '#', 'javascript:', 'mailto:', 'tel:', 'about:'];
  if (skip.some(p => trimmed.startsWith(p))) return url;

  // Already proxied through us
  const alreadyProxied = origin + PROXY_PATH;
  if (trimmed.startsWith(alreadyProxied)) return url;

  try {
    const abs = new URL(trimmed, baseUrl).toString();
    return origin + PROXY_PATH + encodeURIComponent(abs);
  } catch {
    return url;
  }
}

/* ─── CSS Rewriting ─────────────────────────────────────────────────────────── */

function rewriteCss(css, baseUrl, origin) {
  if (!css) return css;
  // Rewrite url('...') and url("...") and url(...)
  return css.replace(/url\(\s*(["']?)([^"')\s]+)\1\s*\)/gi, (match, quote, url) => {
    if (url.startsWith('data:') || url.startsWith('#')) return match;
    const proxied = toProxyUrl(url, baseUrl, origin);
    return `url(${quote}${proxied}${quote})`;
  });
}

/* ─── HTML Rewriting ────────────────────────────────────────────────────────── */

/**
 * Attributes that contain URLs and should be rewritten.
 * We handle both quoted and unquoted (though unquoted is rare in practice).
 */
const URL_ATTRS = [
  'src', 'href', 'action', 'poster', 'data-src', 'data-href',
  'data-url', 'data-original', 'data-lazy', 'content',
];

function rewriteHtml(html, baseUrl, origin) {
  if (!html) return html;

  const proxyFn = (url) => toProxyUrl(url, baseUrl, origin);

  // ── 1. Inject our JS shim right before </head> (or at start of <body> fallback) ──
  const shim = buildJsShim(baseUrl, origin);

  if (html.includes('</head>')) {
    html = html.replace('</head>', shim + '\n</head>');
  } else if (html.includes('<body')) {
    html = html.replace(/<body([^>]*)>/i, (m) => m + '\n' + shim);
  } else {
    html = shim + '\n' + html;
  }

  // ── 2. Remove existing <base> tags (they'd override our rewriting) ──
  html = html.replace(/<base[^>]*>/gi, '');

  // ── 3. Rewrite URL attributes (double-quoted) ──
  const doubleQuoteAttrRe = new RegExp(
    `\\b(${URL_ATTRS.join('|')})\\s*=\\s*"([^"]*)"`,
    'gi'
  );
  html = html.replace(doubleQuoteAttrRe, (match, attr, url) => {
    // Don't rewrite fragment-only or javascript: hrefs
    const lower = attr.toLowerCase();
    if ((lower === 'href' || lower === 'action') &&
        (url.startsWith('#') || url.startsWith('javascript:') || url.startsWith('mailto:'))) {
      return match;
    }
    // <meta http-equiv="refresh"> content — leave alone
    if (lower === 'content' && !match.includes('http')) return match;
    return `${attr}="${proxyFn(url)}"`;
  });

  // ── 4. Rewrite URL attributes (single-quoted) ──
  const singleQuoteAttrRe = new RegExp(
    `\\b(${URL_ATTRS.join('|')})\\s*=\\s*'([^']*)'`,
    'gi'
  );
  html = html.replace(singleQuoteAttrRe, (match, attr, url) => {
    const lower = attr.toLowerCase();
    if ((lower === 'href' || lower === 'action') &&
        (url.startsWith('#') || url.startsWith('javascript:') || url.startsWith('mailto:'))) {
      return match;
    }
    if (lower === 'content' && !match.includes('http')) return match;
    return `${attr}='${proxyFn(url)}'`;
  });

  // ── 5. Rewrite srcset (comma-separated url descriptor pairs) ──
  html = html.replace(/\bsrcset\s*=\s*"([^"]*)"/gi, (match, srcset) => {
    const rewritten = srcset.split(',').map(part => {
      const pieces = part.trim().split(/\s+/);
      if (pieces[0]) pieces[0] = proxyFn(pieces[0]);
      return pieces.join(' ');
    }).join(', ');
    return `srcset="${rewritten}"`;
  });

  // ── 6. Rewrite CSS inside <style> tags ──
  html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, open, css, close) => {
    return open + rewriteCss(css, baseUrl, origin) + close;
  });

  // ── 7. Rewrite inline style attributes ──
  html = html.replace(/\bstyle\s*=\s*"([^"]*)"/gi, (match, style) => {
    return `style="${rewriteCss(style, baseUrl, origin)}"`;
  });
  html = html.replace(/\bstyle\s*=\s*'([^']*)'/gi, (match, style) => {
    return `style='${rewriteCss(style, baseUrl, origin)}'`;
  });

  return html;
}

/* ─── JS Shim ────────────────────────────────────────────────────────────────── */

/**
 * A small but powerful script injected into every proxied HTML page.
 * It intercepts all the ways a webpage might try to load external content
 * or navigate away, and routes everything back through our proxy.
 *
 * Also kills the two most common frame-busting patterns.
 */
function buildJsShim(baseUrl, origin) {
  return `<script data-horizon-shim="1">
(function() {
  'use strict';
  var PROXY  = ${JSON.stringify(origin + PROXY_PATH)};
  var BASE   = ${JSON.stringify(baseUrl)};

  /* ── Kill frame-busting ─────────────────────────────────────── */
  try {
    // Pattern 1: if (window !== window.top) window.top.location = ...
    Object.defineProperty(window, 'top',    { get: function() { return window; }, configurable: true });
    Object.defineProperty(window, 'parent', { get: function() { return window; }, configurable: true });
    Object.defineProperty(window, 'frameElement', { get: function() { return null; }, configurable: true });
  } catch(e) {}

  /* ── URL → proxy URL ────────────────────────────────────────── */
  function p(url) {
    if (!url || typeof url !== 'string') return url;
    var u = url.trim();
    if (!u) return url;
    var skip = ['data:', 'blob:', '#', 'javascript:', 'mailto:', 'tel:', 'about:'];
    for (var i = 0; i < skip.length; i++) { if (u.indexOf(skip[i]) === 0) return url; }
    if (u.indexOf(PROXY) === 0) return url;          // already proxied
    try { return PROXY + encodeURIComponent(new URL(u, BASE).toString()); }
    catch(e) { return url; }
  }

  /* ── Intercept fetch() ──────────────────────────────────────── */
  if (window.fetch) {
    var _fetch = window.fetch.bind(window);
    window.fetch = function(resource, init) {
      try {
        if (typeof resource === 'string') resource = p(resource);
        else if (resource && resource.url) resource = new Request(p(resource.url), { method: resource.method, headers: resource.headers, body: resource.body, mode: 'cors', credentials: 'omit' });
      } catch(e) {}
      return _fetch(resource, init);
    };
  }

  /* ── Intercept XMLHttpRequest ───────────────────────────────── */
  var _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, async, user, pass) {
    try { url = p(String(url)); } catch(e) {}
    return _xhrOpen.call(this, method, url, async !== false, user, pass);
  };

  /* ── Intercept link clicks ──────────────────────────────────── */
  document.addEventListener('click', function(e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#' || href.indexOf('javascript:') === 0) return;
    e.preventDefault();
    e.stopPropagation();
    window.location.href = p(href);
  }, true);

  /* ── Intercept form submits ─────────────────────────────────── */
  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (!form || !form.getAttribute) return;
    var action = form.getAttribute('action');
    if (action && action.charAt(0) !== '#' && action.indexOf('javascript:') !== 0) {
      form.setAttribute('action', p(action));
    }
  }, true);

  /* ── Intercept window.open ──────────────────────────────────── */
  var _open = window.open;
  window.open = function(url, target, features) {
    try { url = p(url); } catch(e) {}
    return _open ? _open.call(window, url, target, features) : null;
  };

  /* ── Intercept history API ──────────────────────────────────── */
  if (history.pushState) {
    var _push = history.pushState;
    history.pushState = function(state, title, url) {
      try { if (url) url = p(String(url)); } catch(e) {}
      return _push.call(history, state, title, url);
    };
  }
  if (history.replaceState) {
    var _replace = history.replaceState;
    history.replaceState = function(state, title, url) {
      try { if (url) url = p(String(url)); } catch(e) {}
      return _replace.call(history, state, title, url);
    };
  }

  /* ── WebSocket proxy hint ───────────────────────────────────── */
  // Real WS proxying requires a separate server-side tunnel.
  // We suppress errors from pages that try to open raw WS connections
  // to external hosts (they'll fail silently rather than throwing).
  var _WS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    // If it's a relative WS URL, let it through unchanged
    if (url && (url.indexOf('ws://') === 0 || url.indexOf('wss://') === 0)) {
      // External WS — will fail cross-origin but won't crash the page
      console.warn('[Horizon] WebSocket to external host blocked:', url);
      // Return a fake closed socket to prevent uncaught errors
      var fake = { readyState: 3, close: function(){}, send: function(){},
                   addEventListener: function(){}, removeEventListener: function(){} };
      return fake;
    }
    return _WS ? new _WS(url, protocols) : null;
  };

  /* ── Mark as Horizon proxied ────────────────────────────────── */
  window.__horizonProxy = true;
  window.__horizonBase  = BASE;

})();
</script>`;
}

/* ─── Fetch Target URL (with redirect following) ────────────────────────────── */

function fetchTarget(urlString, reqHeaders) {
  return new Promise((resolve, reject) => {
    const MAX_REDIRECTS = 8;
    let redirects = 0;
    let currentUrl = urlString;

    function doRequest(urlStr) {
      let parsed;
      try { parsed = new URL(urlStr); }
      catch(e) { return reject(new Error('Invalid URL: ' + urlStr)); }

      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options = {
        hostname : parsed.hostname,
        port     : parsed.port || (isHttps ? 443 : 80),
        path     : parsed.pathname + (parsed.search || ''),
        method   : 'GET',
        headers  : {
          'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control'  : 'no-cache',
          'Pragma'         : 'no-cache',
          'Sec-Fetch-Dest' : 'document',
          'Sec-Fetch-Mode' : 'navigate',
          'Sec-Fetch-Site' : 'none',
          'Upgrade-Insecure-Requests': '1',
        },
        timeout: 18000,
      };

      // Forward cookie header from client if present (helps with session continuity)
      if (reqHeaders && reqHeaders['cookie']) {
        options.headers['Cookie'] = reqHeaders['cookie'];
      }

      const req = lib.request(options, (res) => {
        // Follow redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (++redirects > MAX_REDIRECTS) {
            return reject(new Error('Too many redirects'));
          }
          // Resolve potentially relative redirect URL
          let location = res.headers.location;
          try { location = new URL(location, currentUrl).toString(); } catch {}
          currentUrl = location;
          res.resume(); // drain
          return doRequest(location);
        }

        // Collect compressed body
        const chunks = [];
        let totalSize = 0;

        const onData = (chunk) => {
          totalSize += chunk.length;
          if (totalSize > MAX_BODY_SIZE) {
            res.destroy();
            return reject(new Error('Response body too large'));
          }
          chunks.push(chunk);
        };
        const onEnd = () => {
          const raw = Buffer.concat(chunks);
          const encoding = (res.headers['content-encoding'] || '').toLowerCase();

          let decompress;
          if (encoding === 'gzip')   decompress = zlib.gunzip;
          else if (encoding === 'deflate') decompress = zlib.inflate;
          else if (encoding === 'br') decompress = zlib.brotliDecompress;

          if (decompress) {
            decompress(raw, (err, result) => {
              if (err) return resolve({ status: res.statusCode, headers: res.headers, body: raw, finalUrl: currentUrl });
              resolve({ status: res.statusCode, headers: res.headers, body: result, finalUrl: currentUrl });
            });
          } else {
            resolve({ status: res.statusCode, headers: res.headers, body: raw, finalUrl: currentUrl });
          }
        };

        const onErr = (err) => reject(err);
        res.on('data', onData).on('end', onEnd).on('error', onErr);
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
      req.end();
    }

    doRequest(currentUrl);
  });
}

/* ─── Request Handler ─────────────────────────────────────────────────────── */

async function handleRender(req, res) {
  let { url } = req.query;

  // Decode if double-encoded
  try { url = decodeURIComponent(url); } catch {}
  url = (url || '').replace(/&#x2F;/gi,'/').replace(/&#x3A;/gi,':').replace(/&amp;/gi,'&');

  if (!url) {
    return res.status(400).json({ error: 'url parameter is required' });
  }

  // Validate
  let targetUrl;
  try {
    targetUrl = new URL(url);
    if (!['http:', 'https:'].includes(targetUrl.protocol)) {
      return res.status(400).json({ error: 'Only http/https URLs are allowed' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Determine our server origin (for building proxy URLs in the shim)
  const serverOrigin = `${req.protocol}://${req.get('host')}`;

  try {
    console.log('[HorizonRender] Fetching:', targetUrl.toString());
    const result = await fetchTarget(targetUrl.toString(), req.headers);
    console.log('[HorizonRender] Status:', result.status, '| Final URL:', result.finalUrl);

    // ── Build clean response headers ──────────────────────────────────────────
    const forwardHeaders = {};
    for (const [key, value] of Object.entries(result.headers)) {
      if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
        forwardHeaders[key] = value;
      }
    }

    // Always set permissive CORS + framing headers
    forwardHeaders['Access-Control-Allow-Origin']  = '*';
    forwardHeaders['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    forwardHeaders['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    // Deliberately do NOT set X-Frame-Options or CSP frame-ancestors

    // Permissive CSP for the proxied content (it can load whatever it needs)
    forwardHeaders['Content-Security-Policy'] =
      "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;";

    const contentType = (result.headers['content-type'] || '').toLowerCase();

    // ── HTML: rewrite + inject shim ──────────────────────────────────────────
    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      let body = result.body.toString('utf8');

      // Rewrite all URLs
      body = rewriteHtml(body, result.finalUrl, serverOrigin);

      forwardHeaders['Content-Type']   = 'text/html; charset=utf-8';
      forwardHeaders['Content-Length'] = Buffer.byteLength(body, 'utf8').toString();
      // Tell Horizon what the final URL was (after any redirects)
      forwardHeaders['X-Horizon-Final-URL'] = encodeURIComponent(result.finalUrl);

      res.status(result.status);
      for (const [k, v] of Object.entries(forwardHeaders)) res.setHeader(k, v);
      return res.end(body, 'utf8');
    }

    // ── CSS: rewrite url() references ──────────────────────────────────────
    if (contentType.includes('text/css')) {
      let css = result.body.toString('utf8');
      css = rewriteCss(css, targetUrl.toString(), serverOrigin);

      forwardHeaders['Content-Type']   = 'text/css; charset=utf-8';
      forwardHeaders['Content-Length'] = Buffer.byteLength(css, 'utf8').toString();

      res.status(result.status);
      for (const [k, v] of Object.entries(forwardHeaders)) res.setHeader(k, v);
      return res.end(css, 'utf8');
    }

    // ── JavaScript: pass through (URL rewriting in JS is too complex without a real parser) ──
    if (contentType.includes('javascript') || contentType.includes('ecmascript')) {
      forwardHeaders['Content-Type']   = contentType || 'application/javascript';
      forwardHeaders['Content-Length'] = result.body.length.toString();

      res.status(result.status);
      for (const [k, v] of Object.entries(forwardHeaders)) res.setHeader(k, v);
      return res.end(result.body);
    }

    // ── Everything else (images, fonts, video, JSON, etc.) ─────────────────
    forwardHeaders['Content-Type']   = contentType || 'application/octet-stream';
    forwardHeaders['Content-Length'] = result.body.length.toString();

    res.status(result.status);
    for (const [k, v] of Object.entries(forwardHeaders)) res.setHeader(k, v);
    return res.end(result.body);

  } catch (err) {
    console.error('[HorizonRender] Error:', err.message);

    // Return a friendly error HTML page instead of JSON
    // (the iframe is expecting HTML)
    const errorPage = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: system-ui, sans-serif; background: #0d0f18; color: #e6edf3;
         display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .box { text-align: center; max-width: 500px; padding: 32px; }
  h2 { font-size: 20px; font-weight: 600; margin-bottom: 12px; color: #f85149; }
  p  { font-size: 13px; color: #8b949e; line-height: 1.65; }
  code { background: rgba(255,255,255,0.08); padding: 2px 7px; border-radius: 4px; font-size: 12px; }
</style>
</head><body>
<div class="box">
  <h2>⚠ Horizon couldn't load this page</h2>
  <p>${escapeHtml(err.message)}</p>
  <p>This site may be offline, blocking automated requests, or behind authentication.
     If Brave/Chrome CDP is running, it will be used automatically instead.</p>
  <p><code>${escapeHtml(url)}</code></p>
</div>
</body></html>`;

    res.status(502);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(errorPage);
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { handleRender, rewriteHtml, rewriteCss, toProxyUrl, PROXY_PATH };
