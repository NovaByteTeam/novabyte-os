registerApp({
  id: 'inspector',
  name: 'Inspector',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiIgd2lkdGg9Ijk0IiBoZWlnaHQ9Ijk0Ij4KICA8ZGVmcz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0iaW5zLXJpbSIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjNjBhNWZhIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iIzI1NjNlYiIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0iaW5zLWdsYXNzIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNlZmY2ZmYiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjYmZkYmZlIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJpbnMtaGFuZGxlIiB4MT0iMCIgeTE9IjAiIHgyPSIwIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNmYmJmMjQiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjZDk3NzA2Ii8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogIDwvZGVmcz4KICA8IS0tIHNoYWRvdyAtLT4KICA8ZWxsaXBzZSBjeD0iNDgiIGN5PSI5MCIgcng9IjMwIiByeT0iNiIgZmlsbD0iIzAwMCIgb3BhY2l0eT0iMC4xOCIvPgoKICA8IS0tIGhhbmRsZSAtLT4KICA8cmVjdCB4PSI2MCIgeT0iNTgiIHdpZHRoPSIxNCIgaGVpZ2h0PSIzMCIgcng9IjYiIGZpbGw9InVybCgjaW5zLWhhbmRsZSkiIHRyYW5zZm9ybT0icm90YXRlKDQ1IDY3IDczKSIvPgoKICA8IS0tIGxlbnMgcmltIC0tPgogIDxjaXJjbGUgY3g9IjQyIiBjeT0iNDIiIHI9IjI4IiBmaWxsPSJ1cmwoI2lucy1yaW0pIi8+CiAgPCEtLSBsZW5zIGdsYXNzIC0tPgogIDxjaXJjbGUgY3g9IjQyIiBjeT0iNDIiIHI9IjIwIiBmaWxsPSJ1cmwoI2lucy1nbGFzcykiLz4KCiAgPCEtLSBzY2FuIHB1bHNlIGxpbmUgaW5zaWRlIHRoZSBnbGFzcyAtLT4KICA8cG9seWxpbmUgcG9pbnRzPSIyOCw0NCAzNSw0NCAzOSwzNCA0NSw1MiA0OSw0NCA1Niw0NCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMjU2M2ViIiBzdHJva2Utd2lkdGg9IjIuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CgogIDwhLS0gaGlnaGxpZ2h0IC0tPgogIDxlbGxpcHNlIGN4PSIzNSIgY3k9IjMwIiByeD0iMTAiIHJ5PSI1IiBmaWxsPSIjZmZmIiBvcGFjaXR5PSIwLjM1IiB0cmFuc2Zvcm09InJvdGF0ZSgtMjUgMzUgMzApIi8+Cjwvc3ZnPgo=',
  description: 'Inspect registered apps and open windows on NovaByte OS',
  category: 'developer',
  devOnly: true,
  autoGrant: true,
  defaultSize: [700, 550],
  minSize: [420, 350],
  permissions: ['system:info', 'system:apps', 'system:settings'],
  init(content, state, options) {
    if (!window.AppDirs?.getVFSDir('com.nbosp.settings', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.settings</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
      return;
    }

    if (!OS.settings.get('devMode')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">🔒</div><div style="font-size:14px;text-align:center">Enable Developer Mode in Settings to use Inspector.</div>';
      return;
    }

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-default,#0f1115);color:var(--text-primary,#e6e6e6);font-family:var(--font-ui,sans-serif);overflow:hidden;padding:16px;font-size:13px;box-sizing:border-box;';

    // AbortController covers the filter input and every per-row
    // focus/close button rebound on each render(). state.cleanups.push is
    // the real teardown hook (confirmed against wm.js, same as every other
    // dev app here) — init()'s return value is discarded.
    const ac = new AbortController();
    state.cleanups.push(() => ac.abort());

    const filterRow = createEl('div', { style: 'margin-bottom:12px;flex-shrink:0;' });
    const filterInput = createEl('input', { placeholder: 'Filter by app id, name, or window id…', style: 'width:100%;box-sizing:border-box;padding:7px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:12px;' });
    filterRow.appendChild(filterInput);
    content.appendChild(filterRow);

    const scroll = createEl('div', { style: 'flex:1;overflow:auto;' });
    content.appendChild(scroll);

    function render() {
      const apps = Array.isArray(window.APP_REGISTRY) ? window.APP_REGISTRY : [];
      const wins = typeof OS !== 'undefined' && OS.windows ? [...OS.windows.values()] : [];
      const q = filterInput.value.trim().toLowerCase();

      // Look up each window's friendly display name (matching what
      // Registered Apps shows) instead of the raw appId string — 'Clock'
      // vs 'nbosp-clock' was the same app shown two different ways.
      const appNameById = new Map(apps.map(a => [a.id, a.name || a.id]));

      const filteredApps = q ? apps.filter(a => (a.id || '').toLowerCase().includes(q) || (a.name || '').toLowerCase().includes(q)) : apps;
      const filteredWins = q ? wins.filter(w => (w.appId || '').toLowerCase().includes(q) || (w.id || '').toLowerCase().includes(q)) : wins;

      scroll.innerHTML = '';

      const appsSection = createEl('div', { style: 'margin-bottom:24px;' });
      appsSection.appendChild(createEl('h3', { textContent: `Registered Apps (${filteredApps.length})`, style: 'margin:0 0 8px;font-size:14px;color:var(--accent);' }));
      const appsList = createEl('div', { style: 'display:flex;flex-direction:column;gap:6px;' });

      filteredApps.forEach(app => {
        const row = createEl('div', { style: 'padding:8px;background:var(--bg-elevated);border-radius:6px;border:1px solid var(--border-subtle);' });
        const header = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;' });
        header.appendChild(createEl('strong', { textContent: app.name || app.id }));
        const badges = [];
        if (app.verified) badges.push(createEl('span', { textContent: '✓ verified', style: 'font-size:11px;color:#3fb950;' }));
        if (app.permissions?.length) badges.push(createEl('span', { textContent: app.permissions.length + ' perms', style: 'font-size:11px;color:var(--text-muted);' }));
        badges.forEach(b => header.appendChild(b));
        row.appendChild(header);

        const meta = createEl('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:4px;font-family:monospace;' });
        meta.textContent = `id: ${app.id} · version: ${app.version || '?'} · launchCount: ${app.launchCount || 0}`;
        row.appendChild(meta);

        if (app.permissions?.length) {
          const permStr = app.permissions.map(p => typeof p === 'string' ? p : p.permission || p).join(', ');
          row.appendChild(createEl('div', { textContent: 'Permissions: ' + permStr, style: 'font-size:11px;color:var(--text-muted);margin-top:4px;' }));
        }

        appsList.appendChild(row);
      });

      if (!filteredApps.length) {
        appsList.appendChild(createEl('div', { textContent: apps.length ? 'No apps match filter' : 'No apps registered', style: 'color:var(--text-muted);padding:8px;' }));
      }
      appsSection.appendChild(appsList);
      scroll.appendChild(appsSection);

      // Windows section
      const winsSection = createEl('div');
      winsSection.appendChild(createEl('h3', { textContent: `Open Windows (${filteredWins.length})`, style: 'margin:0 0 8px;font-size:14px;color:var(--accent);' }));
      const winsList = createEl('div', { style: 'display:flex;flex-direction:column;gap:6px;' });

      filteredWins.forEach(win => {
        const row = createEl('div', { style: 'padding:8px;background:var(--bg-elevated);border-radius:6px;border:1px solid var(--border-subtle);' });
        const header = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;' });
        const titleWrap = createEl('div', { style: 'min-width:0;overflow:hidden;display:flex;align-items:center;gap:8px;' });
        titleWrap.appendChild(createEl('strong', { textContent: appNameById.get(win.appId) || win.appId || 'unknown' }));
        titleWrap.appendChild(createEl('span', { textContent: win.appId, style: 'font-size:10px;color:var(--text-muted);opacity:0.7;' }));
        titleWrap.appendChild(createEl('span', { textContent: win.id, style: 'font-size:11px;color:var(--text-muted);font-family:monospace;' }));
        if (OS.focusedWindowId === win.id) {
          titleWrap.appendChild(createEl('span', { textContent: 'focused', style: 'font-size:10px;color:var(--accent);border:1px solid var(--accent);border-radius:3px;padding:1px 5px;' }));
        }
        header.appendChild(titleWrap);

        // Click-to-act: WM.focusWindow/closeWindow are real public methods
        // on the window-manager singleton (confirmed as window.WM in
        // wm.js — every internal call site uses the same two functions).
        // No app in this codebase called them before; this is genuinely
        // new capability, not a rename of something that existed.
        //
        // id is read from a data attribute via event.currentTarget inside
        // the handler, not captured via closure over `win` — this makes it
        // impossible for the id to go stale regardless of how often/when
        // render() re-runs relative to when the click actually fires.
        const btns = createEl('div', { style: 'display:flex;gap:6px;flex-shrink:0;' });
        const focusBtn = createEl('button', { textContent: 'Focus', style: 'padding:3px 10px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;' });
        focusBtn.dataset.windowId = win.id;
        focusBtn.addEventListener('click', (e) => {
          window.WM?.focusWindow?.(e.currentTarget.dataset.windowId);
        }, { signal: ac.signal });
        const closeBtn = createEl('button', { textContent: 'Close', style: 'padding:3px 10px;background:transparent;color:#f85149;border:1px solid #f85149;border-radius:4px;cursor:pointer;font-size:11px;' });
        closeBtn.dataset.windowId = win.id;
        closeBtn.addEventListener('click', (e) => {
          window.WM?.closeWindow?.(e.currentTarget.dataset.windowId);
        }, { signal: ac.signal });
        btns.appendChild(focusBtn);
        btns.appendChild(closeBtn);
        header.appendChild(btns);
        row.appendChild(header);

        // Confirmed against wm.js: x/y/width/height/minimized/maximized are
        // flat on the state object itself (OS.windows.set(id, state)), not
        // nested under a .state property.
        row.appendChild(createEl('div', { textContent: `${win.x || 0},${win.y || 0} ${win.width || '?'}x${win.height || '?'}${win.minimized ? ' [min]' : ''}${win.maximized ? ' [max]' : ''}`, style: 'font-size:11px;color:var(--text-muted);margin-top:4px;font-family:monospace;' }));
        winsList.appendChild(row);
      });

      if (!filteredWins.length) {
        winsList.appendChild(createEl('div', { textContent: wins.length ? 'No windows match filter' : 'No windows open', style: 'color:var(--text-muted);padding:8px;' }));
      }
      winsSection.appendChild(winsList);
      scroll.appendChild(winsSection);
    }

    filterInput.addEventListener('input', render, { signal: ac.signal });

    // Live updates: OS.events fires 'app:opened' / 'app:closed' / 'app:focused'
    // (confirmed as the complete set of window-lifecycle events emitted
    // anywhere in wm.js — there's no resize/move/minimize event, so those
    // still rely on the polling fallback below rather than being instant).
    //
    // Root cause found live: wm.js's focusWindow() previously re-emitted
    // 'app:focused' on every single pointerdown inside a window's own
    // content, even when that window was already focused — so clicking
    // ANY button inside Inspector re-triggered a full render() (measured:
    // 63 DOM mutations in 3s just from normal interaction), destroying and
    // recreating the very button being clicked before its own click event
    // could fire. Fixed at the source in wm.js (focusWindow now no-ops
    // when already focused and not minimized). This local guard is a
    // second, cheap layer of defense: even if some other future emitter
    // fires 'app:focused' redundantly, Inspector won't re-render unless
    // the focused window id actually changed.
    let lastFocusedId = OS.focusedWindowId;
    const deferredRender = () => queueMicrotask(render);
    const onOpened  = deferredRender;
    const onClosed  = deferredRender;
    const onFocused = () => {
      if (OS.focusedWindowId === lastFocusedId) return;
      lastFocusedId = OS.focusedWindowId;
      deferredRender();
    };
    OS.events.on('app:opened', onOpened);
    OS.events.on('app:closed', onClosed);
    OS.events.on('app:focused', onFocused);

    const timeoutId = setTimeout(render, 100);
    // Reduced from the original 5s: this is now a fallback for state the
    // event system doesn't cover (minimize/maximize/drag/resize), not the
    // primary refresh mechanism, so a shorter interval doesn't cost much.
    const intervalId = setInterval(render, 2000);

    state.cleanups.push(() => {
      clearTimeout(timeoutId);
      clearInterval(intervalId);
      OS.events.off('app:opened', onOpened);
      OS.events.off('app:closed', onClosed);
      OS.events.off('app:focused', onFocused);
    });
  }
});