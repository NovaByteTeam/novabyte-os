# NovaByte OS .novaapp Developer Guide

This is the entry point for building apps for NovaByte OS. It follows the full developer journey — first project, manifest, build, signing, install, runtime, permissions, OS services, background execution, data lifecycle, debugging, publishing, updates, and uninstall — and links out to the deeper reference documents instead of duplicating them.

**Who this is for:** developers writing `.novaapp` apps. You need plain web skills (HTML/CSS/JS); Node.js is only needed to run the packager. You do not need NW.js, Electron, or OS-internals knowledge.

**Citation convention:** `path:line` references point into the NovaByte OS repo (`NBOSP/...` relative to the repo root, e.g. `app-package.js:780-1001` is `NBOSP/js/platform/core/app-package.js`). Every default, number, name, and error string below comes from a code-verified audit of the current tree; where an older document was wrong, this guide states the real behavior.

## 1.1 The document set

| Question you have | Document |
|---|---|
| How do I build, package, install, publish, update an app? What manifest fields exist? | **This file** (`guide.md`) |
| What does each of the 52 permissions do? How do prompts, denial, expiry, revocation work? | [`permissions.md`](permissions.md) |
| What are the exact `nova:*` channels, `window.nova` / `window.novaOS` methods, payloads, rate limits, error codes? | [`api-reference.md`](api-reference.md) |
| Show me complete working example apps (storage, files, notifications, browser views, OAuth, IPC). | [`examples.md`](examples.md) |
| How does the OS itself work (sandbox engine, NB-MAC, trust store, registry, server, image)? For OS contributors. | [`internals.md`](internals.md) |

A note on trust levels used throughout this doc set: anything not verifiable from the code is marked inline with `> **Unverified:**` and collected at the end.

### 1.2 The journey map

| Stage | Section |
|---|---|
| Understand the model | §2 |
| Write and build the first app | §3 |
| Fill in the manifest | §4 |
| Sign and verify packages | §5 |
| Get it installed | §6 |
| Know how it runs | §7 |
| Get permissions right | §8 (+ [`permissions.md`](permissions.md)) |
| Use OS services | §9 (+ [`api-reference.md`](api-reference.md)) |
| Run in the background | §10 |
| Survive updates and uninstall | §11 |
| Debug it | §12 |
| Publish and distribute | §13 |
| Check every limit and default | §14 |
| Stay compatible across OS versions | §15 |

---

## 2. What is a `.novaapp` app

A `.novaapp` app is **a sandboxed web app plus a manifest plus permissions plus OS services**. The five-minute mental model:

1. **Your app is a folder of ordinary web files** (HTML, JS, CSS, images, fonts, WASM) with a `manifest.json` at its root. A build step packs the whole folder into a single `.novaapp` file — which is **pretty-printed JSON, not a zip/tar** (`build-apps.mjs:505-516`).
2. **At runtime your app runs inside an isolated NW.js `<webview>`** — a separate renderer process with `nodeintegration="false"`, a sandbox attribute, and its own storage partition (`app-sandbox.js:13717-14011`). There is no `window.parent`, no DOM access to the OS, no Node, no `OS` object. The default origin is **opaque** (`allow-same-origin` is not granted by default, `app-sandbox.js:13394-13396`).
3. **Everything the OS lets you do arrives through an IPC bridge** exposed as `window.nova` (v1) and `window.novaOS` (v2) — injected into your entry HTML before your code runs (`app-sandbox.js:11013-13033`). `fetch`, `XMLHttpRequest`, and `WebSocket` are replaced with permission-checked bridges.
4. **Capabilities are gated by permissions** from a fixed catalog of 52 (`app-permission-manager.js:15-245`). You declare them in the manifest; the user consents at first launch or on first use. Denial never blocks launch — your app runs in restricted mode and gated calls fail with `PERMISSION_DENIED`.
5. **Every privileged call is checked host-side on every invocation** by the NB-MAC policy front door before any handler runs (`app-sandbox.js:9584-9596`). Declaring a permission is necessary but never sufficient.

### What apps can do

- Ship any static web content, including WebAssembly (`script-src` carries `'wasm-unsafe-eval'`).
- Store data: host-side key-value storage with no permission, an app-private `/data/<appId>/` filesystem tree, encrypted secrets, and registry config under `HKNA/<appId>/`.
- Use OS services via the bridge: notifications, file pickers, share sheet, clipboard, network, alarms, push, badges, mail/calendar/contacts, camera/microphone, nested browser views — each behind its permission.
- Open popups (OAuth flows included) via an OS-owned overlay that shares your app's storage partition, if you opt in and the user grants escape consent.
- Run when closed: scheduled wake-ups (~every 15 min), stay-alive backgrounding, and autostart at boot — three separate grants.
- Talk to other installed apps through manifest-declared IPC endpoints.

### What apps cannot do

- No Node.js, no host `OS` object, no `window.parent`/`postMessage` into the OS, no direct filesystem paths outside the scoped roots.
- `eval()` and `new Function()` are blocked outright by CSP (`'unsafe-eval'` is not present; only `'wasm-unsafe-eval'` is, `app-sandbox.js:13071`).
- No popups unless the sandbox attribute carries `allow-popups`; unsandboxed (escaping) popups additionally need a live user grant checked per popup.
- No nested `<webview>` without a manifest opt-in **and** the `sandbox:nested-webview` grant — attempts silently become an inert `<span>` plus an audit event (`app-sandbox.js:12962-13030`).
- Cannot set `devMode`, `rootAccessEnabled`, or any credentials via `nova:settings:set` (writable-key allowlist excludes them, `app-sandbox.js:2951-2953`).
- `system: true` / `systemService: true` in the manifest have **no authority by themselves** — they only matter when the package is signed by the NovaByte System key (the verified triple; see §4 and §13).
- Cannot prompt for `fs:access` (special access, Settings toggle only) or bypass signature verification on the fail-closed install paths.

Three execution tiers exist: the **sandbox tier** (every third-party app), the **trusted host tier** (first-party bundles only, see §7.1), and the **root tier** (`system:root` apps on Developer-Mode devices, §7.1). Everything in this guide about writing apps targets the sandbox tier unless stated.

---

## 3. Your first app — the verified hello world

### 3.1 Project layout

Create a folder whose **name matches your manifest id** (the builder writes `<appId>.novaapp` from the manifest id, so matching names keep the tree readable):

```text
my-apps/
└── com.example.hello/
    ├── manifest.json
    ├── index.html
    ├── app.js
    └── icon.svg
```

`manifest.json` — the four required fields plus an icon:

```json
{
  "id": "com.example.hello",
  "name": "Hello",
  "version": "1.0.0",
  "entry": "index.html",
  "icon": "icon.svg"
}
```

(The icon may be a plain asset path bundled in your package — as here, with `icon.svg` next to the manifest — a `data:` URI, or a short emoji of ≤12 characters; see §4. To see the permission-prompt flow, add e.g. `"permissions": ["clipboard:read"]` with a `permissionReasons` entry.)

`index.html`:

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Hello</title></head>
<body>
  <p id="out">loading…</p>
  <script src="app.js" defer></script>
</body>
</html>
```

`app.js` — use the v2 facade, wait for the ready handshake, write a value to durable storage:

```js
window.novaOS.ready.get().then((info) => {
  document.getElementById('out').textContent =
    'Hello from ' + info.appId + ' on NovaByte OS ' + info.osVersion;
  return window.novaOS.storage.set('lastRun', new Date().toISOString());
});
```

Notes on this snippet:

- The `nova:ready` handshake fires **automatically** when your entry page loads (`app-sandbox.js:11879-11881`); `ready.get()` returns the same payload — `{ appId, permissions, optionalPermissions, osVersion, securityPatch, username }` (username is null for non-system apps).
- `window.novaOS.storage.set` needs **no permission** and is durable (host-side IndexedDB, survives restarts; see §9 and §11).
- Packaged external `<script>` tags are forced to `defer` by the host even if you omit it (`app-sandbox.js:13035-13052`), so `app.js` runs after parse either way.

### 3.2 Build

From the `NBOSP/` directory (the packager lives at the repo root):

```bash
node build-apps.mjs ../my-apps                    # builds every app folder under ../my-apps
node build-apps.mjs ../my-apps com.example.hello  # builds only the named subset
```

- The builder processes **every subfolder that contains `manifest.json`**; folders without one are skipped ("no manifest.json, not an app dir", `build-apps.mjs:470-478`).
- Output lands **next to the app folder**: `my-apps/com.example.hello.novaapp`.
- With no arguments it builds the OS's own apps: `node build-apps.mjs` defaults to `NBOSP/js/apps` (usage header, `build-apps.mjs:63-66`).
- The builder reads **`manifest.json` only** — the claim that `novaapp.json` is also accepted is not true of this builder (repo grep; `NOVAAPP.md` says so, no code path does).
- **The builder does not validate your manifest.** Manifest validation happens at *install* time (`app-package.js:780-1001`). A bad manifest builds fine and fails later.
- Every build is signed (§5). A fresh clone signs with the committed test key: the build log reports `signer: NovaByte System (tier: test — build reports test-keys)`.
- `_package-meta.json` (stale prior-build metadata) is excluded from bundling (`build-apps.mjs:77-79`).

### 3.3 Install

Two everyday routes:

- **App Manager** (`com.nbosp.appmanager`, the standard route): open App Manager → **Install** button, or drag-and-drop the `.novaapp` anywhere in its window. This path runs the full gauntlet: content-scanner sweep of every packaged file, integrity precompute, trust-store verification, and dialogs for anything suspicious (§6).
- **Files app**: right-click a `.novaapp` → Install. Capped at **32 MiB** ("This package is larger than 32 MiB.", `files/app.js:1667-1671`); hands the file off to App Manager.

The **Packages app** (`com.nbosp.packages`) is a Developer-Mode-only tool for pasting package JSON and flipping `skipVerify`/`allowUnverified` checkboxes — it refuses to run otherwise ("Enable Developer Mode in Settings to use Packages."). Use it for experiments, not distribution.

Where things land: package files go to OPFS under `apps/<safeAppId>` (machine-wide) or `apps/@users/<uid>/<safeAppId>` (per account) — `nova-app-package-store.js:41-49,157-209`; the inventory row goes to registry `HKNS/apps/installed`; your app-private data folder `/data/<appId>` is created on first use. Installs are **per account** — two accounts can hold the same app id independently.

### 3.4 First launch — what actually happens

1. The launchpad shows your app. Clicking it calls `WM.createWindow(app.id)` (`launcher/app.js:257`).
2. `AppRegistry.launchApp` runs the **permission ladder**: all low-risk permissions you declared are **auto-granted** (e.g. `net:external`, `clipboard:write`, `device:notifications`); missing **required medium/high/critical** permissions enter a sequential consent queue (`requestAll`, `app-registry.js:672-687`). Optional sensitive permissions are *not* prompted at launch — they are requested at point of use.
3. **Denial never blocks launch.** The gate logs "Launch continuing in restricted mode" and records `__deniedPermissionsAtLaunch` (`app-registry.js:689-708`). The denied capability fails at call time with `PERMISSION_DENIED`.
4. `AppSandbox.launch` picks the tier (root → trusted host → sandbox; §7.1) and creates the `<webview>`; your entry HTML is registered with the local HTTPS server and navigated to, after a deliberate 250 ms content-script registration delay (NW.js race mitigation, `app-sandbox.js:14307-14334`).
5. The capability shim is injected as the very first bytes of your entry HTML — `window.nova` and `window.novaOS` exist before any of your scripts run; no import, no handshake call needed.

A package whose `entry` file is missing from `files` **installs fine** (install does not check entry-file presence) and at launch shows the default "Running in Sandbox" placeholder shell instead of your content (`app-sandbox.js:13190-13227`). The Packages app UI and the Store do check entry presence on their own paths.

### 3.5 What the consent dialogs look like

If your hello-world declared, say, `clipboard:read` (high risk), the first launch opens one dialog per missing required medium+ permission, in a sequential pager ("Permission {current} of {total}" with progress dots). Each dialog shows (`app-permission-manager.js:1149-1280`):

- the permission's user-facing label (e.g. "Read clipboard") and "Requested by **Hello**";
- your `permissionReasons` text, or the fallback block "This app declared no reason why it needs this permission." if you did not declare one — declare one;
- a risk row (LOW/MEDIUM/HIGH/CRITICAL + category);
- **Deny** and **Allow** buttons. `Enter` maps to Allow, `Escape` to Deny; there is no timeout — the dialog waits indefinitely.

Dialogs are built with `createElement`/`textContent` only (your app name and reason strings are treated as untrusted text). Root-access requests add a red-bordered trust banner ("UNVERIFIED PUBLISHER — …" for non-System signers), a mandatory "I understand this app can access and change the OS outside its sandbox" checkbox, and the Allow button becomes "Grant Root Access", disabled until the checkbox is ticked.

### 3.6 Troubleshooting the first run

| Symptom | Cause / fix |
|---|---|
| App installs, launch shows "Running in Sandbox" placeholder | `entry` names a file not present in `files`. Install never checks this — fix the manifest or bundle the file. |
| "Entry file … is not among the packaged files" | The Packages app UI *does* check entry presence (only that path and the Store do). |
| Untrusted/unsigned warning at install | Expected for test-key or self-signed builds; "Install Anyway" is hidden behind the **More Info** expander. Tamper warnings require typing a confirmation phrase. |
| Replace dialog offers an older version | The interactive paths do no version comparison; the dialog shows both versions and relies on you. |
| App invisible in the launchpad | `devOnly: true` needs Developer Mode; disabled apps are blocked at `WM.createWindow` (`wm.js:93-100,110`). |
| App won't relaunch after uninstall/reinstall churn | A pending storage-partition wipe failed; launches are refused (fail-closed) until the wipe succeeds (`app-sandbox.js:14370-14385`). |

---

## 4. The manifest — complete field reference

Validation happens at **install time** in `validateManifest` (`app-package.js:780-1001`): about 31 error rules (install-blocking) and 8 warning rules (install proceeds). Defaults marked "registry" come from `AppRegistry.registerApp` (`app-registry.js:445-459`); defaults marked "launcher" come from the launch config builder (`nova-app-launcher.js:737-781`), which is what a `.novaapp` app actually launches with.

| Field | Type | Required | Default | Validation | Notes |
|---|---|---|---|---|---|
| `id` | string | **Yes** | — | Error unless matches `^[a-z][a-z0-9]*(\.[a-z0-9]+)+$` (reverse-domain); `webapp_*` ids bypass the regex entirely (`app-package.js:828-831`) | Use reverse-domain, e.g. `com.example.hello`. Reserved first-party ids additionally require a verified signature to register (`app-registry.js:286-288`). |
| `name` | string | **Yes** | — | Non-empty (`app-package.js:785-787`) | Shown in titlebar, launchpad, taskbar, dialogs. |
| `version` | string | **Yes** | `'1.0.0'` (registry) | Non-empty; non-semver is a **warning only** — any string installs (`app-package.js:832-833`) | Store publishing enforces strict semver server-side even though the OS install path does not (§13). |
| `entry` | string | **Yes** | `'index.html'` (launcher) | Relative path, no `..`/`.`/empty segments, no backslash/colon/control chars (`SAFE_PACKAGE_PATH_RE`, `app-package.js:795-811`) | Main HTML file the webview loads. **Its presence in `files` is not checked at install** — only the Packages app UI and the Store check it; elsewhere a missing entry installs and fails at launch (§3.4). |
| `description` | string | No | `''` (registry) | none | |
| `author` | string | No | `'Unknown'` (registry) | none | |
| `email` | string | No | — | none | Pass-through; no consumer in the OS. |
| `website` | string | No | — | none | Pass-through; Store listings use their own `links` metadata. |
| `icon` | string | No | **`/assets/no_app_icon.svg`** (registry + launcher, `app-registry.js:446`; `nova-app-launcher.js:50-53`) | Warning if not a `data:` URI, a plain asset path, nor an emoji ≤12 chars ("will be rendered as escaped text", `app-package.js:812-827`); `data:` URI over **512 KiB** is an error (`app-package.js:983-989`) | The old doc's default `"box"` was wrong — `box` is merely a valid example value. |
| `type` | string | No | `'webapp'` (registry, `app-registry.js:449`); launcher falls back to `'package'` (`nova-app-launcher.js:751`) | **No whitelist exists** — any string passes | Built-ins use values including `webapp` and `blank`. `type: "webapp"` **with a `url`** makes the record an external-URL web app (no capability shim, §7.3). |
| `categories` | string[] | No | **`['other']`** (registry, `app-registry.js:451`) | **No whitelist** — free-form strings; category queries just match on them (`app-registry.js:764-766`) | The old doc's default `[]` was wrong. The Store normalizes listing categories separately (lowercase-hyphen, 1-8, 2-32 chars each) server-side. |
| `permissions` | string[] | No (expected in practice) | `[]` | Must be an array; **unknown permission strings are warnings** at install ("Unknown permission: …", `app-package.js:925-930`) and are then hard-stripped from the record (`app-registry.js:315-324`) | Full catalog in [`permissions.md`](permissions.md). `system:root` must be here (not optionalPermissions) and requires `unrestrictedEntry`. |
| `optionalPermissions` | string[] | No | `[]` | Same as `permissions` | Prompted at point of use, not launch; denials don't degrade launch. |
| `permissionReasons` | object | No | — | Object mapping permission → string; values non-empty, ≤500 chars; keys not declared in permissions/optionalPermissions produce a warning (`app-package.js:931-970`) | Shown verbatim in the consent dialog; publish-time automated review requires one for every declared permission (§13). |
| `defaultSize` | `[w,h]` | No | `[800,560]` (launcher, `nova-app-launcher.js:742`; registry fallback is `[800,600]`) | Error unless a 2-element array (`app-package.js:991-993`) | Initial window size. |
| `minSize` | `[w,h]` | No | `[400,300]` (launcher `:743`; registry `[300,200]` via wm.js `:112-121`) | 2-element array (`:996`) | |
| `maxSize` | `[w,h]` | No | none (`app.maxSize ?? null`, `wm.js:112-121`) | 2-element array (`:999`) | |
| `resizable` | boolean | No | `true` (`!== false`, `nova-app-launcher.js:771`) | none | `false` → `.app-window--no-resize`. |
| `frame` | boolean | No | `true` (`:775`) | none | `false` → frameless window. Frameless + transparent + alwaysOnTop is clamped below system chrome ("Phishing overlay risk", `wm.js:673-679`). |
| `transparent` | boolean | No | `false` (`!!`, `:772`) | none | Alpha-capable surface: `allowtransparency="true"` + rgba background on the webview (`app-sandbox.js:13894-13897`). |
| `alwaysOnTop` | boolean | No | `false` (`:773`) | none | |
| `startMinimized` | boolean | No | `false` (`:774`) | none | |
| `unrestrictedEntry` | string | No | `null` | Must match a packaged-JS-file path regex (relative, `.js` extension, no parent-directory segments; `app-package.js:973-976`); for `system:root` packages the file **must exist in `files`** at install ("Root package is missing unrestrictedEntry file …", `:527-529, 605-618`) | The packaged JS file executed in the host page by the root / trusted-host tiers (§7.1). Third-party apps only reach it via `system:root`. |
| `handles` | object | No | — | Object; only keys `protocols`, `extensions`, `mimeTypes`, `roles` allowed; each an array ≤100 with per-item regexes; `roles` accepts **only `home`** (`app-package.js:834-863`) | Default-apps discovery only (§4.1). Not a permission; there is no `handles:*` permission string. |
| `ipc` | object | No | — | Only keys `exports`, `receives`; endpoints match `^(?:service\|provider):[a-z0-9][a-z0-9._-]{0,127}$`; actions match `^[a-z0-9][a-z0-9._:-]{0,127}$`; ≤100 entries, no duplicates (`app-package.js:892-922`) | App-to-app IPC surface (§4.2). Gated by `apps:communicate`. |
| `notifications` | object | No | — | Shape consumed: `channels: [{ id, name, importance, description }]` | Declared channels are seeded before first post (`app-sandbox.js:1540-1549`; `notifications/service.js:155-163`). Max 32 channels/app; importance locked at creation. |
| `allowNestedWebview` | boolean | No | `false` | none | Opt-in for nested browser views. Alone it is not enough: every host call also checks the live `sandbox:nested-webview` grant (`app-sandbox.js:9968-10001`). |
| `allowPopupsToEscapeSandbox` | boolean | No | `false` | none | **Top-level field only** — listing `sandbox:escape-popups` in `permissions` does *not* count as opt-in (`app-sandbox.js:9988-9992`). Per-popup live grant still required (§7.4). |
| `sandbox` | object | No | `{ allowScripts: true, allowForms: true, allowPopups: false }` (launcher `:750`; registry adds `allowSameOrigin: false`) | Recognized keys map to sandbox-attribute tokens: `allowScripts`, `allowForms`, `allowPopups`, `allowModals`; exotic tokens are dropped (`app-sandbox.js:13461-13467`); `allow-downloads` is always added (`:13477-13485`) | `allowSameOrigin: true` requests the same-origin token, granted only if the user also holds `sandbox:same-origin` (§8.1). |
| `shareTarget` | object | No | — | Only key `mimeTypes`; ≤20 patterns; duplicates rejected (`app-package.js:864-891`) | Makes the app eligible to receive shared content (`system:share-target`). |
| `registryScopes` | object | No | see notes | `write` is a list of HKNU path prefixes; **no entry-count cap exists** (the old doc's 32-entry cap was wrong — grep `registryScopes`: no length validation) | Declaring the field **at all — even empty — opts out** of the default write scope `HKNU/software/<appId>/` (`app-sandbox.js:3119-3132`). `read` is advisory documentation only. Scopes can never unlock HKNS, HKND, or another app's HKNA subtree. |
| `system` | boolean | No | derived | **Not a validated field — and not authoritative.** `system` becomes true on the record only for the verified triple `verified === true && signer === 'NovaByte System' && manifest.system === true` (`app-package.js:638`; `app-registry.js:422-424`) | Claiming it unsigned gets you the App Manager system-impersonation **hard block** (no override, §6.2). |
| `systemService` | boolean | No | derived | Headless first-party services: require `system: true` + `systemService: true` + a verified System package, else registration throws (`app-registry.js:519-538`) | First-party only — this only has authority when signed by the System key and loaded from the OS bundle. |
| `headless` | boolean | No | `true`-ish (`manifest.headless !== false`, service loader) | none | Service-loader knob: whether the service registers as headless. |
| `devOnly` | boolean | No | `false` (`nova-app-launcher.js:753`) | none | App hidden and unlaunchable unless Developer Mode is on (`wm.js:110`). |
| `guestEntry` | string | No | — | Same path-safety rules as `entry` (`app-package.js:810-811`) | Validated if present; used by guest surfaces. |
| `url` | string | No | — | When `type: "webapp"`: validated by `resolveAndClassifyUrl` before navigation (`app-sandbox.js:13176-13188`) | External-URL web app record — the modern path for these is the App Manager "Web Apps" panel, not a `.novaapp` manifest. |

### 4.1 The `handles` model (default apps)

`handles` declares what your app can open. Only four keys are allowed — `protocols`, `extensions`, `mimeTypes`, `roles` — each an array of at most 100 strings; the only accepted role is `home` (`app-package.js:834-863`).

- Declaring makes the app **eligible**: it appears in Settings → Default Apps and in "Open with…" choosers (`default-apps/service.js:213-305`). The user still has to choose it — declaration is discovery, not a grant.
- Extensions are matched case-insensitively and require a leading dot (`foo.webp` → `.webp`); MIME types ignore parameters and support `image/*` wildcards (`default-apps/service.js:144-167`).
- A `home` role makes the app selectable as the Home surface; a third-party Home app runs in a full-screen sandboxed webview, never with host access, and selection takes effect after the OS page reloads.
- When the user opens a file with your app, the launch options carry `fileIntent` (`window.__NOVA_APP_OPTIONS__`) and a **scoped, exact-file-id** read/write grant for that one file — no directory listing, no other files (`app-sandbox.js:13942-13946`, `desktop.js:1870-1879`).
- Any installed `.novaapp`, signed or not, may claim any type — there is no verification filter on handles today.

### 4.2 The `ipc` model (app-to-app)

`ipc.exports` lists endpoints your app provides (`service:`/`provider:` prefixed, ≤100, unique); `ipc.receives` lists endpoints you may call and broadcast actions you accept. Cross-app calls are gated by `apps:communicate`, limited to manifest-declared targets, time out after 25 s, cap payloads at 256 KB (over-budget rejects with `INVALID_ARGS`, not `PAYLOAD_TOO_LARGE`), and broadcasts are rate-limited to 20/min. Full channel detail: [`api-reference.md`](api-reference.md).

### 4.3 Worked manifest examples

Minimal manifest — exactly the four install-blocking fields validates (`app-package.js:785-787`):

```json
{
  "id": "com.example.hello",
  "name": "Hello",
  "version": "1.0.0",
  "entry": "index.html"
}
```

Full-optional manifest — every field below passes validation (shape-checked where noted):

```json
{
  "id": "com.example.full",
  "name": "Full Example",
  "version": "2.1.0",
  "description": "Demonstrates every optional manifest field.",
  "author": "Example Corp",
  "email": "apps@example.com",
  "website": "https://example.com",
  "entry": "index.html",
  "icon": "box",
  "type": "blank",
  "unrestrictedEntry": "root.js",
  "permissions": ["fs:read:images", "system:root"],
  "optionalPermissions": ["device:notifications"],
  "permissionReasons": {
    "fs:read:images": "Shows your shared pictures in the gallery view.",
    "system:root": "Manages system services."
  },
  "defaultSize": [800, 560],
  "minSize": [400, 300],
  "maxSize": [1600, 1200],
  "resizable": true,
  "frame": true,
  "transparent": false,
  "categories": ["utilities"],
  "handles": { "extensions": [".mp3", ".flac"], "roles": ["home"] },
  "ipc": { "exports": [], "receives": [] },
  "notifications": { "channels": [{ "id": "updates", "name": "Updates", "importance": "default" }] },
  "allowNestedWebview": false,
  "allowPopupsToEscapeSandbox": false,
  "sandbox": { "allowSameOrigin": true },
  "shareTarget": { "mimeTypes": ["text/plain"] }
}
```

Notes on this example: `"icon": "box"` is a valid *example value* (a plain asset key passes the icon rule) — it is **not** the default (the default is `/assets/no_app_icon.svg`). `"type": "blank"` is likewise a valid *example* — there is no type whitelist and the registry default is `webapp`. `system:root` requires `unrestrictedEntry` to name a packaged `.js` file that actually exists, or install throws.

### 4.4 Exact validation strings (for automated tooling)

Errors (install-blocking), verbatim from `validateManifest`:

```text
Manifest is missing or not an object
Missing required field: id | name | version | entry
Invalid entry "…": no absolute paths, traversal, backslashes, ':' or control characters
Invalid app ID "…". Must be reverse domain format.
handles must be an object
handles.<key> is not supported
handles.<key> must be an array of at most 100 strings
handles.<key>[i] is invalid
shareTarget must be an object
shareTarget.mimeTypes must be an array of at most 20 MIME patterns
shareTarget.mimeTypes[i] is invalid | duplicated
ipc must be an object
ipc.<key> is not supported
ipc.<key> must be an array of at most 100 strings
ipc.<key>[i] is invalid | duplicated
permissions must be an array
permissionReasons must be an object mapping permission strings to reason strings
permissionReasons keys must be non-empty permission strings
permissionReasons["…"] must be a non-empty string
permissionReasons["…"] exceeds 500 characters
unrestrictedEntry must name a packaged JavaScript file without parent-directory segments
system:root requires unrestrictedEntry to name a packaged JavaScript file
system:root must be declared as a required permission, not optionalPermissions
Icon data URI exceeds 524288 byte limit (got ~N bytes) — use a smaller image or reference a file in the package instead
defaultSize must be [width, height]   (same for minSize, maxSize)
```

Warnings (install proceeds): `Icon is neither a data: URI, a plain asset path, nor an emoji; it will be rendered as escaped text` · `Version "…" doesn't follow semver (x.y.z)` · `Unknown permission: …` · `Unknown permission in permissionReasons: …` · `permissionReasons declares "…", which is not in permissions or optionalPermissions`.

---

## 5. Build, sign, verify

### 5.1 The builder CLI

```text
node build-apps.mjs [apps-dir] [app-directory ...]
```

- Builds every subfolder of `apps-dir` containing `manifest.json`; trailing args select a subset (error: `App directory not found: <names>` for unknown names, `build-apps.mjs:548-550`). Default `apps-dir` is `js/apps` next to the script.
- Output: `<apps-dir>/<appId>.novaapp`, pretty-printed JSON (`JSON.stringify(pkg, null, 2)`), written **next to** the app folder; the source folder is never modified.
- Every emitted package is signed. `npm start` / `npm run dev` run the builder automatically via `prestart`/`predev` (`package.json:11-12`); `NBOSP_SKIP_APP_BUILD=1` skips it (`scripts/build-apps-on-start.js:5-8`).

### 5.2 Package anatomy (what the builder emits)

| Field | Value | Ref |
|---|---|---|
| `novabyte_app` | `true` (builder). Note: the runtime `AppPackage.createPackage` API emits the string `'1.0'` instead — both are just payload bytes, but tooling comparing them should normalize (`app-package.js:39,508`) | `build-apps.mjs:437` |
| `compiled_at` | `Date.now()` epoch **milliseconds** (builder); `createPackage` emits an ISO string | `build-apps.mjs:438` |
| `manifest` | your parsed `manifest.json`, verbatim | `:388-395,439` |
| `files` | `{ relativePath: base64 }` for **every** file in the app dir, recursive, forward slashes, sorted; `_package-meta.json` excluded | `:116-157, 402-412` |
| `signing` | `{ method: 'ed25519', signer: 'NovaByte System', tier: 'test'\|'release', signature: <hex> }` | `:304-314, 496-501` |
| `signature` | duplicate of `signing.signature` (hex) | `:501` |
| `integrity` | `{ method: 'sha512', payloadHash, fileHashes }` | `:316-326, 502` |

**What is signed** — the canonical payload, built identically by builder and verifier:

```js
JSON.stringify({ novabyte_app, manifest, files, compiled_at })
```

The `signing` and `integrity` blocks are deliberately excluded (`build-apps.mjs:278-293`; `app-package.js:124-131`). Integrity hashes are SHA-512 over the canonical payload plus one SHA-512 per **decoded** file. `signing.signer` is self-attested and not part of the signed payload — trust derives from the key match, not the string.

### 5.3 Signing key resolution (AOSP model)

Priority (`build-apps.mjs:228-273`):

1. `NBOSP_SYSTEM_SIGNING_KEY_PATH` — path to an Ed25519 OKP JWK file → tier **`release`**
2. `NBOSP_SYSTEM_SIGNING_KEY` — inline JWK JSON → tier **`release`**
3. Committed test pair `keys/test-system-key.json` → signer `NovaByte System`, tier **`test`**

A **fresh clone with no configuration builds test-signed packages that verify as "NovaByte System"** against the default trust anchor — deliberately, like an AOSP build signed with public platform test keys. The committed test key includes its private half **on purpose**; anyone with repo read can mint test-key "NovaByte System" packages on test-tier builds (`keys/README.md:19-25`). This is the single most consequential fact in the trust model — see §13.

What `test` vs `release` means at runtime: `TrustStore.systemSignatureTier()` reports `'test-keys'` or `'release-keys'` (AOSP `ro.build.tags` analogue), shown in Settings → About so a test-key build can never masquerade as a release-key one (`trust-store.js:361-364`). To ship release keys: build with an env key, then rotate the runtime anchor by setting `NBOSP_SYSTEM_SIGNING_PUBLIC_JWK` on the server, which injects `<meta name="nova-system-signing-jwk">`; the trust store swaps its System anchor to that public key (OKP/Ed25519 only; malformed values keep the test anchor, `trust-store.js:145-176`).

### 5.4 Verification

- Runtime accepts **hex and base64url** signatures (the builder emits hex; the Packages app emits base64url — both verify, `app-package.js:152-170`).
- Seven signing methods exist (`SIGNING_METHODS`, `app-package.js:69-77`): `ed25519` (default), `ecdsa-p256`, `ecdsa-p384`, `rsa-pss-4096`, `ml-dsa-65` (experimental, hex keys), `ed448` (experimental, needs Node crypto), `custom`. The OS builder always uses Ed25519.
- Integrity methods: `blake3` (runtime default), `sha256`, `sha512` (builder), `none` — and `verifyIntegrity` **fails closed** for `none`/missing digest (`app-package.js:353-381`).
- A "verified" package = signature from a trust-store key + not revoked + integrity hashes match. A self-signed package is labeled `signer: 'local-dev-<method>'` in the Packages app and installs as Unverified.

Two independent questions are asked on install, in this order: (1) *is the signature cryptographically valid* (`verifyPackage`, `app-package.js:427-483`), and (2) *is that public key in the OS trust store* (`verifyAgainstTrustStore`, `:485-498` — revocation is checked before key matching; first key match wins and yields the signer name). A valid signature from an unknown key is still **Unverified** — trust comes only from the anchor match.

### 5.5 Verifying a package by hand

The Packages app's **Verify** tab accepts a pasted package JSON (or the last signed package handed over from the Sign tab) and reports signature verification, integrity verification, and a file preview, plus a revoke/unrevoke panel for the exact signature string ("Revoked. Persisted to revoked-signatures.json."). Its **"Trust this key locally"** button adds a public key to the trust store for the current session only — useful for testing your own keypair; session trust is never persisted (`trust-store.js:366-388`).

Typical build console output for a fresh clone:

```text
Signing key: AOSP-style PUBLIC test key (NBOSP/keys/test-system-key.json)
Signer: NovaByte System (tier: test — build reports test-keys)
Signature: Ed25519
Building 1 app(s) from ../my-apps
✓ com.example.hello -> com.example.hello.novaapp (3 files, signed as NovaByte System (TEST KEY), source untouched)
```

### 5.6 NovaByte Studio — the GUI packager

NovaByte Studio (`github.com/dirazcoder/novapack-studio`, Apache-2.0, NW.js desktop IDE for Windows/macOS/Linux) packages a project directory into a `.novaapp` without the CLI. Its source was audited separately from this repo (v1.2.34 @ `7236672`); everything below is cited to that tree. (The OS repo README links to a stale `NovaByteOfficial/…` URL — the live repo is `dirazcoder/…`.)

**Project & build** (Studio `src/sdk/builder.js`):

- **Manifest**: `manifest.json` at the project root; `novaapp.json` is accepted as a **legacy fallback** (`builder.js:374-377`). Either way the manifest is packaged as app metadata, never as a regular project file (`builder.js:271`).
- **Build-time validation is a subset of the install-time contract**: required fields, reverse-domain/`webapp_*` id format, `permissionReasons` shape (≤500 chars) and entry-file existence are hard errors (`builder.js:395-452`); unknown permissions are **stripped with a warning**, and legacy `vfs:*` aliases are retained (`builder.js:421-436`). The `handles`/`shareTarget`/`ipc`/icon-size rules from §4.4 are still only enforced at install — Studio's SDK has the same `validateManifest`, but the Build button's code path does not run it.
- **C/C++**: any `.cpp/.cc/.cxx/.c` file is compiled at Build time to a sibling `.js`+`.wasm` pair with a fixed, Studio-controlled emcc flag set (`-O2 -std=c++23 -s WASM=1 -s MODULARIZE=1 -s EXPORT_NAME=Module`, `builder.js:168-198` — no user-supplied compiler flags). Packaged Studio releases bundle a platform-specific Emscripten SDK (`builder.js:59-108`); running Studio from source needs `emcc` on PATH or `NOVAPACK_EMSDK` pointing at an emsdk root. While compiling, the Build button switches to a purple **"Compiling C++..."** state (`app.js:12063-12068`; `--native: #7c3aed`, `style.css:104`).
- **Bundling**: `node_modules`, dotfiles and the manifest file are always excluded; a `.studioignore` file (`.gitignore` syntax, globs + `!` negation, **no protected-file exemptions**) excludes more (`builder.js:240-275`). A `vendor/` directory for single-file JS/CSS libraries is bundled like any other file.
- **Output**: `<id>.novaapp`, pretty-printed JSON, in the project dir or a configured output dir (`builder.js:560-565`), with `manifest.packagedAt` added.

**Signing & integrity defaults**: the UI starts every session with signing **None** and integrity **None** (`app.js:12238-12239`) — this is the code behind the "Studio v1.1.80+ defaults new projects to integrity `none`" claim. Pick a method on the Sign tab before Building. The method lists are identical to the OS SDK's (7 signing, 4 integrity; Studio `app-package.js:85-103`), and signatures emit base64url while the verifier accepts both encodings — same as §5.4. Build-time signing records `signer: 'self-signed'`; the Sign tab's **Self-Sign Last Build** re-signs the last output as `local-dev-<method>` and logs the honest consequence: *"This will still show as Unverified in NBOSP unless the public key is in the trust store"* (`app.js:12597-12660`). Use the OS Packages app's "Trust this key locally" (§5.5) to make a dev keypair verify for a session.

**Tooling around the build**: a Package Inspector (drop a `.novaapp` → manifest, file list, declared-vs-inferred permission audit, signature badge — it verifies against an **empty** trust store, so every key not explicitly trusted shows "Untrusted signature", `app.js:14452-14457`), source permission audit (declared vs inferred from `nova:` strings and `window.novaOS` calls), build-contents preview with `.studioignore` exclusions, named build profiles (keys are never stored in a profile), 9 project templates + 13 API-starter templates that use the v2 `window.novaOS` facade (`templates.js:401,767`), and a two-level plugin API (level 1: Studio 1.2.31+; level 2: 1.2.34+).

**One caveat found in the cross-check**: Studio's repo ships its own copy of the `.novaapp` guide, and it is a **stale snapshot** (it documents `localStorage`-based installs and predates the signing-tier model). This docs set supersedes it.

---

## 6. Install paths and what install checks

### 6.1 The seven entry points

| Path | Scanner sweep | Trust / integrity gates | Notes |
|---|---|---|---|
| **App Manager** (Install button, drag-drop, Files handoff) | **Yes** — `Scanner.scanBase64` on every file; scan errors skipped per-file (best-effort) | Integrity precompute → trust-store verify + revocation → dialogs: malicious (no proceed), system-impersonation (**hard block, no override**), untrusted/revoked/unsigned (proceed behind "More Info"), tamper (typed phrase), combined | The reference path. Replace-confirm dialog shows old/new version. `appmanager/app.js:2380-2623` |
| **Files app** right-click → Install | Yes (gate before handoff) | Delegated to App Manager | 32 MiB cap; only regular files. `files/app.js:1667-1710` |
| **`nova:app:install` IPC** (from a sandboxed app holding `system:apps`) | **Yes — fail-closed** | Integrity **hard-required**, trust **hard-required**, duplicates refused. **No bypass of any kind.** | Error codes below. `app-sandbox.js:5902-6008` |
| **Store app** | No | `verifyCatalogPackage`: integrity + trust + revocation; revoked ⇒ blocked | Installs **unverified packages with no warning dialog** — only badge absence signals it (§13.4). `store/app.js:203-218, 544-566` |
| **Packages app** (devMode-gated) | **No** | Opt-in checkboxes `skipVerify`, `allowUnverified` (which also enables the weaker integrity-only fallback, signer `'integrity-only'`) | Dev tool; explicit "unsafe, dev use only" labels. |
| **my-apps-manager** `installFromFile`/`installFromUrl` | No | Trust store + revocation defaults; caller-supplied options | Library surface; skips App Manager's dialogs and impersonation gate. |
| **Boot reconcile** (bundled system packages) | No | `source:'system-bundle'` provenance + force reinstall when signature/version/compiled_at/payloadHash differ; manifest id must equal bundle id | Self-healing: the **shipped** version always wins, even an older one. `boot.js:842-899` |

### 6.2 Error outcomes

IPC `nova:app:install` codes (`app-sandbox.js:5904-6007`): `PERMISSION_DENIED` (no `system:apps`), `INVALID_ARGS`, `INVALID_PACKAGE`, **`MALICIOUS_PACKAGE`** (scanner flag), `SCAN_FAILED`, **`UNVERIFIED`** — *missing integrity record* ("Package has no integrity record — install manually via App Manager"; unsigned/untrusted rejections use **`UNTRUSTED`**, `:5969`), **`TAMPERED`** (trusted signer, altered bytes), `UNAVAILABLE`, `UNTRUSTED` ("Install blocked — … Install manually via App Manager to review and confirm."), **`ALREADY_INSTALLED`** (refuses any replace — "install manually via App Manager to replace it"), `ERROR`.

Core `AppPackage.installPackage` throws: `Invalid manifest: <errors>` · `Package signature did not match any trusted signer and integrity check failed` · `App ${id} is already installed. Use force option to overwrite.` · `Root package is missing unrestrictedEntry file "…"`. App Manager UI: `System apps cannot be replaced by package installs.` · `Please select a valid .novaapp package.` · `Package is not valid JSON. Obfuscated .novaapp files are no longer supported for security reasons.` The system-impersonation dialog (`manifest.system === true` + unknown id or failed trust/integrity) has **no proceed button** — "NovaByte OS does not offer an override for this case" (`appmanager/app.js:187-243`).

### 6.3 What install validates — and what it doesn't

Validated: required fields (`id`, `name`, `version`, `entry`), id format, path safety of `entry`/`guestEntry`, icon rules, `handles`/`shareTarget`/`ipc` shapes, permission array shape, `permissionReasons` shape, size arrays, `unrestrictedEntry` rules.

**Not** validated at install: entry-file presence in `files` (except `unrestrictedEntry` for root packages), `type`/`categories` values (no whitelists), version ordering (replace does no version comparison), signature trust on the interactive paths (dialogs instead), and the scanner on three of the seven paths. Grants are **not** given at install — they are prompted at first launch (§3.4).

### 6.4 App Manager install, step by step

The reference path (`appmanager/app.js:2380-2623`), in order:

1. `.novaapp` extension check → read as **text and JSON.parse only** (obfuscated packages rejected: "Obfuscated .novaapp files are no longer supported for security reasons").
2. Manifest required-fields check (`id`, `name`, `version`).
3. **Scanner heuristic sweep of every packaged file** — a malicious flag opens an acknowledge-only dialog with **no install-anyway path**.
4. Integrity digests recomputed and compared (mismatches narrowed to the exact files).
5. Trust-store verification with revocation.
6. **System-impersonation hard block** if `manifest.system === true` and the id is not a known first-party id or trust/integrity failed — no override.
7. Dialogs as needed: revoked ("Do Not Install"), untrusted/unsigned (proceed behind More Info), tampered (typed phrase), combined trust+integrity failure.
8. Replace confirmation if the id is already installed: `"<name>" is already installed (v<old>). Replace with v<new>?` — system apps refused outright.
9. Persist to the package store, register into the live registry, re-render launchpad/taskbar, post an "App Installed" notification.

The scanner is a tripwire, not an AV engine. It flags: inline `<script>…</script>` blocks with active content; non-local `<script src>` (scheme/protocol-relative/absolute/traversal all rejected); literal `eval(` and `new Function(`; base64/Buffer/String.fromCharCode decoding piped into eval/`document.write`/`.innerHTML=`; `<iframe>` without a sandbox attribute; sandboxed iframes combining `allow-same-origin` with `allow-scripts`; high-entropy files with text extensions; and double-extension tricks like `readme.pdf.exe` (`scanner/service.js`).

### 6.5 Where an installed app lives

```text
OPFS (per account):
  apps/<safeAppId>/              or   apps/@users/<uid>/<safeAppId>/
    files/<every packaged file>       (safeAppId strips [^a-zA-Z0-9._-] to _)
    files.index.json
    manifest.json
    app.json                       (metadata; functions + files map stripped)

Inventory:  registry HKNS/apps/installed   (fallback localStorage nova_installed_apps)
App data:   /data/<appId>/{files,cache,databases,shared_prefs}   (created on demand)
Registry:   HKNA/<appId>/**               (your config subtree)
```

Every package file is a separate OPFS blob with a guessed MIME type; paths are normalized (backslash→slash, `.`/`..`/empty segments rejected) and writes stay under `apps/<id>/files/` — no host-filesystem escape (`nova-app-package-store.js:51-73,157-209`).

---

## 7. Runtime model — how your app runs

### 7.1 Launch and the three tiers

Click → `WM.createWindow` (disabled/devOnly gates, geometry from manifest) → `AppRegistry.launchApp` (permission ladder) → `AppSandbox.launch` (`app-sandbox.js:14255-14348`), which decides the tier on **every** launch — nothing is cached:

1. **Root tier**: app holds `system:root` (declared + granted) **and** Developer Mode **and** Root Access are both on. `launchRootApp` executes your `unrestrictedEntry` JS directly in the OS host page with an audited `OS.root` API; a launch failure forces a full OS reload to clear partial state (`:14145-14184`).
2. **Trusted host tier**: first-party only. `UnrestrictedGate.checkUnrestrictedApp` requires all six: `system` triple, `source === 'system-bundle'` (only boot can mint that), `manifest.system === true`, id in the build-time first-party manifest, and a still-verifying integrity record (`unrestricted-gate.js:141-176`). The app's script is injected straight into the OS page — no webview, full host APIs.
3. **Sandbox tier**: everyone else — the `<webview>` described next.

### 7.2 The sandbox webview

```html
<webview nodeintegration="false" nodeintegrationsubframes="false"
         sandbox="<tokens>" partition="persist:app_<appId>">
```

- **Partition** is user-scoped: `persist:u<uid>_app_<id>` on multi-user machines, volatile `guest_app_<id>` for guests, `persist:app_<id>` otherwise (`app-sandbox.js:13749-13765`). You never choose it.
- **Sandbox tokens** from `sanitizeSandboxAttr` (`:13392-13508`): default set `allow-scripts allow-forms allow-popups allow-modals` + `allow-downloads` (always); `allow-same-origin` only with manifest opt-in **and** live grant; exotic tokens (e.g. `allow-top-navigation`) are dropped.
- **Origin is opaque** by default; the IPC bridge does not need same-origin (it uses an isolated-world transport scoped to your app's serving paths only, `:13805-13857`).
- **Content serving**: files are POSTed to the local HTTPS server (TLS-only, default `https://localhost:3003`); your entry loads from a per-session URL plus a **stable alias** `/api/apps/serve/sandbox_<appId>/` that survives relaunches — use it as the pre-registered OAuth `redirect_uri` (alias exists only for reverse-domain or `webapp_*` ids). The server prunes registrations after 30 min idle; the sandbox heartbeats every 5 min. Files serve **only while your app is running** — 404 after.
- **On final close**, the storage partition is wiped (fail-closed: a failed wipe blocks future launches until it succeeds) unless the effective sandbox attribute had `allow-same-origin` (`:14461-14492`).

### 7.3 Who gets the `window.nova` shim

| Page | Gets the bridge? |
|---|---|
| Sandboxed `.novaapp` app **entry HTML** | **Yes** — full hardened shim (`window.nova` v1, `window.novaOS` v2 frozen, `apiVersion: 2`) injected as the first bytes (`app-sandbox.js:11013-13033`) |
| Other bundled pages of the same app (e.g. `callback.html`) | **No** — served raw; only the entry file is shimmed (`:13199-13204`) |
| Legacy webview web apps (AppSandbox unavailable fallback) | Yes — an older postMessage-based `window.nova` + compat shim (`nova-app-launcher.js:1074`) |
| `webapp_*` web shortcuts / PWAs (external URLs) | **No capability shim at all** — they navigate to the classified URL and "were never given window.nova capabilities" (`app-sandbox.js:13834-13836`) |

`window.nova` is **not frozen** (mutable; `nova.browser` is bolted on later under nested-webview opt-in); `window.novaOS` is `Object.freeze`d. There is no `app.isSandboxed()` anywhere — feature-detect with `novaOS.capabilities.has(name)`.

### 7.4 Effective CSP

The policy is defined in **two places that must match**: the client `RELAXED_CSP_META` (`app-sandbox.js:13071`) and the server-sent `Content-Security-Policy` header on the `/api/apps/serve/:sandboxId` route (`server/core/index.js:581-593`) — **the header is authoritative and overrides the meta for served apps**. The effective policy:

```text
default-src 'self' blob: data: 'unsafe-inline';
script-src  'self' blob: 'unsafe-inline' 'wasm-unsafe-eval';
style-src   'self' 'unsafe-inline' blob: data:;
img-src     'self' blob: data: https:;
font-src    'self' blob: data:;
connect-src 'self' blob:;
frame-src   http: https:;   (only when nested-webview external frames are permitted)
```

Reading it as an app developer: inline scripts/styles are allowed; **`eval()`/`new Function()` are blocked** (`'unsafe-eval'` is absent — only `'wasm-unsafe-eval'` for WebAssembly remains); **remote images over https: load fine**; **direct network is limited to your own serving origin** — `fetch`/`XHR`/`WebSocket` are patched to route through the permission-checked IPC bridge (`nova:net:fetch`, `nova:net:websocket`), locked against `delete window.fetch`-style unshadowing (`app-sandbox.js:12302-12308`). Requests to your own serve prefix self-fetch natively (WASM/Emscripten support).

### 7.5 What's blocked, mediated, or special

- **Popups**: blocked unless the sandbox attr has `allow-popups`. An *escaping* (unsandboxed) popup additionally requires the live `sandbox:escape-popups` grant, checked **per popup** — token without grant ⇒ popup silently discarded (fail-closed, `:13530-13715`). Popups render in an OS-owned overlay card (URL titlebar, close button) that **shares your app's partition** (OAuth sessions persist). Un-navigable targets (`about:blank`, `javascript:`) are discarded.
- **Nested webview**: `document.createElement('webview')` is re-routed to the `nova-nested-webview` proxy; without opt-in it becomes an inert `<span>` + audit event. Navigation inside nested views requires `net:internal`/`net:external` per destination classification.
- **Top-level navigation** of your app webview is not a general capability — content is served from your package; `nova:open-url` (no permission) opens credential-free http(s) URLs in the OS browser app.
- **Downloads**: `<a download>` clicks and nested-view downloads are intercepted and routed through `nova:download` — the OS save dialog is the control; no byte cap, payload buffered in memory.
- **getUserMedia**: your facade call checks `device:camera`/`device:microphone` per constraints first; then the real `navigator.mediaDevices.getUserMedia` runs in your document and the browser-level `permissionrequest` gate runs separately with **OR semantics** — either grant allows the media request (`:9935-9942`); fullscreen/pointerLock requests are always denied.
- **Window chrome**: your manifest controls `defaultSize`/`minSize`/`maxSize`/`resizable`/`frame`/`transparent`; runtime window control via `novaOS.window` (close/minimize/maximize/setTitle/resize/getState); title clamped to 200 chars.

### 7.6 Serving URLs — the OAuth pattern

Your app's files are registered under two URLs on the local TLS server (`server/core/index.js:318-481`):

```text
Per-session (regenerated every launch):
  https://localhost:3003/api/apps/serve/sandbox_com.example.hello_<unique>/index.html

Stable alias (fixed for the lifetime of the install):
  https://localhost:3003/api/apps/serve/sandbox_com.example.hello/index.html
```

- Pre-register the **stable alias** as your OAuth/SSO `redirect_uri` — it survives relaunches and always resolves to the most recent launch (last launch wins; an older still-open window keeps serving from its own per-session path).
- The alias exists only for platform-shaped ids (reverse-domain or `webapp_*`, ≤128 chars) — anything else degrades to session-only serving and has no stable callback URL.
- Always use `https://` — the server is TLS-only and rejects plaintext with an explicit "HTTPS required" page.
- Files serve **only while your app is running**; after the sandbox is destroyed the alias 404s.
- The callback page itself does **not** get the capability shim (§7.3) — read `?code=` from `location.search` and relay it to your entry page, or, with `sandbox:same-origin`, via `localStorage`/`BroadcastChannel`. Popup relays use `window.opener.postMessage({ code }, '*')` — the escaped popup runs on the real serving origin, and the sandboxed opener's opaque origin makes any narrower targetOrigin unmatchable.

### 7.7 Window lifecycle states

| State | Meaning | Notes |
|---|---|---|
| running | webview in a window | normal foreground operation |
| minimized | window hidden | sandbox untouched (`wm.js:528-543`) |
| backgrounded (live) | webview reparented to hidden `#background-app-host` | requires `system:background:live` **and** a per-session `stayAlive()` (§10); all live state (sockets, subscriptions) kept |
| reattached | backgrounded webview moved into a new window | reopen does not launch a second instance; `wantsBackgroundLive` is deliberately not reset |
| destroyed | full teardown | cleanup + partition wipe decision (§7.2) |

Close path (`wm.js:413-526`): closing animation → background keep-alive check (skipped on `forceKill`) → sandbox cleanup → window geometry saved (per-app "Shell Bags") → element removed → `app.onClose` → pinned background notification with Terminate if kept alive → focus next window. Force Stop in App Manager closes all windows with `forceKill` and terminates background sandboxes; uninstall does the same before removal.

---

## 8. Permissions in brief

The full catalog (all 52, risk tiers, grant/deny/expire semantics, dialog anatomy, rate limiting) is in [`permissions.md`](permissions.md). The essentials:

- **Declaration** happens in `permissions` (required) and `optionalPermissions` (point-of-use). Unknown strings warn at install and are stripped. Legacy `vfs:*` names are translated (`vfs:access/read/write/delete → fs:access`, `vfs:metadata → fs:metadata`) — translation can never widen access.
- **Low-risk permissions are auto-granted at launch** unless previously denied; required medium/high/critical permissions are prompted in a sequential queue with your `permissionReasons` text; **denial never blocks launch** — "Launch continuing in restricted mode".
- **Runtime requests**: `await novaOS.permissions.request(name, reason)` (resolves boolean) or `nova.requestPermission(...)` (raw). Denials do not suppress future prompts — the rate limiter (3 requests/60 s per app+permission, exponential cooldown 5 s → 15 min) is the anti-prompt-bombing defense.
- **Grants** are keyed `appId:permission` only — not version, not signature. They survive updates and even an unverified reinstall under the same id (only `system:root` re-prompts). Non-permanent grants expire after 1 day; unused apps' grants expire after 30 days (`system:root` never sweeps).
- `fs:access` is **special access**: apps can never prompt for it; the user toggles it in Settings only.

**Grant lifetime and persistence.** Grant records live in registry `HKNU/security/appPermissions` on multi-user machines (`HKNS/...` otherwise), with a `localStorage` fallback; they are per-account ("each account consents for itself") and re-hydrated on login/user switch. A runtime request with `permanent: false` expires after 1 day. An app that goes unused for 30 days has its granted permissions swept (with a "Permissions removed" notification); denial records are never swept, and `system:root` grants are exempt — root revocation is always an explicit user action. Users can re-enable a denied permission in Settings (which clears the denial then grants) or reset all permissions per app in App Manager; revoking `sandbox:same-origin` force-closes the app's windows, and revoking root triggers a full OS reload to evict the app from the host page.

**Prompt queue behavior worth knowing**: launch-time prompts skip permissions already denied (a denial is not re-asked at launch — only via runtime request or Settings), while runtime `requestPermission` **always** re-prompts after a denial (hence the rate limiter). There is no "don't ask again" checkbox anywhere in the OS.

### 8.1 The three sandbox capability double-gates

These need **manifest opt-in AND a live user grant** — neither alone does anything:

| Capability | Opt-in (you) | Grant (user) | Effect |
|---|---|---|---|
| `sandbox:same-origin` (high) | `sandbox.allowSameOrigin === true` | live `isGranted` at sandbox creation | adds the `allow-same-origin` token → real cookies/localStorage on the shared origin; revocation closes all windows and queues a partition wipe |
| `sandbox:escape-popups` (high) | **top-level `allowPopupsToEscapeSandbox` field only** (listing it in `permissions` does not count) | checked per popup at `newwindow` | popup runs unsandboxed (needed for OAuth `postMessage` relays); without grant the popup is discarded fail-closed |
| `sandbox:nested-webview` (critical) | `allowNestedWebview === true` or declared in permissions | checked on every host operation | enables `nova:nested-webview` IPC, context menus, overlays; revocation destroys nested views + overlays |

---

## 9. Using OS services

The pattern for every service is the same: **declare → get the grant → call the facade** — and the host re-checks the grant on every single call, so a revocation takes effect immediately. All facades reject with an `Error` carrying `{ code, message }`; the common codes are `PERMISSION_DENIED` (missing/revoked grant or MAC policy), `INVALID_ARGS`, `NOT_FOUND`, `UNAVAILABLE`, `RATE_LIMITED`, `LIMIT_REACHED`, `TIMEOUT`.

One paragraph per area; channel payloads, facade signatures, and every rate limit are in [`api-reference.md`](api-reference.md), recipes in [`examples.md`](examples.md).

- **Storage** — `novaOS.storage.get/set/remove/clear/keys/usage`: durable host-side IndexedDB keyed `[appId, key]`, **no permission**. Keys match `^[\w\-. ]+$`; values ≤5 MB; default quota 256 MB (ledger-clamped 1 MB–2 GB).
- **Filesystem** — `novaOS.fs.*` plus scoped roots: `appdata:` (your own `/data/<appId>/` — read/write with no grant; even `appdata:/otherApp/x` is rewritten into your subtree), `shared:`/`media:` (shared tree; reads need a media grant/picked file/`fs:metadata`/`fs:access`, mutations need a user-picked file or `fs:access`). Watching: max 8 watchers/app, 60 events/min.
- **Dialogs** — two picker pairs: `nova.dialog.pickOpen/pickSave` (minimal overlay) and `novaOS.dialog` styled system browser (`nova:sysdialog:*`, supports `multiple: true` ≤25 files). Picking **grants** access to exactly those file ids. Picked files ≤10 MB each; accept lists ≤20 entries; interactive channels get a 10-minute timeout instead of the normal 60 s.
- **Notifications** — channel model (max 32/app; importance `none|low|default|high` locked at creation; user overrides per channel). Posts: 10/min new, 60/min tag updates; title ≤120, body ≤500, actionLabel ≤40 chars; ≤3 actions; icon allowlist `bell, zap, x, info, error, warning, success`; 100 stored; action clicks are **pull-only** via `consumeActions()`. Needs `device:notifications`.
- **Clipboard** — `readText` needs `clipboard:read` (falls back to the host's last written value); `writeText` needs `clipboard:write`. Host keeps a 30-entry clipboard history.
- **Network** — your `fetch`/`XHR`/`WebSocket` are bridged: `net:external` (public), `net:internal` (private/loopback — cloud-metadata IPs always blocked); ws/wss only; URLs with embedded credentials rejected; request bodies capped by the `httpBodyBytes` ledger budget (16 MiB default, 64 KB–64 MiB clamp); `sendBeacon` is fire-and-forget through the bridge.
- **Alarms** — `novaOS.alarms.create/clear/getAll/onAlarm`: needs `system:schedule`; max 32/app; name ≤64 chars (`^[\w.:\-]+$`); `periodMinutes` ≥15 or a `when` ≤1 year ahead; same-name create replaces. **Alarms never wake a closed app** (§10).
- **Background** — three tiers, §10.
- **Push** — `push:receive`; `novaOS.push.register()` (idempotent token) / `unregister()` / `onMessage(cb)`; OS-mediated delivery.
- **Share** — `novaOS.app.share(data)` opens the OS share sheet (**no permission** — the sheet is the consent; 5 sheets/min; text ≤4000 chars); receive shared content with `system:share-target` + `shareTarget.mimeTypes` + `novaOS.share.onInbound(cb)`.
- **App-to-app IPC** — `apps:communicate` + manifest `ipc.exports/receives`; invoke timeout 25 s; payloads ≤256 KB (over ⇒ `INVALID_ARGS`); broadcasts 20/min.
- **Secrets** — `secrets:store`; AES-256-GCM encrypted per-app store; max 64 secrets/app, 8 KiB per value; `novaOS.secrets.set/get/delete/keys`. **Values survive uninstall** (§11.3).
- **Registry** — `registry.read` (low) / `registry.write` (medium): write your own `HKNA/<appId>/` subtree; default HKNU write scope `HKNU/software/<appId>/` (opt out by declaring `registryScopes`); `registry.system` (critical) for everything else; HKND writes additionally need Developer Mode. Paths ≤16 segments, values ≤256 KiB. `novaOS.registry.watch` rides `nova:reg:changed`.
- **Mail / Calendar / Contacts** — `mail:read/write/send/delete` (write/send/delete are critical), `calendar:*`, `contacts:*`; all share the host stores; mail methods are `UNAVAILABLE` until the host Email app has a connected session.
- **Media** — `novaOS.media.query` (media library; needs matching media-read grant/`fs:metadata`/`fs:access`), `checkCamera`/`checkMicrophone` probes, `getUserMedia` (§7.5).
- **Badges** — `system:badge` (low, auto-granted): taskbar badge count 0–999 or 1–4-char text, 30 updates/min.
- **Wallpaper** — `novaOS.wallpaper.set('wallpaperId'|'customWallpaper', v)`: deliberately writable **without** `system:settings` (subject to the writable-key allowlist and the `prohibitWallpaperChange` policy).
- **Appearance** — `novaOS.appearance.get/set/onChange`; rate-limited.
- **Events** — `novaOS.events.on(name, cb)` against a fixed allowlist of 18 names (`system:*`, `app:installed/uninstalled/launched`, `mail:*`, `calendar:*`, `contacts:*`, `nova:net:ws:*`, `nova:reg:changed`); sensitive names need `system:events`, domain events need their read grant. **Caveat:** only `nova:net:ws:*`, `nova:reg:changed`, `calendar:updated`, and `contacts:updated` actually have emitters today — the other 14 subscribe successfully but never fire.

---

## 10. Background execution

There is **no `service`/`background` manifest field** — all three tiers are permission grants declared in `permissions` (`NOVAAPP.md` model confirmed; `app-scheduler.js:1-36`):

| Tier | Grant | What you get |
|---|---|---|
| 1 — scheduled wake | `system:background` (medium) | OS wakes your **closed** app headlessly ~every 15 min, for ≤10 s |
| 2 — stay-alive | `system:background:live` (high) | Your webview survives window close, indefinitely |
| 3 — autostart | `system:autostart` (high) | Your app launches at OS boot |

**Tier 1 protocol**: eligibility = installed ∧ not disabled ∧ grant held — no prior launch needed. The scheduler launches a hidden 1×1 px sandbox and pushes `nova:background:wake { wokeAt, deadlineMs }`; receive it with `novaOS.background.onWake(cb)` (or `nova.onBackgroundWake`); signal early completion with `novaOS.background.wakeDone()`. If you never call it, the host tears the sandbox down at the 10 s deadline anyway. The wake push can race your page load and be lost — there is **no redelivery**. Sweep interval is a fixed 15 min with no jitter; there is no CPU/memory budget, only the time and rate limits.

A minimal wake-capable app:

```js
// manifest: "permissions": ["system:background"]
const off = window.novaOS.background.onWake((info) => {
  doQuickSync(info.wokeAt)          // you have ~10 s (info.deadlineMs)
    .then(() => window.novaOS.background.wakeDone()); // finish early
});
```

Waking does not grant anything else — a woken app without `device:notifications` still gets `PERMISSION_DENIED` on notification posts, and each app's wake is isolated so one misbehaving app cannot cost another its slot.

**Tier 2 protocol**: holding the grant is not enough — call `novaOS.background.stayAlive()` (or `nova.stayAliveInBackground()`) **once per session**; the opt-in is never persisted. On window close the webview is reparented to a hidden host, keeping sockets and state alive; the user sees a one-time toast and a **pinned, non-dismissible notification with a Terminate button** — that, plus Force Stop / disable / uninstall, are the ways the process stops. Reopening reattaches the same instance instead of launching a second one. If a Tier-1 wake finds a live Tier-2 sandbox, it piggybacks rather than launching a second one.

**Tier 3**: needs the grant **and** the user's "start at boot" toggle in App Manager (the boot list is only writable by that UI — an app cannot self-enroll). Both or neither. **If the machine boots to a lock screen, autostart is skipped entirely for that session — the apps never launch, they don't wait for unlock** (`boot.js:1141-1145`).

**Alarms do not wake closed apps.** Alarms fire into a *live* sandbox (open window or Tier-2 process). While closed, periodic alarms silently skip to their next occurrence; one-shot alarms queue (bounded at 8, newest kept) and are delivered right after `nova:ready` on your next launch with `queued: true` (`app-sandbox.js:7897-7902`). If you need work to happen while closed, that is Tier 1's job — "alarms schedule *moments*, the scheduler runs *code*".

---

## 11. Data lifecycle

### 11.1 Where app data lives

| Store | Location | Wiped when |
|---|---|---|
| Webview storage (cookies, localStorage, IndexedDB in-sandbox) | partition `persist:app_<id>` (user-scoped `persist:u<uid>_app_<id>`) | On final window close **unless** the effective sandbox attribute had `allow-same-origin`; also on Clear App Data / uninstall |
| `novaOS.storage` KV | host-side IndexedDB, keyed `[appId, key]` | Only on Clear App Data / uninstall (`storageClear`) |
| App files | `/data/<appId>/` (VFS; native `~/users/<name>/.apps/<appId>/` on Linux) | Only on uninstall / Clear App Data |
| Registry config | `HKNA/<appId>/**` | **Never on uninstall** — residue (see 11.3) |
| Secrets | encrypted store under `root/` | **Never on uninstall** — residue |
| Named alarms | registry `HKNS/apps/alarms` | **Never on uninstall** — residue |
| Package files | OPFS `apps/<safeAppId>` (per-account variant) | On replace (wiped + rewritten) and uninstall |

### 11.2 Update semantics

- An update is just **installing a package with the same id** through any install path.
- **Version rules differ per surface.** Core `installPackage` with `force` and the App Manager replace dialog do **no version comparison at all** — downgrades are permitted (the dialog shows both versions; the user is the only guard). The Store enforces catalog-version match **and** strictly newer semver. The IPC path refuses any replace. Boot self-heals bundled system apps to whatever the OS image shipped — including an older version.
- System apps cannot be replaced by package installs at all.

Preserved vs replaced on update (same id):

| Item | Behavior |
|---|---|
| Package files (OPFS `apps/<id>/files`) | **Wiped and rewritten** |
| App user data (`/data/<id>`) | **Preserved** |
| Permission grants | **Preserved** (revoked only on uninstall) |
| `installedAt` | **Preserved** |
| Secrets | **Preserved** |
| Registry `HKNA/<id>` config | **Preserved** |
| Registry inventory entry | Replaced |
| `source` (App Manager replace path) | Reset to `'file'` (never inherits `system-bundle`) |

The grants row is the one to internalize: grants are keyed by appId only, so a same-id replacement — even an unverified one — inherits every prior consent without re-prompting (only `system:root` re-prompts for non-System signers). That is the documented trade-off of appId-keyed grants, and the reason the Store and IPC paths enforce update direction while the manual paths rely on the user reading the version dialog.

### 11.3 Uninstall — what is removed vs what survives

Uninstall is confirmed with a modal ("Uninstall "<name>" v<version>? This cannot be undone."), refuses system apps, force-closes windows and background sandboxes, and then clears — **on the primary paths (App Manager and IPC)** — these categories (`appmanager/app.js:2664-2808`; `app-sandbox.js:5758-5902`): package files + OPFS dir + index/metadata; package-store inventory entry; registry records (`OS.apps`, `APP_REGISTRY`, launchpad re-render); the webview storage partition; `nova:storage` KV; storage ledger; the `/data/<appId>` app data dir; **all permission grants** (`revokeAllPermissions`); pinned-apps entries; disabled/boot lists entries; desktop shortcuts targeting the app; EventLog entries.

**Caveat — cleanup differs by uninstall surface.** The notification channel state, notification rate-limit entries, and the default-apps rate limit are cleared **only on the IPC path** (`app-sandbox.js:5863-5872`); the App Manager path does not call them.

**Residue that survives every uninstall path** — plan around it:

| Survives | Evidence |
|---|---|
| **App secrets** (encrypted values) | `AppSecrets` has no per-app wipe API; a same-id reinstall silently re-inherits them (`app-secrets.js:243-256`) |
| **Named alarms** (`HKNS/apps/alarms`) | no uninstall path filters them; stale alarms may fire into a reinstalled same-id app |
| **Default-app registrations** (`defaultApps` settings) | only the *rate limit* is cleared (IPC path); stale handler registrations persist (mitigated: `handles` associations vanish with the app record, and eligibility is re-checked at every launch) |
| `HKNA/<appId>/**` config hive | per-path `remove()` only; no uninstall hook |

---

## 12. Dev & debug workflow

**Run the OS from source** (`NBOSP/`): `npm install`, then `npm start` (runs `nw .`; `prestart` builds the `.novaapp` bundles automatically) or `npm run dev` (adds logging flags). `NBOSP_SKIP_APP_BUILD=1` skips the automatic build. The local Express server is spawned as a child process by `scripts/startup.js` (TLS-only, default `https://localhost:3003`); the web page never starts it itself.

**Install local builds**: drag the `.novaapp` into App Manager, or use the Files right-click. For quick JSON-level experiments, the **Packages app** (Developer Mode on) offers Sign/Verify/Install tabs, keypair generation, and the explicit-bypass checkboxes.

**Built-in dev tools** (all `devOnly`, hidden unless Developer Mode is on):

- **Console** (`com.nbosp.devconsole`) — run JavaScript directly in the OS context.
- **Modules** (`com.nbosp.modules`) — hot-reload OS JS modules in the running OS without a restart (a fixed set of paths).
- **Permissions** (`com.nbosp.permissions`) — inspect and grant/revoke per-app permissions ("Grant (no prompt)" bypass included).
- **Packages** (`com.nbosp.packages`) — see above.
- **Debug overlay** — F3 / Ctrl+Shift+D FPS/memory HUD, devMode-gated inside `enable()`.
- **NovaReg** — registry editor (Developer Mode); renders friendly names for ~90 well-known paths.

**Devtools availability**: on dev builds, F12/Ctrl+Shift+I opens DevTools on the OS host page unconditionally (`ui-init.js:58-61`), and the dev `package.json` ships `--remote-debugging-port=9222`, `--auto-open-devtools-for-tabs`, `--disable-web-security` — treat any non-kiosk run as unhardened. The kiosk image replaces these with `--disable-devtools` and a hardened arg set (`prepare-kiosk.mjs:29-63`). There is no code path that exposes `showDevTools()` on third-party sandbox webviews — devtools are for the host page and your own dev builds. `window.__NOVA_DEBUG` un-mutes the console (it is muted by default).

**Tests**: `npm test` runs `npx vitest run --reporter=verbose`; the integration suites also run under `tests/integration/run-all.js`. The suites that pin the app-facing contract:

| Suite | What it pins |
|---|---|
| `tests/integration/guest-bridge.suite.js` | ~327 checks running the real shim + isolated transport + real dispatcher over every documented channel — the executable version of [`api-reference.md`](api-reference.md) |
| `tests/integration/legacy-vfs-compat.suite.js` | the `vfs:*` channel alias table and translate-then-enforce ordering |
| `tests/integration/package-signature-encoding.suite.js` | hex/base64url signature interop |
| `tests/integration/mac-policy.suite.js` · `storage-ledger.suite.js` | the MAC front door and ledger budgets |
| `tests/integration/picker-contract.suite.js` | file-picker grant semantics |
| `tests/apps/store.test.js` · `store-updates.test.js` | catalog merge, unverified-install behavior, update direction, per-version notification dedupe |
| `tests/apps/packages.test.js` | Packages app UI contract (dev-mode gate, tabs, install flow) |
| `tests/platform/security/app-sandbox.test.js` (+ `.facade.test.js`, `.freeze.test.js`) | sandbox construction, permissions, frozen facades |

---

## 13. Trust, verification & distribution

### 13.1 Signing tiers and the trust store

The OS trust store ships exactly two anchors (`trust-store.js:187-211`):

| Anchor | Meaning | Key |
|---|---|---|
| **NovaByte Trusted Signing** (`novabyte-trusted-signing-v1`) | reviewed community/CA signer → **"Verified"** badge | Ed25519 `x=Id_PakcUqjCM2k3i7mSkQy7LadrM_PwVz9S1ikYAzEY` |
| **NovaByte System** (`novabyte-system-signing-v1`) | first-party signer → **"System"** (with `manifest.system`) | committed **test** key by default; server-injected release JWK via `NBOSP_SYSTEM_SIGNING_PUBLIC_JWK` when configured |

The **verified badge** requires: signature from a trust-store key + not revoked + integrity hashes match. `test-keys` builds verify anything signed with the committed test key — including packages claiming to be NovaByte System. On such builds anyone with repo read can mint System-grade packages; the mitigations are the tier labeling in Settings → About, the UnrestrictedGate's first-party id allowlist, and the documented rotation to release keys. **Do not treat test-key machines as a security boundary.**

**Revocation** is keyed by the **exact signature string** (never id/name/version), persisted locally to `revoked-signatures.json` (OS) / `src/revoked-signatures.json` (site) — both currently `[]`. There is **no runtime revocation feed**: a revoked package can only be blocked on a machine by shipping a new OS/site release or revoking locally in the Packages app. Revoking a signature does not revoke the key; key compromise requires replacing the trust-store entry.

### 13.2 Publishing

Two supported routes:

1. **NovaByte Studio** — the GUI packager (`github.com/dirazcoder/novapack-studio`, Apache-2.0; v1.2.34 audited against its source @ `7236672`). It packages a project into a `.novaapp` with optional self-signing and integrity. The verified build flow, defaults, and caveats are in [§5.6](#56-novabyte-studio--the-gui-packager). Signed-with-your-own-key packages publish fine but install as **Unverified** everywhere until the OS trusts the key (§13.1) — the portal's server-side signing (below) is what produces "Verified" badges.
2. **The publisher portal** — part of the NovaByte site (`https://novabyteam.github.io/novabyte-os/`), Supabase-backed. The flow, verified from the publishing stack (`src/publishing.js`; `supabase/functions`):
   1. **Account**: email/password signup with **email confirmation required** (enforced client- and server-side). Sessions live in `sessionStorage` only.
   2. **Submit**: pick a `.novaapp` (≤25 MB, `novabyte_app === true`, valid manifest+files), fill the listing (name, id, author, version, description ≥20 chars, categories, links, changelog ≤4000), attach ≤5 screenshots (embedded as package `screenshots/` files; store-only data stripped before upload). Client-side permission-reason problems only *warn*; the package is still submitted. Quota: ≤20 active submissions per user; new ids blocked if already owned or present in the static catalog; updates require ownership + strictly newer semver.
   3. **Automated review** runs — 22 blocking checks (27 blocking code strings; some checks emit more than one code) plus 5 warning codes. A failing report is attached and the submission still goes to review — enforcement happens at the reviewer-package upload, which re-runs the checks and refuses failing packages. The blocking codes:

      - `invalid_package` / `invalid_package_marker` — root must be an object with `novabyte_app === true`
      - `invalid_manifest` / `missing_manifest_field` — manifest object; `id`, `name`, `version`, `entry` non-empty
      - `invalid_manifest_id` — reverse-domain or `webapp_` prefix pattern
      - `manifest_id_mismatch` / `manifest_version_mismatch` — must equal the submitted listing
      - `invalid_permissions` — permissions must be an array of strings
      - `optional_root_permission` — `system:root` must not be optional
      - `missing_permission_reasons` / `missing_permission_reason` — every declared permission (required + optional) needs a non-empty `permissionReasons` entry (legacy `vfs:*` aliases count for `fs:*`)
      - `invalid_permission_reason` / `overlong_permission_reason` — non-empty, ≤500 chars
      - `invalid_file_map` / `empty_file_map` / `too_many_files` — files object, 1–2000 entries
      - `unsafe_file_path` — no leading `/`, backslash, or `.`/`..`/empty segments
      - `invalid_file_data` — canonical base64
      - `binary_file` — executable-extension blacklist **and** magic-byte sniff (MZ, ELF, zip, 7z, RAR, wasm, Java class, Mach-O)
      - `invalid_text_encoding` — html/js/css/svg must decode as UTF-8
      - `dynamic_code` — `eval(` / `new Function(`
      - `string_timer` — `setTimeout/setInterval("…")`
      - `remote_script` / `remote_module` / `remote_css_import` — remote `<script src>` / `import "//…"` / `@import url(//…)`
      - `missing_entry` — manifest.entry must exist in files
      - `invalid_unrestricted_entry` — must be a packaged `.js` file with a safe name

      Warning codes (never block): `minified_source` (lines >1000 chars), `obfuscated_source` (>20 `\x`/`\u` escapes), `network_reference` (external hosts, localhost excluded), `root_permission`, `permission_rationale`. A human checklist (no ads/trackers, behavior matches listing, no review-detection / system-dialog impersonation / crypto-mining) is attached to every report.
   4. **Single-admin review**: the reviewer (one hardcoded admin account) downloads via a 1-hour signed URL, **must upload the reviewed `.novaapp`** (the upload re-runs the automated checks — failures block it), rates safety confidence 1-100, then publishes / rejects / requests changes (email notifications via Resend).
   5. **Server-side signing at approval**: the Edge Function signs with `NOVABYTE_SIGNING_PRIVATE_JWK` (pinned to the Trusted Signing public key), deletes any pre-existing signature, computes SHA-512 integrity, self-verifies, and publishes to the public `published-packages` bucket at `<appId>/<version>.novaapp` plus a catalog row (atomic upsert). The committed dev/System key is forbidden for publishing.

### 13.3 The Store and catalogs

The Store app (`com.nbosp.store`) merges **two catalogs, deduped by id — community entries override static ones**: the static `apps.json` on GitHub Pages (currently `[]`) and the community Postgres catalog (Supabase). It degrades to whichever is reachable. Install from the Store: package identity check (`manifest.id === catalog id`), integrity + trust + revocation verification — revoked packages are blocked outright. **Caveat:** unverified/unsigned Store packages install with **no warning dialog**; the only signal is the absence of the `✓ Verified` badge (asserted by test: "unsigned package installs unverified").

Catalog entry fields (static and community entries share the shape): `id` (`^[a-z0-9][a-z0-9._-]{1,119}$`), `name` ≤80, `version` (strict semver), `author` ≤80, `description` ≤1000, `categories` 1–8 lowercase-hyphen entries of 2–32 chars, `icon` (data-URI built server-side), `file` (absolute https package URL, or relative to the store base), `size`, `screenshots` ≤5, `links {website, source, support}` (https only), `release_notes`, `version_history` ≤50, `featured` (static catalog only), `published_at`.

### 13.4 Updates

- **The Store update service checks ONLY the static GitHub Pages `apps.json` catalog** (`store-updates/service.js:4-5`). **Community (Supabase-published) apps get no update checks or notifications at all.** Interval: 0/15/30/60 (default)/120/360/720/1440 minutes or 0 = startup only; one notification per app per version; system apps excluded.
- **Direct-distribution updates** = installing a newer version over the old one via any install path. There is **no version comparison on the interactive paths** — the App Manager replace dialog happily installs an *older* version (downgrades allowed); only the Store (strictly newer + catalog match) and the IPC install (refuses any replace) enforce direction.
- Store update flow preserves the original install date and records `lastUpdateSource`/`lastUpdatedAt`; the app is re-registered live (no restart) and data is untouched.

### 13.5 Direct distribution

Handing someone a `.novaapp` file is a fully supported distribution path — no installer, no admin rights, installs per account. The recipient gets the full App Manager gauntlet (scanner, integrity, trust dialogs). Unverified is not blocked: "NBOSP doesn't gatekeep what you can run on your own machine" — the dialogs are warnings with explicit proceed buttons, except system impersonation.

---

## 14. Limits & defaults — consolidated

All numbers verified against the current tree; full per-channel detail in [`api-reference.md`](api-reference.md).

| Thing | Value | Where |
|---|---|---|
| Window defaults (`.novaapp` launch) | size 800×560 · min 400×300 · max none · resizable · framed · opaque | `nova-app-launcher.js:742-743,771-775`; `wm.js:112-121` |
| Registry record fallbacks | icon `/assets/no_app_icon.svg` · type `webapp` · categories `['other']` · version `1.0.0` · author `Unknown` | `app-registry.js:445-451` |
| Icon `data:` URI cap | 512 KiB | `app-package.js:983-989` |
| `permissionReasons` value cap | 500 chars | `app-package.js:943-970` |
| `handles`/`ipc` arrays | ≤100 entries each | `app-package.js:852-853, 906-907` |
| `shareTarget.mimeTypes` | ≤20 | `app-package.js:873-874` |
| Files-app install size cap | 32 MiB (only path with a cap) | `files/app.js:1667-1671` |
| Publisher upload cap | 25 MB | publishing stack |
| Storage KV value / quota | 5 MB per value · 256 MB default quota (clamp 1 MB–2 GB) | `app-sandbox.js` StorageLedger |
| IPC request / payload / HTTP body budgets | 60 s default request timeout (5 s–10 min) · 256 KB payload (1 KB–8 MB) · 16 MiB body (64 KB–64 MiB) · 10 min interactive dialogs | `app-sandbox.js:263-274`; `:11040-11053` |
| Notifications | 32 channels · 10 posts/min · 60 tag-updates/min · 100 stored · 3 actions · 20 pending action clicks | `notifications/service.js:21-35`; `app-sandbox.js:1040-1072` |
| Badges | 0–999 count or 1–4-char text · 30/min | `app-sandbox.js:7516-7518` |
| Alarms | 32/app · ≥15 min period · ≤1 yr horizon · name ≤64 · queue 8 | `app-sandbox.js:7911-7915` |
| Background | wake sweep 15 min · wake deadline 10 s · no CPU/mem budget | `app-scheduler.js:46,58` |
| fs watchers | 8/app · 60 events/min | `app-sandbox.js:7611-7612` |
| Pickers | ≤25 multi-select · ≤10 MB per picked file · ≤20 accept entries | `app-sandbox.js:8802-8973` |
| Share sheet | 5/min · text ≤4000 · ≤6 share targets in sheet | `app-sandbox.js:7800, 4103` |
| App-IPC | 20 broadcasts/min · 25 s invoke timeout | `app-sandbox.js:6100-6144` |
| Cross-app launches | 30/min | `app-sandbox.js:3891` |
| Secrets | 64/app · 8 KiB value | `app-secrets.js:37-39` |
| Registry | 16 path segments · 256 KiB value · per-hive caps | `nova-registry.js:83-96` |
| Serve registry | 5 min heartbeat · 30 min idle prune | `app-sandbox.js:1126-1129` |
| Sandbox launch delay | 250 ms (NW.js content-script race) | `app-sandbox.js:14328` |
| Permissions catalog | 52 permissions · 11 categories · 4 risk tiers | `app-permission-manager.js:15-245` |
| Grant expiry | non-permanent 1 day · unused-app sweep 30 days · root never | `app-permission-manager.js:457-530` |
| Prompt rate limit | 3/60 s per app+permission · cooldown 5 s→15 min | `app-permission-manager.js:264-277` |
| Default sandbox attr tokens | `allow-scripts allow-forms allow-popups allow-modals allow-downloads` | `app-sandbox.js:13477-13485` |
| EventLog ring / downloads history | 500 / 500 entries | `event-log/service.js:28`; `downloads-history/service.js:4` |
| Escaped-popup size clamps | width 360–75% host · height 300–85% host | `app-sandbox.js:13625-13626` |
| Nested-view commands | zoom 0.25–5 · UA override ≤512 · executeScript/insertCSS ≤1 MB | `system-webview/service.js:589-665` |

---

## 15. OS version compatibility

**What the code guarantees:**

- **Feature detection, not version sniffing**: `window.novaOS.capabilities.has(name)` against a frozen list of 28 capability names (`storage.v2`, `fs.v2`, `alarms.v1`, `registry.v1`, …). A capability name means *the runtime ships the surface* — it says nothing about your permission state. `novaOS.apiVersion` is `2`.
- **The v1 channel surface is frozen**: existing `nova:*` channels keep working (pinned by `guest-bridge.suite.js` on every change); new behavior ships as new API, and the v2 facades are sugar over the same channels.
- **Legacy `vfs:*` compatibility**: five permission aliases (`vfs:access/read/write/delete → fs:access`, `vfs:metadata → fs:metadata`) translated at registration and at runtime request; channel aliases at the IPC front door (`vfs:read/write/delete/list/mkdir/stat/rename/move`, plus the `vfs:metedata`/`nova:vfs:metedata` typo forms → `nova:fs:stat`). The alias table is exact — no prefix wildcard; unknown `vfs:*` names return `UNKNOWN_API`. Translation never weakens enforcement (aliases resolve before the MAC check).

The 28 capability names (frozen list, `app-sandbox.js:10255-10299`):

```text
storage.v2  fs.v2  clipboard.v2  notifications.v2  window.v2  dialogs.v2  app.v2  data.v2
locale.v1  badge.v1  fsWatch.v1  alarms.v1  secrets.v1  shareTarget.v1  push.v1
settings.v2  ready.v2
events.v2  geolocation.v2  media.v2  calendar.v2  contacts.v2  mail.v2  admin.v2
background.v2  permissions.v2  net.v2  registry.v1
```

**What the code does not guarantee:** there is **no per-version capability history anywhere in the code** — nothing records which OS version introduced which capability, permission, or channel. If you need "is this OS newer than X", the only signals are `osVersion`/`securityPatch` from `ready.get()` (readable strings, no comparison machinery) and capability detection. Runtime APIs and permissions can also differ between NBOSP forks (forks may rotate keys); the format is used by NovaByte OS and compatible NBOSP forks, but fork behavior is not pinned by this repo.

---

## 16. Glossary

| Term | Definition |
|---|---|
| **NBOSP** | The platform implementation repo (`NBOSP/`) — NovaByte System/OS Platform. The NW.js app, local server, sandbox engine, and Buildroot image. |
| **NovaByte OS** | The operating system product built from NBOSP: NW.js host page + Node server on a Linux kiosk image. Current version 3.0.2. |
| **`.novaapp`** | The app package format: pretty-printed JSON (`novabyte_app`, `compiled_at`, `manifest`, `files` base64 map, `signing`, `signature`, `integrity`). Not a zip. |
| **NovaByte Studio** | External GUI packager (`github.com/dirazcoder/novapack-studio`, Apache-2.0, NW.js desktop IDE; v1.2.34 verified @ `7236672`). Build flow: guide §5.6. |
| **Publisher portal** | The Supabase-backed publishing site (account → submit → automated review → admin approval → server signing → catalog) at `novabyteteam.github.io/novabyte-os`. |
| **Store** | `com.nbosp.store` — the built-in catalog app; merges the static `apps.json` and community catalogs, installs and updates apps. |
| **App Manager** | `com.nbosp.appmanager` — install/uninstall/permissions/defaults management UI; the reference install path with the full scanner + trust gauntlet. |
| **Packages app** | `com.nbosp.packages` — Developer-Mode-only signing/verification/install tool (Sign/Verify/Install tabs, bypass checkboxes). |
| **NovaReg** | `com.nbosp.novareg` — the registry editor app (Developer Mode). |
| **Developer Mode** | Machine setting `HKNS/system/devMode`. Unlocks devOnly apps (Console, Modules, Packages, Permissions), the debug overlay; prerequisite for Root Access. Apps cannot set or bypass it. |
| **Root Access** | Machine setting `HKNS/security/rootAccessEnabled`; requires Developer Mode. Makes `system:root` grants *effective* — individually approved apps run in the OS page via an audited `OS.root` broker backed by passwordless sudo. Not Linux root itself. |
| **system app** | An app whose record satisfies the verified triple (`verified && signer === 'NovaByte System' && manifest.system`). Cannot be uninstalled or replaced. The manifest flag alone has no authority. |
| **test-keys / release-keys** | `TrustStore.systemSignatureTier()` values (AOSP analogue). test-keys = System anchor is the committed public test pair; release-keys = anchor rotated via `NBOSP_SYSTEM_SIGNING_PUBLIC_JWK`. |
| **HKNS / HKNU / HKNA / HKND** | Registry hives: **HKNS** machine system (system apps / `registry.system` only; `HKNS/security` needs `registry.system` even to read) · **HKNU** per-user (default app write scope `HKNU/software/<appId>/`) · **HKNA** per-app (`HKNA/<appId>/` — the app's own subtree) · **HKND** developer (writes need Developer Mode). |
| **MAC / NB-MAC** | The JS-side mandatory-access-control engine ("NB-MAC"): every sandboxed IPC call passes a policy-table check before any handler runs; denials read `Blocked by system security policy (MAC): …`. |
| **trusted host tier** | Execution tier for first-party bundles: `unrestrictedEntry` script injected directly into the OS host page (no webview), gated by UnrestrictedGate's six checks. |
| **sandbox tier** | The default execution tier: isolated `<webview>` with sandbox attribute, opaque origin, per-app partition, bridge-only OS access. |
| **capability** | A feature-detection name in `novaOS.capabilities.has()` (28 exist, e.g. `storage.v2`). Means the runtime ships the surface — never a permission statement. |
| **Content Scanner** | The heuristic tripwire (`window.Scanner`) swept over package files on the App Manager / Files / IPC install paths; flags obfuscation, remote scripts, unsandboxed iframes, disguised binaries. Not an AV engine, and skipped on the Packages/Store/my-apps paths. |
| **stable alias** | The relaunch-stable serving URL `/api/apps/serve/sandbox_<appId>/` registered alongside the per-session path — the pre-registerable OAuth `redirect_uri`. |
| **OPFS** | Origin Private File System — the browser storage backend where installed package files are persisted (`apps/<safeAppId>/files/…`). |
| **web app (`webapp_*`)** | An external-URL shortcut (App Manager → Web Apps panel), not a `.novaapp`: no capability shim, no manifest permissions beyond the launch prompt set. |
| **grant** | A persisted user consent record `{appId, permission, granted, grantedAt, permanent, expiresAt, reason, lastUsed}` keyed `appId:permission`; the thing every host-side check reads. |

---

## 17. Unverified

> NovaByte Studio items that were listed here (UI workflow, `novaapp.json` acceptance, `emcc` compilation, integrity defaults) were resolved by auditing the Studio source — see [§5.6](#56-novabyte-studio--the-gui-packager) and the addendum in [`AUDIT.md`](../AUDIT.md).
>
> **Partly resolved (U-06):** `apps.json` is a required base layer — the Store
> client throws if it isn't an array — and Supabase entries are merged in with
> remote data winning. The 16 apps in the store come from Supabase. What remains
> open is whether the raw-GitHub fallback path also merges Supabase or returns
> only the static file. The publisher portal, Supabase backend, and review queue
> are confirmed operational (U-07).
>
> **Resolved (U-15):** the per-app-UID/seccomp/cgroup isolation stack did exist
> — described in `os/README.md` at `99a6c44` (2026-10-25), removed at `2d24c6e`
> (2026-10-28). The supervisor code itself was not confirmed complete before
> removal.
>
> **Unverified:** the exact set of emitters for OS-bus events on future versions — this guide states emitter status as of the audited tree (14 of 18 allowlisted event names have no emitter today).
