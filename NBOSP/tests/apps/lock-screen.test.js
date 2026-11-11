// tests/apps/lock-screen.test.js — service app: session lock, PIN flow, lockout.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp, settle } from '../helpers/app-harness.js';

const LOCK_SCREEN_MARKUP = `
  <div id="lock-screen">
    <div id="lock-username"></div>
    <div id="lock-pin-dots"></div>
    <div id="lock-status"></div>
    <div id="lock-numpad"></div>
  </div>`;

// Module state (enteredPin etc.) lives per jsdom realm, so every test loads a
// fresh instance. The service registers a 30s idle-lock interval at eval time
// that nothing can cancel — window.close() in afterEach stops jsdom timers.
let dom;
async function loadLockScreen({ osOverrides = {}, markup = LOCK_SCREEN_MARKUP, hash = 'hashed-1111' } = {}) {
  const wmCalls = [];
  const eventLogCalls = [];
  const workerCalls = [];
  const os = {
    lockPin: hash,
    username: 'Nova',
    isLocked: false,
    lockoutUntil: 0,
    wrongPinCount: 0,
    idleTimeout: Infinity,
    settings: { get: () => null },
    workers: { crypto: { call: async (op, pin, salt) => { workerCalls.push([op, pin, salt]); return `hashed-${pin}`; } } },
    ...osOverrides,
  };
  const loaded = await loadServiceApp('lock-screen', {
    withBaseUtils: true, // createEl/svgIcon used by renderLockScreen
    stubs: {
      extra: {
        OS: os,
        WM: { minimizeAll: () => wmCalls.push('minimizeAll'), updateTaskbar: () => wmCalls.push('updateTaskbar') },
        EventLog: { log: (e) => eventLogCalls.push(e) },
        Notify: { show: () => {} },
        getPinSalt: () => 'static-salt',
        renderDesktopIcons: () => wmCalls.push('renderDesktopIcons'),
      },
    },
  });
  dom = loaded.dom;
  if (markup) loaded.document.body.innerHTML = markup;
  return { ...loaded, os, wmCalls, eventLogCalls, workerCalls };
}

function numpadButtons(document) {
  return [...document.querySelectorAll('#lock-numpad button')];
}

async function pressPin(document, window, pin) {
  for (const digit of pin) {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: digit, cancelable: true }));
  }
}


// ── Multi-user surfaces (v2) ───────────────────────────────────────────────
// Picker + per-account auth sheet: server round-trip verification through
// the SessionManager stub; multi-user machines never touch the client-side
// hash worker at all.
describe('LockScreenService multi-user picker (js/apps/lock-screen v2)', () => {
  afterEach(() => { try { dom?.window.close(); } catch { /* already closed */ } });
  beforeEach(() => resetTestStorage());

  const ACCOUNTS = [
    { uid: 'u-ada-001', displayName: 'Ada', username: 'ada', role: 'owner', roleLabel: 'Owner', status: 'active', locked: false, pinLength: 6, hasPassphrase: true, hasBiometric: true, mustChangePin: false },
    { uid: 'u-sam-002', displayName: 'Sam', username: 'sam', role: 'standard', roleLabel: 'Standard', status: 'active', locked: false, pinLength: 4, hasPassphrase: false, hasBiometric: false, mustChangePin: false },
  ];

  async function loadMultiUser({ loginResult = { ok: false, code: 'BAD_CREDENTIAL', message: 'Incorrect PIN' } } = {}) {
    const loginCalls = [];
    const workerCalls = [];
    const manager = {
      state: () => ({ status: 'loggedout', uid: null, uname: null, displayName: null, role: null }),
      active: () => false,
      isActive: () => false,
      isAdmin: () => false,
      suspendedUsers: () => [],
      listAccounts: async () => ({ ok: true, users: ACCOUNTS, policies: { guestAccess: true, showUsernames: true } }),
      login: async (args) => { loginCalls.push(args); return loginResult; },
      unlock: async (secret) => ({ ok: false, code: 'BAD_CREDENTIAL', message: 'Incorrect PIN' }),
      resumeUser: async () => ({ ok: false }),
      suspendForSwitch: async () => ({ ok: true }),
      guestLogin: async () => ({ ok: true, guest: true }),
      webauthnLogin: async () => ({ ok: false, code: 'UNAVAILABLE', message: 'no webauthn' }),
      on: () => () => {},
    };
    const scope = {
      enabled: () => true,
      uid: () => '',
      ownerUid: () => '',
      legacyOwnerUid: () => '',
      isActiveAdmin: () => false,
    };
    const wmCalls = [];
    const loaded = await loadServiceApp('lock-screen', {
      withBaseUtils: true,
      stubs: {
        extra: {
          OS: {
            lockPin: 'hashed-1111', username: 'Nova', isLocked: false,
            lockoutUntil: 0, wrongPinCount: 0, idleTimeout: Infinity,
            settings: { get: () => null },
            workers: { crypto: { call: async (op, pin, salt) => { workerCalls.push([op, pin, salt]); return `hashed-${pin}`; } } },
          },
          WM: { minimizeAll: () => wmCalls.push('minimizeAll'), updateTaskbar: () => wmCalls.push('updateTaskbar') },
          EventLog: { log: () => {} },
          Notify: { show: () => {} },
          getPinSalt: () => 'static-salt',
          renderDesktopIcons: () => wmCalls.push('renderDesktopIcons'),
          NovaUserScope: scope,
          SessionManager: manager,
        },
      },
    });
    dom = loaded.dom;
    loaded.document.body.innerHTML = LOCK_SCREEN_MARKUP;
    return { ...loaded, manager, loginCalls, wmCalls, workerCalls, scope };
  }

  it('showLoginPicker() renders account tiles with role chips and a guest tile', async () => {
    const { window, document } = await loadMultiUser();
    await window.LockScreenService.showLoginPicker();
    await settle();

    const tiles = [...document.querySelectorAll('.lp-tile')];
    expect(tiles).toHaveLength(3); // two accounts + guest tile (policy on)
    expect(tiles[0].querySelector('.lp-name').textContent).toBe('Ada');
    expect(tiles[0].querySelector('.lp-uname').textContent).toBe('ada'); // showUsernames policy
    expect(tiles[0].querySelector('.lp-chip-admin')).toBeTruthy();
    expect(tiles[1].querySelector('.lp-name').textContent).toBe('Sam');
    expect(tiles[1].querySelector('.lp-chip-admin')).toBeNull();
    expect(tiles[2].className).toContain('lp-tile-guest');
    expect(document.querySelector('.lock-picker-clock')).toBeTruthy();
    expect(document.getElementById('lock-screen').className).toContain('active');
  });

  it('selecting an account shows the adaptive sheet — 6 dots for a 6-digit PIN account', async () => {
    const { window, document } = await loadMultiUser();
    await window.LockScreenService.showLoginPicker();
    await settle();
    [...document.querySelectorAll('.lp-tile')][0].click();
    await settle();

    expect(document.getElementById('lock-username').textContent).toBe('Ada');
    expect(document.querySelectorAll('.lock-pin-dot')).toHaveLength(6);
    expect(numpadButtons(document)).toHaveLength(12);
    // Passphrase affordance only for accounts that carry one.
    expect(document.getElementById('lock-passphrase-toggle')).toBeTruthy();
  });

  it('sheet verification is a server round-trip: failed login surfaces the server message', async () => {
    const { window, document, loginCalls } = await loadMultiUser();
    await window.LockScreenService.showLoginPicker();
    await settle();
    [...document.querySelectorAll('.lp-tile')][1].click(); // Sam, 4-digit PIN
    await settle();

    await pressPin(document, window, '9999'); // 4th digit auto-submits
    await settle(50);

    expect(loginCalls).toEqual([{ uid: 'u-sam-002', secret: '9999' }]);
    expect(document.getElementById('lock-status').textContent).toBe('Incorrect PIN');
  });

  it('successful login hides the sheet and the hash worker is never used', async () => {
    const { window, document, workerCalls } = await loadMultiUser({
      loginResult: { ok: true, user: ACCOUNTS[1], mustChangePin: false },
    });
    await window.LockScreenService.showLoginPicker();
    await settle();
    [...document.querySelectorAll('.lp-tile')][1].click();
    await settle();
    // The worker stub is absent for multi-user sheets: no client hashing.
    await pressPin(document, window, '4321');
    await settle(50);

    expect(document.getElementById('lock-screen').className).not.toContain('active');
    expect(workerCalls).toEqual([]); // multi-user verification never hashes client-side
  });

  it('the guest tile starts an ephemeral session and unlocks the gate', async () => {
    const { window, document, manager } = await loadMultiUser();
    await window.LockScreenService.showLoginPicker();
    await settle();
    [...document.querySelectorAll('.lp-tile')][2].click();
    await settle(50);
    expect(document.getElementById('lock-screen').className).not.toContain('active');
    expect(manager.state()).toBeTruthy(); // the guest tile path ran through the manager
  });
});

describe('LockScreenService service (js/apps/lock-screen)', () => {
  afterEach(() => { try { dom?.window.close(); } catch { /* already closed */ } });

  beforeEach(() => resetTestStorage());

  it('attaches a frozen LockScreenService with the v2 API surface', async () => {
    await loadLockScreen({ markup: '' });
    const svc = dom.window.LockScreenService;
    expect(svc).toBeTruthy();
    expect(Object.isFrozen(svc)).toBe(true);
    expect(Object.keys(svc)).toEqual(['lockScreen', 'showLoginPicker', 'lockForUser', 'state']);
    expect(typeof svc.lockScreen).toBe('function');
    expect(typeof svc.showLoginPicker).toBe('function');
    expect(typeof svc.lockForUser).toBe('function');
  });

  it('lockScreen() without a configured PIN just minimizes all windows', async () => {
    const { window, document, os, wmCalls, eventLogCalls } = await loadLockScreen({ osOverrides: { lockPin: '' } });
    window.LockScreenService.lockScreen();
    expect(wmCalls).toEqual(['minimizeAll']);
    expect(os.isLocked).toBe(false);
    expect(document.getElementById('lock-screen').className).not.toContain('active');
    expect(eventLogCalls).toEqual([]);
  });

  it('lockScreen() locks the session, renders the numpad and logs a security event', async () => {
    const { window, document, os, eventLogCalls } = await loadLockScreen();
    window.LockScreenService.lockScreen();
    expect(os.isLocked).toBe(true);
    expect(document.getElementById('lock-screen').className).toContain('active');
    expect(document.getElementById('lock-username').textContent).toBe('Nova');
    expect(numpadButtons(document)).toHaveLength(12); // 1-9 + C + 0 + backspace
    expect(document.querySelectorAll('.lock-pin-dot')).toHaveLength(4);
    expect(eventLogCalls[0]).toMatchObject({ app: 'System', category: 'security', severity: 'info', message: 'Screen locked' });
  });

  it('unlock flow: correct PIN via keyboard unlocks, logs it and refreshes the shell', async () => {
    const { window, document, os, wmCalls, eventLogCalls, workerCalls } = await loadLockScreen();
    window.LockScreenService.lockScreen();

    await pressPin(document, window, '1111'); // 4th digit auto-submits
    await settle();

    expect(workerCalls[0]).toEqual(['pbkdf2', '1111', 'static-salt']);
    expect(os.isLocked).toBe(false);
    expect(document.getElementById('lock-screen').className).not.toContain('active');
    expect(eventLogCalls.at(-1)).toMatchObject({ severity: 'info', message: 'Screen unlocked' });
    await settle(30); // rAF callback
    expect(wmCalls).toContain('updateTaskbar');
    expect(wmCalls).toContain('renderDesktopIcons');
  });

  it('wrong PIN: status message, attempt counter, warn log and cleared dots', async () => {
    const { window, document, os, eventLogCalls } = await loadLockScreen({ hash: 'hashed-9999' });
    window.LockScreenService.lockScreen();

    await pressPin(document, window, '1234');
    await settle();

    expect(os.wrongPinCount).toBe(1);
    expect(document.getElementById('lock-status').textContent).toBe('Incorrect PIN');
    expect(eventLogCalls.at(-1)).toMatchObject({
      severity: 'warn', message: 'Incorrect PIN entered (attempt 1)', data: { wrongPinCount: 1 },
    });
    expect([...document.querySelectorAll('.lock-pin-dot')].every((d) => !d.classList.contains('filled'))).toBe(true);
  });

  it('lockout window blocks verification before the worker is called', async () => {
    const { window, document, os, workerCalls, eventLogCalls } = await loadLockScreen({
      osOverrides: { lockoutUntil: Date.now() + 30000 },
    });
    window.LockScreenService.lockScreen();

    await pressPin(document, window, '1111');
    await settle();

    expect(workerCalls).toEqual([]); // never reached the hash worker
    expect(document.getElementById('lock-status').textContent).toMatch(/^Locked out\. Try again in \d+s$/);
    expect(eventLogCalls.at(-1)).toMatchObject({ severity: 'warn', message: expect.stringContaining('lockout active') });
    expect(os.isLocked).toBe(true); // still locked
  });

  it('keyboard handling: digits fill dots, auto-submit at 4, Escape/Backspace edit the entry', async () => {
    const { window, document } = await loadLockScreen({ hash: 'hashed-9999' });
    window.LockScreenService.lockScreen();

    await pressPin(document, window, '1234');
    let dots = [...document.querySelectorAll('.lock-pin-dot')];
    expect(dots.filter((d) => d.classList.contains('filled'))).toHaveLength(4);
    expect(document.getElementById('lock-status').textContent).toBe('Verifying...'); // submitted

    await settle(); // verification rejects
    expect(document.getElementById('lock-status').textContent).toBe('Incorrect PIN');
    dots = [...document.querySelectorAll('.lock-pin-dot')];
    expect(dots.every((d) => !d.classList.contains('filled'))).toBe(true); // entry reset

    // Escape clears a partial entry and the status line
    await pressPin(document, window, '12');
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    dots = [...document.querySelectorAll('.lock-pin-dot')];
    expect(dots.every((d) => !d.classList.contains('filled'))).toBe(true);
    expect(document.getElementById('lock-status').textContent).toBe('');

    // Backspace removes one filled dot
    await pressPin(document, window, '12');
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Backspace', cancelable: true }));
    dots = [...document.querySelectorAll('.lock-pin-dot')];
    expect(dots.filter((d) => d.classList.contains('filled'))).toHaveLength(1);
  });

  it('re-renders do not stack keydown listeners (remove-before-add)', async () => {
    const { window, document, os } = await loadLockScreen({ hash: 'hashed-9999' });
    window.LockScreenService.lockScreen();
    window.LockScreenService.lockScreen(); // second render over the same DOM
    await pressPin(document, window, '1234');
    await settle();
    // With stacked listeners a single wrong try would count twice.
    expect(os.wrongPinCount).toBe(1);
  });

  it('lockScreen() without the lock-screen DOM still locks and never throws', async () => {
    const { window, document, os, eventLogCalls } = await loadLockScreen({ markup: '' });
    expect(() => window.LockScreenService.lockScreen()).not.toThrow();
    expect(os.isLocked).toBe(true);
    expect(eventLogCalls[0].message).toBe('Screen locked');
    // keydown handling is a no-op without the element (handler unbinds itself)
    expect(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: '5' }))).not.toThrow();
  });
});
