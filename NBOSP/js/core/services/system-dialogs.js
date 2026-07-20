/**
 * SystemDialogs  —  NovaByte OS
 * ─────────────────────────────────────────────────────────────────────────
 * One shared, VFS-backed "Save As" / "Open" dialog, styled like the real
 * Files app (browser-toolbar nav, vault-files icon grid, breadcrumb-free
 * path bar with back/up buttons). Any app — first-party or .novaapp — can
 * call this directly. No permission grant is required to *open* the dialog
 * itself; it only ever touches the VFS through FS, exactly like the Files
 * app does, and every read/write still goes through FS's own bookkeeping
 * (events, search index, etc).
 *
 * Usage:
 *   const res = await SystemDialogs.save({
 *     title: 'Save As',
 *     suggestedName: 'untitled.txt',
 *     startFolderId: FS.specialFolders.documents,
 *   });
 *   // res === null if cancelled, otherwise { folderId, name, path }
 *
 *   const res = await SystemDialogs.open({
 *     title: 'Import',
 *     startFolderId: FS.specialFolders.documents,
 *     filter: (node) => node.type === 'folder' || node.mimeType === 'text/plain',
 *   });
 *   // res === null if cancelled, otherwise the picked file node
 *
 * Deliberately NOT included: a "save as type" dropdown. This dialog only
 * ever deals in VFS paths + a filename — the caller already knows what
 * kind of file it wants (that's what determined which api it invoked).
 */
const SystemDialogs = {
  /**
   * @param {object} opts
   * @param {'save'|'open'} opts.mode
   * @param {string} [opts.title]
   * @param {string} [opts.suggestedName]  save mode only — prefilled filename
   * @param {string} [opts.startFolderId]  defaults to FS.rootId
   * @param {(node: object) => boolean} [opts.filter]  open mode only — hide files that don't match (folders always shown)
   * @returns {Promise<null | {folderId:string, name:string, path:string} | object>}
   */
  _show(opts) {
    const mode = opts.mode;
    const isSave = mode === 'save';

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      // ── Overlay + dialog shell (matches the rest of the OS's modals) ─────
      const overlay = createEl('div', {
        className: 'modal-overlay', role: 'dialog', 'aria-modal': 'true',
      });
      const dialog = createEl('div', {
        className: 'modal-dialog',
        style: 'max-width:640px;width:94%;padding:0;display:flex;flex-direction:column;max-height:78vh;',
      });

      const header = createEl('div', {
        className: 'modal-title',
        style: 'padding:16px 18px 10px;margin:0;',
        textContent: opts.title || (isSave ? 'Save As' : 'Open'),
      });

      // ── Toolbar: back · up · path bar (read-only breadcrumb-style input) ──
      const toolbar = createEl('div', { className: 'browser-toolbar' });
      const backBtn = createEl('button', { className: 'browser-nav-btn', title: 'Back', 'aria-label': 'Back' });
      backBtn.innerHTML = svgIcon('chevron-left', 16);
      const upBtn = createEl('button', { className: 'browser-nav-btn', title: 'Up', 'aria-label': 'Parent folder' });
      upBtn.innerHTML = svgIcon('chevron-up', 16);

      const pathBarWrap = createEl('div', { className: 'browser-url-bar-wrap' });
      const pathBar = createEl('input', {
        className: 'browser-url-bar',
        name: 'sysdialog-path',
        'aria-label': 'Current folder',
        spellcheck: 'false',
        readonly: true,
      });
      const pathIcon = createEl('span', { className: 'browser-url-icon' });
      pathIcon.innerHTML = svgIcon('folder', 14);
      pathBarWrap.append(pathBar, pathIcon);

      toolbar.append(backBtn, upBtn, pathBarWrap);

      // ── File grid (reuses the real Files-app visual classes) ─────────────
      const grid = createEl('div', {
        className: 'vault-files', role: 'grid', 'aria-label': 'Files',
        style: 'max-height:320px;min-height:220px;',
      });

      // ── Bottom bar: filename box (save only) + Cancel / Save|Open ─────────
      const bottomBar = createEl('div', {
        style: 'display:flex;align-items:center;gap:8px;padding:12px 18px;border-top:1px solid var(--border-subtle);flex-shrink:0;',
      });

      let nameInput = null;
      if (isSave) {
        nameInput = createEl('input', {
          className: 'input', name: 'sysdialog-filename',
          type: 'text', style: 'flex:1;', placeholder: 'File name…',
          value: opts.suggestedName || '', 'aria-label': 'File name',
        });
      } else {
        // Keeps layout consistent; shows what's selected in open mode.
        nameInput = createEl('input', {
          className: 'input', name: 'sysdialog-selected',
          type: 'text', style: 'flex:1;', readonly: true,
          placeholder: 'Select a file…', 'aria-label': 'Selected file',
        });
      }

      const cancelBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Cancel' });
      const confirmBtn = createEl('button', {
        className: 'btn btn-sm btn-primary',
        textContent: isSave ? 'Save' : 'Open',
      });
      confirmBtn.disabled = true;

      bottomBar.append(nameInput, cancelBtn, confirmBtn);
      dialog.append(header, toolbar, grid, bottomBar);
      overlay.appendChild(dialog);

      // ── Navigation state ───────────────────────────────────────────────
      const history = [];
      let historyIdx = -1;
      let cwd = opts.startFolderId || FS.rootId;
      let selectedNode = null; // open mode only

      function pushHistory(folderId) {
        if (historyIdx < history.length - 1) history.length = historyIdx + 1;
        history.push(folderId);
        historyIdx = history.length - 1;
      }

      function navigateTo(folderId, { record = true } = {}) {
        cwd = folderId;
        if (record) pushHistory(folderId);
        selectedNode = null;
        if (!isSave) confirmBtn.disabled = true;
        renderPathBar();
        renderGrid();
      }

      backBtn.addEventListener('click', () => {
        if (historyIdx <= 0) return;
        historyIdx--;
        cwd = history[historyIdx];
        selectedNode = null;
        if (!isSave) confirmBtn.disabled = true;
        renderPathBar();
        renderGrid();
      });

      upBtn.addEventListener('click', () => {
        const node = FS.files.get(cwd);
        if (node?.parentId) navigateTo(node.parentId);
      });

      function renderPathBar() {
        pathBar.value = FS.getPath(cwd);
        upBtn.disabled = !FS.files.get(cwd)?.parentId;
        backBtn.disabled = historyIdx <= 0;
      }

      function updateSaveConfirmState() {
        if (!isSave) return;
        confirmBtn.disabled = !nameInput.value.trim();
      }

      if (isSave) {
        nameInput.addEventListener('input', updateSaveConfirmState);
      }

      function renderGrid() {
        grid.replaceChildren();
        let children = FS.listDir(cwd);
        if (!isSave && typeof opts.filter === 'function') {
          children = children.filter((n) => n.type === 'folder' || opts.filter(n));
        }

        if (children.length === 0) {
          grid.appendChild(createEl('div', {
            style: 'grid-column:1/-1;padding:24px;text-align:center;color:var(--text-muted);font-size:12px;',
            textContent: '(empty folder)',
          }));
          return;
        }

        for (const node of children) {
          const item = createEl('div', {
            className: 'vault-file', tabindex: '0',
            role: 'gridcell', 'aria-label': node.name,
          });
          item._fileNode = node;

          const iconWrap = createEl('div', { className: 'vault-file-icon' });
          iconWrap.innerHTML = svgIcon(node.type === 'folder' ? 'folder' : 'file', 32);
          const nameEl = createEl('div', { className: 'vault-file-name', textContent: node.name });
          item.append(iconWrap, nameEl);

          if (node.type === 'folder') {
            item.addEventListener('dblclick', () => navigateTo(node.id));
            item.addEventListener('click', () => {
              // Single click on a folder just selects it visually; double
              // click (or Enter) descends into it. Matches Files app feel.
            });
            item.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') navigateTo(node.id);
            });
          } else {
            item.addEventListener('click', () => {
              for (const el of grid.children) el.classList.remove('selected');
              item.classList.add('selected');
              selectedNode = node;
              if (isSave) {
                nameInput.value = node.name;
                updateSaveConfirmState();
              } else {
                nameInput.value = node.name;
                confirmBtn.disabled = false;
              }
            });
            item.addEventListener('dblclick', () => {
              if (isSave) {
                nameInput.value = node.name;
                updateSaveConfirmState();
                doConfirm();
              } else {
                selectedNode = node;
                doConfirm();
              }
            });
          }

          grid.appendChild(item);
        }
      }

      async function doConfirm() {
        if (confirmBtn.disabled) return;
        if (isSave) {
          const name = nameInput.value.trim();
          if (!name) return;
          finish({ folderId: cwd, name, path: FS.getPath(cwd) + (FS.getPath(cwd) === '/' ? '' : '/') + name });
        } else {
          if (!selectedNode) return;
          finish(selectedNode);
        }
      }

      cancelBtn.addEventListener('click', () => finish(null));
      confirmBtn.addEventListener('click', doConfirm);

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) finish(null);
      });

      function onKeydown(e) {
        if (e.key === 'Escape') { e.preventDefault(); finish(null); }
        else if (e.key === 'Enter' && document.activeElement === nameInput) {
          e.preventDefault();
          doConfirm();
        }
      }
      overlay.addEventListener('keydown', onKeydown);

      function cleanup() {
        overlay.removeEventListener('keydown', onKeydown);
        overlay.remove();
      }

      document.body.appendChild(overlay);
      pushHistory(cwd);
      renderPathBar();
      renderGrid();

      if (isSave) {
        requestAnimationFrame(() => { nameInput.focus(); nameInput.select(); });
        updateSaveConfirmState();
      } else {
        requestAnimationFrame(() => grid.focus());
      }
    });
  },

  /**
   * Opens a Save-As style dialog. Resolves to null if cancelled, otherwise
   * { folderId, name, path }. The caller is responsible for actually
   * writing the file (FS.createFile / FS.writeFile) — this dialog only
   * picks the destination, it never writes anything itself.
   */
  save(opts = {}) {
    return this._show({ ...opts, mode: 'save' });
  },

  /**
   * Opens an Open/Import style dialog. Resolves to null if cancelled,
   * otherwise the picked file's VFS node.
   */
  open(opts = {}) {
    return this._show({ ...opts, mode: 'open' });
  },
};

window.SystemDialogs = SystemDialogs;
