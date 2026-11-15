// The Users admin console renders a Role chip per account. createEl has no
// `html` option, so the chip used to come out empty; this pins the rendered
// text, and that markup in a server-supplied field stays inert text.
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const read = rel => readFile(new URL(rel, import.meta.url), 'utf8');

async function mountUsersApp(users, { events = [], save = vi.fn(async () => null), writeFile = vi.fn(), authFetch = null, sessionState = null } = {}) {
  const [baseUtils, appSource, i18nSource, enCatalogue] = await Promise.all([
    read('../../js/core/utils/base-utils.js'),
    read('../../js/apps/users/app.js'),
    read('../../js/core/core/i18n.js'),
    read('../../js/apps/localisation/locales/en.json'),
  ]);
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only' });
  const { window } = dom;

  // Bring the NovaI18n engine online exactly like the app harness does, so
  // the app's _t() calls resolve the genuine shipped English catalogue.
  window.eval(i18nSource);
  window.NovaI18n.registerResources({ en: JSON.parse(enCatalogue) });

  let config;
  window.registerApp = cfg => { config = cfg; };
  window.NovaUserScope = { enabled: () => true };
  window.SystemDialogs = { save };
  window.require = name => {
    if (name !== 'fs') throw new Error(`Unexpected module: ${name}`);
    return { promises: { writeFile } };
  };
  const calls = [];
  const defaultAuthFetch = async path => ({
    status: 200,
    json: {
      success: true,
      data: path.endsWith('/usage') ? { usage: [] }
        : path.includes('/events') ? { events }
          : { users },
    },
  });
  window.SessionManager = {
    isAdmin: () => true,
    ...(sessionState ? { state: () => sessionState } : {}),
    authFetch: async (path, options = {}) => {
      // The app hands authFetch the plain object; the real SessionManager
      // is what JSON.stringifies it — record whichever shape arrives.
      calls.push({ path, method: options.method || 'GET', body: typeof options.body === 'string' ? JSON.parse(options.body) : (options.body ?? null) });
      return (authFetch || defaultAuthFetch)(path, options);
    },
  };

  window.eval(baseUtils);
  window.eval(appSource);
  const host = window.document.getElementById('host');
  await config.init(host, { cleanups: [] }, {});
  // The first paint routes through selectTab('users') so the section is
  // highlighted on launch; one extra tick keeps any trailing microtask (the
  // usage fetch inside the same loadUsers) settled before assertions.
  await new Promise(resolve => window.setTimeout(resolve, 0));
  return { window, host, calls, save, writeFile };
}

describe('Users app account table', () => {
  it('shows each account\'s role and status as text', async () => {
    const { window, host } = await mountUsersApp([
      { uid: 'u1', username: 'ada', displayName: 'Ada', role: 'owner', roleLabel: 'Owner', status: 'active' },
      { uid: 'u2', username: 'sam', displayName: 'Sam', role: 'standard', roleLabel: 'Standard', status: 'disabled', locked: true },
    ]);
    try {
      expect(host.style.background).toBe('var(--bg-base)');
      expect(host.style.color).toBe('var(--text-primary)');
      expect(host.querySelector('style').textContent).toContain('.nbusers-event.warn { border-left-color:var(--text-warning); }');
      const rows = [...host.querySelectorAll('.nbusers-table tbody tr')];
      expect(rows).toHaveLength(2);

      const addButton = host.querySelector('.nbusers-add-btn');
      expect(addButton.getAttribute('aria-label')).toBe('Add account');
      expect(addButton.querySelector('svg path').getAttribute('d')).toBe('M12 5v14M5 12h14');

      const chips = row => [...row.querySelectorAll('.nbusers-chip')].map(chip => chip.textContent);
      expect(chips(rows[0])).toEqual(['Owner', 'active']);
      expect(chips(rows[1])).toEqual(['Standard', 'disabled', 'locked']);
      expect(rows[0].querySelector('.nbusers-chip.owner')).not.toBeNull();
      expect(rows.map(row => row.cells[0].style.display)).toEqual(['', '']);
      expect(rows.every(row => row.querySelector('.nbusers-account-info'))).toBe(true);
      expect(host.querySelector('style').textContent).toContain('.nbusers-account-info { display:flex;align-items:center;gap:10px; }');
    } finally {
      window.close();
    }
  });

  it('renders markup in a display field as plain text', async () => {
    const { window, host } = await mountUsersApp([
      { uid: 'u1', username: 'ada', displayName: 'Ada', role: 'admin', roleLabel: '<img src=x onerror=alert(1)>', status: 'active' },
    ]);
    try {
      expect(host.querySelector('.nbusers-table img')).toBeNull();
      expect(host.querySelector('.nbusers-chip.admin').textContent).toBe('<img src=x onerror=alert(1)>');
    } finally {
      window.close();
    }
  });

  it('exports audit CSV through SystemDialogs and writes to the selected path', async () => {
    const save = vi.fn(async () => ({ path: '/home/sam/novabyte-account-events.csv' }));
    const writeFile = vi.fn(async () => {});
    const { window, host } = await mountUsersApp([], {
      events: [{
        ts: '2025-01-02T03:04:05.000Z',
        actor: 'sam',
        action: 'login',
        target: 'account',
        severity: 'info',
        ip: '127.0.0.1',
      }],
      save,
      writeFile,
    });
    try {
      host.querySelector('.nbusers-tab:nth-child(3)').click();
      await new Promise(resolve => window.setTimeout(resolve, 0));
      host.querySelector('.nbusers-btn').click();
      await new Promise(resolve => window.setTimeout(resolve, 0));

      expect(save).toHaveBeenCalledWith({
        title: 'Export account events',
        suggestedName: 'novabyte-account-events.csv',
      });
      expect(writeFile).toHaveBeenCalledWith(
        '/home/sam/novabyte-account-events.csv',
        'ts,actor,action,target,severity,ip\n2025-01-02T03:04:05.000Z,sam,login,account,info,127.0.0.1',
        'utf8',
      );
      expect(host.querySelector('a[download]')).toBeNull();
    } finally {
      window.close();
    }
  });
});

describe('Users app first paint', () => {
  it('launches with the Users tab highlighted (first paint routes through selectTab)', async () => {
    const { window, host } = await mountUsersApp([
      { uid: 'u1', username: 'ada', displayName: 'Ada', role: 'owner', roleLabel: 'Owner', status: 'active' },
    ]);
    try {
      const tabs = [...host.querySelectorAll('.nbusers-tab')];
      expect(tabs.map(tab => tab.classList.contains('active'))).toEqual([true, false, false]);
      expect(tabs[0].textContent).toBe('Users');
    } finally {
      window.close();
    }
  });
});

describe('Users app list refresh resilience', () => {
  const USERS = [
    { uid: 'u1', username: 'ada', displayName: 'Ada', role: 'owner', roleLabel: 'Owner', status: 'active' },
    { uid: 'u2', username: 'sam', displayName: 'Sam', role: 'standard', roleLabel: 'Standard', status: 'active' },
  ];
  const okFetch = users => async path => ({
    status: 200,
    json: { success: true, data: path.endsWith('/usage') ? { usage: [] } : { users } },
  });

  it('a failed refresh (transport down) keeps the last known list and a Retry banner — never an empty table', async () => {
    let failList = false;
    const base = okFetch(USERS);
    const { window, host } = await mountUsersApp(USERS, {
      authFetch: async (path, options) => {
        if (path === '/api/auth/admin/users' && (options.method || 'GET') === 'GET' && failList) {
          return { status: 0, ok: false, json: null }; // network-level failure → UNAVAILABLE
        }
        return base(path, options);
      },
    });
    try {
      expect(host.querySelectorAll('.nbusers-table tbody tr')).toHaveLength(2);

      failList = true;
      host.querySelector('.nbusers-tab').click(); // Users tab → re-render → failed refresh
      await new Promise(resolve => window.setTimeout(resolve, 0));

      // The list is NOT collapsed to empty — the last known rows stay.
      expect(host.querySelectorAll('.nbusers-table tbody tr')).toHaveLength(2);
      const banner = host.querySelector('.nbusers-banner');
      expect(banner).toBeTruthy();
      // New i18n keys echo as their key until the locale ships them.
      expect(banner.textContent).toContain("Couldn't refresh accounts");
      expect(banner.textContent).toContain('Account management request failed (0)');

      // The Retry action re-attempts the fetch and clears the banner.
      failList = false;
      banner.querySelector('button').click();
      await new Promise(resolve => window.setTimeout(resolve, 0));
      expect(host.querySelector('.nbusers-banner')).toBeNull();
      expect(host.querySelectorAll('.nbusers-table tbody tr')).toHaveLength(2);
    } finally {
      window.close();
    }
  });

  it('a 401 session expiry keeps the list and offers sign-in through the lock-screen picker', async () => {
    let expired = false;
    let switchUserCalled = 0;
    let directPickerShown = 0;
    const base = okFetch(USERS);
    const { window, host } = await mountUsersApp(USERS, {
      authFetch: async (path, options) => {
        if (path === '/api/auth/admin/users' && (options.method || 'GET') === 'GET' && expired) {
          return { status: 401, json: { success: false, code: 'AUTH_REQUIRED', message: 'Sign in first' } };
        }
        return base(path, options);
      },
    });
    try {
      // The banner button must go through the canonical switch verb:
      // showLoginPicker() alone bails while the (locally still active)
      // session stands — that is the dead-button bug.
      window.LockScreenService = {
        switchUser: async () => { switchUserCalled += 1; },
        showLoginPicker: () => { directPickerShown += 1; },
      };
      expired = true;
      host.querySelector('.nbusers-tab').click();
      await new Promise(resolve => window.setTimeout(resolve, 0));

      expect(host.querySelectorAll('.nbusers-table tbody tr')).toHaveLength(2);
      const banner = host.querySelector('.nbusers-banner');
      expect(banner).toBeTruthy();
      expect(banner.textContent).toContain('Your session expired');
      const action = banner.querySelector('button');
      expect(action.textContent).toBe('Sign in'); // shell.lock.signIn from the shipped catalogue
      await action.click();
      await new Promise(resolve => window.setTimeout(resolve, 0));
      expect(switchUserCalled).toBe(1);
      expect(directPickerShown).toBe(0); // the M10 guard would have eaten it
    } finally {
      window.close();
    }
  });
});

describe('Users app account creation', () => {
  it('requires the Confirm PIN field to match before any create request is sent', async () => {
    const { window, host, calls } = await mountUsersApp([]);
    try {
      host.querySelector('.nbusers-add-btn').click();
      host.querySelector('#nu-display').value = 'Sam Two';
      host.querySelector('#nu-username').value = 'sam2';
      host.querySelector('#nu-pin').value = '4321';
      host.querySelector('#nu-pin2').value = '4322'; // mismatch
      host.querySelector('.nbusers-btn.primary').click();
      await new Promise(resolve => window.setTimeout(resolve, 0));

      const status = host.querySelector('.nbusers-status');
      expect(status.textContent).toContain('The PINs do not match.');
      expect(calls.filter(c => c.method === 'POST' && c.path === '/api/auth/admin/users')).toEqual([]);

      // Matching PINs go through to the server.
      host.querySelector('#nu-pin2').value = '4321';
      host.querySelector('.nbusers-btn.primary').click();
      await new Promise(resolve => window.setTimeout(resolve, 0));
      const created = calls.filter(c => c.method === 'POST' && c.path === '/api/auth/admin/users');
      expect(created).toHaveLength(1);
      expect(created[0].body).toMatchObject({ username: 'sam2', pin: '4321', role: 'standard' });
    } finally {
      window.close();
    }
  });
});

describe('Users app reset-PIN flow', () => {
  const USERS = [
    { uid: 'u1', username: 'ada', displayName: 'Ada', role: 'owner', roleLabel: 'Owner', status: 'active' },
    { uid: 'u2', username: 'sam', displayName: 'Sam', role: 'standard', roleLabel: 'Standard', status: 'active' },
  ];
  const resetFetch = () => async path => {
    if (path.endsWith('/reset-credential')) {
      return { status: 200, json: { success: true, data: { uid: 'u2', username: 'sam', temporaryPin: '654321', expiresAt: Date.now() + 900000 } } };
    }
    return { status: 200, json: { success: true, data: path.endsWith('/usage') ? { usage: [] } : { users: USERS } } };
  };

  async function clickResetFor(window, host, username) {
    const row = [...host.querySelectorAll('.nbusers-table tbody tr')].find(r => r.textContent.includes(username));
    const resetBtn = [...row.querySelectorAll('button')].find(b => b.textContent === 'Reset PIN');
    resetBtn.click();
    await new Promise(resolve => window.setTimeout(resolve, 0));
  }

  it('keeps the temporary-PIN card on screen — refresh is deferred to the Done click', async () => {
    const { window, host, calls } = await mountUsersApp(USERS, {
      authFetch: resetFetch(),
      sessionState: { uid: 'u1' },
    });
    try {
      await clickResetFor(window, host, 'sam'); // NOT the current account → no confirmation view
      expect(calls.filter(c => c.path.endsWith('/reset-credential'))).toHaveLength(1);
      expect(host.textContent).toContain('654321'); // the temporary PIN is shown exactly once

      // No immediate refresh wiped the card: the list fetch count is unchanged.
      expect(calls.filter(c => c.path === '/api/auth/admin/users' && c.method === 'GET')).toHaveLength(1);

      // Done is the only thing that refreshes the list.
      [...host.querySelectorAll('button')].find(b => b.textContent === 'Done').click();
      await new Promise(resolve => window.setTimeout(resolve, 0));
      expect(calls.filter(c => c.path === '/api/auth/admin/users' && c.method === 'GET')).toHaveLength(2);
      expect(host.querySelectorAll('.nbusers-table tbody tr')).toHaveLength(2);
      expect(host.textContent).not.toContain('654321'); // the one-time PIN is gone once dismissed
    } finally {
      window.close();
    }
  });

  it('resetting your own PIN asks for confirmation first (the server revokes your sessions)', async () => {
    const { window, host, calls } = await mountUsersApp(USERS, {
      authFetch: resetFetch(),
      sessionState: { uid: 'u1' },
    });
    try {
      await clickResetFor(window, host, 'ada'); // Ada IS the current account
      // The API was not called — the confirmation view is up instead.
      expect(calls.filter(c => c.path.endsWith('/reset-credential'))).toHaveLength(0);
      expect(host.textContent).toContain('Reset the PIN for Ada'); // en.json ships the key now

      // Cancel returns to the list without resetting anything.
      [...host.querySelectorAll('button')].find(b => b.textContent === 'Cancel').click();
      await new Promise(resolve => window.setTimeout(resolve, 0));
      expect(calls.filter(c => c.path.endsWith('/reset-credential'))).toHaveLength(0);
      expect(host.querySelectorAll('.nbusers-table tbody tr')).toHaveLength(2);

      // Confirm performs the reset and shows the temporary PIN.
      await clickResetFor(window, host, 'ada');
      [...host.querySelectorAll('button')].find(b => b.textContent === 'Reset and sign out').click();
      await new Promise(resolve => window.setTimeout(resolve, 0));
      expect(calls.filter(c => c.path.endsWith('/reset-credential'))).toHaveLength(1);
      expect(host.textContent).toContain('654321');
      expect(host.textContent).toContain('Your PIN was reset');
    } finally {
      window.close();
    }
  });
});
