/**
 * NovaByte Bridge - OAuth Handler
 * OAuth flow handlers for Google, Microsoft, and App Password authentication
 */

/**
 * OAuth Provider Types
 */
const OAuthProvider = {
    GOOGLE: 'google',
    MICROSOFT: 'microsoft',
    APP_PASSWORD: 'app_password'
};

/**
 * OAuth Flow Types
 */
const OAuthFlow = {
    POPUP: 'popup',
    REDIRECT: 'redirect'
};

/**
 * OAuth Handler for managing OAuth flows
 */
class OAuthHandler {
    constructor(apiClient, options = {}) {
        this.apiClient = apiClient;
        this.options = {
            popupWidth: 600,
            popupHeight: 700,
            redirectUrl: options.redirectUrl || '/',
            ...options
        };

        this._popup = null;
        this._listeners = new Map();
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
            this._listeners.get(event).forEach(cb => cb(data));
        }
    }

    /**
     * Initiate Google OAuth flow
     */
    async initGoogleOAuth(flow = OAuthFlow.POPUP, redirectUrl) {
        try {
            // Get OAuth URL from server
            const { authUrl } = await this.apiClient.oauth.getGoogleAuthUrl(
                redirectUrl || this.options.redirectUrl
            );

            if (flow === OAuthFlow.POPUP) {
                return this._openPopup(authUrl, OAuthProvider.GOOGLE);
            } else {
                window.location.href = authUrl;
                return { redirect: true };
            }
        } catch (error) {
            this.emit('error', { provider: OAuthProvider.GOOGLE, error });
            throw error;
        }
    }

    /**
     * Initiate Microsoft OAuth flow
     */
    async initMicrosoftOAuth(flow = OAuthFlow.POPUP, redirectUrl) {
        try {
            // Get OAuth URL from server
            const { authUrl } = await this.apiClient.oauth.getMicrosoftAuthUrl(
                redirectUrl || this.options.redirectUrl
            );

            if (flow === OAuthFlow.POPUP) {
                return this._openPopup(authUrl, OAuthProvider.MICROSOFT);
            } else {
                window.location.href = authUrl;
                return { redirect: true };
            }
        } catch (error) {
            this.emit('error', { provider: OAuthProvider.MICROSOFT, error });
            throw error;
        }
    }

    /**
     * Open OAuth popup window
     */
    _openPopup(url, provider) {
        return new Promise((resolve, reject) => {
            // Calculate center position
            const left = (window.screenX + (window.outerWidth - this.options.popupWidth) / 2);
            const top = (window.screenY + (window.outerHeight - this.options.popupHeight) / 2);

            const popupOptions = [
                `width=${this.options.popupWidth}`,
                `height=${this.options.popupHeight}`,
                `left=${left}`,
                `top=${top}`,
                'menubar=no',
                'toolbar=no',
                'location=no',
                'status=no',
                'resizable=yes',
                'scrollbars=yes'
            ].join(',');

            this._popup = window.open(url, `${provider} OAuth`, popupOptions);

            if (!this._popup) {
                reject(new Error('Popup blocked. Please allow popups for this site.'));
                return;
            }

            // Listen for messages from popup
            const messageHandler = (event) => {
                // Validate origin
                if (event.origin !== window.location.origin) {
                    return;
                }

                const { type, provider: msgProvider, data, error } = event.data || {};

                if (type === 'oauth_callback' && msgProvider === provider) {
                    window.removeEventListener('message', messageHandler);
                    
                    if (this._popup) {
                        this._popup.close();
                        this._popup = null;
                    }

                    if (error) {
                        this.emit('error', { provider, error });
                        reject(new Error(error));
                    } else {
                        this.emit('success', { provider, data });
                        resolve({ provider, data });
                    }
                }
            };

            window.addEventListener('message', messageHandler);

            // Handle popup closed without callback
            const checkClosed = setInterval(() => {
                if (this._popup?.closed) {
                    clearInterval(checkClosed);
                    window.removeEventListener('message', messageHandler);
                    this._popup = null;
                    
                    // Don't reject - user might have closed manually
                    this.emit('popup_closed', { provider });
                }
            }, 500);

            // Cleanup on page unload
            window.addEventListener('beforeunload', () => {
                if (this._popup && !this._popup.closed) {
                    this._popup.close();
                }
            });
        });
    }

    /**
     * Handle OAuth callback (for redirect flow)
     */
    async handleOAuthCallback(provider, queryParams) {
        const { code, state, error, error_description } = queryParams;

        if (error) {
            const errorMsg = error_description || error;
            this.emit('error', { provider, error: errorMsg });
            throw new Error(errorMsg);
        }

        if (!code) {
            const errorMsg = 'No authorization code received';
            this.emit('error', { provider, error: errorMsg });
            throw new Error(errorMsg);
        }

        try {
            const result = await this.apiClient.oauth.handleOAuthCallback(provider, code, state);
            this.emit('success', { provider, data: result });
            return result;
        } catch (error) {
            this.emit('error', { provider, error: error.message });
            throw error;
        }
    }

    /**
     * Close any open popup
     */
    closePopup() {
        if (this._popup && !this._popup.closed) {
            this._popup.close();
            this._popup = null;
        }
    }
}

/**
 * App Password Handler
 */
class AppPasswordHandler {
    constructor(apiClient) {
        this.apiClient = apiClient;
    }

    /**
     * Store app password for account
     */
    async storeAppPassword(accountId, appPassword) {
        try {
            const result = await this.apiClient.oauth.storeAppPassword(accountId, appPassword);
            return result;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Validate app password format
     */
    validateAppPassword(password, providerId) {
        const validations = {
            icloud: {
                pattern: /^[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}$/,
                example: 'xxxx-xxxx-xxxx-xxxx'
            },
            yahoo: {
                pattern: /^[a-zA-Z0-9]{16}$/,
                example: '16 character password'
            },
            fastmail: {
                pattern: /^[a-zA-Z0-9]{32}$/,
                example: '32 character password'
            },
            default: {
                pattern: /^.+$/,
                example: 'App-specific password'
            }
        };

        const validation = validations[providerId] || validations.default;
        
        return {
            valid: validation.pattern.test(password),
            example: validation.example,
            providerId
        };
    }

    /**
     * Get app password URL for provider
     */
    getAppPasswordUrl(providerId) {
        const urls = {
            icloud: 'https://appleid.apple.com/sign-in-with-apple/help',
            yahoo: 'https://login.yahoo.com/account/security',
            fastmail: 'https://www.fastmail.com/help/account/advanced-security.html',
            default: null
        };

        return urls[providerId] || urls.default;
    }
}

/**
 * Account Setup Wizard
 */
class AccountSetupWizard {
    constructor(oauthHandler, appPasswordHandler, apiClient) {
        this.oauthHandler = oauthHandler;
        this.appPasswordHandler = appPasswordHandler;
        this.apiClient = apiClient;
        
        this._currentStep = 0;
        this._steps = [
            'provider_selection',
            'authentication',
            'account_creation',
            'sync_setup',
            'complete'
        ];
    }

    /**
     * Get current step
     */
    get currentStep() {
        return this._currentStep;
    }

    /**
     * Get step name
     */
    get currentStepName() {
        return this._steps[this._currentStep];
    }

    /**
     * Get total steps
     */
    get totalSteps() {
        return this._steps.length;
    }

    /**
     * Move to next step
     */
    nextStep() {
        if (this._currentStep < this._steps.length - 1) {
            this._currentStep++;
            return true;
        }
        return false;
    }

    /**
     * Move to previous step
     */
    previousStep() {
        if (this._currentStep > 0) {
            this._currentStep--;
            return true;
        }
        return false;
    }

    /**
     * Go to specific step
     */
    goToStep(stepIndex) {
        if (stepIndex >= 0 && stepIndex < this._steps.length) {
            this._currentStep = stepIndex;
            return true;
        }
        return false;
    }

    /**
     * Get available providers
     */
    async getProviders() {
        const response = await this.apiClient.providers.getProviders();
        return response.providers || [];
    }

    /**
     * Start account setup with provider
     */
    async startWithProvider(provider, options = {}) {
        this._provider = provider;
        this._options = options;

        // Determine authentication method
        if (provider.oauth_supported) {
            // OAuth is supported - determine provider type
            if (provider.id === 'gmail') {
                return this.oauthHandler.initGoogleOAuth(
                    options.flow || OAuthFlow.POPUP,
                    options.redirectUrl
                );
            } else if (provider.id === 'outlook' || provider.id === 'office365') {
                return this.oauthHandler.initMicrosoftOAuth(
                    options.flow || OAuthFlow.POPUP,
                    options.redirectUrl
                );
            }
        }

        if (provider.app_password_required || provider.id === 'custom') {
            // App password required
            this._currentStep = 1; // Move to authentication step
            return { requiresAppPassword: true, provider };
        }

        throw new Error(`Unsupported authentication method for ${provider.name}`);
    }

    /**
     * Complete account setup with app password
     */
    async completeWithAppPassword(appPassword) {
        if (!this._provider) {
            throw new Error('No provider selected');
        }

        // Validate password
        const validation = this.appPasswordHandler.validateAppPassword(
            appPassword,
            this._provider.id
        );

        if (!validation.valid) {
            throw new Error(`Invalid app password format. Expected: ${validation.example}`);
        }

        // Create account
        const accountData = {
            providerId: this._provider.id,
            emailAddress: this._options.email,
            appPassword: appPassword,
            syncEnabled: this._options.syncEnabled !== false,
            syncInterval: this._options.syncInterval || 5
        };

        const result = await this.apiClient.accounts.addAccount(accountData);
        
        // Test connection
        if (result.account?.id) {
            await this.apiClient.accounts.testConnection(result.account.id);
        }

        return result;
    }

    /**
     * Reset wizard
     */
    reset() {
        this._currentStep = 0;
        this._provider = null;
        this._options = {};
    }
}

/**
 * Provider Selection UI
 */
class ProviderSelector {
    constructor(apiClient) {
        this.apiClient = apiClient;
        this._providers = null;
        this._selectedProvider = null;
    }

    /**
     * Load and cache providers
     */
    async loadProviders() {
        if (this._providers) {
            return this._providers;
        }

        const response = await this.apiClient.providers.getProviders();
        this._providers = response.providers || [];
        return this._providers;
    }

    /**
     * Get OAuth-supported providers
     */
    async getOAuthProviders() {
        const providers = await this.loadProviders();
        return providers.filter(p => p.oauth_supported);
    }

    /**
     * Get app password providers
     */
    async getAppPasswordProviders() {
        const providers = await this.loadProviders();
        return providers.filter(p => p.app_password_required || !p.oauth_supported);
    }

    /**
     * Get custom provider option
     */
    async getCustomProvider() {
        const providers = await this.loadProviders();
        return providers.find(p => p.id === 'custom');
    }

    /**
     * Get provider by ID
     */
    async getProvider(providerId) {
        const providers = await this.loadProviders();
        return providers.find(p => p.id === providerId);
    }

    /**
     * Determine authentication method for provider
     */
    async getAuthMethod(providerId) {
        const provider = await this.getProvider(providerId);
        
        if (!provider) {
            return { method: 'unknown' };
        }

        if (provider.oauth_supported) {
            return { method: 'oauth', provider };
        }

        if (provider.app_password_required) {
            return { 
                method: 'app_password', 
                provider,
                passwordUrl: this._getAppPasswordUrl(providerId)
            };
        }

        if (provider.id === 'custom') {
            return { method: 'custom', provider };
        }

        return { method: 'password', provider };
    }

    /**
     * Get app password URL
     */
    _getAppPasswordUrl(providerId) {
        const urls = {
            icloud: 'https://appleid.apple.com/sign-in-with-apple/help',
            yahoo: 'https://login.yahoo.com/account/security',
            fastmail: 'https://www.fastmail.com/help/account/advanced-security.html'
        };
        return urls[providerId];
    }

    /**
     * Search providers
     */
    async searchProviders(query) {
        const providers = await this.loadProviders();
        const lowerQuery = query.toLowerCase();
        
        return providers.filter(p => 
            p.name.toLowerCase().includes(lowerQuery) ||
            p.provider.toLowerCase().includes(lowerQuery) ||
            p.description?.toLowerCase().includes(lowerQuery)
        );
    }
}

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        OAuthHandler,
        AppPasswordHandler,
        AccountSetupWizard,
        ProviderSelector,
        OAuthProvider,
        OAuthFlow
    };
} else if (typeof window !== 'undefined') {
    window.OAuthHandler = OAuthHandler;
    window.AppPasswordHandler = AppPasswordHandler;
    window.AccountSetupWizard = AccountSetupWizard;
    window.ProviderSelector = ProviderSelector;
    window.OAuthProvider = OAuthProvider;
    window.OAuthFlow = OAuthFlow;
}
