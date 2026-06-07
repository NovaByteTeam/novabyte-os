// Get or generate unique salt for PIN hashing
function getPinSalt() {
        let salt = OS.settings.get('pinSalt');
        if (!salt) {
          // Generate random salt
          const array = new Uint8Array(16);
          crypto.getRandomValues(array);
          salt = Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
          OS.settings.set('pinSalt', salt);
        }
        return salt;
      }

      const OS = {
        version: '3.0.2',
        securityPatch: '2026-06-03',  // NovaByte security patch date — globally readable
        username: 'user',
        workers: {},
        windows: new Map(),
        windowZCounter: 100,
        focusedWindowId: null,
        apps: {},
        clipboard: null,
        notifications: [],
        notifUnread: 0,
        dnd: false,
        volume: 80,
        idleTimer: null,
        idleTimeout: 600000,
        isLocked: false,
        lockPin: null,
        wrongPinCount: 0,
        lockoutUntil: 0,

        // Virtual desktops
        workspaces: [{ id: 1, name: 'Workspace 1', windows: [] }],
        currentWorkspace: 1,
        maxWorkspaces: 6,

        // Clipboard manager
        clipboardHistory: [],
        maxClipboardItems: 30,

        events: {
          _handlers: {},
          on(event, fn) {
            if (!this._handlers[event]) this._handlers[event] = [];
            this._handlers[event].push(fn);
          },
          off(event, fn) {
            if (!this._handlers[event]) return;
            this._handlers[event] = this._handlers[event].filter(h => h !== fn);
          },
          emit(event, data) {
            if (this._handlers[event]) {
              for (const fn of this._handlers[event]) {
                try { fn(data); } catch (e) { /* silent */ }
              }
            }
          }
        },

        settings: {
          _cache: {},
          get(key) { return key in this._cache ? this._cache[key] : this.defaults[key]; },
          set(key, value) {
            this._cache[key] = value;
            OS.workers.fs.call('putSetting', key, value).catch(() => { });
            OS.events.emit('settings:changed', { key, value });
          },
          async load() {
            try {
              const all = await OS.workers.fs.call('getAllSettings');
              this._cache = all || {};
            } catch (e) { this._cache = {}; }
          },
          defaults: {
            theme: 'nova-dark',
            clockFormat: '12h',
            dateFormat: 'MM/DD/YYYY',
            fontSize: '14',
            accentColor: '#58a6ff',
            taskbarStyle: 'windows',
            wallpaper: 'stock-blue',
            windowRadius: '12',
            animSpeed: '1',
            iconSize: '72',
            autoLock: '10',
            searchEngine: 'brave',
            proxyUrl: '',
            username: 'user',
            pinnedApps: ['shell', 'vault', 'browser'],
            proxyEmailImages: true, // Route email images through local server (privacy)
            blockTrackers: true,   // Block known tracker domains via Disconnect.me list
          },
          applySafeModeDefaults() {
            // Safe Mode should behave like a clean default session without persisting changes.
            // Leave the original stored settings untouched, but make all reads resolve to defaults.
            this._cache = {};
          }
        },

        logger: {
          debug() { },
          info() { },
          warn() { },
          error() { }
        }
      };
      window.OS = OS; // Expose OS globally for external scripts




/* Exposed to Global Scope for Flat-Module Architecture */
window.getPinSalt = getPinSalt;
