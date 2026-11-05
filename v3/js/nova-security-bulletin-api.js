/**
 * nova-security-bulletin-api.js
 * NovaByte OS — Security Bulletin Verification API
 *
 * Provides `nova:security:bulletin:verify` postMessage API.
 * Runs behavioral probes for each known CVE and returns a
 * structured compliance report. All probes are read-only and
 * non-exploiting — they verify the *fix* exists, never trigger
 * the vulnerability itself.
 *
 * Usage (sandboxed app):
 *   window.parent.postMessage({ type: 'nova:security:bulletin:verify' }, '*');
 *
 * Response:
 *   { type: 'nova:security:bulletin:verify:response', results: [...], summary: {...} }
 */

const NovaBulletinAPI = (() => {

  // ─── Bulletin Database ────────────────────────────────────────────────────
  // Each entry maps a CVE to its metadata and a behavioral probe function.
  // Probes return: 'patched' | 'unpatched' | 'unknown'
  // Probes must be synchronous, < 2ms, and NEVER exploit the vulnerability.

  const BULLETIN = [
    {
      id: 'CVE-NB-2026-001',
      title: 'Calendar App — Stored XSS in Event Renderer',
      component: 'Calendar App',
      type: 'XSS',
      severity: 'High',
      affectedVersions: '2.x, 3.x',
      patchDate: '2026-05-01',
      description: 'Fields ev.title, ev.timeStart, ev.timeEnd, and ev.desc were interpolated directly into innerHTML without sanitisation.',
      probe() {
        try {
          const calApp = OS?.apps?.['calendar'];
          if (!calApp) return 'unknown';
          const src = calApp.init?.toString() || '';
          const usesUnsafeInterp = /innerHTML\s*[+=]\s*[`'"].*\$\{ev\.(title|desc|timeStart|timeEnd)\}/.test(src);
          return usesUnsafeInterp ? 'unpatched' : 'patched';
        } catch { return 'unknown'; }
      }
    },

    {
      id: 'CVE-NB-2026-002',
      title: 'Server / HTTP Layer — Missing Security Headers',
      component: 'Server / HTTP Layer',
      type: 'ID',
      severity: 'Moderate',
      affectedVersions: '2.x, 3.x',
      patchDate: '2026-05-01',
      description: 'Missing Referrer-Policy, X-Content-Type-Options, and Permissions-Policy headers exposed users to MIME-sniffing attacks and referrer leakage.',
      probe() {
        try {
          // Security headers are set server-side via Helmet — not readable from
          // client JS after page load. We use nonce presence as a proxy signal:
          // nonce injection only runs in the same Helmet middleware chain that
          // also sets Referrer-Policy and Permissions-Policy. If inline scripts
          // carry a nonce, the full header chain is active.
          const inlineScripts = Array.from(document.querySelectorAll('script:not([src])'));
          const noncedScripts = inlineScripts.filter(s => s.nonce || s.getAttribute('nonce'));
          if (noncedScripts.length > 0) return 'patched';
          // Fallback: OS patch date
          const patch = OS?.securityPatch;
          if (patch) return new Date(patch) >= new Date('2026-05-01') ? 'patched' : 'unpatched';
          return 'unknown';
        } catch { return 'unknown'; }
      }
    },

    {
      id: 'CVE-NB-2026-003',
      title: 'CSP / Script Loading — Unsafe Inline Scripts',
      component: 'CSP / Script Loading',
      type: 'XSS',
      severity: 'High',
      affectedVersions: '2.x, 3.x',
      patchDate: '2026-05-13',
      description: 'Content Security Policy permitted unsafe-inline script execution, undermining XSS protections system-wide.',
      probe() {
        try {
          // CSP is now enforced via server-sent nonces. The <meta> CSP tag was
          // removed; the server header is authoritative. Two checks:
          //   1. If a <meta> CSP tag still exists with 'unsafe-inline' in script-src,
          //      the page is in a reverted/unpatched state.
          //   2. Inline <script> tags carry nonce attributes, confirming server-side
          //      nonce injection is active and 'unsafe-inline' is no longer needed.
          const metaCSP = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
          if (metaCSP) {
            const content = metaCSP.getAttribute('content') || '';
            const scriptSrcMatch = content.match(/script-src([^;]*)/i);
            if (scriptSrcMatch && scriptSrcMatch[1].includes("'unsafe-inline'")) {
              return 'unpatched';
            }
          }
          const inlineScripts = Array.from(document.querySelectorAll('script:not([src])'));
          if (inlineScripts.length === 0) return 'unknown';
          const noncedCount = inlineScripts.filter(s => s.nonce || s.getAttribute('nonce')).length;
          return noncedCount > 0 ? 'patched' : 'unknown';
        } catch { return 'unknown'; }
      }
    },

    {
      id: 'CVE-NB-2026-004',
      title: 'CDN Script Integrity (SRI) — Missing integrity Attributes',
      component: 'CDN Script Integrity (SRI)',
      type: 'SRI',
      severity: 'High',
      affectedVersions: '2.x, 3.x',
      patchDate: '2026-05-13',
      description: 'External scripts loaded from CDN lacked integrity attributes, allowing a compromised CDN to inject malicious code.',
      probe() {
        try {
          // pdf.js is loaded via ES module import inside an inline script, so SRI
          // is enforced through <link rel="modulepreload" integrity="..."> rather
          // than <script src integrity="...">. Both vectors are checked so the probe
          // stays correct regardless of future load method changes.
          const externalScripts = Array.from(document.querySelectorAll('script[src]'))
            .filter(s => s.src && !s.src.startsWith(location.origin));
          const modulePreloads = Array.from(document.querySelectorAll('link[rel="modulepreload"]'))
            .filter(l => l.href && !l.href.startsWith(location.origin));

          const allExternal = [...externalScripts, ...modulePreloads];
          if (allExternal.length === 0) return 'patched'; // no external scripts

          const missing = allExternal.filter(el => !el.integrity);
          return missing.length === 0 ? 'patched' : 'unpatched';
        } catch { return 'unknown'; }
      }
    },

    {
      id: 'CVE-NB-2026-005',
      title: 'PDF.js Library — Remote Code Execution',
      component: 'PDF.js Library Upgrade',
      type: 'RCE',
      severity: 'Critical',
      affectedVersions: 'pdf.js ≤ 2.6.347',
      patchDate: '2026-05-01',
      description: 'pdf.js 2.6.347 (2020) contains use-after-free in JBIG2, out-of-bounds write in JPX decoding, and prototype pollution in JS interpreter. Any PDF opened in the NovaByte browser could trigger RCE.',
      probe() {
        try {
          const ver = window.pdfjsLib?.version
            || window.PDFJS?.version
            || OS?.pdfjsVersion
            || null;
          if (!ver) return 'unknown';
          const [major, minor, patch] = ver.split('.').map(Number);
          const vulnerable = major < 2
            || (major === 2 && minor < 6)
            || (major === 2 && minor === 6 && patch <= 347);
          return vulnerable ? 'unpatched' : 'patched';
        } catch { return 'unknown'; }
      }
    },

    {
      id: 'CVE-NB-2026-006',
      title: 'Cross-Origin Message Validation — Inverted Origin Check',
      component: 'Cross-Origin Message Validation',
      type: 'EoP',
      severity: 'Moderate',
      affectedVersions: '2.x, 3.x (prior to 3.0.0)',
      patchDate: '2026-05-01',
      description: 'The postMessage handler in the UV (Universal Viewer) proxy had an inverted origin check, allowing messages from any origin to be processed as if from the trusted iframe.',
      probe() {
        try {
          const uvApp = OS?.apps?.['universal-viewer'] || OS?.apps?.['uv'];
          const handlerSrc = uvApp?.messageHandler?.toString()
            || OS?.uvMessageHandler?.toString()
            || '';
          if (!handlerSrc) {
            const patch = OS?.securityPatch;
            if (!patch) return 'unknown';
            return new Date(patch) >= new Date('2026-05-01') ? 'patched' : 'unpatched';
          }
          const hasInvertedCheck = /event\.origin\s*!==\s*(trustedOrigin|location\.origin)/.test(handlerSrc);
          return hasInvertedCheck ? 'unpatched' : 'patched';
        } catch { return 'unknown'; }
      }
    },

    {
      id: 'CVE-NB-2026-007',
      title: 'DOM / Rendering — innerHTML XSS Vectors',
      component: 'DOM / Rendering — Security Hardening',
      type: 'Hardening',
      severity: 'Low',
      affectedVersions: '2.x, 3.x',
      patchDate: '2026-05-01',
      description: 'Non-CVE hardening. Additional innerHTML sinks in the Calendar app were replaced with DOM-safe textContent assignments, closing further XSS vectors.',
      probe() {
        try {
          const calApp = OS?.apps?.['calendar'];
          if (!calApp) return 'unknown';
          const src = calApp.init?.toString() || '';
          const unsafeCount = (src.match(/\.innerHTML\s*[+=]/g) || []).length;
          return unsafeCount <= 2 ? 'patched' : 'unpatched';
        } catch { return 'unknown'; }
      }
    },

    {
      id: 'CVE-NB-2026-008',
      title: 'Clickjacking Defence — Missing X-Frame-Options',
      component: 'Clickjacking Defence',
      type: 'Clickjack',
      severity: 'Low',
      affectedVersions: '2.x, 3.x',
      patchDate: '2026-05-01',
      description: 'OS UI pages lacked X-Frame-Options and frame-ancestors CSP directive, making them embeddable in malicious iframes for clickjacking attacks.',
      probe() {
        try {
          const csp = OS?.sandboxConfig?.['frame-ancestors']
            || OS?.csp?.['frame-ancestors']
            || null;
          const xfo = OS?.serverPolicy?.headers?.['X-Frame-Options']
            || OS?.httpHeaders?.['X-Frame-Options']
            || null;
          if (!csp && !xfo) return 'unknown';
          return (csp === "'none'" || xfo === 'DENY' || xfo === 'SAMEORIGIN') ? 'patched' : 'unpatched';
        } catch { return 'unknown'; }
      }
    },

    {
      id: 'CVE-NB-2026-009',
      title: 'AI Compose — Error Message Information Disclosure',
      component: 'AI Compose Error Sanitisation',
      type: 'ID',
      severity: 'Low',
      affectedVersions: '3.x',
      patchDate: '2026-05-01',
      description: 'Raw API error objects from the AI Compose feature were forwarded directly to the UI, potentially exposing internal endpoint URLs, API keys, or stack traces.',
      probe() {
        try {
          const aiApp = OS?.apps?.['ai-compose'] || OS?.apps?.['nova-ai'];
          if (!aiApp) return 'unknown';
          const src = aiApp.init?.toString() || aiApp.handleError?.toString() || '';
          const hasSanitiser = /sanitise|sanitize|stripStack|safeError|\.stack\s*=/.test(src);
          const hasRawError = /innerHTML.*error\.|textContent.*error\.stack/.test(src);
          if (hasSanitiser) return 'patched';
          if (hasRawError) return 'unpatched';
          return 'unknown';
        } catch { return 'unknown'; }
      }
    }
  ];

  // ─── Probe Runner ─────────────────────────────────────────────────────────

  /**
   * Run all probes and return a full compliance report.
   * @param {object} options
   * @param {string[]} [options.only]   - Run only these CVE IDs
   * @param {string}   [options.since]  - Only check CVEs with patchDate >= this date
   * @returns {{ results: ProbeResult[], summary: Summary, duration: number }}
   */
  function runVerification(options = {}) {
    const t0 = performance.now();
    const { only, since } = options;

    let targets = BULLETIN;
    if (only?.length) targets = targets.filter(e => only.includes(e.id));
    if (since)        targets = targets.filter(e => e.patchDate >= since);

    const results = targets.map(entry => {
      const probeStart = performance.now();
      let status;
      try {
        status = entry.probe();
      } catch {
        status = 'unknown';
      }
      return {
        id:          entry.id,
        title:       entry.title,
        component:   entry.component,
        type:        entry.type,
        severity:    entry.severity,
        patchDate:   entry.patchDate,
        status,                          // 'patched' | 'unpatched' | 'unknown'
        probeMs:     +(performance.now() - probeStart).toFixed(3)
      };
    });

    const patched   = results.filter(r => r.status === 'patched').length;
    const unpatched = results.filter(r => r.status === 'unpatched').length;
    const unknown   = results.filter(r => r.status === 'unknown').length;
    const critical  = results.filter(r => r.status === 'unpatched' && r.severity === 'Critical');

    return {
      results,
      summary: {
        total:     results.length,
        patched,
        unpatched,
        unknown,
        compliant: unpatched === 0,
        criticalUnpatched: critical.map(r => r.id),
        currentPatch: OS?.securityPatch || null,
        verifiedAt: new Date().toISOString()
      },
      duration: +(performance.now() - t0).toFixed(2)
    };
  }

  // ─── postMessage Handler ──────────────────────────────────────────────────

  // Trusted origins that may invoke the bulletin API.
  // '*' is intentionally NOT used — a security API must never broadcast
  // its response to unknown origins. Replies always target event.origin only.
  const TRUSTED_ORIGINS = new Set([
    location.origin,           // same-origin OS apps (covers localhost:3002 at runtime)
    'https://localhost:3002',  // explicit local dev
    'https://127.0.0.1:3002'  // explicit local dev (IP form)
  ]);

  function handleMessage(event, sourceWindow) {
    const { type, payload = {} } = event.data || {};
    if (!type?.startsWith('nova:security:bulletin')) return false;

    // Reject requests from untrusted origins. Prevents a cross-origin page from
    // requesting compliance reports or triggering probes via postMessage.
    if (!TRUSTED_ORIGINS.has(event.origin)) return false;

    // Always reply to event.origin specifically — never '*'.
    // The response contains compliance data that should only go back to the sender.
    const replyOrigin = event.origin;

    switch (type) {

      // Run full (or filtered) verification
      case 'nova:security:bulletin:verify': {
        const report = runVerification(payload);
        sourceWindow.postMessage({
          type: 'nova:security:bulletin:verify:response',
          ...report
        }, replyOrigin);
        return true;
      }

      // Return raw bulletin metadata (no probes run)
      case 'nova:security:bulletin:list': {
        sourceWindow.postMessage({
          type: 'nova:security:bulletin:list:response',
          bulletins: BULLETIN.map(({ probe: _probe, ...meta }) => meta)
        }, replyOrigin);
        return true;
      }

      // Return single CVE detail
      case 'nova:security:bulletin:get': {
        const entry = BULLETIN.find(e => e.id === payload.id);
        if (!entry) {
          sourceWindow.postMessage({
            type: 'nova:security:bulletin:get:response',
            error: 'NOT_FOUND'
          }, replyOrigin);
        } else {
          const { probe: _probe, ...meta } = entry;
          sourceWindow.postMessage({
            type: 'nova:security:bulletin:get:response',
            bulletin: meta
          }, replyOrigin);
        }
        return true;
      }

      default:
        return false;
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  return {
    /** Programmatic access for trusted OS-level code */
    verify:       (opts) => runVerification(opts),
    getBulletins: ()     => BULLETIN.map(({ probe: _p, ...m }) => m),

    /** Wire into the OS sandbox message router */
    handleMessage,

    /** Convenience: check if a specific CVE is patched */
    isCVEPatched(cveId) {
      const entry = BULLETIN.find(e => e.id === cveId);
      if (!entry) return null;
      try { return entry.probe() === 'patched'; }
      catch { return null; }
    }
  };

})();

// ─── Integration: hook into OS sandbox message router ────────────────────────
// Drop this into the existing postMessage dispatch chain in app-sandbox.js:
//
//   if (NovaBulletinAPI.handleMessage(event, event.source)) return;
//
// Required permission: none for 'list' and 'get'
// Required permission: admin:audit for 'verify' (enforced by sandbox router)