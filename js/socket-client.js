/**
 * NovaByte Bridge - WebSocket Client
 * Socket.io client for real-time email notifications
 */

// Connection states
const ConnectionState = {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    RECONNECTING: 'reconnecting',
    ERROR: 'error'
};

// Event names
const SocketEvents = {
    NEW_EMAIL: 'new_email',
    SYNC_COMPLETE: 'sync_complete',
    SYNC_ERROR: 'sync_error',
    CONNECTION_STATUS: 'connection_status',
    ACCOUNT_ADDED: 'account_added',
    ACCOUNT_REMOVED: 'account_removed',
    ACCOUNT_UPDATED: 'account_updated',
    EMAIL_DELETED: 'email_deleted',
    EMAIL_MOVED: 'email_moved',
    EMAIL_SENT: 'email_sent',
    ERROR: 'error'
};

/**
 * Socket Client with event emitter pattern
 */
class SocketClient {
    constructor(options = {}) {
        this.options = {
            url: options.url || '',
            reconnection: options.reconnection !== false,
            reconnectionAttempts: options.reconnectionAttempts || 5,
            reconnectionDelay: options.reconnectionDelay || 1000,
            reconnectionDelayMax: options.reconnectionDelayMax || 5000,
            authToken: options.authToken || null,
            ...options
        };

        this._socket = null;
        this._state = ConnectionState.DISCONNECTED;
        this._listeners = new Map();
        this._eventQueue = [];
        this._reconnectAttempt = 0;
        this._manuallyDisconnected = false;

        // Initialise listeners
        this._initDefaultListeners();
    }

    /**
     * Get current connection state
     */
    get state() {
        return this._state;
    }

    /**
     * Check if connected
     */
    get isConnected() {
        return this._state === ConnectionState.CONNECTED;
    }

    /**
     * Initialise default event listeners
     */
    _initDefaultListeners() {
        // Default error handler
        this.on(SocketEvents.ERROR, (error) => {
            console.error('[SocketClient] Error:', error);
        });

        // Default connection status handler
        this.on(SocketEvents.CONNECTION_STATUS, (status) => {
            console.log('[SocketClient] Connection status:', status);
        });
    }

    /**
     * Connect to WebSocket server
     */
    connect() {
        if (this._socket?.connected) {
            console.warn('[SocketClient] Already connected');
            return Promise.resolve();
        }

        this._manuallyDisconnected = false;
        this._setState(ConnectionState.CONNECTING);

        return new Promise((resolve, reject) => {
            try {
                // Load Socket.io dynamically if not available
                if (typeof io === 'undefined') {
                    this._loadSocketIO().then(() => {
                        this._establishConnection(resolve, reject);
                    }).catch(reject);
                } else {
                    this._establishConnection(resolve, reject);
                }
            } catch (error) {
                this._setState(ConnectionState.ERROR);
                reject(error);
            }
        });
    }

    /**
     * Load Socket.io library
     */
    async _loadSocketIO() {
        return new Promise((resolve, reject) => {
            if (typeof io !== 'undefined') {
                resolve();
                return;
            }

            const script = document.createElement('script');
            script.src = '/socket.io/socket.io.js';
            script.onload = resolve;
            script.onerror = () => reject(new Error('Failed to load Socket.io'));
            document.head.appendChild(script);
        });
    }

    /**
     * Establish WebSocket connection
     */
    _establishConnection(resolve, reject) {
        const socketUrl = this.options.url || (window.location.origin);
        
        this._socket = io(socketUrl, {
            reconnection: this.options.reconnection,
            reconnectionAttempts: this.options.reconnectionAttempts,
            reconnectionDelay: this.options.reconnectionDelay,
            reconnectionDelayMax: this.options.reconnectionDelayMax,
            auth: this.options.authToken ? { token: this.options.authToken } : {},
            transports: ['websocket', 'polling'],
            timeout: 20000
        });

        // Connection events
        this._socket.on('connect', () => {
            console.log('[SocketClient] Connected:', this._socket.id);
            this._reconnectAttempt = 0;
            this._setState(ConnectionState.CONNECTED);
            this._flushEventQueue();
            resolve();
        });

        this._socket.on('disconnect', (reason) => {
            console.log('[SocketClient] Disconnected:', reason);
            
            if (!this._manuallyDisconnected) {
                this._setState(ConnectionState.DISCONNECTED);
                
                // Emit connection status event
                this.emit(SocketEvents.CONNECTION_STATUS, {
                    connected: false,
                    reason
                });
            }
        });

        this._socket.on('connect_error', (error) => {
            console.error('[SocketClient] Connection error:', error.message);
            this._setState(ConnectionState.ERROR);
            
            this.emit(SocketEvents.CONNECTION_STATUS, {
                connected: false,
                error: error.message
            });
            
            if (this._state !== ConnectionState.CONNECTING) {
                reject(error);
            }
        });

        this._socket.on('reconnect', (attemptNumber) => {
            console.log('[SocketClient] Reconnected after', attemptNumber, 'attempts');
            this._setState(ConnectionState.CONNECTED);
            
            this.emit(SocketEvents.CONNECTION_STATUS, {
                connected: true,
                reconnected: true,
                attemptNumber
            });
        });

        this._socket.on('reconnect_attempt', (attemptNumber) => {
            console.log('[SocketClient] Reconnect attempt:', attemptNumber);
            this._reconnectAttempt = attemptNumber;
            this._setState(ConnectionState.RECONNECTING);
            
            this.emit(SocketEvents.CONNECTION_STATUS, {
                connected: false,
                reconnecting: true,
                attemptNumber
            });
        });

        this._socket.on('reconnect_failed', () => {
            console.error('[SocketClient] Reconnection failed');
            this._setState(ConnectionState.ERROR);
            
            this.emit(SocketEvents.CONNECTION_STATUS, {
                connected: false,
                reconnectFailed: true
            });
        });

        // Register event handlers
        this._registerEventHandlers();
    }

    /**
     * Register all event handlers from server
     */
    _registerEventHandlers() {
        // Email events
        this._socket.on(SocketEvents.NEW_EMAIL, (data) => {
            console.log('[SocketClient] New email received:', data);
            this.emit(SocketEvents.NEW_EMAIL, data);
        });

        // Sync events
        this._socket.on(SocketEvents.SYNC_COMPLETE, (data) => {
            console.log('[SocketClient] Sync complete:', data);
            this.emit(SocketEvents.SYNC_COMPLETE, data);
        });

        this._socket.on(SocketEvents.SYNC_ERROR, (data) => {
            console.error('[SocketClient] Sync error:', data);
            this.emit(SocketEvents.SYNC_ERROR, data);
        });

        // Account events
        this._socket.on(SocketEvents.ACCOUNT_ADDED, (data) => {
            console.log('[SocketClient] Account added:', data);
            this.emit(SocketEvents.ACCOUNT_ADDED, data);
        });

        this._socket.on(SocketEvents.ACCOUNT_REMOVED, (data) => {
            console.log('[SocketClient] Account removed:', data);
            this.emit(SocketEvents.ACCOUNT_REMOVED, data);
        });

        this._socket.on(SocketEvents.ACCOUNT_UPDATED, (data) => {
            console.log('[SocketClient] Account updated:', data);
            this.emit(SocketEvents.ACCOUNT_UPDATED, data);
        });

        // Email operation events
        this._socket.on(SocketEvents.EMAIL_DELETED, (data) => {
            console.log('[SocketClient] Email deleted:', data);
            this.emit(SocketEvents.EMAIL_DELETED, data);
        });

        this._socket.on(SocketEvents.EMAIL_MOVED, (data) => {
            console.log('[SocketClient] Email moved:', data);
            this.emit(SocketEvents.EMAIL_MOVED, data);
        });

        this._socket.on(SocketEvents.EMAIL_SENT, (data) => {
            console.log('[SocketClient] Email sent:', data);
            this.emit(SocketEvents.EMAIL_SENT, data);
        });

        // Error events
        this._socket.on(SocketEvents.ERROR, (data) => {
            console.error('[SocketClient] Server error:', data);
            this.emit(SocketEvents.ERROR, data);
        });
    }

    /**
     * Set connection state
     */
    _setState(state) {
        const previousState = this._state;
        this._state = state;
        
        if (previousState !== state) {
            this.emit('stateChanged', { previous: previousState, current: state });
        }
    }

    /**
     * Disconnect from WebSocket server
     */
    disconnect() {
        this._manuallyDisconnected = true;
        
        if (this._socket) {
            this._socket.disconnect();
            this._socket = null;
        }
        
        this._setState(ConnectionState.DISCONNECTED);
        
        this.emit(SocketEvents.CONNECTION_STATUS, {
            connected: false,
            manuallyDisconnected: true
        });
    }

    /**
     * Reconnect to WebSocket server
     */
    reconnect() {
        this.disconnect();
        return this.connect();
    }

    /**
     * Update authentication token
     */
    setAuthToken(token) {
        this.options.authToken = token;
        
        if (this._socket?.connected) {
            this._socket.auth = { token };
            this._socket.emit('auth_update', { token });
        }
    }

    /**
     * Emit event to server
     */
    emit(event, data) {
        if (this._socket?.connected) {
            this._socket.emit(event, data);
        } else {
            // Queue event for when connection is restored
            this._eventQueue.push({ event, data, timestamp: Date.now() });
        }
    }

    /**
     * Send event with acknowledgment
     */
    emitWithAck(event, data, timeout = 10000) {
        return new Promise((resolve, reject) => {
            if (!this._socket?.connected) {
                reject(new Error('Not connected'));
                return;
            }

            const timer = setTimeout(() => {
                reject(new Error('Request timeout'));
            }, timeout);

            this._socket.emit(event, data, (response) => {
                clearTimeout(timer);
                if (response?.error) {
                    reject(new Error(response.error));
                } else {
                    resolve(response);
                }
            });
        });
    }

    /**
     * Flush queued events
     */
    _flushEventQueue() {
        while (this._eventQueue.length > 0) {
            const { event, data } = this._eventQueue.shift();
            this.emit(event, data);
        }
    }

    /**
     * Subscribe to account-specific events
     */
    subscribeToAccount(accountId) {
        this.emit('subscribe_account', { accountId });
    }

    /**
     * Unsubscribe from account-specific events
     */
    unsubscribeFromAccount(accountId) {
        this.emit('unsubscribe_account', { accountId });
    }

    /**
     * Request sync for account
     */
    requestSync(accountId) {
        this.emit('request_sync', { accountId });
    }

    /**
     * Event emitter: on
     */
    on(event, callback) {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set());
        }
        this._listeners.get(event).add(callback);
        
        // Return unsubscribe function
        return () => this.off(event, callback);
    }

    /**
     * Event emitter: off
     */
    off(event, callback) {
        if (this._listeners.has(event)) {
            this._listeners.get(event).delete(callback);
        }
    }

    /**
     * Event emitter: once
     */
    once(event, callback) {
        const wrapper = (data) => {
            this.off(event, wrapper);
            callback(data);
        };
        this.on(event, wrapper);
    }

    /**
     * Event emitter: emit
     */
    emit(event, data) {
        if (this._listeners.has(event)) {
            this._listeners.get(event).forEach(callback => {
                try {
                    callback(data);
                } catch (error) {
                    console.error(`[SocketClient] Error in event handler for ${event}:`, error);
                }
            });
        }
    }

    /**
     * Remove all listeners
     */
    removeAllListeners() {
        this._listeners.clear();
    }
}

/**
 * Socket Manager - manages multiple socket connections and provides a singleton
 */
class SocketManager {
    constructor() {
        this._client = null;
        this._apiClient = null;
    }

    /**
     * Initialise with API client
     */
    init(apiClient) {
        this._apiClient = apiClient;
        
        // Listen for auth events to update socket token
        apiClient.on('auth:expired', () => {
            if (this._client) {
                this._client.disconnect();
            }
        });
    }

    /**
     * Get or create socket client
     */
    getClient(options = {}) {
        if (!this._client) {
            const token = this._apiClient?.getToken();
            
            this._client = new SocketClient({
                ...options,
                authToken: token,
                url: options.url || ''
            });
        }
        
        return this._client;
    }

    /**
     * Connect socket
     */
    async connect(options = {}) {
        const client = this.getClient(options);
        await client.connect();
        return client;
    }

    /**
     * Disconnect socket
     */
    disconnect() {
        if (this._client) {
            this._client.disconnect();
        }
    }

    /**
     * Get current client
     */
    get client() {
        return this._client;
    }
}

// Create global instance
const socketManager = new SocketManager();

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { 
        SocketClient, 
        SocketManager, 
        socketManager,
        ConnectionState,
        SocketEvents 
    };
} else if (typeof window !== 'undefined') {
    window.SocketClient = SocketClient;
    window.SocketManager = SocketManager;
    window.socketManager = socketManager;
    window.ConnectionState = ConnectionState;
    window.SocketEvents = SocketEvents;
}
