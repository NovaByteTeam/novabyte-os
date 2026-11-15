# .novaapp Examples — Working Code Cookbook

Runnable recipes for NovaByte OS (NBOSP) `.novaapp` apps. Every example states its goal, the manifest it needs, the code, what the user sees, and the failure modes with the exact error strings the host produces.

**Audience:** `.novaapp` developers. Sibling documents: [`guide.md`](guide.md) (app journey, manifest format, packaging), [`permissions.md`](permissions.md) (the 52-permission catalog and prompt behavior), [`api-reference.md`](api-reference.md) (every channel, facade method, rate limit), [`internals.md`](internals.md) (OS implementation detail). This file is a cookbook — it links out instead of duplicating reference tables.

**Citation convention:** bare `:NNNN` references point at `NBOSP/js/platform/security/app-sandbox.js`. Other files are cited as `path:line` (test files under `NBOSP/tests/` by short name, e.g. `appmanager.test.js:91`). Behavior pinned by integration suites is cited as `tests/integration/<suite>.js:line`.

**Two rules that hold everywhere:**

1. Facade choice: prefer `window.novaOS.*` (v2, frozen, normalized results); use `window.nova.*` for v1-only surfaces (`files`, `appearance`, `overlay`, `contextMenu`, `wallpaper`, `home`, `browser`, `ipc`); use `nova.ipc(type, payload)` only for channels with no facade method. Full mapping in [`api-reference.md` §1](api-reference.md).
2. There is no `window.nova.ready()` callback. The `nova:ready` handshake fires automatically before your scripts run (`:11879`), so top-level `await` works immediately; re-read the snapshot any time with `await novaOS.ready.get()` → `{ appId, permissions, optionalPermissions, osVersion, securityPatch, username }` (`:10770`, username only for system-bundled apps).

---

## 1. Hello world — from folder to running app

**Goal.** Build, install, and launch the smallest possible verified app, and understand exactly what happens on first launch.

**Permissions.** `device:notifications` (low risk — auto-granted, no dialog), `clipboard:read` (high risk, optional — never prompted at launch).

### Project layout

The builder takes a **parent directory** and builds every sub-directory that contains a `manifest.json` (`build-apps.mjs:470-478`):

```text
hello/                        ← parent dir (any name)
  com.example.hello/          ← folder named after the app id
    manifest.json
    index.html
    app.js
```

### `com.example.hello/manifest.json`

This exact manifest passed real validation with zero errors and zero warnings:

```json
{
  "id": "com.example.hello",
  "name": "Hello",
  "version": "1.0.0",
  "entry": "index.html",
  "description": "Smallest verified .novaapp",
  "author": "Example Co",
  "permissions": ["device:notifications"],
  "optionalPermissions": ["clipboard:read"]
}
```

Required fields are `id`, `name`, `version`, `entry` (`app-package.js:785-787`); ids must be reverse-domain (`/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/`, `app-package.js:828-831`).

### `com.example.hello/index.html`

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Hello</title></head>
<body>
  <h1 id="greeting">…</h1>
  <script src="app.js" defer></script>
</body>
</html>
```

The host forces deferred execution for packaged scripts even if you omit `defer` (`deferPackagedScripts`, `:13112`; pinned `app-sandbox.test.js:1346`).

### `com.example.hello/app.js`

```js
// window.nova / window.novaOS are injected before this file runs — no
// import, no handshake needed. Re-read the launch snapshot if you want it:
const info = await window.novaOS.ready.get();
// → { appId: 'com.example.hello', permissions: [...], optionalPermissions: [...],
//     osVersion, securityPatch, username: undefined }

await window.novaOS.storage.set('greeting', 'hello');
const value = await window.novaOS.storage.get('greeting'); // 'hello'
document.getElementById('greeting').textContent = value;
```

### Build and install

```bash
cd NBOSP
node build-apps.mjs /path/to/hello
# ✓ com.example.hello -> com.example.hello.novaapp (3 files, signed as
#   NovaByte System (TEST KEY), source untouched)
```

The output `hello/com.example.hello.novaapp` is pretty-printed JSON with `{ novabyte_app, compiled_at, manifest, files: {path: base64}, signing: { method:'ed25519', signer:'NovaByte System', tier:'test', signature:<hex> }, integrity: { method:'sha512', ... } }` (`build-apps.mjs:436-454, 496-502`). Install it by dropping the file onto **App Manager**, or App Manager → Install (picker titled `Install .novaapp`, `appmanager.test.js:91`), or double-clicking it in Files.

### What the user sees

- **First launch:** no permission dialog at all. `device:notifications` is low risk → silently auto-granted (explicit earlier user denial would win, `app-permission-manager.test.js:132`). `clipboard:read` is optional → the app must ask at point of use (Example 12).
- A window titled "Hello" showing "hello".
- The app appears in the launcher; App Manager shows it with the signer's verified badge ("✓ Verified", test-key tier — see Settings → About for `test-keys` vs `release-keys`, `trust-store.js:361-364`).

### Failure modes

| Symptom | Exact string | Source |
|---|---|---|
| Missing manifest field (build/install) | `Missing required field: id` (etc.) | `app-package.js:786` |
| Bad id shape | `Invalid app ID "Hello". Must be reverse domain format.` | `app-package.js:830` |
| Non-semver version | warning only: `Version "1" doesn't follow semver (x.y.z)` | `app-package.js:833` |
| Dropped the wrong file | `Please select a valid .novaapp package.` | `appmanager/app.js:2382` |
| Corrupt/obfuscated package | `Package is not valid JSON. Obfuscated .novaapp files are no longer supported for security reasons.` | `appmanager/app.js:2400` |
| Manifest lacks basics | `Missing required manifest fields (id, name, version).` | `appmanager/app.js:2406` |

---

## 2. Storing data — key-value storage with quotas

**Goal.** Persist small structured state per app, watch the quota, and handle the two `STORAGE_FULL` cases.

**Permissions.** None. Storage is always your app's own namespace (`nova:storage:*` is host-side IndexedDB keyed `[owner, appId, key]`, `:6615-6636`).

### Code

```js
const s = window.novaOS.storage;

await s.set('greeting', 'hello');            // mutation → undefined
await s.set('prefs', { theme: 'dark' });     // any JSON value
const v = await s.get('greeting');           // 'hello' (or null when absent)
const keys = await s.keys();                 // ['greeting', 'prefs'] (ordered)
const { usage, budget } = await s.usage();   // bytes; budget = your 256 MB default
await s.remove('greeting');
await s.clear();                             // wipes ONLY this app's namespace
```

Raw-channel equivalents (identical store, unnormalized results):

```js
await nova.ipc('nova:storage:set', { key: 'greeting', value: 'hello' });
const { value } = await nova.ipc('nova:storage:get', { key: 'greeting' });
```

### Quota behavior (pinned by `tests/integration/storage-ledger.suite.js:64-66`)

- **Namespace budget: 256 MB** per (user, app) — admin-adjustable 1 MB–2 GB.
- **Per-value cap: 5 MB** (5,242,880 bytes) — a larger value rejects with `STORAGE_FULL: Value exceeds 5242880 byte limit` (`:6917-6918`, pinned `ipc-matrix.suite.js:325`).
- **Per-user ceiling: 2 GB hard-coded** — `STORAGE_FULL: Account storage quota exceeded` / `Storage quota exceeded` (`:6778-6781, 6929`).

### What the user sees

Nothing — storage is silent. Settings' storage dashboard reads the same ledger (`StorageLedger`), so heavy use shows up there.

### Failure modes

| Cause | Error |
|---|---|
| Key outside `/^[\w\-. ]+$/` (e.g. `'a/b'`) | `INVALID_ARGS: Invalid storage key` (`:6880`) |
| Value with cycles / non-JSON | `INVALID_ARGS: Value is not JSON-serializable: …` (`:6913`) |
| Single value > 5 MB | `STORAGE_FULL: Value exceeds 5242880 byte limit` |
| Namespace > 256 MB (or user > 2 GB) | `STORAGE_FULL: Per-app storage quota exceeded` / `Account storage quota exceeded` |

Quirk worth knowing: a host-side IndexedDB outage makes `get` fail **open** (`{success:true, value:null}`, `:6885-6889`) — a storage break looks like missing data, not an error.

For anything bigger than key/value or for file-shaped data, use Example 3 or Example 17.

---

## 3. Reading and writing files — app-private data vs user-picked files

**Goal.** Save app state as files, and import/export real user documents through the picker.

**Permissions.** None for your own `/data/` tree. User-picked files are granted by the pick itself. Shared media needs `fs:read:images|video|audio`; broad shared access needs `fs:access` (manual, Settings-only).

### App-private paths — the `appdata:/` root

```js
const fs = window.novaOS.fs;

// appdata:/ maps to /data/<your-app-id>/ — no permission, no path juggling.
await fs.appdata.write('appdata:/notes/todo.txt', 'hello');
const rec = await fs.appdata.read('appdata:/notes/todo.txt'); // { data, size, modified, ... }
const dir = await fs.appdata.list('appdata:/notes');          // { files: [...] }
await fs.appdata.remove('appdata:/notes/todo.txt');
```

Raw `nova:fs:*` paths start at `/data/` and are **rewritten host-side**: `/data/notes.txt` becomes `/data/<your-app-id>/notes.txt` (`:1808-1810`). Two rules (see [`guide.md`](guide.md) and NOVAAPP.md "path rewriting"):

- Always write `/data/` **with the trailing slash**; never embed your own app id — `/data/com.example.hello/x` resolves to a double-nested `NOT_FOUND`.
- Your app root is pre-populated with `files/ cache/ databases/ shared_prefs/` subfolders — organizational only.

### User-picked files — picker returns a scoped token

```js
// OPEN: user-mediated, no permission. accept ≤ 20 MIME and/or '.ext' entries.
const opened = await window.nova.files.open({
  title: 'Import notes',
  accept: ['text/plain', 'application/json', '.json'],
});
if (!opened.cancelled) {
  const f = opened.file;               // { id, name, path, mimeType, size, content }
  // Binary files come back as base64 with f.encoding === 'base64'.
  // f.id is a picked-file token: usable with nova:fs:* for THIS sandbox's
  // lifetime — read AND write, that file only.
}

// SAVE: the user chooses the destination; you supply the bytes.
const saved = await window.nova.files.save({
  title: 'Export notes',
  filename: 'notes.txt',
  mimeType: 'text/plain',
  content: 'Exported content',
});
if (!saved.cancelled) console.log('Saved to', saved.file.path);
```

The v2 facade covers both families: `novaOS.dialog.pickOpen({ accept, multiple: true })` (multi-select ≤ 25 files → `files[]` + `file`) and `novaOS.dialog.pickSave({ suggestedName: 'out.txt' })` (`:10599-10613`).

> **Unverified:** NOVAAPP.md's v2 table shows `dialog.pickSave({ defaultName })`, but both underlying channels read `suggestedName` (`:2171`, `:9107`) and the facade passes options through unchanged — use `suggestedName`.

### The modify / rename / move caveat on shared files

A picked **shared** file (one you don't own) is usable, but every destructive mutation — overwrite, rename, move, delete — triggers a **host-side user confirmation** each time (`confirmSharedFileChange`, `:1875-1880`; NOVAAPP.md fs section). If confirmation is unavailable, the call fails with `UNAVAILABLE: User confirmation is required to overwrite a shared file` (`:9126-9128, 9254-9257`). Your own `/data/` files never prompt. `fs:access` holders skip the prompts but still never see another app's private tree (`:1821-1822`).

```js
// Write back to a user-opened file using the picked id:
await nova.ipc('nova:fs:write', { id: opened.file.id, content: 'Updated' });
```

### What the user sees

- Own-data reads/writes: silent.
- Pickers: a real system dialog; the app only ever receives what the user picked.
- Shared-file mutations: a confirm dialog naming the operation.

### Failure modes

| Cause | Error |
|---|---|
| `accept` malformed | `INVALID_ARGS: accept must be a string or an array of at most 20 MIME types and/or file extensions (e.g. ".json")` (`:8780-8783`) |
| Picked file > 10 MB | `FILE_TOO_LARGE` (`:9188-9191`) |
| Non-text file through `nova:files:open` | `UNSUPPORTED_TYPE: Selected file is not available as text` (`:9185-9187`) |
| Multi-select > 25 | `LIMIT_REACHED` (`:8950-8952`) |
| Reading another app's `/data` | `NOT_FOUND` (ownership enforced, `:1823-1824`) |
| Deleting a filesystem root | `PROTECTED_LOCATION: System filesystem roots cannot be deleted` (`:2518`) |
| Reading shared image without `fs:read:images` | `PERMISSION_DENIED` (per-media gate, `:1842-1859`) |

---

## 4. Notifications — channels, tags, actions, rate limits

**Goal.** Post user-visible notifications through declared channels, update them in place, and receive action-button taps.

**Permissions.** `device:notifications` (low risk, auto-granted) — covers every notifications channel (`:2703-2705`).

### Manifest — declare channels up front

```json
{
  "id": "com.example.chat",
  "name": "Chat",
  "version": "1.0.0",
  "entry": "index.html",
  "permissions": ["device:notifications"],
  "notifications": {
    "channels": [
      { "id": "messages", "name": "New messages", "importance": "high",
        "description": "One-to-one and group chats" },
      { "id": "sync", "name": "Sync status", "importance": "low" }
    ]
  }
}
```

Manifest channels are seeded idempotently before every post (`ensureDeclaredChannels`, `notifications/service.js:152-163`; `:1540-1549`). Or create them at runtime: `await novaOS.notifications.createChannel('messages', 'New messages', 'high')` → `{ created, channel: { id, name, importance } }`. Importance is one of `none | low | default | high` and is **locked at creation** (Android parity); `'none'` at creation maps to `'default'` — only the user can mute to `'none'` (`notifications/service.js:131-144`).

### Posting, tag updates, progress

```js
const n = window.novaOS.notifications;

const r1 = await n.post({
  title: 'Ada', body: 'Lunch at 1?', channelId: 'messages',
  tag: 'conv-42',
  actions: [{ id: 'reply', label: 'Reply' }, { id: 'mute', label: 'Mute' }],
});
// → { success: true, posted: true, updated: false, id: '…', importance: 'high' }

// Same tag updates IN PLACE (keeps position; omitted actions/progress are
// inherited — only explicit actions:[] or progress:null clears them):
await n.post({
  channelId: 'messages', tag: 'conv-42',
  title: 'Ada', body: '3 new messages',
  progress: { value: 25, max: 200 },   // or { indeterminate: true }
});

const done = await n.consumeActions();
// → { success: true, actions: [ { appId, notifId, tag, actionId, label,
//                                title, clickedAt } ] }   (drains exactly once)
```

Actions are pull-only: tapping a button opens your app and queues the tap; nothing is pushed (comment `:2845`; facade `:10566`; entry shape `notifications/service.js:194-202`). Call `consumeActions()` on launch and on regain of focus.

### Rate limits (pinned `tests/integration/ipc-matrix.suite.js:377-390`)

- **10 new posts per minute** per app → `RATE_LIMITED: Max 10 notifications per minute`.
- **60 tag updates per minute** (separate budget so progress tickers don't trip the spam limit) → `RATE_LIMITED: Max 60 notification updates per minute`.

### What the user sees

- `high` importance: toast ~8 s; `default`: ~4 s; `low`: silent, panel-only (`IMPORTANCE_DWELL_MS`, `notifications/service.js:25`). The notification panel keeps the last 100 entries per device, top 50 rendered.
- Muting your channel in the panel means posts resolve `{ success: true, posted: false, reason: 'CHANNEL_MUTED', importance }` — not an error (`:2790-2794`).

### Failure modes

| Cause | Error |
|---|---|
| Post to undeclared/unknown channel | `INVALID_ARGS: Unknown notification channel 'x' — create it first (nova:notifications:createChannel) or declare notifications.channels in the manifest` (`:2786-2789`) |
| 11th new post in a minute | `RATE_LIMITED: Max 10 notifications per minute` |
| Bad channel id at creation | `INVALID_ARGS: channel id must match ^[a-zA-Z0-9_-]+$ and be <= 64 chars` |
| > 32 channels | `LIMIT_REACHED: Max 32 channels per app` |
| Channel name missing | `INVALID_ARGS: channel requires a non-empty name (<= 60 chars)` |
| No grant | `PERMISSION_DENIED: device:notifications permission required` |

Clamps: title ≤ 120, body ≤ 500, action label ≤ 40 chars, 3 actions per notification (`:1040-1042, 1071-1072`).

---

## 5. Networking — fetch, WebSocket, and the internal/external split

**Goal.** Call HTTP APIs and hold WebSocket connections, with the right `net:*` grants.

**Permissions.** `net:external` (public HTTP(S)/WSS — auto-granted), `net:internal` (localhost, private ranges, `api.novabyte.internal`, `.local`-style names — prompted), `net:websocket` (any socket — auto-granted).

### Plain `fetch()` is intercepted

`window.fetch` (and XHR) inside your app are replaced with bridge-routed versions (`:12302-12308`); you never call `nova:net:fetch` by hand:

```js
// Requires net:external
const res = await fetch('https://api.example.com/data', {
  headers: { 'Accept': 'application/json' },
});
const data = await res.json();

// Plaintext http is allowed (no TLS floor) — but classify first:
await fetch('http://updates.example.com/feed');  // net:external
await fetch('http://127.0.0.1:3000/status');     // internal → needs net:internal
```

Classification is by literal hostname (`:1267-1288, 1388-1401`): `localhost`, `api.novabyte.internal`, RFC1918/loopback/link-local IPv4 and IPv6 → internal; everything else → external. One exception: fetching **your own bundled files** (same-origin under `/api/apps/serve/<sandboxId>/`) bypasses the bridge entirely and needs no `net:*` grant (`:11892-11925`). Response bodies are **not size-capped** on either branch; request bodies are budgeted at 16 MiB default.

### WebSocket

```js
// Requires net:websocket (+ net:internal for private/first-party hosts)
const ws = await window.novaOS.net.websocket('wss://socket.example.com/feed');
// Handle: { wsId, readyState, onMessage(cb), onError(cb), onClose(cb),
//           send(data), close(code, reason) }   (:10946-10975; v1 nova.websocket :11761)

ws.onMessage((msg) => console.log('frame', msg.data));   // push: { wsId, data } (:6549)
await ws.send({ op: 'subscribe', channel: 'prices' });
await ws.close(1000, 'done');          // defaults {code:1000, reason:'done'}
```

`ws://` plaintext is allowed; URLs with embedded credentials are rejected outright; cloud-metadata literals (`169.254.169.254`, `fd00:ec2::254`) are invalid destinations on both surfaces (`:1299-1326, 1258`).

### What the user sees

Nothing for auto-granted `net:external`/`net:websocket`. `net:internal` produces a standard permission dialog when first needed.

### Failure modes

| Cause | Error |
|---|---|
| Missing `net:internal` on private host | `PERMISSION_DENIED: net:internal permission required for private or first-party WebSocket destinations` (`:6529-6531`) |
| No `net:websocket` grant | `PERMISSION_DENIED` (MAC front door) |
| Non-HTTP(S) URL | `INVALID_ARGS: Only http and https URLs are allowed` |
| Metadata host | `INVALID_ARGS: Cloud metadata endpoints are not reachable from apps` |
| Bad method | `INVALID_ARGS: Method not allowed: TRACE` |
| Request body > 16 MiB | `PAYLOAD_TOO_LARGE: Binary request body exceeds the 16 MiB limit` (`:6438-6441`) |
| Proxy failure (external branch) | `NETWORK_ERROR` (`:6490`) |
| send on closed/unknown socket | `INVALID_STATE` / `NOT_FOUND: WebSocket connection not found` (`:6584-6588`) |

Known quirk: a WebSocket that never opens surfaces as the generic 30 s IPC timeout — there is no host reject path (`:11753-11760`).

---

## 6. Named alarms — scheduled moments

**Goal.** Run something at a future time or on a coarse period, in a live app.

**Permissions.** `system:schedule` (System / Medium).

### Code

```js
const a = window.novaOS.alarms;

await a.create({ name: 'reminder', when: Date.now() + 60_000 });   // one-shot
await a.create({ name: 'sync', periodMinutes: 30 });               // periodic
const all = await a.getAll();   // [{ name, when, periodMinutes, scheduledTime }]

const off = a.onAlarm((fire) => {
  // fire: { name, alarm: { name, when, periodMinutes, scheduledTime },
  //         firedAt: '<ISO>', queued? }        (exact payload :7995-7999)
  if (fire.name === 'sync') doSync();
});

await a.clear('reminder');      // → undefined; raw channel gives {cleared:boolean}
```

### Rules that bite

- **15-minute floor** on `periodMinutes` (WorkManager parity, `:7912`; constraint errors `:8081-8083`).
- Exactly one of `when` (future epoch ms, ≤ 1 year out) or `periodMinutes` — `INVALID_ARGS` quoting the violated constraint (`:8069-8082`).
- Names: 1–64 chars, `/^[\w.:\-]+$/`; re-creating a name replaces it (no budget burn); **max 32 alarms** → `RATE_LIMITED: Max 32 alarms per app` (`:8090-8091`).
- **Alarms never wake a closed app.** Periodic alarms skip missed cycles while closed; one-shot alarms are **queued (max 8, oldest dropped)** and delivered right after the next `nova:ready` with `queued: true` (`:7897-7902, 8021-8043`, pinned `guest-bridge.suite.js:1593`). Alarms schedule *moments*; the scheduler runs *code* — if you must run while closed, see Example 7.
- The alarm registry persists across OS reboots; timers are rebuilt at boot (`:7904-7946`).

### What the user sees

Nothing — alarm delivery is an in-app push (`nova:background:alarm`), not a notification. Post via Example 4 if the user should see something.

---

## 7. Background execution — Tier 1 wakes and Tier 2 stay-alive

**Goal.** Do periodic work while closed (Tier 1), or keep a live process after the window closes (Tier 2).

**Permissions.** Tier 1 `system:background` (Medium). Tier 2 `system:background:live` (High). Tier 3 `system:autostart` (High, boot-list + grant, no runtime API).

### Tier 1 — scheduled wake

The OS sweeps roughly every **15 minutes** and wakes eligible apps headlessly with a **10-second deadline** (`app-scheduler.js:46, 58`, pinned `app-scheduler.test.js:142-206`):

```js
// v1
window.nova.onBackgroundWake((info) => {
  // info: { wokeAt: '<ISO>', deadlineMs: 10000 }
  doQuickSync();
  window.nova.backgroundWakeDone();   // optional early finish
});

// v2 — same push, plus an off() handle
const off = window.novaOS.background.onWake((info) => {
  doQuickSync();
  window.novaOS.background.wakeDone();
});
```

If you never call `wakeDone()`, the host waits out `deadlineMs` and tears the sandbox down anyway. A wake does **not** grant `device:notifications` — posting from a wake handler needs that permission separately. The wake push can race app page load and be lost (no re-delivery, `app-scheduler.js:197-203`).

### Tier 2 — stay alive after close

Holding the grant is not enough; the app opts in **per session** (never persisted, `:2888-2891`):

```js
// Requires system:background:live
const { enabled } = await window.novaOS.background.stayAlive();     // → {enabled:true}
await window.novaOS.background.stayAlive(false);                    // opt back out
// v1: window.nova.stayAliveInBackground() / (false)
```

Once opted in, closing the window reparents the webview into a hidden host container with all live state (sockets, subscriptions) intact, for the OS-page lifetime — no time limit (`:14539-14573`).

### What the user sees

- Tier 1: nothing (headless, 1×1 px hidden wrapper).
- Tier 2: a one-time toast, then a **pinned, non-dismissible notification with a Terminate button** — the only kill switch short of the app exiting itself (`wm.js:490-501`, `notifications/service.js:654-675`). Reopening from the launcher reattaches the same process and clears the pin; closing again re-backgrounds without a second `stayAlive()` call (`:14612-14622`). A Tier-1 wake piggybacks onto a live Tier-2 sandbox without owning or killing it.

### Failure modes

| Cause | Error |
|---|---|
| `stayAlive` without `system:background:live` | `PERMISSION_DENIED` (`:2892-2906`) |
| Ineligible wake (disabled app, revoked grant, unknown id) | honest `false` from the scheduler — nothing reaches your app (`app-scheduler.js:319-354`) |

---

## 8. Push delivery — server-to-app messages

**Goal.** Let your backend wake your app with messages, including while it is closed.

**Permissions.** `push:receive` (System / Medium).

### App side

```js
const p = window.novaOS.push;

const { token, endpoint, subscribed } = await p.register();
// token: 'nps_<32 hex>' (idempotent per install), endpoint: '/api/push/publish'
// Hand `token` to YOUR backend. If subscribed === false (offline), retry.

const off = p.onMessage((message) => {
  // message: { appId, id, title?, body?, data?, sentAt, queued? }
  if (message.queued) drainAfterRelaunch(message.data);
});

await p.unregister();   // revokes the token and drops the queue
```

### Backend side

```bash
curl -X POST https://<os-host>/api/push/publish \
  -H 'content-type: application/json' \
  -d '{"token":"nps_…","title":"New message","body":"Ada says hi",
       "data":{"conversationId":"c-42"},"id":"msg-7"}'
```

The endpoint is **untrusted by design** — the token is the capability (`push-routes.js:9-20, 91-134`). Success `200 {delivered:true}`; offline `202 {delivered:false, reason:'device-offline'}` (backlog replays once on reconnect); unknown token `404 {delivered:false, reason:'unknown-token'}`; malformed fields `400` with reasons `invalid-token|invalid-title|invalid-body|invalid-id|invalid-data|data-too-large`.

### Delivery ladder (re-checked on every message, `:8348-8393`)

| App state | What happens |
|---|---|
| Running (window or Tier-2 keep-alive) | `nova:push:message` push — immediate |
| Closed, holds `system:background` | Queued (≤ 8) + Tier-1 wake requested; flushes right after the woken ready handshake |
| Closed, message has title/body | OS displays a notification **attributed to your app** (same sanitizer + your 10/min notification budget) and queues the data |
| Closed, data-only | Queued (≤ 8), delivered after next `nova:ready` with `queued: true` |
| Revoked / disabled / uninstalled | Dropped at the door |

Message caps at the publish endpoint: `title` ≤ 200, `body` ≤ 2000, `data` a JSON object ≤ 4 KB, `id` ≤ 64 chars.

> **Unverified:** no per-day publish-volume budget (e.g. "200 publishes/day") exists anywhere in the notes or the server code — do not build against one. The only volume limits are the field caps above and the server's global API rate limit.

### What the user sees

Nothing until a message with `title`/`body` lands while the app is closed — then an OS notification in your app's name. Push is live-delivery semantics, not a mailbox: the server keeps only a small in-memory backlog (last 16 messages / 24 h per token). For must-not-lose data, push a pointer and fetch over your own channel.

---

## 9. App-to-app IPC — providers, callers, broadcasts

**Goal.** Two of your apps (or cooperating third-party apps) exchange data through host-brokered endpoints and broadcasts.

**Permissions.** `apps:communicate` (High) on **both** sides. Every endpoint/action must be declared in the manifest before it can be registered (`:6207, :6293-6295`; pinned `app-sandbox.test.js:1031`).

### Provider — `com.example.contacts`

```json
{
  "id": "com.example.contacts",
  "permissions": ["apps:communicate"],
  "ipc": {
    "exports": ["provider:com.example.contacts.lookup"],
    "receives": ["com.example.notes.changed"]
  }
}
```

```js
const stop = await window.nova.ipc.provide(
  'provider:com.example.contacts.lookup',
  async ({ endpoint, sourceAppId, data }) => {   // handler arg shape :11194-11206
    if (data?.query !== 'Ada') return null;
    return { id: 'contact-1', name: 'Ada' };
  }
);
// stop() unregisters.
```

### Caller — any other app holding `apps:communicate`

```js
const response = await window.nova.ipc.call(
  'com.example.contacts',
  'provider:com.example.contacts.lookup',
  { query: 'Ada' }
);
console.log(response.result);   // provider's return value, spread onto the response
```

### Broadcast

```js
const off = await window.nova.ipc.onBroadcast(
  'com.example.notes.changed',
  ({ sourceAppId, data }) => refreshNote(data.noteId)
);
await window.nova.ipc.broadcast('com.example.notes.changed', { noteId: 'note-1' });
// → { delivered: <count of matching live subscribers> }
```

### Rules

- Endpoint names: `^(?:service|provider):[a-z0-9][a-z0-9._-]{0,127}$`; actions: `^[a-z0-9][a-z0-9._:-]{0,127}$` (`:6101-6102`).
- Requests time out after **25 s** (`APP_IPC_TIMEOUT_MS`, `:6100`).
- Payloads clamped to your `ipcPayloadBytes` budget — **256 KB default** (`:6120-6131`; ledger pin `storage-ledger.suite.js:64-66`).
- Rate limit **20 per minute** per app per type (invoke / broadcast separately) (`:6133-6144`).
- The host never starts a provider implicitly — the target must be live and registered.
- Sandbox closure cancels in-flight calls: `'An app sandbox closed before the IPC request completed'` (`:6150-6158`).

### What the user sees

Nothing — this is app-to-app plumbing. Treat request and response data as untrusted on both sides; providers return only the minimum needed.

### Failure modes

| Cause | Error |
|---|---|
| Either side lacks the grant | `PERMISSION_DENIED: apps:communicate permission required` (`:6199` on invoke, `:6163` on register) |
| Endpoint not in provider's `manifest.ipc.exports` | `NOT_FOUND: Target app does not export this endpoint` (`:6207`) |
| Provider installed but not running | `UNAVAILABLE: Target endpoint is not running` (`:6213-6221`) |
| 21st call in a minute | `RATE_LIMITED: Max 20 app IPC calls per minute` |
| 21st broadcast in a minute | `RATE_LIMITED: Max 20 app broadcasts per minute` (`:6320-6321`) |
| Payload over budget | `PAYLOAD_TOO_LARGE: IPC payload exceeds the 256 KB limit` |
| Provider never replies | `REMOTE_ERROR: Target app did not respond before the IPC timeout` |
| Registering an undeclared endpoint | `PERMISSION_DENIED: Endpoint is not declared in manifest.ipc.exports` |

---

## 10. Share target — receiving shares from other apps

**Goal.** Appear in the OS share sheet and receive shared text/URLs, even while closed.

**Permissions.** `system:share-target` (System / Medium).

### Manifest + code

```json
{
  "shareTarget": { "mimeTypes": ["text/plain", "text/uri-list"] }
}
```

```js
const off = window.novaOS.share.onInbound((share) => {
  // share: { title, text, url, sourceAppId, firedAt, queued? }
  importSnippet(share.text ?? share.url);
});
```

MIME patterns accept `type/*` and `*/*` wildcards; ≤ 20 patterns, no duplicates (`app-package.js:864-891`). Outbound side needs no permission: `await nova.share({ title, text, url })` opens the sheet (≤ 5 sheets/min; at least one of `text`/`url`; `url` must be credential-free HTTP(S)).

### Delivery semantics

- Delivery is **user-mediated**: the other app opens the sheet, the OS lists at most **6 matching targets**, and the user's pick is the consent (`:4221-4231`, `apps.md` §6).
- A live sandbox gets the `nova:share:inbound` push immediately; a closed target has the entry **queued (max 8)** and delivered right after its next launch with `queued: true` (`:7868-7889`). The pick may open your window; the push never starts an app by itself.
- Content is clamped to `title` ≤ 120 / `text` ≤ 4000 chars on delivery. Shares are **text/URL only** — no binary file sharing exists.

### What the user sees

Your app's name (and icon) in the share sheet, listed as "Send to \<Your App\>". After picking, your app opens with the shared content.

---

## 11. Secrets — small encrypted credentials

**Goal.** Store API tokens/passwords encrypted at rest, isolated per app.

**Permissions.** `secrets:store` (Data / Medium).

### Code

```js
const sec = window.novaOS.secrets;

await sec.set('api-token', 'dN0tARealToken');        // → undefined
const token = await sec.get('api-token');             // plaintext | null
const labels = await sec.keys();                      // your key names, sorted
await sec.delete('api-token');
```

AES-256-GCM at rest under a per-install 32-byte master key; plaintext never touches disk (`app-secrets.test.js:56-106`).

### Rules

- Budgets: **64 secrets per app, 8 KB (8192 bytes) per value, 128-char keys** (module-enforced, `app-secrets.js:37-39`; pinned `app-secrets.test.js:44-46`).
- **Secrets are excluded from data export/backup envelopes** — a backup can never carry credentials (Example 17). Encrypt it yourself if you truly need it portable.
- No cross-app reads, ever. Tampered ciphertext reads back as `null` (GCM auth), not an error (`app-secrets.test.js:199-212`).
- If the master key can't persist (locked-down FS), `set` still works but the raw channel responds `persisted: false` — surface that to the user (`:8130-8138`; `app-secrets.test.js:84`).

### Failure modes

| Cause | Error |
|---|---|
| 65th secret | `RATE_LIMITED` — message contains `Max 64` (`app-secrets.test.js:175`) |
| Value > 8192 UTF-8 bytes | `INVALID_ARGS` — message contains `8192 bytes` (`app-secrets.test.js:152`) |
| Key empty / 129 chars / untrimmed / control chars | `INVALID_ARGS` (`app-secrets.test.js:135`) |
| No grant | `PERMISSION_DENIED: secrets:store permission required` (`:8132`) |

Note: secrets survive uninstall (no host-side wipe) and are silently re-inherited by a reinstall of the same id — a documented residue (`packaging.md` §6).

---

## 12. Small surfaces — clipboard, badge, wallpaper, appearance, locale, window

**Goal.** One verified snippet per utility surface. All are complete; none needs a manifest beyond the named permission.

```js
// Clipboard — write auto-granted (clipboard:write), read needs clipboard:read (high)
await window.novaOS.clipboard.writeText('copied');
const text = await window.novaOS.clipboard.readText();   // string | null
// Write with no system clipboard → CLIPBOARD_UNAVAILABLE; a failed read
// falls back to the last value this OS instance wrote. Raw: nova:clipboard:read/write

// Taskbar badge — system:badge; 0–999 or {text} 1–4 chars; 30/min; session-only
await window.novaOS.badge.set(3);
await window.novaOS.badge.set({ text: 'new' });
await window.novaOS.badge.clear();

// Wallpaper — NO permission; two allowlisted settings keys (system:settings exempt)
await window.novaOS.settings.set('wallpaperId', 'stock-teal');        // preset id only
await window.novaOS.settings.set('customWallpaper', dataUrl);         // image URL/data:
await window.nova.wallpaper.set('wallpaperId', 'stock-purple');       // legacy bridge
// Presets: stock-blue|dark|light|green|purple|red|gray|teal. Kiosk policy
// prohibitWallpaperChange → POLICY_BLOCKED. wallpaperId takes a PRESET id,
// never an image → INVALID_ARGS (exact strings :2994-2998).

// Appearance — get/onChange need no permission; set is allowlisted, 10/min
const look = await window.nova.appearance.get();
const off = await window.nova.appearance.onChange((a) => renderTheme(a.theme));
await window.nova.appearance.set({ theme: 'nord', accentColor: '#5e81ac',
                                   reduceMotion: true });
// Themes: nova-dark|nova-light|nord|dracula|catppuccin|tokyo-night|gruvbox.
// theme is an OS id, NOT a light/dark token — map it, don't assign it raw.

// Locale — no permission by design (same facts a web page gets)
const { locale, region, timeZone, firstDayOfWeek } = await window.novaOS.locale.get();

// Window controls — no permission
await window.novaOS.window.setTitle('My App — Editing');
await window.novaOS.window.resize(1200, 800);
await window.novaOS.window.maximize();      // also close(), minimize()
const ws = await window.novaOS.window.getState();
// → { id, x, y, width, height, maximized, minimized }   (:10584-10589)
```

Failure modes worth catching: badge over 30/min → `RATE_LIMITED: Max 30 badge updates per minute` (`:7556`); appearance 11th change/min → `RATE_LIMITED: Max 10 appearance updates per minute` (`:8660-8663`); unknown appearance field or theme → `INVALID_ARGS`; wallpaper under `prohibitWallpaperChange` → `POLICY_BLOCKED`.

---

## 13. Registry — typed app configuration

**Goal.** Store typed, user-inspectable configuration in the OS registry and react to changes.

**Permissions.** `registry.read` (Low) for get/stat/list/export/watch; `registry.write` (Medium) for set/remove/import.

### Code

```js
const reg = window.novaOS.registry;

// Your supported home: the DEFAULT write scope every scope-less manifest gets:
// HKNU/software/<your-app-id>/  (notes/tests.md, novareg-sandbox.test.js:331)
await reg.set('HKNU/software/com.example.player/volume', 80, 'REG_DWORD');
await reg.set('HKNU/software/com.example.player/library', { paths: ['/x'] }); // auto REG_JSON
const vol = await reg.get('HKNU/software/com.example.player/volume');         // 80 | undefined

// Your machine-scoped subtree (also writable with plain registry.write):
await reg.set('HKNA/com.example.player/lastPlaylist', { tracks: [1, 7, 9] });
const stat = await reg.stat('HKNA/com.example.player/lastPlaylist'); // { found, type, data }
const listing = await reg.list('HKNA/com.example.player');           // { path, keys, values }

// Watch — prefix-filtered sugar over the nova:reg:changed event
const off = await reg.watch('HKNA/com.example.player', (change) => {
  // change: { path, type, value, appId, source }
});

await reg.remove('HKNA/com.example.player/lastPlaylist');           // non-empty key → recursive:true
```

### Hive rules and quotas

- Writable with plain `registry.write`: your `HKNA/<appId>/**` subtree and your default `HKNU/software/<appId>/` slice. `HKNU` elsewhere needs `registry.system` (Critical); `HKNS` is system-apps-only; `HKNS/security` needs `registry.system` even to read; `HKND` needs Developer Mode (`novareg-sandbox.test.js:117-168`).
- A manifest `registryScopes: { write: ['HKNU/…'] }` (≤ 32 prefixes) unlocks designated HKNU slices; declaring the field **replaces** the default scope (even an empty object opts out) (`novareg-sandbox.test.js:299-375`).
- `HKCU` is an alias for `HKNU`; a bare key path addresses the key's `(default)` value.
- Engine quotas: path depth 16, name length 64, **value size 256 KB** (`nova-registry.js:83-95`) → `QUOTA_EXCEEDED`.
- Writes are audited with your app id as actor (`novareg-sandbox.test.js:319`).

### What the user sees

Nothing directly; NovaReg (Developer Mode) shows your `HKNA`/`HKNU/software` subtrees with friendly names.

### Failure modes

`PERMISSION_DENIED` (missing grant, foreign `HKNA`, `HKNS/security` without `registry.system` — message `Blocked by system security policy (MAC): …`); `INVALID_ARGS` (malformed path, e.g. `BOGUS/x` or trailing slash); `SUBTREE_NOT_EMPTY` (deleting a non-empty key without `recursive: true`); `QUOTA_EXCEEDED` (oversized value); `NOT_FOUND`; per-key ACL denials surface as `PERMISSION_DENIED: key ACL denies read|write`.

---

## 14. Default apps and file-open intents

**Goal.** Let the user open files of your declared types with your app, and consume the resulting open intent.

**Permissions.** None — `handles` is a discovery/selection declaration, not a permission. Launching other apps needs `system:app-launch` (30 launches/min → `RATE_LIMITED`, `app-sandbox.test.js:2446`).

### Manifest

```json
{
  "handles": {
    "extensions": [".webp", ".heic"],
    "mimeTypes": ["image/heic", "image/webp"],
    "protocols": [],
    "roles": []
  }
}
```

All four keys are optional and independent; arrays ≤ 100 strings; `roles` supports exactly `home` (`app-package.js:834-863`). Extensions include the leading dot; matching is case-insensitive; MIME wildcards like `image/*` are supported.

### Receiving a file open intent

When the user opens a matching file through the desktop, **Open with...**, or a per-type default, the launch options carry a `fileIntent` and the host grants access to that one file only (re-checked against your live declaration at every launch, `:13932-13946`):

```js
const intent = window.__NOVA_APP_OPTIONS__?.fileIntent;
// intent: { action: 'open', file: { id, name, mimeType } }
if (intent?.action === 'open') {
  const file = await nova.ipc('nova:fs:read', { id: intent.file.id });   // file.data
  await nova.ipc('nova:fs:write', { id: intent.file.id, content: 'Updated' });
}
// Or the facade route: const opts = await nova.app.getLaunchOptions();
```

Scoped rules: read/write **by file id only** — no directory listing, no sibling files. Cross-app `nova:app:launch` strips any caller-supplied `fileIntent`/`fileId`/`folderId` ("file access must come from a host user-selection flow", `:3927-3930`).

A sandboxed file manager can show the OS chooser itself: `await nova.openWith(fileId)` → `{ cancelled, success, appId, windowId, defaultSaved }`; foreign file ids → `NOT_FOUND` (`app-sandbox.test.js:1148-1186`).

### What the user sees

Your app appears in Settings → Default Apps (per category where your types overlap a route) and in every **Open with...** menu for matching files. The chooser's "Always use this app for this file type" checkbox persists a per-type default (`extension:.heic` keys, `default-apps.test.js:95`).

---

## 15. Calendar, contacts, mail — shared provider snippets

**Goal.** One working call per surface. All three read/write the **same shared data** the built-in apps use — not per-app stores (`:11807-11809`).

```js
// Calendar — calendar:read / calendar:write / calendar:delete
const events = await window.novaOS.calendar.list();
await window.novaOS.calendar.save({
  id: 'standup-1', title: 'Standup', date: '2026-07-20',
  color: '#3fb950',   // optional; must be one of the 8 preset colors
});
const removed = await window.novaOS.calendar.remove('standup-1');  // boolean

// Contacts — contacts:read / contacts:write / contacts:delete
const contacts = await window.novaOS.contacts.list();
await window.novaOS.contacts.save({ id: 'c1', name: 'Jane Doe', email: 'jane@example.com' });
await window.novaOS.contacts.remove('c1');   // false when absent

// Mail — mail:read / mail:write / mail:send / mail:delete
// Acts on the host Email app's ONE connected session (account-global).
const acct = await window.nova.mail.account();       // { restored, type, host, user }
const { data } = await window.nova.mail.messages({ folder: 'INBOX', page: 1, limit: 20 });
await window.nova.mail.send({
  to: 'someone@example.com', subject: 'Hello', text: 'Hi there',
  smtpHost: 'smtp.example.com', smtpPort: 587,   // smtpHost is MANDATORY
});
```

Calendar `color` presets (frozen, `:7290`): `#58a6ff #3fb950 #d29922 #f85149 #bc8cff #ff7b72 #79c0ff #56d364` — any other value silently falls back to `#58a6ff`.

Failure modes: calendar event without title or `YYYY-MM-DD` date → `INVALID_EVENT: Event must have a title and a YYYY-MM-DD date` (`:7337`); contact without a name → `INVALID_CONTACT: Contact must have at least a name` (`:7408`); mail with nothing connected → `UNAVAILABLE: No email account connected — open the Email app and connect an account first` (`:5484-5486`); missing `smtpHost` → `INVALID_ARGS: smtpHost is required — the server has no way to infer it from the connected IMAP/POP3/EWS account (they are frequently different hosts)` (`:5648`); `mail.connect({ssl:false})` → `INVALID_ARGS: Plaintext connections are not supported` (`:5504-5507`).

---

## 16. Nested webview — an in-app browser view

**Goal.** Embed a host-managed browser view (site viewports, OAuth pages, help content).

**Permissions.** Double gate: manifest `"allowNestedWebview": true` **and** a live `sandbox:nested-webview` grant; plus `net:external` (and `net:internal` for private destinations). The opt-in alone exposes the API surface, but every host call still enforces the grant (`app-sandbox.test.js:1237, 2614`).

### Manifest

```json
{
  "id": "com.example.browser",
  "allowNestedWebview": true,
  "permissions": ["sandbox:nested-webview", "net:external"]
}
```

### Code

```html
<div id="browser-viewport" style="height: 600px"></div>
```

```js
const view = await window.nova.browser.createView({
  container: document.getElementById('browser-viewport'),  // required Element
  url: 'https://example.com',
  pollingInterval: 1000,   // 0 or 250–10000 ms
});

view.addEventListener('url-change', (e) => { address.value = e.detail.url; });
view.addEventListener('title-change', (e) => { document.title = e.detail.title; });
view.addEventListener('state-change', (e) => {
  backBtn.disabled = !e.detail.canGoBack;
});
view.addEventListener('navigation-error', (e) => {
  status.textContent = e.detail.errorDescription || 'Navigation failed';
});

await view.navigate('https://example.org/docs');
await view.back();  await view.reload();
await view.destroy();
```

`window.nova.browser` only exists when the manifest opted in (`:12911`); without the grant, host-side creation rejects with `PERMISSION_DENIED` and live views are revoked when the grant is revoked (`app-sandbox.test.js:1220, 1265`). Nested sites get their own stable partition (`persist:app_<id>_webcontent`) — they never inherit your app sandbox (`system-webview/service.js:34`). Navigation is gated by the same URL classification as Example 5; embedded credentials in URLs are refused (`:10016`). Non-opted-in apps get an inert `<span>` instead of a `<webview>` element — a security block, not a crash (`:12962-12975`).

What the user sees: a live page inside your app's content area, bounded to it, with your chrome around it.

---

## 17. Data export / backup / restore — portable envelopes

**Goal.** Move your app's key/value namespace (Example 2 store) between installs and versions.

**Permissions.** `data:export` (Low) for export/import subsets; `data:backup` (Low) for full snapshots.

### Code

```js
const d = window.novaOS.data;

// Subset export (requires data:export)
const { envelope } = await d.export({ prefix: 'recipes.' });   // or { keys: [...] }
await d.import(envelope);   // MERGE only — never deletes keys it doesn't contain

// Full backup (requires data:backup)
const { envelope: snapshot } = await d.backup();
const result = await d.restore(snapshot, { clearFirst: true });
// → { success: true, restoredKeys: 2, cleared: true, failedKeys: [] }
```

Envelope shape — versioned, checksummed, **pinned to your app id**:

```json
{
  "novaDataEnvelope": 1,
  "format": 1,
  "kind": "backup",
  "appId": "com.example.myapp",
  "capturedAt": "2026-11-04T12:00:00.000Z",
  "storage": { "recipes.pancakes": "…" },
  "counts": { "keys": 1, "bytes": 42 },
  "checksum": "<sha256 hex over key-sorted serialization of storage>"
}
```

Rules enforced in order (`:7021-7136`, pinned `app-sandbox.data-portability.test.js`): kind must match the channel (`restore` wants `backup`, `import` wants `export`) → `INVALID_ARGS`; an envelope whose `appId` isn't you → `POLICY_BLOCKED: envelope belongs to a different app — envelopes only restore into their own app`; checksum mismatch → `INVALID_ARGS: envelope checksum mismatch — the data is corrupt or was modified` (nothing is written); values over the 5 MB per-value cap are reported per-key in `failedKeys` instead of failing the call. Export requires a selector and caps `keys` at 1000 (`:7145-7146`). The OS never stores envelopes for you — persist them via `nova.files.save` or your own export flow.

What the user sees: whatever file flow you build around it. Secrets are never included (Example 11).

---

## 18. Dev workflow — build, install, inspect

**Goal.** The tightest develop → install → debug loop.

### 1. Build

```bash
cd NBOSP
node build-apps.mjs /path/to/parentdir            # every app dir with a manifest.json
node build-apps.mjs /path/to/parentdir com.example.hello   # build just one
```

Rebuilds are safe: same-id output is overwritten; source dirs are untouched (`build-apps.mjs:505-516`). Release signing: set `NBOSP_SYSTEM_SIGNING_KEY_PATH` (JWK) → tier `release`; default builds sign with the committed AOSP-style test pair → tier `test` (`build-apps.mjs:228-273`).

### 2. Install

Two dev surfaces (both need **Developer Mode** enabled in Settings):

- **App Manager** (no devMode needed for install, needed for dev-only apps): drag the `.novaapp` onto the window, or the Install picker. Scan → integrity → trust verification run on every manual install; unsigned/tampered packages get warn dialogs with an Install-Anyway proceed, while claimed-but-unproven `system: true` packages are hard-blocked with no override (`appmanager/app.js:176-243, 2519-2556`).
- **Packages** (`com.nbosp.packages`, dev-only): gate text `Enable Developer Mode in Settings to use Packages.`; paste the package JSON (or carry it from the Sign tab) → Install. Success message: `Test App v1.0.0 installed and registered.` (`packages.test.js:117, 283`). The `skipVerify`/`allowUnverified` checkboxes exist but are dev-unsafe by their own labels.

A replace keeps your app's data: package files are rewritten, but `/data/<id>`, storage namespace, and permission grants survive (only uninstall wipes them — `packaging.md` §5, §6).

### 3. Inspect with devconsole

Open **Devconsole** (`com.nbosp.devconsole`, dev-only; eval banner `Console ready.`). It evals against the host page, so inspect registry/engine-level state directly:

```js
// In devconsole (host context, not your app's sandbox):
NovaAppPackageStore.loadRegistry()[0]        // installed package metadata
AppPermissionManager.getAppPermissions('com.example.hello')
NovaRegistry.list('HKNU/software/com.example.hello')
EventLog.getAll().slice(-20)
```

History persists to `HKND/console/history` (`devconsole.test.js:187`). Companion dev tools: **Permissions** (grant/revoke without prompts), **NovaReg** (registry editor, friendly names for your app subtrees), **Inspector** (APP_REGISTRY/window inventory), **Modules** (hot-reload any OS module — powerful and dangerous).

### Common loop failures

| Symptom | Fix |
|---|---|
| `App directory not found: <name>` | arg 2 is the parent dir; args 3+ select app dirs inside it (`build-apps.mjs:548`) |
| `- skip <dir>: no manifest.json, not an app dir` | each app needs its own `manifest.json` (`build-apps.mjs:470-478`) |
| Entry missing at launch (`Entry file not found in package.`) | builder/installer don't check `entry` against `files` — keep names in sync (`nova-app-launcher.test.js:229`; `packaging.md` §9.10) |
| Dev app won't open | Developer Mode off → `Developer Mode Required` modal / dev gate text |
| Old code still running | same-id installs replace package files, but the sandbox must relaunch; use App Manager → Force Stop |

---

## Cross-reference

Manifest fields, build, signing tiers: [`guide.md`](guide.md) · every channel, facade method, and consolidated rate-limit table: [`api-reference.md`](api-reference.md) §5, §7 · permission catalog, prompt anatomy, anti-prompt-bomb limiter: [`permissions.md`](permissions.md) §1–§4 · sandbox engine, MAC policy, transport hardening: [`internals.md`](internals.md) §5–§6.
