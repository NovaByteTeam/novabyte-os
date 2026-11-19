registerApp({
  id: 'com.nbosp.devconsole',
  name: 'Console',
  icon: window.__novaUnrestrictedPackage?.manifest?.icon || 'assets/icon.svg',
  description: 'Evaluate JS in the OS context',
  category: 'developer',
  version: '3.0.2',
  devOnly: true,
  defaultSize: [600, 500],
  minSize: [400, 300],
  // eval() runs with full OS-context privileges, no sandboxing here.
  // Keep this app's permission set narrow anyway — it doesn't need
  // fs/net grants of its own, since eval'd code isn't restricted by
  // the permission system to begin with. Don't read that as "safe";
  // it's the opposite: nothing in this app can be scoped down further.
  init(content, state, options) {
    if (!window.AppDirs?.getAppDataPath('com.nbosp.settings', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.settings</b><br>' + _t('apps.devconsole.appDataMissing') + '<br>' + _t('apps.devconsole.requiresNovaByte') + '</div>';
      return;
    }

    if (!OS.settings.get('devMode')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">🔒</div><div style="font-size:14px;text-align:center">' + _t('apps.devconsole.devModeRequired') + '</div>';
      return;
    }

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-base);color:var(--text-primary);font-family:var(--font-ui,sans-serif);overflow:hidden;padding:16px;font-size:13px;box-sizing:border-box;';

    // Declared up front, not near the bottom where it originally lived —
    // several listeners registered earlier in this function (search,
    // clear, export, autocomplete) now need ac.signal too, and referencing
    // a const before its declaration throws (temporal dead zone), not
    // just silently reads undefined.
    const ac = new AbortController();

    const outputToolbar = createEl('div', { style: 'display:flex;gap:8px;margin-bottom:8px;flex-shrink:0;' });
    const searchInput = createEl('input', {
      placeholder: _t('apps.devconsole.filterPlaceholder'),
      style: 'flex:1;padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:11px;box-sizing:border-box;'
    });
    const clearBtn = createEl('button', { textContent: _t('apps.devconsole.clear'), title: _t('apps.devconsole.clearTitle'), style: 'padding:5px 10px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;' });
    const exportBtn = createEl('button', { textContent: _t('apps.devconsole.export'), title: _t('apps.devconsole.exportTitle'), style: 'padding:5px 10px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;' });
    outputToolbar.appendChild(searchInput);
    outputToolbar.appendChild(clearBtn);
    outputToolbar.appendChild(exportBtn);

    const inputRow = createEl('div', { style: 'display:flex;gap:8px;margin-bottom:12px;align-items:flex-start;flex-shrink:0;' });
    // textarea instead of <input> so Shift+Enter can insert a newline for
    // multi-line snippets (e.g. a small for-loop). Enter alone still runs.
    const input = createEl('textarea', {
      placeholder: _t('apps.devconsole.inputPlaceholder'),
      rows: '2',
      style: 'flex:1;padding:8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:12px;resize:vertical;min-height:36px;max-height:160px;'
    });
    const runBtn = createEl('button', { textContent: _t('apps.devconsole.run'), style: 'padding:8px 16px;background:var(--accent);color:var(--text-on-accent);border:none;border-radius:4px;cursor:pointer;flex-shrink:0;' });
    const output = createEl('pre', { textContent: _t('apps.devconsole.readyMessage') + '\n', style: 'flex:1;padding:12px;background:var(--bg-elevated);border-radius:6px;border:1px solid var(--border-subtle);overflow:auto;font-size:12px;color:var(--text-muted);margin:0;white-space:pre-wrap;word-break:break-word;' });

    let hasRun = false;
    let outputSearch = '';

    // Output was appended to forever with no cap. A long dev session could
    // grow this string to megabytes, and textContent += on a <pre> replaces
    // the whole text node each time, so writes get slower as history grows.
    // Keep a bounded ring buffer of entries and re-render from that instead.
    const MAX_ENTRIES = 200;
    const entries = [];

    // Re-renders from `entries` applying the current search filter — kept
    // separate from pushEntry so typing in the filter box can re-render
    // without appending anything, and so pushEntry doesn't need to know
    // about search state at all.
    function renderOutput() {
      const q = outputSearch.trim().toLowerCase();
      const visible = q ? entries.filter(e => e.toLowerCase().includes(q)) : entries;
      output.textContent = visible.length ? visible.join('') : (q ? _t('apps.devconsole.noOutputMatches', { query: outputSearch }) : '');
      output.scrollTop = output.scrollHeight;
    }

    function pushEntry(text) {
      entries.push(text);
      if (entries.length > MAX_ENTRIES) entries.shift();
      renderOutput();
    }

    searchInput.addEventListener('input', () => { outputSearch = searchInput.value; renderOutput(); }, { signal: ac.signal });

    clearBtn.addEventListener('click', () => {
      entries.length = 0;
      hasRun = true; // matches the "first real run" reset path — clearing counts as having started a session
      renderOutput();
    }, { signal: ac.signal });

    exportBtn.addEventListener('click', async () => {
      if (!entries.length) return;
      try {
        if (typeof window.SystemDialogs?.saveContent !== 'function') {
          throw new Error(_t('apps.sysdialog.unavailable'));
        }
        const destination = await window.SystemDialogs.saveContent({
          title: _t('apps.devconsole.exportDialogTitle'),
          suggestedName: 'nbosp-console-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt',
          accept: '.txt',
        }, entries.join(''));
        if (!destination) return;
        Notify.show({
          title: _t('apps.devconsole.exportedTitle'),
          body: _t('apps.devconsole.exportedBody', { path: destination.path }),
          type: 'success',
          appName: 'Console',
        });
      } catch (error) {
        console.error('[Console] Export failed:', error);
        Notify.show({
          title: _t('apps.devconsole.exportFailedTitle'),
          body: error.message,
          type: 'error',
          appName: 'Console',
        });
      }
    }, { signal: ac.signal });


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

    // ── Capture console.* calls made by eval'd code ─────────────────────
    // Without this, code like `console.log('debug', x)` inside an eval'd
    // snippet only shows in the browser's real DevTools console — which
    // defeats the point of an in-app console meant to be usable without
    // DevTools open. Patches window.console for the duration of eval only
    // (try/finally restores it even if eval throws), and still forwards
    // to the real console methods so DevTools users see it too — this is
    // additive capture, not a silent redirect.
    const REAL_CONSOLE = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    // NOTE: this must be async. If fn() returns a promise (e.g. the user's
    // eval'd code is an async IIFE), the old synchronous version restored
    // the real console.* methods in `finally` the instant fn() returned —
    // which happens immediately, before any of that promise's *own*
    // console.log calls actually run on the microtask queue. Those calls
    // still hit the real console (nothing throws), but by then `captured`
    // has already been read out empty by the caller, so the in-app Console
    // silently shows no output even though the code succeeded. Awaiting a
    // thenable result here keeps capture active until the async code is
    // actually done running.
    async function withCapturedConsole(fn) {
      const captured = [];
      const wrap = (level) => (...args) => {
        captured.push({ level, text: args.map(a => {
          if (typeof a === 'string') return a;
          try { return formatResult(a); } catch { return String(a); }
        }).join(' ') });
        REAL_CONSOLE[level].apply(console, args);
      };
      console.log = wrap('log');
      console.warn = wrap('warn');
      console.error = wrap('error');
      console.info = wrap('info');
      try {
        let result = fn();
        if (result && typeof result.then === 'function') {
          result = await result;
        }
        return { result, captured };
      } finally {
        console.log = REAL_CONSOLE.log;
        console.warn = REAL_CONSOLE.warn;
        console.error = REAL_CONSOLE.error;
        console.info = REAL_CONSOLE.info;
      }
    }

    // ── Persisted command history (↑/↓ navigation) ──────────────────────
    // Lives in the dev hive (HKND/console/history — same home as the Event
    // Viewer's filters/views); the scoped localStorage key is the pre-
    // registry seed and the fail-soft fallback.
    const HISTORY_KEY = 'nbosp_devconsole_history';
    const HISTORY_REG_PATH = 'HKND/console/history';
    const MAX_HISTORY = 100;
    function devReg() {
      return (typeof window !== 'undefined' && window.NovaRegistry && typeof window.NovaRegistry.get === 'function')
        ? window.NovaRegistry : null;
    }
    let cmdHistory = [];
    try {
      const r = devReg();
      let raw = null;
      if (r) { try { raw = r.get(HISTORY_REG_PATH); } catch (_) { raw = null; } }
      if (raw === null || raw === undefined) {
        raw = localStorage.getItem(HISTORY_KEY);
        if (raw) cmdHistory = JSON.parse(raw);
      } else {
        cmdHistory = raw;
      }
      if (!Array.isArray(cmdHistory)) cmdHistory = [];
    } catch {
      cmdHistory = [];
    }
    let historyIndex = cmdHistory.length; // one past the end = "not browsing"
    let draftBeforeHistory = '';

    function saveHistory() {
      try {
        const r = devReg();
        if (r) {
          try { r.set(HISTORY_REG_PATH, cmdHistory, { type: 'REG_JSON', source: 'devconsole' }); return; }
          catch (_) { /* fall through to legacy */ }
        }
        if (typeof lsSave === 'function') lsSave(HISTORY_KEY, cmdHistory);
        else localStorage.setItem(HISTORY_KEY, JSON.stringify(cmdHistory));
      } catch {
        // Best-effort — same degrade-silently pattern other apps use for
        // storage failures (quota, private mode, etc).
      }
    }

    // AbortController declared at the top of init() now — see comment
    // there. Kept this section marker so the surrounding code's original
    // structure/order is still easy to follow.

    async function run() {
      let code = input.value.trim();
      if (!code) return;
      if (!hasRun) {
        entries.length = 0;
        output.style.color = 'var(--text-primary)';
        hasRun = true;
      }
      // `reg ...` lines route to the Registry CLI (reg.exe flavor) instead
      // of eval() — window.RegCLI comes from js/platform/core/nova-reg-cli.js.
      if (/^reg\b/.test(code) && window.RegCLI) {
        let text;
        try {
          text = window.RegCLI.run(code, window.NovaRegistry, window.NovaRegFile);
        } catch (err) {
          text = 'ERROR: ' + (err && err.message ? err.message : String(err));
        }
        pushEntry(`\n> ${code}\n${text}\n`);
      } else {
        try {
          const { result, captured } = await withCapturedConsole(() => eval(code));
          let out = `\n> ${code}\n`;
          if (captured.length) {
            out += captured.map(c => `${c.level === 'error' ? '✗' : c.level === 'warn' ? '⚠' : '·'} ${c.text}`).join('\n') + '\n';
          }
          out += formatResult(result) + '\n';
          pushEntry(out);
        } catch (e) {
          pushEntry(`\n> ${code}\nError: ${e.message}\n`);
        }
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
      hideCompletions();
    }

    // ── Autocomplete ─────────────────────────────────────────────────────
    // Splits input on the last '.' — everything before is evaluated (in a
    // try/catch, since a partial/incomplete expression like "OS.wind"
    // before the dot is still a complete, valid sub-expression up to that
    // point) to get a live object, then Object.keys + the prototype chain
    // (own enumerable props alone miss most built-in/class methods, e.g.
    // Map.prototype.get wouldn't show for a Map instance otherwise) are
    // filtered against whatever's typed after the dot. No completion for
    // top-level identifiers with no dot (e.g. "OS" alone) — matching
    // against `window`'s hundreds of global properties is noisy enough to
    // not be worth it, and dotted-path completion covers the actual use
    // case (exploring a known object's shape).
    function getCompletions(text) {
      const lastDot = text.lastIndexOf('.');
      if (lastDot === -1) return null;
      const base = text.slice(0, lastDot);
      const prefix = text.slice(lastDot + 1);
      if (!base.trim()) return null;
      let obj;
      try {
        obj = eval(base);
      } catch {
        return null; // base doesn't evaluate (yet) — not an error, just no suggestions
      }
      if (obj === null || obj === undefined) return null;
      const names = new Set();
      let cur = obj;
      let depth = 0;
      // Walk the prototype chain, capped, so this can't spin on a
      // pathological/proxy object with a broken __proto__ cycle.
      while (cur && depth < 6) {
        Object.getOwnPropertyNames(cur).forEach(n => names.add(n));
        cur = Object.getPrototypeOf(cur);
        depth++;
      }
      const matches = [...names]
        .filter(n => n.startsWith(prefix) && n !== prefix && !/^\d+$/.test(n)) // skip array-index-like keys, noisy for arrays
        .sort()
        .slice(0, 12); // cap suggestion list length, not a full IDE
      return matches.length ? { base, lastDot, prefix, matches } : null;
    }

    const acBox = createEl('div', {
      style: 'position:absolute;display:none;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;font-family:monospace;font-size:11px;z-index:20;max-height:160px;overflow:auto;box-shadow:0 4px 12px rgba(0,0,0,0.3);'
    });
    document.body.appendChild(acBox);
    state.cleanups.push(() => acBox.remove());

    let acState = null; // { matches, base, lastDot, selected }

    function hideCompletions() {
      acState = null;
      acBox.style.display = 'none';
    }

    function applyCompletion(name) {
      if (!acState) return;
      input.value = acState.base + '.' + name;
      input.selectionStart = input.selectionEnd = input.value.length;
      hideCompletions();
      input.focus();
    }

    function renderCompletions() {
      if (!acState) { acBox.style.display = 'none'; return; }
      acBox.innerHTML = '';
      acState.matches.forEach((name, i) => {
        const item = createEl('div', {
          textContent: name,
          style: 'padding:4px 10px;cursor:pointer;color:var(--text-primary);' + (i === acState.selected ? 'background:var(--accent);color:var(--text-on-accent);' : '')
        });
        item.addEventListener('mousedown', (e) => { e.preventDefault(); applyCompletion(name); }, { signal: ac.signal });
        acBox.appendChild(item);
      });
      const rect = input.getBoundingClientRect();
      acBox.style.left = rect.left + 'px';
      acBox.style.top = (rect.top - Math.min(acState.matches.length, 6) * 22 - 8) + 'px'; // above the input, textarea can grow downward into the output pane
      acBox.style.width = Math.min(rect.width, 260) + 'px';
      acBox.style.display = 'block';
    }

    function updateCompletions() {
      const c = getCompletions(input.value.slice(0, input.selectionStart));
      if (!c) { hideCompletions(); return; }
      acState = { ...c, selected: 0 };
      renderCompletions();
    }

    runBtn.addEventListener('click', run, { signal: ac.signal });

    input.addEventListener('keydown', (e) => {
      // Tab cycles/accepts the current suggestion when the dropdown is
      // open — checked first so it takes priority over the textarea's
      // default focus-shift behavior and doesn't fall through to the
      // history/run handling below.
      if (acState && e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) acState.selected = (acState.selected - 1 + acState.matches.length) % acState.matches.length;
        else acState.selected = (acState.selected + 1) % acState.matches.length;
        renderCompletions();
        return;
      }
      if (acState && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        applyCompletion(acState.matches[acState.selected]);
        return;
      }
      if (acState && e.key === 'Escape') {
        e.preventDefault();
        hideCompletions();
        return;
      }

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

    input.addEventListener('input', updateCompletions, { signal: ac.signal });
    input.addEventListener('blur', () => {
      // Small delay, not instant hide: the mousedown handler on a
      // suggestion item needs to fire before blur would otherwise wipe
      // acState out from under it (blur fires before click on most
      // browsers' event order) — mousedown's preventDefault already
      // stops the textarea from losing focus in the first place, so this
      // is just a safety net for stray blur events, not the primary path.
      setTimeout(hideCompletions, 100);
    }, { signal: ac.signal });

    // state.cleanups.push is the real teardown contract the window manager
    // honors — init()'s return value is discarded, so returning a cleanup
    // fn here (as some other apps in this codebase do) would silently do
    // nothing. This is what actually releases the listeners on close.
    // wm.js always sets state.cleanups = [] before init() runs, so no
    // optional chaining needed here — if it were ever missing that'd be
    // a real bug worth seeing, not something to silently swallow.
    state.cleanups.push(() => ac.abort());

    // ── Live re-localisation ──────────────────────────────────────────
    // Rebuild this window's labels when the OS language changes, so an
    // already-open console follows the switch in real time. Command history
    // survives: entries/cmdHistory are never rebuilt — only the static
    // chrome is relabelled, and renderOutput() re-renders from the
    // untouched ring buffer (which also refreshes the filter's "no output
    // matches" line in the new language).
    const localeHandler = () => {
      try {
        window.NovaI18n?.applyStaticDom?.(content);
        searchInput.placeholder = _t('apps.devconsole.filterPlaceholder');
        clearBtn.textContent = _t('apps.devconsole.clear');
        clearBtn.title = _t('apps.devconsole.clearTitle');
        exportBtn.textContent = _t('apps.devconsole.export');
        exportBtn.title = _t('apps.devconsole.exportTitle');
        input.placeholder = _t('apps.devconsole.inputPlaceholder');
        runBtn.textContent = _t('apps.devconsole.run');
        if (hasRun || outputSearch.trim()) {
          renderOutput();
        } else {
          // Pre-run surface: the ready message is not part of `entries`, so
          // relabel it directly rather than via renderOutput().
          output.textContent = _t('apps.devconsole.readyMessage') + '\n';
        }
      } catch (error) {
        console.warn('[DevConsole] Language change re-render failed:', error);
      }
    };
    typeof OS !== 'undefined' && OS.events?.on?.('languageChanged', localeHandler);
    state.cleanups.push(() => typeof OS !== 'undefined' && OS.events?.off?.('languageChanged', localeHandler));

    inputRow.appendChild(input);
    inputRow.appendChild(runBtn);
    content.appendChild(outputToolbar);
    content.appendChild(inputRow);
    content.appendChild(output);
  }
});