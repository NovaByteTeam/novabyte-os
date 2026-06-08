'use strict';
const path = require('path');
// ─────────────────────────────────────────────────────────────────────────────
// IMAP  (imapflow)
// ─────────────────────────────────────────────────────────────────────────────

async function imapConnect(creds) {
  if (!ImapFlow) throw missingDep('imapflow');
  const client = new ImapFlow({
    host: creds.host,
    port: parseInt(creds.port) || (creds.ssl ? 993 : 143),
    secure: Boolean(creds.ssl),
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
    tls: { rejectUnauthorized: true },
    timeout: 10000,           // 10s connection timeout
    commandTimeout: 30000,    // 30s command timeout
    idleTimeout: 30 * 60 * 1000  // 30m idle timeout
  });
  await client.connect();
  return client;
}

async function imapFolders(creds) {
  const client = await imapConnect(creds);
  try {
    const list = await client.list();
    return list.map(m => ({
      path: decodeEntities(m.path),
      name: decodeEntities(m.name || m.path.split(m.delimiter || '/').pop()),
      delimiter: m.delimiter,
      flags: [...(m.flags || [])]
    }));
  } finally {
    await client.logout().catch(() => { });
  }
}

// Some IMAP servers or JSON serialisers encode '/' as '&#x2F;' in folder paths.
// Decode all named/numeric HTML entities before using a path with ImapFlow.
// Memoize results to avoid O(n) regex replacements on repeated folder paths (P1)
const decodedPathCache = new Map();
function decodeEntities(str) {
  if (!str || !str.includes('&')) return str;
  if (decodedPathCache.has(str)) return decodedPathCache.get(str);
  const decoded = str
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  if (decodedPathCache.size > 500) {
    const first = decodedPathCache.keys().next().value;
    decodedPathCache.delete(first);
  }
  decodedPathCache.set(str, decoded);
  return decoded;
}

// Common folder name aliases per provider (Gmail, Outlook, Yahoo, etc.)
const FOLDER_ALIASES = {
  inbox: ['inbox'],
  sent: ['sent', 'sent mail', 'sent messages', 'sent items', '[gmail]/sent mail'],
  drafts: ['drafts', 'draft', '[gmail]/drafts'],
  trash: ['trash', 'deleted', 'deleted items', 'bin', '[gmail]/trash'],
  spam: ['spam', 'junk', 'junk e-mail', 'junk mail', 'bulk mail', '[gmail]/spam'],
  archive: ['archive', 'all mail', '[gmail]/all mail'],
};

async function resolveFolder(client, folder) {
  // Decode HTML entities (e.g. &#x2F; → /) that may be embedded in stored paths.
  folder = decodeEntities(folder);
  try {
    return await client.mailboxOpen(folder);
  } catch {
    // Folder path didn't match — try alias-based lookup against the real folder list.
    const needle = folder.toLowerCase().replace(/^.*\//, ''); // strip namespace prefix
    const aliases = FOLDER_ALIASES[needle] || [needle];
    const list = await client.list();
    const match = list.find(f =>
      aliases.some(a => f.path.toLowerCase() === a || (f.name || '').toLowerCase() === a)
    );
    if (!match) throw new Error(`Folder not found: ${folder}`);
    return client.mailboxOpen(match.path);
  }
}

async function imapMessages(creds, folder, page, limit) {
  const client = await imapConnect(creds);
  try {
    const box = await resolveFolder(client, folder);
    const total = box.exists;
    if (total === 0) return { messages: [], total: 0, page, pages: 0 };

    // Sequence range — newest first
    const end = Math.max(1, total - (page - 1) * limit);
    const start = Math.max(1, end - limit + 1);

    const messages = [];
    for await (const msg of client.fetch(`${start}:${end}`, {
      uid: true, flags: true, envelope: true
    })) {
      const env = msg.envelope || {};
      messages.push({
        uid: msg.uid,
        seq: msg.seq,
        seen: msg.flags?.has('\\Seen') || false,
        subject: env.subject || '(no subject)',
        from: env.from?.[0]
          ? [env.from[0].name, `<${env.from[0].address}>`].filter(Boolean).join(' ').trim()
          : '',
        to: (env.to || []).map(a => a.address).join(', '),
        date: env.date ? new Date(env.date).toISOString() : null
      });
    }
    return { messages: messages.reverse(), total, page, pages: Math.ceil(total / limit) };
  } finally {
    await client.logout().catch(() => { });
  }
}

async function imapMessage(creds, folder, uid) {
  if (!PostalMime) throw missingDep('postal-mime');
  const client = await imapConnect(creds);
  try {
    await resolveFolder(client, folder);
    let raw = null;
    for await (const msg of client.fetch({ uid: parseInt(uid) }, { source: true })) {
      raw = msg.source;
    }
    if (!raw) throw new Error('Message not found');
    const parser = new PostalMime();
    const parsed = await parser.parse(raw);
    return msgShape(parsed);
  } finally {
    await client.logout().catch(() => { });
  }
}


module.exports = { imapConnect, imapFolders, imapMessages, imapMessage };
