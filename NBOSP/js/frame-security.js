/**
 * NovaByte - Frame Security Manager
 * ────────────────────────────────────────────────────────────
 * Enforces NW.js frame type separation and security boundaries.
 *
 * SECURITY FIXES applied:
 *  [1] NODE_REMOTE_PATTERNS restricted to https:// only.
 *      The original wildcard "*://" allowed javascript:, file:,
 *      chrome-extension:// etc. to receive Node.js access.
 *  [2] blob:/data:/javascript:/file: URLs are always classified
 *      as 'normal' frames — they can never be node frames.
 *  [3] validateFrameSecurity now correctly flags blob: iframes
 *      that are missing a sandbox attribute.
 *
 * @module js/frame-security
 */

const FrameSecurity = (() => {
    'use strict';

    // ─── CONFIGURATION ───────────────────────────────────────────────────────

    // FIX [1]: https:// only. Removed http:// and chrome-extension://.
    const NODE_REMOTE_PATTERNS = [
        /^https:\/\/localhost(:\d+)?\//,
        /^https:\/\/127\.0\.0\.1(:\d+)?\//
    ];

    // FIX [2]: These schemes are ALWAYS normal frames regardless of URL content.
    const ALWAYS_NORMAL_SCHEMES = new Set(['blob:', 'data:', 'javascript:', 'file:']);

    // ─── FRAME TYPE DETECTION ─────────────────────────────────────────────────

    function isNodeRemoteUrl(urlString) {
        try {
            const url = new URL(urlString);
            // FIX [2]: Reject non-https schemes immediately.
            if (ALWAYS_NORMAL_SCHEMES.has(url.protocol)) return false;
            if (url.protocol !== 'https:') return false;
            return NODE_REMOTE_PATTERNS.some(p => p.test(urlString));
        } catch (e) {
            return false;
        }
    }

    function hasNwDisable(iframe) {
        return iframe && iframe.hasAttribute('nwdisable');
    }

    function isInWebview(iframe) {
        if (!iframe) return false;
        let parent = iframe.parentElement;
        while (parent) {
            if (parent.tagName === 'WEBVIEW') return true;
            parent = parent.parentElement;
        }
        return false;
    }

    /**
     * Determine frame type.
     * A "node frame" requires ALL of:
     *  1. https://localhost or https://127.0.0.1 URL
     *  2. No nwdisable attribute
     *  3. Not inside <webview>
     *  4. Parent frame not nwdisable
     */
    function getFrameType(iframe) {
        if (!iframe) return 'normal';

        const iframeUrl = iframe.src || '';

        // FIX [2]: blob: / data: / file: / javascript: are always normal.
        try {
            const u = new URL(iframeUrl);
            if (ALWAYS_NORMAL_SCHEMES.has(u.protocol)) return 'normal';
        } catch (_) { /* relative or empty — normal */ }

        const hasNodeRemoteUrl = isNodeRemoteUrl(iframeUrl);
        const disabled = hasNwDisable(iframe);
        const inWebview = isInWebview(iframe);
        const parentDisabled = hasNwDisable(iframe.parentElement?.closest('iframe'));

        if (hasNodeRemoteUrl && !disabled && !inWebview && !parentDisabled) {
            return 'node';
        }
        return 'normal';
    }

    function validateFrameSecurity(iframe) {
        if (!iframe) return { valid: false, issues: ['iframe element is null'] };

        const issues = [];
        const frameType = getFrameType(iframe);
        const iframeUrl = iframe.src || '';

        // Node frames must not carry sandbox restrictions.
        if (isNodeRemoteUrl(iframeUrl) && frameType === 'node') {
            if (iframe.sandbox && iframe.sandbox.length > 0) {
                issues.push('Node frame should not have sandbox restrictions');
            }
        }

        // FIX [3]: Normal frames (including blob:) must have sandbox attribute.
        if (frameType === 'normal' && iframeUrl && !hasNwDisable(iframe)) {
            if (!iframe.sandbox || iframe.sandbox.length === 0) {
                issues.push('Normal frames must have sandbox attribute');
            }
        }

        // Cross-origin URLs must never be node frames.
        if (!isNodeRemoteUrl(iframeUrl) && iframeUrl && frameType === 'node') {
            issues.push('Non-localhost URLs should not be node frames');
        }

        return { valid: issues.length === 0, frameType, issues };
    }

    function securifyFrame(iframe, frameType) {
        if (!iframe) return iframe;
        const iframeUrl = iframe.src || '';
        const shouldBeNodeFrame = isNodeRemoteUrl(iframeUrl);

        if (frameType === 'node' && shouldBeNodeFrame) {
            iframe.removeAttribute('sandbox');
            iframe.removeAttribute('nwdisable');
        } else {
            if (!shouldBeNodeFrame) {
                iframe.setAttribute('nwdisable', '');
            }
            const sandboxAttrs = [
                'allow-same-origin', 'allow-scripts', 'allow-forms',
                'allow-modals', 'allow-popups'
            ];
            iframe.sandbox.add(...sandboxAttrs);
        }
        return iframe;
    }

    function auditAllFrames(verbose = false) {
        const iframes = document.querySelectorAll('iframe');
        const audit = { total: iframes.length, nodeFrames: 0, normalFrames: 0, issues: [] };

        iframes.forEach(iframe => {
            const validation = validateFrameSecurity(iframe);
            if (validation.frameType === 'node') audit.nodeFrames++;
            else audit.normalFrames++;

            if (!validation.valid) {
                audit.issues.push({
                    iframe: iframe.id || iframe.className || iframe.src,
                    type: validation.frameType,
                    problems: validation.issues
                });
            }
        });

        if (verbose) console.log('[FrameSecurity] Audit Report:', audit);
        return audit;
    }

    return {
        isNodeRemoteUrl,
        hasNwDisable,
        isInWebview,
        getFrameType,
        validateFrameSecurity,
        securifyFrame,
        auditAllFrames,
        getNodeRemotePatterns: () => NODE_REMOTE_PATTERNS.map(p => p.source)
    };
})();

window.FrameSecurity = FrameSecurity;