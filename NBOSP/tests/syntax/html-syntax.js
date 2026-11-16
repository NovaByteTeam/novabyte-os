'use strict';

/**
 * html-syntax.js — HTML syntax checker for every .html file in the
 * repository (excluding the os/ section, node_modules and generated output
 * directories).
 *
 * Uses the html-validate package (https://www.npmjs.com/package/html-validate).
 * The rule set is deliberately scoped to SYNTAX and document-structure
 * defects rather than stylistic or accessibility opinions, so a pass means
 * "this markup is machine-parseable and structurally sound":
 *
 *   - parser-error (always on) — tokenizer failures such as malformed
 *     attributes or broken tag syntax;
 *   - no-dup-attr / no-dup-id — duplicate attributes and duplicate id
 *     attributes, both real markup defects;
 *   - element-permitted-parent — an element nested where the HTML content
 *     model forbids it;
 *   - element-required-content — required content missing (e.g. <head>
 *     without <title>).
 *
 * Usage:
 *   node tests/syntax/html-syntax.js     (standalone — exit code 1 on failure)
 *   run() / checkSource()                (imported by tests/syntax/syntax.test.js)
 */

const fs = require('node:fs');
const path = require('node:path');

const { HtmlValidate } = require('html-validate');
const { collectTargetFiles, reportAndExit } = require('./scan-common.js');

const EXTENSIONS = ['.html'];

// Structure/syntax rules only — validated against every HTML file in the
// repository. Style rules (attr-quotes, doctype-style, no-inline-style, …)
// are intentionally left off: this is a syntax checker, not a linter.
const SYNTAX_RULES = {
  'no-dup-attr': 'error',
  'no-dup-id': 'error',
  'element-permitted-parent': 'error',
  'element-required-content': 'error',
};

const validator = new HtmlValidate({ rules: { ...SYNTAX_RULES } });

/**
 * Validate an HTML source string and return positioned error descriptions.
 *
 * @param {string} source HTML source text.
 * @returns {Promise<string[]>} Empty array when the markup is valid.
 */
async function checkSource(source) {
  let report;
  try {
    report = await validator.validateString(source);
  } catch (error) {
    return [`validator crashed: ${error.message}`];
  }
  const messages = report.results.flatMap(result => result.messages);
  return messages
    .filter(message => message.severity === 2)
    .map(message => `L${message.line}:${message.column} [${message.ruleId}] ${message.message}`);
}

/**
 * Syntax-check a single HTML file.
 *
 * @param {string} file Absolute path.
 * @returns {Promise<string[]>} Empty array when the file is valid.
 */
async function checkFile(file) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return [`unreadable: ${error.message}`];
  }
  return checkSource(source);
}

/**
 * Check every target file in the repository (bounded concurrency).
 *
 * @returns {Promise<{total:number, failed:number, passed:number,
 *   failures: Array<{file:string, errors:string[]}>}>}
 */
async function run() {
  const files = collectTargetFiles(EXTENSIONS);
  const CONCURRENCY = 8;
  const results = new Array(files.length);
  let cursor = 0;

  async function lane() {
    while (cursor < files.length) {
      const index = cursor++;
      results[index] = await checkFile(files[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, lane));

  const failures = files
    .map((file, index) => ({ file, errors: results[index] }))
    .filter(entry => entry.errors.length > 0);

  return {
    total: files.length,
    failed: failures.length,
    passed: files.length - failures.length,
    failures,
  };
}

if (require.main === module) {
  run()
    .then(result => process.exit(reportAndExit('html-syntax', result)))
    .catch(error => {
      console.error('[fail] html-syntax: checker crashed:', error);
      process.exit(1);
    });
}

module.exports = { run, checkFile, checkSource, SYNTAX_RULES, EXTENSIONS };
