import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Isolation ──────────────────────────────────────────────────────────────
// security/routes.js resolves its SQLite sessions store, admin-state.json and
// users.db through NBOSP_DATA_DIR at require time — point everything at a
// throwaway data dir BEFORE the module chain loads (same discipline as
// tests/server/auth-routes.test.js).
const dataDir = mkdtempSync(join(tmpdir(), 'nova-sec-routes-'));
const envSnapshot = { ...process.env };

process.env.NBOSP_DATA_DIR = dataDir;
process.env.NBOSP_CRED_KEY = 'e'.repeat(64);
process.env.SESSION_SECRET = 'f'.repeat(128);
// The blocked-IP end-to-end assertions simulate remote clients through
// X-Forwarded-For (supertest always peers from loopback, which the default
// trustedProxies list trusts). getClientIP reads this env at request time.
process.env.TRUST_X_FORWARDED_FOR = '1';

// One shared require registry for the whole chain (tests/server/push.test.js
// header: a bare ESM import of a CJS file gets a second module instance under
// vite-node — the router's module state would diverge from ours).
const require = createRequire(import.meta.url);

const express = require('express');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const request = require('supertest');
const Database = require('better-sqlite3');

const usersDb = require('../../server/security/users-db.js');
const adminState = require('../../server/security/admin-state.js');
const ServerEventLog = require('../../server/core/server-event-log.js');
const securityMiddleware = require('../../security/middleware.js');
const securityRoutes = require('../../security/routes.js');
const authRoutes = require('../../server/security/auth-routes.js');

// ─── Sessions DB seeding (production row shape: sid / sess JSON / expire ISO)
// The /api/security/sessions family reads this table directly instead of the
// live express-session store, so rows are seeded exactly the way the
// production SqliteStore keeps them (tests/server/auth-routes.test.js does
// the same for its revoker coverage).
const sessionsDbPath = join(dataDir, 'data', 'sessions.db');

function withSessionsDb(fn) {
  const db = new Database(sessionsDbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function seedSessionRow(sid, sess, expireAt = Date.now() + 3600 * 1000) {
  withSessionsDb((db) => {
    db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT NOT NULL PRIMARY KEY, sess TEXT NOT NULL, expire TEXT NOT NULL)');
    db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expire) VALUES (?, ?, ?)')
      .run(String(sid), typeof sess === 'string' ? sess : JSON.stringify(sess), new Date(expireAt).toISOString());
  });
}

function clearSessionRows() {
  if (!existsSync(sessionsDbPath)) return;
  withSessionsDb((db) => {
    db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT NOT NULL PRIMARY KEY, sess TEXT NOT NULL, expire TEXT NOT NULL)');
    db.exec('DELETE FROM sessions');
  });
}

function sessionRowExists(sid) {
  if (!existsSync(sessionsDbPath)) return false;
  return withSessionsDb((db) =>
    !!db.prepare('SELECT sid FROM sessions WHERE sid = ?').get(String(sid)));
}

// ─── Apps ───────────────────────────────────────────────────────────────────
// bareApp: the router's own contract — JSON bodies only, no session, no
// identity stamping. This is how tests/server/routes.test.js mounts it, and
// the shape under which the routes' own 401 branches are reachable.
let bareApp;
// fullApp: a 1:1 replica of the real server stack for /api/security —
// express.json -> cookieParser -> express-session (real MemoryStore) ->
// the identity stamping middleware from server/middleware.js (including the
// legacy single-user admin derivation) -> the real security chain from
// createSecurityMiddleware -> the real /api/auth router -> this router.
let fullApp;
const sessionStore = new session.MemoryStore();

function buildBareApp() {
  const a = express();
  a.use(express.json());
  a.use('/api/security', securityRoutes);
  return a;
}

function buildFullApp() {
  const a = express();
  a.use(express.json({ limit: '1mb' }));
  a.use(cookieParser());
  a.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 },
  }));
  // Identity resolution — replica of server/middleware.js: authenticated
  // sessions carry uid/role/uname; anonymous ones keep the legacy single-user
  // derivation, where adminEnabled grants admin ONLY while no accounts exist.
  a.use((req, res, next) => {
    const s = req.session;
    if (s && s.uid && s.uname) {
      const adminRole = s.role === 'owner' || s.role === 'admin';
      req.user = {
        id: s.uid,
        uid: s.uid,
        role: adminRole ? 'admin' : 'user',
        uname: s.uname,
        suspended: !!s.suspended,
        locked: !!s.lockedAt,
      };
    } else {
      let legacyAdmin = false;
      try {
        legacyAdmin = !usersDb.hasAccounts() && adminState.isAdminEnabled();
      } catch (_) {
        legacyAdmin = adminState.isAdminEnabled();
      }
      req.user = { id: req.sessionID, role: legacyAdmin ? 'admin' : 'user' };
    }
    if (req.session) {
      req.session.user = req.user;
      req.session.lastIp = req.ip;
      req.session.lastUserAgent = req.get('user-agent') || null;
    }
    next();
  });
  // The real security chain the server installs (CSRF included — this is the
  // router-level guard every state-changing /api/security verb passes through).
  for (const mw of securityMiddleware.createSecurityMiddleware({
    enableCsrfProtection: true,
    enableIpBlocking: true,
    enableRequestValidation: true,
    enableInputSanitization: true,
  })) {
    a.use(mw);
  }
  a.use('/api/auth', authRoutes);
  a.use('/api/security', securityRoutes);
  return a;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function cookieSid(res) {
  const header = res.headers['set-cookie']?.[0];
  if (!header) return null;
  const m = header.match(/connect\.sid=([^;]+)/);
  if (!m) return null;
  const raw = decodeURIComponent(m[1]);
  return raw.startsWith('s:') ? raw.slice(2).split('.')[0] : raw.split('.')[0];
}

const storeGet = (sid) => new Promise((resolve, reject) => {
  sessionStore.get(sid, (err, sess) => (err ? reject(err) : resolve(sess)));
});

/** Anonymous browser session + its CSRF token, obtained the way the OS host
 * does: any first request through the security chain stamps and persists the
 * token on the fresh session (csrfTokenMiddleware). */
async function anonSession() {
  const agent = request.agent(fullApp);
  const res = await agent.get('/api/security/admin-mode');
  const sid = cookieSid(res);
  expect(sid).toBeTruthy();
  const sess = await storeGet(sid);
  expect(sess?.csrfToken).toMatch(/^[0-9a-f]{64}$/);
  return { agent, sid, csrf: sess.csrfToken };
}

/** First-boot world: only the owner account exists and is logged in. */
async function ownerWorld() {
  const owner = request.agent(fullApp);
  const setup = await owner.post('/api/auth/setup')
    .send({ displayName: 'Ada Lovelace', username: 'ada', pin: '123456' });
  expect(setup.status).toBe(200);
  expect(setup.body.success).toBe(true);
  return {
    owner,
    ownerCsrf: setup.body.data.csrfToken,
    ownerUid: setup.body.data.user.uid,
    ownerSid: setup.body.data.sessionId,
  };
}

/** Multi-user world: owner (admin) + sam (standard), both with live sessions. */
async function world() {
  const w = await ownerWorld();
  const samCreate = await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
    .send({ displayName: 'Sam Smith', username: 'sam', pin: '4321', role: 'standard' });
  expect(samCreate.status).toBe(200);
  const samUid = samCreate.body.data.user.uid;
  const sam = request.agent(fullApp);
  const samLogin = await sam.post('/api/auth/login').send({ username: 'sam', secret: '4321' });
  expect(samLogin.status).toBe(200);
  expect(samLogin.body.success).toBe(true);
  return {
    ...w,
    sam,
    samCsrf: samLogin.body.data.csrfToken,
    samSid: samLogin.body.data.sessionId,
    samUid,
  };
}

/** Seeds entries into the ServerEventLog ring buffer the audit routes read. */
function seedAudit(entries) {
  return entries.map((e) => ServerEventLog.log({
    app: e.app || 'SecurityRoutes',
    severity: e.severity || 'info',
    message: e.message || '',
    data: e.data || null,
  }));
}

const adminStatePath = () => join(dataDir, 'data', 'admin-state.json');

// ─── Lifecycle ──────────────────────────────────────────────────────────────

beforeAll(() => {
  bareApp = buildBareApp();
  fullApp = buildFullApp();
});

beforeEach(() => {
  // First-boot state for every test: no accounts, admin mode off, no live
  // sessions, no seeded session rows, no events, no blocked IPs, and the
  // security middleware back at its production configuration.
  usersDb.wipeAll(null);
  adminState.setAdminEnabled(false);
  sessionStore.clear();
  clearSessionRows();
  ServerEventLog.clear();
  for (const ip of securityMiddleware.getBlockedIPs()) {
    securityMiddleware.unblockIP(ip);
  }
  securityMiddleware.configure({ enableIpBlocking: true });
});

afterAll(() => {
  try { adminState.setAdminEnabled(false); } catch (_) { /* temp dir may be gone */ }
  try { usersDb.close(); } catch (_) { /* already closed */ }
  rmSync(dataDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
});

// ─── /admin-mode — bare router mount ────────────────────────────────────────

describe('security/routes.js — /admin-mode on the bare router', () => {
  it('GET /admin-mode reports the persisted admin flag (false on a fresh data dir)', async () => {
    const res = await request(bareApp).get('/api/security/admin-mode');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, adminEnabled: false });
  });

  it('POST /admin-mode flips the flag on an account-less machine and persists it to disk', async () => {
    const on = await request(bareApp).post('/api/security/admin-mode').send({ enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ success: true, adminEnabled: true });

    // Side effect: the atomic state file on disk carries the new value.
    expect(JSON.parse(readFileSync(adminStatePath(), 'utf8'))).toEqual({ adminEnabled: true });

    const read = await request(bareApp).get('/api/security/admin-mode');
    expect(read.body.adminEnabled).toBe(true);

    const off = await request(bareApp).post('/api/security/admin-mode').send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ success: true, adminEnabled: false });
  });

  it('POST /admin-mode rejects a missing enabled field with 400', async () => {
    const res = await request(bareApp).post('/api/security/admin-mode').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation Failed');
    expect(res.body.details[0]).toMatchObject({ field: 'enabled', location: 'body' });
    expect(res.body.details[0].message).toContain('enabled is required');
  });

  it('POST /admin-mode rejects a non-boolean enabled value with 400', async () => {
    const res = await request(bareApp).post('/api/security/admin-mode').send({ enabled: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.details[0]).toMatchObject({ field: 'enabled', location: 'body' });
    expect(res.body.details[0].message).toContain('must be of type boolean');
  });
});

// ─── /admin-mode — full server stack ────────────────────────────────────────

describe('security/routes.js — /admin-mode behind the real server stack', () => {
  it('POST /admin-mode without a CSRF token is rejected by the mounted security chain', async () => {
    await anonSession();
    const res = await request(fullApp).post('/api/security/admin-mode').send({ enabled: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_MISSING');
  });

  it('a valid CSRF token lets an anonymous first-boot session toggle admin mode', async () => {
    const anon = await anonSession();
    const res = await anon.agent.post('/api/security/admin-mode')
      .set('X-CSRF-Token', anon.csrf)
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, adminEnabled: true });

    // Real side effect: with no accounts and admin mode on, the identity
    // middleware now grants the anonymous session the admin role.
    const settings = await anon.agent.get('/api/security/settings');
    expect(settings.status).toBe(200);
    expect(settings.body.data._meta).toBeDefined();
    expect(settings.body.data.passwordMinLength).toBe(8);

    const off = await anon.agent.post('/api/security/admin-mode')
      .set('X-CSRF-Token', anon.csrf)
      .send({ enabled: false });
    expect(off.body.adminEnabled).toBe(false);

    const settingsAfter = await anon.agent.get('/api/security/settings');
    expect(settingsAfter.body.data._meta).toBeUndefined();
  });

  it('on a multi-user machine an anonymous session cannot flip admin mode (403 ADMIN_REQUIRED)', async () => {
    await world();
    const anon = await anonSession();
    const res = await anon.agent.post('/api/security/admin-mode')
      .set('X-CSRF-Token', anon.csrf)
      .send({ enabled: true });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'Forbidden',
      code: 'ADMIN_REQUIRED',
    });
    expect(res.body.message).toContain('administrator account is required');
    expect(adminState.isAdminEnabled()).toBe(false);
  });

  it('on a multi-user machine a standard-tier session cannot flip admin mode (403 ADMIN_REQUIRED)', async () => {
    const w = await world();
    const res = await w.sam.post('/api/security/admin-mode')
      .set('X-CSRF-Token', w.samCsrf)
      .send({ enabled: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
    expect(adminState.isAdminEnabled()).toBe(false);
  });

  it('on a multi-user machine the owner (admin with a real session) can flip admin mode', async () => {
    const w = await world();
    const on = await w.owner.post('/api/security/admin-mode')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ success: true, adminEnabled: true });
    expect(adminState.isAdminEnabled()).toBe(true);

    const off = await w.owner.post('/api/security/admin-mode')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.adminEnabled).toBe(false);
  });
});

// ─── GET /audit ─────────────────────────────────────────────────────────────

describe('security/routes.js — GET /audit', () => {
  it('an admin sees every audit entry, newest first, with default pagination', async () => {
    const w = await ownerWorld();
    const entries = seedAudit([
      { data: { action: 'login_attempt', userId: 'u-a', resource: 'auth', success: true } },
      { data: { action: 'config_change', userId: 'u-b', resource: 'settings', success: true } },
      { data: { action: 'security_event', userId: 'u-a', resource: 'report', success: false }, severity: 'warn' },
    ]);
    const res = await w.owner.get('/api/security/audit');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.data[0].id).toBe(entries[2].id);
    expect(res.body.data[2].id).toBe(entries[0].id);
    expect(res.body.pagination).toEqual({ limit: 100, offset: 0, total: 3 });
    expect(res.body.statistics.total).toBe(3);
    expect(res.body.statistics.bySeverity).toEqual({ info: 2, warn: 1 });
    expect(res.body.statistics.byApp.SecurityRoutes).toBe(3);
  });

  // DOCUMENTS CURRENT BEHAVIOR (source bug — see final report): routes.js
  // line 383 tries to force req.query.userId = req.user?.id for non-admins,
  // but Express 5's req.query is a getter that re-parses the URL on every
  // access, so the mutation never sticks and the userId filter stays
  // undefined. A non-admin therefore receives the FULL audit log, not just
  // their own entries. (Verified directly: req.query !== req.query in 5.3.)
  it('a non-admin is supposed to be scoped to their own entries — the forced filter currently never applies', async () => {
    const w = await world();
    seedAudit([
      { data: { action: 'login_attempt', userId: w.samUid, resource: 'auth', success: true } },
      { data: { action: 'login_attempt', userId: 'u-someone-else', resource: 'auth', success: true } },
    ]);
    const res = await w.sam.get('/api/security/audit');
    expect(res.status).toBe(200);
    // The other user's entry leaks through to the standard-tier session.
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.some((e) => e.data.userId === 'u-someone-else')).toBe(true);
  });

  it('an explicit userId query filter does apply for a non-admin', async () => {
    const w = await world();
    seedAudit([
      { data: { action: 'login_attempt', userId: w.samUid, resource: 'auth', success: true } },
      { data: { action: 'login_attempt', userId: 'u-someone-else', resource: 'auth', success: true } },
    ]);
    const res = await w.sam.get(`/api/security/audit?userId=${w.samUid}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].data.userId).toBe(w.samUid);
  });

  it('rejects a non-numeric limit with 400 before querying', async () => {
    const w = await ownerWorld();
    const res = await w.owner.get('/api/security/audit?limit=abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation Failed');
    expect(res.body.details[0]).toMatchObject({ field: 'limit', location: 'query' });
    expect(res.body.details[0].message).toContain('non-negative integer');
  });

  it('rejects a non-numeric offset with 400', async () => {
    const w = await ownerWorld();
    const res = await w.owner.get('/api/security/audit?offset=12x');
    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('offset');
  });

  it('rejects an array-valued query parameter with 400 (query type validation)', async () => {
    const w = await ownerWorld();
    const res = await w.owner.get('/api/security/audit?userId=a&userId=b');
    expect(res.status).toBe(400);
    expect(res.body.details[0]).toMatchObject({ field: 'userId', location: 'query' });
    expect(res.body.details[0].message).toContain('must be of type string');
  });

  it('applies limit and offset to the newest-first result window', async () => {
    const w = await ownerWorld();
    const entries = seedAudit([
      { data: { action: 'a1', resource: 'r', success: true } },
      { data: { action: 'a2', resource: 'r', success: true } },
      { data: { action: 'a3', resource: 'r', success: true } },
    ]);
    const page1 = await w.owner.get('/api/security/audit?limit=2');
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.pagination).toEqual({ limit: 2, offset: 0, total: 2 });
    expect(page1.body.data.map((e) => e.id)).toEqual([entries[2].id, entries[1].id]);

    // page1's own handler appended an audit_logs entry to the ring buffer,
    // so the next request sees 4 entries newest-first: [page1Log, a3, a2, a1].
    const page2 = await w.owner.get('/api/security/audit?limit=2&offset=2');
    expect(page2.body.data).toHaveLength(2);
    expect(page2.body.data.map((e) => e.id)).toEqual([entries[1].id, entries[0].id]);

    const newest = await w.owner.get('/api/security/audit?limit=1');
    expect(newest.body.data).toHaveLength(1);
    expect(newest.body.data[0].data.resource).toBe('audit_logs');
  });

  it('filters by level (severity)', async () => {
    const w = await ownerWorld();
    seedAudit([
      { data: { action: 'x', resource: 'r', success: true } },
      { data: { action: 'y', resource: 'r', success: false }, severity: 'warn' },
    ]);
    const res = await w.owner.get('/api/security/audit?level=warn');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].severity).toBe('warn');
  });

  it('filters by success=true / success=false', async () => {
    const w = await ownerWorld();
    seedAudit([
      { data: { action: 'ok', resource: 'r', success: true } },
      { data: { action: 'bad', resource: 'r', success: false }, severity: 'warn' },
    ]);
    const ok = await w.owner.get('/api/security/audit?success=true');
    expect(ok.body.data).toHaveLength(1);
    expect(ok.body.data[0].data.action).toBe('ok');
    const bad = await w.owner.get('/api/security/audit?success=false');
    expect(bad.body.data).toHaveLength(1);
    expect(bad.body.data[0].data.action).toBe('bad');
  });

  it('filters by action and resource', async () => {
    const w = await ownerWorld();
    seedAudit([
      { data: { action: 'login_attempt', resource: 'auth', success: true } },
      { data: { action: 'config_change', resource: 'settings', success: true } },
    ]);
    const byAction = await w.owner.get('/api/security/audit?action=login_attempt');
    expect(byAction.body.data).toHaveLength(1);
    expect(byAction.body.data[0].data.action).toBe('login_attempt');
    const byResource = await w.owner.get('/api/security/audit?resource=settings');
    expect(byResource.body.data).toHaveLength(1);
    expect(byResource.body.data[0].data.resource).toBe('settings');
  });

  it('filters by userId', async () => {
    const w = await ownerWorld();
    seedAudit([
      { data: { action: 'a', resource: 'r', userId: 'u-keep', success: true } },
      { data: { action: 'a', resource: 'r', userId: 'u-drop', success: true } },
    ]);
    const res = await w.owner.get('/api/security/audit?userId=u-keep');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].data.userId).toBe('u-keep');
  });

  it('date-window filters exclude everything when the window cannot match', async () => {
    const w = await ownerWorld();
    seedAudit([
      { data: { action: 'a', resource: 'r', success: true } },
      { data: { action: 'b', resource: 'r', success: true } },
    ]);
    const future = await w.owner.get(`/api/security/audit?startDate=${encodeURIComponent(new Date(Date.now() + 60000).toISOString())}`);
    expect(future.body.data).toEqual([]);
    const past = await w.owner.get(`/api/security/audit?endDate=${encodeURIComponent('2000-01-01T00:00:00.000Z')}`);
    expect(past.body.data).toEqual([]);
  });
});

// ─── GET /sessions ──────────────────────────────────────────────────────────

describe('security/routes.js — GET /sessions', () => {
  // NOTE ON ORDER: this first test must run before any seedSessionRow call —
  // it exercises the branch where sessions.db exists (lazily created by the
  // router's own connection) but has no `sessions` table yet.
  it('returns an empty list when the sessions table does not exist yet (fresh install)', async () => {
    const w = await ownerWorld();
    const res = await w.owner.get('/api/security/sessions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: [], count: 0 });
  });

  it('requires authentication (401) when no identity middleware is mounted', async () => {
    const res = await request(bareApp).get('/api/security/sessions');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthorized', message: 'Authentication required' });
  });

  it('an admin sees every non-expired session with parsed identity metadata', async () => {
    const w = await world();
    // Seed with the SAME timestamp the assertion checks — recomputing
    // Date.now() in both places flakes by a millisecond.
    const futureAt = Date.now() + 3600 * 1000;
    const future = new Date(futureAt).toISOString();
    seedSessionRow('sess-alpha', {
      user: { id: 'u-1', role: 'admin' },
      lastIp: '10.1.1.1',
      lastUserAgent: 'UA-Alpha',
      cookie: {},
    }, futureAt);
    seedSessionRow('sess-beta', 'this is not json {');
    seedSessionRow('sess-gamma', { user: { id: 'u-3' } }, Date.now() - 3600 * 1000); // expired
    seedSessionRow(w.ownerSid, { user: { id: w.ownerUid, role: 'admin' }, cookie: {} });

    const res = await w.owner.get('/api/security/sessions');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3); // gamma is expired and must be excluded
    const byId = Object.fromEntries(res.body.data.map((s) => [s.id, s]));

    expect(byId['sess-alpha']).toMatchObject({
      userId: 'u-1',
      role: 'admin',
      ipAddress: '10.1.1.1',
      userAgent: 'UA-Alpha',
      expiresAt: future.slice(0, future.length), // ISO string as stored
      current: false,
    });
    // A corrupt sess blob degrades to null metadata instead of failing the listing.
    expect(byId['sess-beta']).toMatchObject({ userId: null, role: null, ipAddress: null, userAgent: null });
    // The admin's own live session is flagged current.
    expect(byId[w.ownerSid]).toMatchObject({ userId: w.ownerUid, role: 'admin', current: true });
    expect(res.body.data.some((s) => s.id === 'sess-gamma')).toBe(false);
  });

  it('a non-admin only sees their own session, flagged current', async () => {
    const w = await world();
    seedSessionRow('sess-alpha', { user: { id: 'u-1' } });
    seedSessionRow(w.samSid, { user: { id: w.samUid, role: 'user' }, cookie: {} });
    const res = await w.sam.get('/api/security/sessions');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0]).toMatchObject({ id: w.samSid, userId: w.samUid, current: true });
  });

  it('an anonymous session also sees only itself', async () => {
    const anon = await anonSession();
    seedSessionRow('sess-alpha', { user: { id: 'u-1' } });
    seedSessionRow(anon.sid, { user: { id: anon.sid, role: 'user' }, cookie: {} });
    const res = await anon.agent.get('/api/security/sessions');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].id).toBe(anon.sid);
  });
});

// ─── DELETE /sessions/:id ───────────────────────────────────────────────────

describe('security/routes.js — DELETE /sessions/:id', () => {
  it('requires authentication (401) when no identity middleware is mounted', async () => {
    const res = await request(bareApp).delete('/api/security/sessions/whatever');
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Authentication required');
  });

  it('returns 404 for an unknown session id', async () => {
    const w = await world();
    const res = await w.owner.delete('/api/security/sessions/sess-nope')
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Not Found', message: 'Session not found' });
  });

  it('a non-admin cannot revoke someone else\'s session (403) and the row survives', async () => {
    const w = await world();
    seedSessionRow('sess-alpha', { user: { id: 'u-1' } });
    const res = await w.sam.delete('/api/security/sessions/sess-alpha')
      .set('X-CSRF-Token', w.samCsrf);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Forbidden', message: 'Cannot revoke other user sessions' });
    expect(sessionRowExists('sess-alpha')).toBe(true);
  });

  it('a user can revoke their own session and the row is deleted from the store', async () => {
    const w = await world();
    seedSessionRow(w.samSid, { user: { id: w.samUid, role: 'user' }, cookie: {} });
    const res = await w.sam.delete(`/api/security/sessions/${w.samSid}`)
      .set('X-CSRF-Token', w.samCsrf);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, message: 'Session revoked successfully' });
    expect(sessionRowExists(w.samSid)).toBe(false);
  });

  it('an admin can revoke another user\'s session', async () => {
    const w = await world();
    seedSessionRow(w.samSid, { user: { id: w.samUid, role: 'user' }, cookie: {} });
    const res = await w.owner.delete(`/api/security/sessions/${w.samSid}`)
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(res.status).toBe(200);
    expect(sessionRowExists(w.samSid)).toBe(false);

    // And it disappears from the admin's own listing.
    const list = await w.owner.get('/api/security/sessions');
    expect(list.body.data.some((s) => s.id === w.samSid)).toBe(false);
  });

  it('returns 500 when the sessions store is write-locked by another connection', { timeout: 30000 }, async () => {
    const w = await world();
    seedSessionRow('sess-locked', { user: { id: 'u-9' } });

    // A second SQLite connection holds an EXCLUSIVE write transaction: under
    // WAL the router's SELECT still succeeds, but its DELETE hits SQLITE_BUSY
    // after the 5s busy timeout — the route's catch turns that into a 500.
    const blocker = new Database(sessionsDbPath);
    blocker.pragma('busy_timeout = 30000');
    blocker.exec('BEGIN EXCLUSIVE');
    try {
      const res = await w.owner.delete('/api/security/sessions/sess-locked')
        .set('X-CSRF-Token', w.ownerCsrf);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal Server Error', message: 'Failed to revoke session' });
      expect(sessionRowExists('sess-locked')).toBe(true);
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
  });
});

// ─── POST /report ───────────────────────────────────────────────────────────

describe('security/routes.js — POST /report', () => {
  it('accepts a well-formed report and records it in the audit trail', async () => {
    const w = await ownerWorld();
    const res = await w.owner.post('/api/security/report')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ type: 'phishing', description: 'Received an email asking for my PIN' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('Report submitted successfully');
    expect(res.body.reportId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // Side effect: the report is queryable through the audit surface.
    const audit = await w.owner.get('/api/security/audit?resource=security_report');
    expect(audit.body.data).toHaveLength(1);
    expect(audit.body.data[0].data.resourceId).toBe(res.body.reportId);
    expect(audit.body.data[0].data.metadata.reportType).toBe('phishing');
  });

  it('accepts optional evidence, ipAddress and timestamp fields', async () => {
    const anon = await anonSession();
    const res = await anon.agent.post('/api/security/report')
      .set('X-CSRF-Token', anon.csrf)
      .send({
        type: 'malware',
        description: 'Found a suspicious binary on disk',
        evidence: { file: '/tmp/x', hash: 'abc' },
        ipAddress: '203.0.113.5',
        timestamp: '2026-01-01T00:00:00.000Z',
      });
    expect(res.status).toBe(201);
    expect(res.body.reportId).toBeTruthy();
  });

  it('rejects validation failures: missing type, bad enum, short and oversized descriptions, wrong evidence type', async () => {
    const anon = await anonSession();
    const post = (body) => anon.agent.post('/api/security/report').set('X-CSRF-Token', anon.csrf).send(body);

    const noType = await post({ description: 'A validly long description' });
    expect(noType.status).toBe(400);
    expect(noType.body.details[0].field).toBe('type');
    expect(noType.body.details[0].message).toContain('type is required');

    const badEnum = await post({ type: 'spam', description: 'A validly long description' });
    expect(badEnum.status).toBe(400);
    expect(badEnum.body.details[0].message).toContain('must be one of');

    const short = await post({ type: 'other', description: 'too short' });
    expect(short.status).toBe(400);
    expect(short.body.details[0].message).toContain('at least 10 characters');

    const long = await post({ type: 'other', description: 'x'.repeat(2001) });
    expect(long.status).toBe(400);
    expect(long.body.details[0].message).toContain('at most 2000 characters');

    const badEvidence = await post({ type: 'other', description: 'A validly long description', evidence: 'not-an-object' });
    expect(badEvidence.status).toBe(400);
    expect(badEvidence.body.details[0].message).toContain('must be of type object');
  });

  it('suspicious_login reports without an ipAddress do not feed the lockout counter', async () => {
    const anon = await anonSession();
    for (let i = 0; i < 6; i++) {
      const res = await anon.agent.post('/api/security/report')
        .set('X-CSRF-Token', anon.csrf)
        .send({ type: 'suspicious_login', description: 'Someone tried to log in as me' });
      expect(res.status).toBe(201);
    }
    expect(securityMiddleware.getBlockedIPs()).toEqual([]);
  });

  it('five suspicious_login reports for the same IP auto-block it end to end', async () => {
    const w = await ownerWorld();
    const anon = await anonSession();
    const attackerIp = '203.0.113.66';

    for (let i = 0; i < 5; i++) {
      const res = await anon.agent.post('/api/security/report')
        .set('X-CSRF-Token', anon.csrf)
        .set('X-Forwarded-For', attackerIp)
        .send({ type: 'suspicious_login', description: 'Failed login attempt seen', ipAddress: attackerIp });
      expect(res.status).toBe(201);
    }

    // The IP now appears in the admin blocklist...
    const list = await w.owner.get('/api/security/blocked-ips');
    expect(list.body.data).toContain(attackerIp);

    // ...and requests originating from that IP are refused by the live chain.
    const blocked = await anon.agent.get('/api/security/admin-mode')
      .set('X-Forwarded-For', attackerIp);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ error: 'Access Denied', code: 'IP_BLOCKED' });

    // Unblocking through the API restores access.
    const unblock = await w.owner.delete(`/api/security/blocked-ips/${attackerIp}`)
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(unblock.status).toBe(200);
    const after = await anon.agent.get('/api/security/admin-mode')
      .set('X-Forwarded-For', attackerIp);
    expect(after.status).toBe(200);
  });
});

// ─── GET/PUT /settings ──────────────────────────────────────────────────────

describe('security/routes.js — GET/PUT /settings', () => {
  it('a non-admin gets only the reduced public settings payload', async () => {
    const w = await world();
    const res = await w.sam.get('/api/security/settings');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(['maxConcurrentSessions', 'sessionTimeout', 'tfaRequired']);
  });

  it('an admin gets the full settings plus the editable-field metadata', async () => {
    const w = await ownerWorld();
    const res = await w.owner.get('/api/security/settings');
    expect(res.status).toBe(200);
    expect(res.body.data.passwordMinLength).toBe(8);
    expect(res.body.data.maxLoginAttempts).toBe(5);
    expect(res.body.data.csrfEnabled).toBe(true);
    expect(res.body.data._meta.editable).toContain('passwordMinLength');
    expect(res.body.data._meta.editable).toContain('csrfEnabled');
  });

  it('an anonymous first-boot session with admin mode enabled also sees the full settings', async () => {
    const anon = await anonSession();
    const on = await anon.agent.post('/api/security/admin-mode')
      .set('X-CSRF-Token', anon.csrf)
      .send({ enabled: true });
    expect(on.status).toBe(200);
    const res = await anon.agent.get('/api/security/settings');
    expect(res.body.data._meta).toBeDefined();
    expect(res.body.data.sessionTimeout).toBe(24 * 60 * 60 * 1000);
  });

  it('a non-admin cannot update settings (403)', async () => {
    const w = await world();
    const res = await w.sam.put('/api/security/settings')
      .set('X-CSRF-Token', w.samCsrf)
      .send({ maxLoginAttempts: 3 });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Admin access required to modify security settings');
  });

  it('an admin can update a numeric setting and read the new value back', async () => {
    const w = await ownerWorld();
    const update = await w.owner.put('/api/security/settings')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ maxLoginAttempts: 3 });
    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({ success: true, updated: ['maxLoginAttempts'] });

    const readBack = await w.owner.get('/api/security/settings');
    expect(readBack.body.data.maxLoginAttempts).toBe(3);

    // Restore the default through the same public surface.
    const restore = await w.owner.put('/api/security/settings')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ maxLoginAttempts: 5 });
    expect(restore.status).toBe(200);
  });

  it('rejects out-of-range and wrongly-typed update payloads with 400', async () => {
    const w = await ownerWorld();
    const put = (body) => w.owner.put('/api/security/settings')
      .set('X-CSRF-Token', w.ownerCsrf).send(body);

    const tooSmall = await put({ passwordMinLength: 5 });
    expect(tooSmall.status).toBe(400);
    expect(tooSmall.body.details[0].message).toContain('passwordMinLength must be at least 8');

    const tooBig = await put({ maxLoginAttempts: 99 });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.details[0].message).toContain('maxLoginAttempts must be at most 10');

    const wrongType = await put({ passwordMinLength: '8' });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.details[0].message).toContain('must be of type number');

    const sessionTimeout = await put({ sessionTimeout: 1000 });
    expect(sessionTimeout.status).toBe(400);
    expect(sessionTimeout.body.details[0].message).toContain('sessionTimeout must be at least 3600000');
  });

  it('disabling IP blocking through settings immediately stops the live IP block', async () => {
    const w = await ownerWorld();
    const block = await w.owner.post('/api/security/blocked-ips')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ ip: '198.51.100.9', reason: 'test' });
    expect(block.status).toBe(201);

    const anon = await anonSession();
    const stillBlocked = await anon.agent.get('/api/security/admin-mode')
      .set('X-Forwarded-For', '198.51.100.9');
    expect(stillBlocked.status).toBe(403);

    const update = await w.owner.put('/api/security/settings')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ enableIPBlocking: false });
    expect(update.status).toBe(200);
    expect(update.body.updated).toContain('enableIPBlocking');

    const nowAllowed = await anon.agent.get('/api/security/admin-mode')
      .set('X-Forwarded-For', '198.51.100.9');
    expect(nowAllowed.status).toBe(200);

    // Restore through the same public surface.
    const restore = await w.owner.put('/api/security/settings')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ enableIPBlocking: true });
    expect(restore.status).toBe(200);
  });

  // Documents current behavior: the editable allowlist is read from
  // securitySettings._meta, which is only ever attached to the GET response's
  // copy — never to the stored settings object — so the PUT filter accepts
  // any field that passes validation, including unknown keys.
  it('persists unknown keys: the _meta.editable allowlist never actually applies', async () => {
    const w = await ownerWorld();
    const res = await w.owner.put('/api/security/settings')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ novelField: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual(['novelField']);

    const readBack = await w.owner.get('/api/security/settings');
    expect(readBack.body.data.novelField).toBe('x');
  });
});

// ─── /blocked-ips ───────────────────────────────────────────────────────────

describe('security/routes.js — /blocked-ips', () => {
  it('GET /blocked-ips is admin-only (403 for a standard session)', async () => {
    const w = await world();
    const res = await w.sam.get('/api/security/blocked-ips');
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Admin access required');
  });

  it('GET /blocked-ips starts empty and reflects blocked IPs after they are added', async () => {
    const w = await ownerWorld();
    const empty = await w.owner.get('/api/security/blocked-ips');
    expect(empty.body).toEqual({ success: true, data: [], count: 0 });

    const block = await w.owner.post('/api/security/blocked-ips')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ ip: '198.51.100.7', reason: 'repeated abuse' });
    expect(block.status).toBe(201);
    expect(block.body.message).toBe('IP 198.51.100.7 blocked successfully');

    const list = await w.owner.get('/api/security/blocked-ips');
    expect(list.body.count).toBe(1);
    expect(list.body.data).toEqual(['198.51.100.7']);
  });

  it('blocking an IP through the API really blocks subsequent requests from it', async () => {
    const w = await ownerWorld();
    const block = await w.owner.post('/api/security/blocked-ips')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ ip: '192.0.2.44' });
    expect(block.status).toBe(201);

    const anon = await anonSession();
    const hit = await anon.agent.get('/api/security/admin-mode')
      .set('X-Forwarded-For', '192.0.2.44');
    expect(hit.status).toBe(403);
    expect(hit.body).toMatchObject({ error: 'Access Denied', code: 'IP_BLOCKED' });
    expect(hit.body.message).toBe('Your IP address has been blocked');

    const other = await anon.agent.get('/api/security/admin-mode')
      .set('X-Forwarded-For', '192.0.2.45');
    expect(other.status).toBe(200);
  });

  it('POST /blocked-ips is admin-only (403) even with a valid payload', async () => {
    const w = await world();
    const res = await w.sam.post('/api/security/blocked-ips')
      .set('X-CSRF-Token', w.samCsrf)
      .send({ ip: '192.0.2.50' });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Admin access required');
  });

  it('POST /blocked-ips validates the payload (ip required, string; reason <= 500)', async () => {
    const w = await ownerWorld();
    const post = (body) => w.owner.post('/api/security/blocked-ips')
      .set('X-CSRF-Token', w.ownerCsrf).send(body);

    const missing = await post({});
    expect(missing.status).toBe(400);
    expect(missing.body.details[0].message).toContain('ip is required');

    const wrongType = await post({ ip: 12345 });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.details[0].message).toContain('ip must be of type string');

    const longReason = await post({ ip: '192.0.2.51', reason: 'r'.repeat(501) });
    expect(longReason.status).toBe(400);
    expect(longReason.body.details[0].message).toContain('at most 500 characters');
  });

  it('POST /blocked-ips refuses to double-block an already blocked IP (400)', async () => {
    const w = await ownerWorld();
    const first = await w.owner.post('/api/security/blocked-ips')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ ip: '192.0.2.52' });
    expect(first.status).toBe(201);
    const second = await w.owner.post('/api/security/blocked-ips')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ ip: '192.0.2.52' });
    expect(second.status).toBe(400);
    expect(second.body.message).toBe('IP already blocked');
  });

  it('DELETE /blocked-ips/:ip is admin-only (403)', async () => {
    const w = await world();
    const res = await w.sam.delete('/api/security/blocked-ips/192.0.2.53')
      .set('X-CSRF-Token', w.samCsrf);
    expect(res.status).toBe(403);
  });

  it('DELETE /blocked-ips/:ip returns 404 for an IP that is not blocked', async () => {
    const w = await ownerWorld();
    const res = await w.owner.delete('/api/security/blocked-ips/192.0.2.54')
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('IP not found in blocklist');
  });

  it('DELETE /blocked-ips/:ip unblocks and traffic from that IP flows again', async () => {
    const w = await ownerWorld();
    await w.owner.post('/api/security/blocked-ips')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ ip: '192.0.2.55', reason: 'temporary' });

    const anon = await anonSession();
    const blocked = await anon.agent.get('/api/security/admin-mode')
      .set('X-Forwarded-For', '192.0.2.55');
    expect(blocked.status).toBe(403);

    const unblock = await w.owner.delete('/api/security/blocked-ips/192.0.2.55')
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(unblock.status).toBe(200);
    expect(unblock.body.message).toBe('IP 192.0.2.55 unblocked successfully');

    const list = await w.owner.get('/api/security/blocked-ips');
    expect(list.body.data).toEqual([]);

    const allowed = await anon.agent.get('/api/security/admin-mode')
      .set('X-Forwarded-For', '192.0.2.55');
    expect(allowed.status).toBe(200);
  });
});

// ─── /suspicious ────────────────────────────────────────────────────────────

describe('security/routes.js — /suspicious', () => {
  it('GET /suspicious is admin-only (403)', async () => {
    const w = await world();
    const res = await w.sam.get('/api/security/suspicious');
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Admin access required');
  });

  it('GET /suspicious returns the (currently stubbed, empty) activity list for an admin', async () => {
    const w = await ownerWorld();
    const res = await w.owner.get('/api/security/suspicious?status=pending&type=phishing&userId=u-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: [], count: 0 });
  });

  it('PATCH /suspicious/:id is admin-only (403)', async () => {
    const w = await world();
    const res = await w.sam.patch('/api/security/suspicious/sa-1')
      .set('X-CSRF-Token', w.samCsrf)
      .send({ status: 'investigating' });
    expect(res.status).toBe(403);
  });

  it('PATCH /suspicious/:id validates the status payload', async () => {
    const w = await ownerWorld();
    const missing = await w.owner.patch('/api/security/suspicious/sa-1')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({});
    expect(missing.status).toBe(400);
    expect(missing.body.details[0].message).toContain('status is required');

    const badEnum = await w.owner.patch('/api/security/suspicious/sa-1')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ status: 'wont-do' });
    expect(badEnum.status).toBe(400);
    expect(badEnum.body.details[0].message).toContain('must be one of');

    const longNotes = await w.owner.patch('/api/security/suspicious/sa-1')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ status: 'resolved', notes: 'n'.repeat(2001) });
    expect(longNotes.status).toBe(400);
    expect(longNotes.body.details[0].message).toContain('at most 2000 characters');
  });

  it('PATCH /suspicious/:id with a valid status still 404s (no activity store backing it yet)', async () => {
    const w = await ownerWorld();
    const res = await w.owner.patch('/api/security/suspicious/sa-1')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ status: 'investigating', notes: 'checked the logs' });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Suspicious activity not found');
  });
});

// ─── POST /export ───────────────────────────────────────────────────────────

describe('security/routes.js — POST /export', () => {
  it('is admin-only (403)', async () => {
    const w = await world();
    const res = await w.sam.post('/api/security/export')
      .set('X-CSRF-Token', w.samCsrf)
      .send({ format: 'json' });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Admin access required');
  });

  it('validates the format field (required, enum)', async () => {
    const w = await ownerWorld();
    const missing = await w.owner.post('/api/security/export')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({});
    expect(missing.status).toBe(400);
    expect(missing.body.details[0].message).toContain('format is required');

    const bad = await w.owner.post('/api/security/export')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ format: 'xml' });
    expect(bad.status).toBe(400);
    expect(bad.body.details[0].message).toContain('must be one of');
  });

  it('exports JSON with attachment headers and the full entry list', async () => {
    const w = await ownerWorld();
    const seeded = seedAudit([
      { data: { action: 'a', resource: 'r', success: true } },
      { data: { action: 'b', resource: 'r', success: true } },
    ]);
    const res = await w.owner.post('/api/security/export')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ format: 'json' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="audit-logs-\d+\.json"/);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((e) => e.id).sort()).toEqual(seeded.map((e) => e.id).sort());
  });

  it('exports CSV with a header row, quoted cells and formula-injection guards', async () => {
    const w = await ownerWorld();
    seedAudit([
      { app: '=evil', message: 'a,b', data: { action: 'a', resource: 'r', success: true } },
      { app: '=combo,x', message: 'plain', data: { action: 'b', resource: 'r', success: true } },
    ]);
    const res = await w.owner.post('/api/security/export')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="audit-logs-\d+\.csv"/);

    const lines = res.text.split('\n');
    expect(lines[0]).toBe('id,timestamp,app,severity,message');
    expect(lines).toHaveLength(3);
    // Leading '=' is neutralized with a guard apostrophe...
    expect(res.text).toContain("'=evil");
    expect(res.text).not.toMatch(/(?:^|,)=evil/);
    // ...and a guarded cell that also contains a comma gets CSV-quoted.
    expect(res.text).toContain('"\'=combo,x"');
    // A message containing a comma/quote is JSON-encoded then quote-doubled.
    expect(res.text).toContain('"""a,b"""');
  });

  it('applies body filters to the export (userId passthrough, empty window)', async () => {
    const w = await ownerWorld();
    seedAudit([
      { data: { action: 'a', resource: 'r', userId: 'u-export', success: true } },
      { data: { action: 'b', resource: 'r', userId: 'u-other', success: true } },
    ]);
    const filtered = await w.owner.post('/api/security/export')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ format: 'json', userId: 'u-export' });
    expect(filtered.body).toHaveLength(1);
    expect(filtered.body[0].data.userId).toBe('u-export');

    const empty = await w.owner.post('/api/security/export')
      .set('X-CSRF-Token', w.ownerCsrf)
      .send({ format: 'json', startDate: new Date(Date.now() + 60000).toISOString() });
    expect(empty.body).toEqual([]);
  });
});
