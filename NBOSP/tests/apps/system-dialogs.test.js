// tests/apps/system-dialogs.test.js — service app: fs-backed open/save dialogs.
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp, settle } from '../helpers/app-harness.js';
import nodeFs from 'node:fs';
import fsPromises from 'node:fs/promises';
import nodePath from 'node:path';
import nodeOs from 'node:os';

// The service does `require('fs')` at eval time — jsdom has no require, so the
// harness gets a shim that hands back the real Node modules. The dialog then
// browses an actual temp directory, exercising the true fs code paths.
let tmpRoot;

async function loadDialogs(notifyCalls = [], userRoot = null, registry = null) {
  const { window, document } = await loadServiceApp('system-dialogs', {
    stubs: {
      extra: {
        require: (mod) => ({ fs: nodeFs, path: nodePath, os: nodeOs })[mod],
        Notify: { show: (o) => notifyCalls.push(o) },
        ...(userRoot ? {
          FS: {
            rootId: userRoot.id,
            getPath: (id) => id === userRoot.id ? userRoot.path : null,
          },
        } : {}),
        ...(registry ? { NovaRegistry: registry } : {}),
      },
    },
  });
  return { window, document, notifyCalls };
}

// Map-backed NovaRegistry stub — enough surface for the dialog's guarded
// get()/set() calls (HKNU/shell/sysdialog/lastDir persistence).
function mapRegistry(bag = new Map()) {
  return {
    get: (key) => (bag.has(key) ? bag.get(key) : undefined),
    set: (key, value) => { bag.set(key, value); return { path: key, value, changed: true }; },
  };
}

const items = (document) => [...document.querySelectorAll('.system-file-dialog-item')];
const itemByName = (document, name) => items(document).find((el) => el.getAttribute('aria-label') === name);
const buttons = (document) => [...document.querySelectorAll('.modal-dialog button')];
const confirmBtn = (document) => buttons(document).find((b) => b.classList.contains('btn-primary'));
const cancelBtn = (document) => buttons(document).find((b) => b.textContent === 'Cancel');
const nameInput = (document) => document.querySelector('footer .input, .system-file-dialog-footer .input');
const pathBar = (document) => document.querySelector('.system-file-dialog-path');

describe('SystemDialogs service (js/apps/system-dialogs)', () => {
  beforeAll(async () => {
    resetTestStorage();
    tmpRoot = await fsPromises.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'nbosp-dialogs-'));
    await fsPromises.mkdir(nodePath.join(tmpRoot, 'sub'));
    await fsPromises.writeFile(nodePath.join(tmpRoot, 'alpha.txt'), 'hello alpha', 'utf8');
    await fsPromises.writeFile(nodePath.join(tmpRoot, 'beta.md'), '# beta', 'utf8');
    await fsPromises.writeFile(nodePath.join(tmpRoot, 'sub', 'inner.txt'), 'inner', 'utf8');
  });
  afterAll(() => { try { nodeFs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ } });

  beforeEach(() => resetTestStorage());

  it('attaches SystemDialogs with open() and save()', async () => {
    const { window } = await loadDialogs();
    const svc = window.SystemDialogs;
    expect(svc).toBeTruthy();
    expect(Object.isFrozen(svc)).toBe(false);
    expect(typeof svc.open).toBe('function');
    expect(typeof svc.save).toBe('function');
  });

  it('defaults open/import and save dialogs to the mounted account root', async () => {
    const userRoot = { id: 'logged-in-account-root', path: tmpRoot };
    const { window, document } = await loadDialogs([], userRoot);
    const open = window.SystemDialogs.open();
    await settle(80);
    expect(pathBar(document).value).toBe(tmpRoot);
    itemByName(document, 'alpha.txt').click();
    confirmBtn(document).click();
    await expect(open).resolves.toMatchObject({
      path: nodePath.join(tmpRoot, 'alpha.txt'),
      name: 'alpha.txt',
    });

    const { window: saveWindow, document: saveDocument } = await loadDialogs([], userRoot);
    const save = saveWindow.SystemDialogs.save({ suggestedName: 'account-home.txt' });
    await settle(80);
    expect(pathBar(saveDocument).value).toBe(tmpRoot);
    confirmBtn(saveDocument).click();
    await expect(save).resolves.toEqual({
      path: nodePath.join(tmpRoot, 'account-home.txt'),
      name: 'account-home.txt',
    });
  });

  it('open() lists folders first (sorted), then files (sorted), with grid semantics', async () => {
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.open({ title: 'Open File', startPath: tmpRoot });
    await settle(80);

    const overlay = document.querySelector('.modal-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(document.querySelector('.modal-title').textContent).toBe('Open File');
    // folders first, both lists locale-sorted
    expect(items(document).map((el) => el.getAttribute('aria-label'))).toEqual(['sub', 'alpha.txt', 'beta.md']);
    expect(pathBar(document).value).toBe(tmpRoot);
    expect(confirmBtn(document).disabled).toBe(true); // nothing selected yet

    cancelBtn(document).click();
    await expect(p).resolves.toBe(null);
    expect(document.querySelector('.modal-overlay')).toBe(null); // dialog cleaned up
  });

  it('open() picks a file and resolves its content, mime and size', async () => {
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.open({ startPath: tmpRoot });
    await settle(80);

    itemByName(document, 'beta.md').click();
    expect(nameInput(document).value).toBe('beta.md');
    expect(itemByName(document, 'beta.md').getAttribute('aria-selected')).toBe('true');
    expect(confirmBtn(document).disabled).toBe(false);

    confirmBtn(document).click();
    const result = await p;
    expect(result).toEqual({
      path: nodePath.join(tmpRoot, 'beta.md'),
      name: 'beta.md',
      content: '# beta',
      mimeType: 'text/markdown',
      size: 6,
    });
    expect(document.querySelector('.modal-overlay')).toBe(null);
  });

  it('open() filters with custom predicates and <input accept> lists', async () => {
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.open({ startPath: tmpRoot, filter: (name, isDir) => isDir || name.startsWith('a') });
    await settle(80);
    expect(items(document).map((el) => el.getAttribute('aria-label'))).toEqual(['sub', 'alpha.txt']);
    cancelBtn(document).click();
    await p;

    const { window: w2, document: d2 } = await loadDialogs();
    const p2 = w2.SystemDialogs.open({ startPath: tmpRoot, accept: '.md' });
    await settle(80);
    expect(items(d2).map((el) => el.getAttribute('aria-label'))).toEqual(['sub', 'beta.md']);
    cancelBtn(d2).click();
    await p2;
  });

  it('directory mode: selecting a folder resolves { path, name } (falls back to cwd)', async () => {
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.open({ title: 'Choose Folder', directory: true, startPath: tmpRoot });
    await settle(80);

    expect(confirmBtn(document).textContent).toBe('Select');
    itemByName(document, 'sub').click(); // folders are selectable, files hidden
    expect(items(document).map((el) => el.getAttribute('aria-label'))).toEqual(['sub']);
    expect(nameInput(document).value).toBe('sub');

    confirmBtn(document).click();
    await expect(p).resolves.toEqual({ path: nodePath.join(tmpRoot, 'sub'), name: 'sub' });
  });

  it('multi-select: click toggles rows, confirm resolves every picked file', async () => {
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.open({ startPath: tmpRoot, multiple: true });
    await settle(80);

    itemByName(document, 'alpha.txt').click();
    itemByName(document, 'beta.md').click();
    expect(nameInput(document).value).toBe('2 files selected');
    itemByName(document, 'beta.md').click(); // toggling off
    expect(nameInput(document).value).toBe('alpha.txt');

    confirmBtn(document).click();
    const results = await p;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'alpha.txt', content: 'hello alpha', mimeType: 'text/plain', size: 11 });
  });

  it('save() prefills the name, resolves { path, name }, and rejects path-like names', async () => {
    const notifyCalls = [];
    const { window, document } = await loadDialogs(notifyCalls);
    const p = window.SystemDialogs.save({ title: 'Save As', suggestedName: 'untitled.txt', startPath: tmpRoot });
    await settle(80);

    expect(nameInput(document).value).toBe('untitled.txt');
    expect(confirmBtn(document).disabled).toBe(false);

    nameInput(document).value = 'sub/evil.txt';
    confirmBtn(document).click();
    await settle(30);
    expect(notifyCalls[0]).toMatchObject({ title: 'Invalid file name', body: 'Enter a file name, not a path.' });
    expect(document.querySelector('.modal-overlay')).toBeTruthy(); // dialog stays open

    nameInput(document).value = 'report.txt';
    confirmBtn(document).click();
    await expect(p).resolves.toEqual({ path: nodePath.join(tmpRoot, 'report.txt'), name: 'report.txt' });
  });

  it('navigates: double-click enters a folder, Up goes to the parent, Back walks history', async () => {
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.open({ startPath: tmpRoot });
    await settle(80);

    itemByName(document, 'sub').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    await settle(80);
    expect(pathBar(document).value).toBe(nodePath.join(tmpRoot, 'sub'));
    expect(items(document).map((el) => el.getAttribute('aria-label'))).toEqual(['inner.txt']);

    buttons(document).find((b) => b.title === 'Up').click();
    await settle(80);
    expect(pathBar(document).value).toBe(tmpRoot);

    buttons(document).find((b) => b.title === 'Back').click();
    await settle(80);
    expect(pathBar(document).value).toBe(nodePath.join(tmpRoot, 'sub'));

    // Enter in the path bar navigates; an unknown folder reports via Notify.
    pathBar(document).value = '/definitely/not/here';
    pathBar(document).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    await settle(80);
    expect(pathBar(document).value).toBe(nodePath.join(tmpRoot, 'sub')); // unchanged

    cancelBtn(document).click();
    await p;
  });

  it('navigating to a missing folder notifies "Folder unavailable" and keeps the dialog', async () => {
    const notifyCalls = [];
    const { window, document } = await loadDialogs(notifyCalls);
    const p = window.SystemDialogs.open({ startPath: tmpRoot });
    await settle(80);

    pathBar(document).value = nodePath.join(tmpRoot, 'nope');
    pathBar(document).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    await settle(80);

    expect(notifyCalls[0]).toMatchObject({ title: 'Folder unavailable', type: 'error' });
    expect(document.querySelector('.modal-overlay')).toBeTruthy();
    expect(pathBar(document).value).toBe(tmpRoot); // reset to the current folder

    cancelBtn(document).click();
    await expect(p).resolves.toBe(null);
  });

  it('Escape and backdrop clicks cancel; Enter in the name input confirms (save mode)', async () => {
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.open({ startPath: tmpRoot });
    await settle(80);
    document.querySelector('.modal-overlay')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(p).resolves.toBe(null);

    const { window: w2, document: d2 } = await loadDialogs();
    const p2 = w2.SystemDialogs.save({ startPath: tmpRoot, suggestedName: 'via-enter.txt' });
    await settle(80);
    d2.querySelector('.modal-overlay').dispatchEvent(new window.MouseEvent('click')); // target === overlay
    await expect(p2).resolves.toBe(null);

    const { window: w3, document: d3 } = await loadDialogs();
    const p3 = w3.SystemDialogs.save({ startPath: tmpRoot, suggestedName: 'enter-save.txt' });
    await settle(80);
    nameInput(d3).focus(); // the overlay handler only confirms when the name input is focused
    d3.querySelector('.modal-overlay').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    await expect(p3).resolves.toEqual({ path: nodePath.join(tmpRoot, 'enter-save.txt'), name: 'enter-save.txt' });
  });

  it('binary files resolve to a Buffer; text files to a decoded string', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    await fsPromises.writeFile(nodePath.join(tmpRoot, 'tiny.png'), png);
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.open({ startPath: tmpRoot });
    await settle(80);

    itemByName(document, 'tiny.png').click();
    confirmBtn(document).click();
    const result = await p;
    expect(result.mimeType).toBe('image/png');
    expect(Buffer.isBuffer(result.content)).toBe(true);
    expect(result.content.equals(png)).toBe(true);
    expect(result.size).toBe(png.length);
  });

  it('remembers the last visited folder per user (HKNU lastDir) and reopens there', async () => {
    const bag = new Map();
    const registry = mapRegistry(bag);
    const userRoot = { id: 'acct-root', path: tmpRoot };

    // First visit: start at the account root, browse into sub/, open inner.txt.
    const { window, document } = await loadDialogs([], userRoot, registry);
    const p = window.SystemDialogs.open(); // no startPath
    await settle(80);
    expect(pathBar(document).value).toBe(tmpRoot); // default: mounted account root
    itemByName(document, 'sub').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    await settle(80);
    itemByName(document, 'inner.txt').click();
    confirmBtn(document).click();
    await expect(p).resolves.toMatchObject({ name: 'inner.txt' });
    expect(bag.get('HKNU/shell/sysdialog/lastDir')).toBe(nodePath.join(tmpRoot, 'sub'));

    // Second dialog over the same registry reopens where the user left off.
    const { window: w2, document: d2 } = await loadDialogs([], userRoot, registry);
    const p2 = w2.SystemDialogs.open();
    await settle(80);
    expect(pathBar(d2).value).toBe(nodePath.join(tmpRoot, 'sub'));
    expect(items(d2).map((el) => el.getAttribute('aria-label'))).toEqual(['inner.txt']);
    cancelBtn(d2).click();
    await expect(p2).resolves.toBe(null);

    // A stale lastDir (folder no longer exists) falls back to the account root.
    bag.set('HKNU/shell/sysdialog/lastDir', nodePath.join(tmpRoot, 'gone'));
    const { window: w3, document: d3 } = await loadDialogs([], userRoot, registry);
    const p3 = w3.SystemDialogs.open();
    await settle(80);
    expect(pathBar(d3).value).toBe(tmpRoot);
    cancelBtn(d3).click();
    await expect(p3).resolves.toBe(null);

    // An explicit startPath always wins over the remembered directory.
    bag.set('HKNU/shell/sysdialog/lastDir', nodePath.join(tmpRoot, 'sub'));
    const { window: w4, document: d4 } = await loadDialogs([], userRoot, registry);
    const p4 = w4.SystemDialogs.open({ startPath: tmpRoot });
    await settle(80);
    expect(pathBar(d4).value).toBe(tmpRoot);
    cancelBtn(d4).click();
    await expect(p4).resolves.toBe(null);
  });

  it('sidebar quick access anchors on the account root and navigates with history', async () => {
    const userRoot = { id: 'acct-root', path: tmpRoot };
    const { window, document } = await loadDialogs([], userRoot);
    const p = window.SystemDialogs.open({ startPath: nodePath.join(tmpRoot, 'sub') });
    await settle(80);

    // Only Home is listed: the common folders (Desktop/Documents/…) do not
    // exist under the account root in the temp fixture, so they hide.
    const sideItems = [...document.querySelectorAll('.system-file-dialog-side-item')];
    expect(sideItems.map((b) => b.getAttribute('aria-label'))).toEqual(['Home']);
    expect(sideItems[0].classList.contains('active')).toBe(false); // cwd is sub/

    sideItems[0].click();
    await settle(80);
    expect(pathBar(document).value).toBe(tmpRoot);
    expect(sideItems[0].classList.contains('active')).toBe(true);

    // Sidebar navigation participates in toolbar history: Back returns.
    buttons(document).find((b) => b.title === 'Back').click();
    await settle(80);
    expect(pathBar(document).value).toBe(nodePath.join(tmpRoot, 'sub'));

    cancelBtn(document).click();
    await expect(p).resolves.toBe(null);
  });

  it('breadcrumbs navigate by segment; the edit affordance swaps to the path input', async () => {
    await fsPromises.mkdir(nodePath.join(tmpRoot, 'sub', 'sub2'), { recursive: true });
    const start = nodePath.join(tmpRoot, 'sub', 'sub2');
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.open({ startPath: start });
    await settle(80);

    // No mounted account root: root-anchored crumbs ("/ > tmp > … > sub").
    const crumbTexts = () => [...document.querySelectorAll('.system-file-dialog-crumb')].map((b) => b.textContent);
    const root = nodePath.parse(start).root;
    const segments = start.slice(root.length).split(nodePath.sep).filter(Boolean);
    expect(crumbTexts()).toEqual([root, ...segments.slice(0, -1)]); // root crumb + every ancestor segment
    expect(document.querySelector('.system-file-dialog-crumb-current').textContent).toBe('sub2');

    // Clicking a segment navigates (and records history).
    const subCrumb = [...document.querySelectorAll('.system-file-dialog-crumb')]
      .filter((b) => b.textContent === 'sub').pop(); // the deepest "sub" crumb
    subCrumb.click();
    await settle(80);
    expect(pathBar(document).value).toBe(nodePath.join(tmpRoot, 'sub'));
    expect(crumbTexts()).toEqual([root, ...segments.slice(0, -2)]);

    // Edit affordance: the pencil swaps the crumbs for the editable input.
    const editBtn = document.querySelector('.system-file-dialog-path-edit');
    const wrap = document.querySelector('.system-file-dialog-path-wrap');
    editBtn.click();
    expect(wrap.classList.contains('editing')).toBe(true);

    // Escape while editing reverts the value and leaves the dialog open.
    pathBar(document).value = '/definitely/not/here';
    pathBar(document).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(30);
    expect(wrap.classList.contains('editing')).toBe(false);
    expect(pathBar(document).value).toBe(nodePath.join(tmpRoot, 'sub'));
    expect(document.querySelector('.modal-overlay')).toBeTruthy();

    // Enter in the path input still navigates and returns to breadcrumb mode.
    editBtn.click();
    pathBar(document).value = tmpRoot;
    pathBar(document).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(80);
    expect(pathBar(document).value).toBe(tmpRoot);
    expect(wrap.classList.contains('editing')).toBe(false);
    expect(document.querySelector('.system-file-dialog-crumb-current').textContent).toBe(nodePath.basename(tmpRoot));

    cancelBtn(document).click();
    await expect(p).resolves.toBe(null);
  });

  it('"New folder" creates first-free numbered folders in the cwd and selects them', async () => {
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.open({ startPath: tmpRoot });
    await settle(80);

    const newFolderBtn = buttons(document).find((b) => b.getAttribute('aria-label') === 'New folder');
    expect(newFolderBtn).toBeTruthy();

    newFolderBtn.click();
    await settle(80);
    expect(nodeFs.statSync(nodePath.join(tmpRoot, 'New folder')).isDirectory()).toBe(true);
    expect(itemByName(document, 'New folder').getAttribute('aria-selected')).toBe('true');

    // The listing refresh re-renders the toolbar — re-query the live button
    // (a real user always clicks the button that is on screen now).
    buttons(document).find((b) => b.getAttribute('aria-label') === 'New folder').click();
    await settle(80);
    expect(nodeFs.statSync(nodePath.join(tmpRoot, 'New folder (2)')).isDirectory()).toBe(true);
    expect(itemByName(document, 'New folder (2)').getAttribute('aria-selected')).toBe('true');
    expect(itemByName(document, 'New folder').getAttribute('aria-selected')).toBe('false'); // selection moved

    cancelBtn(document).click();
    await expect(p).resolves.toBe(null);
  });

  it('save mode "New file" creates an empty file with the filter extension and prefills the name', async () => {
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.save({ startPath: tmpRoot, accept: '.json' });
    await settle(80);

    const newFileBtn = buttons(document).find((b) => b.getAttribute('aria-label') === 'New file');
    expect(newFileBtn).toBeTruthy();

    newFileBtn.click();
    await settle(80);
    const created = nodePath.join(tmpRoot, 'New file.json');
    expect(nodeFs.statSync(created).isFile()).toBe(true);
    expect(nodeFs.statSync(created).size).toBe(0);
    expect(nameInput(document).value).toBe('New file.json');
    expect(confirmBtn(document).disabled).toBe(false);

    // Re-query: the first creation re-renders the toolbar.
    buttons(document).find((b) => b.getAttribute('aria-label') === 'New file').click();
    await settle(80);
    expect(nodeFs.statSync(nodePath.join(tmpRoot, 'New file (2).json')).isFile()).toBe(true);
    expect(nameInput(document).value).toBe('New file (2).json');

    confirmBtn(document).click();
    await expect(p).resolves.toEqual({ path: nodePath.join(tmpRoot, 'New file (2).json'), name: 'New file (2).json' });
  });

  it('open mode hides the "New file" button (save mode only)', async () => {
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.open({ startPath: tmpRoot });
    await settle(80);
    expect(buttons(document).find((b) => b.getAttribute('aria-label') === 'New file')).toBeUndefined();
    cancelBtn(document).click();
    await expect(p).resolves.toBe(null);
  });
});
