registerApp({
        id: 'vault', name: 'Files', icon: 'folder-open',
        description: 'File Manager',
        defaultSize: [780, 520], minSize: [480, 340],
        init(content, state, options) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.vault', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.vault</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          // ── Root layout ──────────────────────────────────────────────
          const root = createEl('div', { style: 'display:flex;flex-direction:column;height:100%;overflow:hidden;' });
          content.appendChild(root);

          // ── Toolbar (browser-style: back · up · path · search) ───────
          const toolbar = createEl('div', { className: 'browser-toolbar' });

          const backBtn = createEl('button', { className: 'browser-nav-btn', title: 'Back', 'aria-label': 'Back' });
          backBtn.innerHTML = svgIcon('chevron-left', 16);
          const upBtn = createEl('button', { className: 'browser-nav-btn', title: 'Up', 'aria-label': 'Parent folder' });
          upBtn.innerHTML = svgIcon('chevron-up', 16);

          const pathBarWrap = createEl('div', { className: 'browser-url-bar-wrap' });
          const pathBar = createEl('input', { className: 'browser-url-bar', id: 'file-browser-path-input', name: 'file-browser-path', 'aria-label': 'Current path', spellcheck: 'false', placeholder: '/' });
          const pathIcon = createEl('span', { className: 'browser-url-icon' });
          pathIcon.innerHTML = svgIcon('folder', 14);
          pathBarWrap.appendChild(pathBar);
          pathBarWrap.appendChild(pathIcon);

          const searchInput = createEl('input', { className: 'browser-url-bar', id: 'file-browser-search-input', name: 'file-browser-search', style: 'max-width:140px;', placeholder: 'Search…', 'aria-label': 'Search files' });

          toolbar.append(backBtn, upBtn, pathBarWrap, searchInput);
          root.appendChild(toolbar);

          // ── Files area ───────────────────────────────────────────────
          const filesWrap = createEl('div', { style: 'flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0;' });

          // Icon view
          const filesGrid = createEl('div', { className: 'vault-files', role: 'grid', 'aria-label': 'Files', style: 'display:grid;' });

          // List view
          const listView = createEl('div', { style: 'display:none;flex:1;overflow:auto;flex-direction:column;' });
          const listHeader = createEl('div', { style: 'display:grid;grid-template-columns:1fr 80px 120px 110px;background:var(--bg-sunken);border-bottom:1px solid var(--border-subtle);flex-shrink:0;position:sticky;top:0;z-index:1;' });
          
          const headers = ['Name', 'Size', 'Type', 'Modified'];
          const sortKeys = ['name', 'size', 'mime', 'modified'];
          headers.forEach((h, i) => {
            const th = createEl('button', { style: 'padding:6px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);background:none;border:none;cursor:pointer;', textContent: h });
            th.addEventListener('click', () => {
              const key = sortKeys[i];
              if (sortBy === key) sortAsc = !sortAsc; else { sortBy = key; sortAsc = true; }
              renderFiles();
            });
            listHeader.appendChild(th);
          });
          const listBody = createEl('div', { style: 'flex:1;overflow-y:auto;' });
          listView.appendChild(listHeader);
          listView.appendChild(listBody);

          filesWrap.appendChild(filesGrid);
          filesWrap.appendChild(listView);
          root.appendChild(filesWrap);

          // ── Status bar ───────────────────────────────────────────────
          const statusBar = createEl('div', { className: 'vault-statusbar', role: 'status' });
          root.appendChild(statusBar);

          // ── State ────────────────────────────────────────────────────
          let viewMode = 'icon';
          let sortBy = 'name', sortAsc = true;
          let selectedIds = new Set();
          let clipboardOp = null;
          let isRenaming = false;
          let currentFilesCache = [];

          // Single navigation state (no tabs)
          const _startFolder = options?.folderId || FS.rootId;
          const nav = {
            cwd: _startFolder,
            history: [_startFolder],
            historyIdx: 0
          };
          state._nav = nav; // expose to onDrop

          // ── Navigation ───────────────────────────────────────────────
          function navigateTo(folderId) {
            nav.cwd = folderId;
            if (nav.historyIdx < nav.history.length - 1) nav.history = nav.history.slice(0, nav.historyIdx + 1);
            nav.history.push(folderId);
            nav.historyIdx = nav.history.length - 1;
            selectedIds.clear();
            renderFiles();
          }

          function goBack() {
            if (nav.historyIdx <= 0) return;
            nav.historyIdx--; nav.cwd = nav.history[nav.historyIdx];
            selectedIds.clear(); renderFiles();
          }

          function goUp() {
            const node = FS.files.get(nav.cwd);
            if (node && node.parentId) navigateTo(node.parentId);
          }

          backBtn.addEventListener('click', goBack);
          upBtn.addEventListener('click', goUp);

          pathBar.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
              const node = FS.getByPath(pathBar.value.trim());
              if (node) navigateTo(node.id);
              else { pathBar.style.color = 'var(--text-danger)'; setTimeout(() => pathBar.style.color = '', 800); }
              filesGrid.focus();
            }
            if (e.key === 'Escape') { updatePathBar(); filesGrid.focus(); }
          });

          function updatePathBar() {
            if (document.activeElement !== pathBar) pathBar.value = FS.getPath(nav.cwd);
          }

          // ── Automatic Core Folders Rebuilder ────────────────────────
          async function ensureDefaultSystemFolders() {
            // Full comprehensive list of OS directories, fully capitalized
            const defaultFolders = ['data', 'Downloads', 'Documents', 'Pictures', 'Music', 'Videos', 'System'];
            const len = defaultFolders.length;
            const currentItems = FS.listDir(nav.cwd);
            
            for (let i = 0; i < len; i++) {
              const folderName = defaultFolders[i];
              // JIT-friendly presence check
              const exists = currentItems.some(item => item.name === folderName && item.type === 'folder');
              if (!exists) {
                await FS.createFolder(nav.cwd, folderName);
              }
            }
          }

          // ── Sort ─────────────────────────────────────────────────────
          function sortFiles(files) {
            return [...files].sort((a, b) => {
              if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
              let cmp = 0;
              if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
              else if (sortBy === 'size') cmp = (a.size || 0) - (b.size || 0);
              else if (sortBy === 'mime') cmp = (a.mimeType || '').localeCompare(b.mimeType || '');
              else if (sortBy === 'modified') cmp = (a.modified || 0) - (b.modified || 0);
              return sortAsc ? cmp : -cmp;
            });
          }

          // ── Inline rename ────────────────────────────────────────────
          async function inlineRename(fileNode, nameEl) {
            if (OS.settings.get('filesViewOnly')) { Notify.show({ title: 'Blocked', body: 'Renaming disabled by policy.', type: 'warning', appName: 'Files' }); return; }
            isRenaming = true;
            const old = fileNode.name;
            const input = createEl('input', { id: 'file-rename-input', name: 'file-rename', value: old, style: 'width:100%;background:var(--bg-base);border:1px solid var(--accent);border-radius:4px;padding:1px 4px;font-size:11px;color:var(--text-primary);outline:none;' });
            nameEl.innerHTML = '';
            nameEl.appendChild(input);
            input.focus(); input.select();
            const commit = async () => {
              const newName = input.value.trim();
              if (newName && newName !== old) { await FS.rename(fileNode.id, newName); renderDesktopIcons(); }
              isRenaming = false; renderFiles();
            };
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') { isRenaming = false; renderFiles(); } });
          }

          // ── Selection UI Sync ────────────────────────────────────────
          function updateSelectionVisuals() {
            if (viewMode === 'icon') {
              Array.from(filesGrid.children).forEach(item => {
                if (item._fileNode) {
                  item.classList.toggle('selected', selectedIds.has(item._fileNode.id));
                }
              });
            } else {
              Array.from(listBody.children).forEach(row => {
                if (row._fileNode) {
                  row.style.background = selectedIds.has(row._fileNode.id) ? 'var(--accent-muted)' : '';
                }
              });
            }
            
            const selCount = selectedIds.size;
            if (selCount > 0) {
              const totalSize = currentFilesCache.filter(f => selectedIds.has(f.id)).reduce((s, f) => s + (f.size || 0), 0);
              statusBar.textContent = `${selCount} of ${currentFilesCache.length} selected${totalSize > 0 ? ' — ' + formatBytes(totalSize) : ''}`;
            } else {
              statusBar.textContent = `${currentFilesCache.length} item${currentFilesCache.length !== 1 ? 's' : ''}`;
            }
          }

          function handleSelectionEvent(e, fileId) {
            if (e.shiftKey || e.ctrlKey || e.metaKey) {
              selectedIds.has(fileId) ? selectedIds.delete(fileId) : selectedIds.add(fileId);
            } else {
              if (!selectedIds.has(fileId)) {
                selectedIds.clear(); selectedIds.add(fileId);
              }
            }
            updateSelectionVisuals();
          }

          // ── Optimized Icon View Generator ────────────────────────────
          function renderFileList(files) {
            filesGrid.innerHTML = '';
            if (!files.length) {
              filesGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:40px;font-size:13px;">This folder is empty</div>';
              statusBar.textContent = 'Empty';
              return;
            }

            const fragment = document.createDocumentFragment();
            files.forEach(f => {
              const item = createEl('div', { className: 'vault-file' + (selectedIds.has(f.id) ? ' selected' : ''), role: 'gridcell', tabindex: '0' });
              item._fileNode = f;

              const iconDiv = createEl('div', { className: 'vault-file-icon', style: 'position:relative;' });
              iconDiv.innerHTML = svgIcon(f.type === 'folder' ? 'folder' : FS.getMimeIcon(f.mimeType, f.name), 36);
              if (f.tags?.[0]) {
                const colorMap = { red: 'text-danger', green: 'text-success', blue: 'accent', yellow: 'text-warning' };
                const dot = createEl('div', { style: `position:absolute;bottom:2px;right:2px;width:8px;height:8px;border-radius:50%;background:var(--${colorMap[f.tags[0]] || 'text-warning'});` });
                iconDiv.appendChild(dot);
              }

              const nameDiv = createEl('div', { className: 'vault-file-name', textContent: f.name });
              item.append(iconDiv, nameDiv);
              fragment.appendChild(item);
            });
            filesGrid.appendChild(fragment);
            updateSelectionVisuals();
          }

          // ── Optimized List View Generator ────────────────────────────
          function renderListView(files) {
            listBody.innerHTML = '';
            const fragment = document.createDocumentFragment();
            files.forEach(f => {
              const row = createEl('div', { style: 'display:grid;grid-template-columns:1fr 80px 120px 110px;align-items:center;border-bottom:1px solid var(--border-subtle);cursor:pointer;transition:background var(--t-fast);' });
              row._fileNode = f;
              
              const nameCell = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;min-width:0;' });
              const ic = createEl('span', { style: 'flex-shrink:0;color:var(--text-muted);' }); 
              ic.innerHTML = svgIcon(f.type === 'folder' ? 'folder' : FS.getMimeIcon(f.mimeType, f.name), 16);
              const nm = createEl('span', { style: 'font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', textContent: f.name });
              nameCell.append(ic, nm);
              
              const sizeCell = createEl('div', { style: 'padding:6px 12px;font-size:12px;color:var(--text-secondary);', textContent: f.type === 'folder' ? '—' : formatBytes(f.size || 0) });
              const typeCell = createEl('div', { style: 'padding:6px 12px;font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', textContent: f.type === 'folder' ? 'Folder' : (f.mimeType?.split('/')[1] || 'File').toUpperCase() });
              const dateCell = createEl('div', { style: 'padding:6px 12px;font-size:12px;color:var(--text-secondary);', textContent: new Date(f.modified || Date.now()).toLocaleDateString() });
              
              row.append(nameCell, sizeCell, typeCell, dateCell);
              fragment.appendChild(row);
            });
            listBody.appendChild(fragment);
            updateSelectionVisuals();
          }

          // ── Centralized Event Delegation for File Items ──────────────
          function attachDelegatedHandlers(parentElement) {
            parentElement.addEventListener('click', e => {
              const targetItem = e.target.closest('.vault-file, [style*="grid-template-columns"]');
              if (targetItem?._fileNode) handleSelectionEvent(e, targetItem._fileNode.id);
            });

            parentElement.addEventListener('dblclick', e => {
              const targetItem = e.target.closest('.vault-file, [style*="grid-template-columns"]');
              if (targetItem?._fileNode) {
                const f = targetItem._fileNode;
                if (f.type === 'folder') navigateTo(f.id); else openFileWithDefaultApp(f);
              }
            });

            parentElement.addEventListener('contextmenu', e => {
              const targetItem = e.target.closest('.vault-file, [style*="grid-template-columns"]');
              if (targetItem?._fileNode) {
                e.preventDefault(); e.stopPropagation();
                const f = targetItem._fileNode;
                selectedIds.add(f.id);
                updateSelectionVisuals();
                showFileContextMenu(e.clientX, e.clientY, f, currentFilesCache);
              }
            });
          }

          attachDelegatedHandlers(filesGrid);
          attachDelegatedHandlers(listBody);

          listBody.addEventListener('mouseenter', e => {
            const row = e.target.closest('[style*="grid-template-columns"]');
            if (row?._fileNode && !selectedIds.has(row._fileNode.id)) row.style.background = 'rgba(255,255,255,0.04)';
          }, { capture: true });

          listBody.addEventListener('mouseleave', e => {
            const row = e.target.closest('[style*="grid-template-columns"]');
            if (row?._fileNode && !selectedIds.has(row._fileNode.id)) row.style.background = '';
          }, { capture: true });

          // ── Main render ──────────────────────────────────────────────
          function renderFiles(searchQuery) {
            updatePathBar();
            let files = FS.listDir(nav.cwd);
            if (searchQuery) {
              const q = searchQuery.toLowerCase();
              files = files.filter(f => f.name.toLowerCase().includes(q));
            }
            currentFilesCache = sortFiles(files);
            
            filesGrid.style.display = viewMode === 'icon' ? 'grid' : 'none';
            listView.style.display = viewMode === 'list' ? 'flex' : 'none';
            
            if (viewMode === 'icon') renderFileList(currentFilesCache);
            else renderListView(currentFilesCache);
          }

          // ── Context menu ─────────────────────────────────────────────
          function showFileContextMenu(x, y, f, files) {
            const inTrash = nav.cwd === FS.specialFolders.trash;
            const isHtml = f.type !== 'folder' && (f.name.endsWith('.html') || f.name.endsWith('.htm') || f.mimeType === 'text/html');
            ContextMenu.show(x, y, [
              { label: 'Open', icon: 'eye', action: () => { if (f.type === 'folder') navigateTo(f.id); else openFileWithDefaultApp(f); } },
              ...(isHtml ? [{ label: 'Edit in Text Editor', icon: 'edit', action: () => WM.createWindow('quill', { fileId: f.id }) }] : []),
              { separator: true },
              {
                label: 'Rename', icon: 'file-text', shortcut: 'F2', action: async () => {
                  if (OS.settings.get('filesViewOnly')) { Notify.show({ title: 'Blocked', body: 'Renaming disabled.', type: 'warning', appName: 'Files' }); return; }
                  const nameEl = filesGrid.querySelector('.vault-file.selected .vault-file-name');
                  if (nameEl?.tagName) inlineRename(f, nameEl);
                  else { const name = await showPrompt('Rename', f.name); if (name && name !== f.name) { await FS.rename(f.id, name); renderFiles(); renderDesktopIcons(); } }
                }
              },
              { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', action: () => { if (OS.settings.get('disableClipboardCopy')) { Notify.show({ title: 'Blocked', body: 'Copy disabled.', type: 'warning', appName: 'Files' }); return; } clipboardOp = { type: 'copy', fileId: f.id }; OS.clipboard = clipboardOp; Notify.show({ title: 'Copied', body: f.name + ' copied', type: 'info', appName: 'Files' }); } },
              { label: 'Move', icon: 'move', shortcut: 'Ctrl+X', action: () => { clipboardOp = { type: 'cut', fileId: f.id }; OS.clipboard = clipboardOp; Notify.show({ title: 'Cut', body: f.name + ' ready to move', type: 'info', appName: 'Files' }); } },
              { separator: true },
              ...(inTrash ? [
                { label: 'Restore', icon: 'refresh', action: async () => { f.parentId = FS.specialFolders.desktop; FS.files.set(f.id, f); await OS.workers.fs.call('putFiles', [f]); renderFiles(); renderDesktopIcons(); Notify.show({ title: 'Restored', body: f.name + ' restored', type: 'success', appName: 'Files' }); } },
                { label: 'Delete Permanently', icon: 'trash', danger: true, action: async () => { const ok = await showModal('Delete Permanently', 'This cannot be undone.', [{ label: 'Cancel' }, { label: 'Delete', style: 'danger' }]); if (ok !== 'Delete') return; await FS.permanentDelete(f.id); renderFiles(); renderDesktopIcons(); } }] : [
                {
                  label: 'Move to Trash', icon: 'trash', danger: true, shortcut: 'Del', action: async () => {
                    if (OS.settings.get('filesViewOnly')) { Notify.show({ title: 'Blocked', body: 'Delete disabled.', type: 'warning', appName: 'Files' }); return; }
                    const ids = [...selectedIds]; if (!ids.includes(f.id)) ids.push(f.id);
                    for (const id of ids) { await FS.deleteToTrash(id); }
                    selectedIds.clear(); renderFiles(); renderDesktopIcons();
                  }
                }])]);
          }

          async function trashSelected() {
            if (OS.settings.get('filesViewOnly')) { Notify.show({ title: 'Blocked', body: 'Delete disabled.', type: 'warning', appName: 'Files' }); return; }
            const ids = [...selectedIds]; if (!ids.length) return;
            for (const id of ids) await FS.deleteToTrash(id);
            selectedIds.clear(); renderFiles(); renderDesktopIcons();
          }

          // ── Empty area context menu ──────────────────────────────────
          filesGrid.addEventListener('contextmenu', e => {
            if (e.target === filesGrid) {
              e.preventDefault();
              ContextMenu.show(e.clientX, e.clientY, [
                { label: 'New File', icon: 'file', shortcut: 'Ctrl+N', action: async () => { const n = await showPrompt('New File Name', 'untitled.txt'); if (n) { await FS.createFile(nav.cwd, n, '', 'text/plain'); renderFiles(); renderDesktopIcons(); } } },
                { label: 'New Folder', icon: 'folder', shortcut: 'Ctrl+Shift+N', action: async () => { const n = await showPrompt('New Folder', 'New Folder'); if (n) { await FS.createFolder(nav.cwd, n); renderFiles(); renderDesktopIcons(); } } },
                { separator: true },
                {
                  label: 'Paste', icon: 'documents', shortcut: 'Ctrl+V', action: async () => {
                    if (OS.settings.get('disableClipboardPaste')) { Notify.show({ title: 'Blocked', body: 'Paste disabled.', type: 'warning', appName: 'Files' }); return; }
                    const clip = OS.clipboard; if (!clip?.fileId) return;
                    const src = FS.files.get(clip.fileId); if (!src) return;
                    if (clip.type === 'cut') { src.parentId = nav.cwd; FS.files.set(src.id, src); await OS.workers.fs.call('putFiles', [src]); OS.clipboard = null; }
                    else await FS.createFile(nav.cwd, src.name, src.content, src.mimeType);
                    renderFiles(); renderDesktopIcons();
                  }
                },
                { separator: true },
                { label: 'Sort by Name', action: () => { sortBy = 'name'; sortAsc = !sortAsc; renderFiles(); } },
                { label: 'Sort by Size', action: () => { sortBy = 'size'; sortAsc = !sortAsc; renderFiles(); } },
                { label: 'Sort by Type', action: () => { sortBy = 'mime'; sortAsc = !sortAsc; renderFiles(); } },
                { label: 'Sort by Date', action: () => { sortBy = 'modified'; sortAsc = !sortAsc; renderFiles(); } },
                { separator: true },
                { label: 'View: Icons', action: () => { viewMode = 'icon'; renderFiles(); } },
                { label: 'View: List', action: () => { viewMode = 'list'; renderFiles(); } },
                { separator: true },
                { label: 'Select All', action: () => { FS.listDir(nav.cwd).forEach(f => selectedIds.add(f.id)); updateSelectionVisuals(); } }]);
            }
          });

          listBody.addEventListener('contextmenu', e => {
            if (e.target === listBody) { e.preventDefault(); filesGrid.dispatchEvent(Object.assign(new MouseEvent('contextmenu', { clientX: e.clientX, clientY: e.clientY, bubbles: true }))); }
          });

          // ── Search ───────────────────────────────────────────────────
          let searchTimer;
          searchInput.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => renderFiles(searchInput.value.trim()), 150);
          });

          // ── FS change listeners ──────────────────────────────────────
          const onFsChange = () => { if (!isRenaming) renderFiles(); };
          OS.events.on('fs:created', onFsChange);
          OS.events.on('fs:updated', onFsChange);
          OS.events.on('fs:deleted', onFsChange);
          state.cleanups.push(
            () => OS.events.off('fs:created', onFsChange),
            () => OS.events.off('fs:updated', onFsChange),
            () => OS.events.off('fs:deleted', onFsChange)
          );

          // ── Keyboard shortcuts ───────────────────────────────────────
          const _kd = e => {
            const win = content.closest('.app-window');
            if (win?.dataset.appId !== 'vault') return;
            const ae = document.activeElement;
            if (ae === pathBar || ae === searchInput) return;
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
            if ((e.key === 'Backspace' && !e.altKey) || (e.key === 'ArrowLeft' && e.altKey)) { e.preventDefault(); goBack(); }
            if (e.key === 'ArrowUp' && e.altKey) { e.preventDefault(); goUp(); }
            if (e.key === 'F2') { const sel = filesGrid.querySelector('.vault-file.selected'); if (sel?._fileNode) { const nm = sel.querySelector('.vault-file-name'); if (nm) inlineRename(sel._fileNode, nm); } }
            if (e.key === 'Delete') { e.preventDefault(); trashSelected(); }
            if (e.ctrlKey && e.key === 'a') { e.preventDefault(); FS.listDir(nav.cwd).forEach(f => selectedIds.add(f.id)); updateSelectionVisuals(); }
            if (e.ctrlKey && e.key === 'l') { e.preventDefault(); pathBar.focus(); pathBar.select(); }
            if (e.ctrlKey && e.key === 'f') { e.preventDefault(); searchInput.focus(); }
          };
          document.addEventListener('keydown', _kd);
          state.cleanups.push(() => document.removeEventListener('keydown', _kd));

          // ── Init ─────────────────────────────────────────────────────
          ensureDefaultSystemFolders().then(() => {
            renderFiles();
          });
        },

        // ── Static Extension Map for onDrop Optimization ─────────────
        _extMap: { 
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', 
          webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', mp3: 'audio/mpeg', 
          mp4: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', 
          m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg; codecs=opus', 
          weba: 'audio/webm', webm: 'audio/webm', pdf: 'application/pdf', 
          txt: 'text/plain', md: 'text/markdown', json: 'application/json' 
        },

        async onDrop(file, state) {
          try {
            const fileId = generateId();
            const fileData = await file.arrayBuffer();
            let mime = file.type;
            if (!mime) {
              const ext = file.name.split('.').pop().toLowerCase();
              mime = this._extMap[ext] || 'application/octet-stream';
            }
            const parentId = state._nav?.cwd || FS.specialFolders.desktop || FS.rootId;
            const node = { id: fileId, name: file.name, type: 'file', size: file.size, content: new Uint8Array(fileData), mimeType: mime, parentId, modified: Date.now() };
            FS.files.set(fileId, node);
            await OS.workers.fs.call('putFiles', [node]);
            if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
            Notify.show({ title: 'File Added', body: file.name, type: 'success', appName: 'Files' });
          } catch {
            Notify.show({ title: 'Error', body: 'Failed to add file.', type: 'error', appName: 'Files' });
          }
        }
      });