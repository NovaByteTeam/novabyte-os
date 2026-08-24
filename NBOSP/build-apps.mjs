#!/usr/bin/env node
// Repackages every app under js/apps/<id>/ into a single js/apps/<id>.novaapp
// file, then deletes the source folder. Only manifest.json, index.html,
// app.js, and style.css are bundled — anything else in the folder (assets/,
// images, etc.) is left out and reported as skipped, since a couple of these
// apps do carry runtime assets that this script intentionally won't pull in.
//
// Usage: node scripts/build-apps.mjs [apps-dir]
// Defaults to js/apps relative to this script's location.

import { readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGED_FILES = ['manifest.json', 'index.html', 'app.js', 'style.css'];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appsDir = path.resolve(process.argv[2] ?? path.join(scriptDir, '..', 'js', 'apps'));

async function findAppDirs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function packageApp(appId, appDir) {
  const manifestRaw = await readFile(path.join(appDir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);

  const files = {};
  for (const name of PACKAGED_FILES) {
    const filePath = path.join(appDir, name);
    try {
      const buf = await readFile(filePath);
      files[name] = buf.toString('base64');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // Optional files (e.g. style.css) can legitimately be missing.
    }
  }

  const allEntries = await readdir(appDir, { withFileTypes: true });
  const skipped = allEntries
    .map((e) => e.name)
    .filter((name) => !PACKAGED_FILES.includes(name));
  if (skipped.length > 0) {
    console.warn(`  ! ${appId}: not packaged (outside js/manifest/html/css scope): ${skipped.join(', ')}`);
  }

  return {
    novabyte_app: true,
    compiled_at: Date.now(),
    manifest,
    files,
    signing: { method: 'none' },
    integrity: { method: 'none' },
  };
}

async function buildOne(appDirName) {
  const appDir = path.join(appsDir, appDirName);
  const manifestPath = path.join(appDir, 'manifest.json');

  try {
    await stat(manifestPath);
  } catch {
    console.log(`- skip ${appDirName}: no manifest.json, not an app dir`);
    return;
  }

  const pkg = await packageApp(appDirName, appDir);
  const appId = pkg.manifest.id ?? appDirName;
  const outPath = path.join(appsDir, `${appId}.novaapp`);

  await writeFile(outPath, JSON.stringify(pkg, null, 2));
  await rm(appDir, { recursive: true, force: true });

  console.log(`✓ ${appDirName} -> ${path.relative(appsDir, outPath)}`);
}

async function main() {
  const dirs = await findAppDirs(appsDir);
  if (dirs.length === 0) {
    console.log(`No app directories found in ${appsDir}`);
    return;
  }

  console.log(`Building ${dirs.length} app(s) from ${appsDir}\n`);
  for (const dirName of dirs) {
    await buildOne(dirName);
  }
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exitCode = 1;
});
