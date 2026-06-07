registerApp({
        id: 'nbosp-gallery', name: 'Gallery', icon: 'image',
        description: 'Image Viewer',
        defaultSize: [840, 580], minSize: [500, 360],
        init(content, state) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.gallery', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.gallery</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const root = createEl('div', { style: 'display:flex;flex-direction:column;height:100%;background:var(--bg-base);overflow:hidden;' });
          content.appendChild(root);

          /* ── Toolbar ── */
          const toolbar = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);' });
          const titleEl = createEl('span', { textContent: 'Gallery', style: 'font-size:13px;font-weight:600;flex:1;color:var(--text-primary);' });
          const countEl = createEl('span', { style: 'font-size:11px;color:var(--text-muted);' });
          const refreshBtn = createEl('button', { className: 'browser-nav-btn', title: 'Refresh' });
          refreshBtn.innerHTML = svgIcon('refresh', 15);
          toolbar.append(titleEl, countEl, refreshBtn);
          root.appendChild(toolbar);

          /* ── Grid ── */
          const gridWrap = createEl('div', { style: 'flex:1;overflow-y:auto;padding:12px;' });
          const grid = createEl('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;' });
          gridWrap.appendChild(grid);
          root.appendChild(gridWrap);

          /* ── Lightbox (positioned inside content so it's window-scoped) ── */
          const lb = createEl('div', { style: 'display:none;position:absolute;inset:0;background:rgba(0,0,0,0.93);z-index:200;align-items:center;justify-content:center;flex-direction:column;' });
          const lbImg = createEl('img', { style: 'max-width:88%;max-height:82%;object-fit:contain;border-radius:6px;box-shadow:0 8px 48px rgba(0,0,0,0.8);user-select:none;', draggable: 'false', alt: '' });
          const lbClose = createEl('button', { style: 'position:absolute;top:10px;right:14px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:#fff;border-radius:6px;width:30px;height:30px;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;' });
          lbClose.innerHTML = svgIcon('x', 14);
          const lbPrev = createEl('button', { style: 'position:absolute;left:10px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:50%;width:38px;height:38px;cursor:pointer;display:flex;align-items:center;justify-content:center;' });
          lbPrev.innerHTML = svgIcon('chevron-left', 18);
          const lbNext = createEl('button', { style: 'position:absolute;right:10px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:50%;width:38px;height:38px;cursor:pointer;display:flex;align-items:center;justify-content:center;' });
          lbNext.innerHTML = svgIcon('chevron-right', 18);
          const lbCaption = createEl('div', { style: 'position:absolute;bottom:12px;left:50%;transform:translateX(-50%);color:rgba(255,255,255,0.55);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:80%;text-align:center;' });
          lb.append(lbImg, lbClose, lbPrev, lbNext, lbCaption);
          content.style.position = 'relative';
          content.appendChild(lb);

          let images = [];
          let lbIdx = 0;
          const blobCache = new Map();

          // Normalise whatever FS gives us into something Blob() can handle.
          // After IndexedDB round-trips, Uint8Array often comes back as a plain
          // object { "0": 255, "1": 216, … } — we rebuild it here.
          function toBufferData(raw) {
            if (!raw) return null;
            if (raw instanceof ArrayBuffer) return raw;
            if (ArrayBuffer.isView(raw)) return raw;
            if (typeof raw === 'string') {
              try {
                const bin = atob(raw);
                const u8 = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
                return u8;
              } catch {
                return new TextEncoder().encode(raw);
              }
            }
            if (typeof raw === 'object') {
              const len = Object.keys(raw).length;
              const u8 = new Uint8Array(len);
              for (let i = 0; i < len; i++) u8[i] = raw[i] ?? 0;
              return u8;
            }
            return null;
          }

          function getUrl(f) {
            if (blobCache.has(f.id)) return blobCache.get(f.id);
            const data = toBufferData(f.content);
            if (data) {
              try {
                const blob = new Blob([data], { type: f.mimeType || 'image/png' });
                const url = URL.createObjectURL(blob);
                blobCache.set(f.id, url);
                return url;
              } catch { return null; }
            }
            return null;
          }

          function openLb(idx) {
            lbIdx = Math.max(0, Math.min(idx, images.length - 1));
            const f = images[lbIdx];
            lbImg.src = getUrl(f) || '';
            lbCaption.textContent = f.name + '  (' + (lbIdx + 1) + ' / ' + images.length + ')';
            lbPrev.style.opacity = lbIdx > 0 ? '1' : '0.25';
            lbNext.style.opacity = lbIdx < images.length - 1 ? '1' : '0.25';
            lb.style.display = 'flex';
          }

          lbClose.addEventListener('click', () => { lb.style.display = 'none'; });
          lb.addEventListener('click', e => { if (e.target === lb) lb.style.display = 'none'; });
          lbPrev.addEventListener('click', () => { if (lbIdx > 0) openLb(lbIdx - 1); });
          lbNext.addEventListener('click', () => { if (lbIdx < images.length - 1) openLb(lbIdx + 1); });

          const onKey = e => {
            if (lb.style.display === 'none') return;
            if (e.key === 'ArrowLeft') { e.preventDefault(); if (lbIdx > 0) openLb(lbIdx - 1); }
            if (e.key === 'ArrowRight') { e.preventDefault(); if (lbIdx < images.length - 1) openLb(lbIdx + 1); }
            if (e.key === 'Escape') lb.style.display = 'none';
          };
          document.addEventListener('keydown', onKey);

          /* ── Render grid ── */
          function render() {
            const trashId = FS.specialFolders?.trash;
            const imgExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'tiff']);
            images = Array.from(FS.files.values())
              .filter(f => {
                if (f.type !== 'file' || f.parentId === trashId) return false;
                if (f.mimeType && f.mimeType.startsWith('image/')) return true;
                const ext = (f.name || '').split('.').pop().toLowerCase();
                return imgExts.has(ext);
              })
              .sort((a, b) => b.modified - a.modified);

            grid.innerHTML = '';
            countEl.textContent = images.length ? images.length + ' image' + (images.length > 1 ? 's' : '') : '';

            if (!images.length) {
              const empty = createEl('div', { style: 'grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:64px 24px;color:var(--text-muted);gap:8px;text-align:center;' });
              empty.innerHTML = svgIcon('image', 38) + '<div style="font-size:13px;margin-top:10px;color:var(--text-secondary);">No images found</div><div style="font-size:11px;margin-top:4px;">Save image files via Files to view them here</div>';
              grid.appendChild(empty);
              return;
            }

            images.forEach((f, idx) => {
              const card = createEl('div', { style: 'border-radius:8px;overflow:hidden;cursor:pointer;background:var(--bg-elevated);border:1px solid var(--border-subtle);aspect-ratio:1;display:flex;align-items:center;justify-content:center;transition:transform 0.13s,border-color 0.13s;position:relative;', title: f.name });
              card.addEventListener('mouseenter', () => { card.style.transform = 'scale(1.04)'; card.style.borderColor = 'var(--accent)'; });
              card.addEventListener('mouseleave', () => { card.style.transform = ''; card.style.borderColor = ''; });
              card.addEventListener('click', () => openLb(idx));

              const url = getUrl(f);
              if (url) {
                const img = createEl('img', { style: 'width:100%;height:100%;object-fit:cover;', alt: f.name, draggable: 'false' });
                img.src = url;
                img.addEventListener('error', () => { card.innerHTML = ''; card.innerHTML = svgIcon('image', 24); card.style.color = 'var(--text-muted)'; });
                card.appendChild(img);
              } else {
                card.innerHTML = svgIcon('image', 24);
                card.style.color = 'var(--text-muted)';
              }

              const label = createEl('div', { textContent: f.name, style: 'position:absolute;bottom:0;left:0;right:0;padding:4px 6px;background:linear-gradient(transparent,rgba(0,0,0,0.7));color:#fff;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' });
              card.appendChild(label);
              grid.appendChild(card);
            });
          }

          refreshBtn.addEventListener('click', render);
          state.cleanups = state.cleanups || [];
          state.cleanups.push(() => {
            document.removeEventListener('keydown', onKey);
            blobCache.forEach(u => URL.revokeObjectURL(u));
          });

          render();
          // If launched by double-clicking a specific image, jump straight to it
          if (state.fileId) {
            render();
            const startIdx = images.findIndex(f => f.id === state.fileId);
            if (startIdx !== -1) openLb(startIdx);
          }
        }
      });



      /* ── Global Downloads API — persists even when Downloads app is closed ── */
      (function () {
        const SK = 'nova_downloads';
        function _load() { try { return JSON.parse(localStorage.getItem(SK) || '[]'); } catch { return []; } }
        function _save(arr) { try { localStorage.setItem(SK, JSON.stringify(arr.slice(0, 500))); } catch { } }
        window.Downloads = {
          _renderFn: null,          // set by Downloads app init when its window is open
          add(name, url, size, mimeType) {
            const entry = {
              id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
              name: name || 'Unknown file', url: url || '',
              size: size || 0, mimeType: mimeType || '',
              ts: Date.now(), status: 'done'
            };
            const arr = _load(); arr.unshift(entry);
            _save(arr);
            if (window.Downloads._renderFn) window.Downloads._renderFn();
            return entry;
          },
          setStatus(id, status, size) {
            const arr = _load();
            const it = arr.find(x => x.id === id);
            if (it) { it.status = status; if (size != null) it.size = size; _save(arr); }
            if (window.Downloads._renderFn) window.Downloads._renderFn();
          },
          getAll() { return _load(); }
        };
      })();


