(function () {
  'use strict';

  /**
   * com.nbosp.localisation — NovaByte Localisation system service.
   *
   * SystemServiceLoader injects this script into the trusted OS page (as a
   * first-party system-bundle service, validated by UnrestrictedGate) BEFORE
   * window.boot() runs. Its job is deliberately tiny:
   *
   *   1. fetch its own .novaapp package (through the AppLoaderOptimizer
   *      cache when available, direct fetch otherwise — both channels are
   *      the same statically-served file the loader itself used),
   *   2. inject the vendored i18next UMD build bundled under vendor/ so the
   *      engine never depends on node_modules being installed,
   *   3. decode locales/<language>.json for every supported language and
   *      hand them to the core NovaI18n engine (js/core/core/i18n.js).
   *
   * Everything user-facing — language persistence, <html lang/dir> updates,
   * static-DOM re-labelling, RTL mirroring and the languageChanged fan-out —
   * is owned by the core engine, which boot() brings online after the
   * settings store loads. This keeps the language surface identical in dev,
   * production and OOBE, with zero network round-trips at switch time.
   */

  const APP_ID = 'com.nbosp.localisation';
  const APP_FILE = `js/apps/${APP_ID}.novaapp`;

  function decodePackageFile(encoded) {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  async function loadOwnPackage() {
    // Preferred channel: the AppLoaderOptimizer cache — the same one the
    // service loader just used, so this is an IndexedDB read, not a second
    // HTTP round-trip. It needs our own bundle entry (file + cacheKey) from
    // the first-party manifest.
    try {
      const response = await fetch('js/apps/novaapp-manifest.json', { cache: 'no-store' });
      if (response.ok) {
        const bundles = await response.json();
        const self = Array.isArray(bundles) && bundles.find(bundle => bundle?.id === APP_ID);
        if (self && typeof self.file === 'string' &&
            typeof window.AppLoaderOptimizer?.getPackage === 'function') {
          const pkg = await window.AppLoaderOptimizer.getPackage(self.file, self.cacheKey);
          if (pkg?.manifest?.id === APP_ID) return pkg;
        }
      }
    } catch (_) { /* fall back to the direct static fetch below */ }

    // Fallback: plain static fetch of the .novaapp (always shipped — the
    // production build stages system .novaapp bundles verbatim).
    const response = await fetch(APP_FILE, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Failed to fetch ${APP_ID}: HTTP ${response.status}`);
    const pkg = await response.json();
    if (pkg?.manifest?.id !== APP_ID) throw new Error('Unexpected package identity');
    return pkg;
  }

  function injectVendoredLibrary(code) {
    // Same injection mechanism SystemServiceLoader itself uses: a plain
    // <script> with textContent in the trusted host document. The i18next
    // UMD wrapper publishes window.i18next synchronously on execution.
    const script = document.createElement('script');
    script.dataset.novaVendored = 'i18next';
    script.textContent = code;
    document.head.appendChild(script);
    script.remove();
  }

  (async () => {
    const engine = window.NovaI18n;
    if (!engine || typeof engine.registerResources !== 'function') {
      // The core engine script failed to load — nothing this service can do.
      // Resolve nothing: boot() carries its own fail-soft timeout for the
      // resources gate, and _t() degrades to key echo. Surface it loudly.
      console.error(`[${APP_ID}] NovaI18n core engine is unavailable — localisation offline`);
      return;
    }

    try {
      const pkg = await loadOwnPackage();

      // Vendored i18next first — the engine needs the library instance to
      // construct the real translation pipeline.
      if (typeof window.i18next === 'undefined' && typeof pkg.files['vendor/i18next.min.js'] === 'string') {
        injectVendoredLibrary(decodePackageFile(pkg.files['vendor/i18next.min.js']));
      }
      const library = (typeof window.i18next !== 'undefined') ? window.i18next : null;
      if (library) engine.setLibrary(library);

      // Language catalogues. The engine's registry is the single source of
      // truth for which languages exist, so iterate that — never a copy.
      const bundles = {};
      for (const language of engine.getLanguages()) {
        const encoded = pkg.files[`locales/${language.code}.json`];
        if (typeof encoded !== 'string') continue;
        bundles[language.code] = JSON.parse(decodePackageFile(encoded));
      }
      const shipped = Object.keys(bundles).length;
      if (!bundles.en) throw new Error('the en fallback catalogue is missing from the package');

      engine.registerResources(bundles);
      console.info(`[${APP_ID}] Localisation online — ${shipped} language catalogues registered`);
    } catch (error) {
      console.error(`[${APP_ID}] Failed to bring localisation online:`, error);
      // Unblock the boot gate so the OS starts (in untranslated English)
      // instead of waiting on the timeout — a missing translator must never
      // brick the boot sequence.
      engine.registerResources({});
    }
  })();
})();
