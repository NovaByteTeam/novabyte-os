export const MAX_TEMPLATE_JSON_BYTES = 4 * 1024 * 1024;
export const MAX_TEMPLATE_EXPANDED_BYTES = 2 * 1024 * 1024;
export const MAX_TEMPLATE_FILES = 500;
const MAX_TEMPLATE_DESCRIPTION_LENGTH = 240;
const MAX_TEMPLATE_ICON_LENGTH = 100;

const TEMPLATE_KEYS = [
  'author',
  'category',
  'description',
  'files',
  'icon',
  'manifest',
  'name',
  'releaseVersion',
];
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const encoder = new TextEncoder();

export class CommunityTemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommunityTemplateError';
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateJsonKeys(value) {
  if (Array.isArray(value)) {
    for (const item of value) validateJsonKeys(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new CommunityTemplateError(`The template JSON contains a forbidden key: ${key}`);
    }
    validateJsonKeys(child);
  }
}

function requiredText(value, label, maximum, minimum = 1) {
  if (typeof value !== 'string') throw new CommunityTemplateError(`${label} must be a string.`);
  const result = value.trim();
  if (result.length < minimum || result.length > maximum) {
    throw new CommunityTemplateError(`${label} must be between ${minimum} and ${maximum} characters.`);
  }
  if (result !== value) throw new CommunityTemplateError(`${label} must not start or end with whitespace.`);
  return result;
}

function validateFilePath(path) {
  if (typeof path !== 'string' || path.length > 240) {
    throw new CommunityTemplateError('Template file paths must be strings no longer than 240 characters.');
  }
  const segments = path.split('/');
  if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/')
    || /^[a-zA-Z]:/.test(path) || segments.some(segment =>
      !segment || segment === '.' || segment === '..' || segment.includes(':')
      || segment.startsWith('.') || segment.toLowerCase() === 'node_modules'
      || FORBIDDEN_KEYS.has(segment.toLowerCase()))) {
    throw new CommunityTemplateError(`The template contains an unsafe or unsupported file path: ${path}`);
  }
  const basename = segments.at(-1).toLowerCase();
  if (basename === 'manifest.json' || basename === 'template.json') {
    throw new CommunityTemplateError(`The template file path collides with reserved metadata: ${path}`);
  }
  return path;
}

function compareVersions(left, right) {
  const parse = version => {
    const match = VERSION_PATTERN.exec(version);
    if (!match) throw new CommunityTemplateError('Template releaseVersion must be valid semantic versioning, such as 1.2.3.');
    return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') || null };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (!a.prerelease || !b.prerelease) {
    if (a.prerelease === b.prerelease) return 0;
    return a.prerelease ? -1 : 1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    if (a.prerelease[index] === b.prerelease[index]) continue;
    const leftNumeric = /^\d+$/.test(a.prerelease[index]);
    const rightNumeric = /^\d+$/.test(b.prerelease[index]);
    if (leftNumeric && rightNumeric) return Number(a.prerelease[index]) > Number(b.prerelease[index]) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return a.prerelease[index] > b.prerelease[index] ? 1 : -1;
  }
  return 0;
}

export function validateCommunityTemplate(value) {
  if (!isRecord(value)) throw new CommunityTemplateError('The template must be a JSON object.');
  validateJsonKeys(value);
  const keys = Object.keys(value).sort();
  if (keys.length !== TEMPLATE_KEYS.length || keys.some((key, index) => key !== TEMPLATE_KEYS[index])) {
    throw new CommunityTemplateError(`The template must contain exactly: ${TEMPLATE_KEYS.join(', ')}.`);
  }

  const template = {
    name: requiredText(value.name, 'Template name', 80),
    description: requiredText(value.description, 'Description', MAX_TEMPLATE_DESCRIPTION_LENGTH, 10),
    author: requiredText(value.author, 'Author', 80),
    releaseVersion: requiredText(value.releaseVersion, 'Release version', 40),
    category: requiredText(value.category, 'Category', 40),
    icon: requiredText(value.icon, 'Icon', MAX_TEMPLATE_ICON_LENGTH),
    manifest: value.manifest,
    files: value.files,
  };
  if (!VERSION_PATTERN.test(template.releaseVersion)) {
    throw new CommunityTemplateError('Template releaseVersion must be valid semantic versioning, such as 1.2.3.');
  }
  if (!isRecord(template.manifest)) throw new CommunityTemplateError('The template manifest must be a JSON object.');
  if (!isRecord(template.files)) throw new CommunityTemplateError('Template files must be an object mapping safe paths to text content.');

  const paths = new Set();
  let expandedBytes = 0;
  const fileEntries = Object.entries(template.files);
  if (!fileEntries.length || fileEntries.length > MAX_TEMPLATE_FILES) {
    throw new CommunityTemplateError(`A template must contain between 1 and ${MAX_TEMPLATE_FILES} files.`);
  }
  for (const [rawPath, contents] of fileEntries) {
    const path = validateFilePath(rawPath);
    const normalizedPath = path.normalize('NFC').toLowerCase();
    if (paths.has(normalizedPath)) throw new CommunityTemplateError(`The template contains a duplicate file path: ${path}`);
    paths.add(normalizedPath);
    if (typeof contents !== 'string') {
      throw new CommunityTemplateError(`Template file "${path}" must contain text, not binary data.`);
    }
    expandedBytes += encoder.encode(contents).byteLength;
    if (expandedBytes > MAX_TEMPLATE_EXPANDED_BYTES) {
      throw new CommunityTemplateError('Template files exceed the 2 MiB expanded-content limit.');
    }
  }
  return template;
}

export function parseCommunityTemplateJson(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_TEMPLATE_JSON_BYTES) {
    throw new CommunityTemplateError('The template JSON must be between 1 byte and 4 MiB.');
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new CommunityTemplateError('The template upload must be valid UTF-8 JSON.');
  }
  if (!isRecord(parsed)) throw new CommunityTemplateError('The template upload must be a JSON object.');
  validateJsonKeys(parsed);
  const allowed = ['format', 'template', 'version'];
  const keys = Object.keys(parsed).sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw new CommunityTemplateError('Use an unsigned JSON wrapper containing only format, version, and template.');
  }
  if (parsed.format !== 'novapack-studio-user-template' || parsed.version !== 1) {
    throw new CommunityTemplateError('The upload must use the novapack-studio-user-template format, version 1.');
  }
  return {
    format: parsed.format,
    version: parsed.version,
    template: validateCommunityTemplate(parsed.template),
  };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function encodeCommunityTemplateFiles(template) {
  const files = Object.fromEntries(Object.entries(template.files).map(([path, content]) => {
    const bytes = encoder.encode(content);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return [path, btoa(binary)];
  }));
  return { ...template, files };
}

export function compareCommunityTemplateVersions(left, right) {
  return compareVersions(left, right);
}
