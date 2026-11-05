/**
 * NovaByte Bridge - NovaMail Integration
 * Main integration module for NovaMail UI
 */

// Import or create API client
const apiClient = typeof NovaByteApi !== 'undefined' ? new NovaByteApi() : null;

/**
 * NovaMail Integration Controller
 */
class NovaMailIntegration {
    constructor() {
        this.api = apiClient;
        this.socket = null;
        this.oauthHandler = null;
        this.appPasswordHandler = null;
        this.providerSelector = null;
        
        // State
        this._isInitialised = false;
        this._accounts = [];
        this._currentAccount = null;
        this._emails = [];
        this._folders = [];
        this._offlineQueue = [];
        this._listeners = new Map(); // Must be initialised before any emit() calls
        
        // Configuration
        this.config = {
            autoConnect: true,
            syncInterval: 30000,
            maxRetries: 3,
            retryDelay: 1000,
            ...this._getConfigFromWindow()
        };
        
        // Bind methods
        this._bindMethods();

        // Restore any emails that were queued while offline
        this._loadOfflineQueue();
    }

    /**
     * Get configuration from window
     */
    _getConfigFromWindow() {
        if (typeof window !== 'undefined' && window.NovaMailConfig) {
            return window.NovaMailConfig;
        }
        return {};
    }

    /**
     * Bind methods to preserve context
     */
    _bindMethods() {
        this.handleNewEmail = this.handleNewEmail.bind(this);
        this.handleSyncComplete = this.handleSyncComplete.bind(this);
        this.handleSyncError = this.handleSyncError.bind(this);
        this.handleConnectionStatus = this.handleConnectionStatus.bind(this);
    }

    /**
     * Initialise the integration
     */
    async init() {
        if (this._isInitialised) {
            console.warn('[NovaMail] Already initialised');
            return;
        }

        try {
            // Initialise API client
            if (!this.api) {
                this.api = new NovaByteApi();
            }

            // Validate session
            const session = await this.api.initFromSession();
            
            if (!session.authenticated) {
                console.log('[NovaMail] Not authenticated');
                this.emit('auth_required');
                return;
            }

            // Initialise OAuth handler
            this.oauthHandler = new OAuthHandler(this.api);
            this.appPasswordHandler = new AppPasswordHandler(this.api);
            this.providerSelector = new ProviderSelector(this.api);

            // Initialise socket connection
            if (this.config.autoConnect) {
                await this._initSocket();
            }

            // Load accounts
            await this.loadAccounts();

            // Register socket event handlers
            this._registerSocketHandlers();

            this._isInitialised = true;
            this.emit('ready', { session });
            
            console.log('[NovaMail] Initialised successfully');
        } catch (error) {
            console.error('[NovaMail] Initialisation error:', error);
            this.emit('error', { type: 'init', error });
            throw error;
        }
    }

    /**
     * Initialise WebSocket connection
     */
    async _initSocket() {
        try {
            this.socket = await socketManager.connect({});
            socketManager.init(this.api);
            return this.socket;
        } catch (error) {
            console.error('[NovaMail] Socket connection failed:', error);
            this.emit('socket_error', { error });
        }
    }

    /**
     * Register socket event handlers
     */
    _registerSocketHandlers() {
        if (!this.socket) return;

        this.socket.on(SocketEvents.NEW_EMAIL, this.handleNewEmail);
        this.socket.on(SocketEvents.SYNC_COMPLETE, this.handleSyncComplete);
        this.socket.on(SocketEvents.SYNC_ERROR, this.handleSyncError);
        this.socket.on(SocketEvents.CONNECTION_STATUS, this.handleConnectionStatus);
    }

    /**
     * Handle new email event
     */
    handleNewEmail(data) {
        const { accountId, email } = data;
        
        // Add to emails list if viewing same account
        if (this._currentAccount?.id === accountId) {
            this._emails.unshift(email);
            this.emit('email_received', { accountId, email });
        }
        
        // Emit notification
        this.emit('notification', {
            type: 'new_email',
            title: 'New Email',
            body: email.subject || 'You have a new email',
            accountId
        });
        
        // Update unread count
        this._updateUnreadCount(accountId);
    }

    /**
     * Handle sync complete event
     */
    handleSyncComplete(data) {
        const { accountId } = data;
        this.emit('sync_complete', { accountId });
        
        // Refresh emails if viewing this account
        if (this._currentAccount?.id === accountId) {
            this.fetchInbox({ accountId, forceRefresh: true });
        }
    }

    /**
     * Handle sync error event
     */
    handleSyncError(data) {
        const { accountId, error } = data;
        this.emit('sync_error', { accountId, error });
    }

    /**
     * Handle connection status change
     */
    handleConnectionStatus(data) {
        const { connected, reconnected } = data;
        
        this.emit('connection_changed', { connected, reconnected });
        
        if (connected && this.config.autoReconnect) {
            // Re-sync accounts on reconnect
            this.syncAllAccounts();
        }
    }

    /**
     * Load all accounts
     */
    async loadAccounts() {
        try {
            const response = await this.api.accounts.listAccounts();
            this._accounts = response.accounts || [];
            this.emit('accounts_loaded', { accounts: this._accounts });
            return this._accounts;
        } catch (error) {
            console.error('[NovaMail] Failed to load accounts:', error);
            this.emit('error', { type: 'load_accounts', error });
            throw error;
        }
    }

    /**
     * Get accounts
     */
    getAccounts() {
        return this._accounts;
    }

    /**
     * Select current account
     */
    async selectAccount(accountId) {
        const account = this._accounts.find(a => a.id === accountId);
        
        if (!account) {
            throw new Error('Account not found');
        }

        this._currentAccount = account;
        
        // Subscribe to account events
        if (this.socket) {
            this.socket.subscribeToAccount(accountId);
        }

        this.emit('account_selected', { account });
        
        // Load folders
        await this.loadFolders(accountId);
        
        // Load emails
        await this.fetchInbox({ accountId });
        
        return account;
    }

    /**
     * Get current account
     */
    getCurrentAccount() {
        return this._currentAccount;
    }

    /**
     * Add new email account
     */
    async addAccount(accountData) {
        try {
            const result = await this.api.accounts.addAccount(accountData);
            
            if (result.success && result.account) {
                this._accounts.push(result.account);
                this.emit('account_added', { account: result.account });
            }
            
            return result;
        } catch (error) {
            this.emit('error', { type: 'add_account', error });
            throw error;
        }
    }

    /**
     * Remove email account
     */
    async removeAccount(accountId) {
        try {
            await this.api.accounts.removeAccount(accountId);
            
            const index = this._accounts.findIndex(a => a.id === accountId);
            if (index > -1) {
                this._accounts.splice(index, 1);
            }
            
            // Clear current account if removed
            if (this._currentAccount?.id === accountId) {
                this._currentAccount = null;
            }
            
            this.emit('account_removed', { accountId });
        } catch (error) {
            this.emit('error', { type: 'remove_account', error });
            throw error;
        }
    }

    /**
     * Load folders for account
     */
    async loadFolders(accountId) {
        try {
            const response = await this.api.mail.getFolders(accountId);
            this._folders = response.folders || [];
            this.emit('folders_loaded', { accountId, folders: this._folders });
            return this._folders;
        } catch (error) {
            console.error('[NovaMail] Failed to load folders:', error);
            this.emit('error', { type: 'load_folders', error });
            throw error;
        }
    }

    /**
     * Get folders
     */
    getFolders() {
        return this._folders;
    }

    /**
     * Fetch inbox emails
     */
    async fetchInbox({ accountId, page = 1, limit = 50, forceRefresh = false } = {}) {
        const targetAccountId = accountId || this._currentAccount?.id;
        
        if (!targetAccountId) {
            throw new Error('No account selected');
        }

        // Return cached if not forcing refresh
        if (!forceRefresh && this._emails.length > 0) {
            return this._emails;
        }

        try {
            this.emit('fetching_emails', { accountId: targetAccountId });
            
            const response = await this.api.mail.fetchInbox(targetAccountId, { page, limit });
            
            this._emails = response.emails || [];
            this._pagination = response.pagination;
            
            this.emit('emails_loaded', { 
                accountId: targetAccountId, 
                emails: this._emails,
                pagination: this._pagination
            });
            
            return this._emails;
        } catch (error) {
            console.error('[NovaMail] Failed to fetch inbox:', error);
            this.emit('error', { type: 'fetch_inbox', error });
            throw error;
        }
    }

    /**
     * Get emails
     */
    getEmails() {
        return this._emails;
    }

    /**
     * Fetch single email
     */
    async fetchEmail(accountId, messageId) {
        try {
            const response = await this.api.mail.fetchEmail(accountId, messageId);
            this.emit('email_loaded', { accountId, messageId, email: response.email });
            return response.email;
        } catch (error) {
            this.emit('error', { type: 'fetch_email', error });
            throw error;
        }
    }

    /**
     * Send email
     */
    async sendEmail(accountId, emailData) {
        const targetAccountId = accountId || this._currentAccount?.id;
        
        if (!targetAccountId) {
            throw new Error('No account selected');
        }

        // Check if offline and queue if so
        if (!navigator.onLine) {
            return this._queueEmail(targetAccountId, emailData);
        }

        try {
            this.emit('sending_email', { accountId: targetAccountId, emailData });
            
            const result = await this.api.mail.sendEmail(targetAccountId, emailData);
            
            this.emit('email_sent', { 
                accountId: targetAccountId, 
                messageId: result.messageId 
            });
            
            return result;
        } catch (error) {
            // Queue on failure for retry
            await this._queueEmail(targetAccountId, emailData);
            this.emit('error', { type: 'send_email', error });
            throw error;
        }
    }

    /**
     * Move email to folder
     */
    async moveEmail(accountId, messageId, targetFolder) {
        const targetAccountId = accountId || this._currentAccount?.id;
        
        if (!targetAccountId) {
            throw new Error('No account selected');
        }

        try {
            await this.api.mail.moveEmail(targetAccountId, { messageId, targetFolder });
            
            // Update local state
            const emailIndex = this._emails.findIndex(e => e.messageId === messageId);
            if (emailIndex > -1) {
                this._emails[emailIndex].folder = targetFolder;
            }
            
            this.emit('email_moved', { accountId: targetAccountId, messageId, targetFolder });
        } catch (error) {
            this.emit('error', { type: 'move_email', error });
            throw error;
        }
    }

    /**
     * Delete email
     */
    async deleteEmail(accountId, messageId, moveToTrash = true) {
        const targetAccountId = accountId || this._currentAccount?.id;
        
        if (!targetAccountId) {
            throw new Error('No account selected');
        }

        try {
            await this.api.mail.deleteEmail(targetAccountId, { messageId, moveToTrash });
            
            // Remove from local state
            const emailIndex = this._emails.findIndex(e => e.messageId === messageId);
            if (emailIndex > -1) {
                this._emails.splice(emailIndex, 1);
            }
            
            this.emit('email_deleted', { accountId: targetAccountId, messageId });
        } catch (error) {
            this.emit('error', { type: 'delete_email', error });
            throw error;
        }
    }

    /**
     * Search emails
     */
    async searchEmails(accountId, query, options = {}) {
        const targetAccountId = accountId || this._currentAccount?.id;
        
        if (!targetAccountId) {
            throw new Error('No account selected');
        }

        try {
            const response = await this.api.mail.searchEmails(targetAccountId, {
                query,
                ...options
            });
            
            this.emit('search_complete', { 
                accountId: targetAccountId, 
                query, 
                results: response.data?.emails || [] 
            });
            
            return response.data?.emails || [];
        } catch (error) {
            this.emit('error', { type: 'search_emails', error });
            throw error;
        }
    }

    /**
     * Sync all accounts
     */
    async syncAllAccounts() {
        for (const account of this._accounts) {
            if (this.socket) {
                this.socket.requestSync(account.id);
            }
        }
        this.emit('sync_started', { accounts: this._accounts });
    }

    /**
     * Sync specific account
     */
    async syncAccount(accountId) {
        if (this.socket) {
            this.socket.requestSync(accountId);
            this.emit('sync_started', { accountId });
        }
    }

    /**
     * Queue email for offline sending
     */
    async _queueEmail(accountId, emailData) {
        const queueItem = {
            id: Date.now().toString(),
            accountId,
            emailData,
            createdAt: new Date().toISOString(),
            retries: 0
        };
        
        this._offlineQueue.push(queueItem);
        
        // Store in localStorage for persistence
        this._persistOfflineQueue();
        
        this.emit('email_queued', { queueItem });
        
        return queueItem;
    }

    /**
     * Process offline queue
     */
    async _processOfflineQueue() {
        if (!navigator.onLine || this._offlineQueue.length === 0) {
            return;
        }

        const failedItems = [];
        
        for (const item of this._offlineQueue) {
            try {
                await this.api.mail.sendEmail(item.accountId, item.emailData);
                this.emit('queued_email_sent', { queueItem: item });
            } catch (error) {
                item.retries++;
                
                if (item.retries >= this.config.maxRetries) {
                    this.emit('queued_email_failed', { queueItem: item, error });
                } else {
                    failedItems.push(item);
                }
            }
        }
        
        this._offlineQueue = failedItems;
        this._persistOfflineQueue();
    }

    /**
     * Persist offline queue to localStorage
     */
    _persistOfflineQueue() {
        try {
            localStorage.setItem('novamail_offline_queue', JSON.stringify(this._offlineQueue));
        } catch (error) {
            console.warn('[NovaMail] Failed to persist offline queue:', error);
        }
    }

    /**
     * Load offline queue from localStorage
     */
    _loadOfflineQueue() {
        try {
            const stored = localStorage.getItem('novamail_offline_queue');
            if (stored) {
                this._offlineQueue = JSON.parse(stored);
            }
        } catch (error) {
            console.warn('[NovaMail] Failed to load offline queue:', error);
        }
    }

    /**
     * Update unread count for account
     */
    async _updateUnreadCount(accountId) {
        try {
            const account = this._accounts.find(a => a.id === accountId);
            if (account) {
                const response = await this.api.accounts.getAccountStatus(accountId);
                account.unreadCount = response.status?.unreadCount || 0;
                this.emit('unread_updated', { accountId, count: account.unreadCount });
            }
        } catch (error) {
            console.warn('[NovaMail] Failed to update unread count:', error);
        }
    }

    /**
     * Login user
     */
    async login(email, password, mfaCode) {
        try {
            const result = await this.api.auth.login({ email, password, mfaCode });
            
            if (!result.mfaRequired) {
                // Initialise after successful login
                await this.init();
            }
            
            return result;
        } catch (error) {
            this.emit('error', { type: 'login', error });
            throw error;
        }
    }

    /**
     * Register user
     */
    async register(email, password, displayName) {
        try {
            const result = await this.api.auth.register({ email, password, displayName });
            return result;
        } catch (error) {
            this.emit('error', { type: 'register', error });
            throw error;
        }
    }

    /**
     * Logout user
     */
    async logout() {
        try {
            await this.api.auth.logout();
            
            // Disconnect socket
            if (this.socket) {
                this.socket.disconnect();
            }
            
            // Clear state
            this._accounts = [];
            this._currentAccount = null;
            this._emails = [];
            this._folders = [];
            
            this.emit('logged_out');
        } catch (error) {
            this.emit('error', { type: 'logout', error });
            throw error;
        }
    }

    /**
     * Check authentication status
     */
    async checkAuth() {
        try {
            const session = await this.api.auth.validateSession();
            return session.authenticated;
        } catch (error) {
            return false;
        }
    }

    /**
     * Event emitter
     */
    on(event, callback) {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set());
        }
        this._listeners.get(event).add(callback);
    }

    off(event, callback) {
        if (this._listeners?.has(event)) {
            this._listeners.get(event).delete(callback);
        }
    }

    emit(event, data) {
        if (this._listeners?.has(event)) {
            this._listeners.get(event).forEach(cb => cb(data));
        }
    }

    /**
     * Destroy instance
     */
    destroy() {
        if (this.socket) {
            this.socket.disconnect();
        }
        
        this._listeners?.clear();
        this._accounts = [];
        this._currentAccount = null;
        this._emails = [];
        this._folders = [];
        this._isInitialised = false;
    }
}

// Offline queue processing
if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
        if (window.novaMailIntegration) {
            window.novaMailIntegration._processOfflineQueue();
        }
    });
}

// Create global instance
let novaMailIntegration;

/**
 * Get or create NovaMail integration instance
 */
function getNovaMailIntegration() {
    if (!novaMailIntegration) {
        novaMailIntegration = new NovaMailIntegration();
    }
    return novaMailIntegration;
}

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { NovaMailIntegration, getNovaMailIntegration };
} else if (typeof window !== 'undefined') {
    window.NovaMailIntegration = NovaMailIntegration;
    window.getNovaMailIntegration = getNovaMailIntegration;
    
    // Auto-initialise if configured
    if (window.NovaMailConfig?.autoInit !== false) {
        document.addEventListener('DOMContentLoaded', () => {
            getNovaMailIntegration();
        });
    }
}