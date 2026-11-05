'use strict';

const path = require('path');
const express = require('express');

let _bareServer = null;

/**
 * uvStaticRouter(app)
 * Call EARLY (before API routes). Registers:
 *  1. Catch-all middleware to intercept /bare/ before any route/404 handler
 *  2. /uv/ static file serving
 */
function uvStaticRouter(app) {

    // ── Bare HTTP intercept — registered FIRST so it beats every other route ─
    // Top-level (no path prefix), so req.url is the full path.
    // shouldRoute() checks req.url against /bare/ prefix internally.
    app.use((req, res, next) => {
        if (_bareServer && _bareServer.shouldRoute(req)) {
            _bareServer.routeRequest(req, res);
        } else {
            next();
        }
    });

    // ── UV static assets ─────────────────────────────────────────────────────
    const uvPublicDir = path.join(__dirname, 'public', 'uv');
    app.use('/uv', express.static(uvPublicDir, {
        setHeaders(res, filePath) {
            if (filePath.endsWith('sw.js') && !filePath.includes('baremux')) {
                res.setHeader('Service-Worker-Allowed', '/uv/');
                res.setHeader('Cache-Control', 'no-store');
            }
            if (filePath.endsWith('baremux-worker.js')) {
                res.setHeader('Cache-Control', 'no-store');
            }
            if (filePath.endsWith('baremux-transport.js') || filePath.endsWith('bare-mux.js')) {
                res.setHeader('Cache-Control', 'no-store');
                res.setHeader('Content-Type', 'application/javascript');
            }
            res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
            res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
        }
    }));

    app.get('/api/uv/status', (_req, res) => {
        res.json({ available: _bareServer !== null, bare: '/bare/', prefix: '/uv/service/' });
    });

    console.log('[UV] Static files served from /uv/');
}

/**
 * createBare(httpServer)
 * Call AFTER server is created (near server.listen).
 * Sets _bareServer so the middleware above can use it, and attaches WS handler.
 */
function createBare(httpServer) {
    try {
        const { createBareServer } = require('@tomphttp/bare-server-node');
        _bareServer = createBareServer('/bare/');

        httpServer.on('upgrade', (req, socket, head) => {
            if (_bareServer.shouldRoute(req)) {
                _bareServer.routeUpgrade(req, socket, head);
            }
        });

        console.log('[UV] Bare server mounted at /bare/');
    } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
            console.warn('[UV] bare-server-node not installed — npm install @tomphttp/bare-server-node');
        } else {
            console.error('[UV] Bare server error:', err.message);
        }
    }
}

module.exports = { createBare, uvStaticRouter };