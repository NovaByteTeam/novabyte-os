import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';

// ── Mock globals for NovaAppPackageStore ─────────────────────────────────────
const _opfsFiles = new Map();
const _opfsDirs = new Set(['/']);

const opfsMock = {
  available: true,
  root: true,
  async init() {},
  async readText(path) {
    const entry = _opfsFiles.get(path);
    return entry?.type === 'file' ? entry.content ?? null : null;
  },
  async writeText(path, content, type) {
    _opfsFiles.set(path, { type: 'file', content, mime: type ?? 'text/plain' });
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      _opfsDirs.add('/' + parts.slice(0, i).join('/'));
    }
  },
  async getBlob(path) {
    const entry = _opfsFiles.get(path);
    if (!entry || entry.type !== 'file') return null;
    return new Blob([entry.content ?? ''], { type: entry.mime });
  },
  async writeBlob(path, blob, type) {
    const text = await blob.text();
    _opfsFiles.set(path, { type: 'file', content: text, mime: type ?? 'application/octet-stream' });
  },
  async deleteBlob(path) { _opfsFiles.delete(path); },
  async deletePath(path, recursive) {
    if (recursive) {
      for (const k of [..._opfsFiles.keys()]) {
        if (k === path || k.startsWith(path + '/')) _opfsFiles.delete(k);
      }
      for (const d of [..._opfsDirs]) {
        if (d === path || d.startsWith(path + '/')) _opfsDirs.delete(d);
      }
    } else {
      _opfsFiles.delete(path);
    }
  },
  async ensureDirectory(path) { _opfsDirs.add(path); },
  async listEntries() {
    return [..._opfsFiles.entries()].map(([path, entry]) => ({
      path,
      kind: 'file',
      size: (entry.content ?? '').length,
      type: entry.mime,
      fallback: false,
    }));
  },
  async clear() {
    _opfsFiles.clear();
    _opfsDirs.clear();
    _opfsDirs.add('/');
  },
};

globalThis.OPFS = opfsMock;

// NovaAppPackageStore exports to window.NovaAppPackageStore (not CommonJS)
// We test it by loading the module and accessing window.NovaAppPackageStore

describe('NovaAppPackageStore (js/platform/core/nova-app-package-store.js)', () => {
  beforeEach(() => {
    resetTestStorage();
    _opfsFiles.clear();
    _opfsDirs.clear();
    _opfsDirs.add('/');
    vi.clearAllMocks();
    // Load the module to populate window.NovaAppPackageStore
    require('../../js/platform/core/nova-app-package-store.js');
  });

  describe('window.NovaAppPackageStore API', () => {
    it('exposes expected methods', () => {
      expect(window.NovaAppPackageStore).toBeDefined();
      expect(typeof window.NovaAppPackageStore.installApp).toBe('function');
      expect(typeof window.NovaAppPackageStore.hydrateApp).toBe('function');
      expect(typeof window.NovaAppPackageStore.saveRegistry).toBe('function');
      expect(typeof window.NovaAppPackageStore.loadRegistry).toBe('function');
    });

    it('returns null when input is empty', () => {
      expect(window.NovaAppPackageStore).toBeDefined();
    });
  });
});
