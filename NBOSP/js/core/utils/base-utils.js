// UTILITIES

function generateId() {
        try { return crypto.randomUUID(); } catch (e) {
          return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
          });
        }
      }

      function sanitiseHTML(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
      }

      function escapeText(str) {
        if (typeof str !== 'string') return '';
        const _ed = document.createElement('div');
        _ed.textContent = str;
        return _ed.innerHTML;
      }

      function safeEvaluateArithmetic(input) {
        const s = String(input).replace(/\s+/g, '');
        let i = 0;

        function consume(ch) {
          if (s[i] === ch) {
            i += 1;
            return true;
          }
          return false;
        }

        function parseNumber() {
          const start = i;
          let sawDigit = false;
          let sawDot = false;

          while (i < s.length) {
            const ch = s[i];
            if (ch >= '0' && ch <= '9') {
              sawDigit = true;
              i += 1;
            } else if (ch === '.' && !sawDot) {
              sawDot = true;
              i += 1;
            } else {
              break;
            }
          }

          if (!sawDigit) throw new Error('Expected number');
          return Number(s.slice(start, i));
        }

        function parsePrimary() {
          if (consume('+')) return parsePrimary();
          if (consume('-')) return -parsePrimary();
          if (consume('(')) {
            const value = parseAddSub();
            if (!consume(')')) throw new Error('Expected )');
            return value;
          }
          return parseNumber();
        }

        function parseMulDiv() {
          let left = parsePrimary();
          while (i < s.length) {
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
          while (i < s.length) {
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
        if (i !== s.length) throw new Error('Unexpected token');
        if (!Number.isFinite(value)) throw new Error('Invalid result');
        return value;
      }

      // Detect browser function
      function detectBrowser() {
        const ua = navigator.userAgent;

        // Check for Edge (must check before Chrome)
        if (ua.includes('Edg/')) {
          return 'Edge';
        }

        // Check for Brave (must check before Chrome)
        if (ua.includes('Brave/')) {
          return 'Brave';
        }

        // Check for Chrome
        if (ua.includes('Chrome/') && !ua.includes('Chromium/')) {
          return 'Chrome';
        }

        // Check for Firefox
        if (ua.includes('Firefox/')) {
          return 'Firefox';
        }

        // Check for Safari (must check after Chrome)
        if (ua.includes('Safari/') && !ua.includes('Chrome/')) {
          return 'Safari';
        }

        // Check for Opera
        if (ua.includes('OPR/') || ua.includes('Opera/')) {
          return 'Opera';
        }

        // Check for Chromium
        if (ua.includes('Chromium/')) {
          return 'Chromium';
        }

        return 'Unknown';
      }

      function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
      }

      function formatTime(date) {
        const h = date.getHours();
        const m = date.getMinutes();
        const use24 = OS.settings.get('clockFormat') === '24h';
        if (use24) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        const h12 = h % 12 || 12;
        const ampm = h < 12 ? 'AM' : 'PM';
        return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
      }

      function formatDate(date) {
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]}`;
      }

      function debounce(fn, ms) {
        let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
      }

      function throttleRAF(fn) {
        let ticking = false;
        return (...args) => {
          if (!ticking) {
            ticking = true;
            requestAnimationFrame(() => { fn(...args); ticking = false; });
          }
        };
      }

      /** Safe localStorage.setItem — swallows QuotaExceededError silently. */
      function lsSave(key, value) {
        try {
          localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
          if (window.AppDirs?.vfsFolders) AppDirs.syncKey(key, value).catch(() => { });
        } catch (_) { }
      }

      function createEl(tag, attrs, children) {
        const el = document.createElement(tag);
        if (attrs) {
          for (const [k, v] of Object.entries(attrs)) {
            if (k === 'className') el.className = v;
            else if (k === 'textContent') el.textContent = v;
            else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
            else if (k === 'style' && typeof v === 'string') el.style.cssText = v;
            else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
            else if (typeof v === 'boolean') { if (v) el.setAttribute(k, ''); else el.removeAttribute(k); }
            else el.setAttribute(k, v);
          }
        }
        if (children) {
          if (Array.isArray(children)) children.forEach(c => { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
          else if (typeof children === 'string') el.textContent = children;
          else el.appendChild(children);
        }
        return el;
      }

      function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }

      function svgIcon(name, size) {
        size = size || 18;

        if (typeof name === 'string' && name.startsWith('data:')) {
          return `<img src="${name}" width="${size}" height="${size}" style="display:inline-block;vertical-align:middle;object-fit:contain;pointer-events:none;" draggable="false" alt="" onerror="this.style.visibility='hidden';">`;
        }

        const uiIcons = {
          'x': `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`,
          'plus': `<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`,
          'minus': `<line x1="5" y1="12" x2="19" y2="12"/>`,
          'check': `<polyline points="20 6 9 17 4 12"/>`,
          'chevron-left': `<polyline points="15 18 9 12 15 6"/>`,
          'chevron-right': `<polyline points="9 18 15 12 9 6"/>`,
          'chevron-up': `<polyline points="18 15 12 9 6 15"/>`,
          'chevron-down': `<polyline points="6 9 12 15 18 9"/>`,
          'arrow-left': `<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>`,
          'arrow-right': `<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>`,
          'more-horizontal': `<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>`,
          'corner-up-left': `<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>`,
          'corner-up-right': `<polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>`,
          'maximize-2': `<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>`,
          'minimize-2': `<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/>`,
          'align-left': `<line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/>`,
          'align-center': `<line x1="21" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/>`,
          'align-right': `<line x1="21" y1="7" x2="3" y2="7"/><line x1="21" y1="17" x2="3" y2="17"/><line x1="21" y1="12" x2="3" y2="12"/>`,
          'square': `<rect x="3" y="3" width="18" height="18" rx="2"/>`,
          'layout': `<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>`,
           'skip-back': `<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>`,
           'skip-forward': `<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>`,
           'external-link': `<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>`,
        };

        if (uiIcons[name]) {
          return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${uiIcons[name]}</svg>`;
        }

        const iconMap = {
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
          'pause': 'pause-button',
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
          'plus': 'plus-math',
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
          'chevron-left': 'arrow-left',
          'chevron-right': 'arrow-right',
          'chevron-up': 'arrow-up',
          'list': 'document',
           'move': 'arrow-right',
           'shuffle': 'shuffle-96',
           'repeat': 'repeat',
        };
        const special = { 'shuffle': 'shuffle-96', 'repeat': 'repeat-button-96', 'pause': 'pause-96' };
        const i8name = special[name] || iconMap[name] || name;
        const localPath = special[name]
          ? `/assets/icons8-${special[name]}.png`
          : `/assets/icons8-${i8name}-94.png`;
        return `<img src="${localPath}" width="${size}" height="${size}" style="display:inline-block;vertical-align:middle;object-fit:contain;pointer-events:none;" draggable="false" alt="" onerror="this.style.visibility='hidden';">`;
      }




/* Exposed to Global Scope for Flat-Module Architecture */
window.generateId = generateId;
window.sanitiseHTML = sanitiseHTML;
window.escapeText = escapeText;
window.safeEvaluateArithmetic = safeEvaluateArithmetic;
window.svgIcon = svgIcon;
