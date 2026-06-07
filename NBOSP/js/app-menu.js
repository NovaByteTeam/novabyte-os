
const ContextMenu = {
        current: null,

        show(x, y, items) {
          ContextMenu.hide();
          const menu = createEl('div', { className: 'context-menu', role: 'menu' });

          for (const item of items) {
            if (item.separator) {
              menu.appendChild(createEl('div', { className: 'ctx-separator' }));
              continue;
            }
            const btn = createEl('button', {
              className: 'ctx-item' + (item.danger ? ' danger' : ''),
              role: 'menuitem',
              'aria-label': item.label
            });
            if (item.icon) {
              const iconEl = createEl('span');
              iconEl.innerHTML = svgIcon(item.icon, 14);
              btn.appendChild(iconEl);
            }
            btn.appendChild(createEl('span', { textContent: item.label }));
            if (item.shortcut) {
              btn.appendChild(createEl('span', { className: 'ctx-shortcut', textContent: item.shortcut }));
            }
            btn.addEventListener('click', () => {
              ContextMenu.hide();
              if (item.action) item.action();
            });
            menu.appendChild(btn);
          }

          // Position
          document.body.appendChild(menu);
          const rect = menu.getBoundingClientRect();
          if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
          if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
          menu.style.left = x + 'px';
          menu.style.top = y + 'px';

          ContextMenu.current = menu;

          const dismiss = (e) => {
            if (!menu.contains(e.target)) {
              ContextMenu.hide();
              document.removeEventListener('pointerdown', dismiss);
            }
          };
          setTimeout(() => document.addEventListener('pointerdown', dismiss), 10);
        },

        hide() {
          if (ContextMenu.current) {
            ContextMenu.current.remove();
            ContextMenu.current = null;
          }
        }
      };


window.ContextMenu = ContextMenu;



/* Exposed to Global Scope for Flat-Module Architecture */
