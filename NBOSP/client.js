const { spawn }                  = require('child_process');
const path                       = require('path');
const fs                         = require('fs');
const dotenv                     = require('dotenv');
const os                         = require('os');
const crypto                     = require('crypto');
const { execSync, execFileSync } = require('child_process');
require('reflect-metadata');                                    // required by @peculiar/x509 2.x (tsyringe)
const x509                       = require('@peculiar/x509');

// ── Certificate bootstrap ─────────────────────────────────────────────────────
// Generates a local CA + server cert (proper chain, like mkcert).
// Installs the CA into the OS trust store once — triggers native OS prompt.
// After that, Chromium trusts the cert natively, no flags needed.
//
//   Windows → certutil.exe            → Windows security dialog
//   macOS   → security add-trusted-cert → password / Touch ID popup
//   Linux   → sudo update-ca-certificates → terminal sudo prompt
//             + certutil for Chrome NSS db

const CA_KEY          = path.join(__dirname, 'ca.key');
const CA_CRT          = path.join(__dirname, 'ca.crt');
const CERT_KEY        = path.join(__dirname, 'cert.key');
const CERT_CRT        = path.join(__dirname, 'cert.crt');
const CA_TRUSTED_FLAG = path.join(__dirname, 'ca.trusted');
const CERT_MAX_AGE_MS = 10 * 365.25 * 24 * 60 * 60 * 1000;

async function certsAreFresh() {
  try {
    await Promise.all([CA_KEY, CA_CRT, CERT_KEY, CERT_CRT].map(f => fs.promises.access(f)));
    const stat = await fs.promises.stat(CERT_CRT);
    return (Date.now() - stat.mtimeMs) < CERT_MAX_AGE_MS;
  } catch (_) { return false; }
}

// ── OS trust store installation ───────────────────────────────────────────────

function installCaTrustWindows(caCrtPath) {
  // certutil.exe is built into Windows — same tool mkcert uses.
  // stdio:'inherit' required so the Windows security dialog has a window to attach to.
  // -user = CurrentUser\Root store, no admin rights needed.
  try {
    execFileSync('certutil', ['-addstore', '-user', 'Root', caCrtPath], {
      stdio: 'inherit',
      timeout: 60000
    });
    return true;
  } catch (e) {
    console.error('[NovaByte] Windows CA install failed:', e.message);
    return false;
  }
}

function installCaTrustMac(caCrtPath) {
  // FIX: Single-quote escape the path to prevent shell injection via special chars/spaces.
  // mkcert approach: osascript elevates `security add-trusted-cert` with admin privileges.
  // Targets /Library/Keychains/System.keychain (Chromium reads System, not login keychain).
  // stdio must be 'inherit' so the auth dialog can render.
  const quotedPath = "'" + caCrtPath.replace(/'/g, "'\\''") + "'";
  const shellScript = `do shell script "security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${quotedPath}" with administrator privileges`;
  try {
    execFileSync('osascript', ['-e', shellScript], { stdio: 'inherit', timeout: 120000 });
    return true;
  } catch (e) {
    console.error('[NovaByte] macOS CA install failed:', e.message);
    return false;
  }
}

function installCaTrustLinux(caCrtPath) {
  // On Linux, Chromium/NW.js uses the NSS database (~/.pki/nssdb), NOT the system CA store.
  // certutil into the NSS db is the critical step; update-ca-certificates is supplemental.
  // certutil requires libnss3-tools (Debian/Ubuntu) or nss-tools (RHEL).

  let nssOk = false;
  let sysOk = false;

  // ── 1. NSS db for Chromium (critical for NW.js) ───────────────────────────
  try {
    let certutil = '';
    for (const p of ['/usr/bin/certutil', '/usr/local/bin/certutil']) {
      if (fs.existsSync(p)) { certutil = p; break; }
    }
    if (!certutil) {
      try { certutil = execSync('which certutil 2>/dev/null', { encoding: 'utf8' }).trim(); } catch (_) {}
    }

    if (certutil) {
      const nssDb = path.join(os.homedir(), '.pki', 'nssdb');
      if (!fs.existsSync(nssDb)) {
        fs.mkdirSync(nssDb, { recursive: true });
        execFileSync(certutil, ['-N', '-d', `sql:${nssDb}`, '--empty-password'], { stdio: 'pipe', timeout: 15000 });
      }
      // Remove old cert if present (ignore errors)
      try { execFileSync(certutil, ['-D', '-d', `sql:${nssDb}`, '-n', 'NovaByte Local CA'], { stdio: 'pipe', timeout: 10000 }); } catch (_) {}
      // Install CA cert — "C,," = trusted CA for SSL
      execFileSync(certutil, ['-A', '-d', `sql:${nssDb}`, '-t', 'C,,', '-n', 'NovaByte Local CA', '-i', caCrtPath], { stdio: 'pipe', timeout: 15000 });
      console.log('[NovaByte] CA installed in NSS db (Chromium will trust it).');
      nssOk = true;
    } else {
      console.warn('[NovaByte] certutil not found. Install libnss3-tools (Debian/Ubuntu) or nss-tools (RHEL).');
    }
  } catch (e) {
    console.error('[NovaByte] NSS db install failed:', e.message);
  }

  // ── 2. System CA store (optional for Chromium, useful for other tools) ────
  try {
    // Debian/Ubuntu/Mint
    execFileSync('sudo', ['cp', caCrtPath, '/usr/local/share/ca-certificates/novabyte-ca.crt'], { stdio: 'inherit', timeout: 30000 });
    execFileSync('sudo', ['update-ca-certificates'], { stdio: 'pipe', timeout: 30000 });
    sysOk = true;
  } catch (_) {
    try {
      // RHEL/Fedora/CentOS/Arch
      execFileSync('sudo', ['cp', caCrtPath, '/etc/pki/ca-trust/source/anchors/novabyte-ca.crt'], { stdio: 'inherit', timeout: 30000 });
      execFileSync('sudo', ['update-ca-trust', 'extract'], { stdio: 'pipe', timeout: 30000 });
      sysOk = true;
    } catch (_e) {}
  }

  // NSS ok is sufficient for NW.js/Chromium
  return nssOk || sysOk;
}

function installCaTrust(caCrtPath) {
  const p = process.platform;
  if (p === 'win32')  return installCaTrustWindows(caCrtPath);
  if (p === 'darwin') return installCaTrustMac(caCrtPath);
  return installCaTrustLinux(caCrtPath);
}

// ── PEM helper ────────────────────────────────────────────────────────────────
// FIX: Loop instead of regex — avoids the overhead of .match(/.{1,64}/g) on large buffers.
function toPem(der, type) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${type}-----\n${lines.join('\n')}\n-----END ${type}-----\n`;
}

// ── Cert generation using @peculiar/x509 ─────────────────────────────────────
async function generateCerts() {
  const subtle = crypto.subtle;
  const keyParams = {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256'
  };
  const notBefore = new Date();
  // FIX: Reuse CERT_MAX_AGE_MS constant instead of duplicating the magic number.
  const notAfter = new Date(Date.now() + CERT_MAX_AGE_MS);

  // 1. CA key pair + self-signed CA cert
  const caKeys = await subtle.generateKey(keyParams, true, ['sign', 'verify']);
  const caCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=NovaByte Local CA',
    notBefore, notAfter,
    signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    keys: caKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 2, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    ]
  });

  // 2. Server key pair + cert signed by CA
  const serverKeys = await subtle.generateKey(keyParams, true, ['sign', 'verify']);
  const serverCert = await x509.X509CertificateGenerator.create({
    serialNumber: '02',
    subject: 'CN=localhost',
    issuer: caCert.subject,
    notBefore, notAfter,
    signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    publicKey: serverKeys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false),
      new x509.SubjectAlternativeNameExtension([
        { type: 'dns', value: 'localhost' },
        { type: 'ip',  value: '127.0.0.1' },
      ]),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment
      ),
    ]
  });

  // 3. Export to PEM
  const caKeyDer     = await subtle.exportKey('pkcs8', caKeys.privateKey);
  const serverKeyDer = await subtle.exportKey('pkcs8', serverKeys.privateKey);

  return {
    caCertPem:     caCert.toString('pem'),
    caKeyPem:      toPem(caKeyDer, 'PRIVATE KEY'),
    serverCertPem: serverCert.toString('pem'),
    serverKeyPem:  toPem(serverKeyDer, 'PRIVATE KEY'),
  };
}


// ── .env Management ──────────────────────────────────────────────────────────
// Load .env via dotenv's parser, validate schema, generate missing secrets,
// and write atomically (cross-platform safe).

async function parseEnvFile(filePath) {
  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    return dotenv.parse(content);
  } catch (_) { return null; }
}

async function atomicWriteEnv(filePath, env) {
  const tempPath = filePath + '.tmp';
  // FIX: Always double-quote values so spaces, $, #, and special chars survive a round-trip.
  const content = Object.entries(env)
    .map(([k, v]) => {
      const escaped = String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `${k}="${escaped}"`;
    })
    .join('\n') + '\n';

  await fs.promises.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });

  try {
    await fs.promises.rename(tempPath, filePath);
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'EACCES') {
      // Windows can't atomically overwrite — unlink then retry
      await fs.promises.unlink(filePath);
      await fs.promises.rename(tempPath, filePath);
    } else {
      // FIX: Clean up temp file before re-throwing so we don't leave orphaned .tmp files.
      try { await fs.promises.unlink(tempPath); } catch (_) {}
      throw err;
    }
  }
}

async function ensureEnv() {
  const envPath     = path.join(__dirname, '.env');
  const examplePath = path.join(__dirname, '.env.example');

  // 1. Load .env, or bootstrap from .env.example if missing
  let env = await parseEnvFile(envPath);
  if (!env || Object.keys(env).length === 0) {
    console.log('[NovaByte] No .env found — bootstrapping from .env.example...');
    const example = await parseEnvFile(examplePath);
    if (!example || Object.keys(example).length === 0) {
      throw new Error('[NovaByte] FATAL: .env and .env.example missing or empty.');
    }
    env = { ...example };
  }

  // 2. Generate any missing required secrets
  const secretsRequired = { SESSION_SECRET: 64, NBOSP_CRED_KEY: 32 };
  const missing = {};
  for (const [key, byteLength] of Object.entries(secretsRequired)) {
    if (!(env[key] || '').trim()) {
      console.log(`[NovaByte] Generating missing ${key}...`);
      missing[key] = crypto.randomBytes(byteLength).toString('hex');
    }
  }

  if (Object.keys(missing).length > 0) {
    Object.assign(env, missing);
    await atomicWriteEnv(envPath, env);
    console.log('[NovaByte] .env updated with generated secrets (atomic, platform-safe).');
  }

  // 3. Schema validation
  const parsePort = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
  };
  const parsePositiveInt = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? n : null;
  };
  const validateCorsOrigin = (v) => {
    if (!v) return null;
    const urls = v.split(',').map(u => u.trim()).filter(Boolean);
    for (const url of urls) {
      try {
        if (new URL(url).protocol !== 'https:') return null;
      } catch (_) { return null; }
    }
    return urls.length > 0 ? urls : null;
  };

  const schema = {
    PORT:                   (v) => parsePort(v)          ? null : `must be integer 1-65535`,
    RATE_LIMIT_WINDOW_MS:   (v) => parsePositiveInt(v)   ? null : `must be a positive integer`,
    RATE_LIMIT_MAX_REQUESTS:(v) => parsePositiveInt(v)   ? null : `must be a positive integer`,
    CORS_ORIGIN:            (v) => validateCorsOrigin(v) ? null : `must be comma-separated https:// URLs`,
    // FIX: Never print the actual secret value in error output — log length only.
    SESSION_SECRET: (v) => v && v.length >= 128 ? null : `must be 128+ char hex string (got length ${v ? v.length : 0})`,
    NBOSP_CRED_KEY: (v) => v && v.length >= 64  ? null : `must be 64+ char hex string (got length ${v ? v.length : 0})`,
  };

  const errors = [];
  for (const [key, validate] of Object.entries(schema)) {
    const error = validate(env[key] || '');
    if (error) errors.push(`${key}: ${error}`);
  }

  if (errors.length > 0) {
    const msg = `[NovaByte] .env validation failed:\n  ${errors.join('\n  ')}\n\nFix .env and restart.`;
    console.error(msg);
    throw new Error(msg);
  }

  Object.assign(process.env, env);
  console.log('[NovaByte] .env loaded, validated, and applied to process.env.');
}

// ── Main cert bootstrap ───────────────────────────────────────────────────────
async function ensureCerts() {
  const fresh = await certsAreFresh();
  let trusted = false;
  try { await fs.promises.access(CA_TRUSTED_FLAG); trusted = true; } catch (_) {}

  if (fresh && trusted) {
    console.log('[NovaByte] Certs OK, CA already trusted — HTTPS ready.');
    await stripSpkiFromPackageJson();
    return true;
  }

  if (!fresh) {
    console.log('[NovaByte] Generating CA and server certificate...');
    try {
      const { caCertPem, caKeyPem, serverCertPem, serverKeyPem } = await generateCerts();

      await fs.promises.writeFile(CA_CRT,   caCertPem,     { encoding: 'utf8', mode: 0o644 });
      await fs.promises.writeFile(CA_KEY,   caKeyPem,      { encoding: 'utf8', mode: 0o600 });
      await fs.promises.writeFile(CERT_CRT, serverCertPem, { encoding: 'utf8', mode: 0o644 });
      await fs.promises.writeFile(CERT_KEY, serverKeyPem,  { encoding: 'utf8', mode: 0o600 });

      // Invalidate old trust flag — new CA means we must re-install
      try { await fs.promises.unlink(CA_TRUSTED_FLAG); } catch (_) {}
      console.log('[NovaByte] Certificates generated.');
    } catch (err) {
      console.error('[NovaByte] Certificate generation failed:', err.message);
      return false;
    }
  }

  console.log('[NovaByte] Installing CA into OS trust store...');
  const ok = installCaTrust(CA_CRT);
  if (ok) {
    await fs.promises.writeFile(CA_TRUSTED_FLAG, new Date().toISOString(), 'utf8');
    console.log('[NovaByte] CA trusted. HTTPS will work natively from now on.');
    await stripSpkiFromPackageJson();
    return true;
  } else {
    console.warn('[NovaByte] CA trust install failed — falling back to HTTP.');
    return false;
  }
}

async function stripSpkiFromPackageJson() {
  try {
    const pkgPath = path.join(__dirname, 'package.json');
    const parsed  = JSON.parse(await fs.promises.readFile(pkgPath, 'utf8'));
    if (!parsed.window) return;
    const args = parsed.window['chromium-args'] || '';
    const cleaned = args
      .replace(/--ignore-certificate-errors(?!-spki)\s*/g, '')
      .replace(/--allow-insecure-localhost\s*/g, '')
      .replace(/--ignore-certificate-errors-spki-list=\S*\s*/g, '')
      .trim();
    if (cleaned !== args) {
      parsed.window['chromium-args'] = cleaned;
      await fs.promises.writeFile(pkgPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
      console.log('[NovaByte] Cleaned stale SPKI flags from package.json.');
    }
  } catch (e) {
    console.error('[NovaByte] Failed to clean package.json:', e.message);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
// FIX: Single `win` at module scope so F11/F12 hotkey handlers can read it.
// Previously there were TWO `let win = null` — one inside the IIFE (set by openWindow)
// and one at module scope (read by hotkeys). The outer one was never updated, so
// both hotkeys were permanently broken. Now there's only one.
let win = null;

(async () => {
  // FIX: Wrap the entire startup in try/catch so fatal errors produce clean messages
  // instead of unhandled promise rejection noise.
  try {
    await ensureEnv();
    // FIX: `port` belongs inside the IIFE — the outer `let port = 3003` was dead code.
    const port   = parseInt(process.env.PORT || '3003', 10);
    const appUrl = `https://localhost:${port}`;

    await ensureCerts();
    // Always target https — server.js loads cert.key/cert.crt and starts HTTPS if they exist.

    const logStream = fs.createWriteStream(path.join(__dirname, 'server.log'), { flags: 'a' });

    // In packaged NW.js apps, process.execPath is the NW.js binary, not Node.
    // Set NODE_BIN_PATH at build time to the actual Node binary path.
    // FIX: Don't set NODE_OPTIONS on the current process — the heap flag is passed
    // directly to server.js via spawn args, so setting it in NODE_OPTIONS would
    // apply it twice to the server and unnecessarily to the NW.js process as well.
    const nodeBin = process.env.NODE_BIN_PATH || 'node';
    const server  = spawn(nodeBin, ['--max-old-space-size=4096', '--expose-gc', path.join(__dirname, 'server.js')], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });

    let _conout = null;
    if (process.platform === 'win32' && process.env.NW_SHOW_CONSOLE === 'true') {
      try {
        _conout = fs.createWriteStream('\\\\.\\CONOUT$', { flags: 'a' });
        _conout.on('error', () => { _conout = null; });
      } catch (_) { _conout = null; }
    }

    function tee(chunk, isErr) {
      try { logStream.write(chunk); } catch (_) {}
      if (_conout) {
        try { _conout.write(chunk); } catch (_) {}
      } else {
        try { (isErr ? process.stderr : process.stdout).write(chunk); } catch (_) {}
      }
    }

    // FIX: Log server errors/exits instead of silently swallowing them.
    server.on('error', (err) => {
      tee(Buffer.from(`[NovaByte] Server spawn error: ${err.message}\n`), true);
    });

    // FIX: Close streams when server exits so nothing is left dangling.
    server.on('exit', (code, signal) => {
      tee(Buffer.from(`[NovaByte] Server exited (code=${code}, signal=${signal})\n`), false);
      logStream.end();
      if (_conout) try { _conout.end(); } catch (_) {}
    });

    let opened = false;
    function openWindow() {
      if (opened) return;
      opened = true;
      nw.Window.open(appUrl, { title: 'NovaByte', width: 1280, height: 720 }, function (window) {
        // FIX: Assigns to module-scope `win` — hotkeys now work correctly.
        win = window;
        win.on('close', function () {
          server.kill();
          this.close(true);
          nw.App.quit();
        });
      });
    }

    server.stdout.on('data', d => {
      tee(d, false);
      // FIX: Short-circuit once the window is open — no point checking every chunk forever.
      if (!opened && d.toString().includes('Address')) openWindow();
    });
    server.stderr.on('data', d => tee(d, true));

    setTimeout(openWindow, 8000);

    // FIX: Removed `nw.App.quit()` from inside the quit handler — calling it there
    // is recursive and either infinite-loops or no-ops depending on NW.js internals.
    nw.App.on('quit', () => {
      server.kill();
    });

  } catch (err) {
    console.error('[NovaByte] Fatal startup error:', err.message);
    process.exit(1);
  }
})();

nw.App.registerGlobalHotKey(new nw.Shortcut({
  key: 'F11',
  active: function () { if (win) win.toggleFullscreen(); }
}));

nw.App.registerGlobalHotKey(new nw.Shortcut({
  key: 'F12',
  active: function () { if (win) win.showDevTools(); }
}));