const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Increase Node.js heap size to prevent OOM crashes during heavy indexing
process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || '') + ' --max-old-space-size=4096';

// ── Certificate bootstrap ────────────────────────────────────────────────────
// Generates a self-signed localhost cert on first launch using an ephemeral
// tmp sandbox.  The sandbox is deleted after generation — nothing is added to
// package.json or node_modules permanently.
//
// Security model:
//   --ignore-certificate-errors       (broad, trusts everything)  ← REMOVED
//   --ignore-certificate-errors-spki-list=<sha256/base64>         ← USED
//   Only NovaByte's own cert is pinned.  External bad-cert warnings stay.

const os   = require('os');
const crypto = require('crypto');

const CERT_KEY  = path.join(__dirname, 'cert.key');
const CERT_CRT  = path.join(__dirname, 'cert.crt');
const CERT_SPKI = path.join(__dirname, 'cert.spki');
const CERT_MAX_AGE_MS = 10 * 365.25 * 24 * 60 * 60 * 1000; // 10 years

function certsAreFresh() {
  try {
    if (!fs.existsSync(CERT_KEY) || !fs.existsSync(CERT_CRT)) return false;
    const age = Date.now() - fs.statSync(CERT_CRT).mtimeMs;
    return age < CERT_MAX_AGE_MS;
  } catch (_) { return false; }
}

function computeSpki(publicPem) {
  const der = Buffer.from(
    publicPem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''),
    'base64'
  );
  return crypto.createHash('sha256').update(der).digest('base64');
}

function pinSpkiInPackageJson(spki) {
  // Read package.json, update chromium-args with the specific SPKI pin,
  // write it back.  This runs before the window opens so the flag is live
  // on the current process (NW.js reads package.json at startup for the
  // initial window, but we need it set for the relaunch after cert gen).
  try {
    const pkgPath = path.join(__dirname, 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.window) return;
    let args = parsed.window['chromium-args'] || '';
    // Remove old broad flags and any stale SPKI pin
    args = args
      .replace(/--ignore-certificate-errors(?!-spki)\s*/g, '')
      .replace(/--allow-insecure-localhost\s*/g, '')
      .replace(/--ignore-certificate-errors-spki-list=\S*\s*/g, '')
      .trim();
    // Add the specific pin
    args = (args + ' --ignore-certificate-errors-spki-list=' + spki).trim();
    parsed.window['chromium-args'] = args;
    fs.writeFileSync(pkgPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    console.log('[NovaByte] SPKI pin written to package.json');
  } catch (e) {
    console.error('[NovaByte] Failed to pin SPKI in package.json:', e.message);
  }
}

async function ensureCerts() {
  // ── Case 1: certs already exist and are fresh ─────────────────────────────
  if (certsAreFresh() && fs.existsSync(CERT_SPKI)) {
    const spki = fs.readFileSync(CERT_SPKI, 'utf8').trim();
    pinSpkiInPackageJson(spki);
    console.log('[NovaByte] Certs OK, SPKI pinned:', spki.slice(0, 12) + '...');
    return true;
  }

  // ── Case 2: generate certs in an ephemeral sandbox ────────────────────────
  console.log('[NovaByte] Generating self-signed localhost certificate...');

  const sandboxId  = 'nb_cert_' + crypto.randomBytes(6).toString('hex');
  const sandboxDir = path.join(os.tmpdir(), sandboxId);

  try {
    // 1. Create isolated sandbox (never touches project node_modules)
    fs.mkdirSync(sandboxDir, { recursive: true });

    // 2. Install selfsigned into the sandbox only
    const { execSync } = require('child_process');
    execSync(
      'npm install selfsigned --prefix ' + JSON.stringify(sandboxDir) +
      ' --no-save --no-audit --no-fund --loglevel=error',
      { cwd: sandboxDir, stdio: 'pipe', timeout: 60000 }
    );

    // 3. Require directly from sandbox path
    const selfsigned = require(path.join(sandboxDir, 'node_modules', 'selfsigned'));

    // 4. Generate cert
    const pems = await selfsigned.generate(
      [{ name: 'commonName', value: 'localhost' }],
      {
        keySize: 2048,
        days: 3650,           // 10 years
        algorithm: 'sha256',
        extensions: [
          { name: 'basicConstraints', cA: false },
          { name: 'subjectAltName', altNames: [
            { type: 2, value: 'localhost' },
            { type: 2, value: '127.0.0.1' },
            { type: 7, ip: '127.0.0.1' }
          ]}
        ]
      }
    );

    // 5. Compute SPKI fingerprint for Chromium cert pinning
    const spki = computeSpki(pems.public);

    // 6. Write certs next to the app (mode 0o600 = owner read/write only)
    fs.writeFileSync(CERT_KEY,  pems.private, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(CERT_CRT,  pems.cert,    { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(CERT_SPKI, spki,         { encoding: 'utf8', mode: 0o600 });

    console.log('[NovaByte] Certificate generated successfully.');
    console.log('[NovaByte] SPKI fingerprint:', spki.slice(0, 12) + '...');

    // 7. Pin the SPKI in package.json so the next launch uses it
    pinSpkiInPackageJson(spki);

    return true;

  } catch (err) {
    console.error('[NovaByte] Certificate generation failed:', err.message);
    // Soft-fail: fall back to http:// so the app still opens
    return false;
  } finally {
    // 8. Always delete the sandbox — no trace left in node_modules or package.json
    try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch (_) {}
    console.log('[NovaByte] Certificate sandbox cleaned up.');
  }
}

// ── Startup: generate certs if needed, then spawn server ─────────────────────
const port = process.env.PORT || 3003;

(async () => {
  const certOk = await ensureCerts();
  const protocol = certOk ? 'https' : 'http';
  const appUrl = `${protocol}://localhost:${port}`;

  // Spawn server — on Windows NW.js is a GUI app so stdout isn't a real terminal.
  // Write server logs to server.log so you can tail it if needed.
  const logStream = fs.createWriteStream(path.join(__dirname, 'server.log'), { flags: 'a' });
  const server = spawn('node', ['--max-old-space-size=4096', '--expose-gc', path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Handle server crashes silently
  server.on('exit', () => {
    // Server process ended
  });

  server.on('error', () => {
    // Server error occurred
  });

  // On Windows, nw.exe is a GUI subsystem binary with no real console attached.
  // Try \\.\CONOUT$ to write to the parent console if available.
  // Fallback: logs always land in server.log regardless.
  let _conout = null;
  if (process.platform === 'win32' && process.env.NW_SHOW_CONSOLE === 'true') {
    try {
      _conout = fs.createWriteStream('\\\\.\\CONOUT$', { flags: 'a' });
      _conout.on('error', () => { _conout = null; });
    } catch (_) { _conout = null; }
  }

  // Tee helper: write a chunk to the log file AND the terminal (if one is attached)
  function tee(chunk, isErr) {
    logStream.write(chunk);
    if (_conout) {
      try { _conout.write(chunk); } catch (_) { }
    } else {
      try { (isErr ? process.stderr : process.stdout).write(chunk); } catch (_) { }
    }
  }

  // Open window once server is ready (detects "Address" in log) or after 3s fallback
  let opened = false;
  let win = null;
  function openWindow() {
    if (opened) return;
    opened = true;
    nw.Window.open(appUrl, { title: 'NovaByte', width: 1280, height: 720 }, function (window) {
      win = window;
      // Prevent window from closing
      win.on('close', function () {
        server.kill();
        this.close(true); // true = bypass close event, actually close
        nw.App.quit();
      });
    });
  }
  server.stdout.on('data', d => { tee(d, false); if (d.toString().includes('Address')) openWindow(); });
  server.stderr.on('data', d => tee(d, true));
  // 8s timeout — gives server time to start on slow machines or first npm install
  setTimeout(openWindow, 8000);

  nw.App.on('quit', () => {
    server.kill();
    nw.App.quit();
  });

})(); // end async startup IIFE

  // Register F11 to toggle fullscreen
  nw.App.registerGlobalHotKey(new nw.Shortcut({
    key: "F11",
    active: function () {
      if (win) win.toggleFullscreen();
    }
  }));

  // Register F12 to toggle devtools
  nw.App.registerGlobalHotKey(new nw.Shortcut({
    key: "F12",
    active: function () {
      if (win) {
        win.showDevTools();
      }
    }
  }));