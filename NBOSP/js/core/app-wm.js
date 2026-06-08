
const WM = window.WM = {
        container: null,
        snapPreview: null,
        snapCompass: null,

        init() {
          WM.container = document.getElementById('windows');
          WM.snapPreview = document.getElementById('snap-preview');
          WM.snapCompass = document.getElementById('snap-compass');
        },

        createWindow(appId, options) {
          if (appId === 'launchpad') { toggleLaunchpad(); return null; }

          const id = generateId();
          const app = OS.apps[appId];
          if (!app) return null;

          const defaults = {
            width: app.defaultSize ? app.defaultSize[0] : 700,
            height: app.defaultSize ? app.defaultSize[1] : 500,
            x: 80 + Math.random() * 200,
            y: 40 + Math.random() * 100,
            minWidth: app.minSize ? app.minSize[0] : 300,
            minHeight: app.minSize ? app.minSize[1] : 200,
          };

          const cfg = { ...defaults, ...options };

          const win = createEl('div', {
            className: 'app-window opening',
            style: {
              left: cfg.x + 'px', top: cfg.y + 'px',
              width: cfg.width + 'px', height: cfg.height + 'px',
              zIndex: ++OS.windowZCounter
            },
            role: 'dialog',
            'aria-label': app.name + ' window'
          });
          win.dataset.windowId = id;
          win.dataset.appId = appId;

          // Resize handles
          const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
          for (const d of dirs) {
            win.appendChild(createEl('div', { className: `window-resize-handle ${d}`, 'aria-hidden': 'true' }));
          }

          // Title bar
          const titlebar = createEl('div', { className: 'window-titlebar' });

          const icon = createEl('div', { className: 'window-titlebar-icon' });
          icon.innerHTML = svgIcon(app.icon, 16);

          const titleText = createEl('span', { className: 'window-titlebar-text', textContent: app.name });

          const controls = createEl('div', { className: 'window-controls' });

          const closeBtn = createEl('button', {
            className: 'window-control-btn close',
            'aria-label': 'Close window'
          });
          const minBtn = createEl('button', {
            className: 'window-control-btn minimize',
            'aria-label': 'Minimize window'
          });
          const maxBtn = createEl('button', {
            className: 'window-control-btn maximize',
            'aria-label': 'Maximize window'
          });

          controls.appendChild(closeBtn);
          controls.appendChild(minBtn);
          controls.appendChild(maxBtn);
          titlebar.appendChild(icon);
          titlebar.appendChild(titleText);
          titlebar.appendChild(controls);
          win.appendChild(titlebar);

          // Content area
          const content = createEl('div', { className: 'window-content' });
          win.appendChild(content);

          WM.container.appendChild(win);

          const state = {
            id, appId, element: win, content, titlebar, titleText,
            x: cfg.x, y: cfg.y, width: cfg.width, height: cfg.height,
            minWidth: cfg.minWidth, minHeight: cfg.minHeight,
            maximized: false, minimized: false,
            preMaxState: null,
            snapSide: null, preSnapState: null,
            cleanups: []
          };
          OS.windows.set(id, state);

          // Clamp spawn position so window never starts outside the OS viewport
          const spawnClamped = WM.clampWindowRect(state, state.x, state.y, state.width, state.height);
          state.x = spawnClamped.x;
          state.y = spawnClamped.y;
          state.width = spawnClamped.w;
          state.height = spawnClamped.h;
          win.style.left = state.x + 'px';
          win.style.top = state.y + 'px';
          win.style.width = state.width + 'px';
          win.style.height = state.height + 'px';

          // Remove opening class precisely when animation ends
          win.addEventListener('animationend', () => win.classList.remove('opening'), { once: true });

          // Setup interactions
          WM.setupDrag(state);
          WM.setupResize(state);

          // Button handlers
          const onClose = () => WM.closeWindow(id);
          const onMin = () => WM.minimizeWindow(id);
          const onMax = () => WM.toggleMaximize(id);

          closeBtn.addEventListener('click', onClose);
          minBtn.addEventListener('click', onMin);
          maxBtn.addEventListener('click', onMax);
          state.cleanups.push(
            () => closeBtn.removeEventListener('click', onClose),
            () => minBtn.removeEventListener('click', onMin),
            () => maxBtn.removeEventListener('click', onMax)
          );

          // Focus on click
          const onFocus = () => WM.focusWindow(id);
          win.addEventListener('pointerdown', onFocus);
          state.cleanups.push(() => win.removeEventListener('pointerdown', onFocus));

          // Double-click titlebar to maximize
          const onDblClick = () => WM.toggleMaximize(id);
          titlebar.addEventListener('dblclick', onDblClick);
          state.cleanups.push(() => titlebar.removeEventListener('dblclick', onDblClick));

          WM.focusWindow(id);
          WM.updateTaskbar();

          // Initialize app
          try {
            if (app.init) app.init(content, state, options);
          } catch (e) { /* app init error */ }

          // ═══════════════════════════════════════════════════════════════
          // ADD DRAG-AND-DROP SUPPORT TO ALL APP WINDOWS
          // ═══════════════════════════════════════════════════════════════

          const onDragOver = (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            content.style.background = 'var(--bg-overlay)';
            content.style.borderRadius = '8px';
          };

          const onDragLeave = (e) => {
            if (e.target === content) {
              content.style.background = '';
              content.style.borderRadius = '';
            }
          };

          const onDrop = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            content.style.background = '';
            content.style.borderRadius = '';

            // Handle dropped files
            const files = e.dataTransfer.files;
            if (files.length > 0) {
              for (let i = 0; i < files.length; i++) {
                const file = files[i];

                // Call app's onDrop handler if it exists
                if (app.onDrop) {
                  try {
                    await app.onDrop(file, state);
                  } catch (err) { /* error handling */ }
                } else {
                  // Default behavior: try to open the file in appropriate app
                  const fileName = file.name;
                  const ext = fileName.split('.').pop().toLowerCase();

                  // Determine which app to open based on file type
                  let targetApp = 'vault';
                  if (['txt', 'md', 'js', 'html', 'css', 'json'].includes(ext)) targetApp = 'quill';

                  // Add file to filesystem and open
                  const fileId = generateId();
                  const fileData = await file.arrayBuffer();
                  let dropMime = file.type;
                  if (!dropMime) {
                    const dropExt = fileName.split('.').pop().toLowerCase();
                    const extMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', mp3: 'audio/mpeg', mp4: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json' };
                    dropMime = extMap[dropExt] || 'application/octet-stream';
                  }
                  const dropNode = { id: fileId, name: fileName, type: 'file', size: file.size, content: new Uint8Array(fileData), mimeType: dropMime, parentId: FS.specialFolders.desktop || FS.rootId, modified: Date.now() };
                  FS.files.set(fileId, dropNode);
                  await OS.workers.fs.call('putFiles', [dropNode]);

                  WM.createWindow(targetApp, { fileId });
                }
              }
            }

            // Handle dropped text (internal file references)
            const text = e.dataTransfer.getData('text/plain');
            if (text && app.onDropText) {
              try {
                app.onDropText(text, state);
              } catch (err) { /* error handling */ }
            }
          };

          content.addEventListener('dragover', onDragOver);
          content.addEventListener('dragleave', onDragLeave);
          content.addEventListener('drop', onDrop);

          state.cleanups.push(
            () => content.removeEventListener('dragover', onDragOver),
            () => content.removeEventListener('dragleave', onDragLeave),
            () => content.removeEventListener('drop', onDrop)
          );

          OS.events.emit('app:opened', { id, appId });
          return state;
        },

        closeWindow(id) {
          const state = OS.windows.get(id);
          if (!state) return;

          state.element.classList.add('closing');

          setTimeout(() => {
            for (const cleanup of state.cleanups) {
              try { cleanup(); } catch (e) { }
            }
            state.element.remove();
            OS.windows.delete(id);

            const app = OS.apps[state.appId];
            if (app && app.onClose) {
              try { app.onClose(state); } catch (e) { }
            }

            if (OS.focusedWindowId === id) {
              OS.focusedWindowId = null;
              const remaining = Array.from(OS.windows.values());
              if (remaining.length > 0) {
                const top = remaining.reduce((a, b) =>
                  parseInt(a.element.style.zIndex) > parseInt(b.element.style.zIndex) ? a : b
                );
                WM.focusWindow(top.id);
              }
            }

            WM.updateTaskbar();
            OS.events.emit('app:closed', { id, appId: state.appId });
          }, 150);
        },

        minimizeWindow(id) {
          const state = OS.windows.get(id);
          if (!state) return;
          state.minimized = true;
          state.element.classList.add('minimizing');
          if (OS.focusedWindowId === id) OS.focusedWindowId = null;
          WM.updateTaskbar();
          // Remove class after animation completes
          setTimeout(() => {
            if (state.minimized) state.element.style.display = 'none';
          }, 300);
        },

        restoreWindow(id) {
          const state = OS.windows.get(id);
          if (!state) return;
          state.minimized = false;
          state.element.style.display = '';
          state.element.classList.remove('minimizing');
          state.element.classList.add('window-restoring');
          WM.focusWindow(id);
          state.element.addEventListener('animationend', () => state.element.classList.remove('window-restoring'), { once: true });
          WM.updateTaskbar();
        },


        getWorkArea() {
          const vw = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
          const vh = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
          const tb = document.getElementById('taskbar');
          const area = { left: 0, top: 0, right: vw, bottom: vh };
          if (!tb) {
            return { ...area, width: vw, height: vh, taskbarHidden: true, taskbarPosition: 'bottom' };
          }

          const isHidden = tb.classList.contains('taskbar-autohide') && !tb.classList.contains('taskbar-ah-shown');
          if (isHidden) {
            return { ...area, width: vw, height: vh, taskbarHidden: true, taskbarPosition: 'bottom' };
          }

          const rect = tb.getBoundingClientRect();
          const style = window.getComputedStyle(tb);
          let position = 'bottom';
          if (style.left === '0px' && style.right === 'auto') position = 'left';
          else if (style.right === '0px' && style.left === 'auto') position = 'right';
          else if (style.top === '0px' && style.bottom === 'auto') position = 'top';

          const gap = 8;
          if (position === 'bottom') area.bottom = Math.max(area.top + 220, Math.floor(rect.top) - gap);
          else if (position === 'top') area.top = Math.min(area.bottom - 220, Math.ceil(rect.bottom) + gap);
          else if (position === 'left') area.left = Math.min(area.right - 320, Math.ceil(rect.right) + gap);
          else if (position === 'right') area.right = Math.max(area.left + 320, Math.floor(rect.left) - gap);

          return {
            ...area,
            width: Math.max(0, area.right - area.left),
            height: Math.max(0, area.bottom - area.top),
            taskbarHidden: false,
            taskbarPosition: position
          };
        },

        clampWindowRect(state, x, y, w, h) {
          const area = WM.getWorkArea();
          const minW = state.minWidth || 300;
          const minH = state.minHeight || 200;
          // Use full viewport for size clamping (not just work area) so windows
          // can be dragged partially under the taskbar
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const maxW = Math.max(minW, vw);
          const maxH = Math.max(minH, vh);
          const width = Math.min(Math.max(w, minW), maxW);
          const height = Math.min(Math.max(h, minH), maxH);
          // Horizontal: keep at least 80px of the window visible on each side.
          // Use window.innerWidth (not area.right) as the hard right boundary so a
          // window can never be placed beyond the actual viewport edge — which would
          // widen the document and cause the page to scroll horizontally.
          const grabMarginH = 80;
          const minX = area.left - width + grabMarginH;
          const maxX = Math.min(area.right, window.innerWidth) - grabMarginH;
          // Vertical: top edge must stay within the screen top + work area top
          // (so titlebar is reachable), and bottom is clamped to the taskbar top
          // so the titlebar can never be dragged fully behind the taskbar.
          const grabH = 32; // minimum titlebar height that must remain visible
          const minY = area.top;                     // can't go above work area top
          const maxY = area.bottom - grabH;          // titlebar must stay above taskbar
          return {
            x: Math.min(Math.max(x, minX), maxX),
            y: Math.min(Math.max(y, minY), maxY),
            w: width,
            h: height
          };
        },

        toggleMaximize(id) {
          const state = OS.windows.get(id);
          if (!state) return;
          state.element.classList.add('is-maximizing');
          setTimeout(() => state.element.classList.remove('is-maximizing'), 420);
          if (state.maximized) {
            state.maximized = false;
            state.element.classList.remove('maximized');
            state.element.classList.add('window-restoring');
            if (state.preMaxState) {
              state.element.style.left = state.preMaxState.x + 'px';
              state.element.style.top = state.preMaxState.y + 'px';
              state.element.style.width = state.preMaxState.w + 'px';
              state.element.style.height = state.preMaxState.h + 'px';
              state.x = state.preMaxState.x;
              state.y = state.preMaxState.y;
              state.width = state.preMaxState.w;
              state.height = state.preMaxState.h;
            }
            state.element.addEventListener('animationend', () => state.element.classList.remove('window-restoring'), { once: true });
          } else {
            state.preMaxState = { x: state.x, y: state.y, w: state.width, h: state.height };
            state.maximized = true;
            state.element.classList.add('maximized');
            const area = WM.getWorkArea();
            state.element.style.left = area.left + 'px';
            state.element.style.top = area.top + 'px';
            state.element.style.width = area.width + 'px';
            state.element.style.height = area.height + 'px';
            state.x = area.left;
            state.y = area.top;
            state.width = area.width;
            state.height = area.height;
          }
        },

        focusWindow(id) {
          const state = OS.windows.get(id);
          if (!state) return;
          if (state.minimized) WM.restoreWindow(id);
          state.element.style.zIndex = ++OS.windowZCounter;
          OS.focusedWindowId = id;
          for (const [wid, w] of OS.windows) {
            w.element.classList.toggle('focused', wid === id);
          }
          WM.updateTaskbar();
          OS.events.emit('app:focused', { id, appId: state.appId });

          // Route keyboard focus into the window so typing goes there immediately.
          // Prefer: a visible input/textarea that is already focused inside the window,
          // or the first visible input/textarea, or the window content itself.
          const win = state.element;
          const alreadyFocused = document.activeElement;
          if (!alreadyFocused || !win.contains(alreadyFocused)) {
            const focusable = win.querySelector(
              'input:not([type=hidden]):not([disabled]), textarea:not([disabled]), [contenteditable="true"]'
            );
            if (focusable) {
              // Small defer so pointer events don't immediately blur it
              requestAnimationFrame(() => focusable.focus());
            } else {
              // Fall back to making the window content itself keyboard-reachable
              const content = win.querySelector('.window-content');
              if (content) { content.tabIndex = -1; content.focus({ preventScroll: true }); }
            }
          }
        },

        setupDrag(state) {
          const titlebar = state.titlebar;
          let dragging = false, startX, startY, origX, origY;
          let snapZoneCandidate = null, snapZoneCandidateCount = 0;
          const SNAP_DWELL = 2;

          const onPointerDown = (e) => {
            if (e.target.closest('.window-controls')) return;
            if (state.maximized) {
              state.maximized = false;
              state.element.classList.remove('maximized');
              // Close the notification panel so it can't sit over the titlebar
              // and feed an off-screen clientX into the restored position calc.
              const _np = document.getElementById('notification-panel');
              if (_np && _np.classList.contains('active')) {
                _np.classList.remove('active');
              }
              if (state.preMaxState) {
                state.width = state.preMaxState.w;
                state.height = state.preMaxState.h;
                state.element.style.width = state.width + 'px';
                state.element.style.height = state.height + 'px';
                // Clamp the click X to the safe visible area so the restored window
                // is never placed off-screen (e.g. when the notification panel was
                // open and the user clicked through it at a far-right clientX).
                const _safeMaxX = window.innerWidth - 80;
                const _safeClientX = Math.min(e.clientX, _safeMaxX);
                const restored = WM.clampWindowRect(
                  state,
                  _safeClientX - (state.width / 2),
                  e.clientY - 10,
                  state.width,
                  state.height
                );
                state.x = restored.x;
                state.y = restored.y;
                state.element.style.left = state.x + 'px';
                state.element.style.top = state.y + 'px';
              }
            }
            // Un-snap: restore pre-snap size when user drags a snapped window
            if (state.snapSide) {
              state.snapSide = null;
              if (state.preSnapState) {
                state.width = state.preSnapState.w;
                state.height = state.preSnapState.h;
                state.element.style.width = state.width + 'px';
                state.element.style.height = state.height + 'px';
                const _safeSnapX = Math.min(e.clientX, window.innerWidth - 80);
                const _snapR = WM.clampWindowRect(state, _safeSnapX - state.width / 2, e.clientY - 10, state.width, state.height);
                state.x = _snapR.x;
                state.y = _snapR.y;
                state.element.style.left = state.x + 'px';
                state.element.style.top = state.y + 'px';
                state.preSnapState = null;
              }
            }
            dragging = true;
            startX = e.clientX; startY = e.clientY;
            origX = state.x; origY = state.y;
            state.element.style.transition = 'none';
            state.element.style.willChange = 'transform';
            state.element.classList.add('is-dragging');
            document.body.style.cursor = 'grabbing';
            e.preventDefault();
          };

          const onPointerMove = throttleRAF((e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const next = WM.clampWindowRect(state, origX + dx, origY + dy, state.width, state.height);
            state.x = next.x;
            state.y = next.y;
            state.element.style.transform = `translate(${state.x - origX}px, ${state.y - origY}px)`;

            // Zone detection with Alt-key suppression
            const rawZone = e.altKey ? null : WM.getSnapZone(e.clientX, e.clientY);

            // Dwell: require zone to be stable for SNAP_DWELL consecutive frames
            if (rawZone === snapZoneCandidate) {
              snapZoneCandidateCount = Math.min(snapZoneCandidateCount + 1, 10);
            } else {
              snapZoneCandidate = rawZone;
              snapZoneCandidateCount = 1;
            }
            const activeZone = (snapZoneCandidateCount >= SNAP_DWELL) ? snapZoneCandidate : null;

            // Compass: show when within 160px of any edge
            const W = window.innerWidth, H = window.innerHeight;
            const nearEdge = !e.altKey && (e.clientX < 160 || e.clientX > W - 160 || e.clientY < 160 || e.clientY > H - 160);
            if (nearEdge) {
              WM.showSnapCompass(activeZone);
            } else {
              WM.hideSnapCompass();
            }

            if (activeZone) {
              WM.showSnapPreview(activeZone);
            } else {
              WM.hideSnapPreview();
            }
          });

          const onPointerUp = (e) => {
            if (!dragging) return;
            dragging = false;
            state.element.classList.remove('is-dragging');
            state.element.style.transition = 'none';
            state.element.style.left = state.x + 'px';
            state.element.style.top = state.y + 'px';
            state.element.style.transform = 'none';
            document.body.style.cursor = '';
            requestAnimationFrame(() => {
              state.element.style.transform = '';
              state.element.style.willChange = '';
              requestAnimationFrame(() => {
                state.element.style.transition = '';
              });
            });

            const activeZone = (snapZoneCandidateCount >= SNAP_DWELL) ? snapZoneCandidate : null;
            if (activeZone) {
              if (activeZone === 'top') {
                WM.toggleMaximize(state.id);
              } else {
                WM.snapWindow(state, activeZone);
              }
            }
            snapZoneCandidate = null;
            snapZoneCandidateCount = 0;
            WM.hideSnapPreview();
            WM.hideSnapCompass();
          };

          titlebar.addEventListener('pointerdown', onPointerDown);
          document.addEventListener('pointermove', onPointerMove);
          document.addEventListener('pointerup', onPointerUp);
          state.cleanups.push(
            () => titlebar.removeEventListener('pointerdown', onPointerDown),
            () => document.removeEventListener('pointermove', onPointerMove),
            () => document.removeEventListener('pointerup', onPointerUp)
          );
        },

        setupResize(state) {
          const handles = state.element.querySelectorAll('.window-resize-handle');
          let resizing = false, dir = '', startX, startY, origX, origY, origW, origH;

          const onPointerDown = (e) => {
            if (state.maximized) return;
            resizing = true;
            dir = '';
            for (const d of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
              if (e.target.classList.contains(d)) { dir = d; break; }
            }
            startX = e.clientX; startY = e.clientY;
            origX = state.x; origY = state.y;
            origW = state.width; origH = state.height;
            state.element.style.transition = 'none';
            state.element.style.backdropFilter = 'none';
            state.element.style.webkitBackdropFilter = 'none';
            state.element.classList.add('is-resizing');
            e.preventDefault();
            e.stopPropagation();
          };

          const onPointerMove = throttleRAF((e) => {
            if (!resizing) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            let newW = origW, newH = origH, newX = origX, newY = origY;

            if (dir.includes('e')) newW = Math.max(state.minWidth, origW + dx);
            if (dir.includes('w')) { newW = Math.max(state.minWidth, origW - dx); newX = origX + origW - newW; }
            if (dir.includes('s')) newH = Math.max(state.minHeight, origH + dy);
            if (dir.includes('n')) { newH = Math.max(state.minHeight, origH - dy); newY = origY + origH - newH; }

            const next = WM.clampWindowRect(state, newX, newY, newW, newH);
            state.width = next.w;
            state.height = next.h;
            state.x = next.x;
            state.y = next.y;
            state.element.style.width = next.w + 'px';
            state.element.style.height = next.h + 'px';
            state.element.style.left = next.x + 'px';
            state.element.style.top = next.y + 'px';
          });

          const onPointerUp = () => {
            if (!resizing) return;
            resizing = false;
            state.element.classList.remove('is-resizing');
            state.element.style.transition = '';
            state.element.style.backdropFilter = '';
            state.element.style.webkitBackdropFilter = '';
          };

          handles.forEach(h => h.addEventListener('pointerdown', onPointerDown));
          document.addEventListener('pointermove', onPointerMove);
          document.addEventListener('pointerup', onPointerUp);
          state.cleanups.push(
            () => handles.forEach(h => h.removeEventListener('pointerdown', onPointerDown)),
            () => document.removeEventListener('pointermove', onPointerMove),
            () => document.removeEventListener('pointerup', onPointerUp)
          );
        },

        // ── Returns the snap zone name for a pointer position, or null ──
        getSnapZone(x, y) {
          const W = window.innerWidth;
          const H = window.innerHeight;
          const CORNER = 80;
          const EDGE = 40;
          // Corners take priority over edges
          if (x < CORNER && y < CORNER)     return 'top-left';
          if (x > W - CORNER && y < CORNER) return 'top-right';
          if (x < CORNER && y > H - CORNER) return 'bottom-left';
          if (x > W - CORNER && y > H - CORNER) return 'bottom-right';
          // Edges
          if (x < EDGE)         return 'left';
          if (x > W - EDGE)     return 'right';
          if (y < EDGE)         return 'top';
          if (y > H - EDGE)     return 'bottom';
          return null;
        },

        // ── Returns {x,y,w,h} for a zone relative to the work area ──
        getSnapRect(zone) {
          const a = WM.getWorkArea();
          const hw = Math.floor(a.width / 2);
          const hh = Math.floor(a.height / 2);
          const map = {
            'left':         { x: a.left,      y: a.top,      w: hw,           h: a.height      },
            'right':        { x: a.left + hw,  y: a.top,      w: a.width - hw, h: a.height      },
            'top':          { x: a.left,      y: a.top,      w: a.width,      h: a.height      },
            'bottom':       { x: a.left,      y: a.top + hh, w: a.width,      h: a.height - hh },
            'top-left':     { x: a.left,      y: a.top,      w: hw,           h: hh            },
            'top-right':    { x: a.left + hw,  y: a.top,      w: a.width - hw, h: hh            },
            'bottom-left':  { x: a.left,      y: a.top + hh, w: hw,           h: a.height - hh },
            'bottom-right': { x: a.left + hw,  y: a.top + hh, w: a.width - hw, h: a.height - hh },
          };
          return map[zone] || null;
        },

        snapWindow(state, zone) {
          const r = WM.getSnapRect(zone);
          if (!r) return;
          // Save pre-snap state only on first snap (not when re-snapping to another zone)
          if (!state.snapSide) {
            state.preSnapState = { x: state.x, y: state.y, w: state.width, h: state.height };
          }
          state.snapSide = zone;
          state.preMaxState = state.preSnapState; // keep maximize compat
          const next = WM.clampWindowRect(state, r.x, r.y, r.w, r.h);
          state.x = next.x; state.y = next.y; state.width = next.w; state.height = next.h;
          state.element.style.left   = state.x + 'px';
          state.element.style.top    = state.y + 'px';
          state.element.style.width  = state.width + 'px';
          state.element.style.height = state.height + 'px';
        },

        showSnapPreview(zone) {
          const r = WM.getSnapRect(zone);
          if (!r) return;
          const el = WM.snapPreview;
          if (!el.classList.contains('visible')) {
            // First appearance: position instantly, then fade in (no position teleport)
            el.style.transition = 'none';
            el.style.left   = r.x + 'px';
            el.style.top    = r.y + 'px';
            el.style.width  = r.w + 'px';
            el.style.height = r.h + 'px';
            el.offsetHeight; // force reflow
            el.style.transition = '';
            el.classList.add('visible');
          } else {
            // Already visible: CSS transition animates position/size to new zone
            el.style.left   = r.x + 'px';
            el.style.top    = r.y + 'px';
            el.style.width  = r.w + 'px';
            el.style.height = r.h + 'px';
          }
        },

        hideSnapPreview() {
          WM.snapPreview.classList.remove('visible');
        },

        showSnapCompass(activeZone) {
          const compass = WM.snapCompass;
          if (!compass) return;
          compass.classList.add('visible');
          compass.querySelectorAll('.sc-zone').forEach(el => {
            el.classList.toggle('active', el.dataset.zone === activeZone);
          });
        },

        hideSnapCompass() {
          if (WM.snapCompass) WM.snapCompass.classList.remove('visible');
        },

        updateTaskbar() {
          const container = document.getElementById('taskbar-apps');
          container.innerHTML = '';

          const pinnedApps = OS.settings.get('pinnedApps') || [];

          // Group open windows by appId
          const appWindows = new Map();
          for (const [id, state] of OS.windows) {
            if (!appWindows.has(state.appId)) appWindows.set(state.appId, []);
            appWindows.get(state.appId).push({ id, state });
          }

          // Build ordered list: pinned first (in order), then any running-but-not-pinned apps
          const seen = new Set();
          const orderedIds = [...pinnedApps];
          for (const appId of appWindows.keys()) {
            if (!seen.has(appId) && !pinnedApps.includes(appId)) orderedIds.push(appId);
          }

          for (const appId of orderedIds) {
            const app = OS.apps[appId];
            const windows = appWindows.get(appId) || [];
            const isPinned = pinnedApps.includes(appId);
            // Skip pinned IDs that have no registered app (not installed)
            if (!app) continue;

            const hasWindows = windows.length > 0;
            const hasMultipleWindows = windows.length > 1;
            const isAnyActive = windows.some(w => OS.focusedWindowId === w.id && !w.state.minimized);

            const btn = createEl('button', {
              className: 'taskbar-app-btn' + (isAnyActive ? ' active' : '') + (isPinned ? ' pinned' : ''),
              'aria-label': app.name + (hasMultipleWindows ? ` (${windows.length} windows)` : '')
            });

            let badge = hasMultipleWindows ? `<span class="taskbar-window-count">${windows.length}</span>` : '';
            btn.innerHTML = svgIcon(app.icon, 20) + '<span class="indicator"></span>' + badge;

            const clickHandler = () => {
              if (!hasWindows) {
                WM.createWindow(appId);
              } else if (hasMultipleWindows) {
                showWindowPreview(btn, appId, windows);
              } else {
                const { id, state } = windows[0];
                if (OS.focusedWindowId === id && !state.minimized) WM.minimizeWindow(id);
                else WM.focusWindow(id);
              }
            };

            const contextMenuHandler = (e) => {
              e.preventDefault();
              const menuItems = [];
              if (hasMultipleWindows) {
                windows.forEach((w, index) => {
                  const winTitle = w.state.title || `Window ${index + 1}`;
                  menuItems.push({ label: winTitle, icon: OS.focusedWindowId === w.id ? 'check' : 'square', action: () => WM.focusWindow(w.id) });
                });
                menuItems.push({ separator: true });
              }
              if (hasWindows) {
                menuItems.push({ label: hasMultipleWindows ? 'Close All Windows' : 'Close Window', icon: 'x', danger: true, action: () => windows.forEach(w => WM.closeWindow(w.id)) });
                menuItems.push({ separator: true });
              } else {
                menuItems.push({ label: 'Open', icon: 'play', action: () => WM.createWindow(appId) });
                menuItems.push({ separator: true });
              }
              menuItems.push({
                label: isPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar',
                icon: isPinned ? 'pin-off' : 'pin',
                action: () => {
                  const pins = OS.settings.get('pinnedApps') || [];
                  const next = isPinned ? pins.filter(id => id !== appId) : [...pins, appId];
                  OS.settings.set('pinnedApps', next);
                  WM.updateTaskbar();
                  Notify.show({ title: isPinned ? 'Unpinned' : 'Pinned', body: `${app.name} ${isPinned ? 'removed from' : 'pinned to'} taskbar`, type: 'success', appName: 'Taskbar' });
                }
              });
              ContextMenu.show(e.clientX, e.clientY, menuItems);
            };

            btn.addEventListener('click', clickHandler);
            btn.addEventListener('contextmenu', contextMenuHandler);
            container.appendChild(btn);
          }
        },

        minimizeAll() {
          for (const [id] of OS.windows) WM.minimizeWindow(id);
        },

        getWorkspaceWindows(workspaceId) {
          const ws = OS.workspaces.find(w => w.id === workspaceId);
          return ws ? ws.windows.map(id => OS.windows.get(id)).filter(Boolean) : [];
        }
      };

      // Window preview popup for switching between multiple windows
      function showWindowPreview(btn, appId, windows) {
        // Remove any existing preview
        const existingPreview = document.querySelector('.taskbar-window-preview');
        if (existingPreview) existingPreview.remove();

        const preview = createEl('div', { className: 'taskbar-window-preview' });

        windows.forEach((w, index) => {
          const app = OS.apps[appId];
          const winTitle = w.state.title || `Window ${index + 1}`;
          const isActive = OS.focusedWindowId === w.id && !w.state.minimized;

          const item = createEl('div', {
            className: 'preview-window-item' + (isActive ? ' active' : '')
          });

          const icon = createEl('span', { className: 'preview-icon' });
          icon.innerHTML = svgIcon(app.icon, 16);

          const title = createEl('span', {
            className: 'preview-title',
            textContent: winTitle
          });

          const closeBtn = createEl('button', {
            className: 'preview-close',
            'aria-label': 'Close window'
          });
          closeBtn.innerHTML = svgIcon('x', 12);
          closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            WM.closeWindow(w.id);
            preview.remove();
          });

          item.appendChild(icon);
          item.appendChild(title);
          item.appendChild(closeBtn);

          item.addEventListener('click', () => {
            WM.focusWindow(w.id);
            preview.remove();
          });

          preview.appendChild(item);
        });

        // Position preview above the button
        document.body.appendChild(preview);
        const btnRect = btn.getBoundingClientRect();
        const previewRect = preview.getBoundingClientRect();

        let left = btnRect.left + (btnRect.width / 2) - (previewRect.width / 2);
        let bottom = window.innerHeight - btnRect.top + 8;

        // Keep preview within viewport
        if (left < 8) left = 8;
        if (left + previewRect.width > window.innerWidth - 8) {
          left = window.innerWidth - previewRect.width - 8;
        }

        preview.style.left = left + 'px';
        preview.style.bottom = bottom + 'px';

        // Close preview when clicking outside
        const dismiss = (e) => {
          if (!preview.contains(e.target) && e.target !== btn) {
            preview.remove();
            document.removeEventListener('pointerdown', dismiss);
          }
        };
        setTimeout(() => document.addEventListener('pointerdown', dismiss), 10);
      }

// ── EXPOSE TO GLOBAL RUNTIME SCOPE ───────────────────────────────────────────
if (typeof WM !== 'undefined') window.WM = WM;
if (typeof WindowInstance !== 'undefined') window.WindowInstance = WindowInstance;
