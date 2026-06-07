registerApp({
        id: 'calendar-app', name: 'Calendar', icon: 'calendar',
        description: 'Calendar & Scheduling',
        defaultSize: [860, 580], minSize: [600, 440],
        init(content, state) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.calendar', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.calendar</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const STORE_KEY = 'calendar_events_v2';
          const COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff', '#ff7b72', '#79c0ff', '#56d364'];
          const COLOR_NAMES = ['Blue', 'Green', 'Yellow', 'Red', 'Purple', 'Salmon', 'Sky', 'Lime'];

          function loadEvents() {
            try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; }
          }
          function saveEvents(evs) { lsSave(STORE_KEY, evs); }

          let events = loadEvents();
          let view = 'month';
          let viewDate = new Date();

          // ── Root layout ────────────────────────────────────────────────
          const root = createEl('div', { style: 'display:flex;height:100%;overflow:hidden;font-size:13px;' });
          content.appendChild(root);

          // ── Sidebar ────────────────────────────────────────────────────
          const sidebar = createEl('div', { style: 'width:200px;flex-shrink:0;border-right:1px solid var(--border-subtle);display:flex;flex-direction:column;background:var(--bg-sunken);' });

          // Mini-calendar nav
          const miniNav = createEl('div', { style: 'padding:10px 12px 4px;' });
          const miniHdr = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;' });
          const miniTitle = createEl('span', { style: 'font-size:12px;font-weight:600;' });
          const miniPrev = createEl('button', { className: 'btn btn-icon btn-sm', style: 'padding:2px;' });
          miniPrev.innerHTML = svgIcon('chevron-left', 12);
          const miniNext = createEl('button', { className: 'btn btn-icon btn-sm', style: 'padding:2px;' });
          miniNext.innerHTML = svgIcon('chevron-right', 12);
          miniHdr.append(miniPrev, miniTitle, miniNext);

          const miniGrid = createEl('div', { style: 'display:grid;grid-template-columns:repeat(7,1fr);gap:1px;font-size:10px;text-align:center;' });
          ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(d => {
            miniGrid.appendChild(createEl('div', { textContent: d, style: 'color:var(--text-muted);padding:2px 0;font-weight:600;' }));
          });
          miniNav.append(miniHdr, miniGrid);

          // Upcoming events
          const upcomingWrap = createEl('div', { style: 'flex:1;overflow-y:auto;padding:8px 10px;border-top:1px solid var(--border-subtle);' });
          const upcomingTitle = createEl('div', { style: 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:6px;' });
          upcomingTitle.textContent = 'Upcoming';
          upcomingWrap.appendChild(upcomingTitle);
          const upcomingList = createEl('div');
          upcomingWrap.appendChild(upcomingList);

          // New event button
          const newEvtBtn = createEl('button', { className: 'btn btn-primary', style: 'margin:10px;width:calc(100% - 20px);font-size:12px;' });
          newEvtBtn.innerHTML = svgIcon('plus', 12) + ' New Event';

          sidebar.append(miniNav, upcomingWrap, newEvtBtn);

          // ── Main panel ─────────────────────────────────────────────────
          const main = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;' });

          const toolbar = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;' });
          const prevBtn = createEl('button', { className: 'btn btn-icon btn-sm' }); prevBtn.innerHTML = svgIcon('chevron-left', 16);
          const nextBtn = createEl('button', { className: 'btn btn-icon btn-sm' }); nextBtn.innerHTML = svgIcon('chevron-right', 16);
          const todayBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Today' });
          const mainTitle = createEl('h3', { style: 'margin:0;font-size:15px;font-weight:700;flex:1;' });

          const viewBtns = createEl('div', { style: 'display:flex;background:var(--bg-sunken);border-radius:8px;padding:3px;gap:2px;' });
          ['month', 'week', 'day', 'agenda'].forEach(v => {
            const b = createEl('button', {
              textContent: v.charAt(0).toUpperCase() + v.slice(1),
              style: 'padding:4px 10px;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:500;transition:all 0.15s;'
            });
            b.dataset.view = v;
            b.addEventListener('click', () => { view = v; renderMain(); updateViewBtns(); });
            viewBtns.appendChild(b);
          });

          toolbar.append(prevBtn, nextBtn, todayBtn, mainTitle, viewBtns);

          const contentArea = createEl('div', { style: 'flex:1;overflow:auto;' });
          main.append(toolbar, contentArea);
          root.append(sidebar, main);

          // ── Mini-calendar render ────────────────────────────────────────
          function renderMini() {
            const y = viewDate.getFullYear(), m = viewDate.getMonth();
            miniTitle.textContent = viewDate.toLocaleDateString([], { month: 'short', year: 'numeric' });
            miniGrid.querySelectorAll('.mini-day').forEach(e => e.remove());
            const firstDay = new Date(y, m, 1).getDay();
            const daysIn = new Date(y, m + 1, 0).getDate();
            const today = new Date();
            for (let i = 0; i < firstDay; i++) {
              miniGrid.appendChild(createEl('div', { className: 'mini-day', style: 'padding:2px;' }));
            }
            for (let d = 1; d <= daysIn; d++) {
              const isToday = today.getDate() === d && today.getMonth() === m && today.getFullYear() === y;
              const dot = events.some(ev => ev.date === `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
              const cell = createEl('div', {
                className: 'mini-day',
                textContent: String(d),
                style: `padding:2px;border-radius:4px;cursor:pointer;${isToday ? 'background:var(--accent);color:#fff;font-weight:700;' : ''}`
              });
              if (dot && !isToday) cell.style.textDecoration = 'underline';
              cell.addEventListener('click', () => {
                viewDate = new Date(y, m, d);
                view = 'day'; updateViewBtns(); renderAll();
              });
              miniGrid.appendChild(cell);
            }
          }

          // ── Upcoming ───────────────────────────────────────────────────
          function renderUpcoming() {
            upcomingList.innerHTML = '';
            const today = new Date().toISOString().split('T')[0];
            const upcoming = events
              .filter(ev => ev.date >= today)
              .sort((a, b) => a.date.localeCompare(b.date) || (a.timeStart || '').localeCompare(b.timeStart || ''))
              .slice(0, 8);
            if (!upcoming.length) {
              upcomingList.appendChild(createEl('div', { textContent: 'No upcoming events', style: 'font-size:11px;color:var(--text-muted);padding:4px 0;' }));
              return;
            }
            upcoming.forEach(ev => {
              const item = createEl('div', { style: 'padding:5px 0;border-bottom:1px solid var(--border-subtle);cursor:pointer;' });
              const bar = createEl('div', { style: `width:3px;height:28px;background:${ev.color || 'var(--accent)'};border-radius:2px;float:left;margin-right:8px;` });
              const info = createEl('div', { style: 'overflow:hidden;' });
              info.appendChild(createEl('div', { textContent: ev.title, style: 'font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }));
              info.appendChild(createEl('div', { textContent: ev.date + (ev.timeStart ? ' · ' + ev.timeStart : ''), style: 'font-size:10px;color:var(--text-muted);' }));
              item.append(bar, info);
              item.addEventListener('click', () => openEventModal(new Date(ev.date), ev));
              upcomingList.appendChild(item);
            });
          }

          // ── Main views ─────────────────────────────────────────────────
          function updateViewBtns() {
            viewBtns.querySelectorAll('button').forEach(b => {
              const active = b.dataset.view === view;
              b.style.background = active ? 'var(--accent)' : 'transparent';
              b.style.color = active ? '#fff' : 'var(--text-primary)';
            });
          }

          function renderMain() {
            contentArea.innerHTML = '';
            const y = viewDate.getFullYear(), m = viewDate.getMonth(), d = viewDate.getDate();

            if (view === 'month') {
              mainTitle.textContent = viewDate.toLocaleDateString([], { month: 'long', year: 'numeric' });
              const grid = createEl('div', { style: 'display:grid;grid-template-columns:repeat(7,1fr);height:100%;' });
              ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(day => {
                grid.appendChild(createEl('div', { textContent: day, style: 'text-align:center;padding:6px 0;font-size:11px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border-subtle);' }));
              });
              const firstDay = new Date(y, m, 1).getDay();
              const daysIn = new Date(y, m + 1, 0).getDate();
              const today = new Date();
              for (let i = 0; i < firstDay; i++) {
                grid.appendChild(createEl('div', { style: 'border:1px solid var(--border-subtle);min-height:80px;background:var(--bg-sunken);opacity:0.5;' }));
              }
              for (let day = 1; day <= daysIn; day++) {
                const isToday = today.getDate() === day && today.getMonth() === m && today.getFullYear() === y;
                const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const cell = createEl('div', { style: `border:1px solid var(--border-subtle);min-height:80px;padding:4px;cursor:pointer;transition:background 0.1s;position:relative;${isToday ? 'background:var(--accent-muted);' : ''}` });
                const num = createEl('div', { textContent: String(day), style: `font-size:12px;font-weight:${isToday ? '700' : '400'};color:${isToday ? 'var(--accent)' : 'var(--text-primary)'};margin-bottom:3px;` });
                cell.appendChild(num);
                events.filter(ev => ev.date === dateStr).slice(0, 3).forEach(ev => {
                  const evEl = createEl('div', { textContent: (ev.timeStart ? ev.timeStart + ' ' : '') + ev.title, style: `font-size:10px;background:${ev.color || 'var(--accent)'};color:#fff;border-radius:3px;padding:1px 4px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;` });
                  evEl.addEventListener('click', e => { e.stopPropagation(); openEventModal(new Date(dateStr), ev); });
                  cell.appendChild(evEl);
                });
                cell.addEventListener('click', () => openEventModal(new Date(dateStr), null));
                cell.addEventListener('mouseenter', () => { if (!isToday) cell.style.background = 'var(--bg-elevated)'; });
                cell.addEventListener('mouseleave', () => { cell.style.background = isToday ? 'var(--accent-muted)' : ''; });
                grid.appendChild(cell);
              }
              contentArea.appendChild(grid);

            } else if (view === 'week') {
              const startOfWeek = new Date(viewDate);
              startOfWeek.setDate(d - viewDate.getDay());
              const days = [...Array(7)].map((_, i) => { const dt = new Date(startOfWeek); dt.setDate(startOfWeek.getDate() + i); return dt; });
              mainTitle.textContent = days[0].toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' – ' + days[6].toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
              const today = new Date();
              const grid = createEl('div', { style: 'display:grid;grid-template-columns:40px repeat(7,1fr);height:100%;overflow-y:auto;' });
              grid.appendChild(createEl('div', { style: 'border-bottom:1px solid var(--border-subtle);' }));
              days.forEach(dt => {
                const isToday = dt.toDateString() === today.toDateString();
                const hdr = createEl('div', { style: `text-align:center;padding:6px 4px;border-bottom:1px solid var(--border-subtle);border-left:1px solid var(--border-subtle);font-size:11px;font-weight:${isToday ? '700' : '400'};color:${isToday ? 'var(--accent)' : 'var(--text-primary)'};` });
                hdr.textContent = dt.toLocaleDateString([], { weekday: 'short', day: 'numeric' });
                grid.appendChild(hdr);
              });
              for (let hr = 0; hr < 24; hr++) {
                const label = createEl('div', { textContent: hr === 0 ? '12a' : hr < 12 ? hr + 'a' : hr === 12 ? '12p' : (hr - 12) + 'p', style: 'font-size:10px;color:var(--text-muted);padding:2px 4px;text-align:right;border-top:1px solid var(--border-subtle);' });
                grid.appendChild(label);
                days.forEach(dt => {
                  const dateStr = dt.toISOString().split('T')[0];
                  const cell = createEl('div', { style: 'border-top:1px solid var(--border-subtle);border-left:1px solid var(--border-subtle);min-height:36px;padding:1px;position:relative;' });
                  events.filter(ev => ev.date === dateStr && parseInt(ev.timeStart || '99') === hr).forEach(ev => {
                    const evEl = createEl('div', { textContent: ev.title, style: `font-size:10px;background:${ev.color || 'var(--accent)'};color:#fff;border-radius:3px;padding:2px 4px;cursor:pointer;` });
                    evEl.addEventListener('click', () => openEventModal(dt, ev));
                    cell.appendChild(evEl);
                  });
                  grid.appendChild(cell);
                });
              }
              contentArea.appendChild(grid);

            } else if (view === 'day') {
              mainTitle.textContent = viewDate.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
              const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
              const dayEvs = events.filter(ev => ev.date === dateStr).sort((a, b) => (a.timeStart || '').localeCompare(b.timeStart || ''));
              const wrap = createEl('div', { style: 'padding:16px;max-width:600px;' });
              if (!dayEvs.length) {
                const empty = createEl('div', { textContent: 'No events — click to add one.', style: 'color:var(--text-muted);font-size:13px;margin-top:24px;' });
                wrap.appendChild(empty);
              }
              dayEvs.forEach(ev => {
                const row = createEl('div', { style: `display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border-subtle);cursor:pointer;` });
                const bar = createEl('div', { style: `width:4px;border-radius:2px;background:${ev.color || 'var(--accent)'};flex-shrink:0;` });
                const info = createEl('div', { style: 'flex:1;' });
                info.appendChild(createEl('div', { textContent: ev.title, style: 'font-weight:600;font-size:14px;' }));
                if (ev.timeStart) { info.appendChild(createEl('div', { textContent: ev.timeStart + (ev.timeEnd ? ' – ' + ev.timeEnd : ''), style: 'font-size:12px;color:var(--text-muted);' })); }
                if (ev.desc) { info.appendChild(createEl('div', { textContent: ev.desc, style: 'font-size:12px;color:var(--text-secondary);margin-top:4px;' })); }
                row.append(bar, info);
                row.addEventListener('click', () => openEventModal(viewDate, ev));
                wrap.appendChild(row);
              });
              wrap.addEventListener('click', e => { if (e.target === wrap) openEventModal(viewDate, null); });
              contentArea.appendChild(wrap);

            } else if (view === 'agenda') {
              mainTitle.textContent = 'Agenda';
              const today = new Date().toISOString().split('T')[0];
              const sorted = events.filter(ev => ev.date >= today).sort((a, b) => a.date.localeCompare(b.date) || (a.timeStart || '').localeCompare(b.timeStart || ''));
              const wrap = createEl('div', { style: 'padding:16px;' });
              if (!sorted.length) { wrap.appendChild(createEl('div', { textContent: 'No upcoming events.', style: 'color:var(--text-muted);' })); }
              let lastDate = '';
              sorted.forEach(ev => {
                if (ev.date !== lastDate) {
                  lastDate = ev.date;
                  const d = new Date(ev.date + 'T12:00:00');
                  wrap.appendChild(createEl('div', { textContent: d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }), style: 'font-size:12px;font-weight:700;color:var(--text-muted);margin:14px 0 6px;text-transform:uppercase;letter-spacing:0.06em;' }));
                }
                const row = createEl('div', { style: `display:flex;gap:10px;padding:8px;border-radius:8px;cursor:pointer;margin-bottom:4px;` });
                row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-elevated)');
                row.addEventListener('mouseleave', () => row.style.background = '');
                const bar = createEl('div', { style: `width:4px;border-radius:2px;background:${ev.color || 'var(--accent)'};flex-shrink:0;` });
                const info = createEl('div');
                info.appendChild(createEl('div', { textContent: ev.title, style: 'font-weight:600;font-size:13px;' }));
                if (ev.timeStart) { info.appendChild(createEl('div', { textContent: ev.timeStart + (ev.timeEnd ? ' – ' + ev.timeEnd : ''), style: 'font-size:11px;color:var(--text-muted);' })); }
                row.append(bar, info);
                row.addEventListener('click', () => openEventModal(new Date(ev.date + 'T12:00:00'), ev));
                wrap.appendChild(row);
              });
              contentArea.appendChild(wrap);
            }
          }

          // ── Event modal ────────────────────────────────────────────────
          function openEventModal(date, existing) {
            const isEdit = !!existing;
            const overlay = createEl('div', { style: 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:9999;' });
            const modal = createEl('div', { style: 'background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:12px;padding:20px;width:360px;max-width:90vw;' });

            const title = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;' });
            title.appendChild(createEl('span', { textContent: isEdit ? 'Edit Event' : 'New Event', style: 'font-size:15px;font-weight:700;' }));
            const closeBtn = createEl('button', { className: 'btn btn-icon btn-sm' }); closeBtn.innerHTML = svgIcon('x', 14);
            closeBtn.addEventListener('click', () => overlay.remove());
            title.appendChild(closeBtn);
            modal.appendChild(title);

            function field(label, el) {
              const wrap = createEl('div', { style: 'margin-bottom:12px;' });
              wrap.appendChild(createEl('label', { textContent: label, style: 'display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.06em;' }));
              wrap.appendChild(el); return wrap;
            }

            const titleInp = createEl('input', { className: 'input', placeholder: 'Event title', value: existing?.title || '', id: 'event-title-input', name: 'event-title', style: 'width:100%;' });
            modal.appendChild(field('Title', titleInp));

            const dateInp = createEl('input', { type: 'date', className: 'input', value: date ? date.toISOString().split('T')[0] : '', id: 'event-date-input', name: 'event-date', style: 'width:100%;' });
            const timeStartInp = createEl('input', { type: 'time', className: 'input', value: existing?.timeStart || '', id: 'event-time-start-input', name: 'event-time-start', style: 'flex:1;' });
            const timeEndInp = createEl('input', { type: 'time', className: 'input', value: existing?.timeEnd || '', id: 'event-time-end-input', name: 'event-time-end', style: 'flex:1;' });
            modal.appendChild(field('Date', dateInp));
            const timeRow = createEl('div', { style: 'display:flex;gap:8px;margin-bottom:12px;' });
            function timeField(label, el) {
              const w = createEl('div', { style: 'flex:1;' });
              w.appendChild(createEl('label', { textContent: label, style: 'display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.06em;' }));
              w.appendChild(el); return w;
            }
            timeRow.append(timeField('Start', timeStartInp), timeField('End', timeEndInp));
            modal.appendChild(timeRow);

            const descInp = createEl('textarea', { className: 'input', id: 'event-description-input', name: 'event-description', placeholder: 'Description (optional)', style: 'width:100%;resize:vertical;min-height:56px;' });
            descInp.value = existing?.desc || '';
            modal.appendChild(field('Description', descInp));

            const colorWrap = createEl('div', { style: 'margin-bottom:16px;' });
            colorWrap.appendChild(createEl('label', { textContent: 'Color', style: 'display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.06em;' }));
            const colorRow = createEl('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;' });
            let selectedColor = existing?.color || COLORS[0];
            const colorBtns = [];
            COLORS.forEach((c, i) => {
              const cb = createEl('button', { title: COLOR_NAMES[i], style: `width:22px;height:22px;border-radius:50%;background:${c};border:2px solid ${c === selectedColor ? '#fff' : 'transparent'};cursor:pointer;` });
              cb.addEventListener('click', () => { selectedColor = c; colorBtns.forEach((b, j) => b.style.borderColor = COLORS[j] === c ? '#fff' : 'transparent'); });
              colorBtns.push(cb); colorRow.appendChild(cb);
            });
            colorWrap.appendChild(colorRow);
            modal.appendChild(colorWrap);

            const actions = createEl('div', { style: 'display:flex;gap:8px;justify-content:space-between;' });
            if (isEdit) {
              const delBtn = createEl('button', { className: 'btn', style: 'color:var(--text-danger);border-color:var(--text-danger);', textContent: 'Delete' });
              delBtn.addEventListener('click', () => { events = events.filter(ev => ev.id !== existing.id); saveEvents(events); overlay.remove(); renderAll(); });
              actions.appendChild(delBtn);
            } else { actions.appendChild(createEl('div')); }

            const saveBtn = createEl('button', { className: 'btn btn-primary', textContent: isEdit ? 'Save Changes' : 'Add Event' });
            saveBtn.addEventListener('click', () => {
              const t = titleInp.value.trim();
              if (!t) return titleInp.focus();
              if (isEdit) {
                const ev = events.find(ev => ev.id === existing.id);
                if (ev) Object.assign(ev, { title: t, date: dateInp.value, timeStart: timeStartInp.value, timeEnd: timeEndInp.value, desc: descInp.value, color: selectedColor });
              } else {
                events.push({ id: Date.now().toString(36), title: t, date: dateInp.value || new Date().toISOString().split('T')[0], timeStart: timeStartInp.value, timeEnd: timeEndInp.value, desc: descInp.value, color: selectedColor });
              }
              saveEvents(events); overlay.remove(); renderAll();
              Notify?.show?.({ title: isEdit ? 'Event updated' : 'Event added', body: t, type: 'success', appName: 'Calendar' });
            });
            const cancelBtn = createEl('button', { className: 'btn', textContent: 'Cancel' });
            cancelBtn.addEventListener('click', () => overlay.remove());
            actions.append(cancelBtn, saveBtn);
            modal.appendChild(actions);

            overlay.appendChild(modal);
            document.body.appendChild(overlay);
            setTimeout(() => titleInp.focus(), 50);
          }

          // ── Nav handlers ───────────────────────────────────────────────
          prevBtn.addEventListener('click', () => {
            if (view === 'month') viewDate.setMonth(viewDate.getMonth() - 1);
            else if (view === 'week') viewDate.setDate(viewDate.getDate() - 7);
            else viewDate.setDate(viewDate.getDate() - 1);
            renderAll();
          });
          nextBtn.addEventListener('click', () => {
            if (view === 'month') viewDate.setMonth(viewDate.getMonth() + 1);
            else if (view === 'week') viewDate.setDate(viewDate.getDate() + 7);
            else viewDate.setDate(viewDate.getDate() + 1);
            renderAll();
          });
          todayBtn.addEventListener('click', () => { viewDate = new Date(); renderAll(); });
          miniPrev.addEventListener('click', () => { viewDate.setMonth(viewDate.getMonth() - 1); renderAll(); });
          miniNext.addEventListener('click', () => { viewDate.setMonth(viewDate.getMonth() + 1); renderAll(); });
          newEvtBtn.addEventListener('click', () => openEventModal(new Date(), null));

          function renderAll() { renderMini(); renderMain(); renderUpcoming(); updateViewBtns(); }
          renderAll();
        }
      });


