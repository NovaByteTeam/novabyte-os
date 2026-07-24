// USER ACCOUNTS
//
// Multi-account layer sitting on top of what used to be a single global
// identity (OS.username / OS.lockPin, one PBKDF2 hash, one shared salt —
// see kernel.js/boot.js history). This module owns the account list, the
// active session, and the security rules around roles and PINs:
//
//   - Every user has their own PIN and their own salt. No one, including
//     admins, can read or set another user's PIN — ever. That's enforced
//     here, not just hidden in the UI: setPin() only accepts a userId that
//     matches the currently active session.
//   - Only an admin can change another user's role, name, or picture, or
//     delete another account. There must always be at least one admin.
//   - The very first account created on a fresh machine is always admin —
//     there's no such thing as an admin-less install.
//
// Storage: a dedicated 'users' object store in the same IndexedDB database
// the fs worker already opens (see workers.js). Deliberately NOT namespaced
// per-user like files/settings are — the account list has to be readable
// before any one account is selected.

const Users = {
  _cache: new Map(),   // id -> user record
  activeId: null,      // id of the signed-in account, or null pre-login

  get active() {
    return this.activeId ? this._cache.get(this.activeId) || null : null;
  },

  list() {
    return Array.from(this._cache.values());
  },

  get(id) {
    return this._cache.get(id) || null;
  },

  admins() {
    return this.list().filter(u => u.role === 'admin');
  },

  async load() {
    const rows = await OS.workers.fs.call('getAllUsers');
    this._cache.clear();
    for (const u of (rows || [])) this._cache.set(u.id, u);

    // Migration: a pre-multi-account install has OS.lockPin (one PBKDF2
    // hash under a shared pinSalt) and OS.username, but no user records at
    // all. Wrap that single identity into the first admin account so
    // existing users aren't locked out by this change. Runs once — after
    // migration there's at least one user, so this branch never fires
    // again for that install.
    if (this._cache.size === 0) {
      const legacyPin  = OS.settings.get('lockPin')  || null;
      const legacySalt = OS.settings.get('pinSalt')  || null;
      const legacyName = OS.settings.get('username') || OS.username || 'user';

      const migrated = {
        id: generateId(),
        name: legacyName,
        role: 'admin',
        pinHash: legacyPin,
        // If there was never a PIN set, leave salt null too — createPin()
        // fills in a fresh one the first time this account sets a PIN.
        pinSalt: legacyPin ? legacySalt : null,
        avatar: null,
        createdAt: Date.now()
      };
      this._cache.set(migrated.id, migrated);
      await OS.workers.fs.call('putUser', migrated);
    }
  },

  // Fresh-install / "no accounts yet" is a distinct state from "accounts
  // exist, no one has logged in this session" — the boot sequence and lock
  // screen both need to tell these apart to decide whether to show
  // "create your admin account" vs. the account picker.
  needsFirstRun() {
    return this._cache.size === 0;
  },

  async _hash(pin, salt) {
    return OS.workers.crypto.call('pbkdf2', pin, salt);
  },

  _freshSalt() {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    let hex = '';
    for (let i = 0; i < 16; i++) hex += (buf[i] < 16 ? '0' : '') + buf[i].toString(16);
    return hex;
  },

  // Creates a new account. First account on the machine is forced admin
  // regardless of what's passed in — there's no admin-less install state.
  //
  // pin may be null/undefined — an account can exist with no PIN set yet
  // (this is how the very first, auto-created admin account starts: see
  // boot.js's first-run path, which mirrors the old single-user install
  // where a PIN was optional). A null pin here means pinHash/pinSalt stay
  // null until the user sets one via setPin(), same as the migration path
  // in load() for an install that never had OS.lockPin set.
  async createUser({ name, role, pin }) {
    if (!name) throw new Error('Name is required.');
    if (pin !== null && pin !== undefined && !/^\d{4}$/.test(pin)) {
      throw new Error('PIN must be exactly 4 digits, or omitted.');
    }
    const isFirst = this._cache.size === 0;
    const hasPin = pin !== null && pin !== undefined;
    const salt = hasPin ? this._freshSalt() : null;
    const user = {
      id: generateId(),
      name,
      role: isFirst ? 'admin' : (role === 'admin' ? 'admin' : 'standard'),
      pinHash: hasPin ? await this._hash(pin, salt) : null,
      pinSalt: salt,
      avatar: null,
      createdAt: Date.now()
    };
    this._cache.set(user.id, user);
    await OS.workers.fs.call('putUser', user);
    return user;
  },

  // Owner-only, no exceptions — see the module comment. requestingUserId
  // must equal userId or this throws, even if the requester is an admin.
  async setPin(userId, requestingUserId, currentPin, newPin) {
    if (userId !== requestingUserId) {
      throw new Error('Only the account owner can change their own PIN.');
    }
    const user = this._cache.get(userId);
    if (!user) throw new Error('Account not found.');

    if (user.pinHash) {
      if (!currentPin) throw new Error('Current PIN is required.');
      const hash = await this._hash(currentPin, user.pinSalt);
      if (hash !== user.pinHash) throw new Error('Current PIN is incorrect.');
    }
    if (!/^\d{4}$/.test(newPin || '')) throw new Error('PIN must be exactly 4 digits.');

    const salt = this._freshSalt();
    user.pinHash = await this._hash(newPin, salt);
    user.pinSalt = salt;
    await OS.workers.fs.call('putUser', user);
    return user;
  },

  async verifyPin(userId, pin) {
    const user = this._cache.get(userId);
    if (!user || !user.pinHash) return false;
    const hash = await this._hash(pin, user.pinSalt);
    return hash === user.pinHash;
  },

  // Name/picture: self, or an admin acting on someone else's account.
  async updateProfile(userId, requestingUserId, { name, avatar }) {
    const requester = this._cache.get(requestingUserId);
    const target = this._cache.get(userId);
    if (!target) throw new Error('Account not found.');
    const isSelf = userId === requestingUserId;
    if (!isSelf && requester?.role !== 'admin') {
      throw new Error('Only an admin can edit another account.');
    }
    if (typeof name === 'string' && name.trim()) target.name = name.trim();
    if (avatar !== undefined) target.avatar = avatar;
    await OS.workers.fs.call('putUser', target);
    return target;
  },

  // Admin-only, and never lets the last admin be demoted — that would
  // strand the machine with no account able to manage roles/dev mode/etc.
  async setRole(userId, requestingUserId, role) {
    const requester = this._cache.get(requestingUserId);
    if (requester?.role !== 'admin') throw new Error('Only an admin can change roles.');
    if (!['admin', 'standard'].includes(role)) throw new Error('Invalid role.');

    const target = this._cache.get(userId);
    if (!target) throw new Error('Account not found.');

    if (target.role === 'admin' && role === 'standard' && this.admins().length <= 1) {
      throw new Error('Cannot demote the last admin account.');
    }
    target.role = role;
    await OS.workers.fs.call('putUser', target);
    return target;
  },

  // Admin-only. A locked-out standard user's PIN can never be recovered
  // (see setPin) — the only remedy an admin has is deleting the account
  // outright, which also wipes that user's isolated storage (handled by
  // whatever calls this, since storage isolation lives in fs.js/workers.js,
  // not here).
  async deleteUser(userId, requestingUserId) {
    const requester = this._cache.get(requestingUserId);
    if (requester?.role !== 'admin') throw new Error('Only an admin can delete an account.');
    if (userId === requestingUserId) throw new Error('An admin cannot delete their own account while signed in.');

    const target = this._cache.get(userId);
    if (!target) return;
    if (target.role === 'admin' && this.admins().length <= 1) {
      throw new Error('Cannot delete the last admin account.');
    }
    this._cache.delete(userId);
    await OS.workers.fs.call('deleteUser', userId);
  },

  // Called by the lock/login screen once a PIN has verified. Does not
  // touch per-user storage scoping — that's step 2 (fs.js re-init).
  setActive(userId) {
    if (!this._cache.has(userId)) return false;
    this.activeId = userId;
    return true;
  }
};

window.Users = Users;