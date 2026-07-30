// DEFAULT APPS SERVICE — default-apps.js
//
// Lets the user pick which app opens each type of file or link (Settings ->
// Default Apps), the same idea as Windows' Settings > Apps > Default apps
// or Android's Settings > Apps > Default apps > Browser app.
//
// Two sources feed the candidate list for each category:
//
//  1. CATEGORIES (static, below) — hardcoded {id, name, icon} entries for
//     the built-in apps (Browser, TextEdit, Music, Gallery, Email,
//     Calendar). This is the reliable path: it doesn't depend on OS.apps
//     carrying any particular property at any particular moment, so the
//     built-ins always show up as long as they're installed. Add a line
//     here for any new built-in that should be selectable as a default.
//
//  2. Live discovery — for everything NOT in the static table (namely
//     third-party .novaapp packages and web apps), we still scan OS.apps
//     for a `handles: { protocols, extensions }` block on the app's
//     registerApp() config, the same manifest-declaration idea Android
//     uses with <intent-filter>. A .novaapp author declares:
//
//       registerApp({
//         id: 'com.someuser.tunes', name: 'Tunes', icon: 'music',
//         handles: { protocols: [], extensions: ['.mp3', '.flac'] },
//         ...
//       });
//
//     and it becomes a selectable Music Player option automatically, no
//     edit to this file required.
//
// getAppsForCategory() merges both, static entries first, deduped by id
// (a static entry always wins if somehow duplicated, since it's what we
// trust most).
//
// @module js/core/services/default-apps

const DefaultApps = {

  // categoryId -> { name, apps: [{id, name, icon}] }
  // `apps` here is ONLY the hardcoded built-in candidates — third-party
  // apps are found dynamically in getAppsForCategory(), not listed here.
  CATEGORIES: {
    browser: {
      name: 'Web Browser',
      apps: [
        { id: 'browser', name: 'Browser', icon: 'globe' },
      ],
    },
    texteditor: {
      name: 'Text Editor',
      apps: [
        { id: 'quill', name: 'TextEdit', icon: 'pen-tool' },
      ],
    },
    music: {
      name: 'Music Player',
      apps: [
        { id: 'nbosp-music', name: 'Music', icon: 'music' },
      ],
    },
    gallery: {
      name: 'Photo Viewer',
      apps: [
        { id: 'nbosp-gallery', name: 'Gallery', icon: 'image' },
      ],
    },
    email: {
      name: 'Email',
      apps: [
        { id: 'nbosp-email', name: 'Email', icon: 'mail' },
      ],
    },
    calendar: {
      name: 'Calendar',
      apps: [
        { id: 'calendar-app', name: 'Calendar', icon: 'calendar' },
      ],
    },
  },

  // Extensions/protocols routed to each category — used by
  // getCategoryFor()/resolveHandler() to decide *which* category a file or
  // link belongs to, AND by the live-discovery half of getAppsForCategory()
  // to check a third-party app's `handles` block for overlap. Kept separate
  // from CATEGORIES.apps on purpose: which built-in apps fill a slot and
  // which files fall into that slot are different questions.
  ROUTES: {
    browser:    { protocols: ['http', 'https'], extensions: ['.html', '.htm'] },
    texteditor: { protocols: [],                extensions: ['.txt', '.md', '.json', '.js', '.css', '.log'] },
    music:      { protocols: [],                extensions: ['.mp3', '.wav', '.ogg', '.flac', '.m4a'] },
    gallery:    { protocols: [],                extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'] },
    email:      { protocols: ['mailto'],        extensions: [] },
    calendar:   { protocols: ['webcal'],        extensions: ['.ics'] },
  },

  _settingsKey: 'defaultApps',

  // ── Candidate apps ────────────────────────────────────────────────────

  /**
   * Static built-in candidates for a category, filtered to only those
   * currently installed (checked against OS.apps so an uninstalled
   * built-in doesn't show up as a choice). If OS.apps isn't available yet,
   * returns the full static list rather than an empty one — better to
   * over-show briefly during early boot than to flash "no app available".
   * @param {string} categoryId
   * @returns {Array<{id: string, name: string, icon: string}>}
   */
  _staticCandidates(categoryId) {
    const category = this.CATEGORIES[categoryId];
    if (!category) return [];
    const hasOSApps = typeof OS !== 'undefined' && OS.apps && Object.keys(OS.apps).length > 0;
    if (!hasOSApps) return category.apps.slice();
    return category.apps.filter(a => !!OS.apps[a.id]);
  },

  /**
   * Dynamic candidates for a category: any currently-registered app whose
   * `handles` block overlaps the category's protocols/extensions, skipping
   * ids already covered by the static table above (built-ins are only ever
   * sourced from CATEGORIES, never from this scan, even if their
   * registerApp() config also happens to carry a `handles` block).
   * @param {string} categoryId
   * @returns {Array<{id: string, name: string, icon: string}>}
   */
  _dynamicCandidates(categoryId) {
    const route = this.ROUTES[categoryId];
    if (!route || typeof OS === 'undefined' || !OS.apps) return [];

    const staticIds = new Set((this.CATEGORIES[categoryId]?.apps || []).map(a => a.id));
    const protoSet   = new Set(route.protocols);
    const extSet     = new Set(route.extensions.map(e => e.toLowerCase()));

    const matches = [];
    for (const [id, config] of Object.entries(OS.apps)) {
      if (staticIds.has(id)) continue; // built-ins come from CATEGORIES, not here
      const handles = config && config.handles;
      if (!handles) continue;
      const appProtos = handles.protocols  || [];
      const appExts    = (handles.extensions || []).map(e => e.toLowerCase());
      const overlaps = appProtos.some(p => protoSet.has(p)) || appExts.some(e => extSet.has(e));
      if (overlaps) matches.push({ id, name: config.name || id, icon: config.icon || null });
    }
    return matches;
  },

  /**
   * Full candidate list for a category: static built-ins first, then any
   * third-party/.novaapp apps discovered via their `handles` declaration,
   * deduped by id (static wins on a collision).
   * @param {string} categoryId - a key of DefaultApps.CATEGORIES
   * @returns {Array<{id: string, name: string, icon: string}>}
   */
  getAppsForCategory(categoryId) {
    const staticList  = this._staticCandidates(categoryId);
    const dynamicList = this._dynamicCandidates(categoryId);
    const seen = new Set(staticList.map(a => a.id));
    const merged = staticList.slice();
    for (const app of dynamicList) {
      if (seen.has(app.id)) continue;
      seen.add(app.id);
      merged.push(app);
    }
    return merged;
  },

  /**
   * Which category (if any) a file extension or protocol belongs to.
   * @param {{extension?: string, protocol?: string}} query
   * @returns {string|null}
   */
  getCategoryFor({ extension, protocol } = {}) {
    const ext = extension ? extension.toLowerCase() : null;
    for (const [categoryId, route] of Object.entries(this.ROUTES)) {
      if (protocol && route.protocols.includes(protocol)) return categoryId;
      if (ext && route.extensions.includes(ext)) return categoryId;
    }
    return null;
  },

  // ── User preference ───────────────────────────────────────────────────

  /**
   * @returns {Object<string,string>} categoryId -> appId map, as persisted.
   */
  _getMap() {
    if (typeof OS === 'undefined' || !OS.settings) return {};
    return OS.settings.get(this._settingsKey) || {};
  },

  /**
   * The user's chosen default app id for a category, or null if they've
   * never set one (caller should fall back to a hardcoded default in that
   * case — see resolveHandler()).
   * @param {string} categoryId
   * @returns {string|null}
   */
  getDefault(categoryId) {
    return this._getMap()[categoryId] || null;
  },

  /**
   * Persist the user's choice. Emits the normal 'settings:changed' event
   * (via OS.settings.set) so anything caching a resolved handler — none of
   * the built-in apps do today, but a future one might — can invalidate.
   * @param {string} categoryId
   * @param {string} appId
   */
  setDefault(categoryId, appId) {
    if (typeof OS === 'undefined' || !OS.settings) return;
    const map = this._getMap();
    map[categoryId] = appId;
    OS.settings.set(this._settingsKey, map);
  },

  /**
   * Resolve which app should open a given file/link, honoring the user's
   * choice first and falling back to `fallbackAppId` (the pre-existing
   * hardcoded behavior) if they never picked one, or picked an app that's
   * since been uninstalled.
   * @param {{extension?: string, protocol?: string}} query
   * @param {string} fallbackAppId
   * @returns {string} an app id
   */
  resolveHandler(query, fallbackAppId) {
    const categoryId = this.getCategoryFor(query);
    if (!categoryId) return fallbackAppId;

    const chosen = this.getDefault(categoryId);
    if (!chosen) return fallbackAppId;

    // Guard against a stale choice pointing at an uninstalled app —
    // otherwise files silently stop opening instead of falling back.
    if (typeof OS !== 'undefined' && OS.apps && !OS.apps[chosen]) return fallbackAppId;

    return chosen;
  },
};

if (typeof DefaultApps !== 'undefined') {
  window.DefaultApps = DefaultApps;
} else {
  console.warn('DefaultApps object was not found in the local scope of default-apps.js');
}