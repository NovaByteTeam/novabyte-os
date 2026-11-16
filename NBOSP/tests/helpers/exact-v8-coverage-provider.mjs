// Exact-counts V8 coverage provider.
//
// Why this exists — two defects in the stock @vitest/coverage-v8 pipeline
// corrupt counts for files that are executed more than once:
//
//  1. Same-URL ScriptCoverage entries are raw-merged (@bcoe/v8-coverage
//     mergeScriptCovs) BEFORE conversion. The merged range tree reports
//     zero or negative counts for else-arcs that demonstrably executed.
//  2. Entries for raw require()d files (the cover-loader / requireFresh
//     harness) go through the Vite SSR transform path: their v8 offsets are
//     coordinates in the ORIGINAL file, but the converter treats them as
//     coordinates in the Vite-transformed code and remaps them through the
//     transform source map — landing branch arcs on the wrong code.
//
// This provider converts every ScriptCoverage entry SEPARATELY (no raw
// merge) and lets istanbul-lib-coverage merge() SUM the per-entry counts.
// Entries with startOffset 0 (raw require: the executing script IS the
// original file) are converted directly against the file's own source.
// Entries with startOffset > 0 (executed through Vite's SSR transform) keep
// the stock transform + source-map path.
//
// Verified against raw Profiler.takePreciseCoverage dumps: per-entry
// conversion of the raw file reproduces the true hit counts exactly.
import { promises } from 'node:fs';
import { fileURLToPath } from 'node:url';
import stock from '@vitest/coverage-v8';

const noopDebug = () => {};
noopDebug.enabled = false;

let exactClassPromise = null;

export default {
  getProvider() {
    exactClassPromise ??= (async () => {
      const stockInstance = await stock.getProvider();
      const StockClass = Object.getPrototypeOf(stockInstance).constructor;
      return class ExactCountsV8Provider extends StockClass {
        async generateCoverage({ allTestsRun } = {}) {
          const coverageMap = this.createCoverageMap();
          const scripts = [];
          await this.readCoverageFiles({
            onFileRead: (coverage) => { scripts.push(...coverage.result); },
            onFinished: async (project, environment) => {
              for (const script of scripts) {
                let converted = null;
                if ((script.startOffset || 0) === 0 && script.url && script.url.startsWith('file://')) {
                  // Raw require()d file: the executing script is the original
                  // file itself — convert straight against the file source,
                  // no transform, no source map.
                  let filePath = null;
                  try { filePath = fileURLToPath(script.url); } catch { filePath = null; }
                  if (filePath && this.isIncluded(filePath)) {
                    let raw = null;
                    try { raw = await promises.readFile(filePath, 'utf8'); } catch { raw = null; }
                    if (raw != null) {
                      converted = await this.remapCoverage(script.url, 0, { code: raw }, script.functions);
                    }
                  }
                }
                if (converted == null) {
                  // Vite-transformed execution (ESM imports of source files):
                  // keep the stock transform + source-map remap, per entry.
                  try {
                    converted = await this.convertCoverage({ result: [script] }, project, environment);
                  } catch { converted = null; }
                }
                if (converted != null) coverageMap.merge(converted);
              }
              scripts.length = 0;
            },
            onDebug: noopDebug,
          });
          // Untested-file placeholders: identical to the stock provider.
          if (this.options.include != null && (allTestsRun || !this.options.cleanOnRerun)) {
            const coveredFiles = coverageMap.files();
            const untestedCoverage = await this.getCoverageMapForUncoveredFiles(coveredFiles);
            coverageMap.merge(untestedCoverage);
          }
          return coverageMap;
        }
      };
    })();
    return exactClassPromise.then((ExactClass) => new ExactClass());
  },
};
