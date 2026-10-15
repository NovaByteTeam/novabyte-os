
(function () {
  'use strict';
  // Guest compatibility shims. These deliberately expose only the small API
  // surface Email already used; privileged mail operations are implemented by
  // the host-side nova:mail handlers and remain permission-gated.
  const _openMailto = (url) => {
    try {
      const u = new URL(url, location.href);
      if (u.protocol === 'mailto:' && typeof window.nova?.mail?.compose === 'function') {
        return window.nova.mail.compose({ to: u.pathname, subject: u.searchParams.get('subject') || '', body: u.searchParams.get('body') || '' });
      }
    } catch {}
  };
  window.OS = window.OS || {};
  if (typeof window.OS.openMailto !== 'function') window.OS.openMailto = _openMailto;
  window.Notify = window.Notify || { show: (opts) => window.nova.ipc('nova:notifications:show', opts || {}) };
  window.__NBOSP_BG = window.__NBOSP_BG || { email: { ensureBooted() {}, setAccounts() {}, onChange: null } };

const appConfig = {
  id: 'com.nbosp.email',
  name: 'Email',
  icon: 'mail',
  version: '3.0.3',
  description: 'IMAP · POP3 · Exchange',
  defaultSize: [860, 580],
  minSize: [600, 420],

  init(content, state, options) {
    // Guest-local permission facade. NovaApps run in an isolated webview and
    // cannot access the host AppPermissionManager global directly. The host
    // authenticated nova:ready handshake exposes the granted permission set.
    const permissionReady = new Promise(resolve => {
      const started = Date.now();
      const poll = () => {
        const r = window.__novaPermResponse;
        if (r && Array.isArray(r.permissions)) return resolve(r);
        if (Date.now() - started >= 10000) return resolve({ permissions: [], optionalPermissions: [] });
        setTimeout(poll, 25);
      };
      poll();
    });
    const hasPermission = async permission => {
      const r = await permissionReady;
      return Array.isArray(r.permissions) && r.permissions.includes(permission);
    };
    // Guest-local DOM helper. The standalone OS app previously inherited
    // createEl from the host runtime; .novaapp guests do not share those
    // globals, so define the exact small helper the Email UI expects.
    function createEl(tag, attrs, children) {
      const el = document.createElement(tag);
      if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
          if (k === 'className') el.className = v;
          else if (k === 'htmlFor') el.htmlFor = v;
          else if (k === 'style' && v && typeof v === 'object') Object.assign(el.style, v);
          else if (k.startsWith('data-')) el.setAttribute(k, v);
          else el[k] = v;
        }
      }
      if (children) el.append(...[].concat(children));
      return el;
    }

    // Guest-local svgIcon helper. The standalone Email app inherited this
    // from the host's base-utils.js; novaapp guests do not share host globals.
    // Keep the same Lucide-style SVG markup for the icons Email actually uses.
    function svgIcon(name, size = 16) {
      const safeSize = Math.max(8, Math.min(96, Number(size) || 16));
      const paths = {
        refresh: '<path d=\"M20 11a8.1 8.1 0 0 0-15.5-3.1L3 10\"/><path d=\"M3 4v6h6\"/><path d=\"M4 13a8.1 8.1 0 0 0 15.5 3.1L21 14\"/><path d=\"M21 20v-6h-6\"/>',
        'corner-up-left': '<polyline points=\"9 14 4 9 9 4\"/><path d=\"M20 20v-7a4 4 0 0 0-4-4H4\"/>',
        'corner-up-right': '<polyline points=\"15 14 20 9 15 4\"/><path d=\"M4 20v-7a4 4 0 0 1 4-4h12\"/>',
        x: '<line x1=\"18\" y1=\"6\" x2=\"6\" y2=\"18\"/><line x1=\"6\" y1=\"6\" x2=\"18\" y2=\"18\"/>'
      };
      const body = paths[name];
      if (!body) return '';
      return '<svg width=\"' + safeSize + '\" height=\"' + safeSize + '\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\">' + body + '</svg>';
    }
    // CSS — injected once per app open. The shell owns the design tokens
    // (--bg-elevated, --accent, --border, --text-primary, …); we only scope
    // local styles under the .em-* prefix.
    const styleEl = document.createElement('style');
    styleEl.setAttribute('nonce', window.__cspNonce || '');
    styleEl.textContent = `

    :root {
      --bg-base:#07090f; --bg-elevated:rgba(14,18,28,.22); --bg-overlay:rgba(20,26,40,.14);
      --bg-sunken:rgba(3,5,8,.35); --bg-hover:rgba(255,255,255,.06); --bg-sidebar:rgba(4,6,12,.20);
      --text-primary:#e6edf3; --text-secondary:#8b949e; --text-muted:#484f58; --text-link:#58a6ff;
      --text-danger:#f85149; --text-success:#3fb950; --text-warning:#d29922;
      --accent:#58a6ff; --accent-hover:#79b8ff; --accent-muted:rgba(88,166,255,.15);
      --border:rgba(255,255,255,.12); --border-subtle:rgba(255,255,255,.06); --border-default:rgba(255,255,255,.12); --border-strong:rgba(255,255,255,.25);
      --r-xs:6px; --r-sm:10px; --r-md:14px; --r-lg:20px; --r-xl:24px;
      --ease-macos:cubic-bezier(.25,.46,.45,.94); --font-ui:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; --font-size:14px;
      --bg-elevated-2:rgba(255,255,255,.10);
    }
    html,body,#app { width:100%; height:100%; margin:0; padding:0; overflow:hidden; background:transparent !important; font-family:var(--font-ui); color:var(--text-primary); }
    *,*::before,*::after { box-sizing:border-box; }
    button,.btn,[role=button] {
      font-family:var(--font-ui); font-size:13px; cursor:pointer; transition:all .2s cubic-bezier(.34,1.56,.64,1);
    }
    .btn { padding:6px 14px; border-radius:var(--r-sm); border:1px solid var(--border-default); background:var(--bg-overlay); color:var(--text-primary); min-height:32px; display:inline-flex; align-items:center; justify-content:center; gap:6px; }
    .btn:hover { background:rgba(255,255,255,.10); border-color:var(--border-strong); transform:translateY(-2px); box-shadow:0 4px 12px rgba(0,0,0,.20); }
    .btn:active { transform:translateY(0) scale(.98); }
    .btn-primary { background:var(--accent); border-color:var(--accent); color:#fff; }
    .btn-primary:hover { background:var(--accent-hover); transform:translateY(-2px); box-shadow:0 6px 16px rgba(88,166,255,.30); }
    .btn-danger { background:transparent; border-color:var(--text-danger); color:var(--text-danger); }
    .btn-sm { padding:4px 10px; font-size:12px; }
    .btn-icon { width:32px; height:32px; min-width:44px; min-height:44px; padding:0; display:inline-flex; align-items:center; justify-content:center; }
    input,textarea,select { font-family:var(--font-ui); }
    :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
      .em-root{display:flex;flex-direction:column;height:100%;overflow:hidden;font-size:13px;}
      .em-toolbar{display:flex;align-items:center;gap:6px;padding:7px 10px;border-bottom:1px solid var(--border);background:var(--bg-elevated);flex-shrink:0;}
      .em-tb-btn{min-height:32px;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;}
      .em-tb-btn.em-primary{color:#fff;}
      .em-tb-sep{flex:1;}
      .em-main{display:flex;flex:1;overflow:hidden;}
      /* Sidebar */
      .em-sidebar{width:196px;flex-shrink:0;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto;background:var(--bg-elevated);transition:width .18s;}
      .em-sidebar.hidden{width:0;overflow:hidden;}
      .em-sb-section{font-size:10px;font-weight:700;color:var(--text-secondary);letter-spacing:.07em;padding:12px 12px 3px;text-transform:uppercase;}
      .em-sb-row{display:flex;align-items:center;gap:7px;padding:7px 14px;font-size:13px;cursor:pointer;color:var(--text-secondary);white-space:nowrap;transition:background .1s;}
      .em-sb-row:hover{background:rgba(255,255,255,.05);}
      .em-sb-row.active{background:rgba(99,102,241,.15);color:var(--accent);}
      .em-sb-badge{margin-left:auto;background:var(--accent);color:#fff;border-radius:10px;padding:1px 6px;font-size:10px;font-weight:700;}
      /* List column */
      .em-list-col{width:280px;flex-shrink:0;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;}
      .em-list-tb{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--border);flex-shrink:0;}
      .em-search{flex:1;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;padding:5px 9px;color:var(--text-primary);font-size:12px;outline:none;}
      .em-search:focus{border-color:var(--accent);}
      .em-batch-bar{display:none;align-items:center;gap:6px;padding:5px 10px;background:rgba(99,102,241,.1);border-bottom:1px solid var(--border);font-size:12px;color:var(--text-primary);flex-shrink:0;}
      .em-msg-list{flex:1;overflow-y:auto;}
      .em-msg-row{display:flex;align-items:flex-start;gap:7px;padding:9px 10px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .1s,transform .18s;position:relative;}
      .em-msg-row:hover{background:var(--bg-elevated);}
      .em-msg-row.active{background:rgba(99,102,241,.13);}
      .em-msg-row.unread .em-msg-from{font-weight:700;color:var(--text-primary);}
      .em-msg-row.unread .em-msg-subj{font-weight:600;color:var(--text-secondary);}
      .em-msg-check{width:14px;height:14px;flex-shrink:0;accent-color:var(--accent);cursor:pointer;margin-top:3px;}
      .em-avatar{width:30px;height:30px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;}
      .em-msg-meta{flex:1;min-width:0;}
      .em-msg-from{font-size:12px;font-weight:500;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .em-msg-subj{font-size:12px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;}
      .em-msg-acct{font-size:10px;color:var(--text-secondary);opacity:.7;margin-top:1px;}
      .em-msg-date{font-size:10px;color:var(--text-secondary);flex-shrink:0;margin-top:2px;}
      .em-pagination{display:none;align-items:center;justify-content:center;gap:8px;padding:7px;border-top:1px solid var(--border);font-size:12px;color:var(--text-secondary);flex-shrink:0;}
      /* Reader */
      .em-reader{flex:1;display:flex;flex-direction:column;overflow:hidden;}
      .em-reader-hdr{padding:14px 18px 10px;border-bottom:1px solid var(--border);flex-shrink:0;}
      .em-reader-subj{font-size:15px;font-weight:700;color:var(--text-primary);margin-bottom:7px;line-height:1.3;}
      .em-reader-meta{font-size:11px;color:var(--text-secondary);display:flex;flex-direction:column;gap:2px;}
      .em-reader-actions{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap;}
      .em-reader-body{flex:1;overflow:hidden;}
      .em-reader-body iframe{width:100%;height:100%;border:none;background:#fff;}
      .em-text-body{padding:14px 18px;font-size:13px;line-height:1.65;color:var(--text-primary);white-space:pre-wrap;overflow-y:auto;height:100%;box-sizing:border-box;}
      .em-attachments{padding:8px 18px;border-top:1px solid var(--border);display:flex;gap:7px;flex-wrap:wrap;flex-shrink:0;}
      .em-attach-chip{display:flex;align-items:center;gap:5px;padding:4px 9px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;font-size:11px;color:var(--text-secondary);}
      /* Empty / spinner */
      .em-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;color:var(--text-secondary);gap:8px;font-size:13px;height:100%;}
      @keyframes em-spin{to{transform:rotate(360deg);}}
      .em-spinner{width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:em-spin .6s linear infinite;}
      /* Buttons */
      .em-btn{min-height:32px;color:var(--text-primary);}
      .em-btn:hover{color:var(--text-primary);}
      .em-btn:disabled{opacity:.4;cursor:default;}
      .em-btn.danger{color:#e55;border-color:rgba(229,85,85,.4);}
      .em-btn.danger:hover{background:rgba(229,85,85,.1);}
      /* Setup */
      .em-setup{flex:1;padding:24px;overflow-y:auto;}
      .em-setup-card{width:100%;max-width:430px;margin:0 auto;display:flex;flex-direction:column;gap:10px;}
      .em-setup-title{font-size:17px;font-weight:700;color:var(--text-primary);margin-bottom:4px;}
      .em-lbl{font-size:10px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.07em;margin-bottom:2px;}
      .em-input{background:var(--bg-elevated);border:1px solid var(--border);border-radius:7px;padding:8px 11px;color:var(--text-primary);font-size:13px;outline:none;width:100%;box-sizing:border-box;transition:border-color .12s;}
      .em-input:focus{border-color:var(--accent);}
      .em-proto-row{display:flex;gap:6px;}
      .em-proto-btn{flex:1;padding:7px 0;border:1px solid var(--border);border-radius:7px;background:var(--bg-elevated);color:var(--text-secondary);cursor:pointer;font-size:12px;font-weight:600;transition:all .15s;}
      .em-proto-btn.active{background:var(--accent);color:#fff;border-color:var(--accent);}
      .em-row2{display:flex;gap:8px;}
      .em-row2>*{flex:1;}
      /* Compose */
      .em-compose-overlay{position:absolute;inset:0;background:rgba(0,0,0,.45);z-index:100;display:flex;align-items:flex-end;justify-content:flex-end;}
      .em-compose-win{width:460px;max-width:100%;background:var(--bg-elevated);border-radius:12px 12px 0 0;border:1px solid var(--border);border-bottom:none;display:flex;flex-direction:column;max-height:88%;overflow:hidden;}
      .em-compose-hdr{display:flex;align-items:center;padding:9px 12px;border-bottom:1px solid var(--border);font-size:13px;font-weight:600;color:var(--text-primary);flex-shrink:0;}
      .em-cfield{display:flex;align-items:center;gap:8px;padding:6px 13px;border-bottom:1px solid var(--border);}
      .em-cfield-lbl{font-size:11px;color:var(--text-secondary);width:32px;flex-shrink:0;}
      .em-cinput{flex:1;background:none;border:none;color:var(--text-primary);font-size:13px;outline:none;}
      .em-cbody{flex:1;padding:10px 13px;background:none;border:none;color:var(--text-primary);font-size:13px;outline:none;resize:none;font-family:inherit;min-height:110px;}
      .em-compose-foot{display:flex;align-items:center;gap:7px;padding:8px 11px;border-top:1px solid var(--border);flex-shrink:0;}
    `;
    content.appendChild(styleEl);

    // Constants
    const SK = 'nbosp_email_accts_v2';
    const SK_DRAFT = 'nbosp_email_drafts_v1';
    const COLORS = Object.freeze([
      '#6366f1', '#ec4899', '#14b8a6', '#f59e0b',
      '#8b5cf6', '#10b981', '#ef4444', '#3b82f6',
    ]);
    const FICONS = Object.freeze({
      inbox: '📥', sent: '📤', drafts: '📝', trash: '🗑️',
      spam: '⚠️', junk: '⚠️', archive: '📦', starred: '⭐', all: '📬',
    });
    const PAGE_SIZE = 20;
    const COMBINED_LIMIT = 60;
    const SEARCH_DEBOUNCE_MS = 420;
    const ROW_ANIM_MS = 200;
    const ONE_WEEK_MS = 7 * 86_400_000;
    const DEFAULT_FOLDERS = Object.freeze([
      { path: 'INBOX', name: 'Inbox' },
      { path: 'SENT', name: 'Sent' },
      { path: 'DRAFTS', name: 'Drafts' },
      { path: 'TRASH', name: 'Trash' },
      { path: 'SPAM', name: 'Spam' },
    ]);
    const PROTO_DEFAULTS = Object.freeze({ imap: '993', pop3: '995', exchange: '443' });

    // Hoisted utilities — defined once, referenced throughout. Defining them
    // here (rather than inline at call sites) avoids recreating function
    // objects on every render or interval tick.

    // Minimal HTML-entity decoder used only for Notification bodies (plain
    // text). Not a full entity decoder; covers the few entities mail servers
    // commonly inject into Subject headers.
    function decodeEntities(str) {
      if (!str) return str;
      return str
        .replace(/&#x27;/gi, "'").replace(/&#39;/gi, "'")
        .replace(/&quot;/gi, '"').replace(/&#x22;/gi, '"')
        .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&');
    }

    function parseMailto(url) {
      try {
        const u = new URL(url);
        if (u.protocol !== 'mailto:') return {};
        const params = u.searchParams;
        return {
          to: decodeURIComponent(u.pathname),
          subject: params.get('subject') || '',
          body: params.get('body') || '',
          cc: params.get('cc') || '',
          bcc: params.get('bcc') || '',
        };
      } catch {
        return {};
      }
    }

    // Math.imul performs correct 32-bit integer multiplication; plain
    // `h * 31` would lose precision on large floats before the bitwise mask,
    // biasing the colour distribution.
    function avatarColor(s) {
      let h = 0;
      for (let i = 0; i < (s || '').length; i++) {
        h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
      }
      return COLORS[Math.abs(h) % COLORS.length];
    }

    function fmtDate(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      const now = new Date();
      if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      if (now - d < ONE_WEEK_MS) {
        return d.toLocaleDateString([], { weekday: 'short' });
      }
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    function fmtSize(bytes) {
      if (!bytes || bytes <= 0) return '';
      if (bytes < 1024) return bytes + 'B';
      if (bytes < 1_048_576) return Math.round(bytes / 1024) + 'KB';
      return (bytes / 1_048_576).toFixed(1) + 'MB';
    }

    function uidKey(acctId, folder) {
      return acctId + '|' + folder;
    }

    function notify(body, type = 'info', title = 'Email') {
      Notify.show({ title, body, type, appName: 'Email' });
    }

    function logError(context, err) {
      // AbortError is expected when a stale load is cancelled — never surface
      // it to the user or treat it as a real failure.
      if (err?.name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Email] ' + context + ':', msg);
    }

    // Build a labelled input row used by the setup wizard. Hoisted out of
    // buildSetup so it isn't recreated on every open.
    function makeFieldRow(label, type, placeholder, value) {
      const wrapper = createEl('div', { style: 'display:flex;flex-direction:column;gap:3px;' });
      wrapper.appendChild(createEl('div', { className: 'em-lbl', textContent: label }));
      const inp = createEl('input', {
        className: 'em-input',
        type,
        placeholder,
        value: value || '',
      });
      wrapper.appendChild(inp);
      return { wrapper, inp };
    }

    // Build a compose field row (To / Cc / Bcc / Subject).
    function makeComposeField(label, type, placeholder) {
      const row = createEl('div', { className: 'em-cfield' });
      row.appendChild(createEl('span', { className: 'em-cfield-lbl', textContent: label }));
      const inp = createEl('input', { className: 'em-cinput', type, placeholder });
      row.appendChild(inp);
      return { row, inp };
    }

    // State
    let accounts = [];
    let activeAcctId = 'all';
    let activeFolder = 'INBOX';
    let messages = [];
    let page = 1;
    let pages = 1;
    let activeMsgUid = null;
    let loading = false;
    let searchQ = '';
    const selectedUids = new Set();
    const unreadMap = Object.create(null); // "acctId|folder" → count
    const syncTimers = Object.create(null); // acctId → interval id
    const emailBg = window.__NBOSP_BG?.email || null;

    // In-memory credential cache. Passwords live here and in the server-side
    // session only — never written to localStorage in plaintext.
    const credCache = Object.create(null);

    // Lifecycle — one AbortController for the whole app instance. Every
    // addEventListener and every fetch uses its signal, so a single abort()
    // in __nbospEmailCleanup tears down all listeners and in-flight requests
    // at once. This is the cleanest teardown pattern for long-lived UIs.
    window.__nbospEmailCleanup?.();
    const previousOpenMailto = OS.openMailto;
    const lifecycle = new AbortController();
    const { signal: appSignal } = lifecycle;

    // Per-call controller for loadMessages. Aborting the previous call before
    // starting a new one cancels stale fetches and discards their results.
    let loadController = null;
    appSignal.addEventListener('abort', () => loadController?.abort(), { once: true });

    let searchTimer = 0;
    appSignal.addEventListener('abort', () => clearTimeout(searchTimer), { once: true });

    // Intercept OS.openMailto while the app is running so mailto: links open
    // the inline composer instead of relaunching the app. Restored on cleanup
    // only if no other app has since replaced our handler.
    const ourMailto = (url) => openCompose(parseMailto(url));
    OS.openMailto = ourMailto;

    window.__nbospEmailCleanup = () => {
      lifecycle.abort();
      // Stop every account's background sync interval — the aborted signal
      // guards the callback body, but the interval itself would otherwise
      // keep firing forever.
      for (const id of Object.keys(syncTimers)) {
        clearInterval(syncTimers[id]);
        delete syncTimers[id];
      }
      if (OS.openMailto === ourMailto && typeof previousOpenMailto === 'function') {
        OS.openMailto = previousOpenMailto;
      }
      // Drop the background-sync callback so it can't fire into a dead
      // closure after the app closes.
      if (emailBg) emailBg.onChange = null;
    };

    // Storage
    function loadAccts() {
      try {
        const raw = localStorage.getItem(SK);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function saveAccts() {
      try {
        // Strip pass before persisting; credCache holds it in-memory only.
        const safe = accounts.map(({ pass: _omit, ...rest }) => rest);
        localStorage.setItem(SK, JSON.stringify(safe));
        emailBg?.setAccounts?.(accounts);
      } catch (e) {
        // QuotaExceededError, SecurityError, etc. — don't let a storage
        // failure crash the app, but warn so the user knows persistence
        // didn't happen.
        logError('saveAccts', e);
      }
    }

    function loadDrafts() {
      try {
        const raw = localStorage.getItem(SK_DRAFT);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function saveDraft(draft) {
      try {
        const drafts = loadDrafts();
        drafts.unshift(draft);
        localStorage.setItem(SK_DRAFT, JSON.stringify(drafts.slice(0, 50)));
        return true;
      } catch (e) {
        logError('saveDraft', e);
        return false;
      }
    }

    // Packaged-app API bridge. Keep the original /api/email call shape inside
    // the app so the UI/logic stays functionally identical, while privileged
    // mail operations cross the authenticated nova:mail IPC boundary.
    async function api(method, path, body, params, signal) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const m = method.toUpperCase();
      const p = String(path || '');
      let result;
      if (m === 'GET' && p === '/restore') {
        result = await window.nova.mail.account();
        return result?.data || result;
      }
      if (m === 'GET' && p === '/folders') {
        result = await window.nova.mail.folders();
        return result?.data || result;
      }
      if (m === 'GET' && p === '/messages') {
        result = await window.nova.mail.messages({ ...(params || {}) });
        return result?.data || result;
      }
      if (m === 'GET' && p === '/search') {
        result = await window.nova.mail.search(params?.q || params?.query || '', params?.folder);
        return result?.data || result;
      }
      if (m === 'GET' && p === '/message') {
        result = await window.nova.mail.message(params?.uid, params?.folder);
        return result?.data || result;
      }
      if (m === 'POST' && p === '/connect') {
        result = await window.nova.mail.connect(body || {});
        return result?.data || result;
      }
      if (m === 'POST' && p === '/disconnect') {
        result = await window.nova.mail.disconnect();
        return result?.data || result;
      }
      if (m === 'POST' && p === '/batch') {
        const q = body || {};
        if (q.op === 'delete') result = await window.nova.mail.remove(q.uids || [], q.folder || 'INBOX');
        else if (q.op === 'move') result = await window.nova.mail.move(q.uids || [], q.dest, q.folder || 'INBOX');
        else result = await window.nova.mail.markRead(q.uids || [], q.folder || 'INBOX');
        return result?.data || result;
      }
      if (m === 'POST' && p === '/send') {
        const q = body instanceof FormData ? (() => {
          const out = {};
          for (const [k, v] of body.entries()) {
            if (k === 'attachments' && v instanceof File) {
              out.attachments = out.attachments || [];
              out.attachments.push(v);
            } else {
              out[k] = v;
            }
          }
          return out;
        })() : { ...(body || {}) };

        if (Array.isArray(q.attachments)) {
          q.attachments = await Promise.all(q.attachments.map(async file => ({
            filename: file.name,
            contentType: file.type || 'application/octet-stream',
            contentBase64: await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
              reader.onerror = () => reject(reader.error || new Error('Unable to read attachment'));
              reader.readAsDataURL(file);
            }),
          })));
        }
        result = await window.nova.mail.send(q);
        return result?.data || result;
      }
      throw new Error(`Unsupported email API route: ${m} ${p}`);
    }

    async function ensureConnected(acct, signal) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const pass = credCache[acct.id]?.pass;
      if (pass) {
        await api('POST', '/connect', {
          type: acct.type, host: acct.host, port: acct.port,
          ssl: acct.ssl, user: acct.user, pass,
        }, null, signal);
        return;
      }
      // Passwords intentionally live only in-memory. On a later launch, restore
      // the authenticated host-side email session before asking for messages.
      const restored = await api('GET', '/restore', null, null, signal);
      if (!restored?.restored && restored?.connected !== true) {
        throw new Error('Email session expired — reconnect this account');
      }
    }

    function getActiveAcct() {
      if (activeAcctId === 'all') return accounts[0] || null;
      return accounts.find(a => a.id === activeAcctId) || null;
    }

    // Root
    const root = createEl('div', { className: 'em-root' });
    content.appendChild(root);

    // TOOLBAR
    const toolbar = createEl('div', { className: 'em-toolbar' });
    const menuBtn = createEl('button', {
      className: 'btn btn-sm em-tb-btn',
      title: 'Toggle sidebar',
      innerHTML: '&#9776;',
    });
    const acctLabel = createEl('span', {
      style: 'font-size:13px;font-weight:600;color:var(--text-primary);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
    });
    const tbSep = createEl('div', { className: 'em-tb-sep' });
    const refreshBtn = createEl('button', {
      className: 'btn btn-sm em-tb-btn',
      title: 'Refresh',
      innerHTML: svgIcon('refresh', 14),
    });
    const composeBtn = createEl('button', {
      className: 'btn btn-primary em-tb-btn em-primary',
      innerHTML: '&#9998; Compose',
    });
    toolbar.append(menuBtn, acctLabel, tbSep, refreshBtn, composeBtn);
    root.appendChild(toolbar);

    // MAIN
    const mainEl = createEl('div', { className: 'em-main' });
    root.appendChild(mainEl);

    // Sidebar
    const sidebar = createEl('div', { className: 'em-sidebar' });
    mainEl.appendChild(sidebar);
    let sidebarHidden = false;
    menuBtn.addEventListener('click', () => {
      sidebarHidden = !sidebarHidden;
      sidebar.classList.toggle('hidden', sidebarHidden);
    }, { signal: appSignal });

    // List column
    const listCol = createEl('div', { className: 'em-list-col' });
    mainEl.appendChild(listCol);

    const listTb = createEl('div', { className: 'em-list-tb' });
    const selectAllChk = createEl('input', {
      type: 'checkbox',
      title: 'Select all',
      style: 'accent-color:var(--accent);cursor:pointer;flex-shrink:0;',
    });
    const searchInp = createEl('input', {
      className: 'em-search',
      type: 'search',
      placeholder: 'Search…',
    });
    listTb.append(selectAllChk, searchInp);
    listCol.appendChild(listTb);

    const batchBar = createEl('div', { className: 'em-batch-bar' });
    const batchLbl = createEl('span', { style: 'flex:1' });
    const batchReadBtn = createEl('button', { className: 'btn btn-sm em-btn', textContent: 'Mark read' });
    const batchTrashBtn = createEl('button', { className: 'btn btn-danger btn-sm em-btn danger', textContent: 'Delete' });
    batchBar.append(batchLbl, batchReadBtn, batchTrashBtn);
    listCol.appendChild(batchBar);

    const msgListEl = createEl('div', { className: 'em-msg-list' });
    listCol.appendChild(msgListEl);

    const paginationEl = createEl('div', { className: 'em-pagination' });
    const prevBtn = createEl('button', { className: 'btn btn-sm em-btn', textContent: '‹ Prev' });
    const pageLbl = createEl('span');
    const nextBtn = createEl('button', { className: 'btn btn-sm em-btn', textContent: 'Next ›' });
    paginationEl.append(prevBtn, pageLbl, nextBtn);
    listCol.appendChild(paginationEl);

    // Reader pane
    const readerEl = createEl('div', { className: 'em-reader' });
    mainEl.appendChild(readerEl);
    window.addEventListener('message', (event) => {
      const iframe = readerEl.querySelector('iframe[title="Email body"]');
      const link = event.data;
      if (event.source !== iframe?.contentWindow || link?.type !== 'nbosp:email-link' || typeof link.href !== 'string') return;

      let url;
      try {
        url = new URL(link.href);
      } catch {
        return;
      }
      if (url.protocol === 'mailto:') {
        ourMailto(url.href);
        return;
      }
      if (!['http:', 'https:'].includes(url.protocol)) return;
      const openLink = window.nova?.mail?.openLink;
      if (typeof openLink !== 'function') {
        notify('Could not open this link in Browser.', 'error');
        return;
      }
      openLink(url.href).catch((error) => {
        logError('Could not open message link', error);
        notify('Could not open this link in Browser.', 'error');
      });
    }, { signal: appSignal });

    // Setup screen (overlays main)
    const setupScreen = createEl('div', { className: 'em-setup', style: 'display:none;' });
    root.appendChild(setupScreen);

    // SIDEBAR RENDER
    function buildSidebar() {
      sidebar.replaceChildren();

      if (accounts.length > 1) {
        sidebar.appendChild(createEl('div', { className: 'em-sb-section', textContent: 'Accounts' }));
        const row = createEl('div', {
          className: 'em-sb-row' + (activeAcctId === 'all' ? ' active' : ''),
        });
        row.textContent = '📬 Combined Inbox';
        row.addEventListener('click', () => {
          activeAcctId = 'all';
          activeFolder = 'INBOX';
          page = 1;
          searchQ = '';
          searchInp.value = '';
          buildSidebar();
          loadMessages();
        }, { signal: appSignal });
        sidebar.appendChild(row);
      }

      accounts.forEach(acct => {
        const hdr = createEl('div', {
          className: 'em-sb-section',
          style: 'color:' + acct.color + ';',
        });
        hdr.textContent = acct.name || acct.email;
        sidebar.appendChild(hdr);

        const folders = acct.folders && acct.folders.length
          ? acct.folders
          : DEFAULT_FOLDERS;
        folders.forEach(f => {
          const icon = FICONS[(f.name || f.path).toLowerCase()] || '📁';
          const active = activeAcctId === acct.id && activeFolder === f.path;
          const row = createEl('div', {
            className: 'em-sb-row' + (active ? ' active' : ''),
          });
          row.appendChild(createEl('span', {
            textContent: icon + ' ' + f.name,
            style: 'flex:1',
          }));
          const key = uidKey(acct.id, f.path);
          if (unreadMap[key]) {
            row.appendChild(createEl('span', {
              className: 'em-sb-badge',
              textContent: String(unreadMap[key]),
            }));
          }
          row.addEventListener('click', () => {
            activeAcctId = acct.id;
            activeFolder = f.path;
            page = 1;
            searchQ = '';
            searchInp.value = '';
            buildSidebar();
            loadMessages();
          }, { signal: appSignal });
          sidebar.appendChild(row);
        });
      });

      const addRow = createEl('div', {
        className: 'em-sb-row',
        style: 'color:var(--accent);margin-top:6px;',
      });
      addRow.textContent = '＋ Add Account';
      addRow.addEventListener('click', () => buildSetup(null), { signal: appSignal });
      sidebar.appendChild(addRow);

      if (accounts.length) {
        const settRow = createEl('div', {
          className: 'em-sb-row',
          style: 'color:var(--text-secondary);',
        });
        settRow.textContent = '⚙ Settings';
        settRow.addEventListener('click', () => {
          const acct = accounts.find(a => a.id === activeAcctId) || accounts[0];
          buildSetup(acct);
        }, { signal: appSignal });
        sidebar.appendChild(settRow);
      }

      acctLabel.textContent = activeAcctId === 'all'
        ? 'Combined Inbox'
        : (accounts.find(a => a.id === activeAcctId)?.name || 'Email');
    }

    // SETUP WIZARD
    function buildSetup(existing) {
      setupScreen.replaceChildren();
      mainEl.style.display = 'none';
      setupScreen.style.display = '';

      const card = createEl('div', { className: 'em-setup-card' });
      card.appendChild(createEl('div', {
        className: 'em-setup-title',
        textContent: existing ? 'Edit Account' : 'Add Email Account',
      }));

      // Protocol selector
      card.appendChild(createEl('div', { className: 'em-lbl', textContent: 'Protocol' }));
      const protoRow = createEl('div', { className: 'em-proto-row' });
      let proto = existing?.type || 'imap';
      ['imap', 'pop3', 'exchange'].forEach(p => {
        const b = createEl('button', {
          className: 'btn btn-sm em-proto-btn' + (proto === p ? ' active' : ''),
          textContent: p === 'exchange' ? 'Exchange' : p.toUpperCase(),
        });
        b.addEventListener('click', () => {
          proto = p;
          protoRow.querySelectorAll('.em-proto-btn').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          portInp.value = PROTO_DEFAULTS[p];
          sslChk.checked = true;
        }, { signal: appSignal });
        protoRow.appendChild(b);
      });
      card.appendChild(protoRow);

      const { wrapper: nameW, inp: nameInp } = makeFieldRow('Display Name', 'text', 'Work Email', existing?.name || '');
      const { wrapper: hostW, inp: hostInp } = makeFieldRow('Incoming Server (IMAP/POP3/EWS Host)', 'text', 'mail.example.com', existing?.host || '');
      const { wrapper: userW, inp: userInp } = makeFieldRow('Username / Email', 'email', 'user@example.com', existing?.user || '');
      const { wrapper: passW, inp: passInp } = makeFieldRow('Password', 'password', '••••••••', (existing && credCache[existing.id]?.pass) || '');

      const row2 = createEl('div', { className: 'em-row2' });
      const { wrapper: portW, inp: portInp } = makeFieldRow('Port', 'number', '993', existing?.port || '993');
      const sslW = createEl('div', { style: 'display:flex;flex-direction:column;gap:3px;' });
      sslW.appendChild(createEl('div', { className: 'em-lbl', textContent: 'SSL/TLS' }));
      const sslR = createEl('div', { style: 'display:flex;align-items:center;gap:6px;padding-top:10px;' });
      const sslChk = createEl('input', {
        type: 'checkbox',
        style: 'width:15px;height:15px;accent-color:var(--accent);cursor:pointer;',
        checked: existing?.ssl !== false,
      });
      sslR.append(sslChk, createEl('span', { textContent: 'Enabled', style: 'font-size:12px;color:var(--text-secondary);' }));
      sslW.appendChild(sslR);
      row2.append(portW, sslW);

      // SMTP section (optional — used for sending via IMAP/POP3 accounts)
      const smtpSection = createEl('div', {
        style: 'display:flex;flex-direction:column;gap:8px;padding:8px;background:rgba(255,255,255,.03);border-radius:8px;border:1px solid var(--border);',
      });
      smtpSection.appendChild(createEl('div', {
        className: 'em-lbl',
        textContent: 'Outgoing Mail (SMTP) — optional',
      }));
      const smtpRow = createEl('div', { className: 'em-row2' });
      const { wrapper: smtpHostW, inp: smtpHostInp } = makeFieldRow('SMTP Host', 'text', 'smtp.example.com', existing?.smtpHost || '');
      const { wrapper: smtpPortW, inp: smtpPortInp } = makeFieldRow('SMTP Port', 'number', '587', existing?.smtpPort || '587');
      smtpRow.append(smtpHostW, smtpPortW);
      smtpSection.appendChild(smtpRow);

      const { wrapper: syncW, inp: syncInp } = makeFieldRow('Check every (mins, 0 = manual)', 'number', '15', String(existing?.syncInterval ?? 15));
      const sigW = createEl('div', { style: 'display:flex;flex-direction:column;gap:3px;' });
      sigW.appendChild(createEl('div', { className: 'em-lbl', textContent: 'Signature' }));
      const sigTa = createEl('textarea', {
        className: 'em-input',
        id: 'email-signature-input',
        name: 'email-signature',
        placeholder: 'Sent from NBOSP Email',
        style: 'min-height:56px;resize:vertical;',
        value: existing?.signature || '',
      });
      sigW.appendChild(sigTa);

      const errEl = createEl('div', { style: 'color:#e55;font-size:12px;min-height:14px;' });
      const footRow = createEl('div', { style: 'display:flex;gap:8px;' });
      const cancelBtn = createEl('button', {
        className: 'btn btn-sm em-btn',
        textContent: 'Cancel',
        style: 'flex-shrink:0;',
      });
      const saveBtn = createEl('button', {
        textContent: existing ? 'Save' : 'Add Account',
        style: 'flex:1;padding:9px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;',
      });

      if (existing) {
        const delBtn = createEl('button', {
          className: 'btn btn-danger btn-sm em-btn danger',
          textContent: 'Remove',
          style: 'flex-shrink:0;',
        });
        delBtn.addEventListener('click', async () => {
          delete credCache[existing.id];
          accounts = accounts.filter(a => a.id !== existing.id);
          saveAccts();
          // Clear session credentials for the removed account so the server
          // doesn't retain them in req.session.emailCreds after removal.
          api('POST', '/disconnect').catch(e => logError('disconnect', e));
          if (!accounts.length) {
            setupScreen.style.display = 'none';
            mainEl.style.display = '';
            showEmpty();
            buildSetup(null);
          } else {
            activeAcctId = accounts[0].id;
            showMain();
          }
        }, { signal: appSignal });
        footRow.appendChild(delBtn);
      }

      cancelBtn.addEventListener('click', () => {
        if (accounts.length) showMain();
        else {
          setupScreen.style.display = 'none';
          mainEl.style.display = '';
        }
      }, { signal: appSignal });

      saveBtn.addEventListener('click', async () => {
        const host = hostInp.value.trim();
        const user = userInp.value.trim();
        const pass = passInp.value;
        if (!host || !user || !pass) {
          errEl.textContent = 'Host, username and password are required.';
          return;
        }
        errEl.textContent = '';
        saveBtn.textContent = 'Connecting…';
        saveBtn.disabled = true;
        try {
          await api('POST', '/connect', {
            type: proto, host, port: portInp.value, ssl: sslChk.checked, user, pass,
          });
          const acctId = existing?.id || Date.now().toString(36);
          // Store pass only in credCache (in-memory), never on the acct object.
          credCache[acctId] = { user, pass };
          const acct = {
            id: acctId,
            name: nameInp.value.trim() || user,
            email: user,
            type: proto,
            host,
            port: portInp.value,
            ssl: sslChk.checked,
            user,
            smtpHost: smtpHostInp.value.trim(),
            smtpPort: smtpPortInp.value,
            signature: sigTa.value.trim(),
            syncInterval: parseInt(syncInp.value, 10) || 0,
            color: existing?.color || COLORS[accounts.length % COLORS.length],
            folders: null,
          };
          if (existing) {
            accounts = accounts.map(a => a.id === acct.id ? acct : a);
          } else {
            accounts.push(acct);
          }
          saveAccts();
          // Fetch the real folder list (best-effort; non-fatal if it fails).
          try {
            const fd = await api('GET', '/folders');
            acct.folders = fd.folders;
            saveAccts();
          } catch (e) {
            logError('fetch folders after connect', e);
          }
          activeAcctId = acct.id;
          activeFolder = 'INBOX';
          showMain();
          scheduleSyncAll();
          notify('"' + acct.name + '" connected.', 'success');
        } catch (e) {
          errEl.textContent = e.message;
        } finally {
          saveBtn.textContent = existing ? 'Save' : 'Add Account';
          saveBtn.disabled = false;
        }
      }, { signal: appSignal });

      footRow.append(cancelBtn, saveBtn);
      card.append(nameW, hostW, userW, passW, row2, smtpSection, syncW, sigW, errEl, footRow);
      setupScreen.appendChild(card);
    }

    // LOAD MESSAGES
    // Each call cancels the previous in-flight load via loadController so a
    // slow response can't overwrite a newer one (race condition fix).
    async function loadMessages() {
      loadController?.abort();
      loadController = new AbortController();
      const { signal } = loadController;

      if (!(await hasPermission('mail:read'))) {
        notify('Email needs mail:read permission.', 'error', 'Permission denied');
        messages = [];
        renderMsgList();
        return;
      }
      if (!accounts.length) return;

      loading = true;
      messages = [];
      renderMsgList();

      try {
        if (activeAcctId === 'all') {
          const results = await Promise.allSettled(accounts.map(async acct => {
            await ensureConnected(acct, signal);
            const d = await api('GET', '/messages', null, {
              folder: 'INBOX', page: 1, limit: PAGE_SIZE,
            }, signal);
            return (d.messages || []).map(m => ({
              ...m,
              _acctId: acct.id,
              _acctName: acct.name || acct.email,
            }));
          }));
          if (signal.aborted) return;
          const all = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
          all.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
          messages = all.slice(0, COMBINED_LIMIT);
          pages = 1;
        } else {
          const acct = getActiveAcct();
          if (!acct) return;
          await ensureConnected(acct, signal);
          const params = { folder: activeFolder, page, limit: PAGE_SIZE };
          if (searchQ) params.q = searchQ;
          const d = await api('GET', searchQ ? '/search' : '/messages', null, params, signal);
          if (signal.aborted) return;
          messages = d.messages || [];
          pages = d.pages || 1;
          unreadMap[uidKey(acct.id, activeFolder)] = messages.filter(m => !m.seen).length;
          // Fetch the folder list once if missing (best-effort, non-fatal).
          if (!acct.folders) {
            api('GET', '/folders', null, null, signal)
              .then(fd => {
                acct.folders = fd.folders;
                saveAccts();
                buildSidebar();
              })
              .catch(e => logError('fetch folders', e));
          }
          buildSidebar();
        }
      } catch (e) {
        if (e?.name === 'AbortError') return;
        messages = [];
        notify(e.message, 'error');
      } finally {
        if (!signal.aborted) {
          loading = false;
          renderMsgList();
        }
      }
    }

    // RENDER MESSAGE LIST
    function renderMsgList() {
      msgListEl.replaceChildren();
      selectedUids.clear();
      selectAllChk.checked = false;
      batchBar.style.display = 'none';

      if (loading) {
        const w = createEl('div', {
          style: 'display:flex;align-items:center;justify-content:center;padding:36px;',
        });
        w.appendChild(createEl('div', { className: 'em-spinner' }));
        msgListEl.appendChild(w);
        return;
      }

      if (!messages.length) {
        const w = createEl('div', { className: 'em-empty' });
        w.appendChild(document.createTextNode('📭'));
        w.appendChild(document.createElement('br'));
        w.appendChild(createEl('span', {
          textContent: searchQ ? 'No results' : 'No messages',
        }));
        msgListEl.appendChild(w);
        paginationEl.style.display = 'none';
        return;
      }

      const fragment = document.createDocumentFragment();
      messages.forEach(msg => {
        const isActive = msg.uid === activeMsgUid;
        const row = createEl('div', {
          className: 'em-msg-row' + (!msg.seen ? ' unread' : '') + (isActive ? ' active' : ''),
        });
        row.dataset.uid = String(msg.uid);

        const cb = createEl('input', { type: 'checkbox', className: 'em-msg-check' });
        cb.checked = selectedUids.has(msg.uid);
        cb.addEventListener('change', e => {
          e.stopPropagation();
          if (cb.checked) selectedUids.add(msg.uid);
          else selectedUids.delete(msg.uid);
          updateBatchBar();
        });

        const fromText = msg.from || '(unknown)';
        const av = createEl('div', {
          className: 'em-avatar',
          textContent: fromText[0].toUpperCase(),
          style: 'background:' + avatarColor(msg.from || '') + ';',
        });

        const meta = createEl('div', { className: 'em-msg-meta' });
        meta.appendChild(createEl('div', { className: 'em-msg-from', textContent: fromText }));
        meta.appendChild(createEl('div', {
          className: 'em-msg-subj',
          textContent: msg.subject || '(no subject)',
        }));
        if (msg._acctName) {
          meta.appendChild(createEl('div', { className: 'em-msg-acct', textContent: msg._acctName }));
        }

        const date = createEl('div', { className: 'em-msg-date', textContent: fmtDate(msg.date) });
        row.append(cb, av, meta, date);

        // Swipe gestures — passive listeners never call preventDefault, so
        // they don't block scrolling. Listeners die with the row when it's
        // removed, so no manual teardown needed.
        let touchStartX = 0;
        row.addEventListener('touchstart', e => {
          touchStartX = e.touches[0].clientX;
        }, { passive: true, signal: appSignal });
        row.addEventListener('touchend', e => {
          const dx = e.changedTouches[0].clientX - touchStartX;
          if (dx < -70) doDeleteMsg(msg, row);
          else if (dx > 70) doArchiveMsg(msg, row);
        }, { passive: true, signal: appSignal });

        row.addEventListener('click', () => openMsg(msg), { signal: appSignal });
        fragment.appendChild(row);
      });
      msgListEl.appendChild(fragment);

      paginationEl.style.display = pages > 1 ? 'flex' : 'none';
      if (pages > 1) {
        pageLbl.textContent = page + ' / ' + pages;
        prevBtn.disabled = page <= 1;
        nextBtn.disabled = page >= pages;
      }
    }

    function updateBatchBar() {
      const n = selectedUids.size;
      batchBar.style.display = n ? 'flex' : 'none';
      if (n) {
        batchLbl.textContent = n + ' selected';
        // Guard against the edge case where messages.length is 0 — without
        // the `n > 0` check, `0 === 0` would tick the box erroneously.
        selectAllChk.checked = n === messages.length;
      } else {
        selectAllChk.checked = false;
      }
    }

    selectAllChk.addEventListener('change', () => {
      if (selectAllChk.checked) {
        messages.forEach(m => selectedUids.add(m.uid));
      } else {
        selectedUids.clear();
      }
      updateBatchBar();
      msgListEl.querySelectorAll('.em-msg-check').forEach(cb => {
        cb.checked = selectAllChk.checked;
      });
    }, { signal: appSignal });

    batchTrashBtn.addEventListener('click', async () => {
      if (!selectedUids.size) return;
      const uids = [...selectedUids];
      const acct = getActiveAcct();
      if (!acct) return;
      try {
        await ensureConnected(acct);
        await api('POST', '/batch', { op: 'delete', uids, folder: activeFolder });
        messages = messages.filter(m => !selectedUids.has(m.uid));
        selectedUids.clear();
        renderMsgList();
        notify(uids.length + ' deleted.');
      } catch (e) {
        notify(e.message, 'error');
      }
    }, { signal: appSignal });

    batchReadBtn.addEventListener('click', async () => {
      if (!selectedUids.size) return;
      const uids = [...selectedUids];
      const acct = getActiveAcct();
      if (!acct) return;
      try {
        await ensureConnected(acct);
        await api('POST', '/batch', { op: 'read', uids, folder: activeFolder });
        messages = messages.map(m => selectedUids.has(m.uid) ? { ...m, seen: true } : m);
        selectedUids.clear();
        renderMsgList();
      } catch (e) {
        notify(e.message, 'error');
      }
    }, { signal: appSignal });

    // MESSAGE READER
    function showEmpty() {
      readerEl.replaceChildren();
      const w = createEl('div', { className: 'em-empty' });
      const icon = createEl('div');
      icon.textContent = '✉';
      w.append(icon, document.createElement('br'), createEl('span', { textContent: 'Select a message to read' }));
      readerEl.appendChild(w);
    }

    async function openMsg(msg) {
      activeMsgUid = msg.uid;
      msgListEl.querySelectorAll('.em-msg-row').forEach(r => {
        r.classList.toggle('active', r.dataset.uid === String(msg.uid));
      });
      readerEl.replaceChildren();
      const sp = createEl('div', { className: 'em-empty' });
      sp.appendChild(createEl('div', { className: 'em-spinner' }));
      readerEl.appendChild(sp);

      try {
        const acct = msg._acctId
          ? accounts.find(a => a.id === msg._acctId)
          : getActiveAcct();
        if (!acct) throw new Error('Account not found');
        await ensureConnected(acct);
        const full = await api('GET', '/message', null, { folder: activeFolder, uid: msg.uid });
        msg.seen = true;
        // CSS.escape prevents a malformed UID from breaking the attribute
        // selector or enabling selector injection.
        msgListEl.querySelector('.em-msg-row[data-uid="' + CSS.escape(String(msg.uid)) + '"]')
          ?.classList.remove('unread');
        renderReader(full, msg, acct);
      } catch (e) {
        readerEl.replaceChildren();
        const w = createEl('div', { className: 'em-empty', style: 'color:#e55;' });
        w.textContent = e.message;
        readerEl.appendChild(w);
      }
    }

    async function renderReader(full, msg, acct) {
      readerEl.replaceChildren();

      const hdr = createEl('div', { className: 'em-reader-hdr' });
      hdr.appendChild(createEl('div', {
        className: 'em-reader-subj',
        textContent: full.subject || '(no subject)',
      }));
      const meta = createEl('div', { className: 'em-reader-meta' });
      if (full.from) meta.appendChild(createEl('span', { textContent: 'From: ' + full.from }));
      if (full.to) meta.appendChild(createEl('span', { textContent: 'To: ' + full.to }));
      if (full.cc) meta.appendChild(createEl('span', { textContent: 'CC: ' + full.cc }));
      if (full.date) {
        meta.appendChild(createEl('span', { textContent: new Date(full.date).toLocaleString() }));
      }
      hdr.appendChild(meta);

      const acts = createEl('div', { className: 'em-reader-actions' });
      const replyBtn = createEl('button', { className: 'btn btn-sm em-btn' });
      replyBtn.innerHTML = svgIcon('corner-up-left', 13) + ' Reply';
      const fwdBtn = createEl('button', { className: 'btn btn-sm em-btn' });
      fwdBtn.innerHTML = svgIcon('corner-up-right', 13) + ' Forward';
      const delBtn = createEl('button', { className: 'btn btn-danger btn-sm em-btn danger' });
      delBtn.innerHTML = svgIcon('x', 13) + ' Delete';
      acts.append(replyBtn, fwdBtn, delBtn);
      hdr.appendChild(acts);
      readerEl.appendChild(hdr);

      const replyPrefill = {
        to: full.from,
        subject: 'Re: ' + (full.subject || ''),
        body: '\n\n----\nOn ' + new Date(full.date).toLocaleString() + ', ' + full.from + ' wrote:\n' + (full.text || ''),
      };
      replyBtn.addEventListener('click', () => openCompose(replyPrefill, acct), { signal: appSignal });

      const fwdPrefill = {
        subject: 'Fwd: ' + (full.subject || ''),
        body: '\n\n----\nFrom: ' + full.from + '\nDate: ' + new Date(full.date).toLocaleString() + '\nSubject: ' + full.subject + '\n\n' + (full.text || ''),
      };
      fwdBtn.addEventListener('click', () => openCompose(fwdPrefill, acct), { signal: appSignal });

      const rowEl = msgListEl.querySelector('.em-msg-row[data-uid="' + CSS.escape(String(msg.uid)) + '"]');
      delBtn.addEventListener('click', () => doDeleteMsg(msg, rowEl), { signal: appSignal });

      // Body — render HTML inside a sandboxed iframe; only the injected link
      // bridge can execute, and the iframe never gets same-origin access.
      const bodyEl = createEl('div', { className: 'em-reader-body' });
      if (full.html) {
        // The server sanitises full.html in GET /message before returning it.
        // We run DOMPurify again client-side as defence-in-depth and keep
        // safe target/rel attributes; link navigation is forwarded by the
        // sandboxed iframe bridge below.
        const sanitized = sanitizeEmailHtml(full.html);
        const hasDoc = /^<!doctype/i.test(sanitized.trimStart()) || /^<html[\s>]/i.test(sanitized.trimStart());
        const iframe = createEl('iframe', {
          sandbox: 'allow-scripts',
          title: 'Email body',
          referrerpolicy: 'no-referrer',
        });
        const emailDocument = hasDoc
          ? sanitized
          : '<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:0;word-wrap:break-word}</style></head><body>' + sanitized + '</body></html>';
        iframe.srcdoc = injectEmailLinkBridge(emailDocument);
        bodyEl.appendChild(iframe);
        readerEl.appendChild(bodyEl);
      } else {
        bodyEl.appendChild(createEl('div', {
          className: 'em-text-body',
          textContent: full.text || '(empty message)',
        }));
        readerEl.appendChild(bodyEl);
      }

      // Attachments
      if (full.attachments?.length) {
        const row = createEl('div', { className: 'em-attachments' });
        full.attachments.forEach(a => {
          const chip = createEl('div', { className: 'em-attach-chip' });
          chip.appendChild(document.createTextNode('📄 ' + (a.filename || 'attachment')));
          if (a.size) {
            const sz = createEl('span', { textContent: ' ' + fmtSize(a.size) });
            sz.style.opacity = '0.6';
            chip.appendChild(sz);
          }
          row.appendChild(chip);
        });
        readerEl.appendChild(row);
      }
    }

    // Sanitise email HTML with DOMPurify, forcing links to open safely.
    // The afterSanitizeAttributes hook is always removed via finally —
    // previously a throw inside sanitize() would leak the hook permanently
    // onto DOMPurify's global registry.
    function sanitizeEmailHtml(html) {
      if (typeof DOMPurify === 'undefined') return html;
      DOMPurify.addHook('afterSanitizeAttributes', forceSafeLinks);
      try {
        return DOMPurify.sanitize(html);
      } finally {
        DOMPurify.removeHook('afterSanitizeAttributes');
      }
    }

    function injectEmailLinkBridge(html) {
      const bridge = '<script>(function(){document.addEventListener("click",function(event){var link=event.target.closest&&event.target.closest("a[href]");if(!link)return;event.preventDefault();parent.postMessage({type:"nbosp:email-link",href:link.href},"*");},true);})();</script>';
      return /<\/body\s*>/i.test(html)
        ? html.replace(/<\/body\s*>/i, bridge + '</body>')
        : html + bridge;
    }

    function forceSafeLinks(node) {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }

    // DELETE / ARCHIVE
    async function doDeleteMsg(msg, rowEl) {
      if (!(await hasPermission('mail:delete'))) {
        notify('Email needs mail:delete to remove messages.', 'error', 'Permission denied');
        return;
      }
      try {
        const acct = msg._acctId ? accounts.find(a => a.id === msg._acctId) : getActiveAcct();
        if (!acct) return;
        await ensureConnected(acct);
        await api('POST', '/batch', { op: 'delete', uids: [msg.uid], folder: activeFolder });
        animateRowRemoval(rowEl, 40);
        messages = messages.filter(m => m.uid !== msg.uid);
        if (activeMsgUid === msg.uid) {
          activeMsgUid = null;
          showEmpty();
        }
        notify('Deleted.');
      } catch (e) {
        notify(e.message, 'error');
      }
    }

    async function doArchiveMsg(msg, rowEl) {
      if (!(await hasPermission('mail:delete'))) {
        notify('Email needs mail:delete to archive messages.', 'error', 'Permission denied');
        return;
      }
      try {
        const acct = msg._acctId ? accounts.find(a => a.id === msg._acctId) : getActiveAcct();
        if (!acct) return;
        await ensureConnected(acct);
        await api('POST', '/batch', { op: 'move', uids: [msg.uid], folder: activeFolder, dest: 'Archive' });
        animateRowRemoval(rowEl, -40);
        messages = messages.filter(m => m.uid !== msg.uid);
        notify('Archived.');
      } catch (e) {
        notify(e.message, 'error');
      }
    }

    // Slide the row out, then remove it from the DOM after the transition
    // finishes. Using transform/opacity only — never animate layout-triggering
    // properties like width/left.
    function animateRowRemoval(rowEl, translateX) {
      if (!rowEl) return;
      rowEl.style.transition = 'opacity .18s, transform .18s';
      rowEl.style.opacity = '0';
      rowEl.style.transform = 'translateX(' + translateX + 'px)';
      setTimeout(() => rowEl.remove(), ROW_ANIM_MS);
    }

    // COMPOSE
    function openCompose(prefill = {}, fromAcct = null) {
      if (!true) {
        notify('Email needs mail:write to compose.', 'error', 'Permission denied');
        return;
      }
      root.querySelector('.em-compose-overlay')?.remove();
      const overlay = createEl('div', { className: 'em-compose-overlay' });
      const win = createEl('div', { className: 'em-compose-win' });

      // Header
      const hdr = createEl('div', { className: 'em-compose-hdr' });
      hdr.appendChild(createEl('span', { textContent: 'New Message', style: 'flex:1' }));
      const minBtn = createEl('button', { className: 'em-tb-btn', textContent: '−', title: 'Minimize' });
      const closeXB = createEl('button', { className: 'em-tb-btn', textContent: '✕', title: 'Close' });
      hdr.append(minBtn, closeXB);

      let minimized = false;
      minBtn.addEventListener('click', () => {
        minimized = !minimized;
        win.style.maxHeight = minimized ? '44px' : '88%';
      }, { signal: appSignal });

      const closeOverlay = () => {
        const body = bodyTa.value.trim();
        if (body || toInp.value.trim()) {
          const saved = saveDraft({
            id: Date.now().toString(36),
            to: toInp.value,
            cc: ccInp.value,
            bcc: bccInp.value,
            subject: subjInp.value,
            body,
            savedAt: new Date().toISOString(),
          });
          if (saved) notify('Draft saved.');
        }
        overlay.remove();
      };
      closeXB.addEventListener('click', closeOverlay, { signal: appSignal });

      // Fields
      const fieldsEl = createEl('div', { style: 'flex-shrink:0;' });
      const { row: toRow, inp: toInp } = makeComposeField('To', 'email', 'recipient@example.com');
      const { row: ccRow, inp: ccInp } = makeComposeField('Cc', 'email', '');
      const { row: bccRow, inp: bccInp } = makeComposeField('Bcc', 'email', '');
      const { row: subjRow, inp: subjInp } = makeComposeField('Subject', 'text', 'Subject');

      if (prefill.to) toInp.value = prefill.to;
      if (prefill.subject) subjInp.value = prefill.subject;

      // Cc/Bcc toggle — hidden until the user clicks the toggle.
      ccRow.style.display = 'none';
      bccRow.style.display = 'none';
      const ccToggle = createEl('button', {
        className: 'btn btn-sm em-btn',
        textContent: 'Cc/Bcc',
        style: 'font-size:10px;padding:2px 6px;',
      });
      toRow.appendChild(ccToggle);
      ccToggle.addEventListener('click', () => {
        const show = ccRow.style.display === 'none';
        ccRow.style.display = show ? '' : 'none';
        bccRow.style.display = show ? '' : 'none';
      }, { signal: appSignal });

      fieldsEl.append(toRow, ccRow, bccRow, subjRow);

      const acct = fromAcct || getActiveAcct();
      const sig = acct?.signature ? '\n\n--\n' + acct.signature : '';
      const bodyTa = createEl('textarea', {
        className: 'em-cbody',
        id: 'email-body-input',
        name: 'email-body',
        placeholder: 'Write your message…',
        value: (prefill.body || '') + sig,
      });

      // Attachments — collected client-side and sent as multipart form data
      // so the server receives the actual file bytes alongside the message.
      const fileInp = createEl('input', {
        type: 'file',
        multiple: true,
        style: 'display:none;',
      });
      const attachListEl = createEl('div', {
        style: 'display:flex;flex-wrap:wrap;gap:4px;padding:0 12px 4px;flex-shrink:0;',
      });
      let attachedFiles = [];
      fileInp.addEventListener('change', () => {
        attachedFiles = [...fileInp.files];
        attachListEl.replaceChildren();
        attachedFiles.forEach(f => {
          attachListEl.appendChild(createEl('span', {
            className: 'em-attach-chip',
            textContent: '📎 ' + f.name + ' (' + fmtSize(f.size) + ')',
          }));
        });
        // Reset the input so selecting the same file again still fires change.
        fileInp.value = '';
      }, { signal: appSignal });

      // Footer
      const foot = createEl('div', { className: 'em-compose-foot' });
      const sendBtn = createEl('button', {
        textContent: 'Send',
        style: 'background:var(--accent);color:#fff;border:none;border-radius:7px;padding:6px 16px;font-size:13px;font-weight:600;cursor:pointer;',
      });
      const attachBtn = createEl('button', {
        className: 'btn btn-sm em-btn',
        innerHTML: '&#128206;',
        title: 'Attach file',
      });
      const errSpan = createEl('span', { style: 'font-size:11px;color:#e55;flex:1;' });
      attachBtn.addEventListener('click', () => fileInp.click(), { signal: appSignal });

      sendBtn.addEventListener('click', async () => {
        if (!true) {
          notify('Email needs mail:send permission.', 'error', 'Permission denied');
          return;
        }
        if (!true) {
          notify('Email needs mail:write permission to compose.', 'error', 'Permission denied');
          return;
        }
        const to = toInp.value.trim();
        if (!to) { errSpan.textContent = 'Recipient required.'; return; }
        if (!acct) { errSpan.textContent = 'No account selected.'; return; }
        errSpan.textContent = '';
        sendBtn.textContent = 'Sending…';
        sendBtn.disabled = true;
        try {
          const smtpPort = parseInt(acct.smtpPort, 10) || (acct.ssl ? 465 : 587);
          // Don't send pass in the request body — server pulls it from the
          // session (req.session.emailCreds.pass) set by /connect or /restore.
          const baseFields = {
            host: acct.smtpHost || acct.host,
            port: String(smtpPort),
            ssl: String(smtpPort === 465),
            user: acct.user,
            to,
            cc: ccInp.value,
            bcc: bccInp.value,
            subject: subjInp.value,
            text: bodyTa.value,
          };

          if (attachedFiles.length) {
            // Multipart form when there are attachments — server reads files
            // from req.files / multer.
            const fd = new FormData();
            for (const [k, v] of Object.entries(baseFields)) fd.append(k, v);
            for (const f of attachedFiles) fd.append('attachments', f, f.name);
            await api('POST', '/send', fd);
          } else {
            await api('POST', '/send', baseFields);
          }
          notify('Sent.', 'success');
          overlay.remove();
        } catch (e) {
          errSpan.textContent = e.message;
          sendBtn.textContent = 'Send';
          sendBtn.disabled = false;
        }
      }, { signal: appSignal });

      foot.append(sendBtn, attachBtn, fileInp, errSpan);
      win.append(hdr, fieldsEl, attachListEl, bodyTa, foot);
      overlay.appendChild(win);
      root.appendChild(overlay);
      toInp.focus();
    }

    composeBtn.addEventListener('click', () => openCompose(), { signal: appSignal });

    // Support WM.createWindow('com.nbosp.email', { compose: { to, subject, … } })
    if (options?.compose) openCompose(options.compose);

    // SEARCH / PAGINATION
    searchInp.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchQ = searchInp.value.trim();
        page = 1;
        loadMessages();
      }, SEARCH_DEBOUNCE_MS);
    }, { signal: appSignal });
    prevBtn.addEventListener('click', () => {
      if (page > 1) { page--; loadMessages(); }
    }, { signal: appSignal });
    nextBtn.addEventListener('click', () => {
      if (page < pages) { page++; loadMessages(); }
    }, { signal: appSignal });
    refreshBtn.addEventListener('click', () => loadMessages(), { signal: appSignal });

    // SYNC ENGINE + NOTIFICATIONS
    function scheduleSyncAll() {
      emailBg?.ensureBooted?.();
      if (emailBg?.setAccounts) {
        // Replace the previous onChange (if any) — never accumulate callbacks.
        emailBg.onChange = () => {
          if (lifecycle.signal.aborted) return;
          if (activeAcctId === 'all' || activeFolder === 'INBOX') {
            try { buildSidebar(); } catch (e) { logError('bg onChange', e); }
          }
        };
        emailBg.setAccounts(accounts);
      }
      // Clear any timers from a previous scheduleSyncAll call so we don't
      // double-fire after a re-save.
      for (const id of Object.keys(syncTimers)) {
        clearInterval(syncTimers[id]);
        delete syncTimers[id];
      }
      accounts.forEach(acct => {
        const mins = parseInt(acct.syncInterval, 10) || 0;
        if (!mins) return;
        syncTimers[acct.id] = setInterval(() => {
          // Skip the tick if the app has been torn down.
          if (lifecycle.signal.aborted) return;
          syncAccount(acct).catch(e => logError('sync ' + acct.id, e));
        }, mins * 60_000);
      });
    }

    async function syncAccount(acct) {
      await ensureConnected(acct);
      const d = await api('GET', '/messages', null, {
        folder: 'INBOX', page: 1, limit: 10,
      });
      const newUnread = (d.messages || []).filter(m => !m.seen);
      if (!newUnread.length) return;
      if (Notification.permission === 'granted') {
        new Notification(acct.name || acct.email + ' — ' + newUnread.length + ' new', {
          body: decodeEntities(newUnread[0].subject),
          icon: '/assets/apple-touch-icon.svg',
        });
      }
      notify(newUnread.length + ' new in ' + (acct.name || acct.email));
      if (activeAcctId === acct.id && activeFolder === 'INBOX') loadMessages();
    }

    // requestPermission returns undefined in older Safari; wrap in
    // Promise.resolve so .catch is always safe.
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Promise.resolve(Notification.requestPermission()).catch(() => {});
    }

    // BOOTSTRAP
    function showMain() {
      setupScreen.style.display = 'none';
      mainEl.style.display = '';
      buildSidebar();
      loadMessages();
      showEmpty();
    }

    // Guest-local compatibility for the original app's token binding.
    // Mail writes remain authorized by the host IPC permission boundary.
    const csrfToken = window.__csrfToken || document.querySelector('meta[name="csrf-token"]')?.content || '';
    window.__csrfToken = csrfToken;

    accounts = loadAccts();
    emailBg?.ensureBooted?.();

    if (!accounts.length) {
      // First run — show the setup wizard immediately.
      mainEl.style.display = '';
      buildSetup(null);
    } else {
      activeAcctId = accounts.length > 1 ? 'all' : accounts[0].id;
      // Show sidebar and structure without loading messages yet — credentials
      // are restored in the background below, then loadMessages fires.
      setupScreen.style.display = 'none';
      mainEl.style.display = '';
      buildSidebar();
      showEmpty();

      // Restore credentials in the background, then schedule syncs and load.
      // If restore fails we still attempt to load — ensureConnected will
      // handle a missing session by surfacing the 401 to the user.
      api('GET', '/restore')
        .then(restore => {
          if (restore?.restored) {
            console.log('[Email] Credentials auto-restored');
          }
          if (lifecycle.signal.aborted) return;
          scheduleSyncAll();
          loadMessages();
        })
        .catch(e => {
          if (e?.name === 'AbortError') return;
          console.warn('[Email] Auto-restore failed, messages may not load:', e?.message || e);
          if (lifecycle.signal.aborted) return;
          loadMessages();
        });
    }
  }
};

  appConfig.init(document.getElementById('app'), {}, {});
})();
