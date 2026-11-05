/**
 * NovaByte — NovaByte Registry
 *
 * A Windows-Registry-style hierarchical configuration store for the OS.
 * Four hives:
 *
 *   HKNS — NovaSystem: OS-level config (shell, wallpaper, theme, security
 *          policy). Written by the OS and system apps only.
 *   HKNU — NovaUser: per-user preferences (reserved for user-level config).
 *   HKNA — NovaApps: per-app config, namespaced HKNA/<appId>/....
 *   HKND — NovaDev: developer-mode scratch hive; ignored in normal use.
 *
 * Paths look like 'HKNS/shell/wallpaper' ('\' is accepted as a separator
 * too). Intermediate segments are KEYS; the last segment names a VALUE
 * under its parent key. Values are typed:
 *
 *   REG_SZ (string) · REG_BOOL · REG_DWORD (uint32) · REG_QWORD (non-negative
 *   safe integer) · REG_JSON (plain JSON) · REG_BINARY (base64 string)
 *
 * Every commit is clone-validate-swap (a rejected write can never leave a
 * half-applied hive behind), persisted per hive as one JSON document, and
 * announced on the OS event bus as 'nova:reg:changed'. Hives are quota'd
 * (depth, segment length, value bytes, hive bytes, node count) and a
 * corrupt hive file is quarantined, not fatal.
 *
 * Security lives in the sandbox handlers (app-sandbox.js) — this engine
 * deliberately has no authority model of its own; unrestricted host code
 * (e.g. the NovaReg editor) and host services call it directly.
 *
 * @module js/platform/core/nova-registry
 */

const NovaRegistry = (() => {
  'use strict';

  const HIVES = Object.freeze(['HKNS', 'HKNU', 'HKNA', 'HKND']);
  const HIVE_SET = new Set(HIVES);

  const VALUE_TYPES = Object.freeze([
    'REG_SZ', 'REG_BOOL', 'REG_DWORD', 'REG_QWORD', 'REG_JSON', 'REG_BINARY',
  ]);
  const TYPE_SET = new Set(VALUE_TYPES);

  const LIMITS = Object.freeze({
    MAX_DEPTH: 16,
    MAX_SEG_LENGTH: 64,
    MAX_NAME_LENGTH: 64,
    MAX_VALUE_BYTES: 256 * 1024,
    MAX_HIVE_BYTES: 2 * 1024 * 1024,
    MAX_NODES_PER_HIVE: 4096,
    HIVE_SCHEMA_VERSION: 1,
    MAX_IMPORT_VALUES: 2048,
  });

  // OS.settings keys mirrored into the registry. settings:changed copies
  // settings → registry (attachSettingsMirror); a system writer committing
  // HKNS/shell/* through nova:reg:set copies registry → settings so the
  // existing 'settings:changed' fan-out applies the change live. Keys that
  // are not mapped (customWallpaper — a multi-megabyte data URL — and
  // friends) never enter the registry.
  const SETTINGS_KEY_TO_PATH = Object.freeze({
    theme: 'HKNS/shell/theme',
    accentColor: 'HKNS/shell/accentColor',
    wallpaperId: 'HKNS/shell/wallpaper',
  });
  const SETTINGS_PATH_TO_KEY = Object.freeze(
    Object.fromEntries(Object.entries(SETTINGS_KEY_TO_PATH).map(([key, path]) => [path, key]))
  );

  // Seed-once defaults (merge-only: an existing value is never clobbered).
  const BOOT_DEFAULTS = Object.freeze({
    'HKNS/shell/theme': ['REG_SZ', 'nova-dark'],
    'HKNS/shell/accentColor': ['REG_SZ', '#58a6ff'],
    'HKNS/shell/wallpaper': ['REG_SZ', 'stock-blue'],
    'HKNS/security/policy/prohibitWallpaperChange': ['REG_BOOL', false],
    'HKNU/desktop/pins': ['REG_JSON', []],
  });

  const DEFAULT_VALUE_NAME_QUOTA_NOTE = 'value data exceeds the per-value size limit';

  let state = null; // { hives, storage, events, logger, mirrorAttached }

  function freshState() {
    return { hives: {}, storage: null, events: null, logger: null, mirrorAttached: false };
  }

  function logWarn(...args) {
    try {
      if (state && state.logger && typeof state.logger.warn === 'function') state.logger.warn(...args);
      else if (typeof console !== 'undefined') console.warn('[NovaRegistry]', ...args);
    } catch (_) { /* logging must never throw */ }
  }

  // ── Storage ────────────────────────────────────────────────────────────

  // NW.js/Linux runtime: one JSON file per hive under the OS profile
  // directory (~/.config/novabyte/registry/<HIVE>.json), written atomically
  // (tmp + rename) exactly like kernel.js persists settings.json. Everywhere
  // else (plain web / test runs): localStorage under nova_registry_hive_<HIVE>.
  function createDefaultStorage() {
    let native = null;
    try {
      if (typeof process !== 'undefined' && process.versions && process.versions.node &&
          typeof require === 'function') {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const dir = path.join(os.homedir(), '.config', 'novabyte', 'registry');
        native = {
          file: (hive) => path.join(dir, `${hive}.json`),
          read: (hive) => fs.readFileSync(native.file(hive), 'utf8'),
          write: (hive, json) => {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            const tmp = `${native.file(hive)}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, json, { mode: 0o600 });
            fs.renameSync(tmp, native.file(hive));
          },
          quarantine: (hive, raw) => {
            try { fs.writeFileSync(`${native.file(hive)}.corrupt`, String(raw), { mode: 0o600 }); } catch (_) {}
          },
        };
      }
    } catch (_) { native = null; }

    const lsKey = (hive) => `nova_registry_hive_${hive}`;

    return {
      loadAll() {
        const out = {};
        for (const hive of HIVES) {
          let raw = null;
          if (native) {
            try { raw = native.read(hive); } catch (_) { raw = null; }
          }
          if (raw === null && typeof localStorage !== 'undefined' && localStorage) {
            try { raw = localStorage.getItem(lsKey(hive)); } catch (_) { raw = null; }
          }
          out[hive] = decodeHive(hive, raw, (r) => {
            if (native) native.quarantine(hive, r);
            else {
              try { localStorage.setItem(`${lsKey(hive)}.corrupt`, String(r)); } catch (_) {}
            }
          });
        }
        return out;
      },
      save(hive, hiveData) {
        const json = JSON.stringify(hiveData);
        if (native) {
          try { native.write(hive, json); return true; } catch (err) { logWarn('native save failed', hive, err); }
        }
        try {
          if (typeof localStorage !== 'undefined' && localStorage) {
            localStorage.setItem(lsKey(hive), json);
            return true;
          }
        } catch (err) { logWarn('localStorage save failed', hive, err); }
        return false;
      },
    };
  }

  function decodeHive(hive, raw, quarantine) {
    if (raw === null || raw === undefined) return null;
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      if (typeof data.keys !== 'object' || data.keys === null || Array.isArray(data.keys)) return null;
      if (typeof data.values !== 'object' || data.values === null || Array.isArray(data.values)) return null;
      if (typeof data.hive === 'string' && data.hive !== hive) return null;
      return data;
    } catch (_) {
      try { quarantine(raw); } catch (_) {}
      logWarn(`corrupt ${hive} hive quarantined; starting fresh`);
      return null;
    }
  }

  // ── Errors ─────────────────────────────────────────────────────────────

  function regError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  // ── Path handling ──────────────────────────────────────────────────────

  // Accepts '/' or '\' separators. The hive is case-insensitive; segments
  // are case-sensitive, trimmed, non-empty, may not be '.'/'..', are capped
  // at MAX_SEG_LENGTH, and a path is capped at MAX_DEPTH segments.
  function parsePath(path) {
    if (typeof path !== 'string' || !path.trim()) {
      return { error: 'INVALID_ARGS', message: 'path is required' };
    }
    const parts = path.trim().split(/[/\\]+/);
    const hive = parts[0].toUpperCase();
    if (!HIVE_SET.has(hive)) {
      return { error: 'INVALID_ARGS', message: `unknown hive '${parts[0]}' (expected one of ${HIVES.join(', ')})` };
    }
    const segments = [];
    for (let i = 1; i < parts.length; i++) {
      const seg = parts[i].trim();
      if (!seg) return { error: 'INVALID_ARGS', message: 'path contains an empty segment' };
      if (seg === '.' || seg === '..') return { error: 'INVALID_ARGS', message: "path segments may not be '.' or '..'" };
      if (seg.length > LIMITS.MAX_SEG_LENGTH) {
        return { error: 'INVALID_ARGS', message: `path segment exceeds ${LIMITS.MAX_SEG_LENGTH} characters` };
      }
      segments.push(seg);
    }
    if (segments.length > LIMITS.MAX_DEPTH) {
      return { error: 'INVALID_ARGS', message: `path exceeds ${LIMITS.MAX_DEPTH} segments` };
    }
    return { hive, segments, path: hive + (segments.length ? '/' + segments.join('/') : '') };
  }

  // ── Tree model ─────────────────────────────────────────────────────────
  // A node is { keys: {name: node}, values: {name: {type, data, lastModified}} }.
  // Both maps are sparse; the hive root doubles as the top node.

  function emptyNode() {
    return { keys: {}, values: {} };
  }

  function ensureHive(hive) {
    if (!state.hives[hive]) state.hives[hive] = { version: LIMITS.HIVE_SCHEMA_VERSION, hive, keys: {}, values: {} };
    return state.hives[hive];
  }

  function walk(hive, segments, create) {
    let node = ensureHive(hive);
    for (const seg of segments) {
      if (!node.keys[seg]) {
        if (!create) return undefined;
        node.keys[seg] = emptyNode();
      }
      node = node.keys[seg];
    }
    return node;
  }

  function countNodes(node) {
    let count = Object.keys(node.values).length;
    for (const child of Object.values(node.keys)) count += 1 + countNodes(child);
    return count;
  }

  // ── Value typing ───────────────────────────────────────────────────────

  function byteLength(type, data) {
    if (type === 'REG_JSON') return JSON.stringify(data).length;
    return String(data).length;
  }

  function detectType(value) {
    switch (typeof value) {
      case 'boolean': return 'REG_BOOL';
      case 'number':
        if (Number.isInteger(value) && value >= 0 && value <= 0xFFFFFFFF) return 'REG_DWORD';
        if (Number.isInteger(value) && value >= 0 && Number.isSafeInteger(value)) return 'REG_QWORD';
        throw regError('INVALID_VALUE', 'numbers must be non-negative integers (REG_DWORD/REG_QWORD)');
      case 'string': return 'REG_SZ';
      case 'object':
        if (value === null) return 'REG_JSON';
        return 'REG_JSON';
      default:
        throw regError('INVALID_VALUE', `cannot store a ${typeof value} value in the registry`);
    }
  }

  function coerceValue(type, value) {
    if (!TYPE_SET.has(type)) throw regError('INVALID_VALUE', `unknown value type '${type}'`);
    switch (type) {
      case 'REG_SZ':
        if (typeof value !== 'string') throw regError('INVALID_VALUE', 'REG_SZ requires a string');
        return value;
      case 'REG_BOOL':
        if (typeof value !== 'boolean') throw regError('INVALID_VALUE', 'REG_BOOL requires true or false');
        return value;
      case 'REG_DWORD':
        if (!Number.isInteger(value) || value < 0 || value > 0xFFFFFFFF) {
          throw regError('INVALID_VALUE', 'REG_DWORD requires an integer between 0 and 4294967295');
        }
        return value;
      case 'REG_QWORD':
        if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
          throw regError('INVALID_VALUE', 'REG_QWORD requires a non-negative safe integer');
        }
        return value;
      case 'REG_JSON': {
        try { return JSON.parse(JSON.stringify(value ?? null)); } catch (_) {
          throw regError('INVALID_VALUE', 'REG_JSON requires JSON-serializable data');
        }
      }
      case 'REG_BINARY':
        if (typeof value !== 'string' || !/^[A-Za-z0-9+/=]*$/.test(value)) {
          throw regError('INVALID_VALUE', 'REG_BINARY requires a base64 string');
        }
        return value;
      default:
        throw regError('INVALID_VALUE', `unknown value type '${type}'`);
    }
  }

  // ── Mutation core (clone → validate → swap → persist) ──────────────────

  function commitMutation(hive, mutator) {
    const current = ensureHive(hive);
    const clone = JSON.parse(JSON.stringify(current));
    const result = mutator(clone); // throws regError on any validation failure
    const serialized = JSON.stringify(clone);
    if (serialized.length > LIMITS.MAX_HIVE_BYTES) {
      throw regError('QUOTA_EXCEEDED', `hive ${hive} exceeds ${LIMITS.MAX_HIVE_BYTES} bytes`);
    }
    if (countNodes(clone) > LIMITS.MAX_NODES_PER_HIVE) {
      throw regError('QUOTA_EXCEEDED', `hive ${hive} exceeds ${LIMITS.MAX_NODES_PER_HIVE} nodes`);
    }
    state.hives[hive] = clone;
    if (state.storage && typeof state.storage.save === 'function') state.storage.save(hive, clone);
    return result;
  }

  function emitChanged(path, { type, value, appId, source }) {
    const bus = state && state.events;
    if (!bus || typeof bus.emit !== 'function') return;
    try {
      bus.emit('nova:reg:changed', {
        path, type: type || null, value, appId: appId || null, source: source || 'app',
      });
    } catch (err) { logWarn('failed to emit nova:reg:changed', err); }
  }

  // ── Public API ─────────────────────────────────────────────────────────

  function init(options = {}) {
    state = freshState();
    state.storage = options.storage || createDefaultStorage();
    state.events = options.events !== undefined ? options.events
      : (typeof OS !== 'undefined' && OS && OS.events ? OS.events : null);
    state.logger = options.logger !== undefined ? options.logger
      : (typeof OS !== 'undefined' && OS && OS.logger ? OS.logger : null);
    const loaded = (state.storage && typeof state.storage.loadAll === 'function')
      ? (state.storage.loadAll() || {}) : {};
    for (const hive of HIVES) {
      const raw = loaded[hive];
      state.hives[hive] = (raw && typeof raw === 'object' && !Array.isArray(raw) &&
        raw.keys && typeof raw.keys === 'object' && !Array.isArray(raw.keys) &&
        raw.values && typeof raw.values === 'object' && !Array.isArray(raw.values))
        ? raw
        : { version: LIMITS.HIVE_SCHEMA_VERSION, hive, keys: {}, values: {} };
    }
    return api;
  }

  function ensureReady() {
    if (!state) init();
    return state;
  }

  // Resolves a parsed path to { parentNode, name, node } where parentNode is
  // the KEY containing value `name`, and node (when present) is the KEY the
  // path would address as a key. get/set/stat/delete address the VALUE; list/
  // export address the KEY (zero segments = the hive root).
  function resolveForValue(parsed, create) {
    if (parsed.segments.length < 1) {
      throw regError('INVALID_ARGS', 'path must name a value (a key path has no default value)');
    }
    const parentSegments = parsed.segments.slice(0, -1);
    const name = parsed.segments[parsed.segments.length - 1];
    const parentNode = walk(parsed.hive, parentSegments, create);
    return {
      parentNode,
      name,
      keyNode: parentNode ? parentNode.keys[name] : undefined,
    };
  }

  function stat(path) {
    ensureReady();
    const parsed = parsePath(path);
    if (parsed.error) throw regError(parsed.error, parsed.message);
    const { parentNode, name } = resolveForValue(parsed, false);
    const entry = parentNode ? parentNode.values[name] : undefined;
    if (!entry) return null;
    return { path: parsed.path, type: entry.type, data: entry.data, lastModified: entry.lastModified };
  }

  function get(path) {
    const entry = stat(path);
    return entry ? entry.data : undefined;
  }

  function set(path, value, options = {}) {
    ensureReady();
    const parsed = parsePath(path);
    if (parsed.error) throw regError(parsed.error, parsed.message);
    const type = options.type ? String(options.type) : detectType(value);
    const data = coerceValue(type, value);
    if (byteLength(type, data) > LIMITS.MAX_VALUE_BYTES) {
      throw regError('QUOTA_EXCEEDED', DEFAULT_VALUE_NAME_QUOTA_NOTE);
    }
    const committed = commitMutation(parsed.hive, (root) => {
      const parentSegments = parsed.segments.slice(0, -1);
      const name = parsed.segments[parsed.segments.length - 1];
      let node = root;
      for (const seg of parentSegments) {
        if (!node.keys[seg]) node.keys[seg] = emptyNode();
        node = node.keys[seg];
      }
      const existing = node.values[name];
      if (existing && existing.type === type && JSON.stringify(existing.data) === JSON.stringify(data)) {
        return { changed: false, path: parsed.path, type, data };
      }
      node.values[name] = { type, data, lastModified: Date.now() };
      return { changed: true, path: parsed.path, type, data };
    });
    if (committed.changed) {
      emitChanged(parsed.path, { type, value: data, appId: options.appId, source: options.source });
    }
    return { path: parsed.path, type, data, changed: committed.changed };
  }

  function remove(path, options = {}) {
    ensureReady();
    const parsed = parsePath(path);
    if (parsed.error) throw regError(parsed.error, parsed.message);
    const committed = commitMutation(parsed.hive, (root) => {
      const parentSegments = parsed.segments.slice(0, -1);
      const name = parsed.segments[parsed.segments.length - 1];
      let node = root;
      for (const seg of parentSegments) {
        node = node.keys[seg];
        if (!node) throw regError('NOT_FOUND', `no such key: ${parsed.path}`);
      }
      if (Object.prototype.hasOwnProperty.call(node.values, name)) {
        delete node.values[name];
        return { removed: 'value' };
      }
      if (node.keys[name]) {
        const child = node.keys[name];
        const hasContent = Object.keys(child.values).length > 0 || Object.keys(child.keys).length > 0;
        if (hasContent && options.recursive !== true) {
          throw regError('SUBTREE_NOT_EMPTY', 'key has content; pass recursive: true to delete it');
        }
        delete node.keys[name];
        return { removed: 'key' };
      }
      throw regError('NOT_FOUND', `no such value or key: ${parsed.path}`);
    });
    emitChanged(parsed.path, { type: null, value: null, appId: options.appId, source: options.source });
    return { path: parsed.path, ...committed };
  }

  // Lists a KEY path (zero segments lists the hive root). Returns sorted key
  // names and a shallow copy of the values map.
  function list(path) {
    ensureReady();
    const parsed = parsePath(path);
    if (parsed.error) throw regError(parsed.error, parsed.message);
    const node = walk(parsed.hive, parsed.segments, false);
    if (!node) return null;
    return {
      path: parsed.path,
      keys: Object.keys(node.keys).sort(),
      values: JSON.parse(JSON.stringify(node.values)),
    };
  }

  // Deep-clones the subtree under a KEY path (zero segments = whole hive).
  function exportTree(path) {
    ensureReady();
    const parsed = parsePath(path);
    if (parsed.error) throw regError(parsed.error, parsed.message);
    const node = walk(parsed.hive, parsed.segments, false);
    if (!node) throw regError('NOT_FOUND', `no such key: ${parsed.path}`);
    return JSON.parse(JSON.stringify({ keys: node.keys, values: node.values }));
  }

  // Merges an exportTree-shaped subtree under a KEY path, creating keys as
  // needed. Existing values keep their data unless the imported subtree has
  // a value of the same name (imported wins). Returns the merged value count.
  function importTree(path, data, options = {}) {
    ensureReady();
    const parsed = parsePath(path);
    if (parsed.error) throw regError(parsed.error, parsed.message);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw regError('INVALID_ARGS', 'import data must be an object ({ keys, values })');
    }
    let merged = 0;
    const validateNode = (node, depth) => {
      if (depth > LIMITS.MAX_DEPTH) throw regError('INVALID_VALUE', 'imported subtree is too deep');
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        throw regError('INVALID_VALUE', 'imported nodes must be objects');
      }
      const values = node.values && typeof node.values === 'object' ? node.values : {};
      const keys = node.keys && typeof node.keys === 'object' ? node.keys : {};
      for (const [name, entry] of Object.entries(values)) {
        if (name.length > LIMITS.MAX_NAME_LENGTH) throw regError('INVALID_VALUE', `imported value name too long: ${name}`);
        if (!entry || typeof entry !== 'object') throw regError('INVALID_VALUE', `imported value '${name}' is malformed`);
        const type = entry.type && TYPE_SET.has(entry.type) ? entry.type : detectType(entry.data);
        coerceValue(type, entry.data);
        merged += 1;
        if (merged > LIMITS.MAX_IMPORT_VALUES) throw regError('QUOTA_EXCEEDED', 'imported subtree has too many values');
      }
      for (const child of Object.values(keys)) validateNode(child, depth + 1);
    };
    validateNode(data, parsed.segments.length);

    commitMutation(parsed.hive, (root) => {
      let node = root;
      for (const seg of parsed.segments) {
        if (!node.keys[seg]) node.keys[seg] = emptyNode();
        node = node.keys[seg];
      }
      const applyNode = (target, importNode) => {
        const values = importNode.values && typeof importNode.values === 'object' ? importNode.values : {};
        for (const [name, entry] of Object.entries(values)) {
          const type = entry.type && TYPE_SET.has(entry.type) ? entry.type : detectType(entry.data);
          const valueData = coerceValue(type, entry.data);
          if (byteLength(type, valueData) > LIMITS.MAX_VALUE_BYTES) {
            throw regError('QUOTA_EXCEEDED', `${DEFAULT_VALUE_NAME_QUOTA_NOTE}: ${name}`);
          }
          target.values[name] = { type, data: valueData, lastModified: Date.now() };
        }
        const keys = importNode.keys && typeof importNode.keys === 'object' ? importNode.keys : {};
        for (const [name, child] of Object.entries(keys)) {
          if (!target.keys[name]) target.keys[name] = emptyNode();
          applyNode(target.keys[name], child || {});
        }
      };
      applyNode(node, data);
      return { merged };
    });
    emitChanged(parsed.path, { type: null, value: null, appId: options.appId, source: options.source });
    return { path: parsed.path, merged };
  }

  // Seed-once defaults: only writes paths that have no value yet. Returns
  // how many defaults were newly seeded.
  function ensureDefaults(defaults) {
    ensureReady();
    const map = defaults || BOOT_DEFAULTS;
    let seeded = 0;
    for (const [path, [type, value]] of Object.entries(map)) {
      if (stat(path) === null) {
        set(path, value, { type, source: 'seed' });
        seeded += 1;
      }
    }
    return seeded;
  }

  // settings → registry mirror. Idempotent; the engine dedupes writes whose
  // value did not change, so the mirror can never loop against the
  // registry → settings copy the sandbox handler performs for system writes.
  function attachSettingsMirror(settings, events) {
    ensureReady();
    if (state.mirrorAttached) return true;
    const bus = events || state.events;
    if (!settings || typeof settings.get !== 'function' || !bus || typeof bus.on !== 'function') return false;
    state.mirrorAttached = true;
    bus.on('settings:changed', (payload) => {
      const key = payload && payload.key;
      const path = SETTINGS_KEY_TO_PATH[key];
      if (!path || payload.value === undefined) return;
      try {
        set(path, payload.value, { source: 'settings-mirror' });
      } catch (err) {
        logWarn(`failed to mirror setting '${key}' into ${path}`, err);
      }
    });
    return true;
  }

  function hiveSnapshot(hive) {
    ensureReady();
    if (!HIVE_SET.has(hive)) throw regError('INVALID_ARGS', `unknown hive '${hive}'`);
    return JSON.parse(JSON.stringify(ensureHive(hive)));
  }

  const api = {
    HIVES,
    VALUE_TYPES,
    LIMITS,
    SETTINGS_KEY_TO_PATH,
    SETTINGS_PATH_TO_KEY,
    BOOT_DEFAULTS,
    init,
    get,
    stat,
    set,
    remove,
    delete: remove,
    list,
    export: exportTree,
    import: importTree,
    ensureDefaults,
    attachSettingsMirror,
    hiveSnapshot,
    // Test/introspection hooks. resetState() drops all in-memory and does
    // NOT persist — tests re-init with their own storage afterwards.
    _internal: {
      parsePath,
      coerceValue,
      detectType,
      walk,
      resetState() { state = null; },
      currentState() { return state; },
    },
  };

  return api;
})();

if (typeof window !== 'undefined' && window) window.NovaRegistry = NovaRegistry;
if (typeof module !== 'undefined' && module.exports) module.exports = NovaRegistry;
