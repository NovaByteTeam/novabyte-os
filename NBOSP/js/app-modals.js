
function showModal(title, body, actions, inputType) {
        return new Promise((resolve) => {
          const overlay = createEl('div', { className: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' });
          const dialog = createEl('div', { className: 'modal-dialog' });

          if (title) dialog.appendChild(createEl('div', { className: 'modal-title', textContent: title }));
          if (typeof body === 'string') {
            dialog.appendChild(createEl('div', { className: 'modal-body', textContent: body }));
          } else if (body instanceof HTMLElement) {
            const bodyDiv = createEl('div', { className: 'modal-body' });
            bodyDiv.appendChild(body);
            dialog.appendChild(bodyDiv);
          }

          // FIX 4 — optional input field when inputType is provided
          let _modalInput = null;
          if (inputType) {
            const inputWrap = createEl('div', { className: 'modal-body', style: { paddingTop: '0' } });
            _modalInput = createEl('input', {
              id: 'modal-input-field',
              name: 'modal-input',
              className: 'input',
              type: inputType,
              style: { width: '100%', marginTop: '4px' },
              'aria-label': title || 'Input'
            });
            inputWrap.appendChild(_modalInput);
            dialog.appendChild(inputWrap);
          }

          const actionsDiv = createEl('div', { className: 'modal-actions' });
          for (const act of (actions || [{ label: 'OK', primary: true, value: true }])) {
            const btn = createEl('button', {
              className: 'btn' + (act.primary ? ' btn-primary' : '') + (act.danger ? ' btn-danger' : ''),
              textContent: act.label
            });
            btn.addEventListener('click', () => {
              overlay.remove();
              // If we have an input field: buttons with an explicit value resolve the input's value;
              // buttons without a value (Cancel/dismiss) resolve null.
              if (_modalInput) {
                resolve(act.value !== undefined ? _modalInput.value : null);
              } else {
                resolve(act.value !== undefined ? act.value : act.label);
              }
            });
            actionsDiv.appendChild(btn);
          }
          dialog.appendChild(actionsDiv);
          overlay.appendChild(dialog);

          overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { overlay.remove(); resolve(null); }
          });

          if (_modalInput) {
            _modalInput.addEventListener('keydown', e => {
              if (e.key === 'Enter') { overlay.remove(); resolve(_modalInput.value); }
              if (e.key === 'Escape') { overlay.remove(); resolve(null); }
            });
          }

          document.body.appendChild(overlay);
          if (_modalInput) _modalInput.focus(); else dialog.querySelector('button')?.focus();
        });
      }

      function showPrompt(title, defaultValue) {
        return new Promise((resolve) => {
          const overlay = createEl('div', { className: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' });
          const dialog = createEl('div', { className: 'modal-dialog' });
          dialog.appendChild(createEl('div', { className: 'modal-title', textContent: title }));

          const input = createEl('input', { className: 'input', id: 'modal-input-field', name: 'modal-input', value: defaultValue || '', 'aria-label': title });
          const bodyDiv = createEl('div', { className: 'modal-body' });
          bodyDiv.appendChild(input);
          dialog.appendChild(bodyDiv);

          const actionsDiv = createEl('div', { className: 'modal-actions' });
          const cancelBtn = createEl('button', { className: 'btn', textContent: 'Cancel' });
          const okBtn = createEl('button', { className: 'btn btn-primary', textContent: 'OK' });

          cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(null); });
          okBtn.addEventListener('click', () => { overlay.remove(); resolve(input.value); });
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { overlay.remove(); resolve(input.value); } });

          actionsDiv.appendChild(cancelBtn);
          actionsDiv.appendChild(okBtn);
          dialog.appendChild(actionsDiv);
          overlay.appendChild(dialog);
          overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
          document.body.appendChild(overlay);
          input.focus();
          input.select();
        });
      }


