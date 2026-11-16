// tests/apps/calculator.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/calculator/app.js.
// Loads the REAL app through the cover-loader (real JSDOM + require() in the
// Node realm) and drives it exactly like a user: buttons are clicked, the
// keyboard is used, the display updates, every operator, unary form, nested
// paren expression and error path is exercised.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { coverLoadWindowApp, settle } from '../helpers/cover-loader.js';

async function mount() {
  const ctx = await coverLoadWindowApp('calculator');
  const doc = ctx.document;
  const root = doc.getElementById('calculator-root');
  expect(root).toBeTruthy();
  const display = () => doc.querySelector('#calculator-display').value;
  const result = () => {
    const el = doc.querySelector('#calculator-root > div');
    return el ? el.textContent : '';
  };
  const press = (...keys) => {
    for (const key of keys) {
      let btn = doc.querySelector(`[data-key="${key}"]`);
      if (!btn) {
        // The click handler resolves ANY [data-key] descendant of the button
        // grid — inject a foreign button to drive the default append path
        // with characters the shipped layout has no key for.
        btn = doc.createElement('button');
        btn.dataset.key = key;
        doc.querySelector('#calculator-root > div:last-child').appendChild(btn);
      }
      btn.click();
    }
  };
  const key = (k) => {
    root.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  };
  return { ...ctx, root, display, result, press, key };
}

describe('Calculator app (js/apps/calculator/app.js) — e2e coverage', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.resetModules();
  });

  it('self-mounts into #calculator-root when the page loads', async () => {
    const { display, result } = await mount();
    expect(display()).toBe('');
    expect(result()).toBe('Ready');
  });

  it('treats "=" on an empty expression as a no-op', async () => {
    const { display, result, press } = await mount();
    press('=');
    expect(display()).toBe('');
    expect(result()).toBe('Ready');
  });

  it('evaluates live partial expressions while typing', async () => {
    const { display, result, press } = await mount();
    press('7', '+', '3');
    expect(display()).toBe('7+3');
    expect(result()).toBe('= 10');
  });

  it('computes every binary operator: + − × ÷ %', async () => {
    const { display, result, press } = await mount();
    press('7', '+', '3', '=');  expect(display()).toBe('10');

    press('C', '9', '−', '4', '=');  expect(display()).toBe('5');

    press('C', '6', '×', '7', '=');  expect(display()).toBe('42');

    press('C', '8', '÷', '2', '=');  expect(display()).toBe('4');

    press('C', '7', '%', '3', '=');  expect(display()).toBe('1');
  });

  it('parses decimals, unary +/-, nested parens and chained operators', async () => {
    const { display, press } = await mount();
    press('5', '.', '5', '+', '1', '=');  expect(display()).toBe('6.5');

    press('C', '−', '5', '+', '3', '=');  expect(display()).toBe('-2');

    press('C', '+', '5', '=');  expect(display()).toBe('5');

    press('C', '−', '−', '5', '=');  expect(display()).toBe('5');

    press('C', '(', '(', '5', ')', ')', '=');  expect(display()).toBe('5');

    press('C', '2', '×', '−', '3', '=');  expect(display()).toBe('-6');

    press('C', '1', '+', '2', '×', '3', '=');  expect(display()).toBe('7');

    press('C', '.', '5', '=');  expect(display()).toBe('0.5');
  });

  it('shows error results for invalid, non-finite and truncated expressions', async () => {
    const { result, press } = await mount();
    press('1', '.', '2', '.');  expect(result()).toBe('= Error: Invalid expression');
    press('=', ');');  expect(result()).toBe('= Error: Invalid expression');
    press('C', '(', '1', '+', '2', '=');  expect(result()).toBe('= Error: Invalid expression');
    press('C', '5', '÷', '0', '=');  expect(result()).toBe('= Error: Invalid expression');
    press('C', '0', '÷', '0', '=');  expect(result()).toBe('= Error: Invalid expression');
    press('C', '−', '=');  expect(result()).toBe('= Error: Invalid expression');
    press('C', '5', '%', '=');  expect(result()).toBe('= Error: Invalid expression');
    press('C', '(', ')', '=');  expect(result()).toBe('= Error: Invalid expression');
  });

  it('restarts the expression when a digit follows "=", continues when an operator follows', async () => {
    const { display, press } = await mount();
    press('2', '+', '2', '=');
    expect(display()).toBe('4');
    press('5');
    expect(display()).toBe('5'); // digit after result → fresh expression
    press('×', '2', '=');
    expect(display()).toBe('10');
    press('C', '2', '=', '+', '1', '=');
    expect(display()).toBe('3'); // operator after result → keeps going
  });

  it('clears with C / Escape and deletes with ⌫ / Backspace', async () => {
    const { display, result, press, key } = await mount();
    press('1', '2', '3');
    press('⌫');
    expect(display()).toBe('12');
    press('⌫', '⌫', '⌫');
    expect(display()).toBe('');
    expect(result()).toBe('Ready');
    press('9');
    press('C');
    expect(display()).toBe('');

    press('8');
    key('Backspace');
    expect(display()).toBe('');
    key('Escape');
    expect(display()).toBe('');
  });

  it('supports full keyboard input including translated operators', async () => {
    const { display, key } = await mount();
    for (const k of ['1', '2', '+', '3', '*', '4']) key(k);
    expect(display()).toBe('12+3×4');
    key('Enter');
    expect(display()).toBe('24');

    key('='); // second equals path with prior result
    key('%'); // percent via keyboard
    key('('); key(')');
    key('.'); key('0'); key('-'); key('−'); key('/');
    key('a'); // unhandled key → ignored
    key('Backspace');
    key('Escape');
    expect(display()).toBe('');
  });

  it('ignores whitespace inside expressions (foreign data-key button)', async () => {
    const { display, result, press } = await mount();
    press('1', ' ', '+', ' ', '2', '=');
    expect(display()).toBe('3');
    expect(result()).toBe('= 3');
  });

  it('rejects trailing garbage after a complete expression', async () => {
    const { result, press } = await mount();
    press('1', ' ', '2', '='); // "1 2" parses 1, leaves "2" unconsumed
    expect(result()).toBe('= Error: Invalid expression');
  });

  it('rejects expressions nested deeper than the parser depth limit', async () => {
    const { result, key } = await mount();
    // Only unary +/- increments parser recursion depth, so a chain of 1002
    // consecutive minus signs blows past the depth-1000 guard.
    for (let i = 0; i < 1002; i++) key('-');
    key('1');
    key('Enter');
    expect(result()).toBe('= Error: Invalid expression');
  });

  it('throws loudly when #calculator-root is missing from the host page', async () => {
    const { requireFresh } = await import('../helpers/cover-loader.js');
    const { JSDOM } = await import('jsdom');
    const { installCommonStubs } = await import('../helpers/app-harness.js');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://localhost/blank',
    });
    installCommonStubs(dom.window, {});
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    expect(() => requireFresh('js/apps/calculator/app.js')).toThrow('Calculator root element is missing');
  });

  it('press visual feedback releases on pointerup, pointercancel and pointerleave', async () => {
    const { root, document: doc } = await mount();
    const grid = root.querySelector('div:last-child');
    const btn = grid.querySelector('[data-key="7"]');

    // clicking the grid background (no [data-key] ancestor) is a no-op
    grid.click();

    btn.dispatchEvent(new ctxPointer(doc, 'pointerdown'));
    expect(btn.style.transform).toBe('scale(0.98)');
    btn.dispatchEvent(new ctxPointer(doc, 'pointerup'));
    expect(btn.style.transform).toBe('');

    btn.dispatchEvent(new ctxPointer(doc, 'pointerdown'));
    btn.dispatchEvent(new ctxPointer(doc, 'pointercancel'));
    expect(btn.style.transform).toBe('');

    btn.dispatchEvent(new ctxPointer(doc, 'pointerdown'));
    grid.dispatchEvent(new ctxPointer(doc, 'pointerleave'));
    expect(btn.style.transform).toBe('');

    // pointerdown on the grid itself (no [data-key] target) is a no-op
    grid.dispatchEvent(new ctxPointer(doc, 'pointerdown'));
    grid.dispatchEvent(new ctxPointer(doc, 'pointerup'));
  });

  it('runs the pagehide cleanup handler', async () => {
    const { window } = await mount();
    window.dispatchEvent(new window.Event('pagehide'));
    await settle(10);
  });
});

function ctxPointer(doc, type) {
  const w = doc.defaultView;
  const Ctor = w.PointerEvent ?? w.Event;
  if (Ctor === w.Event) return new w.Event(type, { bubbles: true });
  return new w.PointerEvent(type, { bubbles: true });
}
