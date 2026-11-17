/**
 * NovaByte — Settings Shim
 *
 * Turns OS.settings into a client of the NovaByte Registry, making the
 * registry the source of truth for OS configuration. Boot attaches this
 * right after the registry engine is up and BEFORE OS.settings.load():
 *
 *   writes  — settings.set(key, value) resolves the key through
 *             NovaRegistry.settingsPathFor() and commits it to the hive
 *             (atomic persist + audit + nova:reg:changed). The settings
 *             cache is updated immediately so reads stay synchronous.
 *   reads   — settings.load() hydrates the cache from the registry
 *             (mapped paths plus the generic HKNU/settings/*,
 *             HKNS/settings/*, HKNS/system/*, HKNS/security/* areas). The
 *             old settings.json / IndexedDB store is read once: its keys
 *             are adopted into their live registry paths (guarded by
 *             HKND/_migration/registrySourceDone), and excluded keys —
 *             customWallpaper, too large for a hive value — stay on the
 *             legacy channel permanently.
 *   imports — external registry writers (NovaReg, the reg CLI, app IPC
 *             through nova:reg:set) emit nova:reg:changed; the shim maps
 *             the path back to a settings key via pathToSettingsKey(),
 *             updates the cache and re-emits 'settings:changed' so the
 *             whole shell live-applies the change. Writes that originated
 *             from settings.set itself (source 'settings') are skipped —
 *             the cache is already fresh and settings:changed was emitted
 *             by set().
 *   safety  — if the registry is unavailable, boot skips attach() and
 *             OS.settings keeps its original behaviour byte for byte. A
 *             throwing registry write falls back to the legacy persistence
 *             channel so a broken hive can never lose a setting. Safe Mode
 *             sets OS.settings.volatile = true: changes stay in the session
 *             cache and are never committed anywhere, matching the
 *             documented "clean default session without persisting" intent.
 *
 * UMD: window.NovaSettingsShim in the shell, module.exports in tests.
 */
(function () {
  'use strict';

  // Marker source on registry writes issued by settings.set — the change
  // handler ignores these to keep exactly one 'settings:changed' per write.
  const SOURCE = 'settings';

  function cloneValue(value) {
    if (value === null || typeof value !== 'object') return value;
    try { return structuredClone(value); } catch (_) { /* fall through */ }
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
  }

  // ── Legacy persistence channel (excluded keys + fallback) ─────────────
  // Mirrors kernel.js byte for byte: Linux keeps a 0600 settings.json under
  // ~/.config/novabyte, the web build goes through the fs worker's
  // IndexedDB settings store. The platform flag is cached at load and
  // overridable through _internal for tests (they must never touch the
  // real user settings file).

  let platformIsLinux = (typeof process !== 'undefined' &&
    typeof process.platform === 'string' && process.platform === 'linux');

  function isLinuxRuntime() {
    return platformIsLinux;
  }

  function legacySettingsPath() {
    return require('path').join(require('os').homedir(), '.config', 'novabyte', 'settings.json');
  }

  const CUSTOM_WALLPAPER_STORAGE_PREFIX = '__customWallpaper:';
  const LEGACY_CUSTOM_WALLPAPER_KEY = `${CUSTOM_WALLPAPER_STORAGE_PREFIX}legacy`;

  function isMultiUserMode() {
    return typeof NovaUserScope !== 'undefined' && !!NovaUserScope
      && typeof NovaUserScope.enabled === 'function'
      && NovaUserScope.enabled() === true;
  }

  function legacyStorageKey(key) {
    if (key !== 'customWallpaper' || !isMultiUserMode()) return key;
    if (typeof NovaUserScope.uid !== 'function') return null;
    const uid = NovaUserScope.uid();
    return typeof uid === 'string' && uid
      ? `${CUSTOM_WALLPAPER_STORAGE_PREFIX}user:${uid}`
      : null;
  }

  function readLegacyStore(OS) {
    if (isLinuxRuntime()) {
      const fs = require('fs');
      try {
        const parsed = JSON.parse(fs.readFileSync(legacySettingsPath(), 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch (error) {
        if (error && error.code === 'ENOENT') return {};
        return {};
      }
    }
    // Web build: the fs worker may not exist yet (early boot) — empty then.
    if (!OS.workers || !OS.workers.fs || typeof OS.workers.fs.call !== 'function') return {};
    return OS.workers.fs.call('getAllSettings').then(
      (all) => (all && typeof all === 'object' && !Array.isArray(all) ? all : {}),
      () => ({})
    );
  }

  function writeLegacyStore(OS, cache, logger, onlyKeys) {
    if (isLinuxRuntime()) {
      try {
        const fs = require('fs');
        const path = legacySettingsPath();
        let current = {};
        try { current = JSON.parse(fs.readFileSync(path, 'utf8')) || {}; } catch (_) { /* fresh file */ }
        const next = typeof onlyKeys === 'function'
          ? { ...current, ...onlyKeys(cache) }
          : { ...cache };
        fs.mkdirSync(require('path').dirname(path), { recursive: true, mode: 0o700 });
        const tmp = `${path}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, path);
      } catch (err) {
        if (logger) logger.error('Failed to persist setting(s) to the legacy Linux settings store', err);
      }
      return;
    }
    if (OS.workers && OS.workers.fs && typeof OS.workers.fs.call === 'function') {
      // onlyKeys — persist just the excluded subset in web builds too; the
      // mapped keys live in the registry alone.
      const entries = typeof onlyKeys === 'function' ? onlyKeys(cache) : cache;
      for (const [key, value] of Object.entries(entries)) {
        OS.workers.fs.call('putSetting', key, value).catch((err) => {
          if (logger) logger.error(`Failed to persist setting "${key}" to the legacy store`, err);
        });
      }
    }
  }

  // ── Hydration ───────────────────────────────────────────────────────────

  // 2026-11-15 scope redesign: keys that moved between hives. theme /
  // accentColor / wallpaperId / devMode / rootAccessEnabled became PER-USER
  // (HKNU), timezone became MACHINE-scoped (HKNS). On load, a legacy value
  // is adopted into the new path when the new path has none, and the legacy
  // value is removed either way — otherwise the generic-area scan in
  // hydrateFromRegistry would keep resurrecting the old machine-scoped
  // devMode/rootAccessEnabled (or the first user's personal timezone) over
  // the new scope forever.
  const SETTINGS_SCOPE_MIGRATIONS = Object.freeze({
    theme: 'HKNS/shell/theme',
    accentColor: 'HKNS/shell/accentColor',
    wallpaperId: 'HKNS/shell/wallpaper',
    devMode: 'HKNS/system/devMode',
    rootAccessEnabled: 'HKNS/security/rootAccessEnabled',
    timezone: 'HKNU/settings/timezone',
  });

  function migrateSettingsScopes(reg, logger) {
    let migrated = 0;
    for (const [key, from] of Object.entries(SETTINGS_SCOPE_MIGRATIONS)) {
      let to = null;
      try { to = reg.settingsPathFor(key); } catch (_) { continue; }
      if (!to || to === from) continue;
      let legacy, current;
      try { legacy = reg.get(from); current = reg.get(to); } catch (_) { continue; }
      if (legacy === undefined) continue;
      try {
        if (current === undefined) {
          reg.set(to, legacy, { source: SOURCE, actor: 'shell' });
          migrated += 1;
        }
        reg.remove(from, { source: SOURCE, actor: 'shell' });
      } catch (err) {
        (logger.warn || logger.log || function () {}).call(logger, `[SettingsShim] scope migration for "${key}" failed`, err);
      }
    }
    if (migrated > 0) {
      (logger.info || logger.log || function () {}).call(logger, `[SettingsShim] Migrated ${migrated} setting(s) to their new per-user/system scope`);
    }
    return migrated;
  }

  function hydrateFromRegistry(OS, reg) {
    const cache = {};
    // 1. Explicitly mapped keys (theme, pins, security keys, ...).
    for (const [key, path] of Object.entries(reg.SETTINGS_KEY_TO_PATH)) {
      const value = reg.get(path);
      if (value !== undefined) cache[key] = value;
    }
    // 2. Generic settings areas (unknown-at-runtime keys filed by
    //    settingsPathFor, plus future system keys).
    for (const area of ['HKNU/settings', 'HKNS/settings', 'HKNS/system', 'HKNS/security', 'HKNS/security/policy']) {
      let listing = null;
      try { listing = reg.list(area); } catch (_) { /* area absent yet */ }
      if (!listing) continue;
      for (const name of Object.keys(listing.values)) {
        const key = reg.pathToSettingsKey(`${area}/${name}`);
        if (!key || cache[key] !== undefined) continue;
        const value = reg.get(`${area}/${name}`);
        if (value !== undefined) cache[key] = value;
      }
    }
    return cache;
  }

  // ── attach() ────────────────────────────────────────────────────────────

  function attach(OS, reg) {
    if (!OS || !OS.settings || !OS.events || !reg || typeof reg.get !== 'function') return false;
    const s = OS.settings;
    if (s.__registryBacked) return true;
    if (typeof reg.settingsPathFor !== 'function' || typeof reg.pathToSettingsKey !== 'function') return false;

    const logger = OS.logger || console;
    const bus = OS.events;
    const originals = { set: s.set, load: s.load };

    // settings.set — cache-first, then a registry commit. The registry write
    // is synchronous and atomic; on failure the legacy channel takes over so
    // the change is never lost for the session's storage reality.
    s.set = function registryBackedSet(key, value) {
      if ((key === 'wallpaperId' || key === 'customWallpaper' || key === 'customWallpaperName') &&
          this.get('prohibitWallpaperChange') === true) {
        return false;
      }
      if (this.volatile === true) {
        this._cache[key] = value;
        // Safe Mode: session-only, documented "never persists" semantics.
        bus.emit('settings:changed', { key, value });
        return true;
      }
      const path = reg.settingsPathFor(key);
      const storageKey = path ? key : legacyStorageKey(key);
      if (!path && !storageKey) return false;
      this._cache[key] = value;
      if (!path) {
        // Excluded (oversized) key — legacy channel permanently.
        writeLegacyStore(OS, this._cache, logger, (cache) => ({ [storageKey]: cache[key] }));
        bus.emit('settings:changed', { key, value });
        return true;
      }
      try {
        reg.set(path, value, { source: SOURCE, actor: 'shell' });
      } catch (err) {
        logger.error(`Failed to commit setting "${key}" to ${path} — using legacy store`, err);
        writeLegacyStore(OS, this._cache, logger, (cache) => ({ [storageKey]: cache[key] }));
      }
      bus.emit('settings:changed', { key, value });
      return true;
    };

    // settings.load — hydrate from the registry; adopt legacy values once.
    s.load = async function registryBackedLoad() {
      let raw = {};
      try { raw = await readLegacyStore(OS); } catch (_) { raw = {}; }
      try {
        if (raw && typeof raw === 'object') {
          if (isMultiUserMode() && raw.customWallpaper !== undefined
              && raw[LEGACY_CUSTOM_WALLPAPER_KEY] === undefined) {
            writeLegacyStore(OS, raw, logger, () => ({
              [LEGACY_CUSTOM_WALLPAPER_KEY]: raw.customWallpaper,
            }));
          }
          const keys = Object.keys(raw).filter((key) => !key.startsWith(CUSTOM_WALLPAPER_STORAGE_PREFIX));
          if (keys.length) {
            const adopted = reg.adoptLegacySettings((key) => raw[key], keys);
            if (adopted > 0) logger.info(`[SettingsShim] Adopted ${adopted} legacy setting(s) into the registry`);
          }
        }
        // Scope migrations run BEFORE hydration so adopted values are
        // visible in this very load (best-effort; guarded).
        try {
          if (typeof reg.remove === 'function') migrateSettingsScopes(reg, logger);
        } catch (_) { /* migration is best-effort; hydration still runs */ }
        this._cache = hydrateFromRegistry(OS, reg);
        // Excluded keys never enter the hive — serve them from the legacy
        // store on every boot.
        for (const key of reg.SETTINGS_EXCLUDED_KEYS) {
          const storageKey = legacyStorageKey(key);
          if (storageKey && raw && raw[storageKey] !== undefined) this._cache[key] = raw[storageKey];
        }
        return;
      } catch (err) {
        logger.error('Registry hydration failed — falling back to the legacy settings store', err);
      }
      await originals.load.call(this);
    };

    // External registry writes flow back into settings here: NovaReg edits,
    // reg CLI scripts, app IPC. One 'settings:changed' per external change.
    bus.on('nova:reg:changed', (event) => {
      if (!event || event.source === SOURCE) return;
      const key = reg.pathToSettingsKey(event.path);
      if (!key) return;
      if (event.type === null) delete s._cache[key]; // value/key removed → defaults apply again
      else s._cache[key] = cloneValue(event.value);
      bus.emit('settings:changed', { key, value: event.type === null ? undefined : s._cache[key] });
    });

    s.__registryBacked = true;
    s.__registryShim = { reg, originals };
    return true;
  }

  const api = {
    attach,
    SOURCE,
    hydrateFromRegistry,
    readLegacyStore,
    writeLegacyStore,
    // Test hooks — never used by the shell.
    _internal: {
      setLinuxRuntime(value) { platformIsLinux = value === true; },
    },
  };

  if (typeof window !== 'undefined' && window) window.NovaSettingsShim = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
