
'use strict';
(() => {
  const content = document.getElementById('app') || document.body;
  const state = { cleanups: [] };

  window.createEl = function createEl(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) for (const [key, value] of Object.entries(attrs)) {
      if (value == null) continue;
      if (key === 'className' || key === 'class') el.className = value;
      else if (key === 'textContent') el.textContent = value;
      else if (key === 'innerHTML') el.innerHTML = value;
      else if (key === 'style') el.style.cssText = typeof value === 'object' ? Object.entries(value).map(([k,v]) => `${k}:${v}`).join(';') : String(value);
      else if (key === 'dataset' && typeof value === 'object') for (const [dk,dv] of Object.entries(value)) el.dataset[dk] = dv;
      else if (key === 'htmlFor') el.htmlFor = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (typeof value === 'boolean') { if (value) el.setAttribute(key, ''); }
      else el[key] = value;
    }
    if (children != null) {
      const xs = Array.isArray(children) ? children : [children];
      for (const child of xs) if (child || child === 0) el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  };

  const inlineIcons = {
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    x: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>'
  };
  window.svgIcon = function svgIcon(name, size = 16) {
    const d = inlineIcons[name];
    if (!d) return '';
    const s = Number(size) || 16;
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  };

  // The old built-in app only used this for the presence check. The actual
  // privileged filesystem path is still enforced by the Nova IPC layer.
  window.AppDirs = { getVFSDir() { return '/data/com.nbosp.clock/files'; } };

  const remoteState = {
    timer: { running: false, done: false, presetMs: 0, remainingMs: 0, endAt: 0 },
    stopwatch: { running: false, elapsedMs: 0, startedAt: 0, laps: [] },
    lastAlarmMinute: ''
  };
  let alarmDbCache = { alarms: [] };

  function applyState(s) {
    if (!s || typeof s !== 'object') return;
    if (s.timer) Object.assign(remoteState.timer, s.timer);
    if (s.stopwatch) {
      Object.assign(remoteState.stopwatch, s.stopwatch);
      remoteState.stopwatch.laps = Array.isArray(s.stopwatch.laps) ? s.stopwatch.laps.slice() : [];
    }
    if (typeof s.lastAlarmMinute === 'string') remoteState.lastAlarmMinute = s.lastAlarmMinute;
  }

  async function ipc(type, payload = {}) {
    if (!window.nova?.ipc) throw new Error('Nova IPC bridge unavailable');
    const result = await window.nova.ipc(type, payload);
    if (result?.state) applyState(result.state);
    return result;
  }

  function localTimerMs() {
    if (remoteState.timer.running && remoteState.timer.endAt) {
      return Math.max(0, remoteState.timer.endAt - Date.now());
    }
    return Math.max(0, Number(remoteState.timer.remainingMs) || 0);
  }
  function localStopwatchMs() {
    return remoteState.stopwatch.running
      ? Math.max(0, Number(remoteState.stopwatch.elapsedMs) || 0) + Math.max(0, Date.now() - (Number(remoteState.stopwatch.startedAt) || 0))
      : Math.max(0, Number(remoteState.stopwatch.elapsedMs) || 0);
  }

  const clockSvc = {
    state: remoteState,
    timerMs: localTimerMs,
    stopwatchMs: localStopwatchMs,
    ensureBooted() { return true; },
    persist() { ipc('nova:clock:state:persist').catch(() => {}); },
    setTimerPreset(ms) { ipc('nova:clock:timer:set-preset', { ms }).catch(() => {}); },
    startTimer(ms) { ipc('nova:clock:timer:start', { ms }).catch(() => {}); },
    pauseTimer() { ipc('nova:clock:timer:pause').catch(() => {}); },
    restartTimer() { ipc('nova:clock:timer:restart').catch(() => {}); },
    resetTimer() { ipc('nova:clock:timer:reset').catch(() => {}); },
    startStopwatch() { ipc('nova:clock:stopwatch:start').catch(() => {}); },
    pauseStopwatch() { ipc('nova:clock:stopwatch:pause').catch(() => {}); },
    resetStopwatch() { ipc('nova:clock:stopwatch:reset').catch(() => {}); },
    lapStopwatch() { ipc('nova:clock:stopwatch:lap').catch(() => {}); },
  };

  async function main() {
    try {
      const [stateResult, alarmResult] = await Promise.all([
        ipc('nova:clock:state:get'),
        ipc('nova:clock:alarms:get')
      ]);
      if (stateResult?.state) applyState(stateResult.state);
      if (Array.isArray(alarmResult?.alarms)) alarmDbCache = { alarms: alarmResult.alarms };
    } catch (err) {
      console.warn('[Clock] Background service handshake failed; using local fallback state:', err);
      try {
        alarmDbCache = JSON.parse(localStorage.getItem('nbosp_clock_v1') || '{"alarms":[]}');
      } catch { alarmDbCache = { alarms: [] }; }
    }

    if (!window.AppDirs?.getVFSDir('com.nbosp.clock', 'files')) {
      content.style.cssText =
        'display:flex;align-items:center;justify-content:center;height:100%;' +
        'flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML =
        '<div style="font-size:32px">⚠️</div>' +
        '<div style="font-size:14px;text-align:center"><b>com.nbosp.clock</b><br>' +
        'App data directory missing.<br>This app requires NovaByte OS.</div>';
      return;
    }

    const SK = 'nbosp_clock_v1';

    function loadDb() {
      try {
        return alarmDbCache || { alarms: [] };
      } catch {
        return {};
      }
    }

    async function saveDb() {
      alarmDbCache = { alarms: db.alarms.map(sanitiseAlarm) };
      const r = await ipc('nova:clock:alarms:set', alarmDbCache);
      if (Array.isArray(r?.alarms)) {
        alarmDbCache = { alarms: r.alarms.map(sanitiseAlarm) };
        db.alarms = alarmDbCache.alarms.map(sanitiseAlarm);
      }
      return r;
    }

    const TIME_RE = /^\d{2}:\d{2}$/;

    function sanitiseAlarm(al) {
      return {
        id: typeof al?.id === 'string' ? al.id : Date.now().toString(36),
        time: typeof al?.time === 'string' ? al.time : '07:00',
        label: typeof al?.label === 'string' ? al.label : '',
        days: Array.isArray(al?.days)
          ? al.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6)
          : [],
        enabled: al?.enabled !== false,
      };
    }

    const db = loadDb();
    if (!Array.isArray(db.alarms)) db.alarms = [];
    db.alarms = db.alarms.map(sanitiseAlarm).filter(al => TIME_RE.test(al.time));

    function pad(n) { return String(Math.floor(n)).padStart(2, '0'); }


    function syncClockState() {
      const s = clockSvc?.state;
      if (!s) {
        return {
          timer: { running: false, done: false, presetMs: 0, remainingMs: 0, endAt: 0 },
          stopwatch: { running: false, elapsedMs: 0, startedAt: 0, laps: [] },
        };
      }
      return {
        timer: { ...s.timer },
        stopwatch: {
          ...s.stopwatch,
          laps: Array.isArray(s.stopwatch?.laps) ? s.stopwatch.laps.slice() : [],
        },
      };
    }

    // Reuse one context.
    let _actx = null;
    function getAudioContext() {
      if (!_actx || _actx.state === 'closed') {
        _actx = new (window.AudioContext || window.webkitAudioContext)();
      }
      return _actx;
    }

    // Lets us cancel the queued tones.
    function beep(freq, dur) {
      const ids = [];
      function _beep(f, d, delayMs) {
        const id = setTimeout(() => {
          try {
            const actx = getAudioContext();
            const osc = actx.createOscillator();
            const gn = actx.createGain();
            osc.type = 'sine';
            osc.frequency.value = f || 880;
            gn.gain.setValueAtTime(0.3, actx.currentTime);
            gn.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + (d || 1.2));
            osc.connect(gn);
            gn.connect(actx.destination);
            osc.start();
            osc.stop(actx.currentTime + (d || 1.2));
          } catch {}
        }, delayMs);
        ids.push(id);
      }
      _beep(freq, dur, 0);
      _beep(1047, 0.8, 400);
      _beep(1319, 1.2, 800);
      return () => ids.forEach(clearTimeout);
    }

    // Keep cleanup around for teardown.
    let _cancelBeep = null;
    function fireAlarmBeep() {
      _cancelBeep?.();
      _cancelBeep = beep(880, 0.8);
    }

    const root = createEl('div', { className: 'nbc-root' });
    content.appendChild(root);

    const TABS = ['alarm', 'clock', 'timer', 'stopwatch'];
    const LABELS = { alarm: 'Alarm', clock: 'Clock', timer: 'Timer', stopwatch: 'Stopwatch' };
    let activeTab = 'clock';

    const tabBar = createEl('div', { className: 'nbc-tabbar' });
    const body = createEl('div', { className: 'nbc-body' });
    root.append(tabBar, body);

    const clockSec = createEl('div', { className: 'nbc-section', style: 'align-items:center;padding:28px 16px 16px;' });
    const alarmSec = createEl('div', { className: 'nbc-section' });
    const timerSec = createEl('div', { className: 'nbc-section', style: 'align-items:center;justify-content:center;padding:20px;gap:18px;' });
    const swSec    = createEl('div', { className: 'nbc-section', style: 'align-items:center;padding-top:28px;' });

    const sections = { clock: clockSec, alarm: alarmSec, timer: timerSec, stopwatch: swSec };
    body.append(clockSec, alarmSec, timerSec, swSec);

    const tabEls = {};
    TABS.forEach(t => {
      const el = createEl('button', { className: 'nbc-tab', textContent: LABELS[t] });
      el.addEventListener('click', () => switchTab(t));
      tabBar.appendChild(el);
      tabEls[t] = el;
    });

    function switchTab(t) {
      activeTab = t;
      for (const id of TABS) {
        sections[id].classList.toggle('active', id === t);
        tabEls[id].classList.toggle('active', id === t);
      }
    }
    switchTab(activeTab);


    const NS_SVG = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS_SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 200 200');
    svg.setAttribute('class', 'nbc-clock-face');

    const tickMarkup = Array.from({ length: 60 }, (_, i) => {
      const angle = (i * 6 - 90) * Math.PI / 180;
      const major = i % 5 === 0;
      const r1 = major ? 76 : 83;
      const r2 = 91;
      const x1 = (100 + r1 * Math.cos(angle)).toFixed(3);
      const y1 = (100 + r1 * Math.sin(angle)).toFixed(3);
      const x2 = (100 + r2 * Math.cos(angle)).toFixed(3);
      const y2 = (100 + r2 * Math.sin(angle)).toFixed(3);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--text-muted)" stroke-width="${major ? 2 : 1}" opacity="${major ? 0.9 : 0.35}"/>`;
    }).join('');

    svg.innerHTML =
      '<circle cx="100" cy="100" r="96" fill="none" stroke="var(--border-subtle)" stroke-width="1.5"/>' +
      '<circle cx="100" cy="100" r="95" fill="var(--bg-elevated)"/>' +
      tickMarkup +
      '<line id="nbc-hr" x1="100" y1="100" x2="100" y2="47" stroke="var(--text-primary)" stroke-width="5.5" stroke-linecap="round"/>' +
      '<line id="nbc-mn" x1="100" y1="100" x2="100" y2="24" stroke="var(--text-primary)" stroke-width="3" stroke-linecap="round"/>' +
      '<line id="nbc-sc" x1="100" y1="114" x2="100" y2="18" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round"/>' +
      '<circle cx="100" cy="100" r="5" fill="var(--accent)"/>' +
      '<circle cx="100" cy="100" r="2" fill="var(--bg-elevated)"/>';

    // Hand refs live once; no need to query again.
    const hrHand = svg.querySelector('#nbc-hr');
    const mnHand = svg.querySelector('#nbc-mn');
    const scHand = svg.querySelector('#nbc-sc');

    const digitalEl = createEl('div', { className: 'nbc-digital' });
    const dateEl    = createEl('div', { className: 'nbc-date' });
    clockSec.append(svg, digitalEl, dateEl);

    let _lastClockSec = -1;
    let _lastAlarmMinute = '';

    function tickClock() {
      const now = new Date();
      const sec = now.getSeconds();
      const ms  = now.getMilliseconds();

      const h = (now.getHours() % 12) + now.getMinutes() / 60 + sec / 3600;
      const m = now.getMinutes() + sec / 60;
      const s = sec + ms / 1000;
      hrHand.setAttribute('transform', `rotate(${(h * 30).toFixed(2)} 100 100)`);
      mnHand.setAttribute('transform', `rotate(${(m * 6).toFixed(2)} 100 100)`);
      scHand.setAttribute('transform', `rotate(${(s * 6).toFixed(2)} 100 100)`);

      if (sec !== _lastClockSec) {
        _lastClockSec = sec;
        digitalEl.textContent = now.toLocaleTimeString([], {
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
        dateEl.textContent = now.toLocaleDateString([], {
          weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
        });

        if (sec === 0 && ms < 300) {
          const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
          if (timeStr !== _lastAlarmMinute) {
            _lastAlarmMinute = timeStr;
            const dow = now.getDay();
            let didDisable = false;
            for (const al of db.alarms) {
              if (!al.enabled || al.time !== timeStr) continue;
              if (al.days.length > 0 && !al.days.includes(dow)) continue;
              fireAlarmBeep();
              if (al.days.length === 0) { al.enabled = false; didDisable = true; }
            }
            if (didDisable) { saveDb(); renderAlarms(); }
          }
        }
      }
    }

    const clockInt = setInterval(tickClock, 250);
    state.cleanups?.push(() => clearInterval(clockInt));
    tickClock();


    const alarmHdr = createEl('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;',
    });
    alarmHdr.appendChild(createEl('div', { textContent: 'Alarms', style: 'font-size:15px;font-weight:700;' }));

    const addAlarmBtn = createEl('button', { className: 'btn btn-sm btn-primary', style: 'display:flex;align-items:center;gap:4px;' });
    addAlarmBtn.innerHTML = svgIcon('plus', 13) + ' Add';
    alarmHdr.appendChild(addAlarmBtn);
    alarmSec.appendChild(alarmHdr);

    const alarmList = createEl('div', { style: 'flex:1;overflow-y:auto;' });
    alarmSec.appendChild(alarmList);

    const DOW      = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const DOW_FULL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    // Simple id counter for toggle inputs.
    let _toggleIdCounter = 0;

    function makeToggle(checked, onChange) {
      const uid = `nbc-tog-${++_toggleIdCounter}`;
      const wrap = createEl('label', { className: 'nbc-toggle', htmlFor: uid });
      const inp = createEl('input');
      inp.type = 'checkbox';
      inp.id = uid;
      inp.name = uid;
      inp.checked = checked;
      inp.style.cssText = 'position:absolute;opacity:0;width:0;height:0;';
      const track = createEl('div', {
        className: 'nbc-track',
        style: `background:${checked ? 'var(--accent)' : 'var(--border-default)'};`,
      });
      const thumb = createEl('div', {
        className: 'nbc-thumb',
        style: `left:${checked ? '23' : '3'}px;`,
      });
      inp.addEventListener('change', () => {
        const v = inp.checked;
        track.style.background = v ? 'var(--accent)' : 'var(--border-default)';
        thumb.style.left = v ? '23px' : '3px';
        onChange(v);
      });
      wrap.append(inp, track, thumb);
      return wrap;
    }

    function renderAlarms() {
      alarmList.innerHTML = '';

      const sorted = db.alarms
        .map((al, idx) => ({ idx, al: sanitiseAlarm(al) }))
        .filter(({ al }) => TIME_RE.test(al.time))
        .sort((a, b) => a.al.time.localeCompare(b.al.time));

      if (!sorted.length) {
        alarmList.appendChild(createEl('div', {
          textContent: 'No alarms set. Tap + Add to create one.',
          style: 'padding:40px 20px;text-align:center;color:var(--text-muted);font-size:13px;',
        }));
        return;
      }

      const frag = document.createDocumentFragment();
      for (const { idx, al } of sorted) {
        const [hhS, mmS] = al.time.split(':');
        const hh = +hhS, mm = +mmS;
        const ampm = hh < 12 ? 'AM' : 'PM';
        const h12  = hh % 12 || 12;

        const row  = createEl('div', { className: 'nbc-alarm-row' });
        const left = createEl('div', { style: 'flex:1;cursor:pointer;' });
        left.addEventListener('click', () => openAlarmModal(idx));

        const timeRow = createEl('div', { style: 'display:flex;align-items:baseline;gap:5px;' });
        const timeEl  = createEl('div', { className: 'nbc-alarm-time', textContent: `${h12}:${pad(mm)}` });
        timeEl.style.color = al.enabled ? 'var(--text-primary)' : 'var(--text-muted)';
        const ampmEl = createEl('div', { className: 'nbc-alarm-ampm', textContent: ampm });
        timeRow.append(timeEl, ampmEl);

        const meta = createEl('div', { className: 'nbc-alarm-meta' });
        const parts = [];
        if (al.label) parts.push(al.label);
        if (al.days.length === 0) parts.push('Once');
        else if (al.days.length === 7) parts.push('Every day');
        else if (al.days.length === 5 && !al.days.includes(0) && !al.days.includes(6)) parts.push('Weekdays');
        else parts.push(al.days.map(d => DOW[d]).join(' '));
        meta.textContent = parts.join(' · ');

        left.append(timeRow, meta);

        const toggle = makeToggle(al.enabled, v => {
          db.alarms[idx].enabled = v;
          saveDb();
          renderAlarms();
        });

        row.append(left, toggle);
        frag.appendChild(row);
      }
      alarmList.appendChild(frag);
    }

    // Track the open modal for teardown.
    let _activeModal = null;

    async function openAlarmModal(idx) {
      const isEdit = idx !== null && idx >= 0 && idx < db.alarms.length;
      const src = isEdit ? sanitiseAlarm(db.alarms[idx]) : {
        time: '07:00', label: '', days: [1, 2, 3, 4, 5], enabled: true
      };
      try {
        const response = await ipc('nova:clock:alarm:dialog', { alarm: src, editing: isEdit });
        const result = response?.result;
        if (!result || result === '__CLOCK_CANCEL__') return;
        if (result === '__CLOCK_DELETE__') {
          db.alarms.splice(idx, 1);
          await saveDb();
          renderAlarms();
          return;
        }
        if (!result?.time || !TIME_RE.test(result.time)) return;
        const payload = {
          time: result.time,
          label: String(result.label || '').trim().slice(0, 64),
          days: Array.isArray(result.days) ? result.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : [],
          enabled: true,
        };
        if (isEdit) Object.assign(db.alarms[idx], payload);
        else db.alarms.push({ id: Date.now().toString(36), ...payload });
        await saveDb();
        renderAlarms();
      } catch (e) {
        console.warn('[Clock] Alarm dialog failed:', e);
      }
    }

    addAlarmBtn.addEventListener('click', () => openAlarmModal(null));
    renderAlarms();


    let tiMs = 0, tiSet = 0, tiRun = false, tiDone = false;

    const tiDisplay = createEl('div', { className: 'nbc-timer-display', textContent: '00:00' });

    const tiInpRow = createEl('div', { style: 'display:flex;align-items:center;gap:6px;' });

    function tiInp(max) {
      const el = createEl('input', {
        type: 'number',
        min: '0',
        max: String(max),
        className: 'nbc-timer-inp',
        placeholder: '0',
      });
      el.addEventListener('input', () => {
        let v = parseInt(el.value, 10) || 0;
        if (v > max) { v = max; el.value = max; }
        syncTiFromInputs();
      });
      return el;
    }

    const tiH = tiInp(99), tiM = tiInp(59), tiS = tiInp(59);
    const mkColon = () => createEl('span', { textContent: ':', style: 'font-size:30px;font-weight:200;color:var(--text-muted);' });
    const mkLbl   = t  => createEl('div',  { textContent: t, style: 'font-size:10px;color:var(--text-muted);text-align:center;' });

    function col(inp, lbl) {
      const c = createEl('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:3px;' });
      c.append(inp, mkLbl(lbl));
      return c;
    }
    tiInpRow.append(col(tiH, 'h'), mkColon(), col(tiM, 'm'), mkColon(), col(tiS, 's'));

    function syncTiFromInputs() {
      tiSet = tiMs = (
        (parseInt(tiH.value, 10) || 0) * 3600 +
        (parseInt(tiM.value, 10) || 0) * 60  +
        (parseInt(tiS.value, 10) || 0)
      ) * 1000;
      remoteState.timer.presetMs = tiSet;
      if (!remoteState.timer.running) {
        remoteState.timer.remainingMs = tiSet;
        remoteState.timer.done = false;
        remoteState.timer.endAt = 0;
      }
      clockSvc?.setTimerPreset?.(tiSet).catch(() => {});
      clockSvc?.persist?.().catch(() => {});
      renderTiDisplay();
    }

    function renderTiDisplay() {
      const st = syncClockState();
      tiRun  = !!st.timer.running;
      tiDone = !!st.timer.done;
      tiSet  = Math.max(0, Number(st.timer.presetMs) || 0);
      tiMs   = tiRun
        ? Math.max(0, Number(st.timer.endAt) - Date.now())
        : Math.max(0, Number(st.timer.remainingMs) || tiSet || 0);
      const h = Math.floor(tiMs / 3600000);
      const m = Math.floor((tiMs % 3600000) / 60000);
      const s = Math.floor((tiMs % 60000) / 1000);
      tiDisplay.textContent = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
      tiDisplay.style.color = tiDone ? 'var(--accent)' : 'var(--text-primary)';
    }

    const tiBtnRow = createEl('div', { style: 'display:flex;gap:10px;' });
    const tiStart  = createEl('button', { className: 'nbc-pill-btn primary', textContent: 'Start' });
    const tiReset  = createEl('button', { className: 'nbc-pill-btn', textContent: 'Reset', style: 'display:none;' });
    tiBtnRow.append(tiReset, tiStart);

    function renderTiBtns() {
      tiStart.textContent       = tiRun ? 'Pause' : tiDone ? 'Restart' : 'Start';
      tiReset.style.display     = (tiMs !== tiSet || tiDone) ? 'block' : 'none';
    }

    tiStart.addEventListener('click', async () => {
      const st = syncClockState();
      if (!st.timer.presetMs && !st.timer.remainingMs && !tiSet) return;
      try {
        if (st.timer.running) {
          await clockSvc?.pauseTimer?.();
        } else if (st.timer.done) {
          await clockSvc?.restartTimer?.();
        } else {
          await clockSvc?.startTimer?.(st.timer.remainingMs || tiSet || 0);
        }
      } catch {}
      renderTiDisplay();
      renderTiBtns();
    });

    tiReset.addEventListener('click', () => {
      clockSvc?.resetTimer?.();
      const st = syncClockState();
      tiRun  = false;
      tiDone = false;
      tiMs   = Math.max(0, Number(st.timer.remainingMs) || st.timer.presetMs || 0);
      tiH.value = tiSet ? String(Math.floor(tiSet / 3600000))             || '' : '';
      tiM.value = tiSet ? String(Math.floor((tiSet % 3600000) / 60000))        : '';
      tiS.value = tiSet ? String(Math.floor((tiSet % 60000) / 1000))           : '';
      renderTiDisplay();
      renderTiBtns();
    });

    timerSec.append(tiDisplay, tiInpRow, tiBtnRow);
    renderTiDisplay();
    renderTiBtns();


    let swRun = false, swElapsed = 0, swStart = 0, swLaps = [];

    function swSync() {
      const st = syncClockState();
      swRun     = !!st.stopwatch.running;
      swElapsed = Math.max(0, Number(st.stopwatch.elapsedMs) || 0);
      swStart   = Math.max(0, Number(st.stopwatch.startedAt) || 0);
      swLaps    = Array.isArray(st.stopwatch.laps) ? st.stopwatch.laps.slice() : [];
    }

    function swCurrentMs() {
      return swRun ? swElapsed + (Date.now() - swStart) : swElapsed;
    }

    const swDisplay = createEl('div', { className: 'nbc-sw-display', textContent: '00:00.00' });

    const swBtnRow  = createEl('div', { style: 'display:flex;gap:12px;margin-top:16px;margin-bottom:16px;' });
    const swStartBtn = createEl('button', { textContent: 'Start', className: 'nbc-pill-btn primary' });
    const swLapBtn   = createEl('button', { textContent: 'Lap',   className: 'nbc-pill-btn', style: 'min-width:82px;' });
    swBtnRow.append(swLapBtn, swStartBtn);

    const swLapHdr = createEl('div', { style: 'display:flex;justify-content:space-between;padding:6px 16px;border-bottom:1px solid var(--border-subtle);' });
    const mkHdrCell = t => createEl('span', { textContent: t, style: 'font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.07em;' });
    swLapHdr.append(mkHdrCell('Lap'), mkHdrCell('Split'), mkHdrCell('Overall'));

    const swLapScroll = createEl('div', { style: 'flex:1;overflow-y:auto;width:100%;' });
    swSec.append(swDisplay, swBtnRow, swLapHdr, swLapScroll);

    function fmtSw(ms) {
      const m  = Math.floor(ms / 60000);
      const s  = Math.floor((ms % 60000) / 1000);
      const cs = Math.floor((ms % 1000) / 10);
      return `${pad(m)}:${pad(s)}.${pad(cs)}`;
    }

    // Smooth stopwatch redraw. Elapsed time is derived from Date.now() so there
    // is no drift — we just repaint the centiseconds each animation frame
    // instead of every 250ms (which made the display visibly stutter).
    let swRafId = null;
    function swStopRaf() {
      if (swRafId !== null) { cancelAnimationFrame(swRafId); swRafId = null; }
    }
    function swEnsureRaf() {
      if (swRafId !== null || !swRun) return;
      const loop = () => {
        if (!swRun) { swRafId = null; return; }
        swDisplay.textContent = fmtSw(swCurrentMs());
        swRafId = requestAnimationFrame(loop);
      };
      swRafId = requestAnimationFrame(loop);
    }

    function renderSwLaps() {
      if (!swLaps.length) { swLapScroll.innerHTML = ''; return; }

      const splits     = swLaps.map((v, i) => v - (i > 0 ? swLaps[i - 1] : 0));
      const bestSplit  = Math.min(...splits);
      const worstSplit = Math.max(...splits);
      const frag       = document.createDocumentFragment();

      for (let ri = swLaps.length - 1; ri >= 0; ri--) {
        const split = splits[ri];
        const row   = createEl('div', { className: 'nbc-lap-row' });

        const lapLabel  = createEl('span', { textContent: `Lap ${ri + 1}`, style: 'color:var(--text-secondary);' });
        const splitEl   = createEl('span', { textContent: fmtSw(split) });
        if (swLaps.length > 1) {
          if (split === bestSplit)  splitEl.className = 'nbc-lap-best';
          else if (split === worstSplit) splitEl.className = 'nbc-lap-worst';
        }
        const overallEl = createEl('span', { textContent: fmtSw(swLaps[ri]), style: 'color:var(--text-muted);font-size:12px;' });

        row.append(lapLabel, splitEl, overallEl);
        frag.appendChild(row);
      }

      swLapScroll.innerHTML = '';
      swLapScroll.appendChild(frag);
    }

    swStartBtn.addEventListener('click', () => {
      const st = syncClockState();
      if (st.stopwatch.running) {
        clockSvc?.pauseStopwatch?.();
      } else {
        clockSvc?.startStopwatch?.();
      }
      swSync();
      swStartBtn.textContent = swRun ? 'Stop'  : 'Start';
      swLapBtn.textContent   = swRun ? 'Lap'   : 'Reset';
      if (swRun) {
        swEnsureRaf();
      } else {
        swStopRaf();
        swDisplay.textContent = fmtSw(swCurrentMs());
      }
    });

    swLapBtn.addEventListener('click', () => {
      const st = syncClockState();
      if (st.stopwatch.running) {
        clockSvc?.lapStopwatch?.();
        swSync();
        renderSwLaps();
      } else {
        clockSvc?.resetStopwatch?.();
        swStopRaf();
        swRun = false; swElapsed = 0; swStart = 0; swLaps = [];
        swLapScroll.innerHTML = '';
        swDisplay.textContent = '00:00.00';
        swStartBtn.textContent = 'Start';
        swLapBtn.textContent   = 'Lap';
      }
    });

    const mainInt = setInterval(() => {
      const st = syncClockState();

      tiRun  = !!st.timer.running;
      tiDone = !!st.timer.done;
      tiSet  = Math.max(0, Number(st.timer.presetMs) || 0);
      tiMs   = clockSvc?.timerMs?.()
        ?? (tiRun
          ? Math.max(0, Number(st.timer.endAt) - Date.now())
          : Math.max(0, Number(st.timer.remainingMs) || 0));

      if (tiRun || tiDone) {
        renderTiDisplay();
        renderTiBtns();
      }

      const swWasRun = swRun;
      swRun     = !!st.stopwatch.running;
      swElapsed = Math.max(0, Number(st.stopwatch.elapsedMs) || 0);
      swStart   = Math.max(0, Number(st.stopwatch.startedAt) || 0);
      if (Array.isArray(st.stopwatch.laps)) swLaps = st.stopwatch.laps.slice();

      if (swRun) {
        // Smooth redraw is driven by rAF; here we just make sure it's running
        // (e.g. when the stopwatch was started from elsewhere) and keep the
        // Start/Lap button labels accurate.
        swEnsureRaf();
        swStartBtn.textContent = 'Stop';
        swLapBtn.textContent   = 'Lap';
      } else if (swWasRun) {
        // Just stopped/paused elsewhere: final paint + cancel the loop.
        swStopRaf();
        swDisplay.textContent = fmtSw(swCurrentMs());
        swStartBtn.textContent = 'Start';
        swLapBtn.textContent   = 'Reset';
      }
    }, 250);

    state.cleanups?.push(() => {
      clearInterval(mainInt);
      clearInterval(clockInt);
      swStopRaf();
      _cancelBeep?.();
      _activeModal?.remove();
      _activeModal = null;
      if (_actx && _actx.state !== 'closed') _actx.close();
    });

    clockSvc?.ensureBooted?.();
    renderTiDisplay();
    renderTiBtns();
    swSync();
    swDisplay.textContent = fmtSw(swCurrentMs());
    renderSwLaps();
    switchTab('clock');
  }

  main().catch((err) => {
    console.error('[Clock] Fatal startup error:', err);
    content.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-family:var(--font-ui);color:var(--text-muted);">Clock failed to start.</div>';
  });
})();
