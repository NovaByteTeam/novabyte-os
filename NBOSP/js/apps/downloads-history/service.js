'use strict';

const DOWNLOADS_STORAGE_KEY = 'nova_downloads';
const DOWNLOADS_MAX_ENTRIES = 500;
const downloadListeners = new Set();

function loadDownloadHistory() {
  try {
    const raw = localStorage.getItem(DOWNLOADS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('[DownloadsHistory] Could not read download history:', error);
    return [];
  }
}

function saveDownloadHistory(items) {
  if (!Array.isArray(items)) throw new TypeError('Download history must be an array');
  const boundedItems = items.slice(0, DOWNLOADS_MAX_ENTRIES);
  if (typeof window.lsSave === 'function') {
    window.lsSave(DOWNLOADS_STORAGE_KEY, boundedItems);
  } else {
    localStorage.setItem(DOWNLOADS_STORAGE_KEY, JSON.stringify(boundedItems));
  }
  return boundedItems;
}

function notifyDownloadListeners(change) {
  const items = loadDownloadHistory();
  for (const listener of [...downloadListeners]) {
    try {
      listener(items, change);
    } catch (error) {
      console.error('[DownloadsHistory] Listener failed:', error);
    }
  }
}

function createDownloadId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('A secure random source is required to create download IDs');
}

const Downloads = Object.freeze({
  add(name, url, size, mimeType) {
    const entry = {
      id: createDownloadId(),
      name: name || 'Unknown file',
      url: url || '',
      size: size || 0,
      mimeType: mimeType || '',
      ts: Date.now(),
      status: 'done',
    };
    saveDownloadHistory([entry, ...loadDownloadHistory()]);
    notifyDownloadListeners('add');
    return entry;
  },

  setStatus(id, status, size) {
    const items = loadDownloadHistory();
    const entry = items.find(item => item.id === id);
    if (!entry) return false;
    entry.status = status;
    if (size != null) entry.size = size;
    saveDownloadHistory(items);
    notifyDownloadListeners('status');
    return true;
  },

  getAll() {
    return loadDownloadHistory();
  },

  remove(id) {
    const items = loadDownloadHistory();
    const nextItems = items.filter(item => item.id !== id);
    if (nextItems.length === items.length) return false;
    saveDownloadHistory(nextItems);
    notifyDownloadListeners('remove');
    return true;
  },

  clearCompleted() {
    const items = loadDownloadHistory();
    const nextItems = items.filter(item => item.status === 'downloading');
    if (nextItems.length === items.length) return false;
    saveDownloadHistory(nextItems);
    notifyDownloadListeners('clear-completed');
    return true;
  },

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Download history listener must be a function');
    downloadListeners.add(listener);
    return () => downloadListeners.delete(listener);
  },
});

window.Downloads = Downloads;

window.addEventListener('storage', event => {
  if (event.key === DOWNLOADS_STORAGE_KEY || event.key === null) {
    notifyDownloadListeners('storage');
  }
});
