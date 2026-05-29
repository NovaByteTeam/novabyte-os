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
 *  [4] securifyFrame() sandbox escape closed — allow-same-origin removed
 *      from sandboxAttrs. allow-same-origin + allow-scripts together allow
 *      a framed document to call frameElement.removeAttribute('sandbox'),
 *      completely escaping the sandbox in NW.js (full Node.js access).
 *  [5] getFrameType() parentDisabled now walks the full ancestor chain,
 *      not just the nearest parent iframe.
 *  [6] validateFrameSecurity() sandbox check now also applies to nwdisable
 *      frames — nwdisable + no sandbox still runs scripts unrestricted.
 *  [7] auditAllFrames() upgraded to also install a MutationObserver so
 *      dynamically-added iframes (e.g. browser tab iframes created after
 *      the 3-second boot audit) are validated automatically.
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

        // Walk the full ancestor chain — not just the nearest parent iframe.
        // A deeply nested iframe (C inside B inside A) where only A has nwdisable
        // should still be treated as a normal frame all the way down.
        function anyAncestorDisabled(el) {
            let cur = el.parentElement;
            while (cur) {
                if (cur.tagName === 'IFRAME' && hasNwDisable(cur)) return true;
                cur = cur.parentElement;
            }
            return false;
        }
        const parentDisabled = anyAncestorDisabled(iframe);

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

        // FIX [3]: Normal frames (including blob: and nwdisable) must have sandbox.
        // nwdisable disables Node.js access but does NOT add script restrictions —
        // a nwdisable frame with no sandbox still runs third-party scripts freely.
        if (frameType === 'normal' && iframeUrl) {
            if (!iframe.sandbox || iframe.sandbox.length === 0) {
                if (hasNwDisable(iframe)) {
                    issues.push('nwdisable frame has no sandbox — scripts run unrestricted');
                } else {
                    issues.push('Normal frame must have sandbox attribute');
                }
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
            // NOTE: allow-same-origin is intentionally ABSENT.
            // Combining allow-same-origin + allow-scripts is a known sandbox escape:
            // the framed document can call frameElement.removeAttribute('sandbox')
            // via parent.document, removing all restrictions (full Node.js in NW.js).
            const sandboxAttrs = [
                'allow-scripts', 'allow-forms',
                'allow-modals', 'allow-popups'
            ];
            iframe.sandbox.add(...sandboxAttrs);
        }
        return iframe;
    }

    function auditAllFrames(verbose = false) {
        const iframes = document.querySelectorAll('iframe');
        const audit = { total: iframes.length, nodeFrames: 0, normalFrames: 0, issues: [] };

        // Safe identifier — never log the full src URL (may contain tokens/paths)
        function safeId(iframe) {
            if (iframe.id) return '#' + iframe.id;
            if (iframe.className) return '.' + iframe.className.trim().split(/\s+/)[0];
            try {
                const u = new URL(iframe.src || '');
                return u.protocol + '//' + u.hostname; // origin only, no path/query
            } catch (_) { return '<no-src>'; }
        }

        iframes.forEach(iframe => {
            const validation = validateFrameSecurity(iframe);
            if (validation.frameType === 'node') audit.nodeFrames++;
            else audit.normalFrames++;

            if (!validation.valid) {
                audit.issues.push({
                    iframe: safeId(iframe),
                    type: validation.frameType,
                    problems: validation.issues
                });
            }
        });

        if (verbose) console.log('[FrameSecurity] Audit Report:', audit);
        return audit;
    }

    // ─── DYNAMIC IFRAME OBSERVER ─────────────────────────────────────────────
    // auditAllFrames() is called once at boot (after a 3-second delay).
    // Browser tab iframes are created long after that, so they would never
    // be validated. This MutationObserver catches every iframe added to the
    // DOM at any point and validates it immediately.
    let _observer = null;
    function startObserver() {
        if (_observer || typeof MutationObserver === 'undefined') return;
        _observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue; // elements only
                    // Check the node itself
                    if (node.tagName === 'IFRAME') {
                        const v = validateFrameSecurity(node);
                        if (!v.valid) {
                            console.warn('[FrameSecurity] Dynamically added iframe has issues:', v.issues, node);
                        }
                    }
                    // Check any iframes nested inside the added subtree
                    if (node.querySelectorAll) {
                        node.querySelectorAll('iframe').forEach(ifr => {
                            const v = validateFrameSecurity(ifr);
                            if (!v.valid) {
                                console.warn('[FrameSecurity] Dynamically added nested iframe has issues:', v.issues, ifr);
                            }
                        });
                    }
                }
            }
        });
        _observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    function stopObserver() {
        if (_observer) { _observer.disconnect(); _observer = null; }
    }
    // Auto-start once the DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startObserver, { once: true });
    } else {
        startObserver();
    }

    return {
        isNodeRemoteUrl,
        hasNwDisable,
        isInWebview,
        getFrameType,
        validateFrameSecurity,
        securifyFrame,
        auditAllFrames,
        startObserver,
        stopObserver,
        getNodeRemotePatterns: () => NODE_REMOTE_PATTERNS.map(p => p.source)
    };
})();

window.FrameSecurity = FrameSecurity;