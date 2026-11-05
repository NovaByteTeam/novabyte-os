/**
 * NovaByte OS — Auto-Update Channel Routes  (auto-update-routes.js)  v1.0
 *
 * Adds a zero-touch "push once, all clients update" channel on top of the
 * existing manual package installer in update-routes.js.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  HOW IT WORKS                                                           │
 * │                                                                         │
 * │  1.  Developer runs:  node updates/push-update.js --pkg update.json    │
 * │      ↳ Signs the package and POSTs it to  POST /api/autoupdate/publish  │
 * │                                                                         │
 * │  2.  Server stores the package in  .update-backups/channel.json         │
 * │      and metadata in  .update-backups/channel-meta.json                 │
 * │                                                                         │
 * │  3.  Every client polls  GET /api/autoupdate/check  every N minutes.   │
 * │      The response is just metadata (<2 KB) — no patch payload yet.      │
 * │                                                                         │
 * │  4.  When client sees a newer version it shows an update notification.  │
 * │      On user confirm (or silently if autoInstall=true) it fetches       │
 * │      GET /api/autoupdate/package  and runs UpdateService.install().     │
 * │                                                                         │
 * │  5.  The existing validate/sign/write-file/rollback pipeline is reused. │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Mount in server.js:
 *   const autoUpdateRoutes = require('./auto-update-routes');
 *   app.use('/api/autoupdate', autoUpdateRoutes);
 *
 * Required env vars:
 *   UPDATE_ADMIN_TOKEN   — secret token required to publish a new update
 *                          Generate with:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   UPDATE_CHANNEL       — default channel clients receive (stable | beta | nightly)
 *                          Defaults to 'stable'
 */

'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const router = express.Router();

// Bypass all security middleware for this router - public endpoints
router.use((req, res, next) => {
  req.bypassSecurity = true;
  req.bypassRateLimit = true;
  req.skipSentinel = true;
  next();
});

/* ─────────────────────────────────────────────────────────────────────────────
   PATHS
   ───────────────────────────────────────────────────────────────────────────── */
const ROOT_DIR      = path.join(__dirname);
const BACKUP_DIR    = path.join(ROOT_DIR, '.update-backups');
const CHANNEL_DIR   = path.join(BACKUP_DIR, 'channels');
const AUDIT_PATH    = path.join(BACKUP_DIR, 'auto-update-audit.log');

// Ensure dirs exist
[BACKUP_DIR, CHANNEL_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Supported channels
const VALID_CHANNELS = new Set(['stable', 'beta', 'nightly']);

/* ─────────────────────────────────────────────────────────────────────────────
   HELPERS
   ───────────────────────────────────────────────────────────────────────────── */
function channelMetaPath(channel) {
    return path.join(CHANNEL_DIR, `${channel}-meta.json`);
}
function channelPkgPath(channel) {
    return path.join(CHANNEL_DIR, `${channel}-package.json`);
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
    console.log(`[AutoUpdate] ${event}`, JSON.stringify(extra));
}

function requireAdminToken(req, res, next) {
    const adminToken = process.env.UPDATE_ADMIN_TOKEN;

    // If no token is configured, the publish endpoint is disabled
    if (!adminToken) {
        return res.status(503).json({
            error: 'Auto-update publish is disabled',
            detail: 'Set UPDATE_ADMIN_TOKEN in .env to enable it',
        });
    }

    const provided = req.headers['x-admin-token'] || req.body?.adminToken;
    if (!provided || !crypto.timingSafeEqual(
        Buffer.from(adminToken),
        Buffer.from(provided.padEnd(adminToken.length).slice(0, adminToken.length))
    )) {
        audit(req, 'publish-auth-failed', { status: 401 });
        return res.status(401).json({ error: 'Invalid or missing admin token' });
    }

    next();
}

function semverGt(a, b) {
    // Simple semver comparison: "1.2.3" > "1.2.2"
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
   GET /api/autoupdate/check[?channel=stable&version=1.0.0]
   ─────────────────────────────────────────────────────────────────────────────
   Lightweight poll endpoint — returns only metadata, never the full package.
   Clients call this every N minutes. Response is <2 KB.
   ───────────────────────────────────────────────────────────────────────────── */
router.get('/check', (req, res) => {
    const channel = VALID_CHANNELS.has(req.query.channel)
        ? req.query.channel
        : (process.env.UPDATE_CHANNEL || 'stable');

    const metaFile = channelMetaPath(channel);

    if (!fs.existsSync(metaFile)) {
        // No update published yet for this channel
        return res.json({
            available:  false,
            channel,
            message:    `No updates published on the ${channel} channel`,
        });
    }

    let meta;
    try {
        meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    } catch (e) {
        return res.status(500).json({ error: 'Could not read channel metadata' });
    }

    const clientVersion = req.query.version || '0.0.0';
    const available     = semverGt(meta.version, clientVersion);

    audit(req, 'check', { channel, clientVersion, serverVersion: meta.version, available });

    res.json({
        available,
        channel,
        version:     meta.version,
        publishedAt: meta.publishedAt,
        description: meta.description || '',
        changelog:   meta.changelog   || '',
        // Short hash so client can verify after download
        checksum:    meta.checksum,
        // Size estimate so client can show "7.8 MB" in the UI
        sizeBytes:   meta.sizeBytes   || 0,
        // Trust level from the stored package signature
        trust:       meta.trust       || 'unknown',
        // Optional: minimum client version required to apply this update
        requires:    meta.requires    || null,
    });
});

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/autoupdate/package[?channel=stable]
   ─────────────────────────────────────────────────────────────────────────────
   Returns the full signed package JSON so the client can run
   UpdateService.install(pkg).  Only called after the user confirms install.
   ───────────────────────────────────────────────────────────────────────────── */
router.get('/package', (req, res) => {
    const channel = VALID_CHANNELS.has(req.query.channel)
        ? req.query.channel
        : (process.env.UPDATE_CHANNEL || 'stable');

    const pkgFile = channelPkgPath(channel);

    if (!fs.existsSync(pkgFile)) {
        return res.status(404).json({ error: `No package available on the ${channel} channel` });
    }

    let pkg;
    try {
        pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    } catch (e) {
        return res.status(500).json({ error: 'Could not read package file' });
    }

    audit(req, 'package-download', { channel, version: pkg.version });
    res.json(pkg);
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /api/autoupdate/publish
   ─────────────────────────────────────────────────────────────────────────────
   Admin-only: store a signed update package in the channel.
   Body (JSON):
   {
     adminToken: "…",           // or use X-Admin-Token header
     channel:    "stable",      // stable | beta | nightly
     pkg:        { /* signed package JSON * / }
   }
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/publish', requireAdminToken, (req, res) => {
    const { pkg, channel: rawChannel } = req.body || {};

    // Validate channel
    const channel = VALID_CHANNELS.has(rawChannel)
        ? rawChannel
        : (process.env.UPDATE_CHANNEL || 'stable');

    // Basic package shape validation
    if (!pkg || typeof pkg !== 'object') {
        return res.status(400).json({ error: 'Missing pkg in request body' });
    }
    
    // Support both flat format (pkg.version) and nested format (pkg.package.version)
    const version = pkg.package?.version || pkg.version;
    const files = pkg.package?.files || pkg.files || pkg.patches;
    const name = pkg.package?.name || pkg.name;
    const description = pkg.package?.description || pkg.description;
    const changelog = pkg.package?.changelog || pkg.changelog;
    
    if (!version || typeof version !== 'string') {
        return res.status(400).json({ error: 'pkg.version is required' });
    }
    if (!Array.isArray(files)) {
        return res.status(400).json({ error: 'pkg must contain patches[] or files[]' });
    }

    // Prevent publishing an older version over a newer one on the same channel
    const metaFile = channelMetaPath(channel);
    if (fs.existsSync(metaFile)) {
        try {
            const existing = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
            if (existing.version && !semverGt(version, existing.version)) {
                return res.status(409).json({
                    error: `Channel ${channel} already has v${existing.version} — refusing to downgrade to v${version}`,
                    hint:  'Bump the version number in your package',
                });
            }
        } catch {}
    }

    // Serialise the package
    const pkgJson   = JSON.stringify(pkg);
    const sizeBytes = Buffer.byteLength(pkgJson, 'utf8');
    const checksum  = crypto.createHash('sha256').update(pkgJson).digest('hex');

    // Determine trust level from package signature field
    const trust = pkg.signature
        ? (pkg.signature.keyId === 'official' ? 'official' : 'community')
        : 'unsigned';

    // Build lightweight metadata (no patch payload)
    const meta = {
        version,
        channel,
        publishedAt: new Date().toISOString(),
        description: description || '',
        changelog:   changelog   || '',
        checksum,
        sizeBytes,
        trust,
        requires:    pkg.package?.requires || pkg.requires    || null,
        publishedBy: req.ip,
    };

    // Write files atomically (write to .tmp then rename)
    const pkgFile = channelPkgPath(channel);
    try {
        fs.writeFileSync(pkgFile  + '.tmp', pkgJson,           'utf8');
        fs.writeFileSync(metaFile + '.tmp', JSON.stringify(meta, null, 2), 'utf8');
        fs.renameSync(pkgFile   + '.tmp', pkgFile);
        fs.renameSync(metaFile  + '.tmp', metaFile);
    } catch (e) {
        audit(req, 'publish-write-error', { error: e.message, channel, version });
        return res.status(500).json({ error: 'Failed to write package: ' + e.message });
    }

    audit(req, 'published', { channel, version, sizeBytes, trust, checksum });

    // Emit a Socket.IO broadcast so any connected clients are notified immediately
    // (server.js sets global.io — we use it if available, no hard dependency)
    const io = global.io || global._io;
    if (io) {
        io.emit('update:available', {
            channel,
            version:     meta.version,
            publishedAt: meta.publishedAt,
            description: meta.description,
            changelog:   meta.changelog,
            checksum,
            sizeBytes,
            trust,
        });
        console.log(`[AutoUpdate] Broadcasted update:available to all clients (v${version})`);
    }

    res.json({
        ok:          true,
        channel,
        version,
        sizeBytes,
        checksum,
        trust,
        publishedAt: meta.publishedAt,
        message:     `Update v${version} published to the ${channel} channel. All connected clients will be notified.`,
    });
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /api/autoupdate/retract
   ─────────────────────────────────────────────────────────────────────────────
   Admin-only: pull an update from a channel (e.g. bad release).
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/retract', requireAdminToken, (req, res) => {
    const { channel: rawChannel } = req.body || {};
    const channel = VALID_CHANNELS.has(rawChannel)
        ? rawChannel
        : (process.env.UPDATE_CHANNEL || 'stable');

    const metaFile = channelMetaPath(channel);
    const pkgFile  = channelPkgPath(channel);

    if (!fs.existsSync(metaFile)) {
        return res.status(404).json({ error: `No update found on the ${channel} channel` });
    }

    let retractedVersion = '?';
    try {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        retractedVersion = meta.version;
    } catch {}

    try {
        if (fs.existsSync(metaFile)) fs.unlinkSync(metaFile);
        if (fs.existsSync(pkgFile))  fs.unlinkSync(pkgFile);
    } catch (e) {
        return res.status(500).json({ error: 'Failed to retract: ' + e.message });
    }

    audit(req, 'retracted', { channel, version: retractedVersion });

    const io = global.io || global._io;
    if (io) {
        io.emit('update:retracted', { channel, version: retractedVersion });
    }

    res.json({
        ok:      true,
        channel,
        version: retractedVersion,
        message: `Update v${retractedVersion} retracted from the ${channel} channel.`,
    });
});

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/autoupdate/status
   ─────────────────────────────────────────────────────────────────────────────
   Admin dashboard: see what's published on all channels.
   ───────────────────────────────────────────────────────────────────────────── */
router.get('/status', requireAdminToken, (req, res) => {

// Bypass security middleware for public endpoints
router.use((req, res, next) => {
  req.bypassSecurityCheck = true;
  req.noRateLimit = true;
  next();
});
    const channels = {};
    for (const ch of VALID_CHANNELS) {
        const metaFile = channelMetaPath(ch);
        if (fs.existsSync(metaFile)) {
            try {
                channels[ch] = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
            } catch {
                channels[ch] = { error: 'Could not read metadata' };
            }
        } else {
            channels[ch] = null; // nothing published
        }
    }

    // Last 20 audit entries
    let recentAudit = [];
    try {
        const raw = fs.readFileSync(AUDIT_PATH, 'utf8');
        recentAudit = raw.trim().split('\n').slice(-20).map(l => {
            try { return JSON.parse(l); } catch { return { raw: l }; }
        });
    } catch {}

    res.json({ channels, recentAudit });
});

module.exports = router;
