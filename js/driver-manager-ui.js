/**
 * NovaByte Driver Manager
 * ────────────────────────
 * Drop this entire script tag into index.html.
 * Registers a "Driver Manager" app that opens as a NovaByte window.
 *
 * Usage in your app launcher / taskbar:
 *   NovaByte.DriverManager.open();
 *
 * Or add to your app registry:
 *   { id: 'driver-manager', name: 'Driver Manager', icon: '🔌', launch: () => NovaByte.DriverManager.open() }
 */

(function () {
    'use strict';

    // ── Theme tokens (matches NovaByte CSS vars) ────────────────────────────────
    const S = `
    .nbdm-overlay {
        position: fixed; inset: 0; z-index: 99999;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0,0,0,0.55);
        backdrop-filter: blur(6px);
        animation: nbdm-fade-in 0.18s ease;
    }
    @keyframes nbdm-fade-in { from { opacity:0 } to { opacity:1 } }

    .nbdm-win {
        width: min(860px, 94vw);
        height: min(620px, 88vh);
        background: #0e121c;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 12px;
        box-shadow: 0 32px 80px rgba(0,0,0,0.6), 0 0 0 0.5px rgba(255,255,255,0.04);
        display: flex; flex-direction: column;
        overflow: hidden;
        animation: nbdm-slide-up 0.22s cubic-bezier(0.25,0.8,0.25,1);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    }
    @keyframes nbdm-slide-up { from { transform: translateY(18px); opacity:0 } to { transform:none; opacity:1 } }

    .nbdm-header {
        display: flex; align-items: center; gap: 10px;
        padding: 14px 18px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.07);
        background: rgba(255,255,255,0.02);
        flex-shrink: 0;
    }
    .nbdm-header-icon { font-size: 18px; }
    .nbdm-header-title { color: #e6edf3; font-size: 14px; font-weight: 600; flex: 1; }
    .nbdm-close {
        width: 26px; height: 26px; border-radius: 50%;
        background: rgba(255,255,255,0.06); border: none; cursor: pointer;
        color: #8b949e; font-size: 14px; display:flex; align-items:center; justify-content:center;
        transition: background 0.15s;
    }
    .nbdm-close:hover { background: rgba(255,70,70,0.2); color: #ff6b6b; }

    .nbdm-body { display: flex; flex: 1; overflow: hidden; }

    .nbdm-sidebar {
        width: 180px; flex-shrink: 0;
        border-right: 1px solid rgba(255,255,255,0.07);
        padding: 12px 8px;
        display: flex; flex-direction: column; gap: 2px;
        background: rgba(0,0,0,0.15);
    }
    .nbdm-nav-btn {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 10px; border-radius: 7px;
        border: none; background: none; cursor: pointer;
        color: #8b949e; font-size: 12.5px; text-align: left; width: 100%;
        transition: all 0.12s;
    }
    .nbdm-nav-btn:hover  { background: rgba(255,255,255,0.06); color: #e6edf3; }
    .nbdm-nav-btn.active { background: rgba(88,166,255,0.12); color: #58a6ff; }
    .nbdm-nav-btn .nbdm-nav-icon { font-size: 14px; width: 16px; text-align:center; }

    .nbdm-content { flex: 1; overflow-y: auto; padding: 18px; }

    /* Scrollbar */
    .nbdm-content::-webkit-scrollbar { width: 5px; }
    .nbdm-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }

    /* Driver cards */
    .nbdm-section-title { color: #8b949e; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 12px; }
    .nbdm-card-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .nbdm-card {
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.07);
        border-radius: 9px; padding: 14px;
        transition: border-color 0.15s, background 0.15s;
        cursor: default;
    }
    .nbdm-card:hover { border-color: rgba(88,166,255,0.25); background: rgba(88,166,255,0.04); }
    .nbdm-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .nbdm-card-icon { font-size: 20px; }
    .nbdm-card-name { color: #e6edf3; font-size: 13px; font-weight: 600; }
    .nbdm-card-version { color: #484f58; font-size: 11px; margin-left: auto; }
    .nbdm-card-desc { color: #8b949e; font-size: 11.5px; line-height: 1.5; margin-bottom: 10px; }
    .nbdm-card-footer { display: flex; align-items: center; gap: 6px; }
    .nbdm-badge {
        padding: 2px 7px; border-radius: 20px; font-size: 10px; font-weight: 600;
    }
    .nbdm-badge-active  { background: rgba(63,185,80,0.15); color: #3fb950; }
    .nbdm-badge-builtin { background: rgba(88,166,255,0.12); color: #58a6ff; }
    .nbdm-badge-perm    { background: rgba(255,255,255,0.06); color: #8b949e; }
    .nbdm-toggle {
        margin-left: auto; width: 34px; height: 18px; border-radius: 9px;
        background: rgba(255,255,255,0.1); border: none; cursor: pointer;
        position: relative; transition: background 0.2s;
    }
    .nbdm-toggle.on { background: #238636; }
    .nbdm-toggle::after {
        content: ''; position: absolute; top: 2px; left: 2px;
        width: 14px; height: 14px; border-radius: 50%; background: #fff;
        transition: transform 0.2s;
    }
    .nbdm-toggle.on::after { transform: translateX(16px); }

    /* Env panel */
    .nbdm-env-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 16px; }
    .nbdm-env-card {
        background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07);
        border-radius: 8px; padding: 12px 14px;
    }
    .nbdm-env-label { color: #484f58; font-size: 10px; font-weight: 600; text-transform:uppercase; letter-spacing:0.05em; margin-bottom: 4px; }
    .nbdm-env-value { color: #e6edf3; font-size: 13px; font-weight: 600; }

    /* Install panel */
    .nbdm-textarea {
        width: 100%; height: 200px;
        background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.1);
        border-radius: 8px; padding: 12px; color: #e6edf3; font-family: monospace;
        font-size: 12px; resize: vertical; outline: none; line-height: 1.5;
    }
    .nbdm-textarea:focus { border-color: rgba(88,166,255,0.4); }
    .nbdm-btn {
        padding: 8px 16px; border-radius: 7px; border: none; cursor: pointer;
        font-size: 13px; font-weight: 500; transition: all 0.15s;
    }
    .nbdm-btn-primary { background: #1f6feb; color: #fff; }
    .nbdm-btn-primary:hover { background: #388bfd; }
    .nbdm-btn-danger  { background: rgba(248,81,73,0.15); color: #f85149; border: 1px solid rgba(248,81,73,0.3); }
    .nbdm-btn-danger:hover { background: rgba(248,81,73,0.25); }

    .nbdm-alert {
        padding: 10px 14px; border-radius: 7px; font-size: 12.5px; margin-top: 10px;
    }
    .nbdm-alert-success { background: rgba(63,185,80,0.1);  border: 1px solid rgba(63,185,80,0.25);  color: #3fb950; }
    .nbdm-alert-error   { background: rgba(248,81,73,0.1);  border: 1px solid rgba(248,81,73,0.25);  color: #f85149; }
    .nbdm-alert-info    { background: rgba(88,166,255,0.08); border: 1px solid rgba(88,166,255,0.2); color: #58a6ff; }

    .nbdm-spinner {
        display: inline-block; width: 14px; height: 14px;
        border: 2px solid rgba(255,255,255,0.15); border-top-color: #58a6ff;
        border-radius: 50%; animation: nbdm-spin 0.7s linear infinite; vertical-align: middle;
    }
    @keyframes nbdm-spin { to { transform: rotate(360deg); } }

    .nbdm-empty { text-align: center; color: #484f58; padding: 40px 20px; font-size: 13px; }
    .nbdm-empty-icon { font-size: 32px; margin-bottom: 10px; }

    .nbdm-caps-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .nbdm-cap-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; background: rgba(255,255,255,0.02); }
    .nbdm-cap-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .nbdm-cap-dot.yes { background: #3fb950; }
    .nbdm-cap-dot.no  { background: #484f58; }
    .nbdm-cap-label { color: #8b949e; font-size: 11.5px; }
    `;

    // ── Icons ───────────────────────────────────────────────────────────────────
    const ICONS = {
        'browser-driver':  '🌐',
        'display-driver':  '🖥️',
        'hardware-driver': '⚙️',
        default:           '🔌'
    };

    // ── State ───────────────────────────────────────────────────────────────────
    let activeTab   = 'drivers';
    let drivers     = [];
    let environment = null;
    let capabilities = null;

    // ── API helpers ─────────────────────────────────────────────────────────────
    const api = {
        async get(path) {
            const r = await fetch('/api/drivers' + path);
            return r.json();
        },
        async post(path, body) {
            const r = await fetch('/api/drivers' + path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            return r.json();
        },
        async del(path) {
            const r = await fetch('/api/drivers' + path, { method: 'DELETE' });
            return r.json();
        }
    };

    // ── Render helpers ──────────────────────────────────────────────────────────
    function badge(text, cls) {
        return `<span class="nbdm-badge nbdm-badge-${cls}">${text}</span>`;
    }

    function renderDriverCard(d) {
        const icon = ICONS[d.id] || ICONS.default;
        const perms = (d.permissions || []).slice(0, 3).map(p => badge(p, 'perm')).join(' ');
        const isOn  = d.enabled;

        return `
        <div class="nbdm-card" data-id="${d.id}">
            <div class="nbdm-card-header">
                <span class="nbdm-card-icon">${icon}</span>
                <span class="nbdm-card-name">${d.name}</span>
                <span class="nbdm-card-version">v${d.version}</span>
            </div>
            <div class="nbdm-card-desc">${d.description || 'No description.'}</div>
            <div class="nbdm-card-footer">
                ${d.status === 'active' ? badge('Active', 'active') : ''}
                ${d.builtin ? badge('Built-in', 'builtin') : ''}
                ${perms}
                <button class="nbdm-toggle ${isOn ? 'on' : ''}" title="${isOn ? 'Disable' : 'Enable'}"
                    onclick="NovaByte.DriverManager._toggle('${d.id}', ${!isOn})"></button>
            </div>
        </div>`;
    }

    function renderEnvCard(label, value) {
        return `<div class="nbdm-env-card">
            <div class="nbdm-env-label">${label}</div>
            <div class="nbdm-env-value">${value}</div>
        </div>`;
    }

    function renderCapRow(label, val) {
        const cls = val ? 'yes' : 'no';
        return `<div class="nbdm-cap-row">
            <span class="nbdm-cap-dot ${cls}"></span>
            <span class="nbdm-cap-label">${label}</span>
        </div>`;
    }

    // ── Tab renderers ───────────────────────────────────────────────────────────
    function renderDriversTab() {
        if (!drivers.length) return `<div class="nbdm-empty">
            <div class="nbdm-empty-icon">🔌</div>No drivers installed.</div>`;

        const builtin = drivers.filter(d => d.builtin);
        const user    = drivers.filter(d => !d.builtin);

        let html = '';
        if (builtin.length) {
            html += `<div class="nbdm-section-title">Built-in Drivers</div>
                     <div class="nbdm-card-grid">${builtin.map(renderDriverCard).join('')}</div>`;
        }
        if (user.length) {
            html += `<div class="nbdm-section-title" style="margin-top:18px">Installed Drivers</div>
                     <div class="nbdm-card-grid">${user.map(renderDriverCard).join('')}</div>`;
        }
        return html;
    }

    function renderEnvTab() {
        if (!environment) return `<div class="nbdm-empty"><span class="nbdm-spinner"></span> Detecting...</div>`;
        const e   = environment;
        const cap = capabilities || {};

        const capRows = [
            ['WebUSB',          cap.webUSB],
            ['WebSerial',       cap.webSerial],
            ['WebGPU',          cap.webGPU],
            ['WebBluetooth',    cap.webBluetooth],
            ['OffscreenCanvas', cap.offscreenCanvas],
            ['File System API', cap.fileSystemAccess],
            ['backdrop-filter', cap.css?.backdropFilter],
            ['Container Queries', cap.css?.containerQuery]
        ];

        return `
        <div class="nbdm-section-title">Host Environment</div>
        <div class="nbdm-env-grid">
            ${renderEnvCard('Browser', `${e.browser} ${e.browserVersion || ''}`)}
            ${renderEnvCard('OS', e.os)}
            ${renderEnvCard('Architecture', e.arch)}
            ${renderEnvCard('CPUs', `${(cap.system || e.system || {}).cpus || '?'} cores`)}
            ${renderEnvCard('Engine', e.engine || '?')}
            ${renderEnvCard('Recommended Drivers', (environment.recommended || []).length)}
        </div>
        <div class="nbdm-section-title" style="margin-top:18px">Browser Capabilities</div>
        <div class="nbdm-caps-grid">${capRows.map(([l,v]) => renderCapRow(l, v)).join('')}</div>
        `;
    }

    function renderInstallTab() {
        return `
        <div class="nbdm-section-title">Install Driver (.drv)</div>
        <div style="color:#8b949e;font-size:12.5px;margin-bottom:12px;line-height:1.6">
            Paste the contents of a <code style="background:rgba(255,255,255,0.07);padding:1px 5px;border-radius:4px">.drv</code>
            file below, or use the compiler:<br>
            <code style="background:rgba(0,0,0,0.4);padding:4px 8px;border-radius:5px;display:inline-block;margin-top:6px;font-size:11px;color:#58a6ff">
                node driver-compiler.js build ./my-driver/
            </code>
        </div>
        <textarea class="nbdm-textarea" id="nbdm-drv-input" placeholder='{"novabyte_drv":"1.0","manifest":{...},...}'></textarea>
        <div style="display:flex;gap:8px;margin-top:10px">
            <button class="nbdm-btn nbdm-btn-primary" onclick="NovaByte.DriverManager._install()">Install Driver</button>
        </div>
        <div id="nbdm-install-msg"></div>

        <div class="nbdm-section-title" style="margin-top:24px">Build a Driver</div>
        <div style="color:#8b949e;font-size:12.5px;line-height:1.6">
            Create a folder with these two files:<br><br>
            <strong style="color:#e6edf3">manifest.json</strong>
            <pre style="background:rgba(0,0,0,0.4);border-radius:8px;padding:12px;font-size:11px;color:#f8f8f2;margin:6px 0 12px;overflow-x:auto">{
  "id": "my-driver",
  "name": "My Driver",
  "version": "1.0.0",
  "author": "You",
  "entry": "driver.js",
  "permissions": ["display", "browser"],
  "targets": ["*"],
  "platform": ["windows", "linux", "mac"]
}</pre>
            <strong style="color:#e6edf3">driver.js</strong>
            <pre style="background:rgba(0,0,0,0.4);border-radius:8px;padding:12px;font-size:11px;color:#f8f8f2;margin:6px 0;overflow-x:auto">module.exports = {
  onLoad({ context }) {
    context.log('My driver loaded!');
    return { status: 'ready' };
  },
  myAction({ params, context }) {
    return { result: 'hello from my driver' };
  }
};</pre>
            Then run: <code style="background:rgba(0,0,0,0.4);padding:3px 7px;border-radius:4px;color:#58a6ff;font-size:11px">node driver-compiler.js build ./my-driver/</code>
        </div>
        `;
    }

    // ── Tab contents ────────────────────────────────────────────────────────────
    function getTabContent() {
        switch (activeTab) {
            case 'drivers': return renderDriversTab();
            case 'env':     return renderEnvTab();
            case 'install': return renderInstallTab();
            default:        return '';
        }
    }

    // ── Main render ─────────────────────────────────────────────────────────────
    function render() {
        const overlay = document.getElementById('nbdm-overlay');
        if (!overlay) return;

        const nav = [
            ['drivers', '🔌', 'Drivers'],
            ['env',     '🖥️', 'Environment'],
            ['install', '⬇️', 'Install']
        ].map(([id, icon, label]) =>
            `<button class="nbdm-nav-btn ${activeTab === id ? 'active' : ''}"
                onclick="NovaByte.DriverManager._tab('${id}')">
                <span class="nbdm-nav-icon">${icon}</span>${label}
             </button>`
        ).join('');

        overlay.innerHTML = `
        <div class="nbdm-win">
            <div class="nbdm-header">
                <span class="nbdm-header-icon">🔌</span>
                <span class="nbdm-header-title">Driver Manager</span>
                <button class="nbdm-close" onclick="NovaByte.DriverManager.close()">✕</button>
            </div>
            <div class="nbdm-body">
                <div class="nbdm-sidebar">${nav}</div>
                <div class="nbdm-content" id="nbdm-tab-content">${getTabContent()}</div>
            </div>
        </div>`;
    }

    // ── Public API ──────────────────────────────────────────────────────────────
    const DriverManager = {
        async open() {
            if (document.getElementById('nbdm-overlay')) return;

            // Inject styles
            if (!document.getElementById('nbdm-styles')) {
                const style = document.createElement('style');
                style.id = 'nbdm-styles';
                style.textContent = S;
                document.head.appendChild(style);
            }

            // Create overlay
            const overlay = document.createElement('div');
            overlay.id = 'nbdm-overlay';
            overlay.className = 'nbdm-overlay';
            overlay.addEventListener('mousedown', e => {
                if (e.target === overlay) this.close();
            });
            document.body.appendChild(overlay);

            // Initial render
            render();

            // Load data
            this._loadDrivers();
            this._loadEnv();
        },

        close() {
            const el = document.getElementById('nbdm-overlay');
            if (el) el.remove();
        },

        async _loadDrivers() {
            try {
                const data = await fetch('/api/drivers').then(r => r.json());
                drivers = data.drivers || [];
                if (activeTab === 'drivers') this._refreshContent();
            } catch {}
        },

        async _loadEnv() {
            try {
                const data = await fetch('/api/drivers/detect').then(r => r.json());
                environment  = data.environment || {};
                environment.recommended = data.recommended || [];
                environment.system = data.system || {};
                capabilities = data.capabilities || {};
                if (activeTab === 'env') this._refreshContent();
            } catch {}
        },

        _tab(id) {
            activeTab = id;
            this._refreshContent();
            // Update nav buttons
            document.querySelectorAll('.nbdm-nav-btn').forEach(b => {
                b.classList.toggle('active', b.textContent.trim().toLowerCase().startsWith(id === 'env' ? 'env' : id));
            });
            render();
        },

        _refreshContent() {
            const el = document.getElementById('nbdm-tab-content');
            if (el) el.innerHTML = getTabContent();
        },

        async _toggle(id, enabled) {
            try {
                await fetch(`/api/drivers/${id}/enable`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled })
                });
                const d = drivers.find(x => x.id === id);
                if (d) d.enabled = enabled;
                this._refreshContent();
            } catch {}
        },

        async _install() {
            const input = document.getElementById('nbdm-drv-input');
            const msg   = document.getElementById('nbdm-install-msg');
            if (!input || !msg) return;

            const raw = input.value.trim();
            if (!raw) {
                msg.innerHTML = '<div class="nbdm-alert nbdm-alert-error">Paste a .drv file first.</div>';
                return;
            }

            msg.innerHTML = '<div class="nbdm-alert nbdm-alert-info"><span class="nbdm-spinner"></span> Installing...</div>';

            try {
                let parsed;
                try { parsed = JSON.parse(raw); } catch {
                    msg.innerHTML = '<div class="nbdm-alert nbdm-alert-error">Invalid JSON — not a valid .drv file.</div>';
                    return;
                }

                console.log('[DriverManager] Sending .drv file, size:', raw.length, 'bytes');
                
                // Send the parsed object directly (not as a wrapped string)
                const res = await fetch('/api/drivers/install', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(parsed)
                }).then(r => r.json());

                if (res.ok) {
                    msg.innerHTML = `<div class="nbdm-alert nbdm-alert-success">
                        ✔ Installed: <strong>${res.name}</strong> v${res.version}
                        ${res.warnings?.length ? '<br>⚠ ' + res.warnings.join('<br>⚠ ') : ''}
                    </div>`;
                    input.value = '';
                    await this._loadDrivers();
                } else {
                    msg.innerHTML = `<div class="nbdm-alert nbdm-alert-error">Error: ${res.error}</div>`;
                }
            } catch (e) {
                msg.innerHTML = `<div class="nbdm-alert nbdm-alert-error">Request failed: ${e.message}</div>`;
            }
        }
    };

    // ── Expose globally ─────────────────────────────────────────────────────────
    window.NovaByte = window.NovaByte || {};
    window.NovaByte.DriverManager = DriverManager;

    // ── Auto-init if element exists ─────────────────────────────────────────────
    // You can also place <div id="novabyte-driver-trigger" onclick="NovaByte.DriverManager.open()">
    document.addEventListener('DOMContentLoaded', () => {
        const trigger = document.getElementById('novabyte-driver-trigger');
        if (trigger) trigger.addEventListener('click', () => DriverManager.open());
    });

    console.log('[NovaByte] Driver Manager loaded — call NovaByte.DriverManager.open()');

})();
