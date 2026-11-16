import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end tests for server/proxies.js (setupFrameCheckProxy,
// setupAppNetworkProxy, setupEmailImageProxy).
//
// Strategy: mount all three proxies on a real express app and drive FULL
// request → proxy → upstream → response cycles with supertest against REAL
// node:http upstream servers. No proxy internals are mocked — the SSRF
// pinning machinery (dns validation + pinned undici agents) runs for real.
//
// How the upstreams stay "public":
//   The machine's eth0 address (e.g. 21.0.9.78) is a globally-scoped IP that
//   the proxies' private-range checks consider public, yet connections to it
//   loop back internally. Upstreams listen on that IP, so the proxies
//   genuinely connect out, validate DNS (a literal IP lookup passes through
//   without DNS traffic), pin the connection, and receive real responses.
//
// Test-environment shims (documented, restored in afterAll):
//   1. tests/setup.js swaps globalThis.AbortController for a minimal fake.
//      undici's fetch rejects that signal ("Expected signal to be an
//      instance of AbortSignal"), so every proxied request would throw
//      before touching the network. We install a faithful duck-typed
//      AbortController (aborted flag, reason, listeners called with the
//      signal as `this`) and relax undici's webidl AbortSignal converter
//      (looked up at call time by the RequestInit dictionary) to accept
//      duck-typed signals. Abort semantics — including mid-flight
//      cancellation after the proxies' own timeouts — work end to end.
//   2. `dns.promises.lookup` is swapped only for hostname-specific tests
//      (DNS-rebinding shapes that cannot be expressed with literal IPs) and
//      restored immediately afterwards.
//   3. Rate limiters are bypassed via the real isTrustedSystemAppRequest
//      HMAC gate (system-app signature headers) so the suite stays
//      deterministic; the limiters themselves are exercised in the
//      dedicated 429 test with unsigned requests.
//
// The primitives (_dnsResolvePrivate/_pinnedFetch) already have focused
// coverage in proxies-pinning.test.js; this file covers the three HTTP
// surfaces plus the parts of _internal the pinning file leaves out
// (_isPrivateHost, _isPrivateIpAddr, fail-closed inputs, cache eviction).
// ─────────────────────────────────────────────────────────────────────────────

process.env.NBOSP_CRED_KEY = process.env.NBOSP_CRED_KEY || 'e'.repeat(64);
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'f'.repeat(128);
const RATE_SECRET = 'proxies-e2e-rate-limit-secret';
process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET = RATE_SECRET;

// CJS modules under test MUST come through createRequire so the express app,
// the routes and the SSRF primitives all share ONE module instance.
const require = createRequire(import.meta.url);
const proxies = require('../../server/proxies.js');
const ServerEventLog = require('../../server/core/server-event-log.js');
const dns = require('node:dns');

const { _isPrivateHost, _isPrivateIpAddr, _dnsResolvePrivate, _dnsPrivateCache } = proxies._internal;

// ── Shim 1: a faithful AbortController + relaxed undici signal check ────────
const originalAbortController = globalThis.AbortController;

class E2EAbortController {
  constructor() {
    const listeners = new Set();
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener: (type, fn) => { if (type === 'abort') listeners.add(fn); },
      removeEventListener: (_type, fn) => { listeners.delete(fn); },
      dispatchEvent: () => true,
      throwIfAborted() { if (signal.aborted) throw signal.reason; },
    };
    this.signal = signal;
    this._listeners = listeners;
  }

  abort(reason) {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason = reason ?? Object.assign(new Error('This operation was aborted.'), { name: 'AbortError' });
    // Listeners must run with the signal as `this` — undici's internal
    // abortSignalFollowers calls this.removeEventListener on it.
    for (const fn of [...this._listeners]) fn.call(this.signal, { type: 'abort' });
  }
}
globalThis.AbortController = E2EAbortController;

const undici = require('undici'); // same singleton proxies.js lazily requires
const webidlModule = Object.values(require.cache)
  .find((m) => m.filename && m.filename.endsWith('undici/lib/web/webidl/index.js'));
if (!webidlModule) throw new Error('undici webidl module not found in require cache');
const webidl = webidlModule.exports.webidl;
const originalAbortSignalConverter = webidl.converters.AbortSignal;
const originalAbortSignalIs = webidl.is.AbortSignal;
webidl.converters.AbortSignal = (v) => v;
webidl.is.AbortSignal = () => true;

// ── Locate a public-but-local IP for the real upstreams ─────────────────────
function findPublicLocalIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (!_isPrivateHost(iface.address) && !_isPrivateIpAddr(iface.address)) return iface.address;
    }
  }
  return null;
}
const PUBLIC_IP = findPublicLocalIp();
const E2E_UPSTREAMS = Boolean(PUBLIC_IP);

// ── Upstream server management ───────────────────────────────────────────────
const upstreams = [];
function startUpstream(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, PUBLIC_IP, () => {
      upstreams.push(srv);
      const port = srv.address().port;
      resolve({ srv, port, origin: `http://${PUBLIC_IP}:${port}` });
    });
  });
}
async function getClosedPort() {
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, PUBLIC_IP, r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

// ── The express app with all three proxies mounted ───────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json({ limit: '32mb' }));
  // Stand-in for express-session: requireSession only needs req.session.id.
  // The x-test-auth header selects: default → valid session, 'no-session' →
  // no session at all, 'session-no-id' → session object without an id.
  app.use((req, _res, next) => {
    const auth = req.get('x-test-auth');
    if (auth === 'no-session') return next();
    if (auth === 'session-no-id') { req.session = {}; return next(); }
    req.session = { id: 'e2e-session-id' };
    next();
  });
  proxies.setupFrameCheckProxy(app);
  proxies.setupAppNetworkProxy(app);
  proxies.setupEmailImageProxy(app);
  return app;
}
const app = buildApp();

function signed(extra = {}) {
  const timestamp = String(Date.now());
  const signature = crypto
    .createHmac('sha256', RATE_SECRET)
    .update(`${timestamp}\ne2e-suite`)
    .digest('hex');
  return {
    'x-nova-system-app': 'e2e-suite',
    'x-nova-system-time': timestamp,
    'x-nova-system-signature': signature,
    ...extra,
  };
}

const frameCheck = (url, headers = {}) =>
  request(app).get('/api/frame-check').query({ url }).set(signed(headers));
const proxyPost = (body, headers = {}) =>
  request(app).post('/api/proxy').set(signed(headers)).send(body);

const binaryParser = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const emailImage = (url, headers = {}) =>
  request(app).get('/api/email-image').query({ url }).set(signed(headers)).parse(binaryParser);

// The 1x1 transparent PNG the email proxy substitutes on any failure.
const FALLBACK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// ── DNS stub helpers ─────────────────────────────────────────────────────────
const realLookup = dns.promises.lookup;
function withLookup(stub, fn) {
  return async () => {
    dns.promises.lookup = stub;
    try {
      return await fn();
    } finally {
      dns.promises.lookup = realLookup;
      _dnsPrivateCache.clear();
    }
  };
}

// ── Shared upstream fixtures ─────────────────────────────────────────────────
// Frame-check upstream: serves HEAD and GET with independently configurable
// status + headers, and records every hit for round-trip assertions.
async function frameServer({ headStatus = 200, head = {}, getStatus = 200, get = {} } = {}) {
  const hits = [];
  const up = await startUpstream((req, res) => {
    hits.push({ method: req.method, url: req.url, headers: req.headers });
    req.resume();
    if (req.method === 'HEAD') { res.writeHead(headStatus, head); return res.end(); }
    res.writeHead(getStatus, get);
    res.end();
  });
  return { ...up, hits };
}

// App-proxy upstream that echoes method/url/headers/body as JSON.
async function echoServer() {
  const hits = [];
  const up = await startUpstream((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers });
      res.writeHead(201, 'Made It', { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        bodyHex: Buffer.concat(chunks).toString('hex'),
      }));
    });
  });
  return { ...up, hits };
}

// Redirect upstream: 3xx to the given Location (relative or absolute).
async function redirectServer(location, { status = 302 } = {}) {
  const hits = [];
  const up = await startUpstream((req, res) => {
    hits.push({ method: req.method, url: req.url });
    req.resume();
    res.writeHead(status, { location });
    res.end();
  });
  return { ...up, hits };
}

// Chain upstream: /hop/N → /hop/N+1 forever (distinct URLs, never a loop).
async function hopChainServer() {
  const hits = [];
  const up = await startUpstream((req, res) => {
    hits.push(req.url);
    const m = /\/hop\/(\d+)/.exec(req.url);
    const next = (m ? Number(m[1]) : -1) + 1;
    req.resume();
    res.writeHead(302, { location: `/hop/${next}` });
    res.end();
  });
  return { ...up, hits };
}

// ─────────────────────────────────────────────────────────────────────────────
// _internal primitives (real module — the previous version of this file
// re-implemented them and had drifted from the source's actual behavior).
// ─────────────────────────────────────────────────────────────────────────────
describe('proxies.js — _internal SSRF primitives', () => {
  describe('_isPrivateHost', () => {
    it('blocks the exact-name private set in any case/bracket form', () => {
      for (const h of ['localhost', 'LOCALHOST', 'LocalHost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']) {
        expect(_isPrivateHost(h), h).toBe(true);
      }
    });

    it('DOCUMENTED BUG: the unspecified IPv6 address is not blocked at the hostname layer', () => {
      // server/proxies.js strips brackets BEFORE consulting _PRIVATE_EXACT, but
      // the set only contains the bracketed forms '[::1]' and '[::]'. '::1'
      // survives via the unbracketed '::1' entry, but '::' itself is not in
      // the set, so _isPrivateHost('::') and _isPrivateHost('[::]') are false.
      // (The DNS/IP layer still catches http://[::]/ — see the app-proxy tests.)
      expect(_isPrivateHost('::')).toBe(false);
      expect(_isPrivateHost('[::]')).toBe(false);
    });

    it('blocks RFC1918/loopback/link-local/CGNAT prefixes', () => {
      for (const h of ['10.0.0.1', '10.255.255.255', '127.0.0.1', '127.8.8.8',
        '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.99.99',
        '169.254.169.254', '100.64.0.1']) {
        expect(_isPrivateHost(h), h).toBe(true);
      }
    });

    it('DOCUMENTED GAP: 0.0.0.0/8 hostnames other than the literal 0.0.0.0 pass the hostname check', () => {
      // _PRIVATE_PREFIXES has no '0.' entry; 0.x addresses are only rejected
      // later by the IP-level check (_isPrivateIpAddr) after DNS resolution.
      expect(_isPrivateHost('0.1.2.3')).toBe(false);
      expect(_isPrivateHost('0.0.0.0')).toBe(true);
    });

    it('DOCUMENTED GAP: CGNAT hostnames beyond the 100.64. prefix pass the hostname check', () => {
      // _PRIVATE_PREFIXES only contains '100.64.'; the rest of the shared
      // address range 100.64.0.0/10 is enforced by the IP-level check after
      // DNS resolution (see _isPrivateIpAddr tests).
      expect(_isPrivateHost('100.64.0.1')).toBe(true);
      expect(_isPrivateHost('100.65.0.1')).toBe(false);
      expect(_isPrivateHost('100.127.255.255')).toBe(false);
      expect(_isPrivateIpAddr('100.127.255.255')).toBe(true); // caught one layer later
    });

    it('respects range boundaries (172.15/172.32/100.63/100.128/192.169 are public)', () => {
      for (const h of ['172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '192.169.0.1', '172.160.0.1']) {
        expect(_isPrivateHost(h), h).toBe(false);
      }
    });

    it('blocks .local and .internal suffixes only at the end of the name', () => {
      expect(_isPrivateHost('printer.local')).toBe(true);
      expect(_isPrivateHost('db.PRIVATE.INTERNAL')).toBe(true);
      expect(_isPrivateHost('internal.company.com')).toBe(false);
      expect(_isPrivateHost('localhost.com')).toBe(false);
    });

    it('allows public hostnames and public IPs', () => {
      expect(_isPrivateHost('example.com')).toBe(false);
      expect(_isPrivateHost('8.8.8.8')).toBe(false);
      expect(_isPrivateHost('')).toBe(false);
    });
  });

  describe('_isPrivateIpAddr — IPv4', () => {
    it('detects every guarded v4 range', () => {
      for (const ip of ['10.0.0.1', '127.0.0.1', '127.255.255.255', '0.0.0.0', '0.10.0.1',
        '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '169.254.169.254',
        '100.64.0.1', '100.127.0.1']) {
        expect(_isPrivateIpAddr(ip), ip).toBe(true);
      }
    });

    it('allows public v4 addresses and rejects boundary-adjacent ones', () => {
      for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1',
        '192.169.1.1', '100.63.0.1', '100.128.0.1', '169.255.0.1']) {
        expect(_isPrivateIpAddr(ip), ip).toBe(false);
      }
    });

    it('rejects malformed octets as non-private (not an IP at all)', () => {
      expect(_isPrivateIpAddr('999.1.1.1')).toBe(false);
      expect(_isPrivateIpAddr('not-an-ip')).toBe(false);
      expect(_isPrivateIpAddr('10.0.0.256')).toBe(false);
    });

    it('fails closed on missing values (null/undefined/empty string are private)', () => {
      expect(_isPrivateIpAddr(null)).toBe(true);
      expect(_isPrivateIpAddr(undefined)).toBe(true);
      expect(_isPrivateIpAddr('')).toBe(true);
    });
  });

  describe('_isPrivateIpAddr — IPv6', () => {
    it('blocks loopback, unspecified, ULA, link-local and mapped-private', () => {
      for (const ip of ['::1', '::', '[::1]', '[::]',
        'fc00::1', 'fd12:3456:789a::1', 'FC00::1',
        'fe80::1', 'fe8f::a', 'febf::1', 'FE80::abcd',
        '::ffff:10.0.0.1', '::ffff:127.0.0.1', '[::ffff:192.168.0.1]']) {
        expect(_isPrivateIpAddr(ip), ip).toBe(true);
      }
    });

    it('allows public v6 and mapped-public addresses', () => {
      for (const ip of ['2606:4700::6810:84e5', '2001:db8::1', '::ffff:8.8.8.8', 'fe7f::1', 'fd00::1'.replace('fd', '2d')]) {
        expect(_isPrivateIpAddr(ip), ip).toBe(false);
      }
    });
  });

  describe('_dnsResolvePrivate — fail-closed inputs', () => {
    it('returns a fail-closed result for non-string/empty hostnames', async () => {
      for (const host of [null, undefined, '', 123, {}]) {
        const d = await _dnsResolvePrivate(host);
        expect(d.private, String(host)).toBe(true);
        expect(d.address).toBeNull();
        expect(d.addresses).toEqual([]);
      }
    });

    it('short-circuits private hostnames without hitting DNS', withLookup(
      vi.fn(async () => { throw new Error('lookup must not be called'); }),
      async () => {
        const d = await _dnsResolvePrivate('localhost');
        expect(d.private).toBe(true);
        expect(d.addresses).toEqual([]);
        expect(dns.promises.lookup).not.toHaveBeenCalled();
      }
    ));

    it('fails closed when DNS rejects (ENOTFOUND)', withLookup(
      vi.fn(async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); }),
      async () => {
        const d = await _dnsResolvePrivate('missing.example');
        expect(d.private).toBe(true);
        expect(d.addresses).toEqual([]);
      }
    ));

    it('fails closed when DNS returns an empty address list', withLookup(
      vi.fn(async () => []),
      async () => {
        const d = await _dnsResolvePrivate('empty.example');
        expect(d.private).toBe(true);
        expect(d.addresses).toEqual([]);
      }
    ));

    it('evicts the oldest entry when the cache exceeds 500 hosts', withLookup(
      vi.fn(async (hostname) => [{ address: '93.184.216.34', family: 4 }].slice(0, hostname ? 1 : 0)),
      async () => {
        _dnsPrivateCache.clear();
        for (let i = 0; i < 501; i++) {
          await _dnsResolvePrivate(`evict-${i}.example`);
        }
        expect(_dnsPrivateCache.size).toBeLessThanOrEqual(500);
        // The first host was evicted, so re-resolving it must hit DNS again.
        const callsBefore = dns.promises.lookup.mock.calls.length;
        await _dnsResolvePrivate('evict-0.example');
        expect(dns.promises.lookup.mock.calls.length).toBeGreaterThan(callsBefore);
      }
    ));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// e2e: /api/frame-check
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!E2E_UPSTREAMS)('proxies.js — e2e: frame-check proxy (GET /api/frame-check)', () => {
  beforeAll(async () => {
    // Fail loudly if the local public IP is somehow not usable this run.
    const probe = await startUpstream((_req, res) => res.end('ok'));
    await new Promise((resolve, reject) => {
      const req = http.get(`${probe.origin}/`, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
    });
  });

  describe('input validation and auth', () => {
    it('requires a session (401 without one)', async () => {
      const res = await frameCheck('http://example.com/', { 'x-test-auth': 'no-session' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized — session required');
    });

    it('requires a session id (401 when session has no id)', async () => {
      const res = await frameCheck('http://example.com/', { 'x-test-auth': 'session-no-id' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized — session required');
    });

    it('rejects a missing url parameter (400)', async () => {
      const res = await request(app).get('/api/frame-check').set(signed());
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'url parameter is required' });
    });

    it('rejects an empty url parameter (400)', async () => {
      const res = await request(app).get('/api/frame-check').query({ url: '' }).set(signed());
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'url parameter is required' });
    });

    it('rejects an array-valued url parameter (400)', async () => {
      const res = await request(app).get('/api/frame-check').query({ url: ['a', 'b'] }).set(signed());
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'url parameter is required' });
    });

    it('rejects a malformed URL (400)', async () => {
      const res = await frameCheck('not a valid url at all');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid URL' });
    });

    for (const scheme of ['ftp', 'file', 'gopher', 'javascript']) {
      it(`rejects the ${scheme}: scheme (400)`, async () => {
        const res = await frameCheck(`${scheme}://example.com/x`);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Only http and https URLs are supported' });
      });
    }
  });

  describe('SSRF rejection before probing', () => {
    for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.5.5', '172.20.9.9',
      '169.254.169.254', '100.64.1.1', '0.0.0.0', '[::1]', 'intranet.internal', 'nas.local']) {
      it(`rejects private target ${host} (400)`, async () => {
        const res = await frameCheck(`http://${host}/x`);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Internal URLs are not permitted' });
      });
    }

    it('rejects a hostname that DNS-resolves to a private IP (400)', withLookup(
      vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]),
      async () => {
        const res = await frameCheck('http://rebind-frame.e2e.test/img');
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Internal URLs are not permitted' });
      }
    ));

    it('fails closed when DNS cannot resolve the hostname (400)', withLookup(
      vi.fn(async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); }),
      async () => {
        const res = await frameCheck('http://no-such-host-frame.e2e.test/img');
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Internal URLs are not permitted' });
      }
    ));
  });

  describe('HEAD fast path and X-Frame-Options evaluation', () => {
    it('reports embeddable for a 2xx HEAD without security headers, without a GET fallback', async () => {
      const up = await frameServer({ head: { 'content-type': 'text/html' } });
      const res = await frameCheck(up.origin + '/page');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ embeddable: true });
      expect(res.headers['cache-control']).toBe('private, max-age=300');
      expect(up.hits).toHaveLength(1);
      expect(up.hits[0].method).toBe('HEAD');
      // The probe identifies itself with a fixed UA — assert the upstream saw it.
      expect(up.hits[0].headers['user-agent']).toBe('Mozilla/5.0 (compatible; NovaByte/1.0)');
    });

    it('reports blocked for X-Frame-Options: DENY (HEAD only, no GET fallback)', async () => {
      const up = await frameServer({ head: { 'x-frame-options': 'DENY' } });
      const res = await frameCheck(up.origin + '/');
      expect(res.body).toEqual({ embeddable: false });
      expect(up.hits).toHaveLength(1);
    });

    it('reports blocked for X-Frame-Options: SAMEORIGIN', async () => {
      const up = await frameServer({ head: { 'x-frame-options': 'sameorigin' } });
      const res = await frameCheck(up.origin + '/');
      expect(res.body).toEqual({ embeddable: false });
    });

    it('reports blocked for legacy X-Frame-Options: ALLOW-FROM ...', async () => {
      const up = await frameServer({ head: { 'x-frame-options': 'allow-from http://allowed.example' } });
      const res = await frameCheck(up.origin + '/');
      expect(res.body).toEqual({ embeddable: false });
    });

    it('treats an unrecognized X-Frame-Options value as not blocking', async () => {
      const up = await frameServer({ head: { 'x-frame-options': 'ALLOWALL' } });
      const res = await frameCheck(up.origin + '/');
      expect(res.body).toEqual({ embeddable: true });
    });

    it('accepts https URLs (TLS failure on a plain server still fails open to embeddable)', async () => {
      const up = await frameServer({ head: { 'x-frame-options': 'DENY' } });
      const res = await frameCheck(up.origin.replace('http://', 'https://') + '/');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ embeddable: true });
    });
  });

  describe('CSP frame-ancestors evaluation (via HEAD when present)', () => {
    const cspHead = (policy) => frameServer({ head: { 'content-security-policy': policy } });

    it("blocks on frame-ancestors 'none'", async () => {
      const up = await cspHead("frame-ancestors 'none'");
      expect((await frameCheck(up.origin + '/')).body).toEqual({ embeddable: false });
    });

    it('blocks on FRAME-ANCESTORS NONE regardless of case', async () => {
      const up = await cspHead('FRAME-ANCESTORS NONE');
      expect((await frameCheck(up.origin + '/')).body).toEqual({ embeddable: false });
    });

    it("allows on frame-ancestors *", async () => {
      const up = await cspHead('frame-ancestors *');
      expect((await frameCheck(up.origin + '/')).body).toEqual({ embeddable: true });
    });

    it("allows on frame-ancestors 'self' (quoted and unquoted)", async () => {
      const a = await cspHead("frame-ancestors 'self'");
      expect((await frameCheck(a.origin + '/')).body).toEqual({ embeddable: true });
      const b = await cspHead('frame-ancestors self');
      expect((await frameCheck(b.origin + '/')).body).toEqual({ embeddable: true });
    });

    it('allows when a bare host:port source equals the embedded origin', async () => {
      const up = await startUpstream((req, res) => {
        res.writeHead(200, { 'content-security-policy': `frame-ancestors ${req.headers.host}` });
        res.end();
      });
      expect((await frameCheck(up.origin + '/')).body).toEqual({ embeddable: true });
    });

    it('allows when a scheme://host:port source matches the origin', async () => {
      const up = await startUpstream((req, res) => {
        res.writeHead(200, { 'content-security-policy': `frame-ancestors http://${req.headers.host}` });
        res.end();
      });
      expect((await frameCheck(up.origin + '/')).body).toEqual({ embeddable: true });
    });

    it('allows when a wildcard *.suffix source matches the origin suffix', async () => {
      const up = await startUpstream((req, res) => {
        // e.g. embed origin http://21.0.9.78:45395 against source *.9.78:45395
        const parts = req.headers.host.split(':');
        const ipParts = parts[0].split('.');
        const suffix = `.${ipParts.slice(2).join('.')}:${parts[1]}`;
        res.writeHead(200, { 'content-security-policy': `frame-ancestors *${suffix}` });
        res.end();
      });
      expect((await frameCheck(up.origin + '/')).body).toEqual({ embeddable: true });
    });

    it('blocks when the frame-ancestors list does not contain the origin', async () => {
      const up = await cspHead("frame-ancestors 'none' evil.example");
      expect((await frameCheck(up.origin + '/')).body).toEqual({ embeddable: false });
      const up2 = await cspHead('frame-ancestors *.example.com');
      expect((await frameCheck(up2.origin + '/')).body).toEqual({ embeddable: false });
    });

    it('allows if ANY of multiple frame-ancestors directives permits', async () => {
      const up = await cspHead("frame-ancestors 'none'; frame-ancestors *");
      expect((await frameCheck(up.origin + '/')).body).toEqual({ embeddable: true });
    });

    it('ignores CSP that has no frame-ancestors directive (HEAD fast path)', async () => {
      const up = await cspHead("default-src 'self'; img-src *");
      const res = await frameCheck(up.origin + '/');
      expect(res.body).toEqual({ embeddable: true });
      expect(up.hits).toHaveLength(1); // no GET fallback: no security header seen
    });

    it('skips non-frame-ancestors directives before a matching one', async () => {
      // the default-src directive takes the continue arm at the top of the scan
      const up = await cspHead("default-src 'self'; img-src *; frame-ancestors 'self'");
      expect((await frameCheck(up.origin + '/')).body).toEqual({ embeddable: true });
    });

    it('skips a source that cannot match the host grammar (regex miss arm)', async () => {
      // '/nopath' never matches ^([\w-]+://)?([^/]+) → the !m continue arm;
      // nothing else matches either, so the directive still blocks.
      const up = await cspHead("frame-ancestors 'none' /nopath");
      expect((await frameCheck(up.origin + '/')).body).toEqual({ embeddable: false });
    });
  });

  describe('GET fallback when HEAD is unusable', () => {
    it('falls back to GET when HEAD returns 405 and evaluates the GET response', async () => {
      const up = await frameServer({
        headStatus: 405,
        get: { 'x-frame-options': 'DENY' },
      });
      const res = await frameCheck(up.origin + '/');
      expect(res.body).toEqual({ embeddable: false });
      expect(up.hits.map((h) => h.method)).toEqual(['HEAD', 'GET']);
    });

    it('falls back to GET when HEAD returns 400', async () => {
      const up = await frameServer({ headStatus: 400, get: { 'x-frame-options': 'SAMEORIGIN' } });
      const res = await frameCheck(up.origin + '/');
      expect(res.body).toEqual({ embeddable: false });
      expect(up.hits).toHaveLength(2);
    });

    it('falls back to GET when HEAD returns 404 (not ok)', async () => {
      const up = await frameServer({ headStatus: 404, get: { 'content-type': 'text/html' } });
      const res = await frameCheck(up.origin + '/');
      expect(res.body).toEqual({ embeddable: true });
      expect(up.hits.map((h) => h.method)).toEqual(['HEAD', 'GET']);
    });

    it('falls back to GET when HEAD returns 500', async () => {
      const up = await frameServer({ headStatus: 500, get: { 'x-frame-options': 'DENY' } });
      const res = await frameCheck(up.origin + '/');
      expect(res.body).toEqual({ embeddable: false });
    });

    it('honors frame-ancestors from Content-Security-Policy-Report-Only on the GET fallback', async () => {
      const up = await frameServer({
        headStatus: 404,
        get: { 'content-security-policy-report-only': "frame-ancestors 'none'" },
      });
      const res = await frameCheck(up.origin + '/');
      expect(res.body).toEqual({ embeddable: false });
      expect(up.hits).toHaveLength(2);
    });

    it('does not treat a CSP without frame-ancestors as blocking (GET fallback path)', async () => {
      const up = await frameServer({ headStatus: 501, get: { 'content-security-policy': "default-src 'self'" } });
      const res = await frameCheck(up.origin + '/');
      expect(res.body).toEqual({ embeddable: true });
    });
  });

  describe('redirect handling during the probe', () => {
    it('follows a redirect to a public target and evaluates its headers', async () => {
      const target = await frameServer({ head: { 'x-frame-options': 'DENY' } });
      const redirector = await redirectServer(target.origin + '/landing');
      const res = await frameCheck(redirector.origin + '/start');
      expect(res.body).toEqual({ embeddable: false });
      expect(redirector.hits).toHaveLength(1);
      expect(target.hits).toHaveLength(1); // the redirect was really followed
    });

    it('resolves relative redirect targets against the current URL', async () => {
      const up = await startUpstream((req, res) => {
        req.resume();
        if (req.url === '/start') {
          res.writeHead(302, { location: '/landing' });
          return res.end();
        }
        res.writeHead(200, { 'x-frame-options': 'SAMEORIGIN' });
        res.end();
      });
      const res = await frameCheck(up.origin + '/start');
      expect(res.body).toEqual({ embeddable: false });
    });

    it('fails open (embeddable) on a redirect loop', async () => {
      const up = await startUpstream((req, res) => {
        req.resume();
        res.writeHead(302, { location: '/self' });
        res.end();
      });
      const res = await frameCheck(up.origin + '/self');
      expect(res.body).toEqual({ embeddable: true });
    });

    it('fails open on a 3xx without a Location header', async () => {
      const up = await startUpstream((req, res) => { req.resume(); res.writeHead(302); res.end(); });
      const res = await frameCheck(up.origin + '/');
      expect(res.body).toEqual({ embeddable: true });
    });

    it('fails open on an invalid redirect target', async () => {
      const up = await redirectServer('http://');
      const res = await frameCheck(up.origin + '/');
      expect(res.body).toEqual({ embeddable: true });
    });

    it('fails open when the redirect target uses a non-http protocol', async () => {
      const up = await redirectServer('ftp://example.com/x');
      const res = await frameCheck(up.origin + '/');
      expect(res.body).toEqual({ embeddable: true });
    });

    it('fails open when the redirect targets a private host (SSRF blocked mid-probe)', async () => {
      const up = await redirectServer('http://169.254.169.254/latest/meta-data/');
      const res = await frameCheck(up.origin + '/');
      expect(res.body).toEqual({ embeddable: true });
    });

    it('fails open when the redirect target DNS-resolves to a private IP', withLookup(
      vi.fn(async () => [{ address: '10.0.0.9', family: 4 }]),
      async () => {
        const up = await redirectServer('http://rebind-redirect-frame.e2e.test/x');
        const res = await frameCheck(up.origin + '/');
        expect(res.body).toEqual({ embeddable: true });
      }
    ));

    it('fails open after too many redirects (more than 5 hops)', async () => {
      const up = await hopChainServer();
      const res = await frameCheck(up.origin + '/hop/0');
      expect(res.body).toEqual({ embeddable: true });
      expect(up.hits.length).toBeGreaterThanOrEqual(6); // really chased the chain
    });
  });

  describe('probe failure handling', () => {
    it('fails open (embeddable) when the target is unreachable', async () => {
      const port = await getClosedPort();
      const res = await frameCheck(`http://${PUBLIC_IP}:${port}/x`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ embeddable: true });
    });

    it('fails open (embeddable) when the target never responds within 5s', { timeout: 15000 }, async () => {
      const up = await startUpstream(() => { /* accept the connection, never respond */ });
      const res = await frameCheck(up.origin + '/hang');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ embeddable: true });
    });
  });

  describe('result caching', () => {
    it('caches the verdict per origin and marks subsequent responses as cached', async () => {
      const up = await frameServer({ head: { 'x-frame-options': 'DENY' } });
      const first = await frameCheck(up.origin + '/one');
      expect(first.body).toEqual({ embeddable: false });
      expect(first.body.cached).toBeUndefined();
      const second = await frameCheck(up.origin + '/different-path-same-origin');
      expect(second.body).toEqual({ embeddable: false, cached: true });
      expect(up.hits).toHaveLength(1); // upstream was probed only once
    });

    it('serves different origins independently (cache key includes the port)', async () => {
      const a = await frameServer({ head: { 'x-frame-options': 'DENY' } });
      const b = await frameServer({ head: {} });
      expect((await frameCheck(a.origin + '/')).body).toEqual({ embeddable: false });
      expect((await frameCheck(b.origin + '/')).body).toEqual({ embeddable: true });
    });

    it('evicts the oldest cache entry once 500 origins are stored', { timeout: 60000 }, withLookup(
      vi.fn(async (hostname) => [{ address: PUBLIC_IP, family: 4 }]),
      async () => {
        const up = await frameServer({ head: {} });
        // Prime the cache with far more than FRAME_CHECK_MAX distinct origins;
        // every probe really round-trips to the upstream via the pinned agent.
        for (let i = 0; i < 505; i++) {
          const res = await request(app)
            .get('/api/frame-check')
            .query({ url: `http://evict-${i}.frame-e2e.test:${up.port}/` })
            .set(signed());
          expect(res.status).toBe(200);
          expect(res.body.embeddable).toBe(true);
        }
        expect(up.hits.length).toBeGreaterThanOrEqual(505);
        // The first primed origin must have been evicted (oldest entry) and
        // therefore re-probed instead of served from cache.
        const again = await request(app)
          .get('/api/frame-check')
          .query({ url: `http://evict-0.frame-e2e.test:${up.port}/` })
          .set(signed());
        expect(again.body.cached).toBeUndefined();
        const hitsForFirst = up.hits.filter((h) => h.headers.host === `evict-0.frame-e2e.test:${up.port}`).length;
        expect(hitsForFirst).toBe(2);
      }
    ));
  });

  describe('rate limiting', () => {
    it('returns 429 once the per-IP frame-check budget is exhausted (unsigned requests)', { timeout: 30000 }, async () => {
      let sawLimit = null;
      // The frame-check limiter allows 60 requests/minute from 127.0.0.1;
      // signed (trusted system-app) requests are skipped and never counted,
      // so the counter starts fresh for this test's unsigned burst.
      for (let i = 0; i < 70; i++) {
        const res = await request(app).get('/api/frame-check').query({ url: 'not-a-url' });
        if (res.status === 429) { sawLimit = res; break; }
        expect(res.status).toBe(400); // validation error while under the limit
      }
      expect(sawLimit, 'expected to hit the limiter within 70 unsigned requests').not.toBeNull();
      expect(sawLimit.body).toEqual({ error: 'Too many frame-check requests, slow down.' });
      // A signed request is exempt even while the unsigned budget is spent.
      const signedRes = await frameCheck('not-a-url-either');
      expect(signedRes.status).toBe(400);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// e2e: /api/proxy
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!E2E_UPSTREAMS)('proxies.js — e2e: app network proxy (POST /api/proxy)', () => {
  describe('input validation and auth', () => {
    it('requires a session (401 without one)', async () => {
      const res = await proxyPost({ url: `http://${PUBLIC_IP}:1/` }, { 'x-test-auth': 'no-session' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized — session required');
    });

    it('requires a session id (401 when session has no id)', async () => {
      const res = await proxyPost({ url: `http://${PUBLIC_IP}:1/` }, { 'x-test-auth': 'session-no-id' });
      expect(res.status).toBe(401);
    });

    it('rejects a missing url (400)', async () => {
      const res = await proxyPost({});
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'url is required' });
    });

    it('rejects a non-string url (400)', async () => {
      const res = await proxyPost({ url: 12345 });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'url is required' });
    });

    it('rejects a malformed URL (400)', async () => {
      const res = await proxyPost({ url: '::::not a url' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid URL' });
    });

    for (const scheme of ['ftp', 'file', 'gopher']) {
      it(`rejects the ${scheme}: scheme (400)`, async () => {
        const res = await proxyPost({ url: `${scheme}://${PUBLIC_IP}/x` });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Only http and https URLs are supported' });
      });
    }
  });

  describe('SSRF rejection', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.10.20.30', '10.0.0.5',
      '172.16.0.9', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
      '0.0.0.0', '[::1]', 'service.internal', 'printer.local']) {
      it(`blocks private host ${host} (403) and logs it`, async () => {
        const before = ServerEventLog.getAll().length;
        const res = await proxyPost({ url: `http://${host}/fetch` });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'Internal URLs are not permitted' });
        const logged = ServerEventLog.getAll().slice(before)
          .filter((l) => l.app === 'AppNetworkProxy' && l.data && l.data.hostname === host.toLowerCase());
        expect(logged).toHaveLength(1);
        expect(logged[0].data.reason).toBe('private_host');
        expect(logged[0].severity).toBe('warn');
      });
    }

    it('DOCUMENTED BUG: http://[::]/ skips the hostname check but is still blocked by the DNS/IP layer (403)', async () => {
      // '[::]' is not in the effective private-host set (see the _isPrivateHost
      // bug test), so the request proceeds to DNS resolution, which returns the
      // unspecified address '::' — private per _isPrivateIpAddr. Layered defense
      // holds, but the log records reason 'dns_private' instead of 'private_host'.
      const before = ServerEventLog.getAll().length;
      const res = await proxyPost({ url: 'http://[::]/fetch' });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Internal URLs are not permitted' });
      const logged = ServerEventLog.getAll().slice(before)
        .filter((l) => l.app === 'AppNetworkProxy' && l.data);
      expect(logged).toHaveLength(1);
      expect(logged[0].data.reason).toBe('dns_private');
    });

    it('blocks a hostname that DNS-resolves to a private IP (403) and logs it', withLookup(
      vi.fn(async () => [{ address: '192.168.1.50', family: 4 }]),
      async () => {
        const before = ServerEventLog.getAll().length;
        const res = await proxyPost({ url: 'http://rebind-app.e2e.test/data' });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'Internal URLs are not permitted' });
        const logged = ServerEventLog.getAll().slice(before)
          .filter((l) => l.app === 'AppNetworkProxy' && l.data && l.data.reason === 'dns_private');
        expect(logged).toHaveLength(1);
      }
    ));

    it('fails closed (403) when DNS cannot resolve the hostname', withLookup(
      vi.fn(async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); }),
      async () => {
        const res = await proxyPost({ url: 'http://gone-app.e2e.test/data' });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'Internal URLs are not permitted' });
      }
    ));
  });

  describe('method handling', () => {
    it('defaults to GET when no method is supplied', async () => {
      const up = await echoServer();
      const res = await proxyPost({ url: up.origin + '/default?qp=1' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(201);
      expect(res.body.statusText).toBe('Made It');
      const echoed = JSON.parse(res.body.body);
      expect(echoed.method).toBe('GET');
      expect(echoed.url).toBe('/default?qp=1');
      expect(res.body.bodyEncoding).toBe('utf8');
      expect(res.body.headers['content-type']).toContain('application/json');
    });

    it('uppercases the method (lowercase "post" reaches the upstream as POST)', async () => {
      const up = await echoServer();
      const res = await proxyPost({ url: up.origin + '/x', method: 'post', body: 'payload-1' });
      const echoed = JSON.parse(res.body.body);
      expect(echoed.method).toBe('POST');
      expect(Buffer.from(echoed.bodyHex, 'hex').toString()).toBe('payload-1');
    });

    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      it(`forwards ${method} requests with their body`, async () => {
        const up = await echoServer();
        const res = await proxyPost({ url: up.origin + '/m', method, body: `${method.toLowerCase()}-body` });
        expect(res.status).toBe(200);
        const echoed = JSON.parse(res.body.body);
        expect(echoed.method).toBe(method);
        expect(Buffer.from(echoed.bodyHex, 'hex').toString()).toBe(`${method.toLowerCase()}-body`);
      });
    }

    it('never forwards a body for GET even when one is supplied', async () => {
      const up = await echoServer();
      const res = await proxyPost({ url: up.origin + '/no-body', method: 'GET', body: 'SHOULD-NOT-FORWARD' });
      const echoed = JSON.parse(res.body.body);
      expect(echoed.method).toBe('GET');
      expect(echoed.bodyHex).toBe('');
    });

    for (const method of ['CONNECT', 'TRACE', 'PURGE']) {
      it(`rejects the ${method} method (400)`, async () => {
        const res = await proxyPost({ url: `http://${PUBLIC_IP}:1/`, method });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: `Method not allowed: ${method}` });
      });
    }

    it('DOCUMENTED BUG: HEAD is allowlisted but the response read crashes into a 502 "Read error"', async () => {
      // server/proxies.js line ~612 calls resp.body.getReader() unguarded.
      // undici Responses to HEAD requests have body === null, so every HEAD
      // through the proxy fails with 502 Read error instead of returning the
      // (empty) body. Reported; asserted here as current behavior.
      const up = await echoServer();
      const res = await proxyPost({ url: up.origin + '/head', method: 'HEAD' });
      expect(res.status).toBe(502);
      expect(res.body.error.startsWith('Read error:')).toBe(true);
      expect(up.hits.map((h) => h.method)).toEqual(['HEAD']);
    });
  });

  describe('request body and encoding handling', () => {
    it('rejects a non-string body (400)', async () => {
      const res = await proxyPost({ url: `http://${PUBLIC_IP}:1/`, body: { not: 'a string' } });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'body must be a string' });
    });

    it('treats a request without any body as an empty one (req.body ?? {} arm)', async () => {
      const res = await request(app).post('/api/proxy').set(signed());
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'url is required' });
    });

    it('reports code:null for network errors carrying neither code nor cause (502)', async () => {
      // proxies.js reads undici through property access at call time, so a
      // direct swap is visible to it (same technique as the pinning suite).
      const undici = require('undici');
      const realFetch = undici.fetch;
      undici.fetch = async () => { throw new Error('plain failure'); };
      try {
        const res = await proxyPost({ url: `http://${PUBLIC_IP}:1/`, body: 'x' });
        expect(res.status).toBe(502);
        expect(res.body).toEqual({ error: 'Network error: plain failure', code: null });
      } finally {
        undici.fetch = realFetch;
      }
    });

    it('rejects invalid base64 bodies (400)', async () => {
      const res = await proxyPost({ url: `http://${PUBLIC_IP}:1/`, body: 'this is ** not base64 !!', bodyEncoding: 'base64' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid base64 request body' });
    });

    it('rejects unsupported body encodings (400)', async () => {
      const res = await proxyPost({ url: `http://${PUBLIC_IP}:1/`, body: 'x', bodyEncoding: 'latin1' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Unsupported request body encoding' });
    });

    it('DOCUMENTED BUG: large valid base64 bodies crash the validation regex (500) before the 413 check can run', async () => {
      // server/proxies.js validates the base64 body with a backtracking regex
      // (line ~494) BEFORE the >6 MB size check (line ~498). V8 overflows its
      // stack on the regex for base64 strings beyond roughly 3-5 MB of source
      // bytes, so a body large enough to trigger the intended 413 path always
      // throws RangeError: Maximum call stack size exceeded first, which the
      // express default error handler turns into a 500. The 'Request body too
      // large' (413) branch is therefore unreachable over real HTTP.
      const big = Buffer.alloc(6 * 1024 * 1024 + 128, 65).toString('base64');
      const res = await proxyPost({ url: `http://${PUBLIC_IP}:1/`, body: big, bodyEncoding: 'base64' });
      expect(res.status).toBe(500);
    });

    it('decodes valid base64 bodies and forwards the exact bytes', async () => {
      const up = await echoServer();
      const payload = Buffer.from('binary \x00\x01\x02 payload', 'binary');
      const res = await proxyPost({
        url: up.origin + '/bin',
        method: 'PUT',
        body: payload.toString('base64'),
        bodyEncoding: 'base64',
      });
      const echoed = JSON.parse(res.body.body);
      expect(Buffer.from(echoed.bodyHex, 'hex').equals(payload)).toBe(true);
    });
  });

  describe('request header forwarding', () => {
    it('strips hop-by-hop headers from the forwarded set (transport adds its own connection header)', async () => {
      const up = await echoServer();
      const res = await proxyPost({
        url: up.origin + '/hdrs',
        method: 'POST',
        body: 'x',
        headers: {
          'X-Custom-Forward': 'custom-value-123',
          'X-Another': 'keep-me',
          Host: 'evil.example',
          Connection: 'close',
          'Keep-Alive': 'timeout=5',
          'Proxy-Authenticate': 'Basic realm=x',
          'Proxy-Authorization': 'Bearer secret',
          TE: 'trailers',
          'Transfer-Encoding': 'chunked',
          Trailer: 'X-Foo',
          Upgrade: 'websocket',
        },
      });
      const echoed = JSON.parse(res.body.body);
      expect(echoed.headers['x-custom-forward']).toBe('custom-value-123');
      expect(echoed.headers['x-another']).toBe('keep-me');
      expect(echoed.headers.host).toBe(`${PUBLIC_IP}:${up.port}`); // caller-supplied Host never forwarded
      // These are stripped by the proxy and not re-added by the transport:
      for (const stripped of ['proxy-authenticate', 'proxy-authorization', 'te', 'transfer-encoding', 'upgrade']) {
        expect(echoed.headers[stripped], stripped).toBeUndefined();
      }
      // 'connection' is stripped from the forwarded set, but undici adds its
      // own keep-alive connection header — assert OUR value was not forwarded.
      expect(echoed.headers.connection).not.toBe('close');
      expect(echoed.headers['keep-alive']).not.toBe('timeout=5');
      // NOTE: the hop-by-hop set contains 'trailers' (plural) but not 'trailer',
      // so a Trailer header IS forwarded as-is:
      expect(echoed.headers.trailer).toBe('X-Foo');
    });

    it('ignores a non-object headers value (no headers forwarded)', async () => {
      const up = await echoServer();
      const res = await proxyPost({ url: up.origin + '/h', headers: 'not-an-object' });
      const echoed = JSON.parse(res.body.body);
      expect(echoed.headers['x-custom-forward']).toBeUndefined();
      expect(echoed.headers.host).toBe(`${PUBLIC_IP}:${up.port}`);
    });
  });

  describe('response mapping', () => {
    it('returns status, statusText, safe headers and a utf8 body for textual content', async () => {
      const up = await startUpstream((req, res) => {
        req.resume();
        res.writeHead(207, 'Multi-Status', {
          'content-type': 'text/plain; charset=utf-8',
          'content-language': 'en',
          'cache-control': 'max-age=60',
          etag: '"etag-1"',
          'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
          'x-request-id': 'req-42',
          'set-cookie': 'session=secret; Path=/',
          server: 'upstream-server/9',
          'x-unsafe': 'stripped',
        });
        res.end('plain text body');
      });
      const res = await proxyPost({ url: up.origin + '/text' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(207);
      expect(res.body.statusText).toBe('Multi-Status');
      expect(res.body.bodyEncoding).toBe('utf8');
      expect(res.body.body).toBe('plain text body');
      expect(res.body.headers).toEqual({
        'content-type': 'text/plain; charset=utf-8',
        'content-language': 'en',
        'cache-control': 'max-age=60',
        etag: '"etag-1"',
        'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
        'x-request-id': 'req-42',
      });
    });

    const textual = [
      'text/plain',
      'text/html',
      'application/json',
      'application/javascript',
      'application/xml',
      'application/x-www-form-urlencoded',
      'application/vnd.api+json',
      'application/atom+xml',
    ];
    for (const ct of textual) {
      it(`returns a utf8 body for ${ct}`, async () => {
        const up = await startUpstream((req, res) => {
          req.resume();
          res.writeHead(200, { 'content-type': ct });
          res.end('textual-content');
        });
        const res = await proxyPost({ url: up.origin + '/ct' });
        expect(res.body.bodyEncoding).toBe('utf8');
        expect(res.body.body).toBe('textual-content');
      });
    }

    it('returns a base64 body for binary content types', async () => {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
      const up = await startUpstream((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(bytes);
      });
      const res = await proxyPost({ url: up.origin + '/png' });
      expect(res.body.bodyEncoding).toBe('base64');
      expect(Buffer.from(res.body.body, 'base64').equals(bytes)).toBe(true);
    });

    it('treats a missing content-type as binary (base64)', async () => {
      const up = await startUpstream((req, res) => { req.resume(); res.writeHead(200); res.end('opaque'); });
      const res = await proxyPost({ url: up.origin + '/nomime' });
      expect(res.body.bodyEncoding).toBe('base64');
      expect(Buffer.from(res.body.body, 'base64').toString()).toBe('opaque');
    });

    it('passes upstream error statuses through inside the JSON envelope (proxy stays 200)', async () => {
      const up = await startUpstream((req, res) => {
        req.resume();
        res.writeHead(404, 'Not Found', { 'content-type': 'application/json' });
        res.end('{"missing":true}');
      });
      const res = await proxyPost({ url: up.origin + '/gone' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(404);
      expect(res.body.statusText).toBe('Not Found');
      expect(JSON.parse(res.body.body)).toEqual({ missing: true });
    });
  });

  describe('redirect handling', () => {
    it('follows redirects (relative Location) preserving method and body', async () => {
      const first = await startUpstream((req, res) => {
        if (req.url === '/start') {
          req.resume();
          res.writeHead(302, { location: '/landing' });
          return res.end();
        }
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(201, 'Made It', { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            method: req.method,
            url: req.url,
            headers: req.headers,
            bodyHex: Buffer.concat(chunks).toString('hex'),
          }));
        });
      });
      const res = await proxyPost({ url: first.origin + '/start', method: 'POST', body: 'followed' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(201);
      expect(res.body.statusText).toBe('Made It');
      const echoed = JSON.parse(res.body.body);
      expect(echoed.url).toBe('/landing'); // relative Location resolved against the hop URL
      expect(echoed.method).toBe('POST'); // method preserved across the hop
      expect(Buffer.from(echoed.bodyHex, 'hex').toString()).toBe('followed');
    });

    it('follows absolute redirects to a different public origin', async () => {
      const target = await echoServer();
      const redirector = await redirectServer(target.origin + '/landing');
      const res = await proxyPost({ url: redirector.origin + '/start' });
      expect(res.body.status).toBe(201);
      expect(redirector.hits).toHaveLength(1);
      expect(target.hits).toHaveLength(1);
    });

    it('detects redirect loops (400)', async () => {
      const before = ServerEventLog.getAll().length;
      const up = await startUpstream((req, res) => {
        req.resume();
        res.writeHead(302, { location: '/loop' });
        res.end();
      });
      const res = await proxyPost({ url: up.origin + '/loop' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Redirect loop detected' });
      const logged = ServerEventLog.getAll().slice(before).filter((l) => /Redirect loop/.test(l.message));
      expect(logged).toHaveLength(1);
    });

    it('returns 502 for a 3xx without a Location header', async () => {
      const up = await startUpstream((req, res) => { req.resume(); res.writeHead(307); res.end(); });
      const res = await proxyPost({ url: up.origin + '/noloc' });
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'Redirect with no Location header' });
    });

    it('returns 400 for an invalid redirect target', async () => {
      const up = await redirectServer('http://');
      const res = await proxyPost({ url: up.origin + '/bad' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid redirect target' });
    });

    it('blocks redirects to private hosts (403)', async () => {
      const up = await redirectServer('http://127.0.0.1:8080/admin');
      const res = await proxyPost({ url: up.origin + '/to-private' });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Internal URLs are not permitted' });
    });

    it('blocks redirects whose target DNS-resolves to a private IP (403)', withLookup(
      vi.fn(async () => [{ address: '10.0.0.7', family: 4 }]),
      async () => {
        const up = await redirectServer('http://rebind-hop.e2e.test/x');
        const res = await proxyPost({ url: up.origin + '/to-rebind' });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'Internal URLs are not permitted' });
      }
    ));

    it('rejects redirects to non-http protocols (400)', async () => {
      const up = await redirectServer('gopher://example.com/x');
      const res = await proxyPost({ url: up.origin + '/to-gopher' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Only http and https URLs are supported' });
    });

    it('gives up after more than 5 redirects (502)', async () => {
      const up = await hopChainServer();
      const res = await proxyPost({ url: up.origin + '/hop/0' });
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'Too many redirects' });
      expect(up.hits.length).toBe(6); // hops 0..5, then the loop exits
    });
  });

  describe('error paths', () => {
    it('returns 502 with the cause code when the upstream is unreachable', async () => {
      const port = await getClosedPort();
      const before = ServerEventLog.getAll().length;
      const res = await proxyPost({ url: `http://${PUBLIC_IP}:${port}/x` });
      expect(res.status).toBe(502);
      expect(res.body.error.startsWith('Network error:')).toBe(true);
      expect(res.body.code).toBe('ECONNREFUSED');
      const logged = ServerEventLog.getAll().slice(before)
        .filter((l) => l.app === 'AppNetworkProxy' && l.severity === 'error');
      expect(logged).toHaveLength(1);
      expect(logged[0].data.code).toBe('ECONNREFUSED');
    });

    it('returns 502 "Read error" when the upstream dies mid-body', async () => {
      const up = await startUpstream((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000' });
        res.write('short');
        setTimeout(() => res.destroy(), 100);
      });
      const res = await proxyPost({ url: up.origin + '/truncate' });
      expect(res.status).toBe(502);
      expect(res.body.error.startsWith('Read error:')).toBe(true);
    });

    it('returns 502 "Response too large" when the body exceeds the 10 MB cap', async () => {
      const big = Buffer.alloc(10 * 1024 * 1024 + 512, 122);
      const up = await startUpstream((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(big.length) });
        res.end(big);
      });
      const res = await proxyPost({ url: up.origin + '/huge' });
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'Response too large' });
    });

    it('tries the next validated address when the first pinned connect fails (real fall-through)', { timeout: 20000 }, withLookup(
      vi.fn(async () => [
        { address: '192.0.2.1', family: 4 }, // public (TEST-NET-1) but unroutable — connect times out
        { address: PUBLIC_IP, family: 4 },   // the real local upstream
      ]),
      async () => {
        const up = await echoServer();
        const res = await proxyPost({ url: `http://dual-stack-fallback.e2e.test:${up.port}/fall` });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe(201);
        const echoed = JSON.parse(res.body.body);
        expect(echoed.headers.host).toBe(`dual-stack-fallback.e2e.test:${up.port}`);
      }
    ));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// e2e: /api/email-image
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!E2E_UPSTREAMS)('proxies.js — e2e: email image proxy (GET /api/email-image)', () => {
  describe('input validation and auth', () => {
    // The binary parser hands us Buffer bodies even for JSON error responses.
    const jsonBody = (res) => JSON.parse(res.body.toString('utf8'));

    it('requires a session (401 without one)', async () => {
      const res = await emailImage('http://example.com/x.png', { 'x-test-auth': 'no-session' });
      expect(res.status).toBe(401);
      expect(jsonBody(res)).toEqual({ error: 'Unauthorized — session required' });
    });

    it('requires a session id (401 when session has no id)', async () => {
      const res = await emailImage('http://example.com/x.png', { 'x-test-auth': 'session-no-id' });
      expect(res.status).toBe(401);
      expect(jsonBody(res)).toEqual({ error: 'Unauthorized — session required' });
    });

    it('rejects a missing url parameter (400)', async () => {
      const res = await request(app).get('/api/email-image').set(signed()).parse(binaryParser);
      expect(res.status).toBe(400);
      expect(jsonBody(res)).toEqual({ error: 'url parameter is required' });
    });

    it('rejects an array-valued url parameter (400)', async () => {
      const res = await request(app).get('/api/email-image').query({ url: ['a', 'b'] }).set(signed()).parse(binaryParser);
      expect(res.status).toBe(400);
      expect(jsonBody(res)).toEqual({ error: 'url parameter is required' });
    });
  });

  describe('fallback pixel for rejected targets', () => {
    it('serves the 1x1 fallback PNG for an unparseable URL (200, not 400)', async () => {
      const res = await emailImage('definitely not a url');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.equals(FALLBACK_PNG)).toBe(true);
    });

    for (const url of ['ftp://example.com/x.png', 'file:///etc/passwd.png']) {
      it(`serves the fallback for ${url.split(':')[0]}: URLs`, async () => {
        const res = await emailImage(url);
        expect(res.status).toBe(200);
        expect(res.body.equals(FALLBACK_PNG)).toBe(true);
      });
    }

    it('serves the fallback for private targets', async () => {
      for (const host of ['localhost', '127.0.0.1', '10.0.0.1', '192.168.0.1', 'metadata.internal']) {
        const res = await emailImage(`http://${host}/pixel.png`);
        expect(res.status, host).toBe(200);
        expect(res.body.equals(FALLBACK_PNG), host).toBe(true);
      }
    });

    it('serves the fallback when DNS resolves to a private IP', withLookup(
      vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]),
      async () => {
        const res = await emailImage('http://rebind-email.e2e.test/pixel.png');
        expect(res.status).toBe(200);
        expect(res.body.equals(FALLBACK_PNG)).toBe(true);
      }
    ));

    it('serves the fallback when DNS fails to resolve', withLookup(
      vi.fn(async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); }),
      async () => {
        const res = await emailImage('http://no-such-email-host.e2e.test/pixel.png');
        expect(res.status).toBe(200);
        expect(res.body.equals(FALLBACK_PNG)).toBe(true);
      }
    ));

    it('rejects URLs carrying credentials without contacting the upstream', async () => {
      const up = await startUpstream((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'image/png' }); res.end('PNG'); });
      const res = await emailImage(`http://user:secret@${PUBLIC_IP}:${up.port}/pixel.png`);
      expect(res.status).toBe(200);
      expect(res.body.equals(FALLBACK_PNG)).toBe(true);
    });

    it('serves the fallback when the upstream is unreachable', async () => {
      const port = await getClosedPort();
      const res = await emailImage(`http://${PUBLIC_IP}:${port}/pixel.png`);
      expect(res.status).toBe(200);
      expect(res.body.equals(FALLBACK_PNG)).toBe(true);
    });

    it('serves the fallback for non-2xx upstream statuses', async () => {
      for (const status of [404, 500]) {
        const up = await startUpstream((req, res) => { req.resume(); res.writeHead(status, { 'content-type': 'image/png' }); res.end('x'); });
        const res = await emailImage(`${up.origin}/pixel.png`);
        expect(res.status, String(status)).toBe(200);
        expect(res.body.equals(FALLBACK_PNG), String(status)).toBe(true);
      }
    });

    it('serves the fallback for non-image content types', async () => {
      const up = await startUpstream((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body>not an image</body></html>');
      });
      const res = await emailImage(up.origin + '/page');
      expect(res.status).toBe(200);
      expect(res.body.equals(FALLBACK_PNG)).toBe(true);
    });

    it('serves the fallback when the upstream sends no content-type at all', async () => {
      const up = await startUpstream((req, res) => {
        req.resume();
        res.writeHead(200); // no content-type header
        res.end('raw-bytes');
      });
      const res = await emailImage(up.origin + '/mystery');
      expect(res.status).toBe(200);
      expect(res.body.equals(FALLBACK_PNG)).toBe(true);
    });

    it('serves the fallback for empty image bodies', async () => {
      const up = await startUpstream((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': '0' });
        res.end();
      });
      const res = await emailImage(up.origin + '/empty.png');
      expect(res.status).toBe(200);
      expect(res.body.equals(FALLBACK_PNG)).toBe(true);
    });

    it('serves the fallback when the image exceeds the 5 MB cap', async () => {
      const big = Buffer.alloc(5 * 1024 * 1024 + 512, 7);
      const up = await startUpstream((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(big.length) });
        res.end(big);
      });
      const res = await emailImage(up.origin + '/huge.png');
      expect(res.status).toBe(200);
      expect(res.body.equals(FALLBACK_PNG)).toBe(true);
    });

    it('serves the fallback on redirect loops', async () => {
      const up = await startUpstream((req, res) => { req.resume(); res.writeHead(302, { location: '/loop' }); res.end(); });
      const res = await emailImage(up.origin + '/loop');
      expect(res.body.equals(FALLBACK_PNG)).toBe(true);
    });

    it('serves the fallback for a 3xx without a Location header', async () => {
      const up = await startUpstream((req, res) => { req.resume(); res.writeHead(302); res.end(); });
      const res = await emailImage(up.origin + '/noloc');
      expect(res.body.equals(FALLBACK_PNG)).toBe(true);
    });

    it('serves the fallback for an invalid redirect target', async () => {
      const up = await redirectServer('http://');
      const res = await emailImage(up.origin + '/bad');
      expect(res.body.equals(FALLBACK_PNG)).toBe(true);
    });

    it('serves the fallback when the redirect targets a private host', async () => {
      const up = await redirectServer('http://10.0.0.1/admin');
      const res = await emailImage(up.origin + '/to-private');
      expect(res.body.equals(FALLBACK_PNG)).toBe(true);
    });

    it('serves the fallback when the redirect uses a non-http protocol', async () => {
      const up = await redirectServer('ftp://example.com/x.png');
      const res = await emailImage(up.origin + '/to-ftp');
      expect(res.body.equals(FALLBACK_PNG)).toBe(true);
    });

    it('serves the fallback after too many redirects', async () => {
      const up = await hopChainServer();
      const res = await emailImage(up.origin + '/hop/0');
      expect(res.body.equals(FALLBACK_PNG)).toBe(true);
      expect(up.hits.length).toBeGreaterThanOrEqual(6);
    });

    it('serves the fallback when the upstream never responds within 5s', { timeout: 15000 }, async () => {
      const up = await startUpstream(() => { /* never respond */ });
      const res = await emailImage(up.origin + '/hang.png');
      expect(res.status).toBe(200);
      expect(res.body.equals(FALLBACK_PNG)).toBe(true);
    });
  });

  describe('successful image fetches', () => {
    it('streams the exact upstream bytes with the upstream mime type', async () => {
      const bytes = Buffer.from('P0NGL0T5-0f-1m4g3-d4t4!');
      const hits = [];
      const up = await startUpstream((req, res) => {
        hits.push({ method: req.method, headers: req.headers });
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(bytes);
      });
      const res = await emailImage(up.origin + '/pixel.png');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.equals(bytes)).toBe(true);
      expect(hits).toHaveLength(1);
      expect(hits[0].method).toBe('GET');
      expect(hits[0].headers['user-agent']).toBe('Mozilla/5.0 (compatible; NovaByte/1.0)');
    });

    it('normalizes content-type parameters (image/jpeg; charset=binary → image/jpeg)', async () => {
      const up = await startUpstream((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'image/jpeg; charset=binary' });
        res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      });
      const res = await emailImage(up.origin + '/photo.jpg');
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.body.equals(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    });

    it('follows a redirect to the real image', async () => {
      const bytes = Buffer.from('GIF89a-tracker-bytes');
      const target = await startUpstream((req, res) => {
        res.writeHead(200, { 'content-type': 'image/gif' });
        res.end(bytes);
      });
      const redirector = await redirectServer(target.origin + '/real.gif');
      const res = await emailImage(redirector.origin + '/track');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/gif');
      expect(res.body.equals(bytes)).toBe(true);
      expect(redirector.hits).toHaveLength(1);
      expect(target.hits ?? []).toHaveLength(0); // target handler does not track; the bytes prove the hit
    });
  });
});

// ── Restore everything this file touched (vitest isolates per file, but be
//    a good citizen anyway). ──────────────────────────────────────────────────
afterAll(async () => {
  for (const srv of upstreams) {
    try { srv.close(); } catch { /* already closed */ }
    try { srv.closeAllConnections?.(); } catch { /* not supported */ }
  }
  webidl.converters.AbortSignal = originalAbortSignalConverter;
  webidl.is.AbortSignal = originalAbortSignalIs;
  globalThis.AbortController = originalAbortController;
  dns.promises.lookup = realLookup;
  _dnsPrivateCache.clear();
});
