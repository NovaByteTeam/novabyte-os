registerApp({
        id: 'nbosp-music', name: 'Music', icon: 'music',
        description: 'Music Player',
        defaultSize: [520, 520], minSize: [360, 380],
        init(content, state) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.music', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.music</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const SK_PREFS = 'nova_music_prefs';
          function loadPrefs() { try { return JSON.parse(localStorage.getItem(SK_PREFS) || '{}'); } catch { return {}; } }
          function savePrefs() { lsSave(SK_PREFS, prefs); }
          const prefs = loadPrefs();

          const root = createEl('div', { style: 'display:flex;flex-direction:column;height:100%;overflow:hidden;background:var(--bg-base);' });
          content.appendChild(root);

          /* ── Hidden <audio> element ── */
          const audio = document.createElement('audio');
          audio.style.display = 'none';
          audio.preload = 'metadata';
          root.appendChild(audio);

          /* ── State ── */
          let tracks = [];
          let queue = [];
          let queueIdx = -1;
          let shuffle = prefs.shuffle || false;
          let repeat = prefs.repeat || false;
          const blobCache = new Map();

          function normalizeBuffer(raw) {
            if (!raw) return null;
            if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return raw;
            if (typeof raw === 'string') { try { const b = atob(raw), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++)u[i] = b.charCodeAt(i); return u; } catch { return new TextEncoder().encode(raw); } }
            if (typeof raw === 'object') { const keys = Object.keys(raw), u = new Uint8Array(keys.length); for (let i = 0; i < keys.length; i++)u[i] = raw[i] ?? 0; return u; }
            return null;
          }

          function audioMimeFromName(name) {
            const ext = (name || '').split('.').pop().toLowerCase();
            return {
              mp3: 'audio/mpeg', mp4: 'audio/mp4', m4a: 'audio/mp4', ogg: 'audio/ogg',
              wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
              opus: 'audio/ogg; codecs=opus', weba: 'audio/webm', webm: 'audio/webm'
            }[ext] || 'audio/mpeg';
          }

          function getUrl(track) {
            if (blobCache.has(track.id)) return blobCache.get(track.id);
            if (track.content) {
              try {
                const data = normalizeBuffer(track.content);
                if (!data) return null;
                // Use extension-derived MIME when stored type is missing or non-audio
                // (e.g. 'application/octet-stream'). A wrong MIME on the blob causes
                // NS_ERROR_DOM_MEDIA_METADATA_ERR in Firefox even if the data is valid.
                const storedMime = track.mimeType || '';
                const mime = storedMime.startsWith('audio/') ? storedMime : audioMimeFromName(track.name);
                const blob = new Blob([data], { type: mime });
                const url = URL.createObjectURL(blob);
                blobCache.set(track.id, url);
                return url;
              } catch { return null; }
            }
            return null;
          }

          /* ── Library header ── */
          const libHeader = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);' });
          const libTitle = createEl('span', { textContent: 'Library', style: 'font-size:13px;font-weight:600;flex:1;' });
          const libCount = createEl('span', { style: 'font-size:11px;color:var(--text-muted);' });
          const refreshBtn = createEl('button', { className: 'browser-nav-btn', title: 'Rescan library' });
          refreshBtn.innerHTML = svgIcon('refresh', 15);
          libHeader.append(libTitle, libCount, refreshBtn);
          root.appendChild(libHeader);

          /* ── Track list ── */
          const trackList = createEl('div', { style: 'flex:1;overflow-y:auto;min-height:0;' });
          root.appendChild(trackList);

          /* ── Now-playing bar ── */
          const player = createEl('div', { style: 'border-top:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);padding:12px 14px;display:flex;flex-direction:column;gap:8px;' });

          const trackInfoRow = createEl('div', { style: 'display:flex;align-items:center;gap:10px;' });
          const albumArt = createEl('div', { style: 'width:40px;height:40px;border-radius:6px;background:var(--bg-sunken);border:1px solid var(--border-subtle);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--text-muted);' });
          albumArt.innerHTML = svgIcon('music', 18);
          const trackNameEl = createEl('div', { style: 'flex:1;min-width:0;' });
          const trackTitle = createEl('div', { textContent: 'No track selected', style: 'font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' });
          const trackSub = createEl('div', { textContent: '', style: 'font-size:11px;color:var(--text-muted);' });
          trackNameEl.append(trackTitle, trackSub);
          trackInfoRow.append(albumArt, trackNameEl);

          /* Progress row */
          const progressRow = createEl('div', { style: 'display:flex;align-items:center;gap:8px;' });
          const timeCur = createEl('span', { textContent: '0:00', style: 'font-size:10px;color:var(--text-muted);width:30px;text-align:right;font-variant-numeric:tabular-nums;' });
          const scrubWrap = createEl('div', { style: 'flex:1;height:4px;background:var(--border-subtle);border-radius:2px;cursor:pointer;position:relative;' });
          const scrubFill = createEl('div', { style: 'height:100%;background:var(--accent);border-radius:2px;width:0%;transition:width 0.25s linear;pointer-events:none;' });
          scrubWrap.appendChild(scrubFill);
          const timeTotal = createEl('span', { textContent: '0:00', style: 'font-size:10px;color:var(--text-muted);width:30px;font-variant-numeric:tabular-nums;' });
          progressRow.append(timeCur, scrubWrap, timeTotal);

          /* Controls row */
          const controlsRow = createEl('div', { style: 'display:flex;align-items:center;justify-content:center;gap:6px;' });
          function ctrlBtn(icon, size, title) {
            const b = createEl('button', { className: 'browser-nav-btn', title, style: 'width:32px;height:32px;display:flex;align-items:center;justify-content:center;' });
            b.innerHTML = svgIcon(icon, size);
            return b;
          }
          const shuffleBtn = ctrlBtn('shuffle', 14, 'Shuffle');
          const prevBtn = ctrlBtn('skip-back', 16, 'Previous');
          const playPauseBtn = createEl('button', { style: 'width:38px;height:38px;border-radius:50%;background:var(--accent);border:none;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform 0.1s,background 0.1s;', title: 'Play/Pause' });
          playPauseBtn.innerHTML = svgIcon('play', 18);
          const nextBtn = ctrlBtn('skip-forward', 16, 'Next');
          const repeatBtn = ctrlBtn('repeat', 14, 'Repeat');

          /* Volume */
          const volRow = createEl('div', { style: 'display:flex;align-items:center;gap:6px;' });
          const volIco = createEl('span', { style: 'color:var(--text-muted);', innerHTML: svgIcon('volume-2', 14) });
          const volSlider = createEl('input', { type: 'range', min: '0', max: '1', step: '0.02', value: String(prefs.volume !== undefined ? prefs.volume : 1), style: 'flex:1;accent-color:var(--accent);height:4px;cursor:pointer;' });
          volRow.append(volIco, volSlider);

          controlsRow.append(shuffleBtn, prevBtn, playPauseBtn, nextBtn, repeatBtn, createEl('span', { style: 'flex:1;' }), volRow);
          player.append(trackInfoRow, progressRow, controlsRow);
          root.appendChild(player);

          /* ── Audio event wiring ── */
          function fmtTime(s) { if (!isFinite(s)) return '0:00'; const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }

          audio.volume = parseFloat(volSlider.value);

          audio.addEventListener('timeupdate', () => {
            if (!audio.duration) return;
            const pct = (audio.currentTime / audio.duration) * 100;
            scrubFill.style.width = pct + '%';
            timeCur.textContent = fmtTime(audio.currentTime);
          });
          audio.addEventListener('loadedmetadata', () => { timeTotal.textContent = fmtTime(audio.duration); });
          audio.addEventListener('ended', () => {
            if (repeat) { audio.currentTime = 0; audio.play(); }
            else playIdx(queueIdx + 1);
          });
          audio.addEventListener('play', () => { playPauseBtn.innerHTML = svgIcon('pause', 18); });
          audio.addEventListener('pause', () => { playPauseBtn.innerHTML = svgIcon('play', 18); });

          scrubWrap.addEventListener('click', e => {
            if (!audio.duration) return;
            const r = scrubWrap.getBoundingClientRect();
            audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
          });

          volSlider.addEventListener('input', () => { audio.volume = parseFloat(volSlider.value); prefs.volume = audio.volume; savePrefs(); });

          playPauseBtn.addEventListener('mouseenter', () => playPauseBtn.style.transform = 'scale(1.08)');
          playPauseBtn.addEventListener('mouseleave', () => playPauseBtn.style.transform = '');
          playPauseBtn.addEventListener('click', () => { if (audio.paused) audio.play().catch(() => { }); else audio.pause(); });
          prevBtn.addEventListener('click', () => playIdx(queueIdx - 1));
          nextBtn.addEventListener('click', () => playIdx(queueIdx + 1));

          shuffleBtn.addEventListener('click', () => {
            shuffle = !shuffle; prefs.shuffle = shuffle; savePrefs();
            shuffleBtn.style.color = shuffle ? 'var(--accent)' : '';
            buildQueue();
          });
          repeatBtn.addEventListener('click', () => {
            repeat = !repeat; prefs.repeat = repeat; savePrefs();
            repeatBtn.style.color = repeat ? 'var(--accent)' : '';
          });

          /* Init toggle states */
          if (shuffle) shuffleBtn.style.color = 'var(--accent)';
          if (repeat) repeatBtn.style.color = 'var(--accent)';

          /* ── Queue management ── */
          function buildQueue(startId) {
            queue = [...tracks];
            if (shuffle) {
              for (let i = queue.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [queue[i], queue[j]] = [queue[j], queue[i]];
              }
            }
            if (startId) {
              const si = queue.findIndex(t => t.id === startId);
              if (si > -1) queueIdx = si;
            }
          }

          function playIdx(i) {
            if (!queue.length) return;
            queueIdx = ((i % queue.length) + queue.length) % queue.length;
            playTrack(queue[queueIdx]);
          }

          function playTrack(track) {
            const url = getUrl(track);
            if (!url) { Notify.show({ title: 'Music', body: 'Cannot load ' + track.name, type: 'error', appName: 'Music' }); return; }
            audio.src = url;
            audio.play().catch(() => { });
            trackTitle.textContent = track.name.replace(/\.[^.]+$/, '');
            trackSub.textContent = fmtTime(0);
            renderList();
          }

          /* ── Library scan & render ── */
          function scanLibrary() {
            const audioExts = new Set(['mp3', 'mp4', 'm4a', 'ogg', 'wav', 'flac', 'aac', 'opus', 'weba', 'webm']);
            tracks = Array.from(FS.files.values())
              .filter(f => {
                if (f.type !== 'file') return false;
                if (f.mimeType && f.mimeType.startsWith('audio/')) return true;
                const ext = (f.name || '').split('.').pop().toLowerCase();
                return audioExts.has(ext);
              })
              .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            libCount.textContent = tracks.length ? tracks.length + ' track' + (tracks.length > 1 ? 's' : '') : '';
            buildQueue();
            renderList();
          }

          function renderList() {
            trackList.innerHTML = '';
            if (!tracks.length) {
              const empty = createEl('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-muted);gap:8px;text-align:center;padding:24px;' });
              empty.innerHTML = svgIcon('music', 36) + '<div style="font-size:13px;margin-top:10px;color:var(--text-secondary);">No audio files found</div><div style="font-size:11px;margin-top:4px;">Save audio files via Files to play them here</div>';
              trackList.appendChild(empty);
              return;
            }

            const currentId = queue[queueIdx]?.id;
            tracks.forEach((track, idx) => {
              const isPlaying = track.id === currentId;
              const row = createEl('div', { style: 'display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--border-subtle);cursor:pointer;transition:background 0.1s;background:' + (isPlaying ? 'var(--accent-muted)' : 'transparent') + ';', title: track.name });
              row.addEventListener('mouseenter', () => { if (!isPlaying) row.style.background = 'var(--bg-hover)'; });
              row.addEventListener('mouseleave', () => { if (!isPlaying) row.style.background = ''; });
              row.addEventListener('dblclick', () => { buildQueue(track.id); playTrack(track); });
              row.addEventListener('click', () => {
                if (isPlaying) { if (audio.paused) audio.play().catch(() => { }); else audio.pause(); }
                else { buildQueue(track.id); playTrack(track); }
              });

              const ico = createEl('span', { style: 'color:' + (isPlaying ? 'var(--accent)' : 'var(--text-muted)') + ';flex-shrink:0;' });
              ico.innerHTML = svgIcon(isPlaying && !audio.paused ? 'pause' : 'music', 15);

              const nameEl = createEl('div', { textContent: track.name.replace(/\.[^.]+$/, ''), style: 'flex:1;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:' + (isPlaying ? 'var(--accent)' : 'var(--text-primary)') + ';' });
              const numEl = createEl('div', { textContent: String(idx + 1).padStart(2, '0'), style: 'font-size:11px;color:var(--text-muted);font-variant-numeric:tabular-nums;flex-shrink:0;min-width:20px;text-align:right;' });

              row.append(numEl, ico, nameEl);
              trackList.appendChild(row);
            });
          }

          refreshBtn.addEventListener('click', scanLibrary);

          state.cleanups = state.cleanups || [];
          state.cleanups.push(() => {
            audio.pause();
            blobCache.forEach(u => URL.revokeObjectURL(u));
          });

          scanLibrary();
        }
      });


      // Start the OS
      boot();

      // FIX: run FrameSecurity audit after boot settles so all app iframes are in the DOM
      setTimeout(function () {
        if (typeof window.FrameSecurity !== 'undefined') {
          const audit = window.FrameSecurity.auditAllFrames(false);
          if (audit.issues.length > 0) {
            console.error('[FrameSecurity] Boot audit found issues:', audit.issues);
          }
        }
      }, 3000);


