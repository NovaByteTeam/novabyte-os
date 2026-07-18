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

  // ------------------------------------------------------------------
  // Module state
  // ------------------------------------------------------------------

  // Active sandboxes keyed by sandboxId. Each value holds the webview element,
  // app metadata, window state, WebSocket connections, and a cleanup function.
  const activeSandboxes = new Map();

  // Event subscriptions keyed by sandboxId, then event name -> handler.
  // Kept in a separate map so cleanup can iterate without touching the sandbox
  // object's other fields.
  const eventSubscriptions = new Map();

  // Open file dialogs keyed by sandboxId, so we can tear them down when a
  // sandbox is destroyed mid-dialog (prevents orphaned overlays in the DOM).
  const openDialogs = new Map();

  // ------------------------------------------------------------------
  // Constants
  // ------------------------------------------------------------------

  const API_PREFIX = 'nova:';
  const STORAGE_KEY_PREFIX = 'nova_storage_';
  // Allow word chars, dash, dot, space. Anything else (slashes, colons) is
  // rejected to prevent key injection across app namespaces.
  const STORAGE_KEY_REGEX = /^[\w\-. ]+$/;
  const STORAGE_VALUE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB per single value
  const CLIPBOARD_HISTORY_MAX = 30;
  const ALLOWED_HTTP_METHODS = new Set([
    'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
  ]);
  const ALLOWED_WEB_PROTOCOLS = new Set(['http:', 'https:']);
  // Hostnames that count as "internal" for permission gating. Both bracketed
  // ([::1]) and unbracketed (::1) IPv6 forms are accepted.
  const INTERNAL_HOSTS = new Set([
    'localhost', '127.0.0.1', '::1', '[::1]', 'api.novabyte.internal',
  ]);
  const DEFAULT_WINDOW_WIDTH = 800;
  const DEFAULT_WINDOW_HEIGHT = 600;
  const MIN_WINDOW_DIMENSION = 100;

  // -- Notification gateway --
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

  // ------------------------------------------------------------------
  // Utility helpers
  // ------------------------------------------------------------------

  /**
   * Generate a unique request ID for IPC correlation. Prefers crypto.randomUUID
   * when available; falls back to timestamp + random otherwise.
   */
  function generateRequestId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `req_${crypto.randomUUID()}`;
    }
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  /**
   * Escape a string for safe HTML interpolation. Used whenever app-supplied
   * metadata (name, author, etc.) is embedded into the default shell or error
   * page. Without this, a malicious package could inject <script> tags.
   */
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  /**
   * UTF-8 safe base64 encoding. btoa() throws on non-Latin1 characters, so app
   * HTML containing emoji or CJK content would crash the loader. We go through
   * TextEncoder so the full Unicode range survives the round-trip.
   */
  function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    if (typeof bytes.toBase64 === 'function') {
      return bytes.toBase64();
    }
    // Legacy fallback for runtimes without Uint8Array.toBase64 (pre-ES2026).
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  /** Inverse of encodeBase64Utf8. */
  function decodeBase64Utf8(b64) {
    if (typeof Uint8Array.fromBase64 === 'function') {
      return new TextDecoder().decode(Uint8Array.fromBase64(b64));
    }
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /**
   * Structured logger. Debug-level messages are gated on a window flag so
   * production builds stay quiet unless an operator opts in.
   */
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

  /**
   * Resolve a URL string against the current origin and classify it as
   * internal or external. Handles protocol-relative URLs (//host/path) safely
   * by always resolving through new URL(rawUrl, window.location.origin).
   *
   * Without this, an app could pass "//evil.com/foo" to net:fetch and have it
   * treated as internal because the original check only looked at the leading
   * "/" character.
   */
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
    return {
      valid: true,
      url: resolved.href,
      isInternal: isInternalHost(resolved.hostname),
    };
  }

  function isInternalHost(hostname) {
    return INTERNAL_HOSTS.has(hostname) || INTERNAL_HOSTS.has(hostname.toLowerCase());
  }

  /**
   * Validate that a value is a positive integer within optional bounds.
   * Returns the parsed integer or the fallback when invalid.
   */
  function parsePositiveInt(value, fallback, min = 1) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return parsed;
  }

  // ------------------------------------------------------------------
  // Notification gateway helpers
  // ------------------------------------------------------------------

  /**
   * Strictly whitelist and clamp an app-supplied notification payload before
   * it ever reaches Notify.show(). This is the actual security boundary:
   * Notify.show() itself will call `action` if it's a function (trusted
   * first-party callers rely on that), so nothing but plain, bounded data
   * may cross from a sandboxed app into that call.
   */
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
      appName,
      appId,
      icon,
      action,
      actionLabel,
      category: 'app',
    };
  }

  /**
   * Sliding-window rate limit: returns true if `appId` is still under
   * NOTIF_RATE_LIMIT_MAX notifications within the last
   * NOTIF_RATE_LIMIT_WINDOW_MS, recording this attempt if so. Returns false
   * (and does not record) if the app is over the limit.
   */
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

  // ------------------------------------------------------------------
  // Response helpers
  // ------------------------------------------------------------------

  /**
   * Send a response back to the sandboxed app.
   *
   * <webview> guests have no parent/embedder window reference at all
   * (window.parent === window for a <webview> guest — confirmed
   * empirically, and matches spec: a window with no parent has
   * parent === itself). postMessage from the host to some captured
   * "source" reference was never reachable, because no such reference is
   * ever set — the guest can't postMessage to the host either, for the
   * same reason (see setupAPIBridge, which now reads guest->host messages
   * via the webview's 'consolemessage' DOM event instead).
   *
   * For host->guest, webview.executeScript({mainWorld:true}, ...) is a
   * real, confirmed-working NW.js API already used elsewhere in this
   * codebase (see browser.js's URL/title polling and context-menu
   * injection). This pushes the response directly into a well-known
   * array on the guest's real window (window.__novaInbox), which the
   * guest's shim poller drains.
   *
   * Data is passed as base64-encoded JSON rather than interpolated
   * directly into the injected code string. JSON.stringify does not
   * escape backticks or `${...}`, so an app-supplied value living inside
   * `result` (e.g. an echoed filename) could otherwise break out of the
   * template literal below and run arbitrary code in the guest's own
   * context. Base64's alphabet (A-Za-z0-9+/=) can't contain any of those
   * characters, so splicing it in needs no further escaping.
   */
  function respond(webview, type, requestId, result, error = null) {
    try {
      const json = JSON.stringify({ type: `${type}:response`, requestId, result, error });
      const b64 = Buffer.from(json, 'utf8').toString('base64');
      // The injected code returns true on success / false on a caught parse
      // error, so the executeScript callback's results array actually means
      // something — unlike before, where it was being misread as an (err)
      // argument (executeScript's callback is (results), not (err); the
      // injected push statement returns undefined either way, so that
      // logged a false "Failed to respond" error on every single call,
      // success included).
      const code = '(function(){try{'
        + 'window.__novaInbox=window.__novaInbox||[];'
        + 'window.__novaInbox.push(JSON.parse(atob("' + b64 + '")));'
        + 'return true;'
        + '}catch(e){return false;}})();';
      webview.executeScript({ code, mainWorld: true }, (results) => {
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
    respond(webview, type, requestId, null, { code, message });
  }

  // ------------------------------------------------------------------
  // Filesystem helpers
  // ------------------------------------------------------------------

  /** Resolve a payload (with either `path` or `id`) to a file node. */
  function resolveFile(payload, appId) {
    const { path, id } = payload ?? {};
    if (id) return FS.files.get(id) || null;
    if (path) {
      const rewritten = String(path).startsWith('/data/')
        ? '/data/' + String(appId || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_') + String(path).slice('/data'.length)
        : path;
      return FS.getByPath(rewritten);
    }
    return null;
  }

  /** Convert a file node to a safe serializable object. */
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

  // ------------------------------------------------------------------
  // File dialog
  // ------------------------------------------------------------------

  /**
   * Show a file open/save dialog. The dialog is a custom overlay so it matches
   * the NovaByte visual style. The visuals are kept identical to the original
   * implementation — only internal cleanup wiring has changed.
   */
  function showFileDialog(mode, webview, type, requestId, app, payload) {
    const overlay = document.createElement('div');
    overlay.className = 'nsec-overlay';
    overlay.style.zIndex = '100001';

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
      const children = FS.listDir(currentFolderId);

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
        if (!node || node.type === 'folder') return;
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
          respondError(webview, type, requestId, 'WRITE_ERROR', e.message || 'Failed to write file');
        }
      }
    });

    // Closes the dialog overlay and unregisters it from the openDialogs map
    // so destroy() knows it's no longer pending.
    function closeDialog() {
      overlay.remove();
      const sandboxId = webview.dataset.sandboxId;
      if (sandboxId && openDialogs.get(sandboxId) === overlay) {
        openDialogs.delete(sandboxId);
      }
    }

    btnContainer.appendChild(cancelBtn);
    btnContainer.appendChild(confirmBtn);
    dialog.appendChild(btnContainer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Track the open dialog so destroy() can clean it up if the sandbox is
    // torn down while the user is still picking a file.
    const sandboxId = webview.dataset.sandboxId;
    if (sandboxId) openDialogs.set(sandboxId, overlay);

    renderBreadcrumb();
    renderFileList();

    if (mode === 'save' && filenameInput) {
      setTimeout(() => filenameInput.focus(), 50);
    }
  }

  // ------------------------------------------------------------------
  // IPC handlers
  // ------------------------------------------------------------------
  //
  // Each handler is a named async function that receives a context object
  // with { payload, requestId, app, webview, sandbox }. Handlers that respond
  // synchronously call respond/respondError before returning; async handlers
  // (geolocation, websocket, file dialog) return without responding and send
  // the response later from a callback.

  // -- Filesystem --

  async function handleFsRead({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:read', app.id)) {
      return respondError(webview, 'nova:fs:read', requestId, 'PERMISSION_DENIED', 'fs:read permission required');
    }
    const node = resolveFile(payload, app.id);
    if (!node) return respondError(webview, 'nova:fs:read', requestId, 'NOT_FOUND', 'File or folder not found');
    if (node.type === 'folder') {
      const children = FS.listDir(node.id);
      return respond(webview, 'nova:fs:read', requestId, {
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
    return respond(webview, 'nova:fs:read', requestId, {
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

  async function handleFsWrite({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:write', app.id)) {
      return respondError(webview, 'nova:fs:write', requestId, 'PERMISSION_DENIED', 'fs:write permission required');
    }
    const { path, content, mimeType } = payload ?? {};
    if (!path || content === undefined) {
      return respondError(webview, 'nova:fs:write', requestId, 'INVALID_ARGS', 'path and content are required');
    }
    let resolvedPath = String(path);
    if (resolvedPath.startsWith('/data/')) {
      resolvedPath = '/data/' + String(app.id || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_') + resolvedPath.slice('/data'.length);
    }
    let node = FS.getByPath(resolvedPath);
    if (node) {
      if (node.type === 'folder') {
        return respondError(webview, 'nova:fs:write', requestId, 'INVALID_OPERATION', 'Cannot write to a folder');
      }
      await FS.writeFile(node.id, content);
      return respond(webview, 'nova:fs:write', requestId, { success: true, id: node.id });
    }
    const parts = resolvedPath.split('/').filter(Boolean);
    const fileName = parts.pop();
    const parentPath = '/' + parts.join('/');
    const parent = parts.length > 0 ? FS.getByPath(parentPath) : FS.files.get(FS.rootId);
    if (!parent || parent.type !== 'folder') {
      return respondError(webview, 'nova:fs:write', requestId, 'NOT_FOUND', 'Parent folder not found');
    }
    const newNode = await FS.createFile(
      parent.id,
      fileName,
      typeof content === 'string' ? content : JSON.stringify(content),
      mimeType || 'text/plain'
    );
    return respond(webview, 'nova:fs:write', requestId, {
      success: true,
      id: newNode.id,
      path: FS.getPath(newNode.id),
    });
  }

  async function handleFsDelete({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:delete', app.id)) {
      return respondError(webview, 'nova:fs:delete', requestId, 'PERMISSION_DENIED', 'fs:delete permission required');
    }
    const node = resolveFile(payload, app.id);
    if (!node) return respondError(webview, 'nova:fs:delete', requestId, 'NOT_FOUND', 'File not found');
    if (payload.permanent) {
      await FS.permanentDelete(node.id);
    } else {
      await FS.deleteToTrash(node.id);
    }
    return respond(webview, 'nova:fs:delete', requestId, { success: true });
  }

  async function handleFsList({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:read', app.id)) {
      return respondError(webview, 'nova:fs:list', requestId, 'PERMISSION_DENIED', 'fs:read permission required');
    }
    const node = resolveFile(payload, app.id);
    if (!node) return respondError(webview, 'nova:fs:list', requestId, 'NOT_FOUND', 'Folder not found');
    if (node.type !== 'folder') {
      return respondError(webview, 'nova:fs:list', requestId, 'INVALID_OPERATION', 'Path is not a folder');
    }
    const children = FS.listDir(node.id);
    return respond(webview, 'nova:fs:list', requestId, {
      success: true,
      path: FS.getPath(node.id),
      files: children.map(c => ({
        id: c.id, name: c.name, type: c.type, mimeType: c.mimeType,
        size: c.size, modified: c.modified, created: c.created,
      })),
    });
  }

  async function handleFsMkdir({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:write', app.id)) {
      return respondError(webview, 'nova:fs:mkdir', requestId, 'PERMISSION_DENIED', 'fs:write permission required');
    }
    const { path, name } = payload ?? {};
    if (!name) {
      return respondError(webview, 'nova:fs:mkdir', requestId, 'INVALID_ARGS', 'name is required');
    }
    let resolvedPath = String(path || '');
    if (resolvedPath.startsWith('/data/')) {
      resolvedPath = '/data/' + String(app.id || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_') + resolvedPath.slice('/data'.length);
    }
    let parent;
    if (resolvedPath) {
      parent = FS.getByPath(resolvedPath);
    } else {
      parent = FS.files.get(FS.rootId);
    }
    if (!parent || parent.type !== 'folder') {
      return respondError(webview, 'nova:fs:mkdir', requestId, 'NOT_FOUND', 'Parent folder not found');
    }
    const newFolder = await FS.createFolder(parent.id, name);
    return respond(webview, 'nova:fs:mkdir', requestId, {
      success: true,
      id: newFolder.id,
      path: FS.getPath(newFolder.id),
    });
  }

  async function handleFsStat({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:read', app.id)) {
      return respondError(webview, 'nova:fs:stat', requestId, 'PERMISSION_DENIED', 'fs:read permission required');
    }
    const node = resolveFile(payload, app.id);
    if (!node) return respondError(webview, 'nova:fs:stat', requestId, 'NOT_FOUND', 'File not found');
    return respond(webview, 'nova:fs:stat', requestId, { success: true, stat: fileToJSON(node) });
  }

  async function handleFsRename({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:write', app.id)) {
      return respondError(webview, 'nova:fs:rename', requestId, 'PERMISSION_DENIED', 'fs:write permission required');
    }
    const node = resolveFile(payload, app.id);
    if (!node) return respondError(webview, 'nova:fs:rename', requestId, 'NOT_FOUND', 'File not found');
    if (!payload.name) {
      return respondError(webview, 'nova:fs:rename', requestId, 'INVALID_ARGS', 'name is required');
    }
    await FS.rename(node.id, payload.name);
    return respond(webview, 'nova:fs:rename', requestId, { success: true, name: payload.name });
  }

  async function handleFsMove({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:write', app.id)) {
      return respondError(webview, 'nova:fs:move', requestId, 'PERMISSION_DENIED', 'fs:write permission required');
    }
    const node = resolveFile(payload, app.id);
    if (!node) return respondError(webview, 'nova:fs:move', requestId, 'NOT_FOUND', 'File not found');
    let destPath = String(payload.destPath || '');
    if (destPath.startsWith('/data/')) {
      destPath = '/data/' + String(app.id || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_') + destPath.slice('/data'.length);
    }
    const destParent = destPath ? FS.getByPath(destPath) : null;
    if (!destParent || destParent.type !== 'folder') {
      return respondError(webview, 'nova:fs:move', requestId, 'NOT_FOUND', 'Destination folder not found');
    }
    await FS.move(node.id, destParent.id);
    return respond(webview, 'nova:fs:move', requestId, { success: true, path: FS.getPath(node.id) });
  }

  // -- Notifications --

  async function handleNotificationsShow({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:notifications', app.id)) {
      return respondError(webview, 'nova:notifications:show', requestId, 'PERMISSION_DENIED', 'device:notifications permission required');
    }
    // Notify may be absent in headless test environments. Report UNAVAILABLE
    // rather than silently claiming success — apps deserve to know.
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

  // -- Settings --

  async function handleSettingsGet({ payload, requestId, app, webview }) {
    // system:info gates read access — otherwise any app could read credentials
    // or other sensitive settings keys.
    if (!AppPermissionManager.isGranted('system:info', app.id)) {
      return respondError(webview, 'nova:settings:get', requestId, 'PERMISSION_DENIED', 'system:info permission required');
    }
    const value = OS?.settings?.get(payload.key);
    return respond(webview, 'nova:settings:get', requestId, { success: true, value });
  }

  async function handleSettingsSet({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:settings', app.id)) {
      return respondError(webview, 'nova:settings:set', requestId, 'PERMISSION_DENIED', 'system:settings permission required');
    }
    OS?.settings?.set(payload.key, payload.value);
    return respond(webview, 'nova:settings:set', requestId, { success: true });
  }

  // -- Permission requests --

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
      return respondError(webview, 'nova:request-permission', requestId, 'ERROR', e.message || 'Permission request failed');
    }
  }

  // -- Window management --
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
    if (windowId) {
      const state = OS.windows.get(windowId);
      if (state && state.titleText) {
        state.titleText.textContent = String(payload?.title ?? '');
      }
    }
    return respond(webview, 'nova:window:setTitle', requestId, { success: true });
  }

  async function handleWindowResize({ payload, requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId) {
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
    const state = windowId ? OS.windows.get(windowId) : null;
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

  // -- Clipboard --

  async function handleClipboardRead({ requestId, app, webview }) {
    // Clipboard is gated on fs:read — intentional design choice from the
    // original code (clipboard contents often include file paths).
    if (!AppPermissionManager.isGranted('fs:read', app.id)) {
      return respondError(webview, 'nova:clipboard:read', requestId, 'PERMISSION_DENIED', 'fs:read permission required for clipboard access');
    }
    return respond(webview, 'nova:clipboard:read', requestId, {
      success: true,
      data: OS.clipboard || null,
    });
  }

  async function handleClipboardWrite({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:read', app.id)) {
      return respondError(webview, 'nova:clipboard:write', requestId, 'PERMISSION_DENIED', 'fs:read permission required for clipboard access');
    }
    OS.clipboard = payload.data || '';
    if (!OS.clipboardHistory) OS.clipboardHistory = [];
    if (typeof payload.data === 'string' && !OS.clipboardHistory.includes(payload.data)) {
      OS.clipboardHistory.unshift(payload.data);
      if (OS.clipboardHistory.length > CLIPBOARD_HISTORY_MAX) OS.clipboardHistory.pop();
    }
    return respond(webview, 'nova:clipboard:write', requestId, { success: true });
  }

  // -- Downloads --
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
  // No standing permission is required for this — the native save
  // dialog itself is the control: the app can propose a filename and
  // bytes, but the user always sees and confirms the real destination
  // before anything touches disk. That mirrors how a normal browser
  // download works, and is a deliberate departure from the fs:write
  // pattern above, which writes into novabyte-os's own virtual FS
  // without a per-write prompt.
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

  // NOTE (unresolved, worth testing for specifically): input.click() below
  // runs in the top-level host window, which never received the user's
  // actual click — that happened inside the <webview> guest, and the
  // console.log-based IPC transport carries no user-activation state
  // across that boundary the way includeUserActivation on postMessage
  // was meant to (that mechanism is gone now, since postMessage never
  // reached the host anyway). If the save dialog still doesn't appear
  // after this fix, Chromium silently blocking the synthetic click due to
  // missing user activation in the host frame is the next thing to check
  // — that would be a different, real problem, not a leftover transport bug.
  async function handleDownload({ payload, requestId, app, webview }) {
    const { filename, mimeType, base64Data } = payload ?? {};
    if (typeof base64Data !== 'string' || !base64Data) {
      return respondError(webview, 'nova:download', requestId, 'INVALID_ARGS', 'base64Data is required');
    }
    let buffer;
    try {
      buffer = Buffer.from(base64Data, 'base64');
    } catch (e) {
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

      const cleanup = () => { input.remove(); };

      input.addEventListener('change', () => {
        const savePath = input.value;
        cleanup();
        if (!savePath) {
          respond(webview, 'nova:download', requestId, { success: false, cancelled: true });
          return resolve();
        }
        require('fs').writeFile(savePath, buffer, (err) => {
          if (err) {
            respondError(webview, 'nova:download', requestId, 'IO_ERROR', err.message || 'Failed to write file');
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
            respond(webview, 'nova:download', requestId, { success: true });
          }
          resolve();
        });
      }, { once: true });

      // 'cancel' fires if the user dismisses the dialog without choosing a path.
      input.addEventListener('cancel', () => {
        cleanup();
        respond(webview, 'nova:download', requestId, { success: false, cancelled: true });
        resolve();
      }, { once: true });

      input.click();
    });
  }


  // -- App lifecycle --

  async function handleAppLaunch({ payload, requestId, app, webview }) {
    // system:apps gates cross-app launches — otherwise any app could spawn
    // any other app (privilege escalation surface).
    if (!AppPermissionManager.isGranted('system:apps', app.id)) {
      return respondError(webview, 'nova:app:launch', requestId, 'PERMISSION_DENIED', 'system:apps permission required');
    }
    const { appId, options } = payload ?? {};
    if (!appId) {
      return respondError(webview, 'nova:app:launch', requestId, 'INVALID_ARGS', 'appId is required');
    }
    if (!OS.settings.get('devMode')) {
      const target = OS.apps[appId];
      if (target?.devOnly) {
        return respondError(webview, 'nova:app:launch', requestId, 'PERMISSION_DENIED', 'Developer Mode must be enabled to launch this app');
      }
    }
    try {
      if (typeof WM === 'undefined' || typeof WM.createWindow !== 'function') {
        return respondError(webview, 'nova:app:launch', requestId, 'UNAVAILABLE', 'Window manager not available');
      }
      const win = WM.createWindow(appId, options || {});
      return respond(webview, 'nova:app:launch', requestId, {
        success: !!win,
        windowId: win ? win.id : null,
      });
    } catch (e) {
      return respondError(webview, 'nova:app:launch', requestId, 'ERROR', e.message);
    }
  }

  async function handleAppInfo({ requestId, app, webview }) {
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

  // -- Events --

  async function handleEventsSubscribe({ payload, requestId, app, webview, sandbox }) {
    if (!AppPermissionManager.isGranted('system:events', app.id)) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'PERMISSION_DENIED', 'system:events permission required');
    }
    const { event } = payload ?? {};
    if (!event) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'INVALID_ARGS', 'event name is required');
    }
    const subs = eventSubscriptions.get(webview.dataset.sandboxId);
    if (subs && subs.has(event)) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'ALREADY_SUBSCRIBED', `Already subscribed to '${event}'`);
    }
    const handler = (data) => {
      respond(webview, 'nova:events:event', generateRequestId(), { event, data });
    };
    OS?.events?.on(event, handler);
    if (subs) subs.set(event, handler);
    return respond(webview, 'nova:events:subscribe', requestId, { success: true, subscribed: event });
  }

  async function handleEventsUnsubscribe({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:events', app.id)) {
      return respondError(webview, 'nova:events:unsubscribe', requestId, 'PERMISSION_DENIED', 'system:events permission required');
    }
    const { event } = payload ?? {};
    const subs = eventSubscriptions.get(webview.dataset.sandboxId);
    if (subs && subs.has(event)) {
      const handler = subs.get(event);
      OS?.events?.off(event, handler);
      subs.delete(event);
    }
    return respond(webview, 'nova:events:unsubscribe', requestId, { success: true, unsubscribed: event });
  }

  // -- Network: fetch --

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
    try {
      let res, resBody, resStatus, resStatusText, resHeaders;

      if (classified.isInternal) {
        // Same-origin requests don't hit CORS, so go direct.
        res = await fetch(classified.url, {
          method: safeMethod,
          headers: headers || {},
          body: body || null,
        });
        resBody = await res.text();
        resStatus = res.status;
        resStatusText = res.statusText;
        resHeaders = Object.fromEntries(res.headers.entries());
      } else {
        // External requests go through the server-side proxy. A direct fetch()
        // from this document would be subject to the target server's CORS
        // policy (most external APIs don't allow browser-origin requests),
        // so we hand the request to /api/proxy, which makes it server-to-server.
        const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
        const proxyRes = await fetch('/api/proxy', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({
            url: classified.url,
            method: safeMethod,
            headers: headers || {},
            body: body || null,
          }),
        });
        const proxyJson = await proxyRes.json();
        if (!proxyRes.ok) {
          return respondError(webview, 'nova:net:fetch', requestId, 'NETWORK_ERROR', proxyJson?.error || `Proxy request failed (${proxyRes.status})`);
        }
        resStatus = proxyJson.status;
        resStatusText = proxyJson.statusText;
        resHeaders = proxyJson.headers || {};
        resBody = proxyJson.body || '';
      }

      return respond(webview, 'nova:net:fetch', requestId, {
        success: true,
        status: resStatus,
        statusText: resStatusText,
        headers: resHeaders,
        body: resBody,
      });
    } catch (e) {
      return respondError(webview, 'nova:net:fetch', requestId, 'NETWORK_ERROR', e.message);
    }
  }

  // -- Network: WebSocket --

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
      return respondError(webview, 'nova:net:websocket', requestId, 'INVALID_ARGS', e.message);
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
    const wsState = sandbox?.wsConnections?.get(wsId);
    if (!wsState) {
      return respondError(webview, 'nova:net:ws:send', requestId, 'NOT_FOUND', 'WebSocket connection not found');
    }
    if (wsState.ws.readyState !== WebSocket.OPEN) {
      return respondError(webview, 'nova:net:ws:send', requestId, 'INVALID_STATE', 'WebSocket is not open');
    }
    wsState.ws.send(data ?? '');
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

  // -- Storage --
  //
  // All keys are namespaced under nova_storage_<appId>_ so apps can only see
  // their own keys. Key characters are restricted to prevent path-like
  // injection that could confuse the namespace.

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
    const key = STORAGE_KEY_PREFIX + app.id + '_' + rawKey;
    try {
      const value = localStorage.getItem(key);
      return respond(webview, 'nova:storage:get', requestId, { success: true, value });
    } catch (e) {
      // localStorage can throw in private browsing or when storage is disabled.
      // Treat as "no value" rather than crashing the IPC call.
      return respond(webview, 'nova:storage:get', requestId, { success: true, value: null });
    }
  }

  async function handleStorageSet({ payload, requestId, app, webview }) {
    const rawKey = validateStorageKey(payload?.key);
    if (!rawKey) {
      return respondError(webview, 'nova:storage:set', requestId, 'INVALID_ARGS', 'Invalid storage key');
    }
    // Enforce a per-value size cap so a single call can't exhaust the host's
    // localStorage quota and break other apps on the same origin.
    const value = payload?.value ?? '';
    const valueBytes = new TextEncoder().encode(String(value)).length;
    if (valueBytes > STORAGE_VALUE_MAX_BYTES) {
      return respondError(webview, 'nova:storage:set', requestId, 'STORAGE_FULL', `Value exceeds ${STORAGE_VALUE_MAX_BYTES} byte limit`);
    }
    const key = STORAGE_KEY_PREFIX + app.id + '_' + rawKey;
    try {
      localStorage.setItem(key, value);
      return respond(webview, 'nova:storage:set', requestId, { success: true });
    } catch (e) {
      return respondError(webview, 'nova:storage:set', requestId, 'STORAGE_FULL', 'Failed to write to storage');
    }
  }

  async function handleStorageDelete({ payload, requestId, app, webview }) {
    const rawKey = validateStorageKey(payload?.key);
    if (!rawKey) {
      return respondError(webview, 'nova:storage:delete', requestId, 'INVALID_ARGS', 'Invalid storage key');
    }
    const key = STORAGE_KEY_PREFIX + app.id + '_' + rawKey;
    try {
      localStorage.removeItem(key);
      return respond(webview, 'nova:storage:delete', requestId, { success: true });
    } catch (e) {
      return respondError(webview, 'nova:storage:delete', requestId, 'ERROR', e.message);
    }
  }

  async function handleStorageClear({ requestId, app, webview }) {
    try {
      const prefix = STORAGE_KEY_PREFIX + app.id + '_';
      // Collect first, mutate second — mutating during iteration would skip
      // entries because localStorage's indices shift on removal.
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) toRemove.push(k);
      }
      for (const k of toRemove) localStorage.removeItem(k);
      return respond(webview, 'nova:storage:clear', requestId, { success: true });
    } catch (e) {
      return respondError(webview, 'nova:storage:clear', requestId, 'ERROR', e.message);
    }
  }

  async function handleStorageKeys({ requestId, app, webview }) {
    try {
      const prefix = STORAGE_KEY_PREFIX + app.id + '_';
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) keys.push(k.slice(prefix.length));
      }
      return respond(webview, 'nova:storage:keys', requestId, { success: true, keys });
    } catch (e) {
      return respondError(webview, 'nova:storage:keys', requestId, 'ERROR', e.message);
    }
  }

  // -- Device: geolocation --

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
      (err) => respondError(webview, 'nova:device:geolocation', requestId, 'GEOLOCATION_ERROR', err.message),
      payload.options || {}
    );
  }

  // -- System info --

  async function handleSystemInfo({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:info', app.id)) {
      return respondError(webview, 'nova:system:info', requestId, 'PERMISSION_DENIED', 'system:info permission required');
    }
    return respond(webview, 'nova:system:info', requestId, {
      success: true,
      os: {
        version: OS.version,
        securityPatch: OS.securityPatch,
        username: OS.username,
        uptime: Date.now() - (OS._bootTime || Date.now()),
      },
    });
  }

  // -- Ready handshake --

  async function handleReady({ requestId, app, webview }) {
    const mgr = typeof AppPermissionManager !== 'undefined' ? AppPermissionManager : null;
    const granted = mgr
      ? (app.permissions || []).filter(p => mgr.isGranted(p, app.id))
      : (app.permissions || []);
    const optionalGranted = mgr
      ? (app.optionalPermissions || []).filter(p => mgr.isGranted(p, app.id))
      : (app.optionalPermissions || []);
    const payload = {
      success: true,
      appId: app.id,
      permissions: granted,
      optionalPermissions: optionalGranted,
      osVersion: OS.version,
      securityPatch: OS.securityPatch,
    };
    // Some apps (see the capability shim / createDefaultAppShell) read the
    // handshake fields directly off the top-level response object rather
    // than through the generic `result` wrapper. The guest-side shim's
    // inbox poller (see CAPABILITY_SHIM below) merges `result` fields onto
    // the top level of what it hands back to app code, so a single
    // respond() call covers both shapes — no separate legacy send needed.
    respond(webview, 'nova:ready', requestId, payload);
  }

  // -- File dialogs --

  async function handleDialogOpen({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:read', app.id)) {
      return respondError(webview, 'nova:dialog:open', requestId, 'PERMISSION_DENIED', 'fs:read permission required');
    }
    showFileDialog('open', webview, 'nova:dialog:open', requestId, app, payload);
    // Response is sent from the dialog's confirm/cancel handler.
  }

  async function handleDialogSave({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('fs:write', app.id)) {
      return respondError(webview, 'nova:dialog:save', requestId, 'PERMISSION_DENIED', 'fs:write permission required');
    }
    showFileDialog('save', webview, 'nova:dialog:save', requestId, app, payload);
  }

  // -- Audit: eval --
  //
  // Sent by the capability shim whenever an app calls eval(). We log it for
  // observability but don't block — the CSP allows unsafe-eval by design for
  // apps that genuinely need it. This is fire-and-forget; no response is sent.

  async function handleAuditEval({ app, payload }) {
    log('warn', `${app.name} called eval():`, payload?.preview);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({
        app: 'AppSandbox',
        category: 'security',
        severity: 'warn',
        message: `${app.name} called eval()`,
        data: { appId: app.id, preview: payload?.preview },
      });
    }
  }

  // ------------------------------------------------------------------
  // Handler table
  // ------------------------------------------------------------------
  //
  // Maps API type strings to their handler functions. Using a table instead
  // of a long if/else chain makes the dispatch O(1) and lets new APIs be
  // added by appending a single entry.

  const API_HANDLERS = {
    'nova:fs:read': handleFsRead,
    'nova:fs:write': handleFsWrite,
    'nova:fs:delete': handleFsDelete,
    'nova:fs:list': handleFsList,
    'nova:fs:mkdir': handleFsMkdir,
    'nova:fs:stat': handleFsStat,
    'nova:fs:rename': handleFsRename,
    'nova:fs:move': handleFsMove,
    'nova:notifications:show': handleNotificationsShow,
    'nova:notifications:clear': handleNotificationsClear,
    'nova:settings:get': handleSettingsGet,
    'nova:settings:set': handleSettingsSet,
    'nova:request-permission': handleRequestPermission,
    'nova:window:close': handleWindowClose,
    'nova:window:minimize': handleWindowMinimize,
    'nova:window:maximize': handleWindowMaximize,
    'nova:window:setTitle': handleWindowSetTitle,
    'nova:window:resize': handleWindowResize,
    'nova:window:getState': handleWindowGetState,
    'nova:clipboard:read': handleClipboardRead,
    'nova:clipboard:write': handleClipboardWrite,
    'nova:app:launch': handleAppLaunch,
    'nova:app:info': handleAppInfo,
    'nova:events:subscribe': handleEventsSubscribe,
    'nova:events:unsubscribe': handleEventsUnsubscribe,
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
    'nova:system:info': handleSystemInfo,
    'nova:ready': handleReady,
    'nova:dialog:open': handleDialogOpen,
    'nova:dialog:save': handleDialogSave,
    'nova:audit:eval': handleAuditEval,
    'nova:download': handleDownload,
  };

  /**
   * Dispatch an incoming IPC message to its handler. Catches sync throws and
   * async rejections so a single misbehaving handler can't take down the
   * bridge. Unknown types get an UNKNOWN_API error response.
   */
  async function handleAPICall(type, payload, requestId, app, webview, sandbox) {
    try {
      const handler = API_HANDLERS[type];
      if (!handler) {
        return respondError(webview, type, requestId, 'UNKNOWN_API', `Unknown API: ${type}`);
      }
      await handler({ payload, requestId, app, webview, sandbox });
    } catch (err) {
      log('error', `Error handling ${type}:`, err);
      respondError(webview, type, requestId, 'INTERNAL_ERROR', err.message || 'Internal error');
    }
  }

  // ------------------------------------------------------------------
  // API bridge setup
  // ------------------------------------------------------------------

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

  /**
   * Wire up the API bridge for a sandbox.
   *
   * Guest -> host: the guest's shim calls console.log(IPC_MARKER + JSON)
   * instead of window.parent.postMessage. The host listens on the
   * webview's own 'consolemessage' DOM event (fired for every console.*
   * call inside that specific guest — this is scoped per-webview-element,
   * not a global listener, so there's no cross-app source-pinning problem
   * to solve at all: only messages from *this* webview ever reach this
   * handler).
   *
   * Host -> guest: unchanged in shape, still via webview.executeScript
   * (see respond()), since that direction already works.
   *
   * Every message off the wire is treated as untrusted input from
   * app-controlled content and validated before it's allowed to reach
   * handleAPICall:
   *   - must parse as JSON matching the exact expected shape
   *   - `type` must be an exact, known key in API_HANDLERS (an allowlist,
   *     not just "starts with the right prefix" — a made-up type is
   *     rejected outright rather than silently reaching a handler)
   *   - `requestId` must be a non-empty string
   *   - payload validation is then left to each individual handler, same
   *     as before (handleDownload's base64/size checks, etc.)
   */
  function setupAPIBridge(webview, app, sandboxId) {
    const abortController = new AbortController();

    const consoleHandler = (event) => {
      const msg = event?.message;
      if (typeof msg !== 'string' || !msg.startsWith(IPC_MARKER)) return;

      let data;
      try {
        data = JSON.parse(msg.slice(IPC_MARKER.length));
      } catch (e) {
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

      const idLiteral = JSON.stringify(requestId);
      webview.executeScript({
        mainWorld: true,
        code: `(function(){ var m = window.__novaOutboxPull || {}; var p = m[${idLiteral}]; delete m[${idLiteral}]; return JSON.stringify(p === undefined ? null : p); })()`,
      }, (results) => {
        let payload = null;
        try {
          const raw = Array.isArray(results) ? results[0] : results;
          payload = raw ? JSON.parse(raw) : null;
        } catch (e) {
          log('warn', `Failed to retrieve IPC payload for ${type} from ${app?.id || 'unknown app'}: ${e.message}`);
          return;
        }
        const sandbox = activeSandboxes.get(sandboxId);
        handleAPICall(type, payload, requestId, app, webview, sandbox);
      });
    };

    webview.addEventListener('consolemessage', consoleHandler);
    // consolemessage isn't AbortController-compatible (no `signal` option
    // for webview DOM events), so teardown removes it explicitly below.
    abortController.signal.addEventListener('abort', () => {
      webview.removeEventListener('consolemessage', consoleHandler);
    });

    const sandbox = activeSandboxes.get(sandboxId);
    if (sandbox) {
      sandbox.cleanup = () => {
        // Remove the message listener via AbortController.
        abortController.abort();

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
        if (sandbox.wsConnections) {
          for (const [, wsState] of sandbox.wsConnections) {
            try { wsState.ws.close(1000, 'sandbox closed'); } catch { /* already closed */ }
          }
          sandbox.wsConnections.clear();
        }

        // Close any open file dialog so the overlay doesn't linger in the DOM.
        const dialog = openDialogs.get(sandboxId);
        if (dialog) {
          dialog.remove();
          openDialogs.delete(sandboxId);
        }
      };
    }
  }

  // ------------------------------------------------------------------
  // Error handling
  // ------------------------------------------------------------------

  function setupErrorHandling(webview, app) {
    // loadabort fires when webview navigation is cancelled (network error,
    // blocked URL, etc.). Surface it so we can see why apps fail to load.
    webview.addEventListener('loadabort', (event) => {
      log('error', `Load aborted in ${app.name}:`, event.reason);
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'AppSandbox', category: 'apps', severity: 'error', message: `Load aborted in ${app.name}: ${event.reason}`, data: { appId: app.id } });
      }
    });

    // consolemessage proxies console output from the webview's separate
    // renderer process. We can't attach to contentWindow directly due to
    // process isolation, so this is the only surface for runtime visibility.
    webview.addEventListener('consolemessage', (event) => {
      // Chromium console levels: 0=verbose, 1=info, 2=warning, 3=error.
      if (event.level >= 2) {
        const level = event.level >= 3 ? 'error' : 'warn';
        log(level, `${app.name}:`, event.message,
          event.sourceId ? `(${event.sourceId}:${event.line})` : '');
      }
    });
  }

  // ------------------------------------------------------------------
  // Permission request gate (webview-level device permissions)
  // ------------------------------------------------------------------

  /**
   * Gate webview-level permission requests (geolocation, media) against
   * AppPermissionManager. The sandboxed webview's permissionrequest event is
   * the only enforcement surface for these device features at the
   * renderer-process boundary. Unrecognised permissions are denied by
   * default — fail-closed is the safe choice.
   */
  function setupPermissionRequestGate(webview, app) {
    webview.addEventListener('permissionrequest', (e) => {
      if (e.permission === 'geolocation') {
        if (AppPermissionManager?.isGranted('device:geolocation', app.id)) {
          e.request.allow();
        } else {
          e.request.deny();
        }
        return;
      }
      if (e.permission === 'media') {
        const camOk = AppPermissionManager?.isGranted('device:camera', app.id);
        const micOk = AppPermissionManager?.isGranted('device:microphone', app.id);
        if (camOk && micOk) {
          e.request.allow();
        } else {
          e.request.deny();
        }
        return;
      }
      // Default-deny any permission we don't explicitly handle. The previous
      // implementation left these to the webview's default, which is
      // non-portable and can silently allow access.
      if (typeof e.request.deny === 'function') e.request.deny();
    });
  }

  // ------------------------------------------------------------------
  // Capability shim
  // ------------------------------------------------------------------
  //
  // Injected as the first <script> in every packaged app's HTML. Overrides
  // fetch / XHR / eval / sendBeacon so apps that use standard web APIs work
  // transparently — all network goes through the IPC bridge where
  // permissions are enforced. connect-src 'none' in the served CSP ensures
  // nothing bypasses this at the browser level.
  //
  // The shim also exposes window.nova for apps that want to call the IPC
  // bridge directly (e.g. to request permissions or subscribe to events).

  const CAPABILITY_SHIM = `<script>
(function() {
  'use strict';
  var REQUEST_TIMEOUT_MS = 30000;
  var pendingRequests = new Map();
  // Must exactly match IPC_MARKER in app-sandbox.js's setupAPIBridge.
  var IPC_MARKER = '__NOVA_IPC__:';

  function generateId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'shim_' + window.crypto.randomUUID();
    }
    return 'shim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
  }

  // Send a nova: IPC message and resolve on response. Rejects on timeout or
  // when the host returns an error.
  //
  // NOTE: this does NOT use window.parent.postMessage. For a <webview>
  // guest, window.parent === window (confirmed empirically) — there is no
  // cross-process reference to the host at all, so postMessage from here
  // can only ever loop back to this same page. The one channel that
  // actually reaches the host is console.log: the host listens on this
  // specific <webview> element's 'consolemessage' DOM event (the same
  // mechanism NB Browser already uses for its right-click context menu),
  // so a tagged console.log is a real, working guest->host send.
  // Payloads (which may contain API keys, auth headers, file bytes, etc.)
  // are never put into the console.log string itself — DevTools/consolemessage
  // is a genuinely visible channel by construction, and anything logged in
  // cleartext is exposed to anyone with the console open, independent of any
  // redaction applied elsewhere. Instead the guest stashes the payload in
  // this in-memory map (never logged) and sends only {type, requestId} over
  // console — the host then pulls the actual payload back out via
  // executeScript (window.__novaOutboxPull), which is a host-initiated read,
  // not a guest-broadcast write, so it never lands in the visible log stream.
  window.__novaOutboxPull = window.__novaOutboxPull || {};
  var pendingPayloads = window.__novaOutboxPull;

  function ipc(type, payload) {
    return new Promise(function(resolve, reject) {
      var id = generateId();
      var timer = setTimeout(function() {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          delete pendingPayloads[id];
          reject(new TypeError('IPC request timed out: ' + type));
        }
      }, REQUEST_TIMEOUT_MS);
      pendingRequests.set(id, { resolve: resolve, reject: reject, timer: timer });
      try {
        pendingPayloads[id] = payload;
        // Only the type and requestId ever appear in the visible console
        // stream — no headers, body, URLs, or other app-supplied data.
        console.log(IPC_MARKER + JSON.stringify({ type: type, requestId: id }));
      } catch (e) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        delete pendingPayloads[id];
        reject(e);
      }
    });
  }

  // Responses arrive via window.__novaInbox, pushed to by the host using
  // executeScript (see respond() in app-sandbox.js). Poll it on a plain
  // same-context interval — no IPC needed for this direction, since it's
  // just reading a variable in our own page.
  setInterval(function() {
    var inbox = window.__novaInbox;
    if (!inbox || !inbox.length) return;
    var drained = inbox.splice(0, inbox.length);
    for (var i = 0; i < drained.length; i++) {
      var msg = drained[i];
      if (!msg || typeof msg.type !== 'string') continue;

      // Pushed events (unprompted, no requestId round-trip) — dispatched
      // to onEvent listeners registered for this event name.
      if (msg.type === 'nova:events:event:response' && msg.result && msg.result.event) {
        var listeners = eventListeners[msg.result.event] || [];
        for (var j = 0; j < listeners.length; j++) {
          try { listeners[j](msg.result.data); } catch (_) {}
        }
        continue;
      }

      if (typeof msg.requestId !== 'string') continue;
      var entry = pendingRequests.get(msg.requestId);
      if (!entry) continue;
      pendingRequests.delete(msg.requestId);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(Object.assign(new Error(msg.error.message || 'IPC error'), msg.error));
        continue;
      }

      // Merge result fields onto the top level too, since some app code
      // (see createDefaultAppShell) reads handshake fields directly off
      // the response rather than through a result wrapper.
      var out = Object.assign({}, msg.result, { result: msg.result, type: msg.type });
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
        var renderFn = null;
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
  }, 50);

  // ── Download interceptor ───────────────────────────────────────────
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
  var nativeAnchorClick = HTMLAnchorElement.prototype.click;
  // Captured here, before the network-permission override further down
  // replaces window.fetch with a version that routes everything through
  // nova:net:fetch. blob: URLs aren't network requests — routing them
  // through that bridge sends the literal string "blob:..." to the host
  // as if it were a fetchable resource, which always fails. This
  // interceptor needs the real, unpatched fetch to read blob bytes
  // in-context, so grab it now while it's still native.
  var nativeFetchForDownloads = window.fetch.bind(window);
  HTMLAnchorElement.prototype.click = function() {
    var href = this.href || '';
    var filename = this.download;
    if (filename && href.indexOf('blob:') === 0) {
      var anchor = this;
      nativeFetchForDownloads(href)
        .then(function(res) { return res.blob(); })
        .then(function(blob) {
          var reader = new FileReader();
          reader.onload = function() {
            // reader.result is a data URL: "data:<mime>;base64,<data>"
            var result = String(reader.result || '');
            var commaIdx = result.indexOf(',');
            var base64Data = commaIdx >= 0 ? result.slice(commaIdx + 1) : '';
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
  // ── End download interceptor ───────────────────────────────────────

  // Response handling for ipc() calls now happens in the __novaInbox
  // poller set up above, right next to ipc() itself. That poller also
  // runs the ready-handshake fix (surfacing permissions on window,
  // re-rendering the calendar once DOM is ready) whenever a
  // 'nova:ready:response' arrives, since nova:ready now goes through the
  // same ipc()/inbox path as every other call rather than a separate
  // postMessage handshake — see CAPABILITY_SHIM's init call below.

  // Registered onEvent callbacks, checked by the inbox poller whenever a
  // pushed 'nova:events:event' notification arrives (the host pushes
  // these unprompted, not in response to a specific ipc() call, so they
  // need their own dispatch rather than the requestId-keyed one above).
  var eventListeners = {}; // eventName -> [callback, ...]

  // Public API for apps that want to use the bridge directly.
  window.nova = {
    ipc: ipc,
    requestPermission: function(permission, reason) {
      return ipc('nova:request-permission', { permission: permission, reason: reason });
    },
    onEvent: function(eventName, callback) {
      if (!eventListeners[eventName]) eventListeners[eventName] = [];
      eventListeners[eventName].push(callback);
      return ipc('nova:events:subscribe', { event: eventName });
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

  // Override fetch — route through the IPC bridge.
  var originalFetch = window.fetch;
  window.fetch = function(input, init) {
    init = init || {};
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    var method = (init.method || (input && input.method) || 'GET').toUpperCase();
    var headers = init.headers || (input && input.headers) || {};
    var headerObj = {};
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      headers.forEach(function(v, k) { headerObj[k] = v; });
    } else if (Array.isArray(headers)) {
      headers.forEach(function(pair) { headerObj[pair[0]] = pair[1]; });
    } else if (headers && typeof headers === 'object') {
      for (var k in headers) if (Object.prototype.hasOwnProperty.call(headers, k)) headerObj[k] = headers[k];
    }
    var body = init.body != null ? init.body : null;
    var bodyStr = null;
    if (typeof body === 'string') bodyStr = body;
    else if (body instanceof ArrayBuffer) bodyStr = new TextDecoder().decode(body);
    else if (body instanceof Uint8Array) bodyStr = new TextDecoder().decode(body);
    else if (body == null) bodyStr = null;
    else bodyStr = String(body);

    return ipc('nova:net:fetch', { url: url, method: method, headers: headerObj, body: bodyStr })
      .then(function(res) {
        if (!res || !res.success) throw new TypeError('Fetch failed');
        var responseInit = { status: res.status, statusText: res.statusText, headers: new Headers(res.headers || {}) };
        return new Response(res.body || '', responseInit);
      });
  };

  // Minimal XMLHttpRequest override that routes through the fetch shim.
  // Covers the common API surface (open/send/setRequestHeader/onload/onerror/
  // onreadystatechange/status/responseText). Advanced features (upload
  // events, progress, responseType blob) are not implemented — apps needing
  // those should use fetch directly.
  function NovaXHR() {
    var xhr = this;
    var method = 'GET', url = '', headers = {}, body = null;
    var state = 0;
    var listeners = { load: [], error: [], readystatechange: [], loadend: [], abort: [], timeout: [] };

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
    this.abort = function() { state = 0; listeners.abort.forEach(function(h) { h.call(xhr); }); };
    this.addEventListener = function(type, handler) { if (listeners[type]) listeners[type].push(handler); };
    this.removeEventListener = function(type, handler) {
      if (listeners[type]) listeners[type] = listeners[type].filter(function(h) { return h !== handler; });
    };

    this.send = function(b) {
      body = b;
      window.fetch(url, { method: method, headers: headers, body: typeof body === 'string' ? body : null })
        .then(function(res) {
          state = 2;
          xhr._status = res.status;
          xhr._statusText = res.statusText;
          var headerMap = {};
          var headerLines = [];
          res.headers.forEach(function(v, k) { headerMap[k.toLowerCase()] = v; headerLines.push(k + ': ' + v); });
          xhr._responseHeaderMap = headerMap;
          xhr._responseHeaders = headerLines.join('\\r\\n');
          listeners.readystatechange.forEach(function(h) { h.call(xhr); });
          return res.text();
        })
        .then(function(text) {
          xhr._responseText = text;
          state = 3;
          listeners.readystatechange.forEach(function(h) { h.call(xhr); });
          state = 4;
          listeners.readystatechange.forEach(function(h) { h.call(xhr); });
          listeners.load.forEach(function(h) { h.call(xhr); });
          listeners.loadend.forEach(function(h) { h.call(xhr); });
        })
        .catch(function(err) {
          xhr._error = err;
          state = 4;
          listeners.error.forEach(function(h) { h.call(xhr, err); });
          listeners.loadend.forEach(function(h) { h.call(xhr); });
        });
    };
  }
  window.XMLHttpRequest = NovaXHR;

  // Fire-and-forget send: same console.log marker channel as ipc(), but
  // with no pendingRequests entry since nothing here waits on a reply.
  function ipcFireAndForget(type, payload) {
    try {
      var id = generateId();
      pendingPayloads[id] = payload;
      console.log(IPC_MARKER + JSON.stringify({ type: type, requestId: id }));
    } catch (e) { /* best-effort */ }
  }

  // Audit eval calls — log to host but still execute (per the audit:eval
  // contract: "Log it — don't block"). CSP allows unsafe-eval by design.
  var originalEval = window.eval;
  window.eval = function(code) {
    var preview = String(code).slice(0, 200);
    ipcFireAndForget('nova:audit:eval', { preview: preview });
    return originalEval.call(this, code);
  };

  // Override sendBeacon — fire-and-forget POST through the IPC bridge.
  // Returns true synchronously to match the native API contract; the actual
  // permission check happens host-side and the result is dropped.
  if (navigator.sendBeacon) {
    navigator.sendBeacon = function(url, data) {
      try {
        var body = typeof data === 'string' ? data : (data && data.toString ? data.toString() : '');
        ipcFireAndForget('nova:net:fetch', { url: url, method: 'POST', headers: {}, body: body });
        return true;
      } catch (e) {
        return false;
      }
    };
  }
})();
\x3C/script>`;

  // CSP meta tag injected into app HTML. Allows inline scripts/styles (apps
  // need this) and eval (the audit hook catches abuse), but blocks all direct
  // network access via connect-src 'none' — forcing network through the IPC
  // bridge where permissions are enforced.
  const RELAXED_CSP_META = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\' blob: data: \'unsafe-inline\' \'unsafe-eval\'; script-src \'self\' blob: \'unsafe-inline\' \'unsafe-eval\'; style-src \'self\' \'unsafe-inline\' blob: data:; img-src \'self\' blob: data: https:; font-src \'self\' blob: data:; connect-src \'self\' blob: http://localhost:* https://localhost:*">';

  /**
   * Prepend the capability shim as the very first script in the app's HTML.
   * Injects after <head> if present, otherwise prepends to the document.
   */
  function injectCapabilityShim(html) {
    if (typeof html !== 'string') return html;
    if (/<head(\s[^>]*)?>/i.test(html)) {
      const relaxed = RELAXED_CSP_META + '\n';
      return html.replace(/<head(\s[^>]*)?>/i, (match) => match + '\n' + relaxed + CAPABILITY_SHIM);
    }
    return CAPABILITY_SHIM + '\n' + RELAXED_CSP_META + '\n' + html;
  }

  // ------------------------------------------------------------------
  // App loading
  // ------------------------------------------------------------------

  /**
   * Load app content into a sandbox. For webapps (external URLs), validates
   * the protocol before assigning to webview.src — without this, a malicious
   * manifest could specify javascript: or file: URLs.
   */
  async function loadAppContent(webview, app, state) {
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
        shimmedFiles[app.entry] = encodeBase64Utf8(injectCapabilityShim(rawHtml));

        const regRes = await fetch('/api/apps/serve/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sandboxId, files: shimmedFiles }),
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

  /**
   * Build the default app shell for apps without content. Uses
   * JSON.stringify for the app.id interpolation into the inline script —
   * escapeHtml is wrong for JS string context (it would insert HTML entities
   * literally inside a JS string).
   */
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
          // CAPABILITY_SHIM (injected into <head> above) already provides
          // window.nova.ipc — use the real bridge rather than a bare
          // postMessage, which never reaches the host for a <webview>
          // guest (window.parent === window here; see app-sandbox.js).
          setTimeout(() => {
            if (window.nova && window.nova.ipc) {
              window.nova.ipc('nova:ready', { appId: ${safeAppId} }).then(() => {
                var el = document.getElementById('apiStatus');
                if (el) el.textContent = 'API Bridge: Connected ✓';
              }).catch(() => {
                var el = document.getElementById('apiStatus');
                if (el) el.textContent = 'API Bridge: Connection failed';
              });
            }
          }, 100);
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

  /** Show an error page in the sandbox when app content fails to load. */
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

  // ------------------------------------------------------------------
  // Sandbox attribute sanitisation
  // ------------------------------------------------------------------

  /**
   * Build a safe sandbox attribute string from an app's sandbox config.
   *
   * allow-same-origin is NOT included by default for third-party apps. Including
   * it lets the guest access its own cookies, localStorage, and sessionStorage
   * on the shared origin — increasing the blast radius of any XSS inside the
   * sandbox. The same-document <iframe> sandbox-escape also applies when
   * combined with allow-scripts.
   *
   * In a <webview>, the real isolation boundary is the separate renderer
   * process, so the DOM-level escape risk is lower than for a same-document
   * iframe. However, the IPC bridge depends on `window.location.origin` matching
   * between the parent and the webview. Without allow-same-origin the origin
   * becomes opaque and postMessage silently drops.
   *
   * To balance these concerns:
   *   - System apps (in the audited allowlist) receive allow-same-origin for IPC.
   *   - Third-party apps must explicitly opt in via `allowSameOrigin: true` in
   *     their manifest, and should declare the `sandbox:same-origin` permission
   *     so AppPermissionManager can prompt the user.
   */
  function sanitizeSandboxAttr(sandboxConfig, appId) {
    const _SYSTEM_SANDBOX_APPS = new Set([
      'nook', 'app-manager', 'browser', 'nbosp-email', 'nbosp-gallery',
      'nbosp-downloads', 'nbosp-search', 'nbosp-music', 'nbosp-contacts',
      'calendar-app', 'calculator', 'nbosp-clock', 'quill', 'vault', 'shell',
    ]);

    const isSystemApp = _SYSTEM_SANDBOX_APPS.has(appId);
    const isExplicitOptIn = sandboxConfig && typeof sandboxConfig === 'object' && sandboxConfig.allowSameOrigin === true;

    const tokens = [];
    if (isSystemApp || isExplicitOptIn) {
      tokens.push('allow-same-origin');
    }

    const has = (camelKey, kebabToken) => {
      if (sandboxConfig && typeof sandboxConfig === 'object') {
        return sandboxConfig[camelKey] === true;
      }
      if (typeof sandboxConfig === 'string') {
        return sandboxConfig.includes(kebabToken);
      }
      return false;
    };

    if (has('allowScripts', 'allow-scripts')) tokens.push('allow-scripts');
    if (has('allowForms', 'allow-forms')) tokens.push('allow-forms');
    if (has('allowPopups', 'allow-popups')) tokens.push('allow-popups');
    if (has('allowPopupsToEscapeSandbox', 'allow-popups-to-escape-sandbox')) tokens.push('allow-popups-to-escape-sandbox');
    if (has('allowModals', 'allow-modals')) tokens.push('allow-modals');

    // allow-downloads: without this token, Chromium silently drops any
    // download triggered inside the webview (blob URL + <a download>,
    // navigation to a Content-Disposition: attachment response, etc).
    // It's a per-click, user-gesture-gated action — the OS-native save
    // dialog is the actual security boundary, not this token — so it's
    // safe to include in the default set alongside the other baseline
    // interaction tokens rather than gating it behind a manifest
    // permission the user has to grant separately.
    if (tokens.length === 0) {
      tokens.push('allow-scripts', 'allow-forms', 'allow-popups', 'allow-modals', 'allow-downloads');
    } else if (!tokens.includes('allow-downloads')) {
      tokens.push('allow-downloads');
    }

    log('debug', `sandbox attrs for ${appId || 'unknown'}: ${tokens.join(' ')}`);
    return tokens.join(' ');
  }

  // ------------------------------------------------------------------
  // Sandbox creation
  // ------------------------------------------------------------------

  /**
   * Create a sandboxed webview for app execution. The webview runs in a
   * separate renderer process — true process isolation. It cannot access
   * main page JS, DOM, or memory regardless of app content.
   */
  function createSandbox(app, container, state) {
    const webview = document.createElement('webview');

    // nodeintegration=false means the app cannot require() Node.js modules
    // even if the preload script has access — defense in depth.
    webview.setAttribute('nodeintegration', 'false');
    webview.setAttribute('nodeintegrationsubframes', 'false');

    // Sandbox tracking id — unique per launch (Date.now()), used only to key
    // activeSandboxes/eventSubscriptions/etc. so concurrent or repeated
    // launches of the same app don't collide with each other.
    const sandboxId = `sandbox_${app.id}_${Date.now()}`;

    // Isolated storage partition, keyed by app.id ONLY (not sandboxId).
    // The 'persist:' prefix makes a given partition NAME durable across
    // that partition's own lifetime — it does nothing to unify two
    // different partition names. Using sandboxId here (as before) meant
    // every launch computed a new Date.now()-suffixed name, so each
    // launch got its own fresh, empty partition despite the 'persist:'
    // prefix — storage never actually survived a relaunch. Keying by
    // app.id alone means every launch of the same app resolves to the
    // same on-disk partition.
    const partitionId = `app_${app.id}`;
    webview.setAttribute('partition', `persist:${partitionId}`);

    const sandboxAttr = sanitizeSandboxAttr(app.sandbox, app.id);
    if (sandboxAttr) {
      webview.setAttribute('sandbox', sandboxAttr);
    }

    webview.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
      background: white;
      display: flex;
      flex-direction: column;
    `;

    webview.dataset.sandboxId = sandboxId;
    webview.dataset.appId = app.id;

    activeSandboxes.set(sandboxId, {
      appId: app.id,
      iframe: webview,
      webview: webview,
      created: new Date().toISOString(),
      state: state,
      windowId: state?.id,
      wsConnections: new Map(),
    });

    // Fullscreen support — toggle window maximise when the webview enters or
    // exits fullscreen so the app fills the screen.
    if (state && state.element) {
      const origMaximized = state.maximized;
      webview.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement === webview) {
          if (typeof WM !== 'undefined' && WM.toggleMaximize && !state.maximized) {
            WM.toggleMaximize(state.id);
          }
        } else {
          if (typeof WM !== 'undefined' && WM.toggleMaximize && !origMaximized && state.maximized) {
            WM.toggleMaximize(state.id);
          }
        }
      }, false);
    }

    eventSubscriptions.set(sandboxId, new Map());

    setupAPIBridge(webview, app, sandboxId);
    setupErrorHandling(webview, app);
    setupPermissionRequestGate(webview, app);

    log('debug', `Created webview sandbox for ${app.name} (${sandboxId})`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppSandbox', category: 'security', severity: 'info', message: `Created sandbox for ${app.name}`, data: { appId: app.id, sandboxId } });
    }

    return webview;
  }

  // ------------------------------------------------------------------
  // Public lifecycle
  // ------------------------------------------------------------------

  /**
   * Launch an app in a sandboxed environment.
   * @param {object} app - App definition
   * @param {HTMLElement} container - DOM element to mount the webview in
   * @param {object} state - Window state from the window manager
   * @param {object} [options={}] - Reserved for future launch options
   * @returns {{ success: boolean, sandboxId: string, appId: string, windowId: string, iframe: HTMLElement, webview: HTMLElement, cleanup: () => void }}
   */
  function launch(app, container, state, options = {}) {
    if (!container) {
      throw new Error('Container element is required');
    }

    // Clear container — any previous webview (and its listeners) goes away.
    container.innerHTML = '';

    const webview = createSandbox(app, container, state);
    container.appendChild(webview);

    // loadAppContent is async (registers files with the server) — fire and
    // let errors surface in the webview via showErrorPage.
    loadAppContent(webview, app, state);

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

  /**
   * Destroy a sandbox by ID. Tears down listeners, WebSockets, event
   * subscriptions, open dialogs, and unregisters app files from the serve
   * route. Safe to call multiple times — second call is a no-op.
   * @param {string} sandboxId
   * @returns {boolean} true if a sandbox was destroyed, false if not found
   */
  function destroy(sandboxId) {
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox) return false;

    // sandbox.cleanup (set up in setupAPIBridge) does the actual teardown:
    // aborts the message listener, detaches OS event subs, closes WebSockets,
    // and removes any open file dialog overlay.
    if (typeof sandbox.cleanup === 'function') {
      sandbox.cleanup();
    }

    // Unregister app files from the Express serve route. Best-effort —
    // failures here don't affect the sandbox teardown.
    fetch(`/api/apps/serve/unregister/${encodeURIComponent(sandboxId)}`, { method: 'DELETE' })
      .catch(() => {});

    activeSandboxes.delete(sandboxId);
    log('debug', `Destroyed sandbox: ${sandboxId}`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppSandbox', category: 'security', severity: 'info', message: `Destroyed sandbox ${sandboxId}`, data: { appId: sandbox.appId, sandboxId } });
    }

    return true;
  }

  /**
   * Get active sandbox info by ID.
   * @param {string} sandboxId
   * @returns {object|null}
   */
  function getSandbox(sandboxId) {
    return activeSandboxes.get(sandboxId) || null;
  }

  /**
   * Get all active sandboxes as an array.
   * @returns {object[]}
   */
  function getAllSandboxes() {
    return Array.from(activeSandboxes.values());
  }

  /**
   * Clear the on-disk storage partition for a given app id
   * (persist:app_<appId> — see createSandbox() above). This is a
   * separate Chromium storage partition from the host window's
   * localStorage/IndexedDB/OPFS, and from the app's FS/OPFS data
   * folder cleaned up elsewhere — none of those touch this partition.
   *
   * Callers that fully remove an app's data (uninstall, "wipe all
   * data", factory reset) must call this too, or the app's cookies,
   * IndexedDB, cache, etc. from its own webview silently survive on
   * disk under a partition nothing else references anymore.
   *
   * Safe to call even if the app was never launched (partition simply
   * doesn't exist yet, and gets created+immediately-cleared, which is
   * harmless).
   *
   * @param {string} appId
   * @returns {Promise<void>} resolves once the partition is cleared
   *   (or after a timeout, so callers can't hang forever on this).
   */
  async function clearAppPartition(appId) {
    if (!appId) return;

    // clearData() only actually reaches a partition's real storage once a
    // webview on that partition has completed a genuine same-origin
    // navigation — about:blank never establishes a session against this
    // partition, so clearData silently no-ops against it (confirmed by
    // testing: a throwaway webview parked at about:blank always failed
    // to clear real app data, while the identical webview navigated to
    // the app's real served origin worked). So we register a minimal
    // blank page through the same /api/apps/serve/register mechanism
    // real app launches use (see loadAppContent above), giving the
    // webview a real same-origin page inside the correct partition
    // before calling clearData.
    let baseUrl;
    try {
      const sandboxId = `sandbox_clr_${appId.replace(/[^\w.-]/g, '_')}_${Date.now()}`;
      const files = { 'index.html': btoa('<!doctype html><html><body></body></html>') };
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

    return new Promise(resolve => {
      const wv = document.createElement('webview');
      wv.setAttribute('partition', `persist:app_${appId}`);
      wv.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none;';
      // Correct key set for this NW.js build's <webview> clearData(), confirmed
      // by testing against real data: 'filesystem' must be 'fileSystems'
      // (capitalized S), and 'serviceWorkers'/'cacheStorage' are rejected
      // outright on this build ("Unexpected property") — the webview tag's
      // ClearDataTypeSet here is a narrower, older subset than the full
      // chrome.browsingData schema.
      const clearTypes = { appcache: true, cache: true, cookies: true, fileSystems: true, indexedDB: true, localStorage: true, webSQL: true };
      const cleanup = () => { try { wv.remove(); } catch { } resolve(); };
      wv.addEventListener('loadstop', () => {
        try { wv.clearData({}, clearTypes, cleanup); } catch { cleanup(); }
      });
      wv.addEventListener('loadabort', cleanup);
      document.body.appendChild(wv);
      wv.src = baseUrl ? (window.location.origin + baseUrl + '/index.html') : 'about:blank';
      setTimeout(cleanup, 4000);
    });
  }

  /**
   * Clear storage partitions for multiple apps in parallel. Used by
   * bulk operations (wipe all data, factory reset).
   * @param {string[]} appIds
   * @returns {Promise<void>}
   */
  function clearAppPartitions(appIds) {
    return Promise.all((appIds || []).map(clearAppPartition)).then(() => {});
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  return {
    createSandbox,
    launch,
    destroy,
    getSandbox,
    getAllSandboxes,
    clearAppPartition,
    clearAppPartitions,

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
      CAPABILITY_SHIM,
      RELAXED_CSP_META,
      // Test-only helpers for resetting module state between tests.
      _resetState() {
        activeSandboxes.clear();
        eventSubscriptions.clear();
        openDialogs.clear();
      },
      _activeSandboxes: activeSandboxes,
      _eventSubscriptions: eventSubscriptions,
      _openDialogs: openDialogs,
    },
  };
})();

// CommonJS export for Node.js test runners and bundlers that expect it.
// In the browser, the module attaches as a global `AppSandbox`.
window.AppSandbox = AppSandbox;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AppSandbox;
}