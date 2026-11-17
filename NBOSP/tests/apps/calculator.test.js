import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

const appUrl = new URL('../../js/apps/calculator/app.js', import.meta.url);
const manifestUrl = new URL('../../js/apps/calculator/manifest.json', import.meta.url);
const htmlUrl = new URL('../../js/apps/calculator/index.html', import.meta.url);

describe('Calculator app entry', () => {
  it('runs without host globals and handles calculations', async () => {
    const [source, html] = await Promise.all([
      readFile(appUrl, 'utf8'),
      readFile(htmlUrl, 'utf8'),
    ]);
    const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });

    try {
      expect(dom.window.OS).toBeUndefined();
      expect(dom.window.AppDirs).toBeUndefined();
      expect(dom.window.createEl).toBeUndefined();
      dom.window.eval(source);

      for (const key of ['7', '+', '3', '=']) {
        dom.window.document.querySelector(`[data-key="${key}"]`).click();
      }

      expect(dom.window.document.querySelector('#calculator-display').value).toBe('10');
    } finally {
      dom.window.close();
    }
  });

  it('declares a host entry while retaining its sandbox HTML fallback', async () => {
    const [manifestText, html] = await Promise.all([
      readFile(manifestUrl, 'utf8'),
      readFile(htmlUrl, 'utf8'),
    ]);
    const manifest = JSON.parse(manifestText);

    expect(manifest.entry).toBe('index.html');
    expect(manifest.unrestrictedEntry).toBe('app.js');
    expect(html).toContain('<script src="app.js"></script>');
  });

  it('registers a themed calculator when loaded through the trusted host path', async () => {
    const source = await readFile(appUrl, 'utf8');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    let app;
    dom.window.__novaUnrestrictedPackage = { id: 'com.nbosp.calculator' };
    dom.window.registerApp = (config) => { app = config; };

    try {
      dom.window.eval(source);
      expect(app).toBeTruthy();

      const content = dom.window.document.createElement('div');
      const cleanups = [];
      app.init(content, { cleanups });

      expect(content.querySelector('#calculator-root')).toBeTruthy();
      expect(content.querySelector('[data-key="="]')).toBeTruthy();
      expect(source).toContain('background:var(--bg-base)');
      expect(cleanups).toHaveLength(1);
    } finally {
      dom.window.close();
    }
  });
});
