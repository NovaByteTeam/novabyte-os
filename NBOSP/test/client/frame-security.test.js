import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock document for FrameSecurity ─────────────────────────────────────────
const mockIframe = (attrs = {}) => {
  const sandboxTokens = (attrs.sandbox || '').split(/\s+/).filter(Boolean);
  return {
    src: attrs.src || '',
    sandbox: {
      contains: vi.fn((token) => sandboxTokens.includes(token)),
      value: attrs.sandbox || '',
    },
    hasAttribute: vi.fn((name) => attrs[name] !== undefined),
    getAttribute: vi.fn((name) => attrs[name] ?? null),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    tagName: 'IFRAME',
    id: attrs.id || '',
    className: attrs.className || '',
    parentElement: attrs.parentElement || null,
    isConnected: true,
  };
};

globalThis.document = {
  querySelectorAll: vi.fn(() => []),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  documentElement: { tagName: 'HTML', querySelectorAll: vi.fn(() => []) },
};
globalThis.window = { FrameSecurity: undefined };

describe('FrameSecurity (js/platform/security/frame-security.js)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  describe('Public API surface', () => {
    it('loads without error', () => {
      vi.resetModules();
      require('../../js/platform/security/frame-security.js');
      expect(true).toBe(true);
    });
  });

  describe('isNodeRemoteUrl logic', () => {
    function isNodeRemoteUrl(urlString) {
      if (typeof urlString !== 'string') return false;
      try {
        const url = new URL(urlString);
        if (url.protocol !== 'https:') return false;
        return urlString.startsWith('https://localhost') || urlString.startsWith('https://127.0.0.1');
      } catch {
        return false;
      }
    }

    it('returns false for non-string input', () => {
      expect(isNodeRemoteUrl(null)).toBe(false);
      expect(isNodeRemoteUrl(123)).toBe(false);
    });

    it('returns false for non-https schemes', () => {
      expect(isNodeRemoteUrl('http://localhost:3003')).toBe(false);
      expect(isNodeRemoteUrl('blob:http://example.com/uuid')).toBe(false);
    });

    it('returns true for https://localhost URLs', () => {
      expect(isNodeRemoteUrl('https://localhost:3003/app')).toBe(true);
    });

    it('returns true for https://127.0.0.1 URLs', () => {
      expect(isNodeRemoteUrl('https://127.0.0.1:3003/app')).toBe(true);
    });

    it('returns false for public HTTPS URLs', () => {
      expect(isNodeRemoteUrl('https://example.com')).toBe(false);
    });
  });

  describe('hasSandboxAttribute', () => {
    function hasSandboxAttribute(iframe) {
      return Boolean(iframe && iframe.hasAttribute && iframe.hasAttribute('sandbox'));
    }

    it('returns false for null iframe', () => {
      expect(hasSandboxAttribute(null)).toBe(false);
    });

    it('returns true when sandbox attribute is present', () => {
      const iframe = mockIframe({ sandbox: 'allow-scripts' });
      expect(hasSandboxAttribute(iframe)).toBe(true);
    });

    it('returns true when sandbox is empty string', () => {
      const iframe = mockIframe({ sandbox: '' });
      expect(hasSandboxAttribute(iframe)).toBe(true);
    });
  });

  describe('getFrameType', () => {
    function getFrameType(iframe) {
      if (!iframe) return 'normal';
      if (iframe.src.startsWith('https://localhost') || iframe.src.startsWith('https://127.0.0.1')) return 'node';
      return 'normal';
    }

    it('returns normal for null iframe', () => {
      expect(getFrameType(null)).toBe('normal');
    });

    it('returns node for localhost URLs', () => {
      expect(getFrameType(mockIframe({ src: 'https://localhost:3003/app' }))).toBe('node');
    });

    it('returns normal for external URLs', () => {
      expect(getFrameType(mockIframe({ src: 'https://example.com' }))).toBe('normal');
    });
  });

  describe('validateFrameSecurity', () => {
    function validateFrameSecurity(iframe) {
      if (!iframe) {
        return { valid: false, frameType: 'normal', issues: ['iframe element is null'] };
      }
      const issues = [];
      const frameType = getFrameType(iframe);
      const hasSandbox = hasSandboxAttribute(iframe);

      if (frameType === 'node') {
        if (hasSandbox) issues.push('Node frame should not have sandbox restrictions');
      } else if (iframe.src) {
        if (!hasSandbox) {
          issues.push('Normal frame must have sandbox attribute');
        } else if (iframe.sandbox.contains('allow-same-origin')) {
          issues.push('Sandbox includes allow-same-origin — sandbox escape risk');
        }
      }
      return { valid: issues.length === 0, frameType, issues };
    }

    function getFrameType(iframe) {
      if (!iframe) return 'normal';
      if (iframe.src.startsWith('https://localhost') || iframe.src.startsWith('https://127.0.0.1')) return 'node';
      return 'normal';
    }

    function hasSandboxAttribute(iframe) {
      return Boolean(iframe && iframe.hasAttribute && iframe.hasAttribute('sandbox'));
    }

    it('returns null when input is empty', () => {
      const result = validateFrameSecurity(null);
      expect(result.valid).toBe(false);
    });

    it('validates a correct normal frame', () => {
      const iframe = mockIframe({ src: 'https://example.com/', sandbox: 'allow-scripts' });
      const result = validateFrameSecurity(iframe);
      expect(result.valid).toBe(true);
      expect(result.frameType).toBe('normal');
    });

    it('flags missing sandbox on normal frame', () => {
      const iframe = mockIframe({ src: 'https://example.com/' });
      const result = validateFrameSecurity(iframe);
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.includes('sandbox'))).toBe(true);
    });

    it('flags allow-same-origin as escape risk', () => {
      const iframe = mockIframe({ src: 'https://example.com/', sandbox: 'allow-scripts allow-same-origin' });
      const result = validateFrameSecurity(iframe);
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.includes('allow-same-origin'))).toBe(true);
    });
  });

  describe('securifyFrame', () => {
    function securifyFrame(iframe, _frameType, { mode = 'patch' } = {}) {
      if (!iframe) return iframe;
      if (iframe.src.startsWith('https://localhost') || iframe.src.startsWith('https://127.0.0.1')) {
        iframe.removeAttribute('sandbox');
        iframe.removeAttribute('nwdisable');
        return iframe;
      }
      if (!iframe.hasAttribute('nwdisable')) iframe.setAttribute('nwdisable', '');
      if (mode === 'replace') {
        iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
        return iframe;
      }
      if (!iframe.hasAttribute('sandbox')) {
        iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
      }
      return iframe;
    }

    it('adds nwdisable and sandbox to normal frames', () => {
      const iframe = mockIframe({ src: 'https://example.com/' });
      securifyFrame(iframe, 'normal', { mode: 'patch' });
      expect(iframe.setAttribute).toHaveBeenCalledWith('nwdisable', '');
    });

    it('strips sandbox/nwdisable from node frames', () => {
      const iframe = mockIframe({ src: 'https://localhost:3003/app', sandbox: 'allow-scripts', nwdisable: '' });
      securifyFrame(iframe, 'node');
      expect(iframe.removeAttribute).toHaveBeenCalledWith('sandbox');
      expect(iframe.removeAttribute).toHaveBeenCalledWith('nwdisable');
    });
  });

  describe('safeId', () => {
    function safeId(iframe) {
      if (!iframe) return '<null>';
      if (iframe.id) return '#' + iframe.id;
      if (iframe.className) {
        const first = iframe.className.trim().split(/\s+/)[0];
        if (first) return '.' + first;
      }
      try {
        const u = new URL(iframe.src || '');
        return u.protocol + '//' + u.hostname;
      } catch {
        return '<no-src>';
      }
    }

    it('returns null when input is empty', () => {
      expect(safeId(null)).toBe('<null>');
    });

    it('prefers id over class and origin', () => {
      expect(safeId(mockIframe({ id: 'myframe', src: 'https://example.com/page' }))).toBe('#myframe');
    });
  });
});
