'use strict';

/**
 * NBOSP Email Routes
 * Handles IMAP, POP3, and Microsoft Exchange (EWS) connections.
 * Credentials are stored in the Express session after a successful connect —
 * the password is never sent again after the initial POST /connect.
 *
 * Routes:
 *   GET  /api/email/csrf-token    — fetch a fresh CSRF token (call on app init / relaunch)
 *   POST /api/email/connect       — connect and store creds in session
 *   GET  /api/email/folders       — list folders / mailboxes
 *   GET  /api/email/messages      — list messages (?folder=&page=&limit=)
 *   GET  /api/email/message       — fetch a single message (?folder=&uid=)
 *   POST /api/email/disconnect    — clear session credentials
 */

const express = require('express');
const router = express.Router();
const https = require('https');
const http = require('http');

// ── Optional dependencies (install via npm) ───────────────────────────────────
// npm install imapflow pop3 postal-mime
let ImapFlow, POP3Client, PostalMime;
try { ({ ImapFlow } = require('imapflow')); } catch (e) { ImapFlow = null; }
try { POP3Client = require('node-pop3'); } catch (e) { POP3Client = null; }
try { PostalMime = require('postal-mime'); } catch (e) { PostalMime = null; }

function missingDep(name) {
  return new Error(`Missing dependency: run "npm install ${name}"`);
}

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
    tls: { rejectUnauthorized: false }
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
function decodeEntities(str) {
  if (!str || !str.includes('&')) return str;
  return str
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
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

// ─────────────────────────────────────────────────────────────────────────────
// POP3  (pop3)
// ─────────────────────────────────────────────────────────────────────────────

async function pop3Messages(creds, limit) {
  if (!POP3Client) throw missingDep('node-pop3');
  if (!PostalMime) throw missingDep('postal-mime');

  const port = parseInt(creds.port) || (creds.ssl ? 995 : 110);
  const client = new POP3Client({
    host: creds.host,
    port,
    tls: Boolean(creds.ssl),
    user: creds.user,
    password: creds.pass
  });

  try {
    const [countStr] = await client.STAT();
    const total = parseInt(countStr, 10) || 0;
    const messages = [];

    if (total === 0) {
      return { messages: [], total: 0, page: 1, pages: 1 };
    }

    const fetching = Math.min(total, limit);
    const parser = new PostalMime();

    // Fetch newest messages first
    for (let i = total; i > total - fetching; i--) {
      try {
        const raw = await client.RETR(i);
        const parsed = await parser.parse(raw);
        messages.push({
          uid: i,
          seq: i,
          seen: false,
          subject: parsed.subject || '(no subject)',
          from: parsed.from?.text || '',
          to: parsed.to?.text || '',
          date: parsed.date?.toISOString() || null
        });
      } catch (_) {
        // skip malformed messages
      }
    }

    return { messages, total, page: 1, pages: 1 };
  } finally {
    await client.QUIT().catch(() => { });
  }
}

async function pop3Message(creds, uid) {
  if (!POP3Client) throw missingDep('node-pop3');
  if (!PostalMime) throw missingDep('postal-mime');

  const port = parseInt(creds.port) || (creds.ssl ? 995 : 110);
  const client = new POP3Client({
    host: creds.host,
    port,
    tls: Boolean(creds.ssl),
    user: creds.user,
    password: creds.pass
  });

  try {
    const raw = await client.RETR(parseInt(uid));
    const parser = new PostalMime();
    const parsed = await parser.parse(raw);
    return msgShape(parsed);
  } finally {
    await client.QUIT().catch(() => { });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exchange EWS  (pure HTTP, no extra package)
// ─────────────────────────────────────────────────────────────────────────────

function ewsReq(creds, soapBody) {
  return new Promise((resolve, reject) => {
    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header><t:RequestServerVersion Version="Exchange2013_SP1"/></soap:Header>
  <soap:Body>${soapBody}</soap:Body>
</soap:Envelope>`;

    const auth = Buffer.from(`${creds.user}:${creds.pass}`).toString('base64');
    let urlStr = creds.host.startsWith('http') ? creds.host : `https://${creds.host}`;
    if (!urlStr.endsWith('/EWS/Exchange.asmx')) urlStr += '/EWS/Exchange.asmx';

    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Authorization': `Basic ${auth}`,
        'Content-Length': Buffer.byteLength(envelope)
      },
      rejectUnauthorized: false
    };

    const req = lib.request(opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.write(envelope);
    req.end();
  });
}

function xval(xml, tag) {
  const m = xml.match(new RegExp(`<(?:[a-z]:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[a-z]:)?${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

async function ewsFolders(creds) {
  const soap = `
<m:FindFolder Traversal="Shallow">
  <m:FolderShape>
    <t:BaseShape>IdOnly</t:BaseShape>
    <t:AdditionalProperties>
      <t:FieldURI FieldURI="folder:DisplayName"/>
    </t:AdditionalProperties>
  </m:FolderShape>
  <m:ParentFolderIds>
    <t:DistinguishedFolderId Id="msgfolderroot"/>
  </m:ParentFolderIds>
</m:FindFolder>`;

  const xml = await ewsReq(creds, soap);
  const base = [
    { path: 'inbox', name: 'Inbox' },
    { path: 'sentitems', name: 'Sent Items' },
    { path: 'drafts', name: 'Drafts' },
    { path: 'deleteditems', name: 'Deleted Items' }
  ];
  const blocks = xml.match(/<t:Folder>[\s\S]*?<\/t:Folder>/g) || [];
  const baseNames = new Set(base.map(f => f.name));
  const extra = blocks.map(b => {
    const name = xval(b, 'DisplayName');
    return name ? { path: b.match(/Id="([^"]+)"/)?.[1] || name, name } : null;
  }).filter(f => f && !baseNames.has(f.name));

  return [...base, ...extra];
}

async function ewsMessages(creds, folder, page, limit) {
  const offset = (page - 1) * limit;
  const soap = `
<m:FindItem Traversal="Shallow">
  <m:ItemShape>
    <t:BaseShape>IdOnly</t:BaseShape>
    <t:AdditionalProperties>
      <t:FieldURI FieldURI="message:From"/>
      <t:FieldURI FieldURI="item:Subject"/>
      <t:FieldURI FieldURI="item:DateTimeReceived"/>
      <t:FieldURI FieldURI="message:IsRead"/>
    </t:AdditionalProperties>
  </m:ItemShape>
  <m:IndexedPageItemView MaxEntriesReturned="${limit}" Offset="${offset}" BasePoint="Beginning"/>
  <m:SortOrder>
    <t:FieldOrder Order="Descending">
      <t:FieldURI FieldURI="item:DateTimeReceived"/>
    </t:FieldOrder>
  </m:SortOrder>
  <m:ParentFolderIds>
    <t:DistinguishedFolderId Id="${folder}"/>
  </m:ParentFolderIds>
</m:FindItem>`;

  const xml = await ewsReq(creds, soap);
  const blocks = xml.match(/<t:Message>[\s\S]*?<\/t:Message>/g) || [];
  const messages = blocks.map(b => ({
    uid: b.match(/Id="([^"]+)"/)?.[1] || '',
    seq: 0,
    seen: xval(b, 'IsRead') === 'true',
    subject: xval(b, 'Subject') || '(no subject)',
    from: xval(b, 'Name') || xval(b, 'EmailAddress'),
    date: xval(b, 'DateTimeReceived') ? new Date(xval(b, 'DateTimeReceived')).toISOString() : null
  }));

  const total = parseInt(xml.match(/TotalItemsInView="(\d+)"/)?.[1] || messages.length);
  return { messages, total, page, pages: Math.ceil(total / limit) };
}

async function ewsMessage(creds, uid) {
  const soap = `
<m:GetItem>
  <m:ItemShape>
    <t:BaseShape>Default</t:BaseShape>
    <t:IncludeMimeContent>true</t:IncludeMimeContent>
  </m:ItemShape>
  <m:ItemIds><t:ItemId Id="${uid}"/></m:ItemIds>
</m:GetItem>`;

  const xml = await ewsReq(creds, soap);
  const mime = xval(xml, 'MimeContent');
  if (mime && PostalMime) {
    const parser = new PostalMime();
    return msgShape(await parser.parse(Buffer.from(mime, 'base64')));
  }
  // fallback — text only from XML
  return {
    subject: xval(xml, 'Subject') || '(no subject)',
    from: xval(xml, 'EmailAddress') || xval(xml, 'Name'),
    to: '', cc: '', date: null,
    text: xval(xml, 'Body') || '', html: null, attachments: []
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function msgShape(parsed) {
  // Handle both mailparser and PostalMime formats
  const getAddress = (addr) => {
    if (!addr) return '';
    if (typeof addr === 'string') return addr;
    if (Array.isArray(addr)) return addr.map(a => a.address || a).join(', ');
    return addr.address || addr.text || '';
  };

  return {
    subject: parsed.subject || '(no subject)',
    from: getAddress(parsed.from),
    to: getAddress(parsed.to),
    cc: getAddress(parsed.cc),
    date: parsed.date instanceof Date ? parsed.date.toISOString() : (parsed.date || null),
    text: parsed.text || '',
    html: parsed.html || null,
    attachments: (parsed.attachments || []).map(a => ({
      filename: a.filename,
      contentType: a.contentType || a.mimeType,
      size: a.size || 0
    }))
  };
}

function requireCreds(req, res, next) {
  if (!req.session?.emailCreds) {
    return res.status(401).json({ error: 'Not connected. POST /api/email/connect first.' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/email/csrf-token
 * Returns a fresh CSRF token for the current session.
 * The client must call this on startup (and after any session loss) so that
 * subsequent POST requests — /connect, /preview, /send, etc. — have a valid
 * token to include in the X-CSRF-Token (or _csrf) header/body field.
 *
 * If csurf is not installed the endpoint still responds with ok:true and a
 * null token so the client does not need special-case handling.
 */
router.get('/csrf-token', (req, res) => {
  try {
    // The CSRF token is stored in the session by csrfTokenMiddleware.
    // res.locals.csrfToken is also set by the same middleware as a mirror.
    const token = req.session?.csrfToken || res.locals.csrfToken || null;
    res.json({ ok: true, csrfToken: token });
  } catch (err) {
    res.status(500).json({ ok: false, csrfToken: null, error: err.message });
  }
});

/**
 * POST /api/email/connect
 * Body: { type: 'imap'|'pop3'|'exchange', host, port, ssl, user, pass }
 * Stores credentials in session; returns folders.
 */
router.post('/connect', async (req, res) => {
  const { type, host, port, ssl, user, pass } = req.body;
  if (!type || !host || !user || !pass) {
    return res.status(400).json({ error: 'type, host, user and pass are required' });
  }
  const creds = { type, host, port, ssl: ssl === true || ssl === 'true' || ssl === 1, user, pass };
  try {
    let folders;
    if (type === 'imap') folders = await imapFolders(creds);
    else if (type === 'pop3') folders = [{ path: 'INBOX', name: 'Inbox' }];
    else if (type === 'exchange') folders = await ewsFolders(creds);
    else return res.status(400).json({ error: 'type must be imap, pop3, or exchange' });

    req.session.emailCreds = creds;
    res.json({ ok: true, type, user, host, folders });
  } catch (err) {
    console.error('[Email] connect:', err.message);
    res.status(400).json({ error: err.message || 'Connection failed' });
  }
});

/**
 * GET /api/email/folders
 */
router.get('/folders', requireCreds, async (req, res) => {
  const { emailCreds: c } = req.session;
  try {
    let folders;
    if (c.type === 'imap') folders = await imapFolders(c);
    else if (c.type === 'pop3') folders = [{ path: 'INBOX', name: 'Inbox' }];
    else folders = await ewsFolders(c);
    res.json({ folders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/email/messages?folder=INBOX&page=1&limit=20
 */
router.get('/messages', requireCreds, async (req, res) => {
  const { emailCreds: c } = req.session;
  const folder = req.query.folder || 'INBOX';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(5, parseInt(req.query.limit) || 20));
  try {
    let result;
    if (c.type === 'imap') result = await imapMessages(c, folder, page, limit);
    else if (c.type === 'pop3') result = await pop3Messages(c, limit);
    else result = await ewsMessages(c, folder, page, limit);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/email/message?folder=INBOX&uid=123
 */
router.get('/message', requireCreds, async (req, res) => {
  const { emailCreds: c } = req.session;
  const { folder = 'INBOX', uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid is required' });
  try {
    let msg;
    if (c.type === 'imap') msg = await imapMessage(c, folder, uid);
    else if (c.type === 'pop3') msg = await pop3Message(c, uid);
    else msg = await ewsMessage(c, uid);
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/email/disconnect
 */
router.post('/disconnect', (req, res) => {
  delete req.session.emailCreds;
  res.json({ ok: true });
});

// ── Optional SMTP dependency ──────────────────────────────────────────────────
// npm install nodemailer
let nodemailer;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }

/**
 * POST /api/email/batch
 * Body: { op: 'delete'|'read'|'move', uids: [], folder: string, dest?: string }
 */
router.post('/batch', requireCreds, async (req, res) => {
  const c = req.session.emailCreds;
  const { op, uids = [], folder = 'INBOX', dest } = req.body;
  if (!uids.length) return res.json({ ok: true });
  try {
    if (c.type === 'imap') {
      if (!ImapFlow) throw missingDep('imapflow');
      const client = await imapConnect(c);
      try {
        await resolveFolder(client, folder);
        if (op === 'delete') {
          await client.messageDelete(uids, { uid: true });
        } else if (op === 'read') {
          await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
        } else if (op === 'move' && dest) {
          await client.messageMove(uids, dest, { uid: true });
        }
      } finally {
        await client.logout().catch(() => { });
      }
    }
    // POP3 / Exchange don't support server-side batch ops — silently succeed
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/email/send
 */
router.post('/send', requireCreds, async (req, res) => {
  if (!nodemailer) return res.status(500).json({ error: 'Missing dependency: run "npm install nodemailer"' });
  const sess = req.session.emailCreds;
  // SMTP config comes from the compose FormData (client already sends it).
  // Fall back to the session IMAP host so plain IMAP-only accounts still work.
  const smtpHost = req.body.host || sess.smtpHost || sess.host;
  const smtpPort = parseInt(req.body.port) || sess.smtpPort || 587;
  // Port 465 = direct SSL; port 587 (and others) = STARTTLS.
  // Using secure:true on a STARTTLS port causes "wrong version number" SSL error.
  const useDirectSsl = smtpPort === 465;
  const user = req.body.user || sess.user;
  const pass = req.body.pass || sess.pass;
  if (!smtpHost) return res.status(400).json({ error: 'No SMTP host configured for this account' });
  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost, port: smtpPort,
      secure: useDirectSsl,
      requireTLS: !useDirectSsl,
      auth: { user, pass }, tls: { rejectUnauthorized: false }
    });
    const { to, cc, bcc, subject, text, body, html } = req.body;
    if (!to) return res.status(400).json({ error: 'No recipients defined' });
    const info = await transporter.sendMail({
      from: user, to, cc: cc || undefined, bcc: bcc || undefined, subject,
      text: text || body || '', html: html || undefined
    });
    res.json({ ok: true, messageId: info.messageId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * GET /api/email/search
 */
router.get('/search', requireCreds, async (req, res) => {
  const c = req.session.emailCreds;
  const q = (req.query.q || '').trim();
  const folder = req.query.folder || 'INBOX';
  if (!q) return res.json({ messages: [] });
  if (c.type !== 'imap') return res.status(400).json({ error: 'Search is only supported for IMAP accounts' });
  if (!ImapFlow) return res.status(500).json({ error: 'Missing dependency: run "npm install imapflow"' });
  const client = await imapConnect(c);
  try {
    await resolveFolder(client, folder);
    const uids = await client.search({ or: [{ subject: q }, { from: q }, { body: q }] }, { uid: true });
    const messages = [];
    if (uids.length) {
      for await (const msg of client.fetch(uids.slice(-40).reverse(), { envelope: true, flags: true }, { uid: true })) {
        messages.push({
          uid: msg.uid, subject: msg.envelope.subject || '(no subject)',
          from: msg.envelope.from?.[0]?.address || '', date: msg.envelope.date, seen: msg.flags.has('\\Seen')
        });
      }
    }
    res.json({ messages });
  } finally { await client.logout().catch(() => { }); }
});

/**
 * POST /api/email/delete
 */
router.post('/delete', requireCreds, async (req, res) => {
  const c = req.session.emailCreds;
  const { folder = 'INBOX', uids = [] } = req.body;
  if (!uids.length) return res.json({ ok: true });
  try {
    if (c.type === 'imap') {
      if (!ImapFlow) throw missingDep('imapflow');
      const client = await imapConnect(c);
      try { await resolveFolder(client, folder); await client.messageDelete(uids, { uid: true }); }
      finally { await client.logout().catch(() => { }); }
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /api/email/move
 */
router.post('/move', requireCreds, async (req, res) => {
  const c = req.session.emailCreds;
  const { folder = 'INBOX', uids = [], destination } = req.body;
  if (!uids.length || !destination) return res.json({ ok: true });
  if (c.type !== 'imap') return res.status(400).json({ error: 'Move is only supported for IMAP accounts' });
  if (!ImapFlow) return res.status(500).json({ error: 'Missing dependency: run "npm install imapflow"' });
  const client = await imapConnect(c);
  try {
    await resolveFolder(client, folder);
    await client.messageMove(uids, destination, { uid: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
  finally { await client.logout().catch(() => { }); }
});


// ─────────────────────────────────────────────────────────────────────────────
// Email HTML preview — serves email body with its own permissive CSP so inline
// styles render correctly. Firefox applies the parent page CSP to blob: URLs
// so a server route with its own response headers is the only reliable fix.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const previewCache = new Map();

function cleanPreviewCache() {
  const cutoff = Date.now() - 5 * 60 * 1000; // 5 min TTL
  for (const [k, v] of previewCache) { if (v.ts < cutoff) previewCache.delete(k); }
}

// ── Preview helpers ───────────────────────────────────────────────────────────

function servePreviewHtml(res, html) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src * data: blob:; font-src *; script-src 'none'; object-src 'none'");
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const trimmed = html.trimStart();
  res.send(trimmed.toLowerCase().startsWith('<!doctype') ? trimmed : '<!DOCTYPE html>' + trimmed);
}

/**
 * POST /api/email/preview
 *
 * Stores HTML in the server-side cache (+ session as a fallback) and returns a
 * one-time token the client loads in a sandboxed iframe via GET /preview/:token.
 *
 * CSRF note: this route must be excluded from the global csurf middleware in
 * the main app (e.g. pass { ignoreMethods: [] } and whitelist this path, or
 * apply csurf only to routes that need it). It is not state-modifying — it
 * temporarily stores content the authenticated user already possesses — so
 * exempting it is safe. The client must also send the X-CSRF-Token header
 * (obtained from GET /api/email/csrf-token) if csurf is active globally.
 *
 * If csurf blocks this POST the client should fall back to creating a Blob URL
 * from the HTML locally rather than displaying raw HTML as text.
 */
router.post('/preview', (req, res) => {
  const { html } = req.body || {};
  if (typeof html !== 'string') return res.status(400).json({ error: 'html required' });
  cleanPreviewCache();
  const token = crypto.randomBytes(24).toString('hex');
  previewCache.set(token, { html, ts: Date.now() });

  // Also store in the session so the token survives a server-side cache flush
  // (e.g. if the process restarts between the POST and the iframe GET).
  if (req.session) {
    if (!req.session.emailPreviews) req.session.emailPreviews = {};
    // Keep at most 10 recent previews in the session to avoid bloat.
    const keys = Object.keys(req.session.emailPreviews);
    if (keys.length >= 10) delete req.session.emailPreviews[keys[0]];
    req.session.emailPreviews[token] = html;
  }

  res.json({ token });
});

router.get('/preview/:token', (req, res) => {
  // Prefer the in-memory cache (fastest); fall back to the session store so
  // the iframe still loads even if the server-side Map was flushed.
  const entry = previewCache.get(req.params.token)
    || (req.session?.emailPreviews?.[req.params.token]
      ? { html: req.session.emailPreviews[req.params.token] }
      : null);

  if (!entry) return res.status(404).send('Preview expired or not found. Please reopen the email.');

  // Clean up the session entry once it has been served.
  if (req.session?.emailPreviews?.[req.params.token]) {
    delete req.session.emailPreviews[req.params.token];
  }

  servePreviewHtml(res, entry.html);
});

module.exports = router;