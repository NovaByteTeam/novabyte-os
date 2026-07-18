/**
 * NovaByte - Scanner
 * Barebones static-heuristic gate for untrusted file content before it's
 * written to FS or installed as an app. Not an AV engine — no signature DB,
 * no cloud lookups, no quarantine UI. Just cheap checks that catch the
 * common "disguised payload" tricks, run synchronously against the bytes
 * the browser already has in memory.
 *
 * Currently wired into:
 *   - Desktop / Files vault drag-and-drop (js/core/ui/wm.js, js/apps/files.js)
 *   - App Manager package install (js/apps/appmanager.js)
 *
 * Exposed globally as window.Scanner so any other app/feature can call into
 * it before trusting file content it receives from outside the OS.
 *
 * Usage: const verdict = await Scanner.scan(file);   // File/Blob
 *        if (!verdict.safe) { reject with verdict.reason }
 */
(function () {
  'use strict';

  // First few bytes of common binary/executable formats, keyed by the
  // extension a legitimate file of that type would carry. If a dropped
  // file's declared extension implies "not executable" but its header
  // matches one of these, it's lying about what it is.
  const MAGIC_SIGNATURES = [
    { bytes: [0x4d, 0x5a],                         label: 'Windows PE executable (MZ header)' },
    { bytes: [0x7f, 0x45, 0x4c, 0x46],              label: 'Linux ELF executable' },
    { bytes: [0xca, 0xfe, 0xba, 0xbe],              label: 'Mach-O / Java class (fat binary)' },
    { bytes: [0xfe, 0xed, 0xfa, 0xce],              label: 'Mach-O executable (32-bit)' },
    { bytes: [0xfe, 0xed, 0xfa, 0xcf],              label: 'Mach-O executable (64-bit)' },
    { bytes: [0x23, 0x21],                          label: 'shell script shebang (#!)' },
  ];

  // Extensions that are inherently executable/script content. Dropping
  // these directly is flagged; nothing here runs in this OS, so there's
  // no legitimate reason for one to land in the vault.
  const EXECUTABLE_EXTENSIONS = new Set([
    'exe', 'dll', 'com', 'bat', 'cmd', 'ps1', 'vbs', 'vbe', 'wsf', 'wsh',
    'scr', 'msi', 'msp', 'jar', 'sh', 'bash', 'run', 'bin', 'app', 'command',
    'apk', 'jse', 'cpl', 'gadget',
  ]);

  // Extensions whose content gets *rendered* elsewhere in this OS (Quill,
  // Gallery, Browser preview, Email attachments-preview, etc). These are
  // allowed, but get scanned for embedded active content since an SVG or
  // HTML file can carry a script payload just like a .js file can.
  const RENDERED_TEXT_EXTENSIONS = new Set([
    'svg', 'html', 'htm', 'xhtml', 'xml', 'md', 'txt',
  ]);

  // Patterns indicating embedded script / active content inside a file
  // that's nominally "just markup" or "just text". Kept intentionally
  // small — this is a tripwire, not a parser.
  const ACTIVE_CONTENT_PATTERNS = [
    { re: /<script\b/i,                      label: 'embedded <script> tag' },
    { re: /\son\w+\s*=\s*["']/i,             label: 'inline event handler (on*=)' },
    { re: /javascript:/i,                    label: 'javascript: URI' },
    { re: /<iframe\b/i,                      label: 'embedded <iframe>' },
    { re: /<object\b|<embed\b/i,             label: 'embedded <object>/<embed>' },
    { re: /data:text\/html/i,                label: 'data: HTML payload' },
  ];

  // Obfuscation smells for anything that will be treated as executable
  // script content (either by extension, or because it tripped an
  // active-content pattern above).
  const OBFUSCATION_PATTERNS = [
    { re: /\beval\s*\(/i,                                    label: 'eval(...) call' },
    { re: /new\s+Function\s*\(/i,                            label: 'new Function(...) construction' },
    { re: /(?:\\x[0-9a-f]{2}){8,}/i,                          label: 'long \\xHH escape chain' },
    { re: /(?:%[0-9a-f]{2}){8,}/i,                            label: 'long percent-encoded chain' },
    { re: /atob\s*\(|Buffer\.from\([^)]*base64/i,             label: 'base64 decode call' },
    { re: /fromCharCode\s*\(/i,                               label: 'String.fromCharCode(...) chain' },
  ];

  const MAX_SCAN_BYTES = 512 * 1024;      // only need the head of the file to fingerprint it
  const MAX_TEXT_SCAN_BYTES = 2 * 1024 * 1024; // cap text/regex scanning for large "text" files

  function extOf(name) {
    const parts = String(name || '').toLowerCase().split('.');
    return parts.length > 1 ? parts.pop() : '';
  }

  // Flags "invoice.pdf.exe"-style disguises: an executable extension
  // preceded by a plausible document/media extension.
  function hasDoubleExtensionTrick(name) {
    const lower = String(name || '').toLowerCase();
    const parts = lower.split('.');
    if (parts.length < 3) return false;
    const finalExt = parts[parts.length - 1];
    return EXECUTABLE_EXTENSIONS.has(finalExt);
  }

  function matchesMagicBytes(bytes) {
    for (const sig of MAGIC_SIGNATURES) {
      if (bytes.length < sig.bytes.length) continue;
      let match = true;
      for (let i = 0; i < sig.bytes.length; i++) {
        if (bytes[i] !== sig.bytes[i]) { match = false; break; }
      }
      if (match) return sig.label;
    }
    return null;
  }

  // Rough Shannon entropy over a byte sample — high entropy in something
  // claiming to be plain text/markup is a signal of packed/encoded payload
  // rather than authored content.
  function estimateEntropy(bytes) {
    if (!bytes.length) return 0;
    const counts = new Array(256).fill(0);
    for (let i = 0; i < bytes.length; i++) counts[bytes[i]]++;
    let entropy = 0;
    for (const c of counts) {
      if (!c) continue;
      const p = c / bytes.length;
      entropy -= p * Math.log2(p);
    }
    return entropy; // 0 (uniform/repetitive) .. 8 (fully random)
  }

  function decodeAsText(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch (_e) {
      return '';
    }
  }

  // Shared verdict logic once we have a name + byte buffer, regardless of
  // whether it arrived as a File (drag-and-drop) or a decoded string
  // (app package file entry). Keeps scan() and scanText() from drifting.
  async function scanBytes(name, bytes) {
    const ext = extOf(name);

    if (hasDoubleExtensionTrick(name)) {
      return {
        safe: false,
        reason: `"${name}" disguises an executable (.${extOf(name)}) behind a second file extension.`,
      };
    }

    if (EXECUTABLE_EXTENSIONS.has(ext)) {
      return {
        safe: false,
        reason: `"${name}" is an executable/script file type (.${ext}), which isn't allowed.`,
      };
    }

    const magicLabel = matchesMagicBytes(bytes.subarray(0, Math.min(bytes.length, MAX_SCAN_BYTES)));
    if (magicLabel) {
      return {
        safe: false,
        reason: `"${name}" claims to be a .${ext || 'unknown'} file but its contents are a ${magicLabel}.`,
      };
    }

    const looksTextish = RENDERED_TEXT_EXTENSIONS.has(ext) || ext === '' ||
      ext === 'js' || ext === 'mjs' || ext === 'css' || ext === 'json';
    if (looksTextish && bytes.length <= MAX_TEXT_SCAN_BYTES) {
      const sampleBytes = bytes.subarray(0, Math.min(bytes.length, MAX_TEXT_SCAN_BYTES));
      const text = decodeAsText(sampleBytes);

      // .js/.mjs/.css/.json are expected to contain code, so the markup
      // "active content" patterns (script tags, on*=, iframes) don't apply
      // to them — only the obfuscation + entropy checks do.
      if (RENDERED_TEXT_EXTENSIONS.has(ext) || ext === '') {
        let activeHit = null;
        for (const pat of ACTIVE_CONTENT_PATTERNS) {
          if (pat.re.test(text)) { activeHit = pat.label; break; }
        }
        if (activeHit) {
          return {
            safe: false,
            reason: `"${name}" contains ${activeHit}, which isn't allowed in a file that gets previewed/rendered.`,
          };
        }
      }

      for (const pat of OBFUSCATION_PATTERNS) {
        if (pat.re.test(text)) {
          return {
            safe: false,
            reason: `"${name}" contains obfuscated code (${pat.label}).`,
          };
        }
      }

      const entropy = estimateEntropy(sampleBytes);
      if (entropy > 6.5) {
        return {
          safe: false,
          reason: `"${name}" is declared as text but its content is high-entropy (likely packed/encoded binary), which isn't allowed.`,
        };
      }
    }

    return { safe: true };
  }

  /**
   * Scan a dropped File before it's committed to FS.
   * Returns { safe: boolean, reason?: string, warnings: string[] }
   */
  async function scan(file) {
    const warnings = [];

    if (!file || typeof file.name !== 'string') {
      return { safe: false, reason: 'Invalid file object.', warnings };
    }

    // Only need the head of the file to fingerprint + text-scan it — no
    // reason to pull a multi-GB drop fully into memory.
    const headSize = Math.min(file.size, MAX_TEXT_SCAN_BYTES);
    let headBytes;
    try {
      const headBuf = await file.slice(0, headSize).arrayBuffer();
      headBytes = new Uint8Array(headBuf);
    } catch (_e) {
      return { safe: false, reason: `Could not read "${file.name}" to scan it.`, warnings };
    }

    const verdict = await scanBytes(file.name, headBytes);
    return { ...verdict, warnings };
  }

  /**
   * Scan already-decoded text content (e.g. a package file entry that's
   * been base64-decoded to a string already) without needing a File/Blob.
   * Returns { safe: boolean, reason?: string }
   */
  async function scanText(name, text) {
    const bytes = new TextEncoder().encode(String(text ?? ''));
    return scanBytes(name, bytes);
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /**
   * Scan a raw base64 string directly against the real bytes it decodes
   * to — unlike scanText(), this doesn't round-trip through a JS string
   * first, so magic-byte fingerprinting works correctly even for binary
   * package entries (icons, images, etc), not just text files.
   * Returns { safe: boolean, reason?: string }
   */
  async function scanBase64(name, base64) {
    let bytes;
    try {
      bytes = base64ToBytes(String(base64 ?? ''));
    } catch (_e) {
      return { safe: false, reason: `"${name}" is not valid base64 and could not be scanned.` };
    }
    return scanBytes(name, bytes);
  }

  const Scanner = { scan, scanText, scanBase64 };
  window.Scanner = Scanner;
  // Back-compat alias for existing call sites / anything already wired to
  // the old name.
  window.DropScanner = Scanner;
})();
