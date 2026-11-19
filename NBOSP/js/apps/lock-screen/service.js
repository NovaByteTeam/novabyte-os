'use strict';

// Localised strings — the NovaI18n core engine (js/core/core/i18n.js)
// evaluated before this service script; identity fallback for stripped-down
// host contexts (service unit tests).
var _t = (typeof window !== 'undefined' && typeof window._t === 'function')
  ? window._t
  : (key, vars) => key;

/**
 * NovaByte OS — Lock Screen v2 (com.nbosp.service.lock-screen)
 *
 * Two related surfaces sharing one visual language:
 *
 *  ── The login picker ── appears whenever there is no active session:
 *  cold boot, after sign out, or after a switch. Full-bleed dimmed
 *  wallpaper, a large clock and date, a horizontal set of account tiles
 *  (public-safe fields only: avatar, display name, role badge, status),
 *  an optional guest tile when machine policy enables guest access, and
 *  power controls in the corner. Zero accounts ⇒ first boot: the NovaByte
 *  Setup app (com.nbosp.setup, an AOSP-style .novaapp wizard) owns the
 *  whole first-run experience — this service launches it full-screen and
 *  only falls back to an in-picker notice when the app cannot start.
 *
 *  ── The locked screen ── appears over an ACTIVE session: the current
 *  account's avatar and name, their PIN pad (4 or 6 dots, per the
 *  account's PIN length) or passphrase field, a biometric button when
 *  that account has enrolled WebAuthn credentials, and a switch-user
 *  affordance that suspends the session and returns to the picker
 *  without ending it.
 *
 * The auth sheet is the only place a credential is ever typed, and in
 * multi-user mode it submits straight to the server (SessionManager →
 * POST /api/auth/reverify) — the client never sees a hash. Machines
 * with multi-user mode disabled keep the 3.0.2 client-side PBKDF2
 * verification byte-for-byte.
 */

let _wipeCountdownId = 0;

// ── Mode helpers ─────────────────────────────────────────────────────

function multiUserEnabled() {
  return typeof NovaUserScope !== 'undefined' && NovaUserScope?.enabled?.();
}

function sessionManager() {
  return (typeof SessionManager !== 'undefined' && SessionManager) || null;
}

// Current surface: 'hidden' | 'locked' | 'picker' | 'picker-auth' | 'forced-pin' | 'setup'
let surface = 'hidden';

// ── PIN sheet state ──────────────────────────────────────────────────

let enteredPin = '';
let sheetAccount = null;      // public account record the sheet is authenticating
let sheetMode = 'pin';        // 'pin' | 'passphrase'
let sheetResumable = false;    // sheet targets a parked (suspended) session
let passphraseValue = '';

// ── First-boot setup (NovaByte Setup .novaapp) ───────────────────────

// The wizard itself lives in the com.nbosp.setup system app; this service
// only detects "no accounts yet" and hands the machine over to it. Rapid
// relaunch counting keeps a crashing setup package from spawn-looping the
// window manager — after two quick closes the picker shows the fallback
// notice instead of launching it again.
let setupWindowId = null;
let setupLastLaunch = 0;
let setupRapidCloses = 0;
const SETUP_APP_ID = 'com.nbosp.setup';

// ── Keyboard handler ─────────────────────────────────────────────────

function handleLockScreenKeydown(e) {
  const lockScreenEl = document.getElementById('lock-screen');
  if (!lockScreenEl?.classList.contains('active')) {
    document.removeEventListener('keydown', handleLockScreenKeydown);
    return;
  }
  if (surface === 'picker') {
    handlePickerKeydown(e, lockScreenEl);
    return;
  }
  if (surface === 'setup') return; // the wizard owns its own keyboard handling
  if (surface === 'forced-pin') {
    // The forced-PIN card owns the keyboard while it is up: digit keys must
    // never fall through into the hidden sheet's enterPinDigit →
    // verifySheetSecret → manager.unlock attempts. The card's own inputs
    // take the keystrokes; Enter submits only from inside those inputs.
    const card = document.getElementById('lock-forced-pin');
    const activeId = document.activeElement?.id;
    if (card && e.key === 'Enter' && (activeId === 'fp-pin' || activeId === 'fp-pin2')) {
      e.preventDefault();
      card.querySelector('.fw-submit')?.click();
    }
    return;
  }
  if (sheetMode === 'passphrase') {
    if (e.key === 'Enter') { e.preventDefault(); verifySheetSecret(); }
    return; // the field handles its own input
  }
  if (e.key >= '0' && e.key <= '9') { e.preventDefault(); enterPinDigit(e.key); }
  else if (e.key === 'Backspace') { e.preventDefault(); backspacePin(); }
  else if (e.key === 'Enter') { e.preventDefault(); submitSheetIfComplete(); }
  else if (e.key === 'Escape') { e.preventDefault(); clearPin(); }
}

function submitSheetIfComplete() {
  const pinLength = sheetAccount?.pinLength || 4;
  if (enteredPin.length === pinLength) verifyPin();
}

// ── Shared sheet rendering (numpad + dots are reused components) ─────

const STOCK_WALLPAPER_ID = 'stock-blue';
let lockWallpaperRequest = 0;

/**
 * The login picker always shows stock blue; an account's own wallpaper only
 * appears once that account is the one being unlocked. The account's hive is
 * peeked read-only because nobody has authenticated yet, so it can't be mounted.
 */
async function wallpaperFor(account) {
  if (!account) return { id: STOCK_WALLPAPER_ID, custom: null };
  // The picker may redact usernames, so resolve the UID-scoped mirror first.
  const peek = (path) => {
    const segment = account.username || account.uname || account.uid;
    try { return window.NovaRegistry?.peekUserValue?.(segment, path); } catch (_) { return undefined; }
  };
  let id;
  let custom = null;
  try {
    id = await window.NovaSettingsShim?.peekLockWallpaperId?.(account.uid);
    custom = await window.NovaSettingsShim?.peekLockWallpaper?.(account.uid) || null;
  } catch (error) {
    console.warn('[LockScreen] Could not load the account lock wallpaper:', error);
  }
  if (typeof id !== 'string') id = peek('HKNU/shell/lockWallpaper');
  return { id: typeof id === 'string' ? id : STOCK_WALLPAPER_ID, custom };
}

async function setLockWallpaper(account) {
  const request = ++lockWallpaperRequest;
  const lockScreenEl = document.getElementById('lock-screen');
  const service = window.WallpaperService;
  if (!lockScreenEl || typeof service?.styleFor !== 'function') return;
  let layer = lockScreenEl.querySelector(':scope > .lock-wallpaper');
  if (!layer) {
    layer = createEl('div', { className: 'lock-wallpaper', 'aria-hidden': 'true' });
    lockScreenEl.prepend(layer);
  }
  const { id, custom } = await wallpaperFor(account);
  if (request !== lockWallpaperRequest) return;
  Object.assign(layer.style, service.styleFor(id, custom));
}

function renderLockScreen() {
  const usernameEl = document.getElementById('lock-username');
  const dotsEl = document.getElementById('lock-pin-dots');
  const statusEl = document.getElementById('lock-status');
  const numpadEl = document.getElementById('lock-numpad');
  if (!usernameEl || !dotsEl || !statusEl || !numpadEl) return;

  if (multiUserEnabled()) {
    const manager = sessionManager();
    const account = sheetAccount || (manager ? manager.state() : null);
    usernameEl.textContent = account?.displayName || account?.uname || _t('shell.lock.signIn');
    const pinLength = Math.min(Math.max(account?.pinLength || 4, 4), 6);
    dotsEl.innerHTML = '';
    for (let i = 0; i < pinLength; i++) {
      dotsEl.appendChild(createEl('div', { className: 'lock-pin-dot' }));
    }
  } else {
    usernameEl.textContent = OS.username || '';
    dotsEl.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      dotsEl.appendChild(createEl('div', { className: 'lock-pin-dot' }));
    }
  }
  statusEl.textContent = '';
  numpadEl.innerHTML = '';

  for (let i = 1; i <= 9; i++) {
    const btn = createEl('button', { textContent: String(i), 'aria-label': String(i) });
    btn.addEventListener('click', () => enterPinDigit(String(i)));
    numpadEl.appendChild(btn);
  }
  const clearBtn = createEl('button', { textContent: 'C', 'aria-label': _t('shell.lock.clearAria') });
  clearBtn.addEventListener('click', clearPin);
  numpadEl.appendChild(clearBtn);

  const zeroBtn = createEl('button', { textContent: '0', 'aria-label': '0' });
  zeroBtn.addEventListener('click', () => enterPinDigit('0'));
  numpadEl.appendChild(zeroBtn);

  const backBtn = createEl('button', { 'aria-label': _t('shell.lock.backspaceAria') });
  backBtn.innerHTML = svgIcon('chevron-left', 18);
  backBtn.addEventListener('click', backspacePin);
  numpadEl.appendChild(backBtn);

  // Biometric unlock button — added once per lock screen mount.
  const biometricReady = multiUserEnabled()
    ? (sheetAccount?.hasBiometric || sessionManager()?.state()?.via === 'webauthn')
    : (window.PublicKeyCredential && OS.settings.get('biometricCredentialId'));
  if (window.PublicKeyCredential && biometricReady) {
    const lockScreenEl = document.getElementById('lock-screen');
    if (lockScreenEl && !lockScreenEl.querySelector('.biometric-btn')) {
      const bioBtn = createEl('button', {
        className: 'biometric-btn',
        style: 'margin-top:16px;width:100%;padding:12px;background:var(--bg-elevated);border:1px solid var(--accent);border-radius:8px;color:var(--accent);font-weight:600;cursor:pointer;'
      });
      bioBtn.textContent = _t('shell.lock.useBiometric');
      bioBtn.addEventListener('click', () => attemptBiometricUnlock(statusEl));
      numpadEl.parentNode?.appendChild(bioBtn);
    }
  }

  enteredPin = '';
  updatePinDots();
  // Remove before re-adding so re-renders don't stack keydown listeners.
  document.removeEventListener('keydown', handleLockScreenKeydown);
  document.addEventListener('keydown', handleLockScreenKeydown);
}

// ── Sheet: PIN entry ─────────────────────────────────────────────────

function enterPinDigit(d) {
  const pinLength = (multiUserEnabled() ? (sheetAccount?.pinLength || 4) : 4);
  if (enteredPin.length >= pinLength) return;
  enteredPin += d;
  updatePinDots();
  if (enteredPin.length === pinLength) verifyPin();
}

function clearPin() {
  enteredPin = '';
  passphraseValue = '';
  updatePinDots();
  const statusEl = document.getElementById('lock-status');
  if (statusEl) statusEl.textContent = '';
}

function backspacePin() {
  enteredPin = enteredPin.slice(0, -1);
  updatePinDots();
}

function updatePinDots() {
  document.querySelectorAll('.lock-pin-dot').forEach((dot, i) =>
    dot.classList.toggle('filled', i < enteredPin.length)
  );
}

// ── Sheet: verification ──────────────────────────────────────────────

async function verifyPin() {
  const statusEl = document.getElementById('lock-status');
  if (!statusEl) return;

  if (multiUserEnabled()) {
    await verifySheetSecret();
    return;
  }

  // ── Legacy single-user path (multi-user disabled): byte-identical ──
  if (OS.lockoutUntil && Date.now() < OS.lockoutUntil) {
    const remaining = Math.ceil((OS.lockoutUntil - Date.now()) / 1000);
    statusEl.textContent = _t('shell.lock.lockedOut', { seconds: remaining });
    enteredPin = '';
    updatePinDots();
    EventLog?.log?.({ app: 'System', category: 'security', severity: 'warn', message: `PIN attempt blocked — lockout active (${remaining}s remaining)` });
    return;
  }

  statusEl.textContent = _t('shell.lock.verifying');

  let hash;
  try {
    if (!OS.workers?.crypto?.call) throw new Error('crypto worker unavailable');
    if (typeof getPinSalt !== 'function') throw new Error('PIN salt provider unavailable');
    hash = await OS.workers.crypto.call('pbkdf2', enteredPin, getPinSalt());
  } catch (err) {
    statusEl.textContent = _t('shell.lock.verificationUnavailable', { message: err?.message || 'try again' });
    enteredPin = '';
    updatePinDots();
    EventLog?.log?.({ app: 'System', category: 'security', severity: 'error', message: `PIN verification failed: ${err?.message || err}` });
    return;
  }

  if (hash === OS.lockPin) {
    OS.wrongPinCount = 0;
    OS.lockoutUntil = 0;
    unlockFromLockScreen();
    return;
  }

  // Wrong PIN — escalate lockout based on attempt count.
  OS.wrongPinCount++;
  enteredPin = '';
  updatePinDots();
  EventLog?.log?.({ app: 'System', category: 'security', severity: 'warn', message: `Incorrect PIN entered (attempt ${OS.wrongPinCount})`, data: { wrongPinCount: OS.wrongPinCount } });

  const THRESHOLD = 3;
  const DURATION_MS = 30_000;

  if (OS.wrongPinCount >= THRESHOLD && OS.wrongPinCount < THRESHOLD * 2) {
    applyLockout(statusEl, DURATION_MS);
  } else if (OS.wrongPinCount >= THRESHOLD * 2 && OS.wrongPinCount < 10) {
    applyLockout(statusEl, DURATION_MS * 5);
  } else if (OS.wrongPinCount >= 10) {
    triggerSecurityWipe(statusEl);
  } else {
    statusEl.textContent = _t('shell.lock.incorrectPin');
  }
}

/**
 * Multi-user sheet verification — always a server round-trip. The sheet is
 * the only place a credential is ever typed; the lockout ladder runs on the
 * server where a compromised webview cannot reset the counter.
 */
async function verifySheetSecret() {
  const statusEl = document.getElementById('lock-status');
  if (!statusEl) return;
  const manager = sessionManager();
  if (!manager) {
    statusEl.textContent = _t('shell.lock.sessionUnavailable');
    return;
  }

  const secret = sheetMode === 'passphrase' ? passphraseValue : enteredPin;
  if (!secret) {
    statusEl.textContent = sheetMode === 'passphrase' ? _t('shell.lock.enterPassphrase') : _t('shell.lock.enterPin');
    return;
  }

  statusEl.textContent = _t('shell.lock.verifying');

  let result;
  if (sheetResumable && sheetAccount) {
    // Picker flow on a parked (suspended) session: re-verification resumes it.
    result = await manager.resumeUser(sheetAccount.uid, secret);
    if (!result?.ok && ['AUTH_REQUIRED', 'NO_SESSION', 'NOT_SUSPENDED'].includes(result?.code)) {
      // A server-side credential reset can revoke a session that is still
      // parked in this process. Authenticate afresh instead of requiring a restart.
      sheetResumable = false;
      result = await manager.login({ uid: sheetAccount.uid, secret });
    }
  } else if (sheetAccount && (surface === 'picker' || surface === 'picker-auth')) {
    // Picker login: fresh authentication as this account.
    result = await manager.login({ uid: sheetAccount.uid, secret });
  } else {
    // Locked session of the active account.
    result = await manager.unlock(secret);
  }

  if (result?.ok) {
    clearPin();
    passphraseValue = '';
    unlockFromLockScreen();
    if (result.mustChangePin) showForcedPinChange();
    return;
  }

  enteredPin = '';
  passphraseValue = '';
  updatePinDots();
  const sheet = document.getElementById('lock-screen');
  sheet?.querySelector('.lock-sheet-card')?.classList.remove('shake');
  requestAnimationFrame(() => sheet?.querySelector('.lock-sheet-card')?.classList.add('shake'));

  if (result?.retryAfterMs && result.retryAfterMs > 0) {
    startServerLockoutCountdown(statusEl, result.retryAfterMs, result.message);
  } else {
    statusEl.textContent = result?.message || _t('shell.lock.incorrectPin');
  }
  EventLog?.log?.({
    app: 'System', category: 'security', severity: 'warn',
    message: `Sign-in failed: ${result?.code || 'BAD_CREDENTIAL'}${sheetAccount ? ` (account: ${sheetAccount.displayName || sheetAccount.username})` : ''}`,
  });
}

function startServerLockoutCountdown(statusEl, durationMs, message) {
  const label = message || _t('shell.lock.tooManyAttempts');
  let remaining = Math.ceil(durationMs / 1000);
  const render = () => {
    statusEl.textContent = remaining > 0
      ? _t('shell.lock.tryAgainIn', { label, seconds: remaining })
      : '';
  };
  render();
  const id = setInterval(() => {
    remaining -= 1;
    render();
    if (remaining <= 0) clearInterval(id);
  }, 1000);
}

// ── Sheet: passphrase mode ───────────────────────────────────────────

function showPassphraseField() {
  sheetMode = 'passphrase';
  enteredPin = '';
  passphraseValue = '';
  const dotsEl = document.getElementById('lock-pin-dots');
  const numpadEl = document.getElementById('lock-numpad');
  if (dotsEl) dotsEl.innerHTML = '';
  if (numpadEl) numpadEl.innerHTML = '';
  const statusEl = document.getElementById('lock-status');
  if (statusEl) statusEl.textContent = '';

  const existing = document.getElementById('lock-passphrase');
  if (existing) existing.remove();
  const numpad = document.getElementById('lock-numpad');
  const card = numpad?.parentElement;
  if (!card) return;
  const field = createEl('input', {
    id: 'lock-passphrase',
    type: 'password',
    autocomplete: 'current-password',
    placeholder: _t('shell.lock.passphrase'),
    'aria-label': _t('shell.lock.passphraseAria'),
  });
  Object.assign(field.style, {
    width: '100%', maxWidth: '260px', padding: '12px 14px',
    borderRadius: '10px', border: '1px solid var(--border-default)',
    background: 'var(--bg-overlay)', color: 'var(--text-primary)',
    fontSize: '14px', outline: 'none', textAlign: 'center',
  });
  field.addEventListener('input', () => { passphraseValue = field.value; });
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); verifySheetSecret(); }
  });
  card.insertBefore(field, document.getElementById('lock-status'));
  field.focus();

  const back = createEl('button', {
    id: 'lock-passphrase-back',
    textContent: _t('shell.lock.usePinInstead'),
    'aria-label': _t('shell.lock.usePinInsteadAria'),
  });
  Object.assign(back.style, {
    marginTop: '10px', padding: '6px 12px', borderRadius: '8px',
    border: '1px solid var(--border-default)', background: 'transparent',
    color: 'var(--text-secondary)', fontSize: '12px', cursor: 'pointer',
  });
  back.addEventListener('click', showPinPadForAccount);
  card.insertBefore(back, document.getElementById('lock-status'));
}

function showPinPadForAccount() {
  sheetMode = 'pin';
  const field = document.getElementById('lock-passphrase');
  field?.remove();
  const back = document.getElementById('lock-passphrase-back');
  back?.remove();
  renderLockScreen();
}

// ── Biometric unlock ─────────────────────────────────────────────────

async function attemptBiometricUnlock(statusEl) {
  const manager = sessionManager();
  try {
    const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!available) { statusEl.textContent = _t('shell.lock.biometricUnavailable'); return; }
    if (multiUserEnabled() && manager && sheetAccount?.uid) {
      statusEl.textContent = _t('shell.lock.waitingBiometric');
      const result = await manager.webauthnLogin({ uid: sheetAccount.uid });
      if (result.ok) {
        unlockFromLockScreen();
        if (result.mustChangePin) {
          // A must-change account must land on the forced new-PIN card —
          // biometric login skips the sheet, so route it here exactly the
          // way verifySheetSecret does for PIN/passphrase logins.
          showForcedPinChange();
        } else if (typeof Notify !== 'undefined' && typeof Notify.show === 'function') {
          Notify.show({ title: _t('shell.lock.welcomeBack'), body: _t('shell.lock.authenticatedViaBiometrics'), type: 'success', appName: 'System' });
        }
      } else {
        statusEl.textContent = _t('shell.lock.biometricFailed', { message: result.message || _t('shell.lock.tryYourPin') });
      }
      return;
    }

    // Legacy single-user path.
    statusEl.textContent = _t('shell.lock.waitingBiometric');
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const credentialId = OS.settings.get('biometricCredentialId');
    const credBytes = Uint8Array.fromBase64
      ? Uint8Array.fromBase64(credentialId)
      : Uint8Array.from(atob(credentialId), c => c.charCodeAt(0));

    const credential = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ id: credBytes, type: 'public-key' }],
        userVerification: 'required'
      }
    });
    if (credential) {
      unlockFromLockScreen();
      if (typeof Notify !== 'undefined' && typeof Notify.show === 'function') {
        Notify.show({ title: _t('shell.lock.welcomeBack'), body: _t('shell.lock.authenticatedViaBiometrics'), type: 'success', appName: 'System' });
      }
    }
  } catch (err) {
    statusEl.textContent = _t('shell.lock.biometricFailed', { message: err?.message || _t('shell.lock.tryPin') });
  }
}

// ── Unlock / hide ────────────────────────────────────────────────────

function unlockFromLockScreen() {
  OS.isLocked = false;
  EventLog?.log?.({ app: 'System', category: 'security', severity: 'info', message: 'Screen unlocked' });

  // Cancel any pending wipe countdown — biometric auth must be able to abort it.
  if (_wipeCountdownId) {
    clearInterval(_wipeCountdownId);
    _wipeCountdownId = 0;
  }

  sheetAccount = null;
  hideAllSurfaces();
  enteredPin = '';
  passphraseValue = '';

  WM.updateTaskbar();
  requestAnimationFrame(() => { renderDesktopIcons(); WM.updateTaskbar(); });
}

function hideAllSurfaces() {
  document.getElementById('lock-screen')?.classList.remove('active');
  document.getElementById('lock-screen')?.querySelector('.lock-picker')?.remove();
  document.getElementById('lock-passphrase')?.remove();
  document.getElementById('lock-passphrase-back')?.remove();
  document.getElementById('lock-switch-user')?.remove();
  document.getElementById('lock-passphrase-toggle')?.remove();
  document.getElementById('lock-picker-back')?.remove();
  document.getElementById('lock-forced-pin')?.remove();
  document.removeEventListener('keydown', handleLockScreenKeydown);
  surface = 'hidden';
}

/** Dev HUD comes down with every gate surface (see lockScreen/showLoginPicker). */
function hideDebugOverlayAtGate() {
  // The login/lock gate must never leak dev HUD info (memory, URLs, window
  // geometry) to whoever is standing at the screen. mountUserScope() applies
  // the signed-in account's own dev surface once the gate is past. hide()
  // (not disable()) so the user's debugOverlayVisible preference survives.
  try { if (window.DebugOverlay?.hide) window.DebugOverlay.hide(); else window.DebugOverlay?.disable?.(); } catch (_) { }
}

// ── Lock (the active session) ────────────────────────────────────────

async function lockScreen() {
  if (multiUserEnabled()) {
    const manager = sessionManager();
    if (!manager || !manager.active()) {
      // No live session: the picker IS the gate.
      await showLoginPicker();
      return;
    }
    OS.isLocked = true;
    surface = 'locked';
    hideDebugOverlayAtGate();
    sheetAccount = {
      uid: manager.state().uid,
      displayName: manager.state().displayName || manager.state().uname,
      uname: manager.state().uname,
      pinLength: 4,
    };
    // Best-effort account metadata for the sheet (dots count, biometric).
    try {
      if (manager.listAccounts) {
        const accounts = await manager.listAccounts();
        const match = accounts.users?.find((u) => u.uid === sheetAccount.uid);
        if (match) sheetAccount = match;
      }
    } catch (_) { }
    setLockWallpaper(sheetAccount);
    document.getElementById('lock-screen')?.classList.add('active');
    showPinPadForAccount();
    await manager.lock?.();
    EventLog?.log?.({ app: 'System', category: 'security', severity: 'info', message: 'Screen locked' });
    return;
  }

  if (!OS.lockPin) { WM.minimizeAll(); return; }
  OS.isLocked = true;
  hideDebugOverlayAtGate();
  document.getElementById('lock-screen')?.classList.add('active');
  renderLockScreen();
  EventLog?.log?.({ app: 'System', category: 'security', severity: 'info', message: 'Screen locked' });
}

/** Lock showing the sheet for a specific account (API parity helper). */
async function lockForUser(uid) {
  if (!multiUserEnabled()) { await lockScreen(); return; }
  const manager = sessionManager();
  try {
    if (manager?.listAccounts) {
      const accounts = await manager.listAccounts();
      sheetAccount = accounts.users?.find((u) => u.uid === uid) || { uid, displayName: uid };
    }
  } catch (_) { }
  OS.isLocked = true;
  surface = 'locked';
  hideDebugOverlayAtGate();
  document.getElementById('lock-screen')?.classList.add('active');
  showPinPadForAccount();
}

// ── Login picker ─────────────────────────────────────────────────────

/**
 * Canonical user-switch entry point for shell surfaces (the Settings app's
 * admin lock panel and the Users app's expired-session banner): suspend the
 * current session first, then show the login picker. Calling
 * showLoginPicker() directly from those buttons did nothing — it bails while
 * a session is locally active/guest (the M10 re-activation guard), so the
 * suspend must happen first, exactly like the lock screen's own
 * "Switch user" button does.
 */
async function switchUser() {
  const manager = sessionManager();
  if (manager?.suspendForSwitch) {
    try {
      await manager.suspendForSwitch();
    } catch (_) {
      // authFetch never throws, but if anything above failed mid-teardown
      // the picker is still the right next surface.
    }
  }
  await showLoginPicker();
}

async function showLoginPicker() {
  if (!multiUserEnabled()) { await lockScreen(); return; }
  const manager = sessionManager();
  if (!manager) return;

  // BUG (2026-11-15 audit, finding M10): a guest (or active) session must
  // never have the picker re-activated over it. showLoginPicker() is async
  // and suspends on listAccounts(); when it resumes it used to rebuild the
  // gate unconditionally, even when the session it was invoked for had
  // already been replaced by a successful sign-in. Bail here instead.
  try {
    const st = manager.state?.();
    if (st && (st.status === 'guest' || st.status === 'active')) return;
  } catch (_) { /* state() unavailable in tests — keep legacy behaviour */ }

  surface = 'picker';
  hideDebugOverlayAtGate();
  sheetAccount = null;
  sheetResumable = false;
  sheetMode = 'pin';
  const accounts = await manager.listAccounts();

  const lockScreenEl = document.getElementById('lock-screen');
  if (!lockScreenEl) return;

  // Zero accounts = first boot: the NovaByte Setup app owns the whole
  // first-run experience (nothing account-shaped is hardcoded here). The
  // picker stays down while the wizard runs; if the app cannot start, or
  // closes without creating an account, the picker (re)appears below.
  if (!accounts.users?.length) {
    const launched = await launchFirstBootSetup(manager);
    if (launched) {
      hideAllSurfaces(); // picker chrome down while the wizard runs
      surface = 'setup';
      return;
    }
  }

  // Hide the sheet chrome while the picker is up.
  for (const id of ['lock-avatar', 'lock-username', 'lock-pin-dots', 'lock-status', 'lock-numpad', 'lock-passphrase', 'lock-passphrase-back', 'lock-switch-user', 'lock-passphrase-toggle', 'lock-picker-back']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  lockScreenEl.querySelector('.lock-picker')?.remove();
  setLockWallpaper(null);

  const picker = createEl('div', { className: 'lock-picker', role: 'group', 'aria-label': _t('shell.lock.accountPickerAria') });

  if (!accounts.users?.length) {
    picker.appendChild(buildSetupUnavailableNotice());
  } else {
    const clock = createEl('div', { className: 'lock-picker-clock' });
    const now = new Date();
    clock.appendChild(createEl('div', {
      className: 'lp-time',
      textContent: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      'aria-label': _t('shell.lock.currentTimeAria'),
    }));
    clock.appendChild(createEl('div', {
      className: 'lp-date',
      textContent: now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }),
      'aria-label': _t('shell.lock.currentDateAria'),
    }));
    picker.appendChild(clock);

    picker.appendChild(createEl('div', {
      className: 'lock-picker-title',
      textContent: _t('shell.lock.whoSigningIn'),
      role: 'heading', 'aria-level': 1,
    }));

    const tiles = createEl('div', { className: 'lock-picker-tiles' });
    const suspended = new Map((manager.suspendedUsers?.() || []).map((u) => [u.uid, u]));
    for (const user of accounts.users) {
      tiles.appendChild(buildAccountTile(user, { resumable: suspended.has(user.uid), showUsername: !!accounts.policies?.showUsernames }));
    }
    if (accounts.policies?.guestAccess) {
      tiles.appendChild(buildGuestTile());
    }
    picker.appendChild(tiles);

    const status = createEl('div', { className: 'lock-picker-status', 'aria-live': 'assertive', id: 'lock-picker-status' });
    picker.appendChild(status);
  }

  picker.appendChild(buildPowerControls());

  lockScreenEl.appendChild(picker);
  lockScreenEl.classList.add('active');

  document.removeEventListener('keydown', handleLockScreenKeydown);
  document.addEventListener('keydown', handleLockScreenKeydown);
  EventLog?.log?.({ app: 'System', category: 'security', severity: 'info', message: 'Login picker shown' });
}

function tileAvatar(user) {
  const avatar = createEl('div', { className: 'lp-avatar', 'aria-hidden': 'true' });
  if (typeof user.avatar === 'string' && user.avatar && user.avatar.length <= 8) {
    avatar.textContent = user.avatar;
  } else {
    const source = user.displayName || user.username || '?';
    avatar.textContent = String(source).trim().charAt(0).toUpperCase() || '?';
  }
  return avatar;
}

function buildAccountTile(user, { resumable = false, showUsername = false } = {}) {
  const tile = createEl('button', {
    className: 'lp-tile',
    'aria-label': _t('shell.lock.signInAsAria', { name: `${user.displayName || user.username}${user.roleLabel ? `, ${user.roleLabel}` : ''}` }),
  });
  if (resumable) tile.classList.add('resumable');
  if (user.locked) tile.classList.add('locked');

  tile.appendChild(tileAvatar(user));
  tile.appendChild(createEl('div', { className: 'lp-name', textContent: user.displayName || user.username }));
  if (showUsername) tile.appendChild(createEl('div', { className: 'lp-uname', textContent: user.username }));

  const chips = createEl('div', { className: 'lp-chips' });
  // Admin accounts carry a small shield chip so anyone at the screen can
  // see who holds management power.
  if (user.role === 'admin' || user.role === 'owner') {
    chips.appendChild(createEl('span', { className: 'lp-chip lp-chip-admin', title: _t('shell.lock.accountType', { role: user.roleLabel }) }));
  }
  if (user.locked) {
    chips.appendChild(createEl('span', { className: 'lp-chip lp-chip-locked', textContent: _t('shell.lock.locked') }));
  } else if (resumable) {
    chips.appendChild(createEl('span', { className: 'lp-chip lp-chip-resume', textContent: _t('shell.lock.resumable') }));
  }
  tile.appendChild(chips);

  tile.addEventListener('click', () => {
    selectAccountForAuth(user, { resumable }).catch((error) => {
      console.error('[LockScreen] Could not open account sign-in:', error);
    });
  });
  return tile;
}

function buildGuestTile() {
  const tile = createEl('button', { className: 'lp-tile lp-tile-guest', 'aria-label': _t('shell.lock.continueAsGuestAria') });
  const avatar = createEl('div', { className: 'lp-avatar', 'aria-hidden': 'true', textContent: 'G' });
  tile.appendChild(avatar);
  tile.appendChild(createEl('div', { className: 'lp-name', textContent: _t('shell.lock.guest') }));
  tile.appendChild(createEl('div', { className: 'lp-uname', textContent: _t('shell.lock.ephemeralSession') }));
  tile.addEventListener('click', async () => {
    const manager = sessionManager();
    if (!manager) return;
    await manager.guestLogin();
    unlockFromLockScreen();
  });
  return tile;
}

function buildPowerControls() {
  const row = createEl('div', { className: 'lock-picker-power', 'aria-label': _t('shell.lock.powerControlsAria') });
  const mk = (label, title, action) => {
    const btn = createEl('button', { className: 'lp-power-btn', textContent: label, title, 'aria-label': title });
    btn.addEventListener('click', action);
    return btn;
  };
  row.appendChild(mk(_t('shell.lock.restart'), _t('shell.lock.restartNovaByte'), () => location.reload()));
  row.appendChild(mk(_t('shell.lock.powerOff'), _t('shell.lock.powerOffAria'), () => {
    try {
      if (typeof nw !== 'undefined' && nw?.App?.quit) nw.App.quit();
      else window.close();
    } catch (_) { window.close(); }
  }));
  return row;
}

function handlePickerKeydown(e, lockScreenEl) {
  const tiles = [...lockScreenEl.querySelectorAll('.lp-tile')];
  if (!tiles.length) return;
  const focused = document.activeElement?.classList?.contains('lp-tile')
    ? tiles.indexOf(document.activeElement)
    : -1;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault();
    tiles[(focused + 1 + tiles.length) % tiles.length].focus();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault();
    tiles[(focused - 1 + tiles.length) % tiles.length].focus();
  } else if (e.key === 'Enter' && focused >= 0) {
    e.preventDefault();
    tiles[focused].click();
  } else if (/^[1-9]$/.test(e.key) && tiles[Number(e.key) - 1]) {
    e.preventDefault();
    tiles[Number(e.key) - 1].click();
  }
}

/**
 * The per-account auth sheet from the picker: adapts to what the account
 * actually has — a 4- or 6-dot PIN pad driven by the account's PIN length,
 * a passphrase field for passphrase accounts, and a biometric button only
 * when WebAuthn descriptors exist for that uid.
 */
async function selectAccountForAuth(user, { resumable = false } = {}) {
  sheetAccount = user;
  sheetResumable = resumable;
  surface = 'picker-auth';
  sheetMode = 'pin';

  const lockScreenEl = document.getElementById('lock-screen');
  const pickerEl = lockScreenEl?.querySelector('.lock-picker');
  if (pickerEl) pickerEl.style.display = 'none';

  for (const id of ['lock-avatar', 'lock-username', 'lock-pin-dots', 'lock-status', 'lock-numpad']) {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  }
  const avatar = document.getElementById('lock-avatar');
  if (avatar) {
    if (typeof user.avatar === 'string' && user.avatar && user.avatar.length <= 8) avatar.textContent = user.avatar;
    else avatar.textContent = String(user.displayName || user.username || '?').charAt(0).toUpperCase();
  }

  renderLockScreen();

  const card = document.getElementById('lock-numpad')?.parentElement;
  if (card) {
    // Back-to-picker affordance.
    const existingBack = document.getElementById('lock-picker-back');
    existingBack?.remove();
    const back = createEl('button', { id: 'lock-picker-back', textContent: _t('shell.lock.allAccounts'), 'aria-label': _t('shell.lock.allAccountsAria') });
    Object.assign(back.style, {
      marginTop: '14px', padding: '6px 14px', borderRadius: '8px',
      border: '1px solid var(--border-default)', background: 'transparent',
      color: 'var(--text-secondary)', fontSize: '12px', cursor: 'pointer',
    });
    back.addEventListener('click', () => { showLoginPicker(); });
    card.appendChild(back);

    // Passphrase affordance for accounts that carry one.
    const existingToggle = document.getElementById('lock-passphrase-toggle');
    existingToggle?.remove();
    if (user.hasPassphrase) {
      const toggle = createEl('button', { id: 'lock-passphrase-toggle', textContent: _t('shell.lock.usePassphrase'), 'aria-label': _t('shell.lock.usePassphraseAria') });
      Object.assign(toggle.style, {
        marginTop: '10px', padding: '6px 12px', borderRadius: '8px',
        border: '1px solid var(--border-default)', background: 'transparent',
        color: 'var(--text-secondary)', fontSize: '12px', cursor: 'pointer',
      });
      toggle.addEventListener('click', showPassphraseField);
      card.appendChild(toggle);
    }

    // Switch-user affordance when a live session is being gated instead.
    const existingSwitch = document.getElementById('lock-switch-user');
    existingSwitch?.remove();
    const manager = sessionManager();
    if (manager?.active() && !resumable) {
      const switchBtn = createEl('button', { id: 'lock-switch-user', textContent: _t('shell.lock.switchUser'), 'aria-label': _t('shell.lock.switchUserAria') });
      Object.assign(switchBtn.style, {
        marginTop: '10px', padding: '6px 12px', borderRadius: '8px',
        border: '1px solid var(--accent)', background: 'transparent',
        color: 'var(--accent)', fontSize: '12px', cursor: 'pointer',
      });
      switchBtn.addEventListener('click', async () => {
        await manager.suspendForSwitch();
        await showLoginPicker();
      });
      card.appendChild(switchBtn);
    }
  }
  await setLockWallpaper(user);
}

// ── First-boot setup (launches the NovaByte Setup .novaapp) ───────────

/**
 * Zero accounts on the machine: hand the first-run experience over to the
 * NovaByte Setup system app (com.nbosp.setup) — the AOSP-style multi-step
 * wizard that creates the owner account. Nothing account-shaped stays
 * hardcoded here: the wizard is a signed .novaapp, so it can be updated,
 * extended or replaced like any other system package. Failures fall back
 * to a notice in the picker instead of a broken gate.
 */
async function launchFirstBootSetup(manager) {
  if (typeof WM === 'undefined' || typeof WM.createWindow !== 'function') return false;
  if (!manager || typeof manager.setupOwner !== 'function') return false;
  if (setupRapidCloses >= 2) return false; // crashing package — stop relaunching

  const app = (typeof OS !== 'undefined' && OS.apps) ? OS.apps[SETUP_APP_ID] : null;
  if (!app || typeof app.init !== 'function') {
    console.error('[LockScreen] NovaByte Setup (' + SETUP_APP_ID + ') is not registered');
    return false;
  }

  try {
    const id = WM.createWindow(SETUP_APP_ID, {
      x: 0,
      y: 0,
      width: window.innerWidth || 1280,
      height: window.innerHeight || 800,
      fullscreen: true,
    });
    if (!id) return false;
    setupWindowId = id;
    setupLastLaunch = Date.now();
    surface = 'setup';

    const onClosed = ({ appId, id: closedId } = {}) => {
      if (appId !== SETUP_APP_ID || closedId !== setupWindowId) return;
      try { OS.events?.off?.('app:closed', onClosed); } catch (_) { }
      setupWindowId = null;
      // A setup window that closes without creating an account re-offers
      // the gate; rapid closes are counted so a crashing package cannot
      // spawn-loop (rapidCloses >= 2 keeps the fallback notice instead).
      if (Date.now() - setupLastLaunch < 8000) setupRapidCloses++;
      const session = sessionManager();
      if (session && session.active?.()) return;
      showLoginPicker().catch(() => { });
    };
    try {
      OS.events?.on?.('app:closed', onClosed);
    } catch (_) { }

    EventLog?.log?.({ app: 'System', category: 'security', severity: 'info', message: 'First-boot setup started (NovaByte Setup)' });
    return true;
  } catch (error) {
    console.error('[LockScreen] NovaByte Setup launch failed:', error);
    return false;
  }
}

/** Fallback notice when the Setup app itself cannot run (damaged bundle). */
function buildSetupUnavailableNotice() {
  const wrap = createEl('div', { className: 'lock-wizard', role: 'alert' });
  wrap.appendChild(createEl('div', { className: 'lock-picker-title', textContent: _t('shell.lock.setUpNovaByte'), role: 'heading', 'aria-level': 1 }));
  wrap.appendChild(createEl('div', {
    className: 'lock-wizard-sub',
    textContent: _t('shell.lock.setupUnavailable'),
  }));
  const retry = createEl('button', { className: 'fw-submit', textContent: _t('shell.lock.retrySetup'), 'aria-label': _t('shell.lock.retrySetupAria') });
  Object.assign(retry.style, {
    marginTop: '14px', padding: '12px 22px', borderRadius: '10px',
    border: '1px solid var(--accent)', background: 'var(--accent-muted)',
    color: 'var(--accent)', fontSize: '14px', fontWeight: 600, cursor: 'pointer',
  });
  retry.addEventListener('click', async () => {
    setupRapidCloses = 0;
    const launched = await launchFirstBootSetup(sessionManager());
    if (launched) hideAllSurfaces();
  });
  wrap.appendChild(retry);
  return wrap;
}

// ── Forced new-PIN sheet (admin reset / temporary PIN) ────────────────

function showForcedPinChange() {
  const manager = sessionManager();
  if (!manager) return;
  const lockScreenEl = document.getElementById('lock-screen');
  if (!lockScreenEl) return;

  const existing = document.getElementById('lock-forced-pin');
  existing?.remove();

  // Hide the base sheet chrome while the forced-PIN card is up — the same
  // element set showLoginPicker hides for the picker — so the card is the
  // only visible surface (avatar/name/numpad underneath used to bleed
  // through behind the card).
  for (const id of ['lock-avatar', 'lock-username', 'lock-pin-dots', 'lock-status', 'lock-numpad', 'lock-passphrase', 'lock-passphrase-back', 'lock-switch-user', 'lock-passphrase-toggle', 'lock-picker-back']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  lockScreenEl.querySelector('.biometric-btn')?.remove(); // sibling of the numpad, not hidden by the loop
  lockScreenEl.querySelector('.lock-picker')?.remove();

  const card = createEl('div', { id: 'lock-forced-pin', className: 'lock-forced-pin', role: 'form', 'aria-label': _t('shell.lock.setNewPinAria') });
  card.appendChild(createEl('div', { className: 'lock-picker-title', textContent: _t('shell.lock.chooseNewPin'), role: 'heading', 'aria-level': 2 }));
  card.appendChild(createEl('div', { className: 'lock-wizard-sub', textContent: _t('shell.lock.pinResetNotice') }));

  const pin = createEl('input', { id: 'fp-pin', type: 'password', inputmode: 'numeric', maxlength: '6', placeholder: _t('shell.lock.newPin'), 'aria-label': _t('shell.lock.newPin') });
  const pin2 = createEl('input', { id: 'fp-pin2', type: 'password', inputmode: 'numeric', maxlength: '6', placeholder: _t('shell.lock.confirmNewPin'), 'aria-label': _t('shell.lock.confirmNewPin') });
  for (const input of [pin, pin2]) {
    Object.assign(input.style, {
      width: '260px', padding: '10px 12px', borderRadius: '10px', margin: '4px 0',
      border: '1px solid var(--border-default)', background: 'var(--bg-overlay)',
      color: 'var(--text-primary)', fontSize: '13px', outline: 'none', textAlign: 'center',
    });
    card.appendChild(input);
  }
  const status = createEl('div', { className: 'lock-picker-status', id: 'fp-status', 'aria-live': 'assertive' });
  card.appendChild(status);
  const submit = createEl('button', { className: 'fw-submit', textContent: _t('shell.lock.saveNewPin'), 'aria-label': _t('shell.lock.saveNewPinAria') });
  Object.assign(submit.style, {
    marginTop: '12px', padding: '12px 22px', borderRadius: '10px',
    border: '1px solid var(--accent)', background: 'var(--accent-muted)',
    color: 'var(--accent)', fontSize: '14px', fontWeight: 600, cursor: 'pointer',
  });
  submit.addEventListener('click', async () => {
    if (!/^\d{4,6}$/.test(pin.value)) { status.textContent = _t('shell.lock.pinDigits'); return; }
    if (pin.value !== pin2.value) { status.textContent = _t('shell.lock.pinsNoMatch'); return; }
    const result = await manager.changePin(null, pin.value);
    if (result.ok) {
      // Restore the sheet chrome's default visibility first — a later
      // lockScreen() must not inherit the hidden state — then run the same
      // teardown unlockFromLockScreen() performs, so the overlay cannot
      // stick over the live desktop with a dead 'forced-pin' surface.
      for (const id of ['lock-avatar', 'lock-username', 'lock-pin-dots', 'lock-status', 'lock-numpad']) {
        const el = document.getElementById(id);
        if (el) el.style.display = '';
      }
      unlockFromLockScreen();
      EventLog?.log?.({ app: 'System', category: 'security', severity: 'info', message: 'New PIN saved (forced change)' });
    }
    else status.textContent = result.message || _t('shell.lock.couldNotSavePin');
  });
  card.appendChild(submit);

  lockScreenEl.appendChild(card);
  lockScreenEl.classList.add('active');
  surface = 'forced-pin';
  pin.focus();
}

// ── Legacy lockout / wipe helpers (single-user mode only) ─────────────

function applyLockout(statusEl, durationMs) {
  const sec = Math.round(durationMs / 1000);
  const label = sec >= 60 ? `${Math.round(sec / 60)}min` : `${sec}s`;
  statusEl.textContent = _t('shell.lock.lockout', { label });
  OS.lockoutUntil = Date.now() + durationMs;
  EventLog?.log?.({
    app: 'System', category: 'security', severity: 'warn',
    message: `Lockout triggered (${label}) after ${OS.wrongPinCount} failed PIN attempts`,
    data: { wrongPinCount: OS.wrongPinCount, durationMs }
  });
  setTimeout(() => {
    OS.wrongPinCount = 0;
    OS.lockoutUntil = 0;
    statusEl.textContent = '';
  }, durationMs);
}

function triggerSecurityWipe(statusEl) {
  statusEl.textContent = _t('shell.lock.securityAlert');
  EventLog?.log?.({
    app: 'System', category: 'security', severity: 'error',
    message: `Security wipe countdown started after ${OS.wrongPinCount} failed PIN attempts`,
    data: { wrongPinCount: OS.wrongPinCount }
  });

  let countdown = 10;
  _wipeCountdownId = setInterval(() => {
    countdown--;
    statusEl.textContent = _t('shell.lock.securityWiping', { seconds: countdown });
    if (countdown > 0) return;

    clearInterval(_wipeCountdownId);
    _wipeCountdownId = 0;
    localStorage.clear();
    sessionStorage.clear();
    EventLog?.log?.({ app: 'System', category: 'security', severity: 'error', message: 'Security wipe executed — all local data cleared' });
    Notify.show({
      title: _t('shell.lock.securityWipe'),
      body: _t('shell.lock.wipedBody'),
      type: 'error', appName: 'System'
    });
    setTimeout(() => location.reload(), 2000);
  }, 1000);
}

// ── Idle lock ─────────────────────────────────────────────────────────

let lastActivity = Date.now();
const _resetIdleTimer = () => { lastActivity = Date.now(); };
['pointerdown', 'pointermove', 'keydown', 'scroll'].forEach(evt => {
  document.addEventListener(evt, _resetIdleTimer, { passive: true });
});

setInterval(() => {
  // Truthy check on idleTimeout guards against undefined/0/null — without it,
  // an unset idleTimeout would compare NaN < Infinity (false) and never lock,
  // but a 0 would lock on the very first tick.
  if (OS.lockPin && !OS.isLocked && OS.idleTimeout && OS.idleTimeout < Infinity) {
    if (Date.now() - lastActivity > OS.idleTimeout) lockScreen();
  } else if (multiUserEnabled()) {
    const manager = sessionManager();
    if (manager && manager.isActive() && !OS.isLocked && OS.idleTimeout && OS.idleTimeout < Infinity) {
      if (Date.now() - lastActivity > OS.idleTimeout) lockScreen();
    }
  }
}, 30_000);

// ── Session event wiring ─────────────────────────────────────────────

try {
  const manager = sessionManager();
  manager?.on?.((event) => {
    if (event?.name === 'session:changed' && event.uid) {
      // A signed-in account: the gate is done — the setup window (if the
      // owner was just created through it) closes itself on its finish step.
      if (surface !== 'forced-pin') unlockFromLockScreen();
      setupRapidCloses = 0;
    }
    if (event?.name === 'session:loggedout' || (event?.name === 'session:changed' && event.uid === null && event.phase !== 'picker' && event.phase !== 'setup' && event.phase !== 'guest')) {
      // BUG (2026-11-15 audit, finding M10): guestLogin()'s session:changed
      // (uid:null, no phase) used to match this "signed out" condition, so
      // the picker re-appeared over every live guest session. The emit now
      // carries phase:'guest' (excluded above) — and showLoginPicker()
      // itself re-checks the session state, so any future event-shape
      // regression cannot resurrect the gate over an active/guest desktop.
      showLoginPicker().catch(() => { });
    }
  });
} catch (_) { /* SessionManager loads before this service; guards cover dev/test loads */ }

// ── Live re-localisation ─────────────────────────────────────────────
// The shell can flip the OS language while a lock surface is up (OOBE
// finishing its language step, remote policy). The static markup's
// data-i18n labels are re-applied by the engine's own applyStaticDom pass;
// everything this service builds dynamically is re-rendered below through
// the same builders other interactions call, so an already-visible gate
// follows the switch in real time.

// Targeted re-label of the auth-sheet affordances renderLockScreen() never
// rebuilds (created by selectAccountForAuth / showPassphraseField) plus the
// biometric button that is only added once per mount. In-place .textContent
// passes keep a partially typed passphrase and the sheet's mode intact.
function relabelAuthSheet() {
  const setLabel = (id, textKey, ariaKey) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (textKey) el.textContent = _t(textKey);
    if (ariaKey) el.setAttribute('aria-label', _t(ariaKey));
  };
  setLabel('lock-passphrase-back', 'shell.lock.usePinInstead', 'shell.lock.usePinInsteadAria');
  setLabel('lock-picker-back', 'shell.lock.allAccounts', 'shell.lock.allAccountsAria');
  setLabel('lock-passphrase-toggle', 'shell.lock.usePassphrase', 'shell.lock.usePassphraseAria');
  setLabel('lock-switch-user', 'shell.lock.switchUser', 'shell.lock.switchUserAria');
  const passphraseEl = document.getElementById('lock-passphrase');
  if (passphraseEl) {
    passphraseEl.placeholder = _t('shell.lock.passphrase');
    passphraseEl.setAttribute('aria-label', _t('shell.lock.passphraseAria'));
  }
  const bioBtn = document.querySelector('#lock-screen .biometric-btn');
  if (bioBtn) bioBtn.textContent = _t('shell.lock.useBiometric');
}

// The forced-PIN sheet is relabelled in place instead of re-built so the
// admin-reset PIN the user may already have typed survives the switch.
function relabelForcedPinSheet() {
  const card = document.getElementById('lock-forced-pin');
  if (!card) return;
  card.setAttribute('aria-label', _t('shell.lock.setNewPinAria'));
  const title = card.querySelector('.lock-picker-title');
  if (title) title.textContent = _t('shell.lock.chooseNewPin');
  const sub = card.querySelector('.lock-wizard-sub');
  if (sub) sub.textContent = _t('shell.lock.pinResetNotice');
  for (const [id, key] of [['fp-pin', 'shell.lock.newPin'], ['fp-pin2', 'shell.lock.confirmNewPin']]) {
    const input = document.getElementById(id);
    if (input) {
      input.placeholder = _t(key);
      input.setAttribute('aria-label', _t(key));
    }
  }
  const submit = card.querySelector('.fw-submit');
  if (submit) {
    submit.textContent = _t('shell.lock.saveNewPin');
    submit.setAttribute('aria-label', _t('shell.lock.saveNewPinAria'));
  }
}

function rerenderLockSurfaceForLanguage() {
  if (!document.getElementById('lock-screen')?.classList.contains('active')) return;
  if (surface === 'setup') return; // the Setup wizard owns its own localisation
  if (surface === 'picker') {
    // The picker derives wholly from account data — the normal show path
    // removes and rebuilds it, and is safe to re-run on its own surface.
    showLoginPicker().catch(() => { });
    return;
  }
  if (surface === 'forced-pin') {
    relabelForcedPinSheet();
    return;
  }
  if (surface === 'locked' || surface === 'picker-auth') {
    if (sheetMode === 'passphrase') {
      // Rebuilding the numpad here would re-show the pad alongside the
      // passphrase field; the field also keeps its typed value, so the
      // surface stays consistent with an in-place relabel only.
      relabelAuthSheet();
      return;
    }
    // renderLockScreen() resets enteredPin and clears the transient status
    // line — snapshot the PIN so a half-typed code survives the switch.
    const partialPin = enteredPin;
    renderLockScreen();
    enteredPin = partialPin;
    updatePinDots();
    relabelAuthSheet();
  }
}

function handleLockScreenLanguageChanged() {
  try {
    const lockScreenEl = document.getElementById('lock-screen');
    window.NovaI18n?.applyStaticDom?.(lockScreenEl || document);
    rerenderLockSurfaceForLanguage();
  } catch (error) {
    console.warn('[LockScreen] Language change re-render failed:', error);
  }
}

// The service is a singleton loaded exactly once per host page (the system
// service loader memoises its load promise), so this subscription lives for
// the page lifetime — no window owns the surface, so there is no
// state.cleanups contract to un-register through.
try {
  typeof OS !== 'undefined' && OS.events?.on?.('languageChanged', handleLockScreenLanguageChanged);
} catch (_) { /* event bus unavailable (service unit tests) */ }

window.LockScreenService = Object.freeze({ lockScreen, showLoginPicker, switchUser, lockForUser, state: () => surface });
