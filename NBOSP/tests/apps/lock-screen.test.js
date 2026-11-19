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

  async function loadMultiUser({ loginResult = { ok: false, code: 'BAD_CREDENTIAL', message: 'Incorrect PIN' }, changePinResult = null, webauthnResult = null, status = 'loggedout', accountList = ACCOUNTS, extraStubs = {} } = {}) {
    const loginCalls = [];
    const changePinCalls = [];
    const webauthnCalls = [];
    const suspendCalls = [];
    const workerCalls = [];
    // Mirrors the real SessionManager: suspendForSwitch() flips the local
    // status to 'suspended' even when the server call fails.
    const stateBox = { status };
    const manager = {
      state: () => ({ status: stateBox.status, uid: stateBox.status === 'loggedout' ? null : 'u-ada-001', uname: stateBox.status === 'loggedout' ? null : 'ada', displayName: stateBox.status === 'loggedout' ? null : 'Ada', role: stateBox.status === 'loggedout' ? null : 'owner' }),
      active: () => false,
      isActive: () => false,
      isAdmin: () => false,
      suspendedUsers: () => [],
      listAccounts: async () => ({ ok: true, users: accountList, policies: { guestAccess: true, showUsernames: true } }),
      login: async (args) => { loginCalls.push(args); return loginResult; },
      unlock: async (secret) => ({ ok: false, code: 'BAD_CREDENTIAL', message: 'Incorrect PIN' }),
      resumeUser: async () => ({ ok: false }),
      suspendForSwitch: async () => { suspendCalls.push(1); stateBox.status = 'suspended'; return { ok: true }; },
      guestLogin: async () => ({ ok: true, guest: true }),
      changePin: changePinResult
        ? async (currentSecret, newPin) => { changePinCalls.push([currentSecret, newPin]); return changePinResult; }
        : async () => ({ ok: false, code: 'CHANGE_PIN_FAILED', message: 'no stub' }),
      webauthnLogin: webauthnResult
        ? async (args) => { webauthnCalls.push(args); return webauthnResult; }
        : async () => ({ ok: false, code: 'UNAVAILABLE', message: 'no webauthn' }),
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
          ...extraStubs,
        },
      },
    });
    dom = loaded.dom;
    loaded.document.body.innerHTML = LOCK_SCREEN_MARKUP;
    return { ...loaded, manager, loginCalls, changePinCalls, webauthnCalls, suspendCalls, wmCalls, workerCalls, scope };
  }

  async function loadFirstBoot({
    setupRegistered = true,
    loginResult = { ok: false, code: 'BAD_CREDENTIAL', message: 'Incorrect PIN' },
  } = {}) {
    const manager = {
      state: () => ({ status: 'loggedout', uid: null, uname: null, displayName: null, role: null }),
      active: () => false,
      isActive: () => false,
      isAdmin: () => false,
      suspendedUsers: () => [],
      listAccounts: async () => ({ ok: true, users: [], policies: { guestAccess: false } }),
      login: async (args) => loginResult,
      unlock: async () => ({ ok: false }),
      resumeUser: async () => ({ ok: false }),
      suspendForSwitch: async () => ({ ok: true }),
      guestLogin: async () => ({ ok: true, guest: true }),
      webauthnLogin: async () => ({ ok: false, code: 'UNAVAILABLE' }),
      setupOwner: async (payload) => ({ ok: true, user: { uid: 'u-owner', username: payload.username, role: 'owner' } }),
      on: () => () => {},
    };
    const createdWindows = [];
    const maximized = [];
    const scope = { enabled: () => true, uid: () => '', ownerUid: () => '', activeUsername: () => '' };
    const apps = setupRegistered
      ? { 'com.nbosp.setup': { id: 'com.nbosp.setup', name: 'NovaByte Setup', init: async () => {}, frame: true } }
      : {};
    const wmCalls = [];
    const eventLogCalls = [];
    // A real (tiny) event bus — the setup window lifecycle rides app:closed.
    const handlers = Object.create(null);
    const events = {
      on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
      off: (name, fn) => {
        const list = handlers[name] || [];
        const at = list.indexOf(fn);
        if (at > -1) list.splice(at, 1);
      },
      emit: (name, payload) => {
        wmCalls.push({ name, payload });
        for (const fn of [...(handlers[name] || [])]) fn(payload);
      },
    };
    const loaded = await loadServiceApp('lock-screen', {
      withBaseUtils: true,
      stubs: {
        extra: {
          OS: {
            lockPin: null, username: 'Nova', isLocked: false,
            lockoutUntil: 0, wrongPinCount: 0, idleTimeout: Infinity,
            settings: { get: () => null },
            apps,
            windows: new Map(),
            events,
          },
          WM: {
            minimizeAll: () => {},
            updateTaskbar: () => wmCalls.push('updateTaskbar'),
            createWindow: (appId, opts) => { createdWindows.push({ appId, opts }); return `win-${createdWindows.length}`; },
            toggleMaximize: (id) => maximized.push(id),
            closeWindow: () => {},
          },
          EventLog: { log: (e) => eventLogCalls.push(e) },
          Notify: { show: () => {} },
          getPinSalt: () => 'static-salt',
          renderDesktopIcons: () => {},
          NovaUserScope: scope,
          SessionManager: manager,
        },
      },
    });
    dom = loaded.dom;
    loaded.document.body.innerHTML = LOCK_SCREEN_MARKUP;
    return { ...loaded, manager, createdWindows, maximized, wmCalls, eventLogCalls };
  }

  it('first boot with zero accounts launches the NovaByte Setup app, not an inline wizard', async () => {
    const { window, document, createdWindows, maximized, eventLogCalls } = await loadFirstBoot();
    await window.LockScreenService.showLoginPicker();
    await settle();

    // The setup app owns the first-run experience: a true fullscreen window
    // with no shell chrome and NO account fields hardcoded in the lock screen.
    expect(createdWindows).toHaveLength(1);
    expect(createdWindows[0].appId).toBe('com.nbosp.setup');
    expect(createdWindows[0].opts.fullscreen).toBe(true);
    expect(maximized).toEqual([]);
    expect(document.getElementById('lock-screen').className).not.toContain('active');
    expect(document.querySelector('#fw-username')).toBeNull();
    expect(document.querySelector('.lock-wizard input')).toBeNull();
    expect(eventLogCalls[0]).toMatchObject({ category: 'security', message: 'First-boot setup started (NovaByte Setup)' });
  });

  it('setup window closing without an account re-offers the gate, counting rapid closes', async () => {
    const { window, document, createdWindows } = await loadFirstBoot();
    await window.LockScreenService.showLoginPicker();
    await settle();
    expect(createdWindows).toHaveLength(1);

    // First close (< 8s): the picker relaunches setup — the gate re-offers.
    window.OS.events.emit('app:closed', { id: 'win-1', appId: 'com.nbosp.setup' });
    await settle(50);
    expect(createdWindows).toHaveLength(2);

    // Second rapid close and third: after two rapid closes the fallback
    // notice shows instead of another launch (crash-loop guard).
    window.OS.events.emit('app:closed', { id: 'win-2', appId: 'com.nbosp.setup' });
    await settle(50);
    window.OS.events.emit('app:closed', { id: 'win-2', appId: 'com.nbosp.setup' });
    await settle(50);
    expect(createdWindows).toHaveLength(2);
    expect(document.querySelector('.lock-wizard')).toBeTruthy(); // fallback notice
    expect(document.querySelector('.lock-wizard').textContent).toContain('could not start');
    expect(document.getElementById('lock-screen').className).toContain('active');
  });

  it('when the Setup app is missing the picker shows the fallback notice with a retry', async () => {
    const { window, document, createdWindows } = await loadFirstBoot({ setupRegistered: false });
    await window.LockScreenService.showLoginPicker();
    await settle();

    expect(createdWindows).toEqual([]); // nothing to launch
    expect(document.getElementById('lock-screen').className).toContain('active');
    const notice = document.querySelector('.lock-wizard');
    expect(notice).toBeTruthy();
    expect(notice.textContent).toContain('damaged');

    // Retry re-attempts the launch (and the notice stays when it fails).
    notice.querySelector('button.fw-submit').click();
    await settle(30);
    expect(createdWindows).toEqual([]);
    expect(document.querySelector('.lock-wizard')).toBeTruthy();
  });

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

  it('switchUser() suspends the active session first, then shows the picker (dead-button fix)', async () => {
    // Regression: Settings' "Switch user" / Users' "Sign in" used to call
    // showLoginPicker() directly, which bails while a session is locally
    // active (M10 guard) — the buttons did nothing. switchUser() must do the
    // suspend-then-picker dance the lock screen's own button does.
    const { window, document, suspendCalls } = await loadMultiUser({ status: 'active' });
    expect(window.SessionManager.state().status).toBe('active');

    // direct picker call is still correctly refused for an active session
    await window.LockScreenService.showLoginPicker();
    await settle();
    expect(suspendCalls).toEqual([]);
    expect(document.querySelector('.lock-picker')).toBeNull();

    // the switch verb suspends first — then the picker opens
    await window.LockScreenService.switchUser();
    await settle();
    expect(suspendCalls).toEqual([1]);
    expect(window.LockScreenService.state()).toBe('picker');
    expect(document.querySelector('.lock-picker')).toBeTruthy();
    expect([...document.querySelectorAll('.lp-tile')]).toHaveLength(3);
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

  it('shows stock blue on the picker and only switches to an account\'s wallpaper on its PIN screen', async () => {
    // User hives are mounted by username, while wallpaper blobs use the account UID.
    const stored = { ada: { lockId: 'stock-red' }, sam: { lockId: 'stock-green' } };
    const peekedSegments = [];
    const { window, document } = await loadMultiUser({
      extraStubs: {
        // the machine's desktop is still wearing whoever logged off last
        WallpaperService: { styleFor: (id) => ({ backgroundImage: `url("${id}.png")` }) },
        NovaRegistry: { peekUserValue: (segment, path) => {
          peekedSegments.push(segment);
          return path === 'HKNU/shell/lockWallpaper' ? stored[segment]?.lockId : undefined;
        } },
      },
    });
    const layerImage = () => document.querySelector('#lock-screen > .lock-wallpaper').style.backgroundImage;

    await window.LockScreenService.showLoginPicker();
    await settle();
    expect(layerImage()).toBe('url("stock-blue.png")');

    [...document.querySelectorAll('.lp-tile')][0].click(); // Ada
    await settle();
    expect(layerImage()).toBe('url("stock-red.png")');

    document.getElementById('lock-picker-back').click();
    await settle();
    expect(layerImage()).toBe('url("stock-blue.png")');
    // the PIN screen's back button must not linger above the picker
    expect(document.getElementById('lock-picker-back').style.display).toBe('none');

    [...document.querySelectorAll('.lp-tile')][1].click(); // Sam
    await settle();
    expect(layerImage()).toBe('url("stock-green.png")');
    expect(peekedSegments).toContain('ada');
    expect(peekedSegments).toContain('sam');
  });

  it('uses the UID-scoped preset when the picker redacts account usernames', async () => {
    const accountList = ACCOUNTS.map(({ username, ...account }) => account);
    const { window, document } = await loadMultiUser({
      accountList,
      extraStubs: {
        WallpaperService: { styleFor: (id) => ({ backgroundImage: `url("${id}.png")` }) },
        NovaRegistry: { peekUserValue: () => undefined },
        NovaSettingsShim: {
          peekLockWallpaperId: async (uid) => uid === 'u-sam-002' ? 'stock-purple' : null,
        },
      },
    });

    await window.LockScreenService.showLoginPicker();
    await settle();
    [...document.querySelectorAll('.lp-tile')][1].click(); // Sam, username redacted
    await settle();

    expect(document.getElementById('lock-username').textContent).toBe('Sam');
    expect(document.querySelector('#lock-screen > .lock-wallpaper').style.backgroundImage)
      .toBe('url("stock-purple.png")');
  });

  it('uses the selected account custom image and returns to stock blue on the picker', async () => {
    const { window, document } = await loadMultiUser({
      extraStubs: {
        WallpaperService: {
          styleFor: (id, custom) => ({
            backgroundImage: custom ? `url("${custom}")` : `url("${id}.png")`,
          }),
        },
        NovaRegistry: { peekUserValue: () => 'stock-blue' },
        NovaSettingsShim: { peekLockWallpaper: async (uid) => uid === 'u-ada-001' ? 'data:image/png;base64,ada' : null },
      },
    });

    await window.LockScreenService.showLoginPicker();
    await settle();
    [...document.querySelectorAll('.lp-tile')][0].click();
    await settle();
    expect(document.querySelector('#lock-screen > .lock-wallpaper').style.backgroundImage)
      .toBe('url("data:image/png;base64,ada")');

    document.getElementById('lock-picker-back').click();
    await settle();
    expect(document.querySelector('#lock-screen > .lock-wallpaper').style.backgroundImage)
      .toBe('url("stock-blue.png")');
  });

  it('does not let a late account wallpaper read overwrite the picker wallpaper', async () => {
    let resolveAdaWallpaper;
    const adaWallpaper = new Promise((resolve) => { resolveAdaWallpaper = resolve; });
    const { window, document } = await loadMultiUser({
      extraStubs: {
        WallpaperService: {
          styleFor: (id, custom) => ({
            backgroundImage: custom ? `url("${custom}")` : `url("${id}.png")`,
          }),
        },
        NovaRegistry: { peekUserValue: () => 'stock-red' },
        NovaSettingsShim: { peekLockWallpaper: (uid) => uid === 'u-ada-001' ? adaWallpaper : Promise.resolve(null) },
      },
    });

    await window.LockScreenService.showLoginPicker();
    await settle();
    [...document.querySelectorAll('.lp-tile')][0].click();
    await settle();
    document.getElementById('lock-picker-back').click();
    await settle();

    expect(document.querySelector('#lock-screen > .lock-wallpaper').style.backgroundImage)
      .toBe('url("stock-blue.png")');

    resolveAdaWallpaper('data:image/png;base64,ada');
    await settle();
    expect(document.querySelector('#lock-screen > .lock-wallpaper').style.backgroundImage)
      .toBe('url("stock-blue.png")');
  });

  it('falls back to stock blue for an account whose hive has no wallpaper yet', async () => {
    const { window, document } = await loadMultiUser({
      extraStubs: {
        WallpaperService: { styleFor: (id) => ({ backgroundImage: `url("${id}.png")` }) },
        NovaRegistry: { peekUserValue: () => undefined },
      },
    });
    await window.LockScreenService.showLoginPicker();
    await settle();
    [...document.querySelectorAll('.lp-tile')][0].click();
    await settle();
    expect(document.querySelector('#lock-screen > .lock-wallpaper').style.backgroundImage).toBe('url("stock-blue.png")');
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

  it('a must-change login lands on the forced-PIN card: chrome hidden, digits never leak into unlock attempts, success tears the gate down', async () => {
    const { window, document, loginCalls, changePinCalls } = await loadMultiUser({
      loginResult: { ok: true, user: ACCOUNTS[1], mustChangePin: true },
      changePinResult: { ok: true },
    });
    await window.LockScreenService.showLoginPicker();
    await settle();
    [...document.querySelectorAll('.lp-tile')][1].click(); // Sam, 4-digit PIN
    await settle();
    await pressPin(document, window, '4321'); // 4th digit auto-submits the sheet
    await settle(50);

    // The forced-PIN card is up and the sheet chrome underneath is hidden.
    const card = document.getElementById('lock-forced-pin');
    expect(card).toBeTruthy();
    expect(document.getElementById('lock-screen').className).toContain('active');
    expect(window.LockScreenService.state()).toBe('forced-pin');
    expect(document.getElementById('lock-numpad').style.display).toBe('none');
    expect(document.getElementById('lock-username').style.display).toBe('none');

    // Digit keys while the card is up never fall through into a new
    // verify/unlock round-trip (they drive the card's inputs or nothing).
    await pressPin(document, window, '9999');
    await settle(30);
    expect(loginCalls).toHaveLength(1); // only the original sheet verification

    // A successful save restores the chrome visibility and takes the whole
    // gate down — the overlay cannot stick with a dead 'forced-pin' surface.
    document.getElementById('fp-pin').value = '5678';
    document.getElementById('fp-pin2').value = '5678';
    card.querySelector('.fw-submit').click();
    await settle(50);
    expect(changePinCalls).toEqual([[null, '5678']]);
    expect(document.getElementById('lock-forced-pin')).toBeNull();
    expect(document.getElementById('lock-screen').className).not.toContain('active');
    expect(window.LockScreenService.state()).toBe('hidden');
    expect(document.getElementById('lock-numpad').style.display).toBe(''); // chrome restored for the next lock
  });

  it('a biometric login of a must-change account routes onto the forced-PIN card too', async () => {
    const { window, document, webauthnCalls } = await loadMultiUser({
      webauthnResult: { ok: true, mustChangePin: true },
    });
    // jsdom has no WebAuthn: provide the platform-authenticator surface the
    // button and the unlock path probe.
    window.PublicKeyCredential = {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
    };
    await window.LockScreenService.showLoginPicker();
    await settle();
    [...document.querySelectorAll('.lp-tile')][0].click(); // Ada (hasBiometric)
    await settle();
    const bioBtn = document.querySelector('#lock-screen .biometric-btn');
    expect(bioBtn).toBeTruthy();
    bioBtn.click();
    await settle(50);

    expect(webauthnCalls).toEqual([{ uid: 'u-ada-001' }]);
    expect(document.getElementById('lock-forced-pin')).toBeTruthy();
    expect(window.LockScreenService.state()).toBe('forced-pin');
    expect(document.getElementById('lock-screen').className).toContain('active');
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
    expect(Object.keys(svc)).toEqual(['lockScreen', 'showLoginPicker', 'switchUser', 'lockForUser', 'state']);
    expect(typeof svc.lockScreen).toBe('function');
    expect(typeof svc.showLoginPicker).toBe('function');
    expect(typeof svc.switchUser).toBe('function');
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
