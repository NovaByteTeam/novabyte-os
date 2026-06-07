registerApp({
        id: 'nbosp-contacts', name: 'Contacts', icon: 'users',
        description: 'Contact Book',
        defaultSize: [640, 500], minSize: [440, 320],
        init(content, state) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.contacts', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.contacts</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const SK = 'nova_contacts';

          function load() { try { return JSON.parse(localStorage.getItem(SK) || '[]'); } catch { return []; } }
          function save(arr) { lsSave(SK, arr); }
          function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
          function initials(name) {
            const parts = (name || '?').trim().split(/\s+/);
            return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
          }

          let contacts = load();
          let selected = null;
          let editMode = false;
          let searchQ = '';

          /* ── Root layout ── */
          const root = createEl('div', { style: 'display:flex;height:100%;overflow:hidden;' });
          content.appendChild(root);

          /* ── Left: list panel ── */
          const leftPanel = createEl('div', { style: 'width:220px;flex-shrink:0;display:flex;flex-direction:column;border-right:1px solid var(--border-subtle);background:var(--bg-sidebar);' });

          const listToolbar = createEl('div', { style: 'padding:8px;border-bottom:1px solid var(--border-subtle);display:flex;flex-direction:column;gap:6px;flex-shrink:0;' });
          const searchInp = createEl('input', { type: 'text', placeholder: 'Search contacts…', style: 'width:100%;background:var(--bg-sunken);border:1px solid var(--border-subtle);border-radius:6px;padding:5px 8px;font-size:12px;color:var(--text-primary);outline:none;' });
          const addBtn = createEl('button', { className: 'btn btn-sm btn-primary', style: 'display:flex;align-items:center;gap:4px;justify-content:center;' });
          addBtn.innerHTML = svgIcon('plus', 12) + ' New Contact';
          listToolbar.append(searchInp, addBtn);

          const contactList = createEl('div', { style: 'flex:1;overflow-y:auto;' });
          leftPanel.append(listToolbar, contactList);

          /* ── Right: detail / edit panel ── */
          const rightPanel = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;' });

          const detailArea = createEl('div', { style: 'flex:1;overflow-y:auto;padding:20px;' });
          const actionBar = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);' });
          rightPanel.append(detailArea, actionBar);

          root.append(leftPanel, rightPanel);

          /* ── Render contact list ── */
          function renderList() {
            contactList.innerHTML = '';
            const q = searchQ.toLowerCase();
            const filtered = contacts.filter(c =>
              !q || (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q)
            ).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

            if (!filtered.length) {
              const empty = createEl('div', { style: 'padding:20px;text-align:center;color:var(--text-muted);font-size:12px;' });
              empty.textContent = searchQ ? 'No matches' : 'No contacts yet';
              contactList.appendChild(empty);
              return;
            }

            filtered.forEach(c => {
              const row = createEl('div', { style: 'display:flex;align-items:center;gap:9px;padding:8px 10px;cursor:pointer;border-radius:0;transition:background 0.1s;border-bottom:1px solid var(--border-subtle);' + (selected?.id === c.id ? 'background:var(--accent-muted);' : ''), 'data-id': c.id });
              row.addEventListener('mouseenter', () => { if (selected?.id !== c.id) row.style.background = 'var(--bg-hover)'; });
              row.addEventListener('mouseleave', () => { if (selected?.id !== c.id) row.style.background = ''; });
              row.addEventListener('click', () => selectContact(c.id));

              const avatar = createEl('div', { style: 'width:32px;height:32px;border-radius:50%;background:var(--accent-muted);color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;' });
              avatar.textContent = initials(c.name);

              const info = createEl('div', { style: 'min-width:0;' });
              const nameEl = createEl('div', { textContent: c.name || '(no name)', style: 'font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' });
              const subEl = createEl('div', { textContent: c.email || c.phone || '', style: 'font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' });
              info.append(nameEl, subEl);
              row.append(avatar, info);
              contactList.appendChild(row);
            });
          }

          /* ── Render detail / edit ── */
          function renderDetail() {
            detailArea.innerHTML = '';
            actionBar.innerHTML = '';

            if (!selected) {
              const empty = createEl('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-muted);gap:8px;' });
              empty.innerHTML = svgIcon('users', 36) + '<div style="font-size:13px;margin-top:10px;">Select a contact</div>';
              detailArea.appendChild(empty);
              return;
            }

            if (editMode) {
              /* ── Edit form ── */
              const form = createEl('div', { style: 'display:flex;flex-direction:column;gap:12px;max-width:360px;' });

              function field(label, key, type) {
                const wrap = createEl('div', { style: 'display:flex;flex-direction:column;gap:4px;' });
                const lbl = createEl('label', { textContent: label, style: 'font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.05em;text-transform:uppercase;' });
                const inp = createEl('input', { type: type || 'text', value: selected[key] || '', style: 'background:var(--bg-sunken);border:1px solid var(--border-default);border-radius:6px;padding:7px 10px;font-size:13px;color:var(--text-primary);outline:none;width:100%;', 'data-key': key });
                inp.addEventListener('focus', () => inp.style.borderColor = 'var(--accent)');
                inp.addEventListener('blur', () => inp.style.borderColor = 'var(--border-default)');
                wrap.append(lbl, inp);
                form.appendChild(wrap);
                return inp;
              }

              const nameInp = field('Name', 'name');
              const emailInp = field('Email', 'email', 'email');
              const phoneInp = field('Phone', 'phone', 'tel');
              const wrap = createEl('div', { style: 'display:flex;flex-direction:column;gap:4px;' });
              wrap.appendChild(createEl('label', { textContent: 'Notes', style: 'font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.05em;text-transform:uppercase;' }));
              const notesInp = createEl('textarea', { id: 'contact-notes-input', name: 'contact-notes', style: 'background:var(--bg-sunken);border:1px solid var(--border-default);border-radius:6px;padding:7px 10px;font-size:13px;color:var(--text-primary);outline:none;width:100%;min-height:80px;resize:vertical;', 'data-key': 'notes' });
              notesInp.value = selected.notes || '';
              notesInp.addEventListener('focus', () => notesInp.style.borderColor = 'var(--accent)');
              notesInp.addEventListener('blur', () => notesInp.style.borderColor = 'var(--border-default)');
              wrap.appendChild(notesInp);
              form.appendChild(wrap);

              detailArea.appendChild(form);

              const saveBtn = createEl('button', { className: 'btn btn-primary btn-sm', textContent: 'Save' });
              const cancelBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Cancel' });
              actionBar.append(saveBtn, cancelBtn);

              saveBtn.addEventListener('click', () => {
                selected.name = nameInp.value.trim() || '(no name)';
                selected.email = emailInp.value.trim();
                selected.phone = phoneInp.value.trim();
                selected.notes = notesInp.value.trim();
                save(contacts);
                editMode = false;
                renderList();
                renderDetail();
              });
              cancelBtn.addEventListener('click', () => {
                if (!selected.name) { contacts = contacts.filter(c => c.id !== selected.id); selected = null; }
                editMode = false;
                renderList();
                renderDetail();
              });

            } else {
              /* ── View mode ── */
              const avatar = createEl('div', { style: 'width:56px;height:56px;border-radius:50%;background:var(--accent-muted);color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;margin-bottom:14px;flex-shrink:0;' });
              avatar.textContent = initials(selected.name);

              const nameEl = createEl('div', { textContent: selected.name || '(no name)', style: 'font-size:17px;font-weight:700;margin-bottom:16px;' });
              detailArea.append(avatar, nameEl);

              function infoRow(icon, label, value, clickFn) {
                if (!value) return;
                const row = createEl('div', { style: 'display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-subtle);cursor:' + (clickFn ? 'pointer' : 'default') + ';' });
                row.addEventListener('mouseenter', () => { if (clickFn) row.style.background = 'var(--bg-hover)'; });
                row.addEventListener('mouseleave', () => row.style.background = '');
                if (clickFn) row.addEventListener('click', clickFn);
                const ico = createEl('span', { style: 'color:var(--text-muted);flex-shrink:0;margin-top:1px;' });
                ico.innerHTML = svgIcon(icon, 15);
                const wrap2 = createEl('div', { style: 'min-width:0;' });
                const lbl = createEl('div', { textContent: label, style: 'font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;' });
                const val = createEl('div', { textContent: value, style: 'font-size:13px;color:' + (clickFn ? 'var(--text-link)' : 'var(--text-primary)') + ';word-break:break-all;' });
                wrap2.append(lbl, val);
                row.append(ico, wrap2);
                detailArea.appendChild(row);
              }

              infoRow('mail', 'Email', selected.email, selected.email ? () => WM.createWindow('email', { to: selected.email }) : null);
              infoRow('phone', 'Phone', selected.phone);
              infoRow('file', 'Notes', selected.notes);

              const editBtn = createEl('button', { className: 'btn btn-sm btn-primary', textContent: 'Edit' });
              const delBtn = createEl('button', { className: 'btn btn-sm btn-danger', textContent: 'Delete' });
              actionBar.append(editBtn, delBtn, createEl('span', { style: 'flex:1;' }));

              editBtn.addEventListener('click', () => { editMode = true; renderDetail(); });
              delBtn.addEventListener('click', () => {
                contacts = contacts.filter(c => c.id !== selected.id);
                save(contacts);
                selected = null;
                renderList();
                renderDetail();
              });
            }
          }

          function selectContact(id) {
            selected = contacts.find(c => c.id === id) || null;
            editMode = false;
            renderList();
            renderDetail();
          }

          addBtn.addEventListener('click', () => {
            const c = { id: genId(), name: '', email: '', phone: '', notes: '' };
            contacts.push(c);
            selected = c;
            editMode = true;
            renderList();
            renderDetail();
          });

          searchInp.addEventListener('input', () => { searchQ = searchInp.value; renderList(); });

          renderList();
          renderDetail();
        }
      });




