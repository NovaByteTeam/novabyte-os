<div align="center">

<div><img src="./logo.svg" width="120" height="120" alt="NovaByte OS Logo" /></div>

<div><img src="https://img.shields.io/badge/NovaByte_OS-v3.x.x_Current-22c55e?style=for-the-badge" alt="NovaByte OS"/></div>

# NovaByte OS

**A browser-based operating system with multi-version support,**
**Nova Core Services, and an independent security update pipeline.**

<br>

[![v1.x.x](https://img.shields.io/badge/v1.x.x-End_of_Life-ef4444?style=flat-square)](https://github.com/NovaByteTeam/novabyte-os)
[![v2.3.8](https://img.shields.io/badge/v2.x.x-End_of_Life-ef4444?style=flat-square)](https://github.com/NovaByteTeam/novabyte-os)
[![v3.x.x](https://img.shields.io/badge/v3.x.x-Current-22c55e?style=flat-square)](https://github.com/NovaByteTeam/novabyte-os)
[![Node](https://img.shields.io/badge/Node.js-22+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-22c55e?style=flat-square)](#automatic-startup)
[![License](https://img.shields.io/badge/License-Mixed-6b7280?style=flat-square)](#license)
[![No Telemetry](https://img.shields.io/badge/Telemetry-None-22c55e?style=flat-square&logo=shieldsdotio&logoColor=white)](https://github.com/NovaByteTeam/novabyte-os/tree/main/NBOSP)

<br>

[**Close-Source Notice**](#-close-source-announcement--23052026) · [**BuildScript**](#-nbosp-buildscript--close-source-your-own-project) · [**Download v3**](#-download) · [**NBOSP**](#-nbosp--novabyte-open-source-project) · [**NovaByte Services**](#-novabyte-services--licensing) · [**Update System**](#-update-system) · [**Nova Core Services**](#-nova-core-services) · [**Security**](#-security) · [**Versions**](#-versions)

</div>

-----

## Close-Source Announcement — 23/05/2026

> [!IMPORTANT]
> **NovaByte OS source code was closed on 23 May 2026.**

This release uses three layers of protection:

- **JavaScript obfuscation** — all JavaScript is obfuscated before packaging
- **NW.js (Node-Webkit)** — the app ships as a desktop executable via NW.js
- **V8 bytecode compilation** — source files are compiled to V8 bytecode before release

The full git commit history has also been removed, so there is no history to browse, diff, or trace.

### app.bin

All core OS logic lives in `app.bin`. It contains compiled bytecode, so it is intentionally difficult to inspect or recover into readable source. Recovering meaningful source code from `app.bin` is intentionally made extremely difficult through V8 bytecode compilation and additional protection layers.

### index.html

**`index.html` is encrypted with 256-bit AES-GCM-SIV.** Half of the key is bundled into `server.js` and the other half lives in `app.bin`, so the file is protected rather than exposed as plain text.

### style.css

**`style.css` is also encrypted with 256-bit AES-GCM-SIV.** It uses the same split-key model as `index.html`, with one half in `server.js` and the other half in `app.bin`.

### HTML / CSS Encryption

We replaced the old base64 + gzip approach with **256-bit AES-GCM-SIV encryption** for these assets. The key is split between `server.js` and `app.bin`, and the BuildScript below shows the packaging flow used for release builds.

-----

## 📦 NBOSP BuildScript — Close Source Your Own Project

If you want to close source your own NBOSP-based project the same way we did, we’ve uploaded our **build script** to this repo’s Releases under the tag:

> **`BuildScript`**

**→ [Download the BuildScript from Releases](https://github.com/NovaByteTeam/novabyte-os/releases/tag/BuildScript)**

It handles the full pipeline: JavaScript obfuscation, V8 bytecode compilation, AES-GCM-SIV HTML/CSS encryption, NW.js packaging, and release generation. Use it as a starting point for your own close-source build.

-----

## ⬇️ Download

> [!IMPORTANT]
> **v1, v2, and v3 source code is fully closed source and has been removed from this repository.**
> The compiled v3 executable is available via GitHub Releases.

**→ [Download NovaByte OS v3 (Latest Release)](https://github.com/NovaByteTeam/novabyte-os/releases/latest)**

Download the `.zip`, extract it, and run the executable. No installation is required.

-----

## 🛠️ Building .novaapp Apps? Use NovaByte Studio

**[NovaByte Studio](https://github.com/NovaByteOfficial/novapack-studio)** is the best tool for creating and testing `.novaapp` packages. It bundles NBOSP inside it so you can build and test your app without setting up NBOSP separately — just download Studio and start building.

> **Want to build your own OS based on NBOSP?** That's what this repo is for — fork it and build on top of it. Studio is for `.novaapp` app development only.

**[Download NovaByte Studio →](https://github.com/NovaByteOfficial/novapack-studio/releases)**

---

## 🆓 NBOSP — NovaByte Open Source Project

The `NBOSP/` folder in this repo is the **free, open base of NovaByte**.

> **Who is NBOSP for?** Developers and people who want to run NovaByte daily — those who just want pure stock software. No bloat, no fluff, no extras. Just a minimal, super fast, and clean OS that gets out of your way.

> [!WARNING]
> **NBOSP is a foundation, not a finished product. Read this before you download.**
>
> A large codebase does not mean feature-rich. NBOSP has thousands of lines of code — most of that is OS infrastructure, security, routing, server logic, and plumbing. **The apps and user-facing features are intentionally bare bones.** Each app does the basics and stops there. No advanced functionality, no rich settings, no polish you would expect from a commercial OS. If you open Files you can browse files. If you open Music you can play a track. That is roughly the level across the board.
>
> **This is by design.** NBOSP is the raw skeleton — the base you fork and build on top of. It is not competing with v3 or any consumer OS on features. If you want a fully featured NovaByte OS, download v3 from [Releases](https://github.com/NovaByteTeam/novabyte-os/releases/latest).

- Use, copy, modify, fork, sell, and redistribute it under the Apache 2.0 licence.
- Preserve the copyright notices and the `NBOSP/LICENSE` text.
- This is the NBOSP foundation.
- Basic security (rate limiting, CSRF protection, security headers) is built in
- No edition system, no update pipeline, and no telemetry
- The NBOSP apps are stock versions — pure NovaByte apps that we replaced with our own feature-heavy versions in v3. We took NBOSP and built on top of it with an update system and many more features.
- We maintain two separate app lines: NBOSP apps and our own full-featured apps.
- The NBOSP apps are feature-frozen — we are not adding new features or making interface changes to them, but compatibility, bug, and security fixes continue as always. **Settings is the one exception.** It is not really an app — it is the configuration layer for the entire OS. It controls the visual identity of every part of the UI (themes, accents, layout), not just its own window. Because of that, Settings will continue to receive visual changes and new features as NBOSP itself evolves — anything that affects how the OS looks or integrates at the system level lives there.
- NBOSP itself (the OS) is **not abandoned** — we will keep shipping fixes and anything new we can. It won't always be exciting or frequent, but we're not done. We actually ship fixes faster than v3 — the codebase is small and easy to maintain.
- All listed apps are built specifically for NBOSP and are free to use, customise, or modify however you like.

### 📱 What the NBOSP Apps Actually Do

These are the **actual features pulled directly from the source code** — not guesses based on the app name. The codebase is large but most of that is OS infrastructure (VFS, security, routing, workers). The apps themselves are minimal.

|App|What it actually does|
|:--|:--------------------|
|📁 **NBOSP Files**|Icon grid and list view. Sort by name, size, type, or modified date. Back/up navigation with a path bar. Search within the current folder. New file/folder, copy, cut, paste, rename (F2), move to trash, restore, permanent delete. Multi-select (Ctrl+A). Drag-and-drop file import. Keyboard shortcuts. **No tabs, no split panes, no cloud sync, no bulk rename.**|
|📝 **NBOSP TextEdit**|Plain text editor. Line numbers, status bar showing line/column/word count, Tab indentation, auto-close brackets, Save/Save As to the VFS. Ctrl+S to save. Word count via context menu. **Single file at a time only — no file list, no tabs, no rich formatting, no markdown preview.**|
|💻 **NBOSP Terminal**|A real shell emulator with a working command set: `ls`, `cd`, `cat`, `grep`, `cp`, `mv`, `rm`, `mkdir`, `find`, `diff`, `wc`, `sort`, `head`, `tail`, `echo`, `env`, `export`, `alias`, `history`, `ps`, `neofetch`, and more. Pipe chains, `&&`/`||`/`;` chaining, output redirect (`>`), tab autocomplete, command history, custom aliases, shell variables, multiple tabs (Ctrl+Shift+T). **All commands run against the VFS — not a real system shell.**|
|🌐 **NBOSP Browser**|NW.js WebView with real site rendering. Tabs, bookmarks, history, incognito mode, find-in-page (Ctrl+F), zoom controls, mobile/desktop user-agent toggle, popup blocker, per-tab WebView/iframe mode toggle. See the [browser section](#-nbosp-browser--now-powered-by-nwjs--webview) for full details. **No extensions, no sync, no password manager.**|
|📅 **NBOSP Calendar**|Month, week, day, and agenda views. Mini calendar sidebar. Upcoming events list. Create/edit/delete events with title, date, start/end time, description, and colour. Navigate prev/next/today. **No recurring events, no reminders/notifications, no calendar sync (Google, Outlook, etc.).**|
|📧 **NBOSP Email**|Multi-account IMAP/POP3/Exchange. Sidebar with Inbox, Sent, Drafts, Trash, Spam, Archive, Starred. Search, compose, reply, forward, batch-select, pagination. **No filters/rules, no tags, no offline cache.**|
|🖼 **NBOSP Gallery**|Scans the VFS for image files and shows them in a grid. Lightbox viewer with prev/next navigation, filename caption, and keyboard support (arrow keys, Escape). **No editing, no albums, no metadata, no sorting — just a viewer.**|
|⬇️ **NBOSP Downloads**|Displays files saved from the browser: name, size, date, and status badge (done/downloading/failed). Remove individual items or clear all completed. Live-updates via a global `Downloads.add()` API. **No download queue controls, no pause/resume, no browser integration for in-progress downloads.**|
|👤 **NBOSP Contacts**|Add/edit/delete contacts with name, email, phone, and notes fields. Alphabetically sorted list. Search by name, email, or phone. Avatar initials. **No groups, no import/export (vCard, CSV), no photo support.**|
|🔍 **NBOSP Search**|System-wide search across files (by filename), contacts (name/email/phone), downloads list, and live web results via DuckDuckGo. Clicking a result opens the relevant app or browser. Up to 12 results per section. **Filename matching only for local files — no full-text/content search inside files.**|
|🕐 **NBOSP Clock**|Four tabs: analog+digital clock with date display; alarms with custom time, label, and day-of-week repeat (toggle on/off per alarm); countdown timer with H/M/S input, start/pause/reset; and stopwatch. **No world clock, no multiple time zones.**|
|⚙️ **NBOSP Settings**|Appearance (7 themes: Nova Dark, Nova Light, Nord, Dracula, Catppuccin, Tokyo Night, Gruvbox; accent colour picker; 12/24h clock toggle), System (change username), Storage, Privacy, Desktop, Accessibility, About. **Settings are thin — each section has a handful of toggles, not deep configuration panels.** Unlike the other apps, Settings is actively developed — it controls the visual identity and OS-level behaviour of the entire UI, so it will keep receiving new options and visual updates as NBOSP evolves.|
|🖩 **NBOSP Calculator**|Standard arithmetic with live expression preview. Supports `+`, `-`, `*`, `/`, `%`, parentheses, and decimal input. Backspace, clear, keyboard support. **No scientific mode, no history, no unit conversion.**|
|📦 **NBOSP App Manager**|Install `.novaapp` packages from disk. Manage web apps (add by URL). Pin/unpin apps to the taskbar. Enable/disable installed apps. Set apps to auto-launch on boot. Install log. **No app store/catalogue, no update management, no package signing verification in the UI.**|

> [!IMPORTANT]
> **Starting with 3.0.2, no new features will be added to NBOSP apps.** Compatibility fixes, bug fixes, and security patches continue as always. **Settings is the only exception** — it controls the visual identity and OS-level behaviour of the entire UI, so it will keep receiving updates.

> **Want the full-featured NovaByte OS?** Download the compiled v3 from [Releases](https://github.com/NovaByteTeam/novabyte-os/releases/latest). NBOSP is just the foundation — the base code you build on.

> [!NOTE]
> **Versioning:** NBOSP and v3 share the same version numbering format. The only difference is the product name prefix:
> - NBOSP releases are named **NovaByte 3.0.2** (no "OS")
> - v3 releases are named **NovaByte OS 3.0.2**
>
> The version numbers themselves are identical and stay in sync.

### 🔄 NBOSP App Updates

NBOSP does **not** use the built-in System Updates app. Updates to NBOSP apps depend entirely on your **forker or maintainer**.

If NovaByte fixes or improves something in the NBOSP source, that fix lives in the upstream repo. Your fork does not receive it automatically. Your forker or maintainer has to pull the change, repackage it, and release their own updated build.

|Update type                |How you get it                      |
|-------------------------------------------|---------------------------------------------------------|
|NBOSP app fix from upstream NovaByte    |Forker/maintainer repackages → you re-clone their release|
|NBOSP app fix from your own fork maintainer|Forker/maintainer releases → you re-clone        |
|v3 built-in app fix            |System Updates app → click Update → done         |

### 🌐 NBOSP Browser — Now Powered by NW.js & WebView

**MASSIVE UPDATE (May 2026):** NBOSP Browser has been completely rebuilt using **NW.js (Node-Webkit)** as the rendering engine with **WebView** support, replacing the previous iframe + Ultraviolet proxy architecture.

#### What Changed

**Old approach (iframe + Ultraviolet proxy):**

- The browser was completely broken — unable to properly browse most websites
- UV proxy returning 400 and Bad Request errors
- Cookie support broken, tab switching issues
- Email app limited by iframe isolation

**New approach (NW.js + WebView):**

- ✅ Native browser rendering with full site compatibility
- ✅ Cookie support now fully functional
- ✅ Tab switching works reliably
- ✅ Email app now uses webview — all iframe limitations removed
- ✅ All UV proxy errors completely eliminated
- ✅ Everything “just works” out of the box

#### New Features in NBOSP Browser (Minor updates may still follow)

- **Bookmarks** — Save and organize your favorite websites
- **History** — View and quickly access previously visited pages
- **Find in Page** — Search for text within a page using Ctrl+F
- **New Incognito Tab** — Browse privately without recording history
- **Mobile/Desktop Site Toggle** — Switch between mobile and desktop user agent
- **Zoom Controls** — Adjust page zoom (In, Out, Reset)
- **Dialup Page** — Classic retro homepage for quick access to common sites
- **iFrame / Webview Mode Toggle** — Switch between NW.js WebView and sandboxed iFrame mode per tab
- **Popup Blocker (fixed)** — Blocks intrusive popups while allowing OAuth and login flows through

#### Automatic Startup

Running `npm start` in the NBOSP folder automatically prepares and launches NBOSP.

On startup, NBOSP checks whether dependencies are installed. If `node_modules` is missing, the bootstrap system runs the appropriate package manager command for the current platform and waits for installation to complete before launching.

Supported platforms:

- Windows
- Linux
- macOS

After dependencies are installed, NBOSP launches automatically.

This means a fresh clone can be started immediately with:

```bash
npm start
```

No separate `npm install` step is required on first run.

-----

## 🔑 NovaByte Services — Licensing

> [!CAUTION]
> **NovaByte Services are not free to bundle. They require explicit permission and a licence from us.**

> [!IMPORTANT]
> **NovaByte Services are not available to individuals or the general public. Licences are only issued to developers or teams actively building and capable of releasing a full consumer operating system.**

NovaByte Services includes:

- **Nova Core Services** — the independent security update pipeline
- **NovaBridge** — REST/WebSocket transport, OAuth flows, and real-time sync
- **Sentinel Security System** — the full security runtime, privacy engine, and threat detection
- **System Updates app** — the built-in app update pipeline
- **NovaByte Edition System** — edition management and feature sets
- **NovaByte Proprietary Apps** — closed-source, fully-featured apps built by NovaByte (see below)
- **Any other service, API, or system component developed by NovaByte** that is not part of NBOSP

### 📱 NovaByte Proprietary Apps

NovaByte Services includes a suite of **closed-source, proprietary NovaByte apps**. These are not open source and are not part of NBOSP.

> [!IMPORTANT]
> **Any NovaByte Services license requires bundling Horizon Browser and NovaMail alongside your own browser and email apps. These are not replacements — both your apps and ours must ship together. Additional NovaByte apps are optional.**

#### Required Alongside Your Own Apps

These two apps **must be bundled** in any NovaByte Services-licensed OS, shipping **alongside** the licensee's own browser and email client:

| App | Description |
|-----|-------------|
| 🌐 **Horizon Browser** | NovaByte's proprietary browser. Must ship alongside your own browser. Includes server-side email image proxying (requests are stripped of tracking headers and parameters before leaving your machine; a VPN is required for actual IP privacy), per-tab webview/iframe mode, bookmarks, history, incognito tabs, find-in-page, zoom controls, popup blocker, and mobile/desktop site toggling. |
| 📧 **NovaMail** | NovaByte's proprietary email client. Must ship alongside your own email app. Includes server-side email image proxying. |

#### Optional Apps (choose any)

Beyond the two required apps, you may choose to include any of the following:

| App | Description |
|-----|-------------|
| 🎵 **Resonance** | Music and audio player |
| 🖼 **Prism** | Image viewer and media gallery |
| 🛒 **Marketplace** | App store |
| 🎨 **PixelDrop** | Notes App |
| 📄 **Lumina** | Document viewer and PDF reader |
| 🛡 **NovaSentinel** | Security dashboard and threat monitoring |
| 🔐 **Encryption Vault** | Key generation app with military-grade types |
| 🖩 **Calc+** | Advanced calculator |
| 🕐 **NovaClock** | Clock, alarms, timers, and world time |

You may not modify or redistribute NovaByte proprietary apps outside the terms of your NovaByte Services licence.

### Who Can Apply

Licenses are **only** considered for developers or teams who:

- Are building a **full consumer-facing operating system**
- Are capable of **releasing and maintaining** that OS to real end users
- Can demonstrate the scope and seriousness of their project

**Personal projects, experiments, hobby builds, and individual use cases do not qualify — no exceptions.**

### How to Get a License

If you meet the above criteria and want to bundle NovaByte Services into your OS:

1. **Contact us** — reach out and describe your OS, your team, and what services you want to use
1. **We review your request** — we assess whether your project qualifies
1. **If approved**, we issue a license with specific terms for your use case
1. **You must comply** with all conditions set in your license

**No permission = no bundling. There are no exceptions.**

> We built these services from the ground up for a serious OS product. If you are building something at that level and want them in your product, reach out. NovaByte Services are not available to individuals or anyone outside that scope — permission is required, and not everyone will get it.

-----

## 🏗️ NBOSP Server Architecture — Modular & Security-First

The NBOSP backend (`NBOSP/server/`) has been refactored into a clean, modular architecture with separation of concerns, making it easy to maintain, test, and extend.

### Server Folder Structure

```
server/
 ├── core/
 │  ├── index.js   # Main Express entry point (330 lines)
 │  ├── middleware.js # Security stack: CSP, CORS, rate limiting, sessions (250 lines)
 │  ├── ssl.js    # HTTPS/HTTP server factory with graceful fallback (50 lines)
 │  └── env.js    # Environment validation with fallback seeds (50 lines)
 ├── routes.js     # Sub-router mounting (security + email APIs)
 ├── favicons.js    # Favicon proxy with SSRF protection + DB caching (400 lines)
 └── proxies.js    # Search suggest & email image proxies (500 lines)
```

### Key Features

#### Content Security Policy (CSP) — Nonce-Based

- **Unique nonce per request** — `crypto.randomBytes(16)` generates a fresh base64 nonce on every page load
- **Automatic injection** — Server regex injects the nonce into every `<script>` and `<style>` tag in `index.html`
- **Global exposure** — Nonce is exposed via `window.__cspNonce` for dynamic element creation
- **No unsafe-inline** — CSP header explicitly forbids inline scripts/styles without nonce

**How it works:**

1. Middleware generates: `res.locals.nonce = crypto.randomBytes(16).toString('base64')`
2. Helmet CSP header includes: `'nonce-${nonce}'` for script and style directives
3. GET / route rewrites HTML: `/<script([\s>])/g` → `<script nonce="${nonce}"`
4. Frontend apps use: `setAttribute('nonce', window.__cspNonce)` for dynamic styles

#### Security Layers

| Layer | What it does |
|-------|-------------|
| **Helmet CSP** | Enforces strict Content Security Policy with nonce-based script/style execution |
| **CORS** | Configurable origins, credentials, methods, and allowed headers |
| **Rate Limiting** | Dedicated limits for email image proxy |
| **CSRF Protection** | Session-based CSRF tokens with secure, httpOnly cookies |
| **Session Management** | Express-session with 24h expiry, sameSite=lax, secure on production |
| **SSRF Guards** | Private IP blocking on all proxy endpoints (favicon, email image proxy) |
| **Security Headers** | X-Content-Type-Options, X-XSS-Protection, CORP policies |

#### Modular Proxies

**Email Image Proxy** (`GET /api/email-image?url=..`)
- Fetches images through a local server-side proxy for SSRF protection
- SSRF protection: blocks private IP ranges
- Inline redirect validation (max 5 hops)
- Cache: 1h TTL, 200 entry cap
- Default: 1x1 transparent PNG on error
- Rate limit: 500 req/min per IP

**Favicon Proxy** (`GET /api/favicon?domain=..`)
- Fetches favicons from domain with SSRF protection
- SQLite database cache (better-sqlite3)
- 24h TTL per entry, max 500 entries, LRU eviction
- Fallback chain: direct → DuckDuckGo icon service
- MIME detection: PNG, GIF, JPEG, WebP, AVIF, ICO, SVG
- ICO parsing: extracts best PNG frame from ICO files

#### Environment Configuration

Sensible defaults for development with fallback secrets:

```javascript
// Development fallbacks (git-ignored in production)
NBOSP_CRED_KEY=abcd1234.. (AES-GCM-SIV key for email credentials)
SESSION_SECRET=efgh5678.. (express-session signing key)
PORT=3003
CORS_ORIGIN=https://localhost:3003
```

Validation ensures:
- Numeric vars are in valid ranges (PORT: 1-65535)
- Secrets are hex strings 32+ chars
- CORS origins include https://

### Startup Flow

```
npm start
 ↓
scripts/startup.js spawns Node
 ↓
server/index.js boots Express
 ↓
setupMiddleware(app) ← Helmet, CORS, rate limiting, CSP nonce
 ↓
GET / with nonce injection ← Runs BEFORE static middleware
 ↓
Static assets served ← /js, /assets, /css (except index.html)
 ↓
Favicon/proxy/security routes mounted
 ↓
Listen on 127.0.0.1:3003 (or HTTPS if certs present)
```

### Extension Points

To add new features to NBOSP, you have clear entry points:

1. **New API endpoint?** → Add to `security/routes.js` or `email/index.js`
2. **New proxy?** → Add to `server/proxies.js` or create a new module
3. **New middleware?** → Add to `server/middleware.js` or create in `security/middleware.js`
4. **New rate limit tier?** → Define in `server/middleware.js` and mount in `server/index.js`
5. **Configuration changes?** → Edit `server/env.js` for env vars or Helmet CSP in middleware

All modules are independent and require only their immediate dependencies — no global state, no tight coupling.

-----

## 🔒 Repository Notice — v1, v2, and v3

> [!CAUTION]
> **NovaByte OS v1, v2, and v3 source code is fully closed source.**
> **It has been completely removed from this repository.**
> **Git commit history has been wiped. There is no history to inspect.**
> The source is not available. The compiled v3 executable is available via [GitHub Releases](https://github.com/NovaByteTeam/novabyte-os/releases/latest).

The close-source build uses JavaScript obfuscation, V8 bytecode compilation, NW.js packaging, and AES-GCM-SIV encryption for `index.html` and `style.css`. The encryption key is split between `server.js` and `app.bin`. All OS logic is compiled into **`app.bin`** — do not attempt to reverse engineer or deobfuscate it. **`index.html`** and **`style.css`** are protected assets, not plain source files. See the [Close-Source Announcement](#-close-source-announcement--23052026) section for full details.

You are **not permitted to**:

- fork and redistribute them,
- modify and ship derivatives,
- create custom builds from them,
- or use them as a base for another OS

without explicit permission from the NovaByte team.

If you want a freely buildable base, use `NBOSP/` instead.

-----

## ⚠️ Deprecation Notice: NovaByte OS 1.x.x

> [!WARNING]
> **NovaByte OS 1.x.x has reached End of Life and is no longer supported.**
> 
> |            |Status                 |
> |------------------------|----------------------------------------|
> |OS security patches   |❌ No further patches          |
> |New features      |❌ No backports             |
> |OS-level vulnerabilities|❌ Devices are exposed and unpatched   |
> |Nova Core Services   |✅ Partial service-level patches continue|
> 
> **NovaByte OS 2.x.x has also reached End of Life and is no longer supported.**
> 
> **→ Upgrade to NovaByte OS 3.x.x:** download from [Releases](https://github.com/NovaByteTeam/novabyte-os/releases/latest)

-----

## 📋 Versions

> [!NOTE]
> **Versioning naming:** NBOSP and v3 use the same version number format. NBOSP releases are named **NovaByte 3.x.x** and v3 releases are named **NovaByte OS 3.x.x** — the numbers are identical, only the product name prefix differs (e.g. `NovaByte 3.0.2` = `NovaByte OS 3.0.2`).

|Version  |Status    |Last OS Patch|Core Services|Notes                                 |
|-----------|:-----------:|:-----------:|:-----------:|----------------------------------------------------------------------|
|**v1.8.21**|🔴 End of Life|2026-04-01  |✅ Active   |Final 1.x release, deprecated                     |
|**v2.3.8**|🔴 End of Life|2026-05-01  |✅ Active   |Final 2.x release, deprecated                     |
|**v3.x.x** |🟢 Current  |Active    |✅ Active   |Latest version, recommended — includes built-in **System Updates** app|

-----

## 🚀 Getting Started

### Running NBOSP

```bash
git clone https://github.com/NovaByteTeam/novabyte-os.git
cd novabyte-os/NBOSP
npm start
```

The window opens automatically — no manual browser navigation needed.

> [!NOTE]
> NBOSP automatically checks for dependencies on startup. If `node_modules` is missing, the required packages are installed automatically before launch. This only happens on first run or if dependencies have been removed.

**On first launch, three things happen automatically:**

- Project dependencies are installed if required.
- A `.env` file is generated with a secure random `SESSION_SECRET` and sensible defaults.
- A local HTTPS certificate and CA are generated. A native OS prompt will appear asking you to trust the CA — click **Yes** (Windows) or enter your password (macOS/Linux). This only happens once. After that, the app opens over HTTPS with no browser warnings, permanently.

### Running v3

Download the compiled exe from [Releases](https://github.com/NovaByteTeam/novabyte-os/releases/latest), extract the zip, and run it. No Node.js or cloning required.

-----

## 🗂 Repository Structure

```
novabyte-os/
├── NBOSP/              # NovaByte Open Source Project (free, no rules)
│  ├── index.html          # Single entry point (nonce injection target)
│  ├── style.css          # Global styles
│  ├── ui-init.js          # UI initialization hooks
│  ├── client.js          # Minimal ~11-line entry point stub
│  ├── server/           # Backend modules
│  │  ├── core/          # Core server modules (nested)
│  │  │  ├── index.js       # Main Express entry point (330 lines)
│  │  │  ├── middleware.js    # Helmet CSP, CORS, rate limiting, CSRF, sessions (250 lines)
│  │  │  ├── ssl.js        # HTTPS/HTTP server factory with graceful fallback (50 lines)
│  │  │  └── env.js        # Environment validation with fallback secrets (50 lines)
│  │  ├── routes.js        # Sub-router composition and mounting
│  │  ├── favicons.js       # Favicon proxy with SSRF protection, DB caching (400 lines)
│  │  └── proxies.js        # Email image proxy (500 lines)
│  ├── scripts/           # Launcher modules
│  │  ├── startup.js        # NW.js app initialization, window spawn, logging streams
│  │  ├── env.js          # Platform-specific environment validation, secret generation
│  │  ├── certs.js         # HTTPS certificate generation and validation
│  │  ├── ca-trust.js       # Local CA trust (Windows certutil, macOS security, Linux NSS)
│  │  ├── bootstrap.js       # Dependency auto-install, first-run setup, self-healing config
│  │  ├── logger.js        # Centralized logging and output capture
│  │  └── utils.js         # Shared utilities for platform-specific operations
│  ├── security/          # Security modules
│  │  ├── routes.js        # Security API endpoints
│  │  └── middleware.js      # CSRF validation, IP blocking, request validation
│  ├── email/            # Email modules
│  │  ├── index.js         # Route definitions and account management
│  │  ├── controller.js      # Request handlers and business logic
│  │  ├── credentials.js      # Encrypted credential storage and retrieval
│  │  ├── helpers.js        # Email HTML processing: image proxying, sanitization
│  │  └── protocols/        # Email protocol implementations
│  │    ├── imapClient.js    # IMAP connection and message fetching
│  │    ├── pop3Client.js    # POP3 connection and message fetching
│  │    └── ewsClient.js     # Exchange Web Services (EWS) client
│  ├── js/
│  │  ├── core/          # Core system modules (nested by domain)
│  │  │  ├── core/        # Kernel & boot layer
│  │  │  │  ├── boot.js     # Boot sequence and startup orchestration
│  │  │  │  ├── init.js     # Security & initialization
│  │  │  │  └── kernel.js    # Kernel loop
│  │  │  ├── events/       # Event system
│  │  │  │  └── system-events.js # Global event bus
│  │  │  ├── services/      # Core OS services
│  │  │  │  ├── fs.js      # Virtual filesystem API
│  │  │  │  ├── notifications.js # Notification system
│  │  │  │  ├── registry.js   # Core app registry
│  │  │  │  └── workers.js    # Multi-threaded worker management
│  │  │  ├── ui/         # UI primitives
│  │  │  │  ├── desktop.js    # Desktop shell
│  │  │  │  ├── menu.js     # Context menu system
│  │  │  │  ├── modals.js    # Modal dialog system
│  │  │  │  └── wm.js      # Window manager
│  │  │  └── utils/        # Shared utilities
│  │  │    └── base-utils.js  # Base utility functions
│  │  ├── platform/        # Platform framework modules (nested by concern)
│  │  │  ├── security/      # Security modules
│  │  │  │  ├── frame-security.js   # NW.js frame security validation
│  │  │  │  ├── app-sandbox.js     # App sandbox enforcement
│  │  │  │  └── app-permission-manager.js # Permission system
│  │  │  ├── core/        # Core platform modules
│  │  │  │  ├── app-registry.js    # Full app registry
│  │  │  │  └── app-package.js     # App package management
│  │  │  ├── ui/         # Platform UI modules
│  │  │  │  ├── my-apps-manager.js   # User app management
│  │  │  │  └── web-app-manager.js   # Web app management
│  │  │  └── utils/        # Platform utilities
│  │  │    └── safe-storage.js    # Secure storage abstraction
│  │  └── apps/          # Standalone applications
│  │    ├── files.js       # File manager
│  │    ├── terminal.js     # Terminal emulator
│  │    ├── calculator.js    # Calculator
│  │    ├── email.js       # Email client (IMAP/POP3/Exchange)
│  │    ├── browser.js      # Web browser (NW.js WebView)
│  │    ├── calendar.js     # Calendar
│  │    ├── clock.js       # Clock, alarms, timers
│  │    ├── contacts.js     # Contact manager
│  │    ├── downloads.js     # Downloads manager
│  │    ├── gallery.js      # Image gallery/viewer
│  │    ├── music.js       # Music player
│  │    ├── search.js      # System-wide search
│  │    ├── settings.js     # Settings panel
│  │    ├── textedit.js     # Text editor
│  │    └── appmanager.js    # App manager/installer
│  ├── data/
│  │  └── favicons.db       # Persistent SQLite favicon cache
│  ├── assets/
│  └── LICENSE
├── .gitignore
├── logo.svg
└── README.md
```

> v1/, v2/, and v3/ are closed source and not included in this repository.

### 🧩 Architecture Note: Modular Isolation

NBOSP uses a fully decoupled modular architecture. The original monolithic `app.js` (14,000+ lines), `server.js` (~1,450 lines), and `client.js` (400+ lines) have been split into **57 modular files** across clearly separated layers:

| Layer | Location | Count |
|---|---|---|
| Backend modules | `server/` | 7 files |
| Launcher modules | `scripts/` | 7 files |
| Frontend core | `js/core/` (sub-folders: `core/`, `events/`, `services/`, `ui/`, `utils/`) | 13 files |
| Frontend platform | `js/platform/` | 8 files |
| Standalone apps | `js/apps/` | 15 files |
| Security / Email | `security/`, `email/` | 9 files |

To maintain cross-script communication across individual files without monolithic bundling:
* **Global Exposures:** Core modules explicitly bind their APIs to the global browser execution context (e.g., `window.Notify = Notify;`, `window.registerApp = registerApp;`) at the foot of their files.
* **Fearless Optimization:** You can completely optimize or rewrite individual components (like an app inside `js/apps/`) safely. As long as the file interfaces with the global window bindings, internal code variations will not trigger unexpected side effects across the rest of the OS.

-----

## 🔄 Update System

### v3 Update Instructions

v3 is closed source. Update instructions for v3 have been removed from this document.

### Setting Up Your Own Update System (NBOSP)

NBOSP has no built-in update pipeline — if you build on top of it, you’re responsible for shipping updates to your users. The simplest approach is a GitHub-based pipeline:

**1. Tag your releases**

```bash
git tag v1.0.0
git push --tags
```

**2. Publish a GitHub Release**

Go to your repo → Releases → Draft a new release → select your tag → attach your build → publish.

**3. Check for updates at runtime**

Poll the GitHub Releases API from your app on startup:

```js
const res = await fetch('https://api.github.com/repos/YOUR_USERNAME/YOUR_REPO/releases/latest');
const data = await res.json();
// Compare data.tag_name against your current version
```

If a newer tag exists, prompt the user to download the new release. That’s the whole system — no server required.

### Nova Core Services Updates (legacy v2.3.8 / v3 — internal)

> v2.3.8 is end-of-life; this snippet is preserved for older internal release workflows only.

```
1. Edit Core Services files only
2. Tag: git tag cs-v2.1.0 && git push --tags
3. Create a GitHub Release with your cs- tag and publish
```

-----

## 🛡 Nova Core Services

Nova Core Services is NovaByte’s **independent security update pipeline** — separate from the main OS update system. Even when a version stops receiving OS-level patches, Nova Core Services continues pushing security fixes.

> [!CAUTION]
> **Want Nova Core Services in your own app or OS? You need a license from us. See [NovaByte Services — Licensing](#-novabyte-services--licensing).**

### v3.x.x (Current) — v2.3.8 (End of Life)

> v2.3.8 is no longer supported. The table below is retained for historical reference and for legacy fork maintainers.

|Component       |Files                                       |Description                          |
|----------------------|----------------------------------------------------------------------------------|--------------------------------------------------------------|
|🔐 Security Runtime  |`nova-security-api.js`, `app-sandbox.js`                     |Patch enforcement, iframe sandboxing, CSP, privilege brokering|
|🛡 Privacy Engine   |`app-permission-manager.js`                            |Permission types, consent UI, grant/revoke enforcement    |
|📦 Package Integrity  |`app-package.js`                                 |`.novaapp` creation, signing, verification, installation   |
|⚡ App Runtime     |`app-registry.js`, `web-app-manager.js`, `my-apps-manager.js`           |App lifecycle, registry, web app management          |
|💾 Session Manager   |`session-manager.js`, `app-session-handlers.js`                  |Auto-save, crash recovery, per-app state persistence     |
|🌐 NovaBridge     |`api-client.js`, `socket-client.js`, `oauth-handler.js`, `novamail-integration.js`|REST/WebSocket transport, OAuth flows, real-time sync     |
|🚀 Performance Services|`sw.js`                                      |Caching, offline support, push notifications         |
|🔌 Driver Services   |`driver-manager-ui.js`                              |Hardware driver installation and management          |
|⚙️ System Shell    |`user-power-menu.js`                               |Lock, log off, restart, shutdown with GPO enforcement     |

### v1.x.x (End of Life — limited coverage)

|Component       |Files                                       |Description          |
|----------------------|----------------------------------------------------------------------------------|-------------------------------|
|⚡ App Runtime     |`web-app-manager.js`                               |Web app management       |
|💾 Session Manager   |`session-manager.js`, `app-session-handlers.js`                  |Auto-save, crash recovery   |
|🌐 NovaBridge     |`api-client.js`, `socket-client.js`, `oauth-handler.js`, `novamail-integration.js`|Transport, OAuth, sync     |
|🚀 Performance Services|`sw.js`                                      |Caching, offline support    |
|⚙️ System Shell    |`user-power-menu.js`                               |Power menu with GPO enforcement|

### NBOSP Specifically

NBOSP, the open-source base of NovaByte, explicitly has **no telemetry** — this is called out in the codebase and architecture by design. Because it is fully open source, this is not a claim — it is a fact anyone can audit:

```
git clone https://github.com/NovaByteTeam/novabyte-os.git
cd novabyte-os/NBOSP
grep -r "telemetry\|analytics\|sendBeacon\|segment\|mixpanel\|gtag\|_gaq\|dataLayer" .
```

That grep returns **nothing.** Empty. Because it is not there.

### What About v3 (Closed Source)?

v3 is closed source, so you cannot audit its binary directly — that is the nature of close-source software. However:

- The network architecture is identical to NBOSP (no telemetry endpoints exist in the infrastructure)
- v3 does not connect to any NovaByte-owned analytics or data collection server — there is no such server
- The only outbound calls v3 makes are the same ones listed above: update checks (public GitHub API, no payload) and user-initiated service connections

If you require full auditability with zero trust assumptions, **NBOSP is your answer** — it is open, forkable, and zero-telemetry by design.

-----
## 🔐 Security

- All versions use **HTTPS** with self-signed certificates locally
- **CSRF protection** and **rate limiting** are active on all API routes
- Nova Core Services routes are excluded from CSRF to allow the independent patch pipeline to function

If you discover a security vulnerability, please **open a private issue** or contact the maintainer directly rather than filing a public bug report.

-----

## 📄 License

<div align="center">

### 📜 Repository License Breakdown

|Directory      |License Type      |Terms & Permissions                                                    |
|:--------------------|:----------------------|:--------------------------------------------------------------------------------------------------------------------------|
|📁 `NBOSP/`      |**Apache 2.0 License** |Free to copy, modify, fork, sell, and redistribute. Attribution required — preserve copyright notices and the license text.|
|📁 `v1/`, `v2/`, `v3/`|**All Rights Reserved**|Closed source. Source not included in this repo. Compiled exe available via Releases.                   |

*See `NBOSP/LICENSE` for the complete Apache 2.0 legal text governing the open-source base.*

-----

*NovaByte OS is a project. Built with care.*