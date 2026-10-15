'use strict';

// base-utils.js — shared utilities for the flat-module architecture.
// Every public function below is also attached to window.* at the bottom of
// the file so other scripts can call them without an ES module loader.
//
// Design notes:
// - The file is loaded as a classic <script>, so top-level function and class
//   declarations already become properties of window. The explicit assignments
//   at the end are documentation of the intended public surface.
// - DOM access is feature-detected so the file can be imported in Node/jsdom
//   for testing without throwing at parse time.
// - Hot paths (HTML escaping, icon lookup) avoid per-call allocation.

(function () {
  const hasDocument = (typeof document !== 'undefined') && (typeof document.createElement === 'function');
  const hasWindow = (typeof window !== 'undefined');
  const hasRAF = (typeof requestAnimationFrame === 'function');
  const hasCAF = (typeof cancelAnimationFrame === 'function');

  // Pooled element used by the DOM-based escapers. Allocating a fresh <div>
  // on every escape call shows up in profiles when escapeText is called inside
  // list-render loops; one shared element is enough because we only read
  // innerHTML back synchronously.
  const escaperEl = hasDocument ? document.createElement('div') : null;

  // Module-level lookup tables. The original file rebuilt these objects on
  // every svgIcon call, which is both slow and forces the JS engine to keep
  // a fresh object alive for the lifetime of the returned HTML string.
  const BYTE_UNITS = Object.freeze(['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']);
  const DAY_NAMES = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  const MONTH_NAMES = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);

  // Inline SVG paths for the small UI icon set. These return crisp scalable
  // SVGs with no extra HTTP request, so they are checked first.
  const UI_ICONS = Object.freeze({
    'x': '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    'plus': '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    'minus': '<line x1="5" y1="12" x2="19" y2="12"/>',
    'check': '<polyline points="20 6 9 17 4 12"/>',
    'chevron-left': '<polyline points="15 18 9 12 15 6"/>',
    'chevron-right': '<polyline points="9 18 15 12 9 6"/>',
    'chevron-up': '<polyline points="18 15 12 9 6 15"/>',
    'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
    'arrow-left': '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
    'arrow-right': '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
    'more-horizontal': '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    'corner-up-left': '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
    'corner-up-right': '<polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>',
    'maximize-2': '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
    'minimize-2': '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/>',
    'align-left': '<line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/>',
    'align-center': '<line x1="21" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/>',
    'align-right': '<line x1="21" y1="7" x2="3" y2="7"/><line x1="21" y1="17" x2="3" y2="17"/><line x1="21" y1="12" x2="3" y2="12"/>',
    'square': '<rect x="3" y="3" width="18" height="18" rx="2"/>',
    'layout': '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>',
    'skip-back': '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>',
    'skip-forward': '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>',
    'external-link': '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'
  });

  // Aliases for icons that are served as PNGs from /assets/icons8-*.png.
  // Names that already resolve via UI_ICONS or ICON_SPECIAL above are omitted
  // here because they would be unreachable.
  const ICON_MAP = Object.freeze({
    'folder-open': 'safe',
    'pen-tool': 'pen',
    'globe': 'globe',
    'music': 'music',
    'image': 'picture',
    'calendar': 'calendar',
    'mail': 'mail',
    'monitor': 'monitor',
    'settings': 'gear',
    'alarm-clock': 'alarm-clock',
    'bell': 'bell',
    'shield': 'shield',
    'sliders': 'adjust',
    'users': 'people',
    'wifi': 'wi-fi',
    'clock': 'calendar',
    'database': 'server',
    'terminal': 'command-line',
    'trash': 'trash',
    'trash-2': 'trash',
    'folder': 'opened-folder',
    'file': 'document',
    'file-text': 'document',
    'document': 'document',
    'play': 'play',
    'volume-2': 'sound',
    'archive': 'archive',
    'search': 'magnifying-glass',
    'download': 'download',
    'save': 'save',
    'copy': 'copy',
    'star': 'star',
    'star-filled': 'rating',
    'rating': 'rating',
    'favorite': 'rating',
    'bookmark-filled': 'rating',
    'bookmark': 'bookmark',
    'refresh': 'refresh',
    'maximize': 'fullscreen',
    'info': 'info',
    'eye': 'eye',
    'zap': 'lightning',
    'shutdown': 'shutdown',
    'tag': 'tag',
    'edit-3': 'edit',
    'edit-pencil': 'edit-pencil',
    'edit-property': 'edit-property',
    'filter': 'filter',
    'bar-chart-2': 'bar-chart',
    'list-ordered': 'numbered-list',
    'message-square': 'chat',
    'check-circle': 'checkmark',
    'check-square': 'checkmark',
    'x-circle': 'cancel',
    'keyboard': 'keyboard',
    'layers': 'layers',
    'clipboard-list': 'paste',
    'clip-board': 'paste',
    'clipboard': 'paste',
    'paste': 'paste',
    'user': 'profile',
    'groups': 'people',
    'key': 'key',
    'hard-drive': 'database',
    'attention': 'info',
    'alert-triangle': 'info',
    'lock': 'lock',
    'plus-math': 'plus-math',
    'add': 'plus-math',
    'cpu': 'processor',
    'processor': 'processor',
    'command-line': 'command-line',
    'console': 'command-line',
    'administrative-tools': 'document',
    'maintenance': 'document',
    'registry-editor': 'document',
    'quill-pen': 'pen',
    'pen': 'pen',
    'reading-book-and-apple': 'document',
    'incognito': 'incognito',
    'gamepad-2': 'dice',
    'box': 'dice',
    'circle': 'dice',
    'bomb': 'bomb',
    'clover': 'clover',
    'timer': 'counter',
    'wallet': 'wallet',
    'file-code': 'document',
    'palette': 'color-palette',
    'type': 'quote',
    'qr-code': 'qr-code',
    'metronome': 'counter',
    'binary': 'barcode',
    'hash': 'barcode',
    'regex': 'document',
    'text': 'quote',
    'diff': 'layers',
    'briefcase': 'briefcase',
    'list': 'document',
    'move': 'arrow-right',
    'shuffle': 'shuffle-96',
    'repeat': 'repeat',
    'default-apps': 'services'
  });

  // Icons that need a non-standard PNG filename suffix. Checked before
  // ICON_MAP so the special path wins when present.
  const ICON_SPECIAL = Object.freeze({
    'shuffle': 'shuffle-96',
    'repeat': 'repeat-button-96',
    'pause': 'pause-96',
    'rename': 'rename-96'
  });

  // Cache of already-rendered icon HTML keyed by `${name}|${size}`. The output
  // of svgIcon is a pure function of its inputs, so memoising it avoids both
  // repeated string concatenation and repeated Map lookups for the common
  // case of rendering the same icon many times in a list.
  const iconCache = new Map();
  const ICON_CACHE_LIMIT = 500;

  // Structured error type for the arithmetic evaluator. Callers can use
  // `err instanceof ArithmeticError` (or the cross-realm-safe `Error.isError`
  // plus name check) to distinguish parse failures from other thrown errors.
  class ArithmeticError extends Error {
    constructor(message, { position, input } = {}) {
      super(message);
      this.name = 'ArithmeticError';
      if (position !== undefined) this.position = position;
      if (input !== undefined) this.input = input;
    }
  }

  // --- Internal helpers ---------------------------------------------------

  // Canonical HTML escaper. Uses the DOM when available because it correctly
  // handles characters the regex would miss (NBSP -> &nbsp;, etc.). Falls back
  // to a regex in non-DOM environments. Always escapes the five characters
  // that matter for text content and both single- and double-quoted
  // attributes: & < > " '. The DOM only escapes four of those (and jsdom
  // escapes none of ", '), so we force-escape " and ' afterwards for
  // cross-browser consistency.
  function domEscape(value) {
    const s = String(value);
    if (!escaperEl) {
      return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
    escaperEl.textContent = s;
    return escaperEl.innerHTML
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Coerce a size argument for svgIcon into a safe positive number. The
  // original code used `size || 18`, which kept negative numbers and string
  // values that would later be interpolated raw into HTML.
  function coerceIconSize(size) {
    const n = Number(size);
    if (Number.isFinite(n) && n > 0) return n;
    return 18;
  }

  // One-time delegated listener that hides <img data-hide-on-error> elements
  // when their src fails to load. This replaces the inline onerror handlers
  // the original file embedded in every svgIcon output, which were both a
  // CSP violation (script-src 'unsafe-inline') and an unnecessary per-image
  // attribute. The visual outcome is identical: broken icons disappear.
  function installHideOnErrorListener() {
    if (!hasWindow || !hasDocument) return;
    if (window.__baseUtilsHideOnErrorInstalled) return;
    window.__baseUtilsHideOnErrorInstalled = true;
    // Capture phase: error events on <img> do not bubble.
    document.addEventListener('error', (event) => {
      const target = event.target;
      if (target && target.tagName === 'IMG' && target.hasAttribute('data-hide-on-error')) {
        target.style.visibility = 'hidden';
      }
    }, true);
  }

  // --- Public functions ---------------------------------------------------

  // Generate a UUID. Prefers the native crypto.randomUUID for cryptographic
  // quality; falls back to a Math.random-based RFC 4122 v4 layout for
  // non-secure contexts (e.g. HTTP, sandboxed iframes without crypto).
  function generateId() {
    if (hasWindow && window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // Escape a value for safe insertion as HTML text or attribute value.
  // Treats null/undefined as empty string; everything else is stringified.
  function sanitiseHTML(str) {
    if (str == null) return '';
    return domEscape(str);
  }

  // String-only variant kept for backward compatibility with existing
  // callers. Non-strings return empty string.
  function escapeText(str) {
    if (typeof str !== 'string') return '';
    return domEscape(str);
  }

  // Regex-only escaper for cases where the caller already knows the input is
  // a primitive. Same five-character escape set as domEscape.
  function escapeHtml(s) {
    return domEscape(s);
  }

  // Evaluate a string containing + - * / % and parentheses without ever
  // calling eval or new Function. Throws ArithmeticError on any parse or
  // runtime failure (unbalanced parens, divide-by-zero producing Infinity,
  // input too long, nesting too deep).
  function safeEvaluateArithmetic(input) {
    if (input == null) {
      throw new ArithmeticError('Input is required');
    }
    const source = String(input).replace(/\s+/g, '');
    if (source.length === 0) {
      throw new ArithmeticError('Empty expression', { input: String(input) });
    }
    if (source.length > 10000) {
      throw new ArithmeticError('Expression too long (max 10000 chars)', { input: String(input) });
    }

    let pos = 0;
    let depth = 0;
    const MAX_DEPTH = 200;

    function consume(ch) {
      if (source[pos] === ch) {
        pos += 1;
        return true;
      }
      return false;
    }

    function parseNumber() {
      const start = pos;
      let sawDigit = false;
      let sawDot = false;
      while (pos < source.length) {
        const ch = source[pos];
        if (ch >= '0' && ch <= '9') {
          sawDigit = true;
          pos += 1;
        } else if (ch === '.' && !sawDot) {
          sawDot = true;
          pos += 1;
        } else {
          break;
        }
      }
      if (!sawDigit) {
        throw new ArithmeticError('Expected number', { position: pos, input: source });
      }
      return Number(source.slice(start, pos));
    }

    function parsePrimary() {
      depth += 1;
      if (depth > MAX_DEPTH) {
        throw new ArithmeticError('Expression nested too deeply', { position: pos, input: source });
      }
      try {
        // Iterate unary +/- instead of recursing so that arbitrarily long
        // chains like "+++++++1" do not blow the stack.
        let sign = 1;
        for (;;) {
          if (consume('+')) continue;
          if (consume('-')) { sign = -sign; continue; }
          break;
        }
        if (consume('(')) {
          const value = parseAddSub();
          if (!consume(')')) {
            throw new ArithmeticError('Expected )', { position: pos, input: source });
          }
          return sign * value;
        }
        return sign * parseNumber();
      } finally {
        depth -= 1;
      }
    }

    function parseMulDiv() {
      let left = parsePrimary();
      while (pos < source.length) {
        if (consume('*')) {
          left *= parsePrimary();
        } else if (consume('/')) {
          left /= parsePrimary();
        } else if (consume('%')) {
          left %= parsePrimary();
        } else {
          break;
        }
      }
      return left;
    }

    function parseAddSub() {
      let left = parseMulDiv();
      while (pos < source.length) {
        if (consume('+')) {
          left += parseMulDiv();
        } else if (consume('-')) {
          left -= parseMulDiv();
        } else {
          break;
        }
      }
      return left;
    }

    const value = parseAddSub();
    if (pos !== source.length) {
      throw new ArithmeticError('Unexpected trailing token', { position: pos, input: source });
    }
    if (!Number.isFinite(value)) {
      throw new ArithmeticError('Result is not finite (divide by zero?)', { input: source });
    }
    return value;
  }

  // Best-effort browser detection. Uses navigator.userAgentData.brands when
  // available, then falls back to UA-string sniffing with the ordering bugs
  // from the original fixed (Opera and Brave are now checked before Chrome).
  // Returns one of: Edge, Brave, Chrome, Firefox, Safari, Opera, Chromium,
  // Unknown.
  function detectBrowser() {
    // User-Agent Client Hints are the modern, less-spoofable path.
    const uaData = (typeof navigator !== 'undefined') ? navigator.userAgentData : null;
    if (uaData && Array.isArray(uaData.brands)) {
      const brands = uaData.brands.map((b) => b.brand.toLowerCase());
      if (brands.includes('microsoft edge')) return 'Edge';
      if (brands.includes('opera')) return 'Opera';
      if (brands.includes('brave')) return 'Brave';
      if (brands.includes('chromium')) return 'Chromium';
      if (brands.includes('google chrome')) return 'Chrome';
    }

    // Brave is detectable via navigator.brave (an async boolean). We can't
    // await here, so we accept the synchronous shape and skip if it is a
    // promise — the UA string never contains "Brave/".
    if (typeof navigator !== 'undefined' && typeof navigator.brave === 'object' && navigator.brave !== null && typeof navigator.brave.isBrave === 'function') {
      // navigator.brave.isBrave() resolves to true on Brave. We cannot wait,
      // but its mere presence is a strong signal.
      return 'Brave';
    }

    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '';

    if (ua.includes('Edg/')) return 'Edge';
    if (ua.includes('OPR/') || ua.includes('Opera/')) return 'Opera';
    if (ua.includes('Brave/')) return 'Brave';
    if (ua.includes('Firefox/')) return 'Firefox';
    if (ua.includes('Chrome/') && !ua.includes('Chromium/')) return 'Chrome';
    if (ua.includes('Chromium/')) return 'Chromium';
    // Safari's UA contains "Safari/" but also "Chrome/" when spoofing; the
    // Chrome branch above already filtered that out.
    if (ua.includes('Safari/')) return 'Safari';

    return 'Unknown';
  }

  // Format a byte count into a human-readable string with binary units
  // (1024-based). Handles zero, negatives, and values larger than 1 YB
  // without producing "NaN undefined".
  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n)) {
      throw new TypeError('formatBytes: expected a finite number, got ' + String(bytes));
    }
    if (n === 0) return '0 B';
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    const k = 1024;
    const i = Math.min(Math.floor(Math.log(abs) / Math.log(k)), BYTE_UNITS.length - 1);
    return sign + parseFloat((abs / Math.pow(k, i)).toFixed(1)) + ' ' + BYTE_UNITS[i];
  }

  // Cross-realm Date validator. `instanceof Date` fails for dates created in
  // a different realm (iframes, jsdom tests), so we use the toString tag and
  // check the time is not NaN.
  function isValidDate(value) {
    if (value == null || typeof value !== 'object') return false;
    if (Object.prototype.toString.call(value) !== '[object Date]') return false;
    return !Number.isNaN(value.getTime());
  }

  // Format a Date as HH:MM (24h) or H:MM AM/PM (12h), honouring the
  // clockFormat and timezone settings from the global OS object when present.
  function formatTime(date) {
    if (!isValidDate(date)) {
      throw new TypeError('formatTime: expected a valid Date');
    }
    const use24 = (typeof OS !== 'undefined')
      && OS
      && OS.settings
      && typeof OS.settings.get === 'function'
      && OS.settings.get('clockFormat') === '24h';

    try {
      const tz = (typeof OS !== 'undefined' && OS.settings && typeof OS.settings.get === 'function')
        ? OS.settings.get('timezone')
        : undefined;
      const opts = { hour: 'numeric', minute: '2-digit', hour12: !use24 };
      if (tz) opts.timeZone = tz;
      const parts = new Intl.DateTimeFormat((typeof OS !== 'undefined' && OS.settings && typeof OS.settings.get === 'function') ? OS.settings.get('region') || navigator.language : navigator.language, opts).formatToParts(date);
      const hourPart = parts.find(p => p.type === 'hour');
      const minutePart = parts.find(p => p.type === 'minute');
      const dayPeriodPart = parts.find(p => p.type === 'dayPeriod');
      if (!hourPart || !minutePart) throw new Error('missing parts');
      if (use24) {
        return String(hourPart.value).padStart(2, '0') + ':' + minutePart.value;
      }
      return hourPart.value + ':' + minutePart.value + (dayPeriodPart ? ' ' + dayPeriodPart.value : '');
    } catch {
      const h = date.getHours();
      const m = date.getMinutes();
      if (use24) {
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
      }
      const h12 = h % 12 || 12;
      const ampm = h < 12 ? 'AM' : 'PM';
      return h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
    }
  }

  // Format a Date as locale-aware "short weekday short day short month",
  // honouring the stored region and timezone when available.
  function formatDate(date) {
    if (!isValidDate(date)) {
      throw new TypeError('formatDate: expected a valid Date');
    }
    try {
      const locale = (typeof OS !== 'undefined' && OS.settings && typeof OS.settings.get === 'function')
        ? OS.settings.get('region') || navigator.language
        : navigator.language;
      const tz = (typeof OS !== 'undefined' && OS.settings && typeof OS.settings.get === 'function')
        ? OS.settings.get('timezone')
        : undefined;
      const opts = { weekday: 'short', day: 'numeric', month: 'short' };
      if (tz) opts.timeZone = tz;
      return new Intl.DateTimeFormat(locale, opts).format(date);
    } catch {
      return DAY_NAMES[date.getDay()] + ' ' + date.getDate() + ' ' + MONTH_NAMES[date.getMonth()];
    }
  }

  // Debounce fn by ms milliseconds. The returned function exposes .cancel()
  // (drop pending call) and .flush() (fire pending call immediately) so
  // callers can clean up on unmount or before navigation. Preserves `this`
  // and arguments of the most recent invocation.
  function debounce(fn, ms) {
    let timer = null;
    let pendingArgs = null;
    let pendingThis = null;

    function fire() {
      timer = null;
      const args = pendingArgs;
      const thisArg = pendingThis;
      pendingArgs = null;
      pendingThis = null;
      fn.apply(thisArg, args);
    }

    function debounced(...args) {
      pendingArgs = args;
      pendingThis = this;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(fire, ms);
    }

    debounced.cancel = function cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pendingArgs = null;
      pendingThis = null;
    };

    debounced.flush = function flush() {
      if (timer !== null) {
        clearTimeout(timer);
        fire();
      }
    };

    return debounced;
  }

  // Throttle fn to one invocation per animation frame. Uses the latest
  // arguments and `this` (the original used the first call's arguments,
  // which gave stale scroll positions for scroll handlers). Exposes .cancel()
  // to drop a pending frame. Falls back to setTimeout(16ms) when RAF is
  // unavailable (SSR, jsdom).
  function throttleRAF(fn) {
    const scheduleFrame = hasRAF ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
    const cancelFrame = hasCAF ? cancelAnimationFrame : clearTimeout;

    let scheduledId = null;
    let pendingArgs = null;
    let pendingThis = null;

    function run() {
      scheduledId = null;
      const args = pendingArgs;
      const thisArg = pendingThis;
      pendingArgs = null;
      pendingThis = null;
      fn.apply(thisArg, args);
    }

    function throttled(...args) {
      pendingArgs = args;
      pendingThis = this;
      if (scheduledId !== null) return;
      scheduledId = scheduleFrame(run);
    }

    throttled.cancel = function cancel() {
      if (scheduledId !== null) {
        cancelFrame(scheduledId);
        scheduledId = null;
      }
      pendingArgs = null;
      pendingThis = null;
    };

    return throttled;
  }

  // Best-effort localStorage write. Operational storage failures (quota,
  // private mode, disabled storage) are swallowed because the app must
  // continue. Programmer errors (bad key, non-serialisable value) are
  // rethrown so they surface during development. If the AppDirs VFS sync
  // helper exists, it is invoked fire-and-forget so a slow sync never blocks
  // the caller.
  function lsSave(key, value) {
    const stored = typeof value === 'string' ? value : JSON.stringify(value);

    try {
      localStorage.setItem(key, stored);
    } catch (err) {
      const isStorageError = err instanceof DOMException && (
        err.name === 'QuotaExceededError' ||
        err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        err.name === 'SecurityError'
      );
      if (isStorageError) {
        // Best-effort: log and continue. The app degrades gracefully when
        // persistence is unavailable.
        if (hasWindow && window.console && typeof window.console.warn === 'function') {
          console.warn('lsSave: storage unavailable (' + err.name + ') for key ' + key);
        }
        return;
      }
      throw err;
    }

    if (hasWindow && window.AppDirs && window.AppDirs.vfsFolders && typeof window.AppDirs.syncKey === 'function') {
      try {
        const maybePromise = window.AppDirs.syncKey(key, value);
        if (maybePromise && typeof maybePromise.catch === 'function') {
          maybePromise.catch(() => { /* sync is best-effort */ });
        }
      } catch (_) {
        // Synchronous failure setting up the sync — ignore.
      }
    }
  }

  // Tiny DOM builder. Supports className/class, textContent, style (object
  // or string), on* event handlers, boolean attributes, and arbitrary
  // attributes. Uses setAttribute('class', ...) so the same call works for
  // HTML and SVG elements (el.className is read-only on SVG).
  function createEl(tag, attrs, children) {
    const el = document.createElement(tag);

    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null) continue;

        if (key === 'className' || key === 'class') {
          el.setAttribute('class', value);
        } else if (key === 'textContent') {
          el.textContent = value;
        } else if (key === 'style') {
          if (typeof value === 'object') {
            Object.assign(el.style, value);
          } else {
            el.style.cssText = String(value);
          }
        } else if (key === 'dataset' && typeof value === 'object') {
          for (const [dk, dv] of Object.entries(value)) {
            el.dataset[dk] = dv;
          }
        } else if (key.startsWith('on') && typeof value === 'function') {
          el.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (typeof value === 'boolean') {
          if (value) el.setAttribute(key, '');
          else el.removeAttribute(key);
        } else {
          el.setAttribute(key, value);
        }
      }
    }

    if (children != null) {
      if (Array.isArray(children)) {
        // Batch appends via a fragment so we trigger a single reflow.
        const frag = document.createDocumentFragment();
        for (const child of children) {
          // Preserve original falsy-skip behaviour so visuals stay identical
          // for callers that pass sparse arrays.
          if (!child && child !== 0) continue;
          if (typeof child === 'string' || typeof child === 'number') {
            frag.appendChild(document.createTextNode(String(child)));
          } else if (child instanceof Node) {
            frag.appendChild(child);
          }
          // else: silently skip unknown types — matches original behaviour.
        }
        el.appendChild(frag);
      } else if (typeof children === 'string' || typeof children === 'number') {
        el.textContent = String(children);
      } else if (children instanceof Node) {
        el.appendChild(children);
      } else {
        // Unknown child type — coerce to string for safety.
        el.textContent = String(children);
      }
    }

    return el;
  }

  // Return HTML markup for an icon. Three cases:
  //   1. Inline SVG (UI_ICONS) — scalable, no HTTP request.
  //   2. data: URL — escaped and embedded as <img>.
  //   3. icons8 PNG — fallback for the broad icon set.
  //
  // All <img> output uses data-hide-on-error instead of an inline onerror
  // handler so the file is CSP-compliant (script-src without 'unsafe-inline').
  // Matches a string that is (mostly) emoji rather than an icon-set key name
  // like 'settings' or 'browser'. Icon keys are always plain ASCII letters/
  // hyphens, so any string containing emoji/pictographic codepoints is
  // unambiguously an emoji icon, not a lookup key.
  const EMOJI_RE = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\uFE0F]/u;
  function isEmoji(str) {
    return EMOJI_RE.test(str);
  }

  function svgIcon(name, size) {
    const safeSize = coerceIconSize(size);

    if (typeof name === 'string' && name.startsWith('data:')) {
      // Escape characters that would break out of the src attribute. Valid
      // data: URLs never contain raw " or <, but we defend against malformed
      // input.
      const safeSrc = String(name)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
      return '<img src="' + safeSrc + '" width="' + safeSize + '" height="' + safeSize +
        '" style="display:inline-block;vertical-align:middle;object-fit:contain;pointer-events:none;"' +
        ' draggable="false" alt="" aria-hidden="true" data-hide-on-error>';
    }

    if (typeof name === 'string' && name.startsWith('/assets/')) {
      return '<img src="' + name + '" width="' + safeSize + '" height="' + safeSize +
        '" style="display:inline-block;vertical-align:middle;object-fit:contain;pointer-events:none;"' +
        ' draggable="false" alt="" aria-hidden="true">';
    }

    // Web apps (WebAppManager) store their icon as a plain emoji character
    // (e.g. the '🌐' default) rather than a UI_ICONS key or icons8 name.
    // Without this check that string falls through to the icons8 <img>
    // branch below, requests a nonexistent '/assets/icons8-🌐-94.png', 404s,
    // and gets hidden by data-hide-on-error — leaving pinned web apps with
    // no icon on the desktop/taskbar. Render emoji as text instead.
    if (typeof name === 'string' && isEmoji(name)) {
      return '<span style="display:inline-flex;align-items:center;justify-content:center;' +
        'width:' + safeSize + 'px;height:' + safeSize + 'px;font-size:' + Math.round(safeSize * 0.82) +
        'px;line-height:1;" aria-hidden="true">' + name + '</span>';
    }

    const cacheKey = name + '|' + safeSize;
    const cached = iconCache.get(cacheKey);
    if (cached !== undefined) return cached;

    let html;
    if (UI_ICONS[name]) {
      html = '<svg width="' + safeSize + '" height="' + safeSize +
        '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
        ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
        UI_ICONS[name] + '</svg>';
    } else {
      const specialName = ICON_SPECIAL[name];
      const i8name = specialName || ICON_MAP[name] || name;
      const localPath = specialName
        ? '/assets/icons8-' + specialName + '.png'
        : '/assets/icons8-' + i8name + '-94.png';
      html = '<img src="' + localPath + '" width="' + safeSize + '" height="' + safeSize +
        '" style="display:inline-block;vertical-align:middle;object-fit:contain;pointer-events:none;"' +
        ' draggable="false" alt="" aria-hidden="true" data-hide-on-error>';
    }

    if (iconCache.size < ICON_CACHE_LIMIT) {
      iconCache.set(cacheKey, html);
    }
    return html;
  }

  // Install the delegated error listener on first script load. Idempotent
  // across multiple inclusions of this file on the same page.
  installHideOnErrorListener();

  // --- Public surface -----------------------------------------------------
  // Every function above is also assigned to window here so the intended
  // public API is explicit, and so the file remains usable if it is ever
  // migrated to an ES module wrapper (where top-level declarations would no
  // longer auto-attach to window).
  if (hasWindow) {
    window.generateId = generateId;
    window.sanitiseHTML = sanitiseHTML;
    window.escapeText = escapeText;
    window.escapeHtml = escapeHtml;
    window.safeEvaluateArithmetic = safeEvaluateArithmetic;
    window.ArithmeticError = ArithmeticError;
    window.detectBrowser = detectBrowser;
    window.formatBytes = formatBytes;
    window.formatTime = formatTime;
    window.formatDate = formatDate;
    window.debounce = debounce;
    window.throttleRAF = throttleRAF;
    window.lsSave = lsSave;
    window.createEl = createEl;
    window.svgIcon = svgIcon;

    window.detectLightBackground = function(x, y) {
      try {
        const el = document.elementFromPoint(x, y);
        if (!el) return false;
        if (el.tagName === 'WEBVIEW' || el.closest('webview')) return true;
        if (el.closest('canvas')) return true;
        const bg = getComputedStyle(el).backgroundColor;
        const m = bg.match(/\d+/g);
        if (!m || m.length < 3) return false;
        const r = parseInt(m[0], 10);
        const g = parseInt(m[1], 10);
        const b = parseInt(m[2], 10);
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
        return luminance > 160;
      } catch (e) {
        return false;
      }
    };

    window.applyContrastClass = function(element, x, y) {
      if (!element) return;
      if (window.detectLightBackground(x, y)) {
        element.classList.add('light-bg');
      } else {
        element.classList.remove('light-bg');
      }
    };
  }
})();
const ContextMenu = {
  current: null,
  _activeDismiss: null, // Track the current event handler for absolute safety
  _coveredWebviews: [],

  show(x, y, items) {
    ContextMenu.hide();
    
    const menu = createEl('div', { className: 'context-menu', role: 'menu' });
    const fragment = document.createDocumentFragment();
    const len = items.length;

    // Use a high-performance indexed loop instead of for...of
    for (let i = 0; i < len; i++) {
      const item = items[i];
      
      if (item.separator) {
        fragment.appendChild(createEl('div', { className: 'ctx-separator' }));
        continue;
      }
      
      const btn = createEl('button', {
        className: 'ctx-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : ''),
        role: 'menuitem',
        'aria-label': item.label,
        'aria-disabled': item.disabled ? 'true' : 'false'
      });
      if (item.disabled) btn.disabled = true;
      
      // Store reference to the specific action directly on the DOM element for event delegation
      if (item.action) btn._action = item.action;

      if (item.icon) {
        const iconEl = createEl('span');
        iconEl.innerHTML = svgIcon(item.icon, 14);
        btn.appendChild(iconEl);
      }
      
      btn.appendChild(createEl('span', { textContent: item.label }));
      
      if (item.shortcut) {
        btn.appendChild(createEl('span', { className: 'ctx-shortcut', textContent: item.shortcut }));
      }
      
      fragment.appendChild(btn);
    }

    menu.appendChild(fragment);
    menu.style.visibility = 'hidden';
    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    const winW = window.innerWidth;
    const winH = window.innerHeight;

    if (x + rect.width > winW) x = winW - rect.width - 8;
    if (y + rect.height > winH) y = winH - rect.height - 8;
    
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // Sample background behind the menu to decide text color
    try {
      const samplePoints = [];
      const step = 20;
      for (let sx = x + 5; sx < x + rect.width - 5; sx += step) {
        for (let sy = y + 5; sy < y + rect.height - 5; sy += step) {
          samplePoints.push({ x: sx, y: sy });
        }
      }
      if (samplePoints.length > 0) {
        let lightSample = false;
        let validSamples = 0;
        for (const pt of samplePoints) {
          const el = document.elementFromPoint(pt.x, pt.y);
          if (!el) continue;
          if (el.tagName === 'WEBVIEW' || el.closest('webview')) {
            lightSample = true;
            break;
          }
          const bg = getComputedStyle(el).backgroundColor;
          const m = bg.match(/\d+/g);
          if (!m || m.length < 3) continue;
          validSamples++;
          const r = parseInt(m[0], 10);
          const g = parseInt(m[1], 10);
          const b = parseInt(m[2], 10);
          const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
          if (luminance > 160) {
            lightSample = true;
            break;
          }
        }
        if (lightSample || validSamples === 0) {
          menu.classList.add('light-bg');
        }
      } else {
        menu.classList.add('light-bg');
      }
    } catch (e) {
      // If sampling fails, keep default dark text
    }

    const menuRight = x + rect.width;
    const menuBottom = y + rect.height;
    for (const webview of document.querySelectorAll('webview, nova-nested-webview')) {
      const viewRect = webview.getBoundingClientRect();
      const overlaps = viewRect.left < menuRight && viewRect.right > x
        && viewRect.top < menuBottom && viewRect.bottom > y;
      if (!overlaps || getComputedStyle(webview).visibility === 'hidden') continue;
      ContextMenu._coveredWebviews.push([webview, webview.style.visibility]);
      webview.style.visibility = 'hidden';
    }

    menu.style.visibility = '';
    ContextMenu.current = menu;

    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('.ctx-item');
      if (btn) {
        ContextMenu.hide();
        if (btn._action) btn._action();
      }
    });

    // Optimized dismiss handler using capture phase to avoid setTimeout lag
    const dismiss = (e) => {
      if (!menu.contains(e.target)) {
        ContextMenu.hide();
      }
    };
    
    ContextMenu._activeDismiss = dismiss;
    document.addEventListener('pointerdown', dismiss, { capture: true, passive: true });
  },

  hide() {
    if (ContextMenu.current) {
      ContextMenu.current.remove();
      ContextMenu.current = null;
    }
    for (const [webview, visibility] of ContextMenu._coveredWebviews) {
      if (webview.isConnected) webview.style.visibility = visibility;
    }
    ContextMenu._coveredWebviews.length = 0;
    if (ContextMenu._activeDismiss) {
      document.removeEventListener('pointerdown', ContextMenu._activeDismiss, { capture: true });
      ContextMenu._activeDismiss = null;
    }
  }
};

window.ContextMenu = ContextMenu;
(() => {
  'use strict';
  const APP_ID = 'com.nbosp.browser';
  const call = (type, payload = {}) => window.nova?.ipc?.(type, payload);

  // Launch options are injected by AppSandbox; keep a safe local copy.
  const launchOptions = (window.__NOVA_APP_OPTIONS__ && typeof window.__NOVA_APP_OPTIONS__ === 'object')
    ? window.__NOVA_APP_OPTIONS__ : {};

  // Browser is a first-party package, but its guest is still isolated from
  // host globals. Provide the same public surfaces that the original app used.
  window.AppDirs = { getVFSDir: () => '/data/' + APP_ID + '/files' };
  window.OS = {
    volume: 80,
    settings: {
      get(key) {
        try { return JSON.parse(localStorage.getItem('nbosp.browser.setting.' + key) || 'null'); } catch { return null; }
      },
      set(key, value) {
        try { localStorage.setItem('nbosp.browser.setting.' + key, JSON.stringify(value)); return true; } catch { return false; }
      }
    },
    events: { emit() {}, on() {}, off() {} },
    applyVolumeToWebviews() {}
  };

  const permissionReady = new Promise(resolve => {
    const started = Date.now();
    (function poll() {
      const r = window.__novaPermResponse;
      if (r && Array.isArray(r.permissions)) return resolve(r);
      if (Date.now() - started > 15000) return resolve({ permissions: [], deniedPermissions: [] });
      setTimeout(poll, 20);
    })();
  });
  const normalizeId = id => id === 'browser' ? APP_ID : id;
  window.AppPermissionManager = {
    async ready() { return permissionReady; },
    isGranted(permission, id = APP_ID) {
      const r = window.__novaPermResponse;
      return normalizeId(id) === APP_ID && !!r?.permissions?.includes(permission);
    },
    isDenied(permission, id = APP_ID) {
      const r = window.__novaPermResponse;
      return normalizeId(id) === APP_ID && !!r?.deniedPermissions?.includes(permission);
    },
    async requestPermission(permission, id = APP_ID, opts = {}) {
      if (normalizeId(id) !== APP_ID) return false;
      const permissionState = await permissionReady;
      const response = await call('nova:request-permission', {
        permission,
        reason: opts.reason || `Browser needs ${permission}.`,
        permanent: opts.permanent !== false
      });
      const granted = response?.granted === true;
      if (granted) {
        const currentState = window.__novaPermResponse || permissionState;
        window.__novaPermResponse = currentState;
        if (Array.isArray(currentState.permissions) && !currentState.permissions.includes(permission)) {
          currentState.permissions.push(permission);
        }
        if (Array.isArray(currentState.deniedPermissions)) {
          currentState.deniedPermissions = currentState.deniedPermissions.filter(p => p !== permission);
        }
      }
      return granted;
    }
  };

  window.Notify = { show: opts => call('nova:notifications:show', opts).catch(() => {}) };

  // The Browser's context menus remain inside the Browser document, so use the
  // exact OS menu implementation rather than moving them into the parent DOM.
  // menu.js is loaded immediately before this shim's app adapter below.

  window.WM = {
    createWindow(id, options) {
      const appId = id === 'nbosp-downloads' ? 'com.nbosp.downloads' : id;
      return call('nova:browser:window', { action: 'create', appId, options: options || {} }).catch(() => null);
    }
  };

  window.ipc = {
    postMessage(msg) {
      try {
        const m = typeof msg === 'string' ? JSON.parse(msg) : msg;
        if (m?.type === 'browser:closeAll') return call('nova:browser:window', { action: 'closeAll' });
      } catch {}
    }
  };

  window.Downloads = {
    add(name, url, size = 0, mime = '') {
      const id = 'dl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      call('nova:browser:download-record', { action: 'add', id, name, url, size, mime }).catch(() => {});
      return { id };
    },
    setStatus(id, status, size) {
      call('nova:browser:download-record', { action: 'status', id, status, size }).catch(() => {});
    }
  };

  // Host-backed VFS mirror. Metadata is loaded once; file contents are fetched
  // only when the Browser actually needs them.
  const nodes = new Map();
  function pathJoin(parent, name) { return (parent === '/' ? '' : parent) + '/' + name; }
  const FS = {
    files: nodes, rootId: null, specialFolders: {},
    listDir(id) {
      const out = [];
      for (const n of nodes.values()) if (n.parentId === id) out.push(n);
      return out.sort((a,b) => a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name));
    },
    getPath(id) { return nodes.get(id)?.path || ''; },
    getByPath(path) {
      if (path === '/') return nodes.get(this.rootId) || null;
      for (const n of nodes.values()) if (n.path === path) return n;
      return null;
    },
    async refresh() {
      nodes.clear();
      const root = await call('nova:vfs:stat', { path: '/' });
      if (!root?.success) throw new Error(root?.message || 'Unable to access filesystem');
      const add = n => { nodes.set(n.id, {...n, content: undefined}); };
      add(root.stat); this.rootId = root.stat.id;
      const queue = [this.rootId];
      while (queue.length) {
        const id = queue.shift();
        const r = await call('nova:vfs:list', { id });
        if (!r?.success) continue;
        for (const c of (r.files || [])) {
          add({...c, path: pathJoin(r.path || '/', c.name), parentId: id});
          if (c.type === 'folder') queue.push(c.id);
        }
      }
      for (const n of nodes.values()) {
        if (n.parentId === this.rootId && n.type === 'folder') {
          const key = n.name.toLowerCase();
          if (['desktop','documents','downloads','music','pictures','videos','trash'].includes(key)) this.specialFolders[key] = n.id;
        }
      }
      return this;
    },
    async getFile(id) {
      const r = await call('nova:vfs:read', { id });
      if (!r?.success) return null;
      const n = nodes.get(id);
      if (n) n.content = r.data;
      return n ? {...n} : null;
    },
    async createFile(parentId, name, content, mimeType) {
      const parent = nodes.get(parentId);
      if (!parent) throw new Error('Parent folder not found');
      const r = await call('nova:vfs:write', { path: pathJoin(parent.path || '/', name), content, mimeType: mimeType || 'text/plain' });
      if (!r?.success) throw new Error(r?.message || 'Failed to create file');
      await this.refresh();
      return nodes.get(r.id) || this.getByPath(r.path);
    }
  };
  window.FS = FS;

  // Browser source uses a few legacy NW-only calls defensively. They are
  // intentionally left absent so its existing feature detection handles them.

  window.registerApp = function(config) {
    window.__NOVA_APP_CONFIG__ = config;
    const state = { cleanups: [] };
    window.__NOVA_APP_STATE__ = state;
    const run = async () => {
      try {
        // Never block initial UI rendering on the permission handshake or
        // the full VFS metadata walk. Privileged operations remain host-gated
        // and the VFS mirror is populated in parallel.
        const fsReady = FS.refresh().catch((err) => {
          console.warn('[Browser] VFS mirror unavailable during startup:', err);
          return null;
        });
        await config.init(document.getElementById('app') || document.body, state, launchOptions);
        await fsReady;
      } catch (err) {
        console.error('[Browser] init failed:', err);
        const content = document.getElementById('app') || document.body;
        content.innerHTML = '<div style="padding:24px;font-family:var(--font-ui,sans-serif);color:var(--text-danger);">Browser failed to start: ' + String(err?.message || err) + '</div>';
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true }); else queueMicrotask(run);
  };
})();

// Shared network activity log, read by Perf Monitor's Network tab.
//
// Defined at true top level (script-eval time), not inside init(), so the
// log exists the moment this script evaluates regardless of which windows
// are open. Perf Monitor could open before Browser, or Browser traffic
// could fire before Perf Monitor ever opens, and neither app controls the
// other's load order — a top-level definition is the only safe option.
//
// Guarded with `window.NetworkLog ||` so re-including this script doesn't
// clobber entries already pushed.
window.NetworkLog = window.NetworkLog || {
  entries: [],
  MAX_ENTRIES: 500, // ring buffer — a busy session could otherwise grow unbounded
  _renderFn: null,  // set by Perf Monitor while its Network tab is visible

  push(entry) {
    this.entries.unshift(entry);
    if (this.entries.length > this.MAX_ENTRIES) this.entries.length = this.MAX_ENTRIES;
    this._renderFn?.();
  },

  getAll() {
    return this.entries;
  },

  clear() {
    this.entries.length = 0;
    this._renderFn?.();
  },
};

registerApp({
  id: 'com.nbosp.browser', name: 'Browser', icon: 'globe',
  version: '3.0.3',
  description: 'Web Browser',
  defaultSize: [900, 600], minSize: [500, 350],

  onClose(state) {
    // Flush any debounced localStorage writes so data isn't lost on rapid close.
    // _flushPendingSaves is attached to `state` from inside init() because it
    // closes over per-app caches; calling it via state bridges the scope gap.
    try {
      if (typeof state._flushPendingSaves === 'function') state._flushPendingSaves();
    } catch (err) {
      console.warn('[NB Browser] flush-on-close failed:', err);
    }

    // Tear down every tracked cleanup (intervals, listeners, abort controllers).
    if (Array.isArray(state.cleanups)) {
      for (const fn of state.cleanups) {
        try { fn(); } catch (err) { console.error('[NB Browser] cleanup failed:', err); }
      }
      state.cleanups.length = 0;
    }

    // Tell the OS shell to close every browser window.
    if (window.ipc?.postMessage) {
      try {
        window.ipc.postMessage(JSON.stringify({ type: 'browser:closeAll', source: 'browser-app' }));
      } catch (err) {
        console.error('[NB Browser] IPC close message failed:', err);
      }
    }
  },

  async init(content, state, options) {
    'use strict';

    content.style.overflow = 'hidden';
    content.style.minHeight = '0';

    // NovaByte runtime guard — refuses to launch without AppDirs.
    if (!window.AppDirs?.getVFSDir('com.nbosp.browser', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML =
        '<div style="font-size:32px">⚠️</div>' +
        '<div style="font-size:14px;text-align:center">' +
        '<b>com.nbosp.browser</b><br>App data directory missing.<br>This app requires NovaByte OS.' +
        '</div>';
      return;
    }

    // Constants
    const BK_KEY              = 'nbosp_browser_bookmarks';
    const HX_KEY              = 'nbosp_browser_history';
    const ST_KEY              = 'nbosp_browser_settings';
    const BOOKMARK_MAX        = 500;
    const HISTORY_MAX         = 1000;
    const URL_MAX_LEN         = 2000;
    const TITLE_MAX_LEN       = 300;
    const FAVICON_DATAURI_MAX = 2048;
    const FAVICON_CACHE_MAX   = 256;    // bounded favicon normaliser cache
    const URL_POLL_MS         = 500;
    const DEBOUNCE_MS         = 300;
    const MOBILE_W            = 390;
    const MIN_ZOOM            = 0.25;
    const MAX_ZOOM            = 3;
    const ZOOM_STEP           = 0.1;
    const OMNI_DEBOUNCE_MS    = 120;
    const OMNI_BLUR_CLOSE_MS  = 150;
    const DOWNLOAD_MAX_BYTES  = 512 * 1024 * 1024;
    const MAX_DL_NAME_LEN     = 128;

    const SEARCH_ENGINES = Object.freeze({
      google:      { label: 'Google',      url: 'https://www.google.com/search?q=' },
      bing:        { label: 'Bing',        url: 'https://www.bing.com/search?q=' },
      duckduckgo:  { label: 'DuckDuckGo',  url: 'https://duckduckgo.com/?q=' },
      ecosia:      { label: 'Ecosia',      url: 'https://www.ecosia.org/search?q=' },
      brave:       { label: 'Brave',       url: 'https://search.brave.com/search?q=' },
      yahoo:       { label: 'Yahoo',       url: 'https://search.yahoo.com/search?p=' },
    });

    const AUTH_HOSTS = Object.freeze([
      'accounts.google.com', 'login.microsoftonline.com',
      'login.live.com', 'appleid.apple.com',
      'github.com', 'gitlab.com',
      'www.facebook.com', 'connect.facebook.net',
      'twitter.com', 'x.com',
      'discord.com', 'slack.com',
      'login.yahoo.com', 'api.amazon.com',
    ]);

    const AUTH_PATHS = Object.freeze([
      '/oauth', '/oauth2', '/auth', '/authorize', '/authorise',
      '/login', '/signin', '/sign-in', '/signup', '/sign-up',
      '/sso', '/saml', '/oidc', '/callback', '/connect',
      '/idp/', '/identity/', '/session', '/token',
    ]);

    // DOM root
    const container = createEl('div', { className: 'browser-container' });
    const tabsBar   = createEl('div', { className: 'browser-tabs-bar', role: 'tablist' });
    const viewport  = createEl('div', {
      className: 'browser-viewport',
      style: { display: 'flex', flexDirection: 'column', position: 'relative' }
    });

    // Tab state
    let tabs        = [{ id: 1, title: 'New Tab', url: '', favicon: '', incognito: false }];
    let activeTabId = 1;
    let nextTabId   = 2;

    const tabWebviews     = new Map();  // tabId → <webview>
    const tabIframes      = new Map();  // tabId → <iframe>
    const tabViewMode     = new Map();  // tabId → 'webview' | 'iframe'
    const tabZoom         = new Map();  // tabId → number
    const tabCleanups     = new Map();  // tabId → Array<() => void>
    const tabUnresponsive = new Set();  // tabIds currently flagged unresponsive

    // App-wide teardown: one AbortController backs every listener that doesn't
    // need finer-grained lifecycle control. Cheaper than tracking each
    // listener separately, and a single abort() call tears everything down.
    const appAbort = new AbortController();
    state.cleanups = state.cleanups || [];
    state.cleanups.push(() => appAbort.abort());

    // Convenience accessor for the currently-active tab object.
    const activeTab = () => tabs.find(t => t.id === activeTabId);

    // Favicon normaliser — memoised with a bounded cache. Without a cap a
    // long session visiting thousands of distinct sites would grow this
    // without end; the simple oldest-first eviction below keeps it bounded
    // while preserving good hit-rate for the working set.
    const _faviconCache = new Map();
    function normFavicon(favicon, siteUrl = '') {
      if (!favicon) return '';
      const cacheKey = favicon + '\u0000' + siteUrl;
      const hit = _faviconCache.get(cacheKey);
      if (hit !== undefined) return hit;

      let result = favicon;
      // Already a proxy URL — use as-is.
      if (favicon.startsWith('/api/favicon')) {
        _faviconCache.set(cacheKey, favicon);
        return favicon;
      }
      // Old Google favicon URL — extract the domain and re-proxy.
      try {
        const u = new URL(favicon);
        if (u.hostname === 'www.google.com' && u.pathname === '/s2/favicons') {
          const domain = u.searchParams.get('domain');
          if (domain) {
            result = '/api/favicon?domain=' + encodeURIComponent(domain);
            _faviconCache.set(cacheKey, result);
            return result;
          }
        }
      } catch { /* not a URL */ }
      // Resolve relative paths into absolute URLs using the guest tab's current domain.
      if (!/^https?:\/\//i.test(favicon) && siteUrl) {
        try { favicon = new URL(favicon, siteUrl).href; }
        catch { /* leave as-is */ }
      }
      // Any other external URL — proxy it via the favicon endpoint using the URL's hostname.
      if (/^https?:\/\//i.test(favicon)) {
        try {
          result = '/api/favicon?url=' + encodeURIComponent(favicon);
        } catch (err) {
          console.debug('[NB Browser] favicon domain extract failed:', favicon, err);
          result = favicon;
        }
      }
      // Bounded eviction: drop the oldest entry once we hit the cap.
      if (_faviconCache.size >= FAVICON_CACHE_MAX) {
        const firstKey = _faviconCache.keys().next().value;
        if (firstKey !== undefined) _faviconCache.delete(firstKey);
      }
      _faviconCache.set(cacheKey, result);
      return result;
    }

    // Settings storage — write-through cache + debounced persist.
    let _settingsCache = null;
    let _settingsSaveTimer = null;

    function loadSettings() {
      if (_settingsCache) return _settingsCache;
      try {
        _settingsCache = JSON.parse(localStorage.getItem(ST_KEY) || '{}');
      } catch (err) {
        console.error('[NB Browser] Settings cache corrupted, resetting:', err);
        _settingsCache = {};
        try { localStorage.removeItem(ST_KEY); } catch { /* ignore */ }
      }
      return _settingsCache;
    }

    function saveSetting(key, val) {
      const s = loadSettings();
      s[key] = val;
      _settingsCache = s;
      clearTimeout(_settingsSaveTimer);
      _settingsSaveTimer = setTimeout(() => {
        try { localStorage.setItem(ST_KEY, JSON.stringify(s)); }
        catch (err) { console.warn('[NB Browser] Failed to save settings:', err); }
      }, DEBOUNCE_MS);
    }

    const getSetting = (key, def) => {
      const v = loadSettings()[key];
      return v !== undefined ? v : def;
    };

    const getSearchUrl = (q) => {
      const eng = getSetting('searchEngine', 'brave');
      const base = SEARCH_ENGINES[eng]?.url || SEARCH_ENGINES.brave.url;
      return base + encodeURIComponent(q);
    };

    // Bookmarks storage
    let _bookmarksCache = null;
    let _bookmarksSaveTimer = null;

    function loadBookmarks() {
      if (_bookmarksCache) return _bookmarksCache;
      try {
        _bookmarksCache = JSON.parse(localStorage.getItem(BK_KEY) || '[]');
      } catch (err) {
        console.error('[NB Browser] Bookmarks cache corrupted, resetting:', err);
        _bookmarksCache = [];
        try { localStorage.removeItem(BK_KEY); } catch { /* ignore */ }
      }
      return _bookmarksCache;
    }

    function saveBookmarks(arr) {
      _bookmarksCache = arr.slice(0, BOOKMARK_MAX);
      clearTimeout(_bookmarksSaveTimer);
      _bookmarksSaveTimer = setTimeout(() => {
        try { localStorage.setItem(BK_KEY, JSON.stringify(_bookmarksCache)); }
        catch (err) { console.warn('[NB Browser] Failed to save bookmarks:', err); }
      }, DEBOUNCE_MS);
    }

    // History storage
    let _historyCache = null;
    let _historySaveTimer = null;

    function loadHistory() {
      if (_historyCache) return _historyCache;
      try {
        _historyCache = JSON.parse(localStorage.getItem(HX_KEY) || '[]');
      } catch (err) {
        console.error('[NB Browser] History cache corrupted, resetting:', err);
        _historyCache = [];
        try { localStorage.removeItem(HX_KEY); } catch { /* ignore */ }
      }
      return _historyCache;
    }

    function saveHistory(arr) {
      _historyCache = arr.slice(0, HISTORY_MAX);
      clearTimeout(_historySaveTimer);
      _historySaveTimer = setTimeout(() => {
        try { localStorage.setItem(HX_KEY, JSON.stringify(_historyCache)); }
        catch (err) { console.warn('[NB Browser] Failed to save history:', err); }
      }, DEBOUNCE_MS);
    }

    // Flush every debounced save immediately. Used by onClose so a rapid
    // window close doesn't lose data sitting in a pending timer.
    function _flushPendingSaves() {
      clearTimeout(_settingsSaveTimer);
      clearTimeout(_bookmarksSaveTimer);
      clearTimeout(_historySaveTimer);
      try {
        if (_settingsCache)  localStorage.setItem(ST_KEY, JSON.stringify(_settingsCache));
        if (_bookmarksCache) localStorage.setItem(BK_KEY, JSON.stringify(_bookmarksCache));
        if (_historyCache)   localStorage.setItem(HX_KEY, JSON.stringify(_historyCache));
      } catch (err) {
        console.warn('[NB Browser] Flush-on-close failed:', err);
      }
    }
    // Exposed for onClose, which runs in a slightly different scope.
    state._flushPendingSaves = _flushPendingSaves;

    // Bookmark helpers — cached membership check via a Set so the address-bar
    // star toggle is O(1) instead of scanning the bookmarks array each time.
    let _bookmarkUrlSet = null;
    function refreshBookmarkSet() {
      _bookmarkUrlSet = new Set(loadBookmarks().map(b => b.url));
    }
    function isBookmarked(url) {
      if (!_bookmarkUrlSet) refreshBookmarkSet();
      return _bookmarkUrlSet.has(url);
    }
    function toggleBookmark(url, title, favicon) {
      let arr = loadBookmarks();
      const idx = arr.findIndex(b => b.url === url);
      if (idx >= 0) {
        arr.splice(idx, 1);
        saveBookmarks(arr);
        refreshBookmarkSet();
        return false;
      }
      arr.unshift({
        url:     url.slice(0, URL_MAX_LEN),
        title:   (title || url).slice(0, TITLE_MAX_LEN),
        favicon: favicon || '',
        ts:      Date.now(),
      });
      saveBookmarks(arr);
      refreshBookmarkSet();
      return true;
    }

    // Panel state — tracked so addHistory can live-refresh the History panel
    // when it's the currently-visible panel.
    let _panelType = null;

    function addHistory(originTabId, url, title, favicon) {
      const tab = tabs.find(t => t.id === originTabId);
      if (!tab || tab.incognito || tab.isPopup) return;

      try {
        // Drop oversized Base64 data-URIs before they can exhaust the 5 MB
        // localStorage quota — a single 100KB favicon would otherwise waste
        // 100KB of quota per visit.
        let safeFavicon = favicon || '';
        if (safeFavicon.startsWith('data:') && safeFavicon.length > FAVICON_DATAURI_MAX) {
          safeFavicon = '';
        }
        const safeTitle      = (title || url).slice(0, TITLE_MAX_LEN);
        const safeStorageUrl = url.slice(0, URL_MAX_LEN);
        // Deduplicate & unshift in a single pass.
        const arr = loadHistory().filter(h => h.url !== url);
        arr.unshift({ url: safeStorageUrl, title: safeTitle, favicon: safeFavicon, ts: Date.now() });
        saveHistory(arr);
        // Live-refresh history panel if it's open.
        if (_panelType === 'history' && panel.style.display !== 'none') showPanel('history');
      } catch (err) {
        console.warn('[NB Browser] addHistory failed:', err);
      }
    }

    // Tabs bar — event-delegated, so there are zero per-tab listeners.
    // Click routing is decided by which element the click landed on.
    tabsBar.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('.tab-close');
      if (closeBtn) {
        e.stopPropagation();
        const tabEl = closeBtn.closest('.browser-tab');
        if (tabEl) closeTab(Number(tabEl.dataset.tabId));
        return;
      }
      const tabEl = e.target.closest('.browser-tab');
      if (tabEl) switchToTab(Number(tabEl.dataset.tabId));
    }, { signal: appAbort.signal });

    // Right-click a tab → Chromium-style tab strip context menu.
    tabsBar.addEventListener('contextmenu', (e) => {
      const tabEl = e.target.closest('.browser-tab');
      // Right-click on empty bar space → just offer a new tab.
      if (!tabEl) {
        e.preventDefault();
        ContextMenu.show(e.clientX, e.clientY, [
          { label: 'New Tab', icon: 'plus', action: createNewTab },
          { label: 'New Incognito Tab', icon: 'incognito', action: createIncognitoTab },
        ]);
        return;
      }
      e.preventDefault();
      const tabId = Number(tabEl.dataset.tabId);
      const idx = tabs.findIndex(t => t.id === tabId);
      const isIncog = Boolean(tabs[idx]?.incognito);
      ContextMenu.show(e.clientX, e.clientY, [
        { label: 'New Tab', icon: 'plus', action: createNewTab },
        { label: 'New Incognito Tab', icon: 'incognito', action: createIncognitoTab },
        { separator: true },
        { label: 'Reload', icon: 'refresh', action: () => reloadTab(tabId) },
        { label: 'Duplicate', icon: 'copy', action: () => duplicateTab(tabId) },
        { separator: true },
        { label: 'Close Tab', icon: 'x', shortcut: 'Ctrl+W', danger: true, action: () => closeTab(tabId) },
        { label: 'Close Other Tabs', action: () => closeOthers(tabId) },
        { label: 'Close Tabs to the Right', action: () => closeTabsToRight(tabId) },
        { label: 'Close Tabs to the Left', action: () => closeTabsToLeft(tabId) },
        ...(isIncog ? [{ separator: true }, { label: 'New Incognito Tab', icon: 'incognito', action: createIncognitoTab }] : []),
      ]);
    }, { signal: appAbort.signal });

    function renderTabs() {
      // Use a DocumentFragment to batch DOM writes — avoids N reflows.
      const frag = document.createDocumentFragment();
      for (const tab of tabs) {
        const tabEl = createEl('button', {
          className: 'browser-tab'
            + (tab.id === activeTabId ? ' active' : '')
            + (tab.incognito ? ' incognito' : ''),
          role: 'tab',
          'aria-selected': tab.id === activeTabId,
          'data-tab-id': String(tab.id),
        });
        const faviconSpan = createEl('span', { className: 'tab-icon' });
        if (tab.favicon) {
          const img = createEl('img', {
            src: normFavicon(tab.favicon, tab.url),
            style: { width: '14px', height: '14px', borderRadius: '2px' }
          });
          img.addEventListener('error', () => {
            faviconSpan.innerHTML = svgIcon('globe', 14);
          }, { once: true });
          faviconSpan.appendChild(img);
        } else {
          faviconSpan.innerHTML = svgIcon('globe', 14);
        }
        tabEl.appendChild(faviconSpan);
        const titleSpan = createEl('span', { className: 'tab-title', textContent: tab.title });
        tabEl.appendChild(titleSpan);
        const closeBtn = createEl('span', { className: 'tab-close', role: 'button', 'aria-label': 'Close tab' });
        closeBtn.innerHTML = svgIcon('x', 12);
        tabEl.appendChild(closeBtn);
        frag.appendChild(tabEl);
      }
      const newTabBtn = createEl('button', { className: 'browser-new-tab-btn', 'aria-label': 'New tab' });
      newTabBtn.innerHTML = svgIcon('plus', 16);
      frag.appendChild(newTabBtn);
      // Replace contents in one operation.
      tabsBar.replaceChildren(frag);
      // Re-bind the "+" button — the delegated handler above can't distinguish
      // it without a class, and adding one would change the visual styling.
      newTabBtn.addEventListener('click', createNewTab, { signal: appAbort.signal });
    }

    // Update only the title text of an existing tab — avoids a full re-render
    // on every URL change in an SPA.
    function updateTabTitle(tabId, title) {
      const tabEl = tabsBar.querySelector(`.browser-tab[data-tab-id="${tabId}"]`);
      if (!tabEl) { renderTabs(); return; }
      const titleEl = tabEl.querySelector('.tab-title');
      if (titleEl) titleEl.textContent = title;
    }

    function createNewTab() {
      const t = { id: nextTabId++, title: 'New Tab', url: '', favicon: '', incognito: false };
      tabs.push(t);
      switchToTab(t.id);
    }

    function createIncognitoTab() {
      const t = { id: nextTabId++, title: 'Incognito', url: '', favicon: '', incognito: true };
      tabs.push(t);
      switchToTab(t.id);
    }

    function applyMobileViewportFrame(wv, isMobile) {
      if (isMobile) {
        wv.classList.add('mobile-viewport');
        viewport.classList.add('mobile-mode');
        wv.style.position = 'absolute';
      } else {
        wv.classList.remove('mobile-viewport');
        viewport.classList.remove('mobile-mode');
        wv.style.position = 'relative';
        wv.style.width = '';
        wv.style.left = '';
        wv.style.transform = '';
      }
    }

    function applyZoomToIframe(ifr, isMobile, z) {
      if (isMobile) {
        ifr.style.width = MOBILE_W + 'px';
        ifr.style.height = '100%';
        ifr.style.transformOrigin = 'top center';
        ifr.style.transform = z !== 1.0 ? `translateX(-50%) scale(${z})` : 'translateX(-50%)';
      } else {
        // Counter-scale the iframe's intrinsic size so the visible box stays
        // the same dimensions while page content scales by 1/z.
        const pct = (100 / z).toFixed(4) + '%';
        ifr.style.width = pct;
        ifr.style.height = pct;
        ifr.style.transformOrigin = 'top left';
        ifr.style.transform = z !== 1.0 ? `scale(${z})` : '';
      }
    }

    function applyZoomToWebview(wv, z) {
      try { wv.setZoom(z); } catch { /* webview not ready */ }
    }

    function toggleUserAgent() {
      const tab = activeTab();
      if (!tab) return;
      const mode = getTabMode(activeTabId);
      const goingMobile = tab.userAgent !== 'mobile';
      tab.userAgent = goingMobile ? 'mobile' : 'desktop';

      if (mode === 'iframe') {
        // iframes can't override UA — apply the mobile viewport frame only.
        const ifr = tabIframes.get(activeTabId);
        if (!ifr) return;
        applyMobileViewportFrame(ifr, goingMobile);
        applyZoomToIframe(ifr, goingMobile, tabZoom.get(activeTabId) || 1.0);
        // Reload so the page re-renders inside the new frame dimensions.
        try { ifr.contentWindow.location.reload(); }
        catch {
          const src = ifr.src; ifr.src = ''; ifr.src = src;
        }
      } else {
        const wv = tabWebviews.get(activeTabId);
        if (!wv) return;
        const UA = goingMobile
          ? 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
          : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        try { wv.setUserAgentOverride(UA); } catch { /* webview not ready */ }
        applyMobileViewportFrame(wv, goingMobile);
        if (tab.url) {
          if (goingMobile) {
            // Inject a viewport meta so mobile pages render at device-width.
            const onMobileLoad = () => {
              wv.removeEventListener('loadstop', onMobileLoad);
              try {
                wv.executeScript({ code: `
                  const m = document.querySelector('meta[name=viewport]') ||
                            (() => {
                              const el = document.createElement('meta');
                              el.name = 'viewport';
                              document.head.appendChild(el);
                              return el;
                            })();
                  m.content = 'width=device-width, initial-scale=1, maximum-scale=1';
                ` });
              } catch { /* ignore */ }
            };
            wv.addEventListener('loadstop', onMobileLoad);
          }
          try { wv.reload(); } catch { /* ignore */ }
        }
      }
    }

    function adjustZoom(delta) {
      let z = tabZoom.get(activeTabId) || 1.0;
      z = delta === 0 ? 1.0 : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z + delta));
      tabZoom.set(activeTabId, z);
      const mode = getTabMode(activeTabId);
      if (mode === 'iframe') {
        const ifr = tabIframes.get(activeTabId);
        if (!ifr) return;
        const tab = activeTab();
        applyZoomToIframe(ifr, tab?.userAgent === 'mobile', z);
      } else {
        const wv = tabWebviews.get(activeTabId);
        if (!wv) return;
        applyZoomToWebview(wv, z);
      }
    }

    function registerTabCleanup(tabId, fn) {
      // Map.getOrInsert (Baseline 2026) avoids the verbose has-check pattern.
      const arr = tabCleanups.getOrInsert(tabId, () => []);
      arr.push(fn);
    }

    function closeTab(tabId) {
      const idx = tabs.findIndex(t => t.id === tabId);
      if (idx === -1) return;
      if (tabId === activeTabId && tabs.length > 1) {
        switchToTab(tabs[idx > 0 ? idx - 1 : 1].id);
      }

      // Revoke any tracked blob URLs to prevent memory leaks.
      const closedTab = tabs.find(t => t.id === tabId);
      if (closedTab?.activeBlobUrl) {
        try { URL.revokeObjectURL(closedTab.activeBlobUrl); } catch { /* ignore */ }
        closedTab.activeBlobUrl = null;
      }

      tabs = tabs.filter(t => t.id !== tabId);

      // Run per-tab cleanups (cancels poll timers, etc.) before removing the webview.
      const cleanups = tabCleanups.get(tabId);
      if (cleanups) {
        for (const fn of cleanups) { try { fn(); } catch { /* ignore */ } }
        tabCleanups.delete(tabId);
      }

      // Remove DOM elements BEFORE checking tabs.length — prevents zombie
      // viewport elements lingering in the DOM.
      const closedWv = tabWebviews.get(tabId);
      if (closedWv) { closedWv.remove(); tabWebviews.delete(tabId); }
      const closedIfr = tabIframes.get(tabId);
      if (closedIfr) { closedIfr.remove(); tabIframes.delete(tabId); }
      tabViewMode.delete(tabId);
      tabZoom.delete(tabId);
      tabUnresponsive.delete(tabId);
      _frameCheckGen.delete(tabId);

      const closedNotice = viewport.querySelector(`.browser-iframe-blocked[data-tab="${tabId}"]`);
      if (closedNotice) closedNotice.remove();

      // Now evaluate whether we need a default fallback tab.
      if (tabs.length === 0) { createNewTab(); return; }
      renderTabs();
    }

    // Tab actions shared by the toolbar button and the context menus.
    function reloadTab(tabId) {
      const tab = tabs.find(t => t.id === tabId);
      if (!tab) return;
      if (getTabMode(tabId) === 'iframe') {
        const ifr = tabIframes.get(tabId);
        if (ifr) {
          try { ifr.contentWindow.location.reload(); }
          catch { const s = ifr.src; ifr.src = ''; ifr.src = s; }
          return;
        }
      } else {
        const wv = tabWebviews.get(tabId);
        if (wv) { try { wv.reload(); } catch { /* ignore */ } return; }
      }
      // No element yet (never-rendered background tab) — load it now.
      if (tabId !== activeTabId) switchToTab(tabId);
      if (tab.url) navigate(tab.url);
    }

    function duplicateTab(tabId) {
      const src = tabs.find(t => t.id === tabId);
      if (!src) return;
      const idx = tabs.findIndex(t => t.id === tabId);
      const dup = {
        id: nextTabId++,
        title: src.title || 'New Tab',
        url: src.url || '',
        favicon: src.favicon || '',
        incognito: src.incognito || false,
      };
      tabs.splice(idx + 1, 0, dup);
      switchToTab(dup.id);
      if (dup.url) navigate(dup.url);
    }

    // Snapshot ids BEFORE closing — closeTab reassigns the `tabs` array.
    function closeOthers(keepTabId) {
      // keep this one active so closeTab doesn't reshuffle
      switchToTab(keepTabId);
      for (const id of tabs.filter(t => t.id !== keepTabId).map(t => t.id)) closeTab(id);
    }
    function closeTabsToRight(fromTabId) {
      const idx = tabs.findIndex(t => t.id === fromTabId);
      if (idx === -1) return;
      switchToTab(fromTabId);
      for (const id of tabs.slice(idx + 1).map(t => t.id)) closeTab(id);
    }
    function closeTabsToLeft(fromTabId) {
      const idx = tabs.findIndex(t => t.id === fromTabId);
      if (idx === -1) return;
      switchToTab(fromTabId);
      for (const id of tabs.slice(0, idx).map(t => t.id)) closeTab(id);
    }

    // Speed dial — the new-tab page.
    function renderSpeedDial() {
      requestAnimationFrame(() => {
        for (const wv of tabWebviews.values()) {
          wv.style.visibility = 'hidden';
          wv.style.pointerEvents = 'none';
        }
      });
      const old = viewport.querySelector('.speed-dial');
      if (old) old.remove();

      const tab = activeTab();
      const sd = createEl('div', { className: 'speed-dial' });
      sd.style.cssText = 'position:absolute;inset:0;overflow-y:auto;padding:40px 32px 24px;display:flex;flex-direction:column;align-items:center;gap:28px;background:var(--bg-base);z-index:1;';

      const greeting = createEl('div', { style: 'font-size:22px;font-weight:600;color:var(--text-primary);' });
      const h = new Date().getHours();
      greeting.textContent = h < 12 ? '🌤 Good morning' : h < 18 ? '☀️ Good afternoon' : '🌙 Good evening';
      if (tab?.incognito) {
        sd.style.background = 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)';
        greeting.textContent = '🕶 Incognito';
      }
      sd.appendChild(greeting);

      const bookmarks = loadBookmarks().slice(0, 8);
      if (bookmarks.length) {
        const grid = createEl('div', {
          style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:12px;width:100%;max-width:640px;'
        });
        for (const bk of bookmarks) {
          const tile = createEl('div', { className: 'speed-dial-tile' });
          const ico = createEl('div', {
            style: 'width:32px;height:32px;border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:var(--bg-hover);'
          });
          const fimg = document.createElement('img');
          if (bk.favicon && /^https?:\/\//i.test(bk.favicon)) {
            fimg.src = normFavicon(bk.favicon);
          } else {
            try { fimg.src = '/api/favicon?domain=' + encodeURIComponent(new URL(bk.url).hostname); }
            catch { fimg.src = ''; }
          }
          fimg.style.cssText = 'width:24px;height:24px;border-radius:3px;';
          fimg.onerror = () => { ico.replaceChildren(); ico.innerHTML = svgIcon('globe', 20); };
          if (fimg.src) ico.appendChild(fimg); else ico.innerHTML = svgIcon('globe', 20);

          const lbl = createEl('div', {
            style: 'font-size:11px;color:var(--text-secondary);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%;'
          });
          try { lbl.textContent = new URL(bk.url).hostname.replace('www.', ''); }
          catch { lbl.textContent = bk.title; }
          tile.append(ico, lbl);
          tile.addEventListener('click', () => { sd.remove(); navigate(bk.url); }, { signal: appAbort.signal });
          grid.appendChild(tile);
        }
        sd.appendChild(grid);
      } else {
        const hint = createEl('div', { style: 'color:var(--text-muted);font-size:13px;text-align:center;' });
        hint.textContent = 'Bookmark sites with ★ to see them here';
        sd.appendChild(hint);
      }

      const hist = loadHistory().slice(0, 5);
      if (hist.length && !tab?.incognito) {
        const sec = createEl('div', { style: 'width:100%;max-width:640px;' });
        const hdr = createEl('div', {
          style: 'font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em;',
          textContent: 'Recent'
        });
        sec.appendChild(hdr);
        for (const hEntry of hist) {
          const row = createEl('div', {
            style: 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;'
          });
          row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-elevated)');
          row.addEventListener('mouseleave', () => row.style.background = '');
          row.innerHTML = svgIcon('clock', 13) + '<span style="font-size:12px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;"></span>';
          const span = row.querySelector('span');
          if (span) span.textContent = hEntry.title || hEntry.url;
          row.addEventListener('click', () => { sd.remove(); navigate(hEntry.url); }, { signal: appAbort.signal });
          sec.appendChild(row);
        }
        sd.appendChild(sec);
      }
      viewport.appendChild(sd);
    }

    function switchToTab(tabId) {
      activeTabId = tabId;
      const tab = tabs.find(t => t.id === tabId);
      if (tab) {
        urlBar.value = stripHttps(tab.url || '');
        currentUrl = tab.url || '';
        const bkd = tab.url ? isBookmarked(tab.url) : false;
        starBtn.style.color = bkd ? 'var(--accent)' : '';
        starBtn.innerHTML = svgIcon(bkd ? 'star-filled' : 'star', 16);
        updateModeBtn();
        if (tab.url === 'browser://settings') {
          renderSettingsPage();
        } else if (tab.url) {
          updateUrlIcon(tab.url);
          const mode = getTabMode(tabId);
          if (mode === 'iframe') {
            const ifr = getOrCreateIframe(tabId);
            if (!ifr.parentNode) viewport.appendChild(ifr);
          } else {
            const wv = getOrCreateWebview(tabId);
            if (!wv.parentNode) viewport.appendChild(wv);
          }
          showViewForTab(tabId);
          const sd = viewport.querySelector('.speed-dial');
          if (sd) sd.remove();
        } else {
          const hp = getSetting('homepage', 'most_visited');
          if (hp === 'custom') {
            const hpUrl = getSetting('homepageUrl', '');
            if (hpUrl) { tab.url = hpUrl; navigate(hpUrl); }
            else { renderSpeedDial(); }
          } else if (hp === 'blank') {
            const sd2 = viewport.querySelector('.speed-dial');
            if (sd2) sd2.remove();
            const spBlank = viewport.querySelector('.browser-settings-page');
            if (spBlank) spBlank.remove();
            requestAnimationFrame(() => {
              for (const wv of tabWebviews.values()) {
                wv.style.visibility = 'hidden';
                wv.style.pointerEvents = 'none';
              }
            });
          } else {
            renderSpeedDial();
          }
        }
      }
      renderTabs();
    }

    // Toolbar
    const toolbar    = createEl('div', { className: 'browser-toolbar' });
    const backBtn    = createEl('button', { className: 'browser-nav-btn', 'aria-label': 'Go back' });
    backBtn.innerHTML = svgIcon('chevron-left', 16);
    const fwdBtn     = createEl('button', { className: 'browser-nav-btn', 'aria-label': 'Go forward' });
    fwdBtn.innerHTML = svgIcon('chevron-right', 16);
    const refreshBtn = createEl('button', { className: 'browser-nav-btn', 'aria-label': 'Refresh' });
    refreshBtn.innerHTML = svgIcon('refresh', 16);

    const urlBarWrap = createEl('div', { className: 'browser-url-bar-wrap' });
    const urlBar = createEl('input', {
      id: 'browser-url-bar', name: 'url',
      className: 'browser-url-bar',
      placeholder: 'Search or enter URL…',
      'aria-label': 'Address bar',
      autocomplete: 'off', spellcheck: 'false',
    });
    const urlIcon = createEl('span', { className: 'browser-url-icon' });
    urlIcon.innerHTML = svgIcon('search', 14);
    urlBarWrap.append(urlBar, urlIcon);

    function updateUrlIcon(url) {
      if (url?.startsWith('https://')) {
        urlIcon.innerHTML = svgIcon('lock', 14);
        urlIcon.style.color = 'var(--text-success)';
      } else if (url?.startsWith('http://')) {
        if (getSetting('show_security_warnings', true)) {
          urlIcon.innerHTML = svgIcon('unlock', 14);
          urlIcon.style.color = 'var(--text-warning)';
        } else {
          urlIcon.innerHTML = svgIcon('globe', 14);
          urlIcon.style.color = '';
        }
      } else {
        urlIcon.innerHTML = svgIcon('search', 14);
        urlIcon.style.color = '';
      }
    }

    // Star bookmark button
    const starBtn = createEl('button', {
      className: 'browser-nav-btn',
      'aria-label': 'Bookmark', title: 'Bookmark this page'
    });
    starBtn.innerHTML = svgIcon('star', 16);
    starBtn.addEventListener('click', () => {
      if (!currentUrl || currentUrl.startsWith('novabyte:')) return;
      const tab = activeTab();
      if (tab?.incognito) return;
      const added = toggleBookmark(currentUrl, tab?.title, tab?.favicon);
      starBtn.style.color = added ? 'var(--accent)' : '';
      starBtn.innerHTML = svgIcon(added ? 'star-filled' : 'star', 16);
      Notify.show({
        title: added ? 'Bookmark added' : 'Bookmark removed',
        body: tab?.title || currentUrl,
        type: 'info', appName: 'Browser'
      });
    }, { signal: appAbort.signal });

    // Menu button — Chromium-style overflow menu.
    const menuBtn = createEl('button', {
      className: 'browser-nav-btn', 'aria-label': 'Menu', title: 'Browser menu'
    });
    menuBtn.innerHTML = svgIcon('menu', 16);
    menuBtn.addEventListener('click', (e) => {
      const tab = activeTab();
      const isIncog = tab?.incognito || false;
      const menuItems = [
        { label: 'New Tab', action: createNewTab },
        { label: 'New Incognito Tab', action: createIncognitoTab },
        { separator: true },
      ];
      if (!isIncog) menuItems.push({ label: 'Bookmarks', action: () => showPanel('bookmarks') });
      menuItems.push({ label: 'History', action: () => showPanel('history') });
      menuItems.push({ separator: true });
      menuItems.push(
        { label: 'Find in Page', shortcut: 'Ctrl+F', action: openFindBar },
        { label: tab?.userAgent === 'mobile' ? 'Switch to Desktop Site' : 'Switch to Mobile Site', action: toggleUserAgent },
        {
          label: getTabMode(activeTabId) === 'iframe' ? 'Switch to Webview Mode' : 'Switch to iFrame Mode',
          action: () => {
            const next = getTabMode(activeTabId) === 'iframe' ? 'webview' : 'iframe';
            if (next === 'webview') clearFindStateOnModeSwitch();
            setTabMode(activeTabId, next);
            const t = activeTab();
            if (t?.url && t.url !== 'browser://settings') navigate(t.url);
            updateModeBtn();
          },
        },
        { separator: true },
        { label: 'Zoom In',  action: () => adjustZoom(ZOOM_STEP) },
        { label: 'Zoom Out', action: () => adjustZoom(-ZOOM_STEP) },
        { label: 'Reset Zoom', action: () => adjustZoom(0) },
        { separator: true },
        { label: 'Settings', action: () => navigate('browser://settings') },
      );
      ContextMenu.show(e.clientX, e.clientY, menuItems);
    }, { signal: appAbort.signal });

    toolbar.append(backBtn, fwdBtn, refreshBtn, urlBarWrap, starBtn, menuBtn);

    // View-mode toggle (Webview ↔ iFrame).
    // DEV ONLY — DO NOT SHIP BUTTON TO PRODUCTION.
    // Dev/debug utility: lets a dev building on this app switch a tab
    // between <webview> and <iframe> rendering — useful when <webview>
    // isn't viable (e.g. missing nodeintegration/manifest flags) or
    // when comparing how a tag behaves across the two modes.
    // REMOVE or HIDE this button element before deploying to production,
    // as non-technical/consumer people do not need this interface.
    // The underlying toggle logic is safe to leave in for devs.
    const modeBtn = createEl('button', {
      className: 'browser-mode-btn',
      title: 'Switch to iframe mode',
      'aria-pressed': 'false'
    });
    modeBtn.innerHTML = svgIcon('monitor', 14) + ' <span>Webview</span>';
    modeBtn.addEventListener('click', () => {
      const current = getTabMode(activeTabId);
      const next = current === 'webview' ? 'iframe' : 'webview';
      setTabMode(activeTabId, next);
      const tab = activeTab();
      if (tab?.url && tab.url !== 'browser://settings') navigate(tab.url);
      updateModeBtn();
    }, { signal: appAbort.signal });
    toolbar.appendChild(modeBtn);

    // Find bar
    const findBar = createEl('div', {
      style: 'display:none;align-items:center;gap:6px;padding:4px 10px;background:var(--bg-elevated);border-bottom:1px solid var(--border-subtle);flex-shrink:0;'
    });
    const findInput = createEl('input', {
      id: 'page-find-input', name: 'page-find',
      placeholder: 'Find in page…',
      style: 'flex:1;background:var(--bg-base);border:1px solid var(--border-subtle);border-radius:4px;padding:3px 8px;font-size:12px;color:var(--text-primary);outline:none;',
      autocomplete: 'off', spellcheck: 'false',
    });
    const findCount = createEl('span', {
      style: 'font-size:11px;color:var(--text-muted);min-width:50px;',
      role: 'status', 'aria-live': 'polite'
    });
    const findPrev  = createEl('button', { className: 'browser-nav-btn', style: 'padding:2px 6px;', title: 'Previous', 'aria-label': 'Previous match' });
    findPrev.innerHTML = svgIcon('chevron-up', 14);
    const findNext = createEl('button', { className: 'browser-nav-btn', style: 'padding:2px 6px;', title: 'Next', 'aria-label': 'Next match' });
    findNext.innerHTML = svgIcon('chevron-down', 14);
    const findClose = createEl('button', { className: 'browser-nav-btn', style: 'padding:2px 6px;', title: 'Close', 'aria-label': 'Close find bar' });
    findClose.innerHTML = svgIcon('x', 14);
    findBar.append(findInput, findCount, findPrev, findNext, findClose);

    const openFindBar = () => {
      findBar.style.display = 'flex';
      findInput.focus();
      findInput.select();
    };

    // iframe find helpers — RegExp.escape (ES2025) makes the query safe
    // even when the user types regex metacharacters.
    let _iframeFinds = [];
    let _iframeFindIdx = 0;
    let _lastFindText = '';
    let _findRegex = null;

    function buildFindRegex(text) {
      if (text === _lastFindText && _findRegex) return _findRegex;
      _lastFindText = text;
      _findRegex = text ? new RegExp(RegExp.escape(text), 'gi') : null;
      return _findRegex;
    }

    function iframeFind(text, backward) {
      const ifr = tabIframes.get(activeTabId);
      if (!ifr) return;
      let doc;
      try {
        doc = ifr.contentDocument;
      } catch (e) {
        console.warn('[NB Browser] Cannot search cross-origin iframe:', e.message);
        findCount.textContent = '0/0';
        return;
      }
      if (!doc || !doc.body) return;

      // Clear previous highlights then NORMALIZE to merge fragmented text nodes
      // back together — otherwise splitting marks leaves the DOM in a messy
      // state that breaks subsequent searches.
      doc.querySelectorAll('.__nb_highlight').forEach(el => {
        el.replaceWith(doc.createTextNode(el.textContent));
      });
      doc.body.normalize();
      _iframeFinds = [];

      if (!text) { findCount.textContent = ''; return; }

      const re = buildFindRegex(text);
      if (!re) return;

      // Walk text nodes, skipping script/style so we don't break page JS.
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const tag = node.parentElement?.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      const toReplace = [];
      let node;
      while ((node = walker.nextNode())) {
        re.lastIndex = 0;
        if (re.test(node.textContent)) toReplace.push(node);
      }

      for (const tn of toReplace) {
        const frag = doc.createDocumentFragment();
        let last = 0, m;
        re.lastIndex = 0;
        const textContent = tn.textContent;
        while ((m = re.exec(textContent)) !== null) {
          frag.appendChild(doc.createTextNode(textContent.slice(last, m.index)));
          const mark = doc.createElement('mark');
          mark.className = '__nb_highlight';
          // font:inherit preserves every font property so highlights don't
          // reflow text or break custom fonts.
          mark.style.cssText =
            'background:#f6c90e !important;color:#000 !important;' +
            'font:inherit !important;display:inline !important;' +
            'padding:0 !important;margin:0 !important;border-radius:2px;' +
            'text-decoration:inherit !important;vertical-align:inherit !important;';
          mark.textContent = m[0];
          frag.appendChild(mark);
          _iframeFinds.push(mark);
          last = m.index + m[0].length;
        }
        frag.appendChild(doc.createTextNode(textContent.slice(last)));
        tn.parentNode.replaceChild(frag, tn);
      }

      if (!_iframeFinds.length) { findCount.textContent = '0/0'; return; }
      _iframeFindIdx = backward ? _iframeFinds.length - 1 : 0;
      _iframeFinds[_iframeFindIdx].style.background = '#ff7043 !important';
      _iframeFinds[_iframeFindIdx].scrollIntoView({ block: 'center' });
      findCount.textContent = (_iframeFindIdx + 1) + '/' + _iframeFinds.length;
    }

    function iframeFindStep(backward) {
      if (!_iframeFinds.length) return;
      _iframeFinds[_iframeFindIdx].style.background = '#f6c90e !important';
      _iframeFindIdx = ((_iframeFindIdx + (backward ? -1 : 1)) + _iframeFinds.length) % _iframeFinds.length;
      _iframeFinds[_iframeFindIdx].style.background = '#ff7043 !important';
      _iframeFinds[_iframeFindIdx].scrollIntoView({ block: 'center' });
      findCount.textContent = (_iframeFindIdx + 1) + '/' + _iframeFinds.length;
    }

    function iframeFindClear() {
      const ifr = tabIframes.get(activeTabId);
      if (!ifr) return;
      try {
        const d = ifr.contentDocument;
        if (d?.body) {
          d.querySelectorAll('.__nb_highlight').forEach(el => {
            el.replaceWith(d.createTextNode(el.textContent));
          });
          d.body.normalize();
        }
      } catch { /* cross-origin — expected, ignore */ }
      _iframeFinds = [];
      _iframeFindIdx = 0;
    }

    function closeFindBar() {
      findBar.style.display = 'none';
      findCount.textContent = '';
      if (getTabMode(activeTabId) === 'iframe') {
        iframeFindClear();
      } else {
        const wv = tabWebviews.get(activeTabId);
        if (wv) try { wv.stopFinding('clear'); } catch { /* ignore */ }
      }
    }

    function clearFindStateOnModeSwitch() {
      iframeFindClear();
      findCount.textContent = '';
    }

    function webviewFind(q, opts) {
      const wv = tabWebviews.get(activeTabId);
      if (!wv || !q) { findCount.textContent = ''; return; }
      try {
        wv.find(q, opts, r => {
          if (r) findCount.textContent = r.activeMatchOrdinal + '/' + r.numberOfMatches;
        });
      } catch { /* ignore */ }
    }

    findInput.addEventListener('input', () => {
      const q = findInput.value;
      if (getTabMode(activeTabId) === 'iframe') iframeFind(q, false);
      else webviewFind(q, {});
    });
    findInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        if (getTabMode(activeTabId) === 'iframe') iframeFindStep(e.shiftKey);
        else webviewFind(findInput.value, { backward: e.shiftKey });
      }
      if (e.key === 'Escape') closeFindBar();
    });
    findPrev.addEventListener('click', () => {
      if (getTabMode(activeTabId) === 'iframe') iframeFindStep(true);
      else webviewFind(findInput.value, { backward: true });
    });
    findNext.addEventListener('click', () => {
      if (getTabMode(activeTabId) === 'iframe') iframeFindStep(false);
      else webviewFind(findInput.value, { backward: false });
    });
    findClose.addEventListener('click', closeFindBar);

    // Panel (Bookmarks / History) — event-delegated, so there's a single
    // click listener for the whole list regardless of how many rows render.
    const panel = createEl('div', {
      style: 'display:none;position:absolute;top:0;right:0;bottom:0;width:300px;background:var(--bg-elevated);border-left:1px solid var(--border-subtle);z-index:100;flex-direction:column;overflow:hidden;'
    });

    function showPanel(type) {
      _panelType = type;
      if (!panel.parentNode) viewport.appendChild(panel);
      panel.style.display = 'flex';
      panel.replaceChildren();

      const hdr = createEl('div', {
        style: 'display:flex;align-items:center;padding:10px 12px;border-bottom:1px solid var(--border-subtle);gap:8px;flex-shrink:0;'
      });
      const title = createEl('span', {
        textContent: type === 'bookmarks' ? '★ Bookmarks' : '🕐 History',
        style: 'font-size:13px;font-weight:600;flex:1;'
      });
      const closeP = createEl('button', { className: 'browser-nav-btn', style: 'padding:2px 6px;', 'aria-label': 'Close panel' });
      closeP.innerHTML = svgIcon('x', 14);
      closeP.addEventListener('click', () => { panel.style.display = 'none'; _panelType = null; });
      hdr.append(title, closeP);
      panel.appendChild(hdr);

      const list = createEl('div', { style: 'flex:1;overflow-y:auto;' });
      panel.appendChild(list);

      const items = type === 'bookmarks' ? loadBookmarks() : loadHistory();
      if (!items.length) {
        const empty = createEl('div', {
          style: 'text-align:center;padding:32px 16px;color:var(--text-muted);font-size:13px;'
        });
        empty.innerHTML = type === 'bookmarks'
          ? 'No bookmarks yet.<br>Click ★ to save a page.'
          : 'No history yet.';
        list.appendChild(empty);
        return;
      }

      // Event delegation for row clicks & delete buttons — one listener
      // for the whole list, regardless of how many rows there are.
      list.addEventListener('click', (e) => {
        const del = e.target.closest('[data-panel-del]');
        if (!del) {
          const row = e.target.closest('[data-panel-row]');
          if (row) navigate(row.dataset.url);
          return;
        }
        e.stopPropagation();
        const row = del.closest('[data-panel-row]');
        if (!row) return;
        const itemUrl = row.dataset.url;
        const itemTs = row.dataset.ts;
        if (type === 'bookmarks') {
          saveBookmarks(loadBookmarks().filter(b => b.url !== itemUrl));
          refreshBookmarkSet();
        } else {
          saveHistory(loadHistory().filter(h => h.ts != itemTs));
        }
        showPanel(type);
      });

      for (const item of items) {
        const row = createEl('div', {
          style: 'display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border-subtle);',
          'data-panel-row': 'true',
          'data-url': item.url,
          'data-ts': item.ts || ''
        });
        const ico = createEl('span', { style: 'flex-shrink:0;color:var(--text-muted);' });
        const fimg = document.createElement('img');
        if (item.favicon && /^https?:\/\//i.test(item.favicon)) {
          fimg.src = normFavicon(item.favicon);
        } else {
          try { fimg.src = '/api/favicon?domain=' + encodeURIComponent(new URL(item.url).hostname); }
          catch { fimg.src = ''; }
        }
        fimg.style.cssText = 'width:14px;height:14px;border-radius:2px;';
        fimg.onerror = () => { ico.replaceChildren(); ico.innerHTML = svgIcon('globe', 14); };
        if (fimg.src) ico.appendChild(fimg); else ico.innerHTML = svgIcon('globe', 14);

        const info = createEl('div', { style: 'flex:1;min-width:0;' });
        const iTitle = createEl('div', {
          style: 'font-size:12px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
          textContent: item.title || item.url
        });
        const iUrl = createEl('div', {
          style: 'font-size:10px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
          textContent: item.url
        });
        info.append(iTitle, iUrl);

        const del = createEl('button', {
          className: 'browser-nav-btn',
          style: 'padding:2px 4px;opacity:0;transition:opacity 0.1s;',
          title: 'Remove',
          'aria-label': 'Remove item',
          'data-panel-del': 'true'
        });
        del.innerHTML = svgIcon('x', 12);
        row.append(ico, info, del);
        list.appendChild(row);
      }
    }

    viewport.appendChild(panel);
    container.append(tabsBar, toolbar, findBar, viewport);
    content.appendChild(container);

    // Popup mode — when opened via window.open() from another app, the
    // browser chrome is stripped down to just the URL bar (read-only) +
    // a "Popup" badge.
    if (options?.popup) {
      tabsBar.style.display = 'none';
      fwdBtn.style.display = 'none';
      refreshBtn.style.display = 'none';
      starBtn.style.display = 'none';
      menuBtn.style.display = 'none';
      urlBar.readOnly = true;
      urlBar.style.cursor = 'default';
      urlBar.style.background = 'transparent';
      urlBar.style.boxShadow = 'none';

      const popupBadge = createEl('span', {
        style: 'font-size:10px;font-weight:600;color:var(--text-muted);' +
               'background:var(--bg-hover);border:1px solid var(--border-subtle);' +
               'border-radius:4px;padding:2px 7px;white-space:nowrap;flex-shrink:0;' +
               'letter-spacing:.05em;text-transform:uppercase;',
        textContent: 'Popup'
      });
      toolbar.appendChild(popupBadge);
      tabs[0].isPopup = true;
    }

    let currentUrl = '';

    const getTabMode = (tabId) => tabViewMode.get(tabId) || 'webview';

    // Stable browser session ID. Persisted across launches so cookies,
    // localStorage, etc. inside the webview survive a browser restart.
    // Generated once per OS profile and stored in OS.settings.
    let _bpid = OS.settings.get('browserPartitionId');
    if (!_bpid) {
      _bpid = 'b' + Math.random().toString(36).slice(2, 12);
      OS.settings.set('browserPartitionId', _bpid);
    }
    const BROWSER_PARTITION = 'persist:' + _bpid;

    // URL tracking — syncUrlForTab is hoisted to outer scope (not nested
    // in getOrCreateWebview) because both the per-tab webview listeners
    // AND the shared poll timer below need to call it, and it doesn't
    // depend on any per-tab closure state.
    function syncUrlForTab(url, forTabId, source) {
      if (!url || url === 'about:blank' || url === 'about:newtab') return;
      const tab = tabs.find(t => t.id === forTabId);
      if (tab) tab.url = url;
      if (forTabId !== activeTabId) return;
      currentUrl = url;
      urlBar.value = stripHttps(url);
      updateUrlIcon(url);
      const bkd = isBookmarked(url);
      starBtn.style.color = bkd ? 'var(--accent)' : '';
      starBtn.innerHTML = svgIcon(bkd ? 'star-filled' : 'star', 16);
      // Update only the active tab's title; full re-render is wasteful for SPAs.
      if (tab?.title) updateTabTitle(forTabId, tab.title);
    }

    // Shared single-timer URL poller.
    // Instead of N intervals (one per webview), use ONE interval that polls
    // only the currently-active webview. Reduces timer overhead and
    // executeScript calls from O(tabs) to O(1) per tick.
    const _lastPolledUrls = new Map(); // tabId → string
    const _urlPollTimer = setInterval(() => {
      const wv = tabWebviews.get(activeTabId);
      if (!wv) return;
      try {
        wv.executeScript({ code: 'location.href' }, results => {
          if (chrome.runtime?.lastError) return;
          const url = Array.isArray(results) ? results[0] : results;
          if (typeof url !== 'string' || url === 'about:blank') return;
          if (url === _lastPolledUrls.get(activeTabId)) return;
          _lastPolledUrls.set(activeTabId, url);
          syncUrlForTab(url, activeTabId, 'poll');
        });
      } catch (err) {
        console.warn('[NB Browser] URL poll executeScript failed:', err);
      }
    }, URL_POLL_MS);
    state.cleanups.push(() => clearInterval(_urlPollTimer));

    // Info bar — for unresponsive pages, certificate warnings, etc.
    function showInfoBar(tabId, msg, actions) {
      dismissInfoBar(tabId);
      const bar = createEl('div', {
        className: 'browser-info-bar',
        'data-tab': String(tabId),
        style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;background:#3a2a1a;color:#f6c90e;border-bottom:1px solid rgba(255,255,255,0.08);font-size:12px;'
      });
      bar.textContent = msg;
      for (const a of actions) {
        const b = createEl('button', {
          style: 'background:transparent;border:1px solid rgba(255,255,255,0.2);color:inherit;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;',
          textContent: a.label
        });
        // Bind to appAbort so a teardown cleans these up even if dismissInfoBar
        // is never explicitly called.
        b.addEventListener('click', a.action, { signal: appAbort.signal });
        bar.appendChild(b);
      }
      viewport.insertBefore(bar, viewport.firstChild);
    }
    function dismissInfoBar(tabId) {
      const existing = viewport.querySelector(`.browser-info-bar[data-tab="${tabId}"]`);
      if (existing) existing.remove();
    }

    // Permission gate for downloads — checks AppPermissionManager for the
    // 'vfs:write' capability, prompting the user if not yet decided.
    // Hoisted out of getOrCreateWebview because it has no per-webview state;
    // defining it once at init scope avoids recreating it on every webview.
    async function ensureBrowserFsWritePermission() {
      const mgr = window.AppPermissionManager;
      if (!mgr) return true;
      const appId = 'com.nbosp.browser';
      if (mgr.isGranted('vfs:write', appId)) return true;
      if (mgr.isDenied?.('vfs:write', appId)) {
        Notify.show({
          title: 'Download blocked',
          body: 'Browser does not have permission to write files. Grant "vfs:write" in Settings → Apps.',
          type: 'error', appName: 'Browser',
        });
        return false;
      }
      const granted = await mgr.requestPermission('vfs:write', appId, {
        appName: 'Browser',
        reason: 'Browser needs to save downloaded files to your Downloads folder.',
      });
      if (!granted) {
        Notify.show({
          title: 'Download blocked',
          body: 'Browser was denied permission to write files.',
          type: 'error', appName: 'Browser',
        });
        return false;
      }
      return true;
    }

    // Sanitise a filename for saving to disk: strip path separators, control
    // characters, and truncate to MAX_DL_NAME_LEN. Returns a non-empty name.
    function sanitizeDownloadName(rawName) {
      const base = (() => {
        try { return decodeURIComponent(new URL(rawName).pathname.split('/').pop()); }
        catch { return ''; }
      })() || ('download_' + Date.now());
      const cleaned = base.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').trim() || ('download_' + Date.now());
      return cleaned.length > MAX_DL_NAME_LEN ? cleaned.slice(0, MAX_DL_NAME_LEN) : cleaned;
    }

    // Pick a non-colliding filename in the downloads folder by appending
    // " (N)" before the extension if the proposed name already exists.
    function pickUniqueDownloadName(folderId, name, ext) {
      const existing = FS.listDir(folderId).map(f => f.name);
      if (!existing.includes(name + ext)) return name;
      const prefixCount = existing.filter(n => n.startsWith(name)).length;
      return name.replace(/(\.\w+)?$/, ' (' + prefixCount + ')$1');
    }

    // Webview factory — creates or returns the <webview> element for a tab.
    // Attaches all event listeners (load, error, fullscreen, permission,
    // download, new-window, context-menu) exactly once per webview.
    function getOrCreateWebview(tabId) {
      const existing = tabWebviews.get(tabId);
      if (existing) return existing;

      const wv = document.createElement('webview');
      const tab = tabs.find(t => t.id === tabId);
      wv.setAttribute('partition', tab?.incognito ? ('incognito_' + tabId) : BROWSER_PARTITION);
      wv.setAttribute('allowfullscreen', 'true');
      wv.setAttribute('nodeintegration', 'false');
      wv.setAttribute('enableremotemodule', 'false');
      wv.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
      wv.style.cssText = 'width:100%;height:100%;border:none;flex:1;position:absolute;visibility:hidden;pointerEvents:none;z-index:0;top:0;left:0;';
      // Stash the tabId directly on the element. NW.js's webRequest event
      // system doesn't reliably retain a closure over the local `tabId`
      // parameter (confirmed by the pre-existing onBeforeRequest listener
      // already avoiding outer-local refs for the same reason). The element
      // itself is what the listener closure captures, and property reads on
      // it always work.
      wv._nbTabId = tabId;

      wv.addEventListener('loadcommit', e => {
        if (e.isTopLevel && e.url) syncUrlForTab(e.url, tabId, 'loadcommit');
      });

      wv.addEventListener('loadstop', () => {
        // Sync URL via executeScript (NW.js has no did-navigate event).
        try {
          wv.executeScript({ code: 'location.href' }, r => {
            if (chrome.runtime?.lastError || !r?.[0]) return;
            syncUrlForTab(r[0], tabId, 'loadstop+executeScript');
          });
        } catch (ex) {
          console.log('[NB Browser] executeScript(loadstop) threw:', ex);
        }
        // Fetch title + href together and save history after each load.
        try {
          wv.executeScript({
            code: `[
              document.title,
              location.href,
              Array.from(document.querySelectorAll('link[rel]'))
                .find(link => /(?:^|\\s)(?:icon|shortcut icon|apple-touch-icon)(?:\\s|$)/i.test(link.rel))
                ?.href || ''
            ]`
          }, r => {
            if (chrome.runtime?.lastError) return;
            const result = Array.isArray(r) ? r[0] : null;
            if (!Array.isArray(result)) return;
            const [title, url, iconUrl] = result;
            const tab = tabs.find(t => t.id === tabId);
            if (!tab) return;
            if (title) {
              tab.title = title;
              if (tabId === activeTabId) updateTabTitle(tabId, title);
              else renderTabs();
              if (options?.popup && state.titleText) state.titleText.textContent = title;
            }
            try {
              const hostname = new URL(url || tab.url).hostname;
              tab.favicon = typeof iconUrl === 'string' && iconUrl
                ? iconUrl
                : '/api/favicon?domain=' + encodeURIComponent(hostname);
              if (tabId === activeTabId) renderTabs(); // re-render for favicon
            } catch { /* ignore */ }
            if (url && !url.startsWith('novabyte:') && !url.startsWith('file://')) {
              addHistory(tabId, url, title || url, tab.favicon);
            }
          });
        } catch { /* ignore */ }
      });

      wv.addEventListener('contentload', () => {
        try {
          wv.executeScript({ code: 'location.href' }, r => {
            if (chrome.runtime?.lastError || !r?.[0]) return;
            syncUrlForTab(r[0], tabId, 'contentload+executeScript');
          });
        } catch { /* ignore */ }
        // New page load — apply the current system volume to whatever
        // <audio>/<video> it just created, instead of leaving them at
        // the page's own default until the tray slider is next touched.
        if (typeof OS !== 'undefined' && typeof OS.applyVolumeToWebviews === 'function') {
          OS.applyVolumeToWebviews(Number.isFinite(OS.volume) ? OS.volume : 80, wv);
        }
      });

      // Network / certificate error handling — render a custom error page
      // inside the webview instead of leaving the user staring at a blank box.
      wv.addEventListener('loaderror', e => {
        if (!e.isTopLevel) return;
        const failedUrl = e.validatedURL || currentUrl || '';
        const code = e.errorCode || 0;
        const desc = e.errorDescription || '';

        let titleText, message, hint, showBypass = false;
        if (desc.includes('CERT') || desc.includes('SSL') || desc.includes('HTTPS') ||
            code === -202 || code === -200 || code === -207) {
          titleText = '⚠ Certificate Error';
          message = 'The connection to this site is not trusted. The certificate may be self-signed, expired, or issued by an unknown authority.';
          hint = 'If this is a local development server, click "Proceed anyway" below.';
          showBypass = true;
        } else if (desc.includes('CONNECTION_REFUSED') || code === -102) {
          titleText = '⚡ Connection Refused';
          message = 'No server is listening at this address. Check that the server is running and the port is correct.';
          hint = (failedUrl.includes('localhost') || failedUrl.includes('127.0.0.1'))
            ? 'Tip: make sure your local server is started (e.g. npm start).'
            : '';
        } else if (desc.includes('NAME_NOT_RESOLVED') || code === -105) {
          titleText = '🌐 DNS Error';
          message = 'The hostname could not be resolved. Check the URL or your internet connection.';
          hint = '';
        } else if (desc.includes('TIMED_OUT') || code === -7) {
          titleText = '⏱ Connection Timed Out';
          message = 'The server took too long to respond.';
          hint = 'Try again or check your network.';
        } else {
          titleText = '✕ Page Failed to Load';
          message = 'Something went wrong loading this page.';
          hint = desc ? 'Error: ' + desc : '';
        }

        // Build the error page. The <script> tag uses data-attributes +
        // addEventListener (no inline handlers — CSP-safe). All user-
        // controlled strings (failedUrl, hint) are HTML-escaped before
        // being interpolated into the markup.
        const escapeHtml = (s) =>
          s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        const safeHint = escapeHtml(hint);
        const safeUrl  = escapeHtml(failedUrl);

        const bypassAttr = showBypass ? ' data-bypass="1"' : '';
        const errorHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${titleText}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#c9d1d9;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{max-width:520px;width:100%;background:#161b22;border:1px solid #30363d;
        border-radius:12px;padding:32px 36px;text-align:center}
  h1{font-size:20px;font-weight:700;margin-bottom:12px;color:#f0f6fc}
  p{font-size:13px;color:#8b949e;line-height:1.6;margin-bottom:8px}
  .url{font-size:11px;color:#58a6ff;word-break:break-all;margin-bottom:20px;
       background:#0d1117;padding:6px 10px;border-radius:6px;border:1px solid #21262d}
  .hint{font-size:12px;color:#e3b341;margin-bottom:20px}
  .actions{display:flex;justify-content:center;flex-wrap:wrap;gap:8px}
  button{background:#238636;color:#fff;border:none;padding:8px 18px;border-radius:6px;
         cursor:pointer;font-size:13px}
  button:hover{opacity:.85}
  button.unsafe{background:#e05d44}
</style></head><body>
<div class="card">
  <h1>${titleText}</h1>
  <p>${message}</p>
  <div class="url">${safeUrl}</div>
  ${safeHint ? `<div class="hint">${safeHint}</div>` : ''}
  <div class="actions">
    ${showBypass ? '<button class="unsafe" id="__nb_bypass">Proceed anyway (unsafe)</button>' : ''}
    <button id="__nb_retry">↺ Retry</button>
  </div>
</div>
<script>
  (function() {
    const u = ${JSON.stringify(failedUrl)};
    const r = document.getElementById('__nb_retry');
    if (r) r.addEventListener('click', () => { window.location.href = u; });
    const b = document.getElementById('__nb_bypass');
    if (b) b.addEventListener('click', () => { window.location.href = u; });
  })();
</script>
</body></html>`;

        try {
          // JSON.stringify the whole HTML string so it survives being
          // embedded inside a JS template literal executed via executeScript.
          const htmlStr = JSON.stringify(errorHtml);
          wv.executeScript({
            code: `requestAnimationFrame(() => { document.documentElement.innerHTML = ${htmlStr}; });`
          }, () => {});
        } catch { /* ignore */ }
      });

      wv.addEventListener('loadabort', e => {
        if (!e.isTopLevel) return;
        if (!e.url || e.url === 'about:blank' || e.url === 'about:newtab') return;
        if (e.reason === 'ERR_ABORTED') return;
        const reasonJson = JSON.stringify(e.reason || 'Unknown reason');
        try {
          wv.executeScript({ code: `
            (function() {
              const reason = ${reasonJson};
              const html = '<html><body style="background:#0d1117;color:#c9d1d9;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">' +
                '<div style="text-align:center;max-width:400px">' +
                '<div style="font-size:32px;margin-bottom:12px">🚫</div>' +
                '<div style="font-size:16px;font-weight:700;margin-bottom:8px">Navigation Blocked</div>' +
                '<div style="font-size:12px;color:#8b949e;margin-bottom:16px">' + reason + '</div>' +
                '<button id="__nb_back" style="background:#238636;color:#fff;border:none;padding:8px 18px;border-radius:6px;cursor:pointer">← Go Back</button>' +
                '</div></body></html>';
              document.documentElement.innerHTML = html;
              const b = document.getElementById('__nb_back');
              if (b) b.addEventListener('click', () => history.back());
            })();
          ` }, () => {});
        } catch { /* ignore */ }
      });

      // Fullscreen support for web content — when a page requests
      // element fullscreen, expand the webview to cover the whole OS
      // window and ask the OS shell to enter fullscreen too.
      wv.addEventListener('enter-html-full-screen', () => {
        wv.style.position = 'fixed';
        wv.style.inset = '0';
        wv.style.zIndex = '2147483647';
        wv.style.width = '100vw';
        wv.style.height = '100vh';
        wv.style.visibility = 'visible';
        wv.style.pointerEvents = 'auto';
        document.body.style.overflow = 'hidden';

        if (document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen().catch(() => {});
        } else if (document.documentElement.webkitRequestFullscreen) {
          document.documentElement.webkitRequestFullscreen();
        }
        if (typeof nw !== 'undefined' && nw.Window) {
          try { nw.Window.get().enterFullscreen(); } catch { /* ignore */ }
        }
      });

      wv.addEventListener('leave-html-full-screen', () => {
        wv.style.position = 'absolute';
        wv.style.inset = 'auto';
        wv.style.zIndex = '1';
        wv.style.width = '100%';
        wv.style.height = '100%';
        document.body.style.overflow = '';

        if (document.fullscreenElement && document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
        if (typeof nw !== 'undefined' && nw.Window) {
          try { nw.Window.get().leaveFullscreen(); } catch { /* ignore */ }
        }
      });

      const _onFsChange = () => {
        if (!document.fullscreenElement) {
          wv.style.position = 'absolute';
          wv.style.inset = 'auto';
          wv.style.zIndex = '1';
          wv.style.width = '100%';
          wv.style.height = '100%';
          document.body.style.overflow = '';
        }
      };
      document.addEventListener('fullscreenchange', _onFsChange);
      state.cleanups.push(() => document.removeEventListener('fullscreenchange', _onFsChange));

      // Process status monitoring — show an info bar offering Wait/Reload
      // when a page becomes unresponsive.
      wv.addEventListener('unresponsive', () => {
        if (tabUnresponsive.has(tabId)) return;
        tabUnresponsive.add(tabId);
        console.warn('[NB Browser] Page became unresponsive: tabId', tabId);
        if (tabId === activeTabId) {
          showInfoBar(
            tabId,
            '⚠\uFE0F This page is not responding.',
            [
              { label: 'Wait', action: () => {} },
              { label: 'Reload', action: () => navigate(tabs.find(t => t.id === tabId)?.url || '') }
            ]
          );
        }
      });
      wv.addEventListener('responsive', () => {
        if (!tabUnresponsive.delete(tabId)) return;
        console.log('[NB Browser] Page became responsive again: tabId', tabId);
        dismissInfoBar(tabId);
      });

      // Download handling. NW.js's webview 'permissionrequest' event with
      // permission='download' is the only reliable hook into downloads
      // initiated by guest content; we deny the native request and run
      // our own fetch+save pipeline so the file lands in the OS Downloads
      // folder with a Downloads manager entry.
      wv.addEventListener('permissionrequest', e => {
        if (e.permission === 'fullscreen') { e.request.allow(); return; }
        if (e.permission === 'pointerLock') { e.request.allow(); return; }
        if (e.permission === 'download') {
          e.request.deny();
          // Promise.try (ES2025) unifies sync-throw and async-reject into a
          // single catchable chain.
          Promise.try(async () => {
            const _url = e.request.url;
            if (!_url || !/^https?:\/\//i.test(_url)) return;
            if (!(await ensureBrowserFsWritePermission())) return;
            try {
              const finalName = sanitizeDownloadName(_url);
              const ext = finalName.includes('.') ? '' : '.bin';
              const dlFolderId = FS.specialFolders.downloads;
              if (!dlFolderId) throw new Error('Downloads folder missing');
              const adjusted = pickUniqueDownloadName(dlFolderId, finalName, ext);
              const entry = window.Downloads?.add(adjusted + ext, _url, 0, '');
              const entryId = entry?.id;
              if (entryId) window.Downloads?.setStatus(entryId, 'downloading');
              WM.createWindow('nbosp-downloads');
              const resp = await fetch(_url);
              if (!resp.ok) throw new Error('HTTP ' + resp.status);
              const cl = resp.headers.get('content-length');
              if (cl && +cl > DOWNLOAD_MAX_BYTES) throw new Error('File too large');
              const buf = await resp.arrayBuffer();
              if (buf.byteLength > DOWNLOAD_MAX_BYTES) throw new Error('File too large');
              // Encode as base64 for storage. Uint8Array.toBase64 (ES2026)
              // is the native, non-looping way; node.content has to survive
              // JSON.stringify inside app-sandbox.js's respond() when a
              // sandboxed app later reads this file via nova:vfs:read —
              // JSON.stringify flattens a raw Uint8Array into an
              // index-keyed object that silently corrupts binary data,
              // so base64 is required regardless of encoding approach.
              const base64Content = new Uint8Array(buf).toBase64();
              await FS.createFile(dlFolderId, adjusted + ext, base64Content, 'application/octet-stream');
              if (entryId) window.Downloads?.setStatus(entryId, 'done', buf.byteLength);
              Notify.show({
                title: 'Download complete', body: adjusted + ext,
                type: 'success', appName: 'Downloads'
              });
              OS.events.emit('fs:created', {});
            } catch (err) {
              console.error('Download handler error:', err);
              Notify.show({
                title: 'Download failed', body: String(err.message || err),
                type: 'error', appName: 'Downloads'
              });
            }
          });
        }
      });

      // Popup / new-window support (NW.js Chrome Apps webview API).
      wv.addEventListener('newwindow', async e => {
        const url = e.targetUrl;
        if (!url || url === 'about:blank' || url.startsWith('javascript:')) return;

        function isAuthPopup(u) {
          try {
            const parsed = new URL(u);
            const host = parsed.hostname.toLowerCase();
            const path = parsed.pathname.toLowerCase();
            if (AUTH_HOSTS.some(h => host === h || host.endsWith('.' + h))) return true;
            if (AUTH_PATHS.some(p => path.startsWith(p) || path.includes(p + '/'))) return true;
            const params = parsed.searchParams;
            if (params.has('client_id') || params.has('response_type') || params.has('redirect_uri')) return true;
          } catch { /* ignore */ }
          return false;
        }

        if (getSetting('block_popup_windows', true) && e.windowOpenDisposition === 'new_popup' && !isAuthPopup(url)) {
          try { if (e.window?.discard) e.window.discard(); } catch { /* ignore */ }
          return;
        }

        const disposition = e.windowOpenDisposition;

        if (disposition === 'new_popup') {
          // Inline popup overlay — e.window.attach() preserves the opener
          // link so window.close() works inside the popup.
          const pw = Math.min(Math.max(e.initialWidth || 520, 360), Math.round(window.innerWidth * 0.75));
          const ph = Math.min(Math.max(e.initialHeight || 620, 300), Math.round(window.innerHeight * 0.85));

          const backdrop = document.createElement('div');
          backdrop.style.cssText = 'position:absolute;inset:0;z-index:9999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;';

          const card = document.createElement('div');
          card.style.cssText = `width:${pw}px;height:${ph}px;background:var(--bg,#1e1e2e);border-radius:10px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.08);`;

          const bar = document.createElement('div');
          bar.style.cssText = 'height:36px;min-height:36px;background:var(--bg2,#181825);display:flex;align-items:center;padding:0 10px;gap:8px;border-bottom:1px solid rgba(255,255,255,0.06);user-select:none;';
          const barTitle = document.createElement('span');
          barTitle.style.cssText = 'flex:1;font-size:12px;opacity:0.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
          barTitle.textContent = url;
          const barClose = document.createElement('button');
          barClose.textContent = '✕';
          barClose.setAttribute('aria-label', 'Close popup');
          barClose.style.cssText = 'background:none;border:none;color:inherit;opacity:0.5;cursor:pointer;font-size:13px;padding:2px 6px;border-radius:4px;';
          barClose.onmouseenter = () => barClose.style.opacity = '1';
          barClose.onmouseleave = () => barClose.style.opacity = '0.5';
          bar.append(barTitle, barClose);

          const popWv = document.createElement('webview');
          popWv.style.cssText = 'flex:1;width:100%;';
          const _parentTab = tabs.find(t => t.id === tabId);
          const _popPartition = _parentTab?.incognito
            ? ('incognito_' + tabId)
            : BROWSER_PARTITION;
          popWv.setAttribute('partition', _popPartition);

          card.append(bar, popWv);
          backdrop.appendChild(card);
          container.appendChild(backdrop);

          const closePopup = () => backdrop.remove();
          barClose.addEventListener('click', closePopup);

          popWv.addEventListener('loadstop', () => {
            try {
              popWv.executeScript({ code: 'document.title' }, r => {
                if (chrome.runtime?.lastError || !r?.[0]) return;
                barTitle.textContent = r[0];
              });
            } catch { /* ignore */ }
            if (typeof OS !== 'undefined' && typeof OS.applyVolumeToWebviews === 'function') {
              OS.applyVolumeToWebviews(Number.isFinite(OS.volume) ? OS.volume : 80, popWv);
            }
          });
          popWv.addEventListener('close', closePopup);
          e.window.attach(popWv);
        } else {
          // For tabs: discard the NW native window, open as a new tab instead.
          try { if (e.window?.discard) e.window.discard(); } catch { /* ignore */ }
          const parentTab = tabs.find(t => t.id === tabId);
          const newTab = {
            id: nextTabId++,
            title: 'New Tab',
            url: '',
            favicon: '',
            incognito: parentTab?.incognito || false
          };
          tabs.push(newTab);
          if (getSetting('open_in_background', false)) {
            renderTabs();
            const bgWv = getOrCreateWebview(newTab.id);
            if (!bgWv.parentNode) viewport.appendChild(bgWv);
            const _bgCanonical = url.toLowerCase()
              .replace(/[\s\u0000-\u001f\u007f-\u009f]/g, '')
              .trim();
            if (!/^(javascript|data|vbscript|about):/i.test(_bgCanonical) && !isLocalAddress(url)) {
              // Bypasses navigate() entirely (sets wv.src directly), so the
              // net:external gate there doesn't apply here — check it again.
              if (!/^https?:\/\//i.test(url) || await ensureExternalNetworkPermission()) bgWv.src = url;
            }
          } else {
            switchToTab(newTab.id);
            navigate(url);
          }
        }
      });

      // window.close() inside guest content closes the host tab.
      wv.addEventListener('close', () => closeTab(tabId));

      tabWebviews.set(tabId, wv);
      applyWebviewSettings(wv);
      return wv;
    }

    // iframe mode helpers — iframe mode is the fallback when <webview> is
    // unavailable (e.g. in a plain browser without NW.js). It uses a
    // sandboxed <iframe> with most of the same plumbing.
    function getOrCreateIframe(tabId) {
      const existing = tabIframes.get(tabId);
      if (existing) return existing;

      const ifr = document.createElement('iframe');
      ifr.setAttribute('allowfullscreen', 'true');
      ifr.setAttribute('allow', 'fullscreen; autoplay; clipboard-read; clipboard-write');
      // allow-same-origin intentionally ABSENT — combining it with
      // allow-scripts enables a known sandbox escape (framed doc can
      // call frameElement.removeAttribute('sandbox')).
      ifr.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation');
      ifr.style.cssText = 'width:100%;height:100%;border:none;flex:1;position:absolute;visibility:hidden;pointerEvents:none;z-index:0;top:0;left:0;background:#fff;';

      // NOTE: blocking is detected server-side via /api/frame-check before
      // the iframe is ever shown (see navigateFrameMode). The old heuristic
      // here (checking ifr.contentDocument.URL === 'about:blank') was wrong
      // both ways: embeddable sites pass through about:blank mid-load (false
      // positive), and genuinely-blocked sites are cross-origin so
      // contentDocument throws and the notice was never shown — leaving the
      // raw "refused to connect" error visible. We now just sync the title.
      ifr.addEventListener('load', () => {
        const tab = tabs.find(t => t.id === tabId);
        if (!tab?.url || !/^https?:/i.test(tab.url)) return;
        try {
          const title = ifr.contentDocument?.title;
          if (title) {
            tab.title = title;
            if (tabId === activeTabId) updateTabTitle(tabId, title);
            else renderTabs();
          }
        } catch { /* cross-origin — title sync not possible, expected */ }
      });

      tabIframes.set(tabId, ifr);
      return ifr;
    }

    function showIframeBlockedNotice(tabId, url) {
      // Remove any prior notice for this tab (e.g. stale from a previous URL).
      const prior = viewport.querySelector(`.browser-iframe-blocked[data-tab="${tabId}"]`);
      if (prior) prior.remove();
      const notice = createEl('div', { className: 'browser-iframe-blocked' });
      notice.dataset.tab = tabId;
      // Build via DOM APIs to avoid innerHTML with translated strings.
      const icon = createEl('div', { className: 'blocked-icon', textContent: '🚫' });
      const titleEl = createEl('div', { className: 'blocked-title', textContent: 'Page blocked iframe embedding' });
      const body = createEl('div', { className: 'blocked-body' });
      body.innerHTML = 'This site uses <code>X-Frame-Options</code> or <code>Content-Security-Policy: frame-ancestors</code> to prevent embedding. Switch to Webview mode to load it normally.';
      const sw = createEl('button', { className: 'blocked-switch', textContent: 'Switch to Webview Mode' });
      sw.addEventListener('click', () => { setTabMode(tabId, 'webview'); navigate(url); });
      notice.append(icon, titleEl, body, sw);
      viewport.appendChild(notice);
    }

    // Per-tab frame-check generation guard. Bumped before each
    // /api/frame-check so a slow response from a previous navigation can't
    // show/hide the iframe of a newer one.
    const _frameCheckGen = new Map(); // tabId → number

    // Server-side frame-embed check. Returns true if the URL may be loaded
    // in an <iframe> (no XFO/CSP frame-ancestors blocking it). On any error
    // or timeout we optimistically return true so we never false-block a
    // legitimate page — the iframe will just show its normal content.
    // Returns null when superseded by a newer call (caller should bail).
    async function checkFrameEmbeddable(tabId, url) {
      const gen = (_frameCheckGen.get(tabId) || 0) + 1;
      _frameCheckGen.set(tabId, gen);
      try {
        // AbortSignal.timeout caps the wait so a hanging server can't leave
        // the iframe stuck on about:blank forever.
        const r = await fetch('/api/frame-check?url=' + encodeURIComponent(url),
          { signal: AbortSignal.timeout(8000) });
        if (gen !== _frameCheckGen.get(tabId)) return null; // superseded
        if (!r.ok) return true; // fail open
        const j = await r.json();
        if (gen !== _frameCheckGen.get(tabId)) return null; // superseded
        return j.embeddable !== false;
      } catch {
        return true; // fail open — don't false-block on network errors
      }
    }

    function setTabMode(tabId, mode) {
      tabViewMode.set(tabId, mode);
      if (tabId === activeTabId) updateModeBtn();
      const wv = tabWebviews.get(tabId);
      const ifr = tabIframes.get(tabId);
      requestAnimationFrame(() => {
        if (mode === 'iframe') {
          if (wv) { wv.style.visibility = 'hidden'; wv.style.pointerEvents = 'none'; }
        } else {
          if (ifr) { ifr.style.visibility = 'hidden'; ifr.style.pointerEvents = 'none'; }
          const blocked = viewport.querySelector(`.browser-iframe-blocked[data-tab="${tabId}"]`);
          if (blocked) blocked.remove();
        }
      });
    }

    function updateModeBtn() {
      const mode = getTabMode(activeTabId);
      modeBtn.classList.toggle('iframe-active', mode === 'iframe');
      modeBtn.title = mode === 'iframe' ? 'Switch to Webview mode' : 'Switch to iframe mode';
      modeBtn.setAttribute('aria-pressed', mode === 'iframe' ? 'true' : 'false');
      modeBtn.innerHTML = (mode === 'iframe'
        ? svgIcon('layout', 14) + ' <span>iFrame</span>'
        : svgIcon('monitor', 14) + ' <span>Webview</span>');
    }

    function showViewForTab(tabId) {
      const mode = getTabMode(tabId);
      const sp = viewport.querySelector('.browser-settings-page');
      if (sp) sp.remove();
      const tab = tabs.find(t => t.id === tabId);
      const isMobile = tab?.userAgent === 'mobile';

      requestAnimationFrame(() => {
        if (mode === 'iframe') {
          for (const [, wv] of tabWebviews) {
            wv.style.position = 'absolute';
            wv.style.visibility = 'hidden';
            wv.style.pointerEvents = 'none';
            wv.style.zIndex = '0';
          }
          for (const [id, ifr] of tabIframes) {
            if (id === tabId) {
              applyMobileViewportFrame(ifr, isMobile);
              applyZoomToIframe(ifr, isMobile, tabZoom.get(tabId) || 1.0);
              // If we've already determined this URL is frame-blocked, keep
              // the iframe hidden so Chromium's "refused to connect" error
              // never shows through under our custom notice.
              const blocked = viewport.querySelector(`.browser-iframe-blocked[data-tab="${tabId}"]`);
              if (blocked) {
                ifr.style.visibility = 'hidden';
                ifr.style.pointerEvents = 'none';
                ifr.style.zIndex = '0';
              } else {
                ifr.style.visibility = 'visible';
                ifr.style.pointerEvents = 'auto';
                ifr.style.zIndex = '1';
              }
            } else {
              // Non-active iframes must be pulled out of flow — see note below.
              ifr.style.position = 'absolute';
              ifr.style.visibility = 'hidden';
              ifr.style.pointerEvents = 'none';
              ifr.style.zIndex = '0';
            }
          }
        } else {
          // Take every iframe OUT of flow. visibility:hidden alone keeps a
          // flex item in layout flow, so a previously-shown iframe left at
          // position:relative + flex:1 would claim half the viewport and
          // show through as a black bar under the active webview.
          for (const [, ifr] of tabIframes) {
            ifr.style.position = 'absolute';
            ifr.style.visibility = 'hidden';
            ifr.style.pointerEvents = 'none';
            ifr.style.zIndex = '0';
          }
          viewport.querySelectorAll(`.browser-iframe-blocked:not([data-tab="${tabId}"])`).forEach(n => n.remove());
          for (const [id, wv] of tabWebviews) {
            if (id === tabId) {
              applyMobileViewportFrame(wv, isMobile);
              if (!isMobile) {
                wv.style.width = '100%';
                wv.style.height = '100%';
                wv.style.top = '0';
                wv.style.left = '0';
              }
              wv.style.visibility = 'visible';
              wv.style.pointerEvents = 'auto';
              wv.style.zIndex = '1';
            } else {
              wv.style.position = 'absolute';
              wv.style.visibility = 'hidden';
              wv.style.pointerEvents = 'none';
              wv.style.zIndex = '0';
            }
          }
        }
      });
    }

    // Apply user prefs (zoom mode, per-page CSS overrides, permission
    // gating, request listeners for the Network tab) to a webview.
    // Called once when the webview is created.
    function applyWebviewSettings(wv) {
      const zoomMap = { FAR: 0.75, MEDIUM: 1.0, CLOSE: 1.25 };

      wv.addEventListener('loadstop', () => {
        // Use the stashed _nbTabId instead of doing an O(n) reverse
        // lookup of the webview inside tabWebviews.
        const tabId = wv._nbTabId;
        if (tabId != null && !tabZoom.has(tabId)) {
          try { wv.setZoom(zoomMap[getSetting('default_zoom', 'MEDIUM')] || 1.0); } catch { /* ignore */ }
        }
      });

      wv.addEventListener('loadcommit', () => {
        try { wv.setZoomMode(getSetting('force_userscalable', false) ? 'per-view' : 'per-origin'); } catch { /* ignore */ }
      });

      wv.addEventListener('permissionrequest', e => {
        const appId = 'com.nbosp.browser';
        if (e.permission === 'geolocation') {
          const osAllowed = AppPermissionManager?.isGranted('device:geolocation', appId);
          const browserAllowed = getSetting('enable_geolocation', true);
          if (!osAllowed) {
            Notify.show({
              title: 'Permission denied',
              body: 'Browser needs Location access in Settings → Apps.',
              type: 'error', appName: 'Browser'
            });
            e.request.deny();
            return;
          }
          browserAllowed ? e.request.allow() : e.request.deny();
        } else if (e.permission === 'media') {
          const camGranted = AppPermissionManager?.isGranted('device:camera', appId);
          const micGranted = AppPermissionManager?.isGranted('device:microphone', appId);
          if (!camGranted && !micGranted) {
            Notify.show({
              title: 'Permission denied',
              body: 'Browser needs Camera/Microphone access in Settings → Apps.',
              type: 'error', appName: 'Browser'
            });
            e.request.deny();
            return;
          }
          if (camGranted && !micGranted) {
            Notify.show({ title: 'Permission limited', body: 'Camera allowed, microphone is not permitted.', type: 'info', appName: 'Browser' });
          } else if (!camGranted && micGranted) {
            Notify.show({ title: 'Permission limited', body: 'Microphone allowed, camera is not permitted.', type: 'info', appName: 'Browser' });
          }
          e.request.allow();
        } else if (e.permission === 'pointerLock') {
          e.request.allow();
        } else {
          e.request.deny();
        }
      });

      // webRequest listeners — attach once per webview.
      let _requestListenersAttached = false;
      function _attachRequestListeners() {
        if (_requestListenersAttached) return;
        _requestListenersAttached = true;
        try {
          wv.request.onBeforeRequest.addListener(
            () => ({ cancel: !getSetting('load_images', true) }),
            { urls: ['<all_urls>'], types: ['image', 'media'] },
            ['blocking']
          );
        } catch { /* wv.request not ready yet */ }

        // Feed Perf Monitor's Network tab. wv.request lives per-<webview>
        // (a genuinely separate NW.js/Chromium process from this document),
        // so this is the only point in the codebase with visibility into
        // Browser tab traffic — perf.js cannot reach it directly and reads
        // from window.NetworkLog instead, same pattern as gallery.js's
        // window.Downloads. onCompleted/onErrorOccurred give method, URL,
        // status, type and timing — NOT response bodies; that requires
        // CDP Network.getResponseBody, which nothing here wires up, so
        // Browser-tab rows in the log intentionally never carry a body.
        try {
          wv.request.onCompleted.addListener(
            (details) => {
              const _tabId = wv._nbTabId;
              const tab = tabs.find(t => t.id === _tabId);
              window.NetworkLog?.push({
                source: 'com.nbosp.browser',
                tabId: _tabId,
                tabTitle: tab?.title || 'Tab ' + _tabId,
                method: details.method,
                url: details.url,
                type: details.type,
                statusCode: details.statusCode,
                error: null,
                // fromCache/timeStamp are what NW.js's webRequest actually
                // provides; there is no per-request start time exposed on
                // this event, so duration can't be computed honestly here —
                // unlike the OS-level fetch/XHR patch in perf.js, which
                // times its own requests directly.
                fromCache: !!details.fromCache,
                time: details.timeStamp || Date.now(),
              });
            },
            { urls: ['<all_urls>'] }
          );
          wv.request.onErrorOccurred.addListener(
            (details) => {
              const _tabId = wv._nbTabId;
              const tab = tabs.find(t => t.id === _tabId);
              window.NetworkLog?.push({
                source: 'com.nbosp.browser',
                tabId: _tabId,
                tabTitle: tab?.title || 'Tab ' + _tabId,
                method: details.method,
                url: details.url,
                type: details.type,
                statusCode: null,
                error: details.error || 'unknown error',
                fromCache: false,
                time: details.timeStamp || Date.now(),
              });
            },
            { urls: ['<all_urls>'] }
          );
        } catch { /* wv.request not ready yet */ }
      }
      wv.addEventListener('contentload', _attachRequestListeners);
      wv.addEventListener('loadcommit', _attachRequestListeners);

      // Per-page CSS: inverted colours + min font size + text zoom.
      // Injected after every loadstop so SPA navigations stay styled.
      wv.addEventListener('loadstop', () => {
        let css = '* { scrollbar-width: none !important; } '
          + '*::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; } ';
        if (getSetting('inverted', false))
          css += 'html { filter: invert(1) hue-rotate(180deg) !important; } img, video { filter: invert(1) hue-rotate(180deg) !important; } ';
        const minFont = getSetting('min_font_size', 0);
        if (minFont > 0)
          css += `* { min-height: unset !important; } body * { font-size: max(${minFont}px, 1em) !important; } `;
        const textZoom = getSetting('text_zoom', 10);
        if (textZoom !== 10)
          css += `body { zoom: ${textZoom / 10} !important; } `;
        if (css) try { wv.insertCSS({ code: css }); } catch { /* ignore */ }
      });

      // Webview viewport right-click menu.
      // NW.js does NOT forward arbitrary DOM events from guest content to
      // the host — 'contextmenu' on the <webview> element never fires
      // (confirmed dead since nw.js 0.29.3; guest content runs in its own
      // process, so host-side listeners for events outside the small
      // documented set just don't see it). So instead:
      //   1. Inject a script into the guest (on every loadstop, for SPA nav)
      //      that listens for 'contextmenu' INSIDE the guest's own document
      //      — the only place that can actually preventDefault() the native
      //      Chromium menu for that content — and reports the click target +
      //      position to the host via console.log, tagged with a marker.
      //   2. Host listens for 'consolemessage' on the <webview> (this one
      //      reliably bubbles), recognizes the tagged payload, converts the
      //      guest-relative click position into host-page coordinates using
      //      the webview's own bounding rect, and shows our ContextMenu.
      const _CTX_MARKER = '__NBOSP_CTXMENU__:';
      const _GUEST_CTX_SCRIPT = `
        (function () {
          if (window.__nbosp_ctx_injected) return;
          window.__nbosp_ctx_injected = true;
          document.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            var el  = e.target;
            var link = el.closest ? el.closest('a') : null;
            var img  = el.tagName === 'IMG'   ? el : (el.closest ? el.closest('img')   : null);
            var vid  = el.tagName === 'VIDEO' ? el : (el.closest ? el.closest('video') : null);
            var sel  = window.getSelection ? window.getSelection().toString().trim() : '';
            var ctx = {
              clientX:      e.clientX,
              clientY:      e.clientY,
              linkHref:     link ? (link.href  || '') : '',
              linkText:     link ? (link.textContent || '').trim().slice(0, 120) : '',
              imgSrc:       img  ? (img.src   || '') : '',
              imgAlt:       img  ? (img.alt   || '') : '',
              videoSrc:     vid  ? (vid.currentSrc || vid.src || '') : '',
              selectedText: sel.slice(0, 500),
              pageUrl:      location.href,
              pageTitle:    document.title
            };
            try { console.log('${_CTX_MARKER}' + JSON.stringify(ctx)); } catch (_e) {}
          }, true);
        })();
      `;

      // Re-inject the tracker after every navigation (SPAs included).
      wv.addEventListener('loadstop', () => {
        try { wv.executeScript({ code: _GUEST_CTX_SCRIPT }); } catch { /* ignore */ }
      });

      // Open a URL in a new tab (inherits incognito state from the source tab).
      function _ctxOpenInNewTab(url) {
        const _ctxTabId = wv._nbTabId;
        const _ctxTab   = tabs.find(t => t.id === _ctxTabId);
        const t = { id: nextTabId++, title: 'New Tab', url, favicon: '', incognito: _ctxTab?.incognito || false };
        tabs.push(t);
        switchToTab(t.id);
        navigate(url);
      }

      // Best-effort clipboard write — try the async Clipboard API first,
      // fall back to the deprecated execCommand path for non-secure
      // contexts where navigator.clipboard is unavailable.
      function _ctxCopyText(text) {
        try {
          navigator.clipboard.writeText(text);
        } catch {
          try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
          } catch { /* ignore */ }
        }
      }

      function _buildWebviewMenu(ctx, pageUrl) {
        const items = [];
        const hasLink  = ctx?.linkHref  && /^https?:/i.test(ctx.linkHref);
        const hasImg   = ctx?.imgSrc    && ctx.imgSrc.length > 0;
        const hasVideo = ctx?.videoSrc  && ctx.videoSrc.length > 0;
        const hasSel   = ctx?.selectedText && ctx.selectedText.length > 0;

        // Link items
        if (hasLink) {
          items.push({ label: 'Open Link in New Tab', action: () => _ctxOpenInNewTab(ctx.linkHref) });
          items.push({ label: 'Copy Link Address',    action: () => _ctxCopyText(ctx.linkHref) });
          items.push({ separator: true });
        }

        // Image items
        if (hasImg) {
          items.push({ label: 'Open Image in New Tab', action: () => _ctxOpenInNewTab(ctx.imgSrc) });
          items.push({ label: 'Copy Image Address',    action: () => _ctxCopyText(ctx.imgSrc) });
          items.push({ separator: true });
        }

        // Video items
        if (hasVideo) {
          items.push({ label: 'Open Video in New Tab', action: () => _ctxOpenInNewTab(ctx.videoSrc) });
          items.push({ label: 'Copy Video Address',    action: () => _ctxCopyText(ctx.videoSrc) });
          items.push({ separator: true });
        }

        // Selection items
        if (hasSel) {
          const snippet = ctx.selectedText.length > 40
            ? ctx.selectedText.slice(0, 40) + '\u2026'
            : ctx.selectedText;
          items.push({ label: 'Copy \u201c' + snippet + '\u201d', action: () => _ctxCopyText(ctx.selectedText) });
          const _engine = SEARCH_ENGINES[getSetting('searchEngine', 'brave')];
          if (_engine) {
            const _q = encodeURIComponent(ctx.selectedText.slice(0, 300));
            items.push({ label: 'Search for \u201c' + snippet + '\u201d', action: () => _ctxOpenInNewTab(_engine.url + _q) });
          }
          items.push({ separator: true });
        }

        // Page navigation (always present)
        items.push({ label: 'Back',    action: () => { try { wv.back();    } catch { /* ignore */ } } });
        items.push({ label: 'Forward', action: () => { try { wv.forward(); } catch { /* ignore */ } } });
        items.push({ label: 'Reload',  action: () => { try { wv.reload();  } catch { /* ignore */ } } });
        items.push({ separator: true });
        if (pageUrl && /^https?:/i.test(pageUrl)) {
          items.push({ label: 'Copy Page URL', action: () => _ctxCopyText(pageUrl) });
        }
        items.push({ label: 'Save as\u2026', action: () => {
          try { wv.executeScript({ code: 'location.href' }, r => {
            const url = (r && r[0]) || pageUrl;
            if (url) window.open(url);
          }); } catch { /* ignore */ }
        }});
        items.push({ label: 'Print\u2026', action: () => {
          try { wv.executeScript({ code: 'window.print()' }); } catch { /* ignore */ }
        }});
        items.push({ separator: true });
        items.push({ label: 'View Page Source', action: () => {
          try { wv.executeScript({ code: 'location.href' }, r => {
            const url = (r && r[0]) || pageUrl;
            if (url) _ctxOpenInNewTab('view-source:' + url);
          }); } catch { /* ignore */ }
        }});
        items.push({ label: 'Inspect', action: () => {
          try { wv.showDevTools(true); } catch {
            try { nw.Window.get().showDevTools(); } catch { /* ignore */ }
          }
        }});

        return items;
      }

      // The guest reports right-clicks here, tagged with _CTX_MARKER so we
      // never mistake an ordinary page's own console.log for our signal.
      wv.addEventListener('consolemessage', (e) => {
        const msg = e?.message;
        if (typeof msg !== 'string' || !msg.startsWith(_CTX_MARKER)) return;
        let ctx = null;
        try { ctx = JSON.parse(msg.slice(_CTX_MARKER.length)); } catch { return; }

        const _ctxTabId = wv._nbTabId;
        const _ctxTab   = tabs.find(t => t.id === _ctxTabId);
        const pageUrl    = ctx.pageUrl || _ctxTab?.url || currentUrl || '';

        // Guest coords are relative to the guest viewport; translate into
        // host-page coords using where the <webview> box actually sits.
        const rect  = wv.getBoundingClientRect();
        const hostX = rect.left + (ctx.clientX || 0);
        const hostY = rect.top  + (ctx.clientY || 0);

        ContextMenu.show(hostX, hostY, _buildWebviewMenu(ctx, pageUrl));
      });
    }

    function clearWebviewData(types, title, body) {
      requestAnimationFrame(() => {
        for (const [, wv] of tabWebviews) {
          try { wv.clearData({}, types); } catch { /* ignore */ }
        }
      });
      Notify.show({ title, body, type: 'info', appName: 'Browser' });
    }

    const showWebviewForTab = (tabId) => showViewForTab(tabId);

    // Settings page — built entirely via DOM APIs (no template literals
    // with user-controlled content). Re-renders on category switch.
    function renderSettingsPage(activeCategory) {
      activeCategory = activeCategory || 'general';
      const eng = getSetting('searchEngine', 'brave');
      const sd = viewport.querySelector('.speed-dial');
      if (sd) sd.remove();
      requestAnimationFrame(() => {
        for (const [, wv] of tabWebviews) wv.style.visibility = 'hidden';
      });
      const old = viewport.querySelector('.browser-settings-page');
      if (old) old.remove();

      const page = createEl('div', { className: 'browser-settings-page' });
      page.style.cssText = 'position:absolute;inset:0;display:flex;background:var(--bg-base);color:var(--text-primary);font-size:13px;z-index:1;';

      const getBPref = (key, def) => getSetting(key, def);
      const setBPref = (key, val) => saveSetting(key, val);

      function mkRow(label, desc, control) {
        const row = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--border-subtle);' });
        const left = createEl('div');
        left.appendChild(createEl('div', { textContent: label, style: 'font-size:13px;color:var(--text-primary);' }));
        if (desc) left.appendChild(createEl('div', { textContent: desc, style: 'font-size:11px;color:var(--text-muted);margin-top:2px;' }));
        row.append(left, control);
        return row;
      }
      const mkSubHdr = (title) => createEl('div', {
        textContent: title,
        style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);margin:20px 0 4px;'
      });

      function mkToggle(key, def, onChange) {
        const val = getBPref(key, def);
        const btn = createEl('button', {
          style: 'width:40px;height:22px;border-radius:11px;border:none;cursor:pointer;position:relative;flex-shrink:0;transition:background 0.2s;background:' + (val ? 'var(--accent)' : 'var(--text-muted)') + ';',
          'aria-pressed': val ? 'true' : 'false', role: 'switch'
        });
        const knob = createEl('div', { style: 'position:absolute;top:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.3);transition:left 0.2s;left:' + (val ? '20px' : '2px') + ';' });
        btn.appendChild(knob);
        btn.addEventListener('click', () => {
          const next = !getBPref(key, def);
          setBPref(key, next);
          btn.style.background = next ? 'var(--accent)' : 'var(--text-muted)';
          knob.style.left = next ? '20px' : '2px';
          btn.setAttribute('aria-pressed', next ? 'true' : 'false');
          if (onChange) onChange(next);
        });
        return btn;
      }

      function mkSelect(key, def, options) {
        const val = getBPref(key, def);
        const sel = createEl('select', {
          id: 'browser-pref-select-' + key, name: 'browser-pref-' + key,
          style: 'background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:6px;padding:5px 8px;color:var(--text-primary);font-size:12px;cursor:pointer;outline:none;max-width:160px;'
        });
        for (const [v, label] of options) {
          const opt = createEl('option', { value: v, textContent: label });
          if (v === val) opt.selected = true;
          sel.appendChild(opt);
        }
        sel.addEventListener('change', () => setBPref(key, sel.value));
        return sel;
      }

      function mkClearBtn(label, action) {
        const btn = createEl('button', {
          textContent: label,
          style: 'padding:6px 14px;border-radius:6px;border:1px solid var(--border-default);background:var(--bg-elevated);color:var(--text-primary);cursor:pointer;font-size:12px;white-space:nowrap;flex-shrink:0;'
        });
        btn.addEventListener('mouseenter', () => btn.style.borderColor = 'var(--accent)');
        btn.addEventListener('mouseleave', () => btn.style.borderColor = 'var(--border-default)');
        btn.addEventListener('click', action);
        return btn;
      }

      function mkSliderRow(label, key, def, min, max, suffix) {
        const row = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--border-subtle);' });
        const left = createEl('div', { style: 'display:flex;flex-direction:column;gap:2px;' });
        left.appendChild(createEl('div', { textContent: label, style: 'font-size:13px;color:var(--text-primary);' }));
        const valLabel = createEl('span', { textContent: getBPref(key, def) + (suffix || ''), style: 'font-size:11px;color:var(--accent);' });
        left.appendChild(valLabel);
        const slider = createEl('input', {
          type: 'range', min: String(min), max: String(max), value: String(getBPref(key, def)),
          id: 'browser-pref-slider-' + key, name: 'browser-pref-' + key,
          style: 'width:140px;accent-color:var(--accent);cursor:pointer;'
        });
        slider.addEventListener('input', () => {
          valLabel.textContent = slider.value + (suffix || '');
          setBPref(key, Number(slider.value));
        });
        row.append(left, slider);
        return row;
      }

      const NAV = [
        { id: 'general',       label: 'General',          icon: '⚙️' },
        { id: 'search',        label: 'Search Engine',    icon: '🔍' },
        { id: 'privacy',       label: 'Privacy & Security', icon: '🔒' },
        { id: 'content',       label: 'Content',          icon: '🌐' },
        { id: 'bandwidth',     label: 'Bandwidth',        icon: '📶' },
        { id: 'accessibility', label: 'Accessibility',    icon: '♿' },
        { id: 'labs',          label: 'Labs',             icon: '🧪' },
        { id: 'reset',         label: 'Reset',            icon: '🔄' },
      ];

      const sidebar = createEl('div', {
        style: 'width:200px;flex-shrink:0;border-right:1px solid var(--border-subtle);padding:20px 0;display:flex;flex-direction:column;gap:2px;overflow-y:auto;background:var(--bg-elevated);'
      });
      sidebar.appendChild(createEl('div', {
        textContent: 'Settings',
        style: 'font-size:13px;font-weight:700;color:var(--text-primary);padding:0 16px 14px;border-bottom:1px solid var(--border-subtle);margin-bottom:6px;'
      }));

      for (const { id, label, icon } of NAV) {
        const btn = createEl('button', {
          style: 'display:flex;align-items:center;gap:9px;width:100%;padding:8px 16px;border:none;background:' +
                 (id === activeCategory ? 'rgba(88,166,255,0.12)' : 'transparent') +
                 ';color:' + (id === activeCategory ? 'var(--accent)' : 'var(--text-secondary)') +
                 ';font-size:12px;font-weight:' + (id === activeCategory ? '600' : '400') +
                 ';cursor:pointer;text-align:left;border-radius:0;transition:background 0.15s;border-left:2px solid ' +
                 (id === activeCategory ? 'var(--accent)' : 'transparent') + ';',
          'aria-current': id === activeCategory ? 'page' : 'false'
        });
        btn.appendChild(createEl('span', { textContent: icon, style: 'font-size:14px;width:18px;text-align:center;' }));
        btn.appendChild(createEl('span', { textContent: label }));
        btn.addEventListener('mouseenter', () => { if (id !== activeCategory) btn.style.background = 'var(--bg-hover)'; });
        btn.addEventListener('mouseleave', () => { if (id !== activeCategory) btn.style.background = 'transparent'; });
        btn.addEventListener('click', () => renderSettingsPage(id));
        sidebar.appendChild(btn);
      }

      const panelEl = createEl('div', { style: 'flex:1;overflow-y:auto;padding:28px 32px;' });
      const panelInner = createEl('div', { style: 'max-width:560px;' });

      function panelTitle(title, desc) {
        panelInner.appendChild(createEl('h2', { textContent: title, style: 'font-size:17px;font-weight:700;margin:0 0 4px;color:var(--text-primary);' }));
        if (desc) panelInner.appendChild(createEl('p', { textContent: desc, style: 'color:var(--text-muted);margin:0 0 20px;font-size:12px;' }));
      }

      if (activeCategory === 'general') {
        panelTitle('General', 'Basic browser behaviour and preferences.');
        const hpSel = mkSelect('homepage', 'most_visited', [['most_visited', 'Speed Dial'], ['blank', 'Blank Page'], ['custom', 'Custom URL']]);
        const hpCustomWrap = createEl('div', { style: 'margin-top:6px;display:' + (getBPref('homepage', 'most_visited') === 'custom' ? 'block' : 'none') + ';' });
        const hpInp = createEl('input', {
          type: 'url', id: 'browser-homepage-input', name: 'browser-homepage',
          placeholder: 'https://example.com', value: getBPref('homepageUrl', ''),
          style: 'width:100%;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:6px;padding:6px 10px;color:var(--text-primary);font-size:12px;outline:none;box-sizing:border-box;'
        });
        hpInp.addEventListener('change', () => setBPref('homepageUrl', hpInp.value));
        hpCustomWrap.appendChild(hpInp);
        hpSel.addEventListener('change', () => { hpCustomWrap.style.display = hpSel.value === 'custom' ? 'block' : 'none'; });
        const hpWrap = createEl('div', { style: 'display:flex;flex-direction:column;gap:4px;max-width:200px;' });
        hpWrap.append(hpSel, hpCustomWrap);
        panelInner.appendChild(mkRow('Homepage', 'Page shown when opening a new tab', hpWrap));
        panelInner.appendChild(mkRow('Autofill', 'Automatically fill in web forms', mkToggle('autofill_enabled', true)));

      } else if (activeCategory === 'search') {
        panelTitle('Search Engine', 'Choose your default search engine.');
        const seList = createEl('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-top:4px;' });
        for (const [key, info] of Object.entries(SEARCH_ENGINES)) {
          const row = createEl('label', {
            style: 'display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;cursor:pointer;border:1px solid ' +
                   (key === eng ? 'var(--accent)' : 'var(--border-subtle)') +
                   ';background:' + (key === eng ? 'rgba(88,166,255,0.08)' : 'var(--bg-elevated)') + ';transition:all 0.15s;'
          });
          const radio = createEl('input');
          radio.type = 'radio'; radio.id = 'search-engine-' + key; radio.name = 'se'; radio.value = key; radio.checked = key === eng;
          radio.style.accentColor = 'var(--accent)';
          const lbl = createEl('span', { textContent: info.label, style: 'flex:1;font-size:13px;' });
          const hint = createEl('span', { textContent: info.url.replace('https://', '').split('/')[0], style: 'font-size:11px;color:var(--text-muted);' });
          row.append(radio, lbl, hint);
          if (key === eng) row.appendChild(createEl('span', { textContent: 'Default', style: 'font-size:10px;padding:2px 7px;border-radius:10px;background:var(--accent);color:#fff;' }));
          radio.addEventListener('change', () => { if (radio.checked) { saveSetting('searchEngine', key); renderSettingsPage('search'); } });
          seList.appendChild(row);
        }
        panelInner.appendChild(seList);

      } else if (activeCategory === 'privacy') {
        panelTitle('Privacy & Security', 'Control cookies, passwords, location and browsing data.');
        panelInner.appendChild(mkRow('Show security warnings', 'Show a warning indicator for non-HTTPS pages in the address bar',
          mkToggle('show_security_warnings', true, () => updateUrlIcon(currentUrl))));

        panelInner.appendChild(mkSubHdr('Cookies'));
        panelInner.appendChild(mkRow('Accept cookies', 'Allow sites to save cookies. Disabling clears existing cookies and blocks new ones via webRequest',
          mkToggle('accept_cookies', true, (v) => {
            if (!v) clearWebviewData({ cookies: true, persistentCookies: true, sessionCookies: true }, 'Cookies blocked', 'Existing cookies cleared. New cookies will be blocked.');
          })));
        panelInner.appendChild(mkRow('Clear cookies', '', mkClearBtn('Clear Cookies', () => clearWebviewData({ cookies: true, persistentCookies: true, sessionCookies: true }, 'Cookies cleared', 'All cookies have been deleted.'))));

        panelInner.appendChild(mkSubHdr('Form Data'));
        panelInner.appendChild(mkRow('Save form data', 'Remember data entered in web forms (managed by the webview session; disable and clear form data to remove)', mkToggle('save_formdata', true)));
        panelInner.appendChild(mkRow('Clear form data', '', mkClearBtn('Clear Form Data', () => clearWebviewData({ localStorage: true, indexedDB: true, webSQL: true }, 'Form data cleared', 'Saved form data has been deleted.'))));

        panelInner.appendChild(mkSubHdr('Location'));
        panelInner.appendChild(mkRow('Enable location', 'Allow sites to request your location', mkToggle('enable_geolocation', true)));
        panelInner.appendChild(mkRow('Clear location access', '', mkClearBtn('Clear Location', () => Notify.show({ title: 'Location access cleared', body: 'All site location permissions have been revoked.', type: 'info', appName: 'Browser' }))));

        panelInner.appendChild(mkSubHdr('Passwords'));
        panelInner.appendChild(mkRow('Remember passwords', 'Offer to save passwords (managed by the webview session; use Clear Passwords to remove saved credentials)', mkToggle('remember_passwords', true)));
        panelInner.appendChild(mkRow('Clear saved passwords', '', mkClearBtn('Clear Passwords', () => Notify.show({ title: 'Passwords cleared', body: 'Saved passwords have been deleted.', type: 'info', appName: 'Browser' }))));

        panelInner.appendChild(mkSubHdr('Browsing Data'));
        const dataRow = createEl('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;padding:12px 0;' });
        dataRow.append(
          mkClearBtn('Clear Cache', () => clearWebviewData({ cache: true, appcache: true }, 'Cache cleared', 'Cached data has been deleted.')),
          mkClearBtn('Clear History', () => {
            try { localStorage.removeItem(HX_KEY); } catch { /* ignore */ }
            _historyCache = null;
            Notify.show({ title: 'History cleared', body: 'Browsing history has been deleted.', type: 'info', appName: 'Browser' });
          }),
          mkClearBtn('Clear Bookmarks', () => {
            try { localStorage.removeItem(BK_KEY); } catch { /* ignore */ }
            _bookmarksCache = null;
            refreshBookmarkSet();
            Notify.show({ title: 'Bookmarks cleared', body: 'All bookmarks have been deleted.', type: 'info', appName: 'Browser' });
          })
        );
        panelInner.appendChild(dataRow);

      } else if (activeCategory === 'content') {
        panelTitle('Content', 'Control how web pages are loaded and displayed.');
        panelInner.appendChild(mkRow('Block pop-up windows', 'Prevent sites from opening new windows', mkToggle('block_popup_windows', true)));
        panelInner.appendChild(mkRow('Open links in background', 'New tabs open without switching to them', mkToggle('open_in_background', false)));
        panelInner.appendChild(mkRow('Allow app tabs', 'Sites can pin themselves as app tabs', mkToggle('allow_apptabs', false)));
        panelInner.appendChild(mkRow('Default zoom', 'Initial page zoom level', mkSelect('default_zoom', 'MEDIUM', [['FAR', 'Far (smallest)'], ['MEDIUM', 'Medium'], ['CLOSE', 'Close (largest)']])));
        panelInner.appendChild(mkRow('Text encoding', 'Default character encoding for web pages', mkSelect('default_text_encoding', 'UTF-8', [['UTF-8', 'UTF-8'], ['ISO-8859-1', 'Latin-1'], ['GBK', 'GBK'], ['Shift_JIS', 'Shift JIS'], ['EUC-JP', 'EUC-JP']])));

      } else if (activeCategory === 'bandwidth') {
        panelTitle('Bandwidth', 'Manage how much data the browser downloads.');
        panelInner.appendChild(mkRow('Load images', 'Download and display images on web pages', mkToggle('load_images', true)));
        panelInner.appendChild(mkRow('Preload pages', 'Download pages in advance for faster browsing', mkSelect('preload_when', 'WIFI_ONLY', [['ALWAYS', 'Always'], ['WIFI_ONLY', 'Wi-Fi only'], ['NEVER', 'Never']])));
        panelInner.appendChild(mkRow('Link prefetch', 'Preload links the page suggests', mkSelect('link_prefetch_when', 'WIFI_ONLY', [['ALWAYS', 'Always'], ['WIFI_ONLY', 'Wi-Fi only'], ['NEVER', 'Never']])));

      } else if (activeCategory === 'accessibility') {
        panelTitle('Accessibility', 'Adjust display and interaction settings.');
        panelInner.appendChild(mkRow('Force zoom', 'Override sites that disable pinch-to-zoom', mkToggle('force_userscalable', false)));
        panelInner.appendChild(mkRow('Inverted colours', 'Display pages with inverted colours', mkToggle('inverted', false)));
        panelInner.appendChild(mkSliderRow('Text zoom', 'text_zoom', 10, 1, 30, '%'));
        panelInner.appendChild(mkSliderRow('Double-tap zoom', 'double_tap_zoom', 5, 1, 10, 'x'));
        panelInner.appendChild(mkSliderRow('Minimum font size', 'min_font_size', 0, 0, 20, 'px'));

      } else if (activeCategory === 'labs') {
        panelTitle('Labs', 'Experimental features — may be unstable.');
        panelInner.appendChild(mkRow('Quick controls', 'Swipe-based navigation controls', mkToggle('enable_quick_controls', false)));
        panelInner.appendChild(mkRow('Fullscreen mode', 'Hide browser chrome when scrolling down', mkToggle('fullscreen', false)));

      } else if (activeCategory === 'reset') {
        panelTitle('Reset', 'Restore all settings to their factory defaults.');
        const resetBtn = createEl('button', {
          textContent: 'Reset all settings to defaults',
          style: 'margin-top:8px;padding:9px 18px;border-radius:8px;border:1px solid var(--text-danger);background:transparent;color:var(--text-danger);font-size:13px;cursor:pointer;transition:background 0.15s;'
        });
        resetBtn.addEventListener('mouseenter', () => resetBtn.style.background = 'rgba(248,81,73,0.1)');
        resetBtn.addEventListener('mouseleave', () => resetBtn.style.background = 'transparent');
        resetBtn.addEventListener('click', () => {
          showModal(
            'Reset Browser Settings',
            'This will restore all browser settings to their factory defaults. Your bookmarks and history will not be affected.',
            [{ label: 'Reset', danger: true, value: true }, { label: 'Cancel', value: false }]
          ).then(confirmed => {
            if (!confirmed) return;
            try { localStorage.removeItem(ST_KEY); } catch { /* ignore */ }
            _settingsCache = null;
            renderSettingsPage('general');
            Notify.show({ title: 'Settings reset', body: 'All browser settings restored to defaults.', type: 'success', appName: 'Browser' });
          });
        });
        panelInner.appendChild(resetBtn);
      }

      panelEl.appendChild(panelInner);
      page.append(sidebar, panelEl);
      viewport.appendChild(page);
    }

    // Local-address guard — blocks navigation to RFC-1918 / loopback /
    // link-local hosts to prevent SSRF-style attacks from guest content.
    // Memoised: hostname → boolean so repeated checks are O(1).
    const _localAddrCache = new Map();
    function isLocalAddress(rawUrl) {
      let hostname;
      try {
        const normalized = /^https?:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl;
        hostname = new URL(normalized).hostname.toLowerCase().replace(/\.$/, '');
      } catch { return false; }
      const cached = _localAddrCache.get(hostname);
      if (cached !== undefined) return cached;

      let result = false;
      if (hostname === 'localhost') result = true;
      else if (hostname === '[::1]' || hostname === '::1') result = true;
      else {
        const h = hostname.replace(/^\[|\]$/g, '');
        // Octal encoding: 0177.0.0.1 → 127.0.0.1
        if (/^0[0-7]{3}\./.test(h)) result = true;
        // Hexadecimal encoding: 0x7f000001 → 127.0.0.1
        else if (/^0x[0-9a-f]+$/i.test(h)) {
          const num = parseInt(h, 16);
          if ((num >= 2130706432 && num <= 2130706447) ||  // 127.0.0.0/24
              (num >= 167772160  && num <= 167772191)  ||  // 10.0.0.0/24
              (num >= 2886729728 && num <= 2886732799) ||  // 172.16.0.0/12
              (num >= 3232235520 && num <= 3232235775))    // 192.168.0.0/16
            result = true;
        }
        // Dword decimal encoding: 2130706433 → 127.0.0.1
        else if (/^\d+$/.test(h)) {
          const num = parseInt(h, 10);
          if ((num >= 2130706432 && num <= 2147483647) ||  // 127.x.x.x
              (num >= 167772160  && num <= 184549375)  ||  // 10.0.0.0/8
              (num >= 2886729728 && num <= 2887778303) ||  // 172.16.0.0/12
              (num >= 3232235520 && num <= 3232301055))    // 192.168.0.0/16
            result = true;
        }
        // IPv4 loopback / link-local / RFC-1918
        else if (/^127\./.test(h) ||
                 /^169\.254\./.test(h) ||
                 /^10\./.test(h) ||
                 /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
                 /^192\.168\./.test(h)) {
          result = true;
        }
      }
      _localAddrCache.set(hostname, result);
      return result;
    }

    // Path-traversal guard — validates that filePath resolves inside basePath.
    // Returns the resolved path on success, null on traversal attempt.
    function validateFilePath(basePath, filePath) {
      try {
        const nPath = require('path');
        const resolved = nPath.resolve(basePath, filePath);
        const relative = nPath.relative(basePath, resolved);
        if (relative.startsWith('..') || relative.startsWith('/..') || relative.startsWith('\\..')) {
          console.error('[NB Browser] SECURITY: Path traversal attempt blocked:', filePath);
          return null;
        }
        return resolved;
      } catch (err) {
        console.error('[NB Browser] Path validation error:', err);
        return null;
      }
    }

    // Navigate the active tab to a URL. Handles all URL schemes the browser
    // supports: browser://, vault:, http/https, plus search-query fallback
    // for inputs that aren't URLs.
    async function ensureExternalNetworkPermission() {
      if (AppPermissionManager?.isGranted('net:external', 'com.nbosp.browser')) return true;
      let granted = false;
      try {
        granted = typeof AppPermissionManager?.requestPermission === 'function'
          && await AppPermissionManager.requestPermission('net:external', 'com.nbosp.browser', {
            appName: 'Browser',
            reason: 'Browser needs permission to connect to external websites.'
          });
      } catch (error) {
        console.error('[NB Browser] External network permission request failed:', error);
        Notify.show({
          title: 'Permission request failed',
          body: error?.message || 'Browser could not request external network access.',
          type: 'error', appName: 'Browser'
        });
        return false;
      }
      if (!granted) {
        Notify.show({
          title: 'Permission denied',
          body: 'External network access is required to load websites. You can grant it in Settings → Apps.',
          type: 'error', appName: 'Browser'
        });
      }
      return !!granted;
    }

    async function navigate(rawUrl) {
      if (!rawUrl) return;
      let url = rawUrl.trim();
      // Canonicalize: strip ALL control chars before scheme checks.
      // Chromium strips \x09, \x0a, \x0d internally; mirror that here so
      // a "java\nscript:" URL can't sneak past the scheme blocklist.
      const _canonicalUrl = url.toLowerCase()
        .replace(/[\s\u0000-\u001f\u007f-\u009f]/g, '')
        .trim();
      if (/^(javascript|data|vbscript|about):/i.test(_canonicalUrl)) return;

      if (isLocalAddress(url)) {
        Notify.show({
          title: 'Browser',
          body: 'Navigation to local or private network addresses is not allowed.',
          type: 'error', appName: 'Browser'
        });
        return;
      }

      // browser://settings — internal page, no network fetch.
      if (url === 'browser://settings') {
        urlBar.value = 'browser://settings';
        currentUrl = 'browser://settings';
        const activeT = activeTab();
        if (activeT) { activeT.url = url; activeT.title = 'Settings'; }
        renderTabs();
        renderSettingsPage();
        return;
      }

      const settingsPage = viewport.querySelector('.browser-settings-page');
      if (settingsPage) settingsPage.remove();

      // vault:// URL handling — open a file from the OS virtual filesystem.
      if (url.startsWith('vault:')) {
        if (!AppPermissionManager?.isGranted('vfs:write', 'com.nbosp.browser')) {
          Notify.show({
            title: 'Permission denied', body: 'Browser needs fs:write to access vault files.',
            type: 'error', appName: 'Browser'
          });
          return;
        }
        const targetTabId = activeTabId;
        const vaultRel = url.replace(/^vault:\/\/+/, '').replace(/^\//, '');
        let targetNode = null;
        for (const [, node] of FS.files) {
          if (node.type !== 'file') continue;
          const parts = [node.name];
          let cur = node;
          while (cur.parentId) {
            const parent = FS.files.get(cur.parentId);
            if (!parent) break;
            parts.unshift(parent.name);
            cur = parent;
          }
          const nodePath = parts.join('/');
          if (nodePath === vaultRel || node.name === vaultRel) { targetNode = node; break; }
        }
        if (targetNode && targetNode.content == null) await FS.getFile(targetNode.id);
        if (targetNode && targetNode.content != null) {
          urlBar.value = stripHttps(url); currentUrl = url; updateUrlIcon(url);
          const activeT = activeTab();
          if (activeT) { activeT.url = url; activeT.title = targetNode.name; }
          renderTabs();
          const sd = viewport.querySelector('.speed-dial');
          if (sd) sd.remove();
          const wv = getOrCreateWebview(targetTabId);
          if (!wv.parentNode) viewport.appendChild(wv);
          showWebviewForTab(targetTabId);
          try {
            const nPath = require('path');
            const nFs = require('fs');
            const nOs = require('os');
            const nUrl = require('url');
            const dirKey = targetNode.parentId || 'root';
            const tmpBase = nPath.join(nOs.tmpdir(), 'nbosp_vault_' + dirKey);
            if (!nFs.existsSync(tmpBase)) nFs.mkdirSync(tmpBase, { recursive: true });
            // Write sibling files alongside the target so relative resource
            // references inside the HTML resolve correctly.
            if (targetNode.parentId) {
              for (const [, sib] of FS.files) {
                if (sib.type !== 'file' || sib.parentId !== targetNode.parentId || sib.content == null) continue;
                const validPath = validateFilePath(tmpBase, sib.name);
                if (!validPath) {
                  console.warn('[NB Browser] Skipping suspicious sibling file:', sib.name);
                  continue;
                }
                const sibContent = sib.content instanceof Uint8Array ? Buffer.from(sib.content) : sib.content;
                try { nFs.writeFileSync(validPath, sibContent); }
                catch (err) { console.error('[NB Browser] Failed to write sibling file ' + sib.name + ':', err); }
              }
            }
            const validTmpFile = validateFilePath(tmpBase, targetNode.name);
            if (!validTmpFile) throw new Error('Invalid target file path');
            const contentToWrite = targetNode.content instanceof Uint8Array
              ? Buffer.from(targetNode.content) : targetNode.content;
            nFs.writeFileSync(validTmpFile, contentToWrite);
            if (activeTabId === targetTabId) {
              wv.src = nUrl.pathToFileURL(validTmpFile).href;
            }
          } catch (err) {
            console.error('[NB Browser] Failed to load vault file via file:// URL:', err);
            // Fallback: use a blob URL instead of file:// to avoid sandbox issues.
            const contentStr = targetNode.content instanceof Uint8Array
              ? new TextDecoder().decode(targetNode.content)
              : String(targetNode.content);
            const blob = new Blob([contentStr], { type: 'text/html' });
            const _blobUrl = URL.createObjectURL(blob);
            if (activeTabId === targetTabId) wv.src = _blobUrl;
            const tab = tabs.find(t => t.id === targetTabId);
            if (tab) {
              if (tab.activeBlobUrl) URL.revokeObjectURL(tab.activeBlobUrl);
              tab.activeBlobUrl = _blobUrl;
            }
          }
          return;
        }
        urlBar.value = stripHttps(url);
        Notify.show({
          title: 'Browser', body: 'File not found in vault: ' + vaultRel,
          type: 'error', appName: 'Browser'
        });
        return;
      }

      // Not a URL and not a known scheme — treat as a search query unless
      // it looks like a domain (has a dot, no spaces).
      if (!url.match(/^https?:\/\//i) && !url.startsWith('blob:') && !url.startsWith('file://') && !url.startsWith('data:')) {
        url = (url.includes('.') && !url.includes(' ')) ? 'https://' + url : getSearchUrl(url);
      }

      // Real network fetch about to happen (http/https to an actual site,
      // not blob:/file:/data: which are local content already produced by
      // this app — see the branches above). Gate on net:external the same
      // way vault:// above gates on vfs:write: check first, notify + bail
      // if missing, rather than letting the webview/iframe silently load
      // the URL regardless of what the user actually granted.
      if (/^https?:\/\//i.test(url) && !(await ensureExternalNetworkPermission())) {
        urlBar.value = stripHttps(url);
        return;
      }

      urlBar.value = stripHttps(url); currentUrl = url; updateUrlIcon(url);
      const activeT = activeTab();
      if (activeT) {
        activeT.url = url;
        try { activeT.title = new URL(url).hostname; } catch { /* ignore */ }
      }
      renderTabs();
      const sd = viewport.querySelector('.speed-dial');
      if (sd) sd.remove();
      const oldNotice = viewport.querySelector(`.browser-iframe-blocked[data-tab="${activeTabId}"]`);
      if (oldNotice) oldNotice.remove();
      const mode = getTabMode(activeTabId);
      if (mode === 'iframe') {
        const ifr = getOrCreateIframe(activeTabId);
        if (!ifr.parentNode) viewport.appendChild(ifr);
        showViewForTab(activeTabId);
        // Server-side embed check BEFORE setting src. If the site blocks
        // framing (XFO / CSP frame-ancestors), keep the iframe hidden and
        // show our custom notice instead of letting Chromium render
        // "refused to connect".
        ifr.style.visibility = 'hidden';
        ifr.style.pointerEvents = 'none';
        // Abort any previous in-flight navigation by resetting src.
        ifr.setAttribute('src', 'about:blank');
        checkFrameEmbeddable(activeTabId, url).then(result => {
          // Stale? Another navigation / mode switch superseded this tab.
          if (result === null) return;
          if (getTabMode(activeTabId) !== 'iframe') return;
          const curTab = activeTab();
          if (curTab?.url !== url) return; // user navigated elsewhere
          if (result === false) {
            // Keep the iframe hidden (it's on about:blank) and show our notice.
            ifr.style.visibility = 'hidden';
            ifr.style.pointerEvents = 'none';
            showIframeBlockedNotice(activeTabId, url);
            return;
          }
          // Embeddable: clear any stale notice and load it.
          const stale = viewport.querySelector(`.browser-iframe-blocked[data-tab="${activeTabId}"]`);
          if (stale) stale.remove();
          ifr.style.visibility = 'visible';
          ifr.style.pointerEvents = 'auto';
          ifr.src = url;
        });
      } else {
        const wv = getOrCreateWebview(activeTabId);
        if (!wv.parentNode) viewport.appendChild(wv);
        showViewForTab(activeTabId);
        wv.src = url;
      }
    }

    const stripHttps = (url) => url ? url.replace(/^https:\/\//, '') : '';

    // Omnibox dropdown — appears below the URL bar with bookmark/history
    // matches as the user types.
    const omniDrop = createEl('div', { className: 'omnibox-dropdown' });
    omniDrop.setAttribute('role', 'listbox');
    container.appendChild(omniDrop);

    let omniItems = [];
    let omniIdx = -1;
    let omniTimer = null;
    let omniGen = 0; // bumped per query + on close → stale renders bail out

    function omniReposition() {
      const r = urlBar.getBoundingClientRect();
      const cr = container.getBoundingClientRect();
      omniDrop.style.top   = (r.bottom - cr.top + 6) + 'px';
      omniDrop.style.left  = (r.left   - cr.left)    + 'px';
      omniDrop.style.width = r.width + 'px';
    }
    function omniClose() {
      // Invalidate any in-flight/queued work so a late async render can't
      // reopen the dropdown after Enter / blur / Esc.
      omniGen++;
      clearTimeout(omniTimer);
      omniDrop.style.display = 'none';
      omniDrop.replaceChildren();
      omniItems = [];
      omniIdx = -1;
    }
    function omniHighlight(idx) {
      const rows = omniDrop.querySelectorAll('.omni-row');
      rows.forEach((r, i) => r.classList.toggle('active', i === idx));
      omniIdx = idx;
    }
    function omniRender(items) {
      omniDrop.replaceChildren();
      omniItems = items;
      omniIdx = -1;
      if (!items.length) { omniDrop.style.display = 'none'; return; }
      omniReposition();
      const frag = document.createDocumentFragment();
      items.forEach((item, i) => {
        const row = createEl('div', { className: 'omni-row', role: 'option' });
        const ic  = createEl('span', { className: 'omni-icon' });
        ic.innerHTML = item.type === 'history'  ? svgIcon('clock',    13)
                     : item.type === 'bookmark' ? svgIcon('bookmark', 13)
                     :                             svgIcon('search',   13);
        const tx = createEl('span', { className: 'omni-text' });
        tx.textContent = item.label;
        if (item.sub) {
          const sb = createEl('span', { className: 'omni-sub' });
          sb.textContent = item.sub;
          row.append(ic, tx, sb);
        } else {
          row.append(ic, tx);
        }
        // mousedown (not click) so the URL bar doesn't lose focus before
        // we can read which suggestion was picked.
        row.addEventListener('mousedown', e => {
          e.preventDefault();
          omniClose();
          navigate(item.url || item.label);
        });
        row.addEventListener('mousemove', () => omniHighlight(i));
        frag.appendChild(row);
      });
      omniDrop.appendChild(frag);
      omniDrop.style.display = 'block';
    }

    async function omniQuery(raw) {
      const q = raw.trim();
      if (!q) { omniClose(); return; }

      // Capture this query's generation; any newer query (or omniClose)
      // bumps omniGen, so a stale fetch result will bail before rendering.
      const gen = (++omniGen);

      // Local sources — instant. Filters run on the cached arrays so no
      // localStorage reads happen on every keystroke.
      const lq = q.toLowerCase();
      const bkItems = loadBookmarks()
        .filter(b => b.url.toLowerCase().includes(lq) || (b.title || '').toLowerCase().includes(lq))
        .slice(0, 3)
        .map(b => ({ type: 'bookmark', label: b.title || b.url, sub: b.url, url: b.url }));
      const hxItems = loadHistory()
        .filter(h => h.url.toLowerCase().includes(lq) || (h.title || '').toLowerCase().includes(lq))
        .slice(0, 4)
        .map(h => ({ type: 'history', label: h.title || h.url, sub: h.url, url: h.url }));

      if (gen !== omniGen) return; // a newer query / close superseded us
      omniRender([...bkItems, ...hxItems]);
    }

    // URL bar events
    urlBar.addEventListener('keydown', e => {
      if (omniDrop.style.display === 'block') {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          omniHighlight(Math.min(omniIdx + 1, omniItems.length - 1));
          if (omniIdx >= 0) urlBar.value = omniItems[omniIdx].url || omniItems[omniIdx].label;
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          omniHighlight(Math.max(omniIdx - 1, 0));
          if (omniIdx >= 0) urlBar.value = omniItems[omniIdx].url || omniItems[omniIdx].label;
          return;
        }
        if (e.key === 'Escape') { omniClose(); return; }
      }
      if (e.key === 'Enter') {
        const val = omniIdx >= 0 ? (omniItems[omniIdx].url || omniItems[omniIdx].label) : urlBar.value;
        omniClose();
        navigate(val);
      }
    });

    urlBar.addEventListener('input', () => {
      clearTimeout(omniTimer);
      omniTimer = setTimeout(() => omniQuery(urlBar.value), OMNI_DEBOUNCE_MS);
    });

    urlBar.addEventListener('focus', () => { urlBar.value = currentUrl || ''; });
    urlBar.addEventListener('blur', () => {
      setTimeout(omniClose, OMNI_BLUR_CLOSE_MS);
      urlBar.value = stripHttps(currentUrl || urlBar.value);
    });

    // Clean up omnibox timer on app teardown.
    state.cleanups.push(() => clearTimeout(omniTimer));

    // Global keyboard shortcuts
    const _onBrowserKeydown = e => {
      if (e.key === 'F12') {
        e.preventDefault();
        try { nw.Window.get().showDevTools(); } catch { /* ignore */ }
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'J') {
        e.preventDefault();
        const wv = tabWebviews.get(activeTabId);
        if (wv) try { wv.showDevTools(true); } catch { /* ignore */ }
      }
    };
    document.addEventListener('keydown', _onBrowserKeydown);
    state.cleanups.push(() => document.removeEventListener('keydown', _onBrowserKeydown));

    // Navigation button handlers
    backBtn.addEventListener('click', () => {
      if (getTabMode(activeTabId) === 'iframe') {
        const ifr = tabIframes.get(activeTabId);
        try { ifr?.contentWindow?.history.back(); } catch { /* ignore */ }
      } else {
        const wv = tabWebviews.get(activeTabId);
        try { wv?.back(); } catch { /* ignore */ }
      }
    });
    fwdBtn.addEventListener('click', () => {
      if (getTabMode(activeTabId) === 'iframe') {
        const ifr = tabIframes.get(activeTabId);
        try { ifr?.contentWindow?.history.forward(); } catch { /* ignore */ }
      } else {
        const wv = tabWebviews.get(activeTabId);
        try { wv?.forward(); } catch { /* ignore */ }
      }
    });
    refreshBtn.addEventListener('click', () => {
      const _mode = getTabMode(activeTabId);
      if (_mode === 'iframe') {
        const ifr = tabIframes.get(activeTabId);
        if (ifr) {
          try { ifr.contentWindow.location.reload(); }
          catch { const _s = ifr.src; ifr.src = ''; ifr.src = _s; }
        }
      } else {
        const wv = tabWebviews.get(activeTabId);
        if (wv) try { wv.reload(); } catch { /* ignore */ }
        else if (currentUrl) navigate(currentUrl);
      }
    });

    // Open HTML file from vault — triggered when the browser is launched
    // with options.fileId (e.g. double-clicking an HTML file in Files app).
    if (options?.fileId) {
      if (!AppPermissionManager?.isGranted('vfs:write', 'com.nbosp.browser')) {
        Notify.show({
          title: 'Permission denied', body: 'Browser needs fs:write to open vault files.',
          type: 'error', appName: 'Browser'
        });
        return;
      }
      const fileNode = FS.files.get(options.fileId);
      if (fileNode != null && fileNode.content == null) await FS.getFile(options.fileId);
      if (fileNode != null && fileNode.content != null) {
        function getVaultPath(node) {
          const parts = [node.name];
          let cur = node;
          while (cur.parentId) {
            const parent = FS.files.get(cur.parentId);
            if (!parent) break;
            parts.unshift(parent.name);
            cur = parent;
          }
          return 'vault:/' + parts.join('/');
        }
        const vaultPath = getVaultPath(fileNode);
        tabs[0].title = fileNode.name;
        renderTabs();
        const wv = getOrCreateWebview(activeTabId);
        if (!wv.parentNode) viewport.appendChild(wv);
        showWebviewForTab(activeTabId);
        urlBar.value = vaultPath;
        updateUrlIcon(vaultPath);

        const htmlContent = fileNode.content instanceof Uint8Array
          ? new TextDecoder().decode(fileNode.content)
          : String(fileNode.content);

        let loaded = false;
        try {
          const nPath = require('path');
          const nFs = require('fs');
          const nOs = require('os');
          const nUrl = require('url');
          const dirKey = fileNode.parentId || 'root';
          const tmpBase = nPath.join(nOs.tmpdir(), 'nbosp_vault_' + dirKey);
          if (!nFs.existsSync(tmpBase)) nFs.mkdirSync(tmpBase, { recursive: true });
          // Write sibling files alongside the target so relative resource
          // references inside the HTML resolve correctly.
          if (fileNode.parentId) {
            for (const [, sib] of FS.files) {
              if (sib.type !== 'file' || sib.parentId !== fileNode.parentId || sib.content == null) continue;
              const validPath = validateFilePath(tmpBase, sib.name);
              if (!validPath) {
                console.warn('[NB Browser] Skipping suspicious sibling file:', sib.name);
                continue;
              }
              const sibContent = sib.content instanceof Uint8Array ? Buffer.from(sib.content) : sib.content;
              try { nFs.writeFileSync(validPath, sibContent); }
              catch (err) { console.error('[NB Browser] Failed to write sibling file ' + sib.name + ':', err); }
            }
          }
          const validTmpFile = validateFilePath(tmpBase, fileNode.name);
          if (!validTmpFile) throw new Error('Invalid file path for vault extraction');
          nFs.writeFileSync(validTmpFile, htmlContent, 'utf8');
          const fileUrl = nUrl.pathToFileURL(validTmpFile).href;
          wv.src = fileUrl;
          currentUrl = fileUrl;
          loaded = true;
        } catch (err) {
          console.error('[NB Browser] File system error during vault loading:', err);
        }
        if (!loaded) {
          // Fallback: blob URL when the file:// approach fails (e.g. sandbox
          // restrictions). Uses the already-decoded htmlContent string.
          const blob = new Blob([htmlContent], { type: 'text/html' });
          const blobUrl = URL.createObjectURL(blob);
          wv.src = blobUrl;
          const tab = tabs.find(t => t.id === activeTabId);
          if (tab) {
            if (tab.activeBlobUrl) URL.revokeObjectURL(tab.activeBlobUrl);
            tab.activeBlobUrl = blobUrl;
          }
          currentUrl = blobUrl;
        }
        return;
      }
    }

    // Open URL passed from OS.openUrl() — launched with options.url.
    if (options?.url) {
      renderTabs();
      navigate(options.url);
      return;
    }

    // Initial render
    renderTabs();
    (() => {
      const _hp = getSetting('homepage', 'most_visited');
      if (_hp === 'custom') {
        const _hpUrl = getSetting('homepageUrl', '');
        if (_hpUrl) navigate(_hpUrl);
        else renderSpeedDial();
      } else if (_hp === 'blank') {
        // leave viewport empty — blank page
      } else {
        renderSpeedDial();
      }
    })();
  }
});
