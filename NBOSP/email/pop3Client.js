'use strict';
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


module.exports = { pop3Messages, pop3Message };
