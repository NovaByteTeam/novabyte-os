import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock the fs/crypto workers Users depends on ─────────────────────────────
// crypto.call('pbkdf2', pin, salt) is faked as a deterministic function of
// (pin, salt) so we can assert on hash equality/inequality without real
// PBKDF2 — good enough for exercising the module's logic, not its crypto.
const _userStore = new Map();

const mockFsWorker = {
  call: vi.fn(async (method, ...args) => {
    if (method === 'getAllUsers') return Array.from(_userStore.values());
    if (method === 'putUser') { _userStore.set(args[0].id, { ...args[0] }); return true; }
    if (method === 'deleteUser') { _userStore.delete(args[0]); return true; }
    throw new Error('unexpected fs method: ' + method);
  }),
};
const mockCryptoWorker = {
  call: vi.fn(async (method, pin, salt) => {
    if (method === 'pbkdf2') return `hash(${pin}:${salt})`;
    throw new Error('unexpected crypto method: ' + method);
  }),
};

let _idCounter = 0;
globalThis.generateId = () => 'user-' + (++_idCounter);

globalThis.OS = {
  workers: { fs: mockFsWorker, crypto: mockCryptoWorker },
  settings: { get: vi.fn(() => null) },
  username: null,
};
globalThis.window = globalThis;
let _saltCallCount = 0;
globalThis.crypto = {
  // Deterministic but call-order-dependent, so repeated _freshSalt() calls
  // within/across tests never collide the way a fixed 0..15 fill did — real
  // getRandomValues' only property this suite actually relies on is "not the
  // same bytes twice," not true entropy.
  getRandomValues: (arr) => {
    _saltCallCount++;
    for (let i = 0; i < arr.length; i++) arr[i] = (i + _saltCallCount) & 0xff;
    return arr;
  },
};

require('../../js/core/services/users.js');
const Users = window.Users;

describe('Users (js/core/services/users.js)', () => {
  beforeEach(async () => {
    _userStore.clear();
    _idCounter = 0;
    Users._cache.clear();
    Users.activeId = null;
    mockFsWorker.call.mockClear();
    OS.settings.get = vi.fn(() => null);
  });

  describe('migration from single-account install', () => {
    it('wraps an existing lockPin/username into the first admin account', async () => {
      OS.settings.get = vi.fn((key) => {
        if (key === 'lockPin') return 'legacy-hash';
        if (key === 'pinSalt') return 'legacy-salt';
        if (key === 'username') return 'OldUser';
        return null;
      });
      await Users.load();
      const users = Users.list();
      expect(users).toHaveLength(1);
      expect(users[0].role).toBe('admin');
      expect(users[0].name).toBe('OldUser');
      expect(users[0].pinHash).toBe('legacy-hash');
      expect(users[0].pinSalt).toBe('legacy-salt');
    });

    it('does not re-run migration once accounts already exist', async () => {
      await Users.createUser({ name: 'Already Here', role: 'admin', pin: '1234' });
      mockFsWorker.call.mockClear();
      await Users.load();
      expect(Users.list()).toHaveLength(1);
      expect(Users.list()[0].name).toBe('Already Here');
    });

    it('leaves pinSalt null if no legacy PIN was ever set', async () => {
      OS.settings.get = vi.fn((key) => (key === 'username' ? 'NoPinUser' : null));
      await Users.load();
      expect(Users.list()[0].pinHash).toBeNull();
      expect(Users.list()[0].pinSalt).toBeNull();
    });
  });

  describe('createUser', () => {
    it('forces the first account to admin regardless of requested role', async () => {
      const u = await Users.createUser({ name: 'First', role: 'standard', pin: '1111' });
      expect(u.role).toBe('admin');
    });

    it('honors requested role for subsequent accounts', async () => {
      await Users.createUser({ name: 'Admin', role: 'admin', pin: '1111' });
      const standard = await Users.createUser({ name: 'Standard', role: 'standard', pin: '2222' });
      expect(standard.role).toBe('standard');
    });

    it('rejects a non-4-digit PIN', async () => {
      await expect(Users.createUser({ name: 'Bad', role: 'admin', pin: '12' })).rejects.toThrow();
      await expect(Users.createUser({ name: 'Bad', role: 'admin', pin: 'abcd' })).rejects.toThrow();
    });

    it('gives each user a distinct salt even with the same PIN', async () => {
      const a = await Users.createUser({ name: 'A', role: 'admin', pin: '1234' });
      const b = await Users.createUser({ name: 'B', role: 'standard', pin: '1234' });
      expect(a.pinSalt).not.toBe(b.pinSalt);
      expect(a.pinHash).not.toBe(b.pinHash);
    });
  });

  describe('setPin — owner-only, no exceptions', () => {
    it('allows a user to change their own PIN', async () => {
      const u = await Users.createUser({ name: 'Self', role: 'admin', pin: '1234' });
      const updated = await Users.setPin(u.id, u.id, '1234', '5678');
      expect(await Users.verifyPin(u.id, '5678')).toBe(true);
      expect(await Users.verifyPin(u.id, '1234')).toBe(false);
      expect(updated.pinHash).not.toBe(u.pinHash);
    });

    it('blocks an admin from changing another user\'s PIN', async () => {
      const admin = await Users.createUser({ name: 'Admin', role: 'admin', pin: '1111' });
      const std = await Users.createUser({ name: 'Std', role: 'standard', pin: '2222' });
      await expect(Users.setPin(std.id, admin.id, '2222', '9999')).rejects.toThrow(/owner/i);
      expect(await Users.verifyPin(std.id, '2222')).toBe(true);
    });

    it('requires the correct current PIN before changing', async () => {
      const u = await Users.createUser({ name: 'Self', role: 'admin', pin: '1234' });
      await expect(Users.setPin(u.id, u.id, '0000', '5678')).rejects.toThrow(/incorrect/i);
    });

    it('rejects a malformed new PIN', async () => {
      const u = await Users.createUser({ name: 'Self', role: 'admin', pin: '1234' });
      await expect(Users.setPin(u.id, u.id, '1234', 'abcd')).rejects.toThrow();
    });
  });

  describe('setRole — admin-only, protects last admin', () => {
    it('blocks a standard user from changing any role', async () => {
      const admin = await Users.createUser({ name: 'Admin', role: 'admin', pin: '1111' });
      const std = await Users.createUser({ name: 'Std', role: 'standard', pin: '2222' });
      await expect(Users.setRole(admin.id, std.id, 'standard')).rejects.toThrow(/admin/i);
    });

    it('allows an admin to promote a standard user', async () => {
      const admin = await Users.createUser({ name: 'Admin', role: 'admin', pin: '1111' });
      const std = await Users.createUser({ name: 'Std', role: 'standard', pin: '2222' });
      const updated = await Users.setRole(std.id, admin.id, 'admin');
      expect(updated.role).toBe('admin');
    });

    it('refuses to demote the last remaining admin', async () => {
      const admin = await Users.createUser({ name: 'OnlyAdmin', role: 'admin', pin: '1111' });
      await expect(Users.setRole(admin.id, admin.id, 'standard')).rejects.toThrow(/last admin/i);
    });

    it('allows demoting an admin when another admin exists', async () => {
      const admin1 = await Users.createUser({ name: 'A1', role: 'admin', pin: '1111' });
      const admin2 = await Users.createUser({ name: 'A2', role: 'admin', pin: '2222' });
      const updated = await Users.setRole(admin2.id, admin1.id, 'standard');
      expect(updated.role).toBe('standard');
    });
  });

  describe('deleteUser — admin-only, protects last admin, no self-delete', () => {
    it('blocks a standard user from deleting anyone', async () => {
      const admin = await Users.createUser({ name: 'Admin', role: 'admin', pin: '1111' });
      const std = await Users.createUser({ name: 'Std', role: 'standard', pin: '2222' });
      await expect(Users.deleteUser(admin.id, std.id)).rejects.toThrow(/admin/i);
    });

    it('prevents an admin from deleting their own active account', async () => {
      const admin = await Users.createUser({ name: 'Admin', role: 'admin', pin: '1111' });
      await expect(Users.deleteUser(admin.id, admin.id)).rejects.toThrow(/own account/i);
    });

    it('refuses to delete the last admin even via another account path', async () => {
      const admin = await Users.createUser({ name: 'OnlyAdmin', role: 'admin', pin: '1111' });
      const std = await Users.createUser({ name: 'Std', role: 'standard', pin: '2222' });
      // std can't delete at all (not admin) — confirms the role gate fires
      // before the last-admin check would even be reached.
      await expect(Users.deleteUser(admin.id, std.id)).rejects.toThrow(/admin/i);
    });

    it('allows deleting a standard user', async () => {
      const admin = await Users.createUser({ name: 'Admin', role: 'admin', pin: '1111' });
      const std = await Users.createUser({ name: 'Std', role: 'standard', pin: '2222' });
      await Users.deleteUser(std.id, admin.id);
      expect(Users.get(std.id)).toBeNull();
    });
  });

  describe('updateProfile — self or admin, cosmetic fields only', () => {
    it('allows a user to update their own name/avatar', async () => {
      const u = await Users.createUser({ name: 'Old', role: 'admin', pin: '1111' });
      const updated = await Users.updateProfile(u.id, u.id, { name: 'New', avatar: 'x.png' });
      expect(updated.name).toBe('New');
      expect(updated.avatar).toBe('x.png');
    });

    it('blocks a standard user from editing another account\'s profile', async () => {
      const admin = await Users.createUser({ name: 'Admin', role: 'admin', pin: '1111' });
      const std = await Users.createUser({ name: 'Std', role: 'standard', pin: '2222' });
      await expect(Users.updateProfile(admin.id, std.id, { name: 'Hijacked' })).rejects.toThrow(/admin/i);
    });

    it('allows an admin to edit another account\'s name/avatar', async () => {
      const admin = await Users.createUser({ name: 'Admin', role: 'admin', pin: '1111' });
      const std = await Users.createUser({ name: 'Std', role: 'standard', pin: '2222' });
      const updated = await Users.updateProfile(std.id, admin.id, { name: 'Renamed' });
      expect(updated.name).toBe('Renamed');
    });
  });

  describe('needsFirstRun / setActive', () => {
    it('reports first-run when no accounts exist', () => {
      expect(Users.needsFirstRun()).toBe(true);
    });

    it('reports not-first-run once an account exists', async () => {
      await Users.createUser({ name: 'A', role: 'admin', pin: '1111' });
      expect(Users.needsFirstRun()).toBe(false);
    });

    it('setActive fails for an unknown id and does not change activeId', () => {
      const ok = Users.setActive('does-not-exist');
      expect(ok).toBe(false);
      expect(Users.activeId).toBeNull();
    });

    it('setActive succeeds for a known id', async () => {
      const u = await Users.createUser({ name: 'A', role: 'admin', pin: '1111' });
      expect(Users.setActive(u.id)).toBe(true);
      expect(Users.active.id).toBe(u.id);
    });
  });
});