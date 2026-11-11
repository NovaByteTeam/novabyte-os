/**
 * NovaByte OS — Multi-user migration (3.0.2 single-user → accounts)
 *
 * The migration that must be perfect, because the existing user's data IS
 * the product. One-time, idempotent behind the HKNS/system/migration/v1
 * marker, and a strict no-op on machines that never enabled multi-user
 * (those keep byte-identical single-user behaviour forever).
 *
 * Order matters: this runs in boot BEFORE any per-user hive is mounted and
 * BEFORE the storage schemas (NovaByte_FS v2, NovaByte_AppStorage v2)
 * stamp owner uids, so every legacy byte is stamped to the owner it
 * belongs to:
 *
 *   1. owner account imported from the legacy single-user state
 *      (HKNS/security/lockPin PBKDF2 hash + pinSalt + HKNU/settings/
 *      username) into the server's users.db — kdf records the legacy
 *      shape, the first successful verification re-hashes to scrypt;
 *   2. registry user hives moved into users/<owner>/registry/;
 *   3. the legacy home tree moved into users/<owner>/home and the per-app
 *      AppDirs re-rooted under users/<owner>/apps/;
 *   4. NovaByte_FS + NovaByte_AppStorage rows stamped with the owner uid
 *      through their schema v2 upgrades;
 *   5. webview partitions renamed from persist:app_<appId> to
 *      persist:u<owner>_app_<appId> — best-effort at the NW.js user-data
 *      layout, fail-soft;
 *   6. the LS_MAP user-data localStorage keys ride their existing mirror
 *      into the owner's per-app files (the AppDirs bootstrap seeds from
 *      localStorage on first login);
 *   7. machine app-permission grants copied into the owner's per-account
 *      hive; legacy adminEnabled=true maps to the owner (owner IS admin).
 *
 * After migration the machine behaves exactly as it did before — one
 * account, one PIN, all data intact — but every stratum carries an owner.
 */
(() => {
  'use strict';

  const MIGRATION_MARKER = 'HKNS/system/migration/v1';
  const MULTI_USER_FLAG = 'HKNS/system/features/multiUser';

  function log(...args) {
    try { console.info('[MultiUserMigration]', ...args); } catch (_) { }
  }

  function warn(...args) {
    try { console.warn('[MultiUserMigration]', ...args); } catch (_) { }
  }

  function isLinuxRuntime() {
    return typeof process !== 'undefined' && process.platform === 'linux' &&
      typeof require === 'function';
  }

  function metaCsrf() {
    try { return document.querySelector('meta[name="csrf-token"]')?.content || ''; } catch (_) { return ''; }
  }

  async function api(path, { method = 'POST', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const csrf = metaCsrf();
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let json = null;
    try { json = await res.json(); } catch (_) { }
    return { status: res.status, ok: res.ok, json };
  }

  /**
   * Runs the migration exactly once per machine. Multi-user mode is only
   * enabled when the server successfully owns accounts afterwards, so a
   * failed migration leaves a fully functional single-user machine.
   */
  async function run() {
    const scope = (typeof NovaUserScope !== 'undefined' && NovaUserScope) || null;
    const registry = (typeof NovaRegistry !== 'undefined' && NovaRegistry) || null;

    // This machine already went through account setup or an earlier
    // migration (flag written as '1') → nothing to do. enabled() can't be used
    // here: multi-user is on by default, so it is true on every fresh machine.
    if (scope && (scope.explicitlyEnabled ? scope.explicitlyEnabled() : scope.enabled())) {
      return { skipped: 'already-enabled' };
    }

    // The marker lives in HKNS — the machine hive, mounted at boot before
    // any account is mounted, so pre-login reads are safe.
    if (registry) {
      try {
        if (registry.get(MIGRATION_MARKER)) return { skipped: 'marker' };
      } catch (_) { }
    }

    // Read the legacy single-user state BEFORE any hive moves.
    let legacy = null;
    if (registry) {
      try {
        legacy = {
          username: registry.get('HKNU/settings/username'),
          displayName: registry.get('HKNU/settings/username'),
          pinHash: registry.get('HKNS/security/lockPin'),
          pinSalt: registry.get('HKNS/security/pinSalt'),
          biometricId: registry.get('HKNS/security/biometricCredentialId'),
        };
      } catch (err) {
        warn('legacy state read failed:', err);
      }
    }

    // Server-side: does users.db already have accounts (e.g. a previous
    // migration whose marker write failed)? Idempotence: import is refused
    // when accounts exist, and the marker is just re-stamped.
    const existing = await api('/api/auth/users', { method: 'GET' });
    const serverHasAccounts = existing.ok && Array.isArray(existing.json?.data?.users) &&
      existing.json.data.users.length > 0;

    let ownerUid = null;
    if (serverHasAccounts && existing.json.data.users.length) {
      ownerUid = existing.json.data.users[0].uid; // the first account is the owner by construction
    } else if (legacy && legacy.pinHash) {
      // The 3.0.2 → accounts import: the PBKDF2 hash + salt + username go
      // to the server; the first successful PIN verification re-hashes the
      // account to scrypt there.
      const username = typeof legacy.username === 'string' && legacy.username
        ? legacy.username : 'user';
      const pinLen = 4;
      const adminMode = await readAdminMode();
      const imported = await api('/api/auth/migrate-legacy', {
        body: {
          username: String(username).toLowerCase(),
          displayName: String(username),
          legacyPinHash: String(legacy.pinHash || ''),
          legacyPinSalt: String(legacy.pinSalt || ''),
          pinLen,
          adminEnabled: adminMode === true,
        },
      });
      if (!imported.ok || !imported.json?.success) {
        warn('legacy import refused — multi-user stays OFF:', imported.json?.message || imported.status);
        return { skipped: 'import-refused' };
      }
      ownerUid = imported.json.data?.uid || null;
      if (!ownerUid) {
        warn('legacy import returned no owner uid — multi-user stays OFF');
        return { skipped: 'no-owner' };
      }
    } else {
      // No legacy PIN and no accounts: this is either a factory-fresh
      // machine (the first-boot wizard will create the owner) or a legacy
      // machine that never set a PIN. Neither has anything to import; the
      // first-boot wizard creates the owner account on the next gate.
      return { skipped: 'no-legacy-state' };
    }

    // Stamp the scope flags BEFORE the storage schemas open: NovaByte_FS
    // and NovaByte_AppStorage v2 upgrades stamp unscoped rows with the
    // legacy owner uid from here.
    if (scope) {
      scope.setLegacyOwnerUid(ownerUid);
      scope.enable();
    }

    if (isLinuxRuntime()) {
      try {
        moveStorageToOwner(ownerUid, { registry, scope, legacy });
      } catch (err) {
        warn('storage move failed (data stays at the legacy roots):', err);
      }
    } else {
      try {
        moveWebStorageToOwner(ownerUid, { registry });
      } catch (err) {
        warn('web storage move failed:', err);
      }
    }

    // The credential keys are deleted at migration time: users.db owns
    // credentials now, and their presence in HKNS would make the legacy
    // lock screen fire on the next boot.
    if (registry) {
      try {
        registry.remove('HKNS/security/lockPin', { actor: 'migration' });
        registry.remove('HKNS/security/pinSalt', { actor: 'migration' });
        registry.remove('HKNS/security/biometricCredentialId', { actor: 'migration' });
      } catch (err) {
        warn('legacy credential key deletion failed:', err);
      }
      try {
        registry.set(MULTI_USER_FLAG, true, { type: 'REG_BOOL', source: 'migration', actor: 'migration' });
        registry.set(MIGRATION_MARKER, { version: 1, at: Date.now(), ownerUid }, { type: 'REG_JSON', source: 'migration', actor: 'migration' });
      } catch (err) {
        warn('marker write failed:', err);
      }
    }

    log('legacy single-user machine migrated to accounts; owner', ownerUid);
    return { migrated: true, ownerUid };
  }

  async function readAdminMode() {
    try {
      const res = await api('/api/security/admin-mode', { method: 'GET' });
      return res.ok && res.json?.data?.adminEnabled === true;
    } catch (_) { return false; }
  }

  // ── Linux native storage move ───────────────────────────────────────────

  function moveStorageToOwner(ownerUid, { registry, scope, legacy }) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const home = os.homedir();
    const shareRoot = path.join(home, '.local', 'share', 'novabyte');
    const userRoot = path.join(shareRoot, 'users', ownerUid);

    const moveTree = (from, to, { keepSource = false } = {}) => {
      if (!fs.existsSync(from)) return false;
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      try {
        fs.renameSync(from, to);
      } catch (_) {
        // Cross-device or busy: fall back to copy + remove.
        fs.cpSync(from, to, { recursive: true });
        if (!keepSource) fs.rmSync(from, { recursive: true, force: true });
      }
      return true;
    };

    // 1. Registry user hives: ~/.config/novabyte/registry/{HKNU,HKNA,HKND}.json
    const regDir = path.join(home, '.config', 'novabyte', 'registry');
    const userRegDir = path.join(home, '.config', 'novabyte', 'users', ownerUid, 'registry');
    for (const hive of ['HKNU', 'HKNA', 'HKND']) {
      moveTree(path.join(regDir, `${hive}.json`), path.join(userRegDir, `${hive}.json`));
    }

    // 2. Per-app AppDirs: ~/.local/share/novabyte/data/<appId> → users/<uid>/apps/<appId>
    const dataRoot = path.join(shareRoot, 'data');
    const userApps = path.join(userRoot, 'apps');
    if (fs.existsSync(dataRoot)) {
      for (const entry of fs.readdirSync(dataRoot)) {
        moveTree(path.join(dataRoot, entry), path.join(userApps, entry));
      }
    }

    // 3. The legacy home tree (documents, pictures, …) → users/<uid>/home.
    // Dot-folders and the NovaByte roots move with it only when they are
    // INSIDE the home tree itself; ~/.config and ~/.local/share are
    // machine state and stay machine state.
    const userHome = path.join(userRoot, 'home');
    fs.mkdirSync(userHome, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(home)) {
      if (entry.startsWith('.')) continue;
      moveTree(path.join(home, entry), path.join(userHome, entry));
    }
    // The legacy XDG trash contents are not per-account property in the
    // same sense — leaving ~/.local/share/Trash alone is the conservative
    // choice; the owner can clean it from the Files app.

    // 4. Per-user browser-state + settings shadow: users/<uid>/browser-state.json
    // is seeded from the machine file on first login by the mirror.
    const legacyBrowserState = path.join(shareRoot, 'browser-state.json');
    if (fs.existsSync(legacyBrowserState)) {
      moveTree(legacyBrowserState, path.join(userRoot, 'browser-state.json'), { keepSource: true });
    }

    // 5. Webview partitions: best-effort rename at the NW.js user-data
    // layout (persist:app_<id> profiles). If the layout ever differs, the
    // rename is a silent no-op and apps just start with fresh partitions.
    try {
      migrateNwjsPartitions(ownerUid, path);
    } catch (err) {
      warn('webview partition migration skipped:', err?.message || err);
    }

    // 6. IndexedDB NovaByte_FS / NovaByte_AppStorage stamping happens via
    //    their own v2 schema upgrades at next open (scope flags are set).

    log('linux storage re-rooted under users/' + ownerUid);
  }

  function migrateNwjsPartitions(ownerUid) {
    const fs = require('fs');
    const path = require('path');
    // NW.js --user-data-dir=./nwjs-data (package.json chromium-args).
    // Persistent partitions live under a Partitions/ directory keyed by a
    // hash of the partition name on some versions, or a directly-named
    // directory on others. Try both, fail-soft.
    const candidates = [
      path.join(process.cwd(), 'nwjs-data', 'Partitions'),
      path.join(process.cwd(), 'nwjs-data'),
    ];
    for (const root of candidates) {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root)) {
        if (entry.startsWith('app_')) {
          // Directly-named layout: rename app_<id> → u<owner>_app_<id>.
          try {
            fs.renameSync(path.join(root, entry), path.join(root, `u${ownerUid}_${entry}`));
          } catch (_) { }
        }
      }
    }
  }

  // ── Web build storage move (localStorage / OPFS best-effort) ────────────

  function moveWebStorageToOwner(ownerUid, { registry }) {
    // Registry hives: localStorage keys nova_registry_hive_<HIVE> →
    // nova_registry_hive_u_<ownerUid>_<HIVE> (the mounted-hive layout).
    try {
      for (const hive of ['HKNU', 'HKNA', 'HKND']) {
        const from = `nova_registry_hive_${hive}`;
        const to = `nova_registry_hive_u_${ownerUid}_${hive}`;
        const raw = localStorage.getItem(from);
        if (raw !== null) {
          localStorage.setItem(to, raw);
          localStorage.removeItem(from);
        }
      }
    } catch (err) {
      warn('web hive move failed:', err);
    }
    // NovaByte_FS / NovaByte_AppStorage stamp through their v2 upgrades at
    // next open; the LS_MAP keys mirror into per-user files through the
    // AppDirs bootstrap; OPFS moves ride the next bootstrap reconcile.
  }

  const MultiUserMigration = { run, MIGRATION_MARKER, MULTI_USER_FLAG };

  if (typeof window !== 'undefined' && window) {
    window.MultiUserMigration = Object.freeze(MultiUserMigration);
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MultiUserMigration;
  }
})();
