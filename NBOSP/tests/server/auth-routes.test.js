import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// ─── Comprehensive e2e suite for server/security/auth-routes.js ──────────────
//
// Every route in the /api/auth router is exercised over real HTTP against a
// 1:1 replica of the production middleware stack (see buildApp below). The
// suite covers: first-boot setup + legacy migration, the full login lifecycle
// (success, failure, kinds, lockout ladder, disabled/locked accounts), session
// cookie issuance/expiry/bearer targeting, lock/suspend/reverify switching,
// self-service credential changes, the admin family (CRUD, lifecycle guards,
// credential reset, policies, audit events, usage), WebAuthn enrollment and
// assertion with REAL cryptographic material, and every validation branch.
//
// KNOWN SOURCE BUG (documented, NOT fixed — outside this suite's remit):
//   server/security/auth-routes.js:815 calls usersDb.touchLogin(uid), but
//   users-db.js keeps touchLogin PRIVATE (defined at line 840, absent from
//   module.exports). Every fully valid WebAuthn assertion therefore dies with
//   "TypeError: usersDb.touchLogin is not a function" and express answers 500
//   with an empty body. Several WebAuthn tests pin this current behavior and
//   name it in their titles; the fix is a one-line export in users-db.js.
//
// Isolation: throwaway data dir + throwaway HOME (see below) — nothing under
// the repo's real data/ or the real home directory is ever touched.
const dataDir = mkdtempSync(join(tmpdir(), 'nova-auth-e2e-'));
const homeDir = mkdtempSync(join(tmpdir(), 'nova-auth-home-'));
const envSnapshot = { ...process.env };
const originalHome = process.env.HOME;

process.env.NBOSP_DATA_DIR = dataDir;
process.env.NBOSP_CRED_KEY = 'e'.repeat(64);
process.env.SESSION_SECRET = 'f'.repeat(128);
process.env.HOME = homeDir;

// Same require registry for the whole router chain (push.test.js header: a
// bare ESM import of a CJS file gives a second instance under vite-node —
// the router's users-db mutations must hit OUR instance).
const require = createRequire(import.meta.url);
const nodeCrypto = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const cookieSignature = require('cookie-signature');
const request = require('supertest');
const Database = require('better-sqlite3');

// auth-routes computes its WebAuthn origin allow-list from PORT at require
// time — derive the test origin with the identical expression, BEFORE the
// router loads.
const ORIGIN = `http://localhost:${process.env.PORT || 3003}`;

const usersDb = require('../../server/security/users-db.js');
const adminState = require('../../server/security/admin-state.js');
const authRoutes = require('../../server/security/auth-routes.js');
const securityMiddleware = require('../../security/middleware.js');

// ─── Real session store + the real server's middleware order ───────────────
// server/core/index.js runs setupMiddleware(app) (body parsers → cookie
// parser → X-Nova-Session bearer → express-session → identity stamping →
// the security/ chain with CSRF) and then mountRoutes(app) which mounts this
// router at /api/auth. That stack is replicated here 1:1, with the REAL
// express-session MemoryStore instead of the SQLite one so Set-Cookie
// headers, regeneration, destruction and expiry behave for real.
const SID_RE = /^[A-Za-z0-9_-]{10,128}$/;
const sessionStore = new session.MemoryStore();

let app;

// Fidelity note: the production stack ALSO mounts the per-IP express-rate-limit
// tiers ahead of the body parsers (server/middleware.js — /api/auth/ gets a
// 30-attempts/min budget, skippable via server/rate-limit-auth.js' trusted
// system-app HMAC). Those are deliberately NOT replicated here: the limiter is
// an IP-tier externality with its own suite (tests/server/middleware-rate-limit
// .test.js), and a 30/min cap would starve this suite's own lockout-ladder
// flows. Everything between the body parsers and the router below is the real
// production chain, middleware for middleware.
function buildApp(store = sessionStore) {
  const a = express();
  a.use(express.json({ limit: '10mb' }));
  a.use(express.urlencoded({ extended: true }));
  a.use(cookieParser());

  // Bearer session targeting — replica of server/middleware.js: the trusted
  // host presents X-Nova-Session with the opaque sid issued by /api/auth/login
  // and the chain rewrites the cookie slot onto that sid before express-session
  // runs, so a second live session (user switching) stays reachable.
  a.use((req, res, next) => {
    const sid = req.get('x-nova-session');
    if (sid && SID_RE.test(sid) && process.env.SESSION_SECRET) {
      const signed = 's:' + cookieSignature.sign(sid, process.env.SESSION_SECRET);
      req.headers.cookie = `connect.sid=${encodeURIComponent(signed)}`;
      if (req.cookies && typeof req.cookies === 'object') {
        req.cookies['connect.sid'] = signed;
      }
      req.novaBearerSession = sid;
    }
    next();
  });

  a.use(session({
    store,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 },
  }));

  // Identity resolution — replica of server/middleware.js: authenticated
  // sessions carry uid/role/uname; anonymous ones stay standard-user.
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
      req.user = { id: req.sessionID, role: 'user' };
    }
    if (req.session) {
      req.session.user = req.user;
      req.session.lastIp = req.ip;
      req.session.lastUserAgent = req.get('user-agent') || null;
    }
    next();
  });

  // The security chain the real server installs (CSRF included). auth-routes
  // pushed the identity-verb exemptions into this same instance at require
  // time, so the exempt list is live here too.
  for (const mw of securityMiddleware.createSecurityMiddleware({
    enableCsrfProtection: true,
    enableIpBlocking: true,
    enableRequestValidation: true,
    enableInputSanitization: true,
  })) {
    a.use(mw);
  }

  a.use('/api/auth', authRoutes);
  return a;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function cookieSid(res) {
  const header = res.headers['set-cookie']?.[0];
  if (!header) return null;
  const m = header.match(/connect\.sid=([^;]+)/);
  if (!m) return null;
  const raw = decodeURIComponent(m[1]);
  return raw.startsWith('s:') ? raw.slice(2).split('.')[0] : raw.split('.')[0];
}

function signedCookie(sid, secret = process.env.SESSION_SECRET) {
  return 's:' + cookieSignature.sign(sid, secret);
}

/** Seeds a sessions.db row the way the production SqliteStore keeps it, so
 *  the router's registered session revoker (which deletes rows from that
 *  file) can be proven end to end. */
function seedSessionsDb(sid) {
  const db = new Database(join(dataDir, 'data', 'sessions.db'));
  db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT, expire INTEGER)');
  db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expire) VALUES (?, ?, ?)')
    .run(String(sid), '{}', Date.now() + 3600000);
  db.close();
  return sid;
}

function sessionsDbHas(sid) {
  const db = new Database(join(dataDir, 'data', 'sessions.db'));
  const row = db.prepare('SELECT sid FROM sessions WHERE sid = ?').get(String(sid));
  db.close();
  return row !== undefined;
}

/** A Proxy over the REAL MemoryStore whose destroy() can be told to fail —
 *  the only way an otherwise healthy request can reach the router's 500
 *  SESSION_ERROR arms (production hits them when the SQLite session store
 *  errors mid-login). This is store fault injection, i.e. an externality —
 *  no module under test is mocked. */
function flakySessionStore() {
  const memory = new session.MemoryStore();
  let broken = false;
  return {
    proxy: new Proxy(memory, {
      // NOTE: methods are returned UNBOUND so their receiver stays the proxy
      // — binding to the target would let Store#regenerate call
      // memory.destroy directly and bypass the fault injection.
      get(target, prop) {
        if (prop === 'destroy' && broken) {
          return (sid, cb) => cb(new Error('simulated session-store failure'));
        }
        return Reflect.get(target, prop);
      },
    }),
    fail() { broken = true; },
    heal() { broken = false; },
  };
}

function makeAuthData(counter, rpId = 'localhost') {
  const rpIdHash = nodeCrypto.createHash('sha256').update(rpId).digest();
  const ctr = Buffer.alloc(4);
  ctr.writeUInt32BE(counter, 0);
  return Buffer.concat([rpIdHash, Buffer.from([0x05]), ctr]);
}

function clientDataB64u(type, challenge, origin = ORIGIN) {
  return b64u(JSON.stringify({ type, challenge, origin }));
}

function assertionMessage(authData, clientDataJSONB64u) {
  return Buffer.concat([
    Buffer.from(authData),
    nodeCrypto.createHash('sha256').update(Buffer.from(clientDataJSONB64u, 'base64url')).digest(),
  ]);
}

/** DER ECDSA signature → the raw 64-byte r||s form real authenticators send. */
function derToRaw(der) {
  const rLen = der[3];
  let r = der.subarray(4, 4 + rLen);
  if (r.length > 32) r = r.subarray(r.length - 32);
  const sOff = 4 + rLen + 2;
  const sLen = der[sOff - 1];
  let s = der.subarray(sOff, sOff + sLen);
  if (s.length > 32) s = s.subarray(s.length - 32);
  const rBuf = Buffer.alloc(32); r.copy(rBuf, 32 - r.length);
  const sBuf = Buffer.alloc(32); s.copy(sBuf, 32 - s.length);
  return Buffer.concat([rBuf, sBuf]);
}

function coseEc(jwk, alg = -7) { return [1, 2, 3, alg, -1, 1, -2, jwk.x, -3, jwk.y]; }
function coseRsa(jwk) { return [1, 3, 3, -257, -1, jwk.n, -2, jwk.e]; }
function coseOkp(jwk) { return [1, 6, 3, -8, -1, 6, -2, jwk.x]; }

/** Standard machine fixture: owner ada (PIN 123456), admin boss, standard sam
 *  (PIN 4321). Every test rebuilds its own world over HTTP. */
async function world() {
  const owner = request.agent(app);
  const setup = await owner.post('/api/auth/setup')
    .send({ displayName: 'Ada Lovelace', username: 'ada', pin: '123456' });
  expect(setup.status).toBe(200);
  expect(setup.body.success).toBe(true);
  const ownerCsrf = setup.body.data.csrfToken;
  const adaUid = setup.body.data.user.uid;

  const boss = await owner.post('/api/auth/admin/users').set('X-CSRF-Token', ownerCsrf)
    .send({ displayName: 'Big Boss', username: 'boss', pin: '111111', role: 'admin' });
  expect(boss.status).toBe(200);
  const sam = await owner.post('/api/auth/admin/users').set('X-CSRF-Token', ownerCsrf)
    .send({ displayName: 'Sam Smith', username: 'sam', pin: '4321', role: 'standard' });
  expect(sam.status).toBe(200);

  return {
    owner, ownerCsrf, adaUid,
    ownerSid: setup.body.data.sessionId,
    bossUid: boss.body.data.user.uid,
    samUid: sam.body.data.user.uid,
  };
}

async function login(agent, creds) {
  const res = await agent.post('/api/auth/login').send(creds);
  return res;
}

async function loginOk(agent, creds) {
  const res = await login(agent, creds);
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.data.sessionId).toBeTruthy();
  expect(res.body.data.csrfToken).toBeTruthy();
  return { sid: res.body.data.sessionId, csrf: res.body.data.csrfToken, body: res.body, res };
}

/** Establishes an anonymous session and returns its CSRF token, the way the
 *  OS host obtains one for pre-login surfaces: the security chain stamps and
 *  persists a token on the anonymous session (csrfTokenMiddleware), and the
 *  trusted host presents it back on the non-exempt verbs. */
async function anonSession(app) {
  const agent = request.agent(app);
  const res = await agent.get('/api/auth/session');
  expect(res.body.data.authenticated).toBe(false);
  const sid = cookieSid(res);
  const csrf = await new Promise((resolve, reject) => {
    sessionStore.get(sid, (err, sess) => (err ? reject(err) : resolve(sess?.csrfToken)));
  });
  expect(csrf).toMatch(/^[0-9a-f]{64}$/);
  return { agent, sid, csrf };
}

const usersRoot = () => join(homeDir, 'users');
const legacyRoot = () => join(homeDir, '.local', 'share', 'novabyte', 'users');

// ─── lifecycle ──────────────────────────────────────────────────────────────

beforeAll(() => {
  app = buildApp();
});

beforeEach(() => {
  // First-boot state for every test: no accounts, default policies, no
  // lockout counters, no live sessions, no stale session-map rows, and a
  // clean per-user storage tree under the temp HOME (leftover bytes from a
  // previous test would pollute the usage/archive assertions).
  usersDb.wipeAll(null);
  sessionStore.clear();
  rmSync(join(homeDir, 'users'), { recursive: true, force: true });
  rmSync(join(homeDir, '.local'), { recursive: true, force: true });
});

afterAll(() => {
  usersDb.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

// ─── 1. first boot: setup, migration, factory reset ─────────────────────────

describe('auth-routes — first boot: /setup, /migrate-legacy, /admin/wipe', () => {
  it('GET /users and /policies describe a fresh machine', async () => {
    const users = await request(app).get('/api/auth/users');
    expect(users.status).toBe(200);
    expect(users.body).toEqual({
      success: true,
      data: { users: [], policies: { guestAccess: false, showUsernames: false } },
    });

    const policies = await request(app).get('/api/auth/policies');
    expect(policies.status).toBe(200);
    expect(policies.body.data).toMatchObject({
      guestAccess: false,
      showUsernames: false,
      closeAppsOnSwitch: true,
      idleLockMaxMinutes: 60,
    });
  });

  it('POST /setup rejects invalid payloads with the real validation messages', async () => {
    const badPin = await request(app).post('/api/auth/setup')
      .send({ displayName: 'A', username: 'ada', pin: '12' });
    expect(badPin.status).toBe(400);
    expect(badPin.body).toMatchObject({ success: false, code: 'INVALID_ARGS', message: 'PIN must be 4 to 6 digits' });

    const badUsername = await request(app).post('/api/auth/setup')
      .send({ displayName: 'A', username: 'ab', pin: '1234' });
    expect(badUsername.status).toBe(400);
    expect(badUsername.body.message).toBe('Username must be 3–32 chars: letters, digits, dot, dash, underscore');

    const shortPass = await request(app).post('/api/auth/setup')
      .send({ displayName: 'A', username: 'ada', pin: '1234', passphrase: 'short' });
    expect(shortPass.status).toBe(400);
    expect(shortPass.body.message).toBe('Passphrase must be at least 8 characters');

    const nonStringPin = await request(app).post('/api/auth/setup')
      .send({ displayName: 'A', username: 'ada', pin: 123456 });
    expect(nonStringPin.status).toBe(400);
    expect(nonStringPin.body.message).toBe('PIN must be 4 to 6 digits');

    const noBody = await request(app).post('/api/auth/setup').send({});
    expect(noBody.status).toBe(400);
    // Nothing was created by any of the refused attempts.
    expect(usersDb.hasAccounts()).toBe(false);
  });

  it('POST /migrate-legacy validates its arguments before importing', async () => {
    // /migrate-legacy is NOT one of the CSRF-exempt identity verbs: the host
    // presents the anonymous page session's token for it.
    const anon = await anonSession(app);
    const missing = await anon.agent.post('/api/auth/migrate-legacy')
      .set('X-CSRF-Token', anon.csrf)
      .send({ username: 'm', legacyPinHash: '', legacyPinSalt: '' });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({
      success: false, code: 'INVALID_ARGS',
      message: 'legacyPinHash and legacyPinSalt are required',
    });

    const badUsername = await anon.agent.post('/api/auth/migrate-legacy')
      .set('X-CSRF-Token', anon.csrf)
      .send({ username: 'x', legacyPinHash: 'aa', legacyPinSalt: 'bb', pinLen: 4 });
    expect(badUsername.status).toBe(400);
    expect(badUsername.body.message).toBe('Username must be 3–32 chars: letters, digits, dot, dash, underscore');
    // Without the token the verb is stopped by the CSRF chain first.
    const noToken = await request(app).post('/api/auth/migrate-legacy')
      .send({ username: 'x', legacyPinHash: 'aa', legacyPinSalt: 'bb' });
    expect(noToken.status).toBe(403);
    expect(noToken.body.code).toBe('CSRF_MISSING');
    expect(usersDb.hasAccounts()).toBe(false);
  });

  it('POST /migrate-legacy imports the 3.0.2 owner, retires the legacy admin flag and logs in via the non-digit legacy PIN', async () => {
    // The legacy admin-mode flag is superseded by account roles — the route
    // switches it off when the migration carries adminEnabled=true.
    adminState.setAdminEnabled(true);
    expect(adminState.readState().adminEnabled).toBe(true);

    const secret = 'legacy-lock-secret!';
    const salt = nodeCrypto.randomBytes(16).toString('hex');
    const legacyPinHash = nodeCrypto
      .pbkdf2Sync(secret, Buffer.from(salt, 'hex'), 100000, 32, 'sha256')
      .toString('hex');

    const host = await anonSession(app); // anonymous first-boot session + token
    const res = await host.agent.post('/api/auth/migrate-legacy')
      .set('X-CSRF-Token', host.csrf)
      .send({
        username: 'migrated', displayName: 'Migrated User',
        legacyPinHash, legacyPinSalt: salt, pinLen: 6, adminEnabled: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ username: 'migrated', role: 'owner' });
    expect(res.body.data.uid).toBeTruthy();
    expect(adminState.readState().adminEnabled).toBe(false);

    // The migration is data-only: no session is established for the importer —
    // the SAME anonymous session is still unauthenticated afterwards.
    const probe = await host.agent.get('/api/auth/session');
    expect(probe.body.data.authenticated).toBe(false);

    // A wrong non-digit secret is a normal outcome (HTTP 200 + code).
    const wrong = await request(app).post('/api/auth/login')
      .send({ uid: res.body.data.uid, secret: 'wrong-legacy' });
    expect(wrong.status).toBe(200);
    expect(wrong.body.code).toBe('BAD_CREDENTIAL');

    // The real legacy secret authenticates through the PBKDF2 row and the
    // account is transparently re-hashed to scrypt.
    const agent = request.agent(app);
    const good = await loginOk(agent, { uid: res.body.data.uid, secret });
    expect(good.body.data.via).toBe('pin');
    expect(good.body.data.user.roleLabel).toBe('Owner');
    expect(JSON.parse(usersDb.getUser(res.body.data.uid).pin_kdf).alg).toBe('scrypt');
  });

  it('POST /setup and /migrate-legacy are refused once accounts exist', async () => {
    const first = await request(app).post('/api/auth/setup')
      .send({ displayName: 'Ada', username: 'ada', pin: '123456' });
    expect(first.status).toBe(200);

    // /setup is CSRF-exempt by design; the 409 comes from the route itself.
    const again = await request(app).post('/api/auth/setup')
      .send({ displayName: 'X', username: 'xxx', pin: '1234' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ success: false, code: 'ALREADY_SET_UP', message: 'This machine already has accounts' });

    // /migrate-legacy is NOT one of the CSRF-exempt identity verbs, so the
    // call must present the anonymous page session's token to reach the
    // route's own 409 (without it the CSRF chain answers 403 first).
    const host = await anonSession(app);
    const migrate = await host.agent.post('/api/auth/migrate-legacy')
      .set('X-CSRF-Token', host.csrf)
      .send({ username: 'legacy', legacyPinHash: 'abc', legacyPinSalt: 'def' });
    expect(migrate.status).toBe(409);
    expect(migrate.body).toMatchObject({ success: false, code: 'ALREADY_MIGRATED', message: 'This machine already has accounts' });
  });

  it('POST /admin/wipe performs a factory reset: rows, policies and both storage roots', async () => {
    // Seed per-user storage under the temp HOME: the current layout plus a
    // legacy nested-layout tree — the wipe must remove both roots outright.
    mkdirSync(join(usersRoot(), 'ada', 'docs'), { recursive: true });
    writeFileSync(join(usersRoot(), 'ada', 'docs', 'a.txt'), 'x'.repeat(100));
    mkdirSync(join(legacyRoot(), 'ada'), { recursive: true });
    writeFileSync(join(legacyRoot(), 'ada', 'old.txt'), 'y'.repeat(50));

    const owner = request.agent(app);
    const setup = await owner.post('/api/auth/setup')
      .send({ displayName: 'Ada', username: 'ada', pin: '123456' });
    const csrf = setup.body.data.csrfToken;
    await owner.post('/api/auth/admin/users').set('X-CSRF-Token', csrf)
      .send({ displayName: 'Sam', username: 'sam', pin: '4321', role: 'standard' });
    await owner.put('/api/auth/admin/policies').set('X-CSRF-Token', csrf).send({ guestAccess: true });

    const wipe = await owner.post('/api/auth/admin/wipe').set('X-CSRF-Token', csrf).send({});
    expect(wipe.status).toBe(200);
    expect(wipe.body).toEqual({ success: true, data: { wiped: true } });

    expect((await request(app).get('/api/auth/users')).body.data.users).toEqual([]);
    expect((await request(app).get('/api/auth/policies')).body.data.guestAccess).toBe(false);
    expect(existsSync(usersRoot())).toBe(false);
    expect(existsSync(legacyRoot())).toBe(false);

    // The machine is genuinely first-boot again: setup runs and logs in.
    const second = await request.agent(app).post('/api/auth/setup')
      .send({ displayName: 'New', username: 'newown', pin: '654321' });
    expect(second.status).toBe(200);
    expect(second.body.data.user).toMatchObject({ username: 'newown', role: 'owner' });
    const relogin = await loginOk(request.agent(app), { username: 'newown', secret: '654321' });
    expect(relogin.body.data.user.username).toBe('newown');
  });

  it('after /admin/wipe the acting session keeps REAL admin authority over the empty store (documented quirk)', async () => {
    const w = await world();

    const wipe = await w.owner.post('/api/auth/admin/wipe').set('X-CSRF-Token', w.ownerCsrf).send({});
    expect(wipe.status).toBe(200);

    // The express-session row outlived the account rows: introspection still
    // reports an authenticated owner whose account row is 'gone'.
    const intro = await w.owner.get('/api/auth/session');
    expect(intro.body.data).toMatchObject({ authenticated: true, suspended: false, locked: false });
    expect(intro.body.data.user).toMatchObject({
      uid: w.adaUid, username: 'ada', role: 'owner', status: 'gone',
    });

    // requireAdminRole re-checks the SESSION's role, never the account row,
    // so the stale owner still passes every admin gate on the empty store…
    const list = await w.owner.get('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf);
    expect(list.status).toBe(200);
    expect(list.body.data.users).toEqual([]);

    // …and first-boot /setup is legal again for a fresh agent (the machine
    // genuinely returned to zero accounts).
    const second = await request.agent(app).post('/api/auth/setup')
      .send({ displayName: 'New', username: 'newown', pin: '654321' });
    expect(second.status).toBe(200);

    // The stale pre-wipe owner retains REAL authority alongside the new
    // owner: it can still mint admin accounts on the rebuilt store.
    const rebuilt = await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ displayName: 'Rebuilt', username: 'rebuilt', pin: '7654', role: 'admin' });
    expect(rebuilt.status).toBe(200);
    expect(rebuilt.body.data.user.role).toBe('admin');
  });

  it('the admin surface exposes the KDF generation: a legacy-imported row upgrades to scrypt on first login', async () => {
    const w = await world();

    // Flip sam's PIN row to the 3.0.2 PBKDF2 shape (the store's supported
    // import operation) for the SAME secret '4321'.
    const salt = nodeCrypto.randomBytes(16).toString('hex');
    const legacyHash = nodeCrypto
      .pbkdf2Sync('4321', Buffer.from(salt, 'hex'), 100000, 32, 'sha256')
      .toString('hex');
    usersDb.importLegacyPin(w.samUid, legacyHash, salt);

    const before = await w.owner.get('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf);
    expect(before.body.data.users.find(u => u.username === 'sam').credentialKdf)
      .toBe('pbkdf2(legacy)');

    // The first successful verification transparently re-hashes the row.
    const login = await loginOk(request.agent(app), { uid: w.samUid, secret: '4321' });
    expect(login.body.data.via).toBe('pin');

    const after = await w.owner.get('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf);
    expect(after.body.data.users.find(u => u.username === 'sam').credentialKdf).toBe('scrypt');
  });

  it('POST /setup establishes a real session over HTTP (Set-Cookie + CSRF token + owner projection)', async () => {
    const agent = request.agent(app);
    const anon = await agent.get('/api/auth/session');
    expect(anon.body.data.authenticated).toBe(false);
    const anonCookie = agent.cookies?.find?.((c) => c.name === 'connect.sid')?.value
      ?? cookieSid(anon);

    const res = await agent.post('/api/auth/setup')
      .send({ displayName: 'Ada', username: 'ada', pin: '123456', passphrase: 'longenough', avatar: 'https://example.invalid/a.png' });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({
      username: 'ada', role: 'owner', roleLabel: 'Owner', status: 'active',
      pinLength: 6, hasPassphrase: true, mustChangePin: false,
    });
    expect(res.body.data.sessionId).toBeTruthy();
    expect(res.body.data.csrfToken).toMatch(/^[0-9a-f]{64}$/);

    // Session cookie issued, httpOnly + lax, and the sid regenerated relative
    // to the anonymous page session that preceded it.
    const setCookie = res.headers['set-cookie']?.[0];
    expect(setCookie).toMatch(/^connect\.sid=s%3A/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(cookieSid(res)).not.toBe(anonCookie);
    expect(cookieSid(res)).toBe(res.body.data.sessionId);

    // No credential material ever rides the wire.
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain('pin_hash');
    expect(wire).not.toContain('pass_hash');
    expect(wire).not.toContain('"salt"');

    const intro = await agent.get('/api/auth/session');
    expect(intro.body.data).toMatchObject({
      authenticated: true,
      sessionId: res.body.data.sessionId,
      suspended: false,
      locked: false,
    });
    expect(intro.body.data.user.username).toBe('ada');
  });
});

// ─── 2. picker, policies, session introspection ─────────────────────────────

describe('auth-routes — picker list, policy surfaces, introspection', () => {
  it('GET /users redacts usernames while showUsernamesOnPicker is off and reveals them when it is on', async () => {
    const w = await world();
    await loginOk(request.agent(app), { username: 'sam', secret: '4321' });

    const off = await request(app).get('/api/auth/users');
    expect(off.status).toBe(200);
    expect(off.body.data.users).toHaveLength(3);
    expect(off.body.data.users.every(u => u.username === undefined)).toBe(true);
    expect(off.body.data.policies).toEqual({ guestAccess: false, showUsernames: false });
    // display names are always present — the picker tiles render from them.
    expect(off.body.data.users.some(u => u.displayName === 'Sam Smith')).toBe(true);
    // no lifecycle or credential fields on the public projection.
    for (const u of off.body.data.users) {
      expect(u).not.toHaveProperty('lastLoginAt');
      expect(u).not.toHaveProperty('quotaBytes');
      expect(u).not.toHaveProperty('pin_hash');
    }

    await w.owner.put('/api/auth/admin/policies').set('X-CSRF-Token', w.ownerCsrf)
      .send({ showUsernamesOnPicker: true });
    const on = await request(app).get('/api/auth/users');
    expect(on.body.data.policies.showUsernames).toBe(true);
    expect(on.body.data.users.find(u => u.displayName === 'Sam Smith').username).toBe('sam');
    // usernames are accepted by /login regardless of the picker policy.
    await loginOk(request.agent(app), { username: 'sam', secret: '4321' });
  });

  it('GET /users only lists active accounts; the admin list carries every row', async () => {
    const w = await world();
    await w.owner.post(`/api/auth/admin/users/${w.samUid}/disable`).set('X-CSRF-Token', w.ownerCsrf);

    const pub = await request(app).get('/api/auth/users');
    expect(pub.body.data.users.map(u => u.displayName)).toEqual(['Ada Lovelace', 'Big Boss']);

    const admin = await w.owner.get('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf);
    expect(admin.body.data.users).toHaveLength(3);
    const sam = admin.body.data.users.find(u => u.username === 'sam');
    expect(sam.status).toBe('disabled');
    expect(sam).toHaveProperty('lastLoginAt');
    expect(sam).toHaveProperty('quotaBytes');
    expect(sam).toHaveProperty('trackedSessions');
    expect(sam.credentialKdf).toBe('scrypt');
  });

  it('idleLockMaxMinutes and showUsernamesOnPicker round-trip through the public /policies surface', async () => {
    const w = await world();
    const write = await w.owner.put('/api/auth/admin/policies').set('X-CSRF-Token', w.ownerCsrf)
      .send({ idleLockMaxMinutes: 15, showUsernamesOnPicker: true });
    expect(write.status).toBe(200);
    expect(write.body.data.policies.idleLockMaxMinutes).toBe(15);

    const pub = await request(app).get('/api/auth/policies');
    expect(pub.status).toBe(200);
    expect(pub.body.data).toMatchObject({ idleLockMaxMinutes: 15, showUsernames: true });
  });

  it('picker and login projections expose hasBiometric and mustChangePin as the account evolves', async () => {
    const w = await world();

    // Fresh sam: no authenticator, no forced change.
    const fresh = await request(app).get('/api/auth/users');
    const samTile = fresh.body.data.users.find(u => u.displayName === 'Sam Smith');
    expect(samTile.hasBiometric).toBe(false);
    expect(samTile.mustChangePin).toBe(false);

    // Self-enroll an authenticator over HTTP.
    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    const key = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const opts = await sam.post('/api/auth/webauthn/register/options')
      .set('X-CSRF-Token', samLogin.csrf).send({});
    expect(opts.status).toBe(200);
    const finish = await sam.post('/api/auth/webauthn/register/finish')
      .set('X-CSRF-Token', samLogin.csrf).send({
        credentialId: 'proj-key-1',
        publicKey: coseEc(key.publicKey.export({ format: 'jwk' })),
        clientDataJSON: clientDataB64u('webauthn.create', opts.body.data.challenge),
      });
    expect(finish.status).toBe(200);

    const withKey = await request(app).get('/api/auth/users');
    expect(withKey.body.data.users.find(u => u.displayName === 'Sam Smith').hasBiometric).toBe(true);

    // A pre-reset account state forces the new-PIN sheet.
    usersDb.resetCredential(w.samUid, w.adaUid);
    const forced = await request(app).get('/api/auth/users');
    const forcedTile = forced.body.data.users.find(u => u.displayName === 'Sam Smith');
    expect(forcedTile.mustChangePin).toBe(true);
    expect(forcedTile.hasBiometric).toBe(true);

    // …and the login response's own user projection carries the same flags.
    const sheet = await loginOk(request.agent(app), { uid: w.samUid, secret: '4321' });
    expect(sheet.body.data.mustChangePin).toBe(true);
    expect(sheet.body.data.user.mustChangePin).toBe(true);
    expect(sheet.body.data.user.hasBiometric).toBe(true);
  });

  it('GET /session reports the truth for anonymous, authenticated and deleted-account sessions', async () => {
    const anon = await request(app).get('/api/auth/session');
    expect(anon.status).toBe(200);
    expect(anon.body).toEqual({ success: true, data: { authenticated: false } });

    const w = await world();
    const agent = request.agent(app);
    const login = await loginOk(agent, { username: 'sam', secret: '4321' });
    const intro = await agent.get('/api/auth/session');
    expect(intro.body.data).toMatchObject({
      authenticated: true,
      sessionId: login.sid,
      suspended: false,
      locked: false,
    });
    expect(intro.body.data.loginAt).toBeGreaterThan(0);
    expect(intro.body.data.user).toMatchObject({ username: 'sam', role: 'standard' });

    // The account row disappears underneath a live session → 'gone' fallback.
    await w.owner.delete(`/api/auth/admin/users/${w.samUid}`).set('X-CSRF-Token', w.ownerCsrf).send({ mode: 'wipe' });
    const gone = await agent.get('/api/auth/session');
    expect(gone.body.data.authenticated).toBe(true);
    expect(gone.body.data.user).toMatchObject({ uid: w.samUid, username: 'sam', role: 'standard', status: 'gone' });
    // And the self-service surfaces refuse it with 404.
    const usage = await agent.get('/api/auth/usage');
    expect(usage.status).toBe(404);
    expect(usage.body).toMatchObject({ success: false, code: 'NOT_FOUND', message: 'No such account' });
  });

  it('GET /usage reports only the signed-in account’s own bytes (real files under the temp HOME)', async () => {
    const anon = await request(app).get('/api/auth/usage');
    expect(anon.status).toBe(401);
    expect(anon.body).toMatchObject({ success: false, code: 'AUTH_REQUIRED', message: 'Sign in first' });

    const w = await world();
    mkdirSync(join(usersRoot(), 'sam', 'docs'), { recursive: true });
    writeFileSync(join(usersRoot(), 'sam', 'docs', 'a.txt'), 'A'.repeat(1500));
    writeFileSync(join(usersRoot(), 'sam', 'b.txt'), 'B'.repeat(500));
    mkdirSync(join(legacyRoot(), 'sam'), { recursive: true });
    writeFileSync(join(legacyRoot(), 'sam', 'legacy.txt'), 'C'.repeat(250));

    const agent = request.agent(app);
    await loginOk(agent, { username: 'sam', secret: '4321' });
    const res = await agent.get('/api/auth/usage');
    expect(res.status).toBe(200);
    expect(res.body.data.usage).toEqual({
      uid: w.samUid,
      username: 'sam',
      displayName: 'Sam Smith',
      quotaBytes: 2 * 1024 * 1024 * 1024,
      usedBytes: 2250, // 1500 + 500 in the current tree + 250 in the legacy root
    });
    // Single object, never the every-account array the admin variant returns.
    expect(Array.isArray(res.body.data.usage)).toBe(false);
  });

  it('GET /admin/usage aggregates per-account bytes for every account', async () => {
    const w = await world();
    mkdirSync(join(usersRoot(), 'sam'), { recursive: true });
    writeFileSync(join(usersRoot(), 'sam', 'data.bin'), 'D'.repeat(100));

    const anon = await request(app).get('/api/auth/admin/usage');
    expect(anon.status).toBe(401);

    const agent = request.agent(app);
    const login = await loginOk(agent, { username: 'sam', secret: '4321' });
    const standard = await agent.get('/api/auth/admin/usage');
    expect(standard.status).toBe(403);
    expect(standard.body.code).toBe('ADMIN_REQUIRED');

    const admin = await w.owner.get('/api/auth/admin/usage').set('X-CSRF-Token', w.ownerCsrf);
    expect(admin.status).toBe(200);
    const usage = admin.body.data.usage;
    expect(Array.isArray(usage)).toBe(true);
    expect(usage).toHaveLength(3);
    const sam = usage.find(u => u.username === 'sam');
    const ada = usage.find(u => u.username === 'ada');
    expect(sam).toMatchObject({ uid: w.samUid, quotaBytes: 2 * 1024 * 1024 * 1024, usageBytes: 100 });
    expect(ada.usageBytes).toBe(0);
    expect(sam.quotaBytes).toBe(ada.quotaBytes);
  });
});

// ─── 3. login lifecycle & the lockout ladder ────────────────────────────────

describe('auth-routes — /login: verification, failure modes, lockout ladder', () => {
  it('logs in by uid and by username (case-insensitive), issuing a fresh session id', async () => {
    const w = await world();

    const agent = request.agent(app);
    const pre = await agent.get('/api/auth/session'); // anonymous page session
    const preSid = cookieSid(pre);

    const byName = await loginOk(agent, { username: 'SAM', secret: '4321' }); // NOCASE lookup
    expect(byName.body.data.user).toMatchObject({ username: 'sam', role: 'standard' });
    expect(byName.body.data.via).toBe('pin');
    expect(byName.body.data.mustChangePin).toBe(false);
    expect(byName.sid).not.toBe(preSid); // regeneration: fixation defence

    const byUid = await loginOk(request.agent(app), { uid: w.samUid, secret: '4321' });
    expect(byUid.body.data.user.uid).toBe(w.samUid);
    expect(byUid.body.data.sessionId).not.toBe(byName.sid);
  });

  it('rejects malformed login attempts with 400 INVALID_ARGS and the real message', async () => {
    const w = await world();

    const noTarget = await request(app).post('/api/auth/login').send({ secret: '4321' });
    expect(noTarget.status).toBe(400);
    expect(noTarget.body).toMatchObject({ success: false, code: 'INVALID_ARGS', message: 'uid and secret are required' });

    const unknownName = await request(app).post('/api/auth/login').send({ username: 'ghost', secret: '4321' });
    expect(unknownName.status).toBe(400);
    expect(unknownName.body.code).toBe('INVALID_ARGS');

    const emptySecret = await request(app).post('/api/auth/login').send({ username: 'sam', secret: '' });
    expect(emptySecret.status).toBe(400);

    const nonStringSecret = await request(app).post('/api/auth/login').send({ username: 'sam', secret: 4321 });
    expect(nonStringSecret.status).toBe(400);

    const numericUid = await request(app).post('/api/auth/login').send({ uid: 42, secret: '4321' });
    expect(numericUid.status).toBe(400);

    const noBody = await request(app).post('/api/auth/login');
    expect(noBody.status).toBe(400);
  });

  it('an unknown uid is a 200 + UNKNOWN_ACCOUNT outcome; a wrong secret is 200 + BAD_CREDENTIAL', async () => {
    const w = await world();

    const unknown = await request(app).post('/api/auth/login')
      .send({ uid: '11111111-2222-3333-4444-555555555555', secret: '4321' });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toMatchObject({ success: false, code: 'UNKNOWN_ACCOUNT', message: 'Unknown account' });

    const wrong = await request(app).post('/api/auth/login').send({ uid: w.samUid, secret: '9999' });
    expect(wrong.status).toBe(200);
    expect(wrong.body).toMatchObject({ success: false, code: 'BAD_CREDENTIAL', message: 'Incorrect PIN' });
    // unknown accounts never enter the lockout ladder.
    expect(wrong.body.retryAfterMs).toBeUndefined();
  });

  it('kind=pin / kind=passphrase / unknown kind select the intended credential branch', async () => {
    const w = await world();
    await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ displayName: 'Pat', username: 'pat', pin: '7777', passphrase: 'pat-pass-123', role: 'standard' });
    const pat = usersDb.getUserByUsername('pat').uid;

    // auto: a non-digit secret falls to the passphrase branch.
    const byPhrase = await loginOk(request.agent(app), { uid: pat, secret: 'pat-pass-123' });
    expect(byPhrase.body.data.via).toBe('passphrase');

    // explicit passphrase kind with the digit PIN fails closed (it only tries the passphrase row).
    const pinAsPhrase = await request(app).post('/api/auth/login')
      .send({ uid: pat, secret: '7777', kind: 'passphrase' });
    expect(pinAsPhrase.status).toBe(200);
    expect(pinAsPhrase.body.code).toBe('BAD_CREDENTIAL');

    // explicit pin kind with the passphrase text also fails closed.
    const phraseAsPin = await request(app).post('/api/auth/login')
      .send({ uid: pat, secret: 'pat-pass-123', kind: 'pin' });
    expect(phraseAsPin.status).toBe(200);
    expect(phraseAsPin.body.code).toBe('BAD_CREDENTIAL');

    // unknown kind is treated as auto.
    const weirdKind = await loginOk(request.agent(app), { uid: pat, secret: '7777', kind: 'whatever' });
    expect(weirdKind.body.data.via).toBe('pin');

    // an account without a passphrase never matches a text secret.
    const noPhrase = await request(app).post('/api/auth/login')
      .send({ uid: w.samUid, secret: 'not-a-pin' });
    expect(noPhrase.body.code).toBe('BAD_CREDENTIAL');
  });

  it('lockout ladder e2e: 3 wrong → LOCKOUT, correct PIN rejected during the window, escalation, hard lock at 10, admin unlock', async () => {
    const w = await world();
    const post = (secret) => request(app).post('/api/auth/login').send({ uid: w.samUid, secret });

    // 1-2: plain denials.
    expect((await post('0000')).body.code).toBe('BAD_CREDENTIAL');
    expect((await post('0000')).body.code).toBe('BAD_CREDENTIAL');

    // 3: short window — LOCKOUT with the exact short-window budget.
    const third = await post('0000');
    expect(third.status).toBe(200);
    expect(third.body.code).toBe('LOCKOUT');
    expect(third.body.message).toBe('Too many attempts');
    expect(third.body.retryAfterMs).toBe(30000);

    // The CORRECT pin is now rejected while the window is active.
    const correctDuringLockout = await post('4321');
    expect(correctDuringLockout.status).toBe(200);
    expect(correctDuringLockout.body.success).toBe(false);
    expect(correctDuringLockout.body.code).toBe('LOCKOUT');
    expect(correctDuringLockout.body.retryAfterMs).toBeGreaterThan(0);
    expect(correctDuringLockout.body.retryAfterMs).toBeLessThanOrEqual(30000);

    // Attempts during the window still count, so the ladder escalates.
    await post('0000'); // 5
    const sixth = await post('0000'); // 6 → extended window
    expect(sixth.body.code).toBe('LOCKOUT');
    expect(sixth.body.retryAfterMs).toBeGreaterThan(100000);

    // 7-9 keep sliding the extended window; 10 hard-locks the account.
    await post('0000');
    await post('0000');
    await post('0000');
    const tenth = await post('0000');
    expect(tenth.body).toMatchObject({
      success: false, code: 'ACCOUNT_LOCKED',
      message: 'Account locked — an administrator must unlock it',
    });
    expect(usersDb.getUser(w.samUid).locked).toBe(1);

    // Even the correct PIN cannot recover it — an administrator must unlock.
    const locked = await post('4321');
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');

    // The failure trail is in the audit log. CURRENT BEHAVIOR (users-db.js):
    // only the failures that reach the credential-check branch are logged —
    // attempts made DURING an active lockout window (and the hard-lock tier
    // itself) are counted in the in-memory ladder but never logged, so the
    // trail carries exactly the three pre-lockout attempts (counts 1-3).
    const events = await w.owner.get('/api/auth/admin/events')
      .query({ action: 'auth.failure', uid: w.samUid }).set('X-CSRF-Token', w.ownerCsrf);
    expect(events.body.data.total).toBe(3);
    expect(events.body.data.events).toHaveLength(3);
    expect(events.body.data.events[0].detail).toMatchObject({ count: 3, tier: 'short' });

    // Admin unlock clears both the hard lock and the ladder.
    const unlock = await w.owner.post(`/api/auth/admin/users/${w.samUid}/unlock`)
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(unlock.status).toBe(200);
    expect(unlock.body.data.user.locked).toBe(false);
    const ok = await post('4321');
    expect(ok.body.success).toBe(true);
    expect(ok.body.data.via).toBe('pin');
  });

  it('webauthn login/options honours the account-state gates', async () => {
    const w = await world();

    const noUid = await request(app).post('/api/auth/webauthn/login/options').send({});
    expect(noUid.status).toBe(400);
    expect(noUid.body).toMatchObject({ success: false, code: 'INVALID_ARGS', message: 'uid is required' });

    const unknown = await request(app).post('/api/auth/webauthn/login/options')
      .send({ uid: '11111111-2222-3333-4444-555555555555' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ success: false, code: 'UNKNOWN_ACCOUNT', message: 'Unknown account' });

    const noCred = await request(app).post('/api/auth/webauthn/login/options')
      .send({ uid: w.samUid });
    expect(noCred.status).toBe(400);
    expect(noCred.body).toMatchObject({ success: false, code: 'NO_CREDENTIAL', message: 'This account has no enrolled authenticator' });

    // Disabled account.
    await w.owner.post(`/api/auth/admin/users/${w.samUid}/disable`).set('X-CSRF-Token', w.ownerCsrf);
    const disabled = await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid });
    expect(disabled.status).toBe(423);
    expect(disabled.body).toMatchObject({ success: false, code: 'ACCOUNT_DISABLED', message: 'This account is disabled' });
    await w.owner.post(`/api/auth/admin/users/${w.samUid}/enable`).set('X-CSRF-Token', w.ownerCsrf);

    // Hard-locked account.
    await w.owner.post(`/api/auth/admin/users/${w.samUid}/lock`).set('X-CSRF-Token', w.ownerCsrf);
    const hardLocked = await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid });
    expect(hardLocked.status).toBe(423);
    expect(hardLocked.body).toMatchObject({ success: false, code: 'ACCOUNT_LOCKED', message: 'Account locked — an administrator must unlock it' });
    await w.owner.post(`/api/auth/admin/users/${w.samUid}/unlock`).set('X-CSRF-Token', w.ownerCsrf);

    // Temporary lockout → 429 with the remaining window.
    for (let i = 0; i < 3; i++) {
      await request(app).post('/api/auth/login').send({ uid: w.samUid, secret: '0000' });
    }
    const throttled = await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid });
    expect(throttled.status).toBe(429);
    expect(throttled.body).toMatchObject({ success: false, code: 'LOCKOUT', message: 'Too many attempts — try again soon' });
    expect(throttled.body.retryAfterMs).toBeGreaterThan(0);
  });
});

// ─── 4. session cycles: cookies, CSRF, bearer ───────────────────────────────

describe('auth-routes — session cycles: login → authenticated → logout → rejected', () => {
  it('a full cookie-jar cycle with real Set-Cookie effects', async () => {
    const w = await world();
    const agent = request.agent(app);

    // login (CSRF-exempt by design) issues the authenticated cookie.
    const login = await loginOk(agent, { username: 'sam', secret: '4321' });
    const authCookie = cookieSid(login.res);
    expect(authCookie).toBe(login.sid); // the wire sid equals the reported session id
    // authenticated endpoint through the cookie alone.
    const usage = await agent.get('/api/auth/usage');
    expect(usage.status).toBe(200);
    expect(usage.body.data.usage.username).toBe('sam');

    // logout ends the session server-side and clears the cookie.
    const out = await agent.post('/api/auth/logout').set('X-CSRF-Token', login.csrf).send({});
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ success: true, data: { signedOut: true } });
    const cleared = out.headers['set-cookie']?.[0];
    expect(cleared).toContain('connect.sid=;');
    expect(cleared).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');

    // the old cookie no longer authenticates anything.
    const rejected = await agent.get('/api/auth/session');
    expect(rejected.body.data.authenticated).toBe(false);
    const rejectedUsage = await agent.get('/api/auth/usage');
    expect(rejectedUsage.status).toBe(401);
    expect(rejectedUsage.body.code).toBe('AUTH_REQUIRED');

    // …and the login is audited.
    const events = await w.owner.get('/api/auth/admin/events')
      .query({ action: 'auth.logout' }).set('X-CSRF-Token', w.ownerCsrf);
    expect(events.body.data.total).toBeGreaterThanOrEqual(1);
    expect(events.body.data.events[0].actor).toBe('sam');
  });

  it('destroyed, tampered and garbage cookies all degrade to anonymous sessions', async () => {
    const w = await world();
    const agent = request.agent(app);
    const login = await loginOk(agent, { username: 'sam', secret: '4321' });

    // 1. replay of the pre-logout cookie after a second machine wipe of that
    //    session: destroy it via logout, then present the same value.
    const sid = login.sid;
    await agent.post('/api/auth/logout').set('X-CSRF-Token', login.csrf).send({});
    const replay = await request(app).get('/api/auth/session')
      .set('Cookie', `connect.sid=${encodeURIComponent(signedCookie(sid))}`);
    expect(replay.body.data.authenticated).toBe(false);

    // 2. a valid-looking cookie with a broken signature is not trusted.
    const good = signedCookie(sid);
    const tampered = `s:${sid}.${good.split('.')[1].slice(0, -2)}zz`;
    const broken = await request(app).get('/api/auth/session')
      .set('Cookie', `connect.sid=${encodeURIComponent(tampered)}`);
    expect(broken.body.data.authenticated).toBe(false);

    // 3. pure garbage.
    const garbage = await request(app).get('/api/auth/session')
      .set('Cookie', 'connect.sid=not-a-session-at-all');
    expect(garbage.status).toBe(200);
    expect(garbage.body.data.authenticated).toBe(false);

    // none of the three can reach an authenticated endpoint either.
    for (const cookie of [
      `connect.sid=${encodeURIComponent(signedCookie(sid))}`,
      `connect.sid=${encodeURIComponent(tampered)}`,
      'connect.sid=garbage',
    ]) {
      const probe = await request(app).get('/api/auth/usage').set('Cookie', cookie);
      expect(probe.status).toBe(401);
    }
  });

  it('X-Nova-Session bearer tokens target a specific live session without cookies', async () => {
    const w = await world();
    const login = await loginOk(request.agent(app), { username: 'sam', secret: '4321' });

    // A cookie-less caller resolves the session through the bearer header.
    const viaBearer = await request(app).get('/api/auth/session').set('X-Nova-Session', login.sid);
    expect(viaBearer.body.data).toMatchObject({ authenticated: true, sessionId: login.sid });
    expect(viaBearer.body.data.user.username).toBe('sam');

    const usage = await request(app).get('/api/auth/usage').set('X-Nova-Session', login.sid);
    expect(usage.status).toBe(200);

    // A bearer for a session that no longer exists is anonymous again.
    const logout = await request(app).post('/api/auth/logout')
      .set('X-Nova-Session', login.sid).set('X-CSRF-Token', login.csrf).send({});
    expect(logout.status).toBe(200);
    const dead = await request(app).get('/api/auth/session').set('X-Nova-Session', login.sid);
    expect(dead.body.data.authenticated).toBe(false);

    // Malformed bearer values (SID_RE miss) are simply ignored.
    const malformed = await request(app).get('/api/auth/session').set('X-Nova-Session', 'short!');
    expect(malformed.body.data.authenticated).toBe(false);
  });

  it('the CSRF chain guards every non-exempt verb', async () => {
    const w = await world();
    const agent = request.agent(app);
    const login = await loginOk(agent, { username: 'sam', secret: '4321' });

    // GET is always safe.
    expect((await agent.get('/api/auth/session')).status).toBe(200);

    // POST without a token.
    const missing = await agent.post('/api/auth/lock').send({});
    expect(missing.status).toBe(403);
    expect(missing.body).toMatchObject({ code: 'CSRF_MISSING', error: 'CSRF Token Required' });

    // POST with a token of the wrong shape.
    const wrongLength = await agent.post('/api/auth/lock').set('X-CSRF-Token', 'deadbeef').send({});
    expect(wrongLength.status).toBe(403);
    expect(wrongLength.body.code).toBe('CSRF_INVALID');

    // POST with a same-length but wrong value.
    const wrongValue = await agent.post('/api/auth/lock')
      .set('X-CSRF-Token', 'f'.repeat(64)).send({});
    expect(wrongValue.status).toBe(403);
    expect(wrongValue.body.code).toBe('CSRF_INVALID');

    // The right token passes, and the identity verbs stay exempt.
    const ok = await agent.post('/api/auth/lock').set('X-CSRF-Token', login.csrf).send({});
    expect(ok.status).toBe(200);
    const reverify = await agent.post('/api/auth/reverify')
      .send({ secret: '4321' }); // no CSRF header at all
    expect(reverify.status).toBe(200);
    expect(reverify.body.success).toBe(true);
    const freshLogin = await request(app).post('/api/auth/login') // no session, no token
      .send({ username: 'sam', secret: '4321' });
    expect(freshLogin.body.success).toBe(true);
  });

  it('documents the bodyless-POST crash in the CSRF chain (security/middleware.js:238)', async () => {
    // A POST with NO body and NO content-type leaves req.body undefined, and
    // csrfProtection reads req.body._csrf unguarded → express answers 500.
    // Current behavior of the real stack; the guard belongs in
    // security/middleware.js, which is outside this suite's remit.
    const w = await world();
    const agent = request.agent(app);
    const login = await loginOk(agent, { username: 'sam', secret: '4321' });
    const noBody = await agent.post('/api/auth/lock'); // no .send(), no token
    expect(noBody.status).toBe(500);
  });
});

// ─── 5. lock / suspend / reverify ───────────────────────────────────────────

describe('auth-routes — /lock, /suspend, /reverify lifecycle', () => {
  it('lock: 401 anonymous; locked sessions are refused by every guarded route until reverified', async () => {
    // Anonymous POSTs on non-exempt verbs need the page session's CSRF token
    // to reach the route at all — then the route's own gate refuses them.
    const anon = await anonSession(app);
    const anonLock = await anon.agent.post('/api/auth/lock')
      .set('X-CSRF-Token', anon.csrf).send({});
    expect(anonLock.status).toBe(401);
    expect(anonLock.body).toMatchObject({ success: false, code: 'AUTH_REQUIRED', message: 'No active session to lock' });

    const w = await world();
    const agent = request.agent(app);
    const login = await loginOk(agent, { username: 'sam', secret: '4321' });

    const lock = await agent.post('/api/auth/lock').set('X-CSRF-Token', login.csrf).send({});
    expect(lock.status).toBe(200);
    expect(lock.body).toEqual({ success: true, data: { locked: true } });

    // Introspection reports the lock…
    const intro = await agent.get('/api/auth/session');
    expect(intro.body.data.locked).toBe(true);

    // …and every guarded route refuses the session.
    const usage = await agent.get('/api/auth/usage');
    expect(usage.status).toBe(403);
    expect(usage.body).toMatchObject({ code: 'SESSION_LOCKED', message: 'This session is locked — unlock it first' });
    const adminAttempt = await agent.get('/api/auth/admin/users');
    expect(adminAttempt.status).toBe(403);
    expect(adminAttempt.body.code).toBe('SESSION_LOCKED');
    // The guarded enroll verb needs its CSRF token to reach the route's own
    // gate (the CSRF chain runs first on non-exempt POSTs).
    const enroll = await agent.post('/api/auth/webauthn/register/options')
      .set('X-CSRF-Token', login.csrf).send({});
    expect(enroll.status).toBe(403);
    expect(enroll.body.code).toBe('SESSION_LOCKED');

    // A wrong secret at the unlock sheet is a normal outcome and stays locked.
    const wrong = await agent.post('/api/auth/reverify').send({ secret: '0000' });
    expect(wrong.status).toBe(200);
    expect(wrong.body).toMatchObject({ success: false, code: 'BAD_CREDENTIAL' });
    expect((await agent.get('/api/auth/usage')).status).toBe(403);

    // The right secret clears it.
    const ok = await agent.post('/api/auth/reverify').send({ secret: '4321' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ sessionId: login.sid });
    expect(ok.body.data.user.username).toBe('sam');
    expect(ok.body.data.csrfToken).toBe(login.csrf);
    expect((await agent.get('/api/auth/usage')).status).toBe(200);
    expect((await agent.get('/api/auth/session')).body.data.locked).toBe(false);
  });

  it('reverify argument validation', async () => {
    const anon = await request(app).post('/api/auth/reverify').send({ secret: '4321' });
    expect(anon.status).toBe(401);
    expect(anon.body).toMatchObject({ code: 'AUTH_REQUIRED', message: 'No session to re-verify' });

    const w = await world();
    const agent = request.agent(app);
    const login = await loginOk(agent, { username: 'sam', secret: '4321' });
    const noSecret = await agent.post('/api/auth/reverify').send({});
    expect(noSecret.status).toBe(400);
    expect(noSecret.body).toMatchObject({ success: false, code: 'INVALID_ARGS', message: 'secret is required' });
    const nonString = await agent.post('/api/auth/reverify').send({ secret: 1234 });
    expect(nonString.status).toBe(400);
  });

  it('suspend: 401 anonymous; suspended sessions are refused until reverify resumes them', async () => {
    const anon = await anonSession(app);
    const anonSuspend = await anon.agent.post('/api/auth/suspend')
      .set('X-CSRF-Token', anon.csrf).send({});
    expect(anonSuspend.status).toBe(401);
    expect(anonSuspend.body).toMatchObject({ success: false, code: 'AUTH_REQUIRED', message: 'No session to suspend' });

    const w = await world();
    const agent = request.agent(app);
    const login = await loginOk(agent, { username: 'sam', secret: '4321' });

    const suspend = await agent.post('/api/auth/suspend').set('X-CSRF-Token', login.csrf).send({});
    expect(suspend.status).toBe(200);
    expect(suspend.body).toEqual({ success: true, data: { suspended: true } });

    const intro = await agent.get('/api/auth/session');
    expect(intro.body.data.suspended).toBe(true);

    const usage = await agent.get('/api/auth/usage');
    expect(usage.status).toBe(403);
    expect(usage.body).toMatchObject({ code: 'SESSION_SUSPENDED', message: 'This session is suspended — resume it first' });
    const adminAttempt = await agent.get('/api/auth/admin/users');
    expect(adminAttempt.status).toBe(403);
    expect(adminAttempt.body.code).toBe('SESSION_SUSPENDED');
    // The guarded enroll verb needs its CSRF token to reach the route's own
    // gate (the CSRF chain runs first on non-exempt POSTs).
    const enroll = await agent.post('/api/auth/webauthn/register/options')
      .set('X-CSRF-Token', login.csrf).send({});
    expect(enroll.status).toBe(403);
    expect(enroll.body.code).toBe('SESSION_SUSPENDED');

    // Resume through reverify.
    const resume = await agent.post('/api/auth/reverify').send({ secret: '4321' });
    expect(resume.status).toBe(200);
    expect((await agent.get('/api/auth/session')).body.data.suspended).toBe(false);
    expect((await agent.get('/api/auth/usage')).status).toBe(200);
  });

  it('suspend cannot pyramid sessions: extras beyond the policy are revoked first', async () => {
    const w = await world();
    // Three stale sids for sam in the session map, then a fourth login.
    for (let i = 0; i < 3; i++) {
      await loginOk(request.agent(app), { username: 'sam', secret: '4321' });
    }
    const agent = request.agent(app);
    const login = await loginOk(agent, { username: 'sam', secret: '4321' });
    // default policy: maxSuspendedSessionsPerAccount = 1 → 3 existing (>= 1+1)
    // exceeds it, so suspending must revoke the oldest extras first.
    const suspend = await agent.post('/api/auth/suspend').set('X-CSRF-Token', login.csrf).send({});
    expect(suspend.status).toBe(200);

    const adminList = await w.owner.get('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf);
    const sam = adminList.body.data.users.find(u => u.username === 'sam');
    expect(sam.trackedSessions).toBe(1); // only the just-registered sid survives
    expect(usersDb.sessionsForUser(w.samUid)).toEqual([login.sid]);
  });
});

// ─── 6. self-service credential changes ────────────────────────────────────

describe('auth-routes — /change-pin and /change-passphrase', () => {
  it('change-pin: 401 anonymous, validation, wrong current secret, success keeps the session alive', async () => {
    const anonHost = await anonSession(app);
    const anon = await anonHost.agent.post('/api/auth/change-pin')
      .set('X-CSRF-Token', anonHost.csrf).send({ newPin: '5555' });
    expect(anon.status).toBe(401);
    expect(anon.body).toMatchObject({ code: 'AUTH_REQUIRED', message: 'Sign in first' });

    const w = await world();
    const agent = request.agent(app);
    const login = await loginOk(agent, { username: 'sam', secret: '4321' });

    const nonString = await agent.post('/api/auth/change-pin')
      .set('X-CSRF-Token', login.csrf).send({ newPin: 5555, currentSecret: '4321' });
    expect(nonString.status).toBe(400);
    expect(nonString.body).toMatchObject({ success: false, code: 'INVALID_ARGS', message: 'newPin is required' });

    // Wrong current secret — normal outcome on a settings form.
    const wrong = await agent.post('/api/auth/change-pin')
      .set('X-CSRF-Token', login.csrf).send({ currentSecret: '0000', newPin: '5555' });
    expect(wrong.status).toBe(200);
    expect(wrong.body).toMatchObject({ success: false, code: 'BAD_CREDENTIAL', message: 'Current PIN is incorrect' });

    const missing = await agent.post('/api/auth/change-pin')
      .set('X-CSRF-Token', login.csrf).send({ newPin: '5555' });
    expect(missing.body.code).toBe('BAD_CREDENTIAL');

    // Right secret, invalid new pin → the users-db validation message.
    const invalid = await agent.post('/api/auth/change-pin')
      .set('X-CSRF-Token', login.csrf).send({ currentSecret: '4321', newPin: '12' });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ success: false, code: 'INVALID_PIN', message: 'PIN must be 4 to 6 digits' });

    // Success: the new PIN works, the old one does not, and the CURRENT
    // session is NOT invalidated (real behavior — only reset-credential revokes).
    const change = await agent.post('/api/auth/change-pin')
      .set('X-CSRF-Token', login.csrf).send({ currentSecret: '4321', newPin: '5555' });
    expect(change.status).toBe(200);
    expect(change.body).toEqual({ success: true, data: { changed: true } });

    const oldLogin = await request(app).post('/api/auth/login').send({ uid: w.samUid, secret: '4321' });
    expect(oldLogin.body.code).toBe('BAD_CREDENTIAL');
    const newLogin = await loginOk(request.agent(app), { uid: w.samUid, secret: '5555' });
    expect(newLogin.body.data.user.username).toBe('sam');

    const stillAuthed = await agent.get('/api/auth/session');
    expect(stillAuthed.body.data.authenticated).toBe(true);
    expect((await agent.get('/api/auth/usage')).status).toBe(200);
  });

  it('change-passphrase: wrong current secret, too-short value, set, verify by login, clear with null', async () => {
    const w = await world();
    await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ displayName: 'Pat', username: 'pat', pin: '7777', passphrase: 'pat-pass-123', role: 'standard' });
    const pat = usersDb.getUserByUsername('pat').uid;

    const agent = request.agent(app);
    const login = await loginOk(agent, { uid: pat, secret: '7777' });

    const anonHost = await anonSession(app);
    const anon = await anonHost.agent.post('/api/auth/change-passphrase')
      .set('X-CSRF-Token', anonHost.csrf).send({ passphrase: 'x'.repeat(12) });
    expect(anon.status).toBe(401);

    const wrong = await agent.post('/api/auth/change-passphrase')
      .set('X-CSRF-Token', login.csrf).send({ currentSecret: 'wrong-text', passphrase: 'brand-new-pass' });
    expect(wrong.status).toBe(200);
    expect(wrong.body).toMatchObject({ success: false, code: 'BAD_CREDENTIAL', message: 'Current secret is incorrect' });

    const missing = await agent.post('/api/auth/change-passphrase')
      .set('X-CSRF-Token', login.csrf).send({ passphrase: 'brand-new-pass' });
    expect(missing.body.code).toBe('BAD_CREDENTIAL');

    const tooShort = await agent.post('/api/auth/change-passphrase')
      .set('X-CSRF-Token', login.csrf).send({ currentSecret: 'pat-pass-123', passphrase: 'short' });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body).toMatchObject({ success: false, code: 'INVALID_PASSPHRASE', message: 'Passphrase must be at least 8 characters' });

    // Current secret may be either the PIN or the passphrase (auto kind).
    const change = await agent.post('/api/auth/change-passphrase')
      .set('X-CSRF-Token', login.csrf).send({ currentSecret: '7777', passphrase: 'brand-new-pass' });
    expect(change.status).toBe(200);
    expect(change.body).toEqual({ success: true, data: { changed: true } });

    const viaPhrase = await loginOk(request.agent(app), { uid: pat, secret: 'brand-new-pass' });
    expect(viaPhrase.body.data.via).toBe('passphrase');

    // Clearing: passphrase null removes the credential row entirely.
    const clear = await agent.post('/api/auth/change-passphrase')
      .set('X-CSRF-Token', login.csrf).send({ currentSecret: 'brand-new-pass', passphrase: null });
    expect(clear.status).toBe(200);
    const phraseLogin = await request(app).post('/api/auth/login')
      .send({ uid: pat, secret: 'brand-new-pass' });
    expect(phraseLogin.body.code).toBe('BAD_CREDENTIAL');
    expect((await loginOk(request.agent(app), { uid: pat, secret: '7777' })).body.success).toBe(true);
  });
});

// ─── 7. admin credential reset flow ────────────────────────────────────────

describe('auth-routes — admin credential reset (temporary PIN + forced change)', () => {
  it('reset-credential: 404 unknown, revokes live sessions, issues a one-time 6-digit PIN, forces a change', async () => {
    const w = await world();
    seedSessionsDb(w.ownerSid);

    const unknown = await w.owner.post('/api/auth/admin/users/11111111-2222-3333-4444-555555555555/reset-credential')
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ success: false, code: 'NOT_FOUND', message: 'No such account' });

    const otherAccount = await w.owner.post(`/api/auth/admin/users/${w.samUid}/reset-credential`)
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(otherAccount.status).toBe(403);
    expect(otherAccount.body).toMatchObject({ success: false, code: 'SELF_ONLY' });

    const reset = await w.owner.post(`/api/auth/admin/users/${w.adaUid}/reset-credential`)
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(reset.status).toBe(200);
    const temporaryPin = reset.body.data.temporaryPin;
    expect(temporaryPin).toMatch(/^\d{6}$/);
    expect(reset.body.data.expiresAt).toBeGreaterThan(Date.now());
    expect(reset.body.data).toMatchObject({ uid: w.adaUid, username: 'ada' });

    // The reset revokes every live session of the account — the sid row dies
    // in sessions.db and the session map no longer tracks it.
    expect(sessionsDbHas(w.ownerSid)).toBe(false);
    expect(usersDb.sessionsForUser(w.adaUid)).toEqual([]);

    // Current behavior, pinned: the previous PIN also still authenticates
    // after a reset (both routes land on the forced new-PIN sheet). The
    // temporary window does not remove the old credential row.
    const viaOld = await loginOk(request.agent(app), { uid: w.adaUid, secret: '123456' });
    expect(viaOld.body.data.mustChangePin).toBe(true);
    expect(viaOld.body.data.via).toBe('pin');

    const viaTemp = await loginOk(request.agent(app), { uid: w.adaUid, secret: temporaryPin });
    expect(viaTemp.body.data.mustChangePin).toBe(true);
    expect(viaTemp.body.data.via).toBe('temporary-pin');

    // The forced session can set a new PIN WITHOUT knowing any current secret.
    const forced = request.agent(app);
    const forcedLogin = await loginOk(forced, { uid: w.adaUid, secret: temporaryPin });
    const noCurrent = await forced.post('/api/auth/change-pin')
      .set('X-CSRF-Token', forcedLogin.csrf).send({ newPin: '6767' });
    expect(noCurrent.status).toBe(200);

    // Old and temporary PINs are gone; the new one works without the sheet.
    expect((await request(app).post('/api/auth/login').send({ uid: w.adaUid, secret: '123456' })).body.code).toBe('BAD_CREDENTIAL');
    expect((await request(app).post('/api/auth/login').send({ uid: w.adaUid, secret: temporaryPin })).body.code).toBe('BAD_CREDENTIAL');
    const fresh = await loginOk(request.agent(app), { uid: w.adaUid, secret: '6767' });
    expect(fresh.body.data.mustChangePin).toBe(false);

    // A second change now requires the current secret again.
    const secondNoCurrent = await request.agent(app);
    const secondLogin = await loginOk(secondNoCurrent, { uid: w.adaUid, secret: '6767' });
    const rejected = await secondNoCurrent.post('/api/auth/change-pin')
      .set('X-CSRF-Token', secondLogin.csrf).send({ newPin: '8989' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.code).toBe('BAD_CREDENTIAL');
  });

  it('admin direct credential routes: set PIN, set/clear passphrase, validation and 404s', async () => {
    const w = await world();

    const otherPin = await w.owner.post(`/api/auth/admin/users/${w.samUid}/credentials/pin`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ pin: '7777' });
    expect(otherPin.status).toBe(403);
    expect(otherPin.body).toMatchObject({ success: false, code: 'SELF_ONLY' });

    const badPin = await w.owner.post(`/api/auth/admin/users/${w.adaUid}/credentials/pin`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ pin: '99ab' });
    expect(badPin.status).toBe(400);
    expect(badPin.body).toMatchObject({ success: false, code: 'INVALID_PIN', message: 'PIN must be 4 to 6 digits' });

    const numericPin = await w.owner.post(`/api/auth/admin/users/${w.adaUid}/credentials/pin`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ pin: 7777 });
    expect(numericPin.status).toBe(200);
    expect(await loginOk(request.agent(app), { uid: w.adaUid, secret: '7777' })).toBeTruthy();

    const setPhrase = await w.owner.post(`/api/auth/admin/users/${w.samUid}/credentials/passphrase`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ passphrase: 'admin-set-pass' });
    expect(setPhrase.status).toBe(200);
    const viaPhrase = await loginOk(request.agent(app), { uid: w.samUid, secret: 'admin-set-pass' });
    expect(viaPhrase.body.data.via).toBe('passphrase');

    const shortPhrase = await w.owner.post(`/api/auth/admin/users/${w.samUid}/credentials/passphrase`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ passphrase: 'tiny' });
    expect(shortPhrase.status).toBe(400);
    expect(shortPhrase.body).toMatchObject({ code: 'INVALID_PASSPHRASE', message: 'Passphrase must be at least 8 characters' });

    const clearPhrase = await w.owner.post(`/api/auth/admin/users/${w.samUid}/credentials/passphrase`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ passphrase: null });
    expect(clearPhrase.status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ uid: w.samUid, secret: 'admin-set-pass' })).body.code)
      .toBe('BAD_CREDENTIAL');

    const unknownPin = await w.owner.post('/api/auth/admin/users/11111111-2222-3333-4444-555555555555/credentials/pin')
      .set('X-CSRF-Token', w.ownerCsrf).send({ pin: '1234' });
    expect(unknownPin.status).toBe(404);
    expect(unknownPin.body.code).toBe('NOT_FOUND');

    const unknownPhrase = await w.owner.post('/api/auth/admin/users/11111111-2222-3333-4444-555555555555/credentials/passphrase')
      .set('X-CSRF-Token', w.ownerCsrf).send({ passphrase: null });
    expect(unknownPhrase.status).toBe(404);
  });
});

// ─── 8. WebAuthn e2e ────────────────────────────────────────────────────────

describe('auth-routes — WebAuthn enrollment and passwordless login', () => {
  function p256() {
    const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return { privateKey, jwk: publicKey.export({ format: 'jwk' }) };
  }

  async function enrollFor(agent, csrf, { uid, credId, cose, label = 'Test key', alg }) {
    const options = await agent.post('/api/auth/webauthn/register/options')
      .set('X-CSRF-Token', csrf).send(uid ? { uid } : {});
    expect(options.status).toBe(200);
    const challenge = options.body.data.challenge;
    const finish = await agent.post('/api/auth/webauthn/register/finish')
      .set('X-CSRF-Token', csrf)
      .send({
        credentialId: credId,
        publicKey: cose,
        alg,
        label,
        clientDataJSON: clientDataB64u('webauthn.create', challenge),
      });
    return { options, finish, challenge };
  }

  async function loginFinishBody(uid, credId, challenge, { authData, clientData, signatureB64u }) {
    return {
      uid, credentialId: credId,
      authenticatorData: b64u(authData),
      clientDataJSON: clientData ?? clientDataB64u('webauthn.get', challenge),
      signature: signatureB64u,
    };
  }

  it('register/options gates: anonymous, self-enrollment, admin-for-other, unknown target', async () => {
    const w = await world();

    const anonHost = await anonSession(app);
    const anon = await anonHost.agent.post('/api/auth/webauthn/register/options')
      .set('X-CSRF-Token', anonHost.csrf).send({});
    expect(anon.status).toBe(401);
    expect(anon.body).toMatchObject({ code: 'AUTH_REQUIRED', message: 'Sign in first' });

    // A standard session enrolling for ITSELF (the 2026-11-15 M3 fix).
    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    const self = await sam.post('/api/auth/webauthn/register/options')
      .set('X-CSRF-Token', samLogin.csrf).send({});
    expect(self.status).toBe(200);
    expect(self.body.data.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(self.body.data.user).toEqual({
      id: b64u(w.samUid), name: 'sam', displayName: 'Sam Smith',
    });
    expect(self.body.data.rp).toEqual({ id: 'localhost', name: 'NovaByte OS' });
    expect(self.body.data.pubKeyCredParams).toEqual([
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
      { type: 'public-key', alg: -8 },
    ]);
    expect(self.body.data.excludeCredentials).toEqual([]);

    // A standard session may NOT enroll for someone else.
    const escalation = await sam.post('/api/auth/webauthn/register/options')
      .set('X-CSRF-Token', samLogin.csrf).send({ uid: w.adaUid });
    expect(escalation.status).toBe(403);
    expect(escalation.body).toMatchObject({
      code: 'ADMIN_REQUIRED',
      message: 'Only administrators may enroll authenticators for another account',
    });

    // An admin session may enroll on behalf of another account.
    const forOther = await w.owner.post('/api/auth/webauthn/register/options')
      .set('X-CSRF-Token', w.ownerCsrf).send({ uid: w.samUid });
    expect(forOther.status).toBe(200);
    expect(forOther.body.data.user.id).toBe(b64u(w.samUid));

    // Unknown target.
    const unknown = await w.owner.post('/api/auth/webauthn/register/options')
      .set('X-CSRF-Token', w.ownerCsrf).send({ uid: '11111111-2222-3333-4444-555555555555' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'NOT_FOUND', message: 'No such account' });
  });

  it('register/finish validation branches', async () => {
    const w = await world();
    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    const key = p256();

    // Missing fields.
    const missing = await sam.post('/api/auth/webauthn/register/finish')
      .set('X-CSRF-Token', samLogin.csrf).send({ credentialId: 'cred-1' });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({
      code: 'INVALID_ARGS',
      message: 'credentialId, publicKey and clientDataJSON are required',
    });

    // publicKey not an array.
    const notArray = await sam.post('/api/auth/webauthn/register/finish')
      .set('X-CSRF-Token', samLogin.csrf)
      .send({ credentialId: 'cred-1', publicKey: 'blob', clientDataJSON: 'e30' });
    expect(notArray.status).toBe(400);
    expect(notArray.body.code).toBe('INVALID_ARGS');

    // Real challenge, wrong client data type.
    const options = await sam.post('/api/auth/webauthn/register/options')
      .set('X-CSRF-Token', samLogin.csrf).send({});
    const challenge = options.body.data.challenge;
    const wrongType = await sam.post('/api/auth/webauthn/register/finish')
      .set('X-CSRF-Token', samLogin.csrf)
      .send({
        credentialId: 'cred-1', publicKey: coseEc(key.jwk),
        clientDataJSON: clientDataB64u('webauthn.get', challenge), // wrong verb
      });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body).toMatchObject({ code: 'WEBAUTHN_INVALID', message: 'Client data failed verification' });

    // Bad origin.
    const badOrigin = await sam.post('/api/auth/webauthn/register/finish')
      .set('X-CSRF-Token', samLogin.csrf)
      .send({
        credentialId: 'cred-1', publicKey: coseEc(key.jwk),
        clientDataJSON: clientDataB64u('webauthn.create', challenge, 'https://evil.example'),
      });
    expect(badOrigin.status).toBe(400);
    expect(badOrigin.body.code).toBe('WEBAUTHN_INVALID');

    // Unparseable client data JSON.
    const garbage = await sam.post('/api/auth/webauthn/register/finish')
      .set('X-CSRF-Token', samLogin.csrf)
      .send({ credentialId: 'cred-1', publicKey: coseEc(key.jwk), clientDataJSON: '!!!not-b64u!!!' });
    expect(garbage.status).toBe(400);
    expect(garbage.body.code).toBe('WEBAUTHN_INVALID');

    // Unknown challenge.
    const unknownChallenge = await sam.post('/api/auth/webauthn/register/finish')
      .set('X-CSRF-Token', samLogin.csrf)
      .send({
        credentialId: 'cred-1', publicKey: coseEc(key.jwk),
        clientDataJSON: clientDataB64u('webauthn.create', 'does-not-exist'),
      });
    expect(unknownChallenge.status).toBe(400);
    expect(unknownChallenge.body).toMatchObject({ code: 'WEBAUTHN_INVALID', message: 'Unknown or expired challenge' });

    // Unsupported key types. NOTE: takeChallenge() consumes the challenge on
    // LOOKUP (before the key conversion), so every attempt that gets past
    // clientDataOk needs its own fresh challenge — the next block reuses none.
    const unsupportedKty = await sam.post('/api/auth/webauthn/register/finish')
      .set('X-CSRF-Token', samLogin.csrf)
      .send({
        credentialId: 'cred-1', publicKey: [1, 99, 3, -7],
        clientDataJSON: clientDataB64u('webauthn.create', challenge),
      });
    expect(unsupportedKty.status).toBe(400);
    expect(unsupportedKty.body).toMatchObject({
      code: 'WEBAUTHN_UNSUPPORTED',
      message: 'Only ES256, RS256 and Ed25519 credentials are supported',
    });

    // Fresh challenge for the wrong-curve attempt: the previous one was
    // consumed by the unsupported-kty lookup even though that attempt failed.
    const freshOptions = await sam.post('/api/auth/webauthn/register/options')
      .set('X-CSRF-Token', samLogin.csrf).send({});
    const freshChallenge = freshOptions.body.data.challenge;
    const wrongCurve = await sam.post('/api/auth/webauthn/register/finish')
      .set('X-CSRF-Token', samLogin.csrf)
      .send({
        credentialId: 'cred-1', publicKey: [1, 2, 3, -7, -1, 2, -2, key.jwk.x, -3, key.jwk.y],
        clientDataJSON: clientDataB64u('webauthn.create', freshChallenge),
      });
    expect(wrongCurve.status).toBe(400);
    expect(wrongCurve.body.code).toBe('WEBAUTHN_UNSUPPORTED');
    // A spent challenge cannot be replayed into a new one.
    const spent = await sam.post('/api/auth/webauthn/register/finish')
      .set('X-CSRF-Token', samLogin.csrf)
      .send({
        credentialId: 'cred-1', publicKey: coseEc(key.jwk),
        clientDataJSON: clientDataB64u('webauthn.create', challenge),
      });
    expect(spent.status).toBe(400);
    expect(spent.body).toMatchObject({ code: 'WEBAUTHN_INVALID', message: 'Unknown or expired challenge' });
    // No credential was stored by any of the failed attempts.
    expect((await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid })).status).toBe(400);
  });

  it('a challenge issued to one standard account cannot be finished by another (challenge theft → 403)', async () => {
    const w = await world();
    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    const key = p256();

    // sam gets a self-enrollment challenge…
    const options = await sam.post('/api/auth/webauthn/register/options')
      .set('X-CSRF-Token', samLogin.csrf).send({});
    const challenge = options.body.data.challenge;

    // …but PAT (a different standard session) presents it. The challenge
    // entry belongs to sam, so the finish must refuse PAT.
    const w2 = { ...w }; // same world, extra account below
    await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ displayName: 'Pat', username: 'pat', pin: '7777', role: 'standard' });
    const pat = request.agent(app);
    const patLogin = await loginOk(pat, { username: 'pat', secret: '7777' });

    const stolen = await pat.post('/api/auth/webauthn/register/finish')
      .set('X-CSRF-Token', patLogin.csrf)
      .send({
        credentialId: 'stolen-cred',
        publicKey: coseEc(p256().jwk),
        clientDataJSON: clientDataB64u('webauthn.create', challenge),
      });
    expect(stolen.status).toBe(403);
    expect(stolen.body).toMatchObject({ code: 'ADMIN_REQUIRED' });
    expect(usersDb.getWebauthnCredential('stolen-cred')).toBeNull();
  });

  it('an authenticator cannot be enrolled to two accounts (CRED_TAKEN)', async () => {
    const w = await world();
    const key = p256();
    const credId = 'shared-cred-1';

    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    const first = await enrollFor(sam, samLogin.csrf, { credId, cose: coseEc(key.jwk), alg: -7 });
    expect(first.finish.status).toBe(200);
    expect(first.finish.body).toEqual({ success: true, data: { enrolled: true } });

    // The same credentialId for a different account is refused.
    const w2 = { ...w };
    await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ displayName: 'Pat', username: 'pat', pin: '7777', role: 'standard' });
    const pat = request.agent(app);
    const patLogin = await loginOk(pat, { username: 'pat', secret: '7777' });
    const second = await enrollFor(pat, patLogin.csrf, { credId, cose: coseEc(p256().jwk) });
    expect(second.finish.status).toBe(400);
    expect(second.finish.body).toMatchObject({
      code: 'CRED_TAKEN',
      message: 'This authenticator is already enrolled to another account',
    });
  });

  it('the admin-enrolls-for-other flow lands the credential on the TARGET account', async () => {
    const w = await world();
    const key = p256();
    const credId = 'admin-issued-1';

    // The owner requests the challenge for sam and finishes it from the
    // owner session: the challenge belongs to sam, the session is admin.
    const result = await enrollFor(w.owner, w.ownerCsrf, { uid: w.samUid, credId, cose: coseEc(key.jwk), alg: -7 });
    expect(result.finish.status).toBe(200);

    const listing = await w.owner.get(`/api/auth/admin/users/${w.samUid}/webauthn`)
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(listing.status).toBe(200);
    expect(listing.body.data.credentials.map(c => c.cred_id)).toContain(credId);
    // …and the credential is NOT on the owner's own account.
    const own = await w.owner.get('/api/auth/webauthn/credentials').set('X-CSRF-Token', w.ownerCsrf);
    expect(own.body.data.credentials.map(c => c.cred_id)).not.toContain(credId);
  });

  it('passwordless login: a fully valid assertion currently 500s — usersDb.touchLogin is not exported (SOURCE BUG, auth-routes.js:815)', async () => {
    const w = await world();
    const key = p256();
    const credId = 'sam-key-1';

    // Enroll over HTTP as sam (self-enrollment).
    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    const enrolled = await enrollFor(sam, samLogin.csrf, {
      credId, cose: coseEc(key.jwk), alg: -7, label: 'Sam Yubi',
    });
    expect(enrolled.finish.status).toBe(200);

    // Self-service listing shows it.
    const selfList = await sam.get('/api/auth/webauthn/credentials').set('X-CSRF-Token', samLogin.csrf);
    expect(selfList.status).toBe(200);
    expect(selfList.body.data.credentials).toHaveLength(1);
    expect(selfList.body.data.credentials[0]).toMatchObject({ cred_id: credId, alg: -7, label: 'Sam Yubi', sign_count: 0 });

    // login/options now returns the allowCredentials list.
    const opts = await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid });
    expect(opts.status).toBe(200);
    expect(opts.body.data).toMatchObject({
      rpId: 'localhost', timeout: 60000, userVerification: 'required',
    });
    expect(opts.body.data.allowCredentials).toEqual([{ type: 'public-key', id: credId }]);
    const challenge = opts.body.data.challenge;

    // Build a genuine assertion: authData(rpIdHash,flags,counter=1) + clientData,
    // signed with the enrolled private key in DER form. The signature, the RP
    // ID hash, the counter and the challenge all verify — the route then calls
    // usersDb.touchLogin(uid) at auth-routes.js:815, but users-db.js defines
    // touchLogin as a PRIVATE function (line 840) and never exports it, so the
    // call throws TypeError: usersDb.touchLogin is not a function. There is no
    // try/catch around it, so express's default error handler answers 500 with
    // an empty (non-JSON) body. This test pins the CURRENT behavior; the fix
    // belongs in server/security/users-db.js (export touchLogin) — outside this
    // suite's remit.
    const authData = makeAuthData(1);
    const cd = clientDataB64u('webauthn.get', challenge);
    const derSig = nodeCrypto.sign('sha256', assertionMessage(authData, cd), key.privateKey);

    const finish = await request(app).post('/api/auth/webauthn/login/finish')
      .send(await loginFinishBody(w.samUid, credId, challenge, {
        authData, clientData: cd, signatureB64u: b64u(derSig),
      }));
    expect(finish.status).toBe(500);
    expect(finish.body).toEqual({}); // no JSON error envelope — bare express 500

    // No session was established: the only Set-Cookie on the 500 is the
    // anonymous page session the CSRF chain persisted; presented back, it
    // introspects as anonymous (authenticated:false).
    const setCookie = (finish.headers['set-cookie'] || []).join('; ');
    expect(setCookie).toMatch(/^connect\.sid=s%3A/);
    const after = await request(app).get('/api/auth/session').set('Cookie', setCookie);
    expect(after.body.data.authenticated).toBe(false);

    // The challenge was still consumed — takeChallenge() runs before the crash.
    const finish2 = await request(app).post('/api/auth/webauthn/login/finish')
      .send(await loginFinishBody(w.samUid, credId, challenge, {
        authData, clientData: cd, signatureB64u: b64u(derSig),
      }));
    expect(finish2.status).toBe(400); // challenges are one-shot
    expect(finish2.body).toMatchObject({ code: 'WEBAUTHN_INVALID', message: 'Unknown, expired or cross-account challenge' });

    // touchWebauthnUse + resetAuthFailures ran before the crash: the sign
    // counter is tracked (1) and last_used_at stamped…
    const listAfter = await sam.get('/api/auth/webauthn/credentials').set('X-CSRF-Token', samLogin.csrf);
    expect(listAfter.body.data.credentials[0].sign_count).toBe(1);
    expect(listAfter.body.data.credentials[0].last_used_at).toBeGreaterThan(0);
    expect(usersDb.isTemporarilyLocked(w.samUid)).toBe(false); // counters were reset
    // …but the auth.success log line (auth-routes.js:817) never runs, so no
    // webauthn success is audited. A PIN login still succeeds normally.
    const events = await w.owner.get('/api/auth/admin/events')
      .query({ action: 'auth.success' }).set('X-CSRF-Token', w.ownerCsrf);
    expect(events.body.data.events.filter(e => e.detail?.via === 'webauthn')).toEqual([]);
    expect((await loginOk(request.agent(app), { uid: w.samUid, secret: '4321' })).body.success).toBe(true);
  });

  it('a raw r||s signature (as browsers send it) passes the DER conversion — and then hits the touchLogin crash', async () => {
    const w = await world();
    const key = p256();
    const credId = 'sam-key-raw';

    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    expect((await enrollFor(sam, samLogin.csrf, { credId, cose: coseEc(key.jwk) })).finish.status).toBe(200);

    const opts = await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid });
    const challenge = opts.body.data.challenge;
    const authData = makeAuthData(5);
    const cd = clientDataB64u('webauthn.get', challenge);
    const derSig = nodeCrypto.sign('sha256', assertionMessage(authData, cd), key.privateKey);
    const rawSig = derToRaw(derSig);
    expect(rawSig.length).toBe(64);

    // The raw 64-byte r||s form is converted to DER server-side and the
    // signature VERIFIES — observable because the route moves past the
    // WEBAUTHN_SIGNATURE gate and crashes at the documented touchLogin call
    // instead (a failed conversion/verify would answer 401 WEBAUTHN_SIGNATURE).
    const finish = await request(app).post('/api/auth/webauthn/login/finish')
      .send(await loginFinishBody(w.samUid, credId, challenge, {
        authData, clientData: cd, signatureB64u: b64u(rawSig),
      }));
    expect(finish.status).toBe(500);
    expect(finish.body).toEqual({});
    // The counter advanced to 5 before the crash.
    expect((await sam.get('/api/auth/webauthn/credentials').set('X-CSRF-Token', samLogin.csrf))
      .body.data.credentials[0].sign_count).toBe(5);
  });

  it('Ed25519 (EdDSA) and RSA (RS256) credentials verify in their own branches (then hit the touchLogin crash)', async () => {
    const w = await world();

    // Ed25519 — the EdDSA branch of verifyAssertionSignature.
    const edPair = nodeCrypto.generateKeyPairSync('ed25519');
    const edJwk = edPair.publicKey.export({ format: 'jwk' });
    const edCred = 'ed-key-1';
    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    expect((await enrollFor(sam, samLogin.csrf, { credId: edCred, cose: coseOkp(edJwk), alg: -8 })).finish.status)
      .toBe(200);

    const edOpts = await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid });
    const edChallenge = edOpts.body.data.challenge;
    const edAuthData = makeAuthData(3);
    const edCd = clientDataB64u('webauthn.get', edChallenge);
    const edSig = nodeCrypto.sign(null, assertionMessage(edAuthData, edCd), edPair.privateKey);
    const edFinish = await request(app).post('/api/auth/webauthn/login/finish')
      .send(await loginFinishBody(w.samUid, edCred, edChallenge, {
        authData: edAuthData, clientData: edCd, signatureB64u: b64u(edSig),
      }));
    // The EdDSA verification passed (a failure would be 401 WEBAUTHN_SIGNATURE)
    // and the route crashed at the documented touchLogin call.
    expect(edFinish.status).toBe(500);
    expect(edFinish.body).toEqual({});
    expect((await sam.get('/api/auth/webauthn/credentials').set('X-CSRF-Token', samLogin.csrf))
      .body.data.credentials.find(c => c.cred_id === edCred).sign_count).toBe(3);

    // RSA 2048 — the RS256 branch.
    const rsaPair = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaJwk = rsaPair.publicKey.export({ format: 'jwk' });
    const rsaCred = 'rsa-key-1';
    expect((await enrollFor(sam, samLogin.csrf, { credId: rsaCred, cose: coseRsa(rsaJwk), alg: -257 })).finish.status)
      .toBe(200);
    const rsaOpts = await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid });
    const rsaChallenge = rsaOpts.body.data.challenge;
    const rsaAuthData = makeAuthData(9);
    const rsaCd = clientDataB64u('webauthn.get', rsaChallenge);
    const rsaSig = nodeCrypto.sign('sha256', assertionMessage(rsaAuthData, rsaCd), rsaPair.privateKey);
    const rsaFinish = await request(app).post('/api/auth/webauthn/login/finish')
      .send(await loginFinishBody(w.samUid, rsaCred, rsaChallenge, {
        authData: rsaAuthData, clientData: rsaCd, signatureB64u: b64u(rsaSig),
      }));
    expect(rsaFinish.status).toBe(500);
    expect(rsaFinish.body).toEqual({});
    expect((await sam.get('/api/auth/webauthn/credentials').set('X-CSRF-Token', samLogin.csrf))
      .body.data.credentials.find(c => c.cred_id === rsaCred).sign_count).toBe(9);
  });

  it('login/finish validation and failure branches', async () => {
    const w = await world();
    const key = p256();
    const credId = 'gate-key-1';
    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    expect((await enrollFor(sam, samLogin.csrf, { credId, cose: coseEc(key.jwk) })).finish.status).toBe(200);

    // Missing args.
    const missing = await request(app).post('/api/auth/webauthn/login/finish')
      .send({ uid: w.samUid, credentialId: credId });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({
      code: 'INVALID_ARGS',
      message: 'uid, credentialId, authenticatorData, clientDataJSON and signature are required',
    });

    const opts = await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid });
    const challenge = opts.body.data.challenge;

    // Wrong client-data type.
    const wrongType = await request(app).post('/api/auth/webauthn/login/finish')
      .send({
        uid: w.samUid, credentialId: credId,
        authenticatorData: b64u(makeAuthData(1)),
        clientDataJSON: clientDataB64u('webauthn.create', challenge),
        signature: b64u('x'.repeat(64)),
      });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body).toMatchObject({ code: 'WEBAUTHN_INVALID', message: 'Client data failed verification' });

    // Cross-account challenge: options for sam, finish claiming ada's uid.
    const cross = await request(app).post('/api/auth/webauthn/login/finish')
      .send({
        uid: w.adaUid, credentialId: credId,
        authenticatorData: b64u(makeAuthData(1)),
        clientDataJSON: clientDataB64u('webauthn.get', challenge),
        signature: b64u('y'.repeat(64)),
      });
    expect(cross.status).toBe(400);
    expect(cross.body).toMatchObject({ code: 'WEBAUTHN_INVALID', message: 'Unknown, expired or cross-account challenge' });

    // Credential does not belong to the claimed account. The challenge is
    // issued for SAM (so the challenge→uid binding passes), and the owner
    // enrolls a separate credential for ADA; presenting ADA's credentialId
    // while claiming sam's uid trips the credential-ownership gate → 401 +
    // a failure recorded on the CLAIMED account.
    const ownerKey = p256();
    const ownerCred = 'owner-key-1';
    const owner = w.owner; // already an authenticated agent
    expect((await enrollFor(w.owner, w.ownerCsrf, { credId: ownerCred, cose: coseEc(ownerKey.jwk) })).finish.status)
      .toBe(200);
    const samOpts = await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid });
    const samChallenge = samOpts.body.data.challenge;
    const ownerAuthData = makeAuthData(1);
    const ownerCd = clientDataB64u('webauthn.get', samChallenge);
    const ownerSig = nodeCrypto.sign('sha256', assertionMessage(ownerAuthData, ownerCd), ownerKey.privateKey);
    // Presenting the owner credential while claiming sam's uid → 401 + failure recorded.
    const mismatch = await request(app).post('/api/auth/webauthn/login/finish')
      .send(await loginFinishBody(w.samUid, ownerCred, samChallenge, {
        authData: ownerAuthData, clientData: ownerCd, signatureB64u: b64u(ownerSig),
      }));
    expect(mismatch.status).toBe(401);
    expect(mismatch.body).toMatchObject({ code: 'WEBAUTHN_INVALID', message: 'Credential does not match this account' });
    expect(usersDb.isTemporarilyLocked(w.samUid)).toBe(false); // 1 failure: no window yet

    // Unknown credential id entirely.
    const opts2 = await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid });
    const challenge2 = opts2.body.data.challenge;
    const noCred = await request(app).post('/api/auth/webauthn/login/finish')
      .send(await loginFinishBody(w.samUid, 'no-such-cred', challenge2, {
        authData: makeAuthData(1), signatureB64u: b64u('z'.repeat(64)),
      }));
    expect(noCred.status).toBe(401);
    expect(noCred.body.code).toBe('WEBAUTHN_INVALID');

    // Bad signature (valid format, wrong key).
    const opts3 = await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid });
    const challenge3 = opts3.body.data.challenge;
    const otherKey = p256();
    const badSig = await request(app).post('/api/auth/webauthn/login/finish')
      .send(await loginFinishBody(w.samUid, credId, challenge3, {
        authData: makeAuthData(1),
        signatureB64u: b64u(nodeCrypto.sign('sha256', assertionMessage(makeAuthData(1), clientDataB64u('webauthn.get', challenge3)), otherKey.privateKey)),
      }));
    expect(badSig.status).toBe(401);
    expect(badSig.body).toMatchObject({ code: 'WEBAUTHN_SIGNATURE', message: 'Signature verification failed' });
    // audited as auth.failure via webauthn.
    const events = await w.owner.get('/api/auth/admin/events')
      .query({ action: 'auth.failure', uid: w.samUid }).set('X-CSRF-Token', w.ownerCsrf);
    expect(events.body.data.events.some(e => e.detail && e.detail.via === 'webauthn')).toBe(true);
  });

  it('authenticator-data defences: RP ID hash mismatch, too-short authData, clone regression', async () => {
    const w = await world();
    const key = p256();
    const credId = 'defense-key-1';
    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    expect((await enrollFor(sam, samLogin.csrf, { credId, cose: coseEc(key.jwk) })).finish.status).toBe(200);

    // Two valid logins first: counter 1 then 2. Each one passes signature
    // verification and advances the stored counter, then crashes at the
    // documented touchLogin call (auth-routes.js:815) — the 500 is the proof
    // the assertion got past every earlier gate.
    for (const counter of [1, 2]) {
      const opts = await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid });
      const challenge = opts.body.data.challenge;
      const authData = makeAuthData(counter);
      const cd = clientDataB64u('webauthn.get', challenge);
      const sig = nodeCrypto.sign('sha256', assertionMessage(authData, cd), key.privateKey);
      const finish = await request(app).post('/api/auth/webauthn/login/finish')
        .send(await loginFinishBody(w.samUid, credId, challenge, {
          authData, clientData: cd, signatureB64u: b64u(sig),
        }));
      expect(finish.status).toBe(500);
      expect(finish.body).toEqual({});
    }
    expect((await sam.get('/api/auth/webauthn/credentials').set('X-CSRF-Token', samLogin.csrf))
      .body.data.credentials[0].sign_count).toBe(2);

    // RP ID hash mismatch: correctly signed, wrong relying party.
    {
      const opts = await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid });
      const challenge = opts.body.data.challenge;
      const authData = makeAuthData(3, 'evil.example');
      const cd = clientDataB64u('webauthn.get', challenge);
      const sig = nodeCrypto.sign('sha256', assertionMessage(authData, cd), key.privateKey);
      const finish = await request(app).post('/api/auth/webauthn/login/finish')
        .send(await loginFinishBody(w.samUid, credId, challenge, {
          authData, clientData: cd, signatureB64u: b64u(sig),
        }));
      expect(finish.status).toBe(401);
      expect(finish.body).toMatchObject({ code: 'WEBAUTHN_INVALID', message: 'Authenticator data RP ID hash mismatch' });
      const events = await w.owner.get('/api/auth/admin/events')
        .query({ action: 'auth.webauthn.rpid' }).set('X-CSRF-Token', w.ownerCsrf);
      expect(events.body.data.total).toBe(1);
    }

    // Too-short authenticator data (validly signed): rejected before parsing.
    {
      const opts = await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid });
      const challenge = opts.body.data.challenge;
      const authData = nodeCrypto.randomBytes(10);
      const cd = clientDataB64u('webauthn.get', challenge);
      const sig = nodeCrypto.sign('sha256', assertionMessage(authData, cd), key.privateKey);
      const finish = await request(app).post('/api/auth/webauthn/login/finish')
        .send(await loginFinishBody(w.samUid, credId, challenge, {
          authData, clientData: cd, signatureB64u: b64u(sig),
        }));
      expect(finish.status).toBe(400);
      expect(finish.body).toMatchObject({ code: 'WEBAUTHN_INVALID', message: 'Authenticator data too short' });
    }

    // Clone regression: counter 2 again (<= stored 2).
    {
      const opts = await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid });
      const challenge = opts.body.data.challenge;
      const authData = makeAuthData(2);
      const cd = clientDataB64u('webauthn.get', challenge);
      const sig = nodeCrypto.sign('sha256', assertionMessage(authData, cd), key.privateKey);
      const finish = await request(app).post('/api/auth/webauthn/login/finish')
        .send(await loginFinishBody(w.samUid, credId, challenge, {
          authData, clientData: cd, signatureB64u: b64u(sig),
        }));
      expect(finish.status).toBe(401);
      expect(finish.body).toMatchObject({ code: 'WEBAUTHN_CLONE', message: 'Authenticator signature counter regressed' });
      const events = await w.owner.get('/api/auth/admin/events')
        .query({ action: 'auth.webauthn.clone' }).set('X-CSRF-Token', w.ownerCsrf);
      expect(events.body.data.total).toBe(1);
      expect(events.body.data.events[0].severity).toBe('error');
    }
  });

  it('a corrupted stored public key degrades to WEBAUTHN_STORE / a broken JWK to WEBAUTHN_SIGNATURE', async () => {
    const w = await world();
    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });

    // Corrupt the STORE row directly (store corruption is a real operational
    // case the route defends against; only reachable by seeding).
    usersDb.addWebauthnCredential(w.samUid, 'corrupt-1', 'this-is-not-json', -7, null);
    const corruptOpts = await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid });
    const corruptChallenge = corruptOpts.body.data.challenge;
    const corruptFinish = await request(app).post('/api/auth/webauthn/login/finish')
      .send(await loginFinishBody(w.samUid, 'corrupt-1', corruptChallenge, {
        authData: makeAuthData(1), signatureB64u: b64u('q'.repeat(64)),
      }));
    expect(corruptFinish.status).toBe(500);
    expect(corruptFinish.body).toMatchObject({ code: 'WEBAUTHN_STORE', message: 'Stored credential is unreadable' });

    // Well-formed JSON that is not a usable JWK → signature verification fails.
    usersDb.addWebauthnCredential(w.samUid, 'badjwk-1', JSON.stringify({ kty: 'EC', crv: 'P-256', x: '!!!', y: '???' }), -7, null);
    const badOpts = await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid });
    const badChallenge = badOpts.body.data.challenge;
    const badFinish = await request(app).post('/api/auth/webauthn/login/finish')
      .send(await loginFinishBody(w.samUid, 'badjwk-1', badChallenge, {
        authData: makeAuthData(1), signatureB64u: b64u('w'.repeat(64)),
      }));
    expect(badFinish.status).toBe(401);
    expect(badFinish.body).toMatchObject({ code: 'WEBAUTHN_SIGNATURE', message: 'Signature verification failed' });
  });

  it('self-service credential list/remove and the admin variants', async () => {
    const w = await world();
    const key = p256();
    const credId = 'selfserve-1';
    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    expect((await enrollFor(sam, samLogin.csrf, { credId, cose: coseEc(key.jwk) })).finish.status).toBe(200);

    // Anonymous listing.
    expect((await request(app).get('/api/auth/webauthn/credentials')).status).toBe(401);

    // Removing a credential that is not this account's.
    const missing = await sam.delete('/api/auth/webauthn/credentials/other-cred')
      .set('X-CSRF-Token', samLogin.csrf);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND', message: 'No such credential for this account' });

    // Successful self-removal.
    const removed = await sam.delete(`/api/auth/webauthn/credentials/${credId}`)
      .set('X-CSRF-Token', samLogin.csrf);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ success: true, data: { removed: true } });
    expect((await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid })).body.code)
      .toBe('NO_CREDENTIAL');

    // Admin listing + removal.
    expect((await enrollFor(sam, samLogin.csrf, { credId: 'admin-rm-1', cose: coseEc(key.jwk) })).finish.status).toBe(200);
    const adminList = await w.owner.get(`/api/auth/admin/users/${w.samUid}/webauthn`)
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(adminList.body.data.credentials.map(c => c.cred_id)).toEqual(['admin-rm-1']);

    const unknownUser = await w.owner.get('/api/auth/admin/users/11111111-2222-3333-4444-555555555555/webauthn')
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(unknownUser.status).toBe(404);
    expect(unknownUser.body.code).toBe('NOT_FOUND');

    const adminRemoveMissing = await w.owner.delete(`/api/auth/admin/users/${w.samUid}/webauthn/nope`)
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(adminRemoveMissing.status).toBe(404);
    expect(adminRemoveMissing.body).toMatchObject({ code: 'NOT_FOUND', message: 'No such credential' });

    const adminRemoved = await w.owner.delete(`/api/auth/admin/users/${w.samUid}/webauthn/admin-rm-1`)
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(adminRemoved.status).toBe(200);
    expect((await w.owner.get(`/api/auth/admin/users/${w.samUid}/webauthn`).set('X-CSRF-Token', w.ownerCsrf))
      .body.data.credentials).toEqual([]);

    // Standard session cannot use the admin variant.
    const forbidden = await sam.get(`/api/auth/admin/users/${w.samUid}/webauthn`)
      .set('X-CSRF-Token', samLogin.csrf);
    expect(forbidden.status).toBe(403);
  });
});

// ─── 9. admin family: gates, CRUD, lifecycle guards ─────────────────────────

describe('auth-routes — admin family: role gates, account CRUD, lifecycle guards', () => {
  it('admin routes demand an admin-role session and audit the denial', async () => {
    const w = await world();

    const anon = await request(app).get('/api/auth/admin/users');
    expect(anon.status).toBe(401);
    expect(anon.body).toMatchObject({ code: 'AUTH_REQUIRED', message: 'Sign in with an administrator account' });

    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    const standard = await sam.get('/api/auth/admin/users').set('X-CSRF-Token', samLogin.csrf);
    expect(standard.status).toBe(403);
    expect(standard.body).toMatchObject({ code: 'ADMIN_REQUIRED', message: 'An administrator account is required' });

    // The denial is audited with the attempted path.
    const events = await w.owner.get('/api/auth/admin/events')
      .query({ action: 'admin.denied' }).set('X-CSRF-Token', w.ownerCsrf);
    expect(events.body.data.total).toBeGreaterThanOrEqual(1);
    expect(events.body.data.events[0].detail).toMatchObject({ path: '/api/auth/admin/users' });

    // A suspended admin-tier session is refused before the role check.
    const suspended = request.agent(app);
    const suspendedLogin = await loginOk(suspended, { username: 'ada', secret: '123456' });
    await suspended.post('/api/auth/suspend').set('X-CSRF-Token', suspendedLogin.csrf).send({});
    const suspendedAttempt = await suspended.get('/api/auth/admin/users');
    expect(suspendedAttempt.status).toBe(403);
    expect(suspendedAttempt.body.code).toBe('SESSION_SUSPENDED');

    // A locked one likewise.
    const locked = request.agent(app);
    const lockedLogin = await loginOk(locked, { username: 'ada', secret: '123456' });
    await locked.post('/api/auth/lock').set('X-CSRF-Token', lockedLogin.csrf).send({});
    const lockedAttempt = await locked.get('/api/auth/admin/users');
    expect(lockedAttempt.status).toBe(403);
    expect(lockedAttempt.body.code).toBe('SESSION_LOCKED');
  });

  it('POST /admin/users: validation, duplicate names (case-insensitive), and immediate login', async () => {
    const w = await world();

    const missing = await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ displayName: 'X' });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ success: false, code: 'INVALID_ARGS', message: 'username and pin are required' });

    const badRole = await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ username: 'newb', pin: '1234', role: 'owner' });
    expect(badRole.status).toBe(400);
    expect(badRole.body).toMatchObject({ success: false, code: 'INVALID_ROLE', message: "role must be 'admin' or 'standard'" });

    const badRole2 = await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ username: 'newb', pin: '1234', role: 'wizard' });
    expect(badRole2.status).toBe(400);
    expect(badRole2.body.code).toBe('INVALID_ROLE');

    // Duplicate, in a different case (COLLATE NOCASE).
    const dup = await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ username: 'SAM', pin: '1234', role: 'standard' });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ success: false, code: 'USERNAME_TAKEN', message: "Username 'sam' is already taken" });

    // Fresh user can sign in immediately.
    const created = await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ username: 'newbie', displayName: 'Newbie', pin: '1357', passphrase: 'newbie-pass-9', role: 'standard' });
    expect(created.status).toBe(200);
    expect(created.body.data.user).toMatchObject({ username: 'newbie', role: 'standard', status: 'active', hasPassphrase: true });
    const newbieLogin = await loginOk(request.agent(app), { username: 'newbie', secret: 'newbie-pass-9' });
    expect(newbieLogin.body.data.via).toBe('passphrase');
  });

  it('PATCH /admin/users/:uid — display fields, quota, role changes and every guard', async () => {
    const w = await world();

    const rename = await w.owner.patch(`/api/auth/admin/users/${w.samUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ displayName: 'Sam Renamed', avatar: 'https://example.invalid/sam.png' });
    expect(rename.status).toBe(200);
    expect(rename.body.data.user.displayName).toBe('Sam Renamed');
    expect((await request(app).get('/api/auth/users')).body.data.users
      .find(u => u.displayName === 'Sam Renamed')).toBeTruthy();

    const emptyName = await w.owner.patch(`/api/auth/admin/users/${w.samUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ displayName: '   ' });
    expect(emptyName.status).toBe(400);
    expect(emptyName.body.message).toBe('Display name cannot be empty');

    const badQuota = await w.owner.patch(`/api/auth/admin/users/${w.samUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ quotaBytes: 1024 });
    expect(badQuota.status).toBe(400);
    expect(badQuota.body.message).toBe('Invalid quota');

    const goodQuota = await w.owner.patch(`/api/auth/admin/users/${w.samUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ quotaBytes: 1024 * 1024 * 1024 });
    expect(goodQuota.status).toBe(200);
    expect(goodQuota.body.data.user.quotaBytes).toBe(1024 * 1024 * 1024);
    const usage = await request.agent(app);
    await loginOk(usage, { username: 'sam', secret: '4321' });
    expect((await usage.get('/api/auth/usage')).body.data.usage.quotaBytes).toBe(1024 * 1024 * 1024);

    // Promote and demote.
    const promote = await w.owner.patch(`/api/auth/admin/users/${w.samUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ role: 'admin' });
    expect(promote.status).toBe(200);
    expect(promote.body.data.user.role).toBe('admin');
    const demote = await w.owner.patch(`/api/auth/admin/users/${w.samUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ role: 'standard' });
    expect(demote.body.data.user.role).toBe('standard');

    // Permission escalation attempts are refused by the store guards.
    const assignOwner = await w.owner.patch(`/api/auth/admin/users/${w.samUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ role: 'owner' });
    expect(assignOwner.status).toBe(400);
    expect(assignOwner.body).toMatchObject({ code: 'ROLE_FORBIDDEN', message: 'The owner role cannot be assigned' });

    const changeOwnerRole = await w.owner.patch(`/api/auth/admin/users/${w.adaUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ role: 'standard' });
    expect(changeOwnerRole.status).toBe(403);
    expect(changeOwnerRole.body).toMatchObject({ code: 'OWNER_PROTECTED', message: 'The owner role cannot be changed' });

    // Empty patch is a no-op success.
    const noop = await w.owner.patch(`/api/auth/admin/users/${w.samUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({});
    expect(noop.status).toBe(200);
    expect(noop.body.data.user.username).toBe('sam');

    const unknown = await w.owner.patch('/api/auth/admin/users/11111111-2222-3333-4444-555555555555')
      .set('X-CSRF-Token', w.ownerCsrf).send({ displayName: 'X' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'NOT_FOUND', message: 'No such account' });
  });

  it('disable/enable: LAST_ADMIN guard, session revocation, login gating', async () => {
    const w = await world();
    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    seedSessionsDb(samLogin.sid);

    const unknown = await w.owner.post('/api/auth/admin/users/11111111-2222-3333-4444-555555555555/disable')
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('NOT_FOUND');

    const disable = await w.owner.post(`/api/auth/admin/users/${w.samUid}/disable`)
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(disable.status).toBe(200);
    expect(disable.body.data.user.status).toBe('disabled');
    // sessions revoked: the sid row dies in sessions.db, the map stops tracking it.
    expect(sessionsDbHas(samLogin.sid)).toBe(false);
    expect((await w.owner.get('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf))
      .body.data.users.find(u => u.username === 'sam').trackedSessions).toBe(0);

    // Login is refused while disabled (200 + code per the family contract).
    const gated = await request(app).post('/api/auth/login').send({ uid: w.samUid, secret: '4321' });
    expect(gated.status).toBe(200);
    expect(gated.body).toMatchObject({ success: false, code: 'ACCOUNT_DISABLED', message: 'This account is disabled' });

    // The LAST_ADMIN guard: disable the owner first (allowed, boss remains),
    // then the last active admin (boss) is refused.
    const disableOwner = await w.owner.post(`/api/auth/admin/users/${w.adaUid}/disable`)
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(disableOwner.status).toBe(200);
    const lastAdmin = await w.owner.post(`/api/auth/admin/users/${w.bossUid}/disable`)
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(lastAdmin.status).toBe(403);
    expect(lastAdmin.body).toMatchObject({ code: 'LAST_ADMIN', message: 'Cannot disable the last active administrator' });

    // Re-enable both, then sam; everything logs in again.
    await w.owner.post(`/api/auth/admin/users/${w.adaUid}/enable`).set('X-CSRF-Token', w.ownerCsrf);
    await w.owner.post(`/api/auth/admin/users/${w.bossUid}/enable`).set('X-CSRF-Token', w.ownerCsrf);
    const enable = await w.owner.post(`/api/auth/admin/users/${w.samUid}/enable`)
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(enable.status).toBe(200);
    expect(enable.body.data.user.status).toBe('active');
    expect((await loginOk(request.agent(app), { uid: w.samUid, secret: '4321' })).body.success).toBe(true);
  });

  it('admin lock/unlock gates logins until an administrator unlocks', async () => {
    const w = await world();
    const lock = await w.owner.post(`/api/auth/admin/users/${w.samUid}/lock`)
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(lock.status).toBe(200);
    expect(lock.body.data.user.locked).toBe(true);

    const gated = await request(app).post('/api/auth/login').send({ uid: w.samUid, secret: '4321' });
    expect(gated.body).toMatchObject({ code: 'ACCOUNT_LOCKED', message: 'Account locked — an administrator must unlock it' });
    expect((await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid })).status).toBe(423);

    const unlock = await w.owner.post(`/api/auth/admin/users/${w.samUid}/unlock`)
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(unlock.status).toBe(200);
    expect(unlock.body.data.user.locked).toBe(false);
    expect((await loginOk(request.agent(app), { uid: w.samUid, secret: '4321' })).body.success).toBe(true);

    const unknownLock = await w.owner.post('/api/auth/admin/users/11111111-2222-3333-4444-555555555555/lock')
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(unknownLock.status).toBe(404);
    const unknownUnlock = await w.owner.post('/api/auth/admin/users/11111111-2222-3333-4444-555555555555/unlock')
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(unknownUnlock.status).toBe(404);
  });

  it('force-logout revokes the account’s sessions from the session store', async () => {
    const w = await world();
    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    seedSessionsDb(samLogin.sid);

    const unknown = await w.owner.post('/api/auth/admin/users/11111111-2222-3333-4444-555555555555/force-logout')
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'NOT_FOUND', message: 'No such account' });

    const forced = await w.owner.post(`/api/auth/admin/users/${w.samUid}/force-logout`)
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(forced.status).toBe(200);
    expect(forced.body.data.revokedSessions).toBeGreaterThanOrEqual(1);
    expect(sessionsDbHas(samLogin.sid)).toBe(false);
    expect(usersDb.sessionsForUser(w.samUid)).toEqual([]);
    // audited as a warn-tier session.forceLogout event.
    const events = await w.owner.get('/api/auth/admin/events')
      .query({ action: 'session.forceLogout' }).set('X-CSRF-Token', w.ownerCsrf);
    expect(events.body.data.events[0].severity).toBe('warn');
  });

  it('DELETE /admin/users/:uid — guards, archive file work, wipe mode, query mode', async () => {
    const w = await world();

    const ownerDelete = await w.owner.delete(`/api/auth/admin/users/${w.adaUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ mode: 'wipe' });
    expect(ownerDelete.status).toBe(403);
    expect(ownerDelete.body).toMatchObject({ code: 'OWNER_PROTECTED', message: 'The owner account cannot be deleted' });

    const unknown = await w.owner.delete('/api/auth/admin/users/11111111-2222-3333-4444-555555555555')
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'NOT_FOUND', message: 'No such account' });

    // LAST_ADMIN: with the owner disabled, boss is the last active admin.
    await w.owner.post(`/api/auth/admin/users/${w.adaUid}/disable`).set('X-CSRF-Token', w.ownerCsrf);
    const lastAdmin = await w.owner.delete(`/api/auth/admin/users/${w.bossUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ mode: 'wipe' });
    expect(lastAdmin.status).toBe(403);
    expect(lastAdmin.body).toMatchObject({ code: 'LAST_ADMIN', message: 'Cannot delete the last active administrator' });
    await w.owner.post(`/api/auth/admin/users/${w.adaUid}/enable`).set('X-CSRF-Token', w.ownerCsrf);

    // ARCHIVE mode with real file work: current tree + a legacy root → the
    // account tree is copied into shared admin-backups and removed.
    mkdirSync(join(usersRoot(), 'sam', 'docs'), { recursive: true });
    writeFileSync(join(usersRoot(), 'sam', 'docs', 'a.txt'), 'A'.repeat(300));
    writeFileSync(join(usersRoot(), 'sam', 'top.txt'), 'B'.repeat(100));
    mkdirSync(join(legacyRoot(), 'sam'), { recursive: true });
    writeFileSync(join(legacyRoot(), 'sam', 'legacy.txt'), 'C'.repeat(50));

    const archive = await w.owner.delete(`/api/auth/admin/users/${w.samUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ mode: 'archive' });
    expect(archive.status).toBe(200);
    expect(archive.body.data).toMatchObject({ uid: w.samUid, username: 'sam', mode: 'archive' });
    // Two trees existed → archivedTo is the array form.
    const archivedTo = archive.body.data.archivedTo;
    expect(Array.isArray(archivedTo)).toBe(true);
    expect(archivedTo).toHaveLength(2);
    for (const target of archivedTo) {
      expect(target).toContain(join('shared', 'admin-backups'));
      expect(existsSync(target)).toBe(true);
    }
    expect(existsSync(join(archivedTo[0], 'docs', 'a.txt'))).toBe(true);
    expect(existsSync(join(archivedTo[0], 'top.txt'))).toBe(true);
    expect(existsSync(join(archivedTo[1], 'legacy.txt'))).toBe(true);
    // The live trees are gone.
    expect(existsSync(join(usersRoot(), 'sam'))).toBe(false);
    expect(existsSync(join(legacyRoot(), 'sam'))).toBe(false);
    // The row is gone from the picker and the admin list.
    expect((await request(app).get('/api/auth/users')).body.data.users.some(u => u.displayName === 'Sam Smith'))
      .toBe(false);

    // Single-tree archive → string form.
    await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ username: 'pat', displayName: 'Pat', pin: '7777', role: 'standard' });
    const patUid = usersDb.getUserByUsername('pat').uid;
    mkdirSync(join(usersRoot(), 'pat'), { recursive: true });
    writeFileSync(join(usersRoot(), 'pat', 'only.txt'), 'D'.repeat(20));
    const single = await w.owner.delete(`/api/auth/admin/users/${patUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ mode: 'archive' });
    expect(single.status).toBe(200);
    expect(typeof single.body.data.archivedTo).toBe('string');
    expect(existsSync(join(single.body.data.archivedTo, 'only.txt'))).toBe(true);

    // WIPE mode via the body, and via the query string.
    await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ username: 'mel', displayName: 'Mel', pin: '6666', role: 'standard' });
    const melUid = usersDb.getUserByUsername('mel').uid;
    mkdirSync(join(usersRoot(), 'mel'), { recursive: true });
    writeFileSync(join(usersRoot(), 'mel', 'gone.txt'), 'E'.repeat(10));
    const wiped = await w.owner.delete(`/api/auth/admin/users/${melUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ mode: 'wipe' });
    expect(wiped.status).toBe(200);
    expect(wiped.body.data).toMatchObject({ mode: 'wipe' });
    expect(wiped.body.data.archivedTo).toBeUndefined();
    expect(existsSync(join(usersRoot(), 'mel'))).toBe(false);

    await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ username: 'nil', displayName: 'Nil', pin: '5555', role: 'standard' });
    const nilUid = usersDb.getUserByUsername('nil').uid;
    mkdirSync(join(usersRoot(), 'nil'), { recursive: true });
    writeFileSync(join(usersRoot(), 'nil', 'q.txt'), 'F'.repeat(5));
    const queryWipe = await w.owner.delete(`/api/auth/admin/users/${nilUid}?mode=wipe`)
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(queryWipe.status).toBe(200);
    expect(queryWipe.body.data.mode).toBe('wipe');
    expect(existsSync(join(usersRoot(), 'nil'))).toBe(false);
  });

  it('deleting an account also drops its session-map rows (tracked sessions do not linger)', async () => {
    const w = await world();
    const sam = request.agent(app);
    await loginOk(sam, { username: 'sam', secret: '4321' });
    expect(usersDb.sessionsForUser(w.samUid)).toHaveLength(1);

    const removed = await w.owner.delete(`/api/auth/admin/users/${w.samUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ mode: 'wipe' });
    expect(removed.status).toBe(200);
    expect(usersDb.sessionsForUser(w.samUid)).toEqual([]);
    const list = await w.owner.get('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf);
    expect(list.body.data.users.map(u => u.username)).toEqual(['ada', 'boss']);
  });

  it('admin policy routes: read, write, validation', async () => {
    const w = await world();

    const before = await w.owner.get('/api/auth/admin/policies').set('X-CSRF-Token', w.ownerCsrf);
    expect(before.status).toBe(200);
    expect(before.body.data.policies).toMatchObject({ guestAccess: false, showUsernamesOnPicker: false });

    const write = await w.owner.put('/api/auth/admin/policies').set('X-CSRF-Token', w.ownerCsrf)
      .send({ guestAccess: true, closeAppsOnSwitch: false });
    expect(write.status).toBe(200);
    expect(write.body.data.policies).toMatchObject({ guestAccess: true, closeAppsOnSwitch: false });
    // the public surface mirrors it.
    expect((await request(app).get('/api/auth/policies')).body.data.guestAccess).toBe(true);

    const invalid = await w.owner.put('/api/auth/admin/policies').set('X-CSRF-Token', w.ownerCsrf)
      .send({ nonsense: 1 });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      success: false, code: 'INVALID_POLICY', message: "Unknown account policy 'nonsense'",
    });

    // Gate: anonymous (with a valid CSRF token, so the route's own gate decides)
    // and standard sessions.
    const anonHost = await anonSession(app);
    expect((await anonHost.agent.put('/api/auth/admin/policies')
      .set('X-CSRF-Token', anonHost.csrf).send({ guestAccess: true })).status).toBe(401);
    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    expect((await sam.put('/api/auth/admin/policies').set('X-CSRF-Token', samLogin.csrf)
      .send({ guestAccess: true })).status).toBe(403);
  });

  it('/admin/wipe is owner-only: anonymous, admin and standard are all refused', async () => {
    const w = await world();

    // Every POST here needs BOTH a CSRF token (to pass the chain) and a JSON
    // body (a bodyless POST crashes the CSRF chain — see the dedicated test
    // above), so the route's own requireOwnerRole gate is what answers.
    const anonHost = await anonSession(app);
    const anon = await anonHost.agent.post('/api/auth/admin/wipe')
      .set('X-CSRF-Token', anonHost.csrf).send({});
    expect(anon.status).toBe(403);
    expect(anon.body).toMatchObject({ success: false, code: 'OWNER_REQUIRED', message: 'The owner account is required' });

    const boss = request.agent(app);
    const bossLogin = await loginOk(boss, { username: 'boss', secret: '111111' });
    const asAdmin = await boss.post('/api/auth/admin/wipe')
      .set('X-CSRF-Token', bossLogin.csrf).send({});
    expect(asAdmin.status).toBe(403);
    expect(asAdmin.body.code).toBe('OWNER_REQUIRED');

    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    const asStandard = await sam.post('/api/auth/admin/wipe')
      .set('X-CSRF-Token', samLogin.csrf).send({});
    expect(asStandard.status).toBe(403);
    expect(asStandard.body.code).toBe('OWNER_REQUIRED');

    // No route exists at /api/auth/wipe (the verb is /admin/wipe): a properly
    // tokenised POST there falls through to express's default 404.
    const ghost = await anonHost.agent.post('/api/auth/wipe')
      .set('X-CSRF-Token', anonHost.csrf).send({});
    expect(ghost.status).toBe(404);

    const asOwner = await w.owner.post('/api/auth/admin/wipe')
      .set('X-CSRF-Token', w.ownerCsrf).send({});
    expect(asOwner.status).toBe(200);
    expect((await request(app).get('/api/auth/users')).body.data.users).toEqual([]);
  });
});

// ─── 10. audit events ───────────────────────────────────────────────────────

describe('auth-routes — audit events feed and CSV export', () => {
  it('records the whole lifecycle and serves filtered feeds with pagination', async () => {
    const w = await world();
    // Drive a compact lifecycle: failed login, success, lock, resume, logout.
    await request(app).post('/api/auth/login').send({ uid: w.samUid, secret: '0000' });
    const agent = request.agent(app);
    const login = await loginOk(agent, { username: 'sam', secret: '4321' });
    await agent.post('/api/auth/lock').set('X-CSRF-Token', login.csrf).send({});
    await agent.post('/api/auth/reverify').send({ secret: '4321' });
    await agent.post('/api/auth/logout').set('X-CSRF-Token', login.csrf).send({});

    const all = await w.owner.get('/api/auth/admin/events')
      .query({ limit: 100 }).set('X-CSRF-Token', w.ownerCsrf);
    expect(all.status).toBe(200);
    const actions = all.body.data.events.map(e => e.action);
    for (const expected of ['auth.failure', 'auth.success', 'session.lock', 'session.resume', 'auth.logout']) {
      expect(actions).toContain(expected);
    }
    expect(all.body.data.total).toBeGreaterThanOrEqual(all.body.data.events.length);

    // Filters.
    const warnOnly = await w.owner.get('/api/auth/admin/events')
      .query({ severity: 'warn' }).set('X-CSRF-Token', w.ownerCsrf);
    expect(warnOnly.body.data.events.every(e => e.severity === 'warn')).toBe(true);

    const byAction = await w.owner.get('/api/auth/admin/events')
      .query({ action: 'session.lock', uid: w.samUid }).set('X-CSRF-Token', w.ownerCsrf);
    expect(byAction.body.data.events.every(e => e.action === 'session.lock' && e.actorUid === w.samUid)).toBe(true);

    // Pagination.
    const page = await w.owner.get('/api/auth/admin/events')
      .query({ limit: 2, offset: 2 }).set('X-CSRF-Token', w.ownerCsrf);
    expect(page.body.data.limit).toBe(2);
    expect(page.body.data.offset).toBe(2);
    expect(page.body.data.events).toHaveLength(2);
    expect(page.body.data.events[0].seq).toBeGreaterThan(page.body.data.events[1].seq);

    // Gate.
    const sam = request.agent(app);
    await loginOk(sam, { username: 'sam', secret: '4321' });
    expect((await sam.get('/api/auth/admin/events')).status).toBe(403);
  });

  it('exports the audit trail as CSV with the right headers', async () => {
    const w = await world();
    await request(app).post('/api/auth/login').send({ uid: w.samUid, secret: '0000' });

    const csv = await w.owner.get('/api/auth/admin/events/export').set('X-CSRF-Token', w.ownerCsrf);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('attachment; filename="novabyte-account-events.csv"');
    expect(csv.text.split('\n')[0]).toBe('ts,actor,action,target,severity,detail,ip');
    expect(csv.text).toContain('auth.failure');

    const filtered = await w.owner.get('/api/auth/admin/events/export')
      .query({ action: 'auth.failure' }).set('X-CSRF-Token', w.ownerCsrf);
    expect(filtered.text).toContain('auth.failure');
    expect(filtered.text).not.toContain('account.create');

    expect((await request(app).get('/api/auth/admin/events/export')).status).toBe(401);
  });
});

// ─── 11. session-store semantics and multi-session switching ────────────────

describe('auth-routes — session-store semantics and multi-session switching', () => {
  it('a cookie whose store row is gone (restart/expiry) degrades to anonymous; the map row survives', async () => {
    const w = await world();
    const agent = request.agent(app);
    const login = await loginOk(agent, { username: 'sam', secret: '4321' });

    // Simulate the store losing the row (MemoryStore restart, or the row
    // aging out): the cookie now points at a sid nobody holds.
    sessionStore.clear();
    const after = await agent.get('/api/auth/session');
    expect(after.status).toBe(200);
    expect(after.body.data.authenticated).toBe(false);
    // …and the authenticated surfaces refuse it.
    expect((await agent.get('/api/auth/usage')).status).toBe(401);
    expect((await agent.get('/api/auth/usage')).body.code).toBe('AUTH_REQUIRED');
    // The users.db session map still carries the sid: it tracks logins, not
    // session liveness — only logout/revocation removes map rows.
    expect(usersDb.sessionsForUser(w.samUid)).toContain(login.sid);
  });

  it('X-Nova-Session overrides the cookie slot: a bearer for another live session wins over the caller’s own cookie', async () => {
    const w = await world();
    const sam = request.agent(app);
    await loginOk(sam, { username: 'sam', secret: '4321' });
    const boss = request.agent(app);
    const bossLogin = await loginOk(boss, { username: 'boss', secret: '111111' });

    // sam's cookie jar + a bearer pointing at boss's session: the bearer is
    // resolved before express-session runs, so the request acts as boss.
    const asBoss = await sam.get('/api/auth/session').set('X-Nova-Session', bossLogin.sid);
    expect(asBoss.body.data).toMatchObject({ authenticated: true, sessionId: bossLogin.sid });
    expect(asBoss.body.data.user.username).toBe('boss');

    // The bearer request also REPOINTS the caller's single cookie slot (the
    // response hands back a Set-Cookie for the bearer's sid), so subsequent
    // cookie-only requests continue as boss — this is the host SessionManager
    // design: "the browser's single cookie slot keeps pointing at" the
    // bearer-targeted session (server/middleware.js).
    expect(asBoss.headers['set-cookie']?.join(' ')).toMatch(/connect\.sid=s%3A/);
    const still = await sam.get('/api/auth/session');
    expect(still.body.data.user.username).toBe('boss');

    // A bearer for a session that no longer exists MASKS any cookie: the
    // rewritten cookie slot points at a dead sid, so the caller is anonymous.
    await request(app).post('/api/auth/logout')
      .set('X-Nova-Session', bossLogin.sid).set('X-CSRF-Token', bossLogin.csrf).send({});
    const masked = await sam.get('/api/auth/session').set('X-Nova-Session', bossLogin.sid);
    expect(masked.body.data.authenticated).toBe(false);
  });

  it('full user-switching flow: suspend the departing session, sign the next user in, resume the first by bearer', async () => {
    const w = await world();
    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });

    // The departing session suspends itself…
    const suspend = await sam.post('/api/auth/suspend').set('X-CSRF-Token', samLogin.csrf).send({});
    expect(suspend.status).toBe(200);

    // …the page session (fresh, anonymous) signs boss in — regeneration issues
    // a NEW sid, so both sessions stay live simultaneously.
    const boss = request.agent(app);
    const bossLogin = await loginOk(boss, { username: 'boss', secret: '111111' });
    expect(bossLogin.sid).not.toBe(samLogin.sid);

    // The suspended session stays reachable through its bearer: suspended,
    // refused by the guarded surfaces, and resumable by reverify.
    const intro = await request(app).get('/api/auth/session').set('X-Nova-Session', samLogin.sid);
    expect(intro.body.data).toMatchObject({ authenticated: true, suspended: true });
    expect(intro.body.data.user.username).toBe('sam');
    const guarded = await request(app).get('/api/auth/usage').set('X-Nova-Session', samLogin.sid);
    expect(guarded.status).toBe(403);
    expect(guarded.body.code).toBe('SESSION_SUSPENDED');

    const resume = await request(app).post('/api/auth/reverify')
      .set('X-Nova-Session', samLogin.sid).send({ secret: '4321' });
    expect(resume.status).toBe(200);
    expect(resume.body.data.user.username).toBe('sam');
    const resumed = await request(app).get('/api/auth/session').set('X-Nova-Session', samLogin.sid);
    expect(resumed.body.data.suspended).toBe(false);

    // Boss's session is untouched by the resume.
    expect((await boss.get('/api/auth/session')).body.data.user.username).toBe('boss');
  });

  it('anonymous logout: 200, cookie cleared, no auth.logout event audited', async () => {
    const w = await world();
    const host = await anonSession(app);
    const before = await w.owner.get('/api/auth/admin/events')
      .query({ action: 'auth.logout' }).set('X-CSRF-Token', w.ownerCsrf);

    const out = await host.agent.post('/api/auth/logout')
      .set('X-CSRF-Token', host.csrf).send({});
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ success: true, data: { signedOut: true } });
    expect(out.headers['set-cookie']?.[0]).toContain('connect.sid=;');
    // Still anonymous afterwards.
    expect((await host.agent.get('/api/auth/session')).body.data.authenticated).toBe(false);

    const after = await w.owner.get('/api/auth/admin/events')
      .query({ action: 'auth.logout' }).set('X-CSRF-Token', w.ownerCsrf);
    expect(after.body.data.total).toBe(before.body.data.total);
  });

  it('a bodyless POST /reverify is CSRF-exempt and fails cleanly with 400 (no 500 crash)', async () => {
    const w = await world();
    const agent = request.agent(app);
    const login = await loginOk(agent, { username: 'sam', secret: '4321' });

    // No .send() at all: req.body is undefined. On the exempt identity verbs
    // the CSRF chain is skipped entirely, so the route's own `req.body || {}`
    // guard answers 400 — contrast the bodyless-POST crash on non-exempt verbs.
    const noBody = await agent.post('/api/auth/reverify');
    expect(noBody.status).toBe(400);
    expect(noBody.body).toMatchObject({ success: false, code: 'INVALID_ARGS', message: 'secret is required' });
    // The session survives and can still be unlocked properly.
    const ok = await agent.post('/api/auth/reverify').send({ secret: '4321' });
    expect(ok.body.success).toBe(true);
    expect((await agent.get('/api/auth/session')).body.data.user.username).toBe('sam');
  });

  it('a CSRF token borrowed from a different session is rejected (tokens are per-session)', async () => {
    const w = await world();
    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    const boss = request.agent(app);
    const bossLogin = await loginOk(boss, { username: 'boss', secret: '111111' });

    // sam presents boss's validly-shaped token on sam's own session.
    const cross = await sam.post('/api/auth/lock')
      .set('X-CSRF-Token', bossLogin.csrf).send({});
    expect(cross.status).toBe(403);
    expect(cross.body.code).toBe('CSRF_INVALID');
    // …and the lock did not happen.
    expect((await sam.get('/api/auth/session')).body.data.locked).toBe(false);
    // sam's own token still works afterwards.
    expect((await sam.post('/api/auth/lock').set('X-CSRF-Token', samLogin.csrf).send({})).status).toBe(200);
  });
});

// ─── 11b. session-store failure semantics ───────────────────────────────────

describe('auth-routes — session-store failure semantics (store fault injection)', () => {
  it('a store that cannot destroy the old session turns /setup and /login into 500 SESSION_ERROR — without rolling back the created account', async () => {
    const flaky = flakySessionStore();
    const flakyApp = buildApp(flaky.proxy);
    const agent = request.agent(flakyApp);

    flaky.fail();
    // First boot against a failing store: the owner row is created, then
    // establishSession's regenerate() cannot destroy the anonymous session →
    // the route answers 500 SESSION_ERROR. The account creation is NOT
    // rolled back — the machine now has an owner it cannot log in as.
    const setup = await agent.post('/api/auth/setup')
      .send({ displayName: 'Ada', username: 'ada', pin: '123456' });
    expect(setup.status).toBe(500);
    expect(setup.body).toEqual({
      success: false, code: 'SESSION_ERROR', message: 'Could not establish session',
    });
    expect(usersDb.hasAccounts()).toBe(true);
    expect(usersDb.getUserByUsername('ada').role).toBe('owner');

    // Retry once the store has healed: /setup is now refused with 409 (the
    // account from the failed attempt persists)…
    flaky.heal();
    const retry = await agent.post('/api/auth/setup')
      .send({ displayName: 'Again', username: 'again', pin: '1234' });
    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe('ALREADY_SET_UP');

    // …but a plain login establishes a session normally on the healed store.
    const good = await agent.post('/api/auth/login').send({ username: 'ada', secret: '123456' });
    expect(good.status).toBe(200);
    expect(good.body.success).toBe(true);
    expect(good.body.data.user.username).toBe('ada');

    // The same fault against an EXISTING account turns /login into the
    // identical 500 SESSION_ERROR outcome (credential verification is not
    // the problem — the session machinery is).
    flaky.fail();
    const second = request.agent(flakyApp);
    const bad = await second.post('/api/auth/login').send({ username: 'ada', secret: '123456' });
    expect(bad.status).toBe(500);
    expect(bad.body).toEqual({
      success: false, code: 'SESSION_ERROR', message: 'Could not establish session',
    });
    // No failure was recorded against the account (the secret verified fine).
    expect(usersDb.isTemporarilyLocked(usersDb.getUserByUsername('ada').uid)).toBe(false);
  });
});

// ─── 12. reverify against changed account state ──────────────────────────────

describe('auth-routes — reverify against changed account state', () => {
  it('reverify after the account was deleted: 200 + UNKNOWN_ACCOUNT, the session stays locked', async () => {
    const w = await world();
    const agent = request.agent(app);
    const login = await loginOk(agent, { username: 'sam', secret: '4321' });
    await agent.post('/api/auth/lock').set('X-CSRF-Token', login.csrf).send({});

    await w.owner.delete(`/api/auth/admin/users/${w.samUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ mode: 'wipe' });

    const verify = await agent.post('/api/auth/reverify').send({ secret: '4321' });
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ success: false, code: 'UNKNOWN_ACCOUNT', message: 'Unknown account' });
    // The session is still locked — unlocking only happens on success.
    expect((await agent.get('/api/auth/session')).body.data.locked).toBe(true);
  });

  it('reverify while the account is disabled: 200 + ACCOUNT_DISABLED, audited as auth.denied', async () => {
    const w = await world();
    const agent = request.agent(app);
    const login = await loginOk(agent, { username: 'sam', secret: '4321' });
    await agent.post('/api/auth/lock').set('X-CSRF-Token', login.csrf).send({});

    await w.owner.post(`/api/auth/admin/users/${w.samUid}/disable`).set('X-CSRF-Token', w.ownerCsrf);
    const verify = await agent.post('/api/auth/reverify').send({ secret: '4321' });
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ success: false, code: 'ACCOUNT_DISABLED', message: 'This account is disabled' });

    const events = await w.owner.get('/api/auth/admin/events')
      .query({ action: 'auth.denied' }).set('X-CSRF-Token', w.ownerCsrf);
    expect(events.body.data.events.some(e => e.detail?.reason === 'disabled')).toBe(true);
    // The session is still locked.
    expect((await agent.get('/api/auth/session')).body.data.locked).toBe(true);
  });

  it('wrong secrets at reverify feed the same lockout ladder as /login', async () => {
    const w = await world();
    const agent = request.agent(app);
    await loginOk(agent, { username: 'sam', secret: '4321' });

    const first = await agent.post('/api/auth/reverify').send({ secret: '0000' });
    expect(first.body).toMatchObject({ success: false, code: 'BAD_CREDENTIAL' });
    const second = await agent.post('/api/auth/reverify').send({ secret: '0000' });
    expect(second.body.code).toBe('BAD_CREDENTIAL');
    const third = await agent.post('/api/auth/reverify').send({ secret: '0000' });
    expect(third.status).toBe(200);
    expect(third.body.code).toBe('LOCKOUT');
    expect(third.body.retryAfterMs).toBeGreaterThan(0);

    // The CORRECT secret is refused during the window — via reverify AND login.
    const correct = await agent.post('/api/auth/reverify').send({ secret: '4321' });
    expect(correct.body.code).toBe('LOCKOUT');
    const loginAttempt = await request(app).post('/api/auth/login').send({ uid: w.samUid, secret: '4321' });
    expect(loginAttempt.body.code).toBe('LOCKOUT');

    // Admin unlock clears it and the session unlocks normally.
    await w.owner.post(`/api/auth/admin/users/${w.samUid}/unlock`).set('X-CSRF-Token', w.ownerCsrf);
    const ok = await agent.post('/api/auth/reverify').send({ secret: '4321' });
    expect(ok.body.success).toBe(true);
  });
});

// ─── 13. credential-change corner cases ─────────────────────────────────────

describe('auth-routes — credential-change corner cases', () => {
  it('forced new-PIN sheet: an invalid new pin keeps the forced state; logins land on the sheet until changed', async () => {
    const w = await world();
    const reset = usersDb.resetCredential(w.samUid, w.adaUid);
    const tempPin = reset.temporaryPin;

    const forced = request.agent(app);
    const forcedLogin = await loginOk(forced, { uid: w.samUid, secret: tempPin });
    expect(forcedLogin.body.data.mustChangePin).toBe(true);

    // Invalid new pin on the forced sheet → 400, and the session stays forced.
    const bad = await forced.post('/api/auth/change-pin')
      .set('X-CSRF-Token', forcedLogin.csrf).send({ newPin: '12' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ success: false, code: 'INVALID_PIN', message: 'PIN must be 4 to 6 digits' });

    // A valid change clears it…
    const good = await forced.post('/api/auth/change-pin')
      .set('X-CSRF-Token', forcedLogin.csrf).send({ newPin: '8888' });
    expect(good.status).toBe(200);
    // …and the next login does NOT land on the forced sheet.
    const other = await loginOk(request.agent(app), { uid: w.samUid, secret: '8888' });
    expect(other.body.data.mustChangePin).toBe(false);
  });

  it('numeric passphrase values are coerced to strings on both the self and the admin surface', async () => {
    const w = await world();
    const agent = request.agent(app);
    const login = await loginOk(agent, { username: 'sam', secret: '4321' });

    // change-passphrase with a NUMBER: the route's String() coercion stores
    // it as text; a 10-digit secret is outside the PIN shape, so auto-login
    // falls to the passphrase branch.
    const change = await agent.post('/api/auth/change-passphrase')
      .set('X-CSRF-Token', login.csrf).send({ currentSecret: '4321', passphrase: 1357902468 });
    expect(change.status).toBe(200);
    const viaPhrase = await loginOk(request.agent(app), { uid: w.samUid, secret: '1357902468' });
    expect(viaPhrase.body.data.via).toBe('passphrase');

    // The same coercion on the admin credential route.
    const adminSet = await w.owner.post(`/api/auth/admin/users/${w.samUid}/credentials/passphrase`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ passphrase: 864213579 });
    expect(adminSet.status).toBe(200);
    expect((await loginOk(request.agent(app), { uid: w.samUid, secret: '864213579' })).body.data.via)
      .toBe('passphrase');
  });

  it('admin credentials/pin with a missing pin coerces to the empty string and fails validation', async () => {
    const w = await world();
    // No pin key at all: String(pin ?? '') → '' → assertPin refuses.
    const noPin = await w.owner.post(`/api/auth/admin/users/${w.adaUid}/credentials/pin`)
      .set('X-CSRF-Token', w.ownerCsrf).send({});
    expect(noPin.status).toBe(400);
    expect(noPin.body).toMatchObject({ success: false, code: 'INVALID_PIN', message: 'PIN must be 4 to 6 digits' });
  });
});

// ─── 14. admin CRUD depth ───────────────────────────────────────────────────

describe('auth-routes — admin CRUD depth: validation, quota, avatar, pagination', () => {
  it('POST /admin/users surfaces the store validation messages and honours quotaBytes', async () => {
    const w = await world();

    const tooSmallDefault = await w.owner.put('/api/auth/admin/policies')
      .set('X-CSRF-Token', w.ownerCsrf).send({ defaultUserQuotaBytes: 107 });
    expect(tooSmallDefault.status).toBe(400);
    expect(tooSmallDefault.body).toMatchObject({ success: false, code: 'INVALID_POLICY' });

    const shortName = await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ username: 'ab', pin: '1234', role: 'standard' });
    expect(shortName.status).toBe(400);
    expect(shortName.body.message).toBe('Username must be 3–32 chars: letters, digits, dot, dash, underscore');

    const badPin = await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ username: 'quota-user', pin: '12', role: 'standard' });
    expect(badPin.status).toBe(400);
    expect(badPin.body.message).toBe('PIN must be 4 to 6 digits');

    const badPinType = await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ username: 'quota-user', pin: 1234, role: 'standard' });
    expect(badPinType.status).toBe(400);
    expect(badPinType.body).toMatchObject({ code: 'INVALID_ARGS', message: 'username and pin are required' });

    const shortPass = await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ username: 'quota-user', pin: '1234', role: 'standard', passphrase: 'tiny' });
    expect(shortPass.status).toBe(400);
    expect(shortPass.body.message).toBe('Passphrase must be at least 8 characters');

    const tooSmall = await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ username: 'quota-user', pin: '2468', role: 'standard', quotaBytes: 107 });
    expect(tooSmall.status).toBe(400);
    expect(tooSmall.body.message).toBe('Invalid quota');

    // Creation with an explicit quota.
    const created = await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ username: 'quota-user', displayName: 'Quota User', pin: '2468', role: 'standard', quotaBytes: 1024 * 1024 * 1024 });
    expect(created.status).toBe(200);
    expect(created.body.data.user).toMatchObject({ username: 'quota-user', quotaBytes: 1024 * 1024 * 1024 });

    // The self usage surface reports it.
    const agent = request.agent(app);
    await loginOk(agent, { username: 'quota-user', secret: '2468' });
    const usage = await agent.get('/api/auth/usage');
    expect(usage.body.data.usage.quotaBytes).toBe(1024 * 1024 * 1024);
  });

  it('PATCH /admin/users: avatar set/clear, unknown role, same-role no-op', async () => {
    const w = await world();

    const setAvatar = await w.owner.patch(`/api/auth/admin/users/${w.samUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ avatar: 'https://cdn.example/sam.png' });
    expect(setAvatar.status).toBe(200);
    expect(setAvatar.body.data.user.avatar).toBe('https://cdn.example/sam.png');
    // …and the picker tile carries it.
    expect((await request(app).get('/api/auth/users')).body.data.users
      .find(u => u.displayName === 'Sam Smith').avatar).toBe('https://cdn.example/sam.png');

    const clearAvatar = await w.owner.patch(`/api/auth/admin/users/${w.samUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ avatar: null });
    expect(clearAvatar.status).toBe(200);
    expect(clearAvatar.body.data.user.avatar).toBeNull();

    const unknownRole = await w.owner.patch(`/api/auth/admin/users/${w.samUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ role: 'wizard' });
    expect(unknownRole.status).toBe(400);
    expect(unknownRole.body.message).toBe('Unknown role');

    // Re-asserting the CURRENT role is a no-op success (updateUser only acts
    // when the role actually changes).
    const sameRole = await w.owner.patch(`/api/auth/admin/users/${w.samUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ role: 'standard' });
    expect(sameRole.status).toBe(200);
    expect(sameRole.body.data.user.role).toBe('standard');
  });

  it('enable with an unknown uid hits the route’s catch arm (404); force-logout with no live sessions revokes zero', async () => {
    const w = await world();

    const unknownEnable = await w.owner.post('/api/auth/admin/users/11111111-2222-3333-4444-555555555555/enable')
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(unknownEnable.status).toBe(404);
    expect(unknownEnable.body).toMatchObject({ success: false, code: 'NOT_FOUND', message: 'No such account' });

    // force-logout for an account that has no live sessions anywhere.
    const fresh = await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ username: 'loner', displayName: 'Loner', pin: '3456', role: 'standard' });
    const lonerUid = fresh.body.data.user.uid;
    const forced = await w.owner.post(`/api/auth/admin/users/${lonerUid}/force-logout`)
      .set('X-CSRF-Token', w.ownerCsrf);
    expect(forced.status).toBe(200);
    expect(forced.body.data.revokedSessions).toBe(0);
  });

  it('admin events feed: limit/offset coercion (non-numeric, negative, oversized) and a severity-filtered CSV', async () => {
    const w = await world();
    // A warn-tier event so the filtered export is non-empty.
    await request(app).post('/api/auth/login').send({ uid: w.samUid, secret: '0000' });

    const nan = await w.owner.get('/api/auth/admin/events')
      .query({ limit: 'abc' }).set('X-CSRF-Token', w.ownerCsrf);
    expect(nan.status).toBe(200);
    expect(nan.body.data.limit).toBe(100);

    const oversized = await w.owner.get('/api/auth/admin/events')
      .query({ limit: '5000', offset: '-5' }).set('X-CSRF-Token', w.ownerCsrf);
    expect(oversized.body.data.limit).toBe(1000); // capped at the store maximum
    expect(oversized.body.data.offset).toBe(0);   // negatives clamp to zero

    const csv = await w.owner.get('/api/auth/admin/events/export')
      .query({ severity: 'warn' }).set('X-CSRF-Token', w.ownerCsrf);
    expect(csv.status).toBe(200);
    const rows = csv.text.split('\n').slice(1).filter(Boolean);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.includes(',warn,'))).toBe(true);
  });
});

// ─── 15. deletion modes and storage-root edges ──────────────────────────────

describe('auth-routes — deletion modes and storage-root edges', () => {
  it('archive mode with NO on-disk trees: success without archivedTo and without archiveError', async () => {
    const w = await world();
    // sam has no ~/users/sam and no legacy roots at all.
    const archive = await w.owner.delete(`/api/auth/admin/users/${w.samUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ mode: 'archive' });
    expect(archive.status).toBe(200);
    expect(archive.body.data).toMatchObject({ uid: w.samUid, username: 'sam', mode: 'archive' });
    expect(archive.body.data).not.toHaveProperty('archivedTo');
    expect(archive.body.data).not.toHaveProperty('archiveError');
  });

  it('only an explicit wipe (body OR query) wipes: a body "archive" cannot override a query "wipe"', async () => {
    const w = await world();
    await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ username: 'mode-user', displayName: 'Mode User', pin: '4567', role: 'standard' });
    const modeUid = usersDb.getUserByUsername('mode-user').uid;
    mkdirSync(join(usersRoot(), 'mode-user'), { recursive: true });
    writeFileSync(join(usersRoot(), 'mode-user', 'keep.txt'), 'K'.repeat(30));

    // Body says archive, query says wipe. The route's ternary only treats the
    // BODY as authoritative when it literally says 'wipe' — anything else
    // falls through to the query, so the query wipe WINS. CURRENT behavior.
    const wiped = await w.owner.delete(`/api/auth/admin/users/${modeUid}?mode=wipe`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ mode: 'archive' });
    expect(wiped.status).toBe(200);
    expect(wiped.body.data.mode).toBe('wipe');
    expect(wiped.body.data).not.toHaveProperty('archivedTo');
    expect(existsSync(join(usersRoot(), 'mode-user'))).toBe(false);
    expect(existsSync(join(homeDir, '.local', 'share', 'novabyte', 'shared'))).toBe(false);

    // No mode anywhere → the archive default (already covered by the archive
    // file-work test); an explicit body wipe without a query also wipes
    // (covered there too). Here: a non-wipe query value must NOT wipe.
    await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ username: 'mode-user2', displayName: 'Mode Two', pin: '4567', role: 'standard' });
    const mode2Uid = usersDb.getUserByUsername('mode-user2').uid;
    mkdirSync(join(usersRoot(), 'mode-user2'), { recursive: true });
    writeFileSync(join(usersRoot(), 'mode-user2', 'keep2.txt'), 'L'.repeat(20));
    const archived = await w.owner.delete(`/api/auth/admin/users/${mode2Uid}?mode=archive`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ mode: 'archive' });
    expect(archived.status).toBe(200);
    expect(archived.body.data.mode).toBe('archive');
    expect(typeof archived.body.data.archivedTo).toBe('string');
    expect(existsSync(join(archived.body.data.archivedTo, 'keep2.txt'))).toBe(true);
  });

  it('archive failure (backup target occupied by a file) reports archiveError and keeps the source tree', async () => {
    const w = await world();
    await w.owner.post('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf)
      .send({ username: 'victim', displayName: 'Victim', pin: '4567', role: 'standard' });
    const victimUid = usersDb.getUserByUsername('victim').uid;

    // A real tree for victim.
    mkdirSync(join(usersRoot(), 'victim'), { recursive: true });
    writeFileSync(join(usersRoot(), 'victim', 'precious.txt'), 'P'.repeat(40));

    // Pre-create the EXACT backup target path as a FILE, so the recursive
    // copy of a directory onto it cannot proceed.
    const stamp = new Date().toISOString().slice(0, 10);
    const baseName = `victim-${stamp}-${victimUid.slice(0, 8)}`;
    const backupDir = join(homeDir, '.local', 'share', 'novabyte', 'shared', 'admin-backups');
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, baseName), 'occupied');
    expect(existsSync(join(backupDir, baseName))).toBe(true);

    const archive = await w.owner.delete(`/api/auth/admin/users/${victimUid}`)
      .set('X-CSRF-Token', w.ownerCsrf).send({ mode: 'archive' });
    expect(archive.status).toBe(200);
    expect(archive.body.data.mode).toBe('archive');
    expect(typeof archive.body.data.archiveError).toBe('string');
    expect(archive.body.data).not.toHaveProperty('archivedTo');
    // The account row IS deleted (the row transaction ran first)…
    expect(usersDb.getUser(victimUid)).toBeNull();
    // …but the live tree survived: rmSync is skipped when the copy fails.
    expect(existsSync(join(usersRoot(), 'victim', 'precious.txt'))).toBe(true);
  });

  it('usage counts the legacy UID-keyed root and degrades to 0 over an unreadable root (file where a dir is expected)', async () => {
    const w = await world();
    // No ~/users/sam tree at all; only the legacy UID-keyed root carries bytes.
    mkdirSync(join(legacyRoot(), w.samUid), { recursive: true });
    writeFileSync(join(legacyRoot(), w.samUid, 'by-uid.txt'), 'U'.repeat(120));

    const agent = request.agent(app);
    await loginOk(agent, { username: 'sam', secret: '4321' });
    const usage = await agent.get('/api/auth/usage');
    expect(usage.status).toBe(200);
    expect(usage.body.data.usage.usedBytes).toBe(120);

    // Now make the CURRENT-layout root a FILE: dirSizeBytes' readdirSync
    // throws ENOTDIR and the route degrades to the surviving roots (none).
    rmSync(join(legacyRoot(), w.samUid), { recursive: true, force: true });
    mkdirSync(usersRoot(), { recursive: true });
    writeFileSync(join(usersRoot(), 'sam'), 'not a directory');
    const degraded = await agent.get('/api/auth/usage');
    expect(degraded.status).toBe(200);
    expect(degraded.body.data.usage.usedBytes).toBe(0);
  });
});

// ─── 16. suspension policy boundaries ───────────────────────────────────────

describe('auth-routes — suspension policy boundaries', () => {
  it('maxSuspendedSessionsPerAccount=2: two stale sessions survive, the third forces the revoke', async () => {
    const w = await world();
    await w.owner.put('/api/auth/admin/policies').set('X-CSRF-Token', w.ownerCsrf)
      .send({ maxSuspendedSessionsPerAccount: 2 });

    // Two stale + the current login → existing=2 < 3 → NO revoke.
    for (let i = 0; i < 2; i++) await loginOk(request.agent(app), { username: 'sam', secret: '4321' });
    const agent = request.agent(app);
    const login = await loginOk(agent, { username: 'sam', secret: '4321' });
    await agent.post('/api/auth/suspend').set('X-CSRF-Token', login.csrf).send({});
    const afterTwo = await w.owner.get('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf);
    expect(afterTwo.body.data.users.find(u => u.username === 'sam').trackedSessions).toBe(3);
    expect(usersDb.sessionsForUser(w.samUid)).toHaveLength(3);

    // One more login (existing=3 >= 2+1) → suspending it revokes the extras.
    const extra = await loginOk(request.agent(app), { username: 'sam', secret: '4321' });
    const suspend = await request(app).post('/api/auth/suspend')
      .set('X-Nova-Session', extra.sid).set('X-CSRF-Token', extra.csrf).send({});
    expect(suspend.status).toBe(200);
    const afterThree = await w.owner.get('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf);
    expect(afterThree.body.data.users.find(u => u.username === 'sam').trackedSessions).toBe(1);
    expect(usersDb.sessionsForUser(w.samUid)).toEqual([extra.sid]);
  });

  it('a null policy value falls back to 1 via the route’s ?? default (one stale is NOT enough to revoke)', async () => {
    const w = await world();
    // Explicitly null: getPolicyBlock hands the route null and the `?? 1`
    // default must kick in — with the raw null the comparison would revoke
    // at ONE stale session already.
    const write = await w.owner.put('/api/auth/admin/policies').set('X-CSRF-Token', w.ownerCsrf)
      .send({ maxSuspendedSessionsPerAccount: null });
    expect(write.status).toBe(200);

    const stale = await loginOk(request.agent(app), { username: 'sam', secret: '4321' });
    const agent = request.agent(app);
    const login = await loginOk(agent, { username: 'sam', secret: '4321' });
    await agent.post('/api/auth/suspend').set('X-CSRF-Token', login.csrf).send({});

    // Fallback 1 → threshold 2 → one stale is below it: nothing is revoked.
    const adminList = await w.owner.get('/api/auth/admin/users').set('X-CSRF-Token', w.ownerCsrf);
    expect(adminList.body.data.users.find(u => u.username === 'sam').trackedSessions).toBe(2);
    expect(usersDb.sessionsForUser(w.samUid)).toEqual(expect.arrayContaining([stale.sid, login.sid]));
  });
});

// ─── 17. WebAuthn store/algorithm edges ──────────────────────────────────────

describe('auth-routes — WebAuthn store/algorithm edges', () => {
  function p256() {
    const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return { privateKey, jwk: publicKey.export({ format: 'jwk' }) };
  }

  async function enroll(agent, csrf, { uid, credId, cose, alg, label }) {
    const options = await agent.post('/api/auth/webauthn/register/options')
      .set('X-CSRF-Token', csrf).send(uid ? { uid } : {});
    expect(options.status).toBe(200);
    const finish = await agent.post('/api/auth/webauthn/register/finish')
      .set('X-CSRF-Token', csrf)
      .send({
        credentialId: credId,
        publicKey: cose,
        alg,
        label,
        clientDataJSON: clientDataB64u('webauthn.create', options.body.data.challenge),
      });
    return { options, finish };
  }

  it('DELETE /webauthn/credentials/:credId demands a session (401) even with a valid CSRF token', async () => {
    const w = await world();
    const host = await anonSession(app);
    const anon = await host.agent.delete('/api/auth/webauthn/credentials/some-cred')
      .set('X-CSRF-Token', host.csrf);
    expect(anon.status).toBe(401);
    expect(anon.body).toMatchObject({ success: false, code: 'AUTH_REQUIRED', message: 'Sign in first' });
  });

  it('excludeCredentials lists the account’s existing authenticators on re-enrollment', async () => {
    const w = await world();
    const key = p256();
    const credId = 'exclude-1';
    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    expect((await enroll(sam, samLogin.csrf, { credId, cose: coseEc(key.jwk) })).finish.status).toBe(200);

    const again = await sam.post('/api/auth/webauthn/register/options')
      .set('X-CSRF-Token', samLogin.csrf).send({});
    expect(again.status).toBe(200);
    expect(again.body.data.excludeCredentials).toEqual([{ type: 'public-key', id: credId }]);
  });

  it('enrollment without an explicit alg stores the JWK’s own default (EC → -7)', async () => {
    const w = await world();
    const key = p256();
    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    expect((await enroll(sam, samLogin.csrf, { credId: 'noalg-1', cose: coseEc(key.jwk) })).finish.status).toBe(200);

    const list = await sam.get('/api/auth/webauthn/credentials').set('X-CSRF-Token', samLogin.csrf);
    const stored = list.body.data.credentials.find(c => c.cred_id === 'noalg-1');
    expect(stored.alg).toBe(-7); // Number(undefined) is NaN → the JWK default
  });

  it('OKP with a curve other than Ed25519 is rejected (WEBAUTHN_UNSUPPORTED)', async () => {
    const w = await world();
    const edPair = nodeCrypto.generateKeyPairSync('ed25519');
    const edJwk = edPair.publicKey.export({ format: 'jwk' });
    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    // kty 6 (OKP) with crv 1 instead of 6: coseToJwk returns null.
    const finish = await enroll(sam, samLogin.csrf, {
      credId: 'badokp-1', cose: [1, 6, 3, -8, -1, 1, -2, edJwk.x],
    });
    expect(finish.finish.status).toBe(400);
    expect(finish.finish.body).toMatchObject({
      code: 'WEBAUTHN_UNSUPPORTED',
      message: 'Only ES256, RS256 and Ed25519 credentials are supported',
    });
  });

  it('an unknown stored alg falls back to RS256 — an Ed25519 credential then fails verification', async () => {
    const w = await world();
    // Seed the store directly with a REAL Ed25519 JWK but alg -999 (not in
    // COSE_ALGS): verifyAssertionSignature takes the RS256 fallback path, and
    // crypto.verify('sha256', …, edKey, sig) cannot verify an EdDSA signature
    // under that hash algorithm — it throws, the catch returns false, and the
    // route answers 401 WEBAUTHN_SIGNATURE.
    const edPair = nodeCrypto.generateKeyPairSync('ed25519');
    const edJwk = edPair.publicKey.export({ format: 'jwk' });
    usersDb.addWebauthnCredential(w.samUid, 'ed-algfallback-1', JSON.stringify(edJwk), -999, null);

    const opts = await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid });
    expect(opts.status).toBe(200);
    expect(opts.body.data.allowCredentials.map(c => c.id)).toContain('ed-algfallback-1');
    const challenge = opts.body.data.challenge;
    const authData = makeAuthData(1);
    const cd = clientDataB64u('webauthn.get', challenge);
    const sig = nodeCrypto.sign(null, assertionMessage(authData, cd), edPair.privateKey);

    const finish = await request(app).post('/api/auth/webauthn/login/finish').send({
      uid: w.samUid, credentialId: 'ed-algfallback-1',
      authenticatorData: b64u(authData),
      clientDataJSON: cd,
      signature: b64u(sig),
    });
    expect(finish.status).toBe(401);
    expect(finish.body).toMatchObject({ code: 'WEBAUTHN_SIGNATURE', message: 'Signature verification failed' });
  });

  it('the DER conversion pads high-order halves: a raw signature needing the 0x00 prefix still verifies', async () => {
    const w = await world();
    const key = p256();
    const credId = 'highbit-1';
    const sam = request.agent(app);
    const samLogin = await loginOk(sam, { username: 'sam', secret: '4321' });
    expect((await enroll(sam, samLogin.csrf, { credId, cose: coseEc(key.jwk) })).finish.status).toBe(200);

    // toInt() pads a half with its first non-zero byte >= 0x80 (DER INTEGERs
    // must be positive). Hunt for a counter whose raw r||s has such a half —
    // every options call yields a fresh challenge, so each signature differs.
    const hasHighHalf = (raw) => {
      const check = (half) => {
        let start = 0;
        while (start < half.length && half[start] === 0) start++;
        const stripped = half.subarray(start);
        return stripped.length > 0 && stripped[0] > 0x7f;
      };
      return check(raw.subarray(0, 32)) || check(raw.subarray(32, 64));
    };

    let chosen = null;
    for (let counter = 1; counter <= 60 && !chosen; counter++) {
      const opts = await request(app).post('/api/auth/webauthn/login/options').send({ uid: w.samUid });
      const challenge = opts.body.data.challenge;
      const authData = makeAuthData(counter);
      const cd = clientDataB64u('webauthn.get', challenge);
      const derSig = nodeCrypto.sign('sha256', assertionMessage(authData, cd), key.privateKey);
      const raw = derToRaw(derSig);
      if (hasHighHalf(raw)) chosen = { counter, challenge, authData, cd, raw };
    }
    expect(chosen).toBeTruthy();

    const finish = await request(app).post('/api/auth/webauthn/login/finish').send({
      uid: w.samUid, credentialId: credId,
      authenticatorData: b64u(chosen.authData),
      clientDataJSON: chosen.cd,
      signature: b64u(chosen.raw),
    });
    // The high-padding arm produced a valid DER signature: the route moved
    // past verification and crashed at the documented touchLogin call.
    expect(finish.status).toBe(500);
    expect(finish.body).toEqual({});
    const list = await sam.get('/api/auth/webauthn/credentials').set('X-CSRF-Token', samLogin.csrf);
    expect(list.body.data.credentials.find(c => c.cred_id === credId).sign_count).toBe(chosen.counter);
  });
});
