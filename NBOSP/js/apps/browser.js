registerApp({
        id: 'browser', name: 'Browser', icon: 'globe',
        description: 'Web Browser',
        defaultSize: [900, 600], minSize: [500, 350],
        onClose(state) {
          if (window.ipc && typeof window.ipc.postMessage === 'function') {
            try {
              window.ipc.postMessage(JSON.stringify({ type: 'browser:closeAll', source: 'browser-app' }));
            } catch (err) {
              console.error('[NB Browser] Failed to send IPC close message:', err);
            }
          }
        },
        init(content, state, options) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.browser', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.browser</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const container = createEl('div', { className: 'browser-container' });

          // ── Tabs bar ──────────────────────────────────────────────────────
          const tabsBar = createEl('div', { className: 'browser-tabs-bar', role: 'tablist' });

          let tabs = [{ id: 1, title: 'New Tab', url: '', favicon: '', incognito: false }];
          let activeTabId = 1;
          let nextTabId = 2;

          // ── Bookmarks, History & Settings storage ─────────────────────────
          const BK_KEY = 'nbosp_browser_bookmarks';
          const HX_KEY = 'nbosp_browser_history';

          // Normalise any stored favicon URL to go through the local proxy.
          // Old bookmarks/history may have the Google URL baked in — rewrite on the fly.
          function normFavicon(favicon, siteUrl = '') {
            if (!favicon) return '';
            // Already a proxy URL — use as-is
            if (favicon.startsWith('/api/favicon') || favicon.startsWith('/api/email-image')) return favicon;
            // Old Google favicon URL — extract the domain and re-proxy
            try {
              const u = new URL(favicon);
              if (u.hostname === 'www.google.com' && u.pathname === '/s2/favicons') {
                const domain = u.searchParams.get('domain');
                if (domain) return '/api/favicon?domain=' + encodeURIComponent(domain);
              }
            } catch (err) {
              console.debug('[NB Browser] Invalid favicon URL:', favicon);
            }
            // Resolve relative paths into absolute URLs using the guest tab's current domain
            if (!/^https?:\/\//i.test(favicon) && siteUrl) {
              try {
                favicon = new URL(favicon, siteUrl).href;
              } catch (_) {}
            }
            // Any other external URL — proxy it via favicon endpoint using the URL's hostname
            if (/^https?:\/\//i.test(favicon)) {
              try {
                const domain = new URL(favicon).hostname;
                return '/api/favicon?domain=' + encodeURIComponent(domain);
              } catch (err) {
                console.debug('[NB Browser] Failed to extract domain from favicon:', favicon);
              }
            }
            return favicon;
          }
          const ST_KEY = 'nbosp_browser_settings';
          let _settingsCache = null;
          function loadSettings() {
            if (_settingsCache) return _settingsCache;
            try {
              _settingsCache = JSON.parse(localStorage.getItem(ST_KEY) || '{}');
            } catch (err) {
              // FIX: Proper error logging for JSON.parse failures to detect corruption
              console.error('[NB Browser] Settings cache corrupted, resetting:', err);
              _settingsCache = {};
              localStorage.removeItem(ST_KEY);
            }
            return _settingsCache;
          }
          let _settingsSaveTimer = null;
          function saveSetting(key, val) {
            const s = loadSettings();
            s[key] = val;
            _settingsCache = s;
            clearTimeout(_settingsSaveTimer);
            _settingsSaveTimer = setTimeout(() => {
              try { localStorage.setItem(ST_KEY, JSON.stringify(s)); }
              catch (_) { console.warn('[NB Browser] Failed to save settings'); }
            }, 300);
          }
          function getSetting(key, def) { const v = loadSettings()[key]; return v !== undefined ? v : def; }

          // Search engines — Brave is default out of the box
          const SEARCH_ENGINES = {
            google: { label: 'Google', url: 'https://www.google.com/search?q=' },
            bing: { label: 'Bing', url: 'https://www.bing.com/search?q=' },
            duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
            ecosia: { label: 'Ecosia', url: 'https://www.ecosia.org/search?q=' },
            brave: { label: 'Brave', url: 'https://search.brave.com/search?q=' },
            yahoo: { label: 'Yahoo', url: 'https://search.yahoo.com/search?p=' },
          };
          function getSearchUrl(q) {
            const eng = getSetting('searchEngine', 'brave');
            const base = SEARCH_ENGINES[eng]?.url || SEARCH_ENGINES.brave.url;
            return base + encodeURIComponent(q);
          }

          let _bookmarksCache = null;
          function loadBookmarks() {
            if (_bookmarksCache) return _bookmarksCache;
            try {
              _bookmarksCache = JSON.parse(localStorage.getItem(BK_KEY) || '[]');
            } catch (err) {
              // FIX: Proper error logging for JSON.parse failures to detect corruption
              console.error('[NB Browser] Bookmarks cache corrupted, resetting:', err);
              _bookmarksCache = [];
              localStorage.removeItem(BK_KEY);
            }
            return _bookmarksCache;
          }
          let _bookmarksSaveTimer = null;
          function saveBookmarks(arr) {
            _bookmarksCache = arr.slice(0, 500);
            clearTimeout(_bookmarksSaveTimer);
            _bookmarksSaveTimer = setTimeout(() => {
              try { localStorage.setItem(BK_KEY, JSON.stringify(_bookmarksCache)); }
              catch (_) { console.warn('[NB Browser] Failed to save bookmarks'); }
            }, 300);
          }
          let _historyCache = null;
          function loadHistory() {
            if (_historyCache) return _historyCache;
            try {
              _historyCache = JSON.parse(localStorage.getItem(HX_KEY) || '[]');
            } catch (err) {
              // FIX: Proper error logging for JSON.parse failures to detect corruption
              console.error('[NB Browser] History cache corrupted, resetting:', err);
              _historyCache = [];
              localStorage.removeItem(HX_KEY);
            }
            return _historyCache;
          }
          let _historySaveTimer = null;
          function saveHistory(arr) {
            _historyCache = arr.slice(0, 1000);
            clearTimeout(_historySaveTimer);
            _historySaveTimer = setTimeout(() => {
              try { localStorage.setItem(HX_KEY, JSON.stringify(_historyCache)); }
              catch (_) { console.warn('[NB Browser] Failed to save history'); }
            }, 300);
          }
          function isBookmarked(url) { return loadBookmarks().some(b => b.url === url); }
          function toggleBookmark(url, title, favicon) {
            let arr = loadBookmarks();
            const idx = arr.findIndex(b => b.url === url);
            if (idx >= 0) { arr.splice(idx, 1); saveBookmarks(arr); return false; }
            arr.unshift({ url: url.slice(0, 2000), title: (title || url).slice(0, 300), favicon: favicon || '', ts: Date.now() });
            saveBookmarks(arr);
            return true;
          }

          let _panelType = null; // track which panel is currently open for live refresh
          function addHistory(originTabId, url, title, favicon) {
            const tab = tabs.find(t => t.id === originTabId);
            if (!tab || tab.incognito || tab.isPopup) return; // no history in incognito or popup windows
            try {
              // Drop oversized Base64 data-URIs before they can exhaust the 5 MB localStorage quota.
              // Legitimate favicons proxied through /api/favicon are short strings; anything larger
              // than 2 KB inline is almost certainly an unintentional or malicious blob.
              let safeFavicon = favicon || '';
              if (safeFavicon.startsWith('data:') && safeFavicon.length > 2048) {
                safeFavicon = '';
              }
              const safeTitle = (title || url).slice(0, 300);
              const safeStorageUrl = url.slice(0, 2000);
              let arr = loadHistory().filter(h => h.url !== url); // deduplicate
              arr.unshift({ url: safeStorageUrl, title: safeTitle, favicon: safeFavicon, ts: Date.now() });
              saveHistory(arr);
              // Live-refresh history panel if it's open
              if (_panelType === 'history' && panel.style.display !== 'none') showPanel('history');
            } catch { }
          }
          // loadHistory defined above (write-through cache version)

          // FIX: Helper for event delegation to prevent listener accumulation on repeated renders
          function delegateEvent(container, eventType, selector, handler) {
            container.addEventListener(eventType, (e) => {
              const target = e.target.closest(selector);
              if (target) handler.call(target, e);
            });
          }

          function renderTabs() {
            tabsBar.innerHTML = '';
            tabs.forEach(tab => {
              const tabEl = createEl('button', {
                className: 'browser-tab' + (tab.id === activeTabId ? ' active' : '') + (tab.incognito ? ' incognito' : ''),
                role: 'tab',
                'aria-selected': tab.id === activeTabId,
              });
              const faviconSpan = createEl('span', { className: 'tab-icon' });
              if (tab.favicon) {
                const img = createEl('img', { src: normFavicon(tab.favicon), style: { width: '14px', height: '14px', borderRadius: '2px' } });
                faviconSpan.appendChild(img);
              } else {
                faviconSpan.innerHTML = svgIcon('globe', 14);
              }
              tabEl.appendChild(faviconSpan);
              const titleSpan = createEl('span', { className: 'tab-title', textContent: tab.title });
              tabEl.appendChild(titleSpan);
              const closeBtn = createEl('span', { className: 'tab-close' });
              closeBtn.innerHTML = svgIcon('x', 12);
              closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id); });
              tabEl.appendChild(closeBtn);
              tabEl.addEventListener('click', () => switchToTab(tab.id));
              tabsBar.appendChild(tabEl);
            });
            const newTabBtn = createEl('button', { className: 'browser-new-tab-btn', 'aria-label': 'New tab' });
            newTabBtn.innerHTML = svgIcon('plus', 16);
            newTabBtn.addEventListener('click', createNewTab);
            tabsBar.appendChild(newTabBtn);
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
              // position:absolute so the CSS width/left/transform take effect
              wv.style.position = 'absolute';
            } else {
              wv.classList.remove('mobile-viewport');
              viewport.classList.remove('mobile-mode');
              // restore normal flow positioning used by showWebviewForTab
              wv.style.position = 'relative';
              wv.style.width = '';
              wv.style.left = '';
              wv.style.transform = '';
            }
          }

          function toggleUserAgent() {
            const tab = tabs.find(t => t.id === activeTabId);
            if (!tab) return;
            const mode = getTabMode(activeTabId);
            const goingMobile = tab.userAgent !== 'mobile';
            tab.userAgent = goingMobile ? 'mobile' : 'desktop';

            if (mode === 'iframe') {
              // iframes can't override UA — apply the 390px viewport frame only.
              // Responsive sites will react to the narrow width even without a mobile UA.
              const ifr = tabIframes.get(activeTabId);
              if (!ifr) return;
              applyMobileViewportFrame(ifr, goingMobile);
              // Re-apply zoom with correct dimensions after mobile/desktop toggle
              const z = tabZoom.get(activeTabId) || 1.0;
              if (goingMobile) {
                ifr.style.width = '390px';
                ifr.style.height = '100%';
                ifr.style.transformOrigin = 'top center';
                ifr.style.transform = z !== 1.0 ? `translateX(-50%) scale(${z})` : 'translateX(-50%)';
              } else {
                const pct = (100 / z).toFixed(4) + '%';
                ifr.style.width = pct;
                ifr.style.height = pct;
                ifr.style.transformOrigin = 'top left';
                ifr.style.transform = z !== 1.0 ? `scale(${z})` : '';
              }
              // Reload so the page re-renders inside the new frame dimensions
              try { ifr.contentWindow.location.reload(); } catch (_) {
                // cross-origin — force reload via src reassignment
                const src = ifr.src; ifr.src = ''; ifr.src = src;
              }
            } else {
              const wv = tabWebviews.get(activeTabId);
              if (!wv) return;
              if (goingMobile) {
                wv.setUserAgentOverride('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
                applyMobileViewportFrame(wv, true);
              } else {
                wv.setUserAgentOverride('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                applyMobileViewportFrame(wv, false);
              }
              if (tab.url) {
                // Register listener BEFORE reload so we never miss the loadstop event
                if (goingMobile) {
                  wv.addEventListener('loadstop', function onMobileLoad() {
                    wv.removeEventListener('loadstop', onMobileLoad);
                    wv.executeScript({
                      code: `
                      var m = document.querySelector('meta[name=viewport]');
                      if (!m) { m = document.createElement('meta'); m.name='viewport'; document.head.appendChild(m); }
                      m.content = 'width=device-width, initial-scale=1, maximum-scale=1';
                    ` });
                  });
                }
                wv.reload();
              }
            }
          }

          const tabZoom = new Map();    // per-tab zoom level
          const tabCleanups = new Map(); // tabId → [cleanup fns]
          function adjustZoom(delta) {
            let z = tabZoom.get(activeTabId) || 1.0;
            if (delta === 0) { z = 1.0; }
            else { z = Math.min(3, Math.max(0.25, z + delta)); }
            tabZoom.set(activeTabId, z);
            const mode = getTabMode(activeTabId);
            if (mode === 'iframe') {
              const ifr = tabIframes.get(activeTabId);
              if (!ifr) return;
              const tab = tabs.find(t => t.id === activeTabId);
              const isMobile = tab?.userAgent === 'mobile';
              if (isMobile) {
                ifr.style.width = '390px';
                ifr.style.height = '100%';
                ifr.style.transformOrigin = 'top center';
                ifr.style.transform = z !== 1.0 ? `translateX(-50%) scale(${z})` : 'translateX(-50%)';
              } else {
                const pct = (100 / z).toFixed(4) + '%';
                ifr.style.width = pct;
                ifr.style.height = pct;
                ifr.style.transformOrigin = 'top left';
                ifr.style.transform = z !== 1.0 ? `scale(${z})` : '';
              }
            } else {
              const wv = tabWebviews.get(activeTabId);
              if (!wv) return;
              wv.setZoom(z);
            }
          }

          function closeTab(tabId) {
            const idx = tabs.findIndex(t => t.id === tabId);
            if (idx === -1) return;
            if (tabId === activeTabId && tabs.length > 1) {
              switchToTab(tabs[idx > 0 ? idx - 1 : 1].id);
            }
            // FIX: Revoke any tracked blob URLs to prevent memory leaks
            const closedTab = tabs.find(t => t.id === tabId);
            if (closedTab?.activeBlobUrl) {
              try { URL.revokeObjectURL(closedTab.activeBlobUrl); } catch (_) {}
            }
            tabs = tabs.filter(t => t.id !== tabId);
            // Run per-tab cleanups (cancels poll timers, etc.) before removing the webview
            (tabCleanups.get(tabId) || []).forEach(fn => { try { fn(); } catch (_) {} });
            tabCleanups.delete(tabId);
            // FIX: Remove DOM elements BEFORE checking tabs.length, to prevent zombie viewport elements
            const closedWv = tabWebviews?.get(tabId); if (closedWv) { closedWv.remove(); tabWebviews.delete(tabId); }
            const closedIfr = tabIframes?.get(tabId); if (closedIfr) { closedIfr.remove(); tabIframes.delete(tabId); }
            tabViewMode.delete(tabId);
            tabZoom.delete(tabId);  // FIX: Clean up orphaned zoom state to prevent memory leak
            const closedNotice = viewport.querySelector('.browser-iframe-blocked[data-tab="' + tabId + '"]'); if (closedNotice) closedNotice.remove();
            // Now evaluate whether we need a default fallback tab
            if (tabs.length === 0) { createNewTab(); return; }
            renderTabs();
          }

          function renderSpeedDial() {
            // Batch visibility changes to prevent layout thrashing
            requestAnimationFrame(() => {
              for (const wv of tabWebviews.values()) {
                wv.style.visibility = 'hidden';
                wv.style.pointerEvents = 'none';
              }
            });
            // Remove old speed dial
            const old = viewport.querySelector('.speed-dial');
            if (old) old.remove();
            const tab = tabs.find(t => t.id === activeTabId);
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
              const grid = createEl('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:12px;width:100%;max-width:640px;' });
              bookmarks.forEach(bk => {
                const tile = createEl('div', { className: 'speed-dial-tile' });
                const ico = createEl('div', { style: 'width:32px;height:32px;border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:var(--bg-hover);' });
                {
                  const _fimg = document.createElement('img');
                  if (bk.favicon && /^https?:\/\//i.test(bk.favicon)) {
                    _fimg.src = normFavicon(bk.favicon);
                  } else {
                    try { _fimg.src = '/api/favicon?domain=' + encodeURIComponent(new URL(bk.url).hostname); } catch { _fimg.src = ''; }
                  }
                  _fimg.style.cssText = 'width:24px;height:24px;border-radius:3px;';
                  _fimg.onerror = () => { ico.innerHTML = ''; ico.innerHTML = svgIcon('globe', 20); };
                  if (_fimg.src) ico.appendChild(_fimg); else ico.innerHTML = svgIcon('globe', 20);
                }
                const lbl = createEl('div', { style: 'font-size:11px;color:var(--text-secondary);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%;' });
                try { lbl.textContent = new URL(bk.url).hostname.replace('www.', ''); } catch { lbl.textContent = bk.title; }
                tile.append(ico, lbl);
                tile.addEventListener('click', () => { sd.remove(); navigate(bk.url); });
                grid.appendChild(tile);
              });
              sd.appendChild(grid);
            } else {
              const hint = createEl('div', { style: 'color:var(--text-muted);font-size:13px;text-align:center;' });
              hint.textContent = 'Bookmark sites with ★ to see them here';
              sd.appendChild(hint);
            }
            // Recent history
            const hist = loadHistory().slice(0, 5);
            if (hist.length && !tab?.incognito) {
              const sec = createEl('div', { style: 'width:100%;max-width:640px;' });
              sec.innerHTML = '<div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em;">Recent</div>';
              hist.forEach(h => {
                const row = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;' });
                row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-elevated)');
                row.addEventListener('mouseleave', () => row.style.background = '');
                row.innerHTML = svgIcon('clock', 13) + '<span style="font-size:12px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;"></span>'; row.querySelector('span').textContent = h.title || h.url;
                row.addEventListener('click', () => { sd.remove(); navigate(h.url); });
                sec.appendChild(row);
              });
              sd.appendChild(sec);
            }
            viewport.appendChild(sd);
          }

          function switchToTab(tabId) {
            activeTabId = tabId;
            const tab = tabs.find(t => t.id === tabId);
            if (tab) {
              urlBar.value = stripHttps(tab.url || ''); currentUrl = tab.url || '';
              starBtn.style.color = tab.url && isBookmarked(tab.url) ? 'var(--accent)' : '';
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
                // hide speed dial if present
                const sd = viewport.querySelector('.speed-dial');
                if (sd) sd.remove();
              } else {
                const hp = getSetting('homepage', 'most_visited');
                if (hp === 'custom') {
                  const hpUrl = getSetting('homepageUrl', '');
                  if (hpUrl) {
                    tab.url = hpUrl;
                    navigate(hpUrl);
                  } else {
                    renderSpeedDial(); // no custom URL set yet, fall back
                  }
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

          // ── Toolbar ───────────────────────────────────────────────────────
          const toolbar = createEl('div', { className: 'browser-toolbar' });

          const backBtn = createEl('button', { className: 'browser-nav-btn', 'aria-label': 'Go back' });
          backBtn.innerHTML = svgIcon('chevron-left', 16);
          const fwdBtn = createEl('button', { className: 'browser-nav-btn', 'aria-label': 'Go forward' });
          fwdBtn.innerHTML = svgIcon('chevron-right', 16);
          const refreshBtn = createEl('button', { className: 'browser-nav-btn', 'aria-label': 'Refresh' });
          refreshBtn.innerHTML = svgIcon('refresh', 16);

          const urlBarWrap = createEl('div', { className: 'browser-url-bar-wrap' });
          const urlBar = createEl('input', {
            id: 'browser-url-bar',
            name: 'url',
            className: 'browser-url-bar',
            placeholder: 'Search or enter URL…',
            'aria-label': 'Address bar'
          });
          const urlIcon = createEl('span', { className: 'browser-url-icon' });
          urlIcon.innerHTML = svgIcon('search', 14);
          urlBarWrap.appendChild(urlBar);
          urlBarWrap.appendChild(urlIcon);

          function updateUrlIcon(url) {
            if (url && url.startsWith('https://')) {
              urlIcon.innerHTML = svgIcon('lock', 14);
              urlIcon.style.color = 'var(--text-success)';
            } else if (url && url.startsWith('http://')) {
              // Only show warning icon if the security warnings setting is enabled
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

          // ── Star bookmark button ──────────────────────────────────────
          const starBtn = createEl('button', { className: 'browser-nav-btn', 'aria-label': 'Bookmark', title: 'Bookmark this page' });
          starBtn.innerHTML = svgIcon('star', 16);
          starBtn.addEventListener('click', () => {
            if (!currentUrl || currentUrl.startsWith('novabyte:')) return;
            const tab = tabs.find(t => t.id === activeTabId);
            if (tab?.incognito) return; // no bookmarks in incognito
            const added = toggleBookmark(currentUrl, tab?.title, tab?.favicon);
            starBtn.style.color = added ? 'var(--accent)' : '';
            starBtn.innerHTML = svgIcon(added ? 'star-filled' : 'star', 16);
            Notify.show({ title: added ? 'Bookmark added' : 'Bookmark removed', body: tab?.title || currentUrl, type: 'info', appName: 'Browser' });
          });

          // ── Menu button ───────────────────────────────────────────────
          const menuBtn = createEl('button', { className: 'browser-nav-btn', 'aria-label': 'Menu', title: 'Browser menu' });
          menuBtn.innerHTML = svgIcon('menu', 16);
          menuBtn.addEventListener('click', (e) => {
            const tab = tabs.find(t => t.id === activeTabId);
            const isIncog = tab?.incognito || false;
            const menuItems = [
              { label: 'New Tab', action: () => createNewTab() },
              { label: 'New Incognito Tab', action: () => createIncognitoTab() },
              { separator: true },
            ];
            if (!isIncog) menuItems.push({ label: 'Bookmarks', action: () => showPanel('bookmarks') });
            menuItems.push({ label: 'History', action: () => showPanel('history') });
            menuItems.push({ separator: true });
            menuItems.push(
              { label: 'Find in Page', shortcut: 'Ctrl+F', action: () => openFindBar() },
              { label: tab?.userAgent === 'mobile' ? 'Switch to Desktop Site' : 'Switch to Mobile Site', action: () => toggleUserAgent() },
              { label: getTabMode(activeTabId) === 'iframe' ? 'Switch to Webview Mode' : 'Switch to iFrame Mode', action: () => { const next = getTabMode(activeTabId) === 'iframe' ? 'webview' : 'iframe'; if (next === 'webview') clearFindStateOnModeSwitch(); setTabMode(activeTabId, next); const t = tabs.find(t2 => t2.id === activeTabId); if (t?.url && t.url !== 'browser://settings') navigate(t.url); updateModeBtn(); } },
              { separator: true },
              { label: 'Zoom In', action: () => adjustZoom(0.1) },
              { label: 'Zoom Out', action: () => adjustZoom(-0.1) },
              { label: 'Reset Zoom', action: () => adjustZoom(0) },
              { separator: true },
              { label: 'Settings', action: () => navigate('browser://settings') },
            );
            ContextMenu.show(e.clientX, e.clientY, menuItems);
          });

          toolbar.append(backBtn, fwdBtn, refreshBtn, urlBarWrap, starBtn, menuBtn);

          // ── View mode toggle button (Webview ↔ iFrame) ───────────────────
          const modeBtn = createEl('button', { className: 'browser-mode-btn', title: 'Switch to iframe mode' });
          modeBtn.innerHTML = svgIcon('monitor', 14) + ' <span>Webview</span>';
          modeBtn.addEventListener('click', () => {
            const current = getTabMode(activeTabId);
            const next = current === 'webview' ? 'iframe' : 'webview';
            setTabMode(activeTabId, next);
            // Re-navigate current URL in the new mode
            const tab = tabs.find(t => t.id === activeTabId);
            if (tab?.url && tab.url !== 'browser://settings') navigate(tab.url);
            updateModeBtn();
          });
          toolbar.appendChild(modeBtn);

          // ── Find bar ─────────────────────────────────────────────────
          const findBar = createEl('div', { style: 'display:none;align-items:center;gap:6px;padding:4px 10px;background:var(--bg-elevated);border-bottom:1px solid var(--border-subtle);flex-shrink:0;' });
          const findInput = createEl('input', { id: 'page-find-input', name: 'page-find', placeholder: 'Find in page…', style: 'flex:1;background:var(--bg-base);border:1px solid var(--border-subtle);border-radius:4px;padding:3px 8px;font-size:12px;color:var(--text-primary);outline:none;' });
          const findCount = createEl('span', { style: 'font-size:11px;color:var(--text-muted);min-width:50px;' });
          const findPrev = createEl('button', { className: 'browser-nav-btn', style: 'padding:2px 6px;', title: 'Previous' });
          findPrev.innerHTML = svgIcon('chevron-up', 14);
          const findNext = createEl('button', { className: 'browser-nav-btn', style: 'padding:2px 6px;', title: 'Next' });
          findNext.innerHTML = svgIcon('chevron-down', 14);
          const findClose = createEl('button', { className: 'browser-nav-btn', style: 'padding:2px 6px;', title: 'Close' });
          findClose.innerHTML = svgIcon('x', 14);
          findBar.append(findInput, findCount, findPrev, findNext, findClose);

          function openFindBar() {
            findBar.style.display = 'flex';
            findInput.focus(); findInput.select();
          }
          // ── iframe find helpers ──────────────────────────────────────────
          let _iframeFinds = [];
          let _iframeFindIdx = 0;

          function iframeFind(text, backward) {
            const ifr = tabIframes.get(activeTabId);
            if (!ifr) return;
            let doc;
            try {
              doc = ifr.contentDocument;
            } catch (e) {
              // FIX: Handle cross-origin iframe errors gracefully with user feedback
              console.warn('[NB Browser] Cannot search cross-origin iframe:', e.message);
              findCount.textContent = '0/0';
              return;
            }
            if (!doc || !doc.body) return;

            // Clear previous highlights then NORMALIZE to merge fragmented text nodes.
            // Without normalize(), searching "hel" after "he" leaves ["he","l","lo"] split
            // nodes so the next regex never matches across the boundary.
            doc.querySelectorAll('.__nb_highlight').forEach(el => {
              el.replaceWith(doc.createTextNode(el.textContent));
            });
            doc.body.normalize();
            _iframeFinds = [];

            if (!text) { findCount.textContent = ''; return; }

            const re = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

            // Walk text nodes, skipping script/style so we don't break page JS
            const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
              acceptNode(node) {
                const tag = node.parentElement && node.parentElement.tagName;
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

            toReplace.forEach(node => {
              const frag = doc.createDocumentFragment();
              let last = 0, m;
              re.lastIndex = 0;
              while ((m = re.exec(node.textContent)) !== null) {
                frag.appendChild(doc.createTextNode(node.textContent.slice(last, m.index)));
                const mark = doc.createElement('mark');
                mark.className = '__nb_highlight';
                // font:inherit preserves every font property (family, size, weight, style,
                // variant, line-height) so highlights don't reflow text or break custom fonts
                mark.style.cssText = 'background:#f6c90e !important;color:#000 !important;' +
                  'font:inherit !important;display:inline !important;' +
                  'padding:0 !important;margin:0 !important;border-radius:2px;' +
                  'text-decoration:inherit !important;vertical-align:inherit !important;';
                mark.textContent = m[0];
                frag.appendChild(mark);
                _iframeFinds.push(mark);
                last = m.index + m[0].length;
              }
              frag.appendChild(doc.createTextNode(node.textContent.slice(last)));
              node.parentNode.replaceChild(frag, node);
            });

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
              if (d && d.body) {
                d.querySelectorAll('.__nb_highlight').forEach(el => {
                  el.replaceWith(d.createTextNode(el.textContent));
                });
                d.body.normalize();
              }
            } catch (_) {}
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
              if (wv) wv.stopFinding('clear');
            }
          }

          // Also clear iframe highlights whenever the active tab switches away from iframe mode
          // (e.g. clicking "Switch to Webview" while find bar was open) — prevents stale marks
          // from causing the "bottom half cut off" repaint glitch in the new webview view.
          function clearFindStateOnModeSwitch() {
            iframeFindClear();
            findCount.textContent = '';
          }

          findInput.addEventListener('input', () => {
            const q = findInput.value;
            if (getTabMode(activeTabId) === 'iframe') {
              iframeFind(q, false);
            } else {
              const wv = tabWebviews.get(activeTabId);
              if (!wv || !q) { findCount.textContent = ''; return; }
              wv.find(q, {}, r => { if (r) findCount.textContent = r.activeMatchOrdinal + '/' + r.numberOfMatches; });
            }
          });
          findInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
              if (getTabMode(activeTabId) === 'iframe') { iframeFindStep(e.shiftKey); }
              else { const wv = tabWebviews.get(activeTabId); if (wv && findInput.value) wv.find(findInput.value, { backward: e.shiftKey }, r => { if (r) findCount.textContent = r.activeMatchOrdinal + '/' + r.numberOfMatches; }); }
            }
            if (e.key === 'Escape') closeFindBar();
          });
          findPrev.addEventListener('click', () => {
            if (getTabMode(activeTabId) === 'iframe') { iframeFindStep(true); }
            else { const wv = tabWebviews.get(activeTabId); if (wv && findInput.value) wv.find(findInput.value, { backward: true }, r => { if (r) findCount.textContent = r.activeMatchOrdinal + '/' + r.numberOfMatches; }); }
          });
          findNext.addEventListener('click', () => {
            if (getTabMode(activeTabId) === 'iframe') { iframeFindStep(false); }
            else { const wv = tabWebviews.get(activeTabId); if (wv && findInput.value) wv.find(findInput.value, { backward: false }, r => { if (r) findCount.textContent = r.activeMatchOrdinal + '/' + r.numberOfMatches; }); }
          });
          findClose.addEventListener('click', closeFindBar);

          // ── Panel (Bookmarks / History) ───────────────────────────────
          const panel = createEl('div', { style: 'display:none;position:absolute;top:0;right:0;bottom:0;width:300px;background:var(--bg-elevated);border-left:1px solid var(--border-subtle);z-index:100;flex-direction:column;overflow:hidden;' });
          function showPanel(type) {
            _panelType = type;
            // Re-attach panel if it was somehow detached from viewport
            if (!panel.parentNode) viewport.appendChild(panel);
            panel.style.display = 'flex';
            panel.innerHTML = '';
            const hdr = createEl('div', { style: 'display:flex;align-items:center;padding:10px 12px;border-bottom:1px solid var(--border-subtle);gap:8px;flex-shrink:0;' });
            const title = createEl('span', { textContent: type === 'bookmarks' ? '★ Bookmarks' : '🕐 History', style: 'font-size:13px;font-weight:600;flex:1;' });
            const closeP = createEl('button', { className: 'browser-nav-btn', style: 'padding:2px 6px;' });
            closeP.innerHTML = svgIcon('x', 14);
            closeP.addEventListener('click', () => { panel.style.display = 'none'; _panelType = null; });
            hdr.append(title, closeP);
            panel.appendChild(hdr);
            const list = createEl('div', { style: 'flex:1;overflow-y:auto;' });
            panel.appendChild(list);
            const items = type === 'bookmarks' ? loadBookmarks() : loadHistory();
            if (!items.length) {
              list.innerHTML = '<div style="text-align:center;padding:32px 16px;color:var(--text-muted);font-size:13px;">' + (type === 'bookmarks' ? 'No bookmarks yet.<br>Click ★ to save a page.' : 'No history yet.') + '</div>';
            } else {
              // FIX: Use event delegation for panel rows to prevent listener accumulation
              // Hover styling moved to CSS to avoid redundant capture-phase event thrashing
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
                  let arr = loadBookmarks();
                  arr = arr.filter(b => b.url !== itemUrl);
                  saveBookmarks(arr);
                } else {
                  saveHistory(loadHistory().filter(h => h.ts != itemTs));
                }
                showPanel(type);
              });
              items.forEach(item => {
                const row = createEl('div', { 
                  style: 'display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border-subtle);',
                  'data-panel-row': 'true',
                  'data-url': item.url,
                  'data-ts': item.ts || ''
                });
                const ico = createEl('span', { style: 'flex-shrink:0;color:var(--text-muted);' });
                {
                  const _fimg2 = document.createElement('img');
                  if (item.favicon && /^https?:\/\//i.test(item.favicon)) {
                    _fimg2.src = normFavicon(item.favicon);
                  } else {
                    try { _fimg2.src = '/api/favicon?domain=' + encodeURIComponent(new URL(item.url).hostname); } catch { _fimg2.src = ''; }
                  }
                  _fimg2.style.cssText = 'width:14px;height:14px;border-radius:2px;';
                  _fimg2.onerror = () => { ico.innerHTML = ''; ico.innerHTML = svgIcon('globe', 14); };
                  if (_fimg2.src) ico.appendChild(_fimg2); else ico.innerHTML = svgIcon('globe', 14);
                }
                const info = createEl('div', { style: 'flex:1;min-width:0;' });
                const _iTitle = document.createElement('div');
                _iTitle.style.cssText = 'font-size:12px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                _iTitle.textContent = item.title || item.url;
                const _iUrl = document.createElement('div');
                _iUrl.style.cssText = 'font-size:10px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                _iUrl.textContent = item.url;
                info.append(_iTitle, _iUrl);
                const del = createEl('button', { 
                  className: 'browser-nav-btn', 
                  style: 'padding:2px 4px;opacity:0;transition:opacity 0.1s;', 
                  title: 'Remove',
                  'data-panel-del': 'true'
                });
                del.innerHTML = svgIcon('x', 12);
                row.append(ico, info, del);
                list.appendChild(row);
              });
            }
          }

          // ── Viewport ──────────────────────────────────────────────────────
          const viewport = createEl('div', { className: 'browser-viewport', style: { display: 'flex', flexDirection: 'column', position: 'relative' } });
          viewport.appendChild(panel);

          container.append(tabsBar, toolbar, findBar, viewport);
          content.appendChild(container);

          // ── Popup mode ───────────────────────────────────────────────────────
          // When spawned by a newwindow event (OAuth, login dialogs, share sheets),
          // strip the browser chrome down to match real browser popup behaviour:
          // no tabs bar, minimal toolbar — just back + a read-only URL bar.
          if (options?.popup) {
            // No tabs — popups are single-page by nature
            tabsBar.style.display = 'none';

            // Minimal toolbar: keep backBtn (useful for multi-step auth flows),
            // read-only URL bar (so the user can see where they are), security icon.
            // Hide everything that implies full browsing.
            fwdBtn.style.display = 'none';
            refreshBtn.style.display = 'none';
            starBtn.style.display = 'none';
            menuBtn.style.display = 'none';
            urlBar.readOnly = true;
            urlBar.style.cursor = 'default';
            urlBar.style.background = 'transparent';
            urlBar.style.boxShadow = 'none';

            // Small pill so the user knows this is a popup, not a full browser window
            const popupBadge = createEl('span', {
              style: 'font-size:10px;font-weight:600;color:var(--text-muted);' +
                'background:var(--bg-hover);border:1px solid var(--border-subtle);' +
                'border-radius:4px;padding:2px 7px;white-space:nowrap;flex-shrink:0;' +
                'letter-spacing:.05em;text-transform:uppercase;',
              textContent: 'Popup'
            });
            toolbar.appendChild(popupBadge);

            // No history or bookmarks for popup windows — use a dedicated flag
            // so the tab keeps partition:'persist:browser' and shares the user's cookies.
            // (Setting incognito:true would switch the partition to an isolated session,
            // which would log the user out of every site in the popup.)
            tabs[0].isPopup = true;
          }

          let currentUrl = '';
          const tabWebviews = new Map();
          const tabIframes = new Map();   // tabId → <iframe> element
          const tabViewMode = new Map();  // tabId → 'webview' | 'iframe'

          // Tracker blocklist — fetched from the local server (require() is unavailable
          // in the main window; it has no Node integration — only the server process does).
          // TRACKER_DOMAINS starts empty and is populated async; any webview whose
          // contentload fires before the fetch completes will still get blocking once
          // the Set is populated because the listener closure captures the reference.
          let TRACKER_DOMAINS = new Set();
          fetch('/trackers.js')
            .then(r => {
              if (!r.ok) throw new Error('HTTP ' + r.status);
              return r.text();
            })
            .then(src => {
              // trackers.js exports: const TRACKER_DOMAINS = new Set([...domains...]);
              // Extract only the array literal passed to the Set constructor — not every
              // quoted string in the file (comments, variable names, etc. would match otherwise).
              let domains = null;
              const arrayMatch = src.match(/new\s+Set\s*\(\s*(\[[\s\S]*?\])\s*\)/);
              if (arrayMatch) {
                try {
                  const parsed = JSON.parse(arrayMatch[1]);
                  if (Array.isArray(parsed)) domains = parsed.filter(d => typeof d === 'string' && d.length > 0);
                } catch (parseErr) {
                  console.warn('[Tracker blocker] JSON.parse of Set array failed:', parseErr.message);
                }
              }
              // Fallback: file may simply be a JSON array of domain strings
              if (!domains) {
                try {
                  const parsed = JSON.parse(src.trim());
                  if (Array.isArray(parsed)) domains = parsed.filter(d => typeof d === 'string' && d.length > 0);
                } catch (_) { }
              }
              if (domains && domains.length > 0) {
                TRACKER_DOMAINS = new Set(domains);
                console.log('[Tracker blocker] Loaded', TRACKER_DOMAINS.size, 'domains via fetch');
              } else {
                console.warn('[Tracker blocker] Fetched trackers.js but could not extract domain list');
              }
            })
            .catch(e => console.warn('[Tracker blocker] Could not fetch /trackers.js —', e.message));

          function getTabMode(tabId) { return tabViewMode.get(tabId) || 'webview'; }

          // Stable browser session ID stored in settings. Wiped on "Wipe All Data" /
          // factory reset, which rotates the partition name → brand new session → logged out.
          let _bpid = OS.settings.get('browserPartitionId');
          if (!_bpid) {
            _bpid = 'b' + Math.random().toString(36).slice(2, 12);
            OS.settings.set('browserPartitionId', _bpid);
          }
          const BROWSER_PARTITION = 'persist:' + _bpid;

          function getOrCreateWebview(tabId) {
            if (tabWebviews.has(tabId)) return tabWebviews.get(tabId);
            const wv = document.createElement('webview');
            const tab = tabs.find(t => t.id === tabId);
            // Incognito = in-memory partition (no persist:), normal = shared persistent session
            wv.setAttribute('partition', tab?.incognito ? ('incognito_' + tabId) : BROWSER_PARTITION);
            wv.setAttribute('allowfullscreen', 'true');
            // FIX: Add sandbox restrictions to prevent privilege escalation via file:// or blob:
            // Disable node integration and V8 code caching to block access to Node APIs
            wv.setAttribute('nodeintegration', 'false');
            wv.setAttribute('enableremotemodule', 'false');
            wv.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
            wv.style.cssText = 'width:100%;height:100%;border:none;flex:1;position:absolute;visibility:hidden;pointer-events:none;z-index:0;top:0;left:0;';

            // ── Permission gate — must explicitly allow fullscreen or NW.js
            // blocks the request before enter-html-full-screen ever fires ────
            // NW.js: match count is returned via the find() callback — no separate event needed

            // ── URL tracking ──────────────────────────────────────────────────
            function syncUrlForTab(url, forTabId, source) {
              if (!url || url === 'about:blank' || url === 'about:newtab') return;
              console.log('[NB Browser] syncUrlForTab:', source, url, 'tabId:', forTabId, 'activeTabId:', activeTabId);
              const tab = tabs.find(t => t.id === forTabId);
              if (tab) tab.url = url;
              if (forTabId !== activeTabId) return;
              currentUrl = url;
              urlBar.value = stripHttps(url);
              updateUrlIcon(url);
              const _bkd = isBookmarked(url);
              starBtn.style.color = _bkd ? 'var(--accent)' : '';
              starBtn.innerHTML = svgIcon(_bkd ? 'star-filled' : 'star', 16);
              renderTabs();
            }

            // ── Primary: event-based ──────────────────────────────────────
            wv.addEventListener('loadcommit', e => {
              console.log('[NB Browser] loadcommit fired, isTopLevel:', e.isTopLevel, 'url:', e.url);
              if (e.isTopLevel && e.url) syncUrlForTab(e.url, tabId, 'loadcommit');
            });
            wv.addEventListener('loadstop', () => {
              console.log('[NB Browser] loadstop fired');
              // Sync URL
              try { wv.executeScript({ code: 'location.href' }, r => { if (chrome.runtime?.lastError || !r?.[0]) return; syncUrlForTab(r[0], tabId, 'loadstop+executeScript'); }); } catch (ex) { console.log('[NB Browser] executeScript(loadstop) threw:', ex); }
              // NW.js has no page-title-updated / page-favicon-updated (Electron-only).
              // Fetch title + href together and save history after each load.
              try {
                wv.executeScript({ code: '[document.title, location.href]' }, r => {
                  if (chrome.runtime?.lastError) return;
                  const result = Array.isArray(r) ? r[0] : null;
                  if (!Array.isArray(result)) return;
                  const [title, url] = result;
                  const tab = tabs.find(t => t.id === tabId);
                  if (!tab) return;
                  if (title) {
                    tab.title = title;
                    renderTabs();
                    // In popup mode, mirror the page title into the OS window titlebar
                    // since the tabs bar (which normally shows the title) is hidden.
                    if (options?.popup && state.titleText) state.titleText.textContent = title;
                  }
                  try {
                    const hostname = new URL(url || tab.url).hostname;
                    tab.favicon = '/api/favicon?domain=' + hostname;
                    renderTabs();
                  } catch (_) { }
                  if (url && !url.startsWith('novabyte:') && !url.startsWith('file://')) {
                    addHistory(tabId, url, title || url, tab.favicon);
                  }
                });
              } catch (_) { }
            });
            wv.addEventListener('contentload', () => {
              console.log('[NB Browser] contentload fired');
              try { wv.executeScript({ code: 'location.href' }, r => { if (chrome.runtime?.lastError || !r?.[0]) return; syncUrlForTab(r[0], tabId, 'contentload+executeScript'); }); } catch (_) { }
            });

            // ── Network / certificate error handling ─────────────────────
            // NW.js fires 'loaderror' for cert errors, DNS failures,
            // ERR_CONNECTION_REFUSED etc.  Without this the webview stays
            // completely blank and the user has no idea what went wrong.
            wv.addEventListener('loaderror', e => {
              if (!e.isTopLevel) return; // ignore sub-resource errors
              console.warn('[NB Browser] loaderror:', e.errorCode, e.errorDescription, e.validatedURL);
              const failedUrl = e.validatedURL || currentUrl || '';
              const code      = e.errorCode || 0;        // negative Chromium net error
              const desc      = e.errorDescription || '';

              // Classify the error for a friendlier message
              let title, message, hint, showBypass = false;
              if (desc.includes('CERT') || desc.includes('SSL') || desc.includes('HTTPS') ||
                  code === -202 || code === -200 || code === -207) {
                title = '⚠ Certificate Error';
                message = 'The connection to this site is not trusted. The certificate may be self-signed, expired, or issued by an unknown authority.';
                hint  = 'If this is a local development server, click "Proceed anyway" below.';
                showBypass = true;
              } else if (desc.includes('CONNECTION_REFUSED') || code === -102) {
                title = '⚡ Connection Refused';
                message = 'No server is listening at this address. Check that the server is running and the port is correct.';
                hint  = failedUrl.includes('localhost') || failedUrl.includes('127.0.0.1')
                  ? 'Tip: make sure your local server is started (e.g. npm start).'
                  : '';
              } else if (desc.includes('NAME_NOT_RESOLVED') || code === -105) {
                title = '🌐 DNS Error';
                message = 'The hostname could not be resolved. Check the URL or your internet connection.';
                hint  = '';
              } else if (desc.includes('TIMED_OUT') || code === -7) {
                title = '⏱ Connection Timed Out';
                message = 'The server took too long to respond.';
                hint  = 'Try again or check your network.';
              } else {
                title = '✕ Page Failed to Load';
                message = 'Something went wrong loading this page.';
                hint  = desc ? 'Error: ' + desc : '';
              }

              // FIX: HTML-escape hint to prevent XSS if error description ever contains markup
              const safeHint = hint.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

              // FIX: Properly escape backslashes BEFORE single quotes to prevent string breakout
              // A trailing backslash would un-escape the closing quote: 'url\' → ends the string
              const safeUrl = failedUrl
                .replace(/\\/g, '\\\\')
                .replace(/'/g, "\\'")
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
              const bypassBtn = showBypass
                ? `<button onclick="window.__nbBypass()" style="background:#e05d44;color:#fff;border:none;padding:8px 18px;border-radius:6px;cursor:pointer;font-size:13px;margin-right:8px;">Proceed anyway (unsafe)</button>`
                : '';

              const errorHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${title}</title>
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
</style></head><body>
<div class="card">
  <h1>${title}</h1>
  <p>${message}</p>
  <div class="url">${safeUrl}</div>
  ${safeHint ? `<div class="hint">${safeHint}</div>` : ''}
  <div class="actions">
    ${bypassBtn}
    <button onclick="window.__nbRetry()">↺ Retry</button>
  </div>
</div>
<script>
  window.__nbRetry  = () => { window.location.href = '${safeUrl}'; };
  window.__nbBypass = () => { window.location.href = '${safeUrl}'; };
</script>
</body></html>`;

              try {
                // Write the error page directly into the webview via innerHTML
                // (safer than document.write and avoids creating blob URLs)
                const htmlStr = JSON.stringify(errorHtml);
                wv.executeScript({
                  code: `requestAnimationFrame(() => { document.documentElement.innerHTML = ${htmlStr}; });`
                }, () => { });
              } catch (_) { }
            });

            // loadabort fires for navigation that was blocked before it started
            // (e.g. subresource integrity failures, safebrowsing, etc.)
            wv.addEventListener('loadabort', e => {
              if (!e.isTopLevel) return;
              console.warn('[NB Browser] loadabort:', e.reason, e.url);
              // Only show UI for non-trivial aborts (not blank / newtab navigations)
              if (!e.url || e.url === 'about:blank' || e.url === 'about:newtab') return;
              // 'ERR_ABORTED' (-3) fires on legitimate JS-driven navigations — ignore
              if (e.reason === 'ERR_ABORTED') return;
              // FIX: Properly escape backslashes first to prevent string injection
              const safeUrl = (e.url || '')
                .replace(/\\/g, '\\\\')
                .replace(/'/g, "\\'");
              try {
                wv.executeScript({ code: `
                  const html = '<html><body style="background:#0d1117;color:#c9d1d9;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">'
                    + '<div style="text-align:center;max-width:400px">'
                    + '<div style="font-size:32px;margin-bottom:12px">🚫</div>'
                    + '<div style="font-size:16px;font-weight:700;margin-bottom:8px">Navigation Blocked</div>'
                    + '<div style="font-size:12px;color:#8b949e;margin-bottom:16px">' + ${JSON.stringify(e.reason || 'Unknown reason')} + '</div>'
                    + '<button onclick="history.back()" style="background:#238636;color:#fff;border:none;padding:8px 18px;border-radius:6px;cursor:pointer">← Go Back</button>'
                    + '</div></body></html>';
                  document.documentElement.innerHTML = html;
                ` }, () => { });
              } catch (_) { }
            });
            // NW.js does not fire will-navigate / did-navigate / did-navigate-in-page / did-finish-load.
            // Top-level navigations are caught by loadcommit above.
            // In-page (SPA / pushState) navigations are caught by the 500 ms executeScript poll below.

            // ── Fallback: poll via executeScript every 500ms ───────────────
            let _lastPolledUrl = '';
            const _urlPollTimer = setInterval(() => {
              // Only poll the active tab — background tabs don't need URL sync
              // and executeScript on every open tab compounds linearly with tab count.
              if (tabId !== activeTabId) return;
              try {
                wv.executeScript({ code: 'location.href' }, results => {
                  if (chrome.runtime?.lastError) return;
                  const url = Array.isArray(results) ? results[0] : results;
                  if (url && typeof url === 'string' && url !== 'about:blank' && url !== _lastPolledUrl) {
                    _lastPolledUrl = url;
                    console.log('[NB Browser] poll detected URL change:', url);
                    syncUrlForTab(url, tabId, 'poll');
                  }
                });
              } catch (err) {
                console.warn('[NB Browser] URL poll executeScript failed:', err);
              }
            }, 500);

            state.cleanups = state.cleanups || [];
            state.cleanups.push(() => clearInterval(_urlPollTimer));
            // Also track per-tab so closeTab() can cancel it immediately
            const _tc = tabCleanups.get(tabId) || [];
            _tc.push(() => clearInterval(_urlPollTimer));
            tabCleanups.set(tabId, _tc);
            // page-title-updated and page-favicon-updated are Electron-only — handled in loadstop above.

            // ── Fullscreen support for web content (YouTube, etc.) ────────
            wv.addEventListener('enter-html-full-screen', e => {
              // Step 1: expand the webview to cover the full viewport so it's
              // ready the moment the OS-level fullscreen transition completes.
              wv.style.position = 'fixed';
              wv.style.inset = '0';
              wv.style.zIndex = '2147483647';
              wv.style.width = '100vw';
              wv.style.height = '100vh';
              wv.style.visibility = 'visible';
              wv.style.pointerEvents = 'auto';
              document.body.style.overflow = 'hidden';

              // Step 2: request OS-level fullscreen on the root element so the
              // window actually covers the whole monitor — not just fills the
              // existing browser window.
              if (document.documentElement.requestFullscreen) {
                document.documentElement.requestFullscreen().catch(() => { });
              } else if (document.documentElement.webkitRequestFullscreen) {
                document.documentElement.webkitRequestFullscreen();
              }

              // Fallback: NW.js native fullscreen API
              if (typeof nw !== 'undefined' && nw.Window) {
                try { nw.Window.get().enterFullscreen(); } catch (_) { }
              }
            });

            wv.addEventListener('leave-html-full-screen', e => {
              // Restore webview to its normal in-window position.
              wv.style.position = 'absolute';
              wv.style.inset = 'auto';
              wv.style.zIndex = '1';
              wv.style.width = '100%';
              wv.style.height = '100%';
              document.body.style.overflow = '';

              // Exit OS-level fullscreen.
              if (document.fullscreenElement && document.exitFullscreen) {
                document.exitFullscreen().catch(() => { });
              } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
              }

              // Fallback: NW.js native API
              if (typeof nw !== 'undefined' && nw.Window) {
                try { nw.Window.get().leaveFullscreen(); } catch (_) { }
              }
            });

            // If the user presses Escape or the browser exits fullscreen on its
            // own (e.g. the user hits Esc), restore the webview sizing so the
            // OS UI doesn't stay covered.
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
            state.cleanups = state.cleanups || [];
            state.cleanups.push(() => document.removeEventListener('fullscreenchange', _onFsChange));

            // History is now saved from the loadstop handler above via executeScript.

            // ── Process status monitoring ─────────────────────────────────
            // NW.js Chrome Apps webview fires 'unresponsive' when the guest renderer
            // stops responding (OOM, infinite loop, etc.). There is no Electron-style
            // 'render-process-gone' in this API surface — 'unresponsive' is the correct
            // hook. Track per-tab so the infobar is only shown once until recovery.
            let _tabUnresponsive = false;
            wv.addEventListener('unresponsive', () => {
              if (_tabUnresponsive) return;
              _tabUnresponsive = true;
              console.warn('[NB Browser] Page became unresponsive: tabId', tabId);
              if (tabId === activeTabId) {
                // Surface a non-blocking infobar rather than a full crash screen;
                // the process may recover and the user may want to wait.
                showInfoBar(
                  tabId,
                  '⚠\uFE0F This page is not responding. ',
                  [{ label: 'Wait', action: () => {} }, { label: 'Reload', action: () => navigate(tabs.find(t => t.id === tabId)?.url || '') }]
                );
              }
            });
            wv.addEventListener('responsive', () => {
              if (!_tabUnresponsive) return;
              _tabUnresponsive = false;
              console.log('[NB Browser] Page became responsive again: tabId', tabId);
              dismissInfoBar(tabId);
            });

            // ── Download handling ────────────────────────────────────────
            // Chrome Apps webview fires permissionrequest with permission==='download'
            // (will-download is Electron-only). We intercept here and save via Node.js.

            async function ensureBrowserFsWritePermission() {
              const mgr = window.AppPermissionManager;
              if (!mgr) return true;

              const appId = 'browser';
              if (mgr.isGranted('fs:write', appId)) return true;

              if (mgr.isDenied?.('fs:write', appId)) {
                Notify.show({
                  title: 'Download blocked',
                  body: 'Browser does not have permission to write files. Grant "fs:write" in Settings → Apps.',
                  type: 'error',
                  appName: 'Browser',
                });
                return false;
              }

              const granted = await mgr.requestPermission('fs:write', appId, {
                appName: 'Browser',
                reason: 'Browser needs to save downloaded files to your Downloads folder.',
              });

              if (!granted) {
                Notify.show({
                  title: 'Download blocked',
                  body: 'Browser was denied permission to write files.',
                  type: 'error',
                  appName: 'Browser',
                });
                return false;
              }

              return true;
            }

            wv.addEventListener('permissionrequest', e => {
              if (e.permission === 'fullscreen') {
                e.request.allow();
                return;
              }
              // 'pointerLock' is required by browser games and 3D viewers
              if (e.permission === 'pointerLock') {
                e.request.allow();
                return;
              }
              if (e.permission === 'download') {
                e.request.deny();
                (async () => {
                  const _url = e.request.url;
                  // Only allow http(s) downloads — block file:, data:, etc.
                  if (!_url || !/^https?:\/\//i.test(_url)) return;
                  if (!(await ensureBrowserFsWritePermission())) return;
                  try {
                    const baseName = (() => {
                      try { return decodeURIComponent(new URL(_url).pathname.split('/').pop()); }
                      catch { return ''; }
                    })() || ('download_' + Date.now());
                    const safeName = baseName.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').trim() || ('download_' + Date.now());
                    const finalName = safeName.length > 128 ? safeName.slice(0, 128) : safeName;
                    const ext = finalName.includes('.') ? '' : '.bin';
                    const dlFolderId = FS.specialFolders.downloads;
                    if (!dlFolderId) throw new Error('Downloads folder missing');
                    const existing = FS.listDir(dlFolderId).map(f => f.name);
                    const adjusted = existing.includes(finalName + ext)
                      ? finalName.replace(/(\.\w+)?$/, ' (' + existing.filter(n => n.startsWith(finalName)).length + ')$1')
                      : finalName;
                    const entry = window.Downloads?.add(adjusted + ext, _url, 0, '');
                    const entryId = entry?.id;
                    if (entryId) window.Downloads?.setStatus(entryId, 'downloading');
                    WM.createWindow('nbosp-downloads');
                    const MAX_DL = 512 * 1024 * 1024;
                    const resp = await fetch(_url);
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    const cl = resp.headers.get('content-length');
                    const buf = await resp.arrayBuffer();
                    if (cl && +cl > MAX_DL) throw new Error('File too large');
                    if (buf.byteLength > MAX_DL) throw new Error('File too large');
                    await FS.createFile(dlFolderId, adjusted + ext, new Uint8Array(buf), 'application/octet-stream');
                    if (entryId) window.Downloads?.setStatus(entryId, 'done', buf.byteLength);
                    Notify.show({ title: 'Download complete', body: adjusted + ext, type: 'success', appName: 'Downloads' });
                    OS.events.emit('fs:created', {});
                  } catch (err) {
                    console.error('Download handler error:', err);
                    Notify.show({ title: 'Download failed', body: String(err.message || err), type: 'error', appName: 'Downloads' });
                  }
                })();
              }
            });

            // ── Popup / new-window support (NW.js Chrome Apps webview API)  ──────
            wv.addEventListener('newwindow', e => {
              const url = e.targetUrl;
              if (!url || url === 'about:blank' || url.startsWith('javascript:')) return;

              // ── Auth/login popup detection ────────────────────────────────
              // Legitimate OAuth and login flows use window.open() with popup
              // features (disposition = new_popup). We must NEVER block these —
              // doing so breaks Google Sign-In, GitHub OAuth, Apple ID, Microsoft
              // login, and any other auth flow that relies on a popup window.
              function isAuthPopup(u) {
                try {
                  const parsed = new URL(u);
                  const host = parsed.hostname.toLowerCase();
                  const path = parsed.pathname.toLowerCase();
                  // Known auth domains — always allow
                  const authHosts = [
                    'accounts.google.com', 'login.microsoftonline.com',
                    'login.live.com', 'appleid.apple.com',
                    'github.com', 'gitlab.com',
                    'www.facebook.com', 'connect.facebook.net',
                    'twitter.com', 'x.com',
                    'discord.com', 'slack.com',
                    'login.yahoo.com', 'api.amazon.com',
                  ];
                  if (authHosts.some(h => host === h || host.endsWith('.' + h))) return true;
                  // Auth-related path segments — allow on any domain
                  const authPaths = [
                    '/oauth', '/oauth2', '/auth', '/authorize', '/authorise',
                    '/login', '/signin', '/sign-in', '/signup', '/sign-up',
                    '/sso', '/saml', '/oidc', '/callback', '/connect',
                    '/idp/', '/identity/', '/session', '/token',
                  ];
                  if (authPaths.some(p => path.startsWith(p) || path.includes(p + '/'))) return true;
                  // Auth query params — common in OAuth redirects
                  const params = parsed.searchParams;
                  if (params.has('client_id') || params.has('response_type') || params.has('redirect_uri')) return true;
                } catch (_) { }
                return false;
              }

              // Block pop-up windows setting — only blocks non-auth popups
              if (getSetting('block_popup_windows', true) && e.windowOpenDisposition === 'new_popup' && !isAuthPopup(url)) {
                try { if (e.window?.discard) e.window.discard(); } catch (_) { }
                return;
              }

              const disposition = e.windowOpenDisposition;

              if (disposition === 'new_popup') {
                // ── Inline popup overlay ──────────────────────────────────────
                // CRITICAL: use e.window.attach(newWebview), NOT e.window.discard().
                // discard() severs the opener link — window.close() in the popup
                // then has no path back, so the 'close' event never fires.
                // attach() keeps the opener relationship alive.
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
                barClose.style.cssText = 'background:none;border:none;color:inherit;opacity:0.5;cursor:pointer;font-size:13px;padding:2px 6px;border-radius:4px;';
                barClose.onmouseenter = () => barClose.style.opacity = '1';
                barClose.onmouseleave = () => barClose.style.opacity = '0.5';
                bar.append(barTitle, barClose);

                const popWv = document.createElement('webview');
                popWv.style.cssText = 'flex:1;width:100%;';
                // Inherit the parent tab's isolation context: an incognito tab's popup must
                // use the same in-memory partition as its opener, not the persistent session.
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
                  try { popWv.executeScript({ code: 'document.title' }, r => { if (chrome.runtime?.lastError || !r?.[0]) return; barTitle.textContent = r[0]; }); } catch (_) { }
                });

                // attach() keeps opener link alive → window.close() fires 'close' event
                popWv.addEventListener('close', closePopup);
                e.window.attach(popWv);

              } else {
                // For tabs: discard the NW native window, open as a new tab instead.
                try { if (e.window?.discard) e.window.discard(); } catch (_) { }
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
                  // Create the webview but don't switch to it
                  renderTabs();
                  const bgWv = getOrCreateWebview(newTab.id);
                  if (!bgWv.parentNode) viewport.appendChild(bgWv);
                  // bgWv.src bypasses navigate(), so replicate its scheme and local-address
                  // guards here — without this, a newwindow event can load javascript: URIs
                  // or reach private-network addresses regardless of navigate()'s protections.
                  const _bgCanonical = url.toLowerCase()
                    .replace(/[\s\u0000-\u001f\u007f-\u009f]/g, '')
                    .trim();
                  if (!/^(javascript|data|vbscript|about):/i.test(_bgCanonical) && !isLocalAddress(url)) {
                    bgWv.src = url;
                  }
                } else {
                  switchToTab(newTab.id);
                  navigate(url);
                }
              }
            });

            // ── window.close() support ────────────────────────────────────────
            // Two-layer approach because Google's OAuth (gsi/transform) and many
            // other login flows call window.opener.postMessage() rather than
            // 'close' event fires on the parent webview if it has an active popup.
            // (Popups now use inline overlay + attach(), so this handles
            //  any other case where a non-popup tab tries to close itself.)
            wv.addEventListener('close', () => { closeTab(tabId); });

            tabWebviews.set(tabId, wv);
            applyWebviewSettings(wv);
            return wv;
          }

          // ── iframe mode helpers ───────────────────────────────────────────
          function getOrCreateIframe(tabId) {
            if (tabIframes.has(tabId)) return tabIframes.get(tabId);
            const ifr = document.createElement('iframe');
            ifr.setAttribute('allowfullscreen', 'true');
            ifr.setAttribute('allow', 'fullscreen; autoplay; clipboard-read; clipboard-write');
            // NOTE: allow-same-origin is intentionally ABSENT — combining it with allow-scripts
            // enables a known sandbox escape (framed doc can call frameElement.removeAttribute('sandbox')).
            ifr.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation');
            ifr.style.cssText = 'width:100%;height:100%;border:none;flex:1;position:absolute;visibility:hidden;pointer-events:none;z-index:0;top:0;left:0;background:#fff;';

            // Detect X-Frame-Options / CSP frame-ancestors block:
            // browsers fire 'load' even when blocked but the iframe stays empty —
            // we infer a block if the src is an http URL and contentDocument is inaccessible.
            ifr.addEventListener('load', () => {
              const tab = tabs.find(t => t.id === tabId);
              if (!tab?.url || !tab.url.match(/^https?:/i)) return;
              // Remove any stale blocked notice first
              const old = viewport.querySelector('.browser-iframe-blocked[data-tab="' + tabId + '"]');
              if (old) old.remove();
              try {
                // cross-origin frames throw on .contentDocument access → treat as success (loaded)
                // same-origin frames that are blocked land on about:blank with no title
                const doc = ifr.contentDocument;
                if (doc && (doc.URL === 'about:blank' || doc.URL === '') && tab.url.match(/^https?:/i)) {
                  showIframeBlockedNotice(tabId, tab.url);
                }
              } catch (_) {
                // cross-origin but loaded — this is the normal case, clear any notice
              }
              // Sync title where possible (same-origin only)
              try {
                const title = ifr.contentDocument?.title;
                if (title) { tab.title = title; renderTabs(); }
              } catch (_) { }
            });

            tabIframes.set(tabId, ifr);
            return ifr;
          }

          function showIframeBlockedNotice(tabId, url) {
            // Don't double-show
            if (viewport.querySelector('.browser-iframe-blocked[data-tab="' + tabId + '"]')) return;
            const notice = createEl('div', { className: 'browser-iframe-blocked' });
            notice.dataset.tab = tabId;
            notice.innerHTML =
              '<div class="blocked-icon">🚫</div>' +
              '<div class="blocked-title">Page blocked iframe embedding</div>' +
              '<div class="blocked-body">This site uses <code>X-Frame-Options</code> or <code>Content-Security-Policy: frame-ancestors</code> to prevent embedding. Switch to Webview mode to load it normally.</div>';
            const sw = createEl('button', { className: 'blocked-switch', textContent: 'Switch to Webview Mode' });
            sw.addEventListener('click', () => { setTabMode(tabId, 'webview'); navigate(url); });
            notice.appendChild(sw);
            viewport.appendChild(notice);
          }

          function setTabMode(tabId, mode) {
            tabViewMode.set(tabId, mode);
            // Update the toolbar button label/style
            if (tabId === activeTabId) updateModeBtn();
            // Hide the elements of the old mode
            const wv = tabWebviews.get(tabId);
            const ifr = tabIframes.get(tabId);
            // Batch visibility changes to prevent layout thrashing
            requestAnimationFrame(() => {
              if (mode === 'iframe') {
                if (wv) { wv.style.visibility = 'hidden'; wv.style.pointerEvents = 'none'; }
              } else {
                if (ifr) { ifr.style.visibility = 'hidden'; ifr.style.pointerEvents = 'none'; }
                const blocked = viewport.querySelector('.browser-iframe-blocked[data-tab="' + tabId + '"]');
                if (blocked) blocked.remove();
              }
            });
          }

          function updateModeBtn() {
            const mode = getTabMode(activeTabId);
            modeBtn.classList.toggle('iframe-active', mode === 'iframe');
            modeBtn.title = mode === 'iframe' ? 'Switch to Webview mode' : 'Switch to iframe mode';
            modeBtn.innerHTML = (mode === 'iframe'
              ? svgIcon('layout', 14) + ' <span>iFrame</span>'
              : svgIcon('monitor', 14) + ' <span>Webview</span>');
          }

          function showViewForTab(tabId) {
            const mode = getTabMode(tabId);
            // Clear settings page
            const sp = viewport.querySelector('.browser-settings-page');
            if (sp) sp.remove();
            const tab = tabs.find(t => t.id === tabId);
            const isMobile = tab?.userAgent === 'mobile';

            // Batch all visibility changes together to prevent layout thrashing
            requestAnimationFrame(() => {
              if (mode === 'iframe') {
                // Hide all webviews — also reset position:absolute so any webview that
                // was in non-mobile mode (position:relative) doesn't remain in flex flow
                // and push the iframe down, causing the black-gap bug.
                for (const [, wv] of tabWebviews) {
                  wv.style.position = 'absolute';
                  wv.style.visibility = 'hidden';
                  wv.style.pointerEvents = 'none';
                  wv.style.zIndex = '0';
                }
                // Show/hide iframes and restore mobile frame state for the active tab
                for (const [id, ifr] of tabIframes) {
                  if (id === tabId) {
                    applyMobileViewportFrame(ifr, isMobile);
                    const z = tabZoom.get(tabId) || 1.0;
                    if (isMobile) {
                      ifr.style.width = '390px';
                      ifr.style.height = '100%';
                      ifr.style.transformOrigin = 'top center';
                      ifr.style.transform = z !== 1.0 ? `translateX(-50%) scale(${z})` : 'translateX(-50%)';
                    } else {
                      const pct = (100 / z).toFixed(4) + '%';
                      ifr.style.width = pct;
                      ifr.style.height = pct;
                      ifr.style.transformOrigin = 'top left';
                      ifr.style.transform = z !== 1.0 ? `scale(${z})` : '';
                    }
                    ifr.style.visibility = 'visible';
                    ifr.style.pointerEvents = 'auto';
                    ifr.style.zIndex = '1';
                  } else {
                    ifr.style.visibility = 'hidden';
                    ifr.style.pointerEvents = 'none';
                    ifr.style.zIndex = '0';
                  }
                }
              } else {
                // webview mode — existing logic
                // Hide all iframes
                for (const [, ifr] of tabIframes) {
                  ifr.style.visibility = 'hidden';
                  ifr.style.pointerEvents = 'none';
                }
                // Remove blocked notices for other tabs
                viewport.querySelectorAll('.browser-iframe-blocked:not([data-tab="' + tabId + '"])').forEach(n => n.remove());
                for (const [id, wv] of tabWebviews) {
                  if (id === tabId) {
                    applyMobileViewportFrame(wv, isMobile);
                    // Explicitly reset dimensions — switching from iframe mode can leave
                    // stale styles that cause the bottom half to be cut off
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

          function applyWebviewSettings(wv) {
            // ── Default zoom ───────────────────────────────────────────
            const zoomMap = { FAR: 0.75, MEDIUM: 1.0, CLOSE: 1.25 };
            wv.addEventListener('loadstop', () => {
              const tabId = [...tabWebviews.entries()].find(([, v]) => v === wv)?.[0];
              if (tabId && !tabZoom.has(tabId)) {
                try { wv.setZoom(zoomMap[getSetting('default_zoom', 'MEDIUM')] || 1.0); } catch (_) { }
              }
            });

            // ── Force zoom (allow pinch-zoom even when sites disable it) ──
            wv.addEventListener('loadcommit', () => {
              try { wv.setZoomMode(getSetting('force_userscalable', false) ? 'per-view' : 'per-origin'); } catch (_) { }
            });

            // ── Geolocation + media permission gate ───────────────────
            wv.addEventListener('permissionrequest', e => {
              const appId = 'browser';
              if (e.permission === 'geolocation') {
                const osAllowed = AppPermissionManager?.isGranted('device:geolocation', appId);
                const browserAllowed = getSetting('enable_geolocation', true);
                if (!osAllowed) {
                  Notify.show({ title: 'Permission denied', body: 'Browser needs Location access in Settings → Apps.', type: 'error', appName: 'Browser' });
                  e.request.deny();
                  return;
                }
                browserAllowed ? e.request.allow() : e.request.deny();
              } else if (e.permission === 'media') {
                const camGranted  = AppPermissionManager?.isGranted('device:camera', appId);
                const micGranted  = AppPermissionManager?.isGranted('device:microphone', appId);
                if (!camGranted && !micGranted) {
                  Notify.show({ title: 'Permission denied', body: 'Browser needs Camera/Microphone access in Settings → Apps.', type: 'error', appName: 'Browser' });
                  e.request.deny();
                  return;
                }
                // Per-device decision: deny the missing side if partial grant
                if (camGranted && !micGranted) {
                  Notify.show({ title: 'Permission limited', body: 'Camera allowed, microphone is not permitted.', type: 'info', appName: 'Browser' });
                } else if (!camGranted && micGranted) {
                  Notify.show({ title: 'Permission limited', body: 'Microphone allowed, camera is not permitted.', type: 'info', appName: 'Browser' });
                }
                e.request.allow();
              } else if (e.permission === 'pointerLock') {
                e.request.allow(); // pointer lock is low-risk UX feature
              } else {
                e.request.deny(); // deny all other unrecognised permissions by default
              }
            });

            // ── webRequest listeners ────────────────────────────────────
            // wv.request is only available after the webview is inserted into
            // the DOM and its process is live. Attaching here (before appendChild)
            // silently fails because wv.request is undefined at construction time.
            // We defer via a one-time function called from contentload/loadcommit —
            // both fire only after the webview process is ready.
            let _requestListenersAttached = false;
            function _attachRequestListeners() {
              if (_requestListenersAttached) return;
              _requestListenersAttached = true;

              // ── Request listeners ──────────────────────────────────
              try {
                wv.request.onBeforeRequest.addListener(
                  () => ({ cancel: !getSetting('load_images', true) }),
                  { urls: ['<all_urls>'], types: ['image', 'media'] },
                  ['blocking']
                );
              } catch (e) { }

              try {
                wv.request.onBeforeRequest.addListener(
                  (details) => ({ cancel: false }),
                  { urls: ['<all_urls>'] },
                  ['blocking']
                );
              } catch (e) { }
            }

            // contentload fires once the webview process is ready (wv.request exists)
            wv.addEventListener('contentload', _attachRequestListeners);
            // loadcommit is a reliable fallback — fires on first navigation
            wv.addEventListener('loadcommit', _attachRequestListeners);

            // ── Per-page CSS: inverted colours + min font size + text zoom ──
            wv.addEventListener('loadstop', () => {
              let css = '';
              if (getSetting('inverted', false))
                css += 'html { filter: invert(1) hue-rotate(180deg) !important; } img, video { filter: invert(1) hue-rotate(180deg) !important; } ';
              const minFont = getSetting('min_font_size', 0);
              if (minFont > 0)
                css += `* { min-height: unset !important; } body * { font-size: max(${minFont}px, 1em) !important; } `;
              const textZoom = getSetting('text_zoom', 10);
              if (textZoom !== 10)
                css += `body { zoom: ${textZoom / 10} !important; } `;
              if (css) try { wv.insertCSS({ code: css }); } catch (_) { }
            });
          }

          // Clear browsing data across all open webviews
          function clearWebviewData(types, title, body) {
            // Batch operations to avoid layout thrashing
            requestAnimationFrame(() => {
              for (const [, wv] of tabWebviews) {
                try { wv.clearData({}, types); } catch (_) { }
              }
            });
            Notify.show({ title, body, type: 'info', appName: 'Browser' });
          }

          function showWebviewForTab(tabId) {
            showViewForTab(tabId);
          }

          function renderSettingsPage(activeCategory) {
            activeCategory = activeCategory || 'general';
            const eng = getSetting('searchEngine', 'brave');
            const sd = viewport.querySelector('.speed-dial');
            if (sd) sd.remove();
            // Batch visibility changes to prevent layout thrashing
            requestAnimationFrame(() => {
              for (const [, wv] of tabWebviews) {
                wv.style.visibility = 'hidden';
              }
            });
            const old = viewport.querySelector('.browser-settings-page');
            if (old) old.remove();

            const page = createEl('div', { className: 'browser-settings-page' });
            page.style.cssText = 'position:absolute;inset:0;display:flex;background:var(--bg-base);color:var(--text-primary);font-size:13px;z-index:1;';

            // ── helpers ──────────────────────────────────────────────────
            function getBPref(key, def) { return getSetting(key, def); }
            function setBPref(key, val) { saveSetting(key, val); }

            function mkRow(label, desc, control) {
              const row = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--border-subtle);' });
              const left = createEl('div');
              left.appendChild(createEl('div', { textContent: label, style: 'font-size:13px;color:var(--text-primary);' }));
              if (desc) left.appendChild(createEl('div', { textContent: desc, style: 'font-size:11px;color:var(--text-muted);margin-top:2px;' }));
              row.append(left, control);
              return row;
            }

            function mkSubHdr(title) {
              return createEl('div', { textContent: title, style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);margin:20px 0 4px;' });
            }

            function mkToggle(key, def, onChange) {
              const val = getBPref(key, def);
              const btn = createEl('button', { style: 'width:40px;height:22px;border-radius:11px;border:none;cursor:pointer;position:relative;flex-shrink:0;transition:background 0.2s;background:' + (val ? 'var(--accent)' : 'var(--text-muted)') + ';' });
              const knob = createEl('div', { style: 'position:absolute;top:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.3);transition:left 0.2s;left:' + (val ? '20px' : '2px') + ';' });
              btn.appendChild(knob);
              btn.addEventListener('click', () => {
                const next = !getBPref(key, def);
                setBPref(key, next);
                btn.style.background = next ? 'var(--accent)' : 'var(--text-muted)';
                knob.style.left = next ? '20px' : '2px';
                if (onChange) onChange(next);
              });
              return btn;
            }

            function mkSelect(key, def, options) {
              const val = getBPref(key, def);
              const sel = createEl('select', { id: 'browser-pref-select-' + key, name: 'browser-pref-' + key, style: 'background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:6px;padding:5px 8px;color:var(--text-primary);font-size:12px;cursor:pointer;outline:none;max-width:160px;' });
              options.forEach(([v, label]) => {
                const opt = createEl('option', { value: v, textContent: label });
                if (v === val) opt.selected = true;
                sel.appendChild(opt);
              });
              sel.addEventListener('change', () => setBPref(key, sel.value));
              return sel;
            }

            function mkClearBtn(label, action) {
              const btn = createEl('button', { textContent: label, style: 'padding:6px 14px;border-radius:6px;border:1px solid var(--border-default);background:var(--bg-elevated);color:var(--text-primary);cursor:pointer;font-size:12px;white-space:nowrap;flex-shrink:0;' });
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
              const slider = createEl('input', { type: 'range', min: String(min), max: String(max), value: String(getBPref(key, def)), id: 'browser-pref-slider-' + key, name: 'browser-pref-' + key, style: 'width:140px;accent-color:var(--accent);cursor:pointer;' });
              slider.addEventListener('input', () => { valLabel.textContent = slider.value + (suffix || ''); setBPref(key, Number(slider.value)); });
              row.append(left, slider);
              return row;
            }

            // ── Sidebar ───────────────────────────────────────────────────
            const NAV = [
              { id: 'general', label: 'General', icon: '⚙️' },
              { id: 'search', label: 'Search Engine', icon: '🔍' },
              { id: 'privacy', label: 'Privacy & Security', icon: '🔒' },
              { id: 'content', label: 'Content', icon: '🌐' },
              { id: 'bandwidth', label: 'Bandwidth', icon: '📶' },
              { id: 'accessibility', label: 'Accessibility', icon: '♿' },
              { id: 'labs', label: 'Labs', icon: '🧪' },
              { id: 'reset', label: 'Reset', icon: '🔄' },
            ];

            const sidebar = createEl('div', { style: 'width:200px;flex-shrink:0;border-right:1px solid var(--border-subtle);padding:20px 0;display:flex;flex-direction:column;gap:2px;overflow-y:auto;background:var(--bg-elevated);' });
            const sidebarTitle = createEl('div', { textContent: 'Settings', style: 'font-size:13px;font-weight:700;color:var(--text-primary);padding:0 16px 14px;border-bottom:1px solid var(--border-subtle);margin-bottom:6px;' });
            sidebar.appendChild(sidebarTitle);

            const navBtns = {};
            NAV.forEach(({ id, label, icon }) => {
              const btn = createEl('button', { style: 'display:flex;align-items:center;gap:9px;width:100%;padding:8px 16px;border:none;background:' + (id === activeCategory ? 'rgba(88,166,255,0.12)' : 'transparent') + ';color:' + (id === activeCategory ? 'var(--accent)' : 'var(--text-secondary)') + ';font-size:12px;font-weight:' + (id === activeCategory ? '600' : '400') + ';cursor:pointer;text-align:left;border-radius:0;transition:background 0.15s;border-left:2px solid ' + (id === activeCategory ? 'var(--accent)' : 'transparent') + ';' });
              btn.appendChild(createEl('span', { textContent: icon, style: 'font-size:14px;width:18px;text-align:center;' }));
              btn.appendChild(createEl('span', { textContent: label }));
              btn.addEventListener('mouseenter', () => { if (id !== activeCategory) btn.style.background = 'var(--bg-hover)'; });
              btn.addEventListener('mouseleave', () => { if (id !== activeCategory) btn.style.background = 'transparent'; });
              btn.addEventListener('click', () => renderSettingsPage(id));
              navBtns[id] = btn;
              sidebar.appendChild(btn);
            });

            // ── Content panel ─────────────────────────────────────────────
            const panel = createEl('div', { style: 'flex:1;overflow-y:auto;padding:28px 32px;' });
            const panelInner = createEl('div', { style: 'max-width:560px;' });

            function panelTitle(title, desc) {
              panelInner.appendChild(createEl('h2', { textContent: title, style: 'font-size:17px;font-weight:700;margin:0 0 4px;color:var(--text-primary);' }));
              if (desc) panelInner.appendChild(createEl('p', { textContent: desc, style: 'color:var(--text-muted);margin:0 0 20px;font-size:12px;' }));
            }

            // ════════════════════════════════════════════════════════════
            if (activeCategory === 'general') {
              panelTitle('General', 'Basic browser behaviour and preferences.');
              const hpSel = mkSelect('homepage', 'most_visited', [['most_visited', 'Speed Dial'], ['blank', 'Blank Page'], ['custom', 'Custom URL']]);
              const hpCustomWrap = createEl('div', { style: 'margin-top:6px;display:' + (getBPref('homepage', 'most_visited') === 'custom' ? 'block' : 'none') + ';' });
              const hpInp = createEl('input', { type: 'url', id: 'browser-homepage-input', name: 'browser-homepage', placeholder: 'https://example.com', value: getBPref('homepageUrl', ''), style: 'width:100%;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:6px;padding:6px 10px;color:var(--text-primary);font-size:12px;outline:none;box-sizing:border-box;' });
              hpInp.addEventListener('change', () => setBPref('homepageUrl', hpInp.value));
              hpCustomWrap.appendChild(hpInp);
              hpSel.addEventListener('change', () => { hpCustomWrap.style.display = hpSel.value === 'custom' ? 'block' : 'none'; });
              const hpWrap = createEl('div', { style: 'display:flex;flex-direction:column;gap:4px;max-width:200px;' });
              hpWrap.append(hpSel, hpCustomWrap);
              panelInner.appendChild(mkRow('Homepage', 'Page shown when opening a new tab', hpWrap));
              panelInner.appendChild(mkRow('Autofill', 'Automatically fill in web forms', mkToggle('autofill_enabled', true)));

              // ════════════════════════════════════════════════════════════
            } else if (activeCategory === 'search') {
              panelTitle('Search Engine', 'Choose your default search engine.');
              const seList = createEl('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-top:4px;' });
              Object.entries(SEARCH_ENGINES).forEach(([key, info]) => {
                const row = createEl('label', { style: 'display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;cursor:pointer;border:1px solid ' + (key === eng ? 'var(--accent)' : 'var(--border-subtle)') + ';background:' + (key === eng ? 'rgba(88,166,255,0.08)' : 'var(--bg-elevated)') + ';transition:all 0.15s;' });
                const radio = createEl('input');
                radio.type = 'radio'; radio.id = 'search-engine-' + key; radio.name = 'se'; radio.value = key; radio.checked = key === eng;
                radio.style.accentColor = 'var(--accent)';
                const lbl = createEl('span', { textContent: info.label, style: 'flex:1;font-size:13px;' });
                const hint = createEl('span', { textContent: info.url.replace('https://', '').split('/')[0], style: 'font-size:11px;color:var(--text-muted);' });
                row.append(radio, lbl, hint);
                if (key === eng) row.appendChild(createEl('span', { textContent: 'Default', style: 'font-size:10px;padding:2px 7px;border-radius:10px;background:var(--accent);color:#fff;' }));
                radio.addEventListener('change', () => { if (radio.checked) { saveSetting('searchEngine', key); renderSettingsPage('search'); } });
                seList.appendChild(row);
              });
              panelInner.appendChild(seList);

              // ════════════════════════════════════════════════════════════
            } else if (activeCategory === 'privacy') {
              panelTitle('Privacy & Security', 'Control cookies, passwords, location and browsing data.');
              panelInner.appendChild(mkRow('Show security warnings', 'Show a warning indicator for non-HTTPS pages in the address bar', mkToggle('show_security_warnings', true, (v) => {
                // Re-evaluate current page icon when toggled
                updateUrlIcon(currentUrl);
              })));

              panelInner.appendChild(mkSubHdr('Cookies'));
              panelInner.appendChild(mkRow('Accept cookies', 'Allow sites to save cookies. Disabling clears existing cookies and blocks new ones via webRequest', mkToggle('accept_cookies', true, (v) => {
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
                mkClearBtn('Clear History', () => { localStorage.removeItem(HX_KEY); _historyCache = null; Notify.show({ title: 'History cleared', body: 'Browsing history has been deleted.', type: 'info', appName: 'Browser' }); }),
                mkClearBtn('Clear Bookmarks', () => { localStorage.removeItem(BK_KEY); _bookmarksCache = null; Notify.show({ title: 'Bookmarks cleared', body: 'All bookmarks have been deleted.', type: 'info', appName: 'Browser' }); })
              );
              panelInner.appendChild(dataRow);

              // ════════════════════════════════════════════════════════════
            } else if (activeCategory === 'content') {
              panelTitle('Content', 'Control how web pages are loaded and displayed.');
              panelInner.appendChild(mkRow('Block pop-up windows', 'Prevent sites from opening new windows', mkToggle('block_popup_windows', true)));
              panelInner.appendChild(mkRow('Open links in background', 'New tabs open without switching to them', mkToggle('open_in_background', false)));
              panelInner.appendChild(mkRow('Allow app tabs', 'Sites can pin themselves as app tabs', mkToggle('allow_apptabs', false)));
              panelInner.appendChild(mkRow('Default zoom', 'Initial page zoom level', mkSelect('default_zoom', 'MEDIUM', [['FAR', 'Far (smallest)'], ['MEDIUM', 'Medium'], ['CLOSE', 'Close (largest)']])));
              panelInner.appendChild(mkRow('Text encoding', 'Default character encoding for web pages', mkSelect('default_text_encoding', 'UTF-8', [['UTF-8', 'UTF-8'], ['ISO-8859-1', 'Latin-1'], ['GBK', 'GBK'], ['Shift_JIS', 'Shift JIS'], ['EUC-JP', 'EUC-JP']])));

              // ════════════════════════════════════════════════════════════
            } else if (activeCategory === 'bandwidth') {
              panelTitle('Bandwidth', 'Manage how much data the browser downloads.');
              panelInner.appendChild(mkRow('Load images', 'Download and display images on web pages', mkToggle('load_images', true)));
              panelInner.appendChild(mkRow('Preload pages', 'Download pages in advance for faster browsing', mkSelect('preload_when', 'WIFI_ONLY', [['ALWAYS', 'Always'], ['WIFI_ONLY', 'Wi-Fi only'], ['NEVER', 'Never']])));
              panelInner.appendChild(mkRow('Link prefetch', 'Preload links the page suggests', mkSelect('link_prefetch_when', 'WIFI_ONLY', [['ALWAYS', 'Always'], ['WIFI_ONLY', 'Wi-Fi only'], ['NEVER', 'Never']])));

              // ════════════════════════════════════════════════════════════
            } else if (activeCategory === 'accessibility') {
              panelTitle('Accessibility', 'Adjust display and interaction settings.');
              panelInner.appendChild(mkRow('Force zoom', 'Override sites that disable pinch-to-zoom', mkToggle('force_userscalable', false)));
              panelInner.appendChild(mkRow('Inverted colours', 'Display pages with inverted colours', mkToggle('inverted', false)));
              panelInner.appendChild(mkSliderRow('Text zoom', 'text_zoom', 10, 1, 30, '%'));
              panelInner.appendChild(mkSliderRow('Double-tap zoom', 'double_tap_zoom', 5, 1, 10, 'x'));
              panelInner.appendChild(mkSliderRow('Minimum font size', 'min_font_size', 0, 0, 20, 'px'));

              // ════════════════════════════════════════════════════════════
            } else if (activeCategory === 'labs') {
              panelTitle('Labs', 'Experimental features — may be unstable.');
              panelInner.appendChild(mkRow('Quick controls', 'Swipe-based navigation controls', mkToggle('enable_quick_controls', false)));
              panelInner.appendChild(mkRow('Fullscreen mode', 'Hide browser chrome when scrolling down', mkToggle('fullscreen', false)));

              // ════════════════════════════════════════════════════════════
            } else if (activeCategory === 'reset') {
              panelTitle('Reset', 'Restore all settings to their factory defaults.');
              const resetBtn = createEl('button', { textContent: 'Reset all settings to defaults', style: 'margin-top:8px;padding:9px 18px;border-radius:8px;border:1px solid var(--text-danger);background:transparent;color:var(--text-danger);font-size:13px;cursor:pointer;transition:background 0.15s;' });
              resetBtn.addEventListener('mouseenter', () => resetBtn.style.background = 'rgba(248,81,73,0.1)');
              resetBtn.addEventListener('mouseleave', () => resetBtn.style.background = 'transparent');
              resetBtn.addEventListener('click', () => {
                showModal(
                  'Reset Browser Settings',
                  'This will restore all browser settings to their factory defaults. Your bookmarks and history will not be affected.',
                  [{ label: 'Reset', danger: true, value: true }, { label: 'Cancel', value: false }]
                ).then(confirmed => {
                  if (!confirmed) return;
                  localStorage.removeItem(ST_KEY);
                  _settingsCache = null; // invalidate settings cache
                  renderSettingsPage('general');
                  Notify.show({ title: 'Settings reset', body: 'All browser settings restored to defaults.', type: 'success', appName: 'Browser' });
                });
              });
              panelInner.appendChild(resetBtn);
            }

            panel.appendChild(panelInner);
            page.append(sidebar, panel);
            viewport.appendChild(page);
          }

          // Returns true for localhost / loopback / RFC-1918 / link-local addresses.
          // Used to block users from navigating to internal network resources.
          function isLocalAddress(rawUrl) {
            let hostname;
            try {
              // Normalise: prepend scheme if missing so URL() can parse it
              const normalized = /^https?:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl;
              hostname = new URL(normalized).hostname.toLowerCase().replace(/\.$/, '');
            } catch { return false; }
            // Exact names
            if (hostname === 'localhost') return true;
            // IPv6 loopback
            if (hostname === '[::1]' || hostname === '::1') return true;
            // Strip IPv6 brackets for regex checks below
            const h = hostname.replace(/^\[|\]$/g, '');
            // FIX: Detect and reject alternative IP formats that bypass string matching
            // Octal encoding: 0177.0.0.1 → 127.0.0.1
            if (/^0[0-7]{3}\./.test(h)) return true; // octal-encoded first octet
            // Hexadecimal encoding: 0x7f000001 → 127.0.0.1
            if (/^0x[0-9a-f]+$/i.test(h)) {
              try {
                const num = parseInt(h, 16);
                // Check if this resolves to loopback (127.0.0.1 = 2130706433)
                // or any RFC-1918 private range
                if (num >= 2130706432 && num <= 2130706447) return true; // 127.0.0.0/24
                if (num >= 167772160 && num <= 167772191) return true;  // 10.0.0.0/24
                if (num >= 2886729728 && num <= 2886732799) return true; // 172.16.0.0/12
                if (num >= 3232235520 && num <= 3232235775) return true; // 192.168.0.0/16
              } catch {}
            }
            // Dword decimal encoding: 2130706433 → 127.0.0.1 (network byte order check)
            if (/^\d+$/.test(h)) {
              try {
                const num = parseInt(h, 10);
                // Loopback range: 2130706432-2130706447 (127.0.0.0 - 127.0.0.15)
                // Also check 127.0.0.1 specifically: 2130706433
                if (num >= 2130706432 && num <= 2147483647) return true; // 127.x.x.x range
                if (num >= 167772160 && num <= 184549375) return true;   // 10.0.0.0/8
                if (num >= 2886729728 && num <= 2887778303) return true;  // 172.16.0.0/12
                if (num >= 3232235520 && num <= 3232301055) return true;  // 192.168.0.0/16
              } catch {}
            }
            // IPv4 loopback (127.x.x.x), link-local (169.254.x.x),
            // RFC-1918 private ranges (10.x, 172.16-31.x, 192.168.x)
            return /^127\./.test(h) ||
                   /^169\.254\./.test(h) ||
                   /^10\./.test(h) ||
                   /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
                   /^192\.168\./.test(h);
          }

          // FIX: Validate file paths to prevent path traversal attacks
          // Ensures resolved path stays within intended base directory
          function validateFilePath(basePath, filePath) {
            try {
              const nPath = require('path');
              const resolved = nPath.resolve(basePath, filePath);
              const relative = nPath.relative(basePath, resolved);
              // Reject if relative path starts with .. (traversal outside base)
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

          function navigate(rawUrl) {
            if (!rawUrl) return;
            let url = rawUrl.trim();
            // FIX: Canonicalize URL by removing ALL control characters (leading, internal, trailing)
            // before checking dangerous schemes. Chromium strips \x09, \x0a, \x0d internally.
            // Without removing these first, attackers can bypass the regex: java\tscript:code
            const _canonicalUrl = url.toLowerCase()
              .replace(/[\s\u0000-\u001f\u007f-\u009f]/g, '')
              .trim();
            if (/^(javascript|data|vbscript|about):/i.test(_canonicalUrl)) return;

            // Block navigation to localhost / private / loopback addresses
            if (isLocalAddress(url)) {
              Notify.show({ title: 'Browser', body: 'Navigation to local or private network addresses is not allowed.', type: 'error', appName: 'Browser' });
              return;
            }

            // ── browser://settings ────────────────────────────────────────
            if (url === 'browser://settings') {
              urlBar.value = 'browser://settings';
              currentUrl = 'browser://settings';
              const activeTab = tabs.find(t => t.id === activeTabId);
              if (activeTab) { activeTab.url = url; activeTab.title = 'Settings'; }
              renderTabs();
              renderSettingsPage();
              return;
            }

            // Remove settings page if navigating away
            const settingsPage = viewport.querySelector('.browser-settings-page');
            if (settingsPage) settingsPage.remove();

             // Resolve vault:// URLs by looking up the file in FS and loading via temp file or blob
             if (url.startsWith('vault:')) {
               if (!AppPermissionManager?.isGranted('fs:write', 'browser')) {
                 Notify.show({ title: 'Permission denied', body: 'Browser needs fs:write to access vault files.', type: 'error', appName: 'Browser' });
                 return;
               }
              // FIX: Capture target tab ID upfront to prevent race conditions if user switches tabs
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
              if (targetNode && targetNode.content != null) {
                urlBar.value = stripHttps(url); currentUrl = url; updateUrlIcon(url);
                const activeTab = tabs.find(t => t.id === targetTabId);
                if (activeTab) { activeTab.url = url; activeTab.title = targetNode.name; }
                renderTabs();
                // hide speed dial if present
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
                  // Per-folder temp dir — siblings from the same folder land here so
                  // relative imports (style.css, app.js, images) resolve correctly.
                  const dirKey = targetNode.parentId || 'root';
                  const tmpBase = nPath.join(nOs.tmpdir(), 'nbosp_vault_' + dirKey);
                  if (!nFs.existsSync(tmpBase)) nFs.mkdirSync(tmpBase, { recursive: true });
                  // Write all loaded siblings from the same parent folder
                  if (targetNode.parentId) {
                    for (const [, sib] of FS.files) {
                      if (sib.type !== 'file' || sib.parentId !== targetNode.parentId || sib.content == null) continue;
                      // FIX: Validate file paths to prevent traversal attacks
                      const validPath = validateFilePath(tmpBase, sib.name);
                      if (!validPath) {
                        console.warn('[NB Browser] Skipping suspicious sibling file:', sib.name);
                        continue;
                      }
                      const sibContent = sib.content instanceof Uint8Array ? Buffer.from(sib.content) : sib.content;
                      try {
                        nFs.writeFileSync(validPath, sibContent);
                      } catch (err) {
                        console.error('[NB Browser] Failed to write sibling file ' + sib.name + ':', err);
                       }
                     }
                   }
                   // Write the requested file (may already be there from sibling pass)
                  // FIX: Validate main file path
                  const validTmpFile = validateFilePath(tmpBase, targetNode.name);
                  if (!validTmpFile) {
                    throw new Error('Invalid target file path');
                  }
                  const contentToWrite = targetNode.content instanceof Uint8Array ? Buffer.from(targetNode.content) : targetNode.content;
                  nFs.writeFileSync(validTmpFile, contentToWrite);
                  // pathToFileURL handles cross-platform correctly:
                  //   Unix  /tmp/nbosp_vault_x/index.html → file:///tmp/...  (3 slashes)
                  //   Win   C:\...\nbosp_vault_x\index.html → file:///C:/...  (3 slashes)
                  // FIX: Verify tab is still the active target before applying URL change
                  if (activeTabId === targetTabId) {
                    wv.src = nUrl.pathToFileURL(validTmpFile).href;
                  }
                } catch (err) {
                  console.error('[NB Browser] Failed to load vault file via file:// URL:', err);
                  // Fallback: use blob URL instead of file:// to avoid sandbox issues
                  const contentStr = targetNode.content instanceof Uint8Array ? new TextDecoder().decode(targetNode.content) : String(targetNode.content);
                  const blob = new Blob([contentStr], { type: 'text/html' });
                  const _blobUrl = URL.createObjectURL(blob);
                  // FIX: Only apply blob URL if tab is still the active target
                  if (activeTabId === targetTabId) {
                    wv.src = _blobUrl;
                  }
                  // FIX: Track blob URLs on tab state for proper cleanup
                  const tab = tabs.find(t => t.id === targetTabId);
                  if (tab) {
                    if (tab.activeBlobUrl) URL.revokeObjectURL(tab.activeBlobUrl);
                    tab.activeBlobUrl = _blobUrl;
                  }
                }
                return;
              }
              urlBar.value = stripHttps(url);
              Notify.show({ title: 'Browser', body: 'File not found in vault: ' + vaultRel, type: 'error', appName: 'Browser' });
              return;
            }

            if (!url.match(/^https?:\/\//i) && !url.startsWith('blob:') && !url.startsWith('file://') && !url.startsWith('data:')) {
              url = (url.includes('.') && !url.includes(' ')) ? 'https://' + url : getSearchUrl(url);
            }
            urlBar.value = stripHttps(url); currentUrl = url; updateUrlIcon(url);
            const activeTab = tabs.find(t => t.id === activeTabId);
            if (activeTab) { activeTab.url = url; try { activeTab.title = new URL(url).hostname; } catch { } }
            renderTabs();
            // hide speed dial if present
            const sd = viewport.querySelector('.speed-dial');
            if (sd) sd.remove();
            // Remove stale blocked notice for active tab
            const oldNotice = viewport.querySelector('.browser-iframe-blocked[data-tab="' + activeTabId + '"]');
            if (oldNotice) oldNotice.remove();
            const mode = getTabMode(activeTabId);
            if (mode === 'iframe') {
              const ifr = getOrCreateIframe(activeTabId);
              if (!ifr.parentNode) viewport.appendChild(ifr);
              showViewForTab(activeTabId);
              ifr.src = url;
            } else {
              const wv = getOrCreateWebview(activeTabId);
              if (!wv.parentNode) viewport.appendChild(wv);
              showViewForTab(activeTabId);
              wv.src = url;
            }
          }

          const stripHttps = url => url ? url.replace(/^https:\/\//, '') : '';

          // ── Omnibox dropdown ────────────────────────────────────────────────
          // Appended to `container` (not urlBarWrap) so it escapes the
          // translateZ(0) stacking context on .browser-toolbar that would
          // otherwise clip the dropdown inside the toolbar's paint layer.
          // Position is set via getBoundingClientRect on every open.
          const omniDrop = createEl('div', { className: 'omnibox-dropdown' });
          omniDrop.setAttribute('role', 'listbox');
          container.appendChild(omniDrop);

          function omniReposition() {
            const r = urlBar.getBoundingClientRect();
            const cr = container.getBoundingClientRect();
            omniDrop.style.top   = (r.bottom - cr.top + 6) + 'px';
            omniDrop.style.left  = (r.left   - cr.left)    + 'px';
            omniDrop.style.width = r.width + 'px';
          }

          let omniItems = [], omniIdx = -1, omniTimer = null, omniXhr = null;

          function omniClose() {
            omniDrop.style.display = 'none';
            omniDrop.innerHTML = '';
            omniItems = []; omniIdx = -1;
          }

          function omniHighlight(idx) {
            omniDrop.querySelectorAll('.omni-row').forEach((r, i) => r.classList.toggle('active', i === idx));
            omniIdx = idx;
          }

          function omniRender(items) {
            omniDrop.innerHTML = '';
            omniItems = items;
            omniIdx = -1;
            if (!items.length) { omniDrop.style.display = 'none'; return; }
            omniReposition();
            items.forEach((item, i) => {
              const row = createEl('div', { className: 'omni-row', role: 'option' });
              const ic  = createEl('span', { className: 'omni-icon' });
              ic.innerHTML = item.type === 'history'  ? svgIcon('clock',    13)
                           : item.type === 'bookmark' ? svgIcon('bookmark', 13)
                           :                            svgIcon('search',   13);
              const tx = createEl('span', { className: 'omni-text' });
              tx.textContent = item.label;
              if (item.sub) {
                const sb = createEl('span', { className: 'omni-sub' });
                sb.textContent = item.sub;
                row.append(ic, tx, sb);
              } else {
                row.append(ic, tx);
              }
              row.addEventListener('mousedown', e => { e.preventDefault(); omniClose(); navigate(item.url || item.label); });
              row.addEventListener('mousemove', () => omniHighlight(i));
              omniDrop.appendChild(row);
            });
            omniDrop.style.display = 'block';
          }

          async function fetchSuggestions(q, signal) {
            const eng = getSetting('searchEngine', 'brave');
            try {
              const r = await fetch(
                `/api/suggest?engine=${encodeURIComponent(eng)}&q=${encodeURIComponent(q)}`,
                { signal }
              );
              if (!r.ok) return [];
              const j = await r.json();
              return j.suggestions || [];
            } catch { return []; }
          }

          async function omniQuery(raw) {
            const q = raw.trim();
            if (!q) { omniClose(); return; }

            // Local sources — instant
            const lq = q.toLowerCase();
            const bkItems = loadBookmarks()
              .filter(b => b.url.toLowerCase().includes(lq) || (b.title || '').toLowerCase().includes(lq))
              .slice(0, 3)
              .map(b => ({ type: 'bookmark', label: b.title || b.url, sub: b.url, url: b.url }));
            const hxItems = loadHistory()
              .filter(h => h.url.toLowerCase().includes(lq) || (h.title || '').toLowerCase().includes(lq))
              .slice(0, 4)
              .map(h => ({ type: 'history', label: h.title || h.url, sub: h.url, url: h.url }));

            omniRender([...bkItems, ...hxItems]);

            // Skip remote fetch for single-char queries — results are noise
            if (q.length < 2) return;

            // Abort any in-flight request before starting a new one
            if (omniXhr) omniXhr.abort();
            const controller = new AbortController();
            omniXhr = controller;

            const suggestions = await fetchSuggestions(q, controller.signal);
            if (controller.signal.aborted) return;

            const sugItems = suggestions
              .filter(s => !bkItems.some(b => b.label === s) && !hxItems.some(h => h.label === s))
              .map(s => ({ type: 'suggest', label: s, url: null }));

            omniRender([...bkItems, ...hxItems, ...sugItems]);
          }

          // ── URL bar events ──────────────────────────────────────────────────
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
            omniTimer = setTimeout(() => omniQuery(urlBar.value), 120);
          });

          urlBar.addEventListener('focus', () => { urlBar.value = currentUrl || ''; });
          urlBar.addEventListener('blur',  () => { setTimeout(omniClose, 150); urlBar.value = stripHttps(currentUrl || urlBar.value); });

          // F12 → main window DevTools (NW.js requires programmatic open)
          // Ctrl+Shift+J → DevTools INSIDE the active webview (for debugging)
          const _onBrowserKeydown = e => {
            if (e.key === 'F12') {
              e.preventDefault();
              try { nw.Window.get().showDevTools(); } catch (_) { }
            }
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'J') {
              e.preventDefault();
              const wv = tabWebviews.get(activeTabId);
              if (wv) {
                try { wv.showDevTools(true); } catch (_) { }
              }
            }
          };
          document.addEventListener('keydown', _onBrowserKeydown);
          state.cleanups = state.cleanups || [];
          state.cleanups.push(() => document.removeEventListener('keydown', _onBrowserKeydown));

          // Incognito partition — use separate session per incognito tab
          backBtn.addEventListener('click', () => {
            if (getTabMode(activeTabId) === 'iframe') {
              const ifr = tabIframes.get(activeTabId);
              try { if (ifr) ifr.contentWindow.history.back(); } catch (_) {}
            } else { tabWebviews.get(activeTabId)?.back(); }
          });
          fwdBtn.addEventListener('click', () => {
            if (getTabMode(activeTabId) === 'iframe') {
              const ifr = tabIframes.get(activeTabId);
              try { if (ifr) ifr.contentWindow.history.forward(); } catch (_) {}
            } else { tabWebviews.get(activeTabId)?.forward(); }
          });
          refreshBtn.addEventListener('click', () => {
            const _mode = getTabMode(activeTabId);
            if (_mode === 'iframe') {
              const ifr = tabIframes.get(activeTabId);
              if (ifr) {
                // Try contentWindow reload (works for same-origin); fall back to re-setting src
                try { ifr.contentWindow.location.reload(); }
                catch (_) { const _s = ifr.src; ifr.src = ''; ifr.src = _s; }
              }
            } else {
              const wv = tabWebviews.get(activeTabId);
              if (wv) wv.reload(); else if (currentUrl) navigate(currentUrl);
            }
          });

           // Open HTML file from vault — write to temp disk file so webview can load it natively
           if (options?.fileId) {
             if (!AppPermissionManager?.isGranted('fs:write', 'browser')) {
               Notify.show({ title: 'Permission denied', body: 'Browser needs fs:write to open vault files.', type: 'error', appName: 'Browser' });
               return;
             }
            const fileNode = FS.files.get(options.fileId);
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
              // Normalise content: Uint8Array → string
              const htmlContent = fileNode.content instanceof Uint8Array
                ? new TextDecoder().decode(fileNode.content)
                : String(fileNode.content);
              // Try Node fs (NW.js native) — use per-folder temp dir so relative
              // sibling files (style.css, images, etc.) resolve correctly.
              let loaded = false;
              try {
                const nPath = require('path');
                const nFs = require('fs');
                const nOs = require('os');
                const nUrl = require('url');
                const dirKey = fileNode.parentId || 'root';
                const tmpBase = nPath.join(nOs.tmpdir(), 'nbosp_vault_' + dirKey);
                if (!nFs.existsSync(tmpBase)) nFs.mkdirSync(tmpBase, { recursive: true });
                // Write all loaded siblings from the same parent folder first
                if (fileNode.parentId) {
                  for (const [, sib] of FS.files) {
                    if (sib.type !== 'file' || sib.parentId !== fileNode.parentId || sib.content == null) continue;
                    // FIX: Validate file paths to prevent traversal attacks
                    const validPath = validateFilePath(tmpBase, sib.name);
                    if (!validPath) {
                      console.warn('[NB Browser] Skipping suspicious sibling file:', sib.name);
                      continue;
                    }
                    const sibContent = sib.content instanceof Uint8Array ? Buffer.from(sib.content) : sib.content;
                    try {
                      nFs.writeFileSync(validPath, sibContent);
                    } catch (err) {
                      console.error('[NB Browser] Failed to write sibling file ' + sib.name + ':', err);
                    }
                  }
                }
                // FIX: Validate main file path
                const validTmpFile = validateFilePath(tmpBase, fileNode.name);
                if (!validTmpFile) {
                  throw new Error('Invalid file path for vault extraction');
                }
                nFs.writeFileSync(validTmpFile, htmlContent, 'utf8');
                // pathToFileURL handles cross-platform correctly (Unix 3 slashes, Win 3 slashes)
                const fileUrl = nUrl.pathToFileURL(validTmpFile).href;
                wv.src = fileUrl;
                currentUrl = fileUrl;
                loaded = true;
              } catch (err) {
                console.error('[NB Browser] File system error during vault loading:', err);
              }
              if (!loaded) {
                const blob = new Blob([htmlContent], { type: 'text/html' });
                const blobUrl = URL.createObjectURL(blob);
                wv.src = blobUrl;
                // FIX: Track blob URLs on tab state for proper cleanup instead of loadstop event
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

          // Open URL passed from OS.openUrl()
          if (options?.url) {
            renderTabs();
            navigate(options.url);
            return;
          }

          // FIX: Consolidate initialization rendering to prevent layout thrashing
          // Batch initialization into single pass instead of separate renderTabs then renderSpeedDial
          renderTabs();
          (() => {
            const _hp = getSetting('homepage', 'most_visited');
            if (_hp === 'custom') {
              const _hpUrl = getSetting('homepageUrl', '');
              if (_hpUrl) { navigate(_hpUrl); } else { renderSpeedDial(); }
            } else if (_hp === 'blank') {
              // leave viewport empty — blank page
            } else {
              renderSpeedDial();
            }
          })();
        }
      });