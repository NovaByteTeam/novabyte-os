'use strict';

// system-events.js — keyboard, notification-panel, and easter-egg handlers.

// Frozen direction map for the snake game. Built once, never rebuilt per keypress.
const _SNAKE_DIR_MAP = Object.freeze({
  ArrowUp:    { x: 0, y: -1 }, w: { x: 0, y: -1 }, W: { x: 0, y: -1 },
  ArrowDown:  { x: 0, y:  1 }, s: { x: 0, y:  1 }, S: { x: 0, y:  1 },
  ArrowLeft:  { x: -1, y: 0 }, a: { x: -1, y: 0 }, A: { x: -1, y: 0 },
  ArrowRight: { x:  1, y: 0 }, d: { x:  1, y: 0 }, D: { x:  1, y: 0 },
});

// The built-in launcher owns launchpad behavior.

// NOTIFICATION PANEL

document.getElementById('notification-panel')?.addEventListener('click', (e) => {
  if (e.target.id !== 'notification-panel') return;
  e.currentTarget.classList.remove('active');
  resetShellScrollTwice();
});

document.getElementById('tray-bell')?.addEventListener('click', Notify.togglePanel);

document.getElementById('notif-close')?.addEventListener('click', () => {
  document.getElementById('notification-panel')?.classList.remove('active');
  resetShellScrollTwice();
});

document.getElementById('notif-mark-all')?.addEventListener('click', () => {
  // Notify.clearAll() preserves pinned entries (like "running in background");
  // bypassing it by assigning OS.notifications = [] would wipe those too and
  // leave a background app running with no way to stop it.
  Notify.clearAll();
  // clearAll() updates Notify's own badge but not this file's separate tray
  // badge element, so call that here too.
  updateNotificationBadge();
});

document.getElementById('notif-mark-read')?.addEventListener('click', () => {
  Notify.markAllRead();
  updateNotificationBadge();
});

function resetShellScrollTwice() {
  if (typeof window.resetShellScroll !== 'function') return;
  window.resetShellScroll();
  requestAnimationFrame(window.resetShellScroll);
}

function updateNotificationBadge() {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  const unread = (OS.notifications || []).filter(n => !n.read).length;
  if (unread > 0) {
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

Notify.loadPersisted();
Notify.renderPanel();
Notify.updateBadge();
updateNotificationBadge();

// WINDOW RESIZE

window.addEventListener('resize', throttleRAF(() => {
  if (!OS.windows) return;
  for (const state of OS.windows.values()) {
    if (state.maximized) {
      const area = WM.getWorkArea();
      state.x = area.left; state.y = area.top;
      state.width = area.width; state.height = area.height;
      state.element.style.left = area.left + 'px';
      state.element.style.top = area.top + 'px';
      state.element.style.width = area.width + 'px';
      state.element.style.height = area.height + 'px';
    } else {
      const next = WM.clampWindowRect(state, state.x, state.y, state.width, state.height);
      state.x = next.x; state.y = next.y; state.width = next.w; state.height = next.h;
      state.element.style.left = next.x + 'px';
      state.element.style.top = next.y + 'px';
      state.element.style.width = next.w + 'px';
      state.element.style.height = next.h + 'px';
    }
  }
  WM.hideSnapPreview();
}));

// Desktop interactions are owned by the bundled launcher.

// KEYBOARD SHORTCUTS

document.addEventListener('keydown', (e) => {
  const focused = document.activeElement;
  const inAppContent = focused?.closest?.('.window-content');
  const alwaysAllow =
    (e.altKey && (e.key === 'F4' || e.key === 'Tab')) ||
    e.key === 'Escape' || e.key === 'PrintScreen';

  // Don't hijack editor-style shortcuts when the user is typing inside an app.
  if (inAppContent && !alwaysAllow) {
    const conflicting = (e.ctrlKey || e.metaKey) && [
      'l', 'L', 'e', 'E', 'd', 'D', 'c', 'C', 'u', 'U', 'a', 'A',
      ' ', 'ArrowLeft', 'ArrowRight'
    ].includes(e.key);
    if (conflicting) return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key === 'e') { e.preventDefault(); WM.createWindow('com.nbosp.files'); }
  if ((e.metaKey || e.ctrlKey) && e.altKey && e.key === 't') { e.preventDefault(); WM.createWindow('com.nbosp.terminal'); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'l') { e.preventDefault(); window.LockScreenService.lockScreen(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'd') { e.preventDefault(); WM.minimizeAll(); }
  if (e.key === 'PrintScreen' && !e.altKey) { e.preventDefault(); window.ScreenshotService.capture('desktop'); }
  if (e.altKey && e.key === 'PrintScreen') { e.preventDefault(); window.ScreenshotService.capture('window'); }
  if ((e.key === 's' || e.key === 'S') && (e.metaKey || e.ctrlKey) && e.shiftKey) {
    e.preventDefault(); window.ScreenshotService.capture('region');
  }
  if (e.altKey && e.key === 'F4') {
    e.preventDefault();
    if (OS.focusedWindowId) WM.closeWindow(OS.focusedWindowId);
  }
  if (e.altKey && e.key === 'Tab') { e.preventDefault(); window.LauncherShell?.showAppSwitcher(); }

  if (e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    window.LauncherShell?.switchWorkspace(e.key === 'ArrowRight' ? 1 : -1);
  }

  if (e.key === 'Escape') {
    ContextMenu.hide();
  }

  // F3 toggles the debug overlay only; devMode setting is unchanged.
  if (e.key === 'F3') {
    e.preventDefault();
    window.DebugOverlay?.toggle?.();
  }

  // Ctrl+Shift+D copies the debug overlay text to the clipboard.
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    if (window.DebugOverlay?._copyDebugInfo) {
      window.DebugOverlay._copyDebugInfo();
      Notify.show({ title: 'Debug Info Copied', body: 'Overlay text copied to clipboard', type: 'success' });
    }
  }
});

// SNAKE GAME — Easter egg (click NovaByte version label 7× in About)

function launchSnakeGame() {
  if (document.getElementById('snake-game-overlay')) return;

  const COLS = 20, ROWS = 20, CELL = 18;
  const W = COLS * CELL, H = ROWS * CELL;

  const overlay = createEl('div', {
    id: 'snake-game-overlay',
    style: 'position:fixed;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:99999;'
  });
  const win = createEl('div', {
    style: 'background:rgba(10,14,22,0.96);border:1px solid rgba(255,255,255,0.18);border-radius:16px;box-shadow:0 32px 64px rgba(0,0,0,0.6);overflow:hidden;user-select:none;'
  });

  const titleBar = createEl('div', {
    style: 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(255,255,255,0.04);border-bottom:1px solid rgba(255,255,255,0.08);'
  });
  const titleText = createEl('span', {
    textContent: '🐍 NovaByte Snake',
    style: 'font-size:13px;font-weight:600;color:var(--text-primary);'
  });
  const closeBtn = createEl('button', {
    textContent: '✕',
    'aria-label': 'Close',
    style: 'background:rgba(248,81,73,0.18);border:1px solid rgba(248,81,73,0.35);color:#f85149;border-radius:6px;width:24px;height:24px;font-size:11px;cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:center;'
  });
  titleBar.append(titleText, closeBtn);

  const scoreBar = createEl('div', {
    style: 'display:flex;align-items:center;justify-content:space-between;padding:6px 14px;background:rgba(0,0,0,0.2);font-size:12px;color:var(--text-secondary);'
  });
  const scoreLabel = createEl('span', { textContent: 'Score: 0' });
  const hintLabel = createEl('span', { textContent: 'Arrow keys / WASD', style: 'color:var(--text-muted);font-size:11px;' });
  scoreBar.append(scoreLabel, hintLabel);

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.style.display = 'block';
  canvas.setAttribute('aria-label', 'Snake game canvas');
  const ctx = canvas.getContext('2d');

  win.append(titleBar, scoreBar, canvas);
  overlay.appendChild(win);
  document.body.appendChild(overlay);

  let snake, dir, nextDir, food, score, gameLoop;
  const rand = (n) => Math.floor(Math.random() * n);

  function spawnFood() {
    let pos;
    do { pos = { x: rand(COLS), y: rand(ROWS) }; }
    while (snake.some(s => s.x === pos.x && s.y === pos.y));
    return pos;
  }

  function init() {
    const mid = { x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) };
    snake = [mid, { x: mid.x - 1, y: mid.y }, { x: mid.x - 2, y: mid.y }];
    dir = { x: 1, y: 0 };
    nextDir = { x: 1, y: 0 };
    food = spawnFood();
    score = 0;
    scoreLabel.textContent = 'Score: 0';
    canvas.parentElement?.querySelector('.snake-game-over')?.remove();
  }

  function draw() {
    ctx.fillStyle = '#07090f';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 0.5;
    for (let c = 0; c <= COLS; c++) { ctx.beginPath(); ctx.moveTo(c * CELL, 0); ctx.lineTo(c * CELL, H); ctx.stroke(); }
    for (let r = 0; r <= ROWS; r++) { ctx.beginPath(); ctx.moveTo(0, r * CELL); ctx.lineTo(W, r * CELL); ctx.stroke(); }

    const fx = food.x * CELL + CELL / 2, fy = food.y * CELL + CELL / 2, fr = CELL / 2 - 2;
    const foodGrad = ctx.createRadialGradient(fx - 2, fy - 2, 1, fx, fy, fr);
    foodGrad.addColorStop(0, '#ff6e6e');
    foodGrad.addColorStop(1, '#f85149');
    ctx.fillStyle = foodGrad;
    ctx.beginPath(); ctx.arc(fx, fy, fr, 0, Math.PI * 2); ctx.fill();

    snake.forEach((seg, i) => {
      const x = seg.x * CELL + 1, y = seg.y * CELL + 1, s = CELL - 2;
      const t = i / (snake.length - 1 || 1);
      const r = Math.round(88 + (63 - 88) * t);
      const g = Math.round(166 + (190 - 166) * t);
      const b = Math.round(255 + (90 - 255) * t);
      ctx.fillStyle = i === 0 ? '#79b8ff' : `rgb(${r},${g},${b})`;
      ctx.beginPath(); ctx.roundRect(x, y, s, s, i === 0 ? 5 : 3); ctx.fill();
      if (i === 0) {
        ctx.fillStyle = '#07090f';
        const ex = x + (dir.x >= 0 ? s - 4 : 3);
        const ey = y + (dir.y >= 0 ? 3 : s - 4);
        ctx.beginPath(); ctx.arc(ex, ey, 2, 0, Math.PI * 2); ctx.fill();
      }
    });
  }

  function gameOver() {
    if (gameLoop) { clearInterval(gameLoop); gameLoop = null; }
    const goDiv = createEl('div', { className: 'snake-game-over' });
    const goTitle = createEl('div', { className: 'snake-game-over-title', textContent: 'Game Over' });
    const goScore = createEl('div', { className: 'snake-game-over-score', textContent: `Score: ${score}` });
    const goBtn = createEl('button', { className: 'snake-restart-btn', textContent: '↺ Play Again' });
    goBtn.addEventListener('click', () => { goDiv.remove(); startGame(); });
    goDiv.append(goTitle, goScore, goBtn);
    const wrap = canvas.parentElement;
    if (wrap) { wrap.style.position = 'relative'; wrap.appendChild(goDiv); }
  }

  function step() {
    dir = { ...nextDir };
    const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) { gameOver(); return; }
    if (snake.some(s => s.x === head.x && s.y === head.y)) { gameOver(); return; }
    snake.unshift(head);
    if (head.x === food.x && head.y === food.y) {
      score++;
      scoreLabel.textContent = `Score: ${score}`;
      food = spawnFood();
    } else {
      snake.pop();
    }
    draw();
  }

  function startGame() {
    // Defensive: if a previous loop somehow survived (e.g. a startGame call
    // without a gameOver), clear it before starting a new one so we don't
    // end up with two intervals stepping the same snake.
    if (gameLoop) clearInterval(gameLoop);
    init();
    draw();
    gameLoop = setInterval(step, 120);
  }

  function onKey(e) {
    // _SNAKE_DIR_MAP is a module-level frozen constant — zero allocation per keypress.
    const nd = _SNAKE_DIR_MAP[e.key];
    if (nd && !(nd.x === -dir.x && nd.y === -dir.y)) {
      e.preventDefault();
      nextDir = nd;
    }
  }

  document.addEventListener('keydown', onKey);

  // Single cleanup path: clear the loop and drop the keydown listener, then
  // remove the overlay. Both close paths (button + backdrop click) use it.
  const cleanup = () => {
    if (gameLoop) { clearInterval(gameLoop); gameLoop = null; }
    document.removeEventListener('keydown', onKey);
  };
  closeBtn.addEventListener('click', () => { cleanup(); overlay.remove(); });
  overlay.addEventListener('click', e => {
    if (e.target === overlay) { cleanup(); overlay.remove(); }
  });

  startGame();
}

// BACKGROUND EMAIL BOOTSTRAP — silent startup sync.
// Wrapped in try/catch so a failure in the email service can't break the
// rest of the shell's boot wiring.
try {
  const bg = window.__NBOSP_BG = window.__NBOSP_BG || {};
  if (!bg.email?.__patchedStartup) {
    const svc = bg.email = bg.email || {};
    svc.__patchedStartup = true;
    svc.ensureBooted?.();
  }
} catch { /* email service unavailable — silent */ }

OS.events?.on?.('settings:changed', ({ key }) => {
  if (key !== 'devMode') return;
  if (document.getElementById('launchpad')?.classList.contains('active')) renderLaunchpad();
  WM?.updateTaskbar?.();
});
