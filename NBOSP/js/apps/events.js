registerApp({
  id: 'events',
  name: 'Events',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiIgd2lkdGg9Ijk0IiBoZWlnaHQ9Ijk0Ij4KICA8ZGVmcz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0iZXZ0LWJvZHkiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzMzNDE1NSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMwZjE3MmEiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImV2dC1iYXIiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIwIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzQ3NTU2OSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMxZTI5M2IiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgPC9kZWZzPgogIDxlbGxpcHNlIGN4PSI0OCIgY3k9IjkwIiByeD0iMzAiIHJ5PSI2IiBmaWxsPSIjMDAwIiBvcGFjaXR5PSIwLjE4Ii8+CiAgPHJlY3QgeD0iMTQiIHk9IjIwIiB3aWR0aD0iNjgiIGhlaWdodD0iNTQiIHJ4PSI4IiBmaWxsPSJ1cmwoI2V2dC1ib2R5KSIvPgogIDxyZWN0IHg9IjE0IiB5PSIyMCIgd2lkdGg9IjY4IiBoZWlnaHQ9IjE0IiByeD0iOCIgZmlsbD0idXJsKCNldnQtYmFyKSIvPgogIDxyZWN0IHg9IjE0IiB5PSIyNyIgd2lkdGg9IjY4IiBoZWlnaHQ9IjciIGZpbGw9InVybCgjZXZ0LWJhcikiLz4KICA8Y2lyY2xlIGN4PSIyMiIgY3k9IjI3IiByPSIyLjUiIGZpbGw9IiNmODcxNzEiLz4KICA8Y2lyY2xlIGN4PSIzMCIgY3k9IjI3IiByPSIyLjUiIGZpbGw9IiNmYmJmMjQiLz4KICA8Y2lyY2xlIGN4PSIzOCIgY3k9IjI3IiByPSIyLjUiIGZpbGw9IiM0YWRlODAiLz4KICA8bGluZSB4MT0iMjIiIHkxPSI0NiIgeDI9Ijc0IiB5Mj0iNDYiIHN0cm9rZT0iIzRhZGU4MCIgc3Ryb2tlLXdpZHRoPSIzIiBzdHJva2UtbGluZWNhcD0icm91bmQiLz4KICA8bGluZSB4MT0iMjIiIHkxPSI1NiIgeDI9IjY0IiB5Mj0iNTYiIHN0cm9rZT0iI2ZiYmYyNCIgc3Ryb2tlLXdpZHRoPSIzIiBzdHJva2UtbGluZWNhcD0icm91bmQiLz4KICA8bGluZSB4MT0iMjIiIHkxPSI2NiIgeDI9IjcwIiB5Mj0iNjYiIHN0cm9rZT0iI2Y4NzE3MSIgc3Ryb2tlLXdpZHRoPSIzIiBzdHJva2UtbGluZWNhcD0icm91bmQiLz4KICA8cmVjdCB4PSIxNCIgeT0iMjAiIHdpZHRoPSI2OCIgaGVpZ2h0PSIxNCIgcng9IjgiIGZpbGw9IiNmZmYiIG9wYWNpdHk9IjAuMDgiLz4KPC9zdmc+',
  description: 'Unified timeline of console output, permission events, and package events',
  category: 'developer',
  devOnly: true,
  autoGrant: true,
  defaultSize: [700, 520],
  minSize: [420, 320],
  permissions: ['system:info', 'system:settings'],
  init(content, state, options) {
    if (!window.AppDirs?.getVFSDir('com.nbosp.settings', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.settings</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
      return;
    }

    if (!OS.settings.get('devMode')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">🔒</div><div style="font-size:14px;text-align:center">Enable Developer Mode in Settings to use Events.</div>';
      return;
    }

    if (typeof EventLog === 'undefined') {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center">EventLog service is not available in this context.</div>';
      return;
    }

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-default,#0f1115);color:var(--text-primary,#e6e6e6);font-family:var(--font-ui,sans-serif);overflow:hidden;padding:16px;font-size:13px;box-sizing:border-box;';

    const ac = new AbortController();
    state.cleanups.push(() => ac.abort());

    // ── Toolbar ────────────────────────────────────────────────────────
    const toolbar = createEl('div', { style: 'display:flex;gap:8px;margin-bottom:8px;flex-shrink:0;flex-wrap:wrap;' });

    const searchInput = createEl('input', {
      placeholder: 'Filter by message or app…',
      style: 'flex:1;min-width:140px;padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:11px;box-sizing:border-box;'
    });

    const appSelect = createEl('select', {
      style: 'padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-size:11px;'
    });
    appSelect.appendChild(createEl('option', { value: '', textContent: 'All apps' }));

    const severitySelect = createEl('select', {
      style: 'padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-size:11px;'
    });
    for (const [value, label] of [['', 'All severities'], ['info', 'Info'], ['warn', 'Warn'], ['error', 'Error']]) {
      severitySelect.appendChild(createEl('option', { value, textContent: label }));
    }

    const pauseBtn = createEl('button', { textContent: 'Pause', title: 'Pause live updates without losing scroll position', style: 'padding:5px 10px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;' });
    const clearBtn = createEl('button', { textContent: 'Clear', title: 'Clear the event log', style: 'padding:5px 10px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;' });
    const exportBtn = createEl('button', { textContent: 'Export', title: 'Download the filtered events as a .txt file', style: 'padding:5px 10px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;' });

    toolbar.appendChild(searchInput);
    toolbar.appendChild(appSelect);
    toolbar.appendChild(severitySelect);
    toolbar.appendChild(pauseBtn);
    toolbar.appendChild(clearBtn);
    toolbar.appendChild(exportBtn);
    content.appendChild(toolbar);

    const countLine = createEl('div', { style: 'font-size:11px;color:var(--text-muted);margin-bottom:6px;flex-shrink:0;' });
    content.appendChild(countLine);

    const list = createEl('div', {
      style: 'flex:1;overflow:auto;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:6px;padding:4px;'
    });
    content.appendChild(list);

    // ── State ──────────────────────────────────────────────────────────
    let paused = false;
    let searchQuery = '';
    let appFilter = '';
    let severityFilter = '';
    let knownApps = new Set();

    const SEVERITY_COLOR = { info: 'var(--text-muted, #9ca3af)', warn: '#fbbf24', error: '#f87171' };
    const SEVERITY_LABEL = { info: 'INFO', warn: 'WARN', error: 'ERROR' };

    function refreshAppOptions(entries) {
      let changed = false;
      for (const e of entries) {
        if (!knownApps.has(e.app)) { knownApps.add(e.app); changed = true; }
      }
      if (!changed) return;
      const current = appSelect.value;
      appSelect.innerHTML = '';
      appSelect.appendChild(createEl('option', { value: '', textContent: 'All apps' }));
      for (const app of [...knownApps].sort((a, b) => a.localeCompare(b))) {
        appSelect.appendChild(createEl('option', { value: app, textContent: app }));
      }
      appSelect.value = current;
    }

    function formatTime(ts) {
      const d = new Date(ts);
      return d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
    }

    function matches(e) {
      if (severityFilter && e.severity !== severityFilter) return false;
      if (appFilter && e.app !== appFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!e.message.toLowerCase().includes(q) && !e.app.toLowerCase().includes(q)) return false;
      }
      return true;
    }

    let lastFiltered = [];

    function render() {
      const all = EventLog.getAll();
      refreshAppOptions(all);
      const filtered = all.filter(matches);
      lastFiltered = filtered;

      countLine.textContent = filtered.length === all.length
        ? `${all.length} event${all.length === 1 ? '' : 's'}`
        : `${filtered.length} of ${all.length} events`;

      list.innerHTML = '';
      if (!filtered.length) {
        list.appendChild(createEl('div', {
          style: 'padding:24px;text-align:center;color:var(--text-muted);font-size:12px;',
          textContent: all.length ? 'No events match the current filter.' : 'No events yet. Activity from apps, permissions, and packages will show up here.'
        }));
        return;
      }

      // Newest first — matches EventLog.log's unshift order already, so no
      // extra sort needed here.
      for (const e of filtered.slice(0, 500)) {
        const row = createEl('div', {
          style: `display:flex;gap:8px;padding:4px 8px;border-radius:4px;font-family:monospace;font-size:11px;align-items:baseline;`
        });
        row.appendChild(createEl('span', { style: 'color:var(--text-muted);flex-shrink:0;white-space:nowrap;', textContent: formatTime(e.timestamp) }));
        row.appendChild(createEl('span', {
          style: `color:${SEVERITY_COLOR[e.severity] || SEVERITY_COLOR.info};flex-shrink:0;width:42px;font-weight:600;`,
          textContent: SEVERITY_LABEL[e.severity] || 'INFO'
        }));
        row.appendChild(createEl('span', { style: 'color:var(--accent, #67e8f9);flex-shrink:0;white-space:nowrap;', textContent: `[${e.app}]` }));
        row.appendChild(createEl('span', { style: 'color:var(--text-primary);word-break:break-word;flex:1;', textContent: e.message }));
        list.appendChild(row);
      }
    }

    // ── Live updates ───────────────────────────────────────────────────
    const unsubscribe = EventLog.subscribe(() => {
      if (paused) return;
      render();
    });
    state.cleanups.push(unsubscribe);

    // ── Wiring ─────────────────────────────────────────────────────────
    searchInput.addEventListener('input', () => { searchQuery = searchInput.value; render(); }, { signal: ac.signal });
    appSelect.addEventListener('change', () => { appFilter = appSelect.value; render(); }, { signal: ac.signal });
    severitySelect.addEventListener('change', () => { severityFilter = severitySelect.value; render(); }, { signal: ac.signal });

    pauseBtn.addEventListener('click', () => {
      paused = !paused;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
      pauseBtn.style.color = paused ? 'var(--accent, #67e8f9)' : 'var(--text-muted)';
      if (!paused) render();
    }, { signal: ac.signal });

    clearBtn.addEventListener('click', () => {
      EventLog.clear();
      render();
    }, { signal: ac.signal });

    exportBtn.addEventListener('click', () => {
      if (!lastFiltered.length) return;
      const lines = lastFiltered.map(e => `${new Date(e.timestamp).toISOString()} [${SEVERITY_LABEL[e.severity] || 'INFO'}] [${e.app}] ${e.message}`);
      const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = createEl('a', { href: url, download: 'nbosp-events-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, { signal: ac.signal });

    render();
  }
});
