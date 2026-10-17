import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const bootSource = readFileSync(
  new URL('../../js/core/core/boot.js', import.meta.url),
  'utf8'
);
const recoveryStart = bootSource.indexOf('function _doShowRecoveryScreen(');
const recoveryEnd = bootSource.indexOf('// Wires up click handling for the recovery screen.', recoveryStart);
const recoveryImplementation = bootSource.slice(recoveryStart, recoveryEnd);

describe('recovery auto-boot countdown', () => {
  it('cancels when a recovery control click is intercepted during capture', () => {
    const listeners = new Map();
    const countdownText = { textContent: 'Continuing in 15s — interact to cancel' };
    const countdownBlock = {
      style: {},
      querySelector: () => countdownText,
    };
    const recoveryScreen = {
      dataset: {},
      classList: { add() {} },
      addEventListener() {},
      querySelectorAll: () => [],
      contains: () => true,
    };
    const elements = {
      'recovery-screen': recoveryScreen,
      'rec-countdown-block': countdownBlock,
      'rec-cdown-num': { textContent: '' },
      'rec-cdown-bar': { style: {} },
      'rec-diag-lines': { appendChild() {} },
    };
    const document = {
      getElementById: id => elements[id] || null,
      querySelector: () => null,
      addEventListener: (type, listener, options) => listeners.set(type, { listener, options }),
      removeEventListener: (type, listener) => {
        if (listeners.get(type)?.listener === listener) listeners.delete(type);
      },
      createElement: () => ({ className: '', textContent: '' }),
    };
    const clearInterval = vi.fn();
    const context = {
      document,
      localStorage: { length: 0, getItem: () => null },
      Blob,
      Date,
      console,
      setInterval: vi.fn(() => 42),
      clearInterval,
      wireRecoveryControls: vi.fn(),
    };
    context.window = context;

    runInNewContext(
      `let _recoveryClockId = 0; let _recoveryCountdownId = 0;\n${recoveryImplementation}\nwindow.showRecoveryForTest = _doShowRecoveryScreen;`,
      context
    );
    context.showRecoveryForTest([], false);

    const clickListener = listeners.get('click');
    expect(clickListener?.options).toBe(true);
    clickListener.listener({ target: {} });

    expect(clearInterval).toHaveBeenCalledWith(42);
    expect(countdownText.textContent).toBe('Auto-boot cancelled');
    expect(countdownBlock.style.opacity).toBe('0.4');
    expect(listeners.has('click')).toBe(false);
    expect(context._cancelRecoveryAutoBoot).toBeUndefined();
  });
});
