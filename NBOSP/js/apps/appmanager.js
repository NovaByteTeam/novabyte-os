registerApp({
        id: 'app-manager', name: 'App Manager', icon: 'package',
        description: 'Install, manage, and customise .novaapp packages and web apps',
        defaultSize: [980, 640], minSize: [720, 480],
        init(content) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.appmanager', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.appmanager</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const APPS_KEY = 'nova_installed_apps';
          const LOG_KEY = 'nova_appmanager_log';

          // ── Helpers ────────────────────────────────────────────────────
          function getStoredApps() { try { return JSON.parse(localStorage.getItem(APPS_KEY) || '[]'); } catch { return []; } }
          function saveStoredApps(list) { lsSave(APPS_KEY, list); }
          function getLog() { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; } }
          function pushLog(entry) { const l = getLog(); l.unshift({ ...entry, ts: Date.now() }); if (l.length > 200) l.pop(); localStorage.setItem(LOG_KEY, JSON.stringify(l)); }
          function getPinned() { return OS.settings.get('pinnedApps') || []; }
          function getDisabled() { try { return JSON.parse(localStorage.getItem('nova_disabled_apps') || '[]'); } catch { return []; } }
          function setDisabled(list) { localStorage.setItem('nova_disabled_apps', JSON.stringify(list)); }
          function getBootApps() { try { return JSON.parse(localStorage.getItem('nova_boot_apps') || '[]'); } catch { return []; } }
          function setBootApps(list) { localStorage.setItem('nova_boot_apps', JSON.stringify(list)); }

          function buildNovaAppConfig(appData) {
            return {
              id: appData.id, name: appData.name, icon: appData.icon || 'box',
              description: appData.description || '',
              defaultSize: appData.defaultSize || [800, 560],
              minSize: appData.minSize || [400, 300],
              minSecurityPatch: appData.minSecurityPatch || null,
              permissions: appData.permissions || [],
              optionalPermissions: appData.optionalPermissions || [],
              init(contentEl) {
                const entryKey = appData.entry || 'index.html';
                const entryB64 = appData.files?.[entryKey];
                if (!entryB64) { contentEl.innerHTML = '<div style="padding:24px;color:var(--text-danger);font-family:monospace;">Entry file not found in package.</div>'; return; }
                try {
                  const html = decodeURIComponent(escape(atob(entryB64)));
                  const blob = new Blob([html], { type: 'text/html' });
                  const url = URL.createObjectURL(blob);
                  const iframe = createEl('iframe', { src: url, style: 'width:100%;height:100%;border:none;display:block;', sandbox: 'allow-scripts allow-forms allow-popups allow-modals' });
                  contentEl.style.padding = '0';
                  contentEl.appendChild(iframe);
                  iframe.addEventListener('load', () => URL.revokeObjectURL(url));
                } catch (e) { contentEl.innerHTML = `<div style="padding:24px;color:var(--text-danger);font-family:monospace;">Failed to load app: ${e.message}</div>`; }
              }
            };
          }

          function registerNovaApp(appData) {
            if (!OS.apps[appData.id]) registerApp(buildNovaAppConfig(appData));
          }

          let installedApps = getStoredApps();
          installedApps.forEach(a => registerNovaApp(a));

          // ── Shared state ───────────────────────────────────────────────
          let activeTab = 'packages';
          let selectedPkgId = null;

          // ── Root layout ────────────────────────────────────────────────
          content.style.cssText = 'display:flex;flex-direction:column;overflow:hidden;height:100%;';

          // ── Tab bar ────────────────────────────────────────────────────
          const tabBar = createEl('div', { style: 'display:flex;align-items:center;gap:2px;padding:10px 14px 0;border-bottom:1px solid var(--border-subtle);background:var(--bg-sunken);flex-shrink:0;' });

          const TABS = [
            { id: 'packages', label: 'Packages', icon: 'package' },
            { id: 'webapps', label: 'Web Apps', icon: 'globe' }];
          const tabBtns = {};
          TABS.forEach(t => {
            const btn = createEl('button', { style: 'display:flex;align-items:center;gap:6px;padding:7px 14px;border:none;border-radius:10px 10px 0 0;cursor:pointer;font-size:13px;font-weight:600;transition:all 0.12s;background:none;color:var(--text-muted);border-bottom:2px solid transparent;margin-bottom:-1px;' });
            btn.innerHTML = `${svgIcon(t.icon, 13)} ${t.label}`;
            btn.dataset.tab = t.id;
            btn.addEventListener('click', () => switchTab(t.id));
            tabBar.appendChild(btn);
            tabBtns[t.id] = btn;
          });
          content.appendChild(tabBar);

          function refreshTabStyles() {
            Object.values(tabBtns).forEach(btn => {
              const active = btn.dataset.tab === activeTab;
              btn.style.color = active ? 'var(--text-primary)' : 'var(--text-muted)';
              btn.style.background = active ? 'var(--bg-elevated)' : 'none';
              btn.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
            });
          }

          const body = createEl('div', { style: 'flex:1;display:flex;overflow:hidden;' });
          content.appendChild(body);

          function switchTab(id) {
            activeTab = id; refreshTabStyles(); body.innerHTML = '';
            if (id === 'packages') renderPackagesPanel();
            else renderWebAppsPanel();
          }

          // ══════════════════════════════════════════════════════════════
          // PACKAGES PANEL
          // ══════════════════════════════════════════════════════════════
          function renderPackagesPanel() {
            const root = createEl('div', { style: 'display:flex;width:100%;height:100%;overflow:hidden;font-size:13px;' });

            // ── Sidebar ────────────────────────────────────────────────
            const sidebar = createEl('div', { style: 'width:240px;min-width:180px;display:flex;flex-direction:column;border-right:1px solid var(--border-subtle);background:var(--bg-sunken);flex-shrink:0;' });

            // Toolbar: search + install
            const toolbar = createEl('div', { style: 'padding:10px;display:flex;gap:6px;border-bottom:1px solid var(--border-subtle);' });
            const searchEl = createEl('input', { type: 'text', id: 'app-installer-search-input', name: 'app-installer-search', placeholder: 'Search…', style: 'flex:1;padding:5px 9px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:8px;color:var(--text-primary);font-size:12px;outline:none;' });
            const installBtn = createEl('button', { style: 'padding:5px 10px;background:var(--accent);color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap;flex-shrink:0;' });
            installBtn.innerHTML = `${svgIcon('plus', 12)} Install`;
            toolbar.appendChild(searchEl); toolbar.appendChild(installBtn);
            sidebar.appendChild(toolbar);

            const listEl = createEl('div', { style: 'flex:1;overflow-y:auto;padding:6px;' });
            sidebar.appendChild(listEl);

            // ── Detail panel ───────────────────────────────────────────
            const detail = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;' });

            // Hidden file input
            const fileInput = createEl('input', { type: 'file', accept: '.novaapp', id: 'app-install-input', name: 'app-install', style: 'display:none;' });
            fileInput.addEventListener('change', e => { if (e.target.files[0]) processFile(e.target.files[0]); fileInput.value = ''; });
            root.appendChild(fileInput);
            installBtn.addEventListener('click', () => fileInput.click());

            function renderList() {
              listEl.innerHTML = '';
              const q = searchEl.value.trim().toLowerCase();
              const disabled = getDisabled();
              let visible = [...installedApps];
              if (q) visible = visible.filter(a => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q));
              visible.sort((a, b) => a.name.localeCompare(b.name));
              if (!visible.length) {
                const msg = createEl('div', { style: 'padding:24px 12px;text-align:center;color:var(--text-muted);line-height:1.8;' });
                msg.innerHTML = q
                  ? '<div style="font-size:13px;">No apps match.</div>'
                  : `<div style="font-size:32px;margin-bottom:10px;">📦</div><div style="font-size:12px;">No packages installed.<br>Click <strong style="color:var(--text-primary);">Install</strong> or drop a <code style="color:var(--accent);">.novaapp</code> file.</div>`;
                listEl.appendChild(msg); return;
              }
              visible.forEach(app => {
                const isSel = app.id === selectedPkgId;
                const isDis = disabled.includes(app.id);
                const item = createEl('div', { style: `display:flex;align-items:center;gap:9px;padding:8px 9px;border-radius:10px;cursor:pointer;transition:background 0.1s;${isSel ? 'background:var(--accent-muted);' : ''}` });
                const iconWrap = createEl('div', { style: `width:34px;height:34px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${isDis ? 'var(--text-muted)' : 'var(--accent)'};opacity:${isDis ? 0.5 : 1};` });
                iconWrap.innerHTML = svgIcon(app.icon || 'box', 17);
                const meta = createEl('div', { style: 'flex:1;min-width:0;' });
                meta.innerHTML = `<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${isDis ? 'var(--text-muted)' : 'var(--text-primary)'};">${app.name}</div><div style="font-size:10px;color:var(--text-muted);margin-top:2px;">v${app.version || '1.0.0'}${isDis ? ' · disabled' : ''}</div>`;
                item.appendChild(iconWrap); item.appendChild(meta);
                item.addEventListener('mouseenter', () => { if (!isSel) item.style.background = 'var(--bg-elevated)'; });
                item.addEventListener('mouseleave', () => { if (!isSel) item.style.background = ''; });
                item.addEventListener('click', () => { selectedPkgId = app.id; renderList(); renderDetail(); });
                listEl.appendChild(item);
              });
            }

            function renderDetail() {
              detail.innerHTML = '';
              const app = installedApps.find(a => a.id === selectedPkgId);
              if (!app) {
                const drop = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:var(--text-muted);padding:40px;' });
                const dropBox = createEl('div', { style: 'width:110px;height:110px;border:2px dashed var(--border-default);border-radius:24px;display:flex;align-items:center;justify-content:center;transition:all 0.15s;' });
                dropBox.innerHTML = svgIcon('package', 44);
                const dropLabel = createEl('div', { style: 'text-align:center;line-height:1.9;' });
                dropLabel.innerHTML = `<div style="font-size:16px;font-weight:600;color:var(--text-secondary);">Install a .novaapp Package</div><div style="font-size:12px;margin-top:4px;">Drop a <code style="color:var(--accent);">.novaapp</code> file here,<br>or click <strong style="color:var(--text-primary);">Install</strong>.</div>`;
                drop.appendChild(dropBox); drop.appendChild(dropLabel);
                drop.addEventListener('dragover', e => { e.preventDefault(); dropBox.style.borderColor = 'var(--accent)'; dropBox.style.background = 'var(--accent-muted)'; });
                drop.addEventListener('dragleave', () => { dropBox.style.borderColor = 'var(--border-default)'; dropBox.style.background = ''; });
                drop.addEventListener('drop', e => { e.preventDefault(); dropBox.style.borderColor = 'var(--border-default)'; dropBox.style.background = ''; if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]); });
                detail.appendChild(drop); return;
              }

              const disabled = getDisabled();
              const isDis = disabled.includes(app.id);

              // ── Header ─────────────────────────────────────────────
              const header = createEl('div', { style: 'padding:16px 20px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;gap:14px;flex-shrink:0;' });
              const hIcon = createEl('div', { style: `width:56px;height:56px;background:var(--bg-sunken);border:1px solid var(--border-default);border-radius:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${isDis ? 'var(--text-muted)' : 'var(--accent)'};opacity:${isDis ? 0.5 : 1};` });
              hIcon.innerHTML = svgIcon(app.icon || 'box', 28);
              const hMeta = createEl('div', { style: 'flex:1;min-width:0;' });
              hMeta.innerHTML = `<div style="font-size:18px;font-weight:700;color:var(--text-primary);">${app.name}</div><div style="font-size:11px;color:var(--text-muted);margin-top:3px;">v${app.version || '1.0.0'} · ${app.author || 'Unknown'}</div>`;
              header.appendChild(hIcon); header.appendChild(hMeta);
              detail.appendChild(header);

              // ── Actions ─────────────────────────────────────────────
              const actionBar = createEl('div', { style: 'padding:10px 20px;border-bottom:1px solid var(--border-subtle);display:flex;gap:8px;flex-wrap:wrap;flex-shrink:0;background:var(--bg-sunken);' });

              function makeActionBtn(label, iconName, style, onClick) {
                const btn = createEl('button', { style: `display:flex;align-items:center;gap:6px;padding:6px 13px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;transition:all 0.12s;${style}` });
                btn.innerHTML = `${svgIcon(iconName, 12)} ${label}`;
                btn.addEventListener('click', onClick); return btn;
              }

              const launchBtn = makeActionBtn(isDis ? 'Disabled' : 'Launch', 'play',
                isDis ? 'background:var(--bg-elevated);border:1px solid var(--border-default);color:var(--text-muted);cursor:not-allowed;' : 'background:var(--accent);border:1px solid transparent;color:#fff;',
                () => { if (!isDis) WM.createWindow(app.id); });

              const toggleBtn = makeActionBtn(isDis ? 'Enable' : 'Disable', isDis ? 'toggle-left' : 'toggle-right',
                isDis ? 'background:rgba(63,185,80,0.12);border:1px solid rgba(63,185,80,0.35);color:var(--text-success);' : 'background:rgba(210,153,34,0.12);border:1px solid rgba(210,153,34,0.35);color:var(--text-warning);',
                () => {
                  const d = getDisabled();
                  setDisabled(isDis ? d.filter(id => id !== app.id) : [...d, app.id]);
                  selectedPkgId = app.id; renderList(); renderDetail();
                  Notify.show({ title: isDis ? 'App Enabled' : 'App Disabled', body: `${app.name} ${isDis ? 'enabled' : 'disabled'}`, type: 'success', appName: 'App Manager' });
                });

              const uninstBtn = makeActionBtn('Uninstall', 'trash', 'background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.3);color:#f85149;',
                () => doUninstall(app.id));

              [launchBtn, toggleBtn, uninstBtn].forEach(b => actionBar.appendChild(b));
              detail.appendChild(actionBar);

              // ── Info ────────────────────────────────────────────────
              const bodyEl = createEl('div', { style: 'flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:12px;' });
              if (app.description) {
                bodyEl.appendChild(createEl('div', { style: 'color:var(--text-secondary);line-height:1.65;font-size:13px;', textContent: app.description }));
              }
              // Permissions
              const allPerms = [...(app.permissions || []).map(p => ({ p, req: true })), ...(app.optionalPermissions || []).map(p => ({ p, req: false }))];
              if (allPerms.length) {
                const s = createEl('div'); s.innerHTML = `<div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);margin-bottom:8px;">Permissions</div>`;
                const row = createEl('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;' });
                const rs = p => ['fs:delete', 'admin:system'].includes(p) ? 'background:rgba(248,81,73,0.12);border:1px solid rgba(248,81,73,0.35);color:#f85149;' : ['fs:write', 'device:geolocation', 'system:settings'].includes(p) ? 'background:rgba(210,153,34,0.12);border:1px solid rgba(210,153,34,0.35);color:#d29922;' : 'background:var(--accent-muted);border:1px solid rgba(88,166,255,0.3);color:var(--accent);';
                allPerms.forEach(({ p, req }) => { const t = createEl('span', { style: `font-size:11px;padding:3px 9px;border-radius:6px;${rs(p)}` }); t.textContent = p + (req ? '' : ' (opt)'); row.appendChild(t); });
                s.appendChild(row); bodyEl.appendChild(s);
              }
              detail.appendChild(bodyEl);
            }

            function processFile(file) {
              if (!file.name.endsWith('.novaapp')) { Notify.show({ title: 'Invalid File', body: 'Please select a valid .novaapp package.', type: 'error', appName: 'App Manager' }); return; }
              const reader = new FileReader();
              reader.onload = ev => {
                try {
                  const pkg = JSON.parse(ev.target.result);
                  if (!pkg.manifest?.id || !pkg.manifest?.name || !pkg.manifest?.version) throw new Error('Missing required manifest fields (id, name, version).');
                  const payload = JSON.stringify({ novabyte_app: pkg.novabyte_app, manifest: pkg.manifest, files: pkg.files, compiled_at: pkg.compiled_at });
                  let hash = 0; for (let i = 0; i < payload.length; i++) { const c = payload.charCodeAt(i); hash = ((hash << 5) - hash) + c; hash |= 0; }
                  const verified = Math.abs(hash).toString(16).padStart(64, '0') === pkg.signature;
                  if (!verified && !confirm(`⚠ Signature check failed for "${pkg.manifest.name}".\n\nInstall anyway?`)) return;
                  const idx = installedApps.findIndex(a => a.id === pkg.manifest.id);
                  if (idx > -1) { if (!confirm(`"${pkg.manifest.name}" is already installed (v${installedApps[idx].version}).\n\nReplace with v${pkg.manifest.version}?`)) return; delete OS.apps[pkg.manifest.id]; const ri = APP_REGISTRY.findIndex(a => a.id === pkg.manifest.id); if (ri > -1) APP_REGISTRY.splice(ri, 1); installedApps.splice(idx, 1); }
                  const appData = { ...pkg.manifest, files: pkg.files, verified, source: 'file', installedAt: Date.now() };
                  installedApps.push(appData); saveStoredApps(installedApps); registerNovaApp(appData);
                  pushLog({ action: 'install', appId: appData.id, label: `${appData.name} v${appData.version} installed` });
                  selectedPkgId = appData.id; renderList(); renderDetail();
                  Notify.show({ title: 'App Installed', body: `${appData.name} v${appData.version} installed successfully.`, type: 'success', appName: 'App Manager' });
                } catch (err) { Notify.show({ title: 'Install Failed', body: String(err.message || err), type: 'error', appName: 'App Manager' }); }
              };
              reader.readAsText(file);
            }

            function doUninstall(appId) {
              const app = installedApps.find(a => a.id === appId);
              if (!app || !confirm(`Uninstall "${app.name}" v${app.version}?\n\nThis cannot be undone.`)) return;
              pushLog({ action: 'uninstall', appId: app.id, label: `${app.name} v${app.version} uninstalled` });
              installedApps = installedApps.filter(a => a.id !== appId); saveStoredApps(installedApps);
              delete OS.apps[appId]; const ri = APP_REGISTRY.findIndex(a => a.id === appId); if (ri > -1) APP_REGISTRY.splice(ri, 1);
              // Remove from pinned, boot, disabled
              const pins = getPinned().filter(id => id !== appId); OS.settings.set('pinnedApps', pins);
              setDisabled(getDisabled().filter(id => id !== appId));
              setBootApps(getBootApps().filter(id => id !== appId));
              if (WM.updateTaskbar) WM.updateTaskbar();
              selectedPkgId = null; renderList(); renderDetail(); refreshStats();
              Notify.show({ title: 'App Uninstalled', body: `${app.name} has been removed.`, type: 'success', appName: 'App Manager' });
            }

            searchEl.addEventListener('input', () => renderList());
            root.addEventListener('dragover', e => e.preventDefault());
            root.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) processFile(f); });

            root.appendChild(sidebar); root.appendChild(detail);
            body.appendChild(root);
            renderList(); renderDetail();
          }

          // ══════════════════════════════════════════════════════════════
          // WEB APPS PANEL
          // ══════════════════════════════════════════════════════════════
          function renderWebAppsPanel() {
            const wam = typeof WebAppManager !== 'undefined' ? WebAppManager : null;

            function getAllWebApps() { return wam ? wam.getAllApps() : []; }

            const root = createEl('div', { style: 'display:flex;width:100%;height:100%;overflow:hidden;font-size:13px;' });

            // ── Sidebar ──────────────────────────────────────────────────
            const sidebar = createEl('div', { style: 'width:240px;min-width:180px;display:flex;flex-direction:column;border-right:1px solid var(--border-subtle);background:var(--bg-sunken);flex-shrink:0;' });

            const toolbar = createEl('div', { style: 'padding:9px;display:flex;gap:6px;border-bottom:1px solid var(--border-subtle);' });
            const searchEl = createEl('input', { type: 'text', id: 'notes-tasks-search-input', name: 'notes-tasks-search', placeholder: 'Search…', style: 'flex:1;padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:8px;color:var(--text-primary);font-size:12px;outline:none;min-width:0;' });
            const addBtn = createEl('button', { style: 'padding:5px 10px;background:var(--accent);color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap;flex-shrink:0;' });
            addBtn.innerHTML = svgIcon('plus', 12) + ' Add';
            toolbar.append(searchEl, addBtn);
            sidebar.appendChild(toolbar);

            const listEl = createEl('div', { style: 'flex:1;overflow-y:auto;padding:5px;' });
            sidebar.appendChild(listEl);

            // ── Right panel ──────────────────────────────────────────────
            const right = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;' });

            // Initialize selected web app state
            let selectedWebId = null;

            function launchWebApp(wa) {
              const tempId = 'webapp_' + wa.id;
              const wW = 900; const wH = 640;
              if (!OS.apps[tempId]) {
                OS.apps[tempId] = {
                  name: wa.name, icon: wa.icon, defaultSize: [wW, wH], minSize: [400, 300], init(c) {
                    const wrapper = document.createElement('div');
                    wrapper.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;';
                    const urlBar = document.createElement('div');
                    urlBar.style.cssText = 'background:rgba(0,0,0,0.22);border-bottom:1px solid rgba(255,255,255,0.07);padding:5px 12px;font-size:11px;color:rgba(255,255,255,0.4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace;flex-shrink:0;';
                    let h = wa.url; try { h = new URL(wa.url).host; } catch { }
                    urlBar.textContent = '🔒 ' + h;
                    const iframe = document.createElement('webview');
                    iframe.style.cssText = 'flex:1;border:none;background:#fff;';
                    iframe.src = wa.url;
                    wrapper.append(urlBar, iframe);
                    c.style.padding = '0'; c.appendChild(wrapper);
                  }
                };
              }
              WM.createWindow(tempId);
            }

            function renderList() {
              listEl.innerHTML = '';
              const q = searchEl.value.trim().toLowerCase();
              let apps = getAllWebApps();
              if (q) apps = apps.filter(a => a.name.toLowerCase().includes(q) || (a.url || '').toLowerCase().includes(q));

              if (!apps.length) {
                const msg = createEl('div', { style: 'padding:24px 12px;text-align:center;color:var(--text-muted);line-height:1.9;' });
                msg.innerHTML = q
                  ? '<div style="font-size:13px;">No matches found.</div>'
                  : '<div style="font-size:34px;margin-bottom:10px;">🌐</div><div style="font-size:12px;">No web apps yet.<br>Click <strong style="color:var(--text-primary);">+ Add</strong> to get started.</div>';
                listEl.appendChild(msg); return;
              }

              apps.forEach(wa => {
                const isSel = wa.id === selectedWebId;
                let host = wa.url; try { host = new URL(wa.url).host; } catch { }
                const item = createEl('div', { style: `display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:10px;cursor:pointer;transition:background 0.1s;${isSel ? 'background:var(--accent-muted);' : ''}` });
                const iconEl = createEl('div', { style: 'width:32px;height:32px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:17px;line-height:1;' });
                iconEl.textContent = wa.icon || '🌐';
                const meta = createEl('div', { style: 'flex:1;min-width:0;' });
                meta.innerHTML = `<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-primary);font-size:12px;">${wa.name}</div><div style="font-size:10px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${host}</div>`;
                item.append(iconEl, meta);
                item.addEventListener('mouseenter', () => { if (!isSel) item.style.background = 'var(--bg-elevated)'; });
                item.addEventListener('mouseleave', () => { if (!isSel) item.style.background = ''; });
                item.addEventListener('click', () => { selectedWebId = wa.id; renderList(); renderDetail(); });
                listEl.appendChild(item);
              });
            }

            function renderDetail() {
              right.innerHTML = '';
              const wa = getAllWebApps().find(a => a.id === selectedWebId);

              if (!wa) {
                // ── Add form ────────────────────────────────────────────
                const wrap = createEl('div', { style: 'flex:1;overflow-y:auto;padding:28px;display:flex;align-items:flex-start;justify-content:center;' });
                const card = createEl('div', { style: 'width:100%;max-width:420px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:14px;overflow:hidden;' });
                const hdr = createEl('div', { style: 'padding:16px 18px;border-bottom:1px solid var(--border-subtle);background:var(--bg-sunken);' });
                hdr.innerHTML = `<div style="font-size:14px;font-weight:700;color:var(--text-primary);display:flex;align-items:center;gap:8px;">${svgIcon('plus', 15)} Add Web App</div><div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Pin any website as an app.</div>`;
                card.appendChild(hdr);

                const cbody = createEl('div', { style: 'padding:16px 18px;display:flex;flex-direction:column;gap:12px;' });
                function mkField(label, type, ph, fieldId, fieldName) {
                  const w = createEl('div', { style: 'display:flex;flex-direction:column;gap:4px;' });
                  w.innerHTML = `<label style="font-size:11px;font-weight:600;color:var(--text-muted);">${label}</label>`;
                  const inp = createEl('input', { type, id: fieldId, name: fieldName, placeholder: ph, style: 'padding:8px 10px;background:var(--bg-sunken);border:1px solid var(--border-default);border-radius:8px;color:var(--text-primary);font-size:13px;outline:none;width:100%;transition:border-color 0.15s;' });
                  inp.addEventListener('focus', () => inp.style.borderColor = 'var(--accent)');
                  inp.addEventListener('blur', () => inp.style.borderColor = 'var(--border-default)');
                  w.appendChild(inp); return { w, inp };
                }
                const { w: wUrl, inp: urlInp } = mkField('URL *', 'url', 'https://example.com', 'web-app-url-input', 'web-app-url');
                const { w: wName, inp: nameInp } = mkField('Name *', 'text', 'My App', 'web-app-name-input', 'web-app-name');
                const { w: wIcon, inp: iconInp } = mkField('Icon (emoji)', 'text', '🌐', 'web-app-icon-input', 'web-app-icon');
                iconInp.value = '🌐';

                const errEl = createEl('div', { style: 'font-size:11px;color:var(--text-danger);min-height:14px;' });
                const saveBtn = createEl('button', { style: 'padding:10px;background:var(--accent);color:#fff;border:none;border-radius:9px;cursor:pointer;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:7px;' });
                saveBtn.innerHTML = svgIcon('plus', 13) + ' Add Web App';
                saveBtn.addEventListener('click', () => {
                  const url = urlInp.value.trim(); const name = nameInp.value.trim(); const icon = iconInp.value.trim() || '🌐';
                  errEl.textContent = '';
                  if (!url) { errEl.textContent = 'URL is required.'; return; }
                  try { new URL(url); } catch { errEl.textContent = 'Please enter a valid URL.'; return; }
                  if (!name) { errEl.textContent = 'Name is required.'; return; }
                  const addedApp = wam ? wam.addApp({ name, url, icon }) : null;
                  if (addedApp) {
                    Notify.show({ title: 'App Added', body: `"${name}" is now available.`, type: 'success', appName: 'App Manager' });
                    selectedWebId = addedApp.id; renderList(); renderDetail();
                  }
                });

                [wUrl, wName, wIcon, errEl, saveBtn].forEach(el => cbody.appendChild(el));
                card.appendChild(cbody); wrap.appendChild(card); right.appendChild(wrap); return;
              }

              // ── Detail view ─────────────────────────────────────────
              let host = wa.url; try { host = new URL(wa.url).host; } catch { }

              const hdr = createEl('div', { style: 'padding:14px 18px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;gap:12px;flex-shrink:0;background:var(--bg-sunken);' });
              const hIcon = createEl('div', { style: 'width:48px;height:48px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:13px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:24px;line-height:1;' });
              hIcon.textContent = wa.icon || '🌐';
              const hMeta = createEl('div', { style: 'flex:1;min-width:0;' });
              hMeta.innerHTML = `<div style="font-size:16px;font-weight:700;color:var(--text-primary);">${wa.name}</div><div style="font-size:11px;color:var(--text-muted);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${host}</div>`;
              hdr.append(hIcon, hMeta); right.appendChild(hdr);

              const abar = createEl('div', { style: 'padding:9px 18px;border-bottom:1px solid var(--border-subtle);display:flex;gap:7px;flex-shrink:0;' });
              function mkBtn(label, icon, sty, fn) {
                const b = createEl('button', { style: `display:flex;align-items:center;gap:5px;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;${sty}` });
                b.innerHTML = svgIcon(icon, 12) + ' ' + label;
                b.addEventListener('click', fn); abar.appendChild(b); return b;
              }
              mkBtn('Open', 'external-link', 'background:var(--accent);border:1px solid transparent;color:#fff;', () => launchWebApp(wa));
              mkBtn('Remove', 'trash', 'background:rgba(248,81,73,0.08);border:1px solid rgba(248,81,73,0.25);color:#f85149;', () => {
                if (!confirm(`Remove "${wa.name}"?`)) return;
                if (wam) wam.removeApp(wa.id);
                selectedWebId = null; renderList(); renderDetail();
                Notify.show({ title: 'Removed', body: `"${wa.name}" removed`, type: 'success', appName: 'App Manager' });
              });
              right.appendChild(abar);
            }

            addBtn.addEventListener('click', () => { selectedWebId = null; renderList(); renderDetail(); });
            searchEl.addEventListener('input', () => renderList());
            root.append(sidebar, right); body.appendChild(root);
            renderList(); renderDetail();
          }

          // ── Boot ────────────────────────────────────────────────────────
          refreshTabStyles();
          switchTab('packages');
        }
      });

      /* ── Background services: Clock + Email ───────────────────────────────── */
      (function () {
        const bgRoot = window.__NBOSP_BG = window.__NBOSP_BG || {};

        function bgBeep(freq, dur) {
          try {
            const actx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = actx.createOscillator(), gn = actx.createGain();
            osc.type = 'sine'; osc.frequency.value = freq || 880;
            gn.gain.setValueAtTime(0.25, actx.currentTime);
            gn.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + (dur || 1.0));
            osc.connect(gn); gn.connect(actx.destination);
            osc.start(); osc.stop(actx.currentTime + (dur || 1.0));
            setTimeout(() => { try { actx.close(); } catch (e) {} }, Math.max(1200, ((dur || 1.0) * 1000) + 250));
          } catch { }
        }

        function safeJSONParse(raw, fallback) {
          try { return JSON.parse(raw); } catch { return fallback; }
        }

        /* ---------------------------- Clock service ---------------------------- */
        if (!bgRoot.clock) {
          const STATE_KEY = 'nbosp_clock_state_v2';
          const ALARMS_KEY = 'nbosp_clock_v1';

          const defaults = () => ({
            timer: { running: false, done: false, presetMs: 0, remainingMs: 0, endAt: 0 },
            stopwatch: { running: false, elapsedMs: 0, startedAt: 0, laps: [] },
            lastAlarmMinute: ''
          });

          let state = safeJSONParse(localStorage.getItem(STATE_KEY), null) || defaults();

          function normaliseState() {
            state.timer = state.timer || {};
            state.stopwatch = state.stopwatch || {};
            state.timer.running = !!state.timer.running;
            state.timer.done = !!state.timer.done;
            state.timer.presetMs = Math.max(0, Number(state.timer.presetMs) || 0);
            state.timer.remainingMs = Math.max(0, Number(state.timer.remainingMs) || 0);
            state.timer.endAt = Math.max(0, Number(state.timer.endAt) || 0);

            state.stopwatch.running = !!state.stopwatch.running;
            state.stopwatch.elapsedMs = Math.max(0, Number(state.stopwatch.elapsedMs) || 0);
            state.stopwatch.startedAt = Math.max(0, Number(state.stopwatch.startedAt) || 0);
            state.stopwatch.laps = Array.isArray(state.stopwatch.laps)
              ? state.stopwatch.laps.filter(n => Number.isFinite(n) && n >= 0).map(n => Math.floor(n))
              : [];
            state.lastAlarmMinute = typeof state.lastAlarmMinute === 'string' ? state.lastAlarmMinute : '';
          }

          function persist() {
            normaliseState();
            lsSave(STATE_KEY, state);
          }

          function loadAlarms() {
            const raw = safeJSONParse(localStorage.getItem(ALARMS_KEY), {});
            const alarms = Array.isArray(raw?.alarms) ? raw.alarms : [];
            return alarms
              .map(al => ({
                id: al?.id ?? Date.now().toString(36),
                time: typeof al?.time === 'string' ? al.time : '07:00',
                label: typeof al?.label === 'string' ? al.label : '',
                days: Array.isArray(al?.days) ? al.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : [],
                enabled: al?.enabled !== false
              }))
              .filter(al => /^\d{2}:\d{2}$/.test(al.time));
          }

          function saveAlarms(alarms) {
            const raw = safeJSONParse(localStorage.getItem(ALARMS_KEY), {});
            raw.alarms = alarms;
            lsSave(ALARMS_KEY, raw);
          }

          function nowMs() { return Date.now(); }

          function timerMs() {
            normaliseState();
            if (state.timer.running && state.timer.endAt) {
              const rem = Math.max(0, state.timer.endAt - nowMs());
              if (rem <= 0) {
                state.timer.running = false;
                state.timer.done = true;
                state.timer.remainingMs = 0;
                state.timer.endAt = 0;
                persist();
                bgBeep(880, 0.7); setTimeout(() => bgBeep(1047, 0.7), 350); setTimeout(() => bgBeep(1319, 1.0), 700);
                return 0;
              }
              return rem;
            }
            return state.timer.remainingMs || 0;
          }

          function stopwatchMs() {
            normaliseState();
            return state.stopwatch.running
              ? state.stopwatch.elapsedMs + Math.max(0, nowMs() - state.stopwatch.startedAt)
              : state.stopwatch.elapsedMs;
          }

          bgRoot.clock = {
            state,
            persist,
            loadAlarms,
            saveAlarms,
            timerMs,
            stopwatchMs,
            startTimer(ms) {
              const amount = Math.max(0, Math.floor(Number(ms) || 0));
              state.timer.presetMs = amount;
              state.timer.remainingMs = amount;
              state.timer.endAt = nowMs() + amount;
              state.timer.running = amount > 0;
              state.timer.done = false;
              persist();
            },
            pauseTimer() {
              state.timer.remainingMs = timerMs();
              state.timer.running = false;
              state.timer.done = false;
              state.timer.endAt = 0;
              persist();
            },
            resetTimer() {
              state.timer.running = false;
              state.timer.done = false;
              state.timer.remainingMs = state.timer.presetMs || 0;
              state.timer.endAt = 0;
              persist();
            },
            restartTimer() {
              const amount = state.timer.presetMs || state.timer.remainingMs || 0;
              state.timer.remainingMs = amount;
              state.timer.endAt = nowMs() + amount;
              state.timer.running = amount > 0;
              state.timer.done = false;
              persist();
            },
            setTimerPreset(ms) {
              const amount = Math.max(0, Math.floor(Number(ms) || 0));
              state.timer.presetMs = amount;
              if (!state.timer.running) state.timer.remainingMs = amount;
              persist();
            },
            startStopwatch() {
              if (!state.stopwatch.running) {
                state.stopwatch.startedAt = nowMs();
                state.stopwatch.running = true;
                persist();
              }
            },
            pauseStopwatch() {
              if (state.stopwatch.running) {
                state.stopwatch.elapsedMs = stopwatchMs();
                state.stopwatch.running = false;
                state.stopwatch.startedAt = 0;
                persist();
              }
            },
            resetStopwatch() {
              state.stopwatch.running = false;
              state.stopwatch.elapsedMs = 0;
              state.stopwatch.startedAt = 0;
              state.stopwatch.laps = [];
              persist();
            },
            lapStopwatch() {
              const current = Math.floor(stopwatchMs());
              if (!state.stopwatch.laps.length || state.stopwatch.laps[state.stopwatch.laps.length - 1] !== current) {
                state.stopwatch.laps.push(current);
                persist();
              }
              return current;
            },
            getStopwatchLaps() { normaliseState(); return state.stopwatch.laps.slice(); },
            alarmTick(checkFn) {
              const now = new Date();
              const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}:${now.getMinutes()}`;
              if (state.lastAlarmMinute === minuteKey) return;
              const seconds = now.getSeconds();
              const ms = now.getMilliseconds();
              if (seconds !== 0 || ms > 1400) return;
              state.lastAlarmMinute = minuteKey;
              persist();
              const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
              const dow = now.getDay();
              const alarms = loadAlarms();
              alarms.forEach((al, i) => {
                if (!al.enabled || al.time !== timeStr) return;
                if (al.days.length > 0 && !al.days.includes(dow)) return;
                if (typeof checkFn === 'function') {
                  try { checkFn(al, i); } catch (e) { }
                }
                bgBeep(880, 0.8); setTimeout(() => bgBeep(1047, 0.8), 400); setTimeout(() => bgBeep(1319, 1.2), 800);
                if (al.days.length === 0) {
                  al.enabled = false;
                  saveAlarms(alarms);
                }
              });
            },
            ensureBooted() { return true; }
          };

          normaliseState();
          persist();

          if (!bgRoot._clockTimer) {
            bgRoot._clockTimer = setInterval(() => {
              timerMs();
              bgRoot.clock.alarmTick();
            }, 250);
          }
        }

        /* ---------------------------- Email service ---------------------------- */
        if (!bgRoot.email) {
          const ACCTS_KEY = 'nbosp_email_accts_v2';
          const state = {
            started: false,
            accounts: [],
            syncTimers: {},
            onChange: null,
            lastBootAt: 0
          };

          const rawLoad = () => {
            try { return JSON.parse(localStorage.getItem(ACCTS_KEY) || '[]'); } catch { return []; }
          };

          function saveAccounts() {
            lsSave(ACCTS_KEY, state.accounts);
          }

          function clearTimers() {
            Object.values(state.syncTimers).forEach(t => clearInterval(t));
            state.syncTimers = {};
          }

          async function api(path, opts) {
            const r = await fetch('/api/email' + path, Object.assign({ credentials: 'include' }, opts || {}));
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || r.statusText);
            return d;
          }

          async function connectAccount(acct) {
            if (!acct || !acct.host || !acct.user || !acct.pass) return;
            await api('/connect', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: acct.type, host: acct.host, port: acct.port, ssl: acct.ssl, user: acct.user, pass: acct.pass })
            });
          }

          function renderHook() {
            if (typeof state.onChange === 'function') {
              try { state.onChange(); } catch (e) { }
            }
          }

          async function syncAccount(acct) {
            try {
              await connectAccount(acct);
              const d = await api('/messages?folder=INBOX&page=1&limit=10', { method: 'GET' });
              const unread = (d.messages || []).filter(m => !m.seen).length;
              acct._unread = unread;
              acct._lastSync = Date.now();
              state.accounts = rawLoad();
              const target = state.accounts.find(a => a.id === acct.id);
              if (target) {
                target._unread = unread;
                target._lastSync = acct._lastSync;
                saveAccounts();
              }
              if (unread > 0 && window.Notify?.show) {
                Notify.show({ title: 'Email', body: `${unread} new in ${acct.name || acct.email || 'Email'}`, type: 'info', appName: 'Email' });
              }
              renderHook();
            } catch { }
          }

          function schedule() {
            clearTimers();
            state.accounts = rawLoad();
            state.accounts.forEach(acct => {
              const mins = parseInt(acct.syncInterval) || 0;
              if (!mins) return;
              state.syncTimers[acct.id] = setInterval(() => { syncAccount(acct); }, mins * 60000);
            });
          }

          bgRoot.email = {
            state,
            ensureBooted() {
              if (state.started) return;
              state.started = true;
              state.lastBootAt = Date.now();
              state.accounts = rawLoad();
              schedule();
              state.accounts.forEach(acct => {
                const mins = parseInt(acct.syncInterval) || 0;
                if (mins) syncAccount(acct);
              });
            },
            refreshAccounts: schedule,
            getAccounts() {
              state.accounts = rawLoad();
              return state.accounts.slice();
            },
            saveAccounts,
            setAccounts(next) {
              state.accounts = Array.isArray(next) ? next : [];
              saveAccounts();
              schedule();
              renderHook();
            },
            syncNow(acctId) {
              const list = rawLoad();
              if (acctId) {
                const acct = list.find(a => a.id === acctId);
                if (acct) return syncAccount(acct);
                return Promise.resolve();
              }
              return Promise.allSettled(list.map(acct => syncAccount(acct)));
            },
            stop() {
              clearTimers();
              state.started = false;
            }
          };
        }
      })();


