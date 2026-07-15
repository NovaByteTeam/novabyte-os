const ContextMenu = {
  current: null,
  _activeDismiss: null, // Track the current event handler for absolute safety

  show(x, y, items) {
    ContextMenu.hide();
    
    const menu = createEl('div', { className: 'context-menu', role: 'menu' });
    const fragment = document.createDocumentFragment();
    const len = items.length;

    // Use a high-performance indexed loop instead of for...of
    for (let i = 0; i < len; i++) {
      const item = items[i];
      
      if (item.separator) {
        fragment.appendChild(createEl('div', { className: 'ctx-separator' }));
        continue;
      }
      
      const btn = createEl('button', {
        className: 'ctx-item' + (item.danger ? ' danger' : ''),
        role: 'menuitem',
        'aria-label': item.label
      });
      
      // Store reference to the specific action directly on the DOM element for event delegation
      if (item.action) btn._action = item.action;

      if (item.icon) {
        const iconEl = createEl('span');
        iconEl.innerHTML = svgIcon(item.icon, 14);
        btn.appendChild(iconEl);
      }
      
      btn.appendChild(createEl('span', { textContent: item.label }));
      
      if (item.shortcut) {
        btn.appendChild(createEl('span', { className: 'ctx-shortcut', textContent: item.shortcut }));
      }
      
      fragment.appendChild(btn);
    }

    menu.appendChild(fragment);
    menu.style.visibility = 'hidden';
    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    const winW = window.innerWidth;
    const winH = window.innerHeight;

    if (x + rect.width > winW) x = winW - rect.width - 8;
    if (y + rect.height > winH) y = winH - rect.height - 8;
    
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // Sample background behind the menu to decide text color
    try {
      const samplePoints = [];
      const step = 20;
      for (let sx = x + 5; sx < x + rect.width - 5; sx += step) {
        for (let sy = y + 5; sy < y + rect.height - 5; sy += step) {
          samplePoints.push({ x: sx, y: sy });
        }
      }
      if (samplePoints.length > 0) {
        let lightSample = false;
        let validSamples = 0;
        for (const pt of samplePoints) {
          const el = document.elementFromPoint(pt.x, pt.y);
          if (!el) continue;
          if (el.tagName === 'WEBVIEW' || el.closest('webview')) {
            lightSample = true;
            break;
          }
          const bg = getComputedStyle(el).backgroundColor;
          const m = bg.match(/\d+/g);
          if (!m || m.length < 3) continue;
          validSamples++;
          const r = parseInt(m[0], 10);
          const g = parseInt(m[1], 10);
          const b = parseInt(m[2], 10);
          const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
          if (luminance > 160) {
            lightSample = true;
            break;
          }
        }
        if (lightSample || validSamples === 0) {
          menu.classList.add('light-bg');
        }
      } else {
        menu.classList.add('light-bg');
      }
    } catch (e) {
      // If sampling fails, keep default dark text
    }

    menu.style.visibility = '';
    ContextMenu.current = menu;

    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('.ctx-item');
      if (btn) {
        ContextMenu.hide();
        if (btn._action) btn._action();
      }
    });

    // Optimized dismiss handler using capture phase to avoid setTimeout lag
    const dismiss = (e) => {
      if (!menu.contains(e.target)) {
        ContextMenu.hide();
      }
    };
    
    ContextMenu._activeDismiss = dismiss;
    document.addEventListener('pointerdown', dismiss, { capture: true, passive: true });
  },

  hide() {
    if (ContextMenu.current) {
      ContextMenu.current.remove();
      ContextMenu.current = null;
    }
    if (ContextMenu._activeDismiss) {
      document.removeEventListener('pointerdown', ContextMenu._activeDismiss, { capture: true });
      ContextMenu._activeDismiss = null;
    }
  }
};

window.ContextMenu = ContextMenu;