/**
 * baremux-transport.js — Bare V3 transport for @mercuryworkshop/bare-mux
 */

export default class BareTransport {
  constructor([server]) {
    this.serverPath = server.endsWith('/') ? server : server + '/';
    this.ready = true;

    // ── Concurrency limiter ─────────────────────────────────────────
    // Google (and most sites) limit keep-alive connections per IP.
    // Without throttling, loading a page fires 50-100 simultaneous
    // requests through the bare server → 429 CONNECTION_LIMIT_EXCEEDED.
    this._maxConcurrent = 4; // conservative; avoids Google's per-IP connection cap
    this._active = 0;
    this._queue = [];
  }

  async init() { this.ready = true; }

  _acquire() {
    if (this._active < this._maxConcurrent) {
      this._active++;
      return Promise.resolve();
    }
    return new Promise(resolve => this._queue.push(resolve));
  }

  _release() {
    this._active--;
    if (this._queue.length > 0) {
      this._active++;
      this._queue.shift()();
    }
  }

  async request(remote, method, body, headers, signal) {
    const endpoint    = this.serverPath + 'v3/';
    const upperMethod = (method || 'GET').toUpperCase();
    const hasBody     = body != null && !['GET', 'HEAD'].includes(upperMethod);

    const bareHeaders = {
      'X-Bare-URL':             remote.toString(),
      'X-Bare-Headers':         JSON.stringify(headers || {}),
      'X-Bare-Forward-Headers': 'accept-encoding,accept-language,cookie',
    };

    const fetchOpts = {
      method:  upperMethod,
      headers: bareHeaders,
      signal:  signal || undefined,
      // CRITICAL: The bare endpoint URL is always /bare/v3/ regardless of
      // the target. Without no-store the browser caches a CSS response and
      // serves it for every subsequent request → pages show raw CSS.
      cache: 'no-store',
    };

    if (hasBody) {
      fetchOpts.body = body;
      // Required for Chrome 105+ with any non-trivial body.
      fetchOpts.duplex = 'half';
    }

    // ── Retry loop for 429 rate-limit responses ─────────────────────
    // Google's retryAfter can be 40+ seconds. We honour it fully
    // (capped at 60 s) so we don't exhaust retries before the window resets.
    const MAX_RETRIES = 4;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this._acquire();

      // After acquiring slot on retry, add micro-delay to further desynchronize
      // concurrent retries that may have woken up simultaneously
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, Math.random() * 200 + 50));
      }

      let resp;
      try {
        resp = await fetch(endpoint, fetchOpts);
      } finally {
        this._release();
      }

      if (resp.status === 429) {
        const text = await resp.text().catch(() => '{}');
        let retryAfter = 2 ** attempt; // exponential default: 1,2,4,8 s
        try {
          const json = JSON.parse(text);
          // Respect the server's retryAfter, capped at 60 s
          if (json.retryAfter) retryAfter = Math.min(Number(json.retryAfter), 60);
        } catch { /* ignore */ }

        if (attempt < MAX_RETRIES) {
          // Add ±25% jitter to prevent synchronized retry storms
          const jitter = 0.75 + Math.random() * 0.5;
          const actualDelay = Math.round(retryAfter * jitter * 1000);
          console.warn(`[BareTransport] 429 – retrying in ${(actualDelay / 1000).toFixed(1)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
          // Sleep WITHOUT holding a concurrency slot
          await new Promise(r => setTimeout(r, actualDelay));
          continue;
        }
        throw new Error(`Bare server error 429: ${text}`);
      }

      if (!resp.ok && resp.status !== 304) {
        const text = await resp.text().catch(() => 'unknown error');
        throw new Error(`Bare server error ${resp.status}: ${text}`);
      }

      const status     = parseInt(resp.headers.get('X-Bare-Status')     || String(resp.status), 10);
      const statusText =          resp.headers.get('X-Bare-Status-Text') || resp.statusText;
      const rawHeaders = JSON.parse(resp.headers.get('X-Bare-Headers')  || '{}');

      return { status, statusText, headers: rawHeaders, body: resp.body };
    }
  }

  connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    const wsEndpoint = this.serverPath.replace(/^http/, 'ws') + 'v3/';
    let metaReceived = false;
    const ws = new WebSocket(wsEndpoint);
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        remote:         url.toString(),
        headers:        requestHeaders || {},
        protocols:      protocols || [],
        forwardHeaders: ['accept-encoding', 'accept-language'],
      }));
    });

    ws.addEventListener('message', (e) => {
      if (!metaReceived) {
        metaReceived = true;
        try {
          const meta = typeof e.data === 'string' ? JSON.parse(e.data) : {};
          onopen(meta.protocol ?? (protocols?.[0] ?? ''));
        } catch { onopen(protocols?.[0] ?? ''); }
        return;
      }
      onmessage(e.data);
    });

    ws.addEventListener('close', (e) => onclose(e.code, e.reason));
    ws.addEventListener('error', () => onerror(new Error('WebSocket proxy error')));

    return [
      (data)         => ws.send(data),
      (code, reason) => ws.close(code, reason),
    ];
  }
}