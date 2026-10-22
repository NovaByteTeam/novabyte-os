import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const installerPath = fileURLToPath(
  new URL('../os/package/nbosp-install/nbosp-install-system', import.meta.url)
);

describe('NBOSP disk installer boot configuration', () => {
  it('uses the GPT partition UUID for kernel root lookup without an initramfs', () => {
    const installer = readFileSync(installerPath, 'utf8');

    expect(installer).toContain('ROOT_PARTUUID="$(blkid -s PARTUUID -o value "$ROOT_PART")"');
    expect(installer).toContain('root=PARTUUID=$ROOT_PARTUUID');
    expect(installer).not.toContain('root=UUID=$ROOT_UUID');
  });
});
