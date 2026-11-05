/**
 * NovaByte Bridge - Frontend API Client
 * API client for NovaMail integration
 */

class ApiClient {
    constructor(baseUrl = '', parent = null) {
        this.baseUrl = baseUrl || this._getBaseUrl();
        this._token = null;
        this._parent = parent; // Reference to parent NovaByteApi for shared token access
        this._refreshPromise = null;
        this._listeners = new Map();
        
        // Request/response interceptors
        this._requestInterceptors = [];
        this._responseInterceptors = [];
        
        // Configure interceptors
        this._setupDefaultInterceptors();
    }

    /**
     * Get base URL from current location
     */
    _getBaseUrl() {
        if (typeof window !== 'undefined') {
            return window.location.origin;
        }
        return '';
    }

    /**
     * Setup default interceptors
     */
    _setupDefaultInterceptors() {
        // Request interceptor: add auth token
        this.addRequestInterceptor((config) => {
            // Get token from this client or from parent NovaByteApi instance
            const token = this._token || this._parent?._token;
            if (token) {
                config.headers = config.headers || {};
                // Only add if not already set
                if (!config.headers['Authorization']) {
                    config.headers['Authorization'] = `Bearer ${token}`;
                }
            }
            return config;
        });

        // Response interceptor: handle 401 errors and token refresh
        this.addResponseInterceptor(
            (response) => response,
            async (error) => {
                const originalRequest = error.config;
                
                // If 401 and not already retrying, try to refresh token
                if (error.response?.status === 401 && !originalRequest._retry) {
                    originalRequest._retry = true;
                    
                    try {
                        await this.refreshSession();
                        // Get token from this client or parent
                        const token = this._token || this._parent?._token;
                        // Retry the original request
                        return this._fetch(originalRequest.url, {
                            ...originalRequest,
                            headers: {
                                ...originalRequest.headers,
                                'Authorization': `Bearer ${token}`
                            }
                        });
                    } catch (refreshError) {
                        // Refresh failed, clear token and emit event
                        this._token = null;
                        // Also clear parent token if this is a sub-client
                        if (this._parent) {
                            this._parent._token = null;
                            this._parent.emit('auth:expired', null);
                        } else {
                            this.emit('auth:expired', null);
                        }
                        throw refreshError;
                    }
                }
                
                throw error;
            }
        );
    }

    /**
     * Add request interceptor
     */
    addRequestInterceptor(interceptor) {
        this._requestInterceptors.push(interceptor);
    }

    /**
     * Add response interceptor
     */
    addResponseInterceptor(onFulfilled, onRejected) {
        this._responseInterceptors.push({ onFulfilled, onRejected });
    }

    /**
     * Apply request interceptors
     */
    async _applyRequestInterceptors(config) {
        let modifiedConfig = { ...config };
        for (const interceptor of this._requestInterceptors) {
            modifiedConfig = await interceptor(modifiedConfig);
        }
        return modifiedConfig;
    }

    /**
     * Apply response interceptors
     */
    async _applyResponseInterceptors(response) {
        let modifiedResponse = response;
        for (const interceptor of this._responseInterceptors) {
            try {
                modifiedResponse = await interceptor.onFulfilled(modifiedResponse);
            } catch (error) {
                if (interceptor.onRejected) {
                    return interceptor.onRejected(error);
                }
                throw error;
            }
        }
        return modifiedResponse;
    }

    /**
     * Set authentication token
     */
    setToken(token) {
        this._token = token;
    }

    /**
     * Get authentication token
     */
    getToken() {
        return this._token;
    }

    /**
     * Clear authentication token
     */
    clearToken() {
        this._token = null;
    }

    /**
     * Make API request with interceptors
     */
    async _fetch(url, options = {}) {
        const fullUrl = url.startsWith('http') ? url : `${this.baseUrl}${url}`;
        
        const defaultOptions = {
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const config = await this._applyRequestInterceptors({
            ...defaultOptions,
            ...options,
            url: fullUrl
        });

        const response = await fetch(config.url, {
            method: config.method || 'GET',
            headers: config.headers,
            body: config.body,
            credentials: config.credentials
        });

        let data;
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            data = await response.json();
        } else {
            data = await response.text();
        }

        const responseObj = {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            data,
            headers: response.headers
        };

        return this._applyResponseInterceptors(responseObj);
    }

    /**
     * Parse error response and return user-friendly message
     */
    _parseError(error) {
        if (error.response?.data?.error) {
            return error.response.data.error;
        }
        if (error.message) {
            return error.message;
        }
        return 'An unexpected error occurred';
    }

    /**
     * Event emitter methods
     */
    on(event, callback) {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set());
        }
        this._listeners.get(event).add(callback);
    }

    off(event, callback) {
        if (this._listeners.has(event)) {
            this._listeners.get(event).delete(callback);
        }
    }

    emit(event, data) {
        if (this._listeners.has(event)) {
            this._listeners.get(event).forEach(callback => callback(data));
        }
    }
}

/**
 * Authentication API endpoints
 */
class AuthApi extends ApiClient {
    /**
     * Register a new user
     */
    async register({ email, password, displayName }) {
        const response = await this._fetch('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({ email, password, displayName })
        });

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * User login
     */
    async login({ email, password, mfaCode, deviceInfo }) {
        const response = await this._fetch('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password, mfaCode, deviceInfo })
        });

        if (!response.ok) {
            if (response.data?.mfaRequired) {
                return { mfaRequired: true, message: response.data.message };
            }
            throw new Error(this._parseError({ response }));
        }

        // Store token
        if (response.data.session?.token) {
            this.setToken(response.data.session.token);
        }

        return response.data;
    }

    /**
     * User logout
     */
    async logout() {
        try {
            const response = await this._fetch('/api/auth/logout', {
                method: 'POST'
            });

            this.clearToken();
            this.emit('auth:loggedOut', null);

            return response.data;
        } catch (error) {
            // Clear token even if server request fails
            this.clearToken();
            throw error;
        }
    }

    /**
     * Validate current session
     */
    async validateSession() {
        const response = await this._fetch('/api/auth/session');

        if (!response.ok) {
            this.clearToken();
            return { authenticated: false };
        }

        return response.data;
    }

    /**
     * Refresh session token
     */
    async refreshSession() {
        // Prevent multiple simultaneous refresh attempts
        if (this._refreshPromise) {
            return this._refreshPromise;
        }

        this._refreshPromise = (async () => {
            try {
                const response = await this._fetch('/api/auth/refresh', {
                    method: 'POST'
                });

                if (!response.ok) {
                    throw new Error(this._parseError({ response }));
                }

                if (response.data.session?.token) {
                    this.setToken(response.data.session.token);
                }

                return response.data;
            } finally {
                this._refreshPromise = null;
            }
        })();

        return this._refreshPromise;
    }

    /**
     * Change password
     */
    async changePassword({ currentPassword, newPassword }) {
        const response = await this._fetch('/api/auth/change-password', {
            method: 'POST',
            body: JSON.stringify({ currentPassword, newPassword })
        });

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Setup MFA
     */
    async setupMFA() {
        const response = await this._fetch('/api/auth/setup-mfa', {
            method: 'POST'
        });

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Verify MFA code
     */
    async verifyMFA(code) {
        const response = await this._fetch('/api/auth/verify-mfa', {
            method: 'POST',
            body: JSON.stringify({ code })
        });

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Disable MFA
     */
    async disableMFA(password) {
        const response = await this._fetch('/api/auth/disable-mfa', {
            method: 'POST',
            body: JSON.stringify({ password })
        });

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }
}

/**
 * Email Account Management API
 */
class AccountApi extends ApiClient {
    /**
     * Add new email account
     */
    async addAccount(accountData) {
        const response = await this._fetch('/api/mail/accounts', {
            method: 'POST',
            body: JSON.stringify(accountData)
        });

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * List all accounts for user
     */
    async listAccounts() {
        const response = await this._fetch('/api/mail/accounts');

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Get account details
     */
    async getAccount(accountId) {
        const response = await this._fetch(`/api/mail/accounts/${encodeURIComponent(accountId)}`);

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Remove account
     */
    async removeAccount(accountId) {
        const response = await this._fetch(`/api/mail/accounts/${encodeURIComponent(accountId)}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Update account settings
     */
    async updateAccount(accountId, updates) {
        const response = await this._fetch(`/api/mail/accounts/${encodeURIComponent(accountId)}`, {
            method: 'PUT',
            body: JSON.stringify(updates)
        });

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Test account connection
     */
    async testConnection(accountId) {
        const response = await this._fetch(`/api/mail/accounts/${encodeURIComponent(accountId)}/test`, {
            method: 'POST'
        });

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Get account sync status
     */
    async getAccountStatus(accountId) {
        const response = await this._fetch(`/api/mail/accounts/${encodeURIComponent(accountId)}/status`);

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }
}

/**
 * Email Operations API
 */
class MailApi extends ApiClient {
    /**
     * Fetch inbox emails
     */
    async fetchInbox(accountId, { page = 1, limit = 50 } = {}) {
        const params = new URLSearchParams({ page, limit });
        const response = await this._fetch(`/api/mail/accounts/${encodeURIComponent(accountId)}/inbox?${params}`);

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Fetch emails from specific folder
     */
    async fetchEmails(accountId, { folder = 'INBOX', page = 1, limit = 50 } = {}) {
        const params = new URLSearchParams({ folder, page, limit });
        const response = await this._fetch(`/api/mail/accounts/${encodeURIComponent(accountId)}/emails?${params}`);

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Get full email details
     */
    async fetchEmail(accountId, messageId) {
        const response = await this._fetch(
            `/api/mail/accounts/${encodeURIComponent(accountId)}/emails/${encodeURIComponent(messageId)}`
        );

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Send email
     */
    async sendEmail(accountId, emailData) {
        const response = await this._fetch(`/api/mail/accounts/${encodeURIComponent(accountId)}/send`, {
            method: 'POST',
            body: JSON.stringify(emailData)
        });

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Move email to folder
     */
    async moveEmail(accountId, { messageId, targetFolder }) {
        const response = await this._fetch(`/api/mail/accounts/${encodeURIComponent(accountId)}/move`, {
            method: 'POST',
            body: JSON.stringify({ messageId, targetFolder })
        });

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Delete email
     */
    async deleteEmail(accountId, { messageId, moveToTrash = true }) {
        const response = await this._fetch(`/api/mail/accounts/${encodeURIComponent(accountId)}/delete`, {
            method: 'POST',
            body: JSON.stringify({ messageId, moveToTrash })
        });

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Get folder list
     */
    async getFolders(accountId) {
        const response = await this._fetch(`/api/mail/accounts/${encodeURIComponent(accountId)}/folders`);

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Search emails
     */
    async searchEmails(accountId, { query, folder = 'INBOX', page = 1, limit = 50 }) {
        const params = new URLSearchParams({ query, folder, page, limit });
        const response = await this._fetch(`/api/mail/accounts/${encodeURIComponent(accountId)}/search?${params}`);

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }
}

/**
 * Provider Configuration API
 */
class ProviderApi extends ApiClient {
    /**
     * Get all providers
     */
    async getProviders() {
        const response = await this._fetch('/api/mail/providers');

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Get provider by ID
     */
    async getProvider(providerId) {
        const response = await this._fetch(`/api/mail/providers/${encodeURIComponent(providerId)}`);

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Auto-discover email settings
     */
    async autoDiscover(email) {
        const response = await this._fetch('/api/mail/providers/autodiscover', {
            method: 'POST',
            body: JSON.stringify({ email })
        });

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }
}

/**
 * OAuth API endpoints
 */
class OAuthApi extends ApiClient {
    /**
     * Get Google OAuth URL
     */
    async getGoogleAuthUrl(redirectUrl = '/') {
        const params = new URLSearchParams({ redirectUrl });
        const response = await this._fetch(`/api/auth/google?${params}`);

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Get Microsoft OAuth URL
     */
    async getMicrosoftAuthUrl(redirectUrl = '/') {
        const params = new URLSearchParams({ redirectUrl });
        const response = await this._fetch(`/api/auth/microsoft?${params}`);

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Handle OAuth callback
     */
    async handleOAuthCallback(provider, code, state) {
        const response = await this._fetch(`/api/auth/${provider}/callback`, {
            method: 'GET',
            body: JSON.stringify({ code, state })
        });

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }

    /**
     * Store app password for account
     */
    async storeAppPassword(accountId, appPassword) {
        const response = await this._fetch(`/api/mail/accounts/${encodeURIComponent(accountId)}/app-password`, {
            method: 'POST',
            body: JSON.stringify({ appPassword })
        });

        if (!response.ok) {
            throw new Error(this._parseError({ response }));
        }

        return response.data;
    }
}

/**
 * Main API Client that combines all endpoints
 */
class NovaByteApi extends ApiClient {
    constructor(baseUrl) {
        super(baseUrl);
        
        // Store reference to self for sub-clients
        const self = this;
        
        // Sub-clients - pass parent reference so they can access the parent's token
        this.auth = new AuthApi(baseUrl, self);
        this.accounts = new AccountApi(baseUrl, self);
        this.mail = new MailApi(baseUrl, self);
        this.providers = new ProviderApi(baseUrl, self);
        this.oauth = new OAuthApi(baseUrl, self);
        
        // Sync token state with sub-clients
        this._syncTokenState();
    }

    /**
     * Sync token state between main client and sub-clients
     */
    _syncTokenState() {
        const originalSetToken = this.setToken.bind(this);
        const originalClearToken = this.clearToken.bind(this);
        
        this.setToken = (token) => {
            originalSetToken(token);
            this.auth.setToken(token);
            this.accounts.setToken(token);
            this.mail.setToken(token);
            this.providers.setToken(token);
            this.oauth.setToken(token);
        };
        
        this.clearToken = () => {
            originalClearToken();
            this.auth.clearToken();
            this.accounts.clearToken();
            this.mail.clearToken();
            this.providers.clearToken();
            this.oauth.clearToken();
        };
    }

    /**
     * Initialise from stored session
     */
    async initFromSession() {
        try {
            const session = await this.auth.validateSession();
            if (session.authenticated && session.session?.token) {
                this.setToken(session.session.token);
            }
            return session;
        } catch (error) {
            return { authenticated: false };
        }
    }
}

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { NovaByteApi, ApiClient, AuthApi, AccountApi, MailApi, ProviderApi, OAuthApi };
} else if (typeof window !== 'undefined') {
    window.NovaByteApi = NovaByteApi;
    window.ApiClient = ApiClient;
    window.AuthApi = AuthApi;
    window.AccountApi = AccountApi;
    window.MailApi = MailApi;
    window.ProviderApi = ProviderApi;
    window.OAuthApi = OAuthApi;
}
