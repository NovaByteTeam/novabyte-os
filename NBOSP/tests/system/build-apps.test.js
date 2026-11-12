import { execFileSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectDir = fileURLToPath(new URL('../..', import.meta.url));

/** Extracts the System signing anchor JWK from trust-store.js source. */
function systemAnchorJwk() {
  const trustStoreSource = readFileSync(
    path.join(projectDir, 'js', 'platform', 'security', 'trust-store.js'),
    'utf8',
  );
  const systemKeyMatch = trustStoreSource.match(
    /const NOVABYTE_SYSTEM_SIGNING_PUBLIC_JWK = (\{[\s\S]*?\n\};)/,
  );
  expect(systemKeyMatch).not.toBeNull();
  return JSON.parse(systemKeyMatch[1].slice(0, -1));
}

describe('NovaApp build signatures', () => {
  it('signs packages with the environment-supplied System key and never trusts a repo key', () => {
    const appsDir = mkdtempSync(path.join(os.tmpdir(), 'novabyte-app-build-'));
    const appDirs = [
      {
        directory: 'shell-ui',
        id: 'com.nbosp.shell-ui',
        entry: 'wm.js',
        source: 'window.shellUiStarted = true;',
      },
      {
        directory: 'app-loader-optimiser',
        id: 'com.nbosp.service.app-loader-optimiser',
        entry: 'service.js',
        source: 'window.appLoaderOptimiserStarted = true;',
      },
    ];
    for (const app of appDirs) {
      const appDir = path.join(appsDir, app.directory);
      mkdirSync(appDir);
      writeFileSync(path.join(appDir, 'manifest.json'), JSON.stringify({
        id: app.id,
        name: app.id,
        version: '1.0.0',
        entry: app.entry,
        guestEntry: app.entry,
        system: true,
        systemService: true,
        permissions: [],
      }));
      writeFileSync(path.join(appDir, app.entry), app.source);
    }

    // ── Audit regression guard (2026-11-12, finding F1) ──
    // The old development key committed at NBOSP/keys/test-system-key.json
    // matched the trust-store anchor, so anyone who could read the repo
    // could forge "NovaByte System"-signed packages. That file must never
    // come back, and no other private key material may live under keys/.
    expect(existsSync(path.join(projectDir, 'keys', 'test-system-key.json'))).toBe(false);

    // The build signs with an EPHEMERAL throwaway key supplied via the
    // environment (the real System private key is held offline and is
    // never in the repo)…
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyFile = path.join(appsDir, 'ephemeral-signing-key.json');
    writeFileSync(keyFile, JSON.stringify(privateKey.export({ format: 'jwk' })));

    try {
      execFileSync(process.execPath, [
        path.join(projectDir, 'build-apps.mjs'),
        appsDir,
        ...appDirs.map(app => app.directory),
      ], {
        cwd: projectDir,
        stdio: 'ignore',
        env: { ...process.env, NBOSP_SYSTEM_SIGNING_KEY_PATH: keyFile },
      });

      const anchor = systemAnchorJwk();
      const anchorKey = createPublicKey({ key: anchor, format: 'jwk' });
      const ephemeralPublicJwk = publicKey.export({ format: 'jwk' });
      // …which means the ephemeral key is NOT the trusted anchor: packages
      // built with a throwaway key must not verify as System-signed.
      expect(ephemeralPublicJwk.x).not.toBe(anchor.x);

      for (const app of appDirs) {
        const pkg = JSON.parse(readFileSync(path.join(appsDir, `${app.id}.novaapp`), 'utf8'));
        const payload = JSON.stringify({
          novabyte_app: pkg.novabyte_app,
          manifest: pkg.manifest,
          files: pkg.files,
          compiled_at: pkg.compiled_at,
        });

        expect(pkg.manifest.id).toBe(app.id);
        expect(pkg.manifest.systemService).toBe(true);
        expect(pkg.signing.method).toBe('ed25519');
        expect(pkg.signature).toBe(pkg.signing.signature);

        // Signature verifies against the key that actually signed it.
        expect(verify(
          null,
          Buffer.from(payload, 'utf8'),
          publicKey,
          Buffer.from(pkg.signature, 'hex'),
        )).toBe(true);

        // …and does NOT verify against the trust-store System anchor.
        expect(verify(
          null,
          Buffer.from(payload, 'utf8'),
          anchorKey,
          Buffer.from(pkg.signature, 'hex'),
        )).toBe(false);

        const tamperedPayload = JSON.stringify({
          novabyte_app: pkg.novabyte_app,
          manifest: pkg.manifest,
          files: { ...pkg.files, [app.entry]: Buffer.from('window.tampered = true;').toString('base64') },
          compiled_at: pkg.compiled_at,
        });
        expect(verify(
          null,
          Buffer.from(tamperedPayload, 'utf8'),
          publicKey,
          Buffer.from(pkg.signature, 'hex'),
        )).toBe(false);
      }
    } finally {
      rmSync(appsDir, { recursive: true, force: true });
    }
  });

  it('builds UNSIGNED packages when no signing key is configured', () => {
    const appsDir = mkdtempSync(path.join(os.tmpdir(), 'novabyte-app-build-unsigned-'));
    const appDir = path.join(appsDir, 'clock');
    mkdirSync(appDir);
    writeFileSync(path.join(appDir, 'manifest.json'), JSON.stringify({
      id: 'com.nbosp.clock',
      name: 'com.nbosp.clock',
      version: '1.0.0',
      entry: 'service.js',
      guestEntry: 'service.js',
      system: true,
      systemService: true,
      permissions: [],
    }));
    writeFileSync(path.join(appDir, 'service.js'), 'window.clockStarted = true;');

    try {
      execFileSync(process.execPath, [
        path.join(projectDir, 'build-apps.mjs'),
        appsDir,
        'clock',
      ], {
        cwd: projectDir,
        stdio: 'ignore',
        env: { ...process.env, NBOSP_SYSTEM_SIGNING_KEY_PATH: '', NBOSP_SYSTEM_SIGNING_KEY: '' },
      });

      const pkg = JSON.parse(readFileSync(path.join(appsDir, 'com.nbosp.clock.novaapp'), 'utf8'));
      // Unsigned builds carry no signature at all — never a fake one.
      expect(pkg.signing).toMatchObject({ method: 'none' });
      expect(pkg.signature).toBeUndefined();
      // Integrity is still recorded (bundled system apps are gated on it).
      expect(pkg.integrity.method).toBe('sha512');
      expect(pkg.integrity.payloadHash).toMatch(/^[a-f0-9]{128}$/);
    } finally {
      rmSync(appsDir, { recursive: true, force: true });
    }
  });
});
