#!/usr/bin/env node
// Repackages every app under js/apps/<id>/ into a single js/apps/<id>.novaapp
// file. Every file in the app folder is bundled (manifest, html, js, css,
// assets/, images, fonts, whatever's there), recursing into subdirectories.
//
// The one exception is _package-meta.json — that's leftover metadata from a
// previous build, not something the app loads at runtime, so re-bundling it
// would embed a stale signature block inside the new package.
//
// This script never deletes or modifies the source folder. It only writes
// the .novaapp file alongside it.
//
// Usage: node scripts/build-apps.mjs [apps-dir]
// Defaults to js/apps relative to this script's location.

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXCLUDED_FILES = new Set(['_package-meta.json']);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appsDir = path.resolve(process.argv[2] ?? path.join(scriptDir, '..', 'js', 'apps'));

async function findAppDirs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

// Recursively collects every file under `dir`, returning paths relative to
// `baseDir` using forward slashes (so the package's file keys are portable).
async function collectFiles(dir, baseDir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      out.push(...(await collectFiles(fullPath, baseDir)));
      continue;
    }

    if (EXCLUDED_FILES.has(entry.name)) continue;

    const relPath = path.relative(baseDir, fullPath).split(path.sep).join('/');
    out.push(relPath);
  }

  return out;
}

async function packageApp(appDir) {
  const manifestRaw = await readFile(path.join(appDir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);

  const relPaths = await collectFiles(appDir, appDir);

  const files = {};
  for (const relPath of relPaths) {
    const buf = await readFile(path.join(appDir, relPath));
    files[relPath] = buf.toString('base64');
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

  const pkg = await packageApp(appDir);
  const appId = pkg.manifest.id ?? appDirName;
  const outPath = path.join(appsDir, `${appId}.novaapp`);
  const fileCount = Object.keys(pkg.files).length;

  await writeFile(outPath, JSON.stringify(pkg, null, 2));

  console.log(`✓ ${appDirName} -> ${path.relative(appsDir, outPath)} (${fileCount} file${fileCount === 1 ? '' : 's'}, source untouched)`);
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
