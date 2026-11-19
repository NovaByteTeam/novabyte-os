registerApp({
  id: 'com.nbosp.modules',
  name: 'Modules',
  version: '3.0.2',
  icon: window.__novaUnrestrictedPackage?.manifest?.icon || 'assets/icon.svg',
  description: 'Hot-reload OS JS modules without restarting NovaByte OS',
  category: 'developer',
  devOnly: true,
  defaultSize: [600, 600],
  minSize: [420, 380],
  // Fetches arbitrary internal module paths and dynamically imports the
  // response — functionally equivalent to remote code execution against
  // the OS's own module tree. Treat this as high-trust, same tier as
  // net:internal + system:settings, not just system:info.
  init(content, state, options) {
    if (!window.AppDirs?.getAppDataPath('com.nbosp.settings', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.settings</b><br>' + _t('apps.modules.guard.appDataMissing') + '<br>' + _t('apps.modules.guard.requiresNovaByte') + '</div>';
      return;
    }

    if (!OS.settings.get('devMode')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">🔒</div><div style="font-size:14px;text-align:center">' + _t('apps.modules.guard.devModeRequired') + '</div>';
      return;
    }

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-base);color:var(--text-primary);font-family:var(--font-ui,sans-serif);overflow:hidden;padding:16px;font-size:13px;box-sizing:border-box;';

    const desc = createEl('div', { style: 'margin-bottom:12px;color:var(--text-muted);font-size:12px;flex-shrink:0;' });
    desc.textContent = _t('apps.modules.desc');
    content.appendChild(desc);

    // Defaults kept as a starting point, but the list is now editable and
    // persisted — the original hardcoded array meant any module outside
    // this exact set of 8 paths couldn't be hot-reloaded from this app at
    // all. Scoped storage key, same pattern as devconsole's history (see
    // console.js) since there is no filesystem helper for small app
    // state — lsSave/localStorage is what calendar.js, contacts.js, etc.
    // actually use.
    // Config surfaces (module list + safety overrides) live in this app's
    // registry slice (HKNA/com.nbosp.modules/{list,safety} via NovaAppConfig);
    // the scoped localStorage keys are the pre-registry seeds and the
    // fail-soft fallbacks. The reload HISTORY stays on localStorage
    // deliberately — it stores whole file contents (bulk data, not config;
    // Windows keeps documents out of the registry too).
    const STORAGE_KEY = 'nbosp_modules_list';
    const SAFETY_KEY = 'nbosp_modules_safety';   // { [path]: 'safe' | 'unsafe' } manual overrides
    const HISTORY_KEY = 'nbosp_modules_history'; // { [path]: { prevCode, newCode, ts } } last reload only
    const MODULES_REG_SLICE = 'com.nbosp.modules';
    const DEFAULT_MODULES = [
      { id: 'boot', path: 'js/core/core/boot.js' },
      { id: 'wm', path: 'js/apps/shell-ui/wm.js' },
      { id: 'fs', path: 'js/core/services/fs.js' },
      { id: 'app-registry', path: 'js/platform/core/app-registry.js' },
      { id: 'app-permission-manager', path: 'js/platform/security/app-permission-manager.js' },
      { id: 'system-events', path: 'js/apps/system-events/service.js' },
      { id: 'base-utils', path: 'js/core/utils/base-utils.js' },
      { id: 'debug-overlay', path: 'js/apps/debug-overlay/service.js' },
    ];
    const LEGACY_DEBUG_OVERLAY_PATH = 'js/core/utils/debug-overlay.js';
    const DEBUG_OVERLAY_PATH = 'js/apps/debug-overlay/service.js';

    function loadJSON(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        const val = raw ? JSON.parse(raw) : null;
        return val ?? fallback;
      } catch {
        return fallback;
      }
    }
    function saveJSON(key, val) {
      try {
        if (typeof lsSave === 'function') lsSave(key, val);
        else localStorage.setItem(key, JSON.stringify(val));
      } catch {
        // Best-effort — same degrade-silently pattern used elsewhere for
        // storage failures (quota, private mode, etc).
      }
    }

    let modules = loadJSON(STORAGE_KEY, null);
    if (typeof window !== 'undefined' && window.NovaAppConfig) {
      try {
        const stored = window.NovaAppConfig.get(MODULES_REG_SLICE, 'list', { legacyKey: STORAGE_KEY, fallback: null });
        if (Array.isArray(stored) && stored.length) modules = stored;
      } catch { /* fall back to the localStorage read above */ }
    }
    if (!Array.isArray(modules) || !modules.length) modules = DEFAULT_MODULES.slice();
    let modulesPathMigrated = false;
    modules = modules.map(module => {
      if (module?.path !== LEGACY_DEBUG_OVERLAY_PATH) return module;
      modulesPathMigrated = true;
      return { ...module, path: DEBUG_OVERLAY_PATH };
    });

    // Manual safe/unsafe overrides, keyed by path. Auto-detection (see
    // isDangerous below) is a heuristic and can be wrong in both
    // directions — a module might assign window.X without being a
    // singleton other code depends on, or might be dangerous via some
    // other pattern the heuristic doesn't catch. This lets the user
    // correct it per-module instead of being stuck with the guess.
    let safety = loadJSON(SAFETY_KEY, {});
    if (typeof window !== 'undefined' && window.NovaAppConfig) {
      try {
        const stored = window.NovaAppConfig.get(MODULES_REG_SLICE, 'safety', { legacyKey: SAFETY_KEY, fallback: null });
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) safety = stored;
      } catch { /* fall back to the localStorage read above */ }
    }

    // Last reload only, keyed by path — { prevCode, newCode, ts }.
    // Backs both the diff view and undo. Deliberately not a full history
    // stack: unbounded growth of full file contents in localStorage would
    // risk hitting quota fast, and "undo the last reload" covers the
    // actual use case (a reload just made something worse).
    let reloadHistory = loadJSON(HISTORY_KEY, {});

    function saveModules() {
      saveJSON(STORAGE_KEY, modules); // seed + fallback
      if (typeof window !== 'undefined' && window.NovaAppConfig) {
        try { window.NovaAppConfig.set(MODULES_REG_SLICE, 'list', modules, { legacyKey: STORAGE_KEY }); } catch { /* best-effort */ }
      }
    }
    function saveSafety() {
      saveJSON(SAFETY_KEY, safety); // seed + fallback
      if (typeof window !== 'undefined' && window.NovaAppConfig) {
        try { window.NovaAppConfig.set(MODULES_REG_SLICE, 'safety', safety, { legacyKey: SAFETY_KEY }); } catch { /* best-effort */ }
      }
    }
    function saveHistory() { saveJSON(HISTORY_KEY, reloadHistory); }
    function migratePathKey(record) {
      if (!record || typeof record !== 'object' ||
          !Object.prototype.hasOwnProperty.call(record, LEGACY_DEBUG_OVERLAY_PATH)) {
        return false;
      }
      if (!Object.prototype.hasOwnProperty.call(record, DEBUG_OVERLAY_PATH)) {
        record[DEBUG_OVERLAY_PATH] = record[LEGACY_DEBUG_OVERLAY_PATH];
      }
      delete record[LEGACY_DEBUG_OVERLAY_PATH];
      return true;
    }

    if (modulesPathMigrated) saveModules();
    if (migratePathKey(safety)) saveSafety();
    if (migratePathKey(reloadHistory)) saveHistory();

    // Heuristic for "this module owns state other live code depends on
    // and reloading it can desync the UI" — e.g. wm.js's
    // `const WM = window.WM = (() => {...})()`. Re-running that
    // reassigns window.WM to a fresh object with no memory of currently
    // open windows, which is what caused the blank-content bug earlier.
    // Deliberately conservative (regex, not a parser) — false positives
    // (flagging something harmless) just cost one extra confirm click;
    // false negatives (missing a real singleton) are the worse failure
    // mode, so the manual override exists specifically to patch those.
    function autoDetectDangerous(code) {
      return /^\s*(?:const|let|var)\s+\w+\s*=\s*window\.\w+\s*=\s*\(\s*\(\s*\)\s*=>\s*\{/m.test(code)
          || /^\s*window\.\w+\s*=\s*\(\s*\(\s*\)\s*=>\s*\{/m.test(code)
          || /^\s*window\.\w+\s*=\s*\{/m.test(code);
    }
    function isDangerous(mod, code) {
      const override = safety[mod.path];
      if (override === 'safe') return false;
      if (override === 'unsafe') return true;
      return autoDetectDangerous(code);
    }


    // AbortController for the per-row click listeners below plus the
    // add-module form and reload-all button — same pattern as console.js
    // and inspector.js. state.cleanups.push is the real teardown hook the
    // window manager honors (confirmed against wm.js).
    const ac = new AbortController();
    state.cleanups.push(() => ac.abort());

    const toolbar = createEl('div', { style: 'display:flex;gap:8px;margin-bottom:12px;flex-shrink:0;align-items:center;' });
    const reloadAllBtn = createEl('button', { textContent: _t('apps.modules.toolbar.reloadAll'), style: 'padding:6px 12px;background:var(--bg-elevated);color:var(--text-primary);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:12px;flex-shrink:0;' });
    const filterInput = createEl('input', { placeholder: _t('apps.modules.toolbar.filterPlaceholder'), style: 'flex:1;padding:6px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:12px;' });
    toolbar.appendChild(reloadAllBtn);
    toolbar.appendChild(filterInput);
    content.appendChild(toolbar);

    const reloadSummaryEl = createEl('div', { style: 'font-size:11px;color:var(--text-muted);margin-bottom:8px;flex-shrink:0;min-height:14px;' });
    content.appendChild(reloadSummaryEl);

    const list = createEl('div', { style: 'display:flex;flex-direction:column;gap:6px;overflow:auto;flex:1;' });
    content.appendChild(list);

    const addRow = createEl('div', { style: 'display:flex;gap:8px;margin-top:12px;flex-shrink:0;' });
    const idInput = createEl('input', { placeholder: _t('apps.modules.form.idPlaceholder'), style: 'width:140px;padding:6px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:11px;' });
    const pathInput = createEl('input', { placeholder: _t('apps.modules.form.pathPlaceholder'), style: 'flex:1;padding:6px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:11px;' });
    const addBtn = createEl('button', { textContent: _t('apps.modules.form.add'), style: 'padding:6px 14px;background:var(--accent);color:var(--text-on-accent);border:none;border-radius:4px;cursor:pointer;font-size:12px;' });
    addRow.appendChild(idInput);
    addRow.appendChild(pathInput);
    addRow.appendChild(addBtn);
    content.appendChild(addRow);

    // Export/import only the module list ({id, path}[]) — not safety
    // overrides or reload history, which are per-installation debugging
    // state. Both directions use the in-OS file dialogs.
    const ioRow = createEl('div', { style: 'display:flex;gap:8px;margin-top:8px;flex-shrink:0;' });
    const exportBtn = createEl('button', { textContent: _t('apps.modules.io.exportList'), style: 'padding:5px 10px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;' });
    const importBtn = createEl('button', { textContent: _t('apps.modules.io.importList'), style: 'padding:5px 10px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;' });
    ioRow.appendChild(exportBtn);
    ioRow.appendChild(importBtn);
    content.appendChild(ioRow);

    exportBtn.addEventListener('click', async () => {
      try {
        const destination = await SystemDialogs.saveContent({
          title: _t('apps.modules.io.exportList'),
          suggestedName: 'nbosp-modules-list-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json',
          accept: '.json',
        }, JSON.stringify(modules, null, 2));
        if (destination) reloadSummaryEl.textContent = destination.path;
      } catch (error) {
        console.error('[Modules] Export failed:', error);
        reloadSummaryEl.textContent = error.message;
        reloadSummaryEl.style.color = 'var(--text-danger)';
      }
    }, { signal: ac.signal });

    importBtn.addEventListener('click', async () => {
      const file = await SystemDialogs.open({
        title: _t('apps.modules.io.importDialogTitle'),
        accept: '.json',
        filter: (name, isDir) => isDir || name.toLowerCase().endsWith('.json'),
      });
      if (!file) return;
      try {
        const text = typeof file.content === 'string' ? file.content : file.content.toString('utf8');
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error(_t('apps.modules.io.importNotArray'));
        // Validate shape before trusting it — a malformed import (missing
        // id/path, wrong types) would otherwise silently corrupt the list
        // and only surface as confusing errors much later when rendering
        // or reloading a broken entry.
        const valid = parsed.every(m => m && typeof m.id === 'string' && typeof m.path === 'string');
        if (!valid) throw new Error(_t('apps.modules.io.importInvalidEntries'));

        // Merge by path (dedupe), imported entries win on conflict — matches
        // "import" intent (bring in a list) rather than silently discarding
        // anything that collides with what's already there.
        const byPath = new Map(modules.map(m => [m.path, m]));
        parsed.forEach(m => byPath.set(m.path, { id: m.id, path: m.path }));
        modules = [...byPath.values()];
        saveModules();
        render();
      } catch (e) {
        // Inline error next to the buttons rather than a blocking alert —
        // consistent with the rest of this app's no-modal-dialogs approach.
        reloadSummaryEl.textContent = _t('apps.modules.io.importFailed', { message: e.message });
        reloadSummaryEl.style.color = 'var(--text-danger)';
      }
    }, { signal: ac.signal });

    // ── Live code editor (2026-11-16) ────────────────────────────────
    // The module list was reload-only: you could re-import whatever the dev
    // server currently served, but editing meant leaving the OS for an
    // external editor and coming back. The editor makes the loop entirely
    // in-app: load the current source into a textarea, write it back to the
    // physical file (trusted host + dev-mode gated), then hot-reload it with
    // the same reloadOne() pipeline the Reload button uses — the new code is
    // running AND persisted before the editor even closes.
    function hostCanEditModuleFiles() {
      try {
        return typeof require === 'function' && typeof process !== 'undefined' && typeof process.cwd === 'function';
      } catch (_) { return false; }
    }

    // The install under /opt is read-only for the user, so edits are written
    // to an override folder that the server serves ahead of the shipped files
    // (server/core/module-overrides.js builds the same path).
    function moduleOverrideRoot() {
      const pathMod = require('path');
      return process.env.NOVABYTE_MODULE_OVERRIDES_DIR
        ? pathMod.resolve(process.env.NOVABYTE_MODULE_OVERRIDES_DIR)
        : pathMod.join(require('os').homedir(), '.local', 'share', 'novabyte', 'module-overrides');
    }

    function resolveModuleFile(modulePath) {
      const pathMod = require('path');
      const root = moduleOverrideRoot();
      // Module paths are served-rooted ("js/core/..."): strip the leading
      // slash and refuse anything the server wouldn't serve from the overlay.
      const rel = String(modulePath).replace(/^\/+/, '');
      if (!/^js\/.+\.m?js$/.test(rel)) {
        throw new Error('Only .js modules under js/ can be edited');
      }
      const target = pathMod.resolve(root, rel);
      if (!target.startsWith(root + pathMod.sep)) {
        throw new Error('Module path escapes the override folder');
      }
      return target;
    }

    function writeModuleFile(mod, code) {
      const fs = require('fs');
      const target = resolveModuleFile(mod.path);
      fs.mkdirSync(require('path').dirname(target), { recursive: true });
      fs.writeFileSync(target, code, 'utf8');
    }

    let editorEl = null;
    let editorState = null; // { mod, textarea, status, loadedCode }

    function closeEditor() {
      editorEl?.remove();
      editorEl = null;
      editorState = null;
      list.style.display = '';
      addRow.style.display = '';
      ioRow.style.display = '';
      render();
    }

    async function openEditor(mod) {
      editorEl?.remove();
      let code;
      try {
        const res = await fetch('/' + mod.path + '?t=' + Date.now());
        if (!res.ok) throw new Error(_t('apps.modules.editor.fetchFailed', { path: mod.path, status: res.status }));
        code = await res.text();
      } catch (e) {
        reloadSummaryEl.textContent = e.message;
        reloadSummaryEl.style.color = 'var(--text-danger)';
        return;
      }

      list.style.display = 'none';
      addRow.style.display = 'none';
      ioRow.style.display = 'none';

      editorEl = createEl('div', { style: 'display:flex;flex-direction:column;flex:1;min-height:0;gap:8px;' });
      editorEl.dataset.moduleEditor = mod.path;

      const head = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;' });
      const titleWrap = createEl('div', { style: 'min-width:0;' });
      titleWrap.appendChild(createEl('div', { textContent: _t('apps.modules.editor.title', { id: mod.id }), style: 'font-weight:600;font-size:13px;' }));
      titleWrap.appendChild(createEl('div', { textContent: mod.path, style: 'font-size:11px;color:var(--text-muted);font-family:monospace;' }));
      const metaEl = createEl('span', { style: 'font-size:11px;color:var(--text-muted);' });
      const backBtn = createEl('button', { textContent: _t('apps.modules.editor.back'), style: 'padding:4px 10px;background:transparent;color:var(--text-primary);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:12px;' });
      backBtn.addEventListener('click', closeEditor, { signal: ac.signal });
      head.append(titleWrap, metaEl, backBtn);
      editorEl.appendChild(head);

      const textarea = createEl('textarea', {
        spellcheck: 'false',
        'aria-label': _t('apps.modules.editor.title', { id: mod.id }),
      });
      textarea.value = code;
      textarea.style.cssText = 'flex:1;min-height:0;resize:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;padding:10px;background:var(--bg-base);color:var(--text-primary);border:1px solid var(--border-subtle);border-radius:6px;tab-size:2;white-space:pre;overflow:auto;';
      // Tab inserts two spaces instead of leaving the editor — editing with
      // a keyboard shouldn't cost you focus.
      textarea.addEventListener('keydown', (event) => {
        if (event.key !== 'Tab') return;
        event.preventDefault();
        const { selectionStart: s, selectionEnd: e } = textarea;
        textarea.setRangeText('  ', s, e, 'end');
      }, { signal: ac.signal });
      editorEl.appendChild(textarea);

      const statusEl = createEl('div', { role: 'status', style: 'font-size:11px;color:var(--text-muted);min-height:14px;' });
      const refreshMeta = () => {
        const lines = textarea.value.split('\n').length;
        const dirty = textarea.value !== editorState.loadedCode;
        metaEl.textContent = dirty ? _t('apps.modules.editor.unsaved') : '';
        statusEl.textContent = _t('apps.modules.editor.lines', { count: lines });
        statusEl.style.color = 'var(--text-muted)';
      };
      textarea.addEventListener('input', refreshMeta, { signal: ac.signal });

      const btnRow = createEl('div', { style: 'display:flex;gap:8px;flex-shrink:0;' });
      const saveBtn = createEl('button', {
        textContent: _t('apps.modules.editor.save'),
        'aria-label': _t('apps.modules.editor.save'),
        style: 'padding:6px 16px;background:var(--accent);color:var(--text-on-accent);border:none;border-radius:4px;cursor:pointer;font-size:12px;',
      });
      saveBtn.dataset.role = 'save';
      saveBtn.addEventListener('click', async () => {
        const editedCode = textarea.value;
        if (!editedCode.trim()) {
          statusEl.textContent = _t('apps.modules.editor.emptyRefused');
          statusEl.style.color = 'var(--text-danger)';
          return;
        }
        try {
          writeModuleFile(mod, editedCode);
        } catch (e) {
          statusEl.textContent = _t('apps.modules.editor.saveFailed', { message: e.message });
          statusEl.style.color = 'var(--text-danger)';
          return;
        }
        // Re-fetch + re-import through the standard reload pipeline: the
        // file on disk now holds the edit, so reloadOne() reads exactly what
        // was saved, the danger check still applies, and the diff/undo row
        // gets honest prev/new codes.
        const result = await reloadOne(mod, saveBtn);
        if (result.ok) {
          editorState.loadedCode = editedCode;
          refreshMeta();
          statusEl.textContent = _t('apps.modules.editor.saved');
          statusEl.style.color = 'var(--text-success)';
        } else if (!result.cancelled) {
          statusEl.textContent = _t('apps.modules.editor.saveFailed', { message: result.error || '' });
          statusEl.style.color = 'var(--text-danger)';
        }
      }, { signal: ac.signal });
      btnRow.appendChild(saveBtn);
      editorEl.appendChild(btnRow);
      editorEl.appendChild(statusEl);

      // Insert where the list sat so the editor owns the main column.
      content.insertBefore(editorEl, addRow);
      editorState = { mod, textarea, status: statusEl, loadedCode: code };
      refreshMeta();
      textarea.focus();
    }

    // confirmDanger: small inline confirm, not a blocking window.confirm()
    // (which the rest of this app avoids — modals.js exists for real
    // dialogs, but a lightweight inline yes/no keeps this consistent with
    // the rest of the row-based UI and doesn't block the whole OS thread).
    function confirmDanger(mod) {
      return new Promise((resolve) => {
        const overlay = createEl('div', { style: 'position:fixed;inset:0;background:rgba(0,0,0,0.5);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:9999;' });
        // The box is translucent, so it blurs what's behind it too; otherwise the editor text shows through the copy.
        const box = createEl('div', { style: 'background:var(--bg-elevated,#1a1c22);backdrop-filter:var(--window-blur,blur(24px) saturate(160%));border:1px solid var(--border-subtle);border-radius:8px;padding:20px;max-width:360px;font-size:13px;' });
        box.appendChild(createEl('div', { textContent: _t('apps.modules.confirm.title', { id: mod.id }), style: 'font-weight:600;margin-bottom:8px;font-size:14px;' }));
        box.appendChild(createEl('div', {
          textContent: _t('apps.modules.confirm.body'),
          style: 'color:var(--text-muted);margin-bottom:14px;line-height:1.4;'
        }));
        const btnRow = createEl('div', { style: 'display:flex;gap:8px;justify-content:flex-end;' });
        const cancelBtn = createEl('button', { textContent: _t('common.cancel'), style: 'padding:6px 12px;background:transparent;color:var(--text-primary);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;' });
        const proceedBtn = createEl('button', { textContent: _t('apps.modules.confirm.reloadAnyway'), style: 'padding:6px 12px;background:var(--text-danger);color:var(--bg-base);border:none;border-radius:4px;cursor:pointer;' });
        cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(false); });
        proceedBtn.addEventListener('click', () => { overlay.remove(); resolve(true); });
        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(proceedBtn);
        box.appendChild(btnRow);
        overlay.appendChild(box);
        content.appendChild(overlay);
      });
    }

    // skipDangerCheck: used by undo's "re-import previous version" path —
    // re-importing code the user already had running isn't a new risk
    // decision, it's reverting one they already made.
    async function reloadOne(mod, btn, { skipDangerCheck = false, codeOverride = null } = {}) {
      btn.disabled = true;
      // No generic :disabled styling exists in style.css (only a
      // browser-nav-btn-specific rule), so the attribute alone wouldn't
      // give any visual feedback that the button is mid-reload — set
      // opacity directly instead.
      btn.style.opacity = '0.6';
      const prevText = btn.textContent;
      const prevBg = btn.style.background;
      btn.textContent = '…';
      try {
        let code;
        if (codeOverride !== null) {
          code = codeOverride;
        } else {
          const url = '/' + mod.path + '?t=' + Date.now();
          const res = await fetch(url);
          if (!res.ok) throw new Error(_t('apps.modules.reload.httpError', { status: res.status, path: mod.path }));
          code = await res.text();
        }

        if (!skipDangerCheck && isDangerous(mod, code)) {
          const proceed = await confirmDanger(mod);
          if (!proceed) {
            btn.textContent = prevText;
            btn.style.background = prevBg;
            btn.style.opacity = '';
            btn.disabled = false;
            return { ok: false, cancelled: true };
          }
        }

        const prevEntry = reloadHistory[mod.path];
        const prevCode = codeOverride !== null ? (prevEntry?.prevCode ?? null) : (prevEntry?.newCode ?? null);

        // Real root cause (confirmed via browser console, not guessed):
        // this was never a blob-vs-data URL scheme-support issue. The
        // server's CSP (server/middleware.js, helmet's scriptSrcElem
        // directive) simply never included blob: or data: — even though
        // workerSrc and frameSrc both already allowed blob: for their
        // respective content types, scriptSrcElem was never extended to
        // match. Fixed at the source by adding blob: to scriptSrcElem;
        // reverted here to blob: (no base64/percent-encoding overhead)
        // now that the policy actually permits it.
        const blob = new Blob([code], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        // __novaModulesImport is a documented test/host seam: environments
        // without a native dynamic import (JSDOM test realms) can observe
        // the re-import without a module loader. Everything else uses the
        // real import().
        const dynamicImport = typeof window.__novaModulesImport === 'function'
          ? window.__novaModulesImport
          : (url) => import(url);
        try {
          await dynamicImport(blobUrl);
        } finally {
          // Safe to revoke right after import() resolves/rejects — by then
          // the module's been fetched and its top-level code has already
          // run (or thrown), so the blob URL has nothing left to serve.
          URL.revokeObjectURL(blobUrl);
        }

        reloadHistory[mod.path] = { prevCode, newCode: code, ts: Date.now() };
        saveHistory();

        // reloadOne re-executes registerApp() for app modules, which
        // updates APP_REGISTRY/OS.apps immediately — but the launchpad and
        // taskbar are memoized views that only rebuild when explicitly
        // asked to (renderLaunchpad diffs a signature string; it won't
        // pick up the change until toggled). Without this, a reloaded
        // app's new name/icon silently doesn't show until the user closes
        // and reopens the launchpad, which looks exactly like "reload had
        // no effect" even though the registry itself updated correctly.
        try {
          if (typeof renderLaunchpad === 'function') renderLaunchpad();
        } catch { /* best-effort refresh, not a reload failure */ }
        try {
          if (typeof WM !== 'undefined' && WM.updateTaskbar) WM.updateTaskbar();
        } catch { /* best-effort refresh, not a reload failure */ }

        btn.textContent = '✓';
        btn.style.background = 'var(--text-success)';
        btn.title = '';
        render(); // refresh row to show/update the diff + undo affordances
        return { ok: true };
      } catch (e) {
        btn.textContent = '✗';
        btn.style.background = 'var(--text-danger)';
        // Surface the actual error instead of just a red X — hovering
        // shows what broke (bad path, syntax error, import failure, etc),
        // which the original silently discarded.
        btn.title = e.message;
        return { ok: false, error: e.message };
      } finally {
        setTimeout(() => {
          if (btn.textContent === '…') return; // render() may have replaced this row already
          btn.textContent = prevText;
          btn.style.background = prevBg;
          btn.style.opacity = '';
          btn.disabled = false;
        }, 1500);
      }
    }

    // Line-count diff summary — not a real diff algorithm (no LCS/Myers),
    // deliberately: this is a quick "did anything actually change, and
    // roughly how much" indicator for a small UI row, not a code review
    // tool. Counting differing lines by position is O(n) and good enough
    // for that; a real diff view would be a much bigger feature on its own.
    function diffSummary(prevCode, newCode) {
      if (prevCode === null || prevCode === undefined) return null;
      if (prevCode === newCode) return _t('apps.modules.diff.noChanges');
      const a = prevCode.split('\n');
      const b = newCode.split('\n');
      const max = Math.max(a.length, b.length);
      let changed = 0;
      for (let i = 0; i < max; i++) if (a[i] !== b[i]) changed++;
      const delta = b.length - a.length;
      const deltaStr = delta === 0 ? '' : (delta > 0 ? _t('apps.modules.diff.linesAdded', { count: delta }) : _t('apps.modules.diff.linesRemoved', { count: delta }));
      return _t('apps.modules.diff.linesChanged', { count: changed, s: changed === 1 ? '' : 's' }) + deltaStr;
    }

    let filterValue = '';

    function render() {
      list.innerHTML = '';
      const q = filterValue.trim().toLowerCase();
      // Filter by real index (not filtered position) so removeBtn's
      // modules.splice(idx, 1) below still targets the correct underlying
      // entry regardless of what's currently hidden by the filter.
      const visible = modules
        .map((mod, idx) => ({ mod, idx }))
        .filter(({ mod }) => !q || mod.id.toLowerCase().includes(q) || mod.path.toLowerCase().includes(q));

      visible.forEach(({ mod, idx }) => {
        const row = createEl('div', { style: 'display:flex;flex-direction:column;padding:8px;background:var(--bg-elevated);border-radius:6px;border:1px solid var(--border-subtle);gap:6px;' });
        row.dataset.modPath = mod.path;

        const topLine = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;' });
        const info = createEl('div', { style: 'min-width:0;overflow:hidden;' });
        const idLine = createEl('div', { style: 'font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px;' });
        idLine.appendChild(createEl('span', { textContent: mod.id }));

        // Safety badge — reflects the manual override if set, otherwise
        // the auto-detected guess against whatever content we last saw
        // for this path (falls back to "unknown" until first fetched,
        // since we don't have code to inspect before that).
        const knownCode = reloadHistory[mod.path]?.newCode ?? null;
        const override = safety[mod.path];
        const dangerGuess = override ? override === 'unsafe' : (knownCode !== null ? autoDetectDangerous(knownCode) : null);
        const badge = createEl('span', {
          textContent: dangerGuess === null ? _t('apps.modules.badge.unknown') : (dangerGuess ? _t('apps.modules.badge.stateful') : _t('apps.modules.badge.safe')),
          title: override
            ? _t('apps.modules.badge.manuallyMarked', { state: override })
            : (dangerGuess === null ? _t('apps.modules.badge.notYetFetched') : _t('apps.modules.badge.autoDetected')),
          style: 'font-size:10px;padding:1px 6px;border-radius:3px;cursor:pointer;user-select:none;' +
            (dangerGuess === null ? 'background:var(--bg-base);color:var(--text-muted);' :
             dangerGuess ? 'background:color-mix(in srgb,var(--text-danger) 15%,transparent);color:var(--text-danger);' : 'background:color-mix(in srgb,var(--text-success) 15%,transparent);color:var(--text-success);')
        });
        badge.addEventListener('click', () => {
          // Cycle: auto -> forced-safe -> forced-unsafe -> auto
          if (!override) safety[mod.path] = 'safe';
          else if (override === 'safe') safety[mod.path] = 'unsafe';
          else delete safety[mod.path];
          saveSafety();
          render();
        }, { signal: ac.signal });
        idLine.appendChild(badge);
        info.appendChild(idLine);
        info.appendChild(createEl('div', { textContent: mod.path, style: 'font-size:11px;color:var(--text-muted);font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }));
        topLine.appendChild(info);

        const btns = createEl('div', { style: 'display:flex;gap:6px;flex-shrink:0;' });
        const btn = createEl('button', { textContent: _t('apps.modules.row.reload'), style: 'padding:4px 12px;background:var(--accent);color:var(--text-on-accent);border:none;border-radius:4px;cursor:pointer;font-size:12px;' });
        btn.dataset.role = 'reload';
        btn.addEventListener('click', () => reloadOne(mod, btn), { signal: ac.signal });
        btns.appendChild(btn);

        // Live editing — only offered on hosts that can write the source
        // tree (NW.js trusted host); the web build keeps the reload-only UI.
        if (hostCanEditModuleFiles()) {
          const editBtn = createEl('button', {
            textContent: _t('apps.modules.editor.open'),
            title: _t('apps.modules.editor.openTitle'),
            style: 'padding:4px 12px;background:transparent;color:var(--text-primary);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:12px;',
          });
          editBtn.dataset.role = 'edit';
          editBtn.addEventListener('click', () => openEditor(mod), { signal: ac.signal });
          btns.appendChild(editBtn);
        }

        const removeBtn = createEl('button', { textContent: '✕', title: _t('apps.modules.row.removeTitle'), style: 'padding:4px 8px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:12px;' });
        removeBtn.addEventListener('click', () => {
          modules.splice(idx, 1);
          saveModules();
          render();
        }, { signal: ac.signal });
        btns.appendChild(removeBtn);

        topLine.appendChild(btns);
        row.appendChild(topLine);

        // Diff + undo row — only shown once we have a reload on record
        // for this path.
        const hist = reloadHistory[mod.path];
        if (hist) {
          const metaLine = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11px;color:var(--text-muted);' });
          const summary = diffSummary(hist.prevCode, hist.newCode);
          metaLine.appendChild(createEl('span', { textContent: summary ? _t('apps.modules.row.lastReload', { summary, time: new Date(hist.ts).toLocaleTimeString() }) : _t('apps.modules.row.reloaded', { time: new Date(hist.ts).toLocaleTimeString() }) }));

          if (hist.prevCode !== null && hist.prevCode !== undefined && hist.prevCode !== hist.newCode) {
            const undoRow = createEl('div', { style: 'display:flex;gap:6px;' });
            const undoBtn = createEl('button', {
              textContent: _t('apps.modules.row.undo'),
              title: _t('apps.modules.row.undoTitle'),
              style: 'padding:2px 8px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:10px;'
            });
            undoBtn.addEventListener('click', () => {
              reloadOne(mod, btn, { skipDangerCheck: true, codeOverride: hist.prevCode });
            }, { signal: ac.signal });
            undoRow.appendChild(undoBtn);

            const fullReloadBtn = createEl('button', {
              textContent: _t('apps.modules.row.fullReload'),
              title: _t('apps.modules.row.fullReloadTitle'),
              style: 'padding:2px 8px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:10px;'
            });
            fullReloadBtn.addEventListener('click', () => location.reload(), { signal: ac.signal });
            undoRow.appendChild(fullReloadBtn);

            metaLine.appendChild(undoRow);
          }
          row.appendChild(metaLine);
        }

        list.appendChild(row);
      });

      if (!visible.length) {
        list.appendChild(createEl('div', { textContent: modules.length ? _t('apps.modules.list.noMatch') : _t('apps.modules.list.empty'), style: 'color:var(--text-muted);padding:8px;' }));
      }
    }

    filterInput.addEventListener('input', () => {
      filterValue = filterInput.value;
      render();
    }, { signal: ac.signal });

    addBtn.addEventListener('click', () => {
      const id = idInput.value.trim();
      const path = pathInput.value.trim();
      if (!id || !path) return;
      modules.push({ id, path });
      saveModules();
      idInput.value = '';
      pathInput.value = '';
      render();
    }, { signal: ac.signal });

    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) addBtn.click();
    }, { signal: ac.signal });

    reloadAllBtn.addEventListener('click', async () => {
      reloadAllBtn.disabled = true;
      const origText = reloadAllBtn.textContent;
      reloadAllBtn.textContent = _t('apps.modules.toolbar.reloading');

      // Operates on currently visible (filtered) modules only — if the
      // list is filtered down, "Reload All" reloading hidden entries too
      // would be a surprising mismatch between what's on screen and what
      // actually happened. Looked up by data-mod-path rather than
      // positional index, since list.children[i] no longer lines up 1:1
      // with modules[i] once a filter can hide arbitrary rows.
      const q = filterValue.trim().toLowerCase();
      const targets = modules.filter(mod => !q || mod.id.toLowerCase().includes(q) || mod.path.toLowerCase().includes(q));

      const results = await Promise.all(targets.map(mod => {
        const row = list.querySelector(`[data-mod-path="${CSS.escape(mod.path)}"]`);
        const btn = row?.querySelector('[data-role="reload"]');
        return btn ? reloadOne(mod, btn) : Promise.resolve({ ok: false, error: 'row not found' });
      }));

      const okCount = results.filter(r => r.ok).length;
      const cancelledCount = results.filter(r => r.cancelled).length;
      const failCount = results.length - okCount - cancelledCount;
      reloadAllBtn.textContent = origText;
      reloadAllBtn.disabled = false;

      // Brief inline summary next to the button rather than a modal —
      // consistent with the rest of this app avoiding blocking dialogs.
      reloadSummaryEl.textContent = _t('apps.modules.summary.lastRun', { ok: okCount }) +
        (cancelledCount ? _t('apps.modules.summary.cancelled', { count: cancelledCount }) : '') +
        (failCount ? _t('apps.modules.summary.failed', { count: failCount }) : '') +
        _t('apps.modules.summary.total', { count: results.length });
      reloadSummaryEl.style.color = failCount ? 'var(--text-danger)' : (cancelledCount ? 'var(--text-warning)' : 'var(--text-success)');
    }, { signal: ac.signal });

    render();
  }
});