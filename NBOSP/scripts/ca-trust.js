'use strict';

const fs                        = require('fs');
const os                        = require('os');
const path                      = require('path');
const { execFileSync }          = require('child_process');

function installCaTrustWindows(caCrtPath) {
  try {
    execFileSync('certutil', ['-addstore', '-user', 'Root', caCrtPath], {
      stdio:   'inherit',
      timeout: 60_000,
    });
    return true;
  } catch (e) {
    console.error('[NovaByte] Windows CA install failed:', e.message);
    return false;
  }
}

function installCaTrustMac(caCrtPath) {
  // Single-quote escape path for POSIX shell
  const posixEscaped = caCrtPath.replace(/'/g, "'\\''");
  const quotedPath = `'${posixEscaped}'`;

  // Escape backslashes and double quotes inside AppleScript string literal
  const appleScriptEscaped = `security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${quotedPath}`
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');

  const shellScript = `do shell script "${appleScriptEscaped}" with administrator privileges`;

  try {
    execFileSync('osascript', ['-e', shellScript], { stdio: 'inherit', timeout: 120_000 });
    return true;
  } catch (e) {
    console.error('[NovaByte] macOS CA install failed:', e.message);
    return false;
  }
}

function installCaTrustLinux(caCrtPath) {
  let nssOk = false;
  let sysOk = false;

  try {
    const knownPaths = [
      '/usr/bin/certutil',
      '/usr/local/bin/certutil',
      '/bin/certutil',
    ];

    const certutil = knownPaths.find(p => fs.existsSync(p)) || '';

    if (certutil) {
      const nssDb = path.join(os.homedir(), '.pki', 'nssdb');

      if (!fs.existsSync(nssDb)) {
        fs.mkdirSync(nssDb, { recursive: true });
        execFileSync(certutil, ['-N', '-d', `sql:${nssDb}`, '--empty-password'], { stdio: 'pipe', timeout: 15_000 });
      }

      try {
        execFileSync(certutil, ['-D', '-d', `sql:${nssDb}`, '-n', 'NovaByte Local CA'], { stdio: 'pipe', timeout: 10_000 });
      } catch (_) {}

      execFileSync(certutil, ['-A', '-d', `sql:${nssDb}`, '-t', 'C,,', '-n', 'NovaByte Local CA', '-i', caCrtPath], {
        stdio: 'pipe', timeout: 15_000,
      });
      console.log('[NovaByte] CA installed in NSS db (Chromium will trust it).');
      nssOk = true;
    } else {
      console.warn('[NovaByte] certutil not found — install libnss3-tools (Debian/Ubuntu) or nss-tools (RHEL).');
    }
  } catch (e) {
    console.error('[NovaByte] NSS db install failed:', e.message);
  }

  const distros = [
    ['/usr/local/share/ca-certificates/novabyte-ca.crt', ['update-ca-certificates']],
    ['/etc/pki/ca-trust/source/anchors/novabyte-ca.crt',  ['update-ca-trust', 'extract']],
  ];

  for (const [dest, updateCmd] of distros) {
    try {
      execFileSync('sudo', ['cp', caCrtPath, dest],  { stdio: 'inherit', timeout: 30_000 });
      execFileSync('sudo', updateCmd,                 { stdio: 'pipe',    timeout: 30_000 });
      sysOk = true;
      break;
    } catch (_) {}
  }

  return nssOk || sysOk;
}

function installCaTrust(caCrtPath) {
  switch (process.platform) {
    case 'win32':  return installCaTrustWindows(caCrtPath);
    case 'darwin': return installCaTrustMac(caCrtPath);
    default:       return installCaTrustLinux(caCrtPath);
  }
}

module.exports = { installCaTrust };