'use strict';

/**
 * com.nbosp.users — the admin console for accounts.
 *
 * First-class console, not another Settings section: launching requires an
 * admin-role session. It runs in the trusted host (unrestrictedEntry) and
 * calls the /api/auth/admin routes through SessionManager.authFetch; the
 * server re-checks the role on every route. Standard users who launch it get
 * a role-denied splash rather than a silent failure.
 *
 * Three tabs:
 *   Users    — every account: avatar, display name, username, role chip
 *              (Standard/Admin/Owner), status chip (active/disabled/locked),
 *              last login, storage-usage bar against quota; row actions:
 *              edit, credential reset, disable/enable, force logout, delete
 *              with its archive-or-wipe dialog and the last-admin guard.
 *   Policies — the machine account settings: guest access, picker
 *              usernames, lockout ladder, per-account quotas, session
 *              limits, idle-lock maximum, close-apps-on-switch.
 *   Audit    — the persistent per-user event feed with severity coloring,
 *              per-user filtering and CSV export.
 */

registerApp({
  id: 'com.nbosp.users',
  name: 'Users',
  version: '3.0.2',
  icon: '/assets/users.svg',
  description: 'Admin console for accounts: create, edit, reset, disable, delete, machine policies and the per-user audit feed.',
  category: 'admin',
  permissions: [],
  defaultSize: [880, 640],
  minSize: [560, 420],
  resizable: true,

  async init(content, state, options) {
    const ac = new AbortController();
    state.cleanups?.push(() => ac.abort());
    const { signal } = ac;

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-base);color:var(--text-primary);font-family:var(--font-ui,sans-serif);overflow:hidden;';

    const css = document.createElement('style');
    css.textContent = `
      .nbusers-root { display:flex;flex-direction:column;height:100%;overflow:hidden; }
      .nbusers-tabs { display:flex;border-bottom:1px solid var(--border-subtle);background:var(--bg-elevated);flex-shrink:0; }
      .nbusers-tab { padding:9px 18px;background:transparent;border:none;color:var(--text-muted);cursor:pointer;font-size:13px;border-bottom:2px solid transparent; }
      .nbusers-tab.active { color:var(--accent);border-bottom-color:var(--accent);background:var(--bg-hover); }
      .nbusers-body { flex:1;overflow:auto;padding:18px; }
      .nbusers-toolbar { display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap; }
      .nbusers-btn { padding:8px 14px;border-radius:9px;border:1px solid var(--border-default);background:var(--bg-elevated);color:var(--text-primary);font-size:12px;cursor:pointer; }
      .nbusers-btn.primary { border-color:var(--accent);background:var(--accent-muted);color:var(--accent);font-weight:600; }
      .nbusers-btn.danger { border-color:var(--text-danger);color:var(--text-danger); }
      .nbusers-btn.ghost { background:transparent;color:var(--text-muted); }
      .nbusers-add-btn { display:inline-flex;align-items:center;gap:6px; }
      .nbusers-table { width:100%;border-collapse:collapse;font-size:13px; }
      .nbusers-table th { text-align:start;color:var(--text-muted);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:8px 10px;border-bottom:1px solid var(--border-subtle); }
      .nbusers-table td { padding:9px 10px;border-bottom:1px solid var(--border-subtle);vertical-align:middle; }
      .nbusers-account-info { display:flex;align-items:center;gap:10px; }
      .nbusers-avatar { width:34px;height:34px;border-radius:50%;background:var(--accent-muted);color:var(--accent);display:inline-flex;align-items:center;justify-content:center;font-size:14px;font-weight:600; }
      .nbusers-chip { display:inline-block;font-size:10px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--border-default);color:var(--text-muted);margin-right:4px; }
      .nbusers-chip.owner, .nbusers-chip.admin { color:var(--accent);border-color:var(--accent); }
      .nbusers-chip.disabled, .nbusers-chip.locked { color:var(--text-danger);border-color:var(--text-danger); }
      .nbusers-quota { width:120px;height:6px;border-radius:4px;background:var(--bg-overlay);overflow:hidden; }
      .nbusers-quota > div { height:100%;background:var(--accent); }
      .nbusers-quota.over > div { background:var(--text-danger); }
      .nbusers-rowactions { display:flex;gap:6px;flex-wrap:wrap; }
      .nbusers-empty { text-align:center;color:var(--text-muted);padding:48px 12px;font-size:13px; }
      .nbusers-form { display:flex;flex-direction:column;gap:10px;max-width:460px; }
      .nbusers-form label { font-size:11px;color:var(--text-muted); }
      .nbusers-form input, .nbusers-form select { padding:9px 12px;border-radius:9px;border:1px solid var(--border-default);background:var(--bg-overlay);color:var(--text-primary);font-size:13px;outline:none; }
      .nbusers-event { padding:8px 10px;border-left:3px solid var(--border-default);margin-bottom:6px;background:var(--bg-overlay);border-radius:6px;font-size:12px; }
      .nbusers-event.info { border-left-color:var(--accent); }
      .nbusers-event.warn { border-left-color:var(--text-warning); }
      .nbusers-event.error { border-left-color:var(--text-danger); }
      .nbusers-status { min-height:18px;font-size:12px;color:var(--text-danger);margin-top:10px; }
      .nbusers-ok { color:var(--text-muted); }
      .nbusers-banner { display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px 14px;margin-bottom:14px;border:1px solid var(--text-warning);border-radius:9px;background:var(--bg-elevated);color:var(--text-warning);font-size:12px; }
    `;
    content.appendChild(css);

    const root = createEl('div', { className: 'nbusers-root' });
    content.appendChild(root);

    // ── Admin API transport ───────────────────────────────────────────────
    // System apps run in the trusted host, so this talks to the role-gated
    // /api/auth/admin family through SessionManager.authFetch (bearer + CSRF).
    // The server re-checks the session role on every route.
    const uidPath = (p) => `/api/auth/admin/users/${encodeURIComponent(p.uid)}`;
    const ROUTES = {
      'accounts.list':            { method: 'GET',    path: () => '/api/auth/admin/users' },
      'accounts.create':          { method: 'POST',   path: () => '/api/auth/admin/users', body: (p) => p.account },
      'accounts.update':          { method: 'PATCH',  path: uidPath, body: (p) => p.patch },
      'accounts.disable':         { method: 'POST',   path: (p) => `${uidPath(p)}/disable` },
      'accounts.enable':          { method: 'POST',   path: (p) => `${uidPath(p)}/enable` },
      'accounts.lock':            { method: 'POST',   path: (p) => `${uidPath(p)}/lock` },
      'accounts.unlock':          { method: 'POST',   path: (p) => `${uidPath(p)}/unlock` },
      'accounts.forceLogout':     { method: 'POST',   path: (p) => `${uidPath(p)}/force-logout` },
      'accounts.resetCredential': { method: 'POST',   path: (p) => `${uidPath(p)}/reset-credential` },
      'accounts.delete':          { method: 'DELETE', path: (p) => `${uidPath(p)}${p.mode === 'wipe' ? '?mode=wipe' : ''}`, body: (p) => (p.mode ? { mode: p.mode } : undefined) },
      'accounts.setPin':          { method: 'POST',   path: (p) => `${uidPath(p)}/credentials/pin`, body: (p) => ({ pin: p.pin }) },
      'accounts.setPassphrase':   { method: 'POST',   path: (p) => `${uidPath(p)}/credentials/passphrase`, body: (p) => ({ passphrase: p.passphrase ?? null }) },
      'accounts.webauthn.list':   { method: 'GET',    path: (p) => `${uidPath(p)}/webauthn` },
      'accounts.webauthn.remove': { method: 'DELETE', path: (p) => `${uidPath(p)}/webauthn/${encodeURIComponent(p.credentialId)}` },
      'policies.get':             { method: 'GET',    path: () => '/api/auth/admin/policies' },
      'policies.set':             { method: 'PUT',    path: () => '/api/auth/admin/policies', body: (p) => p.policies },
      'events.list':              { method: 'GET',    path: (p) => { const q = new URLSearchParams(); for (const k of ['uid', 'severity', 'action', 'limit', 'offset']) if (p?.[k] !== undefined && p?.[k] !== null) q.set(k, String(p[k])); return `/api/auth/admin/events${q.toString() ? '?' + q.toString() : ''}`; } },
      'usage.get':                { method: 'GET',    path: () => '/api/auth/admin/usage' },
    };

    async function adminUsers(action, payload = {}) {
      const sm = window.SessionManager;
      if (!sm || typeof sm.authFetch !== 'function') {
        return { success: false, code: 'UNAVAILABLE', message: 'Session service is not available' };
      }
      if (typeof NovaUserScope === 'undefined' || !NovaUserScope.enabled()) {
        return { success: false, code: 'MULTI_USER_DISABLED', message: 'Multi-user is off. Enable it to manage accounts.' };
      }
      if (!sm.isAdmin()) {
        return { success: false, code: 'PERMISSION_DENIED', message: 'An administrator account is required for account management' };
      }
      if (!Object.prototype.hasOwnProperty.call(ROUTES, action)) {
        return { success: false, code: 'UNAVAILABLE', message: `Unknown action: ${action}` };
      }
      const route = ROUTES[action];
      const args = { ...payload };
      const { status, json, error } = await sm.authFetch(route.path(args), {
        method: route.method,
        body: route.body ? route.body(args) : undefined,
      });
      if (!json || json.success !== true) {
        const code = status === 403 ? 'PERMISSION_DENIED' : (status === 404 ? 'NOT_FOUND' : 'UNAVAILABLE');
        // serverCode/status ride along so callers can tell an expired session
        // (401 AUTH_REQUIRED) from a transport failure (status 0) from a role
        // denial (403 ADMIN_REQUIRED) — the list renderer degrades each way.
        return { success: false, code, serverCode: json?.code || null, status, message: json?.message || error || `Account management request failed (${status})` };
      }
      return { success: true, data: json.data };
    }

    function isPermissionDenied(result) {
      return result && result.success !== true &&
        (result.code === 'PERMISSION_DENIED' || result.code === 'MULTI_USER_DISABLED' || result.error === 'PERMISSION_DENIED' ||
          /administrator account is required|not in admin mode|admin:users permission/i.test(String(result.message || result.error || '')));
    }

    function fmtBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let value = bytes; let i = 0;
      while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
      return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
    }

    function fmtDate(ts) {
      if (!ts) return _t('apps.users.never');
      try { return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return String(ts); }
    }

    function avatarText(user) {
      if (typeof user?.avatar === 'string' && user.avatar && user.avatar.length <= 8) return user.avatar;
      return String(user?.displayName || user?.username || '?').trim().charAt(0).toUpperCase();
    }

    // ── Splash when the session is not an admin ────────────────────────────
    function roleDeniedSplash(message) {
      root.innerHTML = '';
      const splash = createEl('div', {
        className: 'nbusers-empty',
        style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:10px;',
      });
      splash.appendChild(createEl('div', { style: 'font-size:34px', textContent: '🔒' }));
      splash.appendChild(createEl('div', { style: 'font-size:15px;font-weight:600', textContent: /multi-user is off/i.test(message || '') ? _t('apps.users.splash.multiUserOff') : _t('apps.users.splash.adminRequired') }));
      splash.appendChild(createEl('div', { style: 'font-size:12px;max-width:380px;text-align:center', textContent: message || _t('apps.users.splash.deniedBody') }));
      root.appendChild(splash);
    }

    // ── Shell: tabs ───────────────────────────────────────────────────────
    const tabBar = createEl('div', { className: 'nbusers-tabs' });
    const body = createEl('div', { className: 'nbusers-body' });
    root.appendChild(tabBar);
    root.appendChild(body);

    const TABS = [
      { id: 'users', name: _t('apps.users.tabs.users') },
      { id: 'policies', name: _t('apps.users.tabs.policies') },
      { id: 'audit', name: _t('apps.users.tabs.audit') },
    ];
    let activeTab = 'users';
    const tabButtons = {};

    function selectTab(id) {
      activeTab = id;
      for (const [tid, btn] of Object.entries(tabButtons)) {
        btn.classList.toggle('active', tid === id);
      }
      return renderTab();
    }

    for (const tab of TABS) {
      const btn = createEl('button', { className: 'nbusers-tab', textContent: tab.name });
      btn.addEventListener('click', () => selectTab(tab.id), { signal });
      tabButtons[tab.id] = btn;
      tabBar.appendChild(btn);
    }

    // ── Users tab ─────────────────────────────────────────────────────────
    let usersCache = [];
    let usageCache = [];
    // Outcome of the LAST accounts.list fetch for the renderer: null = clean;
    // { kind: 'session' } = the admin session is gone (401 AUTH_REQUIRED);
    // { kind: 'degraded', message } = any other fetch failure — the last
    // known list stays on screen instead of silently collapsing to empty.
    let listProblem = null;

    function isAdminRoleDenied(result) {
      // Only a genuine admin-role refusal replaces the console with the
      // role-denied splash: the local gates (multi-user off / non-admin
      // session) and the server's 403 ADMIN_REQUIRED. Session-state 403s
      // (SUSPENDED/LOCKED) degrade with the last known list instead.
      if (result?.code === 'MULTI_USER_DISABLED') return true;
      if (/administrator account is required/i.test(String(result?.message || ''))) return true;
      return result?.serverCode === 'ADMIN_REQUIRED';
    }

    async function loadUsers() {
      const result = await adminUsers('accounts.list');
      if (isPermissionDenied(result)) {
        if (isAdminRoleDenied(result)) return { denied: true, message: result.message };
        listProblem = { kind: 'degraded', message: result.message || _t('apps.users.degradedRefresh') };
        return { denied: false, degraded: listProblem.message };
      }
      if (result?.success !== true) {
        // A failed refresh (401 / network / UNAVAILABLE) must NEVER collapse
        // the list to empty: keep the previous usersCache and surface the
        // failure as a banner so the admin keeps working from the last
        // known state.
        if (result?.status === 401 || result?.serverCode === 'AUTH_REQUIRED') {
          listProblem = { kind: 'session' };
          return { denied: false, degraded: _t('apps.users.sessionExpired') };
        }
        listProblem = { kind: 'degraded', message: result?.message || _t('apps.users.degradedRefresh') };
        return { denied: false, degraded: listProblem.message };
      }
      usersCache = result.data?.users || result.users || [];
      listProblem = null;
      const usageResult = await adminUsers('usage.get');
      if (usageResult?.success) {
        usageCache = usageResult.data?.usage || usageResult.usage || [];
      }
      return { denied: false };
    }

    /** Inline banner above the list when the last refresh failed. */
    function buildListProblemBanner() {
      const banner = createEl('div', { className: 'nbusers-banner', role: 'alert' });
      const text = listProblem.kind === 'session'
        ? _t('apps.users.sessionExpired')
        : (listProblem.message && listProblem.message !== _t('apps.users.degradedRefresh')
          ? `${_t('apps.users.degradedRefresh')} (${listProblem.message})`
          : _t('apps.users.degradedRefresh'));
      banner.appendChild(createEl('span', { style: 'flex:1;min-width:220px;', textContent: text }));
      const action = createEl('button', { className: 'nbusers-btn' });
      if (listProblem.kind === 'session') {
        action.textContent = _t('shell.lock.signIn');
        action.setAttribute('aria-label', _t('shell.lock.signIn'));
        // The server session is dead (401) but the local one is still
        // 'active', so showLoginPicker() alone silently bails (M10 guard) —
        // switchUser() suspends/tears the dead session down first and then
        // presents the picker.
        action.addEventListener('click', async () => {
          try { await window.LockScreenService?.switchUser?.(); }
          catch (_) {
            try { await window.LockScreenService?.showLoginPicker?.(); } catch (_) { /* unavailable */ }
          }
        }, { signal });
      } else {
        action.textContent = _t('apps.users.retry');
        action.setAttribute('aria-label', _t('apps.users.retry'));
        action.addEventListener('click', () => { refresh(); }, { signal });
      }
      banner.appendChild(action);
      return banner;
    }

    function usageFor(uid) {
      return usageCache.find(entry => entry.uid === uid) || null;
    }

    function renderUsers() {
      body.innerHTML = '';
      if (listProblem) body.appendChild(buildListProblemBanner());
      const toolbar = createEl('div', { className: 'nbusers-toolbar' });
      toolbar.appendChild(createEl('div', { style: 'font-size:14px;font-weight:600', textContent: _t('apps.users.accountsCount', { count: usersCache.length }) }));
      const addBtn = createEl('button', { className: 'nbusers-btn primary nbusers-add-btn' });
      addBtn.setAttribute('aria-label', _t('apps.users.addAccount'));
      const addIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      addIcon.setAttribute('viewBox', '0 0 24 24');
      addIcon.setAttribute('width', '16');
      addIcon.setAttribute('height', '16');
      addIcon.setAttribute('fill', 'none');
      addIcon.setAttribute('stroke', 'currentColor');
      addIcon.setAttribute('stroke-width', '2');
      addIcon.setAttribute('stroke-linecap', 'round');
      addIcon.setAttribute('aria-hidden', 'true');
      const addIconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      addIconPath.setAttribute('d', 'M12 5v14M5 12h14');
      addIcon.appendChild(addIconPath);
      addBtn.appendChild(addIcon);
      addBtn.appendChild(createEl('span', { textContent: _t('apps.users.addAccount') }));
      addBtn.addEventListener('click', () => renderAddUser(), { signal });
      toolbar.appendChild(addBtn);
      body.appendChild(toolbar);

      if (!usersCache.length) {
        body.appendChild(createEl('div', { className: 'nbusers-empty', textContent: _t('apps.users.noAccounts') }));
        return;
      }

      const table = createEl('table', { className: 'nbusers-table' });
      const head = createEl('tr');
      for (const label of [_t('apps.users.table.account'), _t('apps.users.table.username'), _t('apps.users.table.role'), _t('apps.users.table.status'), _t('apps.users.table.lastSignIn'), _t('apps.users.table.storage'), _t('apps.users.table.actions')]) {
        head.appendChild(createEl('th', { textContent: label }));
      }
      const thead = createEl('thead');
      thead.appendChild(head);
      table.appendChild(thead);
      const tbody = createEl('tbody');

      for (const user of usersCache) {
        const usage = usageFor(user.uid);
        const quota = user.quotaBytes || usage?.quotaBytes || 0;
        const used = usage?.usageBytes || 0;
        const pct = quota ? Math.min(100, Math.round(used / quota * 100)) : 0;

        const row = createEl('tr');

        const cellAccount = createEl('td');
        const accountInfo = createEl('div', { className: 'nbusers-account-info' });
        accountInfo.appendChild(createEl('span', { className: 'nbusers-avatar', textContent: avatarText(user) }));
        const nameWrap = createEl('div');
        nameWrap.appendChild(createEl('div', { style: 'font-weight:600', textContent: user.displayName || user.username }));
        if (user.locked) nameWrap.appendChild(createEl('div', { style: 'font-size:10px;color:var(--text-danger)', textContent: _t('apps.users.lockedNeedsUnlock') }));
        accountInfo.appendChild(nameWrap);
        cellAccount.appendChild(accountInfo);
        row.appendChild(cellAccount);

        row.appendChild(createEl('td', { textContent: user.username }));
        row.appendChild(createEl('td', null, [
          createEl('span', { className: `nbusers-chip ${user.role}`, textContent: user.roleLabel || user.role }),
        ]));
        row.appendChild(createEl('td', null, [
          createEl('span', { className: `nbusers-chip ${user.status}`, textContent: user.status }),
          user.locked ? createEl('span', { className: 'nbusers-chip locked', textContent: _t('apps.users.lockedChip') }) : null,
        ]));
        row.appendChild(createEl('td', { textContent: fmtDate(user.lastLoginAt) }));

        const cellQuota = createEl('td');
        const bar = createEl('div', { className: `nbusers-quota${pct >= 90 ? ' over' : ''}` });
        bar.appendChild(createEl('div', { style: `width:${pct}%` }));
        cellQuota.appendChild(bar);
        cellQuota.appendChild(createEl('div', { style: 'font-size:10px;color:var(--text-muted);margin-top:3px', textContent: `${fmtBytes(used)} / ${fmtBytes(quota)}` }));
        row.appendChild(cellQuota);

        const cellActions = createEl('td');
        const actions = createEl('div', { className: 'nbusers-rowactions' });

        const mkBtn = (label, className, handler, title) => {
          const btn = createEl('button', { className: `nbusers-btn ${className || ''}`, textContent: label });
          if (title) btn.title = title;
          btn.addEventListener('click', handler, { signal });
          return btn;
        };

        actions.appendChild(mkBtn(_t('apps.users.actions.edit'), '', () => renderEditUser(user), _t('apps.users.actions.editTitle')));
        if (user.role !== 'owner') {
          if (user.status === 'active') {
            actions.appendChild(mkBtn(_t('apps.users.actions.disable'), '', () => adminAction('accounts.disable', { uid: user.uid }, 'disable'), _t('apps.users.actions.disableTitle')));
          } else {
            actions.appendChild(mkBtn(_t('apps.users.actions.enable'), '', () => adminAction('accounts.enable', { uid: user.uid }, 'enable')));
          }
          if (user.locked) {
            actions.appendChild(mkBtn(_t('apps.users.actions.unlock'), '', () => adminAction('accounts.unlock', { uid: user.uid }, 'unlock'), _t('apps.users.actions.unlockTitle')));
          }
        }
        actions.appendChild(mkBtn(_t('apps.users.actions.resetPin'), '', () => resetCredential(user), _t('apps.users.actions.resetPinTitle')));
        actions.appendChild(mkBtn(_t('apps.users.actions.forceOut'), 'ghost', () => adminAction('accounts.forceLogout', { uid: user.uid }, 'force-logout'), _t('apps.users.actions.forceOutTitle')));
        if (user.role !== 'owner') {
          actions.appendChild(mkBtn(_t('apps.users.actions.delete'), 'danger', () => renderDeleteUser(user), _t('apps.users.actions.deleteTitle')));
        }
        cellActions.appendChild(actions);
        row.appendChild(cellActions);

        tbody.appendChild(row);
      }
      table.appendChild(tbody);
      body.appendChild(table);
    }

    async function adminAction(action, payload, verbLabel) {
      const result = await adminUsers(action, payload);
      if (result?.success) {
        await refresh();
        return true;
      }
      const message = result?.message || result?.error || _t('apps.users.actionFailed', { verb: verbLabel });
      toast(message, true);
      return false;
    }

    let toastTimer = 0;
    function toast(message, isError) {
      let el = root.querySelector('.nbusers-toast');
      if (!el) {
        el = createEl('div', {
          className: 'nbusers-toast',
          style: 'position:sticky;bottom:10px;align-self:center;padding:10px 16px;border-radius:10px;font-size:12px;z-index:5;pointer-events:none;',
        });
        root.appendChild(el);
      }
      el.textContent = message;
      el.style.border = `1px solid ${isError ? 'var(--text-danger)' : 'var(--accent)'}`;
      el.style.color = isError ? 'var(--text-danger)' : 'var(--accent)';
      el.style.background = 'var(--bg-elevated)';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.remove(), 5000);
    }

    // Add-user wizard (Table 9): account → credentials → review.
    function renderAddUser() {
      body.innerHTML = '';
      body.appendChild(createEl('div', { style: 'font-size:14px;font-weight:600;margin-bottom:4px', textContent: _t('apps.users.addAccount') }));
      body.appendChild(createEl('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:16px', textContent: _t('apps.users.add.subtitle') }));

      const form = createEl('div', { className: 'nbusers-form' });
      const fields = [
        { id: 'nu-display', label: _t('apps.users.fields.displayName'), type: 'text', placeholder: _t('apps.users.fields.displayNamePlaceholder') },
        { id: 'nu-username', label: _t('apps.users.fields.usernameLabel'), type: 'text', placeholder: _t('apps.users.fields.usernamePlaceholder') },
        { id: 'nu-role', label: _t('apps.users.fields.role'), type: 'select', options: [['standard', _t('apps.users.roles.standard')], ['admin', _t('apps.users.roles.admin')]] },
        { id: 'nu-pin', label: _t('apps.users.fields.pinLabel'), type: 'password', placeholder: '••••', maxlength: '6' },
        { id: 'nu-pin2', label: _t('apps.users.confirmPin'), type: 'password', placeholder: '••••', maxlength: '6' },
        { id: 'nu-pass', label: _t('apps.users.fields.passphraseLabel'), type: 'password', placeholder: _t('apps.users.fields.passphrasePlaceholder') },
        { id: 'nu-quota', label: _t('apps.users.fields.quotaDefault'), type: 'number', placeholder: '2', min: '1', max: '32', step: '0.5' },
      ];
      const inputs = {};
      for (const f of fields) {
        form.appendChild(createEl('label', { htmlFor: f.id, textContent: f.label }));
        let input;
        if (f.type === 'select') {
          input = createEl('select');
          for (const [value, label] of f.options) {
            input.appendChild(createEl('option', { value, textContent: label }));
          }
        } else {
          input = createEl('input', { id: f.id, type: f.type, placeholder: f.placeholder || '' });
          if (f.maxlength) input.setAttribute('maxlength', f.maxlength);
          if (f.min) input.setAttribute('min', f.min);
          if (f.max) input.setAttribute('max', f.max);
          if (f.step) input.setAttribute('step', f.step);
        }
        input.style.width = '100%';
        form.appendChild(input);
        inputs[f.id] = input;
      }
      body.appendChild(form);

      const status = createEl('div', { className: 'nbusers-status' });
      body.appendChild(status);

      const row = createEl('div', { style: 'display:flex;gap:10px;margin-top:6px' });
      const cancel = createEl('button', { className: 'nbusers-btn ghost', textContent: _t('common.cancel') });
      cancel.addEventListener('click', () => { selectTab('users'); }, { signal });
      const create = createEl('button', { className: 'nbusers-btn primary', textContent: _t('apps.users.createAccount') });
      create.addEventListener('click', async () => {
        const displayName = inputs['nu-display'].value.trim();
        const username = inputs['nu-username'].value.trim().toLowerCase();
        const role = inputs['nu-role'].value;
        const pin = inputs['nu-pin'].value;
        const pinConfirm = inputs['nu-pin2'].value;
        const passphrase = inputs['nu-pass'].value;
        const quotaGB = parseFloat(inputs['nu-quota'].value);
        if (!displayName) { status.textContent = _t('apps.users.validation.displayNameRequired'); return; }
        if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) { status.textContent = _t('apps.users.validation.usernameInvalid'); return; }
        if (!/^\d{4,6}$/.test(pin)) { status.textContent = _t('apps.users.validation.pinDigits'); return; }
        if (pin !== pinConfirm) { status.textContent = _t('apps.users.pinMismatch'); return; }
        if (passphrase && passphrase.length < 8) { status.textContent = _t('apps.users.validation.passphraseTooShort'); return; }
        status.textContent = _t('apps.users.creating');
        const account = { displayName, username, role, pin };
        if (passphrase) account.passphrase = passphrase;
        if (Number.isFinite(quotaGB) && quotaGB > 0) account.quotaBytes = Math.round(quotaGB * 1024 * 1024 * 1024);
        const result = await adminUsers('accounts.create', { account });
        if (result?.success) {
          status.textContent = '';
          await refresh();
          selectTab('users');
          toast(_t('apps.users.accountCreated', { username }));
        } else {
          status.textContent = result?.message || result?.error || _t('apps.users.creationFailed');
        }
      }, { signal });
      row.appendChild(cancel);
      row.appendChild(create);
      body.appendChild(row);
    }

    function renderEditUser(user) {
      body.innerHTML = '';
      body.appendChild(createEl('div', { style: 'font-size:14px;font-weight:600;margin-bottom:4px', textContent: _t('apps.users.editTitle', { name: user.displayName || user.username }) }));
      body.appendChild(createEl('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:16px', textContent: _t('apps.users.edit.subtitle') }));

      const form = createEl('div', { className: 'nbusers-form' });
      const displayNameInput = createEl('input', { type: 'text', value: user.displayName || '' });
      const roleSelect = createEl('select');
      roleSelect.appendChild(createEl('option', { value: 'standard', textContent: _t('apps.users.roles.standard') }));
      roleSelect.appendChild(createEl('option', { value: 'admin', textContent: _t('apps.users.roles.admin') }));
      roleSelect.value = user.role === 'admin' ? 'admin' : 'standard';
      if (user.role === 'owner') {
        roleSelect.value = 'admin';
        roleSelect.disabled = true;
      }
      const quotaInput = createEl('input', { type: 'number', min: '1', max: '32', step: '0.5', value: (user.quotaBytes ? +(user.quotaBytes / (1024 ** 3)).toFixed(1) : 2) });
      quotaInput.style.width = '100%';
      displayNameInput.style.width = '100%';

      form.appendChild(createEl('label', { textContent: _t('apps.users.fields.displayName') }));
      form.appendChild(displayNameInput);
      form.appendChild(createEl('label', { textContent: _t('apps.users.fields.role') }));
      form.appendChild(roleSelect);
      if (user.role !== 'owner') { /* role editing allowed */ }
      form.appendChild(createEl('label', { textContent: _t('apps.users.fields.storageQuota') }));
      form.appendChild(quotaInput);
      body.appendChild(form);

      const status = createEl('div', { className: 'nbusers-status' });
      body.appendChild(status);

      const row = createEl('div', { style: 'display:flex;gap:10px;margin-top:6px' });
      const back = createEl('button', { className: 'nbusers-btn ghost', textContent: _t('common.back') });
      back.addEventListener('click', () => selectTab('users'), { signal });
      const save = createEl('button', { className: 'nbusers-btn primary', textContent: _t('common.save') });
      save.addEventListener('click', async () => {
        const patch = { displayName: displayNameInput.value.trim() || user.username };
        if (user.role !== 'owner') patch.role = roleSelect.value;
        const gb = parseFloat(quotaInput.value);
        if (Number.isFinite(gb) && gb > 0) patch.quotaBytes = Math.round(gb * 1024 * 1024 * 1024);
        const result = await adminUsers('accounts.update', { uid: user.uid, patch });
        if (result?.success) {
          await refresh();
          selectTab('users');
          toast(_t('apps.users.accountUpdated'));
        } else {
          status.textContent = result?.message || result?.error || _t('apps.users.updateFailed');
        }
      }, { signal });
      row.appendChild(back);
      row.appendChild(save);
      body.appendChild(row);
    }

    /** Confirmation view for resetting the CURRENT account's PIN. */
    function confirmResetPinSelf(user) {
      return new Promise((resolve) => {
        body.innerHTML = '';
        body.appendChild(createEl('div', { style: 'font-size:14px;font-weight:600;margin-bottom:4px', textContent: _t('apps.users.resetPinSelfWarning', { name: user.displayName || user.username }) }));
        body.appendChild(createEl('div', {
          style: 'font-size:12px;color:var(--text-warning);margin-bottom:16px;max-width:460px',
          textContent: _t('apps.users.resetPinSelfWarningBody'),
        }));
        const row = createEl('div', { style: 'display:flex;gap:10px;margin-top:6px' });
        const cancel = createEl('button', { className: 'nbusers-btn ghost', textContent: _t('common.cancel') });
        cancel.addEventListener('click', () => { resolve(false); }, { signal });
        const confirm = createEl('button', { className: 'nbusers-btn danger', textContent: _t('apps.users.resetPinSelfWarningConfirm') });
        confirm.addEventListener('click', () => { resolve(true); }, { signal });
        row.appendChild(cancel);
        row.appendChild(confirm);
        body.appendChild(row);
      });
    }

    async function resetCredential(user) {
      // Resetting your OWN PIN revokes every session of the account
      // server-side — including the admin session this console is riding,
      // which used to make the whole account list "disappear" on the next
      // fetch. Confirm the sign-out-everywhere consequence first.
      const currentUid = window.SessionManager?.state?.()?.uid ?? null;
      if (currentUid && currentUid === user.uid) {
        const confirmed = await confirmResetPinSelf(user);
        if (!confirmed) {
          await refresh();
          return;
        }
      }
      const result = await adminUsers('accounts.resetCredential', { uid: user.uid });
      if (!result?.success) {
        toast(result?.message || result?.error || _t('apps.users.resetFailed'), true);
        return;
      }
      const data = result.data || {};
      // The temporary PIN is shown exactly once.
      body.innerHTML = '';
      body.appendChild(createEl('div', { style: 'font-size:14px;font-weight:600;margin-bottom:4px', textContent: _t('apps.users.temporaryPinTitle', { name: user.displayName || user.username }) }));
      body.appendChild(createEl('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:16px;max-width:460px', textContent: currentUid === user.uid ? _t('apps.users.resetPinSelfWarningDone') : _t('apps.users.temporaryPinBody') }));
      const pinCard = createEl('div', {
        style: 'display:inline-block;padding:18px 26px;border-radius:12px;border:1px dashed var(--accent);font-size:26px;letter-spacing:6px;font-weight:700;color:var(--accent);background:var(--bg-overlay);',
        textContent: String(data.temporaryPin || ''),
      });
      body.appendChild(pinCard);
      const back = createEl('button', { className: 'nbusers-btn', textContent: _t('apps.users.done') });
      back.style.marginTop = '16px';
      // Refresh is deferred to THIS click: awaiting refresh() straight after
      // the reset wiped the temporary-PIN card before it was ever seen (and
      // a self-reset just killed this session — the deferred refresh then
      // lands on the session-expired banner instead of erasing the card).
      back.addEventListener('click', () => { refresh(); }, { signal });
      body.appendChild(back);
    }

    function renderDeleteUser(user) {
      body.innerHTML = '';
      body.appendChild(createEl('div', { style: 'font-size:14px;font-weight:600;margin-bottom:4px', textContent: _t('apps.users.deleteTitle', { name: user.displayName || user.username }) }));
      body.appendChild(createEl('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:16px', textContent: _t('apps.users.delete.subtitle') }));

      const status = createEl('div', { className: 'nbusers-status' });
      const row = createEl('div', { style: 'display:flex;flex-direction:column;gap:10px;max-width:460px' });

      const mk = (title, description, mode, className) => {
        const card = createEl('div', { style: 'padding:14px;border-radius:10px;border:1px solid var(--border-default);cursor:pointer;' });
        card.appendChild(createEl('div', { style: 'font-weight:600;font-size:13px', textContent: title }));
        card.appendChild(createEl('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:4px', textContent: description }));
        card.addEventListener('click', async () => {
          card.style.borderColor = 'var(--accent)';
          status.textContent = '';
          const result = await adminUsers('accounts.delete', { uid: user.uid, mode });
          if (result?.success) {
            const data = result.data || {};
            await refresh();
            selectTab('users');
            toast(data.archivedTo ? _t('apps.users.archivedTo', { path: String(data.archivedTo).split('admin-backups')[1] || '' }) : _t('apps.users.accountDeleted'));
          } else {
            status.textContent = result?.message || result?.error || _t('apps.users.deletionRefused');
          }
        }, { signal });
        return card;
      };

      row.appendChild(mk(_t('apps.users.deleteMode.archive'), _t('apps.users.deleteMode.archiveBody'), 'archive'));
      row.appendChild(mk(_t('apps.users.deleteMode.wipe'), _t('apps.users.deleteMode.wipeBody'), 'wipe'));
      const back = createEl('button', { className: 'nbusers-btn ghost', textContent: _t('common.cancel') });
      back.addEventListener('click', () => selectTab('users'), { signal });
      row.appendChild(back);
      body.appendChild(row);
      body.appendChild(status);
    }

    // ── Policies tab ──────────────────────────────────────────────────────
    let policiesCache = null;

    async function loadPolicies() {
      const result = await adminUsers('policies.get');
      if (isPermissionDenied(result)) return { denied: true, message: result.message };
      policiesCache = result.data?.policies || result.policies || null;
      return { denied: false };
    }

    function renderPolicies() {
      body.innerHTML = '';
      if (!policiesCache) {
        body.appendChild(createEl('div', { className: 'nbusers-empty', textContent: _t('apps.users.policiesUnavailable') }));
        return;
      }
      body.appendChild(createEl('div', { style: 'font-size:14px;font-weight:600;margin-bottom:4px', textContent: _t('apps.users.policies.title') }));
      body.appendChild(createEl('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:16px', textContent: _t('apps.users.policies.subtitle') }));

      const p = policiesCache;
      const form = createEl('div', { className: 'nbusers-form' });

      const mkToggle = (key, label, hint) => {
        const wrap = createEl('label', { style: 'display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;' });
        const input = createEl('input', { type: 'checkbox' });
        input.checked = p[key] === true;
        wrap.appendChild(input);
        const text = createEl('span', {});
        text.appendChild(createEl('div', { textContent: label }));
        if (hint) text.appendChild(createEl('div', { style: 'font-size:11px;color:var(--text-muted)', textContent: hint }));
        wrap.appendChild(text);
        input.dataset.policyKey = key;
        form.appendChild(wrap);
        form.appendChild(createEl('div', { style: 'height:6px' }));
      };

      const mkNumber = (key, label, hint, min, max, step) => {
        form.appendChild(createEl('label', { textContent: label }));
        const input = createEl('input', { type: 'number', min: String(min), max: String(max), step: String(step) });
        const value = p[key];
        input.value = typeof value === 'number' ? value : '';
        input.style.width = '100%';
        input.dataset.policyKey = key;
        form.appendChild(input);
        if (hint) form.appendChild(createEl('div', { style: 'font-size:11px;color:var(--text-muted)', textContent: hint }));
        form.appendChild(createEl('div', { style: 'height:6px' }));
      };

      mkToggle('guestAccess', _t('apps.users.policies.guestAccess'), _t('apps.users.policies.guestAccessHint'));
      mkToggle('showUsernamesOnPicker', _t('apps.users.policies.showUsernames'), _t('apps.users.policies.showUsernamesHint'));
      mkToggle('closeAppsOnSwitch', _t('apps.users.policies.closeAppsOnSwitch'), _t('apps.users.policies.closeAppsHint'));
      mkNumber('defaultUserQuotaBytes', _t('apps.users.policies.defaultQuota'), _t('apps.users.policies.defaultQuotaHint'), 1024 * 1024, 32 * 1024 ** 3, 1024 * 1024);
      mkNumber('idleLockMaxMinutes', _t('apps.users.policies.idleLockMax'), _t('apps.users.policies.idleLockHint'), 1, 240, 1);
      mkNumber('lockoutShortMs', _t('apps.users.policies.lockoutStep1'), _t('apps.users.policies.lockoutStep1Hint'), 5000, 600000, 5000);
      mkNumber('lockoutExtendedMs', _t('apps.users.policies.lockoutStep2'), _t('apps.users.policies.lockoutStep2Hint'), 5000, 3600000, 5000);

      body.appendChild(form);
      const status = createEl('div', { className: 'nbusers-status' });
      body.appendChild(status);
      const save = createEl('button', { className: 'nbusers-btn primary', textContent: _t('apps.users.savePolicies') });
      save.addEventListener('click', async () => {
        const patch = {};
        for (const input of form.querySelectorAll('[data-policy-key]')) {
          const key = input.dataset.policyKey;
          patch[key] = input.type === 'checkbox' ? input.checked : Number(input.value);
        }
        const result = await adminUsers('policies.set', { policies: patch });
        if (result?.success) {
          policiesCache = result.data?.policies || policiesCache;
          status.textContent = _t('apps.users.saved');
          status.className = 'nbusers-status nbusers-ok';
        } else {
          status.textContent = result?.message || result?.error || _t('apps.users.policySaveFailed');
          status.className = 'nbusers-status';
        }
      }, { signal });
      body.appendChild(save);
    }

    // ── Audit tab ────────────────────────────────────────────────────────
    let auditFilterUid = '';

    async function renderAudit() {
      body.innerHTML = '';
      body.appendChild(createEl('div', { style: 'font-size:14px;font-weight:600;margin-bottom:4px', textContent: _t('apps.users.audit.title') }));
      body.appendChild(createEl('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:14px', textContent: _t('apps.users.audit.subtitle') }));

      const toolbar = createEl('div', { className: 'nbusers-toolbar' });
      const filter = createEl('select');
      filter.appendChild(createEl('option', { value: '', textContent: _t('apps.users.audit.allAccounts') }));
      for (const user of usersCache) {
        filter.appendChild(createEl('option', { value: user.uid, textContent: user.displayName || user.username }));
      }
      filter.value = auditFilterUid;
      filter.addEventListener('change', () => { auditFilterUid = filter.value; renderAudit(); }, { signal });
      toolbar.appendChild(filter);
      const exportBtn = createEl('button', { className: 'nbusers-btn', textContent: _t('apps.users.audit.exportCsv') });
      exportBtn.addEventListener('click', exportAuditCsv, { signal });
      toolbar.appendChild(exportBtn);
      body.appendChild(toolbar);

      const result = await adminUsers('events.list', { limit: 200, ...(auditFilterUid ? { uid: auditFilterUid } : {}) });
      const events = result?.data?.events || result?.events || [];
      if (!events.length) {
        body.appendChild(createEl('div', { className: 'nbusers-empty', textContent: _t('apps.users.audit.noEvents') }));
        return;
      }
      for (const event of events) {
        const el = createEl('div', { className: `nbusers-event ${event.severity || 'info'}` });
        el.appendChild(createEl('div', {
          style: 'display:flex;justify-content:space-between;gap:10px;color:var(--text-muted);font-size:11px;',
        }, [
          createEl('span', { textContent: fmtDate(event.ts) }),
          createEl('span', { textContent: event.actor || '' }),
        ]));
        el.appendChild(createEl('div', { style: 'font-weight:600', textContent: event.action }));
        if (event.target) el.appendChild(createEl('div', { style: 'color:var(--text-muted)', textContent: _t('apps.users.audit.target', { target: event.target }) }));
        if (event.detail && typeof event.detail === 'object') {
          el.appendChild(createEl('div', { style: 'color:var(--text-muted);font-size:11px;white-space:pre-wrap;', textContent: JSON.stringify(event.detail) }));
        }
        body.appendChild(el);
      }
    }

    async function exportAuditCsv() {
      const result = await adminUsers('events.list', { ...(auditFilterUid ? { uid: auditFilterUid } : {}), limit: 1000 });
      const events = result?.data?.events || result?.events || [];
      const escapeCell = (value) => {
        const text = value === null || value === undefined ? '' : String(value);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      const lines = [ 'ts,actor,action,target,severity,ip' ];
      for (const event of events) {
        lines.push([new Date(event.ts).toISOString(), event.actor || '', event.action, event.target || '', event.severity || '', event.ip || ''].map(escapeCell).join(','));
      }
      try {
        const destination = await window.SystemDialogs.save({
          title: _t('apps.users.audit.exportTitle'),
          suggestedName: 'novabyte-account-events.csv',
        });
        if (!destination) return;
        const nodeRequire = typeof window.require === 'function'
          ? window.require
          : (typeof require === 'function' ? require : null);
        if (!nodeRequire) throw new Error(_t('apps.users.audit.fileWriteUnavailable'));
        await nodeRequire('fs').promises.writeFile(destination.path, lines.join('\n'), 'utf8');
        toast(_t('apps.users.audit.csvExported', { path: destination.path }));
      } catch (err) {
        toast(_t('apps.users.audit.csvExportFailed', { message: err?.message || err }), true);
      }
    }

    // ── Refresh / first paint ─────────────────────────────────────────────
    async function refresh() {
      const users = await loadUsers();
      if (users.denied) {
        roleDeniedSplash(users.message);
        return;
      }
      if (activeTab === 'users') renderUsers();
    }

    async function renderTab() {
      if (activeTab === 'users') {
        const users = await loadUsers();
        if (users.denied) { roleDeniedSplash(users.message); return; }
        renderUsers();
      } else if (activeTab === 'policies') {
        const policies = await loadPolicies();
        if (policies.denied) { roleDeniedSplash(policies.message); return; }
        renderPolicies();
      } else if (activeTab === 'audit') {
        renderAudit();
      }
    }

    // First paint: verify admin role + grant before any chrome renders, and
    // light the Users tab by routing through selectTab — the same path every
    // other tab takes — so the section is highlighted on launch (selectTab is
    // the only code that owns the .active class; renderUsers stays the body
    // builder renderTab calls for the 'users' tab).
    try {
      await selectTab('users');
    } catch (err) {
      roleDeniedSplash(_t('apps.users.splash.unreachable', { message: err?.message || err }));
    }
  },
});
