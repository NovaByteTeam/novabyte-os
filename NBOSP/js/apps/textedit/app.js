function initLinuxTextEdit(content, state, options = {}) {
  const fs = require('fs').promises;
  const path = require('path');
  const os = require('os');
  const controller = new AbortController();
  state.cleanups = Array.isArray(state.cleanups) ? state.cleanups : [];
  state.cleanups.push(() => controller.abort());

  let currentPath = options.path || options.filePath || null;
  let modified = false;
  const root = createEl('div', { style: 'position:absolute;inset:0;display:flex;flex-direction:column;min-height:0;overflow:hidden;' });
  const toolbar = createEl('div', { style: 'display:flex;gap:8px;padding:8px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;' });
  const editor = createEl('textarea', {
    className: 'quill-textarea',
    'aria-label': _t('apps.textedit.editorAria'),
    spellcheck: 'false',
    // .quill-textarea is absolutely positioned at z-index 10 for the wrapped
    // layout below; here it sits in a flex column, so undo that or it covers the toolbar.
    style: 'flex:1;resize:none;min-height:0;width:100%;box-sizing:border-box;position:static;height:auto;z-index:auto;padding-left:12px;'
  });
  const status = createEl('div', { role: 'status', style: 'padding:5px 10px;border-top:1px solid var(--border-subtle);font-size:11px;color:var(--text-muted);flex-shrink:0;' });
  const setStatus = () => {
    const name = currentPath ? path.basename(currentPath) : _t('apps.textedit.untitled');
    status.textContent = `${name}${modified ? _t('apps.textedit.modifiedIndicator') : ''}`;
  };
  const addButton = (label, action) => {
    const button = createEl('button', { className: 'btn btn-sm', textContent: label });
    button.addEventListener('click', action, { signal: controller.signal });
    toolbar.appendChild(button);
  };
  const selectPath = async (saveAs, suggestedName = 'untitled.txt') => {
    const startPath = currentPath ? path.dirname(currentPath) : os.homedir();
    if (saveAs) {
      const picked = await SystemDialogs.save({ title: _t('apps.textedit.saveAsDialogTitle'), suggestedName, startPath });
      return picked ? picked.path : null;
    } else {
      const picked = await SystemDialogs.open({ title: _t('apps.textedit.openFileDialogTitle'), startPath });
      return picked ? picked.path : null;
    }
  };

  const save = async saveAs => {
    try {
      const target = saveAs || !currentPath ? await selectPath(true, path.basename(currentPath || 'untitled.txt')) : currentPath;
      if (!target) return;
      await fs.writeFile(target, editor.value, 'utf8');
      currentPath = target;
      modified = false;
      setStatus();
      Notify.show({ title: _t('apps.textedit.savedTitle'), body: path.basename(target), type: 'success', appName: 'TextEdit' });
    } catch (error) {
      Notify.show({ title: _t('apps.textedit.saveFailedLinux'), body: error.message, type: 'error', appName: 'TextEdit' });
    }
  };

  const open = async () => {
    const target = await selectPath(false);
    if (!target) return;
    try {
      editor.value = await fs.readFile(target, 'utf8');
      currentPath = target;
      modified = false;
      setStatus();
    } catch (error) {
      Notify.show({ title: _t('apps.textedit.openFailedLinux'), body: error.message, type: 'error', appName: 'TextEdit' });
    }
  };

  addButton(_t('apps.textedit.openButton'), open);
  addButton(_t('common.save'), () => save(false));
  addButton(_t('apps.textedit.saveAsButton'), () => save(true));
  editor.addEventListener('input', () => {
    modified = true;
    setStatus();
  }, { signal: controller.signal });
  editor.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save(event.shiftKey);
    }
  }, { signal: controller.signal });
  root.append(toolbar, editor, status);
  content.replaceChildren(root);
  content.style.cssText = 'padding:0;height:100%;overflow:hidden;position:relative;';
  if (Object.prototype.hasOwnProperty.call(options, 'initialContent')) {
    editor.value = String(options.initialContent ?? '');
    setStatus();
  } else if (currentPath) {
    fs.readFile(currentPath, 'utf8').then(text => {
      editor.value = text;
      modified = false;
      setStatus();
    }).catch(error => {
      console.error('[TextEdit] Could not open requested file:', error);
      Notify.show({ title: _t('apps.textedit.openFailedLinux'), body: error.message, type: 'error', appName: 'TextEdit' });
    });
  } else {
    setStatus();
  }
}

registerApp({
  id: 'com.nbosp.textedit',
  name: 'TextEdit',
  icon: 'pen-tool',
  version: '3.0.2',
  description: 'Text Editor',
  defaultSize: [680, 500],
  minSize: [360, 260],

  init(content, state, options) {
    if (typeof process !== 'undefined' && process.platform === 'linux') {
      initLinuxTextEdit(content, state, options);
      return;
    }
    const ctrl = new AbortController();
    const { signal } = ctrl;
    let rafId = 0;

    // Register teardown immediately so cleanup works even if the directory guard fails early
    content._destroy = () => {
      ctrl.abort();
      if (rafId) cancelAnimationFrame(rafId);
    };

    if (!window.AppDirs?.getAppDataPath('com.nbosp.textedit', 'files')) {
      Object.assign(content.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        flexDirection: 'column',
        gap: '12px',
        fontFamily: 'var(--font-ui, sans-serif)',
        color: 'var(--text-muted, #888)'
      });

      const icon = createEl('div', { style: 'font-size:32px', textContent: '⚠️' });
      const msg = createEl('div', { style: 'font-size:14px;text-align:center' });
      const bold = createEl('b', { textContent: 'com.nbosp.textedit' });

      msg.append(
        bold,
        document.createElement('br'),
        _t('apps.textedit.guard.appDataMissing'),
        document.createElement('br'),
        _t('apps.textedit.guard.requiresOs')
      );
      content.append(icon, msg);
      return;
    }

    const PAIRS = Object.freeze({
      '(': ')', '{': '}', '[': ']', "'": "'", '"': '"', '`': '`'
    });
    const OPENERS = new Set(Object.keys(PAIRS));
    const ASYM_CLOSERS = new Set(
      Object.values(PAIRS).filter(c => !OPENERS.has(c))
    );

    const file = { id: null, name: 'untitled.txt', content: '', modified: false };

    const container = createEl('div', { className: 'quill-container' });
    const toolbar = createEl('div', { className: 'quill-toolbar' });
    const saveBtn = createEl('button', {
      className: 'btn btn-sm btn-primary', textContent: _t('common.save'), title: _t('apps.textedit.saveButtonTitle')
    });
    const saveAsBtn = createEl('button', {
      className: 'btn btn-sm', textContent: _t('apps.textedit.saveAsButton'), title: _t('apps.textedit.saveAsButtonTitle')
    });
    const openBtn = createEl('button', {
      className: 'btn btn-sm', textContent: _t('apps.textedit.openButton'), title: _t('apps.textedit.openButtonTitle')
    });
    const wrapBtn = createEl('button', {
      className: 'btn btn-sm', textContent: _t('apps.textedit.wordWrap'), title: _t('apps.textedit.wordWrapTitle')
    });
    const editorWrap = createEl('div', { className: 'quill-editor-wrap' });
    const gutter = createEl('div', { className: 'quill-gutter', 'aria-hidden': 'true' });
    const textarea = createEl('textarea', {
      className: 'quill-textarea', id: 'quill-text-editor', name: 'quill-editor',
      spellcheck: 'false', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off',
      'aria-label': _t('apps.textedit.editorAria'), role: 'textbox', 'aria-multiline': 'true'
    });
    const statusBar = createEl('div', {
      className: 'quill-statusbar',
      role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true'
    });
    const wrapMeasure = createEl('div', { className: 'quill-wrap-measure', 'aria-hidden': 'true' });

    toolbar.append(saveBtn, saveAsBtn, openBtn, wrapBtn);
    editorWrap.append(gutter, textarea, wrapMeasure);
    container.append(toolbar, editorWrap, statusBar);
    content.appendChild(container);

    let prevLineCount = 0;
    let prevGutterWrapped = false;
    // The word-wrap preference lives in the NovaByte Registry
    // (HKNA/com.nbosp.textedit/wordWrap); the localStorage key is adopted
    // once + kept as the fail-soft fallback.
    const wordWrapKey = 'nbosp.textedit.wordWrap';
    let wordWrapEnabled = false;
    try {
      if (typeof window !== 'undefined' && window.NovaAppConfig) {
        wordWrapEnabled = window.NovaAppConfig.get('com.nbosp.textedit', 'wordWrap', {
          type: 'REG_BOOL', legacyKey: wordWrapKey, fallback: false,
        }) === true;
      } else {
        wordWrapEnabled = localStorage.getItem(wordWrapKey) === 'true';
      }
    }
    catch (err) { console.warn('[TextEdit] Could not read the word-wrap preference:', err); }

    function updateWordWrap() {
      textarea.wrap = wordWrapEnabled ? 'soft' : 'off';
      textarea.classList.toggle('is-wrapped', wordWrapEnabled);
      wrapBtn.setAttribute('aria-pressed', String(wordWrapEnabled));
      wrapBtn.classList.toggle('btn-primary', wordWrapEnabled);
      syncGutter();
      scheduleUpdate();
    }

    wrapBtn.addEventListener('click', () => {
      wordWrapEnabled = !wordWrapEnabled;
      updateWordWrap();
      try {
        if (typeof window !== 'undefined' && window.NovaAppConfig) {
          window.NovaAppConfig.set('com.nbosp.textedit', 'wordWrap', wordWrapEnabled, {
            type: 'REG_BOOL', legacyKey: wordWrapKey, legacyRaw: String(wordWrapEnabled),
          });
        } else {
          localStorage.setItem(wordWrapKey, String(wordWrapEnabled));
        }
      }
      catch (err) { console.warn('[TextEdit] Could not save the word-wrap preference:', err); }
    }, { signal });

    function syncGutter() {
      const val = textarea.value;
      let count = 1;
      for (let i = 0; i < val.length; i++) {
        if (val.charCodeAt(i) === 10) count++;
      }
      const gutterWidth = Math.max(58, String(count).length * 8 + 16);
      editorWrap.style.setProperty('--quill-gutter-width', `${gutterWidth}px`);
      textarea.style.paddingLeft = `${gutterWidth}px`;
      if (!wordWrapEnabled && count === prevLineCount && !prevGutterWrapped) return;
      prevLineCount = count;
      prevGutterWrapped = wordWrapEnabled;

      if (!wordWrapEnabled) {
        const nums = new Array(count);
        for (let i = 0; i < count; i++) nums[i] = i + 1;
        gutter.textContent = nums.join('\n');
        gutter.scrollTop = textarea.scrollTop;
        return;
      }

      const computed = getComputedStyle(textarea);
      const lineHeight = Number.parseFloat(computed.lineHeight) || 20.8;
      const contentWidth = Math.max(
        1,
        textarea.clientWidth -
          (Number.parseFloat(computed.paddingLeft) || 0) -
          (Number.parseFloat(computed.paddingRight) || 0)
      );
      Object.assign(wrapMeasure.style, {
        width: `${contentWidth}px`,
        font: computed.font,
        lineHeight: computed.lineHeight,
        letterSpacing: computed.letterSpacing,
        tabSize: computed.tabSize,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        wordBreak: 'normal'
      });
      const gutterRows = [];
      const lines = val.split('\n');
      const fragment = document.createDocumentFragment();
      const measuredLines = lines.map((line, index) => {
        const row = document.createElement('div');
        row.textContent = line;
        row.style.minHeight = `${lineHeight}px`;
        fragment.appendChild(row);
        return { row, index };
      });
      wrapMeasure.replaceChildren(fragment);
      for (const { row, index } of measuredLines) {
        const visualRows = Math.max(1, Math.round(row.getBoundingClientRect().height / lineHeight));
        gutterRows.push(String(index + 1), ...new Array(visualRows - 1).fill(''));
      }
      gutter.textContent = gutterRows.join('\n');
      gutter.scrollTop = textarea.scrollTop;
    }

    // Linear scan avoids allocating word arrays on every cursor movement or input event
    function countWords(str) {
      let count = 0;
      let inWord = false;
      for (let i = 0; i < str.length; i++) {
        if (str.charCodeAt(i) <= 32) {
          inWord = false;
        } else if (!inWord) {
          inWord = true;
          count++;
        }
      }
      return count;
    }

    function syncStatus() {
      const val = textarea.value;
      const pos = textarea.selectionStart;

      let line = 1;
      let lastNL = -1;
      for (let i = 0; i < pos; i++) {
        if (val.charCodeAt(i) === 10) {
          line++;
          lastNL = i;
        }
      }
      const col = pos - lastNL;
      const words = countWords(val);

      statusBar.textContent = _t('apps.textedit.statusPosition', { line, col, words });
    }

    // Batch UI updates into the next animation frame to avoid layout thrashing on fast input
    function scheduleUpdate() {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        syncGutter();
        syncStatus();
      });
    }

    function getFilesDir() {
      return AppDirs.getAppDataPath('com.nbosp.textedit', 'files') ?? FS.specialFolders.documents;
    }

    function spliceText(start, end, insert) {
      textarea.setRangeText(insert, start, end, 'end');
      file.modified = true;
      scheduleUpdate();
    }

    async function doCopy() {
      const text = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
      if (!text) return false;
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        textarea.focus();
        return document.execCommand('copy');
      }
    }

    async function doCut() {
      const { selectionStart: s, selectionEnd: e } = textarea;
      if (s === e) return;
      const copied = await doCopy();
      if (copied) {
        spliceText(s, e, '');
      }
    }

    async function doPaste() {
      textarea.focus();
      try {
        const text = await navigator.clipboard.readText();
        const { selectionStart: s, selectionEnd: e } = textarea;
        spliceText(s, e, text);
      } catch {
        document.execCommand('paste');
      }
    }

    function applyTab(shiftKey) {
      const { selectionStart: s, selectionEnd: e } = textarea;
      const val = textarea.value;

      if (s === e) {
        if (shiftKey) {
          const lineStart = val.lastIndexOf('\n', s - 1) + 1;
          const lead = val.slice(lineStart, s).match(/^( {1,2})/)?.[1].length ?? 0;
          if (!lead) return;
          textarea.setRangeText('', lineStart, lineStart + lead, 'ignore');
          textarea.selectionStart = textarea.selectionEnd = s - lead;
        } else {
          textarea.setRangeText('  ', s, s, 'end');
        }
      } else {
        const lineStart = val.lastIndexOf('\n', s - 1) + 1;
        const lines = val.slice(lineStart, e).split('\n');
        let totalDiff = 0;
        let firstDiff = 0;

        const newLines = lines.map((ln, idx) => {
          if (ln === '' && idx === lines.length - 1) return ln;

          if (shiftKey) {
            const stripped = ln.replace(/^ {1,2}/, '');
            const removed = ln.length - stripped.length;
            if (idx === 0) firstDiff = -removed;
            totalDiff -= removed;
            return stripped;
          }
          if (idx === 0) firstDiff = 2;
          totalDiff += 2;
          return '  ' + ln;
        });

        textarea.setRangeText(newLines.join('\n'), lineStart, e, 'ignore');
        textarea.selectionStart = Math.max(lineStart, s + firstDiff);
        textarea.selectionEnd = Math.max(textarea.selectionStart, e + totalDiff);
      }

      file.modified = true;
      scheduleUpdate();
    }

    function handleBracket(key) {
      const close = PAIRS[key];
      const { selectionStart: s, selectionEnd: e } = textarea;
      const val = textarea.value;

      // Skip over existing closing char only if cursor is collapsed directly in front of it
      if (s === e && key === close && val[s] === key) {
        textarea.selectionStart = textarea.selectionEnd = s + 1;
        syncStatus();
        return;
      }

      if (s !== e) {
        const selected = val.slice(s, e);
        textarea.setRangeText(key + selected + close, s, e, 'select');
        textarea.selectionStart = s + 1;
        textarea.selectionEnd = e + 1;
      } else {
        textarea.setRangeText(key + close, s, s, 'end');
        textarea.selectionStart = textarea.selectionEnd = s + 1;
      }

      file.modified = true;
      scheduleUpdate();
    }

    function onKeydown(e) {
      const { key, ctrlKey, metaKey, shiftKey } = e;

      if ((ctrlKey || metaKey) && key === 's') {
        e.preventDefault();
        saveFile();
        return;
      }

      if (key === 'Tab') {
        e.preventDefault();
        applyTab(shiftKey);
        return;
      }

      if (OPENERS.has(key)) {
        e.preventDefault();
        handleBracket(key);
        return;
      }

      if (
        ASYM_CLOSERS.has(key) &&
        textarea.selectionStart === textarea.selectionEnd &&
        textarea.value[textarea.selectionStart] === key
      ) {
        e.preventDefault();
        textarea.selectionStart = textarea.selectionEnd = textarea.selectionStart + 1;
        syncStatus();
      }
    }

    async function saveFile() {
      try {
        if (file.id) {
          await FS.writeFile(file.id, textarea.value);
          file.content = textarea.value;
          file.modified = false;
          Notify.show({ title: _t('apps.textedit.savedTitle'), body: file.name, type: 'success', appName: 'TextEdit' });
        } else {
          await saveFileAs();
        }
      } catch (err) {
        Notify.show({
          title: _t('apps.textedit.saveFailed'),
          body: err?.message ?? _t('apps.textedit.saveUnknownError'),
          type: 'error',
          appName: 'TextEdit'
        });
      }
    }

    async function saveFileAs() {
      try {
        const picked = await SystemDialogs.save({
          title: _t('apps.textedit.saveAsDialogTitle'),
          suggestedName: file.name,
          startFolderId: getFilesDir()
        });
        if (!picked || !picked.name?.trim()) return;

        const node = await FS.createFile(picked.folderId, picked.name.trim(), textarea.value, 'text/plain');
        file.id = node.id;
        file.name = picked.name.trim();
        file.content = textarea.value;
        file.modified = false;

        // Optional call handles non-desktop window targets safely
        if (typeof renderDesktopIcons === 'function') {
          renderDesktopIcons();
        }

        Notify.show({ title: _t('apps.textedit.savedTitle'), body: file.name, type: 'success', appName: 'TextEdit' });
      } catch (err) {
        Notify.show({
          title: _t('apps.textedit.saveFailed'),
          body: err?.message ?? _t('apps.textedit.saveUnknownError'),
          type: 'error',
          appName: 'TextEdit'
        });
      }
    }

    async function openFile() {
      try {
        const picked = await SystemDialogs.open({
          title: _t('common.open'),
          startFolderId: getFilesDir(),
          filter: (node) => (node.mimeType || '').startsWith('text/') || node.mimeType === 'application/json'
        });
        if (!picked) return;

        file.id = picked.id;
        file.name = picked.name;
        file.content = picked.content ?? '';
        file.modified = false;

        textarea.value = file.content;
        syncGutter();
        syncStatus();
        Notify.show({ title: _t('apps.textedit.openedTitle'), body: picked.name, type: 'success', appName: 'TextEdit' });
      } catch (err) {
        Notify.show({
          title: _t('apps.textedit.openFailedTitle'),
          body: err?.message ?? _t('apps.textedit.openUnknownError'),
          type: 'error',
          appName: 'TextEdit'
        });
      }
    }

    function onContextMenu(e) {
      e.preventDefault();
      ContextMenu.show(e.clientX, e.clientY, [
        { label: _t('apps.textedit.context.cut'), icon: 'scissors', shortcut: 'Ctrl+X', action: doCut },
        { label: _t('apps.textedit.context.copy'), icon: 'copy', shortcut: 'Ctrl+C', action: doCopy },
        { label: _t('apps.textedit.context.paste'), icon: 'documents', shortcut: 'Ctrl+V', action: doPaste },
        { separator: true },
        {
          label: _t('apps.textedit.context.selectAll'), icon: 'maximize', shortcut: 'Ctrl+A',
          action: () => { textarea.focus(); textarea.select(); }
        },
        { separator: true },
        {
          label: _t('apps.textedit.context.wordCount'), icon: 'info',
          action: () => {
            const n = countWords(textarea.value);
            Notify.show({
              title: _t('apps.textedit.context.wordCount'),
              body: n !== 1 ? _t('apps.textedit.wordCountMany', { count: n }) : _t('apps.textedit.wordCountOne', { count: n }),
              type: 'info', appName: 'TextEdit'
            });
          }
        }
      ]);
    }

    saveBtn.addEventListener('click', saveFile, { signal });
    saveAsBtn.addEventListener('click', saveFileAs, { signal });
    openBtn.addEventListener('click', openFile, { signal });
    editorWrap.addEventListener('contextmenu', onContextMenu, { signal });
    editorWrap.addEventListener('click', e => {
      if (e.target === gutter) textarea.focus();
    }, { signal });

    textarea.addEventListener('input', () => { file.modified = true; scheduleUpdate(); }, { signal, passive: true });
    textarea.addEventListener('scroll', () => { gutter.scrollTop = textarea.scrollTop; }, { signal, passive: true });
    textarea.addEventListener('click', syncStatus, { signal, passive: true });
    textarea.addEventListener('keyup', syncStatus, { signal, passive: true });
    textarea.addEventListener('keydown', onKeydown, { signal });

    if (typeof ResizeObserver === 'function') {
      const gutterResizeObserver = new ResizeObserver(() => {
        if (wordWrapEnabled) syncGutter();
      });
      gutterResizeObserver.observe(textarea);
      signal.addEventListener('abort', () => gutterResizeObserver.disconnect(), { once: true });
    }

    if (options?.fileId) {
      const f = FS.files.get(options.fileId);
      if (f) {
        file.id = f.id;
        file.name = f.name;
        file.content = f.content ?? '';
        file.modified = false;
        textarea.value = file.content;
      }
    }

    syncGutter();
    syncStatus();
    updateWordWrap();
    requestAnimationFrame(() => textarea.focus());
  },

  async onDrop(droppedFile, _state) {
    try {
      const text = await droppedFile.text();
      if (typeof process !== 'undefined' && process.platform === 'linux') {
        const fs = require('fs').promises;
        const path = require('path');
        if (!droppedFile.name || path.basename(droppedFile.name) !== droppedFile.name) {
          throw new Error(_t('apps.textedit.invalidDropName'));
        }
        const destination = path.join(require('os').homedir(), droppedFile.name);
        await fs.writeFile(destination, text, { encoding: 'utf8', flag: 'wx' });
        WM.createWindow('com.nbosp.textedit', { path: destination });
        Notify.show({ title: _t('apps.textedit.fileOpened'), body: droppedFile.name, type: 'success', appName: 'TextEdit' });
        return;
      }
      const fileId = globalThis.generateId?.() ?? crypto.randomUUID();
      FS.files.set(fileId, {
        id: fileId,
        name: droppedFile.name,
        type: 'text/plain',
        size: droppedFile.size,
        content: text,
        mimeType: droppedFile.type || 'text/plain'
      });
      WM.createWindow('com.nbosp.textedit', { fileId });
      Notify.show({ title: _t('apps.textedit.fileOpened'), body: droppedFile.name, type: 'success', appName: 'TextEdit' });
    } catch (err) {
      Notify.show({
        title: _t('common.error'),
        body: err?.message ?? _t('apps.textedit.failedToOpen'),
        type: 'error',
        appName: 'TextEdit'
      });
    }
  }
});