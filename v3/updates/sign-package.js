#!/usr/bin/env node
/**
 * NovaByte OS — Package Signer  (sign-package.js)  v2.0
 *
 * Signs an update package JSON with your installation's official Ed25519 key,
 * writes a fresh SHA-256 checksum, embeds an issuedAt timestamp, an expiry
 * date, a cryptographic nonce (to prevent replay attacks), and optionally a
 * release channel (stable | beta | nightly).
 *
 * Usage:
 *   node sign-package.js <input.json> [output.json] [options]
 *
 * Options:
 *   --channel=stable|beta|nightly   Release channel (default: stable)
 *   --expires=<days>                Days until the package expires (default: 90)
 *   --min-version=<semver>          Override minRequiredVersion in the package
 *   --dry-run                       Validate and show what would be signed, no output
 *
 * Examples:
 *   node sign-package.js update-v1.2.0.json
 *   node sign-package.js patch.json patch.signed.json --channel=beta --expires=30
 *   node sign-package.js release.json --dry-run
 *
 * The server must be running at least once first so it can generate the
 * official keypair in .update-keys/official.json.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

/* ── Terminal styling ─────────────────────────────────────────────────────── */
const C = {
    reset:  '\x1b[0m',
    bold:   '\x1b[1m',
    dim:    '\x1b[2m',
    red:    '\x1b[31m',
    green:  '\x1b[32m',
    yellow: '\x1b[33m',
    blue:   '\x1b[34m',
    cyan:   '\x1b[36m',
    white:  '\x1b[37m',
    bgRed:  '\x1b[41m',
    bgGreen:'\x1b[42m',
};

function box(lines, color = C.blue) {
    const width = Math.max(...lines.map(l => stripAnsi(l).length)) + 4;
    const hr = color + '─'.repeat(width) + C.reset;
    console.log('\n' + color + '┌' + '─'.repeat(width) + '┐' + C.reset);
    for (const line of lines) {
        const pad = width - 2 - stripAnsi(line).length;
        console.log(color + '│ ' + C.reset + line + ' '.repeat(pad) + color + ' │' + C.reset);
    }
    console.log(color + '└' + '─'.repeat(width) + '┘' + C.reset);
}

function stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function step(icon, label, value = '') {
    const valStr = value ? C.dim + ' → ' + C.reset + C.cyan + value + C.reset : '';
    console.log('  ' + icon + ' ' + C.white + label + C.reset + valStr);
}

function warn(msg)  { console.warn('  ' + C.yellow + '⚠' + C.reset + '  ' + msg); }
function err(msg)   { console.error('\n  ' + C.red + C.bold + '✕ ERROR' + C.reset + '  ' + msg + '\n'); }
function ok(msg)    { console.log('  ' + C.green + '✔' + C.reset + '  ' + msg); }

/* ── Argument parsing ─────────────────────────────────────────────────────── */
const args     = process.argv.slice(2);
const flags    = {};
const positional = [];

for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
        // Handle both --flag=value and --flag value
        const eqIdx = arg.indexOf('=');
        if (eqIdx > -1) {
            const k = arg.slice(2, eqIdx);
            const v = arg.slice(eqIdx + 1);
            flags[k] = v;
        } else {
            // Space-separated: --flag value
            const k = arg.slice(2);
            const nextArg = i + 1 < args.length ? args[i + 1] : null;
            if (nextArg && !nextArg.startsWith('--')) {
                flags[k] = nextArg;
                // Don't increment i here - the for loop will do it
            } else {
                flags[k] = true;
            }
        }
    } else {
        positional.push(arg);
    }
}

const [inputArg, outputArg] = positional;
const channel     = flags['channel']     || 'stable';
const expiryDays  = parseInt(flags['expires'] || '90', 10);
const dryRun      = !!flags['dry-run'];
const minVerOverride = flags['min-version'] || null;

if (!inputArg) {
    err('No input file specified.');
    console.log('  Usage: node sign-package.js <input.json> [output.json] [--channel=stable|beta|nightly] [--expires=<days>] [--dry-run]\n');
    process.exit(1);
}

if (!['stable', 'beta', 'nightly'].includes(channel)) {
    err('Invalid channel "' + channel + '" — must be one of: stable, beta, nightly');
    process.exit(1);
}

if (isNaN(expiryDays) || expiryDays < 1 || expiryDays > 730) {
    err('--expires must be between 1 and 730 days');
    process.exit(1);
}

/* ── Locate the official key ──────────────────────────────────────────────── */
function findOfficialKeyPath() {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
        const candidate = path.join(dir, '.update-keys', 'official.json');
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

const OFFICIAL_KEY_PATH = findOfficialKeyPath();

if (!OFFICIAL_KEY_PATH) {
    err('Could not find .update-keys/official.json\n  Searched from: ' + __dirname + ' (and parent directories)\n  Start the NovaByte server at least once to auto-generate the keypair.');
    process.exit(1);
}

let keyData;
try {
    keyData = JSON.parse(fs.readFileSync(OFFICIAL_KEY_PATH, 'utf8'));
} catch (e) {
    err('Failed to read key file: ' + e.message);
    process.exit(1);
}

if (!keyData.privateKey || !keyData.publicKey || !keyData.keyId) {
    err('Key file is missing required fields (privateKey, publicKey, keyId).');
    process.exit(1);
}

/* ── Resolve paths ────────────────────────────────────────────────────────── */
const inputPath  = path.resolve(inputArg);
const outputPath = outputArg
    ? path.resolve(outputArg)
    : path.join(path.dirname(inputPath), path.basename(inputPath, '.json') + '.signed.json');

if (!fs.existsSync(inputPath)) {
    err('File not found: ' + inputPath);
    process.exit(1);
}

/* ── Load and validate package ────────────────────────────────────────────── */
let pkg;
try {
    pkg = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
} catch (e) {
    err('Failed to parse JSON: ' + e.message);
    process.exit(1);
}

/* ── Package structure validation ────────────────────────────────────────── */
const pkgErrors = [];

if (!pkg || typeof pkg !== 'object')           pkgErrors.push('Root must be a JSON object');
if (!pkg.package)                              pkgErrors.push('Missing .package metadata block');
if (!Array.isArray(pkg.files))                 pkgErrors.push('Missing .files[] array');
if (pkg.package && !pkg.package.version)       pkgErrors.push('.package.version is required');
if (pkg.package && !/^\d+\.\d+\.\d+$/.test(pkg.package.version || ''))
                                               pkgErrors.push('.package.version must be MAJOR.MINOR.PATCH format');
if (!pkg.package?.name)                        pkgErrors.push('.package.name is required');
if (!pkg.package?.description)                 warn('.package.description is missing — recommended for user display');
if (!pkg.package?.changelog)                   warn('.package.changelog is missing — users won\'t see what changed');

if (pkgErrors.length > 0) {
    err('Invalid package structure:\n' + pkgErrors.map(e => '    • ' + e).join('\n'));
    process.exit(1);
}

if (Array.isArray(pkg.files)) {
    for (let i = 0; i < pkg.files.length; i++) {
        const f = pkg.files[i];
        if (!f.path) pkgErrors.push('files[' + i + '] is missing .path');
        // Accept unified diff OR legacy search/replace OR semantic instruction — but not none
        if (!f.diff && !f.search && !f.instruction) pkgErrors.push('files[' + i + '] needs .diff (unified diff), .search+.replace (legacy), or .instruction+.snippet (semantic)');
        if (!f.diff && f.search && !f.replace) pkgErrors.push('files[' + i + '] has .search but is missing .replace');
        if (f.instruction && !f.snippet) pkgErrors.push('files[' + i + '] has .instruction but is missing .snippet');
    }
    if (pkgErrors.length > 0) {
        err('File entry errors:\n' + pkgErrors.map(e => '    • ' + e).join('\n'));
        process.exit(1);
    }
}

/* ── Print header ─────────────────────────────────────────────────────────── */
box([
    C.bold + C.white  + 'NovaByte Package Signer' + C.reset + C.dim + '  v2.0' + C.reset,
    C.dim + 'Signing: ' + C.reset + C.cyan + path.basename(inputPath) + C.reset,
    C.dim + 'Output:  ' + C.reset + (dryRun ? C.yellow + '(dry run — no file written)' + C.reset : C.cyan + path.basename(outputPath) + C.reset),
], C.blue);

console.log('');
console.log(C.dim + '  ─── Key Information ──────────────────────────────────────' + C.reset);
step('🔑', 'Key ID:       ', keyData.keyId);
step('🏢', 'Publisher:    ', keyData.publisher);
step('📅', 'Key created:  ', keyData.created ? new Date(keyData.created).toLocaleDateString() : 'unknown');

/* ── Build metadata fields ────────────────────────────────────────────────── */
const now       = new Date();
const expiresAt = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000);
const nonce     = crypto.randomBytes(24).toString('hex'); // 48 hex chars

/* ── Deterministic stringify (mirrors server) ────────────────────────────── */
function deterministicStringify(obj) {
    if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(deterministicStringify).join(',') + ']';
    const keys = Object.keys(obj).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + deterministicStringify(obj[k])).join(',') + '}';
}

/* ── Strip old signature/checksum/timing fields, apply overrides ─────────── */
const { signature: _oldSig, checksum: _oldCs, issuedAt: _ia, expiresAt: _ea, nonce: _n, ...rest } = pkg;

// Apply overrides
const finalPkg = {
    ...rest,
    package: {
        ...rest.package,
        channel,
        ...(minVerOverride ? { minRequiredVersion: minVerOverride } : {}),
    },
    issuedAt:  now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    nonce,
};

/* ── Compute SHA-256 checksum ─────────────────────────────────────────────── */
const checksum = crypto.createHash('sha256').update(deterministicStringify(finalPkg)).digest('hex');
const pkgWithChecksum = { ...finalPkg, checksum };

/* ── Sign with Ed25519 ────────────────────────────────────────────────────── */
let sigBuffer;
try {
    const payload = Buffer.from(deterministicStringify(pkgWithChecksum));
    sigBuffer = crypto.sign(null, payload, keyData.privateKey);
} catch (e) {
    err('Signing failed: ' + e.message);
    process.exit(1);
}

const sigValue = sigBuffer.toString('base64');

const signed = {
    ...pkgWithChecksum,
    signature: {
        algorithm: 'Ed25519',
        keyId:     keyData.keyId,
        publisher: keyData.publisher,
        value:     sigValue,
    },
};

/* ── Compute fingerprints ─────────────────────────────────────────────────── */
const keyFingerprint = crypto.createHash('sha256')
    .update(keyData.publicKey)
    .digest('hex')
    .slice(0, 32)
    .match(/.{4}/g).join(':')
    .toUpperCase();

const packageHash = crypto.createHash('sha256')
    .update(JSON.stringify(signed))
    .digest('hex');

/* ── Print signing results ────────────────────────────────────────────────── */
console.log('');
console.log(C.dim + '  ─── Package Details ──────────────────────────────────────' + C.reset);
step('📦', 'Package:      ', (signed.package.name || 'unnamed') + '  v' + signed.package.version);
step('📡', 'Channel:      ', channel);
step('📅', 'Issued at:    ', now.toISOString());
step('⏰', 'Expires at:   ', expiresAt.toISOString() + ' (' + expiryDays + ' days)');
step('🎲', 'Nonce:        ', nonce.slice(0, 16) + '…');
const diffCount     = pkg.files.filter(f => f.diff).length;
const semanticCount = pkg.files.filter(f => f.instruction).length;
const legacyCount   = pkg.files.filter(f => !f.diff && !f.instruction).length;
const parts = [];
if (diffCount)     parts.push(diffCount     + ' unified diff'   + (diffCount     !== 1 ? 's' : ''));
if (semanticCount) parts.push(semanticCount + ' semantic'       + (semanticCount !== 1 ? 's' : ''));
if (legacyCount)   parts.push(legacyCount   + ' legacy search/replace');
const patchSummary = parts.join(', ') || '0 patches';
step('🗃 ', 'Files in pkg: ', pkg.files.length + ' patch(es) — ' + patchSummary);

console.log('');
console.log(C.dim + '  ─── Cryptographic Proof ──────────────────────────────────' + C.reset);
step('🔐', 'Checksum:     ', checksum.slice(0, 32) + '…');
step('✍ ', 'Signature:    ', sigValue.slice(0, 32) + '…');
step('🔏', 'Key FP:       ', keyFingerprint);
step('📋', 'Package hash: ', packageHash.slice(0, 32) + '…');

/* ── Threat pre-scan summary ──────────────────────────────────────────────── */
const THREAT_PATTERNS = [
    { re: /\beval\s*\(/,                                                   severity: 'HIGH',   label: 'eval() call'                     },
    { re: /new\s+Function\s*\(/,                                           severity: 'HIGH',   label: 'new Function() constructor'      },
    { re: /fetch\s*\(\s*['"`]https?:\/\/(?!localhost|127\.0\.0\.1)/,      severity: 'HIGH',   label: 'fetch() to external domain'      },
    { re: /document\.cookie/,                                              severity: 'HIGH',   label: 'document.cookie access'         },
    { re: /navigator\.sendBeacon/,                                         severity: 'HIGH',   label: 'sendBeacon (data exfiltration)'  },
    { re: /localStorage\.clear\s*\(\)/,                                    severity: 'HIGH',   label: 'localStorage.clear()'           },
    { re: /\brequire\s*\(/,                                                severity: 'HIGH',   label: 'require() in browser code'      },
    { re: /process\s*\.\s*(env|exit|argv)/,                                severity: 'HIGH',   label: 'Node.js process access'         },
    { re: /window\.location\s*=\s*['"`]https?:\/\/(?!localhost|127\.0\.0\.1)/, severity: 'HIGH', label: 'External redirect'           },
    { re: /setTimeout\s*\(\s*['"`]/,                                       severity: 'MED',    label: 'setTimeout with string argument' },
    { re: /setInterval\s*\(\s*['"`]/,                                      severity: 'MED',    label: 'setInterval with string argument'},
    { re: /new\s+XMLHttpRequest/,                                          severity: 'MED',    label: 'XMLHttpRequest usage'            },
    { re: /atob\s*\(/,                                                     severity: 'MED',    label: 'atob() — base64 decode'         },
    { re: /String\.fromCharCode\s*\(/,                                     severity: 'MED',    label: 'String.fromCharCode (obfuscation)'},
    { re: /[0-9a-zA-Z+/=]{200,}/,                                         severity: 'LOW',    label: 'Very long base64-like string'   },
];

const threatsBySeverity = { HIGH: [], MED: [], LOW: [] };
let threatCount = 0;
for (const f of pkg.files) {
    // For unified diffs scan only added lines; for semantic scan snippet; for legacy scan search + replace
    let content;
    if (f.diff) {
        content = f.diff.split('\n')
            .filter(l => l.startsWith('+') && !l.startsWith('+++'))
            .map(l => l.slice(1))
            .join('\n');
    } else if (f.instruction) {
        content = (f.instruction || '') + '\n' + (f.snippet || '');
    } else {
        content = (f.search || '') + '\n' + (f.replace || '');
    }
    for (const { re, severity, label } of THREAT_PATTERNS) {
        if (re.test(content)) {
            threatsBySeverity[severity].push({ label, file: f.path });
            threatCount++;
        }
    }
}

console.log('');
console.log(C.dim + '  ─── Pre-sign Threat Scan ─────────────────────────────────' + C.reset);
if (threatCount === 0) {
    ok('No threat patterns detected across ' + pkg.files.length + ' file(s)');
} else {
    for (const [sev, threats] of Object.entries(threatsBySeverity)) {
        if (threats.length === 0) continue;
        const color = sev === 'HIGH' ? C.red : sev === 'MED' ? C.yellow : C.dim;
        for (const t of threats) {
            console.log('  ' + color + '[' + sev + ']' + C.reset + ' ' + t.label + C.dim + '  (' + t.file + ')' + C.reset);
        }
    }
    if (threatsBySeverity.HIGH.length > 0) {
        console.log('');
        warn(C.red + C.bold + 'HIGH severity threats detected.' + C.reset + ' Review content carefully before distributing.');
    }
}

/* ── Dry run exit ─────────────────────────────────────────────────────────── */
if (dryRun) {
    console.log('');
    console.log(C.yellow + '  ─── DRY RUN — No file written ────────────────────────────' + C.reset);
    console.log(C.dim + '  Remove --dry-run to produce the signed package.\n' + C.reset);
    process.exit(0);
}

/* ── Write output ─────────────────────────────────────────────────────────── */
try {
    fs.writeFileSync(outputPath, JSON.stringify(signed, null, 2), 'utf8');
} catch (e) {
    err('Failed to write output: ' + e.message);
    process.exit(1);
}

/* ── Final summary box ────────────────────────────────────────────────────── */
box([
    C.green + C.bold + '✔  Package signed successfully' + C.reset,
    '',
    C.dim + 'Output: ' + C.reset + C.cyan + path.basename(outputPath) + C.reset,
    C.dim + 'Trust:  ' + C.reset + C.green + 'Official · NovaByte' + C.reset,
    C.dim + 'Valid:  ' + C.reset + now.toLocaleDateString() + ' → ' + expiresAt.toLocaleDateString(),
    C.dim + 'Size:   ' + C.reset + (fs.statSync(outputPath).size / 1024).toFixed(1) + ' KB',
], C.green);

console.log('');
console.log(C.dim + '  Distribute ' + C.cyan + path.basename(outputPath) + C.dim + ' to your update servers.' + C.reset);
console.log(C.dim + '  Recipients must have this installation\'s public key to verify.' + C.reset + '\n');