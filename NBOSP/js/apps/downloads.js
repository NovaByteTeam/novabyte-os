registerApp({
        id: 'nbosp-downloads', name: 'Downloads', icon: 'download',
        description: 'Download Manager',
        defaultSize: [580, 460], minSize: [400, 300],
        init(content, state) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.downloads', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.downloads</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const SK = 'nova_downloads';

          function load() { try { return JSON.parse(localStorage.getItem(SK) || '[]'); } catch { return []; } }
          function save(arr) { lsSave(SK, arr); }
          function fmtSize(b) { if (!b) return '—'; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }
          function fmtDate(ts) { if (!ts) return ''; return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }

          const root = createEl('div', { style: 'display:flex;flex-direction:column;height:100%;overflow:hidden;' });
          content.appendChild(root);

          /* ── Toolbar ── */
          const toolbar = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);' });
          const titleEl = createEl('span', { textContent: 'Downloads', style: 'font-size:13px;font-weight:600;flex:1;' });
          const clearBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Clear completed' });
          toolbar.append(titleEl, clearBtn);
          root.appendChild(toolbar);

          /* ── List ── */
          const list = createEl('div', { style: 'flex:1;overflow-y:auto;' });
          root.appendChild(list);

          function statusStyle(s) {
            if (s === 'downloading') return { bg: 'rgba(88,166,255,0.14)', color: 'var(--accent)' };
            if (s === 'failed') return { bg: 'rgba(248,81,73,0.14)', color: 'var(--text-danger)' };
            return { bg: 'rgba(63,185,80,0.14)', color: 'var(--text-success)' };
          }

          function render() {
            const items = load();
            list.innerHTML = '';

            if (!items.length) {
              const empty = createEl('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-muted);gap:8px;' });
              empty.innerHTML = svgIcon('archive', 34) + '<div style="font-size:13px;margin-top:10px;color:var(--text-secondary);">No downloads yet</div><div style="font-size:11px;margin-top:4px;">Files saved from the browser appear here</div>';
              list.appendChild(empty);
              return;
            }

            items.forEach((item, i) => {
              const row = createEl('div', { style: 'display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border-subtle);transition:background 0.1s;', title: item.url || '' });
              row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-hover)');
              row.addEventListener('mouseleave', () => row.style.background = '');

              const ico = createEl('span', { style: 'color:var(--accent);flex-shrink:0;' });
              ico.innerHTML = svgIcon('file', 18);

              const info = createEl('div', { style: 'flex:1;min-width:0;' });
              const nameEl = createEl('div', { textContent: item.name, style: 'font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' });
              const metaEl = createEl('div', { textContent: fmtSize(item.size) + (item.ts ? '  ·  ' + fmtDate(item.ts) : ''), style: 'font-size:11px;color:var(--text-muted);margin-top:2px;' });
              info.append(nameEl, metaEl);

              const st = statusStyle(item.status || 'done');
              const badge = createEl('span', { textContent: item.status || 'done', style: 'font-size:10px;padding:2px 8px;border-radius:20px;font-weight:600;flex-shrink:0;background:' + st.bg + ';color:' + st.color + ';' });

              const delBtn = createEl('button', { style: 'background:none;border:none;color:var(--text-muted);cursor:pointer;padding:4px;border-radius:4px;display:flex;align-items:center;', title: 'Remove' });
              delBtn.innerHTML = svgIcon('x', 14);
              delBtn.addEventListener('mouseenter', () => delBtn.style.color = 'var(--text-danger)');
              delBtn.addEventListener('mouseleave', () => delBtn.style.color = '');
              delBtn.addEventListener('click', () => {
                const arr = load();
                arr.splice(i, 1);
                save(arr);
                render();
              });

              row.append(ico, info, badge, delBtn);
              list.appendChild(row);
            });
          }

          clearBtn.addEventListener('click', () => {
            const arr = load().filter(it => it.status === 'downloading');
            save(arr);
            render();
          });

          /* ── Hook render into global Downloads API so UI updates live ── */
          window.Downloads._renderFn = render;

          render();
        }
      });




