// tests/apps/setup.test.js — NovaByte Setup: the AOSP-style first-boot wizard
// that lives in the com.nbosp.setup .novaapp instead of being hardcoded into
// the lock screen.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, settle } from '../helpers/app-harness.js';

let dom;

async function loadSetup({
  accounts = { users: [], policies: {} },
  setupResult = { ok: true, user: { uid: 'u-owner', username: 'ada', role: 'owner' } },
} = {}) {
  const setupCalls = [];
  const settingsWrites = [];
  const adminPuts = [];
  const closedWindows = [];
  const manager = {
    state: () => ({ status: 'loggedout', uid: null }),
    active: () => false,
    isAdmin: () => true,
    listAccounts: async () => ({ ok: true, users: accounts.users, policies: accounts.policies || {} }),
    setupOwner: async (payload) => { setupCalls.push(payload); return setupResult; },
    authFetch: async (path, init) => {
      adminPuts.push({ path, method: init?.method, body: init?.body });
      return { ok: true, json: { success: true } };
    },
  };
  const scope = { enabled: () => true, uid: () => '', activeUsername: () => '' };
  const osSettings = {
    set: (key, value) => settingsWrites.push([key, value]),
    get: () => null,
  };
  const loaded = await loadWindowApp('setup', {
    stubs: {
      extra: {
        OS: {
          settings: osSettings,
          events: { on: () => {}, off: () => {}, emit: () => {} },
          windows: new Map(),
        },
        WM: { closeWindow: (id) => closedWindows.push(id), toggleMaximize: () => {}, createWindow: () => null },
        SessionManager: manager,
        NovaUserScope: scope,
        EventLog: { log: () => {} },
        Notify: { show: () => {} },
      },
    },
  });
  dom = loaded.dom;
  const state = { id: 'win-1', cleanups: [] };
  return { ...loaded, manager, setupCalls, settingsWrites, adminPuts, closedWindows, state };
}

function wizardButtons(content) {
  return {
    next: content.querySelector('.nvsetup-bottom .nvsetup-btn.primary'),
    back: [...content.querySelectorAll('.nvsetup-bottom .nvsetup-btn')].find(b => b.textContent === 'Back'),
    skip: [...content.querySelectorAll('.nvsetup-bottom .nvsetup-btn')].find(b => b.textContent === 'Skip'),
  };
}

afterEach(() => { try { dom?.window.close(); } catch { /* already closed */ } });
beforeEach(() => resetTestStorage());

describe('NovaByte Setup (js/apps/setup — first-boot wizard .novaapp)', () => {
  it('registers a system app descriptor with the trusted-host entry shape', async () => {
    const { app } = await loadSetup();
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.nbosp.setup');
    expect(app.name).toBe('NovaByte Setup');
    expect(typeof app.init).toBe('function');
  });

  it('first boot: renders the 6-step wizard starting at Welcome with progress dots', async () => {
    const { app } = await loadSetup();
    const content = dom.window.document.createElement('div');
    await app.init(content, { id: 'w1', cleanups: [] });
    await settle();

    expect(content.querySelector('.nvsetup-title').textContent).toBe('NovaByte OS');
    expect(content.querySelectorAll('.nvsetup-dot')).toHaveLength(6);
    expect([...content.querySelectorAll('.nvsetup-dot.on')]).toHaveLength(1);
    // Language choices — an AOSP-style first step.
    expect(content.querySelectorAll('.nvsetup-lang button').length).toBeGreaterThanOrEqual(2);
    const { next } = wizardButtons(content);
    expect(next.textContent).toBe('Start');
    expect(next.disabled).toBe(false);
  });

  it('steps forward through network (skippable) and privacy toggles', async () => {
    const { app } = await loadSetup();
    const content = dom.window.document.createElement('div');
    await app.init(content, { id: 'w1', cleanups: [] });
    await settle();

    const { next, skip } = wizardButtons(content);
    next.click(); // Welcome -> Network
    await settle();
    expect(content.querySelector('.nvsetup-title').textContent).toBe('Connect to network');
    expect([...content.querySelectorAll('.nvsetup-dot.on')]).toHaveLength(2);
    expect(skip.style.visibility).toBe('visible');
    skip.click(); // Network -> Data & privacy (skipped)
    await settle();
    expect(content.querySelector('.nvsetup-title').textContent).toBe('Your data');
    // Two policy toggles: guest access + diagnostics, both interactive rows.
    const rows = [...content.querySelectorAll('.nvsetup-row')];
    expect(rows).toHaveLength(2);
    rows[1].click(); // diagnostics off -> on
    expect(rows[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('account step validates and gates Next until the owner account is complete', async () => {
    const { app } = await loadSetup();
    const content = dom.window.document.createElement('div');
    await app.init(content, { id: 'w1', cleanups: [] });
    await settle();

    const { next } = wizardButtons(content);
    next.click(); next.click(); next.click(); // Welcome -> Network -> Privacy -> Account
    await settle();
    expect(content.querySelector('.nvsetup-title').textContent).toBe('Create the owner account');
    expect(next.textContent).toBe('Create account');
    expect(next.disabled).toBe(true); // empty fields

    const inputs = [...content.querySelectorAll('.nvsetup-input')];
    const [display, username, pin, pin2] = inputs;
    inputs.forEach(i => { i.value = ''; });

    // Invalid username (too short) keeps the button locked.
    display.value = 'Ada Nova';
    username.value = 'ab';
    pin.value = '1234';
    pin2.value = '1234';
    username.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(next.disabled).toBe(true);

    username.value = 'ada';
    username.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    pin2.value = '4321'; // mismatched PINs still locked
    pin.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(next.disabled).toBe(true);

    pin2.value = '1234';
    pin2.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(next.disabled).toBe(false);
  });

  it('leaving the account step creates the owner through SessionManager.setupOwner', async () => {
    const { app, setupCalls } = await loadSetup();
    const content = dom.window.document.createElement('div');
    await app.init(content, { id: 'w1', cleanups: [] });
    await settle();

    const { next } = wizardButtons(content);
    next.click(); next.click(); next.click();
    await settle();

    const [display, username, pin, pin2, pass] = [...content.querySelectorAll('.nvsetup-input')];
    display.value = 'Ada Nova';
    username.value = 'ada';
    pin.value = '1234';
    pin2.value = '1234';
    pass.value = '';
    for (const input of [display, username, pin, pin2]) {
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }
    await settle();
    next.click(); // create the owner and advance to Appearance
    await settle(30);

    expect(setupCalls).toHaveLength(1);
    expect(setupCalls[0]).toMatchObject({ displayName: 'Ada Nova', username: 'ada', pin: '1234', avatar: 'A' });
    expect(content.querySelector('.nvsetup-title').textContent).toBe('Make it yours');
  });

  it('a failed setupOwner surfaces the message and does not advance', async () => {
    const { app, setupCalls } = await loadSetup({
      setupResult: { ok: false, code: 'USERNAME_TAKEN', message: 'That username is already in use' },
    });
    const content = dom.window.document.createElement('div');
    await app.init(content, { id: 'w1', cleanups: [] });
    await settle();

    const { next } = wizardButtons(content);
    next.click(); next.click(); next.click();
    await settle();
    const [display, username, pin, pin2] = [...content.querySelectorAll('.nvsetup-input')];
    display.value = 'Ada';
    username.value = 'ada';
    pin.value = '1234';
    pin2.value = '1234';
    for (const input of [display, username, pin, pin2]) {
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }
    await settle();
    next.click();
    await settle(30);

    expect(setupCalls).toHaveLength(1);
    expect(content.querySelector('.nvsetup-title').textContent).toBe('Create the owner account');
    expect(content.querySelector('.nvsetup-status').textContent).toBe('That username is already in use');
  });

  it('finish applies preferences through the (now owner-mounted) settings store and closes the window', async () => {
    const { app, settingsWrites, adminPuts, closedWindows } = await loadSetup();
    const content = dom.window.document.createElement('div');
    await app.init(content, { id: 'w9', cleanups: [] });
    await settle();

    const { next } = wizardButtons(content);
    next.click(); next.click(); next.click();
    await settle();
    const [display, username, pin, pin2] = [...content.querySelectorAll('.nvsetup-input')];
    display.value = 'Ada Nova';
    username.value = 'ada';
    pin.value = '1234';
    pin2.value = '1234';
    for (const input of [display, username, pin, pin2]) {
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }
    await settle();
    next.click(); // create owner -> Appearance
    await settle(30);
    next.click(); // Appearance -> All set
    await settle();
    expect(content.querySelector('.nvsetup-title').textContent).toBe('You\u2019re all set');
    next.click(); // finish
    await settle(30);

    const writes = Object.fromEntries(settingsWrites);
    expect(writes.theme).toBe('nova-dark');
    expect(writes.accentColor).toBe('#93c5fd');
    expect(writes.language).toBe('en');
    expect(writes.diagnostics).toBe(false);
    expect(adminPuts.some(p => p.path === '/api/auth/admin/policies' && p.method === 'PUT')).toBe(true);
    expect(closedWindows).toContain('w9');
  });

  it('launching after setup is complete shows the completed state, not the wizard', async () => {
    const { app, setupCalls } = await loadSetup({
      accounts: { users: [{ uid: 'u-owner', username: 'ada' }], policies: {} },
    });
    const content = dom.window.document.createElement('div');
    await app.init(content, { id: 'w2', cleanups: [] });
    await settle();

    expect(content.querySelector('.nvsetup-title').textContent).toBe('Setup is already complete');
    expect(content.querySelectorAll('.nvsetup-dot')).toHaveLength(0);
    expect(setupCalls).toEqual([]);
  });
});
