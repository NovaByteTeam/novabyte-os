'use strict';

/**
 * com.nbosp.setup — NovaByte Setup, the first-boot wizard (AOSP-style).
 *
 * The whole first-run experience lives in this .novaapp instead of being
 * hardcoded into the lock screen: the lock screen only DETECTS "this
 * machine has no accounts" and launches this app full-screen. Everything
 * a person does on a fresh machine — keyboard layout, network,
 * date and region, data & privacy,
 * the owner account, appearance — is a step here, so developers can add,
 * reorder or replace steps without touching core boot code.
 *
 * It runs in the trusted host (unrestrictedEntry) because account
 * creation is a trusted verb: the wizard calls SessionManager.setupOwner
 * directly, the same call the lock screen's inline wizard used to make.
 * After the owner exists the account mount sequence runs; preferences
 * collected along the way (keyboard layout, guest access, theme, accent)
 * are applied once the owner's hive is the mounted settings store.
 *
 * Launching it later (from the App Manager, after setup is done) shows a
 * completed-state screen instead of the wizard — setup is a one-way door.
 *
 * Steps (bare bones, AOSP-like):
 *   1. Welcome        — language + keyboard-layout picker, Start
 *   2. Network        — connectivity check, skippable
 *   3. Date and Region — timezone and locale
 *   4. Data & privacy — per-account storage notice and guest access
 *   5. Owner account  — display name, username, PIN, passphrase
 *   6. Appearance     — theme + accent
 *   7. All set        — apply + finish
 */

// NovaI18n is a core engine script (js/core/core/i18n.js) that has always
// evaluated before the setup app can render — the wizard runs in the
// trusted host. The key-echo fallback only fires if localisation is
// offline entirely, which the boot log surfaces loudly.
var _t = window.NovaI18n?.t?.bind(window.NovaI18n) ?? ((key, vars) => window.NovaI18n?.t ? window.NovaI18n.t(key, vars) : key);

const SETUP_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiIgd2lkdGg9Ijk0IiBoZWlnaHQ9Ijk0Ij48Y2lyY2xlIGN4PSI0OCIgY3k9IjQ4IiByPSIzOCIgZmlsbD0iIzkzYzVmZCIvPjxjaXJjbGUgY3g9IjQ4IiBjeT0iNDgiIHI9IjMwIiBmaWxsPSIjMjU2M2ViIi8+PHBhdGggZD0iTTQwIDM2IEw0OCA1MCA1NiAzNiIgc3Ryb2tlPSIjZmRlNjhhIiBzdHJva2Utd2lkdGg9IjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgZmlsbD0ibm9uZSIvPjxyZWN0IHg9IjM2IiB5PSI1NiIgd2lkdGg9IjI0IiBoZWlnaHQ9IjUiIHJ4PSIyLjUiIGZpbGw9IiNmZGU2OGEiLz48L3N2Zz4=';

registerApp({
  id: 'com.nbosp.setup',
  name: 'NovaByte Setup',
  version: '3.0.2',
  icon: SETUP_ICON,
  description: 'First-boot setup wizard: keyboard layout, date and region, owner account, and appearance.',
  category: 'system',
  permissions: [],
  defaultSize: [920, 640],
  minSize: [560, 420],
  resizable: true,
  transparent: false,

  async init(content, state, options) {
    const ac = new AbortController();
    state.cleanups?.push(() => ac.abort());
    void options;

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-base);color:var(--text-primary);font-family:var(--font-ui,system-ui,sans-serif);overflow:hidden;';

    const css = document.createElement('style');
    css.textContent = `
      .nvsetup-root { display:flex;flex-direction:column;height:100%;overflow:hidden; }
      .nvsetup-top { flex-shrink:0;padding:22px 34px 12px;display:flex;align-items:center;justify-content:space-between; }
      .nvsetup-brand { display:flex;align-items:center;gap:10px;font-weight:600;font-size:14px;color:var(--text-secondary); }
      .nvsetup-brand .nvsetup-logo { width:22px;height:22px; }
      .nvsetup-progress { display:flex;gap:6px;align-items:center; }
      .nvsetup-dot { width:8px;height:8px;border-radius:50%;background:var(--bg-overlay);border:1px solid var(--border-default);transition:background .2s; }
      .nvsetup-dot.on { background:var(--accent);border-color:var(--accent); }
      .nvsetup-body { flex:1;overflow:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px 40px 28px; }
      .nvsetup-card { width:min(560px,100%);display:flex;flex-direction:column;gap:14px; }
      .nvsetup-title { font-size:24px;font-weight:600;margin:0;text-align:center; }
      .nvsetup-sub { font-size:13px;color:var(--text-muted);text-align:center;line-height:1.5;margin:-4px 0 4px; }
      .nvsetup-label { display:block;font-size:12px;color:var(--text-secondary,var(--text-muted));line-height:1.35;margin:0 0 6px; }
      .nvsetup-input { padding:11px 14px;border-radius:10px;border:1px solid var(--border-default);background:var(--bg-overlay);color:var(--text-primary);font-size:14px;outline:none;width:100%;box-sizing:border-box; }
      .nvsetup-input:focus { border-color:var(--accent); }
      .nvsetup-input.bad { border-color:var(--text-danger); }
      .nvsetup-grid2 { display:grid;grid-template-columns:1fr 1fr;gap:12px; }
      .nvsetup-row { display:flex;align-items:center;gap:10px;padding:11px 14px;border:1px solid var(--border-default);border-radius:10px;background:var(--bg-overlay);font-size:13px;cursor:pointer; }
      .nvsetup-row .nvsetup-row-text { flex:1; }
      .nvsetup-row b { font-weight:600;display:block; }
      .nvsetup-row small { color:var(--text-muted); }
      .nvsetup-theme-options .nvsetup-row[aria-pressed="true"] { border-color:var(--accent);background:var(--accent-muted);color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent); }
      .nvsetup-theme-options .nvsetup-row[aria-pressed="true"]::after { content:'✓';font-size:15px;font-weight:700; }
      .nvsetup-switch { width:38px;height:20px;border-radius:999px;background:var(--bg-overlay);border:1px solid var(--border-default);position:relative;flex-shrink:0;transition:background .2s; }
      .nvsetup-switch::after { content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--text-muted);transition:transform .2s,background .2s; }
      .nvsetup-row[aria-pressed="true"] .nvsetup-switch { background:var(--accent-muted);border-color:var(--accent); }
      .nvsetup-row[aria-pressed="true"] .nvsetup-switch::after { transform:translateX(18px);background:var(--accent); }
      .nvsetup-layout { width:100%; }
      .nvsetup-status { min-height:18px;font-size:12px;color:var(--text-danger);text-align:center; }
      .nvsetup-status.ok { color:var(--text-success); }
      .nvsetup-neticon { font-size:34px;text-align:center;margin:0; }
      .nvsetup-note { font-size:12px;color:var(--text-muted);line-height:1.55;background:var(--bg-overlay);border:1px solid var(--border-subtle);border-radius:10px;padding:12px 14px; }
      .nvsetup-note b { color:var(--text-secondary); }
      .nvsetup-bottom { flex-shrink:0;display:flex;justify-content:space-between;gap:10px;padding:16px 34px 22px;border-top:1px solid var(--border-subtle); }
      .nvsetup-btn { padding:10px 22px;border-radius:10px;border:1px solid var(--border-default);background:var(--bg-elevated);color:var(--text-primary);font-size:13px;cursor:pointer; }
      .nvsetup-btn.ghost { background:transparent;border-color:transparent;color:var(--text-muted); }
      .nvsetup-btn.primary { border-color:var(--accent);background:var(--accent);color:var(--text-primary);font-weight:600; }
      .nvsetup-btn.primary:disabled { opacity:.5;cursor:default; }
      .nvsetup-swatches { display:flex;gap:10px;justify-content:center;flex-wrap:wrap; }
      .nvsetup-swatch { width:34px;height:34px;border-radius:50%;border:2px solid transparent;cursor:pointer; }
      .nvsetup-swatch.on { border-color:var(--text-primary);transform:scale(1.1); }
      .nvsetup-center { text-align:center; }
      .nvsetup-big { font-size:44px;margin:8px 0; }
      .nvsetup-done { width:min(430px,100%);display:flex;flex-direction:column;gap:12px;align-items:center; }
    `;
    content.appendChild(css);

    const root = createEl('div', { className: 'nvsetup-root' });
    content.appendChild(root);

    // ── Shared helpers ────────────────────────────────────────────────────
    const manager = (typeof SessionManager !== 'undefined') ? SessionManager : null;
    const multiUser = typeof NovaUserScope !== 'undefined' && NovaUserScope?.enabled?.();

    const pending = {
      keyboardLayout: 'us',
      networkSkipped: false,
      guestAccess: true,
      displayName: '',
      username: '',
      pin: '',
      passphrase: '',
      theme: 'nova-dark',
      accent: '#93c5fd',
      region: OS.settings.get('region') || navigator.language || 'en-US',
      timezone: OS.settings.get('timezone') ||
        ((typeof Intl !== 'undefined' && Intl.DateTimeFormat)
          ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
          : 'UTC'),
      language: (typeof window.NovaI18n?.getLanguage === 'function')
        ? window.NovaI18n.getLanguage()
        : (OS.settings.get('language') || 'en'),
    };

    const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
    const THEMES = [
      { id: 'nova-dark', label: 'Nova Dark' },
      { id: 'nova-light', label: 'Nova Light' },
      { id: 'nord', label: 'Nord' },
      { id: 'dracula', label: 'Dracula' },
      { id: 'catppuccin', label: 'Catppuccin' },
      { id: 'tokyo-night', label: 'Tokyo Night' },
      { id: 'gruvbox', label: 'Gruvbox' },
    ];
    const ACCENTS = ['#93c5fd', '#2563eb', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb7185'];
    const KEYBOARD_LAYOUTS = [
      { code: 'us', label: 'English (US)' },
      { code: 'gb', label: 'English (UK)' },
      { code: 'ca', label: 'English (Canada)' },
      { code: 'au', label: 'English (Australia)' },
      { code: 'de', label: 'German' },
      { code: 'fr', label: 'French' },
      { code: 'be', label: 'Belgian' },
      { code: 'es', label: 'Spanish' },
      { code: 'it', label: 'Italian' },
      { code: 'pt', label: 'Portuguese' },
      { code: 'br', label: 'Portuguese (Brazil)' },
      { code: 'nl', label: 'Dutch' },
      { code: 'se', label: 'Swedish' },
      { code: 'no', label: 'Norwegian' },
      { code: 'dk', label: 'Danish' },
      { code: 'fi', label: 'Finnish' },
      { code: 'pl', label: 'Polish' },
      { code: 'tr', label: 'Turkish' },
      { code: 'ru', label: 'Russian' },
      { code: 'ua', label: 'Ukrainian' },
      { code: 'jp', label: 'Japanese' },
    ];
    const REGIONS = [
      ['en-US', 'United States (English)'], ['en-GB', 'United Kingdom (English)'],
      ['en-CA', 'Canada (English)'], ['fr-CA', 'Canada (French)'],
      ['en-AU', 'Australia (English)'], ['de-DE', 'Germany (German)'],
      ['fr-FR', 'France (French)'], ['es-ES', 'Spain (Spanish)'],
      ['es-MX', 'Mexico (Spanish)'], ['pt-BR', 'Brazil (Portuguese)'],
      ['pt-PT', 'Portugal (Portuguese)'], ['it-IT', 'Italy (Italian)'],
      ['nl-NL', 'Netherlands (Dutch)'], ['sv-SE', 'Sweden (Swedish)'],
      ['ja-JP', 'Japan (Japanese)'], ['zh-CN', 'China (Chinese)'],
      ['zh-TW', 'Taiwan (Chinese)'], ['hi-IN', 'India (Hindi)'],
      ['ar-SA', 'Saudi Arabia (Arabic)'], ['ko-KR', 'South Korea (Korean)'],
    ];
    const TIMEZONES = (() => {
      let supported = [];
      try {
        if (typeof Intl.supportedValuesOf === 'function') supported = Intl.supportedValuesOf('timeZone');
      } catch (_) { /* use the detected zone when timezone enumeration is unavailable */ }
      const common = [
        'Africa/Cairo', 'Africa/Johannesburg', 'America/Los_Angeles',
        'America/New_York', 'America/Sao_Paulo', 'Asia/Dubai',
        'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney',
        'Europe/Berlin', 'Europe/London', 'Europe/Paris',
      ];
      return [...new Set(['UTC', pending.timezone, ...common, ...supported])].filter(Boolean).sort();
    })();

    // ── Step chrome ──────────────────────────────────────────────────────
    let step = 0;
    const LAST_STEP = 6;

    const top = createEl('div', { className: 'nvsetup-top' });
    const brand = createEl('div', { className: 'nvsetup-brand' });
    const logo = createEl('span', { className: 'nvsetup-logo', 'aria-hidden': 'true' });
    logo.innerHTML = svgIcon(SETUP_ICON, 22);
    brand.append(logo, createEl('span', { textContent: 'NovaByte Setup' }));
    const dots = createEl('div', { className: 'nvsetup-progress', role: 'progressbar', 'aria-label': _t('setup.progressAria') });
    for (let i = 0; i <= LAST_STEP; i++) {
      dots.appendChild(createEl('div', { className: 'nvsetup-dot' }));
    }
    top.append(brand, dots);
    root.appendChild(top);

    const body = createEl('div', { className: 'nvsetup-body' });
    root.appendChild(body);

    const bottom = createEl('div', { className: 'nvsetup-bottom' });
    const backBtn = createEl('button', { className: 'nvsetup-btn ghost', textContent: _t('setup.back'), 'aria-label': _t('setup.backAria') });
    const skipBtn = createEl('button', { className: 'nvsetup-btn ghost', textContent: _t('setup.skip'), 'aria-label': _t('setup.skipAria') });
    const nextBtn = createEl('button', { className: 'nvsetup-btn primary', textContent: _t('setup.next'), 'aria-label': _t('setup.nextAria') });
    bottom.append(backBtn, skipBtn, nextBtn);
    root.appendChild(bottom);

    function renderDots() {
      [...dots.children].forEach((dot, i) => dot.classList.toggle('on', i <= step));
    }

    function setButtons({ next = _t('setup.next'), nextDisabled = false, skip = false, back = true } = {}) {
      nextBtn.textContent = next;
      nextBtn.disabled = nextDisabled;
      skipBtn.style.visibility = skip ? 'visible' : 'hidden';
      backBtn.style.visibility = back ? 'visible' : 'hidden';
    }

    // ── Step 1: Welcome ───────────────────────────────────────────────────
    function stepWelcome() {
      const card = createEl('div', { className: 'nvsetup-card' });
      const title = createEl('h1', { className: 'nvsetup-title', textContent: _t('setup.welcome.title') });
      const sub = createEl('div', { className: 'nvsetup-sub', textContent: _t('setup.welcome.sub') });

      // Language picker — switching re-localises the ENTIRE wizard live
      // (and every other shell surface) through NovaI18n.changeLanguage.
      // persist:false because the owner's registry hive is not mounted
      // yet — finish() writes the final choice with the other preferences.
      const languageLabel = createEl('label', { className: 'nvsetup-label', htmlFor: 'nvsetup-language', textContent: _t('setup.welcome.language') });
      const languageSelect = createEl('select', {
        id: 'nvsetup-language',
        className: 'nvsetup-input nvsetup-layout',
        'aria-label': _t('setup.welcome.languageAria'),
      });
      const languages = (typeof window.NovaI18n?.getLanguages === 'function')
        ? window.NovaI18n.getLanguages()
        : [{ code: 'en' }];
      for (const language of languages) {
        languageSelect.appendChild(createEl('option', {
          value: language.code,
          textContent: language.nativeName || language.code,
        }));
      }
      languageSelect.value = pending.language;
      languageSelect.addEventListener('change', () => {
        pending.language = languageSelect.value;
        if (typeof window.NovaI18n?.changeLanguage === 'function') {
          window.NovaI18n.changeLanguage(languageSelect.value, { persist: false })
            .catch(err => console.warn('[NovaByteSetup] Language switch failed:', err));
        }
      });

      const layoutLabel = createEl('label', { className: 'nvsetup-label', htmlFor: 'nvsetup-keyboard-layout', textContent: _t('setup.welcome.keyboardLayout') });
      const layoutSelect = createEl('select', {
        id: 'nvsetup-keyboard-layout',
        className: 'nvsetup-input nvsetup-layout',
        'aria-label': _t('setup.welcome.keyboardAria'),
      });
      for (const layout of KEYBOARD_LAYOUTS) {
        layoutSelect.appendChild(createEl('option', {
          value: layout.code,
          textContent: layout.label,
        }));
      }
      layoutSelect.value = pending.keyboardLayout;
      layoutSelect.addEventListener('change', () => { pending.keyboardLayout = layoutSelect.value; });

      card.append(title, sub, languageLabel, languageSelect, layoutLabel, layoutSelect);
      body.replaceChildren(card);
      setButtons({ next: _t('setup.welcome.start') });
      title.setAttribute('tabindex', '-1');
      title.focus();
    }

    // ── Step 2: Network ──────────────────────────────────────────────────
    function stepNetwork() {
      const card = createEl('div', { className: 'nvsetup-card nvsetup-center' });
      const icon = createEl('div', { className: 'nvsetup-neticon', textContent: '🌐', 'aria-hidden': 'true' });
      const title = createEl('h1', { className: 'nvsetup-title', textContent: _t('setup.network.title') });
      const sub = createEl('div', { className: 'nvsetup-sub', textContent: _t('setup.network.sub') });
      const status = createEl('div', { className: 'nvsetup-status', role: 'status', 'aria-live': 'polite' });

      const refresh = createEl('button', { className: 'nvsetup-btn', textContent: _t('setup.network.checkAgain'), 'aria-label': _t('setup.network.checkAgainAria') });
      refresh.addEventListener('click', () => check());

      card.append(icon, title, sub, status, refresh);
      body.replaceChildren(card);
      setButtons({ next: _t('setup.next'), skip: true });

      async function check() {
        status.className = 'nvsetup-status';
        status.textContent = _t('setup.network.checking');
        const nm = window.NovaByteSystem?.hardware?.network;
        if (nm && typeof nm.getStatus === 'function') {
          try {
            const s = await nm.getStatus();
            if (s?.connectivity === 'full') {
              status.className = 'nvsetup-status ok';
              status.textContent = _t('setup.network.connectedInternet');
            } else if (s?.connectivity === 'limited' || s?.connectivity === 'portal') {
              status.textContent = _t('setup.network.connectedNoInternet');
            } else if (/^connected/.test(String(s?.networkState || ''))) {
              status.className = 'nvsetup-status ok';
              status.textContent = _t('setup.network.connectedNetwork');
            } else {
              status.textContent = _t('setup.network.notConnected');
            }
            return;
          } catch (_) { /* fall through */ }
        }
        status.textContent = navigator.onLine ? _t('setup.network.connectedNetwork') : _t('setup.network.notConnected');
      }
      check();
    }

    // ── Step 3: Date and Region ───────────────────────────────────────────
    function stepDateAndRegion() {
      const card = createEl('div', { className: 'nvsetup-card' });
      const title = createEl('h1', { className: 'nvsetup-title', textContent: _t('setup.region.title') });
      const sub = createEl('div', { className: 'nvsetup-sub', textContent: _t('setup.region.sub') });
      const regionLabel = createEl('label', { className: 'nvsetup-label', htmlFor: 'nvsetup-region', textContent: _t('setup.region.regionFormat') });
      const regionSelect = createEl('select', {
        id: 'nvsetup-region',
        className: 'nvsetup-input nvsetup-layout',
        'aria-label': _t('setup.region.regionFormatAria'),
      });
      const regions = [...REGIONS];
      if (!regions.some(([code]) => code === pending.region)) {
        regions.push([pending.region, pending.region]);
      }
      for (const [code, label] of regions) {
        regionSelect.appendChild(createEl('option', { value: code, textContent: label }));
      }
      regionSelect.value = pending.region;
      regionSelect.addEventListener('change', () => { pending.region = regionSelect.value; });

      const timezoneLabel = createEl('label', { className: 'nvsetup-label', htmlFor: 'nvsetup-timezone', textContent: _t('setup.region.timezone') });
      const timezoneSelect = createEl('select', {
        id: 'nvsetup-timezone',
        className: 'nvsetup-input nvsetup-layout',
        'aria-label': _t('setup.region.timezone'),
      });
      for (const timezone of TIMEZONES) {
        timezoneSelect.appendChild(createEl('option', { value: timezone, textContent: timezone }));
      }
      timezoneSelect.value = pending.timezone;
      timezoneSelect.addEventListener('change', () => { pending.timezone = timezoneSelect.value; });

      card.append(title, sub, regionLabel, regionSelect, timezoneLabel, timezoneSelect);
      body.replaceChildren(card);
      setButtons({ next: _t('setup.next') });
      title.setAttribute('tabindex', '-1');
      title.focus();
    }

    // ── Step 4: Data & privacy ────────────────────────────────────────────
    function stepPrivacy() {
      const card = createEl('div', { className: 'nvsetup-card' });
      const title = createEl('h1', { className: 'nvsetup-title', textContent: _t('setup.privacy.title') });
      const sub = createEl('div', { className: 'nvsetup-sub', textContent: _t('setup.privacy.sub') });

      const note = createEl('div', { className: 'nvsetup-note' });
      note.innerHTML = '';
      note.appendChild(createEl('div', { textContent: _t('setup.privacy.note') }));

      const mkRow = (heading, small, value, key, onToggle) => {
        const row = createEl('button', { className: 'nvsetup-row', type: 'button', 'aria-pressed': String(value) });
        const text = createEl('span', { className: 'nvsetup-row-text' });
        text.append(
          Object.assign(createEl('b'), { textContent: heading }),
          Object.assign(createEl('small'), { textContent: small }),
        );
        const sw = createEl('span', { className: 'nvsetup-switch', 'aria-hidden': 'true' });
        row.append(text, sw);
        row.addEventListener('click', () => {
          const now = row.getAttribute('aria-pressed') !== 'true';
          row.setAttribute('aria-pressed', String(now));
          pending[key] = now;
          onToggle?.(now);
        });
        return row;
      };
      const guestRow = mkRow(_t('setup.privacy.guestAccess'), _t('setup.privacy.guestAccessSub'), pending.guestAccess, 'guestAccess');

      card.append(title, sub, note, guestRow);
      body.replaceChildren(card);
      setButtons({ next: _t('setup.next') });
      title.setAttribute('tabindex', '-1');
      title.focus();
    }

    // ── Step 5: Owner account ────────────────────────────────────────────
    function stepAccount() {
      const card = createEl('div', { className: 'nvsetup-card' });
      const title = createEl('h1', { className: 'nvsetup-title', textContent: _t('setup.account.title') });
      const sub = createEl('div', { className: 'nvsetup-sub', textContent: _t('setup.account.sub') });

      const display = createEl('input', { className: 'nvsetup-input', type: 'text', placeholder: _t('setup.account.namePlaceholder'), autocomplete: 'name', maxLength: 64 });
      const username = createEl('input', { className: 'nvsetup-input', type: 'text', placeholder: _t('setup.account.usernamePlaceholder'), autocomplete: 'username', maxLength: 32, spellcheck: 'false' });
      const pin = createEl('input', { className: 'nvsetup-input', type: 'password', placeholder: _t('setup.account.pinPlaceholder'), inputMode: 'numeric', pattern: '[0-9]*', maxLength: 6, autocomplete: 'new-password' });
      const pin2 = createEl('input', { className: 'nvsetup-input', type: 'password', placeholder: _t('setup.account.confirmPinPlaceholder'), inputMode: 'numeric', pattern: '[0-9]*', maxLength: 6, autocomplete: 'new-password' });
      const pass = createEl('input', { className: 'nvsetup-input', type: 'password', placeholder: _t('setup.account.passphrasePlaceholder'), autocomplete: 'new-password' });

      const nameRow = createEl('div');
      nameRow.append(
        Object.assign(createEl('div', { className: 'nvsetup-label', textContent: _t('setup.account.yourName') })),
        display,
      );
      const userRow = createEl('div');
      userRow.append(
        Object.assign(createEl('div', { className: 'nvsetup-label', textContent: _t('setup.account.usernameLabel') })),
        username,
      );
      const credsGrid = createEl('div', { className: 'nvsetup-grid2' });
      const pinBox = createEl('div');
      pinBox.append(Object.assign(createEl('div', { className: 'nvsetup-label', textContent: _t('setup.account.pin') })), pin);
      const pin2Box = createEl('div');
      pin2Box.append(Object.assign(createEl('div', { className: 'nvsetup-label', textContent: _t('setup.account.confirmPin') })), pin2);
      credsGrid.append(pinBox, pin2Box);
      const passRow = createEl('div');
      passRow.append(
        Object.assign(createEl('div', { className: 'nvsetup-label', textContent: _t('setup.account.passphraseLabel') })),
        pass,
      );

      const status = createEl('div', { className: 'nvsetup-status', role: 'status', 'aria-live': 'polite' });

      const validate = () => {
        pending.displayName = display.value.trim();
        pending.username = username.value.trim().toLowerCase();
        pending.pin = pin.value;
        pending.passphrase = pass.value;
        let ok = true;
        username.classList.toggle('bad', !!pending.username && !USERNAME_RE.test(pending.username));
        if (!pending.displayName) { ok = false; }
        if (!USERNAME_RE.test(pending.username)) { ok = false; }
        if (!/^\d{4,6}$/.test(pending.pin)) { ok = false; }
        if (pending.pin !== pin2.value) { ok = false; }
        if (pending.passphrase && pending.passphrase.length < 8) { ok = false; }
        nextBtn.disabled = !ok;
        return ok;
      };
      for (const input of [display, username, pin, pin2, pass]) {
        input.addEventListener('input', () => { status.textContent = ''; validate(); });
      }

      card.append(title, sub, nameRow, userRow, credsGrid, passRow, status);
      body.replaceChildren(card);
      setButtons({ next: _t('setup.account.createAccount'), nextDisabled: true });
      validate();
      display.focus();
    }

    async function createOwner(statusEl) {
      if (!manager || typeof manager.setupOwner !== 'function') {
        statusEl.textContent = _t('setup.account.sessionUnavailable');
        return false;
      }
      statusEl.textContent = _t('setup.account.creating');
      const result = await manager.setupOwner({
        displayName: pending.displayName,
        username: pending.username,
        pin: pending.pin,
        passphrase: pending.passphrase || undefined,
        avatar: String(pending.displayName).charAt(0).toUpperCase(),
      });
      if (result.ok) return true;
      statusEl.textContent = result.message || _t('setup.account.setupFailed');
      nextBtn.disabled = false;
      return false;
    }

    // ── Step 6: Appearance ────────────────────────────────────────────────
    function stepAppearance() {
      const card = createEl('div', { className: 'nvsetup-card' });
      const title = createEl('h1', { className: 'nvsetup-title', textContent: _t('setup.appearance.title') });
      const sub = createEl('div', { className: 'nvsetup-sub', textContent: _t('setup.appearance.sub') });

      const themeLabel = createEl('div', { className: 'nvsetup-label', textContent: _t('setup.appearance.theme') });
      const themeRows = createEl('div', { className: 'nvsetup-grid2 nvsetup-theme-options' });
      for (const theme of THEMES) {
        const btn = createEl('button', { className: 'nvsetup-row', type: 'button', 'aria-pressed': String(pending.theme === theme.id) });
        const text = createEl('span', { className: 'nvsetup-row-text' });
        text.append(Object.assign(createEl('b'), { textContent: theme.label }));
        btn.appendChild(text);
        btn.addEventListener('click', () => {
          pending.theme = theme.id;
          for (const other of themeRows.children) other.setAttribute('aria-pressed', 'false');
          btn.setAttribute('aria-pressed', 'true');
        });
        themeRows.appendChild(btn);
      }

      const accentLabel = createEl('div', { className: 'nvsetup-label', textContent: _t('setup.appearance.accent') });
      const swatches = createEl('div', { className: 'nvsetup-swatches', role: 'radiogroup', 'aria-label': _t('setup.appearance.accentAria') });
      for (const accent of ACCENTS) {
        const sw = createEl('button', {
          className: 'nvsetup-swatch' + (accent === pending.accent ? ' on' : ''),
          type: 'button',
          role: 'radio',
          'aria-checked': String(accent === pending.accent),
          'aria-label': `Accent ${accent}`,
        });
        sw.style.background = accent;
        sw.addEventListener('click', () => {
          pending.accent = accent;
          for (const other of swatches.children) other.classList.remove('on');
          sw.classList.add('on');
        });
        swatches.appendChild(sw);
      }

      card.append(title, sub, themeLabel, themeRows, accentLabel, swatches);
      body.replaceChildren(card);
      setButtons({ next: _t('setup.next') });
      title.setAttribute('tabindex', '-1');
      title.focus();
    }

    // ── Step 7: All set ───────────────────────────────────────────────────
    function stepDone() {
      const card = createEl('div', { className: 'nvsetup-done' });
      const big = createEl('div', { className: 'nvsetup-big', textContent: '\u2705', 'aria-hidden': 'true' });
      const title = createEl('h1', { className: 'nvsetup-title', textContent: _t('setup.done.title') });
      const sub = createEl('div', { className: 'nvsetup-sub', textContent: _t('setup.done.sub', {
        name: pending.displayName || 'owner',
        username: pending.username || 'owner',
      }) });
      card.append(big, title, sub);
      body.replaceChildren(card);
      setButtons({ next: _t('setup.done.finish'), skip: false, back: false });
      title.setAttribute('tabindex', '-1');
      title.focus();
    }

    async function finish() {
      // Preferences are applied AFTER the account mount: the owner's hive
      // is the mounted settings store by now, so these writes land in the
      // owner's own registry rather than the machine store.
      try {
        OS.settings.set('theme', pending.theme);
        OS.settings.set('accentColor', pending.accent);
        OS.settings.set('keyboardLayout', pending.keyboardLayout);
        OS.settings.set('region', pending.region);
        OS.settings.set('timezone', pending.timezone);
        OS.settings.set('language', pending.language);
        OS.settings.set('doNotDisturb', false);
      } catch (err) {
        console.warn('[NovaByteSetup] Preference apply failed:', err);
      }
      // Guest access is a machine policy — admin route, best effort.
      // PUT /admin/policies takes the patch DIRECTLY as the JSON body
      // (same contract as the Users app's policies.set); wrapping it in
      // a { policies: ... } envelope is rejected by setPolicies as an
      // unknown 'policies' key — 400 INVALID_POLICY.
      try {
        if (manager && typeof manager.authFetch === 'function' && manager.isAdmin?.()) {
          await manager.authFetch('/api/auth/admin/policies', {
            method: 'PUT',
            body: { guestAccess: pending.guestAccess === true },
          });
        }
      } catch (err) {
        console.warn('[NovaByteSetup] Guest-access policy apply failed:', err);
      }
      try {
        EventLog?.log?.({ app: 'NovaByte Setup', category: 'system', severity: 'info', message: 'First-boot setup complete', data: { username: pending.username } });
      } catch (_) { }

      // Close the wizard window — the desktop mounted by setupOwner is the
      // surface that remains. WM.closeWindow no-ops safely if the window is
      // already gone (e.g. the user closed it themselves mid-finish).
      try {
        if (typeof WM !== 'undefined' && typeof WM.closeWindow === 'function') {
          WM.closeWindow(state.id);
        }
      } catch (_) { }
    }

    // ── Completed state (launched after setup already ran) ────────────────
    async function renderCompleted() {
      root.replaceChildren();
      const wrap = createEl('div', { className: 'nvsetup-body' });
      const card = createEl('div', { className: 'nvsetup-done' });
      card.append(
        Object.assign(createEl('div', { className: 'nvsetup-big', textContent: '\uD83D\uDD27', 'aria-hidden': 'true' })),
        Object.assign(createEl('h1', { className: 'nvsetup-title', textContent: _t('setup.completed.title') })),
        Object.assign(createEl('div', { className: 'nvsetup-sub', textContent: _t('setup.completed.sub') })),
      );
      wrap.appendChild(card);
      root.appendChild(wrap);
      const bar = createEl('div', { className: 'nvsetup-bottom' });
      const close = createEl('button', { className: 'nvsetup-btn primary', textContent: _t('setup.completed.close'), 'aria-label': _t('setup.completed.closeAria') });
      close.addEventListener('click', () => {
        if (typeof WM !== 'undefined' && typeof WM.closeWindow === 'function') WM.closeWindow(state.id);
      });
      bar.appendChild(close);
      root.appendChild(bar);
    }

    // ── Step driver ───────────────────────────────────────────────────────
    const steps = [stepWelcome, stepNetwork, stepDateAndRegion, stepPrivacy, stepAccount, stepAppearance, stepDone];

    async function goTo(next) {
      if (next === step) return;
      if (next > step && step === 4) {
        // Leaving the account step: create the owner first.
        const statusEl = body.querySelector('.nvsetup-status');
        if (statusEl && !(await createOwner(statusEl))) return;
      }
      if (next === 6) {
        // Entering the final step: the mount sequence has already run
        // (setupOwner awaited it); nothing else to do here.
      }
      step = Math.min(Math.max(next, 0), LAST_STEP);
      renderDots();
      steps[step]();
    }

    nextBtn.addEventListener('click', () => {
      if (step === LAST_STEP) { nextBtn.disabled = true; finish(); return; }
      goTo(step + 1);
    });
    backBtn.addEventListener('click', () => { goTo(step - 1); });
    skipBtn.addEventListener('click', () => {
      if (step === 1) { pending.networkSkipped = true; goTo(step + 1); }
    });

    content.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !nextBtn.disabled && step !== 3) { e.preventDefault(); nextBtn.click(); }
    });

    // ── Entry decision: wizard or completed state ───────────────────────
    if (!multiUser || !manager) {
      renderCompleted();
      return;
    }
    try {
      const accounts = await manager.listAccounts();
      const hasAccounts = Array.isArray(accounts?.users) && accounts.users.length > 0;
      if (hasAccounts) { renderCompleted(); return; }
    } catch (_) { /* fall through to the wizard — the picker will re-gate */ }

    renderDots();
    stepWelcome();

    // Live re-localisation: when the language changes on the Welcome step
    // (the only step that hosts the picker), re-render the current step and
    // the shared chrome so the wizard itself switches language instantly.
    try {
      OS.events?.on?.('languageChanged', () => {
        if (!content.isConnected) return;
        if (step === 0) {
          renderDots();
          steps[step]();
        }
        backBtn.textContent = _t('setup.back');
        backBtn.setAttribute('aria-label', _t('setup.backAria'));
        skipBtn.textContent = _t('setup.skip');
        skipBtn.setAttribute('aria-label', _t('setup.skipAria'));
        dots.setAttribute('aria-label', _t('setup.progressAria'));
      });
    } catch (_) { /* event bus unavailable (tests) */ }
  },
});
