// tests/apps/contacts.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/contacts/app.js. The real app is
// require()d against a real JSDOM window (cover-loader) and driven like a
// user: contacts are seeded through the storage the app reads, list rows are
// clicked/hovered through delegated events, the edit form is typed into and
// saved/cancelled, legacy databases (linux fs + FS API paths) are migrated,
// storage failures notify, and OS event-bus handlers (contacts:updated /
// languageChanged) are fired exactly like the shell does.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { coverLoadWindowApp, initCoveredApp, settle } from '../helpers/cover-loader.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SK = 'nova_contacts';

function contact(over = {}) {
  return {
    id: 'c-' + Math.random().toString(36).slice(2, 8),
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    phone: '+1 555 0100',
    notes: 'First programmer',
    ...over,
  };
}

// Event-bus stub the OS facade exposes; captured handlers let tests fire
// contacts:updated / languageChanged exactly like the shell does.
function makeEventBus() {
  const handlers = {};
  return {
    on: vi.fn((t, h) => { handlers[t] = h; return () => delete handlers[t]; }),
    off: vi.fn(),
    handlers,
  };
}

async function mount({ stubs = {}, state, os, seed, raw, init = true } = {}) {
  // OS is mirrored onto globalThis for the Node-realm app; without this the
  // previous test's OS stub would leak into "no OS" mounts.
  if (!os) { delete globalThis.OS; delete globalThis.window?.OS; }
  const extra = { ...(stubs.extra ?? {}), ...(os ? { OS: os } : {}) };
  const ctx = await coverLoadWindowApp('contacts', { stubs: { ...stubs, extra } });
  // base-utils installs lsSave/svgIcon on the jsdom window; mirror the ones
  // the app resolves as bare globals in the Node realm (same job the
  // cover-loader's mirrorI18nGlobals does for _t/createEl).
  for (const key of ['svgIcon', 'lsSave']) {
    if (ctx.window[key]) globalThis[key] = ctx.window[key];
  }
  // `seed` writes a parsed contact array; `raw` writes the exact blob the
  // app must read (empty, non-array, corrupt JSON). Both go into THIS load's
  // JSDOM storage before init, so the app sees exactly what the test staged.
  if (seed) localStorage.setItem(SK, JSON.stringify(seed));
  if (raw !== undefined) localStorage.setItem(SK, raw);
  const content = init ? initCoveredApp(ctx.app, { state: state ?? {} }) : null;
  return { ...ctx, content };
}

// Swap the cover realm's localStorage for one whose setItem always throws.
// The app resolves bare `localStorage` through globalThis at call time, so
// this is how a user's Save hits a full disk. jsdom's Storage is a Proxy that
// swallows property assignment, so vi.spyOn(localStorage, 'setItem') cannot
// intercept it — a whole-object swap is the reliable seam.
function failingStorage(message) {
  const real = globalThis.localStorage;
  return {
    getItem: real.getItem.bind(real),
    setItem: () => { throw new Error(message); },
    removeItem: real.removeItem.bind(real),
    clear: real.clear.bind(real),
    key: real.key.bind(real),
    get length() { return real.length; },
  };
}

const btn = (content, label) =>
  [...content.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
const rows = (content) => [...content.querySelectorAll('[data-id]')];
const rowByName = (content, name) => rows(content).find((r) => r.textContent.includes(name));
// detailArea = root > rightPanel > first child (view rows / edit form live here)
const detailArea = (content) => content.firstChild.lastChild.firstChild;
const infoRow = (content, value) => {
  const val = [...detailArea(content).querySelectorAll('div')]
    .find((d) => d.textContent === value && d.children.length === 0);
  return val ? val.parentElement.parentElement : null;
};

describe('Contacts app (js/apps/contacts/app.js) — e2e coverage', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.resetModules();
  });
  afterEach(() => vi.restoreAllMocks());

  it('registers a full app descriptor with the host', async () => {
    const { app } = await mount({});
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.nbosp.contacts');
    expect(app.name).toBe('Contacts');
    expect(app.version).toBe('3.0.2');
    expect(app.description).toBe('Contact Book');
    expect(app.icon).toBe('assets/icon.svg');
    expect(app.defaultSize).toEqual([640, 500]);
    expect(app.minSize).toEqual([440, 320]);
    expect(typeof app.init).toBe('function');
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const { content } = await mount({ stubs: { AppDirs: null } });
    expect(content.textContent).toContain('⚠️');
    expect(content.textContent).toContain('com.nbosp.contacts');
    expect(content.textContent).toContain('App data directory missing.');
    expect(content.textContent).toContain('This app requires NovaByte OS.');
    expect(content.querySelector('input')).toBeNull(); // no real UI built
  });

  it('shows the same fallback when the files data path resolves empty', async () => {
    const { content } = await mount({ stubs: { extra: { AppDirs: { getAppDataPath: () => '' } } } });
    expect(content.textContent).toContain('App data directory missing.');
    expect(content.querySelector('input')).toBeNull();
  });

  it('renders the empty state: search box, New Contact button, empty list', async () => {
    const { content } = await mount({});
    expect(content.querySelector('input[placeholder^="Search contacts"]')).toBeTruthy();
    expect(btn(content, 'New Contact')).toBeTruthy();
    expect(content.textContent).toContain('No contacts yet');
    expect(content.textContent).toContain('Select a contact');
    expect(rows(content)).toHaveLength(0);
  });

  it('migrates a legacy linux contacts.json database into localStorage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nv-contacts-'));
    try {
      writeFileSync(join(dir, 'contacts.json'), JSON.stringify([
        contact({ id: 'legacy-1', name: 'Legacy Larry', email: 'larry@old.os', phone: '555', notes: 'from disk' }),
        { broken: true }, // malformed legacy entry → dropped by validation
      ]));
      const { content } = await mount({
        stubs: { extra: { AppDirs: { getAppDataPath: (appId, kind) => (kind === 'databases' ? dir : `/data/${appId}/files`) } } },
      });
      expect(rows(content)).toHaveLength(1);
      expect(rowByName(content, 'Legacy Larry')).toBeTruthy();
      // Migration wrote the validated entries back into localStorage.
      const migrated = JSON.parse(localStorage.getItem(SK));
      expect(migrated).toHaveLength(1);
      expect(migrated[0]).toMatchObject({ id: 'legacy-1', name: 'Legacy Larry' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a legacy database directory without contacts.json as empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nv-contacts-'));
    try {
      writeFileSync(join(dir, 'unrelated.txt'), 'x');
      const { content } = await mount({
        stubs: { extra: { AppDirs: { getAppDataPath: (appId, kind) => (kind === 'databases' ? dir : `/data/${appId}/files`) } } },
      });
      expect(content.textContent).toContain('No contacts yet');
      expect(localStorage.getItem(SK)).toBeNull(); // nothing to migrate
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads legacy databases through the FS API on non-linux platforms', async () => {
    const legacy = JSON.stringify([contact({ id: 'fs-1', name: 'Fiona Starr', email: 'fiona@fs.os' })]);
    const variants = [
      // name/type mismatches in listDir → find() fails both predicates
      [[{ name: 'other.json', type: 'file', content: 'x' }, { name: 'contacts.json', type: 'dir', content: 'nope' }], null],
      // matching file but content is not a string
      [[{ name: 'contacts.json', type: 'file', year: 2024 }], null],
      // matching file with string content → loaded and migrated
      [[{ name: 'contacts.json', type: 'file', content: legacy }], 'Fiona Starr'],
    ];
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      for (const [nodes, expected] of variants) {
        localStorage.removeItem(SK);
        const ctx = await mount({ init: false, stubs: { extra: { FS: { listDir: () => nodes } } } });
        const content = initCoveredApp(ctx.app, { state: {} });
        if (expected) {
          expect(rowByName(content, expected)).toBeTruthy();
          expect(JSON.parse(localStorage.getItem(SK))[0].id).toBe('fs-1');
        } else {
          expect(content.textContent).toContain('No contacts yet');
        }
      }
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
    }
  });

  it('warns and starts empty when the legacy database directory is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { content } = await mount({
      stubs: { extra: { AppDirs: { getAppDataPath: (appId, kind) => (kind === 'databases' ? '' : `/data/${appId}/files`) } } },
    });
    expect(content.textContent).toContain('No contacts yet');
    expect(warn).toHaveBeenCalledWith(
      '[Contacts] Could not read saved contacts:',
      expect.objectContaining({ message: 'Contacts database directory is unavailable.' }),
    );
  });

  it('drops malformed persisted entries and survives corrupt storage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { content } = await mount({ seed: [
      contact({ id: 'ok-1', name: 'Valid Person' }),
      null, 42, 'a string', true,                     // not objects
      { name: 'Missing id', email: 'm@x.y' },          // no id
      { id: '' },                                      // empty id
      { id: 'x1', name: 7, email: 'a@b.c', phone: '1', notes: '' },  // name not string
      { id: 'x2', name: 'A', email: {}, phone: '1', notes: '' },     // email not string
      { id: 'x3', name: 'A', email: 'a@b.c', phone: [], notes: '' }, // phone not string
      { id: 'x4', name: 'A', email: 'a@b.c', phone: '1', notes: 3 }, // notes not string
    ] });
    expect(rows(content)).toHaveLength(1);
    expect(rowByName(content, 'Valid Person')).toBeTruthy();
    expect(content.textContent).not.toContain('Missing id');

    // empty-string blob → falsy raw → empty list
    const empty = await mount({ raw: '' });
    expect(empty.content.textContent).toContain('No contacts yet');

    // non-array JSON → ignored
    const nonArray = await mount({ raw: '{"not":"an array"}' });
    expect(nonArray.content.textContent).toContain('No contacts yet');

    // corrupt JSON → caught, warned, empty
    const corrupt = await mount({ raw: '{not json' });
    expect(corrupt.content.textContent).toContain('No contacts yet');
    expect(warn).toHaveBeenCalledWith('[Contacts] Ignoring unreadable contact data:', expect.anything());
  });

  it('creates a contact through the edit form, trims input and persists', async () => {
    const { content } = await mount({});
    btn(content, 'New Contact').click();
    const nameInp = content.querySelector('input[id$="-name"]');
    expect(nameInp).toBeTruthy();
    nameInp.value = '  Grace Hopper  ';
    content.querySelector('input[id$="-email"]').value = ' grace@example.com ';
    content.querySelector('input[id$="-phone"]').value = ' +1 555 0101 ';
    content.querySelector('textarea[id$="-notes"]').value = ' COBOL ';
    btn(content, 'Save').click();
    const stored = JSON.parse(localStorage.getItem(SK));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      name: 'Grace Hopper', email: 'grace@example.com',
      phone: '+1 555 0101', notes: 'COBOL',
    });
    // view mode now shows the saved contact
    expect(content.textContent).toContain('Grace Hopper');
    expect(content.textContent).toContain('grace@example.com');
  });

  it('defaults an empty name to "(no name)" when saving a new contact', async () => {
    const { content } = await mount({});
    btn(content, 'New Contact').click();
    expect(content.textContent).toContain('(no name)'); // unsaved placeholder row
    content.querySelector('input[id$="-email"]').value = 'anon@x.y';
    btn(content, 'Save').click();
    expect(JSON.parse(localStorage.getItem(SK))[0].name).toBe('(no name)');
    expect(content.textContent).toContain('(no name)');
  });

  it('highlights edit-form fields on focus and restores on blur', async () => {
    const { content, window } = await mount({});
    btn(content, 'New Contact').click();
    const fields = [
      content.querySelector('input[id$="-name"]'),
      content.querySelector('input[id$="-email"]'),
      content.querySelector('input[id$="-phone"]'),
      content.querySelector('textarea[id$="-notes"]'),
    ];
    expect(fields.every(Boolean)).toBe(true);
    for (const f of fields) {
      f.dispatchEvent(new window.Event('focus'));
      expect(f.style.borderColor).toBe('var(--accent)');
      f.dispatchEvent(new window.Event('blur'));
      expect(f.style.borderColor).toBe('var(--border-default)');
    }
  });

  it('discards a brand-new unsaved contact on cancel', async () => {
    const { content } = await mount({});
    btn(content, 'New Contact').click();
    btn(content, 'Cancel').click();
    expect(content.textContent).toContain('No contacts yet');
    expect(localStorage.getItem(SK)).toBeNull(); // never persisted
  });

  it('restores the pre-edit snapshot on cancel, then saves real edits', async () => {
    const seeded = [contact({ id: 'c-w', name: 'Niklaus Wirth', email: 'w@x.y' })];
    const { content } = await mount({ seed: seeded });
    rowByName(content, 'Niklaus Wirth').click();
    btn(content, 'Edit').click();
    const nameInp = content.querySelector('input[id$="-name"]');
    expect(nameInp.value).toBe('Niklaus Wirth');
    nameInp.value = 'Changed But Not Saved';
    btn(content, 'Cancel').click();
    expect(content.textContent).toContain('Niklaus Wirth');
    expect(content.textContent).not.toContain('Changed But Not Saved');
    expect(JSON.parse(localStorage.getItem(SK))[0].name).toBe('Niklaus Wirth');

    btn(content, 'Edit').click();
    content.querySelector('input[id$="-email"]').value = 'wirth@pascal.ch';
    btn(content, 'Save').click();
    const stored = JSON.parse(localStorage.getItem(SK));
    expect(stored[0].email).toBe('wirth@pascal.ch');
    expect(stored[0].name).toBe('Niklaus Wirth'); // untouched field preserved
  });

  it('renders view-mode detail rows with copy actions and a phone icon image', async () => {
    const Notify = { show: vi.fn() };
    const { content, window } = await mount({
      stubs: { extra: { Notify } },
      seed: [contact({ id: 'c-a', name: 'Ada Lovelace' })],
    });
    const origWrite = globalThis.navigator.clipboard.writeText;
    globalThis.navigator.clipboard.writeText = vi.fn(() => Promise.resolve(true));
    try {
      rowByName(content, 'Ada Lovelace').click();
      expect(content.textContent).toContain('AL'); // avatar initials

      // Email row: pointer cursor, runtime icon, hover feedback, click-to-copy.
      const emailRow = infoRow(content, 'ada@example.com');
      expect(emailRow).toBeTruthy();
      expect(emailRow.style.cursor).toBe('pointer');
      expect(emailRow.querySelector('img').getAttribute('src')).toBe('/assets/icons8-mail-94.png');
      emailRow.dispatchEvent(new window.Event('mouseenter'));
      expect(emailRow.style.background).toBe('var(--bg-hover)');
      emailRow.dispatchEvent(new window.Event('mouseleave'));
      expect(emailRow.style.background).toBe('');
      emailRow.click();
      expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith('ada@example.com');
      await settle(5);
      expect(Notify.show).toHaveBeenCalledWith({
        title: 'Copied', body: 'ada@example.com', type: 'info', appName: 'Contacts',
      });

      // Phone row uses the runtime <img> icon; a load failure hides it.
      const phoneRow = infoRow(content, '+1 555 0100');
      expect(phoneRow.style.cursor).toBe('pointer');
      const img = phoneRow.querySelector('img');
      expect(img.getAttribute('src')).toBe('/assets/icons8-call-94.png');
      expect(img.width).toBe(15);
      expect(img.draggable).toBe(false);
      img.dispatchEvent(new window.Event('error'));
      expect(img.style.visibility).toBe('hidden');
      phoneRow.dispatchEvent(new window.Event('mouseenter'));
      expect(phoneRow.style.background).toBe('var(--bg-hover)');
      phoneRow.dispatchEvent(new window.Event('mouseleave'));
      expect(phoneRow.style.background).toBe('');
      phoneRow.click();
      expect(globalThis.navigator.clipboard.writeText).toHaveBeenCalledWith('+1 555 0100');
      await settle(5);
      expect(Notify.show).toHaveBeenCalledWith({
        title: 'Copied', body: '+1 555 0100', type: 'info', appName: 'Contacts',
      });

      // Notes row renders with a runtime icon and is not clickable.
      const notesRow = infoRow(content, 'First programmer');
      expect(notesRow.style.cursor).toBe('default');
      expect(notesRow.querySelector('img')).toBeTruthy();
      notesRow.click(); // no clickFn → inert
    } finally {
      globalThis.navigator.clipboard.writeText = origWrite;
    }
  });

  it('omits empty info rows and falls back for nameless contacts', async () => {
    const { content } = await mount({ seed: [
      contact({ id: 'c-e', name: '', email: '', phone: '', notes: '' }),
      contact({ id: 'c-c', name: 'Cher', email: 'cher@x.y', phone: '', notes: '' }),
    ] });
    const list = rows(content);
    expect(list[0].firstChild.textContent).toBe('?');   // initials of ''
    expect(list[0].textContent).toContain('(no name)');
    expect(list[1].firstChild.textContent).toBe('C');   // single-word initials
    // sub line falls back email → phone → nothing
    expect(list[0].lastChild.lastChild.textContent).toBe('');
    expect(list[1].lastChild.lastChild.textContent).toBe('cher@x.y');

    list[0].click();
    expect(content.textContent).toContain('(no name)'); // nameEl fallback
    expect(content.querySelector('img')).toBeNull();    // no phone row
    expect(content.textContent).not.toContain('Email'); // no info rows at all
  });

  it('filters the list live as the user types', async () => {
    const { content, window } = await mount({ seed: [
      contact({ id: 'c-a', name: 'Zed Smith', email: 'zed@x.y' }),
      contact({ id: 'c-b', name: 'Ada Lovelace', email: 'ada@x.y' }),
      contact({ id: 'c-c', name: 'Kim Chen', email: 'kim@x.y' }),
    ] });
    // alphabetical order
    expect(rows(content).map((r) => r.textContent)).toEqual([
      expect.stringContaining('Ada Lovelace'),
      expect.stringContaining('Kim Chen'),
      expect.stringContaining('Zed Smith'),
    ]);
    const search = content.querySelector('input[placeholder^="Search contacts"]');
    const type = (v) => { search.value = v; search.dispatchEvent(new window.Event('input', { bubbles: true })); };
    type('ada');  // name match
    expect(rows(content)).toHaveLength(1);
    expect(rowByName(content, 'Ada Lovelace')).toBeTruthy();
    type('zed@'); // email-only match
    expect(rows(content)).toHaveLength(1);
    expect(rowByName(content, 'Zed Smith')).toBeTruthy();
    type('zzz');
    expect(content.textContent).toContain('No matches');
    type('');
    expect(rows(content)).toHaveLength(3);
  });

  it('drives hover and selection through delegated list events', async () => {
    const { content, window } = await mount({ seed: [
      contact({ id: 'c-a', name: 'Ada Lovelace' }),
      contact({ id: 'c-b', name: 'Bob Babbage' }),
    ] });
    const list = rows(content)[0].parentElement;
    const over = (el) => el.dispatchEvent(new window.Event('pointerover', { bubbles: true }));
    const out = (el) => el.dispatchEvent(new window.Event('pointerout', { bubbles: true }));

    // hover on an unselected row (dispatched on the avatar — target deeper
    // than the row itself, resolved via closest('[data-id]'))
    const ada = rowByName(content, 'Ada Lovelace');
    over(ada.firstChild);
    expect(ada.style.background).toBe('var(--bg-hover)');
    out(ada.firstChild);
    expect(ada.style.background).toBe('');

    // events that resolve to no row are inert
    list.dispatchEvent(new window.Event('pointerover'));
    list.dispatchEvent(new window.Event('pointerout'));
    list.click();
    expect(content.textContent).toContain('Select a contact');

    // clicking a row selects it (active row styling)
    ada.click();
    expect(rowByName(content, 'Ada Lovelace').style.background).toBe('var(--accent-muted)');
    // hover must not override the active style of the selected row
    const adaSel = rowByName(content, 'Ada Lovelace');
    over(adaSel);
    expect(adaSel.style.background).toBe('var(--accent-muted)');
    out(adaSel);
    expect(adaSel.style.background).toBe('var(--accent-muted)');
    // selecting another row moves the active style
    rowByName(content, 'Bob Babbage').click();
    expect(rowByName(content, 'Bob Babbage').style.background).toBe('var(--accent-muted)');
  });

  it('deletes the selected contact and persists the change', async () => {
    const { content } = await mount({ seed: [
      contact({ id: 'c-a', name: 'Ada Lovelace' }),
      contact({ id: 'c-b', name: 'Bob Babbage' }),
    ] });
    rowByName(content, 'Ada Lovelace').click();
    btn(content, 'Delete').click();
    expect(JSON.parse(localStorage.getItem(SK)).map((c) => c.id)).toEqual(['c-b']);
    expect(content.textContent).toContain('Bob Babbage');
    expect(content.textContent).toContain('Select a contact'); // selection cleared
  });

  it('notifies and stays in the edit form when the storage write fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Notify = { show: vi.fn() };
    const { content } = await mount({ stubs: { extra: { Notify } } });
    btn(content, 'New Contact').click();
    content.querySelector('input[id$="-name"]').value = 'Grace Hopper';
    const realStorage = globalThis.localStorage;
    globalThis.localStorage = failingStorage('disk full');
    btn(content, 'Save').click();
    globalThis.localStorage = realStorage;
    expect(Notify.show).toHaveBeenCalledWith({
      title: 'Contacts save failed', body: 'disk full', type: 'error', appName: 'Contacts',
    });
    expect(errorSpy).toHaveBeenCalledWith(
      '[Contacts] Could not save contacts:',
      expect.objectContaining({ message: 'disk full' }),
    );
    expect(content.querySelector('input[id$="-name"]')).toBeTruthy(); // still editing
  });

  it('keeps the contact when the delete-persist fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Notify = { show: vi.fn() };
    const { content } = await mount({
      stubs: { extra: { Notify } },
      seed: [contact({ id: 'c-a', name: 'Ada Lovelace' })],
    });
    rowByName(content, 'Ada Lovelace').click();
    const realStorage = globalThis.localStorage;
    globalThis.localStorage = failingStorage('readonly');
    btn(content, 'Delete').click();
    globalThis.localStorage = realStorage;
    expect(Notify.show).toHaveBeenCalledWith({
      title: 'Contacts save failed', body: 'readonly', type: 'error', appName: 'Contacts',
    });
    expect(rows(content)).toHaveLength(1); // nothing removed
    expect(content.textContent).toContain('Ada Lovelace'); // still selected
  });

  it('reloads on contacts:updated, clears stale selections, unsubscribes on cleanup', async () => {
    const events = makeEventBus();
    const state = { cleanups: [] };
    const { content } = await mount({
      os: { events }, state,
      seed: [
        contact({ id: 'c-a', name: 'Ada Lovelace' }),
        contact({ id: 'c-b', name: 'Bob Babbage' }),
      ],
    });
    expect(events.on).toHaveBeenCalledWith('contacts:updated', expect.any(Function));
    expect(events.on).toHaveBeenCalledWith('languageChanged', expect.any(Function));
    rowByName(content, 'Ada Lovelace').click();

    // external removal of the selected contact clears the selection
    localStorage.setItem(SK, JSON.stringify([contact({ id: 'c-b', name: 'Bob Babbage' })]));
    events.handlers['contacts:updated']();
    expect(rows(content)).toHaveLength(1);
    expect(content.textContent).toContain('Select a contact');
    // with no selection the handler is a pure re-render
    events.handlers['contacts:updated']();

    // selection survives when the contact is still present
    rowByName(content, 'Bob Babbage').click();
    localStorage.setItem(SK, JSON.stringify([
      contact({ id: 'c-b', name: 'Bob Babbage' }),
      contact({ id: 'c-c', name: 'Cyd Vega' }),
    ]));
    events.handlers['contacts:updated']();
    expect(rowByName(content, 'Cyd Vega')).toBeTruthy();
    expect(content.textContent).toContain('Notes'); // Bob still selected → view mode detail

    // window-manager teardown unsubscribes both listeners
    expect(state.cleanups.length).toBe(2);
    state.cleanups.forEach((fn) => fn());
    expect(events.off).toHaveBeenCalledWith('contacts:updated', expect.any(Function));
    expect(events.off).toHaveBeenCalledWith('languageChanged', expect.any(Function));
  });

  it('re-localises without losing half-typed edit drafts', async () => {
    const events = makeEventBus();
    const { content } = await mount({ os: { events } });
    btn(content, 'New Contact').click();
    content.querySelector('input[id$="-name"]').value = 'Grace Hopper';
    content.querySelector('input[id$="-email"]').value = 'grace@x.y';
    content.querySelector('input[id$="-phone"]').value = '555';
    content.querySelector('textarea[id$="-notes"]').value = 'WIP';
    events.handlers.languageChanged();
    // drafts were snapshotted from the DOM and written back into the rebuilt form
    expect(content.querySelector('input[id$="-name"]').value).toBe('Grace Hopper');
    expect(content.querySelector('input[id$="-email"]').value).toBe('grace@x.y');
    expect(content.querySelector('input[id$="-phone"]').value).toBe('555');
    expect(content.querySelector('textarea[id$="-notes"]').value).toBe('WIP');
    // toolbar labels re-derived through _t
    expect(content.querySelector('input[placeholder^="Search contacts"]')).toBeTruthy();
    expect(btn(content, 'New Contact').textContent).toContain('New Contact');
    // view-mode re-render (editMode false) skips the draft logic entirely
    btn(content, 'Cancel').click();
    events.handlers.languageChanged();
    expect(content.textContent).toContain('No contacts yet');
  });

  it('skips draft restore when the edit form fields cannot be re-queried', async () => {
    const events = makeEventBus();
    const { content } = await mount({ os: { events } });
    // A selector-hostile contact id makes the `#nbosp-contacts-<id>-<key>`
    // lookups miss (the dot parses as a class combinator) — the draft
    // snapshot comes up empty and the restore loop skips every key.
    const realRandom = globalThis.crypto.randomUUID;
    globalThis.crypto.randomUUID = () => 'weird.id';
    try {
      btn(content, 'New Contact').click();
      content.querySelector('input[id$="-name"]').value = 'Typed Draft';
      events.handlers.languageChanged();
      const rebuilt = content.querySelector('input[id$="-name"]');
      expect(rebuilt).toBeTruthy(); // form rebuilt from state, no crash
      expect(rebuilt.value).toBe(''); // draft dropped
    } finally {
      globalThis.crypto.randomUUID = realRandom;
    }
  });

  it('drops a captured draft when its field disappeared in the re-render', async () => {
    const events = makeEventBus();
    const { content, window } = await mount({ os: { events } });
    const realRandom = globalThis.crypto.randomUUID;
    globalThis.crypto.randomUUID = () => 'weird.id';
    try {
      btn(content, 'New Contact').click();
      // The real name field gets the literal id `nbosp-contacts-weird.id-name`.
      // Plant a decoy inside detailArea that the draft-read selector
      // `#nbosp-contacts-weird.id-name` (id + class combinator) DOES match —
      // the re-render clears detailArea, so the write-back query then finds
      // nothing and the draft is dropped.
      const decoy = window.document.createElement('input');
      decoy.id = 'nbosp-contacts-weird';
      decoy.className = 'id-name';
      decoy.value = 'ghost draft';
      detailArea(content).appendChild(decoy);
      events.handlers.languageChanged();
      const nameInp = content.querySelector('input[id$="-name"]');
      expect(nameInp).toBeTruthy();
      expect(nameInp.value).toBe(''); // ghost draft NOT written back
      expect(content.querySelector('#nbosp-contacts-weird.id-name')).toBeNull();
    } finally {
      globalThis.crypto.randomUUID = realRandom;
    }
  });

  it('warns and continues when the language re-render explodes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events = makeEventBus();
    const { content, window } = await mount({
      os: { events }, seed: [contact({ id: 'c-a', name: 'Ada Lovelace' })],
    });
    const orig = window.NovaI18n;
    window.NovaI18n = { ...orig, applyStaticDom: () => { throw new Error('boom'); } };
    events.handlers.languageChanged();
    expect(warn).toHaveBeenCalledWith(
      '[Contacts] Language change re-render failed:',
      expect.objectContaining({ message: 'boom' }),
    );
    // an engine without applyStaticDom is tolerated (optional call skipped)
    window.NovaI18n = {};
    events.handlers.languageChanged();
    expect(content.textContent).toContain('Ada Lovelace');
    // a missing engine entirely is tolerated too (optional chain skipped)
    window.NovaI18n = undefined;
    events.handlers.languageChanged();
    expect(content.textContent).toContain('Ada Lovelace');
    window.NovaI18n = orig;
  });

  it('works without an OS event bus and without any OS at all', async () => {
    // OS present but no event bus → no registrations, no cleanups
    const state = {};
    const bare = await mount({ os: {}, state });
    expect(bare.content.textContent).toContain('No contacts yet');
    expect(state.cleanups).toBeUndefined();
    // OS with an events object that lacks on() → same
    const state2 = {};
    const noOn = await mount({ os: { events: {} }, state: state2 });
    expect(noOn.content.textContent).toContain('No contacts yet');
    expect(state2.cleanups).toBeUndefined();
    // no OS global at all
    const none = await mount({ seed: [contact({ id: 'c-a', name: 'Ada Lovelace' })] });
    expect(rowByName(none.content, 'Ada Lovelace')).toBeTruthy();
  });

  it('creates its own cleanups array when the state arrives without one', async () => {
    const events = makeEventBus();
    const state = {};
    await mount({ os: { events }, state });
    expect(Array.isArray(state.cleanups)).toBe(true);
    expect(state.cleanups.length).toBe(2);
  });
});
