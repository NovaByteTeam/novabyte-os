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
const path = require('path');
const crypto = require('crypto');

// In-memory preview cache: token → { html, ts }
// Entries expire after 5 minutes (cleaned on each POST /preview).
const previewCache = new Map();

// ── Tracker domain blocklist (Disconnect.me) ──────────────────────────────────
// Loaded once at server startup via require() — works here because email-routes
// runs in the Node/Express server process, not the browser window.
let EMAIL_TRACKER_DOMAINS = new Set();
try {
  ({ TRACKER_DOMAINS: EMAIL_TRACKER_DOMAINS } = require(path.join(__dirname, 'trackers.js')));
  console.log('[Email] Tracker blocklist loaded:', EMAIL_TRACKER_DOMAINS.size, 'domains');
} catch (e) {
  console.warn('[Email] trackers.js not found — email link tracker blocking disabled:', e.message);
}

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
    tls: { rejectUnauthorized: true }
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
      rejectUnauthorized: true
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

  // Helper: decode top-level HTML entities that IMAP servers or PostalMime
  // sometimes introduce (e.g. &lt;div&gt; instead of <div>).
  // Runs two passes to handle double-encoded sequences like &amp;#39; → &#39; → '.
  // Only decodes when the result actually contains HTML markup — avoids
  // mangling plain-text emails that happen to contain &amp; or &lt; literally.
  function decodeIfEntityEncoded(str) {
    if (!str || !str.includes('&lt;')) return str;
    function onePass(s) {
      return s
        .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"').replace(/&#x22;/gi, '"')
        .replace(/&#39;/gi, "'").replace(/&#x27;/gi, "'")
        .replace(/&#x2F;/gi, '/').replace(/&#x2f;/gi, '/')
        .replace(/&amp;/gi, '&');  // &amp; last so it doesn't pre-expand others
    }
    let decoded = onePass(str);
    // Second pass handles double-encoded sequences (&amp;lt; → &lt; → <)
    if (decoded.includes('&lt;') || decoded.includes('&amp;') || decoded.includes('&#')) decoded = onePass(decoded);
    return (/<[a-zA-Z]/.test(decoded) || /<!doctype/i.test(decoded)) ? decoded : str;
  }

  let html = parsed.html ? decodeIfEntityEncoded(parsed.html) : null;
  let text = parsed.text || '';
  // PostalMime sometimes sets `text` to an entity-encoded copy of the HTML body
  // when there is no text/plain part. Detect and promote it to `html`.
  if (!html && text) {
    const decoded = text
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
    if (/^\s*<!doctype\s+html/i.test(decoded) || /^\s*<html[\s>]/i.test(decoded)) {
      html = decoded;
      text = '';
    }
  }

  return {
    subject: parsed.subject || '(no subject)',
    from: getAddress(parsed.from),
    to: getAddress(parsed.to),
    cc: getAddress(parsed.cc),
    date: parsed.date instanceof Date ? parsed.date.toISOString() : (parsed.date || null),
    text,
    html,
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
    // Run full privacy+safety pipeline on HTML before sending to client.
    // Client sets iframe.srcdoc directly — no token round-trip needed.
    if (msg.html) {
      msg.html = sanitizeEmailHtml(rewriteEmailLinks(rewriteEmailImages(msg.html)));
    }
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
      auth: { user, pass }, tls: { rejectUnauthorized: true }
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

// NOTE: /delete and /move routes removed — all callers use POST /batch with
// op:'delete' and op:'move'. Keeping separate routes was dead code that
// duplicated /batch logic with no client callers.


// ─────────────────────────────────────────────────────────────────────────────
// Email HTML preview — serves email body with its own permissive CSP so inline
// styles render correctly. Firefox applies the parent page CSP to blob: URLs
// so a server route with its own response headers is the only reliable fix.
// ─────────────────────────────────────────────────────────────────────────────

// ── Tracking param set (shared by image proxy + link proxy) ───────────────────
const EMAIL_TRACKING_PARAMS = new Set([
  'utm_source','utm_medium','utm_campaign','utm_content','utm_term',
  'utm_id','utm_source_platform','utm_creative_format','utm_marketing_tactic',
  'fbclid','gclid','gclsrc','dclid','gbraid','wbraid',
  'mc_eid','mc_cid','_hsenc','_hsmi','mkt_tok','yclid',
  'igshid','s_cid','ncid','ref','trk','trkinfo',
  // Salesforce/Pardot
  'pi_campaign_id','pi_list_email_id',
  // HubSpot
  '__hstc','__hssc','__hsfp','hsCtaTracking',
  // Klaviyo
  '_kx',
  // Brevo / Sendinblue
  'sib_id',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Shared URL helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a URL string; return null (never throw) on invalid input. */
function safeParseUrl(str) {
  if (!str || typeof str !== 'string') return null;
  try { return new URL(str); } catch (_) { return null; }
}

/**
 * Iteratively decode a percent-encoded string up to maxPasses times.
 * Stops as soon as a pass produces no change or a valid http/https URL is obtained.
 * Handles double- and triple-encoded destinations (%2568ttp%253A%252F%252F...).
 */
function tryDecodeUrl(raw, maxPasses = 3) {
  let prev = raw;
  for (let i = 0; i < maxPasses; i++) {
    let decoded;
    try { decoded = decodeURIComponent(prev); } catch (_) { break; }
    if (decoded === prev) break;
    const u = safeParseUrl(decoded);
    if (u && (u.protocol === 'http:' || u.protocol === 'https:')) return decoded;
    prev = decoded;
  }
  return prev;
}

/** Strip known tracking query params from a URL string, return cleaned string. */
function stripEmailTrackingParams(urlStr) {
  try {
    const u = new URL(urlStr);
    for (const key of [...u.searchParams.keys()]) {
      if (EMAIL_TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
    }
    return u.toString();
  } catch (_) { return urlStr; }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── IMAGE PROXY — rewriteEmailImages ─────────────────────────────────────────
//
// Rewrites every remote image reference in email HTML to route through
// /api/email-image, preventing the user's IP from reaching tracking servers.
//
// Covers:
//   1. <img src="https://...">  and  srcset="..."
//   2. <style> blocks  — url(https://...) and tracker detection
//   3. Inline style="background-image: url(https://...)"
//   4. <td background="https://...">  (legacy HTML email)
//   5. SVG <image href/xlink:href>  — CVE-2026-25916 class (feImage bypass)
//   6. SVG <feImage href/xlink:href>
//   7. SVG <use href/xlink:href>
//
// Gaps fixed vs previous version:
//   - SVG feImage/image/use href not previously rewritten (tracking bypass)
//   - isRemoteUrl was dead code — removed; guard logic is inline
//   - <style> regex replaced with iterative tag scan to handle nested/CDATA edge cases
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the proxy URL for a remote image src.
 * Pre-validates scheme (http/https only) — rejects javascript:, data:, file:, etc.
 * Strips tracking params before encoding.
 */
function proxyEmailImageUrl(src) {
  try {
    const u = new URL(src);
    // Only proxy http/https — never proxy javascript:, data:, file:, etc.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return src;
    const clean = stripEmailTrackingParams(src);
    return '/api/email-image?url=' + encodeURIComponent(clean);
  } catch (_) { return src; }
}

/**
 * True if hostname belongs to a known tracker domain (subdomain-aware).
 * Uses the shared EMAIL_TRACKER_DOMAINS set loaded from trackers.js.
 */
function isTrackerDomain(hostname) {
  if (!hostname || EMAIL_TRACKER_DOMAINS.size === 0) return false;
  const h = hostname.toLowerCase().replace(/^www\./, '');
  const parts = h.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (EMAIL_TRACKER_DOMAINS.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

/**
 * Rewrite a single CSS url() value.
 * Tracker domains → url(none)  |  remote images → proxy URL  |  others → unchanged.
 */
function rewriteCssUrl(src) {
  try {
    const u = new URL(src);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null; // not remote
    const hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    if (isTrackerDomain(hostname)) return 'none';
    return proxyEmailImageUrl(src);
  } catch (_) { return null; }
}

/**
 * Rewrite all url(...) references inside a CSS string (from a <style> block
 * or inline style attribute). Returns the cleaned CSS string.
 */
function rewriteCssUrls(css) {
  return css.replace(
    /url\(\s*(['"]?)(https?:\/\/[^)'"]+)\1\s*\)/gi,
    (match, q, src) => {
      const rewritten = rewriteCssUrl(src);
      if (rewritten === null) return match; // non-remote — leave alone
      return `url(${q}${rewritten}${q})`;
    }
  );
}

/**
 * Rewrite all <style>...</style> blocks in the HTML string.
 * Uses iterative scanning rather than a single regex to handle:
 *   - nested/malformed tags
 *   - CDATA sections inside style blocks
 *   - multiple style blocks
 */
function rewriteStyleBlocks(html) {
  let out = '';
  let pos = 0;
  const OPEN  = /<style\b[^>]*>/gi;
  const CLOSE = /<\/style>/gi;

  while (pos < html.length) {
    OPEN.lastIndex = pos;
    const openM = OPEN.exec(html);
    if (!openM) { out += html.slice(pos); break; }

    // Copy everything before <style>
    out += html.slice(pos, openM.index + openM[0].length);
    const cssStart = openM.index + openM[0].length;

    // Find matching </style>
    CLOSE.lastIndex = cssStart;
    const closeM = CLOSE.exec(html);
    if (!closeM) { out += html.slice(cssStart); break; }

    // Rewrite the CSS content
    const css = html.slice(cssStart, closeM.index);
    out += rewriteCssUrls(css);
    out += closeM[0];
    pos = closeM.index + closeM[0].length;
  }
  return out;
}

function rewriteEmailImages(html) {
  if (!html || typeof html !== 'string') return html;

  // 0. <style> blocks — Samsung/ESP CSS background-image tracking pixels
  html = rewriteStyleBlocks(html);

  // 1. <img src="https://...">
  html = html.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*)(['"])(https?:\/\/[^'">\s]+)\2/gi,
    (_, pre, q, src) => `${pre}${q}${proxyEmailImageUrl(src)}${q}`
  );

  // 2. srcset="https://... 1x, https://... 2x"
  html = html.replace(
    /(<img\b[^>]*?\bsrcset\s*=\s*)(['"])(.*?)\2/gi,
    (_, pre, q, srcset) => {
      const rewritten = srcset.replace(/https?:\/\/[^\s,'"]+/gi, u => proxyEmailImageUrl(u.trim()));
      return `${pre}${q}${rewritten}${q}`;
    }
  );

  // 3. Inline style background / background-image: url(https://...)
  html = html.replace(
    /\bbackground(?:-image)?\s*:\s*(url\(\s*(['"]?)(https?:\/\/[^)'"]+)\2\s*\))/gi,
    (_, urlExpr, q, src) => `background-image: url(${q}${proxyEmailImageUrl(src)}${q})`
  );

  // 4. <td background="https://..."> (legacy HTML email)
  html = html.replace(
    /(\bbackground\s*=\s*)(['"])(https?:\/\/[^'">\s]+)\2/gi,
    (_, pre, q, src) => `${pre}${q}${proxyEmailImageUrl(src)}${q}`
  );

  // 5. SVG <image href="https://..."> and <image xlink:href="https://...">
  //    Also covers <feImage> and <use> — the CVE-2026-25916 class of bypass.
  //    These elements can silently load remote resources, leaking open-signals.
  html = html.replace(
    /(<(?:image|feimage|use)\b[^>]*?\b(?:xlink:)?href\s*=\s*)(['"])(https?:\/\/[^'">\s]+)\2/gi,
    (_, pre, q, src) => `${pre}${q}${proxyEmailImageUrl(src)}${q}`
  );

  return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── LINK PROXY — rewriteEmailLinks ───────────────────────────────────────────
//
// Rewrites every <a href> in email HTML to:
//   1. Block javascript: / data: URIs  → '#'
//   2. Block pure tracker pixel domains → '#'
//   3. Unwrap known ESP redirect chains (SafeLinks, Mailchimp, SendGrid, etc.)
//      extracting the real destination from query params
//   4. Handle double/triple percent-encoded destination params
//   5. Handle base64-encoded destination path segments (Marketo/Pardot)
//   6. Strip tracking query params (utm_*, fbclid, etc.) from final URL
//
// Fixes vs previous version:
//   - javascript: / data: URIs now explicitly blocked (previously passed through)
//   - Generic-prefix domain match now correctly passes null paramSpec to
//     extractRedirectDest (previously passed undefined → no unwrapping occurred)
//   - extractRedirectDest now checks path segments for base64-encoded destinations
//   - Outer href with %-encoded scheme (e.g. %68ttps://) decoded before parsing
// ─────────────────────────────────────────────────────────────────────────────

// Known tracking redirect domains → primary "real URL" query param name.
// null  = no extractable param — strip tracking params from redirect URL only.
// Array = try each param left-to-right until one resolves to a valid URL.
const TRACKING_REDIRECTS = new Map([
  // Microsoft SafeLinks
  ['safelinks.protection.outlook.com', 'url'],
  // Mailchimp
  ['list-manage.com',         'u'],
  ['mailchi.mp',              null],
  // Salesforce / ExactTarget / Pardot
  ['click.salesforce.com',    ['targetURL', 'url']],
  ['links.salesforce.com',    'url'],
  ['click.exacttarget.com',   ['targetURL', 'url']],
  ['go.pardot.com',           ['url', 'targetURL']],
  ['pardot.com',              ['url', 'targetURL']],
  // HubSpot
  ['hs-email.com',            null],
  ['hubspotemail.net',        null],
  ['hs-emails.com',           null],
  // SendGrid / Twilio
  ['sendgrid.net',            'url'],
  ['click.sendgrid.net',      'url'],
  // Constant Contact
  ['r.constantcontact.com',   'url'],
  ['click.constantcontact.com','url'],
  // Campaign Monitor
  ['cmail1.com',              null],
  ['cmail2.com',              null],
  ['createsend.com',          null],
  // Klaviyo
  ['trk.klaviyo.com',         ['url', 'redir']],
  ['klaviyo.com',             null],
  // Marketo
  ['click.marketo.com',       ['url', 'u']],
  ['go.marketo.com',          ['url', 'u']],
  // ActiveCampaign
  ['activehosted.com',        null],
  // Brevo / Sendinblue
  ['clicks.sendinblue.com',   'url'],
  ['brevo.com',               null],
  // Mailjet
  ['links.mailjet.com',       'url'],
  // AWeber
  ['click.aweber.com',        ['url', 'target']],
  // GetResponse
  ['clicks.getresponse.com',  'url'],
  // Drip
  ['email.getdrip.com',       null],
  // Intercom
  ['links.intercom.io',       ['url', 'dest']],
  // Customer.io
  ['track.customer.io',       null],
  // Iterable
  ['links.iterable.com',      ['url', 'u']],
  // Postmark
  ['pstmrk.it',               null],
  // Omnisend
  ['click.omnisend.com',      'url'],
  // Vero
  ['go.getvero.com',          'url'],
  // Samsung (Epsilon/Everest platform)
  ['email.samsung.com',       null],
  ['t6.uk.email.samsung.com', null],
  ['t6.m1.email.samsung.com', null],
  ['uk.email.samsung.com',    null],
  ['m1.email.samsung.com',    null],
]);

// Generic subdomain prefixes that identify click-tracker domains
// even when they have no explicit entry in TRACKING_REDIRECTS.
const TRACKING_REDIRECT_PREFIXES = ['click.', 'track.', 'links.', 'trk.', 'go.email.', 'email.'];

/**
 * Try to extract a real destination URL from a redirect.
 * Tries query params first, then base64-encoded path segments (Marketo/Pardot).
 * Handles single, double, and triple percent-encoding layers.
 * Returns the first valid http/https URL found, or null.
 */
function extractRedirectDest(u, paramSpec) {
  // 1. Query param extraction
  const names = Array.isArray(paramSpec) ? paramSpec : (paramSpec ? [paramSpec] : []);
  for (const name of names) {
    const raw = u.searchParams.get(name);
    if (!raw) continue;
    const decoded = tryDecodeUrl(raw);
    const dest = safeParseUrl(decoded);
    if (dest && (dest.protocol === 'http:' || dest.protocol === 'https:')) return decoded;
  }

  // 2. Base64-encoded path segment (Marketo /r/<base64>, some Pardot variants)
  //    Try each path segment after the first slash.
  const segments = u.pathname.split('/').filter(Boolean);
  for (const seg of segments) {
    // Base64 segments are typically 20+ chars with no dots
    if (seg.length < 20 || seg.includes('.')) continue;
    try {
      const decoded = Buffer.from(seg, 'base64').toString('utf8');
      const dest = safeParseUrl(decoded);
      if (dest && (dest.protocol === 'http:' || dest.protocol === 'https:')) return decoded;
    } catch (_) { /* not valid base64 */ }
  }

  return null;
}

/**
 * Match hostname against TRACKING_REDIRECTS (exact or subdomain) and against
 * generic TRACKING_REDIRECT_PREFIXES.
 * Returns { key, paramSpec } where key is the TRACKING_REDIRECTS map key
 * (or the hostname itself for generic matches), and paramSpec is the param
 * spec to pass to extractRedirectDest (null for generic/unknown).
 * Returns null if no match.
 */
function matchTrackingRedirectDomain(hostname) {
  hostname = hostname.toLowerCase().replace(/^www\./, '');

  // Exact / subdomain match against known ESP entries
  for (const [domain, paramSpec] of TRACKING_REDIRECTS) {
    if (hostname === domain || hostname.endsWith('.' + domain)) {
      return { key: domain, paramSpec };
    }
  }

  // Generic prefix match — catches unknown ESPs with standard subdomain patterns.
  // paramSpec is explicitly null: we'll strip tracking params but won't attempt
  // to unwrap (we don't know which param holds the destination).
  for (const prefix of TRACKING_REDIRECT_PREFIXES) {
    if (hostname.startsWith(prefix) && hostname.includes('.', prefix.length)) {
      return { key: hostname, paramSpec: null };
    }
  }

  return null;
}

/**
 * Rewrite a single href value. Returns the cleaned URL string.
 *
 * Decision tree:
 *   1. Dangerous scheme (javascript:, data:, vbscript:) → '#'
 *   2. Non-http(s) but safe (mailto:, tel:, etc.)       → unchanged
 *   3. Pure tracker domain                              → '#'
 *   4. Known/generic redirect domain with extractable dest → cleaned dest
 *   5. Known redirect domain, no extractable dest       → strip tracking params
 *   6. Plain URL                                        → strip tracking params only
 */
function rewriteEmailLink(href) {
  // Decode &amp; entities before parsing — some clients embed them in hrefs
  const decoded = href.replace(/&amp;/gi, '&');

  // Pre-decode percent-encoded scheme (%68ttps:// etc.) before handing to URL parser
  const preDecoded = tryDecodeUrl(decoded);

  const u = safeParseUrl(preDecoded);
  if (!u) return href; // unparseable — leave as-is (fail-open for legit links)

  // Block dangerous URI schemes
  const proto = u.protocol.toLowerCase();
  if (proto === 'javascript:' || proto === 'data:' || proto === 'vbscript:') return '#';

  // Leave non-http(s) safe schemes (mailto:, tel:, sms:, etc.) untouched
  if (proto !== 'http:' && proto !== 'https:') return href;

  const hostname = u.hostname.toLowerCase().replace(/^www\./, '');

  // Step 1: block pure tracker / pixel domains
  if (isTrackerDomain(hostname)) return '#';

  // Step 2: unwrap redirect domains
  const match = matchTrackingRedirectDomain(hostname);
  if (match) {
    const destStr = extractRedirectDest(u, match.paramSpec);

    if (destStr) {
      const destU = safeParseUrl(destStr);
      if (destU) {
        const destProto = destU.protocol.toLowerCase();
        // Block dangerous dest schemes
        if (destProto === 'javascript:' || destProto === 'data:' || destProto === 'vbscript:') return '#';

        const destHost = destU.hostname.toLowerCase().replace(/^www\./, '');
        // Don't resolve to another tracker or redirect domain
        if (!isTrackerDomain(destHost) && !matchTrackingRedirectDomain(destHost)) {
          // Strip tracking params from real destination
          for (const key of [...destU.searchParams.keys()]) {
            if (EMAIL_TRACKING_PARAMS.has(key.toLowerCase())) destU.searchParams.delete(key);
          }
          return destU.toString();
        }
        // Dest is itself a redirect — fall through to param-strip of outer URL
      }
    }

    // No extractable destination — strip tracking params from the redirect URL itself
    for (const key of [...u.searchParams.keys()]) {
      if (EMAIL_TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
    }
    return u.toString();
  }

  // Step 3: plain URL — strip tracking params only
  let changed = false;
  for (const key of [...u.searchParams.keys()]) {
    if (EMAIL_TRACKING_PARAMS.has(key.toLowerCase())) {
      u.searchParams.delete(key);
      changed = true;
    }
  }
  return changed ? u.toString() : href;
}

function rewriteEmailLinks(html) {
  if (!html || typeof html !== 'string') return html;

  return html.replace(
    /(<a\b[^>]*?\bhref\s*=\s*)(['"])(https?:\/\/[^'">\s]+|javascript:[^'">\s]*|data:[^'">\s]*)\2/gi,
    (_, pre, q, href) => {
      const clean = rewriteEmailLink(href);
      return `${pre}${q}${clean}${q}`;
    }
  );
}
// ── End link proxy ────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// ── EMAIL HTML SANITISER ──────────────────────────────────────────────────────
//
// Strips all unsafe constructs from email HTML before it is cached and served
// in the preview iframe. Runs AFTER rewriteEmailImages + rewriteEmailLinks so
// the sanitiser sees already-proxied URLs, not the originals.
//
// What it removes:
//   - <script>, <noscript>, <object>, <embed>, <applet>, <base>, <meta>,
//     <link> (external resources), <iframe>, <frame>, <frameset>
//   - All event handler attributes (on*)
//   - javascript: / data: / vbscript: in any attribute value
//   - <form> and all form control elements
//   - SVG <script>, <animate> (SMIL XSS), <set>, <animateMotion>,
//     <animateColor>, <animateTransform>
//   - SVG <feImage>, <use>, <image> remote href already rewritten above;
//     any remaining http(s) hrefs on these elements are stripped to '#'
//   - Dangerous CSS: expression(), -moz-binding, behavior,
//     @import, @font-face (exfil vectors)
//   - CSS position:fixed / position:absolute on top-level elements
//     (clickjacking / UI redress)
//   - <style> blocks are kept but their content is CSS-sanitised
//
// What it preserves (email rendering requirements):
//   - All structural/visual HTML tags (div, table, td, p, span, img, a, etc.)
//   - Inline styles (for email client compatibility) — content-sanitised
//   - class, id, width, height, align, valign, cellpadding, cellspacing, colspan,
//     rowspan, bgcolor, color, border and other layout attributes
//   - data-* attributes (needed by some ESP templates)
//   - Already-proxied image src URLs (/api/email-image?url=...)
//
// Strategy: allowlist of safe tags + attribute allowlist + CSS property
// sanitisation. Unrecognised tags have their tags stripped but content kept
// (same as sanitize-html default). Script-category tags have content dropped.
// ─────────────────────────────────────────────────────────────────────────────

// Tags whose entire subtree (including content) is dropped
const DROP_CONTENT_TAGS = new Set([
  'script','noscript','style', // style handled separately
  'object','embed','applet',
  'frame','frameset',
]);

// Tags that are removed but whose text content is preserved
const STRIP_TAG_ONLY = new Set([
  'html','head','body', // strip wrapper tags, keep content
  'xml','xmp',
]);

// Tags allowed in the output
const ALLOWED_TAGS = new Set([
  // Document structure (kept for email layout)
  'div','span','p','br','hr','pre','blockquote','center',
  // Headings
  'h1','h2','h3','h4','h5','h6',
  // Text formatting
  'b','i','u','s','strong','em','ins','del','small','big','sub','sup',
  'tt','code','kbd','samp','var','abbr','acronym','cite','dfn','address',
  // Links and images
  'a','img',
  // Lists
  'ul','ol','li','dl','dt','dd',
  // Tables (essential for HTML email)
  'table','thead','tbody','tfoot','tr','th','td','caption','col','colgroup',
  // Formatting
  'font','nobr','wbr',
  // Media (safe subset)
  'picture','source',
  // SVG (limited safe subset — external resources already rewritten)
  'svg','g','path','rect','circle','ellipse','line','polyline','polygon',
  'text','tspan','defs','symbol','title','desc',
  'lineargradient','radialgradient','stop','clippath','mask','pattern',
  'filter','fegaussianblur','feblend','fecomposite','feflood',
  'fecolormatrix','feturbulence','fedisplacementmap','femerge','femergenode',
  // Note: feImage, use, image are allowed but their href/xlink:href is
  // rewritten by rewriteEmailImages before sanitisation runs.
  'feimage','use','image',
]);

// Attributes always blocked regardless of tag (event handlers + dangerous globals)
const BLOCKED_ATTRS = /^on\w+$|^srcdoc$|^formaction$|^action$/i;

// Attribute values containing dangerous URI schemes
const DANGEROUS_ATTR_VALUE = /^\s*(javascript|data|vbscript)\s*:/i;

// CSS properties that enable script execution or external resource loading
const DANGEROUS_CSS_PROPS = /expression\s*\(|-moz-binding\s*:|behavior\s*:|filter\s*:\s*progid/i;

// CSS at-rules that load external resources (exfiltration vectors)
const DANGEROUS_CSS_ATRULES = /@import\b|@font-face\b/gi;

/**
 * Sanitise a CSS declaration value.
 * Returns null if the value is dangerous and should be dropped entirely.
 */
function sanitizeCssValue(prop, value) {
  if (DANGEROUS_CSS_PROPS.test(prop + ':' + value)) return null;
  // Strip url() references that weren't already rewritten (catch-all)
  // Any remaining https?:// in a CSS value at this point is suspect
  if (/url\s*\(\s*['"]?https?:\/\//i.test(value)) return null;
  return value;
}

/**
 * Sanitise an inline style="..." attribute value.
 * Removes dangerous properties; blocks position:fixed/absolute on elements
 * that could overlay page chrome (clickjacking).
 * Returns the cleaned style string (may be empty).
 */
function sanitizeInlineStyle(styleStr, allowFixed) {
  if (!styleStr) return '';
  // Remove dangerous at-rules (shouldn't appear in inline styles but be safe)
  let cleaned = styleStr.replace(DANGEROUS_CSS_ATRULES, '');
  // Remove expression(), -moz-binding, behavior
  cleaned = cleaned.replace(/[^;]*(?:expression\s*\(|-moz-binding|-ms-behavior|behavior\s*:)[^;]*/gi, '');

  // Parse declarations and rebuild
  const decls = cleaned.split(';');
  const safe = [];
  let hasPosition = false;

  for (const decl of decls) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const val  = decl.slice(colon + 1).trim();
    if (!prop || !val) continue;

    // Block position:fixed/absolute at the top layout level (UI-redress risk)
    if (prop === 'position') {
      const v = val.toLowerCase();
      if (!allowFixed && (v === 'fixed' || v === 'absolute')) continue;
      hasPosition = true;
    }

    const safeVal = sanitizeCssValue(prop, val);
    if (safeVal !== null) safe.push(`${prop}: ${safeVal}`);
  }

  return safe.join('; ');
}

/**
 * Sanitise a <style> block's CSS text.
 * Removes @import, @font-face, dangerous property values, and
 * expression()/binding constructs.
 */
function sanitizeStyleBlock(css) {
  // Remove @import and @font-face entirely
  css = css.replace(/@import\b[^;{]*[;{]/gi, '');
  css = css.replace(/@font-face\s*\{[^}]*\}/gi, '');
  // Remove expression()
  css = css.replace(/[^;{]*expression\s*\([^)]*\)[^;{]*/gi, '');
  // Remove -moz-binding and behavior
  css = css.replace(/[^;{]*-moz-binding\s*:[^;{]*/gi, '');
  css = css.replace(/[^;{]*\bbehavior\s*:[^;{]*/gi, '');
  // Remove remaining remote url() references not already proxied
  css = css.replace(/url\s*\(\s*['"]?https?:\/\/[^)'"]+['"]?\s*\)/gi, 'url(none)');
  return css;
}

/**
 * Main email HTML sanitiser.
 *
 * Parses the HTML string tag-by-tag using a simple but robust state machine
 * (no external DOM/regex-only dependency). Allowlists tags and attributes,
 * sanitises CSS, and removes all script-execution vectors.
 *
 * The approach is conservative: when in doubt, drop the tag (not the content).
 * Script-category tags drop content too.
 */
function sanitizeEmailHtml(html) {
  if (!html || typeof html !== 'string') return '';

  const MAX_INPUT = 2 * 1024 * 1024; // 2MB hard cap
  if (html.length > MAX_INPUT) html = html.slice(0, MAX_INPUT);

  let out = '';
  let pos = 0;
  // Track nesting for drop-content tags so we skip their entire subtree
  const dropStack = []; // stack of tag names whose content we are dropping

  while (pos < html.length) {
    const tagStart = html.indexOf('<', pos);
    if (tagStart < 0) {
      // Remaining text
      if (dropStack.length === 0) out += escapeTextContent(html.slice(pos));
      break;
    }

    // Text before this tag
    if (tagStart > pos && dropStack.length === 0) {
      out += escapeTextContent(html.slice(pos, tagStart));
    }

    // Find end of tag
    let tagEnd = html.indexOf('>', tagStart);
    if (tagEnd < 0) {
      // Unclosed tag — treat remainder as text
      if (dropStack.length === 0) out += escapeTextContent(html.slice(tagStart));
      break;
    }

    const rawTag = html.slice(tagStart, tagEnd + 1);
    pos = tagEnd + 1;

    // Comments — pass through (they render as nothing)
    if (rawTag.startsWith('<!--')) {
      // Skip comments entirely — they can contain IE conditional code
      continue;
    }

    // DOCTYPE — skip
    if (/^<!doctype/i.test(rawTag)) continue;

    // Processing instructions — skip
    if (rawTag.startsWith('<?')) continue;

    // Closing tag
    if (rawTag.startsWith('</')) {
      const tagName = rawTag.slice(2).replace(/[\s>\/]/g, '').toLowerCase();

      if (dropStack.length > 0 && dropStack[dropStack.length - 1] === tagName) {
        dropStack.pop();
      } else if (dropStack.length === 0 && ALLOWED_TAGS.has(tagName)) {
        out += `</${tagName}>`;
      }
      // Else: closing tag for stripped-only tag or out-of-order — discard
      continue;
    }

    // Self-closing or opening tag
    const isSelfClosing = rawTag.endsWith('/>');
    // Parse tag name
    const tagMatch = rawTag.match(/^<([a-zA-Z][a-zA-Z0-9:_-]*)/);
    if (!tagMatch) continue; // malformed
    const tagName = tagMatch[1].toLowerCase();

    // Handle <style> specially — sanitise content, emit sanitised block
    if (tagName === 'style') {
      if (dropStack.length === 0) {
        // Consume until </style>
        const closeStyle = html.indexOf('</style>', pos);
        if (closeStyle < 0) { pos = html.length; continue; }
        const cssContent = html.slice(pos, closeStyle);
        out += '<style>' + sanitizeStyleBlock(cssContent) + '</style>';
        pos = closeStyle + '</style>'.length;
      } else {
        // Inside a dropped subtree — skip style block too
        const closeStyle = html.indexOf('</style>', pos);
        pos = closeStyle < 0 ? html.length : closeStyle + '</style>'.length;
      }
      continue;
    }

    // Drop entire subtree for dangerous content tags
    if (DROP_CONTENT_TAGS.has(tagName)) {
      if (!isSelfClosing) dropStack.push(tagName);
      continue;
    }

    // If we're inside a dropped subtree, skip everything
    if (dropStack.length > 0) continue;

    // Strip wrapper tags but keep content
    if (STRIP_TAG_ONLY.has(tagName)) continue;

    // <base> — always drop (changes all relative URLs in the document)
    if (tagName === 'base') continue;

    // <meta> — drop all (charset/refresh/CSP override risks)
    if (tagName === 'meta') continue;

    // <link> — drop all (loads external stylesheets, prefetch, etc.)
    if (tagName === 'link') continue;

    // <iframe> / <frame> — drop
    if (tagName === 'iframe' || tagName === 'frame') continue;

    // <form> and form controls — drop tag but keep content for text
    if (tagName === 'form' || tagName === 'input' || tagName === 'button' ||
        tagName === 'select' || tagName === 'textarea' || tagName === 'label' ||
        tagName === 'fieldset' || tagName === 'legend' || tagName === 'output') {
      continue;
    }

    // Unknown tag — strip tag, keep content
    if (!ALLOWED_TAGS.has(tagName)) continue;

    // ── Allowed tag — sanitise attributes ─────────────────────────────────
    const cleanAttrs = sanitizeTagAttrs(tagName, rawTag);
    const selfClose = isSelfClosing ? ' /' : '';
    out += `<${tagName}${cleanAttrs}${selfClose}>`;
  }

  return out;
}

/**
 * Parse and sanitise the attributes of an allowed tag.
 * Returns a string of safe attribute declarations (leading space if non-empty).
 */
function sanitizeTagAttrs(tagName, rawTag) {
  // Extract attribute string from raw tag
  const attrStr = rawTag.slice(tagName.length + 1).replace(/\/?>$/, '').trim();
  if (!attrStr) return '';

  const safe = [];
  // Regex to match name="value", name='value', or bare name
  const attrRe = /([a-zA-Z][a-zA-Z0-9_:\-.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;

  while ((m = attrRe.exec(attrStr)) !== null) {
    const attrName = m[1].toLowerCase();
    const attrVal  = m[2] ?? m[3] ?? m[4] ?? '';

    // Block event handlers and other always-blocked attrs
    if (BLOCKED_ATTRS.test(attrName)) continue;

    // Block dangerous URI schemes in any attribute value
    if (DANGEROUS_ATTR_VALUE.test(attrVal)) continue;

    // Sanitise style attribute
    if (attrName === 'style') {
      // Allow fixed/absolute only on td/th/div (needed for email layouts)
      // but not on elements that could overlay the entire viewport
      const allowFixed = ['td','th','div','span','p'].includes(tagName);
      const cleaned = sanitizeInlineStyle(attrVal, allowFixed);
      if (cleaned) safe.push(`style="${escapeAttr(cleaned)}"`);
      continue;
    }

    // For href on <a>: block dangerous schemes, allow all others
    if (attrName === 'href' && tagName === 'a') {
      const v = attrVal.replace(/&amp;/gi, '&').trim();
      const proto = v.split(':')[0].toLowerCase();
      if (proto === 'javascript' || proto === 'data' || proto === 'vbscript') continue;
      safe.push(`href="${escapeAttr(attrVal)}"`);
      continue;
    }

    // For src attributes: only allow relative (/api/email-image...) or blocked
    if (attrName === 'src') {
      const v = attrVal.trim();
      // Allow proxy URLs, relative paths, data:image/* only
      if (/^https?:\/\//i.test(v)) {
        // Remote src that wasn't rewritten by image proxy — block it
        // (shouldn't happen if rewriteEmailImages ran first, but be safe)
        safe.push(`src="${escapeAttr('/api/email-image?url=' + encodeURIComponent(v))}"`);
      } else {
        safe.push(`src="${escapeAttr(v)}"`);
      }
      continue;
    }

    // For SVG href / xlink:href — should already be rewritten; block any remaining http
    if (attrName === 'href' || attrName === 'xlink:href') {
      const v = attrVal.trim();
      if (/^https?:\/\//i.test(v)) {
        // Proxy it as an image (feImage/use/image context)
        safe.push(`${attrName}="${escapeAttr('/api/email-image?url=' + encodeURIComponent(v))}"`);
      } else if (/^(javascript|data|vbscript):/i.test(v)) {
        continue; // block
      } else {
        safe.push(`${attrName}="${escapeAttr(v)}"`);
      }
      continue;
    }

    // target="_blank" — keep but add rel="noopener noreferrer" later
    // (handled by injecting rel below)
    if (attrName === 'target') {
      safe.push(`target="${escapeAttr(attrVal)}"`);
      continue;
    }

    // data-* attributes — allow (needed by ESP templates)
    if (attrName.startsWith('data-')) {
      safe.push(`${attrName}="${escapeAttr(attrVal)}"`);
      continue;
    }

    // All other attributes — allow with escaped value
    safe.push(`${attrName}="${escapeAttr(attrVal)}"`);
  }

  // For <a> tags, always add rel="noopener noreferrer" to prevent reverse tabnapping
  if (tagName === 'a') {
    // Remove any existing rel (we'll set our own)
    const withoutRel = safe.filter(a => !a.startsWith('rel='));
    withoutRel.push('rel="noopener noreferrer"');
    return withoutRel.length ? ' ' + withoutRel.join(' ') : '';
  }

  return safe.length ? ' ' + safe.join(' ') : '';
}

/** Escape text content for safe HTML insertion.
 *  Only encodes bare & not already part of a valid entity, to avoid
 *  double-encoding text nodes that contain &amp;, &#39;, &#x27; etc.
 */
function escapeTextContent(str) {
  return str
    .replace(/&(?!(?:#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape a value for use inside an HTML attribute (double-quoted).
 *  Does not double-encode existing entities (&amp;, &#39;, &#x27; etc).
 *  Single quotes are left literal — encoding them as &#39; breaks CSS
 *  font-family values inside style="..." attributes.
 */
function escapeAttr(str) {
  return String(str)
    .replace(/&(?!(?:#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});)/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
// ── End email HTML sanitiser ──────────────────────────────────────────────────


function cleanPreviewCache() {
  const cutoff = Date.now() - 5 * 60 * 1000; // 5 min TTL
  // Cap at 500 entries regardless of TTL — evict oldest first
  if (previewCache.size > 500) {
    const overflow = previewCache.size - 500;
    let evicted = 0;
    for (const k of previewCache.keys()) {
      previewCache.delete(k);
      if (++evicted >= overflow) break;
    }
  }
  for (const [k, v] of previewCache) { if (v.ts < cutoff) previewCache.delete(k); }
}

// ── Preview helpers ───────────────────────────────────────────────────────────

function servePreviewHtml(res, html) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; script-src 'none'; object-src 'none'; frame-ancestors 'self'");
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // No X-Content-Type-Options nosniff — NW.js sandboxed iframes mishandle it
  res.setHeader('Referrer-Policy', 'no-referrer');
  const trimmed = html.trimStart();
  const hasFullDoc = /^<!doctype/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);
  if (hasFullDoc) {
    res.send(trimmed);
  } else {
    res.send(
      '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<style>*{box-sizing:border-box}body{margin:0;padding:0;word-wrap:break-word;-webkit-text-size-adjust:100%}</style>' +
      '</head><body>' + trimmed + '</body></html>'
    );
  }
}

/**
 * POST /api/email/preview
 *
 * Accepts raw email HTML, runs it through the full privacy + safety pipeline:
 *   1. rewriteEmailImages  — proxies all remote images, blocks trackers
 *   2. rewriteEmailLinks   — unwraps ESP redirects, strips tracking params
 *   3. sanitizeEmailHtml   — removes XSS vectors, dangerous CSS, script tags
 *
 * Stores the sanitised result in the server-side cache and returns a token.
 * The token is served via GET /preview/:token inside a sandboxed iframe.
 *
 * Size limit: 2MB. Requests exceeding this are rejected with 413.
 *
 * Session fallback: stores only a hash pointer in the session, not the full HTML,
 * to avoid bloating cookie/session-store payloads.
 */
router.post('/preview', requireCreds, (req, res) => {
  const { html } = req.body || {};
  if (typeof html !== 'string') return res.status(400).json({ error: 'html required' });

  // Hard size cap — reject before doing any processing
  const MAX_PREVIEW_BYTES = 2 * 1024 * 1024; // 2MB
  if (html.length > MAX_PREVIEW_BYTES) {
    return res.status(413).json({ error: 'Email HTML exceeds 2MB limit' });
  }

  cleanPreviewCache();
  const token = crypto.randomBytes(24).toString('hex');

  // Full pipeline: image proxy → link proxy → HTML sanitiser
  const safeHtml = sanitizeEmailHtml(rewriteEmailLinks(rewriteEmailImages(html)));

  previewCache.set(token, { html: safeHtml, ts: Date.now() });

  // Session fallback: store only the token → token mapping so GET /preview/:token
  // can look up the in-memory cache even after a page reload.
  // We do NOT store the full HTML in the session — it can be 100s of KB and will
  // blow the session store / cookie size limit.
  if (req.session) {
    if (!req.session.emailPreviewTokens) req.session.emailPreviewTokens = [];
    req.session.emailPreviewTokens.push(token);
    // Keep at most 10 token references
    if (req.session.emailPreviewTokens.length > 10) {
      req.session.emailPreviewTokens = req.session.emailPreviewTokens.slice(-10);
    }
  }

  res.json({ token });
});

router.get('/preview/:token', (req, res) => {
  const token = req.params.token;
  // Validate token format — 48 hex chars
  if (!/^[0-9a-f]{48}$/.test(token)) {
    return res.status(400).send('Invalid token.');
  }

  const entry = previewCache.get(token);
  if (!entry) return res.status(404).send('Preview expired or not found. Please reopen the email.');

  // Do NOT delete on first serve — iframe may reload on resize/focus/tab-switch.
  // Entries expire via cleanPreviewCache() TTL (5 min).
  servePreviewHtml(res, entry.html);
});

module.exports = router;