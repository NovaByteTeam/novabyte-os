// tests/apps/shell-ui.cover.test.js
//
// Coverage-attributed e2e suites for the small shell-ui surfaces:
//   js/apps/shell-ui/popup-coordinator.js
//   js/apps/shell-ui/menu.js
//   js/apps/shell-ui/modals.js
// desktop.js and wm.js get their own suites (they need the full OS/WM host).
//
// Each source is require()d in the Node realm against a real JSDOM window
// (cover-loader), then driven through real DOM events exactly like the shell.
import { describe, it, expect, vi } from 'vitest';
import { coverLoadServiceApp } from '../helpers/cover-loader.js';

afterEach(() => { vi.restoreAllMocks(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('ShellPopupCoordinator (js/apps/shell-ui/popup-coordinator.js) — e2e coverage', () => {
  const load = () => coverLoadServiceApp('shell-ui', { scripts: ['popup-coordinator.js'], withBaseUtils: false });

  it('exposes a frozen coordinator on the window', async () => {
    const { window } = await load();
    const c = window.ShellPopupCoordinator;
    expect(c).toBeTruthy();
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.keys(c).sort()).toEqual(['closeAllExcept', 'register', 'unregister']);
  });

  it('closes every other registered popup and skips the one opening', async () => {
    const { window } = await load();
    const c = window.ShellPopupCoordinator;
    const vol = vi.fn(() => c.unregister('volume'));
    const wifi = vi.fn(() => c.unregister('wifi'));
    c.register('volume', vol);
    c.register('wifi', wifi);
    c.closeAllExcept('volume');
    expect(wifi).toHaveBeenCalledTimes(1);
    expect(vol).not.toHaveBeenCalled();
    // the closer unregistered itself, so a second sweep is a no-op
    c.closeAllExcept('volume');
    expect(wifi).toHaveBeenCalledTimes(1);
  });

  it('ignores invalid registrations and unknown unregisters', async () => {
    const { window } = await load();
    const c = window.ShellPopupCoordinator;
    c.register(42, vi.fn());          // non-string id
    c.register('ok-id', 'not a fn');  // non-function closer
    c.register('ok-id', null);        // null closer
    c.closeAllExcept('other');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    c.unregister('nope');
    expect(spy).not.toHaveBeenCalled();
  });

  it('survives a closer that throws and reports it', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { window } = await load();
    const c = window.ShellPopupCoordinator;
    const good = vi.fn();
    c.register('boom', () => { throw new Error('close failed'); });
    c.register('fine', good);
    c.closeAllExcept('x');
    expect(errorSpy).toHaveBeenCalledWith(
      '[ShellPopupCoordinator] Closing popup "boom" failed',
      expect.objectContaining({ message: 'close failed' }),
    );
    expect(good).toHaveBeenCalledTimes(1); // the failure did not abort the sweep
  });

  it('leaves a popup registered when its closer declines (no self-unregister)', async () => {
    const { window } = await load();
    const c = window.ShellPopupCoordinator;
    const stubborn = vi.fn(); // registered closer that never unregisters
    c.register('pinned', stubborn);
    c.closeAllExcept('a');
    c.closeAllExcept('b');
    expect(stubborn).toHaveBeenCalledTimes(2); // retried on every sweep
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ContextMenu (js/apps/shell-ui/menu.js) — e2e coverage', () => {
  const load = () => coverLoadServiceApp('shell-ui', { scripts: ['menu.js'], withBaseUtils: true });

  const fire = (el, type) =>
    el.dispatchEvent(new (el.ownerDocument.defaultView).Event(type, { bubbles: true, cancelable: true }));
  const pointerDown = (el) =>
    el.dispatchEvent(new (el.ownerDocument.defaultView).Event('pointerdown', { bubbles: true }));

  it('renders items, separators, icons, shortcuts and disabled state', async () => {
    const { window } = await load();
    const seen = [];
    const menu = window.ContextMenu.show(50, 60, [
      { label: 'Open', icon: 'box', shortcut: 'Ctrl+O', action: () => seen.push('open') },
      { separator: true },
      { label: 'Rename', disabled: true },
      { label: 'Purge', danger: true, action: () => seen.push('purge') },
    ]);
    expect(menu.className).toBe('context-menu');
    expect(menu.getAttribute('role')).toBe('menu');
    const items = [...menu.querySelectorAll('.ctx-item')];
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('Open');
    expect(items[0].querySelector('.ctx-shortcut').textContent).toBe('Ctrl+O');
    expect(items[0].querySelector('span').innerHTML).toBeTruthy(); // svgIcon output
    expect(items[1].className).toContain('disabled');
    expect(items[1].disabled).toBe(true);
    expect(items[1].getAttribute('aria-disabled')).toBe('true');
    expect(items[2].className).toContain('danger');
    expect(menu.querySelector('.ctx-separator')).toBeTruthy();
    expect(menu.style.left).toBe('50px'); // no clamp: 50 + 0 ≤ 1024
    window.ContextMenu.hide();
    expect(document.body.contains(menu)).toBe(false);
  });

  it('clamps the menu inside the viewport on the right/bottom edges', async () => {
    const { window } = await load();
    // jsdom: getBoundingClientRect is 0×0 and the viewport is 1024×768.
    const menu = window.ContextMenu.show(2000, 2000, [{ label: 'Only' }]);
    expect(menu.style.left).toBe('1016px'); // 1024 - 0 - 8
    expect(menu.style.top).toBe('760px');   // 768 - 0 - 8
    const mid = window.ContextMenu.show(900, 700, [{ label: 'Only' }]);
    expect(mid.style.left).toBe('900px');   // no clamp
    expect(mid.style.top).toBe('700px');
    window.ContextMenu.hide();
  });

  it('runs the action after hiding, and passes the selection index', async () => {
    const { window } = await load();
    const onDismiss = vi.fn();
    const action = vi.fn();
    const menu = window.ContextMenu.show(10, 10, [
      { label: 'Pick', action, _selectionIndex: 2 },
      { label: 'Plain' },
    ]);
    menu.__onDismiss = onDismiss; // set after show to observe the call
    const pick = [...menu.querySelectorAll('.ctx-item')][0];
    pick.click();
    expect(action).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(2);
    expect(window.ContextMenu.current).toBe(null);
    // plain item without action/selection: hide(null), no throw
    const menu2 = window.ContextMenu.show(10, 10, [{ label: 'Plain', action }]);
    [...menu2.querySelectorAll('.ctx-item')][0].click();
    expect(window.ContextMenu.current).toBe(null);
  });

  it('replaces an open menu and keeps only one at a time', async () => {
    const { window } = await load();
    const first = window.ContextMenu.show(5, 5, [{ label: 'A' }]);
    const second = window.ContextMenu.show(6, 6, [{ label: 'B' }]);
    expect(document.body.contains(first)).toBe(false);
    expect(window.ContextMenu.current).toBe(second);
    window.ContextMenu.hide();
  });

  it('dismisses on outside pointerdown but not on in-menu pointerdown', async () => {
    const { window } = await load();
    const menu = window.ContextMenu.show(5, 5, [{ label: 'A' }]);
    // inside: no dismiss
    pointerDown(menu.querySelectorAll('.ctx-item')[0]);
    expect(window.ContextMenu.current).toBe(menu);
    // outside: dismiss
    pointerDown(document.body);
    expect(window.ContextMenu.current).toBe(null);
    expect(window.ContextMenu._activeDismiss).toBe(null);
    // the capture listener is gone: a later outside press is inert
    pointerDown(document.body);
  });

  it('hide(expectedMenu) guards against stale hides', async () => {
    const { window } = await load();
    const menu = window.ContextMenu.show(5, 5, [{ label: 'A' }]);
    const stale = document.createElement('div');
    window.ContextMenu.hide(stale, 1); // current !== expected → keep open
    expect(window.ContextMenu.current).toBe(menu);
    window.ContextMenu.hide(menu, null);
    expect(window.ContextMenu.current).toBe(null);
    // hide with nothing open: both null guards
    window.ContextMenu.hide();
    window.ContextMenu.hide(menu);
  });

  it('takes an onDismiss callback, ignores non-item clicks and value-less items', async () => {
    const { window } = await load();
    const onDismiss = vi.fn();
    const action = vi.fn();
    const menu = window.ContextMenu.show(4, 4, [
      { label: 'Silent' },                                  // no action, no selection
      { label: 'Do', action, _selectionIndex: 1 },
    ], onDismiss);
    expect(menu.__onDismiss).toBe(onDismiss); // function side of the ternary
    // click on the menu itself: closest('.ctx-item') → null, nothing happens
    menu.click();
    expect(onDismiss).not.toHaveBeenCalled();
    // the no-action item: hide(null), _action guard takes the false side
    [...menu.querySelectorAll('.ctx-item')][0].click();
    expect(onDismiss).toHaveBeenCalledWith(null);
    expect(action).not.toHaveBeenCalled();
    // the action item: selection index flows to onDismiss (fresh menu — the
    // first click already closed the previous one via the stale-hide guard)
    const menu2 = window.ContextMenu.show(4, 4, [
      { label: 'Silent' },
      { label: 'Do', action, _selectionIndex: 1 },
    ], onDismiss);
    [...menu2.querySelectorAll('.ctx-item')][1].click();
    expect(onDismiss).toHaveBeenLastCalledWith(1);
    expect(action).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ModalService (js/apps/shell-ui/modals.js) — e2e coverage', () => {
  const load = (i18n = true) =>
    coverLoadServiceApp('shell-ui', { scripts: ['modals.js'], withBaseUtils: true, i18n });

  const q = (sel) => globalThis.window.document.querySelector(sel);

  it('shows a title/body/actions modal and resolves the primary action value', async () => {
    const { window } = await load();
    const p = window.showModal('Confirm', 'Proceed?', [
      { label: 'No' },
      { label: 'Yes', primary: true, value: 'confirmed' },
    ]);
    expect(q('.modal-title').textContent).toBe('Confirm');
    expect(q('.modal-body').textContent).toBe('Proceed?');
    expect(q('#system-modal-root')).toBeTruthy(); // portal root created on demand
    [...q('.modal-actions').querySelectorAll('button')][1].click();
    await expect(p).resolves.toBe('confirmed');
    expect(q('.modal-overlay')).toBe(null); // cleaned up
  });

  it('resolves the label when an action has no explicit value', async () => {
    const { window } = await load();
    const p = window.showModal('Pick', 'body', [{ label: 'Plain', value: undefined }]);
    [...q('.modal-actions').querySelectorAll('button')][0].click();
    await expect(p).resolves.toBe('Plain');
  });

  it('resolves null on overlay dismiss', async () => {
    const { window } = await load();
    const p = window.showModal('T', 'B', [{ label: 'OK', primary: true }]);
    q('.modal-overlay').click();
    await expect(p).resolves.toBe(null);
  });

  it('prompt modal: Enter submits the input value, Escape cancels', async () => {
    const { window } = await load();
    const p1 = window.showPrompt('Name it', 'default');
    const input = q('#modal-input-field');
    expect(input.value).toBe('default');
    expect(input.type).toBe('text');
    input.value = 'typed';
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    await expect(p1).resolves.toBe('typed');

    const p2 = window.showPrompt('Again');
    q('#modal-input-field').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(p2).resolves.toBe(null);
  });

  it('with an input open, buttons return the input value; Cancel is independent of its label', async () => {
    const { window } = await load();
    // showPrompt's Cancel carries value:null but an open input makes the
    // resolution `_hasExplicitValue ? modalInput.value : null` → the input's
    // content at click time.
    const p = window.showPrompt('Rename', 'keep');
    const input = q('#modal-input-field');
    input.value = 'final';
    const buttons = [...q('.modal-actions').querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'OK']);
    buttons[0].click(); // Cancel
    await expect(p).resolves.toBe('final');
  });

  it('with an input open, a value-less button resolves null', async () => {
    const { window } = await load();
    // modalInput present + _hasExplicitValue false → the null side of
    // `btn._hasExplicitValue ? modalInput.value : null`.
    const p = window.showModal('T', 'B', [{ label: 'Send' }], 'text');
    const input = q('#modal-input-field');
    input.value = 'ignored';
    q('.modal-actions button').click();
    await expect(p).resolves.toBe(null);
  });

  it('DOM body: radio-style selection drives bodySelection and submit-selection', async () => {
    const { window } = await load();
    const body = window.document.createElement('div');
    const makeOpt = (value, label) => {
      const el = window.document.createElement('div');
      el.setAttribute('data-modal-value', value);
      el.dataset.modalSelectedStyle = 'radio';
      el.textContent = label;
      const wrap = window.document.createElement('label');
      const dot = window.document.createElement('span');
      dot.setAttribute('data-modal-radio-dot', '');
      wrap.appendChild(dot);
      el.appendChild(wrap);
      return el;
    };
    const a = makeOpt('alpha', 'Alpha');
    const b = makeOpt('beta', 'Beta');
    a.setAttribute('data-modal-selected', 'true'); // pre-selected at open time
    body.append(a, b);

    const p = window.showModal('Choose', body, [
      { label: 'OK', primary: true, value: '__MODAL_SUBMIT_SELECTION__' },
    ]);
    // initial selection read from [data-modal-selected="true"]
    b.click(); // user picks beta: radio styling flips
    expect(b.getAttribute('data-modal-selected')).toBe('true');
    expect(b.getAttribute('aria-checked')).toBe('true');
    expect(b.style.background).toBe('var(--accent-muted)');
    expect(b.querySelector('[data-modal-radio-dot]').style.opacity).toBe('1');
    expect(a.getAttribute('data-modal-selected')).toBe('false');
    expect(a.querySelector('[data-modal-radio-dot]').style.opacity).toBe('0');
    // click a non-option area of the body: ignored
    body.click();
    q('.modal-actions button').click();
    await expect(p).resolves.toBe('beta');
  });

  it('submit-selection without any selection resolves null', async () => {
    const { window } = await load();
    const body = window.document.createElement('div');
    const opt = window.document.createElement('div');
    opt.setAttribute('data-modal-value', 'x');
    body.appendChild(opt); // present but never selected
    const p = window.showModal('Choose', body, [
      { label: 'OK', primary: true, value: '__MODAL_SUBMIT_SELECTION__' },
    ]);
    q('.modal-actions button').click();
    await expect(p).resolves.toBe(null);
  });

  it('submit-custom resolves options.collect(bodyDiv); a throwing collector resolves null', async () => {
    const { window } = await load();
    const body = window.document.createElement('div');
    const opt = window.document.createElement('span');
    body.appendChild(opt);
    const first = window.showModal('Collect', body, [
      { label: 'Go', primary: true, value: '__MODAL_SUBMIT_CUSTOM__' },
    ], null, '', { collect: (bd) => bd.children.length });
    q('.modal-actions button').click();
    await expect(first).resolves.toBe(1); // the body element is bodyDiv's only child

    const second = window.showModal('Collect', body, [
      { label: 'Go', primary: true, value: '__MODAL_SUBMIT_CUSTOM__' },
    ], null, '', { collect: () => { throw new Error('nope'); } });
    q('.modal-actions button').click();
    await expect(second).resolves.toBe(null);
  });

  it('developer-warning variant styles the dialog and pads an element body', async () => {
    const { window } = await load();
    const body = window.document.createElement('p');
    body.textContent = 'careful';
    const p = window.showModal('Dev', body, [{ label: 'OK', primary: true }], null, '', {
      variant: 'developer-warning',
    });
    const dialog = q('.modal-dialog');
    expect(dialog.dataset.modalVariant).toBe('developer-warning');
    expect(dialog.style.border).toContain('var(--text-danger');
    const bodyDiv = dialog.querySelectorAll('.modal-body')[0];
    expect(bodyDiv.style.padding).toContain('18px'); // jsdom serialises '0 0 18px 0'
    expect(bodyDiv.firstChild.textContent).toBe('careful');
    q('.modal-actions button').click();
    await expect(p).resolves.toBe('OK');
  });

  it('focuses the input when one is present, else the first button', async () => {
    const { window } = await load();
    const focusInput = vi.spyOn(window.HTMLElement.prototype, 'focus');
    const p1 = window.showPrompt('Focus me', 'seed'); // select() branch needs a default
    expect(focusInput).toHaveBeenCalled();
    q('#modal-input-field').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    await expect(p1).resolves.toBe('seed');

    const p2 = window.showModal('T', 'B', [{ label: 'OK', primary: true }]);
    q('.modal-actions button').click();
    await expect(p2).resolves.toBe('OK');
    expect(q('.modal-overlay')).toBe(null);
  });

  it('falls back to the identity _t when the i18n engine is absent', async () => {
    const { window } = await load(false); // i18n:false — no window._t at load time
    const p = window.showModal(null, 'B', null, 'text'); // no title → aria-label falls back to _t
    const input = q('#modal-input-field');
    expect(input.getAttribute('aria-label')).toBe('shell.modal.inputAria'); // identity fallback
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    await expect(p).resolves.toBe('');
  });

  it('non-developer variants tag the dialog without warning styles', async () => {
    const { window } = await load();
    const p = window.showModal('V', 'B', null, null, '', { variant: 'plain-v2' });
    const dialog = q('.modal-dialog');
    expect(dialog.dataset.modalVariant).toBe('plain-v2');
    expect(dialog.style.border).toBe(''); // no developer-warning styling
    q('.modal-actions button').click();
    await expect(p).resolves.toBe(true); // default OK action carries value:true
  });

  it('an input layer without an explicit type defaults to text', async () => {
    const { window } = await load();
    // defaultInputValue alone opens the input layer; type falls back to 'text'.
    const p = window.showModal('T', 'B', null, null, 'seed');
    const input = q('#modal-input-field');
    expect(input.type).toBe('text');
    expect(input.value).toBe('seed');
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab' })); // neither Enter nor Escape
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    await expect(p).resolves.toBe('seed');
    // a non-button area of the dialog: closest('button') → null, modal stays
    const p2 = window.showModal('T2', 'B2', [{ label: 'OK', primary: true }]);
    q('.modal-title').click();
    expect(q('.modal-overlay')).toBeTruthy();
    q('.modal-actions button').click();
    await expect(p2).resolves.toBe('OK'); // no explicit value → the label
  });

  it('danger actions get the danger class and resolve their explicit value', async () => {
    const { window } = await load();
    const p = window.showModal('Remove', 'Sure?', [
      { label: 'Keep' },
      { label: 'Delete', danger: true, value: false },
    ]);
    const buttons = [...q('.modal-actions').querySelectorAll('button')];
    expect(buttons[1].className).toContain('btn-danger');
    buttons[1].click();
    await expect(p).resolves.toBe(false);
  });

  it('non-radio body options select without radio styling', async () => {
    const { window } = await load();
    const body = window.document.createElement('div');
    const plain = window.document.createElement('button');
    plain.setAttribute('data-modal-value', 'plain-choice');
    plain.textContent = 'Plain option';
    body.appendChild(plain);
    const p = window.showModal('Pick', body, [
      { label: 'OK', primary: true, value: '__MODAL_SUBMIT_SELECTION__' },
    ]);
    plain.click(); // no modalSelectedStyle → selected without radio visuals
    expect(plain.getAttribute('data-modal-selected')).toBe('true');
    expect(plain.style.borderColor).toBe(''); // untouched
    q('.modal-actions button').click();
    await expect(p).resolves.toBe('plain-choice');

    // radio-styled option without a dot child: the dot guard takes its null side
    const body2 = window.document.createElement('div');
    const dotless = window.document.createElement('div');
    dotless.setAttribute('data-modal-value', 'dotless');
    dotless.dataset.modalSelectedStyle = 'radio';
    body2.appendChild(dotless);
    const p2 = window.showModal('Pick2', body2, [
      { label: 'OK', primary: true, value: '__MODAL_SUBMIT_SELECTION__' },
    ]);
    dotless.click();
    expect(dotless.style.background).toBe('var(--accent-muted)'); // styled but no dot to touch
    q('.modal-actions button').click();
    await expect(p2).resolves.toBe('dotless');
  });
});
