# NovaByte OS .novaapp API Reference

Complete reference for the app-facing IPC surface of NovaByte OS (NBOSP): every `nova:*` channel, the `window.nova` (v1) facade, the `window.novaOS` (v2) facade, pushed events, rate limits, quotas, error codes, and legacy compatibility.

**Audience:** `.novaapp` developers. Sibling documents: [`guide.md`](guide.md) (manifest/packaging), [`permissions.md`](permissions.md) (permission catalog, prompts, runtime requests), [`examples.md`](examples.md) (recipes), [`internals.md`](internals.md) (OS implementation detail).

**Citation convention:** all bare `:NNNN` line references point at `NBOSP/js/platform/security/app-sandbox.js` (the sandbox/IPC engine). Other files are cited as `path:line`. Every channel name, number, and error string below was verified against the code and the audit notes; nothing is invented.

---

## 1. How to use this reference

Apps reach OS capabilities through **three layers**, from lowest to highest:

| Layer | What it is | Use it? |
|---|---|---|
| **Raw channel protocol** | String-typed request/response messages on the sandbox IPC bridge. Every OS capability is a channel named `nova:<family>:<verb>` (e.g. `nova:storage:get`). Historically this rode on `window.postMessage`; `.novaapp` apps now get a hardened transport (one-shot `MessageChannel` port handshake, console-marker + isolated-world payload parking — see [`internals.md`](internals.md)). Reachable from app code via `nova.ipc(type, payload)`. | **Not recommended.** No argument sugar, no result normalization, no local validation; you handle raw envelopes and error codes yourself. Only useful for channels that have no facade method. |
| **`window.nova` (v1 facade)** | The original namespaced facade (`nova.files.open()`, `nova.app.launch()`, `nova.mail.send()`, …). Mutable object assigned at `:11550`. | Supported and stable, but superseded by v2 for new code. |
| **`window.novaOS` (v2 facade)** | The current facade: `Object.freeze`'d at `:10361` (every namespace is individually frozen too), `apiVersion: 2`, normalized return values (`storage.get()` resolves the value, not `{success, value}`). | **Recommended.** |

Facts that hold for all three layers:

- **Every facade method maps 1:1 onto a `nova:*` channel.** The facades are pure sugar: they do not bypass or re-implement host-side path rewriting, MAC permission checks, or quotas — "the host handler is still the only boundary" (`:10411-10416`). §5 gives the full channel-to-facade mapping.
- **`window.novaOS` is `Object.freeze`'d** (`:10361`); `window.nova` is **not frozen** (`:11550`) and is in fact mutated later to add `nova.browser` when the app opts into nested webviews (`:12911`).
- Permission checks happen **host-side on every call**. Declaring a permission in the manifest is necessary but never sufficient; grants can be revoked mid-session (revocation closes windows / cleans up — `:14388-14419`). See [`permissions.md`](permissions.md) for the catalog and prompt behavior.
- There is **no `app.isSandboxed()`** anywhere in the OS (grep-verified). Feature detection is `novaOS.capabilities.has(name)`; identity/permission state comes from `novaOS.ready.get()` / `nova.app.getInfo()`.
- `novaOS.capabilities.has(name)` is **feature detection only** — "a capability name says the runtime ships the surface, not that the app may use it" (`:10256-10272`). The 28 capability names are listed in §4.1.

Layer choice in one line: use `novaOS.*` when a method exists there, `nova.*` for the v1-only surfaces (`appearance`, `contextMenu`, `overlay`, `wallpaper`, `home`, `files`, `browser`), and `nova.ipc(type, payload)` only for channels without a facade method (e.g. `nova:net:fetch` is normally reached through the patched `fetch()`, not called by hand).

---

## 2. Calling conventions

### 2.1 Request/response envelope

A call travels app-main-world → isolated-world transport → host, and back:

```text
novaOS.storage.set('k', v)
  └─ shim: ipc('nova:storage:set', {key:'k', value:v})
       └─ port message:  {kind:'request', type:'nova:storage:set', payload:{...}, requestId:'shim_<uuid>'}   (:11138)
            └─ isolated world: payload parked at window.__novaOutboxPull[requestId] (:10129);
               console message '__NOVA_IPC__:' + {type, requestId} only (:10130) — secrets never hit the log stream
                 └─ host handleAPICall: legacy alias → forbidden-set → handler lookup → MAC front door → handler (:9569-9614)
       ┌─ host respond(): {type:'nova:storage:set:response', requestId, result, error}   (:1660-1668)
  ┌─ isolated world: base64-JSON pushed into window.__novaInbox, drained by 50/250 ms poller (:10150-10177)
┌─ shim resolve: Object.assign({}, msg.result, {result: msg.result, type: msg.type})   (:11361)
```

- **Request (over the port):** `{kind:'request', type, payload, requestId}`. `requestId` is `shim_`/`xport_` + `crypto.randomUUID()` (fallback timestamp+random) (`:11102-11107`).
- **Response (host → app):** `{type: '<type>:response', requestId, result, error}`. On success `error` is absent and `result` is the handler's payload; on failure `result` is absent and `error` is `{code, message}` (`:1660`, `:1704`).
- **Resolve shape:** every resolved value carries the result fields **flattened at the top level and nested under `.result`** (a documented compat hack so default-shell code can read handshake fields directly, `:11358-11361`). `msg.type` is also copied onto the resolved object.
- **Fire-and-forget variant** (`ipcFireAndForget`, `:12312-12317`): no pending-request entry; used only by internal audit hooks (`nova:audit:eval`, `nova:audit:blocked-nested-webview`).

### 2.2 Error envelope and how errors surface

On the wire a failure is `error: {code, message}`. Through the facades it surfaces as a **rejected Promise**:

```js
// reject = Object.assign(new Error(message || 'IPC error'), msg.error)   (:11353-11355)
try { await novaOS.storage.set('bad/key', 1); }
catch (e) {
  e.code;     // 'INVALID_ARGS'
  e.message;  // 'Invalid storage key'
}
```

Conceptually: `{success: false, error: 'CODE', message?}`. Host handlers that *resolve* instead of rejecting still use `success:false` result bodies for user cancellations (e.g. `nova:download` cancel resolves `{success:false, cancelled:true}`, `:3861`; shared-file delete confirm-cancel resolves `{cancelled:true}`).

Error origins, in dispatch order — the first one wins:

| Stage | Code | Typical message |
|---|---|---|
| Legacy alias translation (`:9560-9575`) | — | never fails; unknown names pass through |
| Host-only set (`:9577-9579`) | `PERMISSION_DENIED` | `This system capability is only available through trusted OS UI` |
| Unknown channel (`:9580-9583`) | `UNKNOWN_API` | `Unknown API: <type>` |
| MAC front door (`:9584-9596`) | `PERMISSION_DENIED` | `Blocked by system security policy (MAC): requires <perms joined ' \| '>` or `… (MAC): no policy rule for this endpoint` |
| Handler validation | `INVALID_ARGS`, `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`, … | per-handler (§5, §8) |
| Handler throw/reject (`:9608-9612`) | `INTERNAL_ERROR` | raw error message |
| Shim timeout (`:11130-11134`) | — (TypeError) | `IPC request timed out: <type>` |
| Transport failure (`:10134-10135`) | `TRANSPORT_ERROR` | console channel broken |

**Thrown vs rejected (client-side validation):** facade-level argument checks are inconsistent by design history — know which flavor each method uses:

| Behavior | Members |
|---|---|
| Rejects with `TypeError` (Promise) | `nova.ipc.provide`, `nova.ipc.onBroadcast` (`:11507-11508`, `:11527`), `nova.appearance.onChange` (`:11573-11574`), `nova.getUserMedia`/`novaOS.media.getUserMedia` (no video/audio, `:11793-11795`), all v2 callback registrars (`novaOS.fs.watch`, `alarms.onAlarm`, `push.onMessage`, `share.onInbound`, `background.onWake`, `registry.watch`, `net.websocket` handle callbacks — all `callback must be a function`) |
| **Throws synchronously** (TypeError) | `nova.overlay.onEvent` (`:11621`), `nova.app.onLaunch` (`:11639`), `nova.app.onStateChange` (`:11654`), `nova.browser.createView` (TypeError/RangeError, `:12913-12920`), `nova.browser.download` (TypeError, `:12938`) |
| No validation at all | `nova.onBackgroundWake` — the only callback registrar with no `typeof` check and **no `off()`** (`:11731-11733`) |
| Rejects with host error | everything else (host-side `PERMISSION_DENIED`, `RATE_LIMITED`, …) |

### 2.3 The ready handshake

- The shim **automatically fires `ipc('nova:ready', {})` at load** (`:11879-11881`), before app scripts run (the shim is unconditionally prepended, `:13078-13093`). Every app gets one handshake whether it asks or not; the default app shell never sends a second one (`:13286-13291`).
- The ready response carries the app's authenticated launch snapshot: `{appId, permissions[], optionalPermissions[], osVersion, securityPatch, username}` — `username` only when `app.system === true` (`:8711-8733`). A copy is stashed at `window.__novaPermResponse` for late scripts (`:11370`).
- Right after responding, the host **flushes queued deliveries** in this order: queued one-shot alarms (`nova:background:alarm` with `queued:true`), queued inbound shares (`nova:share:inbound`), queued push messages (`nova:push:message`) (`:8743-8770`).
- To re-read the snapshot in app code: v1 `await nova.app.getInfo()` (same channel), v2 `await novaOS.ready.get()` (normalized; safe to repeat — the queues drain once, `:10762-10769`). **There is no `window.nova.ready` method.**
- **Await permission state before branching on it.** Calls made before the handshake resolves still work (the bridge is up first), but they will be evaluated against the *current* grant set; queued background deliveries only arrive after ready. Practical pattern:

```js
const info = await novaOS.ready.get();     // or nova.app.getInfo()
if (!info.permissions.includes('net:external')) { /* degrade */ }
```

### 2.4 Timeouts

| Timer | Value | Applies to | Source |
|---|---|---|---|
| `REQUEST_TIMEOUT_MS` | ledger budget `requestTimeoutMs` (**default 60 s**; 30 s fallback when no budget is baked) | every non-interactive `ipc()` call | `:11024`, `:267` |
| `INTERACTIVE_TIMEOUT_MS` | **10 minutes** | the 11 human-dialog channels below | `:11040` |
| App-IPC invoke | **25 s** host-side | `nova:ipc:invoke` waiting for the provider app's reply | `:6100` |
| Isolated-process dispatch | **30 s** | `nova:*` calls from Tier-2 worker processes (no webview) | `:9657` |
| Download save dialog | **5 min** | `nova:download` | `:230`, `:3846` |
| Overlay render | **15 s** | `nova:overlay:show` | `:3432-3434` |

Interactive channels (10-min timeout): `nova:context-menu:show`, `nova:download`, `nova:share`, `nova:files:open`, `nova:files:save`, `nova:dialog:open`, `nova:dialog:save`, `nova:sysdialog:open`, `nova:sysdialog:save`, `nova:open-with`, `nova:clock:alarm:dialog` (host-only, listed for completeness) (`:11041-11053`).

A timeout rejects with `TypeError('IPC request timed out: <type>')` — not an error envelope. Note the WebSocket caveat: `nova:net:websocket` is only ever resolved from the socket's `onopen`; a connection that never opens has **no host reject path** and surfaces as this generic timeout (`:11753-11760`).

### 2.5 Payload budget (256 KB IPC cap)

- The per-app ledger budget `ipcPayloadBytes` is **256 KB by default** (admin-adjustable 1 KB – 8 MB; legacy hard cap 64 KB) (`:265`, `:269-274`, `:6097-6099`).
- It is enforced on **app-to-app IPC payloads**: `nova:ipc:invoke` `data`, `nova:ipc:broadcast` `data`, and `nova:ipc:reply` results, measured by JSON round-trip byte length (`normalizeAppIpcPayload`, `:6120-6131`). Over-budget rejects `PAYLOAD_TOO_LARGE` with `IPC payload exceeds the N KB limit`; non-serializable payloads reject `INVALID_ARGS` (`IPC payload is not JSON-serializable: …`).
- Related but distinct budgets: HTTP request bodies `httpBodyBytes` **16 MiB** default (`nova:net:fetch`, XHR `__NOVA_MAX_BODY_BYTES__`), storage values **5 MB**, storage quota **256 MB/app**. All consolidated in §7.

### 2.6 Permission denial shape

A denied call rejects with `code: 'PERMISSION_DENIED'` and one of these messages:

- **MAC front door** (no grant at all): `Blocked by system security policy (MAC): requires <perms joined ' | '>`, or `… no policy rule for this endpoint` for channels with no policy row (`:9584-9596`).
- **Handler-level** (context-dependent, e.g. fs path ownership, event-domain grants): each handler has its own message, e.g. `List app-owned files directly; shared files are available through the file picker or scoped media grants` (`:2331-2357`). Full list in §5.
- **Host-only channel**: `This system capability is only available through trusted OS UI` (`:9577-9579`).

Grant semantics: MAC rows that list multiple permissions are **ANY-of** (e.g. `nova:net:fetch` accepts `net:internal` OR `net:external` and the handler picks per-destination); event-domain gates are **ALL-of** (e.g. subscribing `mail:new` needs `system:events` AND `mail:read`) (`:6080-6095`). Runtime re-requests: `nova.requestPermission()` / `novaOS.permissions.request()` (§3, §4), rate-limited (§7).

Permission quick reference by API area (exact gate per channel in §5):

| API area | Permission(s) |
|---|---|
| Storage / data export-import (`data:export`), backup-restore (`data:backup`) | none (own namespace) / `data:export` / `data:backup` |
| Filesystem app-owned paths | none (ownership is the boundary) |
| Filesystem shared tree / all files | `fs:access`, or user-picked file, or `fs:read:images\|video\|audio` / `fs:metadata` |
| File watching | `fs:watch` |
| Network | `net:internal` and/or `net:external` (ANY-of at the front door, per-destination in the handler); WebSockets `net:websocket` (+ `net:internal` for private hosts) |
| Notifications | `device:notifications` |
| Clipboard | `clipboard:read` / `clipboard:write` |
| Window controls / pickers / share / open-url / download / appearance / locale | none (user-mediated or benign) |
| Settings read / write | `system:info` / `system:settings` (wallpaper keys exempt) |
| App launch / list / install / uninstall | `system:app-launch` (or `system:apps`) / `system:apps` |
| Alarms / background live / background wake / autostart | `system:schedule` / `system:background:live` / `system:background` / `system:autostart` |
| Secrets / push / badge / share-target | `secrets:store` / `push:receive` / `system:badge` / `system:share-target` |
| Registry read / write | `registry.read` / `registry.write` (+ `registry.system` for HKNS/security, HKNU; devMode for HKND) |
| Mail / calendar / contacts / devices | `mail:read\|write\|send\|delete`, `calendar:read\|write\|delete`, `contacts:read\|write\|delete`, `device:geolocation\|camera\|microphone` |
| Events (sensitive) / app-ipc / admin / nested webview | `system:events` (+ domain read grant) / `apps:communicate` / `admin:audit\|system\|users\|apps` (+ machine admin mode) / `sandbox:nested-webview` |

### 2.7 App-page globals (what the shim installs)

Reference for the globals your app page runs with (all main-world unless noted; `:11021-13160`):

| Global | Purpose |
|---|---|
| `window.nova` | v1 facade (`:11550`), mutable |
| `window.novaOS` | v2 facade (`:10361`), frozen |
| `window.__NOVA_APP_OPTIONS__` | launch options injected at load (read via `nova.app.getLaunchOptions()` / `onLaunch`); values escaped `\u003c`/`\u003e`/`\u0026`/u2028/u2029 so a caller-controlled `</script>` cannot terminate the shim (`:13150-13160`) |
| `window.__novaPermResponse` | `{permissions, optionalPermissions}` stashed after the automatic ready handshake (`:11370`) |
| `window.__NOVA_NESTED_WEBVIEW_OPTED_IN__` | baked boolean; gates the `browser.*` surface and webview mediation (`:11027`) |
| `__NOVA_PENDING_INITIAL_URL__` | pinned initial URL for nested views (consumed on first navigation, `:11028`) |
| `window.fetch` / `XMLHttpRequest` / `WebSocket` / `navigator.sendBeacon` | replaced with bridge-mediated versions (`Object.defineProperty`, `writable:false, configurable:false` — cannot be un-shadowed, `:12302-12308`). Requests under your own `/api/apps/serve/<sandboxId>/` prefix use native fetch (WASM support, `:11892-11925`) |
| `HTMLAnchorElement.prototype.click` | blob: download interceptor → `nova:download` (`:11430-11443`) |
| `Document.prototype.createElement` / `Element.prototype.innerHTML` / `outerHTML` / `insertAdjacentHTML` | nested-webview mediation (opted in: rewrite `<webview>` to the proxy element; not opted in: inert `<span>` / tag stripping + audit, `:12383-13030`) |
| `window.eval` | audit wrapper (dead under the current CSP — `unsafe-eval` removed; kept for observability if CSP is ever relaxed, `:12319-12338`) |
| (isolated world only) `window.__novaInbox` / `window.__novaOutboxPull` | host→guest inbox and guest→host payload parking — invisible to app main-world code (`:10105-10115`) |

CSP for app pages (`RELAXED_CSP_META`, `:13071`; the server-sent header for `/api/apps/serve/...` is authoritative): `default-src 'self' blob: data: 'unsafe-inline'; script-src 'self' blob: 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' blob: data:; img-src 'self' blob: data: https:; font-src 'self' blob: data:; connect-src 'self' blob:` (+ `frame-src http: https:` only when external frames are permitted).


---

## 3. `window.nova` v1 facade — complete method reference

`window.nova` is a plain (mutable, **not frozen**) object literal assigned at `:11550`, with `ipc.*` extensions at `:11506-11547` and `browser.*` added later under the nested-webview opt-in (`:12911-12959`). **71 callable members** (69 always present + 2 `browser.*` under the opt-in) across 24 top-level keys (15 namespaces + 9 plain functions; `browser` is a 16th namespace when opted in). All methods return Promises unless noted. "Raw" in the Returns column = the handler's response object resolved as-is (flattened + nested, §2.1).

Several v2 areas have **no v1 surface** — noted inline so you don't hunt for them.

### 3.0 Quick index (all 24 top-level keys)

| Key | Kind | Members | Section |
|---|---|---|---|
| `ipc` | namespace (function + 4 extensions) | `ipc`, `provide`, `call`, `broadcast`, `onBroadcast` | §3.1 |
| `files` | namespace | `open`, `save` | §3.4 |
| `share` | function | `share(data)` | §5.8 |
| `data` | namespace | `export`, `import`, `backup`, `restore` | §3.14 |
| `appearance` | namespace | `get`, `set`, `onChange` | §3.15 |
| `contextMenu` | namespace | `show`, `hide` | §3.16 |
| `overlay` | namespace | `show`, `hide`, `onEvent` | §3.16 |
| `app` | namespace | `getInfo`, `launch`, `getLaunchOptions`, `onLaunch`, `onStateChange` | §3.2 |
| `home` | namespace | `openDefaultAppsSettings`, `apps.list`, `apps.launch` | §3.17 |
| `wallpaper` | namespace | `set` | §3.18 |
| `calendar` | namespace | `list`, `save`, `remove` | §3.19 |
| `contacts` | namespace | `list`, `save`, `remove` | §3.19 |
| `apps` | namespace | `list`, `launch`, `install`, `uninstall`, `openDefaultAppsSettings` | §3.20 |
| `admin` | namespace | `auditQuery`, `systemGet`, `systemSet`, `usersList`, `usersRevoke`, `appsList` | §3.21 |
| `mail` | namespace | 14 methods (§3.22) | §3.22 |
| `browser` | namespace (opt-in only) | `createView`, `download` | §3.23 |
| `requestPermission` | function | | §3.10 |
| `openUrl` | function | | §3.6 |
| `openWith` | function | | §5.8 |
| `onEvent` | function | | §3.11 |
| `onBackgroundWake` | function | | §3.12 |
| `backgroundWakeDone` | function | | §3.12 |
| `stayAliveInBackground` | function | | §3.12 |
| `websocket` | function | | §3.6 |
| `getUserMedia` | function | | §3.13 |

### 3.1 Core / raw bridge

| Method | Channel | Behavior / returns | Limits / errors |
|---|---|---|---|
| `nova.ipc(type, payload)` | any `nova:*` | Raw channel call; timeout 60 s (10 min for interactive channels) | `UNKNOWN_API` for unregistered types; TypeError on timeout |
| `nova.ipc.provide(endpoint, handler)` | `nova:ipc:register` → `nova:ipc:unregister` | Register a `service:`/`provider:` endpoint; resolves `off()` | Rejects TypeError (handler not fn / already registered); host: `PERMISSION_DENIED` (no `apps:communicate` or undeclared endpoint), `ALREADY_REGISTERED`; endpoint must be declared in `manifest.ipc.exports` |
| `nova.ipc.call(targetAppId, endpoint, data)` | `nova:ipc:invoke` | Call another app's endpoint; provider's return value is spread as the response top level (NOT wrapped) | `RATE_LIMITED` 20/min; `PAYLOAD_TOO_LARGE` > 256 KB; `NOT_FOUND`, `UNAVAILABLE`, `REMOTE_ERROR`/timeout (§5) |
| `nova.ipc.broadcast(action, data)` | `nova:ipc:broadcast` | Fire-and-deliver to subscribed apps; resolves `{delivered}` | `RATE_LIMITED` `Max 20 app broadcasts per minute`; action must match `^[a-z0-9][a-z0-9._:-]{0,127}$` |
| `nova.ipc.onBroadcast(action, callback)` | `nova:ipc:broadcast:subscribe` / `:unsubscribe` | Register broadcast listener; resolves `off()`; last `off()` unsubscribes host-side | Rejects TypeError (callback not fn); action must be declared in `manifest.ipc.receives` else `PERMISSION_DENIED` |

### 3.2 App info / lifecycle

| Method | Channel | Behavior / returns | Limits / errors |
|---|---|---|---|
| `nova.app.getInfo()` | `nova:ready` | Launch snapshot: `{appId, permissions[], optionalPermissions[], osVersion, securityPatch, username?}` (username: system apps only) | none (ungated) |
| `nova.app.launch(appId, options)` | `nova:app:launch` | Cross-app launch; resolves `{success, windowId}` | `system:app-launch` OR `system:apps`; **30/min**; `fileIntent`/`fileId`/`folderId` stripped from options (§5) |
| `nova.app.getLaunchOptions()` | — (local) | Deep JSON clone of `window.__NOVA_APP_OPTIONS__` | never rejects except JSON clone errors |
| `nova.app.onLaunch(cb)` | — (local) | Registers launch listener; fires `cb({options, reason:'launch'})` on next microtask; returns `off()` | **throws** TypeError if cb not fn |
| `nova.app.onStateChange(cb)` | — (local) | `{visible, focused}` immediately + on `visibilitychange`/`focus`/`blur`; returns `off()` | **throws** TypeError if cb not fn |

### 3.3 Storage / key-value

**No v1 surface.** Use `novaOS.storage.*` (§4.2) or raw `nova.ipc('nova:storage:get', {key})`. There is no `window.__novaPrivateStore` (§9.3).

### 3.4 Filesystem

**No general v1 fs surface** (no read/write/list/stat/…). v1 exposes only the pickers:

| Method | Channel | Behavior / returns | Limits / errors |
|---|---|---|---|
| `nova.files.open(options)` | `nova:files:open` | Open a user-selected file (VFS or host path); resolves `{success, file:{id,name,content,mimeType,size,path}}`; picked id gets scoped access | **Interactive (10-min timeout)**; `accept` ≤ 20 entries or ≤ 512-char string; content ≤ **10 MB**; errors `INVALID_ARGS`, `UNSUPPORTED_TYPE`, `FILE_TOO_LARGE`, `PICKER_ERROR` (§5) |
| `nova.files.save(options)` | `nova:files:save` | Save content to a user-chosen destination; existing file update or new create | **Interactive**; `content` must be a string ≤ 10 MB; errors `INVALID_ARGS`, `PICKER_ERROR`, `UNAVAILABLE` (§5) |

Scoped media reads, watch, rename/move/mkdir/etc. are v2/raw only (§4.3, §4.4, §5).

### 3.5 Dialogs

**No standalone v1 dialog methods** — the OS-styled pickers are `novaOS.dialog.pickOpen/pickSave` (§4.9); v1 `nova.files.*` uses the scoped variants. Raw channels `nova:dialog:open|save` and `nova:sysdialog:open|save` are documented in §5.

### 3.6 Networking

| Method | Channel | Behavior / returns | Limits / errors |
|---|---|---|---|
| `nova.openUrl(url)` | `nova:open-url` | Open a credential-free HTTP(S) URL in the OS default browser; resolves `{success, windowId}` | No permission (consent = browser window); `INVALID_ARGS` for non-http(s) or credentialed URLs; `UNAVAILABLE` (§5) |
| `nova.websocket(url, protocols)` | `nova:net:websocket` (+ `nova:net:ws:send`/`:close`) | Open a host-owned socket; resolves a handle `{wsId, readyState, onMessage(cb), onError(cb), onClose(cb), send(data), close(code, reason)}` | `net:websocket` (+ `net:internal` for private/first-party hosts); ws/wss only, no embedded credentials; **open failures surface as the generic 60 s IPC timeout** (`:11753-11760`); no socket-count/frame-size/rate caps |
| `fetch()` / `XMLHttpRequest` / `WebSocket` / `navigator.sendBeacon` | `nova:net:fetch` / `nova:net:websocket` | Globally replaced (`Object.defineProperty`, non-configurable — `delete window.fetch` cannot un-shadow, `:12302-12308`). Requests to the app's **own** `/api/apps/serve/<sandboxId>/` prefix bypass the bridge and use native fetch (WASM/Emscripten support, `:11892-11925`) | Any-of `net:internal`/`net:external` (per destination); request body ≤ 16 MiB (XHR: `RangeError('XHR request body exceeds the N MiB limit')`); sync XHR rejected; response has **no size cap** (§5) |

XHR specifics: methods limited to `GET POST PUT PATCH DELETE HEAD OPTIONS`; header CRLF stripped; `responseXML` always null; multipart FormData hand-built with escaped names (`:12006-12057`, `:12092-12099`). `sendBeacon` resolves `true` synchronously regardless of outcome (native contract, `:12344-12352`). The native `WebSocket` constructor is replaced so a zero-permission app cannot open raw sockets (`:12218-12292`).

### 3.7 Notifications

**No v1 surface.** Use `novaOS.notifications.*` (§4.6) or raw `nova.ipc('nova:notifications:post', {...})`. Channel details in §5 (7 channels, `device:notifications`, 10 new/min, 60 update/min, 32 channels/app).

### 3.8 Clipboard

**No v1 surface.** Use `novaOS.clipboard.readText()/writeText()` (§4.5). (`nova.share`'s Copy action also writes the clipboard without needing `clipboard:write` — §5.)

### 3.9 Window controls

**No v1 surface.** Use `novaOS.window.*` (§4.8). (`nova.app.launch` is the only window-adjacent v1 call.)

### 3.10 Permissions

| Method | Channel | Behavior / returns | Limits / errors |
|---|---|---|---|
| `nova.requestPermission(permission, reason?)` | `nova:request-permission` | Shows the OS permission dialog; resolves the raw `{granted}` object | Prompt rate limit: **3 per 60 s burst**, cooldown 5 s → 15 min backoff (§7); permanent by default (`permanent !== false`) |

### 3.11 Events (OS → app)

| Method | Channel | Behavior / returns | Limits / errors |
|---|---|---|---|
| `nova.onEvent(eventName, callback)` | `nova:events:subscribe` (first listener per name only) | Stacks listeners per name over **one** host subscription; the returned Promise resolves `{success, subscribed}` for 2nd+ listeners (no host call) | Returns a **Promise that can reject unhandled** if the host refuses (`PERMISSION_DENIED`, `INVALID_ARGS` not-in-allowlist, `ALREADY_SUBSCRIBED` from another surface); no `off()` — use `novaOS.events.on` if you need teardown |

Subscribable names and their gates: see §6.2 and §5 (events row).

### 3.12 Background wake / stay-alive

| Method | Channel | Behavior / returns | Limits / errors |
|---|---|---|---|
| `nova.onBackgroundWake(callback)` | — (local) | Registers a Tier-1 wake handler; receives `{wokeAt, deadlineMs}`; **returns `undefined`** (no Promise, no `off()`, no callback validation) | fires only in scheduler-started sandboxes; 10 s deadline then teardown |
| `nova.backgroundWakeDone()` | `nova:background:wake-done` | Signal early wake completion; resolves `{success:true}` | no permission (scheduler pre-verified `system:background`) |
| `nova.stayAliveInBackground(enabled?)` | `nova:background:stay-alive` | Tier-2 opt-in for this session (`enabled !== false`, default true); resolves `{success, enabled}` | `system:background:live`; session-only, never persisted — re-opt-in every launch |

### 3.13 getUserMedia (camera / microphone)

| Method | Channel | Behavior / returns | Limits / errors |
|---|---|---|---|
| `nova.getUserMedia(constraints)` | `nova:device:camera` / `nova:device:microphone` (per `constraints.video` / `.audio`) | App-level grant check first, then the **real** `navigator.mediaDevices.getUserMedia(constraints)` in the guest document; resolves a `MediaStream` | Rejects TypeError if neither video nor audio in constraints; rejects `PERMISSION_DENIED` if the needed device grant is missing; the browser-level `permissionrequest` gate runs separately (media branch = camera OR microphone, ANY-of) |

A `MediaStream` cannot cross the IPC bridge — that is why the channels are authorization-only (`:11777-11785`).

### 3.14 Data portability

| Method | Channel | Behavior / returns | Limits / errors |
|---|---|---|---|
| `nova.data.export(options)` | `nova:data:export` | Export `{keys[] ≤ 1000}` or `{prefix}` into a checksummed envelope | `data:export`; `INVALID_ARGS` if no selector |
| `nova.data.import(envelope)` | `nova:data:import` | Merge-only import (never deletes absent keys) | `data:export`; `POLICY_BLOCKED` for another app's envelope; `INVALID_ARGS` on checksum/kind mismatch |
| `nova.data.backup()` | `nova:data:backup` | Full own-namespace snapshot | `data:backup` |
| `nova.data.restore(envelope, options?)` | `nova:data:restore` | Restore a backup envelope; `options.clearFirst === true` wipes own namespace first | `data:backup`; per-key over-cap failures reported in `failedKeys[]` |

Envelope shape: `{novaDataEnvelope:1, format:1, kind:'backup'\|'export', appId, capturedAt, storage:{}, counts, checksum}` — sha256 over key-sorted storage JSON; envelopes are pinned to the calling appId (`:7021-7028`).

### 3.15 Appearance

| Method | Channel | Behavior / returns | Limits / errors |
|---|---|---|---|
| `nova.appearance.get()` | `nova:appearance:get` | `{theme, accentColor, highContrast, reduceMotion, removeTransparency, transparentSurfaces}` | no permission |
| `nova.appearance.set(appearance)` | `nova:appearance:set` | Set allowlisted fields | **10/min**; `INVALID_ARGS` (bad field/value); `POLICY_BLOCKED` |
| `nova.appearance.onChange(cb)` | `nova:appearance:subscribe` (once; shared promise) | Registers change listener; fires immediately with current appearance; resolves `off()`; last `off()` → `nova:appearance:unsubscribe` | Rejects TypeError (not fn / already subscribed); one subscription per sandbox (`ALREADY_SUBSCRIBED` at host) |

### 3.16 Context menu / overlay (host-rendered UI)

Both require the nested-webview opt-in **and** a live `sandbox:nested-webview` grant (handler checks `isNestedWebviewPermitted`, `:3328`, `:3414`).

| Method | Channel | Behavior / returns | Limits / errors |
|---|---|---|---|
| `nova.contextMenu.show(x, y, items)` | `nova:context-menu:show` | Host-rendered menu at host-screen coords (unclamped); resolves `{cancelled, index}` | **Interactive**; 1–100 items; label ≤ 120, icon ≤ 64, shortcut ≤ 32; `INVALID_ARGS`, `UNAVAILABLE` |
| `nova.contextMenu.hide()` | `nova:context-menu:hide` | Close any open menu | `{success, wasOpen}` |
| `nova.overlay.show(options)` | `nova:overlay:show` | Host-rendered overlay iframe (`allow-same-origin` only, scripts blocked, DOMPurify-sanitized); resolves `{success, overlayId}` | html ≤ 100 000 chars, css ≤ 50 000; render timeout 15 s; `INVALID_ARGS`, `SANITIZE_FAILED`, `RENDER_FAILED`, `CANCELLED` |
| `nova.overlay.hide()` | `nova:overlay:hide` | Close overlay | `{success, wasOpen}` |
| `nova.overlay.onEvent(cb)` | — (local; pushes via `nova:overlay:event`) | Register overlay interaction listener; returns `off()` | **throws** TypeError if cb not fn; events only for `click/input/change/submit/keydown` on `[data-nova-action]`/`[data-nova-field]` (action/field ≤ 100, value ≤ 4096, key ≤ 64) |

### 3.17 Home surface (default Home app only)

| Method | Channel | Behavior / returns | Limits / errors |
|---|---|---|---|
| `nova.home.openDefaultAppsSettings()` | `nova:home:openDefaultAppsSettings` | Open Settings → Default Apps (highlights `home`) | caller must be the currently selected Home app; **12/min** |
| `nova.home.apps.list()` | `nova:home:apps:list` | App list for the Home surface; `{success, apps[], fullAccess}` | Home-caller check; without `system:apps` the list is limited to Settings + App Manager |
| `nova.home.apps.launch(appId)` | `nova:home:apps:launch` | Launch from Home (no options passed) | Home-caller; Settings/AppManager always launchable, other targets need `system:app-launch`; **30/min** |

### 3.18 Wallpaper

| Method | Channel | Behavior / returns | Limits / errors |
|---|---|---|---|
| `nova.wallpaper.set(key, value)` | `nova:wallpaper:set` | `key` must be `wallpaperId` (preset id, or null/'' to clear) or `customWallpaper` (image URL/data URL string, or null/'' to clear) | No permission (documented exemption); `INVALID_ARGS`; `POLICY_BLOCKED` if `prohibitWallpaperChange` |

### 3.19 Calendar / contacts (shared OS stores)

| Method | Channel | Behavior / returns | Limits / errors |
|---|---|---|---|
| `nova.calendar.list()` | `nova:calendar:read` | All events in the **shared** store (no per-app scoping) | `calendar:read` |
| `nova.calendar.save(event)` | `nova:calendar:write` | Upsert by id (id assigned host-side); `title` + `date` `YYYY-MM-DD` required; color from 8 frozen values | `calendar:write`; `INVALID_EVENT` |
| `nova.calendar.remove(id)` | `nova:calendar:delete` | Delete by id | `calendar:delete`; `INVALID_ID` |
| `nova.contacts.list()` | `nova:contacts:read` | All contacts (shared store) | `contacts:read` |
| `nova.contacts.save(contact)` | `nova:contacts:write` | Upsert by id; needs at least a trimmed name; id/name/email/phone/notes strings | `contacts:write`; `INVALID_CONTACT` |
| `nova.contacts.remove(id)` | `nova:contacts:delete` | Delete by id | `contacts:delete`; `INVALID_ID` |

### 3.20 App management

| Method | Channel | Behavior / returns | Limits / errors |
|---|---|---|---|
| `nova.apps.list()` | `nova:app:list` | Installed apps; manifest reduced to `{system:bool}` | `system:apps` |
| `nova.apps.launch(appId, options)` | `nova:app:launch` | Duplicate of `nova.app.launch` | see §3.2 |
| `nova.apps.install(pkg)` | `nova:app:install` | Install a **parsed package object** `{manifest, files, signature, integrity}`; unattended path fails closed | `system:apps`; `INVALID_PACKAGE`, `MALICIOUS_PACKAGE`, `SCAN_FAILED`, `UNVERIFIED`, `TAMPERED`, `UNTRUSTED`, `ALREADY_INSTALLED` (§5) |
| `nova.apps.uninstall(appId)` | `nova:app:uninstall` | Uninstall with full state cleanup | `system:apps`; cannot self-uninstall; `NOT_UNINSTALLABLE` for built-ins |
| `nova.apps.openDefaultAppsSettings(category?)` | `nova:app:openDefaultAppsSettings` | Deep-link Settings → Default Apps; `category` is a UI highlight hint only | `system:apps`; **12/min** |

### 3.21 Admin

All `admin:*` channels carry a **dual gate**: the per-app permission AND the machine's local admin mode flag (set in Settings). Granting the permission does not itself enable admin mode (`:11837-11840`).

| Method | Channel | Behavior / returns | Limits / errors |
|---|---|---|---|
| `nova.admin.auditQuery(filters)` | `nova:admin:audit` | Security audit log query (userId, action, resource, ipAddress, success, startDate, endDate, level, limit, offset) | `admin:audit` + admin mode; server 403 → `PERMISSION_DENIED` |
| `nova.admin.systemGet()` | `nova:admin:system {action:'get'}` | Machine security settings | `admin:system` + admin mode |
| `nova.admin.systemSet(settings)` | `nova:admin:system {action:'set'}` | Update security settings | `INVALID_ARGS` if settings object missing |
| `nova.admin.usersList()` | `nova:admin:users {action:'list'}` | Account list | `admin:users` + admin **role** session |
| `nova.admin.usersRevoke(sessionId)` | `nova:admin:users {action:'revoke'}` | Revoke a session | `INVALID_ARGS` without sessionId |
| `nova.admin.appsList()` | `nova:admin:apps` | Per-app declared vs granted permission audit | `admin:apps` + admin mode |

### 3.22 Mail (reuses the host Email app session)

All mail calls fail `UNAVAILABLE` (`No email account connected — open the Email app and connect an account first`) when the host Email app has no connected account (`:5484-5486`).

| Method | Channel (payload action) | Behavior / returns | Limits / errors |
|---|---|---|---|
| `nova.mail.connect(account)` | `nova:mail:session` `connect` | `{type, host, port?, user, pass}`; `ssl` forced true — plaintext refused | `mail:write`; `INVALID_ARGS` |
| `nova.mail.disconnect()` | `nova:mail:session` `disconnect` | Drop the session | `mail:write` |
| `nova.mail.restore()` | `nova:mail:session` `restore` | Restore persisted session | `mail:write` |
| `nova.mail.account()` | `nova:mail:read` `account` | Connected account info | `mail:read` |
| `nova.mail.folders()` | `nova:mail:read` `folders` | Folder list | `mail:read` |
| `nova.mail.messages(opts)` | `nova:mail:read` `messages` | Paged messages (`folder` default `INBOX`, `page`, `limit`) | `mail:read` |
| `nova.mail.message(uid, folder?)` | `nova:mail:read` `message` | Single message | `INVALID_ARGS` without uid |
| `nova.mail.search(query, folder?)` | `nova:mail:read` `search` | Search | `INVALID_ARGS` without query |
| `nova.mail.preview(html)` | `nova:mail:write` `preview` | Sanitized HTML preview token | `mail:write`; `INVALID_ARGS` without html |
| `nova.mail.markRead(uids, folder?)` | `nova:mail:write` `batch op:'read'` | Mark read | `INVALID_ARGS` without uids array |
| `nova.mail.move(uids, dest, folder?)` | `nova:mail:write` `batch op:'move'` | Move messages | `INVALID_ARGS` without dest |
| `nova.mail.send(msg)` | `nova:mail:send` | `{to, cc, bcc, subject, text, html, smtpHost, smtpPort}` — **`smtpHost` required** | `mail:send`; `INVALID_ARGS` |
| `nova.mail.remove(uids, folder?)` | `nova:mail:delete` | Batch delete (op only reachable here — `mail:write` cannot delete) | `mail:delete`; `INVALID_ARGS` |
| `nova.mail.openLink(url)` | `nova:email:open-link` | Open a mailto/http link in the built-in Email app | hard-pinned to `com.nbosp.email` (system-signed) — other apps get `PERMISSION_DENIED` |

### 3.23 Browser view — `nova.browser.*` (nested-webview opt-in only)

Present **only** when the shim baked `__NOVA_NESTED_WEBVIEW_OPTED_IN__ = true` (manifest `allowNestedWebview: true` or `sandbox:nested-webview` declared). The object itself is `Object.freeze`'d (`:12911`).

| Method | Channel | Behavior / returns | Limits / errors |
|---|---|---|---|
| `nova.browser.createView(options)` | `nova:nested-webview {action:'create', …}` (via the `<nova-nested-webview>` proxy element) | Create a host-sibling browser view inside `options.container` (Element, required); awaits element creation; optionally navigates `options.url`; resolves a `NovaBrowserView` | **throws** TypeError (no container Element); `pollingInterval` default 1000, must be 0 or 250–10000 ms else RangeError; every host action re-checks the live `sandbox:nested-webview` grant |
| `nova.browser.download(options)` | `nova:net:fetch` (patched fetch) then `nova:download` | Fetch `options.url`, convert blob → data URL, hand to the OS save dialog; filename defaults `download` | **throws** TypeError (no URL); non-2xx → Error `Download request failed with HTTP <status>`; then `nova:download` rules (§5) |

#### NovaBrowserView (class, `:12670-12909`)

Constructor wires webview events into CustomEvents on the proxy element: `navigation-start`, `navigation-redirect`, `navigation-commit`, `navigation-complete`, `navigation-error`, `close`, `crash`, `new-window` (with a `window.attach/discard` popup shim), `download-request` (only `permission === 'download'`), `contextmenu` (scaled coordinates), `annotation-export` (dataUrl must start `data:image/`), `url-change`, `title-change`, `state-change`, `state-error`, `destroy`.

Methods (all delegating to `nova:nested-webview` actions; `:12784-12907`):

| Method | Behavior |
|---|---|
| `refreshState()` / `getState()` | poll `[location.href, document.title]` into the proxy state (`:12825`) |
| `navigate(url)` | navigate (first call consumes `__NOVA_PENDING_INITIAL_URL__` if no url given) |
| `back()` / `forward()` | client-side history (`_history`, `_historyIndex`, `_historyMove`) |
| `reload()` / `stop()` | reload / stop loading |
| `find(text, options)` / `stopFinding(action)` | host-validated page find (`{activeMatchOrdinal, numberOfMatches}`) |
| `clearData()` | clear the view's stored data |
| `setZoom(factor)` / `setZoomMode(mode)` | zoom controls |
| `setUserAgent(ua)` | user-agent override |
| `setOverlayActive(bool)` | freeze/unfreeze the guest (captured still or plain hide) |
| `setAnnotationLayer(opts)` / `updateAnnotationLayer(opts)` / `setAnnotationActive(bool)` / `clearAnnotationLayer()` / `undoAnnotationLayer()` / `exportAnnotationLayer()` | annotation layer family; export payloads validated to `data:image/` and ≤ 2 000 000 chars |
| `executeScript(code)` | run script in the nested guest |
| `on(type, listener)` | subscribe to the CustomEvents listed above |
| `destroy()` | tear the view down (`destroy` event emitted) |

`navigate()` consumes the pinned `__NOVA_PENDING_INITIAL_URL__` override on first navigation (`:12847-12850`); navigation requires `net:internal`/`net:external` per destination and rejects embedded credentials (`:10007-10020`).

#### NovaNestedWebview (custom element `<nova-nested-webview>`, `:12450-12607`)

`document.createElement('webview')` is re-routed to this element (`:12598-12603`); `innerHTML`/`outerHTML`/`insertAdjacentHTML` rewrite `<webview…>` tags to it (`:12609-12646`); a MutationObserver backstop removes stray native `<webview>` nodes (`:12656-12668`). Attribute changes (`allowfullscreen`, `allowpopups`, `src`, `partition`) are forwarded live; bounds are pushed on resize/mutation (`action:'bounds'`, clamped to viewport, including `visible/visibility/pointerEvents/zIndex`).

Element methods → `nova:nested-webview` actions: `getURL`, `navigate`, `executeScript`, `insertCSS`, `reload`, `back`, `forward`, `stop`, `canGoBack`, `canGoForward`, `find`, `stopFinding`, `setUserAgentOverride`, `setZoom`, `setZoomMode`, `clearData`, `__attachPopup(popupId)`, `setOverlayActive`, and the annotation command family. Removing the element sends `action:'destroy'`.

Apps **not** opted in: `createElement('webview')` returns an inert `<span>` and logs `nova:audit:blocked-nested-webview {via:'createElement'}`; HTML parser paths strip the tag and audit; the MutationObserver removes survivors (`:12962-13030`). This is a security block that deliberately does not throw.


---

## 4. `window.novaOS` v2 facade — complete namespace reference

`window.novaOS = Object.freeze({ apiVersion: 2, … })` (`:10361`); **28 frozen namespaces, 116 methods**, built by `buildNovaOSFacadeSource()` and injected into the same shim/realm as v1 (one `ipc()`, one pending-request map, `:11872`). Normalization rules applied per namespace are noted; everything else resolves the raw handler response (flattened + nested, §2.1).

Notable deliberate design points:

- `storage.get(missing)` resolves **`null`**; `settings.get(unset)` resolves **`undefined`** — "deliberate distinction" (`:10753-10755`).
- Mutations (`set`/`remove`/`clear`/…) resolve **`undefined`**; host errors still reject.
- `novaOS` has **no** `appearance`, `fs.shared.write`, `dialog list`, `permissions list`, or `net.fetch` members — appearance and the raw fetch override stay v1/global (§3.15, §3.6).

### 4.0 Namespace quick index (28 namespaces, 116 methods)

| Namespace | Methods | Section | Namespace | Methods | Section |
|---|---|---|---|---|---|
| `capabilities` | 1 | §4.1 | `share` | 1 | §4.11 |
| `storage` | 6 | §4.2 | `alarms` | 4 | §4.11 |
| `fs` (incl. `appdata`, `shared`) | 16 | §4.3 | `push` | 3 | §4.11 |
| `media` | 4 | §4.4 | `settings` | 2 | §4.12 |
| `clipboard` | 2 | §4.5 | `ready` | 1 | §4.12 |
| `notifications` | 7 | §4.6 | `events` | 3 | §4.12 |
| `locale` | 1 | §4.7 | `geolocation` | 1 | §4.12 |
| `badge` | 2 | §4.7 | `calendar` | 3 | §4.13 |
| `secrets` | 4 | §4.7 | `contacts` | 3 | §4.13 |
| `window` | 6 | §4.8 | `mail` | 14 | §4.14 |
| `dialog` | 2 | §4.9 | `admin` | 6 | §4.14 |
| `app` | 6 | §4.10 | `background` | 3 | §4.15 |
| `data` | 4 | §4.10 | `permissions` | 2 | §4.15 |
| | | | `net` | 1 | §4.16 |
| | | | `registry` | 8 | §4.17 |

### 4.1 `capabilities` (1 method)

| Method | Channel | Returns |
|---|---|---|
| `capabilities.has(name)` | — (local frozen table) | `boolean` — true iff the runtime ships the surface (`hasOwnProperty` and `=== true`). **Not** a permission check. |

The 28 capability names (`:10255-10299`): `storage.v2`, `fs.v2`, `clipboard.v2`, `notifications.v2`, `window.v2`, `dialogs.v2`, `app.v2`, `data.v2`, `locale.v1`, `badge.v1`, `fsWatch.v1`, `alarms.v1`, `secrets.v1`, `shareTarget.v1`, `push.v1`, `settings.v2`, `ready.v2`, `events.v2`, `geolocation.v2`, `media.v2`, `calendar.v2`, `contacts.v2`, `mail.v2`, `admin.v2`, `background.v2`, `permissions.v2`, `net.v2`, `registry.v1`.

### 4.2 `storage` (6 methods) — per-app key-value store

Host-side IndexedDB (`NovaByte_AppStorage`, store `kv2`), rows keyed `[ownerUid, appId, key]` — a guest can never address another owner's or app's rows (`:6615-6676`).

| Method | Channel | Returns | Errors / limits |
|---|---|---|---|
| `storage.get(key)` | `nova:storage:get` | stored value, or `null` when absent (**fail-open read**: IndexedDB outage also resolves `null`, `:6885-6889`) | `INVALID_ARGS` `Invalid storage key` |
| `storage.set(key, value)` | `nova:storage:set` | `undefined` | `INVALID_ARGS` (bad key / not JSON-serializable); `STORAGE_FULL` (value > **5 MB**, quota **256 MB/app**, **2 GB/user**) |
| `storage.remove(key)` | `nova:storage:delete` | `undefined` | `INVALID_ARGS`, `ERROR` |
| `storage.clear()` | `nova:storage:clear` | `undefined` (clears only this owner+app's rows) | `ERROR` |
| `storage.keys()` | `nova:storage:keys` | `string[]` (default `[]`) | `ERROR` |
| `storage.usage()` | `nova:storage:usage` | `{usage, budget}` — own app only | `ERROR` |

Key rules: `/^[\w\-. ]+$/` (word chars, dash, dot, space; no length cap) — slashes/colons rejected to prevent cross-namespace key injection (`:207-209`).

### 4.3 `fs` (16 methods) — scoped filesystem

Caller-relative roots: `appdata:<path>` always resolves into **this app's** `/data/<appId>/` subtree (no syntax names another app's subtree); `shared:`/`media:` address the shared tree under the same permission rules; raw `/…` paths get `/data/…` rewritten to the caller's own segment (`:10406-10416`, `:1782-1797`). App-owned paths need **no grant**; shared-tree access needs `fs:access`, a user-picked file, or a matching media grant.

| Method | Channel | Returns (raw handler shape) | Errors |
|---|---|---|---|
| `fs.read(path)` | `nova:fs:read {path}` | file `{success, data, mimeType, name, size, id, path, modified, created}`; folder `{success, isFolder:true, name, id, path, children[]}` | `NOT_FOUND`, `PERMISSION_DENIED` |
| `fs.write(path, content)` | `nova:fs:write {path, content}` | `{success, id, path}` (create); `{success}` (update) | `INVALID_ARGS`, `PERMISSION_DENIED`, `INVALID_OPERATION` (folder), `NOT_FOUND`, `UNAVAILABLE` |
| `fs.list(path)` | `nova:fs:list {path}` | `{success, path, files[]}` | `NOT_FOUND`, `INVALID_OPERATION`, `PERMISSION_DENIED` |
| `fs.stat(path)` | `nova:fs:stat {path}` | `{success, stat:{id,name,type,mimeType,size,path,parentId,created,modified,accessed,permissions,sha256,tags}}` | `NOT_FOUND`, `PERMISSION_DENIED` |
| `fs.mkdir(path, name)` | `nova:fs:mkdir {path, name}` | `{success, id, path}` (own-subtree ancestors auto-created) | `INVALID_ARGS`, `PERMISSION_DENIED`, `NOT_FOUND` |
| `fs.rename(path, name)` | `nova:fs:rename {path, name}` | `{success, name}` | `NOT_FOUND`, `PERMISSION_DENIED`, `UNAVAILABLE`, `INVALID_ARGS` |
| `fs.move(path, destPath)` | `nova:fs:move {path, destPath}` | `{success, path}` (dest parent must be app-owned or granted) | `NOT_FOUND`, `PERMISSION_DENIED` |
| `fs.remove(path)` | `nova:fs:delete {path}` | `{success:true}` | `NOT_FOUND`, `PROTECTED_LOCATION`, `PERMISSION_DENIED`, `UNAVAILABLE` (confirm unavailable); confirm-cancel resolves `{cancelled:true}` |
| `fs.watch(path, callback)` | `nova:fs:watch {path, watcherId}` | `{watcherId, path, unwatch()}`; callback gets `{watcherId, path, kind:'changed'\|'created'\|'deleted', timestamp}` | rejects TypeError (callback not fn); `fs:watch` grant + read access to the path; `RATE_LIMITED` `Max 8 watchers per app`; events coalesced/debounced, 60 pushes/min |
| `fs.unwatch(watcherId)` | `nova:fs:unwatch {watcherId}` | `undefined` (idempotent; foreign/unknown ids resolve `cleared:false`) | none |
| `fs.appdata.list(path)` | `nova:fs:list` (path prefixed `appdata:/`, leading slashes stripped) | as `fs.list` | as `fs.list` |
| `fs.appdata.read(path)` | `nova:fs:read` (prefixed) | as `fs.read` | as `fs.read` |
| `fs.appdata.write(path, content)` | `nova:fs:write` (prefixed) | as `fs.write` | as `fs.write` |
| `fs.appdata.remove(path)` | `nova:fs:delete` (prefixed) | as `fs.remove` | as `fs.remove` |
| `fs.shared.list(path)` | `nova:fs:list` (prefix `shared:/`) | as `fs.list` (shared tree) | as `fs.list`; paths resolving into `/data` are refused |
| `fs.shared.read(path)` | `nova:fs:read` (prefix `shared:/`) | as `fs.read` | as `fs.read` |

Non-string `content` is JSON-serialized (never `[object Object]`); cycles/BigInt reject `INVALID_ARGS` (`:2399-2420`). `watch` delivery is **best-effort** — poll if you need guarantees (rate-limited events are silently coalesced, `:7688-7690`).

### 4.4 `media` (4 methods)

| Method | Channel | Returns | Errors / limits |
|---|---|---|---|
| `media.query(options)` | `nova:media:query` | `{files}` — indexed shared media metadata (bytes still via `fs.read` under per-file media grants) | `type` ∈ `all\|image\|audio\|video`; needs `fs:metadata` OR `fs:access` OR matching media grant; `INVALID_ARGS`, `PERMISSION_DENIED`, `UNAVAILABLE` |
| `media.checkCamera()` | `nova:device:camera` | `true` | rejects `PERMISSION_DENIED` without `device:camera` |
| `media.checkMicrophone()` | `nova:device:microphone` | `true` | rejects `PERMISSION_DENIED` without `device:microphone` |
| `media.getUserMedia(constraints)` | `nova:device:camera`/`microphone` then in-document gUM | `MediaStream` | rejects TypeError (no video/audio); `PERMISSION_DENIED`; browser gate runs separately (ANY-of camera/mic) |

One merged surface on purpose — an earlier draft's second media key clobbered `query()` (`:10503-10505`).

### 4.5 `clipboard` (2 methods)

| Method | Channel | Returns | Errors / limits |
|---|---|---|---|
| `clipboard.readText()` | `nova:clipboard:read` | text, or `null` when nothing readable | `clipboard:read`; falls back to the host's last written value when the browser clipboard fails (ambient channel — see [`internals.md`](internals.md)) |
| `clipboard.writeText(text)` | `nova:clipboard:write` | `undefined` | `clipboard:write`; `text ?? ''` (0/false preserved); `CLIPBOARD_UNAVAILABLE` on write failure; history capped at 30 |

### 4.6 `notifications` (7 methods)

Same gates/limits as the raw channels: `device:notifications`; **10 new/min, 60 tagged-update/min**; 32 channels/app.

| Method | Channel | Returns | Errors / limits |
|---|---|---|---|
| `notifications.show(options)` | `nova:notifications:show` | raw (`{success:true}`) | title ≤ 120 (default `Notification`), body ≤ 500, type ∈ `info\|success\|warning\|error`, icon from a 22-id allowlist; `RATE_LIMITED` `Max 10 notifications per minute` |
| `notifications.post(options)` | `nova:notifications:post` | `{success, posted, updated, id, importance}` | channel must exist (create first or declare `notifications.channels` in the manifest); muted channel resolves `{success:true, posted:false, reason:'CHANNEL_MUTED', importance}`; tag ≤ 64; ≤ 3 actions (id slug ≤ 40, label ≤ 40); `progress` value 0..max, max clamp 1..100000; omitted `actions`/`progress` inherit field-wise (explicit `[]`/`null` clears) |
| `notifications.createChannel(id, name, importance)` | `nova:notifications:createChannel` | `{success, created, channel:{id,name,importance}}` | id 1–64 chars `^[a-zA-Z0-9_-]+$`; name ≤ 60 non-empty; importance locked at creation (`none` maps to `default`; only user muting reaches `none`); 32-channel cap `LIMIT_REACHED` `Max 32 channels per app` |
| `notifications.cancel(idOrTag)` | `nova:notifications:cancel` | `{success, removed}` | `INVALID_ARGS` `either tag or id is required` |
| `notifications.cancelAll()` | `nova:notifications:cancelAll` | `undefined` | — |
| `notifications.clear()` | `nova:notifications:clear` | `undefined` (clears this app's notifications) | — |
| `notifications.consumeActions()` | `nova:notifications:consumeActions` | `{actions}` — **pull-only**; action clicks are never pushed, they queue host-side (≤ 20 pending/app) and drain here | — |

### 4.7 `locale` / `badge` / `secrets` (7 methods)

| Method | Channel | Returns | Errors / limits |
|---|---|---|---|
| `locale.get()` | `nova:locale:get` | normalized `{locale ('en-US' fallback), region, timeZone, firstDayOfWeek ('monday'\|'sunday')}` | **no permission** (coarse formatting facts only) |
| `badge.set(value)` | `nova:badge:set` | `undefined`; number → `{count}`, object `{text}` passthrough | `system:badge`; **30/min** `Max 30 badge updates per minute`; count 0–999 (floored, 0 = clear), text 1–4 chars after trim |
| `badge.clear()` | `nova:badge:clear` | `undefined` | `system:badge`; `{success, cleared}` raw |
| `secrets.set(key, value)` | `nova:secrets:set` | `undefined` | `secrets:store`; key ≤ 128 chars (trimmed, no control chars); value ≤ **8 KB** UTF-8 (`INVALID_ARGS` `… 8192 bytes`); **64 secrets/app** (`RATE_LIMITED` `Max 64`, replacement at cap allowed); AES-256-GCM at rest |
| `secrets.get(key)` | `nova:secrets:get` | plaintext, or `null` (absent/tampered — auth failure returns null, never garbage) | `secrets:store` |
| `secrets.delete(key)` | `nova:secrets:delete` | `undefined` | `secrets:store` |
| `secrets.keys()` | `nova:secrets:keys` | sorted key array (own app only) | `secrets:store` |

Secrets never appear in data export/backup envelopes (`:8119-8125`).

### 4.8 `window` (6 methods)

| Method | Channel | Returns | Errors / limits |
|---|---|---|---|
| `window.close()` / `minimize()` / `maximize()` | `nova:window:close`/`minimize`/`maximize` | `undefined` (best-effort, always success) | none |
| `window.setTitle(title)` | `nova:window:setTitle` | `undefined` | title stringified and capped at **200 chars** |
| `window.resize(width, height)` | `nova:window:resize` | `undefined` (unmaximizes) | ints; fallback 800/600, minimum 100 |
| `window.getState()` | `nova:window:getState` | `{id, x, y, width, height, maximized, minimized}` | `NOT_FOUND` `Window not found` |

### 4.9 `dialog` (2 methods) — unified pickers

| Method | Channel | Returns | Errors / limits |
|---|---|---|---|
| `dialog.pickOpen(options)` | `style:'system'` → `nova:dialog:open`, else `nova:sysdialog:open` (`style` key stripped; accept/multiple/title/startPath pass through) | picked file(s): VFS `{success, file, files?}`; host-path picks carry absolute path + content | **user-mediated, no permission gate**; interactive 10-min timeout; accept ≤ 20 entries (≤ 64 chars each) or one ≤ 512-char string; multi ≤ 25 files (`LIMIT_REACHED`); read cap **10 MB** (`FILE_TOO_LARGE`); `INVALID_ARGS`, `PERMISSION_DENIED`, `DIALOG_ERROR`, `PICKER_ERROR` |
| `dialog.pickSave(options)` | `style:'system'` → `nova:dialog:save`, else `nova:sysdialog:save` | `{success, file}` (created/updated) | same shape; `suggestedName` ≤ 255; content ≤ 10 MB; overwriting a non-owned VFS file needs user confirm (`UNAVAILABLE` when confirm is unavailable); `WRITE_ERROR` |

Both styles only ever hand the app what the user actively chose — that is the boundary, hence no permission.

### 4.10 `app` / `data` (10 methods)

| Method | Channel | Returns | Errors / limits |
|---|---|---|---|
| `app.info()` | `nova:app:info` | `{id, name, version, icon, type, permissions, optionalPermissions}` (own manifest facts) | `UNAVAILABLE` `No app context` |
| `app.list()` | `nova:app:list` | installed app records (manifest reduced to `{system}`) | `system:apps` |
| `app.launch(appId, options?)` | `nova:app:launch` | `{success, windowId}` | ANY-of `system:app-launch`/`system:apps`; 30/min; file intents stripped |
| `app.openUrl(url)` | `nova:open-url` | `{success, windowId}` | no permission; http(s), credential-free |
| `app.share(data)` | `nova:share` | action result (§5) | no permission; **5 sheets/min**; text ≤ 4000, title ≤ 120 |
| `app.openWith(fileId)` | `nova:open-with` | chooser result | fileId ≤ 200 chars; file must be granted/resolvable |
| `data.export(options)` | `nova:data:export` | envelope | `data:export`; `keys` ≤ 1000 |
| `data.import(envelope)` | `nova:data:import` | `{success, merged?}` | `data:export`; merge-only; `POLICY_BLOCKED` foreign envelope |
| `data.backup()` | `nova:data:backup` | envelope | `data:backup` |
| `data.restore(envelope, options?)` | `nova:data:restore` | `{success, restoredKeys, cleared, failedKeys[]}` | `data:backup`; checksum mismatch → `INVALID_ARGS` |

### 4.11 `share` / `alarms` / `push` (8 methods)

| Method | Channel | Returns | Errors / limits |
|---|---|---|---|
| `share.onInbound(cb)` | — (local; pushes `nova:share:inbound`) | `off()`; callback receives `{title, text, url, sourceAppId, firedAt, queued?}` | rejects TypeError; requires `system:share-target` grant + manifest `shareTarget` to actually receive (host re-checks on delivery) |
| `alarms.create(options)` | `nova:alarms:create` | `{success, replaced, alarm:{name, when, periodMinutes, scheduledTime}}` | `system:schedule`; name 1–64 chars `^[\w.:\-]+$`; **exactly one** of `when` (future epoch-ms, ≤ 1 year out) or `periodMinutes` (≥ **15**); 32/app (`RATE_LIMITED` `Max 32 alarms per app`); same-name create replaces |
| `alarms.clear(name)` | `nova:alarms:clear` | `undefined` (raw `{success, cleared}`) | `system:schedule` |
| `alarms.getAll()` | `nova:alarms:getAll` | own alarms array (default `[]`) | `system:schedule` |
| `alarms.onAlarm(cb)` | — (local; pushes `nova:background:alarm`) | `off()`; callback receives `{name, alarm:{name, when, periodMinutes, scheduledTime}, firedAt, queued?}` | rejects TypeError; fires in live sandboxes; one-shots missed while closed are queued (≤ 8, newest kept) and delivered after the next `nova:ready` |
| `push.register()` | `nova:push:register` | `{success, token, endpoint:'/api/push/publish', queued?, replaced?, subscribed}` — token is stable per install (`nps_` + 32 hex) | `push:receive`; token generation fails closed without CSPRNG |
| `push.unregister()` | `nova:push:unregister` | `undefined` (drops token AND queue) | `push:receive` |
| `push.onMessage(cb)` | — (local; pushes `nova:push:message`) | `off()`; callback receives `{appId, id, title?, body?, data?, sentAt, queued?}` | rejects TypeError; inbound budgets: title ≤ 200, body ≤ 2000, data ≤ 4096 bytes, id ≤ 64, queue ≤ 8 |

### 4.12 `settings` / `ready` / `events` / `geolocation` (7 methods)

| Method | Channel | Returns | Errors / limits |
|---|---|---|---|
| `settings.get(key)` | `nova:settings:get` | stored value, or **`undefined`** when unset | `system:info`; key must be in the 29-key readable allowlist else `PERMISSION_DENIED` `Settings key '<key>' is not readable by apps` |
| `settings.set(key, value)` | `nova:settings:set` | `undefined` | `system:settings` (wallpaper keys exempt); writable allowlist (readable minus `osVersion`/`devMode`); `POLICY_BLOCKED` for wallpaper policy |
| `ready.get()` | `nova:ready` | `{appId, permissions[], optionalPermissions[], osVersion, securityPatch, username}` (username null unless system app) | none |
| `events.on(name, cb)` | `nova:events:subscribe` (shared; tolerates `ALREADY_SUBSCRIBED`) | Promise<off()>; host unsubscribes when the last listener for the name goes (and no v1 listener holds it) | see §6.2 for names/gates; rejects the host error on refusal (local listener rolled back) |
| `events.subscribe(name)` | `nova:events:subscribe` | raw | rejects `ALREADY_SUBSCRIBED` if `on()`/v1 already subscribed the name |
| `events.unsubscribe(name)` | `nova:events:unsubscribe` | `undefined` | none (own-sandbox only) |
| `geolocation.getCurrentPosition(options?)` | `nova:device:geolocation {options}` | `{coords:{latitude, longitude, altitude, accuracy, altitudeAccuracy, heading, speed}, timestamp}` | `device:geolocation`; options passed through unvalidated; `GEOLOCATION_ERROR`; **no watchPosition by design** |

### 4.13 `calendar` / `contacts` (6 methods)

| Method | Channel | Returns | Errors |
|---|---|---|---|
| `calendar.list()` | `nova:calendar:read` | events array (shared store) | `calendar:read` |
| `calendar.save(event)` | `nova:calendar:write` | the host-normalized record | `calendar:write`; `INVALID_EVENT` `Event must have a title and a YYYY-MM-DD date` |
| `calendar.remove(id)` | `nova:calendar:delete` | boolean removed | `calendar:delete`; `INVALID_ID` |
| `contacts.list()` | `nova:contacts:read` | contacts array (shared store) | `contacts:read` |
| `contacts.save(contact)` | `nova:contacts:write` | the host-normalized record | `contacts:write`; `INVALID_CONTACT` `Contact must have at least a name` |
| `contacts.remove(id)` | `nova:contacts:delete` | boolean removed | `contacts:delete`; `INVALID_ID` |

### 4.14 `mail` (14 methods) / `admin` (6 methods)

Identical mapping and semantics to the v1 surfaces — see §3.21 and §3.22 (payloads pass verbatim; responses are action-shaped and left unnormalized, `:10858-10861`). Method list (v1 = v2): mail `connect`, `disconnect`, `restore`, `account`, `folders`, `messages`, `message`, `search`, `preview`, `markRead`, `move`, `send`, `remove`, `openLink`; admin `auditQuery`, `systemGet`, `systemSet`, `usersList`, `usersRevoke`, `appsList`.

### 4.15 `background` / `permissions` (5 methods)

| Method | Channel | Returns | Errors / limits |
|---|---|---|---|
| `background.stayAlive(enabled?)` | `nova:background:stay-alive` | `{enabled}` | `system:background:live`; session-only |
| `background.wakeDone()` | `nova:background:wake-done` | `undefined` | none (scheduler pre-verified) |
| `background.onWake(cb)` | — (local; pushes `nova:background:wake`) | `off()`; fires only in wake-cycle sandboxes; payload `{wokeAt, deadlineMs}` | rejects TypeError |
| `permissions.request(permission, reason?)` | `nova:request-permission` | **boolean** granted | prompt rate limit 3/60 s + 5 s→15 min cooldown (§7) |
| `permissions.checkRateLimited(permission)` | `nova:permission-rate-limited` | raw status record, e.g. `{rateLimited:true, retryAfterMs:30000}` | none (peek only; never prompts) |

### 4.16 `net` (1 method)

| Method | Channel | Returns | Errors / limits |
|---|---|---|---|
| `net.websocket(url, protocols?)` | `nova:net:websocket` (+ `nova:net:ws:send`/`ws:close`) | handle `{wsId, readyState, onMessage(cb), onError(cb), onClose(cb), send(data), close(code, reason)}` — callbacks validated (throw TypeError), own listener registry independent of v1's | `net:websocket`; internal destinations additionally need `net:internal`; ws/wss only; credentials in URL rejected; no socket-count/frame-size caps; open failure = generic timeout |

### 4.17 `registry` (8 methods) — NovaByte Registry

Per-hive write rules (host-side, `:10976-10979`): apps write only their own `HKNA/<appId>/` subtree; `HKNS` needs a system app; `HKNU` needs `registry.system` (or a manifest `registryScopes.write` prefix — default scope for undeclared third-party manifests is `HKNU/software/<appId>`); `HKND` needs Developer Mode; `HKNS/security` needs `registry.system` everywhere. Per-key ACLs apply to every caller without `registry.system`.

| Method | Channel | Returns | Errors / limits |
|---|---|---|---|
| `registry.get(path)` | `nova:reg:get` | stored value, or `undefined` when absent (bare key path = key default) | `registry.read`; `UNAVAILABLE` without engine; engine codes pass through |
| `registry.stat(path)` | `nova:reg:get` | raw `{found, path, type?, data?, lastModified?, expanded?}` | `registry.read` |
| `registry.set(path, value, type?)` | `nova:reg:set` | `{success, path, type}` | `registry.write`; `INVALID_ARGS` (`value is required (null is only valid for REG_JSON)`); depth ≤ 16, name ≤ 64, value ≤ 256 KB (`QUOTA_EXCEEDED`); `INVALID_VALUE` |
| `registry.remove(path, {recursive}?)` | `nova:reg:delete {recursive}` | `{success, path, removed}` | `registry.write`; keys need `recursive:true` else `SUBTREE_NOT_EMPTY` |
| `registry.list(path)` | `nova:reg:list` | engine listing (`{keys[], values{}}`) | `registry.read`; `NOT_FOUND` `no such key: <path>` |
| `registry.export(path)` | `nova:reg:export` | `{path, data}` | `registry.read` |
| `registry.import(path, data)` | `nova:reg:import` | `{success, path, merged}` | `registry.write`; `INVALID_ARGS` (`import needs a target key path`) |
| `registry.watch(path, cb)` | sugar over `nova:events:subscribe('nova:reg:changed')` + guest-side prefix filter (backslashes normalized) | Promise<off()> | needs the same grants as subscribing (`registry.read`); callback receives `{path, type, value, appId}` |

Types: `REG_SZ`, `REG_DWORD`, `REG_QWORD`, `REG_BOOL`, `REG_JSON`, `REG_BINARY`, `REG_MULTI_SZ` (explicit-only), `REG_EXPAND_SZ`, `REG_LINK`; auto-detection for untyped values; `HKCU` aliases `HKNU`.


---

## 5. Raw channel reference

The definitive table of every guest-reachable `nova:*` channel: **124 channels** registered in `API_HANDLERS` (`:9338-9463`). Columns:

- **Facade** — the v1/v2 method(s) that wrap the channel.
- **Permission (MAC)** — the exact NB-MAC front-door gate from `SEED_ENDPOINT_GRANTS` (`:534-681`). `['a','b']` = **ANY-of** those grants; `advisory` = `null` row (no front-door gate; the handler's own checks are the boundary); `ungated` = no row needed (advisory family or two-segment type). Handler-level gates beyond MAC are listed under Errors/notes.
- **Rate limit** — per-app sliding 60 s window unless noted.
- **Payload** / **Response** — request/response field shapes (defaults and clamps stated).
- **Errors** — error codes the handler can emit (messages in §8 where listed).

Every channel additionally rejects `PERMISSION_DENIED` at the MAC front door when its grant row is unmet, `UNKNOWN_API` when mistyped, and `INTERNAL_ERROR` when the handler throws (`:9569-9614`). Channels usable from **isolated processes** (Tier-2 workers, no webview — allowlist `ISOLATED_PROCESS_API_TYPES`, `:9465-9490`) are marked **[isolated ok]**; everything else returns `UNAVAILABLE` (`This API is not available to isolated processes`, `:9627-9634`).

### 5.0 Channel inventory by family

| Family | Channels | MAC gates | Sections |
|---|---|---|---|
| Lifecycle/meta | 3 | advisory/ungated | §5.1 |
| Filesystem (`fs`, `media`) | 11 | advisory rows (path-dependent ownership is the boundary); `fs:watch` grant-coupled | §5.2 |
| Dialogs (`files`, `dialog`, `sysdialog`) | 6 | ungated (user-mediated) | §5.3 |
| Storage | 6 | ungated (own namespace) | §5.4 |
| Data portability | 4 | `data:export` / `data:backup` | §5.5 |
| Appearance | 4 | ungated | §5.6 |
| Context menu / overlay | 4 | handler-checked `sandbox:nested-webview` | §5.7 |
| Share / open-url / open-with / email / download | 5 | ungated or caller-pinned | §5.8 |
| Apps & Home | 8 | `system:apps` family, ANY-of launch | §5.9 |
| Window | 6 | ungated | §5.10 |
| Clipboard | 2 | `clipboard:read` / `clipboard:write` | §5.11 |
| Permissions | 2 | ungated (prompt engine limits) | §5.12 |
| Events | 2 | advisory (allowlist + domain gates in handler) | §5.13 |
| App-IPC | 7 | `apps:communicate` (unsubscribe advisory) | §5.14 |
| Background | 2 | `system:background:live`; wake-done advisory | §5.15 |
| Networking | 4 | `net:*` (ANY-of at front door) | §5.16 |
| Notifications | 7 | `device:notifications` | §5.17 |
| Settings / wallpaper | 3 | `system:info` / `system:settings` (wallpaper exempt) | §5.18 |
| Registry | 6 | `registry.read` / `registry.write` | §5.19 |
| Alarms | 3 | `system:schedule` | §5.20 |
| Secrets | 4 | `secrets:store` | §5.21 |
| Push | 2 | `push:receive` | §5.22 |
| Badge | 2 | `system:badge` | §5.23 |
| Devices | 3 | `device:*` | §5.24 |
| Calendar / contacts | 6 | `calendar:*` / `contacts:*` | §5.25 |
| System info / locale | 2 | `system:info` / ungated | §5.26 |
| Mail | 5 | `mail:*` | §5.27 |
| Admin | 4 | `admin:*` (+ machine admin mode) | §5.28 |
| Nested webview | 1 | `sandbox:nested-webview` | §5.29 |
| **Total guest-reachable** | **124** | | |
| Host-only (`GUEST_FORBIDDEN_IPC_APIS`) | 40 | none — dispatch-rejected | §5.30 |

MAC policy structure (context for the Permission column): `SEED_ENDPOINT_GRANTS` has 88 rows — 67 grant-coupled (permission arrays, ANY-of) and 21 advisory (`null`); 20 advisory families cover the ungated surfaces (`nova:fs`, `nova:storage`, `nova:window`, `nova:appearance`, `nova:ready`, `nova:dialog`, `nova:sysdialog`, `nova:overlay`, `nova:context-menu`, `nova:share`, `nova:files`, `nova:email`, `nova:open-url`, `nova:open-with`, `nova:download`, `nova:wallpaper`, `nova:request-permission`, `nova:permission-rate-limited`, `nova:audit`, `nova:locale`, `:534-695`). A missing row is default-**deny** (`no policy rule for this endpoint`); the `nova:admin` family is a neverallow target (rows must stay grant-coupled).

### 5.1 Lifecycle & meta

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:ready` **[isolated ok]** | `nova.app.getInfo()`, `novaOS.ready.get()` | ungated | none | `{}` | `{success, appId, permissions[], optionalPermissions[], osVersion, securityPatch, username?}`; then flushes queued alarms, inbound shares, push | — |
| `nova:app:info` **[isolated ok]** | `novaOS.app.info()` | advisory (`null`) | none | `{}` | `{id, name, version, icon, type, permissions, optionalPermissions}` | `UNAVAILABLE` `No app context` |
| `nova:audit:eval` | internal (shim eval audit) | ungated | none | eval audit info | `{success:true}` (observability only — CSP already blocks eval) | — |

### 5.2 Filesystem (11 channels)

All `nova:fs:*` MAC rows are `null` (advisory) **by design**: ownership is path-dependent — app-owned `/data/<appId>/` paths need no grant at all; shared-tree paths need `fs:access`, a user-picked file, or a matching media grant (`fs:read:images\|video\|audio` by MIME), so the handler is the boundary (`:323-337`, `:534`).

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:fs:read` **[isolated ok]** | `novaOS.fs.read/appdata.read/shared.read` | advisory | none | `{path}` or `{id}` | file `{success, data, mimeType, name, size, id, path, modified, created}`; folder `{success, isFolder:true, name, id, path, children[]}` | `NOT_FOUND` `File or folder not found`; `PERMISSION_DENIED` (folder listing / file contents variants); ledger `noteBytes(read)` |
| `nova:fs:write` **[isolated ok]** | `novaOS.fs.write/appdata.write` | advisory | none | picked: `{id, content}`; path: `{path, content}` (+`mimeType` for create, default `text/plain`) | create `{success, id, path}`; update `{success}` | `INVALID_ARGS` (`content is required`, `path and content are required`, `Content is not JSON-serializable: …`); `INVALID_OPERATION` `Cannot write to a folder`; `PERMISSION_DENIED` (`shared:/media: roots cannot address app data`, write-grant variants); `NOT_FOUND` (`Selected file no longer exists`, `Parent folder not found`); `UNAVAILABLE` (confirm unavailable) |
| `nova:fs:delete` **[isolated ok]** | `novaOS.fs.remove/appdata.remove` | advisory | none | `{path\|id, permanent?}` (permanent = bypass trash) | `{success:true}`; confirm-cancel resolves `{cancelled:true}` | `NOT_FOUND`; `PROTECTED_LOCATION` `System filesystem roots cannot be deleted` (root, trash, `/data`); `PERMISSION_DENIED`; `UNAVAILABLE` `User confirmation is required to delete a shared file` |
| `nova:fs:list` **[isolated ok]** | `novaOS.fs.list/appdata.list/shared.list` | advisory | none | `{path}` (folder only) | `{success, path, files[]}` | `NOT_FOUND` `Folder not found`; `INVALID_OPERATION` `Path is not a folder`; `PERMISSION_DENIED` |
| `nova:fs:mkdir` **[isolated ok]** | `novaOS.fs.mkdir` | advisory | none | `{path (parent), name}`; own-subtree ancestors auto-created | `{success, id, path}` | `INVALID_ARGS` `name is required`; `PERMISSION_DENIED` (`shared:/media: roots…`, `Folders can only be created in app-owned storage unless fs:access is enabled`); `NOT_FOUND` `Parent folder not found` |
| `nova:fs:stat` **[isolated ok]** | `novaOS.fs.stat` | advisory | none | `{path\|id}` | `{success, stat:{id,name,type,mimeType,size,path,parentId,created,modified,accessed,permissions,sha256,tags}}` | `NOT_FOUND` `File not found`; `PERMISSION_DENIED` `Shared file metadata requires fs:metadata or the matching media read grant` |
| `nova:fs:rename` **[isolated ok]** | `novaOS.fs.rename` | advisory | none | `{path\|id, name}` | `{success, name}` | `NOT_FOUND`; `PERMISSION_DENIED`; `UNAVAILABLE` `User confirmation is required to rename a shared file`; `INVALID_ARGS` `name is required` |
| `nova:fs:move` **[isolated ok]** | `novaOS.fs.move` | advisory | none | `{path\|id, destPath}` (destination parent) | `{success, path}` | `NOT_FOUND` (`File not found`, `Destination folder not found`); `PERMISSION_DENIED` (move grant / `shared:/media:` roots / `Destination folder is outside this app's data directory`) |
| `nova:media:query` **[isolated ok]** | `novaOS.media.query` | advisory | none | `{type: all\|image\|audio\|video, offset?, limit?}` | `{files[]}` (filtered by readability) | `INVALID_ARGS` `type must be all, image, audio, or video`; `PERMISSION_DENIED` `Media queries require a matching media-read grant, fs:metadata, or fs:access`; `UNAVAILABLE` `NovaByte MediaStore is unavailable` |
| `nova:fs:watch` **[isolated ok]** | `novaOS.fs.watch` | **`fs:watch`** (grant row) | 8 watchers/app; pushes 60/min | `{path, watcherId?}` (id honored only if unused or own; pattern `^w_[a-z0-9_]{4,64}$`) | `{success, watcherId, path}` | `NOT_FOUND`; `PERMISSION_DENIED` (read-parity: watching is reading); `RATE_LIMITED` `Max 8 watchers per app`. Push: `nova:fs:changed {watcherId, path, kind: created\|changed\|deleted, timestamp}`, polled every 2000 ms, debounced 300 ms; rate-limited events are dropped (snapshot advanced) |
| `nova:fs:unwatch` **[isolated ok]** | `novaOS.fs.unwatch`, `watch().unwatch()` | advisory | none | `{watcherId}` | `{success, cleared}` (idempotent; foreign id = `cleared:false`) | — |

### 5.3 File & system dialogs (6 channels) — user-mediated, no permission gates

All are **interactive** (10-min shim timeout). Picking grants scoped access: VFS node ids join `sandbox.pickedFileIds`; host paths must round-trip the trusted picker (absolute path, basename match, regular file, no symlinks on write).

| Channel | Facade | Permission | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:files:open` | `nova.files.open(options)` | ungated | none | `{accept?, multiple?}` | `{success, file:{id,name,content,mimeType,size,path}}` (+ scoped access granted) | `INVALID_ARGS` (accept contract); `UNSUPPORTED_TYPE` `Selected file is not available as text`; `FILE_TOO_LARGE` (> **10 MB**); `PICKER_ERROR`; `PERMISSION_DENIED` (VFS resolve) |
| `nova:files:save` | `nova.files.save(options)` | ungated | none | `{content (string ≤ 10 MB), mimeType?, defaultName?…}` (normalized twice: pre- and post-pick) | `{success, file}` | `INVALID_ARGS` `content must be a string up to 10 MB`; `PICKER_ERROR`; `UNAVAILABLE` `User confirmation is required to overwrite a shared file`; `PERMISSION_DENIED` |
| `nova:dialog:open` | `novaOS.dialog.pickOpen({style:'system'})` | ungated | none | `{accept?}` | `{success, file:{…}}` | `INVALID_ARGS` `accept must be a string or an array of at most 20 MIME types and/or file extensions (e.g. ".json")` |
| `nova:dialog:save` | `novaOS.dialog.pickSave({style:'system'})` | ungated | none | save options | `{success, file}` | `WRITE_ERROR` `Failed to write file`; `PERMISSION_DENIED` `Selected folder is outside the accessible files` |
| `nova:sysdialog:open` | `novaOS.dialog.pickOpen()` (default style) | ungated | none | `{title? ≤100, startPath? ≤4096, accept?, multiple?}` | `{success, file, files[]}` (multi normalized; host-path entries read with the 10 MB cap) | `UNAVAILABLE` `SystemDialogs not loaded`; `INVALID_ARGS`; `PERMISSION_DENIED` `Selected file is outside this app's accessible files`; `LIMIT_REACHED` (multi > **25**); `DIALOG_ERROR` |
| `nova:sysdialog:save` | `novaOS.dialog.pickSave()` (default) | ungated | none | `{title?, startPath?, suggestedName? ≤255, content, mimeType?}` | `{success, file}` (host-path write: `O_NOFOLLOW`/`O_EXCL`, mode 0600, truncate+write+sync) | `PERMISSION_DENIED` `Selected folder is outside the accessible files`; `UNAVAILABLE` (confirm unavailable); `WRITE_ERROR` |

Picker `accept` contract: array form ≤ 20 entries, each a MIME (`a/b` pattern) or extension (`.ext`), ≤ 64 chars; **string form passes through unvalidated if ≤ 512 chars** (`:8815-8823`). Overwriting an existing host file requires `window.confirm` unless the app holds `fs:access`.

### 5.4 Storage (6 channels) — per-app key-value

IndexedDB `NovaByte_AppStorage` / store `kv2`, composite key `[ownerUid, appId, key]`; cross-owner and cross-app addressing is impossible by construction (`:6615-6676`). All **[isolated ok]**.

| Channel | Facade | Permission | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:storage:get` | `novaOS.storage.get` | ungated (advisory family) | none | `{key}` | `{success, value}` — **IndexedDB failure resolves `{success:true, value:null}`** (fail-open read) | `INVALID_ARGS` `Invalid storage key` |
| `nova:storage:set` | `novaOS.storage.set` | ungated | none | `{key, value}` | `{success}` | `INVALID_ARGS` (key, `Value is not JSON-serializable: …`); `STORAGE_FULL` (`Value exceeds 5242880 byte limit`, per-(owner,app) quota `Storage quota exceeded`, per-user `Account storage quota exceeded`) |
| `nova:storage:delete` | `novaOS.storage.remove` | ungated | none | `{key}` | `{success}` | `INVALID_ARGS`; `ERROR` |
| `nova:storage:clear` | `novaOS.storage.clear` | ungated | none | `{}` | `{success}` (own owner+app rows only) | `ERROR` |
| `nova:storage:keys` | `novaOS.storage.keys` | ungated | none | `{}` | `{success, keys[]}` | `ERROR` |
| `nova:storage:usage` | `novaOS.storage.usage` | ungated | none | `{}` | `{usage, budget}` (real IndexedDB usage + ledger budget) | `ERROR` |

### 5.5 Data portability (4 channels) — own namespace only

Envelope `{novaDataEnvelope:1, format:1, kind:'backup'\|'export', appId, capturedAt, storage:{}, counts, checksum}`; checksum = sha256 over key-sorted storage JSON. Restore/import refuse any envelope whose `appId` ≠ caller; secrets never ride in envelopes. All **[isolated ok]**.

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:data:export` | `nova.data.export`, `novaOS.data.export` | **`data:export`** | none | `{keys[] ≤ 1000}` or `{prefix}` (selector required) | envelope (`kind:'export'`) | `INVALID_ARGS` (`keys is limited to 1000 entries per export`, no selector) |
| `nova:data:import` | `nova.data.import`, `novaOS.data.import` | **`data:export`** | none | `{envelope}` (kind `export`) | `{success, merged}` — merge-only, never deletes absent keys | `POLICY_BLOCKED` (foreign envelope); `INVALID_ARGS` (kind mismatch, bad storage object, `envelope checksum mismatch — the data is corrupt or was modified`) |
| `nova:data:backup` | `nova.data.backup`, `novaOS.data.backup` | **`data:backup`** | none | `{}` | envelope (`kind:'backup'`, full namespace) | `ERROR` |
| `nova:data:restore` | `nova.data.restore`, `novaOS.data.restore` | **`data:backup`** | none | `{envelope, clearFirst?}` | `{success, restoredKeys, cleared, failedKeys[{key, reason}]}` (per-key over-cap failures don't fail the call) | `POLICY_BLOCKED`; `INVALID_ARGS` (kind/checksum) |

### 5.6 Appearance (4 channels)

| Channel | Facade | Permission | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:appearance:get` | `nova.appearance.get` | ungated | none | `{}` | `{theme, accentColor, highContrast, reduceMotion, removeTransparency, transparentSurfaces}` (`transparentSurfaces` = inverse of `removeTransparency`) | — |
| `nova:appearance:set` | `nova.appearance.set` | ungated | **10/min** `Max 10 appearance updates per minute` | `{appearance}` — fields `theme\|accentColor\|highContrast\|reduceMotion\|removeTransparency\|transparentSurfaces`; theme ∈ 7 values (`nova-dark, nova-light, nord, dracula, catppuccin, tokyo-night, gruvbox`); accentColor `#rrggbb` or null; rest boolean | `{success}` | `INVALID_ARGS` (field allowlist / values); `POLICY_BLOCKED` `Appearance setting 'X' is blocked by system policy` |
| `nova:appearance:subscribe` | `nova.appearance.onChange` (first) | ungated | 1 subscription/sandbox | `{}` | `{success}` | `ALREADY_SUBSCRIBED`; pushes `nova:appearance:changed:event` with the appearance record (only the 5 public keys) |
| `nova:appearance:unsubscribe` | auto (last `off()`) | ungated | none | `{}` | `{success}` | — |

No permission required — validated appearance changes work without `system:settings` (test-pinned, app-sandbox.test.js:2151).

### 5.7 Context menu & overlay (4 channels) — require nested-webview grant

Handler gate on all four: `isNestedWebviewPermitted(app)` = manifest opt-in **AND** live `sandbox:nested-webview` grant (fail-closed on throw, `:9994-10001`).

| Channel | Facade | Permission | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:context-menu:show` | `nova.contextMenu.show(x,y,items)` | ungated at MAC; handler = `sandbox:nested-webview` | none | `{x, y (finite), items[1-100]: {label ≤120, icon ≤64, shortcut ≤32, disabled?, danger?}}`; ≥ 1 selectable item | `{cancelled, index}` (menu at host-screen coords, unclamped) | `INVALID_ARGS` (4 message variants); `UNAVAILABLE` `Host context menus are unavailable` |
| `nova:context-menu:hide` | `nova.contextMenu.hide()` | as above | none | `{}` | `{success, wasOpen}` | — |
| `nova:overlay:show` | `nova.overlay.show(options)` | as above | none | `{html ≤100000, css ≤50000, bounds{x,y,width,height}}` | `{success, overlayId}`; forwards `nova:overlay:event` for click/input/change/submit/keydown on `[data-nova-action]`/`[data-nova-field]` (action/field ≤100, value ≤4096, key ≤64) | `INVALID_ARGS` `Overlay HTML and CSS must be strings within the size limits`; `SANITIZE_FAILED`; `RENDER_FAILED` (`Timed out while loading the host overlay` after 15 s, render failure); `CANCELLED` `Overlay was closed before rendering completed` |
| `nova:overlay:hide` | `nova.overlay.hide()` | as above | none | `{}` | `{success, wasOpen}` | — |

Overlay content runs in a `sandbox="allow-same-origin"` iframe (no scripts) under a locked-down CSP with DOMPurify `FORBID_TAGS: script, iframe, object, embed, base, meta, link` (`:3448-3451`).

### 5.8 Share / URL / email / download (5 channels)

| Channel | Facade | Permission | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:share` | `nova.share(data)`, `novaOS.app.share(data)` | ungated (the sheet is the consent) | **5/min** `Max 5 share sheets per minute` | `{text? ≤4000, url? (credential-free http(s)), title? ≤120}` | action result: Cancel/backdrop/Escape → `{cancelled:true}`; Copy / Open link / Email → `{}`; Send-to-target → `{sharedWith, queued}` | `INVALID_ARGS` (`Share requires text or a URL; text is limited to 4000 characters`, `url must be a credential-free HTTP(S) URL`); `UNAVAILABLE` `Share sheet is not available`; `SHARE_FAILED` (action error). Sheet lists ≤ 6 `system:share-target` holders matching the content MIME |
| `nova:open-url` | `nova.openUrl`, `novaOS.app.openUrl` | ungated | none | `{url}` (parses, http/https, no credentials) | `{success, windowId}` | `INVALID_ARGS` (`A valid HTTP(S) URL is required`, `Only credential-free HTTP(S) links can be opened`); `UNAVAILABLE` (`OS URL service not available`, `No default browser app could be opened`) |
| `nova:open-with` | `nova.openWith`, `novaOS.app.openWith` | ungated (file must be granted/resolvable) | none | `{fileId}` (string ≤ 200) | chooser result | `INVALID_ARGS` `A fileId is required`; `NOT_FOUND` `File is unavailable to this app`; `UNAVAILABLE` `Open with chooser is unavailable` |
| `nova:email:open-link` | `nova.mail.openLink`, `novaOS.mail.openLink` | hard caller pin (not a permission string): caller must be `com.nbosp.email`, verified, `NovaByte System`-signed, `manifest.system` (`:4032-4034`) | none | `{url}` | open result | `PERMISSION_DENIED` for every other app |
| `nova:download` | `nova.browser.download(options)` (opt-in); anchor `download` interceptor | ungated ("the native save dialog itself is the control"; **no size cap**) | none | `{filename?, mimeType?, base64Data}` (filename sanitized: path separators/control chars/leading dots stripped, ≤ 255, fallback `download`) | `{success:true}` after the real disk write at the user-chosen path; cancel → `{success:false, cancelled:true}` | `INVALID_ARGS` (`base64Data is required`, `base64Data is not valid base64`); `UNAVAILABLE` (`SystemDialogs not loaded`, fs module errors); `TIMEOUT` `Save dialog timed out` (5 min); `IO_ERROR` (write/dialog failure); EventLog `downloads` entry side effect |

### 5.9 App management & Home surface (8 channels)

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:app:launch` | `nova.app.launch`/`nova.apps.launch`, `novaOS.app.launch` | **ANY-of `system:app-launch`, `system:apps`** | **30/min** `Max 30 cross-app launches per minute` | `{appId, options?}` — `fileIntent`/`fileId`/`folderId` deleted from app-supplied options | `{success, windowId}` | `INVALID_ARGS` `appId is required`; `PERMISSION_DENIED` `Developer Mode must be enabled to launch this app` (devOnly target); `UNAVAILABLE` `Window manager not available` |
| `nova:app:list` | `nova.apps.list`, `novaOS.app.list` | **`system:apps`** | none | `{}` | `{success, apps[{id,name,version,icon,iconUrl,description,categories,verified,system,signer,manifest:{system},source,builtin,devOnly}]}` (icon data-URI ≤ 700 000 chars) | `UNAVAILABLE` `App registry not available` |
| `nova:app:install` | `nova.apps.install(pkg)` | **`system:apps`** | none | `{package: {manifest, files, signature, integrity}}` (parsed package object) | `{success:true, id, name, version}` (registered `source:'file'`, `verified:true`, `signer`) | `INVALID_PACKAGE` (missing id/name/version); `MALICIOUS_PACKAGE` (scanner verdict); `SCAN_FAILED` (scanner threw — fail closed); `UNVERIFIED` `Package has no integrity record — install manually via App Manager`; `TAMPERED`; `UNTRUSTED` (trust store / revocation list); `ALREADY_INSTALLED`; `ERROR` (registration failure) |
| `nova:app:uninstall` | `nova.apps.uninstall(appId)` | **`system:apps`** | none | `{appId}` | `{success}` (full cleanup: windows, registry, partition, storage, ledger, permissions, notification state, defaults, pins) | self-uninstall refused `An app cannot uninstall itself`; `NOT_UNINSTALLABLE` (built-in / system-signed); `NOT_FOUND`; `UNINSTALL_FAILED` |
| `nova:app:openDefaultAppsSettings` | `nova.apps.openDefaultAppsSettings(category?)` | **`system:apps`** | **12/min** `Max 12 per minute` | `{category?}` (UI highlight hint only) | `{success}` (opens `com.nbosp.settings` default-apps section) | `RATE_LIMITED` |
| `nova:home:openDefaultAppsSettings` | `nova.home.openDefaultAppsSettings()` | advisory (Home-caller check is the boundary) | **12/min** | `{}` | `{success}` (highlights `home` category) | `PERMISSION_DENIED` unless caller is the currently selected Home app |
| `nova:home:apps:list` | `nova.home.apps.list()` | advisory | none | `{}` | `{success, apps[], fullAccess}` — without `system:apps` only `com.nbosp.settings` + `com.nbosp.appmanager` are listed; devOnly hidden unless devMode | `PERMISSION_DENIED` `Only the currently selected Home app can list apps`; `UNAVAILABLE` `App registry not available` |
| `nova:home:apps:launch` | `nova.home.apps.launch(appId)` | advisory (Home-caller; Settings/AppManager always launchable, others need launch grant) | **30/min** `Max 30 Home app launches per minute` | `{appId}` (no options passed) | `{success, windowId}` | `INVALID_ARGS`; `NOT_FOUND` `App is not registered`; `PERMISSION_DENIED` (devMode, launch grant) |

### 5.10 Window controls (6 channels)

| Channel | Facade | Permission | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:window:close` / `:minimize` / `:maximize` | `novaOS.window.close/minimize/maximize` | ungated | none | `{}` | `{success:true}` (best-effort, always success) | — |
| `nova:window:setTitle` | `novaOS.window.setTitle` | ungated | none | `{title}` (`String(...).slice(0, 200)`) | `{success}` | — |
| `nova:window:resize` | `novaOS.window.resize` | ungated | none | `{width, height}` — `parsePositiveInt(w, 800, 100)` / `(h, 600, 100)`; unmaximizes | `{success}` | — |
| `nova:window:getState` | `novaOS.window.getState` | ungated | none | `{}` | `{success, id, x, y, width, height, maximized, minimized}` | `NOT_FOUND` `Window not found` |

### 5.11 Clipboard (2 channels) — [isolated ok]

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:clipboard:read` | `novaOS.clipboard.readText` | **`clipboard:read`** | none | `{}` | `{success, text}` — falls back to the host's last written value (`OS.clipboard`) when `navigator.clipboard` fails | `PERMISSION_DENIED` `clipboard:read permission required for clipboard access` |
| `nova:clipboard:write` | `novaOS.clipboard.writeText` | **`clipboard:write`** | none | `{text}` (`payload?.text ?? ''` — 0/false preserved) | `{success}`; side effect: `OS.clipboard` + history (max 30) | `CLIPBOARD_UNAVAILABLE` `Could not write to the system clipboard: <err>` |


### 5.12 Permission requests (2 channels) — [isolated ok]

| Channel | Facade | Permission | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:request-permission` | `nova.requestPermission`, `novaOS.permissions.request` | ungated (self-service prompt) | prompt engine: **3 per 60 s burst**, then cooldown 5 s base doubling to 15 min cap (denial streak capped at 20) — excess asks are silently auto-denied, no dialog | `{permission, reason?, permanent?}` (`permanent !== false`; reason fallback `<app.name> wants to access this permission.`) | `{granted}` | `INVALID_ARGS` `permission is required`; `ERROR` on throw |
| `nova:permission-rate-limited` | `novaOS.permissions.checkRateLimited` | ungated | none | `{permission}` | status record verbatim, e.g. `{rateLimited:true, retryAfterMs:30000}` | — |

### 5.13 Events bus (2 channels)

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:events:subscribe` | `nova.onEvent` (first listener), `novaOS.events.on/subscribe` | advisory | 1 subscription per sandbox per name | `{event}` — must be in the 17-name allowlist (§6.2) | `{success, subscribed}`; pushes arrive as `nova:events:event {event, data}` | `PERMISSION_DENIED` (sensitive name without `system:events`; missing domain grant — ALL-of model); `INVALID_ARGS` `Event 'X' is not in the subscribable allowlist`; `ALREADY_SUBSCRIBED`; `UNAVAILABLE` `Event bus not available` |
| `nova:events:unsubscribe` | `novaOS.events.unsubscribe` | ungated (own sandbox only) | none | `{event}` | `{success, unsubscribed}` (always) | — |

### 5.14 App-to-app IPC (7 channels) — `apps:communicate`

Endpoint pattern `^(?:service\|provider):[a-z0-9][a-z0-9._-]{0,127}$`; action pattern `^[a-z0-9][a-z0-9._:-]{0,127}$`. Payloads clamped to the ledger `ipcPayloadBytes` budget (**256 KB** default) on invoke, broadcast, and reply. Rate limit: **20/min per `(appId:type)`** key (invoke and broadcast tracked separately).

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:ipc:register` | `nova.ipc.provide` | **`apps:communicate`** | none | `{endpoint}` — must be declared in own `manifest.ipc.exports` | `{success}` | `INVALID_ARGS` `endpoint must be a valid service: or provider: name`; `PERMISSION_DENIED` `Endpoint is not declared in manifest.ipc.exports`; `UNAVAILABLE` `App sandbox is not active`; `ALREADY_REGISTERED` |
| `nova:ipc:unregister` | `off()` from `provide()` | **`apps:communicate`** (consistency) | none | `{endpoint}` | `{success}` | `PERMISSION_DENIED` only |
| `nova:ipc:invoke` | `nova.ipc.call` | **`apps:communicate`** (caller) | **20/min** | `{targetAppId, endpoint, data}` | the provider's return value **spread as the response top level** (not wrapped) | `RATE_LIMITED` `Max 20 app IPC calls per minute`; `NOT_FOUND` `Target app does not export this endpoint`; `PERMISSION_DENIED` `Target app has not enabled apps:communicate`; `UNAVAILABLE` `Target endpoint is not running`; `REMOTE_ERROR` (provider error, string truncated 500 chars) / timeout `Target app did not respond before the IPC timeout` (25 s); sandbox closure cancels in-flight calls |
| `nova:ipc:reply` | internal (provider side) | **`apps:communicate`** (defense in depth) | none | `{callId, result? \| error?}` (result re-clamped) | `{success}` | `NOT_FOUND` `IPC request is no longer active` |
| `nova:ipc:broadcast:subscribe` | `nova.ipc.onBroadcast` (first) | **`apps:communicate`** | none | `{action}` — must be declared in own `manifest.ipc.receives` | `{success}` | `PERMISSION_DENIED` `Broadcast action must be declared in manifest.ipc.receives`; `UNAVAILABLE` |
| `nova:ipc:broadcast:unsubscribe` | last `off()` | advisory (no gate) | none | `{action}` | `{success, action}` | — |
| `nova:ipc:broadcast` | `nova.ipc.broadcast` | **`apps:communicate`** | **20/min** `Max 20 app broadcasts per minute` | `{action, data}` | `{delivered}` (count of live, subscribed, still-granted receiver sandboxes) | `INVALID_ARGS` `A valid broadcast action is required`; `RATE_LIMITED` |

Incoming requests/broadcasts reach the provider as pushes (`nova:ipc:request`, `nova:ipc:broadcast` — §6).

### 5.15 Background (2 channels)

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:background:wake-done` | `nova.backgroundWakeDone`, `novaOS.background.wakeDone` | advisory (scheduler pre-verified `system:background`) | none | `{}` | `{success:true}` (flips the wake-done flag) | — |
| `nova:background:stay-alive` | `nova.stayAliveInBackground`, `novaOS.background.stayAlive` | **`system:background:live`** | none | `{enabled}` (`payload?.enabled !== false`, default true; session-only, never persisted) | `{success, enabled}` | `PERMISSION_DENIED` `system:background:live permission required`; `UNAVAILABLE` `Sandbox not found` |

### 5.16 Networking (4 channels)

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:net:fetch` **[isolated ok]** | patched `fetch()`/`XHR`/`sendBeacon` | **ANY-of `net:internal`, `net:external`** (handler classifies per destination: internal → `net:internal`, else `net:external`) | none (server proxy limits out of scope) | `{url, method? (default GET; GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS), headers?, body?, bodyEncoding? ('utf8' \| 'base64')}` — base64 bodies capped by ledger `httpBodyBytes` (**16 MiB** default) | `{success, status, statusText, headers, body, bodyEncoding}` — textual content types → utf8 string; everything else → base64 + `bodyEncoding:'base64'`. **No response-size cap, no in-handler timeout** | `INVALID_ARGS` (`url` missing, `Method not allowed: X`, encodings other than utf8/base64); `PERMISSION_DENIED` (destination class); `PAYLOAD_TOO_LARGE` `Binary request body exceeds the N MiB limit`; `NETWORK_ERROR` (proxy failure); URL rules: http/https only, protocol-relative resolved against host origin, cloud-metadata hosts (169.254.169.254, fd00:ec2::254) hard-denied |
| `nova:net:websocket` | `nova.websocket`, `novaOS.net.websocket`, patched `WebSocket` | **`net:websocket`** (+ **`net:internal`** for private/first-party destinations) | none (no socket-count or frame caps) | `{url, protocols?}` — ws/wss only, absolute, no credentials in URL | `{success, wsId, readyState}` (resolved from `onopen` only; never-opening = generic timeout). Frames push `nova:net:ws:message` and mirror onto the OS event bus tagged with the owning appId | `INVALID_ARGS`-class URL errors (`Invalid WebSocket URL`, `Only ws and wss URLs are allowed`, `Credentials in WebSocket URLs are not allowed`, metadata-host denial); `PERMISSION_DENIED` `net:internal permission required for private or first-party WebSocket destinations` |
| `nova:net:ws:send` | handle `send(data)` | advisory | none (no size cap) | `{wsId, data}` (objects JSON-stringified, null → `''`, else `String()`) | `{success:true}` | `UNAVAILABLE` `WebSocket not supported`; `INVALID_ARGS` `wsId is required`; `NOT_FOUND` `WebSocket connection not found` (foreign/unknown id); `INVALID_STATE` (`WebSocket is not open`, send failure) |
| `nova:net:ws:close` | handle `close(code, reason)` | advisory | none | `{wsId, code? (default 1000), reason?}` | `{success:true}` (even for unknown ids; map entry deleted) | — |

Internal-host classification (`isInternalHost`): `localhost`, `api.novabyte.internal`, private IPv4 (127/8, 10/8, 172.16-31, 192.168/16, 169.254/16, 0.0.0.0/8, 100.64/10), IPv6 (`::1`, `::`, fc00::/7, fe80::/10, IPv4-mapped/-compatible), and — for WebSockets only — single-label names plus `.localhost .local .lan .internal .home.arpa .test` suffixes (`:1267-1401`, `:1299-1326`).

### 5.17 Notifications (7 channels) — `device:notifications` on every channel

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:notifications:show` **[isolated ok]** | `novaOS.notifications.show` | **`device:notifications`** | **10/min** `Max 10 notifications per minute` | `{title ≤120 (default 'Notification'), body ≤500, type ∈ info\|success\|warning\|error (default info), icon ∈ 22-id allowlist, action?, actionLabel ≤40}` | `{success:true}` | `UNAVAILABLE` (service down — checked before the rate-limit burn); `PERMISSION_DENIED` `device:notifications permission required` |
| `nova:notifications:post` **[isolated ok]** | `novaOS.notifications.post` | **`device:notifications`** | new **10/min** / tagged update **60/min** (`Max 10 notification posts per minute` / `Max 60 notification updates per minute`) | `{channelId ≤64 (default 'general'), tag? ≤64, title, body, type, icon, actions? ≤3 {id ≤40 slug, label ≤40}, progress? {value, max (clamp 1..100000), indeterminate}}` | `{success, posted, updated, id, importance}`; muted channel → `{success:true, posted:false, reason:'CHANNEL_MUTED', importance}` | `INVALID_ARGS` `Unknown notification channel '<id>' — create it first (nova:notifications:createChannel) or declare notifications.channels in the manifest`; omitted `actions`/`progress` inherit field-wise (explicit `[]`/`null` clears) |
| `nova:notifications:createChannel` **[isolated ok]** | `novaOS.notifications.createChannel` | **`device:notifications`** | 32 channels/app | `{id (1–64, `^[a-zA-Z0-9_-]+$`), name ≤60 non-empty, importance}` (importance locked at creation) | `{success, created, channel:{id,name,importance}}` | `INVALID_ARGS` (id/name rules); `LIMIT_REACHED` `Max 32 channels per app` |
| `nova:notifications:cancel` **[isolated ok]** | `novaOS.notifications.cancel` | **`device:notifications`** | none | `{id? \| tag?}` (exactly one required) | `{success, removed}` | `INVALID_ARGS` `either tag or id is required` |
| `nova:notifications:cancelAll` **[isolated ok]** | `novaOS.notifications.cancelAll` | **`device:notifications`** | none | `{}` | `{success:true}` | — |
| `nova:notifications:clear` **[isolated ok]** | `novaOS.notifications.clear` | **`device:notifications`** | none | `{}` | `{success:true}` (clears this app's notifications) | — |
| `nova:notifications:consumeActions` **[isolated ok]** | `novaOS.notifications.consumeActions` | **`device:notifications`** | none | `{}` | `{success, actions[]}` (pull queue; ≤ 20 pending clicks/app; action clicks are **never pushed**) | — |

Icon allowlist (22): `archive, bell, bookmark, box, clock, file, folder, globe, image, layout, lock, monitor, music, package, play, refresh, search, sound, star, unlock, users, x` (`:1047-1051`). Legacy string actions restricted to `settings, open-settings, openSettings, open-store`; function-typed actions are dropped entirely ("coercion here is exactly how a sandbox escape would sneak through", `:1465-1471`). The panel stores 100 notifications, renders 50.

### 5.18 Settings & wallpaper (3 channels) — [isolated ok for settings]

Readable keys (29, `SETTINGS_READABLE_KEYS` `:2941-2949`): `_hiddenDevIconPositions, accentColor, autoLock, browserPartitionId, clockFormat, cursorSize, customWallpaper, debugOverlayVisible, desktopGridSpacing, desktopIconPositions, desktopIconSize, devMode, filesViewOnly, highContrast, osVersion, pinnedApps, prohibitWallpaperChange, reduceMotion, region, removeTransparency, showDesktopIcons, showTaskbarClock, taskbarAutoHide, taskbarPosition, taskbarSize, theme, timezone, username, wallpaperId`. Writable = readable minus `osVersion` and `devMode`. Credentials (`lockPin`, `pinSalt`, `biometricCredentialId`, `bootPassword`) are excluded from both lists.

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:settings:get` | `novaOS.settings.get` | **`system:info`** | none | `{key}` | `{success, value}` | `INVALID_ARGS` `key is required`; `PERMISSION_DENIED` `system:info permission required` / `Settings key '<key>' is not readable by apps` |
| `nova:settings:set` | `novaOS.settings.set` | **`system:settings`** — wallpaper keys (`wallpaperId`, `customWallpaper`) are exempt from the grant but still allowlist-bound | none | `{key, value}` | `{success}` | `PERMISSION_DENIED` (grant / non-writable key); `POLICY_BLOCKED` `Wallpaper changes are disabled by system policy`; `INVALID_ARGS` (wallpaper value validation when WallpaperService is available) |
| `nova:wallpaper:set` | `nova.wallpaper.set` | ungated (documented exemption; `prohibitWallpaperChange` policy still applies) | none | `{key: 'wallpaperId'\|'customWallpaper', value}` — `wallpaperId` preset ids: `stock-blue/dark/light/green/purple/red/gray/teal`, or null/'' to clear; `customWallpaper` any string (data URL in practice), null/'' to clear | `{success}` | `INVALID_ARGS` `key must be 'wallpaperId' or 'customWallpaper'` (+ preset-id/type validation); `POLICY_BLOCKED` |

### 5.19 Registry (6 channels)

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:reg:get` | `novaOS.registry.get/stat` | **`registry.read`** | engine quotas (below) | `{path}` (bare key path = key default; `(default)` segment addressing; `\` and `/` both accepted) | `{found, path, type?, data?, lastModified?, expanded?}` | `UNAVAILABLE` `Registry service not available`; engine codes (`INVALID_ARGS`, `NOT_FOUND`-ish parse errors); `HKNS/security` read needs `registry.system` |
| `nova:reg:set` | `novaOS.registry.set` | **`registry.write`** | path depth ≤ 16; name ≤ 64; value ≤ 256 KB | `{path, value, type?}` | `{success, path, type}` | `INVALID_ARGS` `value is required (null is only valid for REG_JSON)`; `PERMISSION_DENIED` (hive rules: own HKNA only, HKNS needs system app, HKNU needs `registry.system` or manifest `registryScopes.write` prefix, HKND needs Developer Mode, HKNS/security needs `registry.system`); per-key ACL `key ACL denies write: <reason>`; `INVALID_VALUE`; `QUOTA_EXCEEDED` |
| `nova:reg:delete` | `novaOS.registry.remove` | **`registry.write`** | none | `{path, recursive?}` | `{success, path, removed}` | `INVALID_ARGS` `path must name a value or key`; `SUBTREE_NOT_EMPTY` (keys without `recursive`) |
| `nova:reg:list` | `novaOS.registry.list` | **`registry.read`** | none | `{path}` | engine listing `{keys[], values{}}` (value paths list as leaves) | `NOT_FOUND` `no such key: <path>` |
| `nova:reg:export` | `novaOS.registry.export` | **`registry.read`** | none | `{path}` | `{path, data}` | engine codes |
| `nova:reg:import` | `novaOS.registry.import` | **`registry.write`** | none | `{path, data}` | `{success, path, merged}` | `INVALID_ARGS` `import needs a target key path`; engine codes |

Committed writes emit the `nova:reg:changed` event (`{path, type, value, appId, source}`) and registry audit entries (`{actor: appId, action, path, before, after}`). Registry channels are deliberately **not** isolated-process allowed.

### 5.20 Alarms (3 channels) — `system:schedule` — [isolated ok]

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:alarms:create` | `novaOS.alarms.create` | **`system:schedule`** | 32 alarms/app | `{name (1–64, `^[\w.:\-]+$`), when? \| periodMinutes?}` — exactly one; `when` = future epoch-ms ≤ 1 year out; `periodMinutes` ≥ 15 | `{success, replaced, alarm:{name, when, periodMinutes, scheduledTime}}` (same-name create replaces, no cap burn) | `INVALID_ARGS` (constraint messages quote the limits); `RATE_LIMITED` `Max 32 alarms per app` |
| `nova:alarms:clear` | `novaOS.alarms.clear` | **`system:schedule`** | none | `{name}` | `{success, cleared}` | `INVALID_ARGS` (name rules) |
| `nova:alarms:getAll` | `novaOS.alarms.getAll` | **`system:schedule`** | none | `{}` | `{success, alarms[]}` (own app only) | — |

Alarms fire into **live** sandboxes only (running window or Tier-2 keep-alive); while fully closed, periodic alarms skip to the next occurrence and missed one-shots queue (≤ 8, newest kept) for delivery right after the next `nova:ready` (`:7897-7902`). Timer delays clamped to 2^31−1 ms; persistence is registry-first (`HKNS/apps/alarms`) with localStorage fallback; alarms do **not** post notifications by themselves.

### 5.21 Secrets (4 channels) — `secrets:store` — [isolated ok]

AES-256-GCM per-app credential store (32-byte master key on disk, session-only fallback). Budgets module-enforced: **64 secrets/app, 8 KB/value, 128-char keys**.

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:secrets:set` | `novaOS.secrets.set` | **`secrets:store`** | 64/app | `{key, value}` | `{success}` (module result) | module `{code, message}` forwarded: `INVALID_ARGS` (key/value rules), `RATE_LIMITED` `Max 64…` (65th secret; replacement at cap allowed) |
| `nova:secrets:get` | `novaOS.secrets.get` | **`secrets:store`** | none | `{key}` | `{success, value}` (plaintext; tampered ciphertext → null, never garbage) | module codes; `INVALID_ARGS` |
| `nova:secrets:delete` | `novaOS.secrets.delete` | **`secrets:store`** | none | `{key}` | `{success}` | module codes |
| `nova:secrets:keys` | `novaOS.secrets.keys` | **`secrets:store`** | none | `{}` | `{success, keys[]}` (sorted, own app) | — |

### 5.22 Push (2 channels) — `push:receive`

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:push:register` | `novaOS.push.register` | **`push:receive`** | none | `{token?}` (reuse only if it matches `^nps_[0-9a-f]{32}$`) | `{success, token, endpoint:'/api/push/publish', queued, replaced, subscribed}` — the token + publish endpoint are handed to the app; delivery ladder re-checks the grant on every message (live push → Tier-1 wake → OS notification → data queue ≤ 8) | CSPRNG-unavailable failure (token generation fails closed) |
| `nova:push:unregister` | `novaOS.push.unregister` | **`push:receive`** | none | `{}` | `{success}` (drops token AND queue) | — |

Inbound budgets (enforced by the delivery ladder, not the register call): title ≤ 200, body ≤ 2000, data ≤ 4096 bytes, id ≤ 64, queue ≤ 8, reconnect backoff 1/2/5/15 s; OS-attributed notification rung shares the 10/min notification rate limit.

### 5.23 Badge (2 channels) — `system:badge` — [isolated ok for set]

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:badge:set` | `novaOS.badge.set` | **`system:badge`** | **30/min** `Max 30 badge updates per minute` | `{count?}` (finite number 0–999, floored; 0 = clear) or `{text}` (1–4 chars after trim) | `{success}` (session-only taskbar badge; `nova-badge-changed` + taskbar refresh) | `PERMISSION_DENIED`; `RATE_LIMITED` |
| `nova:badge:clear` | `novaOS.badge.clear` | **`system:badge`** | none | `{}` | `{success, cleared}` | `PERMISSION_DENIED` |

### 5.24 Devices (3 channels) — [isolated ok]

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:device:geolocation` | `novaOS.geolocation.getCurrentPosition` | **`device:geolocation`** | none | `{options?}` (PositionOptions passed through unvalidated) | `{success, coords:{latitude, longitude, altitude, accuracy, altitudeAccuracy, heading, speed}, timestamp}` (host-context `getCurrentPosition`) | `GEOLOCATION_ERROR`; `PERMISSION_DENIED` |
| `nova:device:camera` | `novaOS.media.checkCamera`, `getUserMedia` pre-check | **`device:camera`** | none | `{}` | `{success, authorized:true}` — **authorization-only**; the stream itself comes from in-document `getUserMedia` | `PERMISSION_DENIED` |
| `nova:device:microphone` | `novaOS.media.checkMicrophone`, `getUserMedia` pre-check | **`device:microphone`** | none | `{}` | `{success, authorized:true}` | `PERMISSION_DENIED` |

Browser-level `permissionrequest` gate: `media` allowed iff camera **OR** microphone granted (ANY-of); `geolocation` iff `device:geolocation`; `fullscreen`/`pointerLock` always denied; everything else default-deny (`:9886-9951`).

### 5.25 Calendar & contacts (6 channels) — shared OS stores

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:calendar:read` **[isolated ok]** | `nova.calendar.list`, `novaOS.calendar.list` | **`calendar:read`** | none | `{}` | `{success, events[]}` — **all** events in the shared store (no per-app scoping) | `PERMISSION_DENIED` |
| `nova:calendar:write` **[isolated ok]** | `nova.calendar.save`, `novaOS.calendar.save` | **`calendar:write`** | none | `{event}` (`title` non-empty, `date` `YYYY-MM-DD`, color ∈ 8 frozen values, id defaults to random) | `{success, event}` (emits `calendar:updated`) | `INVALID_EVENT` `Event must have a title and a YYYY-MM-DD date` |
| `nova:calendar:delete` **[isolated ok]** | `nova.calendar.remove`, `novaOS.calendar.remove` | **`calendar:delete`** | none | `{id}` | `{success, removed}` | `INVALID_ID` `id must be a non-empty string` |
| `nova:contacts:read` **[isolated ok]** | `nova.contacts.list`, `novaOS.contacts.list` | **`contacts:read`** | none | `{}` | `{success, contacts[]}` — all contacts | `PERMISSION_DENIED` |
| `nova:contacts:write` **[isolated ok]** | `nova.contacts.save`, `novaOS.contacts.save` | **`contacts:write`** | none | `{contact}` (id/name/email/phone/notes strings; ≥ trimmed name) | `{success, contact}` (emits `contacts:updated`) | `INVALID_CONTACT` `Contact must have at least a name` |
| `nova:contacts:delete` **[isolated ok]** | `nova.contacts.remove`, `novaOS.contacts.remove` | **`contacts:delete`** | none | `{id}` | `{success, removed}` | `INVALID_ID` |

### 5.26 System info & locale (2 channels) — [isolated ok]

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:system:info` | — (raw only) | **`system:info`** | none | `{}` | `{success, os:{version, securityPatch, username, uptime}}` — note `username` is exposed to any app holding `system:info` (stricter than `nova:ready`) | `PERMISSION_DENIED` |
| `nova:locale:get` | `novaOS.locale.get` | ungated (advisory row: coarse formatting facts only) | none | `{}` | `{success, locale, region, timeZone, firstDayOfWeek}` | — |

### 5.27 Mail (5 channels) — [isolated ok]

Proxied to the local server `/api/email/*` with the app identity attached; shared error: 401 → `UNAVAILABLE` `No email account connected — open the Email app and connect an account first`.

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:mail:session` | `nova.mail.connect/disconnect/restore`, v2 twins | **`mail:write`** | none | `{action: connect\|disconnect\|restore, account?}` — connect needs `{type, host, user, pass}`; `ssl` forced true | server response | `INVALID_ARGS` (unknown action, missing fields, `Plaintext connections are not supported`); `UNAVAILABLE` |
| `nova:mail:read` | `nova.mail.account/folders/messages/message/search`, v2 twins | **`mail:read`** | none | `{action: account\|folders\|messages\|message\|search, uid?, query?, folder?, page?, limit?}` (folder default INBOX) | action-shaped response | `INVALID_ARGS` (`uid is required for action "message"`, `query is required…`); `UNAVAILABLE` |
| `nova:mail:write` | `nova.mail.preview/markRead/move`, v2 twins | **`mail:write`** | none | `{action: preview\|batch, html? \| (op: read\|move, uids[], dest?, folder?)}` — delete op impossible via this channel | action response | `INVALID_ARGS` (`uids array is required`, `dest is required for op "move"`) |
| `nova:mail:send` | `nova.mail.send`, `novaOS.mail.send` | **`mail:send`** | none | `{to, cc?, bcc?, subject?, text?, html?, smtpHost (required), smtpPort?}` | send result | `INVALID_ARGS` (`smtpHost is required — the server has no way to infer it from the connected IMAP/POP3/EWS account (they are frequently different hosts)`) |
| `nova:mail:delete` | `nova.mail.remove`, v2 twin | **`mail:delete`** | none | `{uids[], folder?}` (POST batch `op:'delete'`, folder INBOX) | `{success, deleted: uids.length}` | `INVALID_ARGS` `uids array is required` |

### 5.28 Admin (4 channels) — dual gate: permission AND machine admin mode

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:admin:audit` | `nova.admin.auditQuery`, v2 twin | **`admin:audit`** | none | `{userId?, action?, resource?, ipAddress?, success?, startDate?, endDate?, level?, limit?, offset?}` (server `GET /api/security/audit`) | `{success, logs, pagination, statistics}` | `PERMISSION_DENIED` `This machine is not in admin mode — enable it in Settings first` (server 403); `UNAVAILABLE` |
| `nova:admin:system` | `nova.admin.systemGet/systemSet`, v2 twins | **`admin:system`** | none | `{action:'get'}` \| `{action:'set', settings}` | `{success, settings}` / `{success, updated}` | `INVALID_ARGS` `settings object is required for action "set"` |
| `nova:admin:users` | `nova.admin.usersList/usersRevoke`, v2 twins | **`admin:users`** (+ admin-role session) | none | `{action:'list'\|'revoke', sessionId?}` (18 account verbs exist host-side; apps get list/revoke) | account list / revoke result | `PERMISSION_DENIED` `An administrator account is required for account management`; `INVALID_ARGS` `sessionId is required for action "revoke"`; `UNAVAILABLE` `No active session` |
| `nova:admin:apps` | `nova.admin.appsList`, v2 twin | **`admin:apps`** | none | `{}` | per-app `{id, name, version, source, builtin, declaredPermissions, declaredOptionalPermissions, declaredVia, grantedPermissions}` | admin-mode inferred client-side (no server 403 on this one) |

### 5.29 Nested webview (1 channel)

| Channel | Facade | Permission (MAC) | Rate limit | Payload | Response | Errors |
|---|---|---|---|---|---|---|
| `nova:nested-webview` | `nova.browser.createView`, `<nova-nested-webview>` element methods, `NovaBrowserView` methods | **`sandbox:nested-webview`** (+ manifest opt-in) | none | `{action: create\|bounds\|command\|queryCommand\|destroy\|…, id, attributes\|bounds\|command\|args}` | service passthrough (action-specific) | `PERMISSION_DENIED` `sandbox:nested-webview permission required`; `UNAVAILABLE` `NovaByte System Webview service is unavailable`. Navigation sub-gate: destination must classify valid, carry no embedded credentials, and match `net:internal`/`net:external` grants |

### 5.30 Host-only channels — not callable by apps

These 40 channels appear in devtools/source but are in `GUEST_FORBIDDEN_IPC_APIS` (`:9317-9336`): a sandboxed guest calling any of them gets `PERMISSION_DENIED` / `This system capability is only available through trusted OS UI` before any handler side effect (`:9577-9579`), and they have **no** `API_HANDLERS` entry. They exist for trusted first-party code (Settings, Clock) calling at host tier. Never build against them; do not confuse them with their app-facing counterparts (e.g. `nova:system:permissions:set` ≠ `nova:request-permission`).

- **System (17):** `nova:system:permissions:list`, `nova:system:permissions:set`, `nova:system:permissions:reset`, `nova:system:data:backup`, `nova:system:data:restore`, `nova:system:dialog`, `nova:system:developer-mode:confirm`, `nova:system:boot-recovery`, `nova:system:data:clear`, `nova:system:default-apps:get`, `nova:system:default-apps:choose`, `nova:system:default-apps:set`, `nova:system:storage:estimate`, `nova:system:admin-mode:get`, `nova:system:admin-mode:set`, `nova:system:preferences:get`, `nova:system:preferences:set`
- **Clock (14):** `nova:clock:state:get`, `nova:clock:state:persist`, `nova:clock:alarms:get`, `nova:clock:alarms:set`, `nova:clock:alarm:dialog`, `nova:clock:timer:set-preset`, `nova:clock:timer:start`, `nova:clock:timer:pause`, `nova:clock:timer:restart`, `nova:clock:timer:reset`, `nova:clock:stopwatch:start`, `nova:clock:stopwatch:pause`, `nova:clock:stopwatch:reset`, `nova:clock:stopwatch:lap`
- **Auth (9):** `nova:auth:login`, `nova:auth:logout`, `nova:auth:lock`, `nova:auth:unlock`, `nova:auth:reverify`, `nova:auth:switch`, `nova:auth:suspend`, `nova:auth:resume`, `nova:auth:setup` — "no app may drive login/logout/switch/reverify" (`:9330-9332`)

What they do (so you can recognize them in devtools, and understand why they are host-only — all would be system-wide state changes with no per-app scoping):

| Channel | Host-tier semantics |
|---|---|
| `nova:system:permissions:list` | all apps + their runtime grants |
| `nova:system:permissions:set` | grant/revoke **any permission for any app** |
| `nova:system:permissions:reset` | reset an app's grants |
| `nova:system:data:backup` / `:restore` | dump/restore **entire host localStorage + settings cache** |
| `nova:system:dialog` | host modal with app-controlled title/message/buttons |
| `nova:system:developer-mode:confirm` | Developer Mode enable flow (warning + confirm) |
| `nova:system:boot-recovery` | set manual-recovery boot flag and reload the host |
| `nova:system:data:clear` | cache or full data wipe (admin-gated account wipe, partition + IDB resets, reload) |
| `nova:system:default-apps:get` / `:choose` / `:set` | default-app category map / modal picker / set default |
| `nova:system:storage:estimate` | host disk usage (`fs.statfsSync`, Win32 PowerShell fallback, webview fallback) |
| `nova:system:admin-mode:get` / `:set` | machine admin flag read/flip |
| `nova:system:preferences:get` / `:set` | raw settings cache dump / write (`devMode`, `rootAccessEnabled` denylisted) |
| `nova:clock:*` (14) | Clock app state, alarms, timer, stopwatch (backed by the `__NBOSP_BG` clock service) |
| `nova:auth:*` (9) | session login/logout/lock/unlock/reverify/switch/suspend/resume/setup |

### 5.31 Isolated-process allowlist (Tier-2 workers)

`ISOLATED_PROCESS_API_TYPES` (`:9465-9490`) is the set of channels dispatchable without a webview (worker/background execution). Everything not listed returns `UNAVAILABLE` / `This API is not available to isolated processes`. Allowed:

`nova:ready`, `nova:app:info`, all `nova:fs:*` data ops + `nova:fs:watch`/`unwatch`, `nova:media:query`, `nova:alarms:*` (3), `nova:secrets:*` (4), `nova:storage:*` (6), `nova:data:*` (4), `nova:settings:get`/`set`, `nova:appearance:get`/`set`, `nova:notifications:*` (7), `nova:request-permission`, `nova:clipboard:read`/`write`, `nova:net:fetch`, `nova:mail:*` (5), `nova:calendar:*` (3), `nova:contacts:*` (3), `nova:locale:get`, `nova:badge:set`/`clear`.

**Excluded by design** (webview-bound): `nova:net:websocket` + `ws:send/close`, all `nova:ipc:*`, `nova:app:launch/list/install/uninstall`, `nova:events:*`, the dialog families (`dialog`/`sysdialog`/`files`), `nova:share`, `nova:push:*`, `nova:background:*`, `nova:system:info`, `nova:device:*`, `nova:download`, `nova:open-url`, `nova:wallpaper:set`, `nova:reg:*` (registry deliberately kept out), `nova:window:*`, overlay/context-menu, `nova:nested-webview`, `nova:email:open-link`, `nova:home:*`.

---

## 6. Pushed events (host → app)

Pushes arrive on the same bridge as responses but with a **fresh requestId that is never in the pending map** — the shim dispatches them to dedicated listener registries by type (`:11253-11256`). Registration is always via a callback API (the "dispatch mechanism" column); none of these can be requested through `nova.ipc()`.

Delivery pipeline: host `respond(webview, type, requestId, result)` → isolated-world `__novaInbox` → MessagePort (`kind:'response'` added) → main-world `handleInboxMessage` (`:11155`) dispatch. Listener exceptions are swallowed (`catch (_) {}` on the events bus fan-out; `console.error` on fs-watch/alarm/share/push) — never let a throwing listener assume it broke anything but itself.

**Pushed events:** the shim's `handleInboxMessage` has 13 dedicated pushed-event branches (the WebSocket branch family covers 3 type strings) plus the ready special case — **14 distinct pushed type strings** in total, enumerated below.

| # | Pushed type (guest sees `…:response`) | Payload (`msg.result`) | Dispatch mechanism (registration) | When it fires |
|---|---|---|---|---|
| 1 | `nova:ready:response` | launch payload `{appId, permissions, optionalPermissions, osVersion, securityPatch, username?}` | special case (`:11368-11387`) — sets `window.__novaPermResponse`; no callback registration | automatic handshake at load (`:11879`); repeat `nova:ready` calls resolve normally |
| 2 | `nova:appearance:changed:event` | appearance record (5 public keys only) | `nova.appearance.onChange(cb)` | any appearance setting change (`:8696`) |
| 3 | `nova:nested-webview:event` | `{proxyId, eventName, …}` (+`popupId` for `newwindow`, `request` for `permissionrequest` — whose `allow`/`deny` are **no-ops**, decisions are host-side, `:11181-11188`) | synthesized `Event` on the `<nova-nested-webview>` proxy element; `NovaBrowserView.on(type, listener)` | nested view lifecycle: navigation, close, crash, new-window, download-request, contextmenu, annotation-export, url/title/state changes |
| 4 | `nova:ipc:request` | `{endpoint, sourceAppId, data}` (+ `msg.requestId` = callId) | `nova.ipc.provide(endpoint, handler)` — handler return value is sent back via `nova:ipc:reply {callId, result\|error}`; unregistered endpoint replies `IPC endpoint is no longer registered` | another app invokes your exported endpoint (`:6241`) |
| 5 | `nova:ipc:broadcast` | `{action, sourceAppId, data}` | `nova.ipc.onBroadcast(action, cb)` (action must be declared in `manifest.ipc.receives`) | another app broadcasts a declared action (`:6331`) |
| 6 | `nova:events:event` | `{event, data}` | `nova.onEvent(name, cb)` and `novaOS.events.on(name, cb)` (both fan out; one host subscription per sandbox) | an allowlisted OS event fires (see §6.2) |
| 7 | `nova:overlay:event` | overlay event `{type:'click'\|…, action?, field?, value?, key?}` | `nova.overlay.onEvent(cb)` | user interacts with `[data-nova-action]`/`[data-nova-field]` in your host overlay (`:3545`) |
| 8 | `nova:net:ws:message` | `{wsId, data}` | handle `onMessage(cb)` (v1 + v2 registries) | inbound frame on your socket (`:6549`) |
| 9 | `nova:net:ws:error` | `{wsId, …}` | handle `onError(cb)` | socket error |
| 10 | `nova:net:ws:close` | `{wsId, code, reason, clean}` | handle `onClose(cb)` (both registries deleted on close) | socket closed. Apps using raw `nova.ipc` + events instead receive the mirrored OS-bus events `nova:net:ws:message/error/close` (own sockets only, filtered by appId) |
| 11 | `nova:background:wake` | `{wokeAt (ISO), deadlineMs}` | `nova.onBackgroundWake(cb)` (v1, no off()) / `novaOS.background.onWake(cb)` (v2, off()) | Tier-1 scheduler wake cycle for this sandbox (`:14517-14522`); can race page load — no re-delivery |
| 12 | `nova:fs:changed` | `{watcherId, path, kind: created\|changed\|deleted, timestamp}` | `novaOS.fs.watch(path, cb)` (registry keyed by watcherId) | watcher poll (2000 ms, 300 ms debounce) detects a change; **60 pushes/min, over-budget events silently dropped** |
| 13 | `nova:background:alarm` | `{name, alarm:{name, when, periodMinutes, scheduledTime}, firedAt, queued?}` | `novaOS.alarms.onAlarm(cb)` | alarm fires in a live sandbox (`:7979`); queued one-shots delivered right after the next `nova:ready` with `queued:true` (`:8753`) |
| 14 | `nova:share:inbound` | `{title, text, url, sourceAppId, firedAt, queued?}` | `novaOS.share.onInbound(cb)` | another app's share sheet delivered to you (live `:7883`, or queued flush `:7862`); requires `system:share-target` |
| 15 | `nova:push:message` | `{appId, id, title?, body?, data?, sentAt, queued?}` | `novaOS.push.onMessage(cb)` | push message via the delivery ladder (live `:8362`, queued `:8411`); OS-attributed notification rung may already have shown a notification |

(Rows 8–10 are the three WebSocket type strings; together with rows 1–7 and 11–15 that is 13 dispatch branches / 14 pushed type strings + the ready special case, `:11253-11345`.)

**Registration / teardown semantics per registrar** (all verified in the facade source):

| Registrar | Duplicate callback | `off()` behavior |
|---|---|---|
| `novaOS.alarms.onAlarm(cb)` | allowed (stacks) | removes the callback only; no host call |
| `novaOS.push.onMessage(cb)` | allowed (stacks) | removes the callback only |
| `novaOS.share.onInbound(cb)` | allowed (stacks) | removes the callback only |
| `novaOS.background.onWake(cb)` | allowed (stacks) | removes the callback only |
| `novaOS.events.on(name, cb)` | allowed (stacks per name) | last listener for the name **and** no v1 listener → `nova:events:unsubscribe`; a refused host subscribe rolls back the local listener |
| `novaOS.fs.watch(path, cb)` | one callback per handle | `handle.unwatch()` → `nova:fs:unwatch` |
| `novaOS.registry.watch(path, cb)` | allowed (stacks) | last listener → events unsubscribe |
| `novaOS.net.websocket` handle `onMessage/onError/onClose` | allowed (stacks per wsId+kind) | none (entries die with the socket); callbacks validated — throw TypeError |
| `nova.ipc.onBroadcast(action, cb)` | allowed (Set per action) | last listener → `nova:ipc:broadcast:unsubscribe` |
| `nova.onBackgroundWake(cb)` (v1) | allowed | **none — no off(), no validation** |
| `nova.onEvent(name, cb)` (v1) | allowed (stacks per name) | **none — use novaOS.events.on for teardown** |
| `nova.appearance.onChange(cb)` | rejects TypeError (`callback is already subscribed`) | last listener → `nova:appearance:unsubscribe` |
| `nova.overlay.onEvent(cb)` | allowed | local removal only (no host call) |
| `nova.app.onLaunch` / `onStateChange` (v1) | allowed | local removal only |

### 6.2 Subscribable OS-bus events (`nova:events:subscribe` allowlist)

17 names (`ALLOWED_EVENT_NAMES`, `:6021-6065`). Sensitive names require `system:events`; domain names additionally require the listed permission (**ALL-of** `system:events` + domain grant, `:6080-6095`):

| Event | Extra gate beyond `system:events` | Notes |
|---|---|---|
| `system:notification`, `system:volumeChanged`, `system:themeChanged`, `system:workspaceChanged`, `system:power`, `system:network` | none | benign device/shell state |
| `app:installed`, `app:uninstalled`, `app:launched` | none (sensitive: `system:events`) | app inventory |
| `mail:new`, `mail:updated` | `mail:read` | **pre-declared, no emitter yet** — subscribing today is a no-op (`:6025-6037`) |
| `calendar:reminder`, `calendar:updated` | `calendar:read` | `calendar:updated` fires on every calendar write |
| `contacts:updated` | `contacts:read` | fires on every contacts write |
| `nova:net:ws:message`, `nova:net:ws:error`, `nova:net:ws:close` | `net:websocket` | raw-socket mirror; subscribers only ever hear **their own** sockets (`data?.appId !== app.id` drop, `:6366`) |
| `nova:reg:changed` | `registry.read` | registry write notifications `{path, type, value, appId, source}` |

There is **no app-to-app publish** on this bus — cross-app messaging is `nova.ipc.broadcast` only (`:10784-10786`). Notification **action clicks are never pushed**; drain them with `consumeActions()`.

---

## 7. Rate limits & quotas — consolidated

All rate limits are per-app sliding 60 s windows unless noted. Ledger budgets (`storageQuotaBytes`, `ipcPayloadBytes`, `httpBodyBytes`, `requestTimeoutMs`) are admin-adjustable per app within the clamp range; defaults shown.

### 7.1 Storage & data

| Area | Limit | Value | Notes / source |
|---|---|---|---|
| App storage quota | per (owner, app) | **256 MB** (clamp 1 MB – 2 GB) | ledger `storageQuotaBytes`; `STORAGE_FULL` `Storage quota exceeded` (`:264`, `:6738-6776`) |
| Per-user ceiling | hard-coded | **2 GB** | `Account storage quota exceeded`, also `STORAGE_FULL` (`:6778-6781`) |
| Per-value cap | `nova:storage:set`, data restore/import | **5 MB** (5 242 880 bytes) | `Value exceeds 5242880 byte limit`; per-key failures in data restore reported via `failedKeys` (`:210`, `:6917-6918`) |
| Storage key format | `nova:storage:*` | `/^[\w\-. ]+$/` (no length cap) | slashes/colons rejected (`:207-209`) |
| Data export selector | `nova:data:export` | `keys` ≤ **1000** entries (or one `prefix`) | `keys is limited to 1000 entries per export` (`:7145-7146`) |
| Secrets | per app / value / key | **64 secrets**, **8 KB** per value (UTF-8), **128-char** keys | module-enforced; 65th → `RATE_LIMITED` `Max 64…`; replacement at cap allowed (app-secrets.js budgets; tests pin `app-secrets.test.js:44-46`) |

### 7.2 IPC & networking

| Area | Limit | Value | Notes |
|---|---|---|---|
| IPC payload | app-ipc invoke/broadcast/reply data | **256 KB** (clamp 1 KB – 8 MB; legacy 64 KB) | `PAYLOAD_TOO_LARGE` `IPC payload exceeds the N KB limit` (`:265`, `:6120-6131`) |
| App-IPC rate | per `(appId:type)` | **20/min** (invoke and broadcast tracked separately) | `Max 20 app IPC calls per minute` / `Max 20 app broadcasts per minute` (`:6133-6144`) |
| App-IPC invoke timeout | host-side | **25 s** | `REMOTE_ERROR` `Target app did not respond before the IPC timeout` (`:6100`) |
| IPC reply error strings | truncation | **500 chars** | `:6280` |
| HTTP request body | `nova:net:fetch` | **16 MiB** (clamp 64 KB – 64 MiB) | base64 bodies decoded then measured; `PAYLOAD_TOO_LARGE` (`:266`, `:6438-6441`) |
| XHR body cap | shim `__NOVA_MAX_BODY_BYTES__` | ledger `httpBodyBytes` (16 MiB default; **6 MiB fallback** when no budget baked) | `RangeError('XHR request body exceeds the N MiB limit')` — never truncation (`:10246-10254`, `:12006-12057`) |
| HTTP response body | — | **no cap** (either branch), no byte accounting | documented gap — see [`internals.md`](internals.md) (`:6452-6506`) |
| Request timeout | shim `REQUEST_TIMEOUT_MS` | ledger `requestTimeoutMs` **60 s** default (clamp 5 s – 10 min; 30 s fallback) | `:11024`, `:267` |
| Interactive timeout | 11 human-dialog channels | **10 min** | `:11040-11053` |
| WebSocket sockets/frames | per app | **no caps** (tracked for teardown only) | `:6543-6546`, `:6575-6603` |
| Isolated-process dispatch | Tier-2 workers | **30 s** | `TIMEOUT` `The OS API request timed out` (`:9657`) |

### 7.3 Notifications

| Area | Limit | Value |
|---|---|---|
| New posts | per app | **10/min** (`Max 10 notifications per minute` / `Max 10 notification posts per minute`) |
| Tagged updates | per app | **60/min** (`Max 60 notification updates per minute`) — split so progress bars don't trip the spam limit |
| Channels | per app | **32** (`Max 32 channels per app`); channel id ≤ 64 (`^[a-zA-Z0-9_-]+$`), name ≤ 60; importance locked at creation |
| Title / body / actionLabel | per notification | **120 / 500 / 40** chars |
| Actions | per notification | **3** (id slug ≤ 40, label ≤ 40); function-typed actions dropped |
| Progress | per notification | value 0..max, max clamped 1..**100000** |
| Tag | per notification | ≤ 64 |
| Pending action clicks | per app | **20** |
| Stored / rendered | global | **100 stored / 50 rendered** |
| Icons | allowlist | 22 ids (§5.17) |
| Toast dwell | by importance | low = silent panel-only, default = 4 s, high = 8 s; actions force ≥ 8 s |

### 7.4 UI surfaces

| Area | Limit | Value |
|---|---|---|
| Taskbar badge | per app | **30/min** (`Max 30 badge updates per minute`); count **0–999** (0 = clear), text **1–4 chars** |
| Share sheets | per app | **5/min** (`Max 5 share sheets per minute`); text ≤ **4000** chars, title ≤ 120 |
| Share targets in sheet | per sheet | **6** (`SHARE_TARGET_SHEET_MAX`); inbound queue **8** (`SHARE_TARGET_QUEUE_MAX`) |
| Context menu | per call | **1–100** items; label ≤ 120, icon ≤ 64, shortcut ≤ 32 |
| Overlay | per call | html ≤ **100 000** chars, css ≤ **50 000**; render timeout **15 s**; event fields: action/field ≤ 100, value ≤ 4096, key ≤ 64 |
| Window title | per call | **200 chars** (sliced) |
| Window resize | per call | integers, minimum **100**, fallback **800×600** |
| Appearance updates | per app | **10/min** (`Max 10 appearance updates per minute`); 6 writable fields; 7 themes; accentColor `#rrggbb` or null |

### 7.5 Launches & prompts

| Area | Limit | Value |
|---|---|---|
| Cross-app launches | per app | **30/min** (`Max 30 cross-app launches per minute`) — asserted exactly: 30 successes, #31 `RATE_LIMITED` (app-sandbox.test.js:2471-2473) |
| Home launches | per app | **30/min** (`Max 30 Home app launches per minute`) |
| Default-apps deep links | per app | **12/min** (`Max 12 per minute`) — both `nova:app:openDefaultAppsSettings` and `nova:home:openDefaultAppsSettings` |
| Permission prompts | per app+permission | **3 per 60 s** burst; cooldown **5 s base → 15 min cap** (denial streak capped at 20); excess requests auto-denied without a dialog; already-granted calls are never rate-limited; `retryAfterMs` example 30000 (app-permission-manager.js:273-278; tests pin behavior) |

### 7.6 Filesystem & pickers

| Area | Limit | Value |
|---|---|---|
| fs watchers | per app | **8** (`Max 8 watchers per app`); poll **2000 ms**, debounce **300 ms**, push budget **60/min** (rate-limited events dropped, snapshot still advances); watcherId `^w_[a-z0-9_]{4,64}$` |
| Picker multi-select | per dialog | **25 files** (`PICKER_MULTI_MAX_FILES`, `LIMIT_REACHED`) |
| Picked file read/write | per file | **10 MB** (`Selected files are limited to 10 MB` / `content must be a string up to 10 MB`; `FILE_TOO_LARGE`) |
| Picker `accept` | per dialog | array ≤ **20** entries × **64** chars (MIME or `.ext`), or one string ≤ **512** chars (unvalidated pass-through) |
| sysdialog fields | per call | title ≤ 100, `suggestedName` ≤ 255, `startPath` ≤ 4096 |
| Download | per call | **no byte cap** (the native save dialog is the control); dialog cap **5 min** |

### 7.7 Alarms, push, events

| Area | Limit | Value |
|---|---|---|
| Alarms | per app | **32** (`Max 32 alarms per app`); `periodMinutes` ≥ **15**; `when` ≤ **1 year** ahead; name 1–**64** chars `^[\w.:\-]+$`; missed one-shot queue **8** (newest kept); timer delay clamp 2^31−1 ms |
| Push messages | inbound | title ≤ **200**, body ≤ **2000**, data ≤ **4096 bytes**, id ≤ **64**, queue **8**, reconnect backoff 1/2/5/15 s |
| Push token | format | `nps_` + 16 CSPRNG bytes hex (`^nps_[0-9a-f]{32}$`); generation fails closed without CSPRNG |
| Event subscriptions | per sandbox | **1 per event name** (`ALREADY_SUBSCRIBED` on doubles); 17-name allowlist |
| fs:watch events | per app | 60/min (see §7.6) |

### 7.8 Registry quotas

| Area | Limit | Value |
|---|---|---|
| Path depth | per path | **16** (`MAX_DEPTH`) — deeper → `INVALID_ARGS` |
| Name length | per segment | **64** (`MAX_NAME_LENGTH`) |
| Value size | per value | **256 KB** (`MAX_VALUE_BYTES`) — `QUOTA_EXCEEDED` |
| Audit ring | per engine | **500** entries (`MAX_AUDIT_ENTRIES`) |
| Snapshots | per hive | **3** (`MAX_SNAPSHOTS_PER_HIVE`) |

### 7.9 Background & scheduler

| Area | Limit | Value |
|---|---|---|
| Tier-1 wake sweep | global | every **15 min** (`WAKE_INTERVAL_MS`), no jitter |
| Tier-1 wake deadline | per wake | **10 s** (`WAKE_DEADLINE_MS`), then teardown (early finish via `wakeDone()`) |
| Tier-2 stay-alive | per session | unbounded for OS-page lifetime (pinned Terminate notification is the kill switch); `stayAlive` opt-in is session-only |
| Sandbox serving | per sandbox | heartbeat **5 min**; server prunes serve entries idle **30 min** |

### 7.10 Host-side bookkeeping (visible indirectly)

| Area | Limit | Value |
|---|---|---|
| MAC audit writes | per app | **60/min** (denial *decisions* are never rate-limited — "a denied call is always denied"); audit ring **300** |
| Storage ledger access log | per app | **500** entries, detail sliced to 300 chars, persist debounce 400 ms |
| Root audit | global | **1000** entries, debounce 250 ms |
| EventLog ring | global | **500** entries (any app can fill it via console output) |
| Downloads history | global | **500** entries |
| Clipboard history | global | **30** entries |
| Serial console mirror | per app | **40 lines / 5 s**, lines truncated to 2000 chars |
| Annotation export | per call | **2 000 000** chars |
| App list icons | per entry | data-URI ≤ **700 000** chars |
| HTTP rate limiter (server) | route exclusion | `/api/apps/serve/*` (register/heartbeat/unregister/content) excluded from the per-IP limiter; other `/api/*` limited |

> **Unverified / not in code:** no per-app limit was found for `nova:app:list`, `nova:net:websocket` socket count, `nova:net:ws:send` frames, `nova:net:fetch` call frequency, `nova:clipboard` call frequency, or `nova:events:unsubscribe`. Treat them as unbounded (subject to the generic IPC timeout and server-side limits).

---

## 8. Error codes

Every error string the sandbox can emit, with where it comes from. Common to all channels: `PERMISSION_DENIED` (MAC/host-only/handler gates), `UNKNOWN_API`, `INTERNAL_ERROR`, `TRANSPORT_ERROR`, and the shim's TypeError timeout.

### 8.1 Dispatch & transport

| Code | Thrown by | Trigger |
|---|---|---|
| `UNKNOWN_API` | dispatch (`:9580-9583`) | channel not in `API_HANDLERS` |
| `PERMISSION_DENIED` | dispatch (`:9577-9579`) | channel in `GUEST_FORBIDDEN_IPC_APIS` — `This system capability is only available through trusted OS UI` |
| `PERMISSION_DENIED` | MAC front door (`:9584-9596`) | grant row unmet — `Blocked by system security policy (MAC): requires …` / `… no policy rule for this endpoint` |
| `INTERNAL_ERROR` | dispatch (`:9608-9612`) | handler threw / async rejection; raw message |
| `TRANSPORT_ERROR` | isolated transport (`:10134-10135`) | console channel broken |
| `TIMEOUT` | isolated-process dispatcher (`:9648-9657`) | 30 s — `The OS API request timed out` |
| `TIMEOUT` | `nova:download` (`:3854-3856`) | save dialog not answered in 5 min — `Save dialog timed out` |
| `UNAVAILABLE` | isolated-process gate (`:9627-9634`) | `This API is not available to isolated processes` |
| `APP_UNAVAILABLE` | isolated-process gate (`:9636-9644`) | app missing/revoked/tampered |

### 8.2 Validation & arguments

| Code | Thrown by | Trigger (representative message) |
|---|---|---|
| `INVALID_ARGS` | ~30 handlers | bad/missing fields — see §5 rows |
| `INVALID_VALUE` | registry engine | value doesn't fit declared type |
| `INVALID_OPERATION` | `nova:fs:list`, `nova:fs:write` | `Path is not a folder` / `Cannot write to a folder` |
| `INVALID_STATE` | `nova:net:ws:send`; registry batches | socket not OPEN (`WebSocket is not open`); nested batch |
| `INVALID_ID` | calendar/contacts delete | `id must be a non-empty string` |
| `INVALID_EVENT` | `nova:calendar:write` | `Event must have a title and a YYYY-MM-DD date` |
| `INVALID_CONTACT` | `nova:contacts:write` | `Contact must have at least a name` |
| `UNSUPPORTED_TYPE` | `nova:files:open` | `Selected file is not available as text` |

### 8.3 Filesystem & files

| Code | Thrown by | Trigger |
|---|---|---|
| `NOT_FOUND` | fs family, ws:send, app launch/uninstall, reg:list, open-with, ipc invoke/reply | target missing (file, folder, socket, app, key, endpoint, pending call) |
| `PROTECTED_LOCATION` | `nova:fs:delete` | `System filesystem roots cannot be deleted` |
| `FILE_TOO_LARGE` | `nova:files:open` | picked file > 10 MB |
| `PICKER_ERROR` | `nova:files:open/save` | picker failure |
| `WRITE_ERROR` | `nova:sysdialog:save`, `nova:dialog:save` | write failure (`Failed to write file`) |
| `IO_ERROR` | `nova:download` | disk write / dialog failure |
| `LIMIT_REACHED` | `nova:sysdialog:open`, `nova:notifications:createChannel` | > 25 picked files / > 32 channels |
| `SANITIZE_FAILED` | `nova:overlay:show` | DOMPurify rejected the overlay |
| `RENDER_FAILED` | `nova:overlay:show` | render timeout (15 s) or load failure |
| `CANCELLED` | `nova:overlay:show`, context menu (as `{cancelled:true}` result) | `Overlay was closed before rendering completed` / user dismissed |

### 8.4 Storage & quotas

| Code | Thrown by | Trigger |
|---|---|---|
| `STORAGE_FULL` | `nova:storage:set` | value > 5 MB; app quota (256 MB); user ceiling (2 GB); **also masks generic write failures** |
| `QUOTA_EXCEEDED` | registry engine | value > 256 KB |
| `PAYLOAD_TOO_LARGE` | app-ipc clamp; `nova:net:fetch` | payload > 256 KB; base64 body > 16 MiB |

### 8.5 Apps & packages

| Code | Thrown by | Trigger |
|---|---|---|
| `INVALID_PACKAGE` | `nova:app:install` | manifest missing id/name/version |
| `MALICIOUS_PACKAGE` | `nova:app:install` | malware scanner verdict unsafe |
| `SCAN_FAILED` | `nova:app:install` | scanner threw (fail closed) |
| `UNVERIFIED` | `nova:app:install` | `Package has no integrity record — install manually via App Manager` |
| `TAMPERED` | `nova:app:install` | integrity verification failed |
| `UNTRUSTED` | `nova:app:install` | signer not in trust store / revoked |
| `ALREADY_INSTALLED` | `nova:app:install` | existing install |
| `NOT_UNINSTALLABLE` | `nova:app:uninstall` | built-in / system-signed app |
| `UNINSTALL_FAILED` | `nova:app:uninstall` | registry uninstall failed |
| `ERROR` | `nova:app:install`, storage, misc | generic handler failure |

### 8.6 Policy, rate & state

| Code | Thrown by | Trigger |
|---|---|---|
| `RATE_LIMITED` | launches, app-ipc, notifications, badge, appearance, share, alarms, secrets, fs:watch | see §7 for every budget and message |
| `POLICY_BLOCKED` | wallpaper/appearance settings, data restore | `Wallpaper changes are disabled by system policy`; `Appearance setting 'X' is blocked by system policy`; foreign data envelope |
| `ALREADY_SUBSCRIBED` | events/appearance subscribe | second subscription for the same name in one sandbox |
| `ALREADY_REGISTERED` | `nova:ipc:register` | endpoint already registered in this sandbox |
| `REMOTE_ERROR` | `nova:ipc:invoke` | provider replied with an error (string truncated 500 chars) |
| `NETWORK_ERROR` | `nova:net:fetch` | external proxy failure |
| `GEOLOCATION_ERROR` | `nova:device:geolocation` | position fix failed |
| `CLIPBOARD_UNAVAILABLE` | `nova:clipboard:write` | `Could not write to the system clipboard: <err>` |
| `SHARE_FAILED` | `nova:share` | chosen share action threw |

### 8.7 Registry engine codes (pass through `nova:reg:*`)

| Code | Trigger |
|---|---|
| `SUBTREE_NOT_EMPTY` | key delete without `recursive:true` |
| `INVALID_LINK`, `LINK_LOOP`, `LINK_CROSS_HIVE` | REG_LINK misuse (self-links, loops, cross-hive write-through) |
| `NAME_CONFLICT` | rename onto an existing name |
| `INVALID_STATE` | nested batch transactions |

### 8.8 Server-side codes (surfaced only through proxied/admin channels)

Seen on `/api/auth/*` and admin APIs; apps normally only see them wrapped as `UNAVAILABLE`/`PERMISSION_DENIED` by the proxying handler: `AUTH_REQUIRED` (401), `ADMIN_REQUIRED` (403), `OWNER_PROTECTED`, `ALREADY_SET_UP` (409), `ALREADY_MIGRATED` (409), `BAD_CREDENTIAL` (200 + body). Push publish HTTP codes: 202 `device-offline`, 404 `unknown-token`, 400 malformed subscribe/publish, 403 signature/origin. The integration test sentinel codes `DOUBLE_RESPONSE`/`NO_RESPONSE` are test-harness-only.

---

## 9. Legacy compatibility

### 9.1 Legacy `vfs:*` channel aliases

`LEGACY_VFS_CHANNEL_ALIASES` (`:9531-9555`) maps historical channel names to modern `nova:fs:*` channels. Resolution runs at **every entry point before** handler lookup and the MAC check ("translate-then-enforce", `:9501-9504`) — a legacy call takes exactly the same enforcement path as a modern one; there is no alias bypass. Responses echo the **modern** type string; the guest shim matches responses by requestId, never by type (`:9524-9529`).

| Legacy channel | Modern channel |
|---|---|
| `nova:vfs:read` | `nova:fs:read` |
| `nova:vfs:write` | `nova:fs:write` |
| `nova:vfs:delete` | `nova:fs:delete` |
| `nova:vfs:list` | `nova:fs:list` |
| `nova:vfs:mkdir` | `nova:fs:mkdir` |
| `nova:vfs:stat` | `nova:fs:stat` |
| `nova:vfs:rename` | `nova:fs:rename` |
| `nova:vfs:move` | `nova:fs:move` |
| `vfs:read` / `vfs:write` / `vfs:delete` / `vfs:list` / `vfs:mkdir` / `vfs:stat` / `vfs:rename` / `vfs:move` (bare spellings) | same modern channels |
| `vfs:metadata`, **`vfs:metedata`** (typo, aliased "as free insurance"), `nova:vfs:metadata`, `nova:vfs:metedata` | `nova:fs:stat` |

There is deliberately **no `vfs:access` channel alias** (`:9518-9522`).

### 9.2 Legacy permission translation (manifest side)

`LEGACY_PERMISSION_ALIASES` in `js/platform/core/app-registry.js:75-81` translates manifest permission names at registration (deduplicated when legacy names collapse):

| Legacy permission | Modern permission |
|---|---|
| `vfs:access` | `fs:access` |
| `vfs:read` | `fs:access` |
| `vfs:write` | `fs:access` |
| `vfs:delete` | `fs:access` |
| `vfs:metadata` | `fs:metadata` |

Asymmetry to know: the **channel** alias table includes the `vfs:metedata`/`nova:vfs:metedata` typo spellings, but the **permission** translator does not — a manifest declaring `vfs:metedata` has it stripped as unknown (app-registry.test.js:181). Legacy `vfs:*` keys in `permissionReasons` are translated the same way.

### 9.3 `window.__novaPrivateStore` — legacy web-app bridge only

There is **no** `window.__novaPrivateStore` for `.novaapp` apps (NOVAAPP.md:553, :714). The name exists only in the **legacy web-app bridge**: the App Manager injects a minimal `window.nova` shim (postMessage-based `ipc` with a 30 s timeout, `window.allowedPermissions`, `window.__novaPermResponse`) into wrapped web apps (`wa_*`/`webapp_*` entries) and sets `window.__novaPrivateStore = {}` as a compatibility marker (`js/platform/core/nova-app-launcher.js:1074`, `js/apps/appmanager/app.js:1070`). Sandboxed `.novaapp` packages get the full MessagePort bridge instead; use `novaOS.storage.*` for isolated, namespaced storage — your app can never read or overwrite another app's data through it.

Other legacy artifacts apps may encounter: legacy localStorage keys (`nova_installed_apps`, `nova_app_permissions`, `nova_app_alarms`, …) live on as adoption/fallback shadows of their registry counterparts (see [`internals.md`](internals.md)); `window.NovaAppIdAliases` canonicalizes old app ids (e.g. `com.nbosp.quill` → `com.nbosp.textedit`), which also redirects their data subtrees.

---

## 10. Document status

- Everything in §3–§9 is code-verified: facade members from the shim/facade source (`:10235-13030`), channels from `API_HANDLERS` (`:9338-9463`) and the handler bodies, limits from the constants inventory and the test suites (values asserted in `tests/platform/security/*` and `tests/integration/*`).
- **Response shapes that are undocumented in code:** the `nova:nested-webview` response bodies are action-specific and defined by `js/apps/system-webview/service.js` (not enumerated here); the exact success payload of `nova:open-with` (chooser delegation) and `nova:app:uninstall` is a thin `{success…}` wrapper. Everything else in §5 was read from the handler's `respond()` call.
- Where the audit notes could not establish a payload/response shape or where two sources disagreed, this document says so inline (see the Unverified blockquote in §7.10; the share/download cancel semantics in §5.8; the mail action responses in §5.27, which are server-action-shaped).
- Related docs: [`guide.md`](guide.md) — manifests, packaging, sandbox attributes, capability declaration. [`permissions.md`](permissions.md) — the permission catalog, risk tiers, prompts and the request flow. [`examples.md`](examples.md) — working recipes over these APIs. [`internals.md`](internals.md) — dispatch pipeline, MAC engine, storage ledger, known security observations.

---

## Appendix A. Raw protocol examples

For completeness — the exact envelopes a raw `nova.ipc()` call produces. You should not need these unless you are debugging the bridge or calling a channel without a facade method.

**A.1 Storage set (success):**

```js
await nova.ipc('nova:storage:set', { key: 'todos', value: {items: 3} });
// request  : {kind:'request', type:'nova:storage:set',
//             payload:{key:'todos', value:{items:3}}, requestId:'shim_…'}
// response : {type:'nova:storage:set:response', requestId:'shim_…',
//             result:{success:true}}
// resolves : {success:true, result:{success:true}, type:'nova:storage:set:response'}
```

**A.2 Permission denied (MAC front door):**

```js
try { await nova.ipc('nova:clipboard:read', {}); }
catch (e) {
  e.code;     // 'PERMISSION_DENIED'
  e.message;  // 'Blocked by system security policy (MAC): requires clipboard:read'
}
// response : {type:'nova:clipboard:read:response', requestId:'shim_…',
//             error:{code:'PERMISSION_DENIED', message:'Blocked by system security policy (MAC): requires clipboard:read'}}
```

**A.3 Legacy alias (translate-then-enforce):**

```js
await nova.ipc('vfs:read', { path: 'notes.txt' });
// translated to 'nova:fs:read' BEFORE handler lookup and MAC check;
// response carries type 'nova:fs:read:response' — matching is by requestId,
// so the legacy caller never notices (§9.1).
```

**A.4 Interactive channel (10-minute timeout):**

```js
const picked = await nova.ipc('nova:sysdialog:open',
  { title: 'Open note', multiple: false, accept: ['.txt', 'text/plain'] });
// up to 10 minutes while the user browses; cancel resolves via the dialog contract
```

**A.5 Pushed event (no pending request):**

```js
novaOS.alarms.onAlarm(a => console.log(a.name, a.queued));
// host push: {type:'nova:background:alarm:response', requestId:'<fresh id>',
//             result:{name:'sync', alarm:{…}, firedAt:'…', queued:true}}
// dispatched to alarmListeners; never resolves a pendingRequests entry
```

## Appendix B. Count summary

| Item | Count |
|---|---|
| Guest-reachable channels (`API_HANDLERS`) | 124 |
| Host-only channels (`GUEST_FORBIDDEN_IPC_APIS`) | 40 |
| `window.nova` v1 members | 71 (69 always + 2 opt-in `browser.*`) |
| `window.novaOS` v2 namespaces / methods | 28 / 116 |
| Capability names | 28 |
| Pushed event type strings | 15 (14 pushed types + the ready special case; 13 shim dispatch branches, §6) |
| Subscribable OS-bus event names | 17 |
| Interactive channels (10-min timeout) | 11 |
| Legacy channel aliases | 22 spellings → 9 modern channels |
| Legacy permission aliases | 5 |

## Appendix C. Task → API quick map

| Task | Recommended call(s) | Gate / limit to know |
|---|---|---|
| Read my launch options / permission snapshot | `await novaOS.ready.get()` (or `nova.app.getInfo()`); options: `nova.app.getLaunchOptions()` | automatic handshake already ran; re-reads are safe |
| Persist a setting | `novaOS.storage.set(key, value)` | 5 MB/value, 256 MB/app; key `/^[\w\-. ]+$/` |
| Save a file the user chooses | `novaOS.dialog.pickSave({ content, suggestedName })` | 10 MB content cap; interactive 10-min timeout |
| Open a file the user chooses | `novaOS.dialog.pickOpen({ accept: ['.json'] })` or `nova.files.open()` | picked id gains scoped read/write, no fs grant needed |
| Read/write my own app data tree | `novaOS.fs.appdata.read/write/list/remove(path)` | no permission (own subtree) |
| Watch my files | `novaOS.fs.watch(path, cb)` → `handle.unwatch()` | `fs:watch`; 8 watchers, 60 events/min, best-effort |
| Show a notification with actions | `novaOS.notifications.createChannel()` once, then `post({channelId, tag, actions, progress})` | `device:notifications`; 10 new/min, 60 update/min; drain clicks with `consumeActions()` |
| Update a progress notification | `post({channelId, tag, progress})` with the same `tag` | counts against the 60/min update budget, not the 10/min |
| Set the taskbar badge | `novaOS.badge.set(3)` / `set({text:'NEW'})` / `clear()` | `system:badge`; 30/min; 0–999 / 1–4 chars |
| Request a permission at runtime | `await novaOS.permissions.request('net:external', 'why')` → boolean | 3 prompts/60 s, 5 s→15 min cooldown; peek with `checkRateLimited()` |
| Fetch a remote API | `await fetch(url, opts)` (patched global) | ANY-of `net:internal`/`net:external`; 16 MiB request body; plaintext http allowed |
| Open a WebSocket | `const ws = await novaOS.net.websocket(url)` | `net:websocket` (+ `net:internal` for LAN hosts); open failure = generic timeout |
| Share content out | `novaOS.app.share({ title, text, url })` | no permission; 5 sheets/min; text ≤ 4000 |
| Receive shares | manifest `shareTarget` + `system:share-target`, then `novaOS.share.onInbound(cb)` | queue ≤ 8 while closed, flushed after ready |
| Talk to another app | provider: `nova.ipc.provide('service:x', handler)`; caller: `nova.ipc.call(appId, 'service:x', data)` | both apps: `apps:communicate` + `manifest.ipc.exports`/`.receives`; 20/min; 256 KB |
| Broadcast to apps | `nova.ipc.broadcast('action', data)` | same gates; `{delivered}` count |
| Schedule work later (app running) | `novaOS.alarms.create({ name, periodMinutes: 15 })` + `onAlarm(cb)` | `system:schedule`; 32 alarms, ≥ 15 min; does **not** wake a closed app |
| Survive window close | `novaOS.background.stayAlive()` (each session) | `system:background:live`; user sees a pinned Terminate notification |
| Handle a scheduled wake | `nova.onBackgroundWake(cb)` / `novaOS.background.onWake(cb)`; finish early with `wakeDone()` | `system:background` (checked by the scheduler, not you); 10 s deadline |
| Receive push from your backend | `const {token, endpoint} = await novaOS.push.register()`; `novaOS.push.onMessage(cb)` | `push:receive`; hand the token to your server, publish to `/api/push/publish` |
| Store a credential | `novaOS.secrets.set(key, value)` | `secrets:store`; 64 secrets, 8 KB each; never in backups |
| React to theme changes | `nova.appearance.onChange(cb)` | no permission; immediate first callback |
| Set the window title | `novaOS.window.setTitle('Notes — draft')` | 200-char cap |
| Open a URL in the browser | `novaOS.app.openUrl(url)` | no permission; credential-free http(s) only |
| Download bytes to disk | `nova.browser.download({ url, filename })` (nested-webview opt-in) or `nova.ipc('nova:download', { base64Data, mimeType, filename })` | no permission, no size cap; the save dialog is the consent |
| Embed a web view | manifest `allowNestedWebview: true` + `sandbox:nested-webview`; `nova.browser.createView({ container })` | every navigation re-checked against `net:*` grants |
| React to registry changes | `novaOS.registry.watch('HKNU/software/myapp', cb)` | `registry.read`; prefix-filtered `nova:reg:changed` |
| Export/import my data | `novaOS.data.backup()` / `restore(env)`; subsets via `export({keys})` / `import(env)` | `data:backup` / `data:export`; envelopes are checksummed + appId-pinned |
