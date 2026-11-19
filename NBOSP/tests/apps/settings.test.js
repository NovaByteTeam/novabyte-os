// tests/apps/settings.test.js — window app: unavailable-API guard, sidebar
// navigation, appearance theme/clock flows, desktop wallpaper + taskbar
// controls, developer-mode warning dialog, About hardware fixture, and the
// degraded connectivity/default-apps/storage sections.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

// In-memory settings facade mirroring window.NovaByteSystem.settings.
function makeSystemStub(initial = {}) {
  const store = {
    theme: 'nova-dark',
    accentColor: '#58a6ff',
    clockFormat: '12h',
    ...initial,
  };
  const sets = [];
  return {
    store,
    sets,
    get: (key) => store[key],
    set: (key, value) => { sets.push([key, value]); store[key] = value; return value; },
  };
}

function makeNovaByteSystem(initial) {
  const settings = makeSystemStub(initial);
  return {
    settings,
    sets: settings.sets,
    store: settings.store,
    security: { setLockPin: (pin) => settings.sets.push(['lockPin', pin]) },
    developer: {
      setMode: (v) => settings.sets.push(['devMode', v]),
      setRootAccess: (v) => settings.sets.push(['rootAccess', v]),
    },
    hardware: {
      network: null, // connectivity section degrades by default
      getInventory: () => ({
        supported: true,
        graphics: [{ vendor: 'Mesa', driver: 'llvmpipe' }],
        display: { resolution: { width: 1024, height: 768 } },
        cpu: { logicalCores: 8 },
        virtualization: { vendor: 'KVM' },
        vmwareTools: { running: false, installed: false },
        memory: { totalBytes: 8 * 1024 ** 3 },
      }),
    },
  };
}

const WALLPAPERS = [
  { id: 'stock-blue', name: 'Nova Blue', gradient: 'linear-gradient(rgb(2, 12, 30), rgb(10, 20, 40))' },
  { id: 'stock-teal', name: 'Nova Teal', gradient: 'linear-gradient(rgb(10, 94, 112), rgb(4, 40, 50))' },
];

async function loadSettings({ system, os, wallpaperService, extra = {} } = {}) {
  const nbs = system ?? makeNovaByteSystem();
  const notify = { calls: [], show: (n) => notify.calls.push(n) };
  const loaded = await loadWindowApp('settings', {
    stubs: {
      extra: {
        NovaByteSystem: nbs,
        OS: os ?? { username: 'nova', lockPin: null, version: '3.0.2', dnd: false, apps: {} },
        Notify: notify,
        WallpaperService: wallpaperService ?? { getPresets: () => WALLPAPERS },
        // 2026-11-15: admin-gated surfaces (root, recovery boot, admin-mode
        // toggle, factory wipe) render for an admin session by default so
        // the legacy expectations keep exercising the full controls; the
        // non-admin lock panels are covered by their own test below.
        SessionManager: { isAdmin: () => true },
        ...extra,
      },
    },
  });
  const content = initApp(loaded.app, { window: loaded.window, state: {} });
  // The real window manager attaches the content element; several render
  // paths check content.isConnected before painting.
  loaded.document.body.appendChild(content);
  return { ...loaded, content, nbs, notify };
}

const sidebarBtn = (content, name) =>
  [...content.querySelectorAll('.nook-section-btn')]
    .find((b) => b.getAttribute('aria-label') === name);

describe("'Settings' app (js/apps/settings)", () => {
  beforeEach(() => resetTestStorage());

  it('registers a full app descriptor with the host', async () => {
    const { app } = await loadWindowApp('settings');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.nbosp.settings');
    expect(app.name).toBe('Settings');
    expect(app.version).toBe('3.0.2');
    expect(app.icon).toBe('assets/icon.svg');
    expect(app.defaultSize).toEqual([700, 500]);
    expect(app.minSize).toEqual([500, 400]);
    expect(typeof app.init).toBe('function');
  });

  it('sets the Home default in Settings without showing the launch-time switch prompt', async () => {
    const homeApps = [
      { id: 'com.test.saved-home', name: 'Saved launcher' },
      { id: 'com.test.new-home', name: 'New launcher' },
    ];
    const DefaultApps = {
      CATEGORIES: { home: { name: 'Home app' } },
      getAppsForCategory: vi.fn((category) => category === 'home' ? homeApps : []),
      getDefault: vi.fn((category) => category === 'home' ? homeApps[0].id : null),
      setDefault: vi.fn(() => true),
    };
    const showModal = vi.fn();
    const { content } = await loadSettings({ extra: { DefaultApps, showModal } });
    sidebarBtn(content, 'Default Apps').click();
    const homeLabel = [...content.querySelectorAll('*')]
      .find((element) => element.textContent.trim() === 'Home app');
    expect(homeLabel).toBeTruthy();
    homeLabel.parentElement.parentElement.parentElement.querySelector('button').click();
    content.ownerDocument.querySelectorAll('[role="radio"]')[1].click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(showModal).not.toHaveBeenCalled();
    expect(DefaultApps.setDefault).toHaveBeenCalledWith('home', 'com.test.new-home');
  });

  it('shows the unavailable-system guard when NovaByteSystem is missing', async () => {
    const { app, window } = await loadWindowApp('settings');
    const content = initApp(app, { window, state: {} });
    expect(content.textContent)
      .toBe('System settings are unavailable. Restart NovaByte OS and try again.');
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const { app, window, document } = await loadWindowApp('settings', {
      stubs: {
        AppDirs: null,
        extra: { NovaByteSystem: makeNovaByteSystem(), OS: { username: 'nova' } },
      },
    });
    const content = initApp(app, { window, state: {} });
    document.body.appendChild(content);
    expect(content.textContent).toContain('App data directory missing.');
    expect(content.querySelector('b').textContent).toBe('com.nbosp.settings');
  });

  it('renders all 13 sidebar sections and navigates between them', async () => {
    const icon = 'data:image/svg+xml;base64,PHN2Zy8+';
    const os = {
      username: 'nova',
      lockPin: null,
      version: '3.0.2',
      dnd: false,
      apps: { 'com.nbosp.settings': { icon } },
    };
    const { content } = await loadSettings({ os });
    const buttons = [...content.querySelectorAll('.nook-section-btn')];
    expect(content.querySelector('.nook-sidebar-brand')).toBeTruthy();
    expect(content.querySelector('.nook-sidebar-brand img')?.getAttribute('src')).toBe(icon);
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Appearance', 'Accessibility', 'Desktop', 'System', 'Date and Region',
      'Connectivity', 'VPN', 'Storage', 'Notifications', 'Privacy', 'Root Access',
      'Default Apps', 'About',
    ]);
    // Appearance is the default section and is marked active.
    expect(content.querySelector('.nook-section-btn.active').getAttribute('aria-label')).toBe('Appearance');

    sidebarBtn(content, 'System').click();
    expect(content.querySelector('.nook-content').dataset.currentTab).toBe('system');
    expect(content.querySelector('.nook-page-header')).toBeTruthy();
    expect(content.querySelector('.nook-content h2').textContent).toBe('System');
    expect(content.querySelector('#system-username-input').value).toBe('nova');
    expect([...content.querySelectorAll('button')].some((b) => b.textContent === 'Boot to Recovery')).toBe(true);

    sidebarBtn(content, 'Accessibility').click();
    expect(content.querySelector('.nook-content').dataset.currentTab).toBe('accessibility');
    expect(content.querySelector('.nook-content h2').textContent).toBe('Accessibility');
    expect(content.querySelector('.nook-section-btn.active').getAttribute('aria-label')).toBe('Accessibility');
  });

  it('connects and disconnects the selected app through Device VPN settings', async () => {
    let active = false;
    const vpn = {
      getStatus: vi.fn(async () => active
        ? { active: true, providerId: 'com.test.vpn' }
        : { active: false, providerId: null }),
      getProviders: vi.fn(async () => [
        { id: 'com.test.vpn', name: 'Test VPN', granted: true },
      ]),
      activate: vi.fn(async (providerId) => {
        expect(providerId).toBe('com.test.vpn');
        active = true;
      }),
      deactivate: vi.fn(async () => { active = false; }),
    };
    const { content } = await loadSettings({ extra: { NovaVPNService: vpn } });
    sidebarBtn(content, 'VPN').click();
    await settle();

    expect(content.querySelector('.nook-content').textContent).toContain('VPN is disconnected.');
    const providerSelect = content.querySelector('select[aria-label="VPN provider app"]');
    expect(providerSelect.options).toHaveLength(1);
    const deviceButton = [...content.querySelectorAll('.nook-group button')]
      .find((button) => button.textContent === 'Connect' && !button.disabled);
    deviceButton.click();
    await settle();
    expect(vpn.activate).toHaveBeenCalledWith('com.test.vpn');
    expect(content.querySelector('.nook-content').textContent).toContain('Active · Test VPN');

    const disconnect = [...content.querySelectorAll('.nook-group button')]
      .find((button) => button.textContent === 'Disconnect');
    disconnect.click();
    await settle();
    expect(vpn.deactivate).toHaveBeenCalled();
    expect(content.querySelector('.nook-content').textContent).toContain('VPN is disconnected.');
  });

  it('starts the recovery handoff directly after confirmation', async () => {
    const recovery = { request: vi.fn(() => true) };
    const showModal = vi.fn().mockResolvedValue('confirm');
    const { content } = await loadSettings({ extra: { NovaRecovery: recovery, showModal } });
    sidebarBtn(content, 'System').click();

    const button = [...content.querySelectorAll('button')]
      .find((candidate) => candidate.textContent === 'Boot to Recovery');
    button.click();
    await settle();

    expect(recovery.request).toHaveBeenCalledWith('manual');
    expect(localStorage.getItem('nova_manual_recovery')).toBeNull();
  });

  it('switches the theme and toggles the clock format in Appearance', async () => {
    const { content, nbs } = await loadSettings();
    // Content was detached during init, so the first paint happens on the
    // first sidebar click (the real WM attaches before init).
    sidebarBtn(content, 'Appearance').click();
    const appearance = content.querySelector('.nook-content');

    // 7 theme rows from THEMES/THEME_NAMES.
    const themeGroup = [...appearance.querySelectorAll('.nook-group')]
      .find((g) => g.textContent.includes('Theme'));
    const themeButtons = [...themeGroup.querySelectorAll('button')];
    expect(themeButtons.map((b) => b.textContent)).toEqual([
      'Active', 'Select', 'Select', 'Select', 'Select', 'Select', 'Select',
    ]);

    // Click "Select" on Nord → persisted and re-rendered as Active.
    themeButtons[2].click();
    expect(nbs.sets).toContainEqual(['theme', 'nord']);
    const themeGroup2 = [...content.querySelectorAll('.nook-group')]
      .find((g) => g.textContent.includes('Theme'));
    expect([...themeGroup2.querySelectorAll('button')][2].textContent).toBe('Active');

    // Clock format toggle flips 12h → 24h.
    const clockToggle = appearance.querySelector('button[aria-label="Toggle 24-hour time"]');
    expect(clockToggle.getAttribute('aria-checked')).toBe('false');
    clockToggle.click();
    expect(nbs.sets).toContainEqual(['clockFormat', '24h']);
    expect(clockToggle.getAttribute('aria-checked')).toBe('true');
  });

  it('keeps accent swatches from shrinking in narrow Settings windows', async () => {
    const { content } = await loadSettings();
    sidebarBtn(content, 'Appearance').click();
    const swatches = content.querySelector('.nook-accent-swatches');
    expect(swatches).toBeTruthy();
    expect(swatches.querySelectorAll('.nook-accent-swatch')).toHaveLength(8);
  });

  it('renders region names using the UI locale instead of script-dependent autonyms', async () => {
    const { content } = await loadSettings();
    sidebarBtn(content, 'Date and Region').click();
    const regionSelect = content.querySelector('#region-select');
    const myanmar = regionSelect.querySelector('option[value="my-MM"]');
    const regionName = new Intl.DisplayNames([navigator.language || 'en'], { type: 'region' }).of('MM');
    expect(myanmar.textContent).toBe(regionName);
    expect(myanmar.textContent).not.toMatch(/[□�]/);
  });

  it('applies a preset wallpaper and manages taskbar settings in Desktop', async () => {
    const { content, nbs, notify } = await loadSettings();
    sidebarBtn(content, 'Desktop').click();
    const desktop = content.querySelector('.nook-content');

    // Two preset cards from the WallpaperService stub; stock-blue active by default.
    const cards = [...desktop.querySelectorAll('[role="button"][aria-label^="Wallpaper:"]')];
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Wallpaper: Nova Blue (active)', 'Wallpaper: Nova Teal',
      'Wallpaper: Nova Blue (Lock screen)', 'Wallpaper: Nova Teal (Lock screen)',
    ]);
    const lockTealCard = cards.find((card) => card.getAttribute('aria-label') === 'Wallpaper: Nova Teal (Lock screen)');
    lockTealCard.click();
    expect(lockTealCard.getAttribute('aria-pressed')).toBe('true');

    cards[1].click();
    expect(nbs.sets).toContainEqual(['wallpaperId', 'stock-teal']);
    expect(nbs.sets).toContainEqual(['customWallpaper', null]);
    expect(notify.calls.some((n) => n.title === 'Wallpaper Changed' && n.body === 'Applied Nova Teal')).toBe(true);
    expect(cards[1].getAttribute('aria-pressed')).toBe('true');

    // Taskbar size buttons.
    const largeBtn = [...desktop.querySelectorAll('button')].find((b) => b.textContent === 'Large');
    largeBtn.click();
    expect(nbs.sets).toContainEqual(['taskbarSize', 'large']);

    // Show-clock toggle hides a live #tray-clock element when present.
    const trayClock = attachTrayClock(content);
    const clockToggle = [...desktop.querySelectorAll('button[role="switch"]')]
      .find((b) => b.getAttribute('aria-label') === 'Toggle clock in taskbar');
    expect(clockToggle.getAttribute('aria-checked')).toBe('true');
    clockToggle.click();
    expect(nbs.sets).toContainEqual(['showTaskbarClock', false]);
    expect(trayClock.style.display).toBe('none');
  });

  it('uploads and resets a lock-screen image independently from the desktop wallpaper', async () => {
    const file = {
      name: 'account-lock.png',
      mimeType: 'image/png',
      content: Uint8Array.from([1, 2, 3]),
    };
    const { content, nbs } = await loadSettings({
      extra: { SystemDialogs: { open: vi.fn(async () => file) } },
    });

    sidebarBtn(content, 'Desktop').click();

    const lockUpload = content.querySelector('.nook-lock-wallpaper-custom button');
    expect(lockUpload).toBeTruthy();
    lockUpload.click();
    await settle();

    expect(nbs.sets).toContainEqual(['lockCustomWallpaper', 'data:image/png;base64,AQID']);
    expect(nbs.sets).toContainEqual(['lockCustomWallpaperName', 'account-lock.png']);
    expect(nbs.sets).toContainEqual(['lockWallpaperId', null]);
    expect(nbs.sets.some(([key]) => key === 'customWallpaper')).toBe(false);
    expect(content.querySelector('.nook-lock-wallpaper-custom .nook-row-desc').textContent)
      .toBe('account-lock.png');

    const resetLock = content.querySelector('.nook-lock-wallpaper-actions button:nth-child(2)');
    expect(resetLock).toBeTruthy();
    resetLock.click();
    expect(nbs.sets).toContainEqual(['lockCustomWallpaper', null]);
    expect(nbs.sets).toContainEqual(['lockWallpaperId', 'stock-blue']);
  });

  it('saves desktop icon size through the desktopIconSize setting', async () => {
    const { content, nbs } = await loadSettings();
    expect(sidebarBtn(content, 'VPN').querySelector('img').getAttribute('src'))
      .toBe('/assets/vpn-icon.svg');
    sidebarBtn(content, 'Accessibility').click();

    const iconSizeGroup = [...content.querySelectorAll('.nook-group')]
      .find((group) => group.querySelector('.nook-group-title')?.textContent === 'Icon Size');
    expect(iconSizeGroup).toBeTruthy();
    const largeRow = [...iconSizeGroup.querySelectorAll('.nook-row')]
      .find((row) => row.textContent.includes('Large'));
    largeRow.querySelector('button').click();

    expect(nbs.sets).toContainEqual(['desktopIconSize', 108]);
    expect(nbs.sets.some(([key]) => key === 'cursorSize')).toBe(false);
  });

  it('guards enabling Developer Mode behind the security warning dialog', async () => {
    const { content, nbs, notify, document } = await loadSettings();
    sidebarBtn(content, 'System').click();

    const devToggle = [...content.querySelectorAll('button[role="switch"]')]
      .find((b) => b.getAttribute('aria-label') === 'Toggle developer mode');
    expect(devToggle.getAttribute('aria-checked')).toBe('false');

    devToggle.click();
    // Overlay is mounted on document.body, not inside the window content.
    const overlay = [...document.body.children].find((el) => el.textContent.includes('Developer Mode — Security Warning'));
    expect(overlay).toBeTruthy();

    // Cancel → nothing changes, overlay dismissed.
    [...overlay.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
    expect(nbs.sets).not.toContainEqual(['devMode', true]);
    expect([...document.body.children].some((el) => el.textContent.includes('Security Warning'))).toBe(false);

    // Confirm → dev mode enabled + notification (the dialog resolves a
    // promise, so the setMode continuation lands in a microtask).
    devToggle.click();
    const overlay2 = [...document.body.children].find((el) => el.textContent.includes('Developer Mode — Security Warning'));
    [...overlay2.querySelectorAll('button')].find((b) => b.textContent === 'Turn On Anyway').click();
    await settle(10);
    expect(nbs.sets).toContainEqual(['devMode', true]);
    expect(devToggle.getAttribute('aria-checked')).toBe('true');
    expect(notify.calls.some((n) => n.title === 'Developer Mode Enabled')).toBe(true);
  });

  it('renders the About section from the hardware inventory fixture', async () => {
    const { content, notify } = await loadSettings();
    sidebarBtn(content, 'About').click();
    const about = content.querySelector('.nook-content');

    expect(about.querySelector('.nook-about-body img')?.getAttribute('src')).toBe('/assets/icon.svg');
    expect(about.textContent).toContain('Software Information');
    expect(about.textContent).toContain('NovaByte Version');
    expect(about.textContent).toContain('v3.0.2');
    expect(about.textContent).toMatch(/Build Date\s*\d{4}-\d{2}-\d{2}/);
    // jsdom has no Node process → the non-Linux fallback values.
    expect(about.textContent).toContain('Not running on Linux');
    expect(about.textContent).toContain('Unavailable');
    expect(about.textContent).toContain('CPU Cores');
    expect(about.textContent).toContain('8'); // hardware.cpu.logicalCores
    expect(about.textContent).toContain('Mesa llvmpipe');
    expect(about.textContent).toContain('KVM');
    expect(about.textContent).toContain('Apache 2.0');
    const aboutBody = about.querySelector('.nook-about-body');
    expect(aboutBody).toBeTruthy();
    expect(aboutBody.querySelectorAll(':scope > div')).toHaveLength(4);
    expect(about.querySelector('.nook-page-header')).toBeTruthy();

    // jsdom exposes no navigator.clipboard → the guarded copy path surfaces
    // a "Copy Failed" notification instead of writing the clipboard.
    [...about.querySelectorAll('button')]
      .find((b) => b.textContent.includes('Copy System Info')).click();
    await settle(20);
    expect(notify.calls.some((n) => n.title === 'Copy Failed')).toBe(true);
  });

  it('keeps the disabled Root Access notice compact instead of filling the pane', async () => {
    const { content } = await loadSettings({
      system: makeNovaByteSystem({ devMode: false, rootAccessEnabled: false }),
    });
    sidebarBtn(content, 'Root Access').click();
    const notice = content.querySelector('.nook-content .empty-state');

    expect(notice).not.toBeNull();
    expect(notice.style.height).toBe('auto');
    expect(notice.style.padding).toBe('18px 0px');
    expect(notice.style.alignItems).toBe('flex-start');
    expect(notice.style.justifyContent).toBe('flex-start');
  });

  it('uses the active session transport for admin-mode reads and updates', async () => {
    const calls = [];
    const { content } = await loadSettings({
      extra: {
        SessionManager: {
          isAdmin: () => true, // 2026-11-15: the admin-mode toggle is admin-gated
          authFetch: async (path, options = {}) => {
            calls.push({ path, ...options });
            return {
              ok: true,
              json: { success: true, adminEnabled: options.method === 'POST' ? options.body.enabled : false },
            };
          },
        },
      },
    });

    sidebarBtn(content, 'Privacy').click();
    await settle();
    const toggle = content.querySelector('[aria-label="Toggle admin mode"]');
    expect(toggle.disabled).toBe(false);
    expect(calls).toEqual([{ path: '/api/security/admin-mode', method: 'GET', body: undefined }]);

    toggle.click();
    await settle();
    expect(calls[1]).toEqual({
      path: '/api/security/admin-mode',
      method: 'POST',
      body: { enabled: true },
    });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('locks admin-only sections behind an administrator account (2026-11-15)', async () => {
    let switchUserCalled = 0;
    const { content, window } = await loadSettings({
      extra: {
        SessionManager: { isAdmin: () => false }, // standard account
        LockScreenService: {
          switchUser: async () => { switchUserCalled += 1; },
          showLoginPicker: () => { throw new Error('must not be called directly'); },
        },
      },
    });

    // Root section: lock panel instead of the controls.
    sidebarBtn(content, 'Root Access').click();
    expect(content.textContent).toContain('Administrator required');
    expect(content.textContent).toContain('Sign in with an administrator account');

    // The lock panel's Switch user button must run the canonical
    // switch verb (suspend-then-picker); the old direct
    // showLoginPicker() call silently did nothing (M10 guard).
    const switchBtn = [...content.querySelectorAll('button')]
      .find((b) => b.textContent === 'Switch user');
    expect(switchBtn).toBeTruthy();
    await switchBtn.click();
    await settle();
    expect(switchUserCalled).toBe(1);

    // System section: the recovery-boot toggle is replaced by the lock panel,
    // and the Developer Mode toggle (2026-11-16) is admin-only as well.
    sidebarBtn(content, 'System').click();
    expect([...content.querySelectorAll('button')].some((b) => b.textContent === 'Boot to Recovery')).toBe(false);
    expect(content.querySelector('[aria-label="Toggle developer mode"]')).toBeNull();
    expect(content.textContent).toContain('Administrator required');

    // Privacy section: the admin-mode toggle is hidden; the rest renders.
    sidebarBtn(content, 'Privacy').click();
    expect(content.querySelector('[aria-label="Toggle admin mode"]')).toBeNull();

    // Storage: the factory wipe is hidden for standard accounts.
    sidebarBtn(content, 'Storage').click();
    expect([...content.querySelectorAll('button')].some((b) => b.textContent === 'Wipe All Data')).toBe(false);
  });

  it('degrades connectivity, default-apps and storage sections without host services', async () => {
    const { content } = await loadSettings();

    sidebarBtn(content, 'Connectivity').click();
    expect(content.querySelector('.nook-content').textContent)
      .toContain('Connectivity service is not available in this build.');

    sidebarBtn(content, 'Default Apps').click();
    expect(content.querySelector('.nook-content').textContent)
      .toContain('Default apps system not available.');

    sidebarBtn(content, 'Storage').click();
    // navigator.storage does not exist in jsdom → estimate() fails into the catch.
    await settle(20);
    expect(content.querySelector('.nook-content').textContent)
      .toContain('Unable to retrieve storage information.');
  });
});

// Attach a tray clock node so the Desktop toggle's live-DOM branch is real.
function attachTrayClock(content) {
  const ownerDoc = content.ownerDocument;
  const tray = ownerDoc.createElement('div');
  tray.id = 'tray-clock';
  ownerDoc.body.appendChild(tray);
  return tray;
}
