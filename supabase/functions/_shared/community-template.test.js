import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJson,
  encodeCommunityTemplateFiles,
  MAX_TEMPLATE_EXPANDED_BYTES,
  MAX_TEMPLATE_JSON_BYTES,
  NOVABYTE_TEMPLATE_SIGNING_PUBLIC_KEY,
  parseCommunityTemplateJson,
  parseSignedCommunityTemplateJson,
  parseStudioCommunityTemplateBundle,
} from './community-template.js';

function makeUpload(overrides = {}) {
  return new TextEncoder().encode(JSON.stringify({
    format: 'novapack-studio-user-template',
    version: 1,
    template: {
      name: 'Starter Project',
      description: 'A reviewed starter project template.',
      author: 'NovaByte Community',
      releaseVersion: '1.0.0',
      category: 'general',
      icon: '✨',
      manifest: { formatVersion: 1 },
      files: { 'README.md': 'Starter content' },
      ...overrides,
    },
  }));
}

function makeStudioBundle() {
  const template = JSON.parse(new TextDecoder().decode(makeUpload())).template;
  template.files = Object.fromEntries(Object.entries(template.files).map(([path, text]) => [
    path,
    btoa(String.fromCharCode(...new TextEncoder().encode(text))),
  ]));
  return new TextEncoder().encode(JSON.stringify({
    format: 'novapack-studio-user-template',
    version: 1,
    template,
  }));
}

test('accepts an unsigned version-one template wrapper and preserves content', () => {
  const parsed = parseCommunityTemplateJson(makeUpload());
  assert.equal(parsed.format, 'novapack-studio-user-template');
  assert.equal(parsed.version, 1);
  assert.equal(parsed.template.files['README.md'], 'Starter content');
});

test('accepts an exported .nbtemplate and decodes files only for validation', () => {
  const parsed = parseStudioCommunityTemplateBundle(makeStudioBundle());
  assert.equal(parsed.format, 'novapack-studio-user-template');
  assert.equal(parsed.template.files['README.md'], 'Starter content');
});

test('rejects a signed bundle as an initial unsigned template submission', () => {
  const bundle = JSON.parse(new TextDecoder().decode(makeStudioBundle()));
  bundle.signature = { algorithm: 'Ed25519', publicKey: NOVABYTE_TEMPLATE_SIGNING_PUBLIC_KEY, signature: 'invalid' };
  assert.throws(
    () => parseStudioCommunityTemplateBundle(new TextEncoder().encode(JSON.stringify(bundle))),
    /unsigned Studio \.nbtemplate/i,
  );
});

test('requires the pinned NovaByte signing key for signed templates', async () => {
  const bundle = JSON.parse(new TextDecoder().decode(makeStudioBundle()));
  bundle.signature = { algorithm: 'Ed25519', publicKey: 'not-the-pinned-key', signature: 'AA' };
  await assert.rejects(
    parseSignedCommunityTemplateJson(new TextEncoder().encode(JSON.stringify(bundle))),
    /NovaByte Trusted Signing/,
  );
});

test('rejects a signed template with an invalid Ed25519 signature', async () => {
  const bundle = JSON.parse(new TextDecoder().decode(makeStudioBundle()));
  const zeros = String.fromCharCode(...new Uint8Array(64));
  bundle.signature = {
    algorithm: 'Ed25519',
    publicKey: NOVABYTE_TEMPLATE_SIGNING_PUBLIC_KEY,
    signature: btoa(zeros).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''),
  };
  await assert.rejects(
    parseSignedCommunityTemplateJson(new TextEncoder().encode(JSON.stringify(bundle))),
    /failed NovaByte signature verification/,
  );
});

test('canonical JSON sorts keys recursively', () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, b: 3 } }),
    '{"a":{"b":3,"y":2},"z":1}',
  );
});

test('encodes reviewed UTF-8 text files in the format Studio verifies', () => {
  const parsed = parseCommunityTemplateJson(makeUpload({
    files: { 'src/index.js': 'const title = "café";' },
  }));
  const signedTemplate = encodeCommunityTemplateFiles(parsed.template);
  assert.notEqual(signedTemplate.files['src/index.js'], parsed.template.files['src/index.js']);
  assert.equal(
    new TextDecoder().decode(Uint8Array.from(atob(signedTemplate.files['src/index.js']), character => character.charCodeAt(0))),
    'const title = "café";',
  );
});

test('rejects path traversal, hidden, dependency, and manifest-collision paths', () => {
  for (const path of ['../secret', 'folder/../../secret', '.git/config', 'node_modules/pkg', 'src/manifest.json']) {
    assert.throws(
      () => parseCommunityTemplateJson(makeUpload({ files: { [path]: 'content' } })),
      /unsafe|reserved metadata/i,
    );
  }
});

test('rejects prototype keys in nested JSON and duplicate file paths across case', () => {
  const unsafe = makeUpload();
  const unsafeObject = JSON.parse(new TextDecoder().decode(unsafe));
  unsafeObject.template.manifest.constructor = 'unsafe';
  assert.throws(
    () => parseCommunityTemplateJson(new TextEncoder().encode(JSON.stringify(unsafeObject))),
    /forbidden key/i,
  );
  assert.throws(
    () => parseCommunityTemplateJson(makeUpload({ files: { 'src/main.ts': 'a', 'SRC/Main.ts': 'b' } })),
    /duplicate file path/i,
  );
});

test('enforces text-only files and expanded UTF-8 content limit', () => {
  assert.throws(
    () => parseCommunityTemplateJson(makeUpload({ files: { 'file.bin': { data: 'no' } } })),
    /must contain text/i,
  );
  assert.throws(
    () => parseCommunityTemplateJson(makeUpload({ files: { 'large.txt': 'é'.repeat(Math.floor(MAX_TEMPLATE_EXPANDED_BYTES / 2) + 1) } })),
    /2 MiB expanded-content limit/i,
  );
});

test('rejects unsupported fields, wrappers, and oversized JSON', () => {
  assert.throws(
    () => parseCommunityTemplateJson(makeUpload({ description: 'x'.repeat(241) })),
    /Description must be between 10 and 240 characters/,
  );
  assert.throws(
    () => parseCommunityTemplateJson(makeUpload({ icon: 'x'.repeat(101) })),
    /Icon must be between 1 and 100 characters/,
  );
  assert.throws(
    () => parseCommunityTemplateJson(makeUpload({ screenshots: [] })),
    /exactly/i,
  );
  const bytes = makeUpload();
  const signedInput = JSON.parse(new TextDecoder().decode(bytes));
  signedInput.signature = {};
  assert.throws(
    () => parseCommunityTemplateJson(new TextEncoder().encode(JSON.stringify(signedInput))),
    /only format, version, and template/i,
  );
  assert.throws(
    () => parseCommunityTemplateJson(new Uint8Array(MAX_TEMPLATE_JSON_BYTES + 1)),
    /between 1 byte and 4 MiB/i,
  );
});
