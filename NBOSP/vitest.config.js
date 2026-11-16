import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
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
