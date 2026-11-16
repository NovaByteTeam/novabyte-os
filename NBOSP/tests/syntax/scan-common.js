'use strict';

/**
 * Shared scanner helpers for the tests/syntax suite.
 *
 * Every checker (js-syntax.js, json-syntax.js, css-syntax.js,
 * html-syntax.js) walks the same file set so the four of them stay in
 * lock-step about what gets validated:
 *
 *   - scope: the NBOSP/ tree only
 *   - excluded: the os/ packaging section (NBOSP/os/, per repo test
 *     policy), plus the marketing site (src/), the Supabase functions
 *     (supabase/) and docs/ — and, at any depth, VCS internals,
 *     dependency trees and generated/volatile directories (mirrors the
 *     top-level .gitignore so build output is never scanned).
 *
 * Only .js / .mjs / .cjs, .json, .css and .html files are ever validated;
 * markdown, YAML, licenses and SVG assets are out of scope by design.
 */

const fs = require('node:fs');
const path = require('node:path');

// <repoRoot>/NBOSP/tests/syntax/scan-common.js -> NBOSP project root.
const NBOSP_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(NBOSP_ROOT, '..');

// Directory names that are never scanned, at any depth. These are VCS
// internals, dependency trees, or generated output (see .gitignore), or
// the deliberately-broken fixture files the syntax suite validates
// itself against (tests/syntax/fixtures/).
const EXCLUDED_DIR_NAMES = new Set([
  'fixtures',
  '.git',
  'node_modules',
  '.cache',
  '.dist',
  '.update-backups',
  '.update-keys',
  '.wrangler',
  '.zcode',
  '.kilo',
  '.vs',
  'graphify-out',
  'novabyte-v3-build',
  'build',
  '.build-stage',
  '.nwjs-cache',
  'cache',
  'dist',
  'data',
]);

// NBOSP-relative prefixes that are never scanned. The os/ section
// (NBOSP/os/) is deliberately out of scope for the test suite.
const EXCLUDED_RELATIVE_PREFIXES = ['os' + path.sep];

/** True when a directory entry (by name) must be skipped entirely. */
function isExcludedDir(name) {
  return EXCLUDED_DIR_NAMES.has(name);
}

/** True when a repo-relative file path falls in an excluded section. */
function isExcludedRelative(relativePath) {
  return EXCLUDED_RELATIVE_PREFIXES.some(prefix => relativePath.startsWith(prefix));
}

/**
 * Recursively collect every file matching one of the given extensions.
 *
 * @param {string[]} extensions - Extensions to match, each including the
 *   leading dot (e.g. ['.js', '.mjs', '.cjs']).
 * @returns {string[]} Sorted absolute file paths under NBOSP/.
 */
function collectTargetFiles(extensions) {
  const found = [];

  function walk(dir, relativeBase) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — nothing to check there
    }

    for (const entry of entries) {
      const relativePath = relativeBase ? path.join(relativeBase, entry.name) : entry.name;
      if (isExcludedRelative(relativePath)) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isExcludedDir(entry.name)) continue;
        walk(fullPath, relativePath);
      } else if (entry.isFile() && extensions.includes(path.extname(entry.name))) {
        found.push(fullPath);
      }
    }
  }

  walk(NBOSP_ROOT, '');
  return found.sort((a, b) => a.localeCompare(b));
}

/** Format one failure record for CLI/vitest output. */
function formatFailure(failure) {
  const rel = path.relative(NBOSP_ROOT, failure.file);
  const lines = [`  ${rel}`];
  for (const error of failure.errors) lines.push(`    ${error}`);
  return lines.join('\n');
}

/** Print a standalone CLI report and return the process exit code. */
function reportAndExit(checkerName, result) {
  const { total, failed, failures } = result;
  if (failed > 0) {
    console.error(`\n[fail] ${checkerName}: ${failed} of ${total} file(s) failed:\n`);
    for (const failure of failures) console.error(formatFailure(failure));
    console.error(`\n[fail] ${checkerName}: ${failed} of ${total} file(s) failed.`);
    return 1;
  }
  console.log(`[ok] ${checkerName}: ${total} file(s) passed.`);
  return 0;
}

module.exports = {
  NBOSP_ROOT,
  REPO_ROOT,
  collectTargetFiles,
  formatFailure,
  reportAndExit,
  isExcludedDir,
  isExcludedRelative,
};
