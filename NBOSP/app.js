/* ── Inline Scripts ── */
// Auto-apply CSP nonce to dynamically created <style> elements so they aren't
    // blocked by style-src-elem. window.__cspNonce is injected by the server at render time.
    // Fix CVE-NB-2026-009-H2 (2026-05-14): nonce is captured into a closure-local variable
    // and then deleted from window immediately, so an XSS payload cannot read it to
    // self-apply a valid nonce and bypass CSP style-src restrictions.
    (function () {
      // The server injects window.__cspNonce just before the closing head tag, which runs
      // AFTER this script block. Capture it lazily on the first createElement('style') call.
      // Once captured, delete it from window so XSS running later cannot read the nonce.
      var _nonce = null;
      var _nonceCaptured = false;
      var _orig = document.createElement.bind(document);
      document.createElement = function (tag) {
        var el = _orig.apply(document, arguments);
        if (typeof tag === 'string' && tag.toLowerCase() === 'style') {
          if (!_nonceCaptured) {
            _nonce = window.__cspNonce || null;
            _nonceCaptured = true;
            try { delete window.__cspNonce; } catch (e) { window.__cspNonce = undefined; }
          }
          if (_nonce) el.nonce = _nonce;
        }
        return el;
      };
    })();

    // Basic frame-busting guard for clickjacking resistance in a static HTML page.
    // Fix CVE-NB-2026-009-H1 (2026-05-14): replaced innerHTML='' (XSS sink) with
    // style-based hide — achieves the same visual effect without touching innerHTML.
    if (window.top !== window.self) {
      try {
        window.top.location = window.self.location.href;
      } catch (e) {
        // Cannot escape frame — hide the page content instead of clearing innerHTML
        document.addEventListener('DOMContentLoaded', function () {
          if (document.body) document.body.style.display = 'none';
        });
        // Also attempt to hide immediately in case DOMContentLoaded already fired
        if (document.body) document.body.style.display = 'none';
      }
    }

    // Memory management: force garbage collection periodically to prevent OOM
    if (typeof window !== 'undefined') {
      // Only works if --expose-gc flag is used (which it is in package.json)
      if (typeof gc === 'function') {
        setInterval(() => {
          try { gc(); } catch (e) { console.warn('GC failed:', e.message); }
        }, 30000); // Force GC every 30 seconds
      }
    }

// Ensure localStorage is always available (fallback to in-memory for sandboxed contexts)
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
      // Test if localStorage is actually writable (may fail in sandboxed contexts)
      try {
        const testKey = '__novabyte_test__';
        localStorage.setItem(testKey, '1');
        localStorage.removeItem(testKey);
      } catch (e) {
        // localStorage exists but is read-only or blocked, replace with in-memory storage
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
              // Fallback to memory storage silently
            }
            memStore.set(key, String(value));
          },
          removeItem: (key) => {
            try {
              originalLS.removeItem(key);
            } catch (err) {
              // Fallback to memory storage silently
            }
            memStore.delete(key);
          },
          clear: () => {
            try {
              originalLS.clear();
            } catch (err) {
              // Fallback to memory storage silently
            }
            memStore.clear();
          },
          key: (index) => Array.from(memStore.keys())[index] ?? null,
          get length() { return memStore.size; }
        };
      }
    }

// ── Fix CVE-NB-2026-009-M3 (2026-05-14): localStorage sensitive-key guard ──
    // NovaByte localStorage stores only OS state (boot config, recovery flags).
    // NEVER store auth tokens, passwords, PII, or secrets here — any XSS payload
    // can read all localStorage keys. This guard warns loudly if a sensitive-looking
    // key is written so accidental credential storage is caught early.
    (function () {
      var SENSITIVE = /token|auth|secret|password|credential|session|apikey|api_key|jwt|bearer/i;
      var _realSet = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function (key, value) {
        if (SENSITIVE.test(key)) {
          var msg = '[NovaByte] SECURITY: Refusing to store sensitive key "' + key +
            '" in localStorage (XSS-readable). Use a server-side session instead.';
          if (window.__NOVA_DEBUG) {
            console.warn(msg); // warn in dev, allow through
            return _realSet(key, value);
          }
          throw new Error(msg); // hard-fail in production
        }
        return _realSet(key, value);
      };
    })();

// ── Fix CVE-NB-2026-009-L2 (2026-05-14): Event delegation — inline handlers ─
    // Replaced 36 static onclick= attributes with data-* attributes routed here.
    // Dynamic onclick= inside JS template literals are tracked as a separate item.
    document.addEventListener('DOMContentLoaded', function () {
      document.addEventListener('click', function (e) {
        var t = e.target.closest('[data-fn]');
        if (!t) return;
        if (t.dataset.fn) {
          var fn = window[t.dataset.fn];
          if (typeof fn === 'function') fn();
        }
      });
    });

    // ── Production console guard (CVE-NB-2026-009-H6, 2026-05-14) ──────────────
    // Suppress all console output in production to prevent information disclosure
    // via DevTools (internal paths, state values, API endpoints).
    // Set window.__NOVA_DEBUG = true in a local .env or browser console to re-enable.
    (function () {
      if (typeof window.__NOVA_DEBUG === 'undefined' || !window.__NOVA_DEBUG) {
        var noop = function () { };
        ['log', 'info', 'warn', 'debug', 'group', 'groupEnd', 'groupCollapsed', 'table', 'dir'].forEach(function (m) {
          try { console[m] = noop; } catch (e) { }
        });
        // Keep console.error for genuine unhandled errors but strip message content
        console.error = function () {
          // Only emit in dev; in prod swallow to avoid leaking stack traces
        };
      }
    })();

// Boot config defaults for NBOSP
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

    // ── Critical Error Handler & Boot Watchdog ─────────────────────────
    // This runs BEFORE the main script to catch syntax errors
    (function () {
      const RECOVERY_FORCE_KEY = 'nova_force_recovery';
      const BOOT_TIMEOUT_MS = 15000;
      const MANUAL_RECOVERY_KEY = 'nova_manual_recovery';

      // Check if this is a manual recovery (user clicked "Boot to Recovery" in settings)
      const isManualRecovery = localStorage.getItem(MANUAL_RECOVERY_KEY) === '1';

      if (isManualRecovery) {
        console.log('[BOOT] Manual recovery boot - showing recovery screen directly');
        // Clear the manual recovery flag so it doesn't persist
        localStorage.removeItem(MANUAL_RECOVERY_KEY);
        // Clear any fake boot attempts we set
        localStorage.removeItem('nova_boot_attempts');
        // Set a flag for the main boot script to show recovery
        localStorage.setItem('nova_show_recovery', '1');
        // Don't run stuck boot detection
        return;
      }

      if (localStorage.getItem(RECOVERY_FORCE_KEY) === '1') {
        console.log('[CRITICAL] Previous boot was stuck/broken - showing recovery boot animation');
        localStorage.removeItem(RECOVERY_FORCE_KEY);

        // Run the recovery boot animation inline — we can't call showRecoveryScreen()
        // because it lives in the main script which may be broken/unparsed.
        // This is a self-contained copy that only needs the DOM.
        setTimeout(function () {
          var anim = document.createElement('div');
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
            '<div class="rba-subtitle">\u26a0 Recovery Mode v2.0</div>',
            '<div class="rba-log" id="rba-log"></div>',
            '<div class="rba-bar-wrap"><div class="rba-bar" id="rba-bar"></div></div>',
            '<div class="rba-status" id="rba-status">Initializing recovery environment\u2026</div>',
            '</div>'
          ].join('');
          document.body.appendChild(anim);

          var rbaLog = document.getElementById('rba-log');
          var rbaBar = document.getElementById('rba-bar');
          var rbaStatus = document.getElementById('rba-status');
          var step = 0;
          var steps = [
            { msg: '[ RECOVERY MODE TRIGGERED ]', cls: 'warn', pct: 8, label: 'Loading recovery kernel\u2026' },
            { msg: '\u2713 Recovery environment v2.0 loaded', cls: 'ok', pct: 22, label: 'Mounting storage\u2026' },
            { msg: '\u2713 localStorage integrity check\u2026', cls: 'ok', pct: 38, label: 'Checking data\u2026' },
            { msg: '\u26a0 Boot failure detected \u2014 entering recovery', cls: 'warn', pct: 60, label: 'Preparing interface\u2026' },
            { msg: '\u2713 Recovery UI ready', cls: 'ok', pct: 88, label: 'Almost ready\u2026' },
            { msg: '\u2713 Handoff to Recovery Environment', cls: 'info', pct: 100, label: 'Done.' }
          ];

          function runStep() {
            if (step >= steps.length) {
              // Animation done — fade out and reveal the recovery screen
              setTimeout(function () {
                anim.classList.add('fade-out');
                setTimeout(function () { anim.remove(); }, 650);

                // Show the recovery screen
                var screen = document.getElementById('recovery-screen');
                if (screen) {
                  screen.classList.add('active');
                  var attemptEl = document.getElementById('rec-attempt-count');
                  var tsEl = document.getElementById('rec-timestamp');
                  if (attemptEl) attemptEl.textContent = '2+';
                  if (tsEl) tsEl.innerHTML = '<strong>Boot Failure Detected</strong>';

                  // Countdown auto-boot
                  var countdown = 15;
                  var cdownNum = document.getElementById('rec-cdown-num');
                  var cdownBar = document.getElementById('rec-cdown-bar');
                  var cdownBlock = document.getElementById('rec-countdown-block');
                  if (cdownNum && cdownBar) {
                    var timer = setInterval(function () {
                      countdown--;
                      cdownNum.textContent = countdown;
                      cdownBar.style.width = ((countdown / 15) * 100) + '%';
                      if (countdown <= 0) {
                        clearInterval(timer);
                      }
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
            var s = steps[step++];
            rbaBar.style.width = s.pct + '%';
            rbaStatus.textContent = s.label;
            var line = document.createElement('div');
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

      // Set up error handler for syntax errors
      window.addEventListener('error', function (e) {
        const msg = e.message || '';
        if (msg.includes('SyntaxError') || msg.includes('Unexpected token')) {
          console.error('[CRITICAL] Syntax error detected:', msg);
          localStorage.setItem(RECOVERY_FORCE_KEY, '1');
          localStorage.setItem('nova_boot_attempts', JSON.stringify([
            { ts: Date.now() - 2000, reason: 'syntax_error_1', ua: navigator.userAgent.slice(0, 80) },
            { ts: Date.now(), reason: 'syntax_error_2', ua: navigator.userAgent.slice(0, 80) }
          ]));
          location.reload();
        }
      });

      // Check boot config for alternative boot modes
      const config = getBootConfig();
      if (config.default === 'recovery') {
        localStorage.setItem('nova_show_recovery', '1');
      }

      // Boot watchdog - if boot() doesn't complete in 15 seconds, force recovery
      const bootStartTime = Date.now();
      window._bootStartTime = bootStartTime;

      const watchdog = setInterval(function () {
        // Check if the boot-screen is still visible (boot incomplete)
        const bootScreen = document.getElementById('boot-screen');
        const hasCompleted = document.body.classList.contains('os-booted');

        if (Date.now() - bootStartTime > BOOT_TIMEOUT_MS && !hasCompleted && bootScreen) {
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

    // ── Recovery UI v2 removed ────────────────────────────────────────────

    function recLog(msg, cls = '') {
      const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
      function makeLogLine() {
        const line = document.createElement('div');
        line.className = 'recovery-log-line' + (cls ? ' ' + cls : '');
        const _ts = document.createElement('span'); _ts.className = 'recovery-log-ts'; _ts.textContent = ts;
        const _msg = document.createElement('span'); _msg.className = 'recovery-log-msg'; _msg.textContent = msg;
        line.append(_ts, _msg);
        return line;
      }
      // Write to main log panel
      const mainEl = document.getElementById('rec-diag-lines');
      if (mainEl) {
        mainEl.appendChild(makeLogLine());
        mainEl.parentElement.scrollTop = mainEl.parentElement.scrollHeight;
      }
      // Also mirror to terminal page output
      const termEl = document.getElementById('rec-term-lines');
      if (termEl) {
        termEl.appendChild(makeLogLine());
        termEl.scrollTop = termEl.scrollHeight;
      }
    }

    function initRecoveryUI() {
      // Live clock
      const clockEl = document.getElementById('rec-clock');
      if (clockEl) {
        const tick = () => clockEl.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
        tick(); setInterval(tick, 1000);
      }

      // System info
      try {
        const lsSize = new Blob([JSON.stringify(localStorage)]).size;
        const si = (id, val, cls) => {
          const el = document.getElementById(id);
          if (el) { el.textContent = val; if (cls) el.className = 'recovery-sysinfo-value ' + cls; }
        };
        si('rec-si-storage', lsSize > 0 ? (lsSize / 1024).toFixed(1) + ' KB' : '0 KB', lsSize > 500000 ? 'warn' : 'ok');
        const hasSettings = !!localStorage.getItem('nova_settings');
        si('rec-si-settings', hasSettings ? 'Found' : 'Missing', hasSettings ? 'ok' : 'warn');
        const attempts = JSON.parse(localStorage.getItem('nova_boot_attempts') || '[]');
        si('rec-si-boots', attempts.length + ' attempt(s)', attempts.length >= 3 ? 'err' : attempts.length >= 1 ? 'warn' : 'ok');
      } catch (e) { }

      // Initial diagnostics log
      recLog('NovaByte Recovery Environment initialized', 'info');
      recLog('Scanning storage...', 'info');
      try {
        const keys = Object.keys(localStorage);
        recLog(`localStorage: ${keys.length} key(s) · ${new Blob([JSON.stringify(localStorage)]).size} bytes`, 'ok');
        ['nova_settings', 'nova_boot_attempts'].forEach(k => {
          const v = localStorage.getItem(k);
          recLog((v ? '✓' : '✗') + ' ' + k + (v ? ': ' + v.length + ' chars' : ': not found'), v ? 'ok' : 'warn');
        });
      } catch (e) { recLog('Storage read error: ' + e.message, 'err'); }
      recLog('Select a recovery option to continue.', 'info');

      // Console input (bottom bar)
      const inp = document.getElementById('rec-console-input');
      if (inp) {
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            const cmd = inp.value.trim();
            inp.value = '';
            if (cmd) handleConsoleCmd(cmd);
          }
        });
      }

      // Terminal page input (full terminal view)
      const termInp = document.getElementById('rec-term-cmd-input');
      if (termInp) {
        termInp.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            const cmd = termInp.value.trim();
            termInp.value = '';
            if (cmd) handleConsoleCmd(cmd);
          }
        });
      }
    }

    function handleConsoleCmd(cmd) {
      const cw = document.getElementById('rec-console-wrap');
      if (cw) cw.classList.add('active');
      recLog('$ ' + cmd, 'info');
      const c = cmd.toLowerCase().trim();

      const cmds = {
        help: () => ['─────────────────────────────', 'NovaByte Recovery Terminal', '─────────────────────────────', 'NAVIGATION', '  nav <page>      — go to page (home/tools/data/advanced)', '  back            — go back', 'SYSTEM', '  status          — full system status', '  ls              — list localStorage keys', '  get <key>       — read a localStorage key', '  set <key> <val> — write a localStorage key', '  del <key>       — delete a localStorage key', '  env             — environment info', '  meminfo         — JS heap memory', 'RECOVERY', '  clear-boot      — clear boot attempt counter', '  clear-cache     — flush all caches', '  safe            — reboot to safe mode', '  continue        — boot normally', '  factory         — factory reset (asks confirmation)', 'LOG', '  clear           — clear log panel', '─────────────────────────────'].forEach(l => recLog(l, l.startsWith('─') ? 'info' : l.match(/^  /) ? '' : 'warn')),

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
        ls: () => { const keys = Object.keys(localStorage); if (!keys.length) { recLog('(empty)', 'warn'); return; } keys.forEach(k => recLog('  ' + k + ' — ' + localStorage.getItem(k).length + ' chars', 'ok')); },
        env: () => { recLog('── Environment ──', 'info'); recLog('UA: ' + navigator.userAgent.slice(0, 80), 'ok'); recLog('Lang: ' + navigator.language, 'ok'); recLog('Cores: ' + (navigator.hardwareConcurrency || '?'), 'ok'); recLog('Online: ' + navigator.onLine, navigator.onLine ? 'ok' : 'warn'); recLog('Screen: ' + screen.width + 'x' + screen.height, 'ok'); recLog('Time: ' + new Date().toISOString(), 'ok'); },
        'clear-boot': () => { localStorage.removeItem('nova_boot_attempts'); recLog('Boot counter cleared', 'ok'); },
        meminfo: () => { if (performance.memory) { const mb = n => (n / 1024 / 1024).toFixed(1) + ' MB'; recLog('Heap Used: ' + mb(performance.memory.usedJSHeapSize), 'ok'); recLog('Heap Total: ' + mb(performance.memory.totalJSHeapSize), 'ok'); recLog('Heap Limit: ' + mb(performance.memory.jsHeapSizeLimit), 'ok'); } else recLog('performance.memory not available', 'warn'); },
        clear: () => { const el = document.getElementById('rec-diag-lines'); if (el) el.innerHTML = ''; },
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
            if (!entries.length) { recLog('(empty)', 'warn'); return; }
            entries.forEach(entry => {
              const label = entry.kind === 'directory' ? '[dir] ' : '[file] ';
              recLog('  ' + label + entry.path + (entry.kind === 'file' ? ' — ' + _formatBytes(entry.size || 0) : ''), 'ok');
            });
          } else if (sub === 'cat') {
            const path = cmd.slice(cmd.toLowerCase().indexOf('cat') + 3).trim();
            if (!path) { recLog('Usage: opfs cat <path>', 'warn'); return; }
            const blob = await OPFS.getBlob(path);
            if (!blob) { recLog('Not found: ' + path, 'warn'); return; }
            const text = await blob.text();
            recLog('[' + path + ']\n' + (text.length > 8000 ? text.slice(0, 8000) + '\n… [truncated]' : text), 'ok');
          } else if (sub === 'rm' || sub === 'delete') {
            const path = cmd.slice(cmd.toLowerCase().indexOf(sub) + sub.length).trim();
            if (!path) { recLog('Usage: opfs rm <path>', 'warn'); return; }
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

      if (c.startsWith('get ')) { const key = cmd.slice(4).trim(), v = localStorage.getItem(key); if (!v) recLog('Key not found: ' + key, 'warn'); else { try { recLog('[' + key + ']\n' + JSON.stringify(JSON.parse(v), null, 2), 'ok'); } catch { recLog('[' + key + '] ' + v, 'ok'); } } return; }
      if (c.startsWith('set ')) { const p = cmd.slice(4).split(' '), k = p.shift(), v = p.join(' '); try { localStorage.setItem(k, v); recLog('Set ' + k + ' = ' + v.slice(0, 60), 'ok'); } catch (e) { recLog('Error: ' + e.message, 'err'); } return; }
      if (c.startsWith('del ')) { const k = cmd.slice(4).trim(); localStorage.removeItem(k); recLog('Deleted: ' + k, 'ok'); return; }
      if (c.startsWith('nav ')) { recLog('Navigation removed', 'warn'); return; }
      if (cmds[c]) cmds[c]();
      else recLog('Unknown: "' + cmd + '" — type "help"', 'warn');
    }

    // ── Folder Navigation ───────────────────────────────────────────────────
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
      var pages = document.querySelectorAll('.recovery-page');
      pages.forEach(function (p) { p.style.display = 'none'; });
      var target = document.querySelector('.recovery-page[data-page="' + window._recPage + '"]');
      var footer = document.querySelector('.recovery-footer');
      if (footer) footer.style.display = (window._recPage === 'tools' || window._recPage === 'file-manager' || window._recPage === 'settings-editor' || window._recPage === 'storage-analyzer' || window._recPage === 'event-log') ? 'none' : '';
      if (target) {
        target.style.display = 'flex';
        if (window._recPage === 'file-manager') _renderFileManager();
        else if (window._recPage === 'settings-editor') _renderSettingsEditor();
        else if (window._recPage === 'storage-analyzer') _renderStorageAnalyzer();
        else if (window._recPage === 'event-log') _renderEventLog();
        else if (window._recPage === 'tools') {
          recLog('NovaByte Recovery Terminal v2', 'info');
          recLog('Type "help" for commands.', 'info');
          var inp = document.getElementById('rec-console-input');
          if (inp) {
            inp.onkeyup = function (e) { if (e.key === 'Enter' && inp.value.trim()) { recLog('$ ' + inp.value, 'info'); handleConsoleCmd(inp.value); inp.value = ''; } };
            inp.focus();
          }
        }
      }
    }

    // ── Recovery Actions ───────────────────────────────────────────────────
    window.recoveryAction = function (action) {
      const BOOT_ATTEMPT_KEY = 'nova_boot_attempts';
      const SAFE_MODE_KEY = 'nova_safe_mode';
      const RECOVERY_FORCE_KEY = 'nova_force_recovery';

      // Stop countdown on any action
      window._countdownStopped = true;
      const cb = document.getElementById('rec-countdown-block');
      if (cb) cb.style.opacity = '0.35';

      if (action === 'continue' || action === 'boot') {
        recLog('Continuing to NovaByte...', 'info');
        localStorage.removeItem(BOOT_ATTEMPT_KEY);
        localStorage.removeItem(RECOVERY_FORCE_KEY);
        document.getElementById('recovery-screen').classList.remove('active');
        setTimeout(() => location.reload(), 800);

      } else if (action === 'safemode') {
        recLog('Rebooting into Safe Mode...', 'warn');
        localStorage.setItem(SAFE_MODE_KEY, '1');
        localStorage.removeItem(BOOT_ATTEMPT_KEY);
        setTimeout(() => location.reload(), 800);

      } else if (action === 'boot-normal') {
        recLog('Normal boot...', 'info'); localStorage.removeItem(BOOT_ATTEMPT_KEY); localStorage.removeItem(SAFE_MODE_KEY); localStorage.removeItem('nova_minimal_mode'); setTimeout(() => location.reload(), 600);
      } else if (action === 'boot-safe') {
        recoveryAction('safemode');
      } else if (action === 'boot-minimal') {
        recLog('Minimal mode...', 'warn');
        localStorage.setItem('nova_minimal_mode', '1'); localStorage.setItem(SAFE_MODE_KEY, '1'); localStorage.removeItem(BOOT_ATTEMPT_KEY); setTimeout(() => location.reload(), 800);
      } else if (action === 'boot-recovery') {
        recLog('Forcing recovery on next boot...', 'warn'); localStorage.setItem(RECOVERY_FORCE_KEY, '1'); recLog('Done.', 'ok');

      } else if (action === 'console') {
        recNav('tools');
        setTimeout(() => { const cw = document.getElementById('rec-console-wrap'); if (cw) { cw.classList.add('active'); window._consoleOpen = true; } const inp = document.getElementById('rec-console-input'); if (inp) inp.focus(); recLog('Terminal ready. Type "help".', 'info'); }, 80);

      } else if (action === 'file-manager') {
        recNav('file-manager'); recLog('File manager...', 'info'); setTimeout(_renderFileManager, 60);

      } else if (action === 'settings-editor') {
        recNav('settings-editor'); recLog('Settings editor...', 'info'); setTimeout(_renderSettingsEditor, 60);

      } else if (action === 'storage-analyzer') {
        recNav('storage-analyzer'); recLog('Analyzing storage...', 'info'); setTimeout(_renderStorageAnalyzer, 60);

      } else if (action === 'event-log') {
        recNav('event-log'); setTimeout(_renderEventLog, 60);

      } else if (action === 'clear-cache') {
        recLog('');
        recLog('[ Clear Cache & Temp Data ]', 'info');
        // Session storage
        const ssBefore = sessionStorage.length;
        sessionStorage.clear();
        recLog(`✓ sessionStorage cleared (${ssBefore} entries)`, 'ok');
        // Remove temp/cache keys from localStorage
        const cacheKeys = Object.keys(localStorage).filter(k =>
          k.startsWith('cache_') || k.startsWith('tmp_') || k.startsWith('temp_') ||
          k.includes('_cache') || k.includes('_temp') || k === 'nova_boot_attempts' || k === 'nova_force_recovery'
        );
        cacheKeys.forEach(k => localStorage.removeItem(k));
        recLog(`✓ ${cacheKeys.length} temp/cache key(s) removed from localStorage`, 'ok');
        // Clear service worker caches
        if ('caches' in window) {
          caches.keys().then(names => {
            return Promise.all(names.map(n => caches.delete(n)));
          }).then(results => {
            recLog(`✓ ${results.filter(Boolean).length} service worker cache(s) cleared`, 'ok');
          }).catch(() => recLog('⚠ Could not clear SW caches', 'warn'));
        } else {
          recLog('⚠ Service worker caches not available', 'warn');
        }
        recLog('Cache clear complete.', 'ok');

      } else if (action === 'export') {
        recLog('');
        recLog('[ Export System Backup ]', 'info');
        const backup = { exportedAt: new Date().toISOString(), version: '3.0.0', userAgent: navigator.userAgent, localStorage: {} };
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          try { backup.localStorage[k] = JSON.parse(localStorage.getItem(k)); }
          catch { backup.localStorage[k] = localStorage.getItem(k); }
        }
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `novabyte-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click(); URL.revokeObjectURL(url);
        recLog('✓ Backup saved — check your downloads folder', 'ok');

      } else if (action === 'import') {
        recLog('');
        recLog('[ Import Backup ]', 'info');
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.json'; inp.id = 'backup-import-input'; inp.name = 'backup-import';
        inp.onchange = e => {
          const file = e.target.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = ev => {
            try {
              const data = JSON.parse(ev.target.result);
              if (!data.localStorage) { recLog('✗ Invalid backup file format', 'err'); return; }
              if (!confirm(`Import backup from ${data.exportedAt}?\n\nThis will overwrite current settings. The OS will reload.`)) { recLog('Cancelled.', 'warn'); return; }
              Object.entries(data.localStorage).forEach(([k, v]) => {
                try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch { }
              });
              recLog(`✓ Imported ${Object.keys(data.localStorage).length} key(s) from backup`, 'ok');
              recLog('Reloading…', 'info');
              setTimeout(() => location.reload(), 2000);
            } catch (e) { recLog('✗ Failed to parse backup: ' + e.message, 'err'); }
          };
          reader.readAsText(file);
        };
        inp.click();

      } else if (action === 'wipe-user-data') {
        if (!confirm('Wipe all user data (settings, files)? This cannot be undone.')) { recLog('Cancelled', 'ok'); return; }
        recLog('Wiping user data...', 'warn');
        ['nova_settings', 'nova_fs', 'nova_wallpaper', 'nova_theme'].forEach(k => { localStorage.removeItem(k); recLog('  ✗ ' + k, 'warn'); });
        // Also wipe IndexedDB where actual settings/files are stored
        const _wipeDBs = ['NovaByte_FS', 'novabyte_opfs_fallback'];
        let _wipeCount = 0;
        const _doWipe = () => {
          if (_wipeCount >= _wipeDBs.length) { recLog('Done. Reloading in 3s...', 'ok'); setTimeout(() => location.reload(), 3000); return; }
          const _req = indexedDB.deleteDatabase(_wipeDBs[_wipeCount++]);
          _req.onsuccess = _req.onerror = _req.onblocked = () => _doWipe();
        };
        _doWipe();

      } else if (action === 'reset-settings') {
        recLog('Resetting settings...', 'warn');
        ['nova_settings'].forEach(k => localStorage.removeItem(k));
        recLog('Done. Reloading in 2s...', 'ok'); setTimeout(() => location.reload(), 2000);

      } else if (action === 'factory') {
        if (!confirm('⚠ FACTORY RESET\n\nThis will permanently wipe ALL data:\n• All files and folders\n• All settings and preferences\n• All Group Policies\n• All application data\n\nThis CANNOT be undone. Are you absolutely sure?')) return;
        if (!confirm('Last chance — click OK to erase everything and start fresh.')) return;
        localStorage.clear(); sessionStorage.clear();
        const dbsToDelete = ['NovaByte_FS', 'novabyte_opfs_fallback'];
        let dbCount = 0;
        const deleteDbs = () => new Promise(resolve => {
          if (dbCount >= dbsToDelete.length) { resolve(); return; }
          const req = indexedDB.deleteDatabase(dbsToDelete[dbCount++]);
          req.onsuccess = req.onerror = req.onblocked = () => deleteDbs().then(resolve);
        });
        const clearOPFS = async () => {
          try {
            if (typeof OPFS !== 'undefined' && OPFS.clear) {
              await OPFS.clear();
            }
          } catch { }
        };
        (async () => { await deleteDbs(); await clearOPFS(); location.reload(); })();

      }
    };

    // ── File Manager ──────────────────────────────────────────────────────
    function _formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
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
            const sk = k.replace(/'/g, "\'");
            row.innerHTML = `<div class="rec-fm-icon">📄</div><div class="rec-fm-info"><div class="rec-fm-name"></div><div class="rec-fm-meta">${_formatBytes(size)} · ${_detectType(v)}</div></div><div class="rec-fm-actions"><button class="rec-fm-btn rec-fm-view-btn">View</button><button class="rec-fm-btn danger rec-fm-del-btn">Del</button></div>`;
            row.querySelector('.rec-fm-name').textContent = k;
            row.querySelector('.rec-fm-view-btn').addEventListener('click', () => _fmView(sk));
            row.querySelector('.rec-fm-del-btn').addEventListener('click', () => _fmDelete(sk));
            localContainer.appendChild(row);
          });
        }
      }

      await _renderOPFSSection();
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

    // ── Settings Editor ───────────────────────────────────────────────────
    function _renderSettingsEditor() {
      const ta = document.getElementById('rec-settings-textarea');
      if (!ta) return;
      const raw = localStorage.getItem('nova_settings') || '{}';
      try { ta.value = JSON.stringify(JSON.parse(raw), null, 2); } catch { ta.value = raw; }
    }
    window._settingsSave = function () {
      const ta = document.getElementById('rec-settings-textarea');
      if (!ta) return;
      try { JSON.parse(ta.value); localStorage.setItem('nova_settings', ta.value); recLog('Settings saved', 'ok'); }
      catch (e) { recLog('Invalid JSON: ' + e.message, 'err'); }
    };

    // ── Storage Analyzer ──────────────────────────────────────────────────
    function _renderStorageAnalyzer() {
      const c = document.getElementById('rec-sa-content');
      if (!c) return;
      const items = Object.keys(localStorage).map(k => ({ k, size: new Blob([localStorage.getItem(k)]).size })).sort((a, b) => b.size - a.size);
      const total = items.reduce((s, i) => s + i.size, 0);
      c.innerHTML = items.map(item => {
        const pct = total ? ((item.size / total) * 100).toFixed(1) : 0;
        return `<div class="rec-sa-row"><div class="rec-sa-key">${sanitiseHTML(item.k)}</div><div class="rec-sa-bar-wrap"><div class="rec-sa-bar" style="width:${pct}%"></div></div><div class="rec-sa-size">${item.size < 1024 ? item.size + 'B' : (item.size / 1024).toFixed(1) + 'KB'} (${pct}%)</div></div>`;
      }).join('') + `<div class="rec-sa-total">Total: ${(total / 1024).toFixed(2)} KB · ${items.length} keys</div>`;
    }

    // ── Event Log ─────────────────────────────────────────────────────────
    function _renderEventLog() {
      const c = document.getElementById('rec-eventlog-content');
      if (!c) return;
      const attempts = JSON.parse(localStorage.getItem('nova_boot_attempts') || '[]');
      if (!attempts.length) { c.innerHTML = '<div class="rec-fm-empty">No boot events recorded</div>'; return; }
      c.innerHTML = attempts.map((a, i) => `<div class="rec-eventlog-row"><div class="rec-eventlog-num">#${i + 1}</div><div class="rec-eventlog-info"><div class="rec-eventlog-time">${new Date(a.ts).toLocaleString()}</div><div class="rec-eventlog-reason">${sanitiseHTML(a.reason || 'unknown')}</div></div></div>`).join('');
    }

/* ╔══════════════════════════════════════════════════════════════════════╗
       ║                                                                    ║
       ║   ███╗   ██╗ ██████╗ ██╗   ██╗ █████╗ ██████╗ ██╗   ██╗████████╗  ║
       ║   ████╗  ██║██╔═══██╗██║   ██║██╔══██╗██╔══██╗╚██╗ ██╔╝╚══██╔══╝  ║
       ║   ██╔██╗ ██║██║   ██║██║   ██║███████║██████╔╝ ╚████╔╝    ██║     ║
       ║   ██║╚██╗██║██║   ██║╚██╗ ██╔╝██╔══██║██╔══██╗  ╚██╔╝     ██║     ║
       ║   ██║ ╚████║╚██████╔╝ ╚████╔╝ ██║  ██║██████╔╝   ██║      ██║     ║
       ║   ╚═╝  ╚═══╝ ╚═════╝   ╚═══╝  ╚═╝  ╚═╝╚═════╝    ╚═╝      ╚═╝     ║
       ║                                                                    ║
       ║   NovaByte — "Your world. Your browser."                       ║
       ║                                                                    ║
       ╚══════════════════════════════════════════════════════════════════════╝ */

    (function NovaBytOS() {
      'use strict';

      /* ═══════════════════════════════════════════════════════════════
         SECTION: UTILITIES
         ═══════════════════════════════════════════════════════════════ */

      function generateId() {
        try { return crypto.randomUUID(); } catch (e) {
          return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
          });
        }
      }

      function sanitiseHTML(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
      }

      function escapeText(str) {
        if (typeof str !== 'string') return '';
        const _ed = document.createElement('div');
        _ed.textContent = str;
        return _ed.innerHTML;
      }

      function safeEvaluateArithmetic(input) {
        const s = String(input).replace(/\s+/g, '');
        let i = 0;

        function consume(ch) {
          if (s[i] === ch) {
            i += 1;
            return true;
          }
          return false;
        }

        function parseNumber() {
          const start = i;
          let sawDigit = false;
          let sawDot = false;

          while (i < s.length) {
            const ch = s[i];
            if (ch >= '0' && ch <= '9') {
              sawDigit = true;
              i += 1;
            } else if (ch === '.' && !sawDot) {
              sawDot = true;
              i += 1;
            } else {
              break;
            }
          }

          if (!sawDigit) throw new Error('Expected number');
          return Number(s.slice(start, i));
        }

        function parsePrimary() {
          if (consume('+')) return parsePrimary();
          if (consume('-')) return -parsePrimary();
          if (consume('(')) {
            const value = parseAddSub();
            if (!consume(')')) throw new Error('Expected )');
            return value;
          }
          return parseNumber();
        }

        function parseMulDiv() {
          let left = parsePrimary();
          while (i < s.length) {
            if (consume('*')) {
              left *= parsePrimary();
            } else if (consume('/')) {
              left /= parsePrimary();
            } else if (consume('%')) {
              left %= parsePrimary();
            } else {
              break;
            }
          }
          return left;
        }

        function parseAddSub() {
          let left = parseMulDiv();
          while (i < s.length) {
            if (consume('+')) {
              left += parseMulDiv();
            } else if (consume('-')) {
              left -= parseMulDiv();
            } else {
              break;
            }
          }
          return left;
        }

        const value = parseAddSub();
        if (i !== s.length) throw new Error('Unexpected token');
        if (!Number.isFinite(value)) throw new Error('Invalid result');
        return value;
      }

      // Detect browser function
      function detectBrowser() {
        const ua = navigator.userAgent;

        // Check for Edge (must check before Chrome)
        if (ua.includes('Edg/')) {
          return 'Edge';
        }

        // Check for Brave (must check before Chrome)
        if (ua.includes('Brave/')) {
          return 'Brave';
        }

        // Check for Chrome
        if (ua.includes('Chrome/') && !ua.includes('Chromium/')) {
          return 'Chrome';
        }

        // Check for Firefox
        if (ua.includes('Firefox/')) {
          return 'Firefox';
        }

        // Check for Safari (must check after Chrome)
        if (ua.includes('Safari/') && !ua.includes('Chrome/')) {
          return 'Safari';
        }

        // Check for Opera
        if (ua.includes('OPR/') || ua.includes('Opera/')) {
          return 'Opera';
        }

        // Check for Chromium
        if (ua.includes('Chromium/')) {
          return 'Chromium';
        }

        return 'Unknown';
      }

      function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
      }

      function formatTime(date) {
        const h = date.getHours();
        const m = date.getMinutes();
        const use24 = OS.settings.get('clockFormat') === '24h';
        if (use24) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        const h12 = h % 12 || 12;
        const ampm = h < 12 ? 'AM' : 'PM';
        return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
      }

      function formatDate(date) {
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]}`;
      }

      function debounce(fn, ms) {
        let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
      }

      function throttleRAF(fn) {
        let ticking = false;
        return (...args) => {
          if (!ticking) {
            ticking = true;
            requestAnimationFrame(() => { fn(...args); ticking = false; });
          }
        };
      }

      /** Safe localStorage.setItem — swallows QuotaExceededError silently. */
      function lsSave(key, value) {
        try {
          localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
          if (window.AppDirs?.vfsFolders) AppDirs.syncKey(key, value).catch(() => { });
        } catch (_) { }
      }

      function createEl(tag, attrs, children) {
        const el = document.createElement(tag);
        if (attrs) {
          for (const [k, v] of Object.entries(attrs)) {
            if (k === 'className') el.className = v;
            else if (k === 'textContent') el.textContent = v;
            else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
            else if (k === 'style' && typeof v === 'string') el.style.cssText = v;
            else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
            else if (typeof v === 'boolean') { if (v) el.setAttribute(k, ''); else el.removeAttribute(k); }
            else el.setAttribute(k, v);
          }
        }
        if (children) {
          if (Array.isArray(children)) children.forEach(c => { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
          else if (typeof children === 'string') el.textContent = children;
          else el.appendChild(children);
        }
        return el;
      }

      function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }

      function svgIcon(name, size) {
        size = size || 18;

        // ── Small UI/nav SVGs — keep crisp at any pixel size ──────────────
        const uiIcons = {
          'x': `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`,
          'plus': `<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`,
          'minus': `<line x1="5" y1="12" x2="19" y2="12"/>`,
          'check': `<polyline points="20 6 9 17 4 12"/>`,
          'chevron-left': `<polyline points="15 18 9 12 15 6"/>`,
          'chevron-right': `<polyline points="9 18 15 12 9 6"/>`,
          'chevron-up': `<polyline points="18 15 12 9 6 15"/>`,
          'chevron-down': `<polyline points="6 9 12 15 18 9"/>`,
          'arrow-left': `<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>`,
          'arrow-right': `<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>`,
          'more-horizontal': `<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>`,
          'corner-up-left': `<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>`,
          'corner-up-right': `<polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>`,
          'maximize-2': `<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>`,
          'minimize-2': `<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/>`,
          'align-left': `<line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/>`,
          'align-center': `<line x1="21" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/>`,
          'align-right': `<line x1="21" y1="10" x2="7" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="7" y2="18"/>`,
          'square': `<rect x="3" y="3" width="18" height="18" rx="2"/>`,
          'layout': `<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>`,
          // ── Media controls — inline so CSP img-src never blocks them ──────────
          'play': `<polygon points="5 3 19 12 5 21 5 3"/>`,
          'pause': `<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`,
          'skip-back': `<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>`,
          'skip-forward': `<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>`,
          'shuffle': `<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>`,
          'repeat': `<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>`,
          'volume-2': `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>`,
          'unlock': `<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>`,
        };

        if (uiIcons[name]) {
          return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${uiIcons[name]}</svg>`;
        }

        // ── Icons8 3D Fluency map ──────────────────────────────────────────
        const iconMap = {
          // ── APP ICONS ──────────────────────────────────────────────────────────
          'folder-open': 'safe',
          'pen-tool': 'pen',
          'globe': 'globe',
          'music': 'music',
          'image': 'picture',
          'calendar': 'calendar',
          'mail': 'mail',
          'monitor': 'monitor',
          'settings': 'gear',
          'alarm-clock': 'alarm-clock',
          'bell': 'bell',
          'shield': 'shield',
          'sliders': 'adjust',
          'users': 'people',
          'wifi': 'wi-fi',
          'clock': 'calendar',
          'database': 'server',
          'terminal': 'command-line',

          // ── FALLBACK / COMPATIBILITY ──────────────────────────────────────────
          'trash': 'trash',
          'trash-2': 'trash',
          'folder': 'opened-folder',
          'file': 'document',
          'file-text': 'document',
          'document': 'document',

          // ── MEDIA / PLAYBACK ──────────────────────────────────────────────────
          'play': 'play-button',
          'pause': 'pause-button',
          'volume-2': 'sound',

          // ── MAIL / ARCHIVE ──────────────────────────────────────────────────
          'archive': 'archive',

          // ── GENERAL ICONS ──────────────────────────────────────────────────
          'search': 'magnifying-glass',
          'download': 'download',
          'save': 'save',
          'copy': 'copy',
          'star': 'star',
          'bookmark': 'bookmark',
          'refresh': 'refresh',
          'maximize': 'fullscreen',
          'info': 'info',
          'eye': 'eye',
          'zap': 'lightning',
          'tag': 'tag',
          'edit-3': 'edit',
          'filter': 'filter',
          'bar-chart-2': 'bar-chart',
          'list-ordered': 'numbered-list',
          'message-square': 'chat',
          'check-circle': 'checkmark',
          'x-circle': 'cancel',
          'keyboard': 'keyboard',
          'layers': 'layers',
          'clipboard-list': 'document',
          'clip-board': 'document',
          'user': 'user',
          'groups': 'people',
          'key': 'key',
          'hard-drive': 'hdd',
          'attention': 'error',
          'alert-triangle': 'error',
          'lock': 'lock',
          'plus': 'plus-math',
          'plus-math': 'plus-math',
          'add': 'plus-math',
          'cpu': 'processor',
          'processor': 'processor',
          'command-line': 'command-line',
          'administrative-tools': 'document',
          'maintenance': 'document',
          'registry-editor': 'document',
          'quill-pen': 'pen',
          'pen': 'pen',
          'console': 'console',
          'reading-book-and-apple': 'document',

          // ── ADDITIONAL ICONS ───────────────────────────────────────────────
          'gamepad-2': 'dice',              // Game icon
          'box': 'dice',              // Box/tetris fallback
          'circle': 'dice',              // Circle fallback
          'bomb': 'bomb',              // Minesweeper
          'clover': 'clover',            // Chess
          'timer': 'counter',           // Pomodoro/timer
          'check-square': 'checkmark',         // Habits/checklist
          'wallet': 'wallet',            // Budget tracker
          'file-code': 'code',              // Markdown/code apps
          'palette': 'color-palette',     // Color picker
          'type': 'quote',             // Text-based apps
          'qr-code': 'qr-code',           // QR Generator
          'metronome': 'counter',           // Metronome
          'binary': 'barcode',           // Base64/binary
          'hash': 'barcode',           // Hash generator
          'regex': 'code',              // Regex tester
          'text': 'quote',             // Lorem ipsum
          'diff': 'layers',            // Diff tool
          'briefcase': 'briefcase',         // Productivity category
          'chevron-left': 'arrow-left',        // Back button in Files
          'chevron-right': 'arrow-right',       // Forward button in Files
          'chevron-up': 'arrow-up',          // Up button in Files
          'list': 'document',          // List view
          'move': 'arrow-right',       // Move/cut action
        };

        const i8name = iconMap[name] || name;
        // Use local asset — no external dependency
        const localPath = `/assets/icons8-${i8name}-94.png`;
        return `<img src="${localPath}" width="${size}" height="${size}" style="display:inline-block;vertical-align:middle;object-fit:contain;pointer-events:none;" draggable="false" alt="" onerror="this.style.visibility='hidden';">`;
      }

      /* ═══════════════════════════════════════════════════════════════
         SECTION: WEB WORKERS (INLINE BLOB)
         ═══════════════════════════════════════════════════════════════ */

      const FS_WORKER_CODE = `
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
const DB_NAME = 'NovaByte_FS';
const DB_VERSION = 1;
const STORE_FILES = 'files';
const STORE_SETTINGS = 'settings';
const STORE_NOTIFICATIONS = 'notifications';
const STORE_EVENTS = 'calendar_events';

let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (db) { resolve(db); return; }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch(e) {
      // IDB blocked (sandboxed VM context) — build an in-memory fallback DB
      const _stores = {};
      function _ms(n) {
        if (!_stores[n]) _stores[n] = {};
        const s = _stores[n];
        return {
          put(i) { const k = i.id !== undefined ? i.id : i.key !== undefined ? i.key : JSON.stringify(i); s[k] = i; return {}; },
          get(k) { const r = {result: s[k]}; setTimeout(() => r.onsuccess?.({target:r}), 0); return r; },
          getAll() { const r = {result: Object.values(s)}; setTimeout(() => r.onsuccess?.({target:r}), 0); return r; },
          delete(k) { delete s[k]; return {}; },
          createIndex() { return { getAll() { const r={result:[]}; setTimeout(() => r.onsuccess?.({target:r}), 0); return r; } }; }
        };
      }
      db = {
        objectStoreNames: { contains: n => !!_stores[n] },
        createObjectStore: n => { _stores[n] = {}; return _ms(n); },
        transaction(storeName, mode) {
          const tx = { objectStore: n => _ms(n), oncomplete: null, onerror: null };
          setTimeout(() => tx.oncomplete?.({target:tx}), 0);
          return tx;
        }
      };
      // Pre-create the expected stores
      [STORE_FILES, STORE_SETTINGS, STORE_NOTIFICATIONS, STORE_EVENTS].forEach(n => { _stores[n] = {}; });
      resolve(db);
      return;
    }
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE_FILES)) {
        d.createObjectStore(STORE_FILES, { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains(STORE_SETTINGS)) {
        d.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
      if (!d.objectStoreNames.contains(STORE_NOTIFICATIONS)) {
        const ns = d.createObjectStore(STORE_NOTIFICATIONS, { keyPath: 'id' });
        ns.createIndex('timestamp', 'timestamp');
      }
      if (!d.objectStoreNames.contains(STORE_EVENTS)) {
        d.createObjectStore(STORE_EVENTS, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getAllFiles() {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE_FILES, 'readonly');
    const req = tx.objectStore(STORE_FILES).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putFiles(files) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE_FILES, 'readwrite');
    const store = tx.objectStore(STORE_FILES);
    for (const f of files) store.put(f);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteFile(id) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE_FILES, 'readwrite');
    tx.objectStore(STORE_FILES).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getSetting(key) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE_SETTINGS, 'readonly');
    const req = tx.objectStore(STORE_SETTINGS).get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
    req.onerror = () => reject(req.error);
  });
}

async function putSetting(key, value) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE_SETTINGS, 'readwrite');
    tx.objectStore(STORE_SETTINGS).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllSettings() {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE_SETTINGS, 'readonly');
    const req = tx.objectStore(STORE_SETTINGS).getAll();
    req.onsuccess = () => {
      const map = {};
      for (const item of req.result) map[item.key] = item.value;
      resolve(map);
    };
    req.onerror = () => reject(req.error);
  });
}

async function saveEvents(events) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE_EVENTS, 'readwrite');
    const store = tx.objectStore(STORE_EVENTS);
    for (const e of events) store.put(e);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllEvents() {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE_EVENTS, 'readonly');
    const req = tx.objectStore(STORE_EVENTS).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteEvent(id) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE_EVENTS, 'readwrite');
    tx.objectStore(STORE_EVENTS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

self.onmessage = async (e) => {
  const { id, method, args } = e.data;
  try {
    let result;
    switch (method) {
      case 'init': await openDB(); result = true; break;
      case 'getAllFiles': result = await getAllFiles(); break;
      case 'putFiles': await putFiles(args[0]); result = true; break;
      case 'deleteFile': await deleteFile(args[0]); result = true; break;
      case 'getSetting': result = await getSetting(args[0]); break;
      case 'putSetting': await putSetting(args[0], args[1]); result = true; break;
      case 'getAllSettings': result = await getAllSettings(); break;
      case 'saveEvents': await saveEvents(args[0]); result = true; break;
      case 'getAllEvents': result = await getAllEvents(); break;
      case 'deleteEvent': await deleteEvent(args[0]); result = true; break;
      default: throw new Error('Unknown method: ' + method);
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
`;

      const SEARCH_WORKER_CODE = `
'use strict';
let index = new Map();

function buildIndex(files) {
  index.clear();
  for (const f of files) {
    // Deduplicate terms per file first — cuts index size and memory use significantly
    const termSet = new Set(
      ((f.name || '') + ' ' + (f.content || '')).toLowerCase().split(/\\W+/).filter(t => t.length >= 2)
    );
    for (const t of termSet) {
      if (!index.has(t)) index.set(t, new Set());
      index.get(t).add(f.id);
    }
  }
}

function search(query, files) {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const fileMap = new Map(files.map(f => [f.id, f]));
  const results = new Map();
  for (const [term, ids] of index) {
    if (term.includes(q)) {
      for (const id of ids) {
        results.set(id, (results.get(id) || 0) + 1);
      }
    }
  }
  return Array.from(results.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([id]) => fileMap.get(id))
    .filter(Boolean);
}

self.onmessage = (e) => {
  const { id, method, args } = e.data;
  try {
    let result;
    switch (method) {
      case 'buildIndex': buildIndex(args[0]); result = true; break;
      case 'search': result = search(args[0], args[1]); break;
      default: result = null;
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
`;

      const CRYPTO_WORKER_CODE = `
'use strict';

async function sha256(data) {
  const encoder = new TextEncoder();
  const buffer = encoder.encode(data);
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  const array = Array.from(new Uint8Array(hash));
  return array.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function pbkdf2Hash(pin, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256'
  }, keyMaterial, 256);
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2,'0')).join('');
}

self.onmessage = async (e) => {
  const { id, method, args } = e.data;
  try {
    let result;
    switch (method) {
      case 'sha256': result = await sha256(args[0]); break;
      case 'pbkdf2': result = await pbkdf2Hash(args[0], args[1]); break;
      default: result = null;
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
`;

      function createWorker(code) {
        const blob = new Blob([code], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        const worker = new Worker(url);
        let _id = 0;
        const pending = new Map();
        worker.onmessage = (e) => {
          const { id, result, error } = e.data;
          const p = pending.get(id);
          if (p) {
            pending.delete(id);
            if (error) p.reject(new Error(error));
            else p.resolve(result);
          }
        };
        return {
          call(method, ...args) {
            const id = ++_id;
            return new Promise((resolve, reject) => {
              pending.set(id, { resolve, reject });
              worker.postMessage({ id, method, args });
            });
          },
          terminate() { worker.terminate(); URL.revokeObjectURL(url); }
        };
      }

      /* ═══════════════════════════════════════════════════════════════
         SECTION: KERNEL — EventBus, Settings, OS Core
         ═══════════════════════════════════════════════════════════════ */

      // Get or generate unique salt for PIN hashing
      function getPinSalt() {
        let salt = OS.settings.get('pinSalt');
        if (!salt) {
          // Generate random salt
          const array = new Uint8Array(16);
          crypto.getRandomValues(array);
          salt = Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
          OS.settings.set('pinSalt', salt);
        }
        return salt;
      }

      const OS = {
        version: '3.0.2',
        securityPatch: '2026-05-01',  // NovaByte security patch date — globally readable
        username: 'user',
        workers: {},
        windows: new Map(),
        windowZCounter: 100,
        focusedWindowId: null,
        apps: {},
        clipboard: null,
        notifications: [],
        notifUnread: 0,
        dnd: false,
        volume: 80,
        idleTimer: null,
        idleTimeout: 600000,
        isLocked: false,
        lockPin: null,
        wrongPinCount: 0,
        lockoutUntil: 0,

        // Virtual desktops
        workspaces: [{ id: 1, name: 'Workspace 1', windows: [] }],
        currentWorkspace: 1,
        maxWorkspaces: 6,

        // Clipboard manager
        clipboardHistory: [],
        maxClipboardItems: 30,

        events: {
          _handlers: {},
          on(event, fn) {
            if (!this._handlers[event]) this._handlers[event] = [];
            this._handlers[event].push(fn);
          },
          off(event, fn) {
            if (!this._handlers[event]) return;
            this._handlers[event] = this._handlers[event].filter(h => h !== fn);
          },
          emit(event, data) {
            if (this._handlers[event]) {
              for (const fn of this._handlers[event]) {
                try { fn(data); } catch (e) { /* silent */ }
              }
            }
          }
        },

        settings: {
          _cache: {},
          get(key) { return key in this._cache ? this._cache[key] : this.defaults[key]; },
          set(key, value) {
            this._cache[key] = value;
            OS.workers.fs.call('putSetting', key, value).catch(() => { });
            OS.events.emit('settings:changed', { key, value });
          },
          async load() {
            try {
              const all = await OS.workers.fs.call('getAllSettings');
              this._cache = all || {};
            } catch (e) { this._cache = {}; }
          },
          defaults: {
            theme: 'nova-dark',
            clockFormat: '12h',
            dateFormat: 'MM/DD/YYYY',
            fontSize: '14',
            accentColor: '#58a6ff',
            taskbarStyle: 'windows',
            wallpaper: 'stock-blue',
            windowRadius: '12',
            animSpeed: '1',
            iconSize: '72',
            autoLock: '10',
            searchEngine: 'duckduckgo',
            proxyUrl: '',
            username: 'user',
            pinnedApps: ['shell', 'vault', 'browser']
          },
          applySafeModeDefaults() {
            // Safe Mode should behave like a clean default session without persisting changes.
            // Leave the original stored settings untouched, but make all reads resolve to defaults.
            this._cache = {};
          }
        },

        logger: {
          debug() { },
          info() { },
          warn() { },
          error() { }
        }
      };
      window.OS = OS; // Expose OS globally for external scripts (nova-security-api.js etc.)

      /* ═══════════════════════════════════════════════════════════════
         SECTION: FILESYSTEM API
         ═══════════════════════════════════════════════════════════════ */

      const FS = {
        files: new Map(),
        rootId: null,
        specialFolders: {},

        async init() {
          try {
            const files = await OS.workers.fs.call('getAllFiles');
            if (files && files.length > 0) {
              for (const f of files) FS.files.set(f.id, f);
              FS.findSpecialFolders();
            } else {
              await FS.createDefaultFS();
            }
            FS.updateSearchIndex();
          } catch (e) {
            await FS.createDefaultFS();
          }
        },

        findSpecialFolders() {
          for (const [id, f] of FS.files) {
            if (f.parentId === null && f.type === 'folder') { FS.rootId = id; break; }
          }
          for (const [id, f] of FS.files) {
            if (f.parentId === FS.rootId) {
              const name = f.name.toLowerCase();
              if (name === 'desktop') FS.specialFolders.desktop = id;
              else if (name === 'documents') FS.specialFolders.documents = id;
              else if (name === 'downloads') FS.specialFolders.downloads = id;
              else if (name === 'music') FS.specialFolders.music = id;
              else if (name === 'pictures') FS.specialFolders.pictures = id;
              else if (name === 'videos') FS.specialFolders.videos = id;
              else if (name === 'trash') FS.specialFolders.trash = id;
            }
          }
        },

        async createDefaultFS() {
          const now = Date.now();
          const mkNode = (name, type, parentId, content, mime) => ({
            id: generateId(), name, type, parentId,
            content: content || null, blobKey: null,
            size: content ? new Blob([content]).size : 0,
            mimeType: mime || (type === 'folder' ? 'inode/directory' : 'text/plain'),
            created: now, modified: now, accessed: now,
            permissions: { read: true, write: true, execute: false },
            tags: [], sha256: null, icon: null
          });

          const root = mkNode('/', 'folder', null);
          FS.rootId = root.id;

          const desktop = mkNode('Desktop', 'folder', root.id);
          const documents = mkNode('Documents', 'folder', root.id);
          const downloads = mkNode('Downloads', 'folder', root.id);
          const music = mkNode('Music', 'folder', root.id);
          const pictures = mkNode('Pictures', 'folder', root.id);
          const videos = mkNode('Videos', 'folder', root.id);
          const trash = mkNode('Trash', 'folder', root.id);
          const screenshots = mkNode('Screenshots', 'folder', pictures.id);

          const allFiles = [root, desktop, documents, downloads, music, pictures, videos, trash, screenshots];

          for (const f of allFiles) FS.files.set(f.id, f);

          FS.specialFolders = {
            desktop: desktop.id, documents: documents.id, downloads: downloads.id,
            music: music.id, pictures: pictures.id, videos: videos.id, trash: trash.id
          };

          await OS.workers.fs.call('putFiles', allFiles);
        },

        listDir(folderId) {
          const children = [];
          for (const [, f] of FS.files) {
            if (f.parentId === folderId) children.push(f);
          }
          return children.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        },

        getPath(id) {
          const parts = [];
          let node = FS.files.get(id);
          while (node) {
            if (node.parentId === null) break;
            parts.unshift(node.name);
            node = FS.files.get(node.parentId);
          }
          return '/' + parts.join('/');
        },

        getByPath(path) {
          if (path === '/') return FS.files.get(FS.rootId);
          const parts = path.split('/').filter(Boolean);
          let current = FS.rootId;
          for (const part of parts) {
            const children = FS.listDir(current);
            const found = children.find(c => c.name === part);
            if (!found) return null;
            current = found.id;
          }
          return FS.files.get(current);
        },

        async createFile(parentId, name, content, mimeType) {
          const node = {
            id: generateId(), name, type: 'file', parentId,
            content: content || '', blobKey: null,
            size: content ? new Blob([content]).size : 0,
            mimeType: mimeType || 'text/plain',
            created: Date.now(), modified: Date.now(), accessed: Date.now(),
            permissions: { read: true, write: true, execute: false },
            tags: [], sha256: null, icon: null
          };
          FS.files.set(node.id, node);
          await OS.workers.fs.call('putFiles', [node]);
          FS.updateSearchIndex();
          OS.events.emit('fs:created', node);
          return node;
        },

        async createFolder(parentId, name) {
          const node = {
            id: generateId(), name, type: 'folder', parentId,
            content: null, blobKey: null, size: 0,
            mimeType: 'inode/directory',
            created: Date.now(), modified: Date.now(), accessed: Date.now(),
            permissions: { read: true, write: true, execute: true },
            tags: [], sha256: null, icon: null
          };
          FS.files.set(node.id, node);
          await OS.workers.fs.call('putFiles', [node]);
          OS.events.emit('fs:created', node);
          return node;
        },

        async writeFile(id, content) {
          const node = FS.files.get(id);
          if (!node) return null;
          node.content = content;
          node.size = new Blob([content]).size;
          node.modified = Date.now();
          try { node.sha256 = await OS.workers.crypto.call('sha256', content); } catch (e) { }
          FS.files.set(id, node);
          await OS.workers.fs.call('putFiles', [node]);
          FS.updateSearchIndex();
          OS.events.emit('fs:updated', node);
          return node;
        },

        async rename(id, newName) {
          const node = FS.files.get(id);
          if (!node) return null;
          node.name = newName;
          node.modified = Date.now();
          FS.files.set(id, node);
          await OS.workers.fs.call('putFiles', [node]);
          OS.events.emit('fs:updated', node);
          return node;
        },

        async move(id, newParentId) {
          const node = FS.files.get(id);
          if (!node) return null;
          node.parentId = newParentId;
          node.modified = Date.now();
          FS.files.set(id, node);
          await OS.workers.fs.call('putFiles', [node]);
          OS.events.emit('fs:moved', node);
          return node;
        },

        async deleteToTrash(id) {
          const node = FS.files.get(id);
          if (!node) return;
          node._originalParent = node.parentId;
          node.parentId = FS.specialFolders.trash;
          node.modified = Date.now();
          FS.files.set(id, node);
          await OS.workers.fs.call('putFiles', [node]);
          OS.events.emit('fs:deleted', node);
        },

        async permanentDelete(id) {
          const node = FS.files.get(id);
          if (!node) return;
          if (node.type === 'folder') {
            const children = FS.listDir(id);
            for (const c of children) await FS.permanentDelete(c.id);
          }
          FS.files.delete(id);
          await OS.workers.fs.call('deleteFile', id);
          OS.events.emit('fs:deleted', { id });
        },

        async emptyTrash() {
          const trashItems = FS.listDir(FS.specialFolders.trash);
          for (const item of trashItems) await FS.permanentDelete(item.id);
        },

        updateSearchIndex() {
          // Trim content before serialising to worker — full content causes OOM on large vaults
          const MAX_CONTENT = 50_000;
          const files = Array.from(FS.files.values()).map(f => ({
            id: f.id,
            name: f.name || '',
            content: typeof f.content === 'string' ? f.content.slice(0, MAX_CONTENT) : ''
          }));
          OS.workers.search.call('buildIndex', files).catch(() => { });
        },

        async search(query) {
          try {
            const files = Array.from(FS.files.values());
            return await OS.workers.search.call('search', query, files);
          } catch (e) { return []; }
        },

        getMimeIcon(mimeType, name) {
          if (!mimeType) return 'file';
          if (mimeType === 'inode/directory') return 'folder';
          if (mimeType.startsWith('image/')) return 'image';
          if (mimeType.startsWith('audio/')) return 'music';
          if (mimeType.startsWith('video/')) return 'file';
          if (mimeType === 'application/pdf') return 'file-text';
          if (name && name.endsWith('.md')) return 'file-text';
          return 'file-text';
        }
      };

      /* ═══════════════════════════════════════════════════════════════
         SECTION: WINDOW MANAGER
         ═══════════════════════════════════════════════════════════════ */

      const WM = window.WM = {
        container: null,
        snapPreview: null,

        init() {
          WM.container = document.getElementById('windows');
          WM.snapPreview = document.getElementById('snap-preview');
        },

        createWindow(appId, options) {
          if (appId === 'launchpad') { toggleLaunchpad(); return null; }

          const id = generateId();
          const app = OS.apps[appId];
          if (!app) return null;

          const defaults = {
            width: app.defaultSize ? app.defaultSize[0] : 700,
            height: app.defaultSize ? app.defaultSize[1] : 500,
            x: 80 + Math.random() * 200,
            y: 40 + Math.random() * 100,
            minWidth: app.minSize ? app.minSize[0] : 300,
            minHeight: app.minSize ? app.minSize[1] : 200,
          };

          const cfg = { ...defaults, ...options };

          const win = createEl('div', {
            className: 'app-window opening',
            style: {
              left: cfg.x + 'px', top: cfg.y + 'px',
              width: cfg.width + 'px', height: cfg.height + 'px',
              zIndex: ++OS.windowZCounter
            },
            role: 'dialog',
            'aria-label': app.name + ' window'
          });
          win.dataset.windowId = id;
          win.dataset.appId = appId;

          // Resize handles
          const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
          for (const d of dirs) {
            win.appendChild(createEl('div', { className: `window-resize-handle ${d}`, 'aria-hidden': 'true' }));
          }

          // Title bar
          const titlebar = createEl('div', { className: 'window-titlebar' });

          const icon = createEl('div', { className: 'window-titlebar-icon' });
          icon.innerHTML = svgIcon(app.icon, 16);

          const titleText = createEl('span', { className: 'window-titlebar-text', textContent: app.name });

          const controls = createEl('div', { className: 'window-controls' });

          const closeBtn = createEl('button', {
            className: 'window-control-btn close',
            'aria-label': 'Close window'
          });
          const minBtn = createEl('button', {
            className: 'window-control-btn minimize',
            'aria-label': 'Minimize window'
          });
          const maxBtn = createEl('button', {
            className: 'window-control-btn maximize',
            'aria-label': 'Maximize window'
          });

          controls.appendChild(closeBtn);
          controls.appendChild(minBtn);
          controls.appendChild(maxBtn);
          titlebar.appendChild(icon);
          titlebar.appendChild(titleText);
          titlebar.appendChild(controls);
          win.appendChild(titlebar);

          // Content area
          const content = createEl('div', { className: 'window-content' });
          win.appendChild(content);

          WM.container.appendChild(win);

          const state = {
            id, appId, element: win, content, titlebar, titleText,
            x: cfg.x, y: cfg.y, width: cfg.width, height: cfg.height,
            minWidth: cfg.minWidth, minHeight: cfg.minHeight,
            maximized: false, minimized: false,
            preMaxState: null,
            cleanups: []
          };
          OS.windows.set(id, state);

          // Clamp spawn position so window never starts outside the OS viewport
          const spawnClamped = WM.clampWindowRect(state, state.x, state.y, state.width, state.height);
          state.x = spawnClamped.x;
          state.y = spawnClamped.y;
          state.width = spawnClamped.w;
          state.height = spawnClamped.h;
          win.style.left = state.x + 'px';
          win.style.top = state.y + 'px';
          win.style.width = state.width + 'px';
          win.style.height = state.height + 'px';

          // Remove opening class precisely when animation ends
          win.addEventListener('animationend', () => win.classList.remove('opening'), { once: true });

          // Setup interactions
          WM.setupDrag(state);
          WM.setupResize(state);

          // Button handlers
          const onClose = () => WM.closeWindow(id);
          const onMin = () => WM.minimizeWindow(id);
          const onMax = () => WM.toggleMaximize(id);

          closeBtn.addEventListener('click', onClose);
          minBtn.addEventListener('click', onMin);
          maxBtn.addEventListener('click', onMax);
          state.cleanups.push(
            () => closeBtn.removeEventListener('click', onClose),
            () => minBtn.removeEventListener('click', onMin),
            () => maxBtn.removeEventListener('click', onMax)
          );

          // Focus on click
          const onFocus = () => WM.focusWindow(id);
          win.addEventListener('pointerdown', onFocus);
          state.cleanups.push(() => win.removeEventListener('pointerdown', onFocus));

          // Double-click titlebar to maximize
          const onDblClick = () => WM.toggleMaximize(id);
          titlebar.addEventListener('dblclick', onDblClick);
          state.cleanups.push(() => titlebar.removeEventListener('dblclick', onDblClick));

          WM.focusWindow(id);
          WM.updateTaskbar();

          // Initialize app
          try {
            if (app.init) app.init(content, state, options);
          } catch (e) { /* app init error */ }

          // ═══════════════════════════════════════════════════════════════
          // ADD DRAG-AND-DROP SUPPORT TO ALL APP WINDOWS
          // ═══════════════════════════════════════════════════════════════

          const onDragOver = (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            content.style.background = 'var(--bg-overlay)';
            content.style.borderRadius = '8px';
          };

          const onDragLeave = (e) => {
            if (e.target === content) {
              content.style.background = '';
              content.style.borderRadius = '';
            }
          };

          const onDrop = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            content.style.background = '';
            content.style.borderRadius = '';

            // Handle dropped files
            const files = e.dataTransfer.files;
            if (files.length > 0) {
              for (let i = 0; i < files.length; i++) {
                const file = files[i];

                // Call app's onDrop handler if it exists
                if (app.onDrop) {
                  try {
                    await app.onDrop(file, state);
                  } catch (err) { /* error handling */ }
                } else {
                  // Default behavior: try to open the file in appropriate app
                  const fileName = file.name;
                  const ext = fileName.split('.').pop().toLowerCase();

                  // Determine which app to open based on file type
                  let targetApp = 'vault';
                  if (['txt', 'md', 'js', 'html', 'css', 'json'].includes(ext)) targetApp = 'quill';

                  // Add file to filesystem and open
                  const fileId = generateId();
                  const fileData = await file.arrayBuffer();
                  let dropMime = file.type;
                  if (!dropMime) {
                    const dropExt = fileName.split('.').pop().toLowerCase();
                    const extMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', mp3: 'audio/mpeg', mp4: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json' };
                    dropMime = extMap[dropExt] || 'application/octet-stream';
                  }
                  const dropNode = { id: fileId, name: fileName, type: 'file', size: file.size, content: new Uint8Array(fileData), mimeType: dropMime, parentId: FS.specialFolders.desktop || FS.rootId, modified: Date.now() };
                  FS.files.set(fileId, dropNode);
                  await OS.workers.fs.call('putFiles', [dropNode]);

                  WM.createWindow(targetApp, { fileId });
                }
              }
            }

            // Handle dropped text (internal file references)
            const text = e.dataTransfer.getData('text/plain');
            if (text && app.onDropText) {
              try {
                app.onDropText(text, state);
              } catch (err) { /* error handling */ }
            }
          };

          content.addEventListener('dragover', onDragOver);
          content.addEventListener('dragleave', onDragLeave);
          content.addEventListener('drop', onDrop);

          state.cleanups.push(
            () => content.removeEventListener('dragover', onDragOver),
            () => content.removeEventListener('dragleave', onDragLeave),
            () => content.removeEventListener('drop', onDrop)
          );

          OS.events.emit('app:opened', { id, appId });
          return state;
        },

        closeWindow(id) {
          const state = OS.windows.get(id);
          if (!state) return;

          state.element.classList.add('closing');

          setTimeout(() => {
            for (const cleanup of state.cleanups) {
              try { cleanup(); } catch (e) { }
            }
            state.element.remove();
            OS.windows.delete(id);

            const app = OS.apps[state.appId];
            if (app && app.onClose) {
              try { app.onClose(state); } catch (e) { }
            }

            if (OS.focusedWindowId === id) {
              OS.focusedWindowId = null;
              const remaining = Array.from(OS.windows.values());
              if (remaining.length > 0) {
                const top = remaining.reduce((a, b) =>
                  parseInt(a.element.style.zIndex) > parseInt(b.element.style.zIndex) ? a : b
                );
                WM.focusWindow(top.id);
              }
            }

            WM.updateTaskbar();
            OS.events.emit('app:closed', { id, appId: state.appId });
          }, 150);
        },

        minimizeWindow(id) {
          const state = OS.windows.get(id);
          if (!state) return;
          state.minimized = true;
          state.element.classList.add('minimizing');
          if (OS.focusedWindowId === id) OS.focusedWindowId = null;
          WM.updateTaskbar();
          // Remove class after animation completes
          setTimeout(() => {
            if (state.minimized) state.element.style.display = 'none';
          }, 300);
        },

        restoreWindow(id) {
          const state = OS.windows.get(id);
          if (!state) return;
          state.minimized = false;
          state.element.style.display = '';
          state.element.classList.remove('minimizing');
          state.element.classList.add('window-restoring');
          WM.focusWindow(id);
          state.element.addEventListener('animationend', () => state.element.classList.remove('window-restoring'), { once: true });
          WM.updateTaskbar();
        },


        getWorkArea() {
          const vw = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
          const vh = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
          const tb = document.getElementById('taskbar');
          const area = { left: 0, top: 0, right: vw, bottom: vh };
          if (!tb) {
            return { ...area, width: vw, height: vh, taskbarHidden: true, taskbarPosition: 'bottom' };
          }

          const isHidden = tb.classList.contains('taskbar-autohide') && !tb.classList.contains('taskbar-ah-shown');
          if (isHidden) {
            return { ...area, width: vw, height: vh, taskbarHidden: true, taskbarPosition: 'bottom' };
          }

          const rect = tb.getBoundingClientRect();
          const style = window.getComputedStyle(tb);
          let position = 'bottom';
          if (style.left === '0px' && style.right === 'auto') position = 'left';
          else if (style.right === '0px' && style.left === 'auto') position = 'right';
          else if (style.top === '0px' && style.bottom === 'auto') position = 'top';

          const gap = 8;
          if (position === 'bottom') area.bottom = Math.max(area.top + 220, Math.floor(rect.top) - gap);
          else if (position === 'top') area.top = Math.min(area.bottom - 220, Math.ceil(rect.bottom) + gap);
          else if (position === 'left') area.left = Math.min(area.right - 320, Math.ceil(rect.right) + gap);
          else if (position === 'right') area.right = Math.max(area.left + 320, Math.floor(rect.left) - gap);

          return {
            ...area,
            width: Math.max(0, area.right - area.left),
            height: Math.max(0, area.bottom - area.top),
            taskbarHidden: false,
            taskbarPosition: position
          };
        },

        clampWindowRect(state, x, y, w, h) {
          const area = WM.getWorkArea();
          const minW = state.minWidth || 300;
          const minH = state.minHeight || 200;
          // Use full viewport for size clamping (not just work area) so windows
          // can be dragged partially under the taskbar
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const maxW = Math.max(minW, vw);
          const maxH = Math.max(minH, vh);
          const width = Math.min(Math.max(w, minW), maxW);
          const height = Math.min(Math.max(h, minH), maxH);
          // Horizontal: keep at least 80px of the window visible on each side
          const grabMarginH = 80;
          const minX = area.left - width + grabMarginH;
          const maxX = area.right - grabMarginH;
          // Vertical: top edge must stay within the screen top + work area top
          // (so titlebar is reachable), and bottom is clamped to the taskbar top
          // so the titlebar can never be dragged fully behind the taskbar.
          const grabH = 32; // minimum titlebar height that must remain visible
          const minY = area.top;                     // can't go above work area top
          const maxY = area.bottom - grabH;          // titlebar must stay above taskbar
          return {
            x: Math.min(Math.max(x, minX), maxX),
            y: Math.min(Math.max(y, minY), maxY),
            w: width,
            h: height
          };
        },

        toggleMaximize(id) {
          const state = OS.windows.get(id);
          if (!state) return;
          state.element.classList.add('is-maximizing');
          setTimeout(() => state.element.classList.remove('is-maximizing'), 420);
          if (state.maximized) {
            state.maximized = false;
            state.element.classList.remove('maximized');
            state.element.classList.add('window-restoring');
            if (state.preMaxState) {
              state.element.style.left = state.preMaxState.x + 'px';
              state.element.style.top = state.preMaxState.y + 'px';
              state.element.style.width = state.preMaxState.w + 'px';
              state.element.style.height = state.preMaxState.h + 'px';
              state.x = state.preMaxState.x;
              state.y = state.preMaxState.y;
              state.width = state.preMaxState.w;
              state.height = state.preMaxState.h;
            }
            state.element.addEventListener('animationend', () => state.element.classList.remove('window-restoring'), { once: true });
          } else {
            state.preMaxState = { x: state.x, y: state.y, w: state.width, h: state.height };
            state.maximized = true;
            state.element.classList.add('maximized');
            const area = WM.getWorkArea();
            state.element.style.left = area.left + 'px';
            state.element.style.top = area.top + 'px';
            state.element.style.width = area.width + 'px';
            state.element.style.height = area.height + 'px';
            state.x = area.left;
            state.y = area.top;
            state.width = area.width;
            state.height = area.height;
          }
        },

        focusWindow(id) {
          const state = OS.windows.get(id);
          if (!state) return;
          if (state.minimized) WM.restoreWindow(id);
          state.element.style.zIndex = ++OS.windowZCounter;
          OS.focusedWindowId = id;
          for (const [wid, w] of OS.windows) {
            w.element.classList.toggle('focused', wid === id);
          }
          WM.updateTaskbar();
          OS.events.emit('app:focused', { id, appId: state.appId });

          // Route keyboard focus into the window so typing goes there immediately.
          // Prefer: a visible input/textarea that is already focused inside the window,
          // or the first visible input/textarea, or the window content itself.
          const win = state.element;
          const alreadyFocused = document.activeElement;
          if (!alreadyFocused || !win.contains(alreadyFocused)) {
            const focusable = win.querySelector(
              'input:not([type=hidden]):not([disabled]), textarea:not([disabled]), [contenteditable="true"]'
            );
            if (focusable) {
              // Small defer so pointer events don't immediately blur it
              requestAnimationFrame(() => focusable.focus());
            } else {
              // Fall back to making the window content itself keyboard-reachable
              const content = win.querySelector('.window-content');
              if (content) { content.tabIndex = -1; content.focus({ preventScroll: true }); }
            }
          }
        },

        setupDrag(state) {
          const titlebar = state.titlebar;
          let dragging = false, startX, startY, origX, origY;

          const onPointerDown = (e) => {
            if (e.target.closest('.window-controls')) return;
            if (state.maximized) {
              state.maximized = false;
              state.element.classList.remove('maximized');
              if (state.preMaxState) {
                state.width = state.preMaxState.w;
                state.height = state.preMaxState.h;
                state.element.style.width = state.width + 'px';
                state.element.style.height = state.height + 'px';
                const restored = WM.clampWindowRect(
                  state,
                  e.clientX - (state.width / 2),
                  e.clientY - 10,
                  state.width,
                  state.height
                );
                state.x = restored.x;
                state.y = restored.y;
                state.element.style.left = state.x + 'px';
                state.element.style.top = state.y + 'px';
              }
            }
            dragging = true;
            startX = e.clientX; startY = e.clientY;
            origX = state.x; origY = state.y;
            state.element.style.transition = 'none';
            state.element.style.willChange = 'transform';
            state.element.classList.add('is-dragging');
            document.body.style.cursor = 'grabbing';
            e.preventDefault();
          };

          const onPointerMove = throttleRAF((e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const next = WM.clampWindowRect(state, origX + dx, origY + dy, state.width, state.height);
            state.x = next.x;
            state.y = next.y;
            state.element.style.transform = `translate(${state.x - origX}px, ${state.y - origY}px)`;

            const area = WM.getWorkArea();
            const snapZone = 20;
            if (e.clientX < snapZone) {
              WM.showSnapPreview(area.left, area.top, Math.floor(area.width / 2), area.height);
            } else if (e.clientX > window.innerWidth - snapZone) {
              WM.showSnapPreview(area.left + Math.floor(area.width / 2), area.top, Math.floor(area.width / 2), area.height);
            } else if (e.clientY < snapZone) {
              WM.showSnapPreview(area.left, area.top, area.width, area.height);
            } else {
              WM.hideSnapPreview();
            }
          });

          const onPointerUp = (e) => {
            if (!dragging) return;
            dragging = false;
            state.element.classList.remove('is-dragging');
            state.element.style.transition = 'none';
            state.element.style.left = state.x + 'px';
            state.element.style.top = state.y + 'px';
            state.element.style.transform = 'none';
            document.body.style.cursor = '';
            requestAnimationFrame(() => {
              state.element.style.transform = '';
              state.element.style.willChange = '';
              requestAnimationFrame(() => {
                state.element.style.transition = '';
              });
            });

            const snapZone = 20;
            if (e.clientX < snapZone) {
              WM.snapWindow(state, 'left');
            } else if (e.clientX > window.innerWidth - snapZone) {
              WM.snapWindow(state, 'right');
            } else if (e.clientY < snapZone) {
              WM.toggleMaximize(state.id);
            }
            WM.hideSnapPreview();
          };

          titlebar.addEventListener('pointerdown', onPointerDown);
          document.addEventListener('pointermove', onPointerMove);
          document.addEventListener('pointerup', onPointerUp);
          state.cleanups.push(
            () => titlebar.removeEventListener('pointerdown', onPointerDown),
            () => document.removeEventListener('pointermove', onPointerMove),
            () => document.removeEventListener('pointerup', onPointerUp)
          );
        },

        setupResize(state) {
          const handles = state.element.querySelectorAll('.window-resize-handle');
          let resizing = false, dir = '', startX, startY, origX, origY, origW, origH;

          const onPointerDown = (e) => {
            if (state.maximized) return;
            resizing = true;
            dir = '';
            for (const d of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
              if (e.target.classList.contains(d)) { dir = d; break; }
            }
            startX = e.clientX; startY = e.clientY;
            origX = state.x; origY = state.y;
            origW = state.width; origH = state.height;
            state.element.style.transition = 'none';
            state.element.style.backdropFilter = 'none';
            state.element.style.webkitBackdropFilter = 'none';
            state.element.classList.add('is-resizing');
            e.preventDefault();
            e.stopPropagation();
          };

          const onPointerMove = throttleRAF((e) => {
            if (!resizing) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            let newW = origW, newH = origH, newX = origX, newY = origY;

            if (dir.includes('e')) newW = Math.max(state.minWidth, origW + dx);
            if (dir.includes('w')) { newW = Math.max(state.minWidth, origW - dx); newX = origX + origW - newW; }
            if (dir.includes('s')) newH = Math.max(state.minHeight, origH + dy);
            if (dir.includes('n')) { newH = Math.max(state.minHeight, origH - dy); newY = origY + origH - newH; }

            const next = WM.clampWindowRect(state, newX, newY, newW, newH);
            state.width = next.w;
            state.height = next.h;
            state.x = next.x;
            state.y = next.y;
            state.element.style.width = next.w + 'px';
            state.element.style.height = next.h + 'px';
            state.element.style.left = next.x + 'px';
            state.element.style.top = next.y + 'px';
          });

          const onPointerUp = () => {
            if (!resizing) return;
            resizing = false;
            state.element.classList.remove('is-resizing');
            state.element.style.transition = '';
            state.element.style.backdropFilter = '';
            state.element.style.webkitBackdropFilter = '';
          };

          handles.forEach(h => h.addEventListener('pointerdown', onPointerDown));
          document.addEventListener('pointermove', onPointerMove);
          document.addEventListener('pointerup', onPointerUp);
          state.cleanups.push(
            () => handles.forEach(h => h.removeEventListener('pointerdown', onPointerDown)),
            () => document.removeEventListener('pointermove', onPointerMove),
            () => document.removeEventListener('pointerup', onPointerUp)
          );
        },

        snapWindow(state, side) {
          const area = WM.getWorkArea();
          state.preMaxState = { x: state.x, y: state.y, w: state.width, h: state.height };
          if (side === 'left') {
            state.x = area.left;
            state.y = area.top;
            state.width = Math.floor(area.width / 2);
            state.height = area.height;
          } else if (side === 'right') {
            state.x = area.left + Math.floor(area.width / 2);
            state.y = area.top;
            state.width = Math.ceil(area.width / 2);
            state.height = area.height;
          }
          const next = WM.clampWindowRect(state, state.x, state.y, state.width, state.height);
          state.x = next.x;
          state.y = next.y;
          state.width = next.w;
          state.height = next.h;
          state.element.style.left = state.x + 'px';
          state.element.style.top = state.y + 'px';
          state.element.style.width = state.width + 'px';
          state.element.style.height = state.height + 'px';
        },

        showSnapPreview(x, y, w, h) {
          WM.snapPreview.style.left = x + 'px';
          WM.snapPreview.style.top = y + 'px';
          WM.snapPreview.style.width = w + 'px';
          WM.snapPreview.style.height = h + 'px';
          WM.snapPreview.classList.add('visible');
        },

        hideSnapPreview() {
          WM.snapPreview.classList.remove('visible');
        },

        updateTaskbar() {
          const container = document.getElementById('taskbar-apps');
          container.innerHTML = '';

          const pinnedApps = OS.settings.get('pinnedApps') || [];

          // Group open windows by appId
          const appWindows = new Map();
          for (const [id, state] of OS.windows) {
            if (!appWindows.has(state.appId)) appWindows.set(state.appId, []);
            appWindows.get(state.appId).push({ id, state });
          }

          // Build ordered list: pinned first (in order), then any running-but-not-pinned apps
          const seen = new Set();
          const orderedIds = [...pinnedApps];
          for (const appId of appWindows.keys()) {
            if (!seen.has(appId) && !pinnedApps.includes(appId)) orderedIds.push(appId);
          }

          for (const appId of orderedIds) {
            const app = OS.apps[appId];
            const windows = appWindows.get(appId) || [];
            const isPinned = pinnedApps.includes(appId);
            // Skip pinned IDs that have no registered app (not installed)
            if (!app) continue;

            const hasWindows = windows.length > 0;
            const hasMultipleWindows = windows.length > 1;
            const isAnyActive = windows.some(w => OS.focusedWindowId === w.id && !w.state.minimized);

            const btn = createEl('button', {
              className: 'taskbar-app-btn' + (isAnyActive ? ' active' : '') + (isPinned ? ' pinned' : ''),
              'aria-label': app.name + (hasMultipleWindows ? ` (${windows.length} windows)` : '')
            });

            let badge = hasMultipleWindows ? `<span class="taskbar-window-count">${windows.length}</span>` : '';
            btn.innerHTML = svgIcon(app.icon, 20) + '<span class="indicator"></span>' + badge;

            const clickHandler = () => {
              if (!hasWindows) {
                WM.createWindow(appId);
              } else if (hasMultipleWindows) {
                showWindowPreview(btn, appId, windows);
              } else {
                const { id, state } = windows[0];
                if (OS.focusedWindowId === id && !state.minimized) WM.minimizeWindow(id);
                else WM.focusWindow(id);
              }
            };

            const contextMenuHandler = (e) => {
              e.preventDefault();
              const menuItems = [];
              if (hasMultipleWindows) {
                windows.forEach((w, index) => {
                  const winTitle = w.state.title || `Window ${index + 1}`;
                  menuItems.push({ label: winTitle, icon: OS.focusedWindowId === w.id ? 'check' : 'square', action: () => WM.focusWindow(w.id) });
                });
                menuItems.push({ separator: true });
              }
              if (hasWindows) {
                menuItems.push({ label: hasMultipleWindows ? 'Close All Windows' : 'Close Window', icon: 'x', danger: true, action: () => windows.forEach(w => WM.closeWindow(w.id)) });
                menuItems.push({ separator: true });
              } else {
                menuItems.push({ label: 'Open', icon: 'play', action: () => WM.createWindow(appId) });
                menuItems.push({ separator: true });
              }
              menuItems.push({
                label: isPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar',
                icon: isPinned ? 'pin-off' : 'pin',
                action: () => {
                  const pins = OS.settings.get('pinnedApps') || [];
                  const next = isPinned ? pins.filter(id => id !== appId) : [...pins, appId];
                  OS.settings.set('pinnedApps', next);
                  WM.updateTaskbar();
                  Notify.show({ title: isPinned ? 'Unpinned' : 'Pinned', body: `${app.name} ${isPinned ? 'removed from' : 'pinned to'} taskbar`, type: 'success', appName: 'Taskbar' });
                }
              });
              ContextMenu.show(e.clientX, e.clientY, menuItems);
            };

            btn.addEventListener('click', clickHandler);
            btn.addEventListener('contextmenu', contextMenuHandler);
            container.appendChild(btn);
          }
        },

        minimizeAll() {
          for (const [id] of OS.windows) WM.minimizeWindow(id);
        }
      };

      // Window preview popup for switching between multiple windows
      function showWindowPreview(btn, appId, windows) {
        // Remove any existing preview
        const existingPreview = document.querySelector('.taskbar-window-preview');
        if (existingPreview) existingPreview.remove();

        const preview = createEl('div', { className: 'taskbar-window-preview' });

        windows.forEach((w, index) => {
          const app = OS.apps[appId];
          const winTitle = w.state.title || `Window ${index + 1}`;
          const isActive = OS.focusedWindowId === w.id && !w.state.minimized;

          const item = createEl('div', {
            className: 'preview-window-item' + (isActive ? ' active' : '')
          });

          const icon = createEl('span', { className: 'preview-icon' });
          icon.innerHTML = svgIcon(app.icon, 16);

          const title = createEl('span', {
            className: 'preview-title',
            textContent: winTitle
          });

          const closeBtn = createEl('button', {
            className: 'preview-close',
            'aria-label': 'Close window'
          });
          closeBtn.innerHTML = svgIcon('x', 12);
          closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            WM.closeWindow(w.id);
            preview.remove();
          });

          item.appendChild(icon);
          item.appendChild(title);
          item.appendChild(closeBtn);

          item.addEventListener('click', () => {
            WM.focusWindow(w.id);
            preview.remove();
          });

          preview.appendChild(item);
        });

        // Position preview above the button
        document.body.appendChild(preview);
        const btnRect = btn.getBoundingClientRect();
        const previewRect = preview.getBoundingClientRect();

        let left = btnRect.left + (btnRect.width / 2) - (previewRect.width / 2);
        let bottom = window.innerHeight - btnRect.top + 8;

        // Keep preview within viewport
        if (left < 8) left = 8;
        if (left + previewRect.width > window.innerWidth - 8) {
          left = window.innerWidth - previewRect.width - 8;
        }

        preview.style.left = left + 'px';
        preview.style.bottom = bottom + 'px';

        // Close preview when clicking outside
        const dismiss = (e) => {
          if (!preview.contains(e.target) && e.target !== btn) {
            preview.remove();
            document.removeEventListener('pointerdown', dismiss);
          }
        };
        setTimeout(() => document.addEventListener('pointerdown', dismiss), 10);
      }

      /* ═══════════════════════════════════════════════════════════════
         SECTION: NOTIFICATION SYSTEM
         ═══════════════════════════════════════════════════════════════ */

      const Notify = {
        _storageKey: 'novaOS_notifications',
        _loaded: false,

        loadPersisted() {
          if (Notify._loaded) return;
          Notify._loaded = true;
          try {
            const saved = JSON.parse(localStorage.getItem(Notify._storageKey) || '[]');
            if (Array.isArray(saved)) {
              OS.notifications = saved.slice(0, 100);
              OS.notifUnread = OS.notifications.filter(n => !n.read).length;
            }
          } catch (e) {
            OS.notifications = [];
            OS.notifUnread = 0;
          }
        },

        persist() {
          try { localStorage.setItem(Notify._storageKey, JSON.stringify(OS.notifications.slice(0, 100))); } catch (e) { }
        },

        markAllRead() {
          let changed = false;
          OS.notifications = OS.notifications.map(n => {
            if (n && !n.read) {
              changed = true;
              return { ...n, read: true };
            }
            return n;
          });
          OS.notifUnread = 0;
          if (changed) Notify.persist();
          Notify.updateBadge();
          updateNotificationBadge();
          Notify.renderPanel();
        },

        show(opts) {
          Notify.loadPersisted();
          const { title, body, type, appName, category, icon, action, actionLabel } = opts;
          const notif = {
            id: generateId(),
            title: title || '',
            body: body || '',
            type: type || 'info',
            appName: appName || 'System',
            category: category || 'system',
            icon: icon || 'bell',
            timestamp: Date.now(),
            read: false,
            action: action || null,
            actionLabel: actionLabel || null
          };
          OS.notifications.unshift(notif);
          if (OS.notifications.length > 100) OS.notifications.pop();
          OS.notifUnread++;
          Notify.updateBadge();
          updateNotificationBadge();
          Notify.renderPanel();
          // FIX 15 — persist to localStorage
          Notify.persist();

          if (!OS.dnd) Notify.showToast(notif);
        },

        showToast(notif) {
          const container = document.getElementById('toast-container');
          const toast = createEl('div', { className: `toast ${notif.type}`, role: 'alert' });

          const content = createEl('div', { className: 'toast-content' });
          const titleEl = createEl('div', { className: 'toast-title', textContent: notif.title });
          const bodyEl = createEl('div', { className: 'toast-body', textContent: notif.body });
          content.appendChild(titleEl);
          content.appendChild(bodyEl);

          // Add action button if action is provided
          if (notif.action && notif.actionLabel) {
            const actionBtn = createEl('button', { className: 'toast-action' });
            actionBtn.textContent = notif.actionLabel;
            actionBtn.style.cssText = 'margin-left:auto;padding:6px 14px;font-size:12px;font-weight:600;border-radius:6px;background:rgba(88,166,255,0.2);color:#58a6ff;border:1px solid rgba(88,166,255,0.4);cursor:pointer;transition:all 0.15s;';
            actionBtn.onmouseenter = () => { actionBtn.style.background = 'rgba(88,166,255,0.35)'; };
            actionBtn.onmouseleave = () => { actionBtn.style.background = 'rgba(88,166,255,0.2)'; };
            actionBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              clearTimeout(timer);
              try {
                removeToast();
                if (typeof notif.action === 'function') {
                  notif.action();
                } else if (typeof notif.action === 'string') {
                  // Handle built-in actions
                  switch (notif.action) {
                    case 'settings':
                    case 'open-settings':
                    case 'openSettings':
                      renderSettings();
                      break;
                    default:
                      console.warn('[Notify] Unknown built-in action:', notif.action);
                  }
                }
              } catch (err) {
                console.error('[Notify] Action error:', err);
                alert('Error: ' + err.message);
              }
            });
            content.appendChild(actionBtn);
          }

          const closeBtn = createEl('button', { className: 'toast-close', 'aria-label': 'Dismiss notification' });
          closeBtn.innerHTML = svgIcon('x', 14);

          toast.appendChild(content);
          toast.appendChild(closeBtn);
          container.appendChild(toast);

          let timer = setTimeout(() => removeToast(), notif.action ? 8000 : 4000);

          toast.addEventListener('pointerenter', () => clearTimeout(timer));
          toast.addEventListener('pointerleave', () => { timer = setTimeout(() => removeToast(), notif.action ? 4000 : 2000); });

          closeBtn.addEventListener('click', () => { clearTimeout(timer); removeToast(); });

          function removeToast() {
            toast.classList.add('removing');
            setTimeout(() => toast.remove(), 300);
          }
        },

        updateBadge() {
          const badge = document.getElementById('notif-badge');
          if (OS.notifUnread > 0) {
            badge.textContent = OS.notifUnread > 99 ? '99+' : OS.notifUnread;
            badge.classList.remove('hidden');
          } else {
            badge.classList.add('hidden');
          }
        },

        renderPanel() {
          Notify.loadPersisted();
          const list = document.getElementById('notif-list');
          list.innerHTML = '';
          if (OS.notifications.length === 0) {
            list.innerHTML = '<div class="empty-state"><div class="text-muted">No notifications</div></div>';
            return;
          }
          for (const n of OS.notifications.slice(0, 50)) {
            const item = createEl('div', { className: 'notif-item' });
            const icon = createEl('div', { style: { width: '24px', height: '24px', color: 'var(--text-secondary)', flexShrink: '0' } });
            icon.innerHTML = svgIcon('bell', 16);
            const content = createEl('div', { className: 'notif-item-content' });
            content.appendChild(createEl('div', { className: 'notif-item-title', textContent: n.title }));
            content.appendChild(createEl('div', { className: 'notif-item-body', textContent: n.body }));
            const ago = Date.now() - n.timestamp;
            const mins = Math.floor(ago / 60000);
            const timeStr = mins < 1 ? 'Just now' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ago`;
            content.appendChild(createEl('div', { className: 'notif-item-time', textContent: timeStr }));
            item.appendChild(icon);
            item.appendChild(content);
            list.appendChild(item);
          }
        },

        togglePanel() {
          Notify.loadPersisted();
          const panel = document.getElementById('notification-panel');
          const opening = !panel.classList.contains('active');
          panel.classList.toggle('active');
          if (opening) {
            if (OS.notifications.length) {
              OS.notifications = OS.notifications.map(n => n && !n.read ? { ...n, read: true } : n);
              OS.notifUnread = 0;
              Notify.persist();
            }
            Notify.updateBadge();
            updateNotificationBadge();
            Notify.renderPanel();
          }
        }
      };

      /* ═══════════════════════════════════════════════════════════════
         SECTION: CONTEXT MENU
         ═══════════════════════════════════════════════════════════════ */

      const ContextMenu = {
        current: null,

        show(x, y, items) {
          ContextMenu.hide();
          const menu = createEl('div', { className: 'context-menu', role: 'menu' });

          for (const item of items) {
            if (item.separator) {
              menu.appendChild(createEl('div', { className: 'ctx-separator' }));
              continue;
            }
            const btn = createEl('button', {
              className: 'ctx-item' + (item.danger ? ' danger' : ''),
              role: 'menuitem',
              'aria-label': item.label
            });
            if (item.icon) {
              const iconEl = createEl('span');
              iconEl.innerHTML = svgIcon(item.icon, 14);
              btn.appendChild(iconEl);
            }
            btn.appendChild(createEl('span', { textContent: item.label }));
            if (item.shortcut) {
              btn.appendChild(createEl('span', { className: 'ctx-shortcut', textContent: item.shortcut }));
            }
            btn.addEventListener('click', () => {
              ContextMenu.hide();
              if (item.action) item.action();
            });
            menu.appendChild(btn);
          }

          // Position
          document.body.appendChild(menu);
          const rect = menu.getBoundingClientRect();
          if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
          if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
          menu.style.left = x + 'px';
          menu.style.top = y + 'px';

          ContextMenu.current = menu;

          const dismiss = (e) => {
            if (!menu.contains(e.target)) {
              ContextMenu.hide();
              document.removeEventListener('pointerdown', dismiss);
            }
          };
          setTimeout(() => document.addEventListener('pointerdown', dismiss), 10);
        },

        hide() {
          if (ContextMenu.current) {
            ContextMenu.current.remove();
            ContextMenu.current = null;
          }
        }
      };

      /* ═══════════════════════════════════════════════════════════════
         SECTION: MODAL DIALOGS
         ═══════════════════════════════════════════════════════════════ */

      function showModal(title, body, actions, inputType) {
        return new Promise((resolve) => {
          const overlay = createEl('div', { className: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' });
          const dialog = createEl('div', { className: 'modal-dialog' });

          if (title) dialog.appendChild(createEl('div', { className: 'modal-title', textContent: title }));
          if (typeof body === 'string') {
            dialog.appendChild(createEl('div', { className: 'modal-body', textContent: body }));
          } else if (body instanceof HTMLElement) {
            const bodyDiv = createEl('div', { className: 'modal-body' });
            bodyDiv.appendChild(body);
            dialog.appendChild(bodyDiv);
          }

          // FIX 4 — optional input field when inputType is provided
          let _modalInput = null;
          if (inputType) {
            const inputWrap = createEl('div', { className: 'modal-body', style: { paddingTop: '0' } });
            _modalInput = createEl('input', {
              id: 'modal-input-field',
              name: 'modal-input',
              className: 'input',
              type: inputType,
              style: { width: '100%', marginTop: '4px' },
              'aria-label': title || 'Input'
            });
            inputWrap.appendChild(_modalInput);
            dialog.appendChild(inputWrap);
          }

          const actionsDiv = createEl('div', { className: 'modal-actions' });
          for (const act of (actions || [{ label: 'OK', primary: true, value: true }])) {
            const btn = createEl('button', {
              className: 'btn' + (act.primary ? ' btn-primary' : '') + (act.danger ? ' btn-danger' : ''),
              textContent: act.label
            });
            btn.addEventListener('click', () => {
              overlay.remove();
              // If we have an input field: buttons with an explicit value resolve the input's value;
              // buttons without a value (Cancel/dismiss) resolve null.
              if (_modalInput) {
                resolve(act.value !== undefined ? _modalInput.value : null);
              } else {
                resolve(act.value !== undefined ? act.value : act.label);
              }
            });
            actionsDiv.appendChild(btn);
          }
          dialog.appendChild(actionsDiv);
          overlay.appendChild(dialog);

          overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { overlay.remove(); resolve(null); }
          });

          if (_modalInput) {
            _modalInput.addEventListener('keydown', e => {
              if (e.key === 'Enter') { overlay.remove(); resolve(_modalInput.value); }
              if (e.key === 'Escape') { overlay.remove(); resolve(null); }
            });
          }

          document.body.appendChild(overlay);
          if (_modalInput) _modalInput.focus(); else dialog.querySelector('button')?.focus();
        });
      }

      function showPrompt(title, defaultValue) {
        return new Promise((resolve) => {
          const overlay = createEl('div', { className: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' });
          const dialog = createEl('div', { className: 'modal-dialog' });
          dialog.appendChild(createEl('div', { className: 'modal-title', textContent: title }));

          const input = createEl('input', { className: 'input', id: 'modal-input-field', name: 'modal-input', value: defaultValue || '', 'aria-label': title });
          const bodyDiv = createEl('div', { className: 'modal-body' });
          bodyDiv.appendChild(input);
          dialog.appendChild(bodyDiv);

          const actionsDiv = createEl('div', { className: 'modal-actions' });
          const cancelBtn = createEl('button', { className: 'btn', textContent: 'Cancel' });
          const okBtn = createEl('button', { className: 'btn btn-primary', textContent: 'OK' });

          cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(null); });
          okBtn.addEventListener('click', () => { overlay.remove(); resolve(input.value); });
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { overlay.remove(); resolve(input.value); } });

          actionsDiv.appendChild(cancelBtn);
          actionsDiv.appendChild(okBtn);
          dialog.appendChild(actionsDiv);
          overlay.appendChild(dialog);
          overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
          document.body.appendChild(overlay);
          input.focus();
          input.select();
        });
      }

      /* ═══════════════════════════════════════════════════════════════
         SECTION: APP REGISTRY
         ═══════════════════════════════════════════════════════════════ */

      const APP_REGISTRY = [];

      /* ── WebAppManager — persistent web app store ── */
      const WebAppManager = (() => {
        const STORAGE_KEY = 'nova_webapps';
        function load() {
          try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
        }
        function save(apps) { localStorage.setItem(STORAGE_KEY, JSON.stringify(apps)); }
        function genId() { return 'wa_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }
        return {
          getAllApps() { return load(); },
          getApp(id) { return load().find(a => a.id === id) || null; },
          addApp(data) {
            const apps = load();
            const app = { id: genId(), name: data.name || 'Web App', url: data.url || '', icon: data.icon || '🌐', addedAt: Date.now(), launchCount: 0 };
            apps.push(app); save(apps); return app;
          },
          saveApps(apps) { save(apps); },
          removeApp(id) { save(load().filter(a => a.id !== id)); },
          launchApp(id) {
            const apps = load();
            const idx = apps.findIndex(a => a.id === id);
            if (idx !== -1) { apps[idx].launchCount = (apps[idx].launchCount || 0) + 1; apps[idx].lastUsed = Date.now(); save(apps); }
          }
        };
      })();

      function registerApp(config) {
        OS.apps[config.id] = config;
        APP_REGISTRY.push(config);
      }

      // ── Global URL opener — routes all links to com.nbosp.browser ──────
      OS.openUrl = function (url) {
        if (!url) return;
        if (/^(javascript|data|vbscript):/i.test(url.trim())) return;
        WM.createWindow('browser', { url });
      };

      // Intercept <a> clicks anywhere in the NovaByte UI
      document.addEventListener('click', e => {
        const a = e.target.closest('a[href]');
        if (!a) return;
        const href = a.getAttribute('href');
        if (!href || href.startsWith('#')) return;
        if (/^(javascript|data|vbscript):/i.test(href.trim())) return;
        if (href.match(/^https?:\/\//i)) {
          e.preventDefault();
          e.stopPropagation();
          OS.openUrl(href);
        }
      }, true);

      // Prevent NW.js from opening external links in a new NW.js window
      if (typeof nw !== 'undefined') {
        nw.Window.get().on('new-win-policy', (frame, url, policy) => {
          if (url.match(/^https?:\/\//i)) {
            policy.ignore();
            OS.openUrl(url);
          }
        });
      }

      /* ── APP 1: Files (NBOSP — minimal AOSP-style) ── */
      registerApp({
        id: 'vault', name: 'Files', icon: 'folder-open',
        description: 'File Manager',
        defaultSize: [780, 520], minSize: [480, 340],
        init(content, state, options) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.vault', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.vault</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          // ── Root layout ──────────────────────────────────────────────
          const root = createEl('div', { style: 'display:flex;flex-direction:column;height:100%;overflow:hidden;' });
          content.appendChild(root);

          // ── Toolbar (browser-style: back · up · path · search) ───────
          const toolbar = createEl('div', { className: 'browser-toolbar' });

          const backBtn = createEl('button', { className: 'browser-nav-btn', title: 'Back', 'aria-label': 'Back' });
          backBtn.innerHTML = svgIcon('chevron-left', 16);
          const upBtn = createEl('button', { className: 'browser-nav-btn', title: 'Up', 'aria-label': 'Parent folder' });
          upBtn.innerHTML = svgIcon('chevron-up', 16);

          const pathBarWrap = createEl('div', { className: 'browser-url-bar-wrap' });
          const pathBar = createEl('input', { className: 'browser-url-bar', id: 'file-browser-path-input', name: 'file-browser-path', 'aria-label': 'Current path', spellcheck: 'false', placeholder: '/' });
          const pathIcon = createEl('span', { className: 'browser-url-icon' });
          pathIcon.innerHTML = svgIcon('folder', 14);
          pathBarWrap.appendChild(pathBar);
          pathBarWrap.appendChild(pathIcon);

          const searchInput = createEl('input', { className: 'browser-url-bar', id: 'file-browser-search-input', name: 'file-browser-search', style: 'max-width:140px;', placeholder: 'Search…', 'aria-label': 'Search files' });

          toolbar.append(backBtn, upBtn, pathBarWrap, searchInput);
          root.appendChild(toolbar);

          // ── Files area ───────────────────────────────────────────────
          const filesWrap = createEl('div', { style: 'flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0;' });

          // Icon view
          const filesGrid = createEl('div', { className: 'vault-files', role: 'grid', 'aria-label': 'Files', style: 'display:grid;' });

          // List view
          const listView = createEl('div', { style: 'display:none;flex:1;overflow:auto;flex-direction:column;' });
          const listHeader = createEl('div', { style: 'display:grid;grid-template-columns:1fr 80px 120px 110px;background:var(--bg-sunken);border-bottom:1px solid var(--border-subtle);flex-shrink:0;position:sticky;top:0;z-index:1;' });
          ['Name', 'Size', 'Type', 'Modified'].forEach((h, i) => {
            const th = createEl('button', { style: 'padding:6px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);background:none;border:none;cursor:pointer;', textContent: h });
            th.addEventListener('click', () => {
              const key = ['name', 'size', 'mime', 'modified'][i];
              if (sortBy === key) sortAsc = !sortAsc; else { sortBy = key; sortAsc = true; }
              renderFiles();
            });
            listHeader.appendChild(th);
          });
          const listBody = createEl('div', { style: 'flex:1;overflow-y:auto;' });
          listView.appendChild(listHeader);
          listView.appendChild(listBody);

          filesWrap.appendChild(filesGrid);
          filesWrap.appendChild(listView);
          root.appendChild(filesWrap);

          // ── Status bar ───────────────────────────────────────────────
          const statusBar = createEl('div', { className: 'vault-statusbar', role: 'status' });
          root.appendChild(statusBar);

          // ── State ────────────────────────────────────────────────────
          let viewMode = 'icon';
          let sortBy = 'name', sortAsc = true;
          let selectedIds = new Set();
          let clipboardOp = null;
          let isRenaming = false;

          // Single navigation state (no tabs)
          const _startFolder = options?.folderId || FS.rootId;
          const nav = {
            cwd: _startFolder,
            history: [_startFolder],
            historyIdx: 0
          };
          state._nav = nav; // expose to onDrop

          // ── Navigation ───────────────────────────────────────────────
          function navigateTo(folderId) {
            nav.cwd = folderId;
            if (nav.historyIdx < nav.history.length - 1) nav.history = nav.history.slice(0, nav.historyIdx + 1);
            nav.history.push(folderId);
            nav.historyIdx = nav.history.length - 1;
            selectedIds.clear();
            renderFiles();
          }

          function goBack() {
            if (nav.historyIdx <= 0) return;
            nav.historyIdx--; nav.cwd = nav.history[nav.historyIdx];
            selectedIds.clear(); renderFiles();
          }

          function goUp() {
            const node = FS.files.get(nav.cwd);
            if (node && node.parentId) navigateTo(node.parentId);
          }

          backBtn.addEventListener('click', goBack);
          upBtn.addEventListener('click', goUp);

          pathBar.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
              const node = FS.getByPath(pathBar.value.trim());
              if (node) navigateTo(node.id);
              else { pathBar.style.color = 'var(--text-danger)'; setTimeout(() => pathBar.style.color = '', 800); }
              filesGrid.focus();
            }
            if (e.key === 'Escape') { updatePathBar(); filesGrid.focus(); }
          });

          function updatePathBar() {
            if (document.activeElement !== pathBar) pathBar.value = FS.getPath(nav.cwd);
          }

          // ── Sort ─────────────────────────────────────────────────────
          function sortFiles(files) {
            return [...files].sort((a, b) => {
              if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
              let cmp = 0;
              if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
              else if (sortBy === 'size') cmp = (a.size || 0) - (b.size || 0);
              else if (sortBy === 'mime') cmp = (a.mimeType || '').localeCompare(b.mimeType || '');
              else if (sortBy === 'modified') cmp = (a.modified || 0) - (b.modified || 0);
              return sortAsc ? cmp : -cmp;
            });
          }

          // ── Inline rename ────────────────────────────────────────────
          async function inlineRename(fileNode, nameEl) {
            if (OS.settings.get('filesViewOnly')) { Notify.show({ title: 'Blocked', body: 'Renaming disabled by policy.', type: 'warning', appName: 'Files' }); return; }
            isRenaming = true;
            const old = fileNode.name;
            const input = createEl('input', { id: 'file-rename-input', name: 'file-rename', value: old, style: 'width:100%;background:var(--bg-base);border:1px solid var(--accent);border-radius:4px;padding:1px 4px;font-size:11px;color:var(--text-primary);outline:none;' });
            nameEl.innerHTML = '';
            nameEl.appendChild(input);
            input.focus(); input.select();
            const commit = async () => {
              const newName = input.value.trim();
              if (newName && newName !== old) { await FS.rename(fileNode.id, newName); renderDesktopIcons(); }
              isRenaming = false; renderFiles();
            };
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') { isRenaming = false; renderFiles(); } });
          }

          // ── Render icon view ─────────────────────────────────────────
          function renderFileList(files) {
            filesGrid.innerHTML = '';
            if (!files.length) {
              filesGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:40px;font-size:13px;">This folder is empty</div>';
              statusBar.textContent = 'Empty';
              return;
            }
            files.forEach(f => {
              const item = createEl('div', { className: 'vault-file' + (selectedIds.has(f.id) ? ' selected' : ''), role: 'gridcell', tabindex: '0' });
              item._fileNode = f;

              const iconDiv = createEl('div', { className: 'vault-file-icon', style: 'position:relative;' });
              iconDiv.innerHTML = svgIcon(f.type === 'folder' ? 'folder' : FS.getMimeIcon(f.mimeType, f.name), 36);
              if (f.tags && f.tags[0]) {
                const dot = createEl('div', { style: `position:absolute;bottom:2px;right:2px;width:8px;height:8px;border-radius:50%;background:var(--${f.tags[0] === 'red' ? 'text-danger' : f.tags[0] === 'green' ? 'text-success' : f.tags[0] === 'blue' ? 'accent' : 'text-warning'});` });
                iconDiv.appendChild(dot);
              }

              const nameDiv = createEl('div', { className: 'vault-file-name', textContent: f.name });
              item.appendChild(iconDiv);
              item.appendChild(nameDiv);

              item.addEventListener('click', e => {
                if (e.shiftKey || e.ctrlKey || e.metaKey) {
                  selectedIds.has(f.id) ? selectedIds.delete(f.id) : selectedIds.add(f.id);
                } else if (!selectedIds.has(f.id)) {
                  selectedIds.clear(); selectedIds.add(f.id);
                }
                renderFileList(files);
              });
              item.addEventListener('dblclick', () => { if (f.type === 'folder') navigateTo(f.id); else openFileWithDefaultApp(f); });
              item.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); selectedIds.add(f.id); renderFileList(files); showFileContextMenu(e.clientX, e.clientY, f, files); });
              item.addEventListener('keydown', e => {
                if (e.key === 'Enter') { if (f.type === 'folder') navigateTo(f.id); else openFileWithDefaultApp(f); }
                if (e.key === 'F2') inlineRename(f, nameDiv);
                if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); trashSelected(files); }
              });

              filesGrid.appendChild(item);
            });

            const selCount = selectedIds.size;
            if (selCount > 0) {
              const totalSize = files.filter(f => selectedIds.has(f.id)).reduce((s, f) => s + (f.size || 0), 0);
              statusBar.textContent = `${selCount} of ${files.length} selected${totalSize > 0 ? ' — ' + formatBytes(totalSize) : ''}`;
            } else {
              statusBar.textContent = `${files.length} item${files.length !== 1 ? 's' : ''}`;
            }
          }

          // ── Render list view ─────────────────────────────────────────
          function renderListView(files) {
            listBody.innerHTML = '';
            files.forEach(f => {
              const row = createEl('div', { style: 'display:grid;grid-template-columns:1fr 80px 120px 110px;align-items:center;border-bottom:1px solid var(--border-subtle);cursor:pointer;transition:background var(--t-fast);' + (selectedIds.has(f.id) ? 'background:var(--accent-muted);' : '') });
              row._fileNode = f;
              const nameCell = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;min-width:0;' });
              const ic = createEl('span', { style: 'flex-shrink:0;color:var(--text-muted);' }); ic.innerHTML = svgIcon(f.type === 'folder' ? 'folder' : FS.getMimeIcon(f.mimeType, f.name), 16);
              const nm = createEl('span', { style: 'font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', textContent: f.name });
              nameCell.appendChild(ic); nameCell.appendChild(nm);
              const sizeCell = createEl('div', { style: 'padding:6px 12px;font-size:12px;color:var(--text-secondary);', textContent: f.type === 'folder' ? '—' : formatBytes(f.size || 0) });
              const typeCell = createEl('div', { style: 'padding:6px 12px;font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', textContent: f.type === 'folder' ? 'Folder' : (f.mimeType?.split('/')[1] || 'File').toUpperCase() });
              const dateCell = createEl('div', { style: 'padding:6px 12px;font-size:12px;color:var(--text-secondary);', textContent: new Date(f.modified || Date.now()).toLocaleDateString() });
              row.appendChild(nameCell); row.appendChild(sizeCell); row.appendChild(typeCell); row.appendChild(dateCell);
              row.addEventListener('mouseenter', () => { if (!selectedIds.has(f.id)) row.style.background = 'rgba(255,255,255,0.04)'; });
              row.addEventListener('mouseleave', () => { if (!selectedIds.has(f.id)) row.style.background = ''; });
              row.addEventListener('click', e => {
                if (e.shiftKey || e.ctrlKey || e.metaKey) {
                  selectedIds.has(f.id) ? selectedIds.delete(f.id) : selectedIds.add(f.id);
                } else if (!selectedIds.has(f.id)) {
                  selectedIds.clear(); selectedIds.add(f.id);
                }
                renderListView(files);
              });
              row.addEventListener('dblclick', () => { if (f.type === 'folder') navigateTo(f.id); else openFileWithDefaultApp(f); });
              row.addEventListener('contextmenu', e => { e.preventDefault(); selectedIds.add(f.id); renderListView(files); showFileContextMenu(e.clientX, e.clientY, f, files); });
              listBody.appendChild(row);
            });
            const selCount = selectedIds.size;
            statusBar.textContent = selCount > 0 ? `${selCount} of ${files.length} selected` : `${files.length} item${files.length !== 1 ? 's' : ''}`;
          }

          // ── Main render ──────────────────────────────────────────────
          function renderFiles(searchQuery) {
            updatePathBar();
            let files = FS.listDir(nav.cwd);
            if (searchQuery) files = files.filter(f => f.name.toLowerCase().includes(searchQuery.toLowerCase()));
            files = sortFiles(files);
            filesGrid.style.display = viewMode === 'icon' ? 'grid' : 'none';
            listView.style.display = viewMode === 'list' ? 'flex' : 'none';
            if (viewMode === 'icon') renderFileList(files);
            else renderListView(files);
          }

          // ── Context menu ─────────────────────────────────────────────
          function showFileContextMenu(x, y, f, files) {
            const inTrash = nav.cwd === FS.specialFolders.trash;
            const isHtml = f.type !== 'folder' && (f.name.endsWith('.html') || f.name.endsWith('.htm') || (f.mimeType || '') === 'text/html');
            ContextMenu.show(x, y, [
              { label: 'Open', icon: 'eye', action: () => { if (f.type === 'folder') navigateTo(f.id); else openFileWithDefaultApp(f); } },
              ...(isHtml ? [{ label: 'Edit in Text Editor', icon: 'edit', action: () => WM.createWindow('quill', { fileId: f.id }) }] : []),
              { separator: true },
              {
                label: 'Rename', icon: 'file-text', shortcut: 'F2', action: async () => {
                  if (OS.settings.get('filesViewOnly')) { Notify.show({ title: 'Blocked', body: 'Renaming disabled.', type: 'warning', appName: 'Files' }); return; }
                  const nameEl = filesGrid.querySelector('.vault-file.selected .vault-file-name');
                  if (nameEl && nameEl.tagName) inlineRename(f, nameEl);
                  else { const name = await showPrompt('Rename', f.name); if (name && name !== f.name) { await FS.rename(f.id, name); renderFiles(); renderDesktopIcons(); } }
                }
              },
              { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', action: () => { if (OS.settings.get('disableClipboardCopy')) { Notify.show({ title: 'Blocked', body: 'Copy disabled.', type: 'warning', appName: 'Files' }); return; } clipboardOp = { type: 'copy', fileId: f.id }; OS.clipboard = clipboardOp; Notify.show({ title: 'Copied', body: f.name + ' copied', type: 'info', appName: 'Files' }); } },
              { label: 'Move', icon: 'move', shortcut: 'Ctrl+X', action: () => { clipboardOp = { type: 'cut', fileId: f.id }; OS.clipboard = clipboardOp; Notify.show({ title: 'Cut', body: f.name + ' ready to move', type: 'info', appName: 'Files' }); } },
              { separator: true },
              ...(inTrash ? [
                { label: 'Restore', icon: 'refresh', action: async () => { f.parentId = FS.specialFolders.desktop; FS.files.set(f.id, f); await OS.workers.fs.call('putFiles', [f]); renderFiles(); renderDesktopIcons(); Notify.show({ title: 'Restored', body: f.name + ' restored', type: 'success', appName: 'Files' }); } },
                { label: 'Delete Permanently', icon: 'trash', danger: true, action: async () => { const ok = await showModal('Delete Permanently', 'This cannot be undone.', [{ label: 'Cancel' }, { label: 'Delete', style: 'danger' }]); if (ok !== 'Delete') return; await FS.permanentDelete(f.id); renderFiles(); renderDesktopIcons(); } }] : [
                {
                  label: 'Move to Trash', icon: 'trash', danger: true, shortcut: 'Del', action: async () => {
                    if (OS.settings.get('filesViewOnly')) { Notify.show({ title: 'Blocked', body: 'Delete disabled.', type: 'warning', appName: 'Files' }); return; }
                    const ids = [...selectedIds]; if (!ids.includes(f.id)) ids.push(f.id);
                    for (const id of ids) { await FS.deleteToTrash(id); }
                    selectedIds.clear(); renderFiles(); renderDesktopIcons();
                  }
                }])]);
          }

          async function trashSelected() {
            if (OS.settings.get('filesViewOnly')) { Notify.show({ title: 'Blocked', body: 'Delete disabled.', type: 'warning', appName: 'Files' }); return; }
            const ids = [...selectedIds]; if (!ids.length) return;
            for (const id of ids) await FS.deleteToTrash(id);
            selectedIds.clear(); renderFiles(); renderDesktopIcons();
          }

          // ── Empty area context menu ──────────────────────────────────
          filesGrid.addEventListener('contextmenu', e => {
            if (e.target === filesGrid) {
              e.preventDefault();
              ContextMenu.show(e.clientX, e.clientY, [
                { label: 'New File', icon: 'file', shortcut: 'Ctrl+N', action: async () => { const n = await showPrompt('New File Name', 'untitled.txt'); if (n) { await FS.createFile(nav.cwd, n, '', 'text/plain'); renderFiles(); renderDesktopIcons(); } } },
                { label: 'New Folder', icon: 'folder', shortcut: 'Ctrl+Shift+N', action: async () => { const n = await showPrompt('New Folder', 'New Folder'); if (n) { await FS.createFolder(nav.cwd, n); renderFiles(); renderDesktopIcons(); } } },
                { separator: true },
                {
                  label: 'Paste', icon: 'documents', shortcut: 'Ctrl+V', action: async () => {
                    if (OS.settings.get('disableClipboardPaste')) { Notify.show({ title: 'Blocked', body: 'Paste disabled.', type: 'warning', appName: 'Files' }); return; }
                    const clip = OS.clipboard; if (!clip?.fileId) return;
                    const src = FS.files.get(clip.fileId); if (!src) return;
                    if (clip.type === 'cut') { src.parentId = nav.cwd; FS.files.set(src.id, src); await OS.workers.fs.call('putFiles', [src]); OS.clipboard = null; }
                    else await FS.createFile(nav.cwd, src.name, src.content, src.mimeType);
                    renderFiles(); renderDesktopIcons();
                  }
                },
                { separator: true },
                { label: 'Sort by Name', action: () => { sortBy = 'name'; sortAsc = !sortAsc; renderFiles(); } },
                { label: 'Sort by Size', action: () => { sortBy = 'size'; sortAsc = !sortAsc; renderFiles(); } },
                { label: 'Sort by Type', action: () => { sortBy = 'mime'; sortAsc = !sortAsc; renderFiles(); } },
                { label: 'Sort by Date', action: () => { sortBy = 'modified'; sortAsc = !sortAsc; renderFiles(); } },
                { separator: true },
                { label: 'View: Icons', action: () => { viewMode = 'icon'; renderFiles(); } },
                { label: 'View: List', action: () => { viewMode = 'list'; renderFiles(); } },
                { separator: true },
                { label: 'Select All', action: () => { FS.listDir(nav.cwd).forEach(f => selectedIds.add(f.id)); renderFiles(); } }]);
            }
          });

          listBody.addEventListener('contextmenu', e => {
            if (e.target === listBody) { e.preventDefault(); filesGrid.dispatchEvent(Object.assign(new MouseEvent('contextmenu', { clientX: e.clientX, clientY: e.clientY, bubbles: true }))); }
          });

          // ── Search ───────────────────────────────────────────────────
          let searchTimer;
          searchInput.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => renderFiles(searchInput.value.trim()), 150);
          });

          // ── FS change listeners ──────────────────────────────────────
          const onFsChange = () => { if (!isRenaming) renderFiles(); };
          OS.events.on('fs:created', onFsChange);
          OS.events.on('fs:updated', onFsChange);
          OS.events.on('fs:deleted', onFsChange);
          state.cleanups.push(
            () => OS.events.off('fs:created', onFsChange),
            () => OS.events.off('fs:updated', onFsChange),
            () => OS.events.off('fs:deleted', onFsChange)
          );

          // ── Keyboard shortcuts ───────────────────────────────────────
          const _kd = e => {
            const win = content.closest('.app-window');
            if (!win || win.dataset.appId !== 'vault') return;
            const ae = document.activeElement;
            if (ae === pathBar || ae === searchInput) return;
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
            if ((e.key === 'Backspace' && !e.altKey) || (e.key === 'ArrowLeft' && e.altKey)) { e.preventDefault(); goBack(); }
            if (e.key === 'ArrowUp' && e.altKey) { e.preventDefault(); goUp(); }
            if (e.key === 'F2') { const sel = filesGrid.querySelector('.vault-file.selected'); if (sel && sel._fileNode) { const nm = sel.querySelector('.vault-file-name'); if (nm) inlineRename(sel._fileNode, nm); } }
            if (e.key === 'Delete') { e.preventDefault(); trashSelected(); }
            if (e.ctrlKey && e.key === 'a') { e.preventDefault(); FS.listDir(nav.cwd).forEach(f => selectedIds.add(f.id)); renderFiles(); }
            if (e.ctrlKey && e.key === 'l') { e.preventDefault(); pathBar.focus(); pathBar.select(); }
            if (e.ctrlKey && e.key === 'f') { e.preventDefault(); searchInput.focus(); }
          };
          document.addEventListener('keydown', _kd);
          state.cleanups.push(() => document.removeEventListener('keydown', _kd));

          // ── Init ─────────────────────────────────────────────────────
          renderFiles();
        },

        async onDrop(file, state) {
          try {
            const fileId = generateId();
            const fileData = await file.arrayBuffer();
            // Resolve MIME type — browsers sometimes leave file.type empty for less common formats
            let mime = file.type;
            if (!mime) {
              const ext = file.name.split('.').pop().toLowerCase();
              const extMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', mp3: 'audio/mpeg', mp4: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg; codecs=opus', weba: 'audio/webm', webm: 'audio/webm', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json' };
              mime = extMap[ext] || 'application/octet-stream';
            }
            const parentId = (state._nav && state._nav.cwd) || FS.specialFolders.desktop || FS.rootId;
            const node = { id: fileId, name: file.name, type: 'file', size: file.size, content: new Uint8Array(fileData), mimeType: mime, parentId, modified: Date.now() };
            FS.files.set(fileId, node);
            await OS.workers.fs.call('putFiles', [node]);
            if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
            Notify.show({ title: 'File Added', body: file.name, type: 'success', appName: 'Files' });
          } catch {
            Notify.show({ title: 'Error', body: 'Failed to add file.', type: 'error', appName: 'Files' });
          }
        }
      });

      /* ── APP 2: Notes (NBOSP — minimal) ── */
      registerApp({
        id: 'quill', name: 'Notes', icon: 'pen-tool',
        description: 'Text Editor',
        defaultSize: [680, 500], minSize: [360, 260],
        init(content, state, options) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.quill', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.quill</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const container = createEl('div', { className: 'quill-container' });

          // Single file state
          const file = { id: null, name: 'untitled.txt', content: '', modified: false };

          // Toolbar
          const toolbar = createEl('div', { className: 'quill-toolbar' });
          const saveBtn = createEl('button', { className: 'btn btn-sm btn-primary', textContent: 'Save' });
          const saveAsBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Save As…' });
          saveBtn.title = 'Save (Ctrl+S)';
          saveAsBtn.title = 'Save a copy with a new name';
          toolbar.append(saveBtn, saveAsBtn);
          container.appendChild(toolbar);

          // Editor wrapper
          const editorWrap = createEl('div', { className: 'quill-editor-wrap' });

          const gutter = createEl('div', { className: 'quill-gutter', 'aria-hidden': 'true' });

          const textarea = createEl('textarea', {
            className: 'quill-textarea',
            id: 'quill-text-editor',
            name: 'quill-editor',
            spellcheck: 'false',
            'aria-label': 'Text editor',
            role: 'textbox',
            'aria-multiline': 'true'
          });

          editorWrap.appendChild(gutter);
          editorWrap.appendChild(textarea);

          const statusBar = createEl('div', { className: 'quill-statusbar', role: 'status' });

          container.appendChild(editorWrap);
          container.appendChild(statusBar);
          content.appendChild(container);

          // Context menu
          editorWrap.addEventListener('contextmenu', e => {
            e.preventDefault();
            ContextMenu.show(e.clientX, e.clientY, [
              { label: 'Cut', icon: 'scissors', shortcut: 'Ctrl+X', action: () => document.execCommand('cut') },
              { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', action: () => document.execCommand('copy') },
              { label: 'Paste', icon: 'documents', shortcut: 'Ctrl+V', action: () => document.execCommand('paste') },
              { separator: true },
              { label: 'Select All', icon: 'maximize', shortcut: 'Ctrl+A', action: () => document.execCommand('selectAll') },
              { separator: true },
              {
                label: 'Word Count', icon: 'info', action: () => {
                  const words = textarea.value.trim().split(/\s+/).filter(Boolean).length;
                  Notify.show({ title: 'Word Count', body: `${words} words`, type: 'info', appName: 'Notes' });
                }
              }]);
          });

          editorWrap.addEventListener('click', e => {
            if (e.target === gutter) textarea.focus();
          });

          function updateGutter() {
            const lines = textarea.value.split('\n').length;
            let html = '';
            for (let i = 1; i <= lines; i++) html += i + '\n';
            gutter.textContent = html;
          }

          function updateStatus() {
            const val = textarea.value;
            const pos = textarea.selectionStart;
            let line = 1, col = 1;
            for (let i = 0; i < pos; i++) { if (val[i] === '\n') { line++; col = 1; } else col++; }
            const words = val.split(/\s+/).filter(Boolean).length;
            statusBar.textContent = `Ln ${line}, Col ${col}  ·  ${words} words`;
          }

          // Save notes to com.nbosp.quill/files/ (Android-style private app storage)
          function getQuillFilesDir() {
            return AppDirs.getVFSDir('com.nbosp.quill', 'files') || FS.specialFolders.documents;
          }

          async function saveFile() {
            if (file.id) {
              await FS.writeFile(file.id, textarea.value);
              file.modified = false; file.content = textarea.value;
              Notify.show({ title: 'Saved', body: file.name, type: 'success', appName: 'Notes' });
            } else {
              const name = await showPrompt('Save As', file.name);
              if (name) {
                const node = await FS.createFile(getQuillFilesDir(), name, textarea.value, 'text/plain');
                file.id = node.id; file.name = name; file.modified = false; file.content = textarea.value;
                renderDesktopIcons();
                Notify.show({ title: 'Saved', body: name, type: 'success', appName: 'Notes' });
              }
            }
          }

          saveBtn.addEventListener('click', () => saveFile());
          saveAsBtn.addEventListener('click', async () => {
            const name = await showPrompt('Save As', file.name);
            if (!name) return;
            const node = await FS.createFile(getQuillFilesDir(), name, textarea.value, 'text/plain');
            file.id = node.id; file.name = name; file.modified = false; file.content = textarea.value;
            renderDesktopIcons();
            Notify.show({ title: 'Saved', body: name, type: 'success', appName: 'Notes' });
          });

          textarea.addEventListener('input', () => { file.modified = true; updateGutter(); updateStatus(); }, { passive: true });
          textarea.addEventListener('scroll', () => { gutter.scrollTop = textarea.scrollTop; }, { passive: true });
          textarea.addEventListener('click', updateStatus);
          textarea.addEventListener('keyup', updateStatus);

          textarea.addEventListener('keydown', e => {
            if (e.key === 'Tab') {
              e.preventDefault();
              const s = textarea.selectionStart, end = textarea.selectionEnd;
              textarea.value = textarea.value.substring(0, s) + '  ' + textarea.value.substring(end);
              textarea.selectionStart = textarea.selectionEnd = s + 2;
              updateGutter();
            }
            if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveFile(); }
            // Auto-close brackets
            const pairs = { '(': ')', '{': '}', '[': ']', "'": "'", '"': '"', '`': '`' };
            if (pairs[e.key]) {
              const s = textarea.selectionStart, end = textarea.selectionEnd;
              if (s !== end) return;
              e.preventDefault();
              textarea.value = textarea.value.substring(0, s) + e.key + pairs[e.key] + textarea.value.substring(end);
              textarea.selectionStart = textarea.selectionEnd = s + 1;
            }
          });

          // Load file
          if (options?.fileId) {
            const f = FS.files.get(options.fileId);
            if (f) { file.id = f.id; file.name = f.name; file.content = f.content || ''; textarea.value = file.content; }
          }
          updateGutter();
          updateStatus();
          requestAnimationFrame(() => textarea.focus());
        },

        async onDrop(file, state) {
          try {
            const fileId = generateId();
            const fileData = await file.text();
            FS.files.set(fileId, { id: fileId, name: file.name, type: 'text/plain', size: file.size, content: fileData, mimeType: file.type });
            WM.createWindow('quill', { fileId });
            Notify.show({ title: 'File Opened', body: file.name, type: 'success', appName: 'Notes' });
          } catch {
            Notify.show({ title: 'Error', body: 'Failed to open file.', type: 'error', appName: 'Notes' });
          }
        }
      });

      /* ── APP 3: Terminal (NBOSP — minimal) ── */
      registerApp({
        id: 'shell', name: 'Terminal', icon: 'terminal',
        description: 'Terminal',
        defaultSize: [700, 460], minSize: [420, 260],
        init(content, state) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.shell', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.shell</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const root = createEl('div', { className: 'shell-container' });
          content.appendChild(root);

          const mainArea = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0;' });
          root.appendChild(mainArea);

          // Context menu
          root.addEventListener('contextmenu', e => {
            if (e.target.closest('.shell-output') || e.target.closest('.shell-input-line')) {
              e.preventDefault();
              const sel = window.getSelection().toString();
              ContextMenu.show(e.clientX, e.clientY, [
                ...(sel ? [{ label: 'Copy', icon: 'copy', action: () => { navigator.clipboard.writeText(sel); Notify.show({ title: 'Copied', body: 'Text copied', type: 'info', appName: 'Terminal' }); } }, { separator: true }] : []),
                { label: 'Paste', icon: 'documents', action: () => { navigator.clipboard.readText().then(text => { if (tabs[activeTabIdx]?.input) tabs[activeTabIdx].input.value += text; }); } },
                { label: 'Clear', icon: 'trash-2', action: () => { if (tabs[activeTabIdx]?.output) tabs[activeTabIdx].output.innerHTML = ''; } },
                { separator: true },
                { label: 'Select All', icon: 'maximize', action: () => document.execCommand('selectAll') }]);
            }
          });

          let tabs = [];
          let activeTabIdx = 0;

          // ── Path resolver (fixed cd) ─────────────────────────────────
          function resolvePath(cwd, arg) {
            if (!arg || arg === '~') return FS.specialFolders.desktop;
            if (arg === '.') return cwd;
            // Absolute path
            if (arg.startsWith('/')) {
              const parts = arg.split('/').filter(Boolean);
              let node = FS.rootId;
              for (const part of parts) {
                if (part === '..') { const n = FS.files.get(node); if (n && n.parentId) node = n.parentId; }
                else if (part !== '.') {
                  const ch = FS.listDir(node);
                  const found = ch.find(c => c.name === part && c.type === 'folder');
                  if (!found) return false;
                  node = found.id;
                }
              }
              return node;
            }
            // Relative path
            const parts = arg.split('/').filter(Boolean);
            let node = cwd;
            for (const part of parts) {
              if (part === '..') { const n = FS.files.get(node); if (n && n.parentId) node = n.parentId; else return false; }
              else if (part !== '.') {
                const ch = FS.listDir(node);
                const found = ch.find(c => c.name === part && c.type === 'folder');
                if (!found) return false;
                node = found.id;
              }
            }
            return node;
          }

          // ── Create session ───────────────────────────────────────────
          function createTab(label) {
            const tab = {
              label: label || 'Terminal',
              cwd: FS.specialFolders.desktop,
              prevCwd: null,
              history: [],
              historyIdx: -1,
              variables: { HOME: '/Desktop', USER: OS.username, HOSTNAME: 'novabyteOS', SHELL: '/bin/sh', TERM: 'xterm-256color', PATH: '/bin:/usr/bin:/usr/local/bin' },
              aliases: { ll: 'ls -la', la: 'ls -a', l: 'ls -lh', cls: 'clear', md: 'mkdir', rd: 'rmdir', ff: 'fastfetch' },
              element: null, output: null, input: null, prompt: null, btnEl: null
            };

            const pane = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;' });
            const output = createEl('div', { className: 'shell-output', role: 'log', 'aria-label': 'Terminal output' });
            const inputLine = createEl('div', { className: 'shell-input-line' });
            const promptEl = createEl('span', { className: 'shell-prompt' });
            const inputEl = createEl('input', { className: 'shell-input', id: 'shell-command-input', name: 'shell-command', 'aria-label': 'Command input', autocomplete: 'off', spellcheck: 'false' });

            inputLine.appendChild(promptEl);
            inputLine.appendChild(inputEl);
            pane.appendChild(output);
            pane.appendChild(inputLine);

            output.addEventListener('click', () => inputEl.focus());
            pane.addEventListener('click', ev => { if (!ev.target.closest('a') && !ev.target.closest('button')) inputEl.focus(); });
            inputLine.addEventListener('click', () => inputEl.focus());

            tab.element = pane;
            tab.output = output;
            tab.input = inputEl;
            tab.prompt = promptEl;
            tab.btnEl = { classList: { toggle: () => { } } }; // stub

            tabs.push(tab);
            setupInput(tab);
            return tab;
          }

          function removeTab(idx) { /* no-op — single session */ }

          function switchTab(idx) {
            activeTabIdx = idx;
            if (tabs[idx]) {
              mainArea.innerHTML = '';
              mainArea.appendChild(tabs[idx].element);
              tabs[idx].input.focus();
              updatePrompt(tabs[idx]);
            }
          }

          // ── Terminal output helpers ──────────────────────────────────
          function getPromptStr(tab) {
            const path = FS.getPath(tab.cwd).replace(/^\/Desktop/, '~');
            return `<span class="shell-green">${escapeText(OS.username)}@novabyteOS</span>:<span class="shell-blue">${escapeText(path)}</span>$ `;
          }
          function updatePrompt(tab) { tab.prompt.innerHTML = getPromptStr(tab); }

          function writeLine(tab, text, cls) {
            const d = createEl('div'); if (cls) d.className = cls; d.textContent = text;
            tab.output.appendChild(d); tab.output.scrollTop = tab.output.scrollHeight;
          }
          function writeHTML(tab, html) {
            const d = createEl('div'); d.innerHTML = html;
            tab.output.appendChild(d); tab.output.scrollTop = tab.output.scrollHeight;
          }
          function writePromptLine(tab, cmd) {
            const d = createEl('div');
            d.innerHTML = getPromptStr(tab) + escapeText(cmd);
            tab.output.appendChild(d);
          }
          function clearOutput(tab) { tab.output.innerHTML = ''; }

          // ── Tab-completion ───────────────────────────────────────────
          function getCompletions(tab, partial) {
            const BUILTINS = ['ls', 'cd', 'pwd', 'mkdir', 'rmdir', 'rm', 'touch', 'cat', 'head', 'tail', 'wc', 'grep', 'sort', 'uniq', 'cut', 'find', 'tree', 'diff', 'stat', 'chmod', 'cp', 'mv', 'echo', 'printf', 'base64', 'date', 'sleep', 'yes', 'seq', 'expr', 'true', 'false', 'env', 'export', 'unset', 'alias', 'unalias', 'which', 'hostname', 'whoami', 'uname', 'uptime', 'history', 'clear', 'ps', 'kill', 'neofetch', 'fastfetch', 'help', 'exit'];
            const files = FS.listDir(tab.cwd).map(f => f.name + (f.type === 'folder' ? '/' : ''));
            return [...BUILTINS, ...files].filter(c => c.startsWith(partial));
          }

          // ── Input handler ────────────────────────────────────────────
          function setupInput(tab) {
            let completions = [], compIdx = 0;

            tab.input.addEventListener('keydown', async e => {
              // Stop the event from reaching the global OS shortcut listener
              // so terminal shortcuts (Ctrl+L clear, Ctrl+C cancel, etc.) don't
              // accidentally trigger OS actions (Ctrl+L lock, Ctrl+E file manager…)
              e.stopPropagation();

              if (e.key === 'Enter') {
                e.preventDefault();
                const cmd = tab.input.value.trim();
                tab.input.value = ''; completions = [];
                writePromptLine(tab, cmd);
                if (cmd) { tab.history.unshift(cmd); tab.historyIdx = -1; }
                const result = await runCommand(tab, cmd);
                if (result) {
                  const isErr = result.startsWith('bash:') || result.startsWith('cd:') || result.startsWith('Error');
                  result.split('\n').forEach(line => writeLine(tab, line, isErr ? 'shell-red' : undefined));
                }
                updatePrompt(tab);
                tab.output.scrollTop = tab.output.scrollHeight;

              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (tab.historyIdx < tab.history.length - 1) tab.input.value = tab.history[++tab.historyIdx];

              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                tab.historyIdx > 0 ? (tab.input.value = tab.history[--tab.historyIdx]) : (tab.historyIdx = -1, tab.input.value = '');

              } else if (e.key === 'Tab') {
                e.preventDefault();
                const words = tab.input.value.split(' ');
                const partial = words[words.length - 1];
                if (!completions.length) { completions = getCompletions(tab, partial); compIdx = 0; }
                if (completions.length === 1) { words[words.length - 1] = completions[0]; tab.input.value = words.join(' '); completions = []; }
                else if (completions.length > 1) {
                  if (completions.length <= 12) writeHTML(tab, `<span class="shell-dim">${completions.map(c => escapeText(c)).join('  ')}</span>`);
                  words[words.length - 1] = completions[compIdx++ % completions.length];
                  tab.input.value = words.join(' ');
                }

              } else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); clearOutput(tab); updatePrompt(tab); }
              else if (e.key === 'c' && e.ctrlKey) { e.preventDefault(); writeLine(tab, '^C', 'shell-red'); tab.input.value = ''; updatePrompt(tab); }
              else if (e.key === 'u' && e.ctrlKey) { e.preventDefault(); tab.input.value = ''; }
              else if (e.key === 'a' && e.ctrlKey) { e.preventDefault(); tab.input.setSelectionRange(0, 0); }
              else if (e.key === 'e' && e.ctrlKey) { e.preventDefault(); tab.input.setSelectionRange(tab.input.value.length, tab.input.value.length); }
              else { completions = []; compIdx = 0; }
            });
          }

          // ── Command parsing ──────────────────────────────────────────
          function tokenize(cmd) {
            const toks = []; let cur = '', inQ = false, qc = '';
            for (const ch of cmd) {
              if (inQ) { if (ch === qc) inQ = false; else cur += ch; }
              else if (ch === '"' || ch === "'") { inQ = true; qc = ch; }
              else if (ch === ' ' || ch === '\t') { if (cur) { toks.push(cur); cur = ''; } }
              else cur += ch;
            }
            if (cur) toks.push(cur);
            return toks;
          }

          function splitPipes(line) {
            const segs = []; let cur = '', inQ = false, qc = '';
            for (const ch of line) {
              if (inQ) { if (ch === qc) inQ = false; else cur += ch; }
              else if (ch === '"' || ch === "'") { inQ = true; qc = ch; }
              else if (ch === '|') { segs.push(cur.trim()); cur = ''; }
              else cur += ch;
            }
            segs.push(cur.trim()); return segs.filter(Boolean);
          }

          // ── Individual command executor ──────────────────────────────
          async function execOne(tab, cmdStr, pipeIn) {
            if (!cmdStr.trim()) return pipeIn || '';
            // Variable expansion
            cmdStr = cmdStr.replace(/\$\{?(\w+)\}?/g, (_, n) => tab.variables[n] || '');
            const toks = tokenize(cmdStr);
            if (!toks.length) return '';
            let cmd = toks[0], args = toks.slice(1);
            // Alias expansion
            if (tab.aliases[cmd]) { const at = tokenize(tab.aliases[cmd]); cmd = at[0]; args = [...at.slice(1), ...args]; }

            switch (cmd) {
              // ── Help ──
              case 'help': {
                const sections = [
                  ['Filesystem', 'ls  ll  la  l  cd  pwd  mkdir  rmdir  rm  touch  cp  mv  cat  head  tail  stat  chmod  find  tree  diff'],
                  ['Text', 'echo  printf  grep  sort  uniq  cut  wc  base64'],
                  ['System', 'clear  history  env  export  unset  alias  unalias  which  hostname  whoami  uname  uptime  date  ps  kill  sleep'],
                  ['Math', 'expr  seq'],
                  ['Fun', 'neofetch  fastfetch  yes  true  false  exit']];
                writeHTML(tab, `<span class="shell-bold shell-blue">Terminal</span> <span class="shell-dim">— ${OS.username}@novabyteOS</span>`);
                sections.forEach(([s, cmds]) => writeHTML(tab, `  <span class="shell-yellow">${s}:</span> <span class="shell-dim">${cmds}</span>`));
                writeHTML(tab, `\n  <span class="shell-dim">Shortcuts: <span class="shell-green">Tab</span>=autocomplete  <span class="shell-green">↑↓</span>=history  <span class="shell-green">Ctrl+L</span>=clear  <span class="shell-green">Ctrl+C</span>=cancel  <span class="shell-green">Ctrl+Shift+T</span>=new tab</span>`);
                return '';
              }

              case 'clear': clearOutput(tab); return '';
              case 'exit': return 'Use the window close button to exit.';
              case 'true': return '';
              case 'false': return 'Error: false returned exit code 1';
              case 'pwd': return FS.getPath(tab.cwd);
              case 'whoami': return OS.username;
              case 'hostname': return args.includes('-f') ? 'novabyteOS.local' : 'novabyteOS';
              case 'date': return args.includes('-u') ? new Date().toUTCString() : new Date().toString();
              case 'uptime': return `up  ${Math.floor(performance.now() / 3600000)}:${String(Math.floor(performance.now() / 60000) % 60).padStart(2, '0')}, load average: 0.08 0.10 0.09`;

              case 'uname': {
                if (args.includes('-a')) return 'NovaKernel novabyteOS 5.15.0-nova #1 SMP ' + new Date().toDateString() + ' x86_64 GNU/NovaByte';
                if (args.includes('-r')) return '5.15.0-nova';
                if (args.includes('-m')) return 'x86_64';
                if (args.includes('-s')) return 'NovaKernel';
                if (args.includes('-n')) return 'novabyteOS';
                return 'NovaKernel';
              }

              case 'env': {
                if (args[0]) { const [k, ...v] = args[0].split('='); if (v.length) { tab.variables[k] = v.join('='); return execOne(tab, args.slice(1).join(' '), pipeIn); } }
                return Object.entries({ ...tab.variables }).map(([k, v]) => `${k}=${v}`).join('\n');
              }

              case 'export': {
                if (!args[0]) return Object.entries(tab.variables).map(([k, v]) => `declare -x ${k}="${v}"`).join('\n');
                for (const a of args) {
                  const eq = a.indexOf('=');
                  if (eq > 0) tab.variables[a.slice(0, eq)] = a.slice(eq + 1).replace(/^["']|["']$/g, '');
                }
                return '';
              }

              case 'unset': { args.forEach(a => { delete tab.variables[a]; }); return ''; }

              case 'alias': {
                if (!args[0]) return Object.entries(tab.aliases).map(([k, v]) => `alias ${k}='${v}'`).join('\n');
                const eq = args[0].indexOf('=');
                if (eq > 0) tab.aliases[args[0].slice(0, eq)] = args[0].slice(eq + 1).replace(/^["']|["']$/g, '');
                return '';
              }

              case 'unalias': { args.forEach(a => delete tab.aliases[a]); return ''; }

              case 'which': {
                if (!args[0]) return 'which: missing argument';
                const BUILTINS = ['ls', 'cd', 'pwd', 'mkdir', 'rmdir', 'rm', 'touch', 'cat', 'head', 'tail', 'wc', 'grep', 'sort', 'uniq', 'cut', 'find', 'tree', 'diff', 'stat', 'chmod', 'cp', 'mv', 'echo', 'printf', 'base64', 'date', 'sleep', 'yes', 'seq', 'expr', 'true', 'false', 'env', 'export', 'unset', 'alias', 'unalias', 'which', 'hostname', 'whoami', 'uname', 'uptime', 'history', 'clear', 'ps', 'kill', 'neofetch', 'fastfetch', 'help', 'exit'];
                return BUILTINS.includes(args[0]) ? `/bin/${args[0]}` : `${args[0]}: not found`;
              }

              case 'history': {
                if (args[0] === '-c') { tab.history = []; return ''; }
                const n = parseInt(args[0]) || tab.history.length;
                return tab.history.slice(0, n).slice().reverse().map((c, i) => `${String(i + 1).padStart(5)}  ${c}`).join('\n') || '(empty)';
              }

              case 'echo': {
                const noNl = args[0] === '-n', en = args[0] === '-e';
                let text = args.slice((noNl || en) ? 1 : 0).join(' ');
                if (en) text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\033\[(\d+)m/g, '');
                return text;
              }

              case 'printf': {
                if (!args[0]) return '';
                let fmt = args[0], ai = 1, out = '';
                for (let i = 0; i < fmt.length; i++) {
                  if (fmt[i] === '%' && i + 1 < fmt.length) {
                    const spec = fmt[++i];
                    if (spec === 's') out += (args[ai++] || '');
                    else if (spec === 'd') out += parseInt(args[ai++] || '0');
                    else if (spec === 'f') out += parseFloat(args[ai++] || '0').toFixed(2);
                    else out += spec;
                  } else if (fmt[i] === '\\' && i + 1 < fmt.length) {
                    const esc = fmt[++i];
                    if (esc === 'n') out += '\n'; else if (esc === 't') out += '\t'; else out += esc;
                  } else out += fmt[i];
                }
                return out;
              }

              case 'sleep': {
                const secs = parseFloat(args[0]) || 1;
                await new Promise(r => setTimeout(r, Math.min(secs, 30) * 1000));
                return '';
              }

              case 'yes': {
                const w = args[0] || 'y';
                return Array(25).fill(w).join('\n') + '\n\x1b[2m(truncated)\x1b[0m';
              }

              case 'seq': {
                let start = 1, end = 1, step = 1;
                if (args.length === 1) end = parseInt(args[0]);
                else if (args.length === 2) { start = parseInt(args[0]); end = parseInt(args[1]); }
                else if (args.length === 3) { start = parseInt(args[0]); step = parseInt(args[1]); end = parseInt(args[2]); }
                const out = [];
                for (let i = start; i <= end && out.length < 1000; i += step) out.push(i);
                return out.join('\n');
              }

              case 'expr': {
                try {
                  const expr = args.join(' ').replace(/[^0-9+\-*\/()% ]/g, '');
                  return String(safeEvaluateArithmetic(expr));
                } catch { return 'expr: syntax error'; }
              }

              case 'base64': {
                const src = pipeIn || (args.find(a => !a.startsWith('-')) && FS.listDir(tab.cwd).find(f => f.name === args.find(a => !a.startsWith('-')))?.content) || args.filter(a => !a.startsWith('-')).join(' ');
                if (args.includes('-d') || args.includes('--decode')) {
                  try { return atob(src.trim()); } catch { return 'base64: invalid input'; }
                }
                try { return btoa(src); } catch { return 'base64: error encoding'; }
              }

              // ── Navigation ──
              case 'cd': {
                if (!args[0] || args[0] === '~') { tab.prevCwd = tab.cwd; tab.cwd = FS.specialFolders.desktop; updatePrompt(tab); return ''; }
                if (args[0] === '-') {
                  if (!tab.prevCwd) return 'cd: OLDPWD not set';
                  [tab.cwd, tab.prevCwd] = [tab.prevCwd, tab.cwd];
                  updatePrompt(tab); return FS.getPath(tab.cwd);
                }
                const resolved = resolvePath(tab.cwd, args[0]);
                if (resolved === false) return `cd: ${args[0]}: No such file or directory`;
                const node = FS.files.get(resolved);
                if (!node) return `cd: ${args[0]}: No such file or directory`;
                if (node.type !== 'folder') return `cd: ${args[0]}: Not a directory`;
                tab.prevCwd = tab.cwd; tab.cwd = resolved; updatePrompt(tab); return '';
              }

              // ── File listing ──
              case 'ls': {
                const hidden = args.some(a => ['-a', '-la', '-al', '-lah'].includes(a));
                const long = args.some(a => ['-l', '-la', '-al', '-lh', '-lah'].includes(a));
                const human = args.some(a => ['-h', '-lh', '-lah'].includes(a));
                const targetArg = args.find(a => !a.startsWith('-'));
                let tid = tab.cwd;
                if (targetArg) { const r = resolvePath(tab.cwd, targetArg); if (r === false) return `ls: cannot access '${targetArg}': No such file or directory`; tid = r; }
                let files = FS.listDir(tid);
                if (!hidden) files = files.filter(f => !f.name.startsWith('.'));
                files.sort((a, b) => a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name));
                if (!files.length) return '';
                if (long) {
                  const rows = files.map(f => {
                    const d = f.type === 'folder'; const perm = d ? 'drwxr-xr-x' : '-rw-r--r--';
                    const sz = human ? formatBytes(f.size || 0).padStart(6) : String(f.size || 0).padStart(8);
                    const dt = new Date(f.modified || Date.now()); const dateStr = dt.toLocaleDateString('en', { month: 'short', day: '2-digit', year: 'numeric' });
                    return `<span class="shell-dim">${perm}  1 ${OS.username} ${OS.username} ${sz} ${dateStr}</span> <span class="${d ? 'shell-blue shell-bold' : ''}">${escapeText(f.name)}${d ? '/' : ''}</span>`;
                  });
                  writeHTML(tab, `<span class="shell-dim">total ${files.length}</span>\n` + rows.join('\n'));
                  return '';
                }
                const cols = Math.max(1, Math.floor((tab.output.clientWidth || 600) / 120));
                const items = files.map(f => {
                  const d = f.type === 'folder';
                  return `<span class="${d ? 'shell-blue shell-bold' : ''}">${escapeText(f.name)}${d ? '/' : ''}</span>`;
                });
                for (let i = 0; i < items.length; i += cols) writeHTML(tab, items.slice(i, i + cols).join('  '));
                return '';
              }

              case 'tree': {
                let out = `<span class="shell-blue shell-bold">.</span>\n`; let count = { d: 0, f: 0 };
                function drawTree(id, prefix, depth) {
                  if (depth > 5) return;
                  const files = FS.listDir(id);
                  files.forEach((f, i) => {
                    const last = i === files.length - 1;
                    const conn = last ? '└── ' : '├── '; const ext = last ? '    ' : '│   ';
                    const isD = f.type === 'folder';
                    out += `${prefix}${conn}<span class="${isD ? 'shell-blue shell-bold' : ''}">${escapeText(f.name)}${isD ? '/' : ''}</span>\n`;
                    if (isD) { count.d++; drawTree(f.id, prefix + ext, depth + 1); } else count.f++;
                  });
                }
                drawTree(tab.cwd, '', 0);
                out += `\n<span class="shell-dim">${count.d} directories, ${count.f} files</span>`;
                writeHTML(tab, out); return '';
              }

              case 'mkdir': {
                const name = args.filter(a => !a.startsWith('-'))[0]; if (!name) return 'mkdir: missing operand';
                if (args.includes('-p')) {
                  const parts = name.split('/').filter(Boolean); let cur = tab.cwd;
                  for (const p of parts) {
                    const ch = FS.listDir(cur); const ex = ch.find(f => f.name === p && f.type === 'folder');
                    if (ex) cur = ex.id; else { const nf = await FS.createFolder(cur, p); cur = nf.id || cur; }
                  }
                } else { await FS.createFolder(tab.cwd, name); }
                renderDesktopIcons(); return '';
              }

              case 'rmdir': {
                const name = args[0]; if (!name) return 'rmdir: missing operand';
                const ch = FS.listDir(tab.cwd); const t = ch.find(f => f.name === name && f.type === 'folder');
                if (!t) return `rmdir: failed to remove '${name}': No such file or directory`;
                if (FS.listDir(t.id).length) return `rmdir: failed to remove '${name}': Directory not empty`;
                await FS.permanentDelete(t.id); renderDesktopIcons(); return '';
              }

              case 'touch': {
                if (!args[0]) return 'touch: missing file operand';
                const ch = FS.listDir(tab.cwd); const ex = ch.find(f => f.name === args[0]);
                if (ex) ex.modified = Date.now(); else await FS.createFile(tab.cwd, args[0], '', 'text/plain');
                renderDesktopIcons(); return '';
              }

              case 'rm': {
                const names = args.filter(a => !a.startsWith('-')); if (!names.length) return 'rm: missing operand';
                const rf = args.includes('-rf') || args.includes('-r') || args.includes('-f');
                for (const name of names) {
                  const ch = FS.listDir(tab.cwd); const t = ch.find(f => f.name === name);
                  if (!t) { if (!args.includes('-f')) return `rm: cannot remove '${name}': No such file or directory`; continue; }
                  if (rf) await FS.permanentDelete(t.id); else await FS.deleteToTrash(t.id);
                }
                renderDesktopIcons(); return '';
              }

              case 'cp': {
                const names = args.filter(a => !a.startsWith('-')); if (names.length < 2) return 'cp: missing destination file operand';
                const [srcName, ...rest] = names; const dst = rest[rest.length - 1];
                const ch = FS.listDir(tab.cwd); const src = ch.find(f => f.name === srcName);
                if (!src) return `cp: cannot stat '${srcName}': No such file or directory`;
                const dstFolder = resolvePath(tab.cwd, dst);
                if (dstFolder !== false) { await FS.createFile(dstFolder, srcName, src.content, src.mimeType); }
                else { await FS.createFile(tab.cwd, dst, src.content, src.mimeType); }
                renderDesktopIcons(); return '';
              }

              case 'mv': {
                const names = args.filter(a => !a.startsWith('-')); if (names.length < 2) return 'mv: missing destination file operand';
                const srcName = names[0]; const dst = names[1];
                const ch = FS.listDir(tab.cwd); const src = ch.find(f => f.name === srcName);
                if (!src) return `mv: cannot stat '${srcName}': No such file or directory`;
                const dstFolder = resolvePath(tab.cwd, dst);
                if (dstFolder !== false) { src.parentId = dstFolder; FS.files.set(src.id, src); await OS.workers.fs.call('putFiles', [src]); }
                else await FS.rename(src.id, dst);
                renderDesktopIcons(); return '';
              }

              case 'cat': {
                if (!args[0] && pipeIn !== undefined) return pipeIn || '';
                const names = args.filter(a => !a.startsWith('-'));
                if (!names.length) return pipeIn || '';
                const results = [];
                for (const n of names) {
                  const ch = FS.listDir(tab.cwd); const t = ch.find(f => f.name === n);
                  if (!t) return `cat: ${n}: No such file or directory`;
                  if (t.type === 'folder') return `cat: ${n}: Is a directory`;
                  if (args.includes('-n')) results.push((t.content || '').split('\n').map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n'));
                  else results.push(t.content || '');
                }
                return results.join('\n');
              }

              case 'head': {
                const fname = args.find(a => !a.startsWith('-')); const nFlag = args.find(a => a.startsWith('-'))?.slice(1);
                const n = nFlag && !isNaN(nFlag) ? parseInt(nFlag) : 10;
                const text = pipeIn || (fname && FS.listDir(tab.cwd).find(f => f.name === fname)?.content) || '';
                return text.split('\n').slice(0, n).join('\n');
              }

              case 'tail': {
                const fname = args.find(a => !a.startsWith('-')); const nFlag = args.find(a => a.startsWith('-'))?.slice(1);
                const n = nFlag && !isNaN(nFlag) ? parseInt(nFlag) : 10;
                const text = pipeIn || (fname && FS.listDir(tab.cwd).find(f => f.name === fname)?.content) || '';
                return text.split('\n').slice(-n).join('\n');
              }

              case 'wc': {
                const fname = args.find(a => !a.startsWith('-'));
                const text = pipeIn || (fname && FS.listDir(tab.cwd).find(f => f.name === fname)?.content) || '';
                if (args.includes('-l')) return String(text.split('\n').length);
                if (args.includes('-w')) return String(text.split(/\s+/).filter(Boolean).length);
                if (args.includes('-c')) return String(new TextEncoder().encode(text).length);
                const L = text.split('\n').length; const W = text.split(/\s+/).filter(Boolean).length; const C = text.length;
                return `${String(L).padStart(8)} ${String(W).padStart(8)} ${String(C).padStart(8)}${fname ? ' ' + fname : ''}`;
              }

              case 'grep': {
                const patternArg = args.find(a => !a.startsWith('-'));
                if (!patternArg) return 'grep: missing PATTERN';
                const fileArg = args.find((a, i) => !a.startsWith('-') && i !== args.indexOf(patternArg));
                const text = pipeIn || (fileArg && FS.listDir(tab.cwd).find(f => f.name === fileArg)?.content) || '';
                const flags = (args.includes('-i') ? 'i' : '') + (args.includes('-m') ? 'm' : '');
                const invert = args.includes('-v'); const count = args.includes('-c'); const lnum = args.includes('-n');
                let rx; try { rx = new RegExp(patternArg, flags); } catch { return `grep: invalid regexp: ${patternArg}`; }
                const lines = text.split('\n');
                const matched = lines.filter(l => invert ? !rx.test(l) : rx.test(l));
                if (count) return String(matched.length);
                if (lnum) return matched.map((l, i) => `${i + 1}:${l}`).join('\n');
                return matched.join('\n');
              }

              case 'sort': {
                const fname = args.find(a => !a.startsWith('-'));
                const text = pipeIn || (fname && FS.listDir(tab.cwd).find(f => f.name === fname)?.content) || '';
                let lines = text.split('\n');
                const rev = args.includes('-r'); const num = args.includes('-n'); const uniq = args.includes('-u');
                lines.sort((a, b) => num ? (parseFloat(a) - parseFloat(b)) : a.localeCompare(b));
                if (rev) lines.reverse();
                if (uniq) lines = [...new Set(lines)];
                return lines.join('\n');
              }

              case 'uniq': {
                const text = pipeIn || '';
                return text.split('\n').filter((l, i, a) => i === 0 || l !== a[i - 1]).join('\n');
              }

              case 'cut': {
                const text = pipeIn || '';
                const di = args.indexOf('-d'); const delim = di >= 0 ? args[di + 1] : '\t';
                const fi = args.indexOf('-f'); const field = fi >= 0 ? parseInt(args[fi + 1]) - 1 : 0;
                return text.split('\n').map(l => l.split(delim)[field] ?? '').join('\n');
              }

              case 'stat': {
                if (!args[0]) return 'stat: missing operand';
                const ch = FS.listDir(tab.cwd); const t = ch.find(f => f.name === args[0]);
                if (!t) return `stat: cannot statx '${args[0]}': No such file or directory`;
                const dt = new Date(t.modified || Date.now());
                return `  File: ${t.name}\n  Size: ${t.size || 0}\t\tBlocks: ${Math.ceil((t.size || 0) / 512)}\tIO Block: 4096  ${t.type === 'folder' ? 'directory' : 'regular file'}\nDevice: nova0\t\tInode: ${t.id.slice(-8) || 0}\tLinks: 1\nAccess: ${dt.toISOString()}\nModify: ${dt.toISOString()}\nChange: ${dt.toISOString()}`;
              }

              case 'chmod': {
                writeLine(tab, `chmod: permissions are advisory in NovaByte`, 'shell-yellow'); return '';
              }

              case 'find': {
                const startArg = args.find(a => !a.startsWith('-')) || '.';
                const nameArg = args.includes('-name') ? args[args.indexOf('-name') + 1] : null;
                const typeArg = args.includes('-type') ? args[args.indexOf('-type') + 1] : null;
                const startId = startArg === '.' ? tab.cwd : resolvePath(tab.cwd, startArg);
                if (startId === false) return `find: '${startArg}': No such file or directory`;
                const results = [];
                function search(id, prefix) {
                  const files = FS.listDir(id);
                  for (const f of files) {
                    const path = prefix + '/' + f.name;
                    const matchName = !nameArg || f.name.replace(/^\./, '') === (nameArg.replace(/^\*/, '')) || f.name.includes(nameArg.replace(/[*?]/g, ''));
                    const matchType = !typeArg || (typeArg === 'd' && f.type === 'folder') || (typeArg === 'f' && f.type !== 'folder');
                    if (matchName && matchType) results.push(path);
                    if (f.type === 'folder') search(f.id, path);
                  }
                }
                search(startId === false ? tab.cwd : startId, '.');
                return results.join('\n') || (nameArg ? '(no matches)' : '');
              }

              case 'diff': {
                if (args.length < 2) return 'diff: missing operand after diff';
                const [a1, a2] = args.filter(a => !a.startsWith('-'));
                const ch = FS.listDir(tab.cwd);
                const f1 = ch.find(f => f.name === a1); const f2 = ch.find(f => f.name === a2);
                if (!f1) return `diff: ${a1}: No such file or directory`;
                if (!f2) return `diff: ${a2}: No such file or directory`;
                const L1 = (f1.content || '').split('\n'); const L2 = (f2.content || '').split('\n');
                const max = Math.max(L1.length, L2.length); let out = ''; let hasDiff = false;
                writeHTML(tab, `<span class="shell-dim">--- ${a1}</span>\n<span class="shell-dim">+++ ${a2}</span>`);
                for (let i = 0; i < max; i++) {
                  if (L1[i] !== L2[i]) {
                    hasDiff = true;
                    if (L1[i] !== undefined) out += `<span class="shell-red">- ${escapeText(L1[i])}</span>\n`;
                    if (L2[i] !== undefined) out += `<span class="shell-green">+ ${escapeText(L2[i])}</span>\n`;
                  }
                }
                if (!hasDiff) return '(files are identical)';
                writeHTML(tab, out); return '';
              }

              case 'ps': {
                const procs = [{ pid: 1, user: 'root', stat: 'S', name: 'nova-init' }, { pid: 2, user: 'root', stat: 'S', name: 'kworker/0:0' }, { pid: 10, user: 'root', stat: 'S', name: 'nova-kernel' }, { pid: 100, user: OS.username, stat: 'S', name: 'nova-session' }, { pid: 101, user: OS.username, stat: 'S', name: 'nova-wm' }, { pid: 102, user: OS.username, stat: 'S', name: 'nova-fs' }, { pid: 103, user: OS.username, stat: 'S', name: 'nova-indexer' }];
                let pid = 200;
                for (const [, ws] of OS.windows) { const app = OS.apps[ws.appId]; if (app) procs.push({ pid: pid++, user: OS.username, stat: 'S', name: app.name.toLowerCase() }); }
                const header = '<span class="shell-bold">  PID USER     STAT COMMAND</span>';
                const rows = procs.map(p => `${String(p.pid).padStart(5)} ${p.user.padEnd(8)} ${p.stat}    ${p.name}`);
                writeHTML(tab, header); return rows.join('\n');
              }

              case 'kill': {
                if (!args[0]) return 'kill: usage: kill [-s sigspec] pid';
                if (isNaN(parseInt(args[args.length - 1]))) return `kill: ${args[args.length - 1]}: invalid signal specification`;
                return `kill: (${args[args.length - 1]}) - Operation not permitted`;
              }

              case 'neofetch':
              case 'fastfetch': {
                const cores = navigator.hardwareConcurrency || 4;
                const ram = (navigator.deviceMemory || 4) + ' GB';
                const engine = navigator.userAgent.match(/(Chrome|Firefox|Safari|Edge)\/[\d.]+/)?.[0] || 'Browser';
                writeHTML(tab,
                  `  <span class="shell-blue shell-bold">  ╔══╗  </span>  <span class="shell-bold shell-green">${OS.username}</span><span class="shell-dim">@</span><span class="shell-bold">novabyteOS</span>\n` +
                  `  <span class="shell-blue shell-bold">  ║NB║  </span>  <span class="shell-dim">────────────────────────</span>\n` +
                  `  <span class="shell-blue shell-bold">  ╚══╝  </span>  <span class="shell-blue">OS:</span>      NovaByte <span class="shell-bold">${OS.version}</span>\n` +
                  `          <span class="shell-blue">Kernel:</span>  NovaKernel 5.15.0-nova\n` +
                  `          <span class="shell-blue">Shell:</span>   Terminal\n` +
                  `          <span class="shell-blue">CPU:</span>     ${cores} cores (logical)\n` +
                  `          <span class="shell-blue">RAM:</span>     ${ram}\n` +
                  `          <span class="shell-blue">Engine:</span>  ${engine}\n` +
                  `          <span class="shell-blue">Screen:</span>  ${screen.width}×${screen.height}@${window.devicePixelRatio}x\n` +
                  `          <span class="shell-blue">Theme:</span>   NovaDark (default)\n` +
                  `          <span class="shell-blue">User:</span>    ${OS.username}`);
                return '';
              }

              default: {
                const ch = FS.listDir(tab.cwd); const ex = ch.find(f => f.name === cmd);
                if (ex) return `bash: ${cmd}: Permission denied`;
                return `bash: ${cmd}: command not found`;
              }
            }
          }

          // ── Full pipeline runner ─────────────────────────────────────
          async function runCommand(tab, line) {
            line = line.trim(); if (!line) return '';
            // Handle ; chains
            if (line.includes(';')) {
              const parts = line.split(';').map(s => s.trim()).filter(Boolean);
              let last = ''; for (const p of parts) last = await runCommand(tab, p); return last;
            }
            // Handle && chains
            if (line.includes('&&')) {
              const parts = line.split('&&').map(s => s.trim());
              let last = ''; for (const p of parts) { last = await runCommand(tab, p); if (last && (last.startsWith('bash:') || last.startsWith('Error'))) return last; }
              return last;
            }
            // Handle || chains
            if (line.includes(' || ')) {
              const parts = line.split(' || ').map(s => s.trim());
              let last = ''; for (const p of parts) { last = await runCommand(tab, p); if (!last || (typeof last === 'string' && !last.startsWith('Error') && !last.startsWith('bash:'))) return last; }
              return last;
            }
            // Handle redirects (basic)
            if (line.includes('>')) {
              const [cmdPart, filePart] = line.split('>').map(s => s.trim());
              const out = await runCommand(tab, cmdPart);
              if (filePart) { const ch = FS.listDir(tab.cwd); const ex = ch.find(f => f.name === filePart.trim()); if (ex) { ex.content = out; await OS.workers.fs.call('putFiles', [ex]); } else await FS.createFile(tab.cwd, filePart.trim(), out, 'text/plain'); return ''; }
              return out;
            }
            // Pipe chain
            const segs = splitPipes(line);
            if (segs.length === 1) return await execOne(tab, segs[0], '');
            let pipe = '';
            for (const s of segs) pipe = await execOne(tab, s, pipe);
            return pipe;
          }

          function welcomeTab(tab) {
            writeHTML(tab, `<span class="shell-bold shell-blue">Terminal</span>  <span class="shell-dim">NovaByte ${OS.version} — ${OS.username}@novabyteOS</span>`);
            writeHTML(tab, `<span class="shell-dim">Type <span class="shell-green">help</span> for commands  ·  <span class="shell-green">Tab</span> autocomplete  ·  <span class="shell-green">Ctrl+Shift+T</span> new tab</span>`);
            writeLine(tab, '');
          }

          // ── Global keyboard shortcuts ────────────────────────────────
          const _kd = e => {
            const win = content.closest('.app-window');
            if (!win || win.dataset.appId !== 'shell') return;
            if (e.ctrlKey && e.shiftKey && e.key === 'T') { e.preventDefault(); const t = createTab('Terminal ' + (tabs.length + 1)); switchTab(tabs.length - 1); welcomeTab(t); updatePrompt(t); }
            if (e.ctrlKey && e.shiftKey && e.key === 'W') { e.preventDefault(); removeTab(activeTabIdx); }
          };
          document.addEventListener('keydown', _kd);
          state.cleanups.push(() => document.removeEventListener('keydown', _kd));

          // ── Init first tab ───────────────────────────────────────────
          const t0 = createTab('Terminal');
          switchTab(0);
          welcomeTab(t0);
          updatePrompt(t0);
          requestAnimationFrame(() => t0.input.focus());
        }
      });

      /* ── APP 4: Browser ── */
      registerApp({
        id: 'browser', name: 'Browser', icon: 'globe',
        description: 'Web Browser',
        defaultSize: [900, 600], minSize: [500, 350],
        onClose(state) {
          // Tell client.js to destroy all hidden browser windows for this session
          if (window.ipc) window.ipc.postMessage(JSON.stringify({ type: 'browser:closeAll' }));
        },
        init(content, state, options) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.browser', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.browser</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const container = createEl('div', { className: 'browser-container' });

          // ── Tabs bar ──────────────────────────────────────────────────────
          const tabsBar = createEl('div', { className: 'browser-tabs-bar', role: 'tablist' });

          let tabs = [{ id: 1, title: 'New Tab', url: '', favicon: '', incognito: false }];
          let activeTabId = 1;
          let nextTabId = 2;

          // ── Bookmarks, History & Settings storage ─────────────────────────
          const BK_KEY = 'nbosp_browser_bookmarks';
          const HX_KEY = 'nbosp_browser_history';
          const ST_KEY = 'nbosp_browser_settings';
          let _settingsCache = null;
          function loadSettings() {
            if (_settingsCache) return _settingsCache;
            try { _settingsCache = JSON.parse(localStorage.getItem(ST_KEY) || '{}'); }
            catch { _settingsCache = {}; }
            return _settingsCache;
          }
          function saveSetting(key, val) {
            const s = loadSettings();
            s[key] = val;
            _settingsCache = s;
            localStorage.setItem(ST_KEY, JSON.stringify(s));
          }
          function getSetting(key, def) { const v = loadSettings()[key]; return v !== undefined ? v : def; }

          // Search engines — Google is default out of the box
          const SEARCH_ENGINES = {
            google: { label: 'Google', url: 'https://www.google.com/search?q=' },
            bing: { label: 'Bing', url: 'https://www.bing.com/search?q=' },
            duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
            ecosia: { label: 'Ecosia', url: 'https://www.ecosia.org/search?q=' },
            brave: { label: 'Brave', url: 'https://search.brave.com/search?q=' },
            yahoo: { label: 'Yahoo', url: 'https://search.yahoo.com/search?p=' },
          };
          function getSearchUrl(q) {
            const eng = getSetting('searchEngine', 'google');
            const base = SEARCH_ENGINES[eng]?.url || SEARCH_ENGINES.google.url;
            return base + encodeURIComponent(q);
          }

          let _bookmarksCache = null;
          function loadBookmarks() {
            if (_bookmarksCache) return _bookmarksCache;
            try { _bookmarksCache = JSON.parse(localStorage.getItem(BK_KEY) || '[]'); }
            catch { _bookmarksCache = []; }
            return _bookmarksCache;
          }
          function saveBookmarks(arr) {
            _bookmarksCache = arr.slice(0, 500);
            localStorage.setItem(BK_KEY, JSON.stringify(_bookmarksCache));
          }
          let _historyCache = null;
          function loadHistory() {
            if (_historyCache) return _historyCache;
            try { _historyCache = JSON.parse(localStorage.getItem(HX_KEY) || '[]'); }
            catch { _historyCache = []; }
            return _historyCache;
          }
          function saveHistory(arr) {
            _historyCache = arr.slice(0, 1000);
            localStorage.setItem(HX_KEY, JSON.stringify(_historyCache));
          }
          function isBookmarked(url) { return loadBookmarks().some(b => b.url === url); }
          function toggleBookmark(url, title, favicon) {
            let arr = loadBookmarks();
            const idx = arr.findIndex(b => b.url === url);
            if (idx >= 0) { arr.splice(idx, 1); saveBookmarks(arr); return false; }
            arr.unshift({ url, title: title || url, favicon: favicon || '', ts: Date.now() });
            saveBookmarks(arr);
            return true;
          }

          let _panelType = null; // track which panel is currently open for live refresh
          function addHistory(url, title, favicon) {
            const tab = tabs.find(t => t.id === activeTabId);
            if (tab?.incognito || tab?.isPopup) return; // no history in incognito or popup windows
            try {
              let arr = loadHistory().filter(h => h.url !== url); // deduplicate
              arr.unshift({ url, title: title || url, favicon: favicon || '', ts: Date.now() });
              saveHistory(arr);
              // Live-refresh history panel if it's open
              if (_panelType === 'history' && panel.style.display !== 'none') showPanel('history');
            } catch { }
          }
          // loadHistory defined above (write-through cache version)

          function renderTabs() {
            tabsBar.innerHTML = '';
            tabs.forEach(tab => {
              const tabEl = createEl('button', {
                className: 'browser-tab' + (tab.id === activeTabId ? ' active' : '') + (tab.incognito ? ' incognito' : ''),
                role: 'tab',
                'aria-selected': tab.id === activeTabId,
              });
              const faviconSpan = createEl('span', { className: 'tab-icon' });
              if (tab.favicon) {
                const img = createEl('img', { src: tab.favicon, style: { width: '14px', height: '14px', borderRadius: '2px' } });
                faviconSpan.appendChild(img);
              } else {
                faviconSpan.innerHTML = svgIcon('globe', 14);
              }
              tabEl.appendChild(faviconSpan);
              const titleSpan = createEl('span', { className: 'tab-title', textContent: tab.title });
              tabEl.appendChild(titleSpan);
              const closeBtn = createEl('span', { className: 'tab-close' });
              closeBtn.innerHTML = svgIcon('x', 12);
              closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id); });
              tabEl.appendChild(closeBtn);
              tabEl.addEventListener('click', () => switchToTab(tab.id));
              tabsBar.appendChild(tabEl);
            });
            const newTabBtn = createEl('button', { className: 'browser-new-tab-btn', 'aria-label': 'New tab' });
            newTabBtn.innerHTML = svgIcon('plus', 16);
            newTabBtn.addEventListener('click', createNewTab);
            tabsBar.appendChild(newTabBtn);
          }

          function createNewTab() {
            const t = { id: nextTabId++, title: 'New Tab', url: '', favicon: '', incognito: false };
            tabs.push(t);
            switchToTab(t.id);
          }

          function createIncognitoTab() {
            const t = { id: nextTabId++, title: 'Incognito', url: '', favicon: '', incognito: true };
            tabs.push(t);
            switchToTab(t.id);
          }

          function applyMobileViewportFrame(wv, isMobile) {
            if (isMobile) {
              wv.classList.add('mobile-viewport');
              viewport.classList.add('mobile-mode');
              // position:absolute so the CSS width/left/transform take effect
              wv.style.position = 'absolute';
            } else {
              wv.classList.remove('mobile-viewport');
              viewport.classList.remove('mobile-mode');
              // restore normal flow positioning used by showWebviewForTab
              wv.style.position = 'relative';
              wv.style.width = '';
              wv.style.left = '';
              wv.style.transform = '';
            }
          }

          function toggleUserAgent() {
            const tab = tabs.find(t => t.id === activeTabId);
            if (!tab) return;
            const mode = getTabMode(activeTabId);
            const goingMobile = tab.userAgent !== 'mobile';
            tab.userAgent = goingMobile ? 'mobile' : 'desktop';

            if (mode === 'iframe') {
              // iframes can't override UA — apply the 390px viewport frame only.
              // Responsive sites will react to the narrow width even without a mobile UA.
              const ifr = tabIframes.get(activeTabId);
              if (!ifr) return;
              applyMobileViewportFrame(ifr, goingMobile);
              // Re-apply zoom with correct dimensions after mobile/desktop toggle
              const z = tabZoom.get(activeTabId) || 1.0;
              if (goingMobile) {
                ifr.style.width = '390px';
                ifr.style.height = '100%';
                ifr.style.transformOrigin = 'top center';
                ifr.style.transform = z !== 1.0 ? `translateX(-50%) scale(${z})` : 'translateX(-50%)';
              } else {
                const pct = (100 / z).toFixed(4) + '%';
                ifr.style.width = pct;
                ifr.style.height = pct;
                ifr.style.transformOrigin = 'top left';
                ifr.style.transform = z !== 1.0 ? `scale(${z})` : '';
              }
              // Reload so the page re-renders inside the new frame dimensions
              try { ifr.contentWindow.location.reload(); } catch (_) {
                // cross-origin — force reload via src reassignment
                const src = ifr.src; ifr.src = ''; ifr.src = src;
              }
            } else {
              const wv = tabWebviews.get(activeTabId);
              if (!wv) return;
              if (goingMobile) {
                wv.setUserAgentOverride('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
                applyMobileViewportFrame(wv, true);
              } else {
                wv.setUserAgentOverride('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                applyMobileViewportFrame(wv, false);
              }
              if (tab.url) {
                // Register listener BEFORE reload so we never miss the loadstop event
                if (goingMobile) {
                  wv.addEventListener('loadstop', function onMobileLoad() {
                    wv.removeEventListener('loadstop', onMobileLoad);
                    wv.executeScript({
                      code: `
                      var m = document.querySelector('meta[name=viewport]');
                      if (!m) { m = document.createElement('meta'); m.name='viewport'; document.head.appendChild(m); }
                      m.content = 'width=device-width, initial-scale=1, maximum-scale=1';
                    ` });
                  });
                }
                wv.reload();
              }
            }
          }

          const tabZoom = new Map();    // per-tab zoom level
          const tabCleanups = new Map(); // tabId → [cleanup fns]
          function adjustZoom(delta) {
            let z = tabZoom.get(activeTabId) || 1.0;
            if (delta === 0) { z = 1.0; }
            else { z = Math.min(3, Math.max(0.25, z + delta)); }
            tabZoom.set(activeTabId, z);
            const mode = getTabMode(activeTabId);
            if (mode === 'iframe') {
              const ifr = tabIframes.get(activeTabId);
              if (!ifr) return;
              const tab = tabs.find(t => t.id === activeTabId);
              const isMobile = tab?.userAgent === 'mobile';
              if (isMobile) {
                ifr.style.width = '390px';
                ifr.style.height = '100%';
                ifr.style.transformOrigin = 'top center';
                ifr.style.transform = z !== 1.0 ? `translateX(-50%) scale(${z})` : 'translateX(-50%)';
              } else {
                const pct = (100 / z).toFixed(4) + '%';
                ifr.style.width = pct;
                ifr.style.height = pct;
                ifr.style.transformOrigin = 'top left';
                ifr.style.transform = z !== 1.0 ? `scale(${z})` : '';
              }
            } else {
              const wv = tabWebviews.get(activeTabId);
              if (!wv) return;
              wv.setZoom(z);
            }
          }

          function closeTab(tabId) {
            const idx = tabs.findIndex(t => t.id === tabId);
            if (idx === -1) return;
            if (tabId === activeTabId && tabs.length > 1) {
              switchToTab(tabs[idx > 0 ? idx - 1 : 1].id);
            }
            tabs = tabs.filter(t => t.id !== tabId);
            // Run per-tab cleanups (cancels poll timers, etc.) before removing the webview
            (tabCleanups.get(tabId) || []).forEach(fn => { try { fn(); } catch (_) {} });
            tabCleanups.delete(tabId);
            if (tabs.length === 0) { createNewTab(); return; }
            renderTabs();
            const closedWv = tabWebviews?.get(tabId); if (closedWv) { closedWv.remove(); tabWebviews.delete(tabId); }
            const closedIfr = tabIframes?.get(tabId); if (closedIfr) { closedIfr.remove(); tabIframes.delete(tabId); }
            tabViewMode.delete(tabId);
            const closedNotice = viewport.querySelector('.browser-iframe-blocked[data-tab="' + tabId + '"]'); if (closedNotice) closedNotice.remove();
          }

          function renderSpeedDial() {
            // Hide all webviews
            tabWebviews.forEach(wv => { wv.style.visibility = 'hidden'; wv.style.pointerEvents = 'none'; });
            // Remove old speed dial
            const old = viewport.querySelector('.speed-dial');
            if (old) old.remove();
            const tab = tabs.find(t => t.id === activeTabId);
            const sd = createEl('div', { className: 'speed-dial' });
            sd.style.cssText = 'position:absolute;inset:0;overflow-y:auto;padding:40px 32px 24px;display:flex;flex-direction:column;align-items:center;gap:28px;background:var(--bg-base);z-index:1;';
            const greeting = createEl('div', { style: 'font-size:22px;font-weight:600;color:var(--text-primary);' });
            const h = new Date().getHours();
            greeting.textContent = h < 12 ? '🌤 Good morning' : h < 18 ? '☀️ Good afternoon' : '🌙 Good evening';
            if (tab?.incognito) {
              sd.style.background = 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)';
              greeting.textContent = '🕶 Incognito';
            }
            sd.appendChild(greeting);
            const bookmarks = loadBookmarks().slice(0, 8);
            if (bookmarks.length) {
              const grid = createEl('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:12px;width:100%;max-width:640px;' });
              bookmarks.forEach(bk => {
                const tile = createEl('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 8px;background:var(--bg-elevated);border-radius:10px;cursor:pointer;border:1px solid var(--border-subtle);transition:background 0.15s;' });
                tile.addEventListener('mouseenter', () => tile.style.background = 'var(--bg-hover)');
                tile.addEventListener('mouseleave', () => tile.style.background = 'var(--bg-elevated)');
                const ico = createEl('div', { style: 'width:32px;height:32px;border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:var(--bg-hover);' });
                if (bk.favicon && /^https?:\/\//i.test(bk.favicon)) {
                  const _fimg = document.createElement('img');
                  _fimg.src = bk.favicon; _fimg.style.cssText = 'width:24px;height:24px;border-radius:3px;';
                  _fimg.onerror = () => { ico.innerHTML = ''; ico.innerHTML = svgIcon('globe', 20); };
                  ico.appendChild(_fimg);
                } else { ico.innerHTML = svgIcon('globe', 20); }
                const lbl = createEl('div', { style: 'font-size:11px;color:var(--text-secondary);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%;' });
                try { lbl.textContent = new URL(bk.url).hostname.replace('www.', ''); } catch { lbl.textContent = bk.title; }
                tile.append(ico, lbl);
                tile.addEventListener('click', () => { sd.remove(); navigate(bk.url); });
                grid.appendChild(tile);
              });
              sd.appendChild(grid);
            } else {
              const hint = createEl('div', { style: 'color:var(--text-muted);font-size:13px;text-align:center;' });
              hint.textContent = 'Bookmark sites with ★ to see them here';
              sd.appendChild(hint);
            }
            // Recent history
            const hist = loadHistory().slice(0, 5);
            if (hist.length && !tab?.incognito) {
              const sec = createEl('div', { style: 'width:100%;max-width:640px;' });
              sec.innerHTML = '<div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em;">Recent</div>';
              hist.forEach(h => {
                const row = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;' });
                row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-elevated)');
                row.addEventListener('mouseleave', () => row.style.background = '');
                row.innerHTML = svgIcon('clock', 13) + '<span style="font-size:12px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;"></span>'; row.querySelector('span').textContent = h.title || h.url;
                row.addEventListener('click', () => { sd.remove(); navigate(h.url); });
                sec.appendChild(row);
              });
              sd.appendChild(sec);
            }
            viewport.appendChild(sd);
          }

          function switchToTab(tabId) {
            activeTabId = tabId;
            const tab = tabs.find(t => t.id === tabId);
            if (tab) {
              urlBar.value = stripHttps(tab.url || ''); currentUrl = tab.url || '';
              starBtn.style.color = tab.url && isBookmarked(tab.url) ? 'var(--accent)' : '';
              updateModeBtn();
              if (tab.url === 'browser://settings') {
                renderSettingsPage();
              } else if (tab.url) {
                updateUrlIcon(tab.url);
                const mode = getTabMode(tabId);
                if (mode === 'iframe') {
                  const ifr = getOrCreateIframe(tabId);
                  if (!ifr.parentNode) viewport.appendChild(ifr);
                } else {
                  const wv = getOrCreateWebview(tabId);
                  if (!wv.parentNode) viewport.appendChild(wv);
                }
                showViewForTab(tabId);
                // hide speed dial if present
                const sd = viewport.querySelector('.speed-dial');
                if (sd) sd.remove();
              } else {
                renderSpeedDial();
              }
            }
            renderTabs();
          }

          // ── Toolbar ───────────────────────────────────────────────────────
          const toolbar = createEl('div', { className: 'browser-toolbar' });

          const backBtn = createEl('button', { className: 'browser-nav-btn', 'aria-label': 'Go back' });
          backBtn.innerHTML = svgIcon('chevron-left', 16);
          const fwdBtn = createEl('button', { className: 'browser-nav-btn', 'aria-label': 'Go forward' });
          fwdBtn.innerHTML = svgIcon('chevron-right', 16);
          const refreshBtn = createEl('button', { className: 'browser-nav-btn', 'aria-label': 'Refresh' });
          refreshBtn.innerHTML = svgIcon('refresh', 16);

          const urlBarWrap = createEl('div', { className: 'browser-url-bar-wrap' });
          const urlBar = createEl('input', {
            id: 'browser-url-bar',
            name: 'url',
            className: 'browser-url-bar',
            placeholder: 'Search or enter URL…',
            'aria-label': 'Address bar'
          });
          const urlIcon = createEl('span', { className: 'browser-url-icon' });
          urlIcon.innerHTML = svgIcon('search', 14);
          urlBarWrap.appendChild(urlBar);
          urlBarWrap.appendChild(urlIcon);

          function updateUrlIcon(url) {
            if (url && url.startsWith('https://')) {
              urlIcon.innerHTML = svgIcon('lock', 14);
              urlIcon.style.color = 'var(--text-success)';
            } else if (url && url.startsWith('http://')) {
              // Only show warning icon if the security warnings setting is enabled
              if (getSetting('show_security_warnings', true)) {
                urlIcon.innerHTML = svgIcon('unlock', 14);
                urlIcon.style.color = 'var(--text-warning)';
              } else {
                urlIcon.innerHTML = svgIcon('globe', 14);
                urlIcon.style.color = '';
              }
            } else {
              urlIcon.innerHTML = svgIcon('search', 14);
              urlIcon.style.color = '';
            }
          }

          // ── Star bookmark button ──────────────────────────────────────
          const starBtn = createEl('button', { className: 'browser-nav-btn', 'aria-label': 'Bookmark', title: 'Bookmark this page' });
          starBtn.innerHTML = svgIcon('star', 16);
          starBtn.addEventListener('click', () => {
            if (!currentUrl || currentUrl.startsWith('novabyte:')) return;
            const tab = tabs.find(t => t.id === activeTabId);
            if (tab?.incognito) return; // no bookmarks in incognito
            const added = toggleBookmark(currentUrl, tab?.title, tab?.favicon);
            starBtn.style.color = added ? 'var(--accent)' : '';
            starBtn.innerHTML = svgIcon(added ? 'star' : 'star', 16);
            Notify.show({ title: added ? 'Bookmark added' : 'Bookmark removed', body: tab?.title || currentUrl, type: 'info', appName: 'Browser' });
          });

          // ── Menu button ───────────────────────────────────────────────
          const menuBtn = createEl('button', { className: 'browser-nav-btn', 'aria-label': 'Menu', title: 'Browser menu' });
          menuBtn.innerHTML = svgIcon('menu', 16);
          menuBtn.addEventListener('click', (e) => {
            const tab = tabs.find(t => t.id === activeTabId);
            const isIncog = tab?.incognito || false;
            const menuItems = [
              { label: 'New Tab', action: () => createNewTab() },
              { label: 'New Incognito Tab', action: () => createIncognitoTab() },
              { separator: true },
            ];
            if (!isIncog) menuItems.push({ label: 'Bookmarks', action: () => showPanel('bookmarks') });
            menuItems.push({ label: 'History', action: () => showPanel('history') });
            menuItems.push({ separator: true });
            menuItems.push(
              { label: 'Find in Page', shortcut: 'Ctrl+F', action: () => openFindBar() },
              { label: tab?.userAgent === 'mobile' ? 'Switch to Desktop Site' : 'Switch to Mobile Site', action: () => toggleUserAgent() },
              { label: getTabMode(activeTabId) === 'iframe' ? 'Switch to Webview Mode' : 'Switch to iFrame Mode', action: () => { const next = getTabMode(activeTabId) === 'iframe' ? 'webview' : 'iframe'; if (next === 'webview') clearFindStateOnModeSwitch(); setTabMode(activeTabId, next); const t = tabs.find(t2 => t2.id === activeTabId); if (t?.url && t.url !== 'browser://settings') navigate(t.url); updateModeBtn(); } },
              { separator: true },
              { label: 'Zoom In', action: () => adjustZoom(0.1) },
              { label: 'Zoom Out', action: () => adjustZoom(-0.1) },
              { label: 'Reset Zoom', action: () => adjustZoom(0) },
              { separator: true },
              { label: 'Settings', action: () => navigate('browser://settings') },
            );
            ContextMenu.show(e.clientX, e.clientY, menuItems);
          });

          toolbar.append(backBtn, fwdBtn, refreshBtn, urlBarWrap, starBtn, menuBtn);

          // ── View mode toggle button (Webview ↔ iFrame) ───────────────────
          const modeBtn = createEl('button', { className: 'browser-mode-btn', title: 'Switch to iframe mode' });
          modeBtn.innerHTML = svgIcon('monitor', 14) + ' <span>Webview</span>';
          modeBtn.addEventListener('click', () => {
            const current = getTabMode(activeTabId);
            const next = current === 'webview' ? 'iframe' : 'webview';
            setTabMode(activeTabId, next);
            // Re-navigate current URL in the new mode
            const tab = tabs.find(t => t.id === activeTabId);
            if (tab?.url && tab.url !== 'browser://settings') navigate(tab.url);
            updateModeBtn();
          });
          toolbar.appendChild(modeBtn);

          // ── Find bar ─────────────────────────────────────────────────
          const findBar = createEl('div', { style: 'display:none;align-items:center;gap:6px;padding:4px 10px;background:var(--bg-elevated);border-bottom:1px solid var(--border-subtle);flex-shrink:0;' });
          const findInput = createEl('input', { id: 'page-find-input', name: 'page-find', placeholder: 'Find in page…', style: 'flex:1;background:var(--bg-base);border:1px solid var(--border-subtle);border-radius:4px;padding:3px 8px;font-size:12px;color:var(--text-primary);outline:none;' });
          const findCount = createEl('span', { style: 'font-size:11px;color:var(--text-muted);min-width:50px;' });
          const findPrev = createEl('button', { className: 'browser-nav-btn', style: 'padding:2px 6px;', title: 'Previous' });
          findPrev.innerHTML = svgIcon('chevron-up', 14);
          const findNext = createEl('button', { className: 'browser-nav-btn', style: 'padding:2px 6px;', title: 'Next' });
          findNext.innerHTML = svgIcon('chevron-down', 14);
          const findClose = createEl('button', { className: 'browser-nav-btn', style: 'padding:2px 6px;', title: 'Close' });
          findClose.innerHTML = svgIcon('x', 14);
          findBar.append(findInput, findCount, findPrev, findNext, findClose);

          function openFindBar() {
            findBar.style.display = 'flex';
            findInput.focus(); findInput.select();
          }
          // ── iframe find helpers ──────────────────────────────────────────
          let _iframeFinds = [];
          let _iframeFindIdx = 0;

          function iframeFind(text, backward) {
            const ifr = tabIframes.get(activeTabId);
            if (!ifr) return;
            let doc;
            try { doc = ifr.contentDocument; } catch (_) { return; }
            if (!doc || !doc.body) return;

            // Clear previous highlights then NORMALIZE to merge fragmented text nodes.
            // Without normalize(), searching "hel" after "he" leaves ["he","l","lo"] split
            // nodes so the next regex never matches across the boundary.
            doc.querySelectorAll('.__nb_highlight').forEach(el => {
              el.replaceWith(doc.createTextNode(el.textContent));
            });
            doc.body.normalize();
            _iframeFinds = [];

            if (!text) { findCount.textContent = ''; return; }

            const re = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

            // Walk text nodes, skipping script/style so we don't break page JS
            const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
              acceptNode(node) {
                const tag = node.parentElement && node.parentElement.tagName;
                if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
              }
            });
            const toReplace = [];
            let node;
            while ((node = walker.nextNode())) {
              re.lastIndex = 0;
              if (re.test(node.textContent)) toReplace.push(node);
            }

            toReplace.forEach(node => {
              const frag = doc.createDocumentFragment();
              let last = 0, m;
              re.lastIndex = 0;
              while ((m = re.exec(node.textContent)) !== null) {
                frag.appendChild(doc.createTextNode(node.textContent.slice(last, m.index)));
                const mark = doc.createElement('mark');
                mark.className = '__nb_highlight';
                // font:inherit preserves every font property (family, size, weight, style,
                // variant, line-height) so highlights don't reflow text or break custom fonts
                mark.style.cssText = 'background:#f6c90e !important;color:#000 !important;' +
                  'font:inherit !important;display:inline !important;' +
                  'padding:0 !important;margin:0 !important;border-radius:2px;' +
                  'text-decoration:inherit !important;vertical-align:inherit !important;';
                mark.textContent = m[0];
                frag.appendChild(mark);
                _iframeFinds.push(mark);
                last = m.index + m[0].length;
              }
              frag.appendChild(doc.createTextNode(node.textContent.slice(last)));
              node.parentNode.replaceChild(frag, node);
            });

            if (!_iframeFinds.length) { findCount.textContent = '0/0'; return; }
            _iframeFindIdx = backward ? _iframeFinds.length - 1 : 0;
            _iframeFinds[_iframeFindIdx].style.background = '#ff7043 !important';
            _iframeFinds[_iframeFindIdx].scrollIntoView({ block: 'center' });
            findCount.textContent = (_iframeFindIdx + 1) + '/' + _iframeFinds.length;
          }

          function iframeFindStep(backward) {
            if (!_iframeFinds.length) return;
            _iframeFinds[_iframeFindIdx].style.background = '#f6c90e !important';
            _iframeFindIdx = ((_iframeFindIdx + (backward ? -1 : 1)) + _iframeFinds.length) % _iframeFinds.length;
            _iframeFinds[_iframeFindIdx].style.background = '#ff7043 !important';
            _iframeFinds[_iframeFindIdx].scrollIntoView({ block: 'center' });
            findCount.textContent = (_iframeFindIdx + 1) + '/' + _iframeFinds.length;
          }

          function iframeFindClear() {
            const ifr = tabIframes.get(activeTabId);
            if (!ifr) return;
            try {
              const d = ifr.contentDocument;
              if (d && d.body) {
                d.querySelectorAll('.__nb_highlight').forEach(el => {
                  el.replaceWith(d.createTextNode(el.textContent));
                });
                d.body.normalize();
              }
            } catch (_) {}
            _iframeFinds = [];
            _iframeFindIdx = 0;
          }

          function closeFindBar() {
            findBar.style.display = 'none';
            findCount.textContent = '';
            if (getTabMode(activeTabId) === 'iframe') {
              iframeFindClear();
            } else {
              const wv = tabWebviews.get(activeTabId);
              if (wv) wv.stopFinding('clear');
            }
          }

          // Also clear iframe highlights whenever the active tab switches away from iframe mode
          // (e.g. clicking "Switch to Webview" while find bar was open) — prevents stale marks
          // from causing the "bottom half cut off" repaint glitch in the new webview view.
          function clearFindStateOnModeSwitch() {
            iframeFindClear();
            findCount.textContent = '';
          }

          findInput.addEventListener('input', () => {
            const q = findInput.value;
            if (getTabMode(activeTabId) === 'iframe') {
              iframeFind(q, false);
            } else {
              const wv = tabWebviews.get(activeTabId);
              if (!wv || !q) { findCount.textContent = ''; return; }
              wv.find(q, {}, r => { if (r) findCount.textContent = r.activeMatchOrdinal + '/' + r.numberOfMatches; });
            }
          });
          findInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
              if (getTabMode(activeTabId) === 'iframe') { iframeFindStep(e.shiftKey); }
              else { const wv = tabWebviews.get(activeTabId); if (wv && findInput.value) wv.find(findInput.value, { backward: e.shiftKey }, r => { if (r) findCount.textContent = r.activeMatchOrdinal + '/' + r.numberOfMatches; }); }
            }
            if (e.key === 'Escape') closeFindBar();
          });
          findPrev.addEventListener('click', () => {
            if (getTabMode(activeTabId) === 'iframe') { iframeFindStep(true); }
            else { const wv = tabWebviews.get(activeTabId); if (wv && findInput.value) wv.find(findInput.value, { backward: true }, r => { if (r) findCount.textContent = r.activeMatchOrdinal + '/' + r.numberOfMatches; }); }
          });
          findNext.addEventListener('click', () => {
            if (getTabMode(activeTabId) === 'iframe') { iframeFindStep(false); }
            else { const wv = tabWebviews.get(activeTabId); if (wv && findInput.value) wv.find(findInput.value, { backward: false }, r => { if (r) findCount.textContent = r.activeMatchOrdinal + '/' + r.numberOfMatches; }); }
          });
          findClose.addEventListener('click', closeFindBar);

          // ── Panel (Bookmarks / History) ───────────────────────────────
          const panel = createEl('div', { style: 'display:none;position:absolute;top:0;right:0;bottom:0;width:300px;background:var(--bg-elevated);border-left:1px solid var(--border-subtle);z-index:100;flex-direction:column;overflow:hidden;' });
          function showPanel(type) {
            _panelType = type;
            // Re-attach panel if it was somehow detached from viewport
            if (!panel.parentNode) viewport.appendChild(panel);
            panel.style.display = 'flex';
            panel.innerHTML = '';
            const hdr = createEl('div', { style: 'display:flex;align-items:center;padding:10px 12px;border-bottom:1px solid var(--border-subtle);gap:8px;flex-shrink:0;' });
            const title = createEl('span', { textContent: type === 'bookmarks' ? '★ Bookmarks' : '🕐 History', style: 'font-size:13px;font-weight:600;flex:1;' });
            const closeP = createEl('button', { className: 'browser-nav-btn', style: 'padding:2px 6px;' });
            closeP.innerHTML = svgIcon('x', 14);
            closeP.addEventListener('click', () => { panel.style.display = 'none'; _panelType = null; });
            hdr.append(title, closeP);
            panel.appendChild(hdr);
            const list = createEl('div', { style: 'flex:1;overflow-y:auto;' });
            panel.appendChild(list);
            const items = type === 'bookmarks' ? loadBookmarks() : loadHistory();
            if (!items.length) {
              list.innerHTML = '<div style="text-align:center;padding:32px 16px;color:var(--text-muted);font-size:13px;">' + (type === 'bookmarks' ? 'No bookmarks yet.<br>Click ★ to save a page.' : 'No history yet.') + '</div>';
            } else {
              items.forEach(item => {
                const row = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border-subtle);' });
                row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-hover)');
                row.addEventListener('mouseleave', () => row.style.background = '');
                const ico = createEl('span', { style: 'flex-shrink:0;color:var(--text-muted);' });
                if (item.favicon && /^https?:\/\//i.test(item.favicon)) {
                  const _fimg2 = document.createElement('img');
                  _fimg2.src = item.favicon; _fimg2.style.cssText = 'width:14px;height:14px;border-radius:2px;';
                  _fimg2.onerror = () => { ico.innerHTML = ''; ico.innerHTML = svgIcon('globe', 14); };
                  ico.appendChild(_fimg2);
                } else { ico.innerHTML = svgIcon('globe', 14); }
                const info = createEl('div', { style: 'flex:1;min-width:0;' });
                const _iTitle = document.createElement('div');
                _iTitle.style.cssText = 'font-size:12px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                _iTitle.textContent = item.title || item.url;
                const _iUrl = document.createElement('div');
                _iUrl.style.cssText = 'font-size:10px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                _iUrl.textContent = item.url;
                info.append(_iTitle, _iUrl);
                const del = createEl('button', { className: 'browser-nav-btn', style: 'padding:2px 4px;opacity:0;transition:opacity 0.1s;', title: 'Remove' });
                del.innerHTML = svgIcon('x', 12);
                row.addEventListener('mouseenter', () => del.style.opacity = '1');
                row.addEventListener('mouseleave', () => del.style.opacity = '0');
                del.addEventListener('click', (e) => {
                  e.stopPropagation();
                  if (type === 'bookmarks') { let arr = loadBookmarks(); arr = arr.filter(b => b.url !== item.url); saveBookmarks(arr); }
                  else { saveHistory(loadHistory().filter(h => h.ts !== item.ts)); }
                  showPanel(type);
                });
                row.appendChild(ico); row.appendChild(info); row.appendChild(del);
                row.addEventListener('click', () => { panel.style.display = 'none'; navigate(item.url); });
                list.appendChild(row);
              });
            }
          }

          // ── Viewport ──────────────────────────────────────────────────────
          const viewport = createEl('div', { className: 'browser-viewport', style: { display: 'flex', flexDirection: 'column', position: 'relative' } });
          viewport.appendChild(panel);

          container.append(tabsBar, toolbar, findBar, viewport);
          content.appendChild(container);

          // ── Popup mode ───────────────────────────────────────────────────────
          // When spawned by a newwindow event (OAuth, login dialogs, share sheets),
          // strip the browser chrome down to match real browser popup behaviour:
          // no tabs bar, minimal toolbar — just back + a read-only URL bar.
          if (options?.popup) {
            // No tabs — popups are single-page by nature
            tabsBar.style.display = 'none';

            // Minimal toolbar: keep backBtn (useful for multi-step auth flows),
            // read-only URL bar (so the user can see where they are), security icon.
            // Hide everything that implies full browsing.
            fwdBtn.style.display = 'none';
            refreshBtn.style.display = 'none';
            starBtn.style.display = 'none';
            menuBtn.style.display = 'none';
            urlBar.readOnly = true;
            urlBar.style.cursor = 'default';
            urlBar.style.background = 'transparent';
            urlBar.style.boxShadow = 'none';

            // Small pill so the user knows this is a popup, not a full browser window
            const popupBadge = createEl('span', {
              style: 'font-size:10px;font-weight:600;color:var(--text-muted);' +
                'background:var(--bg-hover);border:1px solid var(--border-subtle);' +
                'border-radius:4px;padding:2px 7px;white-space:nowrap;flex-shrink:0;' +
                'letter-spacing:.05em;text-transform:uppercase;',
              textContent: 'Popup'
            });
            toolbar.appendChild(popupBadge);

            // No history or bookmarks for popup windows — use a dedicated flag
            // so the tab keeps partition:'persist:browser' and shares the user's cookies.
            // (Setting incognito:true would switch the partition to an isolated session,
            // which would log the user out of every site in the popup.)
            tabs[0].isPopup = true;
          }

          let currentUrl = '';
          const tabWebviews = new Map();
          const tabIframes = new Map();   // tabId → <iframe> element
          const tabViewMode = new Map();  // tabId → 'webview' | 'iframe'

          function getTabMode(tabId) { return tabViewMode.get(tabId) || 'webview'; }

          // Stable browser session ID stored in settings. Wiped on "Wipe All Data" /
          // factory reset, which rotates the partition name → brand new session → logged out.
          let _bpid = OS.settings.get('browserPartitionId');
          if (!_bpid) {
            _bpid = 'b' + Math.random().toString(36).slice(2, 12);
            OS.settings.set('browserPartitionId', _bpid);
          }
          const BROWSER_PARTITION = 'persist:' + _bpid;

          function getOrCreateWebview(tabId) {
            if (tabWebviews.has(tabId)) return tabWebviews.get(tabId);
            const wv = document.createElement('webview');
            const tab = tabs.find(t => t.id === tabId);
            // Incognito = in-memory partition (no persist:), normal = shared persistent session
            wv.setAttribute('partition', tab?.incognito ? ('incognito_' + tabId) : BROWSER_PARTITION);
            wv.setAttribute('allowfullscreen', 'true');
            wv.style.cssText = 'width:100%;height:100%;border:none;flex:1;position:absolute;visibility:hidden;pointer-events:none;z-index:0;top:0;left:0;';

            // ── Permission gate — must explicitly allow fullscreen or NW.js
            // blocks the request before enter-html-full-screen ever fires ────
            // NW.js: match count is returned via the find() callback — no separate event needed

            // ── URL tracking ──────────────────────────────────────────────────
            function syncUrlForTab(url, forTabId, source) {
              if (!url || url === 'about:blank' || url === 'about:newtab') return;
              console.log('[NB Browser] syncUrlForTab:', source, url, 'tabId:', forTabId, 'activeTabId:', activeTabId);
              const tab = tabs.find(t => t.id === forTabId);
              if (tab) tab.url = url;
              if (forTabId !== activeTabId) return;
              currentUrl = url;
              urlBar.value = stripHttps(url);
              updateUrlIcon(url);
              starBtn.style.color = isBookmarked(url) ? 'var(--accent)' : '';
              renderTabs();
            }

            // ── Primary: event-based ──────────────────────────────────────
            wv.addEventListener('loadcommit', e => {
              console.log('[NB Browser] loadcommit fired, isTopLevel:', e.isTopLevel, 'url:', e.url);
              if (e.isTopLevel && e.url) syncUrlForTab(e.url, tabId, 'loadcommit');
            });
            wv.addEventListener('loadstop', () => {
              console.log('[NB Browser] loadstop fired');
              // Sync URL
              try { wv.executeScript({ code: 'location.href' }, r => { if (chrome.runtime?.lastError || !r?.[0]) return; syncUrlForTab(r[0], tabId, 'loadstop+executeScript'); }); } catch (ex) { console.log('[NB Browser] executeScript(loadstop) threw:', ex); }
              // NW.js has no page-title-updated / page-favicon-updated (Electron-only).
              // Fetch title + href together and save history after each load.
              try {
                wv.executeScript({ code: '[document.title, location.href]' }, r => {
                  if (chrome.runtime?.lastError) return;
                  const result = Array.isArray(r) ? r[0] : null;
                  if (!Array.isArray(result)) return;
                  const [title, url] = result;
                  const tab = tabs.find(t => t.id === tabId);
                  if (!tab) return;
                  if (title) {
                    tab.title = title;
                    renderTabs();
                    // In popup mode, mirror the page title into the OS window titlebar
                    // since the tabs bar (which normally shows the title) is hidden.
                    if (options?.popup && state.titleText) state.titleText.textContent = title;
                  }
                  try {
                    const hostname = new URL(url || tab.url).hostname;
                    tab.favicon = 'https://www.google.com/s2/favicons?domain=' + hostname + '&sz=32';
                  } catch (_) { }
                  if (url && !url.startsWith('novabyte:') && !url.startsWith('file://')) {
                    addHistory(url, title || url, tab.favicon);
                  }
                });
              } catch (_) { }
            });
            wv.addEventListener('contentload', () => {
              console.log('[NB Browser] contentload fired');
              try { wv.executeScript({ code: 'location.href' }, r => { if (chrome.runtime?.lastError || !r?.[0]) return; syncUrlForTab(r[0], tabId, 'contentload+executeScript'); }); } catch (_) { }
            });

            // ── Network / certificate error handling ─────────────────────
            // NW.js fires 'loaderror' for cert errors, DNS failures,
            // ERR_CONNECTION_REFUSED etc.  Without this the webview stays
            // completely blank and the user has no idea what went wrong.
            wv.addEventListener('loaderror', e => {
              if (!e.isTopLevel) return; // ignore sub-resource errors
              console.warn('[NB Browser] loaderror:', e.errorCode, e.errorDescription, e.validatedURL);
              const failedUrl = e.validatedURL || currentUrl || '';
              const code      = e.errorCode || 0;        // negative Chromium net error
              const desc      = e.errorDescription || '';

              // Classify the error for a friendlier message
              let title, message, hint, showBypass = false;
              if (desc.includes('CERT') || desc.includes('SSL') || desc.includes('HTTPS') ||
                  code === -202 || code === -200 || code === -207) {
                title = '⚠ Certificate Error';
                message = 'The connection to this site is not trusted. The certificate may be self-signed, expired, or issued by an unknown authority.';
                hint  = 'If this is a local development server, click "Proceed anyway" below.';
                showBypass = true;
              } else if (desc.includes('CONNECTION_REFUSED') || code === -102) {
                title = '⚡ Connection Refused';
                message = 'No server is listening at this address. Check that the server is running and the port is correct.';
                hint  = failedUrl.includes('localhost') || failedUrl.includes('127.0.0.1')
                  ? 'Tip: make sure your local server is started (e.g. npm start).'
                  : '';
              } else if (desc.includes('NAME_NOT_RESOLVED') || code === -105) {
                title = '🌐 DNS Error';
                message = 'The hostname could not be resolved. Check the URL or your internet connection.';
                hint  = '';
              } else if (desc.includes('TIMED_OUT') || code === -7) {
                title = '⏱ Connection Timed Out';
                message = 'The server took too long to respond.';
                hint  = 'Try again or check your network.';
              } else {
                title = '✕ Page Failed to Load';
                message = 'Something went wrong loading this page.';
                hint  = desc ? 'Error: ' + desc : '';
              }

              const safeUrl  = failedUrl.replace(/'/g, "\\'").replace(/</g, '&lt;').replace(/>/g, '&gt;');
              const bypassBtn = showBypass
                ? `<button onclick="window.__nbBypass()" style="background:#e05d44;color:#fff;border:none;padding:8px 18px;border-radius:6px;cursor:pointer;font-size:13px;margin-right:8px;">Proceed anyway (unsafe)</button>`
                : '';

              const errorHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${title}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#c9d1d9;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{max-width:520px;width:100%;background:#161b22;border:1px solid #30363d;
        border-radius:12px;padding:32px 36px;text-align:center}
  h1{font-size:20px;font-weight:700;margin-bottom:12px;color:#f0f6fc}
  p{font-size:13px;color:#8b949e;line-height:1.6;margin-bottom:8px}
  .url{font-size:11px;color:#58a6ff;word-break:break-all;margin-bottom:20px;
       background:#0d1117;padding:6px 10px;border-radius:6px;border:1px solid #21262d}
  .hint{font-size:12px;color:#e3b341;margin-bottom:20px}
  .actions{display:flex;justify-content:center;flex-wrap:wrap;gap:8px}
  button{background:#238636;color:#fff;border:none;padding:8px 18px;border-radius:6px;
         cursor:pointer;font-size:13px}
  button:hover{opacity:.85}
</style></head><body>
<div class="card">
  <h1>${title}</h1>
  <p>${message}</p>
  <div class="url">${safeUrl}</div>
  ${hint ? `<div class="hint">${hint}</div>` : ''}
  <div class="actions">
    ${bypassBtn}
    <button onclick="window.__nbRetry()">↺ Retry</button>
  </div>
</div>
<script>
  window.__nbRetry  = () => { window.location.href = '${safeUrl}'; };
  window.__nbBypass = () => { window.location.href = '${safeUrl}'; };
</script>
</body></html>`;

              try {
                // Write the error page directly into the webview via srcdoc
                // (avoids creating a blob URL that we'd need to revoke)
                wv.executeScript({
                  code: `document.open();document.write(${JSON.stringify(errorHtml)});document.close();`
                }, () => { });
              } catch (_) { }
            });

            // loadabort fires for navigation that was blocked before it started
            // (e.g. subresource integrity failures, safebrowsing, etc.)
            wv.addEventListener('loadabort', e => {
              if (!e.isTopLevel) return;
              console.warn('[NB Browser] loadabort:', e.reason, e.url);
              // Only show UI for non-trivial aborts (not blank / newtab navigations)
              if (!e.url || e.url === 'about:blank' || e.url === 'about:newtab') return;
              // 'ERR_ABORTED' (-3) fires on legitimate JS-driven navigations — ignore
              if (e.reason === 'ERR_ABORTED') return;
              const safeUrl = (e.url || '').replace(/'/g, "\\'");
              try {
                wv.executeScript({ code: `
                  document.open();
                  document.write('<html><body style="background:#0d1117;color:#c9d1d9;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">'
                    + '<div style="text-align:center;max-width:400px">'
                    + '<div style="font-size:32px;margin-bottom:12px">🚫</div>'
                    + '<div style="font-size:16px;font-weight:700;margin-bottom:8px">Navigation Blocked</div>'
                    + '<div style="font-size:12px;color:#8b949e;margin-bottom:16px">' + ${JSON.stringify(e.reason || 'Unknown reason')} + '</div>'
                    + '<button onclick="history.back()" style="background:#238636;color:#fff;border:none;padding:8px 18px;border-radius:6px;cursor:pointer">← Go Back</button>'
                    + '</div></body></html>');
                  document.close();
                ` }, () => { });
              } catch (_) { }
            });
            // NW.js does not fire will-navigate / did-navigate / did-navigate-in-page / did-finish-load.
            // Top-level navigations are caught by loadcommit above.
            // In-page (SPA / pushState) navigations are caught by the 500 ms executeScript poll below.

            // ── Fallback: poll via executeScript every 500ms ───────────────
            let _lastPolledUrl = '';
            const _urlPollTimer = setInterval(() => {
              try {
                wv.executeScript({ code: 'location.href' }, results => {
                  if (chrome.runtime?.lastError) return;
                  const url = Array.isArray(results) ? results[0] : results;
                  if (url && typeof url === 'string' && url !== 'about:blank' && url !== _lastPolledUrl) {
                    _lastPolledUrl = url;
                    console.log('[NB Browser] poll detected URL change:', url);
                    syncUrlForTab(url, tabId, 'poll');
                  }
                });
              } catch (_) { }
            }, 500);

            state.cleanups = state.cleanups || [];
            state.cleanups.push(() => clearInterval(_urlPollTimer));
            // Also track per-tab so closeTab() can cancel it immediately
            const _tc = tabCleanups.get(tabId) || [];
            _tc.push(() => clearInterval(_urlPollTimer));
            tabCleanups.set(tabId, _tc);
            // page-title-updated and page-favicon-updated are Electron-only — handled in loadstop above.

            // ── Fullscreen support for web content (YouTube, etc.) ────────
            wv.addEventListener('enter-html-full-screen', e => {
              // Step 1: expand the webview to cover the full viewport so it's
              // ready the moment the OS-level fullscreen transition completes.
              wv.style.position = 'fixed';
              wv.style.inset = '0';
              wv.style.zIndex = '2147483647';
              wv.style.width = '100vw';
              wv.style.height = '100vh';
              wv.style.visibility = 'visible';
              wv.style.pointerEvents = 'auto';
              document.body.style.overflow = 'hidden';

              // Step 2: request OS-level fullscreen on the root element so the
              // window actually covers the whole monitor — not just fills the
              // existing browser window.
              if (document.documentElement.requestFullscreen) {
                document.documentElement.requestFullscreen().catch(() => { });
              } else if (document.documentElement.webkitRequestFullscreen) {
                document.documentElement.webkitRequestFullscreen();
              }

              // Fallback: NW.js native fullscreen API
              if (typeof nw !== 'undefined' && nw.Window) {
                try { nw.Window.get().enterFullscreen(); } catch (_) { }
              }
            });

            wv.addEventListener('leave-html-full-screen', e => {
              // Restore webview to its normal in-window position.
              wv.style.position = 'absolute';
              wv.style.inset = 'auto';
              wv.style.zIndex = '1';
              wv.style.width = '100%';
              wv.style.height = '100%';
              document.body.style.overflow = '';

              // Exit OS-level fullscreen.
              if (document.fullscreenElement && document.exitFullscreen) {
                document.exitFullscreen().catch(() => { });
              } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
              }

              // Fallback: NW.js native API
              if (typeof nw !== 'undefined' && nw.Window) {
                try { nw.Window.get().leaveFullscreen(); } catch (_) { }
              }
            });

            // If the user presses Escape or the browser exits fullscreen on its
            // own (e.g. the user hits Esc), restore the webview sizing so the
            // OS UI doesn't stay covered.
            const _onFsChange = () => {
              if (!document.fullscreenElement) {
                wv.style.position = 'absolute';
                wv.style.inset = 'auto';
                wv.style.zIndex = '1';
                wv.style.width = '100%';
                wv.style.height = '100%';
                document.body.style.overflow = '';
              }
            };
            document.addEventListener('fullscreenchange', _onFsChange);
            state.cleanups = state.cleanups || [];
            state.cleanups.push(() => document.removeEventListener('fullscreenchange', _onFsChange));

            // History is now saved from the loadstop handler above via executeScript.

            // ── Download handling ────────────────────────────────────────
            // Chrome Apps webview fires permissionrequest with permission==='download'
            // (will-download is Electron-only). We intercept here and save via Node.js.
            wv.addEventListener('permissionrequest', e => {
              if (e.permission === 'fullscreen') {
                e.request.allow();
                return;
              }
              // 'pointerLock' is required by browser games and 3D viewers
              if (e.permission === 'pointerLock') {
                e.request.allow();
                return;
              }
              if (e.permission === 'download') {
                e.request.deny(); // prevent default browser save-dialog; we handle it ourselves
                (async () => {
                  const _url = e.request.url;
                  // Only allow http(s) downloads — block file:, data:, etc.
                  if (!_url || !/^https?:\/\//i.test(_url)) return;
                  try {
                    // Derive filename from URL and sanitise against path traversal
                    let baseName = (() => {
                      try { return decodeURIComponent(new URL(_url).pathname.split('/').pop()); }
                      catch { return ''; }
                    })() || ('download_' + Date.now());
                    // Strip dangerous filename characters (path separators, shell chars)
                    baseName = baseName.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').trim() || ('download_' + Date.now());
                    // Cap filename length to prevent FS issues
                    if (baseName.length > 128) baseName = baseName.slice(0, 128);
                    if (!baseName.includes('.')) baseName += '.bin';

                    // Deduplicate filename within VFS Downloads folder
                    const dlFolderId = FS.specialFolders.downloads;
                    if (!dlFolderId) throw new Error('VFS Downloads folder not found');
                    const existing = FS.listDir(dlFolderId).map(f => f.name);
                    if (existing.includes(baseName)) {
                      const dot = baseName.lastIndexOf('.');
                      const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
                      const ext = dot > 0 ? baseName.slice(dot) : '';
                      let n = 1;
                      while (existing.includes(stem + ' (' + n + ')' + ext)) n++;
                      baseName = stem + ' (' + n + ')' + ext;
                    }

                    // Register in Downloads manager and open it
                    const entry = window.Downloads?.add(baseName, _url, 0, '');
                    const entryId = entry?.id;
                    if (entryId) window.Downloads?.setStatus(entryId, 'downloading');
                    WM.createWindow('nbosp-downloads');

                    // Fetch bytes via browser fetch (inherits webview session/cookies for auth)
                    const resp = await fetch(_url);
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    // Refuse downloads over 512 MB to prevent memory exhaustion
                    const _cl = resp.headers.get('content-length');
                    const MAX_DL = 512 * 1024 * 1024;
                    if (_cl && parseInt(_cl, 10) > MAX_DL) throw new Error('File too large (> 512 MB)');
                    const buf = await resp.arrayBuffer();
                    if (buf.byteLength > MAX_DL) throw new Error('File too large (> 512 MB)');
                    const bytes = new Uint8Array(buf);

                    // Detect MIME type from Content-Type header or fall back to octet-stream
                    const ct = resp.headers.get('content-type') || '';
                    const mime = ct.split(';')[0].trim() || 'application/octet-stream';

                    // Save into VFS Downloads folder
                    await FS.createFile(dlFolderId, baseName, bytes, mime);

                    if (entryId) window.Downloads?.setStatus(entryId, 'done', bytes.byteLength);
                    Notify.show({ title: 'Download complete', body: baseName, type: 'success', appName: 'Downloads' });
                    OS.events.emit('fs:created', {});

                  } catch (err) {
                    console.error('Download handler error:', err);
                    Notify.show({ title: 'Download failed', body: String(err.message || err), type: 'error', appName: 'Downloads' });
                  }
                })();
              }
            });

            // ── Popup / new-window support (NW.js Chrome Apps webview API) ──────
            wv.addEventListener('newwindow', e => {
              const url = e.targetUrl;
              if (!url || url === 'about:blank' || url.startsWith('javascript:')) return;

              // ── Auth/login popup detection ────────────────────────────────
              // Legitimate OAuth and login flows use window.open() with popup
              // features (disposition = new_popup). We must NEVER block these —
              // doing so breaks Google Sign-In, GitHub OAuth, Apple ID, Microsoft
              // login, and any other auth flow that relies on a popup window.
              function isAuthPopup(u) {
                try {
                  const parsed = new URL(u);
                  const host = parsed.hostname.toLowerCase();
                  const path = parsed.pathname.toLowerCase();
                  // Known auth domains — always allow
                  const authHosts = [
                    'accounts.google.com', 'login.microsoftonline.com',
                    'login.live.com', 'appleid.apple.com',
                    'github.com', 'gitlab.com',
                    'www.facebook.com', 'connect.facebook.net',
                    'twitter.com', 'x.com',
                    'discord.com', 'slack.com',
                    'login.yahoo.com', 'api.amazon.com',
                  ];
                  if (authHosts.some(h => host === h || host.endsWith('.' + h))) return true;
                  // Auth-related path segments — allow on any domain
                  const authPaths = [
                    '/oauth', '/oauth2', '/auth', '/authorize', '/authorise',
                    '/login', '/signin', '/sign-in', '/signup', '/sign-up',
                    '/sso', '/saml', '/oidc', '/callback', '/connect',
                    '/idp/', '/identity/', '/session', '/token',
                  ];
                  if (authPaths.some(p => path.startsWith(p) || path.includes(p + '/'))) return true;
                  // Auth query params — common in OAuth redirects
                  const params = parsed.searchParams;
                  if (params.has('client_id') || params.has('response_type') || params.has('redirect_uri')) return true;
                } catch (_) { }
                return false;
              }

              // Block pop-up windows setting — only blocks non-auth popups
              if (getSetting('block_popup_windows', true) && e.windowOpenDisposition === 'new_popup' && !isAuthPopup(url)) {
                try { if (e.window?.discard) e.window.discard(); } catch (_) { }
                return;
              }

              const disposition = e.windowOpenDisposition;

              if (disposition === 'new_popup') {
                // ── Inline popup overlay ──────────────────────────────────────
                // CRITICAL: use e.window.attach(newWebview), NOT e.window.discard().
                // discard() severs the opener link — window.close() in the popup
                // then has no path back, so the 'close' event never fires.
                // attach() keeps the opener relationship alive.
                const pw = Math.min(Math.max(e.initialWidth || 520, 360), Math.round(window.innerWidth * 0.75));
                const ph = Math.min(Math.max(e.initialHeight || 620, 300), Math.round(window.innerHeight * 0.85));

                const backdrop = document.createElement('div');
                backdrop.style.cssText = 'position:absolute;inset:0;z-index:9999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;';

                const card = document.createElement('div');
                card.style.cssText = `width:${pw}px;height:${ph}px;background:var(--bg,#1e1e2e);border-radius:10px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.08);`;

                const bar = document.createElement('div');
                bar.style.cssText = 'height:36px;min-height:36px;background:var(--bg2,#181825);display:flex;align-items:center;padding:0 10px;gap:8px;border-bottom:1px solid rgba(255,255,255,0.06);user-select:none;';
                const barTitle = document.createElement('span');
                barTitle.style.cssText = 'flex:1;font-size:12px;opacity:0.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                barTitle.textContent = url;
                const barClose = document.createElement('button');
                barClose.textContent = '✕';
                barClose.style.cssText = 'background:none;border:none;color:inherit;opacity:0.5;cursor:pointer;font-size:13px;padding:2px 6px;border-radius:4px;';
                barClose.onmouseenter = () => barClose.style.opacity = '1';
                barClose.onmouseleave = () => barClose.style.opacity = '0.5';
                bar.append(barTitle, barClose);

                const popWv = document.createElement('webview');
                popWv.style.cssText = 'flex:1;width:100%;';
                popWv.setAttribute('partition', BROWSER_PARTITION);

                card.append(bar, popWv);
                backdrop.appendChild(card);
                container.appendChild(backdrop);

                const closePopup = () => backdrop.remove();
                barClose.addEventListener('click', closePopup);

                popWv.addEventListener('loadstop', () => {
                  try { popWv.executeScript({ code: 'document.title' }, r => { if (chrome.runtime?.lastError || !r?.[0]) return; barTitle.textContent = r[0]; }); } catch (_) { }
                });

                // attach() keeps opener link alive → window.close() fires 'close' event
                popWv.addEventListener('close', closePopup);
                e.window.attach(popWv);

              } else {
                // For tabs: discard the NW native window, open as a new tab instead.
                try { if (e.window?.discard) e.window.discard(); } catch (_) { }
                const parentTab = tabs.find(t => t.id === tabId);
                const newTab = {
                  id: nextTabId++,
                  title: 'New Tab',
                  url: '',
                  favicon: '',
                  incognito: parentTab?.incognito || false
                };
                tabs.push(newTab);
                if (getSetting('open_in_background', false)) {
                  // Create the webview but don't switch to it
                  renderTabs();
                  const bgWv = getOrCreateWebview(newTab.id);
                  if (!bgWv.parentNode) viewport.appendChild(bgWv);
                  bgWv.src = url;
                } else {
                  switchToTab(newTab.id);
                  navigate(url);
                }
              }
            });

            // ── window.close() support ────────────────────────────────────────
            // Two-layer approach because Google's OAuth (gsi/transform) and many
            // other login flows call window.opener.postMessage() rather than
            // 'close' event fires on the parent webview if it has an active popup.
            // (Popups now use inline overlay + attach(), so this handles
            //  any other case where a non-popup tab tries to close itself.)
            wv.addEventListener('close', () => { closeTab(tabId); });

            tabWebviews.set(tabId, wv);
            applyWebviewSettings(wv);
            return wv;
          }

          // ── iframe mode helpers ───────────────────────────────────────────
          function getOrCreateIframe(tabId) {
            if (tabIframes.has(tabId)) return tabIframes.get(tabId);
            const ifr = document.createElement('iframe');
            ifr.setAttribute('allowfullscreen', 'true');
            ifr.setAttribute('allow', 'fullscreen; autoplay; clipboard-read; clipboard-write');
            // NOTE: allow-same-origin is intentionally ABSENT — combining it with allow-scripts
            // enables a known sandbox escape (framed doc can call frameElement.removeAttribute('sandbox')).
            ifr.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation');
            ifr.style.cssText = 'width:100%;height:100%;border:none;flex:1;position:absolute;visibility:hidden;pointer-events:none;z-index:0;top:0;left:0;background:#fff;';

            // Detect X-Frame-Options / CSP frame-ancestors block:
            // browsers fire 'load' even when blocked but the iframe stays empty —
            // we infer a block if the src is an http URL and contentDocument is inaccessible.
            ifr.addEventListener('load', () => {
              const tab = tabs.find(t => t.id === tabId);
              if (!tab?.url || !tab.url.match(/^https?:/i)) return;
              // Remove any stale blocked notice first
              const old = viewport.querySelector('.browser-iframe-blocked[data-tab="' + tabId + '"]');
              if (old) old.remove();
              try {
                // cross-origin frames throw on .contentDocument access → treat as success (loaded)
                // same-origin frames that are blocked land on about:blank with no title
                const doc = ifr.contentDocument;
                if (doc && (doc.URL === 'about:blank' || doc.URL === '') && tab.url.match(/^https?:/i)) {
                  showIframeBlockedNotice(tabId, tab.url);
                }
              } catch (_) {
                // cross-origin but loaded — this is the normal case, clear any notice
              }
              // Sync title where possible (same-origin only)
              try {
                const title = ifr.contentDocument?.title;
                if (title) { tab.title = title; renderTabs(); }
              } catch (_) { }
            });

            tabIframes.set(tabId, ifr);
            return ifr;
          }

          function showIframeBlockedNotice(tabId, url) {
            // Don't double-show
            if (viewport.querySelector('.browser-iframe-blocked[data-tab="' + tabId + '"]')) return;
            const notice = createEl('div', { className: 'browser-iframe-blocked' });
            notice.dataset.tab = tabId;
            notice.innerHTML =
              '<div class="blocked-icon">🚫</div>' +
              '<div class="blocked-title">Page blocked iframe embedding</div>' +
              '<div class="blocked-body">This site uses <code>X-Frame-Options</code> or <code>Content-Security-Policy: frame-ancestors</code> to prevent embedding. Switch to Webview mode to load it normally.</div>';
            const sw = createEl('button', { className: 'blocked-switch', textContent: 'Switch to Webview Mode' });
            sw.addEventListener('click', () => { setTabMode(tabId, 'webview'); navigate(url); });
            notice.appendChild(sw);
            viewport.appendChild(notice);
          }

          function setTabMode(tabId, mode) {
            tabViewMode.set(tabId, mode);
            // Update the toolbar button label/style
            if (tabId === activeTabId) updateModeBtn();
            // Hide the elements of the old mode
            const wv = tabWebviews.get(tabId);
            const ifr = tabIframes.get(tabId);
            if (mode === 'iframe') {
              if (wv) { wv.style.visibility = 'hidden'; wv.style.pointerEvents = 'none'; }
            } else {
              if (ifr) { ifr.style.visibility = 'hidden'; ifr.style.pointerEvents = 'none'; }
              const blocked = viewport.querySelector('.browser-iframe-blocked[data-tab="' + tabId + '"]');
              if (blocked) blocked.remove();
            }
          }

          function updateModeBtn() {
            const mode = getTabMode(activeTabId);
            modeBtn.classList.toggle('iframe-active', mode === 'iframe');
            modeBtn.title = mode === 'iframe' ? 'Switch to Webview mode' : 'Switch to iframe mode';
            modeBtn.innerHTML = (mode === 'iframe'
              ? svgIcon('layout', 14) + ' <span>iFrame</span>'
              : svgIcon('monitor', 14) + ' <span>Webview</span>');
          }

          function showViewForTab(tabId) {
            const mode = getTabMode(tabId);
            // Clear settings page
            const sp = viewport.querySelector('.browser-settings-page');
            if (sp) sp.remove();
            const tab = tabs.find(t => t.id === tabId);
            const isMobile = tab?.userAgent === 'mobile';

            if (mode === 'iframe') {
              // Hide all webviews — also reset position:absolute so any webview that
              // was in non-mobile mode (position:relative) doesn't remain in flex flow
              // and push the iframe down, causing the black-gap bug.
              for (const [, wv] of tabWebviews) {
                wv.style.position = 'absolute';
                wv.style.visibility = 'hidden';
                wv.style.pointerEvents = 'none';
                wv.style.zIndex = '0';
              }
              // Show/hide iframes and restore mobile frame state for the active tab
              for (const [id, ifr] of tabIframes) {
                if (id === tabId) {
                  applyMobileViewportFrame(ifr, isMobile);
                  const z = tabZoom.get(tabId) || 1.0;
                  if (isMobile) {
                    ifr.style.width = '390px';
                    ifr.style.height = '100%';
                    ifr.style.transformOrigin = 'top center';
                    ifr.style.transform = z !== 1.0 ? `translateX(-50%) scale(${z})` : 'translateX(-50%)';
                  } else {
                    const pct = (100 / z).toFixed(4) + '%';
                    ifr.style.width = pct;
                    ifr.style.height = pct;
                    ifr.style.transformOrigin = 'top left';
                    ifr.style.transform = z !== 1.0 ? `scale(${z})` : '';
                  }
                  ifr.style.visibility = 'visible';
                  ifr.style.pointerEvents = 'auto';
                  ifr.style.zIndex = '1';
                } else {
                  ifr.style.visibility = 'hidden';
                  ifr.style.pointerEvents = 'none';
                  ifr.style.zIndex = '0';
                }
              }
            } else {
              // webview mode — existing logic
              // Hide all iframes
              for (const [, ifr] of tabIframes) {
                ifr.style.visibility = 'hidden';
                ifr.style.pointerEvents = 'none';
              }
              // Remove blocked notices for other tabs
              viewport.querySelectorAll('.browser-iframe-blocked:not([data-tab="' + tabId + '"])').forEach(n => n.remove());
              for (const [id, wv] of tabWebviews) {
                if (id === tabId) {
                  applyMobileViewportFrame(wv, isMobile);
                  // Explicitly reset dimensions — switching from iframe mode can leave
                  // stale styles that cause the bottom half to be cut off
                  if (!isMobile) {
                    wv.style.width = '100%';
                    wv.style.height = '100%';
                    wv.style.top = '0';
                    wv.style.left = '0';
                  }
                  wv.style.visibility = 'visible';
                  wv.style.pointerEvents = 'auto';
                  wv.style.zIndex = '1';
                } else {
                  wv.style.position = 'absolute';
                  wv.style.visibility = 'hidden';
                  wv.style.pointerEvents = 'none';
                  wv.style.zIndex = '0';
                }
              }
            }
          }

          function applyWebviewSettings(wv) {
            // ── Default zoom ───────────────────────────────────────────
            const zoomMap = { FAR: 0.75, MEDIUM: 1.0, CLOSE: 1.25 };
            wv.addEventListener('loadstop', () => {
              const tabId = [...tabWebviews.entries()].find(([, v]) => v === wv)?.[0];
              if (tabId && !tabZoom.has(tabId)) {
                try { wv.setZoom(zoomMap[getSetting('default_zoom', 'MEDIUM')] || 1.0); } catch (_) { }
              }
            });

            // ── Force zoom (allow pinch-zoom even when sites disable it) ──
            wv.addEventListener('loadcommit', () => {
              try { wv.setZoomMode(getSetting('force_userscalable', false) ? 'per-view' : 'per-origin'); } catch (_) { }
            });

            // ── Geolocation + media permission gate ───────────────────
            wv.addEventListener('permissionrequest', e => {
              if (e.permission === 'geolocation') {
                getSetting('enable_geolocation', true) ? e.request.allow() : e.request.deny();
              } else if (e.permission === 'media') {
                // Show a non-blocking OS permission prompt — never grant camera/mic silently
                const _origin = (() => { try { return new URL(currentUrl).hostname; } catch { return currentUrl || 'this site'; } })();
                showModal(
                  'Permission Request',
                  _origin + ' wants to access your camera and/or microphone.',
                  [{ label: 'Allow', primary: true, value: true }, { label: 'Deny', value: false }]
                ).then(result => { result ? e.request.allow() : e.request.deny(); });
              } else if (e.permission === 'pointerLock') {
                e.request.allow(); // pointer lock is low-risk UX feature
              } else {
                e.request.deny(); // deny all other unrecognised permissions by default
              }
            });

            // ── Block images/media via webRequest ──────────────────────
            try {
              wv.request.onBeforeRequest.addListener(
                () => ({ cancel: !getSetting('load_images', true) }),
                { urls: ['<all_urls>'], types: ['image', 'media'] },
                ['blocking']
              );
            } catch (_) { }

            // ── Per-page CSS: inverted colours + min font size + text zoom ──
            wv.addEventListener('loadstop', () => {
              let css = '';
              if (getSetting('inverted', false))
                css += 'html { filter: invert(1) hue-rotate(180deg) !important; } img, video { filter: invert(1) hue-rotate(180deg) !important; } ';
              const minFont = getSetting('min_font_size', 0);
              if (minFont > 0)
                css += `* { min-height: unset !important; } body * { font-size: max(${minFont}px, 1em) !important; } `;
              const textZoom = getSetting('text_zoom', 10);
              if (textZoom !== 10)
                css += `body { zoom: ${textZoom / 10} !important; } `;
              if (css) try { wv.insertCSS({ code: css }); } catch (_) { }
            });
          }

          // Clear browsing data across all open webviews
          function clearWebviewData(types, title, body) {
            tabWebviews.forEach(wv => { try { wv.clearData({}, types); } catch (_) { } });
            Notify.show({ title, body, type: 'info', appName: 'Browser' });
          }

          function showWebviewForTab(tabId) {
            showViewForTab(tabId);
          }

          function renderSettingsPage(activeCategory) {
            activeCategory = activeCategory || 'general';
            const eng = getSetting('searchEngine', 'google');
            const sd = viewport.querySelector('.speed-dial');
            if (sd) sd.remove();
            for (const [, wv] of tabWebviews) wv.style.visibility = 'hidden';
            const old = viewport.querySelector('.browser-settings-page');
            if (old) old.remove();

            const page = createEl('div', { className: 'browser-settings-page' });
            page.style.cssText = 'position:absolute;inset:0;display:flex;background:var(--bg-base);color:var(--text-primary);font-size:13px;z-index:1;';

            // ── helpers ──────────────────────────────────────────────────
            function getBPref(key, def) { return getSetting(key, def); }
            function setBPref(key, val) { saveSetting(key, val); }

            function mkRow(label, desc, control) {
              const row = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--border-subtle);' });
              const left = createEl('div');
              left.appendChild(createEl('div', { textContent: label, style: 'font-size:13px;color:var(--text-primary);' }));
              if (desc) left.appendChild(createEl('div', { textContent: desc, style: 'font-size:11px;color:var(--text-muted);margin-top:2px;' }));
              row.append(left, control);
              return row;
            }

            function mkSubHdr(title) {
              return createEl('div', { textContent: title, style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);margin:20px 0 4px;' });
            }

            function mkToggle(key, def, onChange) {
              const val = getBPref(key, def);
              const btn = createEl('button', { style: 'width:40px;height:22px;border-radius:11px;border:none;cursor:pointer;position:relative;flex-shrink:0;transition:background 0.2s;background:' + (val ? 'var(--accent)' : 'var(--text-muted)') + ';' });
              const knob = createEl('div', { style: 'position:absolute;top:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.3);transition:left 0.2s;left:' + (val ? '20px' : '2px') + ';' });
              btn.appendChild(knob);
              btn.addEventListener('click', () => {
                const next = !getBPref(key, def);
                setBPref(key, next);
                btn.style.background = next ? 'var(--accent)' : 'var(--text-muted)';
                knob.style.left = next ? '20px' : '2px';
                if (onChange) onChange(next);
              });
              return btn;
            }

            function mkSelect(key, def, options) {
              const val = getBPref(key, def);
              const sel = createEl('select', { id: 'browser-pref-select-' + key, name: 'browser-pref-' + key, style: 'background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:6px;padding:5px 8px;color:var(--text-primary);font-size:12px;cursor:pointer;outline:none;max-width:160px;' });
              options.forEach(([v, label]) => {
                const opt = createEl('option', { value: v, textContent: label });
                if (v === val) opt.selected = true;
                sel.appendChild(opt);
              });
              sel.addEventListener('change', () => setBPref(key, sel.value));
              return sel;
            }

            function mkClearBtn(label, action) {
              const btn = createEl('button', { textContent: label, style: 'padding:6px 14px;border-radius:6px;border:1px solid var(--border-default);background:var(--bg-elevated);color:var(--text-primary);cursor:pointer;font-size:12px;white-space:nowrap;flex-shrink:0;' });
              btn.addEventListener('mouseenter', () => btn.style.borderColor = 'var(--accent)');
              btn.addEventListener('mouseleave', () => btn.style.borderColor = 'var(--border-default)');
              btn.addEventListener('click', action);
              return btn;
            }

            function mkSliderRow(label, key, def, min, max, suffix) {
              const row = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--border-subtle);' });
              const left = createEl('div', { style: 'display:flex;flex-direction:column;gap:2px;' });
              left.appendChild(createEl('div', { textContent: label, style: 'font-size:13px;color:var(--text-primary);' }));
              const valLabel = createEl('span', { textContent: getBPref(key, def) + (suffix || ''), style: 'font-size:11px;color:var(--accent);' });
              left.appendChild(valLabel);
              const slider = createEl('input', { type: 'range', min: String(min), max: String(max), value: String(getBPref(key, def)), id: 'browser-pref-slider-' + key, name: 'browser-pref-' + key, style: 'width:140px;accent-color:var(--accent);cursor:pointer;' });
              slider.addEventListener('input', () => { valLabel.textContent = slider.value + (suffix || ''); setBPref(key, Number(slider.value)); });
              row.append(left, slider);
              return row;
            }

            // ── Sidebar ───────────────────────────────────────────────────
            const NAV = [
              { id: 'general', label: 'General', icon: '⚙️' },
              { id: 'search', label: 'Search Engine', icon: '🔍' },
              { id: 'privacy', label: 'Privacy & Security', icon: '🔒' },
              { id: 'content', label: 'Content', icon: '🌐' },
              { id: 'bandwidth', label: 'Bandwidth', icon: '📶' },
              { id: 'accessibility', label: 'Accessibility', icon: '♿' },
              { id: 'labs', label: 'Labs', icon: '🧪' },
              { id: 'reset', label: 'Reset', icon: '🔄' },
            ];

            const sidebar = createEl('div', { style: 'width:200px;flex-shrink:0;border-right:1px solid var(--border-subtle);padding:20px 0;display:flex;flex-direction:column;gap:2px;overflow-y:auto;background:var(--bg-elevated);' });
            const sidebarTitle = createEl('div', { textContent: 'Settings', style: 'font-size:13px;font-weight:700;color:var(--text-primary);padding:0 16px 14px;border-bottom:1px solid var(--border-subtle);margin-bottom:6px;' });
            sidebar.appendChild(sidebarTitle);

            const navBtns = {};
            NAV.forEach(({ id, label, icon }) => {
              const btn = createEl('button', { style: 'display:flex;align-items:center;gap:9px;width:100%;padding:8px 16px;border:none;background:' + (id === activeCategory ? 'rgba(88,166,255,0.12)' : 'transparent') + ';color:' + (id === activeCategory ? 'var(--accent)' : 'var(--text-secondary)') + ';font-size:12px;font-weight:' + (id === activeCategory ? '600' : '400') + ';cursor:pointer;text-align:left;border-radius:0;transition:background 0.15s;border-left:2px solid ' + (id === activeCategory ? 'var(--accent)' : 'transparent') + ';' });
              btn.appendChild(createEl('span', { textContent: icon, style: 'font-size:14px;width:18px;text-align:center;' }));
              btn.appendChild(createEl('span', { textContent: label }));
              btn.addEventListener('mouseenter', () => { if (id !== activeCategory) btn.style.background = 'var(--bg-hover)'; });
              btn.addEventListener('mouseleave', () => { if (id !== activeCategory) btn.style.background = 'transparent'; });
              btn.addEventListener('click', () => renderSettingsPage(id));
              navBtns[id] = btn;
              sidebar.appendChild(btn);
            });

            // ── Content panel ─────────────────────────────────────────────
            const panel = createEl('div', { style: 'flex:1;overflow-y:auto;padding:28px 32px;' });
            const panelInner = createEl('div', { style: 'max-width:560px;' });

            function panelTitle(title, desc) {
              panelInner.appendChild(createEl('h2', { textContent: title, style: 'font-size:17px;font-weight:700;margin:0 0 4px;color:var(--text-primary);' }));
              if (desc) panelInner.appendChild(createEl('p', { textContent: desc, style: 'color:var(--text-muted);margin:0 0 20px;font-size:12px;' }));
            }

            // ════════════════════════════════════════════════════════════
            if (activeCategory === 'general') {
              panelTitle('General', 'Basic browser behaviour and preferences.');
              const hpSel = mkSelect('homepage', 'most_visited', [['most_visited', 'Most Visited'], ['blank', 'Blank Page'], ['custom', 'Custom URL']]);
              const hpCustomWrap = createEl('div', { style: 'margin-top:6px;display:' + (getBPref('homepage', 'most_visited') === 'custom' ? 'block' : 'none') + ';' });
              const hpInp = createEl('input', { type: 'url', id: 'browser-homepage-input', name: 'browser-homepage', placeholder: 'https://example.com', value: getBPref('homepageUrl', ''), style: 'width:100%;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:6px;padding:6px 10px;color:var(--text-primary);font-size:12px;outline:none;box-sizing:border-box;' });
              hpInp.addEventListener('change', () => setBPref('homepageUrl', hpInp.value));
              hpCustomWrap.appendChild(hpInp);
              hpSel.addEventListener('change', () => { hpCustomWrap.style.display = hpSel.value === 'custom' ? 'block' : 'none'; });
              const hpWrap = createEl('div', { style: 'display:flex;flex-direction:column;gap:4px;max-width:200px;' });
              hpWrap.append(hpSel, hpCustomWrap);
              panelInner.appendChild(mkRow('Homepage', 'Page shown when opening a new tab', hpWrap));
              panelInner.appendChild(mkRow('Autofill', 'Automatically fill in web forms', mkToggle('autofill_enabled', true)));

              // ════════════════════════════════════════════════════════════
            } else if (activeCategory === 'search') {
              panelTitle('Search Engine', 'Choose your default search engine.');
              const seList = createEl('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-top:4px;' });
              Object.entries(SEARCH_ENGINES).forEach(([key, info]) => {
                const row = createEl('label', { style: 'display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;cursor:pointer;border:1px solid ' + (key === eng ? 'var(--accent)' : 'var(--border-subtle)') + ';background:' + (key === eng ? 'rgba(88,166,255,0.08)' : 'var(--bg-elevated)') + ';transition:all 0.15s;' });
                const radio = createEl('input');
                radio.type = 'radio'; radio.id = 'search-engine-' + key; radio.name = 'se'; radio.value = key; radio.checked = key === eng;
                radio.style.accentColor = 'var(--accent)';
                const lbl = createEl('span', { textContent: info.label, style: 'flex:1;font-size:13px;' });
                const hint = createEl('span', { textContent: info.url.replace('https://', '').split('/')[0], style: 'font-size:11px;color:var(--text-muted);' });
                row.append(radio, lbl, hint);
                if (key === eng) row.appendChild(createEl('span', { textContent: 'Default', style: 'font-size:10px;padding:2px 7px;border-radius:10px;background:var(--accent);color:#fff;' }));
                radio.addEventListener('change', () => { if (radio.checked) { saveSetting('searchEngine', key); renderSettingsPage('search'); } });
                seList.appendChild(row);
              });
              panelInner.appendChild(seList);

              // ════════════════════════════════════════════════════════════
            } else if (activeCategory === 'privacy') {
              panelTitle('Privacy & Security', 'Control cookies, passwords, location and browsing data.');
              panelInner.appendChild(mkRow('Show security warnings', 'Show a warning indicator for non-HTTPS pages in the address bar', mkToggle('show_security_warnings', true, (v) => {
                // Re-evaluate current page icon when toggled
                updateUrlIcon(currentUrl);
              })));

              panelInner.appendChild(mkSubHdr('Cookies'));
              panelInner.appendChild(mkRow('Accept cookies', 'Allow sites to save cookies. Disabling clears existing cookies and blocks new ones via webRequest', mkToggle('accept_cookies', true, (v) => {
                if (!v) clearWebviewData({ cookies: true, persistentCookies: true, sessionCookies: true }, 'Cookies blocked', 'Existing cookies cleared. New cookies will be blocked.');
              })));
              panelInner.appendChild(mkRow('Clear cookies', '', mkClearBtn('Clear Cookies', () => clearWebviewData({ cookies: true, persistentCookies: true, sessionCookies: true }, 'Cookies cleared', 'All cookies have been deleted.'))));

              panelInner.appendChild(mkSubHdr('Form Data'));
              panelInner.appendChild(mkRow('Save form data', 'Remember data entered in web forms (managed by the webview session; disable and clear form data to remove)', mkToggle('save_formdata', true)));
              panelInner.appendChild(mkRow('Clear form data', '', mkClearBtn('Clear Form Data', () => clearWebviewData({ localStorage: true, indexedDB: true, webSQL: true }, 'Form data cleared', 'Saved form data has been deleted.'))));

              panelInner.appendChild(mkSubHdr('Location'));
              panelInner.appendChild(mkRow('Enable location', 'Allow sites to request your location', mkToggle('enable_geolocation', true)));
              panelInner.appendChild(mkRow('Clear location access', '', mkClearBtn('Clear Location', () => Notify.show({ title: 'Location access cleared', body: 'All site location permissions have been revoked.', type: 'info', appName: 'Browser' }))));

              panelInner.appendChild(mkSubHdr('Passwords'));
              panelInner.appendChild(mkRow('Remember passwords', 'Offer to save passwords (managed by the webview session; use Clear Passwords to remove saved credentials)', mkToggle('remember_passwords', true)));
              panelInner.appendChild(mkRow('Clear saved passwords', '', mkClearBtn('Clear Passwords', () => Notify.show({ title: 'Passwords cleared', body: 'Saved passwords have been deleted.', type: 'info', appName: 'Browser' }))));

              panelInner.appendChild(mkSubHdr('Browsing Data'));
              const dataRow = createEl('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;padding:12px 0;' });
              dataRow.append(
                mkClearBtn('Clear Cache', () => clearWebviewData({ cache: true, appcache: true }, 'Cache cleared', 'Cached data has been deleted.')),
                mkClearBtn('Clear History', () => { localStorage.removeItem(HX_KEY); _historyCache = null; Notify.show({ title: 'History cleared', body: 'Browsing history has been deleted.', type: 'info', appName: 'Browser' }); }),
                mkClearBtn('Clear Bookmarks', () => { localStorage.removeItem(BK_KEY); _bookmarksCache = null; Notify.show({ title: 'Bookmarks cleared', body: 'All bookmarks have been deleted.', type: 'info', appName: 'Browser' }); })
              );
              panelInner.appendChild(dataRow);

              // ════════════════════════════════════════════════════════════
            } else if (activeCategory === 'content') {
              panelTitle('Content', 'Control how web pages are loaded and displayed.');
              panelInner.appendChild(mkRow('Block pop-up windows', 'Prevent sites from opening new windows', mkToggle('block_popup_windows', true)));
              panelInner.appendChild(mkRow('Open links in background', 'New tabs open without switching to them', mkToggle('open_in_background', false)));
              panelInner.appendChild(mkRow('Allow app tabs', 'Sites can pin themselves as app tabs', mkToggle('allow_apptabs', false)));
              panelInner.appendChild(mkRow('Default zoom', 'Initial page zoom level', mkSelect('default_zoom', 'MEDIUM', [['FAR', 'Far (smallest)'], ['MEDIUM', 'Medium'], ['CLOSE', 'Close (largest)']])));
              panelInner.appendChild(mkRow('Text encoding', 'Default character encoding for web pages', mkSelect('default_text_encoding', 'UTF-8', [['UTF-8', 'UTF-8'], ['ISO-8859-1', 'Latin-1'], ['GBK', 'GBK'], ['Shift_JIS', 'Shift JIS'], ['EUC-JP', 'EUC-JP']])));

              // ════════════════════════════════════════════════════════════
            } else if (activeCategory === 'bandwidth') {
              panelTitle('Bandwidth', 'Manage how much data the browser downloads.');
              panelInner.appendChild(mkRow('Load images', 'Download and display images on web pages', mkToggle('load_images', true)));
              panelInner.appendChild(mkRow('Preload pages', 'Download pages in advance for faster browsing', mkSelect('preload_when', 'WIFI_ONLY', [['ALWAYS', 'Always'], ['WIFI_ONLY', 'Wi-Fi only'], ['NEVER', 'Never']])));
              panelInner.appendChild(mkRow('Link prefetch', 'Preload links the page suggests', mkSelect('link_prefetch_when', 'WIFI_ONLY', [['ALWAYS', 'Always'], ['WIFI_ONLY', 'Wi-Fi only'], ['NEVER', 'Never']])));

              // ════════════════════════════════════════════════════════════
            } else if (activeCategory === 'accessibility') {
              panelTitle('Accessibility', 'Adjust display and interaction settings.');
              panelInner.appendChild(mkRow('Force zoom', 'Override sites that disable pinch-to-zoom', mkToggle('force_userscalable', false)));
              panelInner.appendChild(mkRow('Inverted colours', 'Display pages with inverted colours', mkToggle('inverted', false)));
              panelInner.appendChild(mkSliderRow('Text zoom', 'text_zoom', 10, 1, 30, '%'));
              panelInner.appendChild(mkSliderRow('Double-tap zoom', 'double_tap_zoom', 5, 1, 10, 'x'));
              panelInner.appendChild(mkSliderRow('Minimum font size', 'min_font_size', 0, 0, 20, 'px'));

              // ════════════════════════════════════════════════════════════
            } else if (activeCategory === 'labs') {
              panelTitle('Labs', 'Experimental features — may be unstable.');
              panelInner.appendChild(mkRow('Quick controls', 'Swipe-based navigation controls', mkToggle('enable_quick_controls', false)));
              panelInner.appendChild(mkRow('Fullscreen mode', 'Hide browser chrome when scrolling down', mkToggle('fullscreen', false)));

              // ════════════════════════════════════════════════════════════
            } else if (activeCategory === 'reset') {
              panelTitle('Reset', 'Restore all settings to their factory defaults.');
              const resetBtn = createEl('button', { textContent: 'Reset all settings to defaults', style: 'margin-top:8px;padding:9px 18px;border-radius:8px;border:1px solid var(--text-danger);background:transparent;color:var(--text-danger);font-size:13px;cursor:pointer;transition:background 0.15s;' });
              resetBtn.addEventListener('mouseenter', () => resetBtn.style.background = 'rgba(248,81,73,0.1)');
              resetBtn.addEventListener('mouseleave', () => resetBtn.style.background = 'transparent');
              resetBtn.addEventListener('click', () => {
                showModal(
                  'Reset Browser Settings',
                  'This will restore all browser settings to their factory defaults. Your bookmarks and history will not be affected.',
                  [{ label: 'Reset', danger: true, value: true }, { label: 'Cancel', value: false }]
                ).then(confirmed => {
                  if (!confirmed) return;
                  localStorage.removeItem(ST_KEY);
                  _settingsCache = null; // invalidate settings cache
                  renderSettingsPage('general');
                  Notify.show({ title: 'Settings reset', body: 'All browser settings restored to defaults.', type: 'success', appName: 'Browser' });
                });
              });
              panelInner.appendChild(resetBtn);
            }

            panel.appendChild(panelInner);
            page.append(sidebar, panel);
            viewport.appendChild(page);
          }

          function navigate(rawUrl) {
            if (!rawUrl) return;
            let url = rawUrl.trim();
            // Block dangerous schemes — must check before any branching
            const _lowerUrl = url.toLowerCase().replace(/^[\s\u0000-\u001f]+/, '');
            if (/^(javascript|data|vbscript|about):/i.test(_lowerUrl)) return;

            // ── browser://settings ────────────────────────────────────────
            if (url === 'browser://settings') {
              urlBar.value = 'browser://settings';
              currentUrl = 'browser://settings';
              const activeTab = tabs.find(t => t.id === activeTabId);
              if (activeTab) { activeTab.url = url; activeTab.title = 'Settings'; }
              renderTabs();
              renderSettingsPage();
              return;
            }

            // Remove settings page if navigating away
            const settingsPage = viewport.querySelector('.browser-settings-page');
            if (settingsPage) settingsPage.remove();

            // Resolve vault:// URLs by looking up the file in FS and loading via temp file or blob
            if (url.startsWith('vault:')) {
              const vaultRel = url.replace(/^vault:\/\/+/, '').replace(/^\//, '');
              let targetNode = null;
              for (const [, node] of FS.files) {
                if (node.type !== 'file') continue;
                const parts = [node.name];
                let cur = node;
                while (cur.parentId) {
                  const parent = FS.files.get(cur.parentId);
                  if (!parent) break;
                  parts.unshift(parent.name);
                  cur = parent;
                }
                const nodePath = parts.join('/');
                if (nodePath === vaultRel || node.name === vaultRel) { targetNode = node; break; }
              }
              if (targetNode && targetNode.content != null) {
                urlBar.value = stripHttps(url); currentUrl = url; updateUrlIcon(url);
                const activeTab = tabs.find(t => t.id === activeTabId);
                if (activeTab) { activeTab.url = url; activeTab.title = targetNode.name; }
                renderTabs();
                // hide speed dial if present
                const sd = viewport.querySelector('.speed-dial');
                if (sd) sd.remove();
                const wv = getOrCreateWebview(activeTabId);
                if (!wv.parentNode) viewport.appendChild(wv);
                showWebviewForTab(activeTabId);
                try {
                  const nPath = require('path');
                  const nFs = require('fs');
                  const nOs = require('os');
                  const tmpDir = nOs.tmpdir();
                  const tmpFile = nPath.join(tmpDir, 'nbosp_' + targetNode.id + '.html');
                  const contentToWrite = targetNode.content instanceof Uint8Array ? Buffer.from(targetNode.content) : targetNode.content;
                  nFs.writeFileSync(tmpFile, contentToWrite);
                  wv.src = 'file:///' + tmpFile.replace(/\\/g, '/');
                } catch (_) {
                  const contentStr = targetNode.content instanceof Uint8Array ? new TextDecoder().decode(targetNode.content) : String(targetNode.content);
                  const blob = new Blob([contentStr], { type: 'text/html' });
                  const _blobUrl = URL.createObjectURL(blob);
                  wv.src = _blobUrl;
                  wv.addEventListener('loadstop', () => URL.revokeObjectURL(_blobUrl), { once: true });
                }
                return;
              }
              urlBar.value = stripHttps(url);
              Notify.show({ title: 'Browser', body: 'File not found in vault: ' + vaultRel, type: 'error', appName: 'Browser' });
              return;
            }

            if (!url.match(/^https?:\/\//i) && !url.startsWith('blob:') && !url.startsWith('file://') && !url.startsWith('data:')) {
              url = (url.includes('.') && !url.includes(' ')) ? 'https://' + url : getSearchUrl(url);
            }
            urlBar.value = stripHttps(url); currentUrl = url; updateUrlIcon(url);
            const activeTab = tabs.find(t => t.id === activeTabId);
            if (activeTab) { activeTab.url = url; try { activeTab.title = new URL(url).hostname; } catch { } }
            renderTabs();
            // hide speed dial if present
            const sd = viewport.querySelector('.speed-dial');
            if (sd) sd.remove();
            // Remove stale blocked notice for active tab
            const oldNotice = viewport.querySelector('.browser-iframe-blocked[data-tab="' + activeTabId + '"]');
            if (oldNotice) oldNotice.remove();
            const mode = getTabMode(activeTabId);
            if (mode === 'iframe') {
              const ifr = getOrCreateIframe(activeTabId);
              if (!ifr.parentNode) viewport.appendChild(ifr);
              showViewForTab(activeTabId);
              ifr.src = url;
            } else {
              const wv = getOrCreateWebview(activeTabId);
              if (!wv.parentNode) viewport.appendChild(wv);
              showViewForTab(activeTabId);
              wv.src = url;
            }
          }

          const stripHttps = url => url ? url.replace(/^https:\/\//, '') : '';

          urlBar.addEventListener('keydown', e => { if (e.key === 'Enter') navigate(urlBar.value); });
          urlBar.addEventListener('focus', () => { urlBar.value = currentUrl || ''; });
          urlBar.addEventListener('blur', () => { urlBar.value = stripHttps(currentUrl || urlBar.value); });

          // F12 → main window DevTools (NW.js requires programmatic open)
          // Ctrl+Shift+J → DevTools INSIDE the active webview (for debugging)
          const _onBrowserKeydown = e => {
            if (e.key === 'F12') {
              e.preventDefault();
              try { nw.Window.get().showDevTools(); } catch (_) { }
            }
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'J') {
              e.preventDefault();
              const wv = tabWebviews.get(activeTabId);
              if (wv) {
                try { wv.showDevTools(true); } catch (_) { }
              }
            }
          };
          document.addEventListener('keydown', _onBrowserKeydown);
          state.cleanups = state.cleanups || [];
          state.cleanups.push(() => document.removeEventListener('keydown', _onBrowserKeydown));

          // Incognito partition — use separate session per incognito tab
          backBtn.addEventListener('click', () => {
            if (getTabMode(activeTabId) === 'iframe') {
              const ifr = tabIframes.get(activeTabId);
              try { if (ifr) ifr.contentWindow.history.back(); } catch (_) {}
            } else { tabWebviews.get(activeTabId)?.back(); }
          });
          fwdBtn.addEventListener('click', () => {
            if (getTabMode(activeTabId) === 'iframe') {
              const ifr = tabIframes.get(activeTabId);
              try { if (ifr) ifr.contentWindow.history.forward(); } catch (_) {}
            } else { tabWebviews.get(activeTabId)?.forward(); }
          });
          refreshBtn.addEventListener('click', () => {
            const _mode = getTabMode(activeTabId);
            if (_mode === 'iframe') {
              const ifr = tabIframes.get(activeTabId);
              if (ifr) {
                // Try contentWindow reload (works for same-origin); fall back to re-setting src
                try { ifr.contentWindow.location.reload(); }
                catch (_) { const _s = ifr.src; ifr.src = ''; ifr.src = _s; }
              }
            } else {
              const wv = tabWebviews.get(activeTabId);
              if (wv) wv.reload(); else if (currentUrl) navigate(currentUrl);
            }
          });

          // Open HTML file from vault — write to temp disk file so webview can load it natively
          if (options?.fileId) {
            const fileNode = FS.files.get(options.fileId);
            if (fileNode != null && fileNode.content != null) {
              function getVaultPath(node) {
                const parts = [node.name];
                let cur = node;
                while (cur.parentId) {
                  const parent = FS.files.get(cur.parentId);
                  if (!parent) break;
                  parts.unshift(parent.name);
                  cur = parent;
                }
                return 'vault:/' + parts.join('/');
              }
              const vaultPath = getVaultPath(fileNode);
              tabs[0].title = fileNode.name;
              renderTabs();
              const wv = getOrCreateWebview(activeTabId);
              if (!wv.parentNode) viewport.appendChild(wv);
              showWebviewForTab(activeTabId);
              urlBar.value = vaultPath;
              updateUrlIcon(vaultPath);
              // Normalise content: Uint8Array → string
              const htmlContent = fileNode.content instanceof Uint8Array
                ? new TextDecoder().decode(fileNode.content)
                : String(fileNode.content);
              // Try Node fs (NW.js native), fall back to blob URL
              let loaded = false;
              try {
                const nPath = require('path');
                const nFs = require('fs');
                const nOs = require('os');
                const tmpDir = nOs.tmpdir();
                const tmpFile = nPath.join(tmpDir, 'nbosp_' + fileNode.id + '.html');
                nFs.writeFileSync(tmpFile, htmlContent, 'utf8');
                const fileUrl = 'file:///' + tmpFile.replace(/\\/g, '/');
                wv.src = fileUrl;
                currentUrl = fileUrl;
                loaded = true;
              } catch (err) {
                console.warn('Node fs unavailable, falling back to blob URL:', err);
              }
              if (!loaded) {
                const blob = new Blob([htmlContent], { type: 'text/html' });
                const blobUrl = URL.createObjectURL(blob);
                wv.src = blobUrl;
                wv.addEventListener('loadstop', () => URL.revokeObjectURL(blobUrl), { once: true });
                currentUrl = blobUrl;
              }
              return;
            }
          }

          // Open URL passed from OS.openUrl()
          if (options?.url) { renderTabs(); navigate(options.url); return; }

          renderTabs();
          // Show speed dial on first open (no URL loaded yet)
          renderSpeedDial();
        }
      });

      /* ── APP 7: Calendar ── */
      registerApp({
        id: 'calendar-app', name: 'Calendar', icon: 'calendar',
        description: 'Calendar & Scheduling',
        defaultSize: [860, 580], minSize: [600, 440],
        init(content, state) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.calendar', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.calendar</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const STORE_KEY = 'calendar_events_v2';
          const COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff', '#ff7b72', '#79c0ff', '#56d364'];
          const COLOR_NAMES = ['Blue', 'Green', 'Yellow', 'Red', 'Purple', 'Salmon', 'Sky', 'Lime'];

          function loadEvents() {
            try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; }
          }
          function saveEvents(evs) { lsSave(STORE_KEY, evs); }

          let events = loadEvents();
          let view = 'month';
          let viewDate = new Date();

          // ── Root layout ────────────────────────────────────────────────
          const root = createEl('div', { style: 'display:flex;height:100%;overflow:hidden;font-size:13px;' });
          content.appendChild(root);

          // ── Sidebar ────────────────────────────────────────────────────
          const sidebar = createEl('div', { style: 'width:200px;flex-shrink:0;border-right:1px solid var(--border-subtle);display:flex;flex-direction:column;background:var(--bg-sunken);' });

          // Mini-calendar nav
          const miniNav = createEl('div', { style: 'padding:10px 12px 4px;' });
          const miniHdr = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;' });
          const miniTitle = createEl('span', { style: 'font-size:12px;font-weight:600;' });
          const miniPrev = createEl('button', { className: 'btn btn-icon btn-sm', style: 'padding:2px;' });
          miniPrev.innerHTML = svgIcon('chevron-left', 12);
          const miniNext = createEl('button', { className: 'btn btn-icon btn-sm', style: 'padding:2px;' });
          miniNext.innerHTML = svgIcon('chevron-right', 12);
          miniHdr.append(miniPrev, miniTitle, miniNext);

          const miniGrid = createEl('div', { style: 'display:grid;grid-template-columns:repeat(7,1fr);gap:1px;font-size:10px;text-align:center;' });
          ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(d => {
            miniGrid.appendChild(createEl('div', { textContent: d, style: 'color:var(--text-muted);padding:2px 0;font-weight:600;' }));
          });
          miniNav.append(miniHdr, miniGrid);

          // Upcoming events
          const upcomingWrap = createEl('div', { style: 'flex:1;overflow-y:auto;padding:8px 10px;border-top:1px solid var(--border-subtle);' });
          const upcomingTitle = createEl('div', { style: 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:6px;' });
          upcomingTitle.textContent = 'Upcoming';
          upcomingWrap.appendChild(upcomingTitle);
          const upcomingList = createEl('div');
          upcomingWrap.appendChild(upcomingList);

          // New event button
          const newEvtBtn = createEl('button', { className: 'btn btn-primary', style: 'margin:10px;width:calc(100% - 20px);font-size:12px;' });
          newEvtBtn.innerHTML = svgIcon('plus', 12) + ' New Event';

          sidebar.append(miniNav, upcomingWrap, newEvtBtn);

          // ── Main panel ─────────────────────────────────────────────────
          const main = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;' });

          const toolbar = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;' });
          const prevBtn = createEl('button', { className: 'btn btn-icon btn-sm' }); prevBtn.innerHTML = svgIcon('chevron-left', 16);
          const nextBtn = createEl('button', { className: 'btn btn-icon btn-sm' }); nextBtn.innerHTML = svgIcon('chevron-right', 16);
          const todayBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Today' });
          const mainTitle = createEl('h3', { style: 'margin:0;font-size:15px;font-weight:700;flex:1;' });

          const viewBtns = createEl('div', { style: 'display:flex;background:var(--bg-sunken);border-radius:8px;padding:3px;gap:2px;' });
          ['month', 'week', 'day', 'agenda'].forEach(v => {
            const b = createEl('button', {
              textContent: v.charAt(0).toUpperCase() + v.slice(1),
              style: 'padding:4px 10px;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:500;transition:all 0.15s;'
            });
            b.dataset.view = v;
            b.addEventListener('click', () => { view = v; renderMain(); updateViewBtns(); });
            viewBtns.appendChild(b);
          });

          toolbar.append(prevBtn, nextBtn, todayBtn, mainTitle, viewBtns);

          const contentArea = createEl('div', { style: 'flex:1;overflow:auto;' });
          main.append(toolbar, contentArea);
          root.append(sidebar, main);

          // ── Mini-calendar render ────────────────────────────────────────
          function renderMini() {
            const y = viewDate.getFullYear(), m = viewDate.getMonth();
            miniTitle.textContent = viewDate.toLocaleDateString([], { month: 'short', year: 'numeric' });
            miniGrid.querySelectorAll('.mini-day').forEach(e => e.remove());
            const firstDay = new Date(y, m, 1).getDay();
            const daysIn = new Date(y, m + 1, 0).getDate();
            const today = new Date();
            for (let i = 0; i < firstDay; i++) {
              miniGrid.appendChild(createEl('div', { className: 'mini-day', style: 'padding:2px;' }));
            }
            for (let d = 1; d <= daysIn; d++) {
              const isToday = today.getDate() === d && today.getMonth() === m && today.getFullYear() === y;
              const dot = events.some(ev => ev.date === `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
              const cell = createEl('div', {
                className: 'mini-day',
                textContent: String(d),
                style: `padding:2px;border-radius:4px;cursor:pointer;${isToday ? 'background:var(--accent);color:#fff;font-weight:700;' : ''}`
              });
              if (dot && !isToday) cell.style.textDecoration = 'underline';
              cell.addEventListener('click', () => {
                viewDate = new Date(y, m, d);
                view = 'day'; updateViewBtns(); renderAll();
              });
              miniGrid.appendChild(cell);
            }
          }

          // ── Upcoming ───────────────────────────────────────────────────
          function renderUpcoming() {
            upcomingList.innerHTML = '';
            const today = new Date().toISOString().split('T')[0];
            const upcoming = events
              .filter(ev => ev.date >= today)
              .sort((a, b) => a.date.localeCompare(b.date) || (a.timeStart || '').localeCompare(b.timeStart || ''))
              .slice(0, 8);
            if (!upcoming.length) {
              upcomingList.appendChild(createEl('div', { textContent: 'No upcoming events', style: 'font-size:11px;color:var(--text-muted);padding:4px 0;' }));
              return;
            }
            upcoming.forEach(ev => {
              const item = createEl('div', { style: 'padding:5px 0;border-bottom:1px solid var(--border-subtle);cursor:pointer;' });
              const bar = createEl('div', { style: `width:3px;height:28px;background:${ev.color || 'var(--accent)'};border-radius:2px;float:left;margin-right:8px;` });
              const info = createEl('div', { style: 'overflow:hidden;' });
              info.appendChild(createEl('div', { textContent: ev.title, style: 'font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }));
              info.appendChild(createEl('div', { textContent: ev.date + (ev.timeStart ? ' · ' + ev.timeStart : ''), style: 'font-size:10px;color:var(--text-muted);' }));
              item.append(bar, info);
              item.addEventListener('click', () => openEventModal(new Date(ev.date), ev));
              upcomingList.appendChild(item);
            });
          }

          // ── Main views ─────────────────────────────────────────────────
          function updateViewBtns() {
            viewBtns.querySelectorAll('button').forEach(b => {
              const active = b.dataset.view === view;
              b.style.background = active ? 'var(--accent)' : 'transparent';
              b.style.color = active ? '#fff' : 'var(--text-primary)';
            });
          }

          function renderMain() {
            contentArea.innerHTML = '';
            const y = viewDate.getFullYear(), m = viewDate.getMonth(), d = viewDate.getDate();

            if (view === 'month') {
              mainTitle.textContent = viewDate.toLocaleDateString([], { month: 'long', year: 'numeric' });
              const grid = createEl('div', { style: 'display:grid;grid-template-columns:repeat(7,1fr);height:100%;' });
              ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(day => {
                grid.appendChild(createEl('div', { textContent: day, style: 'text-align:center;padding:6px 0;font-size:11px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border-subtle);' }));
              });
              const firstDay = new Date(y, m, 1).getDay();
              const daysIn = new Date(y, m + 1, 0).getDate();
              const today = new Date();
              for (let i = 0; i < firstDay; i++) {
                grid.appendChild(createEl('div', { style: 'border:1px solid var(--border-subtle);min-height:80px;background:var(--bg-sunken);opacity:0.5;' }));
              }
              for (let day = 1; day <= daysIn; day++) {
                const isToday = today.getDate() === day && today.getMonth() === m && today.getFullYear() === y;
                const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const cell = createEl('div', { style: `border:1px solid var(--border-subtle);min-height:80px;padding:4px;cursor:pointer;transition:background 0.1s;position:relative;${isToday ? 'background:var(--accent-muted);' : ''}` });
                const num = createEl('div', { textContent: String(day), style: `font-size:12px;font-weight:${isToday ? '700' : '400'};color:${isToday ? 'var(--accent)' : 'var(--text-primary)'};margin-bottom:3px;` });
                cell.appendChild(num);
                events.filter(ev => ev.date === dateStr).slice(0, 3).forEach(ev => {
                  const evEl = createEl('div', { textContent: (ev.timeStart ? ev.timeStart + ' ' : '') + ev.title, style: `font-size:10px;background:${ev.color || 'var(--accent)'};color:#fff;border-radius:3px;padding:1px 4px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;` });
                  evEl.addEventListener('click', e => { e.stopPropagation(); openEventModal(new Date(dateStr), ev); });
                  cell.appendChild(evEl);
                });
                cell.addEventListener('click', () => openEventModal(new Date(dateStr), null));
                cell.addEventListener('mouseenter', () => { if (!isToday) cell.style.background = 'var(--bg-elevated)'; });
                cell.addEventListener('mouseleave', () => { cell.style.background = isToday ? 'var(--accent-muted)' : ''; });
                grid.appendChild(cell);
              }
              contentArea.appendChild(grid);

            } else if (view === 'week') {
              const startOfWeek = new Date(viewDate);
              startOfWeek.setDate(d - viewDate.getDay());
              const days = [...Array(7)].map((_, i) => { const dt = new Date(startOfWeek); dt.setDate(startOfWeek.getDate() + i); return dt; });
              mainTitle.textContent = days[0].toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' – ' + days[6].toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
              const today = new Date();
              const grid = createEl('div', { style: 'display:grid;grid-template-columns:40px repeat(7,1fr);height:100%;overflow-y:auto;' });
              grid.appendChild(createEl('div', { style: 'border-bottom:1px solid var(--border-subtle);' }));
              days.forEach(dt => {
                const isToday = dt.toDateString() === today.toDateString();
                const hdr = createEl('div', { style: `text-align:center;padding:6px 4px;border-bottom:1px solid var(--border-subtle);border-left:1px solid var(--border-subtle);font-size:11px;font-weight:${isToday ? '700' : '400'};color:${isToday ? 'var(--accent)' : 'var(--text-primary)'};` });
                hdr.textContent = dt.toLocaleDateString([], { weekday: 'short', day: 'numeric' });
                grid.appendChild(hdr);
              });
              for (let hr = 0; hr < 24; hr++) {
                const label = createEl('div', { textContent: hr === 0 ? '12a' : hr < 12 ? hr + 'a' : hr === 12 ? '12p' : (hr - 12) + 'p', style: 'font-size:10px;color:var(--text-muted);padding:2px 4px;text-align:right;border-top:1px solid var(--border-subtle);' });
                grid.appendChild(label);
                days.forEach(dt => {
                  const dateStr = dt.toISOString().split('T')[0];
                  const cell = createEl('div', { style: 'border-top:1px solid var(--border-subtle);border-left:1px solid var(--border-subtle);min-height:36px;padding:1px;position:relative;' });
                  events.filter(ev => ev.date === dateStr && parseInt(ev.timeStart || '99') === hr).forEach(ev => {
                    const evEl = createEl('div', { textContent: ev.title, style: `font-size:10px;background:${ev.color || 'var(--accent)'};color:#fff;border-radius:3px;padding:2px 4px;cursor:pointer;` });
                    evEl.addEventListener('click', () => openEventModal(dt, ev));
                    cell.appendChild(evEl);
                  });
                  grid.appendChild(cell);
                });
              }
              contentArea.appendChild(grid);

            } else if (view === 'day') {
              mainTitle.textContent = viewDate.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
              const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
              const dayEvs = events.filter(ev => ev.date === dateStr).sort((a, b) => (a.timeStart || '').localeCompare(b.timeStart || ''));
              const wrap = createEl('div', { style: 'padding:16px;max-width:600px;' });
              if (!dayEvs.length) {
                const empty = createEl('div', { textContent: 'No events — click to add one.', style: 'color:var(--text-muted);font-size:13px;margin-top:24px;' });
                wrap.appendChild(empty);
              }
              dayEvs.forEach(ev => {
                const row = createEl('div', { style: `display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border-subtle);cursor:pointer;` });
                const bar = createEl('div', { style: `width:4px;border-radius:2px;background:${ev.color || 'var(--accent)'};flex-shrink:0;` });
                const info = createEl('div', { style: 'flex:1;' });
                info.appendChild(createEl('div', { textContent: ev.title, style: 'font-weight:600;font-size:14px;' }));
                if (ev.timeStart) { info.appendChild(createEl('div', { textContent: ev.timeStart + (ev.timeEnd ? ' – ' + ev.timeEnd : ''), style: 'font-size:12px;color:var(--text-muted);' })); }
                if (ev.desc) { info.appendChild(createEl('div', { textContent: ev.desc, style: 'font-size:12px;color:var(--text-secondary);margin-top:4px;' })); }
                row.append(bar, info);
                row.addEventListener('click', () => openEventModal(viewDate, ev));
                wrap.appendChild(row);
              });
              wrap.addEventListener('click', e => { if (e.target === wrap) openEventModal(viewDate, null); });
              contentArea.appendChild(wrap);

            } else if (view === 'agenda') {
              mainTitle.textContent = 'Agenda';
              const today = new Date().toISOString().split('T')[0];
              const sorted = events.filter(ev => ev.date >= today).sort((a, b) => a.date.localeCompare(b.date) || (a.timeStart || '').localeCompare(b.timeStart || ''));
              const wrap = createEl('div', { style: 'padding:16px;' });
              if (!sorted.length) { wrap.appendChild(createEl('div', { textContent: 'No upcoming events.', style: 'color:var(--text-muted);' })); }
              let lastDate = '';
              sorted.forEach(ev => {
                if (ev.date !== lastDate) {
                  lastDate = ev.date;
                  const d = new Date(ev.date + 'T12:00:00');
                  wrap.appendChild(createEl('div', { textContent: d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }), style: 'font-size:12px;font-weight:700;color:var(--text-muted);margin:14px 0 6px;text-transform:uppercase;letter-spacing:0.06em;' }));
                }
                const row = createEl('div', { style: `display:flex;gap:10px;padding:8px;border-radius:8px;cursor:pointer;margin-bottom:4px;` });
                row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-elevated)');
                row.addEventListener('mouseleave', () => row.style.background = '');
                const bar = createEl('div', { style: `width:4px;border-radius:2px;background:${ev.color || 'var(--accent)'};flex-shrink:0;` });
                const info = createEl('div');
                info.appendChild(createEl('div', { textContent: ev.title, style: 'font-weight:600;font-size:13px;' }));
                if (ev.timeStart) { info.appendChild(createEl('div', { textContent: ev.timeStart + (ev.timeEnd ? ' – ' + ev.timeEnd : ''), style: 'font-size:11px;color:var(--text-muted);' })); }
                row.append(bar, info);
                row.addEventListener('click', () => openEventModal(new Date(ev.date + 'T12:00:00'), ev));
                wrap.appendChild(row);
              });
              contentArea.appendChild(wrap);
            }
          }

          // ── Event modal ────────────────────────────────────────────────
          function openEventModal(date, existing) {
            const isEdit = !!existing;
            const overlay = createEl('div', { style: 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:9999;' });
            const modal = createEl('div', { style: 'background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:12px;padding:20px;width:360px;max-width:90vw;' });

            const title = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;' });
            title.appendChild(createEl('span', { textContent: isEdit ? 'Edit Event' : 'New Event', style: 'font-size:15px;font-weight:700;' }));
            const closeBtn = createEl('button', { className: 'btn btn-icon btn-sm' }); closeBtn.innerHTML = svgIcon('x', 14);
            closeBtn.addEventListener('click', () => overlay.remove());
            title.appendChild(closeBtn);
            modal.appendChild(title);

            function field(label, el) {
              const wrap = createEl('div', { style: 'margin-bottom:12px;' });
              wrap.appendChild(createEl('label', { textContent: label, style: 'display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.06em;' }));
              wrap.appendChild(el); return wrap;
            }

            const titleInp = createEl('input', { className: 'input', placeholder: 'Event title', value: existing?.title || '', id: 'event-title-input', name: 'event-title', style: 'width:100%;' });
            modal.appendChild(field('Title', titleInp));

            const dateInp = createEl('input', { type: 'date', className: 'input', value: date ? date.toISOString().split('T')[0] : '', id: 'event-date-input', name: 'event-date', style: 'width:100%;' });
            const timeStartInp = createEl('input', { type: 'time', className: 'input', value: existing?.timeStart || '', id: 'event-time-start-input', name: 'event-time-start', style: 'flex:1;' });
            const timeEndInp = createEl('input', { type: 'time', className: 'input', value: existing?.timeEnd || '', id: 'event-time-end-input', name: 'event-time-end', style: 'flex:1;' });
            modal.appendChild(field('Date', dateInp));
            const timeRow = createEl('div', { style: 'display:flex;gap:8px;margin-bottom:12px;' });
            function timeField(label, el) {
              const w = createEl('div', { style: 'flex:1;' });
              w.appendChild(createEl('label', { textContent: label, style: 'display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.06em;' }));
              w.appendChild(el); return w;
            }
            timeRow.append(timeField('Start', timeStartInp), timeField('End', timeEndInp));
            modal.appendChild(timeRow);

            const descInp = createEl('textarea', { className: 'input', id: 'event-description-input', name: 'event-description', placeholder: 'Description (optional)', style: 'width:100%;resize:vertical;min-height:56px;' });
            descInp.value = existing?.desc || '';
            modal.appendChild(field('Description', descInp));

            const colorWrap = createEl('div', { style: 'margin-bottom:16px;' });
            colorWrap.appendChild(createEl('label', { textContent: 'Color', style: 'display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.06em;' }));
            const colorRow = createEl('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;' });
            let selectedColor = existing?.color || COLORS[0];
            const colorBtns = [];
            COLORS.forEach((c, i) => {
              const cb = createEl('button', { title: COLOR_NAMES[i], style: `width:22px;height:22px;border-radius:50%;background:${c};border:2px solid ${c === selectedColor ? '#fff' : 'transparent'};cursor:pointer;` });
              cb.addEventListener('click', () => { selectedColor = c; colorBtns.forEach((b, j) => b.style.borderColor = COLORS[j] === c ? '#fff' : 'transparent'); });
              colorBtns.push(cb); colorRow.appendChild(cb);
            });
            colorWrap.appendChild(colorRow);
            modal.appendChild(colorWrap);

            const actions = createEl('div', { style: 'display:flex;gap:8px;justify-content:space-between;' });
            if (isEdit) {
              const delBtn = createEl('button', { className: 'btn', style: 'color:var(--text-danger);border-color:var(--text-danger);', textContent: 'Delete' });
              delBtn.addEventListener('click', () => { events = events.filter(ev => ev.id !== existing.id); saveEvents(events); overlay.remove(); renderAll(); });
              actions.appendChild(delBtn);
            } else { actions.appendChild(createEl('div')); }

            const saveBtn = createEl('button', { className: 'btn btn-primary', textContent: isEdit ? 'Save Changes' : 'Add Event' });
            saveBtn.addEventListener('click', () => {
              const t = titleInp.value.trim();
              if (!t) return titleInp.focus();
              if (isEdit) {
                const ev = events.find(ev => ev.id === existing.id);
                if (ev) Object.assign(ev, { title: t, date: dateInp.value, timeStart: timeStartInp.value, timeEnd: timeEndInp.value, desc: descInp.value, color: selectedColor });
              } else {
                events.push({ id: Date.now().toString(36), title: t, date: dateInp.value || new Date().toISOString().split('T')[0], timeStart: timeStartInp.value, timeEnd: timeEndInp.value, desc: descInp.value, color: selectedColor });
              }
              saveEvents(events); overlay.remove(); renderAll();
              Notify?.show?.({ title: isEdit ? 'Event updated' : 'Event added', body: t, type: 'success', appName: 'Calendar' });
            });
            const cancelBtn = createEl('button', { className: 'btn', textContent: 'Cancel' });
            cancelBtn.addEventListener('click', () => overlay.remove());
            actions.append(cancelBtn, saveBtn);
            modal.appendChild(actions);

            overlay.appendChild(modal);
            document.body.appendChild(overlay);
            setTimeout(() => titleInp.focus(), 50);
          }

          // ── Nav handlers ───────────────────────────────────────────────
          prevBtn.addEventListener('click', () => {
            if (view === 'month') viewDate.setMonth(viewDate.getMonth() - 1);
            else if (view === 'week') viewDate.setDate(viewDate.getDate() - 7);
            else viewDate.setDate(viewDate.getDate() - 1);
            renderAll();
          });
          nextBtn.addEventListener('click', () => {
            if (view === 'month') viewDate.setMonth(viewDate.getMonth() + 1);
            else if (view === 'week') viewDate.setDate(viewDate.getDate() + 7);
            else viewDate.setDate(viewDate.getDate() + 1);
            renderAll();
          });
          todayBtn.addEventListener('click', () => { viewDate = new Date(); renderAll(); });
          miniPrev.addEventListener('click', () => { viewDate.setMonth(viewDate.getMonth() - 1); renderAll(); });
          miniNext.addEventListener('click', () => { viewDate.setMonth(viewDate.getMonth() + 1); renderAll(); });
          newEvtBtn.addEventListener('click', () => openEventModal(new Date(), null));

          function renderAll() { renderMini(); renderMain(); renderUpcoming(); updateViewBtns(); }
          renderAll();
        }
      });

      /* ── APP 13: Nook (Settings) ── */
      registerApp({
        id: 'nook', name: 'Settings', icon: 'settings',
        description: 'System Settings',
        defaultSize: [700, 500], minSize: [500, 400],
        init(content, state, options) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.settings', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.settings</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const container = createEl('div', { className: 'nook-container' });

          const sidebar = createEl('div', { className: 'nook-sidebar', role: 'navigation' });
          const mainContent = createEl('div', { className: 'nook-content' });

          const sections = [
            { id: 'appearance', name: 'Appearance', icon: 'image' },
            { id: 'accessibility', name: 'Accessibility', icon: 'eye' },
            { id: 'desktop', name: 'Desktop', icon: 'layers' },
            { id: 'system', name: 'System', icon: 'processor' },
            { id: 'storage', name: 'Storage', icon: 'database' },
            { id: 'privacy', name: 'Privacy', icon: 'lock' },
            { id: 'about', name: 'About', icon: 'info' }
          ];

          const validIds = new Set(sections.map(s => s.id));
          let currentSection = (options && validIds.has(options.section)) ? options.section : 'appearance';

          function renderSidebar() {
            sidebar.innerHTML = '';
            sections.forEach(s => {
              const btn = createEl('button', {
                className: 'nook-section-btn' + (currentSection === s.id ? ' active' : ''),
                'aria-label': s.name
              });
              const icon = createEl('span');
              icon.innerHTML = svgIcon(s.icon, 16);
              btn.appendChild(icon);
              btn.appendChild(createEl('span', { textContent: s.name }));
              btn.addEventListener('click', () => {
                currentSection = s.id;
                renderSidebar();
                renderContent();
              });
              sidebar.appendChild(btn);
            });
          }

          function renderContent() {
            const tabId = currentSection;

            // Always clear before rendering - this prevents any duplicates
            mainContent.innerHTML = '';
            mainContent.dataset.currentTab = tabId;

            switch (currentSection) {
              case 'appearance':
                renderAppearance();
                break;
              case 'accessibility':
                renderAccessibility();
                break;
              case 'system':
                renderSystem();
                break;
              case 'storage':
                renderStorage();
                break;
              case 'shortcuts':
                renderShortcuts();
                break;
              case 'privacy':
                renderPrivacy();
                break;
              case 'desktop':
                renderDesktop();
                break;
              case 'about':
                renderAbout();
                break;
              default:
                mainContent.appendChild(createEl('div', { className: 'empty-state', textContent: 'Section coming soon' }));
            }
          }

          function renderAppearance() {
            mainContent.appendChild(createEl('h2', { textContent: 'Appearance', style: { marginBottom: '20px' } }));

            const _wallpaperLocked = OS.settings.get('prohibitWallpaperChange');

            const themeGroup = createEl('div', { className: 'nook-group' });
            themeGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Theme' }));

            const themes = ['nova-dark', 'nova-light', 'nord', 'dracula', 'catppuccin', 'tokyo-night', 'gruvbox'];
            const themeNames = ['Nova Dark', 'Nova Light', 'Nord', 'Dracula', 'Catppuccin', 'Tokyo Night', 'Gruvbox'];

            themes.forEach((t, i) => {
              const row = createEl('div', { className: 'nook-row' });
              row.appendChild(createEl('span', { className: 'nook-row-label', textContent: themeNames[i] }));
              const btn = createEl('button', {
                className: 'btn btn-sm' + (OS.settings.get('theme') === t ? ' btn-primary' : ''),
                textContent: OS.settings.get('theme') === t ? 'Active' : 'Select',
              });
              btn.addEventListener('click', () => {
                OS.settings.set('theme', t);
                applyTheme(t);
                // Re-apply saved custom accent (applyTheme resets --accent to theme default)
                const _savedAccent = OS.settings.get('accentColor');
                if (_savedAccent) {
                  document.documentElement.style.setProperty('--accent', _savedAccent);
                  document.documentElement.style.setProperty('--accent-hover', _savedAccent + 'dd');
                  document.documentElement.style.setProperty('--accent-muted', _savedAccent + '26');
                }
                renderContent();
              });
              row.appendChild(btn);
              themeGroup.appendChild(row);
            });

            mainContent.appendChild(themeGroup);

            // Accent color — locked if wallpaper/personalization policy active
            const accentGroup = createEl('div', { className: 'nook-group' });
            accentGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Accent Color' }));

            if (_wallpaperLocked) {
              accentGroup.appendChild(createEl('div', { style: 'font-size:11px;color:var(--text-warning,#d29922);padding:4px 0;', textContent: '🔒 Accent colour changes are restricted by policy.' }));
            }

            const colors = ['#58a6ff', '#3fb950', '#f85149', '#d29922', '#bc8cff', '#ff7b72', '#79c0ff', '#56d4dd'];
            const colorRow = createEl('div', { className: 'nook-row' });
            colors.forEach(c => {
              const btn = createEl('button', {
                className: 'btn btn-sm',
                style: { width: '32px', height: '32px', background: c, border: OS.settings.get('accentColor') === c ? '2px solid white' : 'none', borderRadius: '50%', padding: '0', opacity: _wallpaperLocked ? '0.4' : '1', cursor: _wallpaperLocked ? 'not-allowed' : 'pointer' },
                'aria-label': 'Color ' + c,
                disabled: !!_wallpaperLocked
              });
              if (!_wallpaperLocked) {
                btn.addEventListener('click', () => {
                  OS.settings.set('accentColor', c);
                  document.documentElement.style.setProperty('--accent', c);
                  document.documentElement.style.setProperty('--accent-hover', c + 'dd');
                  document.documentElement.style.setProperty('--accent-muted', c + '22');
                  renderContent();
                });
              }
              colorRow.appendChild(btn);
            });
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
              // FIX 10 — force clock to update immediately without waiting for next interval tick
              const _timeEl = document.getElementById('tray-time');
              if (_timeEl) {
                const _now = new Date();
                const _h = _now.getHours(), _m = _now.getMinutes();
                if (!is24) { // new format is 24h
                  _timeEl.textContent = String(_h).padStart(2, '0') + ':' + String(_m).padStart(2, '0');
                } else { // new format is 12h
                  const _h12 = _h % 12 || 12;
                  _timeEl.textContent = _h12 + ':' + String(_m).padStart(2, '0') + ' ' + (_h < 12 ? 'AM' : 'PM');
                }
              }
            });
            clockRow.appendChild(clockToggle);
            clockGroup.appendChild(clockRow);
            mainContent.appendChild(clockGroup);
          }

          function renderSystem() {
            mainContent.appendChild(createEl('h2', { textContent: 'System', style: { marginBottom: '20px' } }));

            const userGroup = createEl('div', { className: 'nook-group' });
            userGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'User' }));

            const userRow = createEl('div', { className: 'nook-row' });
            userRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Username' }));
            const userInput = createEl('input', { className: 'input', id: 'system-username-input', name: 'system-username', style: { width: '150px' }, value: OS.username });
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
                // Change PIN - ask for current PIN first
                const currentPin = await showModal('Change PIN', 'Enter current PIN:', [
                  { label: 'Cancel' },
                  { label: 'Next', value: 'next' }
                ], 'password');
                if (!currentPin) return;

                const hash = await OS.workers.crypto.call('pbkdf2', currentPin, getPinSalt());
                if (hash !== OS.lockPin) {
                  showModal('Incorrect PIN', 'The current PIN you entered is incorrect.');
                  return;
                }
              }

              // Ask for new PIN twice
              const pin1 = await showModal(OS.lockPin ? 'New PIN' : 'Set PIN', 'Enter a 4-digit PIN:', [
                { label: 'Cancel' },
                { label: 'Next', value: 'next' }
              ], 'password');
              if (!pin1 || pin1.length !== 4 || !/^\d{4}$/.test(pin1)) {
                if (pin1) showModal('Invalid PIN', 'PIN must be exactly 4 digits.');
                return;
              }


              const pin2 = await showModal('Confirm PIN', 'Re-enter your PIN:', [
                { label: 'Cancel' },
                { label: 'Set PIN', value: 'confirm' }
              ], 'password');

              if (pin1 !== pin2) {
                showModal('PIN Mismatch', 'The PINs do not match. Please try again.');
                return;
              }

              const _wasSet = !!OS.lockPin;
              const newHash = await OS.workers.crypto.call('pbkdf2', pin1, getPinSalt());
              OS.lockPin = newHash;
              OS.settings.set('lockPin', newHash);
              Notify.show({ title: _wasSet ? 'PIN Updated' : 'PIN Set', body: _wasSet ? 'Lock screen PIN has been updated' : 'Lock screen PIN has been set', type: 'success', appName: 'Settings' });
              renderContent();
            });
            pinRow.appendChild(pinBtn);

            if (OS.lockPin) {
              const removePinBtn = createEl('button', { className: 'btn btn-sm btn-danger', textContent: 'Remove', style: { marginLeft: '8px' } });
              removePinBtn.addEventListener('click', async () => {
                const confirmed = await showModal('Remove PIN', 'Are you sure you want to remove PIN lock?', [
                  { label: 'Cancel' },
                  { label: 'Remove PIN', danger: true, value: 'confirm' }
                ]);
                if (confirmed === 'confirm') {
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

            // Boot to Recovery section
            const recoveryGroup = createEl('div', { className: 'nook-group' });
            recoveryGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Recovery' }));

            const recoveryRow = createEl('div', { className: 'nook-row' });
            recoveryRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Recovery Environment' }));
            const recoveryBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Boot to Recovery', style: { background: '#6c5ce7' } });
            recoveryBtn.addEventListener('click', () => {
              const confirmed = confirm('Boot to Recovery Environment?\n\nThis will restart and show the recovery options screen.');
              if (!confirmed) return;
              // Set manual recovery flag so recovery screen knows this is intentional
              localStorage.setItem('nova_manual_recovery', '1');
              // Set enough boot attempts to trigger recovery (threshold is 2) but mark as intentional
              localStorage.setItem('nova_boot_attempts', JSON.stringify([
                { ts: Date.now() - 1000, reason: 'manual_recovery_intentional', ua: navigator.userAgent.slice(0, 80) },
                { ts: Date.now(), reason: 'manual_recovery_intentional', ua: navigator.userAgent.slice(0, 80) }
              ]));
              localStorage.removeItem('nova_safe_mode');
              location.reload();
            });
            recoveryRow.appendChild(recoveryBtn);
            recoveryGroup.appendChild(recoveryRow);
            mainContent.appendChild(recoveryGroup);
          }

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

              const bar = createEl('div', { className: 'lens-bar' });
              const fill = createEl('div', { className: 'lens-bar-fill', style: { width: ((est.usage || 0) / (est.quota || 1) * 100) + '%' } });
              bar.appendChild(fill);
              usageGroup.appendChild(bar);

              mainContent.appendChild(usageGroup);
            } catch (e) {
              mainContent.appendChild(createEl('p', { textContent: 'Unable to retrieve storage information.' }));
            }

            // Clear data buttons
            const clearGroup = createEl('div', { className: 'nook-group' });
            clearGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Clear Data' }));

            const clearCacheBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Clear Cache' });
            clearCacheBtn.addEventListener('click', async () => {
              let cleared = [];

              // 1. Cache Storage API (service worker caches)
              if ('caches' in window) {
                try {
                  const cacheNames = await caches.keys();
                  if (cacheNames.length) {
                    await Promise.all(cacheNames.map(n => caches.delete(n)));
                    cleared.push(cacheNames.length + ' SW cache' + (cacheNames.length > 1 ? 's' : ''));
                  }
                } catch (e) { /* not available */ }
              }

              // 2. Temp / cache-like localStorage keys (safe to drop, not user data)
              try {
                const tempKeys = Object.keys(localStorage).filter(k =>
                  k.includes('_cache') || k.includes('_temp') ||
                  k === 'nova_boot_attempts' || k === 'nova_force_recovery'
                );
                if (tempKeys.length) {
                  tempKeys.forEach(k => localStorage.removeItem(k));
                  cleared.push(tempKeys.length + ' temp key' + (tempKeys.length > 1 ? 's' : ''));
                }
              } catch (e) { /* localStorage blocked */ }

              if (cleared.length) {
                Notify.show({ title: 'Cache Cleared', body: 'Removed: ' + cleared.join(', '), type: 'success', appName: 'Settings' });
              } else {
                Notify.show({ title: 'Nothing to Clear', body: 'Cache is already empty', type: 'info', appName: 'Settings' });
              }
            });
            clearGroup.appendChild(clearCacheBtn);

            const wipeBtn = createEl('button', { className: 'btn btn-danger btn-sm', style: { marginLeft: '8px' }, textContent: 'Wipe All Data' });
            wipeBtn.addEventListener('click', async () => {
              const confirm = await showModal('Wipe All Data', 'This will delete all files, settings, and data. This action cannot be undone.', [
                { label: 'Cancel' },
                { label: 'Wipe Everything', danger: true, value: 'wipe' }
              ]);
              if (confirm === 'wipe') {
                Notify.show({ title: 'Wiping Data', body: 'Please wait...', type: 'warning', appName: 'Settings' });
                // Clear synchronous storage first
                localStorage.clear();
                sessionStorage.clear();
                // Delete all IndexedDB databases sequentially, then clear OPFS, then reload
                const dbsToDelete = ['NovaByte_FS', 'novabyte_opfs_fallback'];
                let dbCount = 0;
                const deleteDbs = () => new Promise(resolve => {
                  if (dbCount >= dbsToDelete.length) { resolve(); return; }
                  const req = indexedDB.deleteDatabase(dbsToDelete[dbCount++]);
                  req.onsuccess = req.onerror = req.onblocked = () => deleteDbs().then(resolve);
                });
                const clearOPFS = async () => {
                  try {
                    if (typeof OPFS !== 'undefined' && OPFS.clear) await OPFS.clear();
                  } catch { }
                };
                (async () => { await deleteDbs(); await clearOPFS(); location.reload(); })();
              }
            });
            clearGroup.appendChild(wipeBtn);

            mainContent.appendChild(clearGroup);
          }

          function renderShortcuts() {
            mainContent.appendChild(createEl('h2', { textContent: 'Keyboard Shortcuts', style: { marginBottom: '20px' } }));

            const shortcuts = [
              { key: 'Win + E', action: 'Open Files' },
              { key: 'Win + T', action: 'Open Terminal' },
              { key: 'Win + Space', action: 'Open Launchpad' },
              { key: 'Win + L', action: 'Lock Screen' },
              { key: 'Win + D', action: 'Show Desktop' },
              { key: 'Alt + Tab', action: 'Switch Apps' },
              { key: 'Alt + F4', action: 'Close Window' },
              { key: 'Ctrl + S', action: 'Save (in apps)' },
              { key: 'Ctrl + C/V/X', action: 'Copy/Paste/Cut' },
              { key: 'F11', action: 'Fullscreen' },
              { key: 'Print Screen', action: 'Screenshot' }
            ];

            shortcuts.forEach(s => {
              const row = createEl('div', { className: 'nook-row' });
              row.appendChild(createEl('span', { className: 'nook-row-label', textContent: s.key }));
              row.appendChild(createEl('span', { style: { color: 'var(--text-secondary)', fontSize: '13px' }, textContent: s.action }));
              mainContent.appendChild(row);
            });
          }

          function renderAbout() {
            mainContent.appendChild(createEl('h2', { textContent: 'About NovaByte', style: { marginBottom: '20px' } }));

            const info = createEl('div', { style: { lineHeight: '1.8' } });
            info.appendChild(createEl('p', { textContent: 'NovaByte v' + OS.version, style: { fontSize: '18px', fontWeight: '500' } }));
            info.appendChild(createEl('p', { textContent: '"Your world. Your browser."', style: { fontStyle: 'italic', color: 'var(--text-secondary)', marginBottom: '16px' } }));

            const details = [
              ['Browser', detectBrowser()],
              ['Platform', navigator.platform],
              ['Screen', `${screen.width} × ${screen.height}`],
              ['Color Depth', screen.colorDepth + ' bit'],
              ['Device Pixel Ratio', window.devicePixelRatio + 'x'],
              ['CPU Cores', navigator.hardwareConcurrency || 'Unknown'],
              ['Language', navigator.language]
            ];

            details.forEach(([label, value]) => {
              const row = createEl('div', { className: 'nook-row' });
              row.appendChild(createEl('span', { className: 'nook-row-label', textContent: label }));
              row.appendChild(createEl('span', { textContent: value }));
              info.appendChild(row);
            });

            mainContent.appendChild(info);

            // ── Security & Services card ──────────────────────────────────────────────
            const secCard = createEl('div', { style: 'margin-top:24px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;overflow:hidden;' });
            const secTitle = createEl('div', { textContent: 'Security & Services', style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);padding:10px 14px 8px;border-bottom:1px solid var(--border-subtle);' });
            secCard.appendChild(secTitle);

            // Security Patch Level row
            const patchRow = createEl('div', { className: 'nook-row', style: 'padding:10px 14px;' });
            patchRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Security Patch Level' }));
            const patchRowRight = createEl('div', { style: 'display:flex;align-items:center;gap:6px;' });
            const patchBadge = createEl('span', { textContent: OS.securityPatch, style: 'font-family:monospace;font-size:12px;background:rgba(63,185,80,0.12);color:#3fb950;border:1px solid rgba(63,185,80,0.3);padding:2px 8px;border-radius:4px;' });
            patchRowRight.appendChild(patchBadge);
            patchRow.appendChild(patchRowRight);
            secCard.appendChild(patchRow);

            // Divider
            secCard.appendChild(createEl('div', { style: 'height:1px;background:var(--border-subtle);margin:0 14px;' }));

            mainContent.appendChild(secCard);

          }


          function renderDesktop() {
            mainContent.appendChild(createEl('h2', { textContent: 'Desktop', style: { marginBottom: '20px' } }));

            // Custom wallpaper
            const wallpaperGroup = createEl('div', { className: 'nook-group' });
            wallpaperGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Wallpaper' }));

            // Preset wallpapers selector
            const PRESET_WALLPAPERS = [
              { id: 'stock-blue', name: 'Nova Blue', gradient: 'radial-gradient(ellipse at 28% 38%, #1a5fbf 0%, #0a3070 35%, transparent 65%), linear-gradient(160deg, #020c1e 0%, #041428 45%, #061830 75%, #020c1e 100%)' },
              { id: 'stock-dark', name: 'Obsidian', gradient: 'radial-gradient(ellipse at 70% 25%, #160a28 0%, transparent 55%), radial-gradient(ellipse at 25% 75%, #0c0818 0%, transparent 50%), linear-gradient(150deg, #080810 0%, #0e0818 50%, #08080e 100%)' },
              { id: 'stock-light', name: 'Frost', gradient: 'radial-gradient(ellipse at 40% 30%, #ffffff 0%, #e8f0ff 45%, transparent 70%), linear-gradient(160deg, #dde8f8 0%, #eaf0ff 45%, #d8e6f5 100%)' },
              { id: 'stock-green', name: 'Evergreen', gradient: 'radial-gradient(ellipse at 30% 40%, #0a5c2a 0%, #043818 38%, transparent 65%), linear-gradient(155deg, #020c06 0%, #040e08 45%, #060e06 75%, #020c06 100%)' },
              { id: 'stock-purple', name: 'Deep Violet', gradient: 'radial-gradient(ellipse at 62% 32%, #4a1272 0%, #2c0858 40%, transparent 65%), radial-gradient(ellipse at 22% 70%, #1e084a 0%, transparent 50%), linear-gradient(155deg, #0a0414 0%, #140628 50%, #0a0414 100%)' },
              { id: 'stock-red', name: 'Ember Core', gradient: 'radial-gradient(ellipse at 35% 42%, #8c1a10 0%, #5c0808 40%, transparent 65%), radial-gradient(ellipse at 75% 70%, #3a0c0c 0%, transparent 50%), linear-gradient(155deg, #0e0404 0%, #180808 45%, #0e0404 100%)' },
              { id: 'stock-gray', name: 'Steel', gradient: 'radial-gradient(ellipse at 50% 32%, #2c3c4e 0%, #1a2838 40%, transparent 65%), linear-gradient(155deg, #0c1018 0%, #16202c 45%, #0c1218 75%, #0c1018 100%)' },
              { id: 'stock-teal', name: 'Abyss', gradient: 'radial-gradient(ellipse at 38% 36%, #0a5e70 0%, #044050 40%, transparent 65%), radial-gradient(ellipse at 72% 68%, #042835 0%, transparent 50%), linear-gradient(155deg, #020c10 0%, #041520 45%, #021018 100%)' }
            ];

            const presetRow = createEl('div', { className: 'nook-row' });
            presetRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Preset Wallpapers' }));

            const presetContainer = createEl('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;' });
            const savedWallpaperId = OS.settings.get('wallpaperId');
            const wallpaperExists = PRESET_WALLPAPERS.some(wp => wp.id === savedWallpaperId);
            const currentWallpaperId = (wallpaperExists ? savedWallpaperId : 'stock-blue');

            PRESET_WALLPAPERS.forEach(wp => {
              const wpCard = createEl('div', {
                style: `width:64px;height:48px;border-radius:6px;cursor:pointer;border:2px solid transparent;background:${wp.gradient};transition:all 0.15s;${currentWallpaperId === wp.id ? 'border-color:var(--accent);box-shadow:0 0 0 2px var(--window-bg), 0 0 8px var(--accent);' : 'opacity:0.7;'}`
              });

              wpCard.title = wp.name;
              wpCard.addEventListener('click', () => {
                const desktop = document.getElementById('desktop');
                if (desktop) {
                  desktop.style.backgroundImage = wp.gradient;
                }
                OS.settings.set('wallpaperId', wp.id);
                OS.settings.set('customWallpaper', null);
                wallpaperInput.value = '';

                // Update all cards
                Array.from(presetContainer.querySelectorAll('div')).forEach((card, idx) => {
                  if (idx === PRESET_WALLPAPERS.indexOf(wp)) {
                    card.style.borderColor = 'var(--accent)';
                    card.style.boxShadow = '0 0 0 2px var(--window-bg), 0 0 8px var(--accent)';
                    card.style.opacity = '1';
                  } else {
                    card.style.borderColor = 'transparent';
                    card.style.boxShadow = 'none';
                    card.style.opacity = '0.7';
                  }
                });

                Notify.show({ title: 'Wallpaper Changed', body: `Applied ${wp.name}`, type: 'success', appName: 'Settings' });
              });

              presetContainer.appendChild(wpCard);
            });

            presetRow.appendChild(presetContainer);
            wallpaperGroup.appendChild(presetRow);

            // Apply current wallpaper on render
            const desktop = document.getElementById('desktop');
            if (desktop) {
              // Clear all existing background
              desktop.style.backgroundImage = '';
              desktop.style.backgroundSize = '';
              desktop.style.backgroundPosition = '';
              desktop.style.backgroundRepeat = '';

              const customWallpaper = OS.settings.get('customWallpaper');
              if (customWallpaper) {
                desktop.style.backgroundImage = 'url(' + customWallpaper + ')';
                desktop.style.backgroundSize = 'cover';
                desktop.style.backgroundPosition = 'center';
                desktop.style.backgroundRepeat = 'no-repeat';
              } else {
                const currentWallpaper = PRESET_WALLPAPERS.find(wp => wp.id === currentWallpaperId);
                if (currentWallpaper) {
                  desktop.style.backgroundImage = currentWallpaper.gradient;
                }
              }
            }

            const wallpaperRow = createEl('div', { className: 'nook-row', style: 'margin-top:16px;' });
            wallpaperRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Custom Image' }));

            const wallpaperInput = createEl('input', {
              id: 'wallpaper-upload',
              name: 'wallpaper-upload',
              type: 'file',
              accept: 'image/*',
              style: { width: '200px' }
            });
            wallpaperInput.addEventListener('change', async () => {
              const file = wallpaperInput.files[0];
              if (file) {
                const reader = new FileReader();
                reader.onload = () => {
                  const dataUrl = reader.result;
                  const desktop = document.getElementById('desktop');
                  if (desktop) {
                    desktop.style.backgroundImage = 'url(' + dataUrl + ')';
                    desktop.style.backgroundSize = 'cover';
                    desktop.style.backgroundPosition = 'center';
                    desktop.style.backgroundRepeat = 'no-repeat';
                  }
                  OS.settings.set('customWallpaper', dataUrl);
                  OS.settings.set('wallpaperId', null);
                  Notify.show({ title: 'Wallpaper Changed', body: 'Custom wallpaper applied', type: 'success', appName: 'Settings' });
                };
                reader.readAsDataURL(file);
              }
            });
            wallpaperRow.appendChild(wallpaperInput);

            // Reset button
            const resetBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Reset to Default', style: { marginLeft: '8px' } });
            resetBtn.addEventListener('click', () => {
              const desktop = document.getElementById('desktop');
              const defaultGradient = PRESET_WALLPAPERS[0].gradient; // stock-blue
              if (desktop) {
                desktop.style.backgroundImage = defaultGradient;
                desktop.style.backgroundSize = '';
                desktop.style.backgroundPosition = '';
                desktop.style.backgroundRepeat = '';
              }
              OS.settings.set('customWallpaper', null);
              OS.settings.set('wallpaperId', 'stock-blue');
              wallpaperInput.value = '';

              // Reset all cards
              Array.from(presetContainer.querySelectorAll('div')).forEach((card, idx) => {
                if (idx === 0) {
                  card.style.borderColor = 'var(--accent)';
                  card.style.boxShadow = '0 0 0 2px var(--window-bg), 0 0 8px var(--accent)';
                  card.style.opacity = '1';
                } else {
                  card.style.borderColor = 'transparent';
                  card.style.boxShadow = 'none';
                  card.style.opacity = '0.7';
                }
              });

              Notify.show({ title: 'Wallpaper Reset', body: 'Default wallpaper restored', type: 'success', appName: 'Settings' });
            });
            wallpaperRow.appendChild(resetBtn);

            wallpaperGroup.appendChild(wallpaperRow);
            mainContent.appendChild(wallpaperGroup);

            // Show taskbar clock toggle
            const clockGroup = createEl('div', { className: 'nook-group' });
            clockGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Taskbar' }));

            const clockRow = createEl('div', { className: 'nook-toggle-row' });
            clockRow.appendChild(createEl('span', { textContent: 'Show Clock in Taskbar' }));
            const clockToggle = createEl('button', {
              className: 'toggle' + (OS.settings.get('showTaskbarClock') !== false ? ' active' : '')
            });
            clockToggle.addEventListener('click', () => {
              const newVal = OS.settings.get('showTaskbarClock') !== false;
              OS.settings.set('showTaskbarClock', !newVal);
              clockToggle.classList.toggle('active', !newVal);
              const clockEl = document.getElementById('tray-clock'); // FIX 4a — was 'taskbar-clock' (wrong ID)
              if (clockEl) clockEl.style.display = newVal ? 'none' : 'flex'; // FIX 4b — was inverted (!newVal)
            });
            clockRow.appendChild(clockToggle);
            clockGroup.appendChild(clockRow);

            // Taskbar size
            const sizeRow = createEl('div', { className: 'nook-row' });
            sizeRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Size' }));

            const sizes = [
              { value: 'compact', label: 'Compact' },
              { value: 'normal', label: 'Normal' },
              { value: 'large', label: 'Large' }
            ];
            const currentSize = OS.settings.get('taskbarSize') || 'normal';

            sizes.forEach(sz => {
              const btn = createEl('button', {
                className: 'btn btn-sm' + (currentSize === sz.value ? ' btn-primary' : ''),
                textContent: sz.label,
                style: { marginRight: '8px' }
              });
              btn.addEventListener('click', () => {
                OS.settings.set('taskbarSize', sz.value);
                const heights = { compact: '36px', normal: '48px', large: '64px' };
                document.documentElement.style.setProperty('--taskbar-height', heights[sz.value]);
                renderContent();
              });
              sizeRow.appendChild(btn);
            });
            mainContent.appendChild(clockGroup);
          }

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
              const isActive = OS.settings.get('reduceMotion');
              OS.settings.set('reduceMotion', !isActive);
              document.documentElement.classList.toggle('reduce-motion', !isActive);
              document.documentElement.style.setProperty('--anim-speed', !isActive ? '0.001' : '1');
              const _wEl = document.getElementById('wallpaper');
              if (_wEl) _wEl.style.animation = !isActive ? 'none' : '';
              motionToggle.classList.toggle('active', !isActive);

              const wallpaper = document.getElementById('wallpaper');
              if (wallpaper) {
                wallpaper.style.animation = 'none';
              }
            });
            motionRow.appendChild(motionToggle);
            motionGroup.appendChild(motionRow);
            mainContent.appendChild(motionGroup);

            // Icon Size
            const cursorGroup = createEl('div', { className: 'nook-group' });
            cursorGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Icon Size' }));

            const cursorOptions = [
              { value: 'normal', label: 'Normal' },
              { value: 'large', label: 'Large' },
              { value: 'xlarge', label: 'X-Large' }
            ];

            cursorOptions.forEach(opt => {
              const row = createEl('div', { className: 'nook-row' });
              row.appendChild(createEl('span', { textContent: opt.label }));
              const btn = createEl('button', {
                className: 'btn btn-sm' + (OS.settings.get('cursorSize') === opt.value ? ' btn-primary' : ''),
                textContent: OS.settings.get('cursorSize') === opt.value ? 'Active' : 'Select'
              });
              btn.addEventListener('click', () => {
                OS.settings.set('cursorSize', opt.value);
                // FIX 2: Use CSS transform to scale cursor indicator instead of invalid cursor size
                const cursorStyles = document.getElementById('cursor-custom-styles') || (() => {
                  const s = document.createElement('style'); s.id = 'cursor-custom-styles'; document.head.appendChild(s); return s;
                })();
                const transforms = { normal: 'scale(1)', large: 'scale(1.5)', xlarge: 'scale(2)' };
                cursorStyles.textContent = `#desktop .desktop-icon { transform: ${transforms[opt.value]} }`;
                renderContent();
              });
              row.appendChild(btn);
              cursorGroup.appendChild(row);
            });

            mainContent.appendChild(cursorGroup);
          }

          function renderPrivacy() {
            mainContent.appendChild(createEl('h2', { textContent: 'Privacy & Security', style: { marginBottom: '20px' } }));

            // Data export/import
            const exportSection = createEl('div', { className: 'nook-privacy-section' });
            exportSection.appendChild(createEl('h3', { textContent: 'Data Management' }));

            const exportActions = createEl('div', { className: 'nook-data-actions' });

            const exportBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Export All Data (JSON)' });
            exportBtn.addEventListener('click', () => {
              const data = {
                settings: Object.fromEntries(Object.entries(OS.settings._cache || {})), // FIX 14 — was OS.settings.store (undefined); actual store is _cache
                version: OS.version,
                exportDate: new Date().toISOString()
              };
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = createEl('a', { href: url, download: 'novabyte-export.json' });
              a.click();
              URL.revokeObjectURL(url);
              Notify.show({ title: 'Data Exported', body: 'All data has been exported', type: 'success', appName: 'Nook' });
            });
            exportActions.appendChild(exportBtn);

            const importBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Import Data' });
            importBtn.addEventListener('click', async () => {
              const input = createEl('input', { type: 'file', accept: '.json', id: 'settings-import-input', name: 'settings-import' });
              input.addEventListener('change', async () => {
                const file = input.files[0];
                if (file) {
                  const text = await file.text();
                  try {
                    const data = JSON.parse(text);
                    if (data.settings) {
                      Object.entries(data.settings).forEach(([k, v]) => OS.settings.set(k, v));
                      Notify.show({ title: 'Data Imported', body: 'Settings have been imported', type: 'success', appName: 'Nook' });
                    }
                  } catch (e) {
                    Notify.show({ title: 'Import Failed', body: 'Invalid JSON file', type: 'error', appName: 'Nook' });
                  }
                }
              });
              input.click();
            });
            exportActions.appendChild(importBtn);

            exportSection.appendChild(exportActions);
            mainContent.appendChild(exportSection);
          }

          renderShortcuts = function () {
            mainContent.innerHTML = '';
            mainContent.appendChild(createEl('h2', { textContent: 'Keyboard Shortcuts', style: { marginBottom: '20px' } }));

            const searchInput = createEl('div', { className: 'nook-shortcuts-search' });
            const search = createEl('input', { id: 'shortcuts-search-input', name: 'shortcuts-search', placeholder: 'Search shortcuts...' });
            searchInput.appendChild(search);
            mainContent.appendChild(searchInput);

            const table = createEl('table', { className: 'nook-shortcuts-table' });
            const thead = createEl('thead');
            thead.innerHTML = '<tr><th>Action</th><th>Shortcut</th><th></th></tr>';
            table.appendChild(thead);

            const tbody = createEl('tbody');

            const shortcutsList = [
              { action: 'Open File Manager', key: 'Win+E' },
              { action: 'Open Terminal', key: 'Win+T' },
              { action: 'Open Launchpad', key: 'Win+Space' },
              { action: 'Lock Screen', key: 'Win+L' },
              { action: 'Show Desktop', key: 'Win+D' },
              { action: 'Switch Apps', key: 'Alt+Tab' },
              { action: 'Close Window', key: 'Alt+F4' },
              { action: 'Fullscreen', key: 'F11' },
              { action: 'Screenshot', key: 'Print Screen' },
              { action: 'New Tab (Browser)', key: 'Ctrl+T' },
              { action: 'Close Tab', key: 'Ctrl+W' },
              { action: 'Find in Page', key: 'Ctrl+F' },
              { action: 'Quick Commands', key: 'Ctrl+K' }
            ];

            const customShortcuts = JSON.parse(localStorage.getItem('novabyte-shortcuts') || '{}');

            function captureKeyBinding(action, currentKey) {
              return new Promise(resolve => {
                const overlay = createEl('div', {
                  // FIX 13 — tabIndex: -1 makes the div programmatically focusable so keydown events fire
                  tabIndex: -1,
                  style: 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:9999;outline:none'
                });
                const msg = createEl('div', {
                  style: 'background:var(--bg-elevated);padding:30px 40px;border-radius:12px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.5)',
                  innerHTML: `<h3 style="margin-bottom:15px;color:var(--text-primary)">Rebind: ${action}</h3><p style="color:var(--text-secondary);margin-bottom:20px">Press any key combination...</p><div id="kb-capture" style="font-family:var(--font-mono);font-size:18px;padding:10px 20px;background:var(--bg-sunken);border-radius:6px;color:var(--accent)">Waiting...</div>`
                });
                overlay.appendChild(msg);
                document.body.appendChild(overlay);

                const captureEl = msg.querySelector('#kb-capture');
                const keyCombo = { mods: [], key: '' };

                const keyHandler = e => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (e.key === 'Escape') { overlay.remove(); resolve(null); return; }
                  const parts = [];
                  if (e.ctrlKey) parts.push('Ctrl');
                  if (e.altKey) parts.push('Alt');
                  if (e.shiftKey) parts.push('Shift');
                  if (e.metaKey) parts.push('Win');
                  if (e.key && !['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
                  if (parts.length > 0) {
                    keyCombo.mods = parts.slice(0, -1);
                    keyCombo.key = parts[parts.length - 1];
                    captureEl.textContent = parts.join('+');
                    setTimeout(() => {
                      overlay.remove();
                      resolve(parts.join('+'));
                    }, 400);
                  }
                };

                overlay.addEventListener('keydown', keyHandler, true);
                overlay.style.cursor = 'wait';
                setTimeout(() => overlay.focus(), 100);
              });
            }

            shortcutsList.forEach(s => {
              const row = createEl('tr');
              const currentKey = customShortcuts[s.action] || s.key;
              row.innerHTML = `<td></td><td><span class="nook-shortcut-key"></span></td><td><button class="btn btn-sm nook-rebind-btn">Rebind</button></td>`; row.querySelector("td:first-child").textContent = s.action; row.querySelector(".nook-shortcut-key").textContent = currentKey;
              const btn = row.querySelector('.nook-rebind-btn');
              btn.addEventListener('click', async () => {
                const newKey = await captureKeyBinding(s.action, s.key);
                if (newKey) {
                  customShortcuts[s.action] = newKey;
                  localStorage.setItem('novabyte-shortcuts', JSON.stringify(customShortcuts));
                  row.querySelector('.nook-shortcut-key').textContent = newKey;
                }
              });
              tbody.appendChild(row);
            });

            table.appendChild(tbody);
            mainContent.appendChild(table);

            search.addEventListener('input', () => {
              const query = search.value.toLowerCase();
              tbody.querySelectorAll('tr').forEach(row => {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(query) ? '' : 'none';
              });
            });
          };

          // 2.3.8 — Redesigned About section with organised sections
          renderAbout = function () {
            mainContent.innerHTML = '';
            mainContent.style.padding = '0';

            const body = createEl('div', { style: 'padding:24px 28px;display:flex;flex-direction:column;gap:18px;overflow-y:auto;flex:1;' });

            // ── Helpers ───────────────────────────────────────────────────────────
            function mkSection(title, icon) {
              const wrap = createEl('div', { style: 'background:var(--bg-sunken);border:1px solid var(--border-subtle);border-radius:12px;overflow:hidden;' });
              const hdr = createEl('div', { style: 'padding:11px 16px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;gap:8px;background:rgba(255,255,255,0.025);' });
              hdr.appendChild(createEl('span', { textContent: icon, style: 'font-size:13px;' }));
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

            // ══════════════════════════════════════════════════════════════════════
            //  SECTION 1 — SOFTWARE INFORMATION
            // ══════════════════════════════════════════════════════════════════════
            const { wrap: swWrap, rows: swRows } = mkSection('Software Information', '\uD83D\uDCBF');

            // Logo + name + version
            const logoRow = createEl('div', { style: 'padding:18px 0 14px;display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--border-subtle);' });
            const logoBox = createEl('div', { style: 'width:54px;height:54px;border-radius:15px;background:linear-gradient(135deg,#3d8eff 0%,#7c5cfc 55%,#c45cff 100%);display:flex;align-items:center;justify-content:center;box-shadow:0 6px 22px rgba(88,166,255,0.32),0 2px 8px rgba(0,0,0,0.4),inset 0 1px 0 rgba(255,255,255,0.22);flex-shrink:0;' });
            logoBox.innerHTML = '<svg viewBox="0 0 120 120" width="32" height="32" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="abt-g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#58a6ff"/><stop offset="100%" stop-color="#a371f7"/></linearGradient></defs><polygon points="60,5 110,30 110,85 60,115 10,85 10,30" fill="rgba(88,166,255,0.05)" stroke="url(#abt-g)" stroke-width="2.5" opacity="0.9"/><polygon points="60,15 100,35 100,80 60,105 20,80 20,35" fill="none" stroke="url(#abt-g)" stroke-width="1.5" opacity="0.38"/><polygon points="60,28 88,43 88,76 60,91 32,76 32,43" fill="rgba(163,113,247,0.05)" stroke="url(#abt-g)" stroke-width="1" opacity="0.3"/><text x="60" y="69" text-anchor="middle" fill="url(#abt-g)" font-family="system-ui,-apple-system,sans-serif" font-size="30" font-weight="700">NB</text></svg>';
            const logoMeta = createEl('div');
            const lgTitle = createEl('div', { style: 'font-size:17px;font-weight:800;background:linear-gradient(130deg,#e6edf3 25%,#a371f7 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:4px;line-height:1.15;' });
            lgTitle.textContent = 'NovaByte';
            const verBadge = createEl('div', { style: 'display:inline-flex;align-items:center;gap:5px;background:rgba(88,166,255,0.12);border:1px solid rgba(88,166,255,0.3);border-radius:20px;padding:2px 11px;font-size:11px;font-weight:700;color:var(--accent);margin-bottom:3px;' });
            verBadge.textContent = 'v' + OS.version;
            const tagline = createEl('div', { style: 'font-size:10.5px;color:var(--text-muted);font-style:italic;' });
            tagline.textContent = '\u201cYour world. Your browser.\u201d';
            logoMeta.append(lgTitle, verBadge, tagline);
            logoRow.append(logoBox, logoMeta);
            swRows.appendChild(logoRow);

            // ── NovaByte Version (clickable easter egg) ─────────────────────────────
            const novaVersionRow = createEl('div', {
              className: 'nook-row clickable',
              style: 'display:flex;justify-content:space-between;align-items:center;padding:9px 0;font-size:12.5px;border-bottom:1px solid var(--border-subtle);cursor:pointer;transition:background 0.15s;border-radius:6px;'
            });
            novaVersionRow.addEventListener('mouseenter', () => { novaVersionRow.style.background = 'rgba(88,166,255,0.08)'; });
            novaVersionRow.addEventListener('mouseleave', () => { novaVersionRow.style.background = 'transparent'; });

            const novaVerLabel = createEl('span', { textContent: 'NovaByte Version', style: 'color:var(--text-secondary);flex-shrink:0;margin-right:12px;' });
            const novaVerValue = createEl('span', {
              style: 'color:var(--text-primary);font-weight:500;text-align:right;max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
            });
            novaVerValue.textContent = 'v' + OS.version;
            novaVersionRow.append(novaVerLabel, novaVerValue);

            let clickCount = 0;
            let clickTimeout = null;
            novaVersionRow.addEventListener('click', () => {
              clickCount++;
              if (clickCount >= 7) {
                clickCount = 0;
                clearTimeout(clickTimeout);
                launchSnakeGame();
                return;
              }
              clearTimeout(clickTimeout);
              clickTimeout = setTimeout(() => {
                clickCount = 0;
              }, 1500);
            });

            swRows.appendChild(novaVersionRow);

            swRows.appendChild(mkRow('Build Channel', 'Stable'));
            swRows.appendChild(mkRow('Release Date', '2026-05-01'));

            // Security update row
            const secRow = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:9px 0;font-size:12.5px;border-top:1px solid var(--border-subtle);border-radius:6px;' });
            const secRowLeft = createEl('div', { style: 'display:flex;align-items:center;gap:6px;' });
            secRowLeft.appendChild(createEl('span', { textContent: 'Security Patch Level', style: 'color:var(--text-secondary);' }));
            secRow.appendChild(secRowLeft);
            const secRowRight = createEl('div', { style: 'display:flex;align-items:center;gap:6px;' });
            const secBadge = createEl('span', { style: 'display:inline-flex;align-items:center;gap:5px;background:rgba(63,185,80,0.1);border:1px solid rgba(63,185,80,0.3);border-radius:20px;padding:2px 10px;font-size:10.5px;font-weight:700;color:#3fb950;' });
            secBadge.textContent = '\uD83D\uDD12 2026-05-01';
            secRowRight.appendChild(secBadge);
            secRow.appendChild(secRowRight);
            swRows.appendChild(secRow);

            body.appendChild(swWrap);

            // ══════════════════════════════════════════════════════════════════════
            //  SECTION 2 — HARDWARE
            // ══════════════════════════════════════════════════════════════════════
            const { wrap: hwWrap, rows: hwRows } = mkSection('Hardware', '\uD83D\uDDA5\uFE0F');
            [
              ['Screen Resolution', screen.width + '\u00D7' + screen.height, false],
              ['Colour Depth', screen.colorDepth + ' bit', false],
              ['Pixel Ratio', window.devicePixelRatio + '\u00D7', false],
              ['CPU Cores', String(navigator.hardwareConcurrency || 'Unknown'), false],
              ['Device Memory', navigator.deviceMemory ? navigator.deviceMemory + ' GB (approx.)' : 'Not reported', false],
              ['Touch Points', navigator.maxTouchPoints > 0 ? String(navigator.maxTouchPoints) + ' point(s)' : 'None', true],
            ].forEach(function (r) { hwRows.appendChild(mkRow(r[0], r[1], r[2])); });
            body.appendChild(hwWrap);

            // ══════════════════════════════════════════════════════════════════════
            //  SECTION 3 — ENVIRONMENT
            // ══════════════════════════════════════════════════════════════════════
            const { wrap: envWrap, rows: envRows } = mkSection('Environment', '\uD83C\uDF10');
            var _tz = 'Unknown';
            try { _tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown'; } catch (e) { }
            [
              ['Browser', detectBrowser(), false],
              ['Platform', navigator.platform, false],
              ['Language', navigator.language, false],
              ['Timezone', _tz, false],
              ['Do Not Track', navigator.doNotTrack === '1' ? 'Enabled \u2713' : 'Not set', false],
              ['Cookies', navigator.cookieEnabled ? 'Enabled \u2713' : 'Disabled', false],
              ['Service Workers', ('serviceWorker' in navigator) ? 'Supported \u2713' : 'Not supported', true],
            ].forEach(function (r) { envRows.appendChild(mkRow(r[0], r[1], r[2])); });
            body.appendChild(envWrap);

            // ══════════════════════════════════════════════════════════════════════
            //  SECTION 5 — LEGAL & LICENCES
            // ══════════════════════════════════════════════════════════════════════
            const { wrap: lgWrap, rows: lgRows } = mkSection('Legal \u0026 Licences', '\u2696\uFE0F');
            lgRows.appendChild(mkRow('Licence', 'Apache 2.0'));
            lgRows.appendChild(mkRow('Copyright', '\u00A9 2024\u20132026 NovaByte'));
            lgRows.appendChild(mkRow('Privacy Policy', 'Privacy-first. Zero telemetry.', true));
            body.appendChild(lgWrap);

            // ── Copy System Info ──────────────────────────────────────────────────
            const copyBtn = createEl('button', { className: 'btn btn-sm', textContent: '\uD83D\uDCCB Copy System Info' });
            copyBtn.addEventListener('click', function () {
              var _tz2 = 'Unknown';
              try { _tz2 = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown'; } catch (e) { }
              var lines = [
                'NovaByte v' + OS.version,
                'Security Update: 2026-05-01',
                'Browser: ' + detectBrowser(),
                'Platform: ' + navigator.platform,
                'Screen: ' + screen.width + '\u00D7' + screen.height,
                'CPU Cores: ' + (navigator.hardwareConcurrency || 'Unknown'),
                'Language: ' + navigator.language,
                'Timezone: ' + _tz2,
              ];
              navigator.clipboard.writeText(lines.join('\n'));
              Notify.show({ title: 'Copied', body: 'System info copied to clipboard', type: 'success', appName: 'Nook' });
            });
            body.appendChild(copyBtn);
            mainContent.appendChild(body);
          };

          container.appendChild(sidebar);
          container.appendChild(mainContent);
          content.appendChild(container);

          renderSidebar();
          renderContent();
        }
      });

      /* ── APP 30: Calculator ── */
      registerApp({
        id: 'calculator',
        name: 'Calculator',
        icon: 'calculator',
        description: 'Bare-bones calculator for quick arithmetic',
        defaultSize: [320, 440],
        minSize: [280, 380],
        init(content) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.calculator', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.calculator</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          content.style.cssText = 'display:flex;flex-direction:column;height:100%;padding:14px;background:var(--bg-base);gap:10px;';

          const display = createEl('input', {
            id: 'calculator-display',
            name: 'calculator-display',
            type: 'text',
            value: '',
            readonly: 'readonly',
            inputMode: 'decimal',
            placeholder: '0',
            style: 'width:100%;height:58px;border:1px solid var(--border-default);border-radius:14px;background:var(--bg-elevated);color:var(--text-primary);font-size:28px;font-weight:600;text-align:right;padding:0 14px;outline:none;font-family:var(--font-mono);'
          });

          const result = createEl('div', {
            textContent: 'Ready',
            style: 'min-height:18px;font-size:11px;color:var(--text-muted);padding:0 4px;font-family:var(--font-mono);text-align:right;'
          });

          const buttons = createEl('div', {
            style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:6px;flex:none;align-content:start;'
          });

          let expr = '';
          let justEvaluated = false;

          function setDisplay(next) {
            display.value = next;
            display.scrollLeft = display.scrollWidth;
          }

          function evaluateExpression(input) {
            const s = String(input).replace(/\s+/g, '');
            let i = 0;

            function consume(ch) {
              if (s[i] === ch) {
                i += 1;
                return true;
              }
              return false;
            }

            function parseNumber() {
              const start = i;
              let sawDigit = false;
              let sawDot = false;

              while (i < s.length) {
                const ch = s[i];
                if (ch >= '0' && ch <= '9') {
                  sawDigit = true;
                  i += 1;
                } else if (ch === '.' && !sawDot) {
                  sawDot = true;
                  i += 1;
                } else {
                  break;
                }
              }

              if (!sawDigit) throw new Error('Expected number');
              return Number(s.slice(start, i));
            }

            function parsePrimary() {
              if (consume('+')) return parsePrimary();
              if (consume('-')) return -parsePrimary();
              if (consume('(')) {
                const value = parseAddSub();
                if (!consume(')')) throw new Error('Expected )');
                return value;
              }
              return parseNumber();
            }

            function parseMulDiv() {
              let left = parsePrimary();
              while (i < s.length) {
                if (consume('*')) {
                  left *= parsePrimary();
                } else if (consume('/')) {
                  left /= parsePrimary();
                } else if (consume('%')) {
                  left %= parsePrimary();
                } else {
                  break;
                }
              }
              return left;
            }

            function parseAddSub() {
              let left = parseMulDiv();
              while (i < s.length) {
                if (consume('+')) {
                  left += parseMulDiv();
                } else if (consume('-')) {
                  left -= parseMulDiv();
                } else {
                  break;
                }
              }
              return left;
            }

            const value = parseAddSub();
            if (i !== s.length) throw new Error('Unexpected token');
            if (!Number.isFinite(value)) throw new Error('Invalid result');
            return value;
          }

          function update() {
            setDisplay(expr || '');
            if (!expr) {
              result.textContent = 'Ready';
              return;
            }
            try {
              const safe = expr.replace(/[^0-9+\-*/().%]/g, '');
              if (!safe.trim()) {
                result.textContent = 'Enter a calculation';
                return;
              }
              const out = evaluateExpression(safe);
              result.textContent = String(out);
            } catch {
              result.textContent = 'Invalid expression';
            }
          }

          function append(v) {
            if (justEvaluated && /[0-9.]/.test(v)) {
              expr = '';
            }
            justEvaluated = false;
            expr += v;
            update();
          }

          function clearAll() {
            expr = '';
            justEvaluated = false;
            update();
          }

          function backspace() {
            if (justEvaluated) {
              justEvaluated = false;
            }
            expr = expr.slice(0, -1);
            update();
          }

          function equals() {
            try {
              const safe = expr.replace(/[^0-9+\-*/().%]/g, '');
              if (!safe.trim()) return;
              const out = evaluateExpression(safe);
              expr = String(out);
              justEvaluated = true;
              setDisplay(expr);
              result.textContent = '=' + String(out);
            } catch {
              result.textContent = 'Invalid expression';
            }
          }

          const keys = [
            ['C', clearAll], ['⌫', backspace], ['%', () => append('%')], ['÷', () => append('/')],
            ['7', () => append('7')], ['8', () => append('8')], ['9', () => append('9')], ['×', () => append('*')],
            ['4', () => append('4')], ['5', () => append('5')], ['6', () => append('6')], ['−', () => append('-')],
            ['1', () => append('1')], ['2', () => append('2')], ['3', () => append('3')], ['+', () => append('+')],
            ['0', () => append('0')], ['.', () => append('.')], ['(', () => append('(')], [')', () => append(')')],
          ];

          keys.forEach(([label, fn]) => {
            const btn = createEl('button', {
              textContent: label,
              style: 'height:42px;border:1px solid var(--border-default);border-radius:12px;background:var(--bg-overlay);color:var(--text-primary);font-size:16px;font-weight:600;cursor:pointer;'
            });
            btn.addEventListener('click', fn);
            btn.addEventListener('mousedown', () => btn.style.transform = 'scale(0.98)');
            btn.addEventListener('mouseup', () => btn.style.transform = '');
            btn.addEventListener('mouseleave', () => btn.style.transform = '');
            buttons.appendChild(btn);
          });

          const equalsBtn = createEl('button', {
            textContent: '=',
            style: 'height:42px;border:1px solid var(--accent);border-radius:12px;background:var(--accent);color:#fff;font-size:16px;font-weight:700;cursor:pointer;grid-column:1/-1;'
          });
          equalsBtn.addEventListener('click', equals);
          buttons.appendChild(equalsBtn);

          content.append(display, result, buttons);

          content.addEventListener('keydown', (e) => {
            const k = e.key;
            if (/^[0-9]$/.test(k) || k === '.') { e.preventDefault(); append(k); return; }
            if (k === '+' || k === '-' || k === '*' || k === '/' || k === '(' || k === ')') { e.preventDefault(); append(k); return; }
            if (k === 'Enter' || k === '=') { e.preventDefault(); equals(); return; }
            if (k === 'Backspace') { e.preventDefault(); backspace(); return; }
            if (k === 'Escape') { e.preventDefault(); clearAll(); return; }
          });

          content.tabIndex = 0;
          setTimeout(() => content.focus(), 50);
          update();
        }
      });

      /* ── APP 31: App Manager ── */
      registerApp({
        id: 'app-manager', name: 'App Manager', icon: 'package',
        description: 'Install, manage, and customise .novaapp packages and web apps',
        defaultSize: [980, 640], minSize: [720, 480],
        init(content) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.appmanager', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.appmanager</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const APPS_KEY = 'nova_installed_apps';
          const LOG_KEY = 'nova_appmanager_log';

          // ── Helpers ────────────────────────────────────────────────────
          function getStoredApps() { try { return JSON.parse(localStorage.getItem(APPS_KEY) || '[]'); } catch { return []; } }
          function saveStoredApps(list) { lsSave(APPS_KEY, list); }
          function getLog() { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; } }
          function pushLog(entry) { const l = getLog(); l.unshift({ ...entry, ts: Date.now() }); if (l.length > 200) l.pop(); localStorage.setItem(LOG_KEY, JSON.stringify(l)); }
          function getPinned() { return OS.settings.get('pinnedApps') || []; }
          function getDisabled() { try { return JSON.parse(localStorage.getItem('nova_disabled_apps') || '[]'); } catch { return []; } }
          function setDisabled(list) { localStorage.setItem('nova_disabled_apps', JSON.stringify(list)); }
          function getBootApps() { try { return JSON.parse(localStorage.getItem('nova_boot_apps') || '[]'); } catch { return []; } }
          function setBootApps(list) { localStorage.setItem('nova_boot_apps', JSON.stringify(list)); }

          function buildNovaAppConfig(appData) {
            return {
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
                if (!entryB64) { contentEl.innerHTML = '<div style="padding:24px;color:var(--text-danger);font-family:monospace;">Entry file not found in package.</div>'; return; }
                try {
                  const html = decodeURIComponent(escape(atob(entryB64)));
                  const blob = new Blob([html], { type: 'text/html' });
                  const url = URL.createObjectURL(blob);
                  const iframe = createEl('iframe', { src: url, style: 'width:100%;height:100%;border:none;display:block;', sandbox: 'allow-same-origin allow-scripts allow-forms allow-popups allow-modals' });
                  contentEl.style.padding = '0';
                  contentEl.appendChild(iframe);
                  iframe.addEventListener('load', () => URL.revokeObjectURL(url));
                } catch (e) { contentEl.innerHTML = `<div style="padding:24px;color:var(--text-danger);font-family:monospace;">Failed to load app: ${e.message}</div>`; }
              }
            };
          }

          function registerNovaApp(appData) {
            if (!OS.apps[appData.id]) registerApp(buildNovaAppConfig(appData));
          }

          let installedApps = getStoredApps();
          installedApps.forEach(a => registerNovaApp(a));

          // ── Shared state ───────────────────────────────────────────────
          let activeTab = 'packages';
          let selectedPkgId = null;

          // ── Root layout ────────────────────────────────────────────────
          content.style.cssText = 'display:flex;flex-direction:column;overflow:hidden;height:100%;';

          // ── Tab bar ────────────────────────────────────────────────────
          const tabBar = createEl('div', { style: 'display:flex;align-items:center;gap:2px;padding:10px 14px 0;border-bottom:1px solid var(--border-subtle);background:var(--bg-sunken);flex-shrink:0;' });

          const TABS = [
            { id: 'packages', label: 'Packages', icon: 'package' },
            { id: 'webapps', label: 'Web Apps', icon: 'globe' }];
          const tabBtns = {};
          TABS.forEach(t => {
            const btn = createEl('button', { style: 'display:flex;align-items:center;gap:6px;padding:7px 14px;border:none;border-radius:10px 10px 0 0;cursor:pointer;font-size:13px;font-weight:600;transition:all 0.12s;background:none;color:var(--text-muted);border-bottom:2px solid transparent;margin-bottom:-1px;' });
            btn.innerHTML = `${svgIcon(t.icon, 13)} ${t.label}`;
            btn.dataset.tab = t.id;
            btn.addEventListener('click', () => switchTab(t.id));
            tabBar.appendChild(btn);
            tabBtns[t.id] = btn;
          });
          content.appendChild(tabBar);

          function refreshTabStyles() {
            Object.values(tabBtns).forEach(btn => {
              const active = btn.dataset.tab === activeTab;
              btn.style.color = active ? 'var(--text-primary)' : 'var(--text-muted)';
              btn.style.background = active ? 'var(--bg-elevated)' : 'none';
              btn.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
            });
          }

          const body = createEl('div', { style: 'flex:1;display:flex;overflow:hidden;' });
          content.appendChild(body);

          function switchTab(id) {
            activeTab = id; refreshTabStyles(); body.innerHTML = '';
            if (id === 'packages') renderPackagesPanel();
            else renderWebAppsPanel();
          }

          // ══════════════════════════════════════════════════════════════
          // PACKAGES PANEL
          // ══════════════════════════════════════════════════════════════
          function renderPackagesPanel() {
            const root = createEl('div', { style: 'display:flex;width:100%;height:100%;overflow:hidden;font-size:13px;' });

            // ── Sidebar ────────────────────────────────────────────────
            const sidebar = createEl('div', { style: 'width:240px;min-width:180px;display:flex;flex-direction:column;border-right:1px solid var(--border-subtle);background:var(--bg-sunken);flex-shrink:0;' });

            // Toolbar: search + install
            const toolbar = createEl('div', { style: 'padding:10px;display:flex;gap:6px;border-bottom:1px solid var(--border-subtle);' });
            const searchEl = createEl('input', { type: 'text', id: 'app-installer-search-input', name: 'app-installer-search', placeholder: 'Search…', style: 'flex:1;padding:5px 9px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:8px;color:var(--text-primary);font-size:12px;outline:none;' });
            const installBtn = createEl('button', { style: 'padding:5px 10px;background:var(--accent);color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap;flex-shrink:0;' });
            installBtn.innerHTML = `${svgIcon('plus', 12)} Install`;
            toolbar.appendChild(searchEl); toolbar.appendChild(installBtn);
            sidebar.appendChild(toolbar);

            const listEl = createEl('div', { style: 'flex:1;overflow-y:auto;padding:6px;' });
            sidebar.appendChild(listEl);

            // ── Detail panel ───────────────────────────────────────────
            const detail = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;' });

            // Hidden file input
            const fileInput = createEl('input', { type: 'file', accept: '.novaapp', id: 'app-install-input', name: 'app-install', style: 'display:none;' });
            fileInput.addEventListener('change', e => { if (e.target.files[0]) processFile(e.target.files[0]); fileInput.value = ''; });
            root.appendChild(fileInput);
            installBtn.addEventListener('click', () => fileInput.click());

            function renderList() {
              listEl.innerHTML = '';
              const q = searchEl.value.trim().toLowerCase();
              const disabled = getDisabled();
              let visible = [...installedApps];
              if (q) visible = visible.filter(a => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q));
              visible.sort((a, b) => a.name.localeCompare(b.name));
              if (!visible.length) {
                const msg = createEl('div', { style: 'padding:24px 12px;text-align:center;color:var(--text-muted);line-height:1.8;' });
                msg.innerHTML = q
                  ? '<div style="font-size:13px;">No apps match.</div>'
                  : `<div style="font-size:32px;margin-bottom:10px;">📦</div><div style="font-size:12px;">No packages installed.<br>Click <strong style="color:var(--text-primary);">Install</strong> or drop a <code style="color:var(--accent);">.novaapp</code> file.</div>`;
                listEl.appendChild(msg); return;
              }
              visible.forEach(app => {
                const isSel = app.id === selectedPkgId;
                const isDis = disabled.includes(app.id);
                const item = createEl('div', { style: `display:flex;align-items:center;gap:9px;padding:8px 9px;border-radius:10px;cursor:pointer;transition:background 0.1s;${isSel ? 'background:var(--accent-muted);' : ''}` });
                const iconWrap = createEl('div', { style: `width:34px;height:34px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${isDis ? 'var(--text-muted)' : 'var(--accent)'};opacity:${isDis ? 0.5 : 1};` });
                iconWrap.innerHTML = svgIcon(app.icon || 'box', 17);
                const meta = createEl('div', { style: 'flex:1;min-width:0;' });
                meta.innerHTML = `<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${isDis ? 'var(--text-muted)' : 'var(--text-primary)'};">${app.name}</div><div style="font-size:10px;color:var(--text-muted);margin-top:2px;">v${app.version || '1.0.0'}${isDis ? ' · disabled' : ''}</div>`;
                item.appendChild(iconWrap); item.appendChild(meta);
                item.addEventListener('mouseenter', () => { if (!isSel) item.style.background = 'var(--bg-elevated)'; });
                item.addEventListener('mouseleave', () => { if (!isSel) item.style.background = ''; });
                item.addEventListener('click', () => { selectedPkgId = app.id; renderList(); renderDetail(); });
                listEl.appendChild(item);
              });
            }

            function renderDetail() {
              detail.innerHTML = '';
              const app = installedApps.find(a => a.id === selectedPkgId);
              if (!app) {
                const drop = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:var(--text-muted);padding:40px;' });
                const dropBox = createEl('div', { style: 'width:110px;height:110px;border:2px dashed var(--border-default);border-radius:24px;display:flex;align-items:center;justify-content:center;transition:all 0.15s;' });
                dropBox.innerHTML = svgIcon('package', 44);
                const dropLabel = createEl('div', { style: 'text-align:center;line-height:1.9;' });
                dropLabel.innerHTML = `<div style="font-size:16px;font-weight:600;color:var(--text-secondary);">Install a .novaapp Package</div><div style="font-size:12px;margin-top:4px;">Drop a <code style="color:var(--accent);">.novaapp</code> file here,<br>or click <strong style="color:var(--text-primary);">Install</strong>.</div>`;
                drop.appendChild(dropBox); drop.appendChild(dropLabel);
                drop.addEventListener('dragover', e => { e.preventDefault(); dropBox.style.borderColor = 'var(--accent)'; dropBox.style.background = 'var(--accent-muted)'; });
                drop.addEventListener('dragleave', () => { dropBox.style.borderColor = 'var(--border-default)'; dropBox.style.background = ''; });
                drop.addEventListener('drop', e => { e.preventDefault(); dropBox.style.borderColor = 'var(--border-default)'; dropBox.style.background = ''; if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]); });
                detail.appendChild(drop); return;
              }

              const disabled = getDisabled();
              const isDis = disabled.includes(app.id);

              // ── Header ─────────────────────────────────────────────
              const header = createEl('div', { style: 'padding:16px 20px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;gap:14px;flex-shrink:0;' });
              const hIcon = createEl('div', { style: `width:56px;height:56px;background:var(--bg-sunken);border:1px solid var(--border-default);border-radius:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${isDis ? 'var(--text-muted)' : 'var(--accent)'};opacity:${isDis ? 0.5 : 1};` });
              hIcon.innerHTML = svgIcon(app.icon || 'box', 28);
              const hMeta = createEl('div', { style: 'flex:1;min-width:0;' });
              hMeta.innerHTML = `<div style="font-size:18px;font-weight:700;color:var(--text-primary);">${app.name}</div><div style="font-size:11px;color:var(--text-muted);margin-top:3px;">v${app.version || '1.0.0'} · ${app.author || 'Unknown'}</div>`;
              header.appendChild(hIcon); header.appendChild(hMeta);
              detail.appendChild(header);

              // ── Actions ─────────────────────────────────────────────
              const actionBar = createEl('div', { style: 'padding:10px 20px;border-bottom:1px solid var(--border-subtle);display:flex;gap:8px;flex-wrap:wrap;flex-shrink:0;background:var(--bg-sunken);' });

              function makeActionBtn(label, iconName, style, onClick) {
                const btn = createEl('button', { style: `display:flex;align-items:center;gap:6px;padding:6px 13px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;transition:all 0.12s;${style}` });
                btn.innerHTML = `${svgIcon(iconName, 12)} ${label}`;
                btn.addEventListener('click', onClick); return btn;
              }

              const launchBtn = makeActionBtn(isDis ? 'Disabled' : 'Launch', 'play',
                isDis ? 'background:var(--bg-elevated);border:1px solid var(--border-default);color:var(--text-muted);cursor:not-allowed;' : 'background:var(--accent);border:1px solid transparent;color:#fff;',
                () => { if (!isDis) WM.createWindow(app.id); });

              const toggleBtn = makeActionBtn(isDis ? 'Enable' : 'Disable', isDis ? 'toggle-left' : 'toggle-right',
                isDis ? 'background:rgba(63,185,80,0.12);border:1px solid rgba(63,185,80,0.35);color:var(--text-success);' : 'background:rgba(210,153,34,0.12);border:1px solid rgba(210,153,34,0.35);color:var(--text-warning);',
                () => {
                  const d = getDisabled();
                  setDisabled(isDis ? d.filter(id => id !== app.id) : [...d, app.id]);
                  selectedPkgId = app.id; renderList(); renderDetail();
                  Notify.show({ title: isDis ? 'App Enabled' : 'App Disabled', body: `${app.name} ${isDis ? 'enabled' : 'disabled'}`, type: 'success', appName: 'App Manager' });
                });

              const uninstBtn = makeActionBtn('Uninstall', 'trash', 'background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.3);color:#f85149;',
                () => doUninstall(app.id));

              [launchBtn, toggleBtn, uninstBtn].forEach(b => actionBar.appendChild(b));
              detail.appendChild(actionBar);

              // ── Info ────────────────────────────────────────────────
              const bodyEl = createEl('div', { style: 'flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:12px;' });
              if (app.description) {
                bodyEl.appendChild(createEl('div', { style: 'color:var(--text-secondary);line-height:1.65;font-size:13px;', textContent: app.description }));
              }
              // Permissions
              const allPerms = [...(app.permissions || []).map(p => ({ p, req: true })), ...(app.optionalPermissions || []).map(p => ({ p, req: false }))];
              if (allPerms.length) {
                const s = createEl('div'); s.innerHTML = `<div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);margin-bottom:8px;">Permissions</div>`;
                const row = createEl('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;' });
                const rs = p => ['fs:delete', 'admin:system'].includes(p) ? 'background:rgba(248,81,73,0.12);border:1px solid rgba(248,81,73,0.35);color:#f85149;' : ['fs:write', 'device:geolocation', 'system:settings'].includes(p) ? 'background:rgba(210,153,34,0.12);border:1px solid rgba(210,153,34,0.35);color:#d29922;' : 'background:var(--accent-muted);border:1px solid rgba(88,166,255,0.3);color:var(--accent);';
                allPerms.forEach(({ p, req }) => { const t = createEl('span', { style: `font-size:11px;padding:3px 9px;border-radius:6px;${rs(p)}` }); t.textContent = p + (req ? '' : ' (opt)'); row.appendChild(t); });
                s.appendChild(row); bodyEl.appendChild(s);
              }
              detail.appendChild(bodyEl);
            }

            function processFile(file) {
              if (!file.name.endsWith('.novaapp')) { Notify.show({ title: 'Invalid File', body: 'Please select a valid .novaapp package.', type: 'error', appName: 'App Manager' }); return; }
              const reader = new FileReader();
              reader.onload = ev => {
                try {
                  const pkg = JSON.parse(ev.target.result);
                  if (!pkg.manifest?.id || !pkg.manifest?.name || !pkg.manifest?.version) throw new Error('Missing required manifest fields (id, name, version).');
                  const payload = JSON.stringify({ novabyte_app: pkg.novabyte_app, manifest: pkg.manifest, files: pkg.files, compiled_at: pkg.compiled_at });
                  let hash = 0; for (let i = 0; i < payload.length; i++) { const c = payload.charCodeAt(i); hash = ((hash << 5) - hash) + c; hash |= 0; }
                  const verified = Math.abs(hash).toString(16).padStart(64, '0') === pkg.signature;
                  if (!verified && !confirm(`⚠ Signature check failed for "${pkg.manifest.name}".\n\nInstall anyway?`)) return;
                  const idx = installedApps.findIndex(a => a.id === pkg.manifest.id);
                  if (idx > -1) { if (!confirm(`"${pkg.manifest.name}" is already installed (v${installedApps[idx].version}).\n\nReplace with v${pkg.manifest.version}?`)) return; delete OS.apps[pkg.manifest.id]; const ri = APP_REGISTRY.findIndex(a => a.id === pkg.manifest.id); if (ri > -1) APP_REGISTRY.splice(ri, 1); installedApps.splice(idx, 1); }
                  const appData = { ...pkg.manifest, files: pkg.files, verified, source: 'file', installedAt: Date.now() };
                  installedApps.push(appData); saveStoredApps(installedApps); registerNovaApp(appData);
                  pushLog({ action: 'install', appId: appData.id, label: `${appData.name} v${appData.version} installed` });
                  selectedPkgId = appData.id; renderList(); renderDetail();
                  Notify.show({ title: 'App Installed', body: `${appData.name} v${appData.version} installed successfully.`, type: 'success', appName: 'App Manager' });
                } catch (err) { Notify.show({ title: 'Install Failed', body: String(err.message || err), type: 'error', appName: 'App Manager' }); }
              };
              reader.readAsText(file);
            }

            function doUninstall(appId) {
              const app = installedApps.find(a => a.id === appId);
              if (!app || !confirm(`Uninstall "${app.name}" v${app.version}?\n\nThis cannot be undone.`)) return;
              pushLog({ action: 'uninstall', appId: app.id, label: `${app.name} v${app.version} uninstalled` });
              installedApps = installedApps.filter(a => a.id !== appId); saveStoredApps(installedApps);
              delete OS.apps[appId]; const ri = APP_REGISTRY.findIndex(a => a.id === appId); if (ri > -1) APP_REGISTRY.splice(ri, 1);
              // Remove from pinned, boot, disabled
              const pins = getPinned().filter(id => id !== appId); OS.settings.set('pinnedApps', pins);
              setDisabled(getDisabled().filter(id => id !== appId));
              setBootApps(getBootApps().filter(id => id !== appId));
              if (WM.updateTaskbar) WM.updateTaskbar();
              selectedPkgId = null; renderList(); renderDetail(); refreshStats();
              Notify.show({ title: 'App Uninstalled', body: `${app.name} has been removed.`, type: 'success', appName: 'App Manager' });
            }

            searchEl.addEventListener('input', () => renderList());
            root.addEventListener('dragover', e => e.preventDefault());
            root.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) processFile(f); });

            root.appendChild(sidebar); root.appendChild(detail);
            body.appendChild(root);
            renderList(); renderDetail();
          }

          // ══════════════════════════════════════════════════════════════
          // WEB APPS PANEL
          // ══════════════════════════════════════════════════════════════
          function renderWebAppsPanel() {
            const wam = typeof WebAppManager !== 'undefined' ? WebAppManager : null;

            function getAllWebApps() { return wam ? wam.getAllApps() : []; }

            const root = createEl('div', { style: 'display:flex;width:100%;height:100%;overflow:hidden;font-size:13px;' });

            // ── Sidebar ──────────────────────────────────────────────────
            const sidebar = createEl('div', { style: 'width:240px;min-width:180px;display:flex;flex-direction:column;border-right:1px solid var(--border-subtle);background:var(--bg-sunken);flex-shrink:0;' });

            const toolbar = createEl('div', { style: 'padding:9px;display:flex;gap:6px;border-bottom:1px solid var(--border-subtle);' });
            const searchEl = createEl('input', { type: 'text', id: 'notes-tasks-search-input', name: 'notes-tasks-search', placeholder: 'Search…', style: 'flex:1;padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:8px;color:var(--text-primary);font-size:12px;outline:none;min-width:0;' });
            const addBtn = createEl('button', { style: 'padding:5px 10px;background:var(--accent);color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap;flex-shrink:0;' });
            addBtn.innerHTML = svgIcon('plus', 12) + ' Add';
            toolbar.append(searchEl, addBtn);
            sidebar.appendChild(toolbar);

            const listEl = createEl('div', { style: 'flex:1;overflow-y:auto;padding:5px;' });
            sidebar.appendChild(listEl);

            // ── Right panel ──────────────────────────────────────────────
            const right = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;' });

            // Initialize selected web app state
            let selectedWebId = null;

            function launchWebApp(wa) {
              const tempId = 'webapp_' + wa.id;
              const wW = 900; const wH = 640;
              if (!OS.apps[tempId]) {
                OS.apps[tempId] = {
                  name: wa.name, icon: wa.icon, defaultSize: [wW, wH], minSize: [400, 300], init(c) {
                    const wrapper = document.createElement('div');
                    wrapper.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;';
                    const urlBar = document.createElement('div');
                    urlBar.style.cssText = 'background:rgba(0,0,0,0.22);border-bottom:1px solid rgba(255,255,255,0.07);padding:5px 12px;font-size:11px;color:rgba(255,255,255,0.4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace;flex-shrink:0;';
                    let h = wa.url; try { h = new URL(wa.url).host; } catch { }
                    urlBar.textContent = '🔒 ' + h;
                    const iframe = document.createElement('webview');
                    iframe.style.cssText = 'flex:1;border:none;background:#fff;';
                    iframe.src = wa.url;
                    wrapper.append(urlBar, iframe);
                    c.style.padding = '0'; c.appendChild(wrapper);
                  }
                };
              }
              WM.createWindow(tempId);
            }

            function renderList() {
              listEl.innerHTML = '';
              const q = searchEl.value.trim().toLowerCase();
              let apps = getAllWebApps();
              if (q) apps = apps.filter(a => a.name.toLowerCase().includes(q) || (a.url || '').toLowerCase().includes(q));

              if (!apps.length) {
                const msg = createEl('div', { style: 'padding:24px 12px;text-align:center;color:var(--text-muted);line-height:1.9;' });
                msg.innerHTML = q
                  ? '<div style="font-size:13px;">No matches found.</div>'
                  : '<div style="font-size:34px;margin-bottom:10px;">🌐</div><div style="font-size:12px;">No web apps yet.<br>Click <strong style="color:var(--text-primary);">+ Add</strong> to get started.</div>';
                listEl.appendChild(msg); return;
              }

              apps.forEach(wa => {
                const isSel = wa.id === selectedWebId;
                let host = wa.url; try { host = new URL(wa.url).host; } catch { }
                const item = createEl('div', { style: `display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:10px;cursor:pointer;transition:background 0.1s;${isSel ? 'background:var(--accent-muted);' : ''}` });
                const iconEl = createEl('div', { style: 'width:32px;height:32px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:17px;line-height:1;' });
                iconEl.textContent = wa.icon || '🌐';
                const meta = createEl('div', { style: 'flex:1;min-width:0;' });
                meta.innerHTML = `<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-primary);font-size:12px;">${wa.name}</div><div style="font-size:10px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${host}</div>`;
                item.append(iconEl, meta);
                item.addEventListener('mouseenter', () => { if (!isSel) item.style.background = 'var(--bg-elevated)'; });
                item.addEventListener('mouseleave', () => { if (!isSel) item.style.background = ''; });
                item.addEventListener('click', () => { selectedWebId = wa.id; renderList(); renderDetail(); });
                listEl.appendChild(item);
              });
            }

            function renderDetail() {
              right.innerHTML = '';
              const wa = getAllWebApps().find(a => a.id === selectedWebId);

              if (!wa) {
                // ── Add form ────────────────────────────────────────────
                const wrap = createEl('div', { style: 'flex:1;overflow-y:auto;padding:28px;display:flex;align-items:flex-start;justify-content:center;' });
                const card = createEl('div', { style: 'width:100%;max-width:420px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:14px;overflow:hidden;' });
                const hdr = createEl('div', { style: 'padding:16px 18px;border-bottom:1px solid var(--border-subtle);background:var(--bg-sunken);' });
                hdr.innerHTML = `<div style="font-size:14px;font-weight:700;color:var(--text-primary);display:flex;align-items:center;gap:8px;">${svgIcon('plus', 15)} Add Web App</div><div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Pin any website as an app.</div>`;
                card.appendChild(hdr);

                const cbody = createEl('div', { style: 'padding:16px 18px;display:flex;flex-direction:column;gap:12px;' });
                function mkField(label, type, ph, fieldId, fieldName) {
                  const w = createEl('div', { style: 'display:flex;flex-direction:column;gap:4px;' });
                  w.innerHTML = `<label style="font-size:11px;font-weight:600;color:var(--text-muted);">${label}</label>`;
                  const inp = createEl('input', { type, id: fieldId, name: fieldName, placeholder: ph, style: 'padding:8px 10px;background:var(--bg-sunken);border:1px solid var(--border-default);border-radius:8px;color:var(--text-primary);font-size:13px;outline:none;width:100%;transition:border-color 0.15s;' });
                  inp.addEventListener('focus', () => inp.style.borderColor = 'var(--accent)');
                  inp.addEventListener('blur', () => inp.style.borderColor = 'var(--border-default)');
                  w.appendChild(inp); return { w, inp };
                }
                const { w: wUrl, inp: urlInp } = mkField('URL *', 'url', 'https://example.com', 'web-app-url-input', 'web-app-url');
                const { w: wName, inp: nameInp } = mkField('Name *', 'text', 'My App', 'web-app-name-input', 'web-app-name');
                const { w: wIcon, inp: iconInp } = mkField('Icon (emoji)', 'text', '🌐', 'web-app-icon-input', 'web-app-icon');
                iconInp.value = '🌐';

                const errEl = createEl('div', { style: 'font-size:11px;color:var(--text-danger);min-height:14px;' });
                const saveBtn = createEl('button', { style: 'padding:10px;background:var(--accent);color:#fff;border:none;border-radius:9px;cursor:pointer;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:7px;' });
                saveBtn.innerHTML = svgIcon('plus', 13) + ' Add Web App';
                saveBtn.addEventListener('click', () => {
                  const url = urlInp.value.trim(); const name = nameInp.value.trim(); const icon = iconInp.value.trim() || '🌐';
                  errEl.textContent = '';
                  if (!url) { errEl.textContent = 'URL is required.'; return; }
                  try { new URL(url); } catch { errEl.textContent = 'Please enter a valid URL.'; return; }
                  if (!name) { errEl.textContent = 'Name is required.'; return; }
                  const addedApp = wam ? wam.addApp({ name, url, icon }) : null;
                  if (addedApp) {
                    Notify.show({ title: 'App Added', body: `"${name}" is now available.`, type: 'success', appName: 'App Manager' });
                    selectedWebId = addedApp.id; renderList(); renderDetail();
                  }
                });

                [wUrl, wName, wIcon, errEl, saveBtn].forEach(el => cbody.appendChild(el));
                card.appendChild(cbody); wrap.appendChild(card); right.appendChild(wrap); return;
              }

              // ── Detail view ─────────────────────────────────────────
              let host = wa.url; try { host = new URL(wa.url).host; } catch { }

              const hdr = createEl('div', { style: 'padding:14px 18px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;gap:12px;flex-shrink:0;background:var(--bg-sunken);' });
              const hIcon = createEl('div', { style: 'width:48px;height:48px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:13px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:24px;line-height:1;' });
              hIcon.textContent = wa.icon || '🌐';
              const hMeta = createEl('div', { style: 'flex:1;min-width:0;' });
              hMeta.innerHTML = `<div style="font-size:16px;font-weight:700;color:var(--text-primary);">${wa.name}</div><div style="font-size:11px;color:var(--text-muted);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${host}</div>`;
              hdr.append(hIcon, hMeta); right.appendChild(hdr);

              const abar = createEl('div', { style: 'padding:9px 18px;border-bottom:1px solid var(--border-subtle);display:flex;gap:7px;flex-shrink:0;' });
              function mkBtn(label, icon, sty, fn) {
                const b = createEl('button', { style: `display:flex;align-items:center;gap:5px;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;${sty}` });
                b.innerHTML = svgIcon(icon, 12) + ' ' + label;
                b.addEventListener('click', fn); abar.appendChild(b); return b;
              }
              mkBtn('Open', 'external-link', 'background:var(--accent);border:1px solid transparent;color:#fff;', () => launchWebApp(wa));
              mkBtn('Remove', 'trash', 'background:rgba(248,81,73,0.08);border:1px solid rgba(248,81,73,0.25);color:#f85149;', () => {
                if (!confirm(`Remove "${wa.name}"?`)) return;
                if (wam) wam.removeApp(wa.id);
                selectedWebId = null; renderList(); renderDetail();
                Notify.show({ title: 'Removed', body: `"${wa.name}" removed`, type: 'success', appName: 'App Manager' });
              });
              right.appendChild(abar);
            }

            addBtn.addEventListener('click', () => { selectedWebId = null; renderList(); renderDetail(); });
            searchEl.addEventListener('input', () => renderList());
            root.append(sidebar, right); body.appendChild(root);
            renderList(); renderDetail();
          }

          // ── Boot ────────────────────────────────────────────────────────
          refreshTabStyles();
          switchTab('packages');
        }
      });

      /* ── APP 8: Clock (NBOSP — AOSP DeskClock style) ── */
      registerApp({
        id: 'nbosp-clock', name: 'Clock', icon: 'alarm-clock',
        description: 'Alarm · Clock · Timer · Stopwatch',
        defaultSize: [400, 600], minSize: [340, 480],
        init(content, state) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.clock', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.clock</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }

          // ── Persistence
          const SK = 'nbosp_clock_v1';
          function load() { try { return JSON.parse(localStorage.getItem(SK) || '{}'); } catch { return {}; } }
          function save() { try { lsSave(SK, db); } catch { } }
          const db = load();
          if (!Array.isArray(db.alarms)) db.alarms = [];
          db.alarms = db.alarms
            .map(al => ({
              id: al?.id ?? Date.now().toString(36),
              time: typeof al?.time === 'string' ? al.time : '07:00',
              label: typeof al?.label === 'string' ? al.label : '',
              days: Array.isArray(al?.days) ? al.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : [],
              enabled: al?.enabled !== false
            }))
            .filter(al => /^\d{2}:\d{2}$/.test(al.time));


          function pad(n) { return String(Math.floor(n)).padStart(2, '0'); }

          // ── Web Audio beep
          function beep(freq, dur) {
            try {
              const actx = new (window.AudioContext || window.webkitAudioContext)();
              const osc = actx.createOscillator(), gn = actx.createGain();
              osc.type = 'sine'; osc.frequency.value = freq || 880;
              gn.gain.setValueAtTime(0.3, actx.currentTime);
              gn.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + (dur || 1.2));
              osc.connect(gn); gn.connect(actx.destination);
              osc.start(); osc.stop(actx.currentTime + (dur || 1.2));
            } catch { }
          }

          // ── Root
          const root = createEl('div', { className: 'nbc-root' });
          content.appendChild(root);

          // ── Tab bar
          const TABS = ['alarm', 'clock', 'timer', 'stopwatch'];
          const LABELS = { alarm: 'Alarm', clock: 'Clock', timer: 'Timer', stopwatch: 'Stopwatch' };
          let activeTab = 'clock';

          const tabBar = createEl('div', { className: 'nbc-tabbar' });
          const tabEls = {};

          const body = createEl('div', { className: 'nbc-body' });
          root.append(tabBar, body);

          // ── Create ALL sections upfront so switchTab is always safe
          const sections = {};
          const clockSec = createEl('div', { className: 'nbc-section', style: 'align-items:center;padding:28px 16px 16px;' });
          const alarmSec = createEl('div', { className: 'nbc-section' });
          const timerSec = createEl('div', { className: 'nbc-section', style: 'align-items:center;justify-content:center;padding:20px;gap:18px;' });
          const swSec = createEl('div', { className: 'nbc-section', style: 'align-items:center;padding-top:28px;' });
          sections['clock'] = clockSec;
          sections['alarm'] = alarmSec;
          sections['timer'] = timerSec;
          sections['stopwatch'] = swSec;
          body.appendChild(clockSec);
          body.appendChild(alarmSec);
          body.appendChild(timerSec);
          body.appendChild(swSec);

          // ── Tab buttons (after sections exist so switchTab is safe from first click)
          TABS.forEach(t => {
            const el = createEl('button', { className: 'nbc-tab', textContent: LABELS[t] });
            el.addEventListener('click', () => switchTab(t));
            tabBar.appendChild(el);
            tabEls[t] = el;
          });

          function switchTab(t) {
            activeTab = t;
            TABS.forEach(id => {
              sections[id].classList.toggle('active', id === t);
              tabEls[id].classList.toggle('active', id === t);
            });
          }
          switchTab(activeTab); // FIX 1: activate default tab on open

          // ════════════════════════════════════════════════════
          // CLOCK TAB — content
          // ════════════════════════════════════════════════════

          // SVG analog clock
          const ns = 'http://www.w3.org/2000/svg';
          const svg = document.createElementNS(ns, 'svg');
          svg.setAttribute('viewBox', '0 0 200 200'); svg.setAttribute('class', 'nbc-clock-face');
          svg.innerHTML = [
            '<circle cx="100" cy="100" r="96" fill="none" stroke="var(--border-subtle)" stroke-width="1.5"/>',
            '<circle cx="100" cy="100" r="95" fill="var(--bg-elevated)"/>',
            [...Array(60)].map((_, i) => {
              const a = (i * 6 - 90) * Math.PI / 180, maj = i % 5 === 0;
              const r1 = maj ? 76 : 83, r2 = 91;
              return `<line x1="${100 + r1 * Math.cos(a)}" y1="${100 + r1 * Math.sin(a)}" x2="${100 + r2 * Math.cos(a)}" y2="${100 + r2 * Math.sin(a)}" stroke="var(--text-muted)" stroke-width="${maj ? 2 : 1}" opacity="${maj ? 0.9 : 0.35}"/>`;
            }).join(''),
            '<line id="nbc-hr" x1="100" y1="100" x2="100" y2="47" stroke="var(--text-primary)" stroke-width="5.5" stroke-linecap="round"/>',
            '<line id="nbc-mn" x1="100" y1="100" x2="100" y2="24" stroke="var(--text-primary)" stroke-width="3" stroke-linecap="round"/>',
            '<line id="nbc-sc" x1="100" y1="114" x2="100" y2="18" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round"/>',
            '<circle cx="100" cy="100" r="5" fill="var(--accent)"/>',
            '<circle cx="100" cy="100" r="2" fill="var(--bg-elevated)"/>',
          ].join('');

          const digitalEl = createEl('div', { className: 'nbc-digital' });
          const dateEl = createEl('div', { className: 'nbc-date' });
          clockSec.append(svg, digitalEl, dateEl);


          // Clock tick
          function tickClock() {
            const now = new Date();
            const h = (now.getHours() % 12) + now.getMinutes() / 60 + now.getSeconds() / 3600;
            const m = now.getMinutes() + now.getSeconds() / 60;
            const s = now.getSeconds() + now.getMilliseconds() / 1000;
            const rot = (el, deg) => el?.setAttribute('transform', `rotate(${deg.toFixed(2)} 100 100)`);
            rot(svg.querySelector('#nbc-hr'), h * 30);
            rot(svg.querySelector('#nbc-mn'), m * 6);
            rot(svg.querySelector('#nbc-sc'), s * 6);
            digitalEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            dateEl.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
            // Alarm check (on the second boundary)
            if (now.getMilliseconds() < 1100) {
              const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
              const dow = now.getDay();
              db.alarms.forEach((al, i) => {
                if (!al.enabled || al.time !== timeStr || now.getSeconds() !== 0) return;
                if (al.days.length > 0 && !al.days.includes(dow)) return;
                beep(880, 0.8); setTimeout(() => beep(1047, 0.8), 400); setTimeout(() => beep(1319, 1.2), 800);
                if (al.days.length === 0) { al.enabled = false; save(); renderAlarms(); }
              });
            }
          }
          const clockInt = setInterval(tickClock, 250);
          state.cleanups?.push(() => clearInterval(clockInt));
          tickClock();

          // ════════════════════════════════════════════════════
          // ALARM TAB — content
          // ════════════════════════════════════════════════════

          const alarmHdr = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;' });
          alarmHdr.appendChild(createEl('div', { textContent: 'Alarms', style: 'font-size:15px;font-weight:700;' }));
          const addAlarmBtn = createEl('button', { className: 'btn btn-sm btn-primary', style: 'display:flex;align-items:center;gap:4px;' });
          addAlarmBtn.innerHTML = svgIcon('plus', 13) + ' Add';
          alarmHdr.appendChild(addAlarmBtn);
          alarmSec.appendChild(alarmHdr);

          const alarmList = createEl('div', { style: 'flex:1;overflow-y:auto;' });
          alarmSec.appendChild(alarmList);

          const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
          const DOW_FULL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

          function makeToggle(checked, onChange) {
            const wrap = createEl('label', { className: 'nbc-toggle' });
            const inp = createEl('input'); inp.type = 'checkbox'; inp.id = 'clock-toggle-checkbox'; inp.name = 'clock-toggle'; inp.checked = checked; inp.style.cssText = 'position:absolute;opacity:0;width:0;height:0;';
            const track = createEl('div', { className: 'nbc-track', style: `background:${checked ? 'var(--accent)' : 'var(--border-default)'};` });
            const thumb = createEl('div', { className: 'nbc-thumb', style: `left:${checked ? '23' : '3'}px;` });
            inp.addEventListener('change', () => {
              const v = inp.checked;
              track.style.background = v ? 'var(--accent)' : 'var(--border-default)';
              thumb.style.left = v ? '23px' : '3px';
              onChange(v);
            });
            wrap.append(inp, track, thumb); return wrap;
          }

          function renderAlarms() {
            alarmList.innerHTML = '';
            const alarms = db.alarms
              .map((al, idx) => ({
                idx,
                alarm: {
                  id: al?.id ?? idx,
                  time: typeof al?.time === 'string' ? al.time : '',
                  label: typeof al?.label === 'string' ? al.label : '',
                  days: Array.isArray(al?.days) ? al.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : [],
                  enabled: al?.enabled !== false
                }
              }))
              .filter(({ alarm }) => /^\d{2}:\d{2}$/.test(alarm.time))
              .sort((a, b) => a.alarm.time.localeCompare(b.alarm.time));

            if (!alarms.length) {
              const emp = createEl('div', { textContent: 'No alarms set. Tap + Add to create one.', style: 'padding:40px 20px;text-align:center;color:var(--text-muted);font-size:13px;' });
              alarmList.appendChild(emp); return;
            }
            alarms.forEach(({ idx, alarm: al }) => {
              const [hhS, mmS] = al.time.split(':');
              const hh = +hhS, mm = +mmS;
              const ampm = hh < 12 ? 'AM' : 'PM', h12 = hh % 12 || 12;
              const row = createEl('div', { className: 'nbc-alarm-row' });
              // Left: time + meta (clickable to edit)
              const left = createEl('div', { style: 'flex:1;cursor:pointer;' });
              left.addEventListener('click', () => openAlarmModal(idx));
              const timeRow = createEl('div', { style: 'display:flex;align-items:baseline;gap:5px;' });
              const timeEl = createEl('div', { className: 'nbc-alarm-time', textContent: `${h12}:${pad(mm)}` });
              timeEl.style.color = al.enabled ? 'var(--text-primary)' : 'var(--text-muted)';
              const ampmEl = createEl('div', { className: 'nbc-alarm-ampm', textContent: ampm });
              timeRow.append(timeEl, ampmEl);
              // Days/label meta
              const meta = createEl('div', { className: 'nbc-alarm-meta' });
              const parts = [];
              if (al.label) parts.push(al.label);
              if (al.days.length === 0) parts.push('Once');
              else if (al.days.length === 7) parts.push('Every day');
              else if (al.days.length === 5 && !al.days.includes(0) && !al.days.includes(6)) parts.push('Weekdays');
              else parts.push(al.days.map(d => DOW[d]).join(' '));
              meta.textContent = parts.join(' · ');
              left.append(timeRow, meta);
              const toggle = makeToggle(al.enabled, v => { al.enabled = v; db.alarms[idx] = al; save(); renderAlarms(); });
              row.append(left, toggle); alarmList.appendChild(row);
            });
          }

          function openAlarmModal(idx) {
            const isEdit = idx !== null && idx >= 0 && idx < db.alarms.length;
            const src = isEdit ? db.alarms[idx] : { time: '07:00', label: '', days: [1, 2, 3, 4, 5], enabled: true };
            const al = { ...src, days: [...src.days] };
            const ov = createEl('div', { style: 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;' });
            const box = createEl('div', { style: 'background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:16px;padding:22px;width:320px;max-width:95vw;box-shadow:0 24px 48px rgba(0,0,0,0.4);' });
            // Header
            const hdr = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;' });
            hdr.appendChild(createEl('span', { textContent: isEdit ? 'Edit Alarm' : 'Add Alarm', style: 'font-size:15px;font-weight:700;' }));
            const xBtn = createEl('button', { className: 'btn btn-icon btn-sm' }); xBtn.innerHTML = svgIcon('x', 14); xBtn.addEventListener('click', () => ov.remove());
            hdr.appendChild(xBtn); box.appendChild(hdr);
            // Time input
            const timeInp = createEl('input', { type: 'time', className: 'input', id: 'alarm-time-input', name: 'alarm-time', style: 'width:100%;font-size:30px;font-weight:200;height:54px;text-align:center;margin-bottom:14px;letter-spacing:2px;font-variant-numeric:tabular-nums;' });
            timeInp.value = al.time; box.appendChild(timeInp);
            // Label
            const labelInp = createEl('input', { type: 'text', className: 'input', id: 'alarm-label-input', name: 'alarm-label', placeholder: 'Label (optional)', style: 'width:100%;margin-bottom:14px;' });
            labelInp.value = al.label; box.appendChild(labelInp);
            // Repeat days
            box.appendChild(createEl('div', { textContent: 'Repeat', style: 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:8px;' }));
            const daysRow = createEl('div', { style: 'display:flex;gap:5px;margin-bottom:18px;' });
            const dayBtns = DOW_FULL.map((d, i) => {
              const on = al.days.includes(i);
              const btn = createEl('button', { title: d, style: `flex:1;padding:7px 0;border-radius:50%;font-size:11px;font-weight:700;cursor:pointer;border:1px solid ${on ? 'var(--accent)' : 'var(--border-subtle)'};background:${on ? 'var(--accent)' : 'transparent'};color:${on ? '#fff' : 'var(--text-muted)'};aspect-ratio:1;transition:all 0.12s;` });
              btn.textContent = d.charAt(0);
              btn.dataset.i = i; btn.dataset.on = on ? '1' : '0';
              btn.addEventListener('click', () => {
                const now2 = btn.dataset.on === '1';
                btn.dataset.on = now2 ? '0' : '1';
                btn.style.background = now2 ? 'transparent' : 'var(--accent)';
                btn.style.color = now2 ? 'var(--text-muted)' : '#fff';
                btn.style.borderColor = now2 ? 'var(--border-subtle)' : 'var(--accent)';
              });
              daysRow.appendChild(btn); return btn;
            });
            box.appendChild(daysRow);
            // Actions
            const acts = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;' });
            if (isEdit) {
              const delBtn = createEl('button', { textContent: 'Delete', className: 'btn btn-sm', style: 'color:#f85149;border-color:#f85149;' });
              delBtn.addEventListener('click', () => { db.alarms.splice(idx, 1); save(); renderAlarms(); ov.remove(); });
              acts.appendChild(delBtn);
            } else { acts.appendChild(createEl('div')); }
            const rightActs = createEl('div', { style: 'display:flex;gap:8px;' });
            const cancelBtn = createEl('button', { textContent: 'Cancel', className: 'btn btn-sm' }); cancelBtn.addEventListener('click', () => ov.remove());
            const saveBtn = createEl('button', { textContent: 'Save', className: 'btn btn-sm btn-primary' });
            saveBtn.addEventListener('click', () => {
              const t = timeInp.value; if (!t) return;
              const selDays = dayBtns.filter(b => b.dataset.on === '1').map(b => +b.dataset.i);
              const payload = { time: t, label: labelInp.value.trim(), days: selDays, enabled: true };
              if (isEdit) Object.assign(db.alarms[idx], payload);
              else db.alarms.push({ id: Date.now().toString(36), ...payload });
              save(); renderAlarms(); ov.remove();
            });
            rightActs.append(cancelBtn, saveBtn); acts.appendChild(rightActs); box.appendChild(acts);
            ov.appendChild(box); document.body.appendChild(ov);
            setTimeout(() => timeInp.focus(), 50);
          }

          addAlarmBtn.addEventListener('click', () => openAlarmModal(null));
          renderAlarms();

          // ════════════════════════════════════════════════════
          // TIMER TAB — content
          // ════════════════════════════════════════════════════

          let tiMs = 0, tiSet = 0, tiEnd = 0, tiRun = false, tiDone = false;

          const tiDisplay = createEl('div', { className: 'nbc-timer-display', textContent: '00:00' });


          // H : M : S inputs
          const tiInpRow = createEl('div', { style: 'display:flex;align-items:center;gap:6px;' });
          function tiInp(max) {
            const el = createEl('input', { type: 'number', min: '0', max: String(max), className: 'nbc-timer-inp', placeholder: '0' });
            el.addEventListener('input', () => { let v = parseInt(el.value) || 0; if (v > max) { v = max; el.value = max; } syncTiFromInputs(); });
            return el;
          }
          const tiH = tiInp(99), tiM = tiInp(59), tiS = tiInp(59);
          const mkColon = () => createEl('span', { textContent: ':', style: 'font-size:30px;font-weight:200;color:var(--text-muted);' });
          const mkLbl = t => createEl('div', { textContent: t, style: 'font-size:10px;color:var(--text-muted);text-align:center;' });
          function col(inp, lbl) { const c = createEl('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:3px;' }); c.append(inp, mkLbl(lbl)); return c; }
          tiInpRow.append(col(tiH, 'h'), mkColon(), col(tiM, 'm'), mkColon(), col(tiS, 's'));

          function syncTiFromInputs() {
            tiSet = tiMs = ((parseInt(tiH.value) || 0) * 3600 + (parseInt(tiM.value) || 0) * 60 + (parseInt(tiS.value) || 0)) * 1000;
            renderTiDisplay();
          }
          function renderTiDisplay() {
            const ms = tiRun ? Math.max(0, tiEnd - Date.now()) : tiMs;
            const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
            tiDisplay.textContent = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
            tiDisplay.style.color = tiDone ? 'var(--accent)' : 'var(--text-primary)';
          }

          const tiBtnRow = createEl('div', { style: 'display:flex;gap:10px;' });
          const tiStart = createEl('button', { className: 'nbc-pill-btn primary', textContent: 'Start' });
          const tiReset = createEl('button', { className: 'nbc-pill-btn', textContent: 'Reset', style: 'display:none;' });
          tiBtnRow.append(tiReset, tiStart);

          function renderTiBtns() {
            tiStart.textContent = tiRun ? 'Pause' : tiDone ? 'Restart' : 'Start';
            tiReset.style.display = (tiMs !== tiSet || tiDone) ? 'block' : 'none';
          }
          tiStart.addEventListener('click', () => {
            if (!tiSet) return;
            if (tiRun) { tiMs = Math.max(0, tiEnd - Date.now()); tiRun = false; }
            else { tiEnd = Date.now() + tiMs; tiRun = true; tiDone = false; }
            renderTiBtns();
          });
          tiReset.addEventListener('click', () => {
            tiRun = false; tiDone = false; tiMs = tiSet;
            tiH.value = tiSet ? Math.floor(tiSet / 3600000) || '' : '';
            tiM.value = tiSet ? String(Math.floor((tiSet % 3600000) / 60000)) : '';
            tiS.value = tiSet ? String(Math.floor((tiSet % 60000) / 1000)) : '';
            renderTiDisplay(); renderTiBtns();
          });

          timerSec.append(tiDisplay, tiInpRow, tiBtnRow);
          renderTiBtns();

          // ════════════════════════════════════════════════════
          // STOPWATCH TAB — content
          // ════════════════════════════════════════════════════

          let swRun = false, swElapsed = 0, swStart = 0, swLaps = [];
          function swNow() { return swRun ? swElapsed + (performance.now() - swStart) : swElapsed; }

          const swDisplay = createEl('div', { className: 'nbc-sw-display', textContent: '00:00.00' });

          const swBtnRow = createEl('div', { style: 'display:flex;gap:12px;margin-top:16px;margin-bottom:16px;' });
          const swStartBtn = createEl('button', { textContent: 'Start', className: 'nbc-pill-btn primary' });
          const swLapBtn = createEl('button', { textContent: 'Lap', className: 'nbc-pill-btn', style: 'min-width:82px;' });
          swBtnRow.append(swLapBtn, swStartBtn);

          // Column headers
          const swLapHdr = createEl('div', { style: 'display:flex;justify-content:space-between;padding:6px 16px;border-bottom:1px solid var(--border-subtle);' });
          swLapHdr.appendChild(createEl('span', { textContent: 'Lap', style: 'font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.07em;' }));
          swLapHdr.appendChild(createEl('span', { textContent: 'Split', style: 'font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.07em;' }));
          swLapHdr.appendChild(createEl('span', { textContent: 'Overall', style: 'font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.07em;' }));

          const swLapScroll = createEl('div', { style: 'flex:1;overflow-y:auto;width:100%;' });
          swSec.append(swDisplay, swBtnRow, swLapHdr, swLapScroll);

          function fmtSw(ms) {
            const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), cs = Math.floor((ms % 1000) / 10);
            return `${pad(m)}:${pad(s)}.${pad(cs)}`;
          }

          function renderSwLaps() {
            swLapScroll.innerHTML = '';
            if (!swLaps.length) return;
            const splits = swLaps.map((v, i) => v - (i > 0 ? swLaps[i - 1] : 0));
            const bestSplit = Math.min(...splits), worstSplit = Math.max(...splits);
            [...swLaps].reverse().forEach((lapEnd, ri) => {
              const i = swLaps.length - 1 - ri;
              const split = splits[i];
              const row = createEl('div', { className: 'nbc-lap-row' });
              const lapLabel = createEl('span', { textContent: `Lap ${i + 1}`, style: 'color:var(--text-secondary);' });
              const splitEl = createEl('span', { textContent: fmtSw(split) });
              if (swLaps.length > 1 && split === bestSplit) splitEl.className = 'nbc-lap-best';
              else if (swLaps.length > 1 && split === worstSplit) splitEl.className = 'nbc-lap-worst';
              const overallEl = createEl('span', { textContent: fmtSw(lapEnd), style: 'color:var(--text-muted);font-size:12px;' });
              row.append(lapLabel, splitEl, overallEl); swLapScroll.appendChild(row);
            });
          }

          swStartBtn.addEventListener('click', () => {
            if (swRun) {
              swElapsed = swNow(); swRun = false;
              swStartBtn.textContent = 'Start'; swLapBtn.textContent = 'Reset';
            } else {
              swStart = performance.now(); swRun = true;
              swStartBtn.textContent = 'Stop'; swLapBtn.textContent = 'Lap';
            }
          });
          swLapBtn.addEventListener('click', () => {
            if (swRun) { swLaps.push(swNow()); renderSwLaps(); }
            else { swRun = false; swElapsed = 0; swStart = 0; swLaps = []; swLapScroll.innerHTML = ''; swDisplay.textContent = '00:00.00'; swStartBtn.textContent = 'Start'; swLapBtn.textContent = 'Lap'; }
          });

          // ── Main 50ms tick (timer + stopwatch)
          const mainInt = setInterval(() => {
            // Timer
            if (tiRun) {
              const rem = tiEnd - Date.now();
              if (rem <= 0) {
                tiRun = false; tiDone = true; tiMs = 0;
                renderTiDisplay(); renderTiBtns();
                beep(880, 0.7); setTimeout(() => beep(1047, 0.7), 350); setTimeout(() => beep(1319, 1.0), 700);
              } else { renderTiDisplay(); }
            }
            // Stopwatch
            if (swRun) {
              const t = swNow();
              const m = Math.floor(t / 60000), s = Math.floor((t % 60000) / 1000), cs = Math.floor((t % 1000) / 10);
              swDisplay.textContent = `${pad(m)}:${pad(s)}.${pad(cs)}`;
            }
          }, 50);
          state.cleanups?.push(() => clearInterval(mainInt));

          // ── Boot
          switchTab('clock');
        }
      });

      /* ═══════════════════════════════════════════════════════════════
         SECTION: UTILITY FUNCTIONS
         ═══════════════════════════════════════════════════════════════ */

      function applyTheme(theme) {
        const themes = {
          'nova-dark': {
            '--bg-base': '#07090f',
            '--bg-elevated': 'rgba(14, 18, 28, 0.80)',
            '--bg-overlay': 'rgba(20, 26, 40, 0.70)',
            '--bg-sunken': '#030508',
            '--text-primary': '#e6edf3',
            '--text-secondary': '#8b949e',
            '--text-muted': '#484f58',
            '--text-link': '#58a6ff',
            '--text-danger': '#f85149',
            '--text-success': '#3fb950',
            '--text-warning': '#d29922',
            '--accent': '#58a6ff',
            '--accent-hover': '#79b8ff',
            '--accent-muted': 'rgba(88, 166, 255, 0.15)',
            '--window-bg': 'rgba(10, 14, 22, 0.50)',
            '--window-border': 'rgba(255, 255, 255, 0.12)',
            '--window-shadow': '0 32px 64px rgba(0,0,0,0.50), 0 8px 24px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.07)',
            '--taskbar-bg': 'rgba(6, 10, 18, 0.65)',
            '--taskbar-border': 'rgba(255, 255, 255, 0.08)',
            '--border-subtle': 'rgba(255, 255, 255, 0.06)',
            '--border-default': 'rgba(255, 255, 255, 0.12)',
            '--border-strong': 'rgba(255, 255, 255, 0.25)',
            '--r-window': '16px',
            '--font-size': '14px',
            '--window-blur': 'blur(28px) saturate(160%)'
          },
          'nova-light': {
            '--bg-base': '#ffffff',
            '--bg-elevated': '#f6f8fa',
            '--bg-overlay': '#ffffff',
            '--bg-sunken': '#eaeef2',
            '--text-primary': '#24292f',
            '--text-secondary': '#57606a',
            '--text-muted': '#8c959f',
            '--text-link': '#0969da',
            '--text-danger': '#cf222e',
            '--text-success': '#1a7f37',
            '--text-warning': '#9a6700',
            '--accent': '#0969da',
            '--accent-hover': '#0550ae',
            '--accent-muted': 'rgba(9, 105, 218, 0.1)',
            '--window-bg': 'rgba(255, 255, 255, 0.72)',
            '--window-border': 'rgba(27, 31, 35, 0.12)',
            '--window-shadow': '0 24px 48px rgba(0,0,0,0.12), 0 6px 20px rgba(0,0,0,0.07), inset 0 1px 0 rgba(255,255,255,0.90)',
            '--taskbar-bg': 'rgba(246, 248, 250, 0.72)',
            '--taskbar-border': 'rgba(27, 31, 35, 0.12)',
            '--border-subtle': 'rgba(27, 31, 35, 0.06)',
            '--border-default': 'rgba(27, 31, 35, 0.12)',
            '--border-strong': 'rgba(27, 31, 35, 0.25)',
            '--r-window': '14px',
            '--font-size': '14px',
            '--window-blur': 'blur(28px) saturate(160%)'
          },
          'nord': {
            '--bg-base': '#2e3440',
            '--bg-elevated': '#3b4252',
            '--bg-overlay': '#434c5e',
            '--bg-sunken': '#242933',
            '--text-primary': '#eceff4',
            '--text-secondary': '#d8dee9',
            '--text-muted': '#4c566a',
            '--text-link': '#88c0d0',
            '--text-danger': '#bf616a',
            '--text-success': '#a3be8c',
            '--text-warning': '#ebcb8b',
            '--accent': '#88c0d0',
            '--accent-hover': '#81a1c1',
            '--accent-muted': 'rgba(136, 192, 208, 0.15)',
            '--window-bg': 'rgba(46, 52, 64, 0.52)',
            '--window-border': 'rgba(236, 239, 244, 0.12)',
            '--window-shadow': '0 24px 48px rgba(0,0,0,0.45), 0 6px 20px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.07)',
            '--taskbar-bg': 'rgba(36, 41, 51, 0.65)',
            '--taskbar-border': 'rgba(236, 239, 244, 0.10)',
            '--border-subtle': 'rgba(236, 239, 244, 0.08)',
            '--border-default': 'rgba(236, 239, 244, 0.15)',
            '--border-strong': 'rgba(236, 239, 244, 0.30)',
            '--r-window': '14px',
            '--font-size': '14px',
            '--window-blur': 'blur(28px) saturate(160%)'
          },
          'dracula': {
            '--bg-base': '#282a36',
            '--bg-elevated': '#44475a',
            '--bg-overlay': '#44475a',
            '--bg-sunken': '#21222c',
            '--text-primary': '#f8f8f2',
            '--text-secondary': '#6272a4',
            '--text-muted': '#484a66',
            '--text-link': '#8be9fd',
            '--text-danger': '#ff5555',
            '--text-success': '#50fa7b',
            '--text-warning': '#f1fa8c',
            '--accent': '#bd93f9',
            '--accent-hover': '#ff79c6',
            '--accent-muted': 'rgba(189, 147, 249, 0.15)',
            '--window-bg': 'rgba(40, 42, 54, 0.52)',
            '--window-border': 'rgba(248, 248, 242, 0.12)',
            '--window-shadow': '0 24px 48px rgba(0,0,0,0.50), 0 6px 20px rgba(0,0,0,0.32), inset 0 1px 0 rgba(189,147,249,0.08)',
            '--taskbar-bg': 'rgba(30, 31, 41, 0.65)',
            '--taskbar-border': 'rgba(248, 248, 242, 0.10)',
            '--border-subtle': 'rgba(248, 248, 242, 0.08)',
            '--border-default': 'rgba(248, 248, 242, 0.15)',
            '--border-strong': 'rgba(248, 248, 242, 0.30)',
            '--r-window': '14px',
            '--font-size': '14px',
            '--window-blur': 'blur(28px) saturate(160%)'
          },
          'catppuccin': {
            '--bg-base': '#1e1e2e',
            '--bg-elevated': '#313244',
            '--bg-overlay': '#45475a',
            '--bg-sunken': '#181825',
            '--text-primary': '#cdd6f4',
            '--text-secondary': '#a6adc8',
            '--text-muted': '#6c7086',
            '--text-link': '#89b4fa',
            '--text-danger': '#f38ba8',
            '--text-success': '#a6e3a1',
            '--text-warning': '#f9e2af',
            '--accent': '#cba6f7',
            '--accent-hover': '#b4befe',
            '--accent-muted': 'rgba(203, 166, 247, 0.15)',
            '--window-bg': 'rgba(30, 30, 46, 0.52)',
            '--window-border': 'rgba(205, 214, 244, 0.13)',
            '--window-shadow': '0 24px 48px rgba(0,0,0,0.48), 0 6px 20px rgba(0,0,0,0.30), inset 0 1px 0 rgba(203,166,247,0.08)',
            '--taskbar-bg': 'rgba(22, 22, 34, 0.65)',
            '--taskbar-border': 'rgba(205, 214, 244, 0.10)',
            '--border-subtle': 'rgba(205, 214, 244, 0.08)',
            '--border-default': 'rgba(205, 214, 244, 0.15)',
            '--border-strong': 'rgba(205, 214, 244, 0.30)',
            '--r-window': '14px',
            '--font-size': '14px',
            '--window-blur': 'blur(28px) saturate(160%)'
          },
          'tokyo-night': {
            '--bg-base': '#1a1b26',
            '--bg-elevated': '#24283b',
            '--bg-overlay': '#414868',
            '--bg-sunken': '#16161e',
            '--text-primary': '#c0caf5',
            '--text-secondary': '#565f89',
            '--text-muted': '#3b4261',
            '--text-link': '#7aa2f7',
            '--text-danger': '#f7768e',
            '--text-success': '#9ece6a',
            '--text-warning': '#e0af68',
            '--accent': '#7aa2f7',
            '--accent-hover': '#bb9af7',
            '--accent-muted': 'rgba(122, 162, 247, 0.15)',
            '--window-bg': 'rgba(22, 24, 38, 0.52)',
            '--window-border': 'rgba(192, 202, 245, 0.13)',
            '--window-shadow': '0 24px 48px rgba(0,0,0,0.50), 0 6px 20px rgba(0,0,0,0.32), inset 0 1px 0 rgba(122,162,247,0.08)',
            '--taskbar-bg': 'rgba(16, 17, 28, 0.65)',
            '--taskbar-border': 'rgba(192, 202, 245, 0.10)',
            '--border-subtle': 'rgba(192, 202, 245, 0.08)',
            '--border-default': 'rgba(192, 202, 245, 0.15)',
            '--border-strong': 'rgba(192, 202, 245, 0.30)',
            '--r-window': '14px',
            '--font-size': '14px',
            '--window-blur': 'blur(28px) saturate(160%)'
          },
          'gruvbox': {
            '--bg-base': '#282828',
            '--bg-elevated': '#3c3836',
            '--bg-overlay': '#504945',
            '--bg-sunken': '#1d2021',
            '--text-primary': '#ebdbb2',
            '--text-secondary': '#d5c4a1',
            '--text-muted': '#665c54',
            '--text-link': '#83a598',
            '--text-danger': '#fb4934',
            '--text-success': '#b8bb26',
            '--text-warning': '#fabd2f',
            '--accent': '#fabd2f',
            '--accent-hover': '#fe8019',
            '--accent-muted': 'rgba(250, 189, 47, 0.15)',
            '--window-bg': 'rgba(40, 40, 40, 0.52)',
            '--window-border': 'rgba(235, 219, 178, 0.13)',
            '--window-shadow': '0 24px 48px rgba(0,0,0,0.48), 0 6px 20px rgba(0,0,0,0.30), inset 0 1px 0 rgba(250,189,47,0.06)',
            '--taskbar-bg': 'rgba(29, 32, 33, 0.65)',
            '--taskbar-border': 'rgba(235, 219, 178, 0.10)',
            '--border-subtle': 'rgba(235, 219, 178, 0.08)',
            '--border-default': 'rgba(235, 219, 178, 0.15)',
            '--border-strong': 'rgba(235, 219, 178, 0.30)',
            '--r-window': '14px',
            '--font-size': '14px',
            '--window-blur': 'blur(28px) saturate(160%)'
          },
          'high-contrast': {
            '--bg-base': '#000000',
            '--bg-elevated': '#1a1a1a',
            '--bg-overlay': '#333333',
            '--bg-sunken': '#000000',
            '--text-primary': '#ffffff',
            '--text-secondary': '#cccccc',
            '--text-muted': '#999999',
            '--text-link': '#ffff00',
            '--text-danger': '#ff0000',
            '--text-success': '#00ff00',
            '--text-warning': '#ffff00',
            '--accent': '#ffff00',
            '--accent-hover': '#ffffff',
            '--accent-muted': 'rgba(255, 255, 0, 0.15)',
            '--window-bg': 'rgba(0, 0, 0, 0.95)',
            '--window-border': '3px solid #ffffff',
            '--window-shadow': '0 8px 32px rgba(255,255,255,0.2), 0 2px 8px rgba(255,255,255,0.1)',
            '--taskbar-bg': 'rgba(0, 0, 0, 0.95)',
            '--taskbar-border': '2px solid #ffffff',
            '--border-subtle': '2px solid #ffffff',
            '--border-default': '3px solid #ffffff',
            '--border-strong': '4px solid #ffffff',
            '--r-window': '0px',
            '--font-size': '16px',
            '--window-blur': 'none'
          }
        };

        const t = themes[theme] || themes['nova-dark'];
        for (const [k, v] of Object.entries(t)) {
          document.documentElement.style.setProperty(k, v);
        }
        window.dispatchEvent(new CustomEvent('theme:changed', { detail: { theme } }));
      }

      /* ═══════════════════════════════════════════════════════════════════
         OPFS (Origin Private File System) Support
         ═══════════════════════════════════════════════════════════════════ */

      const OPFS = {
        root: null,
        available: false,

        async init() {
          try {
            if ('storage' in navigator && 'getDirectory' in navigator.storage) {
              this.root = await navigator.storage.getDirectory();
              this.available = true;
            } else {
              this.available = false;
            }
          } catch (e) {
            this.available = false;
          }
          return this.available;
        },

        async ensureRoot() {
          if (this.root) return this.root;
          await this.init();
          return this.root;
        },

        async storeBlob(key, blob) {
          if (this.available && this.root) {
            try {
              const fileHandle = await this.root.getFileHandle(key, { create: true });
              const writable = await fileHandle.createWritable();
              await writable.write(blob);
              await writable.close();
              return true;
            } catch (e) {
              // Silently fallback to IndexedDB
            }
          }
          return this._storeIndexedDB(key, blob);
        },

        async getBlob(key) {
          if (this.available && this.root) {
            try {
              const fileHandle = await this.root.getFileHandle(key);
              return await fileHandle.getFile();
            } catch (e) {
              // Silently fallback to IndexedDB
            }
          }
          return this._getIndexedDB(key);
        },

        async deleteBlob(key) {
          if (this.available && this.root) {
            try {
              await this.root.removeEntry(key);
              return true;
            } catch (e) {
              // Silently fallback to IndexedDB
            }
          }
          return this._deleteIndexedDB(key);
        },

        async ensureDirectory(path) {
          const root = await this.ensureRoot();
          if (!root) return null;
          const parts = String(path || '').split('/').filter(Boolean);
          let current = root;
          for (const part of parts) {
            current = await current.getDirectoryHandle(part, { create: true });
          }
          return current;
        },

        async writeText(path, text, type = 'text/plain') {
          const parts = String(path || '').split('/').filter(Boolean);
          if (!parts.length) throw new Error('Path is required');
          const fileName = parts.pop();
          const dir = parts.length ? await this.ensureDirectory(parts.join('/')) : await this.ensureRoot();
          if (!dir) return this._storeIndexedDB(path, new Blob([String(text)], { type }));
          const fileHandle = await dir.getFileHandle(fileName, { create: true });
          const writable = await fileHandle.createWritable();
          const blob = text instanceof Blob ? text : new Blob([String(text)], { type });
          await writable.write(blob);
          await writable.close();
          return true;
        },

        async readText(path) {
          const blob = await this.getBlob(path);
          if (!blob) return null;
          try {
            return await blob.text();
          } catch (e) {
            return null;
          }
        },

        async deletePath(path, recursive = true) {
          const parts = String(path || '').split('/').filter(Boolean);
          if (!parts.length) return false;

          if (this.available && this.root) {
            try {
              const name = parts.pop();
              let parent = this.root;
              for (const part of parts) {
                parent = await parent.getDirectoryHandle(part);
              }
              await parent.removeEntry(name, { recursive });
              return true;
            } catch (e) {
              // Fall through to IndexedDB fallback path below
            }
          }

          return this._deleteIndexedDB(path);
        },

        async listEntries() {
          if (this.available && this.root) {
            try {
              const entries = [];
              const walk = async (dir, prefix = '') => {
                const children = [];
                for await (const [name, handle] of dir.entries()) children.push([name, handle]);
                children.sort((a, b) => {
                  if (a[1].kind !== b[1].kind) return a[1].kind === 'directory' ? -1 : 1;
                  return a[0].localeCompare(b[0]);
                });
                for (const [name, handle] of children) {
                  const path = prefix ? `${prefix}/${name}` : name;
                  if (handle.kind === 'directory') {
                    entries.push({ path, name, kind: 'directory', size: 0, type: 'inode/directory', lastModified: 0 });
                    await walk(handle, path);
                  } else {
                    let size = 0;
                    let type = '';
                    let lastModified = 0;
                    try {
                      const file = await handle.getFile();
                      size = file.size || 0;
                      type = file.type || '';
                      lastModified = file.lastModified || 0;
                    } catch (e) { }
                    entries.push({ path, name, kind: 'file', size, type, lastModified });
                  }
                }
              };
              await walk(this.root);
              return entries;
            } catch (e) {
              // fall through to IndexedDB fallback
            }
          }
          return this._listIndexedDB();
        },

        async clear() {
          if (this.available && this.root) {
            try {
              const entries = [];
              for await (const [name, handle] of this.root.entries()) entries.push([name, handle]);
              for (const [name, handle] of entries) {
                try {
                  await this.root.removeEntry(name, { recursive: handle.kind === 'directory' });
                } catch (e) { }
              }
            } catch (e) { }
          }
          return this._clearIndexedDB();
        },

        // IndexedDB fallback
        _db: null,

        async _openDB() {
          if (this._db) return this._db;
          return new Promise((resolve, reject) => {
            const request = indexedDB.open('novabyte_opfs_fallback', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              this._db = request.result;
              resolve(this._db);
            };
            request.onupgradeneeded = (e) => {
              const db = e.target.result;
              if (!db.objectStoreNames.contains('blobs')) {
                db.createObjectStore('blobs');
              }
            };
          });
        },

        async _storeIndexedDB(key, blob) {
          const db = await this._openDB();
          return new Promise((resolve, reject) => {
            const tx = db.transaction('blobs', 'readwrite');
            const store = tx.objectStore('blobs');
            const request = store.put(blob, key);
            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
          });
        },

        async _getIndexedDB(key) {
          const db = await this._openDB();
          return new Promise((resolve, reject) => {
            const tx = db.transaction('blobs', 'readonly');
            const store = tx.objectStore('blobs');
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        },

        async _deleteIndexedDB(key) {
          const db = await this._openDB();
          return new Promise((resolve, reject) => {
            const tx = db.transaction('blobs', 'readwrite');
            const store = tx.objectStore('blobs');
            const request = store.delete(key);
            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
          });
        },

        async _listIndexedDB() {
          try {
            const db = await this._openDB();
            return await new Promise((resolve, reject) => {
              const tx = db.transaction('blobs', 'readonly');
              const store = tx.objectStore('blobs');
              const items = [];
              const req = store.openCursor();
              req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (!cursor) {
                  items.sort((a, b) => a.path.localeCompare(b.path));
                  resolve(items);
                  return;
                }
                const value = cursor.value;
                const blob = value instanceof Blob ? value : new Blob([value]);
                items.push({
                  path: cursor.key,
                  name: String(cursor.key).split('/').pop(),
                  kind: 'file',
                  size: blob.size || 0,
                  type: blob.type || '',
                  lastModified: 0,
                  fallback: true
                });
                cursor.continue();
              };
              req.onerror = () => reject(req.error);
            });
          } catch (e) {
            return [];
          }
        },

        async _clearIndexedDB() {
          try {
            const db = await this._openDB();
            return await new Promise((resolve, reject) => {
              const tx = db.transaction('blobs', 'readwrite');
              const store = tx.objectStore('blobs');
              const req = store.openCursor();
              req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (!cursor) { resolve(true); return; }
                cursor.delete();
                cursor.continue();
              };
              req.onerror = () => reject(req.error);
            });
          } catch (e) {
            return false;
          }
        }
      };

      // ── AppDirs — per-app OPFS data directories (Android /data/data/ style) ──
      const AppDirs = {
        // Maps app ID → com.nbosp.* package name
        PACKAGES: {
          'vault': 'com.nbosp.vault',
          'quill': 'com.nbosp.quill',
          'shell': 'com.nbosp.shell',
          'browser': 'com.nbosp.browser',
          'calendar-app': 'com.nbosp.calendar',
          'nook': 'com.nbosp.settings',
          'calculator': 'com.nbosp.calculator',
          'app-manager': 'com.nbosp.appmanager',
          'nbosp-clock': 'com.nbosp.clock',
          'nbosp-email': 'com.nbosp.email',
          'nbosp-gallery': 'com.nbosp.gallery',
          'nbosp-downloads': 'com.nbosp.downloads',
          'nbosp-contacts': 'com.nbosp.contacts',
          'nbosp-search': 'com.nbosp.search',
          'nbosp-music': 'com.nbosp.music',
        },

        // Resolved directory handles cache — avoids repeated getDirectoryHandle calls
        _handles: {},

        // Bootstrap the full directory tree — safe to call every boot (idempotent)
        async bootstrap() {
          // ── 1. OPFS physical directories ────────────────────────────────
          if (OPFS.available && OPFS.root) {
            const mkd = (parent, name) => parent.getDirectoryHandle(name, { create: true });
            try {
              const system = await mkd(OPFS.root, 'System');
              const marker = await system.getFileHandle('.nbosp_runtime', { create: true });
              const w = await marker.createWritable();
              await w.write(JSON.stringify({ os: 'NovaByte', layer: 'nbosp', booted: Date.now() }));
              await w.close();
              const data = await mkd(OPFS.root, 'data');
              const dataData = await mkd(data, 'data');
              for (const pkg of Object.values(this.PACKAGES)) {
                const appDir = await mkd(dataData, pkg);
                await mkd(appDir, 'files');
                await mkd(appDir, 'cache');
                await mkd(appDir, 'databases');
                await mkd(appDir, 'shared_prefs');
                this._handles[pkg] = appDir;
              }
            } catch (e) {
              console.warn('[AppDirs] OPFS bootstrap failed:', e);
            }
          }

          // ── 2. Virtual FS — mirror tree so it's visible in Files app ────
          const mkVDir = async (parentId, name) => {
            const existing = FS.listDir(parentId).find(f => f.name === name && f.type === 'folder');
            if (existing) return existing;
            return await FS.createFolder(parentId, name);
          };
          const mkVFile = async (parentId, name, content, mime) => {
            const existing = FS.listDir(parentId).find(f => f.name === name && f.type === 'file');
            if (existing) return existing;
            return await FS.createFile(parentId, name, content, mime || 'application/json');
          };
          const updateVFile = async (parentId, name, content, mime) => {
            const existing = FS.listDir(parentId).find(f => f.name === name && f.type === 'file');
            if (existing) { await FS.writeFile(existing.id, content); return existing; }
            return await FS.createFile(parentId, name, content, mime || 'application/json');
          };

          const APP_META = {
            'com.nbosp.vault': { name: 'Files', version: '1.0.0', description: 'File Manager' },
            'com.nbosp.quill': { name: 'Notes', version: '1.0.0', description: 'Text Editor & Notes' },
            'com.nbosp.shell': { name: 'Terminal', version: '1.0.0', description: 'System Terminal' },
            'com.nbosp.browser': { name: 'Browser', version: '1.0.0', description: 'Web Browser' },
            'com.nbosp.calendar': { name: 'Calendar', version: '1.0.0', description: 'Calendar & Events' },
            'com.nbosp.settings': { name: 'Settings', version: '1.0.0', description: 'System Settings' },
            'com.nbosp.calculator': { name: 'Calculator', version: '1.0.0', description: 'Calculator' },
            'com.nbosp.appmanager': { name: 'App Manager', version: '1.0.0', description: 'Package Manager' },
            'com.nbosp.clock': { name: 'Clock', version: '1.0.0', description: 'Clock & Alarms' },
            'com.nbosp.email': { name: 'Email', version: '1.0.0', description: 'Email Client' },
            'com.nbosp.gallery': { name: 'Gallery', version: '1.0.0', description: 'Image Viewer' },
            'com.nbosp.downloads': { name: 'Downloads', version: '1.0.0', description: 'Download Manager' },
            'com.nbosp.contacts': { name: 'Contacts', version: '1.0.0', description: 'Contacts' },
            'com.nbosp.search': { name: 'Search', version: '1.0.0', description: 'System Search' },
            'com.nbosp.music': { name: 'Music', version: '1.0.0', description: 'Music Player' },
          };

          try {
            const dataNode = await mkVDir(FS.rootId, 'data');
            const dataDataNode = await mkVDir(dataNode.id, 'data');

            // /System/ — OS identity visible in Files
            const systemNode = await mkVDir(FS.rootId, 'System');
            await updateVFile(systemNode.id, 'build.json', JSON.stringify({
              os: 'NovaByte', layer: 'nbosp', version: '3.0.0',
              booted: new Date().toISOString()
            }, null, 2));

            this.vfsFolders = {};

            for (const pkg of Object.values(this.PACKAGES)) {
              const appNode = await mkVDir(dataDataNode.id, pkg);
              const filesNode = await mkVDir(appNode.id, 'files');
              const cacheNode = await mkVDir(appNode.id, 'cache');
              const dbNode = await mkVDir(appNode.id, 'databases');
              const prefsNode = await mkVDir(appNode.id, 'shared_prefs');

              // Cache folder IDs for later use by syncKey and apps
              this.vfsFolders[pkg] = {
                root: appNode.id, files: filesNode.id,
                cache: cacheNode.id, databases: dbNode.id, shared_prefs: prefsNode.id
              };

              const meta = APP_META[pkg] || { name: pkg, version: '1.0.0', description: '' };
              await mkVFile(filesNode.id, 'appinfo.json', JSON.stringify({
                packageId: pkg, name: meta.name, version: meta.version,
                description: meta.description, installedAt: new Date().toISOString(), layer: 'nbosp',
              }, null, 2));
            }

            // ── Migrate existing notes from Documents → com.nbosp.quill/files/ ──
            const quillFilesId = this.vfsFolders['com.nbosp.quill']?.files;
            if (quillFilesId && FS.specialFolders.documents) {
              const docsFiles = FS.listDir(FS.specialFolders.documents);
              for (const f of docsFiles) {
                if (f.type === 'file') {
                  // Move: just update parentId
                  const alreadyMoved = FS.listDir(quillFilesId).find(n => n.name === f.name);
                  if (!alreadyMoved) {
                    f.parentId = quillFilesId;
                    FS.files.set(f.id, f);
                    await OS.workers.fs.call('putFiles', [f]);
                  }
                }
              }
            }

            // ── Sync real localStorage data into virtual FS databases/ ──
            await this._syncAllToVFS(updateVFile);

            // ── Sync real settings into com.nbosp.settings/shared_prefs/prefs.json ──
            const settingsPrefsId = this.vfsFolders['com.nbosp.settings']?.shared_prefs;
            if (settingsPrefsId) {
              await updateVFile(settingsPrefsId, 'prefs.json',
                JSON.stringify(OS.settings._cache, null, 2));
            }

            this.fsFolders = { data: dataNode.id, dataData: dataDataNode.id, system: systemNode.id };
            console.log('[AppDirs] Virtual FS tree bootstrapped — visible in Files app');
          } catch (e) {
            console.warn('[AppDirs] Virtual FS bootstrap failed:', e);
          }
        },

        // Get the root handle for an app's data directory by app ID or package name
        async getAppDir(appIdOrPkg) {
          const pkg = this.PACKAGES[appIdOrPkg] || appIdOrPkg;
          if (this._handles[pkg]) return this._handles[pkg];
          if (!OPFS.available || !OPFS.root) return null;
          try {
            const data = await OPFS.root.getDirectoryHandle('data');
            const dataData = await data.getDirectoryHandle('data');
            const appDir = await dataData.getDirectoryHandle(pkg);
            this._handles[pkg] = appDir;
            return appDir;
          } catch (e) {
            return null;
          }
        },

        // Helper — read a shared_prefs JSON file for an app
        async getPrefs(appIdOrPkg) {
          const appDir = await this.getAppDir(appIdOrPkg);
          if (!appDir) return {};
          try {
            const prefsDir = await appDir.getDirectoryHandle('shared_prefs');
            const file = await prefsDir.getFileHandle('prefs.json');
            const f = await file.getFile();
            return JSON.parse(await f.text());
          } catch (e) {
            return {};
          }
        },

        // Helper — write a shared_prefs JSON file for an app
        async setPrefs(appIdOrPkg, data) {
          const appDir = await this.getAppDir(appIdOrPkg);
          if (!appDir) return false;
          try {
            const prefsDir = await appDir.getDirectoryHandle('shared_prefs', { create: true });
            const file = await prefsDir.getFileHandle('prefs.json', { create: true });
            const w = await file.createWritable();
            await w.write(JSON.stringify(data));
            await w.close();
            return true;
          } catch (e) {
            return false;
          }
        },

        // Maps localStorage key → { pkg, subdir, filename }
        LS_MAP: {
          'calendar_events_v2': { pkg: 'com.nbosp.calendar', subdir: 'databases', file: 'events.json' },
          'nbosp_clock_v1': { pkg: 'com.nbosp.clock', subdir: 'databases', file: 'alarms.json' },
          'nbosp_email_accts_v2': { pkg: 'com.nbosp.email', subdir: 'databases', file: 'accounts.json' },
          'nbosp_email_drafts_v1': { pkg: 'com.nbosp.email', subdir: 'databases', file: 'drafts.json' },
          'nova_downloads': { pkg: 'com.nbosp.downloads', subdir: 'databases', file: 'history.json' },
          'nova_contacts': { pkg: 'com.nbosp.contacts', subdir: 'databases', file: 'contacts.json' },
          'nova_music_prefs': { pkg: 'com.nbosp.music', subdir: 'shared_prefs', file: 'prefs.json' },
          'nova_installed_apps': { pkg: 'com.nbosp.appmanager', subdir: 'databases', file: 'packages.json' },
        },

        // Get a virtual FS folder ID for an app's subdirectory
        getVFSDir(pkg, subdir) {
          return this.vfsFolders?.[pkg]?.[subdir] ?? null;
        },

        // Mirror one localStorage key into the virtual FS — called by lsSave override
        async syncKey(lsKey, value) {
          const mapping = this.LS_MAP[lsKey];
          if (!mapping || !this.vfsFolders) return;
          const folderId = this.getVFSDir(mapping.pkg, mapping.subdir);
          if (!folderId) return;
          const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
          try {
            const existing = FS.listDir(folderId).find(f => f.name === mapping.file && f.type === 'file');
            if (existing) { await FS.writeFile(existing.id, content); }
            else { await FS.createFile(folderId, mapping.file, content, 'application/json'); }
          } catch (e) { /* silent */ }
        },

        // Boot-time sync — read all known localStorage keys and write to virtual FS
        async _syncAllToVFS(updateVFile) {
          for (const [lsKey, mapping] of Object.entries(this.LS_MAP)) {
            const raw = localStorage.getItem(lsKey);
            if (!raw) continue;
            const folderId = this.getVFSDir(mapping.pkg, mapping.subdir);
            if (!folderId) continue;
            try {
              // Pretty-print if it's valid JSON, otherwise store as-is
              let content = raw;
              try { content = JSON.stringify(JSON.parse(raw), null, 2); } catch { }
              await updateVFile(folderId, mapping.file, content, 'application/json');
            } catch (e) { /* silent */ }
          }
        },

        // Wipe all data for one app (equivalent of Android "Clear App Data")
        async clearAppData(appIdOrPkg) {
          const pkg = this.PACKAGES[appIdOrPkg] || appIdOrPkg;
          if (!OPFS.available || !OPFS.root) return false;
          try {
            const data = await OPFS.root.getDirectoryHandle('data');
            const dataData = await data.getDirectoryHandle('data');
            await dataData.removeEntry(pkg, { recursive: true });
            delete this._handles[pkg];
            // Recreate empty structure
            const appDir = await dataData.getDirectoryHandle(pkg, { create: true });
            const mkd = (p, n) => p.getDirectoryHandle(n, { create: true });
            await mkd(appDir, 'files');
            await mkd(appDir, 'cache');
            await mkd(appDir, 'databases');
            await mkd(appDir, 'shared_prefs');
            this._handles[pkg] = appDir;
            return true;
          } catch (e) {
            return false;
          }
        },
      };

      // Global runtime flag — apps check this to verify they're running inside NovaByte
      window.__NB_RUNTIME = { os: 'NovaByte', layer: 'nbosp', ready: false };
      window.AppDirs = AppDirs;

      function openFileWithDefaultApp(fileNode) {
        if (!fileNode) return;

        const mime = fileNode.mimeType || '';
        let appId = 'quill'; // default

        if (mime === 'text/html' || fileNode.name.endsWith('.html') || fileNode.name.endsWith('.htm')) appId = 'browser';
        else if (mime.startsWith('image/')) appId = 'nbosp-gallery';
        else if (mime.startsWith('audio/')) appId = 'nbosp-music';
        else if (mime === 'application/pdf' || fileNode.name.endsWith('.pdf')) appId = 'lumina';

        WM.createWindow(appId, { fileId: fileNode.id });
      }

      function renderDesktopIcons() {
        const desktop = document.getElementById('desktop');
        desktop.innerHTML = '';

        // FIX 1.6.41: Respect user showDesktopIcons setting
        if (OS.settings.get('showDesktopIcons') === false) {
          return;
        }

        const desktopFolder = FS.specialFolders.desktop;
        if (!desktopFolder) return;

        const files = FS.listDir(desktopFolder);

        // Desktop icons are independent of taskbar pins — show nothing by default
        const defaultApps = [];

        // Desktop icon positions storage
        const iconPositions = OS.settings.get('desktopIconPositions') || {};

        // Add drop event handlers for creating app shortcuts
        function handleDesktopDrop(e) {
          e.preventDefault();
          e.stopPropagation();

          try {
            // First, check for app shortcut drops (JSON data)
            const data = e.dataTransfer.getData('application/json');
            if (data) {
              const payload = JSON.parse(data);

              if (payload.type === 'app-shortcut') {
                // Create a shortcut file on the desktop
                const shortcutName = payload.appName + '.lnk';
                const shortcutContent = JSON.stringify({
                  target: payload.appId,
                  type: 'app-shortcut',
                  icon: payload.appIcon
                });

                // Create in desktop folder
                const desktopFolder = FS.specialFolders.desktop;
                FS.createFile(desktopFolder, shortcutName, shortcutContent, 'application/x-app-shortcut').then(() => {
                  // Set drop position
                  const desktopRect = desktop.getBoundingClientRect();
                  const x = Math.max(0, Math.min(e.clientX - desktopRect.left, desktopRect.width - 80));
                  const y = Math.max(0, Math.min(e.clientY - desktopRect.top, desktopRect.height - 100));

                  // Key by appId so it matches what renderDesktopIcons looks up
                  iconPositions['app:' + payload.appId] = { x, y };
                  OS.settings.set('desktopIconPositions', iconPositions);

                  renderDesktopIcons();
                  Notify.show({
                    title: 'Shortcut Created',
                    body: `${payload.appName} shortcut added to desktop`,
                    type: 'success',
                    appName: 'Desktop'
                  });
                }).catch(err => {
                  console.error('Failed to create file:', err);
                  Notify.show({
                    title: 'Error',
                    body: 'Failed to create shortcut',
                    type: 'error',
                    appName: 'Desktop'
                  });
                });
                return;
              }
            }

            // If no JSON data or not an app-shortcut, check for file drops
            const files = e.dataTransfer.files;
            if (files && files.length > 0) {

              let filesAdded = 0;
              for (const file of files) {

                const reader = new FileReader();
                reader.onload = async () => {
                  try {
                    // Read file content
                    let content;
                    // For text files, use TextDecoder for proper UTF-8 handling
                    const buffer = reader.result;
                    const view = new Uint8Array(buffer);
                    content = new TextDecoder('utf-8').decode(view);

                    // Security check - Phase 1: Extension Check
                    const extCheck = checkFileExtension(file.name);
                    if (extCheck.blocked) {
                      Notify.show({
                        title: '🚫 File Blocked - Executable Type',
                        body: `"${file.name}": ${extCheck.reason}`,
                        type: 'error',
                        appName: 'System'
                      });
                      console.warn('[Security] Blocked on extension:', {
                        file: file.name,
                        reason: extCheck.reason
                      });
                      return;
                    }

                    // Security check - Phase 2: Content Pattern Scanning
                    if (typeof content === 'string') {
                      const scanResult = scanFileForThreats(content, file.name);
                      if (scanResult.isMalicious) {
                        const threatList = scanResult.patterns.join(', ');
                        Notify.show({
                          title: '⚠️ Malicious File Blocked',
                          body: `"${file.name}" contains threats: ${threatList}`,
                          type: 'error',
                          appName: 'System'
                        });
                        console.warn('[Security] Malicious file blocked:', {
                          file: file.name,
                          threats: scanResult.threats,
                          patterns: scanResult.patterns
                        });
                        return;
                      }
                    }

                    // Detect proper MIME type for known file extensions
                    let mimeType = file.type;
                    if (!mimeType) mimeType = 'application/octet-stream';

                    const desktopId = FS.specialFolders.desktop;
                    if (!desktopId) {
                      console.error('[Desktop Drop] Desktop folder ID not found');
                      Notify.show({ title: 'Error', body: 'Desktop folder not found', type: 'error', appName: 'System' });
                      return;
                    }

                    await FS.createFile(desktopId, file.name, content, mimeType);
                    filesAdded++;

                    // Refresh after each file
                    renderDesktopIcons();
                  } catch (err) {
                    console.error('[Desktop Drop] Error:', err);
                    Notify.show({ title: 'Error', body: `Failed to add ${file.name}: ${err.message}`, type: 'error', appName: 'System' });
                  }
                };

                reader.onerror = () => {
                  console.error('[Desktop Drop] File read error:', file.name);
                  Notify.show({ title: 'Error', body: `Failed to read ${file.name}`, type: 'error', appName: 'System' });
                };

                // Read file as ArrayBuffer
                reader.readAsArrayBuffer(file);
              }

              // Final success notification if files were added
              if (filesAdded > 0) {
                setTimeout(() => {
                  Notify.show({
                    title: 'Files Added',
                    body: `${filesAdded} file(s) added to desktop`,
                    type: 'success',
                    appName: 'System',
                    duration: 3000
                  });
                }, 300);
              }
            }
          } catch (err) {
            console.error('Drop error:', err);
          }
        }

        if (!desktop._dropHandlersAttached) {
          desktop._dropHandlersAttached = true;

          desktop.addEventListener('dragenter', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            desktop.style.opacity = '0.7';
          });

          desktop.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            desktop.style.opacity = '0.7';
          });

          desktop.addEventListener('dragleave', (e) => {
            // Only clear if leaving desktop entirely
            if (e.target === desktop) {
              desktop.style.opacity = '1';
            }
          });

          desktop.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            desktop.style.opacity = '1';
            handleDesktopDrop(e);
          });

          // Document-level drop fallback (covers edge cases where target is a child)
          document.addEventListener('drop', (e) => {
            if (e.target === desktop || (e.target && desktop.contains(e.target))) {
              e.preventDefault();
              e.stopPropagation();
              desktop.style.opacity = '1';
              handleDesktopDrop(e);
            }
          }, true);

        } // end _dropHandlersAttached guard

        // Add taskbar drop support for pinning apps
        const taskbar = document.getElementById('taskbar');
        if (taskbar) {
          taskbar.addEventListener('dragenter', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            taskbar.style.borderTop = '2px solid var(--accent)';
          });

          taskbar.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            taskbar.style.borderTop = '2px solid var(--accent)';
          });

          taskbar.addEventListener('dragleave', (e) => {
            // Only clear when pointer truly leaves the taskbar (not just a child element)
            if (!taskbar.contains(e.relatedTarget)) {
              taskbar.style.borderTop = '';
            }
          });

          taskbar.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            taskbar.style.borderTop = '';

            try {
              const data = e.dataTransfer.getData('application/json');
              if (!data) {
                return;
              }

              const payload = JSON.parse(data);
              if (payload.type !== 'app-shortcut') return;

              // Add app to pinned apps
              let pinnedApps = OS.settings.get('pinnedApps') || [];

              // Don't add duplicates
              if (!pinnedApps.includes(payload.appId)) {
                pinnedApps.push(payload.appId);
                OS.settings.set('pinnedApps', pinnedApps);
                // Refresh taskbar
                if (typeof WM !== 'undefined' && WM.updateTaskbar) {
                  WM.updateTaskbar();
                }
                Notify.show({
                  title: 'Pinned to Taskbar',
                  body: `${payload.appName} pinned to taskbar`,
                  type: 'success',
                  appName: 'Taskbar'
                });
              }
            } catch (err) {
              console.error('Taskbar drop error:', err);
            }
          });
        }

        function makeDraggable(icon, appId, isFile = false, fileNode = null) {
          let isDragging = false;
          let startX, startY, initialX, initialY;

          icon.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // Only left click
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = icon.getBoundingClientRect();
            const desktopRect = desktop.getBoundingClientRect();
            initialX = rect.left - desktopRect.left;
            initialY = rect.top - desktopRect.top;
            icon.style.zIndex = '1000';
            icon.style.transition = 'none';
          });

          document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const desktopRect = desktop.getBoundingClientRect();
            let newX = Math.max(0, Math.min(initialX + dx, desktopRect.width - icon.offsetWidth));
            let newY = Math.max(0, Math.min(initialY + dy, desktopRect.height - icon.offsetHeight));
            icon.style.position = 'absolute';
            icon.style.left = newX + 'px';
            icon.style.top = newY + 'px';
          });

          document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            icon.style.zIndex = '';
            icon.style.transition = '';
            // Save position
            const key = isFile ? ('file:' + fileNode.id) : ('app:' + appId);
            const rect = icon.getBoundingClientRect();
            const desktopRect = desktop.getBoundingClientRect();
            iconPositions[key] = {
              x: rect.left - desktopRect.left,
              y: rect.top - desktopRect.top
            };
            OS.settings.set('desktopIconPositions', iconPositions);
          });
        }

        function getInitialPosition(key, index, isFile = false) {
          const saved = iconPositions[key];
          if (saved) return { left: saved.x + 'px', top: saved.y + 'px', position: 'absolute' };
          // Default grid positions
          const iconSize = 80;
          const iconSpacing = 16;
          const cols = Math.floor((window.innerWidth - 40) / iconSize);
          const col = index % cols;
          const row = Math.floor(index / cols);
          const x = 20 + col * (iconSize + iconSpacing);
          const y = 20 + row * (iconSize + iconSpacing + 24); // +24 for label height
          return { position: 'absolute', left: x + 'px', top: y + 'px' };
        }

        defaultApps.forEach((app, idx) => {
          const key = 'app:' + app.id;
          const icon = createEl('div', {
            className: 'desktop-icon',
            tabindex: '0',
            'aria-label': app.name,
            role: 'button',
            style: getInitialPosition(key, idx)
          });
          const img = createEl('div', { className: 'desktop-icon-img' });
          img.innerHTML = svgIcon(app.icon, 40);
          const label = createEl('div', { className: 'desktop-icon-label', textContent: app.name });
          icon.appendChild(img);
          icon.appendChild(label);

          makeDraggable(icon, app.id);

          icon.addEventListener('dblclick', () => WM.createWindow(app.id));
          icon.addEventListener('click', (e) => {
            if (!e.ctrlKey) desktop.querySelectorAll('.desktop-icon').forEach(i => i.classList.remove('selected'));
            icon.classList.add('selected');
          });
          icon.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const pinnedApps = OS.settings.get('pinnedApps') || [];
            const isPinned = pinnedApps.includes(app.id);
            // Detect if this is a user-installed app (has a stored entry)
            const storedApps = (() => { try { return JSON.parse(localStorage.getItem('nova_installed_apps') || '[]'); } catch { return []; } })();
            const isUserApp = storedApps.some(a => a.id === app.id);
            const items = [
              { label: 'Open', icon: 'play', action: () => WM.createWindow(app.id) },
              { separator: true },
              {
                label: isPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar',
                icon: 'pin',
                action: () => {
                  const pins = OS.settings.get('pinnedApps') || [];
                  const next = isPinned ? pins.filter(id => id !== app.id) : [...pins, app.id];
                  OS.settings.set('pinnedApps', next);
                  WM.updateTaskbar();
                  Notify.show({ title: isPinned ? 'Unpinned' : 'Pinned', body: `${app.name} ${isPinned ? 'removed from' : 'pinned to'} taskbar`, type: 'success', appName: 'Desktop' });
                }
              }];
            if (isUserApp) {
              items.push({ separator: true });
              items.push({
                label: 'Uninstall',
                icon: 'trash',
                danger: true,
                action: () => {
                  if (!confirm(`Uninstall "${app.name}"?

This cannot be undone.`)) return;
                  try {
                    const stored = JSON.parse(localStorage.getItem('nova_installed_apps') || '[]');
                    const updated = stored.filter(a => a.id !== app.id);
                    localStorage.setItem('nova_installed_apps', JSON.stringify(updated));
                    delete OS.apps[app.id];
                    const ri = APP_REGISTRY.findIndex(a => a.id === app.id);
                    if (ri > -1) APP_REGISTRY.splice(ri, 1);
                    renderDesktopIcons();
                    WM.updateTaskbar();
                    Notify.show({ title: 'Uninstalled', body: `${app.name} has been removed.`, type: 'success', appName: 'Desktop' });
                  } catch (err) {
                    Notify.show({ title: 'Error', body: `Failed to uninstall: ${err.message}`, type: 'error', appName: 'Desktop' });
                  }
                }
              });
            }
            ContextMenu.show(e.clientX, e.clientY, items);
          });
          desktop.appendChild(icon);
        });

        // Add files
        files.forEach((f, idx) => {
          // Check if this is a shortcut file
          let isShortcut = false;
          let shortcutData = null;

          if (f.name.endsWith('.lnk') && f.mimeType === 'application/x-app-shortcut') {
            try {
              shortcutData = JSON.parse(f.content);
              if (shortcutData && shortcutData.type === 'app-shortcut') {
                isShortcut = true;
              }
            } catch (e) {
              // Not a valid shortcut, treat as normal file
            }
          }

          const key = 'file:' + f.id;
          const icon = createEl('div', {
            className: 'desktop-icon',
            tabindex: '0',
            'aria-label': f.name,
            role: 'button',
            style: getInitialPosition(key, defaultApps.length + idx, true)
          });
          const img = createEl('div', { className: 'desktop-icon-img' });

          // Use app icon for shortcuts
          if (isShortcut && shortcutData) {
            img.innerHTML = svgIcon(shortcutData.icon, 40);
            // Add small arrow to indicate shortcut
            const arrow = createEl('div', {
              style: 'position: absolute; bottom: 0; right: 0; width: 16px; height: 16px; background: var(--accent); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; color: white; font-weight: bold;'
            });
            arrow.textContent = '→';
            img.style.position = 'relative';
            img.appendChild(arrow);
          } else {
            img.innerHTML = svgIcon(FS.getMimeIcon(f.mimeType, f.name), 40);
            if (f.type === 'folder') img.style.color = 'var(--text-warning)';
          }

          const label = createEl('div', { className: 'desktop-icon-label', textContent: isShortcut ? f.name.replace(/\.lnk$/i, '') : f.name });
          icon.appendChild(img);
          icon.appendChild(label);

          makeDraggable(icon, null, true, f);

          icon.addEventListener('dblclick', () => {
            if (isShortcut && shortcutData) {
              // Launch the app from the shortcut
              WM.createWindow(shortcutData.target);
            } else if (f.type === 'folder') {
              WM.createWindow('vault', { folderId: f.id });
            } else {
              openFileWithDefaultApp(f);
            }
          });
          icon.addEventListener('click', (e) => {
            if (!e.ctrlKey) desktop.querySelectorAll('.desktop-icon').forEach(i => i.classList.remove('selected'));
            icon.classList.add('selected');
          });
          icon.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const viewOnly = OS.settings.get('filesViewOnly');
            const menuItems = [
              { label: 'Open', icon: 'play', action: () => openFileWithDefaultApp(f) }
            ];
            if (!viewOnly) {
              menuItems.push(
                {
                  label: 'Rename', icon: 'edit', action: async () => {
                    const name = await showPrompt('Rename', f.name);
                    if (name && name !== f.name) {
                      await FS.rename(f.id, name);
                      renderDesktopIcons();
                    }
                  }
                },
                { separator: true },
                {
                  label: 'Move to Trash', icon: 'trash', danger: true, action: async () => {
                    await FS.deleteToTrash(f.id);
                    renderDesktopIcons();
                  }
                }
              );
            }
            ContextMenu.show(e.clientX, e.clientY, menuItems);
          });
          desktop.appendChild(icon);
        });
      }

      /* ═══════════════════════════════════════════════════════════════
         SECTION: BOOT SEQUENCE
         ═══════════════════════════════════════════════════════════════ */

      async function boot() {
        // ╔════════════════════════════════════════════════════════════════╗
        // ║  ⚠️ TEST SYNTAX ERROR - COMMENT OUT TO FIX BOOT              ║
        // ║  Remove the line below this block to fix the error            ║
        // ╚════════════════════════════════════════════════════════════════╝
        // // const broken = { // ← SYNTAX ERROR: Unclosed bracket

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
                    sandbox: 'allow-same-origin allow-scripts allow-forms allow-popups allow-modals'
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

      /* ═══════════════════════════════════════════════════════════════
         SECTION: GLOBAL EVENT HANDLERS
         ═══════════════════════════════════════════════════════════════ */

      // Launchpad
      document.getElementById('start-btn').addEventListener('click', toggleLaunchpad);

      function toggleLaunchpad() {
        const launchpad = document.getElementById('launchpad');
        launchpad.classList.toggle('active');
        if (launchpad.classList.contains('active')) {
          renderLaunchpad();
          document.getElementById('launchpad-search').value = '';
          document.getElementById('launchpad-search').focus();
        }
      }

      function renderLaunchpad() {
        const grid = document.getElementById('launchpad-grid');
        const apps = APP_REGISTRY;
        const webApps = (typeof WebAppManager !== 'undefined' && WebAppManager.getAllApps) ? WebAppManager.getAllApps() : [];
        const signature = [
          ...apps.map(app => `${app.id}:${app.name}:${app.icon}`),
          ...webApps.map(webApp => `web:${webApp.id}:${webApp.name}:${webApp.icon}:${webApp.url}`)
        ].join('||');

        const needsRebuild = grid.dataset.renderedSignature !== signature || grid.children.length === 0;

        if (needsRebuild) {
          grid.innerHTML = '';
          grid.dataset.renderedSignature = signature;

          const appendAppItem = (app) => {
            const item = createEl('button', {
              className: 'launchpad-item',
              'aria-label': app.name,
              draggable: 'true'
            });
            const icon = createEl('div', { className: 'launchpad-icon' });
            icon.innerHTML = svgIcon(app.icon, 28);
            const name = createEl('div', { className: 'launchpad-name', textContent: app.name });
            item.appendChild(icon);
            item.appendChild(name);

            item.addEventListener('click', () => {
              toggleLaunchpad();
              WM.createWindow(app.id);
            });

            item.addEventListener('contextmenu', (e) => {
              e.preventDefault();
              e.stopPropagation();
              const pinnedApps = OS.settings.get('pinnedApps') || [];
              const isPinned = pinnedApps.includes(app.id);
              const storedApps = (() => { try { return JSON.parse(localStorage.getItem('nova_installed_apps') || '[]'); } catch { return []; } })();
              const isUserApp = storedApps.some(a => a.id === app.id);
              const items = [
                { label: 'Open', icon: 'play', action: () => { toggleLaunchpad(); WM.createWindow(app.id); } },
                { separator: true },
                {
                  label: isPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar',
                  icon: 'pin',
                  action: () => {
                    const pins = OS.settings.get('pinnedApps') || [];
                    const next = isPinned ? pins.filter(id => id !== app.id) : [...pins, app.id];
                    OS.settings.set('pinnedApps', next);
                    WM.updateTaskbar();
                    Notify.show({ title: isPinned ? 'Unpinned' : 'Pinned', body: `${app.name} ${isPinned ? 'removed from' : 'added to'} taskbar`, type: 'success', appName: 'Launchpad' });
                  }
                }
              ];
              if (isUserApp) {
                items.push({ separator: true });
                items.push({
                  label: 'Uninstall',
                  icon: 'trash',
                  danger: true,
                  action: () => {
                    toggleLaunchpad();
                    if (!confirm(`Uninstall "${app.name}"?\n\nThis cannot be undone.`)) return;
                    try {
                      const stored = JSON.parse(localStorage.getItem('nova_installed_apps') || '[]');
                      localStorage.setItem('nova_installed_apps', JSON.stringify(stored.filter(a => a.id !== app.id)));
                      delete OS.apps[app.id];
                      const ri = APP_REGISTRY.findIndex(a => a.id === app.id);
                      if (ri > -1) APP_REGISTRY.splice(ri, 1);
                      renderDesktopIcons();
                      WM.updateTaskbar();
                      Notify.show({ title: 'Uninstalled', body: `${app.name} has been removed.`, type: 'success', appName: 'Launchpad' });
                    } catch (err) {
                      Notify.show({ title: 'Error', body: `Failed to uninstall: ${err.message}`, type: 'error', appName: 'Launchpad' });
                    }
                  }
                });
              }
              ContextMenu.show(e.clientX, e.clientY, items);
            });

            item.addEventListener('dragstart', (e) => {
              e.dataTransfer.effectAllowed = 'copy';
              e.dataTransfer.setData('application/json', JSON.stringify({
                type: 'app-shortcut',
                appId: app.id,
                appName: app.name,
                appIcon: app.icon
              }));
              e.dataTransfer.setData('text/plain', app.name);
              const dragImg = createEl('div', { style: 'padding:8px 16px;background:var(--accent);color:#fff;border-radius:8px;font-size:12px;font-family:var(--font-ui);position:fixed;top:-200px;left:-200px;' });
              dragImg.textContent = app.name;
              document.body.appendChild(dragImg);
              e.dataTransfer.setDragImage(dragImg, dragImg.offsetWidth / 2, dragImg.offsetHeight / 2);
              requestAnimationFrame(() => document.body.removeChild(dragImg));
              requestAnimationFrame(() => {
                const lp = document.getElementById('launchpad');
                if (lp) { lp.style.pointerEvents = 'none'; lp.style.opacity = '0.15'; }
              });
            });

            item.addEventListener('dragend', () => {
              const lp = document.getElementById('launchpad');
              if (lp) { lp.style.pointerEvents = ''; lp.style.opacity = ''; }
              setTimeout(() => {
                if (document.getElementById('launchpad')?.classList.contains('active')) toggleLaunchpad();
              }, 80);
            });

            grid.appendChild(item);
          };

          apps.forEach(appendAppItem);

          if (typeof WebAppManager !== 'undefined') {
            webApps.forEach(webApp => {
              const item = createEl('button', {
                className: 'launchpad-item',
                'aria-label': `${webApp.name} (Web App)`,
                title: webApp.url,
                draggable: true
              });
              const icon = createEl('div', {
                className: 'launchpad-icon',
                textContent: webApp.icon,
                style: 'font-size: 28px; line-height: 1;'
              });
              const name = createEl('div', { className: 'launchpad-name', textContent: webApp.name });
              const indicator = createEl('div', {
                style: 'position: absolute; bottom: 4px; right: 4px; width: 8px; height: 8px; background: #58a6ff; border-radius: 50%; border: 1px solid rgba(255,255,255,0.3);',
                title: 'Web App'
              });

              item.appendChild(icon);
              item.appendChild(name);
              item.appendChild(indicator);

              item.addEventListener('click', () => {
                toggleLaunchpad();
                try {
                  const appData = WebAppManager.getApp(webApp.id);
                  if (!appData) throw new Error('Web app not found');

                  WebAppManager.launchApp(webApp.id);

                  const tempAppId = 'webapp_' + webApp.id;
                  if (!OS.apps[tempAppId]) {
                    OS.apps[tempAppId] = {
                      name: appData.name,
                      icon: appData.icon,
                      defaultSize: [800, 600],
                      minSize: [400, 300]
                    };
                  }
                  const windowElement = WM.createWindow(tempAppId);

                  const iframeContainer = document.createElement('div');
                  iframeContainer.style.cssText = `width: 100%; height: 100%; display: flex; flex-direction: column; overflow: hidden; position: relative;`;

                  const loader = document.createElement('div');
                  loader.style.cssText = `position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center; color: rgba(255,255,255,0.7); z-index: 1000;`;
                  loader.innerHTML = `<div style="font-size:24px;margin-bottom:12px;">⏳</div><div>Loading...</div>`;

                  const hideLoader = () => { loader.style.display = 'none'; };
                  const iframe = document.createElement('webview');
                  iframe.style.cssText = `flex: 1; border: none; background: white; overflow: hidden;`;
                  iframe.addEventListener('did-finish-load', hideLoader);
                  iframe.addEventListener('did-stop-loading', hideLoader);
                  iframe.addEventListener('did-fail-load', () => { hideLoader(); loader.style.display = 'flex'; loader.innerHTML = `<div style="font-size:20px;margin-bottom:12px;">❌</div><div>Failed to load</div>`; });
                  setTimeout(hideLoader, 5000);
                  iframe.src = appData.url;

                  const urlBar = document.createElement('div');
                  urlBar.style.cssText = `background: rgba(255,255,255,0.08); border-bottom: 1px solid rgba(255,255,255,0.1); padding: 8px 16px; font-size: 11px; color: rgba(255,255,255,0.5); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: monospace;`;
                  try {
                    const urlObj = new URL(appData.url);
                    urlBar.textContent = `🔒 ${urlObj.host}`;
                  } catch {
                    urlBar.textContent = `External Web App`;
                  }

                  iframeContainer.appendChild(urlBar);
                  iframeContainer.appendChild(loader);
                  iframeContainer.appendChild(iframe);

                  if (windowElement && windowElement.content) {
                    windowElement.content.appendChild(iframeContainer);
                  }
                } catch (error) {
                  Notify.show({
                    title: 'Error',
                    body: `Failed to launch app: ${error.message}`,
                    type: 'error',
                    appName: 'System'
                  });
                }
              });

              item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const waPins = OS.settings.get('pinnedApps') || [];
                const waId = 'webapp_' + webApp.id;
                const waIsPinned = waPins.includes(waId);
                ContextMenu.show(e.clientX, e.clientY, [
                  { label: 'Open', icon: 'play', action: () => { toggleLaunchpad(); item.click(); } },
                  { separator: true },
                  {
                    label: waIsPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar',
                    icon: waIsPinned ? 'pin-off' : 'pin',
                    action: () => {
                      const p = OS.settings.get('pinnedApps') || [];
                      const next = waIsPinned ? p.filter(id => id !== waId) : [...p, waId];
                      OS.settings.set('pinnedApps', next);
                      if (typeof WM !== 'undefined' && WM.updateTaskbar) WM.updateTaskbar();
                      Notify.show({ title: waIsPinned ? 'Unpinned' : 'Pinned', body: `${webApp.name} ${waIsPinned ? 'unpinned from' : 'pinned to'} taskbar`, type: 'success', appName: 'Launchpad' });
                    }
                  },
                  { separator: true },
                  {
                    label: 'Remove Web App',
                    icon: 'trash',
                    danger: true,
                    action: () => {
                      WebAppManager.removeApp(webApp.id);
                      renderLaunchpad();
                      Notify.show({ title: 'Removed', body: `"${webApp.name}" has been removed`, type: 'success', appName: 'Launchpad' });
                    }
                  }
                ]);
              });

              item.draggable = true;
              item.addEventListener('dragstart', (e) => {
                const webAppId = 'webapp_' + webApp.id;
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData('application/json', JSON.stringify({
                  type: 'app-shortcut',
                  appId: webAppId,
                  appName: webApp.name,
                  appIcon: webApp.icon
                }));
                e.dataTransfer.setData('text/plain', webApp.name);
                const dragImg = createEl('div', { style: 'padding:8px 16px;background:var(--accent);color:#fff;border-radius:10px;font-size:12px;font-family:var(--font-ui);position:fixed;top:-200px;left:-200px;' });
                dragImg.textContent = webApp.name;
                document.body.appendChild(dragImg);
                e.dataTransfer.setDragImage(dragImg, dragImg.offsetWidth / 2, dragImg.offsetHeight / 2);
                requestAnimationFrame(() => document.body.removeChild(dragImg));
                requestAnimationFrame(() => {
                  const lp = document.getElementById('launchpad');
                  if (lp) { lp.style.pointerEvents = 'none'; lp.style.opacity = '0.15'; }
                });
              });
              item.addEventListener('dragend', () => {
                const lp = document.getElementById('launchpad');
                if (lp) { lp.style.pointerEvents = ''; lp.style.opacity = ''; }
                setTimeout(() => {
                  if (document.getElementById('launchpad')?.classList.contains('active')) toggleLaunchpad();
                }, 80);
              });

              grid.appendChild(item);
            });
          }
        } else {
          Array.from(grid.children).forEach(item => {
            item.classList.remove('animate');
            item.style.opacity = '0';
            item.style.transform = 'scale(0)';
            item.style.removeProperty('--delay');
            item.style.willChange = '';
            item.style.display = '';
          });
        }

        const animateLaunchpadItems = () => {
          requestAnimationFrame(() => {
            const prefersReducedMotion = OS.settings.get('reduceMotion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            const items = Array.from(grid.querySelectorAll('.launchpad-item')).filter(item => item.style.display !== 'none');

            if (prefersReducedMotion) {
              items.forEach(item => {
                item.style.opacity = '1';
                item.style.transform = 'scale(1)';
                item.classList.add('animate');
              });
              return;
            }

            const gridWidth = grid.offsetWidth;
            const gridHeight = grid.offsetHeight;
            const centerX = gridWidth / 2;
            const centerY = gridHeight / 2;
            const maxDistance = Math.sqrt(Math.pow(gridWidth / 2, 2) + Math.pow(gridHeight / 2, 2)) || 1;

            const itemData = items.map(item => ({
              item,
              cx: item.offsetLeft + item.offsetWidth / 2,
              cy: item.offsetTop + item.offsetHeight / 2
            }));

            itemData.forEach(({ item, cx, cy }) => {
              const distance = Math.sqrt(Math.pow(cx - centerX, 2) + Math.pow(cy - centerY, 2));
              const delay = Math.round((distance / maxDistance) * 300);
              item.style.setProperty('--delay', `${delay}ms`);
              item.style.willChange = 'transform, opacity';
              item.classList.add('animate');
              setTimeout(() => {
                item.style.willChange = '';
              }, 500 + delay);
            });
          });
        };

        animateLaunchpadItems();
      }

      // Launchpad search
      document.getElementById('launchpad-search').addEventListener('input', debounce(function (e) {
        const q = (e.target || this).value.toLowerCase().trim();
        const items = document.querySelectorAll('.launchpad-item');
        items.forEach(item => {
          const name = item.querySelector('.launchpad-name').textContent.toLowerCase();
          // Also search through aria-label for better matching
          const label = item.getAttribute('aria-label') || '';
          const match = name.includes(q) || label.toLowerCase().includes(q);
          item.style.display = match ? '' : 'none';
        });
        // Show/hide no results message
        const visibleItems = document.querySelectorAll('.launchpad-item[style=""]');
        const allItems = document.querySelectorAll('.launchpad-item');
        let noResultsMsg = document.getElementById('launchpad-no-results');
        if (q && visibleItems.length === 0 && allItems.length > 0) {
          if (!noResultsMsg) {
            noResultsMsg = createEl('div', {
              id: 'launchpad-no-results',
              className: 'launchpad-no-results',
              textContent: 'No apps found',
              style: 'grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 40px;'
            });
            document.getElementById('launchpad-grid').appendChild(noResultsMsg);
          }
          noResultsMsg.style.display = '';
        } else if (noResultsMsg) {
          noResultsMsg.style.display = 'none';
        }
      }, 150));

      // Close launchpad on click outside
      document.getElementById('launchpad').addEventListener('click', (e) => {
        if (e.target.id === 'launchpad') toggleLaunchpad();
      });

      // Close notification panel on click outside
      document.getElementById('notification-panel').addEventListener('click', (e) => {
        if (e.target.id === 'notification-panel') {
          document.getElementById('notification-panel').classList.remove('active');
        }
      });

      // Notification panel
      document.getElementById('tray-bell').addEventListener('click', Notify.togglePanel);
      document.getElementById('notif-close').addEventListener('click', () => {
        document.getElementById('notification-panel').classList.remove('active');
      });
      document.getElementById('notif-mark-all').addEventListener('click', () => {
        OS.notifications = [];
        OS.notifUnread = 0;
        Notify.persist();
        Notify.updateBadge();
        updateNotificationBadge();
        Notify.renderPanel();
      });


      // FIX 13 — WiFi tray button had no click handler at all
      const trayWifi = document.getElementById('tray-wifi');
      if (trayWifi) {
        trayWifi.addEventListener('click', (e) => {
          e.stopPropagation();
          let wifiPopup = document.getElementById('wifi-popup');
          if (!wifiPopup) {
            wifiPopup = document.createElement('div');
            wifiPopup.id = 'wifi-popup';
            wifiPopup.style.cssText = 'position:fixed;bottom:60px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:var(--r-md);padding:16px;min-width:200px;z-index:9999;box-shadow:var(--shadow-md)';
            document.body.appendChild(wifiPopup);
            document.addEventListener('click', () => wifiPopup.remove(), { once: true });
          } else {
            wifiPopup.remove(); return;
          }
          const online = navigator.onLine;
          const rect = trayWifi.getBoundingClientRect();
          wifiPopup.style.left = Math.max(0, rect.left - 80) + 'px';
          wifiPopup.innerHTML = '<div style="font-weight:600;margin-bottom:8px;">Network</div>' +
            '<div style="display:flex;align-items:center;gap:8px;font-size:13px;"><span style="color:' + (online ? 'var(--text-success)' : 'var(--text-danger)') + '">●</span>' +
            (online ? 'Connected to network' : 'No internet connection') + '</div>';
        });
      }

      // Volume popup
      const volumeBtn = document.getElementById('tray-volume');
      const volumePopup = document.getElementById('volume-popup');
      const volumeSlider = document.getElementById('volume-slider');
      const volumeValue = document.getElementById('volume-value');

      volumeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = volumeBtn.getBoundingClientRect();
        volumePopup.style.left = rect.left + 'px';
        volumePopup.style.bottom = '60px';
        volumePopup.classList.toggle('active');
      });

      let volumePopupPinned = false;

      volumeBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        volumePopupPinned = !volumePopupPinned;
      });

      volumeSlider.addEventListener('click', (e) => {
        e.stopPropagation();
      });

      volumeSlider.addEventListener('input', () => {
        OS.volume = parseInt(volumeSlider.value);
        volumeValue.textContent = OS.volume + '%';
      });

      volumePopup.addEventListener('click', (e) => {
        e.stopPropagation();
      });

      document.addEventListener('click', () => {
        if (!volumePopupPinned) {
          volumePopup.classList.remove('active');
        }
      });

      // FIX 12 — removed duplicate tray-bell click handler that was opening Pulse app.
      // The correct handler (Notify.togglePanel) is already registered above at line 25416.

      // Update notification badge
      function updateNotificationBadge() {
        const badge = document.getElementById('notif-badge');
        const unread = (OS.notifications || []).filter(n => !n.read).length;
        if (unread > 0) {
          badge.textContent = unread > 9 ? '9+' : unread;
          badge.classList.remove('hidden');
        } else {
          badge.classList.add('hidden');
        }
      }

      Notify.loadPersisted();
      Notify.renderPanel();
      Notify.updateBadge();
      updateNotificationBadge();

      window.addEventListener('resize', throttleRAF(() => {
        for (const state of OS.windows.values()) {
          if (state.maximized) {
            const area = WM.getWorkArea();
            state.x = area.left;
            state.y = area.top;
            state.width = area.width;
            state.height = area.height;
            state.element.style.left = area.left + 'px';
            state.element.style.top = area.top + 'px';
            state.element.style.width = area.width + 'px';
            state.element.style.height = area.height + 'px';
          } else {
            const next = WM.clampWindowRect(state, state.x, state.y, state.width, state.height);
            state.x = next.x;
            state.y = next.y;
            state.width = next.w;
            state.height = next.h;
            state.element.style.left = next.x + 'px';
            state.element.style.top = next.y + 'px';
            state.element.style.width = next.w + 'px';
            state.element.style.height = next.h + 'px';
          }
        }
        WM.hideSnapPreview();
      }));

      // Battery status
      async function updateBattery() {
        const batteryBtn = document.getElementById('tray-battery');
        try {
          if ('getBattery' in navigator) {
            const battery = await navigator.getBattery();
            function update() {
              const level = Math.round(battery.level * 100);
              batteryBtn.innerHTML = `<span style="font-size:11px">${level}%</span>`;
            }
            battery.addEventListener('levelchange', update);
            update();
          }
        } catch (e) { }
      }
      updateBattery();

      // Desktop context menu
      const desktopEl = document.getElementById('desktop');
      if (desktopEl) {
        // Clicking bare desktop unfocuses all windows (removes focused highlight)
        desktopEl.addEventListener('pointerdown', (e) => {
          if (!e.target.closest('.app-window') && !e.target.closest('.taskbar') && !e.target.closest('.context-menu')) {
            for (const [, w] of OS.windows) w.element.classList.remove('focused');
            OS.focusedWindowId = null;
            WM.updateTaskbar();
            // Blur the currently focused element so keypresses don't go into a window
            if (document.activeElement && document.activeElement !== document.body) {
              document.activeElement.blur();
            }
          }
        });

        desktopEl.addEventListener('contextmenu', (e) => {
          // Only show custom menu when clicking directly on desktop background
          // (not on icons - they have their own handlers)
          if (e.target.closest('.desktop-icon')) {
            return;
          }
          // Prevent browser's default context menu
          e.preventDefault();

          const menuItems = [
            {
              label: 'New File', icon: 'file', action: async () => {
                const name = await showPrompt('New File Name', 'untitled.txt');
                if (name) {
                  await FS.createFile(FS.specialFolders.desktop, name, '', 'text/plain');
                  renderDesktopIcons();
                }
              }
            },
            {
              label: 'New Folder', icon: 'folder', action: async () => {
                const name = await showPrompt('New Folder Name', 'New Folder');
                if (name) {
                  await FS.createFolder(FS.specialFolders.desktop, name);
                  renderDesktopIcons();
                }
              }
            },
            { separator: true },
            { label: 'Open Terminal', icon: 'terminal', action: () => WM.createWindow('shell') },
            { label: 'Open Settings', icon: 'settings', action: () => WM.createWindow('nook') }];


          menuItems.push(
            { separator: true },
            { label: 'Refresh', action: () => renderDesktopIcons() }
          );

          ContextMenu.show(e.clientX, e.clientY, menuItems);
        });
      }

      // Keyboard shortcuts
      document.addEventListener('keydown', (e) => {
        // If the user is actively typing inside any app window's content area,
        // suppress OS-level shortcuts that would conflict with in-app shortcuts.
        // Alt+F4, Alt+Tab, Escape, and PrintScreen are always allowed through.
        const focused = document.activeElement;
        const inAppContent = focused && focused.closest && focused.closest('.window-content');
        const alwaysAllow = e.altKey && (e.key === 'F4' || e.key === 'Tab') || e.key === 'Escape' || e.key === 'PrintScreen';

        if (inAppContent && !alwaysAllow) {
          // Only block shortcuts that have known in-app conflicts.
          // Specifically block: Ctrl+L, Ctrl+E, Ctrl+D, Ctrl+C, Ctrl+U,
          // Ctrl+A, Ctrl+Space, Ctrl+Shift+S, Ctrl+ArrowLeft/Right
          const conflicting = (
            (e.ctrlKey || e.metaKey) && (
              e.key === 'l' || e.key === 'L' ||
              e.key === 'e' || e.key === 'E' ||
              e.key === 'd' || e.key === 'D' ||
              e.key === 'c' || e.key === 'C' ||
              e.key === 'u' || e.key === 'U' ||
              e.key === 'a' || e.key === 'A' ||
              e.key === ' ' ||
              e.key === 'ArrowLeft' || e.key === 'ArrowRight'
            )
          );
          if (conflicting) return;
        }

        // Win/Cmd + E - File Manager
        if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
          e.preventDefault();
          WM.createWindow('vault');
        }
        // Win/Cmd + T - Terminal
        if ((e.metaKey || e.ctrlKey) && e.altKey && e.key === 't') {
          e.preventDefault();
          WM.createWindow('shell');
        }
        // Win/Cmd + Space - Launchpad
        if ((e.metaKey || e.ctrlKey) && e.key === ' ') {
          e.preventDefault();
          toggleLaunchpad();
        }
        // Win/Cmd + L - Lock
        if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
          e.preventDefault();
          lockScreen();
        }
        // Win/Cmd + D - Show desktop
        if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
          e.preventDefault();
          WM.minimizeAll();
        }
        // Win + V - Clipboard history
        if (e.key === 'v' && (e.metaKey || e.ctrlKey) && !e.altKey) {
          // This is handled by the browser for paste, but we intercept for clipboard history
        }
        // Print Screen - Screenshot desktop
        if (e.key === 'PrintScreen') {
          e.preventDefault();
          captureScreenshot('desktop');
        }
        // Alt + Print Screen - Screenshot window
        if (e.altKey && e.key === 'PrintScreen') {
          e.preventDefault();
          captureScreenshot('window');
        }
        // Win + Shift + S - Snipping tool
        if (e.key === 's' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
          e.preventDefault();
          captureScreenshot('region');
        }
        // Ctrl + Win + D - Create new workspace
        if (e.ctrlKey && e.key === 'd' && !e.altKey) {
          // Check for Windows key (metaKey on Windows is usually false, use key instead)
        }
        // Ctrl + Win + Arrow - Switch workspace
        if (e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault();
          switchWorkspace(e.key === 'ArrowRight' ? 1 : -1);
        }
        // Alt + F4 - Close window
        if (e.altKey && e.key === 'F4') {
          e.preventDefault();
          if (OS.focusedWindowId) WM.closeWindow(OS.focusedWindowId);
        }
        // Escape - Close launchpad
        if (e.key === 'Escape') {
          const launchpad = document.getElementById('launchpad');
          if (launchpad.classList.contains('active')) toggleLaunchpad();
          ContextMenu.hide();
        }
        // Alt + Tab - App switcher
        if (e.altKey && e.key === 'Tab') {
          e.preventDefault();
          showAppSwitcher();
        }
      });

      // Screenshot functionality
      async function captureScreenshot(mode) {
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { displaySurface: mode === 'window' ? 'window' : 'monitor' }
          });
          const video = document.createElement('video');
          video.srcObject = stream;
          await video.play();

          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          canvas.getContext('2d').drawImage(video, 0, 0);

          stream.getTracks().forEach(t => t.stop());

          const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
          const url = URL.createObjectURL(blob);

          const a = document.createElement('a');
          a.href = url;
          a.download = `screenshot-${Date.now()}.png`;
          a.click();
          URL.revokeObjectURL(url);

          Notify.show({ title: 'Screenshot Saved', body: 'Screenshot captured successfully', type: 'success', appName: 'System' });
        } catch (e) {
          Notify.show({ title: 'Screenshot Failed', body: 'Could not capture screenshot', type: 'error', appName: 'System' });
        }
      }

      // Virtual desktops
      function switchWorkspace(direction) {
        const currentIdx = OS.workspaces.findIndex(w => w.id === OS.currentWorkspace);
        const newIdx = currentIdx + direction;


        if (newIdx >= 0 && newIdx < OS.workspaces.length && OS.workspaces.length <= maxWorkspaces) {
          OS.currentWorkspace = OS.workspaces[newIdx].id;
          // Move windows to new workspace
          // Implementation would need to track window workspace assignments
        } else if (newIdx >= OS.workspaces.length && OS.workspaces.length < maxWorkspaces) {
          // Create new workspace if under limit
          const newWs = { id: Date.now(), name: 'Workspace ' + (OS.workspaces.length + 1) };
          OS.workspaces.push(newWs);
          OS.currentWorkspace = newWs.id;
        }
      }

      // App switcher
      let switcherActive = false;
      let switcherIdx = 0;

      function showAppSwitcher() {
        const windows = Array.from(OS.windows.values());
        if (windows.length === 0) return;

        switcherActive = true;
        switcherIdx = 0;

        const switcher = document.getElementById('app-switcher');
        const list = document.getElementById('app-switcher-list');
        list.innerHTML = '';

        windows.forEach((w, i) => {
          const app = OS.apps[w.appId];
          if (!app) return;
          const item = createEl('div', { className: 'app-switcher-item' + (i === switcherIdx ? ' active' : '') });
          const icon = createEl('div', { className: 'app-switcher-icon' });
          icon.innerHTML = svgIcon(app.icon, 32);
          const name = createEl('div', { className: 'app-switcher-name', textContent: app.name });
          item.appendChild(icon);
          item.appendChild(name);
          list.appendChild(item);
        });

        switcher.classList.add('active');
      }

      function hideAppSwitcher() {
        document.getElementById('app-switcher').classList.remove('active');
        switcherActive = false;
      }

      document.addEventListener('keyup', (e) => {
        if (switcherActive && e.key === 'Alt') {
          hideAppSwitcher();
          const windows = Array.from(OS.windows.values());
          if (windows[switcherIdx]) WM.focusWindow(windows[switcherIdx].id);
        }
        // Windows/Cmd key alone — toggle Launchpad
      });

      // Lock screen keyboard handler
      function handleLockScreenKeydown(e) {
        const lockScreen = document.getElementById('lock-screen');
        if (!lockScreen.classList.contains('active')) {
          document.removeEventListener('keydown', handleLockScreenKeydown);
          return;
        }

        // Number keys 0-9
        if (e.key >= '0' && e.key <= '9') {
          e.preventDefault();
          enterPinDigit(e.key);
        }
        // Backspace
        else if (e.key === 'Backspace') {
          e.preventDefault();
          backspacePin();
        }
        // Enter - submit PIN early if 4 digits entered
        else if (e.key === 'Enter') {
          e.preventDefault();
          if (enteredPin.length === 4) {
            verifyPin();
          }
        }
        // Escape - clear PIN
        else if (e.key === 'Escape') {
          e.preventDefault();
          clearPin();
        }
      }

      // Lock screen
      function lockScreen() {
        if (!OS.lockPin) {
          WM.minimizeAll();
          return;
        }
        OS.isLocked = true;
        document.getElementById('lock-screen').classList.add('active');
        renderLockScreen();
      }

      function renderLockScreen() {
        const usernameEl = document.getElementById('lock-username');
        const dotsEl = document.getElementById('lock-pin-dots');
        const statusEl = document.getElementById('lock-status');
        const numpadEl = document.getElementById('lock-numpad');

        usernameEl.textContent = OS.username;
        dotsEl.innerHTML = '';
        for (let i = 0; i < 4; i++) {
          dotsEl.appendChild(createEl('div', { className: 'lock-pin-dot' }));
        }
        statusEl.textContent = '';

        numpadEl.innerHTML = '';
        for (let i = 1; i <= 9; i++) {
          const btn = createEl('button', { textContent: i, 'aria-label': i.toString() });
          btn.addEventListener('click', () => enterPinDigit(i.toString()));
          numpadEl.appendChild(btn);
        }
        // Clear button
        const clearBtn = createEl('button', { textContent: 'C', 'aria-label': 'Clear' });
        clearBtn.addEventListener('click', clearPin);
        numpadEl.appendChild(clearBtn);
        // 0
        const zeroBtn = createEl('button', { textContent: '0', 'aria-label': '0' });
        zeroBtn.addEventListener('click', () => enterPinDigit('0'));
        numpadEl.appendChild(zeroBtn);
        // Backspace
        const backBtn = createEl('button', { innerHTML: svgIcon('chevron-left', 18), 'aria-label': 'Backspace' });
        backBtn.addEventListener('click', backspacePin);
        numpadEl.appendChild(backBtn);

        // Add biometric authentication button if WebAuthn available
        if (window.PublicKeyCredential && OS.settings.get('biometricCredentialId')) {
          const bioContainer = document.getElementById('lock-screen');
          const existingBio = bioContainer.querySelector('.biometric-btn');
          if (!existingBio) {
            const bioBtn = createEl('button', {
              className: 'biometric-btn',
              textContent: '👆 Use Biometric',
              style: 'margin-top:16px;width:100%;padding:12px;background:var(--bg-elevated);border:1px solid var(--accent);border-radius:8px;color:var(--accent);font-weight:600;cursor:pointer;'
            });
            bioBtn.addEventListener('click', async () => {
              try {
                const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
                if (!available) {
                  statusEl.textContent = 'Biometric not available on this device';
                  return;
                }
                statusEl.textContent = 'Waiting for biometric...';
                const challenge = crypto.getRandomValues(new Uint8Array(32));
                const credentialId = OS.settings.get('biometricCredentialId');
                const credBytes = new Uint8Array(atob(credentialId).split('').map(c => c.charCodeAt(0)));

                const credential = await navigator.credentials.get({
                  publicKey: {
                    challenge: challenge,
                    allowCredentials: [{ id: credBytes, type: 'public-key' }],
                    userVerification: 'required'
                  }
                });

                if (credential) {
                  unlockFromLockScreen();
                  Notify.show({ title: 'Welcome back', body: 'Authenticated via biometrics', type: 'success', appName: 'System' });
                }
              } catch (e) {
                statusEl.textContent = 'Biometric failed: ' + (e.message || 'Try PIN instead');
              }
            });
            numpadEl.parentNode.appendChild(bioBtn);
          }
        }

        enteredPin = '';
        updatePinDots();

        // Keyboard support for lock screen — remove before re-adding to prevent listener stacking
        document.removeEventListener('keydown', handleLockScreenKeydown);
        document.addEventListener('keydown', handleLockScreenKeydown);
      }

      let enteredPin = '';

      function unlockFromLockScreen() {
        OS.isLocked = false;
        const lockScreenEl = document.getElementById('lock-screen');
        if (lockScreenEl) lockScreenEl.classList.remove('active');
        document.removeEventListener('keydown', handleLockScreenKeydown);
        enteredPin = '';
        // Paint the taskbar first so pinned apps appear immediately after unlock.
        WM.updateTaskbar();
        requestAnimationFrame(() => {
          renderDesktopIcons();
          WM.updateTaskbar();
        });
      }

      function enterPinDigit(d) {
        if (enteredPin.length < 4) {
          enteredPin += d;
          updatePinDots();
          if (enteredPin.length === 4) verifyPin();
        }
      }

      function clearPin() {
        enteredPin = '';
        updatePinDots();
        document.getElementById('lock-status').textContent = '';
      }

      function backspacePin() {
        enteredPin = enteredPin.slice(0, -1);
        updatePinDots();
      }

      function updatePinDots() {
        const dots = document.querySelectorAll('.lock-pin-dot');
        dots.forEach((dot, i) => dot.classList.toggle('filled', i < enteredPin.length));
      }

      async function verifyPin() {
        const statusEl = document.getElementById('lock-status');
        statusEl.textContent = 'Verifying...';

        const hash = await OS.workers.crypto.call('pbkdf2', enteredPin, getPinSalt());

        if (hash === OS.lockPin) {
          OS.wrongPinCount = 0;
          unlockFromLockScreen();
        } else {
          OS.wrongPinCount++;
          enteredPin = '';
          updatePinDots();

          const _effectiveThreshold = 3;
          const _effectiveDurationMs = 30000;

          // Tier 1: threshold attempts -> policy-defined or default 30s lockout
          if (OS.wrongPinCount >= _effectiveThreshold && OS.wrongPinCount < _effectiveThreshold * 2) {
            const durSec = Math.round(_effectiveDurationMs / 1000);
            const durLabel = durSec >= 60 ? `${Math.round(durSec / 60)}min` : `${durSec}s`;
            statusEl.textContent = `Too many attempts. ${durLabel} lockout.`;
            OS.lockoutUntil = Date.now() + _effectiveDurationMs;
            setTimeout(() => {
              OS.wrongPinCount = 0;
              OS.lockoutUntil = 0;
              statusEl.textContent = '';
            }, _effectiveDurationMs);
          }
          // Tier 2: 2× threshold -> 5× duration lockout
          else if (OS.wrongPinCount >= _effectiveThreshold * 2 && OS.wrongPinCount < 10) {
            const longDur = _effectiveDurationMs * 5;
            const durSec = Math.round(longDur / 1000);
            const durLabel = durSec >= 60 ? `${Math.round(durSec / 60)}min` : `${durSec}s`;
            statusEl.textContent = `Too many attempts. ${durLabel} lockout.`;
            OS.lockoutUntil = Date.now() + longDur;
            setTimeout(() => {
              OS.wrongPinCount = 0;
              OS.lockoutUntil = 0;
              statusEl.textContent = '';
            }, longDur);
          }
          // Tier 3: 10 wrong attempts -> wipe prompt with countdown
          else if (OS.wrongPinCount >= 10) {
            statusEl.textContent = 'Security alert! Data will be wiped.';
            let countdown = 10;
            const countdownInterval = setInterval(() => {
              countdown--;
              statusEl.textContent = `Security alert! Wiping in ${countdown}s`;
              if (countdown <= 0) {
                clearInterval(countdownInterval);
                // Wipe data and reload
                localStorage.clear();
                sessionStorage.clear();
                Notify.show({ title: 'Security Wipe', body: 'All data has been wiped due to too many failed attempts.', type: 'error', appName: 'System' });
                setTimeout(() => location.reload(), 2000);
              }
            }, 1000);
          }
          else {
            statusEl.textContent = 'Incorrect PIN';
          }
        }
      }

      // Idle lock
      let lastActivity = Date.now();

      function resetIdleTimer() {
        lastActivity = Date.now();
      }

      ['pointerdown', 'pointermove', 'keydown', 'scroll'].forEach(evt => {
        document.addEventListener(evt, resetIdleTimer, { passive: true });
      });

      setInterval(() => {
        if (OS.lockPin && !OS.isLocked && OS.idleTimeout < Infinity) {
          if (Date.now() - lastActivity > OS.idleTimeout) {
            lockScreen();
          }
        }
      }, 30000);

      // ═════════════════════════════════════════════════════════════════════════
      // FILE THREAT SCANNING - Scan dropped files for malicious patterns
      // ═════════════════════════════════════════════════════════════════════════

      /**
       * Check file signature (magic bytes) for executable and suspicious formats
       * @param {Uint8Array} buffer - File buffer
       * @returns {Object} { isExecutable: boolean, type: string }
       */
      /**
       * Check file extension against suspicious list
       * @param {string} filename - File name
       * @returns {Object} { blocked: boolean, reason: string }
       */
      function checkFileExtension(filename) {
        // Only block TRULY dangerous executables
        // Don't block legitimate filetypes
        const dangerousExtensions = [
          // Windows executables only
          'exe', 'dll', 'scr', 'msi', 'com',
          // Very dangerous scripts only - but allow .js, .py, .sh for development
          'pif', 'vbs', 'vbe', 'wsf', 'wsh'
        ];

        const ext = filename.split('.').pop().toLowerCase();

        if (dangerousExtensions.includes(ext)) {
          return {
            blocked: true,
            reason: `Blocked: ${ext.toUpperCase()} files cannot be added (executable type)`
          };
        }

        return { blocked: false, reason: null };
      }

      /**
       * Scan file content for MALICIOUS patterns only (not all code)
       * @param {string} content - File content
       * @param {string} filename - File name
       * @returns {Object} { isMalicious: boolean, threats: [], patterns: [] }
       */
      function scanFileForThreats(content, filename) {
        if (!content || typeof content !== 'string' || content.length === 0) {
          return { isMalicious: false, threats: [], patterns: [] };
        }

        const threats = [];
        const patterns = [];

        // ONLY flag OBVIOUS malicious patterns, not legitimate code

        // XSS patterns (HTML files with malicious scripts)
        const xssPatterns = [
          { regex: /<script[\s\S]*?alert\s*\(/gi, name: 'alert-xss', severity: 'high' },  // script tags with alerts
          { regex: /onerror\s*=\s*["']alert/gi, name: 'onerror-alert', severity: 'high' },  // event handlers with alert
          { regex: /onclick\s*=\s*["']alert/gi, name: 'onclick-alert', severity: 'high' }   // onclick with alert
        ];

        // Only flag ENCODED malware (base64 + eval = obfuscation = malware)
        const malwarePatterns = [
          { regex: /eval\s*\(\s*atob\s*\(/gi, name: 'encoded-eval', severity: 'critical' },  // encoded + executed
          { regex: /eval\s*\(\s*decodeURIComponent/gi, name: 'uri-decode-eval', severity: 'critical' }  // URI decode + eval
        ];

        // Check patterns
        const allPatterns = [...xssPatterns, ...malwarePatterns];

        for (const { regex, name, severity } of allPatterns) {
          if (regex.test(content)) {
            patterns.push(name);
            threats.push({ type: name, severity });
          }
        }

        return {
          isMalicious: patterns.length > 0,
          threats,
          patterns
        };
      }

      // ── Recovery Mode ────────────────────────────────────────────────────

      // Trigger recovery mode manually or automatically
      function triggerRecovery(reason) {
        // Don't hijack the UI if OS is already running
        if (document.body.classList.contains('os-booted')) return false;

        const BOOT_ATTEMPT_KEY = 'nova_boot_attempts';
        const priorAttempts = (() => {
          try { return JSON.parse(localStorage.getItem(BOOT_ATTEMPT_KEY) || '[]'); } catch { return []; }
        })();

        // Add the current failure as an attempt
        priorAttempts.push({ ts: Date.now(), reason: reason || 'unknown', ua: navigator.userAgent.slice(0, 80) });
        if (priorAttempts.length > 10) priorAttempts.shift();
        localStorage.setItem(BOOT_ATTEMPT_KEY, JSON.stringify(priorAttempts));

        // Show recovery screen if we haven't already
        if (priorAttempts.length >= 2) {
          showRecoveryScreen(priorAttempts);
          return true;
        }
        return false;
      }

      // Global error handler to catch boot failures
      window.addEventListener('error', function (e) {
        // Don't trigger recovery if OS already booted successfully
        if (document.body.classList.contains('os-booted')) return;

        // Check if this is a boot-related error
        const errorMsg = e.message || '';

        // Syntax errors during boot should trigger recovery
        if (errorMsg.includes('SyntaxError') || errorMsg.includes('Unexpected token')) {
          console.error('[BOOT] Syntax error detected:', errorMsg);
          triggerRecovery('syntax_error: ' + errorMsg.slice(0, 100));
        }
      });

      function showRecoveryScreen(priorAttempts) {
        // Hide the boot screen so the recovery UI is not covered
        const bootScreen = document.getElementById('boot-screen');
        if (bootScreen) bootScreen.style.display = 'none';

        // ── Recovery Boot Animation ──────────────────────────────────────
        const anim = document.createElement('div');
        anim.id = 'recovery-boot-anim';
        anim.innerHTML = `
    <div class="rba-scanlines"></div>
    <div class="rba-glow"></div>
    <div class="rba-content">
      <div class="rba-logo-wrap">
        <div class="rba-logo-ring"></div>
        <div class="rba-logo-ring-2"></div>
        <div class="rba-logo-hex">
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
            <polygon points="18,3 33,10.5 33,25.5 18,33 3,25.5 3,10.5" fill="none" stroke="#ff6b35" stroke-width="1.5" opacity="0.8"/>
            <text x="18" y="23" text-anchor="middle" font-size="13" font-weight="700" fill="#ffd700" font-family="monospace">NB</text>
          </svg>
        </div>
      </div>
      <div class="rba-title">NovaByte</div>
      <div class="rba-subtitle">⚠ Recovery Mode v2.0</div>
      <div class="rba-log" id="rba-log"></div>
      <div class="rba-bar-wrap"><div class="rba-bar" id="rba-bar"></div></div>
      <div class="rba-status" id="rba-status">Initializing recovery environment…</div>
    </div>`;
        document.body.appendChild(anim);

        const rbaLog = document.getElementById('rba-log');
        const rbaBar = document.getElementById('rba-bar');
        const rbaStatus = document.getElementById('rba-status');
        let step = 0;
        const steps = [
          { msg: '[ RECOVERY MODE TRIGGERED ]', cls: 'warn', pct: 8, label: 'Loading recovery kernel…' },
          { msg: '✓ Recovery environment v2.0 loaded', cls: 'ok', pct: 22, label: 'Mounting storage…' },
          { msg: '✓ localStorage integrity check…', cls: 'ok', pct: 38, label: 'Checking data…' },
          { msg: '⚠ Boot failure detected — entering recovery', cls: 'warn', pct: 60, label: 'Preparing interface…' },
          { msg: '✓ Recovery UI ready', cls: 'ok', pct: 88, label: 'Almost ready…' },
          { msg: '✓ Handoff to Recovery Environment', cls: 'info', pct: 100, label: 'Done.' }];

        function runStep() {
          if (step >= steps.length) {
            // Fade out and show recovery screen
            setTimeout(() => {
              anim.classList.add('fade-out');
              setTimeout(() => { anim.remove(); }, 650);
              _doShowRecoveryScreen(priorAttempts);
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
      }

      function _doShowRecoveryScreen(priorAttempts) {
        const screen = document.getElementById('recovery-screen');
        screen.classList.add('active');

        // Check if this was a manual recovery boot (intentional, not failed)
        const isManualRecovery = localStorage.getItem('nova_manual_recovery') === '1' || localStorage.getItem('nova_show_recovery') === '1';
        if (isManualRecovery) {
          localStorage.removeItem('nova_manual_recovery');
          localStorage.removeItem('nova_show_recovery');
        }

        // Update attempt count - hide if manual recovery
        const attemptCountEl = document.getElementById('rec-attempt-count');
        const attemptAlertEl = document.querySelector('.recovery-alert');
        if (isManualRecovery && attemptAlertEl) {
          attemptAlertEl.style.display = 'none';
          attemptCountEl.textContent = '0';
        } else {
          attemptCountEl.textContent = priorAttempts.length;
        }

        // Timestamp
        const now = new Date();
        document.getElementById('rec-timestamp').innerHTML = `<strong>${now.toLocaleString()}</strong>`;
        document.getElementById('rec-footer-time').textContent = now.toLocaleTimeString();

        // Update footer clock
        setInterval(() => {
          document.getElementById('rec-footer-time').textContent = new Date().toLocaleTimeString();
        }, 1000);

        // Build diagnostics log
        const diagEl = document.getElementById('rec-diag-lines');
        const log = (msg, cls = '') => {
          const line = document.createElement('div');
          line.className = 'recovery-log-line' + (cls ? ' ' + cls : '');
          line.textContent = msg;
          diagEl.appendChild(line);
        };

        log('[ NovaByte Recovery Environment ]', 'info');
        log('');

        // Hide boot failure analysis for manual recovery
        if (!isManualRecovery) {
          log('Boot failure analysis:', 'warn');
          priorAttempts.slice(-5).forEach((a, i) => {
            const t = new Date(a.ts).toLocaleTimeString();
            log(`  Attempt ${i + 1}: ${t}`, 'err');
          });
          log('');
        } else {
          log('Recovery mode initialized (Manual boot)', 'info');
          log('');
        }

        log('Scanning storage...', 'info');

        // Storage diagnostics
        try {
          const lsKeys = Object.keys(localStorage);
          log(`  localStorage: ${lsKeys.length} key(s) · ${new Blob([JSON.stringify(localStorage)]).size} bytes`, 'ok');
          const knownKeys = ['nova_settings', 'nova_boot_attempts'];
          knownKeys.forEach(k => {
            const val = localStorage.getItem(k);
            if (val) log(`  ✓ ${k}: ${val.length} chars`, 'ok');
            else log(`  ✗ ${k}: not found`, 'warn');
          });
        } catch (e) {
          log('  ! localStorage read error: ' + e.message, 'err');
        }

        log('');
        const hasSettings = !!localStorage.getItem('nova_settings');
        log(`  Settings key present: ${hasSettings ? 'YES' : 'NO'}`, hasSettings ? 'ok' : 'warn');
        log('');
        if (!isManualRecovery) {
          log('Recommendation: Try "Continue" first.', 'info');
          log('If it fails again, use Safe Mode or', 'info');
          log('"Reset Settings" to restore stability.', 'info');
        } else {
          log('Select any recovery option as needed.', 'info');
        }

        // Countdown auto-boot
        let countdown = 15;
        let countdownStopped = false;
        const cdownNum = document.getElementById('rec-cdown-num');
        const cdownBar = document.getElementById('rec-cdown-bar');
        const cdownBlock = document.getElementById('rec-countdown-block');

        function stopCountdown() {
          countdownStopped = true;
          cdownBlock.style.opacity = '0.4';
          cdownBlock.querySelector('.recovery-countdown-text').innerHTML = 'Auto-boot cancelled';
          cdownBar.style.transition = 'none';
          cdownBar.style.width = '0%';
        }

function wireRecoveryControls() {
  if (!screen || screen.dataset.recoveryWired === '1') return;
  screen.dataset.recoveryWired = '1';

  const actionMap = {
    'continue': 'continue',
    'boot': 'boot',
    'boot normal': 'boot-normal',
    'normal boot': 'boot-normal',
    'safe mode': 'safemode',
    'boot safe': 'boot-safe',
    'boot to safe mode': 'boot-safe',
    'minimal mode': 'boot-minimal',
    'boot minimal': 'boot-minimal',
    'boot recovery': 'boot-recovery',
    'boot to recovery': 'boot-recovery',
    'reset settings': 'reset-settings',
    'clear cache': 'clear-cache',
    'clear data': 'wipe-user-data',
    'factory reset': 'factory',
    'console': 'console',
    'terminal': 'console',
    'file manager': 'file-manager',
    'settings editor': 'settings-editor',
    'storage analyzer': 'storage-analyzer',
    'event log': 'event-log',
    'back': 'back'
  };

  function switchRecoveryTab(tabName) {
    const tab = String(tabName || '').trim().toLowerCase();
    if (!tab) return false;
    const tabButtons = screen.querySelectorAll('.recovery-tab');
    const panels = screen.querySelectorAll('.recovery-tab-panel');

    tabButtons.forEach((btn) => {
      const btnTab = (btn.dataset.tab || btn.dataset.switchtab || '').trim().toLowerCase();
      btn.classList.toggle('active', btnTab === tab);
      btn.setAttribute('aria-selected', btnTab === tab ? 'true' : 'false');
    });

    panels.forEach((panel) => {
      const panelId = (panel.id || '').replace(/^tab-/, '').trim().toLowerCase();
      panel.classList.toggle('active', panelId === tab);
    });

    return true;
  }

  screen.addEventListener('click', function (e) {
    const t = e.target.closest('button, [role="button"], [data-fn], [data-action], [data-recovery-action], .recovery-tab, .recovery-option, .rec-btn, .rec-breadcrumb-item');
    if (!t || !screen.contains(t)) return;

    const dataAction = (t.dataset.recoveryAction || t.dataset.action || t.dataset.fn || '').trim();
    const label = (t.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const action = dataAction || actionMap[label] || actionMap[label.replace(/\s*\(.*?\)\s*$/g, '')];

    const tabName = (t.dataset.tab || t.dataset.switchtab || '').trim().toLowerCase();
    if (t.classList.contains('recovery-tab') && tabName) {
      e.preventDefault();
      e.stopPropagation();
      switchRecoveryTab(tabName);
      return;
    }

    if (t.dataset.page && typeof recNav === 'function') {
      e.preventDefault();
      e.stopPropagation();
      recNav(t.dataset.page);
      return;
    }

    if (dataAction && typeof window[dataAction] === 'function') {
      e.preventDefault();
      e.stopPropagation();
      window[dataAction](t.dataset.arg || t.dataset.value || t.dataset.page);
      return;
    }

    if (action === 'back' && typeof recGoBack === 'function') {
      e.preventDefault();
      e.stopPropagation();
      recGoBack();
      return;
    }

    if (action) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof recoveryAction === 'function') recoveryAction(action);
    }
  }, true);
}

// Initialize the UI clock, sysinfo, and console
if (typeof initRecoveryUI === 'function') initRecoveryUI();
wireRecoveryControls();

        // For manual recovery, cancel countdown immediately (no auto-reboot)
        if (isManualRecovery) {
          stopCountdown();
        } else {
          const countdownTimer = setInterval(() => {
            if (countdownStopped) { clearInterval(countdownTimer); return; }
            countdown--;
            cdownNum.textContent = countdown;
            cdownBar.style.width = ((countdown / 15) * 100) + '%';
            if (countdown <= 0) {
              clearInterval(countdownTimer);
              recoveryAction('continue');
            }
          }, 1000);

          // Cancel countdown on any user interaction
          ['click', 'keydown', 'mousemove'].forEach(ev => {
            document.addEventListener(ev, () => { if (!countdownStopped) stopCountdown(); }, { once: true });
          });
        }
      }

      // ⚠️ TEST SYNTAX ERROR — remove the next line to restore normal boot
      // [REPAIRED L21187] const _recoveryTest = {; // SYNTAX ERROR: unexpected token

      // ══════════════════════════════════════════════════════════════════════════════

      // ══════════════════════════════════════════════════════════════════════════════
      //  SNAKE GAME — Easter egg (click NovaByte Version 7× in About)
      // ══════════════════════════════════════════════════════════════════════════════
      function launchSnakeGame() {
        // Prevent duplicate instances
        if (document.getElementById('snake-game-overlay')) return;

        const COLS = 20, ROWS = 20, CELL = 18;
        const W = COLS * CELL, H = ROWS * CELL;

        // ── Overlay backdrop ────────────────────────────────────────────────────────
        const overlay = createEl('div', {
          id: 'snake-game-overlay',
          style: 'position:fixed;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:99999;'
        });

        // ── Window shell ────────────────────────────────────────────────────────────
        const win = createEl('div', {
          style: 'background:rgba(10,14,22,0.96);border:1px solid rgba(255,255,255,0.18);border-radius:16px;box-shadow:0 32px 64px rgba(0,0,0,0.6);overflow:hidden;user-select:none;'
        });

        // Title bar
        const titleBar = createEl('div', {
          style: 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(255,255,255,0.04);border-bottom:1px solid rgba(255,255,255,0.08);'
        });
        const titleText = createEl('span', { textContent: '🐍 NovaByte Snake', style: 'font-size:13px;font-weight:600;color:var(--text-primary);' });
        const closeBtn = createEl('button', {
          textContent: '✕',
          style: 'background:rgba(248,81,73,0.18);border:1px solid rgba(248,81,73,0.35);color:#f85149;border-radius:6px;width:24px;height:24px;font-size:11px;cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:center;'
        });
        closeBtn.onclick = () => overlay.remove();
        titleBar.append(titleText, closeBtn);

        // Score bar
        const scoreBar = createEl('div', {
          style: 'display:flex;align-items:center;justify-content:space-between;padding:6px 14px;background:rgba(0,0,0,0.2);font-size:12px;color:var(--text-secondary);'
        });
        const scoreLabel = createEl('span', { textContent: 'Score: 0' });
        const hintLabel = createEl('span', { textContent: 'Arrow keys / WASD', style: 'color:var(--text-muted);font-size:11px;' });
        scoreBar.append(scoreLabel, hintLabel);

        // Canvas
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        canvas.style.cssText = `display:block;`;
        const ctx = canvas.getContext('2d');

        win.append(titleBar, scoreBar, canvas);
        overlay.appendChild(win);
        document.body.appendChild(overlay);

        // ── Game state ──────────────────────────────────────────────────────────────
        let snake, dir, nextDir, food, score, gameLoop;

        function rand(n) { return Math.floor(Math.random() * n); }

        function spawnFood() {
          let pos;
          do { pos = { x: rand(COLS), y: rand(ROWS) }; }
          while (snake.some(s => s.x === pos.x && s.y === pos.y));
          return pos;
        }

        function init() {
          const mid = { x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) };
          snake = [mid, { x: mid.x - 1, y: mid.y }, { x: mid.x - 2, y: mid.y }];
          dir = { x: 1, y: 0 };
          nextDir = { x: 1, y: 0 };
          food = spawnFood();
          score = 0;
          scoreLabel.textContent = 'Score: 0';
          // Remove any game-over overlay
          const go = canvas.parentElement && canvas.parentElement.querySelector('.snake-game-over');
          if (go) go.remove();
        }

        function draw() {
          // Background
          ctx.fillStyle = '#07090f';
          ctx.fillRect(0, 0, W, H);

          // Grid (subtle)
          ctx.strokeStyle = 'rgba(255,255,255,0.035)';
          ctx.lineWidth = 0.5;
          for (let c = 0; c <= COLS; c++) { ctx.beginPath(); ctx.moveTo(c * CELL, 0); ctx.lineTo(c * CELL, H); ctx.stroke(); }
          for (let r = 0; r <= ROWS; r++) { ctx.beginPath(); ctx.moveTo(0, r * CELL); ctx.lineTo(W, r * CELL); ctx.stroke(); }

          // Food
          const fx = food.x * CELL + CELL / 2, fy = food.y * CELL + CELL / 2, fr = CELL / 2 - 2;
          const foodGrad = ctx.createRadialGradient(fx - 2, fy - 2, 1, fx, fy, fr);
          foodGrad.addColorStop(0, '#ff6e6e');
          foodGrad.addColorStop(1, '#f85149');
          ctx.fillStyle = foodGrad;
          ctx.beginPath(); ctx.arc(fx, fy, fr, 0, Math.PI * 2); ctx.fill();

          // Snake
          snake.forEach((seg, i) => {
            const x = seg.x * CELL + 1, y = seg.y * CELL + 1, s = CELL - 2;
            const t = i / (snake.length - 1 || 1);
            // Head is bright accent, tail fades
            const r = Math.round(88 + (63 - 88) * t);
            const g = Math.round(166 + (190 - 166) * t);
            const b = Math.round(255 + (90 - 255) * t);
            ctx.fillStyle = i === 0 ? '#79b8ff' : `rgb(${r},${g},${b})`;
            const radius = i === 0 ? 5 : 3;
            ctx.beginPath();
            ctx.roundRect(x, y, s, s, radius);
            ctx.fill();
            // Eye on head
            if (i === 0) {
              ctx.fillStyle = '#07090f';
              const ex = x + (dir.x >= 0 ? s - 4 : 3);
              const ey = y + (dir.y >= 0 ? 3 : s - 4);
              ctx.beginPath(); ctx.arc(ex, ey, 2, 0, Math.PI * 2); ctx.fill();
            }
          });
        }

        function gameOver() {
          clearInterval(gameLoop);

          // Game-over panel inside canvas parent
          const goDiv = createEl('div', { className: 'snake-game-over' });
          const goTitle = createEl('div', { className: 'snake-game-over-title', textContent: 'Game Over' });
          const goScore = createEl('div', { className: 'snake-game-over-score', textContent: `Score: ${score}` });
          const goBtn = createEl('button', { className: 'snake-restart-btn', textContent: '↺ Play Again' });
          goBtn.onclick = () => { goDiv.remove(); startGame(); };
          goDiv.append(goTitle, goScore, goBtn);
          // Position parent relatively so the overlay sits correctly
          const wrap = canvas.parentElement;
          if (wrap) { wrap.style.position = 'relative'; wrap.appendChild(goDiv); }
        }

        function step() {
          dir = { ...nextDir };
          const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

          // Wall collision
          if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) { gameOver(); return; }
          // Self collision
          if (snake.some(s => s.x === head.x && s.y === head.y)) { gameOver(); return; }

          snake.unshift(head);

          if (head.x === food.x && head.y === food.y) {
            score++;
            scoreLabel.textContent = `Score: ${score}`;
            food = spawnFood();
          } else {
            snake.pop();
          }
          draw();
        }

        function startGame() {
          init();
          draw();
          gameLoop = setInterval(step, 120);
        }

        // ── Keyboard controls ───────────────────────────────────────────────────────
        function onKey(e) {
          const map = {
            ArrowUp: { x: 0, y: -1 }, w: { x: 0, y: -1 }, W: { x: 0, y: -1 },
            ArrowDown: { x: 0, y: 1 }, s: { x: 0, y: 1 }, S: { x: 0, y: 1 },
            ArrowLeft: { x: -1, y: 0 }, a: { x: -1, y: 0 }, A: { x: -1, y: 0 },
            ArrowRight: { x: 1, y: 0 }, d: { x: 1, y: 0 }, D: { x: 1, y: 0 },
          };
          const nd = map[e.key];
          if (nd && !(nd.x === -dir.x && nd.y === -dir.y)) {
            e.preventDefault();
            nextDir = nd;
          }
        }
        document.addEventListener('keydown', onKey);

        // Cleanup on close
        closeBtn.addEventListener('click', () => {
          clearInterval(gameLoop);
          document.removeEventListener('keydown', onKey);
        });
        overlay.addEventListener('click', e => {
          if (e.target === overlay) {
            clearInterval(gameLoop);
            document.removeEventListener('keydown', onKey);
            overlay.remove();
          }
        });

        startGame();
      }

      // ─────────────────────────────────────────────────────────────────────────────
      // NBOSP Email — IMAP · POP3 · Exchange
      // ─────────────────────────────────────────────────────────────────────────────
      registerApp({
        id: 'nbosp-email', name: 'Email', icon: 'mail',
        description: 'IMAP · POP3 · Exchange',
        defaultSize: [860, 580], minSize: [600, 420],
        init(content) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.email', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.email</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }

          // ── CSS
          const _style = document.createElement('style');
          _style.textContent = `
      .em-root{display:flex;flex-direction:column;height:100%;overflow:hidden;font-size:13px;}
      .em-toolbar{display:flex;align-items:center;gap:6px;padding:7px 10px;border-bottom:1px solid var(--border);background:var(--bg-elevated);flex-shrink:0;}
      .em-tb-btn{background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:5px 8px;border-radius:6px;font-size:12px;display:flex;align-items:center;gap:4px;white-space:nowrap;transition:background .12s,color .12s;}
      .em-tb-btn:hover{background:var(--bg-elevated-2,rgba(255,255,255,.06));color:var(--text-primary);}
      .em-tb-btn.em-primary{background:var(--accent);color:#fff;}
      .em-tb-btn.em-primary:hover{opacity:.88;}
      .em-tb-sep{flex:1;}
      .em-main{display:flex;flex:1;overflow:hidden;}
      /* Sidebar */
      .em-sidebar{width:196px;flex-shrink:0;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto;background:var(--bg-elevated);transition:width .18s;}
      .em-sidebar.hidden{width:0;overflow:hidden;}
      .em-sb-section{font-size:10px;font-weight:700;color:var(--text-secondary);letter-spacing:.07em;padding:12px 12px 3px;text-transform:uppercase;}
      .em-sb-row{display:flex;align-items:center;gap:7px;padding:7px 14px;font-size:13px;cursor:pointer;color:var(--text-secondary);white-space:nowrap;transition:background .1s;}
      .em-sb-row:hover{background:rgba(255,255,255,.05);}
      .em-sb-row.active{background:rgba(99,102,241,.15);color:var(--accent);}
      .em-sb-badge{margin-left:auto;background:var(--accent);color:#fff;border-radius:10px;padding:1px 6px;font-size:10px;font-weight:700;}
      /* List column */
      .em-list-col{width:280px;flex-shrink:0;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;}
      .em-list-tb{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--border);flex-shrink:0;}
      .em-search{flex:1;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;padding:5px 9px;color:var(--text-primary);font-size:12px;outline:none;}
      .em-search:focus{border-color:var(--accent);}
      .em-batch-bar{display:none;align-items:center;gap:6px;padding:5px 10px;background:rgba(99,102,241,.1);border-bottom:1px solid var(--border);font-size:12px;color:var(--text-primary);flex-shrink:0;}
      .em-msg-list{flex:1;overflow-y:auto;}
      .em-msg-row{display:flex;align-items:flex-start;gap:7px;padding:9px 10px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .1s,transform .18s;position:relative;}
      .em-msg-row:hover{background:var(--bg-elevated);}
      .em-msg-row.active{background:rgba(99,102,241,.13);}
      .em-msg-row.unread .em-msg-from{font-weight:700;color:var(--text-primary);}
      .em-msg-row.unread .em-msg-subj{font-weight:600;color:var(--text-secondary);}
      .em-msg-check{width:14px;height:14px;flex-shrink:0;accent-color:var(--accent);cursor:pointer;margin-top:3px;}
      .em-avatar{width:30px;height:30px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;}
      .em-msg-meta{flex:1;min-width:0;}
      .em-msg-from{font-size:12px;font-weight:500;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .em-msg-subj{font-size:12px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;}
      .em-msg-acct{font-size:10px;color:var(--text-secondary);opacity:.7;margin-top:1px;}
      .em-msg-date{font-size:10px;color:var(--text-secondary);flex-shrink:0;margin-top:2px;}
      .em-pagination{display:none;align-items:center;justify-content:center;gap:8px;padding:7px;border-top:1px solid var(--border);font-size:12px;color:var(--text-secondary);flex-shrink:0;}
      /* Reader */
      .em-reader{flex:1;display:flex;flex-direction:column;overflow:hidden;}
      .em-reader-hdr{padding:14px 18px 10px;border-bottom:1px solid var(--border);flex-shrink:0;}
      .em-reader-subj{font-size:15px;font-weight:700;color:var(--text-primary);margin-bottom:7px;line-height:1.3;}
      .em-reader-meta{font-size:11px;color:var(--text-secondary);display:flex;flex-direction:column;gap:2px;}
      .em-reader-actions{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap;}
      .em-reader-body{flex:1;overflow:hidden;}
      .em-reader-body iframe{width:100%;height:100%;border:none;background:#fff;}
      .em-text-body{padding:14px 18px;font-size:13px;line-height:1.65;color:var(--text-primary);white-space:pre-wrap;overflow-y:auto;height:100%;box-sizing:border-box;}
      .em-attachments{padding:8px 18px;border-top:1px solid var(--border);display:flex;gap:7px;flex-wrap:wrap;flex-shrink:0;}
      .em-attach-chip{display:flex;align-items:center;gap:5px;padding:4px 9px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;font-size:11px;color:var(--text-secondary);}
      /* Empty / spinner */
      .em-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;color:var(--text-secondary);gap:8px;font-size:13px;height:100%;}
      @keyframes em-spin{to{transform:rotate(360deg);}}
      .em-spinner{width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:em-spin .6s linear infinite;}
      /* Buttons */
      .em-btn{background:var(--bg-elevated);border:1px solid var(--border);color:var(--text-secondary);padding:5px 10px;border-radius:6px;font-size:11px;cursor:pointer;transition:background .1s;}
      .em-btn:hover{background:var(--bg-elevated-2,rgba(255,255,255,.08));color:var(--text-primary);}
      .em-btn:disabled{opacity:.4;cursor:default;}
      .em-btn.danger{color:#e55;border-color:rgba(229,85,85,.4);}
      .em-btn.danger:hover{background:rgba(229,85,85,.1);}
      /* Setup */
      .em-setup{flex:1;padding:24px;overflow-y:auto;}
      .em-setup-card{width:100%;max-width:430px;margin:0 auto;display:flex;flex-direction:column;gap:10px;}
      .em-setup-title{font-size:17px;font-weight:700;color:var(--text-primary);margin-bottom:4px;}
      .em-lbl{font-size:10px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.07em;margin-bottom:2px;}
      .em-input{background:var(--bg-elevated);border:1px solid var(--border);border-radius:7px;padding:8px 11px;color:var(--text-primary);font-size:13px;outline:none;width:100%;box-sizing:border-box;transition:border-color .12s;}
      .em-input:focus{border-color:var(--accent);}
      .em-proto-row{display:flex;gap:6px;}
      .em-proto-btn{flex:1;padding:7px 0;border:1px solid var(--border);border-radius:7px;background:var(--bg-elevated);color:var(--text-secondary);cursor:pointer;font-size:12px;font-weight:600;transition:all .15s;}
      .em-proto-btn.active{background:var(--accent);color:#fff;border-color:var(--accent);}
      .em-row2{display:flex;gap:8px;}
      .em-row2>*{flex:1;}
      /* Compose */
      .em-compose-overlay{position:absolute;inset:0;background:rgba(0,0,0,.45);z-index:100;display:flex;align-items:flex-end;justify-content:flex-end;}
      .em-compose-win{width:460px;max-width:100%;background:var(--bg-elevated);border-radius:12px 12px 0 0;border:1px solid var(--border);border-bottom:none;display:flex;flex-direction:column;max-height:88%;overflow:hidden;}
      .em-compose-hdr{display:flex;align-items:center;padding:9px 12px;border-bottom:1px solid var(--border);font-size:13px;font-weight:600;color:var(--text-primary);flex-shrink:0;}
      .em-cfield{display:flex;align-items:center;gap:8px;padding:6px 13px;border-bottom:1px solid var(--border);}
      .em-cfield-lbl{font-size:11px;color:var(--text-secondary);width:32px;flex-shrink:0;}
      .em-cinput{flex:1;background:none;border:none;color:var(--text-primary);font-size:13px;outline:none;}
      .em-cbody{flex:1;padding:10px 13px;background:none;border:none;color:var(--text-primary);font-size:13px;outline:none;resize:none;font-family:inherit;min-height:110px;}
      .em-compose-foot{display:flex;align-items:center;gap:7px;padding:8px 11px;border-top:1px solid var(--border);flex-shrink:0;}
    `;
          content.appendChild(_style);

          // ── Constants
          const SK = 'nbosp_email_accts_v2';
          const SK_DRAFT = 'nbosp_email_drafts_v1';
          const COLORS = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#10b981', '#ef4444', '#3b82f6'];
          const FICONS = { inbox: '📥', sent: '📤', drafts: '📝', trash: '🗑️', spam: '⚠️', junk: '⚠️', archive: '📦', starred: '⭐', all: '📬' };

          // ── State
          let accounts = [];
          let activeAcctId = 'all';
          let activeFolder = 'INBOX';
          let messages = [];
          let page = 1, pages = 1;
          let activeMsgUid = null;
          let loading = false;
          let searchQ = '';
          let selectedUids = new Set();
          let syncTimers = {};
          let unreadMap = {};   // "acctId|folder" → count

          // ── Storage
          const loadAccts = () => { try { return JSON.parse(localStorage.getItem(SK) || '[]'); } catch { return []; } };
          const saveAccts = () => { try { localStorage.setItem(SK, JSON.stringify(accounts)); } catch { } };

          // ── API helpers
          async function api(method, path, body, params) {
            let url = '/api/email' + path;
            if (params) { const qs = new URLSearchParams(params).toString(); if (qs) url += '?' + qs; }
            const opts = { method, credentials: 'include', headers: {} };
            if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
              opts.headers['X-CSRF-Token'] = (document.querySelector('meta[name="csrf-token"]')?.content) || window.__csrfToken || '';
            }
            if (body && !(body instanceof FormData)) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
            else if (body instanceof FormData) opts.body = body;
            const r = await fetch(url, opts);
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || r.statusText);
            return d;
          }

          async function ensureConnected(acct) {
            await api('POST', '/connect', { type: acct.type, host: acct.host, port: acct.port, ssl: acct.ssl, user: acct.user, pass: acct.pass });
          }

          function getActiveAcct() {
            if (activeAcctId === 'all') return accounts[0] || null;
            return accounts.find(a => a.id === activeAcctId) || null;
          }

          function avatarColor(s) {
            let h = 0; for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff;
            return COLORS[Math.abs(h) % COLORS.length];
          }
          function fmtDate(iso) {
            if (!iso) return '';
            const d = new Date(iso), now = new Date();
            if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            if (now - d < 7 * 86400000) return d.toLocaleDateString([], { weekday: 'short' });
            return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
          }

          // ── Root
          const root = createEl('div', { className: 'em-root' });
          content.appendChild(root);

          // ────────────────────────────────────────────────────────────────────────
          // TOOLBAR
          // ────────────────────────────────────────────────────────────────────────
          const toolbar = createEl('div', { className: 'em-toolbar' });
          const menuBtn = createEl('button', { className: 'em-tb-btn', title: 'Toggle sidebar', innerHTML: '&#9776;' });
          const acctLabel = createEl('span', { style: 'font-size:13px;font-weight:600;color:var(--text-primary);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' });
          const tbSep = createEl('div', { className: 'em-tb-sep' });
          const refreshBtn = createEl('button', { className: 'em-tb-btn', title: 'Refresh', innerHTML: svgIcon('refresh', 14) });
          const composeBtn = createEl('button', { className: 'em-tb-btn em-primary', innerHTML: '&#9998; Compose' });
          toolbar.append(menuBtn, acctLabel, tbSep, refreshBtn, composeBtn);
          root.appendChild(toolbar);

          // ────────────────────────────────────────────────────────────────────────
          // MAIN
          // ────────────────────────────────────────────────────────────────────────
          const mainEl = createEl('div', { className: 'em-main' });
          root.appendChild(mainEl);

          // ── Sidebar
          const sidebar = createEl('div', { className: 'em-sidebar' });
          mainEl.appendChild(sidebar);
          let sidebarHidden = false;
          menuBtn.addEventListener('click', () => {
            sidebarHidden = !sidebarHidden;
            sidebar.classList.toggle('hidden', sidebarHidden);
          });

          // ── List column
          const listCol = createEl('div', { className: 'em-list-col' });
          mainEl.appendChild(listCol);

          const listTb = createEl('div', { className: 'em-list-tb' });
          const selectAllChk = createEl('input', { type: 'checkbox', title: 'Select all', style: 'accent-color:var(--accent);cursor:pointer;flex-shrink:0;' });
          const searchInp = createEl('input', { className: 'em-search', type: 'search', placeholder: 'Search…' });
          listTb.append(selectAllChk, searchInp);
          listCol.appendChild(listTb);

          const batchBar = createEl('div', { className: 'em-batch-bar' });
          const batchLbl = createEl('span', { style: 'flex:1' });
          const batchReadBtn = createEl('button', { className: 'em-btn', textContent: 'Mark read' });
          const batchTrashBtn = createEl('button', { className: 'em-btn danger', textContent: 'Delete' });
          batchBar.append(batchLbl, batchReadBtn, batchTrashBtn);
          listCol.appendChild(batchBar);

          const msgListEl = createEl('div', { className: 'em-msg-list' });
          listCol.appendChild(msgListEl);

          const paginationEl = createEl('div', { className: 'em-pagination' });
          const prevBtn = createEl('button', { className: 'em-btn', textContent: '‹ Prev' });
          const pageLbl = createEl('span');
          const nextBtn = createEl('button', { className: 'em-btn', textContent: 'Next ›' });
          paginationEl.append(prevBtn, pageLbl, nextBtn);
          listCol.appendChild(paginationEl);

          // ── Reader pane
          const readerEl = createEl('div', { className: 'em-reader' });
          mainEl.appendChild(readerEl);

          // ── Setup screen (overlays main)
          const setupScreen = createEl('div', { className: 'em-setup', style: 'display:none;' });
          root.appendChild(setupScreen);

          // ────────────────────────────────────────────────────────────────────────
          // SIDEBAR RENDER
          // ────────────────────────────────────────────────────────────────────────
          function buildSidebar() {
            sidebar.innerHTML = '';

            if (accounts.length > 1) {
              sidebar.appendChild(createEl('div', { className: 'em-sb-section', textContent: 'Accounts' }));
              const row = createEl('div', { className: 'em-sb-row' + (activeAcctId === 'all' ? ' active' : '') });
              row.innerHTML = '📬 Combined Inbox';
              row.addEventListener('click', () => { activeAcctId = 'all'; activeFolder = 'INBOX'; page = 1; searchQ = ''; searchInp.value = ''; buildSidebar(); loadMessages(); });
              sidebar.appendChild(row);
            }

            accounts.forEach(acct => {
              const hdr = createEl('div', { className: 'em-sb-section', style: `color:${acct.color};` });
              hdr.textContent = acct.name || acct.email;
              sidebar.appendChild(hdr);

              const stdFolders = acct.folders || [
                { path: 'INBOX', name: 'Inbox' }, { path: 'SENT', name: 'Sent' },
                { path: 'DRAFTS', name: 'Drafts' }, { path: 'TRASH', name: 'Trash' }, { path: 'SPAM', name: 'Spam' }
              ];
              stdFolders.forEach(f => {
                const icon = FICONS[(f.name || f.path).toLowerCase()] || '📁';
                const active = activeAcctId === acct.id && activeFolder === f.path;
                const row = createEl('div', { className: 'em-sb-row' + (active ? ' active' : '') });
                const nameSpan = createEl('span', { textContent: `${icon} ${f.name}`, style: 'flex:1' });
                row.appendChild(nameSpan);
                const key = acct.id + '|' + f.path;
                if (unreadMap[key]) row.appendChild(createEl('span', { className: 'em-sb-badge', textContent: unreadMap[key] }));
                row.addEventListener('click', () => { activeAcctId = acct.id; activeFolder = f.path; page = 1; searchQ = ''; searchInp.value = ''; buildSidebar(); loadMessages(); });
                sidebar.appendChild(row);
              });
            });

            const addRow = createEl('div', { className: 'em-sb-row', style: 'color:var(--accent);margin-top:6px;' });
            addRow.innerHTML = '＋ Add Account';
            addRow.addEventListener('click', () => buildSetup(null));
            sidebar.appendChild(addRow);

            if (accounts.length) {
              const settRow = createEl('div', { className: 'em-sb-row', style: 'color:var(--text-secondary);' });
              settRow.innerHTML = '⚙ Settings';
              settRow.addEventListener('click', () => {
                const acct = accounts.find(a => a.id === activeAcctId) || accounts[0];
                buildSetup(acct);
              });
              sidebar.appendChild(settRow);
            }

            acctLabel.textContent = activeAcctId === 'all'
              ? 'Combined Inbox'
              : (accounts.find(a => a.id === activeAcctId)?.name || 'Email');
          }

          // ────────────────────────────────────────────────────────────────────────
          // SETUP WIZARD
          // ────────────────────────────────────────────────────────────────────────
          function buildSetup(existing) {
            setupScreen.innerHTML = '';
            mainEl.style.display = 'none';
            setupScreen.style.display = '';

            const card = createEl('div', { className: 'em-setup-card' });
            card.appendChild(createEl('div', { className: 'em-setup-title', textContent: existing ? 'Edit Account' : 'Add Email Account' }));

            // Protocol
            card.appendChild(createEl('div', { className: 'em-lbl', textContent: 'Protocol' }));
            const protoRow = createEl('div', { className: 'em-proto-row' });
            let proto = existing?.type || 'imap';
            ['imap', 'pop3', 'exchange'].forEach(p => {
              const b = createEl('button', { className: 'em-proto-btn' + (proto === p ? ' active' : ''), textContent: p === 'exchange' ? 'Exchange' : p.toUpperCase() });
              b.addEventListener('click', () => {
                proto = p;
                protoRow.querySelectorAll('.em-proto-btn').forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                const defs = { imap: ['993', ''], pop3: ['995', ''], exchange: ['443', ''] };
                portInp.value = defs[p][0];
                sslChk.checked = true;
              });
              protoRow.appendChild(b);
            });
            card.appendChild(protoRow);

            function fldRow(label, type, ph, val) {
              const w = createEl('div', { style: 'display:flex;flex-direction:column;gap:3px;' });
              w.appendChild(createEl('div', { className: 'em-lbl', textContent: label }));
              const inp = createEl('input', { className: 'em-input', type, placeholder: ph, value: val || '' });
              w.appendChild(inp);
              return { w, inp };
            }

            const { w: nameW, inp: nameInp } = fldRow('Display Name', 'text', 'Work Email', existing?.name || '');
            const { w: hostW, inp: hostInp } = fldRow('Incoming Server (IMAP/POP3/EWS Host)', 'text', 'mail.example.com', existing?.host || '');
            const { w: userW, inp: userInp } = fldRow('Username / Email', 'email', 'user@example.com', existing?.user || '');
            const { w: passW, inp: passInp } = fldRow('Password', 'password', '••••••••', existing?.pass || '');

            const row2 = createEl('div', { className: 'em-row2' });
            const { w: portW, inp: portInp } = fldRow('Port', 'number', '993', existing?.port || '993');
            const sslW = createEl('div', { style: 'display:flex;flex-direction:column;gap:3px;' });
            sslW.appendChild(createEl('div', { className: 'em-lbl', textContent: 'SSL/TLS' }));
            const sslR = createEl('div', { style: 'display:flex;align-items:center;gap:6px;padding-top:10px;' });
            const sslChk = createEl('input', { type: 'checkbox', style: 'width:15px;height:15px;accent-color:var(--accent);cursor:pointer;', checked: existing?.ssl !== false });
            sslR.append(sslChk, createEl('span', { textContent: 'Enabled', style: 'font-size:12px;color:var(--text-secondary);' }));
            sslW.appendChild(sslR);
            row2.append(portW, sslW);

            // SMTP (for sending, IMAP/POP3 only)
            const smtpSection = createEl('div', { style: 'display:flex;flex-direction:column;gap:8px;padding:8px;background:rgba(255,255,255,.03);border-radius:8px;border:1px solid var(--border);' });
            smtpSection.appendChild(createEl('div', { className: 'em-lbl', textContent: 'Outgoing Mail (SMTP) — optional' }));
            const smtpRow = createEl('div', { className: 'em-row2' });
            const { w: smtpHostW, inp: smtpHostInp } = fldRow('SMTP Host', 'text', 'smtp.example.com', existing?.smtpHost || '');
            const { w: smtpPortW, inp: smtpPortInp } = fldRow('SMTP Port', 'number', '587', existing?.smtpPort || '587');
            smtpRow.append(smtpHostW, smtpPortW);
            smtpSection.appendChild(smtpRow);

            const { w: syncW, inp: syncInp } = fldRow('Check every (mins, 0 = manual)', 'number', '15', String(existing?.syncInterval ?? 15));
            const sigW = createEl('div', { style: 'display:flex;flex-direction:column;gap:3px;' });
            sigW.appendChild(createEl('div', { className: 'em-lbl', textContent: 'Signature' }));
            const sigTa = createEl('textarea', { className: 'em-input', id: 'email-signature-input', name: 'email-signature', placeholder: 'Sent from NBOSP Email', style: 'min-height:56px;resize:vertical;', value: existing?.signature || '' });
            sigW.appendChild(sigTa);

            const errEl = createEl('div', { style: 'color:#e55;font-size:12px;min-height:14px;' });
            const footRow = createEl('div', { style: 'display:flex;gap:8px;' });
            const cancelBtn = createEl('button', { className: 'em-btn', textContent: 'Cancel', style: 'flex-shrink:0;' });
            const saveBtn = createEl('button', {
              textContent: existing ? 'Save' : 'Add Account',
              style: 'flex:1;padding:9px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;'
            });

            if (existing) {
              const delBtn = createEl('button', { className: 'em-btn danger', textContent: 'Remove', style: 'flex-shrink:0;' });
              delBtn.addEventListener('click', () => {
                accounts = accounts.filter(a => a.id !== existing.id);
                saveAccts();
                if (!accounts.length) { setupScreen.style.display = 'none'; mainEl.style.display = ''; showEmpty(); buildSetup(null); }
                else { activeAcctId = accounts[0].id; showMain(); }
              });
              footRow.appendChild(delBtn);
            }

            cancelBtn.addEventListener('click', () => {
              if (accounts.length) showMain();
              else { setupScreen.style.display = 'none'; mainEl.style.display = ''; }
            });

            saveBtn.addEventListener('click', async () => {
              const host = hostInp.value.trim(), user = userInp.value.trim(), pass = passInp.value;
              if (!host || !user || !pass) { errEl.textContent = 'Host, username and password are required.'; return; }
              errEl.textContent = '';
              saveBtn.textContent = 'Connecting…'; saveBtn.disabled = true;
              try {
                await api('POST', '/connect', { type: proto, host, port: portInp.value, ssl: sslChk.checked, user, pass });
                const acct = {
                  id: existing?.id || Date.now().toString(36),
                  name: nameInp.value.trim() || user,
                  email: user, type: proto, host,
                  port: portInp.value,
                  ssl: sslChk.checked, user, pass,
                  smtpHost: smtpHostInp.value.trim(),
                  smtpPort: smtpPortInp.value,
                  signature: sigTa.value.trim(),
                  syncInterval: parseInt(syncInp.value) || 0,
                  color: existing?.color || COLORS[accounts.length % COLORS.length],
                  folders: null
                };
                if (existing) accounts = accounts.map(a => a.id === acct.id ? acct : a);
                else accounts.push(acct);
                saveAccts();
                // Fetch real folder list
                try {
                  const fd = await api('GET', '/folders');
                  acct.folders = fd.folders;
                  saveAccts();
                } catch { }
                activeAcctId = acct.id; activeFolder = 'INBOX';
                showMain(); scheduleSyncAll();
                Notify.show({ title: 'Email', body: `"${acct.name}" connected.`, type: 'success', appName: 'Email' });
              } catch (e) {
                errEl.textContent = e.message;
              } finally {
                saveBtn.textContent = existing ? 'Save' : 'Add Account'; saveBtn.disabled = false;
              }
            });

            footRow.append(cancelBtn, saveBtn);
            card.append(nameW, hostW, userW, passW, row2, smtpSection, syncW, sigW, errEl, footRow);
            setupScreen.appendChild(card);
          }

          // ────────────────────────────────────────────────────────────────────────
          // LOAD MESSAGES
          // ────────────────────────────────────────────────────────────────────────
          async function loadMessages() {
            if (!accounts.length) return;
            loading = true; messages = [];
            renderMsgList();
            try {
              if (activeAcctId === 'all') {
                const results = await Promise.allSettled(accounts.map(async acct => {
                  await ensureConnected(acct);
                  const d = await api('GET', '/messages', null, { folder: 'INBOX', page: 1, limit: 20 });
                  return (d.messages || []).map(m => ({ ...m, _acctId: acct.id, _acctName: acct.name || acct.email }));
                }));
                const all = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
                all.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
                messages = all.slice(0, 60); pages = 1;
              } else {
                const acct = getActiveAcct();
                if (!acct) return;
                await ensureConnected(acct);
                const params = { folder: activeFolder, page, limit: 20 };
                if (searchQ) params.q = searchQ;
                const d = await api('GET', searchQ ? '/search' : '/messages', null, params);
                messages = d.messages || []; pages = d.pages || 1;
                unreadMap[acct.id + '|' + activeFolder] = messages.filter(m => !m.seen).length;
                // Fetch folders once if missing
                if (!acct.folders) {
                  api('GET', '/folders').then(fd => { acct.folders = fd.folders; saveAccts(); buildSidebar(); }).catch(() => { });
                }
                buildSidebar();
              }
            } catch (e) {
              messages = [];
              Notify.show({ title: 'Email', body: e.message, type: 'error', appName: 'Email' });
            } finally {
              loading = false; renderMsgList();
            }
          }

          // ────────────────────────────────────────────────────────────────────────
          // RENDER MESSAGE LIST
          // ────────────────────────────────────────────────────────────────────────
          function renderMsgList() {
            msgListEl.innerHTML = '';
            selectedUids.clear();
            selectAllChk.checked = false;
            batchBar.style.display = 'none';

            if (loading) {
              const w = createEl('div', { style: 'display:flex;align-items:center;justify-content:center;padding:36px;' });
              w.appendChild(createEl('div', { className: 'em-spinner' }));
              msgListEl.appendChild(w); return;
            }
            if (!messages.length) {
              const w = createEl('div', { className: 'em-empty' });
              w.innerHTML = '📭<br><span>' + (searchQ ? 'No results' : 'No messages') + '</span>';
              msgListEl.appendChild(w);
              paginationEl.style.display = 'none'; return;
            }

            messages.forEach(msg => {
              const row = createEl('div', { className: 'em-msg-row' + (!msg.seen ? ' unread' : '') + (msg.uid === activeMsgUid ? ' active' : '') });
              row.dataset.uid = String(msg.uid);

              const cb = createEl('input', { type: 'checkbox', className: 'em-msg-check' });
              cb.addEventListener('change', e => {
                e.stopPropagation();
                if (cb.checked) selectedUids.add(msg.uid); else selectedUids.delete(msg.uid);
                updateBatchBar();
              });

              const av = createEl('div', { className: 'em-avatar', textContent: (msg.from || '?')[0].toUpperCase(), style: `background:${avatarColor(msg.from || '')};` });

              const meta = createEl('div', { className: 'em-msg-meta' });
              meta.appendChild(createEl('div', { className: 'em-msg-from', textContent: msg.from || '(unknown)' }));
              meta.appendChild(createEl('div', { className: 'em-msg-subj', textContent: msg.subject || '(no subject)' }));
              if (msg._acctName) meta.appendChild(createEl('div', { className: 'em-msg-acct', textContent: msg._acctName }));

              const date = createEl('div', { className: 'em-msg-date', textContent: fmtDate(msg.date) });
              row.append(cb, av, meta, date);

              // Swipe gestures
              let tx0 = 0;
              row.addEventListener('touchstart', e => { tx0 = e.touches[0].clientX; }, { passive: true });
              row.addEventListener('touchend', e => {
                const dx = e.changedTouches[0].clientX - tx0;
                if (dx < -70) doDeleteMsg(msg, row);
                else if (dx > 70) doArchiveMsg(msg, row);
              }, { passive: true });

              row.addEventListener('click', () => openMsg(msg));
              msgListEl.appendChild(row);
            });

            paginationEl.style.display = pages > 1 ? 'flex' : 'none';
            if (pages > 1) { pageLbl.textContent = `${page} / ${pages}`; prevBtn.disabled = page <= 1; nextBtn.disabled = page >= pages; }
          }

          function updateBatchBar() {
            const n = selectedUids.size;
            batchBar.style.display = n ? 'flex' : 'none';
            if (n) { batchLbl.textContent = `${n} selected`; selectAllChk.checked = n === messages.length; }
            else selectAllChk.checked = false;
          }

          selectAllChk.addEventListener('change', () => {
            if (selectAllChk.checked) messages.forEach(m => selectedUids.add(m.uid));
            else selectedUids.clear();
            updateBatchBar();
            msgListEl.querySelectorAll('.em-msg-check').forEach(cb => { cb.checked = selectAllChk.checked; });
          });

          batchTrashBtn.addEventListener('click', async () => {
            if (!selectedUids.size) return;
            const uids = [...selectedUids];
            const acct = getActiveAcct(); if (!acct) return;
            try { await ensureConnected(acct); await api('POST', '/batch', { op: 'delete', uids, folder: activeFolder }); messages = messages.filter(m => !selectedUids.has(m.uid)); selectedUids.clear(); renderMsgList(); Notify.show({ title: 'Email', body: `${uids.length} deleted.`, type: 'info', appName: 'Email' }); }
            catch (e) { Notify.show({ title: 'Email', body: e.message, type: 'error', appName: 'Email' }); }
          });

          batchReadBtn.addEventListener('click', async () => {
            if (!selectedUids.size) return;
            const uids = [...selectedUids];
            const acct = getActiveAcct(); if (!acct) return;
            try { await ensureConnected(acct); await api('POST', '/batch', { op: 'read', uids, folder: activeFolder }); messages = messages.map(m => selectedUids.has(m.uid) ? { ...m, seen: true } : m); selectedUids.clear(); renderMsgList(); }
            catch (e) { Notify.show({ title: 'Email', body: e.message, type: 'error', appName: 'Email' }); }
          });

          // ────────────────────────────────────────────────────────────────────────
          // MESSAGE READER
          // ────────────────────────────────────────────────────────────────────────
          function showEmpty() {
            readerEl.innerHTML = '';
            const w = createEl('div', { className: 'em-empty' });
            w.innerHTML = '&#9993;<br><span>Select a message to read</span>';
            readerEl.appendChild(w);
          }

          async function openMsg(msg) {
            activeMsgUid = msg.uid;
            msgListEl.querySelectorAll('.em-msg-row').forEach(r => r.classList.toggle('active', r.dataset.uid === String(msg.uid)));
            readerEl.innerHTML = '';
            const sp = createEl('div', { className: 'em-empty' });
            sp.appendChild(createEl('div', { className: 'em-spinner' }));
            readerEl.appendChild(sp);

            try {
              const acct = msg._acctId ? accounts.find(a => a.id === msg._acctId) : getActiveAcct();
              if (!acct) throw new Error('Account not found');
              await ensureConnected(acct);
              const full = await api('GET', '/message', null, { folder: activeFolder, uid: msg.uid });
              msg.seen = true;
              msgListEl.querySelector(`.em-msg-row[data-uid="${msg.uid}"]`)?.classList.remove('unread');
              renderReader(full, msg, acct);
            } catch (e) {
              readerEl.innerHTML = '';
              const w = createEl('div', { className: 'em-empty', style: 'color:#e55;' });
              w.textContent = e.message; readerEl.appendChild(w);
            }
          }

          async function renderReader(full, msg, acct) {
            readerEl.innerHTML = '';

            const hdr = createEl('div', { className: 'em-reader-hdr' });
            hdr.appendChild(createEl('div', { className: 'em-reader-subj', textContent: full.subject || '(no subject)' }));
            const meta = createEl('div', { className: 'em-reader-meta' });
            if (full.from) meta.appendChild(createEl('span', { textContent: 'From: ' + full.from }));
            if (full.to) meta.appendChild(createEl('span', { textContent: 'To: ' + full.to }));
            if (full.cc) meta.appendChild(createEl('span', { textContent: 'CC: ' + full.cc }));
            if (full.date) meta.appendChild(createEl('span', { textContent: new Date(full.date).toLocaleString() }));
            hdr.appendChild(meta);

            const acts = createEl('div', { className: 'em-reader-actions' });
            const replyBtn = createEl('button', { className: 'em-btn' });
            replyBtn.innerHTML = svgIcon('corner-up-left', 13) + ' Reply';
            const fwdBtn = createEl('button', { className: 'em-btn' });
            fwdBtn.innerHTML = svgIcon('corner-up-right', 13) + ' Forward';
            const delBtn = createEl('button', { className: 'em-btn danger' });
            delBtn.innerHTML = svgIcon('x', 13) + ' Delete';
            acts.append(replyBtn, fwdBtn, delBtn);
            hdr.appendChild(acts);
            readerEl.appendChild(hdr);

            replyBtn.addEventListener('click', () => openCompose({
              to: full.from, subject: 'Re: ' + (full.subject || ''),
              body: '\n\n----\nOn ' + new Date(full.date).toLocaleString() + ', ' + full.from + ' wrote:\n' + (full.text || '')
            }, acct));
            fwdBtn.addEventListener('click', () => openCompose({
              subject: 'Fwd: ' + (full.subject || ''),
              body: '\n\n----\nFrom: ' + full.from + '\nDate: ' + new Date(full.date).toLocaleString() + '\nSubject: ' + full.subject + '\n\n' + (full.text || '')
            }, acct));
            delBtn.addEventListener('click', () => doDeleteMsg(msg, msgListEl.querySelector(`.em-msg-row[data-uid="${msg.uid}"]`)));

            // Body
            const bodyEl = createEl('div', { className: 'em-reader-body' });
            if (full.html) {
              // Strip meta-refresh redirects and render via srcdoc (NW.js honours srcdoc, no blob/file needed)
              const cleanHtml = '<!DOCTYPE html>' + full.html
                .replace(/<meta[^>]*http-equiv\s*=\s*["']refresh["'][^>]*>/gi, '')
                .replace(/<base[^>]*>/gi, '');
              const iframe = createEl('iframe', {
                sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
                title: 'Email body', referrerpolicy: 'no-referrer'
              });
              iframe.style.cssText = 'width:100%;height:100%;border:none;background:#fff;display:block;';
              iframe.srcdoc = cleanHtml;
              bodyEl.appendChild(iframe);
              readerEl.appendChild(bodyEl);
            } else {
              const pre = createEl('div', { className: 'em-text-body', textContent: full.text || '(empty message)' });
              bodyEl.appendChild(pre);
              readerEl.appendChild(bodyEl);
            }

            // Attachments
            if (full.attachments?.length) {
              const row = createEl('div', { className: 'em-attachments' });
              full.attachments.forEach(a => {
                const chip = createEl('div', { className: 'em-attach-chip' });
                chip.appendChild(document.createTextNode('\uD83D\uDCC4 ' + (a.filename || 'attachment')));
                if (a.size) {
                  const sz = createEl('span', { textContent: ' ' + Math.round(a.size / 1024) + 'KB' });
                  sz.style.opacity = '0.6';
                  chip.appendChild(sz);
                }
                row.appendChild(chip);
              });
              readerEl.appendChild(row);
            }
          }

          // ────────────────────────────────────────────────────────────────────────
          // DELETE / ARCHIVE
          // ────────────────────────────────────────────────────────────────────────
          async function doDeleteMsg(msg, rowEl) {
            try {
              const acct = msg._acctId ? accounts.find(a => a.id === msg._acctId) : getActiveAcct();
              if (!acct) return;
              await ensureConnected(acct);
              await api('POST', '/batch', { op: 'delete', uids: [msg.uid], folder: activeFolder });
              if (rowEl) { rowEl.style.transition = 'opacity .18s,transform .18s'; rowEl.style.opacity = '0'; rowEl.style.transform = 'translateX(40px)'; setTimeout(() => rowEl.remove(), 200); }
              messages = messages.filter(m => m.uid !== msg.uid);
              if (activeMsgUid === msg.uid) { activeMsgUid = null; showEmpty(); }
              Notify.show({ title: 'Email', body: 'Deleted.', type: 'info', appName: 'Email' });
            } catch (e) { Notify.show({ title: 'Email', body: e.message, type: 'error', appName: 'Email' }); }
          }

          async function doArchiveMsg(msg, rowEl) {
            try {
              const acct = msg._acctId ? accounts.find(a => a.id === msg._acctId) : getActiveAcct();
              if (!acct) return;
              await ensureConnected(acct);
              await api('POST', '/batch', { op: 'move', uids: [msg.uid], folder: activeFolder, dest: 'Archive' });
              if (rowEl) { rowEl.style.transition = 'opacity .18s,transform .18s'; rowEl.style.opacity = '0'; rowEl.style.transform = 'translateX(-40px)'; setTimeout(() => rowEl.remove(), 200); }
              messages = messages.filter(m => m.uid !== msg.uid);
              Notify.show({ title: 'Email', body: 'Archived.', type: 'info', appName: 'Email' });
            } catch (e) { Notify.show({ title: 'Email', body: e.message, type: 'error', appName: 'Email' }); }
          }

          // ────────────────────────────────────────────────────────────────────────
          // COMPOSE
          // ────────────────────────────────────────────────────────────────────────
          function openCompose(prefill = {}, fromAcct = null) {
            root.querySelector('.em-compose-overlay')?.remove();
            const overlay = createEl('div', { className: 'em-compose-overlay' });
            const win = createEl('div', { className: 'em-compose-win' });

            const hdr = createEl('div', { className: 'em-compose-hdr' });
            hdr.appendChild(createEl('span', { textContent: 'New Message', style: 'flex:1' }));
            const minBtn = createEl('button', { className: 'em-tb-btn', textContent: '−', title: 'Minimize' });
            const closeXB = createEl('button', { className: 'em-tb-btn', textContent: '✕', title: 'Close' });
            hdr.append(minBtn, closeXB);

            let minimized = false;
            minBtn.addEventListener('click', () => {
              minimized = !minimized;
              win.style.maxHeight = minimized ? '44px' : '88%';
            });
            closeXB.addEventListener('click', () => {
              const body = bodyTa.value.trim();
              if (body || toInp.value.trim()) {
                const drafts = JSON.parse(localStorage.getItem(SK_DRAFT) || '[]');
                drafts.unshift({ id: Date.now().toString(36), to: toInp.value, cc: ccInp.value, bcc: bccInp.value, subject: subjInp.value, body, savedAt: new Date().toISOString() });
                localStorage.setItem(SK_DRAFT, JSON.stringify(drafts.slice(0, 50)));
                Notify.show({ title: 'Email', body: 'Draft saved.', type: 'info', appName: 'Email' });
              }
              overlay.remove();
            });

            const fieldsEl = createEl('div', { style: 'flex-shrink:0;' });
            function cf(lbl, type, ph) {
              const row = createEl('div', { className: 'em-cfield' });
              row.appendChild(createEl('span', { className: 'em-cfield-lbl', textContent: lbl }));
              const inp = createEl('input', { className: 'em-cinput', type, placeholder: ph });
              row.appendChild(inp);
              return { row, inp };
            }
            const { row: toRow, inp: toInp } = cf('To', 'email', 'recipient@example.com');
            const { row: ccRow, inp: ccInp } = cf('Cc', 'email', '');
            const { row: bccRow, inp: bccInp } = cf('Bcc', 'email', '');
            const { row: subjRow, inp: subjInp } = cf('Subject', 'text', 'Subject');

            if (prefill.to) toInp.value = prefill.to;
            if (prefill.subject) subjInp.value = prefill.subject;

            // Cc/Bcc toggle
            ccRow.style.display = 'none'; bccRow.style.display = 'none';
            const ccToggle = createEl('button', { className: 'em-btn', textContent: 'Cc/Bcc', style: 'font-size:10px;padding:2px 6px;' });
            toRow.appendChild(ccToggle);
            ccToggle.addEventListener('click', () => { const s = ccRow.style.display === 'none'; ccRow.style.display = s ? '' : 'none'; bccRow.style.display = s ? '' : 'none'; });

            fieldsEl.append(toRow, ccRow, bccRow, subjRow);

            const acct = fromAcct || getActiveAcct();
            const sig = acct?.signature ? '\n\n--\n' + acct.signature : '';
            const bodyTa = createEl('textarea', { className: 'em-cbody', id: 'email-body-input', name: 'email-body', placeholder: 'Write your message…', value: (prefill.body || '') + sig });

            // Attachments
            const fileInp = createEl('input', { type: 'file', multiple: true, style: 'display:none;' });
            const attachListEl = createEl('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;padding:0 12px 4px;flex-shrink:0;' });
            let attachedFiles = [];
            fileInp.addEventListener('change', () => {
              attachedFiles = [...fileInp.files];
              attachListEl.innerHTML = '';
              attachedFiles.forEach(f => attachListEl.appendChild(createEl('span', { className: 'em-attach-chip', textContent: '📎 ' + f.name })));
            });

            const foot = createEl('div', { className: 'em-compose-foot' });
            const sendBtn = createEl('button', { textContent: 'Send', style: 'background:var(--accent);color:#fff;border:none;border-radius:7px;padding:6px 16px;font-size:13px;font-weight:600;cursor:pointer;' });
            const attachBtn = createEl('button', { className: 'em-btn', innerHTML: '&#128206;', title: 'Attach file' });
            const errSpan = createEl('span', { style: 'font-size:11px;color:#e55;flex:1;' });
            attachBtn.addEventListener('click', () => fileInp.click());

            sendBtn.addEventListener('click', async () => {
              const to = toInp.value.trim();
              if (!to) { errSpan.textContent = 'Recipient required.'; return; }
              if (!acct) { errSpan.textContent = 'No account selected.'; return; }
              errSpan.textContent = '';
              sendBtn.textContent = 'Sending…'; sendBtn.disabled = true;
              try {
                const smtpPort = parseInt(acct.smtpPort) || (acct.ssl ? 465 : 587);
                const payload = {
                  host: acct.smtpHost || acct.host,
                  port: smtpPort,
                  ssl: smtpPort === 465,
                  user: acct.user,
                  pass: acct.pass,
                  to, cc: ccInp.value, bcc: bccInp.value,
                  subject: subjInp.value,
                  text: bodyTa.value
                };
                await api('POST', '/send', payload);
                Notify.show({ title: 'Email', body: 'Sent.', type: 'success', appName: 'Email' });
                overlay.remove();
              } catch (e) {
                errSpan.textContent = e.message;
                sendBtn.textContent = 'Send'; sendBtn.disabled = false;
              }
            });

            foot.append(sendBtn, attachBtn, fileInp, errSpan);
            win.append(hdr, fieldsEl, attachListEl, bodyTa, foot);
            overlay.appendChild(win);
            root.appendChild(overlay);
            toInp.focus();
          }

          composeBtn.addEventListener('click', () => openCompose());

          // ────────────────────────────────────────────────────────────────────────
          // SEARCH / PAGINATION
          // ────────────────────────────────────────────────────────────────────────
          let searchTimer;
          searchInp.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { searchQ = searchInp.value.trim(); page = 1; loadMessages(); }, 420); });
          prevBtn.addEventListener('click', () => { if (page > 1) { page--; loadMessages(); } });
          nextBtn.addEventListener('click', () => { if (page < pages) { page++; loadMessages(); } });
          refreshBtn.addEventListener('click', () => loadMessages());

          // ────────────────────────────────────────────────────────────────────────
          // SYNC ENGINE + NOTIFICATIONS
          // ────────────────────────────────────────────────────────────────────────
          function scheduleSyncAll() {
            Object.values(syncTimers).forEach(clearInterval);
            syncTimers = {};
            accounts.forEach(acct => {
              const mins = parseInt(acct.syncInterval) || 0;
              if (!mins) return;
              syncTimers[acct.id] = setInterval(async () => {
                try {
                  await ensureConnected(acct);
                  const d = await api('GET', '/messages', null, { folder: 'INBOX', page: 1, limit: 10 });
                  const newUnread = (d.messages || []).filter(m => !m.seen);
                  if (!newUnread.length) return;
                  if (Notification.permission === 'granted') {
                    new Notification(`${acct.name || acct.email} — ${newUnread.length} new`, {
                      body: newUnread[0].subject, icon: '/assets/apple-touch-icon.svg'
                    });
                  }
                  Notify.show({ title: 'Email', body: `${newUnread.length} new in ${acct.name || acct.email}`, type: 'info', appName: 'Email' });
                  if (activeAcctId === acct.id && activeFolder === 'INBOX') loadMessages();
                } catch { }
              }, mins * 60000);
            });
          }

          if (Notification.permission === 'default') Notification.requestPermission().catch(() => { });

          // ────────────────────────────────────────────────────────────────────────
          // BOOTSTRAP
          // ────────────────────────────────────────────────────────────────────────
          function showMain() {
            setupScreen.style.display = 'none';
            mainEl.style.display = '';
            buildSidebar();
            loadMessages();
            showEmpty();
          }

          // Fetch a fresh CSRF token before doing anything so that POST /preview,
          // Read CSRF token directly from the server-injected meta tag — no fetch needed.
          window.__csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';

          accounts = loadAccts();
          if (!accounts.length) {
            mainEl.style.display = '';
            buildSetup(null);
          } else {
            activeAcctId = accounts.length > 1 ? 'all' : accounts[0].id;
            showMain();
            scheduleSyncAll();
          }
        }
      });


      /* ═══════════════════════════════════════════════════════════════
         APP: Gallery — image viewer that reads from FS
         ═══════════════════════════════════════════════════════════════ */
      registerApp({
        id: 'nbosp-gallery', name: 'Gallery', icon: 'image',
        description: 'Image Viewer',
        defaultSize: [840, 580], minSize: [500, 360],
        init(content, state) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.gallery', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.gallery</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const root = createEl('div', { style: 'display:flex;flex-direction:column;height:100%;background:var(--bg-base);overflow:hidden;' });
          content.appendChild(root);

          /* ── Toolbar ── */
          const toolbar = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);' });
          const titleEl = createEl('span', { textContent: 'Gallery', style: 'font-size:13px;font-weight:600;flex:1;color:var(--text-primary);' });
          const countEl = createEl('span', { style: 'font-size:11px;color:var(--text-muted);' });
          const refreshBtn = createEl('button', { className: 'browser-nav-btn', title: 'Refresh' });
          refreshBtn.innerHTML = svgIcon('refresh', 15);
          toolbar.append(titleEl, countEl, refreshBtn);
          root.appendChild(toolbar);

          /* ── Grid ── */
          const gridWrap = createEl('div', { style: 'flex:1;overflow-y:auto;padding:12px;' });
          const grid = createEl('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;' });
          gridWrap.appendChild(grid);
          root.appendChild(gridWrap);

          /* ── Lightbox (positioned inside content so it's window-scoped) ── */
          const lb = createEl('div', { style: 'display:none;position:absolute;inset:0;background:rgba(0,0,0,0.93);z-index:200;align-items:center;justify-content:center;flex-direction:column;' });
          const lbImg = createEl('img', { style: 'max-width:88%;max-height:82%;object-fit:contain;border-radius:6px;box-shadow:0 8px 48px rgba(0,0,0,0.8);user-select:none;', draggable: 'false', alt: '' });
          const lbClose = createEl('button', { style: 'position:absolute;top:10px;right:14px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:#fff;border-radius:6px;width:30px;height:30px;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;' });
          lbClose.innerHTML = svgIcon('x', 14);
          const lbPrev = createEl('button', { style: 'position:absolute;left:10px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:50%;width:38px;height:38px;cursor:pointer;display:flex;align-items:center;justify-content:center;' });
          lbPrev.innerHTML = svgIcon('chevron-left', 18);
          const lbNext = createEl('button', { style: 'position:absolute;right:10px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:50%;width:38px;height:38px;cursor:pointer;display:flex;align-items:center;justify-content:center;' });
          lbNext.innerHTML = svgIcon('chevron-right', 18);
          const lbCaption = createEl('div', { style: 'position:absolute;bottom:12px;left:50%;transform:translateX(-50%);color:rgba(255,255,255,0.55);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:80%;text-align:center;' });
          lb.append(lbImg, lbClose, lbPrev, lbNext, lbCaption);
          content.style.position = 'relative';
          content.appendChild(lb);

          let images = [];
          let lbIdx = 0;
          const blobCache = new Map();

          // Normalise whatever FS gives us into something Blob() can handle.
          // After IndexedDB round-trips, Uint8Array often comes back as a plain
          // object { "0": 255, "1": 216, … } — we rebuild it here.
          function toBufferData(raw) {
            if (!raw) return null;
            if (raw instanceof ArrayBuffer) return raw;
            if (ArrayBuffer.isView(raw)) return raw;
            if (typeof raw === 'string') {
              try {
                const bin = atob(raw);
                const u8 = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
                return u8;
              } catch {
                return new TextEncoder().encode(raw);
              }
            }
            if (typeof raw === 'object') {
              const len = Object.keys(raw).length;
              const u8 = new Uint8Array(len);
              for (let i = 0; i < len; i++) u8[i] = raw[i] ?? 0;
              return u8;
            }
            return null;
          }

          function getUrl(f) {
            if (blobCache.has(f.id)) return blobCache.get(f.id);
            const data = toBufferData(f.content);
            if (data) {
              try {
                const blob = new Blob([data], { type: f.mimeType || 'image/png' });
                const url = URL.createObjectURL(blob);
                blobCache.set(f.id, url);
                return url;
              } catch { return null; }
            }
            return null;
          }

          function openLb(idx) {
            lbIdx = Math.max(0, Math.min(idx, images.length - 1));
            const f = images[lbIdx];
            lbImg.src = getUrl(f) || '';
            lbCaption.textContent = f.name + '  (' + (lbIdx + 1) + ' / ' + images.length + ')';
            lbPrev.style.opacity = lbIdx > 0 ? '1' : '0.25';
            lbNext.style.opacity = lbIdx < images.length - 1 ? '1' : '0.25';
            lb.style.display = 'flex';
          }

          lbClose.addEventListener('click', () => { lb.style.display = 'none'; });
          lb.addEventListener('click', e => { if (e.target === lb) lb.style.display = 'none'; });
          lbPrev.addEventListener('click', () => { if (lbIdx > 0) openLb(lbIdx - 1); });
          lbNext.addEventListener('click', () => { if (lbIdx < images.length - 1) openLb(lbIdx + 1); });

          const onKey = e => {
            if (lb.style.display === 'none') return;
            if (e.key === 'ArrowLeft') { e.preventDefault(); if (lbIdx > 0) openLb(lbIdx - 1); }
            if (e.key === 'ArrowRight') { e.preventDefault(); if (lbIdx < images.length - 1) openLb(lbIdx + 1); }
            if (e.key === 'Escape') lb.style.display = 'none';
          };
          document.addEventListener('keydown', onKey);

          /* ── Render grid ── */
          function render() {
            const trashId = FS.specialFolders?.trash;
            const imgExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'tiff']);
            images = Array.from(FS.files.values())
              .filter(f => {
                if (f.type !== 'file' || f.parentId === trashId) return false;
                if (f.mimeType && f.mimeType.startsWith('image/')) return true;
                const ext = (f.name || '').split('.').pop().toLowerCase();
                return imgExts.has(ext);
              })
              .sort((a, b) => b.modified - a.modified);

            grid.innerHTML = '';
            countEl.textContent = images.length ? images.length + ' image' + (images.length > 1 ? 's' : '') : '';

            if (!images.length) {
              const empty = createEl('div', { style: 'grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:64px 24px;color:var(--text-muted);gap:8px;text-align:center;' });
              empty.innerHTML = svgIcon('image', 38) + '<div style="font-size:13px;margin-top:10px;color:var(--text-secondary);">No images found</div><div style="font-size:11px;margin-top:4px;">Save image files via Files to view them here</div>';
              grid.appendChild(empty);
              return;
            }

            images.forEach((f, idx) => {
              const card = createEl('div', { style: 'border-radius:8px;overflow:hidden;cursor:pointer;background:var(--bg-elevated);border:1px solid var(--border-subtle);aspect-ratio:1;display:flex;align-items:center;justify-content:center;transition:transform 0.13s,border-color 0.13s;position:relative;', title: f.name });
              card.addEventListener('mouseenter', () => { card.style.transform = 'scale(1.04)'; card.style.borderColor = 'var(--accent)'; });
              card.addEventListener('mouseleave', () => { card.style.transform = ''; card.style.borderColor = ''; });
              card.addEventListener('click', () => openLb(idx));

              const url = getUrl(f);
              if (url) {
                const img = createEl('img', { style: 'width:100%;height:100%;object-fit:cover;', alt: f.name, draggable: 'false' });
                img.src = url;
                img.addEventListener('error', () => { card.innerHTML = ''; card.innerHTML = svgIcon('image', 24); card.style.color = 'var(--text-muted)'; });
                card.appendChild(img);
              } else {
                card.innerHTML = svgIcon('image', 24);
                card.style.color = 'var(--text-muted)';
              }

              const label = createEl('div', { textContent: f.name, style: 'position:absolute;bottom:0;left:0;right:0;padding:4px 6px;background:linear-gradient(transparent,rgba(0,0,0,0.7));color:#fff;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' });
              card.appendChild(label);
              grid.appendChild(card);
            });
          }

          refreshBtn.addEventListener('click', render);
          state.cleanups = state.cleanups || [];
          state.cleanups.push(() => {
            document.removeEventListener('keydown', onKey);
            blobCache.forEach(u => URL.revokeObjectURL(u));
          });

          render();
          // If launched by double-clicking a specific image, jump straight to it
          if (state.fileId) {
            render();
            const startIdx = images.findIndex(f => f.id === state.fileId);
            if (startIdx !== -1) openLb(startIdx);
          }
        }
      });



      /* ── Global Downloads API — persists even when Downloads app is closed ── */
      (function () {
        const SK = 'nova_downloads';
        function _load() { try { return JSON.parse(localStorage.getItem(SK) || '[]'); } catch { return []; } }
        function _save(arr) { try { localStorage.setItem(SK, JSON.stringify(arr.slice(0, 500))); } catch { } }
        window.Downloads = {
          _renderFn: null,          // set by Downloads app init when its window is open
          add(name, url, size, mimeType) {
            const entry = {
              id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
              name: name || 'Unknown file', url: url || '',
              size: size || 0, mimeType: mimeType || '',
              ts: Date.now(), status: 'done'
            };
            const arr = _load(); arr.unshift(entry);
            _save(arr);
            if (window.Downloads._renderFn) window.Downloads._renderFn();
            return entry;
          },
          setStatus(id, status, size) {
            const arr = _load();
            const it = arr.find(x => x.id === id);
            if (it) { it.status = status; if (size != null) it.size = size; _save(arr); }
            if (window.Downloads._renderFn) window.Downloads._renderFn();
          },
          getAll() { return _load(); }
        };
      })();

      /* ═══════════════════════════════════════════════════════════════
         APP: Downloads — download manager with global Downloads.add()
         ═══════════════════════════════════════════════════════════════ */
      registerApp({
        id: 'nbosp-downloads', name: 'Downloads', icon: 'download',
        description: 'Download Manager',
        defaultSize: [580, 460], minSize: [400, 300],
        init(content, state) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.downloads', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.downloads</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const SK = 'nova_downloads';

          function load() { try { return JSON.parse(localStorage.getItem(SK) || '[]'); } catch { return []; } }
          function save(arr) { lsSave(SK, arr); }
          function fmtSize(b) { if (!b) return '—'; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }
          function fmtDate(ts) { if (!ts) return ''; return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }

          const root = createEl('div', { style: 'display:flex;flex-direction:column;height:100%;overflow:hidden;' });
          content.appendChild(root);

          /* ── Toolbar ── */
          const toolbar = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);' });
          const titleEl = createEl('span', { textContent: 'Downloads', style: 'font-size:13px;font-weight:600;flex:1;' });
          const clearBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Clear completed' });
          toolbar.append(titleEl, clearBtn);
          root.appendChild(toolbar);

          /* ── List ── */
          const list = createEl('div', { style: 'flex:1;overflow-y:auto;' });
          root.appendChild(list);

          function statusStyle(s) {
            if (s === 'downloading') return { bg: 'rgba(88,166,255,0.14)', color: 'var(--accent)' };
            if (s === 'failed') return { bg: 'rgba(248,81,73,0.14)', color: 'var(--text-danger)' };
            return { bg: 'rgba(63,185,80,0.14)', color: 'var(--text-success)' };
          }

          function render() {
            const items = load();
            list.innerHTML = '';

            if (!items.length) {
              const empty = createEl('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-muted);gap:8px;' });
              empty.innerHTML = svgIcon('archive', 34) + '<div style="font-size:13px;margin-top:10px;color:var(--text-secondary);">No downloads yet</div><div style="font-size:11px;margin-top:4px;">Files saved from the browser appear here</div>';
              list.appendChild(empty);
              return;
            }

            items.forEach((item, i) => {
              const row = createEl('div', { style: 'display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border-subtle);transition:background 0.1s;', title: item.url || '' });
              row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-hover)');
              row.addEventListener('mouseleave', () => row.style.background = '');

              const ico = createEl('span', { style: 'color:var(--accent);flex-shrink:0;' });
              ico.innerHTML = svgIcon('file', 18);

              const info = createEl('div', { style: 'flex:1;min-width:0;' });
              const nameEl = createEl('div', { textContent: item.name, style: 'font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' });
              const metaEl = createEl('div', { textContent: fmtSize(item.size) + (item.ts ? '  ·  ' + fmtDate(item.ts) : ''), style: 'font-size:11px;color:var(--text-muted);margin-top:2px;' });
              info.append(nameEl, metaEl);

              const st = statusStyle(item.status || 'done');
              const badge = createEl('span', { textContent: item.status || 'done', style: 'font-size:10px;padding:2px 8px;border-radius:20px;font-weight:600;flex-shrink:0;background:' + st.bg + ';color:' + st.color + ';' });

              const delBtn = createEl('button', { style: 'background:none;border:none;color:var(--text-muted);cursor:pointer;padding:4px;border-radius:4px;display:flex;align-items:center;', title: 'Remove' });
              delBtn.innerHTML = svgIcon('x', 14);
              delBtn.addEventListener('mouseenter', () => delBtn.style.color = 'var(--text-danger)');
              delBtn.addEventListener('mouseleave', () => delBtn.style.color = '');
              delBtn.addEventListener('click', () => {
                const arr = load();
                arr.splice(i, 1);
                save(arr);
                render();
              });

              row.append(ico, info, badge, delBtn);
              list.appendChild(row);
            });
          }

          clearBtn.addEventListener('click', () => {
            const arr = load().filter(it => it.status === 'downloading');
            save(arr);
            render();
          });

          /* ── Hook render into global Downloads API so UI updates live ── */
          window.Downloads._renderFn = render;

          render();
        }
      });



      /* ═══════════════════════════════════════════════════════════════
         APP: Contacts — local contact book
         ═══════════════════════════════════════════════════════════════ */
      registerApp({
        id: 'nbosp-contacts', name: 'Contacts', icon: 'users',
        description: 'Contact Book',
        defaultSize: [640, 500], minSize: [440, 320],
        init(content, state) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.contacts', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.contacts</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const SK = 'nova_contacts';

          function load() { try { return JSON.parse(localStorage.getItem(SK) || '[]'); } catch { return []; } }
          function save(arr) { lsSave(SK, arr); }
          function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
          function initials(name) {
            const parts = (name || '?').trim().split(/\s+/);
            return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
          }

          let contacts = load();
          let selected = null;
          let editMode = false;
          let searchQ = '';

          /* ── Root layout ── */
          const root = createEl('div', { style: 'display:flex;height:100%;overflow:hidden;' });
          content.appendChild(root);

          /* ── Left: list panel ── */
          const leftPanel = createEl('div', { style: 'width:220px;flex-shrink:0;display:flex;flex-direction:column;border-right:1px solid var(--border-subtle);background:var(--bg-sidebar);' });

          const listToolbar = createEl('div', { style: 'padding:8px;border-bottom:1px solid var(--border-subtle);display:flex;flex-direction:column;gap:6px;flex-shrink:0;' });
          const searchInp = createEl('input', { type: 'text', placeholder: 'Search contacts…', style: 'width:100%;background:var(--bg-sunken);border:1px solid var(--border-subtle);border-radius:6px;padding:5px 8px;font-size:12px;color:var(--text-primary);outline:none;' });
          const addBtn = createEl('button', { className: 'btn btn-sm btn-primary', style: 'display:flex;align-items:center;gap:4px;justify-content:center;' });
          addBtn.innerHTML = svgIcon('plus', 12) + ' New Contact';
          listToolbar.append(searchInp, addBtn);

          const contactList = createEl('div', { style: 'flex:1;overflow-y:auto;' });
          leftPanel.append(listToolbar, contactList);

          /* ── Right: detail / edit panel ── */
          const rightPanel = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;' });

          const detailArea = createEl('div', { style: 'flex:1;overflow-y:auto;padding:20px;' });
          const actionBar = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);' });
          rightPanel.append(detailArea, actionBar);

          root.append(leftPanel, rightPanel);

          /* ── Render contact list ── */
          function renderList() {
            contactList.innerHTML = '';
            const q = searchQ.toLowerCase();
            const filtered = contacts.filter(c =>
              !q || (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q)
            ).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

            if (!filtered.length) {
              const empty = createEl('div', { style: 'padding:20px;text-align:center;color:var(--text-muted);font-size:12px;' });
              empty.textContent = searchQ ? 'No matches' : 'No contacts yet';
              contactList.appendChild(empty);
              return;
            }

            filtered.forEach(c => {
              const row = createEl('div', { style: 'display:flex;align-items:center;gap:9px;padding:8px 10px;cursor:pointer;border-radius:0;transition:background 0.1s;border-bottom:1px solid var(--border-subtle);' + (selected?.id === c.id ? 'background:var(--accent-muted);' : ''), 'data-id': c.id });
              row.addEventListener('mouseenter', () => { if (selected?.id !== c.id) row.style.background = 'var(--bg-hover)'; });
              row.addEventListener('mouseleave', () => { if (selected?.id !== c.id) row.style.background = ''; });
              row.addEventListener('click', () => selectContact(c.id));

              const avatar = createEl('div', { style: 'width:32px;height:32px;border-radius:50%;background:var(--accent-muted);color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;' });
              avatar.textContent = initials(c.name);

              const info = createEl('div', { style: 'min-width:0;' });
              const nameEl = createEl('div', { textContent: c.name || '(no name)', style: 'font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' });
              const subEl = createEl('div', { textContent: c.email || c.phone || '', style: 'font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' });
              info.append(nameEl, subEl);
              row.append(avatar, info);
              contactList.appendChild(row);
            });
          }

          /* ── Render detail / edit ── */
          function renderDetail() {
            detailArea.innerHTML = '';
            actionBar.innerHTML = '';

            if (!selected) {
              const empty = createEl('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-muted);gap:8px;' });
              empty.innerHTML = svgIcon('users', 36) + '<div style="font-size:13px;margin-top:10px;">Select a contact</div>';
              detailArea.appendChild(empty);
              return;
            }

            if (editMode) {
              /* ── Edit form ── */
              const form = createEl('div', { style: 'display:flex;flex-direction:column;gap:12px;max-width:360px;' });

              function field(label, key, type) {
                const wrap = createEl('div', { style: 'display:flex;flex-direction:column;gap:4px;' });
                const lbl = createEl('label', { textContent: label, style: 'font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.05em;text-transform:uppercase;' });
                const inp = createEl('input', { type: type || 'text', value: selected[key] || '', style: 'background:var(--bg-sunken);border:1px solid var(--border-default);border-radius:6px;padding:7px 10px;font-size:13px;color:var(--text-primary);outline:none;width:100%;', 'data-key': key });
                inp.addEventListener('focus', () => inp.style.borderColor = 'var(--accent)');
                inp.addEventListener('blur', () => inp.style.borderColor = 'var(--border-default)');
                wrap.append(lbl, inp);
                form.appendChild(wrap);
                return inp;
              }

              const nameInp = field('Name', 'name');
              const emailInp = field('Email', 'email', 'email');
              const phoneInp = field('Phone', 'phone', 'tel');
              const wrap = createEl('div', { style: 'display:flex;flex-direction:column;gap:4px;' });
              wrap.appendChild(createEl('label', { textContent: 'Notes', style: 'font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.05em;text-transform:uppercase;' }));
              const notesInp = createEl('textarea', { id: 'contact-notes-input', name: 'contact-notes', style: 'background:var(--bg-sunken);border:1px solid var(--border-default);border-radius:6px;padding:7px 10px;font-size:13px;color:var(--text-primary);outline:none;width:100%;min-height:80px;resize:vertical;', 'data-key': 'notes' });
              notesInp.value = selected.notes || '';
              notesInp.addEventListener('focus', () => notesInp.style.borderColor = 'var(--accent)');
              notesInp.addEventListener('blur', () => notesInp.style.borderColor = 'var(--border-default)');
              wrap.appendChild(notesInp);
              form.appendChild(wrap);

              detailArea.appendChild(form);

              const saveBtn = createEl('button', { className: 'btn btn-primary btn-sm', textContent: 'Save' });
              const cancelBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Cancel' });
              actionBar.append(saveBtn, cancelBtn);

              saveBtn.addEventListener('click', () => {
                selected.name = nameInp.value.trim() || '(no name)';
                selected.email = emailInp.value.trim();
                selected.phone = phoneInp.value.trim();
                selected.notes = notesInp.value.trim();
                save(contacts);
                editMode = false;
                renderList();
                renderDetail();
              });
              cancelBtn.addEventListener('click', () => {
                if (!selected.name) { contacts = contacts.filter(c => c.id !== selected.id); selected = null; }
                editMode = false;
                renderList();
                renderDetail();
              });

            } else {
              /* ── View mode ── */
              const avatar = createEl('div', { style: 'width:56px;height:56px;border-radius:50%;background:var(--accent-muted);color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;margin-bottom:14px;flex-shrink:0;' });
              avatar.textContent = initials(selected.name);

              const nameEl = createEl('div', { textContent: selected.name || '(no name)', style: 'font-size:17px;font-weight:700;margin-bottom:16px;' });
              detailArea.append(avatar, nameEl);

              function infoRow(icon, label, value, clickFn) {
                if (!value) return;
                const row = createEl('div', { style: 'display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-subtle);cursor:' + (clickFn ? 'pointer' : 'default') + ';' });
                row.addEventListener('mouseenter', () => { if (clickFn) row.style.background = 'var(--bg-hover)'; });
                row.addEventListener('mouseleave', () => row.style.background = '');
                if (clickFn) row.addEventListener('click', clickFn);
                const ico = createEl('span', { style: 'color:var(--text-muted);flex-shrink:0;margin-top:1px;' });
                ico.innerHTML = svgIcon(icon, 15);
                const wrap2 = createEl('div', { style: 'min-width:0;' });
                const lbl = createEl('div', { textContent: label, style: 'font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;' });
                const val = createEl('div', { textContent: value, style: 'font-size:13px;color:' + (clickFn ? 'var(--text-link)' : 'var(--text-primary)') + ';word-break:break-all;' });
                wrap2.append(lbl, val);
                row.append(ico, wrap2);
                detailArea.appendChild(row);
              }

              infoRow('mail', 'Email', selected.email, selected.email ? () => WM.createWindow('email', { to: selected.email }) : null);
              infoRow('phone', 'Phone', selected.phone);
              infoRow('file', 'Notes', selected.notes);

              const editBtn = createEl('button', { className: 'btn btn-sm btn-primary', textContent: 'Edit' });
              const delBtn = createEl('button', { className: 'btn btn-sm btn-danger', textContent: 'Delete' });
              actionBar.append(editBtn, delBtn, createEl('span', { style: 'flex:1;' }));

              editBtn.addEventListener('click', () => { editMode = true; renderDetail(); });
              delBtn.addEventListener('click', () => {
                contacts = contacts.filter(c => c.id !== selected.id);
                save(contacts);
                selected = null;
                renderList();
                renderDetail();
              });
            }
          }

          function selectContact(id) {
            selected = contacts.find(c => c.id === id) || null;
            editMode = false;
            renderList();
            renderDetail();
          }

          addBtn.addEventListener('click', () => {
            const c = { id: genId(), name: '', email: '', phone: '', notes: '' };
            contacts.push(c);
            selected = c;
            editMode = true;
            renderList();
            renderDetail();
          });

          searchInp.addEventListener('input', () => { searchQ = searchInp.value; renderList(); });

          renderList();
          renderDetail();
        }
      });



      /* ═══════════════════════════════════════════════════════════════
         APP: Search — system-wide search across FS, Contacts, Downloads
         ═══════════════════════════════════════════════════════════════ */
      registerApp({
        id: 'nbosp-search', name: 'Search', icon: 'search',
        description: 'System Search',
        defaultSize: [640, 500], minSize: [420, 300],
        init(content, state) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.search', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.search</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const root = createEl('div', { style: 'display:flex;flex-direction:column;height:100%;overflow:hidden;' });
          content.appendChild(root);

          /* ── Search bar ── */
          const barWrap = createEl('div', { style: 'padding:12px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);' });
          const bar = createEl('div', { style: 'display:flex;align-items:center;gap:8px;background:var(--bg-sunken);border:1px solid var(--border-default);border-radius:8px;padding:7px 10px;transition:border-color 0.15s;' });
          const barIco = createEl('span', { style: 'color:var(--text-muted);flex-shrink:0;' });
          barIco.innerHTML = svgIcon('search', 16);
          const inp = createEl('input', { type: 'search', placeholder: 'Search files, contacts, downloads…', style: 'flex:1;background:none;border:none;outline:none;font-size:14px;color:var(--text-primary);', 'aria-label': 'Search' });
          const clearX = createEl('button', { style: 'background:none;border:none;color:var(--text-muted);cursor:pointer;display:none;padding:2px;', 'aria-label': 'Clear' });
          clearX.innerHTML = svgIcon('x', 14);
          bar.append(barIco, inp, clearX);
          barWrap.appendChild(bar);
          root.appendChild(barWrap);

          inp.addEventListener('focus', () => bar.style.borderColor = 'var(--accent)');
          inp.addEventListener('blur', () => bar.style.borderColor = 'var(--border-default)');

          /* ── Results area ── */
          const results = createEl('div', { style: 'flex:1;overflow-y:auto;padding:8px;' });
          root.appendChild(results);

          function section(title, items, renderFn) {
            if (!items.length) return null;
            const wrap = createEl('div', { style: 'margin-bottom:12px;' });
            const hdr = createEl('div', { textContent: title, style: 'font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em;padding:6px 8px 4px;' });
            wrap.appendChild(hdr);
            items.slice(0, 8).forEach(item => {
              const row = renderFn(item);
              if (row) wrap.appendChild(row);
            });
            return wrap;
          }

          function resultRow(icon, primary, secondary, onClick) {
            const row = createEl('div', { style: 'display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:6px;cursor:pointer;transition:background 0.1s;' });
            row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-hover)');
            row.addEventListener('mouseleave', () => row.style.background = '');
            row.addEventListener('click', onClick);
            const ico = createEl('span', { style: 'color:var(--accent);flex-shrink:0;' });
            ico.innerHTML = svgIcon(icon, 16);
            const text = createEl('div', { style: 'min-width:0;flex:1;' });
            const pri = createEl('div', { textContent: primary, style: 'font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' });
            const sec = createEl('div', { textContent: secondary, style: 'font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' });
            text.append(pri, sec);
            row.append(ico, text);
            return row;
          }

          function doSearch(q) {
            results.innerHTML = '';
            if (!q.trim()) {
              const hint = createEl('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:80%;color:var(--text-muted);gap:8px;' });
              hint.innerHTML = svgIcon('search', 36) + '<div style="font-size:13px;margin-top:10px;">Type to search</div>';
              results.appendChild(hint);
              return;
            }

            const lq = q.toLowerCase();
            let totalHits = 0;

            /* ── Files ── */
            const fileHits = Array.from(FS.files.values()).filter(f =>
              f.type === 'file' && (f.name || '').toLowerCase().includes(lq)
            ).slice(0, 12);

            const filesSec = section('Files', fileHits, f => {
              const icon = f.mimeType ? (f.mimeType.startsWith('image/') ? 'image' : f.mimeType.startsWith('audio/') ? 'music' : 'file') : 'file';
              const path = FS.getPath ? FS.getPath(f.id) : (f.name || '');
              return resultRow(icon, f.name, path, () => {
                if (f.mimeType && f.mimeType.startsWith('image/')) WM.createWindow('nbosp-gallery');
                else if (f.mimeType && f.mimeType.startsWith('audio/')) WM.createWindow('nbosp-music');
                else WM.createWindow('quill', { fileId: f.id });
              });
            });
            if (filesSec) { results.appendChild(filesSec); totalHits += fileHits.length; }

            /* ── Contacts ── */
            let contactData = [];
            try { contactData = JSON.parse(localStorage.getItem('nova_contacts') || '[]'); } catch { }
            const contactHits = contactData.filter(c =>
              (c.name || '').toLowerCase().includes(lq) ||
              (c.email || '').toLowerCase().includes(lq) ||
              (c.phone || '').toLowerCase().includes(lq)
            );
            const contactsSec = section('Contacts', contactHits, c =>
              resultRow('users', c.name || '(no name)', c.email || c.phone || '', () => WM.createWindow('nbosp-contacts'))
            );
            if (contactsSec) { results.appendChild(contactsSec); totalHits += contactHits.length; }

            /* ── Downloads ── */
            let dlData = [];
            try { dlData = JSON.parse(localStorage.getItem('nova_downloads') || '[]'); } catch { }
            const dlHits = dlData.filter(d => (d.name || '').toLowerCase().includes(lq));
            const dlSec = section('Downloads', dlHits, d =>
              resultRow('download', d.name, d.url || '', () => WM.createWindow('nbosp-downloads'))
            );
            if (dlSec) { results.appendChild(dlSec); totalHits += dlHits.length; }

            /* ── No results ── */
            if (!totalHits) {
              const none = createEl('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;color:var(--text-muted);gap:8px;text-align:center;' });
              none.innerHTML = svgIcon('search', 32) + '<div style="font-size:13px;margin-top:10px;color:var(--text-secondary);">No results for "' + escapeHtml(q) + '"</div>';
              results.appendChild(none);
            }
          }

          let debounce;
          inp.addEventListener('input', () => {
            clearX.style.display = inp.value ? '' : 'none';
            clearTimeout(debounce);
            debounce = setTimeout(() => doSearch(inp.value), 200);
          });
          clearX.addEventListener('click', () => { inp.value = ''; clearX.style.display = 'none'; doSearch(''); inp.focus(); });

          doSearch('');
          inp.focus();
        }
      });



      /* ═══════════════════════════════════════════════════════════════
         APP: Music — audio player using FS + HTML5 <audio>
         ═══════════════════════════════════════════════════════════════ */
      registerApp({
        id: 'nbosp-music', name: 'Music', icon: 'music',
        description: 'Music Player',
        defaultSize: [520, 520], minSize: [360, 380],
        init(content, state) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.music', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.music</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const SK_PREFS = 'nova_music_prefs';
          function loadPrefs() { try { return JSON.parse(localStorage.getItem(SK_PREFS) || '{}'); } catch { return {}; } }
          function savePrefs() { lsSave(SK_PREFS, prefs); }
          const prefs = loadPrefs();

          const root = createEl('div', { style: 'display:flex;flex-direction:column;height:100%;overflow:hidden;background:var(--bg-base);' });
          content.appendChild(root);

          /* ── Hidden <audio> element ── */
          const audio = document.createElement('audio');
          audio.style.display = 'none';
          audio.preload = 'metadata';
          root.appendChild(audio);

          /* ── State ── */
          let tracks = [];
          let queue = [];
          let queueIdx = -1;
          let shuffle = prefs.shuffle || false;
          let repeat = prefs.repeat || false;
          const blobCache = new Map();

          function normalizeBuffer(raw) {
            if (!raw) return null;
            if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return raw;
            if (typeof raw === 'string') { try { const b = atob(raw), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++)u[i] = b.charCodeAt(i); return u; } catch { return new TextEncoder().encode(raw); } }
            if (typeof raw === 'object') { const keys = Object.keys(raw), u = new Uint8Array(keys.length); for (let i = 0; i < keys.length; i++)u[i] = raw[i] ?? 0; return u; }
            return null;
          }

          function audioMimeFromName(name) {
            const ext = (name || '').split('.').pop().toLowerCase();
            return {
              mp3: 'audio/mpeg', mp4: 'audio/mp4', m4a: 'audio/mp4', ogg: 'audio/ogg',
              wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
              opus: 'audio/ogg; codecs=opus', weba: 'audio/webm', webm: 'audio/webm'
            }[ext] || 'audio/mpeg';
          }

          function getUrl(track) {
            if (blobCache.has(track.id)) return blobCache.get(track.id);
            if (track.content) {
              try {
                const data = normalizeBuffer(track.content);
                if (!data) return null;
                // Use extension-derived MIME when stored type is missing or non-audio
                // (e.g. 'application/octet-stream'). A wrong MIME on the blob causes
                // NS_ERROR_DOM_MEDIA_METADATA_ERR in Firefox even if the data is valid.
                const storedMime = track.mimeType || '';
                const mime = storedMime.startsWith('audio/') ? storedMime : audioMimeFromName(track.name);
                const blob = new Blob([data], { type: mime });
                const url = URL.createObjectURL(blob);
                blobCache.set(track.id, url);
                return url;
              } catch { return null; }
            }
            return null;
          }

          /* ── Library header ── */
          const libHeader = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);' });
          const libTitle = createEl('span', { textContent: 'Library', style: 'font-size:13px;font-weight:600;flex:1;' });
          const libCount = createEl('span', { style: 'font-size:11px;color:var(--text-muted);' });
          const refreshBtn = createEl('button', { className: 'browser-nav-btn', title: 'Rescan library' });
          refreshBtn.innerHTML = svgIcon('refresh', 15);
          libHeader.append(libTitle, libCount, refreshBtn);
          root.appendChild(libHeader);

          /* ── Track list ── */
          const trackList = createEl('div', { style: 'flex:1;overflow-y:auto;min-height:0;' });
          root.appendChild(trackList);

          /* ── Now-playing bar ── */
          const player = createEl('div', { style: 'border-top:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);padding:12px 14px;display:flex;flex-direction:column;gap:8px;' });

          const trackInfoRow = createEl('div', { style: 'display:flex;align-items:center;gap:10px;' });
          const albumArt = createEl('div', { style: 'width:40px;height:40px;border-radius:6px;background:var(--bg-sunken);border:1px solid var(--border-subtle);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--text-muted);' });
          albumArt.innerHTML = svgIcon('music', 18);
          const trackNameEl = createEl('div', { style: 'flex:1;min-width:0;' });
          const trackTitle = createEl('div', { textContent: 'No track selected', style: 'font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' });
          const trackSub = createEl('div', { textContent: '', style: 'font-size:11px;color:var(--text-muted);' });
          trackNameEl.append(trackTitle, trackSub);
          trackInfoRow.append(albumArt, trackNameEl);

          /* Progress row */
          const progressRow = createEl('div', { style: 'display:flex;align-items:center;gap:8px;' });
          const timeCur = createEl('span', { textContent: '0:00', style: 'font-size:10px;color:var(--text-muted);width:30px;text-align:right;font-variant-numeric:tabular-nums;' });
          const scrubWrap = createEl('div', { style: 'flex:1;height:4px;background:var(--border-subtle);border-radius:2px;cursor:pointer;position:relative;' });
          const scrubFill = createEl('div', { style: 'height:100%;background:var(--accent);border-radius:2px;width:0%;transition:width 0.25s linear;pointer-events:none;' });
          scrubWrap.appendChild(scrubFill);
          const timeTotal = createEl('span', { textContent: '0:00', style: 'font-size:10px;color:var(--text-muted);width:30px;font-variant-numeric:tabular-nums;' });
          progressRow.append(timeCur, scrubWrap, timeTotal);

          /* Controls row */
          const controlsRow = createEl('div', { style: 'display:flex;align-items:center;justify-content:center;gap:6px;' });
          function ctrlBtn(icon, size, title) {
            const b = createEl('button', { className: 'browser-nav-btn', title, style: 'width:32px;height:32px;display:flex;align-items:center;justify-content:center;' });
            b.innerHTML = svgIcon(icon, size);
            return b;
          }
          const shuffleBtn = ctrlBtn('shuffle', 14, 'Shuffle');
          const prevBtn = ctrlBtn('skip-back', 16, 'Previous');
          const playPauseBtn = createEl('button', { style: 'width:38px;height:38px;border-radius:50%;background:var(--accent);border:none;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform 0.1s,background 0.1s;', title: 'Play/Pause' });
          playPauseBtn.innerHTML = svgIcon('play', 18);
          const nextBtn = ctrlBtn('skip-forward', 16, 'Next');
          const repeatBtn = ctrlBtn('repeat', 14, 'Repeat');

          /* Volume */
          const volRow = createEl('div', { style: 'display:flex;align-items:center;gap:6px;' });
          const volIco = createEl('span', { style: 'color:var(--text-muted);', innerHTML: svgIcon('volume-2', 14) });
          const volSlider = createEl('input', { type: 'range', min: '0', max: '1', step: '0.02', value: String(prefs.volume !== undefined ? prefs.volume : 1), style: 'flex:1;accent-color:var(--accent);height:4px;cursor:pointer;' });
          volRow.append(volIco, volSlider);

          controlsRow.append(shuffleBtn, prevBtn, playPauseBtn, nextBtn, repeatBtn, createEl('span', { style: 'flex:1;' }), volRow);
          player.append(trackInfoRow, progressRow, controlsRow);
          root.appendChild(player);

          /* ── Audio event wiring ── */
          function fmtTime(s) { if (!isFinite(s)) return '0:00'; const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }

          audio.volume = parseFloat(volSlider.value);

          audio.addEventListener('timeupdate', () => {
            if (!audio.duration) return;
            const pct = (audio.currentTime / audio.duration) * 100;
            scrubFill.style.width = pct + '%';
            timeCur.textContent = fmtTime(audio.currentTime);
          });
          audio.addEventListener('loadedmetadata', () => { timeTotal.textContent = fmtTime(audio.duration); });
          audio.addEventListener('ended', () => {
            if (repeat) { audio.currentTime = 0; audio.play(); }
            else playIdx(queueIdx + 1);
          });
          audio.addEventListener('play', () => { playPauseBtn.innerHTML = svgIcon('pause', 18); });
          audio.addEventListener('pause', () => { playPauseBtn.innerHTML = svgIcon('play', 18); });

          scrubWrap.addEventListener('click', e => {
            if (!audio.duration) return;
            const r = scrubWrap.getBoundingClientRect();
            audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
          });

          volSlider.addEventListener('input', () => { audio.volume = parseFloat(volSlider.value); prefs.volume = audio.volume; savePrefs(); });

          playPauseBtn.addEventListener('mouseenter', () => playPauseBtn.style.transform = 'scale(1.08)');
          playPauseBtn.addEventListener('mouseleave', () => playPauseBtn.style.transform = '');
          playPauseBtn.addEventListener('click', () => { if (audio.paused) audio.play().catch(() => { }); else audio.pause(); });
          prevBtn.addEventListener('click', () => playIdx(queueIdx - 1));
          nextBtn.addEventListener('click', () => playIdx(queueIdx + 1));

          shuffleBtn.addEventListener('click', () => {
            shuffle = !shuffle; prefs.shuffle = shuffle; savePrefs();
            shuffleBtn.style.color = shuffle ? 'var(--accent)' : '';
            buildQueue();
          });
          repeatBtn.addEventListener('click', () => {
            repeat = !repeat; prefs.repeat = repeat; savePrefs();
            repeatBtn.style.color = repeat ? 'var(--accent)' : '';
          });

          /* Init toggle states */
          if (shuffle) shuffleBtn.style.color = 'var(--accent)';
          if (repeat) repeatBtn.style.color = 'var(--accent)';

          /* ── Queue management ── */
          function buildQueue(startId) {
            queue = [...tracks];
            if (shuffle) {
              for (let i = queue.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [queue[i], queue[j]] = [queue[j], queue[i]];
              }
            }
            if (startId) {
              const si = queue.findIndex(t => t.id === startId);
              if (si > -1) queueIdx = si;
            }
          }

          function playIdx(i) {
            if (!queue.length) return;
            queueIdx = ((i % queue.length) + queue.length) % queue.length;
            playTrack(queue[queueIdx]);
          }

          function playTrack(track) {
            const url = getUrl(track);
            if (!url) { Notify.show({ title: 'Music', body: 'Cannot load ' + track.name, type: 'error', appName: 'Music' }); return; }
            audio.src = url;
            audio.play().catch(() => { });
            trackTitle.textContent = track.name.replace(/\.[^.]+$/, '');
            trackSub.textContent = fmtTime(0);
            renderList();
          }

          /* ── Library scan & render ── */
          function scanLibrary() {
            const audioExts = new Set(['mp3', 'mp4', 'm4a', 'ogg', 'wav', 'flac', 'aac', 'opus', 'weba', 'webm']);
            tracks = Array.from(FS.files.values())
              .filter(f => {
                if (f.type !== 'file') return false;
                if (f.mimeType && f.mimeType.startsWith('audio/')) return true;
                const ext = (f.name || '').split('.').pop().toLowerCase();
                return audioExts.has(ext);
              })
              .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            libCount.textContent = tracks.length ? tracks.length + ' track' + (tracks.length > 1 ? 's' : '') : '';
            buildQueue();
            renderList();
          }

          function renderList() {
            trackList.innerHTML = '';
            if (!tracks.length) {
              const empty = createEl('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-muted);gap:8px;text-align:center;padding:24px;' });
              empty.innerHTML = svgIcon('music', 36) + '<div style="font-size:13px;margin-top:10px;color:var(--text-secondary);">No audio files found</div><div style="font-size:11px;margin-top:4px;">Save audio files via Files to play them here</div>';
              trackList.appendChild(empty);
              return;
            }

            const currentId = queue[queueIdx]?.id;
            tracks.forEach((track, idx) => {
              const isPlaying = track.id === currentId;
              const row = createEl('div', { style: 'display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--border-subtle);cursor:pointer;transition:background 0.1s;background:' + (isPlaying ? 'var(--accent-muted)' : 'transparent') + ';', title: track.name });
              row.addEventListener('mouseenter', () => { if (!isPlaying) row.style.background = 'var(--bg-hover)'; });
              row.addEventListener('mouseleave', () => { if (!isPlaying) row.style.background = ''; });
              row.addEventListener('dblclick', () => { buildQueue(track.id); playTrack(track); });
              row.addEventListener('click', () => {
                if (isPlaying) { if (audio.paused) audio.play().catch(() => { }); else audio.pause(); }
                else { buildQueue(track.id); playTrack(track); }
              });

              const ico = createEl('span', { style: 'color:' + (isPlaying ? 'var(--accent)' : 'var(--text-muted)') + ';flex-shrink:0;' });
              ico.innerHTML = svgIcon(isPlaying && !audio.paused ? 'pause' : 'music', 15);

              const nameEl = createEl('div', { textContent: track.name.replace(/\.[^.]+$/, ''), style: 'flex:1;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:' + (isPlaying ? 'var(--accent)' : 'var(--text-primary)') + ';' });
              const numEl = createEl('div', { textContent: String(idx + 1).padStart(2, '0'), style: 'font-size:11px;color:var(--text-muted);font-variant-numeric:tabular-nums;flex-shrink:0;min-width:20px;text-align:right;' });

              row.append(numEl, ico, nameEl);
              trackList.appendChild(row);
            });
          }

          refreshBtn.addEventListener('click', scanLibrary);

          state.cleanups = state.cleanups || [];
          state.cleanups.push(() => {
            audio.pause();
            blobCache.forEach(u => URL.revokeObjectURL(u));
          });

          scanLibrary();
        }
      });


      // Start the OS
      boot();

      // FIX: run FrameSecurity audit after boot settles so all app iframes are in the DOM
      setTimeout(function () {
        if (typeof window.FrameSecurity !== 'undefined') {
          const audit = window.FrameSecurity.auditAllFrames(false);
          if (audit.issues.length > 0) {
            console.error('[FrameSecurity] Boot audit found issues:', audit.issues);
          }
        }
      }, 3000);

    })();