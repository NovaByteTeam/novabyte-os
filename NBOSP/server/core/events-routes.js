/**
 * NovaByte - Server Events Routes
 * Exposes ServerEventLog over Server-Sent Events so the browser-side
 * Events app can show what's happening on the Node side (security, email,
 * proxies) in the same timeline as browser-origin events.
 *
 * One-directional (server -> client) is all this needs, so SSE over plain
 * HTTP rather than a WebSocket — no extra dependency, no handshake beyond
 * a normal GET, and it survives NW.js's single-process model fine.
 */

const express = require('express');
const ServerEventLog = require('./server-event-log');

function setupEventsRoutes(app) {
  const router = express.Router();

  router.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');

    for (const entry of ServerEventLog.getAll()) {
      if (res.writableEnded || res.headersSent) break;
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    const unsubscribe = ServerEventLog.subscribe((entry) => {
      if (!res.writableEnded && !res.headersSent) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      }
    });

    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.headersSent) {
        res.write(': heartbeat\n\n');
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.use('/api/events', router);
}

module.exports = { setupEventsRoutes };
