// syntax.test.js — vitest entry point for the tests/syntax suite.
//
// This file is what makes the four syntax checkers part of `npm test`:
// vitest only picks up tests/**/*.test.js, so the checkers themselves
// (js-syntax.js, json-syntax.js, css-syntax.js, html-syntax.js) export
// their run()/checkFile() APIs and are driven from here.
//
// Coverage is end-to-end at two levels:
//
//   1. Checker self-tests — every checker is aimed at the deliberately
//      broken and deliberately valid fixtures in tests/syntax/fixtures/
//      (excluded from the real scan). A checker must reject every broken
//      fixture AND accept every valid one, otherwise the suite itself is
//      broken and its green runs mean nothing.
//
//   2. Full repository scans — each checker scans every target file of
//      its kind under NBOSP/ (os/, node_modules and generated output
//      excluded) and must report zero failures.
//
// Scope tests pin the scanning rules themselves: os/ and node_modules are
// never returned, and the known project files of every kind are present,
// so a scanner that silently stopped finding files fails loudly.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const jsSyntax = require('./js-syntax.js');
const jsonSyntax = require('./json-syntax.js');
const cssSyntax = require('./css-syntax.js');
const htmlSyntax = require('./html-syntax.js');
const scanCommon = require('./scan-common.js');

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name) => path.join(FIXTURES, name);

// Full scans spawn child processes (js) or parse hundreds of files — give
// them generous timeouts so slow CI machines don't flake.
const SCAN_TIMEOUT = 180_000;

// ---------------------------------------------------------------------------
// 1. js-syntax.js — Node's built-in syntax checker for every .js file
// ---------------------------------------------------------------------------
describe('js-syntax.js (node --check for every JavaScript file)', () => {
  it('rejects a deliberately broken fixture', async () => {
    const errors = await jsSyntax.checkFile(fixture('broken.js'));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toMatch(/SyntaxError|Unexpected/i);
  }, 60_000);

  it('accepts a valid CommonJS fixture on the first parse', async () => {
    expect(await jsSyntax.checkFile(fixture('valid-cjs.js'))).toEqual([]);
  }, 60_000);

  it('accepts an ESM-only .js fixture through the .mjs fallback', async () => {
    // NBOSP is a CJS package, so a bare --check of ESM syntax fails; the
    // checker must recover through its documented ESM re-parse.
    expect(await jsSyntax.checkFile(fixture('esm-only.js'))).toEqual([]);
  }, 60_000);

  it('scans every JavaScript file in the repository and they all parse', async () => {
    const result = await jsSyntax.run();
    expect(result.failed).toBe(0);
    expect(result.total).toBeGreaterThan(200); // the repo ships 300+ scripts
    expect(result.passed).toBe(result.total);
  }, SCAN_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 2. json-syntax.js — JSON.parse for every .json file
// ---------------------------------------------------------------------------
describe('json-syntax.js (strict JSON validation of every JSON file)', () => {
  it('rejects a deliberately broken fixture with a position', () => {
    const errors = jsonSyntax.checkFile(fixture('broken.json'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/position|JSON/i);
  });

  it('reports a line/column location for the parse error', () => {
    const errors = jsonSyntax.checkFile(fixture('broken.json'));
    expect(errors[0]).toMatch(/line \d+, column \d+/);
  });

  it('recovers the position from token-context messages (new V8 format)', () => {
    // Node 24 reports token errors as: Unexpected token '}', "…" is not
    // valid JSON — no explicit position. The checker must still locate it:
    // the fixture's stray } sits on line 4, column 1.
    const errors = jsonSyntax.checkFile(fixture('broken.json'));
    expect(errors[0]).toMatch(/Unexpected token '}'/);
    expect(errors[0]).toMatch(/\(line 4, column 1\)/);
  });

  it('uses the engine-provided position when present', () => {
    // {"a": 1,} → "Expected double-quoted property name … at position 8
    // (line 1 column 9)" — position comes straight from the message.
    const errors = jsonSyntax.checkFile(fixture('trailing-comma.json'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/position 8 \(line 1 column 9\)/);
  });

  it('degrades gracefully when no position is derivable', () => {
    // Empty/truncated input yields "Unexpected end of JSON input" with no
    // position — the message must still surface, without a fake location.
    const errors = jsonSyntax.checkFile(fixture('empty.json'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Unexpected end of JSON input/);
    expect(errors[0]).not.toMatch(/line \d+/);
  });

  it('accepts a valid fixture', () => {
    expect(jsonSyntax.checkFile(fixture('valid.json'))).toEqual([]);
  });

  it('reports unreadable files instead of crashing', () => {
    const errors = jsonSyntax.checkFile(path.join(FIXTURES, 'does-not-exist.json'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/unreadable/i);
  });

  it('scans every JSON file in the repository and they all parse', () => {
    const result = jsonSyntax.run();
    expect(result.failed).toBe(0);
    expect(result.total).toBeGreaterThan(50); // manifests + locales + configs
    expect(result.passed).toBe(result.total);
  }, SCAN_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 3. css-syntax.js — csstree-validator for every .css file
// ---------------------------------------------------------------------------
describe('css-syntax.js (csstree-validator for every stylesheet)', () => {
  it('rejects a broken stylesheet with a line:column position', () => {
    const errors = cssSyntax.checkSource('.broken { color: ; }', 'broken.css');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/^L\d+:\d+/);
  });

  it('flags unknown properties as value-level errors', () => {
    const errors = cssSyntax.checkSource('.x { nosuchproperty: 1px; }', 'unknown.css');
    expect(errors.join('\n')).toMatch(/nosuchproperty/i);
  });

  it('accepts a valid stylesheet', () => {
    expect(cssSyntax.checkSource('body { color: red; margin: 0 auto; }', 'valid.css')).toEqual([]);
  });

  it('accepts the valid fixture file end-to-end', () => {
    expect(cssSyntax.checkFile(fixture('valid.css'))).toEqual([]);
  });

  it('rejects the broken fixture file end-to-end', () => {
    const errors = cssSyntax.checkFile(fixture('broken.css'));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('scans every stylesheet in the repository and they all validate', () => {
    const result = cssSyntax.run();
    expect(result.failed).toBe(0);
    expect(result.total).toBeGreaterThan(20);
    expect(result.passed).toBe(result.total);
  }, SCAN_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 4. html-syntax.js — html-validate for every .html file
// ---------------------------------------------------------------------------
describe('html-syntax.js (html-validate for every markup file)', () => {
  it('rejects duplicate ids (no-dup-id rule is active)', async () => {
    const errors = await htmlSyntax.checkSource(
      '<!doctype html><html><head><title>t</title></head><body><p id="a"></p><p id="a"></p></body></html>',
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toMatch(/no-dup-id|duplicate/i);
  });

  it('accepts a well-formed document', async () => {
    const errors = await htmlSyntax.checkSource(
      '<!doctype html><html><head><title>ok</title></head><body><p id="one">x</p></body></html>',
    );
    expect(errors).toEqual([]);
  });

  it('accepts the valid fixture file end-to-end', async () => {
    expect(await htmlSyntax.checkFile(fixture('valid.html'))).toEqual([]);
  });

  it('rejects the broken fixture file end-to-end', async () => {
    const errors = await htmlSyntax.checkFile(fixture('broken.html'));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('scans every HTML file in the repository and they all validate', async () => {
    const result = await htmlSyntax.run();
    expect(result.failed).toBe(0);
    // Baseline: the shell index.html plus one per window app (~30 tracked
    // markup files). Deliberately a floor, not an exact count.
    expect(result.total).toBeGreaterThan(25);
    expect(result.passed).toBe(result.total);
  }, SCAN_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 5. scan-common.js — the shared scanning rules
// ---------------------------------------------------------------------------
describe('scan-common.js (shared scan scope)', () => {
  it('never returns files from os/, node_modules or excluded dirs', () => {
    const all = [
      ...scanCommon.collectTargetFiles(jsSyntax.EXTENSIONS),
      ...scanCommon.collectTargetFiles(jsonSyntax.EXTENSIONS),
      ...scanCommon.collectTargetFiles(cssSyntax.EXTENSIONS),
      ...scanCommon.collectTargetFiles(htmlSyntax.EXTENSIONS),
    ];
    for (const file of all) {
      const rel = path.relative(scanCommon.NBOSP_ROOT, file);
      expect(rel.split(path.sep)[0]).not.toBe('os');
      expect(rel).not.toContain(`node_modules${path.sep}`);
      expect(rel).not.toContain(`fixtures${path.sep}`);
    }
  });

  it('finds the known root-level files of every kind', () => {
    const jsFiles = scanCommon.collectTargetFiles(jsSyntax.EXTENSIONS).map(f => path.relative(scanCommon.NBOSP_ROOT, f));
    const jsonFiles = scanCommon.collectTargetFiles(jsonSyntax.EXTENSIONS).map(f => path.relative(scanCommon.NBOSP_ROOT, f));
    const cssFiles = scanCommon.collectTargetFiles(cssSyntax.EXTENSIONS).map(f => path.relative(scanCommon.NBOSP_ROOT, f));
    const htmlFiles = scanCommon.collectTargetFiles(htmlSyntax.EXTENSIONS).map(f => path.relative(scanCommon.NBOSP_ROOT, f));
    expect(jsFiles).toContain('client.js');
    expect(jsFiles).toContain('tests/syntax/js-syntax.js');
    expect(jsonFiles).toContain('package.json');
    expect(cssFiles).toContain('style.css');
    expect(htmlFiles).toContain('index.html');
  });

  it('classifies excluded directories and prefixes correctly', () => {
    expect(scanCommon.isExcludedDir('os')).toBe(false); // dir NAME "os" is fine
    expect(scanCommon.isExcludedDir('node_modules')).toBe(true);
    expect(scanCommon.isExcludedDir('fixtures')).toBe(true);
    expect(scanCommon.isExcludedRelative(`os${path.sep}installer`)).toBe(true);
    expect(scanCommon.isExcludedRelative('js')).toBe(false);
  });

  it('formats failure records for humans', () => {
    const text = scanCommon.formatFailure({
      file: path.join(scanCommon.NBOSP_ROOT, 'style.css'),
      errors: ['L1:1 boom'],
    });
    expect(text).toContain('style.css');
    expect(text).toContain('L1:1 boom');
  });
});
