/**
 * SystemDialogs  —  NovaByte OS
 * ─────────────────────────────────────────────────────────────────────────
 * Filesystem picker dialog. Browses the host disk via Node's fs
 * module — no GTK or native OS picker. Rendered entirely in the
 * NovaByte shell window. Windows-Explorer-style layout: a quick-access
 * sidebar, a breadcrumb address bar that toggles into an editable path
 * field, and in-dialog "New folder" / "New file" creation. The folder
 * the user last visited is remembered per account via the HKNU
 * (per-user) registry hive.
 *
 * Usage:
 *   // Open a file — resolves to null if cancelled, otherwise:
 *   // { path, name, content, mimeType, size }
 *   const file = await SystemDialogs.open({
 *     title: 'Open File',
 *     filter: (name, isDir) => isDir || name.endsWith('.txt'),
 *   });
 *
 *   // Folder — pass directory: true; resolves { path, name } or null.
 *   const dir = await SystemDialogs.open({ title: "Choose Folder", directory: true });
 *
 *   // Multiple files — pass multiple: true; click toggles, resolves an array or null.
 *
 *   // Save — resolves to null if cancelled, otherwise:
 *   // { path, name }  (caller writes the file)
 *   const dest = await SystemDialogs.save({
 *     title: 'Save As',
 *     suggestedName: 'untitled.txt',
 *   });
 */
const SystemDialogs = (() => {
  'use strict';

  // Localised strings — NovaI18n core engine (js/core/core/i18n.js)
  // evaluated before this service script; identity fallback for
  // stripped-down host contexts.
  var _t = (typeof window !== 'undefined' && typeof window._t === 'function')
    ? window._t
    : (key, vars) => key;

  const fs   = require('fs');
  const path = require('path');
  const os   = require('os');

  const DEFAULT_START = os.homedir() || '/home/nbosp';

  function getDefaultStartPath() {
    try {
      if (typeof FS !== 'undefined' && FS.rootId && typeof FS.getPath === 'function') {
        const userRoot = FS.getPath(FS.rootId);
        if (typeof userRoot === 'string' && path.isAbsolute(userRoot)) return userRoot;
      }
    } catch (error) {
      console.warn('[SystemDialogs] Could not resolve the mounted account root:', error);
    }
    return DEFAULT_START;
  }

  // ── Per-user "last directory" memory ──────────────────────────────────
  // HKNU is the per-user registry hive (mounted per login by the session
  // manager), so a value written there is inherently per-user. Every call
  // is guarded: without a registry engine (stripped-down host contexts,
  // tests) the feature degrades silently.
  const LAST_DIR_KEY = 'HKNU/shell/sysdialog/lastDir';

  function persistLastDir(dirPath) {
    try {
      const reg = (typeof window !== 'undefined') ? window.NovaRegistry : null;
      if (reg && typeof reg.set === 'function' && typeof dirPath === 'string' && dirPath) {
        reg.set(LAST_DIR_KEY, dirPath, { source: 'sysdialog' });
      }
    } catch (_) { /* fail silent — memory is a nicety, never a blocker */ }
  }

  function readLastDir() {
    try {
      const reg = (typeof window !== 'undefined') ? window.NovaRegistry : null;
      if (!reg || typeof reg.get !== 'function') return null;
      const value = reg.get(LAST_DIR_KEY);
      if (typeof value !== 'string' || !value.trim()) return null;
      // Validate the remembered folder still exists and is a directory —
      // removable media / deleted homes must never trap the dialog.
      const stat = fs.statSync(value);
      if (!stat.isDirectory()) return null;
      return value;
    } catch (_) { return null; }
  }

  // ── Mime guessing (enough for common types) ────────────────────────────
  const EXT_MIME = {
    txt: 'text/plain', md: 'text/markdown', js: 'text/javascript',
    json: 'application/json', html: 'text/html', htm: 'text/html',
    css: 'text/css', sh: 'application/x-sh', xml: 'application/xml',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    pdf: 'application/pdf', zip: 'application/zip',
    novaapp: 'application/json',
  };

  function guessMime(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    return EXT_MIME[ext] || 'application/octet-stream';
  }

  // Wider table for matching an <input accept> list and for pathOnly results.
  // It stays apart from EXT_MIME on purpose: callers that read file contents
  // choose string vs Buffer from guessMime(), so adding text types there
  // would turn a Latin-1 CSV into a mangled UTF-8 string.
  const EXT_MIME_EXTRA = {
    bmp: 'image/bmp', ico: 'image/vnd.microsoft.icon', avif: 'image/avif',
    heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
    jxl: 'image/jxl',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
    flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/opus',
    weba: 'audio/webm', mid: 'audio/midi', midi: 'audio/midi',
    mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm', ogv: 'video/ogg',
    mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
    mpeg: 'video/mpeg', mpg: 'video/mpeg', '3gp': 'video/3gpp',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    odp: 'application/vnd.oasis.opendocument.presentation',
    rtf: 'application/rtf', epub: 'application/epub+zip',
    csv: 'text/csv', tsv: 'text/tab-separated-values', ics: 'text/calendar',
    vcf: 'text/vcard', yaml: 'application/yaml', yml: 'application/yaml',
    gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar',
    bz2: 'application/x-bzip2', xz: 'application/x-xz',
    '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    wasm: 'application/wasm', mjs: 'text/javascript',
    iso: 'application/x-iso9660-image', deb: 'application/vnd.debian.binary-package',
    apk: 'application/vnd.android.package-archive',
  };

  function lookupMime(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    return EXT_MIME[ext] || EXT_MIME_EXTRA[ext] || 'application/octet-stream';
  }

  // Turns an <input accept> string (".png,image/*,application/pdf") into a
  // filter(name, isDir), or null when it holds no usable rule. Extension rules
  // are strict. MIME rules let through files whose type we can't identify:
  // the table can't cover every format, and the dialog has no "all files"
  // switch, so hiding an unknown file would make it unpickable.
  function acceptFilter(accept) {
    const rules = String(accept || '').split(',').map(r => r.trim().toLowerCase())
      .filter(r => /^\.[\w+-]+$/.test(r) || /^[\w.+-]+\/(\*|[\w.+-]+)$/.test(r));
    if (!rules.length) return null;
    return (name, isDir) => {
      if (isDir) return true;
      const lowerName = name.toLowerCase();
      const type = lookupMime(name);
      return rules.some(rule => {
        if (rule.startsWith('.')) return lowerName.endsWith(rule);
        if (type === 'application/octet-stream') return true;
        if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1));
        return type === rule;
      });
    };
  }

  // The extension a "New file" should carry: the single extension implied by
  // the active accept list (".json" or ".txt,.text/plain" style lists where
  // every rule is the SAME extension), else the suggested name's extension,
  // else ".txt" — the Windows default.
  function impliedExtension(opts) {
    try {
      const rules = String(opts.accept || '').split(',').map(r => r.trim().toLowerCase())
        .filter(r => /^\.[\w+-]+$/.test(r) || /^[\w.+-]+\/(\*|[\w.+-]+)$/.test(r));
      const exts = rules.filter(r => r.startsWith('.'));
      if (exts.length && exts.length === rules.length) {
        const unique = [...new Set(exts)];
        if (unique.length === 1) return unique[0];
      }
    } catch (_) { /* fall through to the defaults below */ }
    const suggested = typeof opts.suggestedName === 'string' ? opts.suggestedName.trim() : '';
    const match = suggested.match(/\.[\w+-]+$/);
    if (match) return match[0].toLowerCase();
    return '.txt';
  }

  // ── Icon SVGs (minimal, inline) ────────────────────────────────────────
  function folderIcon() {
    return `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.586a1 1 0 0 1 .707.293L10.414 6.5A1 1 0 0 0 11.121 6.793H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`;
  }
  function fileIcon() {
    return `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
  }
  function chevronLeft() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
  }
  function chevronUp() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`;
  }
  function chevronRight() {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
  }
  function homeIcon() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
  }
  function pencilIcon() {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`;
  }
  function folderPlusIcon() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.586a1 1 0 0 1 .707.293L10.414 6.5A1 1 0 0 0 11.121 6.793H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><line x1="12" y1="10" x2="12" y2="16"/><line x1="9" y1="13" x2="15" y2="13"/></svg>`;
  }
  function filePlusIcon() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`;
  }

  // ── Read a directory, sorted (folders first) ───────────────────────────
  async function readDir(dirPath) {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const dirs = [];
    const files = [];
    for (const entry of entries) {
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await fs.promises.stat(path.join(dirPath, entry.name));
          isDir = target.isDirectory();
          isFile = target.isFile();
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          isFile = true;
        }
      }
      if (isDir) dirs.push({ name: entry.name, isDir: true });
      else if (isFile) files.push({ name: entry.name, isDir: false });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  }

  function isDirectorySafe(target) {
    try { return fs.statSync(target).isDirectory(); } catch (_) { return false; }
  }

  // Sidebar "Quick access" common folders, Windows order.
  const QUICK_FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music'];

  // "New folder" / "New file" base names — on-disk artifact names, matching
  // the Windows convention (kept literal, not localised, so tests and callers
  // can rely on the exact bytes created in the host filesystem).
  const NEW_FOLDER_BASE = 'New folder';
  const NEW_FILE_BASE = 'New file';

  // First free name in dirPath: base+ext, then "base (2)+ext", "base (3)+ext"…
  // (Windows numbering — the second artifact is "(2)", not "(1)".)
  function firstFreeName(dirPath, baseName, ext) {
    const candidate = (n) => (n === 0 ? `${baseName}${ext}` : `${baseName} (${n + 1})${ext}`);
    for (let n = 0; n < 1000; n++) {
      try { fs.statSync(path.join(dirPath, candidate(n))); } catch (_) { return candidate(n); }
    }
    return `${baseName} (${Date.now()})${ext}`;
  }

  // ── Core dialog ────────────────────────────────────────────────────────
  function _show(opts) {
    const isSave    = opts.mode === 'save';
    // directory: true (open mode only) turns the dialog into a folder chooser.
    // Resolves { path, name } for the highlighted subfolder, or the current one.
    const pickDir   = !isSave && opts.directory === true;
    // multiple: true (open mode, files only) allows click-to-toggle multi-select
    // and resolves an array of file objects (same shape as single open).
    const multi     = !isSave && !pickDir && opts.multiple === true;
    // pathOnly: true (open mode) skips reading file contents and resolves
    // { path, name, mimeType, size } only, for callers that stream the file
    // themselves instead of holding all of it in memory.
    const pathOnly  = !isSave && opts.pathOnly === true;
    const title     = opts.title || (isSave ? _t('shell.files.saveAs') : pickDir ? _t('shell.files.selectFolder') : _t('shell.files.open'));
    // accept: an <input accept> style list, combined with filter if both are given.
    const customFilter = typeof opts.filter === 'function' ? opts.filter : null;
    const acceptRule   = acceptFilter(opts.accept);
    const filter    = (name, isDir) =>
      (!customFilter || customFilter(name, isDir)) && (!acceptRule || acceptRule(name, isDir));
    // Start folder: an explicit startPath always wins; otherwise the folder
    // this user last visited (validated to still exist), else the account root.
    let   cwd       = opts.startPath || readLastDir() || getDefaultStartPath();
    // Sidebar anchor: the mounted account root, or — in host contexts without
    // one — the dialog's starting directory, so quick access stays meaningful.
    const homePath  = getDefaultStartPath();
    let   quickBase = null;
    try {
      if (typeof FS !== 'undefined' && FS.rootId && typeof FS.getPath === 'function') {
        const userRoot = FS.getPath(FS.rootId);
        if (typeof userRoot === 'string' && path.isAbsolute(userRoot)) quickBase = userRoot;
      }
    } catch (_) { /* fall through */ }
    if (!quickBase) {
      quickBase = (opts.startPath && path.isAbsolute(opts.startPath)) ? opts.startPath : homePath;
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      // ── Modal root ───────────────────────────────────────────────────
      let modalRoot = document.getElementById('system-modal-root');
      if (!modalRoot) {
        modalRoot = document.createElement('div');
        modalRoot.id = 'system-modal-root';
        Object.assign(modalRoot.style, {
          position: 'fixed', inset: '0',
          width: '100vw', height: '100vh',
          zIndex: '2147483000',
          pointerEvents: 'none',
          isolation: 'isolate',
        });
        document.body.appendChild(modalRoot);
      }

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.style.pointerEvents = 'auto';

      const dialog = document.createElement('div');
      dialog.className = 'modal-dialog system-file-dialog';

      // ── Header ───────────────────────────────────────────────────────
      const header = document.createElement('div');
      header.className = 'modal-title system-file-dialog-title';
      header.textContent = title;

      // ── Toolbar ──────────────────────────────────────────────────────
      const toolbar = document.createElement('div');
      toolbar.className = 'system-file-dialog-toolbar';

      const backBtn = document.createElement('button');
      backBtn.className = 'system-file-dialog-nav-btn';
      backBtn.title = _t('shell.files.back');
      backBtn.setAttribute('aria-label', _t('shell.files.back'));
      backBtn.innerHTML = chevronLeft();

      const upBtn = document.createElement('button');
      upBtn.className = 'system-file-dialog-nav-btn';
      upBtn.title = _t('shell.files.up');
      upBtn.setAttribute('aria-label', _t('shell.files.parentFolder'));
      upBtn.innerHTML = chevronUp();

      // Address bar: breadcrumb mode by default, editable path mode on
      // demand (edit button, or a click on the bar's empty space).
      const pathBarWrap = document.createElement('div');
      pathBarWrap.className = 'system-file-dialog-path-wrap';

      const crumbs = document.createElement('div');
      crumbs.className = 'system-file-dialog-breadcrumbs';
      crumbs.setAttribute('role', 'navigation');
      crumbs.setAttribute('aria-label', _t('apps.sysdialog.breadcrumbsAria'));

      const pathBar = document.createElement('input');
      pathBar.className = 'system-file-dialog-path';
      pathBar.setAttribute('aria-label', _t('shell.files.currentFolder'));
      pathBar.spellcheck = false;
      pathBar.type = 'text';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'system-file-dialog-path-edit';
      editBtn.title = _t('apps.sysdialog.editPath');
      editBtn.setAttribute('aria-label', _t('apps.sysdialog.editPath'));
      editBtn.innerHTML = pencilIcon();

      pathBarWrap.append(crumbs, pathBar, editBtn);

      // "New folder" (both modes) and "New file" (save mode only).
      const newFolderBtn = document.createElement('button');
      newFolderBtn.type = 'button';
      newFolderBtn.className = 'system-file-dialog-action-btn';
      newFolderBtn.title = _t('apps.sysdialog.newFolder');
      newFolderBtn.setAttribute('aria-label', _t('apps.sysdialog.newFolder'));
      const newFolderIcon = document.createElement('span');
      newFolderIcon.className = 'system-file-dialog-action-icon';
      newFolderIcon.innerHTML = folderPlusIcon();
      const newFolderLabel = document.createElement('span');
      newFolderLabel.className = 'system-file-dialog-action-label';
      newFolderLabel.textContent = _t('apps.sysdialog.newFolder');
      newFolderBtn.append(newFolderIcon, newFolderLabel);

      let newFileBtn = null;
      if (isSave) {
        newFileBtn = document.createElement('button');
        newFileBtn.type = 'button';
        newFileBtn.className = 'system-file-dialog-action-btn';
        newFileBtn.title = _t('apps.sysdialog.newFile');
        newFileBtn.setAttribute('aria-label', _t('apps.sysdialog.newFile'));
        const newFileIcon = document.createElement('span');
        newFileIcon.className = 'system-file-dialog-action-icon';
        newFileIcon.innerHTML = filePlusIcon();
        const newFileLabel = document.createElement('span');
        newFileLabel.className = 'system-file-dialog-action-label';
        newFileLabel.textContent = _t('apps.sysdialog.newFile');
        newFileBtn.append(newFileIcon, newFileLabel);
      }

      toolbar.append(backBtn, upBtn, pathBarWrap, newFolderBtn);
      if (newFileBtn) toolbar.appendChild(newFileBtn);

      // ── Dialog body: sidebar + file grid ─────────────────────────────
      const body = document.createElement('div');
      body.className = 'system-file-dialog-body';

      const sidebar = document.createElement('nav');
      sidebar.className = 'system-file-dialog-sidebar';
      sidebar.setAttribute('aria-label', _t('apps.sysdialog.quickAccess'));

      const sideHeader = document.createElement('div');
      sideHeader.className = 'system-file-dialog-side-header';
      sideHeader.textContent = _t('apps.sysdialog.quickAccess');
      sidebar.appendChild(sideHeader);

      // Quick access entries: Home (account root), then the common folders
      // that actually exist on disk — hidden when their target is missing.
      const sideButtons = [];
      const quickEntries = [];
      if (isDirectorySafe(homePath)) {
        quickEntries.push({ label: _t('apps.sysdialog.home'), target: homePath, icon: homeIcon });
      }
      for (const folder of QUICK_FOLDERS) {
        const target = path.join(quickBase, folder);
        if (isDirectorySafe(target)) {
          quickEntries.push({ label: folder, target, icon: folderIcon });
        }
      }
      for (const entry of quickEntries) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'system-file-dialog-side-item';
        btn.setAttribute('aria-label', entry.label);
        const icon = document.createElement('span');
        icon.className = 'system-file-dialog-side-icon';
        icon.innerHTML = entry.icon();
        const label = document.createElement('span');
        label.className = 'system-file-dialog-side-name';
        label.textContent = entry.label;
        btn.append(icon, label);
        btn.addEventListener('click', () => {
          if (path.resolve(entry.target) === path.resolve(cwd)) return;
          navigateTo(entry.target);
        });
        sidebar.appendChild(btn);
        sideButtons.push({ el: btn, target: path.resolve(entry.target) });
      }

      const grid = document.createElement('div');
      grid.className = 'system-file-dialog-grid';
      grid.setAttribute('role', 'grid');
      grid.setAttribute('aria-label', _t('shell.files.filesAria'));

      body.append(sidebar, grid);

      // ── Footer ───────────────────────────────────────────────────────
      const footer = document.createElement('div');
      footer.className = 'system-file-dialog-footer';

      // Status line for in-dialog creation feedback (errors surface here
      // instead of crashing the dialog).
      const statusEl = document.createElement('div');
      statusEl.className = 'system-file-dialog-status';
      statusEl.setAttribute('role', 'status');
      statusEl.setAttribute('aria-live', 'polite');

      const nameInput = document.createElement('input');
      nameInput.className = 'input';
      nameInput.type = 'text';
      nameInput.style.flex = '1';
      nameInput.setAttribute('aria-label', isSave ? _t('shell.files.fileNameAria') : _t('shell.files.selectedFileAria'));
      nameInput.placeholder = isSave ? _t('shell.files.fileNamePlaceholder') : pickDir ? _t('shell.files.currentFolder') : multi ? _t('shell.files.selectFilesPlaceholder') : _t('shell.files.selectAFilePlaceholder');
      if (isSave) nameInput.value = opts.suggestedName || '';
      else nameInput.readOnly = true;

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-sm';
      cancelBtn.textContent = _t('common.cancel');

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'btn btn-sm btn-primary';
      confirmBtn.textContent = isSave ? _t('common.save') : pickDir ? _t('common.select') : _t('common.open');
      confirmBtn.disabled = pickDir ? false : (!isSave || !nameInput.value.trim());

      footer.append(statusEl, nameInput, cancelBtn, confirmBtn);
      dialog.append(header, toolbar, body, footer);
      overlay.appendChild(dialog);

      // ── Navigation state ─────────────────────────────────────────────
      const history = [];
      let histIdx = -1;
      let selectedName = null;
      const selectedSet = new Set();

      function pushHistory(p) {
        if (histIdx < history.length - 1) history.length = histIdx + 1;
        history.push(p);
        histIdx = history.length - 1;
      }

      function setStatus(message, isError) {
        statusEl.textContent = message || '';
        statusEl.classList.toggle('is-error', Boolean(isError && message));
      }

      // Everything that visualises the current cwd: path bar value, back/up
      // button state, breadcrumb segments and the sidebar's active entry.
      function syncChrome() {
        pathBar.value = cwd;
        upBtn.disabled = (path.dirname(cwd) === cwd); // at root
        backBtn.disabled = histIdx <= 0;
        renderBreadcrumbs();
        updateSidebarActive();
      }

      async function navigateTo(dirPath, { record = true } = {}) {
        const nextPath = path.resolve(dirPath);
        try {
          const target = await fs.promises.stat(nextPath);
          if (!target.isDirectory()) throw new Error(_t('shell.files.notAFolder'));
        } catch (error) {
          pathBar.value = cwd;
          if (typeof Notify !== 'undefined') {
            Notify.show({ title: 'Folder unavailable', body: error.message, type: 'error' });
          }
          return false;
        }
        cwd = nextPath;
        if (record) pushHistory(dirPath);
        selectedName = null;
        selectedSet.clear();
        if (!isSave) {
          nameInput.value = '';
          confirmBtn.disabled = !pickDir;
        }
        setStatus('');
        persistLastDir(cwd); // per-user last-directory memory (cheap, on navigation)
        syncChrome();
        await renderGrid();
        return true;
      }

      backBtn.addEventListener('click', async () => {
        if (histIdx <= 0) return;
        histIdx--;
        cwd = history[histIdx];
        selectedName = null;
        selectedSet.clear();
        if (!isSave) { nameInput.value = ''; confirmBtn.disabled = !pickDir; }
        setStatus('');
        persistLastDir(cwd);
        syncChrome();
        await renderGrid();
      });

      upBtn.addEventListener('click', () => {
        const parent = path.dirname(cwd);
        if (parent !== cwd) navigateTo(parent);
      });

      // ── Breadcrumb address bar ───────────────────────────────────────
      function renderBreadcrumbs() {
        crumbs.innerHTML = '';
        const parts = [];
        const rel = path.relative(homePath, cwd);
        const underHome = rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel));
        if (underHome) {
          // "Home > Documents > …" when the cwd lives under the account root.
          parts.push({ label: _t('apps.sysdialog.home'), target: homePath });
          let acc = homePath;
          if (rel) {
            for (const seg of rel.split(path.sep).filter(Boolean)) {
              acc = path.join(acc, seg);
              parts.push({ label: seg, target: acc });
            }
          }
        } else {
          // Otherwise root-anchored segments: "/ > tmp > …".
          const resolved = path.resolve(cwd);
          const root = path.parse(resolved).root || path.sep;
          parts.push({ label: root, target: root });
          let acc = root;
          for (const seg of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
            acc = path.join(acc, seg);
            parts.push({ label: seg, target: acc });
          }
        }
        parts.forEach((part, idx) => {
          const isCurrent = idx === parts.length - 1;
          if (idx > 0) {
            const sep = document.createElement('span');
            sep.className = 'system-file-dialog-crumb-sep';
            sep.setAttribute('aria-hidden', 'true');
            sep.innerHTML = chevronRight();
            crumbs.appendChild(sep);
          }
          if (isCurrent) {
            const current = document.createElement('span');
            current.className = 'system-file-dialog-crumb-current';
            current.textContent = part.label;
            crumbs.appendChild(current);
          } else {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'system-file-dialog-crumb';
            btn.textContent = part.label;
            btn.setAttribute('aria-label', part.label);
            btn.title = part.target;
            btn.addEventListener('click', () => navigateTo(part.target));
            crumbs.appendChild(btn);
          }
        });
      }

      function updateSidebarActive() {
        const current = path.resolve(cwd);
        for (const { el, target } of sideButtons) {
          const on = target === current;
          el.classList.toggle('active', on);
          el.setAttribute('aria-current', on ? 'true' : 'false');
        }
      }

      function enterEditMode() {
        if (pathBarWrap.classList.contains('editing')) return;
        pathBar.value = cwd;
        pathBarWrap.classList.add('editing');
        requestAnimationFrame(() => { pathBar.focus(); pathBar.select(); });
      }

      function exitEditMode() {
        pathBarWrap.classList.remove('editing');
      }

      editBtn.addEventListener('click', enterEditMode);
      // Clicking the breadcrumb bar's empty space toggles the path editor,
      // like the Windows Explorer address bar.
      crumbs.addEventListener('click', e => { if (e.target === crumbs) enterEditMode(); });

      pathBar.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          const target = pathBar.value.trim();
          if (!target) { exitEditMode(); return; }
          navigateTo(target).then((ok) => { if (ok) exitEditMode(); });
        } else if (event.key === 'Escape') {
          // Escape while editing the path reverts the edit — it must NOT
          // cancel the whole dialog, so stop the event before the overlay's
          // cancel handler sees it.
          event.stopPropagation();
          event.preventDefault();
          pathBar.value = cwd;
          exitEditMode();
        }
      });

      // ── In-dialog creation (Windows killer feature) ──────────────────
      function selectEntry(name, isDirEntry) {
        const item = [...grid.querySelectorAll('.system-file-dialog-item')]
          .find(el => el.getAttribute('aria-label') === name);
        if (!item) return;
        clearSelection();
        item.classList.add('selected');
        item.setAttribute('aria-selected', 'true');
        if (isDirEntry) {
          if (pickDir) { selectedName = name; nameInput.value = name; }
        } else {
          selectedName = name;
          nameInput.value = name;
          confirmBtn.disabled = isSave ? !nameInput.value.trim() : false;
        }
      }

      function reportCreateFailure(message, error) {
        setStatus(message, true);
        if (typeof Notify !== 'undefined') {
          Notify.show({ title: _t('apps.sysdialog.createFailed'), body: error.message, type: 'error' });
        }
      }

      async function createNewFolder() {
        try {
          const name = firstFreeName(cwd, NEW_FOLDER_BASE, '');
          await fs.promises.mkdir(path.join(cwd, name));
          setStatus('');
          await renderGrid();
          selectEntry(name, true);
        } catch (error) {
          reportCreateFailure(_t('apps.sysdialog.createFolderFailed', { message: error.message }), error);
        }
      }

      async function createNewFile() {
        try {
          const ext = impliedExtension(opts);
          const name = firstFreeName(cwd, NEW_FILE_BASE, ext);
          await fs.promises.writeFile(path.join(cwd, name), '');
          setStatus('');
          await renderGrid();
          selectEntry(name, false);
          // Pre-fill the save-mode filename input so Save can happen
          // immediately (still editable for a rename-before-save).
          nameInput.value = name;
          confirmBtn.disabled = !nameInput.value.trim();
          requestAnimationFrame(() => { nameInput.focus(); nameInput.select(); });
        } catch (error) {
          reportCreateFailure(_t('apps.sysdialog.createFileFailed', { message: error.message }), error);
        }
      }

      newFolderBtn.addEventListener('click', () => { createNewFolder(); });
      if (newFileBtn) newFileBtn.addEventListener('click', () => { createNewFile(); });

      if (isSave) {
        nameInput.addEventListener('input', () => {
          confirmBtn.disabled = !nameInput.value.trim();
        });
      }

      async function renderGrid() {
        grid.innerHTML = '';
        let entries;
        try {
          entries = await readDir(cwd);
        } catch (error) {
          const message = document.createElement('div');
          message.style.cssText = 'grid-column:1/-1;padding:24px;text-align:center;color:var(--text-muted);font-size:12px;';
          message.textContent = _t('shell.files.unableToReadFolder', { message: error.message });
          grid.appendChild(message);
          if (typeof Notify !== 'undefined') {
            Notify.show({ title: _t('shell.files.folderUnavailable'), body: error.message, type: 'error' });
          }
          return;
        }
        const visible = pickDir
          ? entries.filter(e => e.isDir)
          : entries.filter(e => e.isDir || filter(e.name, false));

        if (visible.length === 0) {
          const empty = document.createElement('div');
          empty.style.cssText = 'grid-column:1/-1;padding:24px;text-align:center;color:var(--text-muted);font-size:12px;';
          empty.textContent = _t('shell.files.emptyFolder');
          grid.appendChild(empty);
          return;
        }

        for (const entry of visible) {
          const item = document.createElement('div');
          item.className = 'system-file-dialog-item';
          item.tabIndex = 0;
          item.setAttribute('role', 'gridcell');
          item.setAttribute('aria-label', entry.name);
          item.setAttribute('aria-selected', 'false');

          const iconWrap = document.createElement('div');
          iconWrap.className = 'system-file-dialog-icon';
          iconWrap.innerHTML = entry.isDir ? folderIcon() : fileIcon();

          const nameEl = document.createElement('div');
          nameEl.className = 'system-file-dialog-name';
          nameEl.textContent = entry.name;

          item.append(iconWrap, nameEl);

          if (entry.isDir) {
            item.addEventListener('click', () => {
              clearSelection();
              item.classList.add('selected');
              item.setAttribute('aria-selected', 'true');
              if (pickDir) { selectedName = entry.name; nameInput.value = entry.name; }
            });
            item.addEventListener('dblclick', () => navigateTo(path.join(cwd, entry.name)));
            item.addEventListener('keydown', e => {
              if (e.key === 'Enter') navigateTo(path.join(cwd, entry.name));
            });
          } else {
            item.addEventListener('click', () => {
              if (multi) {
                const on = !selectedSet.has(entry.name);
                item.classList.toggle('selected', on);
                item.setAttribute('aria-selected', String(on));
                if (on) selectedSet.add(entry.name); else selectedSet.delete(entry.name);
                nameInput.value = selectedSet.size > 1 ? _t('shell.files.filesSelected', { count: selectedSet.size }) : ([...selectedSet][0] || '');
                confirmBtn.disabled = selectedSet.size === 0;
                return;
              }
              clearSelection();
              item.classList.add('selected');
              item.setAttribute('aria-selected', 'true');
              selectedName = entry.name;
              nameInput.value = entry.name;
              if (isSave) confirmBtn.disabled = !nameInput.value.trim();
              else confirmBtn.disabled = false;
            });
            item.addEventListener('dblclick', () => {
              selectedName = entry.name;
              nameInput.value = entry.name;
              if (multi) { selectedSet.add(entry.name); confirmBtn.disabled = false; }
              doConfirm();
            });
            item.addEventListener('keydown', e => {
              if (e.key === 'Enter') {
                selectedName = entry.name;
                if (multi) { selectedSet.add(entry.name); confirmBtn.disabled = false; }
                doConfirm();
              }
            });
          }

          grid.appendChild(item);
        }
      }

      function clearSelection() {
        for (const el of grid.children) {
          el.classList.remove('selected');
          el.setAttribute('aria-selected', 'false');
        }
      }

      async function doConfirm() {
        if (confirmBtn.disabled) return;
        if (pickDir) {
          const dir = selectedName ? path.join(cwd, selectedName) : cwd;
          persistLastDir(cwd);
          finish({ path: dir, name: path.basename(dir) || dir });
          return;
        }
        if (multi) {
          const names = [...selectedSet];
          if (!names.length) return;
          const results = [];
          for (const n of names) {
            const fp = path.join(cwd, n);
            try {
              if (pathOnly) {
                const stat = await fs.promises.stat(fp);
                results.push({ path: fp, name: n, mimeType: lookupMime(n), size: stat.size });
                continue;
              }
              const buf = await fs.promises.readFile(fp);
              const mime = guessMime(n);
              const isText = mime.startsWith('text/') || mime === 'application/json' || mime === 'application/x-sh' || mime === 'application/xml';
              results.push({ path: fp, name: n, content: isText ? buf.toString('utf8') : buf, mimeType: mime, size: buf.length });
            } catch (err) {
              if (typeof Notify !== 'undefined') {
                Notify.show({ title: _t('shell.files.openFailed'), body: `${n}: ${err.message}`, type: 'error' });
              }
              return;
            }
          }
          persistLastDir(cwd);
          finish(results);
          return;
        }
        const name = nameInput.value.trim();
        if (!name) return;
        if (isSave && (name === '.' || name === '..' || name.includes('\0') ||
            path.basename(name) !== name)) {
          if (typeof Notify !== 'undefined') {
            Notify.show({ title: _t('shell.files.invalidFileName'), body: _t('shell.files.enterFileName'), type: 'error' });
          }
          return;
        }
        const fullPath = path.join(cwd, name);

        if (isSave) {
          persistLastDir(cwd);
          finish({ path: fullPath, name });
        } else if (pathOnly) {
          fs.stat(fullPath, (err, stat) => {
            if (err) {
              if (typeof Notify !== 'undefined') {
                Notify.show({ title: _t('shell.files.openFailed'), body: err.message, type: 'error' });
              }
              return;
            }
            persistLastDir(cwd);
            finish({ path: fullPath, name, mimeType: lookupMime(name), size: stat.size });
          });
        } else {
          // read the file content
          fs.readFile(fullPath, (err, buf) => {
            if (err) {
              if (typeof Notify !== 'undefined') {
                Notify.show({ title: _t('shell.files.openFailed'), body: err.message, type: 'error' });
              }
              return;
            }
            const mime = guessMime(name);
            const isText = mime.startsWith('text/') || mime === 'application/json' || mime === 'application/x-sh' || mime === 'application/xml';
            persistLastDir(cwd);
            finish({
              path: fullPath,
              name,
              content: isText ? buf.toString('utf8') : buf,
              mimeType: mime,
              size: buf.length,
            });
          });
        }
      }

      cancelBtn.addEventListener('click', () => finish(null));
      confirmBtn.addEventListener('click', doConfirm);
      overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });

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

      // ── Init ─────────────────────────────────────────────────────────
      modalRoot.appendChild(overlay);
      navigateTo(cwd, { record: false }).then(() => {
        pushHistory(cwd);
        if (isSave) {
          requestAnimationFrame(() => { nameInput.focus(); nameInput.select(); });
        } else {
          requestAnimationFrame(() => grid.focus());
        }
      });
    });
  }

  return {
    open(opts = {}) { return _show({ ...opts, mode: 'open' }); },
    save(opts = {}) { return _show({ ...opts, mode: 'save' }); },
  };
})();

window.SystemDialogs = SystemDialogs;
