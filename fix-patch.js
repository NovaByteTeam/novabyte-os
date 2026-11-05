#!/usr/bin/env node
// fix-patch.js - Advanced Interactive Patch JSON Fixer
// Usage: node fix-patch.js [patch-file]
// Dependencies: npm install inquirer@8 chalk@4 ora@5

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Lazy-load deps with friendly errors ──────────────────────────────────────
function requireDep(name) {
  try { return require(name); }
  catch {
    console.error(`\n  Missing dependency: ${name}`);
    console.error(`  Run:  npm install inquirer@8 chalk@4 ora@5\n`);
    process.exit(1);
  }
}
const inquirer = requireDep('inquirer');
const chalk    = requireDep('chalk');
const ora      = requireDep('ora');

// ─── Constants ────────────────────────────────────────────────────────────────
const BACKUP_SUFFIX = '.bak';
const CONFIDENCE = { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW', NONE: 'NONE' };

// ─── Utilities ────────────────────────────────────────────────────────────────
const fmt = {
  ok:      s => chalk.green(`  ✓ ${s}`),
  fixed:   s => chalk.yellow(`  ✎ ${s}`),
  fail:    s => chalk.red(`  ✗ ${s}`),
  warn:    s => chalk.magenta(`  ⚠ ${s}`),
  info:    s => chalk.cyan(`  ℹ ${s}`),
  header:  s => chalk.bold.white(`\n${'─'.repeat(60)}\n  ${s}\n${'─'.repeat(60)}`),
  dim:     s => chalk.dim(s),
  bold:    s => chalk.bold(s),
};

function normalize(str) {
  // Normalize line endings and trailing whitespace per line
  return str.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
            .split('\n').map(l => l.trimEnd()).join('\n');
}

function similarity(a, b) {
  // Levenshtein-based similarity ratio (0–1) between two strings
  const la = a.length, lb = b.length;
  if (la === 0 && lb === 0) return 1;
  if (la === 0 || lb === 0) return 0;
  // Cap at 4 000 chars for performance
  const sa = a.slice(0, 4000), sb = b.slice(0, 4000);
  const m = sa.length, n = sb.length;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = i;
    for (let j = 1; j <= n; j++) {
      const val = sa[i - 1] === sb[j - 1] ? row[j - 1] : 1 + Math.min(prev, row[j], row[j - 1]);
      row[j - 1] = prev;
      prev = val;
    }
    row[n] = prev;
  }
  const dist = row[n];
  return 1 - dist / Math.max(m, n);
}

function confidenceLabel(score) {
  if (score >= 0.92) return CONFIDENCE.HIGH;
  if (score >= 0.75) return CONFIDENCE.MEDIUM;
  if (score >= 0.50) return CONFIDENCE.LOW;
  return CONFIDENCE.NONE;
}

function confidenceColor(level) {
  return { HIGH: chalk.green, MEDIUM: chalk.yellow, LOW: chalk.red, NONE: chalk.red }[level];
}

// ─── Core matching logic ──────────────────────────────────────────────────────
/**
 * Attempt to locate `search` in `content`.
 * Returns { found, exact, index, endIndex, actual, confidence, score, ambiguous }
 */
function locateSearch(content, search) {
  const normContent = normalize(content);
  const normSearch  = normalize(search);

  // 1. Exact match (after normalization)
  const exactIdx = normContent.indexOf(normSearch);
  if (exactIdx !== -1) {
    return {
      found: true, exact: true,
      index: exactIdx, endIndex: exactIdx + normSearch.length,
      actual: normSearch, confidence: CONFIDENCE.HIGH, score: 1,
      ambiguous: normContent.indexOf(normSearch, exactIdx + 1) !== -1,
    };
  }

  // 2. Line-anchor fuzzy: find first line, find last line, grab between them
  const searchLines  = normSearch.split('\n');
  const firstLine    = searchLines[0].trim();
  const lastLine     = searchLines[searchLines.length - 1].trim();
  const contentLines = normContent.split('\n');

  // Find ALL occurrences of firstLine to detect ambiguity
  const firstLineMatches = [];
  contentLines.forEach((cl, i) => { if (cl.trim() === firstLine) firstLineMatches.push(i); });

  if (firstLineMatches.length === 0) {
    return { found: false, reason: 'First line not found in file' };
  }

  const candidates = [];

  for (const startLineIdx of firstLineMatches) {
    // Find the last line at or after startLineIdx
    for (let endLineIdx = startLineIdx; endLineIdx < contentLines.length; endLineIdx++) {
      if (contentLines[endLineIdx].trim() === lastLine) {
        const actualLines = contentLines.slice(startLineIdx, endLineIdx + 1);
        const actual      = actualLines.join('\n');
        const score       = similarity(normSearch, actual);
        candidates.push({ startLineIdx, endLineIdx, actual, score });
        break; // only take the first lastLine match per startLine
      }
    }
  }

  if (candidates.length === 0) {
    return { found: false, reason: 'Last line not found after first line' };
  }

  // Pick highest-scoring candidate
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const confidence = confidenceLabel(best.score);

  if (confidence === CONFIDENCE.NONE) {
    return { found: false, reason: `Best match score too low (${(best.score * 100).toFixed(1)}%)` };
  }

  // Compute character indices in normContent
  const linesBefore = contentLines.slice(0, best.startLineIdx);
  const charIndex   = linesBefore.join('\n').length + (linesBefore.length > 0 ? 1 : 0);
  const charEnd     = charIndex + best.actual.length;

  return {
    found: true, exact: false,
    index: charIndex, endIndex: charEnd,
    actual: best.actual,
    confidence, score: best.score,
    ambiguous: candidates.length > 1 || firstLineMatches.length > 1,
  };
}

// ─── Load & validate patch file ───────────────────────────────────────────────
function loadPatch(filePath) {
  if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (e) { return { error: `Cannot read file: ${e.message}` }; }
  let patch;
  try { patch = JSON.parse(raw); }
  catch (e) { return { error: `Invalid JSON: ${e.message}` }; }
  if (!Array.isArray(patch.files)) return { error: '`files` array missing or not an array' };
  return { patch, raw };
}

// ─── Scan all entries ─────────────────────────────────────────────────────────
function scanPatch(patch) {
  return patch.files.map((f, i) => {
    const base = { index: i, path: f.path, entry: f };

    if (!f.path || !f.search) {
      return { ...base, status: 'invalid', reason: 'Missing path or search field' };
    }
    if (!fs.existsSync(f.path)) {
      return { ...base, status: 'missing', reason: 'Target file not found' };
    }

    const content = fs.readFileSync(f.path, 'utf8');
    const result  = locateSearch(content, f.search);

    if (!result.found) {
      return { ...base, status: 'failed', reason: result.reason, content };
    }
    if (result.exact) {
      return { ...base, status: 'ok', confidence: CONFIDENCE.HIGH, score: 1, content };
    }
    return {
      ...base, status: 'fixable',
      confidence: result.confidence, score: result.score,
      ambiguous: result.ambiguous,
      fixedSearch: result.actual,
      content,
    };
  });
}

// ─── Backup ───────────────────────────────────────────────────────────────────
function backupPatch(filePath) {
  const dest = filePath + BACKUP_SUFFIX;
  fs.copyFileSync(filePath, dest);
  return dest;
}

function restoreBackup(filePath) {
  const src = filePath + BACKUP_SUFFIX;
  if (!fs.existsSync(src)) return false;
  fs.copyFileSync(src, filePath);
  return true;
}

// ─── Apply fixes ──────────────────────────────────────────────────────────────
function applyFixes(patch, results, dryRun) {
  let fixCount = 0;
  for (const r of results) {
    if (r.status !== 'fixable') continue;
    if (!dryRun) {
      r.entry.search = r.fixedSearch;
      fixCount++;
    } else {
      fixCount++;
    }
  }
  return fixCount;
}

// ─── Print scan summary ───────────────────────────────────────────────────────
function printScanResults(results) {
  console.log(fmt.header('SCAN RESULTS'));
  for (const r of results) {
    const label = `#${r.index + 1} ${r.path || '(no path)'}`;
    if (r.status === 'ok') {
      console.log(fmt.ok(`${label}`));
    } else if (r.status === 'fixable') {
      const pct   = `${(r.score * 100).toFixed(1)}%`;
      const conf  = confidenceColor(r.confidence)(`[${r.confidence} ${pct}]`);
      const amb   = r.ambiguous ? chalk.magenta(' ⚠ AMBIGUOUS') : '';
      console.log(fmt.fixed(`${label}  ${conf}${amb}`));
    } else if (r.status === 'failed') {
      console.log(fmt.fail(`${label}  — ${r.reason}`));
    } else if (r.status === 'missing') {
      console.log(fmt.fail(`${label}  — ${r.reason}`));
    } else {
      console.log(fmt.fail(`${label}  — ${r.reason}`));
    }
  }

  const ok      = results.filter(r => r.status === 'ok').length;
  const fixable = results.filter(r => r.status === 'fixable').length;
  const failed  = results.filter(r => ['failed','missing','invalid'].includes(r.status)).length;

  console.log('');
  console.log(fmt.bold('  Summary:'));
  console.log(fmt.ok(`OK: ${ok}`));
  if (fixable) console.log(fmt.fixed(`Fixable: ${fixable}`));
  if (failed)  console.log(fmt.fail(`Failed: ${failed}`));
  console.log('');
}

// ─── Show ambiguity detail ────────────────────────────────────────────────────
function printFixableDetail(results) {
  const fixable = results.filter(r => r.status === 'fixable');
  if (!fixable.length) { console.log(fmt.info('Nothing to fix.')); return; }

  console.log(fmt.header('FIXABLE ENTRIES — DETAIL'));
  for (const r of fixable) {
    const pct  = `${(r.score * 100).toFixed(1)}%`;
    const conf = confidenceColor(r.confidence)(`[${r.confidence} ${pct}]`);
    console.log(chalk.bold(`\n  #${r.index + 1} ${r.path}  ${conf}`));
    if (r.ambiguous) console.log(fmt.warn('Multiple anchor matches found — review carefully!'));
    console.log(fmt.dim('  Original search (first 120 chars):'));
    console.log(fmt.dim('  ' + r.entry.search.slice(0, 120).replace(/\n/g, '↵')));
    console.log(fmt.dim('  Proposed fix (first 120 chars):'));
    console.log(fmt.dim('  ' + r.fixedSearch.slice(0, 120).replace(/\n/g, '↵')));
  }
  console.log('');
}

// ─── Main interactive loop ────────────────────────────────────────────────────
async function main() {
  console.clear();
  console.log(chalk.bold.cyan('\n  ╔══════════════════════════════════╗'));
  console.log(chalk.bold.cyan('  ║    PATCH JSON FIXER  v2.0        ║'));
  console.log(chalk.bold.cyan('  ╚══════════════════════════════════╝\n'));

  // ── Select patch file ──────────────────────────────────────────────────────
  let patchFile = process.argv[2];

  if (!patchFile) {
    // Offer JSON files in cwd and common locations
    const cwd   = process.cwd();
    const dirs  = [cwd, path.join(cwd, 'updates')];
    const found = [];
    for (const d of dirs) {
      if (fs.existsSync(d)) {
        fs.readdirSync(d)
          .filter(f => f.endsWith('.json'))
          .forEach(f => found.push(path.join(d, f)));
      }
    }

    if (found.length) {
      const { chosen } = await inquirer.prompt([{
        type: 'list', name: 'chosen',
        message: 'Select a patch file:',
        choices: [...found.map(f => ({ name: path.relative(cwd, f), value: f })),
                  new inquirer.Separator(),
                  { name: '↩  Enter path manually', value: '__manual__' }],
      }]);
      patchFile = chosen;
    }

    if (!patchFile || patchFile === '__manual__') {
      const { manual } = await inquirer.prompt([{
        type: 'input', name: 'manual',
        message: 'Patch file path:',
        validate: v => v.trim() ? true : 'Please enter a path',
      }]);
      patchFile = manual.trim();
    }
  }

  // ── Load ───────────────────────────────────────────────────────────────────
  const spinner = ora('Loading patch file…').start();
  const loaded  = loadPatch(patchFile);
  if (loaded.error) {
    spinner.fail(chalk.red(loaded.error));
    process.exit(1);
  }
  spinner.succeed(`Loaded: ${chalk.bold(patchFile)}`);

  const { patch } = loaded;
  console.log(fmt.info(`Version: ${patch.package?.version ?? 'unknown'}  |  Entries: ${patch.files.length}`));

  let results = null;
  let dirty   = false; // tracks unsaved changes

  // ── Main menu ──────────────────────────────────────────────────────────────
  while (true) {
    const hasBackup = fs.existsSync(patchFile + BACKUP_SUFFIX);
    const choices = [
      { name: '🔍  Scan — check all entries', value: 'scan' },
      { name: '📋  View fixable entries (detail)', value: 'detail', disabled: !results },
      new inquirer.Separator(),
      { name: '✎   Fix all (with backup)', value: 'fix' },
      { name: '👁   Dry run — preview fixes only', value: 'dryrun' },
      new inquirer.Separator(),
      { name: hasBackup ? '♻️   Restore from backup' : '♻️   Restore from backup (none found)', value: 'restore', disabled: !hasBackup },
      { name: '📁  Change patch file', value: 'change' },
      new inquirer.Separator(),
      { name: dirty ? '💾  Save changes*' : '💾  Save (no pending changes)', value: 'save', disabled: !dirty },
      { name: '🚪  Exit', value: 'exit' },
    ];

    const { action } = await inquirer.prompt([{
      type: 'list', name: 'action',
      message: dirty ? chalk.yellow('Main Menu  [unsaved changes]') : 'Main Menu',
      choices,
      pageSize: 14,
    }]);

    // ── SCAN ────────────────────────────────────────────────────────────────
    if (action === 'scan') {
      const sp = ora('Scanning entries…').start();
      results = scanPatch(patch);
      sp.stop();
      printScanResults(results);

    // ── DETAIL ──────────────────────────────────────────────────────────────
    } else if (action === 'detail') {
      printFixableDetail(results);
      await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to continue…' }]);

    // ── DRY RUN ─────────────────────────────────────────────────────────────
    } else if (action === 'dryrun') {
      if (!results) results = scanPatch(patch);
      const fixable = results.filter(r => r.status === 'fixable');
      const failed  = results.filter(r => ['failed','missing','invalid'].includes(r.status));

      console.log(fmt.header('DRY RUN — NO FILES CHANGED'));
      console.log(fmt.info(`Would fix: ${fixable.length}  |  Cannot fix: ${failed.length}`));

      // Warn about low-confidence fixes
      const lowConf = fixable.filter(r => r.confidence !== CONFIDENCE.HIGH);
      if (lowConf.length) {
        console.log(fmt.warn(`${lowConf.length} entries have MEDIUM or LOW confidence — review before applying.`));
      }
      if (failed.length) {
        console.log(fmt.fail(`${failed.length} entries cannot be fixed automatically.`));
        for (const f of failed) console.log(fmt.fail(`  #${f.index + 1} ${f.path}: ${f.reason}`));
      }
      console.log('');
      await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to continue…' }]);

    // ── FIX ─────────────────────────────────────────────────────────────────
    } else if (action === 'fix') {
      if (!results) results = scanPatch(patch);

      const fixable  = results.filter(r => r.status === 'fixable');
      const lowConf  = fixable.filter(r => r.confidence !== CONFIDENCE.HIGH);
      const ambig    = fixable.filter(r => r.ambiguous);

      if (!fixable.length) {
        console.log(fmt.info('Nothing to fix.'));
        continue;
      }

      // Warn and confirm if risky entries exist
      if (lowConf.length || ambig.length) {
        console.log('');
        if (lowConf.length) console.log(fmt.warn(`${lowConf.length} low-confidence fixes detected.`));
        if (ambig.length)   console.log(fmt.warn(`${ambig.length} ambiguous matches detected.`));
        const { proceed } = await inquirer.prompt([{
          type: 'confirm', name: 'proceed',
          message: 'Review the detail view first. Proceed anyway?',
          default: false,
        }]);
        if (!proceed) continue;
      }

      // Backup
      const { doBackup } = await inquirer.prompt([{
        type: 'confirm', name: 'doBackup',
        message: `Create backup at ${path.basename(patchFile)}${BACKUP_SUFFIX}?`,
        default: true,
      }]);

      if (doBackup) {
        const dest = backupPatch(patchFile);
        console.log(fmt.ok(`Backup created: ${dest}`));
      }

      const count = applyFixes(patch, results, false);
      dirty = true;
      console.log(fmt.fixed(`Applied ${count} fix(es). Save to write to disk.`));

      // Re-scan so statuses update
      results = scanPatch(patch);

    // ── SAVE ────────────────────────────────────────────────────────────────
    } else if (action === 'save') {
      const { confirm } = await inquirer.prompt([{
        type: 'confirm', name: 'confirm',
        message: `Write changes to ${patchFile}?`,
        default: true,
      }]);
      if (confirm) {
        fs.writeFileSync(patchFile, JSON.stringify(patch, null, 2), 'utf8');
        dirty = false;
        console.log(fmt.ok('Saved successfully.'));

        // Exit code reflects final state
        const finalFailed = (results || []).filter(r =>
          ['failed','missing','invalid'].includes(r.status)).length;
        if (finalFailed > 0) {
          console.log(fmt.warn(`${finalFailed} entries could not be fixed — patch is incomplete.`));
        }
      }

    // ── RESTORE ─────────────────────────────────────────────────────────────
    } else if (action === 'restore') {
      const { confirm } = await inquirer.prompt([{
        type: 'confirm', name: 'confirm',
        message: `Restore ${patchFile} from backup? This will overwrite current file.`,
        default: false,
      }]);
      if (confirm) {
        const ok = restoreBackup(patchFile);
        if (ok) {
          const reloaded = loadPatch(patchFile);
          if (reloaded.error) { console.log(fmt.fail(`Restore failed: ${reloaded.error}`)); }
          else {
            Object.assign(patch, reloaded.patch);
            dirty   = false;
            results = null;
            console.log(fmt.ok('Restored from backup. Run Scan to refresh.'));
          }
        } else {
          console.log(fmt.fail('Backup file not found.'));
        }
      }

    // ── CHANGE FILE ─────────────────────────────────────────────────────────
    } else if (action === 'change') {
      if (dirty) {
        const { discard } = await inquirer.prompt([{
          type: 'confirm', name: 'discard',
          message: 'You have unsaved changes. Discard?',
          default: false,
        }]);
        if (!discard) continue;
      }
      process.argv[2] = undefined;
      return main(); // restart

    // ── EXIT ────────────────────────────────────────────────────────────────
    } else if (action === 'exit') {
      if (dirty) {
        const { save } = await inquirer.prompt([{
          type: 'confirm', name: 'save',
          message: 'You have unsaved changes. Save before exiting?',
          default: true,
        }]);
        if (save) {
          fs.writeFileSync(patchFile, JSON.stringify(patch, null, 2), 'utf8');
          console.log(fmt.ok('Saved.'));
        }
      }

      // Final exit code
      const finalFailed = (results || []).filter(r =>
        ['failed','missing','invalid'].includes(r.status)).length;
      console.log(chalk.dim('\n  Goodbye.\n'));
      process.exit(finalFailed > 0 ? 1 : 0);
    }
  }
}

main().catch(e => {
  console.error(chalk.red('\n  Unexpected error: ' + e.message));
  process.exit(2);
});