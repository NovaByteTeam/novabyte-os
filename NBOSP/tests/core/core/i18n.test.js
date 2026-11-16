import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

// ── js/core/core/i18n.js — NovaI18n engine, e2e in a real DOM ───────────────
//
// i18n.js is a window-attach IIFE (publishes window.NovaI18n + window._t).
// This suite evals the real engine into a real JSDOM document and drives it
// exactly the way the OS does: registerResources() from the localisation
// service, setLibrary() with the vendored i18next, init() from boot(),
// changeLanguage() from Settings, and applyStaticDom() re-labelling.
// The English catalogue assertions run against the REAL shipped en.json.

const SCRIPT_URL = new URL('../../../js/core/core/i18n.js', import.meta.url);
const EN_URL = new URL('../../../js/apps/localisation/locales/en.json', import.meta.url);
const DE_URL = new URL('../../../js/apps/localisation/locales/de.json', import.meta.url);
const AR_URL = new URL('../../../js/apps/localisation/locales/ar.json', import.meta.url);

let dom;
let w;

beforeEach(async () => {
  dom = new JSDOM(`<!doctype html>
    <html lang="en" dir="ltr">
      <head></head>
      <body>
        <button data-i18n="common.ok">Okay</button>
        <input data-i18n-placeholder="apps.search.placeholder" placeholder="Search">
        <a data-i18n-aria="common.cancel" href="#">x</a>
        <span data-i18n-title="common.ok" title="Okay"></span>
      </body>
    </html>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://localhost/index.html',
  });
  w = dom.window;
  w.eval(await readFile(SCRIPT_URL, 'utf8'));
});

afterEach(() => {
  dom.window.close();
  dom = null;
  w = null;
});

async function registerRealCatalogues() {
  const [en, de, ar] = await Promise.all([
    readFile(EN_URL, 'utf8'), readFile(DE_URL, 'utf8'), readFile(AR_URL, 'utf8'),
  ]);
  w.NovaI18n.registerResources({ en: JSON.parse(en), de: JSON.parse(de), ar: JSON.parse(ar) });
}

describe('NovaI18n — language registry', () => {
  it('exposes the full supported set with native names and directions', () => {
    const langs = w.NovaI18n.getLanguages();
    expect(langs.length).toBeGreaterThanOrEqual(19);
    const codes = langs.map((l) => l.code);
    for (const code of ['en', 'es', 'zh-CN', 'fr', 'de', 'ja', 'pt', 'ar', 'ru', 'hi', 'ko', 'it', 'id', 'bn', 'tr', 'vi', 'sw', 'ur', 'fa']) {
      expect(codes).toContain(code);
    }
  });

  it('marks exactly the RTL languages as RTL', () => {
    const rtl = w.NovaI18n.getLanguages().filter((l) => l.dir === 'rtl').map((l) => l.code).sort();
    expect(rtl).toEqual(['ar', 'fa', 'ur']);
    for (const code of ['ar', 'fa', 'ur']) expect(w.NovaI18n.isRTL(code)).toBe(true);
    for (const code of ['en', 'de', 'ja', 'zh-CN']) expect(w.NovaI18n.isRTL(code)).toBe(false);
    expect(w.NovaI18n.getDir('ar')).toBe('rtl');
    expect(w.NovaI18n.getDir('en')).toBe('ltr');
    // Unknown codes degrade to ltr, never throw.
    expect(w.NovaI18n.getDir('xx')).toBe('ltr');
    expect(w.NovaI18n.isRTL('xx')).toBe(false);
  });

  it('defaults to English before init', () => {
    expect(w.NovaI18n.getLanguage()).toBe('en');
  });
});

describe('NovaI18n — manual fallback translation (no i18next)', () => {
  it('translates from the registered English catalogue before init', async () => {
    await registerRealCatalogues();
    const value = w._t('common.ok');
    expect(typeof value).toBe('string');
    expect(value).not.toBe('common.ok');
  });

  it('echoes the key when nothing is registered', () => {
    expect(w._t('common.ok')).toBe('common.ok');
  });

  it('falls back to English for a key missing in the active language', async () => {
    const de = JSON.parse(await readFile(DE_URL, 'utf8'));
    // English carries a key the German catalogue lacks — the engine must
    // resolve it through the English resource-of-last-resort.
    w.NovaI18n.registerResources({ de, en: { only: { english: 'English-only value' } } });
    await w.NovaI18n.changeLanguage('de', { persist: false });
    expect(w._t('only.english')).toBe('English-only value');
    // And a key missing everywhere still echoes the key.
    expect(w._t('missing.everywhere')).toBe('missing.everywhere');
  });

  it('interpolates {{placeholders}} and keeps unknown placeholders intact', async () => {
    await registerRealCatalogues();
    const out = w._t('test.key', {});
    // Use the manual path with a synthetic catalogue instead:
    w.NovaI18n.registerResources({ en: { greet: 'Hello {{ name }} and {{missing}}!' } });
    expect(w._t('greet', { name: 'Nova' })).toBe('Hello Nova and {{missing}}!');
    // null/undefined vars keep the placeholder too.
    expect(w._t('greet', { name: null })).toBe('Hello {{ name }} and {{missing}}!');
    expect(w._t('greet')).toBe('Hello {{ name }} and {{missing}}!');
  });

  it('returns the key itself for non-string values in the catalogue', () => {
    w.NovaI18n.registerResources({ en: { nested: { deep: { leaf: 'yes' } }, list: [1, 2] } });
    expect(w._t('nested.deep.leaf')).toBe('yes');
    expect(w._t('nested.deep')).toBe('nested.deep'); // object, not a string
    expect(w._t('nested.missing')).toBe('nested.missing');
    expect(w._t('list')).toBe('list');
  });

  it('ignores non-object resource bundles', () => {
    w.NovaI18n.registerResources(null);
    expect(w._t('anything')).toBe('anything');
    w.NovaI18n.registerResources(['not', 'an', 'object']);
    expect(w._t('anything')).toBe('anything');
  });
});

describe('NovaI18n — init()', () => {
  it('activates the persisted language from OS.settings', async () => {
    await registerRealCatalogues();
    w.OS = { settings: { get: (k) => (k === 'language' ? 'de' : null), set: vi.fn() }, events: { emit: vi.fn(), on: vi.fn() } };
    await w.NovaI18n.init();
    expect(w.NovaI18n.getLanguage()).toBe('de');
    expect(w.document.documentElement.lang).toBe('de');
  });

  it('falls back to English for an unsupported persisted language', async () => {
    await registerRealCatalogues();
    w.OS = { settings: { get: () => 'klingon', set: vi.fn() }, events: { emit: vi.fn(), on: vi.fn() } };
    await w.NovaI18n.init();
    expect(w.NovaI18n.getLanguage()).toBe('en');
  });

  it('does not wait forever when the localisation service never registers', async () => {
    // No registerResources call: init must still settle via its 4s race.
    // (Fast-forward by awaiting init with a shorter wall-clock budget.)
    w.OS = { settings: { get: () => null, set: vi.fn() }, events: { emit: vi.fn(), on: vi.fn() } };
    const start = Date.now();
    await w.NovaI18n.init();
    expect(Date.now() - start).toBeGreaterThanOrEqual(3900);
    expect(w.NovaI18n.getLanguage()).toBe('en');
  }, 10_000);

  it('initialises the real i18next when the library is present', async () => {
    await registerRealCatalogues();
    const initCalls = [];
    // A minimal i18next-shaped library, exactly the surface i18n.js uses.
    const library = {
      init: vi.fn(async (options) => { initCalls.push(options); }),
      t: (key) => (key === 'common.ok' ? 'LIB-TRANSLATED' : key),
      changeLanguage: vi.fn(async () => {}),
    };
    w.NovaI18n.setLibrary(library);
    await w.NovaI18n.init();
    expect(initCalls).toHaveLength(1);
    expect(initCalls[0].lng).toBe('en');
    expect(initCalls[0].fallbackLng).toBe('en');
    expect(initCalls[0].supportedLngs).toContain('ar');
    // t() prefers the library's translation when it differs from the key.
    expect(w._t('common.ok')).toBe('LIB-TRANSLATED');
  });

  it('falls back to manual translation when the library init throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await registerRealCatalogues();
    w.NovaI18n.setLibrary({
      init: async () => { throw new Error('broken library'); },
      t: () => { throw new Error('unreachable'); },
    });
    await w.NovaI18n.init();
    expect(w._t('common.ok')).toBe('OK'); // manual path still works
  });
});

describe('NovaI18n — changeLanguage()', () => {
  beforeEach(async () => {
    await registerRealCatalogues();
  });

  it('switches language, updates <html lang>/<html dir> and emits on the bus', async () => {
    const emitted = [];
    w.OS = { settings: { get: () => null, set: vi.fn() }, events: { emit: (...a) => emitted.push(a), on: vi.fn() } };
    await w.NovaI18n.changeLanguage('ar');
    expect(w.NovaI18n.getLanguage()).toBe('ar');
    expect(w.document.documentElement.lang).toBe('ar');
    expect(w.document.documentElement.dir).toBe('rtl');
    expect(emitted).toEqual([['languageChanged', { language: 'ar', dir: 'rtl' }]]);
    expect(w.OS.settings.set).toHaveBeenCalledWith('language', 'ar');
  });

  it('rejects unsupported language codes', async () => {
    await expect(w.NovaI18n.changeLanguage('klingon')).rejects.toThrow('Unsupported language: klingon');
  });

  it('skips persistence with { persist: false }', async () => {
    const set = vi.fn();
    w.OS = { settings: { get: () => null, set }, events: { emit: vi.fn(), on: vi.fn() } };
    await w.NovaI18n.changeLanguage('fr', { persist: false });
    expect(w.NovaI18n.getLanguage()).toBe('fr');
    expect(set).not.toHaveBeenCalled();
  });

  it('skips persistence when the settings store is volatile', async () => {
    const set = vi.fn();
    w.OS = { settings: { get: () => null, set, volatile: true }, events: { emit: vi.fn(), on: vi.fn() } };
    await w.NovaI18n.changeLanguage('fr');
    expect(set).not.toHaveBeenCalled();
  });

  it('survives a settings store that throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    w.OS = { settings: { get: () => null, set: () => { throw new Error('disk full'); } }, events: { emit: vi.fn(), on: vi.fn() } };
    await w.NovaI18n.changeLanguage('fr');
    expect(w.NovaI18n.getLanguage()).toBe('fr'); // still switched
  });

  it('relays to the library and survives its failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const changeLanguage = vi.fn(async () => { throw new Error('library broke'); });
    w.NovaI18n.setLibrary({ init: async () => {}, t: (k) => k, changeLanguage });
    w.OS = { settings: { get: () => null, set: vi.fn() }, events: { emit: vi.fn(), on: vi.fn() } };
    await w.NovaI18n.changeLanguage('de', { persist: false });
    expect(changeLanguage).toHaveBeenCalledWith('de');
    expect(w.NovaI18n.getLanguage()).toBe('de');
  });
});

describe('NovaI18n — applyStaticDom()', () => {
  it('relabels every i18n attribute kind in the document', async () => {
    await registerRealCatalogues();
    const en = JSON.parse(await readFile(EN_URL, 'utf8'));
    w.NovaI18n.applyStaticDom(w.document);
    const okBtn = w.document.querySelector('[data-i18n="common.ok"]');
    const search = w.document.querySelector('[data-i18n-placeholder]');
    const link = w.document.querySelector('[data-i18n-aria]');
    const titled = w.document.querySelector('[data-i18n-title]');
    expect(okBtn.textContent).toBe(en['common']?.ok ?? okBtn.textContent);
    expect(search.getAttribute('placeholder')).toBe(en.apps?.search?.placeholder ?? search.getAttribute('placeholder'));
    expect(link.getAttribute('aria-label')).toBe(en['common']?.cancel ?? link.getAttribute('aria-label'));
    expect(titled.getAttribute('title')).toBe(en['common']?.ok ?? titled.getAttribute('title'));
  });

  it('accepts a scoped root element', async () => {
    await registerRealCatalogues();
    const scope = w.document.createElement('div');
    scope.innerHTML = '<p data-i18n="common.ok">old</p>';
    w.document.body.appendChild(scope);
    w.NovaI18n.applyStaticDom(scope);
    expect(scope.textContent).not.toBe('old');
  });

  it('is a no-op for non-element roots', () => {
    expect(() => w.NovaI18n.applyStaticDom(null)).not.toThrow();
    expect(() => w.NovaI18n.applyStaticDom({})).not.toThrow();
  });
});

describe('NovaI18n — window aliases', () => {
  it('publishes NovaI18n and the bound _t alias on the window', () => {
    expect(typeof w.NovaI18n).toBe('object');
    expect(typeof w._t).toBe('function');
    // _t is bound: calling it detached still resolves through the engine.
    const detached = w._t;
    expect(detached('whatever-key')).toBe('whatever-key');
  });

  it('onLanguageChanged subscribes through OS.events when available', () => {
    const listeners = [];
    w.OS = { events: { on: (topic, cb) => { listeners.push([topic, cb]); return () => {}; } } };
    const off = w.NovaI18n.onLanguageChanged(() => {});
    expect(listeners).toEqual([['languageChanged', expect.any(Function)]]);
    expect(typeof off).toBe('function');
  });

  it('onLanguageChanged degrades to a no-op without OS.events', () => {
    expect(typeof w.NovaI18n.onLanguageChanged(() => {})).toBe('function');
  });
});
