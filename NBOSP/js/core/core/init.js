// Frame-busting guard for clickjacking resistance.
// Fix CVE-NB-2026-009-H1: this used to clear document.body.innerHTML on
// failure, which is itself an XSS sink. Hiding via style does the same job
// visually without touching innerHTML.
if (window.top !== window.self) {
  try {
    window.top.location = window.self.location.href;
  } catch (e) {
    // cross-origin frame, can't navigate the parent — just hide our content
    const hide = () => { if (document.body) document.body.style.display = 'none'; };
    document.addEventListener('DOMContentLoaded', hide);
    hide(); // in case DOMContentLoaded already fired before this ran
  }
}

// Make sure localStorage always exists, even in sandboxed/private contexts
// where it can be missing entirely or present-but-throwing on write.
if (typeof localStorage === 'undefined') {
  const memStore = new Map();
  window.localStorage = {
    getItem: (key) => memStore.get(key) ?? null,
    setItem: (key, value) => { memStore.set(key, String(value)); },
    removeItem: (key) => { memStore.delete(key); },
    clear: () => { memStore.clear(); },
    key: (index) => Array.from(memStore.keys())[index] ?? null,
    get length() { return memStore.size; }
  };
} else {
  // localStorage can exist but still throw on write (Safari private mode,
  // some sandboxed iframes) — actually test it instead of assuming.
  try {
    const testKey = '__novabyte_test__';
    localStorage.setItem(testKey, '1');
    localStorage.removeItem(testKey);
  } catch (e) {
    const originalLS = localStorage;
    const memStore = new Map();
    window.localStorage = {
      getItem: (key) => {
        try {
          return originalLS.getItem(key) ?? memStore.get(key) ?? null;
        } catch (err) {
          return memStore.get(key) ?? null;
        }
      },
      setItem: (key, value) => {
        try {
          originalLS.setItem(key, String(value));
        } catch (err) {
          // real storage is blocked, memory fallback below still gets written
        }
        memStore.set(key, String(value));
      },
      removeItem: (key) => {
        try {
          originalLS.removeItem(key);
        } catch (err) { }
        memStore.delete(key);
      },
      clear: () => {
        try {
          originalLS.clear();
        } catch (err) { }
        memStore.clear();
      },
      key: (index) => Array.from(memStore.keys())[index] ?? null,
      get length() { return memStore.size; }
    };
  }
}

// Fix CVE-NB-2026-009-M3: block writes of actual credenital material to
// localStorage, since it's readable by any XSS payload on the page. The
// regex targets patterns that are almost always secrets — password, private
// key, API key — and deliberately skips overloaded terms like "session" or
// "token" that also show up in non-secret internal state (counters, expiry
// flags, recovery ids).
(function () {
  const SECRET = /^.*(password|private.?key|secret.?key|apikey|api_key|credential).*$/i;
  const realSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (key, value) {
    if (SECRET.test(key)) {
      const msg = `[NovaByte] SECURITY: Refusing to store key "${key}" in localStorage (XSS-readable). Use a server-side session instead.`;
      console.error(msg);
      throw new Error(msg);
    }
    return realSet(key, value);
  };
})();

// Fix CVE-NB-2026-009-L2: swapped 36 inline onclick= attributes for
// data-fn + delegated click handling. Dynamic onclick= inside JS template
// literals elsewhere in the app are tracked separately, this only covers
// the static markup.
document.addEventListener('DOMContentLoaded', function () {
  document.addEventListener('click', function (e) {
    const target = e.target.closest('[data-fn]');
    if (!target?.dataset.fn) return;
    const fn = window[target.dataset.fn];
    if (typeof fn === 'function') fn();
  });
});

// Fix CVE-NB-2026-009-H6: mute console output in production so DevTools
// doesn't leak internal paths, state, or API endpoints to anyone poking
// around. console.error stays on — errors need to surface regardless.
// Set window.__NOVA_DEBUG = true before this script runs to turn it back on.
(function () {
  if (!window.__NOVA_DEBUG) {
    const noop = () => { };
    ['log', 'info', 'warn', 'debug', 'group', 'groupEnd', 'groupCollapsed', 'table', 'dir'].forEach((method) => {
      try { console[method] = noop; } catch (e) { }
    });
  }
})();

// Default boot config for NBOSP.
function getBootConfig() {
  return {
    bootEntries: [
      { id: 'default', name: 'NovaByte (Default)', kernel: 'kernel.efi', initrd: 'initrd.img', options: 'quiet splash vga=791', default: true, enabled: true, bootOrder: 1, advanced: { acpi: true, smp: true, firewire: false, usb3: true } },
      { id: 'recovery', name: 'Recovery Mode', kernel: 'kernel.efi', initrd: 'initrd.img', options: 'single recovery rd.break', default: false, enabled: true, bootOrder: 2, advanced: { acpi: true, smp: false, firewire: false, usb3: false } }
    ],
    default: 'default',
    timeout: 30,
    quietBoot: false,
    debugMode: false,
    safeMode: false,
    lastModified: new Date().toISOString()
  };
}

// This runs before the main script so it can catch syntax errors in it.
(function () {
  const RECOVERY_FORCE_KEY = 'nova_force_recovery';
  const BOOT_TIMEOUT_MS = 15000;
  const MANUAL_RECOVERY_KEY = 'nova_manual_recovery';

  // user clicked "Boot to Recovery" in settings last session
  const isManualRecovery = localStorage.getItem(MANUAL_RECOVERY_KEY) === '1';

  if (isManualRecovery) {
    console.log('[BOOT] Manual recovery boot - showing recovery screen directly');
    localStorage.removeItem(MANUAL_RECOVERY_KEY);
    localStorage.removeItem('nova_boot_attempts');
    localStorage.setItem('nova_show_recovery', '1');
    return; // skip the stuck-boot detection below, we're going to recovery anyway
  }

  if (localStorage.getItem(RECOVERY_FORCE_KEY) === '1') {
    console.log('[CRITICAL] Previous boot was stuck/broken - showing recovery boot animation');
    localStorage.removeItem(RECOVERY_FORCE_KEY);

    // Self-contained recovery animation — can't call showRecoveryScreen()
    // from the main script since that's the thing that might be broken.
    setTimeout(function () {
      const anim = document.createElement('div');
      anim.id = 'recovery-boot-anim';
      anim.innerHTML = [
        '<div class="rba-scanlines"></div>',
        '<div class="rba-glow"></div>',
        '<div class="rba-content">',
        '<div class="rba-logo-wrap">',
        '<div class="rba-logo-ring"></div>',
        '<div class="rba-logo-ring-2"></div>',
        '<div class="rba-logo-hex">',
        '<svg width="36" height="36" viewBox="0 0 36 36" fill="none">',
        '<polygon points="18,3 33,10.5 33,25.5 18,33 3,25.5 3,10.5" fill="none" stroke="#ff6b35" stroke-width="1.5" opacity="0.8"/>',
        '<text x="18" y="23" text-anchor="middle" font-size="13" font-weight="700" fill="#ffd700" font-family="monospace">NB</text>',
        '</svg>',
        '</div>',
        '</div>',
        '<div class="rba-title">NovaByte</div>',
        '<div class="rba-subtitle">\u26a0 Recovery Mode</div>',
        '<div class="rba-log" id="rba-log"></div>',
        '<div class="rba-bar-wrap"><div class="rba-bar" id="rba-bar"></div></div>',
        '<div class="rba-status" id="rba-status">Initializing recovery environment\u2026</div>',
        '</div>'
      ].join('');
      document.body.appendChild(anim);

      const rbaLog = document.getElementById('rba-log');
      const rbaBar = document.getElementById('rba-bar');
      const rbaStatus = document.getElementById('rba-status');
      let step = 0;
      const steps = [
        { msg: '[ RECOVERY MODE TRIGGERED ]', cls: 'warn', pct: 8, label: 'Loading recovery kernel\u2026' },
        { msg: '\u2713 Recovery environment loaded', cls: 'ok', pct: 22, label: 'Mounting storage\u2026' },
        { msg: '\u2713 localStorage integrity check\u2026', cls: 'ok', pct: 38, label: 'Checking data\u2026' },
        { msg: '\u26a0 Boot failure detected \u2014 entering recovery', cls: 'warn', pct: 60, label: 'Preparing interface\u2026' },
        { msg: '\u2713 Recovery UI ready', cls: 'ok', pct: 88, label: 'Almost ready\u2026' },
        { msg: '\u2713 Handoff to Recovery Environment', cls: 'info', pct: 100, label: 'Done.' }
      ];

      function runStep() {
        if (step >= steps.length) {
          setTimeout(function () {
            anim.classList.add('fade-out');
            setTimeout(function () { anim.remove(); }, 650);

            const screen = document.getElementById('recovery-screen');
            if (screen) {
              screen.classList.add('active');
              const attemptEl = document.getElementById('rec-attempt-count');
              const tsEl = document.getElementById('rec-timestamp');
              if (attemptEl) attemptEl.textContent = '2+';
              if (tsEl) tsEl.innerHTML = '<strong>Boot Failure Detected</strong>';

              // auto-boot countdown, cancels itself on the first click/keypress
              let countdown = 15;
              const cdownNum = document.getElementById('rec-cdown-num');
              const cdownBar = document.getElementById('rec-cdown-bar');
              const cdownBlock = document.getElementById('rec-countdown-block');
              if (cdownNum && cdownBar) {
                const timer = setInterval(function () {
                  countdown--;
                  cdownNum.textContent = countdown;
                  cdownBar.style.width = ((countdown / 15) * 100) + '%';
                  if (countdown <= 0) clearInterval(timer);
                }, 1000);
                ['click', 'keydown'].forEach(function (ev) {
                  document.addEventListener(ev, function () {
                    clearInterval(timer);
                    if (cdownBlock) cdownBlock.style.opacity = '0.4';
                  }, { once: true });
                });
              }
            }
          }, 300);
          return;
        }
        const s = steps[step++];
        rbaBar.style.width = s.pct + '%';
        rbaStatus.textContent = s.label;
        const line = document.createElement('div');
        line.className = 'rba-log-line ' + (s.cls || '');
        line.textContent = s.msg;
        rbaLog.appendChild(line);
        rbaLog.scrollTop = rbaLog.scrollHeight;
        setTimeout(runStep, step === 1 ? 250 : 320);
      }
      setTimeout(runStep, 180);
    }, 100);
    return;
  }

  // Track which app broke so it can be disabled instead of taking the
  // whole OS down. Keyed by id, not appended blindly — a flaky app that
  // fails every boot should update its one entry, not pile up duplicates.
  function disableAppByPath(src) {
    try {
      const id = src.split('/js/apps/').pop().split('.')[0];
      const map = {
        search: 'nbosp-search', browser: 'com.nbosp.browser', contacts: 'nbosp-contacts',
        email: 'com.nbosp.email', calendar: 'nbosp-calendar', settings: 'nbosp-settings',
        clock: 'com.nbosp.clock', appmanager: 'com.nbosp.appmanager', calculator: 'nbosp-calculator',
        files: 'nbosp-files', gallery: 'nbosp-gallery', downloads: 'nbosp-downloads',
        textedit: 'nbosp-textedit', terminal: 'nbosp-terminal', music: 'nbosp-music'
      };
      const appId = id ? (map[id] || id) : null;
      if (!appId) return;

      const existing = JSON.parse(localStorage.getItem('nova_disabled_apps') || '[]');
      const withoutThisApp = existing.filter((entry) => entry.id !== appId);
      localStorage.setItem('nova_disabled_apps', JSON.stringify([
        ...withoutThisApp,
        { id: appId, reason: 'broken: ' + src, ts: Date.now() }
      ]));
    } catch (e) { }
  }

  window.addEventListener('error', function (e) {
    const msg = e.message || '';
    if (!msg.includes('SyntaxError') && !msg.includes('Unexpected token')) return;

    const src = e.filename || e.target?.src || '';
    if (src.includes('/js/apps/')) {
      console.warn('[AppLoader] Skipping broken app file:', src, msg);
      disableAppByPath(src);
      return;
    }
    console.error('[CRITICAL] Syntax error in core file:', src, msg);
    localStorage.setItem(RECOVERY_FORCE_KEY, '1');
    localStorage.setItem('nova_boot_attempts', JSON.stringify([
      { ts: Date.now() - 2000, reason: 'syntax_error_1', ua: navigator.userAgent.slice(0, 80) },
      { ts: Date.now(), reason: 'syntax_error_2', ua: navigator.userAgent.slice(0, 80) }
    ]));
    location.reload();
  });

  const config = getBootConfig();
  if (config.default === 'recovery') {
    localStorage.setItem('nova_show_recovery', '1');
  }

  // If boot() hasn't finished within BOOT_TIMEOUT_MS, assume it's stuck and
  // force recovery. Cleared on both outcomes — success and failure — so this
  // doesn't keep polling every 2 seconds for the rest of the tab's life.
  const bootStartTime = Date.now();
  window._bootStartTime = bootStartTime;

  const watchdog = setInterval(function () {
    const bootScreen = document.getElementById('boot-screen');
    const hasCompleted = document.body.classList.contains('os-booted');

    if (hasCompleted) {
      clearInterval(watchdog);
      return;
    }

    if (Date.now() - bootStartTime > BOOT_TIMEOUT_MS && bootScreen) {
      clearInterval(watchdog);
      console.error('[CRITICAL] Boot timeout - stuck detection');
      localStorage.setItem(RECOVERY_FORCE_KEY, '1');
      localStorage.setItem('nova_boot_attempts', JSON.stringify([
        { ts: Date.now() - 2000, reason: 'boot_timeout_1', ua: navigator.userAgent.slice(0, 80) },
        { ts: Date.now(), reason: 'boot_timeout_2', ua: navigator.userAgent.slice(0, 80) }
      ]));
      location.reload();
    }
  }, 2000);
})();

function recLog(msg, cls = '') {
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  function makeLogLine() {
    const line = document.createElement('div');
    line.className = 'recovery-log-line' + (cls ? ' ' + cls : '');
    const tsSpan = document.createElement('span');
    tsSpan.className = 'recovery-log-ts';
    tsSpan.textContent = ts;
    const msgSpan = document.createElement('span');
    msgSpan.className = 'recovery-log-msg';
    msgSpan.textContent = msg;
    line.append(tsSpan, msgSpan);
    return line;
  }
  // same line goes to both the main log panel and the terminal page,
  // they're separate DOM elements so each needs its own copy
  const mainEl = document.getElementById('rec-diag-lines');
  if (mainEl) {
    mainEl.appendChild(makeLogLine());
    mainEl.parentElement.scrollTop = mainEl.parentElement.scrollHeight;
  }
  const termEl = document.getElementById('rec-term-lines');
  if (termEl) {
    termEl.appendChild(makeLogLine());
    termEl.scrollTop = termEl.scrollHeight;
  }
}

function initRecoveryUI() {
  const clockEl = document.getElementById('rec-clock');
  if (clockEl) {
    const tick = () => clockEl.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
    tick();
    setInterval(tick, 1000);
  }

  try {
    const lsSize = new Blob([JSON.stringify(localStorage)]).size;
    const setSysInfo = (id, val, cls) => {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = val;
        if (cls) el.className = 'recovery-sysinfo-value ' + cls;
      }
    };
    setSysInfo('rec-si-storage', lsSize > 0 ? (lsSize / 1024).toFixed(1) + ' KB' : '0 KB', lsSize > 500000 ? 'warn' : 'ok');
    const hasSettings = !!localStorage.getItem('nova_settings');
    setSysInfo('rec-si-settings', hasSettings ? 'Found' : 'Missing', hasSettings ? 'ok' : 'warn');
    const attempts = JSON.parse(localStorage.getItem('nova_boot_attempts') || '[]');
    setSysInfo('rec-si-boots', attempts.length + ' attempt(s)', attempts.length >= 3 ? 'err' : attempts.length >= 1 ? 'warn' : 'ok');
  } catch (e) { }

  recLog('NovaByte Recovery Environment initialized', 'info');
  recLog('Scanning storage...', 'info');
  try {
    const keys = Object.keys(localStorage);
    recLog(`localStorage: ${keys.length} key(s) · ${new Blob([JSON.stringify(localStorage)]).size} bytes`, 'ok');
    ['nova_settings', 'nova_boot_attempts'].forEach((k) => {
      const v = localStorage.getItem(k);
      recLog((v ? '✓' : '✗') + ' ' + k + (v ? ': ' + v.length + ' chars' : ': not found'), v ? 'ok' : 'warn');
    });
  } catch (e) {
    recLog('Storage read error: ' + e.message, 'err');
  }
  recLog('Select a recovery option to continue.', 'info');

  // bottom console bar — this is the only place that listens on this
  // input, _recRender used to attach a second keyup handler here too but
  // it never actually fired since this keydown handler always empties
  // the field first
  const inp = document.getElementById('rec-console-input');
  if (inp) {
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const cmd = inp.value.trim();
      inp.value = '';
      if (cmd) handleConsoleCmd(cmd);
    });
  }

  // separate input on the full terminal page view
  const termInp = document.getElementById('rec-term-cmd-input');
  if (termInp) {
    termInp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const cmd = termInp.value.trim();
      termInp.value = '';
      if (cmd) handleConsoleCmd(cmd);
    });
  }
}

function handleConsoleCmd(cmd) {
  const cw = document.getElementById('rec-console-wrap');
  if (cw) cw.classList.add('active');
  recLog('$ ' + cmd, 'info');
  const c = cmd.toLowerCase().trim();

  const cmds = {
    help: () => {
      const lines = [
        '─────────────────────────────',
        'NovaByte Recovery Terminal',
        '─────────────────────────────',
        'NAVIGATION',
        '  nav <page>      — go to page (home/tools/data/advanced)',
        '  back            — go back',
        'SYSTEM',
        '  status          — full system status',
        '  ls              — list localStorage keys',
        '  get <key>       — read a localStorage key',
        '  set <key> <val> — write a localStorage key',
        '  del <key>       — delete a localStorage key',
        '  env             — environment info',
        '  meminfo         — JS heap memory',
        'RECOVERY',
        '  clear-boot      — clear boot attempt counter',
        '  clear-cache     — flush all caches',
        '  safe            — reboot to safe mode',
        '  continue        — boot normally',
        '  factory         — factory reset (asks confirmation)',
        'LOG',
        '  clear           — clear log panel',
        '─────────────────────────────'
      ];
      lines.forEach((l) => recLog(l, l.startsWith('─') ? 'info' : l.match(/^  /) ? '' : 'warn'));
    },

    status: () => {
      const attempts = JSON.parse(localStorage.getItem('nova_boot_attempts') || '[]');
      const lsSize = new Blob([JSON.stringify(localStorage)]).size;
      recLog('── System Status ──', 'info');
      recLog('Boot attempts: ' + attempts.length, attempts.length >= 2 ? 'warn' : 'ok');
      recLog('Settings: ' + (localStorage.getItem('nova_settings') ? 'present' : 'missing'), localStorage.getItem('nova_settings') ? 'ok' : 'warn');
      recLog('Storage: ' + (lsSize / 1024).toFixed(2) + ' KB (' + lsSize + ' bytes)', 'ok');
      recLog('Keys: ' + Object.keys(localStorage).length, 'ok');
      recLog('Safe mode: ' + (localStorage.getItem('nova_safe_mode') === '1' ? 'ON' : 'off'), 'ok');
    },

    ls: () => {
      const keys = Object.keys(localStorage);
      if (!keys.length) {
        recLog('(empty)', 'warn');
        return;
      }
      keys.forEach((k) => recLog('  ' + k + ' — ' + localStorage.getItem(k).length + ' chars', 'ok'));
    },

    env: () => {
      recLog('── Environment ──', 'info');
      recLog('UA: ' + navigator.userAgent.slice(0, 80), 'ok');
      const region = (typeof OS !== 'undefined' && OS.settings?.get) ? OS.settings.get('region') : navigator.language;
      recLog('Lang: ' + region, 'ok');
      recLog('Cores: ' + (navigator.hardwareConcurrency || '?'), 'ok');
      recLog('Online: ' + navigator.onLine, navigator.onLine ? 'ok' : 'warn');
      recLog('Screen: ' + screen.width + 'x' + screen.height, 'ok');
      recLog('Time: ' + new Date().toISOString(), 'ok');
    },

    'clear-boot': () => {
      localStorage.removeItem('nova_boot_attempts');
      recLog('Boot counter cleared', 'ok');
    },

    meminfo: () => {
      // performance.memory is Chrome-only, not standard — feature detect
      if (!performance.memory) {
        recLog('performance.memory not available', 'warn');
        return;
      }
      const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
      recLog('Heap Used: ' + mb(performance.memory.usedJSHeapSize), 'ok');
      recLog('Heap Total: ' + mb(performance.memory.totalJSHeapSize), 'ok');
      recLog('Heap Limit: ' + mb(performance.memory.jsHeapSizeLimit), 'ok');
    },

    clear: () => {
      const el = document.getElementById('rec-diag-lines');
      if (el) el.innerHTML = '';
    }
  };

  if (c === 'opfs' || c.startsWith('opfs ')) {
    (async () => {
      const args = cmd.trim().split(/\s+/);
      const sub = (args[1] || 'status').toLowerCase();

      if (sub === 'status') {
        const entries = await OPFS.listEntries();
        recLog('── OPFS Status ──', 'info');
        recLog('Available: ' + (OPFS.available ? 'yes' : 'no'), OPFS.available ? 'ok' : 'warn');
        recLog('Entries: ' + entries.length, 'ok');
        recLog('Backend: ' + (OPFS.available ? 'native OPFS' : 'IndexedDB fallback'), 'ok');
      } else if (sub === 'ls') {
        const entries = await OPFS.listEntries();
        if (!entries.length) {
          recLog('(empty)', 'warn');
          return;
        }
        entries.forEach((entry) => {
          const label = entry.kind === 'directory' ? '[dir] ' : '[file] ';
          recLog('  ' + label + entry.path + (entry.kind === 'file' ? ' — ' + _formatBytes(entry.size || 0) : ''), 'ok');
        });
      } else if (sub === 'cat') {
        const path = cmd.slice(cmd.toLowerCase().indexOf('cat') + 3).trim();
        if (!path) {
          recLog('Usage: opfs cat <path>', 'warn');
          return;
        }
        const blob = await OPFS.getBlob(path);
        if (!blob) {
          recLog('Not found: ' + path, 'warn');
          return;
        }
        const text = await blob.text();
        recLog('[' + path + ']\n' + (text.length > 8000 ? text.slice(0, 8000) + '\n… [truncated]' : text), 'ok');
      } else if (sub === 'rm' || sub === 'delete') {
        const path = cmd.slice(cmd.toLowerCase().indexOf(sub) + sub.length).trim();
        if (!path) {
          recLog('Usage: opfs rm <path>', 'warn');
          return;
        }
        if (!confirm('Delete OPFS item?\n\n' + path)) return;
        await OPFS.deletePath(path);
        recLog('Deleted: ' + path, 'ok');
      } else if (sub === 'clear') {
        if (!confirm('Clear all OPFS data? This cannot be undone.')) return;
        await OPFS.clear();
        recLog('OPFS cleared', 'ok');
      } else {
        recLog('Usage: opfs [status|ls|cat <path>|rm <path>|clear]', 'warn');
      }
    })();
    return;
  }

  if (c.startsWith('get ')) {
    const key = cmd.slice(4).trim();
    const v = localStorage.getItem(key);
    if (!v) {
      recLog('Key not found: ' + key, 'warn');
    } else {
      try {
        recLog('[' + key + ']\n' + JSON.stringify(JSON.parse(v), null, 2), 'ok');
      } catch {
        recLog('[' + key + '] ' + v, 'ok');
      }
    }
    return;
  }

  if (c.startsWith('set ')) {
    const parts = cmd.slice(4).split(' ');
    const key = parts.shift();
    const value = parts.join(' ');
    try {
      localStorage.setItem(key, value);
      recLog('Set ' + key + ' = ' + value.slice(0, 60), 'ok');
    } catch (e) {
      recLog('Error: ' + e.message, 'err');
    }
    return;
  }

  if (c.startsWith('del ')) {
    const key = cmd.slice(4).trim();
    localStorage.removeItem(key);
    recLog('Deleted: ' + key, 'ok');
    return;
  }

  if (c.startsWith('nav ')) {
    recLog('Navigation removed', 'warn');
    return;
  }

  if (cmds[c]) cmds[c]();
  else recLog('Unknown: "' + cmd + '" — type "help"', 'warn');
}

window._recPage = 'home';
window._recHistory = [];

window.recNav = function (page) {
  if (!page) return;
  if (window._recPage !== page) {
    window._recHistory.push(window._recPage);
    if (window._recHistory.length > 5) window._recHistory.shift();
  }
  window._recPage = page;
  _recRender();
};

window.recGoBack = function () {
  if (window._recHistory.length) {
    window._recPage = window._recHistory.pop();
    _recRender();
  } else {
    recNav('home');
  }
};

function _recRender() {
  document.querySelectorAll('.recovery-page').forEach((p) => { p.style.display = 'none'; });
  const target = document.querySelector(`.recovery-page[data-page="${window._recPage}"]`);
  const footer = document.querySelector('.recovery-footer');
  const hideFooterOn = ['tools', 'file-manager', 'settings-editor', 'storage-analyzer', 'event-log'];
  if (footer) footer.style.display = hideFooterOn.includes(window._recPage) ? 'none' : '';

  if (!target) return;
  target.style.display = 'flex';

  if (window._recPage === 'file-manager') {
    _renderFileManager();
  } else if (window._recPage === 'settings-editor') {
    _renderSettingsEditor();
  } else if (window._recPage === 'storage-analyzer') {
    _renderStorageAnalyzer();
  } else if (window._recPage === 'event-log') {
    _renderEventLog();
  } else if (window._recPage === 'tools') {
    recLog('NovaByte Recovery Terminal v2', 'info');
    recLog('Type "help" for commands.', 'info');
    // note: the actual Enter-key handling lives on this same input in
    // initRecoveryUI (keydown), so this is just refocusing it, not
    // wiring a second handler
    const inp = document.getElementById('rec-console-input');
    if (inp) inp.focus();
  }
}

// Both wipe-user-data and factory reset need to delete the same IndexedDB
// databases. They used to be two separate near-identical implementations
// that had already drifted apart — this is the one shared version.
// onblocked means another tab still has the DB open, so the delete hasn't
// actually happened yet. Treating that the same as success (like the old
// code did) means a factory reset can silently leave data behind while
// telling the user it's done — so this logs it instead of pretending it worked.
function deleteIndexedDBs(dbNames) {
  return Promise.all(dbNames.map((name) => new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve({ name, ok: true });
    req.onerror = () => resolve({ name, ok: false, reason: 'error' });
    req.onblocked = () => resolve({ name, ok: false, reason: 'blocked' });
  })));
}

window.recoveryAction = function (action) {
  const BOOT_ATTEMPT_KEY = 'nova_boot_attempts';
  const SAFE_MODE_KEY = 'nova_safe_mode';
  const RECOVERY_FORCE_KEY = 'nova_force_recovery';

  window._countdownStopped = true;
  const cb = document.getElementById('rec-countdown-block');
  if (cb) cb.style.opacity = '0.35';

  if (action === 'continue' || action === 'boot') {
    recLog('Continuing to NovaByte...', 'info');
    localStorage.removeItem(BOOT_ATTEMPT_KEY);
    localStorage.removeItem(RECOVERY_FORCE_KEY);
    setTimeout(() => location.reload(), 800);

  } else if (action === 'safemode') {
    recLog('Rebooting into Safe Mode...', 'warn');
    localStorage.setItem(SAFE_MODE_KEY, '1');
    localStorage.removeItem(BOOT_ATTEMPT_KEY);
    setTimeout(() => location.reload(), 800);

  } else if (action === 'boot-normal') {
    recLog('Normal boot...', 'info');
    localStorage.removeItem(BOOT_ATTEMPT_KEY);
    localStorage.removeItem(SAFE_MODE_KEY);
    localStorage.removeItem('nova_minimal_mode');
    setTimeout(() => location.reload(), 600);

  } else if (action === 'boot-safe') {
    recoveryAction('safemode');

  } else if (action === 'boot-minimal') {
    recLog('Minimal mode...', 'warn');
    localStorage.setItem('nova_minimal_mode', '1');
    localStorage.setItem(SAFE_MODE_KEY, '1');
    localStorage.removeItem(BOOT_ATTEMPT_KEY);
    setTimeout(() => location.reload(), 800);

  } else if (action === 'boot-recovery') {
    recLog('Forcing recovery on next boot...', 'warn');
    localStorage.setItem(RECOVERY_FORCE_KEY, '1');
    recLog('Done.', 'ok');

  } else if (action === 'console') {
    recNav('tools');
    setTimeout(() => {
      const cw = document.getElementById('rec-console-wrap');
      if (cw) {
        cw.classList.add('active');
        window._consoleOpen = true;
      }
      const inp = document.getElementById('rec-console-input');
      if (inp) inp.focus();
      recLog('Terminal ready. Type "help".', 'info');
    }, 80);

  } else if (action === 'file-manager') {
    recNav('file-manager');
    recLog('File manager...', 'info');
    setTimeout(_renderFileManager, 60);

  } else if (action === 'settings-editor') {
    recNav('settings-editor');
    recLog('Settings editor...', 'info');
    setTimeout(_renderSettingsEditor, 60);

  } else if (action === 'storage-analyzer') {
    recNav('storage-analyzer');
    recLog('Analyzing storage...', 'info');
    setTimeout(_renderStorageAnalyzer, 60);

  } else if (action === 'event-log') {
    recNav('event-log');
    setTimeout(_renderEventLog, 60);

  } else if (action === 'clear-cache') {
    recLog('');
    recLog('[ Clear Cache & Temp Data ]', 'info');

    const ssBefore = sessionStorage.length;
    sessionStorage.clear();
    recLog(`✓ sessionStorage cleared (${ssBefore} entries)`, 'ok');

    const cacheKeys = Object.keys(localStorage).filter((k) =>
      k.startsWith('cache_') || k.startsWith('tmp_') || k.startsWith('temp_') ||
      k.includes('_cache') || k.includes('_temp') || k === 'nova_boot_attempts' || k === 'nova_force_recovery'
    );
    cacheKeys.forEach((k) => localStorage.removeItem(k));
    recLog(`✓ ${cacheKeys.length} temp/cache key(s) removed from localStorage`, 'ok');

    if ('caches' in window) {
      caches.keys()
        .then((names) => Promise.all(names.map((n) => caches.delete(n))))
        .then((results) => recLog(`✓ ${results.filter(Boolean).length} service worker cache(s) cleared`, 'ok'))
        .catch(() => recLog('⚠ Could not clear SW caches', 'warn'));
    } else {
      recLog('⚠ Service worker caches not available', 'warn');
    }
    recLog('Cache clear complete.', 'ok');

  } else if (action === 'export') {
    recLog('');
    recLog('[ Export System Backup ]', 'info');
    const backup = { exportedAt: new Date().toISOString(), version: '3.0.2', userAgent: navigator.userAgent, localStorage: {} };
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      try {
        backup.localStorage[k] = JSON.parse(localStorage.getItem(k));
      } catch {
        backup.localStorage[k] = localStorage.getItem(k);
      }
    }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `novabyte-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    recLog('✓ Backup saved — check your downloads folder', 'ok');

  } else if (action === 'import') {
    recLog('');
    recLog('[ Import Backup ]', 'info');
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json';
    inp.id = 'backup-import-input';
    inp.name = 'backup-import';
    inp.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          if (!data.localStorage) {
            recLog('✗ Invalid backup file format', 'err');
            return;
          }
          if (!confirm(`Import backup from ${data.exportedAt}?\n\nThis will overwrite current settings. The OS will reload.`)) {
            recLog('Cancelled.', 'warn');
            return;
          }
          Object.entries(data.localStorage).forEach(([k, v]) => {
            try {
              localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
            } catch { }
          });
          recLog(`✓ Imported ${Object.keys(data.localStorage).length} key(s) from backup`, 'ok');
          recLog('Reloading…', 'info');
          setTimeout(() => location.reload(), 2000);
        } catch (e) {
          recLog('✗ Failed to parse backup: ' + e.message, 'err');
        }
      };
      reader.readAsText(file);
    };
    inp.click();

  } else if (action === 'wipe-user-data') {
    if (!confirm('Wipe all user data (settings, files)? This cannot be undone.')) {
      recLog('Cancelled', 'ok');
      return;
    }
    recLog('Wiping user data...', 'warn');
    ['nova_settings', 'nova_fs', 'nova_wallpaper', 'nova_theme'].forEach((k) => {
      localStorage.removeItem(k);
      recLog('  ✗ ' + k, 'warn');
    });
    deleteIndexedDBs(['NovaByte_FS', 'novabyte_opfs_fallback']).then((results) => {
      const blocked = results.filter((r) => r.reason === 'blocked');
      if (blocked.length) {
        recLog(`⚠ ${blocked.length} database(s) still open in another tab — close other NovaByte tabs and try again for a full wipe`, 'warn');
      }
      recLog('Done. Reloading in 3s...', 'ok');
      setTimeout(() => location.reload(), 3000);
    });

  } else if (action === 'reset-settings') {
    recLog('Resetting settings...', 'warn');
    localStorage.removeItem('nova_settings');
    recLog('Done. Reloading in 2s...', 'ok');
    setTimeout(() => location.reload(), 2000);

  } else if (action === 'factory') {
    if (!confirm('⚠ FACTORY RESET\n\nThis will permanently wipe ALL data:\n• All files and folders\n• All settings and preferences\n• All Group Policies\n• All application data\n\nThis CANNOT be undone. Are you absolutely sure?')) return;
    if (!confirm('Last chance — click OK to erase everything and start fresh.')) return;

    localStorage.clear();
    sessionStorage.clear();

    const clearOPFS = async () => {
      try {
        if (typeof OPFS !== 'undefined' && OPFS.clear) await OPFS.clear();
      } catch { }
    };

    // .novaapp data lives in per-app webview storage partitions
    // (persist:app_<id>, see app-sandbox.js createSandbox()) — separate
    // from localStorage/IndexedDB/OPFS, so it needs its own cleanup pass
    const clearAppPartitions = async () => {
      try {
        const appIds = (typeof OS !== 'undefined' && OS.apps) ? Object.keys(OS.apps) : [];
        if (typeof AppSandbox !== 'undefined' && AppSandbox.clearAppPartitions) {
          await AppSandbox.clearAppPartitions(appIds);
        }
      } catch { }
    };

    (async () => {
      const results = await deleteIndexedDBs(['NovaByte_FS', 'novabyte_opfs_fallback']);
      const blocked = results.filter((r) => r.reason === 'blocked');
      if (blocked.length) {
        console.warn('[Factory Reset] Some databases were blocked and may not be fully cleared:', blocked.map((r) => r.name));
      }
      await clearOPFS();
      await clearAppPartitions();
      location.reload();
    })();
  }
};

function _formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Escapes text before it goes into innerHTML template strings. This was
// being called in three places (OPFS paths, storage keys, boot event
// reasons) without ever being defined, which meant those three render
// functions would throw as soon as they ran, and worse — those values
// come from user input (prompt() for folder names, localStorage keys
// typed into the console), so without escaping this was also an XSS hole,
// not just a crash.
function sanitiseHTML(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

function _detectType(value) {
  if (typeof value !== 'string' || value.length === 0) return 'empty';
  const trimmed = value.trim();
  if (trimmed === '') return 'empty';
  try {
    JSON.parse(trimmed);
    return 'JSON';
  } catch (_) {
    // not JSON, keep checking other formats
  }
  if (/^data:[^;]+;base64,/.test(trimmed)) return 'data URI';
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length % 4 === 0 && trimmed.length > 16) return 'base64';
  if (/^https?:\/\//i.test(trimmed)) return 'URL';
  return 'text';
}

async function _renderFileManager() {
  const container = document.getElementById('rec-fm-content');
  if (!container) return;

  const localKeys = Object.keys(localStorage).sort();
  const localTotal = localKeys.reduce((sum, key) => sum + new Blob([localStorage.getItem(key) || '']).size, 0);

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:16px;">
      <section style="display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <div>
            <div style="font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#ff6b35;">Local Storage</div>
            <div style="font-size:11px;color:#6a7888;margin-top:3px;">${localKeys.length} key(s) · ${_formatBytes(localTotal)}</div>
          </div>
          <button class="rec-btn" data-fn="_renderFileManager">Refresh</button>
        </div>
        <div id="rec-fm-local"></div>
      </section>

      <section style="display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div>
            <div style="font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#58a6ff;">Origin Private File System</div>
            <div style="font-size:11px;color:#6a7888;margin-top:3px;" id="rec-opfs-status">Checking…</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="rec-btn" data-fn="_opfsRefresh">Refresh</button>
            <button class="rec-btn" data-fn="_opfsNewFolder">New folder</button>
            <button class="rec-btn" data-fn="_opfsNewFile">New file</button>
            <button class="rec-btn" data-fn="_opfsClear">Clear</button>
          </div>
        </div>
        <div id="rec-fm-opfs"></div>
      </section>
    </div>`;

  const localContainer = document.getElementById('rec-fm-local');
  if (localContainer) {
    if (!localKeys.length) {
      localContainer.innerHTML = '<div class="rec-fm-empty">No localStorage keys found</div>';
    } else {
      localContainer.innerHTML = '';
      localKeys.forEach((k) => {
        const v = localStorage.getItem(k) || '';
        const size = new Blob([v]).size;
        const row = document.createElement('div');
        row.className = 'rec-fm-row';
        row.innerHTML = `<div class="rec-fm-icon">📄</div><div class="rec-fm-info"><div class="rec-fm-name"></div><div class="rec-fm-meta">${_formatBytes(size)} · ${_detectType(v)}</div></div><div class="rec-fm-actions"><button class="rec-fm-btn rec-fm-view-btn">View</button><button class="rec-fm-btn danger rec-fm-del-btn">Del</button></div>`;
        row.querySelector('.rec-fm-name').textContent = k;
        row.querySelector('.rec-fm-view-btn').addEventListener('click', () => _fmView(k));
        row.querySelector('.rec-fm-del-btn').addEventListener('click', () => _fmDelete(k));
        localContainer.appendChild(row);
      });
    }
  }

  await _renderOPFSSection();
}

function _fmView(key) {
  const v = localStorage.getItem(key);
  if (v === null) {
    recLog('localStorage key not found: ' + key, 'warn');
    return;
  }
  const preview = v.length > 8000 ? v.slice(0, 8000) + '\n… [truncated]' : v;
  recLog('[' + key + ']\n' + preview, 'ok');
}

function _fmDelete(key) {
  if (!confirm('Delete localStorage item?\n\n' + key)) return;
  localStorage.removeItem(key);
  recLog('Deleted localStorage item: ' + key, 'warn');
  _renderFileManager();
}

async function _renderOPFSSection() {
  const statusEl = document.getElementById('rec-opfs-status');
  const container = document.getElementById('rec-fm-opfs');
  if (!statusEl || !container) return;

  try {
    await OPFS.init();
    const supported = !!(OPFS.available && OPFS.root);
    statusEl.textContent = supported ? 'Available · data is stored in the browser sandbox' : 'Unavailable in this browser · using IndexedDB fallback';
    const entries = await OPFS.listEntries();
    if (!entries.length) {
      container.innerHTML = '<div class="rec-fm-empty">No files found in OPFS yet</div>';
      return;
    }

    container.innerHTML = '';
    entries.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'rec-fm-row';
      const depth = entry.path.split('/').filter(Boolean).length - 1;
      const indent = Math.max(0, depth) * 14;
      const icon = entry.kind === 'directory' ? '📁' : '📄';
      const meta = entry.kind === 'directory'
        ? 'Folder'
        : `${_formatBytes(entry.size || 0)}${entry.type ? ' · ' + entry.type : ''}${entry.fallback ? ' · IndexedDB fallback' : ''}`;
      row.innerHTML = `
        <div class="rec-fm-icon">${icon}</div>
        <div class="rec-fm-info" style="padding-left:${indent}px;min-width:0;">
          <div class="rec-fm-name"></div>
          <div class="rec-fm-meta">${sanitiseHTML(entry.path)} · ${meta}</div>
        </div>
        <div class="rec-fm-actions">
          ${entry.kind === 'file' ? '<button class="rec-fm-btn rec-fm-opfs-view-btn">View</button><button class="rec-fm-btn rec-fm-opfs-download-btn">Download</button>' : ''}
          <button class="rec-fm-btn danger rec-fm-opfs-del-btn">Del</button>
        </div>`;
      row.querySelector('.rec-fm-name').textContent = entry.name || entry.path;
      if (entry.kind === 'file') {
        row.querySelector('.rec-fm-opfs-view-btn').addEventListener('click', () => _opfsView(entry.path));
        row.querySelector('.rec-fm-opfs-download-btn').addEventListener('click', () => _opfsDownload(entry.path));
      }
      row.querySelector('.rec-fm-opfs-del-btn').addEventListener('click', () => _opfsDelete(entry.path));
      container.appendChild(row);
    });
  } catch (e) {
    statusEl.textContent = 'Error loading OPFS: ' + e.message;
    container.innerHTML = '<div class="rec-fm-empty">Unable to read OPFS data</div>';
  }
}

window._opfsRefresh = function () { return _renderOPFSSection(); };

window._opfsNewFolder = async function () {
  const raw = prompt('Enter a folder path to create in OPFS', 'notes/projects');
  if (!raw) return;
  const path = raw.replace(/^\/+|\/+$/g, '');
  if (!path) return;
  try {
    await OPFS.ensureDirectory(path);
    recLog('Created OPFS folder: ' + path, 'ok');
    await _renderOPFSSection();
  } catch (e) {
    recLog('Failed to create folder: ' + e.message, 'err');
  }
};

window._opfsNewFile = async function () {
  const raw = prompt('Enter a file path to create in OPFS', 'notes/example.txt');
  if (!raw) return;
  const path = raw.replace(/^\/+|\/+$/g, '');
  if (!path) return;
  const content = prompt('File contents', '');
  if (content === null) return;
  try {
    await OPFS.writeText(path, content);
    recLog('Created OPFS file: ' + path, 'ok');
    await _renderOPFSSection();
  } catch (e) {
    recLog('Failed to create file: ' + e.message, 'err');
  }
};

window._opfsView = async function (path) {
  try {
    const blob = await OPFS.getBlob(path);
    if (!blob) {
      recLog('OPFS file not found: ' + path, 'warn');
      return;
    }
    if ((blob.type && blob.type.startsWith('text/')) || blob.size <= 50000) {
      const text = await blob.text();
      const preview = text.length > 8000 ? text.slice(0, 8000) + '\n… [truncated]' : text;
      recLog('[' + path + ']\n' + preview, 'ok');
    } else {
      recLog('[' + path + '] Binary file · ' + _formatBytes(blob.size), 'ok');
    }
  } catch (e) {
    recLog('Failed to open OPFS file: ' + e.message, 'err');
  }
};

window._opfsDownload = async function (path) {
  try {
    const blob = await OPFS.getBlob(path);
    if (!blob) {
      recLog('OPFS file not found: ' + path, 'warn');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop() || 'opfs-file';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    recLog('Downloaded: ' + path, 'ok');
  } catch (e) {
    recLog('Failed to download OPFS file: ' + e.message, 'err');
  }
};

window._opfsDelete = async function (path) {
  if (!confirm('Delete OPFS item?\n\n' + path)) return;
  try {
    await OPFS.deletePath(path);
    recLog('Deleted OPFS item: ' + path, 'warn');
    await _renderOPFSSection();
  } catch (e) {
    recLog('Failed to delete OPFS item: ' + e.message, 'err');
  }
};

window._opfsClear = async function () {
  if (!confirm('Clear all OPFS data? This cannot be undone.')) return;
  try {
    await OPFS.clear();
    recLog('OPFS cleared', 'ok');
    await _renderOPFSSection();
  } catch (e) {
    recLog('Failed to clear OPFS: ' + e.message, 'err');
  }
};

function _renderSettingsEditor() {
  const ta = document.getElementById('rec-settings-textarea');
  if (!ta) return;
  const raw = localStorage.getItem('nova_settings') || '{}';
  try {
    ta.value = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    ta.value = raw;
  }
}

window._settingsSave = function () {
  const ta = document.getElementById('rec-settings-textarea');
  if (!ta) return;
  try {
    JSON.parse(ta.value);
    localStorage.setItem('nova_settings', ta.value);
    recLog('Settings saved', 'ok');
  } catch (e) {
    recLog('Invalid JSON: ' + e.message, 'err');
  }
};

function _renderStorageAnalyzer() {
  const c = document.getElementById('rec-sa-content');
  if (!c) return;
  const items = Object.keys(localStorage)
    .map((k) => ({ k, size: new Blob([localStorage.getItem(k)]).size }))
    .sort((a, b) => b.size - a.size);
  const total = items.reduce((s, i) => s + i.size, 0);

  c.innerHTML = items.map((item) => {
    const pct = total ? ((item.size / total) * 100).toFixed(1) : 0;
    return `<div class="rec-sa-row"><div class="rec-sa-key">${sanitiseHTML(item.k)}</div><div class="rec-sa-bar-wrap"><div class="rec-sa-bar" style="width:${pct}%"></div></div><div class="rec-sa-size">${item.size < 1024 ? item.size + 'B' : (item.size / 1024).toFixed(1) + 'KB'} (${pct}%)</div></div>`;
  }).join('') + `<div class="rec-sa-total">Total: ${(total / 1024).toFixed(2)} KB · ${items.length} keys</div>`;
}

function _renderEventLog() {
  const c = document.getElementById('rec-eventlog-content');
  if (!c) return;
  const attempts = JSON.parse(localStorage.getItem('nova_boot_attempts') || '[]');
  if (!attempts.length) {
    c.innerHTML = '<div class="rec-fm-empty">No boot events recorded</div>';
    return;
  }
  c.innerHTML = attempts.map((a, i) =>
    `<div class="rec-eventlog-row"><div class="rec-eventlog-num">#${i + 1}</div><div class="rec-eventlog-info"><div class="rec-eventlog-time">${new Date(a.ts).toLocaleString()}</div><div class="rec-eventlog-reason">${sanitiseHTML(a.reason || 'unknown')}</div></div></div>`
  ).join('');
}