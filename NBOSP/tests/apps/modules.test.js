// tests/apps/modules.test.js — window app: dev-mode gates, module list CRUD,
// reload error surfacing, safety-badge overrides, storage migration/import,
// and the live code editor (edit → save to disk → hot-reload).
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

const LIST_KEY = 'nbosp_modules_list';
const SAFETY_KEY = 'nbosp_modules_safety';
const LEGACY_OVERLAY_PATH = 'js/core/utils/debug-overlay.js';
const OVERLAY_PATH = 'js/apps/debug-overlay/service.js';

// The app hard-references OS.settings.get('devMode') and pushes onto
// state.cleanups without a guard, so every happy-path load needs both.
const devOS = { settings: { get: (key) => key === 'devMode' } };

function loadModules(opts = {}) {
  const { extra = {}, ...stubs } = opts;
  return loadWindowApp('modules', {
    stubs: { ...stubs, extra: { OS: devOS, ...extra } },
  });
}

function initModules(loaded, extraState = {}) {
  return initApp(loaded.app, { window: loaded.window, state: { cleanups: [], ...extraState } });
}

const rowPaths = (content) =>
  [...content.querySelectorAll('[data-mod-path]')].map((r) => r.dataset.modPath);

describe("'Modules' app (js/apps/modules)", () => {
  beforeEach(() => resetTestStorage());

  it('registers a full dev-only app descriptor with the host', async () => {
    const { app } = await loadModules();
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.nbosp.modules');
    expect(app.name).toBe('Modules');
    expect(app.version).toBe('3.0.2');
    expect(app.category).toBe('developer');
    expect(app.devOnly).toBe(true);
    expect(app.description).toMatch(/Hot-reload/);
    expect(Array.isArray(app.defaultSize)).toBe(true);
    expect(app.defaultSize).toEqual([600, 600]);
    expect(app.minSize).toEqual([420, 380]);
    expect(typeof app.init).toBe('function');
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const { app, window } = await loadModules({ AppDirs: null });
    const content = initApp(app, { window, state: {} });
    expect(content.textContent).toContain('App data directory missing.');
    expect(content.querySelector('b').textContent).toBe('com.nbosp.settings');
  });

  it('shows the developer-mode gate when OS.settings.devMode is off', async () => {
    const offOS = { settings: { get: () => false } };
    const { app, window } = await loadModules({ extra: { OS: offOS } });
    const content = initApp(app, { window, state: {} });
    expect(content.textContent).toContain('Enable Developer Mode in Settings to use Modules.');
  });

  it('renders the toolbar and the 8 default module rows with unknown safety badges', async () => {
    const { app, window } = await loadModules();
    const content = initModules({ app, window });
    const reloadAllBtn = [...content.querySelectorAll('button')].find((b) => b.textContent === 'Reload All');
    expect(reloadAllBtn).toBeTruthy();
    const filter = content.querySelector('input[placeholder="Filter by id or path…"]');
    expect(filter).toBeTruthy();
    // The 8 DEFAULT_MODULES entries from the source.
    expect(rowPaths(content)).toEqual([
      'js/core/core/boot.js',
      'js/apps/shell-ui/wm.js',
      'js/core/services/fs.js',
      'js/platform/core/app-registry.js',
      'js/platform/security/app-permission-manager.js',
      'js/apps/system-events/service.js',
      'js/core/utils/base-utils.js',
      'js/apps/debug-overlay/service.js',
    ]);
    // Nothing fetched yet → every badge shows the "unknown" state.
    for (const badge of content.querySelectorAll('[data-mod-path] span[title]')) {
      if (badge.textContent.includes('unknown')) expect(badge.textContent).toBe('? unknown');
    }
    expect(content.querySelector('input[placeholder="id (e.g. my-module)"]')).toBeTruthy();
    expect(content.querySelector('input[placeholder="path (e.g. js/apps/foo.js)"]')).toBeTruthy();
    expect([...content.querySelectorAll('button')].map((b) => b.textContent)).toContain('Export List');
    expect([...content.querySelectorAll('button')].map((b) => b.textContent)).toContain('Import List');
  });

  it('filters rows live and reports an empty filter result', async () => {
    const { app, window } = await loadModules();
    const content = initModules({ app, window });
    const filter = content.querySelector('input[placeholder="Filter by id or path…"]');

    filter.value = 'boot';
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(rowPaths(content)).toEqual(['js/core/core/boot.js']);

    filter.value = 'app-permission';
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(rowPaths(content)).toEqual(['js/platform/security/app-permission-manager.js']);

    filter.value = 'no-such-module';
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(rowPaths(content)).toEqual([]);
    expect(content.textContent).toContain('No modules match filter');
  });

  it('adds a module through the form and persists it to localStorage', async () => {
    const { app, window } = await loadModules();
    const content = initModules({ app, window });
    const idInput = content.querySelector('input[placeholder="id (e.g. my-module)"]');
    const pathInput = content.querySelector('input[placeholder="path (e.g. js/apps/foo.js)"]');
    const addBtn = [...content.querySelectorAll('button')].find((b) => b.textContent === 'Add');

    idInput.value = 'my-module';
    pathInput.value = 'js/apps/my-module.js';
    addBtn.click();

    expect(rowPaths(content)).toContain('js/apps/my-module.js');
    // Inputs are cleared after a successful add.
    expect(idInput.value).toBe('');
    expect(pathInput.value).toBe('');
    const stored = JSON.parse(window.localStorage.getItem(LIST_KEY));
    expect(stored.some((m) => m.id === 'my-module' && m.path === 'js/apps/my-module.js')).toBe(true);

    // Empty id or path is ignored (no push, no save).
    addBtn.click();
    expect(JSON.parse(window.localStorage.getItem(LIST_KEY)).some((m) => m.id === '')).toBe(false);
  });

  it('removes a row via the ✕ button and persists the shorter list', async () => {
    const { app, window } = await loadModules();
    const content = initModules({ app, window });
    const before = rowPaths(content).length;
    const firstRow = content.querySelector('[data-mod-path="js/core/core/boot.js"]');
    const removeBtn = [...firstRow.querySelectorAll('button')].find((b) => b.textContent === '✕');
    removeBtn.click();

    expect(rowPaths(content)).not.toContain('js/core/core/boot.js');
    expect(rowPaths(content).length).toBe(before - 1);
    const stored = JSON.parse(window.localStorage.getItem(LIST_KEY));
    expect(stored.some((m) => m.path === 'js/core/core/boot.js')).toBe(false);
  });

  it('surfaces reload failures on the row button (HTTP error from fetch)', async () => {
    const { app, window } = await loadModules(); // default harness fetch → 404
    const content = initModules({ app, window });
    const row = content.querySelector('[data-mod-path="js/core/core/boot.js"]');
    const reloadBtn = row.querySelector('[data-role="reload"]');

    reloadBtn.click();
    await settle(30);

    expect(reloadBtn.textContent).toBe('✗');
    expect(reloadBtn.title).toBe('HTTP 404 fetching js/core/core/boot.js');
    expect(Number(reloadBtn.style.opacity)).toBeLessThan(1);
  });

  it('Reload All reports a per-run summary in the inline status line', async () => {
    const { app, window } = await loadModules(); // every fetch 404s
    const content = initModules({ app, window });
    const reloadAllBtn = [...content.querySelectorAll('button')].find((b) => b.textContent === 'Reload All');
    // content children order: desc, toolbar, summary line, list, add row, io row.
    const summary = [...content.children].find((el) => el.style.minHeight === '14px');
    expect(summary).toBeTruthy();

    reloadAllBtn.click();
    await settle(50);

    expect(reloadAllBtn.textContent).toBe('Reload All'); // restored after the run
    expect(reloadAllBtn.disabled).toBe(false);
    expect(summary.textContent).toBe('Last run: 0 ok, 8 failed (8 total)');
    expect(summary.style.color).toBe('rgb(248, 81, 73)'); // #f85149
  });

  it('cycles the safety override on badge click and persists it', async () => {
    const { app, window } = await loadModules();
    const content = initModules({ app, window });
    const row = content.querySelector('[data-mod-path="js/core/core/boot.js"]');
    const badge = [...row.querySelectorAll('span')].find((s) => s.textContent === '? unknown');
    expect(badge).toBeTruthy();

    badge.click(); // auto → forced safe
    let stored = JSON.parse(window.localStorage.getItem(SAFETY_KEY));
    expect(stored['js/core/core/boot.js']).toBe('safe');
    let row2 = content.querySelector('[data-mod-path="js/core/core/boot.js"]');
    expect([...row2.querySelectorAll('span')].some((s) => s.textContent === '✓ safe')).toBe(true);

    row2.querySelector('span[title*="Manually marked safe"]').click(); // safe → unsafe
    stored = JSON.parse(window.localStorage.getItem(SAFETY_KEY));
    expect(stored['js/core/core/boot.js']).toBe('unsafe');
    row2 = content.querySelector('[data-mod-path="js/core/core/boot.js"]');
    expect([...row2.querySelectorAll('span')].some((s) => s.textContent === '⚠ stateful')).toBe(true);

    row2.querySelector('span[title*="Manually marked unsafe"]').click(); // unsafe → auto
    stored = JSON.parse(window.localStorage.getItem(SAFETY_KEY));
    expect(stored['js/core/core/boot.js']).toBeUndefined();
    row2 = content.querySelector('[data-mod-path="js/core/core/boot.js"]');
    expect([...row2.querySelectorAll('span')].some((s) => s.textContent === '? unknown')).toBe(true);
  });

  it('migrates the legacy debug-overlay path and repairs malformed saved lists', async () => {
    const { app, window } = await loadModules();
    window.localStorage.setItem(LIST_KEY, JSON.stringify([
      { id: 'debug-overlay', path: LEGACY_OVERLAY_PATH },
    ]));
    initModules({ app, window });

    const stored = JSON.parse(window.localStorage.getItem(LIST_KEY));
    expect(stored).toEqual([{ id: 'debug-overlay', path: OVERLAY_PATH }]);

    // A second load with a corrupt (non-array) list falls back to defaults.
    const second = await loadModules();
    window.localStorage.setItem(LIST_KEY, 'not-json');
    const content = initModules(second);
    expect(rowPaths(content).length).toBe(8); // DEFAULT_MODULES again
  });

  it('imports a module list via SystemDialogs and merges by path', async () => {
    const imported = [
      { id: 'boot-renamed', path: 'js/core/core/boot.js' }, // conflicts — imported wins
      { id: 'extra', path: 'js/apps/extra.js' },
    ];
    const { app, window } = await loadModules({
      extra: { SystemDialogs: { open: async () => ({ content: JSON.stringify(imported) }) } },
    });
    const content = initModules({ app, window });
    const importBtn = [...content.querySelectorAll('button')].find((b) => b.textContent === 'Import List');

    importBtn.click();
    await settle(30);

    const paths = rowPaths(content);
    expect(paths).toContain('js/apps/extra.js');
    const stored = JSON.parse(window.localStorage.getItem(LIST_KEY));
    expect(stored.find((m) => m.path === 'js/core/core/boot.js').id).toBe('boot-renamed');
    // 8 defaults + 1 new entry (boot conflict merged, not duplicated).
    expect(stored.length).toBe(9);
  });

  it('reports a malformed import inline without corrupting the list', async () => {
    const { app, window } = await loadModules({
      extra: { SystemDialogs: { open: async () => ({ content: '{"not":"an array"}' }) } },
    });
    const content = initModules({ app, window });
    const importBtn = [...content.querySelectorAll('button')].find((b) => b.textContent === 'Import List');

    importBtn.click();
    await settle(30);

    expect(content.textContent).toContain('Import failed: Expected a JSON array');
    // Original list untouched.
    expect(rowPaths(content).length).toBe(8);
  });

  // ── Live code editor ──────────────────────────────────────────────────────
  // A fake NW.js-style host: require('fs'/'path') + process.cwd, a fetch that
  // serves module source, blob URLs, and the __novaModulesImport seam that
  // stands in for dynamic import() in JSDOM realms.
  function makeHost({ code = '// module source\nlet a = 1;\n' } = {}) {
    const writes = [];
    const imports = [];
    const posix = {
      resolve: (base, rel = '') => (rel ? `${String(base).replace(/\/+$/, '')}/${String(rel).replace(/^\/+/, '')}` : String(base)),
      sep: '/',
    };
    return {
      writes, imports,
      extra: {
        require: (name) => {
          if (name === 'fs') return { writeFileSync: (p, c, enc) => writes.push([p, c, enc]) };
          if (name === 'path') return posix;
          throw new Error(`unexpected module ${name}`);
        },
        process: { cwd: () => '/nbosp', platform: 'linux' },
        fetch: vi.fn(async (url) => ({ ok: true, status: 200, text: async () => code })),
      },
    };
  }

  function armBlobUrls(window) {
    window.URL.createObjectURL = () => 'blob:nova-modules-test';
    window.URL.revokeObjectURL = () => {};
  }

  it('offers the Edit button only on hosts that can write the source tree', async () => {
    // default harness: no require/process → reload-only UI
    const plain = await loadModules();
    const plainContent = initModules({ app: plain.app, window: plain.window });
    expect(plainContent.querySelector('[data-role="edit"]')).toBeNull();

    const host = makeHost();
    const { app, window } = await loadModules({ extra: host.extra });
    const content = initModules({ app, window });
    const editBtn = content.querySelector('[data-mod-path="js/core/core/boot.js"] [data-role="edit"]');
    expect(editBtn).toBeTruthy();
    expect(editBtn.textContent).toBe('Edit');
  });

  it('live editor: loads the served source, saves the edit to disk and hot-reloads it', async () => {
    const host = makeHost({ code: '// module source\nlet a = 1;\n' });
    const { app, window } = await loadModules({ extra: host.extra });
    window.__novaModulesImport = async (url) => { host.imports.push(url); };
    armBlobUrls(window);
    const content = initModules({ app, window });

    content.querySelector('[data-mod-path="js/core/core/boot.js"] [data-role="edit"]').click();
    await settle(30);

    // the editor pane replaces the module list and carries the served source
    const editor = content.querySelector('[data-module-editor="js/core/core/boot.js"]');
    expect(editor).toBeTruthy();
    const textarea = editor.querySelector('textarea');
    expect(textarea.value).toBe('// module source\nlet a = 1;\n');
    expect(content.textContent).toContain('3 lines');
    // the list view is hidden while editing (its container, which holds the rows)
    const listContainer = content.querySelector('[data-mod-path="js/core/core/boot.js"]').parentElement;
    expect(listContainer.style.display).toBe('none');

    // an edit flips the unsaved marker
    textarea.value = '// module source\nlet a = 2;\nconsole.log(a);\n';
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle(10);
    expect(content.textContent).toContain('Edited — not saved yet');

    // Save & reload: the file on disk gets the edited code, then the module
    // is re-imported through the standard reload pipeline
    editor.querySelector('[data-role="save"]').click();
    await settle(60);

    expect(host.writes).toEqual([[
      '/nbosp/js/core/core/boot.js',
      '// module source\nlet a = 2;\nconsole.log(a);\n',
      'utf8',
    ]]);
    expect(host.imports).toHaveLength(1);
    expect(content.textContent).toContain('Saved to disk and reloaded into the running OS');
    // the unsaved marker cleared
    expect(content.textContent).not.toContain('Edited — not saved yet');
  });

  it('live editor: Back returns to the module list', async () => {
    const host = makeHost();
    const { app, window } = await loadModules({ extra: host.extra });
    const content = initModules({ app, window });
    content.querySelector('[data-mod-path="js/core/core/boot.js"] [data-role="edit"]').click();
    await settle(30);
    expect(content.querySelector('[data-module-editor]')).toBeTruthy();

    [...content.querySelectorAll('button')].find((b) => b.textContent === '← Back to modules').click();
    await settle(10);

    expect(content.querySelector('[data-module-editor]')).toBeNull();
    expect(rowPaths(content).length).toBe(8);
  });

  it('live editor: a save that cannot write the file surfaces the failure inline', async () => {
    const host = makeHost();
    host.extra.require = (name) => {
      if (name === 'fs') return { writeFileSync: () => { throw new Error('EACCES: read-only file system'); } };
      if (name === 'path') return { resolve: (base, rel = '') => (rel ? `${base}/${rel}` : base), sep: '/' };
      throw new Error(`unexpected module ${name}`);
    };
    const { app, window } = await loadModules({ extra: host.extra });
    const content = initModules({ app, window });
    content.querySelector('[data-mod-path="js/core/core/boot.js"] [data-role="edit"]').click();
    await settle(30);
    const editor = content.querySelector('[data-module-editor="js/core/core/boot.js"]');

    editor.querySelector('[data-role="save"]').click();
    await settle(30);

    expect(content.textContent).toContain('Save failed: EACCES: read-only file system');
    // nothing was imported — the reload pipeline never ran
    expect(host.imports).toEqual([]);
  });
});
