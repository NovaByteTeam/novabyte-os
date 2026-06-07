
const FS = {
        files: new Map(),
        rootId: null,
        specialFolders: {},

        async init() {
          try {
            const files = await OS.workers.fs.call('getAllFiles');
            if (files && files.length > 0) {
              for (const f of files) FS.files.set(f.id, f);
              FS.findSpecialFolders();
            } else {
              await FS.createDefaultFS();
            }
            FS.updateSearchIndex();
          } catch (e) {
            await FS.createDefaultFS();
          }
        },

        findSpecialFolders() {
          for (const [id, f] of FS.files) {
            if (f.parentId === null && f.type === 'folder') { FS.rootId = id; break; }
          }
          for (const [id, f] of FS.files) {
            if (f.parentId === FS.rootId) {
              const name = f.name.toLowerCase();
              if (name === 'desktop') FS.specialFolders.desktop = id;
              else if (name === 'documents') FS.specialFolders.documents = id;
              else if (name === 'downloads') FS.specialFolders.downloads = id;
              else if (name === 'music') FS.specialFolders.music = id;
              else if (name === 'pictures') FS.specialFolders.pictures = id;
              else if (name === 'videos') FS.specialFolders.videos = id;
              else if (name === 'trash') FS.specialFolders.trash = id;
            }
          }
        },

        async createDefaultFS() {
          const now = Date.now();
          const mkNode = (name, type, parentId, content, mime) => ({
            id: generateId(), name, type, parentId,
            content: content || null, blobKey: null,
            size: content ? new Blob([content]).size : 0,
            mimeType: mime || (type === 'folder' ? 'inode/directory' : 'text/plain'),
            created: now, modified: now, accessed: now,
            permissions: { read: true, write: true, execute: false },
            tags: [], sha256: null, icon: null
          });

          const root = mkNode('/', 'folder', null);
          FS.rootId = root.id;

          const desktop = mkNode('Desktop', 'folder', root.id);
          const documents = mkNode('Documents', 'folder', root.id);
          const downloads = mkNode('Downloads', 'folder', root.id);
          const music = mkNode('Music', 'folder', root.id);
          const pictures = mkNode('Pictures', 'folder', root.id);
          const videos = mkNode('Videos', 'folder', root.id);
          const trash = mkNode('Trash', 'folder', root.id);
          const screenshots = mkNode('Screenshots', 'folder', pictures.id);

          const allFiles = [root, desktop, documents, downloads, music, pictures, videos, trash, screenshots];

          for (const f of allFiles) FS.files.set(f.id, f);

          FS.specialFolders = {
            desktop: desktop.id, documents: documents.id, downloads: downloads.id,
            music: music.id, pictures: pictures.id, videos: videos.id, trash: trash.id
          };

          await OS.workers.fs.call('putFiles', allFiles);
        },

        listDir(folderId) {
          const children = [];
          for (const [, f] of FS.files) {
            if (f.parentId === folderId) children.push(f);
          }
          return children.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        },

        getPath(id) {
          const parts = [];
          let node = FS.files.get(id);
          while (node) {
            if (node.parentId === null) break;
            parts.unshift(node.name);
            node = FS.files.get(node.parentId);
          }
          return '/' + parts.join('/');
        },

        getByPath(path) {
          if (path === '/') return FS.files.get(FS.rootId);
          const parts = path.split('/').filter(Boolean);
          let current = FS.rootId;
          for (const part of parts) {
            const children = FS.listDir(current);
            const found = children.find(c => c.name === part);
            if (!found) return null;
            current = found.id;
          }
          return FS.files.get(current);
        },

        async createFile(parentId, name, content, mimeType) {
          const node = {
            id: generateId(), name, type: 'file', parentId,
            content: content || '', blobKey: null,
            size: content ? new Blob([content]).size : 0,
            mimeType: mimeType || 'text/plain',
            created: Date.now(), modified: Date.now(), accessed: Date.now(),
            permissions: { read: true, write: true, execute: false },
            tags: [], sha256: null, icon: null
          };
          FS.files.set(node.id, node);
          await OS.workers.fs.call('putFiles', [node]);
          FS.updateSearchIndex();
          OS.events.emit('fs:created', node);
          return node;
        },

        async createFolder(parentId, name) {
          const node = {
            id: generateId(), name, type: 'folder', parentId,
            content: null, blobKey: null, size: 0,
            mimeType: 'inode/directory',
            created: Date.now(), modified: Date.now(), accessed: Date.now(),
            permissions: { read: true, write: true, execute: true },
            tags: [], sha256: null, icon: null
          };
          FS.files.set(node.id, node);
          await OS.workers.fs.call('putFiles', [node]);
          OS.events.emit('fs:created', node);
          return node;
        },

        async writeFile(id, content) {
          const node = FS.files.get(id);
          if (!node) return null;
          node.content = content;
          node.size = new Blob([content]).size;
          node.modified = Date.now();
          try { node.sha256 = await OS.workers.crypto.call('sha256', content); } catch (e) { }
          FS.files.set(id, node);
          await OS.workers.fs.call('putFiles', [node]);
          FS.updateSearchIndex();
          OS.events.emit('fs:updated', node);
          return node;
        },

        async rename(id, newName) {
          const node = FS.files.get(id);
          if (!node) return null;
          node.name = newName;
          node.modified = Date.now();
          FS.files.set(id, node);
          await OS.workers.fs.call('putFiles', [node]);
          OS.events.emit('fs:updated', node);
          return node;
        },

        async move(id, newParentId) {
          const node = FS.files.get(id);
          if (!node) return null;
          node.parentId = newParentId;
          node.modified = Date.now();
          FS.files.set(id, node);
          await OS.workers.fs.call('putFiles', [node]);
          OS.events.emit('fs:moved', node);
          return node;
        },

        async deleteToTrash(id) {
          const node = FS.files.get(id);
          if (!node) return;
          node._originalParent = node.parentId;
          node.parentId = FS.specialFolders.trash;
          node.modified = Date.now();
          FS.files.set(id, node);
          await OS.workers.fs.call('putFiles', [node]);
          OS.events.emit('fs:deleted', node);
        },

        async permanentDelete(id) {
          const node = FS.files.get(id);
          if (!node) return;
          if (node.type === 'folder') {
            const children = FS.listDir(id);
            for (const c of children) await FS.permanentDelete(c.id);
          }
          FS.files.delete(id);
          await OS.workers.fs.call('deleteFile', id);
          OS.events.emit('fs:deleted', { id });
        },

        async emptyTrash() {
          const trashItems = FS.listDir(FS.specialFolders.trash);
          for (const item of trashItems) await FS.permanentDelete(item.id);
        },

        updateSearchIndex() {
          // Trim content before serialising to worker — full content causes OOM on large vaults
          const MAX_CONTENT = 50_000;
          const files = Array.from(FS.files.values()).map(f => ({
            id: f.id,
            name: f.name || '',
            content: typeof f.content === 'string' ? f.content.slice(0, MAX_CONTENT) : ''
          }));
          OS.workers.search.call('buildIndex', files).catch(() => { });
        },

        async search(query) {
          try {
            const files = Array.from(FS.files.values());
            return await OS.workers.search.call('search', query, files);
          } catch (e) { return []; }
        },

        getMimeIcon(mimeType, name) {
          if (!mimeType) return 'file';
          if (mimeType === 'inode/directory') return 'folder';
          if (mimeType.startsWith('image/')) return 'image';
          if (mimeType.startsWith('audio/')) return 'music';
          if (mimeType.startsWith('video/')) return 'file';
          if (mimeType === 'application/pdf') return 'file-text';
          if (name && name.endsWith('.md')) return 'file-text';
          return 'file-text';
        }
      };


window.FS = FS;



/* Exposed to Global Scope for Flat-Module Architecture */
