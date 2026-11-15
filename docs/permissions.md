# Permissions reference (.novaapp)

Every capability a NovaByte OS app can touch behind the IPC bridge is gated by a **permission** from a fixed catalog of **52 permissions in 11 categories** (`PERMISSION_TYPES` / `PERMISSION_CATEGORIES`, app-permission-manager.js:15-245). There are exactly two ways to obtain one:

1. **Declare it in the manifest** — `permissions` (required) or `optionalPermissions` (point-of-use). Sensitive required permissions are prompted at first launch; low-risk ones are auto-granted.
2. **Request it at runtime** — `await window.nova.requestPermission(name, reason)` (v1, raw result) or `await window.novaOS.permissions.request(name, reason)` (v2, resolves to a boolean). Both ride the `nova:request-permission` channel and open the same consent dialog.

For the full app journey (manifest → install → launch → first-run prompts), see [guide.md](guide.md). For channel payloads and facade signatures, see [api-reference.md](api-reference.md). For the enforcement chain (NB-MAC front door, dispatch pipeline), see [internals.md](internals.md). Working sample apps live in [examples.md](examples.md).

Denial contract used throughout this document: **denial never blocks launch** — every launch gate continues in restricted mode ("Launch continuing in restricted mode", app-registry.js:703-708). The denied capability fails at call time: the NB-MAC front door rejects the call before any handler runs with error code `PERMISSION_DENIED` and message `Blocked by system security policy (MAC): requires <perm>` (app-sandbox.js:9584-9596). In the guest, `ipc()` promises reject with an `Error` carrying that `code` and `message` (app-sandbox.js:11353-11355).

---

## Contents

1. [How requesting works](#1-how-requesting-works)
2. [What the user sees](#2-what-the-user-sees)
3. [Grant lifetime](#3-grant-lifetime)
4. [The reference — all 52 permissions](#4-the-reference--all-52-permissions)
5. [Legacy `vfs:*` aliases](#5-legacy-vfs-aliases)
6. [Consolidated quick-reference table](#6-consolidated-quick-reference-table)
7. [Edge cases and non-IPC grants](#7-edge-cases-and-non-ipc-grants)
8. [Unverified](#8-unverified)

---

## 1. How requesting works

### Manifest declaration

```json
{
  "id": "com.example.notes",
  "permissions": ["fs:read:images", "system:app-launch"],
  "optionalPermissions": ["device:notifications"],
  "permissionReasons": {
    "fs:read:images": "Shows your shared photos as note attachments",
    "system:app-launch": "Opens the image editor you pick"
  }
}
```

- `permissions` — required set. At launch, low-risk entries are auto-granted without a dialog (app-registry.js:672-674; `autoGrantLowRisk` refuses if the user has an explicit denial, app-permission-manager.js:941-951); missing sensitive/medium/high entries are queued for prompting.
- `optionalPermissions` — unioned with `permissions` for the low-risk auto-grant pass, but only `permissions` feeds the "required sensitive" launch prompt set (app-registry.js:647-653, :676-680). An optional sensitive permission stays a **point-of-use** runtime request — your app must handle its denial.
- `permissionReasons` — map of permission string to a reason string (max 500 chars, values trimmed; non-strings dropped, unknown keys stripped at install, app-registry.js:326-393). The effective reason is shown in the dialog and **stored on the grant** so Settings can display why the app asked (app-permission-manager.js:826-833).
- Unknown permission names are stripped at registration (`KNOWN_PERMISSIONS`, app-registry.js:315-324). Legacy `vfs:*` names are translated (see section 5).

**Denial at launch never blocks the app.** Missing sensitive grants requested at launch are prompted, and denial does not block — the app opens regardless and `__deniedPermissionsAtLaunch` is recorded (app-registry.js:689-708; appmanager/app.js:802-828; bootstrap:117-131). For `optionalPermissions`, denial is a normal runtime state your app must handle.

Web apps (ids `webapp_*` / `wa_*`) get `net:external` + `net:websocket` auto-granted at boot and are prompted once for `['device:camera','device:microphone','device:geolocation']` (app-permissions-bootstrap.js:238, :240-291).

### Runtime request

```js
const granted = await novaOS.permissions.request(
  'device:notifications',
  'Notify you when a sync finishes'
);                                   // v2: boolean
const raw = await nova.requestPermission('device:notifications', '…'); // v1: raw record
```

- Channel: `nova:request-permission` → `AppPermissionManager.requestPermission(permission, appId, { reason, permanent })` (app-sandbox.js:3592-3606).
- Reason resolution order: runtime payload reason → manifest `permissionReasons` (via AppRegistry record, then `OS.apps` copies) → fallback block "This app declared no reason why it needs this permission." (app-permission-manager.js:319-358, :1109-1114).
- If no reason is passed at all, the host defaults the payload reason to `` `${app.name} wants to access this permission.` `` (app-sandbox.js:3599).
- Runtime requests **re-prompt after every denial** — denials do not suppress future prompts on this path (app-permission-manager.js:782-791). This is why the rate limiter exists.
- Non-permanent grants (`permanent !== true` on the internal path) expire after **1 day** (app-permission-manager.js:896-898).

### Prompt queue and rate limits

- Launch-time prompts run through `requestAll()`: already-granted permissions are filtered out; previously-denied ones still get a live re-prompt on this path, but launch-gate callers pre-filter `isDenied` themselves (app-permission-manager.js:858-882; app-registry.js:681-684). The pager shows "Permission {current} of {total}" with progress dots (app-permission-manager.js:1058-1074).
- **Anti prompt-bombing (app-permission-manager.js:273-277, :727-767):** more than **3 requests per 60 s** for the same `${appId}:${permission}` → silent auto-deny plus a cooldown of `5 s * 2^denialStreak`, capped at **15 minutes** (`RATE_WINDOW_MS=60_000`, `RATE_MAX_BURST=3`, `RATE_BASE_COOLDOWN_MS=5_000`, `RATE_MAX_COOLDOWN_MS=15*60_000`, `RATE_MAX_DENIAL_STREAK=20`). Each event is logged as 'Rate-limited permission request'.
- Query cooldown state without prompting: `await novaOS.permissions.checkRateLimited(name)` (channel `nova:permission-rate-limited`, app-sandbox.js:3608-3614). Example result: `{ rateLimited: true, retryAfterMs: 30000 }`.
- There is **no "don't ask again" checkbox anywhere**. An explicit denial is permanent until the user acts: `resetPermission()` clears the record back to pending; `revokePermission()` writes an explicit denial so launch-time low-risk auto-grants cannot silently undo the user's choice (app-permission-manager.js:708-716, :953-965).

### Where grants are shown and managed

| Surface | What it offers |
|---|---|
| Settings → Permissions (per-app) | Grant/revoke toggles, stored reasons, risk glossary; re-enable = `resetPermission` → `grantPermission` (settings/app.js:2216-2219). `fs:access` appears here as Special access: "enable or revoke here; apps cannot prompt for it." (settings/app.js:2190-2195) |
| App Manager → Permissions | Same per-app grant table from the manager UI |
| Permissions (dev-only app, `com.nbosp.permissions`) | Requires Developer Mode ("Enable Developer Mode in Settings to use Permissions."), offers "Grant (no prompt)" — an acknowledged bypass of the consent flow (permissions/app.js:340-354) |

---

## 2. What the user sees

Dialog anatomy (`showPermissionDialog`, app-permission-manager.js:1149-1280):

- Full-screen overlay at `z-index:100000`; card border is red `#f85149` for `system:root` requests, otherwise neutral.
- **Header:** the permission's user-visible label, then "Requested by **{appName}**".
- **Reason block:** the resolved reason text (runtime reason → `permissionReasons` → fallback "This app declared no reason why it needs this permission.").
- **Risk row:** "Risk" · UPPERCASE tier · category, with a colored chip per tier: low `#3fb950`, medium `#d29922`, high `#f0883e`, critical `#f85149` (app-permission-manager.js:1034-1040).
- **Root-only warning** (system:root): "**This app will run inside the OS, not in its sandbox.**", "{appName} may read or change OS data, manipulate system UI, and access host-page APIs. Root API calls are recorded, but direct JavaScript and browser activity cannot be completely observed.", plus a mandatory checkbox "I understand this app can access and change the OS outside its sandbox." — the Allow button stays disabled until it is checked (app-permission-manager.js:1190-1220).
- **Unverified root requests** additionally show, verbatim: "UNVERIFIED PUBLISHER — this package was NOT signed by any trusted signing authority. Granting root lets its code run unrestricted inside the OS host process." (app-permission-manager.js:815-821).
- **Buttons:** "Deny" (neutral outline) and "Allow" (blue `#58a6ff`); for root requests Allow becomes "Grant Root Access" (red `#b42318`, disabled until the checkbox is ticked).
- **Keyboard:** `Enter` = Allow, `Escape` = Deny (app-permission-manager.js:1275-1278). Note Enter defaults to **Allow**.
- **No timeout** — the dialog waits indefinitely; teardown force-closes it as a denial.
- All text is set via `textContent` (never `innerHTML`) because appName and reason are untrusted (app-permission-manager.js:1026-1032).

The generic pattern referenced by every entry below:

> Label — Requested by **{appName}** · reason text (or the declared-no-reason fallback) · Risk · TIER · category · Deny / Allow (Enter = Allow).

Low-risk permissions produce **no dialog at launch** (silent auto-grant); a runtime `requestPermission()` for them does show the standard dialog. `fs:access` produces **no dialog ever**.

---

## 3. Grant lifetime

### Persistence

| What | Primary (registry-first) | Fail-soft fallback |
|---|---|---|
| Grant/denial records | `HKNS/security/appPermissions` (REG_JSON, machine-wide); **`HKNU/security/appPermissions` when multi-user is on** ("each account consents for itself", registry-system-state.js:258-268) | localStorage `nova_app_permissions` (app-permission-manager.js:259, :421-451) |
| Sweep stamp | `HKNS/security/meta/lastSweep` | `nova_perm_last_sweep` |
| Bootstrap marker | `HKND/_migration/permsBootstrapped` | `nova_perms_bootstrapped` |

- Grant record shape: `{appId, permission, granted, grantedAt, grantedBy, permanent, expiresAt, reason, lastUsed}`; keyed `${appId}:${permission}` (appId must be non-empty with no colons, app-permission-manager.js:371-386, :889-901).
- Registry writes go through `RegistrySystemState`; if the registry is unavailable, both reads and writes degrade to localStorage (app-permission-manager.js:428-451, :534-552). Integrity check is structural only — no HMAC (by design, :388-395).
- On login/user switch, `reloadForUser()` clears the in-memory table and re-hydrates from the active account's hive (app-permission-manager.js:687-700).
- `isGranted()` layers, in order: (1) Settings-app identity exemption; (2) `admin:*` requires an admin session when multi-user is on; (3) machine policy at `HKNS/security/policy/appPolicy/<appId>` — a `deny` list hard-blocks, a `pin` list force-grants regardless of consent; (4) the per-key grant table (app-permission-manager.js:641-669).

### Expiry and sweeps

- **30-day unused sweep:** granted permissions are deleted when the app's `lastUsed`/`grantedAt` is older than `UNUSED_DAYS = 30`; the user gets a notification — "{appName} hasn't been used in 30 days. N permission(s) removed to protect your privacy." (app-permission-manager.js:259-262, :457-497). Sweep runs at most once per day, deferred 5 s after boot (:504-530).
- Denial records are never swept (:467-468). `system:root` is never swept — "Root access therefore requires an explicit user revocation" (:469-472).
- Non-permanent grants expire after 1 day (see section 1).

### Update, reinstall, signature change, uninstall

- Grants are keyed by **appId only** — not version, not signature. Updating via `registerApp(..., {force:true})` keeps every existing grant (app-registry.js:278-284).
- Consequence: replacing an app under the same id with a differently-signed or unverified package **inherits all previous grants**; only `system:root` in the manifest re-prompts on next launch for non-System signers (root restore rule, app-registry.js:171-185).
- **Uninstall via App Manager** calls `revokeAllPermissions(appId)` (Android parity; appmanager/app.js:2752-2756, app-sandbox.js:5843-5851) and also clears rate-limit state, storage partitions, per-app storage, notification state, and app data. The core `uninstallApp`/`unregisterApp` path does **not** clear grants — orphaned grants age out via the 30-day sweep.
- `revokeAllPermissions` triggers `handlePermissionRevoked` for live `sandbox:same-origin` / `sandbox:nested-webview` grants and `reloadAfterRootRevocation` for root (app-permission-manager.js:967-996).
- Live revocation of a single grant is enforced immediately: capabilities are torn down (`AppSandbox.handlePermissionRevoked`), and root revocation reloads the host page (app-permission-manager.js:962-984).

---

## 4. The reference — all 52 permissions

Grouped by the 11 catalog categories. Counts: filesystem 6, network 3, email 4, calendar 3, contacts 3, device 6, data 3, apps 1, system 16, admin 4, sandbox 3 = **52 entries**. Risk tiers: low 10, medium 16, high 15, critical 11.

The MAC seed table (`SEED_ENDPOINT_GRANTS`, app-sandbox.js:534-681) is the authoritative endpoint → permission map; rows are **ANY-of** (any one listed grant passes the front door; the handler may add per-path/destination rules). Channels marked *advisory* have a `null` MAC row — the handler-level check is the boundary.

### filesystem (6)

### `fs:access` — Risk: critical — Category: filesystem
- **User-visible label:** "Manage all files"
- **What it unlocks:** broad access across the `nova:fs` family on the **shared tree** — `nova:fs:read`, `nova:fs:write`, `nova:fs:delete`, `nova:fs:list`, `nova:fs:mkdir`, `nova:fs:stat`, `nova:fs:rename`, `nova:fs:move`, plus `nova:media:query` (all advisory MAC rows; the handler's path rules are the boundary). Specifically `hasFsAccess()` (app-sandbox.js:1831-1833) satisfies `canReadFileContents`, `canReadMetadata`, `canMutateFile` for shared nodes, `broadAccess` in `nova:sysdialog:save` (overwrite shared files without an extra confirm), `canPickerAccess`, and the `fs:watch` folder-parity check. It never unlocks another app's private `/data/<appId>/` tree (foreign nodes resolve `NOT_FOUND`).
- **Extra gates:** none — but see the request flow below.
- **How to request:** you cannot. `specialAccess: true` (app-permission-manager.js:142) — `requestPermission('fs:access')` returns false without a dialog (app-permission-manager.js:778) and `requestAll()` skips it (:863-865). Manifest declarations are recorded but never prompt. The user enables it manually in Settings → Permissions → Special access.
- **Working example:**
  ```js
  // Only after the user turned on "Manage all files" in Settings:
  const files = await novaOS.fs.list('shared:/Documents');
  await novaOS.fs.write('shared:/Documents/notes.txt', 'hello');
  ```
- **What the user sees:** no dialog, ever. Only the Settings toggle: "Special access: enable or revoke here; apps cannot prompt for it."
- **On denial:** app runs normally with its own `/data/<appId>/` tree and picker-granted files; shared-tree mutations fail handler-side with `PERMISSION_DENIED` (e.g. `nova:sysdialog:open` VFS branch: 'Selected file is outside this app's accessible files', app-sandbox.js:8960).
- **Limits tied to this permission:** none specific to the grant; filesystem roots stay protected (`PROTECTED_LOCATION` on delete of roots); picker-mediated host files remain capped at 10 MB per read/write.
- **Overlap guidance:** request this only for real file managers. For showing media use `fs:read:images`/`fs:read:video`/`fs:read:audio`; for names and sizes only, `fs:metadata`.

### `fs:metadata` — Risk: medium — Category: filesystem
- **User-visible label:** "Read shared file metadata"
- **What it unlocks:** metadata (name/size/mime/modified) of shared-tree nodes through `nova:fs:stat`, `nova:fs:list`, and `nova:media:query` — `canReadMetadata` adds this grant on top of owned/picked/fs:access paths (app-sandbox.js:1862-1867). Also satisfies the `fs:watch` folder-access parity check (app-sandbox.js:7718-7726).
- **Extra gates:** none.
- **How to request:** manifest (`permissions` prompts at launch) and/or runtime `nova.requestPermission('fs:metadata', reason)`.
- **Working example:**
  ```js
  const st = await novaOS.fs.stat('shared:/Photos');
  ```
- **What the user sees:** standard dialog — "Read shared file metadata" — Requested by **{appName}** · reason block · Risk · MEDIUM · filesystem · Deny / Allow (Enter = Allow).
- **On denial:** app runs; `nova:fs:stat`/`list` on shared (non-owned) paths reject with `PERMISSION_DENIED`. Own `/data/<appId>/` metadata needs no grant.
- **Limits tied to this permission:** none documented for metadata reads.
- **Overlap guidance:** prefer this over `fs:access` when you only list/inspect files; prefer the media grants when you need actual bytes.

### `fs:watch` — Risk: low — Category: filesystem
- **User-visible label:** "Get notified when your files change"
- **What it unlocks:** `nova:fs:watch` — the only grant-coupled row in the fs family. Facade `novaOS.fs.watch(path, callback)` returns `{watcherId, path, unwatch()}`; change pushes arrive as `nova:fs:changed` with `{watcherId, path, kind: 'created'|'changed'|'deleted', timestamp}`. `nova:fs:unwatch` is advisory (dropping your own poller leaks nothing).
- **Extra gates:** per-path read rules in the handler ("watching is reading"): folders need owned OR `fs:access` OR `fs:metadata` OR any of `fs:read:images`/`fs:read:video`/`fs:read:audio`; files need `canReadFileContents` (app-sandbox.js:7718-7727).
- **How to request:** manifest declaration is auto-granted at launch with no dialog (low risk, unless previously revoked); runtime request shows the standard dialog.
- **Working example:**
  ```js
  const w = await novaOS.fs.watch('shared:/Documents', (e) => {
    console.log(e.kind, e.path);       // created | changed | deleted
  });
  // later: await w.unwatch();
  ```
- **What the user sees:** no dialog at launch (silent auto-grant); runtime request shows "Get notified when your files change" with the standard anatomy.
- **On denial:** app runs; `nova:fs:watch` rejects with `PERMISSION_DENIED`.
- **Limits tied to this permission:** max **8 watchers per app** (`RATE_LIMITED` 'Max 8 watchers per app'); poll every 2000 ms, debounce 300 ms; max **60 pushes per minute** per app (rate-limited events are coalesced, not queued); watcherId pattern `^w_[a-z0-9_]{4,64}$` (app-sandbox.js:7609-7612, :7752-7753).
- **Overlap guidance:** purely reactive — it grants no new read access. Pair it with whichever read grant already covers the watched path; don't reach for `fs:access` just to watch.

### `fs:read:images` — Risk: medium — Category: filesystem
- **User-visible label:** "Read shared images"
- **What it unlocks:** reading image-MIME files from the shared tree via `nova:fs:read` (facades `novaOS.fs.read(path)`, `novaOS.fs.shared.read(path)`) and `nova:media:query` — the per-media branch of `canReadFileContents` (app-sandbox.js:1842-1859). Also counts for the `fs:watch` folder parity check.
- **Extra gates:** per-MIME match enforced handler-side; MAC rows for the fs family are advisory.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  const photo = await novaOS.fs.read('shared:/Photos/cat.jpg');
  ```
- **What the user sees:** standard dialog — "Read shared images" · reason · Risk · MEDIUM · filesystem.
- **On denial:** app runs; shared-image reads reject with `PERMISSION_DENIED` ("limits shared-media reads to the matching media permission", app-sandbox.test.js:1896). Own and picker-granted files still work.
- **Limits tied to this permission:** none documented for media reads (the 10 MB cap applies to the separate host-picker flow).
- **Overlap guidance:** vs `fs:access` — this is scoped to one media type on the shared tree; request the narrowest grant that covers your feature.

### `fs:read:video` — Risk: medium — Category: filesystem
- **User-visible label:** "Read shared videos"
- **What it unlocks:** same surface as `fs:read:images` but for video MIME types: `nova:fs:read` / `novaOS.fs.read` / `novaOS.fs.shared.read` and `nova:media:query` (app-sandbox.js:1842-1859); counts for `fs:watch` folder parity.
- **Extra gates:** per-MIME match handler-side.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  const clip = await novaOS.fs.read('shared:/Movies/clip.mp4');
  ```
- **What the user sees:** standard dialog — "Read shared videos" · reason · Risk · MEDIUM · filesystem.
- **On denial:** app runs; shared-video reads reject with `PERMISSION_DENIED`.
- **Limits tied to this permission:** none documented.
- **Overlap guidance:** pick per media type; declare all three media grants only if you genuinely index the whole shared library.

### `fs:read:audio` — Risk: medium — Category: filesystem
- **User-visible label:** "Read shared audio"
- **What it unlocks:** same surface as `fs:read:images` but for audio MIME types: `nova:fs:read` / `novaOS.fs.read` / `novaOS.fs.shared.read` and `nova:media:query`; counts for `fs:watch` folder parity.
- **Extra gates:** per-MIME match handler-side.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  const track = await novaOS.fs.read('shared:/Music/track.mp3');
  ```
- **What the user sees:** standard dialog — "Read shared audio" · reason · Risk · MEDIUM · filesystem.
- **On denial:** app runs; shared-audio reads reject with `PERMISSION_DENIED`.
- **Limits tied to this permission:** none documented.
- **Overlap guidance:** see `fs:read:images`.

### network (3)

### `net:internal` — Risk: high — Category: network
- **User-visible label:** "Internal network"
- **What it unlocks:** `nova:net:fetch` to **internal** destinations. The MAC row is ANY-of `['net:internal','net:external']` and the handler classifies the destination (app-sandbox.js:6408-6410): `localhost`, `api.novabyte.internal`, private IPv4 (127/8, 10/8, 172.16-31, 192.168/16, 169.254/16, 0.0.0.0/8, 100.64.0.0/10), private IPv6 ranges, and — for WebSockets — `.localhost/.local/.lan/.internal/.home.arpa/.test` suffixes plus single-label names. Internal fetches run directly from the host document. Additionally required **on top of** `net:websocket` for private/first-party WebSocket URLs, and by the nested-webview navigation gate for internal URLs.
- **Extra gates:** none.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  // The patched window.fetch rides nova:net:fetch transparently:
  const res = await fetch('https://api.novabyte.internal/v1/state');
  ```
- **What the user sees:** standard dialog — "Internal network" · reason · Risk · HIGH · network.
- **On denial:** app runs; internal fetches reject with `PERMISSION_DENIED` (the analogous WebSocket denial string is 'net:internal permission required for private or first-party WebSocket destinations', app-sandbox.js:6529-6531).
- **Limits tied to this permission:** request bodies capped by the ledger `httpBodyBytes` budget (default **16 MiB**; `PAYLOAD_TOO_LARGE` 'Binary request body exceeds the N MiB limit'); methods limited to GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS; http/https only; cloud-metadata hosts (169.254.169.254, fd00:ec2::254) hard-denied; no response-size cap or in-handler timeout (documented gap).
- **Overlap guidance:** vs `net:external` — the two are alternatives at the MAC front door; the handler decides per destination. An app that only talks to LAN/localhost services needs only `net:internal`; a public-internet app needs only `net:external`; a hybrid needs both.

### `net:external` — Risk: low — Category: network
- **User-visible label:** "Public internet access"
- **What it unlocks:** `nova:net:fetch` to **public** destinations (external branch routes through the server proxy `/api/proxy`); also satisfies the nested-webview navigation gate for external URLs. The app page's patched `window.fetch`, `XMLHttpRequest`, and `navigator.sendBeacon` all ride this channel. **Auto-granted to web apps at boot** (app-permissions-bootstrap.js:252).
- **Extra gates:** none.
- **How to request:** manifest declaration is auto-granted at launch with no dialog; runtime request shows the standard dialog.
- **Working example:**
  ```js
  const res = await fetch('https://api.openweathermap.org/data/2.5/weather?q=Berlin');
  const data = await res.json();
  ```
- **What the user sees:** no dialog at launch (silent auto-grant, low risk); runtime request shows "Public internet access" with the standard anatomy.
- **On denial:** app runs; external fetches reject with `PERMISSION_DENIED`; proxy failures surface as `NETWORK_ERROR`.
- **Limits tied to this permission:** request body ≤ **16 MiB** (ledger `httpBodyBytes`); method/protocol allowlists; metadata hosts blocked; no response-size cap; `http:` plaintext allowed (no TLS floor).
- **Overlap guidance:** see `net:internal`.

### `net:websocket` — Risk: low — Category: network
- **User-visible label:** "Public WebSocket connections"
- **What it unlocks:** `nova:net:websocket` — facades `nova.websocket(url, protocols)` and `novaOS.net.websocket(url, protocols)` return a handle `{wsId, readyState, onMessage, onError, onClose, send(data), close(code, reason)}`. The data-plane channels `nova:net:ws:send` / `nova:net:ws:close` are advisory (own sockets only). Subscribing to the mirrored OS-bus events `nova:net:ws:message|error|close` requires this grant (plus `system:events` per the domain rules). **Auto-granted to web apps at boot** (app-permissions-bootstrap.js:253).
- **Extra gates:** `ws:`/`wss:` URLs only; credentials embedded in the URL rejected; **internal destinations additionally require `net:internal`** (app-sandbox.js:6529-6531).
- **How to request:** manifest declaration is auto-granted at launch; runtime request shows the standard dialog.
- **Working example:**
  ```js
  const ws = await nova.websocket('wss://socket.example.com/feed');
  ws.onMessage((frame) => render(frame));
  await ws.send({ subscribe: 'prices' });
  ```
- **What the user sees:** no dialog at launch; runtime request shows "Public WebSocket connections" with the standard anatomy.
- **On denial:** app runs; `nova:net:websocket` rejects with `PERMISSION_DENIED`; ws event subscription fails with `PERMISSION_DENIED` and no subscription is created (app-sandbox.test.js:3033).
- **Limits tied to this permission:** **no cap on concurrent sockets, frame sizes, or send rate** (documented); one connection-open resolves only from `onopen` — a never-opening socket surfaces as the generic 30 s IPC timeout.
- **Overlap guidance:** independent of `net:external` (a plain-HTTP fetch grant does not cover sockets). Request `net:internal` too if your socket endpoints are private/first-party.

### email (4)

### `mail:read` — Risk: high — Category: email
- **User-visible label:** "Read emails"
- **What it unlocks:** `nova:mail:read` with actions `folders | message (uid) | search (query) | account | messages (folder/page/limit)` — proxied host-side to `/api/email/*` with the app identity attached. The v1 `nova.mail.*` read methods and the mirrored `novaOS.mail.*` methods wrap this channel.
- **Extra gates:** an email account must already be connected in the Email app, else every call fails `UNAVAILABLE` 'No email account connected — open the Email app and connect an account first' (app-sandbox.js:5484-5486).
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  const hits = await nova.ipc('nova:mail:read', {
    action: 'search', query: 'invoice'
  });
  ```
- **What the user sees:** standard dialog — "Read emails" · reason · Risk · HIGH · email.
- **On denial:** app runs; `nova:mail:read` rejects with `PERMISSION_DENIED`. Invalid payloads give `INVALID_ARGS` ('uid is required for action "message"', 'query is required…').
- **Limits tied to this permission:** none documented on the channel.
- **Overlap guidance:** vs `mail:write`/`send`/`delete` — read is the only non-destructive mail grant; request the others only for compose/send/destruction features.

### `mail:write` — Risk: critical — Category: email
- **User-visible label:** "Compose emails"
- **What it unlocks:** `nova:mail:write` (actions `preview` — HTML render preview — and `batch` with op `read` or `move`; a delete op is deliberately impossible via this channel) **and** `nova:mail:session` (actions `connect | disconnect | restore`; `connect` requires `type, host, user, pass`, plaintext refused with 'Plaintext connections are not supported'). Credential-bearing operations stay host-side by design (app-sandbox.js:5488-5492).
- **Extra gates:** same connected-account requirement as `mail:read`.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  await nova.mail.connect({
    type: 'imap', host: 'imap.example.com',
    user: 'a@example.com', pass: '•••'
  });
  ```
- **What the user sees:** standard dialog — "Compose emails" · reason · Risk · CRITICAL · email.
- **On denial:** app runs; `nova:mail:write` / `nova:mail:session` reject with `PERMISSION_DENIED`; `INVALID_ARGS` for missing `uids`/`dest`.
- **Limits tied to this permission:** none documented.
- **Overlap guidance:** this is compose/session, not sending — sending needs `mail:send`, destruction needs `mail:delete`.

### `mail:send` — Risk: critical — Category: email
- **User-visible label:** "Send emails"
- **What it unlocks:** `nova:mail:send` (facade `nova.mail.send` / `novaOS.mail.send`) — forwards `to` (required), `to/cc/bcc/subject/text/html`, and `smtpHost` (**required**: 'smtpHost is required — the server has no way to infer it from the connected IMAP/POP3/EWS account (they are frequently different hosts)', app-sandbox.js:5648) to `/api/email/send`.
- **Extra gates:** same connected-account requirement.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  await nova.mail.send({
    to: 'team@example.com', smtpHost: 'smtp.example.com',
    subject: 'Weekly report', text: 'All charts attached.'
  });
  ```
- **What the user sees:** standard dialog — "Send emails" · reason · Risk · CRITICAL · email.
- **On denial:** app runs; `nova:mail:send` rejects with `PERMISSION_DENIED`; missing `to`/`smtpHost` give `INVALID_ARGS`.
- **Limits tied to this permission:** none documented.
- **Overlap guidance:** keep separate from `mail:write` — a draft composer that never sends should not hold `mail:send`.

### `mail:delete` — Risk: critical — Category: email
- **User-visible label:** "Delete emails"
- **What it unlocks:** `nova:mail:delete` — `uids` must be a non-empty array; posts `{op:'delete', uids, folder:'INBOX'}` to `/api/email/batch`; responds `{success, deleted: uids.length}`.
- **Extra gates:** same connected-account requirement.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  const res = await nova.ipc('nova:mail:delete', { uids: [42, 43] });
  // { success: true, deleted: 2 }
  ```
- **What the user sees:** standard dialog — "Delete emails" · reason · Risk · CRITICAL · email.
- **On denial:** app runs; `nova:mail:delete` rejects with `PERMISSION_DENIED`; empty/missing `uids` gives `INVALID_ARGS` 'uids array is required'.
- **Limits tied to this permission:** none documented.
- **Overlap guidance:** the destructive sibling of `mail:read`; deleting is not possible through `mail:write`'s batch channel by design.

### calendar (3)

### `calendar:read` — Risk: medium — Category: calendar
- **User-visible label:** "Read calendar"
- **What it unlocks:** `nova:calendar:read` — facades `nova.calendar.list()` / `novaOS.calendar.list()`. Returns **all** events from the shared host store (`calendar_events_v2`) — there is no per-app scoping (Android-style shared provider).
- **Extra gates:** none.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  const events = await nova.calendar.list();
  ```
- **What the user sees:** standard dialog — "Read calendar" · reason · Risk · MEDIUM · calendar.
- **On denial:** app runs; `nova:calendar:read` rejects with `PERMISSION_DENIED`.
- **Limits tied to this permission:** none documented.
- **Overlap guidance:** read-only view of the shared calendar; write/delete are separate grants.

### `calendar:write` — Risk: high — Category: calendar
- **User-visible label:** "Edit calendar"
- **What it unlocks:** `nova:calendar:write` — facades `nova.calendar.save(event)` / `novaOS.calendar.save(event)`; upsert by id; saves emit `calendar:updated`.
- **Extra gates:** sanitizer requires a non-empty `title` and a `date` matching `/^\d{4}-\d{2}-\d{2}$/`; `color` must be one of 8 frozen colors; else `INVALID_EVENT` 'Event must have a title and a YYYY-MM-DD date'.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  await nova.calendar.save({
    id: 'evt_1', title: 'Ship 1.2.0', date: '2026-12-01'
  });
  ```
- **What the user sees:** standard dialog — "Edit calendar" · reason · Risk · HIGH · calendar.
- **On denial:** app runs; `nova:calendar:write` rejects with `PERMISSION_DENIED`.
- **Limits tied to this permission:** none documented.
- **Overlap guidance:** upsert only — removal needs `calendar:delete`.

### `calendar:delete` — Risk: high — Category: calendar
- **User-visible label:** "Delete calendar events"
- **What it unlocks:** `nova:calendar:delete` — facades `nova.calendar.remove(id)` / `novaOS.calendar.remove(id)` (returns a boolean `removed`).
- **Extra gates:** id must be a non-empty string, else `INVALID_ID` 'id must be a non-empty string'.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  const removed = await nova.calendar.remove('evt_1');
  ```
- **What the user sees:** standard dialog — "Delete calendar events" · reason · Risk · HIGH · calendar.
- **On denial:** app runs; `nova:calendar:delete` rejects with `PERMISSION_DENIED`.
- **Limits tied to this permission:** none documented.
- **Overlap guidance:** the destructive member of the calendar trio; request it only if your UI actually deletes events.

### contacts (3)

### `contacts:read` — Risk: medium — Category: contacts
- **User-visible label:** "Read contacts"
- **What it unlocks:** `nova:contacts:read` — facades `nova.contacts.list()` / `novaOS.contacts.list()`. Returns **all** contacts from the shared store `nova_contacts` (no per-app scoping).
- **Extra gates:** none.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  const all = await nova.contacts.list();
  ```
- **What the user sees:** standard dialog — "Read contacts" · reason · Risk · MEDIUM · contacts.
- **On denial:** app runs; `nova:contacts:read` rejects with `PERMISSION_DENIED`.
- **Limits tied to this permission:** none documented.
- **Overlap guidance:** read-only; write/delete are separate grants.

### `contacts:write` — Risk: high — Category: contacts
- **User-visible label:** "Edit contacts"
- **What it unlocks:** `nova:contacts:write` — facades `nova.contacts.save(contact)` / `novaOS.contacts.save(contact)`; upsert by id; saves emit `contacts:updated`.
- **Extra gates:** write requires at least a trimmed name, else `INVALID_CONTACT` 'Contact must have at least a name'; valid contacts need id/name/email/phone/notes as strings.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  await nova.contacts.save({
    id: 'c_1', name: 'Ada', email: 'ada@example.com',
    phone: '555-0100', notes: ''
  });
  ```
- **What the user sees:** standard dialog — "Edit contacts" · reason · Risk · HIGH · contacts.
- **On denial:** app runs; `nova:contacts:write` rejects with `PERMISSION_DENIED`.
- **Limits tied to this permission:** none documented.
- **Overlap guidance:** upsert only — removal needs `contacts:delete`.

### `contacts:delete` — Risk: high — Category: contacts
- **User-visible label:** "Delete contacts"
- **What it unlocks:** `nova:contacts:delete` — facades `nova.contacts.remove(id)` / `novaOS.contacts.remove(id)` (boolean result).
- **Extra gates:** id must be a non-empty string, else `INVALID_ID`.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  const removed = await nova.contacts.remove('c_1');
  ```
- **What the user sees:** standard dialog — "Delete contacts" · reason · Risk · HIGH · contacts.
- **On denial:** app runs; `nova:contacts:delete` rejects with `PERMISSION_DENIED`.
- **Limits tied to this permission:** none documented.
- **Overlap guidance:** destructive member of the contacts trio.

### device (6)

### `device:notifications` — Risk: low — Category: device
- **User-visible label:** "Send notifications"
- **What it unlocks:** every `nova:notifications:*` channel — `show`, `clear`, `post`, `createChannel`, `cancel`, `cancelAll`, `consumeActions` (the MAC comment: "every handler checks device:notifications"). Facade: `novaOS.notifications.{show, post, createChannel, cancel, cancelAll, clear, consumeActions}`. Notification **actions are pull-only** — there is no action-click push; consume via `consumeActions()`.
- **Extra gates:** none. Note: neither background grant implies this one (catalog comment, app-permission-manager.js:65-66).
- **How to request:** manifest declaration is auto-granted at launch with no dialog; runtime request shows the standard dialog.
- **Working example:**
  ```js
  await novaOS.notifications.post({
    title: 'Backup complete', body: 'All notes saved.', type: 'success'
  });
  ```
- **What the user sees:** no dialog at launch; runtime request shows "Send notifications" with the standard anatomy.
- **On denial:** app runs; all notification channels reject with `PERMISSION_DENIED`.
- **Limits tied to this permission:** **10 new posts per 60 s** and a separate **60 tagged updates per 60 s** per app; title ≤ 120 chars (default 'Notification'), body ≤ 500; type ∈ {info, success, warning, error}; icon ∈ 22 allowlisted ids; ≤ 3 actions (labels ≤ 40 chars) with action string ∈ {settings, open-settings, openSettings, open-store} else dropped; 32 channels per app; channelId ≤ 64; tag ≤ 64; progress max 100000 (app-sandbox.js:1040-1074).
- **Overlap guidance:** the default companion for messaging/sync apps; harmless to combine with any other grant.

### `device:geolocation` — Risk: high — Category: device
- **User-visible label:** "Access location"
- **What it unlocks:** `nova:device:geolocation` — facade `novaOS.geolocation.getCurrentPosition(options)` → `{coords{latitude, longitude, altitude, accuracy, altitudeAccuracy, heading, speed}, timestamp}` (wraps `navigator.geolocation` in the host context). Also unlocks the webview-level `geolocation` permission request (allowed iff this grant is held, app-sandbox.js:9915-9921). Deliberately **no watchPosition**.
- **Extra gates:** none.
- **How to request:** manifest and/or runtime; part of the web-app launch prompt set (bootstrap:238).
- **Working example:**
  ```js
  const pos = await novaOS.geolocation.getCurrentPosition();
  console.log(pos.coords.latitude, pos.coords.longitude);
  ```
- **What the user sees:** standard dialog — "Access location" · reason · Risk · HIGH · device.
- **On denial:** app runs; `nova:device:geolocation` rejects with `PERMISSION_DENIED`; browser-level geolocation in the guest is denied too; position failures give `GEOLOCATION_ERROR`.
- **Limits tied to this permission:** none documented.
- **Overlap guidance:** none — standalone.

### `device:camera` — Risk: critical — Category: device
- **User-visible label:** "Access camera"
- **What it unlocks:** `nova:device:camera` — an **authorization-only** probe returning `{success, authorized:true}`; the stream itself is obtained guest-side via `getUserMedia`. Facades: `novaOS.media.checkCamera()` (→ true / rejects `PERMISSION_DENIED`), `nova.getUserMedia({video:true})`, `novaOS.media.getUserMedia`. The browser-level `media` permission request is allowed if camera **OR** microphone is granted (ANY-of, app-sandbox.js:9923-9934).
- **Extra gates:** `media.getUserMedia({})` with no constraints rejects with `TypeError` before any IPC.
- **How to request:** manifest and/or runtime; part of the web-app launch prompt set (bootstrap:238).
- **Working example:**
  ```js
  if (await novaOS.media.checkCamera()) {
    const stream = await novaOS.media.getUserMedia({ video: true });
  }
  ```
- **What the user sees:** standard dialog — "Access camera" · reason · Risk · CRITICAL · device.
- **On denial:** app runs; `nova:device:camera` rejects with `PERMISSION_DENIED`; the media gate denies the browser request, so `getUserMedia` cannot open a camera.
- **Limits tied to this permission:** none documented.
- **Overlap guidance:** with `device:microphone` — the browser media gate accepts either, but the app-level probes are per-device; request exactly the devices you use.

### `device:microphone` — Risk: critical — Category: device
- **User-visible label:** "Access microphone"
- **What it unlocks:** `nova:device:microphone` — authorization-only probe; facades `novaOS.media.checkMicrophone()`, `nova.getUserMedia({audio:true})`, `novaOS.media.getUserMedia`. Shares the ANY-of browser media gate with camera.
- **Extra gates:** same TypeError on empty constraints.
- **How to request:** manifest and/or runtime; part of the web-app launch prompt set (bootstrap:238).
- **Working example:**
  ```js
  const stream = await nova.getUserMedia({ audio: true });
  ```
- **What the user sees:** standard dialog — "Access microphone" · reason · Risk · CRITICAL · device.
- **On denial:** app runs; `nova:device:microphone` rejects with `PERMISSION_DENIED`; the guest media gate denies audio capture.
- **Limits tied to this permission:** none documented.
- **Overlap guidance:** see `device:camera`.

### `clipboard:read` — Risk: high — Category: device
- **User-visible label:** "Read clipboard"
- **What it unlocks:** `nova:clipboard:read` — facade `novaOS.clipboard.readText()` → text or `null`.
- **Extra gates:** none.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  const text = await novaOS.clipboard.readText();   // string | null
  ```
- **What the user sees:** standard dialog — "Read clipboard" · reason · Risk · HIGH · device.
- **On denial:** app runs; `nova:clipboard:read` rejects with `PERMISSION_DENIED` (the Terminal app surfaces this as 'Paste failed: Clipboard read unavailable', terminal.test.js:417).
- **Limits tied to this permission:** no rate limit documented for the channel; host-side clipboard history is capped at 30 entries (`CLIPBOARD_HISTORY_MAX`, app-sandbox.js:214).
- **Overlap guidance:** independent of `clipboard:write`; rated high because the clipboard is a shared, ambient, cross-app channel.

### `clipboard:write` — Risk: low — Category: device
- **User-visible label:** "Write clipboard"
- **What it unlocks:** `nova:clipboard:write` — facade `novaOS.clipboard.writeText(text)`.
- **Extra gates:** none.
- **How to request:** manifest declaration is auto-granted at launch with no dialog; runtime request shows the standard dialog.
- **Working example:**
  ```js
  await novaOS.clipboard.writeText('copied from MyApp');
  ```
- **What the user sees:** no dialog at launch; runtime request shows "Write clipboard" with the standard anatomy.
- **On denial:** app runs; `nova:clipboard:write` rejects with `PERMISSION_DENIED`.
- **Limits tied to this permission:** none documented.
- **Overlap guidance:** the safe sibling of `clipboard:read`; request it alone for copy buttons.

### data (3)

### `data:export` — Risk: low — Category: data
- **User-visible label:** "Export this app’s data"
- **What it unlocks:** `nova:data:export` and `nova:data:import` — facades `nova.data.export(options)` / `nova.data.import(envelope)` and `novaOS.data.export/import`. Envelope `{novaDataEnvelope:1, format:1, kind:'export', appId, capturedAt, storage, counts, checksum}` with a sha256 checksum over key-sorted storage. Strictly **caller-scoped**: restore/import refuse any envelope whose `appId` is not the caller's (`POLICY_BLOCKED` 'envelope belongs to a different app — envelopes only restore into their own app').
- **Extra gates:** export requires a `keys` array or a `prefix` string (else `INVALID_ARGS`); import is **merge-only** — it never deletes keys it doesn't contain.
- **How to request:** manifest declaration is auto-granted at launch with no dialog; runtime request shows the standard dialog.
- **Working example:**
  ```js
  const envelope = await nova.data.export({ keys: ['settings', 'notes'] });
  // later, possibly on a new install of the SAME app:
  await nova.data.import(envelope);
  ```
- **What the user sees:** no dialog at launch; runtime request shows "Export this app’s data" with the standard anatomy.
- **On denial:** app runs; both channels reject with `PERMISSION_DENIED` (MAC-gated, app-sandbox.data-portability.test.js:150). Tampered envelopes give `INVALID_ARGS` 'envelope checksum mismatch — the data is corrupt or was modified'.
- **Limits tied to this permission:** `keys` limited to **1000 entries per export** ('keys is limited to 1000 entries per export').
- **Overlap guidance:** vs `data:backup` — export/import is partial and merge-only; backup/restore is the full-namespace snapshot with optional wipe. Same blast radius (own data only).

### `data:backup` — Risk: low — Category: data
- **User-visible label:** "Back up and restore this app’s data"
- **What it unlocks:** `nova:data:backup` and `nova:data:restore` — facades `nova.data.backup()` / `nova.data.restore(envelope, options)` and `novaOS.data.backup/restore`. Full snapshot into a `kind:'backup'` checksummed envelope; `clearFirst: true` wipes the app's own namespace before restoring; per-key failures are reported in `failedKeys` instead of failing the call.
- **Extra gates:** envelope kind must be `backup`; same appId pinning and checksum validation as export.
- **How to request:** manifest declaration is auto-granted at launch; runtime request shows the standard dialog.
- **Working example:**
  ```js
  const snapshot = await nova.data.backup();
  await nova.data.restore(snapshot, { clearFirst: true });
  ```
- **What the user sees:** no dialog at launch; runtime request shows "Back up and restore this app’s data" with the standard anatomy.
- **On denial:** app runs; both channels reject with `PERMISSION_DENIED`.
- **Limits tied to this permission:** restored values are subject to the per-value **5 MB** cap (`failedKeys` entries carry the byte-limit reason).
- **Overlap guidance:** see `data:export`.

### `secrets:store` — Risk: medium — Category: data
- **User-visible label:** "Securely store passwords and tokens"
- **What it unlocks:** the encrypted per-app credential store — `nova:secrets:set`, `nova:secrets:get` (returns plaintext), `nova:secrets:delete`, `nova:secrets:keys` (key names only). Facade `novaOS.secrets.{set, get, delete, keys}`. AES-256-GCM at rest with a 32-byte master key; **never** included in backup/export envelopes; Settings shows counts only, never values.
- **Extra gates:** none.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  await novaOS.secrets.set('api_key', 's3cr3t-token');
  const key  = await novaOS.secrets.get('api_key');   // plaintext | null
  const keys = await novaOS.secrets.keys();           // sorted names
  ```
- **What the user sees:** standard dialog — "Securely store passwords and tokens" · reason · Risk · MEDIUM · data.
- **On denial:** app runs; all four channels reject with `PERMISSION_DENIED`. Budget violations give `INVALID_ARGS` (key/value shape) or `RATE_LIMITED` 'Max 64'.
- **Limits tied to this permission:** **64 secrets per app** (65th → `RATE_LIMITED` 'Max 64'; replacement at cap allowed); **8 KB per value** (UTF-8 bytes); **128-char keys**; invalid keys (empty, untrimmed, control chars) rejected with `INVALID_ARGS`.
- **Overlap guidance:** none — this is the only sanctioned secret storage; don't roll your own in `nova:storage`.

### apps (1)

### `apps:communicate` — Risk: high — Category: apps
- **User-visible label:** "Communicate with other apps"
- **What it unlocks:** the app-to-app IPC family — `nova:ipc:register`, `nova:ipc:unregister`, `nova:ipc:invoke`, `nova:ipc:reply`, `nova:ipc:broadcast:subscribe`, `nova:ipc:broadcast` (the MAC table gates all six; `nova:ipc:broadcast:unsubscribe` is advisory). Facades: `nova.ipc.provide(endpoint, handler)`, `nova.ipc.call(targetAppId, endpoint, data)`, `nova.ipc.broadcast(action, data)`, `nova.ipc.onBroadcast(action, cb)`.
- **Extra gates:** endpoints must match `^(?:service|provider):[a-z0-9][a-z0-9._-]{0,127}$` **and** be declared in your manifest's `ipc.exports`; broadcast receive actions must be declared in `manifest.ipc.receives`; the **target app must also hold `apps:communicate`** and have the endpoint live-registered.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  // manifest: "ipc": { "exports": ["service:notes"] }
  await nova.ipc.provide('service:notes', async (data) => {
    return { ok: true, note: data.note };
  });
  ```
- **What the user sees:** standard dialog — "Communicate with other apps" · reason · Risk · HIGH · apps.
- **On denial:** app runs; all six channels reject with `PERMISSION_DENIED` 'apps:communicate permission required'; undeclared endpoints give `PERMISSION_DENIED` 'Endpoint is not declared in manifest.ipc.exports' / 'Broadcast action must be declared in manifest.ipc.receives'.
- **Limits tied to this permission:** **20 calls per 60 s** per `(appId:type)` key for invoke and broadcast ('Max 20 app IPC calls per minute', 'Max 20 app broadcasts per minute'); payloads clamped to the ledger `ipcPayloadBytes` budget (**256 KB** default; legacy 64 KB); call timeout **25 s** ('Target app did not respond before the IPC timeout'); reply error strings truncated to 500 chars.
- **Overlap guidance:** none — this is the only cross-app channel; `nova:share` (user-mediated) needs no grant.

### system (16)

### `system:info` — Risk: medium — Category: system
- **User-visible label:** "System information"
- **What it unlocks:** `nova:system:info` → `{os: {version, securityPatch, username, uptime}}` (note: `username` is exposed to any holder) and `nova:settings:get` — the `SETTINGS_READABLE_KEYS` allowlist (username, region, timezone, `devMode`, `browserPartitionId`, and ~24 more real settings values). Facade: `novaOS.settings.get(key)` → stored value or `undefined`.
- **Extra gates:** none.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  const info = await nova.ipc('nova:system:info', {});
  const tz = await novaOS.settings.get('timezone');
  ```
- **What the user sees:** standard dialog — "System information" · reason · Risk · MEDIUM · system.
- **On denial:** app runs; both channels reject with `PERMISSION_DENIED` (e.g. `nova:settings:get` handler check, app-sandbox.js:2958-2960).
- **Limits tied to this permission:** none documented.
- **Overlap guidance:** read-only; changing settings needs `system:settings`. `nova:locale:get` needs no permission at all.

### `system:settings` — Risk: medium — Category: system
- **User-visible label:** "System settings"
- **What it unlocks:** `nova:settings:set` — facade `novaOS.settings.set(key, value)`.
- **Extra gates:** `SETTINGS_WRITABLE_KEYS` excludes `osVersion` and `devMode` (app-sandbox.js:2951-2953); setting `rootAccessEnabled` rejects with `PERMISSION_DENIED` (real-use.suite.js:978-979); credential keys are unreachable from the facade. The wallpaper keys enjoy a documented exemption — `customWallpaper`/`wallpaperId` are settable through `nova:settings:set` **without** this grant (app-sandbox.test.js:3821), and `nova:wallpaper:set` is ungated entirely (subject to `POLICY_BLOCKED` when `prohibitWallpaperChange` is set).
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  await novaOS.settings.set('clockFormat', '24h');
  ```
- **What the user sees:** standard dialog — "System settings" · reason · Risk · MEDIUM · system.
- **On denial:** app runs; `nova:settings:set` rejects with `PERMISSION_DENIED` for non-exempt keys.
- **Limits tied to this permission:** none documented.
- **Overlap guidance:** for appearance changes prefer the ungated `nova:appearance:set` (allowlisted public keys, 10/min) — no grant needed.

### `system:apps` — Risk: medium — Category: system
- **User-visible label:** "Manage apps"
- **What it unlocks:** `nova:app:list` (full inventory: id, name, version, icon, categories, verified, signer, devOnly, source; manifest reduced to `{system}`), `nova:app:install` (takes a parsed package `{manifest, files, signature, integrity}`; fails closed with `MALICIOUS_PACKAGE` / `SCAN_FAILED` / `UNVERIFIED` / `TAMPERED` / `UNTRUSTED` / `ALREADY_INSTALLED`), `nova:app:uninstall` (self-uninstall refused; built-ins `NOT_UNINSTALLABLE`; runs the full cleanup chain including `revokeAllPermissions`), and `nova:app:openDefaultAppsSettings`. It is also an **acceptable alternative** to `system:app-launch` for `nova:app:launch` (ANY-of row). Facades: `nova.apps.{list, install, uninstall, openDefaultAppsSettings}`, `novaOS.app.list()`.
- **Extra gates:** none beyond the grant.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  const apps = await nova.apps.list();
  ```
- **What the user sees:** standard dialog — "Manage apps" · reason · Risk · MEDIUM · system.
- **On denial:** app runs; all four channels reject with `PERMISSION_DENIED`.
- **Limits tied to this permission:** `nova:app:openDefaultAppsSettings` is rate-limited to **12 per 60 s** (`DEFAULT_APPS_RATE_LIMIT_MAX`); no rate limit on `app:list`; app icons capped at 700,000 data-URI chars.
- **Overlap guidance:** vs `system:app-launch` — `system:apps` is the manager grant (inventory + install/uninstall) and also satisfies the launch channel; if you only open other apps, request the low-risk `system:app-launch` instead.

### `system:app-launch` — Risk: low — Category: system
- **User-visible label:** "Launch installed apps"
- **What it unlocks:** `nova:app:launch` — facades `nova.app.launch(appId, options)`, `nova.apps.launch`, `novaOS.app.launch`. The MAC row is ANY-of `['system:app-launch','system:apps']`, so **either** grant opens the channel; sibling that also works: `system:apps`. File intents are stripped from app-requested cross-app launches (only the user/WM can attach them). The Home surface has separate, grant-free flows (`nova:home:apps:launch` is restricted to the active Home app, which may always open Settings and App Manager).
- **Extra gates:** none.
- **How to request:** manifest declaration is auto-granted at launch with no dialog; runtime request shows the standard dialog.
- **Working example:**
  ```js
  await nova.app.launch('com.example.viewer', {});
  ```
- **What the user sees:** no dialog at launch; runtime request shows "Launch installed apps" with the standard anatomy.
- **On denial:** app runs; `nova:app:launch` rejects with `PERMISSION_DENIED`.
- **Limits tied to this permission:** **30 cross-app launches per 60 s**, the 31st → `RATE_LIMITED` (app-sandbox.test.js:2446-2471).
- **Overlap guidance:** see `system:apps` — prefer this narrow grant unless you actually manage installs.

### `system:root` — Risk: critical — Category: system
- **User-visible label:** "Unrestricted OS access (Root)"
- **What it unlocks:** no `nova:*` channel — the app's `unrestrictedEntry` script executes **directly in the OS host page** (not its sandbox), with access to host globals (`OS`, `FS`, `WM`, …). Runtime privileged operations additionally go through the NovaRoot broker (audited, passwordless sudo). Root API calls are recorded in an audit log surfaced in Settings (up to 1,000 recent calls retained).
- **Extra gates:** all of the following:
  1. Manifest must declare `permissions: ["system:root"]` **and** package an `unrestrictedEntry` file — enforced at package creation and install (app-package.js:527-529, :605-609).
  2. Device: **Developer Mode AND Root Access** both enabled (`HKNS/system/devMode` + `HKNS/security/rootAccessEnabled`; apps cannot set either — `rootAccessEnabled` writes reject `PERMISSION_DENIED`). With Root Access off, `requestPermission('system:root')` auto-denies and `isGranted` is always false (app-permission-manager.js:635-643, :779).
  3. User: explicit consent dialog with the mandatory acknowledgement checkbox; Allow is renamed "Grant Root Access" and disabled until checked.
  4. If the package is not System-signed: the **UNVERIFIED PUBLISHER** banner (see section 2).
  5. `grantPermission('system:root')` is programmatically impossible — "Root access must be granted through its explicit confirmation prompt" (app-permission-manager.js:935-937).
  6. In multi-user, root broker ops additionally require an admin session (root-broker.js:161-177).
- **How to request:** manifest declaration + the user flips the per-app toggle in Settings → Developer (which routes through the same consent dialog), or a runtime `requestPermission` when Root Access is already on. Never auto-granted; never implied.
- **Working example:**
  ```js
  // unrestrictedEntry.js — runs in the OS host page, not the sandbox.
  // Host APIs are directly reachable (calls are audit-wrapped):
  OS.settings.set('theme', 'nord');
  ```
- **What the user sees:** red-bordered dialog: "Unrestricted OS access (Root)" — Requested by **{appName}** · reason · Risk · CRITICAL · system · the root warning block · mandatory checkbox · "Grant Root Access" (Enter = Allow). Unverified packages additionally get the UNVERIFIED PUBLISHER banner.
- **On denial:** app runs sandboxed like any other app; root execution is simply unavailable. The grant is also **never removed by the 30-day sweep** — revocation is explicit (Settings toggle or uninstall), and revoking reloads root apps out of the host page immediately (`reloadAfterRootRevocation`).
- **Limits tied to this permission:** audit log capped at 1,000 entries; note the OS admits observability limits ("Root API calls are recorded, but direct JavaScript and browser activity cannot be completely observed").
- **Overlap guidance:** none — the terminal grant. Everything else on this page works inside the sandbox; prefer any narrower permission that covers the need.

### `system:events` — Risk: medium — Category: system
- **User-visible label:** "System events"
- **What it unlocks:** `nova:events:subscribe` (advisory MAC row; the handler is the boundary) for the **9 sensitive event names**: `system:notification`, `app:installed`, `app:uninstalled`, `app:launched`, `mail:new`, `mail:updated`, `calendar:reminder`, `calendar:updated`, `contacts:updated`. Facades: `nova.onEvent(name, cb)`, `novaOS.events.on(name, cb)` / `subscribe(name)`. Benign names (`system:themeChanged`, `system:volumeChanged`, `system:workspaceChanged`, `system:power`, `system:network`) are subscribable with no grant; `app:launched` without the grant rejects with `PERMISSION_DENIED` (app-sandbox.test.js:2476).
- **Extra gates:** domain events are **ALL-of** — `system:events` **plus** the domain read grant: `mail:*` → `mail:read`; `calendar:*` → `calendar:read`; `contacts:updated` → `contacts:read`; `nova:net:ws:*` → `net:websocket`; `nova:reg:changed` → `registry.read` (app-sandbox.js:6080-6095).
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  const off = await nova.onEvent('app:launched', (evt) => {
    console.log('launched:', evt.data);
  });
  ```
- **What the user sees:** standard dialog — "System events" · reason · Risk · MEDIUM · system.
- **On denial:** app runs; subscribing to a sensitive name rejects with `PERMISSION_DENIED`; names outside the 17-entry allowlist give `INVALID_ARGS` 'Event 'X' is not in the subscribable allowlist'.
- **Limits tied to this permission:** one subscription per event per sandbox (`ALREADY_SUBSCRIBED`); WS push events are filtered so subscribers only hear their own sockets.
- **Overlap guidance:** pair with the domain grant you actually need (e.g. `mail:read` for `mail:new`); theme-only apps need no grant at all.

### `system:background` — Risk: medium — Category: system
- **User-visible label:** "Run scheduled background tasks"
- **What it unlocks:** no guest request channel — it gates **host-initiated scheduled wake-ups**: `AppScheduler` sweeps every **15 minutes**, launches eligible granted apps into a headless background sandbox, and pushes `nova:background:wake` with a `{wokeAt, deadlineMs: 10000}` payload. Also rung 2 of the push delivery ladder: when a push arrives for a closed app holding `push:receive` + `system:background`, the scheduler wakes it via `requestWake`. Facades: `nova.onBackgroundWake(cb)` / `novaOS.background.onWake(cb)` to receive the wake, `nova.backgroundWakeDone()` / `novaOS.background.wakeDone()` to finish early.
- **Extra gates:** disabled apps and apps without the grant are never woken (`requestWake` reports false for every ineligible case).
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  nova.onBackgroundWake(async (wake) => {
    await syncNow();                 // you have ~10 s (deadlineMs)
    nova.backgroundWakeDone();
  });
  ```
- **What the user sees:** standard dialog — "Run scheduled background tasks" · reason · Risk · MEDIUM · system.
- **On denial:** app runs; it is simply never scheduled — `requestWake` for it returns false and nothing is dispatched.
- **Limits tied to this permission:** wake sweep every 15 min; wake deadline **10 s** (the scheduler tears down its owned sandbox when it expires); one wake at a time per sandbox.
- **Overlap guidance:** vs `system:background:live` and `system:autostart` — three independent grants: brief scheduled wake-ups vs staying alive after close vs launching at boot. Request the smallest that matches the feature.

### `system:background:live` — Risk: high — Category: system
- **User-visible label:** "Keep running after you close it"
- **What it unlocks:** `nova:background:stay-alive` — facades `nova.stayAliveInBackground(enabled)` and `novaOS.background.stayAlive(enabled)` → `{enabled}`. Lets the sandbox keep running after the user closes its window (detached background process).
- **Extra gates:** the grant alone is not enough — it is a **per-session opt-in**: the app must call `stayAlive(true)` each launch (the flag is session-only, `wantsBackgroundLive`).
- **How to request:** grant via manifest/runtime, then assert at runtime with `stayAlive(true)`.
- **Working example:**
  ```js
  const res = await novaOS.background.stayAlive(true);   // { enabled: true }
  ```
- **What the user sees:** standard dialog — "Keep running after you close it" · reason · Risk · HIGH · system.
- **On denial:** app runs; `stayAlive` rejects with `PERMISSION_DENIED` and the sandbox is destroyed when its window closes.
- **Limits tied to this permission:** session-scoped (no persistence of the opt-in); wake-cycle deadlines from `system:background` do not apply to live sandboxes.
- **Overlap guidance:** see `system:background` — a live process consumes resources indefinitely; prefer scheduled wake-ups when brief work suffices.

### `system:autostart` — Risk: high — Category: system
- **User-visible label:** "Start automatically when NovaByte starts"
- **What it unlocks:** no IPC channel — it gates being **launched automatically at OS boot/login** (boot list persisted at `HKNU/apps/boot`, legacy `nova_boot_apps`). The catalog calls it "a bigger trust ask than either background tier" (app-permission-manager.js:67-70).
- **Extra gates:** the app must also be on the boot list (Settings/App Manager).
- **How to request:** manifest and/or runtime; there is no app-callable API — the OS acts on it.
- **Working example:**
  ```js
  // No gated API exists. Declare in the manifest and handle a cold
  // launch: check how you were started via nova.app.getLaunchOptions().
  const opts = await nova.app.getLaunchOptions();
  ```
- **What the user sees:** standard dialog — "Start automatically when NovaByte starts" · reason · Risk · HIGH · system.
- **On denial:** app runs normally when launched manually; it is simply not started at boot.
- **Limits tied to this permission:** none documented.
- **Overlap guidance:** see `system:background` — autostart is unconditional boot launch, distinct from wake-ups and stay-alive.

### `system:badge` — Risk: low — Category: system
- **User-visible label:** "Show a badge on the taskbar"
- **What it unlocks:** `nova:badge:set` and `nova:badge:clear` — facade `novaOS.badge.set(value)` (number → `{count}`, object passthrough) and `novaOS.badge.clear()`. Purely presentational, scoped to the app's own taskbar icon; badge state is session-only (read-only global `window.NovaAppBadges`).
- **Extra gates:** none.
- **How to request:** manifest declaration is auto-granted at launch with no dialog; runtime request shows the standard dialog.
- **Working example:**
  ```js
  await novaOS.badge.set(7);              // numeric count
  await novaOS.badge.set({ text: 'NEW' }); // 1–4 char label
  await novaOS.badge.clear();
  ```
- **What the user sees:** no dialog at launch; runtime request shows "Show a badge on the taskbar" with the standard anatomy.
- **On denial:** app runs; badge channels reject with `PERMISSION_DENIED`.
- **Limits tied to this permission:** **30 badge updates per minute** (`RATE_LIMITED` 'Max 30 badge updates per minute'); count 0–999 (0 clears); text 1–4 chars after trim.
- **Overlap guidance:** none — safe to add alongside `device:notifications` for unread counters.

### `system:schedule` — Risk: medium — Category: system
- **User-visible label:** "Schedule named alarms"
- **What it unlocks:** `nova:alarms:create`, `nova:alarms:clear`, `nova:alarms:getAll` — facades `novaOS.alarms.{create, clear, getAll}` plus the `onAlarm(cb)` push (`nova:background:alarm`, delivered live or queued-after-launch). Alarms persist host-side (registry-first, `HKNS/apps/alarms`) and **never self-launch**: a fire while fully closed only queues a bounded push for the next launch.
- **Extra gates:** name 1–64 chars matching `/^[\w.:\-]+$/`; exactly one of `when` (future epoch-ms, at most 1 year out) or `periodMinutes` (≥ 15).
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  await novaOS.alarms.create({ name: 'digest', periodMinutes: 30 });
  novaOS.alarms.onAlarm(({ name }) => refresh(name));
  ```
- **What the user sees:** standard dialog — "Schedule named alarms" · reason · Risk · MEDIUM · system.
- **On denial:** app runs; all three channels reject with `PERMISSION_DENIED`; `INVALID_ARGS` messages quote the name/when/period constraints.
- **Limits tied to this permission:** **32 alarms per app** (`RATE_LIMITED` 'Max 32 alarms per app'); missed one-shot queue bounded at 8; periodic alarms skip missed cycles.
- **Overlap guidance:** vs `system:background` — alarms fire pushes into the app (host-side timers, no process between fires); `system:background` is for scheduler-owned wake work. They compose but do not imply each other.

### `system:share-target` — Risk: medium — Category: system
- **User-visible label:** "Receive shared content"
- **What it unlocks:** inbound share delivery — the host pushes `nova:share:inbound` with `{title, text, url, sourceAppId, firedAt, queued?}` when the user picks your app in the share sheet. Facade: `novaOS.share.onInbound(callback)`. `deliverShareTarget` re-checks this grant on **every** share; without it delivery returns `{delivered:false, reason:'PERMISSION_DENIED'}`.
- **Extra gates:** the manifest must declare a `shareTarget` with the accepted MIME types (matching supports `*/*` and `type/*`); the user's pick in the sheet **is** the consent.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  novaOS.share.onInbound((share) => {
    importNote(share.title, share.text);   // from sourceAppId
  });
  ```
- **What the user sees:** standard dialog — "Receive shared content" · reason · Risk · MEDIUM · system.
- **On denial:** app runs; it is not offered in the share sheet and deliveries bounce with `PERMISSION_DENIED`.
- **Limits tied to this permission:** inbound queue bounded at 8 (flushed after the next `nova:ready`); inbound `title` clamped to 120 chars, `text` to 4000.
- **Overlap guidance:** outbound sharing (`nova.share(data)`, `nova:share`) needs **no** permission — only receiving does.

### `push:receive` — Risk: medium — Category: system
- **User-visible label:** "Receive push messages from its own server"
- **What it unlocks:** the request channels `nova:push:register` / `nova:push:unregister` — facade `novaOS.push.register()` → `{success, token, endpoint:'/api/push/publish', queued, replaced, subscribed}` (token `nps_` + 32 hex chars, idempotent) and `unregister()`. The **inbound** direction (`nova:push:message`) is a host→guest push, not a request channel: the OS owns the single SSE connection (`/api/push/stream`) and the delivery ladder re-checks this grant and the disabled list on **every** message before the app sees one. Facade: `novaOS.push.onMessage(cb)`.
- **Extra gates:** delivery ladder: rung 1 live sandbox push; rung 2 needs `system:background` (scheduler wake); rung 3 OS-attributed notification (same sanitizer and 10/min budget as app-posted); rung 4 data always queued (bounded 8). The server must confirm every subscription.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  const { token, endpoint } = await novaOS.push.register();
  // hand token + endpoint to YOUR backend; it POSTs to /api/push/publish
  novaOS.push.onMessage((msg) => render(msg));
  ```
- **What the user sees:** standard dialog — "Receive push messages from its own server" · reason · Risk · MEDIUM · system.
- **On denial:** app runs; `register`/`unregister` reject with `PERMISSION_DENIED` and no message is ever delivered or queued.
- **Limits tied to this permission:** message queue 8; title ≤ 200; body ≤ 2000; `data` ≤ 4096 bytes; id ≤ 64; reconnect backoff 1/2/5/15 s; notification-rung display bounded by the 10/min notification budget.
- **Overlap guidance:** for notifications while open, `device:notifications` alone is enough; `push:receive` is specifically for server-initiated delivery (including while closed, via rungs 2–4).

### `registry.read` — Risk: low — Category: system
- **User-visible label:** "Read the NovaByte Registry"
- **What it unlocks:** `nova:reg:get`, `nova:reg:list`, `nova:reg:export` — facades `novaOS.registry.get(path)` (value or `undefined`), `stat(path)` (`{found, type, data}`), `list(path)`, `export(path)`, and `watch(path, cb)` (sugar over the `nova:reg:changed` event with a guest-side prefix filter). Absent keys read as `{found:false, path}`; a value path lists as a leaf. Subscribing to `nova:reg:changed` events requires this grant plus `system:events`.
- **Extra gates:** the `HKNS/security` subtree is blocked without `registry.system`; per-key ACLs apply ('ACL denies read'; `*` wildcard grants exist).
- **How to request:** manifest declaration is auto-granted at launch with no dialog; runtime request shows the standard dialog.
- **Working example:**
  ```js
  const v = await novaOS.registry.get('HKNU/settings/fontSize');
  const hit = await novaOS.registry.stat('HKNS/shell/theme');
  ```
- **What the user sees:** no dialog at launch; runtime request shows "Read the NovaByte Registry" with the standard anatomy.
- **On denial:** app runs; all read channels reject with `PERMISSION_DENIED` (MAC front door, novareg-sandbox.test.js:86).
- **Limits tied to this permission:** engine quotas: path depth ≤ 16, names ≤ 64 chars, values ≤ 256 KB (`QUOTA_EXCEEDED`).
- **Overlap guidance:** vs `registry.write`/`registry.system` — request read alone for config-consuming apps; read never implies write.

### `registry.write` — Risk: medium — Category: system
- **User-visible label:** "Store settings in the NovaByte Registry"
- **What it unlocks:** `nova:reg:set`, `nova:reg:delete`, `nova:reg:import` — facades `novaOS.registry.set(path, value, type)`, `remove(path, {recursive})`, `import(path, data)`. Committed writes emit `nova:reg:changed` and record the calling app id as the audit actor.
- **Extra gates:** apps write **only their own `HKNA/<appId>/` subtree** (foreign `HKNA` and the `HKNA` root reject `PERMISSION_DENIED`); `HKNS` writes need a system app; `HKNU` needs `registry.system`; `HKND` needs Developer Mode. A scope-less manifest gets one built-in extra write scope `HKNU/software/<appId>`; explicit `registryScopes.write` prefixes (HKNU only) replace the default.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  await novaOS.registry.set('HKNA/com.example.notes/theme', 'dark');
  ```
- **What the user sees:** standard dialog — "Store settings in the NovaByte Registry" · reason · Risk · MEDIUM · system.
- **On denial:** app runs; write channels reject with `PERMISSION_DENIED` (read does not imply write, novareg-sandbox.test.js:132).
- **Limits tied to this permission:** same engine quotas as reads (depth 16 / name 64 / value 256 KB); subtree deletes need `recursive:true` else `SUBTREE_NOT_EMPTY`.
- **Overlap guidance:** see `registry.read` and `registry.system` — this is the quota'd own-namespace tier; system-wide configuration is `registry.system`.

### `registry.system` — Risk: critical — Category: system
- **User-visible label:** "Full Registry access, including system keys"
- **What it unlocks:** no separate channel — it **extends the reach** of the `registry.read` and `registry.write` grants: the `HKNS/security` subtree becomes readable/writable, `HKNU` (other users' hives) becomes writable, and per-key ACLs are bypassed. The catalog calls it "effectively root for configuration" (app-permission-manager.js:129-135).
- **Extra gates:** none beyond the consent; note that machine policy at `HKNS/security/policy/appPolicy/<appId>` is itself registry data a holder can write (a documented escalation-shaped trade-off).
- **How to request:** manifest and/or runtime (dialog consent; critical tier).
- **Working example:**
  ```js
  await novaOS.registry.set(
    'HKNS/security/policy/prohibitWallpaperChange', 1, 'REG_DWORD');
  ```
- **What the user sees:** standard dialog — "Full Registry access, including system keys" · reason · Risk · CRITICAL · system.
- **On denial:** app runs; reads/writes stay confined to the `registry.read`/`registry.write` rules (`HKNS/security` still blocked).
- **Limits tied to this permission:** same engine quotas (depth 16 / name 64 / value 256 KB; audit ring 500; 3 snapshots per hive).
- **Overlap guidance:** the widest registry tier — request only for administration tooling; everything else is covered by read/write.

### admin (4)

All four `admin:*` permissions share one extra gate layer: the grant itself requires an **admin-role session** when multi-user is on (app-permission-manager.js:647-649, :672-676), and server-mediated `/api` calls additionally need the machine **Admin Access** flag (Settings → Privacy; "Lets apps you've granted admin permissions to … actually use them"). The facades note the dual gate explicitly (app-sandbox.js:11837-11840). On single-user machines the client-side session check passes for everyone — the grant (and the server flag) is then the effective gate.

### `admin:apps` — Risk: high — Category: admin
- **User-visible label:** "Manage apps (admin)"
- **What it unlocks:** `nova:admin:apps` — facades `nova.admin.appsList()` / `novaOS.admin.appsList()`.
- **Extra gates:** admin session + Admin Access flag (see above).
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  const managed = await nova.admin.appsList();
  ```
- **What the user sees:** standard dialog — "Manage apps (admin)" · reason · Risk · HIGH · admin.
- **On denial:** app runs; `nova:admin:apps` rejects with `PERMISSION_DENIED`.
- **Limits tied to this permission:** none documented on the channel.
- **Overlap guidance:** vs `system:apps` — `admin:apps` is the administrative surface (admin-session gated), `system:apps` the per-user manager; don't request both unless you build an admin console.

### `admin:users` — Risk: critical — Category: admin
- **User-visible label:** "Manage users"
- **What it unlocks:** `nova:admin:users` with actions `list` and `revoke` (session revocation) — facades `nova.admin.usersList()` / `nova.admin.usersRevoke(sessionId)` and the `novaOS.admin` mirrors.
- **Extra gates:** admin session + Admin Access flag.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  const users = await nova.admin.usersList();
  await nova.admin.usersRevoke('sess_123');
  ```
- **What the user sees:** standard dialog — "Manage users" · reason · Risk · CRITICAL · admin.
- **On denial:** app runs; `nova:admin:users` rejects with `PERMISSION_DENIED`.
- **Limits tied to this permission:** none documented on the channel.
- **Overlap guidance:** the most destructive admin grant; request only for user-management tooling.

### `admin:system` — Risk: critical — Category: admin
- **User-visible label:** "System administration"
- **What it unlocks:** `nova:admin:system` with actions `get` and `set` — facades `nova.admin.systemGet()` / `nova.admin.systemSet(settings)` and the `novaOS.admin` mirrors.
- **Extra gates:** admin session + Admin Access flag.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  const state = await nova.admin.systemGet();
  await nova.admin.systemSet({ maintenance: true });
  ```
- **What the user sees:** standard dialog — "System administration" · reason · Risk · CRITICAL · admin.
- **On denial:** app runs; `nova:admin:system` rejects with `PERMISSION_DENIED`.
- **Limits tied to this permission:** none documented on the channel.
- **Overlap guidance:** see `admin:apps`; system-wide administration is the broadest of the four.

### `admin:audit` — Risk: high — Category: admin
- **User-visible label:** "Audit logs"
- **What it unlocks:** `nova:admin:audit` — facade `nova.admin.auditQuery(filters)` / `novaOS.admin.auditQuery(filters)`.
- **Extra gates:** admin session + Admin Access flag.
- **How to request:** manifest and/or runtime.
- **Working example:**
  ```js
  const entries = await nova.admin.auditQuery({ limit: 50 });
  ```
- **What the user sees:** standard dialog — "Audit logs" · reason · Risk · HIGH · admin.
- **On denial:** app runs; `nova:admin:audit` rejects with `PERMISSION_DENIED`.
- **Limits tied to this permission:** none documented on the channel.
- **Overlap guidance:** read-only observation; the least destructive admin grant.

### sandbox (3)

### `sandbox:nested-webview` — Risk: critical — Category: sandbox
- **User-visible label:** "Embed live web content (nested browser view)"
- **What it unlocks:** `nova:nested-webview` (actions `create`, `command`, `bounds`, `destroy`, …) — a **second renderer process** your app controls: facades `nova.browser.createView(options)` (returns a `NovaBrowserView`) and the `<nova-nested-webview>` custom element (created via `document.createElement('webview')`, which is re-routed). Permitted nested views get a separate stable partition (`persist:app_<id>_webcontent`) and never inherit the app sandbox.
- **Extra gates:** double gate — an **opt-in** (manifest `allowNestedWebview: true`; declaring `sandbox:nested-webview` in `permissions` also marks the opt-in) **AND** the live user grant (`isNestedWebviewPermitted`, fail-closed, app-sandbox.js:9994-10001). Navigation inside the view is separately gated by `canNestedWebviewNavigate`: valid http/https URL, no embedded credentials, and the matching network grant (`net:internal`/`net:external` by destination). Non-opted-in apps get an inert `<span>` instead of a webview plus an audit entry.
- **How to request:** manifest `allowNestedWebview: true` (or the permission declaration) plus the grant via manifest prompt or runtime request.
- **Working example:**
  ```js
  // manifest: "allowNestedWebview": true
  const view = await nova.browser.createView({
    container: document.getElementById('browserPane')
  });
  view.navigate('https://example.com');
  ```
- **What the user sees:** standard dialog — "Embed live web content (nested browser view)" · reason · Risk · CRITICAL · sandbox.
- **On denial:** app runs; host-side `nova:nested-webview` calls reject with `PERMISSION_DENIED` (the facade surface still exists when opted in — enforcement is host-side, app-sandbox.test.js:1237). Live revocation removes nested views immediately (`NovaSystemWebview.revokeApp`).
- **Limits tied to this permission:** `pollingInterval` 0 or 250–10000 ms; bounds clamped to the viewport; annotation exports capped at 2,000,000 chars.
- **Overlap guidance:** vs the other `sandbox:*` grants — this one embeds content (new renderer); `sandbox:same-origin` widens storage reach; `sandbox:escape-popups` unsandboxes popups. Independent double-gates; request each only for the specific feature.

### `sandbox:same-origin` — Risk: high — Category: sandbox
- **User-visible label:** "Access shared cookies & storage"
- **What it unlocks:** no channel — it adds the `allow-same-origin` token to the sandbox attribute, giving the guest a real (non-opaque) origin with its **own cookies, localStorage, and sessionStorage on the shared origin**. The IPC bridge itself depends on the origin matching the parent.
- **Extra gates:** double gate — manifest `sandbox: { allowSameOrigin: true }` **AND** this grant (app-sandbox.js:13394-13396). Default token set otherwise: `allow-scripts allow-forms allow-popups allow-modals allow-downloads`.
- **How to request:** manifest flag + grant (manifest prompt or runtime request).
- **Working example:**
  ```js
  // Only meaningful with "sandbox": { "allowSameOrigin": true } in the
  // manifest AND the grant — otherwise storage is opaque/ephemeral:
  localStorage.setItem('session', 'abc');
  console.log(document.cookie);
  ```
- **What the user sees:** standard dialog — "Access shared cookies & storage" · reason · Risk · HIGH · sandbox.
- **On denial:** app runs fully sandboxed with an opaque origin (storage wiped per destroy cycle). Note: revocation closes the app's windows and queues a partition wipe; a grant **without** the manifest flag still gets its partition wiped on destroy (the effective attribute is what counts, app-sandbox.js:14461-14492).
- **Limits tied to this permission:** none specific; storage still lands under `persist:app_<appId>`.
- **Overlap guidance:** see `sandbox:nested-webview`; this grant only widens what an existing XSS in the guest can reach (rated high, not critical).

### `sandbox:escape-popups` — Risk: high — Category: sandbox
- **User-visible label:** "Open unrestricted popup windows"
- **What it unlocks:** no channel — it allows popups opened by the app to **escape the sandbox attribute** (`allow-popups-to-escape-sandbox` token; `allow-popups` is implied when escape is permitted). Popups render in an OS-owned overlay card sharing the app's persistent partition (the OAuth use case); consent is re-checked per popup at `newwindow` time, so a grant obtained after launch takes effect without relaunch.
- **Extra gates:** double gate — top-level manifest `allowPopupsToEscapeSandbox: true` (or the same flag nested under `manifest.allowPopupsToEscapeSandbox`); **listing `sandbox:escape-popups` in `permissions` explicitly does NOT count as the opt-in** (app-sandbox.js:9979-9992) — plus the live grant, checked fail-closed at popup time. An escape-capable popup without the live grant is **discarded**.
- **How to request:** manifest flag + grant (manifest prompt or runtime request).
- **Working example:**
  ```js
  // manifest: "allowPopupsToEscapeSandbox": true
  const a = document.createElement('a');
  a.href = 'https://accounts.example.com/oauth';
  a.target = '_blank';
  a.click();          // opens in the OS-owned overlay card
  ```
- **What the user sees:** standard dialog — "Open unrestricted popup windows" · reason · Risk · HIGH · sandbox.
- **On denial:** app runs; popups stay sandboxed (or are discarded if the attribute requested escape but the grant is missing); `about:blank`/`javascript:` targets are always discarded.
- **Limits tied to this permission:** popup width clamped to 360–75% of host, height 300–85%; popup console output shares the app's 40-lines/5 s serial budget.
- **Overlap guidance:** see `sandbox:nested-webview` — use this for OAuth/relay popups, nested-webview for embedded browsing.

---

## 5. Legacy `vfs:*` aliases

Five legacy permission names from the pre-fs era are still translated at runtime (`LEGACY_PERMISSION_ALIASES`, kept in sync in app-permission-manager.js:251-257 and app-registry.js:75-81):

| Legacy name | Translates to | Notes |
|---|---|---|
| `vfs:access` | `fs:access` | Lands on the special-access grant — "can never widen an old app's access silently" (app-registry.js:60-72) |
| `vfs:read` | `fs:access` | |
| `vfs:write` | `fs:access` | |
| `vfs:delete` | `fs:access` | |
| `vfs:metadata` | `fs:metadata` | |

Translation happens **both** at install/registration (app-registry.js:296-313, including `permissionReasons` keys) and at runtime `requestPermission()` (app-permission-manager.js:776), so a raw `nova:request-permission` with a `vfs:*` name cannot bypass normalization. Any other legacy spelling (e.g. the `vfs:metedata` typo) is stripped as unknown at install.

Separately — and unrelated to permissions — legacy **channel** aliases (`nova:vfs:read`, bare `vfs:*` spellings, and the `vfs:metedata` typo) are translated to the modern `nova:fs:*` channels at dispatch time ("translate-then-enforce", app-sandbox.js:9492-9564), so old apps take exactly the same enforcement path.

---

## 6. Consolidated quick-reference table

All 52 permissions. "Extra gates" beyond the consent dialog are abbreviated; see the full entries above.

| # | Permission | Category | Risk | User-visible label | Gated channels (short) | Extra gates |
|---|---|---|---|---|---|---|
| 1 | `fs:access` | filesystem | critical | Manage all files | `nova:fs:*` shared-tree paths, `nova:media:query`, sysdialog broadAccess | specialAccess — Settings toggle only, never prompts |
| 2 | `fs:metadata` | filesystem | medium | Read shared file metadata | `nova:fs:stat`/`list`, `nova:media:query`; fs:watch folder parity | — |
| 3 | `fs:watch` | filesystem | low | Get notified when your files change | `nova:fs:watch` | per-path read rules in handler |
| 4 | `fs:read:images` | filesystem | medium | Read shared images | `nova:fs:read`, `nova:media:query` (image MIME) | per-MIME handler rules |
| 5 | `fs:read:video` | filesystem | medium | Read shared videos | `nova:fs:read`, `nova:media:query` (video MIME) | per-MIME handler rules |
| 6 | `fs:read:audio` | filesystem | medium | Read shared audio | `nova:fs:read`, `nova:media:query` (audio MIME) | per-MIME handler rules |
| 7 | `apps:communicate` | apps | high | Communicate with other apps | `nova:ipc:register/unregister/invoke/reply/broadcast(+subscribe)` | manifest `ipc.exports`/`ipc.receives`; target must also hold it |
| 8 | `net:internal` | network | high | Internal network | `nova:net:fetch` (internal), `nova:net:websocket` (internal), nested-webview nav | — |
| 9 | `net:external` | network | low | Public internet access | `nova:net:fetch` (external), nested-webview nav | auto-granted to web apps |
| 10 | `net:websocket` | network | low | Public WebSocket connections | `nova:net:websocket` (+ advisory `ws:send`/`ws:close`); ws event bus | internal destinations also need `net:internal`; auto-granted to web apps |
| 11 | `mail:read` | email | high | Read emails | `nova:mail:read` | connected account required |
| 12 | `mail:write` | email | critical | Compose emails | `nova:mail:write`, `nova:mail:session` | connected account required |
| 13 | `mail:send` | email | critical | Send emails | `nova:mail:send` | connected account + `smtpHost` |
| 14 | `mail:delete` | email | critical | Delete emails | `nova:mail:delete` | connected account required |
| 15 | `calendar:read` | calendar | medium | Read calendar | `nova:calendar:read` | — |
| 16 | `calendar:write` | calendar | high | Edit calendar | `nova:calendar:write` | title + YYYY-MM-DD required |
| 17 | `calendar:delete` | calendar | high | Delete calendar events | `nova:calendar:delete` | — |
| 18 | `contacts:read` | contacts | medium | Read contacts | `nova:contacts:read` | — |
| 19 | `contacts:write` | contacts | high | Edit contacts | `nova:contacts:write` | name required |
| 20 | `contacts:delete` | contacts | high | Delete contacts | `nova:contacts:delete` | — |
| 21 | `device:notifications` | device | low | Send notifications | `nova:notifications:*` (show/clear/post/createChannel/cancel/cancelAll/consumeActions) | — |
| 22 | `device:geolocation` | device | high | Access location | `nova:device:geolocation` + webview geolocation gate | — |
| 23 | `device:camera` | device | critical | Access camera | `nova:device:camera` + media gate | — |
| 24 | `device:microphone` | device | critical | Access microphone | `nova:device:microphone` + media gate | — |
| 25 | `clipboard:read` | device | high | Read clipboard | `nova:clipboard:read` | — |
| 26 | `clipboard:write` | device | low | Write clipboard | `nova:clipboard:write` | — |
| 27 | `data:export` | data | low | Export this app’s data | `nova:data:export`, `nova:data:import` | — |
| 28 | `data:backup` | data | low | Back up and restore this app’s data | `nova:data:backup`, `nova:data:restore` | — |
| 29 | `secrets:store` | data | medium | Securely store passwords and tokens | `nova:secrets:set/get/delete/keys` | — |
| 30 | `system:info` | system | medium | System information | `nova:system:info`, `nova:settings:get` | readable-key allowlist |
| 31 | `system:settings` | system | medium | System settings | `nova:settings:set` | writable-key allowlist (osVersion/devMode/rootAccessEnabled blocked) |
| 32 | `system:apps` | system | medium | Manage apps | `nova:app:list/install/uninstall/openDefaultAppsSettings`; `nova:app:launch` (ANY-of) | — |
| 33 | `system:app-launch` | system | low | Launch installed apps | `nova:app:launch` (ANY-of with `system:apps`) | — |
| 34 | `system:root` | system | critical | Unrestricted OS access (Root) | host-page execution (no channel); NovaRoot broker | devMode + rootAccessEnabled + checkbox consent; UNVERIFIED PUBLISHER banner if unverified |
| 35 | `system:events` | system | medium | System events | `nova:events:subscribe` (9 sensitive names) | domain events also need the domain read grant |
| 36 | `system:background` | system | medium | Run scheduled background tasks | none (scheduler wake; push ladder rung 2) | — |
| 37 | `system:background:live` | system | high | Keep running after you close it | `nova:background:stay-alive` | per-session opt-in via stayAlive |
| 38 | `system:autostart` | system | high | Start automatically when NovaByte starts | none (boot launch) | boot-list entry (`HKNU/apps/boot`) |
| 39 | `system:badge` | system | low | Show a badge on the taskbar | `nova:badge:set`, `nova:badge:clear` | — |
| 40 | `system:schedule` | system | medium | Schedule named alarms | `nova:alarms:create/clear/getAll` | exactly one of `when` / `periodMinutes` ≥ 15 |
| 41 | `system:share-target` | system | medium | Receive shared content | `nova:share:inbound` push (delivery re-checks grant) | manifest `shareTarget` MIME types |
| 42 | `push:receive` | system | medium | Receive push messages from its own server | `nova:push:register/unregister`; `nova:push:message` delivery ladder | ladder re-checks grant every message; rung 2 needs `system:background` |
| 43 | `registry.read` | system | low | Read the NovaByte Registry | `nova:reg:get/list/export`; `nova:reg:changed` events | HKNS/security needs `registry.system`; ACLs apply |
| 44 | `registry.write` | system | medium | Store settings in the NovaByte Registry | `nova:reg:set/delete/import` | own `HKNA/<appId>/` subtree (or `registryScopes` prefixes) |
| 45 | `registry.system` | system | critical | Full Registry access, including system keys | extends reg read/write reach; bypasses ACLs | — |
| 46 | `admin:apps` | admin | high | Manage apps (admin) | `nova:admin:apps` | admin session (multi-user) + Admin Access flag |
| 47 | `admin:users` | admin | critical | Manage users | `nova:admin:users` | admin session + Admin Access flag |
| 48 | `admin:system` | admin | critical | System administration | `nova:admin:system` | admin session + Admin Access flag |
| 49 | `admin:audit` | admin | high | Audit logs | `nova:admin:audit` | admin session + Admin Access flag |
| 50 | `sandbox:nested-webview` | sandbox | critical | Embed live web content (nested browser view) | `nova:nested-webview` | manifest `allowNestedWebview:true` (or perm declaration) + grant; nav needs `net:*` |
| 51 | `sandbox:same-origin` | sandbox | high | Access shared cookies & storage | none (`allow-same-origin` token) | manifest `sandbox.allowSameOrigin:true` + grant |
| 52 | `sandbox:escape-popups` | sandbox | high | Open unrestricted popup windows | none (`allow-popups-to-escape-sandbox` token) | manifest `allowPopupsToEscapeSandbox:true` + grant (permission alone is not the opt-in) |

---

## 7. Edge cases and non-IPC grants

Several permissions don't gate a guest-request channel at all. Their enforcement lives elsewhere:

- **`push:receive` (gates inbound delivery, not a request channel).** `nova:push:register`/`unregister` are the only guest-callable channels. The inbound `nova:push:message` direction is a host→guest push; the delivery ladder re-checks the grant and the disabled list on **every** message (app-sandbox.js:8348-8393), so revocation stops delivery instantly even mid-queue. Rung 3 (OS-attributed notification while closed) additionally depends on the notification sanitizer and its 10/min budget.
- **`system:autostart` (gates boot launch).** No API to call — the OS launches granted, boot-listed apps at startup. The boot list persists at `HKNU/apps/boot` (legacy `nova_boot_apps`).
- **`system:background:live` (grant + per-session opt-in).** The grant enables the capability; the app must still call `nova:background:stay-alive` / `novaOS.background.stayAlive(true)` each session — the opt-in is session-only and never persisted.
- **`fs:watch` (front-door grant + per-path rules).** The MAC row is a context-free `fs:watch` check, but the handler then applies the exact `nova:fs:read` per-path access rules ("watching is reading") — the grant alone never makes an unreadable path readable.
- **`fs:access` specialAccess flow.** Apps can never prompt for it (`requestPermission` returns false, `requestAll` skips it); the only path is the user's toggle in Settings → Permissions → Special access. Declaring it in the manifest merely advertises intent.
- **`system:background` (scheduler eligibility).** Also non-request: the host's `AppScheduler` decides wake eligibility from the grant; the app only receives `nova:background:wake` pushes and answers with `nova:background:wake-done` (advisory channel).
- **`system:share-target` (user-mediated inbound).** The pick in the share sheet is the consent; `deliverShareTarget` re-checks the grant per delivery, so revocation takes effect on the next share.
- **`sandbox:same-origin` / `sandbox:escape-popups` (attribute tokens).** Neither maps to a channel; they add tokens to the sandbox attribute (`allow-same-origin`, `allow-popups-to-escape-sandbox`), each behind a manifest flag AND the live grant, with per-popup re-checks for escapes.
- **`system:root` (host-tier execution).** No channel — the grant switches the app's launch path into the OS host page and routes privileged ops through the NovaRoot broker.

Related non-permission flows worth knowing: `nova:share` (outbound share sheet) and `nova:wallpaper:set` need no grant; `nova:locale:get` is ungated by design; file pickers (`nova:files:open/save`, `nova:dialog:*`, `nova:sysdialog:*`) are user-mediated and grant-free — the user's pick is the scoped grant.

---

## 8. Unverified

> Items the audit notes could not fully establish; treat as open questions:
>
> - **`nova.mail.*` facade method signatures.** The 14 v1 methods and their v2 mirrors are attested as a set (tests pin "15 methods incl. send/search/restore"), and channel payloads are verified, but per-method argument shapes beyond `connect`/`openLink` are not quoted in the notes. The examples above use the channel form where the payload is verified.
> - **Events gate composition for `nova:net:ws:*`.** The notes state the domain rules are ALL-of (`system:events` **and** `net:websocket`, app-sandbox.js:6080-6095), but the pinned test only asserts the `net:websocket` half (app-sandbox.test.js:3033). Verify in [internals.md](internals.md) if you subscribe to raw socket events.
> - **Boot-list enrollment UX for `system:autostart`.** The grant, its registry home (`HKNU/apps/boot`), and the "grant must be explicit" rule are verified; the exact Settings/App Manager flow that adds an app to the boot list is not described in the notes.
> - **Rate limits for `mail:*`, `calendar:*`, `contacts:*`, `clipboard:*`, `admin:*`, `device:geolocation/camera/microphone`, `system:info/settings`.** No per-channel limits are documented in the notes; only the *absence* of limits is affirmatively documented (for the WebSocket data plane). Absence here means "not established", not "unlimited".
> - **Runtime `requestPermission()` for low-risk permissions.** Launch-path silent auto-grant is verified; whether the runtime dialog path also auto-grants low-risk items or always shows the dialog is pinned only as "dialog (apm:771-854); low-risk auto-grantable by policy" (app-permission-manager.js:771-854, :941-951).
> - **Settings UI label drift.** Settings carries a hand-maintained `PERM_LABELS` copy missing `contacts:delete`, `system:root`, `registry.*`, and `sandbox:*` — those render as raw permission strings in the Settings list (settings/app.js:144-161, :2176). The consent dialog always uses the catalog labels quoted in this document.
> - **Eighth notifications channel.** The MAC seed lists 7 grant-coupled `nova:notifications:*` rows while the dispatch table is described as having 8; the 8th entry's name is not quoted in the notes. The catalog comment ("every handler checks device:notifications") covers it either way.
