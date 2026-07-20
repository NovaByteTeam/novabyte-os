// Known, safe values for notif.icon / opts.icon. svgIcon() is an external
// global we don't control, so we validate the key here at the boundary
// before it ever reaches innerHTML, rather than trusting whatever string an
// app passed into show().
const KNOWN_ICONS = new Set(['bell', 'zap', 'x', 'info', 'error', 'warning', 'success']);

function safeIconKey(icon) {
  return KNOWN_ICONS.has(icon) ? icon : 'bell';
}

// Shared inline styles for the two "action" buttons (toast + panel row).
// Was duplicated as two near-identical cssText strings before.
const ACTION_BUTTON_STYLE = 'padding:6px 14px;font-size:12px;font-weight:600;border-radius:6px;background:rgba(88,166,255,0.2);color:#58a6ff;border:1px solid rgba(88,166,255,0.4);cursor:pointer;transition:all 0.15s;';

function wireActionButtonHover(btn) {
  btn.addEventListener('pointerenter', () => { btn.style.background = 'rgba(88,166,255,0.35)'; });
  btn.addEventListener('pointerleave', () => { btn.style.background = 'rgba(88,166,255,0.2)'; });
}

// Epoch-ms timestamp -> short "time ago" / "running for" string. Kept as a
// standalone function (rather than inline in renderPanel) so the date math
// lives in one place instead of being duplicated inline.
//
// This stays on Date.now() rather than Temporal: Temporal is ES2026 and
// needs either a native runtime that ships it or the @js-temporal/polyfill
// package, and this file has neither an import for that polyfill nor any
// build step that would add one. Introducing Temporal here without either
// would just replace working code with a ReferenceError. If Temporal (or
// its polyfill) gets added to this codebase's dependencies, this is the
// function to switch over.
function timeAgoLabel(timestampMs, { running } = {}) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestampMs) / 60000));

  if (running) {
    if (minutes < 1) return 'Running';
    if (minutes < 60) return `Running for ${minutes}m`;
    return `Running for ${Math.floor(minutes / 60)}h`;
  }
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

// Shared by markAllRead() and togglePanel()'s "opening the panel marks
// everything read" step — both used to inline the same map() separately.
function markAllReadInPlace() {
  let changed = false;
  OS.notifications = OS.notifications.map(n => {
    if (n && !n.read) {
      changed = true;
      return { ...n, read: true };
    }
    return n;
  });
  if (changed) OS.notifUnread = 0;
  return changed;
}

function markReadInPlace(notifId) {
  let changed = false;
  OS.notifications = OS.notifications.map(n => {
    if (n && n.id === notifId && !n.read) {
      changed = true;
      return { ...n, read: true };
    }
    return n;
  });
  if (changed) OS.notifUnread = Math.max(0, OS.notifUnread - 1);
  return changed;
}

function dismissNotification(notifId) {
  const before = OS.notifications.length;
  OS.notifications = OS.notifications.filter(n => !(n.id === notifId && !n.pinned));
  if (OS.notifications.length === before) return false;
  OS.notifUnread = OS.notifications.filter(n => !n.read).length;
  return true;
}

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
    const changed = markAllReadInPlace();
    OS.notifUnread = 0;
    if (changed) Notify.persist();
    Notify.updateBadge();
    updateNotificationBadge();
    Notify.renderPanel();
  },

  // Clears only notifications tagged with the given appId — used by the
  // nova:notifications:clear IPC handler so a sandboxed app can clear its
  // own notifications without touching other apps' or the system's.
  clearForApp(appId) {
    if (!appId) return;
    const before = OS.notifications.length;
    OS.notifications = OS.notifications.filter(n => n && n.appId !== appId);
    if (OS.notifications.length === before) return;
    OS.notifUnread = OS.notifications.filter(n => !n.read).length;
    Notify.persist();
    Notify.updateBadge();
    updateNotificationBadge();
    Notify.renderPanel();
  },

  // Clears every notification regardless of source, except pinned entries.
  // Not exposed over the app IPC bridge — only for first-party system UI
  // (e.g. a "Clear all" button the user presses directly in the
  // notification panel). Pinned entries survive this on purpose: "Clear
  // All" is a way to tidy up past events, not a way to make a still-running
  // background app disappear from view — the only path that removes a
  // pinned entry is unpin(), via Terminate or the app's own exit.
  clearAll() {
    OS.notifications = OS.notifications.filter(n => n && n.pinned);
    OS.notifUnread = OS.notifications.filter(n => !n.read).length;
    Notify.persist();
    Notify.updateBadge();
    updateNotificationBadge();
    Notify.renderPanel();
  },

  show(opts) {
    Notify.loadPersisted();
    const { title, body, type, appName, appId, category, icon, action, actionLabel, pinned, pinId } = opts;
    const id = generateId();
    const notif = {
      id,
      title: title || '',
      body: body || '',
      type: type || 'info',
      appName: appName || 'System',
      appId: appId || null,
      category: category || 'system',
      icon: safeIconKey(icon || 'bell'),
      timestamp: Date.now(),
      read: false,
      action: action || null,
      actionLabel: actionLabel || null,
      // Pinned entries are for things that are still true right now (an app
      // is currently running in the background), not a one-off event — see
      // pinBackgroundApp()/unpin() below. `pinId` is a stable key so a
      // caller can look the entry up later and clear it without touching
      // regular notifications; plain one-off notifications never set this.
      pinned: !!pinned,
      pinId: pinned ? (pinId || `pin_${id}`) : null,
    };

    OS.notifications.unshift(notif);
    if (OS.notifications.length > 100) {
      // Never let the 100-cap evict a pinned entry — it's reporting a
      // currently-true fact (a background app is alive), not a stale event,
      // so it doesn't age out just because unrelated notifications piled up.
      // Trim the oldest *unpinned* entry instead. Walk backward from the end
      // rather than cloning and reversing the whole array just to find one
      // index.
      let trimIndex = -1;
      for (let i = OS.notifications.length - 1; i >= 0; i--) {
        if (!OS.notifications[i].pinned) {
          trimIndex = i;
          break;
        }
      }
      if (trimIndex !== -1) OS.notifications.splice(trimIndex, 1);
    }
    OS.notifUnread++;
    Notify.updateBadge();
    updateNotificationBadge();
    Notify.renderPanel();
    Notify.persist();

    if (!OS.dnd) Notify.showToast(notif);

    if (notif.type === 'error' && typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'Notify', category: 'system', severity: 'error', message: `[${notif.appName}] ${notif.title}${notif.body ? ': ' + notif.body : ''}`, data: { appName: notif.appName, title: notif.title } });
    }

    return notif;
  },

  // ── Pinned background-app entries ──────────────────────────────────────
  // A pinned entry represents "this app is currently running in the
  // background," not a past event, so it behaves differently from a normal
  // notification in three ways: it sorts above everything else in the
  // panel, it survives clearAll()/the 100-item cap, and it can't be
  // dismissed by the user — only by the thing it describes actually ending
  // (see unpin(), called from the Terminate action or the app's own
  // natural exit). This mirrors how a foreground-service notification
  // behaves on Android, for the same reason: the cost is ongoing, so the
  // visibility should be too.

  /**
   * Create (or replace) the pinned "running in background" entry for an app.
   * @param {string} appId
   * @param {{ appName?: string, title?: string, body?: string, onTerminate?: () => void }} opts
   * @returns {object} the pinned notification object
   */
  pinBackgroundApp(appId, opts = {}) {
    Notify.loadPersisted();
    const pinId = `pin_bg_${appId}`;
    // Replace rather than duplicate if one already exists for this app.
    Notify.unpin(pinId, { silent: true });
    const notif = Notify.show({
      title: opts.title || `${opts.appName || appId} is running in the background`,
      body: opts.body || '',
      type: 'info',
      appName: opts.appName || appId,
      appId,
      category: 'background',
      icon: 'zap',
      pinned: true,
      pinId,
      action: () => {
        try { opts.onTerminate?.(); } finally { Notify.unpin(pinId); }
      },
      actionLabel: 'Terminate',
    });
    return notif;
  },

  /**
   * Remove a pinned entry by its pinId. This is the *only* way a pinned
   * entry goes away — normal dismiss/clear paths skip pinned rows entirely
   * (see clearAll() and renderPanel()'s missing close button on pinned
   * items). Call this once the thing it was reporting on has actually
   * ended (Terminate pressed, or the app exited on its own).
   */
  unpin(pinId, { silent = false } = {}) {
    if (!pinId) return;
    const before = OS.notifications.length;
    OS.notifications = OS.notifications.filter(n => !(n.pinned && n.pinId === pinId));
    if (OS.notifications.length === before) return;
    OS.notifUnread = OS.notifications.filter(n => !n.read).length;
    Notify.persist();
    if (!silent) {
      Notify.updateBadge();
      updateNotificationBadge();
      Notify.renderPanel();
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
    const ac = new AbortController();

    const content = createEl('div', { className: 'toast-content' });
    const titleEl = createEl('div', { className: 'toast-title', textContent: notif.title });
    const bodyEl = createEl('div', { className: 'toast-body', textContent: notif.body });
    content.appendChild(titleEl);
    if (notif.body) content.appendChild(bodyEl);

    if (notif.action && notif.actionLabel) {
      const actionBtn = createEl('button', { className: 'toast-action' });
      actionBtn.textContent = notif.actionLabel;
      actionBtn.style.cssText = `margin-left:auto;${ACTION_BUTTON_STYLE}`;
      wireActionButtonHover(actionBtn);
      actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearTimeout(timer);
        removeToast();
        Notify.runAction(notif);
      }, { signal: ac.signal });
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

    toast.addEventListener('pointerenter', () => clearTimeout(timer), { signal: ac.signal });
    toast.addEventListener('pointerleave', () => { timer = setTimeout(() => removeToast(), hoverGraceDelay); }, { signal: ac.signal });

    closeBtn.addEventListener('click', () => { clearTimeout(timer); removeToast(); }, { signal: ac.signal });

    function removeToast() {
      clearTimeout(timer);
      ac.abort();
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 300);
    }
  },

  updateBadge() {
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    if (OS.notifUnread > 0) {
      badge.textContent = OS.notifUnread > 99 ? '99+' : String(OS.notifUnread);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  },

  renderPanel() {
    Notify.loadPersisted();
    const list = document.getElementById('notif-list');
    if (!list) return;
    if (OS.notifications.length === 0) {
      const empty = createEl('div', { className: 'empty-state' });
      empty.appendChild(createEl('div', { className: 'text-muted', textContent: 'No notifications' }));
      list.replaceChildren(empty);
      return;
    }
    // Building nodes in a fragment and appending once avoids a reflow per
    // notification row. Pinned entries (currently-running background apps)
    // sort above everything else regardless of timestamp — they're
    // reporting an ongoing state, not a past event, so "most recent first"
    // doesn't apply to them the way it does to the rest of the list.
    const sorted = [...OS.notifications].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    const frag = document.createDocumentFragment();
    for (const n of sorted.slice(0, 50)) {
      const item = createEl('div', {
        className: `notif-item${n.read ? ' read' : ''}${n.pinned ? ' notif-item-pinned' : ''}`,
        role: 'listitem',
      });
      const icon = createEl('div', { style: { width: '24px', height: '24px', color: n.pinned ? '#58a6ff' : 'var(--text-secondary)', flexShrink: '0' } });
      icon.innerHTML = svgIcon(n.pinned ? safeIconKey(n.icon || 'zap') : 'bell', 16);
      const content = createEl('div', { className: 'notif-item-content' });
      content.appendChild(createEl('div', { className: 'notif-item-title', textContent: n.title }));
      content.appendChild(createEl('div', { className: 'notif-item-body', textContent: n.body }));
      content.appendChild(createEl('div', { className: 'notif-item-time', textContent: timeAgoLabel(n.timestamp, { running: n.pinned }) }));
      item.appendChild(icon);
      item.appendChild(content);

      if (n.action && n.actionLabel) {
        const actionBtn = createEl('button', { className: 'notif-item-action' });
        actionBtn.textContent = n.actionLabel;
        actionBtn.style.cssText = `margin-left:auto;flex-shrink:0;${ACTION_BUTTON_STYLE}`;
        wireActionButtonHover(actionBtn);
        actionBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          Notify.runAction(n);
        });
        item.appendChild(actionBtn);
      }

      if (!n.read) {
        const markReadBtn = createEl('button', { className: 'notif-item-action', textContent: 'Mark read' });
        markReadBtn.style.cssText = `margin-left:auto;flex-shrink:0;${ACTION_BUTTON_STYLE}`;
        wireActionButtonHover(markReadBtn);
        markReadBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const changed = markReadInPlace(n.id);
          if (changed) {
            Notify.persist();
            Notify.updateBadge();
            updateNotificationBadge();
            Notify.renderPanel();
          }
        });
        item.appendChild(markReadBtn);
      }

      if (!n.pinned) {
        const dismissBtn = createEl('button', { className: 'notif-item-dismiss', 'aria-label': 'Dismiss notification' });
        dismissBtn.innerHTML = svgIcon('x', 14);
        dismissBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const changed = dismissNotification(n.id);
          if (changed) {
            Notify.persist();
            Notify.updateBadge();
            updateNotificationBadge();
            Notify.renderPanel();
          }
        });
        item.appendChild(dismissBtn);
      }

      frag.appendChild(item);
    }
    list.replaceChildren(frag);
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
        const changed = markAllReadInPlace();
        if (changed) Notify.persist();
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
  // first light, opaque-enough pixel it finds — a fully or mostly
  // transparent background color isn't actually rendering as light on
  // screen, so it shouldn't count as one just because its r/g/b channels
  // happen to be bright.
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
          // Match decimals too, not just digits — rgba()'s alpha channel is
          // often fractional (e.g. "0.5"), and a digits-only match would
          // split that into "0" and "5" and throw off which value is which.
          const m = bg.match(/[\d.]+/g);
          if (!m || m.length < 3) continue;
          const [r, g, b] = m;
          const alpha = m.length >= 4 ? Number(m[3]) : 1;
          if (alpha < 0.5) continue;
          const luminance = 0.299 * Number(r) + 0.587 * Number(g) + 0.114 * Number(b);
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