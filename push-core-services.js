#!/usr/bin/env node
/**
 * DEPRECATED — This file is no longer used.
 *
 * To publish a Nova Core Services update:
 *   1. Edit your files and commit to GitHub
 *   2. Tag the release: git tag cs-v2026.05.3 && git push --tags
 *   3. Go to github.com/NovaByteOfficial/novabyte-os/releases/new
 *   4. Select your tag, write changelog in the release notes, publish
 *
 * The update system will automatically detect the new release via GitHub API.
 * No server is required. Forks can point to their own repository via nova-custom.json.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * LEGACY DOCUMENTATION (kept for reference):
 *
 * NovaByte OS — Push Core Services Update CLI
 * (updates/push-core-services.js)  v1.0
 *
 * Builds, signs, and publishes a Nova Core Services System Update package.
 * Unlike the OS updater, Core Services packages target files in /js/ only.
 */

'use strict';

throw new Error(
  'push-core-services.js is deprecated.\n' +
  'Use GitHub releases instead:\n' +
  '  1. Tag: git tag cs-v2026.05.3\n' +
  '  2. Push: git push --tags\n' +
  '  3. Release: github.com/NovaByteOfficial/novabyte-os/releases/new\n'
);
    console.log(`${c.blue}│${c.reset} ${c.bold}${title.padEnd(w - 2)}${c.reset} ${c.blue}│${c.reset}`);
    console.log(`${c.blue}├${'─'.repeat(w)}┤${c.reset}`);
    for (const line of lines) {
        console.log(`${c.blue}│${c.reset} ${line.padEnd(w - 2)} ${c.blue}│${c.reset}`);
    }
    console.log(`${c.blue}└${'─'.repeat(w)}┘${c.reset}`);
}

/* ─────────────────────────────────────────────────────────────────────────────
   ARG PARSING
   ───────────────────────────────────────────────────────────────────────────── */
function parseArgs() {
    const args = process.argv.slice(2);
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const [key, ...rest] = arg.slice(2).split('=');
            flags[key] = rest.length ? rest.join('=') : (args[i + 1]?.startsWith('--') ? true : (args[++i] ?? true));
        }
    }
    return flags;
}

/* ─────────────────────────────────────────────────────────────────────────────
   HTTP HELPER
   ───────────────────────────────────────────────────────────────────────────── */
function apiRequest(method, urlPath, body, token) {
    return new Promise((resolve, reject) => {
        const url     = new URL(CONFIG.serverUrl + urlPath);
        const isHttps = url.protocol === 'https:';
        const mod     = isHttps ? https : http;
        const payload = body ? JSON.stringify(body) : null;

        const options = {
            hostname: url.hostname,
            port:     url.port || (isHttps ? 443 : 80),
            path:     url.pathname + url.search,
            method,
            headers: {
                'Content-Type':  'application/json',
                'X-Admin-Token': token || '',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
            },
            rejectUnauthorized: false, // dev self-signed cert
        };

        const req = mod.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data }); }
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

/* ─────────────────────────────────────────────────────────────────────────────
   SIGNING
   Uses the same official Ed25519 key as the OS update signer.
   ───────────────────────────────────────────────────────────────────────────── */
function loadOrCreateKey() {
    const keyPath = path.join(CONFIG.keysDir, 'official.json');
    if (!fs.existsSync(keyPath)) {
        err('No signing key found at ' + keyPath);
        err('Start the server once to generate keys, or run sign-package.js first.');
        process.exit(1);
    }
    try {
        return JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    } catch (e) {
        err('Could not load signing key: ' + e.message);
        process.exit(1);
    }
}

function signPackage(pkg, keyData) {
    const payload = JSON.stringify(pkg.package);
    const checksum = crypto.createHash('sha256').update(payload).digest('hex');

    if (keyData.privateKey) {
        try {
            const sig = crypto.sign(null,
                Buffer.from(payload),
                { key: keyData.privateKey, dsaEncoding: 'der' });
            return {
                ...pkg,
                signature: {
                    algorithm: 'Ed25519',
                    keyId:     'official',
                    value:     sig.toString('base64'),
                },
                checksum,
            };
        } catch (e) {
            inf(`Could not sign with Ed25519 (${e.message}) — package will be unsigned`);
        }
    }

    return { ...pkg, checksum };
}

/* ─────────────────────────────────────────────────────────────────────────────
   BUILD PACKAGE FROM FILES
   ───────────────────────────────────────────────────────────────────────────── */
function buildPackageFromFiles(fileList, meta) {
    const patches = [];

    for (const relPath of fileList) {
        const norm = relPath.replace(/\\/g, '/');
        if (!CS_WRITABLE_FILES.has(norm)) {
            err(`${norm} is not in the Core Services writable allowlist — skipped`);
            continue;
        }
        const absPath = path.join(CONFIG.rootDir, norm);
        if (!fs.existsSync(absPath)) {
            err(`${norm} not found on disk — skipped`);
            continue;
        }
        const content = fs.readFileSync(absPath, 'utf8');
        patches.push({
            file:    norm,
            replace: content,    // full-file replacement (simpler than diffs for JS)
            search:  '__FULL_REPLACE__',
        });
        ok(`Included: ${norm}  (${(Buffer.byteLength(content) / 1024).toFixed(1)} KB)`);
    }

    if (patches.length === 0) {
        err('No valid files to include in the package.');
        process.exit(1);
    }

    return {
        package: {
            name:        'Nova Core Services System Update',
            version:     meta.version,
            patchDate:   meta.patchDate,
            description: meta.description,
            changelog:   meta.changelog,
            components:  meta.components || CS_COMPONENTS,
            issuedAt:    new Date().toISOString(),
            expiresAt:   new Date(Date.now() + 90 * 864e5).toISOString(),
            nonce:       crypto.randomBytes(16).toString('hex'),
            channel:     meta.channel,
            files:       patches,
            type:        'core-services',
        },
    };
}

/* ─────────────────────────────────────────────────────────────────────────────
   COMMANDS
   ───────────────────────────────────────────────────────────────────────────── */
async function cmdStatus() {
    hdr('Nova Core Services — Channel Status');
    if (!CONFIG.adminToken) { err('UPDATE_ADMIN_TOKEN not set in .env'); process.exit(1); }
    const r = await apiRequest('GET', '/api/coreservices/status', null, CONFIG.adminToken);
    if (r.status !== 200) { err(`Server returned ${r.status}: ${JSON.stringify(r.body)}`); return; }
    const { channels } = r.body;
    for (const [ch, meta] of Object.entries(channels)) {
        if (!meta) { inf(`${ch}: (nothing published)`); continue; }
        ok(`${ch}: v${meta.version}  ·  patch ${meta.patchDate}  ·  published ${new Date(meta.publishedAt).toLocaleString()}`);
        if (meta.description) inf(`  ${meta.description}`);
    }
}

async function cmdRetract(flags) {
    const channel = flags.channel || CONFIG.channel;
    hdr(`Retracting Core Services update from channel: ${channel}`);
    if (!CONFIG.adminToken) { err('UPDATE_ADMIN_TOKEN not set in .env'); process.exit(1); }
    const r = await apiRequest('POST', '/api/coreservices/retract', { channel }, CONFIG.adminToken);
    if (r.status !== 200) { err(`Retract failed (${r.status}): ${JSON.stringify(r.body)}`); return; }
    ok(r.body.message);
}

async function cmdPush(flags) {
    const channel  = flags.channel  || CONFIG.channel;
    const token    = CONFIG.adminToken;

    if (!token) {
        err('UPDATE_ADMIN_TOKEN not set in .env');
        err('Add UPDATE_ADMIN_TOKEN=<your-token> to .env');
        process.exit(1);
    }

    let pkg;

    // ── Mode A: pre-built package file ──────────────────────────────────────
    if (flags.pkg) {
        const pkgPath = path.resolve(flags.pkg);
        if (!fs.existsSync(pkgPath)) { err(`Package file not found: ${pkgPath}`); process.exit(1); }
        inf(`Loading pre-built package from ${pkgPath}`);
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    // ── Mode B: build from listed files ────────────────────────────────────
    } else if (flags.version) {
        const version   = flags.version;
        const patchDate = flags['patch-date'] || new Date().toISOString().split('T')[0];
        const desc      = flags.description  || 'Nova Core Services System Update';
        const changelog = flags.changelog    || '';
        const filesCsv  = flags.files        || '';
        const fileList  = filesCsv ? filesCsv.split(',').map(s => s.trim()) : [];

        if (fileList.length === 0) {
            err('Specify files to include: --files js/nova-security-api.js,js/session-manager.js');
            err('Or use --pkg to provide a pre-built package JSON.');
            process.exit(1);
        }

        hdr('Building Nova Core Services package');
        inf(`Version:    ${version}`);
        inf(`Patch date: ${patchDate}`);
        inf(`Channel:    ${channel}`);
        inf(`Files:      ${fileList.join(', ')}\n`);

        const raw = buildPackageFromFiles(fileList, { version, patchDate, description: desc, changelog, channel });

        hdr('Signing package');
        const keyData = loadOrCreateKey();
        pkg = signPackage(raw, keyData);
        ok(`Signed  ·  checksum: ${pkg.checksum?.slice(0, 16)}…`);

        // Save locally as a record
        const outName = `cs-${version}-${channel}.signed.json`;
        const outPath = path.join(CONFIG.backupDir, outName);
        fs.mkdirSync(CONFIG.backupDir, { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(pkg, null, 2), 'utf8');
        ok(`Saved locally: ${outPath}`);

    } else {
        console.log(`
${c.bold}Nova Core Services — Push Update${c.reset}

Usage:
  node updates/push-core-services.js --version 2026.05.2 --patch-date 2026-05-15 \\
       --files js/nova-security-api.js,js/session-manager.js \\
       --description "Security fixes" [--channel beta]

  node updates/push-core-services.js --pkg cs-2026.05.2.signed.json [--channel stable]
  node updates/push-core-services.js --status
  node updates/push-core-services.js --retract [--channel stable]

Available --files (Core Services allowlist):
${[...CS_WRITABLE_FILES].map(f => '  ' + f).join('\n')}
`);
        process.exit(0);
    }

    // ── Publish to server ───────────────────────────────────────────────────
    hdr(`Publishing to ${CONFIG.serverUrl}/api/coreservices (channel: ${channel})`);
    const version = pkg.package?.version || pkg.version;
    const size    = (Buffer.byteLength(JSON.stringify(pkg)) / 1024).toFixed(1);
    inf(`Package size: ${size} KB`);

    const r = await apiRequest('POST', '/api/coreservices/publish', { pkg, channel }, token);

    if (r.status === 200) {
        box('✓ Core Services update published', [
            `Version    : ${r.body.version}`,
            `Patch date : ${r.body.patchDate}`,
            `Channel    : ${r.body.channel}`,
            `Size       : ${(r.body.sizeBytes / 1024).toFixed(1)} KB`,
            `Trust      : ${r.body.trust}`,
            `Checksum   : ${r.body.checksum?.slice(0, 24)}…`,
            `Published  : ${new Date(r.body.publishedAt).toLocaleString()}`,
        ]);
        ok('All connected clients have been notified via Socket.IO');
    } else {
        err(`Publish failed (${r.status}): ${r.body?.error || JSON.stringify(r.body)}`);
        if (r.body?.hint) inf(`Hint: ${r.body.hint}`);
        process.exit(1);
    }
}

/* ─────────────────────────────────────────────────────────────────────────────
   ENTRY POINT
   ───────────────────────────────────────────────────────────────────────────── */
(async () => {
    const flags = parseArgs();

    console.log(`\n${c.bold}${c.blue}NovaByte — Nova Core Services System Update Tool${c.reset}`);
    console.log(`${c.dim}Server: ${CONFIG.serverUrl}  ·  Channel: ${flags.channel || CONFIG.channel}${c.reset}\n`);

    try {
        if (flags.status)  { await cmdStatus(); }
        else if (flags.retract) { await cmdRetract(flags); }
        else               { await cmdPush(flags); }
    } catch (e) {
        err(`Unexpected error: ${e.message}`);
        console.error(e);
        process.exit(1);
    }
})();
