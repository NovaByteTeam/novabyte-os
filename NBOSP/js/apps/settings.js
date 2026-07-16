registerApp({
  id: 'nook', name: 'Settings', icon: 'settings',
  version: '3.0.2',
  description: 'System Settings',
  defaultSize: [700, 500], minSize: [500, 400],
  init(content, state, options) {

    // ── NovaByte runtime guard ────────────────────────────────────────────
    if (!window.AppDirs?.getVFSDir('com.nbosp.settings', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.settings</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
      return;
    }

    // ── Constants — declared once at init scope, NOT inside render fns ───
    const SECTIONS = [
      { id: 'appearance',    name: 'Appearance',    icon: 'image'     },
      { id: 'accessibility', name: 'Accessibility', icon: 'eye'       },
      { id: 'desktop',       name: 'Desktop',       icon: 'layers'    },
      { id: 'system',        name: 'System',        icon: 'processor' },
      { id: 'date-and-region', name: 'Date and Region', icon: 'calendar' },
      { id: 'storage',       name: 'Storage',       icon: 'database'  },
      { id: 'privacy',       name: 'Privacy',       icon: 'lock'      },
      { id: 'apps',          name: 'Apps',          icon: 'package'   },
      { id: 'about',         name: 'About',         icon: 'info'      }
    ];

    const THEMES      = ['nova-dark', 'nova-light', 'nord', 'dracula', 'catppuccin', 'tokyo-night', 'gruvbox'];
    const THEME_NAMES = ['Nova Dark', 'Nova Light', 'Nord', 'Dracula', 'Catppuccin', 'Tokyo Night', 'Gruvbox'];

    const ACCENT_COLORS = ['#58a6ff', '#3fb950', '#f85149', '#d29922', '#bc8cff', '#ff7b72', '#79c0ff', '#56d4dd'];

    const PRESET_WALLPAPERS = [
      { id: 'stock-blue',   name: 'Nova Blue',   gradient: 'radial-gradient(ellipse at 28% 38%, #1a5fbf 0%, #0a3070 35%, transparent 65%), linear-gradient(160deg, #020c1e 0%, #041428 45%, #061830 75%, #020c1e 100%)' },
      { id: 'stock-dark',   name: 'Obsidian',    gradient: 'radial-gradient(ellipse at 70% 25%, #160a28 0%, transparent 55%), radial-gradient(ellipse at 25% 75%, #0c0818 0%, transparent 50%), linear-gradient(150deg, #080810 0%, #0e0818 50%, #08080e 100%)' },
      { id: 'stock-light',  name: 'Frost',       gradient: 'radial-gradient(ellipse at 40% 30%, #ffffff 0%, #e8f0ff 45%, transparent 70%), linear-gradient(160deg, #dde8f8 0%, #eaf0ff 45%, #d8e6f5 100%)' },
      { id: 'stock-green',  name: 'Evergreen',   gradient: 'radial-gradient(ellipse at 30% 40%, #0a5c2a 0%, #043818 38%, transparent 65%), linear-gradient(155deg, #020c06 0%, #040e08 45%, #060e06 75%, #020c06 100%)' },
      { id: 'stock-purple', name: 'Deep Violet', gradient: 'radial-gradient(ellipse at 62% 32%, #4a1272 0%, #2c0858 40%, transparent 65%), radial-gradient(ellipse at 22% 70%, #1e084a 0%, transparent 50%), linear-gradient(155deg, #0a0414 0%, #140628 50%, #0a0414 100%)' },
      { id: 'stock-red',    name: 'Ember Core',  gradient: 'radial-gradient(ellipse at 35% 42%, #8c1a10 0%, #5c0808 40%, transparent 65%), radial-gradient(ellipse at 75% 70%, #3a0c0c 0%, transparent 50%), linear-gradient(155deg, #0e0404 0%, #180808 45%, #0e0404 100%)' },
      { id: 'stock-gray',   name: 'Steel',       gradient: 'radial-gradient(ellipse at 50% 32%, #2c3c4e 0%, #1a2838 40%, transparent 65%), linear-gradient(155deg, #0c1018 0%, #16202c 45%, #0c1218 75%, #0c1018 100%)' },
      { id: 'stock-teal',   name: 'Abyss',       gradient: 'radial-gradient(ellipse at 38% 36%, #0a5e70 0%, #044050 40%, transparent 65%), radial-gradient(ellipse at 72% 68%, #042835 0%, transparent 50%), linear-gradient(155deg, #020c10 0%, #041520 45%, #021018 100%)' }
    ];

    const TASKBAR_SIZES = [
      { value: 'compact', label: 'Compact', height: '36px' },
      { value: 'normal',  label: 'Normal',  height: '48px' },
      { value: 'large',   label: 'Large',   height: '64px' }
    ];

    const ICON_SIZES = [
      { value: 'normal', label: 'Normal',  transform: 'scale(1)'   },
      { value: 'large',  label: 'Large',   transform: 'scale(1.5)' },
      { value: 'xlarge', label: 'X-Large', transform: 'scale(2)'   }
    ];

    const SHORTCUTS_LIST = [
      { action: 'Open File Manager', key: 'Win+E'        },
      { action: 'Open Terminal',     key: 'Win+T'        },
      { action: 'Open Launchpad',    key: 'Win+Space'    },
      { action: 'Lock Screen',       key: 'Win+L'        },
      { action: 'Show Desktop',      key: 'Win+D'        },
      { action: 'Switch Apps',       key: 'Alt+Tab'      },
      { action: 'Close Window',      key: 'Alt+F4'       },
      { action: 'Fullscreen',        key: 'F11'          },
      { action: 'Screenshot',        key: 'Print Screen' },
      { action: 'New Tab (Browser)', key: 'Ctrl+T'       },
      { action: 'Close Tab',         key: 'Ctrl+W'       },
      { action: 'Find in Page',      key: 'Ctrl+F'       },
      { action: 'Quick Commands',    key: 'Ctrl+K'       }
    ];

    const PERM_LABELS = {
      'fs:read': 'Read files', 'fs:write': 'Write files', 'fs:delete': 'Delete files', 'fs:metadata': 'File metadata',
      'net:internal': 'Internal network', 'net:external': 'External network', 'net:websocket': 'WebSocket',
      'mail:read': 'Read emails', 'mail:write': 'Compose emails', 'mail:send': 'Send emails', 'mail:delete': 'Delete emails',
      'calendar:read': 'Read calendar', 'calendar:write': 'Edit calendar', 'calendar:delete': 'Delete events',
      'contacts:read': 'Read contacts', 'contacts:write': 'Edit contacts',
      'device:camera': 'Camera', 'device:microphone': 'Microphone',
      'device:geolocation': 'Location', 'device:notifications': 'Notifications',
      'system:info': 'System info', 'system:settings': 'System settings', 'system:apps': 'Manage apps',
      'admin:system': 'System administration', 'admin:users': 'Manage users', 'admin:audit': 'Audit logs',
      'data:export': 'Export data', 'data:backup': 'Backup data',
    };
    const RISK_COLOR = { low: '#3fb950', medium: '#d29922', high: '#f0883e', critical: '#f85149' };
    const RISK_BG    = { low: 'rgba(63,185,80,0.1)', medium: 'rgba(210,153,34,0.1)', high: 'rgba(240,136,62,0.1)', critical: 'rgba(248,81,73,0.1)' };

    // ── State ─────────────────────────────────────────────────────────────
    const validIds = new Set(SECTIONS.map(s => s.id));
    let currentSection = (options && validIds.has(options.section)) ? options.section : 'appearance';

    // ── DOM skeleton ──────────────────────────────────────────────────────
    const container   = createEl('div', { className: 'nook-container' });
    const sidebar     = createEl('div', { className: 'nook-sidebar', role: 'navigation' });
    const mainContent = createEl('div', { className: 'nook-content' });

    // ── Sidebar: built once, only active class updated on nav ─────────────
    /** @type {Map<string, HTMLButtonElement>} */
    const sidebarBtns = new Map();

    function buildSidebar() {
      for (const s of SECTIONS) {
        const btn = createEl('button', { className: 'nook-section-btn', 'aria-label': s.name });
        const icon = createEl('span');
        icon.innerHTML = svgIcon(s.icon, 16);
        btn.appendChild(icon);
        btn.appendChild(createEl('span', { textContent: s.name }));
        btn.addEventListener('click', () => {
          currentSection = s.id;
          updateSidebarActive();
          renderContent();
        });
        sidebarBtns.set(s.id, btn);
        sidebar.appendChild(btn);
      }
      updateSidebarActive();
    }

    function updateSidebarActive() {
      for (const [id, btn] of sidebarBtns) {
        btn.classList.toggle('active', id === currentSection);
      }
    }

    // ── Content router ─────────────────────────────────────────────────────
    function renderContent() {
      mainContent.innerHTML = '';
      mainContent.dataset.currentTab = currentSection;
      switch (currentSection) {
        case 'appearance':    renderAppearance();    break;
        case 'accessibility': renderAccessibility(); break;
        case 'system':        renderSystem();        break;
        case 'date-and-region': renderDateAndRegion(); break;
        case 'storage':       renderStorage();       break;
        case 'shortcuts':     renderShortcuts();     break;
        case 'privacy':       renderPrivacy();       break;
        case 'apps':          renderApps();          break;
        case 'desktop':       renderDesktop();       break;
        case 'about':         renderAbout();         break;
        default:
          mainContent.appendChild(createEl('div', { className: 'empty-state', textContent: 'Section coming soon' }));
      }
    }

    // ── Appearance ─────────────────────────────────────────────────────────
    function renderAppearance() {
      mainContent.appendChild(createEl('h2', { textContent: 'Appearance', style: { marginBottom: '20px' } }));

      const wallpaperLocked = OS.settings.get('prohibitWallpaperChange');
      const currentTheme    = OS.settings.get('theme');
      const currentAccent   = OS.settings.get('accentColor');

      // Theme
      const themeGroup = createEl('div', { className: 'nook-group' });
      themeGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Theme' }));
      for (let i = 0; i < THEMES.length; i++) {
        const t   = THEMES[i];
        const row = createEl('div', { className: 'nook-row' });
        row.appendChild(createEl('span', { className: 'nook-row-label', textContent: THEME_NAMES[i] }));
        const btn = createEl('button', {
          className: 'btn btn-sm' + (currentTheme === t ? ' btn-primary' : ''),
          textContent: currentTheme === t ? 'Active' : 'Select'
        });
        btn.addEventListener('click', () => {
          OS.settings.set('theme', t);
          applyTheme(t);
          // Re-apply saved custom accent (applyTheme resets --accent to theme default)
          const savedAccent = OS.settings.get('accentColor');
          if (savedAccent) {
            document.documentElement.style.setProperty('--accent', savedAccent);
            document.documentElement.style.setProperty('--accent-hover', savedAccent + 'dd');
            document.documentElement.style.setProperty('--accent-muted', savedAccent + '26');
          }
          renderContent();
        });
        row.appendChild(btn);
        themeGroup.appendChild(row);
      }
      mainContent.appendChild(themeGroup);

      // Accent color
      const accentGroup = createEl('div', { className: 'nook-group' });
      accentGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Accent Color' }));
      if (wallpaperLocked) {
        accentGroup.appendChild(createEl('div', {
          style: 'font-size:11px;color:var(--text-warning,#d29922);padding:4px 0;',
          textContent: '🔒 Accent colour changes are restricted by policy.'
        }));
      }
      const colorRow = createEl('div', { className: 'nook-row' });
      for (const c of ACCENT_COLORS) {
        const btn = createEl('button', {
          className: 'btn btn-sm',
          style: {
            width: '32px', height: '32px', background: c,
            border: currentAccent === c ? '2px solid white' : 'none',
            borderRadius: '50%', padding: '0',
            opacity: wallpaperLocked ? '0.4' : '1',
            cursor: wallpaperLocked ? 'not-allowed' : 'pointer'
          },
          'aria-label': 'Color ' + c,
          disabled: !!wallpaperLocked
        });
        if (!wallpaperLocked) {
          btn.addEventListener('click', () => {
            OS.settings.set('accentColor', c);
            document.documentElement.style.setProperty('--accent', c);
            document.documentElement.style.setProperty('--accent-hover', c + 'dd');
            document.documentElement.style.setProperty('--accent-muted', c + '22');
            renderContent();
          });
        }
        colorRow.appendChild(btn);
      }
      accentGroup.appendChild(colorRow);
      mainContent.appendChild(accentGroup);

      // Clock format
      const clockGroup = createEl('div', { className: 'nook-group' });
      clockGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Clock' }));
      const clockRow = createEl('div', { className: 'nook-row' });
      clockRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Time Format' }));
      const clockToggle = createEl('button', {
        className: 'toggle' + (OS.settings.get('clockFormat') === '24h' ? ' active' : ''),
        'aria-label': 'Toggle 24-hour time'
      });
      clockToggle.addEventListener('click', () => {
        const is24 = OS.settings.get('clockFormat') === '24h';
        OS.settings.set('clockFormat', is24 ? '12h' : '24h');
        clockToggle.classList.toggle('active', !is24);
        // Force clock to update immediately without waiting for next interval tick
        const timeEl = document.getElementById('tray-time');
        if (timeEl) {
          const now = new Date();
          const h = now.getHours(), m = now.getMinutes();
          if (!is24) { // switching to 24h
            timeEl.textContent = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
          } else {     // switching to 12h
            const h12 = h % 12 || 12;
            timeEl.textContent = h12 + ':' + String(m).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM');
          }
        }
      });
      clockRow.appendChild(clockToggle);
      clockGroup.appendChild(clockRow);
      mainContent.appendChild(clockGroup);
    }

    // ── System ─────────────────────────────────────────────────────────────
    function renderSystem() {
      mainContent.appendChild(createEl('h2', { textContent: 'System', style: { marginBottom: '20px' } }));

      // User
      const userGroup = createEl('div', { className: 'nook-group' });
      userGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'User' }));
      const userRow = createEl('div', { className: 'nook-row' });
      userRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Username' }));
      const userInput = createEl('input', {
        className: 'input', id: 'system-username-input', name: 'system-username',
        style: { width: '150px' }, value: OS.username
      });
      userInput.addEventListener('change', () => {
        OS.username = userInput.value || 'user';
        OS.settings.set('username', OS.username);
      });
      userRow.appendChild(userInput);
      userGroup.appendChild(userRow);
      mainContent.appendChild(userGroup);

      // Lock screen
      const lockGroup = createEl('div', { className: 'nook-group' });
      lockGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Lock Screen' }));
      const pinRow = createEl('div', { className: 'nook-row' });
      pinRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'PIN Lock' }));

      const pinBtn = createEl('button', { className: 'btn btn-sm', textContent: OS.lockPin ? 'Change PIN' : 'Set PIN' });
      pinBtn.addEventListener('click', async () => {
        if (OS.lockPin) {
          const currentPin = await showModal('Change PIN', 'Enter current PIN:', [
            { label: 'Cancel' }, { label: 'Next', value: 'next' }
          ], 'password');
          if (!currentPin) return;
          const hash = await OS.workers.crypto.call('pbkdf2', currentPin, getPinSalt());
          if (hash !== OS.lockPin) {
            showModal('Incorrect PIN', 'The current PIN you entered is incorrect.');
            return;
          }
        }

        const pin1 = await showModal(OS.lockPin ? 'New PIN' : 'Set PIN', 'Enter a 4-digit PIN:', [
          { label: 'Cancel' }, { label: 'Next', value: 'next' }
        ], 'password');
        if (!pin1 || pin1.length !== 4 || !/^\d{4}$/.test(pin1)) {
          if (pin1) showModal('Invalid PIN', 'PIN must be exactly 4 digits.');
          return;
        }

        const pin2 = await showModal('Confirm PIN', 'Re-enter your PIN:', [
          { label: 'Cancel' }, { label: 'Set PIN', value: 'confirm' }
        ], 'password');
        if (pin1 !== pin2) {
          showModal('PIN Mismatch', 'The PINs do not match. Please try again.');
          return;
        }

        const wasSet  = !!OS.lockPin;
        const newHash = await OS.workers.crypto.call('pbkdf2', pin1, getPinSalt());
        OS.lockPin    = newHash;
        OS.settings.set('lockPin', newHash);
        Notify.show({ title: wasSet ? 'PIN Updated' : 'PIN Set', body: wasSet ? 'Lock screen PIN has been updated' : 'Lock screen PIN has been set', type: 'success', appName: 'Settings' });
        renderContent();
      });
      pinRow.appendChild(pinBtn);

      if (OS.lockPin) {
        const removePinBtn = createEl('button', { className: 'btn btn-sm btn-danger', textContent: 'Remove', style: { marginLeft: '8px' } });
        removePinBtn.addEventListener('click', async () => {
          const result = await showModal('Remove PIN', 'Are you sure you want to remove PIN lock?', [
            { label: 'Cancel' }, { label: 'Remove PIN', danger: true, value: 'confirm' }
          ]);
          if (result === 'confirm') {
            OS.settings.set('lockPin', null);
            OS.lockPin = null;
            Notify.show({ title: 'PIN Removed', body: 'PIN lock has been disabled', type: 'success', appName: 'Settings' });
            renderContent();
          }
        });
        pinRow.appendChild(removePinBtn);
      }
      lockGroup.appendChild(pinRow);
      mainContent.appendChild(lockGroup);

      // Recovery
      const recoveryGroup = createEl('div', { className: 'nook-group' });
      recoveryGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Recovery' }));
      const recoveryRow = createEl('div', { className: 'nook-row' });
      recoveryRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Recovery Environment' }));
      const recoveryBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Boot to Recovery', style: { background: '#6c5ce7' } });
      recoveryBtn.addEventListener('click', async () => {
        const confirmed = await showModal(
          'Boot to Recovery Environment',
          'This will restart and show the recovery options screen.',
          [{ label: 'Cancel' }, { label: 'Boot to Recovery', value: 'confirm', primary: true }]
        );
        if (confirmed !== 'confirm') return;
        // Set manual recovery flag so recovery screen knows this is intentional.
        // (init.js's manual-recovery branch only checks this flag and always
        // clears nova_boot_attempts itself, so we don't need to write fake
        // boot-attempt entries here — they'd just get deleted immediately.)
        localStorage.setItem('nova_manual_recovery', '1');
        localStorage.removeItem('nova_safe_mode');
        location.reload();
      });
      recoveryRow.appendChild(recoveryBtn);
      recoveryGroup.appendChild(recoveryRow);
      mainContent.appendChild(recoveryGroup);

      // Developer Mode
      const devGroup = createEl('div', { className: 'nook-group' });
      devGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Developer' }));
      const devRow = createEl('div', { className: 'nook-toggle-row' });
      devRow.appendChild(createEl('span', { textContent: 'Developer Mode' }));
      const devToggle = createEl('button', {
        className: 'toggle' + (OS.settings.get('devMode') ? ' active' : '')
      });
      devToggle.addEventListener('click', async () => {
        const next = !OS.settings.get('devMode');
        if (next) {
          const confirmed = await new Promise((resolve) => {
            const overlay = createEl('div', {
              style: 'position:fixed;inset:0;z-index:99001;background:rgba(0,0,0,0.45);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;animation:fadeIn 150ms ease;'
            });
            const dialog = createEl('div', {
              style: 'background:var(--bg-elevated,#1b1f23);border:1px solid var(--text-danger,#f85149);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(248,81,73,0.25);padding:28px;max-width:520px;width:92%;animation:modalIn 200ms ease-out;'
            });

            const header = createEl('div', {
              style: 'display:flex;align-items:center;gap:12px;margin-bottom:16px;'
            });
            const icon = createEl('span', {
              textContent: '⚠️',
              style: 'font-size:22px;line-height:1;'
            });
            const title = createEl('div', {
              textContent: 'Developer Mode — Security Warning',
              style: 'font-size:17px;font-weight:700;color:var(--text-danger,#f85149);letter-spacing:0.2px;'
            });
            header.appendChild(icon);
            header.appendChild(title);
            dialog.appendChild(header);

            const body = createEl('div', {
              style: 'font-size:14px;color:var(--text-secondary,#aaa);line-height:1.55;margin-bottom:18px;white-space:pre-line;max-height:340px;overflow-y:auto;padding-right:4px;'
            });
            body.textContent =
              'WARNING: Developer Mode lowers the system\'s security posture and grants elevated access to internal components.\n\n' +
              'When enabled, the following restrictions are relaxed:\n' +
              '• Unrestricted access to the filesystem, networks, and system APIs\n' +
              '• Elevated permissions to internal system modules and runtime internals\n' +
              '• Visibility into running processes, memory, and module state\n' +
              '• The ability to inspect, alter, or revoke app permissions\n' +
              '• The ability to install, remove, or modify system packages\n\n' +
              'The following internal apps and tools become accessible:\n' +
              '• Console — runs arbitrary JavaScript in the full OS context with no sandboxing\n' +
              '• Inspector — can force-close arbitrary windows and export app state\n' +
              '• Packages — can install unsigned or unverified packages into the live registry, and can add a locally-generated signing key to this device\u2019s trust store for the current session (only affects installs on this machine; never affects other clones, forks, or devices)\n' +
              '• Modules — can dynamically import arbitrary module paths for live code execution\n' +
              '• Permissions — can bulk-grant or revoke permissions for any app without user consent\n' +
              '• Perf — exposes detailed runtime performance data, memory usage, and per-window DOM breakdowns\n' +
              '• SysAccess — can read the virtual filesystem and probe internal network/SSRF configuration\n' +
               '• Events — full visibility into all system-wide activity, including console output, permission checks, package operations, and app event data payloads across every app and OS component\n' +
              '• Debug Overlay — persistent always-on-top diagnostics overlay exposing GPU, memory, URLs, and OS internals (F3)\n\n' +
              'Developer Mode is intended solely for development, debugging, and system maintenance. Enable it only when you understand the risks. Leave it disabled during normal use.';
            dialog.appendChild(body);

            const actions = createEl('div', {
              style: 'display:flex;gap:10px;justify-content:flex-end;'
            });
            const cancelBtn = createEl('button', {
              className: 'btn',
              textContent: 'Cancel'
            });
            const confirmBtn = createEl('button', {
              className: 'btn btn-danger',
              textContent: 'Turn On Anyway'
            });
            actions.appendChild(cancelBtn);
            actions.appendChild(confirmBtn);
            dialog.appendChild(actions);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            const done = (v) => { overlay.remove(); resolve(v); };
            overlay.addEventListener('click', (e) => {
              if (e.target === overlay) done(null);
              const btn = e.target.closest('button');
              if (btn && actions.contains(btn)) {
                done(btn === confirmBtn ? 'confirm' : null);
              }
            });
            confirmBtn.focus();
          });
          if (confirmed !== 'confirm') return;
        }
        OS.settings.set('devMode', next);
        devToggle.classList.toggle('active', next);
        if (window.DebugOverlay) {
          next ? window.DebugOverlay.enable() : window.DebugOverlay.disable();
        }
        Notify.show({
          title: next ? 'Developer Mode Enabled' : 'Developer Mode Disabled',
          body: next ? 'Press F3 to toggle debug overlay' : undefined,
          type: 'info',
          appName: 'Settings'
        });
      });
      devRow.appendChild(devToggle);
      devGroup.appendChild(devRow);
      mainContent.appendChild(devGroup);
    }

    // ── Date and Region ────────────────────────────────────────────────────
    function renderDateAndRegion() {
      mainContent.appendChild(createEl('h2', { textContent: 'Date and Region', style: { marginBottom: '20px' } }));

      let i18n = null;
      try { i18n = require('i18next'); } catch (e) { /* optional */ }

      const REGIONS = [
        { code: 'af-NA', name: 'Afrika (Namibië)' }, { code: 'sq-AL', name: 'Albania' },
        { code: 'ar-SA', name: 'Arab Saudi' }, { code: 'hy-AM', name: 'Hayastán' },
        { code: 'eu-ES', name: 'Euskadi' }, { code: 'be-BY', name: 'Беларусь' },
        { code: 'bn-BD', name: 'বাংলাদেশ' }, { code: 'bs-BA', name: 'Bosna i Hercegovina' },
        { code: 'bg-BG', name: 'България' }, { code: 'ca-ES', name: 'Català' },
        { code: 'zh-CN', name: '中国' }, { code: 'zh-TW', name: '台灣' }, { code: 'zh-HK', name: '香港' },
        { code: 'hr-HR', name: 'Hrvatska' }, { code: 'cs-CZ', name: 'Česká republika' },
        { code: 'da-DK', name: 'Danmark' }, { code: 'nl-NL', name: 'Nederland' },
        { code: 'en-AU', name: 'Australia' }, { code: 'en-CA', name: 'Canada' },
        { code: 'en-GB', name: 'United Kingdom' }, { code: 'en-US', name: 'United States' },
        { code: 'et-EE', name: 'Eesti' }, { code: 'fi-FI', name: 'Suomi' },
        { code: 'fr-BE', name: 'Belgique' }, { code: 'fr-CA', name: 'Canada' },
        { code: 'fr-FR', name: 'France' }, { code: 'gl-ES', name: 'Galicia' },
        { code: 'ka-GE', name: 'საქართველო' }, { code: 'de-AT', name: 'Österreich' },
        { code: 'de-DE', name: 'Deutschland' }, { code: 'de-CH', name: 'Schweiz' },
        { code: 'el-GR', name: 'Ελλάδα' }, { code: 'gu-IN', name: 'ભારત' },
        { code: 'he-IL', name: 'ישראל' }, { code: 'hi-IN', name: 'भारत' },
        { code: 'hu-HU', name: 'Magyarország' }, { code: 'is-IS', name: 'Ísland' },
        { code: 'id-ID', name: 'Indonesia' }, { code: 'ga-IE', name: 'Éire' },
        { code: 'it-IT', name: 'Italia' }, { code: 'ja-JP', name: '日本' },
        { code: 'kn-IN', name: 'ಭಾರತ' }, { code: 'kk-KZ', name: 'Қазақстан' },
        { code: 'km-KH', name: 'កម្ពុជា' }, { code: 'ko-KR', name: '대한민국' },
        { code: 'ku-TR', name: 'Türkiye' }, { code: 'ky-KG', name: 'Кыргызстан' },
        { code: 'lo-LA', name: 'ປະເທດລາວ' }, { code: 'lv-LV', name: 'Latvija' },
        { code: 'lt-LT', name: 'Lietuva' }, { code: 'lb-LU', name: 'Lëtzebuerg' },
        { code: 'mk-MK', name: 'Македонија' }, { code: 'ms-MY', name: 'Malaysia' },
        { code: 'ml-IN', name: 'ഇന്ത്യ' }, { code: 'mt-MT', name: 'Malta' },
        { code: 'mr-IN', name: 'भारत' }, { code: 'mn-MN', name: 'Монгол' },
        { code: 'my-MM', name: 'မြန်မာ' }, { code: 'ne-NP', name: 'नेपाल' },
        { code: 'nb-NO', name: 'Norge' }, { code: 'fa-IR', name: 'ایران' },
        { code: 'pl-PL', name: 'Polska' }, { code: 'pt-BR', name: 'Brasil' },
        { code: 'pt-PT', name: 'Portugal' }, { code: 'pa-IN', name: 'ਭਾਰਤ' },
        { code: 'ro-RO', name: 'România' }, { code: 'ru-RU', name: 'Россия' },
        { code: 'sr-RS', name: 'Србија' }, { code: 'sk-SK', name: 'Slovensko' },
        { code: 'sl-SI', name: 'Slovenija' }, { code: 'es-ES', name: 'España' },
        { code: 'es-MX', name: 'México' }, { code: 'sw-KE', name: 'Kenya' },
        { code: 'sv-SE', name: 'Sverige' }, { code: 'ta-IN', name: 'இந்தியா' },
        { code: 'te-IN', name: 'భారత్' }, { code: 'th-TH', name: 'ไทย' },
        { code: 'tr-TR', name: 'Türkiye' }, { code: 'uk-UA', name: 'Україна' },
        { code: 'ur-PK', name: 'پاکستان' }, { code: 'uz-UZ', name: "O'zbekiston" },
        { code: 'vi-VN', name: 'Việt Nam' }, { code: 'cy-GB', name: 'Cymru' },
        { code: 'ha-NG', name: 'Nigera' }, { code: 'ig-NG', name: 'Nigeria' },
        { code: 'yo-NG', name: 'Nigeria' }, { code: 'zu-ZA', name: 'South Africa' },
        { code: 'xh-ZA', name: 'South Africa' }, { code: 'mg-MG', name: 'Madagascar' },
        { code: 'fil-PH', name: 'Pilipinas' }, { code: 'am-ET', name: 'ኢትዮጵያ' },
        { code: 'bn-IN', name: 'ভারত' }, { code: 'si-LK', name: 'ශ්‍රී ලංකා' },
        { code: 'km-KH', name: 'កម្ពុជា' }, { code: 'my-MM', name: 'မြန်မာ' },
        { code: 'ka-GE', name: 'საქართველო' }, { code: 'hy-AM', name: 'Հայաստան' },
        { code: 'az-AZ', name: 'Azərbaycan' }, { code: 'kk-KZ', name: 'Қазақстан' },
        { code: 'ky-KG', name: 'Кыргызстан' }, { code: 'tg-TJ', name: 'Тоҷикистон' },
        { code: 'tk-TM', name: 'Türkmenistan' }, { code: 'mn-MN', name: 'Монгол' },
        { code: 'ja-JP', name: '日本' }, { code: 'ko-KP', name: '조선민주주의인민공화국' },
        { code: 'ko-KR', name: '대한민국' }, { code: 'zh-CN', name: '中国' },
        { code: 'zh-TW', name: '台灣' }, { code: 'zh-HK', name: '香港' },
        { code: 'vi-VN', name: 'Việt Nam' }, { code: 'lo-LA', name: 'ປະເທດລາວ' },
        { code: 'km-KH', name: 'កម្ពុជា' }, { code: 'my-MM', name: 'မြန်မာ' },
        { code: 'th-TH', name: 'ไทย' }, { code: 'bn-BD', name: 'বাংলাদেশ' },
        { code: 'ne-NP', name: 'नेपाल' }, { code: 'si-LK', name: 'ශ්‍රී ලංකා' },
        { code: 'dv-MV', name: 'ދިވެހިރާއްޖެ' }, { code: 'fa-AF', name: 'افغانستان' },
        { code: 'fa-IR', name: 'ایران' }, { code: 'ur-PK', name: 'پاکستان' },
        { code: 'ps-AF', name: 'افغانستان' }, { code: 'ku-TR', name: 'Türkiye' },
        { code: 'ckb-IQ', name: 'Iraq' }, { code: 'yi-IL', name: 'ישראל' },
        { code: 'am-ET', name: 'ኢትዮጵያ' }, { code: 'ti-ER', name: 'Eritrea' },
        { code: 'so-SO', name: 'Soomaaliya' }, { code: 'sw-KE', name: 'Kenya' },
        { code: 'sw-TZ', name: 'Tanzania' }, { code: 'zu-ZA', name: 'South Africa' },
        { code: 'xh-ZA', name: 'South Africa' }, { code: 'af-ZA', name: 'South Africa' },
        { code: 'st-ZA', name: 'South Africa' }, { code: 'tn-BW', name: 'Botswana' },
        { code: 'mg-MG', name: 'Madagascar' }, { code: 'mt-MT', name: 'Malta' },
        { code: 'is-IS', name: 'Ísland' }, { code: 'fo-FO', name: 'Føroyar' },
        { code: 'se-NO', name: 'Norgga' }, { code: 'sm-WS', name: 'Sāmoa' },
        { code: 'to-TO', name: 'Tonga' }, { code: 'fj-FJ', name: 'Fiji' },
        { code: 'ty-PF', name: 'Polynésie française' }, { code: 'mi-NZ', name: 'Aotearoa' },
        { code: 'qu-PE', name: 'Perú' }, { code: 'gn-PY', name: 'Paraguái' },
        { code: 'ay-BO', name: 'Bolivia' }, { code: 'qu-BO', name: 'Bolivia' },
        { code: 'cy-GB', name: 'Cymru' }, { code: 'gd-GB', name: 'Alba' },
        { code: 'kw-GB', name: 'Kernow' }, { code: 'gv-IM', name: 'Ellan Vannin' },
        { code: 'br-FR', name: 'Breizh' }, { code: 'oc-FR', name: 'Occitània' },
        { code: 'co-FR', name: 'Corsica' }, { code: 'eu-ES', name: 'Euskadi' },
        { code: 'ca-ES', name: 'Català' }, { code: 'gl-ES', name: 'Galicia' },
        { code: 'ast-ES', name: 'Asturies' }, { code: 'an-ES', name: 'Aragón' },
        { code: 'lad-IL', name: 'Israel' }, { code: 'yi-IL', name: 'ישראל' },
        { code: 'he-IL', name: 'ישראל' }, { code: 'ar-IL', name: 'إسرائيل' },
        { code: 'en-IL', name: 'Israel' }, { code: 'fr-DZ', name: 'Algérie' },
        { code: 'ar-MA', name: 'المغرب' }, { code: 'ar-TN', name: 'تونس' },
        { code: 'ar-DZ', name: 'الجزائر' }, { code: 'ar-LY', name: 'ليبيا' },
        { code: 'ar-EG', name: 'مصر' }, { code: 'ar-SD', name: 'السودان' },
        { code: 'ar-SO', name: 'الصومال' }, { code: 'ar-DJ', name: 'جيبوتي' },
        { code: 'ar-KW', name: 'الكويت' }, { code: 'ar-BH', name: 'البحرين' },
        { code: 'ar-QA', name: 'قطر' }, { code: 'ar-AE', name: 'الإمارات' },
        { code: 'ar-OM', name: 'عُمان' }, { code: 'ar-YE', name: 'اليمن' },
        { code: 'ar-JO', name: 'الأردن' }, { code: 'ar-LB', name: 'لبنان' },
        { code: 'ar-SY', name: 'سوريا' }, { code: 'ar-IQ', name: 'العراق' },
        { code: 'fa-IR', name: 'ایران' }, { code: 'ur-PK', name: 'پاکستان' },
        { code: 'ur-IN', name: 'بھارت' }, { code: 'bn-IN', name: 'ভারত' },
        { code: 'bn-BD', name: 'বাংলাদেশ' }, { code: 'pa-IN', name: 'ਭਾਰਤ' },
        { code: 'gu-IN', name: 'ભારત' }, { code: 'mr-IN', name: 'भारत' },
        { code: 'ta-IN', name: 'இந்தியா' }, { code: 'te-IN', name: 'భారత్' },
        { code: 'kn-IN', name: 'ಭಾರತ' }, { code: 'ml-IN', name: 'ഇന്ത്യ' },
        { code: 'si-LK', name: 'ශ්‍රී ලංකා' }, { code: 'my-MM', name: 'မြန်မာ' },
        { code: 'ne-NP', name: 'नेपाल' }, { code: 'bo-CN', name: '中国' },
        { code: 'mn-MN', name: 'Монгол' }, { code: 'ru-RU', name: 'Россия' },
        { code: 'ru-KZ', name: 'Қазақстан' }, { code: 'ru-KG', name: 'Кыргызстан' },
        { code: 'ru-TJ', name: 'Тоҷикистон' }, { code: 'ru-TM', name: 'Türkmenistan' },
        { code: 'ru-UZ', name: "O'zbekiston" }, { code: 'ru-UA', name: 'Україна' },
        { code: 'ru-BY', name: 'Беларусь' }, { code: 'ru-MD', name: 'Moldova' },
        { code: 'ru-AM', name: 'Հայաստան' }, { code: 'ru-GE', name: 'საქართველო' },
        { code: 'ru-AZ', name: 'Azərbaycan' }, { code: 'et-EE', name: 'Eesti' },
        { code: 'lv-LV', name: 'Latvija' }, { code: 'lt-LT', name: 'Lietuva' },
        { code: 'pl-PL', name: 'Polska' }, { code: 'cs-CZ', name: 'Česká republika' },
        { code: 'sk-SK', name: 'Slovensko' }, { code: 'hu-HU', name: 'Magyarország' },
        { code: 'ro-RO', name: 'România' }, { code: 'bg-BG', name: 'България' },
        { code: 'hr-HR', name: 'Hrvatska' }, { code: 'sr-RS', name: 'Србија' },
        { code: 'mk-MK', name: 'Македонија' }, { code: 'sl-SI', name: 'Slovenija' },
        { code: 'al-AL', name: 'Shqipëria' }, { code: 'mk-MK', name: 'Македонија' },
        { code: 'gr-GR', name: 'Ελλάδα' }, { code: 'cy-CY', name: 'Κύπρος' },
        { code: 'tr-CY', name: 'Kıbrıs' }, { code: 'tr-TR', name: 'Türkiye' },
        { code: 'az-AZ', name: 'Azərbaycan' }, { code: 'ge-GE', name: 'საქართველო' },
        { code: 'am-AM', name: 'Հայաստան' }, { code: 'kw-IE', name: 'Éire' },
        { code: 'ga-IE', name: 'Éire' }, { code: 'en-IE', name: 'Ireland' },
        { code: 'cy-GB', name: 'Cymru' }, { code: 'en-GB', name: 'United Kingdom' },
        { code: 'en-SC', name: 'Seychelles' }, { code: 'en-MT', name: 'Malta' },
        { code: 'mt-MT', name: 'Malta' }, { code: 'en-ZA', name: 'South Africa' },
        { code: 'af-ZA', name: 'South Africa' }, { code: 'zu-ZA', name: 'South Africa' },
        { code: 'xh-ZA', name: 'South Africa' }, { code: 'st-ZA', name: 'South Africa' },
        { code: 'tn-BW', name: 'Botswana' }, { code: 'en-BW', name: 'Botswana' },
        { code: 'en-NG', name: 'Nigeria' }, { code: 'en-KE', name: 'Kenya' },
        { code: 'sw-KE', name: 'Kenya' }, { code: 'en-GH', name: 'Ghana' },
        { code: 'fr-SN', name: 'Sénégal' }, { code: 'fr-CI', name: "Côte d'Ivoire" },
        { code: 'fr-CM', name: 'Cameroun' }, { code: 'fr-CD', name: 'RDC' },
        { code: 'fr-CG', name: 'Congo' }, { code: 'fr-GA', name: 'Gabon' },
        { code: 'fr-TD', name: 'Tchad' }, { code: 'fr-CF', name: 'RCA' },
        { code: 'fr-CM', name: 'Cameroun' }, { code: 'fr-MG', name: 'Madagascar' },
        { code: 'fr-MU', name: 'Maurice' }, { code: 'fr-SC', name: 'Seychelles' },
        { code: 'fr-RE', name: 'Réunion' }, { code: 'fr-PF', name: 'Polynésie française' },
        { code: 'fr-NC', name: 'Nouvelle-Calédonie' }, { code: 'fr-WF', name: 'Wallis et Futuna' },
        { code: 'pt-AO', name: 'Angola' }, { code: 'pt-MZ', name: 'Moçambique' },
        { code: 'pt-GW', name: 'Guiné-Bissau' }, { code: 'pt-CV', name: 'Cabo Verde' },
        { code: 'pt-ST', name: 'São Tomé e Príncipe' }, { code: 'pt-TL', name: 'Timor-Leste' },
        { code: 'es-CU', name: 'Cuba' }, { code: 'es-DO', name: 'República Dominicana' },
        { code: 'es-PR', name: 'Puerto Rico' }, { code: 'es-HN', name: 'Honduras' },
        { code: 'es-GT', name: 'Guatemala' }, { code: 'es-SV', name: 'El Salvador' },
        { code: 'es-NI', name: 'Nicaragua' }, { code: 'es-CR', name: 'Costa Rica' },
        { code: 'es-PA', name: 'Panamá' }, { code: 'es-CO', name: 'Colombia' },
        { code: 'es-VE', name: 'Venezuela' }, { code: 'es-EC', name: 'Ecuador' },
        { code: 'es-PE', name: 'Perú' }, { code: 'es-BO', name: 'Bolivia' },
        { code: 'es-PY', name: 'Paraguay' }, { code: 'es-UY', name: 'Uruguay' },
        { code: 'es-AR', name: 'Argentina' }, { code: 'es-CL', name: 'Chile' },
        { code: 'es-BR', name: 'Brasil' }, { code: 'en-BR', name: 'Brasil' },
        { code: 'es-PH', name: 'Pilipinas' }, { code: 'en-PH', name: 'Pilipinas' },
        { code: 'id-ID', name: 'Indonesia' }, { code: 'ms-MY', name: 'Malaysia' },
        { code: 'ms-BN', name: 'Brunei' }, { code: 'th-TH', name: 'ไทย' },
        { code: 'lo-LA', name: 'ປະເທດລາວ' }, { code: 'km-KH', name: 'កម្ពុជា' },
        { code: 'vi-VN', name: 'Việt Nam' }, { code: 'zh-VN', name: 'Việt Nam' },
        { code: 'zh-CN', name: '中国' }, { code: 'zh-SG', name: '新加坡' },
        { code: 'zh-MO', name: '澳門' }, { code: 'zh-HK', name: '香港' },
        { code: 'zh-TW', name: '台灣' }, { code: 'ja-JP', name: '日本' },
        { code: 'ko-KR', name: '대한민국' }, { code: 'ko-KP', name: '조선민주주의인민공화국' },
        { code: 'mn-MN', name: 'Монгол' }, { code: 'ru-RU', name: 'Россия' },
        { code: 'kk-KZ', name: 'Қазақстан' }, { code: 'ky-KG', name: 'Кыргызстан' },
        { code: 'uz-UZ', name: "O'zbekiston" }, { code: 'tj-TJ', name: 'Тоҷикистон' },
        { code: 'tm-TM', name: 'Türkmenistan' }, { code: 'af-AF', name: 'افغانستان' },
        { code: 'ne-NP', name: 'नेपाल' }, { code: 'bn-BD', name: 'বাংলাদেশ' },
        { code: 'bn-IN', name: 'ভারত' }, { code: 'si-LK', name: 'ශ්‍රී ලංකා' },
        { code: 'dv-MV', name: 'ދިވެހިރާއްޖެ' }, { code: 'ur-IN', name: 'بھارت' },
        { code: 'pa-IN', name: 'ਭਾਰਤ' }, { code: 'gu-IN', name: 'ભારત' },
        { code: 'mr-IN', name: 'भारत' }, { code: 'ta-IN', name: 'இந்தியா' },
        { code: 'te-IN', name: 'భారత్' }, { code: 'kn-IN', name: 'ಭಾರತ' },
        { code: 'ml-IN', name: 'ഇന്ത്യ' }, { code: 'or-IN', name: 'ଭାରତ' },
        { code: 'as-IN', name: 'ভাৰত' }, { code: 'mai-IN', name: 'भारत' },
        { code: 'sa-IN', name: 'भारतम्' }, { code: 'en-IN', name: 'भारत' },
        { code: 'fr-IN', name: 'भारत' }, { code: 'pt-IN', name: 'भारत' },
        { code: 'ar-IN', name: 'भारत' }, { code: 'ur-PK', name: 'پاکستان' },
        { code: 'ps-AF', name: 'افغانستان' }, { code: 'fa-AF', name: 'افغانستان' },
        { code: 'tk-TM', name: 'Türkmenistan' }, { code: 'uz-AF', name: 'افغانستان' },
        { code: 'kk-KZ', name: 'Қазақстан' }, { code: 'ru-KZ', name: 'Қазақстан' },
        { code: 'ky-KG', name: 'Кыргызстан' }, { code: 'ru-KG', name: 'Кыргызстан' },
        { code: 'tg-TJ', name: 'Тоҷикистон' }, { code: 'ru-TJ', name: 'Тоҷикистон' },
        { code: 'az-AZ', name: 'Azərbaycan' }, { code: 'ru-AZ', name: 'Azərbaycan' },
        { code: 'hy-AM', name: 'Հայաստան' }, { code: 'ru-AM', name: 'Հայաստան' },
        { code: 'ka-GE', name: 'საქართველო' }, { code: 'ru-GE', name: 'საქართველო' },
        { code: 'ab-GE', name: 'Аҧсуа' }, { code: 'os-GE', name: 'Гуырдзи' },
        { code: 'ru-BY', name: 'Беларусь' }, { code: 'be-BY', name: 'Беларусь' },
        { code: 'ru-UA', name: 'Україна' }, { code: 'uk-UA', name: 'Україна' },
        { code: 'ru-MD', name: 'Moldova' }, { code: 'ro-MD', name: 'Moldova' },
        { code: 'bg-BG', name: 'България' }, { code: 'tr-BG', name: 'Bulgaria' },
        { code: 'ro-RO', name: 'România' }, { code: 'hu-RO', name: 'România' },
        { code: 'hu-HU', name: 'Magyarország' }, { code: 'de-HU', name: 'Ungarn' },
        { code: 'sk-SK', name: 'Slovensko' }, { code: 'hu-SK', name: 'Slovensko' },
        { code: 'cs-CZ', name: 'Česká republika' }, { code: 'sk-CZ', name: 'Česká republika' },
        { code: 'pl-CZ', name: 'Česká republika' }, { code: 'de-CZ', name: 'Tschechien' },
        { code: 'pl-PL', name: 'Polska' }, { code: 'de-PL', name: 'Polen' },
        { code: 'ru-PL', name: 'Polska' }, { code: 'lt-PL', name: 'Lenkija' },
        { code: 'de-DE', name: 'Deutschland' }, { code: 'fr-DE', name: 'Allemagne' },
        { code: 'en-DE', name: 'Germany' }, { code: 'ru-DE', name: 'Германия' },
        { code: 'tr-DE', name: 'Almanya' }, { code: 'ar-DE', name: 'ألمانيا' },
        { code: 'pl-DE', name: 'Niemcy' }, { code: 'nl-DE', name: 'Duitsland' },
        { code: 'da-DE', name: 'Tyskland' }, { code: 'sv-DE', name: 'Tyskland' },
        { code: 'no-DE', name: 'Tyskland' }, { code: 'fi-DE', name: 'Saksa' },
        { code: 'de-AT', name: 'Österreich' }, { code: 'de-CH', name: 'Schweiz' },
        { code: 'fr-CH', name: 'Suisse' }, { code: 'it-CH', name: 'Svizzera' },
        { code: 'rm-CH', name: 'Svizra' }, { code: 'en-CH', name: 'Switzerland' },
        { code: 'fr-LU', name: 'Luxembourg' }, { code: 'de-LU', name: 'Luxemburg' },
        { code: 'lb-LU', name: 'Lëtzebuerg' }, { code: 'pt-LU', name: 'Luxemburgo' },
        { code: 'fr-BE', name: 'Belgique' }, { code: 'nl-BE', name: 'België' },
        { code: 'de-BE', name: 'Belgien' }, { code: 'wa-BE', name: 'Beldjike' },
        { code: 'fr-NL', name: 'Pays-Bas' }, { code: 'nl-NL', name: 'Nederland' },
        { code: 'fy-NL', name: 'Nederlân' }, { code: 'en-NL', name: 'Netherlands' },
        { code: 'en-GB', name: 'United Kingdom' }, { code: 'cy-GB', name: 'Cymru' },
        { code: 'gd-GB', name: 'Alba' }, { code: 'kw-GB', name: 'Kernow' },
        { code: 'gv-IM', name: 'Ellan Vannin' }, { code: 'en-IE', name: 'Ireland' },
        { code: 'ga-IE', name: 'Éire' }, { code: 'en-US', name: 'United States' },
        { code: 'en-CA', name: 'Canada' }, { code: 'fr-CA', name: 'Canada' },
        { code: 'en-AU', name: 'Australia' }, { code: 'en-NZ', name: 'New Zealand' },
        { code: 'mi-NZ', name: 'Aotearoa' }, { code: 'en-ZA', name: 'South Africa' },
        { code: 'en-BW', name: 'Botswana' }, { code: 'en-NG', name: 'Nigeria' },
        { code: 'en-KE', name: 'Kenya' }, { code: 'en-GH', name: 'Ghana' },
        { code: 'en-SC', name: 'Seychelles' }, { code: 'en-MT', name: 'Malta' },
        { code: 'en-PH', name: 'Pilipinas' }, { code: 'en-IN', name: 'भारत' },
        { code: 'en-PK', name: 'پاکستان' }, { code: 'en-BD', name: 'বাংলাদেশ' },
        { code: 'en-LK', name: 'ශ්‍රී ලංකා' }, { code: 'en-MM', name: 'မြန်မာ' },
        { code: 'en-NP', name: 'नेपाल' }, { code: 'en-FJ', name: 'Fiji' },
        { code: 'en-WS', name: 'Sāmoa' }, { code: 'en-TO', name: 'Tonga' },
        { code: 'en-VU', name: 'Vanuatu' }, { code: 'en-SB', name: 'Solomon Islands' },
        { code: 'en-PG', name: 'Papua New Guinea' }, { code: 'en-KI', name: 'Kiribati' },
        { code: 'en-TV', name: 'Tuvalu' }, { code: 'en-NR', name: 'Nauru' },
        { code: 'en-PW', name: 'Palau' }, { code: 'en-MH', name: 'Marshall Islands' },
        { code: 'en-FM', name: 'Micronesia' }, { code: 'en-KY', name: 'Cayman Islands' },
        { code: 'en-BM', name: 'Bermuda' }, { code: 'en-JM', name: 'Jamaica' },
        { code: 'en-BB', name: 'Barbados' }, { code: 'en-TT', name: 'Trinidad and Tobago' },
        { code: 'en-GD', name: 'Grenada' }, { code: 'en-LC', name: 'Saint Lucia' },
        { code: 'en-VC', name: 'Saint Vincent' }, { code: 'en-AG', name: 'Antigua and Barbuda' },
        { code: 'en-DM', name: 'Dominica' }, { code: 'en-KN', name: 'Saint Kitts and Nevis' },
        { code: 'en-BS', name: 'Bahamas' }, { code: 'en-BZ', name: 'Belize' },
        { code: 'en-GY', name: 'Guyana' }, { code: 'en-SR', name: 'Suriname' },
        { code: 'nl-SR', name: 'Suriname' }, { code: 'fr-GY', name: 'Guyane' },
        { code: 'en-MU', name: 'Mauritius' }, { code: 'fr-MU', name: 'Maurice' },
        { code: 'en-SE', name: 'Sweden' }, { code: 'sv-SE', name: 'Sverige' },
        { code: 'en-NO', name: 'Norway' }, { code: 'no-NO', name: 'Norge' },
        { code: 'nb-NO', name: 'Norge' }, { code: 'nn-NO', name: 'Noreg' },
        { code: 'se-NO', name: 'Norgga' }, { code: 'en-FI', name: 'Finland' },
        { code: 'fi-FI', name: 'Suomi' }, { code: 'sv-FI', name: 'Finland' },
        { code: 'en-DK', name: 'Denmark' }, { code: 'da-DK', name: 'Danmark' },
        { code: 'en-IS', name: 'Iceland' }, { code: 'is-IS', name: 'Ísland' },
        { code: 'en-GL', name: 'Greenland' }, { code: 'kl-GL', name: 'Kalaallit Nunaat' },
        { code: 'da-GL', name: 'Grønland' }, { code: 'en-FO', name: 'Faroe Islands' },
        { code: 'fo-FO', name: 'Føroyar' }, { code: 'en-AX', name: 'Åland Islands' },
        { code: 'sv-AX', name: 'Åland' }, { code: 'en-JE', name: 'Jersey' },
        { code: 'fr-JE', name: 'Jersey' }, { code: 'en-GG', name: 'Guernsey' },
        { code: 'fr-GG', name: 'Guernesey' }, { code: 'en-IM', name: 'Isle of Man' },
        { code: 'gv-IM', name: 'Ellan Vannin' }, { code: 'en-CY', name: 'Cyprus' },
        { code: 'el-CY', name: 'Κύπρος' }, { code: 'tr-CY', name: 'Kıbrıs' },
        { code: 'en-MT', name: 'Malta' }, { code: 'mt-MT', name: 'Malta' },
        { code: 'en-BH', name: 'Bahrain' }, { code: 'ar-BH', name: 'البحرين' },
        { code: 'en-QA', name: 'Qatar' }, { code: 'ar-QA', name: 'قطر' },
        { code: 'en-AE', name: 'United Arab Emirates' }, { code: 'ar-AE', name: 'الإمارات' },
        { code: 'en-OM', name: 'Oman' }, { code: 'ar-OM', name: 'عُمان' },
        { code: 'en-KW', name: 'Kuwait' }, { code: 'ar-KW', name: 'الكويت' },
        { code: 'en-SA', name: 'Saudi Arabia' }, { code: 'ar-SA', name: 'المملكة العربية السعودية' },
        { code: 'en-JO', name: 'Jordan' }, { code: 'ar-JO', name: 'الأردن' },
        { code: 'en-LB', name: 'Lebanon' }, { code: 'ar-LB', name: 'لبنان' },
        { code: 'en-SY', name: 'Syria' }, { code: 'ar-SY', name: 'سوريا' },
        { code: 'en-IQ', name: 'Iraq' }, { code: 'ar-IQ', name: 'العراق' },
        { code: 'ku-IQ', name: 'Iraq' }, { code: 'en-YE', name: 'Yemen' },
        { code: 'ar-YE', name: 'اليمن' }, { code: 'en-EG', name: 'Egypt' },
        { code: 'ar-EG', name: 'مصر' }, { code: 'en-SD', name: 'Sudan' },
        { code: 'ar-SD', name: 'السودان' }, { code: 'en-SS', name: 'South Sudan' },
        { code: 'en-ER', name: 'Eritrea' }, { code: 'ti-ER', name: 'Eritrea' },
        { code: 'ar-ER', name: 'إريتريا' }, { code: 'en-DJ', name: 'Djibouti' },
        { code: 'fr-DJ', name: 'Djibouti' }, { code: 'ar-DJ', name: 'جيبوتي' },
        { code: 'en-SO', name: 'Somalia' }, { code: 'so-SO', name: 'Soomaaliya' },
        { code: 'ar-SO', name: 'الصومال' }, { code: 'en-ET', name: 'Ethiopia' },
        { code: 'am-ET', name: 'ኢትዮጵያ' }, { code: 'om-ET', name: 'Oromiyaa' },
        { code: 'so-ET', name: 'Soomaaliya' }, { code: 'en-KE', name: 'Kenya' },
        { code: 'sw-KE', name: 'Kenya' }, { code: 'en-TZ', name: 'Tanzania' },
        { code: 'sw-TZ', name: 'Tanzania' }, { code: 'en-UG', name: 'Uganda' },
        { code: 'sw-UG', name: 'Uganda' }, { code: 'en-RW', name: 'Rwanda' },
        { code: 'fr-RW', name: 'Rwanda' }, { code: 'en-BI', name: 'Burundi' },
        { code: 'fr-BI', name: 'Burundi' }, { code: 'en-MZ', name: 'Mozambique' },
        { code: 'pt-MZ', name: 'Moçambique' }, { code: 'en-ZW', name: 'Zimbabwe' },
        { code: 'en-ZM', name: 'Zambia' }, { code: 'en-MW', name: 'Malawi' },
        { code: 'en-CD', name: 'DRC' }, { code: 'fr-CD', name: 'RDC' },
        { code: 'en-CG', name: 'Congo' }, { code: 'fr-CG', name: 'Congo' },
        { code: 'en-GA', name: 'Gabon' }, { code: 'fr-GA', name: 'Gabon' },
        { code: 'en-CM', name: 'Cameroon' }, { code: 'fr-CM', name: 'Cameroun' },
        { code: 'en-NG', name: 'Nigeria' }, { code: 'en-GH', name: 'Ghana' },
        { code: 'en-SL', name: 'Sierra Leone' }, { code: 'en-GM', name: 'Gambia' },
        { code: 'en-LR', name: 'Liberia' }, { code: 'en-CI', name: "Côte d'Ivoire" },
        { code: 'fr-CI', name: "Côte d'Ivoire" }, { code: 'en-SN', name: 'Senegal' },
        { code: 'fr-SN', name: 'Sénégal' }, { code: 'en-MR', name: 'Mauritania' },
        { code: 'ar-MR', name: 'موريتانيا' }, { code: 'fr-ML', name: 'Mali' },
        { code: 'en-ML', name: 'Mali' }, { code: 'fr-BF', name: 'Burkina Faso' },
        { code: 'en-BF', name: 'Burkina Faso' }, { code: 'fr-NE', name: 'Niger' },
        { code: 'en-NE', name: 'Niger' }, { code: 'fr-TD', name: 'Tchad' },
        { code: 'ar-TD', name: 'تشاد' }, { code: 'en-SD', name: 'Sudan' },
        { code: 'ar-SD', name: 'السودان' }, { code: 'en-ET', name: 'Ethiopia' },
        { code: 'am-ET', name: 'ኢትዮጵያ' }, { code: 'en-SO', name: 'Somalia' },
        { code: 'so-SO', name: 'Soomaaliya' }, { code: 'en-DJ', name: 'Djibouti' },
        { code: 'fr-DJ', name: 'Djibouti' }, { code: 'en-ER', name: 'Eritrea' },
        { code: 'ti-ER', name: 'Eritrea' }, { code: 'en-SS', name: 'South Sudan' },
        { code: 'ar-SS', name: 'South Sudan' }, { code: 'en-LY', name: 'Libya' },
        { code: 'ar-LY', name: 'ليبيا' }, { code: 'en-TN', name: 'Tunisia' },
        { code: 'ar-TN', name: 'تونس' }, { code: 'en-DZ', name: 'Algeria' },
        { code: 'ar-DZ', name: 'الجزائر' }, { code: 'en-MA', name: 'Morocco' },
        { code: 'ar-MA', name: 'المغرب' }, { code: 'fr-MA', name: 'Maroc' },
        { code: 'en-EG', name: 'Egypt' }, { code: 'ar-EG', name: 'مصر' },
        { code: 'en-IL', name: 'Israel' }, { code: 'he-IL', name: 'ישראל' },
        { code: 'ar-IL', name: 'إسرائيل' }, { code: 'en-PS', name: 'Palestine' },
        { code: 'ar-PS', name: 'فلسطين' }, { code: 'en-SA', name: 'Saudi Arabia' },
        { code: 'ar-SA', name: 'المملكة العربية السعودية' }, { code: 'en-BH', name: 'Bahrain' },
        { code: 'ar-BH', name: 'البحرين' }, { code: 'en-QA', name: 'Qatar' },
        { code: 'ar-QA', name: 'قطر' }, { code: 'en-KW', name: 'Kuwait' },
        { code: 'ar-KW', name: 'الكويت' }, { code: 'en-AE', name: 'United Arab Emirates' },
        { code: 'ar-AE', name: 'الإمارات' }, { code: 'en-OM', name: 'Oman' },
        { code: 'ar-OM', name: 'عُمان' }, { code: 'en-YE', name: 'Yemen' },
        { code: 'ar-YE', name: 'اليمن' }, { code: 'en-JO', name: 'Jordan' },
        { code: 'ar-JO', name: 'الأردن' }, { code: 'en-LB', name: 'Lebanon' },
        { code: 'ar-LB', name: 'لبنان' }, { code: 'en-SY', name: 'Syria' },
        { code: 'ar-SY', name: 'سوريا' }, { code: 'en-IQ', name: 'Iraq' },
        { code: 'ar-IQ', name: 'العراق' }, { code: 'ku-IQ', name: 'Iraq' },
        { code: 'en-IR', name: 'Iran' }, { code: 'fa-IR', name: 'ایران' },
        { code: 'en-AF', name: 'Afghanistan' }, { code: 'fa-AF', name: 'افغانستان' },
        { code: 'ps-AF', name: 'افغانستان' }, { code: 'en-PK', name: 'Pakistan' },
        { code: 'ur-PK', name: 'پاکستان' }, { code: 'en-IN', name: 'India' },
        { code: 'hi-IN', name: 'भारत' }, { code: 'en-BD', name: 'Bangladesh' },
        { code: 'bn-BD', name: 'বাংলাদেশ' }, { code: 'en-LK', name: 'Sri Lanka' },
        { code: 'si-LK', name: 'ශ්‍රී ලංකා' }, { code: 'en-MM', name: 'Myanmar' },
        { code: 'my-MM', name: 'မြန်မာ' }, { code: 'en-NP', name: 'Nepal' },
        { code: 'ne-NP', name: 'नेपाल' }, { code: 'en-BT', name: 'Bhutan' },
        { code: 'dz-BT', name: 'འབྲུག་ཡུལ' }, { code: 'en-MV', name: 'Maldives' },
        { code: 'dv-MV', name: 'ދިވެހިރާއްޖެ' }, { code: 'en-PK', name: 'Pakistan' },
        { code: 'ur-PK', name: 'پاکستان' }, { code: 'en-AF', name: 'Afghanistan' },
        { code: 'fa-AF', name: 'افغانستان' }, { code: 'ps-AF', name: 'افغانستان' },
        { code: 'en-TJ', name: 'Tajikistan' }, { code: 'tg-TJ', name: 'Тоҷикистон' },
        { code: 'ru-TJ', name: 'Тоҷикистон' }, { code: 'en-KG', name: 'Kyrgyzstan' },
        { code: 'ky-KG', name: 'Кыргызстан' }, { code: 'ru-KG', name: 'Кыргызстан' },
        { code: 'en-KZ', name: 'Kazakhstan' }, { code: 'kk-KZ', name: 'Қазақстан' },
        { code: 'ru-KZ', name: 'Қазақстан' }, { code: 'en-UZ', name: 'Uzbekistan' },
        { code: 'uz-UZ', name: "O'zbekiston" }, { code: 'ru-UZ', name: "O'zbekiston" },
        { code: 'en-TM', name: 'Turkmenistan' }, { code: 'tk-TM', name: 'Türkmenistan' },
        { code: 'ru-TM', name: 'Türkmenistan' }, { code: 'en-MN', name: 'Mongolia' },
        { code: 'mn-MN', name: 'Монгол' }, { code: 'ru-MN', name: 'Монгол' },
        { code: 'zh-MN', name: '蒙古' }, { code: 'en-CN', name: '中国' },
        { code: 'zh-CN', name: '中国' }, { code: 'en-HK', name: '香港' },
        { code: 'zh-HK', name: '香港' }, { code: 'en-MO', name: '澳門' },
        { code: 'zh-MO', name: '澳門' }, { code: 'en-TW', name: '台灣' },
        { code: 'zh-TW', name: '台灣' }, { code: 'en-JP', name: '日本' },
        { code: 'ja-JP', name: '日本' }, { code: 'en-KP', name: '북한' },
        { code: 'ko-KP', name: '조선민주주의인민공화국' }, { code: 'en-KR', name: '대한민국' },
        { code: 'ko-KR', name: '대한민국' }, { code: 'en-MN', name: 'Mongolia' },
        { code: 'mn-MN', name: 'Монгол' }
      ];

      const savedRegion = OS.settings.get('region') || navigator.language || 'en-US';
      const currentRegion = REGIONS.find(r => r.code === savedRegion) ? savedRegion : 'en-US';

      const TIMEZONES = [
        'Pacific/Midway','Pacific/Niue','Pacific/Honolulu','Pacific/Rarotonga','Pacific/Tahiti',
        'Pacific/Marquesas','Pacific/Gambier','America/Anchorage','America/Los_Angeles',
        'America/Tijuana','America/Vancouver','America/Phoenix','America/Denver',
        'America/Costa_Rica','America/Chicago','America/Mexico_City','America/Regina',
        'America/Bogota','America/New_York','America/Toronto','America/Caracas',
        'America/Santiago','America/St_Johns','America/Sao_Paulo','America/Argentina/Buenos_Aires',
        'America/Noronha','Atlantic/South_Georgia','Atlantic/Azores','Atlantic/Cape_Verde',
        'Europe/London','Europe/Lisbon','Europe/Dublin','Europe/Edinburgh','Europe/Belfast',
        'Europe/Madrid','Europe/Paris','Europe/Brussels','Europe/Amsterdam','Europe/Rome',
        'Europe/Berlin','Europe/Vienna','Europe/Zurich','Europe/Stockholm','Europe/Oslo',
        'Europe/Copenhagen','Europe/Helsinki','Europe/Warsaw','Europe/Prague','Europe/Budapest',
        'Europe/Athens','Europe/Bucharest','Europe/Kyiv','Europe/Sofia','Europe/Belgrade',
        'Europe/Zagreb','Europe/Tallinn','Europe/Riga','Europe/Vilnius','Europe/Chisinau',
        'Europe/Istanbul','Europe/Minsk','Europe/Kaliningrad','Europe/Moscow','Europe/Volgograd',
        'Europe/Astrakhan','Europe/Saratov','Europe/Ulyanovsk','Europe/Kazan','Europe/Yekaterinburg',
        'Asia/Tehran','Asia/Dubai','Asia/Muscat','Asia/Baku','Asia/Tbilisi','Asia/Yerevan',
        'Asia/Kabul','Asia/Karachi','Asia/Kolkata','Asia/Kathmandu','Asia/Dhaka','Asia/Colombo',
        'Asia/Rangoon','Asia/Bangkok','Asia/Jakarta','Asia/Shanghai','Asia/Hong_Kong',
        'Asia/Taipei','Asia/Manila','Asia/Kuala_Lumpur','Asia/Singapore','Asia/Ho_Chi_Minh',
        'Asia/Phnom_Penh','Asia/Vientiane','Asia/Yangon','Asia/Ulaanbaatar','Asia/Pyongyang',
        'Asia/Seoul','Asia/Tokyo','Asia/Osaka','Asia/Beijing','Asia/Chongqing','Asia/Urumqi',
        'Asia/Kashgar','Asia/Harbin','Asia/Macao','Asia/Makassar','Asia/Dili','Asia/Jayapura',
        'Asia/Sakhalin','Asia/Vladivostok','Asia/Anadyr','Asia/Kamchatka','Asia/Magadan',
        'Asia/Yakutsk','Asia/Irkutsk','Asia/Krasnoyarsk','Asia/Novokuznetsk','Asia/Novosibirsk',
        'Asia/Omsk','Asia/Barnaul','Asia/Tomsk','Asia/Bangkok','Asia/Phnom_Penh','Asia/Vientiane',
        'Asia/Calcutta','Asia/Colombo','Asia/Katmandu','Asia/Kolkata','Asia/Dacca','Asia/Dhaka',
        'Asia/Thimphu','Asia/Thimbu','Asia/Kabul','Asia/Tehran','Asia/Baghdad','Asia/Bahrain',
        'Asia/Kuwait','Asia/Qatar','Asia/Riyadh','Asia/Aden','Asia/Dubai','Asia/Muscat',
        'Asia/Tbilisi','Asia/Yerevan','Asia/Baku','Asia/Dubai','Asia/Muscat','Asia/Kabul',
        'Asia/Karachi','Asia/Kolkata','Asia/Kathmandu','Asia/Dhaka','Asia/Colombo','Asia/Rangoon',
        'Asia/Bangkok','Asia/Jakarta','Asia/Shanghai','Asia/Hong_Kong','Asia/Taipei',
        'Asia/Manila','Asia/Kuala_Lumpur','Asia/Singapore','Asia/Ho_Chi_Minh','Asia/Phnom_Penh',
        'Asia/Vientiane','Asia/Yangon','Asia/Ulaanbaatar','Asia/Pyongyang','Asia/Seoul',
        'Asia/Tokyo','Asia/Osaka','Asia/Beijing','Asia/Chongqing','Asia/Urumqi','Asia/Kashgar',
        'Asia/Harbin','Asia/Macao','Asia/Makassar','Asia/Dili','Asia/Jayapura','Asia/Sakhalin',
        'Asia/Vladivostok','Asia/Anadyr','Asia/Kamchatka','Asia/Magadan','Asia/Yakutsk',
        'Asia/Irkutsk','Asia/Krasnoyarsk','Asia/Novokuznetsk','Asia/Novosibirsk','Asia/Omsk',
        'Asia/Barnaul','Asia/Tomsk','Australia/Perth','Australia/Eucla','Australia/Adelaide',
        'Australia/Darwin','Australia/Brisbane','Australia/Sydney','Australia/Melbourne',
        'Australia/Hobart','Australia/Currie','Australia/Lord_Howe','Australia/Lindeman',
        'Pacific/Guam','Pacific/Port_Moresby','Pacific/Tarawa','Pacific/Majuro','Pacific/Kwajalein',
        'Pacific/Chuuk','Pacific/Pohnpei','Pacific/Kosrae','Pacific/Norfolk','Pacific/Noumea',
        'Pacific/Auckland','Pacific/Fiji','Pacific/Tongatapu','Pacific/Kiritimati','Pacific/Tahiti',
        'Pacific/Marquesas','Pacific/Gambier','Pacific/Rarotonga','Pacific/Niue','Pacific/Midway',
        'Pacific/Honolulu','Pacific/Johnston','Pacific/Rarotonga','Pacific/Tahiti','Pacific/Marquesas',
        'Pacific/Gambier','Pacific/Pago_Pago','Pacific/Apia','Pacific/Midway','Pacific/Niue',
        'Pacific/Honolulu','Pacific/Johnston','Pacific/Rarotonga','Pacific/Tahiti','Pacific/Marquesas',
        'Pacific/Gambier','Pacific/Pago_Pago','Pacific/Apia','Pacific/Norfolk','Pacific/Noumea',
        'Pacific/Auckland','Pacific/Fiji','Pacific/Tongatapu','Pacific/Kiritimati','Pacific/Guadalcanal',
        'Pacific/Pohnpei','Pacific/Chuuk','Pacific/Kosrae','Pacific/Majuro','Pacific/Kwajalein',
        'Pacific/Port_Moresby','Pacific/Tarawa','Pacific/Guam','Pacific/Saipan','Pacific/Palau',
        'Pacific/Yap','Pacific/Truk','Pacific/Ponape','Pacific/Kosrae','Pacific/Majuro',
        'Pacific/Kwajalein','Pacific/Johnston','Pacific/Midway','Pacific/Niue','Pacific/Honolulu',
        'Pacific/Rarotonga','Pacific/Tahiti','Pacific/Marquesas','Pacific/Gambier','Pacific/Pago_Pago',
        'Pacific/Apia','Pacific/Norfolk','Pacific/Noumea','Pacific/Auckland','Pacific/Fiji',
        'Pacific/Tongatapu','Pacific/Kiritimati','Pacific/Guadalcanal','Indian/Maldives',
        'Indian/Mauritius','Indian/Reunion','Indian/Mahe','Indian/Kerguelen','Indian/Cocos',
        'Indian/Christmas','Indian/Chagos','Antarctica/McMurdo','Antarctica/South_Pole',
        'Antarctica/Rothera','Antarctica/Palmer','Antarctica/Syowa','Antarctica/Mawson',
        'Antarctica/Davis','Antarctica/Vostok','Antarctica/Troll','Antarctica/Casey',
        'Antarctica/DumontDUrville','Antarctica/Macquarie','Australia/Perth','Australia/Eucla',
        'Australia/Adelaide','Australia/Darwin','Australia/Brisbane','Australia/Sydney',
        'Australia/Melbourne','Australia/Hobart','Australia/Currie','Australia/Lord_Howe'
      ];

      const savedTimezone = OS.settings.get('timezone') || (typeof Intl !== 'undefined' && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC');
      const currentTimezone = TIMEZONES.includes(savedTimezone) ? savedTimezone : (typeof Intl !== 'undefined' && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC');

      const regionToTimezone = {
        'en-US': 'America/New_York','en-GB': 'Europe/London','en-AU': 'Australia/Sydney',
        'en-CA': 'America/Toronto','fr-FR': 'Europe/Paris','fr-CA': 'America/Montreal',
        'de-DE': 'Europe/Berlin','de-AT': 'Europe/Vienna','de-CH': 'Europe/Zurich',
        'es-ES': 'Europe/Madrid','es-MX': 'America/Mexico_City','pt-BR': 'America/Sao_Paulo',
        'ja-JP': 'Asia/Tokyo','zh-CN': 'Asia/Shanghai','zh-TW': 'Asia/Taipei',
        'ko-KR': 'Asia/Seoul','ru-RU': 'Europe/Moscow','it-IT': 'Europe/Rome',
        'nl-NL': 'Europe/Amsterdam','pl-PL': 'Europe/Warsaw','tr-TR': 'Europe/Istanbul',
        'ar-SA': 'Asia/Riyadh','he-IL': 'Asia/Jerusalem','hi-IN': 'Asia/Kolkata',
        'th-TH': 'Asia/Bangkok','vi-VN': 'Asia/Ho_Chi_Minh','id-ID': 'Asia/Jakarta',
        'ms-MY': 'Asia/Kuala_Lumpur','en-IN': 'Asia/Kolkata','en-PK': 'Asia/Karachi',
        'en-BD': 'Asia/Dhaka','en-LK': 'Asia/Colombo','en-MM': 'Asia/Yangon',
        'en-NP': 'Asia/Kathmandu','en-PH': 'Asia/Manila','en-ID': 'Asia/Jakarta',
        'en-MY': 'Asia/Kuala_Lumpur','en-SG': 'Asia/Singapore','en-HK': 'Asia/Hong_Kong',
        'en-MO': 'Asia/Macao','en-TW': 'Asia/Taipei','en-JP': 'Asia/Tokyo',
        'en-KR': 'Asia/Seoul','en-KP': 'Asia/Pyongyang','en-NZ': 'Pacific/Auckland',
        'en-ZA': 'Africa/Johannesburg','en-IE': 'Europe/Dublin','en-IL': 'Asia/Jerusalem',
        'ar-EG': 'Africa/Cairo','ar-AE': 'Asia/Dubai','ar-QA': 'Asia/Qatar',
        'ar-KW': 'Asia/Kuwait','ar-BH': 'Asia/Bahrain','ar-OM': 'Asia/Muscat',
        'ar-YE': 'Asia/Aden','ar-JO': 'Asia/Amman','ar-LB': 'Asia/Beirut',
        'ar-SY': 'Asia/Damascus','ar-IQ': 'Asia/Baghdad','ar-IL': 'Asia/Jerusalem',
        'ar-PS': 'Asia/Gaza','ar-SA': 'Asia/Riyadh','ar-MA': 'Africa/Casablanca',
        'ar-DZ': 'Africa/Algiers','ar-TN': 'Africa/Tunis','ar-LY': 'Africa/Tripoli',
        'ar-SD': 'Africa/Khartoum','ar-SO': 'Africa/Mogadishu','ar-DJ': 'Africa/Djibouti',
        'ar-ER': 'Africa/Asmara','ar-ET': 'Africa/Addis_Ababa','ar-KE': 'Africa/Nairobi',
        'ar-TZ': 'Africa/Dar_es_Salaam','ar-UG': 'Africa/Kampala','ar-RW': 'Africa/Kigali',
        'ar-BI': 'Africa/Bujumbura','ar-MZ': 'Africa/Maputo','ar-ZW': 'Africa/Harare',
        'ar-ZM': 'Africa/Lusaka','ar-MW': 'Africa/Blantyre','ar-CD': 'Africa/Kinshasa',
        'ar-CG': 'Africa/Brazzaville','ar-GA': 'Africa/Libreville','ar-CM': 'Africa/Douala',
        'ar-NG': 'Africa/Lagos','ar-GH': 'Africa/Accra','ar-SL': 'Africa/Freetown',
        'ar-GM': 'Africa/Banjul','ar-LR': 'Africa/Monrovia','ar-CI': 'Africa/Abidjan',
        'ar-SN': 'Africa/Dakar','ar-MR': 'Africa/Nouakchott','ar-ML': 'Africa/Bamako',
        'ar-BF': 'Africa/Ouagadougou','ar-NE': 'Africa/Niamey','ar-TD': 'Africa/Ndjamena',
        'ar-SS': 'Africa/Juba','fa-IR': 'Asia/Tehran','fa-AF': 'Asia/Kabul',
        'ps-AF': 'Asia/Kabul','tk-TM': 'Asia/Ashgabat','uz-UZ': 'Asia/Tashkent',
        'kk-KZ': 'Asia/Almaty','ky-KG': 'Asia/Bishkek','tg-TJ': 'Asia/Dushanbe',
        'ru-RU': 'Europe/Moscow','ru-KZ': 'Asia/Almaty','ru-KG': 'Asia/Bishkek',
        'ru-TJ': 'Asia/Dushanbe','ru-TM': 'Asia/Ashgabat','ru-UZ': 'Asia/Tashkent',
        'ru-UA': 'Europe/Kyiv','ru-BY': 'Europe/Minsk','ru-MD': 'Europe/Chisinau',
        'ru-AM': 'Asia/Yerevan','ru-GE': 'Asia/Tbilisi','ru-AZ': 'Asia/Baku',
        'hy-AM': 'Asia/Yerevan','ka-GE': 'Asia/Tbilisi','az-AZ': 'Asia/Baku',
        'et-EE': 'Europe/Tallinn','lv-LV': 'Europe/Riga','lt-LT': 'Europe/Vilnius',
        'pl-PL': 'Europe/Warsaw','cs-CZ': 'Europe/Prague','sk-SK': 'Europe/Bratislava',
        'hu-HU': 'Europe/Budapest','ro-RO': 'Europe/Bucharest','bg-BG': 'Europe/Sofia',
        'hr-HR': 'Europe/Zagreb','sr-RS': 'Europe/Belgrade','mk-MK': 'Europe/Skopje',
        'sl-SI': 'Europe/Ljubljana','al-AL': 'Europe/Tirana','gr-GR': 'Europe/Athens',
        'cy-CY': 'Asia/Nicosia','tr-CY': 'Asia/Nicosia','mt-MT': 'Europe/Malta',
        'is-IS': 'Atlantic/Reykjavik','fo-FO': 'Atlantic/Faroe','gl-ES': 'Atlantic/Canary',
        'pt-PT': 'Europe/Lisbon','en-GB': 'Europe/London','ga-IE': 'Europe/Dublin',
        'cy-GB': 'Europe/London','gd-GB': 'Europe/London','kw-GB': 'Europe/London',
        'gv-IM': 'Europe/Isle_of_Man','en-JE': 'Europe/Jersey','en-GG': 'Europe/Guernsey',
        'en-IM': 'Europe/Isle_of_Man','en-CY': 'Asia/Nicosia','el-CY': 'Asia/Nicosia',
        'tr-CY': 'Asia/Nicosia','en-MT': 'Europe/Malta','mt-MT': 'Europe/Malta',
        'en-BH': 'Asia/Bahrain','ar-BH': 'Asia/Bahrain','en-QA': 'Asia/Qatar',
        'ar-QA': 'Asia/Qatar','en-AE': 'Asia/Dubai','ar-AE': 'Asia/Dubai',
        'en-OM': 'Asia/Muscat','ar-OM': 'Asia/Muscat','en-KW': 'Asia/Kuwait',
        'ar-KW': 'Asia/Kuwait','en-SA': 'Asia/Riyadh','ar-SA': 'Asia/Riyadh',
        'en-JO': 'Asia/Amman','ar-JO': 'Asia/Amman','en-LB': 'Asia/Beirut',
        'ar-LB': 'Asia/Beirut','en-SY': 'Asia/Damascus','ar-SY': 'Asia/Damascus',
        'en-IQ': 'Asia/Baghdad','ar-IQ': 'Asia/Baghdad','en-YE': 'Asia/Aden',
        'ar-YE': 'Asia/Aden','en-EG': 'Africa/Cairo','ar-EG': 'Africa/Cairo',
        'en-SD': 'Africa/Khartoum','ar-SD': 'Africa/Khartoum','en-SS': 'Africa/Juba',
        'ar-SS': 'Africa/Juba','en-ER': 'Africa/Asmara','ar-ER': 'Africa/Asmara',
        'en-DJ': 'Africa/Djibouti','ar-DJ': 'Africa/Djibouti','en-SO': 'Africa/Mogadishu',
        'ar-SO': 'Africa/Mogadishu','en-ET': 'Africa/Addis_Ababa','am-ET': 'Africa/Addis_Ababa',
        'en-KE': 'Africa/Nairobi','sw-KE': 'Africa/Nairobi','en-TZ': 'Africa/Dar_es_Salaam',
        'sw-TZ': 'Africa/Dar_es_Salaam','en-UG': 'Africa/Kampala','sw-UG': 'Africa/Kampala',
        'en-RW': 'Africa/Kigali','fr-RW': 'Africa/Kigali','en-BI': 'Africa/Bujumbura',
        'fr-BI': 'Africa/Bujumbura','en-MZ': 'Africa/Maputo','pt-MZ': 'Africa/Maputo',
        'en-ZW': 'Africa/Harare','en-ZM': 'Africa/Lusaka','en-MW': 'Africa/Blantyre',
        'en-CD': 'Africa/Kinshasa','fr-CD': 'Africa/Kinshasa','en-CG': 'Africa/Brazzaville',
        'fr-CG': 'Africa/Brazzaville','en-GA': 'Africa/Libreville','fr-GA': 'Africa/Libreville',
        'en-CM': 'Africa/Douala','fr-CM': 'Africa/Douala','en-NG': 'Africa/Lagos',
        'en-GH': 'Africa/Accra','en-SL': 'Africa/Freetown','en-GM': 'Africa/Banjul',
        'en-LR': 'Africa/Monrovia','en-CI': 'Africa/Abidjan','fr-CI': 'Africa/Abidjan',
        'en-SN': 'Africa/Dakar','fr-SN': 'Africa/Dakar','en-MR': 'Africa/Nouakchott',
        'ar-MR': 'Africa/Nouakchott','fr-ML': 'Africa/Bamako','en-ML': 'Africa/Bamako',
        'fr-BF': 'Africa/Ouagadougou','en-BF': 'Africa/Ouagadougou','fr-NE': 'Africa/Niamey',
        'en-NE': 'Africa/Niamey','fr-TD': 'Africa/Ndjamena','ar-TD': 'Africa/Ndjamena',
        'en-LY': 'Africa/Tripoli','ar-LY': 'Africa/Tripoli','en-TN': 'Africa/Tunis',
        'ar-TN': 'Africa/Tunis','en-DZ': 'Africa/Algiers','ar-DZ': 'Africa/Algiers',
        'en-MA': 'Africa/Casablanca','ar-MA': 'Africa/Casablanca','fr-MA': 'Africa/Casablanca',
        'en-EG': 'Africa/Cairo','ar-EG': 'Africa/Cairo','en-IL': 'Asia/Jerusalem',
        'he-IL': 'Asia/Jerusalem','ar-IL': 'Asia/Jerusalem','en-PS': 'Asia/Gaza',
        'ar-PS': 'Asia/Gaza','en-SA': 'Asia/Riyadh','ar-SA': 'Asia/Riyadh',
        'en-BH': 'Asia/Bahrain','ar-BH': 'Asia/Bahrain','en-QA': 'Asia/Qatar',
        'ar-QA': 'Asia/Qatar','en-KW': 'Asia/Kuwait','ar-KW': 'Asia/Kuwait',
        'en-AE': 'Asia/Dubai','ar-AE': 'Asia/Dubai','en-OM': 'Asia/Muscat',
        'ar-OM': 'Asia/Muscat','en-AF': 'Asia/Kabul','fa-AF': 'Asia/Kabul',
        'ps-AF': 'Asia/Kabul','en-PK': 'Asia/Karachi','ur-PK': 'Asia/Karachi',
        'en-IN': 'Asia/Kolkata','hi-IN': 'Asia/Kolkata','en-BD': 'Asia/Dhaka',
        'bn-BD': 'Asia/Dhaka','en-LK': 'Asia/Colombo','si-LK': 'Asia/Colombo',
        'en-MM': 'Asia/Yangon','my-MM': 'Asia/Yangon','en-NP': 'Asia/Kathmandu',
        'ne-NP': 'Asia/Kathmandu','en-BT': 'Asia/Thimphu','dz-BT': 'Asia/Thimphu',
        'en-MV': 'Indian/Maldives','dv-MV': 'Indian/Maldives','en-PH': 'Asia/Manila',
        'fil-PH': 'Asia/Manila','en-ID': 'Asia/Jakarta','id-ID': 'Asia/Jakarta',
        'en-MY': 'Asia/Kuala_Lumpur','ms-MY': 'Asia/Kuala_Lumpur','en-SG': 'Asia/Singapore',
        'en-HK': 'Asia/Hong_Kong','zh-HK': 'Asia/Hong_Kong','en-MO': 'Asia/Macao',
        'zh-MO': 'Asia/Macao','en-TW': 'Asia/Taipei','zh-TW': 'Asia/Taipei',
        'en-JP': 'Asia/Tokyo','ja-JP': 'Asia/Tokyo','en-KP': 'Asia/Pyongyang',
        'ko-KP': 'Asia/Pyongyang','en-KR': 'Asia/Seoul','ko-KR': 'Asia/Seoul',
        'en-MN': 'Asia/Ulaanbaatar','mn-MN': 'Asia/Ulaanbaatar','zh-CN': 'Asia/Shanghai',
        'zh-MN': 'Asia/Shanghai','en-CN': 'Asia/Shanghai','bo-CN': 'Asia/Shanghai',
        'en-AU': 'Australia/Sydney','en-NZ': 'Pacific/Auckland','mi-NZ': 'Pacific/Auckland',
        'en-FJ': 'Pacific/Fiji','en-WS': 'Pacific/Apia','en-TO': 'Pacific/Tongatapu',
        'en-VU': 'Pacific/Efate','en-SB': 'Pacific/Guadalcanal','en-PG': 'Pacific/Port_Moresby',
        'en-KI': 'Pacific/Tarawa','en-TV': 'Pacific/Funafuti','en-NR': 'Pacific/Nauru',
        'en-PW': 'Pacific/Palau','en-MH': 'Pacific/Majuro','en-FM': 'Pacific/Chuuk',
        'en-KY': 'America/New_York','en-BM': 'Atlantic/Bermuda','en-JM': 'America/Jamaica',
        'en-BB': 'America/Barbados','en-TT': 'America/Port_of_Spain','en-GD': 'America/Grenada',
        'en-LC': 'America/St_Lucia','en-VC': 'America/St_Vincent','en-AG': 'America/Antigua',
        'en-DM': 'America/Dominica','en-KN': 'America/St_Kitts','en-BS': 'America/Nassau',
        'en-BZ': 'America/Belize','en-GY': 'America/Guyana','en-SR': 'America/Paramaribo',
        'en-MU': 'Indian/Mauritius','fr-MU': 'Indian/Mauritius','en-SC': 'Indian/Mahe',
        'en-SE': 'Europe/Stockholm','sv-SE': 'Europe/Stockholm','en-NO': 'Europe/Oslo',
        'no-NO': 'Europe/Oslo','nb-NO': 'Europe/Oslo','nn-NO': 'Europe/Oslo',
        'se-NO': 'Europe/Oslo','en-FI': 'Europe/Helsinki','fi-FI': 'Europe/Helsinki',
        'sv-FI': 'Europe/Helsinki','en-DK': 'Europe/Copenhagen','da-DK': 'Europe/Copenhagen',
        'en-IS': 'Atlantic/Reykjavik','is-IS': 'Atlantic/Reykjavik','en-GL': 'America/Godthab',
        'kl-GL': 'America/Godthab','da-GL': 'America/Godthab','en-FO': 'Atlantic/Faroe',
        'fo-FO': 'Atlantic/Faroe','en-AX': 'Europe/Helsinki','sv-AX': 'Europe/Helsinki',
        'en-JE': 'Europe/Jersey','fr-JE': 'Europe/Jersey','en-GG': 'Europe/Guernsey',
        'fr-GG': 'Europe/Guernsey','en-IM': 'Europe/Isle_of_Man','gv-IM': 'Europe/Isle_of_Man'
      };

      const regionGroup = createEl('div', { className: 'nook-group' });
      regionGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Region' }));

      const regionRow = createEl('div', { className: 'nook-row' });
      regionRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Date & Currency Format' }));

      const regionSelect = document.createElement('select');
      regionSelect.className = 'input';
      for (const r of REGIONS) {
        const opt = document.createElement('option');
        opt.value = r.code;
        opt.textContent = r.name;
        if (r.code === currentRegion) opt.selected = true;
        regionSelect.appendChild(opt);
      }
      regionRow.appendChild(regionSelect);
      regionGroup.appendChild(regionRow);
      mainContent.appendChild(regionGroup);

      const timezoneSelect = document.createElement('select');
      timezoneSelect.className = 'input';
      for (const tz of TIMEZONES) {
        const opt = document.createElement('option');
        opt.value = tz;
        opt.textContent = tz;
        if (tz === currentTimezone) opt.selected = true;
        timezoneSelect.appendChild(opt);
      }
      timezoneSelect.addEventListener('change', () => {
        OS.settings.set('timezone', timezoneSelect.value);
        renderContent();
      });

      const timezoneGroup = createEl('div', { className: 'nook-group' });
      timezoneGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Timezone' }));
      const timezoneRow = createEl('div', { className: 'nook-row' });
      timezoneRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Current Timezone' }));
      timezoneRow.appendChild(timezoneSelect);
      timezoneGroup.appendChild(timezoneRow);
      mainContent.appendChild(timezoneGroup);

      regionSelect.addEventListener('change', async () => {
        const selected = regionSelect.value;
        OS.settings.set('region', selected);
        const mappedTz = regionToTimezone[selected];
        if (mappedTz && TIMEZONES.includes(mappedTz)) {
          OS.settings.set('timezone', mappedTz);
          timezoneSelect.value = mappedTz;
        }
        if (i18n) {
          try { await i18n.changeLanguage(selected); } catch (err) { console.warn('[Settings] i18next changeLanguage failed:', err); }
        }
        try { document.documentElement.lang = selected; } catch {}
        renderContent();
      });

      const kbGroup = createEl('div', { className: 'nook-group' });
      kbGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Keyboard Layout' }));

      const kbRow = createEl('div', { className: 'nook-row' });
      kbRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Detected Layout' }));
      const kbValue = createEl('span', { style: 'color:var(--text-primary);font-weight:500;', textContent: 'Detecting...' });
      kbRow.appendChild(kbValue);
      kbGroup.appendChild(kbRow);
      mainContent.appendChild(kbGroup);

      const previewGroup = createEl('div', { className: 'nook-group' });
      previewGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Live Preview' }));
      const previewRow = createEl('div', { style: 'padding:12px 0;font-size:12.5px;color:var(--text-secondary);', id: 'region-preview' });
      previewGroup.appendChild(previewRow);
      mainContent.appendChild(previewGroup);

      function getEffectiveLocale() {
        if (i18n && typeof i18n.language === 'string' && i18n.language) return i18n.language;
        return OS.settings.get('region') || navigator.language || 'en-US';
      }

      function updatePreview(region, timezone) {
        const previewEl = document.getElementById('region-preview');
        if (!previewEl) return;
        const now = new Date();
        const locale = getEffectiveLocale();
        const tz = timezone || OS.settings.get('timezone');
        const opts = { dateStyle: 'full', timeStyle: 'long' };
        if (tz) opts.timeZone = tz;
        const dateStr = new Intl.DateTimeFormat(locale, opts).format(now);
        const currencyStr = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(1234.56);
        previewEl.innerHTML = '<div style="margin-bottom:8px;"><strong>Date & Time:</strong> ' + dateStr + '</div>' +
                              '<div><strong>Currency:</strong> ' + currencyStr + '</div>';
      }

      if (navigator.keyboard && typeof navigator.keyboard.getLayoutMap === 'function') {
        navigator.keyboard.getLayoutMap().then(map => {
          const a = map.get('KeyA');
          const q = map.get('KeyQ');
          let layout = 'Unknown';
          if (a === 'a' && q === 'q') layout = 'QWERTY';
          else if (a === 'q' && q === 'a') layout = 'AZERTY';
          else if (a === 'a' && q === 'w') layout = 'QWERTZ';
          else if (a) layout = 'Custom (' + a + ')';
          kbValue.textContent = layout;
        }).catch(() => { kbValue.textContent = 'Not available'; });
      } else {
        kbValue.textContent = 'Not supported';
      }

      updatePreview(currentRegion);
    }

    // ── Storage ─────────────────────────────────────────────────────────────
    async function renderStorage() {
      mainContent.appendChild(createEl('h2', { textContent: 'Storage', style: { marginBottom: '20px' } }));

      try {
        const est = await navigator.storage.estimate();

        const usageGroup = createEl('div', { className: 'nook-group' });
        usageGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Storage Usage' }));

        const usedRow = createEl('div', { className: 'nook-row' });
        usedRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Used' }));
        usedRow.appendChild(createEl('span', { textContent: formatBytes(est.usage || 0) }));
        usageGroup.appendChild(usedRow);

        const quotaRow = createEl('div', { className: 'nook-row' });
        quotaRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Quota' }));
        quotaRow.appendChild(createEl('span', { textContent: formatBytes(est.quota || 0) }));
        usageGroup.appendChild(quotaRow);

        const bar  = createEl('div', { className: 'lens-bar' });
        const fill = createEl('div', { className: 'lens-bar-fill', style: { width: ((est.usage || 0) / (est.quota || 1) * 100) + '%' } });
        bar.appendChild(fill);
        usageGroup.appendChild(bar);
        mainContent.appendChild(usageGroup);
      } catch {
        mainContent.appendChild(createEl('p', { textContent: 'Unable to retrieve storage information.' }));
      }

      // Clear data buttons
      const clearGroup = createEl('div', { className: 'nook-group' });
      clearGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Clear Data' }));

      const clearCacheBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Clear Cache' });
      clearCacheBtn.addEventListener('click', async () => {
        const cleared = [];

        if ('caches' in window) {
          try {
            const cacheNames = await caches.keys();
            if (cacheNames.length) {
              await Promise.all(cacheNames.map(n => caches.delete(n)));
              cleared.push(cacheNames.length + ' SW cache' + (cacheNames.length > 1 ? 's' : ''));
            }
          } catch { /* SW caches not available */ }
        }

        try {
          const tempKeys = Object.keys(localStorage).filter(k =>
            k.includes('_cache') || k.includes('_temp') ||
            k === 'nova_boot_attempts' || k === 'nova_force_recovery'
          );
          if (tempKeys.length) {
            for (const k of tempKeys) localStorage.removeItem(k);
            cleared.push(tempKeys.length + ' temp key' + (tempKeys.length > 1 ? 's' : ''));
          }
        } catch { /* localStorage blocked */ }

        if (cleared.length) {
          Notify.show({ title: 'Cache Cleared', body: 'Removed: ' + cleared.join(', '), type: 'success', appName: 'Settings' });
        } else {
          Notify.show({ title: 'Nothing to Clear', body: 'Cache is already empty', type: 'info', appName: 'Settings' });
        }
      });
      clearGroup.appendChild(clearCacheBtn);

      const wipeBtn = createEl('button', { className: 'btn btn-danger btn-sm', style: { marginLeft: '8px' }, textContent: 'Wipe All Data' });
      wipeBtn.addEventListener('click', async () => {
        const wipeConfirm = await showModal('Wipe All Data', 'This will delete all files, settings, and data. This action cannot be undone.', [
          { label: 'Cancel' }, { label: 'Wipe Everything', danger: true, value: 'wipe' }
        ]);
        if (wipeConfirm === 'wipe') {
          Notify.show({ title: 'Wiping Data', body: 'Please wait...', type: 'warning', appName: 'Settings' });
          localStorage.clear();
          sessionStorage.clear();
          // Delete IndexedDB databases sequentially
          for (const dbName of ['NovaByte_FS', 'novabyte_opfs_fallback']) {
            await new Promise(resolve => {
              const req = indexedDB.deleteDatabase(dbName);
              req.onsuccess = req.onerror = req.onblocked = () => resolve();
            });
          }
          try {
            if (typeof OPFS !== 'undefined' && OPFS.clear) await OPFS.clear();
          } catch { /* OPFS unavailable */ }
          location.reload();
        }
      });
      clearGroup.appendChild(wipeBtn);
      mainContent.appendChild(clearGroup);
    }

    // ── Desktop ─────────────────────────────────────────────────────────────
    function renderDesktop() {
      mainContent.appendChild(createEl('h2', { textContent: 'Desktop', style: { marginBottom: '20px' } }));

      // Wallpaper
      const wallpaperGroup = createEl('div', { className: 'nook-group' });
      wallpaperGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Wallpaper' }));

      const presetRow = createEl('div', { className: 'nook-row' });
      presetRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Preset Wallpapers' }));
      const presetContainer = createEl('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;' });

      const savedWallpaperId = OS.settings.get('wallpaperId');
      const currentWallpaperId = PRESET_WALLPAPERS.some(wp => wp.id === savedWallpaperId)
        ? savedWallpaperId : 'stock-blue';

      // Keep direct references to cards for O(1) updates (no querySelectorAll on click)
      const wpCards = [];

      PRESET_WALLPAPERS.forEach((wp, idx) => {
        const wpCard = createEl('div', {
          style: `width:64px;height:48px;border-radius:6px;cursor:pointer;border:2px solid transparent;background:${wp.gradient};transition:all 0.15s;${currentWallpaperId === wp.id ? 'border-color:var(--accent);box-shadow:0 0 0 2px var(--window-bg), 0 0 8px var(--accent);' : 'opacity:0.7;'}`
        });
        wpCard.title = wp.name;
        wpCard.addEventListener('click', () => {
          const desktop = document.getElementById('desktop');
          if (desktop) desktop.style.backgroundImage = wp.gradient;
          OS.settings.set('wallpaperId', wp.id);
          OS.settings.set('customWallpaper', null);
          wallpaperInput.value = '';
          // Update cards via pre-built reference array — O(1) per card, no DOM query
          for (let i = 0; i < wpCards.length; i++) {
            if (i === idx) {
              wpCards[i].style.borderColor = 'var(--accent)';
              wpCards[i].style.boxShadow   = '0 0 0 2px var(--window-bg), 0 0 8px var(--accent)';
              wpCards[i].style.opacity     = '1';
            } else {
              wpCards[i].style.borderColor = 'transparent';
              wpCards[i].style.boxShadow   = 'none';
              wpCards[i].style.opacity     = '0.7';
            }
          }
          Notify.show({ title: 'Wallpaper Changed', body: 'Applied ' + wp.name, type: 'success', appName: 'Settings' });
        });
        wpCards.push(wpCard);
        presetContainer.appendChild(wpCard);
      });

      presetRow.appendChild(presetContainer);
      wallpaperGroup.appendChild(presetRow);

      // Apply current wallpaper on render
      const desktopEl = document.getElementById('desktop');
      if (desktopEl) {
        desktopEl.style.backgroundImage = '';
        desktopEl.style.backgroundSize = '';
        desktopEl.style.backgroundPosition = '';
        desktopEl.style.backgroundRepeat = '';
        const customWallpaper = OS.settings.get('customWallpaper');
        if (customWallpaper) {
          desktopEl.style.backgroundImage   = 'url(' + customWallpaper + ')';
          desktopEl.style.backgroundSize    = 'cover';
          desktopEl.style.backgroundPosition = 'center';
          desktopEl.style.backgroundRepeat  = 'no-repeat';
        } else {
          const currentWp = PRESET_WALLPAPERS.find(wp => wp.id === currentWallpaperId);
          if (currentWp) desktopEl.style.backgroundImage = currentWp.gradient;
        }
      }

      const wallpaperRow = createEl('div', { className: 'nook-row', style: 'margin-top:16px;' });
      wallpaperRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Custom Image' }));

      const wallpaperInput = createEl('input', {
        id: 'wallpaper-upload', name: 'wallpaper-upload', type: 'file', accept: 'image/*', style: { width: '200px' }
      });
      wallpaperInput.addEventListener('change', () => {
        const file = wallpaperInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          const desktop = document.getElementById('desktop');
          if (desktop) {
            desktop.style.backgroundImage    = 'url(' + dataUrl + ')';
            desktop.style.backgroundSize     = 'cover';
            desktop.style.backgroundPosition = 'center';
            desktop.style.backgroundRepeat   = 'no-repeat';
          }
          OS.settings.set('customWallpaper', dataUrl);
          OS.settings.set('wallpaperId', null);
          Notify.show({ title: 'Wallpaper Changed', body: 'Custom wallpaper applied', type: 'success', appName: 'Settings' });
        };
        reader.readAsDataURL(file);
      });
      wallpaperRow.appendChild(wallpaperInput);

      const resetBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Reset to Default', style: { marginLeft: '8px' } });
      resetBtn.addEventListener('click', () => {
        const desktop = document.getElementById('desktop');
        if (desktop) {
          desktop.style.backgroundImage   = PRESET_WALLPAPERS[0].gradient;
          desktop.style.backgroundSize    = '';
          desktop.style.backgroundPosition = '';
          desktop.style.backgroundRepeat  = '';
        }
        OS.settings.set('customWallpaper', null);
        OS.settings.set('wallpaperId', 'stock-blue');
        wallpaperInput.value = '';
        for (let i = 0; i < wpCards.length; i++) {
          if (i === 0) {
            wpCards[i].style.borderColor = 'var(--accent)';
            wpCards[i].style.boxShadow   = '0 0 0 2px var(--window-bg), 0 0 8px var(--accent)';
            wpCards[i].style.opacity     = '1';
          } else {
            wpCards[i].style.borderColor = 'transparent';
            wpCards[i].style.boxShadow   = 'none';
            wpCards[i].style.opacity     = '0.7';
          }
        }
        Notify.show({ title: 'Wallpaper Reset', body: 'Default wallpaper restored', type: 'success', appName: 'Settings' });
      });
      wallpaperRow.appendChild(resetBtn);
      wallpaperGroup.appendChild(wallpaperRow);
      mainContent.appendChild(wallpaperGroup);

      // Taskbar group
      const clockGroup = createEl('div', { className: 'nook-group' });
      clockGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Taskbar' }));

      const clockRow = createEl('div', { className: 'nook-toggle-row' });
      clockRow.appendChild(createEl('span', { textContent: 'Show Clock in Taskbar' }));
      const clockToggle = createEl('button', {
        className: 'toggle' + (OS.settings.get('showTaskbarClock') !== false ? ' active' : '')
      });
      clockToggle.addEventListener('click', () => {
        const nowVisible = OS.settings.get('showTaskbarClock') !== false;
        OS.settings.set('showTaskbarClock', !nowVisible);
        clockToggle.classList.toggle('active', !nowVisible);
        const clockEl = document.getElementById('tray-clock');
        if (clockEl) clockEl.style.display = nowVisible ? 'none' : 'flex';
      });
      clockRow.appendChild(clockToggle);
      clockGroup.appendChild(clockRow);

      // Taskbar size — FIX: sizeRow was created and populated but never appended in original
      const sizeRow = createEl('div', { className: 'nook-row' });
      sizeRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Size' }));
      const currentSize = OS.settings.get('taskbarSize') || 'normal';
      for (const sz of TASKBAR_SIZES) {
        const btn = createEl('button', {
          className: 'btn btn-sm' + (currentSize === sz.value ? ' btn-primary' : ''),
          textContent: sz.label, style: { marginRight: '8px' }
        });
        btn.addEventListener('click', () => {
          OS.settings.set('taskbarSize', sz.value);
          document.documentElement.style.setProperty('--taskbar-height', sz.height);
          renderContent();
        });
        sizeRow.appendChild(btn);
      }
      clockGroup.appendChild(sizeRow); // FIX: this line was missing — size buttons were invisible

      mainContent.appendChild(clockGroup);
    }

    // ── Accessibility ───────────────────────────────────────────────────────
    function renderAccessibility() {
      mainContent.appendChild(createEl('h2', { textContent: 'Accessibility', style: { marginBottom: '20px' } }));

      // Reduce Motion
      const motionGroup = createEl('div', { className: 'nook-group' });
      motionGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Motion' }));
      const motionRow = createEl('div', { className: 'nook-toggle-row' });
      motionRow.appendChild(createEl('span', { textContent: 'Reduce Motion' }));
      const motionToggle = createEl('button', {
        className: 'toggle' + (OS.settings.get('reduceMotion') ? ' active' : '')
      });
      motionToggle.addEventListener('click', () => {
        const next = !OS.settings.get('reduceMotion');
        OS.settings.set('reduceMotion', next);
        document.documentElement.classList.toggle('reduce-motion', next);
        document.documentElement.style.setProperty('--anim-speed', next ? '0.001' : '1');
        // FIX: single getElementById call; correct animation state applied (original had duplicate
        // call that always set 'none' regardless of direction)
        const wallpaperEl = document.getElementById('wallpaper');
        if (wallpaperEl) wallpaperEl.style.animation = next ? 'none' : '';
        motionToggle.classList.toggle('active', next);
      });
      motionRow.appendChild(motionToggle);
      motionGroup.appendChild(motionRow);
      mainContent.appendChild(motionGroup);

      // Icon Size
      const iconSizeGroup = createEl('div', { className: 'nook-group' });
      iconSizeGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Icon Size' }));
      const currentIconSize = OS.settings.get('cursorSize') || 'normal'; // read once outside loop
      for (const opt of ICON_SIZES) {
        const row = createEl('div', { className: 'nook-row' });
        row.appendChild(createEl('span', { textContent: opt.label }));
        const btn = createEl('button', {
          className: 'btn btn-sm' + (currentIconSize === opt.value ? ' btn-primary' : ''),
          textContent: currentIconSize === opt.value ? 'Active' : 'Select'
        });
        btn.addEventListener('click', () => {
          OS.settings.set('cursorSize', opt.value);
          const cursorStyles = document.getElementById('cursor-custom-styles') || (() => {
            const s = document.createElement('style');
            s.id = 'cursor-custom-styles';
            document.head.appendChild(s);
            return s;
          })();
          cursorStyles.textContent = `#desktop .desktop-icon { transform: ${opt.transform} }`;
          renderContent();
        });
        row.appendChild(btn);
        iconSizeGroup.appendChild(row);
      }
      mainContent.appendChild(iconSizeGroup);
    }

    // ── Apps ────────────────────────────────────────────────────────────────
    function renderApps() {
      mainContent.appendChild(createEl('h2', { textContent: 'App Permissions', style: { marginBottom: '4px' } }));
      mainContent.appendChild(createEl('p', {
        textContent: 'Manage what each app is allowed to access. Denied permissions can be re-enabled here.',
        style: { color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '20px' }
      }));

      const mgr  = typeof AppPermissionManager !== 'undefined' ? AppPermissionManager : null;
      const pmap = typeof AppPermissionsMap    !== 'undefined' ? AppPermissionsMap    : null;

      if (!mgr || !pmap) {
        const warn = createEl('div', { style: 'padding:16px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);font-size:13px;' });
        warn.textContent = 'Permission system not available.';
        mainContent.appendChild(warn);
        return;
      }

      const appIds = new Set(Object.keys(pmap));
      if (typeof OS !== 'undefined' && OS.apps) {
        for (const id of Object.keys(OS.apps)) {
          if (id.startsWith('wa_')) appIds.add(id);
        }
      }

      let novaApps = [];
      try { novaApps = JSON.parse(localStorage.getItem('nova_installed_apps') || '[]'); } catch { novaApps = []; }
      const novaAppIds = new Set(novaApps.map(a => a.id));

      const builtIns = [...appIds].filter(id => !id.startsWith('wa_') && !novaAppIds.has(id)).sort();
      const webApps  = [...appIds].filter(id =>  id.startsWith('wa_')).sort();

      const devMode = OS.settings.get('devMode');
      const visibleBuiltIns = builtIns.filter(id => {
        if (devMode) return true;
        const entry = OS.apps[id];
        return !entry?.devOnly;
      });

      function buildAppCard(appId, novaData) {
        const entry   = (typeof OS !== 'undefined' && OS.apps) ? OS.apps[appId] : null;
        const appName = novaData?.name ?? entry?.name ?? appId;

        let dangerous, normal, appVersion, appVerified, appAuthor;
        if (novaData) {
          dangerous   = [...(novaData.permissions || []), ...(novaData.optionalPermissions || [])];
          normal      = [];
          appVersion  = novaData.version  || null;
          appVerified = novaData.verified  ?? false;
          appAuthor   = novaData.author    || null;
        } else {
          const mapEntry = pmap[appId];
          dangerous   = mapEntry?.dangerous ?? ['net:external', 'device:camera', 'device:microphone', 'device:geolocation'];
          normal      = mapEntry?.normal    ?? [];
          appVersion  = null;
          appVerified = null;
          appAuthor   = null;
        }

        if (dangerous.length === 0 && normal.length === 0 && !novaData && !appId.startsWith('wa_')) return null;

        const card = createEl('div', {
          style: 'background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;margin-bottom:12px;overflow:hidden;'
        });

        const header     = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:12px 14px;cursor:pointer;user-select:none;' });
        const headerLeft = createEl('div', { style: 'display:flex;align-items:center;gap:10px;' });

        // App icon
        const iconEl = createEl('div', {
          style: 'width:34px;height:34px;border-radius:8px;background:var(--accent-muted,rgba(88,166,255,0.15));display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:var(--accent);flex-shrink:0;overflow:hidden;'
        });
        const iconVal  = novaData?.icon ?? entry?.icon ?? null;
        const isEmoji  = iconVal && /\p{Emoji}/u.test(iconVal) && iconVal.length <= 4;
        const isSvgKey = iconVal && !isEmoji && /^[a-z][a-z0-9-]*$/.test(iconVal);
        const isDataUri = iconVal && typeof iconVal === 'string' && iconVal.startsWith('data:image/svg+xml;base64,');
        if (isSvgKey && typeof svgIcon === 'function') {
          iconEl.innerHTML = svgIcon(iconVal, 18);
          iconEl.style.color = 'var(--accent)';
        } else if (isEmoji) {
          iconEl.style.fontSize = '20px';
          iconEl.textContent = iconVal;
        } else if (isDataUri) {
          iconEl.style.background = 'transparent';
          iconEl.innerHTML = '<img src="' + iconVal + '" width="18" height="18" style="display:block;" draggable="false" alt="">';
        } else {
          iconEl.textContent = appName.charAt(0).toUpperCase();
        }
        headerLeft.appendChild(iconEl);

        const nameEl  = createEl('div');
        nameEl.appendChild(createEl('div', { textContent: appName, style: 'font-weight:600;font-size:13.5px;color:var(--text-primary);' }));

        // Badge row — refreshed in-place on toggle, no full list re-render
        const badgeRow = createEl('div', { style: 'display:flex;gap:4px;margin-top:3px;flex-wrap:wrap;' });
        function refreshBadges() {
          badgeRow.innerHTML = '';
          const grantedCount = dangerous.filter(p => mgr.isGranted(p, appId)).length;
          const deniedCount  = dangerous.filter(p => mgr.isDenied ? mgr.isDenied(p, appId) : false).length;
          const pendingCount = dangerous.length - grantedCount - deniedCount;
          if (grantedCount > 0) badgeRow.appendChild(createEl('span', { textContent: grantedCount + ' allowed',    style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(63,185,80,0.12);color:#3fb950;border:1px solid rgba(63,185,80,0.3);' }));
          if (deniedCount  > 0) badgeRow.appendChild(createEl('span', { textContent: deniedCount  + ' denied',     style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(248,81,73,0.12);color:#f85149;border:1px solid rgba(248,81,73,0.3);' }));
          if (pendingCount > 0) badgeRow.appendChild(createEl('span', { textContent: pendingCount + ' not asked',  style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(255,255,255,0.06);color:var(--text-muted);border:1px solid var(--border-subtle);' }));
          if (dangerous.length === 0 && normal.length === 0)
            badgeRow.appendChild(createEl('span', { textContent: 'No permissions',           style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(255,255,255,0.06);color:var(--text-muted);border:1px solid var(--border-subtle);' }));
          else if (dangerous.length === 0)
            badgeRow.appendChild(createEl('span', { textContent: 'No sensitive permissions', style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(255,255,255,0.06);color:var(--text-muted);border:1px solid var(--border-subtle);' }));
        }
        refreshBadges();

        // Version / author / verified (novaapp packages only)
        if (appVersion || appAuthor || appVerified !== null) {
          const metaRow = createEl('div', { style: 'display:flex;gap:8px;margin-top:3px;align-items:center;flex-wrap:wrap;' });
          if (appVersion)        metaRow.appendChild(createEl('span', { textContent: 'v' + appVersion,  style: 'font-size:10px;color:var(--text-muted);font-family:monospace;' }));
          if (appAuthor)         metaRow.appendChild(createEl('span', { textContent: 'by ' + appAuthor, style: 'font-size:10px;color:var(--text-muted);' }));
          if (appVerified === true)  metaRow.appendChild(createEl('span', { textContent: '✓ Verified',   style: 'font-size:10px;color:#3fb950;' }));
          if (appVerified === false) metaRow.appendChild(createEl('span', { textContent: '⚠ Unverified', style: 'font-size:10px;color:#d29922;' }));
          nameEl.appendChild(metaRow);
        }
        nameEl.appendChild(badgeRow);
        headerLeft.appendChild(nameEl);
        header.appendChild(headerLeft);

        const chevron = createEl('span', { style: 'color:var(--text-muted);font-size:12px;transition:transform 0.2s;' });
        chevron.textContent = '▶';
        header.appendChild(chevron);
        card.appendChild(header);

        // Expandable body
        const body = createEl('div', { style: 'display:none;border-top:1px solid var(--border-subtle);' });

        if (dangerous.length > 0) {
          const section = createEl('div', { style: 'padding:10px 14px 6px;' });
          section.appendChild(createEl('div', {
            textContent: 'SENSITIVE PERMISSIONS',
            style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin-bottom:8px;'
          }));

          for (const perm of dangerous) {
            const cat       = AppPermissionManager.PERMISSION_CATEGORIES?.[perm];
            const risk      = cat?.risk ?? 'medium';
            const label     = PERM_LABELS[perm] ?? perm;
            const isGranted = mgr.isGranted(perm, appId);
            const isDenied  = mgr.isDenied ? mgr.isDenied(perm, appId) : false;

            const row = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border-subtle);' });
            const left = createEl('div', { style: 'display:flex;align-items:center;gap:8px;' });

            const riskBadge = createEl('span', {
              textContent: risk.charAt(0).toUpperCase() + risk.slice(1),
              style: `font-size:9px;padding:1px 6px;border-radius:20px;background:${RISK_BG[risk]};color:${RISK_COLOR[risk]};border:1px solid ${RISK_COLOR[risk]}40;font-weight:600;`
            });
            const labelEl = createEl('div');
            labelEl.appendChild(createEl('div', { textContent: label, style: 'font-size:13px;color:var(--text-primary);font-weight:500;' }));
            labelEl.appendChild(createEl('div', { textContent: perm,  style: 'font-size:10px;color:var(--text-muted);font-family:monospace;' }));
            left.append(riskBadge, labelEl);
            row.appendChild(left);

            const toggleWrap  = createEl('label', { style: 'position:relative;display:inline-block;width:40px;height:22px;flex-shrink:0;cursor:pointer;' });
            const toggleInput = createEl('input', { type: 'checkbox' });
            toggleInput.style.cssText = 'opacity:0;position:absolute;inset:0;width:100%;height:100%;cursor:pointer;z-index:2;';
            toggleInput.checked = isGranted;
            const slider = createEl('span', {
              style: `position:absolute;inset:0;border-radius:22px;transition:background 0.2s;background:${isGranted ? 'var(--accent)' : (isDenied ? 'rgba(248,81,73,0.3)' : 'var(--bg-elevated)')};border:1px solid var(--border-subtle);`
            });
            const knob = createEl('span', {
              style: `position:absolute;top:2px;left:${isGranted ? '20px' : '2px'};width:16px;height:16px;border-radius:50%;background:#fff;transition:left 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.3);`
            });
            slider.appendChild(knob);
            toggleWrap.append(toggleInput, slider);

            toggleInput.addEventListener('change', async () => {
              if (toggleInput.checked) {
                // FIX: original called grantPermission twice (before and after resetPermission)
                // Correct: optional reset to clear denial state, then a single grant
                if (mgr.resetPermission) await Promise.resolve(mgr.resetPermission(perm, appId)).catch(() => {});
                await mgr.grantPermission(perm, appId, { permanent: true, reason: 'Manually granted via Settings', grantedBy: 'user' });
                slider.style.background = 'var(--accent)';
                knob.style.left = '20px';
              } else {
                await mgr.revokePermission(perm, appId);
                slider.style.background = 'rgba(248,81,73,0.3)';
                knob.style.left = '2px';
              }
              // FIX: refresh only this card's badges, not the entire apps list
              refreshBadges();
            });

            row.appendChild(toggleWrap);
            section.appendChild(row);
          }
          body.appendChild(section);
        }

        if (normal.length > 0) {
          const normSection = createEl('div', { style: 'padding:8px 14px 10px;' });
          normSection.appendChild(createEl('div', {
            textContent: 'AUTOMATIC PERMISSIONS',
            style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin-bottom:6px;'
          }));
          const normList = createEl('div', { style: 'display:flex;flex-wrap:wrap;gap:5px;' });
          for (const perm of normal) {
            normList.appendChild(createEl('span', {
              textContent: PERM_LABELS[perm] ?? perm,
              style: 'font-size:11px;padding:2px 8px;border-radius:20px;background:rgba(63,185,80,0.08);color:#3fb950;border:1px solid rgba(63,185,80,0.2);'
            }));
          }
          normSection.appendChild(normList);
          body.appendChild(normSection);
        }

        if (dangerous.length > 0) {
          const footer   = createEl('div', { style: 'padding:8px 14px;border-top:1px solid var(--border-subtle);display:flex;justify-content:flex-end;' });
          const resetBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Reset All Permissions', style: 'font-size:11px;' });
          resetBtn.addEventListener('click', async () => {
            if (mgr.resetPermission) {
              for (const p of dangerous) await mgr.resetPermission(p, appId);
            } else {
              await mgr.revokeAllPermissions(appId);
            }
            Notify.show({ title: 'Permissions Reset', body: appName + ' will be asked again next launch.', type: 'info', appName: 'Settings' });
            refreshBadges();
          });
          footer.appendChild(resetBtn);
          body.appendChild(footer);
        }

        card.appendChild(body);

        let expanded = false;
        header.addEventListener('click', () => {
          expanded = !expanded;
          body.style.display       = expanded ? 'block' : 'none';
          chevron.style.transform  = expanded ? 'rotate(90deg)' : 'rotate(0deg)';
        });

        return card;
      }

      if (visibleBuiltIns.length > 0) {
        mainContent.appendChild(createEl('div', { textContent: 'BUILT-IN APPS', style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin-bottom:10px;' }));
        for (const id of visibleBuiltIns) {
          const card = buildAppCard(id);
          if (card) mainContent.appendChild(card);
        }
      }

      if (novaApps.length > 0) {
        mainContent.appendChild(createEl('div', { textContent: 'INSTALLED PACKAGES', style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin:16px 0 10px;' }));
        for (const novaData of novaApps) {
          const card = buildAppCard(novaData.id, novaData);
          if (card) mainContent.appendChild(card);
        }
      }

      if (webApps.length > 0) {
        mainContent.appendChild(createEl('div', { textContent: 'WEB APPS', style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin:16px 0 10px;' }));
        for (const id of webApps) {
          const card = buildAppCard(id);
          if (card) mainContent.appendChild(card);
        }
      }

      if (visibleBuiltIns.length === 0 && webApps.length === 0 && novaApps.length === 0) {
        const empty = createEl('div', { style: 'text-align:center;color:var(--text-muted);padding:40px 0;font-size:13px;' });
        empty.textContent = 'No apps found.';
        mainContent.appendChild(empty);
      }
    }

    // ── Privacy ──────────────────────────────────────────────────────────────
    function renderPrivacy() {
      mainContent.appendChild(createEl('h2', { textContent: 'Privacy & Security', style: { marginBottom: '20px' } }));


      // Data management
      const exportSection = createEl('div', { className: 'nook-privacy-section' });
      exportSection.appendChild(createEl('h3', { textContent: 'Data Management' }));
      const exportActions = createEl('div', { className: 'nook-data-actions' });

      const exportBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Export All Data (JSON)' });
      exportBtn.addEventListener('click', () => {
        const data = {
          settings:   { ...(OS.settings._cache || {}) },
          version:    OS.version,
          exportDate: new Date().toISOString()
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = createEl('a', { href: url, download: 'novabyte-export.json' });
        a.click();
        URL.revokeObjectURL(url);
        Notify.show({ title: 'Data Exported', body: 'All data has been exported', type: 'success', appName: 'Nook' });
      });
      exportActions.appendChild(exportBtn);

      const importBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Import Data' });
      importBtn.addEventListener('click', () => {
        const input = createEl('input', { type: 'file', accept: '.json', id: 'settings-import-input', name: 'settings-import' });
        input.addEventListener('change', async () => {
          const file = input.files[0];
          if (!file) return;
          try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (data.settings && typeof data.settings === 'object') {
              for (const [k, v] of Object.entries(data.settings)) OS.settings.set(k, v);
              Notify.show({ title: 'Data Imported', body: 'Settings have been imported', type: 'success', appName: 'Nook' });
            }
          } catch {
            Notify.show({ title: 'Import Failed', body: 'Invalid JSON file', type: 'error', appName: 'Nook' });
          }
        });
        input.click();
      });
      exportActions.appendChild(importBtn);
      exportSection.appendChild(exportActions);
      mainContent.appendChild(exportSection);
    }

    // ── Shortcuts ───────────────────────────────────────────────────────────
    function renderShortcuts() {
      mainContent.appendChild(createEl('h2', { textContent: 'Keyboard Shortcuts', style: { marginBottom: '20px' } }));

      const searchWrapper = createEl('div', { className: 'nook-shortcuts-search' });
      const search        = createEl('input', { id: 'shortcuts-search-input', name: 'shortcuts-search', placeholder: 'Search shortcuts...' });
      searchWrapper.appendChild(search);
      mainContent.appendChild(searchWrapper);

      const table = createEl('table', { className: 'nook-shortcuts-table' });
      const thead = createEl('thead');
      const hRow  = createEl('tr');
      for (const text of ['Action', 'Shortcut', '']) hRow.appendChild(createEl('th', { textContent: text }));
      thead.appendChild(hRow);
      table.appendChild(thead);

      const tbody = createEl('tbody');

      // FIX: wrapped in try/catch — corrupt localStorage entry no longer crashes
      let customShortcuts;
      try { customShortcuts = JSON.parse(localStorage.getItem('novabyte-shortcuts') || '{}'); }
      catch { customShortcuts = {}; }

      function captureKeyBinding(action) {
        return new Promise(resolve => {
          const overlay = createEl('div', {
            tabIndex: -1,
            style: 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:9999;outline:none'
          });

          // FIX: build dialog with DOM nodes instead of innerHTML + template interpolation
          const msg      = createEl('div', { style: 'background:var(--bg-elevated);padding:30px 40px;border-radius:12px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.5)' });
          const title    = createEl('h3', { style: 'margin-bottom:15px;color:var(--text-primary)' });
          title.textContent = 'Rebind: ' + action;
          const subtitle = createEl('p',   { textContent: 'Press any key combination...', style: 'color:var(--text-secondary);margin-bottom:20px' });
          const captureEl = createEl('div', {
            textContent: 'Waiting...',
            style: 'font-family:var(--font-mono);font-size:18px;padding:10px 20px;background:var(--bg-sunken);border-radius:6px;color:var(--accent)'
          });
          msg.append(title, subtitle, captureEl);
          overlay.appendChild(msg);
          document.body.appendChild(overlay);

          function keyHandler(e) {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') {
              overlay.removeEventListener('keydown', keyHandler, true);
              overlay.remove();
              resolve(null);
              return;
            }
            const parts = [];
            if (e.ctrlKey)  parts.push('Ctrl');
            if (e.altKey)   parts.push('Alt');
            if (e.shiftKey) parts.push('Shift');
            if (e.metaKey)  parts.push('Win');
            if (e.key && !['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
              parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
            }
            if (parts.length > 0) {
              captureEl.textContent = parts.join('+');
              setTimeout(() => {
                overlay.removeEventListener('keydown', keyHandler, true);
                overlay.remove();
                resolve(parts.join('+'));
              }, 400);
            }
          }

          overlay.addEventListener('keydown', keyHandler, true);
          overlay.style.cursor = 'wait';
          setTimeout(() => overlay.focus(), 100);
        });
      }

      for (const s of SHORTCUTS_LIST) {
        const row      = createEl('tr');
        const actionTd = createEl('td');
        actionTd.textContent = s.action;
        const keyTd  = createEl('td');
        const keySpan = createEl('span', { className: 'nook-shortcut-key', textContent: customShortcuts[s.action] || s.key });
        keyTd.appendChild(keySpan);
        const rebindTd = createEl('td');
        const btn = createEl('button', { className: 'btn btn-sm nook-rebind-btn', textContent: 'Rebind' });
        btn.addEventListener('click', async () => {
          const newKey = await captureKeyBinding(s.action);
          if (newKey) {
            customShortcuts[s.action] = newKey;
            localStorage.setItem('novabyte-shortcuts', JSON.stringify(customShortcuts));
            keySpan.textContent = newKey;
          }
        });
        rebindTd.appendChild(btn);
        row.append(actionTd, keyTd, rebindTd);
        tbody.appendChild(row);
      }

      table.appendChild(tbody);
      mainContent.appendChild(table);

      search.addEventListener('input', () => {
        const query = search.value.toLowerCase();
        for (const row of tbody.querySelectorAll('tr')) {
          row.style.display = row.textContent.toLowerCase().includes(query) ? '' : 'none';
        }
      });
    }

    // ── About ────────────────────────────────────────────────────────────────
    function renderAbout() {
      mainContent.style.padding = '0';
      const body = createEl('div', { style: 'padding:24px 28px;display:flex;flex-direction:column;gap:18px;overflow-y:auto;flex:1;' });

      function mkSection(title, icon) {
        const wrap = createEl('div', { style: 'background:var(--bg-sunken);border:1px solid var(--border-subtle);border-radius:12px;overflow:hidden;' });
        const hdr  = createEl('div', { style: 'padding:11px 16px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;gap:8px;background:rgba(255,255,255,0.025);' });
        hdr.appendChild(createEl('span', { textContent: icon,  style: 'font-size:13px;' }));
        hdr.appendChild(createEl('span', { textContent: title, style: 'font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.09em;color:var(--text-muted);' }));
        const rows = createEl('div', { style: 'padding:0 16px;' });
        wrap.append(hdr, rows);
        return { wrap, rows };
      }

      function mkRow(label, value, last) {
        const row = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:9px 0;font-size:12.5px;' + (last ? '' : 'border-bottom:1px solid var(--border-subtle);') });
        const lbl = createEl('span', { textContent: label, style: 'color:var(--text-secondary);flex-shrink:0;margin-right:12px;' });
        const val = createEl('span', { style: 'color:var(--text-primary);font-weight:500;text-align:right;max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' });
        val.textContent = value;
        row.append(lbl, val);
        return row;
      }

      // ── Software ──────────────────────────────────────────────────────────
      const { wrap: swWrap, rows: swRows } = mkSection('Software Information', '\uD83D\uDCBF');

      const logoRow = createEl('div', { style: 'padding:18px 0 14px;display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--border-subtle);' });
      const logoBox = createEl('div', { style: 'width:54px;height:54px;border-radius:15px;background:linear-gradient(135deg,#3d8eff 0%,#7c5cfc 55%,#c45cff 100%);display:flex;align-items:center;justify-content:center;box-shadow:0 6px 22px rgba(88,166,255,0.32),0 2px 8px rgba(0,0,0,0.4),inset 0 1px 0 rgba(255,255,255,0.22);flex-shrink:0;' });
      logoBox.innerHTML = '<svg viewBox="0 0 120 120" width="32" height="32" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="abt-g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#58a6ff"/><stop offset="100%" stop-color="#a371f7"/></linearGradient></defs><polygon points="60,5 110,30 110,85 60,115 10,85 10,30" fill="rgba(88,166,255,0.05)" stroke="url(#abt-g)" stroke-width="2.5" opacity="0.9"/><polygon points="60,15 100,35 100,80 60,105 20,80 20,35" fill="none" stroke="url(#abt-g)" stroke-width="1.5" opacity="0.38"/><polygon points="60,28 88,43 88,76 60,91 32,76 32,43" fill="rgba(163,113,247,0.05)" stroke="url(#abt-g)" stroke-width="1" opacity="0.3"/><text x="60" y="69" text-anchor="middle" fill="url(#abt-g)" font-family="system-ui,-apple-system,sans-serif" font-size="30" font-weight="700">NB</text></svg>';
      const logoMeta = createEl('div');
      const lgTitle  = createEl('div', { style: 'font-size:17px;font-weight:800;background:linear-gradient(130deg,#e6edf3 25%,#a371f7 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:4px;line-height:1.15;' });
      lgTitle.textContent = 'NovaByte';
      const verBadge = createEl('div', { style: 'display:inline-flex;align-items:center;gap:5px;background:rgba(88,166,255,0.12);border:1px solid rgba(88,166,255,0.3);border-radius:20px;padding:2px 11px;font-size:11px;font-weight:700;color:var(--accent);margin-bottom:3px;' });
      verBadge.textContent = 'v' + OS.version;
      const tagline = createEl('div', { style: 'font-size:10.5px;color:var(--text-muted);font-style:italic;' });
      tagline.textContent = '';
      logoMeta.append(lgTitle, verBadge, tagline);
      logoRow.append(logoBox, logoMeta);
      swRows.appendChild(logoRow);

      // Version row (easter egg: 7 clicks launches Snake)
      const novaVersionRow = createEl('div', {
        className: 'nook-row clickable',
        style: 'display:flex;justify-content:space-between;align-items:center;padding:9px 0;font-size:12.5px;border-bottom:1px solid var(--border-subtle);cursor:pointer;transition:background 0.15s;border-radius:6px;'
      });
      novaVersionRow.addEventListener('mouseenter', () => { novaVersionRow.style.background = 'rgba(88,166,255,0.08)'; });
      novaVersionRow.addEventListener('mouseleave', () => { novaVersionRow.style.background = 'transparent'; });
      const novaVerLabel = createEl('span', { textContent: 'NovaByte Version', style: 'color:var(--text-secondary);flex-shrink:0;margin-right:12px;' });
      const novaVerValue = createEl('span', { style: 'color:var(--text-primary);font-weight:500;text-align:right;max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' });
      novaVerValue.textContent = 'v' + OS.version;
      novaVersionRow.append(novaVerLabel, novaVerValue);

      let clickCount = 0;
      let clickTimeout = null;
      novaVersionRow.addEventListener('click', () => {
        clickCount++;
        if (clickCount >= 7) {
          clickCount = 0;
          clearTimeout(clickTimeout);
          clickTimeout = null;
          launchSnakeGame();
          return;
        }
        clearTimeout(clickTimeout);
        clickTimeout = setTimeout(() => { clickCount = 0; clickTimeout = null; }, 1500);
      });
      swRows.appendChild(novaVersionRow);
      swRows.appendChild(mkRow('Source Date',  '2026-07-16'));

      const secRow      = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:9px 0;font-size:12.5px;border-top:1px solid var(--border-subtle);border-radius:6px;' });
      const secRowLeft  = createEl('div', { style: 'display:flex;align-items:center;gap:6px;' });
      secRowLeft.appendChild(createEl('span', { textContent: 'Security Patch Level', style: 'color:var(--text-secondary);' }));
      secRow.appendChild(secRowLeft);
      const secRowRight = createEl('div', { style: 'display:flex;align-items:center;gap:6px;' });
      const secBadge    = createEl('span', { style: 'display:inline-flex;align-items:center;gap:5px;background:rgba(63,185,80,0.1);border:1px solid rgba(63,185,80,0.3);border-radius:20px;padding:2px 10px;font-size:10.5px;font-weight:700;color:#3fb950;' });
      secBadge.textContent = '\uD83D\uDD12 2026-07-04';
      secRowRight.appendChild(secBadge);
      secRow.appendChild(secRowRight);
      swRows.appendChild(secRow);
      body.appendChild(swWrap);

      // ── Hardware ────────────────────────────────────────────────────────────
      const { wrap: hwWrap, rows: hwRows } = mkSection('Hardware', '\uD83D\uDDA5\uFE0F');
      [
        ['Screen Resolution', screen.width + '\u00D7' + screen.height,                                               false],
        ['Colour Depth',      screen.colorDepth + ' bit',                                                             false],
        ['Pixel Ratio',       window.devicePixelRatio + '\u00D7',                                                     false],
        ['CPU Cores',         String(navigator.hardwareConcurrency || 'Unknown'),                                      false],
        ['Device Memory',     navigator.deviceMemory ? navigator.deviceMemory + ' GB (approx.)' : 'Not reported',    false],
        ['Touch Points',      navigator.maxTouchPoints > 0 ? String(navigator.maxTouchPoints) + ' point(s)' : 'None', true],
      ].forEach(([lbl, val, last]) => hwRows.appendChild(mkRow(lbl, val, last)));
      body.appendChild(hwWrap);

      // ── Environment ─────────────────────────────────────────────────────────
      const { wrap: envWrap, rows: envRows } = mkSection('Environment', '\uD83C\uDF10');
      let tz = 'Unknown';
      try { tz = OS.settings.get('timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown'; } catch { /* sandboxed */ }
      [
        ['Browser',         detectBrowser(),                                                                          false],
        ['Platform',        navigator.platform,                                                                        false],
        ['Region',          OS.settings.get('region') || navigator.language,                                          false],
        ['Timezone',        tz,                                                                                        false],
        ['Do Not Track',    navigator.doNotTrack === '1' ? 'Enabled \u2713' : 'Not set',                             false],
        ['Cookies',         navigator.cookieEnabled ? 'Enabled \u2713' : 'Disabled',                                 false],
        ['Service Workers', ('serviceWorker' in navigator) ? 'Supported \u2713' : 'Not supported',                    true],
      ].forEach(([lbl, val, last]) => envRows.appendChild(mkRow(lbl, val, last)));
      body.appendChild(envWrap);

      // ── Legal ───────────────────────────────────────────────────────────────
      const { wrap: lgWrap, rows: lgRows } = mkSection('Legal \u0026 Licences', '\u2696\uFE0F');
      lgRows.appendChild(mkRow('Licence',        'Apache 2.0'));
      lgRows.appendChild(mkRow('Copyright',      '\u00A9 2026 NovaByteOfficial'));
      body.appendChild(lgWrap);

      // Copy system info
      const copyBtn = createEl('button', { className: 'btn btn-sm', textContent: '\uD83D\uDCCB Copy System Info' });
      copyBtn.addEventListener('click', () => {
        let tzCopy = 'Unknown';
        try { tzCopy = OS.settings.get('timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown'; } catch { /* sandboxed */ }
        const lines = [
          'NovaByte v' + OS.version,
          'Security Update: 2026-07-04',
          'Browser: '   + detectBrowser(),
          'Platform: '  + navigator.platform,
          'Screen: '    + screen.width + '\u00D7' + screen.height,
          'CPU Cores: ' + (navigator.hardwareConcurrency || 'Unknown'),
          'Region: '    + (OS.settings.get('region') || navigator.language),
          'Timezone: '  + tzCopy,
        ];
        navigator.clipboard.writeText(lines.join('\n'));
        Notify.show({ title: 'Copied', body: 'System info copied to clipboard', type: 'success', appName: 'Nook' });
      });
      body.appendChild(copyBtn);
      mainContent.appendChild(body);
    }

    // ── Bootstrap ────────────────────────────────────────────────────────────
    container.appendChild(sidebar);
    container.appendChild(mainContent);
    content.appendChild(container);

    buildSidebar();
    renderContent();

    if (typeof OS !== 'undefined' && OS.events && typeof OS.events.on === 'function') {
      OS.events.on('settings:changed', ({ key }) => {
        if (key === 'devMode' && currentSection === 'apps') renderContent();
        if (key === 'region' && currentSection === 'about') renderContent();
      });
    }
  }
});