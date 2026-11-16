import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.js'],
    coverage: {
      // Custom provider extending @vitest/coverage-v8: converts each V8
      // ScriptCoverage entry separately and lets istanbul merge() sum the
      // counts. The stock provider raw-merges same-URL entries first
      // (@bcoe mergeScriptCovs), which corrupts derived else-arc counts for
      // any file loaded more than once (requireFresh/cover-loader, one load
      // per worker) — zeros/negatives for arcs that ran, positives for arcs
      // that didn't. See tests/helpers/exact-v8-coverage-provider.mjs.
      provider: 'custom',
      customProviderModule: 'tests/helpers/exact-v8-coverage-provider.mjs',
      reporter: ['text', 'json', 'html'],
      // Measure EVERY non-os source file — untouched files show as 0%,
      // so the report is an honest account of real e2e coverage.
      all: true,
      include: [
        'client.js',
        'ui-init.js',
        'build.mjs',
        'build-apps.mjs',
        'vitest.config.js',
        'js/**/*.js',
        'scripts/**/*.js',
        'server/**/*.js',
        'security/**/*.js',
        'email/**/*.js',
      ],
      exclude: [
        // Vendored third-party bundles: syntax-checked by tests/syntax/
        // js-syntax.js like every other .js file, but excluded from coverage
        // measurement (they are upstream code, not NovaByte source).
        'js/purify.min.js',
        'js/apps/localisation/vendor/**',
        'coverage/**',
      ],
    },
  },
});
