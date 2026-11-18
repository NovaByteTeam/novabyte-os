import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}

describe('system service and app-specific icons', () => {
  it('uses shared assets for all embedded developer-app icons', async () => {
    const appDirectories = await readdir(path.join(root, 'js/apps'), { withFileTypes: true });
    const manifests = await Promise.all(appDirectories
      .filter(entry => entry.isDirectory())
      .map(async entry => {
        try {
          return {
            directory: entry.name,
            manifest: await readJson(`js/apps/${entry.name}/manifest.json`),
          };
        } catch (error) {
          if (error.code === 'ENOENT') return null;
          throw error;
        }
      }));

    for (const app of manifests.filter(app => app &&
      (app.manifest.category === 'developer' || app.manifest.categories?.includes('developer')))) {
      expect(app.manifest.icon).toBe(`/assets/${app.directory}.svg`);
      const source = await readFile(path.join(root, 'js/apps', app.directory, 'app.js'), 'utf8');
      expect(source).toContain(`icon: '/assets/${app.directory}.svg'`);
      expect(await readFile(path.join(root, 'assets', `${app.directory}.svg`), 'utf8')).toContain('<svg');
    }
  });

  it('gives every registered system service a resolvable icon', async () => {
    const [services, appDirectories] = await Promise.all([
      readJson('js/apps/system-service-manifest.json'),
      readdir(path.join(root, 'js/apps'), { withFileTypes: true }),
    ]);
    const appManifests = await Promise.all(appDirectories
      .filter(entry => entry.isDirectory())
      .map(async entry => {
        const manifestPath = path.join(root, 'js/apps', entry.name, 'manifest.json');
        try {
          return {
            directory: entry.name,
            manifest: JSON.parse(await readFile(manifestPath, 'utf8')),
          };
        } catch (error) {
          if (error.code === 'ENOENT') return null;
          throw error;
        }
      }));
    const manifestsById = new Map(appManifests.filter(Boolean)
      .map(({ directory, manifest }) => [manifest.id, { directory, manifest }]));

    for (const service of services) {
      const app = manifestsById.get(service.id);
      expect(app, `${service.id} package manifest`).toBeDefined();
      expect(app.manifest.icon, `${service.id} icon`).toMatch(/^\/assets\/[A-Za-z0-9._/-]+$/);
      expect(await readFile(path.join(root, app.manifest.icon.slice(1)))).toBeInstanceOf(Buffer);
    }
  });

  it('uses app-specific assets for every non-service, non-developer app', async () => {
    const [services, appDirectories] = await Promise.all([
      readJson('js/apps/system-service-manifest.json'),
      readdir(path.join(root, 'js/apps'), { withFileTypes: true }),
    ]);
    const serviceIds = new Set(services.map(service => service.id));

    for (const entry of appDirectories.filter(item => item.isDirectory())) {
      let manifest;
      try {
        manifest = await readJson(`js/apps/${entry.name}/manifest.json`);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const categories = manifest.categories ?? [manifest.category];
      if (serviceIds.has(manifest.id) || categories.includes('developer')) continue;

      expect(manifest.icon, `${entry.name} manifest icon`).toBe(`/assets/${entry.name}.svg`);
      const appSource = await readFile(path.join(root, 'assets', `${entry.name}.svg`), 'utf8');
      expect(appSource, `${entry.name} SVG`).toContain('<svg');

      try {
        const runtimeSource = await readFile(path.join(root, 'js/apps', entry.name, 'app.js'), 'utf8');
        if (entry.name !== 'launcher') {
          expect(runtimeSource, `${entry.name} runtime icon`).toContain(`icon: '/assets/${entry.name}.svg'`);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  });
});
