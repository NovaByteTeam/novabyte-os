registerApp({
  id: 'com.nbosp.easter-egg',
  name: 'NovaByte Easter Egg',
  icon: 'star',
  version: '3.0.2',
  description: 'A hidden NovaByte Snake game.',
  defaultSize: [420, 470],
  minSize: [380, 420],

  onClose(state) {
    state.cleanup?.();
    state.cleanup = null;
  },

  init(content, state) {
    const columns = 20;
    const rows = 20;
    const cell = 18;
    const width = columns * cell;
    const height = rows * cell;
    const directions = Object.freeze({
      ArrowUp: { x: 0, y: -1 }, w: { x: 0, y: -1 }, W: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 }, s: { x: 0, y: 1 }, S: { x: 0, y: 1 },
      ArrowLeft: { x: -1, y: 0 }, a: { x: -1, y: 0 }, A: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 }, d: { x: 1, y: 0 }, D: { x: 1, y: 0 },
    });

    content.style.cssText = 'height:100%;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:radial-gradient(ellipse at top,#17243a 0%,var(--bg-base,#0d1117) 70%);';
    const panel = document.createElement('section');
    panel.tabIndex = 0;
    panel.setAttribute('aria-label', 'NovaByte Snake game');
    panel.style.cssText = 'width:min(100%,380px);padding:12px;background:rgba(10,14,22,0.96);border:1px solid var(--border-default,rgba(255,255,255,0.18));border-radius:16px;box-shadow:0 20px 48px rgba(0,0,0,0.45);outline:none;user-select:none;';

    const heading = document.createElement('h1');
    heading.textContent = '🐍 NovaByte Easter Egg';
    heading.style.cssText = 'margin:0 0 10px;font-size:15px;font-weight:650;color:var(--text-primary,#e6edf3);';
    const scoreLabel = document.createElement('div');
    scoreLabel.textContent = 'Score: 0';
    scoreLabel.style.cssText = 'margin-bottom:8px;font-size:12px;color:var(--text-secondary,#c9d1d9);';
    const board = document.createElement('canvas');
    board.width = width;
    board.height = height;
    board.setAttribute('aria-label', 'Snake game board');
    board.style.cssText = 'display:block;width:min(100%,360px);height:auto;margin:0 auto;background:#07090f;border-radius:8px;';
    const hint = document.createElement('p');
    hint.textContent = 'Use the arrow keys or WASD to move.';
    hint.style.cssText = 'margin:10px 0 0;text-align:center;font-size:11px;color:var(--text-muted,#8b949e);';
    panel.append(heading, scoreLabel, board, hint);
    content.replaceChildren(panel);

    const context = board.getContext('2d');
    if (!context) throw new Error('Canvas rendering is unavailable');

    let snake;
    let direction;
    let nextDirection;
    let food;
    let score;
    let gameLoop = null;
    let stopped = false;
    const randomCell = limit => Math.floor(Math.random() * limit);

    function spawnFood() {
      let position;
      do {
        position = { x: randomCell(columns), y: randomCell(rows) };
      } while (snake.some(segment => segment.x === position.x && segment.y === position.y));
      return position;
    }

    function resetGame() {
      const middle = { x: Math.floor(columns / 2), y: Math.floor(rows / 2) };
      snake = [middle, { x: middle.x - 1, y: middle.y }, { x: middle.x - 2, y: middle.y }];
      direction = { x: 1, y: 0 };
      nextDirection = { x: 1, y: 0 };
      food = spawnFood();
      score = 0;
      scoreLabel.textContent = 'Score: 0';
    }

    function draw() {
      context.fillStyle = '#07090f';
      context.fillRect(0, 0, width, height);
      context.strokeStyle = 'rgba(255,255,255,0.035)';
      context.lineWidth = 0.5;
      for (let column = 0; column <= columns; column++) {
        context.beginPath();
        context.moveTo(column * cell, 0);
        context.lineTo(column * cell, height);
        context.stroke();
      }
      for (let row = 0; row <= rows; row++) {
        context.beginPath();
        context.moveTo(0, row * cell);
        context.lineTo(width, row * cell);
        context.stroke();
      }

      const foodX = food.x * cell + cell / 2;
      const foodY = food.y * cell + cell / 2;
      const foodGradient = context.createRadialGradient(foodX - 2, foodY - 2, 1, foodX, foodY, cell / 2 - 2);
      foodGradient.addColorStop(0, '#ff6e6e');
      foodGradient.addColorStop(1, '#f85149');
      context.fillStyle = foodGradient;
      context.beginPath();
      context.arc(foodX, foodY, cell / 2 - 2, 0, Math.PI * 2);
      context.fill();

      snake.forEach((segment, index) => {
        const x = segment.x * cell + 1;
        const y = segment.y * cell + 1;
        const size = cell - 2;
        const ratio = index / (snake.length - 1 || 1);
        const red = Math.round(88 + (63 - 88) * ratio);
        const green = Math.round(166 + (190 - 166) * ratio);
        const blue = Math.round(255 + (90 - 255) * ratio);
        context.fillStyle = index === 0 ? '#79b8ff' : `rgb(${red},${green},${blue})`;
        context.beginPath();
        context.roundRect(x, y, size, size, index === 0 ? 5 : 3);
        context.fill();
        if (index === 0) {
          context.fillStyle = '#07090f';
          const eyeX = x + (direction.x >= 0 ? size - 4 : 3);
          const eyeY = y + (direction.y >= 0 ? 3 : size - 4);
          context.beginPath();
          context.arc(eyeX, eyeY, 2, 0, Math.PI * 2);
          context.fill();
        }
      });
    }

    function gameOver() {
      if (gameLoop) clearInterval(gameLoop);
      gameLoop = null;
      hint.textContent = `Game over — score: ${score}. Press Space to play again.`;
    }

    function step() {
      direction = { ...nextDirection };
      const head = { x: snake[0].x + direction.x, y: snake[0].y + direction.y };
      if (head.x < 0 || head.x >= columns || head.y < 0 || head.y >= rows
        || snake.some(segment => segment.x === head.x && segment.y === head.y)) {
        gameOver();
        return;
      }
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
      if (gameLoop) clearInterval(gameLoop);
      resetGame();
      hint.textContent = 'Use the arrow keys or WASD to move.';
      draw();
      gameLoop = setInterval(step, 120);
    }

    function onKey(event) {
      if (event.code === 'Space' && !gameLoop) {
        event.preventDefault();
        startGame();
        return;
      }
      const next = directions[event.key];
      if (!next || (next.x === -direction.x && next.y === -direction.y)) return;
      event.preventDefault();
      nextDirection = next;
    }

    panel.addEventListener('keydown', onKey);
    state.cleanup = () => {
      if (stopped) return;
      stopped = true;
      if (gameLoop) clearInterval(gameLoop);
      gameLoop = null;
      panel.removeEventListener('keydown', onKey);
    };
    startGame();
    panel.focus();
  },
});
