// tests/apps/scanner.cover.test.js
//
// Coverage-attributed e2e suite for js/apps/scanner/service.js. The real
// service is require()d and driven through its public API (scan /
// scanText / scanBase64) with hand-built File/Blob stand-ins — every
// signature, extension class, active-content rule, sandbox-iframe rule,
// obfuscation pattern and entropy band gets a verdict asserted.
import { describe, it, expect, vi } from 'vitest';
import { coverLoadServiceApp } from '../helpers/cover-loader.js';

const enc = (s) => new TextEncoder().encode(s);
const file = (name, bytes, { failRead = false } = {}) => ({
  name,
  size: bytes.length,
  slice: () => ({
    arrayBuffer: failRead
      ? async () => { throw new Error('read failed'); }
      : async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  }),
});

async function load() {
  const ctx = await coverLoadServiceApp('scanner', { withBaseUtils: true }); // _t
  return ctx.window.Scanner;
}

// deterministic pseudo-random bytes (LCG) — stable entropy across runs
function pseudoRandom(n, seed = 42) {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}

describe('Scanner (js/apps/scanner/service.js) — e2e coverage', () => {
  it('exposes window.Scanner and the DropScanner alias', async () => {
    const S = await load();
    expect(S).toBeTruthy();
    expect(globalThis.window.DropScanner).toBe(S);
    expect(Object.keys(S).sort()).toEqual(['scan', 'scanBase64', 'scanText']);
  });

  it('rejects invalid files and unreadable heads', async () => {
    const S = await load();
    const bad = await S.scan(null);
    expect(bad.safe).toBe(false);
    const noName = await S.scan({ size: 10 });
    expect(noName.safe).toBe(false);
    const unreadable = await S.scan(file('a.txt', enc('hi'), { failRead: true }));
    expect(unreadable.safe).toBe(false);
  });

  it('flags disguised executables by extension and double extension', async () => {
    const S = await load();
    expect((await S.scan(file('installer.exe', enc('whatever')))).safe).toBe(false);
    expect((await S.scan(file('payload.sh', enc('echo hi')))).safe).toBe(false);
    expect((await S.scan(file('invoice.pdf.exe', enc('MZ..')))).reason).toContain('invoice.pdf.exe');
    // a.b.txt: three parts but final ext not executable → no trick
    expect((await S.scan(file('notes.v2.txt', enc('plain')))).safe).toBe(true);
  });

  it('fingerprints every magic-byte signature and tolerates short files', async () => {
    const S = await load();
    const cases = [
      [enc('MZ...'), 'setup.txt'],
      [new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x01]), 'lib.txt'],
      [new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0x00]), 'blob.txt'],
      [new Uint8Array([0xfe, 0xed, 0xfa, 0xce, 0x00]), 'macho.txt'],
      [new Uint8Array([0xfe, 0xed, 0xfa, 0xcf, 0x00]), 'macho64.txt'],
      [enc('#!/bin/sh\necho hi'), 'script.txt'],
    ];
    for (const [bytes, name] of cases) {
      const v = await S.scan(file(name, bytes));
      expect(v.safe).toBe(false);
      expect(v.reason).toBeTruthy();
    }
    // a 1-byte head is shorter than every signature → clean
    expect((await S.scan(file('tiny.txt', new Uint8Array([0x4d])))).safe).toBe(true);
    // a plain image header is not in the signature list → clean
    expect((await S.scan(file('photo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])))).safe).toBe(true);
    // a signature hit on an extension-less file reports the unknown ext
    const noext = await S.scan(file('README', new Uint8Array([0x4d, 0x5a, 0x90, 0x00])));
    expect(noext.safe).toBe(false);
    expect(noext.reason).toBeTruthy();
    // null name: extOf/hasDoubleExtensionTrick take their String(name||'') paths
    const nullName = await S.scanText(null, 'plain content');
    expect(nullName.safe).toBe(true);
  });

  it('blanket-blocks active content in svg/xml/no-ext files', async () => {
    const S = await load();
    const bad = [
      ['a.svg', '<svg><script>alert(1)</script></svg>'],
      ['b.svg', '<a xlink:href="javascript:alert(1)">x</a>'],
      ['c.svg', '<rect onload="go()"/>'],
      ['d.svg', '<iframe src="x.html"></iframe>'],
      ['e.svg', '<object data="x"></object>'],
      ['f.xml', '<payload data="data:text/html,<b>hi</b>"/>'],
    ];
    for (const [name, text] of bad) {
      expect((await S.scanText(name, text)).safe).toBe(false);
    }
    // clean markup passes
    expect((await S.scanText('g.svg', '<svg><rect width="10"/></svg>')).safe).toBe(true);
  });

  it('html: local script src is fine; inline, remote, traversal src are not', async () => {
    const S = await load();
    expect((await S.scanText('index.html', '<script src="app.js"></script><p>hi</p>')).safe).toBe(true);
    expect((await S.scanText('a.html', '<script>alert(1)</script>')).safe).toBe(false);
    expect((await S.scanText('b.html', '<script src="http://evil/x.js"></script>')).safe).toBe(false);
    expect((await S.scanText('c.html', '<script src="//evil/x.js"></script>')).safe).toBe(false);
    expect((await S.scanText('d.html', '<script src="/abs/x.js"></script>')).safe).toBe(false);
    expect((await S.scanText('e.html', '<script src="../up/x.js"></script>')).safe).toBe(false);
    expect((await S.scanText('f.html', '<script src="data:text/html,x"></script>')).safe).toBe(false);
    // a src-less script tag is treated as non-local by design
    expect((await S.scanText('g.html', '<script></script><p>empty script tag</p>')).safe).toBe(false);
    // no src attribute at all → non-local; empty/whitespace src likewise
    expect((await S.scanText('h.html', '<script defer></script>')).safe).toBe(false);
    expect((await S.scanText('i.html', '<script src=""></script>')).safe).toBe(false);
    expect((await S.scanText('j.html', '<script src="   "></script>')).safe).toBe(false);
  });

  it('html: iframes must be sandboxed without the same-origin+scripts combo', async () => {
    const S = await load();
    expect((await S.scanText('a.html', '<iframe src="x.html"></iframe>')).safe).toBe(false);
    // a valueless `sandbox` boolean attribute does not match the sandbox="..."
    // shape — treated as unsandboxed by design
    expect((await S.scanText('b.html', '<iframe sandbox src="local.html"></iframe>')).safe).toBe(false);
    // empty-valued sandbox is a real sandbox
    expect((await S.scanText('b2.html', '<iframe sandbox="" src="local.html"></iframe>')).safe).toBe(true);
    expect((await S.scanText('c.html', '<iframe sandbox="allow-same-origin allow-scripts" src="x"></iframe>')).safe).toBe(false);
    expect((await S.scanText('d.html', '<iframe sandbox="allow-scripts" src="https://ok.example/frame"></iframe>')).safe).toBe(true);
    expect((await S.scanText('e.html', '<iframe sandbox src="http://plain.http/frame"></iframe>')).safe).toBe(false);
    expect((await S.scanText('f.html', '<iframe sandbox src="http://plain.http"></iframe>')).safe).toBe(false);
    expect((await S.scanText('g.html', '<iframe sandbox="allow-forms"></iframe>')).safe).toBe(true); // no src: inert
    expect((await S.scanText('h.html', '<iframe sandbox="allow-same-origin" src="app.js"></iframe>')).safe).toBe(true);
  });

  it('md: attribute checks are scoped to real tags; html stays blanket', async () => {
    const S = await load();
    // prose mentioning javascript:/onclick outside tags is fine in md
    expect((await S.scanText('a.md', 'A tutorial about the `javascript:` URI scheme and onclick= handlers.')).safe).toBe(true);
    // the same words inside a real tag hit
    expect((await S.scanText('b.md', 'see <a href="javascript:alert(1)">this</a>')).safe).toBe(false);
    expect((await S.scanText('c.md', '<img onerror="go()" src="x">')).safe).toBe(false);
    // html keeps the blanket rule (outside tags too)
    expect((await S.scanText('d.html', 'we discuss javascript: URIs in prose')).safe).toBe(false);
    // a tag with neither javascript: nor on*= passes the scoped pass
    expect((await S.scanText('e.md', '<a href="https://ok.example/page">link</a>')).safe).toBe(true);
    // md without any script/iframe pattern is clean even with a local src reference
    expect((await S.scanText('f.md', '<script src="app.js"></script>')).safe).toBe(true);
  });

  it('flags obfuscation patterns in code-ish files', async () => {
    const S = await load();
    const cases = [
      ['a.js', 'eval(x)'],
      ['b.js', 'const f = new Function("return 1")'],
      ['c.txt', decodeURIComponent('%41'.repeat(0)) + '%41%41%41%41%41%41%41%41'.repeat(1)], // 8x %HH chain
      ['d.txt', '\\x41'.repeat(8)], // 8x \xHH chain
      ['e.js', 'eval(atob("YWxlcnQoMSk="))'],
      ['f.js', 'eval(String.fromCharCode(97,108))'],
      ['g.js', 'document.write(String.fromCharCode(97))'],
      ['h.js', 'el.innerHTML = String.fromCharCode(97)'],
    ];
    for (const [name, text] of cases) {
      const v = await S.scanText(name, text);
      expect(v.safe).toBe(false);
      expect(v.reason).toBeTruthy();
    }
    // benign uses of atob / fromCharCode alone are fine
    expect((await S.scanText('i.js', 'const b = atob("YWJj"); const s = String.fromCharCode(97);')).safe).toBe(true);
  });

  it('high-entropy payloads are blocked; ordinary text is not', async () => {
    const S = await load();
    // all 128 single-byte UTF-8 values, top-7-bit LCG sampling: byte entropy
    // ~7.0 (comfortably over the 6.5 gate), lossless TextDecoder round-trip
    const charset = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)).join('');
    let s = 12345;
    let packed = '';
    for (let i = 0; i < 8192; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      packed += charset[s >>> 25];
    }
    const v = await S.scanText('packed.txt', packed);
    expect(v.safe).toBe(false);
    expect((await S.scanText('plain.txt', 'just some ordinary notes')).safe).toBe(true);
    expect((await S.scanText('empty.txt', '')).safe).toBe(true);
  });

  it('skips text analysis for oversized text and non-textish extensions', async () => {
    const S = await load();
    // >2MB text: the text block is skipped entirely → clean
    const huge = 'a'.repeat(2 * 1024 * 1024 + 64);
    expect((await S.scanText('big.txt', huge)).safe).toBe(true);
    // non-textish extension (png): no text scan, no obfuscation hit
    expect((await S.scanText('img.png', 'eval(x) <script>bad</script>')).safe).toBe(true);
    // js with markup strings: only obfuscation applies (clean here)
    expect((await S.scanText('ok.js', 'el.innerHTML = "<b>hi</b>"')).safe).toBe(true);
  });

  it('scanBase64 validates padding and alphabet; scans the real decoded bytes', async () => {
    const S = await load();
    // invalid base64 shapes: each of the three return-false guards + alphabet
    for (const bad of ['A', 'ABCDE', 'ABB==', 'ABBC=', 'A?B/']) {
      const v = await S.scanBase64('a.txt', bad);
      expect(v.safe).toBe(false);
    }
    // empty string is valid base64 for an empty payload → safe
    expect((await S.scanBase64('a.txt', '')).safe).toBe(true);
    // valid: an MZ header hidden in a .txt → magic mismatch through base64
    const mz = btoa('MZ..payload');
    expect((await S.scanBase64('setup.txt', mz)).safe).toBe(false);
    // valid and clean
    const clean = btoa('plain text file');
    expect((await S.scanBase64('a.txt', clean)).safe).toBe(true);
    // binary (non-text) extension: capped at the 512KB sample path
    const bin = btoa(String.fromCharCode(...pseudoRandom(64)));
    expect((await S.scanBase64('icon.png', bin)).safe).toBe(true);
    // oversized base64 input is sliced before decode (no throw)
    expect((await S.scanBase64('a.txt', 'A'.repeat(70_000))).safe).toBe(true);
    // null-ish input: String(null ?? '') → empty payload → safe by design
    expect((await S.scanBase64('a.txt', null)).safe).toBe(true);
  });

  it('scan() returns a warnings array alongside the verdict', async () => {
    const S = await load();
    const v = await S.scan(file('ok.txt', enc('hello world')));
    expect(v).toMatchObject({ safe: true, warnings: [] });
  });
});
