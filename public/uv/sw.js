/*global UVServiceWorker,__uv$config*/
importScripts('uv.bundle.js');
importScripts('uv.config.js');
importScripts(__uv$config.sw || 'uv.sw.js');

const uv = new UVServiceWorker();

/**
 * Detect and fix the GET-form-submission URL corruption.
 *
 * Problem: Google's <form method="GET" action="/search"> gets rewritten by
 * UV's HTML rewriter to action="/uv/service/XOR_ENCODED_PATH".
 * When the browser submits the form it appends ?q=term raw, giving:
 *   /uv/service/XOR_ENCODED_PATH?q=term
 * UV then tries to XOR-decode "XOR_ENCODED_PATH?q=term" as one string,
 * producing a garbled URL. Google serves a CSS file for that garbage path,
 * UV processes it as destination:"style" (appending sentinel{}), and the
 * browser displays raw CSS as the document.
 *
 * Fix: if decoding the full (path + raw query) doesn't yield a valid URL,
 * decode just the path, append the query params properly, re-encode, redirect.
 */
async function fixFormSubmission(event) {
    const req = event.request;
    const dest = req.destination;
    if (dest !== 'document' && dest !== 'iframe') return null;

    const url = new URL(req.url);
    if (!url.search) return null; // no query string, nothing to fix

    const prefix = __uv$config.prefix;
    // encoded part = everything in pathname after the prefix
    const baseEncoded = url.pathname.slice(prefix.length);
    if (!baseEncoded) return null;

    // 1. Try decoding the full string (path + raw query) — the correctly-encoded case.
    const fullEncoded = baseEncoded + url.search;
    try {
        const decoded = __uv$config.decodeUrl(fullEncoded);
        new URL(decoded); // throws if garbled
        return null; // valid → normal UV processing
    } catch (_) { /* garbled → fall through to fix */ }

    // 2. Decode just the path, merge the query params, re-encode, redirect.
    try {
        const decodedBase = __uv$config.decodeUrl(baseEncoded);
        const target = new URL(decodedBase);
        // Merge the raw ?key=value pairs into the decoded URL
        for (const [k, v] of url.searchParams) {
            target.searchParams.append(k, v);
        }
        const fixed = __uv$config.encodeUrl(target.href);
        console.log('[SW] Fixed GET-form URL:', target.href);
        return Response.redirect(prefix + fixed, 302);
    } catch (e) {
        console.warn('[SW] Could not fix form URL:', e);
        return null;
    }
}

async function handleRequest(event) {
    if (uv.route(event)) {
        const fix = await fixFormSubmission(event);
        if (fix) return fix;
        return await uv.fetch(event);
    }
    return await fetch(event.request);
}

self.addEventListener('fetch', (event) => {
    event.respondWith(handleRequest(event));
});