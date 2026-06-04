const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || '') + ' --max-old-space-size=4096';

// ── Certificate bootstrap ────────────────────────────────────────────────────
// Generates a local CA + server cert (proper chain, like mkcert).
// Installs the CA into the OS trust store once — triggers native OS prompt.
// After that, Chromium trusts the cert natively, no flags needed.
//
//   Windows → PowerShell Import-Certificate → Windows security dialog
//   macOS   → security add-trusted-cert     → password / Touch ID popup
//   Linux   → sudo update-ca-certificates   → terminal sudo prompt
//             + certutil for Chrome NSS db

const os     = require('os');
const crypto = require('crypto');
const { execSync, execFileSync } = require('child_process');

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
  // stdio:'inherit' is required so the Windows security dialog has a window to attach to.
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
  // mkcert approach: use osascript to run `security add-trusted-cert` with
  // administrator privileges. This triggers the native macOS password/Touch ID
  // popup. Must target /Library/Keychains/System.keychain (not login keychain)
  // because Chromium reads the System keychain for trusted roots.
  // stdio must be 'inherit' so the auth dialog can render.
  const cmd = [
    'osascript', '-e',
    `do shell script "security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${caCrtPath}" with administrator privileges`
  ];
  try {
    execFileSync(cmd[0], cmd.slice(1), { stdio: 'inherit', timeout: 120000 });
    return true;
  } catch (e) {
    console.error('[NovaByte] macOS CA install failed:', e.message);
    return false;
  }
}

function installCaTrustLinux(caCrtPath) {
  // On Linux, Chromium/NW.js uses the NSS database (~/.pki/nssdb), NOT the
  // system CA store. So certutil into the NSS db is the critical step.
  // update-ca-certificates is done too, but certutil is what actually makes
  // Chromium trust the cert.
  //
  // certutil requires libnss3-tools (Debian/Ubuntu) or nss-tools (RHEL).
  // We create the NSS db if it doesn't exist yet.

  let nssOk = false;
  let sysOk = false;

  // ── 1. NSS db for Chromium (the critical step for NW.js) ─────────────────
  try {
    // Find certutil
    let certutil = '';
    for (const p of ['/usr/bin/certutil', '/usr/local/bin/certutil']) {
      if (fs.existsSync(p)) { certutil = p; break; }
    }
    if (!certutil) {
      try { certutil = execSync('which certutil 2>/dev/null', { encoding: 'utf8' }).trim(); } catch (_) {}
    }

    if (certutil) {
      const nssDb = path.join(os.homedir(), '.pki', 'nssdb');
      // Create NSS db if it doesn't exist
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

  // ── 2. System CA store (for other tools, optional for Chromium) ───────────
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
    } catch (_2) {}
  }

  // NSS ok is sufficient for NW.js/Chromium to work
  return nssOk || sysOk;
}

function installCaTrust(caCrtPath) {
  const p = process.platform;
  if (p === 'win32')  return installCaTrustWindows(caCrtPath);
  if (p === 'darwin') return installCaTrustMac(caCrtPath);
  return installCaTrustLinux(caCrtPath);
}

// ── PEM helper ────────────────────────────────────────────────────────────────
function toPem(der, type) {
  const b64 = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${type}-----\n${b64}\n-----END ${type}-----\n`;
}

// ── Cert generation using @peculiar/x509 (bundled inside selfsigned) ─────────
async function generateCerts(sandboxDir) {
  // Install selfsigned (brings @peculiar/x509 with it)
  execSync(
    'npm install selfsigned --prefix ' + JSON.stringify(sandboxDir) +
    ' --no-save --no-audit --no-fund --loglevel=error',
    { cwd: sandboxDir, stdio: 'pipe', timeout: 60000 }
  );

  const x509 = require(path.join(sandboxDir, 'node_modules', '@peculiar', 'x509'));
  const subtle = crypto.subtle;
  const keyParams = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  const notBefore = new Date();
  const notAfter  = new Date(Date.now() + 10 * 365.25 * 24 * 60 * 60 * 1000);

  // 1. Generate CA key pair + self-signed CA cert
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

  // 2. Generate server key pair + cert signed by CA
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
    caCertPem:    caCert.toString('pem'),
    caKeyPem:     toPem(caKeyDer, 'PRIVATE KEY'),
    serverCertPem: serverCert.toString('pem'),
    serverKeyPem:  toPem(serverKeyDer, 'PRIVATE KEY'),
  };
}


// ── .env bootstrap ────────────────────────────────────────────────────────────
// Generates a .env file with secure random secrets if one doesn't exist.
// Only creates the essential keys server.js needs to start — user fills in
// the rest (OAuth, API keys, etc.) manually.

async function ensureEnv() {
  const envPath = path.join(__dirname, '.env');
  try { await fs.promises.access(envPath); return; } catch (_) {}

  console.log('[NovaByte] No .env found — generating defaults...');

  const sessionSecret = crypto.randomBytes(64).toString('hex');
  const credEncryptKey = crypto.randomBytes(32).toString('hex');

  const env = `# NovaByte Environment Configuration
# Auto-generated on first launch.

# Server
PORT=3003
HOST=127.0.0.1
NODE_ENV=development

# HTTPS — trust the local CA in Node.js
NODE_EXTRA_CA_CERTS=ca.crt

# Security (auto-generated — do not share)
SESSION_SECRET=${sessionSecret}
NBOSP_CRED_KEY=${credEncryptKey}

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# CORS
CORS_ORIGIN=https://localhost:3003,https://127.0.0.1:3003
`;

  await fs.promises.writeFile(envPath, env, { encoding: 'utf8', mode: 0o600 });
  console.log('[NovaByte] .env created with secure random secrets.');
}

// ── Main cert bootstrap ───────────────────────────────────────────────────────
async function ensureCerts() {
  const fresh   = await certsAreFresh();
  let trusted   = false;
  try { await fs.promises.access(CA_TRUSTED_FLAG); trusted = true; } catch (_) {}

  if (fresh && trusted) {
    console.log('[NovaByte] Certs OK, CA already trusted — HTTPS ready.');
    await stripSpkiFromPackageJson();
    return true;
  }

  // Generate fresh CA + server cert if needed
  if (!fresh) {
    console.log('[NovaByte] Generating CA and server certificate...');
    const sandboxId  = 'nb_cert_' + crypto.randomBytes(6).toString('hex');
    const sandboxDir = path.join(os.tmpdir(), sandboxId);
    try {
      await fs.promises.mkdir(sandboxDir, { recursive: true });
      const { caCertPem, caKeyPem, serverCertPem, serverKeyPem } = await generateCerts(sandboxDir);

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
    } finally {
      try { await fs.promises.rm(sandboxDir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // Install CA into OS trust store (triggers native OS prompt)
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
    let args = parsed.window['chromium-args'] || '';
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
const port = process.env.PORT || 3003;

(async () => {
  await ensureEnv();
  const certOk = await ensureCerts();
  // Always use https — server.js loads cert.key/cert.crt and starts HTTPS if they exist.
  // If cert generation failed we still try https (server falls back to http internally).
  const appUrl = `https://localhost:${port}`;

  const logStream = fs.createWriteStream(path.join(__dirname, 'server.log'), { flags: 'a' });
  const server = spawn('node', ['--max-old-space-size=4096', '--expose-gc', path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  server.on('exit', () => {});
  server.on('error', () => {});

  let _conout = null;
  if (process.platform === 'win32' && process.env.NW_SHOW_CONSOLE === 'true') {
    try {
      _conout = fs.createWriteStream('\\\\.\\CONOUT$', { flags: 'a' });
      _conout.on('error', () => { _conout = null; });
    } catch (_) { _conout = null; }
  }

  function tee(chunk, isErr) {
    logStream.write(chunk);
    if (_conout) { try { _conout.write(chunk); } catch (_) {} }
    else { try { (isErr ? process.stderr : process.stdout).write(chunk); } catch (_) {} }
  }

  let opened = false;
  let win = null;
  function openWindow() {
    if (opened) return;
    opened = true;
    nw.Window.open(appUrl, { title: 'NovaByte', width: 1280, height: 720 }, function (window) {
      win = window;
      win.on('close', function () {
        server.kill();
        this.close(true);
        nw.App.quit();
      });
    });
  }

  server.stdout.on('data', d => { tee(d, false); if (d.toString().includes('Address')) openWindow(); });
  server.stderr.on('data', d => tee(d, true));
  setTimeout(openWindow, 8000);

  nw.App.on('quit', () => { server.kill(); nw.App.quit(); });
})();

let win = null; // accessible to hotkey handlers below

nw.App.registerGlobalHotKey(new nw.Shortcut({
  key: 'F11',
  active: function () { if (win) win.toggleFullscreen(); }
}));

nw.App.registerGlobalHotKey(new nw.Shortcut({
  key: 'F12',
  active: function () { if (win) win.showDevTools(); }
}));