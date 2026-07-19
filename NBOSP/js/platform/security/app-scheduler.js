/**
 * AppScheduler — Tier 1 background execution (system:background).
 *
 * This is the "scheduled wake" tier from the permission design doc: an app
 * holding system:background doesn't need to be open, or ever have been
 * opened, for it to periodically run and do work (check state, sync data,
 * update its own storage). It is explicitly NOT a way to send notifications
 * — that still requires device:notifications separately, same as every
 * other capability in this permission model. It is also NOT "stay alive
 * indefinitely" — that's Tier 2 (system:background:live, see
 * AppSandbox.detachToBackground). A Tier-1 wake is brief and bounded: spin
 * the app's sandbox up headlessly, give it a short window to do work, tear
 * it down again.
 *
 * How a wake cycle works:
 *  1. Every WAKE_INTERVAL_MS, sweep every installed, non-disabled app that
 *     holds system:background.
 *  2. If the app already has a live Tier-2 sandbox sitting in
 *     #background-app-host, reuse it — no need to spin up a second
 *     instance of the same app. Otherwise, launch a fresh headless sandbox
 *     into the same hidden host.
 *  3. Dispatch a nova:background:wake push (AppSandbox.dispatchBackgroundWake)
 *     into the sandbox. The app's JS receives this via
 *     nova.onBackgroundWake(callback) (see the capability shim in
 *     app-sandbox.js) and can call nova.ipc('nova:background:wake-done', {})
 *     — or the sugar form nova.backgroundWakeDone() — to signal it's done
 *     early.
 *  4. Give the app up to WAKE_DEADLINE_MS. If it signals done first, or the
 *     deadline passes first, tear the sandbox down (unless it was a
 *     pre-existing Tier-2 sandbox, which is left alone — Tier 1 doesn't get
 *     to kill a Tier-2 process just because its wake window ended).
 *
 * This module has no UI and holds no persistent state beyond in-memory
 * timers — a browser refresh naturally clears all of it, which is correct:
 * scheduled wakes resume from boot.js calling AppScheduler.start().
 */
const AppScheduler = (() => {
  'use strict';

  // Real OS schedulers use similarly coarse intervals for periodic
  // background work (Android's minimum periodic WorkManager interval is
  // 15 minutes) — matching that cadence here rather than inventing a
  // tighter one that would make "background" indistinguishable from
  // "always running", which is exactly the distinction Tier 1 vs Tier 2
  // exists to preserve.
  const WAKE_INTERVAL_MS = 15 * 60 * 1000;

  // How long a single wake gets to run before being torn down regardless
  // of whether it called wake-done. Bounded and short — this is meant for
  // "check something, update local state," not sustained work.
  const WAKE_DEADLINE_MS = 10 * 1000;

  // sandboxId -> { timeoutId, appId, ownedByScheduler }
  // ownedByScheduler distinguishes "this scheduler launched and must tear
  // down this sandbox" from "this is someone else's Tier-2 sandbox that
  // the scheduler is just borrowing for a wake push."
  const pendingWakes = new Map();

  let intervalId = null;
  let running = false;

  function log(level, msg, data) {
    if (typeof window !== 'undefined' && window.EventLog) {
      EventLog.log({ app: 'AppScheduler', category: 'system', severity: level === 'warn' ? 'warn' : 'info', message: msg, data });
    }
  }

  /**
   * Every app eligible for a Tier-1 wake right now: installed, not
   * disabled, and actually holding the system:background grant. Mirrors
   * the same three-part eligibility check boot.js uses for autostart
   * (installed && !disabled && grant held) — deliberately consistent
   * rather than inventing a slightly different rule here.
   * @returns {object[]} app objects from OS.apps
   */
  function getEligibleApps() {
    if (typeof OS === 'undefined' || !OS.apps) return [];

    let disabled = [];
    try {
      disabled = JSON.parse(localStorage.getItem('nova_disabled_apps') || '[]');
    } catch { /* corrupt value, treat as none disabled */ }

    return Object.values(OS.apps).filter(app => {
      if (!app || !app.id) return false;
      if (disabled.includes(app.id)) return false;
      if (typeof AppPermissionManager === 'undefined') return false;
      return AppPermissionManager.isGranted('system:background', app.id);
    });
  }

  /**
   * Find an already-live sandbox for this app sitting in the background
   * host (i.e. a Tier-2 system:background:live instance). Tier 1 should
   * reuse it rather than launching a redundant second sandbox for the
   * same app.
   * @param {string} appId
   * @returns {object|null} sandbox info from AppSandbox.getAllSandboxes()
   */
  function findLiveBackgroundSandbox(appId) {
    if (typeof AppSandbox === 'undefined') return null;
    return AppSandbox.getAllSandboxes()
      .find(s => s.appId === appId && s.backgrounded) || null;
  }

  /**
   * Run one wake cycle for a single app: get or create its sandbox,
   * dispatch the wake push, and schedule teardown.
   * @param {object} app
   */
  function wake(app) {
    if (typeof AppSandbox === 'undefined') return;

    const existing = findLiveBackgroundSandbox(app.id);
    let sandboxId;
    let ownedByScheduler;

    if (existing) {
      // Already alive for Tier 2 reasons — just piggyback the wake push,
      // don't touch its lifecycle. Tier 1 didn't create it and doesn't
      // get to destroy it.
      sandboxId = existing.sandboxId;
      ownedByScheduler = false;
    } else {
      const host = document.getElementById('background-app-host');
      if (!host) {
        log('warn', `AppScheduler: no #background-app-host, skipping wake for ${app.id}`);
        return;
      }
      // A fresh headless launch: no window state, into the same hidden
      // host Tier 2 uses. loadAppContent inside launch() is async and
      // fire-and-forget — the wake push below can race ahead of the
      // app's own page load finishing, same as it would for a real user
      // opening the app quickly and the OS sending an early IPC call.
      // That's an acceptable, pre-existing characteristic of this IPC
      // model, not something Tier 1 introduces.
      const wrapperHost = document.createElement('div');
      wrapperHost.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;pointer-events:none;';
      host.appendChild(wrapperHost);

      const result = AppSandbox.launch(app, wrapperHost, null, {});
      if (!result || !result.success) {
        log('warn', `AppScheduler: launch failed for ${app.id}, skipping wake`);
        wrapperHost.remove();
        return;
      }
      sandboxId = result.sandboxId;
      ownedByScheduler = true;
    }

    if (pendingWakes.has(sandboxId)) {
      // Already mid-wake (e.g. two intervals overlapped for a slow app) —
      // don't double-dispatch or double-schedule teardown.
      return;
    }

    const dispatched = AppSandbox.dispatchBackgroundWake(sandboxId, {
      wokeAt: new Date().toISOString(),
      deadlineMs: WAKE_DEADLINE_MS,
    });
    if (!dispatched) {
      log('warn', `AppScheduler: dispatch failed for ${app.id} (sandbox ${sandboxId})`);
      if (ownedByScheduler) endWake(sandboxId);
      return;
    }

    const timeoutId = setTimeout(() => endWake(sandboxId), WAKE_DEADLINE_MS);
    pendingWakes.set(sandboxId, { timeoutId, appId: app.id, ownedByScheduler });

    log('info', `AppScheduler: woke ${app.id}`, { sandboxId, ownedByScheduler });
  }

  /**
   * End a wake cycle for a sandbox — called either when the deadline
   * timer fires, or early via _markWakeDone(). Only actually tears down
   * the sandbox if the scheduler was the one that created it; a
   * piggybacked Tier-2 sandbox is left running.
   * @param {string} sandboxId
   */
  function endWake(sandboxId) {
    const pending = pendingWakes.get(sandboxId);
    if (!pending) return;

    clearTimeout(pending.timeoutId);
    pendingWakes.delete(sandboxId);

    if (pending.ownedByScheduler && typeof AppSandbox !== 'undefined') {
      const sandbox = AppSandbox.getSandbox(sandboxId);
      const wrapper = sandbox?.webview?.parentNode;
      AppSandbox.destroy(sandboxId);
      // Clean up the 1x1 wrapper div created in wake() — destroy() removes
      // the sandbox's own listeners/state but doesn't know about (or own)
      // this wrapper element, since it's scheduler-created scaffolding,
      // not part of the sandbox itself.
      if (wrapper && wrapper.id !== 'background-app-host') {
        wrapper.remove();
      }
    }

    log('info', `AppScheduler: ended wake`, { sandboxId, ownedByScheduler: pending.ownedByScheduler });
  }

  /**
   * Called from AppSandbox.handleBackgroundWakeDone when an app signals
   * it's finished early via nova.backgroundWakeDone(). Internal — not
   * part of the intended public surface, hence the leading underscore,
   * but must be reachable from app-sandbox.js.
   * @param {string} sandboxId
   */
  function _markWakeDone(sandboxId) {
    endWake(sandboxId);
  }

  /**
   * Sweep every eligible app and wake each one. Exposed so it can also be
   * triggered manually (e.g. from a debug/inspector panel) without
   * waiting for the next interval tick.
   */
  function runWakeCycle() {
    const apps = getEligibleApps();
    for (const app of apps) {
      wake(app);
    }
  }

  /**
   * Start the periodic scheduler. Safe to call more than once — a second
   * call is a no-op rather than stacking duplicate intervals.
   */
  function start() {
    if (running) return;
    running = true;
    intervalId = setInterval(runWakeCycle, WAKE_INTERVAL_MS);
    log('info', 'AppScheduler started', { intervalMs: WAKE_INTERVAL_MS });
  }

  /**
   * Stop the periodic scheduler and cancel any in-flight wake deadlines.
   * Does not tear down live Tier-2 sandboxes (not the scheduler's to
   * manage) but does clean up any scheduler-owned sandbox mid-wake.
   */
  function stop() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    running = false;
    for (const sandboxId of [...pendingWakes.keys()]) {
      endWake(sandboxId);
    }
    log('info', 'AppScheduler stopped');
  }

  return {
    start,
    stop,
    runWakeCycle,
    getEligibleApps,

    // Internal — called from app-sandbox.js's wake-done IPC handler, and
    // by tests. Not covered by stability guarantees.
    _markWakeDone,
    _pendingWakes: pendingWakes,
  };
})();

window.AppScheduler = AppScheduler;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AppScheduler;
}
