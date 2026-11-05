/**
 * NovaByte v3 — Closed Source Build Script
 *
 * Protection layers (in order):
 *  1. JS Obfuscation     — javascript-obfuscator over ALL .js files (hardened anti-Synchrony flags)
 *  2. V8 Bytecode        — nwjc compiles app.js → app.bin (renderer window context only)
 *  3a. Pre-load guard     — SHA-256 of server.js injected into client.js; verified before require()
 *  3b. Anti-tamper        — SHA-256 hashes of client.js + server.js baked into app.bin at build time
 *  4. Prod deps only     — npm install --production in stage (no devDependencies shipped)
 *  5. Non-SDK NW.js      — ships without DevTools (flavor: normal)
 *
 * Usage: node build-cs.mjs
 * IMPORTANT: Always works on the STAGE copy, never your source.
 */

import { execSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { gcmsiv } from '@noble/ciphers/aes.js';
import { gzipSync } from 'zlib';
import {
  readdirSync, statSync, existsSync, mkdirSync,
  cpSync, rmSync, readFileSync, writeFileSync
} from 'fs';
import { join, extname, basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createRequire } from 'module';
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── Config ────────────────────────────────────────────────────────────────────

const BUILD_DIR = resolve(__dirname, '../novabyte-v3-build');
const STAGE_DIR = resolve(__dirname, '../novabyte-v3-stage');

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', '.cache']);
const SKIP_FILES = new Set(['build-cs.mjs', 'official.json', '.env', 'server.log', 'cert.crt', 'cert.key']);

// Randomised per-build prefix — prevents fingerprinting across builds
const BUILD_PREFIX = 'nb' + Math.random().toString(36).slice(2, 7);

// Randomised obfuscation seed — every build produces structurally different output.
// Someone who reverse-engineers build N has to start completely over on build N+1.
const OBF_SEED = Math.floor(Math.random() * 999_999_999);

// ── Split-key secret for NBAES encoding ──────────────────────────────────────
// SECRET_A (16 bytes) lives inside app.bin (delivered via /nb-unlock at runtime).
// SECRET_B (16 bytes) is injected into server.js before obfuscation.
// Neither half alone can decrypt index.html or style.css.
const _buildSecret = randomBytes(32);
const SECRET_A = _buildSecret.slice(0, 16).toString('hex'); // → app.bin
const SECRET_B = _buildSecret.slice(16).toString('hex');    // → server.js

// ── Helpers ───────────────────────────────────────────────────────────────────

const log = (msg) => console.log(`\x1b[36m[build]\x1b[0m ${msg}`);
const done = (msg) => console.log(`\x1b[32m[done]\x1b[0m  ${msg}`);
const warn = (msg) => console.log(`\x1b[33m[warn]\x1b[0m  ${msg}`);
const err = (msg) => console.log(`\x1b[31m[error]\x1b[0m ${msg}`);

function getAllJsFiles(dir, results = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      getAllJsFiles(full, results);
    } else if (extname(entry) === '.js' && !SKIP_FILES.has(entry)) {
      results.push(full);
    }
  }
  return results;
}

function findNwjc() {
  const nwDir = join(__dirname, 'node_modules/nw');
  if (existsSync(nwDir)) {
    for (const entry of readdirSync(nwDir)) {
      const candidate = join(nwDir, entry, 'nwjc.exe');
      if (existsSync(candidate)) return candidate;
      const candidateUnix = join(nwDir, entry, 'nwjc');
      if (existsSync(candidateUnix)) return candidateUnix;
    }
  }
  const candidates = [
    join(__dirname, 'node_modules/nw/nwjc.exe'),
    join(__dirname, 'node_modules/.bin/nwjc.exe'),
    join(__dirname, 'node_modules/nw/nwjc'),
    join(__dirname, 'node_modules/.bin/nwjc'),
    'C:/Users/diraz/Downloads/novabyte-os/v3/node_modules/nw/nwjs-sdk-v0.111.3-win-x64/nwjc.exe',
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  try { execSync('nwjc --version', { stdio: 'ignore' }); return 'nwjc'; } catch { }
  return null;
}

function sha256File(filePath) {
  const data = readFileSync(filePath);
  return createHash('sha256').update(data).digest('hex');
}

// AES-256-GCM-SIV encrypt via @noble/ciphers.
// GCM-SIV is nonce-misuse-resistant and produces a 16-byte auth tag appended to
// the ciphertext — decryption will throw if the tag doesn't verify.
function encryptGcmSiv(keyBuf, nonce, data) {
  const cipher = gcmsiv(keyBuf, nonce);
  return Buffer.from(cipher.encrypt(data)); // ciphertext || 16-byte tag
}

// NBAES encode: gzip → AES-256-GCM-SIV(split-key masked) → base64
// Format: NBAES:<maskedKey_b64>:<nonce_b64>:<ciphertext+tag_b64>
// maskedKey = fileKey XOR buildSecret — stored in file, useless without both SECRET halves.
// GCM-SIV nonce is 12 bytes (96-bit); auth tag is the trailing 16 bytes of ciphertext.
function encodeNBAES(rawBuffer) {
  const compressed = gzipSync(rawBuffer, { level: 9 });
  const fileKey = randomBytes(32);              // 32-byte AES-256 key
  const nonce = randomBytes(12);              // 12-byte GCM-SIV nonce (96-bit)
  const buildSecret = Buffer.from(SECRET_A + SECRET_B, 'hex'); // 32 bytes
  // maskedKey = fileKey XOR buildSecret — stored in file, useless without secret
  const maskedKey = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) maskedKey[i] = fileKey[i] ^ buildSecret[i];
  const encrypted = encryptGcmSiv(fileKey, nonce, compressed); // includes auth tag
  fileKey.fill(0); // zero key from memory
  return 'NBAES:' + maskedKey.toString('base64') + ':' + nonce.toString('base64') + ':' + encrypted.toString('base64');
}

// ── Step 0: Clean stage and copy source ──────────────────────────────────────

log('Cleaning previous build and stage...');
if (existsSync(BUILD_DIR)) rmSync(BUILD_DIR, { recursive: true, force: true });
if (existsSync(STAGE_DIR)) rmSync(STAGE_DIR, { recursive: true, force: true });
mkdirSync(STAGE_DIR, { recursive: true });

log('Copying source to stage...');
cpSync(__dirname, STAGE_DIR, {
  recursive: true,
  filter: (src) => {
    const seg = basename(src);
    if (SKIP_DIR_NAMES.has(seg)) return false;
    if (SKIP_FILES.has(seg)) return false;
    if (src.startsWith(BUILD_DIR)) return false;
    if (src.startsWith(STAGE_DIR)) return false;
    return true;
  }
});
done('Stage ready.');

const stagedPkg = join(STAGE_DIR, 'package.json');
if (existsSync(stagedPkg)) {
  const pkg = JSON.parse(readFileSync(stagedPkg, 'utf8'));
  delete pkg.nwbuild;
  writeFileSync(stagedPkg, JSON.stringify(pkg, null, 2));
  log('Stripped "nwbuild" key from staged package.json.');
}

// ── Step 1: javascript-obfuscator pass over ALL .js files ────────────────────
//
// app.js is skipped here — compiled to app.bin by nwjc in Step 2.
// Flags chosen to defeat Synchrony and all automated deobfuscators:
//   --string-array-indexes-type hexadecimal-number  — kills Synchrony fingerprinting
//   --string-array-wrappers-*                       — multi-layer indirection
//   --string-array-calls-transform                  — extra wrapper on all lookups
//   --transform-object-keys                         — object keys into string array

log('Scanning for JS files...');
log(`Build prefix: ${BUILD_PREFIX}`);
const jsFiles = getAllJsFiles(STAGE_DIR);
log(`Found ${jsFiles.length} JS file(s) to process.`);
log(`Obfuscation seed: ${OBF_SEED} (unique per build — RE on this build won't transfer to next)`);


// Large files skip control-flow-flattening and dead-code-injection —
// these cause severe startup slowness as V8 can't optimize flattened switch statements.
const HEAVY_FILES = new Set(['server.js', 'client.js']);

// server.js and client.js get the lightest possible pass:
//   • identifier renaming only (mangled-shuffled)
//   • string array with base64 only (no RC4 — avoids slow unwrapping on every call)
//   • no rotation, no shuffle, no chained wrappers, no debug-protection
//   • no split-strings, no numbers-to-expressions, no transform-object-keys
// This keeps startup fast and avoids V8 deopt storms on large files.
const MINIMAL_FILES = new Set(['server.js', 'client.js']);

// ── Step 0.5: Terser pre-pass — minify ALL .js files before obfuscation ─────
//
// Terser runs first to:
//  • Strip all comments, whitespace, and source structure
//  • Mangle variable/function names (first rename pass)
//  • Remove dead code branches it can statically detect
// The obfuscator then receives already-mangled code — double the noise,
// smaller output, and the identifier space is exhausted before RE even starts.

log('Running Terser pre-pass (minify before obfuscation)...');
for (const file of jsFiles) {
  const name = basename(file);
  if (name === 'app.js') continue; // app.js goes straight to nwjc
  try {
    execSync(
      `npx terser "${file}" --output "${file}" ` +
      `--compress dead_code=true,drop_console=false,passes=2 ` +
      `--mangle toplevel=false ` +
      `--ecma 2020`,
      { stdio: 'pipe' }
    );
  } catch (e) {
    warn(`Terser failed for ${name}: ${e.message}`);
  }
}
done('Terser pre-pass complete.');

for (const file of jsFiles) {
  const name = basename(file);
  const isMinimal = MINIMAL_FILES.has(name); // server.js / client.js — lightest pass
  const isHeavy = !isMinimal && HEAVY_FILES.has(name); // (kept for future mid-tier files)
  const tier = isMinimal ? ' [minimal]' : isHeavy ? ' [lite]' : '';
  log(`Obfuscating${tier}: ${file.replace(STAGE_DIR, '').replace(/\\/g, '/')}`);
  try {
    if (isMinimal) {
      // ── Minimal pass for server.js / client.js ─────────────────────────────
      // Goals: identifier renaming + basic string hiding only.
      // No RC4 (slow per-call unwrapping), no CFF, no dead-code, no self-defending,
      // no wrappers, no split-strings, no numbers-to-expressions.
      // Keeps startup fast and avoids V8 deopt on large files.
      execSync(
        `npx javascript-obfuscator "${file}" --output "${file}" ` +
        `--target node ` +
        `--compact true ` +
        `--self-defending false ` +
        `--disable-console-output true ` +
        `--control-flow-flattening false ` +
        `--dead-code-injection false ` +
        `--string-array true ` +
        `--string-array-encoding base64 ` +
        `--string-array-threshold 0.75 ` +
        `--string-array-rotate false ` +
        `--string-array-shuffle false ` +
        `--string-array-indexes-type hexadecimal-number ` +
        `--string-array-index-shift false ` +
        `--string-array-calls-transform false ` +
        `--string-array-wrappers-count 1 ` +
        `--transform-object-keys false ` +
        `--numbers-to-expressions false ` +
        `--identifier-names-generator mangled-shuffled ` +
        `--identifiers-prefix ${BUILD_PREFIX} ` +
        `--rename-globals false ` +
        `--simplify true ` +
        `--split-strings false ` +
        `--debug-protection false ` +
        `--debug-protection-interval 0 ` +
        `--seed ${OBF_SEED}`,
        { stdio: 'pipe' }
      );
    } else {
      // ── Standard / lite pass for all other files ───────────────────────────
      execSync(
        `npx javascript-obfuscator "${file}" --output "${file}" ` +
        `--target node ` +
        `--compact true ` +
        `--self-defending ${isHeavy ? 'false' : 'true'} ` +
        `--disable-console-output true ` +
        `--control-flow-flattening ${isHeavy ? 'false' : 'true'} ` +
        `--control-flow-flattening-threshold ${isHeavy ? '0' : '0.4'} ` +
        `--dead-code-injection ${isHeavy ? 'false' : 'true'} ` +
        `--dead-code-injection-threshold ${isHeavy ? '0' : '0.3'} ` +
        `--string-array true ` +
        `--string-array-encoding ${isHeavy ? 'base64,rc4' : 'rc4,base64'} ` +
        `--string-array-threshold 0.95 ` +
        `--string-array-rotate true ` +
        `--string-array-shuffle true ` +
        `--string-array-indexes-type hexadecimal-number,hexadecimal-numeric-string ` +
        `--string-array-index-shift true ` +
        `--string-array-calls-transform-threshold 0.9 ` +
        `--string-array-wrappers-type function ` +
        `--string-array-wrappers-count ${isHeavy ? '3' : '5'} ` +
        `--string-array-wrappers-chained-calls true ` +
        `--string-array-wrappers-parameters-max-count 5 ` +
        `--string-array-calls-transform true ` +
        `--transform-object-keys true ` +
        `--numbers-to-expressions ${isHeavy ? 'false' : 'true'} ` +
        `--identifier-names-generator mangled-shuffled ` +
        `--identifiers-prefix ${BUILD_PREFIX} ` +
        `--rename-globals true ` +
        `--simplify true ` +
        `--split-strings ${isHeavy ? 'false' : 'true'} ` +
        `--split-strings-chunk-length 4 ` +
        `--force-transform-strings '/api/,/api/auth,/api/auth/google/callback,/api/horizon,/api/sentinel,/api/drivers,/api/updates,/api/autoupdate,/api/coreservices,/api/update,/api/info,/api/health,/api/mail,/api/security,/health,novabyte-official-,NovaByte Official,\\.update-keys,official\\.json,community\\.json,SESSION_SECRET,localhost:3002,https://localhost,http://localhost,cert\\.key,cert\\.crt,server\\.log,/api/repair,/api/sysinfo,/api/processes,auto-update-service' ` +
        `--debug-protection ${isHeavy ? 'false' : 'true'} ` +
        `--debug-protection-interval ${isHeavy ? '0' : '4000'} ` +
        `--seed ${OBF_SEED}`,
        { stdio: 'pipe' }
      );
    }
  } catch (e) {
    warn(`Obfuscation failed for ${name}: ${e.message}`);
  }
}
done('Obfuscation complete.');

// ── Step 1.5: Gzip + Base64 obfuscate ALL .html files ────────────────────────
//
// Every .html file (index.html, setup.html, oauth-callback.html, etc.) is
// gzip-compressed then base64-encoded so all files are unreadable garbage in
// any text editor.  oauth-callback.html and setup.html contain real OAuth logic
// so this is especially important for those.  A tiny bootstrap replaces each
// file — it decodes + decompresses at runtime and writes the real HTML.
//
// With DevTools stripped (NW.js flavor:normal) there is no console, no Elements
// panel, and no Network tab, so decoding at runtime is not trivially possible.

function getAllHtmlFiles(dir, results = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      getAllHtmlFiles(full, results);
    } else if (extname(entry) === '.html') {
      results.push(full);
    }
  }
  return results;
}

const htmlFiles = getAllHtmlFiles(STAGE_DIR);
log(`Found ${htmlFiles.length} HTML file(s) to obfuscate.`);

for (const htmlPath of htmlFiles) {
  const name = basename(htmlPath);
  const original = readFileSync(htmlPath);

  // index.html is served by a custom Express route that injects CSP nonces server-side.
  // Use NBGZ format so the server decompresses it and injects nonces reliably —
  // avoids the async document.open() CSP context loss that breaks nonce injection
  // when using the bootstrap wrapper approach.
  if (name === 'index.html') {
    const encoded = encodeNBAES(original);
    writeFileSync(htmlPath, encoded);
    log(`NBAES-encoded (split-key, server-side nonce injection): ${htmlPath.replace(STAGE_DIR, '').replace(/\\/g, '/')}`);
    continue;
  }

  // All other HTML files: bootstrap wrapper (client-side decompression)
  const compressed = gzipSync(original, { level: 9 });
  const encoded = compressed.toString('base64');
  const chunks = encoded.match(/.{1,120}/g).map(c => JSON.stringify(c)).join('+\n    ');

  const bootstrap = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
(function(){
  var b64 = ${chunks};
  var bin = atob(b64);
  var u8  = new Uint8Array(bin.length);
  for(var i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
  var ds  = new DecompressionStream('gzip');
  var w   = ds.writable.getWriter();
  w.write(u8); w.close();
  new Response(ds.readable).text().then(function(html){
    var n = window.__cspNonce || '';
    if(n){
      html = html.replace(/<script>/g,'<script nonce="'+n+'">');
      html = html.replace(/<script type="module">/g,'<script type="module" nonce="'+n+'">');
      html = html.replace(/<style>/g,'<style nonce="'+n+'">');
    }
    document.open(); document.write(html); document.close();
  });
})();
<\/script></body></html>`;

  writeFileSync(htmlPath, bootstrap);
  log(`Obfuscated: ${htmlPath.replace(STAGE_DIR, '').replace(/\\/g, '/')} (${(original.length / 1024).toFixed(1)} KB → ${(bootstrap.length / 1024).toFixed(1)} KB)`);
}
done(`HTML obfuscation complete (${htmlFiles.length} file(s)).`);
// ── Step 1.6: Gzip + Base64 encode sensitive JSON files ──────────────────────
//
// cs-manifest.json reveals internal JS file structure.
// nova-custom.json reveals the GitHub repo name and upstream config.
// Both are encoded in-place with a NBGZ: prefix. Server.js detects the prefix
// and decodes on the fly before serving — dev mode (plain JSON) still works
// unchanged since the prefix is only added by this build step.

const ENCODE_JSON_FILES = [join('updates', 'cs-manifest.json'), 'nova-custom.json'];

for (const jsonName of ENCODE_JSON_FILES) {
  const jsonPath = join(STAGE_DIR, jsonName);
  if (!existsSync(jsonPath)) { warn(`Not found, skipping: ${jsonName}`); continue; }
  const original = readFileSync(jsonPath);
  const compressed = gzipSync(original, { level: 9 });
  const encoded = 'NBGZ:' + compressed.toString('base64');
  writeFileSync(jsonPath, encoded);
  log(`Encoded: ${jsonName} (${(original.length / 1024).toFixed(1)} KB → ${encoded.length} chars)`);
}
done('JSON encoding complete.');

// ── Step 1.65: Gzip + Base64 encode style.css ────────────────────────────────
//
// style.css is now an external file (split from index.html).
// Encode it with the same NBGZ: prefix so it's unreadable in the shipped build.
// The server decodes it on the fly before serving — dev mode (plain CSS) still works.

const cssPath = join(STAGE_DIR, 'style.css');
if (existsSync(cssPath)) {
  const originalCss = readFileSync(cssPath);
  const encodedCss = encodeNBAES(originalCss);
  writeFileSync(cssPath, encodedCss);
  log(`NBAES-encoded: style.css (${(originalCss.length / 1024).toFixed(1)} KB → ${encodedCss.length} chars)`);
} else {
  warn('style.css not found in stage — skipping CSS encoding step.');
}
done('CSS encoding complete.');



// ── Step 1.7: Sanitise registry.json — strip dev machine paths ───────────────
//
// registry.json contains absolute paths from the dev machine
// (e.g. C:\Users\diraz\Downloads\...). Replace them with relative paths
// so the shipped file works on any user machine.

const registryPath = join(STAGE_DIR, 'drivers', 'registry.json');
if (existsSync(registryPath)) {
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  for (const [id, entry] of Object.entries(registry)) {
    if (entry.path) {
      // Store only the filename — driver-kernel resolves the full path at runtime
      entry.path = entry.path.split(/[\/\\]/).pop();
    }
  }
  writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  log('Sanitised registry.json — absolute dev paths reduced to filenames.');
} else {
  warn('registry.json not found in stage — skipping sanitise step.');
}

// ── Step 1c: Inject SECRET_B into server.js ──────────────────────────────────
//
// SECRET_B is the second half of the split key. It's baked into server.js
// before obfuscation so it ends up inside the V8 string array — unreadable
// without the obfuscator's own RC4 unwrapping. Neither half alone can decrypt
// index.html or style.css; both are needed at runtime to reconstruct BUILD_SECRET.
//
// MUST run BEFORE Step 1b so the pre-load guard hashes the final server.js
// (with SECRET_B already present) — matching exactly what ships on disk at runtime.

const clientPath = join(STAGE_DIR, 'client.js');
const serverPath = join(STAGE_DIR, 'server.js');

if (existsSync(serverPath)) {
  const serverSrc = readFileSync(serverPath, 'utf8');
  // __NB_SB      — SECRET_B half of the split key (read at /nb-unlock time)
  // __NB_SECRET  — reconstructed full key; starts null, set by /nb-unlock
  // __NB_UNLOCK_USED — one-shot gate; starts false, flipped by /nb-unlock
  // All three must be declared here so server.js can reference them before
  // /nb-unlock fires (reading an undeclared var throws ReferenceError).
  const injection = `// NB runtime vars injected by build-cs.mjs — do not edit\nconst __NB_SB = '${SECRET_B}';\nlet __NB_SECRET = null;\nlet __NB_UNLOCK_USED = false;\n`;
  writeFileSync(serverPath, injection + serverSrc);
  log(`Injected SECRET_B into server.js (${SECRET_B.slice(0, 8)}...)`);
} else {
  warn('server.js not found in stage — SECRET_B injection skipped.');
}

// ── Step 1b: Inject server.js pre-load hash check into client.js ─────────────
//
// This closes the timing gap where server.js is already running before app.bin's
// renderer-side tamper check fires.  client.js now verifies server.js BEFORE
// require()-ing it.  Mutual lock:
//   • Attacker patches server.js   → client.js check fires, process.exit(1)
//   • Attacker patches client.js   → app.bin hash check fires, nw.App.quit()
//   • Attacker patches both        → app.bin still catches modified client.js
//
// Runs AFTER Step 1c so the hash reflects the final server.js (SECRET_B included).

if (existsSync(clientPath) && existsSync(serverPath)) {
  const serverHashForClient = sha256File(serverPath);
  log(`Pre-load guard: server.js hash → ${serverHashForClient.slice(0, 16)}...`);

  const preloadGuard = `(function(){var _f=require('fs'),_c=require('crypto'),_p=require('path');` +
    `var _e=${JSON.stringify(serverHashForClient)};` +
    `var _s=_p.join(__dirname,'server.js');` +
    `if(!_f.existsSync(_s)){process.exit(1);}` +
    `var _a=_c.createHash('sha256').update(_f.readFileSync(_s)).digest('hex');` +
    `if(_a!==_e){process.exit(1);}` +
    `})();\n`;

  const clientSrc = readFileSync(clientPath, 'utf8');
  writeFileSync(clientPath, preloadGuard + clientSrc);
  log('Injected server.js pre-load guard into client.js.');
} else {
  warn('client.js or server.js not found — skipping pre-load guard injection.');
}



const nwjcPath = findNwjc();

if (nwjcPath) {
  log(`nwjc found at: ${nwjcPath}`);

  // Re-hash client.js now that the pre-load guard is inside it
  const filesToGuard = ['client.js', 'server.js', 'package.json'];
  const guardHashes = {};
  for (const f of filesToGuard) {
    const p = join(STAGE_DIR, f);
    if (existsSync(p)) {
      guardHashes[f] = sha256File(p);
      log(`Hashed for guard: ${f} → ${guardHashes[f].slice(0, 16)}...`);
    } else {
      warn(`Guard target not found: ${f}`);
    }
  }

  const guardBlock = `
// ── Anti-tamper guard + startup unlock (baked into app.bin — do not modify) ──
(function() {
  var _fs     = require('fs');
  var _crypto = require('crypto');
  var _path   = require('path');
  var _http   = require('http');
  var _hashes = ${JSON.stringify(guardHashes)};
  var _base   = _path.join(nw.App.startPath, 'package.nw');
  var _ok     = true;

  // ── 1. Chrome / NW debug switch check ──────────────────────────────────────
  var _badSwitches = ['--remote-debugging-port', '--inspect', '--enable-logging'];
  var _argv = (nw && nw.App && nw.App.argv) ? nw.App.argv : [];
  for (var _i = 0; _i < _argv.length; _i++) {
    if (_badSwitches.some(function(s){ return String(_argv[_i]).indexOf(s) !== -1; })) {
      nw.App.quit(); return;
    }
  }

  // ── 2. Frida global check ───────────────────────────────────────────────────
  try {
    if (typeof global.Frida !== 'undefined' || typeof global.__frida !== 'undefined') {
      nw.App.quit(); return;
    }
  } catch(e) {}

  // ── 3. File integrity check ─────────────────────────────────────────────────
  Object.keys(_hashes).forEach(function(name) {
    var full = _path.join(_base, name);
    if (!_fs.existsSync(full)) { _ok = false; return; }
    var actual = _crypto.createHash('sha256').update(_fs.readFileSync(full)).digest('hex');
    if (actual !== _hashes[name]) _ok = false;
  });
  if (!_ok) {
    nw.App.quit();
    throw new Error('Integrity check failed');
  }

  // ── 4. Deliver SECRET_A to server via /nb-unlock ────────────────────────────
  // SECRET_A is only available inside app.bin. The server needs it to reconstruct
  // BUILD_SECRET and decrypt index.html / style.css. POST once, then discard.
  var _secretA = '${SECRET_A}';
  var _body    = JSON.stringify({ a: _secretA });
  var _req     = _http.request(
    { host: '127.0.0.1', port: 3002, path: '/nb-unlock', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(_body) } },
    function(res) { _secretA = null; }
  );
  _req.on('error', function() {});
  _req.write(_body);
  _req.end();
})();
// ─────────────────────────────────────────────────────────────────────────────
`;

  const appSrc = join(STAGE_DIR, 'app.js');
  if (!existsSync(appSrc)) {
    warn('app.js not found in stage — skipping bytecode step.');
  } else {
    const original = readFileSync(appSrc, 'utf8');
    writeFileSync(appSrc, guardBlock + original);
    log('Injected tamper-check guard into app.js.');

    const appBin = appSrc.replace(/\.js$/, '.bin');
    try {
      execSync(`"${nwjcPath}" "${appSrc}" "${appBin}"`, { stdio: 'inherit' });
      rmSync(appSrc);
      done('Compiled: app.js → app.bin (guard embedded)');
    } catch (e) {
      warn('nwjc failed for app.js: ' + e.message);
      writeFileSync(appSrc, original);
    }
  }
} else {
  warn('nwjc not found — skipping bytecode + anti-tamper step.');
}

// ── Step 3: Install production dependencies ───────────────────────────────────

log('Installing production dependencies in stage (this may take a minute)...');
try {
  execSync('npm install --production --prefer-offline', {
    cwd: STAGE_DIR,
    stdio: 'inherit'
  });
  done('Production dependencies installed.');
} catch (e) {
  warn('npm install failed: ' + e.message);
}

// ── Step 4: Package with nw-builder ──────────────────────────────────────────

log('Packaging with nw-builder (flavor: normal — DevTools stripped)...');
import('nw-builder').then(async ({ default: nwbuild }) => {
  await nwbuild({
    mode: 'build',
    srcDir: STAGE_DIR,
    glob: false,
    platform: 'win',
    arch: 'x64',
    flavor: 'normal',
    outDir: BUILD_DIR,
    app: {
      name: 'NovaByte V3',
      icon: join(__dirname, 'assets/icon.ico')
    }
  });

  done(`Build complete → ${BUILD_DIR}`);

  log('Cleaning up stage...');
  rmSync(STAGE_DIR, { recursive: true, force: true });
  done('Stage cleaned. All done!');

}).catch((e) => {
  err('nw-builder failed: ' + (e.message || e));
});


// (Removed) Secure Binary Builder that bundled *every* JS file into one binary.
// This build script now only bytecodes app.js → app.bin via nwjc (see Step 2).
