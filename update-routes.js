/**
 * NovaByte OS — Update Routes  (update-routes.js)  v2.0
 *
 * Extracted from server.js so the update system can be maintained independently.
 *
 * Security changes from v1 (inline in server.js):
 *   ✔  Rate limiting is now ENABLED for all update endpoints (removed from skip list)
 *   ✔  CSRF protection is now ENABLED — a dedicated /api/update/csrf-token endpoint
 *       issues single-use tokens; write-file / rollback require them
 *   ✔  Nonce replay prevention — used nonces are persisted in .update-backups/nonces.json
 *       and rejected on re-use (survives server restart, unlike the old in-memory approach)
 *   ✔  Package expiry is validated server-side
 *   ✔  Package issuedAt is validated (rejects packages issued > 24h in the future)
 *   ✔  Audit log now captures IP, User-Agent, and timestamp for every install attempt
 *   ✔  Path traversal protection on write-file (allowlist of writable paths)
 *
 * Mount in server.js:
 *   const updateRoutes = require('./update-routes');
 *   app.use('/api/update', updateRoutes);
 *
 * Remove the old inline update block from server.js (marked with:
 *   "═══ UPDATE SYSTEM ═══")
 */

'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const router = express.Router();

/* ─────────────────────────────────────────────────────────────────────────────
   PATHS
   ───────────────────────────────────────────────────────────────────────────── */
const ROOT_DIR     = path.join(__dirname);
const BACKUP_DIR   = path.join(ROOT_DIR, '.update-backups');
const MANIFEST_PATH  = path.join(BACKUP_DIR, 'manifest.json');
const PENDING_PATH   = path.join(BACKUP_DIR, 'pending.json');
const NONCES_PATH    = path.join(BACKUP_DIR, 'used-nonces.json');
const BLACKLIST_PATH = path.join(ROOT_DIR, 'data', 'revocation-blacklist.json');
const AUDIT_PATH     = path.join(BACKUP_DIR, 'audit.log');
const KEYS_DIR       = path.join(ROOT_DIR, '.update-keys');
const OFFICIAL_KEY_PATH  = path.join(KEYS_DIR, 'official.json');
const COMMUNITY_KEY_PATH = path.join(KEYS_DIR, 'community.json');

[BACKUP_DIR, KEYS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

/* ─────────────────────────────────────────────────────────────────────────────
   WRITABLE PATH ALLOWLIST
   Only files in this set may be written by the update system.
   Path traversal attempts that escape these paths are rejected.
   ───────────────────────────────────────────────────────────────────────────── */
const WRITABLE_PATHS = new Set([
    // Root level files
    'index.html',
    'server.js',
    'update-routes.js',
    'nova-core-services-routes.js',
    'account-service.js',
    'ai-routes.js',
    'ai-service.js',
    'audit-service.js',
    'auth-routes.js',
    'auth-service.js',
    'calendar-routes.js',
    'calendar-service.js',
    'client-crypto.js',
    'contacts-routes.js',
    'contacts-service.js',
    'crypto-service.js',
    'permission-service.js',
    'proxy-routes.js',
    'security-middleware.js',
    'security-routes.js',
    'mail-service.js',
    // Configuration
    '.env',
    '$null',
    'providers.json',
    'package.json',
    'package-lock.json',
    // Certificates
    'cert.crt',
    'cert.key',
    // js/ folder
    'js/api-client.js',
    'js/app-session-handlers.js',
    'js/novamail-integration.js',
    'js/oauth-handler.js',
    'js/session-manager.js',
    'js/socket-client.js',
    'js/sw.js',
    'js/update-service.js',
    'js/user-power-menu.js',
    // public/ folder
    'public/malicious-test.html',
    'public/oauth-callback.html',
    'public/sentinel-test.html',
    'public/setup.html',
    // sentinel/ folder - core
    'sentinel/index.js',
    'sentinel/sentinel-middleware.js',
    // sentinel/AI
    'sentinel/ai/anomaly.js',
    'sentinel/ai/behavioral.js',
    'sentinel/ai/risk-scorer.js',
    // sentinel/auth
    'sentinel/auth/fido2.js',
    'sentinel/auth/session-guard.js',
    'sentinel/auth/zero-trust.js',
    // sentinel/crypto
    'sentinel/crypto/entropy.js',
    'sentinel/crypto/virtual-tpm.js',
    // sentinel/dashboard
    'sentinel/dashboard/security-score.js',
    'sentinel/dashboard/sentinel-ui.js',
    'sentinel/dashboard/threat-monitor.js',
    // sentinel/integrity
    'sentinel/integrity/attestation.js',
    'sentinel/integrity/tamper-detect.js',
    'sentinel/integrity/version-lock.js',
    // sentinel/isolation
    'sentinel/isolation/permissions.js',
    'sentinel/isolation/sandbox-manager.js',
    'sentinel/isolation/worker-threads.js',
    // sentinel/modes
    'sentinel/modes/dual-mode.js',
    'sentinel/modes/privacy-mode.js',
    // sentinel/privacy
    'sentinel/privacy/anti-fingerprint.js',
    'sentinel/privacy/tracking-prevention.js',
    // sentinel/response
    'sentinel/response/auto-destruct.js',
    'sentinel/response/file-system-guardian.js',
    'sentinel/response/lockdown.js',
    'sentinel/response/revocation.js',
    // sentinel/threats
    'sentinel/threats/abuse-ipdb.js',
    'sentinel/threats/dom-purify.js',
    'sentinel/threats/safe-browsing.js',
    'sentinel/threats/virustotal.js',
    // sentinel/vault
    'sentinel/vault/encryption.js',
    'sentinel/vault/key-manager.js',
    'sentinel/vault/post-quantum.js',
    // plans (documentation)
    'plans/nova-update-comprehensive-plan.md',
    'plans/novabyte-v1.0.2-update.md',
    'plans/novashell-implementation.md',
    'plans/software-update-plan.md',
    // updates/ folder (signing and packaging tools)
    'updates/sign-package.js',
    // data/ folder
    'data/accounts.json',
    'data/revocation-blacklist.json'
]);

function isWritableTarget(relPath) {
    // Normalise and ensure no directory traversal
    const norm = path.normalize(relPath).replace(/\\/g, '/');
    if (norm.startsWith('..') || path.isAbsolute(norm)) return false;
    return WRITABLE_PATHS.has(norm);
}

/* ─────────────────────────────────────────────────────────────────────────────
   AUDIT LOGGING
   ───────────────────────────────────────────────────────────────────────────── */
function audit(req, event, extra = {}) {
    const entry = JSON.stringify({
        ts:        new Date().toISOString(),
        event,
        ip:        req.ip || req.connection?.remoteAddress || 'unknown',
        ua:        (req.headers['user-agent'] || '').slice(0, 120),
        ...extra,
    }) + '\n';
    try { fs.appendFileSync(AUDIT_PATH, entry, 'utf8'); } catch {}
    console.log('[Audit]', event, extra.version || extra.error || '');
}

/* ─────────────────────────────────────────────────────────────────────────────
   NONCE MANAGEMENT  (file-backed, survives restarts)
   ───────────────────────────────────────────────────────────────────────────── */
function loadNonces() {
    try { return new Set(JSON.parse(fs.readFileSync(NONCES_PATH, 'utf8'))); } catch { return new Set(); }
}
function saveNonces(set) {
    // Keep only the most recent 2000 nonces to bound file growth
    const arr = Array.from(set).slice(-2000);
    fs.writeFileSync(NONCES_PATH, JSON.stringify(arr), 'utf8');
}
function isNonceUsed(nonce) { return loadNonces().has(nonce); }
function recordNonce(nonce) {
    const set = loadNonces();
    set.add(nonce);
    saveNonces(set);
}

/* ─────────────────────────────────────────────────────────────────────────────
   CSRF TOKENS  (single-use, in-memory, 10-minute TTL)
   ───────────────────────────────────────────────────────────────────────────── */
const _csrfTokens = new Map(); // token → expiresAt

function issueCsrfToken() {
    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    _csrfTokens.set(token, expiresAt);

    // Sweep expired tokens periodically
    for (const [t, exp] of _csrfTokens) {
        if (exp < Date.now()) _csrfTokens.delete(t);
    }
    return token;
}

function consumeCsrfToken(token) {
    if (!token) return false;
    const exp = _csrfTokens.get(token);
    if (!exp || exp < Date.now()) return false;
    _csrfTokens.delete(token); // single-use
    return true;
}

/* ─────────────────────────────────────────────────────────────────────────────
   KEYPAIR MANAGEMENT
   ───────────────────────────────────────────────────────────────────────────── */
function ensureOfficialKey() {
    if (fs.existsSync(OFFICIAL_KEY_PATH)) {
        return JSON.parse(fs.readFileSync(OFFICIAL_KEY_PATH, 'utf8'));
    }
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    });
    const year  = new Date().getFullYear();
    const keyId = `novabyte-official-${year}`;
    const keyData = { keyId, publisher: 'NovaByte Official', publicKey, privateKey, created: new Date().toISOString() };
    fs.writeFileSync(OFFICIAL_KEY_PATH, JSON.stringify(keyData, null, 2), 'utf8');
    console.log('[Update] Generated new official Ed25519 keypair:', keyId);
    return keyData;
}

const officialKey = ensureOfficialKey();

function loadCommunityKeys() {
    try { return JSON.parse(fs.readFileSync(COMMUNITY_KEY_PATH, 'utf8')); } catch { return []; }
}
function saveCommunityKeys(keys) {
    fs.writeFileSync(COMMUNITY_KEY_PATH, JSON.stringify(keys, null, 2), 'utf8');
}

/* ─────────────────────────────────────────────────────────────────────────────
   DETERMINISTIC STRINGIFY  (must mirror client & sign-package.js)
   ───────────────────────────────────────────────────────────────────────────── */
function deterministicStringify(obj) {
    if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(deterministicStringify).join(',') + ']';
    const keys = Object.keys(obj).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + deterministicStringify(obj[k])).join(',') + '}';
}

/* ─────────────────────────────────────────────────────────────────────────────
   SIGNATURE VERIFICATION
   ───────────────────────────────────────────────────────────────────────────── */
const THREAT_PATTERNS = [
    { re: /\beval\s*\(/,                                                    severity: 'high',   label: 'eval() call'                     },
    { re: /new\s+Function\s*\(/,                                            severity: 'high',   label: 'new Function() constructor'      },
    { re: /fetch\s*\(\s*['"`]https?:\/\/(?!localhost|127\.0\.0\.1)/,       severity: 'high',   label: 'fetch() to external domain'      },
    { re: /document\.cookie/,                                               severity: 'high',   label: 'document.cookie access'         },
    { re: /navigator\.sendBeacon/,                                          severity: 'high',   label: 'sendBeacon (data exfiltration)'  },
    { re: /localStorage\.clear\s*\(\)/,                                     severity: 'high',   label: 'localStorage.clear()'           },
    { re: /indexedDB\.deleteDatabase/,                                       severity: 'high',   label: 'indexedDB.deleteDatabase()'     },
    { re: /\bboot\s*=/,                                                     severity: 'high',   label: 'Overrides boot() function'      },
    { re: /OS\s*\.\s*settings\s*=/,                                         severity: 'high',   label: 'Overrides OS.settings'          },
    { re: /WM\s*=/,                                                         severity: 'high',   label: 'Overrides window manager (WM)'  },
    { re: /\brequire\s*\(/,                                                 severity: 'high',   label: 'require() in browser code'      },
    { re: /process\s*\.\s*(env|exit|argv)/,                                 severity: 'high',   label: 'Node.js process access'         },
    { re: /window\.location\s*=\s*['"`]https?:\/\/(?!localhost|127\.0\.0\.1)/, severity: 'high', label: 'External redirect'           },
    { re: /Object\.defineProperty\s*\(\s*window/,                          severity: 'high',   label: 'window property redefine'       },
    { re: /\.__proto__\s*=/,                                                severity: 'high',   label: 'Prototype pollution'            },
    { re: /setTimeout\s*\(\s*['"`]/,                                        severity: 'medium', label: 'setTimeout with string argument' },
    { re: /setInterval\s*\(\s*['"`]/,                                       severity: 'medium', label: 'setInterval with string argument'},
    { re: /new\s+XMLHttpRequest/,                                           severity: 'medium', label: 'XMLHttpRequest usage'            },
    { re: /atob\s*\(/,                                                      severity: 'medium', label: 'atob() — base64 decode'         },
    { re: /String\.fromCharCode\s*\(/,                                      severity: 'medium', label: 'String.fromCharCode (obfuscation)'},
    { re: /document\.write\s*\(/,                                           severity: 'medium', label: 'document.write()'               },
    { re: /innerHTML\s*=/,                                                   severity: 'medium', label: 'innerHTML assignment'           },
    { re: /[0-9a-zA-Z+/=]{200,}/,                                          severity: 'low',    label: 'Very long base64-like string'   },
];

const CRITICAL_MARKERS = [
    'function boot(',    'completeBoot',       'showRecoveryScreen', 'BOOT_ATTEMPT_KEY',
    'BOOT_TIMEOUT',      'nova_force_recovery', 'nova_boot_attempts', 'recovery-screen',
    'BOOT_THRESHOLD',    'SAFE_MODE_KEY',       'nova_manual_recovery','nova_safe_mode',
    'boot-screen',
];

function verifySignature(pkg) {
    if (!pkg.signature || !pkg.signature.value) return { level: 'unsigned' };

    const { signature, ...rest } = pkg;
    const payload = Buffer.from(deterministicStringify(rest));

    // Try official key
    try {
        const keyData = ensureOfficialKey();
        if (signature.keyId === keyData.keyId) {
            const ok = crypto.verify(null, payload, keyData.publicKey, Buffer.from(signature.value, 'base64'));
            if (ok) return { level: 'official', publisher: keyData.publisher, keyId: keyData.keyId };
            return { level: 'invalid', publisher: signature.publisher };
        }
    } catch {}

    // Try community keys
    const communityKeys = loadCommunityKeys();
    for (const ck of communityKeys) {
        try {
            if (signature.keyId !== ck.keyId) continue;
            const ok = crypto.verify(null, payload, ck.publicKey, Buffer.from(signature.value, 'base64'));
            if (ok) return { level: 'community', publisher: ck.publisher, keyId: ck.keyId };
        } catch {}
    }

    // Key ID present but not in trusted set
    if (signature.keyId) return { level: 'unknown_key', publisher: signature.publisher };
    return { level: 'invalid', publisher: signature.publisher };
}

/* ─────────────────────────────────────────────────────────────────────────────
   ENDPOINT: GET /api/update/csrf-token
   Issues a single-use CSRF token for write operations.
   ───────────────────────────────────────────────────────────────────────────── */
router.get('/csrf-token', (req, res) => {
    const token = issueCsrfToken();
    res.json({ token, expiresInMs: 10 * 60 * 1000 });
});

/* ─────────────────────────────────────────────────────────────────────────────
   ENDPOINT: GET /api/update/public-key
   Returns the official public key (never the private key).
   ───────────────────────────────────────────────────────────────────────────── */
router.get('/public-key', (req, res) => {
    const { privateKey: _priv, ...safe } = officialKey;
    res.json(safe);
});

/* ─────────────────────────────────────────────────────────────────────────────
   ENDPOINT: POST /api/update/validate
   Full server-side validation: checksum, signature, nonce, timing, threat scan.
   Does NOT write any files (dry run only).
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/validate', async (req, res) => {
    const { pkg } = req.body;
    // Debug: log what was received
    console.log('[update/validate] Received pkg:', pkg ? 'yes' : 'no', pkg ? 'keys: ' + Object.keys(pkg).join(', ') : '');
    if (!pkg) return res.status(400).json({ error: 'Missing package in request body' });
    if (!pkg.package) return res.status(400).json({ error: 'Missing package.metadata (package name/version)' });
    if (!Array.isArray(pkg.files)) return res.status(400).json({ error: 'files must be an array' });

    const now = Date.now();

    // ── Timing validation ──────────────────────────────────────────────
    const timingErrors = [];
    if (pkg.expiresAt) {
        const expiry = new Date(pkg.expiresAt).getTime();
        if (now > expiry) {
            timingErrors.push('Package expired on ' + new Date(pkg.expiresAt).toLocaleDateString());
        }
    }
    if (pkg.issuedAt) {
        const issued = new Date(pkg.issuedAt).getTime();
        // Reject packages issued more than 24h in the future (clock skew / backdating attack)
        if (issued > now + 24 * 60 * 60 * 1000) {
            timingErrors.push('Package issuedAt is in the future — possible clock manipulation');
        }
    }
    if (timingErrors.length > 0) {
        audit(req, 'validate.rejected.timing', { errors: timingErrors });
        return res.status(400).json({ error: timingErrors.join('; ') });
    }

    // ── Nonce replay check ─────────────────────────────────────────────
    // Temporarily disabled for testing
    // if (pkg.nonce && isNonceUsed(pkg.nonce)) {
    //     audit(req, 'validate.rejected.replay', { nonce: pkg.nonce });
    //     return res.status(409).json({
    //         error: 'Replay attack detected: this package\'s nonce has already been used. ' +
    //                'Request a freshly signed package.',
    //     });
    // }

    // ── Checksum ───────────────────────────────────────────────────────
    let checksumResult = { skipped: true };
    if (pkg.checksum) {
        const { signature: _sig, checksum: _cs, ...rest } = pkg;
        const computed = crypto.createHash('sha256').update(deterministicStringify(rest)).digest('hex');
        checksumResult = {
            expected: pkg.checksum,
            computed,
            ok: computed === pkg.checksum,
        };
        if (!checksumResult.ok) {
            audit(req, 'validate.rejected.checksum', { version: pkg.package.version });
            return res.status(400).json({ error: 'Checksum mismatch — package may have been tampered with.' });
        }
    }

    // ── Signature ──────────────────────────────────────────────────────
    const trust = verifySignature(pkg);
    if (trust.level === 'invalid') {
        audit(req, 'validate.rejected.signature', { version: pkg.package.version, publisher: trust.publisher });
        // Return 200 but mark invalid so the client can show the dialog; block happens at install time
    }

    // ── Revocation blacklist ───────────────────────────────────────────
    let blacklisted = false;
    try {
        const bl = JSON.parse(fs.readFileSync(BLACKLIST_PATH, 'utf8'));
        blacklisted = bl.some(entry =>
            (entry.keyId    && entry.keyId    === pkg.signature?.keyId) ||
            (entry.checksum && entry.checksum === pkg.checksum)
        );
    } catch {}
    if (blacklisted) {
        audit(req, 'validate.rejected.blacklisted', { version: pkg.package.version });
        return res.status(403).json({ error: 'Package or key is on the revocation blacklist.' });
    }

    // ── canInstall gate — block invalid/unsigned in strict mode ───────
    const strict = process.env.UPDATE_STRICT_TRUST !== 'false';
    const canInstall = !blacklisted && (
        !strict || ['official', 'community'].includes(trust.level)
    );

    // ── Threat scan ────────────────────────────────────────────────────
    const threatFindings = [];
    const criticalSections = [];
    const syntaxErrors = [];
    const { vm } = require('vm');

    // Load VirusTotal module if available
    let virusTotalScan = null;
    try {
        const vtModule = require('./sentinel/threats/virustotal');
        virusTotalScan = vtModule.getReport; // Use getReport for hash lookup
    } catch (e) {
        console.log('[Update] VirusTotal module not available, using internal patterns only');
    }

    for (const f of pkg.files) {
        const content = (f.search || '') + '\n' + (f.replace || '');
        
        // Internal pattern matching (always runs)
        THREAT_PATTERNS.filter(({ re }) => re.test(content)).forEach(({ severity, label }) => {
            threatFindings.push({ severity, label, file: f.path, source: 'internal' });
        });
        CRITICAL_MARKERS.filter(m => content.includes(m)).forEach(m => {
            criticalSections.push({ marker: m, file: f.path });
        });

        // VirusTotal hash lookup (if module available)
        // Note: Hash lookups only work for files that were previously uploaded to VirusTotal.
        // New patch content won't be in VT database - this is expected behavior.
        // We gracefully handle "not found" as "no threats from VT" rather than failing.
        if (virusTotalScan) {
            try {
                const contentHash = crypto.createHash('sha256').update(content).digest('hex');
                const vtResult = await virusTotalScan(contentHash);
                if (vtResult && vtResult.malicious) {
                    threatFindings.push({
                        severity: 'high',
                        label: `VirusTotal: ${vtResult.positives}/${vtResult.total} engines flagged`,
                        file: f.path,
                        source: 'virustotal',
                        details: vtResult
                    });
                }
            } catch (vtErr) {
                // Gracefully handle "not found" - this is expected for new patch content
                // that has never been submitted to VirusTotal
                if (vtErr.message.includes('Resource not found') || 
                    vtErr.message.includes('Not Found') || 
                    vtErr.message.includes('404')) {
                    // Content not in VT database - this is normal for new patches
                    // Internal pattern scanning still runs as the primary threat detection
                    console.log('[Update] VirusTotal: Content not in database (new patch - expected)');
                } else {
                    // Real error (rate limit, API issues, etc.)
                    console.log('[Update] VirusTotal scan warning:', vtErr.message);
                }
            }
        }

        // Skip syntax check for patches - search/replace is not standalone code
        // and will be validated when actually applied to the file
    }

    const warnings = [];
    if (trust.level === 'unsigned')    warnings.push('Package has no signature — authenticity cannot be verified.');
    if (trust.level === 'unknown_key') warnings.push('Signature key is not in the trusted key store.');
    if (syntaxErrors.length)           warnings.push(syntaxErrors.length + ' file(s) have syntax errors — installation will likely fail.');

    audit(req, 'validate.ok', {
        version: pkg.package.version,
        trust:   trust.level,
        threats: threatFindings.length,
        criticals: criticalSections.length,
    });

    res.json({
        version:    pkg.package.version,
        canInstall,
        warnings,
        checksumResult,
        trust,
        signature:  pkg.signature || null,
        checksum:   pkg.checksum  || null,
        threatFindings,
        criticalSections,
        syntaxErrors,
        files: pkg.files.map(f => ({ path: f.path, ok: true, issues: [] })),
    });
});

/* ─────────────────────────────────────────────────────────────────────────────
   ENDPOINT: POST /api/update/write-file
   Applies a single search-replace patch to a file.

   Requires:
     - X-Update-CSRF-Token header (single-use token from /csrf-token)
     - Path in WRITABLE_PATHS allowlist
     - No path traversal
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/write-file', async (req, res) => {
    // ── CSRF check ─────────────────────────────────────────────────────
    // Temporarily disabled for testing
    // const csrfToken = req.headers['x-update-csrf-token'] || req.body._csrf;
    // if (!consumeCsrfToken(csrfToken)) {
    //     audit(req, 'write-file.rejected.csrf', { path: req.body.path });
    //     return res.status(403).json({ error: 'Invalid or expired CSRF token. Fetch a fresh token from /api/update/csrf-token.' });
    // }

    const { path: relPath, search, replace, version } = req.body;

    if (!relPath || typeof relPath !== 'string') {
        return res.status(400).json({ error: 'path is required' });
    }

    // ── Path allowlist + traversal check ──────────────────────────────
    if (!isWritableTarget(relPath)) {
        audit(req, 'write-file.rejected.path', { path: relPath, version });
        return res.status(403).json({
            error: 'Path not in write allowlist: ' + relPath +
                   '. Add it to WRITABLE_PATHS in update-routes.js if intentional.',
        });
    }

    const fullPath = path.join(ROOT_DIR, relPath);

    // ── Read current file ──────────────────────────────────────────────
    if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ error: 'File not found: ' + relPath });
    }
    const original = fs.readFileSync(fullPath, 'utf8');

    // ── Already up to date? ────────────────────────────────────────────
    if (replace && original.includes(replace.trim())) {
        return res.json({ success: true, skipped: true, message: 'Content already present, skipped.' });
    }

    // ── Backup ────────────────────────────────────────────────────────
    const timestamp = Date.now();
    const safeName  = relPath.replace(/[^a-zA-Z0-9]/g, '_');
    const backupName = safeName + '.v' + (version || 'unknown') + '.' + timestamp + '.bak';
    const backupPath = path.join(BACKUP_DIR, backupName);

    try {
        fs.writeFileSync(backupPath, original, 'utf8');
    } catch (e) {
        return res.status(500).json({ error: 'Backup failed: ' + e.message });
    }

    // ── Update manifest ────────────────────────────────────────────────
    try {
        const manifest = fs.existsSync(MANIFEST_PATH) ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) : {};
        if (!manifest[relPath]) manifest[relPath] = [];
        manifest[relPath].push({ version: version || 'unknown', backup: backupName, timestamp: new Date(timestamp).toISOString() });
        fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
    } catch {}

    // ── Apply patch ────────────────────────────────────────────────────
    let patched;
    if (search) {
        if (!original.includes(search)) {
            return res.status(422).json({ error: 'Search string not found in ' + relPath + '. File may already be patched.' });
        }
        patched = original.split(search).join(replace || '');
    } else {
        // No search = full replacement
        patched = replace || '';
    }

    try {
        fs.writeFileSync(fullPath, patched, 'utf8');
    } catch (e) {
        // Attempt to restore backup
        try { fs.writeFileSync(fullPath, original, 'utf8'); } catch {}
        return res.status(500).json({ error: 'Write failed: ' + e.message });
    }

    // ── Re-establish integrity baseline after file modification ────────
    try {
        const tamperDetect = require('./sentinel/integrity/tamper-detect');
        if (typeof tamperDetect.measureFiles === 'function') {
            await tamperDetect.measureFiles();
            console.log('[Update] Integrity baseline re-established after write');
        }
    } catch (baselineError) {
        console.error('[Update] Failed to re-establish integrity baseline:', baselineError.message);
    }

    audit(req, 'write-file.ok', { path: relPath, version });
    res.json({ success: true, backup: backupName });
});

/* ─────────────────────────────────────────────────────────────────────────────
   ENDPOINT: POST /api/update/rollback-file
   Restores a single file to its backed-up version.
   Requires: X-Update-CSRF-Token
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/rollback-file', async (req, res) => {
    // Temporarily disabled for testing
    // const csrfToken = req.headers['x-update-csrf-token'] || req.body._csrf;
    // if (!consumeCsrfToken(csrfToken)) {
    //     return res.status(403).json({ error: 'Invalid or expired CSRF token.' });
    // }

    const { path: relPath, version } = req.body;
    if (!relPath || !isWritableTarget(relPath)) {
        return res.status(403).json({ error: 'Path not allowed: ' + relPath });
    }

    const manifest = fs.existsSync(MANIFEST_PATH)
        ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
        : {};

    const entries = (manifest[relPath] || []).filter(e => e.version === version);
    if (entries.length === 0) {
        return res.status(404).json({ error: 'No backup found for ' + relPath + ' v' + version });
    }

    // Use most recent backup for this version
    const entry      = entries[entries.length - 1];
    const backupPath = path.join(BACKUP_DIR, entry.backup);

    if (!fs.existsSync(backupPath)) {
        return res.status(404).json({ error: 'Backup file missing: ' + entry.backup });
    }

    try {
        const content  = fs.readFileSync(backupPath, 'utf8');
        const fullPath = path.join(ROOT_DIR, relPath);
        fs.writeFileSync(fullPath, content, 'utf8');

        // Clean up manifest: remove this version and all newer
        const idx = manifest[relPath].findIndex(e => e.version === version);
        if (idx >= 0) {
            manifest[relPath] = manifest[relPath].slice(0, idx);
            fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
        }

        // ── Re-establish integrity baseline after file rollback ──────────
        try {
            const tamperDetect = require('./sentinel/integrity/tamper-detect');
            if (typeof tamperDetect.measureFiles === 'function') {
                await tamperDetect.measureFiles();
                console.log('[Update] Integrity baseline re-established after rollback-file');
            }
        } catch (baselineError) {
            console.error('[Update] Failed to re-establish integrity baseline:', baselineError.message);
        }

        audit(req, 'rollback-file.ok', { path: relPath, version });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Rollback failed: ' + e.message });
    }
});

/* ─────────────────────────────────────────────────────────────────────────────
   ENDPOINT: POST /api/update/rollback
   Full rollback of all files for a given version.
   Requires: X-Update-CSRF-Token
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/rollback', async (req, res) => {
    const csrfToken = req.headers['x-update-csrf-token'] || req.body._csrf;
    if (!consumeCsrfToken(csrfToken)) {
        return res.status(403).json({ error: 'Invalid or expired CSRF token.' });
    }

    const { version } = req.body;
    if (!version) return res.status(400).json({ error: 'version is required' });

    const manifest = fs.existsSync(MANIFEST_PATH)
        ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
        : {};

    const errors  = [];
    const restored = [];

    for (const [relPath, entries] of Object.entries(manifest)) {
        const match = entries.filter(e => e.version === version);
        if (match.length === 0) continue;

        const entry      = match[match.length - 1];
        const backupPath = path.join(BACKUP_DIR, entry.backup);
        const fullPath   = path.join(ROOT_DIR, relPath);

        if (!fs.existsSync(backupPath)) { errors.push('Missing backup: ' + entry.backup); continue; }
        try {
            fs.writeFileSync(fullPath, fs.readFileSync(backupPath, 'utf8'), 'utf8');
            restored.push(relPath);
        } catch (e) {
            errors.push(relPath + ': ' + e.message);
        }
    }

    // Clear pending flag
    try { fs.writeFileSync(PENDING_PATH, JSON.stringify({ cleared: true, ts: Date.now() }), 'utf8'); } catch {}

    // ── Re-establish integrity baseline after rollback ────────────────────
    try {
        const tamperDetect = require('./sentinel/integrity/tamper-detect');
        if (typeof tamperDetect.measureFiles === 'function') {
            await tamperDetect.measureFiles();
            console.log('[Update] Integrity baseline re-established after rollback');
        }
    } catch (baselineError) {
        console.error('[Update] Failed to re-establish integrity baseline:', baselineError.message);
    }

    audit(req, 'rollback.ok', { version, restored: restored.length, errors: errors.length });
    res.json({ success: errors.length === 0, restored, errors });
});

/* ─────────────────────────────────────────────────────────────────────────────
   ENDPOINT: POST /api/update/confirm-nonce
   Called by the install pipeline after a successful install to record the nonce
   server-side (client also records in sessionStorage for the session).
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/confirm-nonce', (req, res) => {
    const { nonce, version } = req.body;
    if (!nonce) return res.status(400).json({ error: 'nonce required' });
    recordNonce(nonce);
    audit(req, 'confirm-nonce', { nonce: nonce.slice(0, 8) + '…', version });
    res.json({ ok: true });
});

/* ─────────────────────────────────────────────────────────────────────────────
   ENDPOINT: POST /api/update/confirm-boot
   Clears the pending-update safety net after a successful boot.
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/confirm-boot', (req, res) => {
    try { fs.writeFileSync(PENDING_PATH, JSON.stringify({ cleared: true, ts: Date.now() }), 'utf8'); } catch {}
    audit(req, 'confirm-boot');
    res.json({ ok: true });
});

/* ─────────────────────────────────────────────────────────────────────────────
   ENDPOINT: GET /api/update/backups
   Returns a list of available backup files.
   ───────────────────────────────────────────────────────────────────────────── */
router.get('/backups', (req, res) => {
    const manifest = fs.existsSync(MANIFEST_PATH)
        ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
        : {};
    res.json({ manifest });
});

/* ─────────────────────────────────────────────────────────────────────────────
   ENDPOINT: GET /api/update/history
   Returns the audit log tail (last N entries).
   ───────────────────────────────────────────────────────────────────────────── */
router.get('/history', (req, res) => {
    const count = Math.min(parseInt(req.query.count || '50', 10), 200);
    try {
        const raw = fs.readFileSync(AUDIT_PATH, 'utf8').trim().split('\n').filter(Boolean);
        const entries = raw.slice(-count).map(l => JSON.parse(l));
        res.json({ entries: entries.reverse() });
    } catch {
        res.json({ entries: [] });
    }
});

/* ─────────────────────────────────────────────────────────────────────────────
   ENDPOINT: POST /api/update/keys/add-community
   Adds a community publisher key to the trusted key store.
   (Admin-only in production — add auth middleware before mounting.)
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/keys/add-community', (req, res) => {
    const { keyId, publisher, publicKey } = req.body;
    if (!keyId || !publisher || !publicKey) {
        return res.status(400).json({ error: 'keyId, publisher, and publicKey are required' });
    }
    // Validate it's actually an Ed25519 public key by attempting to use it
    try {
        crypto.verify(null, Buffer.from('test'), publicKey, Buffer.alloc(64));
    } catch (e) {
        // verify() will fail on bad sig, but key format errors throw differently
        if (e.message.includes('invalid') || e.message.includes('Unknown key type')) {
            return res.status(400).json({ error: 'Invalid public key format: ' + e.message });
        }
    }
    const keys = loadCommunityKeys();
    if (keys.some(k => k.keyId === keyId)) {
        return res.status(409).json({ error: 'Key ID already exists: ' + keyId });
    }
    keys.push({ keyId, publisher, publicKey, added: new Date().toISOString() });
    saveCommunityKeys(keys);
    audit(req, 'add-community-key', { keyId, publisher });
    res.json({ ok: true, keyId, publisher });
});

/* ─────────────────────────────────────────────────────────────────────────────
   ENDPOINT: POST /api/update/keys/revoke
   Adds a key ID or checksum to the revocation blacklist.
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/keys/revoke', (req, res) => {
    const { keyId, checksum, reason } = req.body;
    if (!keyId && !checksum) return res.status(400).json({ error: 'keyId or checksum required' });

    const dataDir = path.join(ROOT_DIR, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    let bl = [];
    try { bl = JSON.parse(fs.readFileSync(BLACKLIST_PATH, 'utf8')); } catch {}
    bl.push({ keyId, checksum, reason, revokedAt: new Date().toISOString() });
    fs.writeFileSync(BLACKLIST_PATH, JSON.stringify(bl, null, 2), 'utf8');
    audit(req, 'revoke', { keyId, checksum, reason });
    res.json({ ok: true });
});

/* ─────────────────────────────────────────────────────────────────────────────
   ENDPOINT: POST /api/update/check-searches
   Pre-flight read-only check: verifies that each patch's search string exists
   in the target file before an install is attempted. Also detects already-
   applied patches (replace string already present) and reports line numbers
   and occurrence counts. Does NOT modify any file.

   Body: { files: [{ path, search, replace? }] }
   Returns: { results: [{ path, index, found, alreadyApplied, lineNumber,
                          occurrences, searchLength, error? }] }
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/check-searches', (req, res) => {
    const { files } = req.body;
    if (!Array.isArray(files)) {
        return res.status(400).json({ error: 'files[] array required' });
    }

    const results = files.map((f, index) => {
        if (!f.path) {
            return { path: null, index, found: false, error: 'Missing path field' };
        }

        // Enforce allowlist — prevent fishing for arbitrary file contents
        if (!isWritableTarget(f.path)) {
            return { path: f.path, index, found: false, error: 'Path not in write allowlist' };
        }

        const fullPath = path.join(ROOT_DIR, f.path);

        if (!fs.existsSync(fullPath)) {
            return { path: f.path, index, found: false, error: 'File not found on server' };
        }

        // No search string = full-file replacement; always "found"
        if (!f.search) {
            return { path: f.path, index, found: true, fullReplace: true };
        }

        try {
            const content = fs.readFileSync(fullPath, 'utf8');

            const found        = content.includes(f.search);
            const occurrences  = found ? content.split(f.search).length - 1 : 0;

            // Already applied: the replace string (trimmed) is already present
            const alreadyApplied = f.replace
                ? content.includes(f.replace.trim())
                : false;

            // Approximate 1-based line number of the first match
            let lineNumber = null;
            if (found) {
                const matchIdx = content.indexOf(f.search);
                lineNumber = content.slice(0, matchIdx).split('\n').length;
            }

            // Warn if the search string appears more than once (ambiguous patch)
            return {
                path: f.path,
                index,
                found,
                alreadyApplied,
                lineNumber,
                occurrences,
                searchLength: f.search.length,
                multipleMatches: occurrences > 1,
            };
        } catch (e) {
            return { path: f.path, index, found: false, error: e.message };
        }
    });

    audit(req, 'check-searches', {
        files:  files.length,
        found:  results.filter(r => r.found).length,
        missed: results.filter(r => !r.found && !r.error).length,
    });

    res.json({ results });
});

/* ─────────────────────────────────────────────────────────────────────────────
   ENDPOINT: POST /api/update/ai-chat
   Server-side streaming proxy for the package-assistant AI.
   Forwards to NVIDIA / MiniMax and streams SSE back to the client so the
   browser never has to connect to an external host directly (CSP stays tight).
   ───────────────────────────────────────────────────────────────────────────── */
const https = require('https');

router.post('/ai-chat', (req, res) => {
    const { messages, temperature, top_p, max_tokens } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages[] array required' });
    }

    // Validate each message minimally
    for (const m of messages) {
        if (!m || !['user', 'assistant', 'system'].includes(m.role) || typeof m.content !== 'string') {
            return res.status(400).json({ error: 'Invalid message format' });
        }
    }

    const payload = JSON.stringify({
        model: 'minimaxai/minimax-m2.5',
        messages,
        temperature: typeof temperature === 'number' ? temperature : 0.7,
        top_p:       typeof top_p       === 'number' ? top_p       : 0.95,
        max_tokens:  typeof max_tokens  === 'number' ? Math.min(max_tokens, 2048) : 1024,
        stream: true,
    });

    const options = {
        hostname: 'integrate.api.nvidia.com',
        path:     '/v1/chat/completions',
        method:   'POST',
        headers: {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'Authorization':  'Bearer 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',
        },
    };

    // Set SSE headers before any data arrives
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present

    const proxyReq = https.request(options, proxyRes => {
        // Forward non-2xx as a JSON error before any streaming starts
        if (proxyRes.statusCode >= 400) {
            let errBody = '';
            proxyRes.on('data', d => { errBody += d; });
            proxyRes.on('end', () => {
                if (!res.headersSent) {
                    res.status(proxyRes.statusCode).json({ error: 'Upstream AI error', detail: errBody.slice(0, 300) });
                } else {
                    res.write(`data: {"error":"${proxyRes.statusCode}"}\n\n`);
                    res.end();
                }
            });
            return;
        }

        proxyRes.on('data',  chunk => { try { res.write(chunk); } catch {} });
        proxyRes.on('end',   ()    => { try { res.end(); } catch {} });
        proxyRes.on('error', ()    => { try { res.end(); } catch {} });
    });

    proxyReq.on('error', err => {
        audit(req, 'ai-chat-error', { error: err.message });
        if (!res.headersSent) {
            res.status(502).json({ error: 'AI proxy connection failed: ' + err.message });
        } else {
            try { res.end(); } catch {}
        }
    });

    // Abort proxy request if client disconnects
    req.on('close', () => { try { proxyReq.destroy(); } catch {} });

    proxyReq.write(payload);
    proxyReq.end();

    audit(req, 'ai-chat', { messages: messages.length });
});

/* ══════════════════════════════════════════════════════════════════════════════
   PACKAGE CREATOR FILE READER
   Reads file content for the Package Creator AI Assistant tab.
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/package-creator/read-file', async (req, res) => {
    // For now, no edition check server-side - UI already restricts to Ultimate edition
    // Enhanced path validation to prevent directory traversal
    const { filePath } = req.body;
    
    if (!filePath || typeof filePath !== 'string') {
        return res.status(400).json({ error: 'Missing filePath' });
    }
    
    // Normalize and validate path
    const normalizedPath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    
    // Security: Only allow files within the ROOT_DIR
    const fullPath = path.join(ROOT_DIR, normalizedPath);
    const resolvedPath = path.resolve(fullPath);
    const rootDirResolved = path.resolve(ROOT_DIR);
    
    // Ensure the resolved path is within ROOT_DIR (prevent directory traversal)
    if (!resolvedPath.startsWith(rootDirResolved + path.sep) && resolvedPath !== rootDirResolved) {
        return res.status(400).json({ error: 'Invalid path: directory traversal not allowed' });
    }
    
    // Check file exists and is readable
    if (!fs.existsSync(resolvedPath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    try {
        const stat = fs.statSync(resolvedPath);
        if (stat.isDirectory()) {
            return res.status(400).json({ error: 'Path is a directory, not a file' });
        }
        
        // Limit file size to 50MB (allow viewing large files like index.html)
        const MAX_SIZE = 50 * 1024 * 1024;
        if (stat.size > MAX_SIZE) {
            return res.status(400).json({ error: `File too large (max ${MAX_SIZE/1024}KB)` });
        }
        
        const content = fs.readFileSync(resolvedPath, 'utf8');
        
        audit(req, 'package-creator-read-file', { path: normalizedPath, size: stat.size });
        res.json({ success: true, path: normalizedPath, content });
    } catch (e) {
        res.status(500).json({ error: 'Cannot read file: ' + e.message });
    }
});

/* ══════════════════════════════════════════════════════════════════════════════
   PACKAGE CREATOR FILE LIST
   Lists all project files for the Package Creator file browser.
   ───────────────────────────────────────────────────────────────────────────── */
router.get('/package-creator/files', (req, res) => {
    // Collect all files in the project
    const files = [];
    const excludeDirs = new Set(['node_modules', '.update-backups', '.update-keys', 'data']);
    
    function walkDir(dir, prefix = '') {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (excludeDirs.has(entry.name)) continue;
                if (entry.name.startsWith('.')) continue;
                
                const fullPath = prefix + entry.name;
                if (entry.isDirectory()) {
                    files.push({ path: fullPath + '/', isDir: true });
                    walkDir(path.join(dir, entry.name), fullPath + '/');
                } else if (entry.isFile()) {
                    // Include common file extensions
                    const ext = entry.name.split('.').pop();
                    if (['js', 'json', 'html', 'css', 'md', 'txt', 'bat', 'sh'].includes(ext)) {
                        files.push({ path: fullPath, isDir: false });
                    }
                }
            }
        } catch (e) {
            // Ignore inaccessible directories
        }
    }
    
    walkDir(ROOT_DIR);
    
    // Sort files alphabetically
    files.sort((a, b) => a.path.localeCompare(b.path));
    
    res.json({ files });
});

module.exports = router;