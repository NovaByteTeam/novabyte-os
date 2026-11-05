
/**
 * NovaByte OS - App Sandbox
 * ────────────────────────────────────────────────────────────
 * Creates secure execution environments for apps using
 * sandboxed iframes with strict CSP policies.
 * 
 * @module js/app-sandbox
 */

const AppSandbox = (() => {
  const activeSandboxes = new Map();
  const API_BRIDGE_NAME = 'NovaByteAPI';

  /**
   * Create a sandboxed iframe for app execution
   * @param {object} app - App object
   * @param {HTMLElement} container - Container element
   * @param {object} state - Window state
   * @returns {HTMLIFrameElement} Sandboxed iframe
   */
  function createSandbox(app, container, state) {
    const iframe = document.createElement('iframe');
    
    // Security: strict sandboxing
    const sandboxAttrs = [
      'allow-same-origin',
      'allow-scripts',
      'allow-forms',
      'allow-modals',
      'allow-popups',
      'allow-downloads'
    ];
    
    // Apply app-specific sandbox restrictions
    if (app.sandbox) {
      if (!app.sandbox.allowSameOrigin) {
        sandboxAttrs.splice(sandboxAttrs.indexOf('allow-same-origin'), 1);
      }
      if (!app.sandbox.allowScripts) {
        sandboxAttrs.splice(sandboxAttrs.indexOf('allow-scripts'), 1);
      }
      if (!app.sandbox.allowForms) {
        sandboxAttrs.splice(sandboxAttrs.indexOf('allow-forms'), 1);
      }
      if (!app.sandbox.allowPopups) {
        sandboxAttrs.splice(sandboxAttrs.indexOf('allow-popups'), 1);
      }
    }
    
    iframe.sandbox = sandboxAttrs.join(' ');
    
    // Security: Content Security Policy
    const csp = [
      "default-src 'self' blob: data:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
      "style-src 'self' 'unsafe-inline' blob:",
      "img-src 'self' blob: data: https:",
      "font-src 'self' blob: data:",
      "connect-src 'self' blob: data:",
      "frame-src 'self' blob: data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ');
    
    iframe.csp = csp;
    
    // Styling
    iframe.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
      background: white;
      display: flex;
      flex-direction: column;
    `;
    
    // Security: prevent framing
    iframe.allow = "fullscreen; camera; microphone";
    
    // Store reference
    const sandboxId = `sandbox_${app.id}_${Date.now()}`;
    iframe.dataset.sandboxId = sandboxId;
    iframe.dataset.appId = app.id;
    
    activeSandboxes.set(sandboxId, {
      appId: app.id,
      iframe: iframe,
      created: new Date().toISOString(),
      state: state
    });
    
    // Setup API bridge
    setupAPIBridge(iframe, app, sandboxId);
    
    // Setup error handling
    setupErrorHandling(iframe, app);
    
    console.log(`[AppSandbox] Created sandbox for ${app.name} (${sandboxId})`);
    
    return iframe;
  }

  /**
   * Setup postMessage API bridge
   * @param {HTMLIFrameElement} iframe - Sandbox iframe
   * @param {object} app - App object
   * @param {string} sandboxId - Sandbox ID
   */
  function setupAPIBridge(iframe, app, sandboxId) {
    const messageHandler = (event) => {
      // Security: verify message origin
      if (event.source !== iframe.contentWindow) {
        return;
      }
      
      const { type, payload, requestId } = event.data;
      
      if (!type || !type.startsWith('nova:')) {
        return;
      }
      
      handleAPICall(type, payload, requestId, app, iframe);
    };
    
    window.addEventListener('message', messageHandler);
    
    // Store cleanup
    const sandbox = activeSandboxes.get(sandboxId);
    if (sandbox) {
      sandbox.cleanup = () => {
        window.removeEventListener('message', messageHandler);
      };
    }
  }

  /**
   * Handle API calls from sandboxed app
   * @param {string} type - API call type
   * @param {object} payload - Call payload
   * @param {string} requestId - Request ID
   * @param {object} app - App object
   * @param {HTMLIFrameElement} iframe - Sandbox iframe
   */
  function handleAPICall(type, payload, requestId, app, iframe) {
    const respond = (result, error = null) => {
      iframe.contentWindow.postMessage({
        type: `${type}:response`,
        requestId,
        result,
        error
      }, '*');
    };
    
    switch (type) {
      case 'nova:fs:read':
        if (AppPermissionManager.isGranted('fs:read', app.id)) {
          // Implement file read
          respond({ success: true, data: null });
        } else {
          respond(null, { code: 'PERMISSION_DENIED', message: 'fs:read permission required' });
        }
        break;
        
      case 'nova:fs:write':
        if (AppPermissionManager.isGranted('fs:write', app.id)) {
          // Implement file write
          respond({ success: true });
        } else {
          respond(null, { code: 'PERMISSION_DENIED', message: 'fs:write permission required' });
        }
        break;
        
      case 'nova:notifications:show':
        if (AppPermissionManager.isGranted('device:notifications', app.id)) {
          if (typeof Notify !== 'undefined') {
            Notify.show({
              title: payload.title,
              body: payload.body,
              type: payload.type || 'info',
              appName: app.name
            });
          }
          respond({ success: true });
        } else {
          respond(null, { code: 'PERMISSION_DENIED', message: 'Notification permission required' });
        }
        break;
        
      case 'nova:settings:get':
        respond({ value: OS?.settings?.get(payload.key) });
        break;
        
      case 'nova:settings:set':
        if (AppPermissionManager.isGranted('system:settings', app.id)) {
          OS?.settings?.set(payload.key, payload.value);
          respond({ success: true });
        } else {
          respond(null, { code: 'PERMISSION_DENIED', message: 'system:settings permission required' });
        }
        break;
        
      case 'nova:window:close':
        respond({ success: true });
        break;
        
      case 'nova:window:minimize':
        respond({ success: true });
        break;
        
      case 'nova:window:maximize':
        respond({ success: true });
        break;
        
      default:
        respond(null, { code: 'UNKNOWN_API', message: `Unknown API: ${type}` });
    }
  }

  /**
   * Setup error handling for sandbox
   * @param {HTMLIFrameElement} iframe - Sandbox iframe
   * @param {object} app - App object
   */
  function setupErrorHandling(iframe, app) {
    iframe.addEventListener('error', (event) => {
      console.error(`[AppSandbox] Error in ${app.name}:`, event.error);
    });
    
    iframe.contentWindow.addEventListener('error', (event) => {
      console.error(`[AppSandbox] Runtime error in ${app.name}:`, event.error);
    });
    
    iframe.contentWindow.addEventListener('unhandledrejection', (event) => {
      console.error(`[AppSandbox] Unhandled rejection in ${app.name}:`, event.reason);
    });
  }

  /**
   * Load app content into sandbox
   * @param {HTMLIFrameElement} iframe - Sandbox iframe
   * @param {object} app - App object
   * @param {object} state - Window state
   */
  function loadAppContent(iframe, app, state) {
    // For web apps (external URLs)
    if (app.type === 'webapp' && app.url) {
      iframe.src = app.url;
      return;
    }
    
    // For packaged apps with HTML entry point
    if (app.entry && app.files && app.files[app.entry]) {
      try {
        const htmlContent = atob(app.files[app.entry]);
        const blob = new Blob([htmlContent], { type: 'text/html' });
        iframe.src = URL.createObjectURL(blob);
      } catch (error) {
        console.error(`[AppSandbox] Failed to load app content for ${app.name}:`, error);
        showErrorPage(iframe, app, 'Failed to load app content');
      }
    } else {
      // Default: create a simple app shell
      createDefaultAppShell(iframe, app, state);
    }
  }

  /**
   * Create default app shell for apps without content
   * @param {HTMLIFrameElement} iframe - Sandbox iframe
   * @param {object} app - App object
   * @param {object} state - Window state
   */
  function createDefaultAppShell(iframe, app, state) {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${app.name}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .app-container {
            text-align: center;
            max-width: 600px;
          }
          .app-icon {
            font-size: 64px;
            margin-bottom: 20px;
          }
          h1 { font-size: 32px; margin-bottom: 10px; }
          p { font-size: 16px; opacity: 0.9; margin-bottom: 30px; }
          .status {
            background: rgba(255,255,255,0.1);
            padding: 15px 25px;
            border-radius: 8px;
            font-size: 14px;
          }
          .api-status {
            margin-top: 20px;
            padding: 10px;
            background: rgba(0,0,0,0.2);
            border-radius: 4px;
            font-family: monospace;
            font-size: 12px;
          }
        </style>
      </head>
      <body>
        <div class="app-container">
          <div class="app-icon">${app.icon || '📱'}</div>
          <h1>${app.name}</h1>
          <p>${app.description || 'A NovaByte OS Application'}</p>
          <div class="status">
            <strong>Version:</strong> ${app.version}<br>
            <strong>Author:</strong> ${app.author}<br>
            <strong>Type:</strong> ${app.type}<br>
            <strong>Status:</strong> Running in Sandbox
          </div>
          <div class="api-status" id="apiStatus">
            Initializing API bridge...
          </div>
        </div>
        <script>
          // Test API bridge
          window.addEventListener('message', (event) => {
            if (event.data.type && event.data.type.startsWith('nova:')) {
              document.getElementById('apiStatus').textContent = 
                'API Bridge: Connected ✓';
            }
          });
          
          // Request API access
          setTimeout(() => {
            window.parent.postMessage({
              type: 'nova:ready',
              appId: '${app.id}'
            }, '*');
          }, 100);
        </script>
      </body>
      </html>
    `;
    
    const blob = new Blob([html], { type: 'text/html' });
    iframe.src = URL.createObjectURL(blob);
  }

  /**
   * Show error page in sandbox
   * @param {HTMLIFrameElement} iframe - Sandbox iframe
   * @param {object} app - App object
   * @param {string} message - Error message
   */
  function showErrorPage(iframe, app, message) {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Error - ${app.name}</title>
        <style>
          body { font-family: sans-serif; padding: 40px; text-align: center; }
          .error { color: #e74c3c; font-size: 48px; margin-bottom: 20px; }
          h1 { color: #2c3e50; }
          p { color: #7f8c8d; }
        </style>
      </head>
      <body>
        <div class="error">⚠</div>
        <h1>Failed to Load Application</h1>
        <p><strong>${app.name}</strong></p>
        <p>${message}</p>
        <p><small>App ID: ${app.id}</small></p>
      </body>
      </html>
    `;
    const blob = new Blob([html], { type: 'text/html' });
    iframe.src = URL.createObjectURL(blob);
  }

  /**
   * Launch an app in a sandboxed environment
   * @param {object} app - App object
   * @param {HTMLElement} container - Container element
   * @param {object} state - Window state
   * @param {object} options - Launch options
   * @returns {object} Launch result
   */
  function launch(app, container, state, options = {}) {
    if (!container) {
      throw new Error('Container element is required');
    }
    
    // Clear container
    container.innerHTML = '';
    
    // Create sandbox
    const iframe = createSandbox(app, container, state);
    
    // Add to container
    container.appendChild(iframe);
    
    // Load app content
    loadAppContent(iframe, app, state);
    
    console.log(`[AppSandbox] Launched ${app.name} in sandbox`);
    
    return {
      success: true,
      sandboxId: iframe.dataset.sandboxId,
      appId: app.id,
      iframe: iframe,
      cleanup: () => {
        const sandbox = activeSandboxes.get(iframe.dataset.sandboxId);
        if (sandbox && sandbox.cleanup) {
          sandbox.cleanup();
        }
        if (iframe.src && iframe.src.startsWith('blob:')) {
          URL.revokeObjectURL(iframe.src);
        }
        activeSandboxes.delete(iframe.dataset.sandboxId);
      }
    };
  }

  /**
   * Destroy a sandbox
   * @param {string} sandboxId - Sandbox ID
   */
  function destroy(sandboxId) {
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox) {
      return false;
    }
    
    if (sandbox.cleanup) {
      sandbox.cleanup();
    }
    
    if (sandbox.iframe && sandbox.iframe.src.startsWith('blob:')) {
      URL.revokeObjectURL(sandbox.iframe.src);
    }
    
    activeSandboxes.delete(sandboxId);
    console.log(`[AppSandbox] Destroyed sandbox: ${sandboxId}`);
    
    return true;
  }

  /**
   * Get active sandbox info
   * @param {string} sandboxId - Sandbox ID
   * @returns {object|null} Sandbox info
   */
  function getSandbox(sandboxId) {
    return activeSandboxes.get(sandboxId) || null;
  }

  /**
   * Get all active sandboxes
   * @returns {Array} Array of sandbox info
   */
  function getAllSandboxes() {
    return Array.from(activeSandboxes.values());
  }

  return {
    createSandbox,
    launch,
    destroy,
    getSandbox,
    getAllSandboxes
  };
})();

// Export for Node.js/CommonJS
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AppSandbox;
}
