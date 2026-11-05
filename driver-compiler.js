#!/usr/bin/env node
/**
 * NovaByte Driver Compiler
 * ─────────────────────────
 * Compiles a driver folder into a signed .drv package.
 *
 * Usage:
 *   node driver-compiler.js build ./my-driver/ [--out ./dist/]
 *   node driver-compiler.js inspect ./my-driver.drv [--no-verify]
 *   node driver-compiler.js verify ./my-driver.drv
 *   node driver-compiler.js list-actions ./my-driver.drv
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { DRV_FORMAT_VERSION, ALLOWED_PERMISSIONS } =
    require('./drv-constants');                         // FIX #11 — single source of truth

// ─── CLI arg parsing ──────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const command = args[0];
const target  = args[1];

// FIX #12 — --out flag for build output directory
const outFlagIdx = args.indexOf('--out');
const outDir     = outFlagIdx !== -1 ? args[outFlagIdx + 1] : null;

// FIX #14 — --no-verify flag for inspect
const noVerify = args.includes('--no-verify');

// ─── Colour helpers ───────────────────────────────────────────────────────────

const c = {
    reset:  '\x1b[0m',
    bold:   '\x1b[1m',
    green:  '\x1b[32m',
    yellow: '\x1b[33m',
    red:    '\x1b[31m',
    cyan:   '\x1b[36m',
    dim:    '\x1b[2m'
};

const ok   = (msg) => console.log(`${c.green}✔${c.reset}  ${msg}`);
const err  = (msg) => console.error(`${c.red}✖${c.reset}  ${msg}`);
const inf  = (msg) => console.log(`${c.cyan}→${c.reset}  ${msg}`);
const warn = (msg) => console.log(`${c.yellow}⚠${c.reset}  ${msg}`);

// ─── BUILD ────────────────────────────────────────────────────────────────────
// FIX #12 — honours --out <dir> flag

function buildDriver(driverDir) {
    const absDir = path.resolve(driverDir);
    if (!fs.existsSync(absDir)) { err(`Directory not found: ${absDir}`); process.exit(1); }

    // ── Read & validate manifest ───────────────────────────────────────────────
    const manifestPath = path.join(absDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) { err('manifest.json not found'); process.exit(1); }

    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch (e) { err(`Invalid manifest.json: ${e.message}`); process.exit(1); }

    const required = ['id', 'name', 'version', 'entry'];
    const missing  = required.filter(f => !manifest[f]);
    if (missing.length) { err(`manifest.json missing: ${missing.join(', ')}`); process.exit(1); }

    if (!/^[a-z0-9-]+$/.test(manifest.id)) {
        err(`manifest id must be lowercase alphanumeric with hyphens only: "${manifest.id}"`);
        process.exit(1);
    }

    const perms   = manifest.permissions || [];
    const invalid = perms.filter(p => !ALLOWED_PERMISSIONS.includes(p));
    if (invalid.length) {
        warn(`Unknown permissions will be stripped: ${invalid.join(', ')}`);
        manifest.permissions = perms.filter(p => ALLOWED_PERMISSIONS.includes(p));
    }

    // ── Read entry file ────────────────────────────────────────────────────────
    const entryPath = path.join(absDir, manifest.entry);
    if (!fs.existsSync(entryPath)) { err(`Entry file not found: ${manifest.entry}`); process.exit(1); }

    // ── Bundle files ───────────────────────────────────────────────────────────
    const files = {};
    const walkDir = (dir, base = '') => {
        fs.readdirSync(dir).forEach(f => {
            const full = path.join(dir, f);
            const rel  = base ? `${base}/${f}` : f;
            if (fs.statSync(full).isDirectory()) {
                walkDir(full, rel);
            } else if (f !== 'manifest.json' && !f.startsWith('.')) {
                files[rel] = fs.readFileSync(full).toString('base64');
            }
        });
    };
    walkDir(absDir);

    inf(`Bundled ${Object.keys(files).length} file(s)`);

    // ── Build & write package ──────────────────────────────────────────────────
    const compiledAt = new Date().toISOString();
    const hash       = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');

    const pkg = {
        novabyte_drv: DRV_FORMAT_VERSION,
        manifest: { ...manifest, compiledAt },
        files,
        signature:   hash,
        compiled_at: compiledAt
    };

    // FIX #12 — write to --out dir if specified, else current directory
    const destDir = outDir ? path.resolve(outDir) : process.cwd();
    if (outDir && !fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    const outFile = path.join(destDir, `${manifest.id}.drv`);
    fs.writeFileSync(outFile, JSON.stringify(pkg, null, 2));

    const size = fs.statSync(outFile).size;

    console.log('');
    console.log(`${c.bold}NovaByte Driver Compiler${c.reset}`);
    console.log('─'.repeat(40));
    ok(`Driver compiled: ${c.bold}${outFile}${c.reset}`);
    inf(`Name:        ${manifest.name}`);
    inf(`ID:          ${manifest.id}`);
    inf(`Version:     ${manifest.version}`);
    inf(`Permissions: ${(manifest.permissions || []).join(', ') || 'none'}`);
    inf(`Targets:     ${(manifest.targets || ['*']).join(', ')}`);
    inf(`Platform:    ${(manifest.platform || ['*']).join(', ')}`);
    inf(`Files:       ${Object.keys(files).length}`);
    inf(`Size:        ${(size / 1024).toFixed(1)} KB`);
    inf(`SHA-256:     ${hash.slice(0, 16)}...`);
    console.log('─'.repeat(40));
    ok(`Done! Copy ${path.basename(outFile)} to drivers/built-in/ or install via API.`);
}

// ─── VERIFY ───────────────────────────────────────────────────────────────────

function verifyDriver(drvFile) {
    const absFile = path.resolve(drvFile);
    if (!fs.existsSync(absFile)) { err(`File not found: ${absFile}`); process.exit(1); }

    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(absFile, 'utf8')); }
    catch (e) { err(`Invalid .drv file: ${e.message}`); process.exit(1); }

    const { files, signature } = pkg;
    const expected = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');

    console.log('');
    if (expected === signature) {
        ok(`Signature VALID — driver integrity confirmed`);
        ok(`SHA-256: ${signature}`);
    } else {
        err(`Signature INVALID — driver may have been tampered with!`);
        err(`Expected: ${expected}`);
        err(`Got:      ${signature}`);
        process.exit(1);
    }
    console.log('');
}

// ─── INSPECT ──────────────────────────────────────────────────────────────────
// FIX #14 — verify signature by default; skip with --no-verify

function inspectDriver(drvFile) {
    const absFile = path.resolve(drvFile);
    if (!fs.existsSync(absFile)) { err(`File not found: ${absFile}`); process.exit(1); }

    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(absFile, 'utf8')); }
    catch (e) { err(`Invalid .drv file: ${e.message}`); process.exit(1); }

    // FIX #14 — verify signature during inspect (unless --no-verify)
    if (!noVerify) {
        const { files, signature } = pkg;
        const expected = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
        if (expected !== signature) {
            err(`Signature INVALID — aborting inspect (use --no-verify to override)`);
            err(`Expected: ${expected}`);
            err(`Got:      ${signature}`);
            process.exit(1);
        }
    } else {
        warn('Signature verification skipped (--no-verify)');
    }

    const { manifest, files, signature, compiled_at } = pkg;

    console.log('');
    console.log(`${c.bold}Driver Inspection${c.reset}`);
    console.log('─'.repeat(40));
    inf(`Name:        ${manifest.name}`);
    inf(`ID:          ${manifest.id}`);
    inf(`Version:     ${manifest.version}`);
    inf(`Author:      ${manifest.author || 'Unknown'}`);
    inf(`Description: ${manifest.description || '-'}`);
    inf(`Permissions: ${(manifest.permissions || []).join(', ') || 'none'}`);
    inf(`Targets:     ${(manifest.targets || ['*']).join(', ')}`);
    inf(`Platform:    ${(manifest.platform || ['*']).join(', ')}`);
    inf(`Entry:       ${manifest.entry}`);
    inf(`Compiled:    ${compiled_at || manifest.compiledAt || 'unknown'}`);
    inf(`Signature:   ${signature}  ${noVerify ? c.yellow + '(unverified)' + c.reset : c.green + '✔' + c.reset}`);
    console.log('');
    inf(`Files:`);
    Object.keys(files).forEach(f => {
        const size = Buffer.from(files[f], 'base64').length;
        console.log(`     ${c.dim}${f}${c.reset}  (${size} bytes)`);
    });
    console.log('─'.repeat(40));
}

// ─── LIST ACTIONS ─────────────────────────────────────────────────────────────
// FIX #10 — use manifest.entry directly, no stale fallback

function listActions(drvFile) {
    const absFile = path.resolve(drvFile);
    if (!fs.existsSync(absFile)) { err(`File not found: ${absFile}`); process.exit(1); }

    const pkg       = JSON.parse(fs.readFileSync(absFile, 'utf8'));
    const entryName = pkg.manifest.entry;              // FIX #10 — always from manifest

    if (!pkg.files[entryName]) {
        err(`Entry file '${entryName}' not found in bundle`);
        process.exit(1);
    }

    const code    = Buffer.from(pkg.files[entryName], 'base64').toString('utf8');
    const actions = [];

    const block = code.match(/module\.exports\s*=\s*\{([^}]+)\}/s);
    if (block) {
        (block[1].match(/(\w+)\s*:/g) || [])
            .forEach(k => actions.push(k.replace(':', '').trim()));
    }

    let m;
    const re = /exports\.(\w+)\s*=/g;
    while ((m = re.exec(code)) !== null) {
        if (!actions.includes(m[1])) actions.push(m[1]);
    }

    console.log('');
    inf(`Actions in ${path.basename(drvFile)} (entry: ${entryName}):`);
    actions.forEach(a => console.log(`   ${c.cyan}${a}${c.reset}`));
    if (!actions.length) warn('No exported actions found');
    console.log('');
}

// ─── HELP ─────────────────────────────────────────────────────────────────────

function showHelp() {
    console.log(`
${c.bold}NovaByte Driver Compiler v${DRV_FORMAT_VERSION}${c.reset}

${c.cyan}Commands:${c.reset}
  build <dir> [--out <dir>]   Compile a driver folder into a .drv package
  inspect <file.drv> [--no-verify]  Show driver info (verifies signature by default)
  verify <file.drv>           Verify driver signature/integrity
  list-actions <file.drv>     List exported driver actions

${c.cyan}Driver folder structure:${c.reset}
  my-driver/
  ├── manifest.json      Required — driver metadata
  ├── driver.js          Required — main driver code
  └── config.json        Optional — driver config

${c.cyan}manifest.json example:${c.reset}
  {
    "id": "my-driver",
    "name": "My Driver",
    "version": "1.0.0",
    "author": "You",
    "description": "Does something cool",
    "entry": "driver.js",
    "permissions": ["display", "browser"],
    "targets": ["chrome", "firefox"],
    "platform": ["windows", "linux", "mac"]
  }

${c.cyan}Available permissions:${c.reset}
  ${ALLOWED_PERMISSIONS.join(', ')}
`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

switch (command) {
    case 'build':
        if (!target) { err('Usage: driver-compiler.js build <dir> [--out <dir>]'); process.exit(1); }
        buildDriver(target);
        break;
    case 'inspect':
        if (!target) { err('Usage: driver-compiler.js inspect <file.drv> [--no-verify]'); process.exit(1); }
        inspectDriver(target);
        break;
    case 'verify':
        if (!target) { err('Usage: driver-compiler.js verify <file.drv>'); process.exit(1); }
        verifyDriver(target);
        break;
    case 'list-actions':
        if (!target) { err('Usage: driver-compiler.js list-actions <file.drv>'); process.exit(1); }
        listActions(target);
        break;
    default:
        showHelp();
}