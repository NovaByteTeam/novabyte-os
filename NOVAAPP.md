# `.novaapp` App Development Guide

This guide documents the `.novaapp` package format and the APIs available to sandboxed apps on NovaByte OS and compatible NBOSP systems. Studio setup, templates, and Studio builds are covered in the [NovaByte Studio README](./README.md).

## Manifest Format

Every app needs a `manifest.json` at the root of its directory (`novaapp.json` is also accepted).

### Minimal manifest

```json
{
  "id": "com.example.myapp",
  "name": "My App",
  "version": "1.0.0",
  "entry": "index.html"
}
```

### Full manifest

```json
{
  "id": "com.example.myapp",
  "name": "My App",
  "version": "1.0.0",
  "description": "A short description",
  "author": "Your Name",
  "email": "you@example.com",
  "website": "https://example.com",
  "entry": "index.html",
  "icon": "box",
  "type": "blank",
  "permissions": ["fs:read:images"],
  "optionalPermissions": ["device:notifications"],
  "ipc": {
    "exports": [],
    "receives": []
  },
  "notifications": {
    "channels": [
      { "id": "messages", "name": "Messages", "importance": "high" }
    ]
  },
  "handles": {
    "extensions": [".mp3", ".flac"]
  },
  "defaultSize": [800, 560],
  "minSize": [400, 300],
  "maxSize": [1600, 1200],
  "resizable": true,
  "frame": true,
  "categories": ["utilities"]
}
```

### Required fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique app ID — reverse domain format (see [App ID format](#app-id-format)) |
| `name` | string | Display name shown in the OS |
| `version` | string | Semantic version `x.y.z` |
| `entry` | string | Main HTML file to load |

### Optional fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `description` | string | — | Short description |
| `author` | string | — | Your name |
| `email` | string | — | Contact email |
| `website` | string | — | Your site |
| `icon` | string | `"box"` | Icon Lucide name, data URI, or URL |
| `type` | string | `"blank"` | App type |
| `unrestrictedEntry` | string | — | Packaged JavaScript entry used by OS-managed unrestricted launch paths |
| `permissions` | array | `[]` | Required capabilities; missing sensitive grants are requested at launch, but denial does not block the app |
| `optionalPermissions` | array | `[]` | Optional permissions — app must handle denial gracefully |
| `defaultSize` | array | `[800, 560]` | `[width, height]` in pixels |
| `minSize` | array | `[400, 300]` | Minimum window size |
| `maxSize` | array | — | Maximum window size |
| `resizable` | boolean | `true` | Whether the window can be resized |
| `frame` | boolean | `true` | Whether the window has a title bar |
| `transparent` | boolean | `false` | Enables an alpha-capable sandboxed app surface |
| `categories` | array | `[]` | App categories for filtering |
| `handles` | object | — | File extensions, URL protocols, MIME types, and roles your app can open — see [Default Apps](#default-apps) |
| `ipc` | object | — | App-to-app service/provider endpoints and broadcast actions your app accepts — see [Inter-app communication](#inter-app-communication) |
| `notifications` | object | — | `{ "channels": [...] }` registered before your first post — see [Notifications](#notifications--novanotifications) |
| `allowNestedWebview` | boolean | `false` | Manifest opt-in required (with the user grant) for `sandbox:nested-webview` |
| `allowPopupsToEscapeSandbox` | boolean | `false` | Manifest opt-in required (with the user grant) for `sandbox:escape-popups` |
| `sandbox` | object | — | `{ "allowSameOrigin": true }` manifest opt-in required (with the user grant) for `sandbox:same-origin` |

### Sandboxed execution and system APIs

Third-party packages run inside an isolated app webview. Trusted, bundled NovaByte System apps are different: after the OS verifies their signature, integrity, and first-party bundle identity, they run directly in the OS page with unrestricted host access. They are not sandboxed, and this path is only for OS-controlled system code — a package cannot gain it by setting `system: true` or claiming the NovaByte System signer.

`unrestrictedEntry` names the packaged JavaScript file used by OS-managed unrestricted launch paths. Ordinary app content loads from `entry`. A third-party package can request `system:root` to run its `unrestrictedEntry` directly in the OS page, but that is a separate, critical permission — not a system-app signature. It is available only when Developer Mode and Root Access are enabled, and requires the user's explicit grant acknowledging the app runs outside its sandbox.

The `system:root` grant gives the app unrestricted host-page access; it does not by itself run Linux commands as root. For privileged OS operations the app must call the OS `NovaRoot` broker (`window.NovaRoot`). The broker checks the live grant and settings, shows a NovaByte-owned confirmation prompt, and runs argv-based commands through passwordless `sudo`. The prompt authorizes a temporary session (up to 15 minutes); the command's system changes may persist after that session ends. This requires `sudo` and the NBOSP passwordless sudoers rule in the OS image. The broker audits its own root operations but cannot audit arbitrary JavaScript run by an unrestricted app.

Built-in headless system services also run in the OS page, not in isolated AppSandbox guests. Their startup is restricted to the verified first-party system bundle and declared service manifest.

### App ID format

Use reverse domain name notation. Studio's manifest validation enforces this at Build time.

```
✅  com.example.myapp
✅  io.github.username.app
✅  webapp_uniqueid          ← web app shortcut IDs use this prefix instead
❌  MyApp                    ← no uppercase
❌  myapp                    ← needs at least one dot
```

### Default Apps

Declaring a `handles` block makes your app selectable in **Settings → Default Apps** and in the file context menu's **Open with...** chooser for matching types, alongside the built-in apps (Browser, TextEdit, Music, Gallery, Email, Calendar). Apps may also declare the `home` role to be offered as a Home app:

```json
{
  "handles": {
    "extensions": [".webp"],
    "mimeTypes": ["image/heic"],
    "roles": ["home"]
  }
}
```

`protocols`, `extensions`, `mimeTypes`, and `roles` are independent and optional — declare whichever applies, or omit `handles` entirely. `roles` currently supports `home`; declaring it only makes the app eligible, the user must choose it in Settings. A selected third-party Home app is hosted in a full-screen sandboxed surface, not an OS application window, and does not receive host-page access. Home selection takes effect after the OS page reloads. Extensions are matched case-insensitively and should include the leading dot (`.mp3`, not `mp3`); protocols and MIME types are matched case-insensitively, MIME parameters are ignored, and subtype wildcards such as `image/*` are supported.

`handles` is a **discovery/selection** declaration, not a permission — it grants no ambient file access and there is no `handles:*` permission string. When the user opens a file through **Open with...**, the launch receives a `fileIntent` object in `window.__NOVA_APP_OPTIONS__`, and the host grants that sandbox access to only that selected file: read and write via `nova:fs:read` / `nova:fs:write` by file id, with no directory listing or access to other files. A user choice applies once unless they pick **Always use this app for this file type**; the OS re-checks the declaration and installed status at every launch, so a stale choice or a type the app no longer declares grants nothing.

Files opened without a matching `handles` declaration do not receive this scoped grant. Any installed `.novaapp`, including unsigned/Unverified ones, is eligible to appear in the chooser for types it declares; the OS does not currently restrict which apps may claim which types.

A sandboxed file manager can show the same OS chooser for a file it can access by calling `window.nova.openWith(fileId)`:

```javascript
fileMenuItems.push({
  label: 'Open with…',
  action: async () => {
    const result = await window.nova.openWith(file.id);
    if (result.cancelled) return;
    if (!result.success) console.error('The selected app could not be opened');
  }
});
```

The host checks the file is within the calling app's accessible filesystem scope before displaying the chooser. The app cannot pass a path or file contents to this API. It resolves to `{ cancelled: true }` if the user dismisses the chooser (or no compatible app is installed), or `{ cancelled: false, success, appId, windowId, defaultSaved }` after a choice. It shows the chooser every time; it never silently launches a remembered default.

```javascript
const intent = window.__NOVA_APP_OPTIONS__?.fileIntent;
if (intent?.action === 'open') {
  const file = await window.nova.ipc('nova:fs:read', { id: intent.file.id });
  // `file.data` is the selected file's content.
  // Saving this same file is scoped to this launch:
  await window.nova.ipc('nova:fs:write', {
    id: intent.file.id,
    content: 'Updated content'
  });
}
```

---

## Build process

When you hit Build in Studio:

- Reads and validates `manifest.json` (or `novaapp.json`)
- Validates the app ID format and all declared permissions against the known permission list
- If the project has a C/C++ source file (e.g. `module.cpp`, from the `native-cpp` template), compiles it with `emcc` first — output is `module.js` (glue) + `module.wasm`, bundled like any other file. The Build button turns purple when C/C++ sources are detected. Requires `emcc` on your PATH.
- Reads every file in the project directory and Base64-encodes it
- Generates an Ed25519 signature over the manifest + files payload
- Writes `<app.id>.novaapp` to your chosen output directory

### Headless system services

NovaByte's built-in headless services are first-party `.novaapp` packages whose entry scripts run directly in the OS page with unrestricted host access. Their manifests use `system: true`, `systemService: true`, and a packaged `unrestrictedEntry`; they have no user-facing window. This is privileged OS code, not sandboxed third-party execution.

Startup order is declared in `js/apps/system-service-manifest.json`. The loader checks package identity, integrity, and the NovaByte System signature against the trust store before launching each service. A manifest's `system` field alone is not authoritative. Framework/bootstrap pieces such as `boot.js`, `kernel.js`, `app-registry.js`, and trust/security initialization also run as OS-page scripts because they are prerequisites for safely loading packages.

Rebuild the built-in services after changing their source:

```sh
node build-apps.mjs js/apps background-apps calendar-notifier default-apps event-log notifications registry scanner server-events-bridge system-dialogs system-events
```

`npm start` and `npm run dev` build the NovaApp packages automatically. Set `NBOSP_SKIP_APP_BUILD=1` to skip that build and use the packages already on disk:

```powershell
$env:NBOSP_SKIP_APP_BUILD = '1'
npm start
```

Remove it with `Remove-Item Env:\NBOSP_SKIP_APP_BUILD` when you want the automatic build again.

---

## App Runtime

When a `.novaapp` is installed and launched, here's what actually happens:

### Install

The App Manager reads the file, validates the manifest fields (`id`, `name`, `version` are required), checks the signature (prompting the user if it fails rather than blocking outright), saves the app data to `localStorage` under `nova_installed_apps`, and calls `registerNovaApp()` so the app appears in the launcher.

In **App Manager → Packages**, user-facing system apps remain visible. Developer tools, the built-in launcher, and headless system services are hidden by default; enable **Show hidden apps** to inspect them. The launcher and headless services cannot be opened from App Manager, and headless services are managed by NovaByte rather than launched, disabled, or uninstalled individually.

### Launch — permission gate

Declaring a permission explains what your app may request; it does not grant access by itself. Low-risk permissions — public internet, public WebSockets, clipboard writing, notifications — are auto-granted unless the user previously denied them. `fs:access` is special all-files access: users enable it manually in Settings, and apps cannot prompt for it. Apps can always access their own `/data/` files; shared media uses type-specific read permissions; documents are opened or saved only after user selection in a file picker. Missing required medium-or-higher permissions go through the consent queue; denying one never blocks app launch — only that capability fails when called. Optional sensitive permissions are not prompted at launch: request them with `window.nova.requestPermission(...)` when the related feature is used.

This follows the Android distinction between ordinary install-time capabilities and sensitive access. Auto-grant is based on the OS risk catalogue, not on an app's `required` label, and a previous denial is never silently replaced.

Design each sensitive feature to be independently optional: explain the reason at the moment of use, request the permission then, and offer a useful fallback if it is denied.

### Launch — sandbox

Third-party apps run inside an NW.js `<webview>` element, not an iframe — a separate renderer process, not a same-document sandbox. There is no `window.parent`/`contentWindow` reference between guest and host, so the two sides cannot reach each other via DOM references or `postMessage`. Communication with the OS happens exclusively through `window.nova`, described below.

`allow-same-origin` is **not** granted to third-party apps by default — only to an audited allowlist of first-party system apps (exempted by app id, not by holding any permission). Granting it to a third-party app gives its guest content access to cookies/localStorage/sessionStorage on the shared origin, which widens the impact of any XSS inside that app. If your app genuinely needs it, **both** of these must be true, or `sanitizeSandboxAttr()` strips it and your webview runs without it:

1. Your manifest declares `sandbox: { allowSameOrigin: true }`, **and**
2. The user has granted the `sandbox:same-origin` permission (declare it in `permissions` so it's requested at launch — see [Permissions](#permissions)).

Declaring the manifest flag without the permission (or vice versa) still gets you a sandbox with no `allow-same-origin`. This is `high` risk — expect extra scrutiny before your app is verified.

**Do not rely on raw browser storage for durable data or guaranteed erasure.** Apps without `sandbox:same-origin` have their `persist:app_<appId>` execution partition cleared on final close; cleanup is serialized per app and a new launch waits for any required clear to finish. If clearing fails, the OS logs the failure and refuses to launch that app until a later retry succeeds. Revoking `sandbox:same-origin` closes that app's live sandbox windows and marks the partition for cleanup before a replacement launch. This is a fail-closed cleanup policy, **not** a forensic secure-erasure guarantee, and it does not affect `nova:storage:*` or the separate partitions used by nested browser views. For settings and save data that must persist, use [Storage](#storage); never store secrets in raw `localStorage` or cookies.

If your app just needs data to survive across launches — settings, save state, caches — don't request `sandbox:same-origin` for this. Use [`nova:storage:*`](#storage), which is durable by default, requires no permission, and isn't affected by any of this.

**Nested browser views:** creating an in-app browser view is gated separately and blocked by default. The supported Nova browser API is documented in [Building browser apps](#building-browser-apps). Legacy `<webview>` creation is proxied for compatibility; the host creates a sibling web-content view rather than a native child webview inside the app renderer. Both an app opt-in and the user's grant are required:

1. Your manifest declares `"allowNestedWebview": true` or `sandbox:nested-webview` in `permissions`, **and**
2. The user has granted the `sandbox:nested-webview` permission.

Without either opt-in or the grant, access is blocked. This is a critical permission because browser views expose live third-party web content and navigation; host-side network permissions continue to apply inside them.

The old advice to delay the first navigation by one second is obsolete. The host-mediated implementation creates the web-content view outside the app renderer. Prefer `window.nova.browser.createView()`: it waits for host-side view creation before starting the first navigation and gives your app a stable Nova API.

### Building browser apps

Use the Nova browser API for an in-app browser. It creates a host-managed browser view and exposes Nova event names and Promise-based operations; app code does not need `BrowserWindow`, `webContents`, `ipcRenderer`, `require('electron')`, or direct access to `OS`. The older nested `<webview>` proxy remains for compatibility, but new browser apps should prefer `window.nova.browser`.

#### 1. Declare browser permissions

```json
{
  "id": "com.example.browser",
  "name": "Example Browser",
  "version": "1.0.0",
  "entry": "index.html",
  "allowNestedWebview": true,
  "permissions": [
    "sandbox:nested-webview",
    "net:external"
  ]
}
```

`sandbox:nested-webview` allows the app to create a browser view. `net:external` allows it to navigate to public HTTP(S) sites and download external content. Declared public internet and WebSocket permissions are auto-granted unless previously denied. Internal NovaByte services and private-network destinations still require `net:internal`; `net:external` cannot reach them. If the nested-webview grant is absent, `window.nova.browser` is not available.

#### 2. Add the browser viewport and controls

Keep the viewport in a container with a definite height. The host-managed view fills the container:

```html
<form id="address-form">
  <button id="back" type="button" aria-label="Back">Back</button>
  <button id="forward" type="button" aria-label="Forward">Forward</button>
  <button id="reload" type="button">Reload</button>
  <input id="address" type="text" autocomplete="url" aria-label="Address or search">
  <button type="submit">Go</button>
</form>
<div id="browser-viewport" style="height: 600px"></div>
<p id="browser-status" role="status"></p>
<script src="app.js" defer></script>
```

The host enforces deferred execution for packaged external scripts even if `defer` is omitted. Keeping the attribute is still useful when testing the page outside NovaByte OS.

#### 3. Create a view and connect navigation

`createView()` resolves to a `BrowserView`. It installs its event listeners before it starts the initial navigation. A URL passed to the app through `nova:open-url` takes precedence over the optional initial `url`, so links opened by the OS are not replaced by the browser's home page.

```javascript
const HOME = 'https://example.com';
let browserView;

function addressToUrl(value) {
  const input = value.trim();
  if (!input) return null;
  if (/^https?:\/\//i.test(input)) return input;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(input) && !input.includes(' ')) {
    return 'https://' + input;
  }
  return 'https://www.google.com/search?q=' + encodeURIComponent(input);
}

async function main() {
  const address = document.getElementById('address');
  const status = document.getElementById('browser-status');
  const viewport = document.getElementById('browser-viewport');

  browserView = await window.nova.browser.createView({
    container: viewport,
    url: HOME,
    pollingInterval: 1000
  });

  browserView.addEventListener('url-change', event => {
    if (document.activeElement !== address) address.value = event.detail.url;
  });
  browserView.addEventListener('title-change', event => {
    document.title = event.detail.title || 'Browser';
  });
  browserView.addEventListener('navigation-start', () => {
    status.textContent = 'Loading…';
  });
  browserView.addEventListener('navigation-complete', () => {
    status.textContent = '';
  });
  browserView.addEventListener('navigation-error', event => {
    status.textContent = event.detail.errorDescription || event.detail.reason || 'Navigation failed';
  });
  browserView.addEventListener('state-change', event => {
    document.getElementById('back').disabled = !event.detail.canGoBack;
    document.getElementById('forward').disabled = !event.detail.canGoForward;
  });

  document.getElementById('address-form').addEventListener('submit', async event => {
    event.preventDefault();
    const url = addressToUrl(address.value);
    if (url) await browserView.navigate(url);
    address.blur();
  });
  document.getElementById('back').addEventListener('click', () => browserView.back());
  document.getElementById('forward').addEventListener('click', () => browserView.forward());
  document.getElementById('reload').addEventListener('click', () => browserView.reload());
}

main();
```

Navigation and download calls return Promises. Handle rejections in UI actions so permission denials and host errors are visible.

#### Browser API reference

```javascript
const view = await window.nova.browser.createView({
  container,            // required DOM Element
  url: 'https://…',     // optional; a pending OS open-url target takes precedence
  pollingInterval: 1000 // optional: 0 disables polling; otherwise 250–10000 ms
});
```

`BrowserView` exposes:

| Member | Behavior |
|--------|----------|
| `element` | The host-managed view element. Prefer the methods below. |
| `url`, `title`, `loading` | Latest known state. URL and title are also refreshed by polling, which catches client-side history changes. |
| `canGoBack`, `canGoForward` | Latest history availability (`null` until state is first queried). |
| `getState()` | Promise for `{ url, title, loading, canGoBack, canGoForward }`. |
| `navigate(url)` | Navigate to a URL; the host enforces network permissions. |
| `back()`, `forward()`, `reload()`, `stop()` | Browser navigation controls. |
| `find(query, options)` | Search page text; resolves with the match count and active match. Options: `backward`, `matchCase`, `wordStart`, `medialCapitalAsWordStart`. |
| `stopFinding(action)` | End page search; `action` is `clear`, `keep`, or `activate` (defaults to `clear`). |
| `setZoom(factor)` | Set page zoom from `0.25` through `5`. |
| `setZoomMode(mode)` | Set `per-view`, `per-origin`, or `automatic` zoom behavior. |
| `setUserAgent(userAgent)` | Override the view's user-agent string (maximum 512 characters). |
| `clearData(types)` | Clear selected site-data categories for this app's browser partition (for example `['cookies', 'cache', 'localStorage', 'indexedDB']`). |
| `executeScript(code)` | Execute JavaScript in the loaded site and resolve with its result. Treat page script execution as privileged; it runs with that site's access. |
| `on(type, listener)` | Listen for an event; returns an unsubscribe function. `addEventListener` / `removeEventListener` are also supported. |
| `destroy()` | Stop polling and remove the view. Call this when permanently discarding a view. |

Nova events use `CustomEvent`; read event-specific information from `event.detail`.

| Event | Detail |
|-------|--------|
| `navigation-start` | Top-level navigation started. |
| `navigation-redirect` | Navigation redirect details. |
| `navigation-commit` | Top-level committed URL and navigation details. |
| `navigation-complete` | Current state after the page load completes. |
| `navigation-error` | `{ url, reason, errorCode, errorDescription, isTopLevel }`. |
| `url-change` | `{ url, previousUrl }`, including in-page URL changes found by polling. |
| `title-change` | `{ title, previousTitle }`. |
| `state-change` | Current URL/title/loading/history state. |
| `state-error` | `{ error }` when the host cannot refresh browser state. |
| `new-window` | `{ url, disposition, width, height, window }`; decide whether to block, open a tab, or display a popup. |
| `download-request` | `{ url }` when page content requests a download. |
| `close`, `crash`, `destroy` | View lifecycle notifications. |

#### Host-rendered overlays

App DOM cannot paint above a host-managed browser view because it runs in a separate renderer. Use `window.nova.overlay.show()` to render custom HTML and CSS in a sandboxed host-layer frame. It requires the `sandbox:nested-webview` grant. The optional `bounds` are relative to the app viewport in CSS pixels; omitted bounds cover the app viewport. Use `data-nova-action` and `data-nova-field` attributes to receive user interactions. Call `hide()` when the overlay is no longer needed; replacing it, closing the app, or revoking the browser-view permission also removes it.

```javascript
const removeOverlayListener = window.nova.overlay.onEvent(event => {
  if (event.type === 'click' && event.action === 'close-bookmarks') {
    window.nova.overlay.hide();
  } else if (event.type === 'input' && event.field === 'search') {
    filterBookmarks(event.value);
  }
});

await window.nova.overlay.show({
  bounds: { left: 0, top: 0, width: 320, height: 560 },
  html: `
    <aside class="bookmark-panel">
      <header><strong>Bookmarks</strong>
        <button data-nova-action="close-bookmarks">Close</button>
      </header>
      <input data-nova-field="search" placeholder="Search bookmarks">
    </aside>
  `,
  css: `
    .bookmark-panel { box-sizing: border-box; height: 100%; padding: 16px;
      color: #eee; background: #252538; font: 14px sans-serif; }
    header { display: flex; justify-content: space-between; }
  `
});
// Later, when the app is disposed:
removeOverlayListener();
await window.nova.overlay.hide();
```

Overlay HTML is sanitized and runs in a script-disabled frame with network access blocked; scripts and inline event handlers in the markup are not run. The `onEvent` callback receives `click`, `input`, `change`, `submit`, or `keydown` events with the `action`/`field` value and relevant input `value`, checkbox `checked`, or key `key`. `show()` resolves with `{ success: true, overlayId }`.

For simple native-style menus, use `window.nova.contextMenu.show()`. Coordinates are client coordinates in the app viewport, such as `event.clientX` and `event.clientY`. Its Promise resolves with `{ cancelled: false, index }` after selection or `{ cancelled: true, index: null }` when dismissed:

```javascript
viewport.addEventListener('contextmenu', async event => {
  event.preventDefault();
  try {
    const result = await window.nova.contextMenu.show(event.clientX, event.clientY, [
      { label: 'Reload', icon: 'refresh' },
      { separator: true },
      { label: 'Close tab', danger: true }
    ]);
    if (!result.cancelled && result.index === 0) browserView.reload();
  } catch (error) {
    console.error('Could not show menu:', error);
  }
});
```

Menu items support `label` (required), `icon`, `shortcut`, `disabled`, and `danger`; separators use `{ separator: true }`. `window.nova.contextMenu.hide()` dismisses the current app menu.

#### Downloads and popups

Page-initiated downloads are denied by default at the native webview boundary. Handle `download-request` and use Nova's save-dialog-backed download method instead of granting a website filesystem access:

```javascript
browserView.addEventListener('download-request', async event => {
  try {
    const result = await window.nova.browser.download({
      url: event.detail.url,
      filename: 'download'
    });
    if (result.cancelled) return;
  } catch (error) {
    console.error('Download failed:', error);
  }
});
```

`download({ url, filename })` fetches through the app's permission-checked network bridge, then asks the user where to save the file. There is no size cap — the user's save-dialog confirmation is the control — but the payload is buffered in memory, so this is not a resumable or background download manager.

For `new-window`, create a view in your tab or popup container, then attach the pending popup to preserve the opener relationship:

```javascript
browserView.addEventListener('new-window', async event => {
  const popupView = await window.nova.browser.createView({ container: popupViewport });
  await event.detail.window.attach(popupView);
  if (event.detail.url) await popupView.navigate(event.detail.url);
});
```

Always provide a user-visible way to close popup views and call `destroy()` when a tab or popup is removed.

#### Browser-app boundaries

- Store bookmarks, history, preferences, and tab metadata with [`nova:storage:*`](#storage); never expose the host `OS` object to app code.
- The OS gives each app a persistent browser-content partition. Cookies and site storage are isolated from the app's own storage and other apps. The API does not let an app select arbitrary partitions or implement a private/incognito profile.
- `canGoBack` and `canGoForward` reflect URL history observed by the view, including polling discoveries. Use them for toolbar state; keep durable history UI in your app.
- Keep browser controls in the app's trusted UI, validate/normalize address-bar input, and never treat arbitrary user text as an executable URL scheme. Only HTTP(S) navigation is supported for nested browser views.
- Treat `executeScript()` as a privileged escape into the current site's page context. Use it only for explicit features and never interpolate untrusted strings into the script source.
- A browser app is responsible for tabs, history/bookmarks UI, downloads UI, popup policy, and user-facing error pages. The API does not provide browser extensions, engine internals, certificate-warning bypass, per-site permission prompts, download progress/resume, or profile management.
- Use [`window.nova.openUrl(url)`](#ipc-api--windownova) to hand a link to the OS-selected browser app rather than opening the system's external desktop browser.

### Launch — window.nova bridge

Before your app's HTML executes, the runtime injects `window.nova` into the guest's page — no import, no handshake required to start using it:

```javascript
window.nova.ipc(type, payload)        // → Promise, resolves with `result`, rejects with {code, message}
window.nova.requestPermission(...)    // convenience wrapper around nova:request-permission
window.nova.onEvent(eventName, cb)    // subscribe to pushed events (see Event bus below)
```

The `nova:ready` handshake fires automatically on load. Call it directly if you want the response (your app's metadata and actually-granted permissions):

```javascript
const info = await window.nova.ipc('nova:ready', {});
// { success, appId, permissions, optionalPermissions, osVersion, securityPatch }
console.log(info.permissions, info.optionalPermissions);
```

`window.fetch` and `XMLHttpRequest` inside your app are routed through the permission-checking bridge. `fetch()` remains the preferred API. The asynchronous `XMLHttpRequest` compatibility layer supports property callbacks and event listeners, string and supported binary/form request bodies (capped by the app's `httpBodyBytes` budget — 16 MiB by default), real CRLF response-header formatting, and text/JSON/ArrayBuffer/Blob response types. It intentionally rejects synchronous XHR. `timeout` raises timeout/loadend events in the guest but does not cancel the in-flight host request; incremental progress events, upload-target events, and credentialed XHR are not implemented. Use `fetch()` for new code.

There is no `window.__novaPrivateStore` — for isolated, namespaced storage use `nova:storage:*` (see [Storage](#storage)), which is backed by the host, not raw `localStorage` inside the guest.

---

## Permissions

Permissions are declared in `manifest.json` and checked before the app loads. Low-risk permissions are auto-granted unless previously denied; required medium-or-higher permissions are requested at launch, while optional sensitive permissions are requested when needed. Denying a permission never blocks app launch. Grants persist across sessions in `localStorage` (validated structurally on load) and unused app grants expire after 30 days of inactivity.

### Full permission list

41 permissions across 10 categories, mirroring `app-permission-manager.js` exactly — these are the only strings `validateManifest` recognizes without a warning.

The three Sandbox permissions have additional manifest opt-ins: `sandbox:nested-webview` requires the top-level `allowNestedWebview` field (or its declaration in `permissions`), `sandbox:same-origin` requires `sandbox.allowSameOrigin`, and `sandbox:escape-popups` requires `allowPopupsToEscapeSandbox`. The manifest flag **and** the matching user grant must both be present before the underlying sandbox attribute is added.

Filesystem permissions follow scoped-storage rules: app-owned files need no grants; shared media requires a matching read grant; document access is user-picker mediated. `fs:metadata` grants metadata-only access to shared files, not contents. `fs:access` is manually enabled special access for the shared filesystem and never grants access to another app's private `/data/` directory.

`system:background`, `system:background:live`, and `system:autostart` are three deliberately separate grants — see [Background execution](#background-execution--novabackground).

| Permission | Category | Risk | Useful for |
|------------|----------|------|------------|
| `fs:access` | Filesystem | Critical | Special access to shared files; users enable it manually in Settings |
| `fs:metadata` | Filesystem | Medium | Reading metadata for shared files without their contents |
| `fs:read:images` | Filesystem | Medium | Reading shared images |
| `fs:read:video` | Filesystem | Medium | Reading shared videos |
| `fs:read:audio` | Filesystem | Medium | Reading shared audio |
| `apps:communicate` | Apps | High | Calling other apps' exported services/providers and broadcasting (see [Inter-app communication](#inter-app-communication)) |
| `net:internal` | Network | High | Calling this OS's own API/server endpoints and explicitly authorized internal/private-network destinations; known cloud-metadata address literals are blocked by the network guards |
| `net:external` | Network | Low | Calling public internet services (auto-granted unless previously denied) |
| `net:websocket` | Network | Low | Public WebSocket connections (auto-granted unless previously denied) |
| `mail:read` | Email | High | Inbox viewers, search, unread-count widgets |
| `mail:write` | Email | Critical | Mark-as-read/move tools, compose-preview UIs, account connect/disconnect |
| `mail:send` | Email | Critical | Send-on-your-behalf tools (needs its own SMTP config — see [Mail](#mail--novamail--windownovamail)) |
| `mail:delete` | Email | Critical | Cleanup/triage tools (spam pruning, bulk delete) |
| `calendar:read` | Calendar | Medium | Agenda widgets, scheduling assistants |
| `calendar:write` | Calendar | High | Event creation, meeting schedulers |
| `calendar:delete` | Calendar | High | Calendar cleanup/sync tools |
| `contacts:read` | Contacts | Medium | Address-book pickers, CRM-style lookups |
| `contacts:write` | Contacts | High | Contact import/sync tools |
| `contacts:delete` | Contacts | High | Dedup/cleanup tools |
| `device:notifications` | Device | Low | Alerts, reminders, background-task completion pings |
| `device:geolocation` | Device | High | Maps, weather, location-tagged content |
| `device:camera` | Device | Critical | Photo capture, video chat, QR/barcode scanning |
| `device:microphone` | Device | Critical | Voice recording, voice chat, dictation |
| `clipboard:read` | Device | High | Paste-in tools, import-from-clipboard features — can expose whatever any other app or the user copied, not just your own app's data |
| `clipboard:write` | Device | Low | Copy-to-clipboard features (does not allow reading clipboard contents) |
| `system:info` | System | Medium | Diagnostics, "about this device" panels — also gates reading allowlisted settings values (see [Settings](#settings--novasettingsget--novasettingsset)) |
| `system:settings` | System | Medium | Preference sync, theme/settings dashboards |
| `system:apps` | System | Medium | Launchers, app-store-style installers, dock/dashboard replacements |
| `system:app-launch` | System | Low | Launching an installed app without access to app inventory or management |
| `system:root` | System | Critical | Runs the packaged `unrestrictedEntry` in the OS page after Developer Mode and Root Access are enabled and the user explicitly grants access; real root commands additionally require NovaRoot confirmation and working passwordless sudo |
| `system:events` | System | Medium | Reacting to protected OS-level events (see [Event bus](#event-bus--novaevents)) |
| `system:background` | System | Medium | Periodic sync/checks while closed (see below) |
| `system:background:live` | System | High | Staying alive after the window closes (see below) |
| `system:autostart` | System | High | Launching automatically at OS startup with no user action (see below) |
| `admin:apps` | Admin | High | Fleet/security audit tools — see actual grants per app, not just declared ones (needs admin mode) |
| `admin:users` | Admin | Critical | Session monitors, force-logout tools (needs admin mode) |
| `admin:system` | Admin | Critical | Security-policy dashboards, lockout/IP-block tuning (needs admin mode) |
| `admin:audit` | Admin | High | Security/activity log viewers (needs admin mode) |
| `sandbox:nested-webview` | Sandbox | Critical | Apps that create their own browser views for in-app browsing; requires the `allowNestedWebview` opt-in (or a `permissions` declaration) plus the user grant |
| `sandbox:same-origin` | Sandbox | High | Apps that need a stable origin for cross-tab logic, or `localStorage`/cookies that survive relaunch. Also requires `"sandbox": { "allowSameOrigin": true }` — the permission alone does nothing |
| `sandbox:escape-popups` | Sandbox | High | Apps whose popups need to open as normal, unsandboxed browser windows (e.g. OAuth flows, external checkout). Also requires `"allowPopupsToEscapeSandbox": true` — the permission alone does nothing |

`admin:*` additionally requires the machine itself to be in admin mode — a separate, local-only toggle in Settings → Privacy & Security → Admin Access. Granting an app an `admin:*` permission doesn't put the machine in admin mode by itself; both gates must pass, or the call is denied with a message saying so.

### Required vs optional

```json
{
  "permissions": ["fs:read:images", "net:internal"],
  "optionalPermissions": ["device:notifications"]
}
```

Required medium-or-higher-risk permissions are prompted for at launch, but a denial does not block the app from loading — check what was actually granted and degrade gracefully. Low-risk permissions are auto-granted regardless of which array they appear in, unless the user previously denied them. Optional sensitive permissions are not prompted at launch; users can grant them manually from Settings → Apps, or your app can request one at runtime.

### Requesting a permission at runtime

Use the `window.nova.requestPermission` convenience wrapper (or call `nova.ipc('nova:request-permission', ...)` directly — they're equivalent):

```javascript
const { granted } = await window.nova.requestPermission('fs:read:images', 'Needed to display shared images.');
console.log(granted); // true or false
```

`permanent` defaults to `true` (grant persists) unless explicitly set to `false`. The wrapper doesn't expose it — for a one-time, non-persistent grant, call `nova.ipc` directly:

```javascript
const { granted } = await window.nova.ipc('nova:request-permission', {
  permission: 'fs:read:images',
  reason: 'Needed to display shared images.',
  permanent: false,
});
```

#### Rate limiting

Every call to `requestPermission` shows a live dialog again, even if the permission was previously denied. A buggy or malicious app calling it in a loop could otherwise spam the user with dialogs, so requests for the same `appId:permission` pair are rate-limited:

- Up to **3 prompts within a rolling 60-second window** are shown normally.
- The next request in that window is **auto-denied with no dialog** (`granted` resolves to `false` immediately) and a cooldown starts.
- The cooldown is **5 seconds base**, **doubling for each consecutive denial** for that pair, capped at **15 minutes**. A grant resets the denial streak.
- Rate-limited requests are logged to `EventLog` (category `permissions`, severity `warn`) even though nothing is shown to the user.

Your app can't distinguish "the user clicked deny" from "auto-denied by the rate limiter" — both resolve `granted: false`.

To check cooldown status without triggering a prompt, use the `nova:permission-rate-limited` channel:

```javascript
const status = await window.nova.ipc('nova:permission-rate-limited', {
  permission: 'fs:read:images',
});
// { limited: false }
// or, mid-cooldown: { limited: true, retryAfterMs: 4213 }
```

Calling `resetPermission` clears both the grant and any rate-limit cooldown state for that pair.

---

## Storage

### Key-value storage — `nova:storage:*`

Per-app key-value storage via the OS bridge. There is no `window.__novaPrivateStore` object; isolated storage is host-side, namespaced by app ID — your app can never read or overwrite another app's data:

```javascript
await window.nova.ipc('nova:storage:set', { key: 'settings', value: JSON.stringify({ theme: 'dark' }) });
const { value } = await window.nova.ipc('nova:storage:get', { key: 'settings' });
await window.nova.ipc('nova:storage:delete', { key: 'settings' });
await window.nova.ipc('nova:storage:clear', {});
const { keys } = await window.nova.ipc('nova:storage:keys', {});
```

Host-backed storage is durable across launches regardless of permissions — raw `localStorage`/cookies inside the guest are not (see [Launch — sandbox](#launch--sandbox)).

### Modern storage — `window.novaOS.storage` (API v2)

New apps can use the separate `window.novaOS` facade. It is additive: `window.nova` and its existing methods, payloads, return objects, and error behavior remain unchanged for older packages.

```javascript
if (window.novaOS.capabilities.has('storage.v2')) {
  const theme = await window.novaOS.storage.get('theme'); // stored value, or null
  await window.novaOS.storage.set('theme', 'dark');
  await window.novaOS.storage.remove('draft');
  const keys = await window.novaOS.storage.keys(); // string[]
  await window.novaOS.storage.clear(); // clears this app's storage only
}
```

`window.novaOS.apiVersion` is `2`. `capabilities.has(name)` returns `true` only for capabilities supported by this runtime; the initial v2 capability is `storage.v2`. The v2 facade uses the same host-side storage service — per-app isolation, key validation, size limits, quota enforcement, and error behavior are identical; it introduces no parallel store or privileged route.

| Behavior | Legacy API (V1) | Modern API (V2) |
|---|---|---|
| Global name | `window.nova` (preserved) | `window.novaOS` (new) |
| Read a value | `nova:storage:get` returns `{ success, value }` | `storage.get(key)` returns the value, or `null` if missing |
| Write a value | `nova:storage:set` with `{ key, value }` | `storage.set(key, value)` |
| Delete a key | `nova:storage:delete` with `{ key }` | `storage.remove(key)` |
| List keys | `nova:storage:keys` returns `{ success, keys }` | `storage.keys()` returns `string[]` |
| Clear storage | `nova:storage:clear` | `storage.clear()` |
| Results | Response objects preserved | Mutations resolve `undefined`; reads return normalized values |

### Storage Ledger — budgets, accounting, and scoped roots

Every app gets a **ledger record** host-side: per-app resource budgets, byte/request accounting, and a shared-file access audit. Apps can't see the ledger itself (Settings reads it for the storage/privacy dashboards); what apps get is the behavior:

**Per-app budgets.** The old fixed OS-wide caps are now defaults in a per-app budget table, enforced on every call. An app can be granted a bigger budget without an OS update:

| Budget | Default | Was | Override range |
| --- | --- | --- | --- |
| `storageQuotaBytes` | 256 MB | 25 MB | 1 MB – 2 GB |
| `ipcPayloadBytes` | 256 KB | 64 KB | 1 KB – 8 MB |
| `httpBodyBytes` | 16 MiB | 6 MiB | 64 KB – 64 MiB |
| `requestTimeoutMs` | 60 s | 30 s | 5 s – 10 min |

Your app can read its own numbers — and only its own — through the v2 facade:

```javascript
const { usage, budget } = await window.novaOS.storage.usage();
if (budget - usage < 64 * 1024) pruneOldData();
```

**Scoped filesystem roots.** Raw `/data/...` paths remain caller-relative (the host injects your app's own id segment; there is no way to name another app's subtree). On top of that, three logical roots are accepted anywhere a path is:

```javascript
// 'appdata:' — YOUR own /data/<appId>/ subtree. Always caller-scoped.
await window.novaOS.fs.appdata.write('notes/todo.txt', 'hello');
const listing = await window.novaOS.fs.appdata.list('notes');

// 'shared:' / 'media:' — the shared tree (Documents, Downloads, …) under
// the same permission rules as raw paths: media grants, user-picked files,
// or fs:access. 'shared:' and 'media:' cannot address /data at all.
await window.nova.ipc('nova:fs:read', { path: 'shared:/Downloads/report.txt' });
```

`appdata:/someOtherApp/…` is not an escape: the caller-relative rewrite happens after scheme expansion, so it still lands in **your own** subtree.

**Shared-access audit.** Reads and writes outside your own `appdata:` subtree (shared files via grants, user-picked files) are logged to the ledger and surfaced in **Settings → Privacy & Security → File Access Audit**. Apps that stay inside their own sandbox generate no audit entries.

**Accounting.** Bytes written/read and request counts are tracked per app (storage sets, fs writes, fetch bodies) and power the **Settings → Storage → Per-App Storage** dashboard. Quotas are enforced by the system regardless of what the app does.

---

## IPC API — `window.nova`

Apps communicate with the OS via `window.nova.ipc(type, payload)`, injected automatically before your app's script runs:

```javascript
try {
  const result = await window.nova.ipc('nova:<category>:<action>', {
    // ... payload fields
  });
  console.log(result);
} catch (err) {
  // err.code and err.message are set for IPC-level errors (see Error codes below)
  console.error(err.code, err.message);
}
```

### App lifecycle and launch intents — `window.nova.app`

`nova:open-url` and app launches carry options into the new app session. Use the app facade instead of reading host globals:

```javascript
const info = await window.nova.app.getInfo();
const options = await window.nova.app.getLaunchOptions();

const removeLaunchListener = window.nova.app.onLaunch(({ options, reason }) => {
  if (options.url) navigateTo(options.url);
  if (options.sharedText) showSharedText(options.sharedText);
});

const removeStateListener = window.nova.app.onStateChange(({ visible, focused }) => {
  // Pause animations or defer nonessential refresh work while not visible.
});
```

`onLaunch` reports this app window's initial options; it is not an app-to-app broadcast channel. `onStateChange` reports this document's visibility/focus and returns an unsubscribe function. These lifecycle signals do not grant background execution; background work still requires the relevant `system:background*` permission.

### Inter-app communication

NovaByte uses host-brokered APIs rather than an Android-Binder-style direct channel. Explicit launches are available through `window.nova.app.launch(appId, options)` and require `system:app-launch`; this grant does not expose another app's data. `window.nova.openWith(fileId)` and `window.nova.openUrl(url)` use the OS's registered handlers/default apps for file and URL intents. A file opened through the OS chooser receives a temporary grant for that selected file only. There is no package-enumeration API through this broker, so there is no Android 11-style package-visibility query declaration.

For service requests, provider-style data methods, and app broadcasts, **both** apps must hold the high-risk `apps:communicate` permission. The receiving app must also declare each exported endpoint or broadcast action in its manifest; the host only routes requests to an active sandbox and never starts a provider app implicitly.

```json
{
  "permissions": ["apps:communicate"],
  "ipc": {
    "exports": [
      "service:com.example.weather.current",
      "provider:com.example.contacts.lookup"
    ],
    "receives": ["com.example.notes.changed"]
  }
}
```

The `service:` / `provider:` prefixes distinguish call kinds. Each endpoint is a request/reply callback implemented by the receiving app:

```javascript
const stopProviding = await window.nova.ipc.provide(
  'provider:com.example.contacts.lookup',
  async ({ sourceAppId, data }) => {
    if (data.query !== 'Ada') return null;
    return { id: 'contact-1', name: 'Ada' };
  }
);

const response = await window.nova.ipc.call(
  'com.example.contacts',
  'provider:com.example.contacts.lookup',
  { query: 'Ada' }
);
console.log(response.result);
```

Provider callbacks return data chosen by the provider; they do not grant access to its filesystem, database, or private app directory. Treat requests and returned data as untrusted, validate the request shape, and return only the minimum data needed. Requests time out after 25 seconds, carry up to the app's `ipcPayloadBytes` budget of JSON data (256 KB by default), and are rate-limited to 20 per minute per app and endpoint type.

Broadcast actions are opt-in and delivered only to active apps that declare the action under `ipc.receives`, subscribe to it, and hold `apps:communicate`:

```javascript
const stopListening = await window.nova.ipc.onBroadcast(
  'com.example.notes.changed',
  ({ sourceAppId, data }) => refreshNote(data.noteId)
);

await window.nova.ipc.broadcast('com.example.notes.changed', { noteId: 'note-1' });
```

Each `provide` and `onBroadcast` registration resolves to an unsubscribe function. `onEvent` remains the separate OS-event API. App broadcasts cannot forge system events.

### Appearance — `window.nova.appearance`

Reading the small, non-sensitive appearance snapshot and subscribing to its changes require no permission:

```javascript
const current = await window.nova.appearance.get();
const unsubscribe = await window.nova.appearance.onChange(appearance => {
  document.documentElement.dataset.theme = appearance.theme;
  document.documentElement.style.setProperty('--accent', appearance.accentColor || '');
  document.documentElement.classList.toggle('high-contrast', appearance.highContrast);
  document.documentElement.classList.toggle('reduce-motion', appearance.reduceMotion);
});
// later, when the view is disposed:
unsubscribe();
```

The API deliberately does not expose unrelated OS settings. `set` accepts only the supported appearance fields and validated values; it does not require `system:settings`. `onChange` calls the callback immediately with the current snapshot, then on each change. Updates are rate-limited to 10 per minute.

```javascript
await window.nova.appearance.set({
  theme: 'nord',
  accentColor: '#5e81ac',
  highContrast: false,
  reduceMotion: true,
  transparentSurfaces: true
});
```

### User-mediated sharing — `window.nova.share`

Opening the OS share sheet needs no permission: the user chooses whether to copy content, open a link in the OS default browser, email it, or cancel. The app cannot silently write to the clipboard or launch a recipient through this chooser:

```javascript
const result = await window.nova.share({
  title: 'Share this page',
  text: 'Useful note',
  url: 'https://example.com/article'
});
if (result.cancelled) return;
```

Only credential-free HTTP(S) links are accepted. Text is limited to 4000 characters and the chooser is rate-limited. The returned `action` identifies the user's choice.

### Picker-scoped files — `window.nova.files`

Use these methods to import or export a document the user explicitly selects. The picker mediates access to one chosen file or save destination. It can show shared user files and the calling app's own private data, never another app's private `/data/<app-id>/` folder:

```javascript
const opened = await window.nova.files.open({
  title: 'Import notes',
  accept: ['text/plain', 'application/json']
});
if (!opened.cancelled) {
  console.log(opened.file.id, opened.file.name, opened.file.content);
}

const saved = await window.nova.files.save({
  title: 'Export notes',
  filename: 'notes.txt',
  mimeType: 'text/plain',
  content: 'Exported content'
});
if (!saved.cancelled) console.log('Saved:', saved.file.path);
```

Open/save calls return `{ cancelled: true }` when dismissed. This first version is text-only and capped at 10 MB. A selected file's id can be used with `nova:fs:*` for the lifetime of that sandbox, with a confirmation for shared-file changes.

### Filesystem — `nova:fs:*`

The filesystem is scoped by ownership and user choice:

- Apps can read, write, list, rename, move, and delete files in their own `/data/` directory without declaring a filesystem permission.
- Shared images, videos, and audio require `fs:read:images`, `fs:read:video`, or `fs:read:audio` respectively. `fs:metadata` permits metadata-only access, not contents.
- Shared documents and other non-media files are accessed through a file picker. Selecting a file grants that sandbox access to that file for the session; modifying, renaming, moving, or deleting it asks the user to confirm.
- `fs:access` enables broad access to shared files. It is special access managed manually in Settings, not promptable. It never exposes another app's private `/data/` directory.
- Apps cannot delete the filesystem root, `/data`, or the Trash folder. App-owned files remain private while in Trash.

```javascript
// Read a file in your app's own storage (no permission required)
const { content, size, modified } = await window.nova.ipc('nova:fs:read', { path: '/data/notes.txt' });

// Read shared media only after declaring the matching permission
const image = await window.nova.ipc('nova:fs:read', { path: '/Pictures/photo.png' });

// List your app's files (no permission required)
const { files } = await window.nova.ipc('nova:fs:list', { path: '/data/' });
// files: [{ id, name, type, mimeType, size, modified, created }, ...]

// Get metadata only for a shared file (requires fs:metadata or its media read grant)
const { stat } = await window.nova.ipc('nova:fs:stat', { path: '/Pictures/photo.png' });
// stat: { id, name, type, mimeType, size, path, parentId, created, modified, accessed, tags }

// Write under your app's data (no permission required)
await window.nova.ipc('nova:fs:write', { path: '/data/notes.txt', content: 'Hello' });

// Create a folder under your app root; omit path for app root.
// NOTE: 'path' must include the trailing slash ('/data/', not '/data') — see
// the path-rewriting section right below for why this matters.
await window.nova.ipc('nova:fs:mkdir', { path: '/data/', name: 'exports' });

// Rename / move / delete in your app data (no permission required)
await window.nova.ipc('nova:fs:rename', { path: '/data/notes.txt', name: 'renamed.txt' });
await window.nova.ipc('nova:fs:move', { path: '/data/notes.txt', destPath: '/data/exports/notes.txt' });
await window.nova.ipc('nova:fs:delete', { path: '/data/notes.txt' });

// For shared documents, use nova:files.open() to choose one; destructive
// changes through nova:fs require a separate confirmation from the user.
```

#### `/data/` path rewriting — read this before you build anything

The most common first-app bug is a caller mistake: passing the wrong `/data/` path shape. The errors you'll hit (`NOT_FOUND`, `PERMISSION_DENIED`) are the system correctly enforcing scoping; they just don't make *which shape you got wrong* obvious. Every `/data/`-prefixed path is rewritten host-side before it's resolved:

> Any path starting with `/data/` (**the trailing slash matters**) has the segment immediately after `/data/` replaced with your own app id, unconditionally — regardless of what you put there.

| You send | Host resolves it as | Result |
|---|---|---|
| `/data/notes.txt` | `/data/<your-app-id>/notes.txt` | ✅ correct — the intended usage |
| `/data/<your-app-id>/notes.txt` | `/data/<your-app-id>/<your-app-id>/notes.txt` | ❌ double-nested. `NOT_FOUND` — **never include your own app id in the path**, the host adds it for you |
| `/data` *(no trailing slash)* | `/data` unchanged — rewrite doesn't fire | ⚠️ resolves to the shared data root. The host filters private app folders so you only see your own subtree. |
| `/data/` *(trailing slash, nothing else)* | `/data/<your-app-id>/` | ✅ correct — the right way to refer to your own app root, e.g. for `list` or as `mkdir`'s parent |

**Takeaways:**
- Treat `/data/` (with the trailing slash) as your app's root constant. Don't hardcode your app id into any path.
- If `list`/`write`/`mkdir` on "my own root" returns folders that aren't yours, you almost certainly sent bare `/data` without a trailing slash.
- If you get `NOT_FOUND: Parent folder not found` on a path you were sure existed, check whether you concatenated your own app id into a `/data/`-prefixed path — that's the #1 cause.
- A leading double-slash from concatenation (e.g. `'/data/' + '/foo.txt'`) is harmless — empty segments are skipped — but avoid it for readability.

#### Auto-created subfolders in your app root

The first time your app's `/data/<your-app-id>/` folder is set up, the host pre-populates it with four subfolders:

```
/data/<your-app-id>/
  files/          — general-purpose app files (suggested default for user content)
  cache/          — disposable/regenerable data
  databases/      — structured/serialized data (JSON, etc.)
  shared_prefs/   — simple key-value settings
```

This mirrors Android's internal-storage convention by name, but the subfolders are organizational only — writing directly to your app root works exactly the same. If you list your root right after install and see these four folders, that's expected. File-browser-style apps should decide up front whether to show them or filter them out.

### Notifications — `nova:notifications:*`

All notification APIs require `device:notifications` (low risk, auto-granted).

**Channels.** Sort notifications into named categories your users can control. Declare them in your manifest (see [Full manifest](#full-manifest)) or create them at runtime:

```javascript
await window.nova.ipc('nova:notifications:createChannel', {
  id: 'messages', name: 'Messages', importance: 'high', description: 'Incoming chats'
});
// { success: true, created: true, channel: { id: 'messages', importance: 'high' } }
```

Channel ids are slugs (`[a-zA-Z0-9_-]`, ≤64 chars), max 32 per app. **Importance is locked at creation** (Android parity): re-creating a channel updates name/description but keeps the original importance — only the user can change importance, in Settings → Notifications. Importances: `'low'` (panel only, no toast), `'default'` (toast + panel), `'high'` (long-lived toast + panel). `'none'` is not valid at creation — that state exists only when the user blocks a channel.

**Posting.**

```javascript
const res = await window.nova.ipc('nova:notifications:post', {
  channelId: 'messages',
  tag: 'chat:alice',                       // optional — enables update-in-place
  title: 'Alice',
  body: 'Lunch at noon?',
  actions: [ { id: 'reply', label: 'Reply' }, { id: 'open', label: 'Open' } ],
  progress: { value: 42, max: 100 }        // or { indeterminate: true }
});
// { success: true, posted: true, updated: false, id: 'n42', importance: 'high' }
```

- `channelId` must resolve; posting to an unknown channel fails with `INVALID_ARGS`. If the user blocked the channel, the call succeeds with `{ posted: false, reason: 'CHANNEL_MUTED' }` — treat that as normal, not an error.
- `tag` groups posts: posting again with the same tag **replaces the live notification in place** (same id, same panel position). Updates run against a separate, larger budget (60/min) than new posts (10/min), so a progress ticker updating once a second never trips the spam limiter. On an update, omitted fields keep their previous value — pass `actions: []` explicitly to clear buttons.
- `actions` (max 3): `{ id, label }` pairs. Ids are opaque slugs (≤40 chars) routed back to your app — never functions. Tapping an action **opens your app** and queues `{ actionId, label, tag, notifId, title, clickedAt }`; drain the queue on launch/resume with `nova:notifications:consumeActions` (returns and acknowledges all pending actions, oldest first, capped at 20). Tapping the notification body also opens your app.
- `progress` renders a determinate bar (`value` clamped to `0..max`, `max` ≤ 100000; `indeterminate: true` shows a fixed sliver).
- Legacy fields still work on `post` and on the old `nova:notifications:show`: `type` (`'info' | 'success' | 'warning' | 'error'`), `icon` (OS icon-set name), `action`/`actionLabel` (built-in strings such as `'open-settings'`, `'open-store'`). `title` (≤120) and `body` (≤500) are length-capped; invalid values fall back rather than erroring.

**Cancel.** `nova:notifications:cancel` removes one of your notifications by `tag` or `id`; `nova:notifications:cancelAll` (and the legacy `nova:notifications:clear`) clears all of them. Pinned background-app entries are never affected.

**Rate limits.** Max 10 new posts per app per minute; tagged updates get their own 60/min window. Exceeding either rejects with `{ code: 'RATE_LIMITED' }` until the window rolls over.

**User controls.** Settings → Notifications exposes Do Not Disturb (toasts suppressed; panel entries still land) and a per-channel importance picker (Blocked / Low / Normal / High). Your declared importance is the default; the user's choice always wins.

### Clipboard — `nova:clipboard:*`

```javascript
// Read clipboard (requires clipboard:read)
const { text } = await window.nova.ipc('nova:clipboard:read', {});

// Write clipboard (declare clipboard:write; auto-granted)
await window.nova.ipc('nova:clipboard:write', { text: 'Hello' });
```

Reads/writes hit the real system clipboard via `navigator.clipboard`:

- **Read** tries `navigator.clipboard.readText()` first; if that throws (no permission, no focus, insecure context), it falls back to the last value this OS instance wrote, so same-session copy/paste keeps working.
- **Write** tries `navigator.clipboard.writeText()` first, falling back to a legacy `execCommand('copy')` shim. If both fail, the call rejects with `CLIPBOARD_UNAVAILABLE` instead of silently no-oping.

### Window — `nova:window:*`

```javascript
await window.nova.ipc('nova:window:close', {});
await window.nova.ipc('nova:window:minimize', {});
await window.nova.ipc('nova:window:maximize', {});
await window.nova.ipc('nova:window:setTitle', { title: 'My App — Editing' });
await window.nova.ipc('nova:window:resize', { width: 1200, height: 800 });

const state = await window.nova.ipc('nova:window:getState', {});
// { width, height, x, y, maximized, minimized }
```

### Network — `fetch()` / `nova:net:fetch`

You generally don't need to call `nova:net:fetch` directly — `window.fetch` inside your app is routed through the bridge, so plain `fetch(url, opts)` works once the relevant `net:*` permission is granted:

```javascript
// Requires net:external (or net:internal for same-origin requests)
const res = await fetch('https://api.example.com/data', {
  headers: { 'Accept': 'application/json' },
});
const data = await res.json();
```

**Exception — fetching your own bundled files:** a same-origin `fetch()` for a file this app already ships (e.g. `module.wasm` in the `native-cpp` template) does not require a `net:*` permission. It's treated the same as a `<script src>` or `<img src>` reading a bundled asset, not as outbound network access.

### WebSocket — `nova:net:websocket` / `window.nova.websocket`

Requires `net:websocket`. Only `ws:` and `wss:` URLs are accepted; credential-bearing URLs and known cloud-metadata address literals are blocked. Literal loopback/private/link-local addresses and NovaByte's internal hosts also require `net:internal`. Hostname classification is based on the URL hostname, so deployments that use private DNS aliases should apply network egress controls as a second layer. Don't call the raw `nova:net:websocket` / `nova:net:ws:send` / `nova:net:ws:close` IPC methods directly — use the `window.nova.websocket()` wrapper, which handles requestId bookkeeping and event dispatch:

```javascript
const ws = await window.nova.websocket('wss://example.com/socket');

// onMessage receives { wsId, data } — not the bare server message.
ws.onMessage((envelope) => {
  const data = JSON.parse(envelope.data);
  console.log('received:', data);
});
ws.onError((err) => console.error('ws error:', err));
ws.onClose(() => console.log('closed'));

ws.send('hello');
ws.close(1000, 'done');
```

> **Don't skip this:** `onMessage`'s callback argument is `{wsId, data}`, not the raw payload. Treating it as the bare message means everything connects with no errors while your handler never fires.

The returned promise resolves once the connection is open — from the host's `onopen` handler only. There is no host-side rejection path if the connection never opens (bad host, refused connection, TLS failure): the call sits until the bridge timeout fires with a generic timeout error. Treat that timeout as a real connection failure.

### Geolocation — `nova:device:geolocation`

```javascript
// Requires device:geolocation
const { coords, timestamp } = await window.nova.ipc('nova:device:geolocation', {
  options: { timeout: 5000 }, // passed through to getCurrentPosition
});
// coords: { latitude, longitude, altitude, accuracy, altitudeAccuracy, heading, speed }
```

### Camera / Microphone — `window.nova.getUserMedia`

A live `MediaStream` can't cross the IPC bridge — `nova:device:camera`/`nova:device:microphone` are authorization-only checks. Use the wrapper; it checks the app-level permission first, then calls the real `navigator.mediaDevices.getUserMedia()` in your own document (which still goes through the browser's own permission gate):

```javascript
// Requires device:camera and/or device:microphone matching your constraints
try {
  const stream = await window.nova.getUserMedia({ video: true });
  stream.getTracks().forEach(t => t.stop());
} catch (err) {
  // PERMISSION_DENIED from the app-level check, or a standard
  // getUserMedia DOMException (NotAllowedError, NotFoundError, NotReadableError)
}
```

### Calendar — `nova:calendar:*` / `window.nova.calendar`

Reads and writes the **same shared calendar data** the built-in Calendar app uses — not an isolated per-app store.

```javascript
// requires calendar:read
const { events } = await window.nova.calendar.list();

// requires calendar:write
await window.nova.calendar.save({ id: 'my-event', title: 'Standup', date: '2026-07-20' });

// requires calendar:delete
await window.nova.calendar.remove('my-event');
```

### Contacts — `nova:contacts:*` / `window.nova.contacts`

Same shared-data model as Calendar — reads/writes the real Contacts app's data.

```javascript
// requires contacts:read
const { contacts } = await window.nova.contacts.list();

// requires contacts:write
await window.nova.contacts.save({ id: 'c1', name: 'Jane Doe', email: 'jane@example.com' });

// requires contacts:delete
await window.nova.contacts.remove('c1');
```

### App management — `nova:app:*` / `window.nova.apps`

```javascript
// List installed apps (requires system:apps)
const { apps } = await window.nova.apps.list();
// Each app retains `icon` and adds `iconUrl` for direct rendering:
// <img src="${apps[0].iconUrl}" alt="">
// `iconUrl` is a package image data URL, a safe local /assets path, or a
// generated SVG data URL for built-in icon names. It is null when unavailable.

// Launch an installed app (requires system:app-launch; max 6 per minute)
await window.nova.apps.launch('com.example.otherapp');

// Get info about this app (no permission)
const info = await window.nova.ipc('nova:app:info', { appId: 'com.example.otherapp' });

// Install a package (requires system:apps) — fails closed. Only succeeds
// for a fully signed, trust-store-verified, unmodified package. Anything
// that would normally need a human warning dialog (untrusted signer,
// tampered contents, already installed) is rejected outright rather than
// silently bypassed — install that manually via App Manager.
await window.nova.apps.install(packageObject);

// Uninstall (requires system:apps) — only works on real, file-installed
// .novaapp packages, not built-in system apps.
await window.nova.apps.uninstall('com.example.otherapp');

// Send the user to Settings → Default Apps (requires system:apps).
// `category` is optional; pass one of the category ids (e.g. 'music',
// 'browser') to open Settings with that row highlighted and a banner
// naming your app as the requester.
await window.nova.apps.openDefaultAppsSettings('music');

// A currently selected sandboxed Home app can take the user directly
// to Home app selection without requesting the broader system:apps grant.
await window.nova.home.openDefaultAppsSettings();

// Home-only app drawer APIs. Settings and App Manager are always listed
// and launchable by the currently selected Home app. Other apps appear
// in list() with system:apps, and can be launched with system:app-launch
// or system:apps.
const { apps, fullAccess } = await window.nova.home.apps.list();
await window.nova.home.apps.launch('com.nbosp.settings');
await window.nova.home.apps.launch('com.nbosp.appmanager');
```

**`openDefaultAppsSettings` is rate-limited** to 3 calls per minute per app id, using the same sliding-window pattern as notifications. This exists because, unlike a real click, there's no reliable host-side signal that the call came from a user gesture; the limit bounds how often a misbehaving app can steal focus by repeatedly popping Settings open. Calls beyond the limit reject with `{ code: 'RATE_LIMITED' }`.

This call only opens Settings to the right place — it never changes the user's default. The user still picks your app from the picker; there's no way to set a default programmatically without their action.

`window.nova.home.*` variants are restricted to the currently selected Home app (others receive `PERMISSION_DENIED`), share the 3-per-minute limit, and Home launches are limited to 6 per minute without accepting caller-supplied launch options or file intents.

### Admin — `nova:admin:*` / `window.nova.admin`

Requires **both** the relevant `admin:*` grant *and* the machine's local admin-mode flag (Settings → Privacy & Security → Admin Access, off by default). If the machine isn't in admin mode, calls reject with a message saying so — that's a correct denial, not a bug.

```javascript
// requires admin:audit — reads the live server event log (a 500-entry
// ring buffer, not a persisted audit trail)
const { logs } = await window.nova.admin.auditQuery({ limit: 10 });

// requires admin:system — read or update server-side security settings
// (password policy, lockout thresholds, IP blocking, etc.)
const { settings } = await window.nova.admin.systemGet();
await window.nova.admin.systemSet({ sessionTimeoutMinutes: 30 });

// requires admin:users — list/revoke active sessions (this OS is
// single-user; "sessions" means active browser/app sessions, not accounts)
const { sessions } = await window.nova.admin.usersList();
await window.nova.admin.usersRevoke(sessionId);

// requires admin:apps — admin-scoped view of the same app registry
// system:apps already exposes
const { apps } = await window.nova.admin.appsList();
```

### Mail — `nova:mail:*` / `window.nova.mail`

All mail calls act on the host Email app's mail session. If nothing is connected, calls reject with a clear "no email account connected" error. Two ways to get there:

- **Use the account the user already connected in the Email app** — `mail.account()` / `mail.restore()` read the live session; reads/writes/sends act on it.
- **Connect an account yourself** — `mail.connect(account)` (requires `mail:write`) takes `{ type, host, user, pass, port?, ssl? }` and connects through the host Email controller. SSL is mandatory (plaintext connections are rejected); credentials are forwarded to the host-side Email controller and never processed in the guest. `mail.disconnect()` ends the session.

```javascript
// requires mail:write — session lifecycle
await window.nova.mail.connect({ type: 'imap', host: 'imap.example.com', user: 'me@example.com', pass: '…' });
await window.nova.mail.restore();
await window.nova.mail.disconnect();

// requires mail:read
const { data } = await window.nova.mail.folders();
const { data } = await window.nova.mail.messages({ folder: 'INBOX', page: 1, limit: 20 });
const { data } = await window.nova.mail.message(uid, 'INBOX');
const { data } = await window.nova.mail.search('invoice', 'INBOX');
const { data } = await window.nova.mail.account(); // { restored, type, host, user }

// requires mail:write — batch mark-read/move, plus HTML preview rendering
await window.nova.mail.markRead([101, 102], 'INBOX');
await window.nova.mail.move([101], 'Archive', 'INBOX');
const { token } = await window.nova.mail.preview('<p>Hello</p>');

// requires mail:send — smtpHost/smtpPort are mandatory. The server cannot
// infer your account's real SMTP host from its IMAP/POP3/EWS host (they're
// frequently different, e.g. imap.gmail.com vs smtp.gmail.com) — get it
// from the account config, don't guess.
await window.nova.mail.send({
  to: 'someone@example.com',
  subject: 'Hello',
  text: 'Hi there',
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
});

// requires mail:delete
await window.nova.mail.remove([101], 'INBOX');
```

For providers with an HTTP/REST API (Gmail API, Microsoft Graph, etc.) you can skip `mail:*` entirely and call the provider directly over `net:external`, handling your own OAuth flow. Raw IMAP/SMTP/POP3 wire protocols are not reachable through `net:external` — there is no host-side handler for arbitrary non-HTTP protocols.

### System info — `nova:system:info`

```javascript
// Requires system:info
const info = await window.nova.ipc('nova:system:info', {});
// { osVersion, securityPatch, platform, ... }
```

### Settings — `nova:settings:get` / `nova:settings:set`

Reading and writing OS settings are gated by **different** permissions, and both directions are **allowlisted** — this is a shared, OS-wide key space of user preferences, not arbitrary key/value access and not per-app storage:

- `nova:settings:get` requires `system:info` and can read only allowlisted preference keys (`theme`, `accentColor`, `username`, `region`, `timezone`, `devMode`, `highContrast`, `reduceMotion`, `taskbarPosition`, `wallpaperId`, and other desktop/appearance/settings values).
- `nova:settings:set` requires `system:settings` and can write the same allowlist minus `osVersion` and `devMode` (those change only through OS-owned flows).

```javascript
// Requires system:info
const { value } = await window.nova.ipc('nova:settings:get', { key: 'theme' });

// Requires system:settings
await window.nova.ipc('nova:settings:set', { key: 'theme', value: 'dark' });
```

Security-sensitive material — `lockPin`, `pinSalt`, `biometricCredentialId`, `bootPassword`, `lockoutUntil`, `wrongPinCount` — is not in the readable allowlist and never reachable through this API, so holding `system:info` can't read the user's PIN hash and holding `system:settings` can't reset lockout state. Calls for any other unlisted key fail with `INVALID_ARGS`.

For appearance customization, prefer `window.nova.appearance.set(...)`: it changes only validated theme/accent/accessibility preferences.

For data scoped to your own app, use [Storage](#storage) instead.

### Event bus — `nova:events:*`

Use `window.nova.onEvent`, which handles the subscribe call and dispatches pushed events:

```javascript
window.nova.onEvent('system:themeChanged', (data) => {
  console.log('theme changed:', data);
});
```

Calling `nova.ipc('nova:events:unsubscribe', { event: 'system:themeChanged' })` directly also works.

**Event names are restricted to a fixed allowlist** — subscribing to any other name fails with `INVALID_ARGS`. Common appearance, volume, workspace, power, and network change events require no permission; notifications, app inventory/lifecycle events, and mail/calendar/contact events require `system:events`, and the mail/calendar/contact ones additionally require their domain read permission:

| Event | Fires when | Permission |
|---|---|---|
| `system:notification` | A system notification is shown | `system:events` |
| `system:volumeChanged` | Volume is changed | `system:events` |
| `system:themeChanged` | Light/dark theme is switched | — |
| `system:workspaceChanged` | The active workspace changes | — |
| `system:power` | Power state changes (battery/charging) | — |
| `system:network` | Network connectivity changes | — |
| `app:installed` | An app is installed | `system:events` |
| `app:uninstalled` | An app is uninstalled | `system:events` |
| `app:launched` | An app is launched | `system:events` |
| `mail:new` | New mail arrives | `system:events` + `mail:read` |
| `mail:updated` | Mail state changes | `system:events` + `mail:read` |
| `calendar:reminder` | A calendar reminder fires | `system:events` + `calendar:read` |
| `calendar:updated` | Calendar data changes | `system:events` + `calendar:read` |
| `contacts:updated` | Contacts data changes | `system:events` + `contacts:read` |

The bus is OS-to-app only — there is no event for arbitrary custom app-to-app messaging (use [Inter-app communication](#inter-app-communication) instead).

### Background execution — `nova:background:*`

Three separate permissions cover three genuinely different questions:

| Permission | Answers | Must the user have opened the app first? |
|------------|---------|---------|
| `system:background` | "Can this app periodically wake up and do a little work while closed?" | No — the OS can wake it even if never launched this session |
| `system:background:live` | "Can this app keep running after its window is closed?" | Yes — it must already be open and choose to stay alive |
| `system:autostart` | "Can this app launch itself at OS startup with no user action?" | No — the biggest ask of the three |

#### Tier 1 — scheduled wake (`system:background`)

Roughly every 15 minutes, the OS spins your app up headlessly — no window, no visible UI — and gives it a short deadline (seconds) to do work: check state, sync data, refresh a cache. It does **not** grant `device:notifications` — a wake handler that wants to alert the user needs that permission separately and gets `PERMISSION_DENIED` without it, exactly as in the foreground.

```javascript
// Requires system:background
window.nova.onBackgroundWake((info) => {
  // info.wokeAt     — ISO timestamp
  // info.deadlineMs — how long you have before the host tears this down

  doQuickSync();

  // Optional: signal done early so the host doesn't wait out the deadline.
  window.nova.backgroundWakeDone();
});
```

If you never call `backgroundWakeDone()`, the host waits out `deadlineMs` and tears the sandbox down anyway.

#### Tier 2 — stay alive after close (`system:background:live`)

Holding the permission is **not** enough by itself — your app must explicitly opt in for the current session:

```javascript
// Requires system:background:live
const { enabled } = await window.nova.stayAliveInBackground();
// Call again with `false` to opt out before the window closes.
```

Once opted in, closing the window keeps the app running. The user sees a one-time toast plus a persistent, non-dismissible notification entry with a **Terminate** button — the only way the process stops short of the app exiting on its own. Reopening the app from the launcher reattaches the existing running instance (same process, same in-memory state) and clears the pinned entry; closing it again re-backgrounds the app without calling `stayAliveInBackground()` a second time.

#### Tier 3 — autostart at OS boot (`system:autostart`)

Your app can launch itself when NovaByte OS starts. Opt-in on two axes: the app needs the grant, **and** the user must add it to their own "start at boot" list (the app's detail page in App Manager shows that toggle only for apps declaring `system:autostart`). Neither alone is enough. There is no runtime API for this tier.

Autostart never runs behind a lock screen — if the machine is locked at boot, autostart apps wait until the user unlocks.

### File picker — `nova:dialog:*`

```javascript
// Open file picker (user selection grants access to the chosen file)
const file = await window.nova.ipc('nova:dialog:open', {
  accept: ['.txt', '.md'],
  multiple: false,
});
// { path, name, content }

// Save file picker (user selection grants access to the chosen destination)
await window.nova.ipc('nova:dialog:save', {
  filename: 'notes.txt',
  content: 'Hello',
});
```

### Styled file picker — `nova:sysdialog:*`

A second, additional picker pair — separate from `nova:dialog:*`, not a replacement; both keep working. Where `nova:dialog:*` renders a minimal one-off overlay, `nova:sysdialog:*` opens the shared, Files-app-styled filesystem browser (`SystemDialogs`) that built-in apps use for Open/Save As: real folder navigation, back/up buttons, a path bar, an icon grid, and no "save as type" dropdown. The picker itself grants access to the chosen item or destination.

```javascript
// Open picker
const result = await window.nova.ipc('nova:sysdialog:open', {
  title: 'Import',            // optional, defaults to "Open"
  startFolderId: undefined,   // optional folder id; defaults to root
});
if (result.cancelled) {
  // user backed out — not an error
} else {
  const { id, name, content, mimeType, size, path } = result.file;
}

// Save picker — writes the file once a destination is chosen
const result = await window.nova.ipc('nova:sysdialog:save', {
  title: 'Save As',            // optional, defaults to "Save As"
  suggestedName: 'notes.txt',  // optional, prefills the filename box
  startFolderId: undefined,
  content: 'Hello',
  mimeType: 'text/plain',      // optional, defaults to 'text/plain'
});
if (!result.cancelled) {
  const { id, name, path } = result.file;
}
```

Both picker channels are on the same interactive, long-timeout tier as `nova:download` and `nova:share` — the call can legitimately sit open for minutes while a person navigates folders, so it gets the 10-minute interactive timeout instead of the normal per-request timeout (60 s by default, per the app's `requestTimeoutMs` budget).

### Error codes

`window.nova.ipc` rejects (throws) rather than resolving with an `{ error }` field — always wrap calls in `try/catch` or attach `.catch()`. The thrown error has `.code` and `.message`:

| Code | Meaning |
|------|---------|
| `PERMISSION_DENIED` | Required permission not granted, or the call was blocked by system security policy (MAC) |
| `INVALID_ARGS` | Missing or invalid payload fields |
| `NOT_FOUND` | File or resource not found |
| `UNKNOWN_API` | Unknown IPC endpoint (typo in the channel name) |
| `REMOTE_ERROR` | A remote app's IPC callback failed or did not respond in time |
| `ALREADY_REGISTERED` | This sandbox already registered the endpoint |
| `ALREADY_SUBSCRIBED` | This sandbox already subscribed to that event |
| `LIMIT_REACHED` | A per-app object limit was hit (e.g. max notification channels) |
| `STORAGE_FULL` | Storage quota or per-value size limit reached |
| `NETWORK_ERROR` | Fetch failed |
| `RATE_LIMITED` | Too many calls to a rate-limited API in the current window |
| `TIMEOUT` | An interactive flow (save dialog, share sheet) timed out |
| `IO_ERROR` | Disk write or save-dialog failure |
| `UNAVAILABLE` | The underlying OS service isn't available, an IPC endpoint isn't running, a required upstream connection isn't set up (e.g. no email account connected), or a machine-level gate is closed (e.g. `admin:*` when the machine isn't in admin mode) |
| `UNVERIFIED` | `nova:app:install` rejected an unsigned or trust-store-unverified package — a correct, fail-closed rejection |
| `GEOLOCATION_ERROR` | The browser's geolocation API itself failed or timed out (separate from `PERMISSION_DENIED`, which means the app-level grant was missing) |
| `CLIPBOARD_UNAVAILABLE` | The system clipboard could not be written/read |
| `INTERNAL_ERROR` | An unexpected host-side handler failure |

---

## Security

### Sandbox model and app isolation

NovaByte's app runtime is NW.js webview guests plus a host-side capability broker:

```text
[NovaByte app guest]
        |
        | validated nova:* IPC + per-app grants
        v
[NovaByte host broker] ---- [scoped FS / OS services]
```

The host broker checks the calling app's identity and grants on every privileged operation. App-private files are scoped under the app's own `/data/<app-id>/` directory; shared filesystem access is mediated by the FS API and picker-granted file ids; cross-app service/provider requests and broadcasts are separately permissioned and limited to manifest-declared targets.

This is not Android, and it is worth being precise about what the boundaries are:

- Apps do **not** run under distinct Linux UIDs, SELinux domains, seccomp filters, or cgroups. There is one browser process and one user; an NW.js renderer guest is not a separate Linux user. (Earlier NBOSP images experimented with a per-app Linux UID supervisor and SELinux boot integration; that substrate has been removed from the image and is not part of the current architecture.)
- JavaScript's managed runtime is not protection against memory or native-code vulnerabilities.
- What enforces isolation instead is the webview renderer boundary plus **two JS-side layers at the IPC choke point**, described below: the MAC policy engine (which endpoints a domain may call, with which grants) and the storage ledger (what an app may store, and which files it may touch). Both are enforced host-side before any handler runs.

### System policy engine (NB-MAC)

Every sandboxed IPC call passes a mandatory access control check in the bridge (`MacPolicy.checkIpc`) **before** any handler code runs. It is the JS-side analog of the SELinux layer Android stacks on top of its per-app UIDs, reimplemented at the bridge because the kernel route does not fit this architecture (single browser process, single-user OS).

The model, briefly: each app maps to a policy **domain** (every sandboxed app starts as `untrusted_app`, enforcing); each IPC endpoint family (`nova:fs`, `nova:admin`, …) has a policy row that is either grant-coupled (the call requires ANY-of a listed permission set) or advisory (the handler's own context-sensitive checks — path ownership, quotas, picker grants — remain the boundary). An endpoint with **no policy row at all is refused** for enforcing domains, so new attack surface is locked by default. A `neverallow` list protects privilege anchors (e.g. `nova:admin:*` can never be made advisory), and a linter rejects policies that leave handlers uncovered or violate it.

What apps observe:

- Grant-coupled endpoints behave exactly as before: without the required permission the call is refused with `PERMISSION_DENIED` (message prefixed `Blocked by system security policy (MAC):`); with it, the call succeeds. Handlers keep their own checks as defense in depth.
- Denials are avc-audited to a rate-limited ring buffer surfaced in **Settings → Privacy & Security → Security Policy**, so users (and you, while debugging) can see what a domain was denied.
- Permissive domains exist for rollout: would-be denials are logged but passed through, the SELinux "ship permissive first, then flip to enforcing" playbook.

App developers normally don't interact with any of this: declare the permissions your app needs and the policy does the rest.

### `eval()` auditing

`eval()` and `new Function()` are blocked twice, independently:

- **Install time:** the Content Scanner flags literal `eval(` and `new Function(` as dynamic-code patterns and can block install before the app ever runs.
- **Runtime:** the sandbox CSP no longer contains `unsafe-eval`, so the browser blocks `eval()` and `new Function()` outright, including indirect forms like `window['ev' + 'al']`. `wasm-unsafe-eval` remains for WebAssembly only — that is not a dynamic-JS grant.

The CSP is enforced from **two independent places**, both stripped of `unsafe-eval`: the client-side `RELAXED_CSP_META` meta tag injected by `app-sandbox.js`, and the server-sent `Content-Security-Policy` header on the `/api/apps/serve/:sandboxId/*` route that serves packaged app files. The header is at least as authoritative as the meta tag — it's set before the browser parses the HTML — so both had to be patched for the fix to be complete.

The sandbox's capability shim still reports attempted `eval()` calls via the internal `nova:audit:eval` channel to `EventLog` (category `security`, severity `warn`) for observability, but in practice the CSP throws before the call does anything.

Practical takeaway: there is no supported way to use `eval()` or `new Function()` in this sandbox. Don't ship code that tries.

### Best practices

- Request the minimum permissions your app actually needs.
- Handle optional permission denial gracefully — the app should still function.
- Don't use `eval()` — use safer alternatives.
- Validate and sanitize all user input and any file content you read.
- Don't collect data you don't need.
- External scripts in the packaged entry HTML are deferred by the NovaByte host, so `app.js` can initialize against the parsed entry-page DOM directly. Add `defer` as well if you also run the page outside NovaByte OS. Dynamically created scripts and documents retain normal browser timing.

### Content Scanner — avoiding false positives on install

Every dropped file and every file inside a `.novaapp` package is run through a static heuristic scanner (`window.Scanner`) before it's trusted — on drag-and-drop into Files/Desktop, and on App Manager package install. It isn't an AV engine; it's a small set of cheap tripwire checks. A handful of ordinary build patterns will trip it if you're not aware of the rules:

- **Reference your script, don't inline it.** In `index.html`, use `<script src="app.js"></script>` — a local relative path to a sibling file in your package. An inline `<script>...</script>` block with actual code inside is flagged and blocks install, no exceptions. Each file in a `.novaapp` package stays a separate file at build and runtime; this rule is purely about what the scanner allows.
- **"Local" means local.** The `src` path can't have a scheme (`http://`, `data:`, …), can't be protocol-relative (`//...`), can't be absolute (`/...`), and can't contain `..` traversal. Keep it a plain relative filename like `app.js` or `js/app.js`.
- **Don't `eval()` decoded/assembled strings.** `atob(...)`, `Buffer.from(..., 'base64')`, and `String.fromCharCode(...)` are fine on their own. What blocks is piping the result into `eval(...)`, `new Function(...)`, `document.write(...)`, or `.innerHTML =`. Decode binary data and use it as data — don't hand it to something that executes it.
- **Avoid literal `eval(` and `new Function(` entirely** — flagged outright, independent of the base64 rule.
- **If your app renders user-supplied HTML/Markdown/SVG, keep iframes sandboxed.** An `<iframe>` with no `sandbox` attribute is always rejected; a sandboxed iframe combining `allow-same-origin` with `allow-scripts` is rejected too — everything else with a proper `sandbox` attribute and a local or `https://` `src` is fine.
- **Don't ship high-entropy content under a text-like extension.** A file declared `.js`, `.json`, `.svg`, `.html`, `.md`, `.txt`, etc. whose bytes look like packed/encoded binary (high Shannon entropy) is flagged as likely disguised content.
- **Don't double up extensions.** `readme.pdf.exe` is flagged purely for the executable extension trailing a plausible document one.

None of this affects `vendor/` libraries dropped in as single minified JS/CSS files — those are bundled at Build time via the normal template pipeline.

---

## Package format

A `.novaapp` file is plain JSON:

```json
{
  "novabyte_app": true,
  "compiled_at": 1700000000000,
  "manifest": { "id": "...", "name": "...", "version": "...", "entry": "...", "permissions": [] },
  "files": {
    "index.html": "<base64-encoded content>",
    "app.js": "<base64-encoded content>"
  },
  "signature": "<Ed25519 signature, base64url>",
  "signer": "NovaByte Trusted Signing"
}
```

File contents are Base64-encoded. `signature` is an Ed25519 signature over the `novabyte_app`, `manifest`, `files`, and `compiled_at` fields — not a checksum. A checksum says nothing about who produced the file; a signature can only be produced by whoever holds the matching private key, which is what makes trust meaningful.

### Package signatures

Signed doesn't automatically mean trusted. The runtime checks two separate things on install:

1. **Is the signature valid?** — does it verify against the public key that produced it.
2. **Is that public key trusted by the OS?** — the OS trust store determines which signers are trusted.

An app can carry a perfectly valid signature from some other key and still be reported **Unverified**. Trust is about "was this signed with a key the OS actually trusts," not "was this signed."

**Self-signing** — you can sign your own `.novaapp` with your own keypair for local testing. It will only be trusted if the corresponding public key is in the OS trust store. Self-signing proves the package hasn't been tampered with since you signed it; it does not make it trusted.

**Revocation** — trust can be pulled from one specific signed package after the fact, by its exact signature, without touching the signing key or any other package that key signed:

- Revocation is keyed by the exact signature string, not by app id/name/version — those fields are dev-controlled and could be reused or spoofed, whereas a signature is a fixed value produced once, at sign time.
- Revoking a signature does **not** revoke the key — every other package signed with that key stays trusted. If the private key itself is compromised, the trust store entry needs to be replaced and everything re-signed.
- Revocations persist to disk (`revoked-signatures.json`) and apply across every NBOSP process on that machine. A mistaken revocation can be undone.

**What the user sees:**

- **Verified** — signed with NovaByte's trusted key, not revoked. Installs normally.
- **Unverified** — unsigned, self-signed, signed with any other key, or individually revoked. The install still proceeds, but the OS shows a clear warning first so the user can back out.

Unverified doesn't mean blocked — NBOSP doesn't gatekeep what you can run on your own machine. It means the OS tells you the truth about what it can and can't vouch for, and leaves the decision with you.

---

## Distribution

### Direct distribution

Share the `.novaapp` file directly. Users drag and drop it into the App Manager, or click Install and pick the file. That's the whole install flow — no separate installer, no admin rights required.

Unverified packages still install, but with a warning so users can decide whether to trust them.

### Updates

There's no built-in update pipeline in NBOSP. The simplest approach is a GitHub Releases pipeline:

1. Bump `version` in `manifest.json`
2. Build and tag a release
3. Attach the `.novaapp` to the release
4. Tell your users to re-download and reinstall

When a user installs an app that's already installed, the App Manager detects the version conflict and prompts them to replace it.

---

## Compatibility

The `.novaapp` format is used by NovaByte OS and compatible NBOSP forks. Runtime APIs and permissions can differ between hosts and forks; check the target system documentation and test against the environments you intend to support.

### API evolution and backward compatibility

Existing `.novaapp` APIs remain available to apps that already use them. When NovaByte adds different behavior, it ships through a new API (like the `window.novaOS` v2 facade) so existing apps keep working.

This does not mean bugs or security issues are left unfixed. NovaByte may fix an existing API when it has a genuine bug or vulnerability, while taking care not to break apps that rely on it.
