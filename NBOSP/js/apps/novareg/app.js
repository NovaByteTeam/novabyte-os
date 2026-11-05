// NovaReg — NovaByte Registry Editor
//
// Dev-mode-only system app. Runs unrestricted in the OS page (same pattern
// as Console/devconsole), so it talks to window.NovaRegistry directly
// instead of going through the sandbox bridge. Sandboxed apps get the same
// store through nova:reg:* under the registry.* permission model; this
// editor is the trusted glass over it.

registerApp({
  id: 'com.nbosp.novareg',
  name: 'NovaReg',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIiB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsPSJOb3ZhUmVnIGljb24iPgogIDxkZWZzPgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJiZyIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiMwZjE3MmEiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMWUyOTNiIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJkYiIgeDE9IjAiIHkxPSIwIiB4Mj0iMCIgeTI9IjEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiM3ZGQzZmMiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIwLjU1IiBzdG9wLWNvbG9yPSIjMzhiZGY4Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzI1NjNlYiIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0iZGJUb3AiIHgxPSIwIiB5MT0iMCIgeDI9IjAiIHkyPSIxIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjYmFlNmZkIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzdkZDNmYyIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0ia2V5IiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iI2ZkZTY4YSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNmNTllMGIiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8ZmlsdGVyIGlkPSJkcyIgeD0iLTMwJSIgeT0iLTMwJSIgd2lkdGg9IjE2MCUiIGhlaWdodD0iMTYwJSI+CiAgICAgIDxmZURyb3BTaGFkb3cgZHg9IjAiIGR5PSI2IiBzdGREZXZpYXRpb249IjgiIGZsb29kLWNvbG9yPSIjMDAwMDAwIiBmbG9vZC1vcGFjaXR5PSIwLjQ1Ii8+CiAgICA8L2ZpbHRlcj4KICA8L2RlZnM+CgogIDwhLS0gYmFja2dyb3VuZCAtLT4KICA8cmVjdCB4PSIxNiIgeT0iMTYiIHdpZHRoPSI0ODAiIGhlaWdodD0iNDgwIiByeD0iMTEyIiBmaWxsPSJ1cmwoI2JnKSIvPgoKICA8IS0tIGZhaW50IE4gbW9ub2dyYW0gLS0+CiAgPHRleHQgeD0iMjU2IiB5PSIzMzAiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtZmFtaWx5PSJBcmlhbCwgSGVsdmV0aWNhLCBzYW5zLXNlcmlmIgogICAgICAgIGZvbnQtc2l6ZT0iMzYwIiBmb250LXdlaWdodD0iODAwIiBmaWxsPSIjMzhiZGY4IiBvcGFjaXR5PSIwLjA3Ij5OPC90ZXh0PgoKICA8IS0tIHJlZ2lzdHJ5IGRhdGFiYXNlIGN5bGluZGVyIC0tPgogIDxnIGZpbHRlcj0idXJsKCNkcykiPgogICAgPHBhdGggZD0iTTExMCAxNjggdjE3NiBhMTIyIDQ0IDAgMCAwIDI0NCAwIHYtMTc2IHoiIGZpbGw9InVybCgjZGIpIi8+CiAgICA8cGF0aCBkPSJNMTEwIDI1MiBhMTIyIDQ0IDAgMCAwIDI0NCAwIiBmaWxsPSJub25lIiBzdHJva2U9IiMxZTNhOGEiIHN0cm9rZS13aWR0aD0iMTAiIG9wYWNpdHk9IjAuNDUiLz4KICAgIDxwYXRoIGQ9Ik0xMTAgMzIyIGExMjIgNDQgMCAwIDAgMjQ0IDAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzFlM2E4YSIgc3Ryb2tlLXdpZHRoPSIxMCIgb3BhY2l0eT0iMC40NSIvPgogICAgPGVsbGlwc2UgY3g9IjIzMiIgY3k9IjE2OCIgcng9IjEyMiIgcnk9IjQ0IiBmaWxsPSJ1cmwoI2RiVG9wKSIvPgogICAgPGVsbGlwc2UgY3g9IjIzMiIgY3k9IjE2OCIgcng9Ijg0IiByeT0iMjciIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzI1NjNlYiIgc3Ryb2tlLXdpZHRoPSI4IiBvcGFjaXR5PSIwLjU1Ii8+CiAgPC9nPgoKICA8IS0tIGtleSAtLT4KICA8ZyBmaWx0ZXI9InVybCgjZHMpIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgzMzAgMzQ0KSByb3RhdGUoLTQyKSI+CiAgICA8Y2lyY2xlIGN4PSIwIiBjeT0iMCIgcj0iMzQiIGZpbGw9Im5vbmUiIHN0cm9rZT0idXJsKCNrZXkpIiBzdHJva2Utd2lkdGg9IjI0Ii8+CiAgICA8cmVjdCB4PSIzNCIgeT0iLTEyIiB3aWR0aD0iMTUyIiBoZWlnaHQ9IjI0IiByeD0iMTIiIGZpbGw9InVybCgja2V5KSIvPgogICAgPHJlY3QgeD0iMTI4IiB5PSIxMCIgd2lkdGg9IjIyIiBoZWlnaHQ9IjM2IiByeD0iNyIgZmlsbD0idXJsKCNrZXkpIi8+CiAgICA8cmVjdCB4PSIxNjQiIHk9IjEwIiB3aWR0aD0iMjIiIGhlaWdodD0iMjgiIHJ4PSI3IiBmaWxsPSJ1cmwoI2tleSkiLz4KICA8L2c+Cjwvc3ZnPgo=',
  description: 'Edit the NovaByte Registry',
  category: 'developer',
  version: '1.0.0',
  devOnly: true,
  defaultSize: [880, 560],
  minSize: [640, 420],

  init(content, state, options) {
    if (!window.NovaRegistry || typeof window.NovaRegistry.get !== 'function') {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:14px;text-align:center">NovaByte Registry engine not available.<br>This app requires NovaByte OS.</div>';
      return;
    }

    if (!OS.settings.get('devMode')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">🔒</div><div style="font-size:14px;text-align:center">Enable Developer Mode in Settings to use NovaReg.</div>';
      return;
    }

    const Reg = window.NovaRegistry;
    const ac = new AbortController();

    const HIVES = Reg.HIVES || ['HKNS', 'HKNU', 'HKNA', 'HKND'];
    const TYPES = Reg.VALUE_TYPES || ['REG_SZ', 'REG_BOOL', 'REG_DWORD', 'REG_QWORD', 'REG_JSON', 'REG_BINARY'];

    // Editor state — selectedPath is the KEY path highlighted in the tree
    // (a hive root at minimum); selectedValue is a value name in the table.
    let selectedPath = 'HKNS';
    let expanded = { HKNS: true };     // key path -> bool
    let treeCache = {};                // key path -> { keys: [...], values: {...} }
    let statusMessage = 'NovaReg ready.';
    let filterText = '';

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-default,#0f1115);color:var(--text-primary,#e6e6e6);font-family:var(--font-ui,sans-serif);font-size:12px;box-sizing:border-box;overflow:hidden;';

    // ── helpers ────────────────────────────────────────────────────────
    const el = (tag, style, text) => {
      const node = document.createElement(tag);
      if (style) node.style.cssText = style;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    function setStatus(message) {
      statusMessage = message;
      statusBar.textContent = selectedPath + (selectedValue ? '  ·  value: ' + selectedValue : '') + '  —  ' + statusMessage;
    }

    function keyOf(path) { return path.split('/').slice(0, -1).join('/') || path.split('/')[0]; }

    function errorMessage(err) { return (err && err.message) ? err.message : String(err); }

    // ── toolbar ────────────────────────────────────────────────────────
    const toolbar = el('div', 'display:flex;gap:6px;padding:8px;border-bottom:1px solid var(--border-subtle,#2a2f3a);align-items:center;flex-shrink:0;flex-wrap:wrap;');

    const jumpInput = el('input', 'flex:1;min-width:180px;padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:11px;box-sizing:border-box;');
    jumpInput.placeholder = 'Jump to path — e.g. HKNS/shell/wallpaper';
    const jumpBtn = el('button', btnStyle(true), 'Go');
    const filterInput = el('input', 'width:140px;padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-size:11px;box-sizing:border-box;');
    filterInput.placeholder = 'Filter keys…';

    function btnStyle(primary) {
      return 'padding:5px 10px;' + (primary
        ? 'background:var(--accent,#58a6ff);color:#fff;border:none;'
        : 'background:transparent;color:var(--text-muted,#9aa4b2);border:1px solid var(--border-subtle,#2a2f3a);') +
        'border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;';
    }
    const newKeyBtn = el('button', btnStyle(false), '+ Key');
    const newValueBtn = el('button', btnStyle(false), '+ Value');
    const deleteBtn = el('button', btnStyle(false), 'Delete');
    const exportBtn = el('button', btnStyle(false), 'Export');
    const importBtn = el('button', btnStyle(false), 'Import');
    const importFile = el('input');
    importFile.type = 'file';
    importFile.accept = '.json,application/json';
    importFile.style.display = 'none';

    toolbar.append(jumpInput, jumpBtn, filterInput, newKeyBtn, newValueBtn, deleteBtn, exportBtn, importBtn, importFile);

    // ── main split ─────────────────────────────────────────────────────
    const main = el('div', 'display:flex;flex:1;min-height:0;');
    const treePane = el('div', 'width:280px;flex-shrink:0;border-right:1px solid var(--border-subtle,#2a2f3a);overflow:auto;padding:6px;');
    const valuePane = el('div', 'flex:1;display:flex;flex-direction:column;min-width:0;');

    const valueHeader = el('div', 'padding:8px 10px;border-bottom:1px solid var(--border-subtle,#2a2f3a);color:var(--text-muted,#9aa4b2);font-weight:600;flex-shrink:0;');
    const valueTable = el('div', 'flex:1;overflow:auto;padding:4px 10px;');
    valuePane.append(valueHeader, valueTable);

    main.append(treePane, valuePane);

    // ── status bar ─────────────────────────────────────────────────────
    const statusBar = el('div', 'padding:6px 10px;border-top:1px solid var(--border-subtle,#2a2f3a);color:var(--text-muted,#9aa4b2);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;');

    content.append(toolbar, main, statusBar);

    // ── tree rendering (lazy: children load on expand) ─────────────────
    function nodeLabel(path) { return path.split('/').pop(); }

    function makeKeyRow(path, depth, hasChildren) {
      const row = el('div', 'display:flex;align-items:center;gap:4px;padding:3px 6px;border-radius:4px;cursor:pointer;white-space:nowrap;');
      row.style.paddingLeft = (6 + depth * 14) + 'px';
      const isOpen = !!expanded[path];
      const caret = el('span', 'width:12px;display:inline-block;text-align:center;color:var(--text-muted,#9aa4b2);', hasChildren ? (isOpen ? '▾' : '▸') : '·');
      const label = el('span', 'font-family:monospace;', nodeLabel(path));
      row.append(caret, label);
      if (path === selectedPath) row.style.background = 'var(--accent-muted,rgba(88,166,255,0.15))';
      row.addEventListener('click', () => {
        if (hasChildren || !treeCache[path]) expanded[path] = !expanded[path];
        else expanded[path] = true;
        selectedPath = path;
        selectedValue = null;
        refresh().then(() => setStatus('Browsing ' + path));
      }, { signal: ac.signal });
      return row;
    }

    function renderTreeNode(path, depth, container) {
      container.appendChild(makeKeyRow(path, depth, true));
      if (!expanded[path]) return;
      const listing = treeCache[path];
      const keys = (listing ? listing.keys : []).filter((k) => !filterText || k.toLowerCase().includes(filterText));
      for (const child of keys) renderTreeNode(path + '/' + child, depth + 1, container);
    }

    function renderTree() {
      treePane.textContent = '';
      for (const hive of HIVES) {
        if (filterText && hive.toLowerCase().includes(filterText) === false && !expanded[hive]) continue;
        renderTreeNode(hive, 0, treePane);
      }
    }

    // ── value table ────────────────────────────────────────────────────
    function makeValueRow(name, entry) {
      const row = el('div', 'display:grid;grid-template-columns:1.1fr 0.7fr 2fr auto;gap:8px;padding:5px 6px;border-radius:4px;cursor:pointer;align-items:baseline;');
      if (selectedValue === name) row.style.background = 'var(--accent-muted,rgba(88,166,255,0.15))';
      const nameSpan = el('span', 'font-family:monospace;color:var(--text-primary);', name);
      const typeSpan = el('span', 'color:var(--text-muted,#9aa4b2);font-size:10px;', entry.type);
      const dataSpan = el('span', 'font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-primary);', preview(entry.data));
      const modSpan = el('span', 'color:var(--text-muted,#9aa4b2);font-size:10px;', entry.lastModified ? new Date(entry.lastModified).toLocaleTimeString() : '');
      row.append(nameSpan, typeSpan, dataSpan, modSpan);
      row.title = 'Double-click to edit · ' + selectedPath + '/' + name;
      row.addEventListener('click', () => { selectedValue = name; renderTree(); refreshValues(); setStatus('Selected ' + name); }, { signal: ac.signal });
      row.addEventListener('dblclick', () => openValueEditor(name, entry), { signal: ac.signal });
      return row;
    }

    function preview(data) {
      let text;
      try { text = typeof data === 'string' ? data : JSON.stringify(data); } catch (_) { text = String(data); }
      return text.length > 200 ? text.slice(0, 200) + '…' : text;
    }

    function refreshValues() {
      const listing = treeCache[selectedPath];
      valueHeader.textContent = selectedPath + '  (' + (listing ? Object.keys(listing.values).length : 0) + ' values)';
      valueTable.textContent = '';
      if (!listing) return;
      const names = Object.keys(listing.values).sort();
      if (!names.length) {
        valueTable.appendChild(el('div', 'color:var(--text-muted,#9aa4b2);padding:8px 0;', '(no values in this key)'));
        return;
      }
      for (const name of names) valueTable.appendChild(makeValueRow(name, listing.values[name]));
    }

    // ── data refresh ───────────────────────────────────────────────────
    async function refresh() {
      // Ensure every expanded path (and the selection) has a cached listing.
      const wanted = new Set([selectedPath]);
      for (const path of Object.keys(expanded)) if (expanded[path]) wanted.add(path);
      for (const hive of HIVES) wanted.add(hive);
      for (const path of wanted) {
        try {
          treeCache[path] = Reg.list(path);
        } catch (err) {
          delete treeCache[path];
          statusMessage = 'list failed: ' + errorMessage(err);
        }
      }
      renderTree();
      refreshValues();
      setStatus(statusMessage);
    }

    // ── toolbar actions ────────────────────────────────────────────────
    function jump() {
      const raw = jumpInput.value.trim();
      if (!raw) return;
      try {
        const listing = Reg.list(raw);
        const normalized = listing ? listing.path : null;
        if (!normalized) { setStatus('No such key: ' + raw); return; }
        // Expand every ancestor so the tree shows the jump target.
        const parts = normalized.split('/');
        for (let i = 1; i <= parts.length; i++) expanded[parts.slice(0, i).join('/')] = true;
        selectedPath = normalized;
        selectedValue = null;
        refresh().then(() => setStatus('Jumped to ' + normalized));
      } catch (err) { setStatus(errorMessage(err)); }
    }
    jumpBtn.addEventListener('click', jump, { signal: ac.signal });
    jumpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') jump(); }, { signal: ac.signal });
    filterInput.addEventListener('input', () => {
      filterText = filterInput.value.trim().toLowerCase();
      for (const hive of HIVES) expanded[hive] = true;
      renderTree();
    }, { signal: ac.signal });

    newKeyBtn.addEventListener('click', () => {
      openPromptDialog('New key under ' + selectedPath, 'Key name', (name) => {
        try {
          Reg.import(selectedPath, { keys: { [name]: { keys: {}, values: {} } }, values: {} }, {});
          expanded[selectedPath] = true;
          expanded[selectedPath + '/' + name] = true;
          refresh().then(() => setStatus('Created key ' + selectedPath + '/' + name));
        } catch (err) { setStatus(errorMessage(err)); }
      });
    }, { signal: ac.signal });

    newValueBtn.addEventListener('click', () => openValueEditor(null, null), { signal: ac.signal });

    deleteBtn.addEventListener('click', () => {
      if (selectedValue) {
        const valuePath = selectedPath + '/' + selectedValue;
        if (!window.confirm('Delete value "' + selectedValue + '"?')) return;
        try {
          Reg.remove(valuePath, { recursive: false });
          selectedValue = null;
          refresh().then(() => setStatus('Deleted ' + valuePath));
        } catch (err) { setStatus(errorMessage(err)); }
        return;
      }
      if (HIVES.includes(selectedPath)) { setStatus('Cannot delete a hive root.'); return; }
      if (!window.confirm('Delete key "' + selectedPath + '" and EVERYTHING under it?')) return;
      try {
        Reg.remove(selectedPath, { recursive: true });
        const parent = keyOf(selectedPath);
        selectedPath = parent || selectedPath.split('/')[0];
        selectedValue = null;
        refresh().then(() => setStatus('Deleted key ' + selectedPath));
      } catch (err) { setStatus(errorMessage(err)); }
    }, { signal: ac.signal });

    exportBtn.addEventListener('click', () => {
      try {
        const data = Reg.export(selectedPath);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = el('a', { href: url, download: 'nova-registry-' + selectedPath.replace(/\//g, '-') + '.json' });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        setStatus('Exported ' + selectedPath);
      } catch (err) { setStatus(errorMessage(err)); }
    }, { signal: ac.signal });

    importBtn.addEventListener('click', () => importFile.click(), { signal: ac.signal });
    importFile.addEventListener('change', () => {
      const file = importFile.files && importFile.files[0];
      importFile.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(String(reader.result));
          const result = Reg.import(selectedPath, data, {});
          expanded[selectedPath] = true;
          refresh().then(() => setStatus('Imported ' + result.merged + ' value(s) into ' + selectedPath));
        } catch (err) { setStatus('Import failed: ' + errorMessage(err)); }
      };
      reader.readAsText(file);
    }, { signal: ac.signal });

    // Live refresh — one debounced listener on the registry change event.
    let refreshTimer = null;
    OS.events.on('nova:reg:changed', () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { refresh(); }, 120);
    });

    // ── dialogs (value editor + prompt) ────────────────────────────────
    function overlay() {
      const back = el('div', 'position:absolute;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:10;');
      content.style.position = 'relative';
      return back;
    }

    function dialogShell(titleText) {
      const back = overlay();
      const box = el('div', 'background:var(--bg-elevated,#161b22);border:1px solid var(--border-subtle,#2a2f3a);border-radius:8px;padding:14px;min-width:340px;max-width:520px;box-shadow:0 12px 32px rgba(0,0,0,0.5);');
      box.appendChild(el('div', 'font-weight:600;margin-bottom:10px;color:var(--text-primary);', titleText));
      back.appendChild(box);
      return { back, box };
    }

    function fieldStyle() { return 'width:100%;padding:6px 8px;background:var(--bg-default,#0f1115);border:1px solid var(--border-subtle,#2a2f3a);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:11px;box-sizing:border-box;'; }

    function closeButtonRow(box, onCancel) {
      const row = el('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;');
      const cancel = el('button', btnStyle(false), 'Cancel');
      const save = el('button', btnStyle(true), 'Save');
      cancel.addEventListener('click', () => { backClose(box); onCancel && onCancel(); }, { signal: ac.signal });
      row.append(cancel, save);
      return { row, save };
    }
    function backClose(box) { if (box && box.parentNode) box.parentNode.remove(); }

    function openPromptDialog(titleText, labelText, onSubmit) {
      const { back, box } = dialogShell(titleText);
      const label = el('div', 'margin-bottom:6px;color:var(--text-muted,#9aa4b2);', labelText);
      const input = el('input', fieldStyle());
      input.placeholder = 'lowercase-name (letters, digits, dash, dot)';
      box.append(label, input);
      const { row, save } = closeButtonRow(box);
      box.appendChild(row);
      const submit = () => {
        const name = input.value.trim();
        if (!name || /[\/\\]/.test(name) || name === '.' || name === '..') { input.style.borderColor = '#f85149'; return; }
        backClose(box);
        onSubmit(name);
      };
      save.addEventListener('click', submit, { signal: ac.signal });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }, { signal: ac.signal });
      content.appendChild(back);
      input.focus();
    }

    function coerceForType(type, rawText) {
      switch (type) {
        case 'REG_SZ': return rawText;
        case 'REG_BOOL': return rawText === 'true';
        case 'REG_DWORD': case 'REG_QWORD': return Number(rawText);
        case 'REG_JSON': return JSON.parse(rawText);
        case 'REG_BINARY': return rawText;
        default: return rawText;
      }
    }

    function openValueEditor(name, entry) {
      const isNew = !name;
      const title = isNew ? 'New value in ' + selectedPath : 'Edit ' + selectedPath + '/' + name;
      const { back, box } = dialogShell(title);

      const nameLabel = el('div', 'margin:6px 0 4px;color:var(--text-muted,#9aa4b2);', 'Name');
      const nameInput = el('input', fieldStyle());
      nameInput.value = name || '';
      nameInput.disabled = !isNew;

      const typeLabel = el('div', 'margin:10px 0 4px;color:var(--text-muted,#9aa4b2);', 'Type');
      const typeSelect = el('select', fieldStyle());
      for (const t of TYPES) {
        const opt = document.createElement('option');
        opt.value = t; opt.textContent = t;
        typeSelect.appendChild(opt);
      }
      const dataLabel = el('div', 'margin:10px 0 4px;color:var(--text-muted,#9aa4b2);', 'Data');
      const dataInput = el('textarea', fieldStyle() + 'min-height:90px;resize:vertical;');
      const boolWrap = el('div');
      const boolSelect = el('select', fieldStyle());
      for (const b of ['false', 'true']) {
        const opt = document.createElement('option');
        opt.value = b; opt.textContent = b;
        boolSelect.appendChild(opt);
      }
      boolWrap.appendChild(boolSelect);

      function syncEditorForType(type) {
        dataInput.style.display = type === 'REG_BOOL' ? 'none' : 'block';
        boolWrap.style.display = type === 'REG_BOOL' ? 'block' : 'none';
        dataLabel.textContent = type === 'REG_JSON' ? 'Data (JSON)' : type === 'REG_BINARY' ? 'Data (base64)' : 'Data';
      }
      typeSelect.addEventListener('change', () => syncEditorForType(typeSelect.value), { signal: ac.signal });

      if (entry) {
        typeSelect.value = entry.type;
        if (entry.type === 'REG_BOOL') boolSelect.value = entry.data ? 'true' : 'false';
        else if (entry.type === 'REG_JSON') dataInput.value = JSON.stringify(entry.data, null, 2);
        else dataInput.value = String(entry.data);
      } else {
        typeSelect.value = 'REG_SZ';
      }
      syncEditorForType(typeSelect.value);

      const errorLine = el('div', 'margin-top:8px;color:#f85149;font-size:11px;min-height:14px;');
      box.append(nameLabel, nameInput, typeLabel, typeSelect, dataLabel, dataInput, boolWrap, errorLine);

      const { row, save } = closeButtonRow(box);
      box.appendChild(row);
      save.addEventListener('click', () => {
        const valueName = (nameInput.value || '').trim();
        if (!valueName || /[\/\\]/.test(valueName) || valueName === '.' || valueName === '..') {
          errorLine.textContent = 'Invalid value name.'; return;
        }
        let value;
        try {
          value = typeSelect.value === 'REG_BOOL' ? (boolSelect.value === 'true') : coerceForType(typeSelect.value, dataInput.value);
        } catch (err) {
          errorLine.textContent = 'Invalid data for ' + typeSelect.value + ': ' + errorMessage(err); return;
        }
        try {
          Reg.set(selectedPath + '/' + valueName, value, { type: typeSelect.value });
          // Live-apply mapped shell keys exactly like the sandbox handler
          // does for nova:reg:set — the settings:changed fan-out repaints
          // wallpaper/theme/accent immediately.
          const settingsKey = Reg.SETTINGS_PATH_TO_KEY && Reg.SETTINGS_PATH_TO_KEY[selectedPath + '/' + valueName];
          if (settingsKey && typeof OS.settings?.set === 'function') {
            try { OS.settings.set(settingsKey, value); } catch (_) { /* non-fatal */ }
          }
          backClose(box);
          selectedValue = valueName;
          refresh().then(() => setStatus('Saved ' + selectedPath + '/' + valueName));
        } catch (err) {
          errorLine.textContent = errorMessage(err);
        }
      }, { signal: ac.signal });

      content.appendChild(back);
      if (isNew) nameInput.focus(); else dataInput.focus();
    }

    // ── go ─────────────────────────────────────────────────────────────
    refresh();
  },
});
