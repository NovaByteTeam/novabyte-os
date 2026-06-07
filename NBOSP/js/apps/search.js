registerApp({
        id: 'nbosp-search', name: 'Search', icon: 'search',
        description: 'System Search',
        defaultSize: [640, 500], minSize: [420, 300],
        init(content, state) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.search', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.search</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const root = createEl('div', { style: 'display:flex;flex-direction:column;height:100%;overflow:hidden;' });
          content.appendChild(root);

          /* ── Search bar ── */
          const barWrap = createEl('div', { style: 'padding:12px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);' });
          const bar = createEl('div', { style: 'display:flex;align-items:center;gap:8px;background:var(--bg-sunken);border:1px solid var(--border-default);border-radius:8px;padding:7px 10px;transition:border-color 0.15s;' });
          const barIco = createEl('span', { style: 'color:var(--text-muted);flex-shrink:0;' });
          barIco.innerHTML = svgIcon('search', 16);
          const inp = createEl('input', { type: 'search', placeholder: 'Search files, contacts, downloads…', style: 'flex:1;background:none;border:none;outline:none;font-size:14px;color:var(--text-primary);', 'aria-label': 'Search' });
          const clearX = createEl('button', { style: 'background:none;border:none;color:var(--text-muted);cursor:pointer;display:none;padding:2px;', 'aria-label': 'Clear' });
          clearX.innerHTML = svgIcon('x', 14);
          bar.append(barIco, inp, clearX);
          barWrap.appendChild(bar);
          root.appendChild(barWrap);

          inp.addEventListener('focus', () => bar.style.borderColor = 'var(--accent)');
          inp.addEventListener('blur', () => bar.style.borderColor = 'var(--border-default)');

          /* ── Results area ── */
          const results = createEl('div', { style: 'flex:1;overflow-y:auto;padding:8px;' });
          root.appendChild(results);

          function section(title, items, renderFn) {
            if (!items.length) return null;
            const wrap = createEl('div', { style: 'margin-bottom:12px;' });
            const hdr = createEl('div', { textContent: title, style: 'font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em;padding:6px 8px 4px;' });
            wrap.appendChild(hdr);
            items.slice(0, 8).forEach(item => {
              const row = renderFn(item);
              if (row) wrap.appendChild(row);
            });
            return wrap;
          }

          function resultRow(icon, primary, secondary, onClick) {
            const row = createEl('div', { style: 'display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:6px;cursor:pointer;transition:background 0.1s;' });
            row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-hover)');
            row.addEventListener('mouseleave', () => row.style.background = '');
            row.addEventListener('click', onClick);
            const ico = createEl('span', { style: 'color:var(--accent);flex-shrink:0;' });
            ico.innerHTML = svgIcon(icon, 16);
            const text = createEl('div', { style: 'min-width:0;flex:1;' });
            const pri = createEl('div', { textContent: primary, style: 'font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' });
            const sec = createEl('div', { textContent: secondary, style: 'font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' });
            text.append(pri, sec);
            row.append(ico, text);
            return row;
          }

          function doSearch(q) {
            results.innerHTML = '';
            if (!q.trim()) {
              const hint = createEl('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:80%;color:var(--text-muted);gap:8px;' });
              hint.innerHTML = svgIcon('search', 36) + '<div style="font-size:13px;margin-top:10px;">Type to search</div>';
              results.appendChild(hint);
              return;
            }

            const lq = q.toLowerCase();
            let totalHits = 0;

            /* ── Files ── */
            const fileHits = Array.from(FS.files.values()).filter(f =>
              f.type === 'file' && (f.name || '').toLowerCase().includes(lq)
            ).slice(0, 12);

            const filesSec = section('Files', fileHits, f => {
              const icon = f.mimeType ? (f.mimeType.startsWith('image/') ? 'image' : f.mimeType.startsWith('audio/') ? 'music' : 'file') : 'file';
              const path = FS.getPath ? FS.getPath(f.id) : (f.name || '');
              return resultRow(icon, f.name, path, () => {
                if (f.mimeType && f.mimeType.startsWith('image/')) WM.createWindow('nbosp-gallery');
                else if (f.mimeType && f.mimeType.startsWith('audio/')) WM.createWindow('nbosp-music');
                else WM.createWindow('quill', { fileId: f.id });
              });
            });
            if (filesSec) { results.appendChild(filesSec); totalHits += fileHits.length; }

            /* ── Contacts ── */
            let contactData = [];
            try { contactData = JSON.parse(localStorage.getItem('nova_contacts') || '[]'); } catch { }
            const contactHits = contactData.filter(c =>
              (c.name || '').toLowerCase().includes(lq) ||
              (c.email || '').toLowerCase().includes(lq) ||
              (c.phone || '').toLowerCase().includes(lq)
            );
            const contactsSec = section('Contacts', contactHits, c =>
              resultRow('users', c.name || '(no name)', c.email || c.phone || '', () => WM.createWindow('nbosp-contacts'))
            );
            if (contactsSec) { results.appendChild(contactsSec); totalHits += contactHits.length; }

            /* ── Downloads ── */
            let dlData = [];
            try { dlData = JSON.parse(localStorage.getItem('nova_downloads') || '[]'); } catch { }
            const dlHits = dlData.filter(d => (d.name || '').toLowerCase().includes(lq));
            const dlSec = section('Downloads', dlHits, d =>
              resultRow('download', d.name, d.url || '', () => WM.createWindow('nbosp-downloads'))
            );
            if (dlSec) { results.appendChild(dlSec); totalHits += dlHits.length; }

            /* ── No results ── */
            if (!totalHits) {
              const none = createEl('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;color:var(--text-muted);gap:8px;text-align:center;' });
              none.innerHTML = svgIcon('search', 32) + '<div style="font-size:13px;margin-top:10px;color:var(--text-secondary);">No results for "' + escapeHtml(q) + '"</div>';
              results.appendChild(none);
            }
          }

          let debounce;
          inp.addEventListener('input', () => {
            clearX.style.display = inp.value ? '' : 'none';
            clearTimeout(debounce);
            debounce = setTimeout(() => doSearch(inp.value), 200);
          });
          clearX.addEventListener('click', () => { inp.value = ''; clearX.style.display = 'none'; doSearch(''); inp.focus(); });

          doSearch('');
          inp.focus();
        }
      });




