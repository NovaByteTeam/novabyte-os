import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

// Same-module-instance discipline as tests/server/push.test.js: the CJS
// modules under test MUST come through one createRequire registry, otherwise
// vite-node hands us a second instance whose config/blocked-IP/CSRF state
// diverges from the one the express apps actually run.
const require = createRequire(import.meta.url);

process.env.NBOSP_CRED_KEY = 'e'.repeat(64);
process.env.SESSION_SECRET = 'f'.repeat(128);

const express = require('express');
const session = require('express-session');
const request = require('supertest');

const mw = require('../../security/middleware.js');

const envSnapshot = { ...process.env };
// Snapshot of the shipped exemption list — tests that replace it restore this.
const defaultCsrfExempt = [...mw.csrfExempt];

// ─── Shared fixtures ────────────────────────────────────────────────────────

const csrfStore = new session.MemoryStore();
const chainStore = new session.MemoryStore();

const storeGet = (store, sid) => new Promise((resolve, reject) => {
  store.get(sid, (err, sess) => (err ? reject(err) : resolve(sess)));
});

function cookieSid(res) {
  const header = res.headers['set-cookie']?.[0];
  if (!header) return null;
  const m = header.match(/connect\.sid=([^;]+)/);
  if (!m) return null;
  const raw = decodeURIComponent(m[1]);
  return raw.startsWith('s:') ? raw.slice(2).split('.')[0] : raw.split('.')[0];
}

/** Minimal app: given middleware stack + a terminal echo handler. */
function echoApp(...middleware) {
  const a = express();
  a.use(express.json());
  for (const m of middleware) a.use(m);
  a.use((req, res) => res.json({
    ok: true,
    body: req.body === undefined ? null : req.body,
    query: req.query,
    locals: res.locals,
  }));
  return a;
}

/** Real session-backed app running csrfTokenMiddleware + csrfProtection. */
function csrfSessionApp() {
  const a = express();
  a.use(express.json());
  a.use(session({
    store: csrfStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 },
  }));
  a.use(mw.csrfTokenMiddleware);
  a.use(mw.csrfProtection);
  a.get('/protected', (req, res) => res.json({ ok: true, token: res.locals.csrfToken }));
  a.post('/protected', (req, res) => res.json({ ok: true, body: req.body ?? null }));
  return a;
}

/** System-trust HMAC headers, exactly like the OS host's system-fetch wrapper
 * (see server/rate-limit-auth.js and tests/server/push.test.js). */
function trustedHeaders(path) {
  const timestamp = String(Date.now());
  const signature = crypto
    .createHmac('sha256', process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET)
    .update(`${timestamp}\n${path}`)
    .digest('hex');
  return {
    'x-nova-system-app': path,
    'x-nova-system-time': timestamp,
    'x-nova-system-signature': signature,
  };
}

function resetSecurityState() {
  for (const ip of mw.getBlockedIPs()) mw.unblockIP(ip);
  mw.configure({
    enableCsrfProtection: true,
    enableIpBlocking: true,
    enableRequestValidation: true,
    enableInputSanitization: true,
    csrfTokenLength: 32,
    maxRequestSize: '10mb',
    trustedProxies: ['127.0.0.1', '::1'],
  });
}

let apps;

beforeAll(() => {
  apps = {};

  // getClientIP echo (needs the live req object)
  apps.ip = express();
  apps.ip.use((req, res) => res.json({ ip: mw.getClientIP(req) }));

  apps.blocking = echoApp(mw.ipBlocking);
  apps.throttle = echoApp(mw.ipThrottleMiddleware);
  apps.headers = echoApp(mw.securityHeaders);
  apps.url = echoApp(mw.validateURL);
  apps.sanitize = echoApp(mw.inputSanitization);
  apps.csrfSession = csrfSessionApp();

  apps.size1kb = echoApp(mw.requestSizeLimit('1kb'));
  apps.size2b = echoApp(mw.requestSizeLimit('2'));
  apps.sizeDefault = echoApp(mw.requestSizeLimit());
  apps.sizeBogus = echoApp(mw.requestSizeLimit('bogus'));

  apps.methodPost = echoApp(mw.validateMethod(['POST']));
  apps.methodDefault = echoApp(mw.validateMethod());

  // validateRequest app with body/query/params schemas on real routes
  const thingSchema = {
    body: {
      name: { type: 'string', required: true, minLength: 2, maxLength: 10 },
      age: { type: 'number', min: 1, max: 120 },
      kind: { type: 'string', enum: ['alpha', 'beta'] },
      code: { type: 'string', pattern: '^\\d{3}$' },
    },
    query: { tag: { type: 'string' } },
  };
  const validate = express();
  validate.use(express.json());
  validate.post('/things', mw.validateRequest(thingSchema), (req, res) => res.json({ ok: true, body: req.body }));
  validate.get('/things', mw.validateRequest(thingSchema), (req, res) => res.json({ ok: true }));
  validate.get('/users/:id', mw.validateRequest({ params: { id: { type: 'string', pattern: '^\\d+$' } } }), (req, res) => res.json({ ok: true, id: req.params.id }));
  apps.validate = validate;

  // Full createSecurityMiddleware chain with a real session store
  const chain = express();
  chain.use(express.json());
  chain.use(session({
    store: chainStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 },
  }));
  for (const m of mw.createSecurityMiddleware({})) chain.use(m);
  chain.get('/api/submit', (req, res) => res.json({ ok: true }));
  chain.post('/api/submit', (req, res) => res.json({ body: req.body }));
  apps.chain = chain;
});

beforeEach(() => {
  resetSecurityState();
  delete process.env.TRUST_X_FORWARDED_FOR;
  delete process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET;
});

afterEach(() => {
  resetSecurityState();
  mw.csrfExempt = defaultCsrfExempt;
  delete process.env.TRUST_X_FORWARDED_FOR;
  delete process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET;
  csrfStore.clear();
  chainStore.clear();
});

afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
});

// ─── sanitizeString / sanitizeObject ────────────────────────────────────────

describe('security/middleware.js — sanitizeString', () => {
  it('escapes every HTML-sensitive character in an XSS payload', () => {
    expect(mw.sanitizeString(`<script>alert('x' & "y")</script>`))
      .toBe('&lt;script&gt;alert(&#x27;x&#x27; &amp; &quot;y&quot;)&lt;/script&gt;');
  });

  it('escapes each character class individually', () => {
    expect(mw.sanitizeString('&')).toBe('&amp;');
    expect(mw.sanitizeString('<')).toBe('&lt;');
    expect(mw.sanitizeString('>')).toBe('&gt;');
    expect(mw.sanitizeString('"')).toBe('&quot;');
    expect(mw.sanitizeString("'")).toBe('&#x27;');
  });

  it('passes non-string values through unchanged', () => {
    expect(mw.sanitizeString(42)).toBe(42);
    expect(mw.sanitizeString(null)).toBe(null);
    expect(mw.sanitizeString(undefined)).toBe(undefined);
    expect(mw.sanitizeString(true)).toBe(true);
  });

  it('returns empty strings untouched', () => {
    expect(mw.sanitizeString('')).toBe('');
  });
});

describe('security/middleware.js — sanitizeObject', () => {
  it('recursively sanitizes nested objects, arrays and strings', () => {
    const input = {
      name: '<b>Sam</b>',
      tags: ['<i>a</i>', { deep: '"quoted"' }],
      profile: { bio: "it's <strong>fine</strong>", n: 7 },
    };
    expect(mw.sanitizeObject(input)).toEqual({
      name: '&lt;b&gt;Sam&lt;/b&gt;',
      tags: ['&lt;i&gt;a&lt;/i&gt;', { deep: '&quot;quoted&quot;' }],
      profile: { bio: 'it&#x27;s &lt;strong&gt;fine&lt;/strong&gt;', n: 7 },
    });
  });

  it('passes primitives and null through untouched', () => {
    expect(mw.sanitizeObject(5)).toBe(5);
    expect(mw.sanitizeObject(null)).toBe(null);
    expect(mw.sanitizeObject('plain')).toBe('plain');
  });
});

// ─── generateCSRFToken ──────────────────────────────────────────────────────

describe('security/middleware.js — generateCSRFToken', () => {
  it('produces unique 64-char hex tokens at the default length', () => {
    const tokens = new Set();
    for (let i = 0; i < 50; i++) {
      const t = mw.generateCSRFToken();
      expect(t).toMatch(/^[0-9a-f]{64}$/);
      tokens.add(t);
    }
    expect(tokens.size).toBe(50);
  });

  it('honors a configured csrfTokenLength', () => {
    mw.configure({ csrfTokenLength: 8 });
    expect(mw.generateCSRFToken()).toMatch(/^[0-9a-f]{16}$/);
    mw.configure({ csrfTokenLength: 32 });
  });
});

// ─── getClientIP ────────────────────────────────────────────────────────────

describe('security/middleware.js — getClientIP', () => {
  it('ignores X-Forwarded-For unless the deployment explicitly opts in', async () => {
    const res = await request(apps.ip).get('/').set('X-Forwarded-For', '6.6.6.6');
    expect(res.status).toBe(200);
    expect(res.body.ip).toBe('127.0.0.1');
  });

  it('uses the first X-Forwarded-For entry when trust is enabled and the peer is a trusted proxy', async () => {
    process.env.TRUST_X_FORWARDED_FOR = '1';
    const res = await request(apps.ip).get('/').set('X-Forwarded-For', '9.9.9.9, 10.0.0.1');
    expect(res.body.ip).toBe('9.9.9.9');
  });

  it('falls back to req.ip when the peer is not in trustedProxies even with trust enabled', async () => {
    process.env.TRUST_X_FORWARDED_FOR = '1';
    mw.configure({ trustedProxies: ['10.0.0.1'] });
    const res = await request(apps.ip).get('/').set('X-Forwarded-For', '9.9.9.9');
    expect(res.body.ip).toBe('127.0.0.1');
  });

  it('falls back to req.ip when trust is enabled but no XFF header is sent', async () => {
    process.env.TRUST_X_FORWARDED_FOR = '1';
    const res = await request(apps.ip).get('/');
    expect(res.body.ip).toBe('127.0.0.1');
  });

  it('prefers req.ip over socket.remoteAddress and reports unknown when both are absent', () => {
    expect(mw.getClientIP({ ip: '1.2.3.4', socket: { remoteAddress: '5.6.7.8' }, headers: {} })).toBe('1.2.3.4');
    expect(mw.getClientIP({ ip: undefined, socket: { remoteAddress: '5.6.7.8' }, headers: {} })).toBe('5.6.7.8');
    // A socket with no remote address (pre-connect) degrades to 'unknown'.
    expect(mw.getClientIP({ ip: undefined, socket: {}, headers: {} })).toBe('unknown');
  });
});

// ─── ipBlocking ─────────────────────────────────────────────────────────────

describe('security/middleware.js — ipBlocking', () => {
  it('rejects a blocked IP with 403 IP_BLOCKED before the route runs', async () => {
    process.env.TRUST_X_FORWARDED_FOR = '1';
    mw.blockIP('203.0.113.10');
    const res = await request(apps.blocking).get('/').set('X-Forwarded-For', '203.0.113.10');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'Access Denied',
      message: 'Your IP address has been blocked',
      code: 'IP_BLOCKED',
    });
  });

  it('lets non-blocked IPs through', async () => {
    process.env.TRUST_X_FORWARDED_FOR = '1';
    mw.blockIP('203.0.113.10');
    const res = await request(apps.blocking).get('/').set('X-Forwarded-For', '203.0.113.11');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('blocks the real loopback peer when 127.0.0.1 itself is blocked', async () => {
    mw.blockIP('127.0.0.1');
    const res = await request(apps.blocking).get('/');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('IP_BLOCKED');
  });

  it('stops blocking entirely when IP blocking is disabled through configure', async () => {
    process.env.TRUST_X_FORWARDED_FOR = '1';
    mw.blockIP('203.0.113.12');
    mw.configure({ enableIpBlocking: false });
    const res = await request(apps.blocking).get('/').set('X-Forwarded-For', '203.0.113.12');
    expect(res.status).toBe(200);
  });
});

// ─── blockIP / unblockIP / isIPBlocked / getBlockedIPs ─────────────────────

describe('security/middleware.js — IP blocklist management', () => {
  it('blockIP adds, isIPBlocked reflects, unblockIP removes', () => {
    expect(mw.isIPBlocked('198.51.100.1')).toBe(false);
    mw.blockIP('198.51.100.1', 'testing');
    expect(mw.isIPBlocked('198.51.100.1')).toBe(true);
    expect(mw.getBlockedIPs()).toContain('198.51.100.1');
    mw.unblockIP('198.51.100.1');
    expect(mw.isIPBlocked('198.51.100.1')).toBe(false);
    expect(mw.getBlockedIPs()).not.toContain('198.51.100.1');
  });

  it('configure({blockedIPs}) merges into the live blocklist without wiping it', async () => {
    mw.blockIP('198.51.100.2');
    mw.configure({ blockedIPs: ['198.51.100.3', '198.51.100.4'] });
    expect(mw.getBlockedIPs().sort()).toEqual(['198.51.100.2', '198.51.100.3', '198.51.100.4']);

    // The merged entries really block requests.
    process.env.TRUST_X_FORWARDED_FOR = '1';
    const res = await request(apps.blocking).get('/').set('X-Forwarded-For', '198.51.100.4');
    expect(res.status).toBe(403);
  });
});

// ─── ipThrottleMiddleware ───────────────────────────────────────────────────

describe('security/middleware.js — ipThrottleMiddleware', () => {
  it('allows 30 requests per IP per window and 429s the 31st', async () => {
    process.env.TRUST_X_FORWARDED_FOR = '1';
    const ip = '203.0.113.30';
    for (let i = 0; i < 30; i++) {
      const res = await request(apps.throttle).get('/api/thing').set('X-Forwarded-For', ip);
      expect(res.status).toBe(200);
    }
    const limited = await request(apps.throttle).get('/api/thing').set('X-Forwarded-For', ip);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('Too Many Requests');
    expect(limited.body.message).toBe('Rate limit exceeded');
    expect(limited.body.retryAfter).toBeGreaterThanOrEqual(1);
    expect(limited.body.retryAfter).toBeLessThanOrEqual(60);
    // Still limited on the next request within the same window.
    const again = await request(apps.throttle).get('/api/thing').set('X-Forwarded-For', ip);
    expect(again.status).toBe(429);
  });

  it('throttles per client IP: a different IP is unaffected', async () => {
    process.env.TRUST_X_FORWARDED_FOR = '1';
    const busy = '203.0.113.31';
    for (let i = 0; i < 32; i++) {
      await request(apps.throttle).get('/api/thing').set('X-Forwarded-For', busy);
    }
    const other = await request(apps.throttle).get('/api/thing').set('X-Forwarded-For', '203.0.113.32');
    expect(other.status).toBe(200);
  });

  it('resets the window after 60 seconds', async () => {
    process.env.TRUST_X_FORWARDED_FOR = '1';
    const ip = '203.0.113.33';
    const t0 = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      for (let i = 0; i < 32; i++) {
        const res = await request(apps.throttle).get('/api/thing').set('X-Forwarded-For', ip);
        expect(res.status).toBe(i < 30 ? 200 : 429);
      }
      // Advance past the 60s window: the bucket resets and traffic flows again.
      spy.mockReturnValue(t0 + 61 * 1000);
      const after = await request(apps.throttle).get('/api/thing').set('X-Forwarded-For', ip);
      expect(after.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it('trusted system-app requests bypass the throttle even with an exhausted bucket', async () => {
    process.env.TRUST_X_FORWARDED_FOR = '1';
    process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET = 'test-security-secret';
    const ip = '203.0.113.34';
    for (let i = 0; i < 32; i++) {
      await request(apps.throttle).get('/api/thing').set('X-Forwarded-For', ip);
    }
    const res = await request(apps.throttle).get('/api/thing')
      .set('X-Forwarded-For', ip)
      .set(trustedHeaders('/api/thing'));
    expect(res.status).toBe(200);
  });

  it('exempts asset, inspector, email and favicon paths from strict throttling', async () => {
    process.env.TRUST_X_FORWARDED_FOR = '1';
    const ip = '203.0.113.35';
    for (let i = 0; i < 32; i++) {
      await request(apps.throttle).get('/api/thing').set('X-Forwarded-For', ip);
    }
    // The bucket for this IP is exhausted, but all these paths skip the check.
    for (const path of [
      '/assets/app.js', '/js/app.js', '/css/app.css', '/public/logo.svg',
      '/sysinfo', '/api/processes', '/api/sysinfo', '/processes',
      '/api/email/folders', '/api/favicon/example.com',
    ]) {
      const res = await request(apps.throttle).get(path).set('X-Forwarded-For', ip);
      expect(res.status).toBe(200);
    }
    // ...while a non-exempt path on the same IP is still throttled.
    const limited = await request(apps.throttle).get('/api/other').set('X-Forwarded-For', ip);
    expect(limited.status).toBe(429);
  });
});

// ─── csrfProtection ─────────────────────────────────────────────────────────

describe('security/middleware.js — csrfProtection', () => {
  it('lets safe methods (GET/HEAD/OPTIONS) through without any token', async () => {
    const agent = request.agent(apps.csrfSession);
    for (const method of ['get', 'head', 'options']) {
      const res = await agent[method]('/protected');
      expect([200, 204]).toContain(res.status);
    }
  });

  it('rejects a state-changing request without a token (403 CSRF_MISSING)', async () => {
    const agent = request.agent(apps.csrfSession);
    await agent.get('/protected'); // establish the session
    const res = await agent.post('/protected').send({ a: 1 });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'CSRF Token Required',
      message: 'Missing CSRF token',
      code: 'CSRF_MISSING',
    });
  });

  it('rejects a request whose session has no token yet (403 CSRF_INVALID, no session)', async () => {
    const a = express();
    a.use(express.json());
    a.use(mw.csrfProtection);
    a.post('/x', (req, res) => res.json({ ok: true }));
    const res = await request(a).post('/x').set('X-CSRF-Token', 'a'.repeat(64)).send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Invalid CSRF Token', code: 'CSRF_INVALID' });
    expect(res.body.message).toContain('no session');
  });

  it('rejects a token of the wrong length before comparing (403 CSRF_INVALID)', async () => {
    const agent = request.agent(apps.csrfSession);
    const seeded = await agent.get('/protected');
    const token = seeded.body.token;
    const res = await agent.post('/protected').set('X-CSRF-Token', token.slice(0, 63)).send({});
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('length mismatch');
    expect(res.body.code).toBe('CSRF_INVALID');
  });

  it('rejects a well-formed but wrong token (403 CSRF_INVALID)', async () => {
    const agent = request.agent(apps.csrfSession);
    await agent.get('/protected');
    const res = await agent.post('/protected').set('X-CSRF-Token', 'f'.repeat(64)).send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Invalid CSRF Token', code: 'CSRF_INVALID' });
    expect(res.body.message).toBe('CSRF token validation failed');
  });

  it('accepts a state-changing request carrying the session token in the X-CSRF-Token header', async () => {
    const agent = request.agent(apps.csrfSession);
    const seeded = await agent.get('/protected');
    const res = await agent.post('/protected')
      .set('X-CSRF-Token', seeded.body.token)
      .send({ payload: '<b>x</b>' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('accepts the token supplied as req.body._csrf', async () => {
    const agent = request.agent(apps.csrfSession);
    const seeded = await agent.get('/protected');
    const res = await agent.post('/protected').send({ _csrf: seeded.body.token });
    expect(res.status).toBe(200);
  });

  it('accepts the token supplied as a _csrf query parameter', async () => {
    const agent = request.agent(apps.csrfSession);
    const seeded = await agent.get('/protected');
    const res = await agent.post(`/protected?_csrf=${seeded.body.token}`).send({});
    expect(res.status).toBe(200);
  });

  it('skips exact and prefixed csrfExempt paths (e.g. /api/email covers /api/email/send)', async () => {
    const a = express();
    a.use(express.json());
    a.use(mw.csrfProtection);
    a.post('/health', (req, res) => res.json({ ok: true }));
    a.post('/api/email/send', (req, res) => res.json({ ok: true }));
    a.post('/api/emailX', (req, res) => res.json({ ok: true }));

    const health = await request(a).post('/health').send({});
    expect(health.status).toBe(200);
    const email = await request(a).post('/api/email/send').send({});
    expect(email.status).toBe(200);
    // Prefix matching requires the slash: /api/emailX is NOT exempt.
    const notExempt = await request(a).post('/api/emailX').send({});
    expect(notExempt.status).toBe(403);
    expect(notExempt.body.code).toBe('CSRF_MISSING');
  });

  it('skips the /bare/ proxy prefix', async () => {
    const a = express();
    a.use(express.json());
    a.use(mw.csrfProtection);
    a.post('/bare/anything', (req, res) => res.json({ ok: true }));
    const res = await request(a).post('/bare/anything').send({});
    expect(res.status).toBe(200);
  });

  it('csrfExempt getter exposes the shipped list and the setter replaces it', async () => {
    expect(mw.csrfExempt).toContain('/health');
    expect(mw.csrfExempt).toContain('/api/security/strip-tracking');
    expect(mw.csrfExempt).toContain('/api/push/subscribe');

    const a = express();
    a.use(express.json());
    a.use(mw.csrfProtection);
    a.post('/custom-exempt', (req, res) => res.json({ ok: true }));
    a.post('/custom-exempt/child', (req, res) => res.json({ ok: true }));
    a.post('/health', (req, res) => res.json({ ok: true }));

    mw.csrfExempt = ['/custom-exempt'];
    expect(mw.csrfExempt).toEqual(['/custom-exempt']);

    const exact = await request(a).post('/custom-exempt').send({});
    expect(exact.status).toBe(200);
    const child = await request(a).post('/custom-exempt/child').send({});
    expect(child.status).toBe(200);
    // The old default exemption is gone.
    const health = await request(a).post('/health').send({});
    expect(health.status).toBe(403);
  });

  it('does nothing when CSRF protection is disabled through configure', async () => {
    const a = express();
    a.use(express.json());
    a.use(mw.csrfProtection);
    a.post('/x', (req, res) => res.json({ ok: true }));
    mw.configure({ enableCsrfProtection: false });
    const res = await request(a).post('/x').send({});
    expect(res.status).toBe(200);
  });
});

// ─── csrfTokenMiddleware ────────────────────────────────────────────────────

describe('security/middleware.js — csrfTokenMiddleware', () => {
  it('creates a session object when none exists and exposes the token via res.locals', async () => {
    const a = express();
    a.use(mw.csrfTokenMiddleware);
    a.get('/token', (req, res) => res.json({ token: res.locals.csrfToken, hasSession: !!req.session }));
    const res = await request(a).get('/token');
    expect(res.status).toBe(200);
    expect(res.body.hasSession).toBe(true);
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stamps and persists the token on a real session (save runs before next)', async () => {
    const agent = request.agent(apps.csrfSession);
    const first = await agent.get('/protected');
    const sid = cookieSid(first);
    expect(sid).toBeTruthy();
    const stored = await storeGet(csrfStore, sid);
    expect(stored.csrfToken).toBe(first.body.token);
  });

  it('reuses the existing session token instead of regenerating it', async () => {
    const agent = request.agent(apps.csrfSession);
    const first = await agent.get('/protected');
    const second = await agent.get('/protected');
    expect(second.body.token).toBe(first.body.token);
  });

  it('the persisted token authorizes a later state-changing request', async () => {
    const agent = request.agent(apps.csrfSession);
    const seeded = await agent.get('/protected');
    const stored = await storeGet(csrfStore, cookieSid(seeded));
    const res = await agent.post('/protected').set('X-CSRF-Token', stored.csrfToken).send({});
    expect(res.status).toBe(200);
  });
});

// ─── inputSanitization ──────────────────────────────────────────────────────

describe('security/middleware.js — inputSanitization', () => {
  const payload = { name: '<script>alert("x")</script>', nested: { deep: "it's" } };

  it('HTML-escapes string values in req.body (recursively)', async () => {
    const res = await request(apps.sanitize).post('/form').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({
      name: '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
      nested: { deep: 'it&#x27;s' },
    });
  });

  it('sanitizes arrays inside the body', async () => {
    const res = await request(apps.sanitize).post('/form').send({ list: ['<a>', 'b', 3] });
    expect(res.body.body.list).toEqual(['&lt;a&gt;', 'b', 3]);
  });

  it('skips /api/repair/, /api/backups/, /api/proxy and the /api/email family', async () => {
    for (const path of ['/api/repair/run', '/api/backups/restore', '/api/proxy', '/api/email', '/api/email/send']) {
      const res = await request(apps.sanitize).post(path).send(payload);
      expect(res.status, path).toBe(200);
      expect(res.body.body, path).toEqual(payload);
    }
  });

  it('still sanitizes paths that only look like the exempt ones', async () => {
    // /api/proxy is an exact-match exemption; sub-paths are NOT exempt.
    const res = await request(apps.sanitize).post('/api/proxy/child').send({ a: '<x>' });
    expect(res.body.body.a).toBe('&lt;x&gt;');
    // /api/repair without the trailing slash is not exempt either.
    const res2 = await request(apps.sanitize).post('/api/repair').send({ a: '<x>' });
    expect(res2.body.body.a).toBe('&lt;x&gt;');
  });

  it('leaves bodies untouched when input sanitization is disabled', async () => {
    mw.configure({ enableInputSanitization: false });
    const res = await request(apps.sanitize).post('/form').send(payload);
    expect(res.body.body).toEqual(payload);
  });

  // DOCUMENTS CURRENT BEHAVIOR (source bug — see final report): the
  // `req.query = sanitizeObject(req.query)` reassignment is a silent no-op on
  // Express 5 (req.query is a getter recomputed from the URL on every access,
  // verified: req.query !== req.query), so query strings are NOT sanitized —
  // only req.body is.
  it('query strings are currently NOT rewritten (Express 5 req.query assignment no-op)', async () => {
    const res = await request(apps.sanitize).post('/form?q=<script>1</script>').send({ a: '<b>' });
    expect(res.status).toBe(200);
    expect(res.body.body.a).toBe('&lt;b&gt;'); // body IS sanitized...
    expect(res.body.query.q).toBe('<script>1</script>'); // ...the query is NOT
  });
});

// ─── validateRequest ────────────────────────────────────────────────────────

describe('security/middleware.js — validateRequest', () => {
  const schema = {
    body: {
      name: { type: 'string', required: true, minLength: 2, maxLength: 10 },
      age: { type: 'number', min: 1, max: 120 },
      kind: { type: 'string', enum: ['alpha', 'beta'] },
      code: { type: 'string', pattern: '^\\d{3}$' },
    },
    query: { tag: { type: 'string' } },
  };

  it('passes a fully valid payload through untouched', async () => {
    const res = await request(apps.validate).post('/things')
      .send({ name: 'Sam', age: 30, kind: 'alpha', code: '123' })
      .query({ tag: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.body.name).toBe('Sam');
  });

  it('flags a missing required field', async () => {
    const res = await request(apps.validate).post('/things').send({ age: 30 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation Failed');
    expect(res.body.details[0]).toMatchObject({ field: 'name', location: 'body' });
    expect(res.body.details[0].message).toBe('name is required');
  });

  it('treats an empty string as a missing required value', async () => {
    const res = await request(apps.validate).post('/things').send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.details[0].message).toBe('name is required');
  });

  it('flags type mismatches (string expected, number given)', async () => {
    const res = await request(apps.validate).post('/things').send({ name: 42 });
    expect(res.status).toBe(400);
    expect(res.body.details[0].message).toBe('name must be of type string');
  });

  it('flags arrays where a string is declared', async () => {
    const res = await request(apps.validate).post('/things').send({ name: ['a', 'b'] });
    expect(res.status).toBe(400);
    expect(res.body.details[0].message).toBe('name must be of type string');
  });

  it('enforces minLength and maxLength on strings', async () => {
    const short = await request(apps.validate).post('/things').send({ name: 'x' });
    expect(short.status).toBe(400);
    expect(short.body.details[0].message).toBe('name must be at least 2 characters');

    const long = await request(apps.validate).post('/things').send({ name: 'x'.repeat(11) });
    expect(long.status).toBe(400);
    expect(long.body.details[0].message).toBe('name must be at most 10 characters');
  });

  it('enforces min and max on numbers, including boundaries', async () => {
    const tooSmall = await request(apps.validate).post('/things').send({ name: 'Sam', age: 0 });
    expect(tooSmall.status).toBe(400);
    expect(tooSmall.body.details[0].message).toBe('age must be at least 1');

    const tooBig = await request(apps.validate).post('/things').send({ name: 'Sam', age: 121 });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.details[0].message).toBe('age must be at most 120');

    const boundaries = await request(apps.validate).post('/things').send({ name: 'Sam', age: 120 });
    expect(boundaries.status).toBe(200);
  });

  it('flags a wrong type given for a numeric field', async () => {
    const res = await request(apps.validate).post('/things').send({ name: 'Sam', age: '30' });
    expect(res.status).toBe(400);
    expect(res.body.details[0].message).toBe('age must be of type number');
  });

  it('enforces enum membership and reports the allowed values', async () => {
    const res = await request(apps.validate).post('/things').send({ name: 'Sam', kind: 'gamma' });
    expect(res.status).toBe(400);
    expect(res.body.details[0].message).toBe('kind must be one of: alpha, beta');
  });

  it('enforces pattern format on strings', async () => {
    const bad = await request(apps.validate).post('/things').send({ name: 'Sam', code: 'abc' });
    expect(bad.status).toBe(400);
    expect(bad.body.details[0].message).toBe('code has invalid format');
    const good = await request(apps.validate).post('/things').send({ name: 'Sam', code: '007' });
    expect(good.status).toBe(200);
  });

  it('aggregates multiple body errors into one response', async () => {
    const res = await request(apps.validate).post('/things').send({ name: 'x', age: 999, kind: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.details).toHaveLength(3);
    expect(res.body.details.map((d) => d.field).sort()).toEqual(['age', 'kind', 'name']);
    expect(res.body.details.every((d) => d.location === 'body')).toBe(true);
  });

  it('validates the query location', async () => {
    const res = await request(apps.validate).post('/things?tag=a&tag=b').send({ name: 'Sam' });
    expect(res.status).toBe(400);
    expect(res.body.details[0]).toMatchObject({ field: 'tag', location: 'query' });
    expect(res.body.details[0].message).toBe('tag must be of type string');
  });

  it('validates route params when a params schema is given', async () => {
    const bad = await request(apps.validate).get('/users/abc');
    expect(bad.status).toBe(400);
    expect(bad.body.details[0]).toMatchObject({ field: 'id', location: 'params' });

    const good = await request(apps.validate).get('/users/123');
    expect(good.status).toBe(200);
  });

  it('skips body validation when the request carries no body (GET)', async () => {
    const res = await request(apps.validate).get('/things');
    expect(res.status).toBe(200);
  });

  it('does nothing when request validation is disabled through configure', async () => {
    mw.configure({ enableRequestValidation: false });
    const res = await request(apps.validate).post('/things').send({ name: 42 });
    expect(res.status).toBe(200);
  });
});

// ─── securityHeaders ────────────────────────────────────────────────────────

describe('security/middleware.js — securityHeaders', () => {
  it('sets the hardening headers on every response', async () => {
    const res = await request(apps.headers).get('/some/page');
    expect(res.status).toBe(200);
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-xss-protection']).toBe('1; mode=block');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['permissions-policy'])
      .toBe('geolocation=(self), microphone=(self), camera=(self), payment=(), usb=()');
    expect(res.headers['origin-agent-cluster']).toBe('?1');
    // Non-API paths get no cache-suppression headers.
    expect(res.headers['cache-control']).toBeUndefined();
    expect(res.headers.pragma).toBeUndefined();
  });

  it('adds no-store cache headers for /api/ paths', async () => {
    const res = await request(apps.headers).get('/api/data');
    expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate, proxy-revalidate');
    expect(res.headers.pragma).toBe('no-cache');
  });
});

// ─── requestSizeLimit ───────────────────────────────────────────────────────

describe('security/middleware.js — requestSizeLimit', () => {
  it('rejects a body larger than the configured limit with 413', async () => {
    const res = await request(apps.size1kb).post('/upload').send('x'.repeat(1025));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      error: 'Payload Too Large',
      message: 'Request body too large',
      maxSize: '1kb',
    });
  });

  it('allows a body exactly at the limit', async () => {
    const res = await request(apps.size1kb).post('/upload').send('x'.repeat(1024));
    expect(res.status).toBe(200);
  });

  it('allows requests without a content-length (e.g. GETs)', async () => {
    const res = await request(apps.size1kb).get('/upload');
    expect(res.status).toBe(200);
  });

  it('skips the app registration endpoint entirely', async () => {
    const res = await request(apps.size1kb).post('/api/apps/serve/register').send('x'.repeat(5000));
    expect(res.status).toBe(200);
  });

  it('a bare number is parsed as bytes', async () => {
    const res = await request(apps.size2b).post('/upload').send('xyz');
    expect(res.status).toBe(413);
    expect(res.body.maxSize).toBe('2');
  });

  it('defaults to 10mb when called with no arguments, and unparseable sizes fall back to 10mb', async () => {
    const res = await request(apps.sizeDefault).post('/upload').send('x'.repeat(11 * 1024 * 1024));
    expect(res.status).toBe(413);
    expect(res.body.maxSize).toBe('10mb');

    const bogus = await request(apps.sizeBogus).post('/upload').send('x'.repeat(11 * 1024 * 1024));
    expect(bogus.status).toBe(413);
    expect(bogus.body.maxSize).toBe('bogus');
  });
});

// ─── validateMethod ─────────────────────────────────────────────────────────

describe('security/middleware.js — validateMethod', () => {
  it('rejects a disallowed method with 405 and echoes the allowlist', async () => {
    const res = await request(apps.methodPost).get('/thing');
    expect(res.status).toBe(405);
    expect(res.body).toEqual({
      error: 'Method Not Allowed',
      message: 'Method GET not allowed',
      allowedMethods: ['POST'],
    });
  });

  it('allows the configured method through', async () => {
    const res = await request(apps.methodPost).post('/thing').send({});
    expect(res.status).toBe(200);
  });

  it('the default allowlist covers GET/POST/PUT/DELETE and rejects PATCH', async () => {
    const patch = await request(apps.methodDefault).patch('/thing').send({});
    expect(patch.status).toBe(405);
    expect(patch.body.allowedMethods).toEqual(['GET', 'POST', 'PUT', 'DELETE']);
    expect(patch.body.message).toBe('Method PATCH not allowed');

    const put = await request(apps.methodDefault).put('/thing').send({});
    expect(put.status).toBe(200);
  });
});

// ─── validateURL ────────────────────────────────────────────────────────────

describe('security/middleware.js — validateURL', () => {
  it('blocks an encoded ../ path traversal with 400', async () => {
    const res = await request(apps.url).get('/files/..%2f..%2fetc%2fpasswd');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid Request', message: 'URL validation failed' });
  });

  it('blocks a backslash traversal variant', async () => {
    const res = await request(apps.url).get('/files/..%5c..%5cwindows');
    expect(res.status).toBe(400);
  });

  it('lets /assets/ paths skip validation entirely (even with traversal bytes)', async () => {
    const res = await request(apps.url).get('/assets/..%2f..%2fsecret');
    expect(res.status).toBe(200);
  });

  it('allows literal dots that are not traversals', async () => {
    const res = await request(apps.url).get('/files/my..file.txt');
    expect(res.status).toBe(200);
  });

  it('falls through when percent-decoding fails (stability over crash)', async () => {
    const res = await request(apps.url).get('/files/a..%zz');
    expect(res.status).toBe(200);
  });
});

// ─── createSecurityMiddleware ───────────────────────────────────────────────

describe('security/middleware.js — createSecurityMiddleware', () => {
  it('returns the full middleware chain in the documented order', () => {
    const chain = mw.createSecurityMiddleware({});
    expect(chain).toHaveLength(7);
    expect(chain[0]).toBe(mw.securityHeaders);
    expect(chain[1]).toBe(mw.ipBlocking);
    expect(chain[2]).toBe(mw.validateURL);
    expect(chain[3]).toBe(mw.inputSanitization);
    // [4] is the requestSizeLimit(config.maxRequestSize) closure
    expect(typeof chain[4]).toBe('function');
    expect(chain[5]).toBe(mw.csrfTokenMiddleware);
    expect(chain[6]).toBe(mw.csrfProtection);
  });

  it('serves a GET through the whole chain with security headers applied', async () => {
    const res = await request(apps.chain).get('/api/submit');
    expect(res.status).toBe(200);
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('blocks a traversal URL inside the chain (400)', async () => {
    const res = await request(apps.chain).get('/api/files/..%2f..%2fetc');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid Request');
  });

  it('blocks a blocked IP inside the chain before CSRF is even evaluated', async () => {
    process.env.TRUST_X_FORWARDED_FOR = '1';
    mw.blockIP('203.0.113.40');
    const res = await request(apps.chain).post('/api/submit')
      .set('X-Forwarded-For', '203.0.113.40')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('IP_BLOCKED');
  });

  it('rejects a POST without a CSRF token inside the chain', async () => {
    const res = await request(apps.chain).post('/api/submit').send({ a: 1 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_MISSING');
  });

  it('accepts a POST with a session CSRF token and sanitizes its body', async () => {
    const agent = request.agent(apps.chain);
    const seeded = await agent.get('/api/submit');
    const sid = cookieSid(seeded);
    const stored = await storeGet(chainStore, sid);
    const res = await agent.post('/api/submit')
      .set('X-CSRF-Token', stored.csrfToken)
      .send({ title: '<script>x</script>' });
    expect(res.status).toBe(200);
    expect(res.body.body.title).toBe('&lt;script&gt;x&lt;/script&gt;');
  });

  it('passes options straight through to configure (e.g. CSRF disabled)', async () => {
    const a = echoApp(...mw.createSecurityMiddleware({ enableCsrfProtection: false }));
    const res = await request(a).post('/anything').send({ x: 1 });
    expect(res.status).toBe(200);
    expect(res.body.body.x).toBe(1);
  });

  it('picks up maxRequestSize configured before the chain is built', async () => {
    mw.configure({ maxRequestSize: '1kb' });
    const a = echoApp(...mw.createSecurityMiddleware({ enableCsrfProtection: false }));
    const res = await request(a).post('/anything').send('x'.repeat(2048));
    expect(res.status).toBe(413);
    expect(res.body.maxSize).toBe('1kb');
  });
});
