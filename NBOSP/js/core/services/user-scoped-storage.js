// USER-SCOPED STORAGE
//
// Single entry point for every piece of user-specific data that used to live
// in global localStorage / global in-memory maps. Other modules should call
// into here rather than reading/writing localStorage directly so that data
// stays isolated per account.

const USER_PREFIX = '__nb_user_';

const UserScopedStorage = {
  _userId: null,

  get userId() {
    return this._userId;
  },

  setUserId(id) {
    this._userId = id || null;
  },

  _key(rawKey) {
    if (!this._userId) return rawKey;
    return USER_PREFIX + this._userId + '__' + rawKey;
  },

  getItem(rawKey) {
    try {
      const v = localStorage.getItem(this._key(rawKey));
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  },

  setItem(rawKey, value) {
    try {
      localStorage.setItem(this._key(rawKey), JSON.stringify(value));
    } catch {
      // quota/sandboxed — silent
    }
  },

  removeItem(rawKey) {
    try {
      localStorage.removeItem(this._key(rawKey));
    } catch {
      // silent
    }
  },

  // Snapshot all keys belonging to a user (for migration / export).
  exportForUser(userId) {
    const out = {};
    const prefix = USER_PREFIX + userId + '__';
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (typeof k === 'string' && k.startsWith(prefix)) {
          const raw = localStorage.getItem(k);
          if (raw) out[k.slice(prefix.length)] = JSON.parse(raw);
        }
      }
    } catch {
      // read errors on one key shouldn't prevent exporting the rest
    }
    return out;
  },

  // Move legacy global keys into a user's scoped namespace.
  migrateGlobalToUser(userId, mappings) {
    try {
      for (const { from, to } of (mappings || [])) {
        const raw = localStorage.getItem(from);
        if (raw !== null) {
          localStorage.setItem(this._keyPrefixFor(userId) + to, raw);
          localStorage.removeItem(from);
        }
      }
    } catch {
      // silent
    }
  },

  _keyPrefixFor(userId) {
    return USER_PREFIX + userId + '__';
  },
};

window.UserScopedStorage = UserScopedStorage;
