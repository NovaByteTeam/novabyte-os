import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../../setup.js';
import {
  createEnv,
  requireFreshLauncher,
  RealAppPermissionManager,
  makePackageApp,
  makeServiceApp,
  LAUNCHER_APP_MANIFEST,
  tick,
} from './nova-app-launcher-harness.js';

// ── nova-app-launcher.js — signed .novaapp launch config builder ────────────
// Window-attach script (no module.exports; publishes window.buildNovaAppConfig
// at require time against the CURRENT window). Every suite loads it fresh
// into a real JSDOM window the way the OS page loads it (runScripts
// outside-only; all module-level globals resolved against the live window).
//
// This file covers: the published surface, pure config building (real
// manifest fixtures from js/apps/*/manifest.json), package icon resolution,
// the init() permission gate against the REAL AppPermissionManager (real
// grant table, real consent dialogs, real persisted outcomes), and the
// AppSandbox.launch hand-off branch. The legacy no-AppSandbox path (webview
// wiring, serve/blob loading, trust/integrity dialogs) lives in
// nova-app-launcher.legacy.test.js.

let env;
let build;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  resetTestStorage();
  env = createEnv();
  build = requireFreshLauncher();
});

afterEach(() => {
  vi.restoreAllMocks();
  env?.teardown();
  env = null;
});

// ── helpers shared by this file ────────────────────────────────────────────

function stubSandbox(result = { success: true, sandboxId: 'sb-1' }) {
  globalThis.AppSandbox = { launch: vi.fn(async () => result) };
  return globalThis.AppSandbox;
}

function useRealPermissionManager() {
  globalThis.AppPermissionManager = RealAppPermissionManager;
  RealAppPermissionManager.initialize();
  return RealAppPermissionManager;
}

const gatedRecord = (id = 'com.example.packaged') => makePackageApp({
  id,
  name: 'Gated App',
  permissions: ['device:camera'],
  optionalPermissions: ['device:notifications'],
  verified: true,
  signer: 'NovaByte Trusted Signing',
});

describe('buildNovaAppConfig (js/platform/core/nova-app-launcher.js)', () => {
  describe('published surface', () => {
    it('exposes buildNovaAppConfig on the live window', () => {
      expect(typeof env.window.buildNovaAppConfig).toBe('function');
      expect(typeof build).toBe('function');
    });

    it('re-publishes independently per window (no cross-window bleed)', () => {
      const second = createEnv({
        unrestrictedPackage: { files: { 'icons/terminal.png': 'AAA=' } },
      });
      try {
        const build2 = requireFreshLauncher();
        const fromSecond = build2(makePackageApp({ icon: 'icons/terminal.png' }));
        expect(env.window.buildNovaAppConfig).not.toBe(second.window.buildNovaAppConfig);
        // The app-manager package files snapshot is taken at load time from
        // each window's own __novaUnrestrictedPackage (no data: rewrite here
        // because the fixture icon is not bundled under that name).
        expect(fromSecond.icon).toBe('icons/terminal.png');
      } finally {
        second.teardown();
      }
    });
  });

  describe('config shape and defaults (real manifest fixtures)', () => {
    it('fills documented defaults for a minimal package record', () => {
      const record = makePackageApp();
      const cfg = build(record);

      expect(cfg.id).toBe('com.example.packaged');
      expect(cfg.name).toBe('Terminal');
      expect(cfg.entry).toBe('index.html');
      expect(cfg.defaultSize).toEqual([700, 460]);
      expect(cfg.minSize).toEqual([420, 260]);
      expect(cfg.permissions).toEqual([]);
      expect(cfg.optionalPermissions).toEqual([]);
      expect(cfg.sandbox).toEqual({ allowScripts: true, allowForms: true, allowPopups: false });
      expect(cfg.type).toBe('package');
      expect(cfg.source).toBe('store');
      expect(cfg.files).toBe(record.files);
      // Booleans normalize: trust flags default to false, chrome defaults open.
      expect(cfg.verified).toBe(false);
      expect(cfg.revoked).toBe(false);
      expect(cfg.tampered).toBe(false);
      expect(cfg.system).toBe(false);
      expect(cfg.resizable).toBe(true);
      expect(cfg.frame).toBe(true);
      expect(cfg.devOnly).toBe(false);
      expect(cfg.handles).toBeUndefined();
      expect(cfg.minSecurityPatch).toBeNull();
      expect(cfg.unrestrictedEntry).toBe('app.js');
      expect(typeof cfg.init).toBe('function');
    });

    it('falls back to manifest-level fields when the record omits them', () => {
      const cfg = build(makePackageApp({
        // record-level fields removed — manifest carries them instead:
        unrestrictedEntry: undefined,
        devOnly: undefined,
        handles: undefined,
        allowNestedWebview: undefined,
        manifest: {
          ...LAUNCHER_APP_MANIFEST,
          id: 'com.example.packaged',
          unrestrictedEntry: 'admin.html',
          devOnly: true,
          handles: { roles: ['home'] },
          allowNestedWebview: true,
        },
      }));

      expect(cfg.unrestrictedEntry).toBe('admin.html');
      expect(cfg.devOnly).toBe(true);
      expect(cfg.handles).toEqual({ roles: ['home'] });
      // allowNestedWebview flows into the config record via the sandboxApp
      // hand-off (asserted below); the top-level config only mirrors the
      // manifest for the fields the OS reads from it.
    });

    it('preserves trust/lifecycle metadata through to the live app config', () => {
      const cfg = build(makePackageApp({
        verified: true,
        signer: 'NovaByte Trusted Signing',
        source: 'system-bundle',
        signature: 'cafe',
        signing: { method: 'ed25519', tier: 'release' },
        integrity: { method: 'blake3', fileHashes: {} },
        revoked: true,
        tampered: true,
        devOnly: true,
        transparent: true,
        alwaysOnTop: true,
        startMinimized: true,
        minSecurityPatch: '2026-08-02',
        novabyte_app: true,
        compiled_at: '2026-11-20T12:00:00.000Z',
        description: 'Keeps its description.',
        defaultSize: [1024, 768],
        minSize: [640, 480],
        resizable: false,
        frame: false,
      }));

      expect(cfg.verified).toBe(true);
      expect(cfg.signer).toBe('NovaByte Trusted Signing');
      expect(cfg.source).toBe('system-bundle');
      expect(cfg.signature).toBe('cafe');
      expect(cfg.signing).toEqual({ method: 'ed25519', tier: 'release' });
      expect(cfg.integrity).toEqual({ method: 'blake3', fileHashes: {} });
      expect(cfg.revoked).toBe(true);
      expect(cfg.tampered).toBe(true);
      expect(cfg.devOnly).toBe(true);
      expect(cfg.transparent).toBe(true);
      expect(cfg.alwaysOnTop).toBe(true);
      expect(cfg.startMinimized).toBe(true);
      expect(cfg.minSecurityPatch).toBe('2026-08-02');
      expect(cfg.novabyte_app).toBe(true);
      expect(cfg.compiled_at).toBe('2026-11-20T12:00:00.000Z');
      expect(cfg.description).toBe('Keeps its description.');
      expect(cfg.defaultSize).toEqual([1024, 768]);
      expect(cfg.minSize).toEqual([640, 480]);
      expect(cfg.resizable).toBe(false);
      expect(cfg.frame).toBe(false);
      // The embedded manifest object is carried by identity, not copied.
      const record = makePackageApp();
      expect(build(record).manifest).toBe(record.manifest);
    });

    it('only marks system:true for packages signed by the NovaByte System key', () => {
      const signed = build(makePackageApp({
        verified: true,
        signer: 'NovaByte System',
        manifest: { ...makePackageApp().manifest, system: true },
      }));
      expect(signed.system).toBe(true);

      const forged = build(makePackageApp({
        verified: true,
        signer: 'Imposter Systems',
        manifest: { ...makePackageApp().manifest, system: true },
      }));
      expect(forged.system).toBe(false);

      const unsigned = build(makePackageApp({
        manifest: { ...makePackageApp().manifest, system: true },
      }));
      expect(unsigned.system).toBe(false);

      const systemClaimOnly = build(makePackageApp({
        verified: true,
        signer: 'NovaByte System',
        manifest: { name: 'Terminal', id: 'com.example.packaged' }, // no system key at all
      }));
      expect(systemClaimOnly.system).toBe(false);
    });

    it('keeps window-app vs service-app type distinctions intact', () => {
      const windowApp = build(makePackageApp({ type: 'blank' }));
      expect(windowApp.type).toBe('blank');

      const service = build(makeServiceApp());
      expect(service.type).toBe('service');
      expect(service.entry).toBe('service.js');
      expect(service.id).toBe('com.example.svc');
      expect(service.name).toBe('Notifications');
    });
  });

  describe('package icon resolution', () => {
    it('passes through absolute, data: and http(s) icons untouched', () => {
      for (const icon of ['data:image/png;base64,AAA', 'https://cdn.example/i.png', '/assets/pic.svg']) {
        expect(build(makePackageApp({ icon })).icon).toBe(icon);
      }
    });

    it('falls back to the stock placeholder when there is no usable icon', () => {
      expect(build(makePackageApp()).icon).toBe('/assets/no_app_icon.svg');
      expect(build(makePackageApp({ icon: '' })).icon).toBe('/assets/no_app_icon.svg');
      expect(build(makePackageApp({ icon: null })).icon).toBe('/assets/no_app_icon.svg');
      expect(build(makePackageApp({ icon: 0 })).icon).toBe('/assets/no_app_icon.svg');
      // Source quirk (resolvePackageIcon): the non-string guard returns
      // `icon || placeholder`, so any TRUTHY non-string flows through as-is.
      expect(build(makePackageApp({ icon: 42 })).icon).toBe(42);
      // A packaged path with no matching file is returned unchanged, not dropped.
      expect(build(makePackageApp({ icon: 'icons/missing.png' })).icon).toBe('icons/missing.png');
    });

    it('rewrites packaged icon paths to data: URIs with the right mime per extension', () => {
      const cases = [
        ['icons/app.png', 'image/png'],
        ['icons/app.svg', 'image/svg+xml'],
        ['icons/app.jpg', 'image/jpeg'],
        ['icons/app.jpeg', 'image/jpeg'],
        ['icons/app.gif', 'image/gif'],
        ['icons/app.webp', 'image/webp'],
        ['icons/app.ico', 'image/png'], // unknown extension degrades to png
      ];
      for (const [icon, mime] of cases) {
        const cfg = build(makePackageApp({
          icon,
          files: { ...makePackageApp().files, [icon]: 'UE5HQkxPQg==' },
        }));
        expect(cfg.icon).toBe(`data:${mime};base64,UE5HQkxPQg==`);
      }
    });

    it('resolves bundled icons through the app\'s own files, not the app-manager package', () => {
      // __novaUnrestrictedPackage carries the App Manager's OWN icons; a
      // launched app must resolve its icon from its OWN files map.
      const env2 = createEnv({ unrestrictedPackage: { files: { 'icons/app.png': 'T3RoZXI=' } } });
      try {
        const build2 = requireFreshLauncher();
        const cfg = build2(makePackageApp({
          icon: 'icons/app.png',
          files: { ...makePackageApp().files, 'icons/app.png': 'QVBQ=' },
        }));
        expect(cfg.icon).toBe('data:image/png;base64,QVBQ=');
      } finally {
        env2.teardown();
      }
    });
  });

  describe('init() permission gate (REAL AppPermissionManager)', () => {
    it('skips the gate entirely when the app declares no permissions', async () => {
      const sandbox = stubSandbox();
      useRealPermissionManager();
      const mgr = vi.spyOn(RealAppPermissionManager, 'requestAll');

      await build(makePackageApp()).init(env.document.createElement('div'), null, null);

      expect(mgr).not.toHaveBeenCalled();
      expect(env.document.querySelector('button[data-action]')).toBeNull();
      expect(sandbox.launch).toHaveBeenCalledTimes(1);
      mgr.mockRestore();
    });

    it('auto-grants low-risk permissions for real and persists the grant', async () => {
      stubSandbox();
      useRealPermissionManager();
      // Optional-only declaration: nothing sensitive to consent, so the
      // gate auto-grants and completes without any dialog.
      const record = makePackageApp({
        id: 'com.example.autogrant',
        name: 'AutoGrant App',
        permissions: [],
        optionalPermissions: ['device:notifications'],
        verified: true,
      });

      await build(record).init(env.document.createElement('div'), null, null);

      // Real observable outcome: the REAL manager now reports the grant.
      expect(RealAppPermissionManager.isGranted('device:notifications', 'com.example.autogrant')).toBe(true);
      // No consent dialog ever opened (nothing to consent to).
      expect(env.document.querySelector('button[data-action]')).toBeNull();
    });

    it('prompts for missing required sensitive permissions through the real consent dialog', async () => {
      stubSandbox();
      useRealPermissionManager();
      const record = gatedRecord('com.example.gated-a');

      const p = build(record).init(env.document.createElement('div'), null, null);
      // The REAL requestAll opens the REAL dialog in the jsdom document.
      const denyBtn = await (async () => {
        for (let i = 0; i < 50; i++) {
          const btn = env.document.querySelector('button[data-action="deny"]');
          if (btn) return btn;
          await tick(5);
        }
        throw new Error('real consent dialog never opened');
      })();

      // device:camera (critical) is the only sensitive missing one; the
      // low-risk optional permission was auto-granted, not prompted.
      expect(env.document.body.textContent).toContain('Access camera');
      denyBtn.click();
      await p;

      // Denial is persisted for real, and the launch was never blocked.
      expect(RealAppPermissionManager.isDenied('device:camera', 'com.example.gated-a')).toBe(true);
      expect(RealAppPermissionManager.isGranted('device:camera', 'com.example.gated-a')).toBe(false);
    });

    it('a real Allow click persists the grant instead of the denial', async () => {
      stubSandbox();
      useRealPermissionManager();
      const record = gatedRecord('com.example.gated-b');

      const p = build(record).init(env.document.createElement('div'), null, null);
      const grantBtn = await (async () => {
        for (let i = 0; i < 50; i++) {
          const btn = env.document.querySelector('button[data-action="grant"]');
          if (btn) return btn;
          await tick(5);
        }
        throw new Error('real consent dialog never opened');
      })();
      grantBtn.click();
      await p;

      expect(RealAppPermissionManager.isGranted('device:camera', 'com.example.gated-b')).toBe(true);
    });

    it('skips prompting for permissions the user previously denied', async () => {
      stubSandbox();
      const mgr = useRealPermissionManager();
      const record = gatedRecord('com.example.gated-c');
      await mgr.revokePermission('device:camera', record.id); // persists a denial

      const requestAll = vi.spyOn(mgr, 'requestAll');
      await build(record).init(env.document.createElement('div'), null, null);

      // Previously denied = no live prompt; the app still launches.
      expect(requestAll).not.toHaveBeenCalled();
      expect(env.document.querySelector('button[data-action]')).toBeNull();
      requestAll.mockRestore();
    });

    it('runs the gate only when AppPermissionManager is defined', async () => {
      const sandbox = stubSandbox();
      // No globalThis.AppPermissionManager installed at all.
      await build(gatedRecord()).init(env.document.createElement('div'), null, null);

      expect(sandbox.launch).toHaveBeenCalledTimes(1);
      expect(env.document.querySelector('button[data-action]')).toBeNull();
    });
  });

  describe('init() AppSandbox hand-off branch', () => {
    it('passes a complete sandboxApp record with the signed identity intact', async () => {
      const sandbox = stubSandbox();
      const record = makePackageApp({
        name: 'Sandboxed App',
        verified: true,
        signer: 'NovaByte Trusted Signing',
        signature: 'sig-1',
        signing: { method: 'ed25519' },
        integrity: { method: 'blake3', fileHashes: {} },
        icon: 'icons/app.png',
        handles: { roles: ['home'] },
        allowNestedWebview: true,
        transparent: true,
        devOnly: true,
        revoked: true,
        tampered: true,
        manifest: { ...makePackageApp().manifest, system: true, devOnly: true, allowNestedWebview: true, handles: { roles: ['home'] } },
      });
      record.files['icons/app.png'] = 'UE5HQkxPQg==';

      const contentEl = env.document.createElement('div');
      const state = { prev: 1 };
      const options = { dry: true };
      const result = await build(record).init(contentEl, state, options);

      expect(sandbox.launch).toHaveBeenCalledTimes(1);
      const [sandboxApp, el, st, op] = sandbox.launch.mock.calls[0];
      expect(sandboxApp.id).toBe('com.example.packaged');
      expect(sandboxApp.name).toBe('Sandboxed App');
      expect(sandboxApp.icon).toBe('data:image/png;base64,UE5HQkxPQg==');
      expect(sandboxApp.entry).toBe('index.html');
      expect(sandboxApp.unrestrictedEntry).toBe('app.js');
      expect(sandboxApp.files).toBe(record.files);
      expect(sandboxApp.handles).toEqual({ roles: ['home'] });
      expect(sandboxApp.sandbox).toEqual({ allowScripts: true, allowForms: true, allowPopups: false });
      expect(sandboxApp.permissions).toEqual([]);
      expect(sandboxApp.optionalPermissions).toEqual([]);
      expect(sandboxApp.type).toBe('package');
      expect(sandboxApp.devOnly).toBe(true);
      expect(sandboxApp.source).toBe('store');
      expect(sandboxApp.verified).toBe(true);
      expect(sandboxApp.signer).toBe('NovaByte Trusted Signing');
      expect(sandboxApp.revoked).toBe(true);
      expect(sandboxApp.tampered).toBe(true);
      expect(sandboxApp.integrity).toEqual({ method: 'blake3', fileHashes: {} });
      expect(sandboxApp.signature).toBe('sig-1');
      expect(sandboxApp.signing).toEqual({ method: 'ed25519' });
      expect(sandboxApp.novabyte_app).toBe(true);
      expect(sandboxApp.compiled_at).toBe('2026-11-20T12:00:00.000Z');
      expect(sandboxApp.allowNestedWebview).toBe(true);
      expect(sandboxApp.transparent).toBe(true);
      expect(sandboxApp.manifest).toBe(record.manifest);
      // system uses the verified triple, never the manifest claim alone.
      expect(sandboxApp.system).toBe(false);
      expect(el).toBe(contentEl);
      expect(st).toBe(state);
      expect(op).toBe(options);
      expect(result).toEqual({ success: true, sandboxId: 'sb-1' });
    });

    it('normalises null state/options to empty objects at the hand-off', async () => {
      const sandbox = stubSandbox();
      await build(makePackageApp()).init(env.document.createElement('div'), null, null);

      const [, , st, op] = sandbox.launch.mock.calls[0];
      expect(st).toEqual({});
      expect(op).toEqual({});
    });

    it('propagates AppSandbox.launch failures instead of falling back to the legacy path', async () => {
      stubSandbox();
      globalThis.AppSandbox.launch = vi.fn(async () => { throw new Error('partition busy'); });
      const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(build(makePackageApp()).init(env.document.createElement('div'), null, null))
        .rejects.toThrow('partition busy');
      expect(consoleErr).toHaveBeenCalledTimes(1);
      expect(consoleErr).toHaveBeenCalledWith(
        '[AM.init] AppSandbox.launch THREW for',
        'com.example.packaged',
        '- falling through to legacy path:',
        expect.any(Error)
      );
    });

    it('falls back to the legacy path when AppSandbox has no launch function', async () => {
      globalThis.AppSandbox = { notALaunch: true }; // present, but not callable
      const contentEl = env.document.createElement('div');

      // Trusted record: no trust/tamper dialog can intervene, so the legacy
      // loader runs to completion.
      await build(makePackageApp({ verified: true, signer: 'NovaByte Trusted Signing' }))
        .init(contentEl, null, null);

      // Legacy branch's observable outcome: a partitioned webview got built.
      // (The un-routed default fetch makes /api/apps/serve/register fail,
      // so the legacy loader lands on its blob-URL fallback.)
      const wv = contentEl.querySelector('webview');
      expect(wv).toBeTruthy();
      expect(String(wv.src)).toMatch(/^blob:/);
      expect(wv.getAttribute('partition')).toBe('persist:app_com.example.packaged');
      // No trust dialog ever opened on the way through.
      expect(env.document.querySelector('[id^="nb-"]')).toBeNull();
    });

    it('ensures the app data folder before launching, and survives AppDirs failures', async () => {
      const sandbox = stubSandbox();
      const order = [];
      env.window.AppDirs = {
        ensureAppDataFolder: async (appId) => { order.push(['ensure', appId]); return '/data/x'; },
        getFSDir: (appId, kind) => `/data/${appId}/${kind}`,
      };

      await build(makePackageApp()).init(env.document.createElement('div'), null, null);
      expect(order).toEqual([['ensure', 'com.example.packaged']]);
      expect(sandbox.launch).toHaveBeenCalledTimes(1);

      // ensureAppDataFolder throwing is best-effort: the launch still runs.
      env.window.AppDirs = {
        ensureAppDataFolder: async () => { throw new Error('quota'); },
        getFSDir: () => '/data/x/files',
      };
      await build(makePackageApp()).init(env.document.createElement('div'), null, null);
      expect(sandbox.launch).toHaveBeenCalledTimes(2);
    });
  });
});
