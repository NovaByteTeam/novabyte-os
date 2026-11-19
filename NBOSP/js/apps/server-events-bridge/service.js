// SERVER EVENTS BRIDGE — server-events-bridge.js
//
// Subscribes to the Node-side event stream (server/events-routes.js) and
// forwards each entry into the browser-side EventLog via ingestRemote(),
// so security/email/proxy activity from the server process shows up in
// the same Events app timeline as browser-origin events.
//
// Node-side events arrive with a delay relative to in-process browser
// events (an HTTP round trip vs. a direct function call) — expected, not
// a bug, given NW.js keeps Node and the renderer as separate contexts.
//
// Reconnects with backoff on drop (server restart, network blip) rather
// than giving up after one failure, since this is meant to run for the
// life of the OS session.

const ServerEventsBridge = {
  _controller: null,
  _retryTimer: null,
  _retryMs: 1000,
  _maxRetryMs: 30000,
  _stopped: false,

  start() {
    if (ServerEventsBridge._controller || ServerEventsBridge._retryTimer) return;
    ServerEventsBridge._stopped = false;
    ServerEventsBridge._connect();
  },

  stop() {
    ServerEventsBridge._stopped = true;
    clearTimeout(ServerEventsBridge._retryTimer);
    ServerEventsBridge._retryTimer = null;
    ServerEventsBridge._controller?.abort();
    ServerEventsBridge._controller = null;
  },

  async _connect() {
    if (ServerEventsBridge._stopped || ServerEventsBridge._controller) return;
    const controller = new AbortController();
    ServerEventsBridge._controller = controller;
    console.log('[ServerEventsBridge] Connecting to /api/events/stream...');

    try {
      const response = await fetch('/api/events/stream', {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Event stream returned HTTP ${response.status}`);
      if (!response.body) throw new Error('Event stream response has no readable body');
      ServerEventsBridge._retryMs = 1000;
      console.log('[ServerEventsBridge] Connected');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, ''))
            .join('\n');
          if (!data) continue;
          try {
            const entry = JSON.parse(data);
            console.log('[ServerEventsBridge] Received:', entry.app, entry.message);
            if (typeof window.EventLog?.ingestRemote === 'function') {
              window.EventLog.ingestRemote(entry);
            }
          } catch (error) {
            console.error('[ServerEventsBridge] Malformed frame:', error.message);
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn('[ServerEventsBridge] Connection error, scheduling reconnect:', error.message);
      }
    } finally {
      if (ServerEventsBridge._controller === controller) {
        ServerEventsBridge._controller = null;
        if (!ServerEventsBridge._stopped) ServerEventsBridge._scheduleReconnect();
      }
    }
  },

  _scheduleReconnect() {
    if (ServerEventsBridge._stopped || ServerEventsBridge._retryTimer) return;
    ServerEventsBridge._retryTimer = setTimeout(() => {
      ServerEventsBridge._retryTimer = null;
      ServerEventsBridge._connect();
    }, ServerEventsBridge._retryMs);
    ServerEventsBridge._retryMs = Math.min(ServerEventsBridge._retryMs * 2, ServerEventsBridge._maxRetryMs);
  },
};

ServerEventsBridge.start();

if (typeof window !== 'undefined') {
  window.ServerEventsBridge = ServerEventsBridge;
}
