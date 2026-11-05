/**
 * App-Specific Session Handlers
 * Register save/restore functions for each app that needs state persistence
 */

(function() {
    'use strict';

    // Wait for SessionManager to be available
    function init() {
        if (!window.SessionManager) {
            console.error('[AppSessionHandlers] SessionManager not found');
            return;
        }

        // Register handlers for each app
        registerVaultHandler();
        registerQuillHandler();
        registerNovaMailHandler();
        registerSentinelHandler();
        registerHorizonHandler();
        registerPulseHandler();
        registerLuminaHandler();
        registerChronosHandler();
        registerLaunchpadHandler();
        registerNookHandler();

        console.log('[AppSessionHandlers] All handlers registered');
    }

    /**
     * Vault (File Manager) - remember current folder, selection, etc.
     */
    function registerVaultHandler() {
        SessionManager.registerAppHandlers('vault',
            // Save
            function() {
                try {
                    const state = {
                        currentFolder: FS.specialFolders.desktop,
                        selectedItems: [],
                        viewMode: 'grid' // or 'list'
                    };
                    // Could also save file tree state if needed
                    return state;
                } catch (e) {
                    console.error('[Vault] Save state error:', e);
                    return {};
                }
            },
            // Restore
            function(data) {
                try {
                    if (data.currentFolder && FS.files.has(data.currentFolder)) {
                        // Navigate to the saved folder
                        console.log('[Vault] Restoring to folder:', data.currentFolder);
                        // Vault would need to implement navigation
                    }
                } catch (e) {
                    console.error('[Vault] Restore state error:', e);
                }
            }
        );
    }

    /**
     * Quill (Text Editor) - save open documents, cursor positions, etc.
     */
    function registerQuillHandler() {
        SessionManager.registerAppHandlers('quill',
            // Save
            function() {
                try {
                    const docs = [];
                    // Find all Quill windows and collect their document state
                    for (const [winId, winState] of OS.windows) {
                        if (winState.appId === 'quill' && winState.quillEditor) {
                            docs.push({
                                windowId: winId,
                                content: winState.quillEditor.getText(),
                                cursor: winState.quillEditor.getSelection(),
                                fileId: winState.fileId
                            });
                        }
                    }
                    return { documents: docs };
                } catch (e) {
                    console.error('[Quill] Save state error:', e);
                    return { documents: [] };
                }
            },
            // Restore
            function(data) {
                try {
                    if (data.documents && Array.isArray(data.documents)) {
                        console.log('[Quill] Restoring', data.documents.length, 'documents');
                        // Quill will need to implement restoration
                        // For now, just log it
                    }
                } catch (e) {
                    console.error('[Quill] Restore state error:', e);
                }
            }
        );
    }

    /**
     * NovaMail (Email Client) - save open folders, selected emails, compose drafts
     */
    function registerNovaMailHandler() {
        SessionManager.registerAppHandlers('novamail',
            // Save
            function() {
                try {
                    const state = {
                        currentFolder: 'inbox',
                        selectedEmail: null,
                        openEmails: [],
                        draftEmails: []
                    };
                    return state;
                } catch (e) {
                    console.error('[NovaMail] Save state error:', e);
                    return {};
                }
            },
            // Restore
            function(data) {
                try {
                    console.log('[NovaMail] Restoring session state');
                    // NovaMail would implement its own restore logic
                } catch (e) {
                    console.error('[NovaMail] Restore state error:', e);
                }
            }
        );
    }

    /**
     * NovaSentinel (Security Dashboard) - save protection states, selected modules
     */
    function registerSentinelHandler() {
        SessionManager.registerAppHandlers('novasentinel',
            // Save
            function() {
                try {
                    // Get current protection states from the UI
                    const protections = {};
                    if (window.sentinelProtectionStates) {
                        protections.states = window.sentinelProtectionStates;
                    }
                    // Save selected modules view
                    protections.lastViewedCategory = 'all';
                    return protections;
                } catch (e) {
                    console.error('[NovaSentinel] Save state error:', e);
                    return {};
                }
            },
            // Restore
            function(data) {
                try {
                    if (data.states && typeof data.states === 'object') {
                        // Apply saved protection states
                        window.pendingSentinelRestore = data.states;
                        console.log('[NovaSentinel] Protection states queued for restore');
                    }
                } catch (e) {
                    console.error('[NovaSentinel] Restore state error:', e);
                }
            }
        );
    }

    /**
     * Horizon (Web Browser) - save open tabs, URLs, scroll positions
     */
    function registerHorizonHandler() {
        SessionManager.registerAppHandlers('horizon',
            // Save
            function() {
                try {
                    const tabs = [];
                    for (const [winId, winState] of OS.windows) {
                        if (winState.appId === 'horizon' && winState.tabs) {
                            tabs.push({
                                windowId: winId,
                                activeTab: winState.activeTab,
                                tabs: winState.tabs.map(tab => ({
                                    url: tab.url,
                                    title: tab.title,
                                    scrollPos: tab.scrollPos || 0
                                }))
                            });
                        }
                    }
                    return { windows: tabs };
                } catch (e) {
                    console.error('[Horizon] Save state error:', e);
                    return { windows: [] };
                }
            },
            // Restore
            function(data) {
                try {
                    if (data.windows) {
                        console.log('[Horizon] Restoring', data.windows.length, 'browser windows');
                        // Horizon will implement its own restore logic
                    }
                } catch (e) {
                    console.error('[Horizon] Restore state error:', e);
                }
            }
        );
    }

    /**
     * Pulse (Notifications) - no state to save really
     */
    function registerPulseHandler() {
        SessionManager.registerAppHandlers('pulse',
            function() { return {}; },
            function(data) { /* nothing to restore */ }
        );
    }

    /**
     * Lumina (PDF Viewer) - save current file, zoom, page
     */
    function registerLuminaHandler() {
        SessionManager.registerAppHandlers('lumina',
            function() {
                try {
                    const states = [];
                    for (const [winId, winState] of OS.windows) {
                        if (winState.appId === 'lumina') {
                            states.push({
                                windowId: winId,
                                pdfUrl: winState.pdfUrl,
                                pageNum: winState.pageNum || 1,
                                zoom: winState.zoom || 1
                            });
                        }
                    }
                    return { documents: states };
                } catch (e) {
                    console.error('[Lumina] Save state error:', e);
                    return { documents: [] };
                }
            },
            function(data) {
                try {
                    if (data.documents) {
                        console.log('[Lumina] Restoring', data.documents.length, 'PDFs');
                        // Lumina will implement restore
                    }
                } catch (e) {
                    console.error('[Lumina] Restore state error:', e);
                }
            }
        );
    }

    /**
     * ChronOS (Calendar/Clock) - no significant state
     */
    function registerChronosHandler() {
        SessionManager.registerAppHandlers('chronos',
            function() { return {}; },
            function(data) { /* nothing to restore */ }
        );
    }

    /**
     * Launchpad (App Launcher) - no state
     */
    function registerLaunchpadHandler() {
        SessionManager.registerAppHandlers('launchpad',
            function() { return {}; },
            function(data) { /* nothing to restore */ }
        );
    }

    /**
     * Nook (Settings) - settings are already persisted via OS.settings
     */
    function registerNookHandler() {
        SessionManager.registerAppHandlers('nook',
            function() { return {}; },
            function(data) { /* settings auto-load */ }
        );
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();