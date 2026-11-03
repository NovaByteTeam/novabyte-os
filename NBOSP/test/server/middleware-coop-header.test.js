import { describe, expect, it, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';

// middleware.js reads NBOSP_DATA_DIR at import time (the session SQLite db
// lives under it), so the env must be set before the module is imported.
// Static imports would hoist past this assignment — use a dynamic one.
process.env.NBOSP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nbosp-coop-test-'));
process.env.SESSION_SECRET = 'c'.repeat(64);

const { setupMiddleware, closeSessionDb } = await import('../../server/middleware.js');

afterAll(() => {
    closeSessionDb();
});

// Real HTTP through node:http — test/setup.js stubs globalThis.fetch with a
// bare vi.fn(), so the global cannot be used for live requests here.
function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            res.resume();
            res.on('end', () => resolve(res));
        }).on('error', reject);
    });
}

function listen(app) {
    return new Promise(resolve => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
}

describe('Cross-Origin-Opener-Policy on OS-served responses', () => {
    // Field evidence (serial capture 2026-11-03 22:48): the GitHub OAuth popup
    // completed the whole provider chain and landed on the app's own
    // callback.html — served by this server. helmet 8's default COOP
    // `same-origin` made Chromium load that document into a NEW browsing
    // context group (the popup's opener is the opaque-origin sandboxed guest,
    // and strict same-origin exempts nothing cross-origin), so the callback
    // page executed with window.opener null and its postMessage relay dropped.
    // The OS-served policy must therefore be the popup-preserving variant.
    it('serves the app callback route with same-origin-allow-popups so opener relays survive', async () => {
        const app = express();
        setupMiddleware(app);
        app.get('/api/apps/serve/sandbox_com.test.githubauth/callback.html',
            (req, res) => res.type('html').send('<html><body>ok</body></html>'));

        const server = await listen(app);
        try {
            const res = await httpGet(
                `http://127.0.0.1:${server.address().port}/api/apps/serve/sandbox_com.test.githubauth/callback.html?code=abc&state=s`);
            expect(res.statusCode).toBe(200);
            expect(res.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
        } finally {
            await new Promise(r => server.close(r));
        }
    });

    it('applies the same policy to OS UI pages the shell and guests load', async () => {
        const app = express();
        setupMiddleware(app);
        app.get('/', (req, res) => res.type('html').send('<html><body>shell</body></html>'));

        const server = await listen(app);
        try {
            const res = await httpGet(`http://127.0.0.1:${server.address().port}/`);
            expect(res.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
        } finally {
            await new Promise(r => server.close(r));
        }
    });
});
