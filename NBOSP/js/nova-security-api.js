/**
 * nova-security-api.js — Security Patch Utility Stubs
 *
 * These are lightweight utilities for developers building an update/patch system on NBOSP.
 * Wire recordPatch() into your update pipeline to track the current patch level.
 * 
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
  //  UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════

  function parseDate(str) {
    // Parse YYYY-MM-DD safely without timezone shifting
    const [y, m, d] = String(str).split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CORE API — UTILITY STUBS
  // ═══════════════════════════════════════════════════════════════════════════

  const NovaSecurityAPI = {

    version: '1.0.0',

    // ── Patch date accessors ─────────────────────────────────────────────────

    /** Return the ISO date string (YYYY-MM-DD) of the current OS patch. */
    getCurrentPatchString() {
      const os = getOS();
      if (os && os.securityPatch) return os.securityPatch;
      try {
        const stored = localStorage.getItem('nova_security_patch_date');
        if (stored) return stored;
      } catch (_) {}
      return '1970-01-01';
    },

    /**
     * Called by your update system after a successful OS patch to record the
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
      const current = parseDate(this.getCurrentPatchString());
      const required = parseDate(requiredDate);
      return current >= required;
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  EXPORT — Make available to global scope
  // ═══════════════════════════════════════════════════════════════════════════

  window.NovaSecurityAPI = NovaSecurityAPI;

})();
