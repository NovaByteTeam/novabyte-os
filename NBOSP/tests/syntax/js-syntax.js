'use strict';

/**
 * js-syntax.js — Node.js built-in syntax checker for every JavaScript file.
 *
 * Runs `node --check` (Node's own built-in parse-only syntax checker — the
 * file is compiled but never executed) over every .js / .mjs / .cjs file in
 * the repository, excluding the os/ section, node_modules and generated
 * output directories.
 *
 * Format handling: `node --check` derives the module format for a path from
 * its extension plus the nearest package.json "type" field. This repository
 * intentionally mixes formats — e.g. the vitest suites under NBOSP (a CJS
 * package) are written with ESM import/export syntax, while src/ is an ESM
 * package with CJS-free sources. A plain --check therefore fails on ESM
 * syntax in .js files under CJS packages without that being a real syntax
 * error. When the native check fails, the source is re-checked once through
 * a temporary .mjs copy (which forces an ECMAScript-modules parse). Only a
 * file that fails BOTH parses is reported as a genuine syntax error.
 *
 * Usage:
 *   node tests/syntax/js-syntax.js     (standalone — exit code 1 on failure)
 *   run() / checkFile()                (imported by tests/syntax/syntax.test.js)
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const { collectTargetFiles, reportAndExit } = require('./scan-common.js');

const execFileP = promisify(execFile);
const EXTENSIONS = ['.js', '.mjs', '.cjs'];
const CONCURRENCY = 16;

/** Run `node --check` against a file path. Resolves on success. */
function nodeCheck(file) {
  return execFileP(process.execPath, ['--check', file]);
}

/**
 * Syntax-check a single JavaScript file (native format first, ESM re-parse
 * as the documented fallback).
 *
 * @param {string} file Absolute path.
 * @param {string|null} [esmScratchDir] Optional existing temp directory for
 *   the .mjs fallback copy (avoids one mkdtemp per file when scanning).
 * @returns {Promise<string[]>} Empty array when the file parses.
 */
async function checkFile(file, esmScratchDir = null) {
  try {
    await nodeCheck(file);
    return [];
  } catch (cjsError) {
    // Fall through to the ESM re-parse below.
    let scratch = esmScratchDir;
    let createdScratch = false;
    if (!scratch) {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nbosp-js-syntax-'));
      createdScratch = true;
    }
    try {
      const copy = path.join(scratch, `esm-${process.pid}-${path.basename(file)}.mjs`);
      fs.writeFileSync(copy, fs.readFileSync(file));
      try {
        await nodeCheck(copy);
        return [];
      } catch {
        return [summariseError(cjsError)];
      }
    } finally {
      if (createdScratch) fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/** Reduce a child-process error to a compact, useful message. */
function summariseError(error) {
  const stderr = String(error.stderr || '');
  const lines = stderr.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  // `node --check` stderr starts with a "file:line" header, then the source
  // line, a caret, and finally "<ErrorClass>: message". Prefer the actual
  // error line so callers see "SyntaxError: ..." instead of a bare path.
  const errorLine = lines.find(line => /^[A-Za-z]+(Error|Exception): /.test(line));
  return errorLine || lines[0] || error.message || String(error);
}

/** Simple bounded-concurrency map over the file list. */
async function mapConcurrent(items, worker, limit = CONCURRENCY) {
  const results = new Array(items.length);
  let cursor = 0;
  async function lane() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/**
 * Check every target file in the repository.
 *
 * @returns {Promise<{total:number, failed:number, passed:number,
 *   failures: Array<{file:string, errors:string[]}>}>}
 */
async function run() {
  const files = collectTargetFiles(EXTENSIONS);
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbosp-js-syntax-'));
  let failures;
  try {
    const perFile = await mapConcurrent(files, file => checkFile(file, scratchDir));
    failures = files
      .map((file, index) => ({ file, errors: perFile[index] }))
      .filter(entry => entry.errors.length > 0);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
  return {
    total: files.length,
    failed: failures.length,
    passed: files.length - failures.length,
    failures,
  };
}

if (require.main === module) {
  run()
    .then(result => process.exit(reportAndExit('js-syntax', result)))
    .catch(error => {
      console.error('[fail] js-syntax: checker crashed:', error);
      process.exit(1);
    });
}

module.exports = { run, checkFile, EXTENSIONS };
