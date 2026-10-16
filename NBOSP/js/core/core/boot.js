// ── Static Configurations & Constants ──────────────────────────────
const BOOT_TIMEOUT_MS = 15000;
const BOOT_THRESHOLD  = 5;

const KEYS = Object.freeze({
  TIMEOUT       : 'nova_boot_timeout_flag',
  FORCE         : 'nova_force_recovery',
  ATTEMPTS      : 'nova_boot_attempts',
  SAFE_MODE     : 'nova_safe_mode',
  MANUAL_REC    : 'nova_manual_recovery',
  SHOW_REC      : 'nova_show_recovery',
  INSTALLED_APPS: 'nova_installed_apps',
  OS_VERSION    : 'novabyte_os_version',
});

const WALLPAPER_PRESETS = Object.freeze({
  'stock-blue'  : 'radial-gradient(ellipse at 28% 38%, #1a5fbf 0%, #0a3070 35%, transparent 65%), linear-gradient(160deg, #020c1e 0%, #041428 45%, #061830 75%, #020c1e 100%)',
  'stock-dark'  : 'radial-gradient(ellipse at 70% 25%, #160a28 0%, transparent 55%), radial-gradient(ellipse at 25% 75%, #0c0818 0%, transparent 50%), linear-gradient(150deg, #080810 0%, #0e0818 50%, #08080e 100%)',
  'stock-light' : 'radial-gradient(ellipse at 40% 30%, #ffffff 0%, #e8f0ff 45%, transparent 70%), linear-gradient(160deg, #dde8f8 0%, #eaf0ff 45%, #d8e6f5 100%)',
  'stock-green' : 'radial-gradient(ellipse at 30% 40%, #0a5c2a 0%, #043818 38%, transparent 65%), linear-gradient(155deg, #020c06 0%, #040e08 45%, #060e06 75%, #020c06 100%)',
  'stock-purple': 'radial-gradient(ellipse at 62% 32%, #4a1272 0%, #2c0858 40%, transparent 65%), radial-gradient(ellipse at 22% 70%, #1e084a 0%, transparent 50%), linear-gradient(155deg, #0a0414 0%, #140628 50%, #0a0414 100%)',
  'stock-red'   : 'radial-gradient(ellipse at 35% 42%, #8c1a10 0%, #5c0808 40%, transparent 65%), radial-gradient(ellipse at 75% 70%, #3a0c0c 0%, transparent 50%), linear-gradient(155deg, #0e0404 0%, #180808 45%, #0e0404 100%)',
  'stock-gray'  : 'radial-gradient(ellipse at 50% 32%, #2c3c4e 0%, #1a2838 40%, transparent 65%), linear-gradient(155deg, #0c1018 0%, #16202c 45%, #0c1218 75%, #0c1018 100%)',
  'stock-teal'  : 'radial-gradient(ellipse at 38% 36%, #0a5e70 0%, #044050 40%, transparent 65%), radial-gradient(ellipse at 72% 68%, #042835 0%, transparent 50%), linear-gradient(155deg, #020c10 0%, #041520 45%, #021018 100%)',
});

// ── Storage Helpers ────────────────────────────────────────────────
const Storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  },
  set(key, value)        { localStorage.setItem(key, JSON.stringify(value)); },
  remove(key)            { localStorage.removeItem(key); },
  checkFlag(key)         { return localStorage.getItem(key) === '1'; },
  removeAll(...keys)     { for (let i = 0; i < keys.length; i++) localStorage.removeItem(keys[i]); },
};

// ── CSS Custom Property Batch Helper ──────────────────────────────
function setCSSVars(style, pairs) {
  for (let i = 0; i < pairs.length; i++) style.setProperty(pairs[i][0], pairs[i][1]);
}

// ── Boot Namespace ─────────────────────────────────────────────────
/**
 * Boot lifecycle manager. Works out of the box with zero configuration.
 * Extend via Boot.hooks without touching core code.
 *
 * Each public stage method is independently overridable:
 * @example
 * // Override wallpaper logic for a custom fork
 * Boot.applyWallpaper = (sGet) => { myDesktop.setWallpaper(sGet('wallpaperId')); };
 *
 * // Hook into the lifecycle
 * Boot.hooks.before.push(() => analytics.track('boot_start'));
 * Boot.hooks.after.push(() => myPlugin.init());
 * Boot.hooks.onError.push((err, stage) => Sentry.captureException(err, { stage }));
 */
const Boot = {

  /**
   * Lifecycle hooks. Push functions onto these arrays before boot() runs.
   *
   * - `before`  : fires before subsystem init, after recovery check
   * - `after`   : fires after the desktop or lock screen is shown
   * - `onError` : fires if a boot stage throws — receives (error, stageName)
   */
  hooks: {
    before : [],
    after  : [],
    onError: [],
  },

  /**
   * Cached DOM references. Available after boot() begins.
   * Access via Boot._dom inside hooks if needed.
   * @type {{ bootScreen, desktop, taskbar, timeEl, dateEl, vPill, rootStyle, rootClasses }|null}
   */
  _dom: null,

  /** @private Fire all hooks registered under `name`. Never throws — errors are logged. */
  _runHooks(name, ...args) {
    for (const fn of Boot.hooks[name]) {
      try { fn(...args); }
      catch (e) { console.error(`[Boot] Hook "${name}" threw:`, e); }
    }
  },

  /** @private Cache all boot-relevant DOM references once at boot start. */
  _cacheDom() {
    Boot._dom = {
      bootScreen : document.getElementById('boot-screen'),
      desktop    : document.getElementById('desktop'),
      taskbar    : document.getElementById('taskbar'),
      timeEl     : document.getElementById('tray-time'),
      dateEl     : document.getElementById('tray-date'),
      vPill      : document.getElementById('boot-version-pill'),
      rootStyle  : document.documentElement.style,
      rootClasses: document.documentElement.classList,
    };
  },

  /**
   * @private
   * Set up the stuck-boot watchdog timer. //TODO: I might remove watchdog entirely or at least improve it; it doesn't work reliably, such as not even syntax error refreshes 2 times.
   * @returns {{ complete: Function }} Call complete() when boot finishes normally.
   */
  _setupWatchdog(bootStartTime, uaShort) {
    Storage.set(KEYS.TIMEOUT, { start: bootStartTime, completed: false });

    const id = setTimeout(() => {
      const td = Storage.get(KEYS.TIMEOUT, {});
      if (!td.completed) {
        console.error('[BOOT] Stuck — timeout detected');
        Storage.set(KEYS.TIMEOUT, { start: bootStartTime, completed: false, stuck: true });
        localStorage.setItem(KEYS.FORCE, '1');
        Storage.set(KEYS.ATTEMPTS, [
          { ts: bootStartTime + BOOT_TIMEOUT_MS - 2000, reason: 'boot_timeout_1', ua: uaShort },
          { ts: bootStartTime + BOOT_TIMEOUT_MS,        reason: 'boot_timeout_2', ua: uaShort },
        ]);
        location.reload();
      }
    }, BOOT_TIMEOUT_MS);

    return {
      complete() {
        clearTimeout(id);
        const td = Storage.get(KEYS.TIMEOUT, {});
        td.completed = true;
        Storage.set(KEYS.TIMEOUT, td);
        Storage.remove(KEYS.FORCE);
      },
    };
  },

  /** @private Mirror OS.settings writes to VFS after subsystem init. */
  _patchSettingsSet() {
    const _orig = OS.settings.set.bind(OS.settings);
    let _prefsFileId = null; // cached after first successful lookup
    OS.settings.set = function settingSet(key, value) {
      _orig(key, value);
      const folderId = window.AppDirs?.getVFSDir?.('com.nbosp.settings', 'shared_prefs');
      if (!folderId) return;
      const content = JSON.stringify(OS.settings._cache, null, 2);
      if (_prefsFileId) {
        FS.writeFile(_prefsFileId, content).catch(() => {});
      } else {
        const existing = FS.listDir(folderId).find(f => f.name === 'prefs.json' && f.type === 'file');
        if (existing) {
          _prefsFileId = existing.id;
          FS.writeFile(_prefsFileId, content).catch(() => {});
        } else {
          FS.createFile(folderId, 'prefs.json', content, 'application/json')
            .then(f => { if (f?.id) _prefsFileId = f.id; })
            .catch(() => {});
        }
      }
    };
  },

  // ── Public Stage Methods ───────────────────────────────────────
  // Override any of these on the Boot object before boot() is called.
  // Each receives a bound settings getter (sGet) where settings are needed.

  /**
   * Initialize OS workers and all filesystem subsystems in parallel.
   * Throws on failure — caller routes to recovery.
   *
   * @param {boolean} isSafeMode
   */
  async initSubsystems(isSafeMode) {
    OS.workers.fs     = createWorker(FS_WORKER_CODE, 'fs');
    OS.workers.search = createWorker(SEARCH_WORKER_CODE, 'search');
    OS.workers.crypto = createWorker(CRYPTO_WORKER_CODE, 'crypto');

    // fs must init before the rest depend on it
    await OS.workers.fs.call('init');

    await OS.settings.load().then(() => {
      if (isSafeMode && typeof OS.settings.applySafeModeDefaults === 'function') {
        OS.settings.applySafeModeDefaults();
      }
    });

    await FS.init();
    await window.AppDirs?.bootstrap?.();
    await window.OPFS?.init?.();

    window.__NB_RUNTIME.ready = true;
    Boot._patchSettingsSet();
  },

  /**
   * Apply core OS variables from settings.
   * @returns {Function} sGet — bound OS.settings.get, reused by subsequent stages.
   */
  applyOSVars() {
    const sGet     = OS.settings.get.bind(OS.settings);
    OS.username    = sGet('username')  || 'user';
    OS.idleTimeout = (parseInt(sGet('autoLock')) || 10) * 60000;
    OS.lockPin     = sGet('lockPin')   || null;
    return sGet;
  },

  /**
   * Apply theme, accent colour, and all CSS custom properties in one pass.
   * @param {Function} sGet
   */
  applyThemeAndVars(sGet) {
    const { rootStyle } = Boot._dom;

    applyTheme(sGet('theme') || 'nova-dark');

    const accent = sGet('accentColor');
    if (accent) {
      setCSSVars(rootStyle, [
        ['--accent',       accent],
        ['--accent-hover', accent + 'dd'],
        ['--accent-muted', accent + '22'],
      ]);
    }

    const cssBatch   = [];
    const iconSize   = sGet('desktopIconSize');
    const gridSpace  = sGet('desktopGridSpacing');
    const tbSize     = sGet('taskbarSize');
    if (iconSize)  cssBatch.push(['--desktop-icon-size',    iconSize  + 'px']);
    if (gridSpace) cssBatch.push(['--desktop-grid-spacing', gridSpace + 'px']);
    if (tbSize) {
      const h = { compact: '36px', normal: '48px', large: '64px' }[tbSize];
      if (h) cssBatch.push(['--taskbar-height', h]);
    }
    if (sGet('reduceMotion')) cssBatch.push(['--anim-speed', '0.001']);
    if (cssBatch.length) setCSSVars(rootStyle, cssBatch);
  },

  /**
   * Apply desktop wallpaper — custom image or a named preset.
   * @param {Function} sGet
   */
  applyWallpaper(sGet) {
    const { desktop } = Boot._dom;
    if (!desktop) return;

    const customBg = sGet('customWallpaper');
    if (customBg) {
      const s = desktop.style;
      s.backgroundImage    = `url(${customBg})`;
      s.backgroundSize     = 'cover';
      s.backgroundPosition = 'center';
      s.backgroundRepeat   = 'no-repeat';
    } else {
      desktop.style.backgroundImage =
        WALLPAPER_PRESETS[sGet('wallpaperId')] ?? WALLPAPER_PRESETS['stock-blue'];
    }
  },

  /**
   * Apply accessibility settings: high contrast and reduce motion.
   * @param {Function} sGet
   */
  applyAccessibility(sGet) {
    const { rootClasses } = Boot._dom;
    const highContrast = !!sGet('highContrast');
    const removeTransparency = !!sGet('removeTransparency');
    const reduceMotion = !!sGet('reduceMotion');

    // This function is called both at boot and from settings:changed. It must
    // be symmetric: the previous version only ever added accessibility
    // classes, so turning a setting back off had no effect until a full reload.
    rootClasses.toggle('no-glass', highContrast);
    rootClasses.toggle('no-transparency', removeTransparency);
    rootClasses.toggle('reduce-motion', reduceMotion);

    const wpEl = document.getElementById('wallpaper');
    if (wpEl) wpEl.style.animation = reduceMotion ? 'none' : '';
  },

  /**
   * Apply cursor size scaling to desktop icons via an injected style tag.
   * @param {Function} sGet
   */
  applyCursorSize(sGet) {
    const cursorSize = sGet('cursorSize');
    if (!cursorSize) return;

    let st = document.getElementById('cursor-custom-styles');
    if (!st) {
      st = document.createElement('style');
      st.id = 'cursor-custom-styles';
      document.head.appendChild(st);
    }
    const t = { normal: 'scale(1)', large: 'scale(1.5)', xlarge: 'scale(2)' };
    st.textContent = `#desktop .desktop-icon{transform:${t[cursorSize] ?? t.normal}}`;
  },

  /**
   * Sync OS version between code constant, settings store, and localStorage.
   * Code version always wins.
   * @param {Function} sGet
   */
  syncVersion(sGet) {
    const { vPill } = Boot._dom;
    const codeVer   = OS.version;
    if (sGet('osVersion') !== codeVer) OS.settings.set('osVersion', codeVer);
    try { localStorage.setItem(KEYS.OS_VERSION, codeVer); } catch (_) {}
    if (vPill) vPill.textContent = 'VERSION ' + codeVer;
  },

  /**
   * Configure taskbar position, orientation, size, and auto-hide proximity detection.
   * @param {Function} sGet
   */
  configureTaskbar(sGet) {
    const { taskbar } = Boot._dom;
    if (!taskbar) return;

    const rootStyle = document.documentElement.style;
    const tbSize = sGet('taskbarSize') || 'normal';
    const tbHeight = { compact: '36px', normal: '48px', large: '64px' }[tbSize] || '48px';
    // Keep the CSS variable in sync on live settings changes as well as boot.
    // The old implementation only used the variable during applyOSVars(), so
    // changing the size in Settings updated the preference but left the actual
    // taskbar at its old height until a restart.
    rootStyle.setProperty('--taskbar-height', tbHeight);

    const tbPos = sGet('taskbarPosition') || 'bottom';

    // Lookup table: each entry is [bottom, top, left, right, width, height, flexDirection, borderLeft, borderRight]
    const TASKBAR_STYLES = {
      bottom: ['0',    'auto', '0',    '0',    '',                        '',      '',        '',                                ''],
      top   : ['auto', '0', '0',    '0',    '',                        '',      '',        '',                                ''],
      left  : ['auto', '0', '0',    'auto', 'var(--taskbar-height)',   '100vh', 'column',  '',                                '1px solid var(--taskbar-border)'],
      right : ['auto', '0', 'auto', '0',    'var(--taskbar-height)',   '100vh', 'column',  '1px solid var(--taskbar-border)', ''],
    };

    const [bottom, top, left, right, width, height, flexDirection, borderLeft, borderRight] =
      TASKBAR_STYLES[tbPos] ?? TASKBAR_STYLES.bottom;

    const s = taskbar.style;
    s.bottom        = bottom;
    s.top           = top;
    s.left          = left;
    s.right         = right;
    s.width         = width;
    s.height        = height;
    s.flexDirection = flexDirection;
    s.borderLeft    = borderLeft;
    s.borderRight   = borderRight;

    const autoHide = !!sGet('taskbarAutoHide');
    taskbar.classList.toggle('taskbar-autohide', autoHide);
    if (!autoHide) taskbar.classList.remove('taskbar-ah-shown');
    if (autoHide && !window.__tbProximityInit) {
      window.__tbProximityInit = true;
      document.addEventListener('mousemove', (e) => {
        if (!taskbar.classList.contains('taskbar-autohide')) return;
        const position = OS.settings.get('taskbarPosition') || 'bottom';
        const edge = position === 'top' ? e.clientY <= 8
          : position === 'left' ? e.clientX <= 8
          : position === 'right' ? e.clientX >= window.innerWidth - 8
          : e.clientY >= window.innerHeight - 8;
        taskbar.classList.toggle('taskbar-ah-shown', edge);
      }, { passive: true });
    }
  },

  /**
   * Initialize the global screen reader announcement helper (window.SR).
   */
  initScreenReader() {
    window.SR = {
      announce(msg) {
        let el = document.getElementById('sr-announcer');
        if (!el) {
          el = document.createElement('div');
          el.id = 'sr-announcer';
          el.setAttribute('aria-live',   'polite');
          el.setAttribute('aria-atomic', 'true');
          el.style.cssText = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0';
          document.body.appendChild(el);
        }
        el.textContent = '';
        requestAnimationFrame(() => { el.textContent = msg; });
      },
    };
  },

  /**
   * Start the window manager, notification badge, and taskbar clock.
   */
  startServices() {
    WM.init();
    updateNotificationBadge();

    const { timeEl, dateEl } = Boot._dom;
    function updateClock() {
      const now = new Date();
      if (timeEl) timeEl.textContent = formatTime(now);
      if (dateEl) dateEl.textContent = formatDate(now);
    }
    updateClock();
    setInterval(updateClock, 1000);
  },
};

// ── Main Boot Entry Point ──────────────────────────────────────────
/**
 * Main boot sequence. Called once on page load by the HTML entry point.
 * Extend via Boot.hooks — do not call this manually.
 */
async function boot() {
  Boot._cacheDom();
  const { bootScreen } = Boot._dom;
  const bootStartTime  = Date.now();
  const uaShort        = navigator.userAgent.slice(0, 80);

  // 1. Watchdog ────────────────────────────────────────────────────
  const forceRecovery = Storage.checkFlag(KEYS.FORCE);
  const watchdog      = Boot._setupWatchdog(bootStartTime, uaShort);

  // 2. Recovery Routing ────────────────────────────────────────────
  const isManualRecovery = Storage.checkFlag(KEYS.MANUAL_REC) || Storage.checkFlag(KEYS.SHOW_REC);
  if (isManualRecovery || forceRecovery) {
    Storage.removeAll(KEYS.MANUAL_REC, KEYS.SHOW_REC, KEYS.FORCE);
    showRecoveryScreen(forceRecovery ? Storage.get(KEYS.ATTEMPTS, []) : [], isManualRecovery && !forceRecovery);
    watchdog.complete();
    return;
  }

  // 3. Attempt Tracking ────────────────────────────────────────────
  const priorAttempts = Storage.get(KEYS.ATTEMPTS, []);
  const isSafeMode    = Storage.checkFlag(KEYS.SAFE_MODE);

  if (priorAttempts.length >= BOOT_THRESHOLD && !isSafeMode) {
    showRecoveryScreen(priorAttempts, false);
    watchdog.complete();
    return;
  }

  // Track this attempt — cleared immediately on subsystem success (not at end of boot)
  // so that rapid dev restarts don't accumulate toward the threshold.
  priorAttempts.push({ ts: Date.now(), ua: uaShort });
  if (priorAttempts.length > 10) priorAttempts.shift();
  Storage.set(KEYS.ATTEMPTS, priorAttempts);

  function markBootSuccess() {
    Storage.removeAll(KEYS.ATTEMPTS, KEYS.FORCE);
    watchdog.complete();
    document.body.classList.add('os-booted');
    document.getElementById('recovery-screen')?.classList.remove('active');
  }

  // 4. Safe Mode ───────────────────────────────────────────────────
  if (isSafeMode) {
    Storage.remove(KEYS.SAFE_MODE);
    document.getElementById('safe-mode-banner').style.display = 'block';
    OS._safeModeActive = true;
  }

  // 5. Pre-boot Hooks ──────────────────────────────────────────────
  Boot._runHooks('before');

  // 6. Subsystems ──────────────────────────────────────────────────
  try {
    await Boot.initSubsystems(isSafeMode);
  } catch (e) {
    console.error('[BOOT] Subsystem init failed at stage "initSubsystems":', e);
    Boot._runHooks('onError', e, 'initSubsystems');
    triggerRecovery('worker_init_failed');
    return;
  }

  // Subsystems initialised cleanly — this is not a crash loop. Clear attempts now
  // so a subsequent fast restart doesn't accumulate toward the threshold.
  Storage.remove(KEYS.ATTEMPTS);

  // 7. Settings & UI ───────────────────────────────────────────────
  const sGet = Boot.applyOSVars();
  Boot.applyThemeAndVars(sGet);
  Boot.applyWallpaper(sGet);
  Boot.applyAccessibility(sGet);
  Boot.applyCursorSize(sGet);
  Boot.syncVersion(sGet);
  Boot.configureTaskbar(sGet);
  Boot.initScreenReader();
  Boot.startServices();

  // 8. NovaApp Reconciliation ─────────────────────────────────────
  // Bundled system packages are source-of-truth content. Reconcile and
  // hydrate them BEFORE the desktop becomes launchable so a stale persisted
  // AppRegistry record can never win the race and launch an older package.
  try {
    await reconcileBundledNovaApps();
    await loadInstalledNovaApps();
  } catch (e) {
    console.error('[BOOT] Failed to reconcile/load Nova apps:', e);
  }

  if (typeof WM !== 'undefined' && typeof WM.updateTaskbar === 'function') WM.updateTaskbar();
  if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
  if (typeof renderLaunchpad === 'function') renderLaunchpad();

  // Apps are now guaranteed to reflect the current bundled package contents.
  launchAutostartApps();

  if (typeof AppScheduler !== 'undefined') {
    AppScheduler.start();
  }

  // 9. Finalize ────────────────────────────────────────────────────
  bootScreen.classList.add('fade-out');

  await new Promise(r => setTimeout(r, 400));
  bootScreen.style.display = 'none';
  markBootSuccess();
  WM.updateTaskbar();

  if (OS.lockPin) {
    lockScreen();
  } else {
    renderDesktopIcons();
  }

  // 10. Post-boot Hooks ────────────────────────────────────────────
  Boot._runHooks('after');

  // 11. Developer Mode / Debug Overlay ───────────────────────────
  if (OS.settings.get('devMode')) {
    const overlayPref = OS.settings.get('debugOverlayVisible');
    if (overlayPref !== false && window.DebugOverlay) {
      window.DebugOverlay.enable();
    }
  }

  // Freeze hooks to prevent post-boot tampering. Any script that tries to push
  // onto Boot.hooks after this point will receive a TypeError.
  try {
    Object.freeze(Boot.hooks.before);
    Object.freeze(Boot.hooks.after);
    Object.freeze(Boot.hooks.onError);
    Object.freeze(Boot.hooks);
  } catch (e) { /* non-fatal */ }
}

// ── App Loader ─────────────────────────────────────────────────────
/**
 * Re-register any .novaapp packages the user has previously installed.
 * Called at idle time after boot — safe to call manually if needed.
 */
  async function reconcileBundledNovaApps() {
    let bundles = [];
    try {
      const response = await fetch('js/apps/novaapp-manifest.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`manifest ${response.status}`);
      const parsed = await response.json();
      bundles = Array.isArray(parsed) ? parsed.filter(x => x && x.id && x.file) : [];
    } catch (e) {
      console.warn('[BOOT] Bundled NovaApp manifest unavailable:', e);
      return;
    }

    const store = window.NovaAppPackageStore;
    if (!store?.loadRegistry || !store?.saveRegistry) return;
    const trustStore = typeof TrustStore !== 'undefined' && typeof TrustStore.list === 'function' ? TrustStore.list() : [];
    const revocationCheck = typeof TrustStore !== 'undefined' && typeof TrustStore.isRevoked === 'function' ? TrustStore.isRevoked : undefined;
    let registry = store.loadRegistry();
    const bundleIds = new Set(bundles.map(b => b.id));

    const removeBundledSystem = async (id, reason) => {
      const stored = registry.find(a => a.id === id);
      if (!stored) return;
      const isBundledSystem = stored.system === true && (stored.signer === 'NovaByte System' || stored.source === 'system-bundle' || stored.manifest?.system === true);
      if (!isBundledSystem) return;
      console.warn(`[BOOT] Removing stale bundled system app (${reason}):`, id);
      try { if (store.removeApp) await store.removeApp(id, { force: true }); } catch (e) { console.warn('[BOOT] Failed removing stored package', id, e); }
      try { if (typeof AppRegistry !== 'undefined' && AppRegistry.unregisterApp) AppRegistry.unregisterApp(id); } catch (e) { console.warn('[BOOT] Failed unregistering', id, e); }
      registry = registry.filter(a => a.id !== id);
      store.saveRegistry(registry);
    };

    // Anything previously installed as a bundled system package but no longer
    // present in the current build manifest must disappear from the package
    // registry. This is what makes deleting/moving a .novaapp actually matter.
    for (const stored of registry.slice()) {
      if (stored?.system === true && (stored.signer === 'NovaByte System' || stored.source === 'system-bundle' || stored.manifest?.system === true) && !bundleIds.has(stored.id)) {
        await removeBundledSystem(stored.id, 'not present in bundled manifest');
      }
    }

    for (const bundle of bundles) {
      let pkg;
      try {
        const response = await fetch(bundle.file, { cache: 'no-store' });
        if (response.status === 404) {
          await removeBundledSystem(bundle.id, 'source file missing');
          continue;
        }
        if (!response.ok) throw new Error(`package ${response.status}`);
        pkg = await response.json();
      } catch (e) {
        console.warn('[BOOT] Failed to read bundled NovaApp', bundle.id, e);
        continue;
      }

      if (!pkg?.manifest?.id || pkg.manifest.id !== bundle.id || pkg.manifest.system !== true) {
        console.warn('[BOOT] Ignoring invalid bundled NovaApp manifest:', bundle.file);
        continue;
      }

      const stored = registry.find(a => a.id === bundle.id);
      const samePackage = stored &&
        stored.signature === pkg.signature &&
        stored.version === pkg.manifest.version &&
        stored.compiled_at === pkg.compiled_at &&
        (!pkg.integrity?.payloadHash || stored.integrity?.payloadHash === pkg.integrity.payloadHash);
      if (samePackage) continue;

      try {
        console.log('[BOOT] Reconciling bundled NovaApp:', bundle.id, pkg.manifest.version);
        await AppPackage.installPackage(pkg, { force: true, source: 'system-bundle', trustStore, revocationCheck });

        const runtimeApp = typeof AppRegistry !== 'undefined' && AppRegistry.getApp
          ? AppRegistry.getApp(bundle.id)
          : null;
        const metadata = store.toMetadata(runtimeApp || { ...pkg.manifest, files: pkg.files, signature: pkg.signature, verified: true, signer: 'NovaByte System', system: true, source: 'system-bundle', manifest: pkg.manifest, novabyte_app: pkg.novabyte_app, compiled_at: pkg.compiled_at });
        registry = registry.filter(a => a.id !== bundle.id);
        registry.push(metadata);
        store.saveRegistry(registry);
      } catch (e) {
        console.error('[BOOT] Failed to reconcile bundled NovaApp', bundle.id, e);
      }
    }
  }

  function registerWithFiles(appData) {
    if (!appData?.id || !appData.files) return;

    try {
      if (typeof window.buildNovaAppConfig !== 'function') {
        // nova-app-launcher.js loads before boot.js in index.html, so this should
        // never actually happen — but if script order ever changes, fail
        // loudly instead of silently falling back to the old incomplete
        // registration path (which is exactly how this bug shipped once).
        console.error('[BOOT] window.buildNovaAppConfig unavailable — cannot register', appData.id, 'with full launch config. Check that nova-app-launcher.js loads before boot.js.');
        return;
      }

      const cfg = window.buildNovaAppConfig(appData);
      OS.apps[appData.id] = cfg;
      const ri = APP_REGISTRY.findIndex(a => a.id === appData.id);
      if (ri > -1) APP_REGISTRY[ri] = cfg;
      else APP_REGISTRY.push(cfg);

      // Deliberately NOT calling AppRegistry.registerApp() here — it
      // unconditionally rebuilds and overwrites OS.apps[id] with its own
      // config (no files/entry), which would immediately clobber the
      // correct cfg set above. PackageStore's registry (nova_installed_apps)
      // is already the real persisted source of truth for installed apps;
      // AppRegistry's separate cache isn't load-bearing for this path.

      if (window.AppDirs && typeof window.AppDirs.ensureAppDataFolder === 'function') {
        window.AppDirs.ensureAppDataFolder(appData.id).catch(() => {});
      }
    } catch (e) {
      console.warn('[BOOT] Failed to register installed app', appData.id, e);
    }
  }

  async function refreshInstalledAppTrust(appData) {
    if (!appData?.id) return { changed: false, app: appData };
    if (appData.system === true && appData.manifest?.system === true && appData.source === 'system-bundle') {
      // Bundled system packages are re-trusted by provenance, but integrity
      // still has to match the package before the trusted runtime metadata is
      // restored. A modified bundle therefore cannot become unrestricted.
      try {
        const ok = !appData.integrity || await AppPackage.verifyIntegrity({
          novabyte_app: appData.novabyte_app,
          manifest: appData.manifest,
          files: appData.files || {},
          compiled_at: appData.compiled_at,
          integrity: appData.integrity,
        });
        if (ok) {
          appData.verified = true;
          appData.signer = 'NovaByte System';
          appData.revoked = false;
          appData.tampered = false;
          appData.system = true;
          return { changed: true, app: appData };
        }
      } catch (e) {
        console.warn('[BOOT] Bundled system integrity refresh failed for', appData.id, e);
      }
    }
    if (!appData?.signature) return { changed: false, app: appData };

    // Older App Manager installs persisted only the manifest/files/signature and
    // dropped the two top-level fields that are part of the canonical signed
    // payload (`novabyte_app` and `compiled_at`). Reconstructing a signature
    // without those exact values can never succeed. For NBOSP-bundled first-
    // party packages, recover the missing envelope fields from the bundled
    // signed package, but only when its signature is byte-for-byte identical
    // to the installed record. This is a migration aid, not a trust bypass.
    if (appData.novabyte_app == null || appData.compiled_at == null || !appData.manifest) {
      try {
        const safeId = String(appData.id).replace(/[^a-zA-Z0-9._-]/g, '_');
        const response = await fetch(`js/apps/${safeId}.novaapp`, { cache: 'no-store' });
        if (response.ok) {
          const bundled = await response.json();
          if (bundled?.signature && bundled.signature === appData.signature) {
            if (appData.novabyte_app == null && bundled.novabyte_app != null) appData.novabyte_app = bundled.novabyte_app;
            if (appData.compiled_at == null && bundled.compiled_at != null) appData.compiled_at = bundled.compiled_at;
            if (!appData.manifest && bundled.manifest) appData.manifest = bundled.manifest;
          }
        }
      } catch (e) {
        console.warn('[BOOT] Could not recover legacy package envelope for', appData.id, e);
      }
    }
    if (typeof AppPackage === 'undefined' || typeof AppPackage.verifyAgainstTrustStore !== 'function' || typeof TrustStore === 'undefined' || typeof TrustStore.list !== 'function') {
      return { changed: false, app: appData };
    }

    try {
      const pkg = {
        novabyte_app: appData.novabyte_app || 1,
        manifest: appData.manifest || {
          id: appData.id, name: appData.name, version: appData.version, entry: appData.entry,
          description: appData.description, author: appData.author, icon: appData.icon,
          type: appData.type, permissions: appData.permissions || [],
          optionalPermissions: appData.optionalPermissions || [],
          defaultSize: appData.defaultSize, minSize: appData.minSize, maxSize: appData.maxSize,
          resizable: appData.resizable, frame: appData.frame, categories: appData.categories,
          handles: appData.handles
        },
        files: appData.files || {},
        signature: appData.signature,
        compiled_at: appData.compiled_at,
        signing: appData.signing || undefined,
        integrity: appData.integrity || null,
      };
      const revocationCheck = typeof TrustStore.isRevoked === 'function' ? TrustStore.isRevoked : undefined;
      const result = await AppPackage.verifyAgainstTrustStore(pkg, TrustStore.list(), revocationCheck);
      const verified = !!result.trusted && !result.revoked;
      const signer = verified ? (result.signer || null) : null;
      const system = verified && signer === 'NovaByte System' && appData?.manifest?.system === true;
      const changed = appData.verified !== verified ||
        (appData.signer || null) !== signer ||
        (!!appData.revoked) !== !!result.revoked ||
        appData.system !== system;
      if (changed) {
        appData.verified = verified;
        appData.signer = signer;
        appData.revoked = !!result.revoked;
        appData.system = system;
        if (verified) appData.tampered = false;
      }
      return { changed, app: appData };
    } catch (e) {
      console.warn('[BOOT] Trust refresh failed for', appData.id, e);
      return { changed: false, app: appData };
    }
  }

  async function loadInstalledNovaApps() {
    const storedApps = Storage.get(KEYS.INSTALLED_APPS, []);
    const apps = window.NovaAppPackageStore?.hydrateApps
      ? await NovaAppPackageStore.hydrateApps(storedApps)
      : storedApps;

    let trustRegistryChanged = false;
    for (let i = 0; i < apps.length; i++) {
      const appData = apps[i];
      if (!appData.files) {
        console.warn('[BOOT] Installed package files missing for', appData.id);
        continue;
      }

      // Re-evaluate trust at startup instead of blindly trusting the cached
      // `verified` boolean from a previous install. This repairs stale
      // `verified:false` metadata after a correctly signed package is
      // reinstalled, and catches a signature that no longer matches the
      // stored package before the app is exposed as trusted.
      const trust = await refreshInstalledAppTrust(appData);
      trustRegistryChanged = trustRegistryChanged || trust.changed;

      if (OS.apps[appData.id] && APP_REGISTRY.some(a => a.id === appData.id)) continue;
      registerWithFiles(appData);
    }

    if (trustRegistryChanged && window.NovaAppPackageStore?.saveRegistry) {
      try {
        NovaAppPackageStore.saveRegistry(apps);
      } catch (e) {
        console.warn('[BOOT] Failed to persist refreshed package trust state:', e);
      }
    }

    // ── Post-install revocation re-check ──────────────────────────
    // verifyAgainstTrustStore only ever ran once, at install time. If
    // NovaByte revokes a signature *after* someone already installed
    // that app, nothing previously re-checked it — the app just kept
    // running as "verified" forever, silently. This scan runs on every
    // boot so a newly-revoked app gets surfaced the next time NBOSP
    // starts, regardless of whether App Manager is ever opened.
    scanForRevokedApps(apps).catch(e =>
      console.error('[BOOT] Revocation scan failed:', e));
  }

  /**
   * Launch every app the user has opted into "start at boot" (nova_boot_apps,
   * set via App Manager's boot toggle — see the App Manager package's getBootApps/
   * setBootApps) AND that separately holds the system:autostart grant.
   *
   * Both conditions matter and neither substitutes for the other:
   *  - nova_boot_apps is the user's own preference ("open this for me"),
   *    stored per-app, not a security boundary — a malicious app can't get
   *    itself into this list, only the user's own App Manager toggle does.
   *  - system:autostart is the permission grant. An app the user asked to
   *    autostart still needs to actually hold the grant, same as any other
   *    permission — a boot-list entry is not itself authorization. This
   *    also protects against nova_boot_apps having been populated by some
   *    older/different mechanism before this permission existed; a stale
   *    boot-list entry alone is never enough to launch something.
   *
   * Deliberately skipped if the lock screen is showing (OS.lockPin set):
   * autostart is real, silent app execution with no user present yet to
   * consent to or even see it happening, which is exactly the case
   * system:autostart is supposed to be the bigger, explicit ask for — it
   * shouldn't quietly happen before the user has even unlocked the
   * session. Apps on the list simply launch once the desktop actually
   * shows (lockScreen()'s own unlock flow doesn't currently re-trigger
   * this pass; that's a reasonable follow-up if it becomes an issue, not
   * something silently assumed to be covered here).
   */
  function launchAutostartApps() {
    if (OS.lockPin) return;

    let bootAppIds;
    try {
      bootAppIds = JSON.parse(localStorage.getItem('nova_boot_apps') || '[]');
    } catch {
      bootAppIds = [];
    }
    if (!Array.isArray(bootAppIds) || bootAppIds.length === 0) return;

    let disabled;
    try {
      disabled = JSON.parse(localStorage.getItem('nova_disabled_apps') || '[]')
        .map(x => (typeof x === 'string' ? x : x?.id))
        .filter(Boolean);
    } catch {
      disabled = [];
    }

    let staleEntryRemoved = false;
    for (const appId of bootAppIds) {
      if (typeof appId !== 'string' || !appId) continue;
      if (disabled.includes(appId)) continue;
      if (!OS.apps[appId]) continue; // not installed (or not yet registered)

      const hasGrant = typeof AppPermissionManager !== 'undefined' &&
        AppPermissionManager.isGranted('system:autostart', appId);
      if (!hasGrant) {
        // The grant was revoked (Permissions section) or expired (30-day
        // unused-app sweep) since this app was added to the boot list.
        // Don't just skip silently forever — drop the stale entry so App
        // Manager's toggle reflects reality next time it's opened, instead
        // of showing "Starts at Boot" for something that will never
        // actually launch again without the user re-granting it.
        bootAppIds = bootAppIds.filter(id => id !== appId);
        staleEntryRemoved = true;
        continue;
      }

      try {
        WM.createWindow(appId);
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'Boot', category: 'apps', severity: 'info', message: `Autostarted ${appId}`, data: { appId } });
        }
      } catch (err) {
        console.warn('[BOOT] Autostart failed for', appId, err);
      }
    }

    if (staleEntryRemoved) {
      try { localStorage.setItem('nova_boot_apps', JSON.stringify(bootAppIds)); } catch { /* quota */ }
    }
  }

  /**
   * Check every installed, signed app against TrustStore.isRevoked and
   * surface a removal dialog for each one currently on the revocation
   * list — every boot, not just the first time it's discovered. Shown
   * sequentially, one at a time, after the desktop is up rather than
   * blocking boot itself.
   */
  async function scanForRevokedApps(apps) {
    if (typeof TrustStore === 'undefined' || typeof TrustStore.isRevoked !== 'function') return;

    // NOTE: deliberately does NOT filter out a.revoked here. revoked is
    // persisted permanently once flagged (see markAppRevokedInStorage,
    // used for the App Manager badge), but the dialog itself must keep
    // firing every boot regardless of that flag — otherwise clicking
    // Cancel once (which sets revoked=true) would silently make this a
    // one-time-only warning, which is exactly the quiet-forever behavior
    // this feature exists to prevent. The only thing that should stop
    // the dialog from reappearing is the app actually being removed.
    const revokedApps = apps.filter(a =>
      a && a.id && a.signature && TrustStore.isRevoked(a.signature));

    if (revokedApps.length === 0) return;

    // Wait for the desktop/boot animation to settle so the dialog
    // doesn't fight with boot-screen fade-out/lock-screen transitions.
    await new Promise(r => setTimeout(r, 1200));

    for (const appData of revokedApps) {
      // Deliberately sequential (await inside loop) — showing several of
      // these stacked at once would be confusing; one decision at a time.
      const revocation = typeof TrustStore.getRevocation === 'function'
        ? TrustStore.getRevocation(appData.signature)
        : null;
      const remove = await showRevokedAppRemovalDialog(appData, revocation);
      if (remove) {
        await removeRevokedApp(appData.id);
      } else {
        // Persist the revoked flag so the rest of the UI (e.g. App
        // Manager's package details panel) can reflect it accurately,
        // WITHOUT suppressing this dialog on future boots — the whole
        // point is this keeps surfacing until the user acts, the same
        // way a browser keeps warning about a disabled/malicious
        // extension rather than mentioning it once and going quiet.
        markAppRevokedInStorage(appData.id);
      }
    }
  }

  function markAppRevokedInStorage(appId) {
    try {
      const list = Storage.get(KEYS.INSTALLED_APPS, []);
      const idx = list.findIndex(a => a.id === appId);
      if (idx > -1 && !list[idx].revoked) {
        list[idx] = { ...list[idx], revoked: true };
        Storage.set(KEYS.INSTALLED_APPS, list);
      }
      if (window.NovaAppPackageStore?.saveRegistry && window.NovaAppPackageStore?.loadRegistry) {
        const reg = NovaAppPackageStore.loadRegistry();
        const ri = reg.findIndex(a => a.id === appId);
        if (ri > -1 && !reg[ri].revoked) {
          reg[ri] = { ...reg[ri], revoked: true };
          NovaAppPackageStore.saveRegistry(reg);
        }
      }
    } catch (e) {
      console.warn('[BOOT] Failed to persist revoked flag for', appId, e);
    }
  }

  async function removeRevokedApp(appId) {
    try {
      delete OS.apps[appId];
      const ri = APP_REGISTRY.findIndex(a => a.id === appId);
      if (ri > -1) APP_REGISTRY.splice(ri, 1);
      if (typeof AppRegistry !== 'undefined' && AppRegistry.unregisterApp) {
        AppRegistry.unregisterApp(appId);
      }
      if (window.NovaAppPackageStore?.removeApp) {
        await NovaAppPackageStore.removeApp(appId);
      } else {
        const list = Storage.get(KEYS.INSTALLED_APPS, []).filter(a => a.id !== appId);
        Storage.set(KEYS.INSTALLED_APPS, list);
      }
      if (typeof WM !== 'undefined' && WM.updateTaskbar) WM.updateTaskbar();
      if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
      console.warn('[BOOT] Removed app with revoked signature:', appId);
    } catch (e) {
      console.error('[BOOT] Failed to remove revoked app', appId, e);
    }
  }

  /**
   * Dialog shown when boot discovers an app whose signature has been
   * revoked SINCE it was installed (as opposed to the App Manager's
   * showUntrustedAppDialog, which only ever runs at install time and
   * offers "Cancel" / "Install Anyway"). This one only ever offers
   * "Remove" / "Cancel" — there's no "install anyway" equivalent here,
   * because the app is already installed and running; the only two
   * outcomes that make sense are taking it out, or acknowledging the
   * warning and leaving it for now (which will nag again next boot).
   */
  function showRevokedAppRemovalDialog(appData, revocation) {
    return new Promise(resolve => {
      const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui,sans-serif);';

      const backdrop = document.createElement('div');
      backdrop.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.65);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);';

      const box = document.createElement('div');
      box.style.cssText = 'position:relative;background:var(--bg-elevated,#1e1e1e);border:1px solid var(--border,#333);border-radius:14px;max-width:520px;width:94%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.04) inset;';

      const safeName = escapeHtml(appData.name || appData.id || 'This app');
      const safeId = escapeHtml(appData.id || '');
      const safeVersion = escapeHtml(appData.version || 'unknown');
      // NovaByte's own reason for revoking is genuinely useful context for
      // deciding whether to remove — surface it verbatim when set, rather
      // than only the generic "why re-checks happen at all" explanation.
      const safeReason = escapeHtml(revocation?.reason || '');
      const cautionBorderColor = 'rgba(248,81,73,0.35)';
      const cautionBgColor = 'rgba(248,81,73,0.1)';
      const cautionDotColor = '#f85149';

      box.innerHTML = `
        <div style="padding:20px 24px 16px;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,0.06));display:flex;align-items:flex-start;gap:14px;">
          <div style="width:44px;height:44px;border-radius:12px;background:var(--bg-inset,rgba(255,255,255,0.04));border:1px solid ${cautionBorderColor};display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px;line-height:1;">\uD83D\uDD34</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:15px;font-weight:700;color:var(--text-primary,#eee);margin-bottom:5px;letter-spacing:-0.01em;">An Installed App Was Revoked</div>
            <div style="font-size:13px;color:var(--text-secondary,#bbb);line-height:1.55;">
              <b>${safeName}</b>${safeId ? ` <span style="color:var(--text-muted,#888);">(${safeId})</span>` : ''} was already installed and trusted, but its signature has since been pulled from NovaByte OS's trust list.
              This is different from an install-time warning — this app has actually been running on your system since it was first installed.
            </div>
          </div>
        </div>

        <div style="padding:16px 24px;display:flex;flex-direction:column;gap:10px;">
          <div style="display:flex;align-items:flex-start;gap:10px;padding:12px;background:${cautionBgColor};border:1px solid ${cautionBorderColor};border-radius:8px;">
            <div style="width:6px;height:6px;border-radius:50%;background:${cautionDotColor};flex-shrink:0;margin-top:7px;box-shadow:0 0 6px ${cautionDotColor};"></div>
            <div style="font-size:12.5px;color:var(--text-secondary,#ccc);line-height:1.55;">
              <div style="font-weight:600;margin-bottom:4px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted,#999);">Why this happened</div>
              A signature is normally only checked when an app is installed. NovaByte OS now also re-checks every installed app's signature each time it starts up, so revocations that happen after install — for example if this package was later found to be harmful, deceptive, or non-compliant — can still be caught.
            </div>
          </div>

          <div style="padding:14px;background:var(--bg-inset,rgba(255,255,255,0.03));border:1px solid var(--border-subtle,rgba(255,255,255,0.06));border-radius:8px;">
            <div style="display:flex;flex-direction:column;gap:7px;font-size:12.5px;color:var(--text-secondary,#bbb);line-height:1.5;">
              <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Package ID</span><span style="font-weight:500;color:var(--text-primary,#eee);text-align:right;word-break:break-all;">${safeId || 'unknown'}</span></div>
              <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Version</span><span style="font-weight:500;color:var(--text-primary,#eee);">${safeVersion}</span></div>
              <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Signature</span><span style="font-weight:500;color:var(--text-primary,#eee);">present, but revoked by NovaByte OS since install</span></div>
              ${safeReason ? `<div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-muted,#999);">Revocation reason</span><span style="font-weight:500;color:var(--text-primary,#eee);text-align:right;">${safeReason}</span></div>` : ''}
            </div>
            <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border-subtle,rgba(255,255,255,0.06));font-size:12px;color:var(--text-muted,#999);line-height:1.6;">
              If you keep this app installed, NovaByte OS will show this warning again the next time it starts, until it's removed. Removing it now uninstalls the app and its data folder.
            </div>
          </div>
        </div>

        <div style="padding:12px 24px 16px;border-top:1px solid var(--border-subtle,rgba(255,255,255,0.06));background:var(--bg-sunken,rgba(0,0,0,0.15));display:flex;align-items:center;justify-content:flex-end;gap:8px;">
          <button id="nb-revoked-cancel-btn" style="background:none;border:1px solid var(--border-subtle,rgba(255,255,255,0.15));color:var(--text-primary,#eee);padding:7px 16px;border-radius:7px;font-size:12.5px;cursor:pointer;transition:all 0.12s;font-weight:500;">Cancel</button>
          <button id="nb-revoked-remove-btn" style="background:rgba(248,81,73,0.15);border:1px solid rgba(248,81,73,0.4);color:#f85149;padding:7px 16px;border-radius:7px;font-size:12.5px;cursor:pointer;transition:all 0.12s;font-weight:700;">Remove App</button>
        </div>
      `;

      const styleEl = document.createElement('style');
      styleEl.textContent = `
        #nb-revoked-cancel-btn:hover { background:var(--bg-elevated,#2a2a2a);border-color:var(--border,#555); }
        #nb-revoked-remove-btn:hover { background:rgba(248,81,73,0.25);border-color:rgba(248,81,73,0.5);box-shadow:0 0 12px rgba(248,81,73,0.15); }
        #nb-revoked-remove-btn:active, #nb-revoked-cancel-btn:active { transform:scale(0.97); }
      `;
      document.head.appendChild(styleEl);

      overlay.appendChild(backdrop);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const cleanup = () => { overlay.remove(); styleEl.remove(); };

      box.querySelector('#nb-revoked-cancel-btn').addEventListener('click', () => {
        cleanup();
        resolve(false);
      });
      box.querySelector('#nb-revoked-remove-btn').addEventListener('click', () => {
        cleanup();
        resolve(true);
      });
      // Deliberately NOT dismissible by clicking the backdrop — this is a
      // security notice about an app already running on the system, not
      // a casual install prompt; it should require an explicit choice.
    });
  }

// ── Global Exports ─────────────────────────────────────────────────
window.boot = boot;
window.Boot = Boot; // expose namespace so plugins/forks can hook in