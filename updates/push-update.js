#!/usr/bin/env node
/**
 * NovaByte OS — Push Update CLI  (updates/push-update.js)
 *
 * Developer tool.  Builds, signs, and publishes an update package to the
 * server channel.  Once published every connected client is notified in
 * real-time via Socket.IO and starts polling for the package.
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │  QUICK WORKFLOW                                                        │
 * │                                                                        │
 * │  # 1 — push a signed package you already created                      │
 * │  node updates/push-update.js --pkg my-update.signed.json              │
 * │                                                                        │
 * │  # 2 — diff index.html vs its last backup and generate a patch pkg    │
 * │  node updates/push-update.js --auto-diff --version 1.2.3              │
 * │         --description "Bug fixes" --changelog "- Fixed X\n- Fixed Y"  │
 * │                                                                        │
 * │  # 3 — push to beta channel instead of stable                         │
 * │  node updates/push-update.js --pkg pkg.json --channel beta            │
 * │                                                                        │
 * │  # 4 — retract the current stable release                             │
 * │  node updates/push-update.js --retract [--channel stable]             │
 * │                                                                        │
 * │  # 5 — check what's published on all channels                         │
 * │  node updates/push-update.js --status                                 │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Config (all optional — env or .env file):
 *   UPDATE_ADMIN_TOKEN   Secret token matching the server's .env
 *   UPDATE_SERVER_URL    Base URL of your NovaByte server (default: https://localhost:3000)
 *   UPDATE_CHANNEL       Default channel (default: stable)
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const https   = require('https');
const http    = require('http');
const readline = require('readline');

/* ─────────────────────────────────────────────────────────────────────────────
   CONFIG
   ───────────────────────────────────────────────────────────────────────────── */
const CONFIG = {
    serverUrl:   process.env.UPDATE_SERVER_URL  || 'https://localhost:3000',
    adminToken:  process.env.UPDATE_ADMIN_TOKEN || '',
    channel:     process.env.UPDATE_CHANNEL     || 'stable',
    keysDir:     path.join(__dirname, '..', '.update-keys'),
    backupDir:   path.join(__dirname, '..', '.update-backups'),
};

/* ─────────────────────────────────────────────────────────────────────────────
   COLOUR HELPERS
   ───────────────────────────────────────────────────────────────────────────── */
const c = {
    reset:  '\x1b[0m',
    bold:   '\x1b[1m',
    dim:    '\x1b[2m',
    green:  '\x1b[32m',
    yellow: '\x1b[33m',
    red:    '\x1b[31m',
    cyan:   '\x1b[36m',
    blue:   '\x1b[34m',
    white:  '\x1b[37m',
};
const ok   = s => `${c.green}✔${c.reset}  ${s}`;
const err  = s => `${c.red}✖${c.reset}  ${s}`;
const info = s => `${c.cyan}ℹ${c.reset}  ${s}`;
const warn = s => `${c.yellow}⚠${c.reset}  ${s}`;
const bold = s => `${c.bold}${s}${c.reset}`;

/* ─────────────────────────────────────────────────────────────────────────────
   ARG PARSING
   ───────────────────────────────────────────────────────────────────────────── */
function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
            args[key] = val;
        }
    }
    return args;
}

/* ─────────────────────────────────────────────────────────────────────────────
   HTTP CLIENT  (no external deps — uses Node built-ins)
   ───────────────────────────────────────────────────────────────────────────── */
function request(method, urlStr, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const url    = new URL(urlStr);
        const mod    = url.protocol === 'https:' ? https : http;
        const bodyBuf = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;

        const options = {
            hostname: url.hostname,
            port:     url.port || (url.protocol === 'https:' ? 443 : 80),
            path:     url.pathname + url.search,
            method,
            headers: {
                'Content-Type':  'application/json',
                'x-admin-token': CONFIG.adminToken,
                ...headers,
                ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}),
            },
            // Allow self-signed certs in dev
            rejectUnauthorized: false,
        };

        const req = mod.request(options, res => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });

        req.on('error', reject);
        if (bodyBuf) req.write(bodyBuf);
        req.end();
    });
}

/* ─────────────────────────────────────────────────────────────────────────────
   SIGNING  (Ed25519 via Node crypto — same as update-routes.js)
   ───────────────────────────────────────────────────────────────────────────── */
function loadKey(type = 'official') {
    const keyFile = path.join(CONFIG.keysDir, `${type}.json`);
    if (!fs.existsSync(keyFile)) return null;
    try { return JSON.parse(fs.readFileSync(keyFile, 'utf8')); }
    catch { return null; }
}

function signPackage(pkg, keyType = 'official') {
    const key = loadKey(keyType);
    if (!key || !key.privateKey) {
        console.log(warn(`No ${keyType} private key found — package will be unsigned`));
        return pkg;
    }

    const payload  = JSON.stringify({ ...pkg, signature: undefined });
    const sigBuf   = crypto.sign(null, Buffer.from(payload), {
        key:    key.privateKey,
        format: 'pem',
        type:   'pkcs8',
        dsaEncoding: 'der',
    });

    return {
        ...pkg,
        signature: {
            keyId:     keyType,
            algorithm: 'ed25519',
            value:     sigBuf.toString('base64'),
            signedAt:  new Date().toISOString(),
        },
    };
}

/* ─────────────────────────────────────────────────────────────────────────────
   AUTO-DIFF  — Generate a str_replace patch from index.html vs its backup
   ───────────────────────────────────────────────────────────────────────────── */
function autoDiffIndex(version, description, changelog) {
    const indexPath  = path.join(__dirname, '..', 'index.html');
    const backupPath = (() => {
        if (!fs.existsSync(CONFIG.backupDir)) return null;
        const files = fs.readdirSync(CONFIG.backupDir)
            .filter(f => f.startsWith('index_html') && f.endsWith('.bak'))
            .sort()
            .reverse();
        return files.length ? path.join(CONFIG.backupDir, files[0]) : null;
    })();

    if (!backupPath) {
        throw new Error('No index.html backup found in .update-backups/. Cannot auto-diff.');
    }

    const newContent = fs.readFileSync(indexPath,  'utf8');
    const oldContent = fs.readFileSync(backupPath, 'utf8');

    if (newContent === oldContent) {
        throw new Error('index.html is identical to the latest backup — nothing to patch.');
    }

    // Generate a real unified diff — no more hand-written search strings
    const diffLib     = require('diff');
    const unifiedDiff = diffLib.createPatch(
        'index.html',
        oldContent.replace(/\r\n/g, '\n'),  // normalise to LF; server restores CRLF if needed
        newContent.replace(/\r\n/g, '\n'),
        'old',
        'new',
        { context: 3 }
    );

    const pkg = {
        package: {
            name:        'NovaByte OS',
            version:     version || '0.0.0',
            description: description || 'Auto-generated update',
            changelog:   changelog   || '- See commit history',
            channel:     CONFIG.channel,
        },
        files: [
            {
                path:        'index.html',
                description: 'Auto-diff patch generated from backup comparison',
                diff:        unifiedDiff,
            },
        ],
        issuedAt:  new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        nonce:     crypto.randomUUID(),
    };

    pkg.checksum = crypto.createHash('sha256').update(JSON.stringify(pkg)).digest('hex');

    return pkg;
}

/* ─────────────────────────────────────────────────────────────────────────────
   PROGRESS SPINNER
   ───────────────────────────────────────────────────────────────────────────── */
function spinner(text) {
    const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    let i = 0;
    const iv = setInterval(() => {
        process.stdout.write(`\r${c.cyan}${frames[i++ % frames.length]}${c.reset}  ${text}`);
    }, 80);
    return {
        succeed: msg => { clearInterval(iv); process.stdout.write(`\r${ok(msg)}\n`); },
        fail:    msg => { clearInterval(iv); process.stdout.write(`\r${err(msg)}\n`); },
        text:    t   => { text = t; },
    };
}

/* ─────────────────────────────────────────────────────────────────────────────
   HUMAN-READABLE BYTES
   ───────────────────────────────────────────────────────────────────────────── */
function humanBytes(n) {
    if (n < 1024)        return `${n} B`;
    if (n < 1024 ** 2)   return `${(n/1024).toFixed(1)} KB`;
    if (n < 1024 ** 3)   return `${(n/1024**2).toFixed(2)} MB`;
    return `${(n/1024**3).toFixed(2)} GB`;
}

/* ─────────────────────────────────────────────────────────────────────────────
   MAIN
   ───────────────────────────────────────────────────────────────────────────── */
async function main() {
    const args = parseArgs(process.argv);

    // Override defaults from flags
    if (args.channel && ['stable','beta','nightly'].includes(args.channel)) {
        CONFIG.channel = args.channel;
    }
    if (args.token) CONFIG.adminToken = args.token;
    if (args.server) CONFIG.serverUrl = args.server;

    console.log('');
    console.log(`${c.bold}${c.cyan}NovaByte OS — Push Update CLI${c.reset}`);
    console.log(`${c.dim}Server: ${CONFIG.serverUrl}   Channel: ${CONFIG.channel}${c.reset}`);
    console.log('');

    if (!CONFIG.adminToken) {
        console.log(err('UPDATE_ADMIN_TOKEN is not set.'));
        console.log(info('Set it in .env or pass --token YOUR_TOKEN'));
        process.exit(1);
    }

    /* ── STATUS ──────────────────────────────────────────────────────────── */
    if (args.status) {
        const sp = spinner('Fetching channel status…');
        try {
            const { status, body } = await request(
                'GET',
                `${CONFIG.serverUrl}/api/autoupdate/status`,
            );
            sp.succeed('Channel status');
            if (status !== 200) {
                console.log(err(`Server returned ${status}: ${JSON.stringify(body)}`));
                process.exit(1);
            }
            const { channels, recentAudit } = body;
            console.log('');
            for (const [ch, meta] of Object.entries(channels)) {
                if (!meta) {
                    console.log(`  ${c.dim}${ch.padEnd(10)}${c.reset} — no update published`);
                } else {
                    const ts = new Date(meta.publishedAt).toLocaleString();
                    console.log(
                        `  ${c.bold}${ch.padEnd(10)}${c.reset}` +
                        ` v${c.green}${meta.version}${c.reset}` +
                        `  ${c.dim}${ts}  ${humanBytes(meta.sizeBytes)}  ${meta.trust}${c.reset}`
                    );
                }
            }
            console.log('');
            if (recentAudit.length) {
                console.log(`${c.dim}Recent audit (last ${recentAudit.length}):${c.reset}`);
                recentAudit.slice(-5).forEach(e => {
                    console.log(`  ${c.dim}${e.ts}  ${e.event}  ${e.version || ''}${c.reset}`);
                });
            }
            console.log('');
        } catch (e) {
            sp.fail(`Request failed: ${e.message}`);
            process.exit(1);
        }
        return;
    }

    /* ── RETRACT ─────────────────────────────────────────────────────────── */
    if (args.retract) {
        const sp = spinner(`Retracting update on ${CONFIG.channel}…`);
        try {
            const { status, body } = await request(
                'POST',
                `${CONFIG.serverUrl}/api/autoupdate/retract`,
                { channel: CONFIG.channel },
            );
            if (status === 200) {
                sp.succeed(`Retracted v${body.version} from ${CONFIG.channel}`);
            } else {
                sp.fail(`Server returned ${status}: ${body.error || JSON.stringify(body)}`);
                process.exit(1);
            }
        } catch (e) {
            sp.fail(`Request failed: ${e.message}`);
            process.exit(1);
        }
        return;
    }

    /* ── LOAD OR BUILD PACKAGE ───────────────────────────────────────────── */
    let pkg;

    if (args['auto-diff']) {
        // Auto-generate patch from index.html vs backup
        const version     = typeof args.version     === 'string' ? args.version     : null;
        const description = typeof args.description === 'string' ? args.description : null;
        const changelog   = typeof args.changelog   === 'string' ? args.changelog   : null;

        if (!version) {
            console.log(err('--auto-diff requires --version X.Y.Z'));
            process.exit(1);
        }

        const sp = spinner('Computing diff between index.html and last backup…');
        try {
            pkg = autoDiffIndex(version, description, changelog);
            sp.succeed(`Auto-diff complete — ${pkg.patches.length} patch(es)`);
        } catch (e) {
            sp.fail(e.message);
            process.exit(1);
        }

    } else if (args.pkg) {
        // Load a pre-built package JSON
        const pkgPath = path.resolve(args.pkg);
        if (!fs.existsSync(pkgPath)) {
            console.log(err(`Package file not found: ${pkgPath}`));
            process.exit(1);
        }
        try {
            pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            const version = pkg.package?.version || pkg.version;
            console.log(ok(`Loaded package v${version} from ${path.basename(pkgPath)}`));
        } catch (e) {
            console.log(err(`Failed to parse package: ${e.message}`));
            process.exit(1);
        }

    } else {
        console.log(`${c.bold}Usage:${c.reset}`);
        console.log('  node updates/push-update.js --pkg <file.json>          Push a pre-built package');
        console.log('  node updates/push-update.js --auto-diff --version X.Y  Diff & push index.html');
        console.log('  node updates/push-update.js --retract                  Retract current release');
        console.log('  node updates/push-update.js --status                   Show channel status');
        console.log('');
        console.log(`${c.bold}Options:${c.reset}`);
        console.log('  --channel  stable|beta|nightly    (default: stable / UPDATE_CHANNEL env)');
        console.log('  --token    admin token            (default: UPDATE_ADMIN_TOKEN env)');
        console.log('  --server   server URL             (default: https://localhost:3000)');
        console.log('  --sign     Sign with official key before publishing');
        console.log('  --yes      Skip confirmation prompt');
        console.log('');
        process.exit(0);
    }

    /* ── OPTIONALLY SIGN ─────────────────────────────────────────────────── */
    if (args.sign && !pkg.signature) {
        const sp = spinner('Signing with official Ed25519 key…');
        pkg = signPackage(pkg, 'official');
        if (pkg.signature) {
            sp.succeed('Package signed');
        } else {
            sp.fail('Signing failed — key not found; continuing unsigned');
        }
    }

    /* ── SUMMARY ─────────────────────────────────────────────────────────── */
    const pkgJson   = JSON.stringify(pkg);
    const sizeBytes = Buffer.byteLength(pkgJson, 'utf8');
    const checksum  = crypto.createHash('sha256').update(pkgJson).digest('hex');

    console.log('');
    console.log(`  ${c.bold}Package Summary${c.reset}`);
    console.log(`  ─────────────────────────────────────────`);
    console.log(`  Name        ${bold(pkg.package?.name || pkg.name || 'NovaByte OS')}`);
    console.log(`  Version     ${c.green}${bold(pkg.package?.version || pkg.version)}${c.reset}`);
    console.log(`  Channel     ${bold(CONFIG.channel)}`);
    console.log(`  Patches     ${pkg.files?.length ?? pkg.patches?.length ?? 0}`);
    console.log(`  Size        ${humanBytes(sizeBytes)}`);
    console.log(`  Checksum    ${c.dim}${checksum.slice(0, 32)}…${c.reset}`);
    console.log(`  Signed      ${pkg.signature ? `${c.green}Yes (${pkg.signature.keyId})${c.reset}` : `${c.yellow}No${c.reset}`}`);
    if (pkg.package?.description || pkg.description) console.log(`  Description ${pkg.package?.description || pkg.description}`);
    console.log('');

    /* ── CONFIRM ─────────────────────────────────────────────────────────── */
    if (!args.yes) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise(resolve => {
            rl.question(
                `  Publish v${pkg.package?.version || pkg.version} to ${bold(CONFIG.channel)} at ${CONFIG.serverUrl}? [y/N] `,
                resolve
            );
        });
        rl.close();
        if (!answer.toLowerCase().startsWith('y')) {
            console.log(warn('Aborted.'));
            process.exit(0);
        }
    }

    /* ── PUBLISH ─────────────────────────────────────────────────────────── */
    console.log('');
    const sp = spinner(`Publishing v${pkg.package?.version || pkg.version} to ${CONFIG.channel}…`);
    try {
        const { status, body } = await request(
            'POST',
            `${CONFIG.serverUrl}/api/autoupdate/publish`,
            { pkg, channel: CONFIG.channel },
        );

        if (status === 200 && body.ok) {
            sp.succeed(`Published v${body.package?.version || body.version} to ${body.channel} (${humanBytes(body.sizeBytes)})`);
            console.log('');
            console.log(ok(`Checksum: ${c.dim}${body.checksum}${c.reset}`));
            console.log(ok(`Published at: ${body.publishedAt}`));
            console.log('');
            console.log(info('All connected clients will receive a notification immediately.'));
            console.log(info('Polling clients will detect this on their next check interval.'));
            console.log('');
        } else {
            sp.fail(`Server returned ${status}: ${body.error || JSON.stringify(body)}`);
            if (body.hint) console.log(info(body.hint));
            process.exit(1);
        }
    } catch (e) {
        sp.fail(`Request failed: ${e.message}`);
        console.log(info('Is the NovaByte server running? Check UPDATE_SERVER_URL.'));
        process.exit(1);
    }
}

main().catch(e => {
    console.error(err('Unexpected error: ' + e.message));
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
});