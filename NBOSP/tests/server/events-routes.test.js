import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import http from 'node:http';

// Both modules through the SAME require instance — events-routes closes over
// its own require('./server-event-log'), and the tests must talk to that
// exact ring buffer (a bare ESM import would create a second instance —
// the same cross-instance contamination push.test.js documents).
const require = createRequire(import.meta.url);
const { setupEventsRoutes } = require('../../server/core/events-routes.js');
const ServerEventLog = require('../../server/core/server-event-log.js');

afterEach(() => {
  ServerEventLog.clear();
});

afterAll(() => {
  ServerEventLog.clear();
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Opens the SSE stream and collects `data:` frames until `predicate` says stop. */
function collectFrames(server, path, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(); reject(new Error('SSE collection timed out')); }, timeoutMs);
    const frames = [];
    let headers = null;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
      headers = res.headers;
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (frame.startsWith('data: ')) frames.push(JSON.parse(frame.slice(6)));
          else if (frame.startsWith(':')) frames.push(frame);
        }
        if (predicate(frames)) {
          clearTimeout(timer);
          req.destroy();
          resolve({ headers, frames });
        }
      });
    });
    req.on('error', (e) => { if (!timer._destroyed) { clearTimeout(timer); if (e.code !== 'ECONNRESET') reject(e); } });
    req.end();
  });
}

describe('server/core/events-routes.js — GET /api/events/stream', () => {
  it('mounts on /api/events and serves an SSE response with the right headers', async () => {
    const app = express();
    setupEventsRoutes(app);
    const server = await listen(app);
    try {
      ServerEventLog.log({ message: 'history-1' });
      const { headers, frames } = await collectFrames(
        server,
        '/api/events/stream',
        (frames) => frames.some((f) => f?.message === 'history-1'),
      );
      expect(headers['content-type']).toContain('text/event-stream');
      expect(headers['cache-control']).toContain('no-cache');
      expect(headers['connection']).toBe('keep-alive');
      expect(headers['x-accel-buffering']).toBe('no');
      expect(frames[0].message).toBe('history-1');
      expect(frames[0].id).toBeTruthy();
    } finally {
      server.close();
    }
  });

  it('replays the full historical buffer to a newly connected client', async () => {
    const app = express();
    setupEventsRoutes(app);
    const server = await listen(app);
    try {
      ServerEventLog.log({ message: 'h1' });
      ServerEventLog.log({ message: 'h2' });
      ServerEventLog.log({ message: 'h3' });
      const { frames } = await collectFrames(
        server,
        '/api/events/stream',
        (frames) => frames.filter((f) => typeof f === 'object').length >= 3,
      );
      const messages = frames.filter((f) => typeof f === 'object').map((f) => f.message);
      expect(messages).toEqual(['h1', 'h2', 'h3']);
    } finally {
      server.close();
    }
  });

  it('pushes live entries logged after the client connected', async () => {
    const app = express();
    setupEventsRoutes(app);
    const server = await listen(app);
    try {
      const pending = collectFrames(
        server,
        '/api/events/stream',
        (frames) => frames.some((f) => f?.message === 'live-after-connect'),
      );
      // give the connection a moment to establish, then log a live entry
      await new Promise((r) => setTimeout(r, 150));
      ServerEventLog.log({ message: 'live-after-connect' });
      const { frames } = await pending;
      expect(frames.some((f) => f?.message === 'live-after-connect')).toBe(true);
    } finally {
      server.close();
    }
  });

  it('stops streaming to a client that disconnected (cleanup does not throw)', async () => {
    const app = express();
    setupEventsRoutes(app);
    const server = await listen(app);
    try {
      ServerEventLog.log({ message: 'pre' });
      const { frames } = await collectFrames(server, '/api/events/stream', (f) => f.length >= 1);
      expect(frames.length).toBeGreaterThanOrEqual(1);
      // the subscriber was removed on close — log again and expect no crash
      expect(() => ServerEventLog.log({ message: 'after-disconnect' })).not.toThrow();
    } finally {
      server.close();
    }
  });

  // The route handler, extracted straight off the mounted express router so
  // the defensive branches that only open in the race window between a stream
  // dying and its close event can be driven deterministically.
  function extractStreamHandler() {
    const app = express();
    setupEventsRoutes(app);
    const root = app._router || app.router;
    const eventsLayer = root.stack.find((l) => l.handle && Array.isArray(l.handle.stack));
    const streamLayer = eventsLayer.handle.stack.find((l) => l.route && l.route.path === '/stream');
    return streamLayer.route.stack[0].handle;
  }

  function fakeRes({ writableEnded = false, destroyed = false, withFlushHeaders = false } = {}) {
    const written = [];
    const handlers = {};
    const res = {
      writableEnded,
      destroyed,
      setHeader: () => {},
      write: (chunk) => written.push(chunk),
      on: (ev, cb) => { handlers[ev] = cb; },
    };
    if (withFlushHeaders) res.flushHeaders = () => { written.push('[flushed]'); };
    return { res, written, handlers };
  }

  it('skips history and live frames for an already-dead stream, without flushHeaders', () => {
    ServerEventLog.clear();
    ServerEventLog.log({ message: 'stale-history' });
    const handler = extractStreamHandler();
    // dead from the first byte, and no flushHeaders method at all
    const { res, written, handlers } = fakeRes({ writableEnded: true });
    const reqHandlers = {};
    handler({ on: (ev, cb) => { reqHandlers[ev] = cb; } }, res, () => {});
    expect(written).toEqual([]); // history loop broke before the first write
    // a live entry arrives while the stream is dead → the subscriber skips
    ServerEventLog.log({ message: 'live-while-dead' });
    expect(written).toEqual([]);
    // close fires cleanup once; a second close is a no-op (guarded)
    expect(() => { reqHandlers.close(); reqHandlers.close(); handlers.close(); handlers.finish(); handlers.error(new Error('x')); }).not.toThrow();
  });

  it('heartbeats every 25s and stops once the stream dies', async () => {
    vi.useFakeTimers();
    try {
      ServerEventLog.clear();
      const handler = extractStreamHandler();
      const { res, written, handlers } = fakeRes();
      handler({ on: () => {} }, res, () => {});
      expect(written).toEqual([]);

      await vi.advanceTimersByTimeAsync(25_000);
      expect(written).toEqual([': heartbeat\n\n']);

      // writableEnded flips true → the left side of the guard is false
      res.writableEnded = true;
      await vi.advanceTimersByTimeAsync(25_000);
      expect(written).toEqual([': heartbeat\n\n']); // no second frame

      // destroyed instead → right side false, still skipped
      res.writableEnded = false;
      res.destroyed = true;
      await vi.advanceTimersByTimeAsync(25_000);
      expect(written).toEqual([': heartbeat\n\n']);

      handlers.close(); // clearInterval + unsubscribe, idempotent
      await vi.advanceTimersByTimeAsync(60_000);
      expect(written).toEqual([': heartbeat\n\n']);
    } finally {
      vi.useRealTimers();
    }
  });
});
