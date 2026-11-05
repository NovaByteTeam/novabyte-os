#!/usr/bin/env node
/**
 * NovaByte OS — Core Services Packager  (updates/cs-packager.js)
 *
 * Builds a CS update package by comparing every file listed in
 * cs-manifest.json against a previous git tag.  Only changed files
 * are included.  The resulting JSON is written to --out and consumed
 * by push-update.js --pkg.
 *
 * Called by .github/workflows/cs-release.yml:
 *
 *   node updates/cs-packager.js \
 *     --version   "2026.05.2" \
 *     --changelog "- Patched auth validator\n- Updated network filter" \
 *     --from      "cs-v2026.05.1"   ← omit to auto-detect latest cs- tag \
 *     --channel   stable \
 *     --out       /tmp/cs-package.json
 */

'use strict';

const fs            = require('fs');
const path          = require('path');
const { execSync }  = require('child_process');

/* ─────────────────────────────────────────────────────────────────────────────
   COLOUR HELPERS  (matches push-update.js style)
   ───────────────────────────────────────────────────────────────────────────── */
const c = {
    reset:  '\x1b[0m',
    bold:   '\x1b[1m',
    dim:    '\x1b[2m',
    green:  '\x1b[32m',
    yellow: '\x1b[33m',
    red:    '\x1b[31m',
    cyan:   '\x1b[36m',
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
   GIT HELPERS
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Returns the latest cs-v* git tag, or null if none exist yet.
 */
function latestCsTag() {
    try {
        const tags = execSync(
            'git tag --sort=-v:refname',
            { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        )
            .split('\n')
            .map(t => t.trim())
            .filter(t => /^cs-v/.test(t));

        return tags.length ? tags[0] : null;
    } catch {
        return null;
    }
}

/**
 * Reads a file's content as it existed at a given git tag.
 * Returns null if the file didn't exist at that tag.
 *
 * @param {string} tag      - e.g. "cs-v2026.05.1"
 * @param {string} repoFile - repo-relative path, e.g. "v3/js/api-client.js"
 */
function gitShow(tag, repoFile) {
    try {
        return execSync(
            `git show "${tag}:${repoFile}"`,
            { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
    } catch {
        return null;   // file didn't exist at that tag → treat as new
    }
}

/**
 * Returns the repo root (absolute path).
 */
function repoRoot() {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
}

/* ─────────────────────────────────────────────────────────────────────────────
   MAIN
   ───────────────────────────────────────────────────────────────────────────── */
async function main() {
    const args = parseArgs(process.argv);

    /* ── Validate required flags ─────────────────────────────────────────── */
    if (!args.version) {
        console.error(err('--version is required  (e.g. --version 2026.05.2)'));
        process.exit(1);
    }
    if (!args.out) {
        console.error(err('--out is required  (e.g. --out /tmp/cs-package.json)'));
        process.exit(1);
    }

    const version   = args.version;
    const changelog = typeof args.changelog === 'string'
        ? args.changelog.replace(/\\n/g, '\n')
        : '';
    const channel   = typeof args.channel   === 'string' ? args.channel : 'stable';
    const outPath   = path.resolve(args.out);

    /* ── Resolve the base tag ────────────────────────────────────────────── */
    let fromTag = typeof args.from === 'string' && args.from ? args.from : null;

    if (!fromTag) {
        fromTag = latestCsTag();
        if (!fromTag) {
            console.log(warn('No previous cs- tag found — treating every manifest file as new (full content included)'));
        } else {
            console.log(info(`Auto-detected base tag: ${bold(fromTag)}`));
        }
    } else {
        console.log(info(`Using specified base tag: ${bold(fromTag)}`));
    }

    /* ── Load cs-manifest.json ───────────────────────────────────────────── */
    //  The script lives at  updates/cs-packager.js
    //  cs-manifest.json is at  updates/cs-manifest.json  (same folder)
    const manifestPath = path.join(__dirname, 'cs-manifest.json');
    if (!fs.existsSync(manifestPath)) {
        console.error(err(`cs-manifest.json not found at: ${manifestPath}`));
        process.exit(1);
    }

    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
        console.error(err(`Failed to parse cs-manifest.json: ${e.message}`));
        process.exit(1);
    }

    const manifestFiles = manifest.files;
    if (!Array.isArray(manifestFiles) || manifestFiles.length === 0) {
        console.error(err('cs-manifest.json has no files listed'));
        process.exit(1);
    }

    console.log(info(`Manifest loaded — ${bold(String(manifestFiles.length))} files in scope`));

    /* ── Compare each manifest file against the base tag ────────────────── */
    //  Each entry in manifest is repo-relative from v3/ root, e.g. "js/api-client.js"
    //  The actual file on disk is  <repoRoot>/v3/<manifestEntry>
    //  In git it lives at          v3/<manifestEntry>
    const root    = repoRoot();
    const v3Dir   = path.join(root, 'v3');       // adjust if your project root differs

    const changedFiles = [];
    const skipped      = [];
    const unchanged    = [];

    console.log('');
    console.log(bold('Scanning for changes…'));

    for (const relPath of manifestFiles) {
        const absPath    = path.join(v3Dir, relPath);
        const repoPath   = `v3/${relPath}`;          // path as git knows it

        // Read current content from working tree
        if (!fs.existsSync(absPath)) {
            console.log(`  ${c.yellow}MISSING${c.reset}  ${relPath} (not on disk — skipping)`);
            skipped.push(relPath);
            continue;
        }
        const currentContent = fs.readFileSync(absPath, 'utf8');

        // Read old content from git tag (null = file is brand new)
        const oldContent = fromTag ? gitShow(fromTag, repoPath) : null;

        if (oldContent === currentContent) {
            console.log(`  ${c.dim}SAME     ${relPath}${c.reset}`);
            unchanged.push(relPath);
            continue;
        }

        const isNew = oldContent === null;
        console.log(`  ${c.green}CHANGED  ${c.reset}${relPath}${isNew ? c.dim + '  (new file)' + c.reset : ''}`);

        changedFiles.push({
            path:       relPath,       // relative to v3 root — same key used by update-service.js
            content:    currentContent,
            encoding:   'utf8',
            isNew,
            sizeBytes:  Buffer.byteLength(currentContent, 'utf8'),
        });
    }

    console.log('');

    if (changedFiles.length === 0) {
        console.log(warn('No files changed between working tree and base tag.'));
        console.log(warn('Nothing to package.  Exiting without writing --out.'));
        process.exit(0);
    }

    /* ── Build the package JSON ──────────────────────────────────────────── */
    const pkg = {
        package: {
            name:        'Nova Core Services',
            version,
            description: `Nova Core Services v${version}`,
            type:        'core-services',
            channel,
            builtAt:     new Date().toISOString(),
            fromTag:     fromTag || null,
        },
        changelog,
        files: changedFiles,          // push-update.js reads pkg.files?.length
    };

    /* ── Write output file ───────────────────────────────────────────────── */
    try {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(pkg, null, 2), 'utf8');
    } catch (e) {
        console.error(err(`Failed to write package: ${e.message}`));
        process.exit(1);
    }

    /* ── Summary ─────────────────────────────────────────────────────────── */
    const totalBytes = changedFiles.reduce((acc, f) => acc + f.sizeBytes, 0);
    const humanBytes = b =>
        b < 1024 ? `${b} B` :
        b < 1048576 ? `${(b / 1024).toFixed(1)} KB` :
        `${(b / 1048576).toFixed(2)} MB`;

    console.log(`  ${bold('CS Package Summary')}`);
    console.log(`  ─────────────────────────────────────`);
    console.log(`  Version      ${c.green}${bold(version)}${c.reset}`);
    console.log(`  Channel      ${bold(channel)}`);
    console.log(`  Base tag     ${fromTag || c.dim + 'none (first release)' + c.reset}`);
    console.log(`  Files        ${c.green}${changedFiles.length} changed${c.reset}  /  ${unchanged.length} unchanged  /  ${skipped.length} skipped`);
    console.log(`  Total size   ${humanBytes(totalBytes)}`);
    console.log(`  Output       ${outPath}`);
    console.log('');
    if (changelog) {
        console.log(`  ${bold('Changelog:')}`);
        changelog.split('\n').forEach(line => console.log(`    ${line}`));
        console.log('');
    }
    console.log(ok('Package written — ready for push-update.js --pkg'));
    console.log('');
}

main().catch(e => {
    console.error(err('Unexpected error: ' + e.message));
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
});
