// tests/apps/easter-egg.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/easter-egg/service.js (the hidden
// Snake game). The real service is require()d against a real JSDOM window
// (cover-loader), the canvas 2d context is a self-chaining proxy (jsdom has
// no canvas package), and the game is driven deterministically: fake timers
// tick the 120ms game loop, and Math.random is scripted so the first food
// spawns directly in the snake's path — making eat / respawn / wall-death /
// restart reachable without flakiness.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { coverLoadServiceApp } from '../helpers/cover-loader.js';

// jsdom's canvas getContext() returns null without the `canvas` npm package.
// The game only writes to the 2d context and reads nothing back, so a
// self-chaining proxy is a faithful stand-in.
function installFake2dContext(window) {
  window.HTMLCanvasElement.prototype.getContext = function () {
    const proxy = new Proxy({}, {
      get: () => (...args) => proxy,
      set: () => true,
    });
    return proxy;
  };
}

// Scripted food placement. The first draw lands ON the snake's head (10,10)
// so spawnFood's reject-and-retry loop runs, the second lands at (13,10) —
// straight ahead of the snake that starts at (10,10) heading right — and
// every later draw goes to (0,0), off the path so the snake reaches the wall.
function scriptFood() {
  const seq = [0.51, 0.51, 0.66, 0.51, 0.01, 0.01];
  let i = 0;
  return vi.spyOn(Math, 'random').mockImplementation(() => seq[Math.min(i++, seq.length - 1)]);
}

async function mount(stubs = {}) {
  const ctx = await coverLoadServiceApp('easter-egg', { withBaseUtils: true, stubs });
  installFake2dContext(ctx.window);
  return ctx;
}

describe('NovaByteEasterEgg service (js/apps/easter-egg/service.js) — e2e coverage', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches a frozen NovaByteEasterEgg facade with only launch()', async () => {
    const { window } = await mount();
    const svc = window.NovaByteEasterEgg;
    expect(Object.isFrozen(svc)).toBe(true);
    expect(Object.keys(svc)).toEqual(['launch']);
    expect(typeof svc.launch).toBe('function');
  });

  it('launch() mounts the overlay, injects its stylesheet and starts the game', async () => {
    vi.useFakeTimers();
    const { window, document } = await mount();
    window.NovaByteEasterEgg.launch();
    const overlay = document.getElementById('snake-game-overlay');
    expect(overlay).toBeTruthy();
    expect(document.getElementById('snake-game-styles')).toBeTruthy();
    expect(overlay.textContent).toContain('🐍 NovaByte Snake');
    expect(overlay.textContent).toContain('Score: 0');
    const canvas = overlay.querySelector('canvas');
    expect(canvas.width).toBe(360);
    expect(canvas.height).toBe(360);
    // one game tick runs and draws without touching a real canvas
    await vi.advanceTimersByTimeAsync(125);
    // cleanup via the ✕ button
    overlay.querySelector('button[aria-label="Close"]').click();
    expect(document.getElementById('snake-game-overlay')).toBeNull();
    await vi.advanceTimersByTimeAsync(1000); // no further ticks after cleanup
  });

  it('is idempotent while the overlay is open and reuses the injected styles after close', async () => {
    vi.useFakeTimers();
    const { window, document } = await mount();
    window.NovaByteEasterEgg.launch();
    window.NovaByteEasterEgg.launch(); // overlay present → early return
    expect(document.querySelectorAll('#snake-game-overlay')).toHaveLength(1);

    document.querySelector('#snake-game-overlay button[aria-label="Close"]').click();
    expect(document.getElementById('snake-game-overlay')).toBeNull();
    expect(document.getElementById('snake-game-styles')).toBeTruthy(); // styles persist

    window.NovaByteEasterEgg.launch(); // relaunch: overlay gone, styles kept
    const overlay = document.getElementById('snake-game-overlay');
    expect(overlay).toBeTruthy();
    expect(document.querySelectorAll('#snake-game-styles')).toHaveLength(1); // not re-injected
    overlay.querySelector('button[aria-label="Close"]').click();
  });

  it('eats scripted food, scores, respawns it, then dies at the wall and restarts', async () => {
    vi.useFakeTimers();
    const { window, document } = await mount();
    const randomSpy = scriptFood(); // AFTER mount: jsdom setup also consumes Math.random
    window.NovaByteEasterEgg.launch();
    const overlay = document.getElementById('snake-game-overlay');
    const scoreText = () => overlay.textContent.match(/Score: (\d+)/)?.[1];

    // draw 1 (10,10) is rejected (on the snake); draw 2 (13,10) is placed.
    // 3 ticks: head moves from x=10 to x=13 where the food sits.
    await vi.advanceTimersByTimeAsync(3 * 120);
    expect(scoreText()).toBe('1');

    // keep ticking: no more food on the path, snake runs into the right wall
    await vi.advanceTimersByTimeAsync(10 * 120);
    const gameOver = overlay.querySelector('.snake-game-over');
    expect(gameOver).toBeTruthy();
    expect(gameOver.textContent).toContain('Game Over');

    // restart from the game-over panel: panel is removed, game re-inits
    gameOver.querySelector('.snake-restart-btn').click();
    expect(overlay.querySelector('.snake-game-over')).toBeNull();
    expect(scoreText()).toBe('0');
    expect(randomSpy).toHaveBeenCalled();

    // closing AFTER game over cleans up with the loop already stopped
    overlay.querySelector('button[aria-label="Close"]').click();
    expect(document.getElementById('snake-game-overlay')).toBeNull();
  });

  it('dies by biting its own tail after a tight U-turn', async () => {
    vi.useFakeTimers();
    const { window, document } = await mount();
    // food straight ahead once ((13,10)), then always far away ((0,0)) so the
    // respawn can't land on the head and loop forever
    const seq = [0.66, 0.51, 0.01, 0.01];
    let draw = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => seq[Math.min(draw++, seq.length - 1)]);
    window.NovaByteEasterEgg.launch();
    const overlay = document.getElementById('snake-game-overlay');
    const key = (k) => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

    await vi.advanceTimersByTimeAsync(3 * 120); // eat at (13,10)
    key('ArrowUp');    await vi.advanceTimersByTimeAsync(120); // dir up
    key('ArrowLeft');  await vi.advanceTimersByTimeAsync(120); // dir left
    key('ArrowDown');  await vi.advanceTimersByTimeAsync(120); // head bites the body → self-collision

    const panel = overlay.querySelector('.snake-game-over');
    expect(panel).toBeTruthy();
    expect(panel.textContent).toContain('Score: 1');
    overlay.querySelector('button[aria-label="Close"]').click();
  });

  it('steers with arrows and WASD, prevents scroll and blocks 180° reversals', async () => {
    vi.useFakeTimers();
    const { window, document } = await mount();
    window.NovaByteEasterEgg.launch();

    // The reversal guard compares against the last TICKED direction (dir),
    // which stays "right" until the loop ticks — so every check here is
    // against a snake heading right: Up/Down/Right/w/s/d legal, Left/a blocked.
    const key = (k) => {
      const ev = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      return ev;
    };
    expect(key('ArrowUp').defaultPrevented).toBe(true);    // 90° turn
    expect(key('ArrowDown').defaultPrevented).toBe(true);  // 90° turn
    expect(key('ArrowLeft').defaultPrevented).toBe(false); // reversal → ignored
    expect(key('ArrowRight').defaultPrevented).toBe(true); // same axis, legal
    expect(key('w').defaultPrevented).toBe(true);
    expect(key('W').defaultPrevented).toBe(true);
    expect(key('a').defaultPrevented).toBe(false);         // reversal → ignored
    expect(key('A').defaultPrevented).toBe(false);
    expect(key('s').defaultPrevented).toBe(true);
    expect(key('S').defaultPrevented).toBe(true);
    expect(key('d').defaultPrevented).toBe(true);
    expect(key('x').defaultPrevented).toBe(false);         // not a control key

    document.querySelector('#snake-game-overlay button[aria-label="Close"]').click();
  });

  it('closes via a click on the overlay backdrop', async () => {
    vi.useFakeTimers();
    const { window, document } = await mount();
    window.NovaByteEasterEgg.launch();
    const overlay = document.getElementById('snake-game-overlay');
    overlay.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('snake-game-overlay')).toBeNull();
  });

  it('relocalises the running game when the OS language changes', async () => {
    vi.useFakeTimers();
    const handlers = {};
    const onOff = { on: vi.fn((t, h) => { handlers[t] = h; }), off: vi.fn() };
    const { window, document } = await mount({ extra: { OS: { events: onOff } } });
    window.NovaByteEasterEgg.launch();
    const overlay = document.getElementById('snake-game-overlay');
    expect(onOff.on).toHaveBeenCalledWith('languageChanged', expect.any(Function));

    // with a game-over panel visible, every relabel branch runs
    await vi.advanceTimersByTimeAsync(14 * 120);
    expect(overlay.querySelector('.snake-game-over')).toBeTruthy();

    handlers.languageChanged();
    expect(overlay.querySelector('.snake-game-over-title').textContent).toBeTruthy();
    expect(overlay.querySelector('.snake-restart-btn').textContent).toBeTruthy();

    // without a game-over panel the relabel skips those nodes
    overlay.querySelector('.snake-restart-btn').click();
    handlers.languageChanged();

    // cleanup unregisters the handler
    overlay.querySelector('button[aria-label="Close"]').click();
    expect(onOff.off).toHaveBeenCalledWith('languageChanged', expect.any(Function));
  });

  it('relocalisation survives a broken i18n engine (catch path)', async () => {
    vi.useFakeTimers();
    const handlers = {};
    const onOff = { on: (t, h) => { handlers[t] = h; }, off: () => {} };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { window, document } = await mount({ extra: { OS: { events: onOff } } });
    window.NovaI18n.applyStaticDom = () => { throw new Error('boom'); };
    window.NovaByteEasterEgg.launch();
    handlers.languageChanged();
    expect(warn).toHaveBeenCalledWith('[EasterEgg] Language change re-render failed:', expect.any(Error));

    document.querySelector('#snake-game-overlay button[aria-label="Close"]').click();
  });

  it('runs without an OS event bus present', async () => {
    vi.useFakeTimers();
    delete globalThis.OS;
    const { window, document } = await mount(); // no OS stub at all
    window.NovaByteEasterEgg.launch();
    expect(document.getElementById('snake-game-overlay')).toBeTruthy();
    document.querySelector('#snake-game-overlay button[aria-label="Close"]').click();
    expect(document.getElementById('snake-game-overlay')).toBeNull();
  });
});
