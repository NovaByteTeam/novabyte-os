// GLOBAL EVENT HANDLERS

// Launchpad
      document.getElementById('start-btn').addEventListener('click', toggleLaunchpad);

      function toggleLaunchpad() {
        const launchpad = document.getElementById('launchpad');
        launchpad.classList.toggle('active');
        if (launchpad.classList.contains('active')) {
          renderLaunchpad();
          document.getElementById('launchpad-search').value = '';
          document.getElementById('launchpad-search').focus();
        }
      }

      function renderLaunchpad() {
        const grid = document.getElementById('launchpad-grid');
        const apps = APP_REGISTRY;
        const webApps = (typeof WebAppManager !== 'undefined' && WebAppManager.getAllApps) ? WebAppManager.getAllApps() : [];
        const signature = [
          ...apps.map(app => `${app.id}:${app.name}:${app.icon}`),
          ...webApps.map(webApp => `web:${webApp.id}:${webApp.name}:${webApp.icon}:${webApp.url}`)
        ].join('||');

        const needsRebuild = grid.dataset.renderedSignature !== signature || grid.children.length === 0;

        if (needsRebuild) {
          grid.innerHTML = '';
          grid.dataset.renderedSignature = signature;

          const appendAppItem = (app) => {
            const item = createEl('button', {
              className: 'launchpad-item',
              'aria-label': app.name,
              draggable: 'true'
            });
            const icon = createEl('div', { className: 'launchpad-icon' });
            icon.innerHTML = svgIcon(app.icon, 28);
            const name = createEl('div', { className: 'launchpad-name', textContent: app.name });
            item.appendChild(icon);
            item.appendChild(name);

            item.addEventListener('click', () => {
              toggleLaunchpad();
              WM.createWindow(app.id);
            });

            item.addEventListener('contextmenu', (e) => {
              e.preventDefault();
              e.stopPropagation();
              const pinnedApps = OS.settings.get('pinnedApps') || [];
              const isPinned = pinnedApps.includes(app.id);
              const storedApps = (() => { try { return JSON.parse(localStorage.getItem('nova_installed_apps') || '[]'); } catch { return []; } })();
              const isUserApp = storedApps.some(a => a.id === app.id);
              const items = [
                { label: 'Open', icon: 'play', action: () => { toggleLaunchpad(); WM.createWindow(app.id); } },
                { separator: true },
                {
                  label: isPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar',
                  icon: 'pin',
                  action: () => {
                    const pins = OS.settings.get('pinnedApps') || [];
                    const next = isPinned ? pins.filter(id => id !== app.id) : [...pins, app.id];
                    OS.settings.set('pinnedApps', next);
                    WM.updateTaskbar();
                    Notify.show({ title: isPinned ? 'Unpinned' : 'Pinned', body: `${app.name} ${isPinned ? 'removed from' : 'added to'} taskbar`, type: 'success', appName: 'Launchpad' });
                  }
                }
              ];
              if (isUserApp) {
                items.push({ separator: true });
                items.push({
                  label: 'Uninstall',
                  icon: 'trash',
                  danger: true,
                  action: () => {
                    toggleLaunchpad();
                    if (!confirm(`Uninstall "${app.name}"?\n\nThis cannot be undone.`)) return;
                    try {
                      const stored = JSON.parse(localStorage.getItem('nova_installed_apps') || '[]');
                      localStorage.setItem('nova_installed_apps', JSON.stringify(stored.filter(a => a.id !== app.id)));
                      delete OS.apps[app.id];
                      const ri = APP_REGISTRY.findIndex(a => a.id === app.id);
                      if (ri > -1) APP_REGISTRY.splice(ri, 1);
                      renderDesktopIcons();
                      WM.updateTaskbar();
                      Notify.show({ title: 'Uninstalled', body: `${app.name} has been removed.`, type: 'success', appName: 'Launchpad' });
                    } catch (err) {
                      Notify.show({ title: 'Error', body: `Failed to uninstall: ${err.message}`, type: 'error', appName: 'Launchpad' });
                    }
                  }
                });
              }
              ContextMenu.show(e.clientX, e.clientY, items);
            });

            item.addEventListener('dragstart', (e) => {
              e.dataTransfer.effectAllowed = 'copy';
              e.dataTransfer.setData('application/json', JSON.stringify({
                type: 'app-shortcut',
                appId: app.id,
                appName: app.name,
                appIcon: app.icon
              }));
              e.dataTransfer.setData('text/plain', app.name);
              const dragImg = createEl('div', { style: 'padding:8px 16px;background:var(--accent);color:#fff;border-radius:8px;font-size:12px;font-family:var(--font-ui);position:fixed;top:-200px;left:-200px;' });
              dragImg.textContent = app.name;
              document.body.appendChild(dragImg);
              e.dataTransfer.setDragImage(dragImg, dragImg.offsetWidth / 2, dragImg.offsetHeight / 2);
              requestAnimationFrame(() => document.body.removeChild(dragImg));
              requestAnimationFrame(() => {
                const lp = document.getElementById('launchpad');
                if (lp) { lp.style.pointerEvents = 'none'; lp.style.opacity = '0.15'; }
              });
            });

            item.addEventListener('dragend', () => {
              const lp = document.getElementById('launchpad');
              if (lp) { lp.style.pointerEvents = ''; lp.style.opacity = ''; }
              setTimeout(() => {
                if (document.getElementById('launchpad')?.classList.contains('active')) toggleLaunchpad();
              }, 80);
            });

            grid.appendChild(item);
          };

          apps.forEach(appendAppItem);

          if (typeof WebAppManager !== 'undefined') {
            webApps.forEach(webApp => {
              const item = createEl('button', {
                className: 'launchpad-item',
                'aria-label': `${webApp.name} (Web App)`,
                title: webApp.url,
                draggable: true
              });
              const icon = createEl('div', {
                className: 'launchpad-icon',
                textContent: webApp.icon,
                style: 'font-size: 28px; line-height: 1;'
              });
              const name = createEl('div', { className: 'launchpad-name', textContent: webApp.name });
              const indicator = createEl('div', {
                style: 'position: absolute; bottom: 4px; right: 4px; width: 8px; height: 8px; background: #58a6ff; border-radius: 50%; border: 1px solid rgba(255,255,255,0.3);',
                title: 'Web App'
              });

              item.appendChild(icon);
              item.appendChild(name);
              item.appendChild(indicator);

              item.addEventListener('click', () => {
                toggleLaunchpad();
                try {
                  const appData = WebAppManager.getApp(webApp.id);
                  if (!appData) throw new Error('Web app not found');

                  WebAppManager.launchApp(webApp.id);

                  const tempAppId = 'webapp_' + webApp.id;
                  if (!OS.apps[tempAppId]) {
                    OS.apps[tempAppId] = {
                      name: appData.name,
                      icon: appData.icon,
                      defaultSize: [800, 600],
                      minSize: [400, 300]
                    };
                  }
                  const windowElement = WM.createWindow(tempAppId);

                  const iframeContainer = document.createElement('div');
                  iframeContainer.style.cssText = `width: 100%; height: 100%; display: flex; flex-direction: column; overflow: hidden; position: relative;`;

                  const loader = document.createElement('div');
                  loader.style.cssText = `position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center; color: rgba(255,255,255,0.7); z-index: 1000;`;
                  loader.innerHTML = `<div style="font-size:24px;margin-bottom:12px;">⏳</div><div>Loading...</div>`;

                  const hideLoader = () => { loader.style.display = 'none'; };
                  const iframe = document.createElement('webview');
                  iframe.style.cssText = `flex: 1; border: none; background: white; overflow: hidden;`;
                  iframe.addEventListener('did-finish-load', hideLoader);
                  iframe.addEventListener('did-stop-loading', hideLoader);
                  iframe.addEventListener('did-fail-load', () => { hideLoader(); loader.style.display = 'flex'; loader.innerHTML = `<div style="font-size:20px;margin-bottom:12px;">❌</div><div>Failed to load</div>`; });
                  setTimeout(hideLoader, 5000);
                  iframe.src = appData.url;

                  const urlBar = document.createElement('div');
                  urlBar.style.cssText = `background: rgba(255,255,255,0.08); border-bottom: 1px solid rgba(255,255,255,0.1); padding: 8px 16px; font-size: 11px; color: rgba(255,255,255,0.5); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: monospace;`;
                  try {
                    const urlObj = new URL(appData.url);
                    urlBar.textContent = `🔒 ${urlObj.host}`;
                  } catch {
                    urlBar.textContent = `External Web App`;
                  }

                  iframeContainer.appendChild(urlBar);
                  iframeContainer.appendChild(loader);
                  iframeContainer.appendChild(iframe);

                  if (windowElement && windowElement.content) {
                    windowElement.content.appendChild(iframeContainer);
                  }
                } catch (error) {
                  Notify.show({
                    title: 'Error',
                    body: `Failed to launch app: ${error.message}`,
                    type: 'error',
                    appName: 'System'
                  });
                }
              });

              item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const waPins = OS.settings.get('pinnedApps') || [];
                const waId = 'webapp_' + webApp.id;
                const waIsPinned = waPins.includes(waId);
                ContextMenu.show(e.clientX, e.clientY, [
                  { label: 'Open', icon: 'play', action: () => { toggleLaunchpad(); item.click(); } },
                  { separator: true },
                  {
                    label: waIsPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar',
                    icon: waIsPinned ? 'pin-off' : 'pin',
                    action: () => {
                      const p = OS.settings.get('pinnedApps') || [];
                      const next = waIsPinned ? p.filter(id => id !== waId) : [...p, waId];
                      OS.settings.set('pinnedApps', next);
                      if (typeof WM !== 'undefined' && WM.updateTaskbar) WM.updateTaskbar();
                      Notify.show({ title: waIsPinned ? 'Unpinned' : 'Pinned', body: `${webApp.name} ${waIsPinned ? 'unpinned from' : 'pinned to'} taskbar`, type: 'success', appName: 'Launchpad' });
                    }
                  },
                  { separator: true },
                  {
                    label: 'Remove Web App',
                    icon: 'trash',
                    danger: true,
                    action: () => {
                      WebAppManager.removeApp(webApp.id);
                      renderLaunchpad();
                      Notify.show({ title: 'Removed', body: `"${webApp.name}" has been removed`, type: 'success', appName: 'Launchpad' });
                    }
                  }
                ]);
              });

              item.draggable = true;
              item.addEventListener('dragstart', (e) => {
                const webAppId = 'webapp_' + webApp.id;
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData('application/json', JSON.stringify({
                  type: 'app-shortcut',
                  appId: webAppId,
                  appName: webApp.name,
                  appIcon: webApp.icon
                }));
                e.dataTransfer.setData('text/plain', webApp.name);
                const dragImg = createEl('div', { style: 'padding:8px 16px;background:var(--accent);color:#fff;border-radius:10px;font-size:12px;font-family:var(--font-ui);position:fixed;top:-200px;left:-200px;' });
                dragImg.textContent = webApp.name;
                document.body.appendChild(dragImg);
                e.dataTransfer.setDragImage(dragImg, dragImg.offsetWidth / 2, dragImg.offsetHeight / 2);
                requestAnimationFrame(() => document.body.removeChild(dragImg));
                requestAnimationFrame(() => {
                  const lp = document.getElementById('launchpad');
                  if (lp) { lp.style.pointerEvents = 'none'; lp.style.opacity = '0.15'; }
                });
              });
              item.addEventListener('dragend', () => {
                const lp = document.getElementById('launchpad');
                if (lp) { lp.style.pointerEvents = ''; lp.style.opacity = ''; }
                setTimeout(() => {
                  if (document.getElementById('launchpad')?.classList.contains('active')) toggleLaunchpad();
                }, 80);
              });

              grid.appendChild(item);
            });
          }
        } else {
          Array.from(grid.children).forEach(item => {
            item.classList.remove('animate');
            item.style.opacity = '0';
            item.style.transform = 'scale(0)';
            item.style.removeProperty('--delay');
            item.style.willChange = '';
            item.style.display = '';
          });
        }

        const animateLaunchpadItems = () => {
          requestAnimationFrame(() => {
            const prefersReducedMotion = OS.settings.get('reduceMotion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            const items = Array.from(grid.querySelectorAll('.launchpad-item')).filter(item => item.style.display !== 'none');

            if (prefersReducedMotion) {
              items.forEach(item => {
                item.style.opacity = '1';
                item.style.transform = 'scale(1)';
                item.classList.add('animate');
              });
              return;
            }

            const gridWidth = grid.offsetWidth;
            const gridHeight = grid.offsetHeight;
            const centerX = gridWidth / 2;
            const centerY = gridHeight / 2;
            const maxDistance = Math.sqrt(Math.pow(gridWidth / 2, 2) + Math.pow(gridHeight / 2, 2)) || 1;

            const itemData = items.map(item => ({
              item,
              cx: item.offsetLeft + item.offsetWidth / 2,
              cy: item.offsetTop + item.offsetHeight / 2
            }));

            itemData.forEach(({ item, cx, cy }) => {
              const distance = Math.sqrt(Math.pow(cx - centerX, 2) + Math.pow(cy - centerY, 2));
              const delay = Math.round((distance / maxDistance) * 300);
              item.style.setProperty('--delay', `${delay}ms`);
              item.style.willChange = 'transform, opacity';
              item.classList.add('animate');
              setTimeout(() => {
                item.style.willChange = '';
              }, 500 + delay);
            });
          });
        };

        animateLaunchpadItems();
      }

      // Launchpad search
      document.getElementById('launchpad-search').addEventListener('input', debounce(function (e) {
        const q = (e.target || this).value.toLowerCase().trim();
        const items = document.querySelectorAll('.launchpad-item');
        items.forEach(item => {
          const name = item.querySelector('.launchpad-name').textContent.toLowerCase();
          // Also search through aria-label for better matching
          const label = item.getAttribute('aria-label') || '';
          const match = name.includes(q) || label.toLowerCase().includes(q);
          item.style.display = match ? '' : 'none';
        });
        // Show/hide no results message
        const visibleItems = document.querySelectorAll('.launchpad-item[style=""]');
        const allItems = document.querySelectorAll('.launchpad-item');
        let noResultsMsg = document.getElementById('launchpad-no-results');
        if (q && visibleItems.length === 0 && allItems.length > 0) {
          if (!noResultsMsg) {
            noResultsMsg = createEl('div', {
              id: 'launchpad-no-results',
              className: 'launchpad-no-results',
              textContent: 'No apps found',
              style: 'grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 40px;'
            });
            document.getElementById('launchpad-grid').appendChild(noResultsMsg);
          }
          noResultsMsg.style.display = '';
        } else if (noResultsMsg) {
          noResultsMsg.style.display = 'none';
        }
      }, 150));

      // Close launchpad on click outside
      document.getElementById('launchpad').addEventListener('click', (e) => {
        if (e.target.id === 'launchpad') toggleLaunchpad();
      });

      // Close notification panel on click outside
      document.getElementById('notification-panel').addEventListener('click', (e) => {
        if (e.target.id === 'notification-panel') {
          document.getElementById('notification-panel').classList.remove('active');
        }
      });

      // Notification panel
      document.getElementById('tray-bell').addEventListener('click', Notify.togglePanel);
      document.getElementById('notif-close').addEventListener('click', () => {
        document.getElementById('notification-panel').classList.remove('active');
      });
      document.getElementById('notif-mark-all').addEventListener('click', () => {
        OS.notifications = [];
        OS.notifUnread = 0;
        Notify.persist();
        Notify.updateBadge();
        updateNotificationBadge();
        Notify.renderPanel();
      });


      // FIX 13 — WiFi tray button had no click handler at all
      const trayWifi = document.getElementById('tray-wifi');
      if (trayWifi) {
        trayWifi.addEventListener('click', (e) => {
          e.stopPropagation();
          let wifiPopup = document.getElementById('wifi-popup');
          if (!wifiPopup) {
            wifiPopup = document.createElement('div');
            wifiPopup.id = 'wifi-popup';
            wifiPopup.style.cssText = 'position:fixed;bottom:60px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:var(--r-md);padding:16px;min-width:200px;z-index:9999;box-shadow:var(--shadow-md)';
            document.body.appendChild(wifiPopup);
            document.addEventListener('click', () => wifiPopup.remove(), { once: true });
          } else {
            wifiPopup.remove(); return;
          }
          const online = navigator.onLine;
          const rect = trayWifi.getBoundingClientRect();
          wifiPopup.style.left = Math.max(0, rect.left - 80) + 'px';
          wifiPopup.innerHTML = '<div style="font-weight:600;margin-bottom:8px;">Network</div>' +
            '<div style="display:flex;align-items:center;gap:8px;font-size:13px;"><span style="color:' + (online ? 'var(--text-success)' : 'var(--text-danger)') + '">●</span>' +
            (online ? 'Connected to network' : 'No internet connection') + '</div>';
        });
      }

      // Volume popup
      const volumeBtn = document.getElementById('tray-volume');
      const volumePopup = document.getElementById('volume-popup');
      const volumeSlider = document.getElementById('volume-slider');
      const volumeValue = document.getElementById('volume-value');

      volumeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = volumeBtn.getBoundingClientRect();
        volumePopup.style.left = rect.left + 'px';
        volumePopup.style.bottom = '60px';
        volumePopup.classList.toggle('active');
      });

      let volumePopupPinned = false;

      volumeBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        volumePopupPinned = !volumePopupPinned;
      });

      volumeSlider.addEventListener('click', (e) => {
        e.stopPropagation();
      });

      volumeSlider.addEventListener('input', () => {
        OS.volume = parseInt(volumeSlider.value);
        volumeValue.textContent = OS.volume + '%';
      });

      volumePopup.addEventListener('click', (e) => {
        e.stopPropagation();
      });

      document.addEventListener('click', () => {
        if (!volumePopupPinned) {
          volumePopup.classList.remove('active');
        }
      });

      // FIX 12 — removed duplicate tray-bell click handler that was opening Pulse app.
      // The correct handler (Notify.togglePanel) is already registered above at line 25416.

      // Update notification badge
      function updateNotificationBadge() {
        const badge = document.getElementById('notif-badge');
        const unread = (OS.notifications || []).filter(n => !n.read).length;
        if (unread > 0) {
          badge.textContent = unread > 9 ? '9+' : unread;
          badge.classList.remove('hidden');
        } else {
          badge.classList.add('hidden');
        }
      }

      Notify.loadPersisted();
      Notify.renderPanel();
      Notify.updateBadge();
      updateNotificationBadge();

      window.addEventListener('resize', throttleRAF(() => {
        for (const state of OS.windows.values()) {
          if (state.maximized) {
            const area = WM.getWorkArea();
            state.x = area.left;
            state.y = area.top;
            state.width = area.width;
            state.height = area.height;
            state.element.style.left = area.left + 'px';
            state.element.style.top = area.top + 'px';
            state.element.style.width = area.width + 'px';
            state.element.style.height = area.height + 'px';
          } else {
            const next = WM.clampWindowRect(state, state.x, state.y, state.width, state.height);
            state.x = next.x;
            state.y = next.y;
            state.width = next.w;
            state.height = next.h;
            state.element.style.left = next.x + 'px';
            state.element.style.top = next.y + 'px';
            state.element.style.width = next.w + 'px';
            state.element.style.height = next.h + 'px';
          }
        }
        WM.hideSnapPreview();
      }));

      // Battery status
      async function updateBattery() {
        const batteryBtn = document.getElementById('tray-battery');
        try {
          if ('getBattery' in navigator) {
            const battery = await navigator.getBattery();
            function update() {
              const level = Math.round(battery.level * 100);
              batteryBtn.innerHTML = `<span style="font-size:11px">${level}%</span>`;
            }
            battery.addEventListener('levelchange', update);
            update();
          }
        } catch (e) { }
      }
      updateBattery();

      // Desktop context menu
      const desktopEl = document.getElementById('desktop');
      if (desktopEl) {
        // Clicking bare desktop unfocuses all windows (removes focused highlight)
        desktopEl.addEventListener('pointerdown', (e) => {
          if (!e.target.closest('.app-window') && !e.target.closest('.taskbar') && !e.target.closest('.context-menu')) {
            for (const [, w] of OS.windows) w.element.classList.remove('focused');
            OS.focusedWindowId = null;
            WM.updateTaskbar();
            // Blur the currently focused element so keypresses don't go into a window
            if (document.activeElement && document.activeElement !== document.body) {
              document.activeElement.blur();
            }
          }
        });

        desktopEl.addEventListener('contextmenu', (e) => {
          // Only show custom menu when clicking directly on desktop background
          // (not on icons - they have their own handlers)
          if (e.target.closest('.desktop-icon')) {
            return;
          }
          // Prevent browser's default context menu
          e.preventDefault();

          const menuItems = [
            {
              label: 'New File', icon: 'file', action: async () => {
                const name = await showPrompt('New File Name', 'untitled.txt');
                if (name) {
                  await FS.createFile(FS.specialFolders.desktop, name, '', 'text/plain');
                  renderDesktopIcons();
                }
              }
            },
            {
              label: 'New Folder', icon: 'folder', action: async () => {
                const name = await showPrompt('New Folder Name', 'New Folder');
                if (name) {
                  await FS.createFolder(FS.specialFolders.desktop, name);
                  renderDesktopIcons();
                }
              }
            },
            { separator: true },
            { label: 'Open Terminal', icon: 'terminal', action: () => WM.createWindow('shell') },
            { label: 'Open Settings', icon: 'settings', action: () => WM.createWindow('nook') }];


          menuItems.push(
            { separator: true },
            { label: 'Refresh', action: () => renderDesktopIcons() }
          );

          ContextMenu.show(e.clientX, e.clientY, menuItems);
        });
      }

      // Keyboard shortcuts
      document.addEventListener('keydown', (e) => {
        // If the user is actively typing inside any app window's content area,
        // suppress OS-level shortcuts that would conflict with in-app shortcuts.
        // Alt+F4, Alt+Tab, Escape, and PrintScreen are always allowed through.
        const focused = document.activeElement;
        const inAppContent = focused && focused.closest && focused.closest('.window-content');
        const alwaysAllow = e.altKey && (e.key === 'F4' || e.key === 'Tab') || e.key === 'Escape' || e.key === 'PrintScreen';

        if (inAppContent && !alwaysAllow) {
          // Only block shortcuts that have known in-app conflicts.
          // Specifically block: Ctrl+L, Ctrl+E, Ctrl+D, Ctrl+C, Ctrl+U,
          // Ctrl+A, Ctrl+Space, Ctrl+Shift+S, Ctrl+ArrowLeft/Right
          const conflicting = (
            (e.ctrlKey || e.metaKey) && (
              e.key === 'l' || e.key === 'L' ||
              e.key === 'e' || e.key === 'E' ||
              e.key === 'd' || e.key === 'D' ||
              e.key === 'c' || e.key === 'C' ||
              e.key === 'u' || e.key === 'U' ||
              e.key === 'a' || e.key === 'A' ||
              e.key === ' ' ||
              e.key === 'ArrowLeft' || e.key === 'ArrowRight'
            )
          );
          if (conflicting) return;
        }

        // Win/Cmd + E - File Manager
        if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
          e.preventDefault();
          WM.createWindow('vault');
        }
        // Win/Cmd + T - Terminal
        if ((e.metaKey || e.ctrlKey) && e.altKey && e.key === 't') {
          e.preventDefault();
          WM.createWindow('shell');
        }
        // Win/Cmd + Space - Launchpad
        if ((e.metaKey || e.ctrlKey) && e.key === ' ') {
          e.preventDefault();
          toggleLaunchpad();
        }
        // Win/Cmd + L - Lock
        if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
          e.preventDefault();
          lockScreen();
        }
        // Win/Cmd + D - Show desktop
        if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
          e.preventDefault();
          WM.minimizeAll();
        }
        // Win + V - Clipboard history
        if (e.key === 'v' && (e.metaKey || e.ctrlKey) && !e.altKey) {
          // This is handled by the browser for paste, but we intercept for clipboard history
        }
        // Print Screen - Screenshot desktop
        if (e.key === 'PrintScreen') {
          e.preventDefault();
          captureScreenshot('desktop');
        }
        // Alt + Print Screen - Screenshot window
        if (e.altKey && e.key === 'PrintScreen') {
          e.preventDefault();
          captureScreenshot('window');
        }
        // Win + Shift + S - Snipping tool
        if (e.key === 's' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
          e.preventDefault();
          captureScreenshot('region');
        }
        // Ctrl + Win + D - Create new workspace
        if (e.ctrlKey && e.key === 'd' && !e.altKey) {
          // Check for Windows key (metaKey on Windows is usually false, use key instead)
        }
        // Ctrl + Win + Arrow - Switch workspace
        if (e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault();
          switchWorkspace(e.key === 'ArrowRight' ? 1 : -1);
        }
        // Alt + F4 - Close window
        if (e.altKey && e.key === 'F4') {
          e.preventDefault();
          if (OS.focusedWindowId) WM.closeWindow(OS.focusedWindowId);
        }
        // Escape - Close launchpad
        if (e.key === 'Escape') {
          const launchpad = document.getElementById('launchpad');
          if (launchpad.classList.contains('active')) toggleLaunchpad();
          ContextMenu.hide();
        }
        // Alt + Tab - App switcher
        if (e.altKey && e.key === 'Tab') {
          e.preventDefault();
          showAppSwitcher();
        }
      });

      // Screenshot functionality
      async function captureScreenshot(mode) {
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { displaySurface: mode === 'window' ? 'window' : 'monitor' }
          });
          const video = document.createElement('video');
          video.srcObject = stream;
          await video.play();

          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          canvas.getContext('2d').drawImage(video, 0, 0);

          stream.getTracks().forEach(t => t.stop());

          const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
          const url = URL.createObjectURL(blob);

          const a = document.createElement('a');
          a.href = url;
          a.download = `screenshot-${Date.now()}.png`;
          a.click();
          URL.revokeObjectURL(url);

          Notify.show({ title: 'Screenshot Saved', body: 'Screenshot captured successfully', type: 'success', appName: 'System' });
        } catch (e) {
          Notify.show({ title: 'Screenshot Failed', body: 'Could not capture screenshot', type: 'error', appName: 'System' });
        }
      }

      // Virtual desktops
      function switchWorkspace(direction) {
        const currentIdx = OS.workspaces.findIndex(w => w.id === OS.currentWorkspace);
        const newIdx = currentIdx + direction;


        if (newIdx >= 0 && newIdx < OS.workspaces.length && OS.workspaces.length <= maxWorkspaces) {
          OS.currentWorkspace = OS.workspaces[newIdx].id;
          // Move windows to new workspace
          // Implementation would need to track window workspace assignments
        } else if (newIdx >= OS.workspaces.length && OS.workspaces.length < maxWorkspaces) {
          // Create new workspace if under limit
          const newWs = { id: Date.now(), name: 'Workspace ' + (OS.workspaces.length + 1) };
          OS.workspaces.push(newWs);
          OS.currentWorkspace = newWs.id;
        }
      }

      // App switcher
      let switcherActive = false;
      let switcherIdx = 0;

      function showAppSwitcher() {
        const windows = Array.from(OS.windows.values());
        if (windows.length === 0) return;

        switcherActive = true;
        switcherIdx = 0;

        const switcher = document.getElementById('app-switcher');
        const list = document.getElementById('app-switcher-list');
        list.innerHTML = '';

        windows.forEach((w, i) => {
          const app = OS.apps[w.appId];
          if (!app) return;
          const item = createEl('div', { className: 'app-switcher-item' + (i === switcherIdx ? ' active' : '') });
          const icon = createEl('div', { className: 'app-switcher-icon' });
          icon.innerHTML = svgIcon(app.icon, 32);
          const name = createEl('div', { className: 'app-switcher-name', textContent: app.name });
          item.appendChild(icon);
          item.appendChild(name);
          list.appendChild(item);
        });

        switcher.classList.add('active');
      }

      function hideAppSwitcher() {
        document.getElementById('app-switcher').classList.remove('active');
        switcherActive = false;
      }

      document.addEventListener('keyup', (e) => {
        if (switcherActive && e.key === 'Alt') {
          hideAppSwitcher();
          const windows = Array.from(OS.windows.values());
          if (windows[switcherIdx]) WM.focusWindow(windows[switcherIdx].id);
        }
        // Windows/Cmd key alone — toggle Launchpad
      });

      // Lock screen keyboard handler
      function handleLockScreenKeydown(e) {
        const lockScreen = document.getElementById('lock-screen');
        if (!lockScreen.classList.contains('active')) {
          document.removeEventListener('keydown', handleLockScreenKeydown);
          return;
        }

        // Number keys 0-9
        if (e.key >= '0' && e.key <= '9') {
          e.preventDefault();
          enterPinDigit(e.key);
        }
        // Backspace
        else if (e.key === 'Backspace') {
          e.preventDefault();
          backspacePin();
        }
        // Enter - submit PIN early if 4 digits entered
        else if (e.key === 'Enter') {
          e.preventDefault();
          if (enteredPin.length === 4) {
            verifyPin();
          }
        }
        // Escape - clear PIN
        else if (e.key === 'Escape') {
          e.preventDefault();
          clearPin();
        }
      }

      // Lock screen
      function lockScreen() {
        if (!OS.lockPin) {
          WM.minimizeAll();
          return;
        }
        OS.isLocked = true;
        document.getElementById('lock-screen').classList.add('active');
        renderLockScreen();
      }

      function renderLockScreen() {
        const usernameEl = document.getElementById('lock-username');
        const dotsEl = document.getElementById('lock-pin-dots');
        const statusEl = document.getElementById('lock-status');
        const numpadEl = document.getElementById('lock-numpad');

        usernameEl.textContent = OS.username;
        dotsEl.innerHTML = '';
        for (let i = 0; i < 4; i++) {
          dotsEl.appendChild(createEl('div', { className: 'lock-pin-dot' }));
        }
        statusEl.textContent = '';

        numpadEl.innerHTML = '';
        for (let i = 1; i <= 9; i++) {
          const btn = createEl('button', { textContent: i, 'aria-label': i.toString() });
          btn.addEventListener('click', () => enterPinDigit(i.toString()));
          numpadEl.appendChild(btn);
        }
        // Clear button
        const clearBtn = createEl('button', { textContent: 'C', 'aria-label': 'Clear' });
        clearBtn.addEventListener('click', clearPin);
        numpadEl.appendChild(clearBtn);
        // 0
        const zeroBtn = createEl('button', { textContent: '0', 'aria-label': '0' });
        zeroBtn.addEventListener('click', () => enterPinDigit('0'));
        numpadEl.appendChild(zeroBtn);
        // Backspace
        const backBtn = createEl('button', { innerHTML: svgIcon('chevron-left', 18), 'aria-label': 'Backspace' });
        backBtn.addEventListener('click', backspacePin);
        numpadEl.appendChild(backBtn);

        // Add biometric authentication button if WebAuthn available
        if (window.PublicKeyCredential && OS.settings.get('biometricCredentialId')) {
          const bioContainer = document.getElementById('lock-screen');
          const existingBio = bioContainer.querySelector('.biometric-btn');
          if (!existingBio) {
            const bioBtn = createEl('button', {
              className: 'biometric-btn',
              textContent: '👆 Use Biometric',
              style: 'margin-top:16px;width:100%;padding:12px;background:var(--bg-elevated);border:1px solid var(--accent);border-radius:8px;color:var(--accent);font-weight:600;cursor:pointer;'
            });
            bioBtn.addEventListener('click', async () => {
              try {
                const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
                if (!available) {
                  statusEl.textContent = 'Biometric not available on this device';
                  return;
                }
                statusEl.textContent = 'Waiting for biometric...';
                const challenge = crypto.getRandomValues(new Uint8Array(32));
                const credentialId = OS.settings.get('biometricCredentialId');
                const credBytes = new Uint8Array(atob(credentialId).split('').map(c => c.charCodeAt(0)));

                const credential = await navigator.credentials.get({
                  publicKey: {
                    challenge: challenge,
                    allowCredentials: [{ id: credBytes, type: 'public-key' }],
                    userVerification: 'required'
                  }
                });

                if (credential) {
                  unlockFromLockScreen();
                  Notify.show({ title: 'Welcome back', body: 'Authenticated via biometrics', type: 'success', appName: 'System' });
                }
              } catch (e) {
                statusEl.textContent = 'Biometric failed: ' + (e.message || 'Try PIN instead');
              }
            });
            numpadEl.parentNode.appendChild(bioBtn);
          }
        }

        enteredPin = '';
        updatePinDots();

        // Keyboard support for lock screen — remove before re-adding to prevent listener stacking
        document.removeEventListener('keydown', handleLockScreenKeydown);
        document.addEventListener('keydown', handleLockScreenKeydown);
      }

      let enteredPin = '';

      function unlockFromLockScreen() {
        OS.isLocked = false;
        const lockScreenEl = document.getElementById('lock-screen');
        if (lockScreenEl) lockScreenEl.classList.remove('active');
        document.removeEventListener('keydown', handleLockScreenKeydown);
        enteredPin = '';
        // Paint the taskbar first so pinned apps appear immediately after unlock.
        WM.updateTaskbar();
        requestAnimationFrame(() => {
          renderDesktopIcons();
          WM.updateTaskbar();
        });
      }

      function enterPinDigit(d) {
        if (enteredPin.length < 4) {
          enteredPin += d;
          updatePinDots();
          if (enteredPin.length === 4) verifyPin();
        }
      }

      function clearPin() {
        enteredPin = '';
        updatePinDots();
        document.getElementById('lock-status').textContent = '';
      }

      function backspacePin() {
        enteredPin = enteredPin.slice(0, -1);
        updatePinDots();
      }

      function updatePinDots() {
        const dots = document.querySelectorAll('.lock-pin-dot');
        dots.forEach((dot, i) => dot.classList.toggle('filled', i < enteredPin.length));
      }

      async function verifyPin() {
        const statusEl = document.getElementById('lock-status');
        statusEl.textContent = 'Verifying...';

        const hash = await OS.workers.crypto.call('pbkdf2', enteredPin, getPinSalt());

        if (hash === OS.lockPin) {
          OS.wrongPinCount = 0;
          unlockFromLockScreen();
        } else {
          OS.wrongPinCount++;
          enteredPin = '';
          updatePinDots();

          const _effectiveThreshold = 3;
          const _effectiveDurationMs = 30000;

          // Tier 1: threshold attempts -> policy-defined or default 30s lockout
          if (OS.wrongPinCount >= _effectiveThreshold && OS.wrongPinCount < _effectiveThreshold * 2) {
            const durSec = Math.round(_effectiveDurationMs / 1000);
            const durLabel = durSec >= 60 ? `${Math.round(durSec / 60)}min` : `${durSec}s`;
            statusEl.textContent = `Too many attempts. ${durLabel} lockout.`;
            OS.lockoutUntil = Date.now() + _effectiveDurationMs;
            setTimeout(() => {
              OS.wrongPinCount = 0;
              OS.lockoutUntil = 0;
              statusEl.textContent = '';
            }, _effectiveDurationMs);
          }
          // Tier 2: 2× threshold -> 5× duration lockout
          else if (OS.wrongPinCount >= _effectiveThreshold * 2 && OS.wrongPinCount < 10) {
            const longDur = _effectiveDurationMs * 5;
            const durSec = Math.round(longDur / 1000);
            const durLabel = durSec >= 60 ? `${Math.round(durSec / 60)}min` : `${durSec}s`;
            statusEl.textContent = `Too many attempts. ${durLabel} lockout.`;
            OS.lockoutUntil = Date.now() + longDur;
            setTimeout(() => {
              OS.wrongPinCount = 0;
              OS.lockoutUntil = 0;
              statusEl.textContent = '';
            }, longDur);
          }
          // Tier 3: 10 wrong attempts -> wipe prompt with countdown
          else if (OS.wrongPinCount >= 10) {
            statusEl.textContent = 'Security alert! Data will be wiped.';
            let countdown = 10;
            const countdownInterval = setInterval(() => {
              countdown--;
              statusEl.textContent = `Security alert! Wiping in ${countdown}s`;
              if (countdown <= 0) {
                clearInterval(countdownInterval);
                // Wipe data and reload
                localStorage.clear();
                sessionStorage.clear();
                Notify.show({ title: 'Security Wipe', body: 'All data has been wiped due to too many failed attempts.', type: 'error', appName: 'System' });
                setTimeout(() => location.reload(), 2000);
              }
            }, 1000);
          }
          else {
            statusEl.textContent = 'Incorrect PIN';
          }
        }
      }

      // Idle lock
      let lastActivity = Date.now();

      function resetIdleTimer() {
        lastActivity = Date.now();
      }

      ['pointerdown', 'pointermove', 'keydown', 'scroll'].forEach(evt => {
        document.addEventListener(evt, resetIdleTimer, { passive: true });
      });

      setInterval(() => {
        if (OS.lockPin && !OS.isLocked && OS.idleTimeout < Infinity) {
          if (Date.now() - lastActivity > OS.idleTimeout) {
            lockScreen();
          }
        }
      }, 30000);

      // ═════════════════════════════════════════════════════════════════════════
      // FILE THREAT SCANNING - Scan dropped files for malicious patterns
      // ═════════════════════════════════════════════════════════════════════════

      /**
       * Check file signature (magic bytes) for executable and suspicious formats
       * @param {Uint8Array} buffer - File buffer
       * @returns {Object} { isExecutable: boolean, type: string }
       */
      /**
       * Check file extension against suspicious list
       * @param {string} filename - File name
       * @returns {Object} { blocked: boolean, reason: string }
       */
      function checkFileExtension(filename) {
        // Only block TRULY dangerous executables
        // Don't block legitimate filetypes
        const dangerousExtensions = [
          // Windows executables only
          'exe', 'dll', 'scr', 'msi', 'com',
          // Very dangerous scripts only - but allow .js, .py, .sh for development
          'pif', 'vbs', 'vbe', 'wsf', 'wsh'
        ];

        const ext = filename.split('.').pop().toLowerCase();

        if (dangerousExtensions.includes(ext)) {
          return {
            blocked: true,
            reason: `Blocked: ${ext.toUpperCase()} files cannot be added (executable type)`
          };
        }

        return { blocked: false, reason: null };
      }

      /**
       * Scan file content for MALICIOUS patterns only (not all code)
       * @param {string} content - File content
       * @param {string} filename - File name
       * @returns {Object} { isMalicious: boolean, threats: [], patterns: [] }
       */
      function scanFileForThreats(content, filename) {
        if (!content || typeof content !== 'string' || content.length === 0) {
          return { isMalicious: false, threats: [], patterns: [] };
        }

        const threats = [];
        const patterns = [];

        // ONLY flag OBVIOUS malicious patterns, not legitimate code

        // XSS patterns (HTML files with malicious scripts)
        const xssPatterns = [
          { regex: /<script[\s\S]*?alert\s*\(/gi, name: 'alert-xss', severity: 'high' },  // script tags with alerts
          { regex: /onerror\s*=\s*["']alert/gi, name: 'onerror-alert', severity: 'high' },  // event handlers with alert
          { regex: /onclick\s*=\s*["']alert/gi, name: 'onclick-alert', severity: 'high' }   // onclick with alert
        ];

        // Only flag ENCODED malware (base64 + eval = obfuscation = malware)
        const malwarePatterns = [
          { regex: /eval\s*\(\s*atob\s*\(/gi, name: 'encoded-eval', severity: 'critical' },  // encoded + executed
          { regex: /eval\s*\(\s*decodeURIComponent/gi, name: 'uri-decode-eval', severity: 'critical' }  // URI decode + eval
        ];

        // Check patterns
        const allPatterns = [...xssPatterns, ...malwarePatterns];

        for (const { regex, name, severity } of allPatterns) {
          if (regex.test(content)) {
            patterns.push(name);
            threats.push({ type: name, severity });
          }
        }

        return {
          isMalicious: patterns.length > 0,
          threats,
          patterns
        };
      }

      // ── Recovery Mode ────────────────────────────────────────────────────

      // Trigger recovery mode manually or automatically
      function triggerRecovery(reason) {
        // Don't hijack the UI if OS is already running
        if (document.body.classList.contains('os-booted')) return false;

        const BOOT_ATTEMPT_KEY = 'nova_boot_attempts';
        const priorAttempts = (() => {
          try { return JSON.parse(localStorage.getItem(BOOT_ATTEMPT_KEY) || '[]'); } catch { return []; }
        })();

        // Add the current failure as an attempt
        priorAttempts.push({ ts: Date.now(), reason: reason || 'unknown', ua: navigator.userAgent.slice(0, 80) });
        if (priorAttempts.length > 10) priorAttempts.shift();
        localStorage.setItem(BOOT_ATTEMPT_KEY, JSON.stringify(priorAttempts));

        // Show recovery screen if we haven't already
        if (priorAttempts.length >= 2) {
          showRecoveryScreen(priorAttempts);
          return true;
        }
        return false;
      }

      // Global error handler to catch boot failures
      window.addEventListener('error', function (e) {
        // Don't trigger recovery if OS already booted successfully
        if (document.body.classList.contains('os-booted')) return;

        // Check if this is a boot-related error
        const errorMsg = e.message || '';

        // Syntax errors during boot should trigger recovery
        if (errorMsg.includes('SyntaxError') || errorMsg.includes('Unexpected token')) {
          console.error('[BOOT] Syntax error detected:', errorMsg);
          triggerRecovery('syntax_error: ' + errorMsg.slice(0, 100));
        }
      });

      function showRecoveryScreen(priorAttempts) {
        // Hide the boot screen so the recovery UI is not covered
        const bootScreen = document.getElementById('boot-screen');
        if (bootScreen) bootScreen.style.display = 'none';

        // ── Recovery Boot Animation ──────────────────────────────────────
        const anim = document.createElement('div');
        anim.id = 'recovery-boot-anim';
        anim.innerHTML = `
    <div class="rba-scanlines"></div>
    <div class="rba-glow"></div>
    <div class="rba-content">
      <div class="rba-logo-wrap">
        <div class="rba-logo-ring"></div>
        <div class="rba-logo-ring-2"></div>
        <div class="rba-logo-hex">
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
            <polygon points="18,3 33,10.5 33,25.5 18,33 3,25.5 3,10.5" fill="none" stroke="#ff6b35" stroke-width="1.5" opacity="0.8"/>
            <text x="18" y="23" text-anchor="middle" font-size="13" font-weight="700" fill="#ffd700" font-family="monospace">NB</text>
          </svg>
        </div>
      </div>
      <div class="rba-title">NovaByte</div>
      <div class="rba-subtitle">⚠ Recovery Mode v2.0</div>
      <div class="rba-log" id="rba-log"></div>
      <div class="rba-bar-wrap"><div class="rba-bar" id="rba-bar"></div></div>
      <div class="rba-status" id="rba-status">Initializing recovery environment…</div>
    </div>`;
        document.body.appendChild(anim);

        const rbaLog = document.getElementById('rba-log');
        const rbaBar = document.getElementById('rba-bar');
        const rbaStatus = document.getElementById('rba-status');
        let step = 0;
        const steps = [
          { msg: '[ RECOVERY MODE TRIGGERED ]', cls: 'warn', pct: 8, label: 'Loading recovery kernel…' },
          { msg: '✓ Recovery environment v2.0 loaded', cls: 'ok', pct: 22, label: 'Mounting storage…' },
          { msg: '✓ localStorage integrity check…', cls: 'ok', pct: 38, label: 'Checking data…' },
          { msg: '⚠ Boot failure detected — entering recovery', cls: 'warn', pct: 60, label: 'Preparing interface…' },
          { msg: '✓ Recovery UI ready', cls: 'ok', pct: 88, label: 'Almost ready…' },
          { msg: '✓ Handoff to Recovery Environment', cls: 'info', pct: 100, label: 'Done.' }];

        function runStep() {
          if (step >= steps.length) {
            // Fade out and show recovery screen
            setTimeout(() => {
              anim.classList.add('fade-out');
              setTimeout(() => { anim.remove(); }, 650);
              _doShowRecoveryScreen(priorAttempts);
            }, 300);
            return;
          }
          const s = steps[step++];
          rbaBar.style.width = s.pct + '%';
          rbaStatus.textContent = s.label;
          const line = document.createElement('div');
          line.className = 'rba-log-line ' + (s.cls || '');
          line.textContent = s.msg;
          rbaLog.appendChild(line);
          rbaLog.scrollTop = rbaLog.scrollHeight;
          setTimeout(runStep, step === 1 ? 250 : 320);
        }
        setTimeout(runStep, 180);
      }

      function _doShowRecoveryScreen(priorAttempts) {
        const screen = document.getElementById('recovery-screen');
        screen.classList.add('active');

        // Check if this was a manual recovery boot (intentional, not failed)
        const isManualRecovery = localStorage.getItem('nova_manual_recovery') === '1' || localStorage.getItem('nova_show_recovery') === '1';
        if (isManualRecovery) {
          localStorage.removeItem('nova_manual_recovery');
          localStorage.removeItem('nova_show_recovery');
        }

        // Update attempt count - hide if manual recovery
        const attemptCountEl = document.getElementById('rec-attempt-count');
        const attemptAlertEl = document.querySelector('.recovery-alert');
        if (isManualRecovery && attemptAlertEl) {
          attemptAlertEl.style.display = 'none';
          attemptCountEl.textContent = '0';
        } else {
          attemptCountEl.textContent = priorAttempts.length;
        }

        // Timestamp
        const now = new Date();
        document.getElementById('rec-timestamp').innerHTML = `<strong>${now.toLocaleString()}</strong>`;
        document.getElementById('rec-footer-time').textContent = now.toLocaleTimeString();

        // Update footer clock
        setInterval(() => {
          document.getElementById('rec-footer-time').textContent = new Date().toLocaleTimeString();
        }, 1000);

        // Build diagnostics log
        const diagEl = document.getElementById('rec-diag-lines');
        const log = (msg, cls = '') => {
          const line = document.createElement('div');
          line.className = 'recovery-log-line' + (cls ? ' ' + cls : '');
          line.textContent = msg;
          diagEl.appendChild(line);
        };

        log('[ NovaByte Recovery Environment ]', 'info');
        log('');

        // Hide boot failure analysis for manual recovery
        if (!isManualRecovery) {
          log('Boot failure analysis:', 'warn');
          priorAttempts.slice(-5).forEach((a, i) => {
            const t = new Date(a.ts).toLocaleTimeString();
            log(`  Attempt ${i + 1}: ${t}`, 'err');
          });
          log('');
        } else {
          log('Recovery mode initialized (Manual boot)', 'info');
          log('');
        }

        log('Scanning storage...', 'info');

        // Storage diagnostics
        try {
          const lsKeys = Object.keys(localStorage);
          log(`  localStorage: ${lsKeys.length} key(s) · ${new Blob([JSON.stringify(localStorage)]).size} bytes`, 'ok');
          const knownKeys = ['nova_settings', 'nova_boot_attempts'];
          knownKeys.forEach(k => {
            const val = localStorage.getItem(k);
            if (val) log(`  ✓ ${k}: ${val.length} chars`, 'ok');
            else log(`  ✗ ${k}: not found`, 'warn');
          });
        } catch (e) {
          log('  ! localStorage read error: ' + e.message, 'err');
        }

        log('');
        const hasSettings = !!localStorage.getItem('nova_settings');
        log(`  Settings key present: ${hasSettings ? 'YES' : 'NO'}`, hasSettings ? 'ok' : 'warn');
        log('');
        if (!isManualRecovery) {
          log('Recommendation: Try "Continue" first.', 'info');
          log('If it fails again, use Safe Mode or', 'info');
          log('"Reset Settings" to restore stability.', 'info');
        } else {
          log('Select any recovery option as needed.', 'info');
        }

        // Countdown auto-boot
        let countdown = 15;
        let countdownStopped = false;
        const cdownNum = document.getElementById('rec-cdown-num');
        const cdownBar = document.getElementById('rec-cdown-bar');
        const cdownBlock = document.getElementById('rec-countdown-block');

        function stopCountdown() {
          countdownStopped = true;
          cdownBlock.style.opacity = '0.4';
          cdownBlock.querySelector('.recovery-countdown-text').innerHTML = 'Auto-boot cancelled';
          cdownBar.style.transition = 'none';
          cdownBar.style.width = '0%';
        }

function wireRecoveryControls() {
  if (!screen || screen.dataset.recoveryWired === '1') return;
  screen.dataset.recoveryWired = '1';

  const actionMap = {
    'continue': 'continue',
    'boot': 'boot',
    'boot normal': 'boot-normal',
    'normal boot': 'boot-normal',
    'safe mode': 'safemode',
    'boot safe': 'boot-safe',
    'boot to safe mode': 'boot-safe',
    'minimal mode': 'boot-minimal',
    'boot minimal': 'boot-minimal',
    'boot recovery': 'boot-recovery',
    'boot to recovery': 'boot-recovery',
    'reset settings': 'reset-settings',
    'clear cache': 'clear-cache',
    'clear data': 'wipe-user-data',
    'factory reset': 'factory',
    'console': 'console',
    'terminal': 'console',
    'file manager': 'file-manager',
    'settings editor': 'settings-editor',
    'storage analyzer': 'storage-analyzer',
    'event log': 'event-log',
    'back': 'back'
  };

  function switchRecoveryTab(tabName) {
    const tab = String(tabName || '').trim().toLowerCase();
    if (!tab) return false;
    const tabButtons = screen.querySelectorAll('.recovery-tab');
    const panels = screen.querySelectorAll('.recovery-tab-panel');

    tabButtons.forEach((btn) => {
      const btnTab = (btn.dataset.tab || btn.dataset.switchtab || '').trim().toLowerCase();
      btn.classList.toggle('active', btnTab === tab);
      btn.setAttribute('aria-selected', btnTab === tab ? 'true' : 'false');
    });

    panels.forEach((panel) => {
      const panelId = (panel.id || '').replace(/^tab-/, '').trim().toLowerCase();
      panel.classList.toggle('active', panelId === tab);
    });

    return true;
  }

  screen.addEventListener('click', function (e) {
    const t = e.target.closest('button, [role="button"], [data-fn], [data-action], [data-recovery-action], .recovery-tab, .recovery-option, .rec-btn, .rec-breadcrumb-item');
    if (!t || !screen.contains(t)) return;

    const dataAction = (t.dataset.recoveryAction || t.dataset.action || t.dataset.fn || '').trim();
    const label = (t.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const action = dataAction || actionMap[label] || actionMap[label.replace(/\s*\(.*?\)\s*$/g, '')];

    const tabName = (t.dataset.tab || t.dataset.switchtab || '').trim().toLowerCase();
    if (t.classList.contains('recovery-tab') && tabName) {
      e.preventDefault();
      e.stopPropagation();
      switchRecoveryTab(tabName);
      return;
    }

    if (t.dataset.page && typeof recNav === 'function') {
      e.preventDefault();
      e.stopPropagation();
      recNav(t.dataset.page);
      return;
    }

    if (dataAction && typeof window[dataAction] === 'function') {
      e.preventDefault();
      e.stopPropagation();
      window[dataAction](t.dataset.arg || t.dataset.value || t.dataset.page);
      return;
    }

    if (action === 'back' && typeof recGoBack === 'function') {
      e.preventDefault();
      e.stopPropagation();
      recGoBack();
      return;
    }

    if (action) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof recoveryAction === 'function') recoveryAction(action);
    }
  }, true);
}

// Initialize the UI clock, sysinfo, and console
if (typeof initRecoveryUI === 'function') initRecoveryUI();
wireRecoveryControls();

        // For manual recovery, cancel countdown immediately (no auto-reboot)
        if (isManualRecovery) {
          stopCountdown();
        } else {
          const countdownTimer = setInterval(() => {
            if (countdownStopped) { clearInterval(countdownTimer); return; }
            countdown--;
            cdownNum.textContent = countdown;
            cdownBar.style.width = ((countdown / 15) * 100) + '%';
            if (countdown <= 0) {
              clearInterval(countdownTimer);
              recoveryAction('continue');
            }
          }, 1000);

          // Cancel countdown on any user interaction
          ['click', 'keydown', 'mousemove'].forEach(ev => {
            document.addEventListener(ev, () => { if (!countdownStopped) stopCountdown(); }, { once: true });
          });
        }
      }

      // ⚠️ TEST SYNTAX ERROR — remove the next line to restore normal boot
      // [REPAIRED L21187] const _recoveryTest = {; // SYNTAX ERROR: unexpected token

      // ══════════════════════════════════════════════════════════════════════════════

      // ══════════════════════════════════════════════════════════════════════════════
      //  SNAKE GAME — Easter egg (click NovaByte Version 7× in About)
      // ══════════════════════════════════════════════════════════════════════════════
      function launchSnakeGame() {
        // Prevent duplicate instances
        if (document.getElementById('snake-game-overlay')) return;

        const COLS = 20, ROWS = 20, CELL = 18;
        const W = COLS * CELL, H = ROWS * CELL;

        // ── Overlay backdrop ────────────────────────────────────────────────────────
        const overlay = createEl('div', {
          id: 'snake-game-overlay',
          style: 'position:fixed;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:99999;'
        });

        // ── Window shell ────────────────────────────────────────────────────────────
        const win = createEl('div', {
          style: 'background:rgba(10,14,22,0.96);border:1px solid rgba(255,255,255,0.18);border-radius:16px;box-shadow:0 32px 64px rgba(0,0,0,0.6);overflow:hidden;user-select:none;'
        });

        // Title bar
        const titleBar = createEl('div', {
          style: 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(255,255,255,0.04);border-bottom:1px solid rgba(255,255,255,0.08);'
        });
        const titleText = createEl('span', { textContent: '🐍 NovaByte Snake', style: 'font-size:13px;font-weight:600;color:var(--text-primary);' });
        const closeBtn = createEl('button', {
          textContent: '✕',
          style: 'background:rgba(248,81,73,0.18);border:1px solid rgba(248,81,73,0.35);color:#f85149;border-radius:6px;width:24px;height:24px;font-size:11px;cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:center;'
        });
        closeBtn.onclick = () => overlay.remove();
        titleBar.append(titleText, closeBtn);

        // Score bar
        const scoreBar = createEl('div', {
          style: 'display:flex;align-items:center;justify-content:space-between;padding:6px 14px;background:rgba(0,0,0,0.2);font-size:12px;color:var(--text-secondary);'
        });
        const scoreLabel = createEl('span', { textContent: 'Score: 0' });
        const hintLabel = createEl('span', { textContent: 'Arrow keys / WASD', style: 'color:var(--text-muted);font-size:11px;' });
        scoreBar.append(scoreLabel, hintLabel);

        // Canvas
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        canvas.style.cssText = `display:block;`;
        const ctx = canvas.getContext('2d');

        win.append(titleBar, scoreBar, canvas);
        overlay.appendChild(win);
        document.body.appendChild(overlay);

        // ── Game state ──────────────────────────────────────────────────────────────
        let snake, dir, nextDir, food, score, gameLoop;

        function rand(n) { return Math.floor(Math.random() * n); }

        function spawnFood() {
          let pos;
          do { pos = { x: rand(COLS), y: rand(ROWS) }; }
          while (snake.some(s => s.x === pos.x && s.y === pos.y));
          return pos;
        }

        function init() {
          const mid = { x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) };
          snake = [mid, { x: mid.x - 1, y: mid.y }, { x: mid.x - 2, y: mid.y }];
          dir = { x: 1, y: 0 };
          nextDir = { x: 1, y: 0 };
          food = spawnFood();
          score = 0;
          scoreLabel.textContent = 'Score: 0';
          // Remove any game-over overlay
          const go = canvas.parentElement && canvas.parentElement.querySelector('.snake-game-over');
          if (go) go.remove();
        }

        function draw() {
          // Background
          ctx.fillStyle = '#07090f';
          ctx.fillRect(0, 0, W, H);

          // Grid (subtle)
          ctx.strokeStyle = 'rgba(255,255,255,0.035)';
          ctx.lineWidth = 0.5;
          for (let c = 0; c <= COLS; c++) { ctx.beginPath(); ctx.moveTo(c * CELL, 0); ctx.lineTo(c * CELL, H); ctx.stroke(); }
          for (let r = 0; r <= ROWS; r++) { ctx.beginPath(); ctx.moveTo(0, r * CELL); ctx.lineTo(W, r * CELL); ctx.stroke(); }

          // Food
          const fx = food.x * CELL + CELL / 2, fy = food.y * CELL + CELL / 2, fr = CELL / 2 - 2;
          const foodGrad = ctx.createRadialGradient(fx - 2, fy - 2, 1, fx, fy, fr);
          foodGrad.addColorStop(0, '#ff6e6e');
          foodGrad.addColorStop(1, '#f85149');
          ctx.fillStyle = foodGrad;
          ctx.beginPath(); ctx.arc(fx, fy, fr, 0, Math.PI * 2); ctx.fill();

          // Snake
          snake.forEach((seg, i) => {
            const x = seg.x * CELL + 1, y = seg.y * CELL + 1, s = CELL - 2;
            const t = i / (snake.length - 1 || 1);
            // Head is bright accent, tail fades
            const r = Math.round(88 + (63 - 88) * t);
            const g = Math.round(166 + (190 - 166) * t);
            const b = Math.round(255 + (90 - 255) * t);
            ctx.fillStyle = i === 0 ? '#79b8ff' : `rgb(${r},${g},${b})`;
            const radius = i === 0 ? 5 : 3;
            ctx.beginPath();
            ctx.roundRect(x, y, s, s, radius);
            ctx.fill();
            // Eye on head
            if (i === 0) {
              ctx.fillStyle = '#07090f';
              const ex = x + (dir.x >= 0 ? s - 4 : 3);
              const ey = y + (dir.y >= 0 ? 3 : s - 4);
              ctx.beginPath(); ctx.arc(ex, ey, 2, 0, Math.PI * 2); ctx.fill();
            }
          });
        }

        function gameOver() {
          clearInterval(gameLoop);

          // Game-over panel inside canvas parent
          const goDiv = createEl('div', { className: 'snake-game-over' });
          const goTitle = createEl('div', { className: 'snake-game-over-title', textContent: 'Game Over' });
          const goScore = createEl('div', { className: 'snake-game-over-score', textContent: `Score: ${score}` });
          const goBtn = createEl('button', { className: 'snake-restart-btn', textContent: '↺ Play Again' });
          goBtn.onclick = () => { goDiv.remove(); startGame(); };
          goDiv.append(goTitle, goScore, goBtn);
          // Position parent relatively so the overlay sits correctly
          const wrap = canvas.parentElement;
          if (wrap) { wrap.style.position = 'relative'; wrap.appendChild(goDiv); }
        }

        function step() {
          dir = { ...nextDir };
          const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

          // Wall collision
          if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) { gameOver(); return; }
          // Self collision
          if (snake.some(s => s.x === head.x && s.y === head.y)) { gameOver(); return; }

          snake.unshift(head);

          if (head.x === food.x && head.y === food.y) {
            score++;
            scoreLabel.textContent = `Score: ${score}`;
            food = spawnFood();
          } else {
            snake.pop();
          }
          draw();
        }

        function startGame() {
          init();
          draw();
          gameLoop = setInterval(step, 120);
        }

        // ── Keyboard controls ───────────────────────────────────────────────────────
        function onKey(e) {
          const map = {
            ArrowUp: { x: 0, y: -1 }, w: { x: 0, y: -1 }, W: { x: 0, y: -1 },
            ArrowDown: { x: 0, y: 1 }, s: { x: 0, y: 1 }, S: { x: 0, y: 1 },
            ArrowLeft: { x: -1, y: 0 }, a: { x: -1, y: 0 }, A: { x: -1, y: 0 },
            ArrowRight: { x: 1, y: 0 }, d: { x: 1, y: 0 }, D: { x: 1, y: 0 },
          };
          const nd = map[e.key];
          if (nd && !(nd.x === -dir.x && nd.y === -dir.y)) {
            e.preventDefault();
            nextDir = nd;
          }
        }
        document.addEventListener('keydown', onKey);

        // Cleanup on close
        closeBtn.addEventListener('click', () => {
          clearInterval(gameLoop);
          document.removeEventListener('keydown', onKey);
        });
        overlay.addEventListener('click', e => {
          if (e.target === overlay) {
            clearInterval(gameLoop);
            document.removeEventListener('keydown', onKey);
            overlay.remove();
          }
        });

        startGame();
      }

      /* ── Background email bootstrap (silent startup sync) ─────────────────── */
      (function () {
        const bg = window.__NBOSP_BG = window.__NBOSP_BG || {};
        if (bg.email && bg.email.__patchedStartup) return;
        const svc = bg.email = bg.email || {};
        svc.__patchedStartup = true;
        try { svc.ensureBooted?.(); } catch (e) { }
      })();


