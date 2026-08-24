// Downloads — download history manager. Runs as a plain page script inside
// this app's own index.html; the OS drives the window shell, not this script.
// Data comes from the host via nova:downloads:* IPC, not localStorage —
// this app has no state of its own to keep durable across relaunch.
(() => {
  const createEl = (tag, props = {}) => {
    const el = document.createElement(tag);
    if (props.className) el.className = props.className;
    if (props.textContent != null) el.textContent = props.textContent;
    if (props.style != null) el.style.cssText = props.style;
    if (props.title != null) el.title = props.title;
    return el;
  };

  // 'x' is real inline SVG on this OS (UI_ICONS). 'file' and 'archive' are
  // PNG-backed (icons8-document-94.png / icons8-archive-94.png). These are
  // embedded here as data: URLs rather than relative src paths: they're
  // built into the DOM at runtime via innerHTML (buildRow/buildEmpty), which
  // happens after the sandbox's one-time static-HTML rewrite pass already
  // ran — a relative path added post-load has nothing left to rewrite it,
  // and resolves against the sandboxed srcdoc's opaque origin, where it can
  // never load. Inlining the bytes at the source removes that dependency
  // entirely instead of relying on a rewrite step that can't see this DOM.
  const svgIcon = (name, size = 18) => {
    const s = Number.isFinite(size) ? size : 18;
    if (name === 'x') {
      return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    }
    const PACKAGED = {
      file: 'data:image/png;base64,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',
      archive: 'data:image/png;base64,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',
    };
    const dataUrl = PACKAGED[name] || PACKAGED.file;
    return `<img src="${dataUrl}" width="${s}" height="${s}" style="display:inline-block;vertical-align:middle;object-fit:contain;pointer-events:none;" draggable="false" alt="" aria-hidden="true">`;
  };

  async function main() {
    const content = document.getElementById('app');
    if (!content) return;

    if (!window.nova?.ipc) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.downloads</b><br>NovaByte runtime bridge unavailable.<br>This app requires NovaByte OS.</div>';
      return;
    }

    if (!document.getElementById('nbosp-dl-style')) {
      const s = document.createElement('style');
      s.id = 'nbosp-dl-style';
      s.textContent = '.dl-row:hover{background:var(--bg-hover)}.dl-delbtn{color:var(--text-muted);transition:color .1s}.dl-row:hover .dl-delbtn{color:var(--text-danger)}';
      document.head.appendChild(s);
    }

    // ── Host-backed data access ───────────────────────────────────────────────
    let cachedHistory = [];
    async function load() {
      try {
        const result = await window.nova.ipc('nova:downloads:list', {});
        const items = Array.isArray(result?.items) ? result.items : [];
        cachedHistory = items;
        return items;
      } catch {
        return cachedHistory;
      }
    }

    async function removeAtIndex(idx) {
      try {
        const result = await window.nova.ipc('nova:downloads:remove', { index: idx });
        cachedHistory = Array.isArray(result?.items) ? result.items : cachedHistory;
        return true;
      } catch {
        return false;
      }
    }

    async function clearCompleted() {
      try {
        const result = await window.nova.ipc('nova:downloads:clear-completed', {});
        cachedHistory = Array.isArray(result?.items) ? result.items : cachedHistory;
        return true;
      } catch {
        return false;
      }
    }

    // ── Formatters ─────────────────────────────────────────────────────────────
    const fmtSize = (b) => {
      if (typeof b !== 'number' || b < 0) return '—';
      if (b < 1_024) return `${b} B`;
      if (b < 1_048_576) return `${(b / 1_024).toFixed(1)} KB`;
      return `${(b / 1_048_576).toFixed(1)} MB`;
    };

    let _dtfCache = null;
    let _dtfCacheKey = null;
    const getFmtDate = () => {
      const locale = navigator.language;
      const cacheKey = locale;
      if (_dtfCacheKey === cacheKey && _dtfCache) return _dtfCache;
      try {
        _dtfCache = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      } catch {
        _dtfCache = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      }
      _dtfCacheKey = cacheKey;
      return _dtfCache;
    };
    const fmtDate = (ts) => {
      if (!ts) return '';
      try { return getFmtDate().format(new Date(+ts)); } catch { return ''; }
    };

    const STATUS = Object.freeze({
      downloading: Object.freeze({ bg: 'rgba(88,166,255,0.14)', color: 'var(--accent)' }),
      failed: Object.freeze({ bg: 'rgba(248,81,73,0.14)', color: 'var(--text-danger)' }),
      done: Object.freeze({ bg: 'rgba(63,185,80,0.14)', color: 'var(--text-success)' }),
    });
    const statusStyle = (s) => STATUS[s] ?? STATUS.done;

    // ── Layout ─────────────────────────────────────────────────────────────────
    const root = createEl('div', { style: 'display:flex;flex-direction:column;height:100%;overflow:hidden;' });
    content.appendChild(root);

    const toolbar = createEl('div', {
      style: 'display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);',
    });
    toolbar.append(createEl('span', { textContent: 'Downloads', style: 'font-size:13px;font-weight:600;flex:1;' }));
    const clearBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Clear completed' });
    toolbar.appendChild(clearBtn);
    root.appendChild(toolbar);

    const list = createEl('div', { style: 'flex:1;overflow-y:auto;' });
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Downloads');
    root.appendChild(list);

    function buildRow(item, idx) {
      const row = createEl('div', {
        className: 'dl-row',
        style: 'display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border-subtle);transition:background 0.1s;',
      });
      row.setAttribute('role', 'listitem');
      if (item.url) row.title = String(item.url).slice(0, 2048);

      const ico = createEl('span', { style: 'color:var(--accent);flex-shrink:0;' });
      ico.innerHTML = svgIcon('file', 18);

      const nameEl = createEl('div', {
        style: 'font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
      });
      nameEl.textContent = item.name ?? '(unnamed)';

      const metaEl = createEl('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px;' });
      metaEl.textContent = item.ts ? `${fmtSize(item.size)}  ·  ${fmtDate(item.ts)}` : fmtSize(item.size);

      const info = createEl('div', { style: 'flex:1;min-width:0;' });
      info.append(nameEl, metaEl);

      const st = statusStyle(item.status);
      const badge = createEl('span', {
        style: `font-size:10px;padding:2px 8px;border-radius:20px;font-weight:600;flex-shrink:0;background:${st.bg};color:${st.color};`,
      });
      badge.textContent = item.status ?? 'done';

      const delBtn = createEl('button', {
        className: 'dl-delbtn',
        style: 'background:none;border:none;cursor:pointer;padding:4px;border-radius:4px;display:flex;align-items:center;',
        title: 'Remove',
      });
      delBtn.setAttribute('aria-label', `Remove ${String(item.name ?? 'download').slice(0, 200)}`);
      delBtn.dataset.del = String(idx);
      delBtn.innerHTML = svgIcon('x', 14);

      row.append(ico, info, badge, delBtn);
      return row;
    }

    function buildEmpty() {
      const wrap = createEl('div', {
        style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-muted);gap:8px;',
      });
      const ico = createEl('span');
      ico.innerHTML = svgIcon('archive', 34);
      const label = createEl('div', { style: 'font-size:13px;margin-top:10px;color:var(--text-secondary);' });
      label.textContent = 'No downloads yet';
      const sub = createEl('div', { style: 'font-size:11px;margin-top:4px;' });
      sub.textContent = 'Files saved from the browser appear here';
      wrap.append(ico, label, sub);
      return wrap;
    }

    list.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-del]');
      if (!btn) return;
      const idx = parseInt(btn.dataset.del, 10);
      if (!Number.isFinite(idx) || idx < 0) return;
      if (await removeAtIndex(idx)) await render();
    });

    async function render() {
      const items = await load();
      const frag = document.createDocumentFragment();
      if (items.length === 0) frag.appendChild(buildEmpty());
      else for (let i = 0; i < items.length; i++) frag.appendChild(buildRow(items[i], i));
      list.replaceChildren(frag);
    }

    clearBtn.addEventListener('click', async () => {
      if (await clearCompleted()) await render();
    });

    await render();
    const refreshTimer = setInterval(() => { void render(); }, 1000);
    window.addEventListener('beforeunload', () => clearInterval(refreshTimer), { once: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void main(), { once: true });
  } else {
    void main();
  }
})();
