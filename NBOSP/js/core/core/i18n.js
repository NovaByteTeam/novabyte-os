// ── NovaI18n — core localisation engine ──────────────────────────────
//
// Loaded early from index.html (right after the kernel defines OS), this
// module is the single stable localisation API for the whole OS shell.
// The com.nbosp.localisation system service (js/apps/localisation/) injects
// the vendored i18next build and registers the language catalogues BEFORE
// window.boot() runs; boot() then calls NovaI18n.init() once the settings
// store has loaded, which activates the persisted language before any
// shell surface renders.
//
// Consumers use either the core method NovaI18n.t(key, vars) or the short
// global alias window._t (bound). Both are safe to call before init():
// they fall back to a manual English lookup with {{placeholder}}
// interpolation, and echo the key itself only when even English is
// unavailable (localisation service failed to load) so problems are
// visible rather than silent.
//
// State changes flow through changeLanguage(): it switches i18next,
// updates <html lang> and (for RTL languages like Arabic) <html dir>,
// re-labels statically marked DOM (data-i18n / data-i18n-aria /
// data-i18n-placeholder / data-i18n-title attributes), persists the choice
// through OS.settings (unless the caller opts out — the OOBE wizard
// persists the final choice itself once the owner hive is mounted), and
// emits 'languageChanged' on the OS event bus so every live surface
// (taskbar, launchpad, desktop icons, notification panel, settings,
// setup wizard) can re-render in the new language.
(() => {
  'use strict';

  // The supported system languages — the single source of truth for the
  // language registry, the validators, and the pickers. Native names are
  // locale metadata (like Intl display names), not translated UI strings,
  // so they live here rather than in the catalogues.
  const LANGUAGES = Object.freeze([
    { code: 'en',    nativeName: 'English',   dir: 'ltr' },
    { code: 'es',    nativeName: 'Español',    dir: 'ltr' },
    { code: 'zh-CN', nativeName: '简体中文',    dir: 'ltr' },
    { code: 'fr',    nativeName: 'Français',   dir: 'ltr' },
    { code: 'de',    nativeName: 'Deutsch',    dir: 'ltr' },
    { code: 'ja',    nativeName: '日本語',      dir: 'ltr' },
    { code: 'pt',    nativeName: 'Português',  dir: 'ltr' },
    { code: 'ar',    nativeName: 'العربية',     dir: 'rtl' },
    { code: 'ru',    nativeName: 'Русский',    dir: 'ltr' },
    { code: 'hi',    nativeName: 'हिन्दी',       dir: 'ltr' },
    { code: 'ko',    nativeName: '한국어',      dir: 'ltr' },
    { code: 'it',    nativeName: 'Italiano',   dir: 'ltr' },
  ]);
  const LANGUAGE_INDEX = new Map(LANGUAGES.map(language => [language.code, language]));
  const DEFAULT_LANGUAGE = 'en';
  // The com.nbosp.localisation service resolves this once its catalogues
  // are registered; init() races it against a timeout so a missing package
  // can never stall the boot sequence.
  let resolveResources;
  const resourcesGate = new Promise(resolve => { resolveResources = resolve; });

  // Engine state ---------------------------------------------------------
  let i18next = null;          // vendored library instance (or null)
  let resources = {};          // { en: {...}, es: {...}, ... } plain catalogues
  let currentLanguage = null;  // validated active language code
  let initialised = false;

  // ── Manual fallback translator (no i18next required) ────────────────
  function lookup(catalogue, key) {
    if (!catalogue || typeof key !== 'string') return null;
    let node = catalogue;
    for (const segment of key.split('.')) {
      if (!node || typeof node !== 'object' || !(segment in node)) return null;
      node = node[segment];
    }
    return typeof node === 'string' ? node : null;
  }

  function interpolate(template, vars) {
    if (!vars) return template;
    return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name) => (
      vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : match
    ));
  }

  function fallbackTranslate(key, vars) {
    // Preferred order: the active language catalogue, then English (the
    // resource-of-last-resort contract every catalogue ships against).
    for (const code of [currentLanguage, DEFAULT_LANGUAGE]) {
      const value = lookup(resources[code], key);
      if (typeof value === 'string') return interpolate(value, vars);
    }
    return typeof key === 'string' ? key : String(key);
  }

  // ── Public API ───────────────────────────────────────────────────────
  const NovaI18n = {
    /** The core translation method (also aliased as window._t). */
    t(key, vars) {
      if (i18next && initialised) {
        try {
          const translated = i18next.t(key, vars || {});
          if (typeof translated === 'string' && translated && translated !== key) {
            return translated;
          }
        } catch (_) { /* fall through to the manual path */ }
      }
      return fallbackTranslate(key, vars);
    },

    /** Called by the localisation service with { language: catalogue }. */
    registerResources(bundles) {
      resources = (bundles && typeof bundles === 'object' && !Array.isArray(bundles))
        ? bundles
        : {};
      resolveResources();
    },

    /** Called by the localisation service with the vendored i18next. */
    setLibrary(library) {
      if (library && typeof library === 'object') i18next = library;
    },

    /**
     * Boot hook — activates the persisted language. Called by boot() after
     * OS.settings.load() and before any UI stage renders. Fail-soft: a
     * broken or missing localisation stack must never block the boot.
     */
    async init() {
      if (initialised) return;
      const timeout = new Promise(resolve => setTimeout(resolve, 4000));
      await Promise.race([resourcesGate, timeout]);

      let language = DEFAULT_LANGUAGE;
      try {
        const saved = (typeof OS !== 'undefined' && OS.settings?.get)
          ? OS.settings.get('language')
          : null;
        if (typeof saved === 'string' && LANGUAGE_INDEX.has(saved)) language = saved;
      } catch (_) { /* defaults win */ }

      if (i18next) {
        try {
          await i18next.init({
            lng: language,
            fallbackLng: DEFAULT_LANGUAGE,
            load: 'currentOnly',
            supportedLngs: LANGUAGES.map(item => item.code),
            resources: Object.fromEntries(
              Object.entries(resources).map(([code, catalogue]) => [code, { translation: catalogue }])
            ),
            interpolation: { escapeValue: false },
            returnEmptyString: false,
          });
        } catch (error) {
          console.error('[NovaI18n] i18next init failed — manual fallback active:', error);
          i18next = null;
        }
      }

      currentLanguage = language;
      initialised = true;
      NovaI18n.applyDocumentLanguage(language);
      NovaI18n.applyStaticDom(document);
    },

    /**
     * Switch the active language. Persists through OS.settings unless
     * { persist: false } (the OOBE wizard opts out and writes the final
     * value itself after the owner hive is mounted).
     */
    async changeLanguage(code, { persist = true } = {}) {
      const language = LANGUAGE_INDEX.get(code);
      if (!language) throw new TypeError(`Unsupported language: ${code}`);
      currentLanguage = language.code;

      if (i18next) {
        try {
          await i18next.changeLanguage(language.code);
        } catch (error) {
          console.error('[NovaI18n] i18next changeLanguage failed:', error);
        }
      }

      if (persist && typeof OS !== 'undefined' && OS.settings &&
          OS.settings.volatile !== true) {
        try { OS.settings.set('language', language.code); } catch (error) {
          console.error('[NovaI18n] Could not persist language choice:', error);
        }
      }

      NovaI18n.applyDocumentLanguage(language.code);
      NovaI18n.applyStaticDom(document);
      try {
        OS.events?.emit?.('languageChanged', { language: language.code, dir: language.dir });
      } catch (_) { /* event bus unavailable (tests) */ }
    },

    /** Active language code ('en' before init). */
    getLanguage() {
      return currentLanguage || DEFAULT_LANGUAGE;
    },

    /** Language registry for pickers: [{ code, nativeName, dir }]. */
    getLanguages() {
      return LANGUAGES.map(language => ({ ...language }));
    },

    isRTL(code) {
      const language = LANGUAGE_INDEX.get(code || currentLanguage || DEFAULT_LANGUAGE);
      return language?.dir === 'rtl';
    },

    getDir(code) {
      const language = LANGUAGE_INDEX.get(code || currentLanguage || DEFAULT_LANGUAGE);
      return language?.dir || 'ltr';
    },

    /** Update <html lang> + <html dir> (RTL mirroring for Arabic). */
    applyDocumentLanguage(code) {
      const language = LANGUAGE_INDEX.get(code) || LANGUAGE_INDEX.get(DEFAULT_LANGUAGE);
      try {
        document.documentElement.lang = language.code;
        document.documentElement.dir = language.dir;
      } catch (_) { /* read-only document (tests) */ }
    },

    /**
     * Re-label DOM marked with i18n attributes. Keeping the original
     * English text in the markup means an uninitialised engine still
     * renders a sensible English shell; this pass localises it live.
     */
    applyStaticDom(root) {
      const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
      if (!scope || typeof scope.querySelectorAll !== 'function') return;
      for (const element of scope.querySelectorAll('[data-i18n]')) {
        const key = element.getAttribute('data-i18n');
        if (key) element.textContent = NovaI18n.t(key);
      }
      for (const element of scope.querySelectorAll('[data-i18n-aria]')) {
        const key = element.getAttribute('data-i18n-aria');
        if (key) element.setAttribute('aria-label', NovaI18n.t(key));
      }
      for (const element of scope.querySelectorAll('[data-i18n-placeholder]')) {
        const key = element.getAttribute('data-i18n-placeholder');
        if (key) element.setAttribute('placeholder', NovaI18n.t(key));
      }
      for (const element of scope.querySelectorAll('[data-i18n-title]')) {
        const key = element.getAttribute('data-i18n-title');
        if (key) element.setAttribute('title', NovaI18n.t(key));
      }
    },

    /** Subscribe to language changes (thin OS.events wrapper). */
    onLanguageChanged(callback) {
      if (typeof OS === 'undefined' || !OS.events?.on) return () => {};
      return OS.events.on('languageChanged', callback);
    },
  };

  window.NovaI18n = NovaI18n;
  // Short global alias so refactored UI code stays clean and readable.
  window._t = NovaI18n.t.bind(NovaI18n);
})();
