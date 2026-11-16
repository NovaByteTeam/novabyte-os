'use strict';

/**
 * json-syntax.js — JSON syntax checker for every .json file in the
 * repository (excluding the os/ section, node_modules and generated output
 * directories).
 *
 * Every file is parsed with JSON.parse — the canonical strict JSON grammar
 * check. Files that fail are reported with the parser's own position
 * information (message, line and column are derived from the byte offset
 * the engine reports).
 *
 * Usage:
 *   node tests/syntax/json-syntax.js     (standalone — exit code 1 on failure)
 *   run() / checkFile()                  (imported by tests/syntax/syntax.test.js)
 */

const fs = require('node:fs');
const path = require('node:path');

const { collectTargetFiles, reportAndExit } = require('./scan-common.js');

const EXTENSIONS = ['.json'];

/** Compute 1-based line/column for a byte offset inside a text buffer. */
function lineColumnAt(text, offset) {
  if (!Number.isFinite(offset) || offset < 0 || offset >= text.length) return null;
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: offset - lastNewline };
}

/** Extract the "position N" offset from a JSON.parse SyntaxError message. */
function offsetFromMessage(message) {
  const match = /position (\d+)/i.exec(String(message));
  return match ? Number(match[1]) : null;
}

/**
 * Recover the error offset from Node's newer "Unexpected token 'X',
 * "context" is not valid JSON" message format (no explicit position).
 *
 * The double-quoted context in the message is a JSON-escaped window of the
 * source text around the offending token. Unescape it, find the window in
 * the real source, then locate the token inside it (choosing the occurrence
 * closest to the middle of the window — that is where V8 centers it).
 *
 * @param {string} message The raw SyntaxError message.
 * @param {string} source The full JSON source text.
 * @returns {number|null} Best-effort byte offset of the error, or null.
 */
function offsetFromTokenContext(message, source) {
  const messageText = String(message);
  // V8 formats this message as:
  //   Unexpected token 'X', "...context..." is not valid JSON
  // where the context window is wrapped in display quotes, may be elided
  // with a literal "..." head and/or tail, and can contain raw newlines
  // and quote characters of its own. Parse with prefix/suffix string
  // operations — a regex cannot express "the last quote before the
  // suffix" when the context itself contains quotes.
  const PREFIX = "Unexpected token '";
  const SUFFIX = '" is not valid JSON';
  if (!messageText.startsWith(PREFIX) || !messageText.endsWith(SUFFIX)) return null;
  const tokenEnd = messageText.indexOf("'", PREFIX.length);
  if (tokenEnd <= PREFIX.length) return null;
  const token = messageText.slice(PREFIX.length, tokenEnd);
  const afterToken = messageText.slice(tokenEnd + 1);
  if (!afterToken.startsWith(", ")) return null;
  let context = afterToken.slice(2, afterToken.length - SUFFIX.length);
  // Unwrap in a fixed order: elision markers first, then the display
  // quotes — an elided window looks like ..."real context"... so the
  // opening display quote sits AFTER the dots.
  context = context.replace(/^\.\.\./, '').replace(/\.\.\.$/, '');
  context = context.replace(/^"/, '').replace(/"$/, '');
  if (!context || !context.includes(token)) return null;
  const contextAt = source.indexOf(context);
  if (contextAt === -1) return null;
  // The offending token sits at the center of the window; when it occurs
  // several times inside the window, pick the occurrence closest to the
  // middle.
  let best = -1;
  let bestDistance = Infinity;
  const middle = (context.length - 1) / 2;
  let at = context.indexOf(token);
  while (at !== -1) {
    const distance = Math.abs(at - middle);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = at;
    }
    at = context.indexOf(token, at + 1);
  }
  return best === -1 ? null : contextAt + best;
}

/**
 * Syntax-check a single JSON file.
 *
 * @param {string} file Absolute path.
 * @returns {string[]} Empty array when the file parses; otherwise a
 *   one-element array with the positioned error description.
 */
function checkFile(file) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return [`unreadable: ${error.message}`];
  }

  try {
    JSON.parse(source);
    return [];
  } catch (error) {
    const message = String(error.message);
    // Node's error formats, newest first:
    //   "… in JSON at position 15 (line 1 column 16)"  — explicit position
    //   "Unexpected token '}', "{a:}" is not valid JSON" — context window
    //   "Unexpected end of JSON input"                  — no position at all
    const position = offsetFromMessage(message) ?? offsetFromTokenContext(message, source);
    // Some engine messages already carry "(line L column C)"; only append
    // a derived location when the message itself has none, so positions
    // are never printed twice.
    const hasEngineLocation = /line \d+ column \d+/.test(message);
    const where = position === null || hasEngineLocation ? null : lineColumnAt(source, position);
    const location = where ? ` (line ${where.line}, column ${where.column})` : '';
    return [`${message}${location}`];
  }
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
  process.exit(reportAndExit('json-syntax', run()));
}

module.exports = { run, checkFile, EXTENSIONS };
