/* ═══════════════════════════════════════════════════════════════
         UTILITY FUNCTIONS
   ═══════════════════════════════════════════════════════════════ */

      function applyTheme(theme) {
        const themes = {
          'nova-dark': {
            '--bg-base': '#07090f',
            '--bg-elevated': 'rgba(14, 18, 28, 0.80)',
            '--bg-overlay': 'rgba(20, 26, 40, 0.70)',
            '--bg-sunken': '#030508',
            '--text-primary': '#e6edf3',
            '--text-secondary': '#8b949e',
            '--text-muted': '#484f58',
            '--text-link': '#58a6ff',
            '--text-danger': '#f85149',
            '--text-success': '#3fb950',
            '--text-warning': '#d29922',
            '--accent': '#58a6ff',
            '--accent-hover': '#79b8ff',
            '--accent-muted': 'rgba(88, 166, 255, 0.15)',
            '--window-bg': 'rgba(10, 14, 22, 0.50)',
            '--window-border': 'rgba(255, 255, 255, 0.12)',
            '--window-shadow': '0 32px 64px rgba(0,0,0,0.50), 0 8px 24px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.07)',
            '--taskbar-bg': 'rgba(6, 10, 18, 0.65)',
            '--taskbar-border': 'rgba(255, 255, 255, 0.08)',
            '--border-subtle': 'rgba(255, 255, 255, 0.06)',
            '--border-default': 'rgba(255, 255, 255, 0.12)',
            '--border-strong': 'rgba(255, 255, 255, 0.25)',
            '--r-window': '16px',
            '--font-size': '14px',
            '--window-blur': 'blur(28px) saturate(160%)'
          },
          'nova-light': {
            '--bg-base': '#ffffff',
            '--bg-elevated': '#f6f8fa',
            '--bg-overlay': '#ffffff',
            '--bg-sunken': '#eaeef2',
            '--text-primary': '#24292f',
            '--text-secondary': '#57606a',
            '--text-muted': '#8c959f',
            '--text-link': '#0969da',
            '--text-danger': '#cf222e',
            '--text-success': '#1a7f37',
            '--text-warning': '#9a6700',
            '--accent': '#0969da',
            '--accent-hover': '#0550ae',
            '--accent-muted': 'rgba(9, 105, 218, 0.1)',
            '--window-bg': 'rgba(255, 255, 255, 0.72)',
            '--window-border': 'rgba(27, 31, 35, 0.12)',
            '--window-shadow': '0 24px 48px rgba(0,0,0,0.12), 0 6px 20px rgba(0,0,0,0.07), inset 0 1px 0 rgba(255,255,255,0.90)',
            '--taskbar-bg': 'rgba(246, 248, 250, 0.72)',
            '--taskbar-border': 'rgba(27, 31, 35, 0.12)',
            '--border-subtle': 'rgba(27, 31, 35, 0.06)',
            '--border-default': 'rgba(27, 31, 35, 0.12)',
            '--border-strong': 'rgba(27, 31, 35, 0.25)',
            '--r-window': '14px',
            '--font-size': '14px',
            '--window-blur': 'blur(28px) saturate(160%)'
          },
          'nord': {
            '--bg-base': '#2e3440',
            '--bg-elevated': '#3b4252',
            '--bg-overlay': '#434c5e',
            '--bg-sunken': '#242933',
            '--text-primary': '#eceff4',
            '--text-secondary': '#d8dee9',
            '--text-muted': '#4c566a',
            '--text-link': '#88c0d0',
            '--text-danger': '#bf616a',
            '--text-success': '#a3be8c',
            '--text-warning': '#ebcb8b',
            '--accent': '#88c0d0',
            '--accent-hover': '#81a1c1',
            '--accent-muted': 'rgba(136, 192, 208, 0.15)',
            '--window-bg': 'rgba(46, 52, 64, 0.52)',
            '--window-border': 'rgba(236, 239, 244, 0.12)',
            '--window-shadow': '0 24px 48px rgba(0,0,0,0.45), 0 6px 20px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.07)',
            '--taskbar-bg': 'rgba(36, 41, 51, 0.65)',
            '--taskbar-border': 'rgba(236, 239, 244, 0.10)',
            '--border-subtle': 'rgba(236, 239, 244, 0.08)',
            '--border-default': 'rgba(236, 239, 244, 0.15)',
            '--border-strong': 'rgba(236, 239, 244, 0.30)',
            '--r-window': '14px',
            '--font-size': '14px',
            '--window-blur': 'blur(28px) saturate(160%)'
          },
          'dracula': {
            '--bg-base': '#282a36',
            '--bg-elevated': '#44475a',
            '--bg-overlay': '#44475a',
            '--bg-sunken': '#21222c',
            '--text-primary': '#f8f8f2',
            '--text-secondary': '#6272a4',
            '--text-muted': '#484a66',
            '--text-link': '#8be9fd',
            '--text-danger': '#ff5555',
            '--text-success': '#50fa7b',
            '--text-warning': '#f1fa8c',
            '--accent': '#bd93f9',
            '--accent-hover': '#ff79c6',
            '--accent-muted': 'rgba(189, 147, 249, 0.15)',
            '--window-bg': 'rgba(40, 42, 54, 0.52)',
            '--window-border': 'rgba(248, 248, 242, 0.12)',
            '--window-shadow': '0 24px 48px rgba(0,0,0,0.50), 0 6px 20px rgba(0,0,0,0.32), inset 0 1px 0 rgba(189,147,249,0.08)',
            '--taskbar-bg': 'rgba(30, 31, 41, 0.65)',
            '--taskbar-border': 'rgba(248, 248, 242, 0.10)',
            '--border-subtle': 'rgba(248, 248, 242, 0.08)',
            '--border-default': 'rgba(248, 248, 242, 0.15)',
            '--border-strong': 'rgba(248, 248, 242, 0.30)',
            '--r-window': '14px',
            '--font-size': '14px',
            '--window-blur': 'blur(28px) saturate(160%)'
          },
          'catppuccin': {
            '--bg-base': '#1e1e2e',
            '--bg-elevated': '#313244',
            '--bg-overlay': '#45475a',
            '--bg-sunken': '#181825',
            '--text-primary': '#cdd6f4',
            '--text-secondary': '#a6adc8',
            '--text-muted': '#6c7086',
            '--text-link': '#89b4fa',
            '--text-danger': '#f38ba8',
            '--text-success': '#a6e3a1',
            '--text-warning': '#f9e2af',
            '--accent': '#cba6f7',
            '--accent-hover': '#b4befe',
            '--accent-muted': 'rgba(203, 166, 247, 0.15)',
            '--window-bg': 'rgba(30, 30, 46, 0.52)',
            '--window-border': 'rgba(205, 214, 244, 0.13)',
            '--window-shadow': '0 24px 48px rgba(0,0,0,0.48), 0 6px 20px rgba(0,0,0,0.30), inset 0 1px 0 rgba(203,166,247,0.08)',
            '--taskbar-bg': 'rgba(22, 22, 34, 0.65)',
            '--taskbar-border': 'rgba(205, 214, 244, 0.10)',
            '--border-subtle': 'rgba(205, 214, 244, 0.08)',
            '--border-default': 'rgba(205, 214, 244, 0.15)',
            '--border-strong': 'rgba(205, 214, 244, 0.30)',
            '--r-window': '14px',
            '--font-size': '14px',
            '--window-blur': 'blur(28px) saturate(160%)'
          },
          'tokyo-night': {
            '--bg-base': '#1a1b26',
            '--bg-elevated': '#24283b',
            '--bg-overlay': '#414868',
            '--bg-sunken': '#16161e',
            '--text-primary': '#c0caf5',
            '--text-secondary': '#565f89',
            '--text-muted': '#3b4261',
            '--text-link': '#7aa2f7',
            '--text-danger': '#f7768e',
            '--text-success': '#9ece6a',
            '--text-warning': '#e0af68',
            '--accent': '#7aa2f7',
            '--accent-hover': '#bb9af7',
            '--accent-muted': 'rgba(122, 162, 247, 0.15)',
            '--window-bg': 'rgba(22, 24, 38, 0.52)',
            '--window-border': 'rgba(192, 202, 245, 0.13)',
            '--window-shadow': '0 24px 48px rgba(0,0,0,0.50), 0 6px 20px rgba(0,0,0,0.32), inset 0 1px 0 rgba(122,162,247,0.08)',
            '--taskbar-bg': 'rgba(16, 17, 28, 0.65)',
            '--taskbar-border': 'rgba(192, 202, 245, 0.10)',
            '--border-subtle': 'rgba(192, 202, 245, 0.08)',
            '--border-default': 'rgba(192, 202, 245, 0.15)',
            '--border-strong': 'rgba(192, 202, 245, 0.30)',
            '--r-window': '14px',
            '--font-size': '14px',
            '--window-blur': 'blur(28px) saturate(160%)'
          },
          'gruvbox': {
            '--bg-base': '#282828',
            '--bg-elevated': '#3c3836',
            '--bg-overlay': '#504945',
            '--bg-sunken': '#1d2021',
            '--text-primary': '#ebdbb2',
            '--text-secondary': '#d5c4a1',
            '--text-muted': '#665c54',
            '--text-link': '#83a598',
            '--text-danger': '#fb4934',
            '--text-success': '#b8bb26',
            '--text-warning': '#fabd2f',
            '--accent': '#fabd2f',
            '--accent-hover': '#fe8019',
            '--accent-muted': 'rgba(250, 189, 47, 0.15)',
            '--window-bg': 'rgba(40, 40, 40, 0.52)',
            '--window-border': 'rgba(235, 219, 178, 0.13)',
            '--window-shadow': '0 24px 48px rgba(0,0,0,0.48), 0 6px 20px rgba(0,0,0,0.30), inset 0 1px 0 rgba(250,189,47,0.06)',
            '--taskbar-bg': 'rgba(29, 32, 33, 0.65)',
            '--taskbar-border': 'rgba(235, 219, 178, 0.10)',
            '--border-subtle': 'rgba(235, 219, 178, 0.08)',
            '--border-default': 'rgba(235, 219, 178, 0.15)',
            '--border-strong': 'rgba(235, 219, 178, 0.30)',
            '--r-window': '14px',
            '--font-size': '14px',
            '--window-blur': 'blur(28px) saturate(160%)'
          },
          'high-contrast': {
            '--bg-base': '#000000',
            '--bg-elevated': '#1a1a1a',
            '--bg-overlay': '#333333',
            '--bg-sunken': '#000000',
            '--text-primary': '#ffffff',
            '--text-secondary': '#cccccc',
            '--text-muted': '#999999',
            '--text-link': '#ffff00',
            '--text-danger': '#ff0000',
            '--text-success': '#00ff00',
            '--text-warning': '#ffff00',
            '--accent': '#ffff00',
            '--accent-hover': '#ffffff',
            '--accent-muted': 'rgba(255, 255, 0, 0.15)',
            '--window-bg': 'rgba(0, 0, 0, 0.95)',
            '--window-border': '3px solid #ffffff',
            '--window-shadow': '0 8px 32px rgba(255,255,255,0.2), 0 2px 8px rgba(255,255,255,0.1)',
            '--taskbar-bg': 'rgba(0, 0, 0, 0.95)',
            '--taskbar-border': '2px solid #ffffff',
            '--border-subtle': '2px solid #ffffff',
            '--border-default': '3px solid #ffffff',
            '--border-strong': '4px solid #ffffff',
            '--r-window': '0px',
            '--font-size': '16px',
            '--window-blur': 'none'
          }
        };

        const t = themes[theme] || themes['nova-dark'];
        for (const [k, v] of Object.entries(t)) {
          document.documentElement.style.setProperty(k, v);
        }
        window.dispatchEvent(new CustomEvent('theme:changed', { detail: { theme } }));
      }

      /* ═══════════════════════════════════════════════════════════════════
         OPFS (Origin Private File System) Support
         ═══════════════════════════════════════════════════════════════════ */

      const OPFS = {
        root: null,
        available: false,

        async init() {
          try {
            if ('storage' in navigator && 'getDirectory' in navigator.storage) {
              this.root = await navigator.storage.getDirectory();
              this.available = true;
            } else {
              this.available = false;
            }
          } catch (e) {
            this.available = false;
          }
          return this.available;
        },

        async ensureRoot() {
          if (this.root) return this.root;
          await this.init();
          return this.root;
        },

        async storeBlob(key, blob) {
          if (this.available && this.root) {
            try {
              const fileHandle = await this.root.getFileHandle(key, { create: true });
              const writable = await fileHandle.createWritable();
              await writable.write(blob);
              await writable.close();
              return true;
            } catch (e) {
              // Silently fallback to IndexedDB
            }
          }
          return this._storeIndexedDB(key, blob);
        },

        async getBlob(key) {
          if (this.available && this.root) {
            try {
              const fileHandle = await this.root.getFileHandle(key);
              return await fileHandle.getFile();
            } catch (e) {
              // Silently fallback to IndexedDB
            }
          }
          return this._getIndexedDB(key);
        },

        async deleteBlob(key) {
          if (this.available && this.root) {
            try {
              await this.root.removeEntry(key);
              return true;
            } catch (e) {
              // Silently fallback to IndexedDB
            }
          }
          return this._deleteIndexedDB(key);
        },

        async ensureDirectory(path) {
          const root = await this.ensureRoot();
          if (!root) return null;
          const parts = String(path || '').split('/').filter(Boolean);
          let current = root;
          for (const part of parts) {
            current = await current.getDirectoryHandle(part, { create: true });
          }
          return current;
        },

        async writeText(path, text, type = 'text/plain') {
          const parts = String(path || '').split('/').filter(Boolean);
          if (!parts.length) throw new Error('Path is required');
          const fileName = parts.pop();
          const dir = parts.length ? await this.ensureDirectory(parts.join('/')) : await this.ensureRoot();
          if (!dir) return this._storeIndexedDB(path, new Blob([String(text)], { type }));
          const fileHandle = await dir.getFileHandle(fileName, { create: true });
          const writable = await fileHandle.createWritable();
          const blob = text instanceof Blob ? text : new Blob([String(text)], { type });
          await writable.write(blob);
          await writable.close();
          return true;
        },

        async readText(path) {
          const blob = await this.getBlob(path);
          if (!blob) return null;
          try {
            return await blob.text();
          } catch (e) {
            return null;
          }
        },

        async deletePath(path, recursive = true) {
          const parts = String(path || '').split('/').filter(Boolean);
          if (!parts.length) return false;

          if (this.available && this.root) {
            try {
              const name = parts.pop();
              let parent = this.root;
              for (const part of parts) {
                parent = await parent.getDirectoryHandle(part);
              }
              await parent.removeEntry(name, { recursive });
              return true;
            } catch (e) {
              // Fall through to IndexedDB fallback path below
            }
          }

          return this._deleteIndexedDB(path);
        },

        async listEntries() {
          if (this.available && this.root) {
            try {
              const entries = [];
              const walk = async (dir, prefix = '') => {
                const children = [];
                for await (const [name, handle] of dir.entries()) children.push([name, handle]);
                children.sort((a, b) => {
                  if (a[1].kind !== b[1].kind) return a[1].kind === 'directory' ? -1 : 1;
                  return a[0].localeCompare(b[0]);
                });
                for (const [name, handle] of children) {
                  const path = prefix ? `${prefix}/${name}` : name;
                  if (handle.kind === 'directory') {
                    entries.push({ path, name, kind: 'directory', size: 0, type: 'inode/directory', lastModified: 0 });
                    await walk(handle, path);
                  } else {
                    let size = 0;
                    let type = '';
                    let lastModified = 0;
                    try {
                      const file = await handle.getFile();
                      size = file.size || 0;
                      type = file.type || '';
                      lastModified = file.lastModified || 0;
                    } catch (e) { }
                    entries.push({ path, name, kind: 'file', size, type, lastModified });
                  }
                }
              };
              await walk(this.root);
              return entries;
            } catch (e) {
              // fall through to IndexedDB fallback
            }
          }
          return this._listIndexedDB();
        },

        async clear() {
          if (this.available && this.root) {
            try {
              const entries = [];
              for await (const [name, handle] of this.root.entries()) entries.push([name, handle]);
              for (const [name, handle] of entries) {
                try {
                  await this.root.removeEntry(name, { recursive: handle.kind === 'directory' });
                } catch (e) { }
              }
            } catch (e) { }
          }
          return this._clearIndexedDB();
        },

        // IndexedDB fallback
        _db: null,

        async _openDB() {
          if (this._db) return this._db;
          return new Promise((resolve, reject) => {
            const request = indexedDB.open('novabyte_opfs_fallback', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              this._db = request.result;
              resolve(this._db);
            };
            request.onupgradeneeded = (e) => {
              const db = e.target.result;
              if (!db.objectStoreNames.contains('blobs')) {
                db.createObjectStore('blobs');
              }
            };
          });
        },

        async _storeIndexedDB(key, blob) {
          const db = await this._openDB();
          return new Promise((resolve, reject) => {
            const tx = db.transaction('blobs', 'readwrite');
            const store = tx.objectStore('blobs');
            const request = store.put(blob, key);
            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
          });
        },

        async _getIndexedDB(key) {
          const db = await this._openDB();
          return new Promise((resolve, reject) => {
            const tx = db.transaction('blobs', 'readonly');
            const store = tx.objectStore('blobs');
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        },

        async _deleteIndexedDB(key) {
          const db = await this._openDB();
          return new Promise((resolve, reject) => {
            const tx = db.transaction('blobs', 'readwrite');
            const store = tx.objectStore('blobs');
            const request = store.delete(key);
            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
          });
        },

        async _listIndexedDB() {
          try {
            const db = await this._openDB();
            return await new Promise((resolve, reject) => {
              const tx = db.transaction('blobs', 'readonly');
              const store = tx.objectStore('blobs');
              const items = [];
              const req = store.openCursor();
              req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (!cursor) {
                  items.sort((a, b) => a.path.localeCompare(b.path));
                  resolve(items);
                  return;
                }
                const value = cursor.value;
                const blob = value instanceof Blob ? value : new Blob([value]);
                items.push({
                  path: cursor.key,
                  name: String(cursor.key).split('/').pop(),
                  kind: 'file',
                  size: blob.size || 0,
                  type: blob.type || '',
                  lastModified: 0,
                  fallback: true
                });
                cursor.continue();
              };
              req.onerror = () => reject(req.error);
            });
          } catch (e) {
            return [];
          }
        },

        async _clearIndexedDB() {
          try {
            const db = await this._openDB();
            return await new Promise((resolve, reject) => {
              const tx = db.transaction('blobs', 'readwrite');
              const store = tx.objectStore('blobs');
              const req = store.openCursor();
              req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (!cursor) { resolve(true); return; }
                cursor.delete();
                cursor.continue();
              };
              req.onerror = () => reject(req.error);
            });
          } catch (e) {
            return false;
          }
        }
      };

      // ── AppDirs — per-app OPFS data directories (Android /data/data/ style) ──
      const AppDirs = {
        // Maps app ID → com.nbosp.* package name
        PACKAGES: {
          'vault': 'com.nbosp.vault',
          'quill': 'com.nbosp.quill',
          'shell': 'com.nbosp.shell',
          'browser': 'com.nbosp.browser',
          'calendar-app': 'com.nbosp.calendar',
          'nook': 'com.nbosp.settings',
          'calculator': 'com.nbosp.calculator',
          'app-manager': 'com.nbosp.appmanager',
          'nbosp-clock': 'com.nbosp.clock',
          'nbosp-email': 'com.nbosp.email',
          'nbosp-gallery': 'com.nbosp.gallery',
          'nbosp-downloads': 'com.nbosp.downloads',
          'nbosp-contacts': 'com.nbosp.contacts',
          'nbosp-search': 'com.nbosp.search',
          'nbosp-music': 'com.nbosp.music',
        },

        // Resolved directory handles cache — avoids repeated getDirectoryHandle calls
        _handles: {},

        // Bootstrap the full directory tree — safe to call every boot (idempotent)
        async bootstrap() {
          // ── 1. OPFS physical directories ────────────────────────────────
          if (OPFS.available && OPFS.root) {
            const mkd = (parent, name) => parent.getDirectoryHandle(name, { create: true });
            try {
              const system = await mkd(OPFS.root, 'System');
              const marker = await system.getFileHandle('.nbosp_runtime', { create: true });
              const w = await marker.createWritable();
              await w.write(JSON.stringify({ os: 'NovaByte', layer: 'nbosp', booted: Date.now() }));
              await w.close();
              const data = await mkd(OPFS.root, 'data');
              const dataData = await mkd(data, 'data');
              for (const pkg of Object.values(this.PACKAGES)) {
                const appDir = await mkd(dataData, pkg);
                await mkd(appDir, 'files');
                await mkd(appDir, 'cache');
                await mkd(appDir, 'databases');
                await mkd(appDir, 'shared_prefs');
                this._handles[pkg] = appDir;
              }
            } catch (e) {
              console.warn('[AppDirs] OPFS bootstrap failed:', e);
            }
          }

          // ── 2. Virtual FS — mirror tree so it's visible in Files app ────
          const mkVDir = async (parentId, name) => {
            const existing = FS.listDir(parentId).find(f => f.name === name && f.type === 'folder');
            if (existing) return existing;
            return await FS.createFolder(parentId, name);
          };
          const mkVFile = async (parentId, name, content, mime) => {
            const existing = FS.listDir(parentId).find(f => f.name === name && f.type === 'file');
            if (existing) return existing;
            return await FS.createFile(parentId, name, content, mime || 'application/json');
          };
          const updateVFile = async (parentId, name, content, mime) => {
            const existing = FS.listDir(parentId).find(f => f.name === name && f.type === 'file');
            if (existing) { await FS.writeFile(existing.id, content); return existing; }
            return await FS.createFile(parentId, name, content, mime || 'application/json');
          };

          const APP_META = {
            'com.nbosp.vault': { name: 'Files', version: '1.0.0', description: 'File Manager' },
            'com.nbosp.quill': { name: 'TextEdit', version: '1.0.0', description: 'Text Editor' },
            'com.nbosp.shell': { name: 'Terminal', version: '1.0.0', description: 'System Terminal' },
            'com.nbosp.browser': { name: 'Browser', version: '1.0.0', description: 'Web Browser' },
            'com.nbosp.calendar': { name: 'Calendar', version: '1.0.0', description: 'Calendar & Events' },
            'com.nbosp.settings': { name: 'Settings', version: '1.0.0', description: 'System Settings' },
            'com.nbosp.calculator': { name: 'Calculator', version: '1.0.0', description: 'Calculator' },
            'com.nbosp.appmanager': { name: 'App Manager', version: '1.0.0', description: 'Package Manager' },
            'com.nbosp.clock': { name: 'Clock', version: '1.0.0', description: 'Clock & Alarms' },
            'com.nbosp.email': { name: 'Email', version: '1.0.0', description: 'Email Client' },
            'com.nbosp.gallery': { name: 'Gallery', version: '1.0.0', description: 'Image Viewer' },
            'com.nbosp.downloads': { name: 'Downloads', version: '1.0.0', description: 'Download Manager' },
            'com.nbosp.contacts': { name: 'Contacts', version: '1.0.0', description: 'Contacts' },
            'com.nbosp.search': { name: 'Search', version: '1.0.0', description: 'System Search' },
            'com.nbosp.music': { name: 'Music', version: '1.0.0', description: 'Music Player' },
          };

          try {
            const dataNode = await mkVDir(FS.rootId, 'data');
            const dataDataNode = await mkVDir(dataNode.id, 'data');

            // /System/ — OS identity visible in Files
            const systemNode = await mkVDir(FS.rootId, 'System');
            await updateVFile(systemNode.id, 'build.json', JSON.stringify({
              os: 'NovaByte', layer: 'nbosp', version: '3.0.0',
              booted: new Date().toISOString()
            }, null, 2));

            this.vfsFolders = {};

            for (const pkg of Object.values(this.PACKAGES)) {
              const appNode = await mkVDir(dataDataNode.id, pkg);
              const filesNode = await mkVDir(appNode.id, 'files');
              const cacheNode = await mkVDir(appNode.id, 'cache');
              const dbNode = await mkVDir(appNode.id, 'databases');
              const prefsNode = await mkVDir(appNode.id, 'shared_prefs');

              // Cache folder IDs for later use by syncKey and apps
              this.vfsFolders[pkg] = {
                root: appNode.id, files: filesNode.id,
                cache: cacheNode.id, databases: dbNode.id, shared_prefs: prefsNode.id
              };

              const meta = APP_META[pkg] || { name: pkg, version: '1.0.0', description: '' };
              await mkVFile(filesNode.id, 'appinfo.json', JSON.stringify({
                packageId: pkg, name: meta.name, version: meta.version,
                description: meta.description, installedAt: new Date().toISOString(), layer: 'nbosp',
              }, null, 2));
            }

            // ── Migrate existing notes from Documents → com.nbosp.quill/files/ ──
            const quillFilesId = this.vfsFolders['com.nbosp.quill']?.files;
            if (quillFilesId && FS.specialFolders.documents) {
              const docsFiles = FS.listDir(FS.specialFolders.documents);
              for (const f of docsFiles) {
                if (f.type === 'file') {
                  // Move: just update parentId
                  const alreadyMoved = FS.listDir(quillFilesId).find(n => n.name === f.name);
                  if (!alreadyMoved) {
                    f.parentId = quillFilesId;
                    FS.files.set(f.id, f);
                    await OS.workers.fs.call('putFiles', [f]);
                  }
                }
              }
            }

            // ── Sync real localStorage data into virtual FS databases/ ──
            await this._syncAllToVFS(updateVFile);

            // ── Sync real settings into com.nbosp.settings/shared_prefs/prefs.json ──
            const settingsPrefsId = this.vfsFolders['com.nbosp.settings']?.shared_prefs;
            if (settingsPrefsId) {
              await updateVFile(settingsPrefsId, 'prefs.json',
                JSON.stringify(OS.settings._cache, null, 2));
            }

            this.fsFolders = { data: dataNode.id, dataData: dataDataNode.id, system: systemNode.id };
            console.log('[AppDirs] Virtual FS tree bootstrapped — visible in Files app');
          } catch (e) {
            console.warn('[AppDirs] Virtual FS bootstrap failed:', e);
          }
        },

        // Get the root handle for an app's data directory by app ID or package name
        async getAppDir(appIdOrPkg) {
          const pkg = this.PACKAGES[appIdOrPkg] || appIdOrPkg;
          if (this._handles[pkg]) return this._handles[pkg];
          if (!OPFS.available || !OPFS.root) return null;
          try {
            const data = await OPFS.root.getDirectoryHandle('data');
            const dataData = await data.getDirectoryHandle('data');
            const appDir = await dataData.getDirectoryHandle(pkg);
            this._handles[pkg] = appDir;
            return appDir;
          } catch (e) {
            return null;
          }
        },

        // Helper — read a shared_prefs JSON file for an app
        async getPrefs(appIdOrPkg) {
          const appDir = await this.getAppDir(appIdOrPkg);
          if (!appDir) return {};
          try {
            const prefsDir = await appDir.getDirectoryHandle('shared_prefs');
            const file = await prefsDir.getFileHandle('prefs.json');
            const f = await file.getFile();
            return JSON.parse(await f.text());
          } catch (e) {
            return {};
          }
        },

        // Helper — write a shared_prefs JSON file for an app
        async setPrefs(appIdOrPkg, data) {
          const appDir = await this.getAppDir(appIdOrPkg);
          if (!appDir) return false;
          try {
            const prefsDir = await appDir.getDirectoryHandle('shared_prefs', { create: true });
            const file = await prefsDir.getFileHandle('prefs.json', { create: true });
            const w = await file.createWritable();
            await w.write(JSON.stringify(data));
            await w.close();
            return true;
          } catch (e) {
            return false;
          }
        },

        // Maps localStorage key → { pkg, subdir, filename }
        LS_MAP: {
          'calendar_events_v2': { pkg: 'com.nbosp.calendar', subdir: 'databases', file: 'events.json' },
          'nbosp_clock_v1': { pkg: 'com.nbosp.clock', subdir: 'databases', file: 'alarms.json' },
          'nbosp_email_accts_v2': { pkg: 'com.nbosp.email', subdir: 'databases', file: 'accounts.json' },
          'nbosp_email_drafts_v1': { pkg: 'com.nbosp.email', subdir: 'databases', file: 'drafts.json' },
          'nova_downloads': { pkg: 'com.nbosp.downloads', subdir: 'databases', file: 'history.json' },
          'nova_contacts': { pkg: 'com.nbosp.contacts', subdir: 'databases', file: 'contacts.json' },
          'nova_music_prefs': { pkg: 'com.nbosp.music', subdir: 'shared_prefs', file: 'prefs.json' },
          'nova_installed_apps': { pkg: 'com.nbosp.appmanager', subdir: 'databases', file: 'packages.json' },
        },

        // Get a virtual FS folder ID for an app's subdirectory
        getVFSDir(pkg, subdir) {
          return this.vfsFolders?.[pkg]?.[subdir] ?? null;
        },

        // Mirror one localStorage key into the virtual FS — called by lsSave override
        async syncKey(lsKey, value) {
          const mapping = this.LS_MAP[lsKey];
          if (!mapping || !this.vfsFolders) return;
          const folderId = this.getVFSDir(mapping.pkg, mapping.subdir);
          if (!folderId) return;
          const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
          try {
            const existing = FS.listDir(folderId).find(f => f.name === mapping.file && f.type === 'file');
            if (existing) { await FS.writeFile(existing.id, content); }
            else { await FS.createFile(folderId, mapping.file, content, 'application/json'); }
          } catch (e) { /* silent */ }
        },

        // Boot-time sync — read all known localStorage keys and write to virtual FS
        async _syncAllToVFS(updateVFile) {
          for (const [lsKey, mapping] of Object.entries(this.LS_MAP)) {
            const raw = localStorage.getItem(lsKey);
            if (!raw) continue;
            const folderId = this.getVFSDir(mapping.pkg, mapping.subdir);
            if (!folderId) continue;
            try {
              // Pretty-print if it's valid JSON, otherwise store as-is
              let content = raw;
              try { content = JSON.stringify(JSON.parse(raw), null, 2); } catch { }
              await updateVFile(folderId, mapping.file, content, 'application/json');
            } catch (e) { /* silent */ }
          }
        },

        // Wipe all data for one app (equivalent of Android "Clear App Data")
        async clearAppData(appIdOrPkg) {
          const pkg = this.PACKAGES[appIdOrPkg] || appIdOrPkg;
          if (!OPFS.available || !OPFS.root) return false;
          try {
            const data = await OPFS.root.getDirectoryHandle('data');
            const dataData = await data.getDirectoryHandle('data');
            await dataData.removeEntry(pkg, { recursive: true });
            delete this._handles[pkg];
            // Recreate empty structure
            const appDir = await dataData.getDirectoryHandle(pkg, { create: true });
            const mkd = (p, n) => p.getDirectoryHandle(n, { create: true });
            await mkd(appDir, 'files');
            await mkd(appDir, 'cache');
            await mkd(appDir, 'databases');
            await mkd(appDir, 'shared_prefs');
            this._handles[pkg] = appDir;
            return true;
          } catch (e) {
            return false;
          }
        },
      };

      // Global runtime flag — apps check this to verify they're running inside NovaByte
      window.__NB_RUNTIME = { os: 'NovaByte', layer: 'nbosp', ready: false };
      window.AppDirs = AppDirs;

      function openFileWithDefaultApp(fileNode) {
        if (!fileNode) return;

        const mime = fileNode.mimeType || '';
        let appId = 'quill'; // default

        if (mime === 'text/html' || fileNode.name.endsWith('.html') || fileNode.name.endsWith('.htm')) appId = 'browser';
        else if (mime.startsWith('image/')) appId = 'nbosp-gallery';
        else if (mime.startsWith('audio/')) appId = 'nbosp-music';
        else if (mime === 'application/pdf' || fileNode.name.endsWith('.pdf')) appId = 'lumina';

        WM.createWindow(appId, { fileId: fileNode.id });
      }

      function renderDesktopIcons() {
        const desktop = document.getElementById('desktop');
        desktop.innerHTML = '';

        // FIX 1.6.41: Respect user showDesktopIcons setting
        if (OS.settings.get('showDesktopIcons') === false) {
          return;
        }

        const desktopFolder = FS.specialFolders.desktop;
        if (!desktopFolder) return;

        const files = FS.listDir(desktopFolder);

        // Desktop icons are independent of taskbar pins — show nothing by default
        const defaultApps = [];

        // Desktop icon positions storage
        const iconPositions = OS.settings.get('desktopIconPositions') || {};

        // Add drop event handlers for creating app shortcuts
        function handleDesktopDrop(e) {
          e.preventDefault();
          e.stopPropagation();

          try {
            // First, check for app shortcut drops (JSON data)
            const data = e.dataTransfer.getData('application/json');
            if (data) {
              const payload = JSON.parse(data);

              if (payload.type === 'app-shortcut') {
                // Create a shortcut file on the desktop
                const shortcutName = payload.appName + '.lnk';
                const shortcutContent = JSON.stringify({
                  target: payload.appId,
                  type: 'app-shortcut',
                  icon: payload.appIcon
                });

                // Create in desktop folder
                const desktopFolder = FS.specialFolders.desktop;
                FS.createFile(desktopFolder, shortcutName, shortcutContent, 'application/x-app-shortcut').then(() => {
                  // Set drop position
                  const desktopRect = desktop.getBoundingClientRect();
                  const x = Math.max(0, Math.min(e.clientX - desktopRect.left, desktopRect.width - 80));
                  const y = Math.max(0, Math.min(e.clientY - desktopRect.top, desktopRect.height - 100));

                  // Key by appId so it matches what renderDesktopIcons looks up
                  iconPositions['app:' + payload.appId] = { x, y };
                  OS.settings.set('desktopIconPositions', iconPositions);

                  renderDesktopIcons();
                  Notify.show({
                    title: 'Shortcut Created',
                    body: `${payload.appName} shortcut added to desktop`,
                    type: 'success',
                    appName: 'Desktop'
                  });
                }).catch(err => {
                  console.error('Failed to create file:', err);
                  Notify.show({
                    title: 'Error',
                    body: 'Failed to create shortcut',
                    type: 'error',
                    appName: 'Desktop'
                  });
                });
                return;
              }
            }

            // If no JSON data or not an app-shortcut, check for file drops
            const files = e.dataTransfer.files;
            if (files && files.length > 0) {

              let filesAdded = 0;
              for (const file of files) {

                const reader = new FileReader();
                reader.onload = async () => {
                  try {
                    // Read file content
                    let content;
                    // For text files, use TextDecoder for proper UTF-8 handling
                    const buffer = reader.result;
                    const view = new Uint8Array(buffer);
                    content = new TextDecoder('utf-8').decode(view);

                    // Security check - Phase 1: Extension Check
                    const extCheck = checkFileExtension(file.name);
                    if (extCheck.blocked) {
                      Notify.show({
                        title: '🚫 File Blocked - Executable Type',
                        body: `"${file.name}": ${extCheck.reason}`,
                        type: 'error',
                        appName: 'System'
                      });
                      console.warn('[Security] Blocked on extension:', {
                        file: file.name,
                        reason: extCheck.reason
                      });
                      return;
                    }

                    // Security check - Phase 2: Content Pattern Scanning
                    if (typeof content === 'string') {
                      const scanResult = scanFileForThreats(content, file.name);
                      if (scanResult.isMalicious) {
                        const threatList = scanResult.patterns.join(', ');
                        Notify.show({
                          title: '⚠️ Malicious File Blocked',
                          body: `"${file.name}" contains threats: ${threatList}`,
                          type: 'error',
                          appName: 'System'
                        });
                        console.warn('[Security] Malicious file blocked:', {
                          file: file.name,
                          threats: scanResult.threats,
                          patterns: scanResult.patterns
                        });
                        return;
                      }
                    }

                    // Detect proper MIME type for known file extensions
                    let mimeType = file.type;
                    if (!mimeType) mimeType = 'application/octet-stream';

                    const desktopId = FS.specialFolders.desktop;
                    if (!desktopId) {
                      console.error('[Desktop Drop] Desktop folder ID not found');
                      Notify.show({ title: 'Error', body: 'Desktop folder not found', type: 'error', appName: 'System' });
                      return;
                    }

                    await FS.createFile(desktopId, file.name, content, mimeType);
                    filesAdded++;

                    // Refresh after each file
                    renderDesktopIcons();
                  } catch (err) {
                    console.error('[Desktop Drop] Error:', err);
                    Notify.show({ title: 'Error', body: `Failed to add ${file.name}: ${err.message}`, type: 'error', appName: 'System' });
                  }
                };

                reader.onerror = () => {
                  console.error('[Desktop Drop] File read error:', file.name);
                  Notify.show({ title: 'Error', body: `Failed to read ${file.name}`, type: 'error', appName: 'System' });
                };

                // Read file as ArrayBuffer
                reader.readAsArrayBuffer(file);
              }

              // Final success notification if files were added
              if (filesAdded > 0) {
                setTimeout(() => {
                  Notify.show({
                    title: 'Files Added',
                    body: `${filesAdded} file(s) added to desktop`,
                    type: 'success',
                    appName: 'System',
                    duration: 3000
                  });
                }, 300);
              }
            }
          } catch (err) {
            console.error('Drop error:', err);
          }
        }

        if (!desktop._dropHandlersAttached) {
          desktop._dropHandlersAttached = true;

          desktop.addEventListener('dragenter', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            desktop.style.opacity = '0.7';
          });

          desktop.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            desktop.style.opacity = '0.7';
          });

          desktop.addEventListener('dragleave', (e) => {
            // Only clear if leaving desktop entirely
            if (e.target === desktop) {
              desktop.style.opacity = '1';
            }
          });

          desktop.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            desktop.style.opacity = '1';
            handleDesktopDrop(e);
          });

          // Document-level drop fallback (covers edge cases where target is a child)
          document.addEventListener('drop', (e) => {
            if (e.target === desktop || (e.target && desktop.contains(e.target))) {
              e.preventDefault();
              e.stopPropagation();
              desktop.style.opacity = '1';
              handleDesktopDrop(e);
            }
          }, true);

        } // end _dropHandlersAttached guard

        // Add taskbar drop support for pinning apps
        const taskbar = document.getElementById('taskbar');
        if (taskbar) {
          taskbar.addEventListener('dragenter', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            taskbar.style.borderTop = '2px solid var(--accent)';
          });

          taskbar.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            taskbar.style.borderTop = '2px solid var(--accent)';
          });

          taskbar.addEventListener('dragleave', (e) => {
            // Only clear when pointer truly leaves the taskbar (not just a child element)
            if (!taskbar.contains(e.relatedTarget)) {
              taskbar.style.borderTop = '';
            }
          });

          taskbar.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            taskbar.style.borderTop = '';

            try {
              const data = e.dataTransfer.getData('application/json');
              if (!data) {
                return;
              }

              const payload = JSON.parse(data);
              if (payload.type !== 'app-shortcut') return;

              // Add app to pinned apps
              let pinnedApps = OS.settings.get('pinnedApps') || [];

              // Don't add duplicates
              if (!pinnedApps.includes(payload.appId)) {
                pinnedApps.push(payload.appId);
                OS.settings.set('pinnedApps', pinnedApps);
                // Refresh taskbar
                if (typeof WM !== 'undefined' && WM.updateTaskbar) {
                  WM.updateTaskbar();
                }
                Notify.show({
                  title: 'Pinned to Taskbar',
                  body: `${payload.appName} pinned to taskbar`,
                  type: 'success',
                  appName: 'Taskbar'
                });
              }
            } catch (err) {
              console.error('Taskbar drop error:', err);
            }
          });
        }

        function makeDraggable(icon, appId, isFile = false, fileNode = null) {
          let isDragging = false;
          let startX, startY, initialX, initialY;

          icon.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // Only left click
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = icon.getBoundingClientRect();
            const desktopRect = desktop.getBoundingClientRect();
            initialX = rect.left - desktopRect.left;
            initialY = rect.top - desktopRect.top;
            icon.style.zIndex = '1000';
            icon.style.transition = 'none';
          });

          document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const desktopRect = desktop.getBoundingClientRect();
            let newX = Math.max(0, Math.min(initialX + dx, desktopRect.width - icon.offsetWidth));
            let newY = Math.max(0, Math.min(initialY + dy, desktopRect.height - icon.offsetHeight));
            icon.style.position = 'absolute';
            icon.style.left = newX + 'px';
            icon.style.top = newY + 'px';
          });

          document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            icon.style.zIndex = '';
            icon.style.transition = '';
            // Save position
            const key = isFile ? ('file:' + fileNode.id) : ('app:' + appId);
            const rect = icon.getBoundingClientRect();
            const desktopRect = desktop.getBoundingClientRect();
            iconPositions[key] = {
              x: rect.left - desktopRect.left,
              y: rect.top - desktopRect.top
            };
            OS.settings.set('desktopIconPositions', iconPositions);
          });
        }

        function getInitialPosition(key, index, isFile = false) {
          const saved = iconPositions[key];
          if (saved) return { left: saved.x + 'px', top: saved.y + 'px', position: 'absolute' };
          // Default grid positions
          const iconSize = 80;
          const iconSpacing = 16;
          const cols = Math.floor((window.innerWidth - 40) / iconSize);
          const col = index % cols;
          const row = Math.floor(index / cols);
          const x = 20 + col * (iconSize + iconSpacing);
          const y = 20 + row * (iconSize + iconSpacing + 24); // +24 for label height
          return { position: 'absolute', left: x + 'px', top: y + 'px' };
        }

        defaultApps.forEach((app, idx) => {
          const key = 'app:' + app.id;
          const icon = createEl('div', {
            className: 'desktop-icon',
            tabindex: '0',
            'aria-label': app.name,
            role: 'button',
            style: getInitialPosition(key, idx)
          });
          const img = createEl('div', { className: 'desktop-icon-img' });
          img.innerHTML = svgIcon(app.icon, 40);
          const label = createEl('div', { className: 'desktop-icon-label', textContent: app.name });
          icon.appendChild(img);
          icon.appendChild(label);

          makeDraggable(icon, app.id);

          icon.addEventListener('dblclick', () => WM.createWindow(app.id));
          icon.addEventListener('click', (e) => {
            if (!e.ctrlKey) desktop.querySelectorAll('.desktop-icon').forEach(i => i.classList.remove('selected'));
            icon.classList.add('selected');
          });
          icon.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const pinnedApps = OS.settings.get('pinnedApps') || [];
            const isPinned = pinnedApps.includes(app.id);
            // Detect if this is a user-installed app (has a stored entry)
            const storedApps = (() => { try { return JSON.parse(localStorage.getItem('nova_installed_apps') || '[]'); } catch { return []; } })();
            const isUserApp = storedApps.some(a => a.id === app.id);
            const items = [
              { label: 'Open', icon: 'play', action: () => WM.createWindow(app.id) },
              { separator: true },
              {
                label: isPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar',
                icon: 'pin',
                action: () => {
                  const pins = OS.settings.get('pinnedApps') || [];
                  const next = isPinned ? pins.filter(id => id !== app.id) : [...pins, app.id];
                  OS.settings.set('pinnedApps', next);
                  WM.updateTaskbar();
                  Notify.show({ title: isPinned ? 'Unpinned' : 'Pinned', body: `${app.name} ${isPinned ? 'removed from' : 'pinned to'} taskbar`, type: 'success', appName: 'Desktop' });
                }
              }];
            if (isUserApp) {
              items.push({ separator: true });
              items.push({
                label: 'Uninstall',
                icon: 'trash',
                danger: true,
                action: () => {
                  if (!confirm(`Uninstall "${app.name}"?

This cannot be undone.`)) return;
                  try {
                    const stored = JSON.parse(localStorage.getItem('nova_installed_apps') || '[]');
                    const updated = stored.filter(a => a.id !== app.id);
                    localStorage.setItem('nova_installed_apps', JSON.stringify(updated));
                    delete OS.apps[app.id];
                    const ri = APP_REGISTRY.findIndex(a => a.id === app.id);
                    if (ri > -1) APP_REGISTRY.splice(ri, 1);
                    renderDesktopIcons();
                    WM.updateTaskbar();
                    Notify.show({ title: 'Uninstalled', body: `${app.name} has been removed.`, type: 'success', appName: 'Desktop' });
                  } catch (err) {
                    Notify.show({ title: 'Error', body: `Failed to uninstall: ${err.message}`, type: 'error', appName: 'Desktop' });
                  }
                }
              });
            }
            ContextMenu.show(e.clientX, e.clientY, items);
          });
          desktop.appendChild(icon);
        });

        // Add files
        files.forEach((f, idx) => {
          // Check if this is a shortcut file
          let isShortcut = false;
          let shortcutData = null;

          if (f.name.endsWith('.lnk') && f.mimeType === 'application/x-app-shortcut') {
            try {
              shortcutData = JSON.parse(f.content);
              if (shortcutData && shortcutData.type === 'app-shortcut') {
                isShortcut = true;
              }
            } catch (e) {
              // Not a valid shortcut, treat as normal file
            }
          }

          const key = 'file:' + f.id;
          const icon = createEl('div', {
            className: 'desktop-icon',
            tabindex: '0',
            'aria-label': f.name,
            role: 'button',
            style: getInitialPosition(key, defaultApps.length + idx, true)
          });
          const img = createEl('div', { className: 'desktop-icon-img' });

          // Use app icon for shortcuts
          if (isShortcut && shortcutData) {
            img.innerHTML = svgIcon(shortcutData.icon, 40);
            // Add small arrow to indicate shortcut
            const arrow = createEl('div', {
              style: 'position: absolute; bottom: 0; right: 0; width: 16px; height: 16px; background: var(--accent); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; color: white; font-weight: bold;'
            });
            arrow.textContent = '→';
            img.style.position = 'relative';
            img.appendChild(arrow);
          } else {
            img.innerHTML = svgIcon(FS.getMimeIcon(f.mimeType, f.name), 40);
            if (f.type === 'folder') img.style.color = 'var(--text-warning)';
          }

          const label = createEl('div', { className: 'desktop-icon-label', textContent: isShortcut ? f.name.replace(/\.lnk$/i, '') : f.name });
          icon.appendChild(img);
          icon.appendChild(label);

          makeDraggable(icon, null, true, f);

          icon.addEventListener('dblclick', () => {
            if (isShortcut && shortcutData) {
              // Launch the app from the shortcut
              WM.createWindow(shortcutData.target);
            } else if (f.type === 'folder') {
              WM.createWindow('vault', { folderId: f.id });
            } else {
              openFileWithDefaultApp(f);
            }
          });
          icon.addEventListener('click', (e) => {
            if (!e.ctrlKey) desktop.querySelectorAll('.desktop-icon').forEach(i => i.classList.remove('selected'));
            icon.classList.add('selected');
          });
          icon.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const viewOnly = OS.settings.get('filesViewOnly');
            const menuItems = [
              { label: 'Open', icon: 'play', action: () => openFileWithDefaultApp(f) }
            ];
            if (!viewOnly) {
              menuItems.push(
                {
                  label: 'Rename', icon: 'edit', action: async () => {
                    const name = await showPrompt('Rename', f.name);
                    if (name && name !== f.name) {
                      await FS.rename(f.id, name);
                      renderDesktopIcons();
                    }
                  }
                },
                { separator: true },
                {
                  label: 'Move to Trash', icon: 'trash', danger: true, action: async () => {
                    await FS.deleteToTrash(f.id);
                    renderDesktopIcons();
                  }
                }
              );
            }
            ContextMenu.show(e.clientX, e.clientY, menuItems);
          });
          desktop.appendChild(icon);
        });
      }


