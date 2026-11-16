'use strict';

/**
 * css-syntax.js — CSS syntax checker for every .css file in the repository
 * (excluding the os/ section, node_modules and generated output
 * directories).
 *
 * Uses the csstree-validator package (https://www.npmjs.com/package/csstree-validator,
 * built on the css-tree parser used by the CSS spec test suites). Each
 * stylesheet is parsed and validated; both parse-level errors (malformed
 * declarations, missing colons, garbage tokens) and property/value-level
 * errors (unknown properties, invalid values) are reported with their
 * line:column positions.
 *
 * Usage:
 *   node tests/syntax/css-syntax.js     (standalone — exit code 1 on failure)
 *   run() / checkSource()               (imported by tests/syntax/syntax.test.js)
 */

const fs = require('node:fs');
const path = require('node:path');

const { validateString } = require('csstree-validator');
const { collectTargetFiles, reportAndExit } = require('./scan-common.js');

const EXTENSIONS = ['.css'];

/**
 * Validate a CSS source string and return positioned error descriptions.
 *
 * csstree-validator's validateString(source, filename) returns a report
 * object keyed by filename whose values are arrays of error entries with
 * .message, .line and .column fields.
 *
 * @param {string} source CSS source text.
 * @param {string} [filename] Filename key for the report object.
 * @returns {string[]} Empty array when the stylesheet is valid.
 */
function checkSource(source, filename = 'sheet.css') {
  let errors;
  try {
    const report = validateString(source, filename);
    errors = (report && report[filename]) || [];
  } catch (error) {
    return [`validator crashed: ${error.message}`];
  }
  return errors.map(error => {
    const line = error.line ?? error.loc?.line ?? '?';
    const column = error.column ?? error.loc?.column ?? '?';
    return `L${line}:${column} ${error.message}`;
  });
}

/**
 * Syntax-check a single CSS file.
 *
 * @param {string} file Absolute path.
 * @returns {string[]} Empty array when the file is valid.
 */
function checkFile(file) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return [`unreadable: ${error.message}`];
  }
  return checkSource(source, file);
}

/**
 * Check every target file in the repository.
 *
 * @returns {{total:number, failed:number, passed:number,
 *   failures: Array<{file:string, errors:string[]}>}}
 */
function run() {
  const files = collectTargetFiles(EXTENSIONS);
  const failures = [];
  for (const file of files) {
    const errors = checkFile(file);
    if (errors.length > 0) failures.push({ file, errors });
  }
  return {
    total: files.length,
    failed: failures.length,
    passed: files.length - failures.length,
    failures,
  };
}

if (require.main === module) {
  process.exit(reportAndExit('css-syntax', run()));
}

module.exports = { run, checkFile, checkSource, EXTENSIONS };
