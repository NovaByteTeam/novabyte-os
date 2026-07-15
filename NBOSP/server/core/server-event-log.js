/**
 * SERVER EVENT LOG — server-event-log.js
 *
 * Node-side counterpart to js/core/services/event-log.js. The browser-side
 * EventLog is a `window` global — code running in this process (Express
 * routes, security middleware, email clients, proxies) has no access to it,
 * since NW.js still runs Node and the renderer as separate contexts.
 *
 * This module is the "record" half of that gap: a small in-memory ring
 * buffer + pub/sub that subsystems in this process call into directly.
 * The "transport" half is events-routes.js, which exposes an SSE stream
 * that the client's server-events-bridge.js subscribes to and forwards
 * into EventLog.ingestRemote().
 *
 * Deliberately not persisted to disk — this is dev/debug visibility for a
 * running process, not an audit trail that needs to survive a restart.
 */

const { randomUUID } = require('crypto');

const MAX_ENTRIES = 500;
const entries = [];
const subscribers = new Set();

/**
 * Record a server-side event.
 *   ServerEventLog.log({ app: 'EmailController', severity: 'error',
 *                         message: 'IMAP connect failed', data: { host } })
 * `category` is intentionally not accepted here — the client always stamps
 * category:'server' on ingest (see EventLog.ingestRemote), so subsystem
 * grouping within "server" happens via `app`, same convention the browser
 * side already uses for app-name grouping.
 */
function log(opts = {}) {
  const entry = {
    id: randomUUID(),
    timestamp: Date.now(),
    app: opts.app || 'server',
    severity: opts.severity || 'info', // 'info' | 'warn' | 'error'
    message: opts.message || '',
    data: opts.data || null,
  };

  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();

  for (const fn of subscribers) {
    try { fn(entry); } catch (e) { /* one bad subscriber shouldn't break the rest */ }
  }

  return entry;
}

/** Returns all buffered entries (oldest first), for late-joining SSE clients. */
function getAll() {
  return entries.slice();
}

/** Live-update hook for the SSE route. Returns an unsubscribe function. */
function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

module.exports = { log, getAll, subscribe };
