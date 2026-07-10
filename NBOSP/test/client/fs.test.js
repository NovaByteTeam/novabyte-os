import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';

// ── Mock OPFS before FS loads ───────────────────────────────────────────────
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

vi.mock('../../js/platform/core/opfs.js', () => ({
  get OPFS() { return opfsMock; },
  default: opfsMock,
}));

const mockWorker = { call: vi.fn() };
vi.mock('../../js/core/services/workers.js', () => ({
  createWorker: vi.fn(() => mockWorker),
  get OS() { return { workers: { fs: mockWorker, crypto: mockWorker, search: mockWorker } }; },
}));

// ── FS exports to window.FS (not CommonJS) ─────────────────────────────────
require('../../js/core/services/fs.js');

describe('FS (js/core/services/fs.js)', () => {
  const FS = window.FS;

  beforeEach(() => {
    resetTestStorage();
    _opfsFiles.clear();
    _opfsDirs.clear();
    _opfsDirs.add('/');
    FS.files.clear();
    FS._childrenByParent.clear();
    FS.rootId = null;
    FS.specialFolders = {};
    FS._searchTimeout = null;
    mockWorker.call.mockClear();
    // Mock dependencies that FS uses
    globalThis.generateId = () => 'id-' + Math.random().toString(36).slice(2);
    globalThis.OS = {
      events: { emit: vi.fn() },
      workers: { fs: { call: vi.fn() }, crypto: { call: vi.fn() }, search: { call: vi.fn() } },
    };
  });

  describe('createDefaultFS', () => {
    it('creates the standard folder structure when no files exist', async () => {
      mockWorker.call.mockResolvedValue([]);
      await FS.createDefaultFS();
      expect(FS.rootId).not.toBeNull();
      expect(FS.specialFolders.desktop).toBeDefined();
      expect(FS.specialFolders.documents).toBeDefined();
      expect(FS.specialFolders.downloads).toBeDefined();
    });

    it('creates a screenshots folder inside pictures', async () => {
      mockWorker.call.mockResolvedValue([]);
      await FS.createDefaultFS();
      const picturesId = FS.specialFolders.pictures;
      const children = FS.listDir(picturesId);
      const screenshots = children.find((c) => c.name === 'Screenshots');
      expect(screenshots).toBeDefined();
      expect(screenshots.type).toBe('folder');
    });
  });

  describe('listDir', () => {
    it('returns an empty array for an empty folder', () => {
      const result = FS.listDir('nonexistent');
      expect(result).toEqual([]);
    });
  });

  describe('getPath', () => {
    it('returns "/" for the root node', () => {
      FS.rootId = 'root';
      FS.files.set('root', { id: 'root', name: '/', parentId: null });
      expect(FS.getPath('root')).toBe('/');
    });
  });

  describe('getByPath', () => {
    it('returns the root for "/"', () => {
      FS.rootId = 'root';
      FS.files.set('root', { id: 'root', name: '/', parentId: null });
      expect(FS.getByPath('/')).toEqual({ id: 'root', name: '/', parentId: null });
    });

    it('returns null for nonexistent paths', () => {
      FS.rootId = 'root';
      FS.files.set('root', { id: 'root', name: '/', parentId: null });
      expect(FS.getByPath('/nonexistent')).toBeNull();
    });
  });

  describe('createFile', () => {
    it('creates a file with correct properties', async () => {
      FS.rootId = 'root';
      FS.files.set('root', { id: 'root', name: '/', parentId: null });
      FS._childrenByParent.set('root', new Map());
      mockWorker.call.mockResolvedValue(undefined);

      const file = await FS.createFile('root', 'test.txt', 'hello', 'text/plain');
      expect(file.name).toBe('test.txt');
      expect(file.type).toBe('file');
      expect(file.content).toBe('hello');
      expect(file.parentId).toBe('root');
      expect(FS.files.has(file.id)).toBe(true);
    });
  });

  describe('createFolder', () => {
    it('creates a folder with correct properties', async () => {
      FS.rootId = 'root';
      FS.files.set('root', { id: 'root', name: '/', parentId: null });
      FS._childrenByParent.set('root', new Map());
      mockWorker.call.mockResolvedValue(undefined);

      const folder = await FS.createFolder('root', 'new-folder');
      expect(folder.name).toBe('new-folder');
      expect(folder.type).toBe('folder');
      expect(folder.parentId).toBe('root');
      expect(FS.files.has(folder.id)).toBe(true);
    });
  });

  describe('writeFile', () => {
    it('updates file content', async () => {
      const id = 'file1';
      FS.files.set(id, {
        id,
        name: 'test.txt',
        type: 'file',
        parentId: 'root',
        content: 'old',
        mimeType: 'text/plain',
        size: 3,
      });
      FS._childrenByParent.set('root', new Map([[id, FS.files.get(id)]]));
      mockWorker.call.mockResolvedValue(undefined);

      await FS.writeFile(id, 'new content');
      expect(FS.files.get(id).content).toBe('new content');
    });

    it('returns null for nonexistent file', async () => {
      const result = await FS.writeFile('nonexistent', 'content');
      expect(result).toBeNull();
    });
  });

  describe('rename', () => {
    it('renames a file', async () => {
      const id = 'file1';
      FS.files.set(id, { id, name: 'old.txt', type: 'file', parentId: 'root' });
      mockWorker.call.mockResolvedValue(undefined);

      const result = await FS.rename(id, 'new.txt');
      expect(result.name).toBe('new.txt');
      expect(FS.files.get(id).name).toBe('new.txt');
    });

    it('returns null for nonexistent file', async () => {
      const result = await FS.rename('nonexistent', 'new.txt');
      expect(result).toBeNull();
    });
  });

  describe('move', () => {
    it('moves a file to a new parent', async () => {
      const fileId = 'file1';
      const oldParent = 'oldParent';
      const newParent = 'newParent';
      FS.files.set(fileId, { id: fileId, name: 'test.txt', type: 'file', parentId: oldParent });
      FS._childrenByParent.set(oldParent, new Map([[fileId, FS.files.get(fileId)]]));
      FS._childrenByParent.set(newParent, new Map());
      mockWorker.call.mockResolvedValue(undefined);

      const result = await FS.move(fileId, newParent);
      expect(result).toBeDefined();
      expect(FS.files.get(fileId).parentId).toBe(newParent);
      // After move, the oldParent map may be deleted if empty, so check conditionally
      const oldParentMap = FS._childrenByParent.get(oldParent);
      if (oldParentMap) {
        expect(oldParentMap.has(fileId)).toBe(false);
      }
      expect(FS._childrenByParent.get(newParent)?.has(fileId)).toBe(true);
    });
  });

  describe('deleteToTrash', () => {
    it('moves file to trash folder', async () => {
      const fileId = 'file1';
      const trashId = 'trash';
      FS.specialFolders.trash = trashId;
      FS.files.set(fileId, { id: fileId, name: 'test.txt', type: 'file', parentId: 'root', _originalParent: null });
      FS._childrenByParent.set('root', new Map([[fileId, FS.files.get(fileId)]]));
      FS._childrenByParent.set(trashId, new Map());
      mockWorker.call.mockResolvedValue(undefined);

      await FS.deleteToTrash(fileId);
      expect(FS.files.get(fileId).parentId).toBe(trashId);
    });
  });

  describe('permanentDelete', () => {
    it('removes file from FS entirely', async () => {
      const fileId = 'file1';
      FS.files.set(fileId, { id: fileId, name: 'test.txt', type: 'file', parentId: 'root' });
      mockWorker.call.mockResolvedValue(undefined);

      await FS.permanentDelete(fileId);
      expect(FS.files.has(fileId)).toBe(false);
    });

    it('recursively deletes folder contents', async () => {
      const folderId = 'folder1';
      const childId = 'child1';
      FS.files.set(folderId, { id: folderId, name: 'folder', type: 'folder', parentId: 'root' });
      FS.files.set(childId, { id: childId, name: 'child.txt', type: 'file', parentId: folderId });
      FS._childrenByParent.set(folderId, new Map([[childId, FS.files.get(childId)]]));
      mockWorker.call.mockResolvedValue(undefined);

      await FS.permanentDelete(folderId);
      expect(FS.files.has(folderId)).toBe(false);
      expect(FS.files.has(childId)).toBe(false);
    });
  });

  describe('getMimeIcon', () => {
    it('returns "folder" for directories', () => {
      expect(FS.getMimeIcon('inode/directory', '')).toBe('folder');
    });

    it('returns "image" for image MIME types', () => {
      expect(FS.getMimeIcon('image/png', '')).toBe('image');
    });

    it('returns "file-text" for markdown files', () => {
      expect(FS.getMimeIcon('text/plain', 'readme.md')).toBe('file-text');
    });

    it('returns "file-text" for unknown types', () => {
      expect(FS.getMimeIcon('application/octet-stream', '')).toBe('file-text');
    });
  });
});
