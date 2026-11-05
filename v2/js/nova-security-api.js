/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  NovaByte OS — Security Update API  (nova-security-api.js)              ║
 * ║  Version 1.0.0  |  Requires NovaByte OS 2.3.8+                         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Enforces minimum security patch levels for apps that handle sensitive data.
 *
 * ── HOW IT WORKS ────────────────────────────────────────────────────────────
 *
 *  1. On boot, this module reads the OS security patch date from the About
 *     section value and exposes it as  OS.securityPatch  (e.g. "2026-05-01").
 *
 *  2. When any window is created, WM.createWindow is patched to call
 *     NovaSecurityAPI.enforce() automatically after app.init().
 *
 *  3. If the app's declared  minSecurityPatch  date is newer than the OS patch
 *     date, an UNSKIPPABLE full-screen blocking dialog is injected into the
 *     window content. It cannot be dismissed and the window auto-closes after
 *     a short countdown.
 *
 *  4. Apps that request sensitive permissions (see SENSITIVE_PERMISSIONS below)
 *     are auto-enrolled even without an explicit  minSecurityPatch  field —
 *     they must be on a patch no older than AUTO_PATCH_MAX_AGE_DAYS.
 *
 * ── DEVELOPER MANIFEST FIELDS ───────────────────────────────────────────────
 *
 *  minSecurityPatch  {string}   ISO date "YYYY-MM-DD". The OS security patch
 *                               date must be on or after this date for the app
 *                               to run. Omit to rely on auto-enforcement only.
 *
 *  Example manifest.json:
 *  {
 *    "id": "com.example.passwordmanager",
 *    "name": "My Password Manager",
 *    "version": "1.0.0",
 *    "entry": "index.html",
 *    "permissions": ["fs:read", "fs:write"],
 *    "minSecurityPatch": "2026-03-01",   ← NEW FIELD
 *    "defaultSize": [700, 500]
 *  }
 *
 * ── POSTMESSAGE API (sandboxed / iframe apps) ────────────────────────────────
 *
 *  Apps running in a sandboxed iframe can trigger a manual security check:
 *
 *    window.parent.postMessage({
 *      type:         'nova:security:check',
 *      minPatchDate: '2026-04-01',          // required
 *      reason:       'Storing credentials'  // optional, shown in dialog
 *    }, '*');
 *
 *  The OS will respond with:
 *    { type: 'nova:security:result', compliant: true|false, current: '2026-05-01', required: '...' }
 *
 * ── ADDING TO index.html ────────────────────────────────────────────────────
 *
 *  Place this script tag AFTER the main OS bundle and BEFORE session-manager:
 *
 *    <script src="/js/nova-security-api.js" defer></script>
 *
 * ────────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  //  CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════

  /** The OS security patch date — sourced from the About section. */
  const OS_PATCH_DATE = '2026-05-01';

  /**
   * Permissions that automatically trigger security enforcement even when
   * the developer has not declared minSecurityPatch in their manifest.
   */
  const SENSITIVE_PERMISSIONS = new Set([
    'fs:write',
    'fs:delete',
    'device:geolocation',
    'system:settings',
    'admin:system',
  ]);

  /**
   * When auto-enforcing based on sensitive permissions, the OS patch date must
   * be no older than this many days. (180 days = ~6 months)
   */
  const AUTO_PATCH_MAX_AGE_DAYS = 180;

  /** Countdown (seconds) before the blocked window auto-closes. */
  const AUTO_CLOSE_SECONDS = 6;

  // ═══════════════════════════════════════════════════════════════════════════
  //  UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════

  function parseDate(str) {
    // Parse YYYY-MM-DD safely without timezone shifting
    const [y, m, d] = String(str).split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function formatDate(date) {
    return date.toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CORE API
  // ═══════════════════════════════════════════════════════════════════════════

  const NovaSecurityAPI = {

    version: '1.0.0',

    // ── Patch date accessors ─────────────────────────────────────────────────

    /** Return the current OS security patch date as a Date object. */
    getCurrentPatchDate() {
      // Prefer a value written by update-service at runtime
      if (window.OS && OS.securityPatch) {
        return parseDate(OS.securityPatch);
      }
      return parseDate(OS_PATCH_DATE);
    },

    /** Return the ISO date string (YYYY-MM-DD) of the current OS patch. */
    getCurrentPatchString() {
      if (window.OS && OS.securityPatch) return OS.securityPatch;
      return OS_PATCH_DATE;
    },

    /**
     * Called by update-service.js after a successful OS update to record the
     * new patch date.
     * @param {string} isoDate - e.g. "2026-07-01"
     */
    recordPatch(isoDate) {
      if (window.OS) OS.securityPatch = isoDate;
      try { localStorage.setItem('nova_security_patch_date', isoDate); } catch (_) {}
    },

    // ── Compliance checks ────────────────────────────────────────────────────

    /** Returns true when the OS patch date meets or exceeds requiredDate. */
    meetsRequirement(requiredDate) {
      return this.getCurrentPatchDate() >= parseDate(requiredDate);
    },

    /** Returns true when any listed permission is in SENSITIVE_PERMISSIONS. */
    hasSensitivePermissions(permissions) {
      return (permissions || []).some(p => SENSITIVE_PERMISSIONS.has(p));
    },

    /**
     * Derive the effective minPatchDate for an app object.
     * Returns { date: 'YYYY-MM-DD', reason: string } or null if no check
     * is required.
     */
    _resolveRequirement(app) {
      // 1 — Explicit developer declaration always wins
      if (app.minSecurityPatch) {
        return {
          date: app.minSecurityPatch,
          reason: `<strong>${escHtml(app.name || 'This app')}</strong> requires a minimum security patch level to protect sensitive data.`,
        };
      }

      // 2 — Auto-enforcement for sensitive permissions
      const allPerms = [
        ...(app.permissions || []),
        ...(app.optionalPermissions || []),
      ];
      if (this.hasSensitivePermissions(allPerms)) {
        const threshold = new Date();
        threshold.setDate(threshold.getDate() - AUTO_PATCH_MAX_AGE_DAYS);
        const iso = threshold.toISOString().split('T')[0];
        const sensitiveList = allPerms
          .filter(p => SENSITIVE_PERMISSIONS.has(p))
          .join(', ');
        return {
          date: iso,
          reason: `<strong>${escHtml(app.name || 'This app')}</strong> uses sensitive permissions (<code>${escHtml(sensitiveList)}</code>) and requires an up-to-date security patch.`,
        };
      }

      return null; // No requirement — app is unrestricted
    },

    // ── Enforcement entry point ───────────────────────────────────────────────

    /**
     * Check whether the given app is allowed to run on this OS patch level.
     * If blocked, injects the unskippable dialog into contentEl and schedules
     * the window to auto-close.
     *
     * @param {string}      windowId  - WM window ID
     * @param {object}      app       - OS.apps[appId] (manifest + init fn)
     * @param {HTMLElement} contentEl - The .window-content element
     * @returns {boolean} true = compliant (app runs normally), false = blocked
     */
    enforce(windowId, app, contentEl) {
      const req = this._resolveRequirement(app);
      if (!req) return true;                      // no requirement
      if (this.meetsRequirement(req.date)) return true; // compliant

      // ── Blocked ──────────────────────────────────────────────────────────
      this._showBlockingDialog(windowId, app, contentEl, req);
      return false;
    },

    // ── Blocking dialog ───────────────────────────────────────────────────────

    _showBlockingDialog(windowId, app, contentEl, req) {
      const currentDate  = this.getCurrentPatchDate();
      const requiredDate = parseDate(req.date);
      const currentStr   = formatDate(currentDate);
      const requiredStr  = formatDate(requiredDate);
      const appName      = escHtml(app.name || 'This app');

      // --- Inject scoped CSS once per page ---
      if (!document.getElementById('nsec-api-styles')) {
        const style = document.createElement('style');
        style.id = 'nsec-api-styles';
        style.textContent = `
/* ── NovaByte Security Block Overlay ─────────────────────────────────────── */
.nsec-overlay {
  position: absolute; inset: 0; z-index: 99999;
  display: flex; align-items: center; justify-content: center;
  background: rgba(4, 6, 12, 0.82);
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  pointer-events: all;
  animation: nsec-fade-in 0.28s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  border-radius: inherit;
  overflow: hidden;
}
@keyframes nsec-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

.nsec-dialog {
  display: flex; flex-direction: column; align-items: center;
  gap: 0;
  background: rgba(14, 18, 28, 0.92);
  border: 1px solid rgba(248, 81, 73, 0.35);
  border-radius: 18px;
  box-shadow:
    0 40px 80px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(248, 81, 73, 0.12),
    inset 0 1px 0 rgba(255, 255, 255, 0.07);
  max-width: 420px; width: calc(100% - 48px);
  overflow: hidden;
  animation: nsec-slide-up 0.32s cubic-bezier(0.175, 0.885, 0.32, 1.15);
}
@keyframes nsec-slide-up {
  from { opacity: 0; transform: translateY(24px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0)    scale(1);    }
}

/* Danger stripe at top */
.nsec-danger-stripe {
  width: 100%; height: 4px;
  background: linear-gradient(90deg, #f85149 0%, #ff6b6b 50%, #f85149 100%);
  background-size: 200% 100%;
  animation: nsec-stripe-shimmer 2s linear infinite;
}
@keyframes nsec-stripe-shimmer {
  from { background-position: 200% 0; }
  to   { background-position: -200% 0; }
}

.nsec-body {
  padding: 28px 28px 0;
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  text-align: center;
}

/* Shield icon */
.nsec-shield-wrap {
  width: 72px; height: 72px; border-radius: 50%;
  background: rgba(248, 81, 73, 0.1);
  border: 1.5px solid rgba(248, 81, 73, 0.3);
  display: flex; align-items: center; justify-content: center;
  animation: nsec-pulse 2.2s ease-in-out infinite;
  flex-shrink: 0;
}
@keyframes nsec-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(248, 81, 73, 0.25); }
  50%       { box-shadow: 0 0 0 10px rgba(248, 81, 73, 0);  }
}
.nsec-shield-wrap svg {
  color: #f85149;
  filter: drop-shadow(0 0 8px rgba(248, 81, 73, 0.5));
}

/* Text */
.nsec-heading {
  font-family: var(--font-ui, system-ui, sans-serif);
  font-size: 17px; font-weight: 800; letter-spacing: -0.01em;
  color: #f0f6fc;
  line-height: 1.2;
  margin: 0;
}
.nsec-sub {
  font-family: var(--font-ui, system-ui, sans-serif);
  font-size: 13px; color: #8b949e; line-height: 1.55;
  margin: 0;
}
.nsec-sub strong { color: #e6edf3; }
.nsec-sub code {
  font-family: var(--font-mono, monospace);
  font-size: 11.5px; background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.1); border-radius: 4px;
  padding: 1px 5px; color: #f0f6fc;
}

/* Patch comparison card */
.nsec-patch-card {
  width: 100%;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 12px;
  overflow: hidden;
}
.nsec-patch-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 11px 16px; font-size: 12.5px;
  font-family: var(--font-ui, system-ui, sans-serif);
}
.nsec-patch-row + .nsec-patch-row {
  border-top: 1px solid rgba(255, 255, 255, 0.07);
}
.nsec-patch-label { color: #8b949e; }
.nsec-date-current {
  font-weight: 700; color: #f85149;
  background: rgba(248, 81, 73, 0.1);
  border: 1px solid rgba(248, 81, 73, 0.25);
  border-radius: 20px; padding: 2px 10px; font-size: 12px;
}
.nsec-date-required {
  font-weight: 700; color: #3fb950;
  background: rgba(63, 185, 80, 0.08);
  border: 1px solid rgba(63, 185, 80, 0.25);
  border-radius: 20px; padding: 2px 10px; font-size: 12px;
}

/* Update hint */
.nsec-hint {
  font-family: var(--font-ui, system-ui, sans-serif);
  font-size: 12px; color: #484f58; line-height: 1.5;
  margin: 0;
}
.nsec-hint strong { color: #8b949e; }

/* Countdown footer */
.nsec-footer {
  width: 100%;
  padding: 16px 28px 22px;
  display: flex; flex-direction: column; align-items: center; gap: 9px;
}
.nsec-countdown-text {
  font-family: var(--font-ui, system-ui, sans-serif);
  font-size: 12px; color: #484f58;
}
.nsec-countdown-text span {
  font-weight: 700; color: #f85149;
  font-variant-numeric: tabular-nums;
}
.nsec-progress-track {
  width: 100%; height: 3px; border-radius: 99px;
  background: rgba(255, 255, 255, 0.07);
  overflow: hidden;
}
.nsec-progress-bar {
  height: 100%; border-radius: 99px;
  background: linear-gradient(90deg, #f85149, #ff6b6b);
  width: 100%;
  transition: width 1s linear;
}
/* ── End NovaByte Security Block Overlay ──────────────────────────────────── */
        `;
        document.head.appendChild(style);
      }

      // --- Build overlay DOM ---
      const overlay = document.createElement('div');
      overlay.className = 'nsec-overlay';
      overlay.setAttribute('role', 'alertdialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'Security patch required');

      // Intercept ALL pointer/keyboard events — nothing below can be reached
      overlay.addEventListener('pointerdown',  e => e.stopPropagation(), true);
      overlay.addEventListener('pointerup',    e => e.stopPropagation(), true);
      overlay.addEventListener('click',        e => e.stopPropagation(), true);
      overlay.addEventListener('keydown',      e => e.stopPropagation(), true);
      overlay.addEventListener('contextmenu',  e => { e.preventDefault(); e.stopPropagation(); }, true);

      overlay.innerHTML = `
        <div class="nsec-dialog">
          <div class="nsec-danger-stripe"></div>

          <div class="nsec-body">
            <!-- Shield icon -->
            <div class="nsec-shield-wrap">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="1.6"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                <line x1="12" y1="8"  x2="12"   y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>

            <h2 class="nsec-heading">Security Patch Required</h2>

            <p class="nsec-sub">${req.reason}</p>

            <!-- Patch date comparison -->
            <div class="nsec-patch-card">
              <div class="nsec-patch-row">
                <span class="nsec-patch-label">Your patch level</span>
                <span class="nsec-date-current">${escHtml(currentStr)}</span>
              </div>
              <div class="nsec-patch-row">
                <span class="nsec-patch-label">Minimum required</span>
                <span class="nsec-date-required">${escHtml(requiredStr)}</span>
              </div>
            </div>

            <p class="nsec-hint">
              Go to <strong>Settings → Updates</strong> to install the latest
              NovaByte OS security patch, then relaunch ${appName}.
            </p>
          </div>

          <!-- Countdown footer -->
          <div class="nsec-footer">
            <div class="nsec-progress-track">
              <div class="nsec-progress-bar" id="nsec-bar-${windowId}"></div>
            </div>
            <p class="nsec-countdown-text">
              App closing in <span id="nsec-count-${windowId}">${AUTO_CLOSE_SECONDS}</span>s
            </p>
          </div>
        </div>
      `;

      // Ensure content area is relatively positioned so absolute overlay works
      const prevPos = contentEl.style.position;
      if (!prevPos || prevPos === 'static') contentEl.style.position = 'relative';

      contentEl.appendChild(overlay);

      // ── Countdown + auto-close ──────────────────────────────────────────
      let remaining = AUTO_CLOSE_SECONDS;
      const countEl = overlay.querySelector(`#nsec-count-${windowId}`);
      const barEl   = overlay.querySelector(`#nsec-bar-${windowId}`);

      const tick = () => {
        remaining--;
        if (countEl) countEl.textContent = remaining;
        if (barEl)   barEl.style.width = (remaining / AUTO_CLOSE_SECONDS * 100) + '%';

        if (remaining <= 0) {
          clearInterval(timer);
          // Close the window via WM
          try {
            if (window.WM && typeof WM.closeWindow === 'function') {
              WM.closeWindow(windowId);
            }
          } catch (_) {}
          // Fallback: remove overlay anyway
          try { overlay.remove(); } catch (_) {}
        }
      };

      // Kick off — first tick after 1 s so the user sees the initial count
      const timer = setInterval(tick, 1000);

      // Show OS notification as well
      try {
        if (window.Notify && typeof Notify.show === 'function') {
          Notify.show({
            title:   'Security Update Required',
            body:    `${app.name || 'An app'} requires a newer security patch to run.`,
            type:    'error',
            appName: 'Security',
          });
        }
      } catch (_) {}
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  POSTMESSAGE HANDLER (sandboxed / iframe apps)
    // ═══════════════════════════════════════════════════════════════════════

    _handleMessage(event) {
      const msg = event.data;
      if (!msg || msg.type !== 'nova:security:check') return;

      const minPatchDate = msg.minPatchDate;
      if (!minPatchDate) return;

      const compliant = NovaSecurityAPI.meetsRequirement(minPatchDate);
      const current   = NovaSecurityAPI.getCurrentPatchString();

      // Reply to the iframe
      try {
        event.source.postMessage({
          type:      'nova:security:result',
          compliant,
          current,
          required:  minPatchDate,
        }, event.origin || '*');
      } catch (_) {}

      // If not compliant, find which window this iframe belongs to and block it
      if (!compliant) {
        const iframes = document.querySelectorAll('.window-content iframe');
        for (const iframe of iframes) {
          if (iframe.contentWindow === event.source) {
            // Walk up to find the .window-content and its window ID
            const contentEl = iframe.closest('.window-content');
            const winEl     = iframe.closest('[data-window-id]');
            if (contentEl && winEl) {
              const windowId = winEl.dataset.windowId;
              const appId    = winEl.dataset.appId;
              const app      = (window.OS && OS.apps && OS.apps[appId]) || {
                name:      msg.reason || 'This app',
                appId,
              };
              const req = {
                date:   minPatchDate,
                reason: msg.reason
                  ? escHtml(msg.reason)
                  : `<strong>${escHtml(app.name || 'This app')}</strong> has requested a security patch check.`,
              };
              NovaSecurityAPI._showBlockingDialog(windowId, app, contentEl, req);
            }
            break;
          }
        }
      }
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  BOOT — Initialise once the DOM & OS are ready
  // ═══════════════════════════════════════════════════════════════════════════

  function init() {
    // 1. Expose the API globally
    window.NovaSecurityAPI = NovaSecurityAPI;

    // 2. Seed OS.securityPatch from localStorage (written by update-service)
    //    or fall back to the built-in About section value.
    if (window.OS) {
      try {
        const stored = localStorage.getItem('nova_security_patch_date');
        OS.securityPatch = stored || OS_PATCH_DATE;
      } catch (_) {
        OS.securityPatch = OS_PATCH_DATE;
      }
    }

    // 3. Patch WM.createWindow to inject security enforcement after app.init()
    if (window.WM && typeof WM.createWindow === 'function') {
      const _original = WM.createWindow.bind(WM);

      WM.createWindow = function (appId, options) {
        const winEl = _original(appId, options);

        // winEl may be null (e.g. GPO blocked, app not found)
        if (!winEl) return winEl;

        // Resolve window state & app
        try {
          const app = OS.apps && OS.apps[appId];
          if (!app) return winEl;

          // The window ID is on the returned element's dataset
          const windowId = winEl.dataset && winEl.dataset.windowId;
          if (!windowId) return winEl;

          const contentEl = winEl.querySelector('.window-content');
          if (!contentEl) return winEl;

          // Run enforcement — blocks silently if not required
          NovaSecurityAPI.enforce(windowId, app, contentEl);
        } catch (_) {
          // Never crash the OS over a security check failure
        }

        return winEl;
      };
    }

    // 4. Listen for postMessage requests from sandboxed apps
    window.addEventListener('message', NovaSecurityAPI._handleMessage.bind(NovaSecurityAPI));

    if (typeof DEBUG !== 'undefined' && DEBUG) {
      console.log('[NovaSecurityAPI] Loaded. OS patch level:', NovaSecurityAPI.getCurrentPatchString());
    }
  }

  // Wait for the OS to finish booting
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Boot screen hides via a "booted" event; delay slightly to let WM attach
    window.addEventListener('nova:booted', init, { once: true });
    // Fallback in case the event already fired
    setTimeout(init, 0);
  }

})();

/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION REFERENCE FOR DEVELOPERS
   ───────────────────────────────────────────────────────────────────────────

   ┌─ Manifest field ──────────────────────────────────────────────────────┐
   │                                                                         │
   │  "minSecurityPatch": "YYYY-MM-DD"                                       │
   │                                                                         │
   │  The OS security patch date (shown in Settings → About) must be on or  │
   │  after this date for the app to launch. If it isn't, the user sees the  │
   │  blocking dialog and the window closes automatically.                   │
   │                                                                         │
   │  Permissions that trigger AUTO-enforcement even without this field:     │
   │    fs:write  |  fs:delete  |  device:geolocation                        │
   │    system:settings  |  admin:system                                     │
   │                                                                         │
   └─────────────────────────────────────────────────────────────────────────┘

   ┌─ postMessage API (sandboxed apps) ─────────────────────────────────────┐
   │                                                                         │
   │  // Trigger a check from inside your iframe:                            │
   │  window.parent.postMessage({                                            │
   │    type:         'nova:security:check',                                 │
   │    minPatchDate: '2026-04-01',                                          │
   │    reason:       'Required to store encrypted passwords safely.'        │
   │  }, '*');                                                               │
   │                                                                         │
   │  // Listen for the result:                                              │
   │  window.addEventListener('message', (e) => {                           │
   │    if (e.data.type === 'nova:security:result') {                        │
   │      console.log(e.data.compliant);  // true or false                  │
   │      console.log(e.data.current);    // "2026-05-01"                   │
   │    }                                                                    │
   │  });                                                                    │
   │                                                                         │
   └─────────────────────────────────────────────────────────────────────────┘

   ┌─ Programmatic check (trusted OS code) ─────────────────────────────────┐
   │                                                                         │
   │  // Check before doing something sensitive:                             │
   │  if (!NovaSecurityAPI.meetsRequirement('2026-03-01')) {                 │
   │    // OS is out of date                                                 │
   │  }                                                                      │
   │                                                                         │
   │  // Record a new patch level after an OS update:                        │
   │  NovaSecurityAPI.recordPatch('2026-07-01');                             │
   │                                                                         │
   └─────────────────────────────────────────────────────────────────────────┘

   ┌─ How update-service.js should record the new patch date ───────────────┐
   │                                                                         │
   │  // Inside your update apply logic, after writing the new index.html:  │
   │  if (window.NovaSecurityAPI) {                                          │
   │    NovaSecurityAPI.recordPatch(pkg.securityPatchDate);                  │
   │  }                                                                      │
   │                                                                         │
   │  // Or write directly to localStorage so the next boot picks it up:    │
   │  localStorage.setItem('nova_security_patch_date', '2026-07-01');       │
   │                                                                         │
   └─────────────────────────────────────────────────────────────────────────┘

   ┌─ Adding the script tag to index.html ──────────────────────────────────┐
   │                                                                         │
   │  <!-- Place after the main OS bundle, before session-manager -->        │
   │  <script src="/js/nova-security-api.js" defer></script>                 │
   │                                                                         │
   └─────────────────────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════════════════ */