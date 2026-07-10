import { describe, it, expect, beforeEach, vi } from 'vitest';

// AppPackage uses module.exports = AppPackage (CommonJS default export)
// We use require() and access the returned object directly.

describe('AppPackage (js/platform/core/app-package.js)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Mock AppRegistry for uninstallPackage
    globalThis.AppRegistry = {
      registerApp: vi.fn((config) => config),
      unregisterApp: vi.fn(() => false),
    };
    // Mock crypto.subtle for signPackage
    globalThis.crypto = {
      randomUUID: () => 'test-uuid',
      getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = (Math.random() * 256) | 0; return arr; },
      subtle: {
        importKey: vi.fn().mockResolvedValue({}),
        sign: vi.fn().mockResolvedValue(new Uint8Array(32).fill(0xAB)),
        verify: vi.fn().mockResolvedValue(true),
      },
    };
  });

  const validManifest = {
    id: 'com.test.app',
    name: 'Test App',
    version: '1.0.0',
    entry: 'index.html',
  };

  describe('validateManifest', () => {
    it('returns valid for a correct manifest', () => {
      const AppPackage = require('../../js/platform/core/app-package.js');
      const result = AppPackage.validateManifest(validManifest);
      expect(result.valid).toBe(true);
    });

    it('flags missing required fields', () => {
      const AppPackage = require('../../js/platform/core/app-package.js');
      const result = AppPackage.validateManifest({ id: 'com.test' });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('returns invalid for null manifest', () => {
      const AppPackage = require('../../js/platform/core/app-package.js');
      let threw = false;
      let result = null;
      try {
        result = AppPackage.validateManifest(null);
      } catch (e) {
        threw = true;
      }
      expect(threw || (result && result.valid === false)).toBe(true);
    });
  });

  describe('createPackage', () => {
    it('creates a package with manifest and files', async () => {
      const AppPackage = require('../../js/platform/core/app-package.js');
      const pkg = await AppPackage.createPackage(validManifest, {
        'index.html': '<h1>Hello</h1>',
        'app.js': 'console.log(1)',
      });
      expect(pkg.novabyte_app).toBe('1.0');
      expect(pkg.manifest.id).toBe('com.test.app');
      expect(Object.keys(pkg.files).length).toBe(2);
    });

    it('creates empty package with no files', async () => {
      const AppPackage = require('../../js/platform/core/app-package.js');
      const pkg = await AppPackage.createPackage(validManifest, {});
      expect(pkg).toBeDefined();
      expect(Object.keys(pkg.files).length).toBe(0);
    });
  });

  describe('signPackage / verifyPackage', () => {
    it('signs a package and returns a signature string', async () => {
      const AppPackage = require('../../js/platform/core/app-package.js');
      const pkg = await AppPackage.createPackage(validManifest, {});
      const sig = await AppPackage.signPackage(pkg, 'test-key');
      expect(typeof sig).toBe('string');
      expect(sig.length).toBeGreaterThan(0);
    });

    it('returns false for null package', async () => {
      const AppPackage = require('../../js/platform/core/app-package.js');
      let result = false;
      try {
        result = await AppPackage.verifyPackage(null, 'key');
      } catch {
        result = false;
      }
      expect(result).toBe(false);
    });
  });

  describe('extractPackage', () => {
    it('decodes base64 file contents', () => {
      const AppPackage = require('../../js/platform/core/app-package.js');
      const pkg = { files: { 'hello.txt': 'aGVsbG8gd29ybGQ=' } };
      const files = AppPackage.extractPackage(pkg);
      expect(files['hello.txt']).toBeInstanceOf(Uint8Array);
    });
  });

  describe('inspectPackage', () => {
    it('returns package metadata', () => {
      const AppPackage = require('../../js/platform/core/app-package.js');
      const pkg = {
        novabyte_app: '1.0',
        manifest: { id: 'com.test', name: 'Test' },
        files: { a: '1', b: '2' },
        signature: 'abcd',
        compiled_at: '2026-07-10T00:00:00Z',
      };
      const info = AppPackage.inspectPackage(pkg);
      expect(info.format).toBe('1.0');
      expect(info.fileCount).toBe(2);
    });
  });

  describe('uninstallPackage', () => {
    it('returns false when app does not exist', () => {
      const AppPackage = require('../../js/platform/core/app-package.js');
      globalThis.AppRegistry.unregisterApp.mockReturnValue(false);
      expect(AppPackage.uninstallPackage('nonexistent')).toBe(false);
    });
  });
});
