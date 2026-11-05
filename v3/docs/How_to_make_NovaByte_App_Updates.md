# How to Make NovaByte App Updates

This document explains how to push updates to built-in NovaByte OS v3 apps using the **System Updates** app (`nova-updates`). This is separate from the full OS update pipeline — it targets individual built-in apps only, without touching `index.html`.

---

## How It Works

The System Updates app reads a manifest from JSONBin. The manifest lists every built-in app, its current version, and the new code to apply. When a user clicks **Update**, NovaByte fetches that code, runs it in memory, and saves it to `localStorage` so it survives page refreshes.

```
You update JSONBin
        ↓
User opens System Updates → sees the new version
        ↓
User clicks Update
        ↓
NovaByte applies the new code in memory + saves to localStorage
        ↓
App is now running your new version — no re-cloning needed
```

Their `index.html` never changes. The update lives in `localStorage` and re-applies automatically on every boot.

---

## Your JSONBin Manifest

Your manifest lives at:

```
https://api.jsonbin.io/v3/b/6a085d7badc21f119aab97e6/latest?meta=false
```

Each app entry looks like this:

```json
{
  "id": "quill",
  "name": "Quill",
  "version": "1.0.0",
  "icon": "pen-tool",
  "changelog": "Initial release"
}
```

When you have an update to ship, you add a `code` field:

```json
{
  "id": "quill",
  "name": "Quill",
  "version": "1.1.0",
  "icon": "pen-tool",
  "changelog": "Fixed markdown rendering bug",
  "code": "OS.apps['quill'].init = function(content, state) { /* new init code here */ };"
}
```

The `code` field is what actually gets applied. Without it, the entry is just informational and no Update button appears.

---

## Step-by-Step: Shipping an App Update

### Step 1 — Fix the app in `index.html`

Make your changes normally. Test locally. Once happy, proceed.

### Step 2 — Copy the new `init` function

Find the app's `registerApp` block in `index.html`. Copy the entire `init(content, state) { ... }` function body — everything between the outermost `{` and `}` of `init`.

### Step 3 — Format it as a patch string

Wrap it like this:

```javascript
OS.apps['quill'].init = function(content, state) {
  // paste the full init body here
};
```

This is the value that goes in the `"code"` field of the manifest.

> **Tip:** Inside the init function you can use `NovaByte.createEl`, `NovaByte.svgIcon`, `NovaByte.Notify`, and `NovaByte.sanitiseHTML` — they're all available via the NovaByte SDK injected at boot.

### Step 4 — Update JSONBin

1. Go to [jsonbin.io](https://jsonbin.io) and open your bin
2. Find the app's entry in the `apps` array
3. Bump the `version` (e.g. `1.0.0` → `1.1.0`)
4. Update `changelog` with what changed
5. Add the `code` field with the patch string from Step 3
6. Click **Save**

That's it. The change is live instantly.

### Step 5 — Verify

Open NovaByte OS, launch **System Updates**, click **Check for Updates**. The app should appear with an Update button. Click it and confirm the app works correctly after updating.

---

## Version Numbering

Use standard semantic versioning: `MAJOR.MINOR.PATCH`

| Change type | Example |
|-------------|---------|
| Bug fix | `1.0.0` → `1.0.1` |
| New feature | `1.0.0` → `1.1.0` |
| Major rewrite | `1.0.0` → `2.0.0` |

All apps start at `1.0.0`. Only bump the version for apps you've actually changed.

---

## What the Patch Code Can Access

Inside your `code` string, these are available as globals:

| Variable | What it is |
|----------|-----------|
| `OS` | The full OS object — `OS.apps`, `OS.settings`, `OS.windows`, etc. |
| `NovaByte.createEl` | DOM element creation helper |
| `NovaByte.svgIcon` | Icon renderer |
| `NovaByte.Notify` | Notification system |
| `NovaByte.sanitiseHTML` | HTML sanitiser |

You do not need to import or declare these — they are injected automatically when the patch runs.

---

## What App Updates Can and Cannot Do

**Can update:**
- Any built-in app's `init` function (the entire UI and logic of the app)
- App behaviour, layout, features, bug fixes

**Cannot update:**
- The OS boot system
- The window manager or taskbar
- Global CSS variables or themes
- The server (`server.js`) or any backend code
- Other apps' code directly (each patch only touches one app at a time)

For changes outside of app `init` functions, use the full OS update pipeline documented in `How_to_make_Updates.md`.

---

## Rolling Back an Update

Users can clear all applied patches from **System Updates → Settings → Clear All Patches**. This removes every patch from `localStorage` and reverts all apps to the versions baked into `index.html`. A page refresh completes the rollback.

To roll back a specific app only, remove the `code` field from its manifest entry and bump the version to a number the user hasn't installed yet — they can then "update" to the rollback version.

---

## Manifest App ID Reference

| App ID | Name |
|--------|------|
| `vault` | Vault |
| `quill` | Quill |
| `shell` | NovaShell |
| `horizon` | Horizon |
| `resonance` | Resonance |
| `prism` | Prism |
| `chronos` | ChronOS |
| `novamail` | NovaMail |
| `marketplace` | Marketplace |
| `lens` | Lens |
| `pixeldrop` | PixelDrop |
| `dataforge` | DataForge |
| `appcreator` | App Creator |
| `nook` | Settings |
| `lumina` | Lumina |
| `pulse` | Pulse |
| `novasentinel` | NovaSentinel |
| `gpedit` | Policy Manager |
| `eventviewer` | Event Viewer |
| `usermgr` | User & Group Manager |
| `certmgr` | Certificate Manager |
| `netmon` | Network Monitor |
| `taskschd` | Scheduled Tasks |
| `novareg` | NovaReg |
| `novabox` | NovaBox |
| `bcdedit` | Boot Config Editor |
| `procexp` | Process Inspector |
| `kernelcon` | Kernel Console |
| `dumpview` | System Dump Analyzer |
| `encvault` | Encryption Vault |
| `app-manager` | App Manager |

---

*NovaByte OS v3 — App Update System*
