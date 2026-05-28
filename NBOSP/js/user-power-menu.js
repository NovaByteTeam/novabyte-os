/**
 * User/Power Menu
 * Handles Lock, Log Off, Restart, and Shut Down actions
 */

(function() {
    'use strict';

    const USER_MENU_BUTTON_ID = 'tray-user';
    const USER_MENU_ID = 'user-menu';

    let isMenuOpen = false;

    /**
     * Initialize the user menu
     */
    function init() {
        const btn = document.getElementById(USER_MENU_BUTTON_ID);
        const menu = document.getElementById(USER_MENU_ID);

        if (!btn || !menu) {
            console.error('[UserPowerMenu] Button or menu not found');
            return;
        }

        // Toggle menu on button click
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMenu();
        });

        // Handle menu item clicks
        menu.addEventListener('click', (e) => {
            const item = e.target.closest('.tray-menu-item');
            if (item) {
                const action = item.dataset.action;
                handleAction(action);
                closeMenu();
            }
        });

        // Handle keyboard navigation
        menu.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeMenu();
                btn.focus();
            }
        });

        // Close menu when clicking outside
        document.addEventListener('click', (e) => {
            if (isMenuOpen && !btn.contains(e.target) && !menu.contains(e.target)) {
                closeMenu();
            }
        });

        console.log('[UserPowerMenu] Initialized');
    }

    /**
     * Toggle menu visibility
     */
    function toggleMenu() {
        if (isMenuOpen) {
            closeMenu();
        } else {
            openMenu();
        }
    }

    /**
     * Open the menu
     */
    function openMenu() {
        const menu = document.getElementById(USER_MENU_ID);
        const btn = document.getElementById(USER_MENU_BUTTON_ID);
        
        if (menu && btn) {
            // GPO: Remove restricted items based on policies
            // Check if GPO settings exist and are enabled (not undefined/false/null)
            const removeShutdown = window.OS && window.OS.settings &&
                window.OS.settings.get('removeShutdown') === true;
            const removeLock = window.OS && window.OS.settings &&
                window.OS.settings.get('removeLock') === true;
            
            if (removeShutdown) {
                const shutdownItem = menu.querySelector('[data-action="shutdown"]');
                const restartItem = menu.querySelector('[data-action="restart"]');
                if (shutdownItem) shutdownItem.style.display = 'none';
                if (restartItem) restartItem.style.display = 'none';
            }
            if (removeLock) {
                const lockItem = menu.querySelector('[data-action="lock"]');
                if (lockItem) lockItem.style.display = 'none';
            }
            
            menu.classList.add('show');
            btn.setAttribute('aria-expanded', 'true');
            isMenuOpen = true;
            
            // Focus first item
            const firstItem = menu.querySelector('.tray-menu-item:not([style*="display: none"])');
            if (firstItem) firstItem.focus();
        }
    }

    /**
     * Close the menu
     */
    function closeMenu() {
        const menu = document.getElementById(USER_MENU_ID);
        const btn = document.getElementById(USER_MENU_BUTTON_ID);
        
        if (menu && btn) {
            menu.classList.remove('show');
            btn.setAttribute('aria-expanded', 'false');
            isMenuOpen = false;
            
            // Reset GPO-hidden items for next open
            const allItems = menu.querySelectorAll('.tray-menu-item');
            allItems.forEach(item => item.style.display = '');
        }
    }

    /**
     * Handle menu action
     */
    function handleAction(action) {
        console.log('[UserPowerMenu] Action:', action);

        switch (action) {
            case 'lock':
                lockScreen();
                break;
            case 'logout':
                logOff();
                break;
            case 'restart':
                restartSystem();
                break;
            case 'shutdown':
                shutDown();
                break;
            default:
                console.warn('[UserPowerMenu] Unknown action:', action);
        }
    }

    /**
     * Lock the screen
     * Shows lock screen overlay requiring PIN/password to unlock
     */
    function lockScreen() {
        console.log('[UserPowerMenu] Locking screen...');

        // Show lock screen
        const lockScreen = document.getElementById('lock-screen');
        if (lockScreen) {
            lockScreen.classList.add('active');
            if (OS) OS.isLocked = true;
            
            // Focus PIN input if exists
            const pinInput = document.getElementById('lock-pin');
            if (pinInput) {
                pinInput.value = '';
                pinInput.focus();
            }
        } else {
            // Fallback: just show a simple lock message
            alert('Screen locked. Refresh to unlock (implementation pending).');
        }
    }

    /**
     * Log off current user
     * Clears session, closes all apps, returns to login/start
     */
    function logOff() {
        console.log('[UserPowerMenu] Logging off...');
        
        if (!confirm('Log off? This will close all your apps and windows.')) {
            return;
        }

        // Close all windows
        if (WM) {
            const windows = Array.from(OS.windows.keys());
            for (const winId of windows) {
                WM.closeWindow(winId);
            }
        }

        // Reload to show login/start screen
        setTimeout(() => {
            window.location.reload();
        }, 500);
    }

    /**
     * Restart the system (browser tab)
     * Saves state and reloads
     */
    function restartSystem() {
        console.log('[UserPowerMenu] Restarting...');
        
        if (!confirm('Restart NovaByte? All apps will be closed.')) {
            return;
        }


        // Show restart message
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; inset: 0; background: rgba(0,0,0,0.9);
            display: flex; align-items: center; justify-content: center;
            z-index: 100000; color: white; font-size: 24px;
        `;
        overlay.textContent = 'Restarting...';
        document.body.appendChild(overlay);

        // Reload after brief delay
        setTimeout(() => {
            window.location.reload();
        }, 1000);
    }

    /**
     * Shut down (close everything)
     * Prompts for confirmation, then closes the tab
     */
    function shutDown() {
        console.log('[UserPowerMenu] Shutting down...');
        
        const confirmed = confirm(
            'Shut down NovaByte?\n\n' +
            'This will close the application.\n' +
            'You can reopen it by launching the app again.'
        );

        if (!confirmed) return;


        // Show shutdown message
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; inset: 0; background: #000;
            display: flex; align-items: center; justify-content: center;
            z-index: 100000; color: white; font-size: 24px;
        `;
        overlay.innerHTML = `
            <div style="text-align: center;">
                <div style="font-size: 48px; margin-bottom: 20px;">⏻</div>
                <div>Shutting down...</div>
                <div style="font-size: 14px; margin-top: 10px; opacity: 0.7;">You can close this tab</div>
            </div>
        `;
        document.body.appendChild(overlay);

        // Try to close the window (may be blocked by browser)
        setTimeout(() => {
            window.open('', '_self').close();
            // Fallback: just show message
            if (!window.closed) {
                overlay.innerHTML += '<div style="font-size: 12px; margin-top: 20px; opacity: 0.5;">Please close this tab manually</div>';
            }
        }, 1500);
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();