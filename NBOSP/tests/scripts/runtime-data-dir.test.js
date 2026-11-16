import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts loaded through CJS require — the same style startup.test.js's
// bootstrap chain uses, keeping the coverage merge uniform across workers.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ensureEnv } = require('../../scripts/env.js');
const { ensureCerts } = require('../../scripts/certs.js');
import { seedCerts } from '../server/helpers/seed-certs.js';
const { getRuntimeDataDir } = require('../../scripts/runtime-data-dir.js');

describe('Linux runtime data directory', () => {
  let tempDir;
  const originalEnv = { ...process.env };

  afterEach(async () => {
    process.env = { ...originalEnv };
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('stores generated environment secrets outside the packaged application', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nbosp-runtime-data-'));
    const appDir = path.join(tempDir, 'app');
    const dataDir = path.join(tempDir, 'runtime');
    await fs.mkdir(appDir);
    await fs.writeFile(path.join(appDir, '.env.example'), [
      'PORT=3003',
      'RATE_LIMIT_WINDOW_MS=900000',
      'RATE_LIMIT_MAX_REQUESTS=100',
      'CORS_ORIGIN=https://localhost:3003',
      'NODE_EXTRA_CA_CERTS=ca.crt',
      'NODE_ENV=development',
      'SESSION_SECRET=',
      'NBOSP_CRED_KEY=',
    ].join('\n'));
    process.env.NBOSP_DATA_DIR = dataDir;
    process.env.NODE_ENV = 'production';

    await ensureEnv(appDir);

    expect(process.env.NODE_ENV).toBe('production');
    const savedEnv = await fs.readFile(path.join(dataDir, '.env'), 'utf8');
    expect(savedEnv).toContain('SESSION_SECRET=');
    expect(savedEnv).toContain('NBOSP_CRED_KEY=');
    if (process.platform === 'linux') {
      expect(savedEnv).toContain(`NODE_EXTRA_CA_CERTS="${path.join(dataDir, 'ca.crt')}"`);
    }
    await expect(fs.access(path.join(appDir, '.env'))).rejects.toThrow();
  });

  it('loads existing certificates and trust state from the runtime directory', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nbosp-runtime-certs-'));
    const appDir = path.join(tempDir, 'app');
    const dataDir = path.join(tempDir, 'runtime');
    await fs.mkdir(appDir);
    await fs.mkdir(dataDir);
    await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({ window: {} }));
    await seedCerts(dataDir);
    await fs.writeFile(path.join(dataDir, 'ca.trusted'), 'test');
    process.env.NBOSP_DATA_DIR = dataDir;

    await expect(ensureCerts(appDir, () => true)).resolves.toBe(true);
    await expect(fs.access(path.join(appDir, 'cert.key'))).rejects.toThrow();
  });
});

describe('getRuntimeDataDir — precedence chain', () => {
  const originalEnv = { ...process.env };
  // NBOSP/scripts/.. == the NBOSP package root
  const NBOSP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('falls back to the packaged app dir above the script when nothing is given', () => {
    delete process.env.NBOSP_DATA_DIR;
    expect(getRuntimeDataDir(null)).toBe(NBOSP_ROOT);
    expect(getRuntimeDataDir(undefined)).toBe(NBOSP_ROOT);
    expect(getRuntimeDataDir('')).toBe(NBOSP_ROOT);
  });

  it('prefers an explicit app dir over the script location', () => {
    delete process.env.NBOSP_DATA_DIR;
    expect(getRuntimeDataDir('/opt/nbosp/package.nw')).toBe('/opt/nbosp/package.nw');
  });

  it('lets NBOSP_DATA_DIR win over both the app dir and the fallback', () => {
    process.env.NBOSP_DATA_DIR = '/var/lib/novabyte';
    expect(getRuntimeDataDir('/opt/nbosp/package.nw')).toBe('/var/lib/novabyte');
    expect(getRuntimeDataDir(null)).toBe('/var/lib/novabyte');
  });
});
