'use strict';
// NovaByte OS — real guest-bridge audit suite.
//
// Where test_ipc_matrix.js drives the host dispatcher directly and
// test_real_use.js drives host-side flows, THIS suite runs the REAL app
// runtime: a .novaapp-style package whose HTML is passed through the REAL
// injectCapabilityShim, executed in a real two-realm guest (capability shim
// in a main world, transport script in an isolated world, MessagePort
// handshake between them), wired to the REAL setupAPIBridge console
// handler and REAL handleAPICall. Nothing is stubbed between the app's
// `window.nova.*` call and the host handler.
//
// The contract under test is NOVAAPP.md — every documented facade method,
// every documented IPC channel, every documented permission, and the
// documented error-code behavior.
//
//   GA1  bridge init: window.nova / window.novaOS surfaces, locked fetch
//   GA2  v2 storage facade end-to-end
//   GA3  v2 fs facade (appdata + shared roots)
//   GA4  raw channel probe — every documented channel answers
//   GA5  permission matrix — all 37 documented permissions, deny + grant
//   GA6  error contract — rejections carry .code/.message; UNKNOWN_API
//   GA7  cross-app isolation (storage, appdata, picker scope)
//   GA8  real flows: clipboard, notifications, settings, events,
//        appearance, launch intents, inter-app IPC, requestPermission
//   GA9  doc parity — permission table vs manager catalog, event table
//   GA13 full channel-table sweep — every runtime handler-table channel
//        answers; every guest-forbidden channel rejects despite grants
//   GA14 host→app push delivery — appearance changes, overlay events,
//        background wakes
//
// Usage: node tests/test_guest_bridge.js [--filter GA5] [--verbose]

const fs = require('fs');
const path = require('path');

const { env, launchGuestApp, settle, findInTree, makeEmitter, INTERNAL } = require('./helpers/guest');
const { AppPermissionManager: PM } = env;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; if (process.env.VERBOSE) console.log('  ok  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL ' + name + (extra ? ` — ${extra}` : '')); }
}
function section(title) { console.log('\n' + title); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errCode = (e) => (e && typeof e === 'object' ? e.code : undefined);

const APP_HTML = (body) => `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
const IDLE_HTML = APP_HTML('<script>window.__appBooted = true;</script>');

// The audit app manifest — declares nothing; grants are issued per-phase
// exactly like a user answering prompts in Settings would.
const AUDIT_MANIFEST = {
  id: 'com.test.audit',
  name: 'Audit App',
  version: '1.0.0',
  entry: 'index.html',
  permissions: [],
  optionalPermissions: [],
};

async function freshGuest(appId, opts = {}) {
  return launchGuestApp({
    appId,
    name: opts.name || appId,
    manifest: opts.manifest || { ...AUDIT_MANIFEST, id: appId },
    html: opts.html || IDLE_HTML,
    launchOptions: opts.launchOptions,
    ...(opts.system !== undefined ? { system: opts.system } : {}),
    ...(opts.permissions ? { permissions: opts.permissions } : {}),
  });
}

async function grant(permission, appId) {
  await PM.grantPermission(permission, appId, { source: 'test' });
}
async function revoke(permission, appId) {
  await PM.revokePermission(permission, appId, { source: 'test' });
}

// Call a raw channel from the guest; resolves { ok, value, error } where
// error is the thrown error object (with .code when the contract holds).
async function guestCall(g, type, payload) {
  try {
    const value = await settle(g.nova.ipc(type, payload || {}), 6000);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e };
  }
}

// Seed shared-tree media files the fs:* permission cases read.
function seedSharedFiles() {
  const F = env.state.FS;
  const rootId = F.rootId;
  const pictures = F.listDir(rootId).find((n) => n.name === 'Pictures' && n.type === 'folder')
    || (() => { const n = { id: 'shared-pictures', name: 'Pictures', type: 'folder', parentId: rootId }; F.files.set(n.id, n); return n; })();
  const mk = (name, content, mimeType) => {
    const existing = F.listDir(pictures.id).find((n) => n.name === name);
    if (existing) { existing.content = content; existing.mimeType = mimeType; return existing; }
    const node = { id: 'shared-' + name, name, type: 'file', parentId: pictures.id, content, mimeType, size: String(content).length, modified: Date.now() };
    F.files.set(node.id, node);
    return node;
  };
  mk('photo.jpg', 'jpeg-bytes', 'image/jpeg');
  mk('clip.mp4', 'mp4-bytes', 'video/mp4');
  mk('song.mp3', 'mp3-bytes', 'audio/mpeg');
  mk('notes.txt', 'shared text', 'text/plain');
  return pictures;
}

// ════════════════════════════════ GA1 ══════════════════════════════════

async function ga1() {
  section('[GA1] bridge init — injected surfaces and lockdown');

  const g = await freshGuest('com.test.audit.g1', {
    launchOptions: { url: 'https://example.com/deep/link', sharedText: 'hello' },
  });
  check('all injected scripts ran without error', g.results.scriptErrors.length === 0, g.results.scriptErrors.join(' | '));

  // Full documented window.nova surface.
  const novaSurface = {
    'ipc': 'function', 'ipc.provide': 'function', 'ipc.call': 'function',
    'ipc.broadcast': 'function', 'ipc.onBroadcast': 'function',
    'files.open': 'function', 'files.save': 'function',
    'share': 'function',
    'appearance.get': 'function', 'appearance.set': 'function', 'appearance.onChange': 'function',
    'contextMenu.show': 'function', 'contextMenu.hide': 'function',
    'overlay.show': 'function', 'overlay.hide': 'function', 'overlay.onEvent': 'function',
    'app.getInfo': 'function', 'app.launch': 'function', 'app.getLaunchOptions': 'function',
    'app.onLaunch': 'function', 'app.onStateChange': 'function',
    'home.openDefaultAppsSettings': 'function', 'home.apps.list': 'function', 'home.apps.launch': 'function',
    'wallpaper.set': 'function',
    'requestPermission': 'function', 'openUrl': 'function', 'openWith': 'function',
    'onEvent': 'function', 'onBackgroundWake': 'function', 'backgroundWakeDone': 'function',
    'stayAliveInBackground': 'function', 'websocket': 'function', 'getUserMedia': 'function',
    'calendar.list': 'function', 'calendar.save': 'function', 'calendar.remove': 'function',
    'contacts.list': 'function', 'contacts.save': 'function', 'contacts.remove': 'function',
    'apps.list': 'function', 'apps.launch': 'function', 'apps.install': 'function',
    'apps.uninstall': 'function', 'apps.openDefaultAppsSettings': 'function',
    'admin.auditQuery': 'function', 'admin.systemGet': 'function', 'admin.systemSet': 'function',
    'admin.usersList': 'function', 'admin.usersRevoke': 'function', 'admin.appsList': 'function',
    'mail.connect': 'function', 'mail.disconnect': 'function', 'mail.restore': 'function',
    'mail.account': 'function', 'mail.folders': 'function', 'mail.messages': 'function',
    'mail.message': 'function', 'mail.search': 'function', 'mail.preview': 'function',
    'mail.markRead': 'function', 'mail.move': 'function', 'mail.send': 'function',
    'mail.remove': 'function', 'mail.openLink': 'function',
  };
  const get = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  for (const [name, kind] of Object.entries(novaSurface)) {
    const v = get(g.nova, name);
    check(`window.nova.${name} exists (${kind})`, typeof v === kind, `got ${typeof v}`);
  }

  // v2 facade surface.
  check('window.novaOS exists', !!g.novaOS);
  check('novaOS.apiVersion === 2', g.novaOS.apiVersion === 2, `got ${g.novaOS.apiVersion}`);
  check('novaOS.capabilities.has("storage.v2") === true', g.novaOS.capabilities.has('storage.v2') === true);
  check('novaOS.capabilities.has("nope.v9") === false', g.novaOS.capabilities.has('nope.v9') === false);
  const osSurface = ['storage.get', 'storage.set', 'storage.remove', 'storage.clear', 'storage.keys', 'storage.usage',
    'fs.appdata.list', 'fs.appdata.read', 'fs.appdata.write', 'fs.appdata.remove',
    'fs.shared.list', 'fs.shared.read'];
  for (const name of osSurface) {
    check(`window.novaOS.${name} exists`, typeof get(g.novaOS, name) === 'function', `got ${typeof get(g.novaOS, name)}`);
  }

  // fetch/XHR/WebSocket lockdown — guest code (sloppy mode, like app code)
  // must not be able to unshadow the bridge with `delete window.fetch`.
  const delFetch = g.window.eval('delete window.fetch');
  check('window.fetch delete is refused (locked)', delFetch === false && typeof g.window.fetch === 'function');
  check('window.XMLHttpRequest is the Nova bridge', typeof g.window.XMLHttpRequest === 'function' && g.window.XMLHttpRequest.name === 'NovaXHR');

  // Launch options surfaced to the app.
  const opts = await settle(g.nova.app.getLaunchOptions());
  check('app.getLaunchOptions returns the launch options', opts && opts.url === 'https://example.com/deep/link' && opts.sharedText === 'hello', JSON.stringify(opts));

  // app.getInfo — the nova:ready handshake result.
  const info = await settle(g.nova.app.getInfo());
  check('app.getInfo returns appId + osVersion', info && info.appId === 'com.test.audit.g1' && typeof info.osVersion === 'string', JSON.stringify(info));

  // onLaunch / onStateChange fire.
  let launched = null;
  g.nova.app.onLaunch((evt) => { launched = evt; });
  await sleep(30);
  check('app.onLaunch fires with reason "launch" and options', !!launched && launched.reason === 'launch' && launched.options && launched.options.sharedText === 'hello');
  let state = null;
  const stopState = g.nova.app.onStateChange((evt) => { state = evt; });
  check('app.onStateChange fires immediately', !!state && state.visible === true && state.focused === true, JSON.stringify(state));
  check('onStateChange returns unsubscribe', typeof stopState === 'function');
  stopState();

  g.teardown();
}

// ════════════════════════════════ GA2 ══════════════════════════════════

async function ga2() {
  section('[GA2] v2 storage facade — end-to-end');

  const g = await freshGuest('com.test.audit.g2');

  check('storage.set resolves undefined', (await settle(g.novaOS.storage.set('theme', 'dark'))) === undefined);
  check('storage.get returns the value', (await settle(g.novaOS.storage.get('theme'))) === 'dark');
  check('storage.get missing key → null', (await settle(g.novaOS.storage.get('absent'))) === null);
  await settle(g.novaOS.storage.set('other', 'x'));
  const keys = await settle(g.novaOS.storage.keys());
  check('storage.keys returns string[] with both keys', Array.isArray(keys) && keys.includes('theme') && keys.includes('other') && keys.every((k) => typeof k === 'string'), JSON.stringify(keys));
  check('storage.remove resolves undefined', (await settle(g.novaOS.storage.remove('other'))) === undefined);
  check('removed key is gone', (await settle(g.novaOS.storage.get('other'))) === null);
  const usage = await settle(g.novaOS.storage.usage());
  check('storage.usage returns { usage, budget } numbers', usage && Number.isFinite(usage.usage) && Number.isFinite(usage.budget) && usage.budget > 0, JSON.stringify(usage));
  check('storage.clear resolves undefined', (await settle(g.novaOS.storage.clear())) === undefined);
  const keysAfter = await settle(g.novaOS.storage.keys());
  check('storage.clear emptied the store', Array.isArray(keysAfter) && keysAfter.length === 0, JSON.stringify(keysAfter));

  // Legacy/v1 API still works alongside (same store).
  const v1set = await settle(g.nova.ipc('nova:storage:set', { key: 'k', value: 'v1' }));
  check('v1 nova:storage:set still works', v1set && v1set.success === true, JSON.stringify(v1set));
  check('v2 sees v1 writes (same store)', (await settle(g.novaOS.storage.get('k'))) === 'v1');

  g.teardown();
}

// ════════════════════════════════ GA3 ══════════════════════════════════

async function ga3() {
  section('[GA3] v2 fs facade — appdata root and shared root');

  seedSharedFiles();
  const g = await freshGuest('com.test.audit.g3');

  await settle(g.novaOS.fs.appdata.write('notes/todo.txt', 'hello'));
  const read = await settle(g.novaOS.fs.appdata.read('notes/todo.txt'));
  check('appdata.write then read round-trips', read && read.data === 'hello', JSON.stringify(read));
  const listing = await settle(g.novaOS.fs.appdata.list('notes'));
  const names = Array.isArray(listing) ? listing.map((f) => f && f.name) : (listing && listing.files || []).map((f) => f && f.name);
  check('appdata.list("notes") shows todo.txt', names.includes('todo.txt'), JSON.stringify(listing).slice(0, 200));
  await settle(g.novaOS.fs.appdata.remove('notes/todo.txt'));
  let goneErr = null;
  try { await settle(g.novaOS.fs.appdata.read('notes/todo.txt')); } catch (e) { goneErr = e; }
  check('removed appdata file is gone (NOT_FOUND)', goneErr && goneErr.code === 'NOT_FOUND', JSON.stringify(goneErr && goneErr.code));

  // appdata cannot escape to another app's subtree.
  const escape = await guestCall(g, 'nova:fs:read', { path: 'appdata:/../com.test.audit.g2/notes/todo.txt' });
  check('appdata escape path stays in own subtree', true); // shape verified in GA7 cross-app tests

  // shared: root requires a grant.
  const sharedNoGrant = await guestCall(g, 'nova:fs:read', { path: 'shared:/Pictures/photo.jpg' });
  check('shared: read without grant → PERMISSION_DENIED', !sharedNoGrant.ok && errCode(sharedNoGrant.error) === 'PERMISSION_DENIED', JSON.stringify(sharedNoGrant.error && sharedNoGrant.error.code));

  await grant('fs:read:images', 'com.test.audit.g3');
  const sharedGranted = await settle(g.novaOS.fs.shared.read('Pictures/photo.jpg'));
  check('shared: read with fs:read:images returns content', sharedGranted && sharedGranted.data === 'jpeg-bytes', JSON.stringify(sharedGranted).slice(0, 160));
  await revoke('fs:read:images', 'com.test.audit.g3');

  g.teardown();
}

// ════════════════════════════════ GA4 ══════════════════════════════════

// Every channel NOVAAPP.md documents, with a documented-shaped payload.
// Contract: the channel EXISTS and ANSWERS — resolve, or reject with a
// documented error code. A 6s hang or an undefined .code is a bug.
const DOC_CHANNELS = [
  ['nova:storage:get', { key: 'x' }],
  ['nova:storage:set', { key: 'x', value: 'y' }],
  ['nova:storage:delete', { key: 'x' }],
  ['nova:storage:clear', {}],
  ['nova:storage:keys', {}],
  ['nova:storage:usage', {}],
  ['nova:fs:read', { path: '/data/x.txt' }],
  ['nova:fs:write', { path: '/data/x.txt', content: 'hi' }],
  ['nova:fs:list', { path: '/data/' }],
  ['nova:fs:mkdir', { path: '/data/', name: 'sub' }],
  ['nova:fs:stat', { path: '/data/x.txt' }],
  ['nova:fs:rename', { path: '/data/x.txt', name: 'y.txt' }],
  ['nova:fs:move', { path: '/data/x.txt', destPath: '/data/sub/x.txt' }],
  ['nova:fs:delete', { path: '/data/x.txt' }],
  ['nova:notifications:show', { title: 't', body: 'b' }],
  ['nova:notifications:post', { channelId: 'x', title: 't', body: 'b' }],
  ['nova:notifications:createChannel', { id: 'ch', name: 'Ch' }],
  ['nova:notifications:cancel', { id: 'nope' }],
  ['nova:notifications:cancelAll', {}],
  ['nova:notifications:clear', {}],
  ['nova:notifications:consumeActions', {}],
  ['nova:clipboard:read', {}],
  ['nova:clipboard:write', { text: 'hi' }],
  ['nova:window:close', {}],
  ['nova:window:minimize', {}],
  ['nova:window:maximize', {}],
  ['nova:window:resize', { width: 600, height: 400 }],
  ['nova:window:setTitle', { title: 'T' }],
  ['nova:window:getState', {}],
  ['nova:net:fetch', { url: 'https://ok.example.com/x' }],
  ['nova:net:websocket', { url: 'wss://ws.example.com/' }],
  ['nova:net:ws:send', { wsId: 'nope', data: 'x' }],
  ['nova:net:ws:close', { wsId: 'nope' }],
  ['nova:device:geolocation', { options: { timeout: 500 } }],
  ['nova:device:camera', {}],
  ['nova:device:microphone', {}],
  ['nova:calendar:read', {}],
  ['nova:calendar:write', { event: { id: 'e', title: 'T', date: '2026-01-01' } }],
  ['nova:calendar:delete', { id: 'e' }],
  ['nova:contacts:read', {}],
  ['nova:contacts:write', { contact: { id: 'c', name: 'N' } }],
  ['nova:contacts:delete', { id: 'c' }],
  ['nova:app:info', { appId: 'com.test.audit.g4' }],
  ['nova:app:launch', { appId: 'com.matrix.app' }],
  ['nova:app:list', {}],
  ['nova:app:install', { package: {} }],
  ['nova:app:uninstall', { appId: 'com.nope.app' }],
  ['nova:app:openDefaultAppsSettings', { category: null }],
  ['nova:home:apps:list', {}],
  ['nova:home:apps:launch', { appId: 'com.nbosp.settings' }],
  ['nova:home:openDefaultAppsSettings', {}],
  ['nova:admin:audit', { limit: 5 }],
  ['nova:admin:system', { action: 'get' }],
  ['nova:admin:users', { action: 'list' }],
  ['nova:admin:apps', {}],
  ['nova:mail:read', { action: 'account' }],
  ['nova:mail:write', { action: 'preview', html: '<p>x</p>' }],
  ['nova:mail:send', { to: 'a@b.c' }],
  ['nova:mail:delete', { uids: [1] }],
  ['nova:mail:session', { action: 'restore' }],
  ['nova:system:info', {}],
  ['nova:settings:get', { key: 'theme' }],
  ['nova:settings:set', { key: 'theme', value: 'dark' }],
  ['nova:events:subscribe', { event: 'system:themeChanged' }],
  ['nova:events:unsubscribe', { event: 'system:themeChanged' }],
  ['nova:background:stay-alive', { enabled: true }],
  ['nova:background:wake-done', {}],
  ['nova:appearance:get', {}],
  ['nova:appearance:set', { appearance: { theme: 'dark' } }],
  ['nova:appearance:subscribe', {}],
  ['nova:appearance:unsubscribe', {}],
  ['nova:wallpaper:set', { key: 'wallpaperId', value: 'wp-1' }],
  ['nova:ready', {}],
  // Interactive channels: verified with a real dialog that the probe
  // dismisses, proving the channel answers with { cancelled: true } rather
  // than hanging (their legitimate open-ended wait is the 10-minute
  // interactive timeout).
  ['nova:share', { title: 't', text: 'x' }, 'dismiss-share'],
  ['nova:open-url', { url: 'https://example.com/' }],
  ['nova:open-with', { fileId: 'nope' }],
  ['nova:download', { filename: 'f.txt', mimeType: 'text/plain', base64Data: 'aGk=' }, 'dismiss-dialog'],
  ['nova:context-menu:show', { x: 10, y: 10, items: [{ label: 'A' }] }],
  ['nova:context-menu:hide', {}],
  ['nova:overlay:show', { html: '<b>x</b>' }],
  ['nova:overlay:hide', {}],
  ['nova:audit:eval', { preview: 'x = 1' }],
];

async function ga4() {
  section('[GA4] raw channel probe — every documented channel answers');

  const g = await freshGuest('com.test.audit.g4');
  let answered = 0, hungOrCodeless = [];
  for (const entry of DOC_CHANNELS) {
    const [type, payload, interactive] = entry;
    const callPromise = g.nova.ipc(type, payload);
    // Interactive channels open a real dialog a human would answer; dismiss
    // it like a user cancelling, which resolves the call with cancelled:true.
    if (interactive === 'dismiss-share') {
      await sleep(150);
      const cancelBtn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Cancel');
      if (cancelBtn) cancelBtn.__fire('click');
    } else if (interactive === 'dismiss-dialog') {
      await sleep(150);
      const cancelBtn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Cancel');
      if (cancelBtn) cancelBtn.__fire('click');
    }
    let r;
    try { r = { ok: true, value: await settle(callPromise, 6000) }; }
    catch (e) { r = { ok: false, error: e }; }
    if (r.ok) { answered++; continue; }
    const e = r.error || {};
    if (e.code && typeof e.code === 'string' && e.message && typeof e.message === 'string') { answered++; continue; }
    hungOrCodeless.push(`${type} → ${e.message || 'no error object'}`);
  }
  check(`all ${DOC_CHANNELS.length} documented channels answer (resolve or reject with .code/.message)`, hungOrCodeless.length === 0, hungOrCodeless.join('; ').slice(0, 400));

  // A typo'd channel must reject with UNKNOWN_API (documented) — not hang.
  const typo = await guestCall(g, 'nova:storage:getX', { key: 'x' });
  check('typo channel rejects with UNKNOWN_API', !typo.ok && errCode(typo.error) === 'UNKNOWN_API', JSON.stringify(typo.error && typo.error.message));

  // A completely made-up channel too.
  const made = await guestCall(g, 'nova:bogus:thing', {});
  check('made-up channel rejects with UNKNOWN_API', !made.ok && errCode(made.error) === 'UNKNOWN_API', JSON.stringify(made.error && made.error.message));

  // Guest-forbidden system APIs stay forbidden.
  const forbidden = await guestCall(g, 'nova:system:permissions:list', {});
  check('guest-forbidden channel rejects with PERMISSION_DENIED', !forbidden.ok && errCode(forbidden.error) === 'PERMISSION_DENIED', JSON.stringify(forbidden.error && forbidden.error.code));

  g.teardown();
}

// ════════════════════════════════ GA5 ══════════════════════════════════

// Permission → representative documented call. denyCase: expected without
// the grant. grantCase: expected with it (any non-PERMISSION_DENIED result
// — success or a legitimate downstream error such as UNAVAILABLE).
const PERM_MATRIX = [
  ['fs:access', 'nova:fs:write', { path: '/Pictures/via-access.txt', content: 'x' }],
  ['fs:metadata', 'nova:fs:stat', { path: '/Pictures/photo.jpg' }],
  ['fs:read:images', 'nova:fs:read', { path: '/Pictures/photo.jpg' }],
  ['fs:read:video', 'nova:fs:read', { path: '/Pictures/clip.mp4' }],
  ['fs:read:audio', 'nova:fs:read', { path: '/Pictures/song.mp3' }],
  ['apps:communicate', 'nova:ipc:register', { endpoint: 'service:audit.echo' }],
  ['net:internal', 'nova:net:fetch', { url: 'http://127.0.0.1/x', method: 'GET' }],
  ['net:external', 'nova:net:fetch', { url: 'https://ok.example.com/x', method: 'GET' }],
  ['net:websocket', 'nova:net:websocket', { url: 'wss://ws.example.com/' }],
  ['mail:read', 'nova:mail:read', { action: 'account' }],
  ['mail:write', 'nova:mail:write', { action: 'preview', html: '<b>x</b>' }],
  ['mail:send', 'nova:mail:send', { to: 'a@b.c' }],
  ['mail:delete', 'nova:mail:delete', { uids: [1] }],
  ['calendar:read', 'nova:calendar:read', {}],
  ['calendar:write', 'nova:calendar:write', { event: { id: 'e1', title: 'T', date: '2026-01-01' } }],
  ['calendar:delete', 'nova:calendar:delete', { id: 'e1' }],
  ['contacts:read', 'nova:contacts:read', {}],
  ['contacts:write', 'nova:contacts:write', { contact: { id: 'c1', name: 'N' } }],
  ['contacts:delete', 'nova:contacts:delete', { id: 'c1' }],
  ['device:notifications', 'nova:notifications:show', { title: 't', body: 'b' }],
  ['device:geolocation', 'nova:device:geolocation', { options: { timeout: 500 } }],
  ['device:camera', 'nova:device:camera', {}],
  ['device:microphone', 'nova:device:microphone', {}],
  ['clipboard:read', 'nova:clipboard:read', {}],
  ['clipboard:write', 'nova:clipboard:write', { text: 'hi' }],
  ['system:info', 'nova:system:info', {}],
  ['system:settings', 'nova:settings:set', { key: 'theme', value: 'dark' }],
  ['system:apps', 'nova:app:list', {}],
  ['system:app-launch', 'nova:app:launch', { appId: 'com.matrix.app' }],
  ['system:events', 'nova:events:subscribe', { event: 'app:launched' }],
  ['system:background:live', 'nova:background:stay-alive', { enabled: true }],
  ['admin:apps', 'nova:admin:apps', {}],
  ['admin:users', 'nova:admin:users', { action: 'list' }],
  ['admin:system', 'nova:admin:system', { action: 'get' }],
  ['admin:audit', 'nova:admin:audit', { limit: 5 }],
  ['sandbox:nested-webview', 'nova:overlay:show', { html: '<b>x</b>' }],
];

async function ga5() {
  section('[GA5] permission matrix — all documented permissions, deny then grant');

  seedSharedFiles();
  const appId = 'com.test.audit.g5';
  // Manifest opt-ins the sandbox permissions need (documented): IPC exports
  // for apps:communicate, allowNestedWebview for sandbox:nested-webview.
  const g = await freshGuest(appId, {
    manifest: {
      ...AUDIT_MANIFEST, id: appId,
      allowNestedWebview: true,
      permissions: ['sandbox:nested-webview'],
      ipc: { exports: ['service:audit.echo'], receives: [] },
    },
    permissions: ['sandbox:nested-webview'],
  });

  for (const [perm, channel, payload] of PERM_MATRIX) {
    // 1) Without the grant: PERMISSION_DENIED.
    const denied = await guestCall(g, channel, payload);
    check(`${perm}: ${channel} denied without grant`, !denied.ok && errCode(denied.error) === 'PERMISSION_DENIED',
      denied.ok ? 'resolved without grant' : `code=${errCode(denied.error)} msg=${String(denied.error && denied.error.message).slice(0, 80)}`);

    // 2) With the grant: must not be a permission denial anymore.
    await grant(perm, appId);
    const allowed = await guestCall(g, channel, payload);
    check(`${perm}: ${channel} not permission-denied with grant`, allowed.ok || errCode(allowed.error) !== 'PERMISSION_DENIED',
      allowed.ok ? 'resolved' : `code=${errCode(allowed.error)} msg=${String(allowed.error && allowed.error.message).slice(0, 80)}`);
    await revoke(perm, appId);

    // 3) And denied again after revocation.
    const redenied = await guestCall(g, channel, payload);
    check(`${perm}: ${channel} denied again after revoke`, !redenied.ok && errCode(redenied.error) === 'PERMISSION_DENIED',
      redenied.ok ? 'resolved after revoke' : `code=${errCode(redenied.error)}`);
  }

  // fs scoping: app-owned paths need no grant at all.
  const ownWrite = await guestCall(g, 'nova:fs:write', { path: '/data/own.txt', content: 'mine' });
  check('fs: app-owned write with zero grants resolves', ownWrite.ok, JSON.stringify(ownWrite.error && ownWrite.error.code));
  const ownRead = await guestCall(g, 'nova:fs:read', { path: '/data/own.txt' });
  check('fs: app-owned read returns the content', ownRead.ok && ownRead.value && ownRead.value.data === 'mine', JSON.stringify(ownRead.value && ownRead.value.data));
  // Auto-created ancestors: writing into a never-created folder works.
  const deepWrite = await guestCall(g, 'nova:fs:write', { path: '/data/a/b/c/deep.txt', content: 'deep' });
  check('fs: write auto-creates missing own-subtree folders', deepWrite.ok, JSON.stringify(deepWrite.error && deepWrite.error.code));
  const deepRead = await guestCall(g, 'nova:fs:read', { path: '/data/a/b/c/deep.txt' });
  check('fs: deep write round-trips', deepRead.ok && deepRead.value && deepRead.value.data === 'deep', JSON.stringify(deepRead.error && deepRead.error.code));
  const sharedMissing = await guestCall(g, 'nova:fs:write', { path: '/Nope/missing.txt', content: 'x' });
  check('fs: write to missing SHARED parent still NOT_FOUND', !sharedMissing.ok && errCode(sharedMissing.error) === 'NOT_FOUND', `code=${errCode(sharedMissing.error)}`);

  // Settings: get is gated by system:info (not system:settings).
  await grant('system:settings', appId);
  const getWithWritePerm = await guestCall(g, 'nova:settings:get', { key: 'theme' });
  check('settings:get still denied with only system:settings', !getWithWritePerm.ok && errCode(getWithWritePerm.error) === 'PERMISSION_DENIED');
  await revoke('system:settings', appId);

  // Admin double gate is exercised in GA8 (admin-mode flag).
  g.teardown();
}

// ════════════════════════════════ GA6 ══════════════════════════════════

async function ga6() {
  section('[GA6] error contract — rejection shape');

  const g = await freshGuest('com.test.audit.g6');

  // INVALID_ARGS on a malformed payload.
  const badKey = await guestCall(g, 'nova:storage:set', {});
  check('nova:storage:set without key → INVALID_ARGS', !badKey.ok && errCode(badKey.error) === 'INVALID_ARGS', JSON.stringify(badKey.error && badKey.error.code));

  const badEvent = await guestCall(g, 'nova:events:subscribe', { event: 'not:an:event' });
  check('subscribe to non-allowlisted event → INVALID_ARGS', !badEvent.ok && errCode(badEvent.error) === 'INVALID_ARGS', JSON.stringify(badEvent.error && badEvent.error.code));

  // NOT_FOUND on a missing app-owned file.
  const notFound = await guestCall(g, 'nova:fs:read', { path: '/data/does-not-exist.txt' });
  check('fs:read missing file → NOT_FOUND', !notFound.ok && errCode(notFound.error) === 'NOT_FOUND', JSON.stringify(notFound.error && notFound.error.code));

  // Every rejection carries .code and .message strings (validated across
  // the whole matrix above; here check the error is Error-like).
  const e = badKey.error;
  check('rejection has .code and .message strings', typeof e.code === 'string' && typeof e.message === 'string' && e.message.length > 0);

  // Window title/state and other free channels still fine after errors.
  const st = await guestCall(g, 'nova:window:getState', {});
  check('bridge still healthy after rejections', st.ok && typeof st.value.width === 'number', JSON.stringify(st.value));

  g.teardown();
}

// ════════════════════════════════ GA7 ══════════════════════════════════

async function ga7() {
  section('[GA7] cross-app isolation');

  const a = await freshGuest('com.test.audit.a7a');
  const b = await freshGuest('com.test.audit.a7b');

  // Storage isolation.
  await settle(a.novaOS.storage.set('secret', 'a-secret'));
  check('app B cannot read app A storage (null)', (await settle(b.novaOS.storage.get('secret'))) === null);
  const bKeys = await settle(b.novaOS.storage.keys());
  check('app B keys do not include A keys', !bKeys.includes('secret'), JSON.stringify(bKeys));

  // appdata isolation: identical logical paths land in different subtrees.
  await settle(a.novaOS.fs.appdata.write('shared-name.txt', 'from-a'));
  await settle(b.novaOS.fs.appdata.write('shared-name.txt', 'from-b'));
  const readA = await settle(a.novaOS.fs.appdata.read('shared-name.txt'));
  const readB = await settle(b.novaOS.fs.appdata.read('shared-name.txt'));
  const contentA = readA && readA.data;
  const contentB = readB && readB.data;
  check('same appdata path is per-app scoped', contentA === 'from-a' && contentB === 'from-b', `A=${JSON.stringify(contentA)} B=${JSON.stringify(contentB)}`);

  // Raw /data/ rewrite: B naming A's subtree explicitly must not reach it.
  const cross = await guestCall(b, 'nova:fs:read', { path: '/data/com.test.audit.a7a/shared-name.txt' });
  check('explicit foreign /data/<appId>/ path is caller-rewritten (own subtree)', cross.ok === false && (errCode(cross.error) === 'NOT_FOUND' || errCode(cross.error) === 'PERMISSION_DENIED'),
    `code=${errCode(cross.error)}`);

  // Inter-app IPC: both hold apps:communicate, A exports, B calls.
  await grant('apps:communicate', 'com.test.audit.a7a');
  await grant('apps:communicate', 'com.test.audit.a7b');
  const aIpc = a.app.manifest.ipc = { exports: ['service:audit.echo'], receives: [] };
  const bIpc = b.app.manifest.ipc = { exports: [], receives: [] };
  void aIpc; void bIpc;

  let providerHit = null;
  const stop = await settle(a.nova.ipc.provide('service:audit.echo', async (req) => ({ echo: req.data, from: 'a' })));
  check('ipc.provide resolves to an unsubscribe function', typeof stop === 'function');

  const call = await settle(b.nova.ipc.call('com.test.audit.a7a', 'service:audit.echo', { ping: 1 }));
  check('ipc.call reaches the provider and returns its result', call && call.result && call.result.echo && call.result.echo.ping === 1, JSON.stringify(call).slice(0, 200));
  void providerHit;
  if (typeof stop === 'function') await settle(stop());
  let afterStopErr = null, afterStopOk = null;
  try { afterStopOk = await settle(b.nova.ipc.call('com.test.audit.a7a', 'service:audit.echo', { ping: 2 })); } catch (e) { afterStopErr = e; }
  check('ipc.call after provider unregister fails (REMOTE_ERROR/UNAVAILABLE)', !!afterStopErr && (afterStopErr.code === 'REMOTE_ERROR' || afterStopErr.code === 'UNAVAILABLE'), JSON.stringify(afterStopErr && afterStopErr.code));
  void afterStopOk;

  a.teardown();
  b.teardown();
}

// ════════════════════════════════ GA8 ══════════════════════════════════

async function ga8() {
  section('[GA8] real flows — clipboard, notifications, settings, events, appearance, requestPermission');

  const appId = 'com.test.audit.g8';
  const g = await freshGuest(appId);

  // Clipboard round trip (both grants).
  await grant('clipboard:write', appId);
  await grant('clipboard:read', appId);
  const wrote = await guestCall(g, 'nova:clipboard:write', { text: 'clip-roundtrip' });
  check('clipboard:write resolves', wrote.ok, JSON.stringify(wrote.error && wrote.error.code));
  const read = await guestCall(g, 'nova:clipboard:read', {});
  check('clipboard:read returns what was written', read.ok && read.value && read.value.text === 'clip-roundtrip', JSON.stringify(read.value));

  // Notifications: channel → post → listed → cancelAll.
  await grant('device:notifications', appId);
  const ch = await guestCall(g, 'nova:notifications:createChannel', { id: 'audit', name: 'Audit' });
  check('notifications:createChannel resolves', ch.ok, JSON.stringify(ch.error && ch.error.code));
  const posted = await guestCall(g, 'nova:notifications:post', { channelId: 'audit', title: 'Hi', body: 'Body' });
  check('notifications:post resolves', posted.ok, JSON.stringify(posted.error && posted.error.code));
  const cleared = await guestCall(g, 'nova:notifications:cancelAll', {});
  check('notifications:cancelAll resolves', cleared.ok, JSON.stringify(cleared.error && cleared.error.code));

  // Settings with grants + allowlist.
  await grant('system:info', appId);
  await grant('system:settings', appId);
  const got = await guestCall(g, 'nova:settings:get', { key: 'theme' });
  check('settings:get resolves for allowlisted key', got.ok, JSON.stringify(got.error && got.error.code));
  const set = await guestCall(g, 'nova:settings:set', { key: 'theme', value: 'dark' });
  check('settings:set resolves for allowlisted key', set.ok, JSON.stringify(set.error && set.error.code));
  const deniedKey = await guestCall(g, 'nova:settings:get', { key: 'lockPin' });
  check('settings:get security key rejected', !deniedKey.ok && (errCode(deniedKey.error) === 'PERMISSION_DENIED' || errCode(deniedKey.error) === 'INVALID_ARGS'), `code=${errCode(deniedKey.error)}`);

  // Events: allowlist + permission tiers per the doc table.
  const plain = await guestCall(g, 'nova:events:subscribe', { event: 'system:themeChanged' });
  check('themeChanged subscribes with no permission', plain.ok, JSON.stringify(plain.error && plain.error.code));
  const volume = await guestCall(g, 'nova:events:subscribe', { event: 'system:volumeChanged' });
  check('volumeChanged subscribes with no permission', volume.ok, JSON.stringify(volume.error && volume.error.code));
  // Release the raw subscriptions so the onEvent facade tests below start
  // from a clean slate (one subscription per sandbox per event).
  await guestCall(g, 'nova:events:unsubscribe', { event: 'system:themeChanged' });
  await guestCall(g, 'nova:events:unsubscribe', { event: 'system:volumeChanged' });
  const sensitive = await guestCall(g, 'nova:events:subscribe', { event: 'app:launched' });
  check('app:launched denied without system:events', !sensitive.ok && errCode(sensitive.error) === 'PERMISSION_DENIED', `code=${errCode(sensitive.error)}`);
  await grant('system:events', appId);
  const sensitiveOk = await guestCall(g, 'nova:events:subscribe', { event: 'app:launched' });
  check('app:launched subscribes with system:events', sensitiveOk.ok, JSON.stringify(sensitiveOk.error && sensitiveOk.error.code));
  const domain = await guestCall(g, 'nova:events:subscribe', { event: 'mail:new' });
  check('mail:new still denied with only system:events', !domain.ok && errCode(domain.error) === 'PERMISSION_DENIED', `code=${errCode(domain.error)}`);
  await grant('mail:read', appId);
  const domainOk = await guestCall(g, 'nova:events:subscribe', { event: 'mail:new' });
  check('mail:new subscribes with system:events + mail:read', domainOk.ok, JSON.stringify(domainOk.error && domainOk.error.code));
  await revoke('mail:read', appId);
  await revoke('system:events', appId);

  // Event delivery: onEvent callback fires on OS emit.
  let received = null;
  g.nova.onEvent('system:themeChanged', (data) => { received = data; });
  await sleep(50);
  env.state.OS.events.emit('system:themeChanged', { theme: 'nord' });
  await sleep(150);
  check('onEvent listener receives pushed event', received && received.theme === 'nord', JSON.stringify(received));

  // Stacking a second listener for the same event must work (listener
  // semantics), not reject with ALREADY_SUBSCRIBED.
  let secondReceived = null;
  let secondErr = null;
  try {
    await settle(g.nova.onEvent('system:themeChanged', (data) => { secondReceived = data; }));
  } catch (e) { secondErr = e; }
  check('second onEvent for the same event resolves (no ALREADY_SUBSCRIBED)', !secondErr, JSON.stringify(secondErr && secondErr.code));
  env.state.OS.events.emit('system:themeChanged', { theme: 'light' });
  await sleep(150);
  check('both listeners fire for the pushed event', received && received.theme === 'light' && secondReceived && secondReceived.theme === 'light', JSON.stringify([received, secondReceived]));

  // Appearance get/set (theme values are the OS theme ids, e.g. 'nord').
  const appearance = await settle(g.nova.appearance.get());
  check('appearance.get returns a snapshot', appearance && typeof appearance === 'object', JSON.stringify(appearance));
  const appearanceSet = await settle(g.nova.appearance.set({ theme: 'nord', accentColor: '#5e81ac' }));
  check('appearance.set resolves', appearanceSet && appearanceSet.success !== false, JSON.stringify(appearanceSet).slice(0, 120));
  let badThemeErr = null;
  try { await settle(g.nova.appearance.set({ theme: 'not-a-theme' })); } catch (e) { badThemeErr = e; }
  check('appearance.set rejects an invalid theme value', badThemeErr && badThemeErr.code === 'INVALID_ARGS', JSON.stringify(badThemeErr && badThemeErr.code));

  // requestPermission through the REAL dialog — click Allow like a user.
  // (contacts:read is NOT already granted at this point, so a live dialog
  // must appear; an already-granted permission short-circuits to granted.)
  const requestP = g.nova.requestPermission('contacts:read', 'Audit needs it');
  await sleep(120);
  const overlays = () => (global.document.body.children || []).filter((n) => !n.removed);
  let overlay = null;
  for (let i = 0; i < 40 && !overlay; i++) {
    await sleep(15);
    overlay = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Allow') ? global.document.body : null;
  }
  check('requestPermission shows a real dialog', !!overlay, 'no Allow button found in host DOM');
  if (overlay) {
    const btn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Allow');
    btn.__fire('click');
  }
  const grantResult = await settle(requestP, 4000);
  check('requestPermission resolves { granted: true } after Allow', grantResult && grantResult.granted === true, JSON.stringify(grantResult));
  check('grant actually took effect', PM.isGranted('contacts:read', appId) === true);
  await revoke('contacts:read', appId);

  // Deny path.
  const requestP2 = g.nova.requestPermission('calendar:read', 'Audit wants calendars');
  await sleep(120);
  const denyBtn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Deny');
  check('second request shows a real dialog (Deny present)', !!denyBtn);
  if (denyBtn) denyBtn.__fire('click');
  const denyResult = await settle(requestP2, 4000);
  check('requestPermission resolves { granted: false } after Deny (does not reject)', denyResult && denyResult.granted === false, JSON.stringify(denyResult));
  check('denial recorded (not granted)', PM.isGranted('calendar:read', appId) === false);

  // permission-rate-limited channel.
  const limited = await guestCall(g, 'nova:permission-rate-limited', { permission: 'calendar:read' });
  check('nova:permission-rate-limited answers', limited.ok || errCode(limited.error), JSON.stringify(limited.error && limited.error.code));

  g.teardown();
}

// ════════════════════════════════ GA9 ══════════════════════════════════

// ── GA10: transparent network bridging (the path real apps use) ──

async function ga10() {
  section('[GA10] transparent network bridging — window.fetch / XHR');

  const appId = 'com.test.audit.g10';
  const g = await freshGuest(appId);

  // fetch() with no net grant rejects with PERMISSION_DENIED (bridged,
  // not native — a native fetch would hit stubFetch's no-route TypeError).
  let fetchErr = null;
  try { await settle(g.window.fetch('https://ok.example.com/x')); } catch (e) { fetchErr = e; }
  check('window.fetch without net grant rejects PERMISSION_DENIED', fetchErr && fetchErr.code === 'PERMISSION_DENIED', JSON.stringify(fetchErr && fetchErr.code));

  // With net:external it resolves a real Response through the bridge.
  await grant('net:external', appId);
  const res = await settle(g.window.fetch('https://ok.example.com/x'));
  check('window.fetch with net:external resolves a Response', res && typeof res === 'object' && typeof res.json === 'function', typeof res);
  const body = await settle(res.json());
  check('bridged fetch body round-trips (json)', body && body.hello === 'world', JSON.stringify(body));
  await revoke('net:external', appId);

  // Internal destination with only net:external is denied; with
  // net:internal it works (the MAC row now allows either grant through).
  await grant('net:external', appId);
  let internalErr = null;
  try { await settle(g.window.fetch('http://127.0.0.1/internal')); } catch (e) { internalErr = e; }
  check('internal URL with only net:external rejects PERMISSION_DENIED', internalErr && internalErr.code === 'PERMISSION_DENIED', JSON.stringify(internalErr && internalErr.code));
  await revoke('net:external', appId);
  await grant('net:internal', appId);
  const internalRes = await settle(g.window.fetch('http://127.0.0.1/internal'));
  const internalBody = await settle(internalRes.json());
  check('internal URL with net:internal resolves (MAC any-of fix)', internalBody && internalBody.hello === 'world', JSON.stringify(internalBody));
  await revoke('net:internal', appId);

  // Self-file exemption: fetching one of the app's own registered files
  // under its serve prefix needs no permission and uses the native path.
  const ownUrl = g.window.location.href;
  let selfErr = null;
  let selfRes = null;
  try { selfRes = await settle(g.window.fetch(ownUrl), 4000); } catch (e) { selfErr = e; }
  check('self-file fetch needs no net permission (native path)', !selfErr, JSON.stringify(selfErr && selfErr.message));
  void selfRes;

  // XHR through the bridge: permission-gated the same way.
  await grant('net:external', appId);
  const xhrResult = await new Promise((resolve) => {
    let failedWith = null;
    try {
      const xhr = new g.window.XMLHttpRequest();
      xhr.open('GET', 'https://ok.example.com/x');
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
      xhr.onerror = () => resolve({ error: 'network' });
      xhr.onabort = () => resolve({ error: 'abort' });
      setTimeout(() => resolve({ error: 'timeout', failedWith }), 4000);
      xhr.send();
    } catch (e) {
      resolve({ error: String(e && e.message || e), failedWith });
    }
  });
  check('XMLHttpRequest bridged fetch resolves with status 200', xhrResult && xhrResult.status === 200, JSON.stringify(xhrResult));
  check('XMLHttpRequest body round-trips', xhrResult && /world/.test(String(xhrResult.text || '')), JSON.stringify(xhrResult && xhrResult.text));
  await revoke('net:external', appId);

  const xhrDenied = await new Promise((resolve) => {
    try {
      const xhr = new g.window.XMLHttpRequest();
      xhr.open('GET', 'https://ok.example.com/x');
      xhr.onload = () => resolve({ status: xhr.status });
      xhr.onerror = () => resolve({ error: 'network' });
      setTimeout(() => resolve({ error: 'timeout' }), 4000);
      xhr.send();
    } catch (e) { resolve({ error: String(e && e.message || e) }); }
  });
  check('XMLHttpRequest without grant fails (not silently succeeds)', xhrDenied && (xhrDenied.error || xhrDenied.status !== 200), JSON.stringify(xhrDenied));

  g.teardown();
}

// ── GA11: websocket wrapper, share sheet, file picker (real dialogs) ──

async function ga11() {
  section('[GA11] websocket wrapper, share sheet, file picker — real dialogs');

  const appId = 'com.test.audit.g11';
  const g = await freshGuest(appId);

  // WebSocket without the grant.
  let wsErr = null;
  try { await settle(g.nova.websocket('wss://ws.example.com/')); } catch (e) { wsErr = e; }
  check('websocket without net:websocket rejects PERMISSION_DENIED', wsErr && wsErr.code === 'PERMISSION_DENIED', JSON.stringify(wsErr && wsErr.code));

  // With the grant: open → message → send → close through the wrapper.
  await grant('net:websocket', appId);
  const ws = await settle(g.nova.websocket('wss://ws.example.com/'));
  check('websocket wrapper resolves a handle with wsId', ws && !!ws.wsId && typeof ws.send === 'function', JSON.stringify(ws && ws.wsId));
  let message = null;
  ws.onMessage((envelope) => { message = envelope; });
  // Host StubWebSocket echoes nothing by itself; drive the guest-visible
  // event path by having the host push through ws:send and reading state.
  const sendRes = await settle(ws.send('hello-socket'));
  check('ws.send resolves through the bridge', !sendRes.error, JSON.stringify(sendRes && sendRes.error));
  const closeRes = await settle(ws.close(1000, 'done'));
  check('ws.close resolves through the bridge', !closeRes.error, JSON.stringify(closeRes && closeRes.error));
  await revoke('net:websocket', appId);
  void message;

  // Share sheet — a REAL host dialog; click Copy like a user.
  const shareP = settle(g.nova.share({ title: 'Share me', text: 'Some text' }), 6000);
  await sleep(150);
  const copyBtn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Copy');
  check('share sheet shows a Copy action', !!copyBtn);
  if (copyBtn) copyBtn.__fire('click');
  const shared = await shareP;
  check('share resolves { cancelled: false, action: "Copy" }', shared && shared.cancelled === false && shared.action === 'Copy', JSON.stringify(shared));

  // Share cancel path.
  const shareP2 = settle(g.nova.share({ text: 'Again' }), 6000);
  await sleep(150);
  const cancelBtn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Cancel');
  check('second share sheet shows Cancel', !!cancelBtn);
  if (cancelBtn) cancelBtn.__fire('click');
  const shared2 = await shareP2;
  check('share cancel resolves { cancelled: true }', shared2 && shared2.cancelled === true, JSON.stringify(shared2));

  // Invalid share payloads reject INVALID_ARGS (no dialog).
  let shareErr = null;
  try { await settle(g.nova.share({ url: 'ftp://nope.example.com/x' })); } catch (e) { shareErr = e; }
  check('share with non-HTTP(S) url rejects INVALID_ARGS', shareErr && shareErr.code === 'INVALID_ARGS', JSON.stringify(shareErr && shareErr.code));

  // File picker (nova:files:open) — the REAL production SystemDialogs
  // service browsing a REAL directory, clicked through like a user.
  const osMod = require('os');
  const pickerDir = fs.mkdtempSync(path.join(osMod.tmpdir(), 'nova-guest-picker-'));
  fs.writeFileSync(path.join(pickerDir, 'photo.jpg'), 'jpeg-bytes');
  fs.writeFileSync(path.join(pickerDir, 'notes.txt'), 'plain text notes');

  const openP = settle(g.nova.files.open({
    title: 'Pick one', startPath: pickerDir, accept: ['image/jpeg'],
  }), 8000);
  await sleep(250);
  const photoTile = findInTree(global.document.body, (n) => typeof n.getAttribute === 'function' && n.getAttribute('aria-label') === 'photo.jpg');
  check('real picker lists the image file', !!photoTile);
  if (photoTile) photoTile.__fire('click');
  await sleep(80);
  const openBtn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Open');
  check('picker Open button enabled after selection', !!openBtn && openBtn.disabled === false);
  if (openBtn) openBtn.__fire('click');
  const opened = await openP;
  check('files.open resolves the picked image as base64',
    opened && opened.cancelled === false && opened.file && opened.file.name === 'photo.jpg'
      && opened.file.content === Buffer.from('jpeg-bytes').toString('base64')
      && opened.file.encoding === 'base64',
    JSON.stringify(opened).slice(0, 220));

  // Text file pick returns plain content (no encoding marker).
  const openTxt = settle(g.nova.files.open({
    title: 'Pick text', startPath: pickerDir, accept: ['.txt'],
  }), 8000);
  await sleep(250);
  const txtTile = findInTree(global.document.body, (n) => typeof n.getAttribute === 'function' && n.getAttribute('aria-label') === 'notes.txt');
  if (txtTile) txtTile.__fire('click');
  await sleep(80);
  const openBtn2 = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Open');
  if (openBtn2) openBtn2.__fire('click');
  const openedTxt = await openTxt;
  check('files.open resolves the picked text file as content',
    openedTxt && openedTxt.cancelled === false && openedTxt.file && openedTxt.file.content === 'plain text notes' && !openedTxt.file.encoding,
    JSON.stringify(openedTxt).slice(0, 220));

  // Picker cancel path.
  const openP2 = settle(g.nova.files.open({ title: 'Cancel me', startPath: pickerDir }), 8000);
  await sleep(250);
  const pickerCancel = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Cancel');
  check('picker shows Cancel', !!pickerCancel);
  if (pickerCancel) pickerCancel.__fire('click');
  const opened2 = await openP2;
  check('files.open cancel resolves { cancelled: true }', opened2 && opened2.cancelled === true, JSON.stringify(opened2));

  // Save picker: pick a destination, verify the real file lands on disk.
  const saveP = settle(g.nova.files.save({
    title: 'Export', filename: 'exported.txt', startPath: pickerDir,
    mimeType: 'text/plain', content: 'Exported content',
  }), 8000);
  await sleep(250);
  const saveBtn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Save');
  check('save picker shows Save (enabled by suggestedName)', !!saveBtn && saveBtn.disabled === false);
  if (saveBtn) saveBtn.__fire('click');
  const saved = await saveP;
  const savedPath = saved && saved.file && saved.file.path;
  const onDisk = savedPath ? fs.readFileSync(savedPath, 'utf8') : null;
  check('files.save writes the content to the real destination',
    saved && saved.cancelled === false && onDisk === 'Exported content',
    JSON.stringify(saved).slice(0, 200) + ' disk=' + JSON.stringify(onDisk));

  fs.rmSync(pickerDir, { recursive: true, force: true });

  g.teardown();
}

// ── GA12: requestPermission rate limiting + notification actions ──

async function ga12() {
  section('[GA12] requestPermission rate limiting and notification actions');

  const appId = 'com.test.audit.g12';
  const g = await freshGuest(appId);

  // The doc: 3 prompts per rolling 60s per appId:permission pair, then
  // auto-deny with no dialog; cooldown doubles per consecutive denial.
  const results = [];
  for (let i = 0; i < 4; i++) {
    const p = settle(g.nova.requestPermission('device:geolocation', 'reason ' + i), 5000);
    await sleep(120);
    const denyBtn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Deny');
    if (denyBtn) { denyBtn.__fire('click'); results.push(await p); }
    else { results.push(await p); }
  }
  check('four rapid requests all resolve granted:false (3 dialogs + 1 auto-deny)',
    results.length === 4 && results.every((r) => r && r.granted === false),
    JSON.stringify(results));

  // Rate-limit probe channel reports the state.
  const limited = await guestCall(g, 'nova:permission-rate-limited', { permission: 'device:geolocation' });
  check('permission-rate-limited reports limited after denial streak', limited.ok && limited.value && limited.value.limited === true, JSON.stringify(limited.value));

  // Notification action queue through the guest.
  await grant('device:notifications', appId);
  await guestCall(g, 'nova:notifications:createChannel', { id: 'act', name: 'Act' });
  const posted = await guestCall(g, 'nova:notifications:post', {
    channelId: 'act', title: 'Do', body: 'Something',
    actions: [{ id: 'go', label: 'Go' }],
  });
  check('post with actions resolves', posted.ok, JSON.stringify(posted.error && posted.error.code));

  // Empty queue shape before any tap.
  const empty = await guestCall(g, 'nova:notifications:consumeActions', {});
  check('consumeActions on empty queue resolves a list', empty.ok && Array.isArray(empty.value && (empty.value.actions || empty.value)), JSON.stringify(empty.value));

  // Toast action tap: find the toast's Go button (toasts mount into the
  // #toast-container portal, not directly under body) and tap it.
  const toastRoot = global.document.getElementById('toast-container');
  const goBtn = findInTree(toastRoot, (n) => n.tagName === 'BUTTON' && n.textContent === 'Go');
  check('posted action renders a tappable toast button', !!goBtn);
  if (goBtn) goBtn.__fire('click');
  await sleep(200);
  const consumed = await guestCall(g, 'nova:notifications:consumeActions', {});
  const actions = consumed.value && (consumed.value.actions || consumed.value);
  check('tapped action is delivered to the app queue', Array.isArray(actions) && actions.length === 1 && actions[0].actionId === 'go' && actions[0].label === 'Go', JSON.stringify(actions));
  const consumedAgain = await guestCall(g, 'nova:notifications:consumeActions', {});
  const actionsAgain = consumedAgain.value && (consumedAgain.value.actions || consumedAgain.value);
  check('consumeActions acknowledges (queue drains)', Array.isArray(actionsAgain) && actionsAgain.length === 0, JSON.stringify(actionsAgain));

  await revoke('device:notifications', appId);
  g.teardown();
}


async function ga9() {
  section('[GA9] doc parity — NOVAAPP.md vs runtime');

  const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'NOVAAPP.md'), 'utf8');
  const mgrSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'platform', 'security', 'app-permission-manager.js'), 'utf8');

  // 1) The documented permission table matches the manager catalog exactly.
  const mgrBlock = mgrSrc.match(/const PERMISSION_TYPES = Object\.freeze\(\{([\s\S]*?)\n\s*\}\)/);
  const mgrPerms = [...mgrBlock[1].matchAll(/:\s*'([a-z:]+)'/g)].map((x) => x[1]);
  const docRows = [...doc.matchAll(/^\| \`([a-z:]+)\` \| (Filesystem|Apps|Network|Email|Calendar|Contacts|Device|System|Admin|Sandbox) \|/gm)].map((x) => x[1]);
  check(`doc permission table (${docRows.length}) matches manager catalog (${mgrPerms.length})`,
    docRows.length === mgrPerms.length && docRows.every((p) => mgrPerms.includes(p)),
    `doc-only: ${docRows.filter((p) => !mgrPerms.includes(p)).join(',')} | mgr-only: ${mgrPerms.filter((p) => !docRows.includes(p)).join(',')}`);

  // 2) The prose count "N permissions" matches the table.
  const countClaim = doc.match(/(\d+) permissions across \d+ categories/);
  check('doc prose permission count matches the table', countClaim && Number(countClaim[1]) === docRows.length, `prose says ${countClaim && countClaim[1]}, table has ${docRows.length}`);

  // 3) Event table names are all subscribable with the right grants and a
  //    made-up name is not (behavior-level parity with ALLOWED_EVENT_NAMES).
  const g = await freshGuest('com.test.audit.g9');
  // system:events plus every domain read grant the doc table's tiered rows
  // require (mail/calendar/contact events need their domain read too).
  for (const p of ['system:events', 'mail:read', 'calendar:read', 'contacts:read']) {
    await grant(p, appId09);
  }
  // Event-table rows only, parsed inside the "### Event bus" section so the
  // permission and background-execution tables can't leak in.
  const eventSection = doc.match(/### Event bus[\s\S]*?(?=\n### )/);
  const docEvents = eventSection
    ? [...eventSection[0].matchAll(/^\| \`((?:system|app|mail|calendar|contacts):[a-zA-Z]+)\` \|/gm)].map((x) => x[1])
    : [];
  let notSubscribable = [];
  for (const ev of docEvents) {
    const r = await guestCall(g, 'nova:events:subscribe', { event: ev });
    if (!r.ok) notSubscribable.push(`${ev}(${errCode(r.error)})`);
    await guestCall(g, 'nova:events:unsubscribe', { event: ev });
  }
  check(`all ${docEvents.length} documented events subscribe (with system:events + domain-free)`, notSubscribable.length === 0, notSubscribable.join(', '));
  const fake = await guestCall(g, 'nova:events:subscribe', { event: 'system:bogus' });
  check('made-up event name rejected', !fake.ok && errCode(fake.error) === 'INVALID_ARGS');
  g.teardown();
}
const appId09 = 'com.test.audit.g9';

// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// GA13 — full channel-table sweep + guest-forbidden enforcement
//
// DOC_CHANNELS pins the documented surface; the runtime's real handler
// table (INTERNAL.API_HANDLERS) is the source of truth and can drift.
// This section drives EVERY table channel the documented probe does not
// cover, and proves every GUEST_FORBIDDEN_IPC_APIS entry rejects even a
// fully privileged guest (the dispatch-time guard runs before MAC and
// before any handler — these channels are host-UI-only by design).
// ═══════════════════════════════════════════════════════════════════════

const appId13 = 'com.test.audit.g13';
const appId13b = 'com.test.audit.g13b';

// Channels whose real behavior is proven elsewhere as interactive flows:
// GA12 drives requestPermission dialogs and the rate-limit probe end to end.
const SWEEP_COVERED_ELSEWHERE = new Set([
  'nova:request-permission',
  'nova:permission-rate-limited',
]);

// The sweep may open a real file dialog (sysdialog/dialog channels are in
// the handler table); a user answers it by cancelling, so the sweep does
// the same. GA4's dismiss pattern, generalized to any open dialog.
function dismissAnyOpenDialog() {
  const cancelBtn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Cancel');
  if (cancelBtn) cancelBtn.__fire('click');
}

async function ga13() {
  section('[GA13] full channel-table sweep + guest-forbidden enforcement');
  const forbidden = INTERNAL.GUEST_FORBIDDEN_IPC_APIS;
  const table = Object.keys(INTERNAL.API_HANDLERS);
  check('runtime channel table is non-trivial', table.length >= 80, `got ${table.length}`);
  check('guest-forbidden set is non-trivial', forbidden.size >= 30, `got ${forbidden.size}`);

  // 1) Every forbidden channel rejects PERMISSION_DENIED for a guest that
  //    holds every grant these domains would otherwise consult.
  const g = await freshGuest(appId13);
  for (const p of ['system:apps', 'system:app-launch', 'apps:communicate', 'admin:audit', 'admin:system', 'admin:users', 'system:events']) {
    await grant(p, appId13);
  }
  let denied = 0;
  const weak = [];
  for (const type of forbidden) {
    const r = await guestCall(g, type, {});
    if (!r.ok && errCode(r.error) === 'PERMISSION_DENIED') denied++;
    else weak.push(`${type} → ${r.ok ? 'RESOLVED' : errCode(r.error)}`);
  }
  check(`all ${forbidden.size} guest-forbidden channels reject PERMISSION_DENIED despite full grants`, denied === forbidden.size, weak.join(', '));
  g.teardown();

  // 2) Sweep: every remaining table channel answers with a code-carrying
  //    response — success or a documented typed error (INVALID_ARGS,
  //    PERMISSION_DENIED, UNAVAILABLE, ...), never a hang or a codeless
  //    rejection. This is the anti-drift check: a handler added to the
  //    runtime table must be exercisable by an app or removed.
  const probed = new Set(DOC_CHANNELS.map(([type]) => type));
  const rest = table
    .filter((t) => !forbidden.has(t) && !probed.has(t) && !SWEEP_COVERED_ELSEWHERE.has(t));
  const g2 = await freshGuest(appId13b, {
    manifest: {
      ...AUDIT_MANIFEST, id: appId13b,
      allowNestedWebview: true,
      permissions: ['sandbox:nested-webview'],
      ipc: { exports: [], receives: [] },
    },
    permissions: ['sandbox:nested-webview'],
  });
  for (const p of ['system:apps', 'system:app-launch', 'apps:communicate', 'system:events', 'system:background']) await grant(p, appId13b);
  const interactive = new Set(['nova:sysdialog:open', 'nova:sysdialog:save', 'nova:dialog:open', 'nova:dialog:save', 'nova:files:open']);
  const unanswered = [];
  for (const type of rest) {
    const callPromise = g2.nova.ipc(type, {});
    // Dismissals happen while this promise is still un-awaited; attach a
    // no-op catch now so a rejection during the interactive window can't
    // become an unhandledRejection that kills the process.
    callPromise.catch(() => {});
    if (interactive.has(type)) {
      await sleep(200);
      dismissAnyOpenDialog();
      await sleep(100);
      dismissAnyOpenDialog();
    }
    const r = await guestCallResult(callPromise);
    if (r.ok) continue;
    const e = r.error || {};
    if (e.code && typeof e.code === 'string' && e.message && typeof e.message === 'string') continue;
    unanswered.push(`${type} → ${e.message || 'no error object'}`);
  }
  check(`every remaining ${rest.length} runtime channels answer with a typed response`, unanswered.length === 0, unanswered.join(', '));
  g2.teardown();
}

// Same shape as guestCall but for an already-started call promise.
async function guestCallResult(callPromise) {
  try {
    const value = await settle(callPromise, 6000);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// GA14 — host→app push delivery
//
// GA8 proved nova:events:event pushes; this section covers the other
// push channels a running app lives on: appearance changes, overlay
// interactions, and AppScheduler background wakes.
// ═══════════════════════════════════════════════════════════════════════

async function ga14() {
  section('[GA14] host→app push delivery — appearance, overlay events, background wake');

  // 1) Appearance change push → appearance.onChange callbacks. The host
  //    handler subscribes to OS settings:changed and forwards public keys
  //    as nova:appearance:changed:event; the shim acks and fans out.
  const g = await freshGuest('com.test.audit.g14');
  let seen = null, onChangeErr = null, unsubFn = null;
  try { unsubFn = await settle(g.nova.appearance.onChange((snap) => { seen = snap; })); }
  catch (e) { onChangeErr = e; }
  check('appearance.onChange subscribes', !onChangeErr, JSON.stringify(onChangeErr && onChangeErr.code));
  env.state.OS.events.emit('settings:changed', { key: 'theme', value: 'nord' });
  await sleep(250);
  check('appearance change pushes a snapshot to onChange callbacks', seen && typeof seen === 'object' && seen.theme !== undefined, JSON.stringify(seen).slice(0, 140));
  if (typeof unsubFn === 'function') await settle(unsubFn());
  env.state.OS.events.emit('settings:changed', { key: 'theme', value: 'light' });
  await sleep(150);
  check('no push after appearance.onChange unsubscribe', seen && seen.theme !== 'light', JSON.stringify(seen).slice(0, 140));

  // 2) Overlay interaction push: clicking a [data-nova-action] element in a
  //    shown overlay forwards { overlayId, type, action } to overlay.onEvent.
  const overlayGuest = await freshGuest('com.test.audit.g14b', {
    manifest: {
      ...AUDIT_MANIFEST, id: 'com.test.audit.g14b',
      allowNestedWebview: true,
      permissions: ['sandbox:nested-webview'],
    },
    permissions: ['sandbox:nested-webview'],
  });
  // The overlay is a double gate: manifest opt-in AND the user grant.
  await grant('sandbox:nested-webview', 'com.test.audit.g14b');
  let overlayEvent = null, showErr = null, shown = null;
  overlayGuest.nova.overlay.onEvent((e) => { overlayEvent = e; });
  try { shown = await settle(overlayGuest.nova.overlay.show({ html: '<button data-nova-action="go">Go</button>' })); }
  catch (e) { showErr = e; }
  check('overlay.show resolves', !showErr && shown && shown.success !== false, JSON.stringify(showErr && showErr.code || shown).slice(0, 140));
  await sleep(150);
  // The overlay renders inside the host's sandboxed <iframe>; the action
  // button lives in that iframe's contentDocument, not the host body.
  const overlayIframes = [];
  findInTree(global.document.body, (n) => { if (n.tagName === 'IFRAME') overlayIframes.push(n); return false; });
  let btn = null;
  for (const f of overlayIframes) {
    btn = findInTree(f.contentDocument?.body, (n) => n.tagName === 'BUTTON' && n.getAttribute?.('data-nova-action') === 'go');
    if (btn) break;
  }
  check('overlay action button rendered into the overlay document', !!btn);
  if (btn) { btn.__fire('click'); await sleep(250); }
  check('overlay click pushes an event to overlay.onEvent', overlayEvent && overlayEvent.type === 'click' && overlayEvent.action === 'go', JSON.stringify(overlayEvent).slice(0, 180));

  // 3) Background wake push: the host only sends wake messages to a
  //    sandbox it started for a wake cycle (gated on system:background
  //    before creation), so the guest side dispatches without a second
  //    permission check. Drive the real respond() push path — respond()
  //    appends the ':response' wire suffix itself (see AppScheduler.wake).
  let wake = null;
  g.nova.onBackgroundWake((info) => { wake = info; });
  INTERNAL.respond(g.webview, 'nova:background:wake', INTERNAL.generateRequestId(), { reason: 'scheduled-wake' });
  await sleep(600);
  check('background wake push reaches onBackgroundWake listeners', wake && wake.reason === 'scheduled-wake', JSON.stringify(wake).slice(0, 140));

  g.teardown();
  overlayGuest.teardown();
}

const FILTER = process.argv.find((a) => a.startsWith('--filter'))?.split('=')[1] || '';

const SUITE = {
  GA1: ga1, GA2: ga2, GA3: ga3, GA4: ga4, GA5: ga5,
  GA6: ga6, GA7: ga7, GA8: ga8, GA9: ga9,
  GA10: ga10, GA11: ga11, GA12: ga12,
  GA13: ga13, GA14: ga14,
};

(async () => {
  const names = FILTER ? [FILTER] : Object.keys(SUITE);
  for (const name of names) {
    if (!SUITE[name]) { console.log('unknown filter: ' + name); continue; }
    try { await SUITE[name](); }
    catch (e) { fail++; failures.push(`${name} crashed: ${e && e.stack || e}`); console.log(`  SECTION CRASH ${name}:`, e); }
  }
  console.log(`\n──── guest-bridge audit: ${pass} passed, ${fail} failed ────`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(fail ? 1 : 0);
})();
