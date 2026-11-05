/**
 * NovaByte OS — Nova Core Services System Update Routes
 * (nova-core-services-routes.js)  v1.0
 *
 * Independent update pipeline for Nova Core Services — the JS-layer runtime
 * components that can be updated without a full OS package release.
 *
 * Unlike the OS updater (auto-update-routes.js) which patches index.html and
 * server-side files, Core Services targets the /js/ folder: nova-security-api,
 * session-manager, update-service, and other runtime modules.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  HOW IT WORKS                                                           │
 * │                                                                         │
 * │  1. Developer runs:                                                     │
 * │       node updates/push-core-services.js --version 2026.05.2           │
 * │     ↳ Builds + signs a Core Services package and POSTs to /publish     │
 * │                                                                         │
 * │  2. Server stores package in .update-backups/core-services/             │
 * │                                                                         │
 * │  3. Clients poll  GET /api/coreservices/check  for new versions.       │
 * │     Response is lightweight metadata only — no patch payload.           │
 * │                                                                         │
 * │  4. On user confirm, client fetches  GET /api/coreservices/package     │
 * │     and installs via the existing UpdateService.install() pipeline.    │
 * │     Patched files: only paths under js/ that are in WRITABLE_PATHS.   │
 * │                                                                         │
 * │  5. After install, OS.coreServicesPatch and coreServicesVersion are    │
 * │     updated in localStorage so the About & Updates UI reflects the      │
 * │     new version immediately on next boot.                               │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Mount in server.js:
 *   const coreServicesRoutes = require('./nova-core-services-routes');
 *   app.use('/api/coreservices', coreServicesRoutes);
 *
 * Also add '/api/coreservices/' to the CSRF bypass list in server.js.
 *
 * Required env vars:
 *   UPDATE_ADMIN_TOKEN   — shared with the OS updater, same token
 *   CORE_SERVICES_CHANNEL — default channel (default: stable)
 */

'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const router = express.Router();

// Bypass security middleware — public read endpoints, admin writes use token auth
router.use((req, res, next) => {
  req.bypassSecurity  = true;
  req.bypassRateLimit = true;
  req.skipSentinel    = true;
  next();
});

/* ─────────────────────────────────────────────────────────────────────────────
   PATHS
   ───────────────────────────────────────────────────────────────────────────── */
const ROOT_DIR      = path.join(__dirname);
const BACKUP_DIR    = path.join(ROOT_DIR, '.update-backups');
const CS_DIR        = path.join(BACKUP_DIR, 'core-services');
const AUDIT_PATH    = path.join(CS_DIR, 'audit.log');

[BACKUP_DIR, CS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const VALID_CHANNELS = new Set(['stable', 'beta', 'nightly']);

/* ─────────────────────────────────────────────────────────────────────────────
   HELPERS
   ───────────────────────────────────────────────────────────────────────────── */
function metaPath(channel)    { return path.join(CS_DIR, `${channel}-meta.json`); }
function pkgPath(channel)     { return path.join(CS_DIR, `${channel}-package.json`); }
function resolveChannel(raw)  {
    return VALID_CHANNELS.has(raw)
        ? raw
        : (process.env.CORE_SERVICES_CHANNEL || 'stable');
}

function audit(req, event, extra = {}) {
    const entry = JSON.stringify({
        ts:    new Date().toISOString(),
        event,
        ip:    req.ip || req.connection?.remoteAddress || 'unknown',
        ua:    (req.headers['user-agent'] || '').slice(0, 120),
        ...extra,
    }) + '\n';
    try { fs.appendFileSync(AUDIT_PATH, entry, 'utf8'); } catch {}
    console.log(`[CoreServices] ${event}`, JSON.stringify(extra));
}

function requireAdminToken(req, res, next) {
    const adminToken = process.env.UPDATE_ADMIN_TOKEN;
    if (!adminToken) {
        return res.status(503).json({
            error:  'Core Services publish is disabled',
            detail: 'Set UPDATE_ADMIN_TOKEN in .env to enable it',
        });
    }
    const provided = req.headers['x-admin-token'] || req.body?.adminToken;
    const hashOf   = s => crypto.createHash('sha256').update(String(s)).digest();
    if (!provided || !crypto.timingSafeEqual(hashOf(adminToken), hashOf(provided))) {
        audit(req, 'publish-auth-failed', { status: 401 });
        return res.status(401).json({ error: 'Invalid or missing admin token' });
    }
    next();
}

/**
 * Compare two Core Services version strings.
 * Format: YYYY.MM.build  (e.g. "2026.05.2")
 * Falls back to semver-style numeric comparison for each segment.
 * Returns true if `a` is newer than `b`.
 */
function csVersionGt(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0, nb = pb[i] || 0;
        if (na > nb) return true;
        if (na < nb) return false;
    }
    return false;
}

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/coreservices/check[?channel=stable&version=2026.03.1]
   ─────────────────────────────────────────────────────────────────────────────
   Lightweight poll — returns only metadata. No patch payload.
   The client calls this from the Settings → Updates → Nova Core Services tab.
   ───────────────────────────────────────────────────────────────────────────── */
router.get('/check', (req, res) => {
    const channel  = resolveChannel(req.query.channel);
    const mPath    = metaPath(channel);

    if (!fs.existsSync(mPath)) {
        return res.json({
            available: false,
            channel,
            message:   `No Core Services update published on the ${channel} channel`,
        });
    }

    let meta;
    try {
        meta = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    } catch {
        return res.status(500).json({ error: 'Could not read Core Services metadata' });
    }

    const clientVersion = req.query.version || '0.0.0';
    const available     = csVersionGt(meta.version, clientVersion);

    audit(req, 'check', { channel, clientVersion, serverVersion: meta.version, available });

    res.json({
        available,
        channel,
        version:     meta.version,
        patchDate:   meta.patchDate,
        publishedAt: meta.publishedAt,
        description: meta.description || '',
        changelog:   meta.changelog   || '',
        checksum:    meta.checksum,
        sizeBytes:   meta.sizeBytes   || 0,
        trust:       meta.trust       || 'unknown',
        components:  meta.components  || [],
    });
});

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/coreservices/package[?channel=stable]
   ─────────────────────────────────────────────────────────────────────────────
   Full signed package. Only called after user confirms install.
   Uses the same format as OS update packages so UpdateService.install() works.
   ───────────────────────────────────────────────────────────────────────────── */
router.get('/package', (req, res) => {
    const channel = resolveChannel(req.query.channel);
    const pPath   = pkgPath(channel);

    if (!fs.existsSync(pPath)) {
        return res.status(404).json({ error: `No Core Services package on the ${channel} channel` });
    }

    let pkg;
    try {
        pkg = JSON.parse(fs.readFileSync(pPath, 'utf8'));
    } catch {
        return res.status(500).json({ error: 'Could not read Core Services package' });
    }

    const version = pkg.package?.version || pkg.version;
    audit(req, 'package-download', { channel, version });
    res.json(pkg);
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /api/coreservices/publish
   ─────────────────────────────────────────────────────────────────────────────
   Admin only. Stores a signed Core Services package in the channel.
   Body: { adminToken, channel, pkg: <signed package JSON> }
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/publish', requireAdminToken, (req, res) => {
    const { pkg, channel: rawChannel } = req.body || {};
    const channel = resolveChannel(rawChannel);

    if (!pkg || typeof pkg !== 'object') {
        return res.status(400).json({ error: 'Missing pkg in request body' });
    }

    const version     = pkg.package?.version   || pkg.version;
    const patchDate   = pkg.package?.patchDate  || pkg.patchDate;
    const files       = pkg.package?.files      || pkg.files || pkg.patches;
    const description = pkg.package?.description || pkg.description || '';
    const changelog   = pkg.package?.changelog   || pkg.changelog   || '';
    const components  = pkg.package?.components  || pkg.components  || [];

    if (!version || typeof version !== 'string') {
        return res.status(400).json({ error: 'pkg.version is required (format: YYYY.MM.build)' });
    }
    if (!patchDate) {
        return res.status(400).json({ error: 'pkg.patchDate is required (format: YYYY-MM-DD)' });
    }
    if (!Array.isArray(files)) {
        return res.status(400).json({ error: 'pkg must contain files[] or patches[]' });
    }

    // Reject downgrade
    const mPath = metaPath(channel);
    if (fs.existsSync(mPath)) {
        try {
            const existing = JSON.parse(fs.readFileSync(mPath, 'utf8'));
            if (existing.version && !csVersionGt(version, existing.version)) {
                return res.status(409).json({
                    error: `Channel ${channel} already has v${existing.version} — refusing downgrade to v${version}`,
                    hint:  'Increment the build number or month in your version string',
                });
            }
        } catch {}
    }

    const pkgJson   = JSON.stringify(pkg);
    const sizeBytes = Buffer.byteLength(pkgJson, 'utf8');
    const checksum  = crypto.createHash('sha256').update(pkgJson).digest('hex');
    const trust     = pkg.signature
        ? (pkg.signature.keyId === 'official' ? 'official' : 'community')
        : 'unsigned';

    const meta = {
        version,
        patchDate,
        channel,
        publishedAt:  new Date().toISOString(),
        description,
        changelog,
        components,
        checksum,
        sizeBytes,
        trust,
        publishedBy:  req.ip,
    };

    const pPath = pkgPath(channel);
    try {
        fs.writeFileSync(pPath   + '.tmp', pkgJson,                      'utf8');
        fs.writeFileSync(mPath   + '.tmp', JSON.stringify(meta, null, 2),'utf8');
        fs.renameSync(pPath + '.tmp', pPath);
        fs.renameSync(mPath + '.tmp', mPath);
    } catch (e) {
        audit(req, 'publish-write-error', { error: e.message, channel, version });
        return res.status(500).json({ error: 'Failed to write package: ' + e.message });
    }

    audit(req, 'published', { channel, version, patchDate, sizeBytes, trust, checksum });

    // Notify connected clients immediately
    const io = global.io || global._io;
    if (io) {
        io.emit('coreservices:update:available', {
            channel, version, patchDate,
            publishedAt:  meta.publishedAt,
            description, changelog, components,
            checksum, sizeBytes, trust,
        });
        console.log(`[CoreServices] Broadcasted update to all clients (v${version})`);
    }

    res.json({
        ok:          true,
        channel,
        version,
        patchDate,
        sizeBytes,
        checksum,
        trust,
        publishedAt: meta.publishedAt,
        message:     `Core Services v${version} (patch: ${patchDate}) published to ${channel}. All connected clients notified.`,
    });
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /api/coreservices/retract
   ─────────────────────────────────────────────────────────────────────────────
   Admin only. Pulls a Core Services update from a channel.
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/retract', requireAdminToken, (req, res) => {
    const channel = resolveChannel(req.body?.channel);
    const mPath   = metaPath(channel);
    const pPath   = pkgPath(channel);

    if (!fs.existsSync(mPath)) {
        return res.status(404).json({ error: `No Core Services update on the ${channel} channel` });
    }

    let retractedVersion = '?', retractedPatchDate = '?';
    try {
        const meta = JSON.parse(fs.readFileSync(mPath, 'utf8'));
        retractedVersion   = meta.version;
        retractedPatchDate = meta.patchDate;
    } catch {}

    try {
        if (fs.existsSync(mPath)) fs.unlinkSync(mPath);
        if (fs.existsSync(pPath)) fs.unlinkSync(pPath);
    } catch (e) {
        return res.status(500).json({ error: 'Failed to retract: ' + e.message });
    }

    audit(req, 'retracted', { channel, version: retractedVersion });

    const io = global.io || global._io;
    if (io) {
        io.emit('coreservices:update:retracted', {
            channel, version: retractedVersion, patchDate: retractedPatchDate,
        });
    }

    res.json({
        ok:        true,
        channel,
        version:   retractedVersion,
        patchDate: retractedPatchDate,
        message:   `Core Services v${retractedVersion} retracted from ${channel}.`,
    });
});

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/coreservices/status
   ─────────────────────────────────────────────────────────────────────────────
   Admin: see what's published on all channels + last 20 audit entries.
   ───────────────────────────────────────────────────────────────────────────── */
router.get('/status', requireAdminToken, (req, res) => {
    const channels = {};
    for (const ch of VALID_CHANNELS) {
        const mPath = metaPath(ch);
        channels[ch] = fs.existsSync(mPath)
            ? (() => { try { return JSON.parse(fs.readFileSync(mPath, 'utf8')); } catch { return { error: 'unreadable' }; } })()
            : null;
    }

    let recentAudit = [];
    try {
        recentAudit = fs.readFileSync(AUDIT_PATH, 'utf8')
            .trim().split('\n').slice(-20)
            .map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
    } catch {}

    res.json({ system: 'Nova Core Services System Update', channels, recentAudit });
});

module.exports = router;
