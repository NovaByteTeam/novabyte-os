/**
 * NovaByte — App Sandbox
 *
 * Creates secure execution environments for apps using sandboxed webviews with
 * process isolation. Each app gets its own renderer process, storage partition,
 * and a capability-scoped IPC bridge to host OS services (filesystem, network,
 * notifications, window manager, etc.).
 *
 * @module app-sandbox
 */

const AppSandbox = (() => {
  'use strict';

  // Module state

  // Active sandboxes keyed by sandboxId. Each value holds the webview element,
  // app metadata, window state, WebSocket connections, and a teardown function.
  const activeSandboxes = new Map();
  const rootExecutionApps = new Map();
  const ROOT_AUDIT_STORAGE_KEY = 'novaOS_root_audit';
  const ROOT_AUDIT_MAX_ENTRIES = 1000;
  const rootAuditSetTimeout = window.setTimeout.bind(window);
  const rootAuditClearTimeout = window.clearTimeout.bind(window);
  const rootRevocationSetTimeout = window.setTimeout.bind(window);
  const rootAuditWrappedFunctions = new WeakSet();
  const rootAuditSubscribers = new Set();
  let rootRevocationReloadScheduled = false;
  let rootAuditEntries = null;
  let rootAuditPersistTimer = null;

  // Event subscriptions keyed by sandboxId, then event name -> handler.
  // Kept in a separate map so cleanup can iterate without touching the sandbox
  // object's other fields.
  const eventSubscriptions = new Map();

  // Open file dialogs keyed by sandboxId, so we can tear them down when a
  // sandbox is destroyed mid-dialog (prevents orphaned overlays in the DOM).
  const openDialogs = new Map();
  const shareDialogs = new Map();

  function getRootAuditEntries() {
    if (rootAuditEntries) return rootAuditEntries.slice();
    try {
      const saved = JSON.parse(localStorage.getItem(ROOT_AUDIT_STORAGE_KEY) || '[]');
      rootAuditEntries = Array.isArray(saved) ? saved.filter(entry =>
        entry && typeof entry === 'object' && typeof entry.timestamp === 'number'
      ) : [];
      return rootAuditEntries.slice();
    } catch (error) {
      console.error('[RootAccess] Could not read the root audit log:', error);
      rootAuditEntries = [];
      return [];
    }
  }

  function recordRootAudit(app, api, severity = 'info') {
    const entry = {
      timestamp: Date.now(),
      appId: app.id,
      appName: app.name || app.id,
      api,
      severity,
    };
    if (!rootAuditEntries) rootAuditEntries = getRootAuditEntries();
    rootAuditEntries.unshift(entry);
    if (rootAuditEntries.length > ROOT_AUDIT_MAX_ENTRIES) rootAuditEntries.length = ROOT_AUDIT_MAX_ENTRIES;
    if (!rootAuditPersistTimer) {
      rootAuditPersistTimer = rootAuditSetTimeout(() => {
        rootAuditPersistTimer = null;
        persistRootAudit();
      }, 250);
    }
    for (const subscriber of rootAuditSubscribers) {
      try {
        subscriber(entry);
      } catch (error) {
        console.error('[RootAccess] Root audit subscriber failed:', error);
      }
    }
  }

  function persistRootAudit() {
    try {
      localStorage.setItem(ROOT_AUDIT_STORAGE_KEY, JSON.stringify(rootAuditEntries || []));
    } catch (error) {
      console.error('[RootAccess] Could not persist the root audit log:', error);
    }
  }

  function flushRootAudit() {
    if (rootAuditPersistTimer) {
      rootAuditClearTimeout(rootAuditPersistTimer);
      rootAuditPersistTimer = null;
    }
    persistRootAudit();
  }

  function identifyRootCaller(stack) {
    for (const app of rootExecutionApps.values()) {
      const marker = `novaapp:${String(app.id).replace(/[^a-zA-Z0-9_.-]/g, '_')}/`;
      if (stack.includes(marker)) return app;
    }
    return null;
  }

  function installRootApiAudit(app) {
    const existing = rootExecutionApps.get(app.id);
    rootExecutionApps.set(app.id, {
      id: app.id,
      name: app.name || app.id,
      entryLoaded: existing?.entryLoaded === true,
    });
    const seenObjects = new WeakSet();
    const excludedMethods = new Set(['log']);

    function instrument(value, path, depth) {
      if (!value || typeof value !== 'object' || seenObjects.has(value) || depth > 2) return;
      let prototype;
      try {
        prototype = Object.getPrototypeOf(value);
      } catch (error) {
        console.error(`[RootAccess] Could not inspect API namespace ${path}:`, error);
        return;
      }
      if (prototype !== Object.prototype && prototype !== null) return;
      seenObjects.add(value);

      for (const key of Object.keys(value)) {
        let current;
        try {
          current = value[key];
        } catch (error) {
          console.error(`[RootAccess] Could not inspect API ${path}.${key}:`, error);
          continue;
        }
        const apiPath = `${path}.${key}`;
        if (typeof current === 'function' && !excludedMethods.has(key) && !rootAuditWrappedFunctions.has(current)) {
          const original = current;
          const wrapped = function(...args) {
            const caller = identifyRootCaller(new Error().stack || '');
            if (caller) recordRootAudit(caller, apiPath);
            return Reflect.apply(original, this, args);
          };
          try {
            value[key] = wrapped;
            if (value[key] === wrapped) rootAuditWrappedFunctions.add(wrapped);
          } catch (error) {
            console.error(`[RootAccess] Could not instrument API ${apiPath}:`, error);
          }
        } else if (current && typeof current === 'object') {
          instrument(current, apiPath, depth + 1);
        }
      }
    }

    for (const name of ['OS', 'FS', 'WM', 'AppRegistry', 'AppPermissionManager', 'Notify', 'DefaultApps', 'Boot', 'Kernel', 'VFS']) {
      const api = window[name];
      if (api && typeof api === 'object') {
        try {
          instrument(api, name, 0);
        } catch (error) {
          console.error(`[RootAccess] Could not instrument API namespace ${name}:`, error);
        }
      }
      return existing?.entryLoaded === true;
    }
  }

  function reloadAfterRootRevocation(reason) {
    if (!rootExecutionApps.size || rootRevocationReloadScheduled) return false;
    rootRevocationReloadScheduled = true;
    for (const app of rootExecutionApps.values()) {
      recordRootAudit(app, `Root execution revoked: ${reason}`, 'warn');
    }
    flushRootAudit();
    try {
      if (typeof OS !== 'undefined' && typeof WM !== 'undefined') {
        for (const [windowId, state] of OS.windows || []) {
          if (rootExecutionApps.has(state.appId)) WM.closeWindow(windowId);
        }
      }
    } catch (error) {
      console.error('[RootAccess] Could not close every root app window before reload:', error);
    } finally {
      rootRevocationSetTimeout(() => window.location.reload(), 100);
    }
    return true;
  }

  // Constants

  const API_PREFIX = 'nova:';
  // Allow word chars, dash, dot, space. Anything else (slashes, colons) is
  // rejected to prevent key injection across app namespaces.
  const STORAGE_KEY_REGEX = /^[\w\-. ]+$/;
  const STORAGE_VALUE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB per single value
  const STORAGE_APP_QUOTA_BYTES = 25 * 1024 * 1024; // 25 MB total per app
  const CLIPBOARD_HISTORY_MAX = 30;
  const ALLOWED_HTTP_METHODS = new Set([
    'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
  ]);
  const ALLOWED_WEB_PROTOCOLS = new Set(['http:', 'https:']);
  // Hostnames that count as "internal" for permission gating, beyond
  // whatever isInternalHost's IP-range checks already catch. Named
  // first-party internal services live here since they don't resolve to
  // a fixed literal IP we could range-check.
  const INTERNAL_HOSTS = new Set([
    'localhost', 'api.novabyte.internal',
  ]);
  const DEFAULT_WINDOW_WIDTH = 800;
  const DEFAULT_WINDOW_HEIGHT = 600;
  const MIN_WINDOW_DIMENSION = 100;
  const DIALOG_FOCUS_DELAY_MS = 50;
  const DOWNLOAD_DIALOG_TIMEOUT_MS = 5 * 60 * 1000; // 5 min cap on save dialog
  const CLEAR_PARTITION_TIMEOUT_MS = 4000;

  // Notification gateway
  // Sandboxed apps never touch Notify.show() directly — everything funnels
  // through handleNotificationsShow, which enforces the limits below. This is
  // the actual security boundary: Notify.show() itself will happily execute a
  // function passed as `action` (trusted first-party callers rely on that),
  // so an app-facing payload must never pass anything but plain data through.
  const NOTIF_TITLE_MAX_LEN = 120;
  const NOTIF_BODY_MAX_LEN = 500;
  const NOTIF_ACTION_LABEL_MAX_LEN = 40;
  const ALLOWED_NOTIF_TYPES = new Set(['info', 'success', 'warning', 'error']);
  // Matches the icon set actually implemented by svgIcon() elsewhere in the
  // OS; anything else falls back to the default rather than being passed
  // through to markup/attribute contexts uninspected.
  const ALLOWED_NOTIF_ICONS = new Set([
    'archive', 'bell', 'bookmark', 'box', 'clock', 'file', 'folder', 'globe',
    'image', 'layout', 'lock', 'monitor', 'music', 'package', 'play', 'refresh',
    'search', 'sound', 'star', 'unlock', 'users', 'x',
  ]);
  // Built-in action strings handleable by Notify.showToast()'s action-button
  // switch statement. Anything else is dropped rather than forwarded, since
  // an unrecognized string is silently ignored downstream anyway (console.warn)
  // but there's no reason to let an app probe for future built-ins.
  const ALLOWED_NOTIF_ACTIONS = new Set(['settings', 'open-settings', 'openSettings']);
  // Sliding-window rate limit: N notifications per app per window.
  const NOTIF_RATE_LIMIT_MAX = 10;
  const NOTIF_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
  // appId -> array of timestamps (ms) within the current window.
  const notifRateLimitLog = new Map();

  // Only an app which passes UnrestrictedGate may execute in the host
  // document. Any package that falls back to a sandbox gets the same
  // permission-gated capabilities as every other sandboxed app.
  function isFullyUnrestricted(app) {
    return app?.__unrestrictedSandbox === true;
  }

  // Shared TextEncoder for the base64 helpers — cheap to construct, but no
  // reason to allocate a new one per call when IPC traffic is high-frequency.
  const sharedTextEncoder = new TextEncoder();
  const sharedTextDecoder = new TextDecoder();

  // Utility helpers

  // Generate a unique request ID for IPC correlation. Prefers crypto.randomUUID
  // when available; falls back to timestamp + random otherwise.
  function generateRequestId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `req_${crypto.randomUUID()}`;
    }
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  // Generate a unique sandbox ID. Uses crypto.randomUUID for collision
  // resistance — Date.now() alone can collide if two sandboxes are created
  // in the same millisecond.
  function generateSandboxId(appId) {
    const unique = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    return `sandbox_${appId}_${unique}`;
  }

  // Escape a string for safe HTML interpolation. Used whenever app-supplied
  // metadata (name, author, etc.) is embedded into the default shell or error
  // page. Without this, a malicious package could inject <script> tags.
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  // UTF-8 safe base64 encoding. btoa() throws on non-Latin1 characters, so app
  // HTML containing emoji or CJK content would crash the loader. We go through
  // TextEncoder so the full Unicode range survives the round-trip.
  function encodeBase64Utf8(text) {
    const bytes = sharedTextEncoder.encode(text);
    if (typeof bytes.toBase64 === 'function') {
      return bytes.toBase64();
    }
    // Legacy fallback for runtimes without Uint8Array.toBase64 (pre-ES2026).
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  // Inverse of encodeBase64Utf8.
  function decodeBase64Utf8(b64) {
    if (typeof Uint8Array.fromBase64 === 'function') {
      return sharedTextDecoder.decode(Uint8Array.fromBase64(b64));
    }
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return sharedTextDecoder.decode(bytes);
  }

  function encodeBase64Bytes(bytes) {
    if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  // Structured logger. Debug-level messages are gated on a window flag so
  // production builds stay quiet unless an operator opts in.
  function log(level, message, ...rest) {
    const prefix = '[AppSandbox]';
    if (level === 'error') console.error(prefix, message, ...rest);
    else if (level === 'warn') console.warn(prefix, message, ...rest);
    else if (level === 'debug') {
      if (typeof window !== 'undefined' && window.__NOVA_SANDBOX_DEBUG__) {
        console.debug(prefix, message, ...rest);
      }
    } else {
      console.log(prefix, message, ...rest);
    }
  }

  // Cloud metadata endpoints — checked ahead of, and independent of, the
  // internal/external classification below. isInternalHost correctly
  // classifies these as internal (they're link-local), which means any app
  // holding an ordinary net:internal grant (intended for talking to
  // api.novabyte.internal) could also reach them directly and pull
  // instance credentials. There's no legitimate reason a third-party
  // sandboxed app should ever reach these regardless of what network
  // permission it holds, so they get a hard deny here rather than being
  // bundled into the same grant as first-party internal services.
  // 169.254.169.254 covers AWS/GCP/Azure/DigitalOcean's IMDS; fd00:ec2::254
  // is AWS's IPv6 equivalent.
  const BLOCKED_METADATA_HOSTS = new Set(['169.254.169.254', 'fd00:ec2::254']);

  // Resolve a URL string against the current origin and classify it as
  // internal or external. Handles protocol-relative URLs (//host/path) safely
  // by always resolving through new URL(rawUrl, window.location.origin).
  //
  // Without this, an app could pass "//evil.com/foo" to net:fetch and have it
  // treated as internal because the original check only looked at the leading
  // "/" character.
  function resolveAndClassifyUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl === '') {
      return { valid: false, error: 'Invalid URL' };
    }
    let resolved;
    try {
      resolved = new URL(rawUrl, window.location.origin);
    } catch {
      return { valid: false, error: 'Invalid URL' };
    }
    if (!ALLOWED_WEB_PROTOCOLS.has(resolved.protocol)) {
      return { valid: false, error: 'Only http and https URLs are allowed' };
    }
    if (BLOCKED_METADATA_HOSTS.has(resolved.hostname.toLowerCase())) {
      return { valid: false, error: 'Cloud metadata endpoints are not reachable from apps' };
    }
    return {
      valid: true,
      url: resolved.href,
      isInternal: isInternalHost(resolved.hostname),
    };
  }

  // Parse a dotted-decimal IPv4 string into 4 octets, or null if it isn't
  // one. `URL` already normalizes alternate encodings (hex, octal, decimal-
  // integer, short forms like "127.1") into plain dotted-decimal before this
  // ever sees the hostname, so a strict dotted-decimal parse here is safe —
  // it's not re-opening the encodings URL already collapsed.
  function parseIPv4(hostname) {
    const parts = hostname.split('.');
    if (parts.length !== 4) return null;
    const octets = [];
    for (const p of parts) {
      if (!/^\d{1,3}$/.test(p)) return null;
      const n = Number(p);
      if (n > 255) return null;
      octets.push(n);
    }
    return octets;
  }

  // True if the given IPv4 octets fall in a loopback/private/link-local
  // range — i.e. anything that isn't routable "external" address space.
  // Covers: 127.0.0.0/8 (all loopback, not just .1), 10.0.0.0/8,
  // 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 (link-local, which
  // includes the 169.254.169.254 cloud metadata endpoint), 0.0.0.0/8, and
  // 100.64.0.0/10 (RFC 6598 shared address space — used internally by some
  // cloud providers, so it isn't public/routable either even though it
  // isn't classic RFC1918).
  //
  // The 0.0.0.0 check used to only match the literal all-zero address
  // (0.0.0.0), not the wider /8. That mattered because Linux resolves any
  // 0.x.x.x address to loopback — http://0.1.2.3/ reaches the same place
  // as 127.0.0.1 on a Linux host, so treating only 0.0.0.0 as internal left
  // the rest of that /8 misclassified as external and routable via a plain
  // net:external grant.
  function isPrivateIPv4(octets) {
    const [a, b] = octets;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  // True if a normalized IPv6 literal (no brackets, lowercase — which is
  // what URL.hostname already gives us) is loopback/private/link-local, or
  // wraps an internal IPv4 address (IPv4-mapped ::ffff:a.b.c.d or the
  // legacy IPv4-compatible ::a.b.c.d form).
  function isPrivateIPv6(hostname) {
    if (hostname === '::1' || hostname === '::') return true;
    // Unique local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd][0-9a-f]{2}:/.test(hostname)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(hostname)) return true;
    // IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d) — the
    // embedded IPv4 address is what actually gets routed to, so classify
    // by that.
    const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(hostname);
    if (mapped) {
      const octets = parseIPv4(mapped[1]);
      return octets ? isPrivateIPv4(octets) : false;
    }
    return false;
  }

  function isInternalHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    if (INTERNAL_HOSTS.has(h)) return true;

    const v4 = parseIPv4(h);
    if (v4) return isPrivateIPv4(v4);

    // URL.hostname strips brackets from IPv6 literals, but check both
    // forms defensively in case this is ever called with a raw value.
    const v6 = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
    if (v6.includes(':')) return isPrivateIPv6(v6);

    return false;
  }

  // Validate that a value is a positive integer within optional bounds.
  // Returns the parsed integer or the fallback when invalid.
  function parsePositiveInt(value, fallback, min = 1) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return parsed;
  }

  // Sanitize an app id for safe interpolation into a /data/ path segment.
  // Strips anything that isn't a word char or dash — notably including dots
  // now, since a bare '..' previously survived this unchanged (the old
  // pattern allowed dots and dashes both, so '..' matched every character
  // and passed through as-is). The one path that constructs an appId here
  // (handleAppInstall) requires signature verification before an id ever
  // reaches this function, so '..' isn't reachable through it today — but
  // this is the last line of defense if a future sideload/dev-install path
  // ever skips that check, so it strips dots regardless of current
  // reachability.
  function sanitizeAppIdSegment(appId) {
    return String(appId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  // Notification gateway helpers

  // Strictly whitelist and clamp an app-supplied notification payload before
  // it ever reaches Notify.show(). This is the actual security boundary:
  // Notify.show() itself will call `action` if it's a function (trusted
  // first-party callers rely on that), so nothing but plain, bounded data
  // may cross from a sandboxed app into that call.
  function sanitizeNotificationPayload(payload, appName, appId) {
    const raw = payload ?? {};

    const title = typeof raw.title === 'string' && raw.title.trim()
      ? raw.title.slice(0, NOTIF_TITLE_MAX_LEN)
      : 'Notification';
    const body = typeof raw.body === 'string'
      ? raw.body.slice(0, NOTIF_BODY_MAX_LEN)
      : '';
    const type = ALLOWED_NOTIF_TYPES.has(raw.type) ? raw.type : 'info';
    const icon = ALLOWED_NOTIF_ICONS.has(raw.icon) ? raw.icon : null;

    // `action` must never be forwarded as anything but a plain, known string.
    // A function reference (or any other type) is dropped entirely rather
    // than coerced, since coercion here is exactly how a sandbox escape
    // would sneak through.
    const action = typeof raw.action === 'string' && ALLOWED_NOTIF_ACTIONS.has(raw.action)
      ? raw.action
      : null;
    const actionLabel = action && typeof raw.actionLabel === 'string'
      ? raw.actionLabel.slice(0, NOTIF_ACTION_LABEL_MAX_LEN)
      : null;

    return {
      title,
      body,
      type,
      // Clamp appName too — a malicious manifest could declare an absurdly
      // long name that would blow past Notify's layout assumptions.
      appName: typeof appName === 'string' ? appName.slice(0, NOTIF_TITLE_MAX_LEN) : 'App',
      appId,
      icon,
      action,
      actionLabel,
      category: 'app',
    };
  }

  // Sliding-window rate limit: returns true if `appId` is still under
  // NOTIF_RATE_LIMIT_MAX notifications within the last
  // NOTIF_RATE_LIMIT_WINDOW_MS, recording this attempt if so. Returns false
  // (and does not record) if the app is over the limit.
  function checkNotificationRateLimit(appId) {
    const now = Date.now();
    const windowStart = now - NOTIF_RATE_LIMIT_WINDOW_MS;
    const timestamps = (notifRateLimitLog.get(appId) ?? []).filter((ts) => ts > windowStart);

    if (timestamps.length >= NOTIF_RATE_LIMIT_MAX) {
      notifRateLimitLog.set(appId, timestamps);
      return false;
    }

    timestamps.push(now);
    notifRateLimitLog.set(appId, timestamps);
    return true;
  }

  // Drop the rate-limit entry for an app. Called on uninstall so the log
  // doesn't grow unbounded across the app's install/uninstall lifecycle.
  function clearNotificationRateLimit(appId) {
    notifRateLimitLog.delete(appId);
  }

  // Response helpers

  // Send a response back to the sandboxed app.
  //
  // <webview> guests have no parent/embedder window reference at all
  // (window.parent === window for a <webview> guest — confirmed empirically,
  // and matches spec: a window with no parent has parent === itself).
  // postMessage from the host to some captured "source" reference was never
  // reachable, because no such reference is ever set — the guest can't
  // postMessage to the host either, for the same reason (see setupAPIBridge,
  // which reads guest->host messages via the webview's 'consolemessage' DOM
  // event instead).
  //
  // For host->guest, webview.executeScript(...) is a real, confirmed-working
  // NW.js API already used elsewhere in this codebase (see browser.js's
  // URL/title polling and context-menu injection). This pushes the response
  // directly into a well-known array (window.__novaInbox), which the
  // isolated-world transport script's poller drains and relays on to the
  // main-world capability shim via postMessage.
  //
  // Deliberately NOT { mainWorld: true } here — window.__novaInbox now
  // lives inside the isolated-world transport script injected via
  // addContentScripts (see buildIsolatedTransportScript), not on the
  // guest's own main-world window. executeScript's default (mainWorld:
  // false / omitted) targets that same isolated world, which is exactly
  // where this needs to land. A guest page's own script — including one
  // that has redefined window.__novaInbox, Array.prototype methods, or
  // anything else in its own main-world realm — cannot see or interfere
  // with this call, because isolated and main worlds share the DOM but
  // not JS globals.
  //
  // Data is passed as base64-encoded JSON rather than interpolated directly
  // into the injected code string. JSON.stringify does not escape backticks
  // or `${...}`, so an app-supplied value living inside `result` (e.g. an
  // echoed filename) could otherwise break out of the template literal below
  // and run arbitrary code in the target context. Base64's alphabet
  // (A-Za-z0-9+/=) can't contain any of those characters, so splicing it in
  // needs no further escaping. We embed it via JSON.stringify so the JS
  // string literal is well-formed regardless of base64 padding characters.
  function respond(webview, type, requestId, result, error = null) {
    if (typeof webview?.__directResponder === 'function') {
      try {
        webview.__directResponder({ type: `${type}:response`, requestId, result, error });
      } catch (e) {
        log('error', `Failed to respond directly to ${type}:`, e);
      }
      return;
    }
    try {
      const json = JSON.stringify({ type: `${type}:response`, requestId, result, error });
      const b64 = encodeBase64Utf8(json);
      const b64Literal = JSON.stringify(b64);
      // The injected code returns true on success / false on a caught parse
      // error, so the executeScript callback's results array actually means
      // something. executeScript's callback is (results), not (err); the
      // injected push statement returns undefined either way, so we wrap it
      // in a try/catch that returns a boolean.
      const code = `(function(){try{window.__novaInbox=window.__novaInbox||[];window.__novaInbox.push(JSON.parse(atob(${b64Literal})));return true;}catch(e){return false;}})();`;
      if (typeof webview?.executeScript !== 'function') {
        log('warn', `Cannot respond to ${type}: webview executeScript unavailable`);
        return;
      }
      webview.executeScript({ code }, (results) => {
        const delivered = Array.isArray(results) ? results[0] : results;
        if (delivered !== true) {
          log('error', `Failed to respond to ${type} (guest-side delivery failed or webview unavailable)`);
        }
      });
    } catch (e) {
      log('error', `Failed to respond to ${type}:`, e);
    }
  }

  // Error codes worth surfacing in the Events app. NOT_FOUND / UNAVAILABLE are
  // routine and would just add noise; PERMISSION_DENIED, RATE_LIMITED, and
  // anything else (unrecognized codes lean toward "new/unexpected", so they're
  // included by default) are the ones a dev actually wants to see happen live.
  const IPC_ERROR_LOG_SKIP = new Set(['NOT_FOUND', 'UNAVAILABLE']);

  function respondError(webview, type, requestId, code, message) {
    if (typeof EventLog !== 'undefined' && !IPC_ERROR_LOG_SKIP.has(code)) {
      const appId = webview?.dataset?.appId || 'unknown';
      EventLog.log({
        app: 'AppSandbox',
        category: 'security',
        severity: code === 'PERMISSION_DENIED' || code === 'RATE_LIMITED' ? 'warn' : 'error',
        message: `${appId}: ${type} → ${code}${message ? ' — ' + message : ''}`,
        data: { appId, type, code },
      });
    }
    // Coerce message to a string so a non-Error value (e.g. an object
    // thrown by an upstream caller that didn't use Error) doesn't surface
    // as "[object Object]" in the guest-side error handler.
    respond(webview, type, requestId, null, { code, message: String(message ?? '') });
  }

  // Filesystem helpers

  // Resolve a payload (with either `path` or `id`) to a file node.
  // Any /data/<segment>/... path belongs to whichever app's id that
  // segment is — this is the convention every fs:write/mkdir path-rewrite
  // already relies on. Re-derived from the node's own canonical path
  // (FS.getPath), never from whatever the caller claims, since an app
  // could otherwise resolve by raw id and bypass a path-based check
  // entirely.
  function ownerAppIdForPath(canonicalPath) {
    const m = /^\/data\/([^/]+)(?:\/|$)/.exec(canonicalPath || '');
    return m ? m[1] : null;
  }

  function ownerAppIdForNode(node, canonicalPath) {
    const canonicalOwner = ownerAppIdForPath(canonicalPath);
    if (canonicalOwner !== null) return canonicalOwner;

    const trashId = FS.specialFolders?.trash;
    const trashPath = trashId ? FS.getPath(trashId) : null;
    if (!trashId || !trashPath || !canonicalPath.startsWith(`${trashPath}/`)) return null;

    let current = node;
    while (current && current.id !== trashId) {
      if (current._originalParent) {
        const originalParentPath = FS.getPath(current._originalParent);
        return ownerAppIdForPath(`${originalParentPath}/${current.name}`);
      }
      current = FS.files.get(current.parentId);
    }
    return '\0'; // Legacy trash entries without ownership metadata fail closed.
  }

  // requireOwnAppData: true for mutations unless vfs:access grants access to
  // shared user files. No grant can reach another app's private data subtree.
  // false for read — apps can see the shared/general tree (anything not
  // under any app's /data/ prefix) plus their own /data/<appId>/, but
  // never another app's /data/<otherAppId>/. This mirrors how mobile
  // scoped storage splits "your own sandboxed folder" from "the general
  // shared area" without handing out unrestricted access to other apps'
  // private data either way.
  //
  // Resolving by raw `id` used to skip this check entirely — any granted
  // vfs:read/write/delete could reach any file's node directly as long as
  // it knew (or guessed/enumerated) an id, regardless of which app's
  // /data/ folder it actually lived in. That's the bug this closes.
  function resolveFile(payload, appId, requireOwnAppData, allowSharedMutation = false) {
    const { path, id } = payload ?? {};
    let node = null;
    if (id) {
      node = FS.files.get(id) || null;
    } else if (path) {
      const rawPath = String(path);
      const rewritten = rawPath.startsWith('/data/')
        ? '/data/' + sanitizeAppIdSegment(appId) + rawPath.slice('/data'.length)
        : rawPath;
      node = FS.getByPath(rewritten);
    } else {
      return null;
    }
    if (!node) return null;

    const canonicalPath = FS.getPath(node.id);
    const ownerAppId = ownerAppIdForNode(node, canonicalPath);
    const safeAppId = sanitizeAppIdSegment(appId);

    // Enforce VFS ownership for every sandboxed caller. Broad access includes
    // shared user files, never another app's private data.
    if (ownerAppId !== null) {
      if (ownerAppId !== safeAppId) return null;
    } else if (requireOwnAppData && !allowSharedMutation) {
      return null;
    }
    return node;
  }

  function hasVfsAccess(appId) {
    return AppPermissionManager.isGranted('vfs:access', appId);
  }

  function hasVfsRead(appId) {
    return hasVfsAccess(appId) || AppPermissionManager.isGranted('vfs:read', appId);
  }

  function hasVfsWrite(appId) {
    return hasVfsAccess(appId) || AppPermissionManager.isGranted('vfs:write', appId);
  }

  function isAppDataContainer(node) {
    return node?.type === 'folder' && FS.getPath(node.id) === '/data';
  }

  function canPickerAccess(node, appId, {
    writable = false, sharedWrite = false, allowContainerNavigation = true,
  } = {}) {
    if (!node) return false;
    if (allowContainerNavigation && (node.id === FS.rootId || isAppDataContainer(node))) return true;
    return !!resolveFile({ id: node.id }, appId, writable, sharedWrite);
  }

  // Convert a file node to a safe serializable object.
  function fileToJSON(node) {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      mimeType: node.mimeType,
      size: node.size,
      path: FS.getPath(node.id),
      parentId: node.parentId,
      created: node.created,
      modified: node.modified,
      accessed: node.accessed,
      permissions: node.permissions,
      sha256: node.sha256,
      tags: node.tags || [],
    };
  }

  // Rewrite a /data/-prefixed path so the segment immediately after /data/
  // is the calling app's own id. Returns the original path unchanged if it
  // doesn't start with /data/. Used by the write/mkdir/move handlers to
  // normalize before FS.getByPath.
  function rewriteDataPath(rawPath, appId) {
    const p = String(rawPath || '');
    if (!p.startsWith('/data/')) return p;
    return '/data/' + sanitizeAppIdSegment(appId) + p.slice('/data'.length);
  }

  // File dialog

  // Show a file open/save dialog. The dialog is a custom overlay so it matches
  // the NovaByte visual style. The visuals are kept identical to the original
  // implementation — only internal cleanup wiring has changed.
  function showFileDialog(mode, webview, type, requestId, app, payload) {
    // Host-level surface: mount into the same portal ModalService uses
    // (modals.js) rather than document.body directly. #launchpad and
    // .app-window elements carry transform/backdrop-filter, which forms
    // its own stacking context — a plain z-index on a document.body child
    // doesn't reliably win against that. This root uses isolation:isolate
    // and the max-safe z-index specifically to sit above every other
    // layer regardless of what those layers set their own z-index to.
    let modalRoot = document.getElementById('system-modal-root');
    if (!modalRoot) {
      modalRoot = document.createElement('div');
      modalRoot.id = 'system-modal-root';
      Object.assign(modalRoot.style, {
        position: 'fixed',
        inset: '0',
        width: '100vw',
        height: '100vh',
        zIndex: '2147483000',
        pointerEvents: 'none',
        isolation: 'isolate',
      });
      document.body.appendChild(modalRoot);
    }

    const overlay = document.createElement('div');
    overlay.className = 'nsec-overlay';
    overlay.style.cssText = `
      position: fixed; inset: 0;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.55);
      pointer-events: auto;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: #0e121c; border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px; padding: 24px; max-width: 620px; width: 92%;
      max-height: 80vh; display: flex; flex-direction: column;
      box-shadow: 0 32px 80px rgba(0,0,0,0.6);
      font-family: var(--font-ui, system-ui, sans-serif);
    `;

    const title = document.createElement('h3');
    title.style.cssText = 'color: #e6edf3; margin: 0 0 4px; font-size: 16px; font-weight: 700;';
    title.textContent = mode === 'open' ? '📂 Open File' : '💾 Save File';
    dialog.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.style.cssText = 'color: #8b949e; margin: 0 0 12px; font-size: 12px;';
    subtitle.textContent = payload.title || `Select a ${mode === 'open' ? 'file to open' : 'location to save'}`;
    dialog.appendChild(subtitle);

    const filter = payload.filter || payload.accept || null;
    if (filter) {
      const filterEl = document.createElement('p');
      filterEl.style.cssText = 'color: #d29922; margin: 0 0 12px; font-size: 11px;';
      filterEl.textContent = `Filter: ${Array.isArray(filter) ? filter.join(', ') : filter}`;
      dialog.appendChild(filterEl);
    }

    const pathBar = document.createElement('div');
    pathBar.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 12px; flex-wrap: wrap;';
    dialog.appendChild(pathBar);

    const fileList = document.createElement('div');
    fileList.style.cssText = 'flex: 1; overflow-y: auto; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; background: rgba(255,255,255,0.02);';

    let currentFolderId = FS.rootId;
    let selectedFile = null;

    function renderFileList() {
      fileList.innerHTML = '';
      const broadAccess = hasVfsAccess(app.id);
      const children = FS.listDir(currentFolderId).filter(item =>
        mode === 'open'
          ? resolveFile({ id: item.id }, app.id)
          : resolveFile({ id: item.id }, app.id, true, broadAccess)
            || (item.type === 'folder' && FS.getPath(item.id) === '/data')
      );

      children.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      if (children.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding: 24px; text-align: center; color: #8b949e; font-size: 13px;';
        empty.textContent = '(empty folder)';
        fileList.appendChild(empty);
      }

      for (const item of children) {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; border-radius: 4px; transition: background 0.1s;';
        row.addEventListener('mouseenter', () => { row.style.background = 'rgba(88,166,255,0.08)'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });

        const icon = document.createElement('span');
        icon.textContent = item.type === 'folder' ? '📁' : '📄';
        icon.style.fontSize = '16px';

        const name = document.createElement('span');
        name.style.cssText = 'flex: 1; color: #e6edf3; font-size: 13px;';
        name.textContent = item.name;

        const meta = document.createElement('span');
        meta.style.cssText = 'color: #8b949e; font-size: 11px; font-family: monospace;';
        if (item.type === 'file') {
          const size = item.size || 0;
          meta.textContent = size > 1024 ? (size / 1024).toFixed(1) + ' KB' : size + ' B';
        }

        row.appendChild(icon);
        row.appendChild(name);
        row.appendChild(meta);

        if (item.type === 'folder') {
          row.addEventListener('click', () => {
            currentFolderId = item.id;
            renderBreadcrumb();
            renderFileList();
            selectedFile = null;
            updateConfirmState();
          });
        } else {
          row.addEventListener('click', () => {
            if (selectedFile === item.id) {
              selectedFile = null;
              row.style.background = 'transparent';
            } else {
              selectedFile = item.id;
              fileList.querySelectorAll('[data-selected]').forEach(el => {
                el.style.background = 'transparent';
                el.removeAttribute('data-selected');
              });
              row.style.background = 'rgba(88,166,255,0.15)';
              row.setAttribute('data-selected', 'true');
            }
            updateConfirmState();
          });

          if (mode === 'save' && item.name === (payload.suggestedName || '')) {
            selectedFile = item.id;
            row.style.background = 'rgba(88,166,255,0.15)';
            row.setAttribute('data-selected', 'true');
          }
        }

        fileList.appendChild(row);
      }
    }

    function renderBreadcrumb() {
      pathBar.innerHTML = '';
      const parts = [];
      let node = FS.files.get(currentFolderId);
      while (node) {
        parts.unshift(node);
        node = FS.files.get(node.parentId);
      }

      parts.forEach((part, i) => {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.style.cssText = 'color: #8b949e;';
          sep.textContent = '/';
          pathBar.appendChild(sep);
        }
        const btn = document.createElement('button');
        btn.style.cssText = 'background: none; border: none; color: #58a6ff; cursor: pointer; font-size: 12px; padding: 2px 4px; border-radius: 3px;';
        btn.textContent = part.name;
        btn.addEventListener('click', () => {
          currentFolderId = part.id;
          renderBreadcrumb();
          renderFileList();
        });
        if (i === parts.length - 1) {
          btn.style.color = '#e6edf3';
          btn.style.fontWeight = '600';
          btn.style.cursor = 'default';
        }
        pathBar.appendChild(btn);
      });
    }

    let filenameInput = null;
    if (mode === 'save') {
      const inputRow = document.createElement('div');
      inputRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 12px;';

      const label = document.createElement('label');
      label.style.cssText = 'color: #8b949e; font-size: 12px; white-space: nowrap;';
      label.textContent = 'Filename:';

      filenameInput = document.createElement('input');
      filenameInput.type = 'text';
      filenameInput.value = payload.suggestedName || '';
      filenameInput.placeholder = 'Enter filename...';
      filenameInput.style.cssText = 'flex: 1; padding: 6px 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; color: #e6edf3; font-size: 13px;';
      filenameInput.addEventListener('input', () => {
        selectedFile = null;
        updateConfirmState();
      });

      inputRow.appendChild(label);
      inputRow.appendChild(filenameInput);
      // Insert the filename row before the file list so the visual order is
      // breadcrumb → filename input → file list → buttons.
      dialog.appendChild(inputRow);
    }

    dialog.appendChild(fileList);

    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding: 8px 18px; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; background: transparent; color: #8b949e; cursor: pointer; font-size: 13px; transition: all 0.15s;';
    cancelBtn.addEventListener('mouseenter', () => { cancelBtn.style.background = 'rgba(255,255,255,0.05)'; });
    cancelBtn.addEventListener('mouseleave', () => { cancelBtn.style.background = 'transparent'; });
    cancelBtn.addEventListener('click', () => {
      closeDialog();
      respond(webview, type, requestId, { cancelled: true });
    });

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = mode === 'open' ? 'Open' : 'Save';
    confirmBtn.style.cssText = 'padding: 8px 18px; border: none; border-radius: 6px; background: #58a6ff; color: white; cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.15s;';
    confirmBtn.addEventListener('mouseenter', () => { confirmBtn.style.background = '#3a8be6'; });
    confirmBtn.addEventListener('mouseleave', () => { confirmBtn.style.background = '#58a6ff'; });
    confirmBtn.disabled = mode === 'open';

    function updateConfirmState() {
      if (mode === 'open') {
        confirmBtn.disabled = !selectedFile;
      } else {
        confirmBtn.disabled = !(filenameInput && filenameInput.value.trim());
      }
    }

    confirmBtn.addEventListener('click', async () => {
      if (mode === 'open') {
        if (!selectedFile) return;
        const node = FS.files.get(selectedFile);
        if (!node || node.type === 'folder' || !resolveFile({ id: node.id }, app.id)) return;
        closeDialog();
        respond(webview, type, requestId, {
          success: true,
          file: {
            id: node.id,
            name: node.name,
            content: node.content || '',
            mimeType: node.mimeType || 'text/plain',
            size: node.size || 0,
            path: FS.getPath(node.id),
          },
        });
      } else {
        const name = filenameInput.value.trim();
        if (!name) return;
        if (!resolveFile({ id: currentFolderId }, app.id, true, hasVfsAccess(app.id))) {
          closeDialog();
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'Selected folder is outside this app\'s writable VFS');
        }
        const content = payload.content || '';
        const mimeType = payload.mimeType || 'text/plain';
        try {
          const newNode = await FS.createFile(currentFolderId, name, content, mimeType);
          closeDialog();
          respond(webview, type, requestId, {
            success: true,
            file: {
              id: newNode.id,
              name: newNode.name,
              path: FS.getPath(newNode.id),
            },
          });
        } catch (e) {
          closeDialog();
          respondError(webview, type, requestId, 'WRITE_ERROR', e?.message || 'Failed to write file');
        }
      }
    });

    // <webview> elements are composited by NW.js as a separate, out-of-
    // process surface — they render above ordinary same-window DOM content
    // regardless of z-index or stacking context, so #system-modal-root's
    // isolation:isolate + max z-index (which correctly beats other host
    // DOM layers like #launchpad) still loses to any running app's
    // webview. The only thing that reliably wins against a webview is
    // toggling its own visibility. Hide every active one for the
    // duration of this dialog and restore exactly the ones we hid.
    const hiddenWebviews = [];
    for (const sandbox of activeSandboxes.values()) {
      const wv = sandbox?.webview;
      if (wv && wv.style.visibility !== 'hidden') {
        hiddenWebviews.push(wv);
        wv.style.visibility = 'hidden';
      }
    }
    function restoreWebviews() {
      for (const wv of hiddenWebviews) wv.style.visibility = '';
    }

    // Closes the dialog overlay and unregisters it from the openDialogs map
    // so destroy() knows it's no longer pending.
    function closeDialog() {
      overlay.remove();
      restoreWebviews();
      const sid = webview.dataset.sandboxId;
      if (sid && openDialogs.get(sid)?.overlay === overlay) {
        openDialogs.delete(sid);
      }
    }

    btnContainer.appendChild(cancelBtn);
    btnContainer.appendChild(confirmBtn);
    dialog.appendChild(btnContainer);
    overlay.appendChild(dialog);
    modalRoot.appendChild(overlay);

    // Track the open dialog (plus its webview-restore callback) so destroy()
    // can clean it up fully if the sandbox is torn down while the user is
    // still picking a file — not just removing the overlay, but also
    // un-hiding whatever other apps' webviews this dialog hid.
    const sandboxId = webview.dataset.sandboxId;
    if (sandboxId) openDialogs.set(sandboxId, { overlay, restore: restoreWebviews });

    renderBreadcrumb();
    renderFileList();

    if (mode === 'save' && filenameInput) {
      setTimeout(() => filenameInput.focus(), DIALOG_FOCUS_DELAY_MS);
    }
  }

  // IPC handlers
  //
  // Each handler is a named async function that receives a context object
  // with { payload, requestId, app, webview, sandbox }. Handlers that respond
  // synchronously call respond/respondError before returning; async handlers
  // (geolocation, websocket, file dialog) return without responding and send
  // the response later from a callback.

  // Filesystem

  function getOpenFileForSandbox(sandbox, payload) {
    const grantedId = sandbox?.openFile?.id;
    if (!grantedId || payload?.id !== grantedId) return null;
    const node = FS.files.get(grantedId);
    return node?.type === 'file' && sandbox.openFile.node === node ? node : null;
  }

  async function handleFsRead({ payload, requestId, app, webview, sandbox }) {
    const selectedFile = getOpenFileForSandbox(sandbox, payload);
    if (!hasVfsRead(app.id) && !selectedFile) {
      return respondError(webview, 'nova:vfs:read', requestId, 'PERMISSION_DENIED', 'vfs:read or vfs:access permission required');
    }
    const node = selectedFile || resolveFile(payload, app.id);
    if (!node) return respondError(webview, 'nova:vfs:read', requestId, 'NOT_FOUND', 'File or folder not found');
    if (node.type === 'folder') {
      const children = FS.listDir(node.id).filter(child => resolveFile({ id: child.id }, app.id));
      return respond(webview, 'nova:vfs:read', requestId, {
        success: true,
        isFolder: true,
        name: node.name,
        id: node.id,
        path: FS.getPath(node.id),
        children: children.map(c => ({
          id: c.id, name: c.name, type: c.type, mimeType: c.mimeType,
          size: c.size, modified: c.modified, created: c.created,
        })),
      });
    }
    return respond(webview, 'nova:vfs:read', requestId, {
      success: true,
      data: node.content,
      mimeType: node.mimeType,
      name: node.name,
      size: node.size,
      id: node.id,
      path: FS.getPath(node.id),
      modified: node.modified,
      created: node.created,
    });
  }

  async function handleFsWrite({ payload, requestId, app, webview, sandbox }) {
    const broadAccess = hasVfsAccess(app.id);
    const selectedFile = getOpenFileForSandbox(sandbox, payload);
    if (!hasVfsWrite(app.id) && !selectedFile) {
      return respondError(webview, 'nova:vfs:write', requestId, 'PERMISSION_DENIED', 'vfs:write or vfs:access permission required');
    }
    const { path, content, mimeType } = payload ?? {};
    if (selectedFile) {
      if (content === undefined || content === null) {
        return respondError(webview, 'nova:vfs:write', requestId, 'INVALID_ARGS', 'content is required');
      }
      const saved = await FS.writeFile(selectedFile.id, content);
      if (!saved) return respondError(webview, 'nova:vfs:write', requestId, 'NOT_FOUND', 'Selected file no longer exists');
      return respond(webview, 'nova:vfs:write', requestId, { success: true, id: selectedFile.id });
    }
    if (!path || content === undefined || content === null) {
      return respondError(webview, 'nova:vfs:write', requestId, 'INVALID_ARGS', 'path and content are required');
    }
    const resolvedPath = rewriteDataPath(path, app.id);
    let node = FS.getByPath(resolvedPath);
    if (node) {
      if (node.type === 'folder') {
        return respondError(webview, 'nova:vfs:write', requestId, 'INVALID_OPERATION', 'Cannot write to a folder');
      }
      // Re-check the resolved node after path rewriting: the broad grant
      // permits shared user files, but never another app's private subtree.
      if (!resolveFile({ id: node.id }, app.id, true, broadAccess)) {
        return respondError(webview, 'nova:vfs:write', requestId, 'PERMISSION_DENIED', 'Path is outside this app\'s data directory or shared VFS');
      }
      await FS.writeFile(node.id, content);
      return respond(webview, 'nova:vfs:write', requestId, { success: true, id: node.id });
    }
    const parts = resolvedPath.split('/').filter(Boolean);
    const fileName = parts.pop();
    const parentPath = '/' + parts.join('/');
    const parent = parts.length > 0 ? FS.getByPath(parentPath) : FS.files.get(FS.rootId);
    if (!parent || parent.type !== 'folder') {
      return respondError(webview, 'nova:vfs:write', requestId, 'NOT_FOUND', 'Parent folder not found');
    }
    if (!resolveFile({ id: parent.id }, app.id, true, broadAccess)) {
      return respondError(webview, 'nova:vfs:write', requestId, 'PERMISSION_DENIED', 'Parent folder is outside this app\'s data directory or shared VFS');
    }
    // Coerce content to a string for FS.createFile. Strings pass through;
    // null/undefined is rejected above; anything else (objects, arrays,
    // numbers) is JSON-stringified so structured data round-trips cleanly
    // rather than becoming "[object Object]".
    const fileContent = typeof content === 'string' ? content : JSON.stringify(content);
    const newNode = await FS.createFile(parent.id, fileName, fileContent, mimeType || 'text/plain');
    return respond(webview, 'nova:vfs:write', requestId, {
      success: true,
      id: newNode.id,
      path: FS.getPath(newNode.id),
    });
  }

  async function handleFsDelete({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('vfs:delete', app.id)) {
      return respondError(webview, 'nova:vfs:delete', requestId, 'PERMISSION_DENIED', 'vfs:delete permission required');
    }
    const node = resolveFile(payload, app.id);
    if (!node) return respondError(webview, 'nova:vfs:delete', requestId, 'NOT_FOUND', 'File not found');
    if (node.id === FS.rootId || node.id === FS.specialFolders?.trash
      || FS.getPath(node.id) === '/data') {
      return respondError(webview, 'nova:vfs:delete', requestId, 'PROTECTED_LOCATION', 'System filesystem roots cannot be deleted');
    }
    if (payload.permanent) {
      await FS.permanentDelete(node.id);
    } else {
      await FS.deleteToTrash(node.id);
    }
    return respond(webview, 'nova:vfs:delete', requestId, { success: true });
  }

  async function handleFsList({ payload, requestId, app, webview }) {
    if (!hasVfsRead(app.id)) {
      return respondError(webview, 'nova:vfs:list', requestId, 'PERMISSION_DENIED', 'vfs:read or vfs:access permission required');
    }
    const node = resolveFile(payload, app.id);
    if (!node) return respondError(webview, 'nova:vfs:list', requestId, 'NOT_FOUND', 'Folder not found');
    if (node.type !== 'folder') {
      return respondError(webview, 'nova:vfs:list', requestId, 'INVALID_OPERATION', 'Path is not a folder');
    }
    const children = FS.listDir(node.id).filter(child => resolveFile({ id: child.id }, app.id));
    return respond(webview, 'nova:vfs:list', requestId, {
      success: true,
      path: FS.getPath(node.id),
      files: children.map(c => ({
        id: c.id, name: c.name, type: c.type, mimeType: c.mimeType,
        size: c.size, modified: c.modified, created: c.created,
      })),
    });
  }

  async function handleFsMkdir({ payload, requestId, app, webview }) {
    const broadAccess = hasVfsAccess(app.id);
    if (!hasVfsWrite(app.id)) {
      return respondError(webview, 'nova:vfs:mkdir', requestId, 'PERMISSION_DENIED', 'vfs:write or vfs:access permission required');
    }
    const { path, name } = payload ?? {};
    if (!name || typeof name !== 'string') {
      return respondError(webview, 'nova:vfs:mkdir', requestId, 'INVALID_ARGS', 'name is required');
    }
    // rewriteDataPath returns '' for null/undefined path; treat that as
    // "root" so a caller can mkdir directly under the app's /data/<appId>/.
    const resolvedPath = rewriteDataPath(path, app.id);
    let parent;
    if (resolvedPath) {
      parent = FS.getByPath(resolvedPath);
    } else {
      parent = FS.files.get(FS.rootId);
    }
    if (!parent || parent.type !== 'folder') {
      return respondError(webview, 'nova:vfs:mkdir', requestId, 'NOT_FOUND', 'Parent folder not found');
    }
    // The broad grant permits shared folders; otherwise mkdir stays inside
    // this app's private data directory.
    if (!resolveFile({ id: parent.id }, app.id, true, broadAccess)) {
      return respondError(webview, 'nova:vfs:mkdir', requestId, 'PERMISSION_DENIED', 'Parent folder is outside this app\'s data directory or shared VFS');
    }
    const newFolder = await FS.createFolder(parent.id, name);
    return respond(webview, 'nova:vfs:mkdir', requestId, {
      success: true,
      id: newFolder.id,
      path: FS.getPath(newFolder.id),
    });
  }

  async function handleFsStat({ payload, requestId, app, webview }) {
    // vfs:metadata is the narrower, lower-risk permission this channel is
    // actually meant to gate on — it existed in PERMISSION_TYPES/
    // PERMISSION_CATEGORIES as a real, distinct entry but this handler was
    // never updated to check it, so it was silently dead. vfs:read still
    // satisfies this too, since full read access is a superset of
    // metadata-only access.
    const hasMetadata = AppPermissionManager.isGranted('vfs:metadata', app.id);
    const hasRead = hasVfsRead(app.id);
    if (!hasMetadata && !hasRead) {
      return respondError(webview, 'nova:vfs:stat', requestId, 'PERMISSION_DENIED', 'vfs:metadata, vfs:read, or vfs:access permission required');
    }
    const node = resolveFile(payload, app.id);
    if (!node) return respondError(webview, 'nova:vfs:stat', requestId, 'NOT_FOUND', 'File not found');
    return respond(webview, 'nova:vfs:stat', requestId, { success: true, stat: fileToJSON(node) });
  }

  async function handleFsRename({ payload, requestId, app, webview }) {
    const broadAccess = hasVfsAccess(app.id);
    if (!hasVfsWrite(app.id)) {
      return respondError(webview, 'nova:vfs:rename', requestId, 'PERMISSION_DENIED', 'vfs:write or vfs:access permission required');
    }
    const node = resolveFile(payload, app.id, true, broadAccess);
    if (!node) return respondError(webview, 'nova:vfs:rename', requestId, 'NOT_FOUND', 'File not found');
    if (!payload.name) {
      return respondError(webview, 'nova:vfs:rename', requestId, 'INVALID_ARGS', 'name is required');
    }
    await FS.rename(node.id, payload.name);
    return respond(webview, 'nova:vfs:rename', requestId, { success: true, name: payload.name });
  }

  async function handleFsMove({ payload, requestId, app, webview }) {
    const broadAccess = hasVfsAccess(app.id);
    if (!hasVfsWrite(app.id)) {
      return respondError(webview, 'nova:vfs:move', requestId, 'PERMISSION_DENIED', 'vfs:write or vfs:access permission required');
    }
    const node = resolveFile(payload, app.id, true, broadAccess);
    if (!node) return respondError(webview, 'nova:vfs:move', requestId, 'NOT_FOUND', 'File not found');
    const destPath = rewriteDataPath(payload.destPath, app.id);
    const destParent = destPath ? FS.getByPath(destPath) : null;
    if (!destParent || destParent.type !== 'folder') {
      return respondError(webview, 'nova:vfs:move', requestId, 'NOT_FOUND', 'Destination folder not found');
    }
    // Same requireOwnAppData=true rule applies to the destination: a move
    // is still a mutation even though it only touches the target folder's
    // listing, not the target's own content — an app moving its own file
    // into another app's /data/<otherAppId>/ would otherwise be able to
    // plant files there despite never having write access to that folder
    // directly.
    if (!resolveFile({ id: destParent.id }, app.id, true, broadAccess)) {
      return respondError(webview, 'nova:vfs:move', requestId, 'PERMISSION_DENIED', 'Destination folder is outside this app\'s data directory or shared VFS');
    }
    await FS.move(node.id, destParent.id);
    return respond(webview, 'nova:vfs:move', requestId, { success: true, path: FS.getPath(node.id) });
  }

  // Notifications

  async function handleNotificationsShow({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:notifications', app.id)) {
      return respondError(webview, 'nova:notifications:show', requestId, 'PERMISSION_DENIED', 'device:notifications permission required');
    }
    // Notify may be absent in headless test environments. Report UNAVAILABLE
    // rather than silently claiming success — apps deserve to know. Check
    // this BEFORE the rate limit counter, otherwise an environment without
    // Notify would still burn a rate-limit slot for every call, eventually
    // throttling the app for "spamming" notifications that never actually
    // rendered anywhere.
    if (typeof Notify === 'undefined' || typeof Notify.show !== 'function') {
      return respondError(webview, 'nova:notifications:show', requestId, 'UNAVAILABLE', 'Notification service not available');
    }
    if (!checkNotificationRateLimit(app.id)) {
      return respondError(webview, 'nova:notifications:show', requestId, 'RATE_LIMITED', `Max ${NOTIF_RATE_LIMIT_MAX} notifications per minute`);
    }
    Notify.show(sanitizeNotificationPayload(payload, app.name, app.id));
    return respond(webview, 'nova:notifications:show', requestId, { success: true });
  }

  async function handleNotificationsClear({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:notifications', app.id)) {
      return respondError(webview, 'nova:notifications:clear', requestId, 'PERMISSION_DENIED', 'device:notifications permission required');
    }
    if (typeof Notify === 'undefined' || typeof Notify.clearForApp !== 'function') {
      return respondError(webview, 'nova:notifications:clear', requestId, 'UNAVAILABLE', 'Notification service not available');
    }
    Notify.clearForApp(app.id);
    return respond(webview, 'nova:notifications:clear', requestId, { success: true });
  }

  // Background wake (system:background)
  //
  // Lets a wake handler signal early completion — see AppScheduler.wake,
  // which is the only thing that ever creates the kind of sandbox this
  // gets called from. No permission check needed here: by the time this
  // sandbox exists at all, the scheduler has already verified
  // system:background before spinning it up, and this call does nothing
  // more than flip a flag the scheduler is already polling for.
  async function handleBackgroundWakeDone({ requestId, app, webview }) {
    const sandboxId = webview?.dataset?.sandboxId;
    if (sandboxId && typeof AppScheduler !== 'undefined' && typeof AppScheduler._markWakeDone === 'function') {
      AppScheduler._markWakeDone(sandboxId);
    }
    return respond(webview, 'nova:background:wake-done', requestId, { success: true });
  }

  // Background live (system:background:live)
  //
  // Opts a sandbox into being kept alive if its window closes. This is
  // the piece that was missing: closeWindow() previously backgrounded
  // *any* app holding system:background:live on every close, purely
  // because the grant existed — with no way for the app (or the user, via
  // some in-app "run in background" toggle) to say whether this
  // particular session actually wants that. Holding the permission is
  // necessary but was wrongly being treated as sufficient. Now
  // closeWindow checks this per-sandbox flag in addition to the grant.
  //
  // Deliberately session-only (not persisted): the app calls this each
  // time it wants the current session kept alive, e.g. right when the
  // user clicks its own "run in background" button. Nothing carries over
  // to the next launch automatically.
  async function handleBackgroundStayAlive({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:background:live', app.id)) {
      return respondError(webview, 'nova:background:stay-alive', requestId, 'PERMISSION_DENIED', 'system:background:live permission required');
    }
    const sandboxId = webview.dataset.sandboxId;
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox) {
      return respondError(webview, 'nova:background:stay-alive', requestId, 'UNAVAILABLE', 'Sandbox not found');
    }
    // enabled defaults true — nova.stayAliveInBackground() with no args
    // means "yes, keep me alive"; passing { enabled: false } lets an app
    // change its mind before it actually closes.
    sandbox.wantsBackgroundLive = payload?.enabled !== false;
    return respond(webview, 'nova:background:stay-alive', requestId, { success: true, enabled: sandbox.wantsBackgroundLive });
  }

  // Settings keys apps holding system:info may read. This used to be a
  // denylist (block these specific sensitive keys, allow everything else by
  // default) — structurally fragile, since every new sensitive settings key
  // added later had to be remembered and added here manually, or it was
  // exposed to any app with system:info by default. Flipped to an allowlist
  // so new keys fail closed instead of open.
  //
  // This list was built by grepping every OS.settings.get()/.set() call
  // site in the codebase (including the sGet() alias used in boot.js) as of
  // this change — it's a snapshot, not derived automatically, so it will
  // drift if a new settings key is added without updating this list too.
  // A key missing from here isn't a bug in itself (it fails closed, the
  // safe direction) but will make legitimate new settings silently
  // unreadable by apps until this list is updated.
  //
  // Deliberately excluded (must stay unreadable regardless of system:info):
  // lockPin, pinSalt, biometricCredentialId, bootPassword — credentials or
  // auth material the OS itself needs to keep private. lockoutUntil and
  // wrongPinCount are also excluded, though for a different reason: they
  // live on the in-memory OS object directly (OS.lockoutUntil,
  // OS.wrongPinCount in kernel.js/system-events.js), never through
  // OS.settings at all, so they were never reachable through this handler
  // in the first place — excluded here only for defense-in-depth in case
  // that ever changes.
  // NOTE: read (system:info) and write (system:settings) are separate,
  // higher/lower-trust grants, so they don't have to share one list.
  // osVersion is the one key here that's fine to read but shouldn't be
  // app-writable: boot.js uses it purely to track the running OS build
  // (`if (sGet('osVersion') !== codeVer) OS.settings.set('osVersion',
  // codeVer)`), and an app overwriting it via nova:settings:set could
  // interfere with that version-detection logic for no legitimate benefit.
  // SETTINGS_WRITABLE_KEYS below additionally excludes devMode, which must
  // only change through the OS-owned Settings confirmation flow.
  const SETTINGS_READABLE_KEYS = new Set([
    '_hiddenDevIconPositions', 'accentColor', 'autoLock', 'browserPartitionId',
    'clockFormat', 'cursorSize', 'customWallpaper', 'debugOverlayVisible',
    'desktopGridSpacing', 'desktopIconPositions', 'desktopIconSize', 'devMode',
    'filesViewOnly', 'highContrast', 'osVersion', 'pinnedApps',
    'prohibitWallpaperChange', 'reduceMotion', 'region', 'removeTransparency',
    'showDesktopIcons', 'showTaskbarClock', 'taskbarAutoHide', 'taskbarPosition',
    'taskbarSize', 'theme', 'timezone', 'username', 'wallpaperId',
  ]);

  const SETTINGS_WRITABLE_KEYS = new Set(
    [...SETTINGS_READABLE_KEYS].filter((k) => k !== 'osVersion' && k !== 'devMode')
  );

  async function handleSettingsGet({ payload, requestId, app, webview }) {
    // system:info gates read access — otherwise any app could read credentials
    // or other sensitive settings keys.
    if (!AppPermissionManager.isGranted('system:info', app.id)) {
      return respondError(webview, 'nova:settings:get', requestId, 'PERMISSION_DENIED', 'system:info permission required');
    }
    const key = payload?.key;
    if (typeof key !== 'string' || !key) {
      return respondError(webview, 'nova:settings:get', requestId, 'INVALID_ARGS', 'key is required');
    }
    if (!SETTINGS_READABLE_KEYS.has(key)) {
      return respondError(webview, 'nova:settings:get', requestId, 'PERMISSION_DENIED', `Settings key '${key}' is not readable by apps`);
    }
    const value = OS?.settings?.get(key);
    return respond(webview, 'nova:settings:get', requestId, { success: true, value });
  }

  async function handleSettingsSetWithType({ payload, requestId, app, webview }, type) {
    const key = payload?.key;
    if (typeof key !== 'string' || !key) {
      return respondError(webview, type, requestId, 'INVALID_ARGS', 'key is required');
    }
    // Wallpaper change is a low-risk ambient capability, not a permission
    // prompt — Android treats it the same way, any app can change the
    // wallpaper without a runtime permission. It bypasses the system:settings
    // grant but is still subject to the writable-key allowlist and the
    // prohibitWallpaperChange policy toggle (checked in OS.settings.set
    // itself, so a locked-down kiosk can still block it).
    const isWallpaperKey = key === 'wallpaperId' || key === 'customWallpaper';
    if (!isWallpaperKey && !AppPermissionManager.isGranted('system:settings', app.id)) {
      return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'system:settings permission required');
    }
    if (!SETTINGS_WRITABLE_KEYS.has(key)) {
      return respondError(webview, type, requestId, 'PERMISSION_DENIED', `Settings key '${key}' is not writable by apps`);
    }
    if (typeof OS?.settings?.set !== 'function') {
      return respondError(webview, type, requestId, 'UNAVAILABLE', 'Settings service not available');
    }
    if (OS.settings.set(key, payload?.value) === false && isWallpaperKey) {
      return respondError(webview, type, requestId, 'POLICY_BLOCKED', 'Wallpaper changes are disabled by system policy');
    }
    return respond(webview, type, requestId, { success: true });
  }

  async function handleSettingsSet(args) {
    return handleSettingsSetWithType(args, 'nova:settings:set');
  }

  async function handleWallpaperSet({ payload, requestId, app, webview }) {
    const key = payload?.key;
    if (key !== 'wallpaperId' && key !== 'customWallpaper') {
      return respondError(webview, 'nova:wallpaper:set', requestId, 'INVALID_ARGS', "key must be 'wallpaperId' or 'customWallpaper'");
    }
    return handleSettingsSetWithType({ payload, requestId, app, webview }, 'nova:wallpaper:set');
  }

  async function handleNestedWebview({ payload, requestId, app, webview, sandbox }) {
    if (!sandbox?.nestedWebviewAllowed) {
      return respondError(webview, 'nova:nested-webview', requestId, 'PERMISSION_DENIED', 'sandbox:nested-webview permission required');
    }
    const id = payload?.id;
    if (typeof id !== 'string' || !/^nvw_[a-zA-Z0-9_-]{1,80}$/.test(id)) {
      return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid nested webview id');
    }

    const views = sandbox.nestedWebviews;
    if (!(views instanceof Map)) {
      return respondError(webview, 'nova:nested-webview', requestId, 'UNAVAILABLE', 'Nested webviews are unavailable');
    }
    const action = payload?.action;
    let entry = views.get(id);

    if (action === 'discard-popup') {
      const pending = sandbox.pendingNewWindows?.get(payload.popupId);
      if (!pending) return respondError(webview, 'nova:nested-webview', requestId, 'NOT_FOUND', 'Popup request has expired');
      sandbox.pendingNewWindows.delete(payload.popupId);
      pending.discard();
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }
    if (action === 'attach-popup') {
      const pending = sandbox.pendingNewWindows?.get(payload.popupId);
      if (!pending || !entry) return respondError(webview, 'nova:nested-webview', requestId, 'NOT_FOUND', 'Popup request or nested webview does not exist');
      sandbox.pendingNewWindows.delete(payload.popupId);
      pending.attach(entry.view);
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }

    if (action === 'create') {
      if (entry) return respond(webview, 'nova:nested-webview', requestId, { success: true });
      const parent = sandbox.state?.content;
      if (!parent?.isConnected) {
        return respondError(webview, 'nova:nested-webview', requestId, 'UNAVAILABLE', 'App window is unavailable');
      }

      const attrs = payload.attributes && typeof payload.attributes === 'object' ? payload.attributes : {};
      if (typeof attrs.src === 'string' && attrs.src && !canNestedWebviewNavigate(app, attrs.src)) {
        return respondError(webview, 'nova:nested-webview', requestId, 'PERMISSION_DENIED', 'The app needs the matching network permission to navigate this webview');
      }
      const child = document.createElement('webview');
      child.setAttribute('nodeintegration', 'false');
      child.setAttribute('nodeintegrationsubframes', 'false');
      child.setAttribute('enableremotemodule', 'false');
      // Keep remote-site state separate from the app's own webview partition:
      // destroy() clears the latter on close for sandboxed apps, while this
      // stable partition preserves website cookies across app-window closes.
      child.setAttribute('partition', `persist:app_${app.id}_webcontent`);
      // Do not copy the outer app webview's sandbox attribute. In particular,
      // it omits allow-same-origin for app code; inheriting it here gives
      // normal websites an opaque origin and prevents their cookies and
      // persistent storage from working.
      child.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;border:0;display:none;z-index:1;';

      // The Browser hides page scrollbars for a consistent viewport, but its
      // old loadstop-only insertCSS ran after the first paint and let the
      // site's native scrollbar flash during navigation. Install the same
      // suppression at document_start for every Browser guest navigation;
      // loadstop's insertCSS remains as a final cascade override and still
      // applies the user's other page settings (zoom, inversion, font size).
      if (app.id === 'com.nbosp.browser' && typeof child.addContentScripts === 'function') {
        try {
          child.addContentScripts([{
            name: `nova-browser-scrollbar-guard-${id}`,
            matches: ['<all_urls>'],
            js: { code: `(() => {
              const css = 'html,body,*{scrollbar-width:none!important;-ms-overflow-style:none!important}' +
                '*::-webkit-scrollbar,*::-webkit-scrollbar-thumb,*::-webkit-scrollbar-track,*::-webkit-scrollbar-corner{' +
                'display:none!important;width:0!important;height:0!important;min-width:0!important;min-height:0!important}';
              const install = () => {
                const root = document.documentElement;
                if (!root) return false;
                let style = root.querySelector('style[data-nbosp-scrollbar-guard]');
                if (!style) {
                  style = document.createElement('style');
                  style.setAttribute('data-nbosp-scrollbar-guard', '');
                  style.textContent = css;
                  (root.head || root).appendChild(style);
                }
                return true;
              };
              if (!install()) {
                const observer = new MutationObserver(() => {
                  if (install()) observer.disconnect();
                });
                observer.observe(document, { childList: true, subtree: true });
              }
            })();` },
            run_at: 'document_start',
            all_frames: false,
          }]);
        } catch (error) {
          log('warn', 'Browser early scrollbar guard registration failed:', error);
        }
      }

      const cleanups = [];
      const sendEvent = (name, event) => {
        const result = { proxyId: id, eventName: name };
        for (const key of ['url', 'isTopLevel', 'reason', 'errorCode', 'errorDescription', 'validatedURL', 'targetUrl', 'disposition', 'windowOpenDisposition', 'initialWidth', 'initialHeight', 'message', 'permission']) {
          if (event?.[key] !== undefined) result[key] = event[key];
        }
        if (event?.request?.url) result.request = { url: event.request.url };
        if (event?.__novaPopupId) result.popupId = event.__novaPopupId;
        respond(webview, 'nova:nested-webview:event', id, result);
      };
      for (const name of ['loadstart', 'loadredirect', 'loadcommit', 'loadstop', 'contentload', 'loadabort', 'loaderror', 'close', 'crashed', 'exit', 'did-fail-load', 'enter-html-full-screen', 'leave-html-full-screen', 'unresponsive', 'responsive', 'permissionrequest', 'consolemessage']) {
        const listener = event => sendEvent(name, event);
        child.addEventListener(name, listener);
        cleanups.push(() => child.removeEventListener(name, listener));
      }
      const newWindowListener = event => {
        event.preventDefault();
        const popupId = generateRequestId();
        sandbox.pendingNewWindows.set(popupId, event.window);
        event.__novaPopupId = popupId;
        setTimeout(() => {
          const pending = sandbox.pendingNewWindows.get(popupId);
          if (!pending) return;
          sandbox.pendingNewWindows.delete(popupId);
          try { pending.discard(); } catch (error) { log('warn', 'Pending popup cleanup failed', error); }
        }, 30000);
        sendEvent('newwindow', event);
      };
      child.addEventListener('newwindow', newWindowListener);
      cleanups.push(() => child.removeEventListener('newwindow', newWindowListener));
      const navigationListener = event => {
        if (event?.isTopLevel === false) return;
        const destination = event?.url || event?.targetUrl || event?.validatedURL;
        if (typeof destination === 'string' && !canNestedWebviewNavigate(app, destination)) {
          event.preventDefault?.();
          sendEvent('navigation-blocked', { url: destination, reason: 'Network permission required' });
        }
      };
      child.addEventListener('will-navigate', navigationListener);
      cleanups.push(() => child.removeEventListener('will-navigate', navigationListener));
      cleanups.push(setupPermissionRequestGate(child, app));
      parent.style.position ||= 'relative';
      entry = { view: child, cleanups };
      views.set(id, entry);
      parent.appendChild(child);

      for (const name of ['allowfullscreen', 'allowpopups']) {
        if (typeof attrs[name] === 'string' && name !== 'src') child.setAttribute(name, attrs[name]);
      }
      if (typeof attrs.src === 'string' && attrs.src) child.src = attrs.src;
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }

    if (!entry) {
      return respondError(webview, 'nova:nested-webview', requestId, 'NOT_FOUND', 'Nested webview does not exist');
    }
    const child = entry.view;

    if (action === 'destroy') {
      views.delete(id);
      for (const cleanup of entry.cleanups) {
        try { cleanup(); } catch (error) { log('warn', 'Nested webview cleanup failed', error); }
      }
      child.remove();
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }

    if (action === 'bounds') {
      const bounds = payload.bounds || {};
      const requested = [bounds.left, bounds.top, bounds.width, bounds.height].map(Number);
      if (!requested.every(Number.isFinite) || requested[2] < 0 || requested[3] < 0) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid nested webview bounds');
      }
      const [requestedLeft, requestedTop, requestedWidth, requestedHeight] = requested;
      const parent = sandbox.state?.content;
      const maxWidth = Math.max(0, parent?.clientWidth || 0);
      const maxHeight = Math.max(0, parent?.clientHeight || 0);
      const left = Math.max(0, Math.min(maxWidth, requestedLeft));
      const top = Math.max(0, Math.min(maxHeight, requestedTop));
      const width = Math.min(requestedWidth, maxWidth - left);
      const height = Math.min(requestedHeight, maxHeight - top);
      const visible = bounds.visible === true && width > 0 && height > 0;
      child.style.left = `${left}px`;
      child.style.top = `${top}px`;
      child.style.width = `${width}px`;
      child.style.height = `${height}px`;
      child.style.display = visible ? 'flex' : 'none';
      child.style.visibility = bounds.visibility === 'hidden' ? 'hidden' : 'visible';
      child.style.pointerEvents = bounds.pointerEvents === 'none' ? 'none' : 'auto';
      child.style.zIndex = String(Math.max(0, Math.min(100, Number(bounds.zIndex) || 1)));
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }

    if (action === 'attribute') {
      const name = payload.name;
      if (!['allowfullscreen', 'allowpopups', 'src'].includes(name)) {
        return respondError(webview, 'nova:nested-webview', requestId, 'PERMISSION_DENIED', 'Attribute is not available on nested webviews');
      }
      if (name === 'src' && payload.remove !== true
        && (typeof payload.value !== 'string' || !canNestedWebviewNavigate(app, payload.value))) {
        return respondError(webview, 'nova:nested-webview', requestId, 'PERMISSION_DENIED', 'The app needs the matching network permission to navigate this webview');
      }
      if (payload.remove === true) child.removeAttribute(name);
      else if (typeof payload.value === 'string') child.setAttribute(name, payload.value);
      if (name === 'src' && payload.remove !== true && typeof payload.value === 'string') child.src = payload.value;
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }

    if (action !== 'command') {
      return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Unsupported nested webview operation');
    }
    const command = payload.command;
    if (command === 'reload') child.reload();
    else if (command === 'back') child.back();
    else if (command === 'forward') child.forward();
    else if (command === 'stop') child.stop();
    else if (command === 'canGoBack' || command === 'canGoForward') {
      const method = child[command];
      if (typeof method !== 'function') {
        return respondError(webview, 'nova:nested-webview', requestId, 'UNAVAILABLE', `${command} is not supported by this webview`);
      }
      return respond(webview, 'nova:nested-webview', requestId, { value: Boolean(method.call(child)) });
    }
    else if (command === 'find') {
      const query = payload.query;
      const options = payload.options && typeof payload.options === 'object' ? payload.options : {};
      if (typeof query !== 'string' || !query.trim() || query.length > 1000
        || Object.keys(options).some(key => !['backward', 'matchCase', 'wordStart', 'medialCapitalAsWordStart'].includes(key))
        || Object.values(options).some(value => typeof value !== 'boolean')) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid page-find query or options');
      }
      if (typeof child.find !== 'function') {
        return respondError(webview, 'nova:nested-webview', requestId, 'UNAVAILABLE', 'Page find is not supported by this webview');
      }
      const result = await new Promise((resolve, reject) => {
        try { child.find(query, options, resolve); } catch (error) { reject(error); }
      });
      return respond(webview, 'nova:nested-webview', requestId, result);
    }
    else if (command === 'stopFinding') {
      const action = payload.value || 'clear';
      if (!['clear', 'keep', 'activate'].includes(action)) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid stop-finding action');
      }
      if (typeof child.stopFinding !== 'function') {
        return respondError(webview, 'nova:nested-webview', requestId, 'UNAVAILABLE', 'Page find is not supported by this webview');
      }
      child.stopFinding(action);
    }
    else if (command === 'setUserAgentOverride') {
      const userAgent = payload.value;
      if (typeof userAgent !== 'string' || userAgent.length > 512) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid user-agent string');
      }
      if (typeof child.setUserAgentOverride !== 'function') {
        return respondError(webview, 'nova:nested-webview', requestId, 'UNAVAILABLE', 'User-agent overrides are not supported by this webview');
      }
      child.setUserAgentOverride(userAgent);
    }
    else if (command === 'setZoom') {
      const zoom = Number(payload.value);
      if (!Number.isFinite(zoom) || zoom < 0.25 || zoom > 5) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid zoom factor');
      }
      child.setZoom(zoom);
    }
    else if (command === 'setZoomMode') {
      if (!['per-view', 'per-origin', 'automatic'].includes(payload.value)) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid zoom mode');
      }
      child.setZoomMode(payload.value);
    }
    else if (command === 'clearData') {
      const types = Array.isArray(payload.types) ? payload.types.filter(type => typeof type === 'string') : [];
      await new Promise((resolve, reject) => {
        try { child.clearData({}, types, resolve); } catch (error) { reject(error); }
      });
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }
    else if (command === 'executeScript' || command === 'insertCSS') {
      const code = payload.details?.code;
      if (typeof code !== 'string' || code.length > 1_000_000) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid webview script');
      }
      const method = command === 'executeScript' ? child.executeScript : child.insertCSS;
      const result = await new Promise((resolve, reject) => {
        try {
          method.call(child, { code }, results => resolve(results));
        } catch (error) { reject(error); }
      });
      return respond(webview, 'nova:nested-webview', requestId, result);
    } else {
      return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Unsupported nested webview operation');
    }
    return respond(webview, 'nova:nested-webview', requestId, { success: true });
  }

  // Permission requests

  async function handleRequestPermission({ payload, requestId, app, webview }) {
    const { permission } = payload ?? {};
    if (!permission) {
      return respondError(webview, 'nova:request-permission', requestId, 'INVALID_ARGS', 'permission is required');
    }
    try {
      const granted = await AppPermissionManager.requestPermission(permission, app.id, {
        reason: payload.reason || `${app.name} wants to access this permission.`,
        permanent: payload.permanent !== false,
      });
      return respond(webview, 'nova:request-permission', requestId, { granted });
    } catch (e) {
      return respondError(webview, 'nova:request-permission', requestId, 'ERROR', e?.message || 'Permission request failed');
    }
  }

  // Lets a caller check rate-limit/cooldown status for a permission without
  // triggering a new prompt — e.g. the Permissions app showing "try again in
  // Ns" instead of blindly calling requestPermission and eating a silent deny.
  async function handlePermissionRateLimited({ payload, requestId, app, webview }) {
    const { permission } = payload ?? {};
    if (!permission) {
      return respondError(webview, 'nova:permission-rate-limited', requestId, 'INVALID_ARGS', 'permission is required');
    }
    try {
      const status = AppPermissionManager.isRateLimited(permission, app.id);
      return respond(webview, 'nova:permission-rate-limited', requestId, status);
    } catch (e) {
      return respondError(webview, 'nova:permission-rate-limited', requestId, 'ERROR', e?.message || 'Rate limit check failed');
    }
  }

  // Window management
  //
  // These all no-op silently when WM or the window state is missing, then
  // return success. This matches the original behaviour — window operations
  // are best-effort from the app's perspective.

  async function handleWindowClose({ requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId && typeof WM !== 'undefined' && typeof WM.closeWindow === 'function') {
      WM.closeWindow(windowId);
    }
    return respond(webview, 'nova:window:close', requestId, { success: true });
  }

  async function handleWindowMinimize({ requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId && typeof WM !== 'undefined' && typeof WM.minimizeWindow === 'function') {
      WM.minimizeWindow(windowId);
    }
    return respond(webview, 'nova:window:minimize', requestId, { success: true });
  }

  async function handleWindowMaximize({ requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId && typeof WM !== 'undefined' && typeof WM.toggleMaximize === 'function') {
      WM.toggleMaximize(windowId);
    }
    return respond(webview, 'nova:window:maximize', requestId, { success: true });
  }

  async function handleWindowSetTitle({ payload, requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId && OS?.windows?.get) {
      const state = OS.windows.get(windowId);
      if (state && state.titleText) {
        // Cap the title so an app can't blow the title bar's layout or
        // OOM the WM's title-state tracking with a multi-megabyte string.
        const title = String(payload?.title ?? '').slice(0, 200);
        state.titleText.textContent = title;
      }
    }
    return respond(webview, 'nova:window:setTitle', requestId, { success: true });
  }

  async function handleWindowResize({ payload, requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId && OS?.windows?.get) {
      const state = OS.windows.get(windowId);
      if (state && state.element) {
        // parseInt with explicit radix and a minimum bound to prevent
        // zero/negative sizes that would render the window unusable.
        const w = parsePositiveInt(payload?.width, DEFAULT_WINDOW_WIDTH, MIN_WINDOW_DIMENSION);
        const h = parsePositiveInt(payload?.height, DEFAULT_WINDOW_HEIGHT, MIN_WINDOW_DIMENSION);
        state.element.style.width = w + 'px';
        state.element.style.height = h + 'px';
        state.width = w;
        state.height = h;
        if (state.maximized) {
          state.maximized = false;
          state.element.classList.remove('maximized');
        }
      }
    }
    return respond(webview, 'nova:window:resize', requestId, { success: true });
  }

  async function handleWindowGetState({ requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    const state = windowId && OS?.windows?.get ? OS.windows.get(windowId) : null;
    if (!state) {
      return respondError(webview, 'nova:window:getState', requestId, 'NOT_FOUND', 'Window not found');
    }
    return respond(webview, 'nova:window:getState', requestId, {
      success: true,
      id: state.id,
      x: state.x, y: state.y,
      width: state.width, height: state.height,
      maximized: !!state.maximized,
      minimized: !!state.minimized,
    });
  }

  // Clipboard

  // The system clipboard is a shared, ambient, cross-app channel — it can
  // contain whatever any other app, or the user, copied moments ago from
  // anywhere, including outside this sandbox model entirely. Gating it on
  // vfs:read ("read files") was a misleading label for "also read whatever's
  // currently on the system clipboard," and meant granting file access
  // silently granted clipboard snooping too.
  //
  // Now gated on its own clipboard:read/clipboard:write permissions instead.
  // vfs:read is kept as a fallback ONLY for apps that were already granted
  // it before this change shipped — those grants live in each user's local
  // permission store, which this patch has no way to inspect or migrate, so
  // a hard cutover would silently break clipboard access for any app that
  // already had file access and expected clipboard to come with it. Any
  // newly-installed app, or any app whose permissions are re-requested,
  // should declare clipboard:read/clipboard:write directly rather than
  // relying on this compatibility fallback. Reading is sensitive; writing
  // is low-risk and auto-granted when declared.
  function clipboardReadPermitted(appId) {
    return AppPermissionManager.isGranted('clipboard:read', appId)
      || AppPermissionManager.isGranted('vfs:read', appId);
  }
  function clipboardWritePermitted(appId) {
    return AppPermissionManager.isGranted('clipboard:write', appId)
      || AppPermissionManager.isGranted('vfs:read', appId);
  }

  async function handleClipboardRead({ requestId, app, webview }) {
    if (!clipboardReadPermitted(app.id)) {
      return respondError(webview, 'nova:clipboard:read', requestId, 'PERMISSION_DENIED', 'clipboard:read permission required for clipboard access');
    }
    let text = null;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      // No permission / no focus / insecure context — fall back to the
      // last value this OS instance itself wrote, rather than failing
      // outright, so same-session copy/paste inside Nova still works.
      text = OS.clipboard || null;
    }
    return respond(webview, 'nova:clipboard:read', requestId, {
      success: true,
      text: text,
    });
  }

  async function handleClipboardWrite({ payload, requestId, app, webview }) {
    if (!clipboardWritePermitted(app.id)) {
      return respondError(webview, 'nova:clipboard:write', requestId, 'PERMISSION_DENIED', 'clipboard:write permission required for clipboard access');
    }
    // ?? not || — a payload of { text: 0 } or { text: false } should still
    // write a real value, not silently become the empty-string default.
    const text = payload?.text ?? '';
    try {
      // Actually write to the real system clipboard. navigator.clipboard
      // requires a secure context + (usually) a recent user gesture; if it
      // rejects (no focus, no gesture, permission denied), fall back to the
      // legacy execCommand path before giving up entirely.
      await navigator.clipboard.writeText(text);
    } catch (err) {
      // try/finally ensures the textarea is always removed from the DOM
      // even if select() or execCommand throws — the previous version
      // leaked the element on a select() failure.
      let ok = false;
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      try {
        ta.focus();
        ta.select();
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      } finally {
        ta.remove();
      }
      if (!ok) {
        return respondError(webview, 'nova:clipboard:write', requestId, 'CLIPBOARD_UNAVAILABLE', 'Could not write to the system clipboard: ' + (err && err.message ? err.message : String(err)));
      }
    }
    OS.clipboard = text;
    if (!OS.clipboardHistory) OS.clipboardHistory = [];
    if (typeof text === 'string' && text && !OS.clipboardHistory.includes(text)) {
      OS.clipboardHistory.unshift(text);
      if (OS.clipboardHistory.length > CLIPBOARD_HISTORY_MAX) OS.clipboardHistory.pop();
    }
    return respond(webview, 'nova:clipboard:write', requestId, { success: true });
  }

  // Downloads
  //
  // <webview> guests can't reach the host's real filesystem or trigger a
  // native save dialog directly (they're intentionally non-Node frames —
  // see nodeintegration=false above). The capability shim in a guest
  // intercepts <a download> clicks on blob: URLs, reads the blob bytes,
  // and ships them here as base64. This handler is what actually shows
  // the native "Save As" dialog and writes the bytes to disk — it only
  // runs in the top-level shell window, which IS a Node frame, so
  // nwsaveas and Node's fs module both work here.
  //
  // No standing permission is required for this — the native save dialog
  // itself is the control: the app can propose a filename and bytes, but
  // the user always sees and confirms the real destination before
  // anything touches disk. That mirrors how a normal browser download
  // works, and is a deliberate departure from the vfs:write pattern
  // above, which writes into novabyte-os's own virtual FS without a
  // per-write prompt.
  const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100MB — generous for a
  // vault export or similar; guards against a runaway/misbehaving app
  // trying to stream something enormous through the IPC bridge.

  function sanitizeDownloadFilename(name) {
    const fallback = 'download';
    if (!name || typeof name !== 'string') return fallback;
    // Strip any path components — this is a filename, not a path. Also
    // strip null bytes and other control characters some OSes mishandle.
    let base = name.replace(/[\\/]/g, '_').replace(/[\x00-\x1f]/g, '').trim();
    base = base.replace(/^\.+/, ''); // no leading dots (hidden files / '..' games)
    if (!base) return fallback;
    return base.slice(0, 255); // filesystem-safe length cap
  }

  async function handleDownload({ payload, requestId, app, webview }) {
    const { filename, mimeType, base64Data } = payload ?? {};
    if (typeof base64Data !== 'string' || !base64Data) {
      return respondError(webview, 'nova:download', requestId, 'INVALID_ARGS', 'base64Data is required');
    }
    let buffer;
    try {
      buffer = Buffer.from(base64Data, 'base64');
    } catch {
      return respondError(webview, 'nova:download', requestId, 'INVALID_ARGS', 'base64Data is not valid base64');
    }
    if (buffer.length > MAX_DOWNLOAD_BYTES) {
      return respondError(webview, 'nova:download', requestId, 'INVALID_ARGS', `Download exceeds ${MAX_DOWNLOAD_BYTES} byte limit`);
    }

    const safeName = sanitizeDownloadFilename(filename);

    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.setAttribute('nwsaveas', safeName);
      input.style.display = 'none';
      document.body.appendChild(input);

      // Cap how long we wait for the save dialog — if the user walks away
      // without dismissing it, the IPC call would otherwise hang forever
      // (the guest's shim has its own 10-min timeout, but the host-side
      // promise has none). 5 minutes is generous for a save decision and
      // short enough that a truly forgotten dialog surfaces as an error
      // rather than a zombie promise.
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        input.remove();
        respondError(webview, 'nova:download', requestId, 'TIMEOUT', 'Save dialog timed out');
        resolve();
      }, DOWNLOAD_DIALOG_TIMEOUT_MS);

      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        input.remove();
        fn();
        resolve();
      };

      input.addEventListener('change', () => {
        const savePath = input.value;
        if (!savePath) {
          finish(() => respond(webview, 'nova:download', requestId, { success: false, cancelled: true }));
          return;
        }
        // Lazy-require fs: this handler only runs in the top-level shell
        // window (a Node frame), so require() is expected to exist. If it
        // doesn't (test/headless env missing Node integration), surface
        // that as an explicit error rather than a ReferenceError.
        if (typeof require !== 'function') {
          finish(() => respondError(webview, 'nova:download', requestId, 'UNAVAILABLE', 'Node fs module not available in this context'));
          return;
        }
        let fs;
        try { fs = require('fs'); } catch (e) {
          finish(() => respondError(webview, 'nova:download', requestId, 'UNAVAILABLE', `Could not load fs module: ${e?.message || e}`));
          return;
        }
        fs.writeFile(savePath, buffer, (err) => {
          if (err) {
            finish(() => respondError(webview, 'nova:download', requestId, 'IO_ERROR', err?.message || 'Failed to write file'));
          } else {
            if (typeof EventLog !== 'undefined') {
              EventLog.log({
                app: 'AppSandbox',
                category: 'downloads',
                severity: 'info',
                message: `${app?.id || 'unknown'}: saved download "${safeName}" (${buffer.length} bytes)`,
                data: { appId: app?.id, filename: safeName, size: buffer.length, mimeType: mimeType || null },
              });
            }
            finish(() => respond(webview, 'nova:download', requestId, { success: true }));
          }
        });
      }, { once: true });

      // 'cancel' fires if the user dismisses the dialog without choosing a path.
      input.addEventListener('cancel', () => {
        finish(() => respond(webview, 'nova:download', requestId, { success: false, cancelled: true }));
      }, { once: true });

      input.click();
    });
  }

  // App lifecycle

  const crossAppLaunchRateLimits = new Map();
  const HOME_ALWAYS_LAUNCHABLE_APP_IDS = new Set([
    'com.nbosp.settings',
    'com.nbosp.appmanager',
  ]);

  async function handleAppLaunch({ payload, requestId, app, webview }) {
    // Launching an installed app is a separate, low-risk capability from
    // enumerating, installing, or uninstalling applications.
    if (!AppPermissionManager.isGranted('system:app-launch', app.id)
      && !AppPermissionManager.isGranted('system:apps', app.id)) {
      return respondError(webview, 'nova:app:launch', requestId, 'PERMISSION_DENIED', 'system:app-launch permission required');
    }
    const now = Date.now();
    const launchTimes = (crossAppLaunchRateLimits.get(app.id) || []).filter(time => time > now - 60_000);
    if (launchTimes.length >= 6) {
      crossAppLaunchRateLimits.set(app.id, launchTimes);
      return respondError(webview, 'nova:app:launch', requestId, 'RATE_LIMITED', 'Max 6 cross-app launches per minute');
    }
    const { appId, options } = payload ?? {};
    if (!appId) {
      return respondError(webview, 'nova:app:launch', requestId, 'INVALID_ARGS', 'appId is required');
    }
    if (!OS?.settings?.get?.('devMode')) {
      const target = OS?.apps?.[appId];
      if (target?.devOnly) {
        return respondError(webview, 'nova:app:launch', requestId, 'PERMISSION_DENIED', 'Developer Mode must be enabled to launch this app');
      }
    }
    try {
      if (typeof WM === 'undefined' || typeof WM.createWindow !== 'function') {
        return respondError(webview, 'nova:app:launch', requestId, 'UNAVAILABLE', 'Window manager not available');
      }
      const launchOptions = options && typeof options === 'object' && !Array.isArray(options)
        ? { ...options }
        : {};
      // File access must come from a host user-selection flow, never app-supplied launch options.
      delete launchOptions.fileIntent;
      delete launchOptions.fileId;
      delete launchOptions.folderId;
      const win = WM.createWindow(appId, launchOptions);
      launchTimes.push(now);
      crossAppLaunchRateLimits.set(app.id, launchTimes);
      return respond(webview, 'nova:app:launch', requestId, {
        success: !!win,
        windowId: win ? win.id : null,
      });
    } catch (e) {
      return respondError(webview, 'nova:app:launch', requestId, 'ERROR', e?.message || 'Launch failed');
    }
  }

  function isActiveHomeCaller(app, sandbox) {
    return !!app?.id
      && sandbox?.homeSurface === true
      && typeof DefaultApps !== 'undefined'
      && DefaultApps.getDefault('home') === app.id;
  }

  function getHomeAppListEntry(app) {
    return {
      id: app.id,
      name: app.name || app.id,
      version: app.version || '1.0.0',
      iconUrl: resolveSandboxAppIcon(app.icon),
      description: app.description || '',
      categories: Array.isArray(app.categories) ? app.categories.slice() : [],
      system: app.system === true || app.manifest?.system === true,
    };
  }

  async function handleHomeAppsList({ requestId, app, sandbox, webview }) {
    if (!isActiveHomeCaller(app, sandbox)) {
      return respondError(webview, 'nova:home:apps:list', requestId, 'PERMISSION_DENIED', 'Only the currently selected Home app can list apps');
    }
    if (typeof APP_REGISTRY === 'undefined' || !Array.isArray(APP_REGISTRY)) {
      return respondError(webview, 'nova:home:apps:list', requestId, 'UNAVAILABLE', 'App registry not available');
    }

    const canListAll = AppPermissionManager.isGranted('system:apps', app.id);
    const apps = APP_REGISTRY.filter(candidate =>
      (canListAll || HOME_ALWAYS_LAUNCHABLE_APP_IDS.has(candidate.id))
      && (OS?.settings?.get?.('devMode') || candidate.devOnly !== true)
    ).map(getHomeAppListEntry);
    return respond(webview, 'nova:home:apps:list', requestId, {
      success: true,
      apps,
      fullAccess: canListAll,
    });
  }

  async function handleHomeAppsLaunch({ payload, requestId, app, sandbox, webview }) {
    if (!isActiveHomeCaller(app, sandbox)) {
      return respondError(webview, 'nova:home:apps:launch', requestId, 'PERMISSION_DENIED', 'Only the currently selected Home app can launch apps');
    }
    const appId = typeof payload?.appId === 'string' ? payload.appId : '';
    if (!appId) {
      return respondError(webview, 'nova:home:apps:launch', requestId, 'INVALID_ARGS', 'appId is required');
    }

    const registryEntry = typeof APP_REGISTRY !== 'undefined' && Array.isArray(APP_REGISTRY)
      ? APP_REGISTRY.find(candidate => candidate.id === appId)
      : null;
    const target = OS?.apps?.[appId];
    if (!registryEntry || !target) {
      return respondError(webview, 'nova:home:apps:launch', requestId, 'NOT_FOUND', 'App is not registered');
    }
    if (!OS?.settings?.get?.('devMode') && (registryEntry.devOnly === true || target.devOnly === true)) {
      return respondError(webview, 'nova:home:apps:launch', requestId, 'PERMISSION_DENIED', 'Developer Mode must be enabled to launch this app');
    }
    const hasLaunchPermission = AppPermissionManager.isGranted('system:app-launch', app.id)
      || AppPermissionManager.isGranted('system:apps', app.id);
    if (!HOME_ALWAYS_LAUNCHABLE_APP_IDS.has(appId) && !hasLaunchPermission) {
      return respondError(webview, 'nova:home:apps:launch', requestId, 'PERMISSION_DENIED', 'system:app-launch permission required for this app');
    }

    const now = Date.now();
    const launchTimes = (crossAppLaunchRateLimits.get(app.id) || []).filter(time => time > now - 60_000);
    if (launchTimes.length >= 6) {
      crossAppLaunchRateLimits.set(app.id, launchTimes);
      return respondError(webview, 'nova:home:apps:launch', requestId, 'RATE_LIMITED', 'Max 6 Home app launches per minute');
    }
    try {
      if (typeof WM === 'undefined' || typeof WM.createWindow !== 'function') {
        return respondError(webview, 'nova:home:apps:launch', requestId, 'UNAVAILABLE', 'Window manager not available');
      }
      const win = WM.createWindow(appId);
      if (win) {
        launchTimes.push(now);
        crossAppLaunchRateLimits.set(app.id, launchTimes);
      }
      return respond(webview, 'nova:home:apps:launch', requestId, {
        success: !!win,
        windowId: win ? win.id : null,
      });
    } catch (error) {
      return respondError(webview, 'nova:home:apps:launch', requestId, 'ERROR', error?.message || 'Launch failed');
    }
  }

  async function handleEmailOpenLink({ payload, requestId, app, webview }) {
    if (app.id !== 'com.nbosp.email' || app.verified !== true || app.signer !== 'NovaByte System' || app.manifest?.system !== true) {
      return respondError(webview, 'nova:email:open-link', requestId, 'PERMISSION_DENIED', 'Email link bridge denied');
    }

    let url;
    try {
      url = new URL(payload?.url);
    } catch {
      return respondError(webview, 'nova:email:open-link', requestId, 'INVALID_ARGS', 'A valid HTTP(S) URL is required');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return respondError(webview, 'nova:email:open-link', requestId, 'INVALID_ARGS', 'Only credential-free HTTP(S) links can be opened');
    }

    try {
      const win = WM.createWindow('com.nbosp.browser', { url: url.href });
      if (!win) {
        return respondError(webview, 'nova:email:open-link', requestId, 'UNAVAILABLE', 'Browser could not be opened');
      }
      return respond(webview, 'nova:email:open-link', requestId, { success: true, windowId: win.id });
    } catch (e) {
      return respondError(webview, 'nova:email:open-link', requestId, 'ERROR', e?.message || 'Could not open Browser');
    }
  }

  async function handleOpenUrl({ payload, requestId, webview }) {
    let url;
    try {
      url = new URL(payload?.url);
    } catch {
      return respondError(webview, 'nova:open-url', requestId, 'INVALID_ARGS', 'A valid HTTP(S) URL is required');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return respondError(webview, 'nova:open-url', requestId, 'INVALID_ARGS', 'Only credential-free HTTP(S) links can be opened');
    }
    if (typeof OS?.openUrl !== 'function') {
      return respondError(webview, 'nova:open-url', requestId, 'UNAVAILABLE', 'OS URL service not available');
    }
    try {
      const win = OS.openUrl(url.href);
      if (!win) {
        return respondError(webview, 'nova:open-url', requestId, 'UNAVAILABLE', 'No default browser app could be opened');
      }
      return respond(webview, 'nova:open-url', requestId, { success: true, windowId: win.id });
    } catch (e) {
      return respondError(webview, 'nova:open-url', requestId, 'ERROR', e?.message || 'Could not open the OS default browser app');
    }
  }

  async function handleOpenWith({ payload, requestId, app, webview, sandbox }) {
    const fileId = payload?.fileId;
    if (typeof fileId !== 'string' || !fileId || fileId.length > 200) {
      return respondError(webview, 'nova:open-with', requestId, 'INVALID_ARGS', 'A fileId is required');
    }
    const node = getOpenFileForSandbox(sandbox, { id: fileId })
      || resolveFile({ id: fileId }, app.id);
    if (!node || node.type !== 'file') {
      return respondError(webview, 'nova:open-with', requestId, 'NOT_FOUND', 'File is unavailable to this app');
    }
    if (typeof window.showOpenWithDialog !== 'function') {
      return respondError(webview, 'nova:open-with', requestId, 'UNAVAILABLE', 'Open with chooser is unavailable');
    }
    try {
      const result = await window.showOpenWithDialog(node);
      return respond(webview, 'nova:open-with', requestId, result || { cancelled: true });
    } catch (error) {
      return respondError(webview, 'nova:open-with', requestId, 'ERROR', error?.message || 'Could not open the file chooser');
    }
  }

  const shareRateLimits = new Map();
  function handleShare({ payload, requestId, app, webview }) {
    const text = typeof payload?.text === 'string' ? payload.text : '';
    const title = typeof payload?.title === 'string' ? payload.title.slice(0, 120) : app?.name || 'Share';
    let url = '';
    if (payload?.url !== undefined) {
      try {
        const parsed = new URL(payload.url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
        url = parsed.href;
      } catch {
        return respondError(webview, 'nova:share', requestId, 'INVALID_ARGS', 'url must be a credential-free HTTP(S) URL');
      }
    }
    if ((!text && !url) || text.length > 4000) {
      return respondError(webview, 'nova:share', requestId, 'INVALID_ARGS', 'Share requires text or a URL; text is limited to 4000 characters');
    }
    const now = Date.now();
    const recent = (shareRateLimits.get(app.id) || []).filter(time => time > now - 60_000);
    if (recent.length >= 5) {
      shareRateLimits.set(app.id, recent);
      return respondError(webview, 'nova:share', requestId, 'RATE_LIMITED', 'Max 5 share sheets per minute');
    }
    recent.push(now);
    shareRateLimits.set(app.id, recent);
    if (!document?.body) {
      return respondError(webview, 'nova:share', requestId, 'UNAVAILABLE', 'Share sheet is not available');
    }

    const overlay = document.createElement('div');
    const sandboxId = webview?.dataset?.sandboxId;
    overlay.setAttribute('role', 'presentation');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px;';
    const dialog = document.createElement('section');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Share');
    dialog.style.cssText = 'width:min(420px,100%);padding:20px;border-radius:14px;background:var(--surface,#242424);color:var(--text,#fff);box-shadow:0 18px 60px #0008;font:14px system-ui,sans-serif;';
    const heading = document.createElement('h2');
    heading.textContent = title;
    heading.style.cssText = 'font-size:18px;margin:0 0 8px;';
    const preview = document.createElement('p');
    preview.textContent = text || url;
    preview.style.cssText = 'margin:0 0 16px;overflow-wrap:anywhere;opacity:.8;max-height:100px;overflow:auto;';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:grid;gap:8px;';
    dialog.append(heading, preview, actions);
    overlay.appendChild(dialog);

    return new Promise(resolve => {
      let settled = false;
      let cancelShare;
      const untrack = () => {
        const dialogs = shareDialogs.get(sandboxId);
        if (!dialogs) return;
        dialogs.delete(cancelShare);
        if (dialogs.size === 0) shareDialogs.delete(sandboxId);
      };
      const finish = result => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKeyDown);
        overlay.remove();
        untrack();
        respond(webview, 'nova:share', requestId, result);
        resolve();
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKeyDown);
        overlay.remove();
        untrack();
        respondError(webview, 'nova:share', requestId, 'SHARE_FAILED', error?.message || String(error));
        resolve();
      };
      const onKeyDown = event => {
        if (event.key === 'Escape') finish({ cancelled: true });
      };
      const addAction = (label, action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.style.cssText = 'min-height:40px;padding:8px 12px;border:1px solid #ffffff22;border-radius:8px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;';
        button.addEventListener('click', async () => {
          try {
            const result = await action();
            finish({ cancelled: false, action: label, ...result });
          } catch (error) {
            fail(error);
          }
        });
        actions.appendChild(button);
      };
      if (text || url) {
        addAction('Copy', async () => {
          const value = [text, url].filter(Boolean).join('\n');
          OS.clipboard = value;
          OS.clipboardHistory ||= [];
          if (!OS.clipboardHistory.includes(value)) {
            OS.clipboardHistory.unshift(value);
            if (OS.clipboardHistory.length > 30) OS.clipboardHistory.pop();
          }
          return {};
        });
      }
      if (url && typeof OS?.openUrl === 'function') {
        addAction('Open link in browser', () => {
          if (!OS.openUrl(url)) throw new Error('Could not open the default browser');
          return {};
        });
      }
      if (typeof OS?.openMailto === 'function') {
        addAction('Email', () => {
          const body = [text, url].filter(Boolean).join('\n');
          OS.openMailto('mailto:?subject=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body));
          return {};
        });
      }
      addAction('Cancel', async () => ({ cancelled: true }));
      overlay.addEventListener('click', event => {
        if (event.target === overlay) finish({ cancelled: true });
      });
      document.addEventListener('keydown', onKeyDown);
      document.body.appendChild(overlay);
      cancelShare = () => finish({ cancelled: true });
      if (sandboxId) {
        let dialogs = shareDialogs.get(sandboxId);
        if (!dialogs) shareDialogs.set(sandboxId, dialogs = new Set());
        dialogs.add(cancelShare);
      }
      actions.querySelector('button')?.focus();
    });
  }

  // Lets an app send the user to Settings → Default Apps — the "Set as
  // default" button pattern every OS has (Windows' "Make default" link in
  // an installer, Android apps deep-linking into
  // Settings > Apps > Default apps). The app cannot change the default
  // itself; it can only bring the user to the picker, same as the real
  // thing — the actual choice always happens through a human clicking an
  // option in nook, never through this call.
  //
  // On the *why this can't require a genuine click* point: this handler
  // runs after the request has already crossed the sandboxed webview's
  // MessageChannel port (see setupAPIBridge / claimHandshake above). A
  // browser's real click-to-postMessage user-activation state is not
  // preserved across that boundary — nothing server-side can distinguish
  // "app.apps.openDefaultAppsSettings() called from a real onclick" from
  // "called from setInterval." Treating the guest as untrusted (which the
  // whole sandbox already does) means we can't lean on the guest telling
  // us it was a click. The mitigation actually available at this layer is
  // the same one used for notifications: a sliding-window rate limit, so
  // a misbehaving app can steal window focus at most a few times a minute
  // instead of in a tight loop.
  const DEFAULT_APPS_RATE_LIMIT_MAX = 3;
  const DEFAULT_APPS_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
  const defaultAppsRateLimitLog = new Map();

  function checkDefaultAppsRateLimit(appId) {
    const now = Date.now();
    const windowStart = now - DEFAULT_APPS_RATE_LIMIT_WINDOW_MS;
    const timestamps = (defaultAppsRateLimitLog.get(appId) ?? []).filter((ts) => ts > windowStart);
    if (timestamps.length >= DEFAULT_APPS_RATE_LIMIT_MAX) {
      defaultAppsRateLimitLog.set(appId, timestamps);
      return false;
    }
    timestamps.push(now);
    defaultAppsRateLimitLog.set(appId, timestamps);
    return true;
  }

  function clearDefaultAppsRateLimit(appId) {
    defaultAppsRateLimitLog.delete(appId);
  }

  async function handleOpenDefaultAppsSettings({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:apps', app.id)) {
      return respondError(webview, 'nova:app:openDefaultAppsSettings', requestId, 'PERMISSION_DENIED', 'system:apps permission required');
    }
    if (!checkDefaultAppsRateLimit(app.id)) {
      return respondError(webview, 'nova:app:openDefaultAppsSettings', requestId, 'RATE_LIMITED', `Max ${DEFAULT_APPS_RATE_LIMIT_MAX} per minute`);
    }
    // category is optional and purely a UI hint (which row nook scrolls to
    // / highlights) — it is never used to decide anything on the app's
    // behalf, and an unrecognized value is just ignored by nook rather
    // than rejected here, since the category list can grow over time.
    const category = (payload && typeof payload.category === 'string') ? payload.category : null;
    try {
      if (typeof WM === 'undefined' || typeof WM.createWindow !== 'function') {
        return respondError(webview, 'nova:app:openDefaultAppsSettings', requestId, 'UNAVAILABLE', 'Window manager not available');
      }
      const win = WM.createWindow('com.nbosp.settings', { section: 'default-apps', highlightCategory: category, requestingAppId: app.id });
      return respond(webview, 'nova:app:openDefaultAppsSettings', requestId, {
        success: !!win,
        windowId: win ? win.id : null,
      });
    } catch (e) {
      return respondError(webview, 'nova:app:openDefaultAppsSettings', requestId, 'ERROR', e?.message || 'Failed to open Settings');
    }
  }

  async function handleHomeOpenDefaultAppsSettings({ requestId, app, sandbox, webview }) {
    if (!sandbox?.homeSurface || typeof DefaultApps === 'undefined'
      || DefaultApps.getDefault('home') !== app?.id) {
      return respondError(webview, 'nova:home:openDefaultAppsSettings', requestId, 'PERMISSION_DENIED', 'Only the currently selected Home app can open Home settings');
    }
    if (!checkDefaultAppsRateLimit(app.id)) {
      return respondError(webview, 'nova:home:openDefaultAppsSettings', requestId, 'RATE_LIMITED', `Max ${DEFAULT_APPS_RATE_LIMIT_MAX} per minute`);
    }
    try {
      if (typeof WM === 'undefined' || typeof WM.createWindow !== 'function') {
        return respondError(webview, 'nova:home:openDefaultAppsSettings', requestId, 'UNAVAILABLE', 'Window manager not available');
      }
      const win = WM.createWindow('com.nbosp.settings', {
        section: 'default-apps',
        highlightCategory: 'home',
        requestingAppId: app.id,
      });
      return respond(webview, 'nova:home:openDefaultAppsSettings', requestId, {
        success: !!win,
        windowId: win ? win.id : null,
      });
    } catch (error) {
      return respondError(webview, 'nova:home:openDefaultAppsSettings', requestId, 'ERROR', error?.message || 'Failed to open Home settings');
    }
  }



  async function handleAppInfo({ requestId, app, webview }) {
    if (!app) {
      return respondError(webview, 'nova:app:info', requestId, 'UNAVAILABLE', 'No app context');
    }
    return respond(webview, 'nova:app:info', requestId, {
      success: true,
      id: app.id,
      name: app.name,
      version: app.version,
      icon: app.icon,
      type: app.type,
      permissions: app.permissions || [],
      optionalPermissions: app.optionalPermissions || [],
    });
  }


  async function clockService() {
    for (let i = 0; i < 20; i++) {
      const svc = window.__NBOSP_BG?.clock;
      if (svc) { svc.ensureBooted?.(); return svc; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Clock background service unavailable');
  }
  async function clockSnapshot() {
    const svc = await clockService();
    const st = svc.state || {};
    return {
      timer: { ...(st.timer || {}) },
      stopwatch: { ...(st.stopwatch || {}), laps: Array.isArray(st.stopwatch?.laps) ? st.stopwatch.laps.slice() : [] },
      lastAlarmMinute: typeof st.lastAlarmMinute === 'string' ? st.lastAlarmMinute : ''
    };
  }
  async function handleClockStateGet({ requestId, webview }) {
    return respond(webview, 'nova:clock:state:get', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockStatePersist({ requestId, webview }) {
    const svc = await clockService();
    svc.persist?.();
    return respond(webview, 'nova:clock:state:persist', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockAlarmsGet({ requestId, webview }) {
    const alarms = (await clockService()).loadAlarms?.() || [];
    return respond(webview, 'nova:clock:alarms:get', requestId, { success: true, alarms });
  }
  async function handleClockAlarmsSet({ payload, requestId, webview }) {
    const alarms = Array.isArray(payload?.alarms) ? payload.alarms : [];
    const svc = await clockService();
    svc.saveAlarms?.(alarms);
    return respond(webview, 'nova:clock:alarms:set', requestId, { success: true, alarms: svc.loadAlarms?.() || [] });
  }

  async function handleClockAlarmDialog({ payload, requestId, webview }) {
    try {
      const src = payload?.alarm && typeof payload.alarm === 'object' ? payload.alarm : {};
      const body = document.createElement('div');
      body.className = 'clock-native-alarm-body';
      body.style.cssText = 'display:flex;flex-direction:column;width:320px;max-width:100%;';

      const time = document.createElement('input');
      time.type = 'time';
      time.className = 'input clock-native-alarm-time';
      time.value = /^\d{2}:\d{2}$/.test(src.time || '') ? src.time : '07:00';
      time.setAttribute('aria-label', 'Alarm time');

      const label = document.createElement('input');
      label.type = 'text';
      label.className = 'input';
      label.maxLength = 64;
      label.value = typeof src.label === 'string' ? src.label : '';
      label.placeholder = 'Label (optional)';
      label.setAttribute('aria-label', 'Alarm label');

      const repeat = document.createElement('div');
      repeat.className = 'clock-native-alarm-repeat-title';
      repeat.textContent = 'Repeat';

      const daysWrap = document.createElement('div');
      daysWrap.className = 'clock-native-alarm-days';
      const days = ['S','M','T','W','T','F','S'];
      const fullDays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const selected = Array.isArray(src.days) ? src.days.map(Number) : [];
      for (let i = 0; i < 7; i++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'clock-native-alarm-day';
        b.title = fullDays[i];
        b.textContent = days[i];
        b.dataset.clockDay = String(i);
        b.dataset.clockSelected = selected.includes(i) ? 'true' : 'false';
        const paint = () => {
          const on = b.dataset.clockSelected === 'true';
          b.style.background = on ? 'var(--accent)' : 'transparent';
          b.style.color = on ? '#fff' : 'var(--text-muted)';
          b.style.borderColor = on ? 'var(--accent)' : 'var(--border-subtle)';
        };
        paint();
        b.addEventListener('click', () => {
          b.dataset.clockSelected = b.dataset.clockSelected === 'true' ? 'false' : 'true';
          paint();
        });
        daysWrap.appendChild(b);
      }

      body.append(time, label, repeat, daysWrap);

      const actions = [];
      if (payload?.editing) actions.push({ label: 'Delete', danger: true, value: '__CLOCK_DELETE__' });
      actions.push({ label: 'Cancel', value: '__CLOCK_CANCEL__' });
      actions.push({ label: 'Save', primary: true, value: '__MODAL_SUBMIT_CUSTOM__' });

      const result = await ModalService.show(
        payload?.editing ? 'Edit Alarm' : 'Add Alarm',
        body,
        actions,
        null,
        '',
        {
          variant: 'clock-alarm',
          collect(root) {
            const chosen = [...root.querySelectorAll('[data-clock-day][data-clock-selected="true"]')]
              .map(x => Number(x.dataset.clockDay));
            return {
              time: time.value,
              label: label.value.trim().slice(0, 64),
              days: chosen,
              enabled: true,
            };
          }
        }
      );
      return respond(webview, 'nova:clock:alarm:dialog', requestId, { success: true, result });
    } catch (e) {
      return respondError(webview, 'nova:clock:alarm:dialog', requestId, 'ERROR', e?.message || 'Clock dialog unavailable');
    }
  }
  async function handleClockTimerSetPreset({ payload, requestId, webview }) {
    const svc = await clockService();
    svc.setTimerPreset?.(payload?.ms);
    return respond(webview, 'nova:clock:timer:set-preset', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockTimerStart({ payload, requestId, webview }) {
    const svc = await clockService();
    svc.startTimer?.(payload?.ms);
    return respond(webview, 'nova:clock:timer:start', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockTimerPause({ requestId, webview }) {
    const svc = await clockService();
    svc.pauseTimer?.();
    return respond(webview, 'nova:clock:timer:pause', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockTimerRestart({ requestId, webview }) {
    const svc = await clockService();
    svc.restartTimer?.();
    return respond(webview, 'nova:clock:timer:restart', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockTimerReset({ requestId, webview }) {
    const svc = await clockService();
    svc.resetTimer?.();
    return respond(webview, 'nova:clock:timer:reset', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockStopwatchStart({ requestId, webview }) {
    const svc = await clockService();
    svc.startStopwatch?.();
    return respond(webview, 'nova:clock:stopwatch:start', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockStopwatchPause({ requestId, webview }) {
    const svc = await clockService();
    svc.pauseStopwatch?.();
    return respond(webview, 'nova:clock:stopwatch:pause', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockStopwatchReset({ requestId, webview }) {
    const svc = await clockService();
    svc.resetStopwatch?.();
    return respond(webview, 'nova:clock:stopwatch:reset', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockStopwatchLap({ requestId, webview }) {
    const svc = await clockService();
    const lap = svc.lapStopwatch?.();
    return respond(webview, 'nova:clock:stopwatch:lap', requestId, { success: true, lap, state: await clockSnapshot() });
  }

  // Admin: audit / system / apps / users
  //
  // admin:* is the only permission category gated by something below the
  // app-permission layer — /api/security/* checks req.user.role === 'admin'
  // server-side, which reflects a real local admin-state flag (see
  // server/security/admin-state.js) instead of being permanently false.
  // Two gates have to agree: AppPermissionManager (per-app grant, same as
  // every other permission) AND the local admin flag (per-machine, off by
  // default, toggled in Settings). An app can be granted admin:audit and
  // still get nothing back if the machine itself isn't in admin mode —
  // that's intentional, not a bug: granting an app the permission means
  // "if this machine is ever in admin mode, this app may use it," not
  // "make this machine an admin machine."
  //
  // There's no user-account CRUD anywhere in this codebase (no
  // create/delete/edit-user route exists), so admin:users maps to session
  // management (list/revoke active sessions) rather than invented account
  // operations. admin:apps has no dedicated route of its own in
  // security/routes.js; it's folded into admin:system's settings surface
  // for now since nothing else under /api/security exists for it.

  function csrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content || '';
  }

  function systemAppRateLimitHeaders(app) {
    if (
      app?.verified !== true ||
      app?.signer !== 'NovaByte System' ||
      app?.system !== true ||
      app?.manifest?.system !== true ||
      typeof require !== 'function' ||
      typeof process === 'undefined'
    ) return {};

    const secret = process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET;
    if (!secret) return {};
    const timestamp = String(Date.now());
    const signature = require('crypto')
      .createHmac('sha256', secret)
      .update(`${timestamp}\n${app.id}`)
      .digest('hex');
    return {
      'X-Nova-System-App': app.id,
      'X-Nova-System-Time': timestamp,
      'X-Nova-System-Signature': signature,
    };
  }

  // Shared helper for admin and mail proxies — both need the same
  // JSON-in/JSON-out shape with a CSRF header. Previously duplicated as
  // adminFetch and mailFetch with identical bodies.
  async function authedJsonFetch(path, options = {}) {
    const res = await fetch(path, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken(),
        ...(options.headers || {}),
        ...systemAppRateLimitHeaders(options.app),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON error page, fall through */ }
    return { status: res.status, ok: res.ok, json };
  }

  async function handleAdminAudit({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('admin:audit', app.id)) {
      return respondError(webview, 'nova:admin:audit', requestId, 'PERMISSION_DENIED', 'admin:audit permission required');
    }
    if (!(await isAdminEnabledClient(app))) {
      return respondError(webview, 'nova:admin:audit', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
    }
    const q = payload ?? {};
    const params = new URLSearchParams();
    for (const k of ['userId', 'action', 'resource', 'ipAddress', 'success', 'startDate', 'endDate', 'level', 'limit', 'offset']) {
      if (q[k] !== undefined && q[k] !== null) params.set(k, String(q[k]));
    }
    try {
      const { status, json } = await authedJsonFetch(`/api/security/audit?${params.toString()}`, { app });
      if (status === 403) {
        return respondError(webview, 'nova:admin:audit', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
      }
      if (!json || json.success !== true) {
        return respondError(webview, 'nova:admin:audit', requestId, 'UNAVAILABLE', json?.message || 'Failed to query audit log');
      }
      return respond(webview, 'nova:admin:audit', requestId, { success: true, logs: json.data, pagination: json.pagination, statistics: json.statistics });
    } catch (e) {
      return respondError(webview, 'nova:admin:audit', requestId, 'UNAVAILABLE', e?.message || 'Audit request failed');
    }
  }

  async function handleAdminSystem({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('admin:system', app.id)) {
      return respondError(webview, 'nova:admin:system', requestId, 'PERMISSION_DENIED', 'admin:system permission required');
    }
    if (!(await isAdminEnabledClient(app))) {
      return respondError(webview, 'nova:admin:system', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
    }
    const action = payload?.action === 'set' ? 'set' : 'get';
    try {
      if (action === 'get') {
        const { status, json } = await authedJsonFetch('/api/security/settings', { app });
        if (status === 403) {
          return respondError(webview, 'nova:admin:system', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
        }
        if (!json || json.success !== true) {
          return respondError(webview, 'nova:admin:system', requestId, 'UNAVAILABLE', json?.message || 'Failed to read security settings');
        }
        return respond(webview, 'nova:admin:system', requestId, { success: true, settings: json.data });
      }
      // action === 'set'
      const updates = payload?.settings;
      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        return respondError(webview, 'nova:admin:system', requestId, 'INVALID_ARGS', 'settings object is required for action "set"');
      }
      const { status, json } = await authedJsonFetch('/api/security/settings', { method: 'PUT', body: updates, app });
      if (status === 403) {
        return respondError(webview, 'nova:admin:system', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
      }
      if (!json || json.success !== true) {
        return respondError(webview, 'nova:admin:system', requestId, 'UNAVAILABLE', json?.message || 'Failed to update security settings');
      }
      return respond(webview, 'nova:admin:system', requestId, { success: true, updated: json.updated });
    } catch (e) {
      return respondError(webview, 'nova:admin:system', requestId, 'UNAVAILABLE', e?.message || 'Admin system request failed');
    }
  }

  async function handleAdminUsers({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('admin:users', app.id)) {
      return respondError(webview, 'nova:admin:users', requestId, 'PERMISSION_DENIED', 'admin:users permission required');
    }
    if (!(await isAdminEnabledClient(app))) {
      return respondError(webview, 'nova:admin:users', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
    }
    // No account system exists in this codebase — this maps to session
    // management (list/revoke), the closest real equivalent to "manage
    // other users' access" that /api/security actually implements.
    const action = payload?.action === 'revoke' ? 'revoke' : 'list';
    try {
      if (action === 'list') {
        const { status, json } = await authedJsonFetch('/api/security/sessions', { app });
        if (status === 401) {
          return respondError(webview, 'nova:admin:users', requestId, 'UNAVAILABLE', 'No active session');
        }
        if (!json || json.success !== true) {
          return respondError(webview, 'nova:admin:users', requestId, 'UNAVAILABLE', json?.message || 'Failed to list sessions');
        }
        return respond(webview, 'nova:admin:users', requestId, { success: true, sessions: json.data });
      }
      // action === 'revoke'
      const sessionId = payload?.sessionId;
      if (!sessionId) {
        return respondError(webview, 'nova:admin:users', requestId, 'INVALID_ARGS', 'sessionId is required for action "revoke"');
      }
      const { status, json } = await authedJsonFetch(`/api/security/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', app });
      if (status === 403) {
        return respondError(webview, 'nova:admin:users', requestId, 'PERMISSION_DENIED', 'Not permitted to revoke this session');
      }
      if (status === 404) {
        return respondError(webview, 'nova:admin:users', requestId, 'NOT_FOUND', 'Session not found');
      }
      if (!json || json.success !== true) {
        return respondError(webview, 'nova:admin:users', requestId, 'UNAVAILABLE', json?.message || 'Failed to revoke session');
      }
      return respond(webview, 'nova:admin:users', requestId, { success: true, revoked: true });
    } catch (e) {
      return respondError(webview, 'nova:admin:users', requestId, 'UNAVAILABLE', e?.message || 'Admin users request failed');
    }
  }

  async function handleAdminApps({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('admin:apps', app.id)) {
      return respondError(webview, 'nova:admin:apps', requestId, 'PERMISSION_DENIED', 'admin:apps permission required');
    }
    // There's no dedicated /api/security route for app management — the
    // real, non-sandboxed app inventory already lives behind system:apps
    // (nova:app:list/install/uninstall). What system:apps:list can't show
    // is what's actually been *granted* at runtime — a manifest can
    // declare permissions it was never given, or the user may have
    // revoked something after install. admin:apps' real, distinguishing
    // scope is that runtime grant state: "an admin-mode app can audit
    // what every installed app can actually do right now," not just what
    // it asked for. If real admin-only mutating operations (force-
    // uninstall another app, disable an app fleet-wide) get built later,
    // they belong here too.
    if (typeof APP_REGISTRY === 'undefined' || !Array.isArray(APP_REGISTRY)) {
      return respondError(webview, 'nova:admin:apps', requestId, 'UNAVAILABLE', 'App registry not available');
    }
    if (!(await isAdminEnabledClient(app))) {
      return respondError(webview, 'nova:admin:apps', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
    }
    const apps = APP_REGISTRY.map(a => {
      const granted = (typeof AppPermissionManager.getAppPermissions === 'function')
        ? AppPermissionManager.getAppPermissions(a.id).map(g => g.permission)
        : [];
      // Built-in apps never declare permissions on their registerApp()
      // config — that's not a gap in this handler, it's a real second
      // source of truth: js/platform/security/app-permissions-bootstrap.js
      // provides legacy developer-tool declarations only. Trusted .novaapp
      // system apps intentionally declare no app-level permissions, while a
      // third-party package's manifest remains the source of its declarations.
      // Report whichever source applies rather than inventing a list for a
      // trusted system package.
      const bootstrapEntry = (typeof window.AppPermissionsMap === 'object' && window.AppPermissionsMap)
        ? window.AppPermissionsMap[a.id]
        : null;
      const declaredPermissions = bootstrapEntry
        ? [...(bootstrapEntry.normal || [])]
        : (a.permissions || []);
      const declaredOptionalPermissions = bootstrapEntry
        ? [...(bootstrapEntry.dangerous || [])]
        : (a.optionalPermissions || []);
      return {
        id: a.id, name: a.name, version: a.version || '1.0.0',
        source: a.source || 'local', builtin: a.source !== 'file',
        declaredPermissions, declaredOptionalPermissions,
        declaredVia: bootstrapEntry ? 'permissions-bootstrap' : 'manifest',
        grantedPermissions: granted,
      };
    });
    return respond(webview, 'nova:admin:apps', requestId, { success: true, apps });
  }

  // admin:apps has no server route to 403 against (unlike the other three,
  // which proxy to /api/security and get a real 403 from there), so it
  // needs its own client-side admin-mode check. Reuses the same signal:
  // GET /api/security/settings returns a *limited* payload for non-admins
  // (no _meta.editable, no full settings) but always 200s, so the leanest
  // honest check is a settings fetch and looking at whether the admin-only
  // fields came back.
  // ── Settings-only unrestricted handlers ──────────────────────────────
  // These handlers exist in API_HANDLERS for completeness, but the IPC
  // bridge (handleAPICall) is the only dispatch path and the Settings app
  // reaches these features directly through OS.system.* rather than via
  // IPC — so nothing on a live code path calls them. They're left in place
  // as the canonical implementation so a future IPC surface can reuse them
  // without duplicating logic.

  async function handleSystemPermissionsList({ requestId, webview }) {
    if (typeof AppPermissionManager === 'undefined' || typeof AppRegistry === 'undefined') {
      return respondError(webview, 'nova:system:permissions:list', requestId, 'UNAVAILABLE', 'Permission system not available');
    }
    const apps = (typeof APP_REGISTRY !== 'undefined' && Array.isArray(APP_REGISTRY)) ? APP_REGISTRY : [];
    const result = apps.map(a => ({
      id: a.id,
      name: a.name,
      grants: typeof AppPermissionManager.getAppPermissions === 'function'
        ? AppPermissionManager.getAppPermissions(a.id)
        : [],
    }));
    return respond(webview, 'nova:system:permissions:list', requestId, { success: true, apps: result });
  }

  async function handleSystemPermissionsSet({ payload, requestId, webview }) {
    if (typeof AppPermissionManager === 'undefined') {
      return respondError(webview, 'nova:system:permissions:set', requestId, 'UNAVAILABLE', 'Permission system not available');
    }
    const { appId, permission, granted } = payload || {};
    if (!appId || !permission || typeof granted !== 'boolean') {
      return respondError(webview, 'nova:system:permissions:set', requestId, 'INVALID_ARGS', 'appId, permission, and a boolean granted are required');
    }
    try {
      if (granted) {
        await AppPermissionManager.grantPermission(permission, appId, { source: 'settings' });
      } else {
        await AppPermissionManager.revokePermission(permission, appId);
      }
    } catch (e) {
      return respondError(webview, 'nova:system:permissions:set', requestId, 'INTERNAL_ERROR', e?.message || 'Failed to update permission');
    }
    return respond(webview, 'nova:system:permissions:set', requestId, { success: true, appId, permission, granted });
  }

  async function handleSystemPermissionsReset({ payload, requestId, webview }) {
    if (typeof AppPermissionManager === 'undefined') {
      return respondError(webview, 'nova:system:permissions:reset', requestId, 'UNAVAILABLE', 'Permission system not available');
    }
    const { appId, permission } = payload || {};
    if (!appId) {
      return respondError(webview, 'nova:system:permissions:reset', requestId, 'INVALID_ARGS', 'appId is required');
    }
    try {
      if (permission) {
        await AppPermissionManager.resetPermission(permission, appId);
      } else if (typeof AppPermissionManager.revokeAllPermissions === 'function') {
        await AppPermissionManager.revokeAllPermissions(appId);
      }
    } catch (e) {
      return respondError(webview, 'nova:system:permissions:reset', requestId, 'INTERNAL_ERROR', e?.message || 'Failed to reset permission(s)');
    }
    return respond(webview, 'nova:system:permissions:reset', requestId, { success: true, appId, permission: permission || null });
  }

  // Mirrors settings.js's existing localStorage.length/key()/getItem() loop
  // exactly (see renderPrivacy's backup path) — same data, just moved
  // behind an IPC call instead of a direct host-global read.
  async function handleSystemDataBackup({ requestId, webview }) {
    if (typeof localStorage === 'undefined') {
      return respondError(webview, 'nova:system:data:backup', requestId, 'UNAVAILABLE', 'localStorage not available in this context');
    }
    const localStorageData = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      localStorageData[key] = localStorage.getItem(key);
    }
    const settingsData = (typeof OS !== 'undefined' && OS.settings?._cache) ? { ...OS.settings._cache } : {};
    return respond(webview, 'nova:system:data:backup', requestId, {
      success: true,
      localStorage: localStorageData,
      settings: settingsData,
      capturedAt: new Date().toISOString(),
    });
  }

  // Mirrors settings.js's existing restore path (setItem per key, plus a
  // clear-first option for full reset) — moved behind IPC the same way.
  async function handleSystemDataRestore({ payload, requestId, webview }) {
    if (typeof localStorage === 'undefined') {
      return respondError(webview, 'nova:system:data:restore', requestId, 'UNAVAILABLE', 'localStorage not available in this context');
    }
    const { localStorage: dataToRestore, settings: settingsToRestore, clearFirst } = payload || {};
    if (clearFirst) {
      try { localStorage.clear(); } catch (e) { log('warn', 'localStorage.clear() failed during restore:', e); }
    }
    let restoredKeys = 0;
    if (dataToRestore && typeof dataToRestore === 'object') {
      for (const [k, v] of Object.entries(dataToRestore)) {
        try { localStorage.setItem(k, v); restoredKeys++; }
        catch (e) { log('warn', `localStorage.setItem failed for ${k}:`, e); }
      }
    }
    if (settingsToRestore && typeof settingsToRestore === 'object' && typeof OS !== 'undefined' && OS.settings) {
      for (const [k, v] of Object.entries(settingsToRestore)) {
        try {
          if (OS.settings._cache) OS.settings._cache[k] = v;
          if (typeof OS.settings.set === 'function') OS.settings.set(k, v);
        } catch (e) { log('warn', `OS.settings restore failed for ${k}:`, e); }
      }
    }
    return respond(webview, 'nova:system:data:restore', requestId, { success: true, restoredKeys, cleared: !!clearFirst });
  }

  async function handleSystemDialog({ payload, requestId, webview }) {
    try {
      const dialogService = (typeof window.ModalService?.show === 'function')
        ? window.ModalService.show.bind(window.ModalService)
        : (typeof window.showModal === 'function' ? window.showModal : null);
      if (!dialogService) {
        return respondError(webview, 'nova:system:dialog', requestId, 'UNAVAILABLE', 'System dialog service not available');
      }
      const buttons = Array.isArray(payload?.buttons) && payload.buttons.length
        ? payload.buttons.map(b => ({
            label: String(b?.label || 'OK'),
            value: b?.value,
            primary: !!b?.primary,
            danger: !!b?.danger
          }))
        : [{ label: 'OK', value: true, primary: true }];
      // Runs in the host page: the overlay is outside the Settings webview.
      const value = await dialogService(
        String(payload?.title || 'Settings'),
        String(payload?.message || ''),
        buttons,
        payload?.inputType || null,
      );
      return respond(webview, 'nova:system:dialog', requestId, { success: true, value });
    } catch (e) {
      return respondError(webview, 'nova:system:dialog', requestId, 'DIALOG_ERROR', e?.message || 'Dialog failed');
    }
  }

  async function handleSystemDeveloperModeConfirm({ requestId, webview }) {
    try {
      const dialogService = (typeof window.ModalService?.show === 'function')
        ? window.ModalService.show.bind(window.ModalService)
        : (typeof window.showModal === 'function' ? window.showModal : null);
      if (!dialogService) {
        return respondError(webview, 'nova:system:developer-mode:confirm', requestId, 'UNAVAILABLE', 'System dialog service not available');
      }

      // Match the original Settings warning verbatim, but construct it in the
      // host dialog portal so it can never be trapped inside the Settings guest.
      const body = document.createElement('div');
      body.style.cssText = 'font-size:14px;color:var(--text-secondary,#aaa);line-height:1.55;';
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:16px;';
      const warningIcon = document.createElement('span');
      warningIcon.textContent = '\u26A0\uFE0F';
      warningIcon.style.cssText = 'font-size:22px;line-height:1;';
      const warningTitle = document.createElement('div');
      warningTitle.textContent = 'Developer Mode — Security Warning';
      warningTitle.style.cssText = 'font-size:17px;font-weight:700;color:var(--text-danger,#f85149);letter-spacing:0.2px;';
      header.append(warningIcon, warningTitle);
      body.appendChild(header);
      const warningText = document.createElement('div');
      warningText.style.cssText = 'white-space:pre-line;max-height:340px;overflow-y:auto;padding-right:4px;';
      body.appendChild(warningText);
      warningText.textContent =
        'WARNING: Developer Mode lowers the system\'s security posture and grants elevated access to internal components.\n\n' +
        'When enabled, the following restrictions are relaxed:\n' +
        '\u2022 Unrestricted access to the filesystem, networks, and system APIs\n' +
        '\u2022 Elevated permissions to internal system modules and runtime internals\n' +
        '\u2022 Visibility into running processes, memory, and module state\n' +
        '\u2022 The ability to inspect, alter, or revoke app permissions\n' +
        '\u2022 The ability to install, remove, or modify system packages\n\n' +
        'The following internal apps and tools become accessible:\n' +
        '\u2022 Console — runs arbitrary JavaScript in the full OS context with no sandboxing\n' +
        '\u2022 Inspector — can force-close arbitrary windows and export app state\n' +
        '\u2022 Packages — can install unsigned or unverified packages into the live registry, and can add a locally-generated signing key to this device\'s trust store for the current session (only affects installs on this machine; never affects other clones, forks, or devices)\n' +
        '\u2022 Modules — can dynamically import arbitrary module paths for live code execution\n' +
        '\u2022 Permissions — can bulk-grant or revoke permissions for any app without user consent\n' +
        '\u2022 Perf — exposes detailed runtime performance data, memory usage, and per-window DOM breakdowns\n' +
        '\u2022 SysAccess — can read the virtual filesystem and probe internal network/SSRF configuration\n' +
        '\u2022 Events — full visibility into all system-wide activity, including console output, permission checks, package operations, and app event data payloads across every app and OS component\n' +
        '\u2022 Debug Overlay — persistent always-on-top diagnostics overlay exposing GPU, memory, URLs, and OS internals (F3)\n\n' +
        'Developer Mode is intended solely for development, debugging, and system maintenance. Enable it only when you understand the risks. Leave it disabled during normal use.';

      const value = await dialogService(
        '',
        body,
        [
          { label: 'Cancel', value: null },
          { label: 'Turn On Anyway', danger: true, primary: true, value: 'confirm' }
        ],
        null,
        '',
        { variant: 'developer-warning' }
      );
      return respond(webview, 'nova:system:developer-mode:confirm', requestId, { success: true, value });
    } catch (e) {
      console.error('[Settings] developer-mode confirmation failed:', e);
      return respondError(webview, 'nova:system:developer-mode:confirm', requestId, 'DIALOG_ERROR', e?.message || 'Developer mode confirmation failed');
    }
  }

  async function handleSystemBootRecovery({ requestId, webview }) {
    try {
      localStorage.setItem('nova_manual_recovery', '1');
      localStorage.removeItem('nova_safe_mode');
      // Reload the HOST window, not the sandbox guest frame. The next boot
      // sees nova_manual_recovery and opens the actual recovery environment.
      setTimeout(() => {
        try { location.reload(); } catch (e) { console.error('[Settings] recovery reload failed:', e); }
      }, 120);
      return respond(webview, 'nova:system:boot-recovery', requestId, { success: true });
    } catch (e) {
      return respondError(webview, 'nova:system:boot-recovery', requestId, 'ERROR', e?.message || 'Failed to reboot to recovery');
    }
  }

  async function handleSystemStorageEstimate({ requestId, webview }) {
    try {
      // Settings is a first-party system app, so storage is measured from the
      // host OS rather than the sandbox webview. navigator.storage.estimate()
      // is renderer/partition scoped in NW.js and can be unavailable or report
      // only the guest partition, which is why Settings previously showed an
      // error even though the OS volume was healthy.
      if (typeof require === 'function') {
        try {
          const fs = require('fs');
          const path = require('path');
          const root = path.parse(process.cwd()).root || process.cwd();
          if (typeof fs.statfsSync === 'function') {
            try {
              const st = fs.statfsSync(root);
              const blockSize = Number(st.bsize || st.frsize || 0);
              const blocks = Number(st.blocks || 0);
              const available = Number(st.bavail ?? st.bfree ?? 0);
              if (blockSize > 0 && blocks > 0) {
                const quota = blocks * blockSize;
                const usage = Math.max(0, (blocks - available) * blockSize);
                return respond(webview, 'nova:system:storage:estimate', requestId, {
                  success: true,
                  usage,
                  quota,
                  source: 'host-filesystem',
                });
              }
            } catch (statfsErr) {
              console.warn('[Settings] statfs storage estimate failed:', statfsErr);
            }
          }

          // Windows builds of Node/NW.js may not expose statfs. Use the native
          // Win32 logical-disk provider through PowerShell as a host-only
          // fallback. This reads the same volume that contains the OS runtime.
          if (process.platform === 'win32') {
            const cp = require('child_process');
            const drive = String(root).replace(/\\+$/, '');
            const ps = [
              '$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'' + drive.replace(/'/g, "''") + '\'";',
              'if ($null -eq $d) { throw "Drive not found" };',
              '[Console]::WriteLine((@{Size=[Int64]$d.Size; FreeSpace=[Int64]$d.FreeSpace} | ConvertTo-Json -Compress))'
            ].join(' ');
            const out = cp.execFileSync('powershell.exe', [
              '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps
            ], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
            const parsed = JSON.parse(String(out).trim());
            const quota = Number(parsed?.Size || 0);
            const free = Number(parsed?.FreeSpace || 0);
            if (quota > 0 && free >= 0 && free <= quota) {
              return respond(webview, 'nova:system:storage:estimate', requestId, {
                success: true,
                usage: quota - free,
                quota,
                source: 'host-windows-volume',
              });
            }
          }
        } catch (hostErr) {
          console.warn('[Settings] host storage estimate fallback failed:', hostErr);
        }
      }

      // Last fallback: if NW.js exposes a useful renderer estimate, return it.
      if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
        const est = await navigator.storage.estimate();
        const usage = Number.isFinite(est?.usage) ? est.usage : 0;
        const quota = Number.isFinite(est?.quota) ? est.quota : 0;
        if (quota > 0 || usage > 0) {
          return respond(webview, 'nova:system:storage:estimate', requestId, {
            success: true, usage, quota, usageDetails: est?.usageDetails || null, source: 'webview-fallback'
          });
        }
      }

      return respondError(webview, 'nova:system:storage:estimate', requestId, 'UNAVAILABLE', 'Storage information is unavailable on this device');
    } catch (e) {
      console.error('[Settings] storage estimate failed:', e);
      return respondError(webview, 'nova:system:storage:estimate', requestId, 'ERROR', e?.message || 'Failed to retrieve storage information');
    }
  }

  async function deleteHostIndexedDBs(names) {
    const results = [];
    for (const name of names) {
      const result = await new Promise(resolve => {
        try {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = () => resolve({ name, ok: true });
          req.onerror = () => resolve({ name, ok: false, reason: 'error' });
          req.onblocked = () => resolve({ name, ok: false, reason: 'blocked' });
        } catch (e) {
          resolve({ name, ok: false, reason: e?.message || 'error' });
        }
      });
      results.push(result);
    }
    return results;
  }

  async function handleSystemDataClear({ payload, requestId, webview }) {
    try {
      const mode = payload?.mode === 'all' ? 'all' : 'cache';
      const cleared = [];

      if (mode === 'cache') {
        try {
          const cacheNames = await caches.keys();
          if (cacheNames.length) {
            await Promise.all(cacheNames.map(n => caches.delete(n)));
            cleared.push(cacheNames.length + ' SW cache' + (cacheNames.length === 1 ? '' : 's'));
          }
        } catch (e) { console.warn('[Settings] cache clear failed:', e); }
        try {
          const tempKeys = Object.keys(localStorage).filter(k =>
            k.includes('_cache') || k.includes('_temp') ||
            k === 'nova_boot_attempts' || k === 'nova_force_recovery'
          );
          if (tempKeys.length) {
            tempKeys.forEach(k => localStorage.removeItem(k));
            cleared.push(tempKeys.length + ' temp key' + (tempKeys.length === 1 ? '' : 's'));
          }
        } catch (e) { console.warn('[Settings] temp key clear failed:', e); }
        return respond(webview, 'nova:system:data:clear', requestId, { success: true, mode, cleared });
      }

      // Full wipe mirrors the recovery/factory-reset path and, critically,
      // runs in the HOST context so it can reach every app partition.
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
      try { if (typeof OPFS !== 'undefined' && OPFS.clear) await OPFS.clear(); } catch (e) { console.warn('[Settings] OPFS clear failed:', e); }

      const appIds = (typeof OS !== 'undefined' && OS.apps) ? Object.keys(OS.apps) : [];
      try {
        if (typeof AppSandbox !== 'undefined' && AppSandbox.clearAppPartitions) {
          await AppSandbox.clearAppPartitions(appIds);
        }
      } catch (e) { console.warn('[Settings] app partition wipe failed:', e); }
      try {
        if (typeof AppSandbox !== 'undefined' && AppSandbox.clearAllStorage) {
          await AppSandbox.clearAllStorage();
        }
      } catch (e) { console.warn('[Settings] app storage wipe failed:', e); }
      const dbResults = await deleteHostIndexedDBs(['NovaByte_FS', 'novabyte_opfs_fallback', 'NovaByte_AppStorage']);
      const blocked = dbResults.filter(r => !r.ok);

      cleared.push('host settings', 'files', 'application data');
      if (blocked.length) cleared.push(blocked.length + ' database(s) could not be deleted because they were blocked');

      setTimeout(() => {
        try { location.reload(); } catch {}
      }, 350);
      return respond(webview, 'nova:system:data:clear', requestId, { success: true, mode, cleared });
    } catch (e) {
      return respondError(webview, 'nova:system:data:clear', requestId, 'WIPE_ERROR', e?.message || 'Failed to clear data');
    }
  }

  function systemDefaultAppsState() {
    if (typeof DefaultApps === 'undefined' || !DefaultApps?.CATEGORIES) return null;
    const categories = Object.entries(DefaultApps.CATEGORIES).map(([id, c]) => {
      const apps = DefaultApps.getAppsForCategory(id);
      const currentId = DefaultApps.getDefault(id) || null;
      const chosen = apps.find(a => a.id === currentId) || apps[0] || null;
      return { id, name: c.name, currentId: chosen?.id || null, currentName: chosen?.name || null, apps };
    });
    return { categories };
  }

  async function handleSystemDefaultAppsGet({ requestId, webview }) {
    const state = systemDefaultAppsState();
    if (!state) return respondError(webview, 'nova:system:default-apps:get', requestId, 'UNAVAILABLE', 'Default apps service not available');
    return respond(webview, 'nova:system:default-apps:get', requestId, { success: true, ...state });
  }

  async function handleSystemDefaultAppsChoose({ payload, requestId, webview }) {
    try {
      if (typeof DefaultApps === 'undefined' || !DefaultApps?.CATEGORIES) {
        return respondError(webview, 'nova:system:default-apps:choose', requestId, 'UNAVAILABLE', 'Default apps service not available');
      }
      const categoryId = String(payload?.categoryId || '');
      const category = DefaultApps.CATEGORIES[categoryId];
      if (!category) {
        return respondError(webview, 'nova:system:default-apps:choose', requestId, 'INVALID_ARGS', 'Unknown default-app category');
      }
      const apps = DefaultApps.getAppsForCategory(categoryId) || [];
      const currentId = DefaultApps.getDefault(categoryId) || apps[0]?.id || null;

      const body = document.createElement('div');
      body.style.cssText = 'display:flex;flex-direction:column;gap:4px;max-height:60vh;overflow:auto;padding:2px;';

      for (const app of apps) {
        const row = document.createElement('div');
        row.setAttribute('data-modal-value', String(app.id));
        row.setAttribute('data-modal-selected', app.id === currentId ? 'true' : 'false');
        row.dataset.modalSelectedStyle = 'radio';
        row.setAttribute('role', 'radio');
        row.setAttribute('aria-checked', app.id === currentId ? 'true' : 'false');
        row.tabIndex = 0;
        row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:9px;cursor:pointer;user-select:none;border:1px solid ' + (app.id === currentId ? 'var(--accent)' : 'transparent') + ';background:' + (app.id === currentId ? 'var(--accent-muted)' : 'transparent') + ';';

        const icon = document.createElement('div');
        icon.style.cssText = 'width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;background:var(--accent-muted);color:var(--accent);font-size:14px;font-weight:700;';
        if (typeof app.icon === 'string' && app.icon.startsWith('data:image/')) {
          const img = document.createElement('img');
          img.src = app.icon;
          img.width = 18; img.height = 18;
          img.alt = '';
          img.draggable = false;
          icon.appendChild(img);
        } else if (typeof app.icon === 'string' && typeof svgIcon === 'function' && /^[a-z][a-z0-9-]*$/.test(app.icon)) {
          // Built-in apps normally publish an icon key (e.g. "mail",
          // "calendar", "settings"), not a data URI. The old chooser treated
          // short keys as literal text, which produced a "mail" word inside
          // the icon box instead of the actual application icon.
          icon.innerHTML = svgIcon(app.icon, 18);
        } else if (typeof app.icon === 'string' && app.icon.length <= 4) {
          icon.textContent = app.icon;
        } else {
          icon.textContent = String(app.name || '?').charAt(0).toUpperCase();
        }

        const label = document.createElement('div');
        label.textContent = String(app.name || app.id);
        label.style.cssText = 'flex:1;font-size:13px;color:var(--text-primary);';

        const radio = document.createElement('div');
        radio.style.cssText = 'width:16px;height:16px;border-radius:50%;border:2px solid ' + (app.id === currentId ? 'var(--accent)' : 'var(--border)') + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;';
        const dot = document.createElement('div');
        dot.setAttribute('data-modal-radio-dot', '');
        dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:var(--accent);opacity:' + (app.id === currentId ? '1' : '0') + ';';
        radio.appendChild(dot);
        row.append(icon, label, radio);

        const syncVisual = () => {
          const selected = row.getAttribute('data-modal-selected') === 'true';
          row.style.borderColor = selected ? 'var(--accent)' : 'transparent';
          row.style.background = selected ? 'var(--accent-muted)' : 'transparent';
          radio.style.borderColor = selected ? 'var(--accent)' : 'var(--border)';
          dot.style.opacity = selected ? '1' : '0';
        };
        row.addEventListener('click', syncVisual);
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            row.click();
          }
        });
        body.appendChild(row);
      }

      if (!apps.length) {
        const empty = document.createElement('div');
        empty.textContent = 'No installed apps support this category yet.';
        empty.style.cssText = 'padding:16px;text-align:center;color:var(--text-muted);font-size:12.5px;';
        body.appendChild(empty);
      }

      const dialogService = (typeof window.ModalService?.show === 'function')
        ? window.ModalService.show.bind(window.ModalService)
        : (typeof window.showModal === 'function' ? window.showModal : null);
      if (!dialogService) {
        return respondError(webview, 'nova:system:default-apps:choose', requestId, 'UNAVAILABLE', 'System dialog service not available');
      }
      const selected = await dialogService(
        'Default ' + String(category.name || 'App'),
        body,
        [
          { label: 'Cancel', value: null },
          { label: 'Select', value: '__MODAL_SUBMIT_SELECTION__', primary: true }
        ]
      );
      return respond(webview, 'nova:system:default-apps:choose', requestId, { success: !!selected, appId: selected || null });
    } catch (e) {
      return respondError(webview, 'nova:system:default-apps:choose', requestId, 'DIALOG_ERROR', e?.message || 'Default app chooser failed');
    }
  }

  async function handleSystemLaunchSnake({ requestId, webview }) {
    try {
      if (typeof launchSnakeGame !== 'function') {
        return respondError(webview, 'nova:system:launch-snake', requestId, 'UNAVAILABLE', 'Snake game service not available');
      }
      launchSnakeGame();
      return respond(webview, 'nova:system:launch-snake', requestId, { success: true });
    } catch (e) {
      return respondError(webview, 'nova:system:launch-snake', requestId, 'ERROR', e?.message || 'Failed to launch Snake');
    }
  }

  async function handleSystemDefaultAppsSet({ payload, requestId, webview }) {
    try {
      const categoryId = typeof payload?.categoryId === 'string' ? payload.categoryId : '';
      const appId = payload?.appId === null || payload?.appId === '' ? null : payload?.appId;
      if (typeof DefaultApps === 'undefined' || !DefaultApps.setDefault) {
        return respondError(webview, 'nova:system:default-apps:set', requestId, 'UNAVAILABLE', 'Default apps service not available');
      }
      if (appId !== null && typeof appId !== 'string') {
        return respondError(webview, 'nova:system:default-apps:set', requestId, 'INVALID_ARGS', 'App id must be a string or null');
      }
      if (!DefaultApps.setDefault(categoryId, appId)) {
        return respondError(webview, 'nova:system:default-apps:set', requestId, 'INVALID_ARGS', 'App is unavailable or does not support this category');
      }
      const apps = DefaultApps.getAppsForCategory(categoryId);
      const chosen = apps.find(a => a.id === DefaultApps.getDefault(categoryId)) || apps[0] || null;
      return respond(webview, 'nova:system:default-apps:set', requestId, { success: true, categoryId, appId: DefaultApps.getDefault(categoryId), currentName: chosen?.name || null });
    } catch (e) {
      return respondError(webview, 'nova:system:default-apps:set', requestId, 'ERROR', e?.message || 'Failed to update default app');
    }
  }

  function getAdminStateService() {
    const loaders = [];
    if (typeof require === 'function') loaders.push(require);
    if (typeof window !== 'undefined' && window.nw && typeof window.nw.require === 'function') {
      loaders.push(window.nw.require.bind(window.nw));
    }
    if (!loaders.length) throw new Error('Node host module loader unavailable');

    let pathModule = null;
    for (const load of loaders) {
      try { pathModule = load('path'); break; } catch (_) {}
    }
    if (!pathModule) throw new Error('Node path module unavailable');

    const root = (typeof process !== 'undefined' && typeof process.cwd === 'function')
      ? process.cwd() : null;
    const absolute = root
      ? pathModule.resolve(root, 'server/security/admin-state.js')
      : 'server/security/admin-state.js';

    let lastError = null;
    for (const load of loaders) {
      try { return load(absolute); } catch (e) { lastError = e; }
    }
    throw new Error(lastError?.message || 'Unable to load admin state service');
  }

  async function handleSystemAdminModeGet({ requestId, webview }) {
    try {
      const adminState = await getAdminStateService();
      return respond(webview, 'nova:system:admin-mode:get', requestId, { success: true, adminEnabled: !!adminState.isAdminEnabled() });
    } catch (e) {
      console.error('[Settings] admin-mode:get failed:', e);
      return respondError(webview, 'nova:system:admin-mode:get', requestId, 'ERROR', e?.message || 'Failed to read admin mode');
    }
  }

  async function handleSystemAdminModeSet({ payload, requestId, webview }) {
    try {
      const adminState = await getAdminStateService();
      const enabled = !!payload?.enabled;
      const state = adminState.setAdminEnabled(enabled);
      return respond(webview, 'nova:system:admin-mode:set', requestId, { success: true, adminEnabled: !!state.adminEnabled });
    } catch (e) {
      console.error('[Settings] admin-mode:set failed:', e);
      return respondError(webview, 'nova:system:admin-mode:set', requestId, 'ERROR', e?.message || 'Failed to set admin mode');
    }
  }

  async function handleSystemPreferencesGet({ payload, requestId, webview }) {
    if (typeof OS === 'undefined' || !OS.settings || typeof OS.settings.get !== 'function') {
      return respondError(webview, 'nova:system:preferences:get', requestId, 'UNAVAILABLE', 'OS.settings not available');
    }
    const key = payload?.key;
    if (key) {
      return respond(webview, 'nova:system:preferences:get', requestId, { success: true, key, value: OS.settings.get(key) });
    }
    return respond(webview, 'nova:system:preferences:get', requestId, { success: true, all: { ...(OS.settings._cache || {}) } });
  }

  async function handleSystemPreferencesSet({ payload, requestId, webview }) {
    if (typeof OS === 'undefined' || !OS.settings || typeof OS.settings.set !== 'function') {
      return respondError(webview, 'nova:system:preferences:set', requestId, 'UNAVAILABLE', 'OS.settings not available');
    }
    const { key, value } = payload || {};
    if (!key) {
      return respondError(webview, 'nova:system:preferences:set', requestId, 'INVALID_ARGS', 'key is required');
    }
    if (key === 'devMode' || key === 'rootAccessEnabled') {
      return respondError(webview, 'nova:system:preferences:set', requestId, 'PERMISSION_DENIED', `Settings key '${key}' can only be changed from the OS Settings app`);
    }
    OS.settings.set(key, value);
    // Settings runs sandboxed (no window.parent/host reference — see
    // app-sandbox.js's <webview> guest notes), so its own "window.DebugOverlay
    // && enable()/disable()" call is always a no-op: that global simply isn't
    // reachable from inside the guest. Drive the overlay from here instead,
    // where we're already running in the host context that owns it.
    if (key === 'devMode' && typeof window !== 'undefined' && window.DebugOverlay) {
      value ? window.DebugOverlay.enable() : window.DebugOverlay.disable();
    }
    return respond(webview, 'nova:system:preferences:set', requestId, { success: true, key, value });
  }

  async function isAdminEnabledClient(app) {
    try {
      const { json } = await authedJsonFetch('/api/security/settings', { app });
      return !!(json && json.success && json.data && json.data._meta);
    } catch {
      return false;
    }
  }

  function mailNotConnectedError(webview, channel, requestId) {
    return respondError(webview, channel, requestId, 'UNAVAILABLE', 'No email account connected — open the Email app and connect an account first');
  }

  // mail:session — connection/session lifecycle for the bundled Email app.
  // This keeps credential-bearing operations on the host side and out of the
  // guest renderer. Connecting/disconnecting is still permission-gated via
  // mail:write; only the destination server, protocol and credentials supplied
  // by the user are forwarded to the existing Email controller.
  async function handleMailSession({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('mail:write', app.id)) {
      return respondError(webview, 'nova:mail:session', requestId, 'PERMISSION_DENIED', 'mail:write permission required');
    }
    const action = payload?.action;
    try {
      if (action === 'connect') {
        const q = payload?.account || {};
        if (!q.type || !q.host || !q.user || !q.pass) {
          return respondError(webview, 'nova:mail:session', requestId, 'INVALID_ARGS', 'type, host, user and pass are required');
        }
        const ssl = q.ssl === undefined ? true : !!q.ssl;
        if (!ssl) {
          return respondError(webview, 'nova:mail:session', requestId, 'INVALID_ARGS', 'Plaintext connections are not supported');
        }
        const { status, json } = await authedJsonFetch('/api/email/connect', {
          method: 'POST',
          app,
          body: {
            type: String(q.type).toLowerCase(),
            host: String(q.host),
            port: q.port,
            ssl: true,
            user: String(q.user),
            pass: String(q.pass),
          },
        });
        if (!json || json.error) {
          return respondError(webview, 'nova:mail:session', requestId, 'UNAVAILABLE', json?.error || `Connect failed (${status})`);
        }
        return respond(webview, 'nova:mail:session', requestId, { success: true, action, data: json });
      }
      if (action === 'disconnect') {
        const { status, json } = await authedJsonFetch('/api/email/disconnect', { method: 'POST', body: {}, app });
        if (!json || json.error) {
          return respondError(webview, 'nova:mail:session', requestId, 'UNAVAILABLE', json?.error || `Disconnect failed (${status})`);
        }
        return respond(webview, 'nova:mail:session', requestId, { success: true, action, data: json });
      }
      if (action === 'restore') {
        const { status, json } = await authedJsonFetch('/api/email/restore', { app });
        if (!json || json.error) {
          return respondError(webview, 'nova:mail:session', requestId, 'UNAVAILABLE', json?.error || `Restore failed (${status})`);
        }
        return respond(webview, 'nova:mail:session', requestId, { success: true, action, data: json });
      }
      return respondError(webview, 'nova:mail:session', requestId, 'INVALID_ARGS', 'Unknown session action');
    } catch (e) {
      return respondError(webview, 'nova:mail:session', requestId, 'UNAVAILABLE', e?.message || 'Mail session request failed');
    }
  }

  // mail:read — folders, message lists, single messages, search. All GET,
  // no mutation of mailbox state.
  async function handleMailRead({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('mail:read', app.id)) {
      return respondError(webview, 'nova:mail:read', requestId, 'PERMISSION_DENIED', 'mail:read permission required');
    }
    const q = payload ?? {};
    const action = q.action === 'folders' ? 'folders'
      : q.action === 'message' ? 'message'
      : q.action === 'search' ? 'search'
      : q.action === 'account' ? 'account'
      : 'messages';
    try {
      let url;
      if (action === 'account') {
        url = '/api/email/restore';
      } else if (action === 'folders') {
        url = '/api/email/folders';
      } else if (action === 'message') {
        if (!q.uid) return respondError(webview, 'nova:mail:read', requestId, 'INVALID_ARGS', 'uid is required for action "message"');
        const p = new URLSearchParams();
        p.set('uid', String(q.uid));
        if (q.folder) p.set('folder', String(q.folder));
        url = `/api/email/message?${p.toString()}`;
      } else if (action === 'search') {
        if (!q.query) return respondError(webview, 'nova:mail:read', requestId, 'INVALID_ARGS', 'query is required for action "search"');
        const p = new URLSearchParams();
        p.set('q', String(q.query));
        if (q.folder) p.set('folder', String(q.folder));
        url = `/api/email/search?${p.toString()}`;
      } else {
        const p = new URLSearchParams();
        if (q.folder) p.set('folder', String(q.folder));
        if (q.page) p.set('page', String(q.page));
        if (q.limit) p.set('limit', String(q.limit));
        url = `/api/email/messages?${p.toString()}`;
      }
      const { status, json } = await authedJsonFetch(url, { app });
      if (status === 401) return mailNotConnectedError(webview, 'nova:mail:read', requestId);
      if (!json || json.error) {
        return respondError(webview, 'nova:mail:read', requestId, 'UNAVAILABLE', json?.error || 'Mail read request failed');
      }
      return respond(webview, 'nova:mail:read', requestId, { success: true, action, data: json });
    } catch (e) {
      return respondError(webview, 'nova:mail:read', requestId, 'UNAVAILABLE', e?.message || 'Mail read request failed');
    }
  }

  // mail:write — batch mutations that aren't deletion (mark-read, move)
  // plus HTML preview rendering. Deliberately excludes batch delete,
  // which is mail:delete's job even though both go through /api/email/batch.
  async function handleMailWrite({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('mail:write', app.id)) {
      return respondError(webview, 'nova:mail:write', requestId, 'PERMISSION_DENIED', 'mail:write permission required');
    }
    const q = payload ?? {};
    const action = q.action === 'preview' ? 'preview' : 'batch';
    try {
      if (action === 'preview') {
        if (typeof q.html !== 'string') return respondError(webview, 'nova:mail:write', requestId, 'INVALID_ARGS', 'html string is required for action "preview"');
        const { status, json } = await authedJsonFetch('/api/email/preview', { method: 'POST', body: { html: q.html }, app });
        if (status === 401) return mailNotConnectedError(webview, 'nova:mail:write', requestId);
        if (!json || json.error) {
          return respondError(webview, 'nova:mail:write', requestId, 'UNAVAILABLE', json?.error || 'Preview request failed');
        }
        return respond(webview, 'nova:mail:write', requestId, { success: true, action, token: json.token });
      }
      // action === 'batch', op must be 'read' or 'move' — 'delete' isn't
      // allowed through this handler, that's mail:delete's surface.
      const op = q.op === 'move' ? 'move' : 'read';
      const uids = Array.isArray(q.uids) ? q.uids : [];
      if (!uids.length) return respondError(webview, 'nova:mail:write', requestId, 'INVALID_ARGS', 'uids array is required');
      if (op === 'move' && !q.dest) return respondError(webview, 'nova:mail:write', requestId, 'INVALID_ARGS', 'dest is required for op "move"');
      const { status, json } = await authedJsonFetch('/api/email/batch', {
        method: 'POST',
        app,
        body: { op, uids, folder: q.folder || 'INBOX', dest: q.dest },
      });
      if (status === 401) return mailNotConnectedError(webview, 'nova:mail:write', requestId);
      if (!json || json.error) {
        return respondError(webview, 'nova:mail:write', requestId, 'UNAVAILABLE', json?.error || 'Mail batch request failed');
      }
      return respond(webview, 'nova:mail:write', requestId, { success: true, action, op });
    } catch (e) {
      return respondError(webview, 'nova:mail:write', requestId, 'UNAVAILABLE', e?.message || 'Mail write request failed');
    }
  }

  // mail:send — SMTP send via the connected account's credentials.
  // The server has no way to know the account's real SMTP host/port on its
  // own: /connect only stores the IMAP/POP3/EWS host (e.g. imap.gmail.com),
  // which is frequently a *different* host than SMTP (smtp.gmail.com) —
  // silently reusing the IMAP host caused real send failures (TLS cert
  // mismatch) before this was required explicitly. The Email app's own UI
  // has a dedicated SMTP Host/Port field for exactly this reason; a
  // sandboxed app calling mail:send needs to supply the same thing rather
  // than have this handler guess at it.
  async function handleMailSend({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('mail:send', app.id)) {
      return respondError(webview, 'nova:mail:send', requestId, 'PERMISSION_DENIED', 'mail:send permission required');
    }
    const q = payload ?? {};
    if (!q.to) return respondError(webview, 'nova:mail:send', requestId, 'INVALID_ARGS', 'to is required');
    if (!q.smtpHost) return respondError(webview, 'nova:mail:send', requestId, 'INVALID_ARGS', 'smtpHost is required — the server has no way to infer it from the connected IMAP/POP3/EWS account (they are frequently different hosts)');
    try {
      const { status, json } = await authedJsonFetch('/api/email/send', {
        method: 'POST',
        app,
        body: { to: q.to, cc: q.cc, bcc: q.bcc, subject: q.subject, text: q.text, html: q.html, host: q.smtpHost, port: q.smtpPort },
      });
      if (status === 401) return mailNotConnectedError(webview, 'nova:mail:send', requestId);
      if (!json || json.error) {
        return respondError(webview, 'nova:mail:send', requestId, 'UNAVAILABLE', json?.error || 'Send failed');
      }
      return respond(webview, 'nova:mail:send', requestId, { success: true, messageId: json.messageId });
    } catch (e) {
      return respondError(webview, 'nova:mail:send', requestId, 'UNAVAILABLE', e?.message || 'Send request failed');
    }
  }

  // mail:delete — batch delete only.
  async function handleMailDelete({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('mail:delete', app.id)) {
      return respondError(webview, 'nova:mail:delete', requestId, 'PERMISSION_DENIED', 'mail:delete permission required');
    }
    const q = payload ?? {};
    const uids = Array.isArray(q.uids) ? q.uids : [];
    if (!uids.length) return respondError(webview, 'nova:mail:delete', requestId, 'INVALID_ARGS', 'uids array is required');
    try {
      const { status, json } = await authedJsonFetch('/api/email/batch', {
        method: 'POST',
        app,
        body: { op: 'delete', uids, folder: q.folder || 'INBOX' },
      });
      if (status === 401) return mailNotConnectedError(webview, 'nova:mail:delete', requestId);
      if (!json || json.error) {
        return respondError(webview, 'nova:mail:delete', requestId, 'UNAVAILABLE', json?.error || 'Mail delete request failed');
      }
      return respond(webview, 'nova:mail:delete', requestId, { success: true, deleted: uids.length });
    } catch (e) {
      return respondError(webview, 'nova:mail:delete', requestId, 'UNAVAILABLE', e?.message || 'Mail delete request failed');
    }
  }

  // App list / install / uninstall
  //
  // These, together with launch (above) and info, are what 'system:apps'
  // actually gates. list/uninstall are straightforward reads/writes on
  // AppRegistry. install is the interesting one: the App Manager package's real
  // install flow (processFile in js/apps/appmanager/app.js) can require up to
  // three human confirmation dialogs — untrusted signer, tampered
  // contents, or "already installed, replace?" — none of which a
  // sandboxed app calling this over IPC can click through. Rather than
  // silently bypassing a security gate a human would otherwise have to
  // consciously approve, this handler fails closed: it only succeeds for
  // a package that is fully signed, trust-store-verified, and unmodified,
  // with no existing install of the same app id already present. Anything
  // that would need a dialog is rejected with a message telling the
  // caller to have the user install manually via App Manager instead.

  function resolveSandboxAppIcon(icon) {
    if (typeof icon !== 'string' || !icon) return null;
    if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|x-icon);/i.test(icon)) {
      return icon.length <= 700_000 ? icon : null;
    }
    if (/^\/assets\/[a-zA-Z0-9._/-]+$/.test(icon) && !icon.split('/').includes('..')) {
      return icon;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(icon) || typeof svgIcon !== 'function') return null;

    const markup = svgIcon(icon, 64);
    const svg = markup.match(/<svg\b[\s\S]*?<\/svg>/i)?.[0];
    if (svg) {
      const withNamespace = svg.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withNamespace)}`;
    }

    const assetPath = markup.match(/<img\b[^>]*\bsrc="(\/assets\/[a-zA-Z0-9._/-]+)"/i)?.[1];
    return assetPath && !assetPath.split('/').includes('..') ? assetPath : null;
  }

  async function handleAppList({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:apps', app.id)) {
      return respondError(webview, 'nova:app:list', requestId, 'PERMISSION_DENIED', 'system:apps permission required');
    }
    // AppRegistry.installedApps is NOT what built-in apps register into —
    // built-in apps call the global registerApp() in js/apps/registry/service.js, which writes
    // to OS.apps + the module-level APP_REGISTRY array. AppRegistry's own
    // store only ever gets entries from its initialize() localStorage
    // restore, so it's effectively empty for the running OS's actual app
    // set. APP_REGISTRY is the real, live list everything else (launchpad,
    // taskbar, App Manager) reads from.
    if (typeof APP_REGISTRY === 'undefined' || !Array.isArray(APP_REGISTRY)) {
      return respondError(webview, 'nova:app:list', requestId, 'UNAVAILABLE', 'App registry not available');
    }
    const apps = APP_REGISTRY.map(a => ({
      id: a.id,
      name: a.name,
      version: a.version || '1.0.0',
      icon: a.icon || null,
      iconUrl: resolveSandboxAppIcon(a.icon),
      description: a.description || '',
      categories: a.categories || [],
      verified: !!a.verified,
      system: a.system === true || a.manifest?.system === true,
      signer: a.signer || null,
      manifest: a.manifest ? { system: a.manifest.system === true } : undefined,
      source: a.source || 'local',
      builtin: a.source !== 'file',
      devOnly: a.devOnly === true,
    }));
    return respond(webview, 'nova:app:list', requestId, { success: true, apps });
  }

  async function handleAppUninstall({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:apps', app.id)) {
      return respondError(webview, 'nova:app:uninstall', requestId, 'PERMISSION_DENIED', 'system:apps permission required');
    }
    const { appId } = payload ?? {};
    if (!appId) {
      return respondError(webview, 'nova:app:uninstall', requestId, 'INVALID_ARGS', 'appId is required');
    }
    if (appId === app.id) {
      return respondError(webview, 'nova:app:uninstall', requestId, 'INVALID_ARGS', 'An app cannot uninstall itself');
    }
    if (typeof APP_REGISTRY === 'undefined' || !Array.isArray(APP_REGISTRY)) {
      return respondError(webview, 'nova:app:uninstall', requestId, 'UNAVAILABLE', 'App registry not available');
    }
    const target = APP_REGISTRY.find(a => a.id === appId);
    if (!target) {
      return respondError(webview, 'nova:app:uninstall', requestId, 'NOT_FOUND', `No installed app with id ${appId}`);
    }
    // Built-in apps (source !== 'file') were never installed as a
    // .novaapp package — there's no package files, storage partition, or
    // app-data directory to clean up, and the App Manager package's own uninstall
    // UI has no path for removing them either. Refuse rather than
    // half-uninstall something that isn't really an installed package.
    if (target.source !== 'file') {
      return respondError(webview, 'nova:app:uninstall', requestId, 'NOT_UNINSTALLABLE', `"${target.name}" is a built-in system app and cannot be uninstalled`);
    }
    // System-signed .novaapp packages (verified against the dedicated
    // 'NovaByte System' trust-store key, see app-package.js) are equally
    // not user- or app-removable, same reasoning as the built-in check
    // above — PackageStore.removeApp() enforces this too, but checking
    // here first gives a clearer error code/message than letting it fall
    // through to a generic UNAVAILABLE/silent-false from that call.
    if (target.system === true) {
      return respondError(webview, 'nova:app:uninstall', requestId, 'NOT_UNINSTALLABLE', `"${target.name}" is a system app and cannot be uninstalled`);
    }

    // Mirrors the App Manager package's doUninstall(): close open windows, then
    // clean up package files, the app's storage partition, and its app
    // data directory, then remove from every registry/list that tracks
    // it. Each cleanup step is independently best-effort (matching the
    // manual path's own try/catch-per-step), since a failure in one
    // (e.g. partition already cleared) shouldn't block the others.
    if (typeof WM !== 'undefined' && WM.closeWindow && OS?.windows && typeof OS.windows[Symbol.iterator] === 'function') {
      const openWindowIds = [];
      for (const [wid, wstate] of OS.windows) {
        if (wstate.appId === appId) openWindowIds.push(wid);
      }
      await Promise.all(openWindowIds.map(wid => WM.closeWindow(wid)));
    }
    try {
      if (typeof PackageStore !== 'undefined' && PackageStore?.removeApp) {
        await PackageStore.removeApp(appId, { updateRegistry: false });
      }
    } catch (e) {
      log('warn', 'nova:app:uninstall — failed to remove stored package files for', appId, e);
    }
    try {
      if (typeof AppSandbox !== 'undefined' && AppSandbox.clearAppPartition) {
        await AppSandbox.clearAppPartition(appId);
      }
    } catch (e) {
      log('warn', 'nova:app:uninstall — failed to clear storage partition for', appId, e);
    }
    try {
      if (typeof AppDirs !== 'undefined' && AppDirs.removeAppData) {
        await AppDirs.removeAppData(appId);
      }
    } catch (e) {
      log('warn', 'nova:app:uninstall — failed to clear app data for', appId, e);
    }
    // Drop the notification rate-limit entry so it doesn't leak across
    // an uninstall/reinstall cycle for the same app id.
    clearNotificationRateLimit(appId);
    clearDefaultAppsRateLimit(appId);

    delete OS.apps[appId];
    const ri = APP_REGISTRY.findIndex(a => a.id === appId);
    if (ri > -1) APP_REGISTRY.splice(ri, 1);

    // the App Manager package's own local installedApps array + its persisted copy
    // is a THIRD place tracking installed-from-file apps, independent of
    // APP_REGISTRY/OS.apps — remove from there too if it's reachable from
    // this scope, same as the manual uninstall path does.
    try {
      if (typeof installedApps !== 'undefined' && Array.isArray(installedApps)) {
        const ii = installedApps.findIndex(a => a.id === appId);
        if (ii > -1) installedApps.splice(ii, 1);
        if (typeof saveStoredApps === 'function') saveStoredApps(installedApps);
      }
    } catch (e) {
      // the App Manager's local state isn't in scope here — APP_REGISTRY/
      // OS.apps removal above is the part that actually matters.
      log('debug', 'nova:app:uninstall — could not sync App Manager local state for', appId, e);
    }

    OS.settings?.set?.('pinnedApps', (OS.settings?.get?.('pinnedApps') || []).filter(id => id !== appId));
    if (typeof WM !== 'undefined' && WM.updateTaskbar) WM.updateTaskbar();
    if (typeof renderDesktopIcons === 'function') {
      try { renderDesktopIcons(); } catch (e) { log('debug', 'renderDesktopIcons threw during uninstall', e); }
    }

    return respond(webview, 'nova:app:uninstall', requestId, { success: true, removed: true });
  }

  async function handleAppInstall({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:apps', app.id)) {
      return respondError(webview, 'nova:app:install', requestId, 'PERMISSION_DENIED', 'system:apps permission required');
    }
    const { package: pkg } = payload ?? {};
    if (!pkg || typeof pkg !== 'object') {
      return respondError(webview, 'nova:app:install', requestId, 'INVALID_ARGS', 'package (a parsed .novaapp object) is required');
    }
    if (!pkg.manifest?.id || !pkg.manifest?.name || !pkg.manifest?.version) {
      return respondError(webview, 'nova:app:install', requestId, 'INVALID_PACKAGE', 'Missing required manifest fields (id, name, version)');
    }

    // Malware/heuristic scan — same as the manual install path, and
    // equally non-negotiable: no override, no "proceed anyway".
    if (window.Scanner?.scanBase64 && pkg.files && typeof pkg.files === 'object') {
      for (const [relPath, rawB64] of Object.entries(pkg.files)) {
        if (typeof rawB64 !== 'string') continue;
        try {
          const verdict = await window.Scanner.scanBase64(relPath, rawB64);
          if (!verdict.safe) {
            return respondError(webview, 'nova:app:install', requestId, 'MALICIOUS_PACKAGE',
              `File "${relPath}" was flagged and installation was blocked: ${verdict.reason || 'matched a pattern associated with malicious files'}`);
          }
        } catch (err) {
          // Scanner error is treated as inconclusive, not a pass — the
          // manual path silently continues past scanner errors (best
          // effort, since a human is still there to react to whatever
          // comes next), but this unattended path has no human backstop,
          // so an inconclusive scan blocks install instead.
          return respondError(webview, 'nova:app:install', requestId, 'SCAN_FAILED', `Could not scan "${relPath}": ${err?.message || err}`);
        }
      }
    }

    // Integrity — must be present and must pass. No informational-only
    // path here (the manual flow can warn-and-proceed via a dialog; this
    // one can't warn anyone, so a failed or missing integrity check is a
    // hard stop).
    if (!pkg.integrity || typeof AppPackage === 'undefined' || typeof AppPackage.verifyIntegrity !== 'function') {
      return respondError(webview, 'nova:app:install', requestId, 'UNVERIFIED', 'Package has no integrity record — install manually via App Manager');
    }
    let integrityOk = false;
    try { integrityOk = await AppPackage.verifyIntegrity(pkg); } catch (e) {
      log('warn', 'nova:app:install — integrity verification threw for', pkg.manifest.id, e);
    }
    if (!integrityOk) {
      return respondError(webview, 'nova:app:install', requestId, 'TAMPERED', 'Package contents do not match their recorded integrity hashes — install manually via App Manager to review');
    }

    // Trust — must be signed and the signature must resolve to a trusted
    // entry in the trust store, not revoked. This is the check that
    // rejects unsigned packages by design, same as the manual flow would
    // show "Unverified" for one.
    if (typeof AppPackage === 'undefined' || typeof AppPackage.verifyAgainstTrustStore !== 'function' || typeof TrustStore === 'undefined') {
      return respondError(webview, 'nova:app:install', requestId, 'UNAVAILABLE', 'Trust store not available');
    }
    let trustResult;
    try {
      const revocationCheck = typeof TrustStore.isRevoked === 'function' ? TrustStore.isRevoked : undefined;
      trustResult = await AppPackage.verifyAgainstTrustStore(pkg, TrustStore.list(), revocationCheck);
    } catch (e) {
      log('warn', 'nova:app:install — trust verification threw for', pkg.manifest.id, e);
      trustResult = { trusted: false, signer: null };
    }
    if (!trustResult.trusted) {
      const reason = trustResult.revoked ? 'the signature is on the revocation list' : 'the package is unsigned or not from a trusted publisher';
      return respondError(webview, 'nova:app:install', requestId, 'UNTRUSTED', `Install blocked — ${reason}. Install manually via App Manager to review and confirm.`);
    }

    // Already-installed — the manual flow asks "replace?"; this path has
    // no one to ask, so it refuses rather than silently overwriting an
    // existing install (which could be a downgrade, or could clobber user
    // data tied to the old version).
    if (typeof AppRegistry === 'undefined' || typeof AppRegistry.getApp !== 'function' || typeof AppRegistry.registerApp !== 'function') {
      return respondError(webview, 'nova:app:install', requestId, 'UNAVAILABLE', 'App registry not available');
    }
    const existing = AppRegistry.getApp(pkg.manifest.id);
    if (existing) {
      return respondError(webview, 'nova:app:install', requestId, 'ALREADY_INSTALLED', `"${pkg.manifest.name}" (${pkg.manifest.id}) is already installed — install manually via App Manager to replace it`);
    }

    // All gates passed: signed, trusted, unmodified, not a duplicate.
    // Register it the same way the App Manager package's manual path ultimately
    // does — via AppRegistry, not by hand-rolling a second code path.
    try {
      const appData = {
        ...pkg.manifest,
        manifest: pkg.manifest,
        files: pkg.files,
        signature: pkg.signature,
        integrity: pkg.integrity,
        verified: true,
        signer: trustResult.signer,
        source: 'file',
        installedDate: new Date().toISOString(),
      };
      const registered = AppRegistry.registerApp(appData);
      return respond(webview, 'nova:app:install', requestId, {
        success: true,
        id: registered.id,
        name: registered.name,
        version: registered.version,
      });
    } catch (e) {
      return respondError(webview, 'nova:app:install', requestId, 'ERROR', e?.message || 'Unknown error');
    }
  }

  // Events
  //
  // Basic appearance/workspace/device-state events are public; sensitive
  // app inventory and user-data events require system:events.
  // Without an allowlist, an app could subscribe to internal channels like
  // 'settings:changed' (which fires for every settings write, including
  // password/PIN updates from system code) or 'os:volumeChanged' purely for
  // reconnaissance. Limit subscriptions to the public event surface — names
  // the OS explicitly emits for app consumption — and reject anything else
  // rather than forwarding it.
  const ALLOWED_EVENT_NAMES = new Set([
    'system:notification', 'system:volumeChanged', 'system:themeChanged',
    'system:workspaceChanged', 'system:power', 'system:network',
    'app:installed', 'app:uninstalled', 'app:launched',
    // As of this comment, nothing in the codebase calls OS.events.emit()
    // for any of the five names below — subscribing today is a no-op, not
    // a live leak. Pre-declared for whoever wires up mail/calendar/contacts
    // sync, gated on the same *:read permission each domain's actual data
    // access already requires (see EVENT_DOMAIN_PERMISSIONS below), rather
    // than being reachable through the flat system:events grant alone. An
    // app that can already read your mail gains nothing new from mail:new
    // notifications; an app that only holds system:events (for volume/
    // theme/power — genuinely low-stakes) can't piggyback into mail
    // metadata just because these names exist in this set. Whoever
    // implements the emit side should still double check the actual
    // payload shape against this gate once it's real, since this was
    // designed against the *names* only — no payload existed to review.
    'mail:new', 'mail:updated',
    'calendar:reminder', 'calendar:updated',
    'contacts:updated',
  ]);
  const SENSITIVE_EVENT_NAMES = new Set([
    'system:notification', 'app:installed', 'app:uninstalled', 'app:launched',
    'mail:new', 'mail:updated', 'calendar:reminder', 'calendar:updated', 'contacts:updated',
  ]);

  // Domain-gated events: subscribing requires system:events AND the listed
  // permission, not system:events alone. Events not listed here only need
  // system:events, same as before this split.
  const EVENT_DOMAIN_PERMISSIONS = new Map([
    ['mail:new', 'mail:read'],
    ['mail:updated', 'mail:read'],
    ['calendar:reminder', 'calendar:read'],
    ['calendar:updated', 'calendar:read'],
    ['contacts:updated', 'contacts:read'],
  ]);

  async function handleEventsSubscribe({ payload, requestId, app, webview, sandbox }) {
    const { event } = payload ?? {};
    if (SENSITIVE_EVENT_NAMES.has(event) && !AppPermissionManager.isGranted('system:events', app.id)) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'PERMISSION_DENIED', 'system:events permission required');
    }
    if (!event) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'INVALID_ARGS', 'event name is required');
    }
    if (typeof event !== 'string' || !ALLOWED_EVENT_NAMES.has(event)) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'INVALID_ARGS', `Event '${event}' is not in the subscribable allowlist`);
    }
    const domainPermission = EVENT_DOMAIN_PERMISSIONS.get(event);
    if (domainPermission && !AppPermissionManager.isGranted(domainPermission, app.id)) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'PERMISSION_DENIED', `${domainPermission} permission required to subscribe to '${event}'`);
    }
    const sandboxId = webview.dataset.sandboxId;
    const subs = eventSubscriptions.get(sandboxId);
    if (subs && subs.has(event)) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'ALREADY_SUBSCRIBED', `Already subscribed to '${event}'`);
    }
    const handler = (data) => {
      respond(webview, 'nova:events:event', generateRequestId(), { event, data });
    };
    // Only register and record the subscription if OS.events actually
    // exists — otherwise we'd record a handler that never fires and
    // silently mislead the app into thinking it's subscribed.
    if (!OS?.events?.on) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'UNAVAILABLE', 'Event bus not available');
    }
    OS.events.on(event, handler);
    if (subs) subs.set(event, handler);
    return respond(webview, 'nova:events:subscribe', requestId, { success: true, subscribed: event });
  }

  async function handleEventsUnsubscribe({ payload, requestId, app, webview }) {
    const { event } = payload ?? {};
    const subs = eventSubscriptions.get(webview.dataset.sandboxId);
    if (subs && subs.has(event)) {
      const handler = subs.get(event);
      OS?.events?.off(event, handler);
      subs.delete(event);
    }
    return respond(webview, 'nova:events:unsubscribe', requestId, { success: true, unsubscribed: event });
  }

  // Network: fetch

  async function handleNetFetch({ payload, requestId, app, webview }) {
    const { url: rawUrl, method, headers, body } = payload ?? {};
    if (!rawUrl) {
      return respondError(webview, 'nova:net:fetch', requestId, 'INVALID_ARGS', 'url is required');
    }
    const safeMethod = (method || 'GET').toUpperCase();
    if (!ALLOWED_HTTP_METHODS.has(safeMethod)) {
      return respondError(webview, 'nova:net:fetch', requestId, 'INVALID_ARGS', `Method not allowed: ${safeMethod}`);
    }
    // Resolve and classify the URL in one pass. This catches protocol-relative
    // URLs (//evil.com) that the old leading-slash check missed.
    const classified = resolveAndClassifyUrl(rawUrl);
    if (!classified.valid) {
      return respondError(webview, 'nova:net:fetch', requestId, 'INVALID_ARGS', classified.error);
    }
    const netPerm = classified.isInternal ? 'net:internal' : 'net:external';
    if (!AppPermissionManager.isGranted(netPerm, app.id)) {
      return respondError(webview, 'nova:net:fetch', requestId, 'PERMISSION_DENIED', `${netPerm} permission required`);
    }
    // Normalize headers to a plain object — apps can pass a Headers instance,
    // an array of pairs, or a plain object. Same conversion the shim does
    // client-side; redo here so the proxy path doesn't choke on a non-plain
    // value getting JSON.stringify'd.
    const headerObj = {};
    if (headers && typeof headers === 'object') {
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        headers.forEach((v, k) => { headerObj[k] = v; });
      } else if (Array.isArray(headers)) {
        for (const pair of headers) {
          if (Array.isArray(pair) && pair.length >= 2) {
            headerObj[String(pair[0])] = String(pair[1]);
          }
        }
      } else {
        for (const k of Object.keys(headers)) {
          headerObj[k] = String(headers[k]);
        }
      }
    }
    try {
      let resStatus, resStatusText, resHeaders, resBody, resBodyEncoding = 'utf8';

      if (classified.isInternal) {
        // Same-origin requests don't hit CORS, so go direct.
        Object.assign(headerObj, systemAppRateLimitHeaders(app));
        const res = await fetch(classified.url, {
          method: safeMethod,
          headers: headerObj,
          body: body ?? null,
        });
        resStatus = res.status;
        resStatusText = res.statusText;
        resHeaders = Object.fromEntries(res.headers.entries());
        const contentType = (res.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
        const isTextual = contentType.startsWith('text/')
          || contentType === 'application/json'
          || contentType === 'application/javascript'
          || contentType === 'application/xml'
          || contentType === 'application/x-www-form-urlencoded'
          || contentType.endsWith('+json')
          || contentType.endsWith('+xml');
        if (isTextual) {
          resBody = await res.text();
        } else {
          resBody = encodeBase64Bytes(new Uint8Array(await res.arrayBuffer()));
          resBodyEncoding = 'base64';
        }
      } else {
        // External requests go through the server-side proxy. A direct fetch()
        // from this document would be subject to the target server's CORS
        // policy (most external APIs don't allow browser-origin requests),
        // so we hand the request to /api/proxy, which makes it server-to-server.
        const { status: proxyStatus, ok, json: proxyJson } = await authedJsonFetch('/api/proxy', {
          method: 'POST',
          app,
          body: { url: classified.url, method: safeMethod, headers: headerObj, body: body ?? null },
        });
        if (!ok) {
          return respondError(webview, 'nova:net:fetch', requestId, 'NETWORK_ERROR', proxyJson?.error || `Proxy request failed (${proxyStatus})`);
        }
        resStatus = proxyJson.status;
        resStatusText = proxyJson.statusText;
        resHeaders = proxyJson.headers || {};
        resBody = proxyJson.body || '';
        resBodyEncoding = proxyJson.bodyEncoding || 'utf8';
      }

      return respond(webview, 'nova:net:fetch', requestId, {
        success: true,
        status: resStatus,
        statusText: resStatusText,
        headers: resHeaders,
        body: resBody,
        bodyEncoding: resBodyEncoding,
      });
    } catch (e) {
      return respondError(webview, 'nova:net:fetch', requestId, 'NETWORK_ERROR', e?.message || String(e));
    }
  }

  // Network: WebSocket

  async function handleNetWebsocket({ payload, requestId, app, webview, sandbox }) {
    const { url, protocols } = payload ?? {};
    if (!url) {
      return respondError(webview, 'nova:net:websocket', requestId, 'INVALID_ARGS', 'url is required');
    }
    if (typeof WebSocket === 'undefined') {
      return respondError(webview, 'nova:net:websocket', requestId, 'UNAVAILABLE', 'WebSocket not supported');
    }
    if (!AppPermissionManager.isGranted('net:websocket', app.id)) {
      return respondError(webview, 'nova:net:websocket', requestId, 'PERMISSION_DENIED', 'net:websocket permission required');
    }
    let ws;
    try {
      ws = protocols?.length
        ? new WebSocket(url, protocols)
        : new WebSocket(url);
    } catch (e) {
      return respondError(webview, 'nova:net:websocket', requestId, 'INVALID_ARGS', e?.message || 'Unknown error');
    }
    const wsId = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    // Track the WebSocket so destroy() can close it when the sandbox is torn
    // down. Without this, sockets would outlive their app and leak.
    if (sandbox) {
      if (!sandbox.wsConnections) sandbox.wsConnections = new Map();
      sandbox.wsConnections.set(wsId, { ws, appId: app.id });
    }
    ws.onopen = () => respond(webview, 'nova:net:websocket', requestId, { success: true, wsId, readyState: ws.readyState });
    ws.onmessage = (e) => {
      respond(webview, 'nova:net:ws:message', generateRequestId(), { wsId, data: e.data });
    };
    ws.onerror = () => {
      respond(webview, 'nova:net:ws:error', generateRequestId(), { wsId, error: 'WebSocket error' });
    };
    ws.onclose = (e) => {
      respond(webview, 'nova:net:ws:close', generateRequestId(), {
        wsId, code: e.code, reason: e.reason, clean: e.wasClean,
      });
      sandbox?.wsConnections?.delete(wsId);
    };
    // Response is sent asynchronously via onopen; nothing to return here.
  }

  async function handleNetWsSend({ payload, requestId, sandbox, webview }) {
    const { wsId, data } = payload ?? {};
    if (typeof WebSocket === 'undefined') {
      return respondError(webview, 'nova:net:ws:send', requestId, 'UNAVAILABLE', 'WebSocket not supported');
    }
    if (!wsId || typeof wsId !== 'string') {
      return respondError(webview, 'nova:net:ws:send', requestId, 'INVALID_ARGS', 'wsId is required');
    }
    const wsState = sandbox?.wsConnections?.get(wsId);
    if (!wsState) {
      return respondError(webview, 'nova:net:ws:send', requestId, 'NOT_FOUND', 'WebSocket connection not found');
    }
    if (wsState.ws.readyState !== WebSocket.OPEN) {
      return respondError(webview, 'nova:net:ws:send', requestId, 'INVALID_STATE', 'WebSocket is not open');
    }
    // Coerce data to a string — ws.send accepts strings, ArrayBuffers,
    // and Blobs, but IPC values come through JSON.parse so anything
    // non-string here is probably an object the app meant to JSON-encode.
    let payload2send = data;
    if (payload2send == null) payload2send = '';
    else if (typeof payload2send === 'object') payload2send = JSON.stringify(payload2send);
    else payload2send = String(payload2send);
    try {
      wsState.ws.send(payload2send);
    } catch (e) {
      return respondError(webview, 'nova:net:ws:send', requestId, 'INVALID_STATE', e?.message || 'Failed to send');
    }
    return respond(webview, 'nova:net:ws:send', requestId, { success: true });
  }

  async function handleNetWsClose({ payload, requestId, sandbox, webview }) {
    const { wsId, code, reason } = payload ?? {};
    const wsState = sandbox?.wsConnections?.get(wsId);
    if (wsState) {
      try { wsState.ws.close(code ?? 1000, reason); } catch { /* already closed */ }
      sandbox?.wsConnections?.delete(wsId);
    }
    return respond(webview, 'nova:net:ws:close', requestId, { success: true });
  }

  // Storage
  //
  // Backed by a single host-side IndexedDB database (NovaByte_AppStorage),
  // NOT localStorage. localStorage lives on the shared shell origin and is
  // readable by anything with same-origin access — a string key prefix
  // isn't real isolation, it just stops accidental collisions. IndexedDB
  // here still lives in the host's origin, but every record is keyed by
  // [appId, key] and every operation is scoped with an IDBKeyRange bound
  // to the calling app's own appId, so one app's IPC calls can never read,
  // enumerate, or clear another app's rows even if it somehow forged a
  // request. Key characters are also restricted to prevent path-like
  // injection confusing downstream consumers of the raw key string.

  const STORAGE_DB_NAME = 'NovaByte_AppStorage';
  const STORAGE_DB_VERSION = 1;
  const STORAGE_STORE = 'kv';
  let storageDbPromise = null;

  function openStorageDB() {
    if (storageDbPromise) return storageDbPromise;
    storageDbPromise = new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(STORAGE_DB_NAME, STORAGE_DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORAGE_STORE)) {
          // Composite keyPath so [appId, key] is unique and directly
          // addressable; the appId index lets clear/keys range-scan just
          // that app's rows instead of iterating every app's data.
          const store = d.createObjectStore(STORAGE_STORE, { keyPath: ['appId', 'key'] });
          store.createIndex('by_appId', 'appId');
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = () => reject(req.error || new Error('Failed to open storage database'));
    });
    // If opening fails, drop the cached promise so the next caller can retry
    // rather than permanently rejecting forever.
    storageDbPromise.catch(() => { storageDbPromise = null; });
    return storageDbPromise;
  }

  function storageAppRange(appId) {
    return IDBKeyRange.bound([appId, ''], [appId, '\uffff'], false, false);
  }

  async function storageGet(appId, key) {
    const db = await openStorageDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readonly');
      const req = tx.objectStore(STORAGE_STORE).get([appId, key]);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
  }

  // Look up the existing byteSize for a key in a single read, used by
  // storageSet's quota check. Returns 0 if the key doesn't exist yet.
  function storageExistingByteSize(db, appId, key) {
    return new Promise((resolve) => {
      const tx = db.transaction(STORAGE_STORE, 'readonly');
      const req = tx.objectStore(STORAGE_STORE).get([appId, key]);
      req.onsuccess = () => resolve(req.result ? (req.result.byteSize || 0) : 0);
      req.onerror = () => resolve(0);
    });
  }

  async function storageAppUsageBytes(appId, db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readonly');
      const idx = tx.objectStore(STORAGE_STORE).index('by_appId');
      const req = idx.openCursor(IDBKeyRange.only(appId));
      let total = 0;
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          total += cursor.value.byteSize || 0;
          cursor.continue();
        } else {
          resolve(total);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function storageSet(appId, key, value, valueBytes) {
    const db = await openStorageDB();
    // Check quota against existing usage for this app minus whatever this
    // key already costs (so overwriting an existing key isn't double-counted).
    // Previously this made two redundant storageGet round-trips — one
    // discarded, one that only read byteSize. Now it's a single read.
    const [usage, existing] = await Promise.all([
      storageAppUsageBytes(appId, db),
      storageExistingByteSize(db, appId, key),
    ]);
    if (usage - existing + valueBytes > STORAGE_APP_QUOTA_BYTES) {
      const err = new Error('Storage quota exceeded');
      err.code = 'STORAGE_FULL';
      throw err;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readwrite');
      tx.objectStore(STORAGE_STORE).put({ appId, key, value, byteSize: valueBytes });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function storageDelete(appId, key) {
    const db = await openStorageDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readwrite');
      tx.objectStore(STORAGE_STORE).delete([appId, key]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function storageClear(appId) {
    const db = await openStorageDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readwrite');
      tx.objectStore(STORAGE_STORE).index('by_appId').openCursor(IDBKeyRange.only(appId)).onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Wipe every row in the nova:storage store, regardless of appId. For
  // factory-reset / "Wipe All Data" — unlike storageClear(appId), this
  // isn't scoped to one app because a factory reset needs to clear
  // everything, including any rows left behind by an app that's since
  // been uninstalled (an already-cleaned entry wouldn't appear in
  // OS.apps for a per-appId sweep to find). Goes through the same
  // cached connection as every other storage* function rather than
  // indexedDB.deleteDatabase(STORAGE_DB_NAME) directly, since a raw
  // delete call would block on this module's own open connection
  // (storageDbPromise) for the lifetime of the session.
  async function clearAllStorage() {
    const db = await openStorageDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readwrite');
      tx.objectStore(STORAGE_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function storageKeys(appId) {
    const db = await openStorageDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readonly');
      const req = tx.objectStore(STORAGE_STORE).index('by_appId').openCursor(IDBKeyRange.only(appId));
      const keys = [];
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          keys.push(cursor.value.key);
          cursor.continue();
        } else {
          resolve(keys);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  function validateStorageKey(rawKey) {
    const key = String(rawKey ?? '');
    if (!key || !STORAGE_KEY_REGEX.test(key)) return null;
    return key;
  }

  async function handleStorageGet({ payload, requestId, app, webview }) {
    const rawKey = validateStorageKey(payload?.key);
    if (!rawKey) {
      return respondError(webview, 'nova:storage:get', requestId, 'INVALID_ARGS', 'Invalid storage key');
    }
    try {
      const value = await storageGet(app.id, rawKey);
      return respond(webview, 'nova:storage:get', requestId, { success: true, value });
    } catch (e) {
      // IndexedDB can throw if disabled/unavailable (e.g. private browsing
      // in some browsers). Treat as "no value" rather than crashing the IPC call.
      log('debug', 'storageGet failed, returning null', e);
      return respond(webview, 'nova:storage:get', requestId, { success: true, value: null });
    }
  }

  async function handleStorageSet({ payload, requestId, app, webview }) {
    const rawKey = validateStorageKey(payload?.key);
    if (!rawKey) {
      return respondError(webview, 'nova:storage:set', requestId, 'INVALID_ARGS', 'Invalid storage key');
    }
    // Enforce a per-value size cap, and storageSet enforces the per-app quota
    // against real existing usage in the DB (not just a per-call check).
    // IndexedDB stores structured values directly, so an object value's real
    // on-disk size is its JSON representation — measure that, not the
    // '[object Object]' that String(value) would give, otherwise the quota
    // check is silently too lenient for any non-string value.
    const value = payload?.value ?? '';
    const valueBytes = sharedTextEncoder.encode(
      typeof value === 'string' ? value : JSON.stringify(value)
    ).length;
    if (valueBytes > STORAGE_VALUE_MAX_BYTES) {
      return respondError(webview, 'nova:storage:set', requestId, 'STORAGE_FULL', `Value exceeds ${STORAGE_VALUE_MAX_BYTES} byte limit`);
    }
    try {
      await storageSet(app.id, rawKey, value, valueBytes);
      return respond(webview, 'nova:storage:set', requestId, { success: true });
    } catch (e) {
      if (e && e.code === 'STORAGE_FULL') {
        return respondError(webview, 'nova:storage:set', requestId, 'STORAGE_FULL', 'Per-app storage quota exceeded');
      }
      return respondError(webview, 'nova:storage:set', requestId, 'STORAGE_FULL', 'Failed to write to storage');
    }
  }

  async function handleStorageDelete({ payload, requestId, app, webview }) {
    const rawKey = validateStorageKey(payload?.key);
    if (!rawKey) {
      return respondError(webview, 'nova:storage:delete', requestId, 'INVALID_ARGS', 'Invalid storage key');
    }
    try {
      await storageDelete(app.id, rawKey);
      return respond(webview, 'nova:storage:delete', requestId, { success: true });
    } catch (e) {
      return respondError(webview, 'nova:storage:delete', requestId, 'ERROR', e?.message || 'Unknown error');
    }
  }

  async function handleStorageClear({ requestId, app, webview }) {
    try {
      await storageClear(app.id);
      return respond(webview, 'nova:storage:clear', requestId, { success: true });
    } catch (e) {
      return respondError(webview, 'nova:storage:clear', requestId, 'ERROR', e?.message || 'Unknown error');
    }
  }

  async function handleStorageKeys({ requestId, app, webview }) {
    try {
      const keys = await storageKeys(app.id);
      return respond(webview, 'nova:storage:keys', requestId, { success: true, keys });
    } catch (e) {
      return respondError(webview, 'nova:storage:keys', requestId, 'ERROR', e?.message || 'Unknown error');
    }
  }

  // Device: geolocation

  async function handleDeviceGeolocation({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:geolocation', app.id)) {
      return respondError(webview, 'nova:device:geolocation', requestId, 'PERMISSION_DENIED', 'device:geolocation permission required');
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return respondError(webview, 'nova:device:geolocation', requestId, 'UNAVAILABLE', 'Geolocation not available');
    }
    // Response is sent from one of the two callbacks below; we don't respond
    // here because getCurrentPosition returns immediately.
    navigator.geolocation.getCurrentPosition(
      (pos) => respond(webview, 'nova:device:geolocation', requestId, {
        success: true,
        coords: {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          altitude: pos.coords.altitude,
          accuracy: pos.coords.accuracy,
          altitudeAccuracy: pos.coords.altitudeAccuracy,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
        },
        timestamp: pos.timestamp,
      }),
      (err) => respondError(webview, 'nova:device:geolocation', requestId, 'GEOLOCATION_ERROR', err?.message || 'Geolocation error'),
      payload.options || {}
    );
  }

  // Device: camera / microphone
  //
  // Unlike geolocation, a getUserMedia() MediaStream can't cross the IPC
  // bridge at all — it isn't serializable, and this handler runs in the
  // host shell's own document, not inside the guest webview that would
  // actually consume the stream. So these two handlers are
  // authorization-only: they check AppPermissionManager and report
  // whether the app is allowed to use the camera/microphone. The guest is
  // expected to then call navigator.mediaDevices.getUserMedia() itself,
  // inside its own document — see window.nova.getUserMedia in the
  // capability shim below, which calls this check first and only then
  // makes the real getUserMedia() call. That real call still goes through
  // the webview's own permissionrequest gate (setupPermissionRequestGate,
  // 'media' branch) as the actual browser-level enforcement point; this
  // handler is the app-level permission gate, a separate decision the
  // browser-level gate doesn't know about on its own.

  async function handleDeviceCamera({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:camera', app.id)) {
      return respondError(webview, 'nova:device:camera', requestId, 'PERMISSION_DENIED', 'device:camera permission required');
    }
    return respond(webview, 'nova:device:camera', requestId, { success: true, authorized: true });
  }

  async function handleDeviceMicrophone({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:microphone', app.id)) {
      return respondError(webview, 'nova:device:microphone', requestId, 'PERMISSION_DENIED', 'device:microphone permission required');
    }
    return respond(webview, 'nova:device:microphone', requestId, { success: true, authorized: true });
  }

  // Calendar
  //
  // Shared calendar service for sandboxed third-party apps. The trusted host
  // Calendar app (com.nbosp.calendar) reads/writes this same store directly;
  // these IPC handlers retain per-app permission checks and input validation.
  // Sanitization prevents malformed events from reaching the Calendar UI.

  const CALENDAR_STORE_KEY = 'calendar_events_v2';
  const CALENDAR_COLORS = Object.freeze(['#58a6ff','#3fb950','#d29922','#f85149','#bc8cff','#ff7b72','#79c0ff','#56d364']);

  function sanitizeCalendarEvent(ev) {
    if (!ev || typeof ev !== 'object') return null;
    if (typeof ev.title !== 'string' || !ev.title.trim()) return null;
    if (typeof ev.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) return null;
    return {
      id:        typeof ev.id === 'string' && ev.id ? ev.id : cryptoRandomId(),
      title:     ev.title.trim(),
      date:      ev.date,
      timeStart: typeof ev.timeStart === 'string' ? ev.timeStart : '',
      timeEnd:   typeof ev.timeEnd   === 'string' ? ev.timeEnd   : '',
      desc:      typeof ev.desc      === 'string' ? ev.desc      : '',
      color:     CALENDAR_COLORS.includes(ev.color) ? ev.color : CALENDAR_COLORS[0],
    };
  }

  function cryptoRandomId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
      : `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function loadCalendarEvents() {
    try {
      const raw = JSON.parse(localStorage.getItem(CALENDAR_STORE_KEY) ?? '[]');
      return Array.isArray(raw) ? raw.map(sanitizeCalendarEvent).filter(Boolean) : [];
    } catch { return []; }
  }

  function saveCalendarEvents(evs) {
    localStorage.setItem(CALENDAR_STORE_KEY, JSON.stringify(evs));
  }

  async function handleCalendarRead({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('calendar:read', app.id)) {
      return respondError(webview, 'nova:calendar:read', requestId, 'PERMISSION_DENIED', 'calendar:read permission required');
    }
    return respond(webview, 'nova:calendar:read', requestId, { success: true, events: loadCalendarEvents() });
  }

  async function handleCalendarWrite({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('calendar:write', app.id)) {
      return respondError(webview, 'nova:calendar:write', requestId, 'PERMISSION_DENIED', 'calendar:write permission required');
    }
    const incoming = sanitizeCalendarEvent(payload && payload.event);
    if (!incoming) {
      return respondError(webview, 'nova:calendar:write', requestId, 'INVALID_EVENT', 'Event must have a title and a YYYY-MM-DD date');
    }
    const events = loadCalendarEvents();
    const idx = events.findIndex(e => e.id === incoming.id);
    if (idx >= 0) events[idx] = incoming; else events.push(incoming);
    saveCalendarEvents(events);
    return respond(webview, 'nova:calendar:write', requestId, { success: true, event: incoming });
  }

  async function handleCalendarDelete({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('calendar:delete', app.id)) {
      return respondError(webview, 'nova:calendar:delete', requestId, 'PERMISSION_DENIED', 'calendar:delete permission required');
    }
    const id = payload && payload.id;
    if (typeof id !== 'string' || !id) {
      return respondError(webview, 'nova:calendar:delete', requestId, 'INVALID_ID', 'id must be a non-empty string');
    }
    const events = loadCalendarEvents();
    const next = events.filter(e => e.id !== id);
    const removed = next.length !== events.length;
    saveCalendarEvents(next);
    return respond(webview, 'nova:calendar:delete', requestId, { success: true, removed });
  }

  // Contacts
  //
  // Same shared-host-storage model as Calendar above; mirrors
  // js/apps/contacts.js's isValidContact() sanitization exactly.

  const CONTACTS_STORE_KEY = 'nova_contacts';

  function isValidContact(c) {
    return c !== null && typeof c === 'object' &&
      typeof c.id === 'string' && c.id.length > 0 &&
      typeof c.name === 'string' &&
      typeof c.email === 'string' &&
      typeof c.phone === 'string' &&
      typeof c.notes === 'string';
  }

  function loadContacts() {
    try {
      const raw = localStorage.getItem(CONTACTS_STORE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter(isValidContact).map(c => ({
        id: String(c.id), name: String(c.name), email: String(c.email),
        phone: String(c.phone), notes: String(c.notes),
      }));
    } catch { return []; }
  }

  function saveContacts(arr) {
    localStorage.setItem(CONTACTS_STORE_KEY, JSON.stringify(arr));
  }

  async function handleContactsRead({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('contacts:read', app.id)) {
      return respondError(webview, 'nova:contacts:read', requestId, 'PERMISSION_DENIED', 'contacts:read permission required');
    }
    return respond(webview, 'nova:contacts:read', requestId, { success: true, contacts: loadContacts() });
  }

  async function handleContactsWrite({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('contacts:write', app.id)) {
      return respondError(webview, 'nova:contacts:write', requestId, 'PERMISSION_DENIED', 'contacts:write permission required');
    }
    const incoming = payload && payload.contact;
    if (!incoming || typeof incoming !== 'object' || typeof incoming.name !== 'string' || !incoming.name.trim()) {
      return respondError(webview, 'nova:contacts:write', requestId, 'INVALID_CONTACT', 'Contact must have at least a name');
    }
    const contact = {
      id: typeof incoming.id === 'string' && incoming.id ? incoming.id : cryptoRandomId(),
      name: incoming.name.trim(),
      email: typeof incoming.email === 'string' ? incoming.email : '',
      phone: typeof incoming.phone === 'string' ? incoming.phone : '',
      notes: typeof incoming.notes === 'string' ? incoming.notes : '',
    };
    const contacts = loadContacts();
    const idx = contacts.findIndex(c => c.id === contact.id);
    if (idx >= 0) contacts[idx] = contact; else contacts.push(contact);
    saveContacts(contacts);
    return respond(webview, 'nova:contacts:write', requestId, { success: true, contact });
  }

  async function handleContactsDelete({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('contacts:delete', app.id)) {
      return respondError(webview, 'nova:contacts:delete', requestId, 'PERMISSION_DENIED', 'contacts:delete permission required');
    }
    const id = payload && payload.id;
    if (typeof id !== 'string' || !id) {
      return respondError(webview, 'nova:contacts:delete', requestId, 'INVALID_ID', 'id must be a non-empty string');
    }
    const contacts = loadContacts();
    const next = contacts.filter(c => c.id !== id);
    const removed = next.length !== contacts.length;
    saveContacts(next);
    return respond(webview, 'nova:contacts:delete', requestId, { success: true, removed });
  }

  // System info

  async function handleSystemInfo({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:info', app.id)) {
      return respondError(webview, 'nova:system:info', requestId, 'PERMISSION_DENIED', 'system:info permission required');
    }
    const bootTime = OS?._bootTime || Date.now();
    return respond(webview, 'nova:system:info', requestId, {
      success: true,
      os: {
        version: OS?.version,
        securityPatch: OS?.securityPatch,
        username: OS?.username,
        uptime: Date.now() - bootTime,
      },
    });
  }

  const PUBLIC_APPEARANCE_SETTING_KEYS = new Set(['theme', 'accentColor', 'highContrast', 'reduceMotion', 'removeTransparency']);
  const PUBLIC_APPEARANCE_FIELDS = new Set(['theme', 'accentColor', 'highContrast', 'reduceMotion', 'transparentSurfaces']);
  const PUBLIC_THEMES = new Set(['nova-dark', 'nova-light', 'nord', 'dracula', 'catppuccin', 'tokyo-night', 'gruvbox']);
  const appearanceSetRateLimits = new Map();

  function getPublicAppearance() {
    const settings = OS?.settings;
    return {
      theme: settings?.get?.('theme') || 'nova-dark',
      accentColor: settings?.get?.('accentColor') || null,
      highContrast: settings?.get?.('highContrast') === true,
      reduceMotion: settings?.get?.('reduceMotion') === true,
      transparentSurfaces: settings?.get?.('removeTransparency') !== true,
    };
  }

  async function handleAppearanceGet({ requestId, webview }) {
    if (!OS?.settings?.get) {
      return respondError(webview, 'nova:appearance:get', requestId, 'UNAVAILABLE', 'Appearance settings are not available');
    }
    return respond(webview, 'nova:appearance:get', requestId, getPublicAppearance());
  }

  async function handleAppearanceSet({ payload, requestId, app, webview }) {
    if (typeof OS?.settings?.set !== 'function') {
      return respondError(webview, 'nova:appearance:set', requestId, 'UNAVAILABLE', 'Appearance settings are not available');
    }
    const patch = payload?.appearance;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return respondError(webview, 'nova:appearance:set', requestId, 'INVALID_ARGS', 'appearance must be an object of supported appearance preferences');
    }
    const entries = Object.entries(patch);
    if (!entries.length || entries.some(([key]) => !PUBLIC_APPEARANCE_FIELDS.has(key))) {
      return respondError(webview, 'nova:appearance:set', requestId, 'INVALID_ARGS', 'Only theme, accentColor, highContrast, reduceMotion, and transparentSurfaces can be changed');
    }
    const now = Date.now();
    const recentUpdates = (appearanceSetRateLimits.get(app.id) || []).filter(time => time > now - 60_000);
    if (recentUpdates.length >= 10) {
      appearanceSetRateLimits.set(app.id, recentUpdates);
      return respondError(webview, 'nova:appearance:set', requestId, 'RATE_LIMITED', 'Max 10 appearance updates per minute');
    }
    for (const [key, value] of entries) {
      const valid = key === 'theme'
        ? PUBLIC_THEMES.has(value)
        : key === 'accentColor'
          ? value === null || (typeof value === 'string' && /^#[\da-f]{6}$/i.test(value))
          : typeof value === 'boolean';
      if (!valid) {
        return respondError(webview, 'nova:appearance:set', requestId, 'INVALID_ARGS', `Invalid value for appearance setting '${key}'`);
      }
    }
    for (const [key, value] of entries) {
      const settingKey = key === 'transparentSurfaces' ? 'removeTransparency' : key;
      const settingValue = key === 'transparentSurfaces' ? !value : value;
      if (OS.settings.set(settingKey, settingValue) === false) {
        return respondError(webview, 'nova:appearance:set', requestId, 'POLICY_BLOCKED', `Appearance setting '${key}' is blocked by system policy`);
      }
    }
    recentUpdates.push(now);
    appearanceSetRateLimits.set(app.id, recentUpdates);
    return respond(webview, 'nova:appearance:set', requestId, { success: true, appearance: getPublicAppearance() });
  }

  async function handleAppearanceSubscribe({ requestId, webview, sandbox }) {
    if (!OS?.events?.on || !sandbox) {
      return respondError(webview, 'nova:appearance:subscribe', requestId, 'UNAVAILABLE', 'Appearance change events are not available');
    }
    if (sandbox.appearanceSubscription) {
      return respondError(webview, 'nova:appearance:subscribe', requestId, 'ALREADY_SUBSCRIBED', 'Already subscribed to appearance changes');
    }
    const handler = change => {
      if (!PUBLIC_APPEARANCE_SETTING_KEYS.has(change?.key)) return;
      respond(webview, 'nova:appearance:changed:event', generateRequestId(), getPublicAppearance());
    };
    OS.events.on('settings:changed', handler);
    sandbox.appearanceSubscription = () => OS.events.off?.('settings:changed', handler);
    return respond(webview, 'nova:appearance:subscribe', requestId, { success: true, appearance: getPublicAppearance() });
  }

  async function handleAppearanceUnsubscribe({ requestId, webview, sandbox }) {
    sandbox?.appearanceSubscription?.();
    if (sandbox) sandbox.appearanceSubscription = null;
    return respond(webview, 'nova:appearance:unsubscribe', requestId, { success: true });
  }

  // Ready handshake

  async function handleReady({ requestId, app, webview }) {
    if (!app) {
      return respondError(webview, 'nova:ready', requestId, 'UNAVAILABLE', 'No app context for ready handshake');
    }
    const mgr = typeof AppPermissionManager !== 'undefined' ? AppPermissionManager : null;
    const appPerms = app.permissions || [];
    const appOptional = app.optionalPermissions || [];
    const granted = mgr ? appPerms.filter(p => mgr.isGranted(p, app.id)) : appPerms;
    const optionalGranted = mgr ? appOptional.filter(p => mgr.isGranted(p, app.id)) : appOptional;
    const payload = {
      success: true,
      appId: app.id,
      permissions: granted,
      optionalPermissions: optionalGranted,
      osVersion: OS?.version,
      securityPatch: OS?.securityPatch,
      // System-bundled apps legitimately need the same OS identity that the
      // host UI uses (for example Terminal's `whoami`, prompt, and `$USER`).
      // A webview is a separate JS realm, so it cannot read the host `OS`
      // object directly. Expose the username through the authenticated ready
      // handshake instead of leaving the guest-side compatibility facade at
      // its fallback value of `user`. Non-system apps do not receive it.
      username: app.system === true ? OS?.username : undefined,
    };
    // Some apps (see the capability shim / createDefaultAppShell) read the
    // handshake fields directly off the top-level response object rather
    // than through the generic `result` wrapper. The guest-side shim's
    // inbox poller merges `result` fields onto the top level of what it
    // hands back to app code, so a single respond() call covers both
    // shapes — no separate legacy send needed.
    respond(webview, 'nova:ready', requestId, payload);
  }

  // File dialogs

  async function handleDialogOpen({ payload, requestId, app, webview }) {
    if (!hasVfsRead(app.id)) {
      return respondError(webview, 'nova:dialog:open', requestId, 'PERMISSION_DENIED', 'vfs:read or vfs:access permission required');
    }
    showFileDialog('open', webview, 'nova:dialog:open', requestId, app, payload);
    // Response is sent from the dialog's confirm/cancel handler.
  }

  async function handleDialogSave({ payload, requestId, app, webview }) {
    if (!hasVfsWrite(app.id)) {
      return respondError(webview, 'nova:dialog:save', requestId, 'PERMISSION_DENIED', 'vfs:write or vfs:access permission required');
    }
    showFileDialog('save', webview, 'nova:dialog:save', requestId, app, payload);
  }

  // New, additional dialog pair: delegates to SystemDialogs — the same
  // shared, Files-app-styled VFS browser that first-party apps (TextEdit,
  // etc.) use. Kept entirely separate from handleDialogOpen/handleDialogSave
  // above (the native-styled dialog), so existing .novaapp callers of
  // nova:dialog:open/save are completely unaffected. Still gated behind the
  // same VFS read/write capabilities as the native pair — this is a new
  // *visual style* of the same capability, not a new capability.
  async function handleSysDialogOpen({ payload, requestId, app, webview }) {
    if (!hasVfsRead(app.id)) {
      return respondError(webview, 'nova:sysdialog:open', requestId, 'PERMISSION_DENIED', 'vfs:read or vfs:access permission required');
    }
    if (typeof window.SystemDialogs === 'undefined') {
      return respondError(webview, 'nova:sysdialog:open', requestId, 'UNAVAILABLE', 'SystemDialogs not loaded');
    }
    try {
      const node = await window.SystemDialogs.open({
        title: payload?.title,
        startFolderId: payload?.startFolderId || FS.rootId,
        canAccess: node => canPickerAccess(node, app.id),
      });
      if (!node) return respond(webview, 'nova:sysdialog:open', requestId, { cancelled: true });
      if (!resolveFile({ id: node.id }, app.id)) {
        return respondError(webview, 'nova:sysdialog:open', requestId, 'PERMISSION_DENIED', 'Selected file is outside this app\'s accessible VFS');
      }
      respond(webview, 'nova:sysdialog:open', requestId, {
        success: true,
        file: {
          id: node.id,
          name: node.name,
          content: node.content || '',
          mimeType: node.mimeType || 'text/plain',
          size: node.size || 0,
          path: FS.getPath(node.id),
        },
      });
    } catch (e) {
      respondError(webview, 'nova:sysdialog:open', requestId, 'DIALOG_ERROR', e?.message || 'Dialog failed');
    }
  }

  async function handleSysDialogSave({ payload, requestId, app, webview }) {
    const broadAccess = hasVfsAccess(app.id);
    if (!hasVfsWrite(app.id)) {
      return respondError(webview, 'nova:sysdialog:save', requestId, 'PERMISSION_DENIED', 'vfs:write or vfs:access permission required');
    }
    if (typeof window.SystemDialogs === 'undefined') {
      return respondError(webview, 'nova:sysdialog:save', requestId, 'UNAVAILABLE', 'SystemDialogs not loaded');
    }
    try {
      const picked = await window.SystemDialogs.save({
        title: payload?.title,
        suggestedName: payload?.suggestedName || '',
        startFolderId: payload?.startFolderId || FS.rootId,
        canAccess: node => canPickerAccess(node, app.id, { writable: true, sharedWrite: broadAccess }),
      });
      if (!picked) return respond(webview, 'nova:sysdialog:save', requestId, { cancelled: true });
      if (!resolveFile({ id: picked.folderId }, app.id, true, broadAccess)) {
        return respondError(webview, 'nova:sysdialog:save', requestId, 'PERMISSION_DENIED', 'Selected folder is outside this app\'s writable VFS');
      }
      const content = payload?.content || '';
      const mimeType = payload?.mimeType || 'text/plain';
      const existing = FS.listDir(picked.folderId).find(node =>
        node.type === 'file' && node.name === picked.name
      );
      if (existing && !resolveFile({ id: existing.id }, app.id, true, broadAccess)) {
        return respondError(webview, 'nova:sysdialog:save', requestId, 'PERMISSION_DENIED', 'Selected file is outside this app\'s writable VFS');
      }
      const newNode = existing
        ? await FS.writeFile(existing.id, content)
        : await FS.createFile(picked.folderId, picked.name, content, mimeType);
      if (!newNode) throw new Error('Unable to write the selected file');
      respond(webview, 'nova:sysdialog:save', requestId, {
        success: true,
        file: { id: newNode.id, name: newNode.name, path: FS.getPath(newNode.id) },
      });
    } catch (e) {
      respondError(webview, 'nova:sysdialog:save', requestId, 'WRITE_ERROR', e?.message || 'Failed to write file');
    }
  }

  async function handleScopedFileOpen({ payload, requestId, app, webview }) {
    if (typeof window.SystemDialogs?.open !== 'function') {
      return respondError(webview, 'nova:files:open', requestId, 'UNAVAILABLE', 'File picker is not available');
    }
    const accept = payload?.accept;
    if (accept !== undefined && (!Array.isArray(accept) || accept.length > 20
      || accept.some(type => typeof type !== 'string' || !/^[\w.+*-]+\/[\w.+*-]+$/.test(type)))) {
      return respondError(webview, 'nova:files:open', requestId, 'INVALID_ARGS', 'accept must be an array of MIME types');
    }
    try {
      const node = await window.SystemDialogs.open({
        title: typeof payload?.title === 'string' ? payload.title.slice(0, 100) : 'Choose a file',
        startFolderId: payload?.startFolderId || FS.rootId,
        canAccess: node => canPickerAccess(node, app.id),
        filter: node => node.type === 'folder' || (node.type === 'file'
          && (!accept?.length || accept.includes(node.mimeType)
            || accept.some(type => type.endsWith('/*') && node.mimeType?.startsWith(type.slice(0, -1))))),
      });
      if (!node) return respond(webview, 'nova:files:open', requestId, { cancelled: true });
      if (!resolveFile({ id: node.id }, app.id)) {
        return respondError(webview, 'nova:files:open', requestId, 'PERMISSION_DENIED', 'Selected file is outside this app\'s accessible VFS');
      }
      const content = node.content;
      if (typeof content !== 'string') {
        return respondError(webview, 'nova:files:open', requestId, 'UNSUPPORTED_TYPE', 'Selected file is not available as text');
      }
      const size = new TextEncoder().encode(content).byteLength;
      if (size > 10_000_000) {
        return respondError(webview, 'nova:files:open', requestId, 'FILE_TOO_LARGE', 'Selected files are limited to 10 MB');
      }
      return respond(webview, 'nova:files:open', requestId, {
        cancelled: false,
        file: {
          name: node.name,
          path: FS.getPath(node.id),
          mimeType: node.mimeType || 'text/plain',
          size,
          content,
        },
      });
    } catch (error) {
      return respondError(webview, 'nova:files:open', requestId, 'PICKER_ERROR', error?.message || 'Could not open the selected file');
    }
  }

  async function handleScopedFileSave({ payload, requestId, app, webview }) {
    if (typeof window.SystemDialogs?.save !== 'function' || typeof FS?.createFile !== 'function') {
      return respondError(webview, 'nova:files:save', requestId, 'UNAVAILABLE', 'File picker is not available');
    }
    if (typeof payload?.content !== 'string') {
      return respondError(webview, 'nova:files:save', requestId, 'INVALID_ARGS', 'content must be a string up to 10 MB');
    }
    const size = new TextEncoder().encode(payload.content).byteLength;
    if (size > 10_000_000) {
      return respondError(webview, 'nova:files:save', requestId, 'INVALID_ARGS', 'content must be a string up to 10 MB');
    }
    const suggestedName = typeof payload.filename === 'string' ? payload.filename.slice(0, 255) : '';
    const mimeType = typeof payload.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(payload.mimeType)
      ? payload.mimeType
      : 'text/plain';
    try {
      const picked = await window.SystemDialogs.save({
        title: typeof payload.title === 'string' ? payload.title.slice(0, 100) : 'Save file',
        suggestedName,
        startFolderId: payload.startFolderId || FS.rootId,
        canAccess: node => canPickerAccess(node, app.id, { writable: true, sharedWrite: true }),
      });
      if (!picked) return respond(webview, 'nova:files:save', requestId, { cancelled: true });
      if (!canPickerAccess(FS.files.get(picked.folderId), app.id, {
        writable: true, sharedWrite: true, allowContainerNavigation: false,
      })) {
        return respondError(webview, 'nova:files:save', requestId, 'PERMISSION_DENIED', 'Selected folder is outside the accessible VFS');
      }
      const existing = FS.listDir(picked.folderId).find(node =>
        node.type === 'file' && node.name === picked.name
      );
      if (existing && !canPickerAccess(existing, app.id, { writable: true, sharedWrite: true })) {
        return respondError(webview, 'nova:files:save', requestId, 'PERMISSION_DENIED', 'Selected file is outside the accessible VFS');
      }
      const saved = existing
        ? await FS.writeFile(existing.id, payload.content)
        : await FS.createFile(picked.folderId, picked.name, payload.content, mimeType);
      if (!saved) throw new Error('Could not save the selected file');
      return respond(webview, 'nova:files:save', requestId, {
        cancelled: false,
        file: { name: saved.name, path: FS.getPath(saved.id), mimeType: saved.mimeType || mimeType, size },
      });
    } catch (error) {
      return respondError(webview, 'nova:files:save', requestId, 'PICKER_ERROR', error?.message || 'Could not save the selected file');
    }
  }

  // Audit: eval
  //
  // Sent by the capability shim whenever an app calls eval(). Historically
  // this only logged, since the CSP allowed 'unsafe-eval' by design — but
  // 'unsafe-eval' has since been removed from RELAXED_CSP_META (see that
  // constant below), so the browser now blocks eval()/new Function() before
  // this handler would ever fire from a real call. This audit path is kept
  // for observability/back-compat only; it does not mean eval is permitted.
  // The shim uses fire-and-forget for this so it doesn't wait on a response,
  // but we send one anyway so any caller using the regular ipc() path
  // (rather than ipcFireAndForget) gets an ack instead of timing out after
  // 30 seconds.

  async function handleAuditEval({ app, payload, requestId, webview }) {
    const appName = app?.name || app?.id || 'unknown';
    const appId = app?.id || 'unknown';
    log('warn', `${appName} called eval():`, payload?.preview);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({
        app: 'AppSandbox',
        category: 'security',
        severity: 'warn',
        message: `${appName} called eval()`,
        data: { appId, preview: payload?.preview },
      });
    }
    return respond(webview, 'nova:audit:eval', requestId, { success: true });
  }

  // Handler table
  //
  // Maps API type strings to their handler functions. Using a table instead
  // of a long if/else chain makes the dispatch O(1) and lets new APIs be
  // added by appending a single entry.

  const API_HANDLERS = {
    'nova:nested-webview': handleNestedWebview,
    'nova:files:open': handleScopedFileOpen,
    'nova:files:save': handleScopedFileSave,
    'nova:share': handleShare,
    'nova:appearance:get': handleAppearanceGet,
    'nova:appearance:set': handleAppearanceSet,
    'nova:appearance:subscribe': handleAppearanceSubscribe,
    'nova:appearance:unsubscribe': handleAppearanceUnsubscribe,
    'nova:vfs:read': handleFsRead,
    'nova:vfs:write': handleFsWrite,
    'nova:vfs:delete': handleFsDelete,
    'nova:vfs:list': handleFsList,
    'nova:vfs:mkdir': handleFsMkdir,
    'nova:vfs:stat': handleFsStat,
    'nova:vfs:rename': handleFsRename,
    'nova:vfs:move': handleFsMove,
    'nova:notifications:show': handleNotificationsShow,
    'nova:notifications:clear': handleNotificationsClear,
    'nova:settings:get': handleSettingsGet,
    'nova:settings:set': handleSettingsSet,
    'nova:wallpaper:set': handleWallpaperSet,
    'nova:request-permission': handleRequestPermission,
    'nova:permission-rate-limited': handlePermissionRateLimited,
    'nova:window:close': handleWindowClose,
    'nova:window:minimize': handleWindowMinimize,
    'nova:window:maximize': handleWindowMaximize,
    'nova:window:setTitle': handleWindowSetTitle,
    'nova:window:resize': handleWindowResize,
    'nova:window:getState': handleWindowGetState,
    'nova:clipboard:read': handleClipboardRead,
    'nova:clipboard:write': handleClipboardWrite,
    'nova:app:launch': handleAppLaunch,
    'nova:email:open-link': handleEmailOpenLink,
    'nova:open-url': handleOpenUrl,
    'nova:open-with': handleOpenWith,
    'nova:app:openDefaultAppsSettings': handleOpenDefaultAppsSettings,
    'nova:home:openDefaultAppsSettings': handleHomeOpenDefaultAppsSettings,
    'nova:home:apps:list': handleHomeAppsList,
    'nova:home:apps:launch': handleHomeAppsLaunch,
    'nova:app:info': handleAppInfo,
    'nova:app:list': handleAppList,
    'nova:app:install': handleAppInstall,
    'nova:app:uninstall': handleAppUninstall,
    'nova:admin:audit': handleAdminAudit,
    'nova:admin:system': handleAdminSystem,
    'nova:admin:users': handleAdminUsers,
    'nova:admin:apps': handleAdminApps,
    'nova:mail:read': handleMailRead,
    'nova:mail:write': handleMailWrite,
    'nova:mail:session': handleMailSession,
    'nova:mail:send': handleMailSend,
    'nova:mail:delete': handleMailDelete,
    'nova:events:subscribe': handleEventsSubscribe,
    'nova:events:unsubscribe': handleEventsUnsubscribe,
    'nova:background:wake-done': handleBackgroundWakeDone,
    'nova:background:stay-alive': handleBackgroundStayAlive,
    'nova:net:fetch': handleNetFetch,
    'nova:net:websocket': handleNetWebsocket,
    'nova:net:ws:send': handleNetWsSend,
    'nova:net:ws:close': handleNetWsClose,
    'nova:storage:get': handleStorageGet,
    'nova:storage:set': handleStorageSet,
    'nova:storage:delete': handleStorageDelete,
    'nova:storage:clear': handleStorageClear,
    'nova:storage:keys': handleStorageKeys,
    'nova:device:geolocation': handleDeviceGeolocation,
    'nova:device:camera': handleDeviceCamera,
    'nova:device:microphone': handleDeviceMicrophone,
    'nova:calendar:read': handleCalendarRead,
    'nova:calendar:write': handleCalendarWrite,
    'nova:calendar:delete': handleCalendarDelete,
    'nova:contacts:read': handleContactsRead,
    'nova:contacts:write': handleContactsWrite,
    'nova:contacts:delete': handleContactsDelete,
    'nova:system:info': handleSystemInfo,
    'nova:clock:state:get': handleClockStateGet,
    'nova:clock:state:persist': handleClockStatePersist,
    'nova:clock:alarms:get': handleClockAlarmsGet,
    'nova:clock:alarms:set': handleClockAlarmsSet,
    'nova:clock:alarm:dialog': handleClockAlarmDialog,
    'nova:clock:timer:set-preset': handleClockTimerSetPreset,
    'nova:clock:timer:start': handleClockTimerStart,
    'nova:clock:timer:pause': handleClockTimerPause,
    'nova:clock:timer:restart': handleClockTimerRestart,
    'nova:clock:timer:reset': handleClockTimerReset,
    'nova:clock:stopwatch:start': handleClockStopwatchStart,
    'nova:clock:stopwatch:pause': handleClockStopwatchPause,
    'nova:clock:stopwatch:reset': handleClockStopwatchReset,
    'nova:clock:stopwatch:lap': handleClockStopwatchLap,
    // Settings-only channels. The Settings app reaches these features
    // directly through OS.system.* rather than via IPC, so these entries
    // are never dispatched on a live code path — they're kept here as the
    // canonical implementation for any future IPC surface to reuse.
    'nova:system:permissions:list': handleSystemPermissionsList,
    'nova:system:permissions:set': handleSystemPermissionsSet,
    'nova:system:permissions:reset': handleSystemPermissionsReset,
    'nova:system:data:backup': handleSystemDataBackup,
    'nova:system:data:restore': handleSystemDataRestore,
    'nova:system:dialog': handleSystemDialog,
    'nova:system:developer-mode:confirm': handleSystemDeveloperModeConfirm,
    'nova:system:boot-recovery': handleSystemBootRecovery,
    'nova:system:data:clear': handleSystemDataClear,
    'nova:system:default-apps:get': handleSystemDefaultAppsGet,
    'nova:system:default-apps:choose': handleSystemDefaultAppsChoose,
    'nova:system:default-apps:set': handleSystemDefaultAppsSet,
    'nova:system:launch-snake': handleSystemLaunchSnake,
    'nova:system:storage:estimate': handleSystemStorageEstimate,
    'nova:system:admin-mode:get': handleSystemAdminModeGet,
    'nova:system:admin-mode:set': handleSystemAdminModeSet,
    'nova:system:preferences:get': handleSystemPreferencesGet,
    'nova:system:preferences:set': handleSystemPreferencesSet,
    'nova:ready': handleReady,
    'nova:dialog:open': handleDialogOpen,
    'nova:dialog:save': handleDialogSave,
    'nova:sysdialog:open': handleSysDialogOpen,
    'nova:sysdialog:save': handleSysDialogSave,
    'nova:audit:eval': handleAuditEval,
    'nova:download': handleDownload,
  };

  // Dispatch an incoming IPC message to its handler. Catches sync throws and
  // async rejections so a single misbehaving handler can't take down the
  // bridge. Unknown types get an UNKNOWN_API error response.
  async function handleAPICall(type, payload, requestId, app, webview, sandbox) {
    try {
      const handler = API_HANDLERS[type];
      if (!handler) {
        return respondError(webview, type, requestId, 'UNKNOWN_API', `Unknown API: ${type}`);
      }
      await handler({ payload, requestId, app, webview, sandbox });
    } catch (err) {
      // Error.isError (ES2026) is the cross-realm-safe check; fall back to
      // instanceof for older runtimes. Either way, extract a real message
      // string for both the log and the guest-side error response.
      const isError = typeof Error.isError === 'function' ? Error.isError(err) : err instanceof Error;
      const msg = isError ? err.message : String(err);
      log('error', `Error handling ${type}:`, err);
      // Guard against a webview that's been destroyed between the call
      // arriving and an async handler throwing — respond would log a
      // spurious error on top of the real one.
      if (webview && typeof webview.executeScript === 'function') {
        respondError(webview, type, requestId, 'INTERNAL_ERROR', msg || 'Internal error');
      }
    }
  }

  // API bridge setup

  // Marker prefix for guest->host IPC messages sent over console.log. Kept
  // deliberately weird/specific so an ordinary page's own console output
  // (or a malicious app trying to guess it) can't accidentally collide.
  // This is the same mechanism NB Browser already uses for its right-click
  // context menu (see browser.js's _CTX_MARKER + 'consolemessage' listener)
  // — a real, confirmed-working <webview> DOM event for guest->host data on
  // this exact NW.js build, unlike window.parent.postMessage which never
  // reaches the host at all (window.parent === window for a <webview>
  // guest; there is no cross-process parent reference to send to).
  const IPC_MARKER = '__NOVA_IPC__:';

  // Wire up the API bridge for a sandbox.
  //
  // Guest -> host: the guest's shim calls console.log(IPC_MARKER + JSON)
  // instead of window.parent.postMessage. The host listens on the
  // webview's own 'consolemessage' DOM event (fired for every console.*
  // call inside that specific guest — this is scoped per-webview-element,
  // not a global listener, so there's no cross-app source-pinning problem
  // to solve at all: only messages from *this* webview ever reach this
  // handler).
  //
  // Host -> guest: unchanged in shape, still via webview.executeScript
  // (see respond()), since that direction already works.
  //
  // Every message off the wire is treated as untrusted input from
  // app-controlled content and validated before it's allowed to reach
  // handleAPICall:
  //   - must parse as JSON matching the exact expected shape
  //   - `type` must be an exact, known key in API_HANDLERS (an allowlist,
  //     not just "starts with the right prefix" — a made-up type is
  //     rejected outright rather than silently reaching a handler)
  //   - `requestId` must be a non-empty string
  //   - payload validation is then left to each individual handler
  //
  // setupAPIBridge returns an array of teardown steps that createSandbox
  // collects alongside the other setup functions. destroy() runs them all.
  function setupAPIBridge(webview, app, sandboxId) {
    const teardown = [];

    const consoleHandler = (event) => {
      const msg = event?.message;
      if (typeof msg !== 'string' || !msg.startsWith(IPC_MARKER)) return;

      let data;
      try {
        data = JSON.parse(msg.slice(IPC_MARKER.length));
      } catch {
        return; // malformed payload — drop silently, nothing to act on
      }
      if (!data || typeof data !== 'object') return;

      // Note: only {type, requestId} travel over the visible console
      // channel now. The actual payload (which may contain secrets — API
      // keys, auth headers, file bytes) never does; it's pulled back out
      // of the guest's in-memory stash via executeScript below, a
      // host-initiated read that doesn't land in the visible log stream
      // the way console.log broadcasts do.
      const { type, requestId } = data;
      if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(API_HANDLERS, type)) {
        log('warn', `Rejected IPC message with unknown/disallowed type from ${app?.id || 'unknown app'}: ${String(type)}`);
        return;
      }
      if (typeof requestId !== 'string' || !requestId) return;

      // Deliberately NOT { mainWorld: true } — window.__novaOutboxPull now
      // lives inside the isolated-world transport script (see
      // buildIsolatedTransportScript), which is also the only realm that
      // could have produced this console.log message in the first place
      // (the guest's own main-world code never touches console.log or
      // __novaOutboxPull directly anymore). executeScript's default
      // (isolated world) is what reaches it.
      const idLiteral = JSON.stringify(requestId);
      // Bail out early if the sandbox has already been destroyed between
      // the consolemessage firing and this host-initiated read landing.
      // Without this guard, handleAPICall would run against a stale
      // webview reference and produce confusing log noise rather than
      // silently dropping the orphaned call.
      if (!activeSandboxes.has(sandboxId)) return;
      webview.executeScript({
        code: `(function(){ var m = window.__novaOutboxPull || {}; var p = m[${idLiteral}]; delete m[${idLiteral}]; return JSON.stringify(p === undefined ? null : p); })()`,
      }, (results) => {
        // Second guard: the executeScript callback is async and may fire
        // after destroy() has torn this sandbox down.
        if (!activeSandboxes.has(sandboxId)) return;
        let payload = null;
        try {
          const raw = Array.isArray(results) ? results[0] : results;
          payload = raw ? JSON.parse(raw) : null;
        } catch (e) {
          log('warn', `Failed to retrieve IPC payload for ${type} from ${app?.id || 'unknown app'}: ${e?.message || e}`);
          return;
        }
        const sandbox = activeSandboxes.get(sandboxId);
        handleAPICall(type, payload, requestId, app, webview, sandbox);
      });
    };

    webview.addEventListener('consolemessage', consoleHandler);
    teardown.push(() => webview.removeEventListener('consolemessage', consoleHandler));

    return () => {
      // Detach OS event subscriptions.
      const subs = eventSubscriptions.get(sandboxId);
      if (subs) {
        for (const [eventName, handler] of subs) {
          try { OS?.events?.off(eventName, handler); } catch { /* best-effort */ }
        }
        subs.clear();
      }
      eventSubscriptions.delete(sandboxId);

      // Close any lingering WebSockets so they don't outlive the sandbox.
      const sandbox = activeSandboxes.get(sandboxId);
      if (sandbox?.wsConnections) {
        for (const [, wsState] of sandbox.wsConnections) {
          try { wsState.ws.close(1000, 'sandbox closed'); } catch { /* already closed */ }
        }
        sandbox.wsConnections.clear();
      }

      // Close any open file dialog so the overlay doesn't linger in the DOM,
      // and restore any other apps' webviews it had hidden to render above
      // them (see showFileDialog's restoreWebviews).
      const dialog = openDialogs.get(sandboxId);
      if (dialog) {
        dialog.overlay.remove();
        dialog.restore?.();
        openDialogs.delete(sandboxId);
      }
      for (const cancelShare of shareDialogs.get(sandboxId) || []) cancelShare();
      shareDialogs.delete(sandboxId);

      // Run the collected teardown steps (listeners removed above).
      for (const fn of teardown) {
        try { fn(); } catch (e) { log('debug', 'teardown step threw', e); }
      }
    };
  }

  // Error handling

  function setupErrorHandling(webview, app) {
    const teardown = [];

    // loadabort fires when webview navigation is cancelled (network error,
    // blocked URL, etc.). Surface it so we can see why apps fail to load.
    const loadAbortHandler = (event) => {
      log('error', `Load aborted in ${app.name}:`, event.reason);
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'AppSandbox', category: 'apps', severity: 'error', message: `Load aborted in ${app.name}: ${event.reason}`, data: { appId: app.id } });
      }
    };
    webview.addEventListener('loadabort', loadAbortHandler);
    teardown.push(() => webview.removeEventListener('loadabort', loadAbortHandler));

    // consolemessage proxies console output from the webview's separate
    // renderer process. We can't attach to contentWindow directly due to
    // process isolation, so this is the only surface for runtime visibility.
    const consoleHandler = (event) => {
      // Chromium console levels: 0=verbose, 1=info, 2=warning, 3=error.
      if (event.level >= 2) {
        const level = event.level >= 3 ? 'error' : 'warn';
        log(level, `${app.name}:`, event.message,
          event.sourceId ? `(${event.sourceId}:${event.line})` : '');
      }
    };
    webview.addEventListener('consolemessage', consoleHandler);
    teardown.push(() => webview.removeEventListener('consolemessage', consoleHandler));

    return () => {
      for (const fn of teardown) {
        try { fn(); } catch (e) { log('debug', 'error-handling teardown step threw', e); }
      }
    };
  }

  // Permission request gate (webview-level device permissions)
  //
  // Gate webview-level permission requests (geolocation, media) against
  // AppPermissionManager. The sandboxed webview's permissionrequest event is
  // the only enforcement surface for these device features at the
  // renderer-process boundary. Unrecognised permissions are denied by
  // default — fail-closed is the safe choice.
  function setupPermissionRequestGate(webview, app) {
    // NW.js/Chromium can surface the same underlying permission request more
    // than once. Calling allow()/deny() twice on that request throws
    // `Permission has already been decided`. WeakSet keeps this one-shot
    // without retaining request objects after Chromium releases them.
    const decidedRequests = new WeakSet();

    const decide = (e, allowed) => {
      const request = e?.request;
      if (!request || (typeof request.allow !== 'function' && typeof request.deny !== 'function')) return;
      if (decidedRequests.has(request)) return;
      decidedRequests.add(request);
      try {
        if (allowed && typeof request.allow === 'function') request.allow();
        else if (!allowed && typeof request.deny === 'function') request.deny();
      } catch (err) {
        // Chromium may auto-resolve a request between the guard and the call.
        // That is harmless; don't turn it into an uncaught app error.
        log('debug', `Permission request for ${app?.id || 'unknown app'} was already decided`, err?.message || err);
      }
    };

    const handler = (e) => {
      if (!e?.request || decidedRequests.has(e.request)) return;
      if (e.permission === 'fullscreen' || e.permission === 'pointerLock') {
        // These capabilities are not granted automatically to sandboxed apps.
        decide(e, false);
        return;
      }
      if (e.permission === 'geolocation') {
        if (AppPermissionManager?.isGranted('device:geolocation', app.id)) {
          decide(e, true);
        } else {
          decide(e, false);
        }
        return;
      }
      if (e.permission === 'media') {
        // Chromium's MediaPermissionRequest carries no audio/video sub-type
        // (confirmed against the chrome.webviewTag reference — it's just
        // { url, allow, deny }), so this layer can't tell a camera-only
        // getUserMedia({video:true}) call apart from a mic-only or
        // combined one. Requiring BOTH device:camera AND device:microphone
        // would wrongly block an app that's only been granted (and only
        // asked for) one of the two. Allowing on EITHER being granted is
        // the correct trade-off here: the actual audio/video split is
        // still enforced by whatever constraints the guest's own
        // getUserMedia() call passes — this gate only decides whether the
        // app may use the media permission surface at all.
        const camOk = AppPermissionManager?.isGranted('device:camera', app.id);
        const micOk = AppPermissionManager?.isGranted('device:microphone', app.id);
        if (camOk || micOk) {
          decide(e, true);
        } else {
          decide(e, false);
        }
        return;
      }
      // Default-deny any permission we don't explicitly handle. The previous
      // implementation left these to the webview's default, which is
      // non-portable and can silently allow access.
      decide(e, false);
    };
    webview.addEventListener('permissionrequest', handler);
    return () => webview.removeEventListener('permissionrequest', handler);
  }

  // Capability shim
  //
  // Injected as the first <script> in every packaged app's HTML. Overrides
  // fetch / XHR / eval / sendBeacon so apps that use standard web APIs work
  // transparently — all network goes through the IPC bridge where
  // permissions are enforced. connect-src 'none' in the served CSP ensures
  // nothing bypasses this at the browser level.
  //
  // The shim also exposes window.nova for apps that want to call the IPC
  // bridge directly (e.g. to request permissions or subscribe to events).

  // Whether sandboxed guest content may instantiate its own nested
  // <webview>. Every sandboxed package must opt in in its manifest and hold
  // the separate sandbox:nested-webview grant. Fail closed on errors.
  function isNestedWebviewPermitted(app) {
    if (!app) return false;
    // Prefer the flattened launch field, but accept the original manifest
    // too. Some install/restore paths preserve the manifest and permissions
    // while omitting the flattened convenience field.
    const manifestOptIn = app.allowNestedWebview === true
      || app.manifest?.allowNestedWebview === true;
    if (!manifestOptIn) return false;
    try {
      return AppPermissionManager?.isGranted('sandbox:nested-webview', app.id) === true;
    } catch (_) {
      return false;
    }
  }

  function isExternalFramesPermitted(app) {
    return isNestedWebviewPermitted(app);
  }

  function canNestedWebviewNavigate(app, rawUrl) {
    const classified = resolveAndClassifyUrl(rawUrl);
    if (!classified.valid) return false;
    let url;
    try {
      url = new URL(classified.url);
    } catch {
      return false;
    }
    if (url.username || url.password) return false;
    const permission = classified.isInternal ? 'net:internal' : 'net:external';
    return typeof AppPermissionManager !== 'undefined'
      && AppPermissionManager?.isGranted(permission, app?.id) === true;
  }

  // Marker used ONLY on the one-shot handshake that hands a MessagePort
  // from the isolated transport script to the main-world capability shim.
  // Deliberately distinct from IPC_MARKER (the guest->host console.log
  // marker). Unlike the previous design, this marker does NOT authenticate
  // ongoing request/response traffic — see the handshake comment below for
  // why a tagged window.postMessage alone is forgeable by any main-world
  // script and can't be trusted for anything beyond the initial port handoff.
  const BRIDGE_MARKER = '__NOVA_BRIDGE__';

  // Cache for buildIsolatedTransportScript — the script is identical for
  // every sandbox, so build it once and reuse the string. Reset by tests
  // via _internal._resetState.
  let _isolatedTransportScriptCache = null;

  // Builds the isolated-world transport content script. This owns the
  // ONLY code path that can produce a valid guest->host IPC message
  // (console.log(IPC_MARKER + ...)) or read a host->guest response
  // (window.__novaInbox). It is injected via webview.addContentScripts()
  // at run_at: 'document_start', which — unlike a <script> spliced into
  // the guest's own HTML — runs in a separate JS realm (Chromium's
  // "isolated world", same mechanism as Chrome extension content
  // scripts) that the guest's own page script cannot reach, patch, or
  // race against. See JavaScript Contexts in NW.js docs: isolated and
  // main-world scripts share the DOM but not JS globals.
  //
  // Ongoing traffic with the main-world capability shim (buildCapabilityShim
  // below) goes over a dedicated MessageChannel, not tagged window.postMessage.
  // This is a deliberate correction: window.postMessage with a __novaBridge
  // tag authenticates "this arrived on this window" but NOT "this actually
  // came from the isolated script" — any main-world code (including an
  // attacker who achieved script execution in the guest's own page, e.g. via
  // an XSS bug in the app itself) can call
  // window.postMessage(sameShapeObject, ...) and a listener keyed only on the
  // tag has no way to tell the difference. Concretely, that let a compromised
  // guest forge a fake "response" for one of its OWN in-flight requestIds and
  // win the race against the real host response, corrupting whatever the
  // guest's own app code does with that result.
  //
  // A MessagePort is what authenticates a message now: holding a reference
  // to port2 is only possible for code that received it in the one-shot
  // handshake below, and the isolated script stops listening for further
  // handshake requests the instant one is claimed — so nothing that runs
  // afterward (including later-injected or dynamically-eval'd guest script)
  // can obtain a second reference to it. A message arriving on
  // `port1.onmessage` can only have been sent via `port2.postMessage`, so no
  // tag/marker is needed to trust port traffic — possession of the port is
  // the credential.
  //
  // This still closes what the window.postMessage version closed relative to
  // the original single-realm shim: (1) a guest page redefining console.log
  // before the shim's IIFE ran could previously blind or spoof the IPC
  // channel — that channel lives in a realm the guest's console.log override
  // never touches; (2) window.__novaInbox / window.__novaOutboxPull used to
  // be plain globals on the guest's own window — now they're closures inside
  // this isolated script, invisible to window.* lookups from the main world.
  // It additionally closes the response-forgery gap the tagged-postMessage
  // bridge itself introduced.
  function buildIsolatedTransportScript() {
    // Cached: the transport script is identical for every sandbox, so build
    // it once. The original code regenerated a multi-KB string template on
    // every launch — measurable on cold boot when several apps launch back
    // to back.
    if (_isolatedTransportScriptCache) return _isolatedTransportScriptCache;
    _isolatedTransportScriptCache = `(function() {
  'use strict';
  const IPC_MARKER = ${JSON.stringify(IPC_MARKER)};
  const BRIDGE_MARKER = ${JSON.stringify(BRIDGE_MARKER)};

  // The MessagePort this isolated script keeps for itself once the
  // handshake completes. port2 (the other end) is handed to the
  // main-world shim exactly once, below. Until the handshake fires,
  // outbound messages queue in pendingOutbound rather than being lost.
  let mainWorldPort = null;
  let pendingOutbound = [];

  function sendToMainWorld(msg) {
    if (mainWorldPort) {
      try { mainWorldPort.postMessage(msg); } catch (e) { /* torn-down guest window */ }
    } else {
      pendingOutbound.push(msg);
    }
  }

  // Host->guest responses land here, pushed to by respond() in
  // app-sandbox.js via executeScript targeting this isolated world
  // specifically (not mainWorld: true — see respond()'s comments).
  window.__novaInbox = window.__novaInbox || [];
  // Guest->host request payloads (may contain secrets) live here,
  // pulled by the host via a host-initiated executeScript read — never
  // broadcast, so never visible in the console stream. Same shape as
  // the pre-split design; only WHERE it lives has changed (isolated
  // world instead of the guest's own main-world window object).
  window.__novaOutboxPull = window.__novaOutboxPull || {};
  const pendingPayloads = window.__novaOutboxPull;

  function generateId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'xport_' + window.crypto.randomUUID();
    }
    return 'xport_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
  }

  // Relay a request from the main-world shim out to the host. Only the
  // {type, requestId} pair ever appears in the visible console stream —
  // matches the guarantee the original single-realm shim made.
  function sendToHost(type, payload, requestId) {
    try {
      pendingPayloads[requestId] = payload;
      console.log(IPC_MARKER + JSON.stringify({ type: type, requestId: requestId }));
    } catch (e) {
      // Deliver a synthetic error back to the main world so its pending
      // promise doesn't hang forever if console.log itself throws.
      deliverToMainWorld({ kind: 'response', requestId: requestId,
        type: type + ':response', result: null, error: { code: 'TRANSPORT_ERROR', message: String((e && e.message) || e) } });
    }
  }

  // Forward a host response (or pushed event) to the main-world shim, over
  // the dedicated port rather than tagged window.postMessage — see the
  // module-level comment above buildIsolatedTransportScript for why.
  function deliverToMainWorld(msg) {
    sendToMainWorld(msg);
  }

  // Same idle-backoff poller design as the original shim, just relocated:
  // drains window.__novaInbox (host responses / pushed events) and
  // forwards each message to the main world over postMessage instead of
  // resolving a same-realm Promise map directly.
  const POLL_BASELINE_MS = 50;
  const POLL_IDLE_MS = 250;
  const POLL_IDLE_THRESHOLD = 20;
  let pollInterval = POLL_BASELINE_MS;
  let emptyPolls = 0;

  function drainInbox() {
    const inbox = window.__novaInbox;
    if (!inbox || !inbox.length) {
      emptyPolls++;
      if (emptyPolls > POLL_IDLE_THRESHOLD && pollInterval < POLL_IDLE_MS) pollInterval = POLL_IDLE_MS;
      return;
    }
    emptyPolls = 0;
    if (pollInterval !== POLL_BASELINE_MS) pollInterval = POLL_BASELINE_MS;

    const drained = inbox.splice(0, inbox.length);
    for (let i = 0; i < drained.length; i++) {
      const msg = drained[i];
      if (!msg || typeof msg.type !== 'string') continue;
      deliverToMainWorld(Object.assign({ kind: 'response' }, msg));
    }
  }

  function scheduleNextPoll() {
    setTimeout(function() { drainInbox(); scheduleNextPoll(); }, pollInterval);
  }
  scheduleNextPoll();

  // Requests arrive from the main-world shim over the dedicated port once
  // the handshake below completes.
  function handlePortMessage(event) {
    const data = event.data;
    if (!data || data.kind !== 'request') return;
    if (typeof data.type !== 'string' || typeof data.requestId !== 'string') return;
    sendToHost(data.type, data.payload, data.requestId);
  }

  // One-shot handshake: create a MessageChannel and hand port2 to the
  // main-world shim. This is the ONLY message this script ever sends via
  // window.postMessage — everything after this point goes over the port.
  //
  // handshakeClaimed makes the handoff strictly one-time: the instant a
  // valid claim request is processed, the listener stops accepting further
  // claims (even a same-tick duplicate call), so no later script — however
  // it got main-world execution — can obtain a second reference to port2.
  // A legitimate shim always wins this because buildCapabilityShim is
  // guaranteed to run as the very first script in the guest's document
  // (see injectCapabilityShim's unconditional prepend), before any guest
  // HTML/script has had a chance to execute at all; run_at: 'document_start'
  // on this content script additionally guarantees this listener exists
  // before that first script tag runs. So the race this is closing is not
  // "can a guest script beat the shim to the handshake" (it can't — the shim
  // runs first, full stop) but "can a guest script REPLAY or FORGE the claim
  // message after the fact" — handshakeClaimed defeats that by making the
  // claim single-use regardless of timing.
  let handshakeClaimed = false;
  window.addEventListener('message', function(event) {
    if (handshakeClaimed) return;
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__novaBridge !== BRIDGE_MARKER || data.kind !== 'claim-port') return;
    handshakeClaimed = true;

    const channel = new MessageChannel();
    mainWorldPort = channel.port1;
    mainWorldPort.onmessage = handlePortMessage;
    mainWorldPort.start();

    // Flush anything queued before the shim claimed its port (there
    // shouldn't be much — host pushes are rare this early — but this
    // avoids silently dropping a pushed event that raced the handshake).
    const queued = pendingOutbound;
    pendingOutbound = [];
    for (let i = 0; i < queued.length; i++) mainWorldPort.postMessage(queued[i]);

    // Transfer port2 to the shim. This is a structured-clone transfer, not
    // a copy — after this call, this script no longer holds any reference
    // to port2, and neither does anything else that isn't the recipient.
    event.source.postMessage({ __novaBridge: BRIDGE_MARKER, kind: 'claim-port-ack' }, event.origin, [channel.port2]);
  });
})();`;
    return _isolatedTransportScriptCache;
  }

  // Builds the capability shim string for a given app. `nestedWebviewAllowed`
  // is baked in as a literal at injection time (not re-checked async inside
  // the guest — permission grants are host-side and the guest has no safe
  // synchronous way to ask), so this must be regenerated per-app/per-load
  // rather than reused as a static constant.
  function buildCapabilityShim(nestedWebviewAllowed, initialUrl = null) {
  return `<script>
(function() {
  'use strict';
  const REQUEST_TIMEOUT_MS = 30000;
  // Baked in at injection time from the host-side permission check —
  // see isNestedWebviewPermitted() in app-sandbox.js. Never trust a guest
  // to self-report this.
  const __NOVA_NESTED_WEBVIEW_ALLOWED__ = ${nestedWebviewAllowed ? 'true' : 'false'};
  let __NOVA_PENDING_INITIAL_URL__ = ${JSON.stringify(initialUrl)};

  // A handful of channels block on a human making a decision in a native
  // OS dialog (choosing where to save, which file to open) rather than on
  // a normal async operation — 30s is fine for everything else, but too
  // short here: someone can take well over 30 seconds browsing folders
  // and typing a filename, and hitting the generic timeout mid-decision
  // produced a real bug (a stale "IPC request timed out" rejection while
  // the dialog was still legitimately open, unrelated to the user
  // actually cancelling). These get a much longer timeout instead of
  // none at all, so a truly stuck/never-resolving call still eventually
  // surfaces as an error rather than hanging the caller forever.
  const INTERACTIVE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
  const INTERACTIVE_CHANNELS = {
    'nova:download': true,
    'nova:share': true,
    'nova:files:open': true,
    'nova:files:save': true,
    'nova:dialog:open': true,
    'nova:dialog:save': true,
    'nova:sysdialog:open': true,
    'nova:sysdialog:save': true,
    'nova:open-with': true,
    'nova:clock:alarm:dialog': true,
  };
  const pendingRequests = new Map();
  // Must exactly match BRIDGE_MARKER in app-sandbox.js's
  // buildIsolatedTransportScript(). This shim never touches IPC_MARKER or
  // console.log directly anymore — that channel now lives entirely inside
  // the isolated-world transport script (injected separately via
  // addContentScripts). BRIDGE_MARKER is used ONLY to claim this shim's
  // MessagePort at startup (see the handshake below) — once claimed, all
  // request/response traffic goes over the port itself, which needs no tag
  // because possession of the port is what proves a message is legitimate.
  // A tagged window.postMessage is forgeable by any main-world script; a
  // port reference isn't, since nothing outside this handshake ever gets one.
  const BRIDGE_MARKER = '__NOVA_BRIDGE__';

  // Set once the one-shot handshake below completes. Requests made before
  // this resolves are queued and flushed the instant the port arrives —
  // in practice this window is essentially zero since this script is
  // guaranteed to run before any other guest code (see
  // injectCapabilityShim's unconditional prepend) and the isolated
  // transport script's claim listener is armed by run_at: 'document_start'
  // before that.
  let hostPort = null;
  let pendingPortMessages = [];
  function sendOverPort(msg) {
    if (hostPort) {
      hostPort.postMessage(msg);
    } else {
      pendingPortMessages.push(msg);
    }
  }
  window.addEventListener('message', function claimHandshake(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__novaBridge !== BRIDGE_MARKER || data.kind !== 'claim-port-ack') return;
    window.removeEventListener('message', claimHandshake);
    const port = event.ports && event.ports[0];
    if (!port) return;
    hostPort = port;
    hostPort.onmessage = function(portEvent) { handleInboxMessage(portEvent.data); };
    hostPort.start();
    const queued = pendingPortMessages;
    pendingPortMessages = [];
    for (let i = 0; i < queued.length; i++) hostPort.postMessage(queued[i]);
  });
  // Ask the isolated transport script for a port. Sent exactly once; the
  // isolated script's handshake listener is single-use on its end too, so
  // a duplicate/replayed claim from anywhere else is a no-op.
  window.postMessage({ __novaBridge: BRIDGE_MARKER, kind: 'claim-port' }, window.location.origin);

  function generateId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'shim_' + window.crypto.randomUUID();
    }
    return 'shim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
  }

  // Send a nova: IPC message and resolve on response. Rejects on timeout or
  // when the host returns an error.
  //
  // This posts the request to the isolated-world transport script rather
  // than touching console.log or window.__novaOutboxPull itself. Those now
  // live in a separate JS realm this main-world code cannot reach — which
  // is deliberate: it means nothing running in this document (including a
  // malicious app that has otherwise fully compromised this realm, e.g. by
  // patching Object.prototype or console.log) can forge, read, or tamper
  // with the actual privileged channel. The public contract of ipc() is
  // unchanged: same Promise, same resolve/reject shape, same timeouts —
  // only the transport underneath moved.
  //
  // Requests go out over hostPort (see the claim-port handshake above),
  // not window.postMessage — the port itself is what authenticates this
  // as a legitimate call; see the BRIDGE_MARKER comment above for why a
  // tagged window.postMessage wasn't sufficient on its own.
  function ipc(type, payload) {
    return new Promise(function(resolve, reject) {
      const id = generateId();
      const timeoutMs = INTERACTIVE_CHANNELS[type] ? INTERACTIVE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
      const timer = setTimeout(function() {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new TypeError('IPC request timed out: ' + type));
        }
      }, timeoutMs);
      pendingRequests.set(id, { resolve: resolve, reject: reject, timer: timer });
      try {
        sendOverPort({ kind: 'request', type: type, payload: payload, requestId: id });
      } catch (e) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(e);
      }
    });
  }

  // Responses (and pushed events) arrive via hostPort.onmessage — see the
  // claim-port handshake above. The isolated transport script drains
  // window.__novaInbox on its own poll loop and forwards each message over
  // the port. This shim no longer touches window.__novaInbox itself (it
  // lives in a different JS realm now), so there's nothing left to poll on
  // this side — just a listener, and one that trusts its input by
  // construction: only the isolated script ever held a reference to the
  // other end of this port, so nothing else could be the source.
  function handleInboxMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'nova:appearance:changed:event:response' && msg.result) {
      for (const callback of appearanceListeners.slice()) {
        try { callback(msg.result); } catch (error) { console.error('Appearance listener failed:', error); }
      }
      return;
    }

    if (msg.type === 'nova:nested-webview:event:response' && msg.result?.proxyId && msg.result?.eventName) {
      const proxy = window.__novaNestedWebviewProxies?.get(msg.result.proxyId);
      if (proxy) {
        const event = new Event(msg.result.eventName);
        for (const [key, value] of Object.entries(msg.result)) {
          if (key === 'proxyId' || key === 'eventName') continue;
          try { Object.defineProperty(event, key, { value: value, configurable: true }); } catch (_) {}
        }
        if (msg.result.eventName === 'newwindow' && msg.result.popupId) {
          const popupId = msg.result.popupId;
          const popup = {
            attach: nestedProxy => nestedProxy?.__attachPopup?.(popupId),
            discard: () => ipc('nova:nested-webview', { action: 'discard-popup', id: proxy.__nestedId, popupId })
          };
          try { Object.defineProperty(event, 'window', { value: popup, configurable: true }); } catch (_) {}
        }
        if (msg.result.eventName === 'permissionrequest') {
          const request = {
            url: msg.result.request?.url,
            allow: function() {},
            deny: function() {}
          };
          try { Object.defineProperty(event, 'request', { value: request, configurable: true }); } catch (_) {}
        }
        proxy.dispatchEvent(event);
      }
      return;
    }

    // Pushed events (unprompted, no requestId round-trip) — dispatched
    // to onEvent listeners registered for this event name.
    if (msg.type === 'nova:events:event:response' && msg.result && msg.result.event) {
      const listeners = eventListeners[msg.result.event] || [];
      for (let j = 0; j < listeners.length; j++) {
        try { listeners[j](msg.result.data); } catch (_) {}
      }
      return;
    }

    // Pushed WebSocket events (message/error/close) — also unprompted,
    // sent with a fresh requestId that was never registered in
    // pendingRequests, so without this branch they'd hit the
    // "!entry -> return" fallthrough below and silently vanish.
    // Dispatched to listeners registered per-wsId via window.nova.websocket().
    if ((msg.type === 'nova:net:ws:message:response' || msg.type === 'nova:net:ws:error:response' || msg.type === 'nova:net:ws:close:response')
        && msg.result && msg.result.wsId) {
      const wsListeners = wsEventListeners[msg.result.wsId];
      if (wsListeners) {
        const kind = msg.type === 'nova:net:ws:message:response' ? 'message'
          : msg.type === 'nova:net:ws:error:response' ? 'error' : 'close';
        const cbs = wsListeners[kind] || [];
        for (let k = 0; k < cbs.length; k++) {
          try { cbs[k](msg.result); } catch (_) {}
        }
        if (kind === 'close') delete wsEventListeners[msg.result.wsId];
      }
      return;
    }

    // Pushed background wake calls (system:background scheduled wake) —
    // also unprompted, same shape as the events branch above. Dispatched
    // to listeners registered via window.nova.onBackgroundWake(). The
    // host only ever sends this to a sandbox it started specifically for
    // a wake cycle (see AppScheduler.wake in app-sandbox.js) — there's no
    // separate permission check needed here on the guest side, since the
    // host already gated the wake itself on system:background before
    // this sandbox was even created.
    if (msg.type === 'nova:background:wake:response') {
      for (let w = 0; w < backgroundWakeListeners.length; w++) {
        try { backgroundWakeListeners[w](msg.result || {}); } catch (_) {}
      }
      return;
    }

    if (typeof msg.requestId !== 'string') return;
    const entry = pendingRequests.get(msg.requestId);
    if (!entry) return;
    pendingRequests.delete(msg.requestId);
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(Object.assign(new Error(msg.error.message || 'IPC error'), msg.error));
      return;
    }

    // Merge result fields onto the top level too, since some app code
    // (see createDefaultAppShell) reads handshake fields directly off
    // the response rather than through a result wrapper.
    const out = Object.assign({}, msg.result, { result: msg.result, type: msg.type });
    entry.resolve(out);

    // Ready-handshake fix: surface permissions on window for
    // late-loading scripts, and re-render the calendar once DOM is
    // ready, same as the old dedicated 'nova:ready:response' handler
    // used to do before nova:ready went through the normal ipc() path.
    if (msg.type === 'nova:ready:response' && msg.result) {
      try {
        window.__novaPermResponse = {
          permissions: msg.result.permissions || [],
          optionalPermissions: msg.result.optionalPermissions || [],
        };
      } catch (_) {}
      let renderFn = null;
      try { renderFn = (typeof renderCalendar === 'function') ? renderCalendar : null; } catch (_) {}
      if (renderFn) {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', function _rr() {
            document.removeEventListener('DOMContentLoaded', _rr);
            try { renderFn(); } catch (_) {}
          });
        } else {
          try { renderFn(); } catch (_) {}
        }
      }
    }
  }

  // Responses (and pushed events) arrive on hostPort.onmessage, wired up
  // in the claim-port-ack handshake above the moment the port is received —
  // no separate listener needed here. Replaces the old setInterval-based
  // drainInbox() poller (push-based now, via the isolated script's own
  // poll of window.__novaInbox forwarding over the port) and the tagged
  // window.postMessage listener this shim used before the MessageChannel
  // handoff (forgeable by any main-world script — see the BRIDGE_MARKER
  // comment above for why that mattered).

  // Download interceptor
  // <webview> tags can't hand a blob: URL to the host — blob URLs are
  // memory-backed and scoped to the browsing context that created them,
  // so window.parent has no way to dereference one even if it has the
  // string. What CAN cross the boundary is the blob's actual bytes.
  //
  // We override the native click() on <a download> elements pointing at
  // blob: URLs: read the blob back out with fetch() (same-context, so
  // this works), base64-encode it, and ship the bytes to the host over
  // the existing IPC bridge. The host does the real save-as. Apps using
  // the standard createObjectURL + <a download> + click() pattern need
  // no changes — this is transparent.
  const nativeAnchorClick = HTMLAnchorElement.prototype.click;
  // Captured here, before the network-permission override further down
  // replaces window.fetch with a version that routes everything through
  // nova:net:fetch. blob: URLs aren't network requests — routing them
  // through that bridge sends the literal string "blob:..." to the host
  // as if it were a fetchable resource, which always fails. This
  // interceptor needs the real, unpatched fetch to read blob bytes
  // in-context, so grab it now while it's still native.
  // Guarded: this shim's IIFE has no outer try/catch, and this line runs
  // unconditionally near the very top of the guest's first script — if
  // window.fetch isn't available yet at this exact point (confirmed
  // reproducible: a TypeError here throws with nothing to catch it,
  // which aborts the rest of this script, including the IPC bridge setup
  // that runs after it), the whole shim silently fails to initialize.
  // Falling back to a no-op means blob: downloads via <a download> won't
  // work until fetch exists, but everything else in the shim still loads.
  const nativeFetchForDownloads = (typeof window.fetch === 'function')
    ? window.fetch.bind(window)
    : function() { return Promise.reject(new TypeError('fetch unavailable at shim init time')); };
  HTMLAnchorElement.prototype.click = function() {
    const href = this.href || '';
    const filename = this.download;
    if (filename && href.indexOf('blob:') === 0) {
      nativeFetchForDownloads(href)
        .then(function(res) { return res.blob(); })
        .then(function(blob) {
          const reader = new FileReader();
          reader.onload = function() {
            // reader.result is a data URL: "data:<mime>;base64,<data>"
            const result = String(reader.result || '');
            const commaIdx = result.indexOf(',');
            const base64Data = commaIdx >= 0 ? result.slice(commaIdx + 1) : '';
            ipc('nova:download', {
              filename: filename,
              mimeType: blob.type || 'application/octet-stream',
              base64Data: base64Data
            }).catch(function(err) {
              console.error('Download interceptor: download failed', err);
            });
          };
          reader.onerror = function() {
            console.error('Download interceptor: failed to read blob for download');
          };
          reader.readAsDataURL(blob);
        })
        .catch(function(err) {
          console.error('Download interceptor: failed to fetch blob for download', err);
        });
      return; // suppress the native click — it would just navigate/no-op
    }
    return nativeAnchorClick.call(this);
  };

  // Registered onEvent callbacks, checked by the inbox poller whenever a
  // pushed 'nova:events:event' notification arrives (the host pushes
  // these unprompted, not in response to a specific ipc() call, so they
  // need their own dispatch rather than the requestId-keyed one above).
  const eventListeners = {}; // eventName -> [callback, ...]
  const appearanceListeners = [];
  let appearanceSubscriptionPromise = null;
  const launchListeners = [];

  // Callbacks registered via window.nova.onBackgroundWake(). Plain array,
  // not keyed by name — there's exactly one wake channel per sandbox
  // instance (this whole sandbox exists only for the duration of one wake
  // cycle; see AppScheduler.wake), unlike eventListeners above which fans
  // out across many different named OS events in a long-lived window.
  const backgroundWakeListeners = [];

  // wsId -> { message: [cb,...], error: [cb,...], close: [cb,...] }
  // Populated by window.nova.websocket(); read by the inbox poller above.
  const wsEventListeners = {};

  // Public API for apps that want to use the bridge directly.
  window.nova = {
    ipc: ipc,
    files: {
      open: function(options) { return ipc('nova:files:open', options || {}); },
      save: function(options) { return ipc('nova:files:save', options || {}); },
    },
    share: function(data) { return ipc('nova:share', data || {}); },
    appearance: {
      get: function() { return ipc('nova:appearance:get', {}); },
      set: function(appearance) { return ipc('nova:appearance:set', { appearance: appearance || {} }); },
      onChange: function(callback) {
        if (typeof callback !== 'function') return Promise.reject(new TypeError('callback must be a function'));
        if (appearanceListeners.includes(callback)) return Promise.reject(new TypeError('callback is already subscribed'));
        appearanceListeners.push(callback);
        if (!appearanceSubscriptionPromise) {
          appearanceSubscriptionPromise = ipc('nova:appearance:subscribe', {}).catch(error => {
            appearanceSubscriptionPromise = null;
            throw error;
          });
        }
        return appearanceSubscriptionPromise.then(function(result) {
          try { callback(result.appearance); }
          catch (error) { console.error('Appearance listener failed:', error); }
          return function() {
            const index = appearanceListeners.indexOf(callback);
            if (index >= 0) appearanceListeners.splice(index, 1);
            if (appearanceListeners.length === 0) {
              appearanceSubscriptionPromise = null;
              ipc('nova:appearance:unsubscribe', {}).catch(error => console.error(error));
            }
          };
        }, function(error) {
          const index = appearanceListeners.indexOf(callback);
          if (index >= 0) appearanceListeners.splice(index, 1);
          throw error;
        });
      },
    },
    app: {
      getInfo: function() { return ipc('nova:ready', {}); },
      launch: function(appId, options) {
        return ipc('nova:app:launch', { appId: appId, options: options || {} });
      },
      getLaunchOptions: function() {
        try { return Promise.resolve(JSON.parse(JSON.stringify(window.__NOVA_APP_OPTIONS__ || {}))); }
        catch (error) { return Promise.reject(error); }
      },
      onLaunch: function(callback) {
        if (typeof callback !== 'function') throw new TypeError('callback must be a function');
        launchListeners.push(callback);
        const options = window.__NOVA_APP_OPTIONS__ || {};
        queueMicrotask(() => {
          if (launchListeners.includes(callback)) {
            try { callback({ options: JSON.parse(JSON.stringify(options)), reason: 'launch' }); }
            catch (error) { console.error('App launch listener failed:', error); }
          }
        });
        return function() {
          const index = launchListeners.indexOf(callback);
          if (index >= 0) launchListeners.splice(index, 1);
        };
      },
      onStateChange: function(callback) {
        if (typeof callback !== 'function') throw new TypeError('callback must be a function');
        const sendState = () => {
          try {
            callback({
              visible: document.visibilityState === 'visible',
              focused: typeof document.hasFocus === 'function' && document.hasFocus(),
            });
          } catch (error) {
            console.error('App state listener failed:', error);
          }
        };
        const listener = () => sendState();
        document.addEventListener('visibilitychange', listener);
        window.addEventListener('focus', listener);
        window.addEventListener('blur', listener);
        sendState();
        return function() {
          document.removeEventListener('visibilitychange', listener);
          window.removeEventListener('focus', listener);
          window.removeEventListener('blur', listener);
        };
      },
    },
    home: {
      openDefaultAppsSettings: function() {
        return ipc('nova:home:openDefaultAppsSettings', {});
      },
      apps: {
        list: function() {
          return ipc('nova:home:apps:list', {});
        },
        launch: function(appId) {
          return ipc('nova:home:apps:launch', { appId: appId });
        },
      },
    },
    wallpaper: {
      set: function(key, value) {
        return ipc('nova:wallpaper:set', { key: key, value: value });
      }
    },
    requestPermission: function(permission, reason) {
      return ipc('nova:request-permission', { permission: permission, reason: reason });
    },
    openUrl: function(url) {
      return ipc('nova:open-url', { url: url });
    },
    openWith: function(fileId) {
      return ipc('nova:open-with', { fileId: fileId });
    },
    onEvent: function(eventName, callback) {
      if (!eventListeners[eventName]) eventListeners[eventName] = [];
      eventListeners[eventName].push(callback);
      return ipc('nova:events:subscribe', { event: eventName });
    },
    // system:background scheduled-wake support. The host only ever spins
    // up a sandbox for a wake cycle if the app holds system:background —
    // there's no separate permission call needed here, unlike most of the
    // rest of this API, since the wake happening at all IS the permission
    // check having already passed (see AppScheduler.wake). The callback
    // gets a bounded window (see wakeInfo.deadlineMs, matching the same
    // clock the host is timing the wake against) to do its work before the
    // host tears this sandbox down regardless — this is a brief scheduled
    // wake, not a way to stay alive; apps wanting to persist need
    // system:background:live instead, which is a different, bigger grant.
    onBackgroundWake: function(callback) {
      backgroundWakeListeners.push(callback);
    },
    // Lets a wake handler tell the host it finished early, so the host
    // doesn't have to sit through the full deadline before tearing the
    // sandbox down. Optional — if never called, the host just waits out
    // the deadline and tears down anyway.
    backgroundWakeDone: function() {
      return ipc('nova:background:wake-done', {});
    },
    // Opt this session into staying alive if the window closes (requires
    // system:background:live). Call with no args to enable, or
    // stayAliveInBackground(false) to change your mind before closing.
    // Session-only — call again next launch if you want it again.
    stayAliveInBackground: function(enabled) {
      return ipc('nova:background:stay-alive', { enabled: enabled !== false });
    },
    // Convenience wrapper around nova:net:websocket + ws:send/ws:close so
    // apps don't have to hand-roll requestId bookkeeping. Returns a promise
    // that resolves once the socket is open (mirrors host's onopen-only
    // response — see NOTE below) with a small handle object.
    //
    // NOTE: the host only ever resolves this ipc() call from the socket's
    // onopen handler. If the connection never opens (bad host, connection
    // refused, TLS failure before handshake), there is no host-side
    // reject path — the call will sit until the shim's own IPC timeout
    // fires and rejects with a generic "IPC request timed out" error
    // rather than a specific connection-failure reason. Callers should
    // treat that timeout as a real (if under-specific) connection failure,
    // not assume something is hung on the guest side.
    websocket: function(url, protocols) {
      return ipc('nova:net:websocket', { url: url, protocols: protocols }).then(function(res) {
        const wsId = res.wsId || (res.result && res.result.wsId);
        if (!wsId) throw new Error('nova:net:websocket resolved without a wsId');
        wsEventListeners[wsId] = { message: [], error: [], close: [] };
        return {
          wsId: wsId,
          readyState: res.readyState,
          onMessage: function(cb) { wsEventListeners[wsId].message.push(cb); },
          onError: function(cb) { wsEventListeners[wsId].error.push(cb); },
          onClose: function(cb) { wsEventListeners[wsId].close.push(cb); },
          send: function(data) { return ipc('nova:net:ws:send', { wsId: wsId, data: data }); },
          close: function(code, reason) { return ipc('nova:net:ws:close', { wsId: wsId, code: code, reason: reason }); },
        };
      });
    },
    // Camera/microphone can't be proxied through the IPC bridge like
    // geolocation coordinates — a MediaStream isn't serializable, and
    // nova:device:camera/microphone only check AppPermissionManager, they
    // don't (and can't) hand back a stream. So this wrapper does the
    // app-level check first, and only calls the real getUserMedia() here
    // in the guest's own document if that check passes. The browser-level
    // decision still happens separately, via this document's own
    // permissionrequest gate (see setupPermissionRequestGate's 'media'
    // branch in app-sandbox.js) when getUserMedia() itself is called.
    getUserMedia: function(constraints) {
      constraints = constraints || {};
      const needsCamera = !!constraints.video;
      const needsMic = !!constraints.audio;
      const checks = [];
      if (needsCamera) checks.push(ipc('nova:device:camera', {}));
      if (needsMic) checks.push(ipc('nova:device:microphone', {}));
      if (checks.length === 0) {
        return Promise.reject(new TypeError('getUserMedia requires at least one of video/audio in constraints'));
      }
      return Promise.all(checks).then(function() {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
          return Promise.reject(new TypeError('getUserMedia not available in this environment'));
        }
        return navigator.mediaDevices.getUserMedia(constraints);
      });
      // Any PERMISSION_DENIED from the ipc() calls above rejects here
      // naturally (ipc() rejects on error responses), so callers see the
      // same app-level denial they'd get from any other nova:* call,
      // before ever reaching the browser's own permission prompt.
    },
    // Calendar/contacts read/write the SAME shared data the host
    // Calendar/Contacts apps use (not a per-app isolated store) — see the
    // handleCalendar*/handleContacts* comments in app-sandbox.js for why.
    calendar: {
      list: function() { return ipc('nova:calendar:read', {}); },
      save: function(event) { return ipc('nova:calendar:write', { event: event }); },
      remove: function(id) { return ipc('nova:calendar:delete', { id: id }); }
    },
    contacts: {
      list: function() { return ipc('nova:contacts:read', {}); },
      save: function(contact) { return ipc('nova:contacts:write', { contact: contact }); },
      remove: function(id) { return ipc('nova:contacts:delete', { id: id }); }
    },
    // list/uninstall are plain reads/writes on the app registry.
    // install fails closed on anything a human would normally need to
    // click through (untrusted signer, tampered contents, already
    // installed) — see the handleAppInstall comment in app-sandbox.js.
    apps: {
      list: function() { return ipc('nova:app:list', {}); },
      launch: function(appId, options) { return ipc('nova:app:launch', { appId: appId, options: options || {} }); },
      install: function(pkg) { return ipc('nova:app:install', { package: pkg }); },
      uninstall: function(appId) { return ipc('nova:app:uninstall', { appId: appId }); },
      // Sends the user to Settings -> Default Apps. category is an
      // optional hint (e.g. 'browser', 'texteditor') telling nook which
      // row to highlight — it does not change the default on the app's
      // own behalf. Meant to be called from a real button click; the host
      // rate-limits this call since a postMessage-based sandbox boundary
      // can't otherwise tell a click apart from a script loop.
      openDefaultAppsSettings: function(category) { return ipc('nova:app:openDefaultAppsSettings', { category: category || null }); }
    },
    // admin:* — requires both the per-app permission grant AND the
    // machine's local admin flag to be on (set in Settings). Granting an
    // app one of these permissions doesn't put the machine in admin mode
    // by itself.
    admin: {
      auditQuery: function(filters) { return ipc('nova:admin:audit', filters || {}); },
      systemGet: function() { return ipc('nova:admin:system', { action: 'get' }); },
      systemSet: function(settings) { return ipc('nova:admin:system', { action: 'set', settings: settings }); },
      usersList: function() { return ipc('nova:admin:users', { action: 'list' }); },
      usersRevoke: function(sessionId) { return ipc('nova:admin:users', { action: 'revoke', sessionId: sessionId }); },
      appsList: function() { return ipc('nova:admin:apps', {}); }
    },
    // mail:* reuses whatever account is connected in the host shell's
    // Email app (session-scoped) — there's no separate per-app mail
    // identity. Fails with UNAVAILABLE if nothing is connected.
    mail: {
      connect: function(account) { return ipc('nova:mail:session', { action: 'connect', account: account || {} }); },
      disconnect: function() { return ipc('nova:mail:session', { action: 'disconnect' }); },
      restore: function() { return ipc('nova:mail:session', { action: 'restore' }); },
      account: function() { return ipc('nova:mail:read', { action: 'account' }); },
      folders: function() { return ipc('nova:mail:read', { action: 'folders' }); },
      messages: function(opts) { return ipc('nova:mail:read', Object.assign({ action: 'messages' }, opts || {})); },
      message: function(uid, folder) { return ipc('nova:mail:read', { action: 'message', uid: uid, folder: folder }); },
      search: function(query, folder) { return ipc('nova:mail:read', { action: 'search', query: query, folder: folder }); },
      preview: function(html) { return ipc('nova:mail:write', { action: 'preview', html: html }); },
      markRead: function(uids, folder) { return ipc('nova:mail:write', { action: 'batch', op: 'read', uids: uids, folder: folder }); },
      move: function(uids, dest, folder) { return ipc('nova:mail:write', { action: 'batch', op: 'move', uids: uids, dest: dest, folder: folder }); },
      send: function(msg) { return ipc('nova:mail:send', msg || {}); }, // msg: { to, cc, bcc, subject, text, html, smtpHost, smtpPort }
      remove: function(uids, folder) { return ipc('nova:mail:delete', { uids: uids, folder: folder }); },
      openLink: function(url) { return ipc('nova:email:open-link', { url: url }); }
    }
  };

  // Self-triggered handshake — every app gets this automatically on load,
  // rather than needing to remember to call it. Runs the same
  // ready-handshake side effects (permissions surfaced on window,
  // calendar re-render) via the __novaInbox poller above once the
  // response arrives.
  ipc('nova:ready', {}).catch(function(e) {
    console.error('nova:ready handshake failed:', e);
  });

  // This guest page was loaded from window.location.origin + baseUrl + '/' +
  // app.entry (see loadAppContent below), where baseUrl is
  // '/api/apps/serve/<sandboxId>'. That means window.location.pathname
  // already starts with this sandbox's own serve prefix — capture it once,
  // here, before anything can reassign window.location, so novaFetchImpl
  // can recognize "this app fetching one of its own bundled files" (e.g.
  // Emscripten's glue code fetching its sibling module.wasm) as distinct
  // from a genuine outbound network request, without needing any IPC
  // round-trip or host-side lookup to tell the two apart.
  const ownSandboxPrefixMatch = /^(\\/api\\/apps\\/serve\\/[^/]+\\/)/.exec(window.location.pathname);
  const ownSandboxPrefix = ownSandboxPrefixMatch ? ownSandboxPrefixMatch[1] : null;

  // Override fetch — route through the IPC bridge.
  const novaFetchImpl = function(input, init) {
    init = init || {};
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);

    // Self-fetch exemption: a request the app is making for one of its own
    // registered files (e.g. Emscripten's glue code loading module.wasm via
    // plain fetch()) is not a network request — it's the same category of
    // same-origin asset load a <script src> or <img src> tag already makes
    // without any permission check. Without this, every app bundling
    // Emscripten/WASM output fails silently: the fetch gets routed through
    // nova:net:fetch, which requires a net:* permission grant for what is
    // actually just reading a file already inside this sandbox's own
    // package. Route those straight to the real fetch instead.
    if (ownSandboxPrefix) {
      let resolvedForSelfCheck;
      // window.location.href (full current URL, including path), not
      // window.location.origin (bare scheme+host) -- resolving a relative
      // URL like 'module.wasm' against just the origin drops the page's own
      // directory and produces '/module.wasm' at the server root instead of
      // '<ownSandboxPrefix>module.wasm', which silently failed this check
      // for every relative fetch (exactly the case Emscripten's glue makes).
      try { resolvedForSelfCheck = new URL(url, window.location.href); } catch { resolvedForSelfCheck = null; }
      if (
        resolvedForSelfCheck &&
        resolvedForSelfCheck.origin === window.location.origin &&
        resolvedForSelfCheck.pathname.indexOf(ownSandboxPrefix) === 0
      ) {
        return nativeFetchForDownloads(input, init);
      }
    }

    const method = (init.method || (input && input.method) || 'GET').toUpperCase();
    const headers = init.headers || (input && input.headers) || {};
    const headerObj = {};
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      headers.forEach(function(v, k) { headerObj[k] = v; });
    } else if (Array.isArray(headers)) {
      headers.forEach(function(pair) { headerObj[pair[0]] = pair[1]; });
    } else if (headers && typeof headers === 'object') {
      for (const k in headers) if (Object.prototype.hasOwnProperty.call(headers, k)) headerObj[k] = headers[k];
    }
    const body = init.body != null ? init.body : null;
    let bodyStr = null;
    if (typeof body === 'string') bodyStr = body;
    else if (body instanceof ArrayBuffer) bodyStr = new TextDecoder().decode(body);
    else if (body instanceof Uint8Array) bodyStr = new TextDecoder().decode(body);
    else if (body == null) bodyStr = null;
    else bodyStr = String(body);

    return ipc('nova:net:fetch', { url: url, method: method, headers: headerObj, body: bodyStr })
      .then(function(res) {
        if (!res || !res.success) throw new TypeError('Fetch failed');
        const responseInit = { status: res.status, statusText: res.statusText, headers: new Headers(res.headers || {}) };
        let responseBody = res.body || '';
        if (res.bodyEncoding === 'base64') {
          const binary = atob(responseBody);
          responseBody = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) responseBody[i] = binary.charCodeAt(i);
        }
        return new Response(responseBody, responseInit);
      });
  };

  // fetch/XMLHttpRequest/WebSocket are locked down with defineProperty
  // (writable: false, configurable: false) after both are defined below,
  // rather than plain 'window.fetch = ...' assignment. A plain assignment
  // is trivially reversible with 'delete window.fetch', since fetch isn't
  // a native own-property of window (it lives on Window.prototype) — the
  // delete just unshadows the real implementation underneath. Locking
  // these down doesn't change behavior for any app going through the
  // override normally; it only stops an app from un-shadowing the native
  // fetch/XHR/WebSocket to bypass nova:net:* permission checks entirely.

  // Minimal XMLHttpRequest override that routes through the fetch shim.
  // Covers the common API surface (open/send/setRequestHeader/onload/onerror/
  // onreadystatechange/status/responseText). Advanced features (upload
  // events, progress, responseType blob, the timeout property's auto-fire
  // of a 'timeout' event) are not implemented — apps needing those should
  // use fetch directly.
  function NovaXHR() {
    const xhr = this;
    let method = 'GET', url = '', headers = {}, body = null;
    let state = 0;
    // aborted flag tracks whether the caller cancelled the request so
    // the late-arriving fetch callback can short-circuit instead of
    // mutating state and firing load/error listeners on a dead object
    // (the previous version's abort() set state=0 but the fetch still
    // resolved and overwrote everything, so abort was effectively a no-op
    // for any request that had already been sent).
    let aborted = false;
    const listeners = { load: [], error: [], readystatechange: [], loadend: [], abort: [] };

    Object.defineProperty(this, 'readyState', { get: function() { return state; }, configurable: true });
    Object.defineProperty(this, 'status', { get: function() { return xhr._status || 0; }, configurable: true });
    Object.defineProperty(this, 'statusText', { get: function() { return xhr._statusText || ''; }, configurable: true });
    Object.defineProperty(this, 'responseText', { get: function() { return xhr._responseText || ''; }, configurable: true });
    Object.defineProperty(this, 'response', { get: function() { return xhr._responseText || ''; }, configurable: true });
    Object.defineProperty(this, 'responseURL', { get: function() { return url; }, configurable: true });

    this.open = function(m, u) { method = (m || 'GET').toUpperCase(); url = u || ''; state = 1; };
    this.setRequestHeader = function(k, v) { headers[k] = v; };
    this.getAllResponseHeaders = function() { return xhr._responseHeaders || ''; };
    this.getResponseHeader = function(k) { return (xhr._responseHeaderMap || {})[k.toLowerCase()] || null; };
    this.abort = function() {
      aborted = true;
      state = 0;
      listeners.abort.forEach(function(h) { h.call(xhr); });
    };
    this.addEventListener = function(type, handler) { if (listeners[type]) listeners[type].push(handler); };
    this.removeEventListener = function(type, handler) {
      if (listeners[type]) listeners[type] = listeners[type].filter(function(h) { return h !== handler; });
    };

    this.send = function(b) {
      body = b;
      novaFetchImpl(url, { method: method, headers: headers, body: typeof body === 'string' ? body : null })
        .then(function(res) {
          if (aborted) return; // caller cancelled — drop silently
          state = 2;
          xhr._status = res.status;
          xhr._statusText = res.statusText;
          const headerMap = {};
          const headerLines = [];
          res.headers.forEach(function(v, k) { headerMap[k.toLowerCase()] = v; headerLines.push(k + ': ' + v); });
          xhr._responseHeaderMap = headerMap;
          xhr._responseHeaders = headerLines.join('\\r\\n');
          listeners.readystatechange.forEach(function(h) { h.call(xhr); });
          return res.text();
        })
        .then(function(text) {
          if (aborted) return;
          xhr._responseText = text;
          state = 3;
          listeners.readystatechange.forEach(function(h) { h.call(xhr); });
          state = 4;
          listeners.readystatechange.forEach(function(h) { h.call(xhr); });
          listeners.load.forEach(function(h) { h.call(xhr); });
          listeners.loadend.forEach(function(h) { h.call(xhr); });
        })
        .catch(function(err) {
          if (aborted) return;
          xhr._error = err;
          state = 4;
          listeners.error.forEach(function(h) { h.call(xhr, err); });
          listeners.loadend.forEach(function(h) { h.call(xhr); });
        });
    };
  }
  // Override WebSocket — route through the IPC bridge instead of letting
  // the guest open a raw socket unmediated. This closes the gap where
  // 'new WebSocket(...)' bypassed nova:net:websocket's permission check
  // entirely: the fetch/XHR overrides below only ever covered fetch()/XHR,
  // never the native WebSocket constructor, so an app with zero granted
  // permissions could still open a live socket to any host RELAXED_CSP_META's
  // connect-src allows. Reuses the same wsId/wsEventListeners plumbing the
  // nova.websocket() convenience wrapper already uses (see setupAPIBridge),
  // so host-side event delivery (nova:net:ws:message/error/close) needs no
  // changes — this just gives the *native* constructor the same routing the
  // wrapper already had.
  function NovaWebSocket(url, protocols) {
    const self = this;
    let wsId = null;
    let readyState = 0; // CONNECTING
    const listeners = { open: [], message: [], error: [], close: [] };
    const bufferedBeforeOpen = []; // sends attempted before the IPC round-trip resolves

    Object.defineProperty(this, 'readyState', { get: function() { return readyState; }, configurable: true });
    Object.defineProperty(this, 'url', { value: typeof url === 'string' ? url : String(url), configurable: true });

    this.addEventListener = function(type, handler) { if (listeners[type]) listeners[type].push(handler); };
    this.removeEventListener = function(type, handler) {
      if (listeners[type]) listeners[type] = listeners[type].filter(function(h) { return h !== handler; });
    };
    // onopen/onmessage/onerror/onclose property-style handlers, mirrored
    // into the same listener arrays as addEventListener for consistency.
    ['open', 'message', 'error', 'close'].forEach(function(evt) {
      let handler = null;
      Object.defineProperty(self, 'on' + evt, {
        get: function() { return handler; },
        set: function(fn) {
          if (handler) listeners[evt] = listeners[evt].filter(function(h) { return h !== handler; });
          handler = fn;
          if (typeof fn === 'function') listeners[evt].push(fn);
        },
        configurable: true
      });
    });

    this.send = function(data) {
      if (readyState !== 1) { bufferedBeforeOpen.push(data); return; }
      ipc('nova:net:ws:send', { wsId: wsId, data: data }).catch(function() { /* best-effort, matches native fire-and-forget semantics */ });
    };
    this.close = function(code, reason) {
      if (readyState === 2 || readyState === 3) return;
      readyState = 2; // CLOSING
      ipc('nova:net:ws:close', { wsId: wsId, code: code, reason: reason }).catch(function() { /* best-effort */ });
    };

    ipc('nova:net:websocket', { url: this.url, protocols: protocols })
      .then(function(res) {
        wsId = res.wsId || (res.result && res.result.wsId);
        if (!wsId) throw new Error('nova:net:websocket resolved without a wsId');
        readyState = 1; // OPEN
        wsEventListeners[wsId] = {
          message: [function(data) { listeners.message.forEach(function(h) { h.call(self, { data: data }); }); }],
          error: [function() { listeners.error.forEach(function(h) { h.call(self, {}); }); }],
          close: [function(info) {
            readyState = 3; // CLOSED
            listeners.close.forEach(function(h) { h.call(self, info || {}); });
            delete wsEventListeners[wsId];
          }]
        };
        bufferedBeforeOpen.splice(0).forEach(function(data) { self.send(data); });
        listeners.open.forEach(function(h) { h.call(self, {}); });
      })
      .catch(function() {
        readyState = 3; // CLOSED — connection never opened; host has no reject
        // path for this (see nova.websocket()'s NOTE above), so this only
        // fires once the shim's own IPC timeout elapses.
        listeners.error.forEach(function(h) { h.call(self, {}); });
        listeners.close.forEach(function(h) { h.call(self, {}); });
      });
  }
  NovaWebSocket.CONNECTING = 0;
  NovaWebSocket.OPEN = 1;
  NovaWebSocket.CLOSING = 2;
  NovaWebSocket.CLOSED = 3;

  // Lock down fetch/XHR/WebSocket so 'delete window.fetch' etc. can't
  // unshadow the native implementations underneath (fix #2). Plain
  // assignment (the old 'window.fetch = ...' / 'window.XMLHttpRequest = ...'
  // pattern) left these reversible with one line from guest code.
  [
    ['fetch', novaFetchImpl],
    ['XMLHttpRequest', NovaXHR],
    ['WebSocket', NovaWebSocket]
  ].forEach(function(pair) {
    Object.defineProperty(window, pair[0], { value: pair[1], writable: false, configurable: false });
  });

  // Fire-and-forget send: same port bridge as ipc(), but with no
  // pendingRequests entry since nothing here waits on a reply.
  function ipcFireAndForget(type, payload) {
    try {
      const id = generateId();
      sendOverPort({ kind: 'request', type: type, payload: payload, requestId: id });
    } catch { /* best-effort */ }
  }

  // Audit eval calls. This wrapper is now effectively dead code for direct
  // eval() — the CSP no longer includes 'unsafe-eval', so the browser
  // itself throws a CSP violation before this function body ever runs.
  // Left in place (harmless) in case CSP is ever relaxed again; if you're
  // reading this because eval() calls aren't being logged, check whether
  // 'unsafe-eval' is back in RELAXED_CSP_META first.
  // NOTE: this only ever wrapped window.eval — new Function(...) is a
  // separate code-execution path that was never audited here, and is now
  // blocked by the same CSP change rather than logged.
  const originalEval = window.eval;
  window.eval = function(code) {
    const preview = String(code).slice(0, 200);
    ipcFireAndForget('nova:audit:eval', { preview: preview });
    // Wrapping eval in a function makes this indirect eval regardless of
    // how it's called — direct eval's special-case only applies to a
    // bare eval(...) call, not to a function wrapper. Indirect eval
    // runs in global scope, which is what we want here since the audit
    // hook shouldn't capture the calling function's local scope.
    return (0, originalEval)(code);
  };

  // Override sendBeacon — fire-and-forget POST through the IPC bridge.
  // Returns true synchronously to match the native API contract; the actual
  // permission check happens host-side and the result is dropped.
  if (navigator.sendBeacon) {
    navigator.sendBeacon = function(url, data) {
      try {
        const body = typeof data === 'string' ? data : (data && data.toString ? data.toString() : '');
        ipcFireAndForget('nova:net:fetch', { url: url, method: 'POST', headers: {}, body: body });
        return true;
      } catch {
        return false;
      }
    };
  }

  // Nested <webview> lockdown
  //
  // A <webview> tag the guest's OWN content creates is a second, independent
  // renderer process this guest would control directly — a much bigger
  // capability than anything else this shim gates, since none of the outer
  // sandbox's own webview attributes (nodeintegration, partition, sandbox
  // tokens) apply to a tag the guest instantiates itself. Blocked by
  // default; only bypassed when the host baked in
  // __NOVA_NESTED_WEBVIEW_ALLOWED__ = true for this specific app (system
  // apps, or a .novaapp that both declared allowNestedWebview in its
  // manifest AND holds the 'sandbox:nested-webview' grant — see
  // isNestedWebviewPermitted() host-side).
  //
  // Three insertion paths are covered, since blocking only one leaves the
  // others wide open:
  //   1. document.createElement('webview') — the normal, scriptable path.
  //   2. innerHTML / outerHTML / insertAdjacentHTML — the HTML parser can
  //      create a <webview> without ever calling createElement.
  //   3. A MutationObserver backstop — catches anything that slips past
  //      1/2 (e.g. a future API, or a parser edge case), by removing any
  //      <webview> element the instant it's actually attached to the DOM.
  //
  // Historical nested-webview crash report; the delay mitigation is removed.
  // The implementation below routes permitted webviews through host siblings,
  // so the guest renderer never instantiates a second native webview.
  //
  // The old navigation delay was only a timing workaround and still created
  // a native guest inside the app's guest. The proxy below instead creates
  // permitted native webviews as siblings of the outer app webview.
  if (__NOVA_NESTED_WEBVIEW_ALLOWED__) {
    const originalCreateElementForNav = Document.prototype.createElement;
    Document.prototype.createElement = function(tagName, options) {
      const el = originalCreateElementForNav.call(this, tagName, options);
      if (typeof tagName === 'string' && tagName.toLowerCase() === 'webview') {
        const srcDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'src')
          || Object.getOwnPropertyDescriptor(Element.prototype, 'src');
        // Fall back to plain attribute get/set if this build's <webview>
        // doesn't expose src as an accessor property (still functionally
        // correct, just without the descriptor's own get/set semantics).
        const nativeGetSrc = srcDesc && srcDesc.get
          ? function() { return srcDesc.get.call(el); }
          : function() { return el.getAttribute('src'); };
        const nativeSetSrc = srcDesc && srcDesc.set
          ? function(v) { srcDesc.set.call(el, v); }
          : function(v) { el.setAttribute('src', v); };

        try {
          Object.defineProperty(el, 'src', {
            get: nativeGetSrc,
            set: function(value) { nativeSetSrc(value); },
            configurable: true,
          });
        } catch (e) {
          // If defineProperty fails for any reason (unexpected element
          // shape, frozen prototype, etc.), fail open to the original,
          // undelayed behavior rather than leaving .src unusable. Uses
          // console.warn directly (not the host-side log() helper — this
          // code runs inside the guest's own injected shim, a different
          // scope, where that helper doesn't exist).
          console.warn('Could not wrap nested webview src for nav delay:', e);
        }
      }
      return el;
    };
  }

  if (__NOVA_NESTED_WEBVIEW_ALLOWED__) {
    const nativeCreateElement = Document.prototype.createElement;
    const nestedProxies = new Map();
    window.__novaNestedWebviewProxies = nestedProxies;
    let nestedSequence = 0;

    function scheduleNestedBounds(proxy) {
      if (proxy.__boundsScheduled) return;
      proxy.__boundsScheduled = true;
      requestAnimationFrame(function() {
        proxy.__boundsScheduled = false;
        if (!proxy.isConnected || !proxy.__hostReady) return;
        const rect = proxy.getBoundingClientRect();
        const style = getComputedStyle(proxy);
        const bounds = {
          left: Math.max(0, rect.left),
          top: Math.max(0, rect.top),
          width: Math.max(0, Math.min(window.innerWidth, rect.right) - Math.max(0, rect.left)),
          height: Math.max(0, Math.min(window.innerHeight, rect.bottom) - Math.max(0, rect.top)),
          visible: !proxy.hidden && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
          visibility: style.visibility,
          pointerEvents: style.pointerEvents,
          zIndex: style.zIndex === 'auto' ? 1 : Number(style.zIndex)
        };
        if (proxy.__lastBounds && Object.keys(bounds).every(key => proxy.__lastBounds[key] === bounds[key])) return;
        proxy.__lastBounds = bounds;
        ipc('nova:nested-webview', { action: 'bounds', id: proxy.__nestedId, bounds })
          .catch(error => console.error('Nested webview bounds update failed:', error));
      });
    }

    class NovaNestedWebview extends HTMLElement {
      constructor() {
        super();
        this.__nestedId = 'nvw_' + Date.now().toString(36) + '_' + (++nestedSequence).toString(36);
      }
      connectedCallback() {
        if (this.__created) return;
        if (!this.style.display) this.style.display = 'block';
        this.__created = true;
        nestedProxies.set(this.__nestedId, this);
        const attributes = {};
        for (const name of ['allowfullscreen', 'allowpopups', 'src', 'partition']) {
          const value = this.getAttribute(name);
          if (value !== null) attributes[name] = value;
        }
        if (attributes.src && __NOVA_PENDING_INITIAL_URL__) {
          attributes.src = __NOVA_PENDING_INITIAL_URL__;
          __NOVA_PENDING_INITIAL_URL__ = null;
        }
        this.__createPromise = ipc('nova:nested-webview', { action: 'create', id: this.__nestedId, attributes })
          .then(() => { this.__hostReady = true; scheduleNestedBounds(this); });
        this.__createPromise.catch(error => console.error('Nested webview creation failed:', error));
        this.__resizeObserver = new ResizeObserver(() => scheduleNestedBounds(this));
        this.__resizeObserver.observe(this);
        this.__mutationObserver = new MutationObserver(() => scheduleNestedBounds(this));
        this.__mutationObserver.observe(this, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
      }
      disconnectedCallback() {
        this.__resizeObserver?.disconnect();
        this.__mutationObserver?.disconnect();
        if (!this.__created) return;
        this.__created = false;
        this.__hostReady = false;
        nestedProxies.delete(this.__nestedId);
        ipc('nova:nested-webview', { action: 'destroy', id: this.__nestedId }).catch(() => {});
      }
      setAttribute(name, value) {
        const key = String(name).toLowerCase();
        if (key === 'src' && __NOVA_PENDING_INITIAL_URL__) {
          value = __NOVA_PENDING_INITIAL_URL__;
          __NOVA_PENDING_INITIAL_URL__ = null;
        }
        super.setAttribute(name, value);
        if (this.__created && ['allowfullscreen', 'allowpopups', 'src', 'partition'].includes(key)) {
          ipc('nova:nested-webview', { action: 'attribute', id: this.__nestedId, name: key, value: String(value) })
            .catch(error => console.error('Nested webview attribute update failed:', error));
        }
        scheduleNestedBounds(this);
      }
      removeAttribute(name) {
        super.removeAttribute(name);
        const key = String(name).toLowerCase();
        if (this.__created && ['allowfullscreen', 'allowpopups', 'src', 'partition'].includes(key)) {
          ipc('nova:nested-webview', { action: 'attribute', id: this.__nestedId, name: key, remove: true })
            .catch(error => console.error('Nested webview attribute update failed:', error));
        }
        scheduleNestedBounds(this);
      }
      get src() { return this.getAttribute('src') || ''; }
      set src(value) { this.setAttribute('src', value); }
      getURL() { return this.src; }
      navigate(url) {
        super.setAttribute('src', String(url));
        return ipc('nova:nested-webview', {
          action: 'attribute', id: this.__nestedId, name: 'src', value: String(url)
        });
      }
      executeScript(details, callback) {
        const result = ipc('nova:nested-webview', { action: 'command', id: this.__nestedId, command: 'executeScript', details: details || {} });
        if (typeof callback === 'function') result.then(callback, error => console.error(error));
        return result;
      }
      insertCSS(details, callback) {
        const result = ipc('nova:nested-webview', { action: 'command', id: this.__nestedId, command: 'insertCSS', details: details || {} });
        if (typeof callback === 'function') result.then(callback, error => console.error(error));
        return result;
      }
      reload() { return this.__command('reload'); }
      back() { return this.__command('back'); }
      forward() { return this.__command('forward'); }
      stop() { return this.__command('stop'); }
      canGoBack() { return this.__queryCommand('canGoBack'); }
      canGoForward() { return this.__queryCommand('canGoForward'); }
      find(query, options) {
        return ipc('nova:nested-webview', {
          action: 'command', id: this.__nestedId, command: 'find',
          query, options: options || {}
        });
      }
      stopFinding(action) { return this.__valueCommand('stopFinding', action || 'clear'); }
      setUserAgentOverride(userAgent) { return this.__valueCommand('setUserAgentOverride', userAgent); }
      setZoom(value) { return this.__valueCommand('setZoom', value); }
      setZoomMode(value) { return this.__valueCommand('setZoomMode', value); }
      clearData(options, types, callback) {
        const result = ipc('nova:nested-webview', {
          action: 'command', id: this.__nestedId, command: 'clearData', types: types || []
        });
        if (typeof callback === 'function') result.then(callback, error => console.error(error));
        return result;
      }
      __command(command) {
        return ipc('nova:nested-webview', { action: 'command', id: this.__nestedId, command });
      }
      __queryCommand(command) {
        return this.__command(command).then(result => result?.value === true);
      }
      __attachPopup(popupId) {
        return Promise.resolve(this.__createPromise).then(() => ipc('nova:nested-webview', {
          action: 'attach-popup', id: this.__nestedId, popupId
        }));
      }
      __valueCommand(command, value) {
        return ipc('nova:nested-webview', { action: 'command', id: this.__nestedId, command, value });
      }
    }

    customElements.define('nova-nested-webview', NovaNestedWebview);
    const proxyStyle = nativeCreateElement.call(document, 'style');
    proxyStyle.textContent = 'nova-nested-webview{display:block;width:100%;height:100%;}nova-nested-webview[hidden]{display:none!important;}';
    document.documentElement.appendChild(proxyStyle);
    Document.prototype.createElement = function(tagName, options) {
      if (typeof tagName === 'string' && tagName.toLowerCase() === 'webview') {
        return nativeCreateElement.call(this, 'nova-nested-webview', options);
      }
      return nativeCreateElement.call(this, tagName, options);
    };
    window.addEventListener('resize', () => nestedProxies.forEach(scheduleNestedBounds));
    window.addEventListener('scroll', () => nestedProxies.forEach(scheduleNestedBounds), true);
    const boundsObserver = new MutationObserver(() => nestedProxies.forEach(scheduleNestedBounds));
    boundsObserver.observe(document.documentElement, { childList: true, subtree: true });

    const innerHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    if (innerHTMLDesc?.set) {
      Object.defineProperty(Element.prototype, 'innerHTML', {
        get: innerHTMLDesc.get,
        set: function(value) {
          if (typeof value === 'string' && /<webview[\\s>]/i.test(value)) {
            value = value.replace(/<webview(?=[\\s>])/gi, '<nova-nested-webview')
              .replace(/<\\/webview\\s*>/gi, '</nova-nested-webview>');
          }
          return innerHTMLDesc.set.call(this, value);
        },
        configurable: true
      });
    }
    const originalInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
    function rewriteNestedWebviewMarkup(value) {
      return value.replace(/<webview(?=[\\s>])/gi, '<nova-nested-webview')
        .replace(/<\\/webview\\s*>/gi, '</nova-nested-webview>');
    }
    Element.prototype.insertAdjacentHTML = function(position, text) {
      if (typeof text === 'string' && /<webview[\\s>]/i.test(text)) {
        text = rewriteNestedWebviewMarkup(text);
      }
      return originalInsertAdjacentHTML.call(this, position, text);
    };
    const outerHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');
    if (outerHTMLDesc?.set) {
      Object.defineProperty(Element.prototype, 'outerHTML', {
        get: outerHTMLDesc.get,
        set: function(value) {
          if (typeof value === 'string' && /<webview[\\s>]/i.test(value)) {
            value = rewriteNestedWebviewMarkup(value);
          }
          return outerHTMLDesc.set.call(this, value);
        },
        configurable: true
      });
    }
    function replaceNativeWebview(node) {
      const proxy = nativeCreateElement.call(document, 'nova-nested-webview');
      const attrs = Array.from(node.attributes || []);
      const src = node.getAttribute('src');
      node.removeAttribute('src');
      for (const attr of attrs) proxy.setAttribute(attr.name, attr.value);
      if (src) proxy.setAttribute('src', src);
      node.replaceWith(proxy);
    }
    const nativeWebviewObserver = new MutationObserver(function(mutations) {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'WEBVIEW') {
            replaceNativeWebview(node);
          } else if (typeof node.querySelectorAll === 'function') {
            node.querySelectorAll('webview').forEach(replaceNativeWebview);
          }
        }
      }
    });
    nativeWebviewObserver.observe(document.documentElement, { childList: true, subtree: true });

    class NovaBrowserView extends EventTarget {
      constructor(element, pollingInterval) {
        super();
        this.element = element;
        this.url = '';
        this.title = '';
        this.loading = false;
        this.canGoBack = null;
        this.canGoForward = null;
        this._history = [];
        this._historyIndex = -1;
        this._historyMove = 0;
        this.destroyed = false;
        this._refreshing = false;
        this._pollingInterval = pollingInterval;
        this._lastStateError = null;
        this._onLoadStart = event => {
          this.loading = true;
          this._emit('navigation-start', this._navigationDetail(event));
        };
        this._onLoadRedirect = event => this._emit('navigation-redirect', this._navigationDetail(event));
        this._onLoadCommit = event => {
          if (event.isTopLevel === false) return;
          this._setUrl(event.url || '');
          this._emit('navigation-commit', this._navigationDetail(event));
        };
        this._onLoadStop = () => {
          this.loading = false;
          this._emit('navigation-complete', this._state());
          this.refreshState().catch(error => this._reportStateError(error));
        };
        this._onLoadError = event => {
          if (event.isTopLevel === false) return;
          this.loading = false;
          this._emit('navigation-error', this._navigationDetail(event));
        };
        this._onClose = event => this._emit('close', this._navigationDetail(event));
        this._onCrash = event => this._emit('crash', this._navigationDetail(event));
        this._onNewWindow = event => {
          const popup = event.window;
          this._emit('new-window', {
            url: event.targetUrl || '',
            disposition: event.windowOpenDisposition || '',
            width: event.initialWidth || null,
            height: event.initialHeight || null,
            window: popup ? {
              attach: browserView => {
                if (!browserView?.element) throw new TypeError('attach requires a Nova browser view');
                return popup.attach(browserView.element);
              },
              discard: () => popup.discard(),
            } : null,
          });
        };
        this._onPermissionRequest = event => {
          if (event.permission === 'download') {
            this._emit('download-request', {
              url: event.request?.url || event.url || '',
            });
          }
        };
        element.addEventListener('loadstart', this._onLoadStart);
        element.addEventListener('loadredirect', this._onLoadRedirect);
        element.addEventListener('loadcommit', this._onLoadCommit);
        element.addEventListener('loadstop', this._onLoadStop);
        element.addEventListener('loadabort', this._onLoadError);
        element.addEventListener('loaderror', this._onLoadError);
        element.addEventListener('close', this._onClose);
        element.addEventListener('crashed', this._onCrash);
        element.addEventListener('newwindow', this._onNewWindow);
        element.addEventListener('permissionrequest', this._onPermissionRequest);
        if (pollingInterval > 0) {
          this._pollTimer = setInterval(() => {
            this.refreshState().catch(error => this._reportStateError(error));
          }, pollingInterval);
        }
      }
      _emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
      }
      _navigationDetail(event) {
        return {
          url: event.url || event.targetUrl || event.validatedURL || this.url,
          isTopLevel: event.isTopLevel !== false,
          reason: event.reason || '',
          errorCode: Number.isInteger(event.errorCode) ? event.errorCode : null,
          errorDescription: event.errorDescription || '',
        };
      }
      _state() {
        return {
          url: this.url,
          title: this.title,
          loading: this.loading,
          canGoBack: this.canGoBack,
          canGoForward: this.canGoForward,
        };
      }
      _setUrl(url) {
        if (typeof url !== 'string' || !url || url === 'about:blank') return;
        if (this._historyMove !== 0) {
          this._historyIndex = Math.max(0, Math.min(this._history.length - 1, this._historyIndex + this._historyMove));
          this._historyMove = 0;
          this._updateHistoryState();
        } else if (url !== this.url) {
          this._history.splice(this._historyIndex + 1);
          this._history.push(url);
          this._historyIndex = this._history.length - 1;
          this._updateHistoryState();
        }
        if (url === this.url) return;
        const previousUrl = this.url;
        this.url = url;
        this._emit('url-change', { url, previousUrl });
      }
      _updateHistoryState() {
        this.canGoBack = this._historyIndex > 0;
        this.canGoForward = this._historyIndex >= 0 && this._historyIndex < this._history.length - 1;
      }
      _reportStateError(error) {
        if (this.destroyed) return;
        const message = error?.message || String(error);
        if (message === this._lastStateError) return;
        this._lastStateError = message;
        this._emit('state-error', { error });
      }
      async refreshState() {
        if (this.destroyed || this._refreshing) return this._state();
        this._refreshing = true;
        try {
          const results = await this.element.executeScript({ code: '[location.href, document.title]' });
          const value = Array.isArray(results) && Array.isArray(results[0]) ? results[0] : results;
          if (Array.isArray(value)) {
            this._setUrl(typeof value[0] === 'string' ? value[0] : '');
            const title = typeof value[1] === 'string' ? value[1] : '';
            if (title !== this.title) {
              const previousTitle = this.title;
              this.title = title;
              this._emit('title-change', { title, previousTitle });
            }
          }
          this._lastStateError = null;
          this._emit('state-change', this._state());
          return this._state();
        } finally {
          this._refreshing = false;
        }
      }
      getState() { return this.refreshState(); }
      navigate(url) {
        if (this.destroyed) return Promise.reject(new Error('Browser view has been destroyed'));
        if (typeof url !== 'string' || !url.trim()) return Promise.reject(new TypeError('A URL is required'));
        if (__NOVA_PENDING_INITIAL_URL__) {
          url = __NOVA_PENDING_INITIAL_URL__;
          __NOVA_PENDING_INITIAL_URL__ = null;
        }
        return this.element.navigate(url);
      }
      back() {
        if (this.canGoBack) this._historyMove = -1;
        return this.element.back().catch(error => {
          this._historyMove = 0;
          throw error;
        });
      }
      forward() {
        if (this.canGoForward) this._historyMove = 1;
        return this.element.forward().catch(error => {
          this._historyMove = 0;
          throw error;
        });
      }
      reload() { return this.element.reload(); }
      stop() { return this.element.stop(); }
      find(query, options) { return this.element.find(query, options); }
      stopFinding(action) { return this.element.stopFinding(action); }
      clearData(types) { return this.element.clearData({}, types); }
      setZoom(zoom) { return this.element.setZoom(zoom); }
      setZoomMode(mode) { return this.element.setZoomMode(mode); }
      setUserAgent(userAgent) { return this.element.setUserAgentOverride(userAgent); }
      executeScript(code) {
        if (typeof code !== 'string' || !code.trim()) return Promise.reject(new TypeError('Script code is required'));
        return this.element.executeScript({ code });
      }
      on(type, listener) {
        this.addEventListener(type, listener);
        return () => this.removeEventListener(type, listener);
      }
      destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        clearInterval(this._pollTimer);
        this.element.removeEventListener('loadstart', this._onLoadStart);
        this.element.removeEventListener('loadredirect', this._onLoadRedirect);
        this.element.removeEventListener('loadcommit', this._onLoadCommit);
        this.element.removeEventListener('loadstop', this._onLoadStop);
        this.element.removeEventListener('loadabort', this._onLoadError);
        this.element.removeEventListener('loaderror', this._onLoadError);
        this.element.removeEventListener('close', this._onClose);
        this.element.removeEventListener('crashed', this._onCrash);
        this.element.removeEventListener('newwindow', this._onNewWindow);
        this.element.removeEventListener('permissionrequest', this._onPermissionRequest);
        this.element.remove();
        this._emit('destroy', {});
      }
    }

    window.nova.browser = Object.freeze({
      createView: async function(options) {
        if (!options || !(options.container instanceof Element)) {
          throw new TypeError('createView requires a container Element');
        }
        const pollingInterval = options.pollingInterval === undefined ? 1000 : Number(options.pollingInterval);
        if (!Number.isInteger(pollingInterval) || pollingInterval < 0 || pollingInterval > 10000
          || (pollingInterval > 0 && pollingInterval < 250)) {
          throw new RangeError('pollingInterval must be 0 or between 250 and 10000 milliseconds');
        }
        const element = document.createElement('webview');
        element.style.cssText = 'display:block;width:100%;height:100%;border:0;';
        options.container.appendChild(element);
        let browserView = null;
        try {
          await element.__createPromise;
          browserView = new NovaBrowserView(element, pollingInterval);
          if (typeof options.url === 'string' && options.url) await browserView.navigate(options.url);
          else if (__NOVA_PENDING_INITIAL_URL__) await browserView.navigate(__NOVA_PENDING_INITIAL_URL__);
          return browserView;
        } catch (error) {
          if (browserView) browserView.destroy();
          else element.remove();
          throw error;
        }
      },
      download: async function(options) {
        if (!options || typeof options.url !== 'string' || !options.url.trim()) {
          throw new TypeError('download requires a URL');
        }
        const response = await fetch(options.url);
        if (!response.ok) throw new Error('Download request failed with HTTP ' + response.status);
        const blob = await response.blob();
        if (blob.size > 100 * 1024 * 1024) throw new RangeError('Downloads are limited to 100 MB');
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error || new Error('Could not read downloaded data'));
          reader.readAsDataURL(blob);
        });
        if (typeof dataUrl !== 'string') throw new Error('Could not encode downloaded data');
        const separator = dataUrl.indexOf(',');
        if (separator < 0) throw new Error('Could not encode downloaded data');
        return window.nova.ipc('nova:download', {
          filename: options.filename || 'download',
          mimeType: blob.type || 'application/octet-stream',
          base64Data: dataUrl.slice(separator + 1),
        });
      },
    });
  }

  if (!__NOVA_NESTED_WEBVIEW_ALLOWED__) {
    const originalCreateElement = Document.prototype.createElement;
    Document.prototype.createElement = function(tagName, options) {
      if (typeof tagName === 'string' && tagName.toLowerCase() === 'webview') {
        ipcFireAndForget('nova:audit:blocked-nested-webview', { via: 'createElement' });
        // Return an inert, disconnected <span> rather than throwing — a
        // throw here would crash whatever app code called createElement
        // (often inside a try/catch-less render path), turning a security
        // block into an unrelated-looking app crash. An inert element that
        // silently does nothing when appended is a much smaller surprise.
        return originalCreateElement.call(this, 'span');
      }
      return originalCreateElement.call(this, tagName, options);
    };

    // Covers innerHTML/outerHTML — both funnel through the same setter,
    // which is what we patch here rather than trying to catch every
    // possible property name.
    const innerHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    if (innerHTMLDesc && innerHTMLDesc.set) {
      Object.defineProperty(Element.prototype, 'innerHTML', {
        get: innerHTMLDesc.get,
        set: function(value) {
          if (typeof value === 'string' && /<webview[\\s>]/i.test(value)) {
            ipcFireAndForget('nova:audit:blocked-nested-webview', { via: 'innerHTML' });
            value = value.replace(/<webview[\\s\\S]*?<\\/webview>/gi, '').replace(/<webview[^>]*\\/?>/gi, '');
          }
          return innerHTMLDesc.set.call(this, value);
        },
        configurable: true,
      });
    }

    const originalInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
    Element.prototype.insertAdjacentHTML = function(position, text) {
      if (typeof text === 'string' && /<webview[\\s>]/i.test(text)) {
        ipcFireAndForget('nova:audit:blocked-nested-webview', { via: 'insertAdjacentHTML' });
        text = text.replace(/<webview[\\s\\S]*?<\\/webview>/gi, '').replace(/<webview[^>]*\\/?>/gi, '');
      }
      return originalInsertAdjacentHTML.call(this, position, text);
    };

    // Backstop: if a <webview> still makes it into the live DOM through
    // some path the above didn't anticipate, rip it out immediately rather
    // than letting it sit there and load. Runs for the lifetime of the
    // document — cheap, since <webview> insertion is not a hot path.
    const nestedWebviewObserver = new MutationObserver(function(mutations) {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'WEBVIEW') {
            ipcFireAndForget('nova:audit:blocked-nested-webview', { via: 'mutation-observer' });
            node.remove();
            continue;
          }
          if (typeof node.querySelectorAll === 'function') {
            const nested = node.querySelectorAll('webview');
            if (nested.length) {
              ipcFireAndForget('nova:audit:blocked-nested-webview', { via: 'mutation-observer-descendant' });
              nested.forEach((n) => n.remove());
            }
          }
        }
      }
    });
    // documentElement always exists by the time this inline script runs
    // (it's injected right after <head>), so no readiness check needed.
    nestedWebviewObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
\x3C/script>`;
  }

  // CSP meta tag injected into app HTML. Allows inline scripts/styles (apps
  // need this) and eval (the audit hook catches abuse), but blocks all direct
  // network access via connect-src 'none' — forcing network through the IPC
  // bridge where permissions are enforced.
  // connect-src no longer carves out http(s)://localhost:* (fix #3). The
  // IPC bridge itself doesn't need it — it's console.log + executeScript,
  // not fetch/XHR/WebSocket — so this carve-out existed only as an
  // (unintentional) escape hatch. With fix #1/#2 closing the WebSocket
  // bypass and locking fetch/XHR/WebSocket against `delete window.fetch`-
  // style unshadowing, this line was the only thing that made either
  // bypass reach anything once triggered. Removing it doesn't change
  // behavior for any app going through nova.fetch()/nova.websocket() as
  // intended, since those never touch native connect-src at all (they're
  // IPC calls, not network requests initiated by this document).
  // CAVEAT: if any first-party app bundle currently does a direct
  // `fetch('http://localhost:...')` or `new WebSocket('ws://localhost:...')`
  // instead of going through nova.fetch()/nova.websocket(), it will break
  // silently (CSP violation, not a JS error) once this ships. That
  // couldn't be verified from this file alone — grep first-party app
  // source for direct localhost fetch/WebSocket calls before deploying,
  // and migrate any hits to the nova.* wrappers first.
  // 'wasm-unsafe-eval' added to script-src to allow WebAssembly.instantiate()/
  // .compile() for apps bundling compiled C/C++ (Emscripten) output. This is
  // deliberately NOT the same grant as 'unsafe-eval' (which stays removed,
  // see the eval-removal history below) — it permits WASM module
  // instantiation only, not eval()/new Function() on arbitrary strings. Must
  // be changed together with the identical server-sent header in
  // server/core/index.js (the /api/apps/serve/:sandboxId route) — that
  // header is authoritative for anything served through it and overrides
  // whatever's in this meta tag, so updating only one of the two leaves the
  // other still blocking (or, if done in the wrong direction, still
  // granting) WASM instantiation regardless of this change.
  // unsafe-eval was previously granted here on the theory that the runtime
  // audit hook (nova:audit:eval) was enough of a check. It wasn't — logging
  // after the fact doesn't stop the call. eval/new Function are blocked
  // outright now, and 'wasm-unsafe-eval' does not reopen that hole.
  const RELAXED_CSP_META = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\' blob: data: \'unsafe-inline\'; script-src \'self\' blob: \'unsafe-inline\' \'wasm-unsafe-eval\'; style-src \'self\' \'unsafe-inline\' blob: data:; img-src \'self\' blob: data: https:; font-src \'self\' blob: data:; connect-src \'self\' blob:">';

  function buildRelaxedCspMeta(allowExternalFrames = false) {
    const frameSrc = allowExternalFrames ? '; frame-src http: https:' : '';
    return '<meta http-equiv="Content-Security-Policy" content="default-src \'self\' blob: data: \'unsafe-inline\'; script-src \'self\' blob: \'unsafe-inline\' \'wasm-unsafe-eval\'; style-src \'self\' \'unsafe-inline\' blob: data:; img-src \'self\' blob: data: https:; font-src \'self\' blob: data:; connect-src \'self\' blob:' + frameSrc + '">';
  }

  // Prepend the capability shim as the very first bytes of the app's HTML,
  // unconditionally — not after a regex-matched <head> tag.
  //
  // The old version replaced the first /<head(\s[^>]*)?>/i match, which
  // means the insertion point depended on how the app's own (untrusted)
  // HTML happened to be written: a document with no <head> tag, a
  // malformed one the regex didn't match, or one wrapped in something
  // that shifted where the match landed, could all change where the shim
  // ended up relative to the app's own inline scripts — and script tags
  // execute in document order, so losing the "first" guarantee here would
  // let an app's own script run before the shim's, which is exactly the
  // race this rewrite is closing. Unconditional prepend removes that
  // dependency on the input entirely: whatever the app's HTML contains,
  // the shim is textually first, full stop. Browsers parse and execute a
  // leading <script> correctly even before a <head>/<html> tag appears
  // (they're implied), so this doesn't require well-formed input either.
  //
  // `app` is required to decide the nested-<webview> grant for THIS app —
  // see isNestedWebviewPermitted(). Passing no app is treated as no app
  // (fails closed to "not permitted"), it does not fall back to some
  // shared/cached shim from a previous call.
  //
  // One exception to "unconditional": a leading <!DOCTYPE ...>. Per the
  // HTML spec a doctype is only recognized when it's the very first thing
  // in the document — it's not executable and doesn't run any guest code,
  // so it doesn't reopen the script-ordering race this rewrite closed, but
  // splicing a <script> block before it does knock the parser out of
  // no-quirks mode (or worse, depending on how the host serves the file),
  // which is exactly the "whole app fails to load" failure this is fixing.
  // Matched narrowly (must be at offset 0, case-insensitive) rather than
  // searched for anywhere in the string, so this can't be tricked by an
  // app embedding a fake "<!DOCTYPE" later in the body.
  const LEADING_DOCTYPE_RE = /^\s*<!DOCTYPE\s+html\s*>/i;

  function deferPackagedScripts(html) {
    return html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>/gi, tag => {
      if (tag.startsWith('<!--')) return tag;
      const attributes = tag.slice('<script'.length, -1);
      if (!/(?:^|\s)src\s*=/i.test(attributes)) return tag;

      // Packaged external scripts run only after HTML parsing, in document
      // order. Normalize async scripts too: they otherwise race their DOM
      // and sibling scripts, making startup timing dependent on download speed.
      const normalizedAttributes = attributes
        .replace(/(?:^|\s+)async(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=\s|$)/gi, '')
        .replace(/(?:^|\s+)defer(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=\s|$)/gi, '');
      return `<script${normalizedAttributes} defer>`;
    });
  }

  function injectCapabilityShim(html, app, launchOptions = {}) {
    if (typeof html !== 'string') return html;
    html = deferPackagedScripts(html);
    const allowNestedWebview = isNestedWebviewPermitted(app);
    const allowExternalFrames = isExternalFramesPermitted(app);
    const initialUrl = allowNestedWebview
      && typeof launchOptions.url === 'string'
      && canNestedWebviewNavigate(app, launchOptions.url)
      ? resolveAndClassifyUrl(launchOptions.url).url
      : null;
    const shim = buildCapabilityShim(allowNestedWebview, initialUrl);
    const cspMeta = buildRelaxedCspMeta(allowExternalFrames);
    const safeOptions = JSON.stringify(launchOptions || {})
      .replace(/</g, '\u003c').replace(/>/g, '\u003e').replace(/&/g, '\u0026')
      .replace(/\u2028/g, '\u2028').replace(/\u2029/g, '\u2029');
    const launchOptionsShim = '<script>window.__NOVA_APP_OPTIONS__=' + safeOptions + ';<\/script>';
    const doctypeMatch = html.match(LEADING_DOCTYPE_RE);
    if (doctypeMatch) {
      const doctype = doctypeMatch[0];
      const rest = html.slice(doctype.length);
      return doctype + '\n' + launchOptionsShim + '\n' + shim + '\n' + cspMeta + '\n' + rest;
    }
    return launchOptionsShim + '\n' + shim + '\n' + cspMeta + '\n' + html;
  }

  // App loading

  // Load app content into a sandbox. For webapps (external URLs), validates
  // the protocol before assigning to webview.src — without this, a malicious
  // manifest could specify javascript: or file: URLs.
  async function loadAppContent(webview, app, state, launchOptions = {}) {
    if (app.type === 'webapp' && app.url) {
      const classified = resolveAndClassifyUrl(app.url);
      if (!classified.valid) {
        log('error', `Invalid webapp URL for ${app.name}: ${classified.error}`);
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'AppSandbox', category: 'security', severity: 'error', message: `Rejected invalid webapp URL for ${app.name}: ${classified.error}`, data: { appId: app.id, url: app.url } });
        }
        showErrorPage(webview, app, `Invalid URL: ${classified.error}`);
        return;
      }
      webview.src = classified.url;
      return;
    }

    if (app.entry && app.files && app.files[app.entry]) {
      try {
        const sandboxId = webview.dataset.sandboxId;
        // Inject the capability shim into the entry HTML before registering.
        // Use UTF-8-safe base64 so non-ASCII content survives the round-trip.
        const shimmedFiles = Object.assign({}, app.files);
        const rawHtml = decodeBase64Utf8(shimmedFiles[app.entry]);
        const allowExternalFrames = isExternalFramesPermitted(app);
        const transparentHtml = app.transparent
          ? rawHtml.replace(
              /<head(\s[^>]*)?>/i,
              (m) => `${m}<style id=\"novaapp-transparent-root\">
                /* transparent: true enables an alpha-capable app surface; it
                   must not force the app's own UI to become transparent. Only
                   the document roots start transparent, and explicit app CSS
                   (including solid backgrounds on body, #app, cards, etc.) is
                   free to paint an opaque surface normally. */
                html,body{background:transparent;}
                /* Descendant elements keep their normal CSS backgrounds. The
                   transparent app surface comes from the document roots, so an
                   app can leave its surrounding canvas glassy while explicitly
                   painting a child surface (search bar, card, toolbar, etc.)
                   with any solid background it wants. */
              </style>`
            )
          : rawHtml;
        shimmedFiles[app.entry] = encodeBase64Utf8(injectCapabilityShim(transparentHtml, app, launchOptions));

        const regRes = await fetch('/api/apps/serve/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sandboxId, files: shimmedFiles, allowExternalFrames }),
        });
        if (!regRes.ok) throw new Error(`File registration failed: ${regRes.status}`);
        const { baseUrl } = await regRes.json();
        webview.src = window.location.origin + baseUrl + '/' + app.entry;
      } catch (error) {
        log('error', `Failed to load app content for ${app.name}:`, error);
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'AppSandbox', category: 'apps', severity: 'error', message: `Failed to load content for ${app.name}: ${error?.message || error}`, data: { appId: app.id } });
        }
        showErrorPage(webview, app, 'Failed to load app content');
      }
    } else {
      createDefaultAppShell(webview, app, state);
    }
  }

  // Build the default app shell for apps without content. Uses
  // JSON.stringify for the app.id interpolation into the inline script —
  // escapeHtml is wrong for JS string context (it would insert HTML entities
  // literally inside a JS string).
  async function createDefaultAppShell(webview, app, state) {
    const safeAppId = JSON.stringify(app.id || '');
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        ${RELAXED_CSP_META}
        <title>${escapeHtml(app.name)}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .app-container { text-align: center; max-width: 600px; }
          .app-icon { font-size: 64px; margin-bottom: 20px; }
          h1 { font-size: 32px; margin-bottom: 10px; }
          p { font-size: 16px; opacity: 0.9; margin-bottom: 30px; }
          .status {
            background: rgba(255,255,255,0.1);
            padding: 15px 25px;
            border-radius: 8px;
            font-size: 14px;
          }
          .api-status {
            margin-top: 20px;
            padding: 10px;
            background: rgba(0,0,0,0.2);
            border-radius: 4px;
            font-family: monospace;
            font-size: 12px;
          }
        </style>
      </head>
      <body>
        <div class="app-container">
          <div class="app-icon">${escapeHtml(app.icon || '📱')}</div>
          <h1>${escapeHtml(app.name)}</h1>
          <p>${escapeHtml(app.description || 'A NovaByte Application')}</p>
          <div class="status">
            <strong>Version:</strong> ${escapeHtml(app.version)}<br>
            <strong>Author:</strong> ${escapeHtml(app.author)}<br>
            <strong>Type:</strong> ${escapeHtml(app.type)}<br>
            <strong>Status:</strong> Running in Sandbox
          </div>
          <div class="api-status" id="apiStatus">
            Initializing API bridge...
          </div>
        </div>
        <script>
          // The capability shim (injected into <head> above) fires
          // nova:ready automatically on load. This script just listens
          // for the resulting bridge-ready signal and updates the status
          // indicator — it does NOT fire a second nova:ready (the old
          // version did, which raced the shim's own ready call and
          // produced a duplicate handshake on every launch).
          (function() {
            function markReady(ok) {
              var el = document.getElementById('apiStatus');
              if (el) el.textContent = ok ? 'API Bridge: Connected ✓' : 'API Bridge: Connection failed';
            }
            if (window.nova && window.nova.ipc) {
              // The shim already fired nova:ready; just listen for its
              // resolution via the shared __novaPermResponse surface the
              // shim populates when the ready response arrives.
              var checkReady = function() {
                if (window.__novaPermResponse) {
                  markReady(true);
                } else {
                  setTimeout(checkReady, 100);
                }
              };
              setTimeout(checkReady, 100);
            } else {
              markReady(false);
            }
          })();
        </script>
      </body>
      </html>
    `;

    try {
      const sandboxId = webview.dataset.sandboxId;
      const regRes = await fetch('/api/apps/serve/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId, files: { 'index.html': encodeBase64Utf8(html) } }),
      });
      if (!regRes.ok) throw new Error(`Registration failed: ${regRes.status}`);
      const { baseUrl } = await regRes.json();
      webview.src = window.location.origin + baseUrl + '/index.html';
    } catch (error) {
      log('error', `Failed to create default shell for ${app.name}:`, error);
    }
  }

  // Show an error page in the sandbox when app content fails to load.
  async function showErrorPage(webview, app, message) {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        ${RELAXED_CSP_META}
        <title>Error - ${escapeHtml(app.name)}</title>
        <style>
          body { font-family: sans-serif; padding: 40px; text-align: center; }
          .error { color: #e74c3c; font-size: 48px; margin-bottom: 20px; }
          h1 { color: #2c3e50; }
          p { color: #7f8c8d; }
        </style>
      </head>
      <body>
        <div class="error">⚠</div>
        <h1>Failed to Load Application</h1>
        <p><strong>${escapeHtml(app.name)}</strong></p>
        <p>${escapeHtml(message)}</p>
        <p><small>App ID: ${escapeHtml(app.id)}</small></p>
      </body>
      </html>
    `;
    try {
      const sandboxId = webview.dataset.sandboxId;
      const regRes = await fetch('/api/apps/serve/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId, files: { 'error.html': encodeBase64Utf8(html) } }),
      });
      if (!regRes.ok) throw new Error(`Registration failed: ${regRes.status}`);
      const { baseUrl } = await regRes.json();
      webview.src = window.location.origin + baseUrl + '/error.html';
    } catch (e) {
      log('error', `Could not show error page for ${app.name}:`, e);
    }
  }

  // Sandbox attribute sanitisation

  // Build a safe sandbox attribute string from an app's sandbox config.
  //
  // allow-same-origin is NOT included by default for third-party apps. Including
  // it lets the guest access its own cookies, localStorage, and sessionStorage
  // on the shared origin — increasing the blast radius of any XSS inside the
  // sandbox. The same-document <iframe> sandbox-escape also applies when
  // combined with allow-scripts.
  //
  // In a <webview>, the real isolation boundary is the separate renderer
  // process, so the DOM-level escape risk is lower than for a same-document
  // iframe. However, the IPC bridge depends on `window.location.origin` matching
  // between the parent and the webview. Without allow-same-origin the origin
  // becomes opaque and postMessage silently drops.
  //
  // Sandboxed apps must explicitly opt in via allowSameOrigin and hold the
  // separate sandbox:same-origin grant. Packages approved for unrestricted
  // host execution return before this function is needed.
  function sanitizeSandboxAttr(sandboxConfig, appId, fullyUnrestricted = false) {
    if (fullyUnrestricted) return '';
    const isExplicitOptIn = sandboxConfig && typeof sandboxConfig === 'object' && sandboxConfig.allowSameOrigin === true;
    const sameOriginPermitted = isExplicitOptIn
      && AppPermissionManager?.isGranted('sandbox:same-origin', appId);

    const tokens = new Set();
    if (sameOriginPermitted) {
      tokens.add('allow-same-origin');
    }

    // Parse the manifest's sandbox config into a token set so we can
    // match exact tokens rather than substring-contains (which would
    // wrongly accept e.g. "allow-scripts-foo" as "allow-scripts").
    //
    // allow-popups-to-escape-sandbox used to be granted purely from the
    // manifest's own self-declaration, with no permission check — unlike
    // allow-same-origin just above, which requires both the manifest flag
    // AND a separate grant. A popup that escapes the sandbox is a fully
    // unrestricted browsing context, arguably comparable risk to
    // allow-same-origin, so it now goes through the same double-gate:
    // manifest opt-in AND sandbox:escape-popups granted.
    const popupsEscapePermitted = sandboxConfig && typeof sandboxConfig === 'object'
      && sandboxConfig.allowPopupsToEscapeSandbox === true
      && AppPermissionManager?.isGranted('sandbox:escape-popups', appId);

    const requestedTokens = new Set();
    if (sandboxConfig && typeof sandboxConfig === 'object') {
      if (sandboxConfig.allowScripts === true) requestedTokens.add('allow-scripts');
      if (sandboxConfig.allowForms === true) requestedTokens.add('allow-forms');
      if (sandboxConfig.allowPopups === true) requestedTokens.add('allow-popups');
      if (popupsEscapePermitted) requestedTokens.add('allow-popups-to-escape-sandbox');
      if (sandboxConfig.allowModals === true) requestedTokens.add('allow-modals');
    } else if (typeof sandboxConfig === 'string') {
      for (const tok of sandboxConfig.split(/\s+/)) {
        if (tok) requestedTokens.add(tok);
      }
    }

    // Only forward tokens we explicitly recognize — a manifest that asks
    // for "allow-top-navigation" or other exotic tokens gets them dropped
    // rather than passed through uninspected.
    const KNOWN_TOKENS = ['allow-scripts', 'allow-forms', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-modals'];
    for (const tok of KNOWN_TOKENS) {
      if (requestedTokens.has(tok)) tokens.add(tok);
    }

    // allow-downloads: without this token, Chromium silently drops any
    // download triggered inside the webview (blob URL + <a download>,
    // navigation to a Content-Disposition: attachment response, etc).
    // It's a per-click, user-gesture-gated action — the OS-native save
    // dialog is the actual security boundary, not this token — so it's
    // safe to include in the default set alongside the other baseline
    // interaction tokens rather than gating it behind a manifest
    // permission the user has to grant separately.
    if (tokens.size === 0) {
      tokens.add('allow-scripts');
      tokens.add('allow-forms');
      tokens.add('allow-popups');
      tokens.add('allow-modals');
      tokens.add('allow-downloads');
    } else if (!tokens.has('allow-downloads')) {
      tokens.add('allow-downloads');
    }

    const attr = Array.from(tokens).join(' ');
    log('debug', `sandbox attrs for ${appId || 'unknown'}: ${attr}`);
    return attr;
  }

  // Sandbox creation

  // Create a sandboxed webview for app execution. The webview runs in a
  // separate renderer process — true process isolation. It cannot access
  // main page JS, DOM, or memory regardless of app content.
  function createSandbox(app, container, state, launchOptions = {}, forceSandbox = false) {
    const webview = document.createElement('webview');

    // nodeintegration=false means the app cannot require() Node.js modules
    // even if the preload script has access — defense in depth.
    webview.setAttribute('nodeintegration', 'false');
    webview.setAttribute('nodeintegrationsubframes', 'false');

    // Sandbox tracking id — unique per launch, used only to key
    // activeSandboxes/eventSubscriptions/etc. so concurrent or repeated
    // launches of the same app don't collide with each other. Uses
    // crypto.randomUUID for collision resistance — Date.now() alone can
    // collide if two sandboxes are created in the same millisecond.
    const sandboxId = generateSandboxId(app.id);
    const nestedWebviewAllowed = isNestedWebviewPermitted(app);

    // Isolated storage partition, keyed by app.id ONLY (not sandboxId).
    // The 'persist:' prefix makes a given partition NAME durable across
    // that partition's own lifetime — it does nothing to unify two
    // different partition names. Keying by app.id alone means every
    // launch of the same app resolves to the same on-disk partition.
    const partitionId = `app_${app.id}`;
    webview.setAttribute('partition', `persist:${partitionId}`);

    const sandboxAttr = sanitizeSandboxAttr(app.sandbox, app.id, isFullyUnrestricted(app) && !forceSandbox);
    if (sandboxAttr) {
      webview.setAttribute('sandbox', sandboxAttr);
    } else if (isFullyUnrestricted(app) && !forceSandbox) {
      // Deliberately no sandbox attribute: this is the exact hand-off from
      // UnrestrictedGate. Keep nodeintegration disabled and the isolated IPC
      // transport intact, so "unsandboxed" does not mean "uncontrolled".
      webview.removeAttribute('sandbox');
    }

    // Register the isolated-world IPC transport before any navigation
    // happens on this webview (loadAppContent, called below, is what
    // first sets webview.src). addContentScripts + run_at: 'document_start'
    // guarantees this runs before the guest's own <head> content —
    // including the main-world capability shim prepended into the app's
    // HTML — ever gets a chance to execute, and it runs in a separate JS
    // realm the guest's own scripts cannot reach (see
    // buildIsolatedTransportScript for why that matters).
    //
    // Scoped to THIS sandbox's own serving path, not the whole origin.
    // /api/apps/serve/register (server/core/index.js) always returns
    // baseUrl = `/api/apps/serve/${sandboxId}` — deterministic from the
    // sandboxId we already generated above, no need to wait on the async
    // registration call below to know it. Matching the bare origin would
    // register this transport against every app's served files on this
    // host (they all live under window.location.origin), so every
    // launched app's webview would get every other app's transport
    // script injected into it — scoping to our own baseUrl keeps this
    // sandbox's isolated IPC transport from leaking into any other
    // sandbox's webview.
    // webapp-type apps (external URLs) don't get this at all: they
    // navigate to classified.url directly and were never given
    // window.nova capabilities in the first place.
    if (typeof webview.addContentScripts === 'function') {
      try {
        webview.addContentScripts([{
          name: `nova-ipc-transport-${sandboxId}`,
          matches: [`${window.location.origin}/api/apps/serve/${sandboxId}/*`],
          js: { code: buildIsolatedTransportScript() },
          run_at: 'document_start',
          all_frames: false,
        }]);
      } catch (e) {
        log('warn', `Failed to register isolated IPC transport for ${app?.id || 'unknown app'}:`, e);
      }
    } else {
      log('warn', `webview.addContentScripts unavailable — IPC transport will not be isolated for ${app?.id || 'unknown app'}`);
    }

    webview.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
      background: ${app.transparent ? 'rgba(0,0,0,0)' : 'transparent'};
      display: flex;
      flex-direction: column;
    `;

    // Transparent NovaApps must not paint an opaque webview canvas over the
    // host window's glass backdrop.
    //
    // NW.js/Chromium's <webview> is a real embedder tag (not an <iframe>),
    // and unlike the top-level BrowserWindow "transparent" feature (which
    // is a documented, compositor-level NW.js feature — see
    // "Transparent Window" in the NW.js docs), there is no equivalent
    // documented guarantee that a nested <webview>'s own rendered surface
    // composites transparently against whatever sits behind it in the
    // embedder page. The `background: transparent` above only avoids the
    // webview element's own CSS box painting a color — it does not by
    // itself confirm the browser process is compositing the guest's
    // rendered surface with per-pixel alpha rather than flattening it to
    // opaque before handing it back to the embedder.
    //
    // `allowtransparency` is the older Chromium/WebKit iframe-family
    // attribute for exactly this (it predates <webview> but the tag
    // inherits from the same guest-view family) — setting it plus an
    // explicit zero-alpha rgba() (rather than the `transparent` keyword,
    // which some Chromium versions resolve differently for compositing
    // purposes than an explicit alpha channel of 0) is the standard
    // combination people reach for. Kept unconditional (not gated behind
    // `if (app.transparent)`) since the base cssText above already always
    // sets background:transparent regardless — there's no reason for this
    // to be conditional on the same flag when it isn't gating anything
    // additional.
    if (app.transparent) {
      webview.setAttribute('allowtransparency', 'true');
      webview.style.backgroundColor = 'rgba(0, 0, 0, 0)';
    }

    webview.dataset.sandboxId = sandboxId;
    webview.dataset.appId = app.id;

    // Collect per-sandbox teardown functions. Each setup function returns
    // a cleanup function; createSandbox stitches them into a single
    // sandbox.cleanup that destroy() runs. This replaces the previous
    // pattern where setupAPIBridge wrote sandbox.cleanup directly (so
    // error-handling and permission-gate listeners were never removed —
    // a real leak for backgrounded sandboxes whose webview element
    // survives in #background-app-host).
    const teardownFns = [];

    const requestedFileIntent = launchOptions?.fileIntent;
    const requestedFileId = requestedFileIntent?.action === 'open'
      ? requestedFileIntent.file?.id
      : null;
    const requestedFile = typeof requestedFileId === 'string' ? FS.files.get(requestedFileId) : null;
    const dotIndex = typeof requestedFile?.name === 'string' ? requestedFile.name.lastIndexOf('.') : -1;
    const fileQuery = requestedFile ? {
      extension: dotIndex !== -1 ? requestedFile.name.slice(dotIndex).toLowerCase() : null,
      mimeType: typeof requestedFile.mimeType === 'string' ? requestedFile.mimeType : '',
    } : null;
    const openFile = requestedFile?.type === 'file'
      && typeof DefaultApps !== 'undefined'
      && DefaultApps.supportsFile(app.id, fileQuery)
      ? { id: requestedFile.id, node: requestedFile }
      : null;

    activeSandboxes.set(sandboxId, {
      appId: app.id,
      iframe: webview,
      webview: webview,
      created: new Date().toISOString(),
      state: state,
      windowId: state?.id,
      wsConnections: new Map(),
      nestedWebviews: new Map(),
      pendingNewWindows: new Map(),
      nestedWebviewAllowed,
      openFile,
      homeSurface: state?.homeSurface === true,
      homeLoadTimer: null,
      cleanup: null, // populated below after all setup runs
    });
    if (state?.content && getComputedStyle(state.content).position === 'static') {
      state.content.style.position = 'relative';
    }

    // Fullscreen support — toggle window maximise when the webview enters or
    // exits fullscreen so the app fills the screen.
    if (state && state.element) {
      // Capture the maximized state at the time of fullscreen entry,
      // not at sandbox creation — the previous version captured it once
      // at creation and then compared against the current state on exit,
      // so if the user manually maximized before entering fullscreen we
      // would wrongly unmaximize on exit.
      let maximizedForFullscreen = false;
      const fullscreenHandler = () => {
        if (document.fullscreenElement === webview) {
          maximizedForFullscreen = !!state.maximized;
          if (typeof WM !== 'undefined' && WM.toggleMaximize && !state.maximized) {
            WM.toggleMaximize(state.id);
          }
        } else {
          if (typeof WM !== 'undefined' && WM.toggleMaximize && !maximizedForFullscreen && state.maximized) {
            WM.toggleMaximize(state.id);
          }
          maximizedForFullscreen = false;
        }
      };
      webview.addEventListener('fullscreenchange', fullscreenHandler, false);
      teardownFns.push(() => webview.removeEventListener('fullscreenchange', fullscreenHandler));
    }

    eventSubscriptions.set(sandboxId, new Map());

    teardownFns.push(setupAPIBridge(webview, app, sandboxId));
    teardownFns.push(setupErrorHandling(webview, app));
    teardownFns.push(setupPermissionRequestGate(webview, app));

    // Compose all teardowns into the sandbox's cleanup function.
    activeSandboxes.get(sandboxId).cleanup = () => {
      for (const entry of activeSandboxes.get(sandboxId)?.nestedWebviews?.values() || []) {
        for (const cleanup of entry.cleanups) {
          try { cleanup(); } catch (e) { log('debug', 'nested webview cleanup step threw', e); }
        }
        entry.view.remove();
      }
      activeSandboxes.get(sandboxId)?.nestedWebviews?.clear();
      activeSandboxes.get(sandboxId)?.appearanceSubscription?.();
      if (activeSandboxes.has(sandboxId)) activeSandboxes.get(sandboxId).appearanceSubscription = null;
      for (const pending of activeSandboxes.get(sandboxId)?.pendingNewWindows?.values() || []) {
        try { pending.discard(); } catch (e) { log('debug', 'pending popup cleanup step threw', e); }
      }
      activeSandboxes.get(sandboxId)?.pendingNewWindows?.clear();
      for (const fn of teardownFns) {
        try { fn(); } catch (e) { log('debug', 'sandbox cleanup step threw', e); }
      }
    };

    log('debug', `Created webview sandbox for ${app.name} (${sandboxId})`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppSandbox', category: 'security', severity: 'info', message: `Created sandbox for ${app.name}`, data: { appId: app.id, sandboxId } });
    }

    return webview;
  }

  // Run a trusted first-party app directly in the host document, matching the
  // pre-NovaApp execution model used by legacy built-in apps. This is the
  // actual "fully unrestricted" tier: there is no guest webview, so the app
  // can see the same host APIs, DOM, WM, FS, Notify, ContextMenu, etc. that
  // its original .js implementation saw. Eligibility is ONLY established by
  // UnrestrictedGate immediately before this function is called.
  async function launchUnrestrictedHostApp(app, container, state, options = {}, reuseEntry = false) {
    const entryName = app?.unrestrictedEntry || app?.manifest?.unrestrictedEntry;
    container.innerHTML = '';
    container.style.padding = '0';
    container.style.overflow = 'hidden';

    if (!reuseEntry) {
      const encoded = entryName && app?.files?.[entryName];
      if (!encoded) throw new Error(`Trusted app ${app?.id || 'unknown'} has no unrestricted entry ${entryName || '(none)'}`);
      const source = decodeBase64Utf8(encoded);

      // Re-use a single marker so reopening an unrestricted app never leaves
      // stale copies of its entry script in the document.
      const scriptSelector = `script[data-nova-unrestricted-app=\"${String(app.id).replace(/[^a-zA-Z0-9_.-]/g, '_')}\"]`;
      document.querySelectorAll(scriptSelector).forEach(node => node.remove());

      // Install the package-local stylesheet in the host document once.
      const styleMarker = `style[data-novaapp-style=\"${String(app.id).replace(/[^a-zA-Z0-9_.-]/g, '_')}\"]`;
      if (!document.querySelector(styleMarker)) {
        const styleEncoded = app?.files?.['style.css'];
        if (styleEncoded) {
          try {
            const styleNode = document.createElement('style');
            styleNode.dataset.novaappStyle = String(app.id).replace(/[^a-zA-Z0-9_.-]/g, '_');
            styleNode.textContent = decodeBase64Utf8(styleEncoded);
            document.head.appendChild(styleNode);
          } catch (styleErr) {
            log('debug', `Unable to install packaged stylesheet for ${app.id}`, { error: styleErr?.message });
          }
        }
      }

      const script = document.createElement('script');
      script.type = 'text/javascript';
      script.dataset.novaUnrestrictedApp = String(app.id).replace(/[^a-zA-Z0-9_.-]/g, '_');
      script.textContent = source + `\n//# sourceURL=novaapp:${String(app.id).replace(/[^a-zA-Z0-9_.-]/g, '_')}/${String(entryName)}\n`;
      const previousUnrestrictedPackage = window.__novaUnrestrictedPackage;
      window.__novaUnrestrictedPackage = app;
      try {
        (document.body || document.documentElement).appendChild(script);
      } finally {
        if (previousUnrestrictedPackage === undefined) {
          delete window.__novaUnrestrictedPackage;
        } else {
          window.__novaUnrestrictedPackage = previousUnrestrictedPackage;
        }
      }
    }

    const registered = (typeof OS !== 'undefined' && OS?.apps?.[app.id]) ||
      (typeof AppRegistry !== 'undefined' && AppRegistry?.getApp?.(app.id)) || null;
    if (!registered || typeof registered.init !== 'function') {
      throw new Error(`Unrestricted app ${app.id} did not register an init() function`);
    }

    // Preserve the signed package identity/lifecycle metadata on the live
    // registered object. The legacy script predates .novaapp metadata and its
    // registerApp() config does not carry these fields.
    Object.assign(registered, {
      icon: app.icon || registered.icon,
      source: app.source,
      verified: app.verified === true,
      signer: app.signer || null,
      revoked: app.revoked === true,
      tampered: app.tampered === true,
      system: app.system === true,
      signature: app.signature || null,
      signing: app.signing || null,
      integrity: app.integrity || null,
      manifest: app.manifest || null,
      novabyte_app: app.novabyte_app,
      compiled_at: app.compiled_at,
      permissions: Array.isArray(app.permissions) ? app.permissions.slice() : (registered.permissions || []),
      optionalPermissions: Array.isArray(app.optionalPermissions) ? app.optionalPermissions.slice() : (registered.optionalPermissions || []),
      unrestrictedEntry: entryName,
      transparent: app.transparent === true,
      allowNestedWebview: app.allowNestedWebview === true,
    });

    await registered.init.call(registered, container, state, options);

    // Host-rendered apps have no webview or sandbox to tear down. The app's
    // own onClose()/state cleanup remains the authoritative lifecycle hook,
    // exactly as it was for the legacy .js app.
    return {
      success: true,
      unrestricted: true,
      appId: app.id,
      windowId: state?.id,
      hostRendered: true,
      iframe: null,
      webview: null,
      cleanup: () => {},
    };
  }

  // Public lifecycle

  function hasRootExecutionGrant(app) {
    return !rootRevocationReloadScheduled
      && (app?.permissions || []).includes('system:root')
      && typeof AppPermissionManager !== 'undefined'
      && AppPermissionManager.isGranted('system:root', app.id) === true
      && typeof OS !== 'undefined'
      && OS.settings?.get?.('devMode') === true
      && OS.settings?.get?.('rootAccessEnabled') === true;
  }

  async function launchRootApp(app, container, state, options) {
    const entryName = app.unrestrictedEntry || app.manifest?.unrestrictedEntry;
    if (typeof entryName !== 'string' || !app.files?.[entryName]) {
      if (typeof Notify !== 'undefined') Notify.show?.({
        title: 'Root app could not start',
        body: 'The package does not contain its declared unrestrictedEntry JavaScript file.',
        type: 'error',
        appName: app.name || 'System',
      });
      if (typeof EventLog !== 'undefined') {
        EventLog.log({
          app: 'AppSandbox',
          category: 'security',
          severity: 'error',
          message: `Root launch blocked for ${app.id}: unrestricted entry missing`,
          data: { appId: app.id, permission: 'system:root', action: 'root-launch-blocked' },
        });
      }
      return null;
    }
    const reuseEntry = installRootApiAudit(app);
    recordRootAudit(app, 'Root execution started');
    app.__rootAccessActive = true;
    try {
      const result = await launchUnrestrictedHostApp(app, container, state, options, reuseEntry);
      const rootRecord = rootExecutionApps.get(app.id);
      if (rootRecord) rootRecord.entryLoaded = true;
      return result;
    } catch (error) {
      console.error(`[RootAccess] Root app ${app.id} failed to start:`, error);
      if (typeof Notify !== 'undefined') Notify.show?.({
        title: 'Root app failed to start',
        body: error?.message || 'The OS will reload to clear partially executed root code.',
        type: 'error',
        appName: app.name || 'System',
      });
      reloadAfterRootRevocation(`Root app ${app.id} failed to start`);
      return null;
    }
  }

  async function launchHome(app, container) {
    if (!container) throw new Error('Home surface container is required');
    if (typeof DefaultApps === 'undefined'
      || !DefaultApps.getAppsForCategory('home').some(candidate => candidate.id === app?.id)) {
      throw new Error('App is not registered as an available Home app');
    }
    const state = {
      appId: app.id,
      content: container,
      element: null,
      homeSurface: true,
      cleanups: [],
    };
    const launchOptions = { homeSurface: true };
    if (hasRootExecutionGrant(app)) {
      return launchRootApp(app, container, state, launchOptions);
    }
    if (typeof app.entry !== 'string' || typeof app.files?.[app.entry] !== 'string') {
      throw new Error(`Home app ${app.id} is missing its packaged entry "${app.entry}"`);
    }

    container.replaceChildren();
    const webview = createSandbox(app, container, state, launchOptions, true);
    webview.style.cssText += 'position:fixed;inset:0;width:100vw;height:100vh;z-index:10;';
    webview.setAttribute('aria-label', `${app.name || app.id} Home`);
    container.appendChild(webview);

    const sandboxId = webview.dataset.sandboxId;
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox) {
      webview.remove();
      throw new Error(`Home app sandbox ${sandboxId} was not registered`);
    }
    sandbox.homeSurface = true;
    sandbox.homeLoadTimer = setTimeout(() => {
      sandbox.homeLoadTimer = null;
      if (activeSandboxes.get(sandboxId) === sandbox) {
        loadAppContent(webview, app, state, launchOptions);
      }
    }, 250);

    return {
      success: true,
      appId: app.id,
      sandboxId,
      webview,
      cleanup: () => destroy(sandboxId),
    };
  }

  // Launch an app in a sandboxed environment unless root access is active.
  async function launch(app, container, state, options = {}) {
    if (!container) {
      throw new Error('Container element is required');
    }

    if (hasRootExecutionGrant(app)) return launchRootApp(app, container, state, options);

    // Re-run the package-level security gate at every launch. Never trust a
    // cached boolean supplied by the caller: the gate re-checks bundle
    // provenance, first-party membership, integrity, and required grants.
    app.__unrestrictedSandbox = false;
    if (typeof UnrestrictedGate !== 'undefined' && typeof UnrestrictedGate.checkUnrestrictedApp === 'function') {
      try {
        const verdict = await UnrestrictedGate.checkUnrestrictedApp(app);
        if (verdict.allowed) {
          app.__unrestrictedSandbox = true;
          log('debug', `Unrestricted execution granted for ${app.id}`);
          return await launchUnrestrictedHostApp(app, container, state, options);
        } else {
          log('debug', `Sandbox retained for ${app.id}: ${verdict.reason}`);
        }
      } catch (err) {
        app.__unrestrictedSandbox = false;
        log('warn', `Unrestricted sandbox check failed for ${app.id}; retaining sandbox`, { error: err?.message });
      }
    }

    // Trusted transparent system apps used to launch through a bespoke
    // sandboxed <iframe> path (launchTrustedTransparentSystemApp, removed)
    // instead of the normal <webview> flow below. That fork existed to keep
    // trusted apps isolated from the parent document, but createSandbox()
    // already isolates every app via a per-app storage partition plus the
    // `sandbox` webview attribute — a stronger boundary than an iframe's
    // same-origin restriction — so the fork bought no real isolation.
    //
    // What it did buy, by accident, was breaking transparency: Chromium
    // composites a sandboxed iframe (no allow-same-origin) as opaque
    // regardless of the guest document's own background:transparent rules,
    // while <webview> honors `allowtransparency` + an explicit zero-alpha
    // background. Signed/trusted transparent apps went through the iframe
    // path and rendered as solid white; unsigned ones went through
    // createSandbox() below and rendered correctly. Routing both through
    // the same path fixes that, and app.transparent (handled inside
    // createSandbox) still applies regardless of app.system/verified/signer.

    // Clear container — any previous webview (and its listeners) goes away.
    container.innerHTML = '';

    const webview = createSandbox(app, container, state, options);
    container.appendChild(webview);

    // NOTE on timing: createSandbox() calls webview.addContentScripts(...)
    // to register the isolated IPC transport script. NW.js's
    // addContentScripts has no Promise, callback, or completion event in
    // its public API (confirmed against docs.nwjs.io and multiple NW.js
    // issue threads) — there is no real way to await "registration done."
    // It's also not guaranteed instantaneous: nwjs/nw.js#7597 reports the
    // registered content script intermittently missing from a webview's
    // very first navigation, which is consistent with a registration race
    // against that navigation rather than a guaranteed-synchronous call.
    //
    // Previously this fired addContentScripts and set webview.src (via
    // loadAppContent, below) back-to-back on the same tick, with nothing
    // between them. If addContentScripts hadn't been processed by NW.js's
    // browser process yet when navigation began, the isolated transport
    // script could fail to attach for that load — and, per manual testing,
    // could produce a hard renderer failure rather than a clean fallback.
    // A short deliberate delay before navigation gives that registration
    // a real window to land first. This is a mitigation for an
    // undocumented timing gap in NW.js's own API, not a confirmed fix for
    // its root cause — if NW.js ever exposes a real completion signal for
    // addContentScripts, switch to that instead of this delay.
    const CONTENT_SCRIPT_REGISTRATION_DELAY_MS = 250;

    // loadAppContent is async (registers files with the server) — fire and
    // let errors surface in the webview via showErrorPage.
    setTimeout(() => {
      loadAppContent(webview, app, state, options || {});
    }, CONTENT_SCRIPT_REGISTRATION_DELAY_MS);

    log('debug', `Launched ${app.name} in sandbox`);

    const sandboxId = webview.dataset.sandboxId;
    return {
      success: true,
      sandboxId,
      appId: app.id,
      windowId: state?.id,
      iframe: webview, // backward-compat alias
      webview: webview,
      cleanup: () => destroy(sandboxId),
    };
  }

  // Destroy a sandbox by ID. Tears down listeners, WebSockets, event
  // subscriptions, open dialogs, and unregisters app files from the serve
  // route. Safe to call multiple times — second call is a no-op.
  function destroy(sandboxId) {
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox) return false;
    // Reentrancy guard: a second caller (e.g. closeWindow racing with
    // uninstall) could otherwise see the same `sandbox` between our get
    // and our delete below, run cleanup twice, and double-close
    // WebSockets / double-remove the dialog overlay. Delete first, then
    // tear down — sandbox.cleanup is still callable via the local ref.
    activeSandboxes.delete(sandboxId);
    if (sandbox.homeLoadTimer) {
      clearTimeout(sandbox.homeLoadTimer);
      sandbox.homeLoadTimer = null;
    }

    // sandbox.cleanup (set up in createSandbox) does the actual teardown:
    // aborts the message listener, detaches OS event subs, closes WebSockets,
    // removes any open file dialog overlay, and detaches the error-handling
    // / permission-gate / fullscreen listeners.
    if (typeof sandbox.cleanup === 'function') {
      sandbox.cleanup();
    }

    // Remove the webview element from the DOM. Without this, a backgrounded
    // sandbox (whose webview lives in #background-app-host) would leak the
    // element and its renderer process forever, even after destroy().
    const webview = sandbox.webview;
    if (webview && webview.parentNode) {
      webview.parentNode.removeChild(webview);
    }

    // Unregister app files from the Express serve route. Best-effort —
    // failures here don't affect the sandbox teardown.
    fetch(`/api/apps/serve/unregister/${encodeURIComponent(sandboxId)}`, { method: 'DELETE' })
      .catch(() => {});

    // Same-origin gating (sanitizeSandboxAttr, above) only controls whether
    // the guest's raw cookies/localStorage/sessionStorage land on a real,
    // stable origin vs an opaque one — it does NOT stop those DOM storage
    // APIs from writing to disk. The persist:app_<appId> partition is a
    // separate Chromium mechanism, set unconditionally in createSandbox(),
    // so an opaque-origin (unpermissioned) app's raw storage writes still
    // survive relaunch under that same reused partition. That's the actual
    // gap sandbox:same-origin's wording ("cookies/localStorage/sessionStorage
    // on the shared origin") implies should NOT persist for these apps.
    //
    // nova:storage:* is unaffected by this — it's a completely separate,
    // host-shell-side IndexedDB, isolated by [appId, key], not by this
    // partition. Wiping the partition here never touches it.
    //
    // Only wipe for apps that weren't granted allow-same-origin at
    // creation. Best-effort: a failure here shouldn't block teardown.
    const appId = sandbox.appId;
    // Read the actual token on the webview instead of re-deriving the grant;
    // this keeps teardown consistent with the decision made at creation.
    const webviewHasSameOrigin = !!sandbox.webview
      && typeof sandbox.webview.getAttribute === 'function'
      && (sandbox.webview.getAttribute('sandbox') || '').split(/\s+/).includes('allow-same-origin');
    const sameOriginPermitted = webviewHasSameOrigin;
    if (appId && !sameOriginPermitted) {
      clearAppExecutionPartition(appId).catch(e => {
        log('warn', 'destroy() — failed to clear storage partition for', appId, e);
      });
    }

    // activeSandboxes.delete(sandboxId) already ran at the top of this
    // function — that early delete is the reentrancy guard, see the
    // comment there for why.
    log('debug', `Destroyed sandbox: ${sandboxId}`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppSandbox', category: 'security', severity: 'info', message: `Destroyed sandbox ${sandboxId}`, data: { appId: sandbox.appId, sandboxId } });
    }

    return true;
  }

  // Push a background-wake event into a specific sandbox's guest page.
  // Narrow, purpose-built wrapper around the internal respond() push
  // mechanism — not a general "send anything into any sandbox" API, since
  // that would let a caller forge arbitrary IPC responses. This only ever
  // sends the one wake payload shape AppScheduler produces, to a sandbox
  // that scheduler itself just created or already knows about.
  function dispatchBackgroundWake(sandboxId, payload) {
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox || !sandbox.webview) return false;
    respond(sandbox.webview, 'nova:background:wake', generateRequestId(), payload || {});
    return true;
  }

  // Get active sandbox info by ID.
  function getSandbox(sandboxId) {
    return activeSandboxes.get(sandboxId) || null;
  }

  // Keep a sandbox's webview (and the process behind it) alive after its
  // window has been closed, for apps holding system:background:live.
  //
  // This does NOT touch activeSandboxes, the API bridge, or any of the
  // sandbox's live state (WebSocket connections, event subscriptions,
  // etc.) — none of that is torn down, unlike a real destroy(). All this
  // does is reparent the webview element out of the closing window's DOM
  // subtree (which is about to be removed) into the hidden
  // #background-app-host, so the element survives `state.element.remove()`
  // and keeps running invisibly.
  function detachToBackground(sandboxId) {
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox) return false;

    const host = document.getElementById('background-app-host');
    if (!host) {
      log('warn', `detachToBackground: #background-app-host not found, cannot keep ${sandboxId} alive`);
      return false;
    }

    const webview = sandbox.webview;
    if (webview && webview.parentNode !== host) {
      host.appendChild(webview);
    }

    sandbox.backgrounded = true;
    sandbox.backgroundedAt = new Date().toISOString();
    // Distinct from backgrounded/backgroundedAt: this never gets cleared
    // by reattachFromBackground(), so wm.js can tell "first time going to
    // background" (show the 'started running' toast) apart from "resuming
    // background mode after a reattach-then-close cycle" (skip the toast —
    // it never actually stopped).
    sandbox.everBackgrounded = true;
    // windowId no longer refers to a live window once the window is gone —
    // keep the old value around under a different key for diagnostics
    // (Inspector, EventLog) rather than silently dropping it.
    sandbox.lastWindowId = sandbox.windowId;
    sandbox.windowId = null;

    log('debug', `Detached sandbox ${sandboxId} to background host`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppSandbox', category: 'security', severity: 'info', message: `${sandbox.appId} kept alive in background`, data: { appId: sandbox.appId, sandboxId } });
    }
    return true;
  }

  // Fully stop a backgrounded sandbox — the Terminate action's actual
  // effect. This is just destroy(): once a sandbox is in the background
  // host rather than a window, ending it is identical to a normal
  // teardown, since there's no window to also close.
  function terminateBackground(sandboxId) {
    return destroy(sandboxId);
  }

  // Move a backgrounded sandbox's webview back into a freshly-created
  // window's content area, and clear its backgrounded state. This is the
  // counterpart to detachToBackground() — without it, reopening an app
  // that's currently alive in the background just launches a second,
  // independent sandbox via the normal launch() path, leaving the
  // original running invisibly with two instances of the same app now
  // open (one live in #background-app-host, one in the new window).
  //
  // The webview element itself, its IPC bridge (setupAPIBridge is keyed
  // to the webview/sandboxId, not to any particular window state), and
  // its in-page JS state all survive the move untouched — only the DOM
  // parent changes. What we do need to refresh is sandbox.state and
  // sandbox.windowId, since detachToBackground() nulled/staled those when
  // the original window closed, and closeWindow() (if this window closes
  // again later) reads the window's own state.appId, not the sandbox's,
  // so this mainly keeps AppSandbox's own bookkeeping (Inspector,
  // getAllSandboxes()) accurate rather than gating any security check.
  function reattachFromBackground(sandboxId, container, state) {
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox || !sandbox.webview) return false;
    if (!container) return false;

    container.innerHTML = '';
    container.appendChild(sandbox.webview);

    sandbox.backgrounded = false;
    sandbox.backgroundedAt = null;
    sandbox.state = state;
    sandbox.windowId = state?.id;
    // Deliberately NOT resetting wantsBackgroundLive here. The process
    // never stopped and its intent to stay alive was already established
    // this continuous session (via nova.stayAliveInBackground()) — that
    // doesn't need to be re-asked just because the user glanced at the
    // window and closed it again. Resetting it would force every
    // reattach-then-close cycle to silently drop back to foreground-only,
    // which is a worse failure mode than the one this whole feature
    // exists to prevent: an app the user believes is still running
    // quietly stops being kept alive with no signal that anything
    // changed. If an app wants OUT of background mode, it calls
    // nova.stayAliveInBackground(false) itself.

    log('debug', `Reattached sandbox ${sandboxId} from background host to window ${state?.id}`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppSandbox', category: 'security', severity: 'info', message: `${sandbox.appId} reattached from background`, data: { appId: sandbox.appId, sandboxId, windowId: state?.id } });
    }
    return true;
  }

  // Get all active sandboxes as an array.
  function getAllSandboxes() {
    // Spread the map key in as `sandboxId` on each entry — callers like
    // WM.closeWindow() need to look up a sandbox by windowId/appId and then
    // act on that specific instance (detachToBackground/terminateBackground),
    // and both of those take a sandboxId string, not the object itself.
    return Array.from(activeSandboxes.entries()).map(([sandboxId, sandbox]) => ({ sandboxId, ...sandbox }));
  }

  // Clear the on-disk storage partitions for a given app id
  // (persist:app_<appId> and persist:app_<appId>_webcontent). This is a
  // separate Chromium storage partition from the host window's
  // localStorage/IndexedDB/OPFS, and from the app's FS/OPFS data
  // folder cleaned up elsewhere — none of those touch these partitions.
  //
  // Callers that fully remove an app's data (uninstall, "wipe all
  // data", factory reset) must call this too, or the app's cookies,
  // IndexedDB, cache, and nested-site browser data survive on disk.
  //
  // Safe to call even if the app was never launched (partition simply
  // doesn't exist yet, and gets created+immediately-cleared, which is
  // harmless).
  async function clearAppPartitionsByName(appId, partitionNames) {
    if (!appId) return;

    // clearData() only actually reaches a partition's real storage once a
    // webview on that partition has completed a genuine same-origin
    // navigation — about:blank never establishes a session against this
    // partition, so clearData silently no-ops against it. So we register
    // a minimal blank page through the same /api/apps/serve/register
    // mechanism real app launches use (see loadAppContent above), giving
    // the webview a real same-origin page inside the correct partition
    // before calling clearData.
    let baseUrl;
    try {
      const sandboxId = `sandbox_clr_${appId.replace(/[^\w.-]/g, '_')}_${Date.now()}`;
      // Use encodeBase64Utf8 rather than bare btoa for consistency with the
      // rest of this module — btoa throws on non-Latin1 input, and even
      // though this particular payload is ASCII-only today, the helper is
      // the convention everywhere else.
      const files = { 'index.html': encodeBase64Utf8('<!doctype html><html><body></body></html>') };
      const regRes = await fetch('/api/apps/serve/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId, files }),
      });
      if (!regRes.ok) throw new Error(`register failed: ${regRes.status}`);
      ({ baseUrl } = await regRes.json());
    } catch {
      // Registration failed — fall back to about:blank rather than
      // hard-failing; clearData will likely no-op, but this keeps the
      // caller's Promise resolving instead of hanging or throwing.
      baseUrl = null;
    }

    const clearPartition = partitionName => new Promise(resolve => {
      const wv = document.createElement('webview');
      wv.setAttribute('partition', `persist:${partitionName}`);
      wv.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none;';
      // Correct key set for this NW.js build's <webview> clearData(), confirmed
      // by testing against real data: 'filesystem' must be 'fileSystems'
      // (capitalized S), and 'serviceWorkers'/'cacheStorage' are rejected
      // outright on this build ("Unexpected property") — the webview tag's
      // ClearDataTypeSet here is a narrower, older subset than the full
      // chrome.browsingData schema.
      const clearTypes = { appcache: true, cache: true, cookies: true, fileSystems: true, indexedDB: true, localStorage: true, webSQL: true };
      // settled flag guards against the loadstop clearData callback and
      // the safety timeout both firing — the second call would otherwise
      // try to wv.remove() an already-removed element (caught by the
      // try/catch, but noisy in logs and conceptually wrong).
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        try { wv.remove(); } catch { /* already removed */ }
        resolve();
      };
      wv.addEventListener('loadstop', () => {
        try { wv.clearData({}, clearTypes, finish); } catch { finish(); }
      });
      wv.addEventListener('loadabort', finish);
      document.body.appendChild(wv);
      wv.src = baseUrl ? (window.location.origin + baseUrl + '/index.html') : 'about:blank';
      setTimeout(finish, CLEAR_PARTITION_TIMEOUT_MS);
    });

    await Promise.all(partitionNames.map(clearPartition));
  }

  async function clearAppExecutionPartition(appId) {
    return clearAppPartitionsByName(appId, [`app_${appId}`]);
  }

  async function clearAppPartition(appId) {
    return clearAppPartitionsByName(appId, [
      `app_${appId}`,
      `app_${appId}_webcontent`,
    ]);
  }

  // Clear storage partitions for multiple apps in parallel. Used by
  // bulk operations (wipe all data, factory reset).
  function clearAppPartitions(appIds) {
    return Promise.all((appIds || []).map(clearAppPartition)).then(() => {});
  }

  // Public API

  return {
    createSandbox,
    launch,
    launchHome,
    destroy,
    getSandbox,
    getAllSandboxes,
    clearAppPartition,
    clearAppPartitions,
    // storageClear/clearAllStorage clear nova:storage (a separate,
    // host-shell-side IndexedDB keyed by [appId, key] — see storageClear
    // above) which clearAppPartition(s) never touches, since that only
    // wipes the webview's own persist:app_<appId> partition. Uninstall
    // and factory-reset callers need both: clearAppPartition(appId) for
    // the app and nested-site webview partitions, storageClear(appId) or clearAllStorage()
    // for this store.
    storageClear,
    clearAllStorage,
    detachToBackground,
    terminateBackground,
    dispatchBackgroundWake,
    reattachFromBackground,
    getRootAuditLog: getRootAuditEntries,
    subscribeRootAudit(callback) {
      if (typeof callback !== 'function') throw new TypeError('Root audit subscriber must be a function');
      rootAuditSubscribers.add(callback);
      return () => rootAuditSubscribers.delete(callback);
    },
    reloadAfterRootRevocation,

    // Internal exports for testing and advanced consumers. Not covered by
    // stability guarantees — do not depend on these in production code.
    _internal: {
      escapeHtml,
      sanitizeSandboxAttr,
      injectCapabilityShim,
      encodeBase64Utf8,
      decodeBase64Utf8,
      generateRequestId,
      resolveAndClassifyUrl,
      isInternalHost,
      parsePositiveInt,
      validateStorageKey,
      handleAPICall,
      API_HANDLERS,
      buildCapabilityShim,
      deferPackagedScripts,
      buildIsolatedTransportScript,
      isNestedWebviewPermitted,
      RELAXED_CSP_META,
      // Test-only helpers for resetting module state between tests.
      _resetState() {
        activeSandboxes.clear();
        rootExecutionApps.clear();
        rootAuditSubscribers.clear();
        rootRevocationReloadScheduled = false;
        rootAuditEntries = null;
        if (rootAuditPersistTimer) rootAuditClearTimeout(rootAuditPersistTimer);
        rootAuditPersistTimer = null;
        eventSubscriptions.clear();
        openDialogs.clear();
        shareDialogs.clear();
        notifRateLimitLog.clear();
        crossAppLaunchRateLimits.clear();
        appearanceSetRateLimits.clear();
        storageDbPromise = null;
        _isolatedTransportScriptCache = null;
      },
      _activeSandboxes: activeSandboxes,
      _eventSubscriptions: eventSubscriptions,
      _openDialogs: openDialogs,
    },
  };
})();

// CommonJS export for Node.js test runners and bundlers that expect it.
// In the browser, the module attaches as a global `AppSandbox`.
if (typeof window !== 'undefined') {
  window.AppSandbox = AppSandbox;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AppSandbox;
}