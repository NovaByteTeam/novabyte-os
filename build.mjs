// Static-site optimiser for a single-file index.html — no framework, just the
// four things that actually apply here: CSS purge, CSS minify, JS minify, HTML minify.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { transform as esbuildTransform } from 'esbuild';
import { minify as minifyHtml } from 'html-minifier-terser';
import { PurgeCSS } from 'purgecss';

const SRC = './index.html';
const OUT_DIR = './dist';
const OUT_FILE = `${OUT_DIR}/index.html`;

const html = readFileSync(SRC, 'utf8');

// --- 1. Pull out the single <style> block and each inline <script type="module"> block ---
// (external scripts like the Lenis CDN tag are left completely alone)
const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
const css = styleMatch[1];

const scriptRe = /<script type="module">([\s\S]*?)<\/script>/g;
const scripts = [...html.matchAll(scriptRe)].map(m => m[1]);

// PurgeCSS's own CSS parser doesn't reliably handle native nesting (`&.is-revealed { ... }`
// inside a parent rule) — it was silently dropping the whole nested block, which killed
// the .is-revealed rule that un-hides scroll-triggered elements. Flatten nesting with
// esbuild first (which DOES understand it) so PurgeCSS only ever sees plain flat selectors.
const { code: flattenedCss } = await esbuildTransform(css, { loader: 'css', minify: false });

// --- 2. Purge unused CSS rules (checks against tags/classes/ids actually used in the HTML + JS) ---
const purgeResult = await new PurgeCSS().purge({
  content: [{ raw: html, extension: 'html' }, ...scripts.map(s => ({ raw: s, extension: 'js' }))],
  css: [{ raw: flattenedCss }],
  safelist: {
    // keep anything toggled purely via JS, plus scroll-triggered/state classes
    standard: [/^is-/, /^has-/, /^active$/, /^open$/, /^visible$/, /^lenis/],
  },
});
const purgedCss = purgeResult[0].css;

// --- 3. Minify the purged CSS and each JS module block via esbuild ---
const { code: minifiedCss } = await esbuildTransform(purgedCss, { loader: 'css', minify: true });

const minifiedScripts = [];
for (const s of scripts) {
  const { code } = await esbuildTransform(s, { loader: 'js', minify: true, target: 'es2019' });
  minifiedScripts.push(code.trim());
}

// --- 4. Splice minified CSS/JS back into the HTML ---
let outHtml = html.replace(/<style>[\s\S]*?<\/style>/, `<style>${minifiedCss}</style>`);
let i = 0;
outHtml = outHtml.replace(scriptRe, () => `<script type="module">${minifiedScripts[i++]}</script>`);

// --- 5. Minify the HTML shell itself ---
const finalHtml = await minifyHtml(outHtml, {
  collapseWhitespace: true,
  removeComments: true,
  removeRedundantAttributes: true,
  removeScriptTypeAttributes: false, // keep type="module", it's not redundant
  useShortDoctype: true,
  // minifyCSS/minifyJS OFF: html-minifier-terser's internal CSS minifier (clean-css)
  // doesn't understand native `&` nesting inside @supports blocks and silently drops
  // those rules (this killed .is-revealed, the fallback path for browsers without
  // scroll-driven animations). We already minify CSS/JS ourselves with esbuild above,
  // so this would just be a second, worse pass anyway -- leave those blocks alone.
  minifyCSS: false,
  minifyJS: false,
});

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, finalHtml);

const before = Buffer.byteLength(html, 'utf8');
const after = Buffer.byteLength(finalHtml, 'utf8');
console.log(`Before: ${(before / 1024).toFixed(1)} KB`);
console.log(`After:  ${(after / 1024).toFixed(1)} KB`);
console.log(`Saved:  ${(((before - after) / before) * 100).toFixed(1)}%`);
