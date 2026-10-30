import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const brokerSource = readFileSync(
  fileURLToPath(new URL('../../js/platform/security/root-broker.js', import.meta.url)),
  'utf8',
);

describe('NovaRoot broker', () => {
  it('detects sudo using the imported child_process module', () => {
    const execFileSync = vi.fn();
    const window = {};
    const context = {
      window,
      console: { info() {} },
      require: name => {
        if (name === 'child_process') return { execFileSync };
        if (name === 'fs' || name === 'path') return {};
        throw new Error(`Unexpected module: ${name}`);
      },
    };

    runInNewContext(brokerSource, context);

    expect(window.NovaRoot.status().available).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'sudo',
      ['--version'],
      { stdio: 'ignore', timeout: 5000 },
    );
  });
});
