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
 *     section value and exposes it as  getOS().securityPatch  (e.g. "2026-05-01").
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
  //  OS REFERENCE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Accessor for the global OS object. Using a getter function instead of a
   * captured const means we always read the current window.OS value, which is
   * safe even if this script somehow executes before the boot script finishes.
   *
   * The OS object is defined as  const OS = window.OS = { ... }  inside
   * index.html's IIFE, so it is NOT available as a bare `OS` identifier here —
   * only as window.OS.
   */
  function getOS() { return window.OS; }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Last-resort fallback. null = no hardcoded date — the OS object set in
   * index.html (window.OS.securityPatch) is always the source of truth.
   */
  const OS_PATCH_DATE = null;

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

  // (Countdown removed — dialog now uses action buttons instead)

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
      // 1. Live OS object — set by index.html at boot (window.OS = OS)
      const os = getOS();
      if (os && os.securityPatch) return parseDate(os.securityPatch);

      // 2. localStorage — written by recordPatch() after updates
      try {
        const stored = localStorage.getItem('nova_security_patch_date');
        if (stored) return parseDate(stored);
      } catch (_) {}

      // 3. No date available — return epoch (always fails the check)
      return new Date(0);
    },

    /** Return the ISO date string (YYYY-MM-DD) of the current OS patch. */
    getCurrentPatchString() {
      const os = getOS();
      if (os && os.securityPatch) return os.securityPatch;
      try {
        const stored = localStorage.getItem('nova_security_patch_date');
        if (stored) return stored;
      } catch (_) {}
      return OS_PATCH_DATE || '1970-01-01';
    },

    /**
     * Called by update-service.js after a successful OS update to record the
     * new patch date.
     * @param {string} isoDate - e.g. "2026-07-01"
     */
    recordPatch(isoDate) {
      if (window.OS) getOS().securityPatch = isoDate;
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

    // ── Fail-safe force close ─────────────────────────────────────────────────

    /**
     * Immediately kill a window and surface the reason.
     * Called whenever the security pipeline throws — we NEVER let an app
     * through just because the check itself errored.
     *
     * @param {string|null} windowId - WM window ID (may be unknown)
     * @param {string}      reason   - Human-readable explanation
     * @param {Error|null}  err      - Original caught exception, if any
     */
    _forceClose(windowId, reason, err) {
      const label = `[NovaSecurityAPI] FORCE-CLOSE — ${reason}`;
      if (err) {
        console.error(label, err);
      } else {
        console.error(label);
      }

      // Kill the window immediately
      if (windowId) {
        try {
          if (window.WM && typeof WM.closeWindow === 'function') {
            WM.closeWindow(windowId);
          }
        } catch (closeErr) {
          console.error('[NovaSecurityAPI] closeWindow also failed:', closeErr);
          // Nuclear option: remove the DOM element directly
          try {
            const el = document.querySelector(`[data-window-id="${CSS.escape(windowId)}"]`);
            if (el) el.remove();
          } catch (_) {}
        }
      }

      // Surface a visible error notification so the user knows why
      try {
        if (window.Notify && typeof Notify.show === 'function') {
          Notify.show({
            title:   'Security Check Failed',
            body:    reason,
            type:    'error',
            appName: 'Security',
          });
        }
      } catch (_) {}
    },

    // ── Enforcement entry point ───────────────────────────────────────────────

    /**
     * Check whether the given app is allowed to run on this OS patch level.
     * If blocked, injects the unskippable dialog into contentEl and schedules
     * the window to auto-close.
     *
     * FAIL-CLOSED: any exception during the check or dialog immediately
     * force-closes the window. The app never slips through on an error.
     *
     * @param {string}      windowId  - WM window ID
     * @param {object}      app       - getOS().apps[appId] (manifest + init fn)
     * @param {HTMLElement} contentEl - The .window-content element
     * @returns {boolean} true = compliant (app runs normally), false = blocked
     */
    enforce(windowId, app, contentEl) {
      try {
        const req = this._resolveRequirement(app);
        if (!req) return true;                            // no requirement
        if (this.meetsRequirement(req.date)) return true; // compliant

        // Blocked — show dialog, but also fail-safe if dialog itself throws
        try {
          this._showBlockingDialog(windowId, app, contentEl, req);
        } catch (dialogErr) {
          // Dialog failed to render — still must NOT let the app run
          this._forceClose(
            windowId,
            `Security block dialog failed to render for "${app.name || windowId}". App closed as a precaution.`,
            dialogErr,
          );
        }
        return false;

      } catch (err) {
        // The requirement check itself threw — fail closed, never open
        this._forceClose(
          windowId,
          `Security check threw an unexpected error for "${(app && app.name) || windowId}". App closed as a precaution.`,
          err,
        );
        return false;
      }
    },

    // ── Blocking dialog ───────────────────────────────────────────────────────

    _showBlockingDialog(windowId, app, contentEl, req) {
      const currentDate  = this.getCurrentPatchDate();
      const requiredDate = parseDate(req.date);
      const currentStr   = formatDate(currentDate);
      const requiredStr  = formatDate(requiredDate);
      const appName      = escHtml(app.name || 'This app');

      // ── Compute how far behind the patch is ──────────────────────────────
      const msPerDay  = 864e5;
      const daysLate  = Math.round((requiredDate - currentDate) / msPerDay);
      const monthsLate = Math.floor(daysLate / 30);
      const lagLabel  = monthsLate >= 2
        ? `${monthsLate} months behind`
        : daysLate === 1
          ? '1 day behind'
          : `${daysLate} days behind`;

      // ── Helper: close this window cleanly ────────────────────────────────
      const closeApp = () => {
        overlay.style.transition = 'opacity 0.18s ease';
        overlay.style.opacity = '0';
        setTimeout(() => {
          try {
            if (window.WM && typeof WM.closeWindow === 'function') WM.closeWindow(windowId);
          } catch (_) {}
          try { overlay.remove(); } catch (_) {}
        }, 180);
      };

      // ── Helper: open Settings → Updates ──────────────────────────────────
      const openUpdates = () => {
        try {
          if (window.WM && typeof WM.createWindow === 'function') {
            // If Settings is already open, focus it and navigate to Updates
            const existing = document.querySelector('[data-app-id="nook"]');
            if (existing) {
              try {
                const wid = existing.dataset.windowId;
                if (wid && typeof WM.focusWindow === 'function') WM.focusWindow(wid);
                else if (wid && typeof WM.restoreWindow === 'function') WM.restoreWindow(wid);
              } catch (_) {}
              // Click the Updates sidebar button in the existing window
              try {
                const btns = existing.querySelectorAll('.nook-section-btn');
                for (const btn of btns) {
                  if (btn.textContent.trim().toLowerCase().includes('update')) {
                    btn.click(); break;
                  }
                }
              } catch (_) {}
            } else {
              // Open Settings directly on the Updates tab (nook now reads options.section)
              WM.createWindow('nook', { section: 'updates' });
            }
          }
        } catch (_) {}

        // Close the blocked app after a short delay
        setTimeout(closeApp, 280);
      };

      // ── Inject scoped styles (once per page load) ─────────────────────────
      if (!document.getElementById('nsec-api-styles')) {
        const style = document.createElement('style');
        style.id = 'nsec-api-styles';
        style.textContent = `
/* ── NovaByte Security Block Overlay ─────────────────────────────────────── */

/* Backdrop */
.nsec-overlay {
  position: absolute; inset: 0; z-index: 99999;
  display: flex; align-items: center; justify-content: center;
  background: rgba(4, 6, 14, 0.88);
  backdrop-filter: blur(22px) saturate(180%);
  -webkit-backdrop-filter: blur(22px) saturate(180%);
  pointer-events: all;
  animation: nsec-fade-in 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94) both;
  border-radius: inherit;
  overflow: hidden;
}
@keyframes nsec-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

/* Card */
.nsec-dialog {
  display: flex; flex-direction: column;
  background: linear-gradient(160deg, rgba(18, 22, 36, 0.98) 0%, rgba(10, 13, 22, 0.98) 100%);
  border: 1px solid rgba(248, 81, 73, 0.28);
  border-radius: 20px;
  box-shadow:
    0 0 0 1px rgba(248, 81, 73, 0.08),
    0 32px 72px rgba(0, 0, 0, 0.72),
    0 8px 24px rgba(248, 81, 73, 0.06),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
  max-width: 440px; width: calc(100% - 40px);
  overflow: hidden;
  animation: nsec-rise 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.12) both;
}
@keyframes nsec-rise {
  from { opacity: 0; transform: translateY(20px) scale(0.97); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

/* Shimmer header bar */
.nsec-header-bar {
  height: 3px; width: 100%;
  background: linear-gradient(90deg, #c0392b, #f85149, #ff8a80, #f85149, #c0392b);
  background-size: 300% 100%;
  animation: nsec-shimmer 3s linear infinite;
}
@keyframes nsec-shimmer {
  0%   { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}

/* Header section */
.nsec-header {
  display: flex; align-items: flex-start; gap: 16px;
  padding: 24px 24px 0;
}
.nsec-icon-wrap {
  flex-shrink: 0;
  width: 52px; height: 52px; border-radius: 14px;
  background: linear-gradient(135deg, rgba(248,81,73,0.18) 0%, rgba(200,40,40,0.08) 100%);
  border: 1px solid rgba(248, 81, 73, 0.25);
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 0 20px rgba(248,81,73,0.12), inset 0 1px 0 rgba(255,255,255,0.08);
  animation: nsec-icon-pulse 2.8s ease-in-out infinite;
}
@keyframes nsec-icon-pulse {
  0%, 100% { box-shadow: 0 0 20px rgba(248,81,73,0.12), inset 0 1px 0 rgba(255,255,255,0.08); }
  50%       { box-shadow: 0 0 32px rgba(248,81,73,0.28), inset 0 1px 0 rgba(255,255,255,0.08); }
}
.nsec-icon-wrap svg { color: #f85149; filter: drop-shadow(0 0 6px rgba(248,81,73,0.6)); }
.nsec-header-text { flex: 1; padding-top: 2px; }
.nsec-title {
  font-family: var(--font-ui, system-ui, sans-serif);
  font-size: 16px; font-weight: 800; letter-spacing: -0.02em;
  color: #f0f6fc; margin: 0 0 5px;
}
.nsec-subtitle {
  font-family: var(--font-ui, system-ui, sans-serif);
  font-size: 12.5px; color: #8b949e; line-height: 1.5; margin: 0;
}
.nsec-subtitle strong { color: #cdd9e5; font-weight: 600; }
.nsec-subtitle code {
  font-family: var(--font-mono, monospace);
  font-size: 11px; background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.1); border-radius: 4px;
  padding: 1px 5px; color: #e6edf3;
}

/* Divider */
.nsec-divider {
  height: 1px; margin: 20px 24px 0;
  background: linear-gradient(90deg, transparent, rgba(248,81,73,0.2), rgba(255,255,255,0.06), transparent);
}

/* Patch comparison card */
.nsec-patch-card {
  margin: 16px 24px 0;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 12px; overflow: hidden;
}
.nsec-patch-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 14px;
  font-family: var(--font-ui, system-ui, sans-serif); font-size: 12px;
}
.nsec-patch-row + .nsec-patch-row { border-top: 1px solid rgba(255,255,255,0.05); }
.nsec-patch-row-gap {
  border-top: 1px solid rgba(255,255,255,0.05);
  background: rgba(248,81,73,0.04);
}
.nsec-patch-label { color: #6e7681; }
.nsec-badge-danger {
  font-weight: 700; font-size: 11.5px;
  color: #f85149;
  background: rgba(248,81,73,0.12);
  border: 1px solid rgba(248,81,73,0.22);
  border-radius: 20px; padding: 2px 10px;
}
.nsec-badge-ok {
  font-weight: 700; font-size: 11.5px;
  color: #3fb950;
  background: rgba(63,185,80,0.1);
  border: 1px solid rgba(63,185,80,0.22);
  border-radius: 20px; padding: 2px 10px;
}
.nsec-badge-gap {
  font-weight: 700; font-size: 11.5px;
  color: #e3b341;
  background: rgba(227,179,65,0.1);
  border: 1px solid rgba(227,179,65,0.22);
  border-radius: 20px; padding: 2px 10px;
  display: flex; align-items: center; gap: 5px;
}
.nsec-badge-gap::before {
  content: '';
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: #e3b341;
  box-shadow: 0 0 6px rgba(227,179,65,0.7);
}

/* What this means section */
.nsec-info-box {
  margin: 14px 24px 0;
  background: rgba(248,81,73,0.04);
  border: 1px solid rgba(248,81,73,0.12);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex; gap: 10px; align-items: flex-start;
}
.nsec-info-icon { flex-shrink: 0; color: #f85149; margin-top: 1px; }
.nsec-info-text {
  font-family: var(--font-ui, system-ui, sans-serif);
  font-size: 12px; color: #8b949e; line-height: 1.55; margin: 0;
}
.nsec-info-text strong { color: #cdd9e5; }

/* Action buttons */
.nsec-actions {
  display: flex; gap: 10px;
  padding: 20px 24px 22px;
}
.nsec-btn {
  flex: 1; border: none; border-radius: 10px;
  font-family: var(--font-ui, system-ui, sans-serif);
  font-size: 13px; font-weight: 600;
  padding: 10px 16px; cursor: pointer;
  transition: transform 0.1s ease, opacity 0.15s ease, box-shadow 0.15s ease;
  display: flex; align-items: center; justify-content: center; gap: 7px;
  letter-spacing: -0.01em;
}
.nsec-btn:active { transform: scale(0.97); }
.nsec-btn-cancel {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  color: #8b949e;
}
.nsec-btn-cancel:hover { background: rgba(255,255,255,0.09); color: #cdd9e5; }
.nsec-btn-update {
  background: linear-gradient(135deg, #f85149 0%, #d73a34 100%);
  border: 1px solid rgba(255,255,255,0.12);
  color: #fff;
  box-shadow: 0 4px 14px rgba(248,81,73,0.35), inset 0 1px 0 rgba(255,255,255,0.15);
}
.nsec-btn-update:hover {
  box-shadow: 0 6px 20px rgba(248,81,73,0.5), inset 0 1px 0 rgba(255,255,255,0.15);
  opacity: 0.92;
}
.nsec-btn svg { flex-shrink: 0; }

/* See why link */
.nsec-why-link {
  background: none; border: none; padding: 0; margin: 0;
  font-family: inherit; font-size: inherit;
  color: #58a6ff; cursor: pointer;
  text-decoration: underline; text-underline-offset: 2px;
  transition: color 0.15s ease, opacity 0.15s ease;
  display: inline;
}
.nsec-why-link:hover { color: #79c0ff; opacity: 0.9; }
.nsec-why-link:active { opacity: 0.7; }

/* ── End NovaByte Security Block Overlay ──────────────────────────────────── */
        `;
        document.head.appendChild(style);
      }

      // ── Build overlay DOM ─────────────────────────────────────────────────
      const overlay = document.createElement('div');
      overlay.className = 'nsec-overlay';
      overlay.setAttribute('role', 'alertdialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'Security patch required — ' + (app.name || 'App'));

      // Block all interaction with the app UNDERNEATH the overlay.
      // We check that the event originates from outside the dialog card —
      // clicks on the buttons or dialog content must pass through normally.
      const _blockIfOutside = (e) => {
        if (!e.target.closest('.nsec-dialog')) e.stopPropagation();
      };
      overlay.addEventListener('pointerdown', _blockIfOutside, true);
      overlay.addEventListener('pointerup',   _blockIfOutside, true);
      overlay.addEventListener('click',       _blockIfOutside, true);
      overlay.addEventListener('keydown',     _blockIfOutside, true);
      overlay.addEventListener('contextmenu', (e) => {
        if (!e.target.closest('.nsec-dialog')) { e.preventDefault(); e.stopPropagation(); }
      }, true);

      overlay.innerHTML = `
        <div class="nsec-dialog" role="document">

          <!-- Shimmer accent bar -->
          <div class="nsec-header-bar" aria-hidden="true"></div>

          <!-- Header: icon + title + subtitle -->
          <div class="nsec-header">
            <div class="nsec-icon-wrap" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="1.75"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                <line x1="12" y1="8"  x2="12"   y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <div class="nsec-header-text">
              <h2 class="nsec-title">Security Patch Required</h2>
              <p class="nsec-subtitle">${req.reason} <button class="nsec-why-link" aria-label="See why this is required">See why.</button></p>
            </div>
          </div>

          <!-- Soft divider -->
          <div class="nsec-divider" aria-hidden="true"></div>

          <!-- Patch version comparison table -->
          <div class="nsec-patch-card" role="table" aria-label="Patch version comparison">
            <div class="nsec-patch-row" role="row">
              <span class="nsec-patch-label" role="cell">Your patch level</span>
              <span class="nsec-badge-danger" role="cell" aria-label="Current: ${escHtml(currentStr)}">${escHtml(currentStr)}</span>
            </div>
            <div class="nsec-patch-row" role="row">
              <span class="nsec-patch-label" role="cell">Minimum required</span>
              <span class="nsec-badge-ok" role="cell" aria-label="Required: ${escHtml(requiredStr)}">${escHtml(requiredStr)}</span>
            </div>
            <div class="nsec-patch-row nsec-patch-row-gap" role="row">
              <span class="nsec-patch-label" role="cell">How far behind</span>
              <span class="nsec-badge-gap" role="cell" aria-label="${escHtml(lagLabel)}">${escHtml(lagLabel)}</span>
            </div>
          </div>

          <!-- Explanation box -->
          <div class="nsec-info-box" role="note">
            <svg class="nsec-info-icon" width="15" height="15" viewBox="0 0 24 24"
                 fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <p class="nsec-info-text">
              <strong>${appName}</strong> handles sensitive data and requires a NovaByte OS security
              patch dated <strong>${escHtml(requiredStr)}</strong> or later to run safely.
              Install the latest update, then relaunch the app.
            </p>
          </div>

          <!-- Action buttons -->
          <div class="nsec-actions">
            <button class="nsec-btn nsec-btn-cancel" aria-label="Close app without updating">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2.2"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6"  y1="6" x2="18" y2="18"/>
              </svg>
              Close App
            </button>
            <button class="nsec-btn nsec-btn-update" aria-label="Open Settings to install update">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2.2"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              Go to Updates
            </button>
          </div>

        </div>
      `;

      // ── Mount overlay ─────────────────────────────────────────────────────
      const prevPos = contentEl.style.position;
      if (!prevPos || prevPos === 'static') contentEl.style.position = 'relative';
      contentEl.appendChild(overlay);

      // ── Wire up buttons ───────────────────────────────────────────────────
      const cancelBtn = overlay.querySelector('.nsec-btn-cancel');
      const updateBtn = overlay.querySelector('.nsec-btn-update');
      const whyBtn    = overlay.querySelector('.nsec-why-link');

      if (cancelBtn) cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeApp();
      });

      if (updateBtn) updateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openUpdates();
      });

      if (whyBtn) whyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        NovaSecurityAPI._showWhyWindow(app, req, currentStr, requiredStr, lagLabel);
      });

      // Show OS notification as well
      try {
        if (window.Notify && typeof Notify.show === 'function') {
          Notify.show({
            title:   'Security Update Required',
            body:    `${app.name || 'An app'} needs a newer OS patch (${req.date}) to run. Your patch: ${this.getCurrentPatchString()}.`,
            type:    'error',
            appName: 'Security',
          });
        }
      } catch (_) {}
    },

    // ── "See why" explanation window ──────────────────────────────────────────

    _showWhyWindow(app, req, currentStr, requiredStr, lagLabel) {
      const appName   = escHtml(app.name || 'This app');
      const reqDate   = escHtml(requiredStr);
      const curDate   = escHtml(currentStr);
      const lag       = escHtml(lagLabel);
      const reqRaw    = escHtml(req.date);

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Why is a security patch required?</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--font-ui, system-ui, -apple-system, sans-serif);
    background: var(--bg-base, #0d1117);
    color: var(--text-primary, #e6edf3);
    padding: 32px 28px 48px;
    line-height: 1.6;
    font-size: 13.5px;
    max-width: 560px;
    margin: 0 auto;
  }

  /* Header */
  .why-hero {
    display: flex; align-items: center; gap: 14px;
    margin-bottom: 24px;
  }
  .why-icon {
    width: 44px; height: 44px; border-radius: 12px; flex-shrink: 0;
    background: linear-gradient(135deg, rgba(248,81,73,0.18), rgba(200,40,40,0.08));
    border: 1px solid rgba(248,81,73,0.25);
    display: flex; align-items: center; justify-content: center;
    color: #f85149;
  }
  .why-hero h1 {
    font-size: 18px; font-weight: 800; letter-spacing: -0.02em;
    color: #f0f6fc; line-height: 1.2;
  }
  .why-hero p { font-size: 12px; color: #6e7681; margin-top: 3px; }

  /* Stat cards */
  .why-stats {
    display: grid; grid-template-columns: 1fr 1fr 1fr;
    gap: 10px; margin-bottom: 24px;
  }
  .why-stat {
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 12px; padding: 14px 12px;
    text-align: center;
  }
  .why-stat-value {
    font-size: 13px; font-weight: 700; margin-bottom: 4px;
  }
  .why-stat-label { font-size: 11px; color: #6e7681; }
  .danger  { color: #f85149; }
  .success { color: #3fb950; }
  .warning { color: #e3b341; }

  /* Section */
  .why-section { margin-bottom: 20px; }
  .why-section h2 {
    font-size: 12px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: #6e7681;
    margin-bottom: 10px; padding-bottom: 6px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
  }

  /* Reason block */
  .why-reason-box {
    background: rgba(248,81,73,0.05);
    border: 1px solid rgba(248,81,73,0.15);
    border-radius: 10px; padding: 14px 16px;
    font-size: 13px; color: #cdd9e5;
  }
  .why-reason-box strong { color: #f0f6fc; }
  .why-reason-box code {
    font-family: var(--font-mono, monospace);
    font-size: 11.5px; background: rgba(255,255,255,0.07);
    border: 1px solid rgba(255,255,255,0.1); border-radius: 4px;
    padding: 1px 5px;
  }

  /* Risk list */
  .why-risks { display: flex; flex-direction: column; gap: 8px; }
  .why-risk {
    display: flex; align-items: flex-start; gap: 10px;
    background: rgba(255,255,255,0.02);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 10px; padding: 11px 13px;
  }
  .why-risk-icon {
    width: 26px; height: 26px; border-radius: 7px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 13px;
  }
  .why-risk-icon.red   { background: rgba(248,81,73,0.12);  color: #f85149; }
  .why-risk-icon.amber { background: rgba(227,179,65,0.12); color: #e3b341; }
  .why-risk-icon.blue  { background: rgba(88,166,255,0.12); color: #58a6ff; }
  .why-risk-body { flex: 1; }
  .why-risk-title { font-size: 12.5px; font-weight: 600; color: #cdd9e5; margin-bottom: 2px; }
  .why-risk-desc  { font-size: 12px; color: #6e7681; line-height: 1.5; }

  /* Steps */
  .why-steps { display: flex; flex-direction: column; gap: 6px; counter-reset: step; }
  .why-step {
    display: flex; align-items: flex-start; gap: 12px;
    padding: 10px 12px;
    background: rgba(255,255,255,0.02);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 10px;
    counter-increment: step;
  }
  .why-step-num {
    width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0;
    background: rgba(88,166,255,0.12); border: 1px solid rgba(88,166,255,0.2);
    color: #58a6ff; font-size: 11px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    margin-top: 1px;
  }
  .why-step-body { flex: 1; font-size: 12.5px; color: #cdd9e5; line-height: 1.5; }
  .why-step-body strong { color: #f0f6fc; }
  .why-step-body kbd {
    font-family: var(--font-mono, monospace);
    font-size: 11px; background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.12); border-radius: 4px;
    padding: 1px 6px; color: #e6edf3;
  }

  /* Footer note */
  .why-footer {
    margin-top: 28px; padding: 12px 14px;
    background: rgba(88,166,255,0.05);
    border: 1px solid rgba(88,166,255,0.12);
    border-radius: 10px;
    font-size: 11.5px; color: #6e7681; line-height: 1.55;
  }
  .why-footer strong { color: #8b949e; }
</style>
</head>
<body>

  <!-- Hero -->
  <div class="why-hero">
    <div class="why-icon">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="1.75"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
    </div>
    <div>
      <h1>Why is a security patch required?</h1>
      <p>NovaByte OS Security Policy &nbsp;·&nbsp; ${appName}</p>
    </div>
  </div>

  <!-- Stats -->
  <div class="why-stats">
    <div class="why-stat">
      <div class="why-stat-value danger">${curDate}</div>
      <div class="why-stat-label">Your patch level</div>
    </div>
    <div class="why-stat">
      <div class="why-stat-value success">${reqDate}</div>
      <div class="why-stat-label">Minimum required</div>
    </div>
    <div class="why-stat">
      <div class="why-stat-value warning">${lag}</div>
      <div class="why-stat-label">How far behind</div>
    </div>
  </div>

  <!-- Why this app needs it -->
  <div class="why-section">
    <h2>Why does this app require it?</h2>
    <div class="why-reason-box">${req.reason}</div>
  </div>

  <!-- Risks of running on an old patch -->
  <div class="why-section">
    <h2>What are the risks of an outdated patch?</h2>
    <div class="why-risks">
      <div class="why-risk">
        <div class="why-risk-icon red">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        </div>
        <div class="why-risk-body">
          <div class="why-risk-title">Encryption vulnerabilities</div>
          <div class="why-risk-desc">Older patches may contain unresolved flaws in the cryptographic APIs used to encrypt and decrypt your stored data, potentially exposing it to local attacks.</div>
        </div>
      </div>
      <div class="why-risk">
        <div class="why-risk-icon red">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <div class="why-risk-body">
          <div class="why-risk-title">Sandbox escape risk</div>
          <div class="why-risk-desc">Unpatched versions of NovaByte OS may allow a malicious app to break out of its iframe sandbox and access data belonging to other apps, including password vaults.</div>
        </div>
      </div>
      <div class="why-risk">
        <div class="why-risk-icon amber">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <div class="why-risk-body">
          <div class="why-risk-title">Credential storage exploits</div>
          <div class="why-risk-desc">Security patches issued after ${curDate} include fixes for known vulnerabilities in the Web Crypto and storage APIs that apps like ${appName} depend on to protect credentials.</div>
        </div>
      </div>
      <div class="why-risk">
        <div class="why-risk-icon blue">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
        <div class="why-risk-body">
          <div class="why-risk-title">This is a policy requirement</div>
          <div class="why-risk-desc">Beyond technical risk, ${appName} explicitly declares <code>minSecurityPatch: ${reqRaw}</code> in its manifest. NovaByte OS enforces this declaration for all apps that handle sensitive permissions or data.</div>
        </div>
      </div>
    </div>
  </div>

  <!-- How to fix -->
  <div class="why-section">
    <h2>How do I fix this?</h2>
    <div class="why-steps">
      <div class="why-step">
        <div class="why-step-num">1</div>
        <div class="why-step-body">Close this window and click <strong>Go to Updates</strong> on the security dialog — or open <strong>Settings</strong> from the taskbar.</div>
      </div>
      <div class="why-step">
        <div class="why-step-num">2</div>
        <div class="why-step-body">Navigate to the <strong>Updates</strong> tab. NovaByte OS will check for available security patches automatically.</div>
      </div>
      <div class="why-step">
        <div class="why-step-num">3</div>
        <div class="why-step-body">Install any update dated <strong>${reqDate} or later</strong>. The OS will restart to apply the patch.</div>
      </div>
      <div class="why-step">
        <div class="why-step-num">4</div>
        <div class="why-step-body">Relaunch <strong>${appName}</strong>. The security check will pass and the app will open normally.</div>
      </div>
    </div>
  </div>

  <div class="why-footer">
    <strong>NovaByte OS Security Policy</strong> — Apps that declare a <code>minSecurityPatch</code>
    in their manifest are automatically blocked by the OS if the installed patch level does not meet
    the requirement. This cannot be overridden by the user. The requirement for this app is
    <strong>${reqDate}</strong>.
  </div>

</body>
</html>`;

      // Open a plain OS window with no app — just inject the HTML directly
      try {
        if (window.WM && typeof WM.createWindow === 'function') {
          const whyWin = WM.createWindow('__nsec_why__', {
            title:       'Why is a security patch required?',
            width:       580,
            height:      580,
            resizable:   true,
            icon:        null,
            noAppEntry:  true,
          });

          if (whyWin) {
            // Find the content area and inject HTML via srcdoc on a fresh iframe
            const content = whyWin.querySelector('.window-content') || whyWin;
            content.style.padding = '0';
            content.style.overflow = 'hidden';

            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'width:100%;height:100%;border:none;background:#0d1117;';
            iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts');
            iframe.srcdoc = html;
            content.innerHTML = '';
            content.appendChild(iframe);
            return;
          }
        }
      } catch (_) {}

      // Fallback: open in a plain new browser window
      try {
        const blob = new Blob([html], { type: 'text/html' });
        const url  = URL.createObjectURL(blob);
        window.open(url, '_blank', 'width=600,height=620,noopener');
        setTimeout(() => URL.revokeObjectURL(url), 5000);
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
              const app      = (window.OS && getOS().apps && getOS().apps[appId]) || {
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

    // 2. Seed window.OS.securityPatch from localStorage (written by update-service)
    //    or keep the value already set in index.html at boot.
    //    If window.OS isn't available yet (very early call), retry via rAF so we
    //    never silently leave securityPatch unset and fall back to epoch.
    const _seedPatch = () => {
      const os = getOS();
      if (!os) {
        // OS object not ready — retry on next animation frame (runs after boot script)
        requestAnimationFrame(_seedPatch);
        return;
      }
      try {
        const stored = localStorage.getItem('nova_security_patch_date');
        // Priority: index.html value → localStorage → null (never overwrite with null)
        if (!os.securityPatch) {
          os.securityPatch = stored || OS_PATCH_DATE;
        }
      } catch (_) {
        // localStorage unavailable — keep whatever index.html set
      }
    };
    _seedPatch();

    // 3. Patch WM.createWindow to inject security enforcement after app.init()
    if (window.WM && typeof WM.createWindow === 'function') {
      const _original = WM.createWindow.bind(WM);

      WM.createWindow = function (appId, options) {
        const winEl = _original(appId, options);

        // winEl may be null (e.g. GPO blocked, app not found)
        if (!winEl) return winEl;

        // Resolve window state & app — guard: OS may not be ready yet on early calls
        try {
          const _os = getOS();
          if (!_os) return winEl;                     // OS not yet initialised
          const app = _os.apps && _os.apps[appId];
          if (!app) return winEl;

          // The window ID is on the returned element's dataset
          const windowId = winEl.dataset && winEl.dataset.windowId;
          if (!windowId) return winEl;

          const contentEl = winEl.querySelector('.window-content');
          if (!contentEl) return winEl;

          // Run enforcement — FAIL-CLOSED: any unhandled error kills the window
          NovaSecurityAPI.enforce(windowId, app, contentEl);
        } catch (pipelineErr) {
          // Something outside enforce() threw (bad app object, missing DOM, etc.).
          // Fail closed — force-kill the window and surface the reason.
          const wid = (winEl.dataset && winEl.dataset.windowId) || null;
          NovaSecurityAPI._forceClose(
            wid,
            `Security pipeline error: ${(pipelineErr && pipelineErr.message) || pipelineErr}. App closed as a precaution.`,
            pipelineErr,
          );
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