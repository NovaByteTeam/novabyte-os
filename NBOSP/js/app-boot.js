
async function boot() {
        
        const bootScreen = document.getElementById('boot-screen');

        // ── Boot Timeout & Stuck Detection ──────────────────────────────
        const BOOT_TIMEOUT_MS = 15000; // 15 seconds max for boot to complete
        const BOOT_TIMEOUT_KEY = 'nova_boot_timeout_flag';
        const RECOVERY_FORCE_KEY = 'nova_force_recovery';

        // Check if this is a forced recovery boot (timeout on previous attempt)
        const forceRecovery = localStorage.getItem(RECOVERY_FORCE_KEY) === '1';

        // Set timeout flag - if boot doesn't complete, this flag will trigger recovery on next load
        const bootStartTime = Date.now();
        localStorage.setItem(BOOT_TIMEOUT_KEY, JSON.stringify({ start: bootStartTime, stuck: false }));

        // Boot timeout watchdog
        const bootTimeoutId = setTimeout(() => {
          const timeoutData = JSON.parse(localStorage.getItem(BOOT_TIMEOUT_KEY) || '{}');
          if (!timeoutData.completed) {
            console.error('[BOOT] Boot appears stuck - timeout detected');
            localStorage.setItem(BOOT_TIMEOUT_KEY, JSON.stringify({ start: bootStartTime, stuck: true }));
            // Set recovery force flag and force refresh
            localStorage.setItem(RECOVERY_FORCE_KEY, '1');
            localStorage.setItem('nova_boot_attempts', JSON.stringify([
              { ts: Date.now() - 2000, reason: 'boot_timeout_1', ua: navigator.userAgent.slice(0, 80) },
              { ts: Date.now(), reason: 'boot_timeout_2', ua: navigator.userAgent.slice(0, 80) }
            ]));
            location.reload();
          }
        }, BOOT_TIMEOUT_MS);

        function completeBoot() {
          clearTimeout(bootTimeoutId);
          try {
            const timeoutData = JSON.parse(localStorage.getItem(BOOT_TIMEOUT_KEY) || '{}');
            timeoutData.completed = true;
            localStorage.setItem(BOOT_TIMEOUT_KEY, JSON.stringify(timeoutData));
          } catch (e) { }
          localStorage.removeItem(RECOVERY_FORCE_KEY);
        }

        // ── Boot Attempt Tracking & Recovery Detection ─────────────────
        const BOOT_ATTEMPT_KEY = 'nova_boot_attempts';
        const SAFE_MODE_KEY = 'nova_safe_mode';
        const BOOT_THRESHOLD = 2; // failed attempts before recovery
        const MANUAL_RECOVERY_KEY = 'nova_manual_recovery';
        const SHOW_RECOVERY_KEY = 'nova_show_recovery';

        // Check for manual recovery first - user intentionally clicked "Boot to Recovery" in settings
        const isManualRecovery = localStorage.getItem(MANUAL_RECOVERY_KEY) === '1' || localStorage.getItem(SHOW_RECOVERY_KEY) === '1';
        if (isManualRecovery) {
          console.log('[BOOT] Manual recovery boot detected - user clicked Boot to Recovery in settings');
          localStorage.removeItem(MANUAL_RECOVERY_KEY);
          localStorage.removeItem(SHOW_RECOVERY_KEY);
          // Show recovery screen directly - no failed boot messaging, no auto-reboot countdown
          showRecoveryScreen([]); // Empty array = 0 failed attempts
          completeBoot();
          return;
        }

        // Check if previous boot was stuck/timeout - go directly to recovery
        if (forceRecovery) {
          console.log('[BOOT] Previous boot timed out - forcing recovery mode');
          localStorage.removeItem(RECOVERY_FORCE_KEY);
          const priorAttempts = (() => {
            try { return JSON.parse(localStorage.getItem(BOOT_ATTEMPT_KEY) || '[]'); } catch { return []; }
          })();
          showRecoveryScreen(priorAttempts);
          completeBoot();
          return;
        }

        function getBootAttempts() {
          try { return JSON.parse(localStorage.getItem(BOOT_ATTEMPT_KEY) || '[]'); } catch { return []; }
        }
        function clearBootAttempts() {
          localStorage.removeItem(BOOT_ATTEMPT_KEY);
          localStorage.removeItem(RECOVERY_FORCE_KEY);
        }
        function recordBootAttempt() {
          const attempts = getBootAttempts();
          attempts.push({ ts: Date.now(), ua: navigator.userAgent.slice(0, 80) });
          if (attempts.length > 10) attempts.shift();
          localStorage.setItem(BOOT_ATTEMPT_KEY, JSON.stringify(attempts));
        }
        function markBootSuccess() {
          clearBootAttempts();
          completeBoot();
          document.body.classList.add('os-booted');
          // Hide recovery screen if it's visible
          const recoveryScreen = document.getElementById('recovery-screen');
          if (recoveryScreen) {
            recoveryScreen.classList.remove('active');
          }
        }

        const priorAttempts = getBootAttempts();
        const isSafeMode = localStorage.getItem(SAFE_MODE_KEY) === '1';

        // If prior failed boots >= threshold AND this isn't already a safe-mode/recovery session → show recovery
        if (priorAttempts.length >= BOOT_THRESHOLD && !isSafeMode) {
          showRecoveryScreen(priorAttempts);
          completeBoot(); // cancel the watchdog timer so it doesn't reload over the recovery screen
          return; // do not proceed with normal boot
        }

        // Record this boot attempt (will be cleared on success)
        recordBootAttempt();

        if (isSafeMode) {
          localStorage.removeItem(SAFE_MODE_KEY);
          document.getElementById('safe-mode-banner').style.display = 'block';
          OS._safeModeActive = true;
        }

        try {
          OS.workers.fs = createWorker(FS_WORKER_CODE);
          OS.workers.search = createWorker(SEARCH_WORKER_CODE);
          OS.workers.crypto = createWorker(CRYPTO_WORKER_CODE);

          await OS.workers.fs.call('init');
          await OS.settings.load();
          if (isSafeMode && typeof OS.settings.applySafeModeDefaults === 'function') {
            OS.settings.applySafeModeDefaults();
          }
          await FS.init();
          await OPFS.init(); // Initialize OPFS for binary storage
          await AppDirs.bootstrap(); // Bootstrap per-app /data/data/ directories
          window.__NB_RUNTIME.ready = true;

          // Hook settings writes → mirror to com.nbosp.settings/shared_prefs/prefs.json
          const _origSettingsSet = OS.settings.set.bind(OS.settings);
          OS.settings.set = function (key, value) {
            _origSettingsSet(key, value);
            const folderId = AppDirs.getVFSDir('com.nbosp.settings', 'shared_prefs');
            if (folderId) {
              const content = JSON.stringify(OS.settings._cache, null, 2);
              const existing = FS.listDir(folderId).find(f => f.name === 'prefs.json' && f.type === 'file');
              if (existing) FS.writeFile(existing.id, content).catch(() => { });
              else FS.createFile(folderId, 'prefs.json', content, 'application/json').catch(() => { });
            }
          };
        } catch (e) {
          // Worker initialization failed - continuing without worker
          console.error('[BOOT] Worker initialization error:', e);
          // Force recovery mode if workers fail
          triggerRecovery('worker_init_failed');
        }

        // Apply settings
        OS.username = OS.settings.get('username') || 'user';
        OS.idleTimeout = (parseInt(OS.settings.get('autoLock')) || 10) * 60000;
        OS.lockPin = OS.settings.get('lockPin') || null;

        applyTheme(OS.settings.get('theme') || 'nova-dark');

        const accent = OS.settings.get('accentColor');
        if (accent) {
          document.documentElement.style.setProperty('--accent', accent);
          document.documentElement.style.setProperty('--accent-hover', accent + 'dd');
          document.documentElement.style.setProperty('--accent-muted', accent + '22');
        }

        // Apply wallpaper — either custom or preset
        const WALLPAPER_PRESETS = {
          'stock-blue': 'radial-gradient(ellipse at 28% 38%, #1a5fbf 0%, #0a3070 35%, transparent 65%), linear-gradient(160deg, #020c1e 0%, #041428 45%, #061830 75%, #020c1e 100%)',
          'stock-dark': 'radial-gradient(ellipse at 70% 25%, #160a28 0%, transparent 55%), radial-gradient(ellipse at 25% 75%, #0c0818 0%, transparent 50%), linear-gradient(150deg, #080810 0%, #0e0818 50%, #08080e 100%)',
          'stock-light': 'radial-gradient(ellipse at 40% 30%, #ffffff 0%, #e8f0ff 45%, transparent 70%), linear-gradient(160deg, #dde8f8 0%, #eaf0ff 45%, #d8e6f5 100%)',
          'stock-green': 'radial-gradient(ellipse at 30% 40%, #0a5c2a 0%, #043818 38%, transparent 65%), linear-gradient(155deg, #020c06 0%, #040e08 45%, #060e06 75%, #020c06 100%)',
          'stock-purple': 'radial-gradient(ellipse at 62% 32%, #4a1272 0%, #2c0858 40%, transparent 65%), radial-gradient(ellipse at 22% 70%, #1e084a 0%, transparent 50%), linear-gradient(155deg, #0a0414 0%, #140628 50%, #0a0414 100%)',
          'stock-red': 'radial-gradient(ellipse at 35% 42%, #8c1a10 0%, #5c0808 40%, transparent 65%), radial-gradient(ellipse at 75% 70%, #3a0c0c 0%, transparent 50%), linear-gradient(155deg, #0e0404 0%, #180808 45%, #0e0404 100%)',
          'stock-gray': 'radial-gradient(ellipse at 50% 32%, #2c3c4e 0%, #1a2838 40%, transparent 65%), linear-gradient(155deg, #0c1018 0%, #16202c 45%, #0c1218 75%, #0c1018 100%)',
          'stock-teal': 'radial-gradient(ellipse at 38% 36%, #0a5e70 0%, #044050 40%, transparent 65%), radial-gradient(ellipse at 72% 68%, #042835 0%, transparent 50%), linear-gradient(155deg, #020c10 0%, #041520 45%, #021018 100%)',

        };

        const desktop = document.getElementById('desktop');
        const customWallpaper = OS.settings.get('customWallpaper');
        const wallpaperId = OS.settings.get('wallpaperId');

        if (customWallpaper && desktop) {
          desktop.style.backgroundImage = 'url(' + customWallpaper + ')';
          desktop.style.backgroundSize = 'cover';
          desktop.style.backgroundPosition = 'center';
          desktop.style.backgroundRepeat = 'no-repeat';
        } else if (wallpaperId && WALLPAPER_PRESETS[wallpaperId] && desktop) {
          desktop.style.backgroundImage = WALLPAPER_PRESETS[wallpaperId];
        } else if (desktop && WALLPAPER_PRESETS['stock-blue']) {
          desktop.style.backgroundImage = WALLPAPER_PRESETS['stock-blue'];
        }

        // FIX 1 — Restore Reduce Motion and desktop layout settings from saved values
        if (OS.settings.get('highContrast')) {
          document.documentElement.classList.add('no-glass');
        }
        if (OS.settings.get('reduceMotion')) {
          document.documentElement.style.setProperty('--anim-speed', '0.001');
          document.documentElement.classList.add('reduce-motion');
          const _wallpaperEl = document.getElementById('wallpaper');
          if (_wallpaperEl) _wallpaperEl.style.animation = 'none';
        }
        const _savedIconSize = OS.settings.get('desktopIconSize');
        if (_savedIconSize) document.documentElement.style.setProperty('--desktop-icon-size', _savedIconSize + 'px');
        const _savedGridSpacing = OS.settings.get('desktopGridSpacing');
        if (_savedGridSpacing) document.documentElement.style.setProperty('--desktop-grid-spacing', _savedGridSpacing + 'px');

        // Restore icon scale transform from cursorSize setting
        const savedCursorSize = OS.settings.get('cursorSize');
        if (savedCursorSize) {
          const cursorStyles = document.getElementById('cursor-custom-styles') || (() => {
            const s = document.createElement('style'); s.id = 'cursor-custom-styles'; document.head.appendChild(s); return s;
          })();
          const transforms = { normal: 'scale(1)', large: 'scale(1.5)', xlarge: 'scale(2)' };
          cursorStyles.textContent = `#desktop .desktop-icon { transform: ${transforms[savedCursorSize]} }`;
        }

        // FIX 7: Dynamic version handling - use code version as single source of truth
        // OS.version is already set to '1.6.41' from the code constant above
        // We only update settings if needed, but the code version always takes precedence
        const _savedOsVersion = OS.settings.get('osVersion');
        const _codeVersion = OS.version; // Use the dynamically defined code version
        // Always prefer the code version (it's newer than any saved "old" version)
        // This ensures after factory reset, version matches what's in the code
        if (_savedOsVersion !== _codeVersion) {
          OS.version = _codeVersion;
          OS.settings.set('osVersion', _codeVersion);
        }
        // Also save to localStorage for cross-scope access
        try {
          localStorage.setItem('novabyte_os_version', OS.version);
          console.log('[Init] Saved OS version to localStorage:', OS.version);
        } catch (e) { console.log('[Init] localStorage not available'); }

        // 2.2.0: Sync boot screen version pill with actual OS.version
        const _vPill = document.getElementById('boot-version-pill');
        if (_vPill) _vPill.textContent = 'VERSION ' + OS.version;
        // Restore taskbar position
        const _savedTaskbarPos = OS.settings.get('taskbarPosition');
        if (_savedTaskbarPos && _savedTaskbarPos !== 'bottom') {
          const _tbPos = document.getElementById('taskbar');
          if (_tbPos) {
            _tbPos.style.bottom = (_savedTaskbarPos === 'bottom') ? '0' : 'auto';
            _tbPos.style.top = (_savedTaskbarPos === 'top' || _savedTaskbarPos === 'left' || _savedTaskbarPos === 'right') ? '0' : 'auto';
            _tbPos.style.left = (_savedTaskbarPos === 'bottom' || _savedTaskbarPos === 'top' || _savedTaskbarPos === 'left') ? '0' : 'auto';
            _tbPos.style.right = (_savedTaskbarPos === 'bottom' || _savedTaskbarPos === 'top' || _savedTaskbarPos === 'right') ? '0' : 'auto';
            _tbPos.style.width = (_savedTaskbarPos === 'left' || _savedTaskbarPos === 'right') ? 'var(--taskbar-height)' : '';
            _tbPos.style.height = (_savedTaskbarPos === 'left' || _savedTaskbarPos === 'right') ? '100vh' : '';
            _tbPos.style.flexDirection = (_savedTaskbarPos === 'left' || _savedTaskbarPos === 'right') ? 'column' : '';
            _tbPos.style.borderLeft = _savedTaskbarPos === 'right' ? '1px solid var(--taskbar-border)' : '';
            _tbPos.style.borderRight = _savedTaskbarPos === 'left' ? '1px solid var(--taskbar-border)' : '';
          }
        }
        // Restore auto-hide state
        if (OS.settings.get('taskbarAutoHide')) {
          const _tbAH = document.getElementById('taskbar');
          if (_tbAH) _tbAH.classList.add('taskbar-autohide');
        }
        const _savedTaskbarSize = OS.settings.get('taskbarSize');
        if (_savedTaskbarSize) {
          const _tbHeights = { compact: '36px', normal: '48px', large: '64px' };
          if (_tbHeights[_savedTaskbarSize]) document.documentElement.style.setProperty('--taskbar-height', _tbHeights[_savedTaskbarSize]);
        }

        // FIX 8: Initialize screen reader announce function
        window.SR = {
          announce: (msg) => {
            let el = document.getElementById('sr-announcer');
            if (!el) {
              el = document.createElement('div');
              el.id = 'sr-announcer';
              el.setAttribute('aria-live', 'polite');
              el.setAttribute('aria-atomic', 'true');
              el.style.cssText = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;';
              document.body.appendChild(el);
            }
            el.textContent = '';
            requestAnimationFrame(() => { el.textContent = msg; });
          }
        };

        // Initialize WM
        WM.init();

        // Setup notification badge
        updateNotificationBadge();

        // Setup taskbar clock
        function updateClock() {
          document.getElementById('tray-time').textContent = formatTime(new Date());
          document.getElementById('tray-date').textContent = formatDate(new Date());
        }
        updateClock();
        setInterval(updateClock, 1000);

        // Auto-hide proximity detection
        // CSS :hover only catches a 3px strip when the taskbar is hidden — JS edge detection
        // is needed to reliably show it when the user moves toward the bottom of the screen.
        (function _initAutoHideProximity() {
          document.addEventListener('mousemove', function (e) {
            const _ahTb = document.getElementById('taskbar');
            if (!_ahTb || !_ahTb.classList.contains('taskbar-autohide')) return;
            if (e.clientY >= window.innerHeight - 8) {
              _ahTb.classList.add('taskbar-ah-shown');
            } else {
              _ahTb.classList.remove('taskbar-ah-shown');
            }
          });
        })();

        // Boot complete
        await new Promise(r => setTimeout(r, 800));

        bootScreen.classList.add('fade-out');

        // If PIN is set, show lock screen instead of going to desktop
        if (OS.lockPin) {
          await new Promise(r => setTimeout(r, 400));
          bootScreen.style.display = 'none';
          markBootSuccess(); // lock screen means boot succeeded
          WM.updateTaskbar();
          lockScreen();
          return;
        }

        setTimeout(() => {
          bootScreen.style.display = 'none';
          markBootSuccess(); // ← boot completed successfully, clear fail counter

          renderDesktopIcons();
          WM.updateTaskbar();
          Notify.show({ title: 'Welcome, ' + OS.username, body: 'NovaByte is ready.', type: 'info', appName: 'System' });
        }, 400);
      }

      /* ═══════════════════════════════════════════════════════════════
         SECTION: INSTALLED NOVAAPP BOOT REGISTRATION
         Re-registers any .novaapp packages the user has previously
         installed so they are available in the launcher / taskbar
         immediately on every boot, without opening App Manager first.
         ═══════════════════════════════════════════════════════════════ */
      (function loadInstalledNovaApps() {
        try {
          const apps = JSON.parse(localStorage.getItem('nova_installed_apps') || '[]');
          apps.forEach(appData => {
            if (OS.apps[appData.id]) return; // already registered
            registerApp({
              id: appData.id, name: appData.name, icon: appData.icon || 'box',
              description: appData.description || '',
              defaultSize: appData.defaultSize || [800, 560],
              minSize: appData.minSize || [400, 300],
              minSecurityPatch: appData.minSecurityPatch || null,
              permissions: appData.permissions || [],
              optionalPermissions: appData.optionalPermissions || [],
              init(contentEl) {
                const entryKey = appData.entry || 'index.html';
                const entryB64 = appData.files?.[entryKey];
                if (!entryB64) {
                  contentEl.innerHTML = '<div style="padding:24px;color:var(--text-danger);font-family:monospace;">Entry file not found in package.</div>';
                  return;
                }
                try {
                  const html = decodeURIComponent(escape(atob(entryB64)));
                  const blob = new Blob([html], { type: 'text/html' });
                  const url = URL.createObjectURL(blob);
                  const iframe = createEl('iframe', {
                    src: url,
                    style: 'width:100%;height:100%;border:none;display:block;',
                    sandbox: 'allow-scripts allow-forms allow-popups allow-modals'
                  });
                  contentEl.style.padding = '0';
                  contentEl.appendChild(iframe);
                  iframe.addEventListener('load', () => URL.revokeObjectURL(url));
                } catch (e) {
                  contentEl.innerHTML = `<div style="padding:24px;color:var(--text-danger);font-family:monospace;">Failed to load app: ${e.message}</div>`;
                }
              }
            });
          });
        } catch (e) { /* silently ignore — non-critical */ }
      })();




/* Exposed to Global Scope for Flat-Module Architecture */
window.boot = boot;
