'use strict';
/**
 * ui-init.js — wires up event listeners that were previously inline
 * event handler attributes (onclick, onerror) in index.html.
 *
 * Kept separate from app.js so server.js can add a nonce to it via the
 * same regex it uses for app.js.
 */
document.addEventListener('DOMContentLoaded', function () {

  // ── Recovery log clear button ────────────────────────────────────────────
  // Previously: onclick="document.getElementById('rec-diag-lines').innerHTML=''"
  var clearBtn = document.getElementById('recovery-log-clear-1016');
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      var el = document.getElementById('rec-diag-lines');
      if (el) el.innerHTML = '';
    });
  }

  // ── Tray icon image fallback ─────────────────────────────────────────────
  // Previously: onerror="this.style.visibility='hidden'"
  // IDs assigned to the img tags in index.html for stable targeting.
  ['tray-volume-img', 'tray-wifi-img', 'tray-bell-img'].forEach(function (id) {
    var img = document.getElementById(id);
    if (img) {
      img.addEventListener('error', function () {
        img.style.visibility = 'hidden';
      });
    }
  });

});
