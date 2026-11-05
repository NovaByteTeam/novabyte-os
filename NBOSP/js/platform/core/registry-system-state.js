/**
 * NovaByte — Registry System State
 *
 * The registry-backed home for the machine-scoped configuration that used to
 * live in ad-hoc localStorage keys inside platform services. This completes
 * the config-database story for everything the system itself owns: what is
 * installed, which permissions were granted, which background alarms and push
 * subscriptions exist, and how often the Store checks for updates.
 *
 *   HKNS/apps/installed                    — installed .novaapp metadata  (REG_JSON [])
 *   HKNS/security/appPermissions           — permission grant records     (REG_JSON [])
 *   HKNS/apps/alarms                       — background alarm registry    (REG_JSON)
 *   HKNS/apps/push                         — push tokens + replay queues  (REG_JSON)
 *   HKNS/apps/pushDeviceId                 — stable push device id        (REG_SZ)
 *   HKNS/apps/store/updateIntervalMinutes  — Store update check interval  (REG_DWORD)
 *
 * Every accessor reads and writes the NovaByte Registry when it is up and
 * silently falls back to the legacy localStorage channel when it is not —
 * callers get one API and never parse localStorage themselves again. The
 * first successful access adopts the legacy localStorage values into their
 * live paths exactly once (guarded by HKND/_migration/sysStateDone, with a
 * per-path absent check so an existing hive value is never clobbered), so an
 * upgrading install keeps every setting without a migration step.
 *
 * UMD: window.RegistrySystemState in the shell, module.exports in tests.
 */
(function () {
  'use strict';

  const MIGRATION_GUARD = 'HKND/_migration/sysStateDone';

  const PATHS = Object.freeze({
    installedApps: 'HKNS/apps/installed',
    appPermissions: 'HKNS/security/appPermissions',
    alarms: 'HKNS/apps/alarms',
    push: 'HKNS/apps/push',
    pushDeviceId: 'HKNS/apps/pushDeviceId',
    storeUpdateInterval: 'HKNS/apps/store/updateIntervalMinutes',
  });

  // The pre-registry localStorage keys, kept for one-time adoption and as
  // the fail-soft fallback when the registry engine is unavailable.
  const LEGACY_KEYS = Object.freeze({
    installedApps: 'nova_installed_apps',
    appPermissions: 'nova_app_permissions',
    alarms: 'nova_app_alarms',
    push: 'nova_app_push',
    pushDeviceId: 'nova_push_device_id',
    storeUpdateInterval: 'nova_store_update_interval_minutes',
  });

  function reg() {
    if (typeof window === 'undefined' || !window) return null;
    const r = window.NovaRegistry;
    return r && typeof r.get === 'function' ? r : null;
  }

  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* quota / private mode */ }
  }

  function readJson(key, fallback) {
    try {
      const parsed = JSON.parse(lsGet(key) || 'null');
      return parsed ?? fallback;
    } catch (_) { return fallback; }
  }

  let adopted = false;

  // One-time import of the legacy localStorage state into their live
  // registry paths. Idempotent; double-guarded by the in-session flag and
  // the HKND/_migration/sysStateDone value. A path that already exists in
  // the hive is never clobbered by its stale localStorage shadow.
  function ensureAdopted() {
    const r = reg();
    if (!r) return false;
    if (adopted) return true;
    try {
      if (r.stat(MIGRATION_GUARD) !== null) { adopted = true; return true; }
      const legacy = {
        [PATHS.installedApps]: readJson(LEGACY_KEYS.installedApps, null),
        [PATHS.appPermissions]: readJson(LEGACY_KEYS.appPermissions, null),
        [PATHS.alarms]: readJson(LEGACY_KEYS.alarms, null),
        [PATHS.push]: readJson(LEGACY_KEYS.push, null),
        [PATHS.pushDeviceId]: lsGet(LEGACY_KEYS.pushDeviceId),
        [PATHS.storeUpdateInterval]: readJson(LEGACY_KEYS.storeUpdateInterval, null),
      };
      r.batch(() => {
        for (const [path, value] of Object.entries(legacy)) {
          if (value === null || value === undefined) continue;
          if (r.stat(path) !== null) continue;
          const type = path === PATHS.storeUpdateInterval
            ? 'REG_DWORD'
            : path === PATHS.pushDeviceId ? 'REG_SZ' : 'REG_JSON';
          r.set(path, value, { type, source: 'sysstate-import' });
        }
        r.set(MIGRATION_GUARD, Date.now(), { type: 'REG_QWORD', source: 'sysstate-import' });
      });
      adopted = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  function readState(path, legacyFallback) {
    const r = reg();
    if (r && ensureAdopted()) {
      try {
        const value = r.get(path);
        if (value !== undefined) return value;
      } catch (_) { /* fall through to legacy */ }
      return typeof legacyFallback === 'function' ? legacyFallback() : legacyFallback;
    }
    return typeof legacyFallback === 'function' ? legacyFallback() : legacyFallback;
  }

  function writeState(path, type, value, legacyKey, legacyRaw) {
    const r = reg();
    if (r) {
      try {
        ensureAdopted();
        r.set(path, value, { type, source: 'sysstate' });
        return true;
      } catch (_) { /* fall through to legacy */ }
    }
    if (legacyKey) {
      lsSet(legacyKey, legacyRaw !== undefined ? legacyRaw : JSON.stringify(value));
    }
    return false;
  }

  // ── Installed apps (.novaapp metadata lists) ────────────────────────────
  // Windows parity: the Uninstall inventory. `nova-app-package-store.js` is
  // the canonical reader/writer; a few surfaces read it directly.

  function installedApps() {
    const value = readState(PATHS.installedApps, () => readJson(LEGACY_KEYS.installedApps, []));
    return Array.isArray(value) ? value : [];
  }

  function setInstalledApps(list) {
    if (!Array.isArray(list)) return false;
    return writeState(PATHS.installedApps, 'REG_JSON', list, LEGACY_KEYS.installedApps);
  }

  // ── Permission grants (AppPermissionManager records) ────────────────────

  function appPermissions() {
    const value = readState(PATHS.appPermissions, () => readJson(LEGACY_KEYS.appPermissions, []));
    return Array.isArray(value) ? value : [];
  }

  function setAppPermissions(grants) {
    if (!Array.isArray(grants)) return false;
    return writeState(PATHS.appPermissions, 'REG_JSON', grants, LEGACY_KEYS.appPermissions);
  }

  // ── Background alarm registry (app-sandbox nova:alarm:*) ────────────────

  function alarms() {
    const value = readState(PATHS.alarms, () => readJson(LEGACY_KEYS.alarms, null));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function setAlarms(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
    return writeState(PATHS.alarms, 'REG_JSON', state, LEGACY_KEYS.alarms);
  }

  // ── Push subscriptions (app-sandbox nova:push:*) ────────────────────────

  function push() {
    const value = readState(PATHS.push, () => readJson(LEGACY_KEYS.push, null));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function setPush(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
    return writeState(PATHS.push, 'REG_JSON', state, LEGACY_KEYS.push);
  }

  function pushDeviceId() {
    const value = readState(PATHS.pushDeviceId, () => lsGet(LEGACY_KEYS.pushDeviceId));
    return typeof value === 'string' && value ? value : null;
  }

  function setPushDeviceId(id) {
    if (typeof id !== 'string' || !id) return false;
    // Legacy channel stored the bare id, not JSON.
    return writeState(PATHS.pushDeviceId, 'REG_SZ', id, LEGACY_KEYS.pushDeviceId, id);
  }

  // ── Store update check interval ─────────────────────────────────────────

  function storeUpdateInterval() {
    const value = readState(PATHS.storeUpdateInterval, () => readJson(LEGACY_KEYS.storeUpdateInterval, null));
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function setStoreUpdateInterval(minutes) {
    if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return false;
    // Legacy channel stored the bare number, not JSON.
    return writeState(PATHS.storeUpdateInterval, 'REG_DWORD', minutes, LEGACY_KEYS.storeUpdateInterval, String(minutes));
  }

  const api = {
    PATHS,
    LEGACY_KEYS,
    installedApps,
    setInstalledApps,
    appPermissions,
    setAppPermissions,
    alarms,
    setAlarms,
    push,
    setPush,
    pushDeviceId,
    setPushDeviceId,
    storeUpdateInterval,
    setStoreUpdateInterval,
    ensureAdopted,
    // Test hook: forget the in-session adoption flag between suites.
    _internal: { resetAdopted() { adopted = false; } },
  };

  if (typeof window !== 'undefined' && window) window.RegistrySystemState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
