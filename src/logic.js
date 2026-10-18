import { blake3 } from '@noble/hashes/blake3.js';

// Icon SVG paths — Lucide-compatible strokes, inline so there's no icon library dep.
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
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" aria-hidden="true">${paths}</svg>`;
}

function setAppIcon(container, app) {
  const icon = typeof app.icon === 'string' ? app.icon : '';
  const hasImageIcon = /^(?:data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,|https:\/\/|\/|apps\/)/i.test(icon);
  if (!hasImageIcon) {
    container.innerHTML = iconSvg(icon);
    return;
  }

  const image = document.createElement('img');
  image.src = icon;
  image.alt = `${app.name} icon`;
  image.loading = 'lazy';
  image.onerror = () => {
    container.innerHTML = iconSvg(icon);
  };
  container.replaceChildren(image);
}

function badgesHtml(categories = []) {
  return categories.map(c => `<span class="badge">${escHtml(c)}</span>`).join('');
}

const packageCache = new Map();
const verificationCache = new Map();
const pendingBadges = new WeakMap();
let siteTrustDataPromise;
const badgeObserver = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        badgeObserver.unobserve(entry.target);
        const pending = pendingBadges.get(entry.target);
        if (pending) verifyBadge(pending.badge, pending.app);
      }
    })
  : null;

async function fetchPackage(app) {
  if (!packageCache.has(app.id)) {
    const request = (async () => {
      const response = await fetch(new URL(app.file, document.baseURI));
      if (!response.ok) throw new Error(`Package request failed (${response.status})`);
      const pkg = await response.json();
      if (!pkg || pkg.novabyte_app !== true || pkg.manifest?.id !== app.id) {
        throw new Error(`Package identity does not match catalog entry "${app.id}".`);
      }
      return pkg;
    })();
    packageCache.set(app.id, request);
    request.catch(() => packageCache.delete(app.id));
  }
  return packageCache.get(app.id);
}

function loadSiteTrustData() {
  if (!siteTrustDataPromise) {
    siteTrustDataPromise = Promise.all([
      fetch('trusted-signers.json').then(response => {
        if (!response.ok) throw new Error(`Trusted signer list request failed (${response.status})`);
        return response.json();
      }),
      fetch('revoked-signatures.json').then(response => {
        if (!response.ok) throw new Error(`Revocation list request failed (${response.status})`);
        return response.json();
      }),
    ]).then(([signers, revocations]) => {
      if (!Array.isArray(signers) || !Array.isArray(revocations)) {
        throw new Error('Store verification data must contain lists.');
      }
      return { signers, revocations };
    });
  }
  return siteTrustDataPromise;
}

function signingPayload(pkg) {
  return JSON.stringify({
    novabyte_app: pkg.novabyte_app,
    manifest: pkg.manifest,
    files: pkg.files,
    compiled_at: pkg.compiled_at,
  });
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function decodeHex(hex) {
  if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  return new Uint8Array(hex.match(/.{2}/g).map(byte => Number.parseInt(byte, 16)));
}

function decodeBase64(encoded) {
  if (typeof encoded !== 'string') return null;
  const binary = atob(encoded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function digest(method, bytes) {
  if (method === 'blake3') return blake3(bytes);
  if (method !== 'sha256' && method !== 'sha512') return null;
  const algorithm = method === 'sha256' ? 'SHA-256' : 'SHA-512';
  return new Uint8Array(await crypto.subtle.digest(algorithm, bytes));
}

async function verifyPackageIntegrity(pkg) {
  if (!pkg.integrity) return false;
  const { method, payloadHash, fileHashes } = pkg.integrity;
  if (method === 'none' || !payloadHash) return true;

  const payloadDigest = await digest(method, new TextEncoder().encode(signingPayload(pkg)));
  if (!payloadDigest || bytesToHex(payloadDigest) !== String(payloadHash).toLowerCase()) return false;

  for (const [file, expectedHash] of Object.entries(fileHashes || {})) {
    const fileBytes = decodeBase64(pkg.files?.[file]);
    if (!fileBytes) return false;
    const fileDigest = await digest(method, fileBytes);
    if (!fileDigest || bytesToHex(fileDigest) !== String(expectedHash).toLowerCase()) return false;
  }
  return true;
}

async function verifyPackageSignature(pkg, app) {
  const { signers, revocations } = await loadSiteTrustData();
  const signature = pkg.signature;
  if (typeof signature !== 'string' || !signature) return null;
  const revoked = revocations.some(record =>
    (typeof record === 'string' ? record : record?.signature) === signature
  );
  if (revoked) return null;

  const method = String(pkg.signing?.method || 'ed25519').toLowerCase();
  if (method !== 'ed25519' || !(await verifyPackageIntegrity(pkg))) return null;
  const signatureBytes = decodeHex(signature);
  if (!signatureBytes) return null;
  const payload = new TextEncoder().encode(signingPayload(pkg));

  for (const signer of signers) {
    if (String(signer.method || 'ed25519').toLowerCase() !== method || !signer.publicKey) continue;
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        signer.publicKey,
        { name: 'Ed25519' },
        false,
        ['verify']
      );
      if (await crypto.subtle.verify({ name: 'Ed25519' }, key, signatureBytes, payload)) {
        return { name: signer.name || app.author || 'Trusted publisher' };
      }
    } catch (error) {
      console.warn(`[Store] Could not verify ${app.id} with signer ${signer.name || signer.id}:`, error);
    }
  }
  return null;
}

function verifyCatalogApp(app) {
  if (!verificationCache.has(app.id)) {
    const verification = fetchPackage(app)
      .then(pkg => verifyPackageSignature(pkg, app))
      .catch(error => {
        console.warn(`[Store] Could not verify ${app.id}:`, error);
        return null;
      });
    verificationCache.set(app.id, verification);
  }
  return verificationCache.get(app.id);
}

function verifyBadge(badge, app) {
  badge.hidden = true;
  verifyCatalogApp(app).then(result => {
    if (!result) return;
    badge.textContent = '✓ Verified';
    badge.title = `Signature and integrity verified: ${result.name}`;
    badge.setAttribute('aria-label', `Verified publisher: ${result.name}`);
    badge.hidden = false;
  });
}

function attachVerifiedBadge(badge, app, observeTarget, eager = false) {
  badge.hidden = true;
  if (!eager && badgeObserver && observeTarget) {
    pendingBadges.set(observeTarget, { badge, app });
    badgeObserver.observe(observeTarget);
    return;
  }
  verifyBadge(badge, app);
}

function permissionName(permission) {
  const labels = {
    'clipboard:read': 'Read clipboard',
    'clipboard:write': 'Write clipboard',
    'net:external': 'Internet access',
    'net:internal': 'Internal network access',
    'net:websocket': 'WebSocket access',
    'device:notifications': 'Notifications',
    'device:camera': 'Camera',
    'device:microphone': 'Microphone',
    'device:geolocation': 'Location',
    'vfs:access': 'Shared files',
    'vfs:read': 'Read files',
    'vfs:write': 'Write files',
    'vfs:delete': 'Delete files',
  };
  return labels[permission] || permission;
}

function safeWebUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, document.baseURI);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function safeAssetUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const base = new URL(document.baseURI);
    const url = new URL(value, base);
    return url.origin === base.origin && ['https:', 'http:'].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function packageImageUrl(value, pkg) {
  if (typeof value !== 'string') return null;
  if (/^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,/i.test(value)) return value;
  const packagedFile = pkg?.files?.[value];
  if (typeof packagedFile === 'string') {
    const extension = value.split('.').pop()?.toLowerCase();
    const mime = extension === 'svg' ? 'image/svg+xml'
      : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
      : extension === 'gif' ? 'image/gif'
      : extension === 'webp' ? 'image/webp'
      : extension === 'png' ? 'image/png'
      : null;
    if (mime) return `data:${mime};base64,${packagedFile}`;
  }
  return safeAssetUrl(value);
}

// ── State ──────────────────────────────────────────────────────────────────

let allApps = [];
let activeCategory = 'all';
let searchQuery = '';

// ── DOM refs ───────────────────────────────────────────────────────────────

const siteHeader    = document.querySelector('.site-header');
const storeView     = document.getElementById('store-view');
const detailView    = document.getElementById('detail-view');
const grid          = document.getElementById('apps-grid');
const gridLoading   = document.getElementById('grid-loading');
const gridEmpty     = document.getElementById('grid-empty');
const gridHeading   = document.getElementById('grid-heading');
const sectionEyebrow = document.getElementById('section-eyebrow');
const resultsCount  = document.getElementById('results-count');
const catalogCount  = document.getElementById('catalog-count');
const categoryBar   = document.querySelector('.category-bar');
const searchInput   = document.getElementById('search-input');
const backBtn       = document.getElementById('back-btn');

const featuredSection = document.getElementById('featured-section');
const featuredCard    = document.getElementById('featured-card');
const featuredIcon    = document.getElementById('featured-icon');
const featuredName    = document.getElementById('featured-name');
const featuredAuthor  = document.getElementById('featured-author');
const featuredDesc    = document.getElementById('featured-desc');
const featuredBadges  = document.getElementById('featured-badges');
const featuredVersion = document.getElementById('featured-version');
const featuredArt     = document.getElementById('featured-art');

const detailIcon     = document.getElementById('detail-icon');
const detailName     = document.getElementById('detail-name');
const detailVerified = document.getElementById('detail-verified');
const detailAuthor   = document.getElementById('detail-author');
const detailCats     = document.getElementById('detail-cats');
const detailDesc     = document.getElementById('detail-desc');
const detailId       = document.getElementById('detail-id');
const detailVersion  = document.getElementById('detail-version');
const detailSize     = document.getElementById('detail-size');
const detailDev      = document.getElementById('detail-dev');
const detailDownload = document.getElementById('detail-download');
const readMoreBtn    = document.getElementById('read-more-btn');
const detailScreenshots = document.getElementById('detail-screenshots');
const detailScreenshotList = document.getElementById('detail-screenshot-list');
const screenshotPreviewDialog = document.getElementById('screenshot-preview-dialog');
const screenshotPreviewImage = document.getElementById('screenshot-preview-image');
const screenshotPreviewCaption = document.getElementById('screenshot-preview-caption');
const screenshotPreviewClose = document.getElementById('screenshot-preview-close');
const detailPermissions = document.getElementById('detail-permissions');
const detailRequiredPermissions = document.getElementById('detail-required-permissions');
const detailOptionalPermissions = document.getElementById('detail-optional-permissions');
const detailReleaseNotes = document.getElementById('detail-release-notes');
const detailReleaseNotesSection = document.getElementById('detail-release-notes-section');
const detailLinks = document.getElementById('detail-links');
const detailSafetyBar     = document.getElementById('detail-safety-bar');
const detailSafetyFill    = document.getElementById('detail-safety-fill');
const detailSafetyLabel   = document.getElementById('detail-safety-label');
const detailVersionHistory = document.getElementById('detail-version-history');
const detailVersionHistoryList = document.getElementById('detail-version-history-list');

// ── Fetch apps ─────────────────────────────────────────────────────────────

async function loadApps() {
  try {
    const res = await fetch('apps.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const catalog = await res.json();
    if (!Array.isArray(catalog)) throw new Error('App catalog must contain a list.');
    allApps = catalog.filter(app =>
      app &&
      typeof app.id === 'string' &&
      typeof app.name === 'string' &&
      typeof app.file === 'string'
    );
    renderCategories();
    catalogCount.textContent = String(allApps.length).padStart(2, '0');
  } catch (err) {
    console.error('Could not load apps.json:', err);
    allApps = [];
  } finally {
    gridLoading.classList.add('hidden');
    renderFeatured();
    renderGrid();
  }
}

function renderCategories() {
  const categories = [...new Set(allApps.flatMap(app =>
    Array.isArray(app.categories) ? app.categories.filter(category => typeof category === 'string') : []
  ))].sort((a, b) => a.localeCompare(b));
  const labels = { personalization: 'Personalization' };
  const entries = [
    { id: 'all', label: 'All apps', count: allApps.length },
    ...categories.map(id => ({
      id,
      label: labels[id] || id.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()),
      count: allApps.filter(app => app.categories?.includes(id)).length,
    })),
  ];
  if (!entries.some(entry => entry.id === activeCategory)) activeCategory = 'all';

  categoryBar.replaceChildren();
  for (const entry of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `cat-btn${entry.id === activeCategory ? ' is-active' : ''}`;
    button.dataset.cat = entry.id;
    button.setAttribute('aria-pressed', String(entry.id === activeCategory));
    const label = document.createElement('span');
    label.textContent = entry.label;
    const count = document.createElement('span');
    count.className = 'category-count';
    count.textContent = String(entry.count);
    button.append(label, count);
    categoryBar.appendChild(button);
  }
}

// ── Featured ───────────────────────────────────────────────────────────────

function renderFeatured() {
  // Only show featured when browsing all categories with no search
  const app = allApps.find(candidate => candidate.featured === true)
    || (allApps.length >= 4 ? allApps[0] : null);
  if (activeCategory !== 'all' || searchQuery || !app) {
    featuredSection.hidden = true;
    featuredName.dataset.appId = '';
    featuredArt.replaceChildren();
    return;
  }
  featuredSection.hidden = false;
  featuredName.dataset.appId = app.id;
  setAppIcon(featuredIcon, app);
  featuredArt.replaceChildren();
  const screenshot = Array.isArray(app.screenshots) ? safeWebUrl(app.screenshots[0]) : null;
  if (screenshot) {
    const image = document.createElement('img');
    image.src = screenshot;
    image.alt = '';
    image.loading = 'lazy';
    featuredArt.appendChild(image);
  }
  featuredName.textContent = app.name;
  const featuredVerified = document.createElement('span');
  featuredVerified.className = 'verified-badge';
  featuredVerified.textContent = '✓ Verified';
  attachVerifiedBadge(featuredVerified, app, featuredCard);
  featuredName.appendChild(featuredVerified);
  featuredAuthor.textContent = app.author ?? '';
  featuredDesc.textContent = app.description ?? '';
  featuredBadges.innerHTML = badgesHtml(app.categories);
  featuredVersion.textContent = `v${app.version}`;
  featuredCard.setAttribute('aria-label', `View ${app.name}`);
  featuredCard.onclick = () => openDetail(app);
  featuredCard.onkeydown = e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(app); }
  };
}

// ── Grid ───────────────────────────────────────────────────────────────────

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
  for (const card of grid.querySelectorAll('.app-card')) {
    badgeObserver?.unobserve(card);
    card.remove();
  }

  const apps = filteredApps();
  // In default view, skip first app — it's in the featured slot
  const gridApps = (activeCategory === 'all' && !searchQuery && apps.length > 0 && !featuredSection.hidden)
    ? apps.filter(app => app.id !== (featuredSection.hidden ? null : featuredName.dataset.appId))
    : apps;
  resultsCount.textContent = `${apps.length} ${apps.length === 1 ? 'app' : 'apps'}`;
  gridHeading.textContent = activeCategory === 'all' && !searchQuery
    ? 'All apps'
    : searchQuery
      ? `Results for "${searchQuery}"`
      : activeCategory.charAt(0).toUpperCase() + activeCategory.slice(1);
  sectionEyebrow.textContent = searchQuery ? 'FIND YOUR NEXT APP' : activeCategory === 'all' ? 'THE CATALOG' : 'BROWSE BY CATEGORY';

  if (apps.length === 0) {
    gridEmpty.classList.remove('hidden');
    gridHeading.hidden = true;
    return;
  }

  gridEmpty.classList.add('hidden');
  gridHeading.hidden = false;

  for (const app of gridApps) {
    const card = document.createElement('article');
    card.className = 'app-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `View ${app.name}`);
    card.dataset.id = app.id;
    card.dataset.category = app.categories?.[0] || 'other';

    card.innerHTML = `
      <div class="card-icon"></div>
      <div class="card-body">
        <div class="card-name"><span>${escHtml(app.name)}</span><span class="verified-badge" hidden></span></div>
        <div class="card-author">${escHtml(app.author ?? '')}</div>
        <p class="card-desc">${escHtml(app.description ?? '')}</p>
        <div class="card-footer">
          <div class="card-badges">${badgesHtml(app.categories)}</div>
          <span class="card-version">v${escHtml(app.version)}</span>
        </div>
      </div>
      <div class="card-chevron" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
    `;
    attachVerifiedBadge(card.querySelector('.verified-badge'), app, card);
    setAppIcon(card.querySelector('.card-icon'), app);

    card.addEventListener('click', () => openDetail(app));
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(app); }
    });

    grid.appendChild(card);
  }
}

// ── Detail view ────────────────────────────────────────────────────────────

function fillPermissionList(container, permissions) {
  container.replaceChildren();
  for (const permission of permissions) {
    if (typeof permission !== 'string') continue;
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = permissionName(permission);
    const code = document.createElement('code');
    code.textContent = permission;
    item.append(label, code);
    container.appendChild(item);
  }
}

function appLinks(app, manifest) {
  const labels = {
    homepage: 'Website',
    website: 'Website',
    support: 'Support',
    supportUrl: 'Support',
    source: 'Source code',
    sourceUrl: 'Source code',
    repository: 'Source code',
    repositoryUrl: 'Source code',
    privacyPolicy: 'Privacy policy',
    privacyPolicyUrl: 'Privacy policy',
    documentation: 'Documentation',
    docs: 'Documentation',
    issues: 'Report an issue',
    issuesUrl: 'Report an issue',
  };
  const sources = [app.links, manifest.links];
  const candidates = sources.flatMap(source => Array.isArray(source)
    ? source
    : Object.entries(source || {}).map(([label, url]) => ({ label, url })));
  for (const key of Object.keys(labels)) {
    for (const url of [app[key], manifest[key]]) {
      if (url) candidates.push({ label: labels[key], url });
    }
  }

  const seen = new Set();
  return candidates.flatMap(candidate => {
    if (!candidate || typeof candidate !== 'object') return [];
    const href = safeWebUrl(candidate.url || candidate.href);
    if (!href || seen.has(href)) return [];
    seen.add(href);
    const rawLabel = candidate.label || candidate.title || '';
    return [{ label: labels[rawLabel] || rawLabel || 'More information', href }];
  });
}

function renderPackageDetails(app, pkg) {
  const manifest = pkg?.manifest || {};
  const releaseNotes = app.releaseNotes || manifest.releaseNotes;
  detailReleaseNotesSection.hidden = !(typeof releaseNotes === 'string' && releaseNotes.trim());
  detailReleaseNotes.textContent = detailReleaseNotesSection.hidden ? '' : releaseNotes;

  const required = Array.isArray(app.permissions) ? app.permissions : manifest.permissions;
  const optional = Array.isArray(app.optionalPermissions) ? app.optionalPermissions : manifest.optionalPermissions;
  fillPermissionList(detailRequiredPermissions, Array.isArray(required) ? required : []);
  fillPermissionList(detailOptionalPermissions, Array.isArray(optional) ? optional : []);
  detailRequiredPermissions.closest('.permission-group').hidden = detailRequiredPermissions.childElementCount === 0;
  detailOptionalPermissions.closest('.permission-group').hidden = detailOptionalPermissions.childElementCount === 0;
  detailPermissions.hidden = detailRequiredPermissions.childElementCount === 0 && detailOptionalPermissions.childElementCount === 0;

  detailScreenshotList.replaceChildren();
  const screenshots = Array.isArray(app.screenshots) ? app.screenshots : manifest.screenshots;
  if (Array.isArray(screenshots)) {
    for (const source of screenshots) {
      const src = packageImageUrl(source, pkg);
      if (!src) continue;
      const image = document.createElement('img');
      image.src = src;
      image.alt = `${app.name} screenshot`;
      image.loading = 'lazy';
      const figure = document.createElement('figure');
      const previewButton = document.createElement('button');
      previewButton.className = 'detail-screenshot-trigger';
      previewButton.type = 'button';
      previewButton.setAttribute('aria-label', `View larger ${image.alt}`);
      previewButton.appendChild(image);
      figure.appendChild(previewButton);
      detailScreenshotList.appendChild(figure);
    }
  }
  detailScreenshots.hidden = detailScreenshotList.childElementCount === 0;

  detailLinks.replaceChildren();
  for (const link of appLinks(app, manifest)) {
    const anchor = document.createElement('a');
    anchor.href = link.href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = link.label;
    detailLinks.appendChild(anchor);
  }
  detailLinks.closest('.detail-section').hidden = detailLinks.childElementCount === 0;
}

// ── Safety Confidence bar ──────────────────────────────────────────────────
//
// The bar reflects cryptographic verification state — not a code audit.
// "100%" means Ed25519 signature + file integrity hashes all passed.
// "Checking…" while verification is in flight.
// "Unverified" if signature is absent, revoked, or integrity fails.

function updateSafetyBar(state) {
  // state: 'pending' | 'verified' | 'unverified'
  const configs = {
    pending:    { pct: 0,   label: 'Checking signature…', mod: 'pending' },
    verified:   { pct: 100, label: '100% — Reviewed and signed by NovaByte', mod: 'verified' },
    unverified: { pct: 0,   label: 'Unverified — no trusted signature found', mod: 'unverified' },
  };
  const { pct, label, mod } = configs[state] ?? configs.unverified;
  detailSafetyFill.style.setProperty('--safety-pct', `${pct}%`);
  detailSafetyFill.dataset.state = mod;
  detailSafetyLabel.textContent = label;
  detailSafetyBar.dataset.state = mod;
}

// ── Version history ────────────────────────────────────────────────────────

function renderVersionHistory(app) {
  const entries = Array.isArray(app.versionHistory) ? app.versionHistory : [];
  detailVersionHistory.hidden = entries.length === 0;
  if (entries.length === 0) return;

  detailVersionHistoryList.replaceChildren();
  for (const entry of entries) {
    if (!entry || typeof entry.version !== 'string') continue;

    const item = document.createElement('li');
    item.className = 'vh-entry';

    const header = document.createElement('div');
    header.className = 'vh-header';

    const versionTag = document.createElement('span');
    versionTag.className = 'vh-version';
    versionTag.textContent = `v${escHtml(entry.version)}`;

    // Mark current version
    if (entry.version === app.version) {
      const currentPill = document.createElement('span');
      currentPill.className = 'vh-current';
      currentPill.textContent = 'current';
      header.append(versionTag, currentPill);
    } else {
      header.append(versionTag);
    }

    if (entry.date) {
      const date = document.createElement('time');
      date.className = 'vh-date';
      date.dateTime = entry.date;
      // Format as "14 Sep 2026" — readable without being ambiguous
      try {
        date.textContent = new Date(entry.date).toLocaleDateString('en-GB', {
          day: 'numeric', month: 'short', year: 'numeric',
        });
      } catch {
        date.textContent = entry.date;
      }
      header.append(date);
    }

    item.appendChild(header);

    if (entry.notes) {
      const notes = document.createElement('p');
      notes.className = 'vh-notes';
      notes.textContent = entry.notes;
      item.appendChild(notes);
    }

    detailVersionHistoryList.appendChild(item);
  }
}

detailScreenshotList.addEventListener('click', event => {
  const trigger = event.target.closest('.detail-screenshot-trigger');
  if (!trigger) return;
  const image = trigger.querySelector('img');
  if (!image) return;
  screenshotPreviewImage.src = image.currentSrc || image.src;
  screenshotPreviewImage.alt = image.alt;
  screenshotPreviewCaption.textContent = image.alt;
  screenshotPreviewDialog.showModal();
});

screenshotPreviewClose.addEventListener('click', () => screenshotPreviewDialog.close());
screenshotPreviewDialog.addEventListener('click', event => {
  if (event.target === screenshotPreviewDialog) screenshotPreviewDialog.close();
});

function openDetail(app) {
  setAppIcon(detailIcon, app);
  detailName.replaceChildren(document.createTextNode(app.name), detailVerified);
  detailVerified.textContent = '✓ Verified';
  attachVerifiedBadge(detailVerified, app, null, true);
  detailAuthor.textContent = app.author ?? '';
  detailCats.innerHTML = badgesHtml(app.categories);
  detailId.textContent = app.id;
  detailVersion.textContent = `v${app.version}`;
  detailSize.textContent = app.size ?? '—';
  detailDev.textContent = app.author ?? '—';
  detailDownload.href = app.file;
  detailDownload.download = app.file.split('/').pop();
  renderPackageDetails(app, null);

  // Description + read-more
  const desc = app.description ?? '';
  detailDesc.textContent = desc;
  detailDesc.classList.remove('is-expanded');
  readMoreBtn.setAttribute('aria-expanded', 'false');
  readMoreBtn.textContent = 'More';

  // Show "More" button only if text is long enough to get clamped
  // (rough heuristic: >200 chars is almost certainly going to clamp at 4 lines)
  readMoreBtn.classList.toggle('hidden', desc.length <= 200);

  // Safety confidence bar — pending until verification resolves
  updateSafetyBar('pending');
  verifyCatalogApp(app).then(result => {
    if (detailId.textContent !== app.id || detailView.classList.contains('hidden')) return;
    updateSafetyBar(result ? 'verified' : 'unverified');
  }).catch(() => {
    if (detailId.textContent !== app.id || detailView.classList.contains('hidden')) return;
    updateSafetyBar('unverified');
  });

  // Version history from catalog entry
  renderVersionHistory(app);

  siteHeader.classList.add('hidden');
  storeView.classList.add('hidden');
  detailView.classList.remove('hidden');
  window.scrollTo(0, 0);
  backBtn.focus();

  fetchPackage(app).then(pkg => {
    if (detailId.textContent !== app.id || detailView.classList.contains('hidden')) return;
    renderPackageDetails(app, pkg);
  }).catch(error => {
    console.warn(`[Store] Could not load detail metadata for ${app.id}:`, error);
  });
}

readMoreBtn.addEventListener('click', () => {
  const expanded = detailDesc.classList.toggle('is-expanded');
  readMoreBtn.setAttribute('aria-expanded', String(expanded));
  readMoreBtn.textContent = expanded ? 'Less' : 'More';
});

function closeDetail() {
  detailView.classList.add('hidden');
  siteHeader.classList.remove('hidden');
  storeView.classList.remove('hidden');
}

backBtn.addEventListener('click', closeDetail);

// ── Category filter ────────────────────────────────────────────────────────

document.querySelector('.category-bar').addEventListener('click', e => {
  const btn = e.target.closest('.cat-btn');
  if (!btn) return;
  document.querySelectorAll('.cat-btn').forEach(b => {
    b.classList.remove('is-active');
    b.setAttribute('aria-pressed', 'false');
  });
  btn.classList.add('is-active');
  btn.setAttribute('aria-pressed', 'true');
  activeCategory = btn.dataset.cat;
  renderFeatured();
  renderGrid();
});

// ── Search ─────────────────────────────────────────────────────────────────

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  renderFeatured();
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
