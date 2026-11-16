import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

// Real configureSSL (ssl.test.js mocks it for the bootstrap tests) + real
// certs from the shared X.509 seeder, so the plaintext-into-TLS-port
// behavior is exercised against an actual https.Server, not a mock.
// Real configureSSL through CJS require — the same instance style the
// ssl.test.js / index.test.js bootstrap chains load (vi.mock cannot
// intercept their internal requires). One loading style per module across
// all workers keeps the v8 coverage merge honest.
import { createRequire } from 'node:module';
const { configureSSL, isPlainHttpRequestToTlsPort, respondPlainHttpOverRawSocket } = createRequire(import.meta.url)('../../server/core/ssl.js');
import { seedCerts } from './helpers/seed-certs.js';

describe('server/core/ssl.js — plain HTTP request on the HTTPS port', () => {
  let dataDir;
  let server;
  let baseUrl;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = undefined;
    }
    if (dataDir) {
      await fs.rm(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
  });

  async function boot() {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nbosp-ssl-plain-http-'));
    await seedCerts(dataDir);
    process.env.NBOSP_DATA_DIR = dataDir;
    ({ server } = configureSSL((req, res) => res.end('ok-https')));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `127.0.0.1:${port}`;
  }

  function rawRequest(requestLine) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const socket = net.connect(Number(baseUrl.split(':')[1]), '127.0.0.1');
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('timed out waiting for response')); }, 5000);
      socket.on('data', (c) => chunks.push(c));
      socket.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
      socket.on('error', (err) => { clearTimeout(timer); reject(err); });
      socket.on('connect', () => {
        socket.end(`${requestLine}\r\nHost: ${baseUrl}\r\nConnection: close\r\n\r\n`);
      });
    });
  }

  it('answers a plaintext HTTP request with an explicit 400 instead of an empty response', async () => {
    await boot();
    const raw = await rawRequest('GET /api/apps/serve/sandbox_com.example.myapp/callback.html?code=abc HTTP/1.1');
    expect(raw.startsWith('HTTP/1.1 400 Bad Request\r\n')).toBe(true);
    expect(raw).toContain('Content-Type: text/html; charset=utf-8');
    expect(raw).toContain('HTTPS required');
    expect(raw).toContain('https://localhost:3003');
  });

  it('keeps Node\'s silent destroy for TLS handshake failures that are not plaintext HTTP', async () => {
    await boot();
    // Garbage that is neither a TLS record nor an HTTP request line.
    const raw = await rawRequest('ZZZZ-not-tls-not-http ZZZZ');
    expect(raw).toBe('');
  });

  it('serves normal HTTPS traffic unchanged', async () => {
    await boot();
    const body = await new Promise((resolve, reject) => {
      const req = https.request({
        host: '127.0.0.1',
        port: Number(baseUrl.split(':')[1]),
        path: '/',
        rejectUnauthorized: false,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(body.status).toBe(200);
    expect(body.body).toBe('ok-https');
  });
});

describe('server/core/ssl.js — responder helpers (unit)', () => {
  it('isPlainHttpRequestToTlsPort matches only the plaintext-HTTP-on-TLS condition', () => {
    expect(isPlainHttpRequestToTlsPort({ code: 'ERR_SSL_HTTP_REQUEST' })).toBe(true);
    expect(isPlainHttpRequestToTlsPort({
      message: 'error:0A00009C:SSL routines::tls_validate_record_header:http req',
    })).toBe(true);
    expect(isPlainHttpRequestToTlsPort({ code: 'ERR_SSL_WRONG_VERSION_NUMBER' })).toBe(false);
    expect(isPlainHttpRequestToTlsPort({ code: 'ERR_SSL_CERT_SIGNATURE_FAILURE' })).toBe(false);
    expect(isPlainHttpRequestToTlsPort(null)).toBe(false);
    expect(isPlainHttpRequestToTlsPort(undefined)).toBe(false);
  });

  function fakeSocket() {
    const writes = [];
    return {
      destroyed: false,
      writable: true,
      writes,
      ended: false,
      destroyCalls: 0,
      listeners: {},
      on(event, fn) { (this.listeners[event] ||= []).push(fn); },
      end(payload) { this.ended = true; if (payload) writes.push(payload); },
      destroy() { this.destroyCalls += 1; },
      emitError(err) { (this.listeners.error || []).forEach((fn) => fn(err)); },
    };
  }

  it('respondPlainHttpOverRawSocket writes one well-formed 400 and ends the socket', () => {
    const socket = fakeSocket();
    expect(respondPlainHttpOverRawSocket(socket)).toBe(true);
    expect(socket.ended).toBe(true);
    expect(socket.writes).toHaveLength(1);
    const response = socket.writes[0];
    expect(response.startsWith('HTTP/1.1 400 Bad Request\r\n')).toBe(true);
    expect(response).toContain('Content-Length:');
    expect(response).toContain('Connection: close');
    // Content-Length must match the actual body length — a mismatch here
    // would just trade ERR_EMPTY_RESPONSE for ERR_CONTENT_LENGTH_MISMATCH.
    const body = response.split('\r\n\r\n')[1];
    const declared = Number(response.match(/Content-Length: (\d+)/)[1]);
    expect(declared).toBe(Buffer.byteLength(body));
    // The error listener must be attached before the write (client may RST).
    expect(socket.listeners.error).toBeDefined();
    // and firing that listener (a mid-flush client reset) is a silent no-op
    expect(() => socket.emitError(new Error('read ECONNRESET'))).not.toThrow();
  });

  it('respondPlainHttpOverRawSocket refuses destroyed or non-writable sockets', () => {
    const destroyed = fakeSocket();
    destroyed.destroyed = true;
    expect(respondPlainHttpOverRawSocket(destroyed)).toBe(false);
    expect(destroyed.ended).toBe(false);

    const notWritable = fakeSocket();
    notWritable.writable = false;
    expect(respondPlainHttpOverRawSocket(notWritable)).toBe(false);
    expect(notWritable.ended).toBe(false);

    expect(respondPlainHttpOverRawSocket(null)).toBe(false);
  });

  it('the 1s destroy backstop fires if the client never closes its side', async () => {
    vi.useFakeTimers();
    try {
      const socket = fakeSocket();
      expect(respondPlainHttpOverRawSocket(socket)).toBe(true);
      expect(socket.destroyCalls).toBe(0); // end() flushed, no destroy yet
      await vi.advanceTimersByTimeAsync(1_000);
      expect(socket.destroyCalls).toBe(1); // backstop destroyed the socket
    } finally {
      vi.useRealTimers();
    }
  });

  it('tolerates timer handles that carry no unref method', () => {
    // some embedder runtimes hand back a bare number from setTimeout
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(12345);
    try {
      const socket = fakeSocket();
      expect(respondPlainHttpOverRawSocket(socket)).toBe(true);
      expect(socket.ended).toBe(true);
      expect(socket.writes).toHaveLength(1);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});

describe('server/core/ssl.js — configureSSL guards', () => {
  const savedDataDir = process.env.NBOSP_DATA_DIR;

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.NBOSP_DATA_DIR;
    else process.env.NBOSP_DATA_DIR = savedDataDir;
  });

  it('refuses to start when the TLS material is missing from the data dir', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'nbosp-ssl-nocerts-'));
    try {
      process.env.NBOSP_DATA_DIR = empty;
      expect(() => configureSSL((req, res) => res.end('x'))).toThrow(
        /Cannot start server without TLS/,
      );
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it('falls back to the package dir above the script when NBOSP_DATA_DIR is unset', async () => {
    delete process.env.NBOSP_DATA_DIR;
    // No cert.key/cert.crt ship inside the repo — the fallback path resolves
    // against NBOSP/ and still refuses to boot without TLS material.
    expect(() => configureSSL((req, res) => res.end('x'))).toThrow(
      /Cannot start server without TLS/,
    );
  });

  it('tlsClientError: non-plaintext failures return early; a missing raw socket destroys the TLS socket', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nbosp-ssl-emit-'));
    await seedCerts(dataDir);
    process.env.NBOSP_DATA_DIR = dataDir;
    try {
      const { server } = configureSSL((req, res) => res.end('x'));
      // a non-plaintext TLS error: our handler returns before touching the
      // raw socket (node's own tls internals may still destroy the wrapper —
      // that is its documented default and fine)
      const parentWrites = [];
      const stray = {
        _parent: {
          destroyed: false,
          writable: true,
          end: (d) => parentWrites.push(d),
          on: () => {},
          destroy: () => {},
        },
        destroy: vi.fn(),
      };
      server.emit('tlsClientError', { code: 'ERR_SSL_WRONG_VERSION_NUMBER' }, stray);
      expect(parentWrites).toEqual([]); // no plaintext 400 for non-plaintext failures

      // plaintext error but the raw socket is gone → the TLS socket is
      // destroyed (node's tls internals also destroy it — its own default)
      const tlsSocket = { _parent: null, destroy: vi.fn() };
      server.emit('tlsClientError', { code: 'ERR_SSL_HTTP_REQUEST' }, tlsSocket);
      expect(tlsSocket.destroy).toHaveBeenCalled();

      // a throwing destroy is swallowed by our handler's try/catch. node's
      // own tls listener was registered first and calls destroy BEFORE ours,
      // so only the SECOND call (ours) explodes — proving our catch held
      let destroyCalls = 0;
      const exploding = {
        _parent: null,
        destroy: () => { destroyCalls += 1; if (destroyCalls === 2) throw new Error('boom'); },
      };
      expect(() => server.emit('tlsClientError', { code: 'ERR_SSL_HTTP_REQUEST' }, exploding)).not.toThrow();
      expect(destroyCalls).toBeGreaterThanOrEqual(2);

      // a tlsSocket without any destroy method: our handler's guard skips the
      // destroy call entirely. Called DIRECTLY off the listener list — a
      // bare emit would die in node's own (first-registered) tls listener,
      // which calls conn.destroy unguarded.
      const handlers = server.listeners('tlsClientError');
      const ourHandler = handlers[handlers.length - 1]; // configureSSL registers last
      expect(() => ourHandler({ code: 'ERR_SSL_HTTP_REQUEST' }, { _parent: null })).not.toThrow();
      // and a destroyed raw socket falls into the same guarded branch
      expect(() => ourHandler({ code: 'ERR_SSL_HTTP_REQUEST' }, { _parent: { destroyed: true } })).not.toThrow();

      await new Promise((r) => server.close(r));
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
