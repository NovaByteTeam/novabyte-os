import { describe, it, expect } from 'vitest';
import AppSandbox from '../../js/platform/security/app-sandbox.js';

describe('AppSandbox (js/platform/security/app-sandbox.js)', () => {
  it('mediates permitted nested webviews through the host sibling bridge', () => {
    const shim = AppSandbox._internal.buildCapabilityShim(true);
    const script = shim.slice(shim.indexOf('<script>') + 8, shim.lastIndexOf('</script>'));

    expect(shim).toContain('nova-nested-webview');
    expect(shim).toContain("action: 'create'");
    expect(shim).toContain("action: 'bounds'");
    expect(shim).toContain("customElements.define('nova-nested-webview'");
    expect(shim).not.toContain('NESTED_WEBVIEW_NAV_DELAY_MS');
    expect(() => new Function(script)).not.toThrow();
    expect(AppSandbox._internal.API_HANDLERS['nova:nested-webview']).toBeTypeOf('function');
  });

  it('does not expose host-mediated webview creation when permission is absent', () => {
    const shim = AppSandbox._internal.buildCapabilityShim(false);
    const script = shim.slice(shim.indexOf('<script>') + 8, shim.lastIndexOf('</script>'));

    expect(shim).toContain('const __NOVA_NESTED_WEBVIEW_ALLOWED__ = false;');
    expect(() => new Function(script)).not.toThrow();
    expect(AppSandbox._internal.API_HANDLERS['nova:nested-webview']).toBeTypeOf('function');
  });

  it('rejects host-side nested webview requests without the permission grant', async () => {
    const responses = [];
    const webview = { __directResponder: message => responses.push(message) };

    await AppSandbox._internal.handleAPICall(
      'nova:nested-webview',
      { action: 'create', id: 'nvw_test' },
      'request-test',
      { id: 'third-party.app' },
      webview,
      { nestedWebviewAllowed: false }
    );

    expect(responses).toHaveLength(1);
    expect(responses[0].error.code).toBe('PERMISSION_DENIED');
  });

  it('updates an existing file selected in the system Save dialog', async () => {
    const existing = { id: 'file-1', name: 'notes.txt', type: 'file' };
    const responses = [];
    const writeFile = vi.fn(async () => existing);
    const createFile = vi.fn();
    vi.stubGlobal('AppPermissionManager', { isGranted: () => true });
    vi.stubGlobal('window', {
      SystemDialogs: { save: async () => ({ folderId: 'documents', name: 'notes.txt' }) },
    });
    vi.stubGlobal('FS', {
      rootId: 'root',
      listDir: () => [existing],
      writeFile,
      createFile,
      getPath: () => '/Documents/notes.txt',
    });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:sysdialog:save',
        { content: 'updated text', mimeType: 'text/plain' },
        'save-test',
        { id: 'com.nbosp.quill' },
        { __directResponder: message => responses.push(message) }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(writeFile).toHaveBeenCalledWith('file-1', 'updated text');
    expect(createFile).not.toHaveBeenCalled();
    expect(responses[0].result.file.path).toBe('/Documents/notes.txt');
  });
});
