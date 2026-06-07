registerApp({
  id: 'calculator',
  name: 'Calculator',
  icon: 'calculator',
  description: 'Bare-bones calculator for quick arithmetic',
  defaultSize: [320, 440],
  minSize: [280, 380],
  init(content) {
    // ── NovaByte runtime guard ──
    if (!window.AppDirs?.getVFSDir('com.nbosp.calculator', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.calculator</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
      return;
    }

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;padding:14px;background:var(--bg-base);gap:10px;';

    const display = createEl('input', {
      id: 'calculator-display',
      name: 'calculator-display',
      type: 'text',
      value: '',
      readonly: 'readonly',
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

    let expr = '';
    let justEvaluated = false;

    const SANITIZE_REGEX = /[^0-9+\-*/().%]/g;

    const Parser = {
      evaluate(input) {
        this.s = String(input).replace(/\s+/g, '');
        this.i = 0;
        const value = this.parseAddSub();
        if (this.i !== this.s.length) throw new Error('Unexpected token');
        if (!Number.isFinite(value)) throw new Error('Invalid result');
        return value;
      },
      consume(ch) {
        if (this.s[this.i] === ch) {
          this.i++;
          return true;
        }
        return false;
      },
      parseNumber() {
        const start = this.i;
        let sawDigit = false;
        let sawDot = false;
        while (this.i < this.s.length) {
          const ch = this.s[this.i];
          if (ch >= '0' && ch <= '9') { sawDigit = true; this.i++; }
          else if (ch === '.' && !sawDot) { sawDot = true; this.i++; }
          else break;
        }
        if (!sawDigit) throw new Error('Expected number');
        return Number(this.s.slice(start, this.i));
      },
      parsePrimary() {
        if (this.consume('+')) return this.parsePrimary();
        if (this.consume('-')) return -this.parsePrimary();
        if (this.consume('(')) {
          const value = this.parseAddSub();
          if (!this.consume(')')) throw new Error('Expected )');
          return value;
        }
        return this.parseNumber();
      },
      parseMulDiv() {
        let left = this.parsePrimary();
        while (this.i < this.s.length) {
          if (this.consume('*')) left *= this.parsePrimary();
          else if (this.consume('/')) left /= this.parsePrimary();
          else if (this.consume('%')) left %= this.parsePrimary();
          else break;
        }
        return left;
      },
      parseAddSub() {
        let left = this.parseMulDiv();
        while (this.i < this.s.length) {
          if (this.consume('+')) left += this.parseMulDiv();
          else if (this.consume('-')) left -= this.parseMulDiv();
          else break;
        }
        return left;
      }
    };

    const update = () => {
      display.value = expr;
      display.scrollLeft = display.scrollWidth;

      if (!expr) {
        result.textContent = 'Ready';
        return;
      }

      try {
        const safe = expr.replace(SANITIZE_REGEX, '');
        if (!safe.trim()) {
          result.textContent = 'Enter a calculation';
          return;
        }
        const out = Parser.evaluate(safe);
        result.textContent = String(out);
      } catch {
        result.textContent = 'Invalid expression';
      }
    };

    const append = (v) => {
      if (justEvaluated && /^[0-9.]$/.test(v)) expr = '';
      justEvaluated = false;
      expr += v;
      update();
    };

    const clearAll = () => {
      expr = '';
      justEvaluated = false;
      update();
    };

    const backspace = () => {
      justEvaluated = false;
      expr = expr.slice(0, -1);
      update();
    };

    const equals = () => {
      try {
        const safe = expr.replace(SANITIZE_REGEX, '');
        if (!safe.trim()) return;
        
        const out = Parser.evaluate(safe);
        expr = String(out);
        justEvaluated = true;
        
        display.value = expr;
        display.scrollLeft = display.scrollWidth;
        result.textContent = '=' + expr;
      } catch {
        result.textContent = 'Invalid expression';
      }
    };

    // Optimization: Using a Map guarantees explicit insertion order for numeric keys
    const keyMap = new Map([
      ['C', clearAll], ['⌫', backspace], ['%', () => append('%')], ['÷', () => append('/')],
      ['7', () => append('7')], ['8', () => append('8')], ['9', () => append('9')], ['×', () => append('*')],
      ['4', () => append('4')], ['5', () => append('5')], ['6', () => append('6')], ['−', () => append('-')],
      ['1', () => append('1')], ['2', () => append('2')], ['3', () => append('3')], ['+', () => append('+')],
      ['0', () => append('0')], ['.', () => append('.')], ['(', () => append('(')], [')', () => append(')')]
    ]);

    const fragment = document.createDocumentFragment();

    for (const [label] of keyMap) {
      const btn = createEl('button', {
        textContent: label,
        'data-key': label,
        style: 'height:42px;border:1px solid var(--border-default);border-radius:12px;background:var(--bg-overlay);color:var(--text-primary);font-size:16px;font-weight:600;cursor:pointer;transition:transform 0.05s ease;'
      });
      fragment.appendChild(btn);
    }

    const equalsBtn = createEl('button', {
      textContent: '=',
      'data-key': '=',
      style: 'height:42px;border:1px solid var(--accent);border-radius:12px;background:var(--accent);color:#fff;font-size:16px;font-weight:700;cursor:pointer;grid-column:1/-1;transition:transform 0.05s ease;'
    });
    fragment.appendChild(equalsBtn);
    buttons.appendChild(fragment);

    buttons.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') return;
      const key = e.target.getAttribute('data-key');
      if (key === '=') equals();
      else if (keyMap.has(key)) keyMap.get(key)();
    });

    buttons.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') e.target.style.transform = 'scale(0.98)';
    });
    const resetTransform = (e) => {
      if (e.target.tagName === 'BUTTON') e.target.style.transform = '';
    };
    buttons.addEventListener('mouseup', resetTransform);
    buttons.addEventListener('mouseleave', resetTransform, true);

    content.append(display, result, buttons);

    const allowedKeys = new Set(['+', '-', '*', '/', '(', ')', '%', '.', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    
    content.addEventListener('keydown', (e) => {
      const k = e.key;
      if (allowedKeys.has(k)) { 
        e.preventDefault(); 
        append(k); 
      } else if (k === 'Enter' || k === '=') { 
        e.preventDefault(); 
        equals(); 
      } else if (k === 'Backspace') { 
        e.preventDefault(); 
        backspace(); 
      } else if (k === 'Escape') { 
        e.preventDefault(); 
        clearAll(); 
      }
    });

    content.tabIndex = 0;
    setTimeout(() => content.focus(), 50);
    update();
  }
});