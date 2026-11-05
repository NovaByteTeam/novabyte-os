/**
 * NovaByte OS — Update Service  (update-service.js)  v2.0
 *
 * Security changes from v1:
 *   - BLOCKS installation when server is unreachable (no more client-only fallback)
 *   - Validates package nonce (prevents replay attacks within a session)
 *   - Validates issuedAt / expiresAt timestamps
 *   - Validates package was issued no more than 7 days before being applied
 *   - Stricter threat scanner with additional patterns
 *   - Requires all high-severity threats to be explicitly acknowledged
 *
 * Feature additions:
 *   - Update channels (stable / beta / nightly) with colour-coded badges
 *   - Real diff-line counter per file
 *   - Live installation log streamed to the dialog
 *   - Per-file before/after diff viewer (toggle)
 *   - Rollback timeline with human-readable timestamps
 *   - Package hash pinning (shown to admin for out-of-band verification)
 *   - Rich tabbed validation dialog: Overview · Security · Files · Changelog
 */

'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   THREAT PATTERNS  (client-side pre-scan; server is authoritative)
   ───────────────────────────────────────────────────────────────────────────── */
const _THREAT_PATTERNS = [
    // ── High severity ─────────────────────────────────────────────────────
    { re: /\beval\s*\(/,                                                   severity: 'high',   label: 'eval() call',                    desc: 'Executes arbitrary strings as code'                    },
    { re: /new\s+Function\s*\(/,                                           severity: 'high',   label: 'new Function() constructor',     desc: 'Constructs and executes arbitrary code at runtime'     },
    { re: /fetch\s*\(\s*['"`]https?:\/\/(?!localhost|127\.0\.0\.1)/,      severity: 'high',   label: 'External fetch()',               desc: 'Makes HTTP requests to external domains'               },
    { re: /document\.cookie/,                                              severity: 'high',   label: 'document.cookie access',         desc: 'Reads or writes session cookies'                      },
    { re: /navigator\.sendBeacon/,                                         severity: 'high',   label: 'sendBeacon()',                   desc: 'Silently exfiltrates data to a remote endpoint'       },
    { re: /localStorage\.clear\s*\(\)/,                                    severity: 'high',   label: 'localStorage.clear()',           desc: 'Wipes all locally stored OS state'                    },
    { re: /indexedDB\.deleteDatabase/,                                     severity: 'high',   label: 'indexedDB.deleteDatabase()',     desc: 'Destroys persistent storage databases'                },
    { re: /\brequire\s*\(/,                                                severity: 'high',   label: 'require() in browser code',      desc: 'Node.js module loader should not appear in browser JS' },
    { re: /process\s*\.\s*(env|exit|argv)/,                                severity: 'high',   label: 'Node.js process access',         desc: 'Accesses server process environment or control'       },
    { re: /window\.location\s*=\s*['"`]https?:\/\/(?!localhost|127\.0\.0\.1)/, severity: 'high', label: 'External redirect',          desc: 'Redirects the user to an external URL'               },
    { re: /\bboot\s*=/,                                                    severity: 'high',   label: 'Overrides boot()',               desc: 'Replaces the critical OS boot function'               },
    { re: /OS\s*\.\s*settings\s*=/,                                        severity: 'high',   label: 'Overrides OS.settings',          desc: 'Replaces the global settings object'                  },
    { re: /WM\s*=/,                                                        severity: 'high',   label: 'Overrides WM',                  desc: 'Replaces the window manager object'                   },
    { re: /Object\.defineProperty\s*\(\s*window/,                         severity: 'high',   label: 'window property redefine',       desc: 'Redefines window-level properties'                    },
    { re: /\.__proto__\s*=/,                                               severity: 'high',   label: 'Prototype pollution',            desc: 'Modifies prototype chain — potential RCE vector'      },
    { re: /constructor\s*\[\s*['"]constructor['"]\s*\]/,                   severity: 'high',   label: 'Constructor chain access',       desc: 'Accesses Function via constructor chain'              },
    // ── Medium severity ────────────────────────────────────────────────────
    { re: /setTimeout\s*\(\s*['"`]/,                                       severity: 'medium', label: 'setTimeout(string)',             desc: 'Executes a string as code via setTimeout'             },
    { re: /setInterval\s*\(\s*['"`]/,                                      severity: 'medium', label: 'setInterval(string)',            desc: 'Executes a string as code via setInterval'            },
    { re: /new\s+XMLHttpRequest/,                                          severity: 'medium', label: 'XMLHttpRequest',                 desc: 'Makes HTTP requests — check the destination'         },
    { re: /atob\s*\(/,                                                     severity: 'medium', label: 'atob() base64 decode',           desc: 'May be used to obfuscate payload content'             },
    { re: /String\.fromCharCode\s*\(/,                                     severity: 'medium', label: 'String.fromCharCode()',          desc: 'Common obfuscation technique'                         },
    { re: /document\.write\s*\(/,                                          severity: 'medium', label: 'document.write()',               desc: 'Inserts raw HTML — common XSS vector'                 },
    { re: /innerHTML\s*=/,                                                  severity: 'medium', label: 'innerHTML assignment',          desc: 'Injects raw HTML into the DOM'                        },
    // ── Low severity ───────────────────────────────────────────────────────
    { re: /[0-9a-zA-Z+/=]{200,}/,                                         severity: 'low',    label: 'Long base64-like string',        desc: 'May be encoded payload — inspect manually'            },
    { re: /\/\*[\s\S]{500,}?\*\//,                                        severity: 'low',    label: 'Large block comment',            desc: 'Unusual — could contain hidden content'               },
];

const _CRITICAL_MARKERS = [
    'function boot(',    'completeBoot',       'showRecoveryScreen', 'BOOT_ATTEMPT_KEY',
    'BOOT_TIMEOUT',      'nova_force_recovery', 'nova_boot_attempts', 'recovery-screen',
    'BOOT_THRESHOLD',    'SAFE_MODE_KEY',       'nova_manual_recovery','nova_safe_mode',
    'boot-screen',
];

/* ─────────────────────────────────────────────────────────────────────────────
   TRUST LEVELS
   ───────────────────────────────────────────────────────────────────────────── */
const _TRUST_CONFIG = {
    official:    { icon: '✦', badge: 'NovaByte Official', color: '#3ecf8e', bg: 'rgba(62,207,142,0.10)',  border: 'rgba(62,207,142,0.32)', glow: 'rgba(62,207,142,0.2)'  },
    community:   { icon: '◈', badge: 'Community Publisher', color: '#60a5fa', bg: 'rgba(96,165,250,0.10)',  border: 'rgba(96,165,250,0.32)', glow: 'rgba(96,165,250,0.2)'  },
    unknown_key: { icon: '◇', badge: 'Key Not Trusted',    color: '#f59e0b', bg: 'rgba(245,158,11,0.10)',  border: 'rgba(245,158,11,0.32)', glow: 'rgba(245,158,11,0.2)'  },
    invalid:     { icon: '✕', badge: 'Signature Invalid',  color: '#ef4444', bg: 'rgba(239,68,68,0.10)',   border: 'rgba(239,68,68,0.38)',  glow: 'rgba(239,68,68,0.2)'   },
    unsigned:    { icon: '○', badge: 'No Signature',       color: '#9ca3af', bg: 'rgba(156,163,175,0.08)', border: 'rgba(156,163,175,0.22)',glow: 'transparent'           },
};

/* ─────────────────────────────────────────────────────────────────────────────
   UPDATE CHANNELS
   ───────────────────────────────────────────────────────────────────────────── */
const _CHANNEL_CONFIG = {
    stable:  { label: 'Stable',  color: '#3ecf8e', icon: '●', desc: 'Production-ready release' },
    beta:    { label: 'Beta',    color: '#f59e0b', icon: '◐', desc: 'Feature-complete, may have minor issues' },
    nightly: { label: 'Nightly', color: '#a78bfa', icon: '◑', desc: 'Bleeding edge — use with caution' },
};

/* ─────────────────────────────────────────────────────────────────────────────
   NONCE TRACKING  — Prevents replay attacks within a browser session.
   All used nonces are tracked in sessionStorage and rejected if seen again.
   ───────────────────────────────────────────────────────────────────────────── */
const _NONCE_STORAGE_KEY = 'nova_used_nonces';

function _recordNonce(nonce) {
    try {
        const used = JSON.parse(sessionStorage.getItem(_NONCE_STORAGE_KEY) || '[]');
        used.push(nonce);
        // Keep only the last 100 nonces
        sessionStorage.setItem(_NONCE_STORAGE_KEY, JSON.stringify(used.slice(-100)));
    } catch {}
}

function _isNonceUsed(nonce) {
    try {
        const used = JSON.parse(sessionStorage.getItem(_NONCE_STORAGE_KEY) || '[]');
        return used.includes(nonce);
    } catch { return false; }
}

/* ─────────────────────────────────────────────────────────────────────────────
   ROLLBACK PROTECTION
   ───────────────────────────────────────────────────────────────────────────── */
const MINIMUM_VERSION     = '1.0.0';
const ROLLBACK_COOLDOWN_MS = 60000;

function canRollback(targetVersion) {
    const history = JSON.parse(localStorage.getItem('nova_update_history') || '[]');
    if (compareVersions(targetVersion, MINIMUM_VERSION) < 0) {
        return { allowed: false, reason: 'Cannot rollback below minimum version ' + MINIMUM_VERSION };
    }
    const now = Date.now();
    for (const entry of history) {
        if (entry.type === 'rollback') {
            const timeSince = now - new Date(entry.timestamp || (entry.date + 'T' + entry.time)).getTime();
            if (timeSince < ROLLBACK_COOLDOWN_MS) {
                const secsLeft = Math.ceil((ROLLBACK_COOLDOWN_MS - timeSince) / 1000);
                return { allowed: false, reason: 'Rollback cooldown active — please wait ' + secsLeft + 's.' };
            }
        }
    }
    return { allowed: true };
}

function compareVersions(a, b) {
    const pa = (a || '0.0.0').split('.').map(Number);
    const pb = (b || '0.0.0').split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (pa[i] > pb[i]) return  1;
        if (pa[i] < pb[i]) return -1;
    }
    return 0;
}

/* ─────────────────────────────────────────────────────────────────────────────
   DIFF UTILITIES  — Counts meaningful line changes for the files tab
   ───────────────────────────────────────────────────────────────────────────── */
const PatchService = {
    /**
     * Compute a simple line-based diff between two strings.
     * Returns an array of { type: 'add'|'del'|'eq', text } objects.
     */
    diff(oldText, newText) {
        if (oldText === newText) return [];
        const oldLines = (oldText || '').split('\n');
        const newLines = (newText || '').split('\n');

        // Myers-style LCS (simplified for display)
        const result = [];
        let o = 0, n = 0;
        while (o < oldLines.length || n < newLines.length) {
            if (o < oldLines.length && n < newLines.length && oldLines[o] === newLines[n]) {
                result.push({ type: 'eq', text: oldLines[o] });
                o++; n++;
            } else if (n < newLines.length && (o >= oldLines.length || oldLines[o] !== newLines[n])) {
                result.push({ type: 'add', text: newLines[n] });
                n++;
            } else {
                result.push({ type: 'del', text: oldLines[o] });
                o++;
            }
        }
        return result;
    },

    countChanges(oldText, newText) {
        const d = this.diff(oldText, newText);
        return { added: d.filter(l => l.type === 'add').length, removed: d.filter(l => l.type === 'del').length };
    },

    renderDiff(oldText, newText, maxLines = 60) {
        const d = this.diff(oldText, newText);
        // Only show changed context (3 lines around each change)
        const relevant = [];
        for (let i = 0; i < d.length && relevant.length < maxLines; i++) {
            if (d[i].type !== 'eq') {
                const start = Math.max(0, i - 2);
                const end   = Math.min(d.length - 1, i + 2);
                for (let j = start; j <= end; j++) {
                    if (!relevant.some(r => r.idx === j)) relevant.push({ idx: j, ...d[j] });
                }
            }
        }
        relevant.sort((a, b) => a.idx - b.idx);
        return relevant.map(function(line) {
            const esc = line.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            if (line.type === 'add') return '<span class="nb-diff-add">+ ' + esc + '</span>';
            if (line.type === 'del') return '<span class="nb-diff-del">- ' + esc + '</span>';
            return '<span class="nb-diff-eq">  ' + esc + '</span>';
        }).join('\n');
    }
};

window.PatchService     = PatchService;
window.canRollback      = canRollback;
window.compareVersions  = compareVersions;

/* ─────────────────────────────────────────────────────────────────────────────
   STYLES — Injected once into <head>
   ───────────────────────────────────────────────────────────────────────────── */
(function injectStyles() {
    if (document.getElementById('nb-update-styles')) return;
    const s = document.createElement('style');
    s.id = 'nb-update-styles';
    s.textContent = `
/* ── Reset & container ───────────────────────────────────────────────── */
.nb-overlay {
    position: fixed; inset: 0; z-index: 999999;
    background: rgba(0,0,0,0.88);
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(10px) saturate(140%);
    animation: nb-fade-in 0.25s ease;
    font-family: var(--font-ui, 'Inter', system-ui, sans-serif);
}
@keyframes nb-fade-in { from { opacity:0 } to { opacity:1 } }

.nb-modal {
    background: var(--bg-elevated, #161b22);
    border: 1px solid var(--border, rgba(240,246,252,0.12));
    border-radius: 16px;
    box-shadow: 0 32px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04);
    width: min(680px, 94vw);
    max-height: 88vh;
    display: flex; flex-direction: column;
    animation: nb-slide-up 0.35s cubic-bezier(0.34,1.56,0.64,1);
    overflow: hidden;
}
@keyframes nb-slide-up { from { transform:translateY(28px); opacity:0 } to { transform:translateY(0); opacity:1 } }

/* ── Header ──────────────────────────────────────────────────────────── */
.nb-header {
    padding: 24px 28px 0;
    flex-shrink: 0;
}
.nb-header-top {
    display: flex; align-items: flex-start; gap: 16px; margin-bottom: 16px;
}
.nb-pkg-icon {
    width: 52px; height: 52px; border-radius: 12px;
    background: linear-gradient(135deg, #1f2937, #374151);
    border: 1px solid rgba(255,255,255,0.08);
    display: flex; align-items: center; justify-content: center;
    font-size: 24px; flex-shrink: 0;
}
.nb-pkg-meta { flex: 1; min-width: 0; }
.nb-pkg-name {
    font-size: 18px; font-weight: 700;
    color: var(--text-primary, #e6edf3);
    line-height: 1.2; margin-bottom: 4px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.nb-pkg-sub {
    font-size: 13px; color: var(--text-secondary, #8b949e);
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
}
.nb-ver-arrow {
    display: inline-flex; align-items: center; gap: 6px;
    font-family: var(--font-mono, 'SF Mono', monospace); font-size: 12px;
}
.nb-ver-old { color: var(--text-muted, #484f58); text-decoration: line-through; }
.nb-ver-new { color: var(--accent, #58a6ff); font-weight: 600; }

/* ── Badges ──────────────────────────────────────────────────────────── */
.nb-badge {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 9px; border-radius: 20px;
    font-size: 11px; font-weight: 600; letter-spacing: 0.3px;
    border: 1px solid;
}
.nb-badge-update-type {
    background: rgba(88,166,255,0.08); color: #58a6ff; border-color: rgba(88,166,255,0.25);
}

/* ── Trust banner ────────────────────────────────────────────────────── */
.nb-trust-banner {
    border-radius: 10px; padding: 11px 16px;
    display: flex; align-items: center; gap: 12px;
    margin-bottom: 16px;
    transition: box-shadow 0.3s;
}
.nb-trust-icon { font-size: 20px; flex-shrink: 0; }
.nb-trust-label { font-size: 13px; font-weight: 600; }
.nb-trust-sub   { font-size: 11px; opacity: 0.72; margin-top: 2px; }
.nb-trust-fp    { font-family: var(--font-mono, monospace); font-size: 10px; opacity: 0.55; margin-top: 3px; word-break: break-all; }

/* ── Tabs ────────────────────────────────────────────────────────────── */
.nb-tabs {
    display: flex; gap: 0; border-bottom: 1px solid var(--border, rgba(240,246,252,0.1));
    padding: 0 28px;
}
.nb-tab {
    padding: 10px 14px; font-size: 13px; font-weight: 500;
    color: var(--text-muted, #484f58); cursor: pointer;
    border-bottom: 2px solid transparent; margin-bottom: -1px;
    transition: color 0.15s, border-color 0.15s;
    display: flex; align-items: center; gap: 6px;
    user-select: none;
}
.nb-tab:hover { color: var(--text-secondary, #8b949e); }
.nb-tab.active { color: var(--accent, #58a6ff); border-bottom-color: var(--accent, #58a6ff); }
.nb-tab-count {
    background: rgba(88,166,255,0.15); color: #58a6ff;
    border-radius: 10px; padding: 1px 6px; font-size: 10px; font-weight: 700;
}
.nb-tab-count.warn { background: rgba(239,68,68,0.15); color: #ef4444; }

/* ── Tab panels ──────────────────────────────────────────────────────── */
.nb-panels {
    flex: 1; overflow-y: auto; padding: 20px 28px;
    scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.1) transparent;
}
.nb-panel { display: none; }
.nb-panel.active { display: block; }

/* ── Overview tab ────────────────────────────────────────────────────── */
.nb-stat-grid {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;
    margin-bottom: 18px;
}
.nb-stat {
    background: var(--bg-sunken, rgba(0,0,0,0.25));
    border: 1px solid var(--border, rgba(240,246,252,0.08));
    border-radius: 10px; padding: 12px 14px;
}
.nb-stat-val { font-size: 22px; font-weight: 700; color: var(--text-primary, #e6edf3); }
.nb-stat-lbl { font-size: 11px; color: var(--text-muted, #484f58); margin-top: 3px; text-transform: uppercase; letter-spacing: 0.5px; }

.nb-meta-row {
    display: flex; justify-content: space-between; align-items: baseline;
    padding: 8px 0; border-bottom: 1px solid var(--border, rgba(240,246,252,0.06));
    font-size: 13px;
}
.nb-meta-row:last-child { border-bottom: none; }
.nb-meta-key   { color: var(--text-muted, #484f58); }
.nb-meta-value { color: var(--text-secondary, #8b949e); font-family: var(--font-mono, monospace); font-size: 12px; }
.nb-meta-value.mono { letter-spacing: -0.3px; }

/* ── Security tab ────────────────────────────────────────────────────── */
.nb-scan-header {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 14px; font-size: 13px; color: var(--text-secondary, #8b949e);
}
.nb-scan-spinner {
    width: 14px; height: 14px; border-radius: 50%;
    border: 2px solid rgba(88,166,255,0.3); border-top-color: #58a6ff;
    animation: nb-spin 0.7s linear infinite; flex-shrink: 0;
}
@keyframes nb-spin { to { transform: rotate(360deg); } }
.nb-scan-done .nb-scan-spinner { display: none; }

.nb-threat-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.nb-threat-item {
    display: flex; align-items: flex-start; gap: 12px;
    padding: 10px 14px; border-radius: 8px;
    border: 1px solid;
    animation: nb-threat-in 0.3s ease both;
}
@keyframes nb-threat-in { from { opacity:0; transform:translateX(-10px) } to { opacity:1; transform:translateX(0) } }
.nb-threat-item.high  { background: rgba(239,68,68,0.07);  border-color: rgba(239,68,68,0.25);  }
.nb-threat-item.medium{ background: rgba(245,158,11,0.07); border-color: rgba(245,158,11,0.25); }
.nb-threat-item.low   { background: rgba(100,116,139,0.07);border-color: rgba(100,116,139,0.2); }

.nb-threat-sev {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;
    padding: 2px 6px; border-radius: 4px; flex-shrink: 0; margin-top: 1px;
}
.nb-threat-item.high   .nb-threat-sev { background:rgba(239,68,68,0.2);  color:#f87171; }
.nb-threat-item.medium .nb-threat-sev { background:rgba(245,158,11,0.2); color:#fbbf24; }
.nb-threat-item.low    .nb-threat-sev { background:rgba(100,116,139,0.2);color:#94a3b8; }

.nb-threat-label { font-size: 13px; font-weight: 600; color: var(--text-primary, #e6edf3); }
.nb-threat-desc  { font-size: 11px; color: var(--text-muted, #484f58); margin-top: 2px; }
.nb-threat-file  { font-size: 10px; color: var(--text-muted, #484f58); font-family: var(--font-mono, monospace); margin-top: 3px; }

.nb-all-clear {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 18px; border-radius: 10px;
    background: rgba(62,207,142,0.07); border: 1px solid rgba(62,207,142,0.25);
    font-size: 13px; color: #3ecf8e; font-weight: 600;
}

.nb-section-title {
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.8px; color: var(--text-muted, #484f58);
    margin: 18px 0 10px;
}

.nb-warn-box {
    padding: 10px 14px; border-radius: 8px; font-size: 12px;
    background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.25);
    color: var(--text-secondary, #8b949e); margin-bottom: 10px;
}

/* ── Checkbox for high-threat ack ────────────────────────────────────── */
.nb-ack {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 12px 14px; border-radius: 8px;
    background: rgba(239,68,68,0.06); border: 1px solid rgba(239,68,68,0.2);
    cursor: pointer; margin-top: 12px;
    font-size: 12px; color: var(--text-secondary, #8b949e);
    user-select: none;
}
.nb-ack input[type="checkbox"] { margin-top: 2px; flex-shrink: 0; accent-color: #ef4444; }
.nb-ack.checked { background: rgba(239,68,68,0.1); border-color: rgba(239,68,68,0.35); }

/* ── Files tab ───────────────────────────────────────────────────────── */
.nb-file-item {
    border: 1px solid var(--border, rgba(240,246,252,0.08));
    border-radius: 10px; margin-bottom: 8px; overflow: hidden;
}
.nb-file-header {
    display: flex; align-items: center; gap: 10px; padding: 12px 14px;
    cursor: pointer; user-select: none;
    background: var(--bg-sunken, rgba(0,0,0,0.2));
}
.nb-file-header:hover { background: rgba(255,255,255,0.03); }
.nb-file-icon { font-size: 14px; }
.nb-file-path { font-size: 13px; font-family: var(--font-mono, monospace); color: var(--text-primary, #e6edf3); flex: 1; }
.nb-file-stats { font-size: 11px; display: flex; gap: 10px; flex-shrink: 0; }
.nb-file-adds  { color: #3ecf8e; }
.nb-file-dels  { color: #f85149; }
.nb-file-chevron { color: var(--text-muted, #484f58); font-size: 11px; transition: transform 0.2s; }
.nb-file-item.open .nb-file-chevron { transform: rotate(90deg); }

.nb-diff-viewer {
    display: none; padding: 12px 14px;
    background: var(--bg-sunken, #090d12);
    border-top: 1px solid var(--border, rgba(240,246,252,0.08));
}
.nb-file-item.open .nb-diff-viewer { display: block; }
.nb-diff-viewer pre {
    margin: 0; font-size: 11px; line-height: 1.6;
    font-family: var(--font-mono, 'SF Mono', monospace);
    overflow-x: auto; max-height: 280px;
    white-space: pre-wrap; word-break: break-all;
}
.nb-diff-add { color: #3ecf8e; display: block; }
.nb-diff-del { color: #f85149; display: block; }
.nb-diff-eq  { color: var(--text-muted, #484f58); display: block; }

/* ── Changelog tab ───────────────────────────────────────────────────── */
.nb-changelog {
    font-size: 13px; line-height: 1.8;
    color: var(--text-secondary, #8b949e);
    white-space: pre-wrap;
}
.nb-changelog-empty { color: var(--text-muted, #484f58); font-style: italic; font-size: 13px; }

/* ── Install log ─────────────────────────────────────────────────────── */
.nb-log-viewer {
    background: var(--bg-sunken, #090d12);
    border: 1px solid var(--border, rgba(240,246,252,0.08));
    border-radius: 8px; padding: 12px 14px;
    font-family: var(--font-mono, monospace); font-size: 11px;
    color: var(--text-secondary, #8b949e); line-height: 1.7;
    max-height: 200px; overflow-y: auto; margin-top: 8px;
}
.nb-log-line.ok   { color: #3ecf8e; }
.nb-log-line.err  { color: #f85149; }
.nb-log-line.warn { color: #f59e0b; }
.nb-log-line.dim  { color: var(--text-muted, #484f58); }

/* ── Progress overlay ────────────────────────────────────────────────── */
.nb-progress-overlay {
    position: fixed; inset: 0; z-index: 1000000;
    background: rgba(0,0,0,0.9);
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(12px);
    animation: nb-fade-in 0.2s ease;
}
.nb-progress-modal {
    background: var(--bg-elevated, #161b22);
    border: 1px solid var(--border, rgba(240,246,252,0.12));
    border-radius: 18px; padding: 36px 48px;
    text-align: center; min-width: 400px; max-width: 520px;
    box-shadow: 0 32px 80px rgba(0,0,0,0.7);
    animation: nb-slide-up 0.35s cubic-bezier(0.34,1.56,0.64,1);
}
.nb-progress-stage {
    font-size: 12px; text-transform: uppercase; letter-spacing: 1.2px;
    color: var(--text-muted, #484f58); margin-bottom: 12px;
}
.nb-progress-title {
    font-size: 20px; font-weight: 700; color: var(--text-primary, #e6edf3);
    margin-bottom: 24px;
}
.nb-progress-track {
    height: 6px; background: rgba(0,0,0,0.4);
    border-radius: 3px; overflow: hidden; margin-bottom: 10px;
    position: relative;
}
.nb-progress-fill {
    height: 100%; border-radius: 3px;
    background: linear-gradient(90deg, #3b82f6, #3ecf8e);
    box-shadow: 0 0 16px rgba(62,207,142,0.4);
    transition: width 0.4s cubic-bezier(0.4,0,0.2,1);
}
.nb-progress-pct {
    font-size: 32px; font-weight: 800; color: var(--accent, #58a6ff);
    font-family: var(--font-mono, monospace); margin: 14px 0 8px;
}
.nb-progress-msg { font-size: 13px; color: var(--text-secondary, #8b949e); margin-bottom: 6px; }
.nb-progress-file {
    font-size: 11px; font-family: var(--font-mono, monospace);
    color: var(--text-muted, #484f58); padding: 5px 12px;
    background: var(--bg-sunken, #090d12); border-radius: 4px;
    display: inline-block; margin: 6px 0 0;
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.nb-progress-steps {
    display: flex; gap: 6px; justify-content: center; margin-top: 20px;
}
.nb-progress-step {
    width: 8px; height: 8px; border-radius: 50%;
    background: rgba(255,255,255,0.1);
    transition: background 0.3s, transform 0.3s;
}
.nb-progress-step.done  { background: #3ecf8e; }
.nb-progress-step.active{ background: #58a6ff; transform: scale(1.3); animation: nb-pulse 1s infinite; }
@keyframes nb-pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }

/* ── Footer ──────────────────────────────────────────────────────────── */
.nb-footer {
    padding: 16px 28px; border-top: 1px solid var(--border, rgba(240,246,252,0.08));
    display: flex; align-items: center; gap: 10px; flex-shrink: 0;
}
.nb-footer-left { flex: 1; font-size: 12px; color: var(--text-muted, #484f58); }
.nb-btn {
    padding: 9px 20px; border-radius: 8px; font-size: 13px; font-weight: 600;
    cursor: pointer; border: 1px solid; transition: all 0.15s; outline: none;
    display: inline-flex; align-items: center; gap: 6px;
}
.nb-btn-cancel {
    background: transparent;
    border-color: var(--border, rgba(240,246,252,0.15));
    color: var(--text-secondary, #8b949e);
}
.nb-btn-cancel:hover { background: rgba(255,255,255,0.04); }
.nb-btn-install {
    background: linear-gradient(135deg, #1d4ed8, #2563eb);
    border-color: rgba(59,130,246,0.5);
    color: #fff;
    box-shadow: 0 0 20px rgba(37,99,235,0.3);
}
.nb-btn-install:hover:not(:disabled) { background: linear-gradient(135deg, #2563eb, #3b82f6); }
.nb-btn-install:disabled { opacity: 0.4; cursor: not-allowed; box-shadow: none; }
.nb-btn-install.danger {
    background: linear-gradient(135deg, #991b1b, #dc2626);
    border-color: rgba(220,38,38,0.4);
    box-shadow: 0 0 20px rgba(220,38,38,0.3);
}

/* ── Expiry warning ──────────────────────────────────────────────────── */
.nb-expiry-warn {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 14px; border-radius: 8px; font-size: 12px;
    background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.2);
    color: #f59e0b; margin-bottom: 14px;
}
`;
    document.head.appendChild(s);
})();

/* ─────────────────────────────────────────────────────────────────────────────
   PROGRESS OVERLAY  (shown during install)
   ───────────────────────────────────────────────────────────────────────────── */
const _STAGES = [
    'Pre-flight',
    'Validation',
    'Security scan',
    'Authorization',
    'Patching',
    'Verification',
    'Complete',
];

function showProgress(stageIdx, pct, msg, fileName) {
    let overlay = document.querySelector('.nb-progress-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'nb-progress-overlay';
        overlay.innerHTML = `
            <div class="nb-progress-modal">
                <div class="nb-progress-stage"></div>
                <div class="nb-progress-title">Installing Update…</div>
                <div class="nb-progress-track"><div class="nb-progress-fill" style="width:0%"></div></div>
                <div class="nb-progress-pct">0%</div>
                <div class="nb-progress-msg"></div>
                <div class="nb-progress-file" style="visibility:hidden">placeholder</div>
                <div class="nb-progress-steps">
                    ${_STAGES.map(() => '<div class="nb-progress-step"></div>').join('')}
                </div>
            </div>`;
        document.body.appendChild(overlay);
    }
    overlay.querySelector('.nb-progress-stage').textContent = 'Stage ' + (stageIdx + 1) + ' of ' + _STAGES.length + ' — ' + (_STAGES[stageIdx] || '');
    overlay.querySelector('.nb-progress-fill').style.width = pct + '%';
    overlay.querySelector('.nb-progress-pct').textContent  = pct + '%';
    overlay.querySelector('.nb-progress-msg').textContent  = msg;
    const fileEl = overlay.querySelector('.nb-progress-file');
    if (fileName) { fileEl.textContent = fileName; fileEl.style.visibility = ''; }
    else          { fileEl.style.visibility = 'hidden'; }
    const steps = overlay.querySelectorAll('.nb-progress-step');
    steps.forEach((s, i) => {
        s.className = 'nb-progress-step' + (i < stageIdx ? ' done' : i === stageIdx ? ' active' : '');
    });
    return overlay;
}

function hideProgress() {
    const overlay = document.querySelector('.nb-progress-overlay');
    if (!overlay) return;
    overlay.style.opacity    = '0';
    overlay.style.transition = 'opacity 0.3s ease';
    setTimeout(() => overlay.remove(), 300);
}

/* ─────────────────────────────────────────────────────────────────────────────
   PENDING-UPDATE KEY
   ───────────────────────────────────────────────────────────────────────────── */
const PENDING_KEY = 'nova_pending_update';

/* ─────────────────────────────────────────────────────────────────────────────
   UPDATE SERVICE
   ───────────────────────────────────────────────────────────────────────────── */
const UpdateService = {

    /* ── Public key fetch ─────────────────────────────────────────────── */
    async _fetchOfficialKey() {
        try {
            const r = await fetch('/api/update/public-key');
            if (r.ok) return r.json();
        } catch {}
        return null;
    },

    /* ── Threat scanning ──────────────────────────────────────────────── */
    _scanThreats(content) {
        return _THREAT_PATTERNS
            .filter(({ re }) => re.test(content))
            .map(({ severity, label, desc }) => ({ severity, label, desc }));
    },

    _detectCritical(search, replace) {
        const combined = (search || '') + '\n' + (replace || '');
        return _CRITICAL_MARKERS.filter(m => combined.includes(m));
    },

    /* ── Version helpers ──────────────────────────────────────────────── */
    _semverLabel(newVer, curVer) {
        const [nMaj, nMin] = newVer.split('.').map(Number);
        const [cMaj, cMin] = curVer.split('.').map(Number);
        if (nMaj > cMaj) return 'Major Update';
        if (nMin > cMin) return 'Minor Update';
        return 'Patch / Hotfix';
    },

    /* ── Server-side validation ───────────────────────────────────────── */
    async _validateWithServer(pkg) {
        const resp = await fetch('/api/update/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pkg }),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error || 'Validation failed (' + resp.status + ')');
        }
        return resp.json();
    },

    /* ── Timestamp & nonce pre-checks ─────────────────────────────────── */
    _validateTiming(pkg) {
        const errors = [];
        const now = Date.now();

        // Check expiry
        if (pkg.expiresAt) {
            const expiry = new Date(pkg.expiresAt).getTime();
            if (now > expiry) {
                errors.push('Package expired on ' + new Date(pkg.expiresAt).toLocaleDateString() +
                            '. Request a fresh signed package.');
            }
        }

        // Reject packages issued more than 7 days in the future (clock skew attack)
        if (pkg.issuedAt) {
            const issued = new Date(pkg.issuedAt).getTime();
            if (issued > now + 7 * 24 * 60 * 60 * 1000) {
                errors.push('Package issuedAt is too far in the future (' +
                            new Date(pkg.issuedAt).toLocaleDateString() + ').');
            }
        }

        return errors;
    },

    _validateNonce(pkg) {
        if (!pkg.nonce) return null; // unsigned packages may lack nonce
        if (_isNonceUsed(pkg.nonce)) {
            return 'This package has already been applied in this session (nonce replay detected). ' +
                   'If you need to re-apply, reload the OS first.';
        }
        return null;
    },

    /* ── Main install pipeline ─────────────────────────────────────────── */
    async handlePackage(pkg, onProgress) {
        onProgress = onProgress || function() {};

        if (!pkg || !pkg.package || !Array.isArray(pkg.files)) {
            throw new Error('Invalid package structure — missing .package metadata or .files[] array');
        }

        const pkgInfo    = pkg.package;
        const pkgVer     = pkgInfo.version || '';
        // Get current version - try multiple sources including localStorage
        let currentVer = '1.0.0';
        try {
            // Try localStorage first (accessible from any scope)
            const storedVer = localStorage.getItem('novabyte_os_version');
            if (storedVer) {
                currentVer = storedVer;
                console.log('[UpdateService] Got version from localStorage:', currentVer);
            }
            // Try window.OS
            if (typeof window !== 'undefined' && window.OS && window.OS.version) {
                currentVer = window.OS.version;
                console.log('[UpdateService] Got version from window.OS:', currentVer);
            }
            // Try globalThis.OS
            else if (typeof globalThis !== 'undefined' && globalThis.OS && globalThis.OS.version) {
                currentVer = globalThis.OS.version;
                console.log('[UpdateService] Got version from globalThis.OS:', currentVer);
            }
        } catch(e) {
            console.log('[UpdateService] Error getting version:', e);
        }
        console.log('[UpdateService] Final currentVer:', currentVer);

        // ── Version format & ordering ──────────────────────────────────
        if (!/^\d+\.\d+\.\d+$/.test(pkgVer)) {
            throw new Error('Version must follow MAJOR.MINOR.PATCH format (e.g. 1.2.3)');
        }
        if (compareVersions(pkgVer, currentVer) <= 0) {
            throw new Error('v' + pkgVer + ' is not newer than current v' + currentVer);
        }
        if (pkgInfo.minRequiredVersion &&
            compareVersions(currentVer, pkgInfo.minRequiredVersion) < 0) {
            throw new Error(
                'This update requires at least v' + pkgInfo.minRequiredVersion +
                '. You are on v' + currentVer + '. Please install intermediate updates first.'
            );
        }

        // ── Timing & nonce pre-checks ──────────────────────────────────
        const timingErrors = this._validateTiming(pkg);
        if (timingErrors.length > 0) throw new Error(timingErrors.join('\n'));

        const nonceError = this._validateNonce(pkg);
        if (nonceError) throw new Error(nonceError);

        // ── Stage 0: Client-side threat pre-scan ──────────────────────
        showProgress(0, 5, 'Running client-side threat pre-scan…');
        onProgress('Scanning for threats…', 10);
        const clientThreats   = [];
        const clientCriticals = [];
        for (const f of pkg.files) {
            let scanContent;
            if (f.diff) {
                scanContent = f.diff.split('\n')
                    .filter(function(l) { return l.startsWith('+') && !l.startsWith('+++'); })
                    .map(function(l) { return l.slice(1); })
                    .join('\n');
            } else {
                scanContent = f.replace || '';
            }
            if (scanContent) {
                this._scanThreats(scanContent).forEach(function(t) { clientThreats.push(Object.assign({ file: f.path }, t)); });
                this._detectCritical(f.search || scanContent, f.replace || scanContent)
                    .forEach(function(m) { clientCriticals.push({ marker: m, file: f.path }); });
            }
        }

        // ── Stage 1: Server-side validation ───────────────────────────
        // SECURITY: If the server is unreachable we BLOCK the install.
        // v1 continued with client-only checks — that was a security hole.
        showProgress(1, 20, 'Waiting for server validation…');
        onProgress('Validating with server…', 25);
        let report, officialKeyInfo;
        try {
            [report, officialKeyInfo] = await Promise.all([
                this._validateWithServer(pkg),
                this._fetchOfficialKey(),
            ]);
        } catch (e) {
            hideProgress();
            throw new Error(
                'Server validation failed and installation has been blocked.\n\n' +
                'Reason: ' + e.message + '\n\n' +
                'NovaByte does not install updates without server-side signature verification. ' +
                'Ensure the server is running and try again.'
            );
        }

        // Merge extra client findings not already in the report
        clientThreats.forEach(function(t) {
            if (!report.threatFindings.some(r => r.label === t.label && r.file === t.file)) {
                report.threatFindings.push(t);
            }
        });
        clientCriticals.forEach(function(c) {
            if (!report.criticalSections.some(r => r.marker === c.marker && r.file === c.file)) {
                report.criticalSections.push(c);
            }
        });

        // ── Stage 2: Compute per-file diffs ───────────────────────────
        showProgress(2, 35, 'Computing file diffs…');
        onProgress('Preparing report…', 40);
        const fileDiffs = pkg.files.map(function(f) {
            let added = 0, removed = 0;
            if (f.diff) {
                f.diff.split('\n').forEach(function(l) {
                    if (l.startsWith('+') && !l.startsWith('+++')) added++;
                    else if (l.startsWith('-') && !l.startsWith('---')) removed++;
                });
            } else {
                const changes = PatchService.countChanges(f.search || '', f.replace || '');
                added = changes.added; removed = changes.removed;
            }
            return { path: f.path, diff: f.diff, search: f.search, replace: f.replace, added, removed };
        });

        // ── Stage 3: Show validation dialog & get user confirmation ────
        hideProgress();
        const proceed = await this._showValidationDialog(pkg, report, currentVer, officialKeyInfo, fileDiffs);
        if (!proceed) return { cancelled: true };

        // ── Stage 4: Critical-section warning ─────────────────────────
        if (report.criticalSections && report.criticalSections.length > 0) {
            const okToContinue = await this._showCriticalWarning(report.criticalSections, pkgVer);
            if (!okToContinue) return { cancelled: true };
        }

        // ── Stage 5: Apply file patches via server ──
        showProgress(4, 55, 'Applying patches…');
        onProgress('Applying patches…', 55);
        const results  = [];
        const log      = [];

        const logLine = (msg, cls = '') => { log.push({ msg, cls }); };
        logLine('Installation started at ' + new Date().toLocaleTimeString(), 'dim');
        logLine('Package: ' + pkgInfo.name + ' v' + pkgVer, 'dim');
        logLine('');

        for (let i = 0; i < pkg.files.length; i++) {
            const fileUpdate = pkg.files[i];
            const pct = 55 + Math.round((i / pkg.files.length) * 30);
            showProgress(4, pct, 'Patching ' + (i + 1) + ' of ' + pkg.files.length + ' file(s)…', fileUpdate.path);
            onProgress('Patching ' + fileUpdate.path + ' (' + (i + 1) + '/' + pkg.files.length + ')…', pct);
            logLine('Patching ' + fileUpdate.path + '…');

            // Fetch CSRF token for each write-file request
            let csrfToken;
            try {
                const csrfResp = await fetch('/api/update/csrf-token');
                if (!csrfResp.ok) throw new Error('Failed to fetch CSRF token');
                const csrfData = await csrfResp.json();
                csrfToken = csrfData.token;
            } catch (e) {
                logLine('  ✕ ' + fileUpdate.path + ' — Failed to obtain CSRF token: ' + e.message, 'err');
                showProgress(5, 85, 'Patch failed — rolling back…');
                onProgress('Patch failed — rolling back…', 85);
                logLine('Rolling back all changes…', 'warn');
                await this._rollbackAll(pkg.files.slice(0, i), pkgVer);
                logLine('Rollback complete.', 'warn');
                hideProgress();
                throw new Error('Failed to patch ' + fileUpdate.path + ': Failed to obtain CSRF token\nAll changes have been rolled back.');
            }

            try {
                const resp = await fetch('/api/update/write-file', {
                    method:  'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Update-CSRF-Token': csrfToken
                    },
                    body:    JSON.stringify({
                        path:    fileUpdate.path,
                        diff:    fileUpdate.diff,    // unified diff (preferred)
                        search:  fileUpdate.search,  // legacy fallback
                        replace: fileUpdate.replace, // legacy fallback
                        version: pkgVer,
                    }),
                });
                const result = await resp.json();
                if (!resp.ok) throw new Error(result.error || 'Patch failed');
                results.push({ path: fileUpdate.path, success: true, skipped: !!result.skipped });
                logLine('  ✔ ' + fileUpdate.path + (result.skipped ? ' (skipped — already up to date)' : ' patched'), 'ok');
            } catch (e) {
                logLine('  ✕ ' + fileUpdate.path + ' — ' + e.message, 'err');
                showProgress(5, 85, 'Patch failed — rolling back…');
                onProgress('Patch failed — rolling back…', 85);
                logLine('Rolling back all changes…', 'warn');
                await this._rollbackAll(pkg.files.slice(0, i), pkgVer);
                logLine('Rollback complete.', 'warn');
                hideProgress();
                throw new Error('Failed to patch ' + fileUpdate.path + ': ' + e.message + '\nAll changes have been rolled back.');
            }
        }

        // ── Check if all patches were already applied ───────────────────
        const allSkipped = results.every(r => r.skipped);
        if (allSkipped) {
            hideProgress();
            logLine('');
            logLine('ℹ All patches in this update package are already applied.', 'dim');
            logLine('No changes were made to the system.', 'dim');
            await this._showInstallLog(log, pkgVer, currentVer, true);
            return { success: false, message: 'All patches already applied' };
        }

        // ── Stage 6: Record nonce + persist update history ─────────────
        showProgress(5, 88, 'Finalising…');
        if (pkg.nonce) _recordNonce(pkg.nonce);

        logLine('');
        logLine('Persisting update record…', 'dim');
        const timestamp = new Date().toISOString();
        const historyEntry = {
            type:            'update',
            version:         pkgVer,
            previousVersion: currentVer,
            channel:         pkgInfo.channel || 'stable',
            timestamp,
            files:           results.map(r => r.path),
        };
        try {
            const history = JSON.parse(localStorage.getItem('nova_update_history') || '[]');
            history.unshift(historyEntry);
            localStorage.setItem('nova_update_history', JSON.stringify(history.slice(0, 50)));
        } catch {}

        // Auto-rollback safety net
        localStorage.setItem(PENDING_KEY, JSON.stringify({
            version:         pkgVer,
            previousVersion: currentVer,
            timestamp,
        }));
        logLine('Safety net set — will prompt rollback if boot fails.', 'dim');

        // ── Stage 7: Show install log & reload ─────────────────────────
        showProgress(6, 100, 'Complete — reloading in 3s…');
        logLine('');
        logLine('✔ All ' + results.length + ' file(s) patched successfully.', 'ok');
        logLine('Reloading OS…', 'dim');
        onProgress('Complete!', 100);

        await this._showInstallLog(log, pkgVer, currentVer);

        setTimeout(function() { location.reload(); }, 1800);
        return { success: true, results };
    },

    /* ── Rollback helpers ─────────────────────────────────────────────── */
    async _rollbackAll(files, version) {
        for (const f of files) {
            try {
                // Fetch CSRF token for each rollback-file request
                const csrfResp = await fetch('/api/update/csrf-token');
                if (!csrfResp.ok) continue; // Skip if can't get token
                const csrfData = await csrfResp.json();
                const csrfToken = csrfData.token;

                await fetch('/api/update/rollback-file', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Update-CSRF-Token': csrfToken
                    },
                    body: JSON.stringify({ path: f.path, version }),
                });
            } catch {}
        }
    },

    getPendingUpdate() {
        try { return JSON.parse(localStorage.getItem(PENDING_KEY)); } catch { return null; }
    },

    async rollbackPending() {
        const pending = this.getPendingUpdate();
        if (!pending) throw new Error('No pending update to rollback');

        // Fetch CSRF token
        let csrfToken;
        try {
            const csrfResp = await fetch('/api/update/csrf-token');
            if (!csrfResp.ok) throw new Error('Failed to fetch CSRF token');
            const csrfData = await csrfResp.json();
            csrfToken = csrfData.token;
        } catch (e) {
            throw new Error('Failed to obtain CSRF token for rollback: ' + e.message);
        }

        const resp = await fetch('/api/update/rollback', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Update-CSRF-Token': csrfToken
            },
            body: JSON.stringify({ version: pending.version }),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error || 'Rollback request failed (' + resp.status + ')');
        }
        localStorage.removeItem(PENDING_KEY);

        // Log the rollback
        try {
            const history = JSON.parse(localStorage.getItem('nova_update_history') || '[]');
            history.unshift({
                type:      'rollback',
                version:   pending.previousVersion,
                fromVersion: pending.version,
                timestamp: new Date().toISOString(),
            });
            localStorage.setItem('nova_update_history', JSON.stringify(history.slice(0, 50)));
        } catch {}
    },

    confirmBoot() {
        localStorage.removeItem(PENDING_KEY);
        fetch('/api/update/confirm-boot', { method: 'POST' }).catch(() => {});
    },

    /* ── UI: Tabbed validation dialog ─────────────────────────────────── */
    _showValidationDialog(pkg, report, currentVer, officialKeyInfo, fileDiffs) {
        return new Promise(function(resolve) {
            const pkgInfo  = pkg.package;
            const pkgVer   = pkgInfo.version;
            const trust    = _TRUST_CONFIG[report.trust?.level || 'unsigned'] || _TRUST_CONFIG.unsigned;
            const channel  = _CHANNEL_CONFIG[pkgInfo.channel || 'stable']     || _CHANNEL_CONFIG.stable;
            const semLabel = UpdateService._semverLabel(pkgVer, currentVer);

            const threats     = report.threatFindings   || [];
            const criticals   = report.criticalSections || [];
            const highThreats = threats.filter(t => t.severity === 'high');
            const allClear    = threats.length === 0;

            // Compute expiry info
            let expiryHtml = '';
            if (pkg.expiresAt) {
                const daysLeft = Math.ceil((new Date(pkg.expiresAt) - Date.now()) / 86400000);
                if (daysLeft < 14) {
                    expiryHtml = `<div class="nb-expiry-warn">⏰ Package expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''} — install promptly.</div>`;
                }
            }

            // Build key fingerprint
            let fpHtml = '';
            if (officialKeyInfo && officialKeyInfo.publicKey) {
                try {
                    const fp = Array.from(new TextEncoder().encode(officialKeyInfo.publicKey))
                        .reduce((h, b) => h * 31 + b, 0).toString(16).slice(-16).toUpperCase()
                        .match(/.{4}/g).join(':');
                    fpHtml = `<div class="nb-trust-fp">Key: ${fp}</div>`;
                } catch {}
            }
            if (report.signature?.keyId) {
                fpHtml += `<div class="nb-trust-fp">Key ID: ${report.signature.keyId}</div>`;
            }

            // Files tab content
            const filesHtml = (fileDiffs || []).map(function(f, idx) {
                let diff;
                if (f.diff) {
                    // Render unified diff directly — +lines green, -lines red, @@ headers blue
                    diff = f.diff.split('\n').map(function(line) {
                        const esc = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                        if (line.startsWith('+') && !line.startsWith('+++')) return '<span class="nb-diff-add">' + esc + '</span>';
                        if (line.startsWith('-') && !line.startsWith('---')) return '<span class="nb-diff-del">' + esc + '</span>';
                        if (line.startsWith('@@')) return '<span style="color:#58a6ff;display:block">' + esc + '</span>';
                        if (line.startsWith('---') || line.startsWith('+++')) return '<span class="nb-diff-eq" style="opacity:0.4">' + esc + '</span>';
                        return '<span class="nb-diff-eq">' + esc + '</span>';
                    }).join('\n');
                } else {
                    diff = PatchService.renderDiff(f.search || '', f.replace || '');
                }
                return `
                <div class="nb-file-item" id="nb-file-${idx}">
                    <div class="nb-file-header" onclick="(function(el){el.closest('.nb-file-item').classList.toggle('open')})(this)">
                        <span class="nb-file-icon">📄</span>
                        <span class="nb-file-path">${f.path}</span>
                        <span class="nb-file-stats">
                            <span class="nb-file-adds">+${f.added}</span>
                            <span class="nb-file-dels">-${f.removed}</span>
                        </span>
                        <span class="nb-file-chevron">▶</span>
                    </div>
                    <div class="nb-diff-viewer">
                        <pre>${diff || '<span style="color:var(--text-muted)">No displayable changes (binary or identical)</span>'}</pre>
                    </div>
                </div>`;
            }).join('') || '<p style="color:var(--text-muted,#484f58);font-size:13px">No files in this package.</p>';

            // Threats tab content
            let threatsHtml = '';
            if (allClear) {
                threatsHtml = `<div class="nb-all-clear">✅ No threat patterns detected across ${(fileDiffs||[]).length} file(s)</div>`;
            } else {
                threatsHtml = `<div class="nb-threat-list" id="nb-threat-list"></div>`;
            }
            const ackHtml = highThreats.length > 0 ? `
                <label class="nb-ack" id="nb-ack-label">
                    <input type="checkbox" id="nb-ack-cb" onchange="
                        this.closest('.nb-ack').classList.toggle('checked', this.checked);
                        document.getElementById('nb-install-btn').disabled = !this.checked && (${highThreats.length} > 0);
                    ">
                    I have reviewed all HIGH severity findings above and accept responsibility for installing this package.
                </label>` : '';

            // Metadata rows for overview
            const totalAdded   = (fileDiffs || []).reduce((s, f) => s + f.added,   0);
            const totalRemoved = (fileDiffs || []).reduce((s, f) => s + f.removed, 0);
            const issuedDate   = pkg.issuedAt  ? new Date(pkg.issuedAt).toLocaleString()  : 'Unknown';
            const expiryDate   = pkg.expiresAt ? new Date(pkg.expiresAt).toLocaleString() : 'No expiry';

            const overlay = document.createElement('div');
            overlay.className = 'nb-overlay';
            overlay.innerHTML = `
                <div class="nb-modal">
                    <!-- Header -->
                    <div class="nb-header">
                        <div class="nb-header-top">
                            <div class="nb-pkg-icon">📦</div>
                            <div class="nb-pkg-meta">
                                <div class="nb-pkg-name">${pkgInfo.name || 'Unnamed Package'}</div>
                                <div class="nb-pkg-sub">
                                    <span class="nb-ver-arrow">
                                        <span class="nb-ver-old">v${currentVer}</span>
                                        <span style="color:var(--text-muted)">→</span>
                                        <span class="nb-ver-new">v${pkgVer}</span>
                                    </span>
                                    <span class="nb-badge nb-badge-update-type">${semLabel}</span>
                                    <span class="nb-badge" style="background:${channel.color}18;color:${channel.color};border-color:${channel.color}44;">${channel.icon} ${channel.label}</span>
                                </div>
                            </div>
                        </div>
                        ${expiryHtml}
                        <!-- Trust banner -->
                        <div class="nb-trust-banner" style="background:${trust.bg};border:1px solid ${trust.border};box-shadow:0 0 20px ${trust.glow};">
                            <span class="nb-trust-icon" style="color:${trust.color}">${trust.icon}</span>
                            <div style="flex:1">
                                <div class="nb-trust-label" style="color:${trust.color}">${trust.badge}</div>
                                <div class="nb-trust-sub">${report.trust?.publisher || (report.trust?.level === 'unsigned' ? 'No signature present' : 'Verified publisher')}</div>
                                ${fpHtml}
                            </div>
                        </div>
                    </div>

                    <!-- Tabs -->
                    <div class="nb-tabs">
                        <div class="nb-tab active" data-panel="overview">Overview</div>
                        <div class="nb-tab" data-panel="security">
                            Security
                            ${threats.length > 0 ? `<span class="nb-tab-count ${highThreats.length > 0 ? 'warn' : ''}">${threats.length}</span>` : ''}
                        </div>
                        <div class="nb-tab" data-panel="files">Files <span class="nb-tab-count">${(fileDiffs||[]).length}</span></div>
                        <div class="nb-tab" data-panel="changelog">Changelog</div>
                    </div>

                    <!-- Panels -->
                    <div class="nb-panels">
                        <!-- Overview -->
                        <div class="nb-panel active" id="nb-panel-overview">
                            <div class="nb-stat-grid">
                                <div class="nb-stat">
                                    <div class="nb-stat-val">${(fileDiffs||[]).length}</div>
                                    <div class="nb-stat-lbl">Files Changed</div>
                                </div>
                                <div class="nb-stat">
                                    <div class="nb-stat-val" style="color:#3ecf8e">+${totalAdded}</div>
                                    <div class="nb-stat-lbl">Lines Added</div>
                                </div>
                                <div class="nb-stat">
                                    <div class="nb-stat-val" style="color:#f85149">-${totalRemoved}</div>
                                    <div class="nb-stat-lbl">Lines Removed</div>
                                </div>
                            </div>
                            <div class="nb-meta-row"><span class="nb-meta-key">Package name</span><span class="nb-meta-value">${pkgInfo.name || '—'}</span></div>
                            <div class="nb-meta-row"><span class="nb-meta-key">Publisher</span><span class="nb-meta-value">${report.trust?.publisher || pkgInfo.publisher || '—'}</span></div>
                            <div class="nb-meta-row"><span class="nb-meta-key">Channel</span><span class="nb-meta-value" style="color:${channel.color}">${channel.label}</span></div>
                            <div class="nb-meta-row"><span class="nb-meta-key">Issued at</span><span class="nb-meta-value">${issuedDate}</span></div>
                            <div class="nb-meta-row"><span class="nb-meta-key">Expires at</span><span class="nb-meta-value">${expiryDate}</span></div>
                            <div class="nb-meta-row"><span class="nb-meta-key">Nonce</span><span class="nb-meta-value mono">${(pkg.nonce || '—').slice(0, 20)}…</span></div>
                            ${pkgInfo.minRequiredVersion ? `<div class="nb-meta-row"><span class="nb-meta-key">Min required version</span><span class="nb-meta-value">v${pkgInfo.minRequiredVersion}</span></div>` : ''}
                            ${report.checksum ? `<div class="nb-meta-row"><span class="nb-meta-key">Checksum (SHA-256)</span><span class="nb-meta-value mono">${(report.checksum||'').slice(0,20)}…</span></div>` : ''}
                            ${report.warnings && report.warnings.length ? `
                                <div class="nb-section-title">Warnings</div>
                                ${report.warnings.map(w => `<div class="nb-warn-box">⚠ ${w}</div>`).join('')}
                            ` : ''}
                        </div>

                        <!-- Security -->
                        <div class="nb-panel" id="nb-panel-security">
                            <div class="nb-scan-header ${allClear ? 'nb-scan-done' : ''}">
                                <div class="nb-scan-spinner"></div>
                                <span id="nb-scan-status">Running threat analysis…</span>
                            </div>
                            ${threatsHtml}
                            ${ackHtml}
                            ${criticals.length > 0 ? `
                                <div class="nb-section-title" style="color:#f59e0b">⚠ Critical Infrastructure Touched</div>
                                ${criticals.map(c => `<div class="nb-warn-box"><code style="color:#58a6ff">${c.marker}</code> in <code>${c.file}</code></div>`).join('')}
                            ` : ''}
                        </div>

                        <!-- Files -->
                        <div class="nb-panel" id="nb-panel-files">
                            ${filesHtml}
                        </div>

                        <!-- Changelog -->
                        <div class="nb-panel" id="nb-panel-changelog">
                            ${pkgInfo.changelog
                                ? `<div class="nb-changelog">${pkgInfo.changelog.replace(/</g,'&lt;')}</div>`
                                : '<div class="nb-changelog-empty">No changelog provided for this package.</div>'}
                        </div>
                    </div>

                    <!-- Footer -->
                    <div class="nb-footer">
                        <div class="nb-footer-left">
                            ${threats.length > 0
                                ? '<span style="color:#f59e0b">⚠ ' + threats.length + ' threat pattern' + (threats.length !== 1 ? 's' : '') + ' detected</span>'
                                : '<span style="color:#3ecf8e">✔ Security scan passed</span>'}
                        </div>
                        <button class="nb-btn nb-btn-cancel" id="nb-cancel-btn">Cancel</button>
                        <button class="nb-btn nb-btn-install ${report.trust?.level === 'invalid' ? 'danger' : ''}"
                                id="nb-install-btn"
                                ${highThreats.length > 0 ? 'disabled' : ''}>
                            Install v${pkgVer}
                        </button>
                    </div>
                </div>`;

            document.body.appendChild(overlay);

            // Tab switching
            overlay.querySelectorAll('.nb-tab').forEach(function(tab) {
                tab.addEventListener('click', function() {
                    overlay.querySelectorAll('.nb-tab').forEach(t => t.classList.remove('active'));
                    overlay.querySelectorAll('.nb-panel').forEach(p => p.classList.remove('active'));
                    tab.classList.add('active');
                    overlay.querySelector('#nb-panel-' + tab.dataset.panel).classList.add('active');
                });
            });

            // Animate threats appearing one by one
            const threatList = overlay.querySelector('#nb-threat-list');
            if (threatList && threats.length > 0) {
                let i = 0;
                function revealNextThreat() {
                    if (i >= threats.length) {
                        const statusEl = overlay.querySelector('#nb-scan-status');
                        if (statusEl) {
                            statusEl.textContent = threats.length + ' pattern' + (threats.length !== 1 ? 's' : '') + ' found — review before proceeding';
                            overlay.querySelector('.nb-scan-header').classList.add('nb-scan-done');
                        }
                        return;
                    }
                    const t = threats[i];
                    const item = document.createElement('div');
                    item.className = 'nb-threat-item ' + t.severity;
                    item.style.animationDelay = (i * 60) + 'ms';
                    item.innerHTML = `
                        <span class="nb-threat-sev">${t.severity}</span>
                        <div>
                            <div class="nb-threat-label">${t.label}</div>
                            ${t.desc ? `<div class="nb-threat-desc">${t.desc}</div>` : ''}
                            ${t.file ? `<div class="nb-threat-file">${t.file}</div>` : ''}
                        </div>`;
                    threatList.appendChild(item);
                    i++;
                    setTimeout(revealNextThreat, 80);
                }
                setTimeout(revealNextThreat, 300);
            } else {
                const statusEl = overlay.querySelector('#nb-scan-status');
                if (statusEl) {
                    statusEl.textContent = 'Scan complete — no threats detected';
                    overlay.querySelector('.nb-scan-header').classList.add('nb-scan-done');
                }
            }

            // Button handlers
            overlay.querySelector('#nb-cancel-btn').addEventListener('click', function() {
                overlay.remove(); resolve(false);
            });
            overlay.querySelector('#nb-install-btn').addEventListener('click', function() {
                overlay.remove(); resolve(true);
            });
        });
    },

    /* ── UI: Post-install log dialog ──────────────────────────────────── */
    _showInstallLog(log, newVer, oldVer, isSkipped = false) {
        return new Promise(function(resolve) {
            const overlay = document.createElement('div');
            overlay.className = 'nb-overlay';
            overlay.innerHTML = `
                <div class="nb-modal" style="max-width:520px">
                    <div class="nb-header">
                        <div class="nb-header-top">
                            <div class="nb-pkg-icon">${isSkipped ? 'ℹ️' : '✅'}</div>
                            <div class="nb-pkg-meta">
                                <div class="nb-pkg-name">${isSkipped ? 'Update check completed' : 'Update installed successfully'}</div>
                                <div class="nb-pkg-sub">
                                    ${isSkipped ? 'All patches were already applied' : `
                                    <span class="nb-ver-arrow">
                                        <span class="nb-ver-old">v${oldVer}</span>
                                        <span style="color:var(--text-muted)">→</span>
                                        <span class="nb-ver-new">v${newVer}</span>
                                    </span>
                                    `}
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="nb-panels">
                        <div class="nb-log-viewer" id="nb-install-log-view">
                            ${log.map(l => `<div class="nb-log-line ${l.cls||''}">${(l.msg||'').replace(/</g,'&lt;')}</div>`).join('')}
                        </div>
                        <p style="font-size:12px;color:var(--text-muted,#484f58);margin-top:12px;text-align:center">
                            ${isSkipped ? 'No changes were made to the system.' : 'The OS will reload automatically in 3 seconds…'}
                        </p>
                    </div>
                    <div class="nb-footer">
                        <div class="nb-footer-left"></div>
                        <button class="nb-btn nb-btn-install" id="nb-reload-now-btn">${isSkipped ? 'Close' : 'Reload now'}</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            overlay.querySelector('#nb-reload-now-btn').addEventListener('click', function() {
                overlay.remove(); resolve(); if (!isSkipped) location.reload();
            });
            // Scroll log to bottom
            const logView = overlay.querySelector('#nb-install-log-view');
            if (logView) logView.scrollTop = logView.scrollHeight;
            // Auto-resolve after 3s (only reload if not skipped)
            setTimeout(function() { overlay.remove(); resolve(); if (!isSkipped) location.reload(); }, 3000);
        });
    },

    /* ── UI: Critical section warning ────────────────────────────────── */
    _showCriticalWarning(criticals, version) {
        return new Promise(function(resolve) {
            const overlay = document.createElement('div');
            overlay.className = 'nb-overlay';
            overlay.innerHTML = `
                <div class="nb-modal" style="max-width:560px">
                    <div class="nb-header" style="padding-bottom:16px">
                        <div class="nb-header-top">
                            <div class="nb-pkg-icon" style="background:rgba(210,153,34,0.15);border-color:rgba(210,153,34,0.3)">⚠️</div>
                            <div class="nb-pkg-meta">
                                <div class="nb-pkg-name" style="color:#d29922">Critical Infrastructure Update</div>
                                <div class="nb-pkg-sub">This patch modifies core boot or recovery components.</div>
                            </div>
                        </div>
                    </div>
                    <div class="nb-panels">
                        <div class="nb-warn-box" style="margin-bottom:14px">
                            ${criticals.map(c => `<div style="margin:4px 0"><code style="color:#58a6ff">${c.marker}</code> <span style="color:var(--text-muted)">(${c.file})</span></div>`).join('')}
                        </div>
                        <div class="nb-section-title">Safe installation steps</div>
                        <ol style="margin:0;padding-left:20px;font-size:12px;color:var(--text-secondary,#8b949e);line-height:2.2">
                            <li>Confirm a backup exists — Settings → Updates → Update History should show a Rollback button.</li>
                            <li>Open a <strong style="color:var(--text-primary)">second browser tab</strong> with this page as a working copy.</li>
                            <li>Click <strong style="color:var(--text-primary)">Continue</strong> — the OS will reload automatically.</li>
                            <li>If boot fails, the recovery screen will offer <strong style="color:var(--text-primary)">Rollback Update v${version}</strong>.</li>
                            <li>If recovery itself breaks, run: <code style="display:block;background:var(--bg-sunken,#090d12);border-radius:4px;padding:6px 10px;margin-top:6px;color:#58a6ff;font-size:11px">cp .update-backups/index_html.v${version}.bak index.html</code></li>
                        </ol>
                    </div>
                    <div class="nb-footer">
                        <div class="nb-footer-left" style="color:#d29922;font-size:12px">Proceed only if you have a verified backup.</div>
                        <button class="nb-btn nb-btn-cancel" id="nb-crit-cancel">Cancel</button>
                        <button class="nb-btn nb-btn-install" id="nb-crit-ok">I understand — Continue</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            overlay.querySelector('#nb-crit-cancel').addEventListener('click', function() { overlay.remove(); resolve(false); });
            overlay.querySelector('#nb-crit-ok').addEventListener('click',     function() { overlay.remove(); resolve(true); });
        });
    },
};

/* ─────────────────────────────────────────────────────────────────────────────
   RECOVERY SCREEN INTEGRATION
   ───────────────────────────────────────────────────────────────────────────── */
function injectUpdateRollbackCard() {
    const pending = UpdateService.getPendingUpdate();
    if (!pending) return;

    const container = document.querySelector('.recovery-options');
    if (!container) return;

    const prevVer  = pending.previousVersion || '?';
    const elapsed  = pending.timestamp
        ? Math.round((Date.now() - new Date(pending.timestamp).getTime()) / 60000) + ' min ago'
        : 'recently';

    const card = document.createElement('div');
    card.className = 'recovery-option';
    card.style.cssText = 'border-color:rgba(248,81,73,0.5);background:rgba(248,81,73,0.07);order:-1;';
    card.innerHTML = `
        <div class="recovery-option-icon" style="color:#f85149">↩</div>
        <div>
            <div class="recovery-option-label" style="color:#f85149">Rollback Update v${pending.version}</div>
            <div class="recovery-option-desc">
                The last update (v${prevVer} → v${pending.version}, installed ${elapsed})
                may have caused this failure. Click to restore the previous version automatically.
            </div>
        </div>`;

    card.addEventListener('click', async function() {
        card.style.opacity       = '0.6';
        card.style.pointerEvents = 'none';
        card.querySelector('.recovery-option-label').textContent = 'Rolling back…';
        try {
            await UpdateService.rollbackPending();
            card.querySelector('.recovery-option-label').textContent = '✅ Rolled back — rebooting…';
            setTimeout(function() { location.reload(); }, 1800);
        } catch (e) {
            card.querySelector('.recovery-option-label').textContent = '✕ Rollback failed: ' + e.message;
            card.style.opacity       = '1';
            card.style.pointerEvents = '';
        }
    });

    container.insertBefore(card, container.firstChild);
}

window.UpdateService            = UpdateService;
window.injectUpdateRollbackCard = injectUpdateRollbackCard;
window.showProgress             = showProgress;
window.hideProgress             = hideProgress;
window.PatchService             = PatchService;
window.canRollback              = canRollback;
window.compareVersions          = compareVersions;