registerApp({
  id: 'modules',
  name: 'Modules',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiIgd2lkdGg9Ijk0IiBoZWlnaHQ9Ijk0Ij4KICA8ZGVmcz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0ibW9kLWwxIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNmZGU2OGEiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjZjU5ZTBiIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJtb2QtbDIiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iI2ZiYmYyNCIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiNkOTc3MDYiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9Im1vZC1sMyIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjZjU5ZTBiIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iI2I0NTMwOSIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICA8L2RlZnM+CiAgPCEtLSBzaGFkb3cgLS0+CiAgPGVsbGlwc2UgY3g9IjQ4IiBjeT0iOTAiIHJ4PSIzMCIgcnk9IjYiIGZpbGw9IiMwMDAiIG9wYWNpdHk9IjAuMTgiLz4KCiAgPCEtLSB0aHJlZSBzdGFja2VkIGRpYW1vbmQgc2xhYnMgLS0+CiAgPHBvbHlnb24gcG9pbnRzPSI0OCwyNiA3NCwzOCA0OCw1MCAyMiwzOCIgZmlsbD0idXJsKCNtb2QtbDEpIi8+CiAgPHBvbHlnb24gcG9pbnRzPSI0OCw0MiA3NCw1NCA0OCw2NiAyMiw1NCIgZmlsbD0idXJsKCNtb2QtbDIpIi8+CiAgPHBvbHlnb24gcG9pbnRzPSI0OCw1OCA3NCw3MCA0OCw4MiAyMiw3MCIgZmlsbD0idXJsKCNtb2QtbDMpIi8+CgogIDwhLS0gcmVmcmVzaCBsb29wIHdyYXBwaW5nIHRoZSBzdGFjayAtLT4KICA8cGF0aCBkPSJNNzYgNTggQTMyIDMyIDAgMSAxIDY2IDI2IiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmZmZmYiIHN0cm9rZS13aWR0aD0iNiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+CiAgPHBvbHlnb24gcG9pbnRzPSI2MCwxNiA3NCwyMiA2NCwzMiIgZmlsbD0iI2ZmZmZmZiIvPgoKICA8IS0tIGhpZ2hsaWdodCAtLT4KICA8ZWxsaXBzZSBjeD0iNDAiIGN5PSIzMiIgcng9IjEwIiByeT0iNCIgZmlsbD0iI2ZmZiIgb3BhY2l0eT0iMC40IiB0cmFuc2Zvcm09InJvdGF0ZSgtMjAgNDAgMzIpIi8+Cjwvc3ZnPgo=',
  description: 'Hot-reload OS JS modules without restarting NovaByte OS',
  category: 'developer',
  devOnly: true,
  autoGrant: true,
  defaultSize: [600, 600],
  minSize: [420, 380],
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

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-default,#0f1115);color:var(--text-primary,#e6e6e6);font-family:var(--font-ui,sans-serif);overflow:hidden;padding:16px;font-size:13px;box-sizing:border-box;';

    const desc = createEl('div', { style: 'margin-bottom:12px;color:var(--text-muted);font-size:12px;flex-shrink:0;' });
    desc.textContent = 'Reload any JS module without restarting the OS. Useful for rapid iteration.';
    content.appendChild(desc);

    // Defaults kept as a starting point, but the list is now editable and
    // persisted — the original hardcoded array meant any module outside
    // this exact set of 8 paths couldn't be hot-reloaded from this app at
    // all. Scoped storage key, same pattern as devconsole's history (see
    // console.js) since there's no VFS read/write helper for small app
    // state — lsSave/localStorage is what calendar.js, contacts.js, etc.
    // actually use.
    const STORAGE_KEY = 'nbosp_modules_list';
    const DEFAULT_MODULES = [
      { id: 'boot', path: 'js/core/core/boot.js' },
      { id: 'wm', path: 'js/core/ui/wm.js' },
      { id: 'fs', path: 'js/core/services/fs.js' },
      { id: 'app-registry', path: 'js/platform/core/app-registry.js' },
      { id: 'app-permission-manager', path: 'js/platform/security/app-permission-manager.js' },
      { id: 'system-events', path: 'js/core/events/system-events.js' },
      { id: 'base-utils', path: 'js/core/utils/base-utils.js' },
      { id: 'debug-overlay', path: 'js/core/utils/debug-overlay.js' },
    ];

    let modules;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      modules = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(modules) || !modules.length) modules = null;
    } catch {
      modules = null;
    }
    if (!modules) modules = DEFAULT_MODULES.slice();

    function saveModules() {
      try {
        if (typeof lsSave === 'function') lsSave(STORAGE_KEY, modules);
        else localStorage.setItem(STORAGE_KEY, JSON.stringify(modules));
      } catch {
        // Best-effort — same degrade-silently pattern used elsewhere for
        // storage failures (quota, private mode, etc).
      }
    }

    // AbortController for the per-row click listeners below plus the
    // add-module form and reload-all button — same pattern as console.js
    // and inspector.js. state.cleanups.push is the real teardown hook the
    // window manager honors (confirmed against wm.js).
    const ac = new AbortController();
    state.cleanups.push(() => ac.abort());

    const toolbar = createEl('div', { style: 'display:flex;gap:8px;margin-bottom:12px;flex-shrink:0;' });
    const reloadAllBtn = createEl('button', { textContent: 'Reload All', style: 'padding:6px 12px;background:var(--bg-elevated);color:var(--text-primary);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:12px;' });
    toolbar.appendChild(reloadAllBtn);
    content.appendChild(toolbar);

    const list = createEl('div', { style: 'display:flex;flex-direction:column;gap:6px;overflow:auto;flex:1;' });
    content.appendChild(list);

    const addRow = createEl('div', { style: 'display:flex;gap:8px;margin-top:12px;flex-shrink:0;' });
    const idInput = createEl('input', { placeholder: 'id (e.g. my-module)', style: 'width:140px;padding:6px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:11px;' });
    const pathInput = createEl('input', { placeholder: 'path (e.g. js/apps/foo.js)', style: 'flex:1;padding:6px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:11px;' });
    const addBtn = createEl('button', { textContent: 'Add', style: 'padding:6px 14px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;' });
    addRow.appendChild(idInput);
    addRow.appendChild(pathInput);
    addRow.appendChild(addBtn);
    content.appendChild(addRow);

    async function reloadOne(mod, btn) {
      btn.disabled = true;
      // No generic :disabled styling exists in style.css (only a
      // browser-nav-btn-specific rule), so the attribute alone wouldn't
      // give any visual feedback that the button is mid-reload — set
      // opacity directly instead.
      btn.style.opacity = '0.6';
      const prevText = btn.textContent;
      const prevBg = btn.style.background;
      btn.textContent = '…';
      try {
        const url = '/' + mod.path + '?t=' + Date.now();
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + mod.path);
        const code = await res.text();

        // Real root cause (confirmed via browser console, not guessed):
        // this was never a blob-vs-data URL scheme-support issue. The
        // server's CSP (server/middleware.js, helmet's scriptSrcElem
        // directive) simply never included blob: or data: — even though
        // workerSrc and frameSrc both already allowed blob: for their
        // respective content types, scriptSrcElem was never extended to
        // match. Fixed at the source by adding blob: to scriptSrcElem;
        // reverted here to blob: (no base64/percent-encoding overhead)
        // now that the policy actually permits it.
        const blob = new Blob([code], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        try {
          await import(blobUrl);
        } finally {
          // Safe to revoke right after import() resolves/rejects — by then
          // the module's been fetched and its top-level code has already
          // run (or thrown), so the blob URL has nothing left to serve.
          URL.revokeObjectURL(blobUrl);
        }

        btn.textContent = '✓';
        btn.style.background = '#3fb950';
        btn.title = '';
        return { ok: true };
      } catch (e) {
        btn.textContent = '✗';
        btn.style.background = '#f85149';
        // Surface the actual error instead of just a red X — hovering
        // shows what broke (bad path, syntax error, import failure, etc),
        // which the original silently discarded.
        btn.title = e.message;
        return { ok: false, error: e.message };
      } finally {
        setTimeout(() => {
          btn.textContent = prevText;
          btn.style.background = prevBg;
          btn.style.opacity = '';
          btn.disabled = false;
        }, 1500);
      }
    }

    function render() {
      list.innerHTML = '';
      modules.forEach((mod, idx) => {
        const row = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:8px;background:var(--bg-elevated);border-radius:6px;border:1px solid var(--border-subtle);gap:8px;' });
        const info = createEl('div', { style: 'min-width:0;overflow:hidden;' });
        info.appendChild(createEl('div', { textContent: mod.id, style: 'font-weight:600;font-size:13px;' }));
        info.appendChild(createEl('div', { textContent: mod.path, style: 'font-size:11px;color:var(--text-muted);font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }));
        row.appendChild(info);

        const btns = createEl('div', { style: 'display:flex;gap:6px;flex-shrink:0;' });
        const btn = createEl('button', { textContent: 'Reload', style: 'padding:4px 12px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;' });
        btn.addEventListener('click', () => reloadOne(mod, btn), { signal: ac.signal });
        btns.appendChild(btn);

        const removeBtn = createEl('button', { textContent: '✕', title: 'Remove from list', style: 'padding:4px 8px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:12px;' });
        removeBtn.addEventListener('click', () => {
          modules.splice(idx, 1);
          saveModules();
          render();
        }, { signal: ac.signal });
        btns.appendChild(removeBtn);

        row.appendChild(btns);
        list.appendChild(row);
      });

      if (!modules.length) {
        list.appendChild(createEl('div', { textContent: 'No modules in list. Add one below.', style: 'color:var(--text-muted);padding:8px;' }));
      }
    }

    addBtn.addEventListener('click', () => {
      const id = idInput.value.trim();
      const path = pathInput.value.trim();
      if (!id || !path) return;
      modules.push({ id, path });
      saveModules();
      idInput.value = '';
      pathInput.value = '';
      render();
    }, { signal: ac.signal });

    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) addBtn.click();
    }, { signal: ac.signal });

    reloadAllBtn.addEventListener('click', async () => {
      reloadAllBtn.disabled = true;
      const rows = [...list.children];
      await Promise.all(modules.map((mod, i) => {
        const btn = rows[i]?.querySelector('button');
        return btn ? reloadOne(mod, btn) : Promise.resolve();
      }));
      reloadAllBtn.disabled = false;
    }, { signal: ac.signal });

    render();
  }
});