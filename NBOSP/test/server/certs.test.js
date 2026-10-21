import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureCerts } from '../../scripts/certs.js';

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

    for (const file of ['ca.key', 'ca.crt', 'cert.key', 'cert.crt', 'ca.trusted']) {
      await fs.writeFile(path.join(appDir, file), 'test');
    }

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

    await expect(ensureCerts(appDir)).resolves.toBe(true);

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    expect(manifest.window['chromium-args']).toContain('--allow-insecure-localhost');
    expect(manifest.window['chromium-args']).not.toContain('--ignore-certificate-errors');
    expect(manifest.window['chromium-args']).not.toContain('--ignore-certificate-errors-spki-list');
  });
});
