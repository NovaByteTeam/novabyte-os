/**
 * Shell Popup Coordinator — one flyout at a time across shell surfaces.
 *
 * The shell has no central popup manager: every tray flyout (volume, wifi,
 * calendar, power menu), the notification panel and the taskbar window
 * preview each own their own open/close state, so two of them can easily
 * sit open at once (open the volume flyout, then click the clock — both
 * flyouts visible, stacked over the taskbar).
 *
 * Contract:
 *   register(id, closeFn)   — call right after a popup opens. closeFn runs
 *                              that popup's existing close path and is
 *                              responsible for unregistering the id once it
 *                              has actually closed it.
 *   unregister(id)          — call on every path that closes the popup
 *                              (outside click, toggle-off, close button).
 *   closeAllExcept(id)      — call right BEFORE opening a popup; invokes
 *                              every other registered closeFn.
 *
 * Every call site guards with optional chaining
 * (window.ShellPopupCoordinator?.closeAllExcept(...)) so a context without
 * this script (stripped-down service harnesses) degrades to the old
 * independent-popups behaviour instead of throwing.
 */
(() => {
  'use strict';

  // id -> closeFn for each currently-open shell popup surface.
  const popups = new Map();

  function register(id, closeFn) {
    if (typeof id !== 'string' || typeof closeFn !== 'function') return;
    popups.set(id, closeFn);
  }

  function unregister(id) {
    popups.delete(id);
  }

  // Invokes every registered closeFn except the popup about to open. The
  // Map is deliberately NOT mutated here: each closeFn unregisters its own
  // id on success, so a closeFn that declines to close (e.g. the volume
  // flyout while the user has pinned it) simply stays registered and is
  // retried by the next closeAllExcept instead of being silently dropped.
  // Map iteration tolerates this live mutation by specification.
  function closeAllExcept(id) {
    for (const [popupId, closeFn] of popups) {
      if (popupId === id) continue;
      try {
        closeFn();
      } catch (error) {
        console.error(`[ShellPopupCoordinator] Closing popup "${popupId}" failed`, error);
      }
    }
  }

  window.ShellPopupCoordinator = Object.freeze({ register, unregister, closeAllExcept });
})();
