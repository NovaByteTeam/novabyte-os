/**
 * SystemDialogs  —  NovaByte OS
 * ─────────────────────────────────────────────────────────────────────────
 * One shared, VFS-backed "Save As" / "Open" dialog, styled like the Files
 * app with its own host-level toolbar and file grid. Any app — first-party or .novaapp — can
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
 *     canAccess: (node) => true, // optional host-side scope for every displayed node
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
   * @param {(node: object) => boolean} [opts.filter]  open mode only — hide files that don't match
   * @param {(node: object) => boolean} [opts.canAccess] host-side scope; hides inaccessible files and folders
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

      let modalRoot = document.getElementById('system-modal-root');
      if (!modalRoot) {
        modalRoot = document.createElement('div');
        modalRoot.id = 'system-modal-root';
        Object.assign(modalRoot.style, {
          position: 'fixed',
          inset: '0',
          width: '100vw',
          height: '100vh',
          zIndex: '2147483000',
          pointerEvents: 'none',
          isolation: 'isolate',
        });
        document.body.appendChild(modalRoot);
      }

      // ── Overlay + dialog shell (matches the rest of the OS's modals) ─────
      const overlay = createEl('div', {
        className: 'modal-overlay', role: 'dialog', 'aria-modal': 'true',
      });
      overlay.style.pointerEvents = 'auto';
      const dialog = createEl('div', {
        className: 'modal-dialog system-file-dialog',
      });

      const header = createEl('div', {
        className: 'modal-title system-file-dialog-title',
        textContent: opts.title || (isSave ? 'Save As' : 'Open'),
      });

      // ── Toolbar: back · up · path bar (read-only breadcrumb-style input) ──
      const toolbar = createEl('div', { className: 'system-file-dialog-toolbar' });
      const backBtn = createEl('button', { className: 'system-file-dialog-nav-btn', title: 'Back', 'aria-label': 'Back' });
      backBtn.innerHTML = svgIcon('chevron-left', 16);
      const upBtn = createEl('button', { className: 'system-file-dialog-nav-btn', title: 'Up', 'aria-label': 'Parent folder' });
      upBtn.innerHTML = svgIcon('chevron-up', 16);

      const pathBarWrap = createEl('div', { className: 'system-file-dialog-path-wrap' });
      const pathBar = createEl('input', {
        className: 'system-file-dialog-path',
        name: 'sysdialog-path',
        'aria-label': 'Current folder',
        spellcheck: 'false',
        readonly: true,
      });
      const pathIcon = createEl('span', { className: 'system-file-dialog-path-icon' });
      pathIcon.innerHTML = svgIcon('folder', 14);
      pathBarWrap.append(pathBar, pathIcon);

      toolbar.append(backBtn, upBtn, pathBarWrap);

      // ── File grid ───────────────────────────────────────────────────────
      const grid = createEl('div', {
        className: 'system-file-dialog-grid', role: 'grid', 'aria-label': 'Files',
      });

      // ── Bottom bar: filename box (save only) + Cancel / Save|Open ─────────
      const bottomBar = createEl('div', {
        className: 'system-file-dialog-footer',
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
      const canAccess = (node) => !!node && (typeof opts.canAccess !== 'function' || opts.canAccess(node) === true);
      let cwd = opts.startFolderId || FS.rootId;
      const startFolder = FS.files.get(cwd);
      if (!startFolder || startFolder.type !== 'folder' || !canAccess(startFolder)) cwd = FS.rootId;
      let selectedNode = null; // open mode only

      function pushHistory(folderId) {
        if (historyIdx < history.length - 1) history.length = historyIdx + 1;
        history.push(folderId);
        historyIdx = history.length - 1;
      }

      function navigateTo(folderId, { record = true } = {}) {
        const folder = FS.files.get(folderId);
        if (!folder || folder.type !== 'folder' || !canAccess(folder)) return;
        cwd = folderId;
        if (record) pushHistory(folderId);
        selectedNode = null;
        if (!isSave) confirmBtn.disabled = true;
        renderPathBar();
        renderGrid();
      }

      backBtn.addEventListener('click', () => {
        if (historyIdx <= 0) return;
        const previousFolderId = history[historyIdx - 1];
        const previousFolder = FS.files.get(previousFolderId);
        if (!previousFolder || previousFolder.type !== 'folder' || !canAccess(previousFolder)) return;
        historyIdx--;
        cwd = previousFolderId;
        selectedNode = null;
        if (!isSave) confirmBtn.disabled = true;
        renderPathBar();
        renderGrid();
      });

      upBtn.addEventListener('click', () => {
        const node = FS.files.get(cwd);
        if (node?.parentId && canAccess(FS.files.get(node.parentId))) navigateTo(node.parentId);
      });

      function renderPathBar() {
        pathBar.value = FS.getPath(cwd);
        const parentId = FS.files.get(cwd)?.parentId;
        upBtn.disabled = !parentId || !canAccess(FS.files.get(parentId));
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
        const currentFolder = FS.files.get(cwd);
        if (!currentFolder || currentFolder.type !== 'folder' || !canAccess(currentFolder)) {
          navigateTo(FS.rootId);
          return;
        }
        grid.replaceChildren();
        let children = FS.listDir(cwd).filter(canAccess);
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
            className: 'system-file-dialog-item', tabindex: '0',
            role: 'gridcell', 'aria-label': node.name,
          });
          item.setAttribute('aria-selected', 'false');
          item._fileNode = node;

          const iconWrap = createEl('div', { className: 'system-file-dialog-icon' });
          iconWrap.innerHTML = svgIcon(node.type === 'folder' ? 'folder' : 'file', 32);
          const nameEl = createEl('div', { className: 'system-file-dialog-name', textContent: node.name });
          item.append(iconWrap, nameEl);

          if (node.type === 'folder') {
            item.addEventListener('dblclick', () => navigateTo(node.id));
            item.addEventListener('click', () => {
              for (const el of grid.children) {
                el.classList.remove('selected');
                el.setAttribute('aria-selected', 'false');
              }
              item.classList.add('selected');
              item.setAttribute('aria-selected', 'true');
              selectedNode = null;
              if (!isSave) {
                nameInput.value = '';
                confirmBtn.disabled = true;
              }
            });
            item.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') navigateTo(node.id);
            });
          } else {
            item.addEventListener('click', () => {
              for (const el of grid.children) {
                el.classList.remove('selected');
                el.setAttribute('aria-selected', 'false');
              }
              item.classList.add('selected');
              item.setAttribute('aria-selected', 'true');
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
          if (!name || !canAccess(FS.files.get(cwd))) return;
          finish({ folderId: cwd, name, path: FS.getPath(cwd) + (FS.getPath(cwd) === '/' ? '' : '/') + name });
        } else {
          if (!selectedNode || !canAccess(selectedNode)) return;
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

      modalRoot.appendChild(overlay);
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
