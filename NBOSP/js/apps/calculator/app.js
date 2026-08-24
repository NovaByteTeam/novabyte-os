// Calculator — arithmetic engine. Runs as a plain page script inside this
// app's own index.html; the OS drives the window shell, not this script.
// No permissions or storage needed: expression state lives in memory only
// and resets on relaunch, same as a physical calculator.
(function () {
  'use strict';

  function main() {
    const content = document.getElementById('app');

    let isEvaluated = false;
    let expr = '';

    // Allocation-light character-code parser: avoids building a token array
    // or AST, walking the raw string directly with a cursor instead.
    class HardcoreParser {
      #s = '';
      #len = 0;
      #i = 0;

      evaluate(raw) {
        this.#s = String(raw);
        this.#len = this.#s.length;
        this.#i = 0;

        const v = this.#addSub();
        this.#skip();

        if (this.#i < this.#len) throw new SyntaxError();
        // NaN check: v !== v; Infinity/-Infinity check (also catches ÷0)
        if (v !== v || v === Infinity || v === -Infinity) throw new RangeError();
        return v;
      }

      #skip() {
        while (this.#i < this.#len) {
          const c = this.#s.charCodeAt(this.#i);
          if (c === 32 || c === 9 || c === 13 || c === 10) {
            this.#i++;
          } else {
            break;
          }
        }
      }

      // #eat advances #i only on a match; returns false without consuming otherwise.
      // Loop termination in #mulDiv/#addSub depends on this non-consuming false path.
      #eat(code) {
        this.#skip();
        if (this.#i < this.#len && this.#s.charCodeAt(this.#i) === code) {
          this.#i++;
          return true;
        }
        return false;
      }

      #num() {
        this.#skip();
        let v = 0;
        let decimals = -1;
        let sawDigit = false;

        while (this.#i < this.#len) {
          const c = this.#s.charCodeAt(this.#i);
          if (c >= 48 && c <= 57) { // '0'-'9'
            sawDigit = true;
            v = v * 10 + (c - 48);
            if (decimals >= 0) decimals++;
            this.#i++;
          } else if (c === 46) { // '.'
            if (decimals >= 0) throw new SyntaxError();
            decimals = 0;
            this.#i++;
          } else {
            break;
          }
        }

        if (!sawDigit) throw new SyntaxError();
        return decimals > 0 ? v / Math.pow(10, decimals) : v;
      }

      #primary(depth = 0) {
        if (depth > 1000) throw new SyntaxError();
        if (this.#eat(43)) return  this.#primary(depth + 1); // '+'
        if (this.#eat(45)) return -this.#primary(depth + 1); // '-'
        if (this.#eat(40)) {                        // '('
          const v = this.#addSub(depth);
          if (!this.#eat(41)) throw new SyntaxError(); // ')'
          return v;
        }
        return this.#num();
      }

      #mulDiv(depth = 0) {
        let v = this.#primary(depth);
        while (this.#i < this.#len) {
          if      (this.#eat(215)) v *= this.#primary(depth); // '×'
          else if (this.#eat(247)) v /= this.#primary(depth); // '÷'
          else if (this.#eat(37))  v %= this.#primary(depth); // '%'
          else break;
        }
        return v;
      }

      #addSub(depth = 0) {
        let v = this.#mulDiv(depth);
        while (this.#i < this.#len) {
          if      (this.#eat(43)) v += this.#mulDiv(depth); // '+'
          else if (this.#eat(45)) v -= this.#mulDiv(depth); // '-'
          else break;
        }
        return v;
      }
    }

    const parser = new HardcoreParser();

    function createEl(tag, attrs, children) {
      const el = document.createElement(tag);
      if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
          if (k === 'className') el.className = v;
          else if (k.startsWith('data-')) el.setAttribute(k, v);
          else el[k] = v;
        }
      }
      if (children) el.append(...[].concat(children));
      return el;
    }

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;padding:14px;background:var(--bg-base);gap:10px;';

    const display = createEl('input', {
      id:        'calculator-display',
      name:      'calculator-display',
      type:      'text',
      value:     '',
      readonly:  'readonly',
      inputMode: 'none',
      placeholder: '0',
      style: 'width:100%;height:58px;border:1px solid var(--border-default);border-radius:14px;background:var(--bg-elevated);color:var(--text-primary);font-size:28px;font-weight:600;text-align:right;padding:0 14px;outline:none;font-family:var(--font-mono);box-sizing:border-box;'
    });

    const result = createEl('div', {
      textContent: 'Ready',
      style: 'min-height:18px;font-size:11px;color:var(--text-muted);padding:0 4px;font-family:var(--font-mono);text-align:right;'
    });

    const buttons = createEl('div', {
      style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:6px;flex:none;align-content:start;'
    });

    const scrollEnd = () => { display.scrollLeft = 9999; };

    // Unified result-line formatter so it always reads as "= value" or "= Error: …"
    const setResult = (text, isError = false) => {
      result.textContent = isError ? `= Error: ${text}` : `= ${text}`;
    };

    const update = () => {
      display.value = expr;
      scrollEnd();

      if (!expr) { result.textContent = 'Ready'; return; }

      try {
        setResult(String(parser.evaluate(expr)));
      } catch {
        setResult('Invalid expression', true);
      }
    };

    const append = (v) => {
      const c = v.charCodeAt(0);
      if (isEvaluated && ((c >= 48 && c <= 57) || c === 46)) expr = '';
      isEvaluated = false;
      expr    += v;
      update();
    };

    const clearAll = () => {
      expr     = '';
      isEvaluated = false;
      update();
    };

    const backspace = () => {
      isEvaluated = false;
      expr     = expr.slice(0, -1);
      update();
    };

    const equals = () => {
      if (!expr) return;
      try {
        const out = parser.evaluate(expr);
        expr     = String(out);
        isEvaluated = true;
        display.value = expr;
        scrollEnd();
        setResult(expr);
      } catch {
        setResult('Invalid expression', true);
      }
    };

    const labels = [
      'C', '⌫', '%', '÷',
      '7', '8', '9', '×',
      '4', '5', '6', '−',
      '1', '2', '3', '+',
      '0', '.', '(', ')'
    ];

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 20; i++) {
      fragment.appendChild(createEl('button', {
        textContent: labels[i],
        'data-key':  labels[i],
        style: 'height:42px;border:1px solid var(--border-default);border-radius:12px;background:var(--bg-overlay);color:var(--text-primary);font-size:16px;font-weight:600;cursor:pointer;transition:transform 0.05s ease;'
      }));
    }

    fragment.appendChild(createEl('button', {
      textContent: '=',
      'data-key':  '=',
      style: 'height:42px;border:1px solid var(--accent);border-radius:12px;background:var(--accent);color:#fff;font-size:16px;font-weight:700;cursor:pointer;grid-column:1/-1;transition:transform 0.05s ease;'
    }));

    buttons.appendChild(fragment);

    const ac = new AbortController();
    const { signal } = ac;

    const handleKeyAction = (key) => {
      switch (key) {
        case '=':  equals(); break;
        case 'C':  clearAll(); break;
        case '⌫': backspace(); break;
        case '%':  append('%'); break;
        case '÷':  append('÷'); break;
        case '×':  append('×'); break;
        case '−':  append('-'); break;
        default:   append(key); break;
      }
    };

    buttons.addEventListener('click', ({ target }) => {
      const btn = target.closest('[data-key]');
      if (btn) handleKeyAction(btn.dataset.key);
    }, { signal });

    let pressedBtn = null;
    buttons.addEventListener('pointerdown', ({ target }) => {
      const btn = target.closest('[data-key]');
      if (!btn) return;
      pressedBtn = btn;
      btn.style.transform = 'scale(0.98)';
    }, { signal });

    const releaseBtn = () => {
      if (!pressedBtn) return;
      pressedBtn.style.transform = '';
      pressedBtn = null;
    };

    buttons.addEventListener('pointerup',     releaseBtn, { signal });
    buttons.addEventListener('pointercancel', releaseBtn, { signal });
    buttons.addEventListener('pointerleave',  releaseBtn, { signal });

    content.addEventListener('keydown', (e) => {
      const k = e.key;
      switch (k) {
        case '*': e.preventDefault(); append('×'); break;
        case '/': e.preventDefault(); append('÷'); break;
        case '+': case '-': case '(': case ')':
        case '%': case '.': case '0': case '1': case '2': case '3':
        case '4': case '5': case '6': case '7': case '8': case '9':
          e.preventDefault(); append(k); break;
        case '−': e.preventDefault(); append('-'); break;
        case 'Enter': case '=': e.preventDefault(); equals(); break;
        case 'Backspace': e.preventDefault(); backspace(); break;
        case 'Escape':    e.preventDefault(); clearAll(); break;
      }
    }, { signal });

    content.append(display, result, buttons);
    content.tabIndex = 0;
    requestAnimationFrame(() => content.focus());
    update();

    // No unmount hook exists in this runtime (unlike the original
    // registerApp() return-a-cleanup-function convention) — the webview
    // is torn down wholesale on app close, taking these listeners with it.
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
