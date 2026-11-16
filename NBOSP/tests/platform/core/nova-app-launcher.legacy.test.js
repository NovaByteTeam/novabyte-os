import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../../setup.js';
import {
  createEnv,
  requireFreshLauncher,
  installFetch,
  serveRegisterResponse,
  RealAppPackage,
  makePackageApp,
  makeFiles,
  stampIntegrity,
  tamperFile,
  b64,
  unb64,
  ENTRY_HTML,
  HEADLESS_HTML,
  HEAD_ATTRS_HTML,
  waitFor,
  tick,
} from './nova-app-launcher-harness.js';

// ── nova-app-launcher.js — LEGACY no-AppSandbox launch path, e2e ────────────
//
// The modern AppSandbox.launch hand-off is covered by nova-app-launcher.test.js.
// This suite drives the legacy fallback init() runs when AppSandbox is absent:
// the launch-time integrity re-verification (REAL AppPackage + REAL BLAKE3),
// the trust / tamper / combined dialogs (real DOM, real clicks, the real
// type-to-confirm phrase), the /api/apps/serve/register round trip (captured
// fetch), the sandboxed <webview> wiring (partition before src, sandbox tokens
// for non-system packages, FrameSecurity for non-WEBVIEW tags), and the blob
// fallback that inlines css/js when the serve API is down.
//
// Dead-code note: svgIcon(), _getFirstPartyAppIds(), isSuspectedSystemImpersonation(),
// showSystemImpersonationDialog() and showMaliciousFileDialog() are defined but
// never called anywhere in this file (or the repo) — they cannot be covered
// through the public surface and are documented here instead.

let env;
let build;
let fetchLog;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  resetTestStorage();
  env = createEnv({ captureBlob: true });
  build = requireFreshLauncher();
  // Default: the serve API is up. Tests that need the blob fallback swap it.
  fetchLog = installFetch({
    '/api/apps/serve/register': serveRegisterResponse({ baseUrl: '/api/apps/serve/sb-fixture' }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  env?.teardown();
  env = null;
  build = null;
});

/** Launch a record through the legacy path and return its content element. */
async function launchLegacy(record, options = null) {
  const contentEl = env.document.createElement('div');
  env.document.body.appendChild(contentEl);
  const done = build(record).init(contentEl, null, options);
  await done;
  return contentEl;
}

/** Launch and hand back the promise + content element (for dialog tests). */
function launchForDialog(record, options = null) {
  const contentEl = env.document.createElement('div');
  env.document.body.appendChild(contentEl);
  return { promise: build(record).init(contentEl, null, options), contentEl };
}

const q = (sel) => env.document.querySelector(sel);
const servedBody = () => JSON.parse(fetchLog.calls.at(-1).opts.body);
const servedEntryHtml = () => unb64(servedBody().files['index.html']);

describe('legacy launch path — serve API round trip (verified package, no dialog)', () => {
  it('registers the shimmed package and wires a partitioned, sandboxed webview', async () => {
    const el = await launchLegacy(makePackageApp({ verified: true }));

    const wv = el.querySelector('webview');
    expect(wv).toBeTruthy();
    // partition attr set, src points at the registered sandbox base + entry.
    expect(wv.getAttribute('partition')).toBe('persist:app_com.example.packaged');
    expect(String(wv.src)).toBe('https://localhost/api/apps/serve/sb-fixture/index.html');
    // Non-system packages get the restrictive sandbox tokens.
    expect(wv.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-modals allow-popups');
    expect(el.style.padding).toBe('0px');
  });

  it('posts a sandboxId keyed to the app id and carries the entry through base64', async () => {
    await launchLegacy(makePackageApp({ verified: true }));
    const body = servedBody();
    expect(body.sandboxId).toMatch(/^sandbox_com\.example\.packaged_\d+$/);
    // A dotted lowercase id qualifies for the stable per-app serving alias.
    expect(body.appId).toBe('com.example.packaged');
    const html = servedEntryHtml();
    expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(html).toContain('__novaPrivateStore');
    expect(html).toContain('window.nova');
  });

  it('omits appId from the registration when the id is not platform-shaped', async () => {
    // No dots + uppercase cannot match the stable-alias regex → session-only.
    await launchLegacy(makePackageApp({ id: 'UPPERCASE', verified: true }));
    const body = servedBody();
    expect(body.appId).toBeUndefined();
    expect(body.sandboxId).toMatch(/^sandbox_UPPERCASE_\d+$/);
  });

  it('keeps host tier (no sandbox attribute) only for the genuine System triple', async () => {
    const el = await launchLegacy(makePackageApp({
      verified: true,
      signer: 'NovaByte System',
      manifest: { ...makePackageApp().manifest, system: true },
    }));
    expect(el.querySelector('webview').getAttribute('sandbox')).toBeNull();

    // A manifest system claim with a non-System signer (or without
    // verification) is NOT host tier — and must not open any dialog on the
    // way (verified stays true so the trust dialog cannot fire either).
    const el2 = await launchLegacy(makePackageApp({
      verified: true,
      signer: 'Some Other CA',
      manifest: { ...makePackageApp().manifest, system: true },
    }));
    expect(el2.querySelector('webview').getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-modals allow-popups');
  });

  it('injects the private-data bridge with the AppDirs fs dir into the blob payload', async () => {
    env.window.AppDirs = { getFSDir: (appId, kind) => `/data/${appId}/${kind}` };
    // Serve API down → blob fallback carries the bridge script.
    installFetch({ '/api/apps/serve/register': { ok: false, status: 500, json: async () => ({}) } });
    const el = await launchLegacy(makePackageApp({ verified: true }));
    expect(String(el.querySelector('webview').src)).toMatch(/^blob:/);
    const blobText = await env.blobs[0].text();
    expect(blobText).toContain('nv-bridge-shim');
    expect(blobText).toContain('s.fsDir="/data/com.example.packaged/files"');
  });
});

describe('legacy launch path — sandbox CSP construction (appData.url handling)', () => {
  const cases = [
    ['https://frames.example.com/app/', '; frame-src https://frames.example.com', null],
    ['http://frames.example.com', '; frame-src http://frames.example.com', null],
    ['ftp://files.example.com', '', 'non-http(s) url'],
    ['not a url at all', '', 'invalid url'],
    [undefined, '', null],
  ];
  for (const [url, expectedCsp, expectedWarn] of cases) {
    it(`url=${JSON.stringify(url)} → ${expectedWarn ?? (expectedCsp || 'no frame-src')}`, async () => {
      const warn = vi.mocked(console.warn);
      await launchLegacy(makePackageApp({ verified: true, url }));
      const html = servedEntryHtml();
      if (expectedCsp) {
        expect(html).toContain(expectedCsp.replace(/"/g, '&quot;'));
      } else {
        expect(html).not.toContain('frame-src');
      }
      if (expectedWarn) {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(expectedWarn), url);
      }
    });
  }
});

describe('legacy launch path — entry document shapes', () => {
  it('prepends CSP + shim before the html when the entry has no <head>', async () => {
    await launchLegacy(makePackageApp({ verified: true, files: makeFiles({ entryHtml: HEADLESS_HTML }) }));
    const html = servedEntryHtml();
    // Prepend branch: shim and CSP land BEFORE the doctype/document.
    expect(html.indexOf('__novaPrivateStore')).toBeLessThan(html.indexOf('<!doctype html>'));
    expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
  });

  it('injects into an attributed <head ...> element', async () => {
    await launchLegacy(makePackageApp({ verified: true, files: makeFiles({ entryHtml: HEAD_ATTRS_HTML }) }));
    const html = servedEntryHtml();
    // Replace branch: CSP meta directly follows the <head ...> open tag.
    expect(html).toMatch(/<head lang="en" data-theme="dark">\s*<meta http-equiv="Content-Security-Policy"/);
  });
});

describe('legacy launch path — blob fallback when the serve API is down', () => {
  function serveDown() {
    installFetch({ '/api/apps/serve/register': { ok: false, status: 503, json: async () => ({}) } });
  }

  it('inlines css and js from the package into the wrapped entry', async () => {
    serveDown();
    const el = await launchLegacy(makePackageApp({ verified: true }));
    const wv = el.querySelector('webview');
    expect(wv).toBeTruthy();
    expect(String(wv.src)).toMatch(/^blob:/);
    expect(wv.getAttribute('partition')).toBe('persist:app_com.example.packaged');
    expect(wv.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-modals allow-popups');

    const blobText = await env.blobs[0].text();
    // <link> and src'd <script> from the entry are stripped...
    expect(blobText).not.toMatch(/<link[^>]+stylesheet/);
    // ...and the packaged files are re-embedded inline. NOTE: the fallback
    // inlines the files' base64 text verbatim (it does not decode first) —
    // that is the source's actual behavior, asserted as such.
    expect(blobText).toContain('<style data-ninline>');
    expect(blobText).toContain(b64('body{font-family:system-ui;margin:0}#fixture-root{color:var(--text-primary)}'));
    expect(blobText).toContain('<script data-ninline>');
    // CSP + bridge are present too.
    expect(blobText).toContain('http-equiv="Content-Security-Policy"');
    expect(blobText).toContain('nv-bridge-shim');
  });

  it('falls back to the blob path when the register fetch itself throws', async () => {
    installFetch({
      '/api/apps/serve/register': () => Promise.reject(new Error('network down')),
    });
    const el = await launchLegacy(makePackageApp({ verified: true }));
    expect(String(el.querySelector('webview').src)).toMatch(/^blob:/);
    expect(env.blobs).toHaveLength(1);
  });

  it('skips non-asset files and raw non-strings when inlining', async () => {
    serveDown();
    await launchLegacy(makePackageApp({
      verified: true,
      files: { ...makeFiles(), 'notes.txt': btoaTxt('ignore me'), 'broken.js': 42 },
    }));
    const blobText = await env.blobs[0].text();
    expect(blobText).not.toContain('ignore me');
    expect(env.blobs).toHaveLength(1);
  });
});

function btoaTxt(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

// ── Trust / tamper / combined dialogs (verified:false / integrity failed) ──

describe('legacy launch path — untrusted (signature trust) dialog', () => {
  it('blocks an unsigned package behind the Not Signed dialog until Install Anyway', async () => {
    const { promise, contentEl } = launchForDialog(makePackageApp({ verified: false }));
    const cancelBtn = await waitFor(() => q('#nb-untrusted-cancel-btn'));
    expect(env.document.body.textContent).toContain('Untrusted App — Not Signed');
    expect(env.document.body.textContent).toContain('not digitally signed');

    // Install Anyway stays hidden until More Info is opened.
    expect(q('#nb-untrusted-launch-btn').style.display).toBe('none');
    q('#nb-untrusted-more-btn').click();
    expect(q('#nb-untrusted-more').style.display).toBe('block');
    const launchBtn = q('#nb-untrusted-launch-btn');
    expect(launchBtn.style.display).toBe('inline-block');

    launchBtn.click();
    await promise;
    // Re-entered init with the user's one-time override → really launched.
    expect(contentEl.querySelector('webview')).toBeTruthy();
    expect(String(contentEl.querySelector('webview').src)).toContain('/api/apps/serve/sb-fixture/');
  });

  it('collapses More Info again on a second click and flips the button label', async () => {
    const { promise } = launchForDialog(makePackageApp({ verified: false }));
    await waitFor(() => q('#nb-untrusted-more-btn'));
    q('#nb-untrusted-more-btn').click();
    expect(q('#nb-untrusted-more-btn').textContent).toBe('Less Info');
    q('#nb-untrusted-more-btn').click();
    expect(q('#nb-untrusted-more-btn').textContent).toBe('More Info');
    expect(q('#nb-untrusted-launch-btn').style.display).toBe('none');
    q('#nb-untrusted-cancel-btn').click();
    await promise;
  });

  it('Cancel leaves a "Launch cancelled." notice and never registers a sandbox', async () => {
    const { promise, contentEl } = launchForDialog(makePackageApp({ verified: false }));
    (await waitFor(() => q('#nb-untrusted-cancel-btn'))).click();
    await promise;
    expect(contentEl.textContent).toContain('Launch cancelled.');
    expect(fetchLog.calls).toHaveLength(0);
  });

  it('clicking the backdrop dismisses the dialog as a cancellation', async () => {
    const { promise, contentEl } = launchForDialog(makePackageApp({ verified: false }));
    const cancelBtn = await waitFor(() => q('#nb-untrusted-cancel-btn'));
    // Walk up to the position:fixed overlay (jsdom may normalise the style
    // string, so match flexibly); the backdrop is its first child.
    let overlay = cancelBtn.parentElement;
    while (overlay && !(overlay.tagName === 'DIV' && /position:\s*fixed/i.test(overlay.getAttribute('style') || ''))) {
      overlay = overlay.parentElement;
    }
    const backdrop = overlay.firstElementChild;
    backdrop.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
    await promise;
    expect(contentEl.textContent).toContain('Launch cancelled.');
  });

  it('shows the Unknown Publisher variant for a signed-but-unrecognised package', async () => {
    const { promise } = launchForDialog(makePackageApp({ verified: false, signature: 'sig-abc' }));
    await waitFor(() => q('#nb-untrusted-cancel-btn'));
    expect(env.document.body.textContent).toContain('Untrusted App — Unknown Publisher');
    expect(env.document.body.textContent).toContain("signed, but the signer is not in NovaByte OS's trust store");
    q('#nb-untrusted-cancel-btn').click();
    await promise;
  });

  it('shows the Revoked Package variant with the install-despite-revocation button', async () => {
    const { promise } = launchForDialog(makePackageApp({ verified: false, signature: 'sig-abc', revoked: true }));
    await waitFor(() => q('#nb-untrusted-cancel-btn'));
    expect(env.document.body.textContent).toContain('Revoked Package — Do Not Install');
    q('#nb-untrusted-more-btn').click();
    expect(q('#nb-untrusted-launch-btn').textContent).toBe('Install Despite Revocation');
    q('#nb-untrusted-cancel-btn').click();
    await promise;
  });

  it('uses translated strings when window._t provides them, and escapes them', async () => {
    env.teardown();
    env = createEnv({
      captureBlob: true,
      _t: (key) => (key === 'shell.untrusted.unsignedTitle'
        ? 'Untrusted — <script>alert(1)</script>'
        : key),
    });
    build = requireFreshLauncher();
    fetchLog = installFetch({
      '/api/apps/serve/register': serveRegisterResponse({ baseUrl: '/api/apps/serve/sb-fixture' }),
    });
    const { promise } = launchForDialog(makePackageApp({ verified: false }));
    await waitFor(() => q('#nb-untrusted-cancel-btn'));
    const title = env.document.body.textContent;
    expect(title).toContain('Untrusted — <script>alert(1)</script>');
    // The raw tag was escaped — no script element was actually created.
    expect(env.document.querySelectorAll('script[id="nb-untrusted"]')).toHaveLength(0);
    q('#nb-untrusted-cancel-btn').click();
    await promise;
  });

  it('falls back to English when window._t throws', async () => {
    env.teardown();
    env = createEnv({
      captureBlob: true,
      _t: () => { throw new Error('catalog missing'); },
    });
    build = requireFreshLauncher();
    fetchLog = installFetch({
      '/api/apps/serve/register': serveRegisterResponse({ baseUrl: '/api/apps/serve/sb-fixture' }),
    });
    const { promise } = launchForDialog(makePackageApp({ verified: false }));
    await waitFor(() => q('#nb-untrusted-cancel-btn'));
    expect(env.document.body.textContent).toContain('Untrusted App — Not Signed');
    q('#nb-untrusted-cancel-btn').click();
    await promise;
  });
});

describe('legacy launch path — launch-time integrity re-verification (REAL AppPackage + BLAKE3)', () => {
  beforeEach(() => {
    globalThis.AppPackage = RealAppPackage;
  });

  it('a verified package with intact files launches with no dialog', async () => {
    const record = makePackageApp({ verified: true });
    await stampIntegrity(record);
    const el = await launchLegacy(record);
    expect(el.querySelector('webview')).toBeTruthy();
    expect(q('#nb-tamper-cancel-btn')).toBeNull();
    expect(q('#nb-untrusted-cancel-btn')).toBeNull();
  });

  it('a genuinely tampered file on a verified package trips the tamper dialog alone', async () => {
    const record = makePackageApp({ verified: true, signer: 'NovaByte Trusted Signing' });
    await stampIntegrity(record);
    tamperFile(record, 'style.css', 'body{background:evil}');
    const { promise, contentEl } = launchForDialog(record);

    await waitFor(() => q('#nb-tamper-cancel-btn'));
    expect(env.document.body.textContent).toContain('Tamper Detected — Package Modified');
    expect(env.document.body.textContent).toContain('style.css');
    // Trusted signer does NOT suppress the tamper dialog.
    expect(env.document.body.textContent).not.toContain('Two Problems Found');

    q('#nb-tamper-cancel-btn').click();
    await promise;
    expect(contentEl.textContent).toContain('Launch cancelled.');
  });

  it('the install button only unlocks for the exact confirmation phrase', async () => {
    const record = makePackageApp({ verified: true });
    await stampIntegrity(record);
    tamperFile(record, 'app.js', 'evil()');
    const { promise, contentEl } = launchForDialog(record);

    const input = await waitFor(() => q('#nb-tamper-confirm-input'));
    const installBtn = q('#nb-tamper-install-btn');
    expect(installBtn.disabled).toBe(true);

    for (const wrong of ['install', 'install tamper', 'uninstall tampered', 'INSTALL  TAMPERED']) {
      input.value = wrong;
      input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
      expect(installBtn.disabled).toBe(true);
    }

    // Case-insensitive + surrounding whitespace tolerated.
    input.value = '  Install Tampered  ';
    input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    expect(installBtn.disabled).toBe(false);

    installBtn.click();
    await promise;
    // Proceeded with the one-time override → real webview launch happened.
    expect(contentEl.querySelector('webview')).toBeTruthy();
    expect(String(contentEl.querySelector('webview').src)).toContain('/api/apps/serve/sb-fixture/');
  });

  it('a disabled install button click is a no-op', async () => {
    const record = makePackageApp({ verified: true });
    await stampIntegrity(record);
    tamperFile(record, 'app.js', 'evil()');
    const { promise } = launchForDialog(record);
    const installBtn = await waitFor(() => q('#nb-tamper-install-btn'));
    installBtn.click();
    await tick(30);
    // Still open — dialog did not resolve.
    expect(q('#nb-tamper-cancel-btn')).toBeTruthy();
    q('#nb-tamper-cancel-btn').click();
    await promise;
  });

  it('lists every mismatched file, folding past eight into "and N more"', async () => {
    const record = makePackageApp({ verified: true });
    // Extra files must exist BEFORE stamping — the integrity block only
    // covers files present when it was computed.
    for (let i = 0; i < 10; i++) record.files[`mod${i}.js`] = b64(`orig${i}()`);
    await stampIntegrity(record);
    for (let i = 0; i < 10; i++) tamperFile(record, `mod${i}.js`, `evil${i}()`);
    const { promise } = launchForDialog(record);
    await waitFor(() => q('#nb-tamper-cancel-btn'));
    const text = env.document.body.textContent;
    for (let i = 0; i < 8; i++) expect(text).toContain(`mod${i}.js`);
    expect(text).toContain('and 2 more');
    q('#nb-tamper-cancel-btn').click();
    await promise;
  });

  it('unsigned + tampered shows the combined dialog, and the phrase unlocks both overrides', async () => {
    const record = makePackageApp({ verified: false });
    await stampIntegrity(record);
    tamperFile(record, 'style.css', 'x');
    const { promise, contentEl } = launchForDialog(record);

    await waitFor(() => q('#nb-combo-confirm-input'));
    expect(env.document.body.textContent).toContain('Two Problems Found');
    expect(env.document.body.textContent).toContain('Not Signed');
    expect(env.document.body.textContent).toContain('Tamper Detected');

    const input = q('#nb-combo-confirm-input');
    input.value = 'install tampered';
    input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    q('#nb-combo-install-btn').click();
    await promise;
    expect(contentEl.querySelector('webview')).toBeTruthy();
  });

  it('signed-unknown + tampered and revoked + tampered reuse the combined dialog', async () => {
    for (const extra of [{ signature: 'sig' }, { signature: 'sig', revoked: true }]) {
      const record = makePackageApp({ verified: false, ...extra });
      await stampIntegrity(record);
      tamperFile(record, 'style.css', 'x');
      const { promise } = launchForDialog(record);
      await waitFor(() => q('#nb-combo-confirm-input'));
      expect(env.document.body.textContent).toContain('Two Problems Found');
      q('#nb-combo-cancel-btn').click();
      await promise;
    }
  });

  it('a verifyIntegrity throw is treated as a failure (defensive)', async () => {
    globalThis.AppPackage = {
      verifyIntegrity: async () => { throw new Error('hash engine unavailable'); },
      computeIntegrity: async () => { throw new Error('same'); },
    };
    const record = makePackageApp({ verified: true });
    record.integrity = { method: 'blake3', fileHashes: { 'style.css': 'deadbeef' } };
    const { promise } = launchForDialog(record);
    await waitFor(() => q('#nb-tamper-cancel-btn'));
    expect(env.document.body.textContent).toContain('Tamper Detected');
    q('#nb-tamper-cancel-btn').click();
    await promise;
  });

  it('an already-granted userAllowedTampered option skips the dialog entirely', async () => {
    const record = makePackageApp({ verified: true });
    await stampIntegrity(record);
    tamperFile(record, 'style.css', 'x');
    const el = await launchLegacy(record, { userAllowedTampered: true });
    expect(el.querySelector('webview')).toBeTruthy();
    expect(q('#nb-tamper-cancel-btn')).toBeNull();
  });
});

describe('legacy launch path — hard failures', () => {
  it('blocks obfuscated packages outright with a lock notice', async () => {
    const el = await launchLegacy(makePackageApp({ verified: true, _wasObfuscated: true }));
    expect(el.textContent).toContain('obfuscated packages cannot be loaded');
    expect(fetchLog.calls).toHaveLength(0);
    expect(el.querySelector('webview')).toBeNull();
  });

  it('renders "Entry file not found" when the entry key is missing from files', async () => {
    const el = await launchLegacy(makePackageApp({ verified: true, entry: 'missing.html' }));
    expect(el.textContent).toContain('Entry file not found in package.');
    expect(fetchLog.calls).toHaveLength(0);
  });

  it('renders "Failed to load app" when the entry is not valid base64', async () => {
    const files = makeFiles();
    files['index.html'] = 'not base64 !!';
    const el = await launchLegacy(makePackageApp({ verified: true, files }));
    expect(el.textContent).toContain('Failed to load app:');
    expect(fetchLog.calls).toHaveLength(0);
  });
});

describe('legacy launch path — FrameSecurity hand-off for non-WEBVIEW tags', () => {
  it('routes lowercase-tagged webviews through FrameSecurity.securifyFrame', async () => {
    env.teardown();
    env = createEnv({ captureBlob: true, lowercaseWebviewTag: true });
    build = requireFreshLauncher();
    fetchLog = installFetch({
      '/api/apps/serve/register': serveRegisterResponse({ baseUrl: '/api/apps/serve/sb-fixture' }),
    });
    const securify = vi.fn();
    globalThis.FrameSecurity = { securifyFrame: securify };

    const el = await launchLegacy(makePackageApp({ verified: true }));
    expect(securify).toHaveBeenCalledTimes(1);
    expect(securify.mock.calls[0][0]).toBe(el.querySelector('webview'));
  });

  it('does not call securifyFrame for a properly uppercased WEBVIEW element', async () => {
    const securify = vi.fn();
    globalThis.FrameSecurity = { securifyFrame: securify };
    await launchLegacy(makePackageApp({ verified: true }));
    expect(securify).not.toHaveBeenCalled();
  });
});
