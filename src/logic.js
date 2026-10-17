// Icon SVG paths — Lucide-compatible strokes, inline so there's no icon library dep.
// Add more here as you add new app categories.
const ICONS = {
  'file-text': `<polyline points="14 2 14 8 20 8"/><path d="M20 8V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8z"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>`,
  'calculator': `<rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="16" y1="10" x2="16" y2="14"/><line x1="8" y1="10" x2="8" y2="10"/><line x1="12" y1="10" x2="12" y2="10"/><line x1="8" y1="14" x2="8" y2="14"/><line x1="12" y1="14" x2="12" y2="14"/><line x1="8" y1="18" x2="12" y2="18"/>`,
  'grid': `<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>`,
  'box': `<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>`,
  'terminal': `<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>`,
  'music': `<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>`,
  'image': `<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>`,
  'gamepad': `<line x1="6" y1="11" x2="10" y2="11"/><line x1="8" y1="9" x2="8" y2="13"/><line x1="15" y1="12" x2="15.01" y2="12"/><line x1="17" y1="10" x2="17.01" y2="10"/><path d="M5 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/>`,
  'settings': `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>`,
};

function iconSvg(name) {
  const paths = ICONS[name] ?? ICONS['box'];
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

// ── State ──────────────────────────────────────────────────────────────────

let allApps = [];
let activeCategory = 'all';
let searchQuery = '';

// ── DOM refs ───────────────────────────────────────────────────────────────

const grid       = document.getElementById('apps-grid');
const gridLoading = document.getElementById('grid-loading');
const gridEmpty  = document.getElementById('grid-empty');
const searchInput = document.getElementById('search-input');

const backdrop   = document.getElementById('modal-backdrop');
const modalClose = document.getElementById('modal-close');
const modalIcon  = document.getElementById('modal-icon');
const modalName  = document.getElementById('modal-name');
const modalAuthor = document.getElementById('modal-author');
const modalBadges = document.getElementById('modal-badges');
const modalDesc  = document.getElementById('modal-desc');
const modalId    = document.getElementById('modal-id');
const modalVersion = document.getElementById('modal-version');
const modalSize  = document.getElementById('modal-size');
const modalDownload = document.getElementById('modal-download');

// ── Fetch apps ─────────────────────────────────────────────────────────────

async function loadApps() {
  try {
    const res = await fetch('apps.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allApps = await res.json();
  } catch (err) {
    console.error('Could not load apps.json:', err);
    allApps = [];
  } finally {
    gridLoading.classList.add('hidden');
    renderGrid();
  }
}

// ── Render ─────────────────────────────────────────────────────────────────

function filteredApps() {
  const q = searchQuery.trim().toLowerCase();
  return allApps.filter(app => {
    const matchesCat = activeCategory === 'all' || app.categories?.includes(activeCategory);
    const matchesSearch = !q
      || app.name.toLowerCase().includes(q)
      || app.description?.toLowerCase().includes(q)
      || app.id.toLowerCase().includes(q)
      || app.author?.toLowerCase().includes(q);
    return matchesCat && matchesSearch;
  });
}

function renderGrid() {
  // Remove any existing cards
  for (const card of grid.querySelectorAll('.app-card')) card.remove();

  const apps = filteredApps();

  if (apps.length === 0) {
    gridEmpty.classList.remove('hidden');
    return;
  }

  gridEmpty.classList.add('hidden');

  for (const app of apps) {
    const card = document.createElement('article');
    card.className = 'app-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `View ${app.name}`);
    card.dataset.id = app.id;

    const badges = (app.categories ?? []).map(c =>
      `<span class="badge">${c}</span>`
    ).join('');

    card.innerHTML = `
      <div class="card-top">
        <div class="card-icon">${iconSvg(app.icon)}</div>
        <div class="card-header">
          <div class="card-name">${escHtml(app.name)}</div>
          <div class="card-author">${escHtml(app.author ?? '')}</div>
        </div>
      </div>
      <p class="card-desc">${escHtml(app.description ?? '')}</p>
      <div class="card-footer">
        <div class="card-badges">${badges}</div>
        <span class="card-version">v${escHtml(app.version)}</span>
      </div>
    `;

    card.addEventListener('click', () => openModal(app));
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModal(app); }
    });

    grid.appendChild(card);
  }
}

// ── Modal ──────────────────────────────────────────────────────────────────

function openModal(app) {
  modalIcon.innerHTML = iconSvg(app.icon);
  modalName.textContent = app.name;
  modalAuthor.textContent = app.author ?? '';
  modalDesc.textContent = app.description ?? '';
  modalId.textContent = app.id;
  modalVersion.textContent = `v${app.version}`;
  modalSize.textContent = app.size ?? '—';

  modalBadges.innerHTML = (app.categories ?? []).map(c =>
    `<span class="badge">${escHtml(c)}</span>`
  ).join('');

  modalDownload.href = app.file;
  modalDownload.download = app.file.split('/').pop();

  backdrop.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  modalClose.focus();
}

function closeModal() {
  backdrop.classList.add('hidden');
  document.body.style.overflow = '';
}

modalClose.addEventListener('click', closeModal);
backdrop.addEventListener('click', e => {
  if (e.target === backdrop) closeModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !backdrop.classList.contains('hidden')) closeModal();
});

// ── Category filter ────────────────────────────────────────────────────────

document.querySelector('.category-bar').addEventListener('click', e => {
  const btn = e.target.closest('.cat-btn');
  if (!btn) return;
  document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  activeCategory = btn.dataset.cat;
  renderGrid();
});

// ── Search ─────────────────────────────────────────────────────────────────

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  renderGrid();
});

// ── Util ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Boot ───────────────────────────────────────────────────────────────────

loadApps();
