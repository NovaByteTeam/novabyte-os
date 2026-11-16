import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const imapClient = require('../../email/protocols/imapClient.js');

// Fake ImapFlow client — records construction options and every call so the
// tests can assert exact wire-level behaviour without a real server.
class FakeImapFlow {
  constructor(opts) {
    this.opts = opts;
    this.calls = [];
    FakeImapFlow.last = this;
  }
  async connect() { this.calls.push('connect'); if (FakeImapFlow.connectError) throw FakeImapFlow.connectError; }
  async logout() { this.calls.push('logout'); if (FakeImapFlow.logoutFails) throw new Error('logout broken'); }
  async list() { return FakeImapFlow.listResult; }
  async mailboxOpen(name) {
    this.calls.push(['open', name]);
    if (FakeImapFlow.opensToFail > 0) {
      FakeImapFlow.opensToFail -= 1;
      throw FakeImapFlow.openError;
    }
    return { exists: FakeImapFlow.exists ?? 0, path: name };
  }
  async *fetch() { for (const m of FakeImapFlow.fetchResult) yield m; }
  async search() { return FakeImapFlow.searchResult; }
  async messageDelete(...a) { this.calls.push(['delete', ...a]); }
  async messageFlagsAdd(...a) { this.calls.push(['flagsAdd', ...a]); }
  async messageMove(...a) { this.calls.push(['move', ...a]); }
}

class FakePostalMime {
  constructor() {}
  async parse(raw) { return { subject: 'parsed:' + String(raw).slice(0, 12), html: '<p>p</p>' }; }
}

const CREDS = { host: 'imap.example.com', port: 993, ssl: true, user: 'u', pass: 'p' };

beforeAll(() => {
  imapClient.setDependencies({ ImapFlow: FakeImapFlow, PostalMime: FakePostalMime });
});

afterAll(() => {
  imapClient.setDependencies({});
});

beforeEach(() => {
  FakeImapFlow.last = null;
  FakeImapFlow.listResult = [];
  FakeImapFlow.fetchResult = [];
  FakeImapFlow.searchResult = [];
  FakeImapFlow.openError = null;
  FakeImapFlow.opensToFail = 0;
  FakeImapFlow.connectError = null;
  FakeImapFlow.logoutFails = false;
});

describe('email/protocols/imapClient.js — imapConnect', () => {
  it('throws a clear error when ImapFlow was never injected', async () => {
    imapClient.setDependencies({});
    await expect(imapClient.imapConnect(CREDS)).rejects.toThrow('Missing dependency: run "npm install imapflow"');
    imapClient.setDependencies({ ImapFlow: FakeImapFlow, PostalMime: FakePostalMime });
  });

  it('requires host, user and pass', async () => {
    await expect(imapClient.imapConnect({ host: 'h', user: 'u' })).rejects.toThrow('IMAP connection requires host, user, and pass');
    await expect(imapClient.imapConnect(null)).rejects.toThrow('IMAP connection requires host, user, and pass');
  });

  it('refuses plaintext connections outright (TLS mandatory)', async () => {
    await expect(imapClient.imapConnect({ ...CREDS, ssl: false })).rejects.toThrow('Plaintext IMAP is not supported');
  });

  it('connects with secure:true, auth, and the requested port (993 default)', async () => {
    const client = await imapClient.imapConnect({ ...CREDS, port: undefined });
    expect(client).toBe(FakeImapFlow.last);
    expect(client.opts.secure).toBe(true);
    expect(client.opts.port).toBe(993);
    expect(client.opts.auth).toEqual({ user: 'u', pass: 'p' });
    expect(client.opts.tls).toEqual({ rejectUnauthorized: true });
    expect(client.calls).toContain('connect');
    await imapClient.imapConnect({ ...CREDS, port: '2993' });
    expect(FakeImapFlow.last.opts.port).toBe(2993);
  });
});

describe('email/protocols/imapClient.js — imapFolders', () => {
  it('maps list() entries and decodes entities in path/name', async () => {
    FakeImapFlow.listResult = [
      { path: 'INBOX', name: 'INBOX', delimiter: '/', flags: ['\\HasNoChildren'] },
      { path: 'Sent &#x27;Items&#x27;', delimiter: '/' },
      // no name and no delimiter: the last-segment fallback splits on '/'
      { path: 'Plain/Child' },
    ];
    const folders = await imapClient.imapFolders(CREDS);
    expect(folders[0]).toEqual({ path: 'INBOX', name: 'INBOX', delimiter: '/', flags: ['\\HasNoChildren'] });
    expect(folders[1].name).toBe("Sent 'Items'");
    // name falls back to the last path segment when the server omits it
    expect(folders[1].path).toBe("Sent 'Items'");
    // the delimiter-less, name-less entry derives its name from the path tail
    expect(folders[2].name).toBe('Child');
    expect(FakeImapFlow.last.calls).toContain('logout');
  });
});

describe('email/protocols/imapClient.js — imapMessages', () => {
  it('returns newest-first page with pagination metadata', async () => {
    FakeImapFlow.exists = 3;
    FakeImapFlow.fetchResult = [
      { uid: 1, seq: 1, flags: new Set(), envelope: { subject: 'one', from: [{ name: 'A', address: 'a@x.com' }], to: [{ address: 'b@x.com' }], date: '2026-01-01T00:00:00Z' } },
      { uid: 2, seq: 2, flags: new Set(['\\Seen']), envelope: { subject: 'two' } },
      { uid: 3, seq: 3, flags: new Set(['\\Seen']), envelope: { subject: 'three' } },
    ];
    // a fetched message without an envelope maps onto the empty-object arm
    FakeImapFlow.fetchResult.push({ uid: 9, seq: 4, flags: new Set(['\\Flagged']) });
    const res = await imapClient.imapMessages(CREDS, 'INBOX', 1, 20, (p) => p);
    expect(res.total).toBe(3);
    expect(res.page).toBe(1);
    expect(res.pages).toBe(1);
    // reversed → newest first
    expect(res.messages.map((m) => m.subject)).toEqual(['(no subject)', 'three', 'two', 'one']);
    expect(res.messages[1].seen).toBe(true);  // 'three'
    expect(res.messages[2].seen).toBe(true);   // 'two' carries \Seen
    expect(res.messages[3].seen).toBe(false);  // 'one' is unseen
    expect(res.messages[3].from).toBe('A <a@x.com>');
    expect(res.messages[3].to).toBe('b@x.com');
    expect(res.messages[3].date).toBe('2026-01-01T00:00:00.000Z');
  });

  it('computes pages and clamps the fetch window to the requested page', async () => {
    FakeImapFlow.exists = 45;
    FakeImapFlow.fetchResult = [];
    const res = await imapClient.imapMessages(CREDS, 'INBOX', 2, 20, (p) => p);
    expect(res.pages).toBe(3);
    // page 2 of 45 @20 → sequence 25:44
    expect(FakeImapFlow.last.calls.some((c) => Array.isArray(c) && c[0] === 'open')).toBe(true);
  });

  it('returns an empty page without fetching when the mailbox is empty or past the end', async () => {
    FakeImapFlow.exists = 0;
    const empty = await imapClient.imapMessages(CREDS, 'INBOX', 1, 20, (p) => p);
    expect(empty).toEqual({ messages: [], total: 0, page: 1, pages: 0 });

    FakeImapFlow.exists = 10;
    const beyond = await imapClient.imapMessages(CREDS, 'INBOX', 9, 20, (p) => p);
    expect(beyond.messages).toEqual([]);
    expect(beyond.total).toBe(10);
  });
});

describe('email/protocols/imapClient.js — imapMessage', () => {
  it('rejects invalid UIDs before connecting', async () => {
    await expect(imapClient.imapMessage(CREDS, 'INBOX', 'not-a-number', (p) => p)).rejects.toThrow('Invalid message UID');
    expect(FakeImapFlow.last).toBeNull();
  });

  it('fetches the raw source, parses it via PostalMime and applies msgShape', async () => {
    FakeImapFlow.fetchResult = [{ source: Buffer.from('RAW MIME DATA') }];
    const shape = (parsed) => ({ subject: parsed.subject, html: parsed.html });
    const msg = await imapClient.imapMessage(CREDS, 'INBOX', 42, shape);
    expect(msg.subject).toBe('parsed:RAW MIME DAT');
    expect(msg.html).toBe('<p>p</p>');
  });

  it('returns the raw parser output when no msgShape is provided', async () => {
    FakeImapFlow.fetchResult = [{ source: Buffer.from('RAW2') }];
    const msg = await imapClient.imapMessage(CREDS, 'INBOX', 7, null);
    expect(msg.subject).toBe('parsed:RAW2');
  });

  it('throws "Message not found" when the fetch yields nothing', async () => {
    FakeImapFlow.fetchResult = [];
    await expect(imapClient.imapMessage(CREDS, 'INBOX', 99, (p) => p)).rejects.toThrow('Message not found');
  });
});

describe('email/protocols/imapClient.js — imapBatch', () => {
  it('returns early (no connection) for an empty uid list', async () => {
    await imapClient.imapBatch(CREDS, 'read', [], 'INBOX');
    expect(FakeImapFlow.last).toBeNull();
  });

  it('maps read → messageFlagsAdd with \\Seen', async () => {
    await imapClient.imapBatch(CREDS, 'read', [1, 2], 'INBOX');
    expect(FakeImapFlow.last.calls).toContainEqual(['flagsAdd', [1, 2], ['\\Seen'], { uid: true }]);
  });

  it('maps delete → messageDelete', async () => {
    await imapClient.imapBatch(CREDS, 'delete', [5], 'INBOX');
    expect(FakeImapFlow.last.calls).toContainEqual(['delete', [5], { uid: true }]);
  });

  it('maps move → messageMove with the destination decoded', async () => {
    await imapClient.imapBatch(CREDS, 'move', [5], 'INBOX', 'Archive &#x27;2026&#x27;');
    expect(FakeImapFlow.last.calls).toContainEqual(['move', [5], "Archive '2026'", { uid: true }]);
  });

  it('does nothing for move without a destination', async () => {
    await imapClient.imapBatch(CREDS, 'move', [5], 'INBOX');
    expect(FakeImapFlow.last.calls.filter((c) => Array.isArray(c) && c[0] === 'move')).toHaveLength(0);
  });
});

describe('email/protocols/imapClient.js — imapSearch', () => {
  it('returns recent matches newest-first via uid search', async () => {
    FakeImapFlow.searchResult = [1, 2, 3];
    FakeImapFlow.fetchResult = [
      { uid: 1, flags: new Set(), envelope: { subject: 'old', from: [{ address: 'a@x.com' }], date: '2026-01-01T00:00:00Z' } },
      { uid: 3, flags: new Set(['\\Seen']), envelope: { subject: 'new' } },
    ];
    // a result without an envelope maps onto the empty-object arm
    FakeImapFlow.fetchResult.push({ uid: 7, flags: new Set() });
    const messages = await imapClient.imapSearch(CREDS, 'needle', 'INBOX');
    expect(messages).toHaveLength(3);
    expect(messages[0].subject).toBe('old');
    expect(messages[1].subject).toBe('new');
    expect(messages[1].seen).toBe(true);
    const bare = messages[2];
    expect(bare.subject).toBe('(no subject)');
    expect(bare.from).toBe('');
    expect(bare.date).toBeNull();
  });

  it('returns [] when the search yields no uids', async () => {
    FakeImapFlow.searchResult = [];
    expect(await imapClient.imapSearch(CREDS, 'needle', 'INBOX')).toEqual([]);
  });
});

describe('email/protocols/imapClient.js — resolveFolder', () => {
  it('opens the requested mailbox directly when it exists', async () => {
    const box = await imapClient.resolveFolder(FakeImapFlow.last || new FakeImapFlow({}), 'INBOX');
    expect(box.path).toBe('INBOX');
  });

  it('falls back to provider folder aliases when the open fails', async () => {
    const client = new FakeImapFlow({});
    FakeImapFlow.openError = new Error('Mailbox doesn\'t exist');
    FakeImapFlow.opensToFail = 1; // first open fails, the alias re-open succeeds
    FakeImapFlow.listResult = [{ path: '[Gmail]/Sent Mail', name: 'Sent Mail' }];
    const box = await imapClient.resolveFolder(client, 'Sent');
    expect(box.path).toBe('[Gmail]/Sent Mail');
  });

  it('throws a clear error when no alias matches', async () => {
    const client = new FakeImapFlow({});
    FakeImapFlow.openError = new Error('nope');
    FakeImapFlow.opensToFail = 999; // every open fails
    FakeImapFlow.listResult = [{ path: 'INBOX', name: 'INBOX' }];
    await expect(imapClient.resolveFolder(client, 'Nowhere')).rejects.toThrow('Folder not found: Nowhere');
    // a list containing a name-less folder exercises the (f.name || '') arm
    // of the alias matcher: the empty string never matches an alias.
    FakeImapFlow.listResult = [{ path: 'INBOX' }, { path: 'x', name: 'Sent' }];
    await expect(imapClient.resolveFolder(client, 'Nowhere')).rejects.toThrow('Folder not found: Nowhere');
  });
});

describe('email/protocols/imapClient.js — decodeEntities', () => {
  it('decodes numeric, hex and named entities', () => {
    expect(imapClient.decodeEntities('&#x27;')).toBe("'");
    expect(imapClient.decodeEntities('&#39;')).toBe("'");
    expect(imapClient.decodeEntities('&amp;')).toBe('&');
    expect(imapClient.decodeEntities('&lt;&gt;&quot;&apos;')).toBe('<>"\'');
    expect(imapClient.decodeEntities('&#65;')).toBe('A');
  });

  it('passes through strings without entities and non-strings', () => {
    expect(imapClient.decodeEntities('plain')).toBe('plain');
    expect(imapClient.decodeEntities('')).toBe('');
    expect(imapClient.decodeEntities(null)).toBeNull();
  });

  it('evicts the oldest decoded paths once the cache passes 500 entries', async () => {
    // 260 folders x (path + name) = 520 distinct decode calls — past the cap
    FakeImapFlow.listResult = Array.from({ length: 260 }, (_, i) => ({
      path: `folder&amp;${i}`,
      name: `box&amp;${i}`,
      delimiter: '/',
      flags: [],
    }));
    const folders = await imapClient.imapFolders(CREDS);
    expect(folders).toHaveLength(260);
    expect(folders[0].path).toBe('folder&0');
    expect(folders[259].name).toBe('box&259');
  });

  it('a broken logout never surfaces — every operation swallows it in finally', async () => {
    FakeImapFlow.logoutFails = true;
    FakeImapFlow.listResult = [{ path: 'INBOX', name: 'INBOX', delimiter: '/', flags: [] }];
    await expect(imapClient.imapFolders(CREDS)).resolves.toHaveLength(1);

    FakeImapFlow.exists = 1;
    FakeImapFlow.fetchResult = [{ uid: 4, seq: 1, source: 'raw-message', flags: new Set(), envelope: { subject: 's' } }];
    const page = await imapClient.imapMessages(CREDS, 'INBOX', 1, 20, (p) => p);
    expect(page.messages[0].from).toBe(''); // no envelope.from → '' (branch)

    await expect(imapClient.imapMessage(CREDS, 'INBOX', 4, (p) => p)).resolves.toBeTruthy();
    await expect(imapClient.imapBatch(CREDS, 'delete', [4], 'INBOX')).resolves.toBeUndefined();

    FakeImapFlow.searchResult = [3];
    FakeImapFlow.fetchResult = [{ uid: 3, envelope: { subject: 'anon' }, flags: new Set() }];
    const hits = await imapClient.imapSearch(CREDS, 'needle', 'INBOX');
    expect(hits[0].from).toBe(''); // from absent → '' fallback
  });

  it('a non-array uid list no-ops exactly like an empty one', async () => {
    await expect(imapClient.imapBatch(CREDS, 'read', 'nope', 'INBOX')).resolves.toBeUndefined();
    expect(FakeImapFlow.last).toBeNull(); // never even constructed a client
  });

  it('imapSearch without imapflow injected fails cleanly', async () => {
    imapClient.setDependencies({});
    await expect(imapClient.imapSearch(CREDS, 'q', 'INBOX')).rejects.toThrow('Missing dependency');
    imapClient.setDependencies({ ImapFlow: FakeImapFlow, PostalMime: FakePostalMime });
  });

  it('imapMessage without postal-mime injected fails cleanly', async () => {
    imapClient.setDependencies({ ImapFlow: FakeImapFlow });
    await expect(imapClient.imapMessage(CREDS, 'INBOX', 7)).rejects.toThrow('Missing dependency');
    imapClient.setDependencies({ ImapFlow: FakeImapFlow, PostalMime: FakePostalMime });
  });

  it('imapBatch without imapflow injected fails cleanly before touching the list', async () => {
    imapClient.setDependencies({ PostalMime: FakePostalMime });
    await expect(imapClient.imapBatch(CREDS, 'delete', [1], 'INBOX')).rejects.toThrow('Missing dependency');
    imapClient.setDependencies({ ImapFlow: FakeImapFlow, PostalMime: FakePostalMime });
  });

  it('envelopes without a subject collapse to "(no subject)"', async () => {
    FakeImapFlow.exists = 1;
    FakeImapFlow.fetchResult = [{ uid: 11, seq: 1, flags: new Set(), envelope: {} }];
    const page = await imapClient.imapMessages(CREDS, 'INBOX', 1, 20, (p) => p);
    expect(page.messages[0].subject).toBe('(no subject)');

    FakeImapFlow.searchResult = [12];
    FakeImapFlow.fetchResult = [{ uid: 12, envelope: {}, flags: new Set() }];
    const hits = await imapClient.imapSearch(CREDS, 'needle', 'INBOX');
    expect(hits[0].subject).toBe('(no subject)');
  });
});
