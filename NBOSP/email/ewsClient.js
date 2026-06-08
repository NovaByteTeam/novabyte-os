'use strict';
const https = require('https');
const http = require('http');
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
  const safeFolderId = escapeXmlAttr(folder);
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
    <t:DistinguishedFolderId Id="${safeFolderId}"/>
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
  const safeUid = escapeXmlAttr(uid);
  const soap = `
<m:GetItem>
  <m:ItemShape>
    <t:BaseShape>Default</t:BaseShape>
    <t:IncludeMimeContent>true</t:IncludeMimeContent>
  </m:ItemShape>
  <m:ItemIds><t:ItemId Id="${safeUid}"/></m:ItemIds>
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
  // Try to restore from persistent storage if session creds are missing
  if (!req.session?.emailCreds && req.session?.emailCredsEncrypted) {
    try {
      const creds = decryptCreds(req.session.emailCredsEncrypted);
      req.session.emailCreds = creds;
      if (req.session.id) {
        sessionCredentials.set(req.session.id, { creds, createdAt: Date.now() });
      }
    } catch (e) {
      // Restore failed, fall through to error
    }
  }
  
  if (!req.session?.emailCreds) {
    return res.status(401).json({ error: 'Not connected. POST /api/email/connect first.' });
  }
  next();
}

// XML escaping helper for EWS SOAP bodies
function escapeXmlAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;');
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

module.exports = { ewsReq };
