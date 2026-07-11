registerApp({
  id: 'modules',
  name: 'Modules',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiIgd2lkdGg9Ijk0IiBoZWlnaHQ9Ijk0Ij4KICA8ZGVmcz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0ibW9kLWwxIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNmZGU2OGEiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjZjU5ZTBiIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJtb2QtbDIiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iI2ZiYmYyNCIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiNkOTc3MDYiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9Im1vZC1sMyIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjZjU5ZTBiIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iI2I0NTMwOSIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICA8L2RlZnM+CiAgPCEtLSBzaGFkb3cgLS0+CiAgPGVsbGlwc2UgY3g9IjQ4IiBjeT0iOTAiIHJ4PSIzMCIgcnk9IjYiIGZpbGw9IiMwMDAiIG9wYWNpdHk9IjAuMTgiLz4KCiAgPCEtLSB0aHJlZSBzdGFja2VkIGRpYW1vbmQgc2xhYnMgLS0+CiAgPHBvbHlnb24gcG9pbnRzPSI0OCwyNiA3NCwzOCA0OCw1MCAyMiwzOCIgZmlsbD0idXJsKCNtb2QtbDEpIi8+CiAgPHBvbHlnb24gcG9pbnRzPSI0OCw0MiA3NCw1NCA0OCw2NiAyMiw1NCIgZmlsbD0idXJsKCNtb2QtbDIpIi8+CiAgPHBvbHlnb24gcG9pbnRzPSI0OCw1OCA3NCw3MCA0OCw4MiAyMiw3MCIgZmlsbD0idXJsKCNtb2QtbDMpIi8+CgogIDwhLS0gcmVmcmVzaCBsb29wIHdyYXBwaW5nIHRoZSBzdGFjayAtLT4KICA8cGF0aCBkPSJNNzYgNTggQTMyIDMyIDAgMSAxIDY2IDI2IiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmZmZmYiIHN0cm9rZS13aWR0aD0iNiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+CiAgPHBvbHlnb24gcG9pbnRzPSI2MCwxNiA3NCwyMiA2NCwzMiIgZmlsbD0iI2ZmZmZmZiIvPgoKICA8IS0tIGhpZ2hsaWdodCAtLT4KICA8ZWxsaXBzZSBjeD0iNDAiIGN5PSIzMiIgcng9IjEwIiByeT0iNCIgZmlsbD0iI2ZmZiIgb3BhY2l0eT0iMC40IiB0cmFuc2Zvcm09InJvdGF0ZSgtMjAgNDAgMzIpIi8+Cjwvc3ZnPgo=',
  description: 'Hot-reload OS JS modules without restarting NovaByte OS',
  category: 'developer',
  devOnly: true,
  autoGrant: true,
  defaultSize: [600, 550],
  minSize: [400, 350],
  // Fetches arbitrary internal module paths and dynamically imports the
  // response — functionally equivalent to remote code execution against
  // the OS's own module tree. Treat this as high-trust, same tier as
  // net:internal + system:settings, not just system:info.
  permissions: ['system:info', 'system:settings', 'net:internal'],
  init(content, state, options) {
    if (!window.AppDirs?.getVFSDir('com.nbosp.settings', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.settings</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
      return;
    }

    if (!OS.settings.get('devMode')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">🔒</div><div style="font-size:14px;text-align:center">Enable Developer Mode in Settings to use Modules.</div>';
      return;
    }

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-default,#0f1115);color:var(--text-primary,#e6e6e6);font-family:var(--font-ui,sans-serif);overflow:auto;padding:16px;font-size:13px;';

    const desc = createEl('div', { style: 'margin-bottom:12px;color:var(--text-muted);font-size:12px;' });
    desc.textContent = 'Reload any JS module without restarting the OS. Useful for rapid iteration.';
    content.appendChild(desc);

    const list = createEl('div', { style: 'display:flex;flex-direction:column;gap:6px;' });
    const modules = [
      { id: 'boot', path: 'js/core/core/boot.js' },
      { id: 'wm', path: 'js/core/ui/wm.js' },
      { id: 'fs', path: 'js/core/services/fs.js' },
      { id: 'app-registry', path: 'js/platform/core/app-registry.js' },
      { id: 'app-permission-manager', path: 'js/platform/security/app-permission-manager.js' },
      { id: 'system-events', path: 'js/core/events/system-events.js' },
      { id: 'base-utils', path: 'js/core/utils/base-utils.js' },
      { id: 'debug-overlay', path: 'js/core/utils/debug-overlay.js' },
    ];

    // AbortController for the per-row click listeners below — same pattern
    // as console.js and inspector.js. state.cleanups.push is the real
    // teardown hook the window manager honors (confirmed against wm.js).
    const ac = new AbortController();

    modules.forEach(mod => {
      const row = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:8px;background:var(--bg-elevated);border-radius:6px;border:1px solid var(--border-subtle);' });
      const info = createEl('div');
      info.appendChild(createEl('div', { textContent: mod.id, style: 'font-weight:600;font-size:13px;' }));
      info.appendChild(createEl('div', { textContent: mod.path, style: 'font-size:11px;color:var(--text-muted);font-family:monospace;' }));
      row.appendChild(info);

      const btn = createEl('button', { textContent: 'Reload', style: 'padding:4px 12px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;' });

      // Tracks the pending "reset button text" timeout so a second click
      // within the 1.5s window can cancel the first one instead of both
      // firing and stepping on each other's button state.
      let resetTimeoutId = null;
      // Plain flag instead of btn.disabled — there's no theme-consistent
      // :disabled style anywhere in style.css, so setting the attribute
      // would fall back to the browser's default greyed-out button, which
      // doesn't match this dark theme. This blocks re-entrancy the same
      // way without changing how the button looks.
      let inFlight = false;

      btn.addEventListener('click', async () => {
        // Each successful reload permanently pins a new module namespace
        // object in memory — that's inherent to importing a fresh blob URL
        // per reload (see MDN's import() docs on cache-busting via unique
        // specifiers), not something fixable without removing hot-reload
        // entirely. Guarding against re-entrancy at least stops a
        // double-click from needlessly doubling that cost for one click.
        if (inFlight) return;
        inFlight = true;
        if (resetTimeoutId != null) clearTimeout(resetTimeoutId);

        try {
          const url = '/' + mod.path + '?t=' + Date.now();
          const res = await fetch(url);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const code = await res.text();
          const blob = new Blob([code], { type: 'application/javascript' });
          const url2 = URL.createObjectURL(blob);
          await import(url2);
          // Safe to revoke right after import() resolves — by then the
          // module's been fetched and its top-level code has already run,
          // so the blob URL has nothing left to serve.
          URL.revokeObjectURL(url2);
          btn.textContent = '✓';
          btn.style.background = '#3fb950';
        } catch (e) {
          btn.textContent = '✗';
          btn.style.background = '#f85149';
        }
        resetTimeoutId = setTimeout(() => {
          btn.textContent = 'Reload';
          btn.style.background = 'var(--accent)';
          inFlight = false;
          resetTimeoutId = null;
        }, 1500);
      }, { signal: ac.signal });

      row.appendChild(btn);
      list.appendChild(row);
    });

    state.cleanups.push(() => ac.abort());

    content.appendChild(list);
  }
});