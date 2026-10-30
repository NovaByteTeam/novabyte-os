import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../../js/apps/system-webview/service.js', import.meta.url),
  'utf8'
);

function loadService(windowObject = {}) {
  vi.stubGlobal('window', windowObject);
  new Function(source)();
  return windowObject.NovaSystemWebview;
}

function createCallbacks(responses = []) {
  return {
    respond: (webview, type, requestId, result) => responses.push({ type, requestId, result }),
    respondError: (webview, type, requestId, code, message) => responses.push({
      type, requestId, error: { code, message },
    }),
    generateRequestId: () => 'popup-test',
    log: vi.fn(),
    canNavigate: vi.fn(() => true),
    setupPermissionRequestGate: vi.fn(() => vi.fn()),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('NovaByte System Webview service', () => {
  it('creates isolated guests with app-scoped storage and owns their teardown', async () => {
    const listeners = new Map();
    const attributes = new Map();
    const child = {
      style: {},
      setAttribute: vi.fn((name, value) => attributes.set(name, value)),
      addEventListener: vi.fn((name, listener) => listeners.set(name, listener)),
      removeEventListener: vi.fn(),
      remove: vi.fn(),
    };
    const parent = { isConnected: true, style: {}, appendChild: vi.fn() };
    const sandbox = { state: { content: parent } };
    const webview = {};
    const responses = [];
    const callbacks = createCallbacks(responses);
    const service = loadService();
    vi.stubGlobal('document', { createElement: vi.fn(() => child) });

    await service.handleRequest({
      payload: {
        action: 'create',
        id: 'nvw_service_test',
        attributes: { src: 'https://example.test/', allowpopups: '' },
      },
      requestId: 'create-view',
      app: { id: 'com.example.app' },
      webview,
      sandbox,
      callbacks,
    });

    expect(Object.fromEntries(attributes)).toMatchObject({
      nodeintegration: 'false',
      nodeintegrationsubframes: 'false',
      enableremotemodule: 'false',
      partition: 'persist:app_com.example.app_webcontent',
      allowpopups: '',
    });
    expect(attributes.has('sandbox')).toBe(false);
    expect(child.src).toBe('https://example.test/');
    expect(callbacks.setupPermissionRequestGate).toHaveBeenCalledWith(child);
    expect(parent.appendChild).toHaveBeenCalledWith(child);
    expect(responses[0].result).toEqual({ success: true });

    expect(service.destroySandbox(sandbox)).toBe(true);
    expect(child.remove).toHaveBeenCalledOnce();
    expect(service.destroySandbox(sandbox)).toBe(false);
  });

  it('rejects navigation without the caller-provided network authorization', async () => {
    const createElement = vi.fn();
    const responses = [];
    const callbacks = createCallbacks(responses);
    callbacks.canNavigate.mockReturnValue(false);
    const service = loadService();
    vi.stubGlobal('document', { createElement });

    await service.handleRequest({
      payload: {
        action: 'create',
        id: 'nvw_denied',
        attributes: { src: 'http://127.0.0.1/' },
      },
      requestId: 'denied-navigation',
      app: { id: 'com.example.app' },
      webview: {},
      sandbox: { state: { content: { isConnected: true, style: {}, appendChild: vi.fn() } } },
      callbacks,
    });

    expect(createElement).not.toHaveBeenCalled();
    expect(responses[0].error.code).toBe('PERMISSION_DENIED');
  });

  it('bounds guests to their app content and destroys pending popups on grant revocation', async () => {
    vi.useFakeTimers();
    const listeners = new Map();
    const child = {
      style: {},
      setAttribute: vi.fn(),
      addEventListener: vi.fn((name, listener) => listeners.set(name, listener)),
      removeEventListener: vi.fn(),
      remove: vi.fn(),
    };
    const parent = { isConnected: true, clientWidth: 400, clientHeight: 300, style: {}, appendChild: vi.fn() };
    const sandbox = { state: { content: parent } };
    const popup = { attach: vi.fn(), discard: vi.fn() };
    const responses = [];
    const callbacks = createCallbacks(responses);
    const service = loadService();
    vi.stubGlobal('document', { createElement: vi.fn(() => child) });

    await service.handleRequest({
      payload: { action: 'create', id: 'nvw_revoke' },
      requestId: 'create-revoke-view',
      app: { id: 'com.example.app' },
      webview: {},
      sandbox,
      callbacks,
    });
    await service.handleRequest({
      payload: { action: 'bounds', id: 'nvw_revoke', bounds: { left: 350, top: 250, width: 100, height: 100, visible: true } },
      requestId: 'set-bounds',
      app: { id: 'com.example.app' },
      webview: {},
      sandbox,
      callbacks,
    });

    expect(child.style).toMatchObject({
      left: '350px',
      top: '250px',
      width: '50px',
      height: '50px',
      display: 'flex',
    });

    const newWindow = { preventDefault: vi.fn(), window: popup };
    listeners.get('newwindow')(newWindow);
    expect(newWindow.preventDefault).toHaveBeenCalledOnce();
    expect(service.revokeApp('com.example.app')).toBe(true);
    expect(child.remove).toHaveBeenCalledOnce();
    expect(popup.discard).toHaveBeenCalledOnce();
    expect(service.revokeApp('com.example.app')).toBe(false);
    vi.useRealTimers();
  });
});
