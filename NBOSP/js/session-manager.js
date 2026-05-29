/**
 * NovaByte OS - Session Manager
 * Auto-save and session restore system
 * Persists: open apps, window states, app data, and preferences
 */

(function() {
    'use strict';

    const SESSION_STORAGE_KEY = 'novabyte_session';
    const SESSION_METADATA_KEY = 'novabyte_session_meta';
    const AUTO_SAVE_INTERVAL = 30000; // 30 seconds
    const SESSION_VERSION = '1.0';

    // Session state
    let sessionId = null;
    let isCleanExit = false;
    let autoSaveTimer = null;
    let isRestoring = false;

    /**
     * Initialize session manager
     */
    function init() {
        console.log('[SessionManager] Initializing...');

        // Generate new session ID
        sessionId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).substr(2);
        isCleanExit = false;

        // Check for previous session
        const previousSession = getSessionMetadata();
        if (previousSession && !previousSession.cleanExit) {
            console.log('[SessionManager] Detected unclean previous session - showing recovery dialog');
            showRecoveryDialog(previousSession);
        } else if (previousSession) {
            // Clean exit - clear old session data
            clearOldSession();
        }

        // Set up auto-save
        startAutoSave();

        // Save session metadata on load
        saveSessionMetadata({ sessionId, cleanExit: false, timestamp: Date.now() });

        // Handle page unload
        window.addEventListener('beforeunload', handleUnload);
        window.addEventListener('unload', handleUnload);

        // Handle page show (visibility change)
        document.addEventListener('visibilitychange', handleVisibilityChange);

        console.log('[SessionManager] Initialized with session ID:', sessionId);
    }

    let _autoSaveInProgress = false;

    /**
     * Start auto-save timer
     */
    function startAutoSave() {
        if (autoSaveTimer) {
            clearInterval(autoSaveTimer);
        }
        autoSaveTimer = setInterval(performAutoSave, AUTO_SAVE_INTERVAL);
        console.log('[SessionManager] Auto-save started (every', AUTO_SAVE_INTERVAL/1000, 'seconds)');
    }

    /**
     * Stop auto-save timer
     */
    function stopAutoSave() {
        if (autoSaveTimer) {
            clearInterval(autoSaveTimer);
            autoSaveTimer = null;
        }
    }

    /**
     * Perform auto-save
     */
    async function performAutoSave() {
        if (isRestoring) {
            console.log('[SessionManager] Skipping auto-save during restore');
            return;
        }

        // Prevent overlapping auto-save runs
        if (_autoSaveInProgress) {
            return;
        }
        
        _autoSaveInProgress = true;

        try {
            const state = collectFullState();
            await saveSession(state);
            console.log('[SessionManager] Auto-save completed');
        } catch (error) {
            console.error('[SessionManager] Auto-save failed:', error);
        } finally {
            _autoSaveInProgress = false;
        }
    }

    /**
     * Collect complete application state
     */
    function collectFullState() {
        const state = {
            version: SESSION_VERSION,
            timestamp: Date.now(),
            sessionId: sessionId,
            apps: collectAppState(),
            preferences: collectPreferences(),
            system: collectSystemState()
        };
        return state;
    }

    /**
     * Check if we're in a valid browser environment with required globals
     */
    function isBrowserEnvironment() {
        return typeof window !== 'undefined' && 
               typeof document !== 'undefined' && 
               typeof navigator !== 'undefined' && 
               typeof getComputedStyle === 'function';
    }

    /**
     * Collect all open apps and their window states
     */
    function collectAppState() {
        const apps = new Map(); // Use Map to avoid duplicates

        // Check if OS is available (may not be during early init or server-side)
        if (!isBrowserEnvironment() || typeof OS === 'undefined' || !OS.windows) {
            return []; // Silently return empty array instead of warning
        }

        // Iterate through all open windows in OS.windows
        for (const [windowId, windowState] of OS.windows) {
            const appId = windowState.appId;
            const appConfig = OS.apps[appId];
            
            if (!appConfig) continue;

            // Get or create app entry
            if (!apps.has(appId)) {
                apps.set(appId, {
                    id: appId,
                    name: appConfig.name,
                    windows: [],
                    appData: collectAppData(appId) // Collect app data once per app
                });
            }

            // Collect this window's state
            const winState = {
                windowId: windowId,
                x: windowState.x,
                y: windowState.y,
                width: windowState.width,
                height: windowState.height,
                isMinimized: windowState.minimized || false,
                isMaximized: windowState.maximized || false,
                zIndex: parseInt(windowState.element?.style.zIndex) || windowState.zIndex || 100,
                options: windowState.options || {}
            };
            apps.get(appId).windows.push(winState);
        }

        return Array.from(apps.values());
    }

    /**
     * Collect app-specific data (to be overridden by apps)
     */
    function collectAppData(appId) {
        // Default: empty object
        // Apps can register custom save/restore handlers
        if (window[`collect${capitalize(appId)}State`]) {
            return window[`collect${capitalize(appId)}State`]();
        }
        return {};
    }

    /**
     * Collect user preferences
     */
    function collectPreferences() {
        // Check if we're in a browser environment with required globals
        if (!isBrowserEnvironment() || typeof OS === 'undefined') {
            return {}; // Silently return empty object instead of warning
        }

        const computedStyle = getComputedStyle(document.documentElement);

        return {
            theme: OS.theme || 'dark',
            fontSize: (typeof localStorage !== 'undefined' && localStorage.getItem('fontSize')) || 'medium',
            language: (typeof navigator !== 'undefined' && navigator.language) || 'en-US',
            timezone: (typeof Intl !== 'undefined' && Intl.DateTimeFormat?.()?.resolvedOptions?.()?.timeZone) || 'UTC',
            // Add more preferences as needed
        };
    }

    /**
     * Collect system state
     */
    function collectSystemState() {
        // Check if we're in a browser environment
        if (!isBrowserEnvironment()) {
            return {}; // Silently return empty object instead of warning
        }

        return {
            userAgent: navigator.userAgent || '',
            platform: navigator.platform || '',
            screenSize: {
                width: window.screen?.width || 0,
                height: window.screen?.height || 0
            },
            viewportSize: {
                width: window.innerWidth || 0,
                height: window.innerHeight || 0
            }
        };
    }

    /**
     * Save session to storage
     */
    async function saveSession(state) {
        try {
            // Check if localStorage is accessible (may be restricted in sandboxes)
            if (typeof localStorage === 'undefined' || !localStorage) {
                return; // Silently skip in sandboxed contexts
            }
            // Use IndexedDB for larger data if needed, otherwise localStorage
            const serialized = JSON.stringify(state);
            localStorage.setItem(SESSION_STORAGE_KEY, serialized);
        } catch (error) {
            // Handle both regular errors and SecurityError (sandbox restrictions)
            if (error.name === 'SecurityError' || error.message?.includes('Forbidden')) {
                // Silently skip in sandboxed contexts
                return;
            }
            console.error('[SessionManager] Save failed:', error);
            throw error;
        }
    }

    /**
     * Save session metadata (for crash detection)
     */
    function saveSessionMetadata(metadata) {
        try {
            if (typeof localStorage === 'undefined' || !localStorage) {
                return; // Silently skip
            }
            localStorage.setItem(SESSION_METADATA_KEY, JSON.stringify(metadata));
        } catch (error) {
            if (error.name === 'SecurityError' || error.message?.includes('Forbidden')) {
                return; // Silently skip
            }
            console.error('[SessionManager] Failed to save metadata:', error);
        }
    }

    /**
     * Get session metadata
     */
    function getSessionMetadata() {
        try {
            if (typeof localStorage === 'undefined' || !localStorage) {
                return null;
            }
            const data = localStorage.getItem(SESSION_METADATA_KEY);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            if (error.name === 'SecurityError' || error.message?.includes('Forbidden')) {
                return null; // Silently skip
            }
            return null;
        }
    }

    /**
     * Clear old session data
     */
    function clearOldSession() {
        try {
            if (typeof localStorage === 'undefined' || !localStorage) {
                return;
            }
            localStorage.removeItem(SESSION_STORAGE_KEY);
            localStorage.removeItem(SESSION_METADATA_KEY);
            console.log('[SessionManager] Cleared old session data');
        } catch (error) {
            if (error.name === 'SecurityError' || error.message?.includes('Forbidden')) {
                return; // Silently skip
            }
            console.error('[SessionManager] Failed to clear old session:', error);
        }
    }

    /**
     * Handle page unload
     */
    function handleUnload(event) {
        console.log('[SessionManager] Page unloading...');

        // Mark as clean exit
        isCleanExit = true;
        saveSessionMetadata({ sessionId, cleanExit: true, timestamp: Date.now() });

        // Perform final save
        try {
            const state = collectFullState();
            saveSession(state);
            console.log('[SessionManager] Final save completed');
        } catch (error) {
            console.error('[SessionManager] Final save failed:', error);
        }

        stopAutoSave();
    }

    /**
     * Handle visibility change (tab switch, minimize, etc.)
     */
    function handleVisibilityChange() {
        if (document.hidden) {
            // Page is being hidden - could save here too
        } else {
            // Page is visible again - could check for updates
        }
    }

    /**
     * Show recovery dialog
     */
    function showRecoveryDialog(previousSession) {
        isRestoring = true;

        const dialog = document.createElement('div');
        dialog.id = 'session-recovery-dialog';
        dialog.innerHTML = `
            <div class="recovery-overlay">
                <div class="recovery-modal">
                    <div class="recovery-icon">⚠️</div>
                    <h2>Recover Previous Session?</h2>
                    <p>NovaByte OS closed unexpectedly. Would you like to restore your previous session?</p>
                    <div class="recovery-info">
                        <span>Session from ${new Date(previousSession.timestamp).toLocaleString()}</span>
                        <span>${previousSession.sessionId.substring(0, 8)}...</span>
                    </div>
                    <div class="recovery-actions">
                        <button id="restore-session" class="btn-primary">Restore Session</button>
                        <button id="start-fresh" class="btn-secondary">Start Fresh</button>
                    </div>
                </div>
            </div>
        `;

        // Add styles if not already present
        if (!document.getElementById('recovery-styles')) {
            const styles = document.createElement('style');
            styles.id = 'recovery-styles';
            styles.textContent = `
                .recovery-overlay {
                    position: fixed;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background: rgba(0,0,0,0.85);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 100000;
                    backdrop-filter: blur(8px);
                }
                .recovery-modal {
                    background: var(--bg-elevated, #161b22);
                    border: 1px solid var(--border, rgba(88,166,255,.2));
                    border-radius: 16px;
                    padding: 32px;
                    max-width: 480px;
                    text-align: center;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
                }
                .recovery-icon {
                    font-size: 64px;
                    margin-bottom: 16px;
                }
                .recovery-modal h2 {
                    color: var(--text-primary, #e6edf3);
                    margin-bottom: 12px;
                    font-size: 24px;
                }
                .recovery-modal p {
                    color: var(--text-secondary, #8b949e);
                    margin-bottom: 16px;
                    line-height: 1.6;
                }
                .recovery-info {
                    background: var(--bg-sunken, #090d12);
                    padding: 12px;
                    border-radius: 8px;
                    margin-bottom: 24px;
                    font-size: 14px;
                    color: var(--text-secondary, #8b949e);
                }
                .recovery-info span {
                    display: block;
                    margin: 4px 0;
                }
                .recovery-actions {
                    display: flex;
                    gap: 12px;
                    justify-content: center;
                }
                .btn-primary, .btn-secondary {
                    padding: 12px 24px;
                    border-radius: 8px;
                    border: none;
                    font-size: 16px;
                    cursor: pointer;
                    transition: all 0.2s;
                }
                .btn-primary {
                    background: var(--accent, #58a6ff);
                    color: white;
                }
                .btn-primary:hover {
                    background: var(--accent2, #3d8ee8);
                }
                .btn-secondary {
                    background: var(--bg-overlay, #21262d);
                    color: var(--text-primary, #e6edf3);
                    border: 1px solid var(--border, rgba(88,166,255,.2));
                }
                .btn-secondary:hover {
                    background: var(--bg-sunken, #090d12);
                }
            `;
            document.head.appendChild(styles);
        }

        document.body.appendChild(dialog);

        // Event listeners
        document.getElementById('restore-session').addEventListener('click', () => {
            restorePreviousSession();
            dialog.remove();
        });

        document.getElementById('start-fresh').addEventListener('click', () => {
            clearOldSession();
            dialog.remove();
            isRestoring = false;
        });

        // ESC key to start fresh
        dialog.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                clearOldSession();
                dialog.remove();
                isRestoring = false;
            }
        });
    }

    /**
     * Restore previous session
     */
    async function restorePreviousSession() {
        console.log('[SessionManager] Restoring previous session...');

        try {
            const savedState = localStorage.getItem(SESSION_STORAGE_KEY);
            if (!savedState) {
                throw new Error('No saved session found');
            }

            const state = JSON.parse(savedState);
            isRestoring = true;

            // Restore in order
            await restorePreferences(state.preferences);
            await restoreApps(state.apps);

            // Mark as clean exit after successful restore
            saveSessionMetadata({ sessionId, cleanExit: true, timestamp: Date.now() });

            isRestoring = false;
            console.log('[SessionManager] Session restored successfully');
        } catch (error) {
            console.error('[SessionManager] Restore failed:', error);
            alert('Failed to restore session. Starting fresh.');
            clearOldSession();
            isRestoring = false;
        }
    }

    /**
     * Restore preferences
     */
    function restorePreferences(preferences) {
        return new Promise((resolve) => {
            if (preferences.theme && typeof OS !== 'undefined' && typeof OS.setTheme === 'function') {
                OS.setTheme(preferences.theme);
            }
            if (preferences.fontSize && typeof localStorage !== 'undefined') {
                localStorage.setItem('fontSize', preferences.fontSize);
            }
            resolve();
        });
    }

    /**
     * Restore apps and windows
     */
    async function restoreApps(apps) {
        console.log('[SessionManager] Restoring', apps.length, 'apps with multiple windows');

        // Check if OS and WM are available
        if (typeof OS === 'undefined' || !OS.apps || typeof WM === 'undefined') {
            console.warn('[SessionManager] OS or WindowManager not available for app restoration');
            return;
        }

        for (const appState of apps) {
            try {
                // Check if app exists
                if (!OS.apps[appState.id]) {
                    console.warn('[SessionManager] App not found:', appState.id);
                    continue;
                }

                // Restore each window for this app
                for (const winState of appState.windows) {
                    // Launch app with specific window options
                    const window = WM.createWindow(appState.id, {
                        x: winState.x,
                        y: winState.y,
                        width: winState.width,
                        height: winState.height
                    });

                    if (window) {
                        // Apply additional state after creation
                        setTimeout(() => {
                            if (typeof window !== 'undefined' && window.element) {
                                window.element.style.zIndex = winState.zIndex;
                            }
                            if (winState.isMinimized && typeof WM !== 'undefined' && typeof WM.minimizeWindow === 'function') {
                                WM.minimizeWindow(window.id);
                            }
                            if (winState.isMaximized && typeof WM !== 'undefined' && typeof WM.toggleMaximize === 'function') {
                                WM.toggleMaximize(window.id);
                            }
                        }, 50);
                    }
                }

                // Restore app-specific data (once per app)
                setTimeout(() => {
                    restoreAppData(appState);
                }, 100);

            } catch (error) {
                console.error('[SessionManager] Failed to restore app:', appState.id, error);
            }
        }
    }

    /**
     * Restore window position and size
     */

    /**
     * Restore app-specific data
     */
    function restoreAppData(appState) {
        if (window[`restore${capitalize(appState.id)}State`]) {
            try {
                window[`restore${capitalize(appState.id)}State`](appState.appData);
            } catch (error) {
                console.error('[SessionManager] Failed to restore app data:', appState.id, error);
            }
        }
    }

    /**
     * Register app-specific save/restore handlers
     */
    function registerAppHandlers(appId, saveHandler, restoreHandler) {
        if (saveHandler) {
            window[`collect${capitalize(appId)}State`] = saveHandler;
        }
        if (restoreHandler) {
            window[`restore${capitalize(appId)}State`] = restoreHandler;
        }
    }

    /**
     * Utility: Capitalize string
     */
    function capitalize(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    /**
     * Force immediate save
     */
    function forceSaveNow() {
        return performAutoSave();
    }

    /**
     * Get session info (for debugging)
     */
    function getSessionInfo() {
        return {
            sessionId: sessionId,
            isRestoring: isRestoring,
            autoSaveInterval: AUTO_SAVE_INTERVAL,
            hasSavedData: !!localStorage.getItem(SESSION_STORAGE_KEY),
            metadata: getSessionMetadata()
        };
    }

    // Expose public API (browser only)
    if (typeof window !== 'undefined') {
        window.SessionManager = {
            init: init,
            forceSave: forceSaveNow,
            registerAppHandlers: registerAppHandlers,
            getInfo: getSessionInfo,
            clearSession: clearOldSession
        };
    }

    // Auto-initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();