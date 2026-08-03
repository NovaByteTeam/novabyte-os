  // this is a single static page with no build step, so "module" here just
  // buys us top-level scoping (nothing leaks onto window) rather than actual
  // imports — there's nothing else to import from.

  const reduceMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');

  // repo/contents/commits calls go through this Worker instead of hitting
  // api.github.com directly — it holds the real GitHub token server-side
  // and only forwards the three route shapes it allowlists (see worker.js)
  const GH_PROXY = 'https://nbosp-github-proxy.novabyteofficial.workers.dev';

  function ghHeaders() {
    return {
      Accept: 'application/vnd.github+json',
    };
  }

  /* ----------------------------------------------------------------------
   * boot sequence: types the two hero commands out like someone's actually
   * typing them, THEN reveals the output lines, THEN starts the blinking
   * cursor. if the person has reduced motion on, skip straight to the
   * finished state — no point making someone sit through a fake typing
   * animation they explicitly asked their OS not to show them.
   * ------------------------------------------------------------------- */
  async function typeOutBootSequence(container) {
    const bootScript = [
      { kind: 'command', text: 'git clone https://github.com/NovaByteTeam/novabyte-os.git' },
      { kind: 'command', text: 'cd novabyte-os/NBOSP && npm start' },
      { kind: 'lines', text: '> novabyte-server@3.0.2 prestart\n> node scripts/bootstrap.js\n[bootstrap] Running npm ci...\n> novabyte-server@3.0.2 start\n> nw .' },
    ];

    if (reduceMotionQuery.matches) {
      renderBootSequenceInstantly(container, bootScript);
      return;
    }

    await renderBootSequenceTyped(container, bootScript);
  }

  function renderBootSequenceInstantly(container, bootScript) {
    for (const entry of bootScript) {
      if (entry.kind === 'command') {
        container.append(buildCommandLine(entry.text));
      } else if (entry.kind === 'lines') {
        for (const lineEl of buildOutputLines(entry.text)) {
          lineEl.classList.add('is-visible');
          container.append(lineEl);
        }
      } else {
        const outputEl = buildOutputBlock(entry.text);
        outputEl.classList.add('is-visible');
        container.append(outputEl);
      }
    }
    container.append(buildPromptWithCursor());
  }

  function buildCommandLine(commandText) {
    const line = document.createElement('div');
    line.className = 'terminal-line';
    line.innerHTML = `<span class="terminal-prompt">$</span><span class="terminal-cmd"></span>`;
    // textContent, not innerHTML, for the actual typed text — this is the
    // one spot where the string genuinely comes from a fixed array we
    // wrote ourselves, but keeping the habit here means copy-pasting this
    // function into something with real user input doesn't silently
    // reopen an XSS hole
    line.querySelector('.terminal-cmd').textContent = commandText;
    return line;
  }

  function buildOutputBlock(outputText) {
    const block = document.createElement('div');
    block.className = 'terminal-output';
    block.textContent = outputText;
    return block;
  }

  // same visual treatment as buildOutputBlock (one .terminal-output per
  // line) but returns an array so the caller can reveal them one at a time
  // instead of the whole block fading in as a single lump
  function buildOutputLines(outputText) {
    return outputText.split('\n').map((line) => {
      const block = document.createElement('div');
      block.className = 'terminal-output';
      block.textContent = line;
      return block;
    });
  }

  function buildPromptWithCursor() {
    const line = document.createElement('div');
    line.className = 'terminal-line';
    line.innerHTML = `<span class="terminal-prompt">$</span><span class="cursor-blink"></span>`;
    return line;
  }

  async function renderBootSequenceTyped(container, bootScript) {
    const millisecondsPerKeystroke = 18;
    const pauseAfterCommand = 280;

    for (const entry of bootScript) {
      if (entry.kind === 'command') {
        const line = document.createElement('div');
        line.className = 'terminal-line';
        const promptSpan = document.createElement('span');
        promptSpan.className = 'terminal-prompt';
        promptSpan.textContent = '$';
        const cmdSpan = document.createElement('span');
        cmdSpan.className = 'terminal-cmd';
        line.append(promptSpan, cmdSpan);
        container.append(line);

        // type character by character — genuinely the slow way to build a
        // string, but it's the whole point of the effect
        for (const character of entry.text) {
          cmdSpan.textContent += character;
          await wait(millisecondsPerKeystroke);
        }
        await wait(pauseAfterCommand);
      } else if (entry.kind === 'lines') {
        // same fade-in as regular output, but one line at a time so a
        // multi-line block (like the npm/bootstrap log) reads as it's
        // "happening" rather than dumping in as one lump
        const pauseBetweenLines = 140;
        for (const lineEl of buildOutputLines(entry.text)) {
          container.append(lineEl);
          lineEl.offsetHeight;
          lineEl.classList.add('is-visible');
          await wait(pauseBetweenLines);
        }
        await wait(pauseAfterCommand);
      } else {
        const outputBlock = buildOutputBlock(entry.text);
        container.append(outputBlock);
        // force a reflow before adding is-visible, otherwise the browser
        // can coalesce "add to DOM" and "make visible" into one frame and
        // the fade transition never actually plays
        outputBlock.offsetHeight;
        outputBlock.classList.add('is-visible');
        await wait(pauseAfterCommand);
      }
    }

    container.append(buildPromptWithCursor());
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  /* ----------------------------------------------------------------------
   * release forwards-filled entrance animations once they finish.
   * `animation-fill-mode: forwards` is what stops the terminal from
   * flashing invisible before JS runs, but it also pins the element to its
   * own compositing layer forever — even at rest — which breaks
   * backdrop-filter for .glass elements nested inside it (confirmed via
   * isolated testing: same structure works fine once the animation is
   * actually cleared instead of held via forwards). so: let the animation
   * play with forwards as the safe default, then the instant it ends, copy
   * its final state into plain inline styles and clear the animation.
   * there's no gap between "remove forwards" and "set final state" because
   * both happen in the same animationend handler, same tick.
   * ------------------------------------------------------------------- */
  function wireUpAnimationRelease() {
    document.querySelectorAll('.terminal-wrap').forEach((el) => {
      el.addEventListener('animationend', () => {
        el.style.opacity = '1';
        el.style.translate = '0 0';
        el.style.animation = 'none';
      });
    });

    // same fix for .reveal-on-scroll wrappers, but ONLY the ones that
    // actually contain a .glass descendant (right now: the split-card
    // wrappers) — every other .reveal-on-scroll on the page doesn't have
    // this bug, so leave their animation-timeline: view() behavior
    // (including re-triggering on scroll-back-up) untouched.
    document.querySelectorAll('.reveal-on-scroll').forEach((el) => {
      if (!el.querySelector('.glass')) return;
      el.addEventListener('animationend', () => {
        el.style.opacity = '1';
        el.style.translate = '0 0';
        el.style.animation = 'none';
      });
    });
  }

  /* ----------------------------------------------------------------------
   * cursor-tracked glow: one listener for the whole page, throttled to
   * animation frames. every .glow-surface element just reads the same two
   * custom properties, so this scales to as many glowing cards as we want
   * without adding more listeners.
   * ------------------------------------------------------------------- */
  function wireUpGlowTracking() {
    let pendingFrame = null;

    document.addEventListener('pointermove', (event) => {
      if (pendingFrame) return; // already have a frame queued, skip this event
      pendingFrame = requestAnimationFrame(() => {
        updateNearestGlowSurface(event.clientX, event.clientY);
        pendingFrame = null;
      });
    }, { passive: true });
  }

  function updateNearestGlowSurface(pointerX, pointerY) {
    // elementsFromPoint gives us everything under the cursor in paint
    // order, so we can find the actual glow-surface the user is over
    // instead of guessing from bounding boxes
    const hits = document.elementsFromPoint(pointerX, pointerY);
    const surface = hits.find((el) => el.classList?.contains('glow-surface'));
    if (!surface) return;

    const rect = surface.getBoundingClientRect();
    const relativeX = ((pointerX - rect.left) / rect.width) * 100;
    const relativeY = ((pointerY - rect.top) / rect.height) * 100;
    surface.style.setProperty('--pointer-x', `${relativeX}%`);
    surface.style.setProperty('--pointer-y', `${relativeY}%`);
  }

  /* ----------------------------------------------------------------------
   * section navigation: the page shows exactly one of hero/[section] at a
   * time instead of one long scroll. showSection() is the single source of
   * truth — it drives visibility, which nav link is highlighted, and the
   * URL hash — so every entry point (nav panel, command palette, in-page
   * links, browser back/forward) goes through the same function rather
   * than each having its own scroll-to or show/hide logic that can drift
   * out of sync with the others.
   * ------------------------------------------------------------------- */
  const SECTION_IDS = ['what', 'apps', 'themes', 'architecture', 'browse',
    'requirements', 'versions', 'downloads', 'faq', 'license', 'start'];

  function showSection(id) {
    const hero = document.querySelector('.hero');
    const targetIsValid = SECTION_IDS.includes(id);

    if (hero) hero.hidden = targetIsValid;
    for (const sectionId of SECTION_IDS) {
      const section = document.getElementById(sectionId);
      if (section) section.hidden = sectionId !== id;
    }

    // sections start hidden, so anything inside them using the JS
    // scroll-reveal fallback (browsers without animation-timeline: view()
    // support) never intersects the viewport and never gets its
    // IntersectionObserver-driven .is-revealed class. There's no actual
    // scrolling happening when a section is switched in, so just reveal
    // its content immediately rather than trying to re-trigger a
    // scroll-based fade that no longer makes sense in this model.
    const shownSection = targetIsValid ? document.getElementById(id) : hero;
    shownSection?.querySelectorAll('.needs-js-reveal').forEach((el) => {
      el.classList.add('is-revealed');
    });

    for (const link of document.querySelectorAll('[data-nav-link]')) {
      const linkId = link.getAttribute('href').replace('#', '');
      link.classList.toggle('is-active', linkId === id);
    }

    // pushState instead of assigning location.hash — assigning the hash
    // directly triggers the browser's native "jump to anchor" scroll
    // behavior, which we don't want since we're doing visibility instead
    // of scrolling; pushState updates the URL without that side effect
    const newHash = targetIsValid ? `#${id}` : '';
    if (location.hash !== newHash) {
      history.pushState({ sectionId: targetIsValid ? id : null }, '', newHash || location.pathname + location.search);
    }

    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  // shows whatever section matches the current URL hash, or the hero if
  // the hash is empty/unrecognized — shared by initial page load and
  // browser back/forward navigation so both paths stay in sync
  function showSectionFromHash() {
    const id = location.hash.replace('#', '');
    showSection(SECTION_IDS.includes(id) ? id : null);
  }

  function wireUpNav() {
    const toggle   = document.querySelector('[data-nav-toggle]');
    const panel    = document.querySelector('[data-nav-panel]');
    const backdrop = document.querySelector('[data-nav-panel-backdrop]');
    if (!toggle || !panel) return;

    function setOpen(open) {
      panel.classList.toggle('is-open', open);
      backdrop?.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
    }

    toggle.addEventListener('click', () => {
      setOpen(!panel.classList.contains('is-open'));
    });

    backdrop?.addEventListener('click', () => setOpen(false));

    // every nav link routes through showSection instead of letting the
    // browser natively jump-scroll to the anchor, and closes the panel
    // after — same as before, just show/hide instead of scroll
    for (const link of document.querySelectorAll('[data-nav-link]')) {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        showSection(link.getAttribute('href').replace('#', ''));
        setOpen(false);
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setOpen(false);
    });

    // any other in-page anchor link (e.g. the hero's "Run it locally"
    // button) needs the same treatment — anything with data-nav-link is
    // already handled above, this catches the rest
    document.querySelectorAll('a[href^="#"]:not([data-nav-link])').forEach((link) => {
      const id = link.getAttribute('href').replace('#', '');
      if (!SECTION_IDS.includes(id)) return;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        showSection(id);
      });
    });

    window.addEventListener('popstate', showSectionFromHash);
    showSectionFromHash();
  }

  /* ----------------------------------------------------------------------
   * dev-mode accordion: grid-rows trick handles the actual animation in
   * CSS, this just flips the class and keeps aria-expanded honest.
   * ------------------------------------------------------------------- */
  function wireUpDevAccordion() {
    const trigger = document.querySelector('[data-accordion-trigger]');
    const shell = document.querySelector('[data-accordion-shell]');
    const label = document.querySelector('[data-toggle-label]');
    if (!trigger || !shell || !label) return;

    trigger.addEventListener('click', () => {
      const isOpen = shell.classList.toggle('is-open');
      trigger.setAttribute('aria-expanded', String(isOpen));
      label.textContent = isOpen ? 'Hide Developer Mode apps' : 'Show Developer Mode apps';
    });
  }

  /* ----------------------------------------------------------------------
   * scroll reveal fallback: only runs its course on browsers that don't
   * support animation-timeline: view() — see the @supports split in the
   * stylesheet. browsers with native support never load this listener's
   * work into anything visible, since .needs-js-reveal never gets the
   * opacity:0 starting state there.
   * ------------------------------------------------------------------- */
  function wireUpScrollRevealFallback() {
    const supportsNativeScrollTimeline = CSS.supports('animation-timeline: view()');
    if (supportsNativeScrollTimeline) return;

    const revealTargets = document.querySelectorAll('.reveal-on-scroll.needs-js-reveal');
    if (revealTargets.length === 0) return;

    const watcher = new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-revealed');
        observer.unobserve(entry.target); // reveal once, then stop watching
      }
    }, { threshold: 0.15 });

    for (const target of revealTargets) watcher.observe(target);
  }

  /* ----------------------------------------------------------------------
   * copy-to-clipboard on the install codeblock
   * ------------------------------------------------------------------- */
  function wireUpCopyButton() {
    const button = document.querySelector('[data-copy-trigger]');
    const block = document.querySelector('[data-copy-target]');
    if (!button || !block) return;

    button.addEventListener('click', async () => {
      // pull the command text back out, skipping the button itself and
      // the comment line — just the actual commands someone would run
      const commandLines = [...block.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent.trim())
        .filter(Boolean);

      try {
        await navigator.clipboard.writeText(commandLines.join('\n'));
        button.textContent = 'Copied';
        button.classList.add('did-copy');
        await wait(1600);
        button.textContent = 'Copy';
        button.classList.remove('did-copy');
      } catch (error) {
        // clipboard API can fail on insecure origins or denied permission —
        // fail quietly rather than throwing an error at someone trying to
        // run a getting-started command
        console.error('clipboard write failed:', error);
        button.textContent = 'Copy failed';
        await wait(1600);
        button.textContent = 'Copy';
      }
    });
  }

  /* ----------------------------------------------------------------------
   * downloads: fetches the latest release straight from GitHub's public
   * API client-side, so asset names/sizes/checksums/links stay accurate
   * forever instead of being hand-typed here and going stale. GitHub's
   * unauthenticated API caps out at 60 req/hour per visitor IP — fine for
   * a low-traffic project page, but real people WILL occasionally hit it,
   * so a failed or rate-limited call falls back to a plain link out to
   * the releases page rather than showing a broken empty state.
   * ------------------------------------------------------------------- */
  const PLATFORM_MATCHERS = [
    { test: /win/i,          label: 'Windows (x64)',       icon: '🪟' },
    { test: /osx|mac|darwin/i, label: 'macOS (Apple Silicon)', icon: '🍎' },
    { test: /linux/i,        label: 'Linux (x64)',         icon: '🐧' },
  ];

  function platformForAsset(name) {
    const match = PLATFORM_MATCHERS.find((p) => p.test.test(name));
    return match || { label: name, icon: '📦' };
  }

  function formatBytes(bytes) {
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(0)} MB`;
  }

  function formatReleaseDate(iso) {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  }

  async function wireUpDownloads() {
    const root = document.querySelector('[data-downloads-root]');
    if (!root) return;

    const loadingEl = root.querySelector('[data-downloads-loading]');
    const errorEl   = root.querySelector('[data-downloads-error]');
    const contentEl = root.querySelector('[data-downloads-content]');
    const tagEl     = root.querySelector('[data-downloads-tag]');
    const dateEl    = root.querySelector('[data-downloads-date]');
    const gridEl    = root.querySelector('[data-downloads-grid]');

    function showError() {
      loadingEl.hidden = true;
      errorEl.hidden = false;
    }

    function showContent() {
      loadingEl.hidden = true;
      // remove the error banner outright rather than just hiding it — a
      // hidden-attribute toggle is state that can regress; deleting the
      // node means there's nothing left to accidentally show again
      errorEl.remove();
      contentEl.hidden = false;
    }

    try {
      const res = await fetch('https://api.github.com/repos/NovaByteTeam/novabyte-os/releases/tags/NBOSP-PREBUILT', {
        headers: ghHeaders(),
      });

      // covers rate-limit (403) and any other non-2xx without guessing at
      // GitHub's exact error shape — we only need to know it didn't work
      if (!res.ok) {
        showError();
        return;
      }

      const release = await res.json();
      const assets = Array.isArray(release.assets) ? release.assets.filter(a => a.name.endsWith('.zip')) : [];

      if (assets.length === 0) {
        showError();
        return;
      }

      tagEl.textContent = release.tag_name || 'Latest';
      dateEl.textContent = release.published_at ? `Updated ${formatReleaseDate(release.published_at)}` : '';

      gridEl.innerHTML = '';
      for (const asset of assets) {
        const platform = platformForAsset(asset.name);
        const card = document.createElement('a');
        card.className = 'download-card glow-surface glass';
        card.href = asset.browser_download_url;
        card.setAttribute('rel', 'noopener noreferrer');

        const glowLayer = document.createElement('div');
        glowLayer.className = 'glow-layer';

        const platformRow = document.createElement('div');
        platformRow.className = 'platform';
        platformRow.textContent = `${platform.icon} ${platform.label}`;

        const filename = document.createElement('div');
        filename.className = 'filename';
        filename.textContent = asset.name;

        const filesize = document.createElement('div');
        filesize.className = 'filesize';
        filesize.textContent = formatBytes(asset.size);

        card.append(glowLayer, platformRow, filename, filesize);
        gridEl.appendChild(card);
      }

      showContent();
    } catch (error) {
      // network failure, blocked request, malformed JSON — all land here
      console.error('[NovaByte] downloads fetch failed:', error);
      showError();
    }
  }

  /* ----------------------------------------------------------------------
   * app filter: plain substring match against each row's data-app-keywords
   * (falls back to the visible name/desc text if keywords are missing).
   * hides non-matching rows rather than re-rendering the list — the rows
   * already exist in the DOM, so this is just a hidden-attribute toggle.
   * ------------------------------------------------------------------- */
  function wireUpAppFilter() {
    const input = document.querySelector('[data-app-filter-input]');
    const rows  = document.querySelectorAll('[data-app-row]');
    const count = document.querySelector('[data-app-filter-count]');
    const empty = document.querySelector('[data-app-filter-empty]');
    const emptyTerm = document.querySelector('[data-app-filter-empty-term]');
    if (!input || !rows.length) return;

    function applyFilter() {
      const term = input.value.trim().toLowerCase();
      let visible = 0;

      for (const row of rows) {
        const haystack = (row.dataset.appKeywords || row.textContent).toLowerCase();
        const matches = term === '' || haystack.includes(term);
        row.hidden = !matches;
        if (matches) visible++;
      }

      count.textContent = term ? `${visible} match${visible === 1 ? '' : 'es'}` : '';
      if (empty) {
        empty.hidden = visible !== 0 || term === '';
        if (emptyTerm) emptyTerm.textContent = input.value.trim();
      }
    }

    input.addEventListener('input', applyFilter);
  }

  /* ----------------------------------------------------------------------
   * theme/accent preview: tints THIS page (not the real OS) using the
   * exact --bg-base/--bg-elevated/--accent hex values pulled from
   * NBOSP/js/core/ui/desktop.js. purely cosmetic — swaps a few of our own
   * CSS variables, doesn't touch the site's actual token system.
   * ------------------------------------------------------------------- */
  function wireUpThemePreview() {
    const themeGrid  = document.querySelector('[data-theme-grid]');
    const accentGrid = document.querySelector('[data-accent-grid]');
    if (!themeGrid || !accentGrid) return;

    const root = document.documentElement;

    // this page's own token system is dark-first (--ink is near-white,
    // --bg-void is near-black), so previewing nova-light isn't just a
    // background swap — text/border tokens need to invert too, or you
    // get white text on a white background. these are the page's own
    // *original* dark values, captured once, so we can restore them
    // cleanly when the person switches back to any dark theme.
    const darkInkDefaults = {
      '--ink': getComputedStyle(root).getPropertyValue('--ink').trim(),
      '--ink-dim': getComputedStyle(root).getPropertyValue('--ink-dim').trim(),
      '--ink-faint': getComputedStyle(root).getPropertyValue('--ink-faint').trim(),
      '--border-hairline': getComputedStyle(root).getPropertyValue('--border-hairline').trim(),
      '--border-hairline-bright': getComputedStyle(root).getPropertyValue('--border-hairline-bright').trim(),
    };

    function setChecked(group, activeBtn) {
      for (const btn of group.querySelectorAll('[role="radio"]')) {
        btn.setAttribute('aria-checked', String(btn === activeBtn));
      }
    }

    themeGrid.addEventListener('click', (event) => {
      const btn = event.target.closest('.theme-swatch');
      if (!btn) return;
      const base = getComputedStyle(btn).getPropertyValue('--sw-base').trim();
      const elevated = getComputedStyle(btn).getPropertyValue('--sw-elevated').trim();
      const accent = getComputedStyle(btn).getPropertyValue('--sw-accent').trim();
      const isLight = btn.dataset.isLight === 'true';

      root.style.setProperty('--bg-void', base);
      root.style.setProperty('--bg-panel', elevated);
      root.style.setProperty('--bg-panel-raised', elevated);
      root.style.setProperty('--glow-primary', accent);
      root.style.setProperty('--glow-primary-soft', `color-mix(in oklch, ${accent} 12%, transparent)`);

      if (isLight) {
        root.style.setProperty('--ink', btn.dataset.ink);
        root.style.setProperty('--ink-dim', btn.dataset.inkDim);
        root.style.setProperty('--ink-faint', btn.dataset.inkFaint);
        root.style.setProperty('--border-hairline', btn.dataset.border);
        root.style.setProperty('--border-hairline-bright', btn.dataset.border);
      } else {
        for (const [prop, value] of Object.entries(darkInkDefaults)) {
          root.style.setProperty(prop, value);
        }
      }

      setChecked(themeGrid, btn);
      // switching theme resets which accent reads as "active" back to
      // that theme's own default, same behavior as the real Settings app
      setChecked(accentGrid, accentGrid.querySelector(`[data-accent="${accent}"]`) || null);
    });

    accentGrid.addEventListener('click', (event) => {
      const btn = event.target.closest('.accent-swatch');
      if (!btn) return;
      const accent = btn.dataset.accent;
      root.style.setProperty('--glow-primary', accent);
      root.style.setProperty('--glow-primary-soft', `color-mix(in oklch, ${accent} 12%, transparent)`);
      setChecked(accentGrid, btn);
    });
  }

  /* ----------------------------------------------------------------------
   * command palette: native <dialog>, opened via Cmd/Ctrl+K or the header
   * button. results are just the page's own sections — filtered client
   * side, arrow-key navigable, no framework needed for six items.
   * ------------------------------------------------------------------- */
  function wireUpCommandPalette() {
    const dialog  = document.querySelector('[data-palette-dialog]');
    const trigger = document.querySelector('[data-palette-trigger]');
    const input   = document.querySelector('[data-palette-input]');
    const list    = document.querySelector('[data-palette-results]');
    const closeBtn = document.querySelector('[data-palette-close]');
    if (!dialog || !input || !list) return;

    const sections = [
      { id: 'what', title: 'What it is', desc: 'Who NBOSP is for' },
      { id: 'apps', title: 'Apps', desc: 'Fourteen apps, pulled from source' },
      { id: 'themes', title: 'Themes', desc: '7 themes, 8 accents — live preview' },
      { id: 'architecture', title: 'Architecture', desc: 'How the pieces talk to each other' },
      { id: 'browse', title: 'Browse', desc: 'Live file browser, pulled from GitHub' },
      { id: 'requirements', title: 'Requirements', desc: 'Node, disk, RAM, OS' },
      { id: 'versions', title: 'Versions', desc: 'What\'s current, what\'s dead' },
      { id: 'downloads', title: 'Downloads', desc: 'Pre-built binaries + repo stats' },
      { id: 'faq', title: 'FAQ', desc: 'Common questions' },
      { id: 'license', title: 'License', desc: 'Apache 2.0 vs closed source' },
      { id: 'start', title: 'Get started', desc: 'Clone and run' },
    ];

    let selectedIndex = 0;
    let filtered = sections;

    function render() {
      list.innerHTML = '';
      filtered.forEach((section, i) => {
        const item = document.createElement('li');
        item.className = 'palette-result';
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(i === selectedIndex));
        item.dataset.sectionId = section.id;

        const title = document.createElement('span');
        title.className = 'palette-result-title';
        title.textContent = section.title;

        const desc = document.createElement('span');
        desc.className = 'palette-result-desc';
        desc.textContent = section.desc;

        item.append(title, desc);
        item.addEventListener('click', () => goTo(section.id));
        list.appendChild(item);
      });
    }

    function goTo(id) {
      dialog.close();
      showSection(id);
    }

    const isMac = (() => {
      // userAgentData is the modern, non-deprecated way to get this, but it's
      // Chromium-only right now — Safari/Firefox fall through to the old fields
      const uaPlatform = navigator.userAgentData?.platform;
      if (uaPlatform) return uaPlatform.toLowerCase().includes('mac');
      const legacy = (navigator.platform || navigator.userAgent || '').toLowerCase();
      return legacy.includes('mac');
    })();

    // pointer:coarse = touch-primary input (phones, tablets). Deliberately not
    // a screen-width check — a touchscreen laptop with a keyboard should still
    // see the ⌘K/Ctrl K hint, and a small desktop window shouldn't lose it.
    const noHardwareKeyboard = matchMedia('(pointer: coarse)').matches;

    function open() {
      input.value = '';
      filtered = sections;
      selectedIndex = 0;
      render();
      dialog.showModal();
      // showModal() moves focus to the dialog itself first; queue the
      // input focus for the next frame so it actually sticks
      requestAnimationFrame(() => input.focus());
    }

    trigger?.addEventListener('click', open);

    const kbd = trigger?.querySelector('.palette-kbd');
    const triggerLabel = trigger?.querySelector('span');
    if (kbd) {
      kbd.textContent = noHardwareKeyboard ? '' : (isMac ? '⌘K' : 'Ctrl K');
      kbd.hidden = noHardwareKeyboard;
    }
    if (triggerLabel && noHardwareKeyboard) triggerLabel.textContent = 'Search';

    // the ↑↓ / ↵ / esc hint row is meaningless without a physical keyboard —
    // hide it rather than show controls the person has no way to press
    const paletteHint = document.querySelector('.palette-hint');
    if (paletteHint) paletteHint.hidden = noHardwareKeyboard;

    document.addEventListener('keydown', (event) => {
      const modifierHeld = isMac ? event.metaKey : event.ctrlKey;
      if (modifierHeld && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        dialog.open ? dialog.close() : open();
      }
    });

    closeBtn?.addEventListener('click', () => dialog.close());

    // clicking the ::backdrop lands directly on the dialog element itself
    // (not a child) — that's the standard way to detect a backdrop click.
    // this was missing entirely before, which combined with no close button
    // meant there was no way to dismiss the palette on a device with no
    // keyboard (no Esc key, and Ctrl K/⌘K obviously isn't reachable either)
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });

    input.addEventListener('input', () => {
      const term = input.value.trim().toLowerCase();
      filtered = sections.filter((s) =>
        s.title.toLowerCase().includes(term) || s.desc.toLowerCase().includes(term)
      );
      selectedIndex = 0;
      render();
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
        render();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, 0);
        render();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (filtered[selectedIndex]) goTo(filtered[selectedIndex].id);
      }
    });
  }

  /* ----------------------------------------------------------------------
   * live repo stats + changelog: routed through the Cloudflare Worker
   * proxy (GH_PROXY), which holds the real token server-side.
   * ------------------------------------------------------------------- */
  async function wireUpRepoStats() {
    const starsEl  = document.querySelector('[data-stat-stars]');
    const forksEl  = document.querySelector('[data-stat-forks]');
    const issuesEl = document.querySelector('[data-stat-issues]');
    if (!starsEl) return;

    try {
      const res = await fetch(`${GH_PROXY}/repo`, {
        headers: ghHeaders(),
      });
      if (!res.ok) return;
      const repo = await res.json();
      starsEl.textContent  = formatCompactNumber(repo.stargazers_count);
      forksEl.textContent  = formatCompactNumber(repo.forks_count);
      issuesEl.textContent = formatCompactNumber(repo.open_issues_count);
    } catch (error) {
      console.error('[NovaByte] repo stats fetch failed:', error);
    }
  }

  function formatCompactNumber(n) {
    if (typeof n !== 'number') return '—';
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return String(n);
  }

  async function wireUpChangelog() {
    const drawer = document.querySelector('[data-changelog-drawer]');
    const listEl = document.querySelector('[data-changelog-list]');
    if (!drawer || !listEl) return;

    // only fetch once the drawer is actually opened — no point spending
    // the request budget on something most visitors won't expand
    let loaded = false;
    drawer.addEventListener('toggle', async () => {
      if (!drawer.open || loaded) return;
      loaded = true;

      try {
        const res = await fetch(`${GH_PROXY}/commits?path=NBOSP&per_page=8`, {
          headers: ghHeaders(),
        });
        if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
        const commits = await res.json();

        listEl.innerHTML = '';
        for (const commit of commits) {
          const link = document.createElement('a');
          link.className = 'changelog-entry';
          link.href = commit.html_url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';

          const msg = document.createElement('div');
          msg.className = 'changelog-msg';
          // first line only — commit bodies can run long and this is a
          // summary list, not a full diff viewer
          msg.textContent = (commit.commit?.message || '').split('\n')[0];

          const meta = document.createElement('div');
          meta.className = 'changelog-meta';
          const sha = commit.sha ? commit.sha.slice(0, 7) : '';
          const date = commit.commit?.author?.date ? formatReleaseDate(commit.commit.author.date) : '';
          meta.textContent = [sha, date].filter(Boolean).join(' · ');

          link.append(msg, meta);
          listEl.appendChild(link);
        }

        if (commits.length === 0) {
          listEl.innerHTML = '<p class="changelog-loading">No commits found.</p>';
        }
      } catch (error) {
        console.error('[NovaByte] changelog fetch failed:', error);
        listEl.innerHTML = '<p class="changelog-loading">Couldn\'t load recent commits — <a href="https://github.com/NovaByteTeam/novabyte-os/commits/main/NBOSP" target="_blank" rel="noopener noreferrer">view on GitHub</a>.</p>';
      }
    });
  }

  /* ----------------------------------------------------------------------
   * file preview modal: lazy-loads CodeMirror (only on first file click,
   * not on page load — no reason to ship a code editor to someone who
   * never opens the browser section) and renders whatever text file the
   * GitHub contents API handed back. Binaries and anything over ~300KB
   * just get a "use Download instead" message rather than trying to
   * syntax-highlight a font file or choke on a huge minified bundle.
   * ------------------------------------------------------------------- */
  function wireUpFilePreview() {
    const dialog     = document.querySelector('[data-file-preview-dialog]');
    const nameEl     = document.querySelector('[data-file-preview-name]');
    const downloadEl = document.querySelector('[data-file-preview-download]');
    const closeBtn   = document.querySelector('[data-file-preview-close]');
    const loadingEl  = document.querySelector('[data-file-preview-loading]');
    const errorEl    = document.querySelector('[data-file-preview-error]');
    const toolargeEl = document.querySelector('[data-file-preview-toolarge]');
    const binaryEl   = document.querySelector('[data-file-preview-binary]');
    const editorEl   = document.querySelector('[data-file-preview-editor]');
    if (!dialog) return null;

    const MAX_PREVIEW_BYTES = 300_000;

    // esm.sh bundles each package (and its deps) into one importable ESM
    // module — no build step needed, works straight from a <script type="module">
    // scope. Versions pinned to what was current on npm at time of writing;
    // bump deliberately, don't float on `latest`.
    const CM_IMPORTS = {
      state: 'https://esm.sh/@codemirror/state@6.7.1',
      view: 'https://esm.sh/@codemirror/view@6.43.7',
      language: 'https://esm.sh/@codemirror/language@6.12.4',
      oneDark: 'https://esm.sh/@codemirror/theme-one-dark@6.1.3',
      javascript: 'https://esm.sh/@codemirror/lang-javascript@6.2.5',
      css: 'https://esm.sh/@codemirror/lang-css@6.3.1',
      html: 'https://esm.sh/@codemirror/lang-html@6.4.11',
      json: 'https://esm.sh/@codemirror/lang-json@6.0.2',
      markdown: 'https://esm.sh/@codemirror/lang-markdown@6.5.1',
    };

    // extension -> which CM_IMPORTS key + exported language function to call.
    // yaml/shell have no official @codemirror/lang- package, so they fall
    // back to plain-text (still gets line numbers, just no highlighting)
    // rather than pulling in a third-party mode for two extensions.
    const LANG_MAP = {
      js:   { mod: 'javascript', fn: (m) => m.javascript() },
      mjs:  { mod: 'javascript', fn: (m) => m.javascript() },
      jsx:  { mod: 'javascript', fn: (m) => m.javascript({ jsx: true }) },
      json: { mod: 'json', fn: (m) => m.json() },
      css:  { mod: 'css', fn: (m) => m.css() },
      html: { mod: 'html', fn: (m) => m.html() },
      htm:  { mod: 'html', fn: (m) => m.html() },
      md:   { mod: 'markdown', fn: (m) => m.markdown() },
    };
    const BINARY_EXTENSIONS = new Set([
      'png','jpg','jpeg','gif','webp','ico','svg','woff','woff2','ttf','eot',
      'mp3','mp4','wav','ogg','zip','gz','tar','pdf','exe','dll','wasm',
    ]);

    let cmCorePromise = null;
    let cmEditor = null;
    const langModuleCache = new Map();
    const contentCache = new Map();

    // core view/state/language/theme modules are shared across every file
    // type, so they only ever get fetched once no matter how many
    // different-language files get opened after
    function ensureCodeMirrorCore() {
      if (!cmCorePromise) {
        cmCorePromise = Promise.all([
          import(CM_IMPORTS.state),
          import(CM_IMPORTS.view),
          import(CM_IMPORTS.language),
          import(CM_IMPORTS.oneDark),
        ]).then(([state, view, language, oneDark]) => ({ state, view, language, oneDark }));
      }
      return cmCorePromise;
    }

    async function loadLanguageExtension(ext) {
      const entry = LANG_MAP[ext];
      if (!entry) return null; // no highlighting available, plain text is fine
      let mod = langModuleCache.get(entry.mod);
      if (!mod) {
        mod = await import(CM_IMPORTS[entry.mod]);
        langModuleCache.set(entry.mod, mod);
      }
      return entry.fn(mod);
    }

    function extensionOf(filename) {
      const parts = filename.split('.');
      return parts.length > 1 ? parts.pop().toLowerCase() : '';
    }

    function resetPanels() {
      loadingEl.hidden = true;
      errorEl.hidden = true;
      toolargeEl.hidden = true;
      binaryEl.hidden = true;
      editorEl.hidden = true;
    }

    function showPanel(el) {
      resetPanels();
      el.hidden = false;
    }

    // base64 from GitHub's API comes with embedded newlines and atob()
    // chokes on those, so strip whitespace first
    function decodeBase64Utf8(b64) {
      const clean = b64.replace(/\s/g, '');
      const binary = atob(clean);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }

    async function openFile(path, name) {
      nameEl.textContent = name;
      const rawUrl = `https://raw.githubusercontent.com/NovaByteTeam/novabyte-os/main/${path}`;
      downloadEl.href = rawUrl;
      downloadEl.setAttribute('download', name);

      dialog.showModal();
      showPanel(loadingEl);

      const ext = extensionOf(name);
      if (BINARY_EXTENSIONS.has(ext)) {
        showPanel(binaryEl);
        return;
      }

      try {
        let data = contentCache.get(path);
        if (!data) {
          const res = await fetch(
            `${GH_PROXY}/contents/${path}`,
            { headers: ghHeaders() }
          );
          if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
          data = await res.json();
          contentCache.set(path, data);
        }

        if (typeof data.size === 'number' && data.size > MAX_PREVIEW_BYTES) {
          showPanel(toolargeEl);
          return;
        }
        if (!data.content) throw new Error('no content field in response');

        const text = decodeBase64Utf8(data.content);

        const { state, view, language, oneDark } = await ensureCodeMirrorCore();
        const langExt = await loadLanguageExtension(ext);

        editorEl.innerHTML = '';
        showPanel(editorEl);

        // fresh EditorView each time rather than reusing one — simplest way
        // to fully reset state between files without hand-rolling a
        // "swap the document" dispatch that also has to reset extensions
        cmEditor = new view.EditorView({
          state: state.EditorState.create({
            doc: text,
            extensions: [
              view.lineNumbers(),
              language.syntaxHighlighting(language.defaultHighlightStyle, { fallback: true }),
              oneDark.oneDark,
              ...(langExt ? [langExt] : []),
              state.EditorState.readOnly.of(true),
              view.EditorView.editable.of(false),
            ],
          }),
          parent: editorEl,
        });
      } catch (error) {
        console.error('[NovaByte] file preview failed:', error);
        showPanel(errorEl);
      }
    }

    function close() {
      dialog.close();
      cmEditor?.destroy();
      cmEditor = null;
      editorEl.innerHTML = '';
    }

    closeBtn?.addEventListener('click', close);
    dialog.addEventListener('click', (event) => {
      // clicking the ::backdrop lands directly on the dialog element itself
      // (not a child), that's the standard way to detect a backdrop click
      if (event.target === dialog) close();
    });

    // exposed so the file browser's row click handler can call it
    return { openFile };
  }

  /* ----------------------------------------------------------------------
   * live file browser: routed through the Cloudflare Worker proxy
   * (GH_PROXY), which holds the real token server-side — visitors get
   * the authenticated 5,000/hr rate limit without the token ever
   * touching the client.
   * ------------------------------------------------------------------- */

  function wireUpFileBrowser(filePreview) {
    const root       = document.querySelector('[data-browser-root]');
    if (!root) return;

    const loadingEl  = root.querySelector('[data-browser-loading]');
    const errorEl    = root.querySelector('[data-browser-error]');
    const tableEl    = root.querySelector('[data-browser-table]');
    const bodyEl     = root.querySelector('[data-browser-body]');
    const pathEl     = root.querySelector('[data-browser-path-current]');

    const ROOT_PATH = 'NBOSP';

    // both caches persist for the whole page session — the repo's history
    // for a given path doesn't change while someone's browsing, so there's
    // no reason to ever fetch the same path twice. this is the actual fix
    // for the rate limit problem: without it, revisiting a folder you've
    // already opened costs another N+1 requests for no reason
    const listingCache = new Map();
    const commitCache = new Map();

    function showLoading() {
      loadingEl.hidden = false;
      errorEl.hidden = true;
      tableEl.hidden = true;
    }

    function showError() {
      loadingEl.hidden = true;
      errorEl.hidden = false;
      tableEl.hidden = true;
    }

    function showTable() {
      loadingEl.hidden = true;
      errorEl.hidden = true;
      tableEl.hidden = false;
    }

    // relative time to match GitHub's own "3 days ago" / "7 hours ago"
    // style rather than a raw ISO date
    function formatRelativeTime(iso) {
      const then = new Date(iso).getTime();
      const diffSeconds = Math.max(0, (Date.now() - then) / 1000);
      const units = [
        ['year', 31536000], ['month', 2592000], ['week', 604800],
        ['day', 86400], ['hour', 3600], ['minute', 60],
      ];
      for (const [name, secondsInUnit] of units) {
        const value = Math.floor(diffSeconds / secondsInUnit);
        if (value >= 1) return `${value} ${name}${value === 1 ? '' : 's'} ago`;
      }
      return 'just now';
    }

    async function fetchLastCommit(path) {
      if (commitCache.has(path)) return commitCache.get(path);
      try {
        const res = await fetch(
          `${GH_PROXY}/commits?path=${encodeURIComponent(path)}&per_page=1`,
          { headers: ghHeaders() }
        );
        if (!res.ok) { commitCache.set(path, null); return null; }
        const commits = await res.json();
        const result = commits[0] || null;
        commitCache.set(path, result);
        return result;
      } catch {
        commitCache.set(path, null);
        return null;
      }
    }

    async function loadPath(path) {
      showLoading();
      pathEl.textContent = path === ROOT_PATH ? '' : path.slice(ROOT_PATH.length + 1);

      try {
        let entries = listingCache.get(path);
        if (!entries) {
          const res = await fetch(
            `${GH_PROXY}/contents/${path}`,
            { headers: ghHeaders() }
          );
          if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
          entries = await res.json();
          listingCache.set(path, entries);
        }

        // dirs first, then files, both alphabetical — matches the
        // convention every git host's file browser already uses
        // (sort a copy — entries may be the same cached array object
        // returned on the next visit, don't want repeated in-place sorts
        // silently relying on already-sorted input)
        const sorted = [...entries].sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

        // last-commit lookups run in parallel — sequential would mean
        // a ~15-entry folder taking 15x one request's latency to paint.
        // fetchLastCommit itself is cached per-path, so revisiting a
        // folder costs zero additional requests here
        const withCommits = await Promise.all(
          sorted.map(async (entry) => ({ entry, commit: await fetchLastCommit(entry.path) }))
        );

        bodyEl.innerHTML = '';

        if (path !== ROOT_PATH) {
          const parentPath = path.split('/').slice(0, -1).join('/') || ROOT_PATH;
          bodyEl.appendChild(buildRow({
            name: '..', isDir: true, path: parentPath, commitMsg: '', commitUrl: '', relTime: '',
          }));
        }

        for (const { entry, commit } of withCommits) {
          bodyEl.appendChild(buildRow({
            name: entry.name,
            isDir: entry.type === 'dir',
            path: entry.path,
            commitMsg: commit?.commit?.message?.split('\n')[0] || '—',
            commitUrl: commit?.html_url || '',
            relTime: commit?.commit?.author?.date ? formatRelativeTime(commit.commit.author.date) : '—',
          }));
        }

        showTable();
      } catch (error) {
        console.error('[NovaByte] file browser fetch failed:', error);
        showError();
      }
    }

    function buildRow({ name, isDir, path, commitMsg, commitUrl, relTime }) {
      const tr = document.createElement('tr');

      const nameTd = document.createElement('td');
      const nameSpan = document.createElement('span');
      nameSpan.className = 'browser-name' + (isDir ? ' is-dir' : '');
      nameSpan.innerHTML = `<span class="browser-icon">${isDir ? '📁' : '📄'}</span>`;
      nameSpan.append(name);
      if (isDir) {
        nameSpan.addEventListener('click', () => loadPath(path));
      } else {
        nameSpan.classList.add('is-file');
        nameSpan.addEventListener('click', () => filePreview?.openFile(path, name));
      }
      nameTd.appendChild(nameSpan);

      const msgTd = document.createElement('td');
      msgTd.className = 'browser-commit-msg';
      if (commitUrl) {
        const link = document.createElement('a');
        link.href = commitUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = commitMsg;
        msgTd.appendChild(link);
      } else {
        msgTd.textContent = commitMsg;
      }

      const dateTd = document.createElement('td');
      dateTd.className = 'browser-commit-date';
      dateTd.textContent = relTime;

      tr.append(nameTd, msgTd, dateTd);
      return tr;
    }

    loadPath(ROOT_PATH);
  }

  /* ----------------------------------------------------------------------
   * smooth scroll: hands scrolling to Lenis so wheel/touch input gets
   * lerp'd into momentum instead of the browser's default instant jump.
   * left off entirely when reduced-motion is on — Lenis's inertia IS the
   * kind of motion that setting exists to suppress, so the honest move is
   * to just not run it, not to run it with duration:0.
   * ------------------------------------------------------------------- */
  function wireUpSmoothScroll() {
    if (reduceMotionQuery.matches || typeof Lenis === 'undefined') return;

    const lenis = new Lenis({
      duration: 1.1,
      easing: (t) => 1 - Math.pow(1 - t, 3), // easeOutCubic — matches --ease-smooth's feel
      wheelMultiplier: 1,
      autoRaf: true,
      anchors: true, // keeps in-page #hash links smooth too
      // Lenis intercepts touch scrolling by default and re-drives it in JS,
      // which fights the browser's native GPU-accelerated touch physics —
      // that's what makes smooth-scroll libraries feel janky/rubber-bandy
      // on mobile. syncTouch:false leaves touch scroll to the platform and
      // only takes over wheel input + anchor-link jumps (still smooth there).
      syncTouch: false,
      // data-lenis-prevent on .file-preview-body / .palette-results covers
      // the known scrollers; this is the fallback so any future scrollable
      // content added inside a <dialog> doesn't reopen this same bug.
      prevent: (node) => Boolean(node.closest?.('dialog')),
    });

    // if the person flips reduced-motion on mid-session, drop back to
    // native scroll rather than leaving a mismatched preference running
    reduceMotionQuery.addEventListener('change', () => {
      if (reduceMotionQuery.matches) lenis.destroy();
    });
  }

  // kick everything off
  const bootContainer = document.querySelector('[data-boot-sequence]');
  if (bootContainer) typeOutBootSequence(bootContainer);

  wireUpSmoothScroll();

  wireUpGlowTracking();
  wireUpAnimationRelease();
  wireUpNav();
  wireUpDevAccordion();
  wireUpScrollRevealFallback();
  wireUpCopyButton();
  wireUpDownloads();
  wireUpAppFilter();
  wireUpThemePreview();
  wireUpCommandPalette();
  wireUpRepoStats();
  wireUpChangelog();
  const filePreview = wireUpFilePreview();
  wireUpFileBrowser(filePreview);
