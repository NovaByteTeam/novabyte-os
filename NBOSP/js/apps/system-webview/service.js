/* NovaByte System Webview host */
(() => {
  'use strict';

  const sandboxStates = new Map();
  const WEBVIEW_EVENTS = [
    'loadstart', 'loadredirect', 'loadcommit', 'loadstop', 'contentload',
    'loadabort', 'loaderror', 'close', 'crashed', 'exit', 'did-fail-load',
    'enter-html-full-screen', 'leave-html-full-screen', 'unresponsive',
    'responsive', 'permissionrequest', 'consolemessage',
  ];

  function getSandboxState(sandbox, appId) {
    let state = sandboxStates.get(sandbox);
    if (!state) {
      state = {
        appId,
        views: new Map(),
        pendingPopups: new Map(),
      };
      sandboxStates.set(sandbox, state);
    }
    return state;
  }

  function reportFailure(callbacks, webview, requestId, error) {
    console.error('[SystemWebview] Webview operation failed:', error);
    return callbacks.respondError(
      webview,
      'nova:nested-webview',
      requestId,
      'INTERNAL_ERROR',
      error?.message || 'Webview operation failed'
    );
  }

  async function handleRequest(context) {
    const {
      payload, requestId, app, webview, sandbox,
      callbacks,
    } = context;
    const { respond, respondError, generateRequestId, log, canNavigate, setupPermissionRequestGate } = callbacks;
    if (!sandbox || typeof sandbox !== 'object') {
      return respondError(webview, 'nova:nested-webview', requestId, 'UNAVAILABLE', 'App window is unavailable');
    }
    const id = payload?.id;
    if (typeof id !== 'string' || !/^nvw_[a-zA-Z0-9_-]{1,80}$/.test(id)) {
      return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid nested webview id');
    }

    const state = getSandboxState(sandbox, app.id);
    const action = payload?.action;
    let entry = state.views.get(id);

    if (action === 'discard-popup') {
      const pending = state.pendingPopups.get(payload.popupId);
      if (!pending) return respondError(webview, 'nova:nested-webview', requestId, 'NOT_FOUND', 'Popup request has expired');
      state.pendingPopups.delete(payload.popupId);
      pending.discard();
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }
    if (action === 'attach-popup') {
      const pending = state.pendingPopups.get(payload.popupId);
      if (!pending || !entry) return respondError(webview, 'nova:nested-webview', requestId, 'NOT_FOUND', 'Popup request or nested webview does not exist');
      state.pendingPopups.delete(payload.popupId);
      pending.attach(entry.view);
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }

    if (action === 'create') {
      if (entry) return respond(webview, 'nova:nested-webview', requestId, { success: true });
      const parent = sandbox.state?.content;
      if (!parent?.isConnected) {
        return respondError(webview, 'nova:nested-webview', requestId, 'UNAVAILABLE', 'App window is unavailable');
      }

      const attrs = payload.attributes && typeof payload.attributes === 'object' ? payload.attributes : {};
      if (typeof attrs.src === 'string' && attrs.src && !canNavigate(attrs.src)) {
        return respondError(webview, 'nova:nested-webview', requestId, 'PERMISSION_DENIED', 'The app needs the matching network permission to navigate this webview');
      }
      const child = document.createElement('webview');
      child.setAttribute('nodeintegration', 'false');
      child.setAttribute('nodeintegrationsubframes', 'false');
      child.setAttribute('enableremotemodule', 'false');
      child.setAttribute('partition', `persist:app_${app.id}_webcontent`);
      child.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;border:0;display:none;z-index:1;';
      const contextMenuMarker = app.id === 'com.nbosp.browser'
        ? `__NOVA_BROWSER_CONTEXT_MENU__:${generateRequestId()}:`
        : null;
      const contextMenuScript = `(() => {
        if (window.__novaContextMenuBridgeInstalled) return;
        window.__novaContextMenuBridgeInstalled = true;
        const marker = ${JSON.stringify(contextMenuMarker)};
        document.addEventListener('contextmenu', event => {
          event.preventDefault();
          const element = event.target;
          const link = element?.closest?.('a');
          const image = element?.tagName === 'IMG' ? element : element?.closest?.('img');
          const selection = window.getSelection?.().toString().trim() || '';
          const payload = {
            clientX: event.clientX,
            clientY: event.clientY,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            linkUrl: link?.href || '',
            linkText: (link?.textContent || '').trim().slice(0, 120),
            imageUrl: image?.src || '',
            imageAlt: image?.alt || '',
            selectedText: selection.slice(0, 500),
            pageUrl: location.href,
            pageTitle: document.title,
          };
          try { console.log(marker + JSON.stringify(payload)); } catch (_) {}
        }, true);
      })();`;

      if (app.id === 'com.nbosp.browser' && typeof child.addContentScripts === 'function') {
        try {
          child.addContentScripts([{
            name: `nova-browser-scrollbar-guard-${id}`,
            matches: ['<all_urls>'],
            js: { code: `(() => {
              const css = 'html,body,*{scrollbar-width:none!important;-ms-overflow-style:none!important}' +
                '*::-webkit-scrollbar,*::-webkit-scrollbar-thumb,*::-webkit-scrollbar-track,*::-webkit-scrollbar-corner{' +
                'display:none!important;width:0!important;height:0!important;min-width:0!important;min-height:0!important}';
              const install = () => {
                const root = document.documentElement;
                if (!root) return false;
                let style = root.querySelector('style[data-nbosp-scrollbar-guard]');
                if (!style) {
                  style = document.createElement('style');
                  style.setAttribute('data-nbosp-scrollbar-guard', '');
                  style.textContent = css;
                  (root.head || root).appendChild(style);
                }
                return true;
              };
              if (!install()) {
                const observer = new MutationObserver(() => {
                  if (install()) observer.disconnect();
                });
                observer.observe(document, { childList: true, subtree: true });
              }
            })();` },
            run_at: 'document_start',
            all_frames: false,
          }]);
        } catch (error) {
          log('warn', 'Browser early scrollbar guard registration failed:', error);
        }
      }

      const cleanups = [];
      const sendEvent = (name, event) => {
        const result = { proxyId: id, eventName: name };
        for (const key of ['url', 'isTopLevel', 'reason', 'errorCode', 'errorDescription', 'validatedURL', 'targetUrl', 'disposition', 'windowOpenDisposition', 'initialWidth', 'initialHeight', 'message', 'permission']) {
          if (event?.[key] !== undefined) result[key] = event[key];
        }
        if (event?.request?.url) result.request = { url: event.request.url };
        if (event?.__novaPopupId) result.popupId = event.__novaPopupId;
        respond(webview, 'nova:nested-webview:event', id, result);
      };
      for (const name of WEBVIEW_EVENTS) {
        const listener = event => {
          if (name === 'loadstop' && contextMenuMarker) {
            try {
              child.executeScript({ code: contextMenuScript }, results => {
                if (Array.isArray(results) && results[0] === false) {
                  log('warn', `Could not install nested browser context menu bridge for ${app?.id || 'app'}`);
                }
              });
            } catch (error) {
              log('warn', 'Could not install nested browser context menu bridge', error);
            }
          }
          if (name === 'consolemessage' && typeof event?.message === 'string' && event.message.startsWith(contextMenuMarker)) {
            let contextData;
            try { contextData = JSON.parse(event.message.slice(contextMenuMarker.length)); }
            catch (error) {
              log('warn', 'Ignored malformed nested browser context menu event', error);
              return;
            }
            if (!Number.isFinite(contextData?.clientX) || !Number.isFinite(contextData?.clientY)
              || !Number.isFinite(contextData?.viewportWidth) || !Number.isFinite(contextData?.viewportHeight)) return;
            const bounded = value => typeof value === 'string' ? value.slice(0, 2000) : '';
            sendEvent('contextmenu', {
              clientX: contextData.clientX,
              clientY: contextData.clientY,
              viewportWidth: contextData.viewportWidth,
              viewportHeight: contextData.viewportHeight,
              linkUrl: bounded(contextData.linkUrl),
              linkText: bounded(contextData.linkText),
              imageUrl: bounded(contextData.imageUrl),
              imageAlt: bounded(contextData.imageAlt),
              selectedText: bounded(contextData.selectedText),
              pageUrl: bounded(contextData.pageUrl),
              pageTitle: bounded(contextData.pageTitle),
            });
            return;
          }
          sendEvent(name, event);
        };
        child.addEventListener(name, listener);
        cleanups.push(() => child.removeEventListener(name, listener));
      }
      const newWindowListener = event => {
        event.preventDefault();
        const popupId = generateRequestId();
        state.pendingPopups.set(popupId, event.window);
        event.__novaPopupId = popupId;
        setTimeout(() => {
          const pending = state.pendingPopups.get(popupId);
          if (!pending) return;
          state.pendingPopups.delete(popupId);
          try { pending.discard(); } catch (error) { log('warn', 'Pending popup cleanup failed', error); }
        }, 30000);
        sendEvent('newwindow', event);
      };
      child.addEventListener('newwindow', newWindowListener);
      cleanups.push(() => child.removeEventListener('newwindow', newWindowListener));
      const navigationListener = event => {
        if (event?.isTopLevel === false) return;
        const destination = event?.url || event?.targetUrl || event?.validatedURL;
        if (typeof destination === 'string' && !canNavigate(destination)) {
          event.preventDefault?.();
          sendEvent('navigation-blocked', { url: destination, reason: 'Network permission required' });
        }
      };
      child.addEventListener('will-navigate', navigationListener);
      cleanups.push(() => child.removeEventListener('will-navigate', navigationListener));
      cleanups.push(setupPermissionRequestGate(child));
      parent.style.position ||= 'relative';
      entry = { view: child, cleanups };
      state.views.set(id, entry);
      parent.appendChild(child);

      for (const name of ['allowfullscreen', 'allowpopups']) {
        if (typeof attrs[name] === 'string') child.setAttribute(name, attrs[name]);
      }
      if (typeof attrs.src === 'string' && attrs.src) child.src = attrs.src;
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }

    if (!entry) {
      return respondError(webview, 'nova:nested-webview', requestId, 'NOT_FOUND', 'Nested webview does not exist');
    }
    const child = entry.view;

    if (action === 'destroy') {
      destroyView(state, id, entry, log);
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }

    if (action === 'bounds') {
      const bounds = payload.bounds || {};
      const requested = [bounds.left, bounds.top, bounds.width, bounds.height].map(Number);
      if (!requested.every(Number.isFinite) || requested[2] < 0 || requested[3] < 0) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid nested webview bounds');
      }
      const [requestedLeft, requestedTop, requestedWidth, requestedHeight] = requested;
      const parent = sandbox.state?.content;
      const maxWidth = Math.max(0, parent?.clientWidth || 0);
      const maxHeight = Math.max(0, parent?.clientHeight || 0);
      const left = Math.max(0, Math.min(maxWidth, requestedLeft));
      const top = Math.max(0, Math.min(maxHeight, requestedTop));
      const width = Math.min(requestedWidth, maxWidth - left);
      const height = Math.min(requestedHeight, maxHeight - top);
      const visible = bounds.visible === true && width > 0 && height > 0;
      child.style.left = `${left}px`;
      child.style.top = `${top}px`;
      child.style.width = `${width}px`;
      child.style.height = `${height}px`;
      child.style.display = visible ? 'flex' : 'none';
      child.style.visibility = bounds.visibility === 'hidden' ? 'hidden' : 'visible';
      child.style.pointerEvents = bounds.pointerEvents === 'none' ? 'none' : 'auto';
      child.style.zIndex = String(Math.max(0, Math.min(100, Number(bounds.zIndex) || 1)));
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }

    if (action === 'attribute') {
      const name = payload.name;
      if (!['allowfullscreen', 'allowpopups', 'src'].includes(name)) {
        return respondError(webview, 'nova:nested-webview', requestId, 'PERMISSION_DENIED', 'Attribute is not available on nested webviews');
      }
      if (name === 'src' && payload.remove !== true
        && (typeof payload.value !== 'string' || !canNavigate(payload.value))) {
        return respondError(webview, 'nova:nested-webview', requestId, 'PERMISSION_DENIED', 'The app needs the matching network permission to navigate this webview');
      }
      if (payload.remove === true) child.removeAttribute(name);
      else if (typeof payload.value === 'string') child.setAttribute(name, payload.value);
      if (name === 'src' && payload.remove !== true && typeof payload.value === 'string') child.src = payload.value;
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    }

    if (action !== 'command') {
      return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Unsupported nested webview operation');
    }
    const command = payload.command;
    if (command === 'reload') child.reload();
    else if (command === 'back') child.back();
    else if (command === 'forward') child.forward();
    else if (command === 'stop') child.stop();
    else if (command === 'canGoBack' || command === 'canGoForward') {
      const method = child[command];
      if (typeof method !== 'function') {
        return respondError(webview, 'nova:nested-webview', requestId, 'UNAVAILABLE', `${command} is not supported by this webview`);
      }
      return respond(webview, 'nova:nested-webview', requestId, { value: Boolean(method.call(child)) });
    } else if (command === 'find') {
      const query = payload.query;
      const options = payload.options && typeof payload.options === 'object' ? payload.options : {};
      if (typeof query !== 'string' || !query.trim() || query.length > 1000
        || Object.keys(options).some(key => !['backward', 'matchCase', 'wordStart', 'medialCapitalAsWordStart'].includes(key))
        || Object.values(options).some(value => typeof value !== 'boolean')) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid page-find query or options');
      }
      if (typeof child.find !== 'function') {
        return respondError(webview, 'nova:nested-webview', requestId, 'UNAVAILABLE', 'Page find is not supported by this webview');
      }
      const result = await new Promise((resolve, reject) => {
        try { child.find(query, options, resolve); } catch (error) { reject(error); }
      });
      return respond(webview, 'nova:nested-webview', requestId, result);
    } else if (command === 'stopFinding') {
      const value = payload.value || 'clear';
      if (!['clear', 'keep', 'activate'].includes(value)) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid stop-finding action');
      }
      if (typeof child.stopFinding !== 'function') {
        return respondError(webview, 'nova:nested-webview', requestId, 'UNAVAILABLE', 'Page find is not supported by this webview');
      }
      child.stopFinding(value);
    } else if (command === 'setUserAgentOverride') {
      const userAgent = payload.value;
      if (typeof userAgent !== 'string' || userAgent.length > 512) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid user-agent string');
      }
      if (typeof child.setUserAgentOverride !== 'function') {
        return respondError(webview, 'nova:nested-webview', requestId, 'UNAVAILABLE', 'User-agent overrides are not supported by this webview');
      }
      child.setUserAgentOverride(userAgent);
    } else if (command === 'setZoom') {
      const zoom = Number(payload.value);
      if (!Number.isFinite(zoom) || zoom < 0.25 || zoom > 5) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid zoom factor');
      }
      child.setZoom(zoom);
    } else if (command === 'setZoomMode') {
      if (!['per-view', 'per-origin', 'automatic'].includes(payload.value)) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid zoom mode');
      }
      child.setZoomMode(payload.value);
    } else if (command === 'clearData') {
      const types = Array.isArray(payload.types) ? payload.types.filter(type => typeof type === 'string') : [];
      await new Promise((resolve, reject) => {
        try { child.clearData({}, types, resolve); } catch (error) { reject(error); }
      });
      return respond(webview, 'nova:nested-webview', requestId, { success: true });
    } else if (command === 'executeScript' || command === 'insertCSS') {
      const code = payload.details?.code;
      if (typeof code !== 'string' || code.length > 1_000_000) {
        return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Invalid webview script');
      }
      const method = command === 'executeScript' ? child.executeScript : child.insertCSS;
      const result = await new Promise((resolve, reject) => {
        try {
          method.call(child, { code }, results => resolve(results));
        } catch (error) { reject(error); }
      });
      return respond(webview, 'nova:nested-webview', requestId, result);
    } else {
      return respondError(webview, 'nova:nested-webview', requestId, 'INVALID_ARGS', 'Unsupported nested webview operation');
    }
    return respond(webview, 'nova:nested-webview', requestId, { success: true });
  }

  function destroyView(state, id, entry, log = (...args) => console.warn(...args.slice(1))) {
    state.views.delete(id);
    for (const cleanup of entry.cleanups) {
      try { cleanup(); } catch (error) { log('warn', 'Nested webview cleanup failed', error); }
    }
    try { entry.view.remove(); }
    catch (error) { log('warn', 'Nested webview removal failed', error); }
  }

  function disposeState(state, log = (...args) => console.warn(...args.slice(1))) {
    for (const [id, entry] of state.views) destroyView(state, id, entry, log);
    for (const pending of state.pendingPopups.values()) {
      try { pending.discard(); } catch (error) { log('warn', 'Pending popup cleanup failed', error); }
    }
    state.pendingPopups.clear();
  }

  function destroySandbox(sandbox) {
    const state = sandboxStates.get(sandbox);
    if (!state) return false;
    disposeState(state);
    sandboxStates.delete(sandbox);
    return true;
  }

  function revokeApp(appId) {
    let removed = false;
    for (const [sandbox, state] of sandboxStates) {
      if (state.appId !== appId) continue;
      disposeState(state);
      sandboxStates.delete(sandbox);
      removed = true;
    }
    return removed;
  }

  window.NovaSystemWebview = Object.freeze({
    handleRequest(context) {
      return handleRequest(context).catch(error => reportFailure(
        context.callbacks,
        context.webview,
        context.requestId,
        error
      ));
    },
    destroySandbox,
    revokeApp,
  });
})();
