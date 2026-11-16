(function () {
  'use strict';

  const directions = Object.freeze({
    ArrowUp: { x: 0, y: -1 }, w: { x: 0, y: -1 }, W: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 }, s: { x: 0, y: 1 }, S: { x: 0, y: 1 },
    ArrowLeft: { x: -1, y: 0 }, a: { x: -1, y: 0 }, A: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 }, d: { x: 1, y: 0 }, D: { x: 1, y: 0 },
  });

  function launchSnakeGame() {
    if (document.getElementById('snake-game-overlay')) return;

    // Styles ship with the service (self-contained since 2026-11-16 — this
    // block moved out of the hardcoded section of the global style.css).
    // Injected once per page; the overlay markup below consumes it.
    if (!document.getElementById('snake-game-styles')) {
      const style = document.createElement('style');
      style.id = 'snake-game-styles';
      style.textContent = '/* ---- Snake game (Easter egg) ----------------------------------------- */\n.snake-modal-overlay {\n  position: fixed;\n  top: 0;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  background: rgba(0, 0, 0, 0.75);\n  backdrop-filter: blur(4px);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  z-index: 100000;\n  animation: fadeIn 0.2s ease-out;\n}\n.snake-modal {\n  background: var(--bg-elevated);\n  border: 1px solid var(--border);\n  border-radius: 16px;\n  padding: 24px;\n  max-width: 500px;\n  width: 90vw;\n  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);\n  animation: snakeSlideUp 0.25s ease-out;\n}\n@keyframes snakeSlideUp {\n  from { transform: translateY(20px); opacity: 0; }\n  to   { transform: translateY(0);    opacity: 1; }\n}\n.snake-header {\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  margin-bottom: 16px;\n}\n.snake-title {\n  font-size: 18px;\n  font-weight: 700;\n  color: var(--text-primary);\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n.snake-close {\n  background: none;\n  border: none;\n  color: var(--text-muted);\n  font-size: 24px;\n  cursor: pointer;\n  padding: 4px 8px;\n  border-radius: 6px;\n  transition: background 0.15s, color 0.15s;\n  line-height: 1;\n}\n.snake-close:hover {\n  background: var(--bg-hover);\n  color: var(--text-primary);\n}\n.snake-score-board {\n  display: flex;\n  justify-content: space-between;\n  font-size: 12px;\n  color: var(--text-secondary);\n  margin-bottom: 12px;\n  padding: 10px 14px;\n  background: var(--bg-sunken);\n  border-radius: 8px;\n}\n.snake-score-value {\n  font-weight: 700;\n  color: var(--accent);\n  font-family: monospace;\n  font-size: 14px;\n}\n.snake-canvas-container {\n  display: flex;\n  justify-content: center;\n  margin-bottom: 12px;\n}\n.snake-canvas {\n  border: 2px solid var(--border);\n  border-radius: 8px;\n  background: rgba(0, 0, 0, 0.3);\n  image-rendering: pixelated;\n}\n.snake-controls {\n  text-align: center;\n  font-size: 11px;\n  color: var(--text-muted);\n}\n.snake-controls kbd {\n  background: var(--bg-elevated);\n  border: 1px solid var(--border);\n  padding: 2px 6px;\n  border-radius: 4px;\n  font-family: system-ui, sans-serif;\n  font-size: 10px;\n}\n.snake-game-over {\n  position: absolute;\n  top: 50%;\n  left: 50%;\n  transform: translate(-50%, -50%);\n  background: rgba(0, 0, 0, 0.85);\n  padding: 20px 30px;\n  border-radius: 12px;\n  text-align: center;\n  color: var(--text-primary);\n  border: 1px solid var(--border);\n}\n.snake-game-over-title {\n  font-size: 16px;\n  font-weight: 700;\n  margin-bottom: 8px;\n  color: var(--text-danger);\n}\n.snake-game-over-score {\n  font-size: 13px;\n  color: var(--text-secondary);\n  margin-bottom: 12px;\n}\n.snake-restart-btn {\n  background: var(--accent);\n  color: var(--text-on-accent);\n  border: none;\n  padding: 8px 16px;\n  border-radius: 6px;\n  font-size: 12px;\n  font-weight: 600;\n  cursor: pointer;\n  transition: opacity 0.15s;\n}\n.snake-restart-btn:hover {\n  opacity: 0.9;\n}\n\n/* Local copy of the shared fadeIn keyframe — keeps this block self-contained. */\n@keyframes fadeIn {\n  from { opacity: 0; }\n  to   { opacity: 1; }\n}\n';
      document.head.appendChild(style);
    }

    const COLS = 20, ROWS = 20, CELL = 18;
    const W = COLS * CELL, H = ROWS * CELL;

    const overlay = createEl('div', {
      id: 'snake-game-overlay',
      style: 'position:fixed;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:99999;'
    });
    const win = createEl('div', {
      style: 'background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:16px;box-shadow:var(--shadow-lg);overflow:hidden;user-select:none;'
    });

    const titleBar = createEl('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--bg-hover);border-bottom:1px solid var(--border-subtle);'
    });
    const titleText = createEl('span', {
      textContent: '🐍 NovaByte Snake',
      style: 'font-size:13px;font-weight:600;color:var(--text-primary);'
    });
    const closeBtn = createEl('button', {
      textContent: '✕',
      'aria-label': _t('common.close'),
      style: 'background:color-mix(in srgb,var(--text-danger) 18%,transparent);border:1px solid color-mix(in srgb,var(--text-danger) 35%,transparent);color:var(--text-danger);border-radius:6px;width:24px;height:24px;font-size:11px;cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:center;'
    });
    titleBar.append(titleText, closeBtn);

    const scoreBar = createEl('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;padding:6px 14px;background:var(--bg-sunken);font-size:12px;color:var(--text-secondary);'
    });
    const scoreLabel = createEl('span', { textContent: _t('apps.easterEgg.score', { score: 0 }) });
    const hintLabel = createEl('span', { textContent: _t('apps.easterEgg.controlsHint'), style: 'color:var(--text-muted);font-size:11px;' });
    scoreBar.append(scoreLabel, hintLabel);

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.style.display = 'block';
    canvas.setAttribute('aria-label', _t('apps.easterEgg.canvasAria'));
    const ctx = canvas.getContext('2d');

    win.append(titleBar, scoreBar, canvas);
    overlay.appendChild(win);
    document.body.appendChild(overlay);

    let snake, dir, nextDir, food, score, gameLoop;
    const rand = n => Math.floor(Math.random() * n);

    function spawnFood() {
      let pos;
      do { pos = { x: rand(COLS), y: rand(ROWS) }; }
      while (snake.some(segment => segment.x === pos.x && segment.y === pos.y));
      return pos;
    }

    function init() {
      const mid = { x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) };
      snake = [mid, { x: mid.x - 1, y: mid.y }, { x: mid.x - 2, y: mid.y }];
      dir = { x: 1, y: 0 };
      nextDir = { x: 1, y: 0 };
      food = spawnFood();
      score = 0;
      scoreLabel.textContent = _t('apps.easterEgg.score', { score: 0 });
      canvas.parentElement?.querySelector('.snake-game-over')?.remove();
    }

    function draw() {
      ctx.fillStyle = '#07090f';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(255,255,255,0.035)';
      ctx.lineWidth = 0.5;
      for (let column = 0; column <= COLS; column++) {
        ctx.beginPath(); ctx.moveTo(column * CELL, 0); ctx.lineTo(column * CELL, H); ctx.stroke();
      }
      for (let row = 0; row <= ROWS; row++) {
        ctx.beginPath(); ctx.moveTo(0, row * CELL); ctx.lineTo(W, row * CELL); ctx.stroke();
      }

      const fx = food.x * CELL + CELL / 2;
      const fy = food.y * CELL + CELL / 2;
      const fr = CELL / 2 - 2;
      const foodGrad = ctx.createRadialGradient(fx - 2, fy - 2, 1, fx, fy, fr);
      foodGrad.addColorStop(0, '#ff6e6e');
      foodGrad.addColorStop(1, '#f85149');
      ctx.fillStyle = foodGrad;
      ctx.beginPath(); ctx.arc(fx, fy, fr, 0, Math.PI * 2); ctx.fill();

      snake.forEach((segment, index) => {
        const x = segment.x * CELL + 1, y = segment.y * CELL + 1, size = CELL - 2;
        const ratio = index / (snake.length - 1 || 1);
        const red = Math.round(88 + (63 - 88) * ratio);
        const green = Math.round(166 + (190 - 166) * ratio);
        const blue = Math.round(255 + (90 - 255) * ratio);
        ctx.fillStyle = index === 0 ? '#79b8ff' : `rgb(${red},${green},${blue})`;
        ctx.beginPath(); ctx.roundRect(x, y, size, size, index === 0 ? 5 : 3); ctx.fill();
        if (index === 0) {
          ctx.fillStyle = '#07090f';
          const eyeX = x + (dir.x >= 0 ? size - 4 : 3);
          const eyeY = y + (dir.y >= 0 ? 3 : size - 4);
          ctx.beginPath(); ctx.arc(eyeX, eyeY, 2, 0, Math.PI * 2); ctx.fill();
        }
      });
    }

    function gameOver() {
      // only ever called from step() while the loop is running
      /* v8 ignore start */
      if (gameLoop) { clearInterval(gameLoop); gameLoop = null; }
      /* v8 ignore stop */
      const gameOverElement = createEl('div', { className: 'snake-game-over' });
      const title = createEl('div', { className: 'snake-game-over-title', textContent: _t('apps.easterEgg.gameOver') });
      const finalScore = createEl('div', { className: 'snake-game-over-score', textContent: _t('apps.easterEgg.score', { score }) });
      const restart = createEl('button', { className: 'snake-restart-btn', textContent: _t('apps.easterEgg.playAgain') });
      restart.addEventListener('click', () => { gameOverElement.remove(); startGame(); });
      gameOverElement.append(title, finalScore, restart);
      const wrap = canvas.parentElement;
      // canvas is always parented before gameOver() can run
      /* v8 ignore start */
      if (wrap) { wrap.style.position = 'relative'; wrap.appendChild(gameOverElement); }
      /* v8 ignore stop */
    }

    function step() {
      dir = { ...nextDir };
      const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
      if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS
        || snake.some(segment => segment.x === head.x && segment.y === head.y)) {
        gameOver();
        return;
      }
      snake.unshift(head);
      if (head.x === food.x && head.y === food.y) {
        score++;
        scoreLabel.textContent = _t('apps.easterEgg.score', { score });
        food = spawnFood();
      } else {
        snake.pop();
      }
      draw();
    }

    function startGame() {
      // callers only invoke startGame with the loop stopped (launch/restart)
      /* v8 ignore start */
      if (gameLoop) clearInterval(gameLoop);
      /* v8 ignore stop */
      init();
      draw();
      gameLoop = setInterval(step, 120);
    }

    function onKey(event) {
      const next = directions[event.key];
      if (next && !(next.x === -dir.x && next.y === -dir.y)) {
        event.preventDefault();
        nextDir = next;
      }
    }

    document.addEventListener('keydown', onKey);

    // Live re-localisation — relabel the running game overlay in place when
    // the OS language changes. The game state, score and any half-typed
    // input are untouched; a visible game-over panel is relabelled rather
    // than rebuilt so its restart handler stays attached.
    const localeHandler = () => {
      try {
        window.NovaI18n?.applyStaticDom?.(overlay);
        closeBtn.setAttribute('aria-label', _t('common.close'));
        hintLabel.textContent = _t('apps.easterEgg.controlsHint');
        canvas.setAttribute('aria-label', _t('apps.easterEgg.canvasAria'));
        scoreLabel.textContent = _t('apps.easterEgg.score', { score });
        const overTitle = overlay.querySelector('.snake-game-over-title');
        if (overTitle) overTitle.textContent = _t('apps.easterEgg.gameOver');
        const overScore = overlay.querySelector('.snake-game-over-score');
        if (overScore) overScore.textContent = _t('apps.easterEgg.score', { score });
        const restartBtn = overlay.querySelector('.snake-restart-btn');
        if (restartBtn) restartBtn.textContent = _t('apps.easterEgg.playAgain');
      } catch (error) {
        console.warn('[EasterEgg] Language change re-render failed:', error);
      }
    };
    if (typeof OS !== 'undefined' && OS.events?.on) {
      typeof OS !== 'undefined' && OS.events.on('languageChanged', localeHandler);
    }

    const cleanup = () => {
      if (gameLoop) { clearInterval(gameLoop); gameLoop = null; }
      document.removeEventListener('keydown', onKey);
      if (typeof OS !== 'undefined' && OS.events?.off) {
        typeof OS !== 'undefined' && OS.events.off('languageChanged', localeHandler);
      }
    };
    closeBtn.addEventListener('click', () => { cleanup(); overlay.remove(); });
    overlay.addEventListener('click', event => {
      if (event.target === overlay) { cleanup(); overlay.remove(); }
    });

    startGame();
  }

  window.NovaByteEasterEgg = Object.freeze({ launch: launchSnakeGame });
})();
