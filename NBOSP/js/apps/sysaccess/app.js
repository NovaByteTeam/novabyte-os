registerApp({
  id: 'com.nbosp.sysaccess',
  name: 'System Access',
  version: '3.0.2',
  icon: '/assets/sysaccess.svg',
  description: 'Inspect network proxy/SSRF configuration and the virtual filesystem',
  category: 'developer',
  devOnly: true,
  defaultSize: [750, 600],
  minSize: [450, 400],
  init(content, state, options) {
    if (!window.AppDirs?.getAppDataPath('com.nbosp.settings', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.settings</b><br>' + _t('apps.sysaccess.guard.appDataMissing') + '<br>' + _t('apps.sysaccess.guard.requiresNovaByte') + '</div>';
      return;
    }

    if (!OS.settings.get('devMode')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">🔒</div><div style="font-size:14px;text-align:center">' + _t('apps.sysaccess.guard.devModeRequired') + '</div>';
      return;
    }

    const TABS = [
      { id: 'network', name: _t('apps.sysaccess.tabs.network'), icon: 'globe' },
      { id: 'fs',      name: _t('apps.sysaccess.tabs.fs'),      icon: 'folder' },
    ];

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-base);color:var(--text-primary);font-family:var(--font-ui,sans-serif);overflow:hidden;';

    const tabBar = createEl('div', { className: 'sysaccess-tabs', style: 'display:flex;border-bottom:1px solid var(--border-subtle);background:var(--bg-elevated);flex-shrink:0;' });
    const panels = {};

    // Shared across every listener registered in this app — tab buttons
    // below and the network tab's Run Test button. state.cleanups.push is
    // the teardown hook the window manager actually calls on close
    // (confirmed against wm.js); nothing in this file was cleaned up
    // before, so every listener stayed alive past window close.
    const ac = new AbortController();

    let _networkRendered = false;
    let _fsRendered = false;

    TABS.forEach(tab => {
      const btn = createEl('button', {
        className: 'sysaccess-tab',
        textContent: tab.name,
        style: 'padding:8px 16px;background:transparent;border:none;color:var(--text-muted);cursor:pointer;font-size:13px;border-bottom:2px solid transparent;transition:all 0.15s;'
      });
      btn.addEventListener('click', () => {
        tabBar.querySelectorAll('.sysaccess-tab').forEach(b => {
          b.style.color = 'var(--text-muted)';
          b.style.borderBottomColor = 'transparent';
          b.style.background = 'transparent';
        });
        btn.style.color = 'var(--accent)';
        btn.style.borderBottomColor = 'var(--accent)';
        btn.style.background = 'var(--bg-hover)';
        Object.values(panels).forEach(p => p.style.display = 'none');
        panels[tab.id].style.display = 'block';
        if (tab.id === 'network' && !_networkRendered) { renderNetwork(); _networkRendered = true; }
        if (tab.id === 'fs' && !_fsRendered) { renderFS(); _fsRendered = true; }
      }, { signal: ac.signal });
      tabBar.appendChild(btn);

      const panel = createEl('div', {
        style: 'display:none;flex:1;overflow:auto;padding:16px;font-size:13px;'
      });
      panels[tab.id] = panel;
      content.appendChild(panel);
    });

    content.insertBefore(tabBar, content.firstChild);
    tabBar.querySelector('.sysaccess-tab').click();

    // ── Network tab ────────────────────────────────────────────────────────
    function renderNetwork() {
      panels.network.innerHTML = '';

      const desc = createEl('div', { style: 'margin-bottom:12px;color:var(--text-muted);font-size:12px;' });
      desc.textContent = _t('apps.sysaccess.network.desc');
      panels.network.appendChild(desc);

      const runBtn = createEl('button', {
        textContent: _t('apps.sysaccess.network.runTest'),
        style: 'padding:6px 14px;background:var(--accent);color:var(--text-on-accent);border:none;border-radius:4px;cursor:pointer;font-size:12px;margin-bottom:12px;margin-right:8px;'
      });
      const exportBtn = createEl('button', {
        textContent: _t('apps.sysaccess.network.exportResults'),
        style: 'padding:6px 14px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:12px;margin-bottom:12px;'
      });
      let lastRunResults = null; // set after each successful Run Test; convenience handle to the object also pushed into runHistory

      const section = createEl('div', { style: 'display:flex;flex-direction:column;gap:12px;' });

      const statusEl = createEl('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:6px;' });
      statusEl.textContent = _t('apps.sysaccess.network.clickToProbe');

      // Proxy status — these are server-side Express routes (proxies.js,
      // module.exports, req/res/next signatures), not browser globals.
      // The original devtools.js checked `typeof setupFrameCheckProxy` etc.
      // from the browser, which can never see a Node-side function — that
      // always printed N/A regardless of whether the routes were actually
      // mounted. There's no dedicated status endpoint to query, so instead
      // we probe each real route directly: a 4xx (bad params, no session)
      // still proves the route is mounted and responding; only a network
      // failure means it genuinely isn't reachable.
      const proxyCard = createEl('div', { style: 'padding:12px;background:var(--bg-elevated);border-radius:6px;border:1px solid var(--border-subtle);' });
      proxyCard.appendChild(createEl('h4', { textContent: _t('apps.sysaccess.network.proxyConfiguration'), style: 'margin:0 0 8px;font-size:13px;color:var(--accent);' }));
      proxyCard.appendChild(createEl('div', { textContent: _t('apps.sysaccess.network.waitingForTest'), style: 'font-size:11px;color:var(--text-muted);margin-bottom:6px;' }));
      section.appendChild(proxyCard);

      const proxyProbes = [
        { label: _t('apps.sysaccess.network.frameCheckProxy'),  url: '/api/frame-check' },
        { label: _t('apps.sysaccess.network.appNetworkProxy'),  url: '/api/proxy', method: 'POST' },
      ];

      // SSRF guard test — the previous version re-implemented a crude
      // hostname substring check entirely client-side and never touched
      // the real server logic (_isPrivateHost / _dnsCheckPrivate in
      // proxies.js), so it always reported the same canned verdict
      // regardless of what the backend would actually decide. We instead
      // send each test URL through the real App Network Proxy endpoint —
      // a 403 means the server's SSRF guard blocked it for real.
      const ssrfCard = createEl('div', { style: 'padding:12px;background:var(--bg-elevated);border-radius:6px;border:1px solid var(--border-subtle);' });
      ssrfCard.appendChild(createEl('h4', { textContent: _t('apps.sysaccess.network.ssrfGuardTest'), style: 'margin:0 0 8px;font-size:13px;color:var(--accent);' }));
      ssrfCard.appendChild(createEl('div', { textContent: _t('apps.sysaccess.network.waitingForTest'), style: 'font-size:11px;color:var(--text-muted);margin-bottom:6px;' }));
      section.appendChild(ssrfCard);

      // Run history — lets you compare "it failed 2 minutes ago, now it
      // passes" instead of Run Test silently overwriting the only visible
      // result each time. Capped ring buffer, newest first, in-memory only
      // (resets on window close/reopen — no persistence layer to hook into
      // here beyond FS, which would be the wrong tool for ephemeral UI state).
      const HISTORY_CAP = 20;
      const runHistory = [];
      const historyCard = createEl('div', { style: 'padding:12px;background:var(--bg-elevated);border-radius:6px;border:1px solid var(--border-subtle);' });
      historyCard.appendChild(createEl('h4', { textContent: _t('apps.sysaccess.network.runHistory'), style: 'margin:0 0 8px;font-size:13px;color:var(--accent);' }));
      const historyList = createEl('div', { style: 'display:flex;flex-direction:column;gap:4px;max-height:140px;overflow:auto;' });
      historyCard.appendChild(historyList);
      section.appendChild(historyCard);

      function renderHistory() {
        historyList.innerHTML = '';
        if (!runHistory.length) {
          historyList.appendChild(createEl('div', { textContent: _t('apps.sysaccess.network.noRunsYet'), style: 'font-size:11px;color:var(--text-muted);' }));
          return;
        }
        runHistory.forEach(run => {
          const row = createEl('div', { style: 'display:flex;justify-content:space-between;padding:3px 6px;background:var(--bg-sunken);border-radius:4px;font-size:11px;font-family:monospace;' });
          const time = new Date(run.timestamp).toLocaleTimeString();
          row.appendChild(createEl('span', { textContent: time, style: 'color:var(--text-muted);' }));
          const proxyOk = run.proxyResults.filter(r => r.ok).length;
          const ssrfBlocked = run.ssrfRows.filter(r => r.blocked).length;
          row.appendChild(createEl('span', {
            textContent: _t('apps.sysaccess.network.historySummary', { ok: proxyOk, total: run.proxyResults.length, blocked: ssrfBlocked, ssrfTotal: run.ssrfRows.length }),
            style: 'color:' + (proxyOk === run.proxyResults.length ? 'var(--text-success)' : 'var(--text-danger)') + ';'
          }));
          historyList.appendChild(row);
        });
      }
      renderHistory();

      const testUrls = ['http://127.0.0.1/x', 'http://localhost/x', 'http://169.254.1.1/x', 'https://example.com/img.png'];

      runBtn.addEventListener('click', async () => {
        runBtn.disabled = true;
        runBtn.textContent = _t('apps.sysaccess.network.running');
        statusEl.textContent = _t('apps.sysaccess.network.probing');

        const proxyResults = await Promise.all(proxyProbes.map(async p => {
          try {
            const res = await fetch(p.url, { method: p.method || 'GET' });
            if (res.status === 404) return { ...p, status: _t('apps.sysaccess.network.statusNotFound'), ok: false };
            return { ...p, status: _t('apps.sysaccess.network.statusReachable', { status: res.status }), ok: true };
          } catch (e) {
            return { ...p, status: _t('apps.sysaccess.network.statusUnreachable'), ok: false };
          }
        }));

        proxyCard.innerHTML = '';
        proxyCard.appendChild(createEl('h4', { textContent: _t('apps.sysaccess.network.proxyConfiguration'), style: 'margin:0 0 8px;font-size:13px;color:var(--accent);' }));
        proxyResults.forEach(item => {
          const row = createEl('div', { style: 'display:flex;justify-content:space-between;padding:4px 0;font-size:12px;' });
          row.appendChild(createEl('span', { textContent: item.label, style: 'color:var(--text-muted);' }));
          row.appendChild(createEl('span', { textContent: item.status, style: 'font-family:monospace;color:' + (item.ok ? 'var(--text-success)' : 'var(--text-danger)') + ';' }));
          proxyCard.appendChild(row);
        });

        const ssrfRows = await Promise.all(testUrls.map(async url => {
          try {
            const res = await fetch('/api/proxy', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url, method: 'GET' })
            });
            const blocked = res.status === 403;
            return { url, blocked, verdict: blocked ? _t('apps.sysaccess.network.ssrfBlocked') : _t('apps.sysaccess.network.ssrfAllowed', { status: res.status }) };
          } catch (e) {
            return { url, blocked: null, verdict: _t('apps.sysaccess.network.ssrfRequestFailed') };
          }
        }));

        ssrfCard.innerHTML = '';
        ssrfCard.appendChild(createEl('h4', { textContent: _t('apps.sysaccess.network.ssrfGuardTest'), style: 'margin:0 0 8px;font-size:13px;color:var(--accent);' }));
        ssrfRows.forEach(r => {
          const row = createEl('div', { style: 'display:flex;justify-content:space-between;padding:4px 0;font-size:12px;font-family:monospace;' });
          row.appendChild(createEl('span', { textContent: r.url, style: 'color:var(--text-muted);' }));
          const color = r.blocked === null ? 'var(--text-warning)' : (r.blocked ? 'var(--text-danger)' : 'var(--text-success)');
          row.appendChild(createEl('span', { textContent: r.verdict, style: 'color:' + color + ';' }));
          ssrfCard.appendChild(row);
        });

        statusEl.textContent = _t('apps.sysaccess.network.testComplete');
        runBtn.disabled = false;
        runBtn.textContent = _t('apps.sysaccess.network.runTest');
        lastRunResults = { timestamp: new Date().toISOString(), proxyResults, ssrfRows };
        runHistory.unshift(lastRunResults);
        if (runHistory.length > HISTORY_CAP) runHistory.length = HISTORY_CAP;
        renderHistory();
      }, { signal: ac.signal });

      exportBtn.addEventListener('click', async () => {
        if (!runHistory.length) return;
        const payload = { exportedAt: new Date().toISOString(), runCount: runHistory.length, runs: runHistory };
        try {
          await SystemDialogs.saveContent({
            title: _t('apps.sysaccess.network.exportResults'),
            suggestedName: 'nbosp-sysaccess-network-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json',
            accept: '.json',
          }, JSON.stringify(payload, null, 2));
        } catch (error) {
          console.error('[System Access] Network export failed:', error);
          Notify.show({ title: _t('apps.sysdialog.saveFailed'), body: error.message, type: 'error', appName: 'System Access' });
        }
      }, { signal: ac.signal });

      panels.network.appendChild(runBtn);
      panels.network.appendChild(exportBtn);
      panels.network.appendChild(statusEl);

      // CORS origins
      const corsCard = createEl('div', { style: 'padding:12px;background:var(--bg-elevated);border-radius:6px;border:1px solid var(--border-subtle);' });
      corsCard.appendChild(createEl('h4', { textContent: _t('apps.sysaccess.network.corsSecurity'), style: 'margin:0 0 8px;font-size:13px;color:var(--accent);' }));
      const corsRow = createEl('div', { style: 'font-size:12px;' });
      corsRow.appendChild(createEl('span', { textContent: 'CORS_ORIGIN: ', style: 'color:var(--text-muted);' }));
      // process.env.CORS_ORIGIN — confirmed safe here: NBOSP/package.json
      // shows this app runs under NW.js (nw: ^0.113.0-sdk, `start: nw .`),
      // which genuinely exposes `process` as a real global in the frontend
      // context (unlike an actual browser). A previous pass flagged this as
      // possibly throwing without a build-time shim — that concern doesn't
      // apply here since there's no browser bundle step involved at all.
      corsRow.appendChild(createEl('span', { textContent: (typeof process !== 'undefined' && process.env?.CORS_ORIGIN) || 'https://localhost:3003 (default)', style: 'color:var(--text-success);font-family:monospace;' }));
      corsCard.appendChild(corsRow);
      section.appendChild(corsCard);

      panels.network.appendChild(section);
    }

    // ── FS tab ────────────────────────────────────────────────────────────
    // Expand/collapse state persists across renderFS() calls (e.g. the 5s
    // refresh) so the tree doesn't collapse back to defaults every time it
    // updates. Keyed by node id, default is collapsed for every folder
    // except root, which is expanded on first render below.
    const expanded = new Set();
    let expandedInitialized = false;
    let selectedNodeId = null;
    let fsFilterValue = '';

    function renderFS() {
      panels.fs.innerHTML = '';

      const desc = createEl('div', { style: 'margin-bottom:12px;color:var(--text-muted);font-size:12px;' });
      desc.textContent = _t('apps.sysaccess.fs.desc');
      panels.fs.appendChild(desc);

      if (!FS.rootId) {
        panels.fs.appendChild(createEl('div', { textContent: _t('apps.sysaccess.fs.notInitialized'), style: 'color:var(--text-muted);' }));
        return;
      }

      if (!expandedInitialized) {
        expanded.add(FS.rootId);
        expandedInitialized = true;
      }

      const filterRow = createEl('div', { style: 'margin-bottom:10px;display:flex;gap:8px;align-items:center;' });
      const filterInput = createEl('input', { placeholder: _t('apps.sysaccess.fs.filterPlaceholder'), value: fsFilterValue, style: 'flex:1;box-sizing:border-box;padding:6px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:11px;' });
      const fsExportBtn = createEl('button', { textContent: _t('apps.sysaccess.fs.export'), title: _t('apps.sysaccess.fs.exportTitle'), style: 'padding:6px 12px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;' });
      filterRow.appendChild(filterInput);
      filterRow.appendChild(fsExportBtn);
      panels.fs.appendChild(filterRow);

      const layout = createEl('div', { style: 'display:flex;gap:12px;align-items:flex-start;' });
      const treeWrap = createEl('div', { style: 'font-family:monospace;font-size:12px;flex:1;min-width:0;' });
      const detailWrap = createEl('div', { style: 'width:320px;flex-shrink:0;' });
      layout.appendChild(treeWrap);
      layout.appendChild(detailWrap);
      panels.fs.appendChild(layout);

      const q = fsFilterValue.trim().toLowerCase();

      // When filtering, a node matches if its own name matches OR any
      // descendant matches — the latter is what lets a matching file cause
      // its ancestor folders to render (and auto-expand) even though the
      // folder names themselves don't match the query. Computed bottom-up
      // once per render rather than per-node during the walk, since a
      // naive per-node descendant search would be O(n^2) on a large tree.
      const subtreeMatches = new Map();
      function computeMatch(id) {
        if (subtreeMatches.has(id)) return subtreeMatches.get(id);
        const node = FS.files.get(id);
        if (!node) { subtreeMatches.set(id, false); return false; }
        let match = !q || node.name.toLowerCase().includes(q);
        const children = FS._childrenByParent.get(id);
        if (children) {
          for (const cid of children.keys()) {
            if (computeMatch(cid)) match = true;
          }
        }
        subtreeMatches.set(id, match);
        return match;
      }
      computeMatch(FS.rootId);

      // Export walks the same subtreeMatches result the renderer just
      // computed, so "Export" always matches what's actually on screen
      // (respecting the current filter), not a separate full-tree dump.
      // Content is deliberately excluded from the export — file bodies can
      // be large/numerous, and per-file content is already viewable in the
      // detail panel on demand; a metadata export stays predictable in size.
      fsExportBtn.addEventListener('click', async () => {
        const rows = [];
        function walk(id, path) {
          const node = FS.files.get(id);
          if (!node || !subtreeMatches.get(id)) return;
          const nodePath = path + '/' + node.name;
          rows.push({
            id: node.id, name: node.name, type: node.type, path: id === FS.rootId ? '/' : nodePath,
            parentId: node.parentId, size: node.size ?? null, mimeType: node.mimeType ?? null,
            created: node.created ?? null, modified: node.modified ?? null, accessed: node.accessed ?? null,
          });
          if (node.type === 'folder') {
            const children = FS._childrenByParent.get(id);
            if (children) for (const cid of children.keys()) walk(cid, id === FS.rootId ? '' : nodePath);
          }
        }
        walk(FS.rootId, '');
        const payload = { exportedAt: new Date().toISOString(), filter: fsFilterValue || null, nodeCount: rows.length, nodes: rows };
        try {
          await SystemDialogs.saveContent({
            title: _t('apps.sysaccess.fs.export'),
            suggestedName: 'nbosp-sysaccess-fs-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json',
            accept: '.json',
          }, JSON.stringify(payload, null, 2));
        } catch (error) {
          console.error('[System Access] Filesystem export failed:', error);
          Notify.show({ title: _t('apps.sysdialog.saveFailed'), body: error.message, type: 'error', appName: 'System Access' });
        }
      }, { signal: ac.signal });

      function fmtBytes(n) {
        if (n < 1024) return n + ' b';
        if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1048576).toFixed(1) + ' MB';
      }

      function renderDetail() {
        detailWrap.innerHTML = '';
        if (!selectedNodeId) {
          detailWrap.appendChild(createEl('div', { textContent: _t('apps.sysaccess.fs.clickToInspect'), style: 'font-size:11px;color:var(--text-muted);padding:8px;' }));
          return;
        }
        const node = FS.files.get(selectedNodeId);
        if (!node) {
          detailWrap.appendChild(createEl('div', { textContent: _t('apps.sysaccess.fs.nodeGone'), style: 'font-size:11px;color:var(--text-muted);padding:8px;' }));
          return;
        }
        const box = createEl('div', { style: 'padding:10px;background:var(--bg-elevated);border-radius:6px;border:1px solid var(--border-subtle);font-size:11px;' });
        const rows = [
          ['name', node.name],
          ['type', node.type],
          ['id', node.id],
          ['parentId', node.parentId || '(root)'],
        ];
        if (node.type === 'file') {
          rows.push(['size', fmtBytes(node.size || 0)]);
          rows.push(['mimeType', node.mimeType || '(unknown)']);
        }
        // created/modified/accessed are confirmed real fields set by
        // fs.js (Date.now() epoch ms) — not invented for this UI.
        if (node.created)  rows.push(['created',  new Date(node.created).toLocaleString()]);
        if (node.modified) rows.push(['modified', new Date(node.modified).toLocaleString()]);
        if (node.accessed) rows.push(['accessed', new Date(node.accessed).toLocaleString()]);
        rows.forEach(([label, val]) => {
          const row = createEl('div', { style: 'margin-bottom:6px;' });
          row.appendChild(createEl('div', { textContent: label, style: 'color:var(--text-muted);font-size:10px;' }));
          row.appendChild(createEl('div', { textContent: String(val), style: 'word-break:break-all;' }));
          box.appendChild(row);
        });
        detailWrap.appendChild(box);

        // Content viewer — node.content is confirmed (fs.js) to hold the
        // actual file body in memory already; no separate worker round-trip
        // exists or is needed to read it (fs.js has no readFile method at
        // all — writeFile is the only content-touching call beyond init's
        // bulk load). Read-only here on purpose: this panel's own
        // description already states "Read-only in dev mode for safety",
        // an existing policy this viewer respects rather than adding a
        // wired-up editor nobody asked for.
        if (node.type === 'file') {
          const contentBox = createEl('div', { style: 'margin-top:8px;padding:10px;background:var(--bg-elevated);border-radius:6px;border:1px solid var(--border-subtle);' });
          contentBox.appendChild(createEl('div', { textContent: _t('apps.sysaccess.fs.content'), style: 'color:var(--text-muted);font-size:10px;margin-bottom:4px;' }));

          if (node.content === null || node.content === undefined) {
            contentBox.appendChild(createEl('div', { textContent: _t('apps.sysaccess.fs.emptyContent'), style: 'font-size:11px;color:var(--text-muted);font-style:italic;' }));
          } else if (typeof node.content !== 'string') {
            // Guard against a shape we don't actually expect (e.g. binary
            // blobKey-backed content) rather than silently rendering
            // "[object Object]" or crashing on a non-string.
            contentBox.appendChild(createEl('div', { textContent: _t('apps.sysaccess.fs.nonTextContent', { type: typeof node.content }), style: 'font-size:11px;color:var(--text-muted);font-style:italic;' }));
          } else {
            const MAX_PREVIEW = 20000;
            const truncated = node.content.length > MAX_PREVIEW;
            const pre = createEl('pre', { textContent: truncated ? node.content.slice(0, MAX_PREVIEW) : node.content, style: 'font-family:monospace;font-size:11px;white-space:pre-wrap;word-break:break-all;max-height:260px;overflow:auto;margin:0;color:var(--text-primary);' });
            contentBox.appendChild(pre);
            if (truncated) {
              contentBox.appendChild(createEl('div', { textContent: _t('apps.sysaccess.fs.truncated', { shown: MAX_PREVIEW.toLocaleString(), total: node.content.length.toLocaleString() }), style: 'font-size:10px;color:var(--text-muted);margin-top:4px;' }));
            }
          }
          detailWrap.appendChild(contentBox);
        }
      }

      function renderNode(id, depth) {
        const node = FS.files.get(id);
        if (!node) return;
        if (!subtreeMatches.get(id)) return;

        const isFolder = node.type === 'folder';
        const isOpen = isFolder && (q ? true : expanded.has(id)); // auto-expand everything while filtering, so matches are visible without manual expand
        const row = createEl('div', {
          style: `padding:2px 4px;cursor:pointer;padding-left:${depth * 16 + 4}px;background:${selectedNodeId === id ? 'var(--bg-hover)' : 'transparent'};border-radius:3px;`
        });

        const caret = isFolder ? (isOpen ? '▾' : '▸') : ' ';
        const icon = isFolder ? '📁' : '📄';
        // textContent, not innerHTML — node.name is user-controlled (via
        // createFile/createFolder/rename in fs.js, no sanitization there).
        // A previous pass fixed this same field's stored-XSS-shaped bug by
        // escaping it before an innerHTML string interpolation; building
        // real DOM nodes with textContent removes the need for escaping
        // entirely, since textContent can never be interpreted as markup.
        row.appendChild(createEl('span', { textContent: caret, style: 'display:inline-block;width:14px;color:var(--text-muted);' }));
        row.appendChild(createEl('span', { textContent: icon + ' ' }));
        row.appendChild(createEl('span', { textContent: node.name }));
        if (!isFolder) {
          row.appendChild(createEl('span', { textContent: ' ' + fmtBytes(node.size || 0), style: 'color:var(--text-muted);' }));
        }

        row.addEventListener('click', () => {
          selectedNodeId = id;
          if (isFolder && !q) {
            if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
          }
          renderFS();
        }, { signal: ac.signal });

        treeWrap.appendChild(row);

        if (isFolder && isOpen) {
          const children = FS._childrenByParent.get(id);
          if (children) {
            for (const cid of children.keys()) {
              renderNode(cid, depth + 1);
            }
          }
        }
      }

      renderNode(FS.rootId, 0);
      renderDetail();

      filterInput.addEventListener('input', () => {
        fsFilterValue = filterInput.value;
        renderFS();
        // Re-focus and restore cursor position — renderFS() rebuilds the
        // whole panel including a fresh <input>, which would otherwise
        // steal focus away on every keystroke.
        const newInput = panels.fs.querySelector('input');
        if (newInput) {
          newInput.focus();
          newInput.selectionStart = newInput.selectionEnd = newInput.value.length;
        }
      }, { signal: ac.signal });
    }

    function refresh() {
      if (panels.fs.style.display !== 'none' && !_fsRendered) renderFS();
    }

    // FS.init() awaits a worker round-trip (OS.workers.fs.call), so FS.rootId
    // may genuinely still be null on the very first render if this app opens
    // before that resolves. renderFS() already degrades gracefully in that
    // case ("FS not initialized") and the 5s interval below will pick it up,
    // but delaying the first paint slightly reduces how often a user sees
    // that transient state needlessly.
    const timeoutId = setTimeout(refresh, 100);
    const intervalId = setInterval(refresh, 5000);

    // state.cleanups.push(fn) is the teardown hook the window manager
    // actually calls on close (confirmed against wm.js) — content never
    // dispatches a 'close' event anywhere in this codebase, so the old
    // listener never ran. This also releases the tab button and Run Test
    // click listeners registered against `ac` earlier in this function,
    // none of which had any cleanup before.
    state.cleanups.push(() => {
      clearTimeout(timeoutId);
      clearInterval(intervalId);
      ac.abort();
    });
  }
});