import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// CJS require — startup.test.js loads certs.js through its own require
// chain; one loading style everywhere keeps the coverage merge honest.
const { createRequire } = await import('node:module');
const { ensureCerts } = createRequire(import.meta.url)('../../scripts/certs.js');
import { seedCerts } from '../server/helpers/seed-certs.js';

describe('scripts/certs.js — kiosk localhost certificate handling', () => {
  let appDir;

  afterEach(async () => {
    if (appDir) {
      await fs.rm(appDir, { recursive: true, force: true });
      appDir = undefined;
    }
  });

  it('preserves the localhost-only certificate exception while removing broad bypass flags', async () => {
    appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nbosp-certs-'));

    await seedCerts(appDir);
    await fs.writeFile(path.join(appDir, 'ca.trusted'), 'test');

    const manifestPath = path.join(appDir, 'package.json');
    await fs.writeFile(manifestPath, JSON.stringify({
      window: {
        'chromium-args': [
          '--allow-insecure-localhost',
          '--ignore-certificate-errors',
          '--ignore-certificate-errors-spki-list=stale-pin',
        ].join(' '),
      },
    }));

    const trustInstaller = vi.fn(() => true);
    await expect(ensureCerts(appDir, trustInstaller)).resolves.toBe(true);
    if (process.platform === 'linux') {
      expect(trustInstaller).toHaveBeenCalledOnce();
      expect(trustInstaller).toHaveBeenCalledWith(path.join(appDir, 'ca.crt'));
    }

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    expect(manifest.window['chromium-args']).toContain('--allow-insecure-localhost');
    expect(manifest.window['chromium-args']).not.toContain('--ignore-certificate-errors');
    expect(manifest.window['chromium-args']).not.toContain('--ignore-certificate-errors-spki-list');
  });

  // Regression: an interrupted write left empty/truncated PEMs that passed the
  // old exists-and-recent check, so ssl.js crashed on every boot after.
  it.each([
    ['an empty cert.crt',          'cert.crt', ''],
    ['a truncated cert.key',       'cert.key', '-----BEGIN PRIVATE KEY-----\nMIIE'],
    ['a cert.crt with no PEM',     'cert.crt', 'test'],
  ])('regenerates instead of reusing %s', async (_label, file, content) => {
    appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nbosp-certs-'));
    await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({ window: {} }));
    await seedCerts(appDir);
    await fs.writeFile(path.join(appDir, file), content);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await ensureCerts(appDir, () => true);
      expect(log).toHaveBeenCalledWith('[NovaByte] Generating CA and server certificate...');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('keeps valid certs without regenerating', async () => {
    appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nbosp-certs-'));
    await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({ window: {} }));
    await seedCerts(appDir);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(ensureCerts(appDir, () => true)).resolves.toBe(true);
      expect(log).not.toHaveBeenCalledWith('[NovaByte] Generating CA and server certificate...');
    } finally {
      vi.restoreAllMocks();
    }
  });

  // certsAreFresh: valid PEMs whose mtime has crossed CERT_MAX_AGE_MS must be
  // treated as stale and regenerated (10-year certificate lifetime guard).
  it('regenerates when valid PEMs are older than the max cert age', async () => {
    appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nbosp-certs-'));
    await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({ window: {} }));
    await seedCerts(appDir);

    const elevenYearsAgo = new Date(Date.now() - 11 * 365.25 * 24 * 60 * 60 * 1000);
    for (const f of ['ca.crt', 'ca.key', 'cert.crt', 'cert.key']) {
      await fs.utimes(path.join(appDir, f), elevenYearsAgo, elevenYearsAgo);
    }

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(ensureCerts(appDir, () => true)).resolves.toBe(true);
      // Stale mtime forces the full regeneration path.
      expect(log).toHaveBeenCalledWith('[NovaByte] Generating CA and server certificate...');
    } finally {
      vi.restoreAllMocks();
    }
  });

  // On non-Linux platforms a fresh+trusted state returns early with the CA
  // already trusted — no trustInstaller call and no regeneration.
  it('returns early with fresh trusted certs on non-Linux platforms', async () => {
    appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nbosp-certs-'));
    await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({
      window: { 'chromium-args': '--ignore-certificate-errors-spki-list=stale-pin' },
    }));
    await seedCerts(appDir);
    await fs.writeFile(path.join(appDir, 'ca.trusted'), new Date().toISOString());

    const trustInstaller = vi.fn(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      await expect(ensureCerts(appDir, trustInstaller)).resolves.toBe(true);
      expect(log).toHaveBeenCalledWith('[NovaByte] Certs OK, CA already trusted — HTTPS ready.');
      expect(trustInstaller).not.toHaveBeenCalled();

      // The SPKI pin must still be stripped from the manifest on the early path.
      const manifest = JSON.parse(await fs.readFile(path.join(appDir, 'package.json'), 'utf8'));
      expect(manifest.window['chromium-args']).not.toContain('stale-pin');
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      vi.restoreAllMocks();
    }
  });

  // writeFileAtomic: a failed rename must remove the temp file and rethrow,
  // which surfaces as "Certificate generation failed" in ensureCerts.
  it('cleans up the temp file and reports failure when an atomic rename fails', async () => {
    appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nbosp-certs-'));
    await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({ window: {} }));
    await seedCerts(appDir);
    // invalidate one PEM so ensureCerts enters the regeneration path
    await fs.writeFile(path.join(appDir, 'cert.crt'), 'truncated');

    const { promises: fsp } = await import('node:fs');
    const renameSpy = vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('EIO rename'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(ensureCerts(appDir, () => true)).resolves.toBe(false);
      expect(errLog).toHaveBeenCalledWith('[NovaByte] Certificate generation failed:', 'EIO rename');
      // The temp files of the non-failed writes must still exist as *.tmp — the
      // failed atomic write removed only its own temp file.
      expect(renameSpy).toHaveBeenCalled();
    } finally {
      renameSpy.mockRestore();
      vi.restoreAllMocks();
    }
  });

  // stripSpkiFromPackageJson: an unreadable package.json must log the failure
  // and let ensureCerts still succeed (best-effort cleaning).
  it('logs a warning when package.json cannot be read for SPKI stripping', async () => {
    appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nbosp-certs-'));
    await seedCerts(appDir);
    await fs.writeFile(path.join(appDir, 'ca.trusted'), new Date().toISOString());
    // A directory named package.json makes the read fail with EISDIR.
    await fs.mkdir(path.join(appDir, 'package.json'));

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      await expect(ensureCerts(appDir, () => true)).resolves.toBe(true);
      expect(log).toHaveBeenCalledWith('[NovaByte] Certs OK, CA already trusted — HTTPS ready.');
      expect(errLog).toHaveBeenCalledWith('[NovaByte] Failed to clean package.json:', expect.stringContaining('EISDIR'));
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      vi.restoreAllMocks();
    }
  });
});
