registerApp({
  id: 'permissions',
  name: 'Permissions',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiIgd2lkdGg9Ijk0IiBoZWlnaHQ9Ijk0Ij4KICA8ZGVmcz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0icHJtLXNoaWVsZCIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjNmVlN2I3Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iIzA1OTY2OSIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0icHJtLWZhY2UiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iI2VjZmRmNSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiNhN2YzZDAiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9InBybS1iYWRnZSIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjODZlZmFjIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iIzE2YTM0YSIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICA8L2RlZnM+CiAgPCEtLSBzaGFkb3cgLS0+CiAgPGVsbGlwc2UgY3g9IjQ4IiBjeT0iOTAiIHJ4PSIzMCIgcnk9IjYiIGZpbGw9IiMwMDAiIG9wYWNpdHk9IjAuMTgiLz4KCiAgPCEtLSBzaGllbGQgYm9keSAtLT4KICA8cGF0aCBkPSJNNDggMTAgTDc2IDIwIFY0NCBDNzYgNjIgNjQgNzYgNDggODQgQzMyIDc2IDIwIDYyIDIwIDQ0IFYyMCBaIiBmaWxsPSJ1cmwoI3BybS1zaGllbGQpIi8+CiAgPCEtLSBpbm5lciBmYWNlIC0tPgogIDxwYXRoIGQ9Ik00OCAxOCBMNjkgMjYgVjQ0IEM2OSA1OCA2MCA2OSA0OCA3NSBDMzYgNjkgMjcgNTggMjcgNDQgVjI2IFoiIGZpbGw9InVybCgjcHJtLWZhY2UpIi8+CgogIDwhLS0ga2V5aG9sZSAtLT4KICA8Y2lyY2xlIGN4PSI0OCIgY3k9IjQwIiByPSI3IiBmaWxsPSIjMDU5NjY5Ii8+CiAgPHBvbHlnb24gcG9pbnRzPSI0NCw0MiA1Miw0MiA0OS41LDU0IDQ2LjUsNTQiIGZpbGw9IiMwNTk2NjkiLz4KCiAgPCEtLSBjaGVjayBiYWRnZSAtLT4KICA8Y2lyY2xlIGN4PSI2OCIgY3k9IjY2IiByPSIxNCIgZmlsbD0idXJsKCNwcm0tYmFkZ2UpIi8+CiAgPHBvbHlsaW5lIHBvaW50cz0iNjEsNjYgNjYsNzEgNzYsNTgiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZmZmZiIgc3Ryb2tlLXdpZHRoPSI0IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KCiAgPCEtLSBoaWdobGlnaHQgLS0+CiAgPGVsbGlwc2UgY3g9IjQwIiBjeT0iMjQiIHJ4PSIxMiIgcnk9IjUiIGZpbGw9IiNmZmYiIG9wYWNpdHk9IjAuMzUiIHRyYW5zZm9ybT0icm90YXRlKC0yMCA0MCAyNCkiLz4KPC9zdmc+Cg==',
  description: 'Review granted, denied, and pending permissions across registered apps',
  category: 'developer',
  devOnly: true,
  autoGrant: true,
  defaultSize: [650, 550],
  minSize: [420, 350],
  permissions: ['system:apps', 'system:settings'],
  init(content, state, options) {
    if (!window.AppDirs?.getVFSDir('com.nbosp.settings', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.settings</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
      return;
    }

    if (!OS.settings.get('devMode')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">🔒</div><div style="font-size:14px;text-align:center">Enable Developer Mode in Settings to use Permissions.</div>';
      return;
    }

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-default,#0f1115);color:var(--text-primary,#e6e6e6);font-family:var(--font-ui,sans-serif);overflow:auto;padding:16px;font-size:13px;';

    function render() {
      content.innerHTML = '';
      const apps = Array.isArray(window.APP_REGISTRY) ? window.APP_REGISTRY : [];

      if (!apps.length) {
        content.appendChild(createEl('div', { textContent: 'No apps registered', style: 'color:var(--text-muted);' }));
        return;
      }

      const table = createEl('table', { style: 'width:100%;border-collapse:collapse;font-size:12px;' });
      // createEl(tag, attrs, children) only takes 3 params — children must
      // be a single array, not one argument per child. Passing 4 <th>
      // elements as separate positional arguments (as this did before)
      // silently drops everything past the 3rd argument, since JS just
      // ignores extra arguments a function never declared. Only "App" ever
      // rendered; "Granted", "Denied", and "Pending" were dropped headers
      // with no visible sign anything was missing.
      table.appendChild(createEl('thead', {},
        [createEl('tr', {}, [
          createEl('th', { textContent: 'App', style: 'text-align:left;padding:6px;border-bottom:1px solid var(--border-subtle);color:var(--text-muted);font-weight:600;' }),
          createEl('th', { textContent: 'Granted', style: 'text-align:left;padding:6px;border-bottom:1px solid var(--border-subtle);color:var(--text-muted);font-weight:600;' }),
          createEl('th', { textContent: 'Denied', style: 'text-align:left;padding:6px;border-bottom:1px solid var(--border-subtle);color:var(--text-muted);font-weight:600;' }),
          createEl('th', { textContent: 'Pending', style: 'text-align:left;padding:6px;border-bottom:1px solid var(--border-subtle);color:var(--text-muted);font-weight:600;' }),
        ])]
      ));

      apps.forEach(app => {
        const perms = app.permissions || [];
        const managerAvailable = typeof AppPermissionManager !== 'undefined';
        const granted = managerAvailable ? perms.filter(p => AppPermissionManager.isGranted(p, app.id)).length : 0;
        const denied = managerAvailable ? perms.filter(p => AppPermissionManager.isDenied(p, app.id)).length : 0;
        const pending = managerAvailable ? (perms.length - granted - denied) : 0;
        const unknown = managerAvailable ? 0 : perms.length;

        const row = createEl('tr', { style: 'border-bottom:1px solid var(--border-subtle);' });
        row.appendChild(createEl('td', { textContent: app.name || app.id, style: 'padding:6px;' }));
        row.appendChild(createEl('td', { textContent: String(granted), style: 'padding:6px;color:#3fb950;' }));
        row.appendChild(createEl('td', { textContent: String(denied), style: 'padding:6px;color:#f85149;' }));
        row.appendChild(createEl('td', { textContent: unknown ? '—' : String(pending), style: 'padding:6px;color:#d29922;', title: unknown ? 'AppPermissionManager unavailable' : '' }));
        table.appendChild(row);
      });

      content.appendChild(table);

      // Permission type reference
      const ref = createEl('div', { style: 'margin-top:20px;' });
      ref.appendChild(createEl('h4', { textContent: 'Permission Types', style: 'margin:0 0 8px;font-size:13px;color:var(--accent);' }));
      const types = typeof AppPermissionManager !== 'undefined' ? AppPermissionManager.PERMISSION_TYPES : {};
      const list = createEl('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:4px;font-size:11px;font-family:monospace;' });
      for (const [key, val] of Object.entries(types)) {
        list.appendChild(createEl('div', { textContent: `${key} → ${val}`, style: 'padding:4px;background:var(--bg-elevated);border-radius:4px;' }));
      }
      ref.appendChild(list);
      content.appendChild(ref);
    }

    const timeoutId = setTimeout(render, 100);
    const intervalId = setInterval(render, 5000);
    // state.cleanups.push(fn) is the teardown hook the window manager
    // actually calls on close (confirmed against wm.js) — content never
    // dispatches a 'close' event anywhere in this codebase, so the old
    // listener never ran and this interval leaked for the OS session every
    // time the window closed.
    state.cleanups.push(() => {
      clearTimeout(timeoutId);
      clearInterval(intervalId);
    });
  }
});