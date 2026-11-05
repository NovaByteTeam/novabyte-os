/**
 * NovaByte OS - App Sandbox
 * ────────────────────────────────────────────────────────────
 * Creates secure execution environments for apps using
 * sandboxed iframes with strict CSP policies.
 *
 * @module js/app-sandbox
 */

const AppSandbox = (() => {
  const activeSandboxes = new Map();
  const API_BRIDGE_NAME = 'NovaByteAPI';
  const eventSubscriptions = new Map(); // sandboxId -> Map(eventName -> handler)

  /**
   * Create a sandboxed iframe for app execution
   * @param {object} app - App object
   * @param {HTMLElement} container - Container element
   * @param {object} state - Window state
   * @returns {HTMLIFrameElement} Sandboxed iframe
   */
  function createSandbox(app, container, state) {
    const iframe = document.createElement('iframe');

    // Security: strict sandboxing
    const sandboxAttrs = [
      'allow-same-origin',
      'allow-scripts',
      'allow-forms',
      'allow-modals',
      'allow-popups',
      'allow-downloads'
    ];

    // Apply app-specific sandbox restrictions
    if (app.sandbox) {
      // Only remove allow-same-origin if explicitly disabled AND not using blob URLs
      // Blob URLs need allow-same-origin for localStorage access
      if (app.sandbox.allowSameOrigin === false && app.type !== 'webapp' && !app.entry) {
        const idx = sandboxAttrs.indexOf('allow-same-origin');
        if (idx > -1) sandboxAttrs.splice(idx, 1);
      }
      if (app.sandbox.allowScripts === false) {
        const idx = sandboxAttrs.indexOf('allow-scripts');
        if (idx > -1) sandboxAttrs.splice(idx, 1);
      }
      if (app.sandbox.allowForms === false) {
        const idx = sandboxAttrs.indexOf('allow-forms');
        if (idx > -1) sandboxAttrs.splice(idx, 1);
      }
      if (app.sandbox.allowPopups === false) {
        const idx = sandboxAttrs.indexOf('allow-popups');
        if (idx > -1) sandboxAttrs.splice(idx, 1);
      }
    }

    iframe.sandbox = sandboxAttrs.join(' ');

    // Security: Content Security Policy
    const csp = [
      "default-src 'self' blob: data:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
      "style-src 'self' 'unsafe-inline' blob:",
      "img-src 'self' blob: data: https:",
      "font-src 'self' blob: data:",
      "connect-src 'self' blob: data:",
      "frame-src 'self' blob: data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ');

    iframe.csp = csp;

    // Styling
    iframe.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
      background: white;
      display: flex;
      flex-direction: column;
    `;

    // Security: prevent framing
    iframe.allow = "fullscreen; camera; microphone";

    // Store reference
    const sandboxId = `sandbox_${app.id}_${Date.now()}`;
    iframe.dataset.sandboxId = sandboxId;
    iframe.dataset.appId = app.id;

    activeSandboxes.set(sandboxId, {
      appId: app.id,
      iframe: iframe,
      created: new Date().toISOString(),
      state: state,
      windowId: state?.id
    });

    eventSubscriptions.set(sandboxId, new Map());

    // Setup API bridge
    setupAPIBridge(iframe, app, sandboxId);

    // Setup error handling
    setupErrorHandling(iframe, app);

    console.log(`[AppSandbox] Created sandbox for ${app.name} (${sandboxId})`);

    return iframe;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  RESPONSE HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Send a response back to the sandboxed app
   */
  function respond(iframe, type, requestId, result, error = null) {
    try {
      iframe.contentWindow.postMessage({
        type: `${type}:response`,
        requestId,
        result,
        error
      }, '*');
    } catch (e) {
      console.error(`[AppSandbox] Failed to respond to ${type}:`, e);
    }
  }

  function respondError(iframe, type, requestId, code, message) {
    respond(iframe, type, requestId, null, { code, message });
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
  function showFileDialog(mode, iframe, type, requestId, app, payload) {
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
      respond(iframe, type, requestId, { cancelled: true });
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
        respond(iframe, type, requestId, {
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
          respond(iframe, type, requestId, {
            success: true,
            file: {
              id: newNode.id,
              name: newNode.name,
              path: FS.getPath(newNode.id)
            }
          });
        } catch (e) {
          overlay.remove();
          respondError(iframe, type, requestId, 'WRITE_ERROR', e.message || 'Failed to write file');
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
   * @param {HTMLIFrameElement} iframe - Sandbox iframe
   * @param {object} app - App object
   * @param {string} sandboxId - Sandbox ID
   */
  function setupAPIBridge(iframe, app, sandboxId) {
    const messageHandler = (event) => {
      // Security: verify message origin
      if (event.source !== iframe.contentWindow) {
        return;
      }

      const { type, payload, requestId } = event.data;

      if (!type || !type.startsWith('nova:')) {
        return;
      }

      const sandbox = activeSandboxes.get(sandboxId);
      handleAPICall(type, payload, requestId, app, iframe, sandbox);
    };

    window.addEventListener('message', messageHandler);

    // Store cleanup
    const sandbox = activeSandboxes.get(sandboxId);
    if (sandbox) {
      sandbox.cleanup = () => {
        window.removeEventListener('message', messageHandler);
        // Clean up event subscriptions
        const subs = eventSubscriptions.get(sandboxId);
        if (subs) {
          for (const [eventName, handler] of subs) {
            OS.events.off(eventName, handler);
          }
          subs.clear();
        }
        eventSubscriptions.delete(sandboxId);
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
   * @param {HTMLIFrameElement} iframe - Sandbox iframe
   * @param {object} sandbox - Sandbox info object
   */
  async function handleAPICall(type, payload, requestId, app, iframe, sandbox) {
    const windowId = sandbox?.windowId;

    try {
      // ── FS: Read ──────────────────────────────────────────────────────
      if (type === 'nova:fs:read') {
        if (!AppPermissionManager.isGranted('fs:read', app.id)) {
          return respondError(iframe, type, requestId, 'PERMISSION_DENIED', 'fs:read permission required');
        }
        const node = resolveFile(payload);
        if (!node) return respondError(iframe, type, requestId, 'NOT_FOUND', 'File or folder not found');
        if (node.type === 'folder') {
          const children = FS.listDir(node.id);
          return respond(iframe, type, requestId, {
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
        return respond(iframe, type, requestId, {
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
          return respondError(iframe, type, requestId, 'PERMISSION_DENIED', 'fs:write permission required');
        }
        const { path, content, mimeType } = payload;
        if (!path || content === undefined) {
          return respondError(iframe, type, requestId, 'INVALID_ARGS', 'path and content are required');
        }
        let node = FS.getByPath(path);
        if (node) {
          if (node.type === 'folder') {
            return respondError(iframe, type, requestId, 'INVALID_OPERATION', 'Cannot write to a folder');
          }
          await FS.writeFile(node.id, content);
          return respond(iframe, type, requestId, { success: true, id: node.id });
        }
        const parts = path.split('/').filter(Boolean);
        const fileName = parts.pop();
        const parentPath = '/' + parts.join('/');
        const parent = parts.length > 0 ? FS.getByPath(parentPath) : FS.files.get(FS.rootId);
        if (!parent || parent.type !== 'folder') {
          return respondError(iframe, type, requestId, 'NOT_FOUND', 'Parent folder not found');
        }
        const newNode = await FS.createFile(parent.id, fileName,
          typeof content === 'string' ? content : JSON.stringify(content),
          mimeType || 'text/plain');
        return respond(iframe, type, requestId, { success: true, id: newNode.id, path: FS.getPath(newNode.id) });
      }

      // ── FS: Delete ────────────────────────────────────────────────────
      if (type === 'nova:fs:delete') {
        if (!AppPermissionManager.isGranted('fs:delete', app.id)) {
          return respondError(iframe, type, requestId, 'PERMISSION_DENIED', 'fs:delete permission required');
        }
        const node = resolveFile(payload);
        if (!node) return respondError(iframe, type, requestId, 'NOT_FOUND', 'File not found');
        if (payload.permanent) {
          await FS.permanentDelete(node.id);
        } else {
          await FS.deleteToTrash(node.id);
        }
        return respond(iframe, type, requestId, { success: true });
      }

      // ── FS: List ──────────────────────────────────────────────────────
      if (type === 'nova:fs:list') {
        if (!AppPermissionManager.isGranted('fs:read', app.id)) {
          return respondError(iframe, type, requestId, 'PERMISSION_DENIED', 'fs:read permission required');
        }
        const node = resolveFile(payload);
        if (!node) return respondError(iframe, type, requestId, 'NOT_FOUND', 'Folder not found');
        if (node.type !== 'folder') {
          return respondError(iframe, type, requestId, 'INVALID_OPERATION', 'Path is not a folder');
        }
        const children = FS.listDir(node.id);
        return respond(iframe, type, requestId, {
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
          return respondError(iframe, type, requestId, 'PERMISSION_DENIED', 'fs:write permission required');
        }
        const { path, name } = payload;
        if (!name) {
          return respondError(iframe, type, requestId, 'INVALID_ARGS', 'name is required');
        }
        let parent;
        if (path) {
          parent = FS.getByPath(path);
        } else {
          parent = FS.files.get(FS.rootId);
        }
        if (!parent || parent.type !== 'folder') {
          return respondError(iframe, type, requestId, 'NOT_FOUND', 'Parent folder not found');
        }
        const newFolder = await FS.createFolder(parent.id, name);
        return respond(iframe, type, requestId, { success: true, id: newFolder.id, path: FS.getPath(newFolder.id) });
      }

      // ── FS: Stat ──────────────────────────────────────────────────────
      if (type === 'nova:fs:stat') {
        if (!AppPermissionManager.isGranted('fs:read', app.id)) {
          return respondError(iframe, type, requestId, 'PERMISSION_DENIED', 'fs:read permission required');
        }
        const node = resolveFile(payload);
        if (!node) return respondError(iframe, type, requestId, 'NOT_FOUND', 'File not found');
        return respond(iframe, type, requestId, {
          success: true,
          stat: fileToJSON(node)
        });
      }

      // ── FS: Rename ────────────────────────────────────────────────────
      if (type === 'nova:fs:rename') {
        if (!AppPermissionManager.isGranted('fs:write', app.id)) {
          return respondError(iframe, type, requestId, 'PERMISSION_DENIED', 'fs:write permission required');
        }
        const node = resolveFile(payload);
        if (!node) return respondError(iframe, type, requestId, 'NOT_FOUND', 'File not found');
        if (!payload.name) {
          return respondError(iframe, type, requestId, 'INVALID_ARGS', 'name is required');
        }
        await FS.rename(node.id, payload.name);
        return respond(iframe, type, requestId, { success: true, name: payload.name });
      }

      // ── FS: Move ──────────────────────────────────────────────────────
      if (type === 'nova:fs:move') {
        if (!AppPermissionManager.isGranted('fs:write', app.id)) {
          return respondError(iframe, type, requestId, 'PERMISSION_DENIED', 'fs:write permission required');
        }
        const node = resolveFile(payload);
        if (!node) return respondError(iframe, type, requestId, 'NOT_FOUND', 'File not found');
        const destParent = payload.destPath ? FS.getByPath(payload.destPath) : null;
        if (!destParent || destParent.type !== 'folder') {
          return respondError(iframe, type, requestId, 'NOT_FOUND', 'Destination folder not found');
        }
        await FS.move(node.id, destParent.id);
        return respond(iframe, type, requestId, { success: true, path: FS.getPath(node.id) });
      }

      // ── Notifications: Show ───────────────────────────────────────────
      if (type === 'nova:notifications:show') {
        if (!AppPermissionManager.isGranted('device:notifications', app.id)) {
          return respondError(iframe, type, requestId, 'PERMISSION_DENIED', 'device:notifications permission required');
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
        return respond(iframe, type, requestId, { success: true });
      }

      // ── Notifications: Clear ──────────────────────────────────────────
      if (type === 'nova:notifications:clear') {
        if (!AppPermissionManager.isGranted('device:notifications', app.id)) {
          return respondError(iframe, type, requestId, 'PERMISSION_DENIED', 'device:notifications permission required');
        }
        if (typeof Notify !== 'undefined' && typeof Notify.clearAll === 'function') {
          Notify.clearAll();
        }
        return respond(iframe, type, requestId, { success: true });
      }

      // ── Settings: Get ─────────────────────────────────────────────────
      if (type === 'nova:settings:get') {
        const value = OS?.settings?.get(payload.key);
        return respond(iframe, type, requestId, { success: true, value });
      }

      // ── Settings: Set ─────────────────────────────────────────────────
      if (type === 'nova:settings:set') {
        if (!AppPermissionManager.isGranted('system:settings', app.id)) {
          return respondError(iframe, type, requestId, 'PERMISSION_DENIED', 'system:settings permission required');
        }
        OS?.settings?.set(payload.key, payload.value);
        return respond(iframe, type, requestId, { success: true });
      }

      // ── Request Permission ────────────────────────────────────────────
      if (type === 'nova:request-permission') {
        const { permission } = payload;
        if (!permission) {
          return respondError(iframe, type, requestId, 'INVALID_ARGS', 'permission is required');
        }
        try {
          const granted = await AppPermissionManager.requestPermission(permission, app.id, {
            reason: payload.reason || `${app.name} wants to access this permission.`,
            permanent: payload.permanent !== false
          });
          return respond(iframe, type, requestId, { granted });
        } catch (e) {
          return respondError(iframe, type, requestId, 'ERROR', e.message || 'Permission request failed');
        }
      }

      // ── Window: Close ─────────────────────────────────────────────────
      if (type === 'nova:window:close') {
        if (windowId && typeof WM.closeWindow === 'function') {
          WM.closeWindow(windowId);
        }
        return respond(iframe, type, requestId, { success: true });
      }

      // ── Window: Minimize ──────────────────────────────────────────────
      if (type === 'nova:window:minimize') {
        if (windowId && typeof WM.minimizeWindow === 'function') {
          WM.minimizeWindow(windowId);
        }
        return respond(iframe, type, requestId, { success: true });
      }

      // ── Window: Maximize / Restore ────────────────────────────────────
      if (type === 'nova:window:maximize') {
        if (windowId && typeof WM.toggleMaximize === 'function') {
          WM.toggleMaximize(windowId);
        }
        return respond(iframe, type, requestId, { success: true });
      }

      // ── Window: Set Title ─────────────────────────────────────────────
      if (type === 'nova:window:setTitle') {
        if (windowId) {
          const state = OS.windows.get(windowId);
          if (state && state.titleText) {
            state.titleText.textContent = payload.title || '';
          }
        }
        return respond(iframe, type, requestId, { success: true });
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
        return respond(iframe, type, requestId, { success: true });
      }

      // ── Window: Get State ─────────────────────────────────────────────
      if (type === 'nova:window:getState') {
        const state = windowId ? OS.windows.get(windowId) : null;
        if (state) {
          return respond(iframe, type, requestId, {
            success: true,
            id: state.id,
            x: state.x, y: state.y,
            width: state.width, height: state.height,
            maximized: !!state.maximized,
            minimized: !!state.minimized
          });
        }
        return respondError(iframe, type, requestId, 'NOT_FOUND', 'Window not found');
      }

      // ── Clipboard: Read ───────────────────────────────────────────────
      if (type === 'nova:clipboard:read') {
        return respond(iframe, type, requestId, {
          success: true,
          data: OS.clipboard || null
        });
      }

      // ── Clipboard: Write ──────────────────────────────────────────────
      if (type === 'nova:clipboard:write') {
        if (!AppPermissionManager.isGranted('fs:read', app.id)) {
          return respondError(iframe, type, requestId, 'PERMISSION_DENIED', 'fs:read permission required for clipboard access');
        }
        OS.clipboard = payload.data || '';
        if (!OS.clipboardHistory) OS.clipboardHistory = [];
        if (typeof payload.data === 'string' && !OS.clipboardHistory.includes(payload.data)) {
          OS.clipboardHistory.unshift(payload.data);
          if (OS.clipboardHistory.length > 30) OS.clipboardHistory.pop();
        }
        return respond(iframe, type, requestId, { success: true });
      }

      // ── App: Launch ───────────────────────────────────────────────────
      if (type === 'nova:app:launch') {
        const { appId, options } = payload;
        if (!appId) {
          return respondError(iframe, type, requestId, 'INVALID_ARGS', 'appId is required');
        }
        try {
          if (typeof WM.createWindow === 'function') {
            const win = WM.createWindow(appId, options || {});
            return respond(iframe, type, requestId, { success: !!win, windowId: win ? win.id : null });
          }
          return respondError(iframe, type, requestId, 'UNAVAILABLE', 'Window manager not available');
        } catch (e) {
          return respondError(iframe, type, requestId, 'ERROR', e.message);
        }
      }

      // ── App: Info ─────────────────────────────────────────────────────
      if (type === 'nova:app:info') {
        return respond(iframe, type, requestId, {
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
        const { event } = payload;
        if (!event) {
          return respondError(iframe, type, requestId, 'INVALID_ARGS', 'event name is required');
        }
        const subs = eventSubscriptions.get(sandboxId);
        if (subs && subs.has(event)) {
          return respondError(iframe, type, requestId, 'ALREADY_SUBSCRIBED', `Already subscribed to '${event}'`);
        }
        const handler = (data) => {
          respond(iframe, 'nova:events:event', generateRequestId(), { event, data });
        };
        OS.events.on(event, handler);
        if (subs) subs.set(event, handler);
        return respond(iframe, type, requestId, { success: true, subscribed: event });
      }

      // ── Events: Unsubscribe ───────────────────────────────────────────
      if (type === 'nova:events:unsubscribe') {
        const { event } = payload;
        const subs = eventSubscriptions.get(sandboxId);
        if (subs && subs.has(event)) {
          const handler = subs.get(event);
          OS.events.off(event, handler);
          subs.delete(event);
        }
        return respond(iframe, type, requestId, { success: true, unsubscribed: event });
      }

      // ── Net: Fetch ────────────────────────────────────────────────────
      if (type === 'nova:net:fetch') {
        const { url, method, headers, body } = payload;
        if (!url) {
          return respondError(iframe, type, requestId, 'INVALID_ARGS', 'url is required');
        }
        // Determine permission level
        const isInternal = url.startsWith('https://api.novabyte.internal') ||
                           url.startsWith('http://localhost') ||
                           url.startsWith('/');
        const netPerm = isInternal ? 'net:internal' : 'net:external';
        if (!AppPermissionManager.isGranted(netPerm, app.id)) {
          return respondError(iframe, type, requestId, 'PERMISSION_DENIED', `${netPerm} permission required`);
        }
        try {
          const res = await fetch(url, {
            method: method || 'GET',
            headers: headers || {},
            body: body || null
          });
          const resBody = await res.text();
          return respond(iframe, type, requestId, {
            success: true,
            status: res.status,
            statusText: res.statusText,
            headers: Object.fromEntries(res.headers.entries()),
            body: resBody
          });
        } catch (e) {
          return respondError(iframe, type, requestId, 'NETWORK_ERROR', e.message);
        }
      }

      // ── Storage: Get ──────────────────────────────────────────────────
      if (type === 'nova:storage:get') {
        const key = `nova_storage_${app.id}_${payload.key}`;
        try {
          const value = localStorage.getItem(key);
          return respond(iframe, type, requestId, { success: true, value: value !== null ? value : null });
        } catch (e) {
          return respond(iframe, type, requestId, { success: true, value: null });
        }
      }

      // ── Storage: Set ──────────────────────────────────────────────────
      if (type === 'nova:storage:set') {
        const key = `nova_storage_${app.id}_${payload.key}`;
        try {
          localStorage.setItem(key, payload.value);
          return respond(iframe, type, requestId, { success: true });
        } catch (e) {
          return respondError(iframe, type, requestId, 'STORAGE_FULL', 'Failed to write to storage');
        }
      }

      // ── Storage: Delete ───────────────────────────────────────────────
      if (type === 'nova:storage:delete') {
        const key = `nova_storage_${app.id}_${payload.key}`;
        try {
          localStorage.removeItem(key);
          return respond(iframe, type, requestId, { success: true });
        } catch (e) {
          return respondError(iframe, type, requestId, 'ERROR', e.message);
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
          return respond(iframe, type, requestId, { success: true });
        } catch (e) {
          return respondError(iframe, type, requestId, 'ERROR', e.message);
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
          return respond(iframe, type, requestId, { success: true, keys });
        } catch (e) {
          return respondError(iframe, type, requestId, 'ERROR', e.message);
        }
      }

      // ── Device: Geolocation ───────────────────────────────────────────
      if (type === 'nova:device:geolocation') {
        if (!AppPermissionManager.isGranted('device:geolocation', app.id)) {
          return respondError(iframe, type, requestId, 'PERMISSION_DENIED', 'device:geolocation permission required');
        }
        if (typeof navigator === 'undefined' || !navigator.geolocation) {
          return respondError(iframe, type, requestId, 'UNAVAILABLE', 'Geolocation not available');
        }
        navigator.geolocation.getCurrentPosition(
          (pos) => respond(iframe, type, requestId, {
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
          (err) => respondError(iframe, type, requestId, 'GEOLOCATION_ERROR', err.message),
          payload.options || {}
        );
        return; // async callback will send response
      }

      // ── System: Info ──────────────────────────────────────────────────
      if (type === 'nova:system:info') {
        return respond(iframe, type, requestId, {
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
        return respond(iframe, type, requestId, {
          success: true,
          appId: app.id,
          permissions: app.permissions || [],
          optionalPermissions: app.optionalPermissions || [],
          osVersion: OS.version,
          securityPatch: OS.securityPatch
        });
      }

      // ── Security: Check (passthrough) ─────────────────────────────────
      if (type === 'nova:security:check') {
        if (typeof NovaSecurityAPI !== 'undefined') {
          const compliant = NovaSecurityAPI.meetsRequirement(payload.minPatchDate);
          return respond(iframe, type, requestId, {
            compliant,
            current: NovaSecurityAPI.getCurrentPatchString(),
            required: payload.minPatchDate
          });
        }
        return respondError(iframe, type, requestId, 'UNAVAILABLE', 'Security API not available');
      }

      // ── Dialog: Open ──────────────────────────────────────────────────
      if (type === 'nova:dialog:open') {
        if (!AppPermissionManager.isGranted('fs:read', app.id)) {
          return respondError(iframe, type, requestId, 'PERMISSION_DENIED', 'fs:read permission required');
        }
        showFileDialog('open', iframe, type, requestId, app, payload);
        return; // async, response sent by dialog callback
      }

      // ── Dialog: Save ──────────────────────────────────────────────────
      if (type === 'nova:dialog:save') {
        if (!AppPermissionManager.isGranted('fs:write', app.id)) {
          return respondError(iframe, type, requestId, 'PERMISSION_DENIED', 'fs:write permission required');
        }
        showFileDialog('save', iframe, type, requestId, app, payload);
        return;
      }

      // ── Unknown API ───────────────────────────────────────────────────
      respondError(iframe, type, requestId, 'UNKNOWN_API', `Unknown API: ${type}`);

    } catch (err) {
      console.error(`[AppSandbox] Error handling ${type}:`, err);
      respondError(iframe, type, requestId, 'INTERNAL_ERROR', err.message || 'Internal error');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  ERROR HANDLING
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Setup error handling for sandbox
   * @param {HTMLIFrameElement} iframe - Sandbox iframe
   * @param {object} app - App object
   */
  function setupErrorHandling(iframe, app) {
    iframe.addEventListener('error', (event) => {
      console.error(`[AppSandbox] Error in ${app.name}:`, event.error);
    });

    iframe.contentWindow.addEventListener('error', (event) => {
      console.error(`[AppSandbox] Runtime error in ${app.name}:`, event.error);
    });

    iframe.contentWindow.addEventListener('unhandledrejection', (event) => {
      console.error(`[AppSandbox] Unhandled rejection in ${app.name}:`, event.reason);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  APP LOADING
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Load app content into sandbox
   * @param {HTMLIFrameElement} iframe - Sandbox iframe
   * @param {object} app - App object
   * @param {object} state - Window state
   */
  function loadAppContent(iframe, app, state) {
    // For web apps (external URLs)
    if (app.type === 'webapp' && app.url) {
      iframe.src = app.url;
      return;
    }

    // For packaged apps with HTML entry point
    if (app.entry && app.files && app.files[app.entry]) {
      try {
        const htmlContent = atob(app.files[app.entry]);
        const blob = new Blob([htmlContent], { type: 'text/html' });
        iframe.src = URL.createObjectURL(blob);
      } catch (error) {
        console.error(`[AppSandbox] Failed to load app content for ${app.name}:`, error);
        showErrorPage(iframe, app, 'Failed to load app content');
      }
    } else {
      // Default: create a simple app shell
      createDefaultAppShell(iframe, app, state);
    }
  }

  /**
   * Create default app shell for apps without content
   * @param {HTMLIFrameElement} iframe - Sandbox iframe
   * @param {object} app - App object
   * @param {object} state - Window state
   */
  function createDefaultAppShell(iframe, app, state) {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${app.name}</title>
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
          <div class="app-icon">${app.icon || '📱'}</div>
          <h1>${app.name}</h1>
          <p>${app.description || 'A NovaByte OS Application'}</p>
          <div class="status">
            <strong>Version:</strong> ${app.version}<br>
            <strong>Author:</strong> ${app.author}<br>
            <strong>Type:</strong> ${app.type}<br>
            <strong>Status:</strong> Running in Sandbox
          </div>
          <div class="api-status" id="apiStatus">
            Initializing API bridge...
          </div>
        </div>
        <script>
          // Safe localStorage wrapper for sandboxed contexts
          (function() {
            if (typeof localStorage === 'undefined') {
              const memStore = new Map();
              window.localStorage = {
                getItem: (key) => memStore.get(key) ?? null,
                setItem: (key, value) => { memStore.set(key, String(value)); },
                removeItem: (key) => { memStore.delete(key); },
                clear: () => { memStore.clear(); },
                key: (index) => Array.from(memStore.keys())[index] ?? null,
                get length() { return memStore.size; }
              };
            } else {
              // Wrap existing localStorage with error handling
              const originalLocalStorage = localStorage;
              const memStore = new Map();
              let useMemory = false;
              
              try {
                originalLocalStorage.setItem('__test__', '1');
                originalLocalStorage.removeItem('__test__');
              } catch (e) {
                useMemory = true;
              }
              
              if (useMemory) {
                window.localStorage = {
                  getItem: (key) => memStore.get(key) ?? null,
                  setItem: (key, value) => { memStore.set(key, String(value)); },
                  removeItem: (key) => { memStore.delete(key); },
                  clear: () => { memStore.clear(); },
                  key: (index) => Array.from(memStore.keys())[index] ?? null,
                  get length() { return memStore.size; }
                };
              }
            }
          })();

          // Test API bridge
          window.addEventListener('message', (event) => {
            if (event.data.type && event.data.type.startsWith('nova:')) {
              document.getElementById('apiStatus').textContent =
                'API Bridge: Connected ✓';
            }
          });

          // Request API access
          setTimeout(() => {
            window.parent.postMessage({
              type: 'nova:ready',
              appId: '${app.id}'
            }, '*');
          }, 100);
        </script>
      </body>
      </html>
    `;

    const blob = new Blob([html], { type: 'text/html' });
    iframe.src = URL.createObjectURL(blob);
  }

  /**
   * Show error page in sandbox
   * @param {HTMLIFrameElement} iframe - Sandbox iframe
   * @param {object} app - App object
   * @param {string} message - Error message
   */
  function showErrorPage(iframe, app, message) {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Error - ${app.name}</title>
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
        <p><strong>${app.name}</strong></p>
        <p>${message}</p>
        <p><small>App ID: ${app.id}</small></p>
      </body>
      </html>
    `;
    const blob = new Blob([html], { type: 'text/html' });
    iframe.src = URL.createObjectURL(blob);
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
    const iframe = createSandbox(app, container, state);

    // Add to container
    container.appendChild(iframe);

    // Load app content
    loadAppContent(iframe, app, state);

    console.log(`[AppSandbox] Launched ${app.name} in sandbox`);

    return {
      success: true,
      sandboxId: iframe.dataset.sandboxId,
      appId: app.id,
      windowId: state?.id,
      iframe: iframe,
      cleanup: () => {
        const sandbox = activeSandboxes.get(iframe.dataset.sandboxId);
        if (sandbox && sandbox.cleanup) {
          sandbox.cleanup();
        }
        if (iframe.src && iframe.src.startsWith('blob:')) {
          URL.revokeObjectURL(iframe.src);
        }
        activeSandboxes.delete(iframe.dataset.sandboxId);
      }
    };
  }

  /**
   * Destroy a sandbox
   * @param {string} sandboxId - Sandbox ID
   */
  function destroy(sandboxId) {
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox) {
      return false;
    }

    // Clean up event subscriptions
    const subs = eventSubscriptions.get(sandboxId);
    if (subs) {
      for (const [eventName, handler] of subs) {
        OS.events.off(eventName, handler);
      }
      subs.clear();
      eventSubscriptions.delete(sandboxId);
    }

    if (sandbox.cleanup) {
      sandbox.cleanup();
    }

    if (sandbox.iframe && sandbox.iframe.src.startsWith('blob:')) {
      URL.revokeObjectURL(sandbox.iframe.src);
    }

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
