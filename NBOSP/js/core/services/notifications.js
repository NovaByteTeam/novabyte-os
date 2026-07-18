const Notify = {
  _storageKey: 'novaOS_notifications',
  _loaded: false,

  loadPersisted() {
    if (Notify._loaded) return;
    Notify._loaded = true;
    try {
      const saved = JSON.parse(localStorage.getItem(Notify._storageKey) || '[]');
      if (Array.isArray(saved)) {
        OS.notifications = saved.slice(0, 100);
        OS.notifUnread = OS.notifications.filter(n => !n.read).length;
      }
    } catch (e) {
      OS.notifications = [];
      OS.notifUnread = 0;
    }
  },

  persist() {
    try {
      localStorage.setItem(Notify._storageKey, JSON.stringify(OS.notifications.slice(0, 100)));
    } catch (e) {
      // localStorage can throw in private-browsing mode or when the quota
      // is full — persistence is best-effort, so we just drop it here.
    }
  },

  markAllRead() {
    let changed = false;
    OS.notifications = OS.notifications.map(n => {
      if (n && !n.read) {
        changed = true;
        return { ...n, read: true };
      }
      return n;
    });
    OS.notifUnread = 0;
    if (changed) Notify.persist();
    Notify.updateBadge();
    updateNotificationBadge();
    Notify.renderPanel();
  },

  clearAll() {
    OS.notifications = [];
    OS.notifUnread = 0;
    Notify.persist();
    Notify.updateBadge();
    updateNotificationBadge();
    Notify.renderPanel();
  },

  show(opts) {
    Notify.loadPersisted();
    const { title, body, type, appName, category, icon, action, actionLabel } = opts;
    const notif = {
      id: generateId(),
      title: title || '',
      body: body || '',
      type: type || 'info',
      appName: appName || 'System',
      category: category || 'system',
      icon: icon || 'bell',
      timestamp: Date.now(),
      read: false,
      action: action || null,
      actionLabel: actionLabel || null
    };
    OS.notifications.unshift(notif);
    if (OS.notifications.length > 100) OS.notifications.pop();
    OS.notifUnread++;
    Notify.updateBadge();
    updateNotificationBadge();
    Notify.renderPanel();
    Notify.persist();

    if (!OS.dnd) Notify.showToast(notif);

    if (notif.type === 'error' && typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'Notify', category: 'system', severity: 'error', message: `[${notif.appName}] ${notif.title}${notif.body ? ': ' + notif.body : ''}`, data: { appName: notif.appName, title: notif.title } });
    }
  },

  // Runs a notification's `action`. Function actions are called directly;
  // string actions go through the built-in allowlist (kept in sync with
  // ALLOWED_NOTIF_ACTIONS in app-sandbox.js). Shared by the toast and the
  // persistent panel so both surfaces behave the same way on click.
  runAction(notif) {
    try {
      if (typeof notif.action === 'function') {
        notif.action();
        return;
      }
      if (typeof notif.action === 'string') {
        switch (notif.action) {
          case 'settings':
          case 'open-settings':
          case 'openSettings':
            if (typeof WM !== 'undefined' && typeof WM.createWindow === 'function') {
              WM.createWindow('nook');
            } else {
              console.warn('[Notify] Cannot open settings — WM.createWindow unavailable');
              if (typeof EventLog !== 'undefined') {
                EventLog.log({ app: 'Notify', category: 'system', severity: 'warn', message: 'Open settings action failed — WM unavailable', data: { action: notif.action, appName: notif.appName } });
              }
            }
            break;
          default:
            console.warn('[Notify] Unknown built-in action:', notif.action);
            if (typeof EventLog !== 'undefined') {
              EventLog.log({ app: 'Notify', category: 'system', severity: 'warn', message: `Unknown built-in action: ${notif.action}`, data: { action: notif.action, appName: notif.appName } });
            }
        }
      }
    } catch (err) {
      console.error('[Notify] Action error:', err);
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'Notify', category: 'system', severity: 'error', message: `Action failed: ${err?.message || err}`, data: { appName: notif.appName } });
      }
      Notify.show({ title: 'Action Failed', body: err?.message || 'An unknown error occurred.', type: 'error', appName: notif.appName || 'System' });
    }
  },

  showToast(notif) {
    const container = document.getElementById('toast-container');
    // The container should always be in the page shell, but bail out
    // quietly instead of throwing if some layout variant doesn't have it —
    // a missing toast host shouldn't take down whatever called Notify.show().
    if (!container) {
      console.warn('[Notify] #toast-container not found, skipping toast for:', notif.title);
      return;
    }

    const toast = createEl('div', { className: `toast ${notif.type}`, role: 'alert' });

    const content = createEl('div', { className: 'toast-content' });
    const titleEl = createEl('div', { className: 'toast-title', textContent: notif.title });
    const bodyEl = createEl('div', { className: 'toast-body', textContent: notif.body });
    content.appendChild(titleEl);
    if (notif.body) content.appendChild(bodyEl);

    if (notif.action && notif.actionLabel) {
      const actionBtn = createEl('button', { className: 'toast-action' });
      actionBtn.textContent = notif.actionLabel;
      actionBtn.style.cssText = 'margin-left:auto;padding:6px 14px;font-size:12px;font-weight:600;border-radius:6px;background:rgba(88,166,255,0.2);color:#58a6ff;border:1px solid rgba(88,166,255,0.4);cursor:pointer;transition:all 0.15s;';
      actionBtn.onmouseenter = () => { actionBtn.style.background = 'rgba(88,166,255,0.35)'; };
      actionBtn.onmouseleave = () => { actionBtn.style.background = 'rgba(88,166,255,0.2)'; };
      actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearTimeout(timer);
        removeToast();
        Notify.runAction(notif);
      });
      content.appendChild(actionBtn);
    }

    const closeBtn = createEl('button', { className: 'toast-close', 'aria-label': 'Dismiss notification' });
    closeBtn.innerHTML = svgIcon('x', 14);

    toast.appendChild(content);
    toast.appendChild(closeBtn);
    container.appendChild(toast);

    // Toasts with an action get longer both on the initial timer and the
    // post-hover grace period, so a reader has time to notice the button
    // either way — the grace period isn't meant to be shorter than a plain
    // toast's full timer, just shorter than this toast's own initial one.
    const initialDelay = notif.action ? 8000 : 4000;
    const hoverGraceDelay = notif.action ? 4000 : 2000;
    let timer = setTimeout(() => removeToast(), initialDelay);

    toast.addEventListener('pointerenter', () => clearTimeout(timer));
    toast.addEventListener('pointerleave', () => { timer = setTimeout(() => removeToast(), hoverGraceDelay); });

    closeBtn.addEventListener('click', () => { clearTimeout(timer); removeToast(); });

    function removeToast() {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 300);
    }
  },

  updateBadge() {
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    if (OS.notifUnread > 0) {
      badge.textContent = OS.notifUnread > 99 ? '99+' : OS.notifUnread;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  },

  renderPanel() {
    Notify.loadPersisted();
    const list = document.getElementById('notif-list');
    if (!list) return;
    list.innerHTML = '';
    if (OS.notifications.length === 0) {
      list.innerHTML = '<div class="empty-state"><div class="text-muted">No notifications</div></div>';
      return;
    }
    // Building nodes in a fragment and appending once avoids a reflow per
    // notification row.
    const frag = document.createDocumentFragment();
    for (const n of OS.notifications.slice(0, 50)) {
      const item = createEl('div', { className: 'notif-item' });
      const icon = createEl('div', { style: { width: '24px', height: '24px', color: 'var(--text-secondary)', flexShrink: '0' } });
      icon.innerHTML = svgIcon('bell', 16);
      const content = createEl('div', { className: 'notif-item-content' });
      content.appendChild(createEl('div', { className: 'notif-item-title', textContent: n.title }));
      content.appendChild(createEl('div', { className: 'notif-item-body', textContent: n.body }));
      const ago = Date.now() - n.timestamp;
      const mins = Math.floor(ago / 60000);
      const timeStr = mins < 1 ? 'Just now' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ago`;
      content.appendChild(createEl('div', { className: 'notif-item-time', textContent: timeStr }));
      item.appendChild(icon);
      item.appendChild(content);

      if (n.action && n.actionLabel) {
        const actionBtn = createEl('button', { className: 'notif-item-action' });
        actionBtn.textContent = n.actionLabel;
        actionBtn.style.cssText = 'margin-left:auto;flex-shrink:0;padding:6px 14px;font-size:12px;font-weight:600;border-radius:6px;background:rgba(88,166,255,0.2);color:#58a6ff;border:1px solid rgba(88,166,255,0.4);cursor:pointer;transition:all 0.15s;';
        actionBtn.onmouseenter = () => { actionBtn.style.background = 'rgba(88,166,255,0.35)'; };
        actionBtn.onmouseleave = () => { actionBtn.style.background = 'rgba(88,166,255,0.2)'; };
        actionBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          Notify.runAction(n);
        });
        item.appendChild(actionBtn);
      }

      frag.appendChild(item);
    }
    list.appendChild(frag);
  },

  togglePanel() {
    Notify.loadPersisted();
    const panel = document.getElementById('notification-panel');
    if (!panel) return;
    const opening = !panel.classList.contains('active');
    panel.classList.toggle('active');
    if (typeof window.resetShellScroll === 'function') {
      window.resetShellScroll();
      requestAnimationFrame(window.resetShellScroll);
    }
    if (opening) {
      if (OS.notifications.length) {
        OS.notifications = OS.notifications.map(n => n && !n.read ? { ...n, read: true } : n);
        OS.notifUnread = 0;
        Notify.persist();
      }
      Notify.updateBadge();
      updateNotificationBadge();
      Notify.renderPanel();
      Notify._applyBackgroundContrast(panel);
    }
  },

  // Samples the background behind the panel to decide whether it needs
  // light or dark text. Each sample point costs a forced layout
  // (elementFromPoint + getComputedStyle), so this only runs once per
  // panel-open rather than on a timer or scroll handler. It stops at the
  // first light pixel it finds, same as before — the one change from the
  // original is scanning point-by-point instead of building a separate
  // array of every point first and then looping over that array, which
  // was doing the same work twice for no benefit.
  _applyBackgroundContrast(panel) {
    try {
      const rect = panel.getBoundingClientRect();
      const step = 30;
      let lightSample = false;

      outer:
      for (let sx = rect.left + 10; sx < rect.right - 10; sx += step) {
        for (let sy = rect.top + 10; sy < rect.bottom - 10; sy += step) {
          const el = document.elementFromPoint(sx, sy);
          if (!el) continue;
          const bg = getComputedStyle(el).backgroundColor;
          const m = bg.match(/\d+/g);
          if (!m || m.length < 3) continue;
          const r = parseInt(m[0], 10);
          const g = parseInt(m[1], 10);
          const b = parseInt(m[2], 10);
          const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
          if (luminance > 160) {
            lightSample = true;
            break outer;
          }
        }
      }

      panel.classList.toggle('light-bg', lightSample);
    } catch (e) {
      // If sampling fails, keep whatever text color class was already set.
    }
  }
};

if (typeof Notify !== 'undefined') {
  window.Notify = Notify;
} else {
  console.warn('Notify object was not found in the local scope of app-notifications.js');
}