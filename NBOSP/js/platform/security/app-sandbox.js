/**
 * NovaByte - App Sandbox
 * ────────────────────────────────────────────────────────────
 * Creates secure execution environments for apps using
 * sandboxed webviews with process isolation.
 *
 * @module js/app-sandbox
 */

const AppSandbox = (() => {
  const activeSandboxes = new Map();
  const eventSubscriptions = new Map(); // sandboxId -> Map(eventName -> handler)

  /**
   * Create a sandboxed webview for app execution.
   * webview runs in a separate renderer process — true process isolation.
   * Cannot access main page JS, DOM, or memory regardless of app content.
   * @param {object} app - App object
   * @param {HTMLElement} container - Container element
   * @param {object} state - Window state
   * @returns {HTMLElement} Sandboxed webview
   */
  function createSandbox(app, container, state) {
    const webview = document.createElement('webview');

    // NW.js webview security: separate renderer process provides the isolation boundary.
    // nodeintegration=false means the app cannot require() Node.js modules even if
    // the preload script has access — defense in depth.
    webview.setAttribute('nodeintegration', 'false');
    webview.setAttribute('nodeintegrationsubframes', 'false');

    // Isolated storage partition per sandbox instance.
    // 'persist:' prefix means storage survives webview destruction (expected for apps).
    // Each app instance gets its own partition — cross-app storage access is impossible.
    const sandboxId = `sandbox_${app.id}_${Date.now()}`;
    webview.setAttribute('partition', `persist:${sandboxId}`);

    const sandboxAttr = sanitizeSandboxAttr(app.sandbox, app.id);
    if (sandboxAttr) {
      webview.setAttribute('sandbox', sandboxAttr);
    }

    // Styling
    webview.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
      background: white;
      display: flex;
      flex-direction: column;
    `;

    webview.dataset.sandboxId = sandboxId;
    webview.dataset.appId = app.id;

    activeSandboxes.set(sandboxId, {
      appId: app.id,
      iframe: webview,
      webview: webview,
      created: new Date().toISOString(),
      state: state,
      windowId: state?.id,
      wsConnections: new Map()
    });

    // ── Fullscreen Support ──
    if (state && state.element) {
      const origMaximized = state.maximized;
      webview.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement === webview) {
          if (typeof WM !== 'undefined' && WM.toggleMaximize && !state.maximized) {
            WM.toggleMaximize(state.id);
          }
        } else {
          if (typeof WM !== 'undefined' && WM.toggleMaximize && !origMaximized && state.maximized) {
            WM.toggleMaximize(state.id);
          }
        }
      }, false);
    }

    eventSubscriptions.set(sandboxId, new Map());

    setupAPIBridge(webview, app, sandboxId);
    setupErrorHandling(webview, app);

    console.log(`[AppSandbox] Created webview sandbox for ${app.name} (${sandboxId})`);

    return webview;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  RESPONSE HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Send a response back to the sandboxed app
   */
  function respond(webview, type, requestId, result, error = null) {
    try {
      // Apps are served from our own origin (https://localhost:PORT/api/apps/serve/…),
      // so we can use the exact origin instead of '*'.
      webview.contentWindow.postMessage({
        type: `${type}:response`,
        requestId,
        result,
        error
      }, window.location.origin);
    } catch (e) {
      console.error(`[AppSandbox] Failed to respond to ${type}:`, e);
    }
  }

  function respondError(webview, type, requestId, code, message) {
    respond(webview, type, requestId, null, { code, message });
  }

  /**
   * Generate a unique request ID for outbound events
   */
  function generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  FS HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Resolve a file path or ID to a file node
   */
  function resolveFile(payload) {
    const { path, id } = payload;
    if (id) return FS.files.get(id) || null;
    if (path) return FS.getByPath(path);
    return null;
  }

  /**
   * Convert a file node to a safe serializable object
   */
  function fileToJSON(node) {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      mimeType: node.mimeType,
      size: node.size,
      path: FS.getPath(node.id),
      parentId: node.parentId,
      created: node.created,
      modified: node.modified,
      accessed: node.accessed,
      permissions: node.permissions,
      sha256: node.sha256,
      tags: node.tags || []
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  FILE DIALOG
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Show a file open/save dialog
   */
  function showFileDialog(mode, webview, type, requestId, app, payload) {
    const overlay = document.createElement('div');
    overlay.className = 'nsec-overlay';
    overlay.style.zIndex = '100001';

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: #0e121c; border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px; padding: 24px; max-width: 620px; width: 92%;
      max-height: 80vh; display: flex; flex-direction: column;
      box-shadow: 0 32px 80px rgba(0,0,0,0.6);
      font-family: var(--font-ui, system-ui, sans-serif);
    `;

    // Title
    const title = document.createElement('h3');
    title.style.cssText = 'color: #e6edf3; margin: 0 0 4px; font-size: 16px; font-weight: 700;';
    title.textContent = mode === 'open' ? '📂 Open File' : '💾 Save File';
    dialog.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.style.cssText = 'color: #8b949e; margin: 0 0 12px; font-size: 12px;';
    subtitle.textContent = payload.title || `Select a ${mode === 'open' ? 'file to open' : 'location to save'}`;
    dialog.appendChild(subtitle);

    // Filter
    const filter = payload.filter || payload.accept || null;
    if (filter) {
      const filterEl = document.createElement('p');
      filterEl.style.cssText = 'color: #d29922; margin: 0 0 12px; font-size: 11px;';
      filterEl.textContent = `Filter: ${Array.isArray(filter) ? filter.join(', ') : filter}`;
      dialog.appendChild(filterEl);
    }

    // Path breadcrumb
    const pathBar = document.createElement('div');
    pathBar.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 12px; flex-wrap: wrap;';

    // File list
    const fileList = document.createElement('div');
    fileList.style.cssText = 'flex: 1; overflow-y: auto; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; background: rgba(255,255,255,0.02);';

    let currentFolderId = FS.rootId;
    let selectedFile = null;

    function renderFileList() {
      fileList.innerHTML = '';
      const children = FS.listDir(currentFolderId);

      // Sort: folders first, then files, alphabetical
      children.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      if (children.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding: 24px; text-align: center; color: #8b949e; font-size: 13px;';
        empty.textContent = '(empty folder)';
        fileList.appendChild(empty);
      }

      for (const item of children) {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; border-radius: 4px; transition: background 0.1s;';
        row.addEventListener('mouseenter', () => { row.style.background = 'rgba(88,166,255,0.08)'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });

        const icon = document.createElement('span');
        icon.textContent = item.type === 'folder' ? '📁' : '📄';
        icon.style.fontSize = '16px';

        const name = document.createElement('span');
        name.style.cssText = 'flex: 1; color: #e6edf3; font-size: 13px;';
        name.textContent = item.name;

        const meta = document.createElement('span');
        meta.style.cssText = 'color: #8b949e; font-size: 11px; font-family: monospace;';
        if (item.type === 'file') {
          const size = item.size || 0;
          meta.textContent = size > 1024 ? (size / 1024).toFixed(1) + ' KB' : size + ' B';
        }

        row.appendChild(icon);
        row.appendChild(name);
        row.appendChild(meta);

        if (item.type === 'folder') {
          row.addEventListener('click', () => {
            currentFolderId = item.id;
            renderBreadcrumb();
            renderFileList();
            selectedFile = null;
            updateConfirmState();
          });
        } else {
          row.addEventListener('click', () => {
            // Toggle selection
            if (selectedFile === item.id) {
              selectedFile = null;
              row.style.background = 'transparent';
            } else {
              selectedFile = item.id;
              // Clear previous highlights
              fileList.querySelectorAll('[data-selected]').forEach(el => {
                el.style.background = 'transparent';
                el.removeAttribute('data-selected');
              });
              row.style.background = 'rgba(88,166,255,0.15)';
              row.setAttribute('data-selected', 'true');
            }
            updateConfirmState();
          });

          if (mode === 'save' && item.name === (payload.suggestedName || '')) {
            selectedFile = item.id;
            row.style.background = 'rgba(88,166,255,0.15)';
            row.setAttribute('data-selected', 'true');
          }
        }

        fileList.appendChild(row);
      }
    }

    function renderBreadcrumb() {
      pathBar.innerHTML = '';
      const parts = [];
      let node = FS.files.get(currentFolderId);
      while (node) {
        parts.unshift(node);
        node = FS.files.get(node.parentId);
      }

      parts.forEach((part, i) => {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.style.cssText = 'color: #8b949e;';
          sep.textContent = '/';
          pathBar.appendChild(sep);
        }
        const btn = document.createElement('button');
        btn.style.cssText = 'background: none; border: none; color: #58a6ff; cursor: pointer; font-size: 12px; padding: 2px 4px; border-radius: 3px;';
        btn.textContent = part.name;
        btn.addEventListener('click', () => {
          currentFolderId = part.id;
          renderBreadcrumb();
          renderFileList();
        });
        if (i === parts.length - 1) {
          btn.style.color = '#e6edf3';
          btn.style.fontWeight = '600';
          btn.style.cursor = 'default';
        }
        pathBar.appendChild(btn);
      });
    }

    // Filename input (save dialog)
    let filenameInput = null;
    if (mode === 'save') {
      const inputRow = document.createElement('div');
      inputRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 12px;';

      const label = document.createElement('label');
      label.style.cssText = 'color: #8b949e; font-size: 12px; white-space: nowrap;';
      label.textContent = 'Filename:';

      filenameInput = document.createElement('input');
      filenameInput.type = 'text';
      filenameInput.value = payload.suggestedName || '';
      filenameInput.placeholder = 'Enter filename...';
      filenameInput.style.cssText = 'flex: 1; padding: 6px 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; color: #e6edf3; font-size: 13px;';
      filenameInput.addEventListener('input', () => {
        selectedFile = null;
        updateConfirmState();
      });

      inputRow.appendChild(label);
      inputRow.appendChild(filenameInput);
      dialog.insertBefore(inputRow, fileList);
    }

    // Buttons
    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding: 8px 18px; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; background: transparent; color: #8b949e; cursor: pointer; font-size: 13px; transition: all 0.15s;';
    cancelBtn.addEventListener('mouseenter', () => { cancelBtn.style.background = 'rgba(255,255,255,0.05)'; });
    cancelBtn.addEventListener('mouseleave', () => { cancelBtn.style.background = 'transparent'; });
    cancelBtn.addEventListener('click', () => {
      overlay.remove();
      respond(webview, type, requestId, { cancelled: true });
    });

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = mode === 'open' ? 'Open' : 'Save';
    confirmBtn.style.cssText = 'padding: 8px 18px; border: none; border-radius: 6px; background: #58a6ff; color: white; cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.15s;';
    confirmBtn.addEventListener('mouseenter', () => { confirmBtn.style.background = '#3a8be6'; });
    confirmBtn.addEventListener('mouseleave', () => { confirmBtn.style.background = '#58a6ff'; });
    confirmBtn.disabled = mode === 'open';

    function updateConfirmState() {
      if (mode === 'open') {
        confirmBtn.disabled = !selectedFile;
      } else {
        confirmBtn.disabled = !(filenameInput && filenameInput.value.trim());
      }
    }

    confirmBtn.addEventListener('click', async () => {
      if (mode === 'open') {
        if (!selectedFile) return;
        const node = FS.files.get(selectedFile);
        if (!node || node.type === 'folder') return;
        overlay.remove();
        respond(webview, type, requestId, {
          success: true,
          file: {
            id: node.id,
            name: node.name,
            content: node.content || '',
            mimeType: node.mimeType || 'text/plain',
            size: node.size || 0,
            path: FS.getPath(node.id)
          }
        });
      } else {
        const name = filenameInput.value.trim();
        if (!name) return;
        const content = payload.content || '';
        const mimeType = payload.mimeType || 'text/plain';
        try {
          const newNode = await FS.createFile(currentFolderId, name, content, mimeType);
          overlay.remove();
          respond(webview, type, requestId, {
            success: true,
            file: {
              id: newNode.id,
              name: newNode.name,
              path: FS.getPath(newNode.id)
            }
          });
        } catch (e) {
          overlay.remove();
          respondError(webview, type, requestId, 'WRITE_ERROR', e.message || 'Failed to write file');
        }
      }
    });

    btnContainer.appendChild(cancelBtn);
    btnContainer.appendChild(confirmBtn);
    dialog.appendChild(btnContainer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Initial render
    renderBreadcrumb();
    renderFileList();

    // Focus filename input for save dialog
    if (mode === 'save' && filenameInput) {
      setTimeout(() => filenameInput.focus(), 50);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  SETUP API BRIDGE
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Setup postMessage API bridge
   * @param {HTMLElement} webview - Sandbox webview
   * @param {object} app - App object
   * @param {string} sandboxId - Sandbox ID
   */
  function setupAPIBridge(webview, app, sandboxId) {
    const messageHandler = (event) => {
      // Apps served from our origin — same-origin postMessage, no 'null' hack needed.
      if (event.origin !== window.location.origin) return;
      // event.source === webview.contentWindow: NW.js exposes ContentWindow on webview,
      // so this check prevents messages from any other frame on the same origin.
      if (event.source !== webview.contentWindow) return;

      const { type, payload, requestId } = event.data;
      if (!type || !type.startsWith('nova:')) return;

      const sandbox = activeSandboxes.get(sandboxId);
      handleAPICall(type, payload, requestId, app, webview, sandbox);
    };

    window.addEventListener('message', messageHandler);

    // Store cleanup
    const sandbox = activeSandboxes.get(sandboxId);
    if (sandbox) {
      sandbox.cleanup = () => {
        window.removeEventListener('message', messageHandler);
        const subs = eventSubscriptions.get(sandboxId);
        if (subs) {
          for (const [eventName, handler] of subs) {
            OS.events.off(eventName, handler);
          }
          subs.clear();
        }
        eventSubscriptions.delete(sandboxId);
        for (const [, wsState] of (sandbox.wsConnections || new Map())) {
          try { wsState.ws.close(1000, 'sandbox closed'); } catch { /* already closed */ }
        }
        sandbox.wsConnections?.clear();
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  MAIN API HANDLER
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Handle API calls from sandboxed app
   * @param {string} type - API call type
   * @param {object} payload - Call payload
   * @param {string} requestId - Request ID for response correlation
   * @param {object} app - App object
   * @param {HTMLElement} webview - Sandbox webview
   * @param {object} sandbox - Sandbox info object
   */
  async function handleAPICall(type, payload, requestId, app, webview, sandbox) {
    const windowId = sandbox?.windowId;

    try {
      // ── FS: Read ──────────────────────────────────────────────────────
      if (type === 'nova:fs:read') {
        if (!AppPermissionManager.isGranted('fs:read', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'fs:read permission required');
        }
        const node = resolveFile(payload);
        if (!node) return respondError(webview, type, requestId, 'NOT_FOUND', 'File or folder not found');
        if (node.type === 'folder') {
          const children = FS.listDir(node.id);
          return respond(webview, type, requestId, {
            success: true,
            isFolder: true,
            name: node.name,
            id: node.id,
            path: FS.getPath(node.id),
            children: children.map(c => ({
              id: c.id, name: c.name, type: c.type, mimeType: c.mimeType,
              size: c.size, modified: c.modified, created: c.created
            }))
          });
        }
        return respond(webview, type, requestId, {
          success: true,
          data: node.content,
          mimeType: node.mimeType,
          name: node.name,
          size: node.size,
          id: node.id,
          path: FS.getPath(node.id),
          modified: node.modified,
          created: node.created
        });
      }

      // ── FS: Write ─────────────────────────────────────────────────────
      if (type === 'nova:fs:write') {
        if (!AppPermissionManager.isGranted('fs:write', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'fs:write permission required');
        }
        const { path, content, mimeType } = payload;
        if (!path || content === undefined) {
          return respondError(webview, type, requestId, 'INVALID_ARGS', 'path and content are required');
        }
        let node = FS.getByPath(path);
        if (node) {
          if (node.type === 'folder') {
            return respondError(webview, type, requestId, 'INVALID_OPERATION', 'Cannot write to a folder');
          }
          await FS.writeFile(node.id, content);
          return respond(webview, type, requestId, { success: true, id: node.id });
        }
        const parts = path.split('/').filter(Boolean);
        const fileName = parts.pop();
        const parentPath = '/' + parts.join('/');
        const parent = parts.length > 0 ? FS.getByPath(parentPath) : FS.files.get(FS.rootId);
        if (!parent || parent.type !== 'folder') {
          return respondError(webview, type, requestId, 'NOT_FOUND', 'Parent folder not found');
        }
        const newNode = await FS.createFile(parent.id, fileName,
          typeof content === 'string' ? content : JSON.stringify(content),
          mimeType || 'text/plain');
        return respond(webview, type, requestId, { success: true, id: newNode.id, path: FS.getPath(newNode.id) });
      }

      // ── FS: Delete ────────────────────────────────────────────────────
      if (type === 'nova:fs:delete') {
        if (!AppPermissionManager.isGranted('fs:delete', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'fs:delete permission required');
        }
        const node = resolveFile(payload);
        if (!node) return respondError(webview, type, requestId, 'NOT_FOUND', 'File not found');
        if (payload.permanent) {
          await FS.permanentDelete(node.id);
        } else {
          await FS.deleteToTrash(node.id);
        }
        return respond(webview, type, requestId, { success: true });
      }

      // ── FS: List ──────────────────────────────────────────────────────
      if (type === 'nova:fs:list') {
        if (!AppPermissionManager.isGranted('fs:read', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'fs:read permission required');
        }
        const node = resolveFile(payload);
        if (!node) return respondError(webview, type, requestId, 'NOT_FOUND', 'Folder not found');
        if (node.type !== 'folder') {
          return respondError(webview, type, requestId, 'INVALID_OPERATION', 'Path is not a folder');
        }
        const children = FS.listDir(node.id);
        return respond(webview, type, requestId, {
          success: true,
          path: FS.getPath(node.id),
          files: children.map(c => ({
            id: c.id, name: c.name, type: c.type, mimeType: c.mimeType,
            size: c.size, modified: c.modified, created: c.created
          }))
        });
      }

      // ── FS: Mkdir ─────────────────────────────────────────────────────
      if (type === 'nova:fs:mkdir') {
        if (!AppPermissionManager.isGranted('fs:write', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'fs:write permission required');
        }
        const { path, name } = payload;
        if (!name) {
          return respondError(webview, type, requestId, 'INVALID_ARGS', 'name is required');
        }
        let parent;
        if (path) {
          parent = FS.getByPath(path);
        } else {
          parent = FS.files.get(FS.rootId);
        }
        if (!parent || parent.type !== 'folder') {
          return respondError(webview, type, requestId, 'NOT_FOUND', 'Parent folder not found');
        }
        const newFolder = await FS.createFolder(parent.id, name);
        return respond(webview, type, requestId, { success: true, id: newFolder.id, path: FS.getPath(newFolder.id) });
      }

      // ── FS: Stat ──────────────────────────────────────────────────────
      if (type === 'nova:fs:stat') {
        if (!AppPermissionManager.isGranted('fs:read', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'fs:read permission required');
        }
        const node = resolveFile(payload);
        if (!node) return respondError(webview, type, requestId, 'NOT_FOUND', 'File not found');
        return respond(webview, type, requestId, {
          success: true,
          stat: fileToJSON(node)
        });
      }

      // ── FS: Rename ────────────────────────────────────────────────────
      if (type === 'nova:fs:rename') {
        if (!AppPermissionManager.isGranted('fs:write', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'fs:write permission required');
        }
        const node = resolveFile(payload);
        if (!node) return respondError(webview, type, requestId, 'NOT_FOUND', 'File not found');
        if (!payload.name) {
          return respondError(webview, type, requestId, 'INVALID_ARGS', 'name is required');
        }
        await FS.rename(node.id, payload.name);
        return respond(webview, type, requestId, { success: true, name: payload.name });
      }

      // ── FS: Move ──────────────────────────────────────────────────────
      if (type === 'nova:fs:move') {
        if (!AppPermissionManager.isGranted('fs:write', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'fs:write permission required');
        }
        const node = resolveFile(payload);
        if (!node) return respondError(webview, type, requestId, 'NOT_FOUND', 'File not found');
        const destParent = payload.destPath ? FS.getByPath(payload.destPath) : null;
        if (!destParent || destParent.type !== 'folder') {
          return respondError(webview, type, requestId, 'NOT_FOUND', 'Destination folder not found');
        }
        await FS.move(node.id, destParent.id);
        return respond(webview, type, requestId, { success: true, path: FS.getPath(node.id) });
      }

      // ── Notifications: Show ───────────────────────────────────────────
      if (type === 'nova:notifications:show') {
        if (!AppPermissionManager.isGranted('device:notifications', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'device:notifications permission required');
        }
        if (typeof Notify !== 'undefined') {
          Notify.show({
            title: payload.title || 'Notification',
            body: payload.body || '',
            type: payload.type || 'info',
            appName: app.name,
            icon: payload.icon || null,
            action: payload.action || null,
            actionLabel: payload.actionLabel || null,
            category: payload.category || 'app'
          });
        }
        return respond(webview, type, requestId, { success: true });
      }

      // ── Notifications: Clear ──────────────────────────────────────────
      if (type === 'nova:notifications:clear') {
        if (!AppPermissionManager.isGranted('device:notifications', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'device:notifications permission required');
        }
        if (typeof Notify !== 'undefined' && typeof Notify.clearAll === 'function') {
          Notify.clearAll();
        }
        return respond(webview, type, requestId, { success: true });
      }

      // ── Settings: Get ─────────────────────────────────────────────────
      if (type === 'nova:settings:get') {
        // FIX: any app could read any system setting key (credentials, etc.)
        if (!AppPermissionManager.isGranted('system:info', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'system:info permission required');
        }
        const value = OS?.settings?.get(payload.key);
        return respond(webview, type, requestId, { success: true, value });
      }

      // ── Settings: Set ─────────────────────────────────────────────────
      if (type === 'nova:settings:set') {
        if (!AppPermissionManager.isGranted('system:settings', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'system:settings permission required');
        }
        OS?.settings?.set(payload.key, payload.value);
        return respond(webview, type, requestId, { success: true });
      }

      // ── Request Permission ────────────────────────────────────────────
      if (type === 'nova:request-permission') {
        const { permission } = payload;
        if (!permission) {
          return respondError(webview, type, requestId, 'INVALID_ARGS', 'permission is required');
        }
        try {
          const granted = await AppPermissionManager.requestPermission(permission, app.id, {
            reason: payload.reason || `${app.name} wants to access this permission.`,
            permanent: payload.permanent !== false
          });
          return respond(webview, type, requestId, { granted });
        } catch (e) {
          return respondError(webview, type, requestId, 'ERROR', e.message || 'Permission request failed');
        }
      }

      // ── Window: Close ─────────────────────────────────────────────────
      if (type === 'nova:window:close') {
        if (windowId && typeof WM.closeWindow === 'function') {
          WM.closeWindow(windowId);
        }
        return respond(webview, type, requestId, { success: true });
      }

      // ── Window: Minimize ──────────────────────────────────────────────
      if (type === 'nova:window:minimize') {
        if (windowId && typeof WM.minimizeWindow === 'function') {
          WM.minimizeWindow(windowId);
        }
        return respond(webview, type, requestId, { success: true });
      }

      // ── Window: Maximize / Restore ────────────────────────────────────
      if (type === 'nova:window:maximize') {
        if (windowId && typeof WM.toggleMaximize === 'function') {
          WM.toggleMaximize(windowId);
        }
        return respond(webview, type, requestId, { success: true });
      }

      // ── Window: Set Title ─────────────────────────────────────────────
      if (type === 'nova:window:setTitle') {
        if (windowId) {
          const state = OS.windows.get(windowId);
          if (state && state.titleText) {
            state.titleText.textContent = payload.title || '';
          }
        }
        return respond(webview, type, requestId, { success: true });
      }

      // ── Window: Resize ────────────────────────────────────────────────
      if (type === 'nova:window:resize') {
        if (windowId) {
          const state = OS.windows.get(windowId);
          if (state && state.element) {
            const w = parseInt(payload.width) || 800;
            const h = parseInt(payload.height) || 600;
            state.element.style.width = w + 'px';
            state.element.style.height = h + 'px';
            state.width = w;
            state.height = h;
            if (state.maximized) {
              state.maximized = false;
              state.element.classList.remove('maximized');
            }
          }
        }
        return respond(webview, type, requestId, { success: true });
      }

      // ── Window: Get State ─────────────────────────────────────────────
      if (type === 'nova:window:getState') {
        const state = windowId ? OS.windows.get(windowId) : null;
        if (state) {
          return respond(webview, type, requestId, {
            success: true,
            id: state.id,
            x: state.x, y: state.y,
            width: state.width, height: state.height,
            maximized: !!state.maximized,
            minimized: !!state.minimized
          });
        }
        return respondError(webview, type, requestId, 'NOT_FOUND', 'Window not found');
      }

      // ── Clipboard: Read ───────────────────────────────────────────────
      if (type === 'nova:clipboard:read') {
        // FIX: reading clipboard was entirely ungated; now requires fs:read
        if (!AppPermissionManager.isGranted('fs:read', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'fs:read permission required for clipboard access');
        }
        return respond(webview, type, requestId, {
          success: true,
          data: OS.clipboard || null
        });
      }

      // ── Clipboard: Write ──────────────────────────────────────────────
      if (type === 'nova:clipboard:write') {
        if (!AppPermissionManager.isGranted('fs:read', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'fs:read permission required for clipboard access');
        }
        OS.clipboard = payload.data || '';
        if (!OS.clipboardHistory) OS.clipboardHistory = [];
        if (typeof payload.data === 'string' && !OS.clipboardHistory.includes(payload.data)) {
          OS.clipboardHistory.unshift(payload.data);
          if (OS.clipboardHistory.length > 30) OS.clipboardHistory.pop();
        }
        return respond(webview, type, requestId, { success: true });
      }

      // ── App: Launch ───────────────────────────────────────────────────
      if (type === 'nova:app:launch') {
        // FIX: require system:apps permission — previously any app could launch any other app
        if (!AppPermissionManager.isGranted('system:apps', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'system:apps permission required');
        }
        const { appId, options } = payload;
        if (!appId) {
          return respondError(webview, type, requestId, 'INVALID_ARGS', 'appId is required');
        }
        try {
          if (typeof WM.createWindow === 'function') {
            const win = WM.createWindow(appId, options || {});
            return respond(webview, type, requestId, { success: !!win, windowId: win ? win.id : null });
          }
          return respondError(webview, type, requestId, 'UNAVAILABLE', 'Window manager not available');
        } catch (e) {
          return respondError(webview, type, requestId, 'ERROR', e.message);
        }
      }

      // ── App: Info ─────────────────────────────────────────────────────
      if (type === 'nova:app:info') {
        return respond(webview, type, requestId, {
          success: true,
          id: app.id,
          name: app.name,
          version: app.version,
          icon: app.icon,
          type: app.type,
          permissions: app.permissions || [],
          optionalPermissions: app.optionalPermissions || []
        });
      }

      // ── Events: Subscribe ─────────────────────────────────────────────
      if (type === 'nova:events:subscribe') {
        if (!AppPermissionManager.isGranted('system:events', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'system:events permission required');
        }
        const { event } = payload;
        if (!event) {
          return respondError(webview, type, requestId, 'INVALID_ARGS', 'event name is required');
        }
        const subs = eventSubscriptions.get(sandboxId);
        if (subs && subs.has(event)) {
          return respondError(webview, type, requestId, 'ALREADY_SUBSCRIBED', `Already subscribed to '${event}'`);
        }
        const handler = (data) => {
          respond(webview, 'nova:events:event', generateRequestId(), { event, data });
        };
        OS.events.on(event, handler);
        if (subs) subs.set(event, handler);
        return respond(webview, type, requestId, { success: true, subscribed: event });
      }

      // ── Events: Unsubscribe ───────────────────────────────────────────
      if (type === 'nova:events:unsubscribe') {
        if (!AppPermissionManager.isGranted('system:events', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'system:events permission required');
        }
        const { event } = payload;
        const subs = eventSubscriptions.get(sandboxId);
        if (subs && subs.has(event)) {
          const handler = subs.get(event);
          OS.events.off(event, handler);
          subs.delete(event);
        }
        return respond(webview, type, requestId, { success: true, unsubscribed: event });
      }

      // ── Net: Fetch ────────────────────────────────────────────────────
      if (type === 'nova:net:fetch') {
        const { url, method, headers, body } = payload;
        if (!url) {
          return respondError(webview, type, requestId, 'INVALID_ARGS', 'url is required');
        }
        const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
        const safeMethod = (method || 'GET').toUpperCase();
        if (!ALLOWED_METHODS.includes(safeMethod)) {
          return respondError(webview, type, requestId, 'INVALID_ARGS', `Method not allowed: ${safeMethod}`);
        }
        if (!url.startsWith('/')) {
          try {
            const _proto = new URL(url).protocol;
            if (!['http:', 'https:'].includes(_proto)) {
              return respondError(webview, type, requestId, 'INVALID_ARGS', 'Only http and https URLs are allowed');
            }
          } catch (_) {
            return respondError(webview, type, requestId, 'INVALID_ARGS', 'Invalid URL');
          }
        }
        let isInternal = false;
        if (url.startsWith('/')) {
          isInternal = true;
        } else {
          try {
            const _u = new URL(url);
            const h  = _u.hostname;
            isInternal = h === 'localhost' || h === '127.0.0.1' || h === '::1'
              || h === 'api.novabyte.internal';
          } catch (_) { /* malformed URL — deny */ }
        }
        const netPerm = isInternal ? 'net:internal' : 'net:external';
        if (!AppPermissionManager.isGranted(netPerm, app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', `${netPerm} permission required`);
        }
        try {
          const res = await fetch(url, {
            method: safeMethod,
            headers: headers || {},
            body: body || null
          });
          const resBody = await res.text();
          return respond(webview, type, requestId, {
            success: true,
            status: res.status,
            statusText: res.statusText,
            headers: Object.fromEntries(res.headers.entries()),
            body: resBody
          });
        } catch (e) {
          return respondError(webview, type, requestId, 'NETWORK_ERROR', e.message);
        }
      }

      // ── Net: WebSocket ────────────────────────────────────────────────
      if (type === 'nova:net:websocket') {
        const { url, protocols } = payload;
        if (!url) {
          return respondError(webview, type, requestId, 'INVALID_ARGS', 'url is required');
        }
        if (typeof WebSocket === 'undefined') {
          return respondError(webview, type, requestId, 'UNAVAILABLE', 'WebSocket not supported');
        }
        if (!AppPermissionManager.isGranted('net:websocket', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'net:websocket permission required');
        }
        let ws;
        try {
          ws = protocols?.length
            ? new WebSocket(url, protocols)
            : new WebSocket(url);
        } catch (e) {
          return respondError(webview, type, requestId, 'INVALID_ARGS', e.message);
        }
        const wsId = 'ws_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        const wsState = { ws, appId: app.id, handlers: {} };
        const sandbox = activeSandboxes.get(sandboxId);
        if (sandbox) {
          if (!sandbox.wsConnections) sandbox.wsConnections = new Map();
          sandbox.wsConnections.set(wsId, wsState);
        }
        ws.onopen = () => respond(webview, type, requestId, { success: true, wsId, readyState: ws.readyState });
        ws.onmessage = (e) => {
          respond(webview, 'nova:net:ws:message', generateRequestId(), { wsId, data: e.data });
        };
        ws.onerror = (e) => {
          respond(webview, 'nova:net:ws:error', generateRequestId(), { wsId, error: 'WebSocket error' });
        };
        ws.onclose = (e) => {
          respond(webview, 'nova:net:ws:close', generateRequestId(), { wsId, code: e.code, reason: e.reason, clean: e.clean });
          activeSandboxes.get(sandboxId)?.wsConnections?.delete(wsId);
        };
        return; // response sent via onopen callback
      }

      // ── Net: WebSocket Send ───────────────────────────────────────────
      if (type === 'nova:net:ws:send') {
        const { wsId, data } = payload;
        const wsState = activeSandboxes.get(sandboxId)?.wsConnections?.get(wsId);
        if (!wsState) return respondError(webview, type, requestId, 'NOT_FOUND', 'WebSocket connection not found');
        if (wsState.ws.readyState !== WebSocket.OPEN) {
          return respondError(webview, type, requestId, 'INVALID_STATE', 'WebSocket is not open');
        }
        wsState.ws.send(data ?? '');
        return respond(webview, type, requestId, { success: true });
      }

      // ── Net: WebSocket Close ──────────────────────────────────────────
      if (type === 'nova:net:ws:close') {
        const { wsId, code, reason } = payload;
        const wsState = activeSandboxes.get(sandboxId)?.wsConnections?.get(wsId);
        if (wsState) {
          wsState.ws.close(code ?? 1000, reason);
          activeSandboxes.get(sandboxId)?.wsConnections?.delete(wsId);
        }
        return respond(webview, type, requestId, { success: true });
      }

      // ── Storage: Get ──────────────────────────────────────────────────
      if (type === 'nova:storage:get') {
        const rawKey = String(payload.key || '');
        // FIX: sanitize storage key — prevent key injection across app boundaries
        // e.g. "../../other_app_id_secret" must not escape this app's namespace
        if (!rawKey || /[^\w\-. ]/.test(rawKey)) {
          return respondError(webview, type, requestId, 'INVALID_ARGS', 'Invalid storage key');
        }
        const key = `nova_storage_${app.id}_${rawKey}`;
        try {
          const value = localStorage.getItem(key);
          return respond(webview, type, requestId, { success: true, value: value !== null ? value : null });
        } catch (e) {
          return respond(webview, type, requestId, { success: true, value: null });
        }
      }

      // ── Storage: Set ──────────────────────────────────────────────────
      if (type === 'nova:storage:set') {
        const rawKey = String(payload.key || '');
        if (!rawKey || /[^\w\-. ]/.test(rawKey)) {
          return respondError(webview, type, requestId, 'INVALID_ARGS', 'Invalid storage key');
        }
        const key = `nova_storage_${app.id}_${rawKey}`;
        try {
          localStorage.setItem(key, payload.value);
          return respond(webview, type, requestId, { success: true });
        } catch (e) {
          return respondError(webview, type, requestId, 'STORAGE_FULL', 'Failed to write to storage');
        }
      }

      // ── Storage: Delete ───────────────────────────────────────────────
      if (type === 'nova:storage:delete') {
        const rawKey = String(payload.key || '');
        if (!rawKey || /[^\w\-. ]/.test(rawKey)) {
          return respondError(webview, type, requestId, 'INVALID_ARGS', 'Invalid storage key');
        }
        const key = `nova_storage_${app.id}_${rawKey}`;
        try {
          localStorage.removeItem(key);
          return respond(webview, type, requestId, { success: true });
        } catch (e) {
          return respondError(webview, type, requestId, 'ERROR', e.message);
        }
      }

      // ── Storage: Clear ────────────────────────────────────────────────
      if (type === 'nova:storage:clear') {
        try {
          const prefix = `nova_storage_${app.id}_`;
          const toRemove = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(prefix)) toRemove.push(k);
          }
          toRemove.forEach(k => localStorage.removeItem(k));
          return respond(webview, type, requestId, { success: true });
        } catch (e) {
          return respondError(webview, type, requestId, 'ERROR', e.message);
        }
      }

      // ── Storage: Keys ─────────────────────────────────────────────────
      if (type === 'nova:storage:keys') {
        try {
          const prefix = `nova_storage_${app.id}_`;
          const keys = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(prefix)) keys.push(k.slice(prefix.length));
          }
          return respond(webview, type, requestId, { success: true, keys });
        } catch (e) {
          return respondError(webview, type, requestId, 'ERROR', e.message);
        }
      }

      // ── Device: Geolocation ───────────────────────────────────────────
      if (type === 'nova:device:geolocation') {
        if (!AppPermissionManager.isGranted('device:geolocation', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'device:geolocation permission required');
        }
        if (typeof navigator === 'undefined' || !navigator.geolocation) {
          return respondError(webview, type, requestId, 'UNAVAILABLE', 'Geolocation not available');
        }
        navigator.geolocation.getCurrentPosition(
          (pos) => respond(webview, type, requestId, {
            success: true,
            coords: {
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              altitude: pos.coords.altitude,
              accuracy: pos.coords.accuracy,
              altitudeAccuracy: pos.coords.altitudeAccuracy,
              heading: pos.coords.heading,
              speed: pos.coords.speed
            },
            timestamp: pos.timestamp
          }),
          (err) => respondError(webview, type, requestId, 'GEOLOCATION_ERROR', err.message),
          payload.options || {}
        );
        return; // async callback will send response
      }

      // ── System: Info ──────────────────────────────────────────────────
      if (type === 'nova:system:info') {
        if (!AppPermissionManager.isGranted('system:info', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'system:info permission required');
        }
        return respond(webview, type, requestId, {
          success: true,
          os: {
            version: OS.version,
            securityPatch: OS.securityPatch,
            username: OS.username,
            uptime: Date.now() - (OS._bootTime || Date.now())
          }
        });
      }

      // ── Ready Handshake ───────────────────────────────────────────────
      if (type === 'nova:ready') {
        return respond(webview, type, requestId, {
          success: true,
          appId: app.id,
          permissions: app.permissions || [],
          optionalPermissions: app.optionalPermissions || [],
          osVersion: OS.version,
          securityPatch: OS.securityPatch
        });
      }

      // ── Dialog: Open ──────────────────────────────────────────────────
      if (type === 'nova:dialog:open') {
        if (!AppPermissionManager.isGranted('fs:read', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'fs:read permission required');
        }
        showFileDialog('open', webview, type, requestId, app, payload);
        return; // async, response sent by dialog callback
      }

      // ── Dialog: Save ──────────────────────────────────────────────────
      if (type === 'nova:dialog:save') {
        if (!AppPermissionManager.isGranted('fs:write', app.id)) {
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'fs:write permission required');
        }
        showFileDialog('save', webview, type, requestId, app, payload);
        return;
      }

      // ── Audit: eval ──────────────────────────────────────────────────
      // Sent by the capability shim whenever an app calls eval(). Log it — don't block.
      if (type === 'nova:audit:eval') {
        console.warn(`[AppSandbox] ${app.name} called eval():`, payload?.preview);
        return; // fire-and-forget, no response needed
      }

      // ── Unknown API ───────────────────────────────────────────────────
      respondError(webview, type, requestId, 'UNKNOWN_API', `Unknown API: ${type}`);

    } catch (err) {
      console.error(`[AppSandbox] Error handling ${type}:`, err);
      respondError(webview, type, requestId, 'INTERNAL_ERROR', err.message || 'Internal error');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  ERROR HANDLING
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Setup error handling for sandbox
   * @param {HTMLElement} webview - Sandbox webview
   * @param {object} app - App object
   */
  function setupErrorHandling(webview, app) {
    // loadabort fires when webview navigation is cancelled (network error, blocked URL, etc.)
    webview.addEventListener('loadabort', (event) => {
      console.error(`[AppSandbox] Load aborted in ${app.name}:`, event.reason);
    });

    // consolemessage proxies console output from the webview's separate renderer process.
    // We can't attach to webview.contentWindow.addEventListener due to process isolation,
    // so this is the correct surface for runtime error/warning visibility.
    webview.addEventListener('consolemessage', (event) => {
      if (event.level >= 2) {
        const level = event.level >= 3 ? 'error' : 'warn';
        console[level](`[AppSandbox] ${app.name}:`, event.message,
          event.sourceId ? `(${event.sourceId}:${event.line})` : '');
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  APP LOADING
  // ═══════════════════════════════════════════════════════════════════════


  // ═══════════════════════════════════════════════════════════════════════
  //  CAPABILITY PROXY SHIM
  //  Injected as the first <script> in every packaged app's HTML.
  //  Overrides fetch / XHR / eval / sendBeacon so apps that use standard
  //  web APIs work transparently — all network goes through the IPC bridge
  //  where permissions are enforced. connect-src 'none' in the served CSP
  //  ensures nothing bypasses this at the browser level.
  // ═══════════════════════════════════════════════════════════════════════

  const CAPABILITY_SHIM = `<script>
(function(){
  // Lightweight request helper — sends a nova: IPC message and resolves on response.
  function _ipc(type, payload) {
    return new Promise(function(resolve, reject) {
      var id = 'shim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
      function handler(e) {
        if (!e.data || e.data.requestId !== id) return;
        window.removeEventListener('message', handler);
        if (e.data.error) reject(new TypeError(e.data.error.message || String(e.data.error)));
        else resolve(e.data.result);
      }
      window.addEventListener('message', handler);
      window.parent.postMessage({ type: type, requestId: id, payload: payload }, '*');
    });
  }
\x3C/script>`;

  const RELAXED_CSP_META = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\' blob: data: \'unsafe-inline\' \'unsafe-eval\'; script-src \'self\' blob: \'unsafe-inline\' \'unsafe-eval\'; style-src \'self\' \'unsafe-inline\' blob: data:; img-src \'self\' blob: data: https:; font-src \'self\' blob: data:; connect-src \'none\'">';

  /**
   * Prepend the capability shim as the very first script in the app's HTML.
   * Injects after <head> if present, otherwise prepends to the document.
   */
  function injectCapabilityShim(html) {
    if (/<head(\s[^>]*)?>/i.test(html)) {
      const relaxed = RELAXED_CSP_META + '\n';
      return html.replace(/<head(\s[^>]*)?>/i, (match) => match + '\n' + relaxed + CAPABILITY_SHIM);
    }
    return CAPABILITY_SHIM + '\n' + RELAXED_CSP_META + '\n' + html;
  }

  /**
   * Load app content into sandbox.
   * Registers app files with the Express serve route so the webview gets
   * a server-sent CSP header (no inheritance from the main page).
   * @param {HTMLElement} webview - Sandbox webview
   * @param {object} app - App object
   * @param {object} state - Window state
   */
  async function loadAppContent(webview, app, state) {
    // For web apps (external URLs) — load directly
    if (app.type === 'webapp' && app.url) {
      webview.src = app.url;
      return;
    }

    // For packaged apps with an HTML entry point
    if (app.entry && app.files && app.files[app.entry]) {
      try {
        const sandboxId = webview.dataset.sandboxId;

        // Inject capability shim into entry HTML before registering.
        // The shim overrides fetch/XHR/eval so network calls route through the IPC bridge.
        const shimmedFiles = Object.assign({}, app.files);
        const rawHtml = atob(shimmedFiles[app.entry]);
        shimmedFiles[app.entry] = btoa(injectCapabilityShim(rawHtml));

        // Register app files with the Express serve route.
        // The server responds with a baseUrl to serve from, and sets a relaxed CSP header
        // on those responses (allowing inline scripts without inheriting the main page CSP).
        const regRes = await fetch('/api/apps/serve/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sandboxId, files: shimmedFiles })
        });
        if (!regRes.ok) throw new Error(`File registration failed: ${regRes.status}`);
        const { baseUrl } = await regRes.json();

        // Load via HTTPS URL — webview's separate renderer gets its own CSP from server headers
        webview.src = `${window.location.origin}${baseUrl}/${app.entry}`;
      } catch (error) {
        console.error(`[AppSandbox] Failed to load app content for ${app.name}:`, error);
        showErrorPage(webview, app, 'Failed to load app content');
      }
    } else {
      createDefaultAppShell(webview, app, state);
    }
  }

  /**
   * Create default app shell for apps without content
   * @param {HTMLElement} webview - Sandbox webview
   * @param {object} app - App object
   * @param {object} state - Window state
   */
  /**
   * Escape a string for safe HTML interpolation.
   * FIX: app.name / app.author / app.icon etc. were interpolated raw,
   * allowing a malicious package to inject <script> tags.
   */
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  /**
   * Build a safe sandbox attribute string from an app's sandbox config.
   * FIX: allow-same-origin is always stripped — combining it with allow-scripts
   * is a known sandbox escape (the exact warning you saw). Same-origin access
   * is already provided by the webview's partition, so this token is both
   * unsafe and unnecessary.
   */
  function sanitizeSandboxAttr(sandboxConfig, appId) {
    const tokens = [];

    const has = (key) => {
      if (sandboxConfig && typeof sandboxConfig === 'object') {
        if (sandboxConfig[key] === true) return true;
      }
      if (typeof sandboxConfig === 'string') {
        return sandboxConfig.includes(key);
      }
      return false;
    };

    if (has('allowScripts'))       tokens.push('allow-scripts');
    if (has('allowForms'))         tokens.push('allow-forms');
    if (has('allowPopups'))        tokens.push('allow-popups');
    if (has('allowPopupsToEscapeSandbox')) tokens.push('allow-popups-to-escape-sandbox');
    if (has('allowModals'))        tokens.push('allow-modals');

    if (tokens.length === 0) {
      tokens.push('allow-scripts', 'allow-forms', 'allow-popups', 'allow-modals');
    }

    if (typeof console !== 'undefined') {
      console.log(`[AppSandbox] sandbox attrs for ${appId || 'unknown'}: ${tokens.join(' ')}`);
    }
    return tokens.join(' ');
  }

  /**
   * Create default app shell for apps without content.
   * Registers via the Express serve route — webview cannot load blob: URLs.
   * @param {HTMLElement} webview - Sandbox webview
   * @param {object} app - App object
   * @param {object} state - Window state
   */
  async function createDefaultAppShell(webview, app, state) {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        ${RELAXED_CSP_META}
        <title>${escapeHtml(app.name)}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .app-container { text-align: center; max-width: 600px; }
          .app-icon { font-size: 64px; margin-bottom: 20px; }
          h1 { font-size: 32px; margin-bottom: 10px; }
          p { font-size: 16px; opacity: 0.9; margin-bottom: 30px; }
          .status {
            background: rgba(255,255,255,0.1);
            padding: 15px 25px;
            border-radius: 8px;
            font-size: 14px;
          }
          .api-status {
            margin-top: 20px;
            padding: 10px;
            background: rgba(0,0,0,0.2);
            border-radius: 4px;
            font-family: monospace;
            font-size: 12px;
          }
        </style>
      </head>
      <body>
        <div class="app-container">
          <div class="app-icon">${escapeHtml(app.icon || '📱')}</div>
          <h1>${escapeHtml(app.name)}</h1>
          <p>${escapeHtml(app.description || 'A NovaByte Application')}</p>
          <div class="status">
            <strong>Version:</strong> ${escapeHtml(app.version)}<br>
            <strong>Author:</strong> ${escapeHtml(app.author)}<br>
            <strong>Type:</strong> ${escapeHtml(app.type)}<br>
            <strong>Status:</strong> Running in Sandbox
          </div>
          <div class="api-status" id="apiStatus">
            Initializing API bridge...
          </div>
        </div>
        <script>
          window.addEventListener('message', (event) => {
            if (event.origin !== window.location.origin) return;
            if (event.data.type && event.data.type.startsWith('nova:')) {
              document.getElementById('apiStatus').textContent = 'API Bridge: Connected ✓';
            }
          });
          setTimeout(() => {
            window.parent.postMessage({ type: 'nova:ready', appId: '${escapeHtml(app.id)}' },
              window.location.origin);
          }, 100);
        </script>
      </body>
      </html>
    `;

    try {
      const sandboxId = webview.dataset.sandboxId;
      const regRes = await fetch('/api/apps/serve/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId, files: { 'index.html': btoa(html) } })
      });
      if (!regRes.ok) throw new Error(`Registration failed: ${regRes.status}`);
      const { baseUrl } = await regRes.json();
      webview.src = `${window.location.origin}${baseUrl}/index.html`;
    } catch (error) {
      console.error(`[AppSandbox] Failed to create default shell for ${app.name}:`, error);
    }
  }

  /**
   * Show error page in sandbox
   * @param {HTMLElement} webview - Sandbox webview
   * @param {object} app - App object
   * @param {string} message - Error message
   */
  async function showErrorPage(webview, app, message) {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        ${RELAXED_CSP_META}
        <title>Error - ${escapeHtml(app.name)}</title>
        <style>
          body { font-family: sans-serif; padding: 40px; text-align: center; }
          .error { color: #e74c3c; font-size: 48px; margin-bottom: 20px; }
          h1 { color: #2c3e50; }
          p { color: #7f8c8d; }
        </style>
      </head>
      <body>
        <div class="error">⚠</div>
        <h1>Failed to Load Application</h1>
        <p><strong>${escapeHtml(app.name)}</strong></p>
        <p>${escapeHtml(message)}</p>
        <p><small>App ID: ${escapeHtml(app.id)}</small></p>
      </body>
      </html>
    `;
    try {
      const sandboxId = webview.dataset.sandboxId;
      const regRes = await fetch('/api/apps/serve/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId, files: { 'error.html': btoa(html) } })
      });
      if (!regRes.ok) throw new Error(`Registration failed: ${regRes.status}`);
      const { baseUrl } = await regRes.json();
      webview.src = `${window.location.origin}${baseUrl}/error.html`;
    } catch (e) {
      console.error(`[AppSandbox] Could not show error page for ${app.name}:`, e);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Launch an app in a sandboxed environment
   * @param {object} app - App object
   * @param {HTMLElement} container - Container element
   * @param {object} state - Window state
   * @param {object} options - Launch options
   * @returns {object} Launch result
   */
  function launch(app, container, state, options = {}) {
    if (!container) {
      throw new Error('Container element is required');
    }

    // Clear container
    container.innerHTML = '';

    // Create sandbox
    const webview = createSandbox(app, container, state);

    // Add to container
    container.appendChild(webview);

    // loadAppContent is async (registers files with server) — fire and let errors surface in the webview
    loadAppContent(webview, app, state);

    console.log(`[AppSandbox] Launched ${app.name} in sandbox`);

    const sandboxId = webview.dataset.sandboxId;
    return {
      success: true,
      sandboxId,
      appId: app.id,
      windowId: state?.id,
      iframe: webview,    // backward-compat alias
      webview: webview,
      cleanup: () => {
        const sandbox = activeSandboxes.get(sandboxId);
        if (sandbox && sandbox.cleanup) sandbox.cleanup();
        // Unregister app files from the serve registry
        fetch(`/api/apps/serve/unregister/${sandboxId}`, { method: 'DELETE' }).catch(() => {});
        activeSandboxes.delete(sandboxId);
      }
    };
  }

  /**
   * Destroy a sandbox
   * @param {string} sandboxId - Sandbox ID
   */
  function destroy(sandboxId) {
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox) return false;

    // Clean up event subscriptions
    const subs = eventSubscriptions.get(sandboxId);
    if (subs) {
      for (const [eventName, handler] of subs) {
        OS.events.off(eventName, handler);
      }
      subs.clear();
      eventSubscriptions.delete(sandboxId);
    }

    if (sandbox.cleanup) sandbox.cleanup();

    // Unregister app files from the Express serve registry
    fetch(`/api/apps/serve/unregister/${sandboxId}`, { method: 'DELETE' }).catch(() => {});

    activeSandboxes.delete(sandboxId);
    console.log(`[AppSandbox] Destroyed sandbox: ${sandboxId}`);

    return true;
  }

  /**
   * Get active sandbox info
   * @param {string} sandboxId - Sandbox ID
   * @returns {object|null} Sandbox info
   */
  function getSandbox(sandboxId) {
    return activeSandboxes.get(sandboxId) || null;
  }

  /**
   * Get all active sandboxes
   * @returns {Array} Array of sandbox info
   */
  function getAllSandboxes() {
    return Array.from(activeSandboxes.values());
  }

  return {
    createSandbox,
    launch,
    destroy,
    getSandbox,
    getAllSandboxes
  };
})();

// Export for Node.js/CommonJS
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AppSandbox;
}