/**
 * Horizon Browser — CDP Bridge
 * ─────────────────────────────────────────────────────────────────────────────
 * Connects Horizon to your running Brave/Chrome instance via the Chrome
 * DevTools Protocol.  Every URL loads in a REAL browser tab — full cookies,
 * full JS execution, GPU-accelerated rendering — then a JPEG screenshot is
 * streamed back to the Horizon UI.  No iframes, no CORS, no sandbox limits.
 *
 * SETUP
 * ─────
 * 1.  npm install chrome-remote-interface
 * 2.  Launch Brave with the debug port open:
 *       brave-browser --remote-debugging-port=9222
 *     (add --remote-debugging-address=0.0.0.0 if Node is on a different host)
 * 3.  Mount this router in your main server file:
 *       const horizonCDP = require('./horizon-cdp');
 *       app.use('/api/horizon', horizonCDP);
 *
 * FRONTEND
 * ────────
 * See the "Horizon CDP client" block at the bottom of this file (copy into
 * index.html) and replace the navigate() call sites.
 */

'use strict';

const express = require('express');
const CDP     = require('chrome-remote-interface');  // npm install chrome-remote-interface
const rateLimit = require('express-rate-limit');

const router = express.Router();

// ─── Config ──────────────────────────────────────────────────────────────────

const CDP_HOST        = process.env.CDP_HOST  || 'localhost';
const CDP_PORT        = parseInt(process.env.CDP_PORT || '9222', 10);
const PAGE_TIMEOUT_MS = parseInt(process.env.HORIZON_TIMEOUT || '18000', 10);
const SETTLE_MS       = 600;   // extra wait after loadEventFired for SPAs
const SESSION_TTL_MS  = 30 * 60 * 1000;  // auto-close idle sessions after 30 min

const DEFAULT_VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };

// ─── Session store ───────────────────────────────────────────────────────────
// Key  : horizonTabId (string)
// Value: { cdpTabId, client, Page, Input, Emulation, Runtime,
//          url, title, favicon, lastActive }

const sessions = new Map();

// ─── Rate limiter ─────────────────────────────────────────────────────────────

const limiter = rateLimit({
    windowMs: 60_000,
    max: 240,
    message: { error: 'Rate limit hit — slow down a bit.' }
});

// ─── CDP helpers ─────────────────────────────────────────────────────────────

/** Probe whether Brave is reachable on the debug port. */
async function probeCDP() {
    try {
        const targets = await CDP.List({ host: CDP_HOST, port: CDP_PORT });
        return { ok: true, count: targets.length };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/**
 * Return an existing live session or create a fresh one.
 * A "session" = one real tab in Brave, identified by the Horizon tab ID.
 */
async function ensureSession(sessionId, viewport = DEFAULT_VIEWPORT) {
    if (sessions.has(sessionId)) {
        const s = sessions.get(sessionId);
        try {
            // Cheap liveness check
            await s.Page.getNavigationHistory();
            s.lastActive = Date.now();
            return s;
        } catch {
            console.log(`[HorizonCDP] Session ${sessionId} stale — recreating`);
            await _destroySession(sessionId);
        }
    }

    console.log(`[HorizonCDP] Opening new CDP tab for session ${sessionId}`);
    const tab = await CDP.New({ host: CDP_HOST, port: CDP_PORT, url: 'about:blank' });
    const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: tab.id });

    const { Page, Input, Emulation, Runtime, Network } = client;

    await Promise.all([
        Page.enable(),
        Network.enable(),
        Runtime.enable(),
        Emulation.setDeviceMetricsOverride({ ...viewport, mobile: false }),
    ]);

    const session = {
        id: sessionId,
        cdpTabId: tab.id,
        client,
        Page, Input, Emulation, Runtime, Network,
        url: 'about:blank',
        title: '',
        favicon: '',
        lastActive: Date.now(),
    };

    sessions.set(sessionId, session);
    console.log(`[HorizonCDP] Session ready: ${sessionId} → Brave tab ${tab.id}`);
    return session;
}

async function _destroySession(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return;
    sessions.delete(sessionId);
    try { await s.client.close(); } catch {}
    try { await CDP.Close({ host: CDP_HOST, port: CDP_PORT, id: s.cdpTabId }); } catch {}
    console.log(`[HorizonCDP] Session closed: ${sessionId}`);
}

/**
 * Navigate the CDP tab to `url` and wait for loadEventFired (or timeout).
 * Updates session.url immediately; real URL is refreshed after screenshot.
 */
async function navAndWait(session, url) {
    const { Page } = session;
    session.url = url;

    await new Promise((resolve) => {
        const timer = setTimeout(resolve, PAGE_TIMEOUT_MS);
        Page.loadEventFired(() => { clearTimeout(timer); resolve(); });
        Page.navigate({ url }).catch(resolve);  // resolve on nav error too
    });

    // Give SPA frameworks a moment to flush their initial render
    await sleep(SETTLE_MS);
}

/**
 * Capture a JPEG screenshot and refresh session metadata from the live DOM.
 */
async function screenshot(session, quality = 95) {
    const { Page, Runtime } = session;

    // Pull title, href, favicon in one shot
    try {
        const { result } = await Runtime.evaluate({
            expression: `JSON.stringify({
                title:   document.title,
                url:     location.href,
                favicon: (document.querySelector('link[rel~="icon"],link[rel="shortcut icon"]') || {}).href
                         || location.origin + '/favicon.ico'
            })`,
            returnByValue: true,
        });
        const info = JSON.parse(result.value || '{}');
        if (info.title)  session.title   = info.title;
        if (info.url)    session.url      = info.url;
        if (info.favicon) session.favicon = info.favicon;
    } catch { /* non-critical */ }

    const { data } = await Page.captureScreenshot({ format: 'jpeg', quality });
    session.lastActive = Date.now();
    return Buffer.from(data, 'base64');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Write the standard Horizon headers onto an Express response. */
function writeHorizonHeaders(res, session) {
    res.setHeader('Content-Type',       'image/jpeg');
    res.setHeader('Cache-Control',      'no-store');
    res.setHeader('X-Horizon-URL',      encodeURIComponent(session.url));
    res.setHeader('X-Horizon-Title',    encodeURIComponent(session.title));
    res.setHeader('X-Horizon-Favicon',  encodeURIComponent(session.favicon));
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /api/horizon/status
 * Returns whether Brave is reachable and how many open sessions exist.
 */
router.get('/status', async (_req, res) => {
    const probe = await probeCDP();
    if (!probe.ok) {
        return res.json({
            available: false,
            sessions:  sessions.size,
            error:     probe.error,
            fix:       `Start Brave with:  brave-browser --remote-debugging-port=${CDP_PORT}`,
        });
    }
    res.json({ available: true, braveTabs: probe.count, sessions: sessions.size });
});

/**
 * GET /api/horizon/navigate?session=<id>&url=<url>[&width=<px>&height=<px>]
 *
 * Opens (or reuses) a real Brave tab, navigates to the URL, waits for load,
 * and returns a JPEG screenshot.  Response headers carry the resolved URL,
 * page title, and favicon so the UI can update without a second round-trip.
 */
router.get('/navigate', limiter, async (req, res) => {
    let { session: sid, url, width, height } = req.query;

    if (!sid || !url) {
        return res.status(400).json({ error: '`session` and `url` are required' });
    }

    // Validate
    try {
        const u = new URL(url);
        if (!['http:', 'https:'].includes(u.protocol)) {
            return res.status(400).json({ error: 'Only http/https URLs are supported' });
        }
    } catch {
        return res.status(400).json({ error: 'Invalid URL' });
    }

    const vp = {
        width:             Math.max(320, Math.min(3840, parseInt(width  || DEFAULT_VIEWPORT.width,  10))),
        height:            Math.max(200, Math.min(2160, parseInt(height || DEFAULT_VIEWPORT.height, 10))),
        deviceScaleFactor: 1,
    };

    try {
        const session = await ensureSession(sid, vp);

        // Resize viewport if the Horizon pane was resized
        await session.Emulation.setDeviceMetricsOverride({ ...vp, mobile: false });

        await navAndWait(session, url);

        const img = await screenshot(session);
        writeHorizonHeaders(res, session);
        return res.send(img);

    } catch (err) {
        console.error('[HorizonCDP] /navigate error:', err.message);
        
        // Graceful error image would be nice; for now return JSON
        return res.status(502).json({
            error: err.message,
            fix: err.message.includes('connect') || err.message.includes('ECONNREFUSED')
                ? `Brave not found on port ${CDP_PORT}.  Start it with --remote-debugging-port=${CDP_PORT}`
                : undefined,
        });
    }
});

/**
 * POST /api/horizon/interact
 * Body (JSON):
 *   { session, type, x?, y?, deltaX?, deltaY?, key?, text?, modifiers? }
 *
 * type values:
 *   "click"   – left-click at (x, y)  [coordinates in VIEWPORT space]
 *   "dblclick"– double-click at (x, y)
 *   "scroll"  – wheel scroll at (x, y) by (deltaX, deltaY) pixels
 *   "keydown" – press & release a key  (key = KeyboardEvent.key value)
 *   "type"    – type a string character by character  (text = string)
 *   "hover"   – move mouse to (x, y) — triggers :hover CSS
 *   "back"    – browser back
 *   "forward" – browser forward
 *   "reload"  – full reload
 *
 * Returns a fresh JPEG screenshot with the same X-Horizon-* headers.
 */
router.post('/interact', limiter, async (req, res) => {
    const {
        session: sid,
        type,
        x = 0, y = 0,
        deltaX = 0, deltaY = 300,
        key, text,
        modifiers = 0,
    } = req.body || {};

    if (!sid) return res.status(400).json({ error: '`session` is required' });

    const session = sessions.get(sid);
    if (!session) {
        return res.status(404).json({ error: 'Session not found.  Call /navigate first.' });
    }

    session.lastActive = Date.now();
    const { Input, Page } = session;

    try {
        switch (type) {
            case 'click':
                await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers });
                await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers });
                await sleep(900);   // wait for any triggered navigation
                break;

            case 'dblclick':
                for (let i = 1; i <= 2; i++) {
                    await Input.dispatchMouseEvent({ type: 'mousePressed',  x, y, button: 'left', clickCount: i, modifiers });
                    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: i, modifiers });
                    await sleep(60);
                }
                await sleep(600);
                break;

            case 'scroll':
                await Input.dispatchMouseEvent({ type: 'mouseWheel', x, y, deltaX, deltaY });
                await sleep(250);
                break;

            case 'keydown':
                if (!key) return res.status(400).json({ error: '`key` required for keydown' });
                await Input.dispatchKeyEvent({ type: 'keyDown', key, text: text || '', modifiers });
                await Input.dispatchKeyEvent({ type: 'keyUp',   key, modifiers });
                await sleep(150);
                break;

            case 'type':
                if (!text) return res.status(400).json({ error: '`text` required for type' });
                for (const ch of text) {
                    await Input.dispatchKeyEvent({ type: 'char', text: ch });
                    await sleep(25);
                }
                break;

            case 'hover':
                await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
                await sleep(200);
                break;

            case 'back':
                await Page.goBack();
                await sleep(PAGE_TIMEOUT_MS / 4);
                break;

            case 'forward':
                await Page.goForward();
                await sleep(PAGE_TIMEOUT_MS / 4);
                break;

            case 'reload':
                await Page.reload({ ignoreCache: false });
                await new Promise((resolve) => {
                    const t = setTimeout(resolve, PAGE_TIMEOUT_MS);
                    Page.loadEventFired(() => { clearTimeout(t); resolve(); });
                });
                await sleep(SETTLE_MS);
                break;

            default:
                return res.status(400).json({ error: `Unknown interaction type: "${type}"` });
        }

        const img = await screenshot(session);
        writeHorizonHeaders(res, session);
        return res.send(img);

    } catch (err) {
        console.error('[HorizonCDP] /interact error:', err.message);
        return res.status(502).json({ error: err.message });
    }
});

/**
 * POST /api/horizon/close
 * Body: { session }
 * Closes the real Brave tab and frees the session.
 */
router.post('/close', async (req, res) => {
    const { session: sid } = req.body || {};
    if (!sid) return res.status(400).json({ error: '`session` required' });
    await _destroySession(sid);
    res.json({ ok: true });
});

/**
 * GET /api/horizon/screenshot?session=<id>[&quality=<0-100>]
 * Take a fresh screenshot of an existing session without navigating.
 */
router.get('/screenshot', limiter, async (req, res) => {
    const { session: sid, quality } = req.query;
    if (!sid) return res.status(400).json({ error: '`session` required' });

    const session = sessions.get(sid);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    try {
        const img = await screenshot(session, parseInt(quality || '82', 10));
        writeHorizonHeaders(res, session);
        return res.send(img);
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
});

// ─── Idle session GC ─────────────────────────────────────────────────────────

setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, s] of sessions) {
        if (s.lastActive < cutoff) {
            console.log(`[HorizonCDP] GC: closing idle session ${id}`);
            _destroySession(id);
        }
    }
}, 5 * 60_000);

module.exports = router;


/* ═══════════════════════════════════════════════════════════════════════════
   FRONTEND PATCH  —  paste into index.html to replace the iframe approach
   ═══════════════════════════════════════════════════════════════════════════

Replace the entire `navigate()` function body (around line 11730) with:

─────────────────────────────────────────────────────────────────────────────

    let _cdpAvailable = null;   // null=unknown, true/false after first check

    async function checkCDP() {
        if (_cdpAvailable !== null) return _cdpAvailable;
        try {
            const r = await fetch('/api/horizon/status');
            const d = await r.json();
            _cdpAvailable = d.available;
        } catch { _cdpAvailable = false; }
        return _cdpAvailable;
    }

    // Track blob URLs so we can revoke them and avoid memory leaks
    const _blobUrls = new Map();  // tabId → blobUrl

    async function navigate(url) {
        if (!url) return;

        // ── 1. Fix / classify the URL ──────────────────────────────────────
        if (!url.match(/^https?:\/\//)) {
            if (url.includes('.') && !url.includes(' ')) {
                url = 'https://' + url;
            } else {
                const _dnsSuffix = OS.settings.get('dnsSuffix');
                if (_dnsSuffix && !url.includes(' ') && !url.includes('.')) {
                    url = 'https://' + url + '.' + _dnsSuffix;
                } else {
                    url = getSearchUrl(url);
                }
            }
        }

        currentUrl = url;
        urlBar.value = url;
        browsingHistory.push(url);
        histIdx = browsingHistory.length - 1;

        const activeTab = tabs.find(t => t.id === activeTabId);
        if (activeTab) {
            activeTab.url = url;
            try {
                const u = new URL(url);
                activeTab.title   = u.hostname;
                activeTab.favicon = u.origin + '/favicon.ico';
            } catch {}
            activeTab.lastActive = Date.now();
        }
        renderTabs();

        // ── 2. Loading spinner ─────────────────────────────────────────────
        viewport.innerHTML = '';
        const loading = createEl('div', {
            className: 'flex-center',
            style: { height: '100%', background: 'var(--bg-base)' }
        });
        loading.innerHTML = `<div class="boot-hex-spinner"></div>`;
        viewport.appendChild(loading);

        // ── 3. Decide rendering path ───────────────────────────────────────
        const useCDP = await checkCDP();

        if (useCDP) {
            await _navigateCDP(url, activeTab);
        } else {
            // Fallback: original iframe/proxy approach
            await _navigateIframe(url, activeTab);
        }
    }

    // ── CDP rendering path ────────────────────────────────────────────────────

    async function _navigateCDP(url, activeTab) {
        const sessionId = String(activeTabId);
        const { width, height } = viewport.getBoundingClientRect();

        try {
            const resp = await fetch(
                `/api/horizon/navigate?session=${encodeURIComponent(sessionId)}`
                + `&url=${encodeURIComponent(url)}`
                + `&width=${Math.round(width) || 1280}`
                + `&height=${Math.round(height) || 800}`
            );

            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ error: resp.statusText }));
                throw new Error(err.error || resp.statusText);
            }

            const blob    = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);

            // Revoke previous blob for this tab
            if (_blobUrls.has(activeTabId)) {
                URL.revokeObjectURL(_blobUrls.get(activeTabId));
            }
            _blobUrls.set(activeTabId, blobUrl);

            // Update tab metadata from response headers
            const newUrl    = _decHdr(resp.headers.get('X-Horizon-URL'))    || url;
            const newTitle  = _decHdr(resp.headers.get('X-Horizon-Title'))  || '';
            const newFavicon= _decHdr(resp.headers.get('X-Horizon-Favicon'))|| '';

            currentUrl = newUrl;
            urlBar.value = newUrl;
            if (activeTab) {
                activeTab.url    = newUrl;
                activeTab.title  = newTitle || new URL(newUrl).hostname;
                activeTab.favicon= newFavicon;
            }
            renderTabs();

            // ── Build the interactive screenshot view ──────────────────────
            viewport.innerHTML = '';
            const img = createEl('img', {
                style: {
                    width: '100%', height: '100%',
                    objectFit: 'fill',
                    display: 'block',
                    cursor: 'default',
                    userSelect: 'none',
                    WebkitUserDrag: 'none',
                }
            });
            img.src = blobUrl;

            // ── Click → forward to CDP tab ─────────────────────────────────
            img.addEventListener('click', async (e) => {
                const rect = img.getBoundingClientRect();
                const scaleX = (Math.round(width) || 1280) / rect.width;
                const scaleY = (Math.round(height) || 800)  / rect.height;
                const cx = Math.round((e.clientX - rect.left) * scaleX);
                const cy = Math.round((e.clientY - rect.top)  * scaleY);
                await _cdpInteract({ type: 'click', x: cx, y: cy }, img, activeTabId);
            });

            // ── Double-click ───────────────────────────────────────────────
            img.addEventListener('dblclick', async (e) => {
                e.preventDefault();
                const rect = img.getBoundingClientRect();
                const scaleX = (Math.round(width) || 1280) / rect.width;
                const scaleY = (Math.round(height) || 800)  / rect.height;
                const cx = Math.round((e.clientX - rect.left) * scaleX);
                const cy = Math.round((e.clientY - rect.top)  * scaleY);
                await _cdpInteract({ type: 'dblclick', x: cx, y: cy }, img, activeTabId);
            });

            // ── Scroll ─────────────────────────────────────────────────────
            img.addEventListener('wheel', async (e) => {
                e.preventDefault();
                await _cdpInteract({ type: 'scroll', deltaY: e.deltaY, deltaX: e.deltaX }, img, activeTabId);
            }, { passive: false });

            // ── Keyboard (when viewport focused) ──────────────────────────
            img.setAttribute('tabindex', '0');
            img.addEventListener('keydown', async (e) => {
                e.preventDefault();
                const mods = (e.shiftKey ? 8 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 1 : 0) | (e.metaKey ? 4 : 0);
                if (e.key.length === 1) {
                    await _cdpInteract({ type: 'type', text: e.key }, img, activeTabId);
                } else {
                    await _cdpInteract({ type: 'keydown', key: e.key, modifiers: mods }, img, activeTabId);
                }
            });

            if (activeTab) activeTab.imgEl = img;
            viewport.appendChild(img);
            img.focus();

        } catch (err) {
            console.error('[Horizon] CDP navigate failed:', err.message);
            _showError(err.message);
            // Fallback to iframe mode
            _cdpAvailable = false;
            await _navigateIframe(url, activeTab);
        }
    }

    async function _cdpInteract(data, img, tabId) {
        const sessionId = String(tabId);
        try {
            const resp = await fetch('/api/horizon/interact', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ session: sessionId, ...data }),
            });
            if (!resp.ok) return;

            const blob    = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);

            // Revoke old blob
            if (_blobUrls.has(tabId)) URL.revokeObjectURL(_blobUrls.get(tabId));
            _blobUrls.set(tabId, blobUrl);
            img.src = blobUrl;

            // Check if the page navigated (e.g. link click)
            const newUrl   = _decHdr(resp.headers.get('X-Horizon-URL'));
            const newTitle = _decHdr(resp.headers.get('X-Horizon-Title'));
            if (newUrl && newUrl !== currentUrl) {
                currentUrl  = newUrl;
                urlBar.value = newUrl;
                browsingHistory.push(newUrl);
                histIdx = browsingHistory.length - 1;
                const t = tabs.find(t => t.id === tabId);
                if (t) { t.url = newUrl; t.title = newTitle || new URL(newUrl).hostname; }
                renderTabs();
            }
        } catch (err) {
            console.warn('[Horizon] CDP interact error:', err.message);
        }
    }

    // Safely decode a percent-encoded response header value
    function _decHdr(val) {
        if (!val) return '';
        try { return decodeURIComponent(val); } catch { return val; }
    }

    function _showError(msg) {
        viewport.innerHTML = '';
        const err = createEl('div', { className: 'empty-state', style: { padding: '40px', background: 'var(--bg-base)' } });
        err.innerHTML = svgIcon('alert-triangle', 48) +
            `<div style="margin-top:12px;color:var(--text-secondary);max-width:420px">${msg}</div>`;
        viewport.appendChild(err);
    }

    // ── Original iframe fallback (keep as-is from your existing code) ─────────

    async function _navigateIframe(url, activeTab) {
        // ... keep your original iframe/proxy logic here unchanged ...
        // This path fires automatically if CDP isn't available.
    }

─────────────────────────────────────────────────────────────────────────────

Also wire up the CDP back/forward/reload actions in your toolbar buttons:

    // Back button
    btnBack.addEventListener('click', async () => {
        if (await checkCDP()) {
            await _cdpInteract({ type: 'back' },
                viewport.querySelector('img'), activeTabId);
        } else { ... existing back logic ... }
    });

    // Forward button
    btnFwd.addEventListener('click', async () => {
        if (await checkCDP()) {
            await _cdpInteract({ type: 'forward' },
                viewport.querySelector('img'), activeTabId);
        }
    });

    // Reload button
    btnReload.addEventListener('click', async () => {
        if (await checkCDP()) {
            await _cdpInteract({ type: 'reload' },
                viewport.querySelector('img'), activeTabId);
        }
    });

    // Close-tab handler — free the Brave tab too
    function closeTab(tabId) {
        // ... your existing close-tab logic ...
        fetch('/api/horizon/close', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session: String(tabId) })
        }).catch(() => {});
    }

═══════════════════════════════════════════════════════════════════════════ */
