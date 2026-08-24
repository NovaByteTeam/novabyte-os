// Gallery — image viewer. Recursively scans the VFS for images and renders
// a grid + lightbox. Runs as a plain page script inside this app's own
// index.html; the OS drives the window shell, not this script.
(() => {
  const IMG_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'tiff']);
  const SKIP_FOLDERS = new Set(['/System']);

  // Two icon names (refresh, image) are only available as bundled PNGs in
  // this package — see assets/. Everything else is inline SVG built here
  // directly, since there's no host-injected svgIcon() inside a packaged
  // app's own guest page.
  const ICONS = {
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    'chevron-left': '<polyline points="15 18 9 12 15 6"/>',
    'chevron-right': '<polyline points="9 18 15 12 9 6"/>',
  };
  function svgIcon(name, size) {
    const s = Number(size) || 16;
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }
  const PACKAGED_ICONS = {
    refresh: 'assets/icons8-refresh-94.png',
    image: 'assets/icons8-picture-94.png',
  };
  function packagedIcon(name, size) {
    const path = PACKAGED_ICONS[name];
    if (!path) return svgIcon(name, size);
    return `<img src="${path}" width="${size}" height="${size}" style="display:inline-block;vertical-align:middle;object-fit:contain;pointer-events:none;" draggable="false" alt="" aria-hidden="true">`;
  }

  function createEl(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) for (const [key, value] of Object.entries(attrs)) {
      if (value == null) continue;
      if (key === 'className' || key === 'class') el.className = value;
      else if (key === 'textContent') el.textContent = value;
      else if (key === 'innerHTML') el.innerHTML = value;
      else if (key === 'style') el.style.cssText = typeof value === 'object' ? Object.entries(value).map(([k, v]) => `${k}:${v}`).join(';') : String(value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (typeof value === 'boolean') { if (value) el.setAttribute(key, ''); }
      else el.setAttribute(key, value);
    }
    if (children != null) {
      const arr = Array.isArray(children) ? children : [children];
      for (const child of arr) if (child || child === 0) el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const extOf = name => {
    const i = (name || '').lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toLowerCase() : '';
  };
  const isImageNode = node => node?.type === 'file' && ((node.mimeType && node.mimeType.startsWith('image/')) || IMG_EXTS.has(extOf(node.name)));

  function main() {
    const content = document.getElementById('gallery-app');

    // ── Root ────────────────────────────────────────────────────────────────
    const root = createEl('div', { style: 'display:flex;flex-direction:column;height:100%;background:var(--bg-base);overflow:hidden;' });
    content.appendChild(root);

    // ── Toolbar ─────────────────────────────────────────────────────────────
    const toolbar = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);' });
    const titleEl = createEl('span', { textContent: 'Gallery', style: 'font-size:13px;font-weight:600;flex:1;color:var(--text-primary);' });
    const countEl = createEl('span', { style: 'font-size:11px;color:var(--text-muted);' });
    const refreshBtn = createEl('button', { className: 'browser-nav-btn', title: 'Refresh' });
    refreshBtn.innerHTML = packagedIcon('refresh', 15);
    toolbar.append(titleEl, countEl, refreshBtn);
    root.appendChild(toolbar);

    // ── Grid ────────────────────────────────────────────────────────────────
    const gridWrap = createEl('div', { style: 'flex:1;overflow-y:auto;padding:12px;' });
    const grid = createEl('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;' });
    gridWrap.appendChild(grid);
    root.appendChild(gridWrap);

    // ── Lightbox ────────────────────────────────────────────────────────────
    const lb = createEl('div', {
      style: 'display:none;position:absolute;inset:0;background:rgba(0,0,0,0.93);z-index:200;align-items:center;justify-content:center;flex-direction:column;',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Image viewer',
    });
    const lbImg = createEl('img', {
      style: 'max-width:88%;max-height:82%;object-fit:contain;border-radius:6px;box-shadow:0 8px 48px rgba(0,0,0,0.8);user-select:none;',
      draggable: 'false',
      alt: '',
    });
    const lbClose = createEl('button', {
      style: 'position:absolute;top:10px;right:14px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:#fff;border-radius:6px;width:30px;height:30px;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;',
      'aria-label': 'Close',
    });
    lbClose.innerHTML = svgIcon('x', 14);
    const lbPrev = createEl('button', {
      style: 'position:absolute;left:10px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:50%;width:38px;height:38px;cursor:pointer;display:flex;align-items:center;justify-content:center;',
      'aria-label': 'Previous image',
    });
    lbPrev.innerHTML = svgIcon('chevron-left', 18);
    const lbNext = createEl('button', {
      style: 'position:absolute;right:10px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:50%;width:38px;height:38px;cursor:pointer;display:flex;align-items:center;justify-content:center;',
      'aria-label': 'Next image',
    });
    lbNext.innerHTML = svgIcon('chevron-right', 18);
    const lbCaption = createEl('div', {
      style: 'position:absolute;bottom:12px;left:50%;transform:translateX(-50%);color:rgba(255,255,255,0.55);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:80%;text-align:center;',
      'aria-live': 'polite',
    });
    lb.append(lbImg, lbClose, lbPrev, lbNext, lbCaption);
    content.style.position = 'relative';
    content.appendChild(lb);

    // ── State ────────────────────────────────────────────────────────────────
    let images = [];
    let lbIdx = 0;
    const blobCache = new Map();  // path → object-URL
    const revokeQueue = new Set();

    function toBufferData(raw) {
      if (!raw) return null;
      if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return raw;
      if (typeof raw === 'string') {
        if (typeof Uint8Array.fromBase64 === 'function') {
          try { return Uint8Array.fromBase64(raw); } catch { /* not base64 */ }
        }
        try {
          const bin = atob(raw);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          return u8;
        } catch { /* not base64 */ }
        return new TextEncoder().encode(raw);
      }
      return null;
    }

    function getUrl(f) {
      const cached = blobCache.get(f.path);
      if (cached !== undefined) return cached;
      const data = toBufferData(f.data);
      if (!data) return null;
      try {
        const blob = new Blob([data], { type: f.mimeType || 'image/png' });
        const url = URL.createObjectURL(blob);
        blobCache.set(f.path, url);
        return url;
      } catch {
        return null;
      }
    }

    // ── Lightbox helpers ─────────────────────────────────────────────────────
    function setLbNavState() {
      const atStart = lbIdx <= 0;
      const atEnd = lbIdx >= images.length - 1;
      lbPrev.style.opacity = atStart ? '0.25' : '1';
      lbNext.style.opacity = atEnd ? '0.25' : '1';
      lbPrev.disabled = atStart;
      lbNext.disabled = atEnd;
      lbPrev.setAttribute('aria-disabled', String(atStart));
      lbNext.setAttribute('aria-disabled', String(atEnd));
    }

    function openLb(idx) {
      if (!images.length) return;
      lbIdx = Math.max(0, Math.min(idx, images.length - 1));
      const f = images[lbIdx];
      lbImg.alt = f.name;
      lbImg.src = getUrl(f) || '';
      lbCaption.textContent = f.name + '  (' + (lbIdx + 1) + ' / ' + images.length + ')';
      setLbNavState();
      lb.style.display = 'flex';
      lbClose.focus();
    }

    function closeLb() {
      lb.style.display = 'none';
      lbImg.src = '';
    }

    lbClose.addEventListener('click', closeLb);
    lb.addEventListener('click', e => { if (e.target === lb) closeLb(); });
    lbPrev.addEventListener('click', () => { if (lbIdx > 0) openLb(lbIdx - 1); });
    lbNext.addEventListener('click', () => { if (lbIdx < images.length - 1) openLb(lbIdx + 1); });

    const onKey = e => {
      if (lb.style.display === 'none') return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); if (lbIdx > 0) openLb(lbIdx - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); if (lbIdx < images.length - 1) openLb(lbIdx + 1); }
      if (e.key === 'Escape') closeLb();
    };
    content.addEventListener('keydown', onKey);

    // ── VFS scan ─────────────────────────────────────────────────────────────
    // Recursive walk from root via the real IPC channels. Requires
    // vfs:read (declared in manifest.json) plus, for full unrestricted
    // reach outside this app's own /data folder, the system-signed trust
    // grant tied to this package's signature.
    async function walk(path, out) {
      const normalized = path === '/' ? '/' : String(path).replace(/\/+$/, '');
      if (SKIP_FOLDERS.has(normalized)) return;
      let listed;
      try {
        listed = await window.nova.ipc('nova:vfs:list', { path: normalized });
      } catch (err) {
        console.warn('[Gallery] Could not list', normalized, err);
        return;
      }
      for (const item of (listed?.files || [])) {
        const childPath = normalized === '/' ? `/${item.name}` : `${normalized}/${item.name}`;
        if (item.type === 'folder') {
          if (!SKIP_FOLDERS.has(childPath)) await walk(childPath, out);
        } else if (isImageNode(item)) {
          try {
            const detail = await window.nova.ipc('nova:vfs:read', { path: childPath });
            if (detail?.success) {
              out.push({ ...item, ...detail, path: childPath });
            }
          } catch (err) {
            console.warn('[Gallery] Could not read', item.name, err);
          }
        }
      }
    }

    async function scan() {
      const found = [];
      try {
        await walk('/', found);
      } catch (err) {
        console.warn('[Gallery] VFS scan failed:', err);
      }
      found.sort((a, b) => (b.modified || 0) - (a.modified || 0));

      const nextPaths = new Set(found.map(f => f.path));
      for (const [path, url] of blobCache) {
        if (!nextPaths.has(path)) {
          revokeQueue.add(url);
          blobCache.delete(path);
        }
      }

      images = found;
      render();
    }

    // ── render ───────────────────────────────────────────────────────────────
    function render() {
      for (const url of revokeQueue) URL.revokeObjectURL(url);
      revokeQueue.clear();

      const frag = document.createDocumentFragment();

      countEl.textContent = images.length
        ? images.length + ' image' + (images.length > 1 ? 's' : '')
        : '';

      if (!images.length) {
        const empty = createEl('div', { style: 'grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:64px 24px;color:var(--text-muted);gap:8px;text-align:center;' });
        empty.innerHTML = packagedIcon('image', 38);
        const noImg = createEl('div', { style: 'font-size:13px;margin-top:10px;color:var(--text-secondary);' });
        noImg.textContent = 'No images found';
        const hint = createEl('div', { style: 'font-size:11px;margin-top:4px;' });
        hint.textContent = 'Save image files via Files to view them here';
        empty.append(noImg, hint);
        frag.appendChild(empty);
        grid.textContent = '';
        grid.appendChild(frag);
        return;
      }

      for (let idx = 0; idx < images.length; idx++) {
        const f = images[idx];
        const card = createEl('div', {
          style: 'border-radius:8px;overflow:hidden;cursor:pointer;background:var(--bg-elevated);border:1px solid var(--border-subtle);aspect-ratio:1;display:flex;align-items:center;justify-content:center;transition:transform 0.13s,border-color 0.13s;position:relative;',
          title: f.name,
          role: 'button',
          tabindex: '0',
          'aria-label': f.name,
        });

        const openThisCard = () => openLb(idx);
        card.addEventListener('click', openThisCard);
        card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openThisCard(); } });
        card.addEventListener('mouseenter', () => { card.style.transform = 'scale(1.04)'; card.style.borderColor = 'var(--accent)'; });
        card.addEventListener('mouseleave', () => { card.style.transform = ''; card.style.borderColor = ''; });

        const url = getUrl(f);
        if (url) {
          const img = createEl('img', {
            style: 'width:100%;height:100%;object-fit:cover;',
            alt: f.name,
            draggable: 'false',
            loading: 'lazy',
          });
          img.addEventListener('error', () => {
            img.remove();
            const icon = createEl('div', { style: 'color:var(--text-muted);' });
            icon.innerHTML = packagedIcon('image', 24);
            card.insertBefore(icon, card.firstChild);
          });
          img.src = url;
          card.appendChild(img);
        } else {
          const icon = createEl('div', { style: 'color:var(--text-muted);' });
          icon.innerHTML = packagedIcon('image', 24);
          card.appendChild(icon);
        }

        const label = createEl('div', {
          style: 'position:absolute;bottom:0;left:0;right:0;padding:4px 6px;background:linear-gradient(transparent,rgba(0,0,0,0.7));color:#fff;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
        });
        label.textContent = f.name;
        card.appendChild(label);
        frag.appendChild(card);
      }

      grid.textContent = '';
      grid.appendChild(frag);
    }

    refreshBtn.addEventListener('click', () => { void scan(); });

    // ── Initial scan ─────────────────────────────────────────────────────────
    render();
    void scan();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main, { once: true });
  } else {
    main();
  }
})();
