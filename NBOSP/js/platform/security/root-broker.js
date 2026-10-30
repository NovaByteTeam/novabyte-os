/**
 * NovaRoot — real root access broker for system:root apps
 * ─────────────────────────────────────────────────────────────────────────
 * Makes `system:root` mean what it says: an approved app can perform
 * privileged (unix root) operations after the user confirms with their own
 * password — asked inside NovaByte's own UI, never inside the app.
 *
 * How it works
 *   1. Caller gate  — the requesting app must be executing in the OS page
 *                     (host/unrestricted), with Developer Mode + Root Access
 *                     enabled AND a live `system:root` grant. Re-checked on
 *                     every call; a revoked package loses access instantly.
 *   2. Password     — `sudo -n -k -- true` detects whether the user account
 *                     has a password. If it does, the OS renders its own
 *                     password prompt (NovaByte-styled, above all app
 *                     windows) and validates it with `sudo -S -k -- true`.
 *                     The password lives in memory for the duration of one
 *                     handshake, is never stored, logged or exposed to the
 *                     app, and is dropped immediately after validation.
 *   3. Operations   — privileged operations run as argv arrays through
 *                     `sudo -n -- <argv…>` (no shell, nothing to inject).
 *                     sudo's own credential cache authorizes the session
 *                     after one validation; when it expires the next call
 *                     re-opens the prompt automatically (polkit-style).
 *   4. Audit        — every grant, denial and operation is written to
 *                     EventLog with the app id and argv. Passwords never are.
 *
 * Public API (window.NovaRoot)
 *   status()                       → { available, rootMode, appId, sessionActive, passwordRequired }
 *   requestSession({ reason })     → Promise<{ granted, reason? }>   — shows the prompt
 *   run({ argv, inputB64?, timeoutMs? }) → Promise<{ code, stdout, stderr }>  — one root argv
 *   rm(path) cp(src,dst) mkdirp(path) writeFile(path, textOrB64) readFile(path)
 *   endSession()                   → invalidate the cached sudo timestamp
 */
(() => {
  'use strict';

  if (typeof require !== 'function') { window.NovaRoot = null; return; }

  let cpMod, fsMod, pathMod;
  try {
    cpMod = require('child_process');
    fsMod = require('fs');
    pathMod = require('path');
  } catch (e) { window.NovaRoot = null; return; }

  const SUDO_CANDIDATES = ['sudo', '/usr/bin/sudo', '/bin/sudo', '/usr/local/bin/sudo'];
  let sudoBin = null;
  let sudoChecked = false;

  const SESSION_SOFT_TTL_MS = 15 * 60 * 1000; // display hint only; sudo enforces the real one
  const MAX_PASSWORD_ATTEMPTS = 3;

  let lastAuthAt = 0;
  let activePrompt = null;   // Promise while the OS prompt is open
  let inFlightSession = null; // coalesce concurrent requestSession() calls

  /* ── sudo resolution ───────────────────────────────────────────── */

  function resolveSudo() {
    if (sudoChecked) return sudoBin;
    sudoChecked = true;
    for (const candidate of SUDO_CANDIDATES) {
      try {
        cp.execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 5000 });
        sudoBin = candidate;
        return sudoBin;
      } catch (e) { /* try next */ }
    }
    return null;
  }

  function sudoErrText(stderr) {
    return String(stderr || '').toLowerCase();
  }

  function needsPasswordErr(stderr) {
    const t = sudoErrText(stderr);
    return t.includes('a password is required') || t.includes('no tty present') && t.includes('askpass');
  }

  function wrongPasswordErr(stderr) {
    const t = sudoErrText(stderr);
    return t.includes('incorrect password') || t.includes('authentication failure');
  }

  /* ── caller gate ───────────────────────────────────────────────── */

  function currentAppId() {
    try {
      const pkg = window.__novaUnrestrictedPackage;
      if (pkg && typeof pkg.id === 'string') return pkg.id;
    } catch (e) { /* ignore */ }
    return null;
  }

  function rootModeEnabled() {
    try {
      return typeof OS !== 'undefined' &&
        OS.settings?.get?.('devMode') === true &&
        OS.settings?.get?.('rootAccessEnabled') === true;
    } catch (e) { return false; }
  }

  function callerHasRootGrant(appId) {
    if (!appId) return false;
    try {
      return typeof AppPermissionManager !== 'undefined' &&
        AppPermissionManager.isGranted?.('system:root', appId) === true;
    } catch (e) { return false; }
  }

  function audit(severity, message, data) {
    try {
      if (typeof EventLog !== 'undefined' && EventLog.log) {
        EventLog.log({
          app: 'NovaRoot',
          category: 'security',
          severity,
          message,
          data: data || {}
        });
      }
    } catch (e) { /* audit channel unavailable */ }
  }

  /* ── low-level sudo runners ────────────────────────────────────── */

  function sudoRun(argv, { input = null, timeoutMs = 30000, maxBuffer = 4 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
      const bin = resolveSudo();
      if (!bin) { reject(new Error('sudo is not available on this system')); return; }
      let child;
      try {
        child = cpMod.execFile(bin, argv, {
          timeout: timeoutMs,
          maxBuffer,
          windowsHide: true
        }, (err, stdout, stderr) => {
          const code = child.exitCode;
          if (err && code == null) { reject(err); return; } // spawn/timeout failure
          resolve({ code: code == null ? 1 : code, stdout: stdout || '', stderr: stderr || '' });
        });
      } catch (e) { reject(e); return; }
      if (input != null && child.stdin) {
        child.stdin.end(input);
      }
    });
  }

  // Non-interactive privileged run — works while sudo's credential cache
  // is valid; fails cleanly with a detectable error when it is not.
  function rootRunCached(argv, opts = {}) {
    return sudoRun(['-n', '--', ...argv], opts);
  }

  // Invalidate the timestamp, then validate a password honestly.
  // Resolves true on success, false on a wrong password, throws on anything
  // else (sudo misconfigured, binary missing, …) so the prompt can tell the
  // user the difference instead of blaming the password.
  async function validatePassword(password) {
    const res = await sudoRun(['-S', '-k', '-p', '', '--', 'true'], {
      input: password == null ? '\n' : String(password) + '\n',
      timeoutMs: 20000
    });
    if (res.code === 0) return true;
    if (wrongPasswordErr(res.stderr)) return false;
    throw new Error('sudo rejected the attempt: ' + (res.stderr || 'exit ' + res.code).trim());
  }

  // Does this account need a password for sudo at all?
  async function detectPasswordRequired() {
    const res = await sudoRun(['-n', '-k', '--', 'true'], { timeoutMs: 10000 });
    if (res.code === 0) return false;            // NOPASSWD or passwordless account
    if (needsPasswordErr(res.stderr)) return true;
    throw new Error('sudo precheck failed: ' + (res.stderr || 'exit ' + res.code).trim());
  }

  /* ── the OS-side password prompt ───────────────────────────────── */

  const Z_TOP = '2147483600'; // above system-modal-root (2147483000) and everything app-side

  function requestPrompt({ appName, reason, passwordRequired }) {
    if (activePrompt) return activePrompt;

    activePrompt = new Promise((resolve) => {
      let settled = false;
      const finish = (granted) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        activePrompt = null;
        resolve(granted);
      };

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.style.cssText = `position:fixed;inset:0;z-index:${Z_TOP};`;

      const dialog = document.createElement('div');
      dialog.className = 'modal-dialog';
      dialog.style.cssText = 'max-width:420px;width:calc(100vw - 48px);';

      const title = document.createElement('div');
      title.className = 'modal-title';
      title.textContent = 'Root access confirmation';
      dialog.appendChild(title);

      const body = document.createElement('div');
      body.style.cssText = 'padding:4px 20px 16px;font:13px/1.55 var(--font-ui,system-ui,sans-serif);color:var(--text-primary,#e6edf3);';

      const shield = document.createElement('div');
      shield.style.cssText = 'font-size:26px;text-align:center;margin-bottom:8px;';
      shield.textContent = '🛡️';
      body.appendChild(shield);

      const line1 = document.createElement('div');
      line1.style.cssText = 'margin-bottom:6px;';
      const strong = document.createElement('b');
      strong.textContent = appName || 'An application';
      line1.appendChild(strong);
      line1.appendChild(document.createTextNode(' wants to run operations with real administrator (root) privileges.'));
      body.appendChild(line1);

      if (reason) {
        const reasonEl = document.createElement('div');
        reasonEl.style.cssText = 'color:var(--text-secondary,#8b949e);margin-bottom:10px;word-break:break-word;';
        reasonEl.textContent = reason;
        body.appendChild(reasonEl);
      }

      const note = document.createElement('div');
      note.style.cssText = 'color:var(--text-secondary,#8b949e);margin-bottom:12px;';
      note.textContent = passwordRequired
        ? 'Enter your user password to continue. NovaByte never stores or shares it — it is validated by the system and dropped immediately.'
        : 'No password is required on this account. Only continue if you trust this app.';
      body.appendChild(note);

      let input = null;
      let errLine = null;
      if (passwordRequired) {
        input = document.createElement('input');
        input.type = 'password';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('aria-label', 'User password');
        input.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 12px;margin-bottom:4px;border-radius:8px;' +
          'border:1px solid var(--border-color,#30363d);background:var(--bg-primary,#0d1117);color:var(--text-primary,#e6edf3);font-size:14px;';
        body.appendChild(input);

        errLine = document.createElement('div');
        errLine.style.cssText = 'min-height:18px;font-size:12px;color:var(--text-danger,#f85149);margin-bottom:4px;';
        body.appendChild(errLine);
      }

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:10px;';
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.style.cssText = 'padding:8px 16px;border-radius:8px;border:1px solid var(--border-color,#30363d);' +
        'background:transparent;color:var(--text-primary,#e6edf3);cursor:pointer;font-size:13px;';
      const ok = document.createElement('button');
      ok.textContent = 'Confirm';
      ok.style.cssText = 'padding:8px 18px;border-radius:8px;border:none;cursor:pointer;font-size:13px;' +
        'background:var(--danger-color,#d29922);color:#fff;';
      ok.style.background = 'var(--accent-color,#238636)';
      btnRow.appendChild(cancel);
      btnRow.appendChild(ok);
      body.appendChild(btnRow);

      dialog.appendChild(body);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        else if (e.key === 'Enter' && input && document.activeElement === input) { e.preventDefault(); attempt(); }
      }
      document.addEventListener('keydown', onKey, true);

      function attempt() {
        if (!input) { finish(true); return; }
        const pw = input.value;
        validatePassword(pw).then((okPw) => {
          input.value = '';
          if (okPw) { finish(true); return; }
          attemptsLeft -= 1;
          if (attemptsLeft > 0) {
            errLine.textContent = 'Incorrect password — ' + attemptsLeft + (attemptsLeft === 1 ? ' attempt' : ' attempts') + ' left.';
            input.focus();
          } else {
            finish('wrong-password');
          }
        }).catch((e) => {
          input.value = '';
          errLine.textContent = 'Password check failed: ' + (e.message || e);
        });
      }
      let attemptsLeft = MAX_PASSWORD_ATTEMPTS;

      cancel.addEventListener('click', () => finish(false));
      ok.addEventListener('click', attempt);
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(false); });
      if (input) setTimeout(() => input.focus(), 40); else setTimeout(() => ok.focus(), 40);
    });

    return activePrompt;
  }

  /* ── session orchestration ─────────────────────────────────────── */

  function sessionActive() {
    return lastAuthAt > 0 && (Date.now() - lastAuthAt) < SESSION_SOFT_TTL_MS;
  }

  async function ensureAuthorized(appId, reason) {
    if (!rootModeEnabled()) {
      return { granted: false, reason: 'Root Access is disabled (needs Developer Mode + Root Access in Settings).' };
    }
    if (!callerHasRootGrant(appId)) {
      return { granted: false, reason: 'The calling app does not hold a system:root grant.' };
    }
    if (sessionActive()) return { granted: true };

    const passwordRequired = await detectPasswordRequired();
    const verdict = await requestPrompt({
      appName: appId,
      reason,
      passwordRequired
    });
    if (verdict === true) {
      lastAuthAt = Date.now();
      audit('warn', `Root session granted for ${appId}`, { appId, passwordRequired });
      return { granted: true };
    }
    if (verdict === 'wrong-password') {
      audit('error', `Root session denied for ${appId} — password entered incorrectly ${MAX_PASSWORD_ATTEMPTS} times`, { appId });
      return { granted: false, reason: 'Incorrect password — too many attempts.' };
    }
    audit('info', `Root session request cancelled by user for ${appId}`, { appId });
    return { granted: false, reason: 'Cancelled by user.' };
  }

  /* ── public API ────────────────────────────────────────────────── */

  async function requestSession(opts = {}) {
    const appId = currentAppId();
    if (inFlightSession) return inFlightSession;
    inFlightSession = (async () => {
      return ensureAuthorized(appId, opts.reason || '');
    })().finally(() => { inFlightSession = null; });
    return inFlightSession;
  }

  async function run({ argv, inputB64 = null, inputText = null, timeoutMs = 30000, maxBuffer } = {}) {
    if (!Array.isArray(argv) || !argv.every(a => typeof a === 'string')) {
      throw new Error('NovaRoot.run needs an argv array of strings (no shell).');
    }
    const appId = currentAppId();

    const doRun = () => sudoRun(['-n', '--', ...argv], {
      input: inputB64 != null ? Buffer.from(inputB64, 'base64') : (inputText != null ? inputText : null),
      timeoutMs, maxBuffer
    });

    const attempt = async () => {
      const res = await doRun();
      if (res.code === 0) return res;
      if (needsPasswordErr(res.stderr)) {
        const session = await requestSession({ reason: 'Root session expired — re-authorization needed.' });
        if (!session.granted) {
          const e = new Error(session.reason || 'Root authorization denied.');
          e.code = 'NOVA_ROOT_DENIED';
          throw e;
        }
        return doRun();
      }
      return res;
    };

    // Gate BEFORE doing anything privileged.
    if (!rootModeEnabled() || !callerHasRootGrant(appId)) {
      const e = new Error('NovaRoot: caller has no active system:root authorization.');
      e.code = 'NOVA_ROOT_DENIED';
      throw e;
    }

    const res = await attempt();
    audit(res.code === 0 ? 'info' : 'warn',
      `Root op by ${appId}: ${argv.join(' ')} → exit ${res.code}`,
      { appId, argv, exit: res.code });
    if (res.code !== 0) {
      const e = new Error(`Root command failed (exit ${res.code}): ${(res.stderr || '').trim() || argv.join(' ')}`);
      e.code = res.code;
      e.stdout = res.stdout;
      e.stderr = res.stderr;
      throw e;
    }
    return { code: res.code, stdoutB64: Buffer.from(res.stdout, 'utf8').toString('base64'), stderrB64: Buffer.from(res.stderr, 'utf8').toString('base64') };
  }

  /* Convenience wrappers — all argv-based, no shell. */

  function rm(p) { return run({ argv: ['rm', '-f', '--', String(p)] }); }
  function cp(src, dst) { return run({ argv: ['cp', '-f', '--', String(src), String(dst)] }); }
  function mkdirp(p) { return run({ argv: ['mkdir', '-p', '--', String(p)] }); }

  async function writeFile(dst, content) {
    // Write to a user-owned temp file first, then place it as root with cp.
    const tmp = pathMod.join((require('os').tmpdir() || '/tmp'), `nova-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const b64 = typeof content === 'string' ? Buffer.from(content, 'utf8').toString('base64') : String(content);
    fsMod.writeFileSync(tmp, Buffer.from(b64, 'base64'));
    try {
      await mkdirp(pathMod.dirname(dst));
      await cp(tmp, dst);
    } finally {
      try { fsMod.unlinkSync(tmp); } catch (e) { /* ignore */ }
    }
    return { code: 0, stdoutB64: '', stderrB64: '' };
  }

  async function readFile(p) {
    const res = await run({ argv: ['cat', '--', String(p)] });
    return Buffer.from(res.stdoutB64, 'base64').toString('utf8');
  }

  async function endSession() {
    lastAuthAt = 0;
    try { await sudoRun(['-k'], { timeoutMs: 10000 }); } catch (e) { /* best effort */ }
    audit('info', 'Root session ended (timestamp invalidated)', {});
    return true;
  }

  function status() {
    return {
      available: !!resolveSudo(),
      rootMode: rootModeEnabled(),
      appId: currentAppId(),
      sessionActive: sessionActive(),
      sessionUntil: lastAuthAt ? new Date(lastAuthAt + SESSION_SOFT_TTL_MS).toISOString() : null
    };
  }

  window.NovaRoot = Object.freeze({
    status,
    requestSession,
    run,
    rm,
    cp,
    mkdirp,
    writeFile,
    readFile,
    endSession
  });

  console.info('[NovaRoot] Root access broker ready — window.NovaRoot');
})();
