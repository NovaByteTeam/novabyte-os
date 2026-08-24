function main() {
  const PAIRS = Object.freeze({
    '(': ')', '{': '}', '[': ']', "'": "'", '"': '"', '`': '`'
  });
  const OPENERS = new Set(Object.keys(PAIRS));
  const ASYM_CLOSERS = new Set(
    Object.values(PAIRS).filter(c => !OPENERS.has(c))
  );

  const file = { path: null, name: 'untitled.txt', content: '', modified: false };

  const saveBtn = document.getElementById('save-btn');
  const saveAsBtn = document.getElementById('save-as-btn');
  const openBtn = document.getElementById('open-btn');
  const editorWrap = document.getElementById('editor-wrap');
  const gutter = document.getElementById('gutter');
  const textarea = document.getElementById('quill-text-editor');
  const statusBar = document.getElementById('status-bar');

  let prevLineCount = 0;
  let rafId = 0;

  function syncGutter() {
    const val = textarea.value;
    let count = 1;
    for (let i = 0; i < val.length; i++) {
      if (val.charCodeAt(i) === 10) count++;
    }
    if (count === prevLineCount) return;
    prevLineCount = count;

    const nums = new Array(count);
    for (let i = 0; i < count; i++) nums[i] = i + 1;
    gutter.textContent = nums.join('\n') + '\n';
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

    statusBar.textContent = `Ln ${line}, Col ${col}  ·  ${words} words`;
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

  function spliceText(start, end, insert) {
    textarea.setRangeText(insert, start, end, 'end');
    file.modified = true;
    scheduleUpdate();
  }

  async function notify(title, body, type) {
    // device:notifications is optional — a missing grant should never
    // block save/open, so this is fire-and-forget. Still logged to console
    // so a failure here isn't invisible on top of whatever else failed.
    try {
      await window.nova.ipc('nova:notifications:show', { title, body, type, appName: 'TextEdit' });
    } catch (err) {
      console.error('[TextEdit] notify failed:', err);
    }
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
    if (!file.path) {
      await saveFileAs();
      return;
    }
    try {
      await window.nova.ipc('nova:vfs:write', { path: file.path, content: textarea.value });
      file.content = textarea.value;
      file.modified = false;
      notify('Saved', file.name, 'success');
    } catch (err) {
      console.error('[TextEdit] saveFile failed:', err);
      notify('Save Failed', err?.message ?? 'Unknown error occurred while saving.', 'error');
    }
  }

  async function saveFileAs() {
    try {
      const result = await window.nova.ipc('nova:sysdialog:save', {
        title: 'Save As',
        suggestedName: file.name,
        content: textarea.value,
        mimeType: 'text/plain',
      });
      if (result?.cancelled || !result?.file?.path) return;

      const picked = result.file;
      file.path = picked.path;
      file.name = picked.name ?? picked.path.split('/').pop();
      file.content = textarea.value;
      file.modified = false;

      notify('Saved', file.name, 'success');
    } catch (err) {
      // SystemDialogs is the first-party Save As path; fall back to the
      // simpler dialog service for shells that do not ship SystemDialogs.
      if (err?.code === 'UNAVAILABLE') {
        try {
          const picked = await window.nova.ipc('nova:dialog:save', {
            filename: file.name,
            content: textarea.value,
          });
          if (!picked || !picked.path) return;

          file.path = picked.path;
          file.name = picked.name ?? picked.path.split('/').pop();
          file.content = textarea.value;
          file.modified = false;

          notify('Saved', file.name, 'success');
          return;
        } catch (fallbackErr) {
          console.error('[TextEdit] saveFileAs fallback failed:', fallbackErr);
          notify('Save Failed', fallbackErr?.message ?? 'Unknown error occurred while saving.', 'error');
          return;
        }
      }

      console.error('[TextEdit] saveFileAs failed:', err);
      notify('Save Failed', err?.message ?? 'Unknown error occurred while saving.', 'error');
    }
  }

  async function openFile() {
    try {
      const result = await window.nova.ipc('nova:sysdialog:open', {
        title: 'Open',
      });
      if (result?.cancelled || !result?.file) return;

      const picked = result.file;
      if (!picked.path) return;

      file.path = picked.path;
      file.name = picked.name ?? 'untitled.txt';
      file.content = picked.content ?? '';
      file.modified = false;

      textarea.value = file.content;
      syncGutter();
      syncStatus();
      notify('Opened', file.name, 'success');
    } catch (err) {
      console.error('[TextEdit] openFile failed:', err);
      notify('Open Failed', err?.message ?? 'Unknown error occurred while opening.', 'error');
    }
  }

  function buildContextMenu(x, y) {
    // No shell ContextMenu service inside the sandbox — a minimal
    // native menu covers the same actions.
    const existing = document.getElementById('quill-ctx-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'quill-ctx-menu';
    Object.assign(menu.style, {
      position: 'fixed', left: x + 'px', top: y + 'px',
      background: '#0e121c', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '10px',
      padding: '4px', fontSize: '12px', color: '#e6edf3', zIndex: 1000,
      boxShadow: '0 8px 32px rgba(0,0,0,0.6)', minWidth: '140px',
    });

    const items = [
      { label: 'Cut', action: doCut },
      { label: 'Copy', action: doCopy },
      { label: 'Paste', action: doPaste },
      { label: 'Select All', action: () => { textarea.focus(); textarea.select(); } },
      { label: 'Word Count', action: () => {
        const n = countWords(textarea.value);
        notify('Word Count', `${n} word${n !== 1 ? 's' : ''}`, 'info');
      } },
    ];

    for (const item of items) {
      const row = document.createElement('div');
      row.textContent = item.label;
      Object.assign(row.style, { padding: '6px 10px', cursor: 'pointer', borderRadius: '4px' });
      row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,0.08)'; });
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
      row.addEventListener('click', () => { item.action(); menu.remove(); });
      menu.appendChild(row);
    }

    document.body.appendChild(menu);
    const closeMenu = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
  }

  saveBtn.addEventListener('click', saveFile);
  saveAsBtn.addEventListener('click', saveFileAs);
  openBtn.addEventListener('click', openFile);
  editorWrap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    buildContextMenu(e.clientX, e.clientY);
  });
  editorWrap.addEventListener('click', (e) => {
    if (e.target === gutter) textarea.focus();
  });

  textarea.addEventListener('input', () => { file.modified = true; scheduleUpdate(); }, { passive: true });
  textarea.addEventListener('scroll', () => { gutter.scrollTop = textarea.scrollTop; }, { passive: true });
  textarea.addEventListener('click', syncStatus, { passive: true });
  textarea.addEventListener('keyup', syncStatus, { passive: true });
  textarea.addEventListener('keydown', onKeydown);

  // Native drag-and-drop replaces the shell's onDrop hook — reads the
  // dropped file locally and lets the user Save As to persist it to VFS.
  document.body.addEventListener('dragover', (e) => e.preventDefault());
  document.body.addEventListener('drop', async (e) => {
    e.preventDefault();
    const dropped = e.dataTransfer?.files?.[0];
    if (!dropped) return;
    try {
      const text = await dropped.text();
      file.path = null;
      file.name = dropped.name;
      file.content = text;
      file.modified = true;
      textarea.value = text;
      syncGutter();
      syncStatus();
      notify('File Opened', dropped.name, 'success');
    } catch (err) {
      notify('Error', err?.message ?? 'Failed to open file.', 'error');
    }
  });

  syncGutter();
  syncStatus();
  requestAnimationFrame(() => textarea.focus());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
