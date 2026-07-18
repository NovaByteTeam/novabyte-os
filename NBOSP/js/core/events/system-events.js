// GLOBAL EVENT HANDLERS — system-events.js
// Comprehensive rewrite: 20 bugs fixed, security hardened, memory leaks sealed,
// performance optimised to ES2026 standards.
//
// Fix index quick-reference:
//  #1  scanFileForThreats — /g + .test() lastIndex bypass (CRITICAL security hole)
//  #2  Volume controls — null-check all four elements before binding handlers
//  #3  verifyPin — enforce OS.lockoutUntil at entry (CRITICAL security bypass)
//  #4  Wipe countdown — module-level ID so biometric unlock can cancel it (DATA LOSS)
//  #5  switchWorkspace — maxWorkspaces was undefined (ReferenceError crash)
//  #6  Web-app context menu "Open" — double toggleLaunchpad via item.click()
//  #7  dragImg removeChild — guard against NotFoundError if already removed
//  #8  Launchpad search — [style=""] selector never matched animated items
//  #9  checkFileExtension — null filename / extensionless file crash
// #10  Recovery footer clock — setInterval leaked on every _doShowRecoveryScreen call
// #11  captureScreenshot — stream tracks not stopped when play/drawImage throws
// #12  Biometric credentialId — atob() replaced with Uint8Array.fromBase64() (ES2026)
// #13  Web-app draggable — duplicate assignment removed
// #14  Launchpad search — two redundant querySelectorAll calls collapsed to one
// #15  matchMedia — re-queried on every launchpad open; now cached with listener
// #16  batteryBtn.innerHTML — replaced with textContent / DOM API (XSS hygiene)
// #17  Snake onKey — direction map rebuilt on every keydown; moved to module level
// #18  Launchpad search debounce — (e.target || this).value → reliable e.target.value
// #19  updateNotificationBadge — badge.textContent without null check
// #20  wireRecoveryControls — resolved against window.screen instead of DOM element

// ── Cached media query (#15) ──────────────────────────────────────────────────
const _reducedMotionMQ = window.matchMedia('(prefers-reduced-motion: reduce)');

// ── Module-level wipe countdown ID (#4) ──────────────────────────────────────
// Must be accessible by both verifyPin() and unlockFromLockScreen()
let _wipeCountdownId = 0;

// ── Module-level recovery footer-clock ID (#10) ───────────────────────────────
let _recoveryClockId = 0;

// ── Snake direction map (#17) — one constant, zero allocations per keypress ───
const _SNAKE_DIR_MAP = Object.freeze({
  ArrowUp:    { x: 0, y: -1 }, w: { x: 0, y: -1 }, W: { x: 0, y: -1 },
  ArrowDown:  { x: 0, y:  1 }, s: { x: 0, y:  1 }, S: { x: 0, y:  1 },
  ArrowLeft:  { x: -1, y: 0 }, a: { x: -1, y: 0 }, A: { x: -1, y: 0 },
  ArrowRight: { x:  1, y: 0 }, d: { x:  1, y: 0 }, D: { x:  1, y: 0 },
});

// ── Threat patterns (#1) — compiled once WITHOUT /g so .test() is always stateless ─
const _THREAT_PATTERNS = Object.freeze([
  { regex: /<script[\s\S]*?alert\s*\(/i,     name: 'alert-xss',       severity: 'high'     },
  { regex: /onerror\s*=\s*["']alert/i,        name: 'onerror-alert',   severity: 'high'     },
  { regex: /onclick\s*=\s*["']alert/i,         name: 'onclick-alert',   severity: 'high'     },
  { regex: /eval\s*\(\s*atob\s*\(/i,           name: 'encoded-eval',    severity: 'critical' },
  { regex: /eval\s*\(\s*decodeURIComponent/i,  name: 'uri-decode-eval', severity: 'critical' },
]);

// ── Desktop shortcut helper ────────────────────────────────────────────────────
function _hasDesktopShortcut(appId) {
  try {
    const desktopFolder = FS.specialFolders?.desktop;
    if (!desktopFolder) return false;
    const files = FS.listDir(desktopFolder);
    for (const f of files) {
      if (f.name.endsWith('.lnk') && f.mimeType === 'application/x-app-shortcut') {
        try {
          if (JSON.parse(f.content || '{}')?.target === appId) return true;
        } catch { /* skip invalid shortcuts */ }
      }
    }
    return false;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAUNCHPAD
// ═══════════════════════════════════════════════════════════════════════════════

document.getElementById('start-btn').addEventListener('click', toggleLaunchpad);

function toggleLaunchpad() {
  const launchpad = document.getElementById('launchpad');
  const isClosing = launchpad.classList.contains('active');
  launchpad.classList.toggle('active');
  if (launchpad.classList.contains('active')) {
    renderLaunchpad();
    const searchEl = document.getElementById('launchpad-search');
    searchEl.value = '';
    setTimeout(() => {
      searchEl.focus();
      searchEl.select();
    }, 50);
  } else if (isClosing) {
    const marks = launchpad.querySelectorAll('.launchpad-name mark');
    marks.forEach(mark => {
      const parent = mark.parentNode;
      if (parent) parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent?.normalize?.();
    });
  }
}

function renderLaunchpad() {
  const grid = document.getElementById('launchpad-grid');
  const devMode = OS.settings.get('devMode');
  const apps = devMode ? APP_REGISTRY : APP_REGISTRY.filter(app => !app.devOnly);
  const webApps = (typeof WebAppManager !== 'undefined' && WebAppManager.getAllApps)
    ? WebAppManager.getAllApps()
    : [];

  const signature = [
    ...apps.map(app => `${app.id}:${app.name}:${app.icon}`),
    ...webApps.map(wa => `web:${wa.id}:${wa.name}:${wa.icon}:${wa.url}`)
  ].join('||');

  const needsRebuild =
    grid.dataset.renderedSignature !== signature || grid.children.length === 0;

  if (needsRebuild) {
    grid.innerHTML = '';
    grid.dataset.renderedSignature = signature;

    // ── Native app items ───────────────────────────────────────────────────────
    const appendAppItem = (app) => {
      const item = createEl('button', {
        className: 'launchpad-item',
        'aria-label': app.name,
        draggable: 'true'
      });
      const icon = createEl('div', { className: 'launchpad-icon' });
      icon.innerHTML = svgIcon(app.id && app.id.startsWith('webapp_') ? app.icon : (app.icon || '/assets/no_app_icon.svg'), 28);
      item.appendChild(icon);
      item.appendChild(createEl('div', { className: 'launchpad-name', textContent: app.name }));

      item.addEventListener('click', () => { toggleLaunchpad(); WM.createWindow(app.id); });

      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pinnedApps = OS.settings.get('pinnedApps') || [];
        const isPinned   = pinnedApps.includes(app.id);
        const storedApps = (() => {
          try { return JSON.parse(localStorage.getItem('nova_installed_apps') || '[]'); } catch { return []; }
        })();
        const isUserApp = storedApps.some(a => a.id === app.id);

        const menuItems = [
          { label: 'Open', icon: 'play', action: () => { toggleLaunchpad(); WM.createWindow(app.id); } },
          { separator: true },
          {
            label: isPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar',
            icon: 'pin',
            action: () => {
              const pins = OS.settings.get('pinnedApps') || [];
              if (isPinned) {
                const next = pins.filter(id => id !== app.id);
                OS.settings.set('pinnedApps', next);
                WM.updateTaskbar();
                Notify.show({ title: 'Unpinned', body: `${app.name} removed from taskbar`, type: 'success', appName: 'Launchpad' });
              } else {
                if (pins.includes(app.id)) {
                  Notify.show({ title: 'Already Pinned', body: `${app.name} is already pinned to taskbar`, type: 'info', appName: 'Launchpad' });
                  return;
                }
                const next = [...pins, app.id];
                OS.settings.set('pinnedApps', next);
                WM.updateTaskbar();
                Notify.show({ title: 'Pinned', body: `${app.name} pinned to taskbar`, type: 'success', appName: 'Launchpad' });
              }
            }
          }
        ];

        const hasShortcut = _hasDesktopShortcut(app.id);
        if (hasShortcut) {
          menuItems.push({ separator: true }, {
            label: 'Unpin from Desktop', icon: 'pin',
            action: async () => {
              try {
                const desktopFolder = FS.specialFolders?.desktop;
                if (desktopFolder) {
                  const files = FS.listDir(desktopFolder);
                  let removed = 0;
                  const iconPositions = OS.settings.get('desktopIconPositions') || {};
                  for (const f of files) {
                    if (f.name.endsWith('.lnk') && f.mimeType === 'application/x-app-shortcut') {
                      try {
                        const data = JSON.parse(f.content || '{}');
                        if (data?.type === 'app-shortcut' && data?.target === app.id) {
                          await FS.permanentDelete(f.id);
                          delete iconPositions['file:' + f.id];
                          removed++;
                        }
                      } catch { /* skip invalid shortcuts */ }
                    }
                  }
                  OS.settings.set('desktopIconPositions', iconPositions);
                  renderDesktopIcons();
                  WM.updateTaskbar();
                  Notify.show({
                    title: 'Unpinned from Desktop',
                    body: removed > 0
                      ? `Removed ${removed} desktop shortcut${removed > 1 ? 's' : ''} for ${app.name}`
                      : `No desktop shortcuts found for ${app.name}`,
                    type: 'success', appName: 'Launchpad'
                  });
                }
              } catch (err) {
                Notify.show({ title: 'Error', body: `Failed to unpin from desktop: ${err.message}`, type: 'error', appName: 'Launchpad' });
              }
            }
          });
        } else {
          menuItems.push({ separator: true }, {
            label: 'Pin to Desktop', icon: 'pin',
            action: async () => {
              try {
                const desktopFolder = FS.specialFolders?.desktop;
                if (desktopFolder) {
                  const shortcutName = app.name + '.lnk';
                  const shortcutContent = JSON.stringify({
                    target: app.id,
                    type: 'app-shortcut',
                    icon: app.icon
                  });
                  await FS.createFile(desktopFolder, shortcutName, shortcutContent, 'application/x-app-shortcut');
                  renderDesktopIcons();
                  Notify.show({ title: 'Pinned to Desktop', body: `${app.name} shortcut added to desktop`, type: 'success', appName: 'Launchpad' });
                }
              } catch (err) {
                Notify.show({ title: 'Error', body: `Failed to pin to desktop: ${err.message}`, type: 'error', appName: 'Launchpad' });
              }
            }
          });
        }

        if (isUserApp) {
          menuItems.push({ separator: true }, {
            label: 'Uninstall', icon: 'trash', danger: true,
            action: async () => {
              toggleLaunchpad();
              const uninstallResult = await showModal(
                'Uninstall App',
                `Uninstall "${app.name}"? This cannot be undone.`,
                [{ label: 'Cancel' }, { label: 'Uninstall', value: 'confirm', danger: true }]
              );
              if (uninstallResult !== 'confirm') return;
              try {
                if (typeof WM !== 'undefined' && WM.closeWindow && typeof OS !== 'undefined' && OS.windows) {
                  const openWindowIds = [];
                  for (const [wid, wstate] of OS.windows) {
                    if (wstate.appId === app.id) openWindowIds.push(wid);
                  }
                  await Promise.all(openWindowIds.map(wid => WM.closeWindow(wid)));
                }
                if (window.NovaAppPackageStore?.removeApp) {
                  await NovaAppPackageStore.removeApp(app.id);
                } else {
                  const stored = JSON.parse(localStorage.getItem('nova_installed_apps') || '[]');
                  localStorage.setItem(
                    'nova_installed_apps',
                    JSON.stringify(stored.filter(a => a.id !== app.id))
                  );
                }
                try {
                  if (typeof AppSandbox !== 'undefined' && AppSandbox.clearAppPartition) {
                    await AppSandbox.clearAppPartition(app.id);
                  }
                } catch (err) {
                  console.warn('[Launchpad] Failed to clear storage partition for', app.id, err);
                }
                try {
                  if (typeof AppDirs !== 'undefined' && AppDirs.removeAppData) {
                    await AppDirs.removeAppData(app.id);
                  }
                } catch (err) {
                  console.warn('[Launchpad] Failed to clear app data for', app.id, err);
                }
                if (typeof AppRegistry !== 'undefined' && AppRegistry.unregisterApp) {
                  AppRegistry.unregisterApp(app.id);
                }
                delete OS.apps[app.id];
                const ri = APP_REGISTRY.findIndex(a => a.id === app.id);
                if (ri > -1) APP_REGISTRY.splice(ri, 1);
                OS.settings.set('pinnedApps', (OS.settings.get('pinnedApps') || []).filter(id => id !== app.id));
                try {
                  const disabled = JSON.parse(localStorage.getItem('nova_disabled_apps') || '[]');
                  const updated = disabled.filter(x => (typeof x === 'string' ? x : x?.id) !== app.id);
                  localStorage.setItem('nova_disabled_apps', JSON.stringify(updated));
                } catch { /* quota */ }
                try {
                  const bootApps = JSON.parse(localStorage.getItem('nova_boot_apps') || '[]');
                  const updated = bootApps.filter(id => id !== app.id);
                  localStorage.setItem('nova_boot_apps', JSON.stringify(updated));
                } catch { /* quota */ }
                try {
                  const desktopFolder = FS.specialFolders?.desktop;
                  if (desktopFolder) {
                    const files = FS.listDir(desktopFolder);
                    for (const f of files) {
                      if (f.name.endsWith('.lnk') && f.mimeType === 'application/x-app-shortcut') {
                        try {
                          const data = JSON.parse(f.content || '{}');
                          if (data?.type === 'app-shortcut' && data?.target === app.id) {
                            await FS.permanentDelete(f.id);
                          }
                        } catch { /* skip invalid shortcuts */ }
                      }
                    }
                  }
                } catch (err) {
                  console.warn('[Launchpad] Failed to clean up shortcuts for', app.id, err);
                  if (typeof EventLog !== 'undefined') {
                    EventLog.log({ app: 'Launchpad', category: 'apps', severity: 'warn', message: `Failed to clean up desktop shortcuts for ${app.id}: ${err?.message || err}`, data: { appId: app.id } });
                  }
                }
                renderDesktopIcons();
                WM.updateTaskbar();
                if (document.getElementById('launchpad')?.classList.contains('active')) renderLaunchpad();
                Notify.show({ title: 'Uninstalled', body: `${app.name} has been removed.`, type: 'success', appName: 'Launchpad' });
              } catch (err) {
                Notify.show({ title: 'Error', body: `Failed to uninstall: ${err.message}`, type: 'error', appName: 'Launchpad' });
              }
            }
          });
        }

        ContextMenu.show(e.clientX, e.clientY, menuItems);
      });

      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('application/json', JSON.stringify({
          type: 'app-shortcut', appId: app.id, appName: app.name, appIcon: app.icon
        }));
        e.dataTransfer.setData('text/plain', app.name);
        const dragImg = createEl('div', {
          style: 'padding:8px 16px;background:var(--accent);color:#fff;border-radius:8px;font-size:12px;font-family:var(--font-ui);position:fixed;top:-200px;left:-200px;'
        });
        dragImg.textContent = app.name;
        document.body.appendChild(dragImg);
        e.dataTransfer.setDragImage(dragImg, dragImg.offsetWidth / 2, dragImg.offsetHeight / 2);
        requestAnimationFrame(() => {
          // #7: guard against NotFoundError — rAF may fire after dragcancel already removed it
          if (dragImg.parentNode === document.body) document.body.removeChild(dragImg);
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

    // ── Web-app items ──────────────────────────────────────────────────────────
    if (typeof WebAppManager !== 'undefined') {
      webApps.forEach(webApp => {
        const item = createEl('button', {
          className: 'launchpad-item',
          'aria-label': `${webApp.name} (Web App)`,
          // cap URL length to prevent tooltip reflow spam from 50KB data URIs
          title: typeof webApp.url === 'string' ? webApp.url.slice(0, 2048) : '',
          draggable: 'true'   // #13: set once here — duplicate assignment below removed
        });

        const icon = createEl('div', {
          className: 'launchpad-icon',
          style: 'font-size: 28px; line-height: 1;'
        });
        if (webApp.icon) {
          if (/^data:|^https?:\/\//i.test(webApp.icon)) {
            const img = createEl('img', { src: webApp.icon, style: 'width:100%;height:100%;object-fit:cover;pointer-events:none;border-radius:inherit;', draggable: 'false', crossorigin: 'anonymous' });
            img.onerror = () => { icon.innerHTML = svgIcon('globe', 28); };
            icon.appendChild(img);
          } else {
            icon.textContent = webApp.icon;
          }
        } else {
          icon.innerHTML = svgIcon('globe', 28);
        }

        const name = createEl('div', { className: 'launchpad-name', textContent: webApp.name });
        const indicator = createEl('div', {
          style: 'position:absolute;bottom:4px;right:4px;width:8px;height:8px;background:#58a6ff;border-radius:50%;border:1px solid rgba(255,255,255,0.3);',
          title: 'Web App'
        });

        item.appendChild(icon);
        item.appendChild(name);
        item.appendChild(indicator);

        // #6: extracted launch logic so context-menu "Open" can call it directly
        // without going through item.click() which would double-fire toggleLaunchpad()
        //
        // Delegates to openWebApp() (registry.js), which sets OS.apps[id].init()
        // so the webview actually renders. This used to build the <webview>
        // by hand and append it to windowElement.content right after
        // createWindow() returned — which meant a window opened this way
        // rendered fine the first time, but reopening it later via the
        // taskbar or a desktop shortcut (which just call WM.createWindow()
        // with no iframe-building step) produced a blank window, since only
        // this one call site ever built the content.
        function launchWebApp() {
          toggleLaunchpad();
          try {
            if (typeof window.openWebApp !== 'function') throw new Error('Web app launcher unavailable');
            const windowElement = window.openWebApp(webApp.id);
            if (!windowElement) throw new Error('Web app not found');
          } catch (error) {
            Notify.show({
              title: 'Error', body: `Failed to launch app: ${error.message}`,
              type: 'error', appName: 'System'
            });
          }
        }

        item.addEventListener('click', launchWebApp);

        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const waPins    = OS.settings.get('pinnedApps') || [];
          const waId      = 'webapp_' + webApp.id;
          const waIsPinned = waPins.includes(waId);
          ContextMenu.show(e.clientX, e.clientY, [
            // #6: call launchWebApp — not item.click() — to avoid double toggleLaunchpad
            { label: 'Open', icon: 'play', action: launchWebApp },
            { separator: true },
            {
              label: waIsPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar',
              icon: 'pin',
              action: () => {
                const p = OS.settings.get('pinnedApps') || [];
                if (waIsPinned) {
                  const next = p.filter(id => id !== waId);
                  OS.settings.set('pinnedApps', next);
                  if (typeof WM !== 'undefined' && WM.updateTaskbar) WM.updateTaskbar();
                  Notify.show({ title: 'Unpinned', body: `${webApp.name} unpinned from taskbar`, type: 'success', appName: 'Launchpad' });
                } else {
                  if (p.includes(waId)) {
                    Notify.show({ title: 'Already Pinned', body: `${webApp.name} is already pinned to taskbar`, type: 'info', appName: 'Launchpad' });
                    return;
                  }
                  const next = [...p, waId];
                  OS.settings.set('pinnedApps', next);
                  if (typeof WM !== 'undefined' && WM.updateTaskbar) WM.updateTaskbar();
                  Notify.show({ title: 'Pinned', body: `${webApp.name} pinned to taskbar`, type: 'success', appName: 'Launchpad' });
                }
              }
            },
            { separator: true },
            {
              label: 'Remove Web App', icon: 'trash', danger: true,
              action: async () => {
                // removeWebApp (registry.js) also unpins from the taskbar
                // and deletes any desktop .lnk shortcut, not just the
                // WebAppManager record — matches the Web Apps tab's Remove
                // button and the desktop shortcut's own Remove Web App item.
                if (typeof window.removeWebApp === 'function') {
                  await window.removeWebApp(webApp.id);
                } else {
                  WebAppManager.removeApp(webApp.id);
                }
                renderLaunchpad();
                Notify.show({ title: 'Removed', body: `"${webApp.name}" has been removed`, type: 'success', appName: 'Launchpad' });
              }
            }
          ]);
        });

        // #13: duplicate `item.draggable = true` removed — already set in createEl above

        item.addEventListener('dragstart', (e) => {
          const webAppId = 'webapp_' + webApp.id;
          e.dataTransfer.effectAllowed = 'copy';
          e.dataTransfer.setData('application/json', JSON.stringify({
            type: 'app-shortcut', appId: webAppId, appName: webApp.name, appIcon: webApp.icon
          }));
          e.dataTransfer.setData('text/plain', webApp.name);
          const dragImg = createEl('div', {
            style: 'padding:8px 16px;background:var(--accent);color:#fff;border-radius:10px;font-size:12px;font-family:var(--font-ui);position:fixed;top:-200px;left:-200px;'
          });
          dragImg.textContent = webApp.name;
          document.body.appendChild(dragImg);
          e.dataTransfer.setDragImage(dragImg, dragImg.offsetWidth / 2, dragImg.offsetHeight / 2);
          requestAnimationFrame(() => {
            // #7: guard removeChild — rAF may fire after dragcancel
            if (dragImg.parentNode === document.body) document.body.removeChild(dragImg);
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
    // Already built — just reset animation state for re-open
    Array.from(grid.children).forEach(item => {
      item.classList.remove('animate');
      item.style.opacity   = '0';
      item.style.transform = 'scale(0)';
      item.style.removeProperty('--delay');
      item.style.willChange = '';
      item.style.display    = '';
    });
  }

  // ── Stagger animation ────────────────────────────────────────────────────────
  requestAnimationFrame(() => {
    // #15: use cached MQ — window.matchMedia() is not free; never re-query per open
    const prefersReducedMotion =
      OS.settings.get('reduceMotion') || _reducedMotionMQ.matches;
    const items = Array.from(grid.querySelectorAll('.launchpad-item'))
      .filter(item => item.style.display !== 'none');

    if (prefersReducedMotion) {
      items.forEach(item => {
        item.style.opacity   = '1';
        item.style.transform = 'scale(1)';
        item.classList.add('animate');
      });
      return;
    }

    const gridWidth  = grid.offsetWidth;
    const gridHeight = grid.offsetHeight;
    const centerX    = gridWidth  / 2;
    const centerY    = gridHeight / 2;
    const maxDist    = Math.sqrt((gridWidth / 2) ** 2 + (gridHeight / 2) ** 2) || 1;

    items.forEach(item => {
      const cx = item.offsetLeft + item.offsetWidth  / 2;
      const cy = item.offsetTop  + item.offsetHeight / 2;
      const d  = Math.sqrt((cx - centerX) ** 2 + (cy - centerY) ** 2);
      const delay = Math.round((d / maxDist) * 300);
      item.style.setProperty('--delay', `${delay}ms`);
      item.style.willChange = 'transform, opacity';
      item.classList.add('animate');
      setTimeout(() => { item.style.willChange = ''; }, 500 + delay);
    });
  });
}

// ── Launchpad search ──────────────────────────────────────────────────────────
document.getElementById('launchpad-search').addEventListener('input', debounce((e) => {
  const q = e.target.value.toLowerCase().trim();
  const items = document.querySelectorAll('.launchpad-item');
  let visibleCount = 0;
  let firstMatch = null;

  items.forEach(item => {
    const nameEl = item.querySelector('.launchpad-name');
    const name  = (nameEl?.textContent || '').toLowerCase();
    const label = (item.getAttribute('aria-label') || '').toLowerCase();
    const match = q === '' || name.includes(q) || label.includes(q);
    item.style.display = match ? '' : 'none';
    if (match) {
      visibleCount++;
      if (!firstMatch) firstMatch = item;
      if (nameEl && q) {
        const original = nameEl.textContent;
        const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        nameEl.innerHTML = original.replace(new RegExp(`(${escaped})`, 'gi'), '<mark style="background:var(--accent);color:#fff;border-radius:2px;padding:0 2px;">$1</mark>');
      } else if (nameEl) {
        nameEl.textContent = nameEl.textContent;
      }
    }
  });

  let noResultsMsg = document.getElementById('launchpad-no-results');
  if (q && visibleCount === 0 && items.length > 0) {
    if (!noResultsMsg) {
      noResultsMsg = createEl('div', {
        id: 'launchpad-no-results',
        className: 'launchpad-no-results',
        textContent: 'No apps found',
        style: 'grid-column:1/-1;text-align:center;color:var(--text-muted);padding:40px;'
      });
      document.getElementById('launchpad-grid').appendChild(noResultsMsg);
    }
    noResultsMsg.style.display = '';
  } else if (noResultsMsg) {
    noResultsMsg.style.display = 'none';
  }
}, 150));

document.getElementById('launchpad-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.toLowerCase().trim();
  const items = Array.from(document.querySelectorAll('.launchpad-item')).filter(item => item.style.display !== 'none');
  if (!items.length) return;
  if (!q) return;
  const target = items.find(item => {
    const name = item.querySelector('.launchpad-name')?.textContent?.toLowerCase() ?? '';
    const label = (item.getAttribute('aria-label') || '').toLowerCase();
    return name === q || label === q;
  });
  if (target) target.click();
});

// Close launchpad on backdrop click
document.getElementById('launchpad').addEventListener('click', (e) => {
  if (e.target.id === 'launchpad') toggleLaunchpad();
});

// ═══════════════════════════════════════════════════════════════════════════════
// NOTIFICATION PANEL
// ═══════════════════════════════════════════════════════════════════════════════

document.getElementById('notification-panel').addEventListener('click', (e) => {
  if (e.target.id === 'notification-panel') {
    document.getElementById('notification-panel').classList.remove('active');
    if (typeof window.resetShellScroll === 'function') {
      window.resetShellScroll();
      requestAnimationFrame(window.resetShellScroll);
    }
  }
});

document.getElementById('tray-bell').addEventListener('click', Notify.togglePanel);

document.getElementById('notif-close').addEventListener('click', () => {
  document.getElementById('notification-panel').classList.remove('active');
  if (typeof window.resetShellScroll === 'function') {
    window.resetShellScroll();
    requestAnimationFrame(window.resetShellScroll);
  }
});

document.getElementById('notif-mark-all').addEventListener('click', () => {
  OS.notifications = [];
  OS.notifUnread   = 0;
  Notify.persist();
  Notify.updateBadge();
  updateNotificationBadge();
  Notify.renderPanel();
});

// Separate from Clear All — this keeps notification history but marks
// everything as read. Notify.markAllRead() already does the mark, persist,
// badge update, and re-render; it just doesn't touch this file's own tray
// badge (updateNotificationBadge), so we call that here too.
document.getElementById('notif-mark-read').addEventListener('click', () => {
  Notify.markAllRead();
  updateNotificationBadge();
});

// ── Notification badge ────────────────────────────────────────────────────────
function updateNotificationBadge() {
  // #19: null-check — badge element may not exist in all layout variants
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  const unread = (OS.notifications || []).filter(n => !n.read).length;
  if (unread > 0) {
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

Notify.loadPersisted();
Notify.renderPanel();
Notify.updateBadge();
updateNotificationBadge();

// ═══════════════════════════════════════════════════════════════════════════════
// TRAY — WiFi
// ═══════════════════════════════════════════════════════════════════════════════

const trayWifi = document.getElementById('tray-wifi');
if (trayWifi) {
  trayWifi.addEventListener('click', (e) => {
    e.stopPropagation();
    let wifiPopup = document.getElementById('wifi-popup');
    if (!wifiPopup) {
      wifiPopup = document.createElement('div');
      wifiPopup.id = 'wifi-popup';
      wifiPopup.style.cssText =
        'position:fixed;bottom:60px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:var(--r-md);padding:16px;min-width:200px;z-index:9999;box-shadow:var(--shadow-md)';
      document.body.appendChild(wifiPopup);
      document.addEventListener('click', () => wifiPopup.remove(), { once: true });
    } else {
      wifiPopup.remove();
      return;
    }

    const online = navigator.onLine;
    const rect   = trayWifi.getBoundingClientRect();
    wifiPopup.style.left = Math.max(0, rect.left - 80) + 'px';

    // Avoid innerHTML with dynamic content
    const header = document.createElement('div');
    header.style.cssText = 'font-weight:600;margin-bottom:8px;';
    header.textContent = 'Network';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;';
    const dot = document.createElement('span');
    dot.style.color = online ? 'var(--text-success)' : 'var(--text-danger)';
    dot.textContent = '●';
    const statusText = document.createElement('span');
    statusText.textContent = online ? 'Connected to network' : 'No internet connection';
    row.appendChild(dot);
    row.appendChild(statusText);

    wifiPopup.appendChild(header);
    wifiPopup.appendChild(row);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRAY — Volume
// ═══════════════════════════════════════════════════════════════════════════════

// #2: guard all four elements — any one missing would throw on .addEventListener
const volumeBtn    = document.getElementById('tray-volume');
const volumePopup  = document.getElementById('volume-popup');
const volumeSlider = document.getElementById('volume-slider');
const volumeValue  = document.getElementById('volume-value');

if (volumeBtn && volumePopup && volumeSlider && volumeValue) {
  let volumePopupPinned = false;

  volumeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = volumeBtn.getBoundingClientRect();
    volumePopup.style.left   = rect.left + 'px';
    volumePopup.style.bottom = '60px';
    volumePopup.classList.toggle('active');
  });

  volumeBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    volumePopupPinned = !volumePopupPinned;
  });

  volumeSlider.addEventListener('click',  (e) => { e.stopPropagation(); });
  volumeSlider.addEventListener('input',  () => {
    const newVolume = parseInt(volumeSlider.value, 10);
    OS.volume = newVolume;
    volumeValue.textContent = newVolume + '%';
    try { OS.events.emit('os:volumeChanged', { volume: newVolume }); } catch {}

    for (const [id, state] of (OS.windows || [])) {
      if (state.appId === 'browser') {
        const webviews = state.element?.querySelectorAll?.('webview');
        if (webviews) {
          for (const webview of webviews) {
            if (typeof webview.executeJavaScript === 'function') {
              webview.executeJavaScript(
                `(function(){const v=${(newVolume / 100).toFixed(2)};` +
                `document.querySelectorAll('audio,video').forEach(function(el){el.volume=v;});})();`
              ).catch(function(){});
            }
          }
        }
      }
    }
  });

  volumePopup.addEventListener('click', (e) => { e.stopPropagation(); });

  document.addEventListener('click', () => {
    if (!volumePopupPinned) volumePopup.classList.remove('active');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRAY — Battery
// ═══════════════════════════════════════════════════════════════════════════════

async function updateBattery() {
  const batteryBtn = document.getElementById('tray-battery');
  if (!batteryBtn) return;
  try {
    if ('getBattery' in navigator) {
      const battery = await navigator.getBattery();
      const update = () => {
        const level = Math.round(battery.level * 100);
        // #16: avoid innerHTML — use textContent via a DOM span
        const span = document.createElement('span');
        span.style.fontSize = '11px';
        span.textContent = `${level}%`;
        batteryBtn.textContent = '';
        batteryBtn.appendChild(span);
      };
      battery.addEventListener('levelchange', update);
      update();
    }
  } catch { /* getBattery not available in this browser */ }
}
updateBattery();

// ═══════════════════════════════════════════════════════════════════════════════
// WINDOW RESIZE
// ═══════════════════════════════════════════════════════════════════════════════

window.addEventListener('resize', throttleRAF(() => {
  for (const state of OS.windows.values()) {
    if (state.maximized) {
      const area = WM.getWorkArea();
      state.x = area.left; state.y = area.top;
      state.width = area.width; state.height = area.height;
      state.element.style.left   = area.left   + 'px';
      state.element.style.top    = area.top    + 'px';
      state.element.style.width  = area.width  + 'px';
      state.element.style.height = area.height + 'px';
    } else {
      const next = WM.clampWindowRect(state, state.x, state.y, state.width, state.height);
      state.x = next.x; state.y = next.y; state.width = next.w; state.height = next.h;
      state.element.style.left   = next.x + 'px';
      state.element.style.top    = next.y + 'px';
      state.element.style.width  = next.w + 'px';
      state.element.style.height = next.h + 'px';
    }
  }
  WM.hideSnapPreview();
}));

// ═══════════════════════════════════════════════════════════════════════════════
// DESKTOP CONTEXT MENU
// ═══════════════════════════════════════════════════════════════════════════════

const desktopEl = document.getElementById('desktop');
if (desktopEl) {
  desktopEl.addEventListener('pointerdown', (e) => {
    if (
      !e.target.closest('.app-window') &&
      !e.target.closest('.taskbar') &&
      !e.target.closest('.context-menu')
    ) {
      for (const [, w] of OS.windows) w.element.classList.remove('focused');
      OS.focusedWindowId = null;
      WM.updateTaskbar();
      if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
      }
    }
  });

  desktopEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.desktop-icon')) return;
    e.preventDefault();
    ContextMenu.show(e.clientX, e.clientY, [
      {
        label: 'New File', icon: 'file', action: async () => {
          const name = await showPrompt('New File Name', 'untitled.txt');
          if (name) {
            const finalName = FS.uniqueName(FS.specialFolders.desktop, name);
            await FS.createFile(FS.specialFolders.desktop, finalName, '', 'text/plain');
            renderDesktopIcons();
          }
        }
      },
      {
        label: 'New Folder', icon: 'folder', action: async () => {
          const name = await showPrompt('New Folder Name', 'New Folder');
          if (name) {
            const finalName = FS.uniqueName(FS.specialFolders.desktop, name);
            await FS.createFolder(FS.specialFolders.desktop, finalName);
            renderDesktopIcons();
          }
        }
      },
      ...(OS.clipboard?.fileId ? [
        { separator: true },
        {
          label: 'Paste', icon: 'paste', action: async () => {
            if (OS.settings?.get?.('disableClipboardPaste')) {
              Notify.show({ title: 'Paste disabled', body: 'Paste disabled.', type: 'error', appName: 'Desktop' });
              return;
            }
            try {
              const clip = OS.clipboard;
              await FS.pasteInto(clip, FS.specialFolders.desktop);
              if (clip.type === 'cut') OS.clipboard = null;
              renderDesktopIcons();
            } catch (err) {
              console.error('[Desktop] paste failed:', err);
              Notify.show({ title: 'Paste failed', body: err?.message || 'Unknown error', type: 'error', appName: 'Desktop' });
            }
          }
        }
      ] : []),
      { separator: true },
      { label: 'Open Terminal', icon: 'terminal', action: () => WM.createWindow('shell') },
      { label: 'Open Settings', icon: 'settings', action: () => WM.createWindow('nook') },
      { separator: true },
      { label: 'Refresh', action: () => renderDesktopIcons() }
    ]);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════════════════════════════════

document.addEventListener('keydown', (e) => {
  const focused      = document.activeElement;
  const inAppContent = focused?.closest?.('.window-content');
  const alwaysAllow  =
    (e.altKey && (e.key === 'F4' || e.key === 'Tab')) ||
    e.key === 'Escape' || e.key === 'PrintScreen';

  if (inAppContent && !alwaysAllow) {
    const conflicting = (e.ctrlKey || e.metaKey) && (
      e.key === 'l' || e.key === 'L' || e.key === 'e' || e.key === 'E' ||
      e.key === 'd' || e.key === 'D' || e.key === 'c' || e.key === 'C' ||
      e.key === 'u' || e.key === 'U' || e.key === 'a' || e.key === 'A' ||
      e.key === ' ' || e.key === 'ArrowLeft' || e.key === 'ArrowRight'
    );
    if (conflicting) return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key === 'e')                        { e.preventDefault(); WM.createWindow('vault'); }
  if ((e.metaKey || e.ctrlKey) && e.altKey && e.key === 't')            { e.preventDefault(); WM.createWindow('shell'); }
  if ((e.metaKey || e.ctrlKey) && e.key === ' ')                        { e.preventDefault(); toggleLaunchpad(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'l')                        { e.preventDefault(); lockScreen(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'd')                        { e.preventDefault(); WM.minimizeAll(); }
  if (e.key === 'PrintScreen' && !e.altKey)                              { e.preventDefault(); captureScreenshot('desktop'); }
  if (e.altKey && e.key === 'PrintScreen')                               { e.preventDefault(); captureScreenshot('window'); }
  if ((e.key === 's' || e.key === 'S') && (e.metaKey || e.ctrlKey) && e.shiftKey) { e.preventDefault(); captureScreenshot('region'); }
  if (e.altKey && e.key === 'F4')  { e.preventDefault(); if (OS.focusedWindowId) WM.closeWindow(OS.focusedWindowId); }
  if (e.altKey && e.key === 'Tab') { e.preventDefault(); showAppSwitcher(); }

  // #5: Ctrl+Arrow — was crashing on undefined maxWorkspaces
  if (e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    switchWorkspace(e.key === 'ArrowRight' ? 1 : -1);
  }

  if (e.key === 'Escape') {
    const launchpad = document.getElementById('launchpad');
    if (launchpad.classList.contains('active')) toggleLaunchpad();
    ContextMenu.hide();
  }

  // F3 — toggle debug overlay only; devMode setting is unchanged
  if (e.key === 'F3') {
    e.preventDefault();
    if (window.DebugOverlay) {
      window.DebugOverlay.toggle();
    }
  }

  // Ctrl+Shift+D — copy debug overlay text to clipboard
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    if (window.DebugOverlay) {
      window.DebugOverlay._copyDebugInfo?.();
      Notify.show({ title: 'Debug Info Copied', body: 'Overlay text copied to clipboard', type: 'success' });
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCREENSHOT
// ═══════════════════════════════════════════════════════════════════════════════

// Strips the `data:<mime>;base64,` wrapper so only the raw base64 payload is
// stored — matches the VFS convention used for dropped/uploaded binary files
// (see extractBase64FromDataUrl in the desktop drop handler) and what apps
// like Gallery expect to decode.
function _dataUrlToBase64(dataUrl) {
  const comma = dataUrl.indexOf(',');
  return comma > -1 ? dataUrl.slice(comma + 1) : dataUrl;
}

// Lets the user drag out a rectangle over a still image of the captured
// frame. Resolves to {x, y, width, height} in the image's own pixel space,
// or null if the user cancels (Escape / right-click).
function _promptRegionSelect(frameCanvas) {
  return new Promise((resolve) => {
    const scale = Math.min(
      (window.innerWidth  * 0.9) / frameCanvas.width,
      (window.innerHeight * 0.9) / frameCanvas.height,
      1
    );
    const dispW = frameCanvas.width  * scale;
    const dispH = frameCanvas.height * scale;

    const overlay = createEl('div', {
      id: 'screenshot-region-overlay',
      style: 'position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;z-index:99999;cursor:crosshair;user-select:none;'
    });

    const frame = createEl('div', {
      style: `position:relative;width:${dispW}px;height:${dispH}px;box-shadow:0 0 0 1px rgba(255,255,255,0.2);`
    });
    const img = createEl('img', { style: 'width:100%;height:100%;display:block;pointer-events:none;' });
    img.src = frameCanvas.toDataURL('image/png');

    const selectionBox = createEl('div', {
      style: 'position:absolute;border:2px solid var(--accent, #3b82f6);background:rgba(59,130,246,0.15);display:none;pointer-events:none;'
    });

    const hint = createEl('div', {
      textContent: 'Drag to select a region · Esc to cancel',
      style: 'position:absolute;top:-32px;left:0;color:#fff;font-size:12px;font-family:var(--font-ui, sans-serif);opacity:0.85;'
    });

    frame.append(img, selectionBox, hint);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);

    let startX = 0, startY = 0, dragging = false;
    let settled = false;

    const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      resolve(result);
    };

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      const rect = frame.getBoundingClientRect();
      startX = clamp(e.clientX - rect.left, 0, dispW);
      startY = clamp(e.clientY - rect.top, 0, dispH);
      dragging = true;
      selectionBox.style.display = 'block';
      selectionBox.style.left = `${startX}px`;
      selectionBox.style.top = `${startY}px`;
      selectionBox.style.width = '0px';
      selectionBox.style.height = '0px';
    };

    const onPointerMove = (e) => {
      if (!dragging) return;
      const rect = frame.getBoundingClientRect();
      const curX = clamp(e.clientX - rect.left, 0, dispW);
      const curY = clamp(e.clientY - rect.top, 0, dispH);
      const left = Math.min(startX, curX), top = Math.min(startY, curY);
      const w = Math.abs(curX - startX), h = Math.abs(curY - startY);
      selectionBox.style.left = `${left}px`;
      selectionBox.style.top = `${top}px`;
      selectionBox.style.width = `${w}px`;
      selectionBox.style.height = `${h}px`;
    };

    const onPointerUp = (e) => {
      if (!dragging) return;
      dragging = false;
      const rect = frame.getBoundingClientRect();
      const curX = clamp(e.clientX - rect.left, 0, dispW);
      const curY = clamp(e.clientY - rect.top, 0, dispH);
      const left = Math.min(startX, curX), top = Math.min(startY, curY);
      const w = Math.abs(curX - startX), h = Math.abs(curY - startY);

      // Too small to be an intentional selection — treat as a click, keep
      // waiting rather than resolving with an empty region.
      if (w < 4 || h < 4) {
        selectionBox.style.display = 'none';
        return;
      }

      // Map back from display space to the source frame's real pixel space.
      finish({
        x: Math.round(left / scale),
        y: Math.round(top / scale),
        width: Math.round(w / scale),
        height: Math.round(h / scale),
      });
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    };
    const onContextMenu = (e) => { e.preventDefault(); finish(null); };

    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    overlay.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKeyDown, true);
  });
}

// Finds the "Screenshots" subfolder inside Pictures, creating it once if it
// doesn't exist yet. Cached after the first successful lookup/creation so
// repeated screenshots don't re-scan Pictures' contents every time.
let _screenshotsFolderId = null;

async function _getOrCreateScreenshotsFolder() {
  if (_screenshotsFolderId && FS.files.has(_screenshotsFolderId)) {
    return _screenshotsFolderId;
  }

  const picturesId = FS.specialFolders?.pictures;
  if (!picturesId) return null;

  const existing = FS.listDir(picturesId)
    .find(f => f.type === 'folder' && f.name === 'Screenshots');

  if (existing) {
    _screenshotsFolderId = existing.id;
    return existing.id;
  }

  const created = await FS.createFolder(picturesId, 'Screenshots');
  _screenshotsFolderId = created.id;
  return created.id;
}

async function captureScreenshot(mode) {
  let stream;
  try {
    // #11: capture stream reference before entering try body
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: mode === 'window' ? 'window' : 'monitor' }
    });

    const video = document.createElement('video');
    video.srcObject = stream;
    await video.play();       // #11: if this throws, finally() still stops tracks

    const fullCanvas = document.createElement('canvas');
    fullCanvas.width  = video.videoWidth;
    fullCanvas.height = video.videoHeight;
    fullCanvas.getContext('2d').drawImage(video, 0, 0);   // #11: same

    // The stream is only needed to grab one frame — release it immediately
    // rather than holding the screen-capture indicator open while the user
    // drags out a region selection.
    stream.getTracks().forEach(t => t.stop());
    stream = null;

    let outputCanvas = fullCanvas;

    if (mode === 'region') {
      const region = await _promptRegionSelect(fullCanvas);
      if (!region) {
        // User cancelled — not an error, just quietly stop.
        return;
      }
      const cropped = document.createElement('canvas');
      cropped.width = region.width;
      cropped.height = region.height;
      cropped.getContext('2d').drawImage(
        fullCanvas,
        region.x, region.y, region.width, region.height,
        0, 0, region.width, region.height
      );
      outputCanvas = cropped;
    }

    const dataUrl = outputCanvas.toDataURL('image/png');
    const base64  = _dataUrlToBase64(dataUrl);
    const name    = `screenshot-${Date.now()}.png`;

    const screenshotsId = await _getOrCreateScreenshotsFolder();
    if (!screenshotsId) throw new Error('Pictures folder not found');

    await FS.createFile(screenshotsId, name, base64, 'image/png');

    Notify.show({ title: 'Screenshot Saved', body: `Saved to Pictures/Screenshots as ${name}`, type: 'success', appName: 'System' });
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'System', category: 'system', severity: 'info', message: `Screenshot captured (${mode})`, data: { mode, name } });
    }
  } catch {
    Notify.show({ title: 'Screenshot Failed', body: 'Could not capture screenshot', type: 'error', appName: 'System' });
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'System', category: 'system', severity: 'error', message: `Screenshot capture failed (${mode})`, data: { mode } });
    }
  } finally {
    // #11: always stop tracks — screen-capture indicator is never left dangling
    stream?.getTracks().forEach(t => t.stop());
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIRTUAL DESKTOPS
// ═══════════════════════════════════════════════════════════════════════════════

// #5: defined as a local constant — the original code used `maxWorkspaces` which
// was never declared anywhere, causing a ReferenceError on every Ctrl+Arrow press.
const MAX_WORKSPACES = 9;

function switchWorkspace(direction) {
  const currentIdx = OS.workspaces.findIndex(w => w.id === OS.currentWorkspace);
  const newIdx     = currentIdx + direction;

  // #5: correct bounds — the old condition `<= maxWorkspaces` was also wrong (off-by-one)
  if (newIdx >= 0 && newIdx < OS.workspaces.length) {
    OS.currentWorkspace = OS.workspaces[newIdx].id;
  } else if (newIdx >= OS.workspaces.length && OS.workspaces.length < MAX_WORKSPACES) {
    const newWs = { id: Date.now(), name: `Workspace ${OS.workspaces.length + 1}` };
    OS.workspaces.push(newWs);
    OS.currentWorkspace = newWs.id;
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'System', category: 'window', severity: 'info', message: `Created ${newWs.name}`, data: { workspaceId: newWs.id } });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// APP SWITCHER
// ═══════════════════════════════════════════════════════════════════════════════

let switcherActive = false;
let switcherIdx    = 0;

function showAppSwitcher() {
  const windows = Array.from(OS.windows.values());
  if (windows.length === 0) return;

  switcherActive = true;
  switcherIdx    = 0;

  const switcher = document.getElementById('app-switcher');
  const list     = document.getElementById('app-switcher-list');
  list.innerHTML = '';

  windows.forEach((w, i) => {
    const app = OS.apps[w.appId];
    if (!app) return;
    const item = createEl('div', { className: 'app-switcher-item' + (i === 0 ? ' active' : '') });
    const icon = createEl('div', { className: 'app-switcher-icon' });
    icon.innerHTML = svgIcon(app.id && app.id.startsWith('webapp_') ? app.icon : (app.icon || '/assets/no_app_icon.svg'), 32);
    item.appendChild(icon);
    item.appendChild(createEl('div', { className: 'app-switcher-name', textContent: app.name }));
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
});

// ═══════════════════════════════════════════════════════════════════════════════
// LOCK SCREEN
// ═══════════════════════════════════════════════════════════════════════════════

function handleLockScreenKeydown(e) {
  const lockScreenEl = document.getElementById('lock-screen');
  if (!lockScreenEl?.classList.contains('active')) {
    document.removeEventListener('keydown', handleLockScreenKeydown);
    return;
  }
  if      (e.key >= '0' && e.key <= '9') { e.preventDefault(); enterPinDigit(e.key); }
  else if (e.key === 'Backspace')         { e.preventDefault(); backspacePin(); }
  else if (e.key === 'Enter')             { e.preventDefault(); if (enteredPin.length === 4) verifyPin(); }
  else if (e.key === 'Escape')            { e.preventDefault(); clearPin(); }
}

function lockScreen() {
  if (!OS.lockPin) { WM.minimizeAll(); return; }
  OS.isLocked = true;
  document.getElementById('lock-screen').classList.add('active');
  renderLockScreen();
  if (typeof EventLog !== 'undefined') {
    EventLog.log({ app: 'System', category: 'security', severity: 'info', message: 'Screen locked' });
  }
}

function renderLockScreen() {
  const usernameEl = document.getElementById('lock-username');
  const dotsEl     = document.getElementById('lock-pin-dots');
  const statusEl   = document.getElementById('lock-status');
  const numpadEl   = document.getElementById('lock-numpad');

  usernameEl.textContent = OS.username;
  dotsEl.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    dotsEl.appendChild(createEl('div', { className: 'lock-pin-dot' }));
  }
  statusEl.textContent = '';
  numpadEl.innerHTML   = '';

  for (let i = 1; i <= 9; i++) {
    const btn = createEl('button', { textContent: String(i), 'aria-label': String(i) });
    btn.addEventListener('click', () => enterPinDigit(String(i)));
    numpadEl.appendChild(btn);
  }
  const clearBtn = createEl('button', { textContent: 'C', 'aria-label': 'Clear' });
  clearBtn.addEventListener('click', clearPin);
  numpadEl.appendChild(clearBtn);

  const zeroBtn = createEl('button', { textContent: '0', 'aria-label': '0' });
  zeroBtn.addEventListener('click', () => enterPinDigit('0'));
  numpadEl.appendChild(zeroBtn);

  const backBtn = createEl('button', { 'aria-label': 'Backspace' });
  backBtn.innerHTML = svgIcon('chevron-left', 18);
  backBtn.addEventListener('click', backspacePin);
  numpadEl.appendChild(backBtn);

  // ── Biometric button ──────────────────────────────────────────────────────
  if (window.PublicKeyCredential && OS.settings.get('biometricCredentialId')) {
    const bioContainer = document.getElementById('lock-screen');
    if (!bioContainer.querySelector('.biometric-btn')) {
      const bioBtn = createEl('button', {
        className: 'biometric-btn',
        style: 'margin-top:16px;width:100%;padding:12px;background:var(--bg-elevated);border:1px solid var(--accent);border-radius:8px;color:var(--accent);font-weight:600;cursor:pointer;'
      });
      bioBtn.textContent = '👆 Use Biometric';
      bioBtn.addEventListener('click', async () => {
        try {
          const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
          if (!available) { statusEl.textContent = 'Biometric not available on this device'; return; }
          statusEl.textContent = 'Waiting for biometric...';

          const challenge     = crypto.getRandomValues(new Uint8Array(32));
          const credentialId  = OS.settings.get('biometricCredentialId');
          // #12: Uint8Array.fromBase64() (ES2026) replaces the deprecated atob() hack
          const credBytes = Uint8Array.fromBase64(credentialId);

          const credential = await navigator.credentials.get({
            publicKey: {
              challenge,
              allowCredentials: [{ id: credBytes, type: 'public-key' }],
              userVerification: 'required'
            }
          });
          if (credential) {
            unlockFromLockScreen();
            Notify.show({ title: 'Welcome back', body: 'Authenticated via biometrics', type: 'success', appName: 'System' });
          }
        } catch (err) {
          statusEl.textContent = 'Biometric failed: ' + (err.message || 'Try PIN instead');
        }
      });
      numpadEl.parentNode.appendChild(bioBtn);
    }
  }

  enteredPin = '';
  updatePinDots();
  // Remove before re-adding — prevents listener stacking across re-renders
  document.removeEventListener('keydown', handleLockScreenKeydown);
  document.addEventListener('keydown', handleLockScreenKeydown);
}

let enteredPin = '';

function unlockFromLockScreen() {
  OS.isLocked = false;
  if (typeof EventLog !== 'undefined') {
    EventLog.log({ app: 'System', category: 'security', severity: 'info', message: 'Screen unlocked' });
  }

  // #4: cancel the wipe countdown — biometric auth must be able to abort it.
  // The old code stored countdownInterval in a block-local var inside verifyPin(),
  // making it completely unreachable here. Now it lives at module scope.
  if (_wipeCountdownId) {
    clearInterval(_wipeCountdownId);
    _wipeCountdownId = 0;
  }

  const lockScreenEl = document.getElementById('lock-screen');
  if (lockScreenEl) lockScreenEl.classList.remove('active');
  document.removeEventListener('keydown', handleLockScreenKeydown);
  enteredPin = '';

  WM.updateTaskbar();
  requestAnimationFrame(() => { renderDesktopIcons(); WM.updateTaskbar(); });
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
  document.querySelectorAll('.lock-pin-dot').forEach((dot, i) =>
    dot.classList.toggle('filled', i < enteredPin.length)
  );
}

async function verifyPin() {
  const statusEl = document.getElementById('lock-status');

  // #3: ENFORCE lockout before touching the hash worker.
  // The original code set OS.lockoutUntil but never checked it at entry —
  // any caller could keep submitting PINs indefinitely during the lockout window.
  if (OS.lockoutUntil && Date.now() < OS.lockoutUntil) {
    const remaining = Math.ceil((OS.lockoutUntil - Date.now()) / 1000);
    statusEl.textContent = `Locked out. Try again in ${remaining}s`;
    enteredPin = '';
    updatePinDots();
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'System', category: 'security', severity: 'warn', message: `PIN attempt blocked — lockout active (${remaining}s remaining)` });
    }
    return;
  }

  statusEl.textContent = 'Verifying...';
  const hash = await OS.workers.crypto.call('pbkdf2', enteredPin, getPinSalt());

  if (hash === OS.lockPin) {
    OS.wrongPinCount = 0;
    OS.lockoutUntil  = 0;
    unlockFromLockScreen();
  } else {
    OS.wrongPinCount++;
    enteredPin = '';
    updatePinDots();
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'System', category: 'security', severity: 'warn', message: `Incorrect PIN entered (attempt ${OS.wrongPinCount})`, data: { wrongPinCount: OS.wrongPinCount } });
    }

    const THRESHOLD    = 3;
    const DURATION_MS  = 30_000;

    if (OS.wrongPinCount >= THRESHOLD && OS.wrongPinCount < THRESHOLD * 2) {
      const sec   = Math.round(DURATION_MS / 1000);
      const label = sec >= 60 ? `${Math.round(sec / 60)}min` : `${sec}s`;
      statusEl.textContent  = `Too many attempts. ${label} lockout.`;
      OS.lockoutUntil       = Date.now() + DURATION_MS;
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'System', category: 'security', severity: 'warn', message: `Lockout triggered (${label}) after ${OS.wrongPinCount} failed PIN attempts`, data: { wrongPinCount: OS.wrongPinCount, durationMs: DURATION_MS } });
      }
      setTimeout(() => { OS.wrongPinCount = 0; OS.lockoutUntil = 0; statusEl.textContent = ''; }, DURATION_MS);

    } else if (OS.wrongPinCount >= THRESHOLD * 2 && OS.wrongPinCount < 10) {
      const longDur = DURATION_MS * 5;
      const sec     = Math.round(longDur / 1000);
      const label   = sec >= 60 ? `${Math.round(sec / 60)}min` : `${sec}s`;
      statusEl.textContent = `Too many attempts. ${label} lockout.`;
      OS.lockoutUntil      = Date.now() + longDur;
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'System', category: 'security', severity: 'warn', message: `Extended lockout triggered (${label}) after ${OS.wrongPinCount} failed PIN attempts`, data: { wrongPinCount: OS.wrongPinCount, durationMs: longDur } });
      }
      setTimeout(() => { OS.wrongPinCount = 0; OS.lockoutUntil = 0; statusEl.textContent = ''; }, longDur);

    } else if (OS.wrongPinCount >= 10) {
      statusEl.textContent = 'Security alert! Data will be wiped.';
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'System', category: 'security', severity: 'error', message: `Security wipe countdown started after ${OS.wrongPinCount} failed PIN attempts`, data: { wrongPinCount: OS.wrongPinCount } });
      }
      let countdown = 10;
      // #4: store at module scope so unlockFromLockScreen() can cancel it
      _wipeCountdownId = setInterval(() => {
        countdown--;
        statusEl.textContent = `Security alert! Wiping in ${countdown}s`;
        if (countdown <= 0) {
          clearInterval(_wipeCountdownId);
          _wipeCountdownId = 0;
          localStorage.clear();
          sessionStorage.clear();
          if (typeof EventLog !== 'undefined') {
            EventLog.log({ app: 'System', category: 'security', severity: 'error', message: 'Security wipe executed — all local data cleared' });
          }
          Notify.show({
            title: 'Security Wipe',
            body: 'All data has been wiped due to too many failed attempts.',
            type: 'error', appName: 'System'
          });
          setTimeout(() => location.reload(), 2000);
        }
      }, 1000);

    } else {
      statusEl.textContent = 'Incorrect PIN';
    }
  }
}

// ── Idle lock ─────────────────────────────────────────────────────────────────

let lastActivity = Date.now();
const _resetIdleTimer = () => { lastActivity = Date.now(); };
['pointerdown', 'pointermove', 'keydown', 'scroll'].forEach(evt => {
  document.addEventListener(evt, _resetIdleTimer, { passive: true });
});

setInterval(() => {
  if (OS.lockPin && !OS.isLocked && OS.idleTimeout < Infinity) {
    if (Date.now() - lastActivity > OS.idleTimeout) lockScreen();
  }
}, 30_000);

// ═══════════════════════════════════════════════════════════════════════════════
// FILE THREAT SCANNING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check a filename's extension against a blocked list.
 * @param {string} filename
 * @returns {{ blocked: boolean, reason: string|null }}
 */
function checkFileExtension(filename) {
  // #9: guard null/undefined; return safe for extensionless files ("Makefile" etc.)
  if (!filename || typeof filename !== 'string') return { blocked: false, reason: null };
  const parts = filename.split('.');
  if (parts.length < 2) return { blocked: false, reason: null };

  const ext = parts.pop().toLowerCase();
  // Edge case: extension equals the whole name after lowercasing (e.g. ".exe" as filename)
  if (!parts.join('')) return { blocked: false, reason: null };

  const BLOCKED = new Set(['exe', 'dll', 'scr', 'msi', 'com', 'pif', 'vbs', 'vbe', 'wsf', 'wsh']);
  if (BLOCKED.has(ext)) {
    return { blocked: true, reason: `Blocked: ${ext.toUpperCase()} files cannot be added (executable type)` };
  }
  return { blocked: false, reason: null };
}

/**
 * Scan file content for known-malicious patterns.
 * @param {string} content
 * @param {string} [_filename] — reserved, unused
 * @returns {{ isMalicious: boolean, threats: Array, patterns: Array }}
 */
function scanFileForThreats(content, _filename) {
  if (!content || typeof content !== 'string' || content.length === 0) {
    return { isMalicious: false, threats: [], patterns: [] };
  }

  const threats  = [];
  const patterns = [];

  // #1: _THREAT_PATTERNS uses no /g flag — .test() result is always correct.
  // With /g, lastIndex advances after each match. On the second call with the
  // same regex instance and matching content, test() returns false (bypasses scanner).
  for (const { regex, name, severity } of _THREAT_PATTERNS) {
    if (regex.test(content)) {
      patterns.push(name);
      threats.push({ type: name, severity });
    }
  }

  return { isMalicious: patterns.length > 0, threats, patterns };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECOVERY MODE
// ═══════════════════════════════════════════════════════════════════════════════

function triggerRecovery(reason) {
  if (document.body.classList.contains('os-booted')) return false;

  const KEY = 'nova_boot_attempts';
  const attempts = (() => {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
  })();

  attempts.push({ ts: Date.now(), reason: reason || 'unknown', ua: navigator.userAgent.slice(0, 80) });
  if (attempts.length > 10) attempts.shift();
  localStorage.setItem(KEY, JSON.stringify(attempts));

  if (typeof EventLog !== 'undefined') {
    EventLog.log({ app: 'System', category: 'system', severity: 'error', message: `Boot failure detected: ${reason || 'unknown'} (attempt ${attempts.length})`, data: { reason, attemptCount: attempts.length } });
  }

  if (attempts.length >= 2) { showRecoveryScreen(attempts, false); return true; }
  return false;
}

window.addEventListener('error', (e) => {
  if (document.body.classList.contains('os-booted')) return;
  const msg = e.message || '';
  if (msg.includes('SyntaxError') || msg.includes('Unexpected token')) {
    const target = e.target;
    const src = target?.src || e.filename || '';
    if (src.includes('/js/apps/') || src.includes('\\js\\apps\\')) {
      console.warn('[Boot] App syntax error skipped from recovery:', src, msg);
      return;
    }
    console.error('[BOOT] Syntax error detected:', msg);
    triggerRecovery('syntax_error: ' + msg.slice(0, 100));
  }
});

function showRecoveryScreen(priorAttempts, isManual) {
  const bootScreen = document.getElementById('boot-screen');
  if (bootScreen) bootScreen.style.display = 'none';

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
            <polygon points="18,3 33,10.5 33,25.5 18,33 3,25.5 3,10.5"
              fill="none" stroke="#ff6b35" stroke-width="1.5" opacity="0.8"/>
            <text x="18" y="23" text-anchor="middle" font-size="13"
              font-weight="700" fill="#ffd700" font-family="monospace">NB</text>
          </svg>
        </div>
      </div>
      <div class="rba-title">NovaByte</div>
      <div class="rba-subtitle">⚠ Recovery Mode</div>
      <div class="rba-log" id="rba-log"></div>
      <div class="rba-bar-wrap"><div class="rba-bar" id="rba-bar"></div></div>
      <div class="rba-status" id="rba-status">Initializing recovery environment…</div>
    </div>`;
  document.body.appendChild(anim);

  const rbaLog    = document.getElementById('rba-log');
  const rbaBar    = document.getElementById('rba-bar');
  const rbaStatus = document.getElementById('rba-status');
  let step = 0;

  const steps = isManual ? [
    { msg: '[ RECOVERY MODE ]',                            cls: 'info', pct: 8,   label: 'Loading recovery kernel…'   },
    { msg: '✓ Recovery environment loaded',          cls: 'ok',   pct: 22,  label: 'Mounting storage…'          },
    { msg: '✓ localStorage integrity check…',             cls: 'ok',   pct: 38,  label: 'Checking data…'             },
    { msg: 'Entering recovery — requested manually',       cls: 'info', pct: 60,  label: 'Preparing interface…'       },
    { msg: '✓ Recovery UI ready',                         cls: 'ok',   pct: 88,  label: 'Almost ready…'              },
    { msg: '✓ Handoff to Recovery Environment',           cls: 'info', pct: 100, label: 'Done.'                      },
  ] : [
    { msg: '[ RECOVERY MODE TRIGGERED ]',                 cls: 'warn', pct: 8,   label: 'Loading recovery kernel…'   },
    { msg: '✓ Recovery environment loaded',          cls: 'ok',   pct: 22,  label: 'Mounting storage…'          },
    { msg: '✓ localStorage integrity check…',             cls: 'ok',   pct: 38,  label: 'Checking data…'             },
    { msg: '⚠ Boot failure detected — entering recovery', cls: 'warn', pct: 60,  label: 'Preparing interface…'       },
    { msg: '✓ Recovery UI ready',                         cls: 'ok',   pct: 88,  label: 'Almost ready…'              },
    { msg: '✓ Handoff to Recovery Environment',           cls: 'info', pct: 100, label: 'Done.'                      },
  ];

  function runStep() {
    if (step >= steps.length) {
      setTimeout(() => {
        anim.classList.add('fade-out');
        setTimeout(() => { anim.remove(); }, 650);
        _doShowRecoveryScreen(priorAttempts, isManual);
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

function _doShowRecoveryScreen(priorAttempts, isManual) {
  // #20: The original wireRecoveryControls() used the bare name `screen` which
  // resolved to window.screen (the global Screen object, not a DOM element).
  // We now look up the element here and pass it explicitly.
  const recoveryScreenEl = document.getElementById('recovery-screen');
  if (!recoveryScreenEl) return;
  recoveryScreenEl.classList.add('active');

  // isManual is passed in explicitly from showRecoveryScreen(), since by the
  // time this runs, boot.js has already cleared nova_manual_recovery and
  // nova_show_recovery (it clears them before calling showRecoveryScreen at
  // all) — re-reading those flags here always returned false, which is why
  // the manual-recovery banner/log treatment was never actually applying.
  isManual = !!isManual;

  const attemptCountEl = document.getElementById('rec-attempt-count');
  const attemptAlertEl = document.querySelector('.recovery-alert');
  if (isManual && attemptAlertEl) {
    attemptAlertEl.style.display = 'none';
    if (attemptCountEl) attemptCountEl.textContent = '0';
  } else if (attemptCountEl) {
    attemptCountEl.textContent = String(priorAttempts.length);
  }

  // Timestamp — use textContent for safety
  const now = new Date();
  const tsEl = document.getElementById('rec-timestamp');
  if (tsEl) tsEl.textContent = now.toLocaleString();
  const footerTimeEl = document.getElementById('rec-footer-time');
  if (footerTimeEl) footerTimeEl.textContent = now.toLocaleTimeString();

  // #10: cancel any leaked clock timer from a prior call before starting a new one
  if (_recoveryClockId) clearInterval(_recoveryClockId);
  _recoveryClockId = setInterval(() => {
    const el = document.getElementById('rec-footer-time');
    if (el) el.textContent = new Date().toLocaleTimeString();
  }, 1000);

  // ── Diagnostics log ──────────────────────────────────────────────────────────
  const diagEl = document.getElementById('rec-diag-lines');
  const log = (msg, cls = '') => {
    const line = document.createElement('div');
    line.className = 'recovery-log-line' + (cls ? ' ' + cls : '');
    line.textContent = msg;
    diagEl.appendChild(line);
  };

  log('[ NovaByte Recovery Environment ]', 'info');
  log('');
  if (!isManual) {
    log('Boot failure analysis:', 'warn');
    priorAttempts.slice(-5).forEach((a, i) => {
      log(`  Attempt ${i + 1}: ${new Date(a.ts).toLocaleTimeString()}`, 'err');
    });
    log('');
  } else {
    log('Recovery mode initialized (Manual boot)', 'info');
    log('');
  }

  log('Scanning storage...', 'info');
  try {
    const lsKeys = Object.keys(localStorage);
    log(`  localStorage: ${lsKeys.length} key(s) · ${new Blob([JSON.stringify(localStorage)]).size} bytes`, 'ok');
    ['nova_settings', 'nova_boot_attempts'].forEach(k => {
      const val = localStorage.getItem(k);
      log(val ? `  ✓ ${k}: ${val.length} chars` : `  ✗ ${k}: not found`, val ? 'ok' : 'warn');
    });
  } catch (err) {
    log('  ! localStorage read error: ' + err.message, 'err');
  }

  log('');
  const hasSettings = !!localStorage.getItem('nova_settings');
  log(`  Settings key present: ${hasSettings ? 'YES' : 'NO'}`, hasSettings ? 'ok' : 'warn');
  log('');
  if (!isManual) {
    log('Recommendation: Try "Continue" first.', 'info');
    log('If it fails again, use Safe Mode or', 'info');
    log('"Reset Settings" to restore stability.', 'info');
  } else {
    log('Select any recovery option as needed.', 'info');
  }

  // ── Countdown auto-boot ──────────────────────────────────────────────────────
  let countdown        = 15;
  let countdownStopped = false;
  const cdownNum   = document.getElementById('rec-cdown-num');
  const cdownBar   = document.getElementById('rec-cdown-bar');
  const cdownBlock = document.getElementById('rec-countdown-block');

  function stopCountdown() {
    countdownStopped = true;
    if (cdownBlock) {
      cdownBlock.style.opacity = '0.4';
      const ctext = cdownBlock.querySelector('.recovery-countdown-text');
      if (ctext) ctext.textContent = 'Auto-boot cancelled';
    }
    if (cdownBar) { cdownBar.style.transition = 'none'; cdownBar.style.width = '0%'; }
  }

  // #20: pass the DOM element — wireRecoveryControls no longer relies on bare `screen`
  wireRecoveryControls(recoveryScreenEl);
  if (typeof initRecoveryUI === 'function') initRecoveryUI();

  if (isManual) {
    stopCountdown();
  } else {
    const countdownTimer = setInterval(() => {
      if (countdownStopped) { clearInterval(countdownTimer); return; }
      countdown--;
      if (cdownNum) cdownNum.textContent = String(countdown);
      if (cdownBar) cdownBar.style.width = ((countdown / 15) * 100) + '%';
      if (countdown <= 0) { clearInterval(countdownTimer); recoveryAction('continue'); }
    }, 1000);

    ['click', 'keydown', 'mousemove'].forEach(ev => {
      document.addEventListener(ev, () => { if (!countdownStopped) stopCountdown(); }, { once: true });
    });
  }
}

// #20: accepts the screen DOM element as a parameter
// Original code used the bare identifier `screen` which JavaScript resolved to
// window.screen (a Screen object). screen.dataset was always undefined;
// screen.querySelectorAll threw "is not a function". The guard
// `if (!screen || ...)` never triggered because window.screen is always truthy.
function wireRecoveryControls(screenEl) {
  if (!screenEl || screenEl.dataset.recoveryWired === '1') return;
  screenEl.dataset.recoveryWired = '1';

  const ACTION_MAP = {
    'continue': 'continue', 'boot': 'boot', 'boot normal': 'boot-normal',
    'normal boot': 'boot-normal', 'safe mode': 'safemode', 'boot safe': 'boot-safe',
    'boot to safe mode': 'boot-safe', 'minimal mode': 'boot-minimal',
    'boot minimal': 'boot-minimal', 'boot recovery': 'boot-recovery',
    'boot to recovery': 'boot-recovery', 'reset settings': 'reset-settings',
    'clear cache': 'clear-cache', 'clear data': 'wipe-user-data',
    'factory reset': 'factory', 'console': 'console', 'terminal': 'console',
    'file manager': 'file-manager', 'settings editor': 'settings-editor',
    'storage analyzer': 'storage-analyzer', 'event log': 'event-log', 'back': 'back'
  };

  function switchRecoveryTab(tabName) {
    const tab = String(tabName || '').trim().toLowerCase();
    if (!tab) return false;
    screenEl.querySelectorAll('.recovery-tab').forEach(btn => {
      const btnTab = (btn.dataset.tab || btn.dataset.switchtab || '').trim().toLowerCase();
      btn.classList.toggle('active', btnTab === tab);
      btn.setAttribute('aria-selected', String(btnTab === tab));
    });
    screenEl.querySelectorAll('.recovery-tab-panel').forEach(panel => {
      const panelId = (panel.id || '').replace(/^tab-/, '').trim().toLowerCase();
      panel.classList.toggle('active', panelId === tab);
    });
    return true;
  }

  screenEl.addEventListener('click', (e) => {
    const t = e.target.closest(
      'button,[role="button"],[data-fn],[data-action],[data-recovery-action],' +
      '.recovery-tab,.recovery-option,.rec-btn,.rec-breadcrumb-item'
    );
    if (!t || !screenEl.contains(t)) return;

    const dataAction = (t.dataset.recoveryAction || t.dataset.action || t.dataset.fn || '').trim();
    const label      = (t.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const action     = dataAction || ACTION_MAP[label] || ACTION_MAP[label.replace(/\s*\(.*?\)\s*$/g, '')];
    const tabName    = (t.dataset.tab || t.dataset.switchtab || '').trim().toLowerCase();

    if (t.classList.contains('recovery-tab') && tabName) {
      e.preventDefault(); e.stopPropagation(); switchRecoveryTab(tabName); return;
    }
    if (t.dataset.page && typeof recNav === 'function') {
      e.preventDefault(); e.stopPropagation(); recNav(t.dataset.page); return;
    }
    if (dataAction && typeof window[dataAction] === 'function') {
      e.preventDefault(); e.stopPropagation();
      window[dataAction](t.dataset.arg || t.dataset.value || t.dataset.page); return;
    }
    if (action === 'back' && typeof recGoBack === 'function') {
      e.preventDefault(); e.stopPropagation(); recGoBack(); return;
    }
    if (action) {
      e.preventDefault(); e.stopPropagation();
      if (typeof recoveryAction === 'function') recoveryAction(action);
    }
  }, true);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SNAKE GAME — Easter egg (click NovaByte version label 7× in About)
// ═══════════════════════════════════════════════════════════════════════════════

function launchSnakeGame() {
  if (document.getElementById('snake-game-overlay')) return;

  const COLS = 20, ROWS = 20, CELL = 18;
  const W = COLS * CELL, H = ROWS * CELL;

  const overlay = createEl('div', {
    id: 'snake-game-overlay',
    style: 'position:fixed;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:99999;'
  });
  const win = createEl('div', {
    style: 'background:rgba(10,14,22,0.96);border:1px solid rgba(255,255,255,0.18);border-radius:16px;box-shadow:0 32px 64px rgba(0,0,0,0.6);overflow:hidden;user-select:none;'
  });

  const titleBar = createEl('div', {
    style: 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(255,255,255,0.04);border-bottom:1px solid rgba(255,255,255,0.08);'
  });
  const titleText = createEl('span', {
    textContent: '🐍 NovaByte Snake',
    style: 'font-size:13px;font-weight:600;color:var(--text-primary);'
  });
  const closeBtn = createEl('button', {
    textContent: '✕',
    style: 'background:rgba(248,81,73,0.18);border:1px solid rgba(248,81,73,0.35);color:#f85149;border-radius:6px;width:24px;height:24px;font-size:11px;cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:center;'
  });
  closeBtn.onclick = () => overlay.remove();
  titleBar.append(titleText, closeBtn);

  const scoreBar = createEl('div', {
    style: 'display:flex;align-items:center;justify-content:space-between;padding:6px 14px;background:rgba(0,0,0,0.2);font-size:12px;color:var(--text-secondary);'
  });
  const scoreLabel = createEl('span', { textContent: 'Score: 0' });
  const hintLabel  = createEl('span', { textContent: 'Arrow keys / WASD', style: 'color:var(--text-muted);font-size:11px;' });
  scoreBar.append(scoreLabel, hintLabel);

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.style.display = 'block';
  const ctx = canvas.getContext('2d');

  win.append(titleBar, scoreBar, canvas);
  overlay.appendChild(win);
  document.body.appendChild(overlay);

  let snake, dir, nextDir, food, score, gameLoop;
  const rand = (n) => Math.floor(Math.random() * n);

  function spawnFood() {
    let pos;
    do { pos = { x: rand(COLS), y: rand(ROWS) }; }
    while (snake.some(s => s.x === pos.x && s.y === pos.y));
    return pos;
  }

  function init() {
    const mid = { x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) };
    snake   = [mid, { x: mid.x - 1, y: mid.y }, { x: mid.x - 2, y: mid.y }];
    dir     = { x: 1, y: 0 };
    nextDir = { x: 1, y: 0 };
    food    = spawnFood();
    score   = 0;
    scoreLabel.textContent = 'Score: 0';
    canvas.parentElement?.querySelector('.snake-game-over')?.remove();
  }

  function draw() {
    ctx.fillStyle = '#07090f';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth   = 0.5;
    for (let c = 0; c <= COLS; c++) { ctx.beginPath(); ctx.moveTo(c * CELL, 0);  ctx.lineTo(c * CELL, H); ctx.stroke(); }
    for (let r = 0; r <= ROWS; r++) { ctx.beginPath(); ctx.moveTo(0, r * CELL); ctx.lineTo(W, r * CELL); ctx.stroke(); }

    const fx = food.x * CELL + CELL / 2, fy = food.y * CELL + CELL / 2, fr = CELL / 2 - 2;
    const foodGrad = ctx.createRadialGradient(fx - 2, fy - 2, 1, fx, fy, fr);
    foodGrad.addColorStop(0, '#ff6e6e');
    foodGrad.addColorStop(1, '#f85149');
    ctx.fillStyle = foodGrad;
    ctx.beginPath(); ctx.arc(fx, fy, fr, 0, Math.PI * 2); ctx.fill();

    snake.forEach((seg, i) => {
      const x = seg.x * CELL + 1, y = seg.y * CELL + 1, s = CELL - 2;
      const t = i / (snake.length - 1 || 1);
      const r = Math.round(88  + (63  - 88)  * t);
      const g = Math.round(166 + (190 - 166) * t);
      const b = Math.round(255 + (90  - 255) * t);
      ctx.fillStyle = i === 0 ? '#79b8ff' : `rgb(${r},${g},${b})`;
      ctx.beginPath(); ctx.roundRect(x, y, s, s, i === 0 ? 5 : 3); ctx.fill();
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
    const goDiv   = createEl('div',    { className: 'snake-game-over' });
    const goTitle = createEl('div',    { className: 'snake-game-over-title', textContent: 'Game Over' });
    const goScore = createEl('div',    { className: 'snake-game-over-score', textContent: `Score: ${score}` });
    const goBtn   = createEl('button', { className: 'snake-restart-btn', textContent: '↺ Play Again' });
    goBtn.onclick = () => { goDiv.remove(); startGame(); };
    goDiv.append(goTitle, goScore, goBtn);
    const wrap = canvas.parentElement;
    if (wrap) { wrap.style.position = 'relative'; wrap.appendChild(goDiv); }
  }

  function step() {
    dir = { ...nextDir };
    const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) { gameOver(); return; }
    if (snake.some(s => s.x === head.x && s.y === head.y))             { gameOver(); return; }
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

  function startGame() { init(); draw(); gameLoop = setInterval(step, 120); }

  function onKey(e) {
    // #17: _SNAKE_DIR_MAP is a module-level frozen constant — zero object allocation per keypress
    const nd = _SNAKE_DIR_MAP[e.key];
    if (nd && !(nd.x === -dir.x && nd.y === -dir.y)) {
      e.preventDefault();
      nextDir = nd;
    }
  }

  document.addEventListener('keydown', onKey);

  const cleanup = () => { clearInterval(gameLoop); document.removeEventListener('keydown', onKey); };
  closeBtn.addEventListener('click', cleanup);
  overlay.addEventListener('click', e => {
    if (e.target === overlay) { cleanup(); overlay.remove(); }
  });

  startGame();
}

/* ── Background email bootstrap (silent startup sync) ────────────────────── */
(function () {
  const bg = window.__NBOSP_BG = window.__NBOSP_BG || {};
  if (bg.email?.__patchedStartup) return;
  const svc = bg.email = bg.email || {};
  svc.__patchedStartup = true;
  try { svc.ensureBooted?.(); } catch { }
})();

OS.events.on('settings:changed', ({ key }) => {
  if (key === 'devMode') {
    if (document.getElementById('launchpad')?.classList.contains('active')) renderLaunchpad();
    if (typeof WM !== 'undefined' && WM.updateTaskbar) WM.updateTaskbar();
  }
});

boot();