/**
 * NovaByte Bridge - Service Worker
 * Service worker for caching, offline support, and push notifications
 */

// Service Worker Version
const CACHE_VERSION = 'novabyte-v1';
const CACHE_NAME = `${CACHE_VERSION}-cache`;

// Static assets to cache immediately
const STATIC_ASSETS = [
    // Pre-cache essential assets that exist within the SW scope
    // Note: SW scope is /js/ by default; adjust registration for broader scope
    '/js/sw.js'
];

// Dynamic API cache configuration
const API_CACHE_CONFIG = {
    maxAge: 5 * 60 * 1000, // 5 minutes
    maxEntries: 50
};

// Offline queue storage
const OFFLINE_QUEUE_KEY = 'novamail_offline_queue';
const SYNC_QUEUE_KEY = 'novamail_sync_queue';

/**
 * Install event - cache static assets
 */
self.addEventListener('install', (event) => {
    console.log('[ServiceWorker] Installing...');
    
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[ServiceWorker] Caching static assets');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => {
                console.log('[ServiceWorker] Installed successfully');
                return self.skipWaiting();
            })
            .catch((error) => {
                console.error('[ServiceWorker] Install failed:', error);
            })
    );
});

/**
 * Activate event - clean up old caches
 */
self.addEventListener('activate', (event) => {
    console.log('[ServiceWorker] Activating...');
    
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames
                        .filter((name) => name.startsWith(CACHE_VERSION) && name !== CACHE_NAME)
                        .map((name) => {
                            console.log('[ServiceWorker] Deleting old cache:', name);
                            return caches.delete(name);
                        })
                );
            })
            .then(() => {
                console.log('[ServiceWorker] Activated successfully');
                return self.clients.claim();
            })
    );
});

/**
 * Fetch event - serve from cache or network
 */
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip non-GET requests
    if (request.method !== 'GET') {
        return;
    }

    // Handle API requests
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(handleApiRequest(request));
        return;
    }

    // Handle static assets
    event.respondWith(handleStaticRequest(request));
});

/**
 * Handle API requests with network-first strategy
 */
async function handleApiRequest(request) {
    try {
        // Try network first
        const response = await fetch(request);
        
        // Cache successful responses
        if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
        }
        
        return response;
    } catch (error) {
        // Try cache on network failure
        const cachedResponse = await caches.match(request);
        
        if (cachedResponse) {
            return cachedResponse;
        }
        
        // Return offline response for API calls
        return new Response(
            JSON.stringify({ error: 'Offline', cached: false }),
            {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

/**
 * Handle static requests with cache-first strategy
 */
async function handleStaticRequest(request) {
    const cachedResponse = await caches.match(request);
    
    if (cachedResponse) {
        // Update cache in background
        updateCache(request);
        return cachedResponse;
    }
    
    try {
        const response = await fetch(request);
        
        if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
        }
        
        return response;
    } catch (error) {
        // Return offline page for navigation requests
        if (request.mode === 'navigate') {
            return caches.match('/offline.html') || new Response('Offline', { status: 503 });
        }
        throw error;
    }
}

/**
 * Update cache in background
 */
async function updateCache(request) {
    try {
        const response = await fetch(request);
        
        if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, response);
        }
    } catch (error) {
        // Silent fail for background updates
    }
}

/**
 * Background Sync for offline email queue
 */
self.addEventListener('sync', (event) => {
    console.log('[ServiceWorker] Background sync:', event.tag);
    
    if (event.tag === 'sync-emails') {
        event.waitUntil(syncOfflineEmails());
    } else if (event.tag.startsWith('sync-account-')) {
        const accountId = event.tag.replace('sync-account-', '');
        event.waitUntil(syncAccount(accountId));
    }
});

/**
 * Sync offline queued emails
 */
async function syncOfflineEmails() {
    try {
        const queue = await getOfflineQueue();
        
        if (queue.length === 0) {
            console.log('[ServiceWorker] No emails to sync');
            return;
        }

        console.log('[ServiceWorker] Syncing', queue.length, 'emails');

        // Get auth token from storage
        const auth = await getAuthData();
        
        if (!auth?.token) {
            console.log('[ServiceWorker] No auth, queueing for later');
            return;
        }

        const results = [];
        
        for (const item of queue) {
            try {
                const response = await fetch(`/api/mail/accounts/${item.accountId}/send`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${auth.token}`
                    },
                    body: JSON.stringify(item.emailData)
                });

                if (response.ok) {
                    results.push({ id: item.id, success: true });
                    
                    // Notify clients
                    notifyClients({
                        type: 'email_sent',
                        accountId: item.accountId,
                        queueItem: item
                    });
                } else {
                    results.push({ id: item.id, success: false, error: 'Server error' });
                }
            } catch (error) {
                results.push({ id: item.id, success: false, error: error.message });
            }
        }

        // Remove successfully sent emails from queue
        const successIds = results.filter(r => r.success).map(r => r.id);
        await removeFromQueue(successIds);

        console.log('[ServiceWorker] Sync complete:', results);
    } catch (error) {
        console.error('[ServiceWorker] Sync failed:', error);
    }
}

/**
 * Sync specific account
 */
async function syncAccount(accountId) {
    try {
        const auth = await getAuthData();
        
        if (!auth?.token) {
            console.log('[ServiceWorker] No auth for account sync');
            return;
        }

        // Request sync via WebSocket or API
        // This is typically handled by the main app
        notifyClients({
            type: 'sync_requested',
            accountId
        });
        
        console.log('[ServiceWorker] Account sync requested:', accountId);
    } catch (error) {
        console.error('[ServiceWorker] Account sync failed:', error);
    }
}

/**
 * Get offline queue from storage
 */
async function getOfflineQueue() {
    return new Promise((resolve) => {
        const request = indexedDB.open('NovaMailDB', 1);
        
        request.onerror = () => resolve([]);
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('offlineQueue')) {
                db.createObjectStore('offlineQueue', { keyPath: 'id' });
            }
        };
        
        request.onsuccess = (event) => {
            const db = event.target.result;
            const transaction = db.transaction('offlineQueue', 'readonly');
            const store = transaction.objectStore('offlineQueue');
            const getAll = store.getAll();
            
            getAll.onsuccess = () => resolve(getAll.result || []);
            getAll.onerror = () => resolve([]);
        };
    });
}

/**
 * Add to offline queue
 */
async function addToQueue(item) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('NovaMailDB', 1);
        
        request.onerror = reject;
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('offlineQueue')) {
                db.createObjectStore('offlineQueue', { keyPath: 'id' });
            }
        };
        
        request.onsuccess = (event) => {
            const db = event.target.result;
            const transaction = db.transaction('offlineQueue', 'readwrite');
            const store = transaction.objectStore('offlineQueue');
            const addRequest = store.add(item);
            
            addRequest.onsuccess = () => resolve();
            addRequest.onerror = reject;
        };
    });
}

/**
 * Remove items from offline queue
 */
async function removeFromQueue(ids) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('NovaMailDB', 1);
        
        request.onerror = reject;
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('offlineQueue')) {
                db.createObjectStore('offlineQueue', { keyPath: 'id' });
            }
        };
        
        request.onsuccess = (event) => {
            const db = event.target.result;
            const transaction = db.transaction('offlineQueue', 'readwrite');
            const store = transaction.objectStore('offlineQueue');
            
            for (const id of ids) {
                store.delete(id);
            }
            
            transaction.oncomplete = resolve;
            transaction.onerror = reject;
        };
    });
}

/**
 * Get auth data from storage
 */
async function getAuthData() {
    return new Promise((resolve) => {
        chrome.storage?.local.get(['authToken', 'session'], (result) => {
            if (result.authToken) {
                resolve({ token: result.authToken });
            } else if (result.session) {
                try {
                    const session = JSON.parse(result.session);
                    resolve({ token: session.token });
                } catch {
                    resolve(null);
                }
            } else {
                resolve(null);
            }
        });
    });
}

/**
 * Notify all clients
 */
async function notifyClients(message) {
    const clients = await self.clients.matchAll();
    
    for (const client of clients) {
        client.postMessage(message);
    }
}

/**
 * Push notification event
 */
self.addEventListener('push', (event) => {
    console.log('[ServiceWorker] Push notification received');
    
    let data = {};
    
    try {
        if (event.data) {
            data = event.data.json();
        }
    } catch (error) {
        console.error('[ServiceWorker] Failed to parse push data:', error);
    }
    
    const title = data.title || 'NovaByte';
    const options = {
        body: data.body || 'You have new notifications',
        icon: data.icon || '/icon-192.png',
        badge: data.badge || '/badge-72.png',
        tag: data.tag || 'novabyte-notification',
        data: data.data || {},
        actions: data.actions || [],
        requireInteraction: data.requireInteraction || false
    };
    
    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

/**
 * Notification click event
 */
self.addEventListener('notificationclick', (event) => {
    console.log('[ServiceWorker] Notification clicked:', event.notification.tag);
    
    event.notification.close();
    
    const data = event.notification.data || {};
    
    // Handle different notification types
    if (data.type === 'new_email') {
        // Open email view
        event.waitUntil(
            self.clients.matchAll({ type: 'window' })
                .then((clients) => {
                    // Focus existing window if open
                    for (const client of clients) {
                        if (client.url.includes('mail')) {
                            client.focus();
                            client.postMessage({
                                type: 'open_email',
                                accountId: data.accountId,
                                messageId: data.messageId
                            });
                            return;
                        }
                    }
                    
                    // Open new window
                    return self.clients.openWindow('/?view=mail');
                })
        );
    } else if (data.action === 'compose') {
        // Open compose view
        event.waitUntil(
            self.clients.openWindow('/?view=compose')
        );
    } else {
        // Default: open app
        event.waitUntil(
            self.clients.openWindow('/')
        );
    }
});

/**
 * Message event - handle messages from main app
 */
self.addEventListener('message', (event) => {
    console.log('[ServiceWorker] Message received:', event.data);
    
    const { type, payload } = event.data || {};
    
    switch (type) {
        case 'skipWaiting':
            self.skipWaiting();
            break;
            
        case 'cacheUrls':
            cacheUrls(payload.urls);
            break;
            
        case 'clearCache':
            clearCache();
            break;
            
        case 'queueEmail':
            addToQueue(payload.item);
            break;
            
        case 'getQueue':
            getOfflineQueue().then(queue => {
                event.source.postMessage({ type: 'queue', data: queue });
            });
            break;
            
        default:
            console.log('[ServiceWorker] Unknown message type:', type);
    }
});

/**
 * Cache specific URLs
 */
async function cacheUrls(urls) {
    try {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(urls);
        console.log('[ServiceWorker] Cached URLs:', urls);
    } catch (error) {
        console.error('[ServiceWorker] Cache failed:', error);
    }
}

/**
 * Clear all caches
 */
async function clearCache() {
    try {
        const keys = await caches.keys();
        await Promise.all(keys.map(key => caches.delete(key)));
        console.log('[ServiceWorker] Cache cleared');
    } catch (error) {
        console.error('[ServiceWorker] Clear cache failed:', error);
    }
}

/**
 * Periodic background sync (if supported)
 */
self.addEventListener('periodicsync', (event) => {
    console.log('[ServiceWorker] Periodic sync:', event.tag);
    
    if (event.tag === 'sync-emails') {
        event.waitUntil(syncOfflineEmails());
    }
});

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {};
}
