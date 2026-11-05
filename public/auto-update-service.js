/**
 * NovaByte OS — Auto-Update Client Service  (js/auto-update-service.js)
 *
 * Drop this file into your js/ folder and add a script tag in index.html
 * AFTER update-service.js:
 *
 *   <script src="/js/auto-update-service.js"></script>
 *
 * This module wires together:
 *   • Periodic HTTP polling  →  GET /api/autoupdate/check
 *   • Socket.IO push         →  event: 'update:available'
 *   • User notification UI   →  toast + confirmation dialog
 *   • Installation           →  delegates to the existing UpdateService
 *
 * Settings keys used (in OS.settings):
 *   autoupdate_enabled      bool   default true
 *   autoupdate_channel      str    default 'stable'
 *   autoupdate_interval     int    check interval in minutes, default 30
 *   autoupdate_auto_install bool   silently install (no confirm), default false
 *   autoupdate_last_check   str    ISO timestamp of last successful check
 *   autoupdate_dismissed    str    version string last dismissed by user
 */

'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   GUARD — only run inside the OS environment, never inside NovaBox VM iframe
   ───────────────────────────────────────────────────────────────────────────── */
if (typeof window === 'undefined' || window !== window.top) {
    // Inside an iframe (NovaBox) — bail out silently
    /* no-op module */
} else {

const AutoUpdateService = (function () {
    'use strict';

    /* ── Defaults ─────────────────────────────────────────────────────────── */
    const DEFAULTS = {
        enabled:      true,
        channel:      'stable',
        intervalMins: 30,
        autoInstall:  false,
    };

    let _pollTimer    = null;
    let _lastVersion  = null;   // version string of the update shown to user
    let _notifEl      = null;   // the banner element currently in the DOM
    let _socketBound  = false;

    /* ── Helpers ──────────────────────────────────────────────────────────── */
    function getSetting(key, fallback) {
        try {
            if (typeof OS !== 'undefined' && OS.settings) {
                const v = OS.settings.get('autoupdate_' + key);
                return v !== null && v !== undefined ? v : fallback;
            }
        } catch {}
        return fallback;
    }

    function setSetting(key, value) {
        try {
            if (typeof OS !== 'undefined' && OS.settings) {
                OS.settings.set('autoupdate_' + key, value);
            }
        } catch {}
    }

    function currentOSVersion() {
        try {
            if (typeof OS !== 'undefined') return OS.version || '0.0.0';
        } catch {}
        return '0.0.0';
    }

    function semverGt(a, b) {
        const pa = String(a).split('.').map(Number);
        const pb = String(b).split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            if ((pa[i]||0) > (pb[i]||0)) return true;
            if ((pa[i]||0) < (pb[i]||0)) return false;
        }
        return false;
    }

    function humanBytes(n) {
        if (n < 1024)       return `${n} B`;
        if (n < 1024 ** 2)  return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / 1024 ** 2).toFixed(2)} MB`;
    }

    function humanTime(iso) {
        try {
            const ms  = Date.now() - new Date(iso).getTime();
            const min = Math.floor(ms / 60000);
            if (min < 1)   return 'just now';
            if (min < 60)  return `${min}m ago`;
            const hr = Math.floor(min / 60);
            if (hr < 24)   return `${hr}h ago`;
            return `${Math.floor(hr / 24)}d ago`;
        } catch { return ''; }
    }

    /* ── Channel badge colour ─────────────────────────────────────────────── */
    const CHANNEL_COLORS = {
        stable:  { bg: 'rgba(62,207,142,0.15)',  text: '#3ecf8e',  border: 'rgba(62,207,142,0.35)' },
        beta:    { bg: 'rgba(245,158,11,0.15)',  text: '#f59e0b',  border: 'rgba(245,158,11,0.35)' },
        nightly: { bg: 'rgba(167,139,250,0.15)', text: '#a78bfa',  border: 'rgba(167,139,250,0.35)' },
    };

    /* ── Trust badge colour ───────────────────────────────────────────────── */
    const TRUST_COLORS = {
        official:    { bg: 'rgba(62,207,142,0.12)',  text: '#3ecf8e' },
        community:   { bg: 'rgba(96,165,250,0.12)',  text: '#60a5fa' },
        unsigned:    { bg: 'rgba(156,163,175,0.10)', text: '#9ca3af' },
        unknown:     { bg: 'rgba(156,163,175,0.10)', text: '#9ca3af' },
    };

    /* ─────────────────────────────────────────────────────────────────────────
       NOTIFICATION BANNER
       ───────────────────────────────────────────────────────────────────────── */
    function _dismissBanner() {
        if (!_notifEl) return;
        _notifEl.style.transform  = 'translateX(calc(100% + 20px))';
        _notifEl.style.opacity    = '0';
        setTimeout(() => { _notifEl?.remove(); _notifEl = null; }, 350);
    }

    function _showBanner(meta) {
        // Remove any existing banner
        _dismissBanner();

        const ch     = meta.channel || 'stable';
        const cc     = CHANNEL_COLORS[ch]  || CHANNEL_COLORS.stable;
        const tc     = TRUST_COLORS[meta.trust] || TRUST_COLORS.unknown;
        const size   = meta.sizeBytes ? humanBytes(meta.sizeBytes) : '';
        const age    = meta.publishedAt ? humanTime(meta.publishedAt) : '';
        const chIcon = { stable: '●', beta: '◐', nightly: '◑' }[ch] || '○';

        const banner = document.createElement('div');
        banner.id = 'autoupdate-banner';
        banner.style.cssText = `
            position: fixed;
            bottom: 68px;
            right: 16px;
            z-index: 99993;
            width: 340px;
            background: rgba(10, 14, 22, 0.82);
            border: 1px solid rgba(255,255,255,0.14);
            border-radius: 14px;
            box-shadow: 0 24px 48px rgba(0,0,0,0.55), 0 4px 16px rgba(0,0,0,0.30),
                        inset 0 1px 0 rgba(255,255,255,0.10);
            backdrop-filter: blur(32px) saturate(180%);
            -webkit-backdrop-filter: blur(32px) saturate(180%);
            padding: 16px;
            font-family: system-ui, -apple-system, sans-serif;
            color: #e6edf3;
            transform: translateX(calc(100% + 20px));
            opacity: 0;
            transition: transform 360ms cubic-bezier(0.34,1.56,0.64,1), opacity 280ms ease;
            user-select: none;
        `;

        banner.innerHTML = `
            <!-- Header row -->
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
                <div style="
                    width:36px;height:36px;border-radius:10px;flex-shrink:0;
                    background:rgba(88,166,255,0.12);border:1px solid rgba(88,166,255,0.25);
                    display:flex;align-items:center;justify-content:center;font-size:16px;
                ">🔄</div>
                <div style="flex:1;min-width:0;">
                    <div style="font-size:13px;font-weight:600;color:#e6edf3;">Update Available</div>
                    <div style="font-size:11px;color:#8b949e;margin-top:1px;">NovaByte OS v${meta.version}</div>
                </div>
                <button id="au-dismiss" style="
                    background:none;border:none;color:#484f58;cursor:pointer;
                    width:24px;height:24px;display:flex;align-items:center;justify-content:center;
                    border-radius:4px;font-size:16px;line-height:1;flex-shrink:0;
                " title="Dismiss">×</button>
            </div>

            <!-- Badges row -->
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
                <span style="
                    display:inline-flex;align-items:center;gap:4px;
                    padding:3px 8px;border-radius:20px;font-size:10px;font-weight:700;
                    background:${cc.bg};color:${cc.text};border:1px solid ${cc.border};
                ">${chIcon} ${ch.charAt(0).toUpperCase() + ch.slice(1)}</span>
                <span style="
                    padding:3px 8px;border-radius:20px;font-size:10px;font-weight:600;
                    background:${tc.bg};color:${tc.text};
                ">${meta.trust === 'official' ? '✦ Official' : meta.trust === 'community' ? '◈ Community' : '○ Unsigned'}</span>
                ${size ? `<span style="padding:3px 8px;border-radius:20px;font-size:10px;background:rgba(255,255,255,0.06);color:#8b949e;">${size}</span>` : ''}
                ${age  ? `<span style="padding:3px 8px;border-radius:20px;font-size:10px;background:rgba(255,255,255,0.06);color:#8b949e;">${age}</span>` : ''}
            </div>

            <!-- Description / changelog preview -->
            ${meta.description ? `<div style="font-size:12px;color:#8b949e;margin-bottom:10px;line-height:1.5;">${meta.description}</div>` : ''}
            ${meta.changelog ? `
                <div style="
                    font-size:11px;color:#8b949e;background:rgba(0,0,0,0.25);
                    border:1px solid rgba(255,255,255,0.06);border-radius:7px;
                    padding:8px 10px;margin-bottom:12px;max-height:72px;overflow-y:auto;
                    line-height:1.7;white-space:pre-wrap;font-family:monospace;
                ">${meta.changelog.slice(0, 400)}${meta.changelog.length > 400 ? '…' : ''}</div>
            ` : ''}

            <!-- Action buttons -->
            <div style="display:flex;gap:8px;">
                <button id="au-later" style="
                    flex:1;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);
                    background:rgba(255,255,255,0.06);color:#8b949e;font-size:12px;
                    cursor:pointer;font-weight:500;transition:all 0.15s;
                ">Later</button>
                <button id="au-install" style="
                    flex:2;padding:8px;border-radius:8px;border:none;
                    background:linear-gradient(135deg,#58a6ff,#a371f7);
                    color:#fff;font-size:12px;cursor:pointer;font-weight:600;
                    transition:opacity 0.15s;
                ">Install Update</button>
            </div>
        `;

        document.body.appendChild(banner);
        _notifEl = banner;

        // Animate in
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                banner.style.transform = 'translateX(0)';
                banner.style.opacity   = '1';
            });
        });

        // Wire buttons
        banner.querySelector('#au-dismiss').addEventListener('click', () => {
            setSetting('dismissed', meta.version);
            _dismissBanner();
        });
        banner.querySelector('#au-later').addEventListener('click', () => {
            // Snooze for 2 hours — reset check timer
            setSetting('dismissed', meta.version);
            _dismissBanner();
            // Reschedule a single check in 2h
            setTimeout(() => {
                setSetting('dismissed', null);
                AutoUpdateService.check();
            }, 2 * 60 * 60 * 1000);
        });
        banner.querySelector('#au-install').addEventListener('click', async () => {
            const btn = banner.querySelector('#au-install');
            btn.disabled    = true;
            btn.textContent = 'Downloading…';
            btn.style.opacity = '0.6';
            try {
                await _downloadAndInstall(meta);
            } catch (e) {
                btn.disabled    = false;
                btn.textContent = '✕ Failed — Retry';
                btn.style.opacity = '1';
                btn.style.background = 'rgba(248,81,73,0.18)';
                btn.style.color = '#f85149';
                // Show error toast via OS notification system if available
                if (typeof Notify !== 'undefined') {
                    Notify.show({ title: 'Update Failed', body: e.message, type: 'error', appName: 'System Update' });
                }
            }
        });

        // Auto-dismiss after 60 s if user doesn't interact
        setTimeout(() => {
            if (_notifEl === banner) _dismissBanner();
        }, 60000);
    }

    /* ─────────────────────────────────────────────────────────────────────────
       DOWNLOAD & INSTALL
       ───────────────────────────────────────────────────────────────────────── */
    async function _downloadAndInstall(meta) {
        const channel = meta.channel || getSetting('channel', DEFAULTS.channel);

        // Fetch full package
        const res = await fetch(`/api/autoupdate/package?channel=${encodeURIComponent(channel)}`, {
            credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
        const pkg = await res.json();

        // Verify checksum matches what we were told in /check
        if (meta.checksum) {
            const pkgStr  = JSON.stringify(pkg);
            const encoded = new TextEncoder().encode(pkgStr);
            let hash;
            try {
                const buf = await crypto.subtle.digest('SHA-256', encoded);
                hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
            } catch {
                // crypto.subtle not available (http?) — skip checksum
            }
            if (hash && hash !== meta.checksum) {
                throw new Error('Package checksum mismatch — download may be corrupted or tampered');
            }
        }

        _dismissBanner();

        // Delegate to the existing UpdateService installer
        if (typeof UpdateService !== 'undefined' && typeof UpdateService.install === 'function') {
            await UpdateService.install(pkg);
        } else {
            throw new Error('UpdateService is not available — please refresh and try again');
        }
    }

    /* ─────────────────────────────────────────────────────────────────────────
       CHECK  — calls /api/autoupdate/check and shows banner if needed
       ───────────────────────────────────────────────────────────────────────── */
    async function check() {
        const result = { available: false, version: null, channel: null };
        if (!getSetting('enabled', DEFAULTS.enabled)) return result;

        const channel   = getSetting('channel', DEFAULTS.channel);
        const myVersion = currentOSVersion();
        const dismissed = getSetting('dismissed', null);

        try {
            const res = await fetch(
                `/api/autoupdate/check?channel=${encodeURIComponent(channel)}&version=${encodeURIComponent(myVersion)}`,
                { credentials: 'same-origin' }
            );
            if (!res.ok) return result;
            const data = await res.json();

            setSetting('last_check', new Date().toISOString());

            if (!data.available) return result;

            // Skip if user already dismissed this exact version
            if (dismissed && dismissed === data.version) return result;

            // Skip if same version banner already showing
            if (_lastVersion === data.version && _notifEl) return result;

            _lastVersion = data.version;

            const autoInstall = getSetting('auto_install', DEFAULTS.autoInstall);
            if (autoInstall) {
                // Silent auto-install — just do it
                try {
                    await _downloadAndInstall(data);
                } catch (e) {
                    console.error('[AutoUpdate] Silent install failed:', e.message);
                    // Fall back to showing the banner
                    _showBanner(data);
                }
            } else {
                _showBanner(data);
            }

            // Return the result with available data
            return { available: true, version: data.version, channel: data.channel };

        } catch (e) {
            // Network error — swallow silently (server might be offline)
            console.debug('[AutoUpdate] Check failed:', e.message);
        }
    }

    /* ─────────────────────────────────────────────────────────────────────────
       SOCKET.IO PUSH  — instant notification when admin publishes
       ───────────────────────────────────────────────────────────────────────── */
    function _bindSocket() {
        if (_socketBound) return;
        // io() is available when socket-client.js is loaded
        try {
            const socket = typeof io !== 'undefined' ? io() : null;
            if (!socket) return;

            socket.on('update:available', (meta) => {
                console.log('[AutoUpdate] Push notification received: v' + meta.version);
                // Treat exactly like a successful /check response
                const dismissed = getSetting('dismissed', null);
                if (dismissed && dismissed === meta.version) return;
                _lastVersion = meta.version;

                const autoInstall = getSetting('auto_install', DEFAULTS.autoInstall);
                if (autoInstall) {
                    _downloadAndInstall(meta).catch(e => {
                        console.error('[AutoUpdate] Silent install (push) failed:', e.message);
                        _showBanner(meta);
                    });
                } else {
                    _showBanner(meta);
                }
            });

            socket.on('update:retracted', ({ channel, version }) => {
                if (_lastVersion === version && _notifEl) {
                    _dismissBanner();
                    _lastVersion = null;
                    if (typeof Notify !== 'undefined') {
                        Notify.show({
                            title: 'Update Retracted',
                            body: `v${version} was pulled by the developer.`,
                            type: 'warning',
                            appName: 'System Update',
                        });
                    }
                }
            });

            _socketBound = true;
        } catch (e) {
            console.debug('[AutoUpdate] Socket bind failed:', e.message);
        }
    }

    /* ─────────────────────────────────────────────────────────────────────────
       PUBLIC API
       ───────────────────────────────────────────────────────────────────────── */
    return {
        /**
         * Start the auto-update polling loop and bind Socket.IO push events.
         * Call once after OS boot, e.g. at the end of boot() in index.html.
         *
         * @param {object} [opts]
         * @param {number} [opts.delayMs]  ms to wait before first check (default 10s)
         */
        start(opts = {}) {
            const delayMs   = opts.delayMs ?? 10_000;
            const intervalMins = getSetting('interval', DEFAULTS.intervalMins);

            console.log(`[AutoUpdate] Starting — channel: ${getSetting('channel', DEFAULTS.channel)}, interval: ${intervalMins}m`);

            // Bind Socket.IO for instant push
            _bindSocket();

            // First check after a short delay (let OS finish booting)
            setTimeout(() => {
                check();
                // Then poll on interval
                _pollTimer = setInterval(check, intervalMins * 60 * 1000);
            }, delayMs);
        },

        /** Stop polling (e.g. when settings change the interval). */
        stop() {
            clearInterval(_pollTimer);
            _pollTimer = null;
        },

        /** Restart with the current interval setting (call after settings change). */
        restart() {
            this.stop();
            this.start({ delayMs: 0 });
        },

        /** Manual one-shot check. Returns { available, version } or null. */
        check,

        /** Dismiss the current banner. */
        dismiss: _dismissBanner,

        /**
         * Settings helper — exposes the config keys for the Settings app.
         */
        getConfig() {
            return {
                enabled:      getSetting('enabled',      DEFAULTS.enabled),
                channel:      getSetting('channel',      DEFAULTS.channel),
                intervalMins: getSetting('interval',     DEFAULTS.intervalMins),
                autoInstall:  getSetting('auto_install', DEFAULTS.autoInstall),
                lastCheck:    getSetting('last_check',   null),
            };
        },

        setConfig(key, value) {
            setSetting(key, value);
            if (key === 'interval' || key === 'enabled') this.restart();
        },
    };
})();

/* ─────────────────────────────────────────────────────────────────────────────
   BOOT HOOK
   ─────────────────────────────────────────────────────────────────────────────
   Start automatically once the OS signals it's done booting.
   We listen for the custom 'os:booted' event (fired at the end of
   completeBoot() in index.html) so we don't interfere with startup.

   If you don't fire that event, add this to your completeBoot() function:
       AutoUpdateService.start();
   ───────────────────────────────────────────────────────────────────────────── */
window.addEventListener('os:booted', () => {
    // Slight additional delay so the desktop is fully rendered
    setTimeout(() => AutoUpdateService.start(), 1500);
}, { once: true });

// Expose globally so Settings app and devtools can call it
window.AutoUpdateService = AutoUpdateService;

} // end iframe guard
