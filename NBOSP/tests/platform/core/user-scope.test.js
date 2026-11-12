// tests/platform/core/user-scope.test.js — per-user scoping: the username
// segment (users/<username>) that every per-user storage stratum derives
// from, plus the login-time uid→username layout upgrade that keeps data
// from machines created before the username layout.
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resetTestStorage } from '../../setup.js';
import UserScope from '../../../js/platform/core/user-scope.js';
import MultiUserMigration from '../../../js/core/services/multiuser-migration.js';

beforeEach(() => resetTestStorage());

describe('NovaUserScope — the mounted account (uid + username)', () => {
  it('enabled() defaults ON (unset flag = accounts are how the OS works)', () => {
    expect(UserScope.enabled()).toBe(true);
    UserScope.disable();
    expect(UserScope.enabled()).toBe(false);
    UserScope.enable();
    expect(UserScope.enabled()).toBe(true);
  });

  it('setActive/setActiveUsername/clearActive track the mounted pair', () => {
    UserScope.setActive('u-123');
    UserScope.setActiveUsername('diraz');
    expect(UserScope.uid()).toBe('u-123');
    expect(UserScope.activeUsername()).toBe('diraz');

    // clearActive tears down the whole pair — no half-mounted account.
    UserScope.clearActive();
    expect(UserScope.uid()).toBe('');
    expect(UserScope.activeUsername()).toBe('');
  });

  it('usernames are validated before they become directory segments', () => {
    UserScope.setActiveUsername('Ada.Nova');   // normalised to lowercase
    expect(UserScope.activeUsername()).toBe('ada.nova');

    UserScope.setActiveUsername('ab');         // too short
    expect(UserScope.activeUsername()).toBe('');
    UserScope.setActiveUsername('has space');   // invalid characters
    expect(UserScope.activeUsername()).toBe('');
    UserScope.setActiveUsername('../../etc');  // path tricks are just bad names
    expect(UserScope.activeUsername()).toBe('');
  });

  it('userSegment() prefers the username: users/<username>', () => {
    UserScope.setActive('u-123');
    expect(UserScope.userSegment()).toBe('users/u-123'); // pre-login fallback
    UserScope.setActiveUsername('diraz');
    expect(UserScope.userSegment()).toBe('users/diraz');
    UserScope.clearActive();
    UserScope.setLegacyOwnerUid('u-legacy');
    expect(UserScope.userSegment()).toBe('users/u-legacy'); // legacy owner stamping
  });

  it('reset() wipes every scope flag including the username', () => {
    UserScope.setActive('u-1');
    UserScope.setActiveUsername('diraz');
    UserScope.setActiveRole('admin');
    UserScope.setLegacyOwnerUid('u-2');
    UserScope.reset();
    expect(UserScope.uid()).toBe('');
    expect(UserScope.activeUsername()).toBe('');
    expect(UserScope.legacyOwnerUid()).toBe('');
    // Factory-reset state: multi-user defaults ON (unset flag) with no role
    // mounted, so no admin powers exist until an account signs in.
    expect(UserScope.isActiveAdmin()).toBe(false);
  });
});

describe('MultiUserMigration.upgradeUserLayout — onto the ~/users/<username> layout', () => {
  // The production NBOSP runtime IS a linux native runtime, so this is the
  // real path: an account's visible filesystem must BE <machine home>/users/
  // <username>/ — a real, separated tree — with the standard folders directly
  // inside it and app data at .apps/. Older layout generations (uid-keyed
  // segments; the nested ~/.local/share/novabyte/users/<name>/home tree) are
  // renamed/lifted onto it at login. A temp home keeps the test off the
  // developer's real machine.
  function withTempHome(run) {
    const realHome = os.homedir;
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'nb-userlayout-'));
    os.homedir = () => tmp;
    try {
      run(tmp);
    } finally {
      os.homedir = realHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('moves the account’s whole tree onto ~/users/<username> exactly once', () => {
    withTempHome((tmp) => {
      const shareUsers = path.join(tmp, '.local', 'share', 'novabyte', 'users');
      const configUsers = path.join(tmp, '.config', 'novabyte', 'users');
      // Pre-flat generations: uid-keyed segment, nested home tree.
      mkdirSync(path.join(shareUsers, 'u1', 'home', 'Documents'), { recursive: true });
      writeFileSync(path.join(shareUsers, 'u1', 'home', 'Documents', 'notes.txt'), 'account data');
      mkdirSync(path.join(shareUsers, 'u1', 'apps'), { recursive: true });
      writeFileSync(path.join(shareUsers, 'u1', 'apps', 'app-state.json'), '{}');
      mkdirSync(path.join(configUsers, 'u1', 'registry'), { recursive: true });
      writeFileSync(path.join(configUsers, 'u1', 'registry', 'HKNU.json'), '{"hive":true}');

      const result = MultiUserMigration.upgradeUserLayout('u1', 'ada');
      expect(result.moved).toBeGreaterThan(0);
      // The account tree root IS ~/users/ada — notes.txt sits directly in
      // its Documents, app data is the hidden .apps, no nested "home".
      expect(existsSync(path.join(tmp, 'users', 'ada', 'Documents', 'notes.txt'))).toBe(true);
      expect(existsSync(path.join(tmp, 'users', 'ada', '.apps', 'app-state.json'))).toBe(true);
      expect(existsSync(path.join(tmp, 'users', 'ada', 'home'))).toBe(false);
      // The registry hives renamed onto the username segment, uid dirs gone.
      expect(existsSync(path.join(configUsers, 'ada', 'registry', 'HKNU.json'))).toBe(true);
      expect(existsSync(path.join(configUsers, 'u1'))).toBe(false);
      expect(existsSync(path.join(shareUsers, 'u1'))).toBe(false);

      // Idempotent: the second run finds nothing left to move.
      expect(MultiUserMigration.upgradeUserLayout('u1', 'ada').moved).toBe(0);
    });
  });

  it('lifts a username-keyed nested tree even with no uid rename to do', () => {
    withTempHome((tmp) => {
      const shareUsers = path.join(tmp, '.local', 'share', 'novabyte', 'users');
      mkdirSync(path.join(shareUsers, 'sam', 'home', 'Desktop'), { recursive: true });
      writeFileSync(path.join(shareUsers, 'sam', 'home', 'Desktop', 'todo.txt'), 'x');
      writeFileSync(path.join(shareUsers, 'sam', 'browser-state.json'), '{}');

      const result = MultiUserMigration.upgradeUserLayout('u-sam', 'sam');
      expect(result.moved).toBe(1);
      expect(existsSync(path.join(tmp, 'users', 'sam', 'Desktop', 'todo.txt'))).toBe(true);
      expect(existsSync(path.join(tmp, 'users', 'sam', '.browser-state.json'))).toBe(true);
      expect(existsSync(path.join(shareUsers, 'sam'))).toBe(false);

      expect(MultiUserMigration.upgradeUserLayout('u-sam', 'sam').moved).toBe(0);
    });
  });

  it('refuses to overwrite an existing users/<username> tree (collision safety)', () => {
    withTempHome((tmp) => {
      const shareUsers = path.join(tmp, '.local', 'share', 'novabyte', 'users');
      mkdirSync(path.join(shareUsers, 'u1', 'home'), { recursive: true });
      mkdirSync(path.join(shareUsers, 'ada', 'home'), { recursive: true });
      writeFileSync(path.join(shareUsers, 'u1', 'home', 'old.txt'), 'old');
      writeFileSync(path.join(shareUsers, 'ada', 'home', 'new.txt'), 'new');
      // The current-layout tree for ada already exists: the lift must not
      // merge the nested copy over it.
      mkdirSync(path.join(tmp, 'users', 'ada', 'Desktop'), { recursive: true });
      writeFileSync(path.join(tmp, 'users', 'ada', 'Desktop', 'current.txt'), 'current');

      MultiUserMigration.upgradeUserLayout('u1', 'ada');
      // The uid tree survives untouched — no merge, no data loss.
      expect(existsSync(path.join(shareUsers, 'u1', 'home', 'old.txt'))).toBe(true);
      // The current-layout tree kept every byte of its own content.
      expect(existsSync(path.join(tmp, 'users', 'ada', 'Desktop', 'current.txt'))).toBe(true);
      // The nested copy's loose entries relocate entry-by-entry (never over
      // an existing name) and never leave a stray "home/" folder behind.
      expect(existsSync(path.join(tmp, 'users', 'ada', 'new.txt'))).toBe(true);
      expect(existsSync(path.join(tmp, 'users', 'ada', 'home'))).toBe(false);
    });
  });

  it('no-ops when the segments match, are missing, or the username is invalid', () => {
    withTempHome(() => {
      expect(MultiUserMigration.upgradeUserLayout('u1', 'u1').moved).toBe(0);
      expect(MultiUserMigration.upgradeUserLayout('', 'ada').moved).toBe(0);
      expect(MultiUserMigration.upgradeUserLayout('u1', 'n%t-a-name').moved).toBe(0);
      expect(MultiUserMigration.upgradeUserLayout('u1', undefined).moved).toBe(0);
    });
  });
});
