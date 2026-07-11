registerApp({
  id: 'devconsole',
  name: 'Console',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiIgd2lkdGg9Ijk0IiBoZWlnaHQ9Ijk0Ij4KICA8ZGVmcz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0iY29uLWJvZHkiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzMzNDE1NSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMwZjE3MmEiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImNvbi1iYXIiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIwIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzQ3NTU2OSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMxZTI5M2IiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgPC9kZWZzPgogIDwhLS0gc2hhZG93IC0tPgogIDxlbGxpcHNlIGN4PSI0OCIgY3k9IjkwIiByeD0iMzAiIHJ5PSI2IiBmaWxsPSIjMDAwIiBvcGFjaXR5PSIwLjE4Ii8+CgogIDwhLS0gd2luZG93IGJvZHkgLS0+CiAgPHJlY3QgeD0iMTQiIHk9IjIwIiB3aWR0aD0iNjgiIGhlaWdodD0iNTQiIHJ4PSI4IiBmaWxsPSJ1cmwoI2Nvbi1ib2R5KSIvPgogIDwhLS0gdGl0bGUgYmFyIC0tPgogIDxyZWN0IHg9IjE0IiB5PSIyMCIgd2lkdGg9IjY4IiBoZWlnaHQ9IjE0IiByeD0iOCIgZmlsbD0idXJsKCNjb24tYmFyKSIvPgogIDxyZWN0IHg9IjE0IiB5PSIyNyIgd2lkdGg9IjY4IiBoZWlnaHQ9IjciIGZpbGw9InVybCgjY29uLWJhcikiLz4KICA8Y2lyY2xlIGN4PSIyMiIgY3k9IjI3IiByPSIyLjUiIGZpbGw9IiNmODcxNzEiLz4KICA8Y2lyY2xlIGN4PSIzMCIgY3k9IjI3IiByPSIyLjUiIGZpbGw9IiNmYmJmMjQiLz4KICA8Y2lyY2xlIGN4PSIzOCIgY3k9IjI3IiByPSIyLjUiIGZpbGw9IiM0YWRlODAiLz4KCiAgPCEtLSBwcm9tcHQgY2FyZXQgKyBjdXJzb3IgLS0+CiAgPHBvbHlsaW5lIHBvaW50cz0iMjQsNDggMzQsNTQgMjQsNjAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzRhZGU4MCIgc3Ryb2tlLXdpZHRoPSIzLjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgogIDxsaW5lIHgxPSI0MCIgeTE9IjYwIiB4Mj0iNTgiIHkyPSI2MCIgc3Ryb2tlPSIjNGFkZTgwIiBzdHJva2Utd2lkdGg9IjMuMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+CiAgPHJlY3QgeD0iNjMiIHk9IjQ1IiB3aWR0aD0iNyIgaGVpZ2h0PSIxMiIgZmlsbD0iI2EzZTYzNSIgb3BhY2l0eT0iMC45Ii8+CgogIDwhLS0gaGlnaGxpZ2h0IC0tPgogIDxyZWN0IHg9IjE0IiB5PSIyMCIgd2lkdGg9IjY4IiBoZWlnaHQ9IjE0IiByeD0iOCIgZmlsbD0iI2ZmZiIgb3BhY2l0eT0iMC4wOCIvPgo8L3N2Zz4K',
  description: 'Evaluate JS in the OS context',
  category: 'developer',
  devOnly: true,
  autoGrant: true,
  defaultSize: [600, 500],
  minSize: [400, 300],
  // eval() runs with full OS-context privileges, no sandboxing here.
  // Keep this app's permission set narrow anyway — it doesn't need
  // fs/net grants of its own, since eval'd code isn't restricted by
  // the permission system to begin with. Don't read that as "safe";
  // it's the opposite: nothing in this app can be scoped down further.
  permissions: ['system:info', 'system:settings'],
  init(content, state, options) {
    if (!window.AppDirs?.getVFSDir('com.nbosp.settings', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.settings</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
      return;
    }

    if (!OS.settings.get('devMode')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">🔒</div><div style="font-size:14px;text-align:center">Enable Developer Mode in Settings to use Console.</div>';
      return;
    }

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-default,#0f1115);color:var(--text-primary,#e6e6e6);font-family:var(--font-ui,sans-serif);overflow:hidden;padding:16px;font-size:13px;box-sizing:border-box;';

    const inputRow = createEl('div', { style: 'display:flex;gap:8px;margin-bottom:12px;align-items:flex-start;flex-shrink:0;' });
    // textarea instead of <input> so Shift+Enter can insert a newline for
    // multi-line snippets (e.g. a small for-loop). Enter alone still runs.
    const input = createEl('textarea', {
      placeholder: 'Enter JS to evaluate, e.g. OS.windows.size\nEnter to run · Shift+Enter for newline · ↑/↓ for history',
      rows: '2',
      style: 'flex:1;padding:8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:12px;resize:vertical;min-height:36px;max-height:160px;'
    });
    const runBtn = createEl('button', { textContent: 'Run', style: 'padding:8px 16px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;flex-shrink:0;' });
    const output = createEl('pre', { textContent: 'Console ready. Type an expression above and press Enter or Run.\nShift+Enter for a newline, ↑/↓ to recall previous commands.\n', style: 'flex:1;padding:12px;background:var(--bg-elevated);border-radius:6px;border:1px solid var(--border-subtle);overflow:auto;font-size:12px;color:var(--text-muted);margin:0;white-space:pre-wrap;word-break:break-word;' });

    let hasRun = false;

    // Output was appended to forever with no cap. A long dev session could
    // grow this string to megabytes, and textContent += on a <pre> replaces
    // the whole text node each time, so writes get slower as history grows.
    // Keep a bounded ring buffer of entries and re-render from that instead.
    const MAX_ENTRIES = 200;
    const entries = [];

    function pushEntry(text) {
      entries.push(text);
      if (entries.length > MAX_ENTRIES) entries.shift();
      output.textContent = entries.join('');
      output.scrollTop = output.scrollHeight;
    }

    // ── Safe result formatting ──────────────────────────────────────────
    // JSON.stringify throws on circular references and silently drops
    // functions/undefined/symbols. Since eval'd code can return literally
    // anything (DOM nodes, OS.windows Map entries, functions, circular
    // structures), format defensively instead of letting one bad result
    // break the whole console.
    function formatResult(result) {
      if (result === undefined) return 'undefined';
      if (result === null) return 'null';
      const t = typeof result;
      if (t === 'function') return `[Function: ${result.name || 'anonymous'}]`;
      if (t !== 'object') return String(result);
      if (result instanceof Node) {
        return `[${result.nodeName}${result.id ? '#' + result.id : ''}${result.className ? '.' + String(result.className).trim().replace(/\s+/g, '.') : ''}]`;
      }
      if (result instanceof Map) {
        return `Map(${result.size}) ${formatResult(Object.fromEntries(result))}`;
      }
      if (result instanceof Set) {
        return `Set(${result.size}) ${formatResult([...result])}`;
      }
      try {
        return JSON.stringify(result, null, 2);
      } catch (e) {
        // Circular reference or other stringify failure — fall back to a
        // best-effort inspection instead of losing the result entirely.
        try {
          return String(result);
        } catch {
          return `[Unserializable ${result.constructor?.name || 'object'}]`;
        }
      }
    }

    // ── Persisted command history (↑/↓ navigation) ──────────────────────
    // Scoped key to avoid collision with other apps' localStorage usage
    // (calendar/contacts/etc. all write to their own plain-string keys via
    // lsSave, confirmed in base-utils.js — there's no enforced namespace,
    // so this app needs its own distinct key).
    const HISTORY_KEY = 'nbosp_devconsole_history';
    const MAX_HISTORY = 100;
    let cmdHistory = [];
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) cmdHistory = JSON.parse(raw);
      if (!Array.isArray(cmdHistory)) cmdHistory = [];
    } catch {
      cmdHistory = [];
    }
    let historyIndex = cmdHistory.length; // one past the end = "not browsing"
    let draftBeforeHistory = '';

    function saveHistory() {
      try {
        if (typeof lsSave === 'function') lsSave(HISTORY_KEY, cmdHistory);
        else localStorage.setItem(HISTORY_KEY, JSON.stringify(cmdHistory));
      } catch {
        // Best-effort — same degrade-silently pattern other apps use for
        // storage failures (quota, private mode, etc).
      }
    }

    // AbortController lets both listeners below be torn down with one call
    // instead of tracking each removal by hand. This app previously
    // registered no cleanup at all, so state.cleanups had nothing to call
    // when the window closed — see the push at the bottom of this function.
    const ac = new AbortController();

    function run() {
      const code = input.value.trim();
      if (!code) return;
      if (!hasRun) {
        entries.length = 0;
        output.style.color = 'var(--text-primary)';
        hasRun = true;
      }
      try {
        const result = eval(code);
        pushEntry(`\n> ${code}\n${formatResult(result)}\n`);
      } catch (e) {
        pushEntry(`\n> ${code}\nError: ${e.message}\n`);
      }

      // Push to history unless it's an exact repeat of the last command —
      // avoids polluting recall with repeated Enter-spam of the same line.
      if (cmdHistory[cmdHistory.length - 1] !== code) {
        cmdHistory.push(code);
        if (cmdHistory.length > MAX_HISTORY) cmdHistory.shift();
        saveHistory();
      }
      historyIndex = cmdHistory.length;
      draftBeforeHistory = '';

      input.value = '';
      input.style.height = '';
    }

    runBtn.addEventListener('click', run, { signal: ac.signal });

    input.addEventListener('keydown', (e) => {
      // isComposing is true while an IME candidate is still being chosen
      // (Japanese/Chinese/Korean input, etc). The Enter that confirms the
      // candidate shouldn't also submit the line — without this check,
      // confirming a candidate would run half-typed code on that Enter.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        run();
        return;
      }

      // Only browse history when the cursor is at the start/end of the
      // textarea — otherwise ↑/↓ inside a multi-line snippet should move
      // the cursor between lines like a normal textarea, not hijack it.
      if (e.key === 'ArrowUp' && input.selectionStart === 0 && input.selectionEnd === 0) {
        if (cmdHistory.length === 0) return;
        e.preventDefault();
        if (historyIndex === cmdHistory.length) draftBeforeHistory = input.value;
        historyIndex = Math.max(0, historyIndex - 1);
        input.value = cmdHistory[historyIndex];
        input.selectionStart = input.selectionEnd = 0;
      } else if (e.key === 'ArrowDown' && input.selectionStart === input.value.length && input.selectionEnd === input.value.length) {
        if (historyIndex >= cmdHistory.length) return;
        e.preventDefault();
        historyIndex++;
        input.value = historyIndex === cmdHistory.length ? draftBeforeHistory : cmdHistory[historyIndex];
        const end = input.value.length;
        input.selectionStart = input.selectionEnd = end;
      }
    }, { signal: ac.signal });

    // state.cleanups.push is the real teardown contract the window manager
    // honors — init()'s return value is discarded, so returning a cleanup
    // fn here (as some other apps in this codebase do) would silently do
    // nothing. This is what actually releases the listeners on close.
    // wm.js always sets state.cleanups = [] before init() runs, so no
    // optional chaining needed here — if it were ever missing that'd be
    // a real bug worth seeing, not something to silently swallow.
    state.cleanups.push(() => ac.abort());

    inputRow.appendChild(input);
    inputRow.appendChild(runBtn);
    content.appendChild(inputRow);
    content.appendChild(output);
  }
});