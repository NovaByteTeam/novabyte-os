<div align="center">

<div><img src="./logo.svg" width="120" height="120" alt="NovaByte OS Logo" /></div>

<div><img src="https://img.shields.io/badge/NovaByte_OS-v3.x.x_Current-22c55e?style=for-the-badge" alt="NovaByte OS"/></div>

# NovaByte OS

**A browser-based operating system with multi-version support,**
**Nova Core Services, and an independent security update pipeline.**

<br>

[![v1.x.x](https://img.shields.io/badge/v1.x.x-End_of_Life-ef4444?style=flat-square)](https://github.com/NovaByteOfficial/novabyte-os)
[![v2.x.x](https://img.shields.io/badge/v2.x.x-Maintenance-f59e0b?style=flat-square)](https://github.com/NovaByteOfficial/novabyte-os)
[![v3.x.x](https://img.shields.io/badge/v3.x.x-Current-22c55e?style=flat-square)](https://github.com/NovaByteOfficial/novabyte-os)
[![Node](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-Private-6b7280?style=flat-square)](https://github.com/NovaByteOfficial/novabyte-os)

<br>

[**Getting Started**](#-getting-started) · [**Update System**](#-update-system) · [**Nova Core Services**](#-nova-core-services) · [**Editions**](#️-editions) · [**Protected Identifiers**](#️-protected-system-identifiers) · [**Security**](#-security) · [**Versions**](#-versions)

</div>

---

## 🆓 NBOSP — NovaByte Open Source Project

The `nbosp/` folder in this repo is the **free, open, no-strings-attached base of NovaByte**.

- Do whatever you want with it — copy it, fork it, sell it, modify it, redistribute it
- No rules, no attribution required, no license restrictions
- This is pure NovaByte.
- Core Apps: **NBOSP Files, NBOSP Notes, NBOSP Terminal, NBOSP Browser, NBOSP Calendar, NBOSP Email, NBOSP Gallery, NBOSP Downloads, NBOSP Contacts, NBOSP Search, NBOSP Music, NBOSP Clock, NBOSP Settings, NBOSP Calculator and NBOSP App Manager**
- Basic security (rate limiting, CSRF protection, security headers) is built in
- No edition system, no update pipeline, and also no telemetry which every version don't have anyway.
- NOTE: "NBOSP" IN EACH APP IS A STOCK VERSION THAT COMES PREINSTALLED WITH NBOSP, WHICH ARE PURE NOVABYTE APPS THAT COME PREINSTALLED, WHICH WE REPLACED WITH OUR OWN FEATURE-HEAVY ONES IN V3. THE OS IS FULLY CUSTOMISABLE, CLEAN, AND LIGHTWEIGHT. FUN FACT: WE TOOK NBOSP AND BUILT UPON IT WITH AN UPDATE SYSTEM AND LOTS MORE FEATURES. CHECK OUT V3.
-AND YES WE DO MAINTAIN TWO VERSIONS NBOSP APPS, AND OUR OWN FULL FEATURED APPS.
-AND YES ALSO WE HAD THIS DIRECTORY BUT DIDNT PUBLISH IT SO ITS NOT NEW THIS IS WE BUILT IT UPON IT ON ITS OUR OWN CODE BLUD. DONT ASK WHY WE REPLACED THE APPS.
- ALSO, WE DECIDED TO ABANDON LOTS OF NBOSP APPS. WE ARE NOT ADDING NEW FEATURES TO THESE APPS OR INTERFACE CHANGES; WE CONTINUE TO DELIVER COMPATIBILITY, BUG AND SECURITY FIXES.
- THE REASON WE EVEN INCLUDED APPS IS BECAUSE WE PROMISE NBOSP IS FUNCTIONAL OUT OF THE BOX, AND PROVING IT'S A DESKTOP OS, IT CAN BROWSE, PLAY MUSIC, BROWSE FILES, INSTALL .NOVAAPP APPS, ETC.
- AND ALSO THE APPS LISTED ARE BUILT SPECIFICALLY FOR THE NOVABYTE OPEN SOURCE PROJECT. FREE TO USE, CUSTOMISE, OR CHANGE ANY BIT THE WAY YOU LIKE.
  
> **Want the full-featured NovaByte OS?** The complete version lives in `v3/` and comes with the usage rules documented below. NBOSP is just the foundation — the base code you build on.

### 🔄 NBOSP App Updates

NBOSP does **not** use the built-in System Updates app. Updates to NBOSP apps depend entirely on your **forker or maintainer**.

If NovaByte fixes or improves something in the NBOSP source, that fix lives in the upstream repo. Your fork does not receive it automatically. Your forker or maintainer has to pull the change, repackage it, and release their own updated build. You then get it by cloning or downloading their new release — this is a **full OS update**, not an in-app patch.

| Update type | How you get it |
|-------------|---------------|
| NBOSP app fix from upstream NovaByte | Forker/maintainer repackages → you re-clone their release |
| NBOSP app fix from your own fork maintainer | Forker/maintainer releases → you re-clone |
| v3 built-in app fix | System Updates app → click Update → done |

If you are running a fork of NBOSP and want updates, check with your fork maintainer. If you are maintaining a fork, it is your responsibility to pull upstream changes and release them to your users.

### 🌐 NBOSP Browser — Now Powered by NW.js & WebView

**MASSIVE UPDATE (May 2026):** NBOSP Browser has been completely rebuilt using **NW.js (Node-Webkit)** as the rendering engine with **WebView** support, replacing the previous iframe + Ultraviolet proxy architecture. Everything works out of the box — no browser navigation required.

#### What Changed

**Old approach (iframe + Ultraviolet proxy):**

- **The browser was completely broken** — unable to properly browse most websites
- Decoding issues and broken rendering
- Integration issues causing sites to fail
- UV proxy returning 400 and Bad Request errors
- Cookie support broken
- Tab switching issues
- Email app limited by iframe isolation
- Website app manager severely restricted

**New approach (NW.js + WebView):**

- ✅ Native browser rendering with full site compatibility
- ✅ Cookie support now fully functional
- ✅ Tab switching works reliably
- ✅ Email app now uses webview — all iframe limitations removed
- ✅ Website app manager now uses webview — vastly improved capabilities
- ✅ Proper fullscreen support
- ✅ All UV proxy errors completely eliminated
- ✅ Everything "just works" out of the box

#### New Features in NBOSP Browser (Last feature update for the stock app)

- **Bookmarks** — Save and organize your favorite websites with one-click access from the menu
- **History** — View and quickly access previously visited pages
- **Find in Page** — Search for text within a page using Ctrl+F
- **New Incognito Tab** — Browse privately without recording history
- **Mobile/Desktop Site Toggle** — Switch between mobile and desktop user agent on demand
- **Zoom Controls** — Adjust page zoom (In, Out, Reset)
- **Dialup Page** — Classic retro homepage for quick access to common sites
- **iFrame / Webview Mode Toggle** — Switch between NW.js WebView (full native rendering, cookie support, site compatibility) and sandboxed iFrame mode per tab, directly from the toolbar. iFrame mode embeds pages using a standard HTML `<iframe>` with sandbox restrictions; sites that block embedding via `X-Frame-Options` or `Content-Security-Policy: frame-ancestors` show a clear notice with a one-click switch back to Webview. Mode is tracked independently per tab.
- **Popup Blocker (fixed)** — Blocks intrusive ad and spam popups while intelligently allowing OAuth and login flows through. The blocker now detects auth popups by URL patterns (known auth domains like `accounts.google.com`, path segments like `/oauth`, `/authorize`, `/login`, and query params like `client_id`) and lets them open as normal inline overlays. Previously, the blocker was incorrectly blocking all `new_popup` dispositions including legitimate login windows.

#### Automatic Startup

You no longer need to manually navigate to `https://localhost:3003` in your browser. Running `npm start` in the NBOSP folder now automatically opens the OS window for you. Everything is ready to go instantly.

#### Security in NW.js — Frame Types and Sandboxing

NBOSP runs on NW.js, which has two distinct frame types with different security boundaries:

**Node Frames** (Node.js API access):
- URLs matching `node-remote` patterns (`localhost:*`, `127.0.0.1:*`, `chrome-extension://`)
- No `nwdisable` attribute
- NOT inside a `<webview>` tag
- Parent frame also NOT disabled
- Can call Node.js APIs and access the system

**Normal Frames** (No Node.js access):
- Any frame that doesn't meet ALL node frame criteria
- **Explicitly marked with `nwdisable` attribute** — the key security boundary
- Cannot access Node.js APIs, even if they somehow match a `node-remote` pattern
- All app iframes in NBOSP use this model for isolation

**Implementation:**

| Component | What it does |
|-----------|-------------|
| `frame-security.js` | Validates frame types, detects privilege escalation attempts, audits frame boundaries |
| `app-sandbox.js` | Creates app iframes with `nwdisable` attribute, enforcing normal frame status |
| `package.json` | Configures `node-remote: "*://localhost:*"` to whitelist the server frame only |

**Rules:**

1. **All user apps run in `nwdisable` iframes** — they cannot access Node.js, regardless of URL
2. **Only localhost server frames can use Node APIs** — they're in the `node-remote` whitelist
3. **Cross-origin content gets additional sandboxing** — iframe `sandbox` attribute + CSP headers
4. **Webview tags bypass frame security** — never put untrusted content in `<webview>`

**For developers extending NBOSP:**

If you add iframes:
```html
<!-- ✅ Safe: normal app frame -->
<iframe nwdisable sandbox="allow-scripts"></iframe>

<!-- ❌ Dangerous: could escalate to Node if matched by node-remote -->
<iframe src="https://localhost:3003/app"></iframe>

<!-- ✅ Safe: remote content with explicit restrictions -->
<iframe nwdisable src="https://example.com" sandbox="allow-scripts allow-same-origin"></iframe>
```

If you need to verify frame boundaries at runtime:
```javascript
// Built-in frame security auditing
const audit = FrameSecurity.auditAllFrames(true); // logs issues to console
console.log(audit.nodeFrames, audit.normalFrames);

// Check a specific frame
const validation = FrameSecurity.validateFrameSecurity(myIframe);
if (!validation.valid) {
  console.warn('Frame security issues:', validation.issues);
}
```

---

## 📦 Bundling Your Own Apps & Services Into NBOSP

NBOSP is designed to be the foundation for your own browser-based OS project.

You are allowed to bundle your own:

- Apps
- Services
- APIs
- System tools
- UI frameworks
- Security layers
- Custom update systems
- Drivers
- Web integrations
- App stores
- Runtime environments

into your own NBOSP-based build.

You may:

- Rename NBOSP
- Replace built-in apps
- Add your own branding
- Build commercial products on top of NBOSP
- Ship private or public releases
- Create your own editions and feature sets

NBOSP exists specifically to let people build their own systems on top of the NovaByte foundation.

> NBOSP is the only NovaByte codebase intended for unrestricted building and redistribution.

---

## 🔒 Repository Notice — v1, v2, and v3

> [!CAUTION]
> NovaByte OS `v1/`, `v2/`, and `v3/` are **not free to build upon**.

You are **not permitted** to:

- fork and redistribute them,
- modify and ship derivatives,
- create custom builds from them,
- or use them as a base for another OS

without explicit permission from the NovaByte team.

### Permission Policy

Permission must be requested from us before building upon:

- `v1/`
- `v2/`
- `v3/`
  
If permission is granted:

- you must follow all NovaByte rules and restrictions,
- your build must pass our internal checklist,
- and you may only ship your build after approval.

Failure to comply may result in permission revocation.

If you want a freely buildable base, use `nbosp/` instead.

---

## ⚠️ Deprecation Notice: NovaByte OS 1.x.x

> [!WARNING]
> **NovaByte OS 1.x.x (including v1.8.21) has reached End of Life and is no longer supported.**
>
> | | Status |
> |---|---|
> | OS security patches | ❌ No further patches will be issued |
> | New features | ❌ No backports |
> | OS-level vulnerabilities | ❌ Devices are exposed and unpatched |
> | Nova Core Services | ✅ Partial service-level patches continue |
>
> **→ Upgrade to NovaByte OS 2.x.x or 3.x.x:** download from [github.com/NovaByteOfficial/novabyte-os](https://github.com/NovaByteOfficial/novabyte-os)
>
> Users remaining on v1.x.x do so at their own risk.

---

## 📋 Versions

| Version | Status | Last OS Patch | Core Services | Notes |
|---------|:------:|:-------------:|:-------------:|-------|
| **v1.8.21** | 🔴 End of Life | 2026-04-01 | ✅ Active | Final 1.x release, deprecated |
| **v2.x.x** | 🟡 Maintenance | Active | ✅ Active | Stable, receiving security patches |
| **v3.x.x** | 🟢 Current | Active | ✅ Active | Latest version, recommended for all users — includes built-in **System Updates** app for pushing app updates to all installs without re-cloning |

---

## 🗂️ Editions

NovaByte OS supports **Editions** — named feature sets or configurations that group specific apps and capabilities together under a single identity (e.g., Home Edition, Pro Edition).

### Removal Rule

> [!CAUTION]
> **Do not remove an Edition unless you are also removing every app associated with it.**
>
> Editions are not cosmetic labels. Each Edition defines which apps are present and how they behave. If you remove an Edition identifier without removing its associated apps, those apps lose their context and will behave incorrectly or fail to launch.
>
> | Action | Required |
> |--------|----------|
> | Keeping an Edition | No changes required to its apps |
> | Removing an Edition | ❌ You **must** also remove **every app** tied to that Edition |
> | Renaming an Edition | Treat as Remove + Re-add — audit all associated apps |

Partial removal (e.g. deleting the Edition entry but leaving its apps in place) is **not supported** and will result in broken app states that are difficult to diagnose.

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** 18+
- **Git**

### Running a version

```bash
# Clone the repo
git clone https://github.com/NovaByteOfficial/novabyte-os.git
cd novabyte-os

# Start v3 (recommended)
cd v3
npm install
node server.js
```

#### Running NBOSP

```bash
cd nbosp
npm install
npm start
```

The window opens automatically — no manual browser navigation needed.

| Version | Behavior |
|---------|----------|
| v1.8.21 (EOL) | `node server.js` → navigate to `https://localhost:3001` |
| v2.x.x | `node server.js` → navigate to `https://localhost:3000` |
| v3.x.x | `node server.js` → navigate to `https://localhost:3002` |
| **nbosp** | **`npm start` → window opens automatically** |

### Optional: GitHub API rate limit

The update system works unauthenticated at **60 requests/hour**. For high-traffic deployments, add a GitHub token to your `.env` to raise this to **5,000 requests/hour**:

```env
GITHUB_TOKEN=ghp_yourtoken
```

---

## 🗂 Repository Structure

```
novabyte-os/
├── nbosp/                           # NovaByte Open Source Project (free, no rules)
│   ├── index.html
│   ├── server.js
│   └── README.md
├── v1/                              # NovaByte OS 1.8.21 (EOL)
│   ├── index.html
│   ├── server.js
│   ├── nova-core-services-routes.js
│   ├── push-core-services.js        # deprecated, see update workflow below
│   ├── cs-manifest.json             # Core Services file whitelist
│   ├── nova-custom.json             # Fork configuration
│   └── version.json                 # Installed version tracking
├── v2/                              # NovaByte OS 2.x.x
│   ├── index.html
│   ├── server.js
│   ├── auto-update-routes.js
│   ├── nova-core-services-routes.js
│   ├── cs-manifest.json
│   ├── nova-custom.json
│   └── version.json
├── v3/                              # NovaByte OS 3.x.x (Current)
│   ├── index.html
│   ├── server.js
│   ├── auto-update-routes.js
│   ├── nova-core-services-routes.js
│   ├── push-core-services.js        # deprecated, see update workflow below
│   ├── cs-manifest.json
│   ├── nova-custom.json
│   └── version.json
├── .gitignore
└── README.md
```

---

## 🔄 Update System

NovaByte OS uses a fully **GitHub-based update pipeline** — no server is needed to receive or distribute updates. Everything runs through the GitHub API.

### OS Updates

```
1. Edit your files and commit
2. Tag the release: git tag v2026.05.3 && git push --tags
3. Go to Releases → New Release, select your tag, write the changelog, and publish
```

Users clicking **Check for Updates** in the OS will see the new version automatically. The changelog you write in the release notes is shown verbatim before they install.

### Nova Core Services Updates

Same process, using a `cs-` prefix on the tag:

```
1. Edit Core Services files only
2. Tag: git tag cs-v2.1.0 && git push --tags
3. Create a GitHub Release with your cs- tag and publish
```

The update system fetches the difference between the user's installed CS version and the latest `cs-` release, then applies only files listed in `cs-manifest.json`. Nothing outside that whitelist is ever touched by a CS update.

### Built-in App Updates (v3 only)

v3 includes a **System Updates** app (`nova-updates`) that lets you push updates to individual built-in apps without requiring users to re-clone or pull anything. Updates are delivered via a hosted JSON manifest (JSONBin) and stored in `localStorage` — the patched app loads automatically on every boot.

#### Protected Apps — OS Updates Only

The following apps are **excluded from the System Updates app** and can only be updated via a full OS update. Patching these at runtime risks breaking core OS functionality:

| App | ID | Reason |
|-----|----|--------|
| Vault | `vault` | File manager + desktop handler — a bad patch breaks the desktop entirely |
| NovaSentinel | `novasentinel` | Security system — cannot be patched at runtime |
| Settings | `nook` | Manages all `OS.settings` — too risky to replace live |
| Policy Manager | `gpedit` | Controls GPO restrictions for all other apps |
| NovaReg | `novareg` | Directly edits the OS registry |
| Boot Config Editor | `bcdedit` | Changes boot order — a bad patch can leave the system unbootable |
| System Updates | `nova-updates` | Never patch the updater itself |

All other built-in apps are safe to update via the System Updates app. See `How_to_make_NovaByte_App_Updates.md` for the full workflow.

### Fork Configuration

Every build includes a `nova-custom.json` in the version folder:

```json
{
  "protected": [],
  "upstream": "NovaByteOfficial/novabyte-os",
  "upstreamCoreServices": "NovaByteOfficial/novabyte-os",
  "coreServicesTagPrefix": "cs-"
}
```

- Forks should change `upstream` and `upstreamCoreServices` to their own repo to run an **independent update pipeline**
- Files listed in `protected` are never overwritten by any upstream update
- To receive official NovaByte OS updates without running your own pipeline, leave these fields pointing to `NovaByteOfficial/novabyte-os`

### Version Tracking

Each version folder contains a `version.json`. The structure differs between versions:

**v2.x.x** — tracks OS and Core Services versions independently:

```json
{
  "osVersion": "2026.05.2",
  "coreServicesVersion": "2.1.0"
}
```

> OS updates write to `osVersion`. CS updates write to `coreServicesVersion`. They never interfere with each other.

**v3.x.x** — Core Services versioning has been removed. `version.json` now uses a single `Date` field:

```json
{
  "osVersion": "2026.05.2",
  "Date": "2026-05-11"
}
```

> In v3, the `Date` field reflects when the Core Services were last updated. There is no separate `coreServicesVersion` field.

> [!NOTE]
> **Don't confuse the Nova Core Update System `Date` field (v3) with the `NovaByte Security Patch Date`.**
>
> - The **Nova Core Update System `Date`** (in `version.json`) is the date the Core Services were last applied to this installation — it is an internal tracking field.
> - The **NovaByte Security Patch Date** (exposed via `NovaByte Security Patch Level`) is a protected system identifier read by apps to determine the OS security posture. It is entirely separate and must never be renamed or removed.
>
> These two dates may differ and serve completely different purposes.

### Upgrading to a Newer NovaByte OS Version (Fork Maintainers)

> [!IMPORTANT]
> **When you clone or pull a newer version of NovaByte OS, all security patches included in that release come with it automatically.** However, because your fork may differ from the upstream source, you are responsible for reviewing every patch and deciding what to apply, skip, or adapt manually.

When upgrading your fork to a newer NovaByte OS base, follow this process for each security patch included in the new version:

- **Backport everything compatible** — if a patch touches a file or feature that exists in your OS and has not been renamed or removed, apply it as-is.
- **If a patched element was renamed in your fork** — the patch will not apply cleanly. You must locate the renamed equivalent in your codebase and apply the fix manually. Do not skip it.
- **If a patched element was removed in your fork** — skip the patch entirely. Applying a fix for something that no longer exists will cause errors. Mark it as skipped (see below).
- **You are required to update `NovaByte Security Patch Level`** to the date corresponding to the patch set you are integrating. This field must always reflect the actual patch level of your build, even on a fork. Do not leave it at an older date after upgrading.

#### Documenting Skipped Patches

For every patch in a release that you skip (because the target was removed or is not applicable to your OS), you must document it clearly in your own changelog or release notes. Add a note alongside each patch entry:

- `Skipped for [Your OS Name]` — used when the patched component does not exist or was removed in your fork and the patch is not applicable.

This tells your users exactly which upstream patches were applied and which were intentionally skipped, so they can make an informed decision about the security posture of your build. Silence on skipped patches is not acceptable.

> **Example patch log entry:**
>
> - `app-sandbox.js` — Fixed privilege escalation in iframe sandboxing ✅ Applied
> - `driver-manager-ui.js` — Fixed driver injection vulnerability — `Skipped for MyOS` *(Driver Services not present)*
> - `nova-security-api.js` — Patched CSP bypass — Applied manually *(file renamed to `security-core.js` in MyOS)*

---

## 🛡 Nova Core Services

Nova Core Services is NovaByte's **independent security update pipeline** — separate from the main OS update system.

Even when a version of NovaByte OS stops receiving OS-level security patches, Nova Core Services continues to push security fixes to the following components:

### v3.x.x — v2.x.x (Current / Maintenance)

| Component | Files | Description |
|-----------|-------|-------------|
| 🔐 Security Runtime | `nova-security-api.js`, `app-sandbox.js` | Patch enforcement, iframe sandboxing, CSP, and privilege brokering |
| 🛡 Privacy Engine | `app-permission-manager.js` | Permission types, consent UI, and grant/revoke enforcement |
| 📦 Package Integrity | `app-package.js` | `.novaapp` creation, signing, verification, and installation |
| ⚡ App Runtime | `app-registry.js`, `web-app-manager.js`, `my-apps-manager.js` | App lifecycle, registry, web app management, and launch tracking |
| 💾 Session Manager | `session-manager.js`, `app-session-handlers.js` | Auto-save, crash recovery, and per-app state persistence |
| 🌐 NovaBridge | `api-client.js`, `socket-client.js`, `oauth-handler.js`, `novamail-integration.js` | REST/WebSocket transport, OAuth flows, and real-time sync |
| 🚀 Performance Services | `sw.js` | Caching, offline support, and push notifications |
| 🔌 Driver Services | `driver-manager-ui.js` | Hardware driver installation and management |
| ⚙️ System Shell | `user-power-menu.js` | Lock, log off, restart, and shutdown with GPO policy enforcement |

### v1.x.x (End of Life — limited coverage)

> [!NOTE]
> v1 did not ship with the Security Runtime, Privacy Engine, Package Integrity, or Driver Services components. Nova Core Services coverage on v1 is therefore limited to 5 components. This is a further reason to upgrade.

| Component | Files | Description |
|-----------|-------|-------------|
| ⚡ App Runtime | `web-app-manager.js` | Web app management and launch tracking |
| 💾 Session Manager | `session-manager.js`, `app-session-handlers.js` | Auto-save, crash recovery, and per-app state persistence |
| 🌐 NovaBridge | `api-client.js`, `socket-client.js`, `oauth-handler.js`, `novamail-integration.js` | REST/WebSocket transport, OAuth flows, and real-time sync |
| 🚀 Performance Services | `sw.js` | Caching, offline support, and push notifications |
| ⚙️ System Shell | `user-power-menu.js` | Lock, log off, restart, and shutdown with GPO policy enforcement |

This works similarly to **Google Play System Updates** — a way to patch essential components independently of the underlying OS version.

### What Core Services Cannot Fix

Nova Core Services operates within the limits of `cs-manifest.json`. It **cannot** patch:

- Deep OS-level bugs in `index.html` or the core window manager
- App sandboxing issues in the base runtime
- Vulnerabilities in the UV/bare-mux proxy layer
- Auth system problems in `server.js` or `auth-routes.js`
- Anything outside the permitted file scope defined in the manifest

> [!IMPORTANT]
> Nova Core Services provides meaningful but **limited** protection on an EOL device. It is not a substitute for a full OS upgrade.

### Required in Every Build and Fork

The Nova Core Services Update System **must be included in all builds and forks**. This ensures that if the original developer discontinues maintenance, core services can continue to receive updates, stay secure, and remain compatible with future code changes.

Be aware that vulnerabilities introduced through deeply integrated custom changes may not be patchable through Nova Core Services. We may be unable to provide fixes for custom builds that are not officially developed or authorized by us.

---

## 🍴 Fork & Identity Policy

> [!CAUTION]
> NovaByte OS is an officially versioned OS with a defined lifecycle and security model as well as a specific UI for major releases. When a version reaches End of Life, the official identity of that release is **permanently frozen**.

### ❌ Not Allowed

- Releasing modified EOL versions that keep the original NovaByte OS UI/UX while applying hidden or untracked fixes
- Creating "patched" or "secure" builds of EOL versions that still look like official NovaByte OS releases
- Maintaining an EOL branch that keeps the original UI while secretly replacing internal security, runtime, or system logic
- Presenting a fork as a "continuation of NovaByte OS" without clear rebranding and architectural changes
- Using NovaByte OS branding, versioning, or identity while fundamentally altering system behavior

### ✅ Allowed (True Derivative Systems)

- The project is clearly **rebranded** as a separate operating system
- The UI/UX is **redesigned or significantly different** (not a visual copy of official releases)
- Internal architecture changes are **documented and independently maintained**
- Security updates and system patches are **managed by the fork maintainers**
- The project does **not** suggest official support or continuity from NovaByte OS

### Built-in Apps — Names & Themes

> [!NOTE]
> **Built-in app names may be kept as-is.** The renaming requirement applies to the OS itself — not to the apps that ship with it. If your fork keeps Nova File Manager, Nova Terminal, or any other built-in app under its original name, that is fine.
>
> **Built-in app themes are not required to change.** The look and feel of built-in apps can remain identical to the official NovaByte versions. You are not required to restyle them, and they are free to use in your build as shipped.
>
> The only identity you must change is the **OS name itself**. Everything inside it is yours to keep, modify, or extend however you want.

### Core Principle

> If it resembles NovaByte OS but is no longer maintained by the official NovaByte project, **it must not be called NovaByte OS.**
>
> **Derivation is allowed. Identity continuation is not.**

This ensures users can differentiate between **official NovaByte OS releases** (authoritative) and **independent operating systems** inspired by NovaByte (community or third-party).

---

## 📋 Your OS Security Update

Forks and custom builds may add their own **Your OS Security Update** entry alongside the official NovaByte security information. This exists so downstream operating systems can document security work specific to their own implementation without modifying or replacing the official NovaByte Security Patch Level or Security Bulletin.

### What it means

If someone forks NovaByte OS and creates their own operating system, they **must** include their own security update row using the following format:

| Security Update Row | Date |
|---------------------|-----:|
| AstroOS Security Update | 2026-05-01 |
| NebulaOS Security Update | 2026-04-01 |
| EnterpriseOS Security Update | 2026-03-01 |

The row is **required** to be named `[Your OS Name] Security Update` — the OS name and the label `Security Update` combined — with the date of the most recent security update on the far right. That row belongs entirely to the fork maintainer and documents security changes specific to that operating system.

### Date Format Rule

> [!IMPORTANT]
> **All dates across `NovaByte Security Patch Level`, `Nova Core Services`, and your OS's `Security Update` row must use the first day of the month — always.**
>
> | ✅ Correct | ❌ Never used |
> |-----------|--------------|
> | `2026-05-01` | `2026-05-14` |
> | `2026-04-01` | `2026-04-23` |
> | `2023-09-01` | `2023-09-30` |
>
> Dates represent the **month** a patch set was issued, not the specific day. Always set the day to `01`.

### What fork maintainers typically use it for

| Use Case                                 | Example                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| Documenting fork-specific security fixes | Patched custom runtime vulnerabilities not present upstream                |
| Explaining architectural changes         | Replaced sandboxing layer, modified CSP model, custom proxy stack          |
| Listing downstream patches               | Added hardening rules, removed vulnerable components, updated dependencies |
| Publishing compatibility notes           | Features or APIs changed compared to upstream NovaByte OS                  |
| Linking external advisories              | Security bulletins, changelogs, CVE writeups, or release notes             |

### Important distinction

The following system identifiers remain official upstream NovaByte identifiers and must never be removed or replaced:

- `NovaByte Security Patch Level`
- `NovaByte Version`
- `NovaByte Security Bulletin`

A fork's `Your OS Security Update` entry exists **alongside** those identifiers — not instead of them.

This allows users to distinguish:

- what security patches came from official NovaByte OS,
- what additional changes were made by the fork maintainer,
- and whether the fork is actively maintained at all.

### NovaByte does not control this section

NovaByte does not define how this row behaves or what it contains.

Fork maintainers may implement it however they want:

- clickable changelog links,
- expandable patch summaries,
- modal-based release notes,
- static version displays,
- or nothing at all.

The purpose of this section is transparency for downstream operating systems — not upstream control.

> [!NOTE]
> A fork may add its own security updates, but it cannot erase or redefine official NovaByte security history. The upstream NovaByte Security Patch Level and Security Bulletin remain authoritative regardless of downstream modifications.

---

## 🏷️ Protected System Identifiers

Certain system-level strings in NovaByte OS are **permanently locked** and must never be renamed, removed, or altered in any build, fork, or derivative.

> [!CAUTION]
>
> ### `NovaByte Security Patch Level` and `NovaByte Version`
>
> These two identifiers are treated the same way Android OEM manufacturers treat `Android Security Patch Level` and `Android Version` — **no one touches them.** Every manufacturer ships Android without renaming these fields, because apps across the ecosystem query them by exact string. NovaByte OS works the same way.
>
> Apps built on NovaByte OS read these identifiers directly by name to determine compatibility, enforce security requirements, and display version information to users. If either string is changed — even slightly — **those apps will silently fail, crash on launch, or never open at all.** Users will have no indication of why.
>
> | Identifier | Status | Rule |
> |------------|--------|------|
> | `NovaByte Security Patch Level` | 🔒 Locked | Never rename, never remove |
> | `NovaByte Version` | 🔒 Locked | Never rename, never remove |
>
> This applies to:
>
> - All official builds and releases
> - All forks and derivative systems, even if rebranded
> - All `.novaapp` packaging and any tooling that reads system metadata
>
> **There are no exceptions.** If your fork displays its own version branding, do so by adding a new field alongside these — never by replacing them.

---

## 🔐 Security

- All versions use **HTTPS** with self-signed certificates locally
- **CSRF protection** and **rate limiting** are active on all API routes
- Nova Core Services routes (`/api/coreservices/`) are excluded from CSRF to allow the independent patch pipeline to function

If you discover a security vulnerability, please **open a private issue** or contact the maintainer directly rather than filing a public bug report.

---

## 📄 License

Private repository — all rights reserved.

---

---

## 🔒 May 2026 Security Bulletin — v3 Only (Yes, Only v3. Sit Down, v2.)

NovaByte OS v3 received a **sweeping security overhaul** in May 2026. Here's what changed — and why v1 and v2 users should feel a very specific kind of existential dread right now.

### What v3 got

| Fix | What it means |
|-----|--------------|
| `unsafe-inline` removed from CSP — replaced with per-request nonces | Inline script execution is now actually locked down instead of politely suggested |
| SHA-384 SRI on both pdf.js CDN files | A compromised CDN now gets hard-blocked instead of silently owning your PDF viewer |
| Referrer-Policy + Permissions-Policy added to Helmet | Headers that were aspirational are now real |
| Security bulletin API origin validation | The API that verifies security was itself unvalidated. Fixed. Yes, really. |
| postMessage `'*'` → `event.origin` in bulletin API | A security compliance API was broadcasting responses to any origin that asked. It was not the best look. |
| CVE-NB-2026-001 through CVE-NB-2026-009 fully audited and resolved | Nine CVEs. All closed. Probes ship with the OS to verify each one at runtime. |

### What v2 got

Nothing.

> [!WARNING]
> **v2 users:** everything listed in that table above? You don't have any of it. Your CSP is `unsafe-inline`. Your pdf.js CDN is trusted unconditionally. Your security headers are vibes. Your bulletin API — if you have one — replies to `'*'`. You are running a UV proxy and a built-in browser on top of all of this. We wish you well. We really do. Upgrade link is at the top of this file. We put it there on purpose.

### What v1 got

Also nothing. v1 never had a Security Runtime, Privacy Engine, or Package Integrity system to begin with. It is not so much "vulnerable" as it is "a different era of computing entirely." Running v1 in 2026 is a bold lifestyle choice and we respect the commitment.

> [!CAUTION]
> **v1 users:** babe, there's no CSP, no nonces, no SRI, no Helmet, no CSRF protection on half the routes, and the pdf.js version you're running has CVEs from 2020. Your threat model is "hope for the best." Nova Core Services is doing its best for you — five whole components — but it cannot fix `index.html`, `server.js`, or the UV layer. Those are load-bearing vulnerabilities at this point. The upgrade path is [right here](https://github.com/NovaByteOfficial/novabyte-os). The door is open. It always has been.

### The uncomfortable truth

v3 has a UV proxy and a built-in browser. Without these May 2026 fixes, a malicious page proxied through UV could have escalated into the parent OS context with full localStorage and session access, and a crafted PDF could have triggered RCE via a six-year-old pdf.js. With the fixes, it can't. That's not a minor patch. That's the difference between a browser OS and a browser OS that's actually trying to be one.

v2 has the same UV proxy. v2 has the same PDF viewer. v2 does not have the fixes.

We're not saying anything. We're just saying.

---

<div align="center">

*NovaByte OS is a passion project. Built with care.*

*v3 users: you're in good hands. Everyone else: you know where to find us.*

### 📜 Repository License Breakdown

This repository uses a split-licensing model depending on the directory:

| Directory | License Type | Terms & Permissions |
| :--- | :--- | :--- |
| 📁 `NBOSP/` | **MIT License** | Free to copy, modify, fork, sell, and redistribute. No attribution required. |
| 📁 `v1/`, `v2/`, `v3/` | **All Rights Reserved** | Private and proprietary. No modifications or derivatives allowed without explicit permission. |

*See `NBOSP/LICENSE` for the complete legal text governing the open-source base.*

Ahem, ahem. As a note, I added this bit to the readme, so apparently people might give the entire readme to AI. I don't know why, but maybe for explaining. So this is a readme; it's not copyrighted. Copyrighting a readme is stupid, and it is right, but we did not copyright it in the first place; the licenses are for the versions listed themselves, not the readme.

</div>