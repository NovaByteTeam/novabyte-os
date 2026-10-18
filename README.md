<div align="center">

<div><img src="./logo.svg" width="120" height="120" alt="NovaByte OS Logo" /></div>

# NovaByte OS

**A browser-based operating system you can fork and make your own.**

<br>

[![Node](https://img.shields.io/badge/Node.js-26+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-22c55e?style=flat-square)](#automatic-startup)
[![License](https://img.shields.io/badge/License-Apache%202.0-6b7280?style=flat-square)](https://www.apache.org/licenses/LICENSE-2.0)
[![No Telemetry](https://img.shields.io/badge/Telemetry-None-22c55e?style=flat-square&logo=shieldsdotio&logoColor=white)](https://github.com/NovaByteTeam/novabyte-os/tree/main/NBOSP)

<br>

> **⚠️ This is a fun project — not a real OS.** That said, `.novaapp` packages run untrusted code, and you should treat them with the same caution you would any unknown executable. It doesn't matter that this is a hobby project; you're still running code you didn't write. Install apps you trust, from sources you trust.

<br>

**→ [Check out the live site](https://novabyteteam.github.io/novabyte-os/)**

> **Publishing apps:** The store is real but this is a fun project — it's a place to share and test apps inside NovaByte. Details on the [Publish Apps](https://novabyteteam.github.io/novabyte-os/) page.

<br>

[**Download**](#-download) · [**NBOSP**](#-nbosp--novabyte-open-source-project) · [**Security**](#-security)

</div>

-----


## ⬇️ Download

**→ [Download pre-built binaries](https://github.com/NovaByteTeam/novabyte-os/releases/tag/NBOSP-PREBUILT)**

Pre-built cross-platform binaries for NovaByte, built directly from the current NBOSP source — no cloning or `npm install` required, just download and run.

-----

## 🛠️ Building .novaapp Apps? Use NovaByte Studio

**[NovaByte Studio](https://github.com/NovaByteOfficial/novapack-studio)** is the best tool for creating and testing `.novaapp` packages. It bundles NBOSP so you can build and test your app without setting up NBOSP separately — just download Studio and start building.

**[Download NovaByte Studio →](https://github.com/NovaByteOfficial/novapack-studio/releases)**

---

## 🆓 NBOSP — NovaByte Open Source Project

The `NBOSP/` folder in this repo is the **free, open base of NovaByte**.



- Use, copy, modify, fork, sell, and redistribute it under the Apache 2.0 licence.
- Preserve the copyright notices and the `LICENSE` text.
- Basic security (rate limiting, CSRF protection, security headers) is built in.
- No telemetry.
- All listed apps are built specifically for NBOSP and are free to use, customise, or modify however you like.

### 📱 What the NBOSP Apps Actually Do



|App|What it actually does|
|:--|:--------------------|
|📁 **NBOSP Files**|Icon grid and list view. Sort by name, size, type, or modified date. Back/up navigation with a path bar. Search within the current folder. New file/folder, copy, cut, paste, rename (F2), move to trash, restore, permanent delete. Multi-select (Ctrl+A). Drag-and-drop file import, screened by the built-in scanner before anything is written to disk. Keyboard shortcuts.|
|📝 **NBOSP TextEdit**|Plain text editor. Line numbers, status bar showing line/column/word count, Tab indentation, auto-close brackets, Save/Save As to the VFS. Ctrl+S to save. Word count via context menu.|
|💻 **NBOSP Terminal**|A real shell emulator with a working command set: `ls`, `cd`, `cat`, `grep`, `cp`, `mv`, `rm`, `mkdir`, `find`, `diff`, `wc`, `sort`, `head`, `tail`, `echo`, `env`, `export`, `alias`, `history`, `ps`, `neofetch`, and more. Pipe chains, `&&`/`||`/`;` chaining, output redirect (`>`), tab autocomplete, command history, custom aliases, shell variables, multiple tabs (Ctrl+Shift+T). All commands run against the VFS — not a real system shell.|
|🌐 **NBOSP Browser**|NW.js WebView with real site rendering. Tabs, bookmarks, history, incognito mode, find-in-page (Ctrl+F), zoom controls, mobile/desktop user-agent toggle, popup blocker, per-tab WebView/iframe mode toggle.|
|📅 **NBOSP Calendar**|Month, week, day, and agenda views. Mini calendar sidebar. Upcoming events list. Create/edit/delete events with title, date, start/end time, description, and colour. While the OS is running, timed events receive a system notification about 10 minutes before they start.|
|📧 **NBOSP Email**|Multi-account IMAP/POP3/Exchange. Sidebar with Inbox, Sent, Drafts, Trash, Spam, Archive, Starred. Search, compose, reply, forward, batch-select, pagination.|
|🖼 **NBOSP Gallery**|Scans the VFS for image files and shows them in a grid. Lightbox viewer with prev/next navigation, filename caption, and keyboard support (arrow keys, Escape).|
|⬇️ **NBOSP Downloads**|Displays files saved from the browser: name, size, date, and status badge (done/downloading/failed). Remove individual items or clear all completed. Live-updates via a global `Downloads.add()` API.|
|👤 **NBOSP Contacts**|Add/edit/delete contacts with name, email, phone, and notes fields. Alphabetically sorted list. Search by name, email, or phone. Avatar initials.|
|🔍 **NBOSP Search**|System-wide search across files (by filename), contacts (name/email/phone), downloads list, and live web results via DuckDuckGo. Clicking a result opens the relevant app or browser. Up to 12 results per section.|
|🕐 **NBOSP Clock**|Four tabs: analog+digital clock with date display; alarms with custom time, label, and day-of-week repeat (toggle on/off per alarm); countdown timer with H/M/S input, start/pause/reset; and stopwatch.|
|⚙️ **NBOSP Settings**|Appearance (7 themes: Nova Dark, Nova Light, Nord, Dracula, Catppuccin, Tokyo Night, Gruvbox; accent colour picker; 12/24h clock toggle), System (change username), Storage, Privacy, Desktop, Accessibility, About. Settings is actively developed — it controls the visual identity and OS-level behaviour of the entire UI.|
|🖩 **NBOSP Calculator**|Standard arithmetic with live expression preview. Supports `+`, `-`, `*`, `/`, `%`, parentheses, and decimal input. Backspace, clear, keyboard support.|
|🎵 **NBOSP Music**|Scans the virtual filesystem for audio files and plays supported formats with a library view, seek and volume controls, shuffle, and repeat. Playback preferences persist between sessions.|
|📦 **NBOSP App Manager**|Install `.novaapp` packages from disk or by drag-and-drop. Every file inside a package is run through the built-in scanner before trust/integrity checks — a flagged file blocks the install outright with a "Malicious File" warning, no override. Manage web apps (add by URL). Pin/unpin apps to the taskbar. Enable/disable installed apps. Set apps to auto-launch on boot. Install log. Verified/Unverified badge on each installed app, based on signature checks against the built-in trust store.|
|🛒 **NBOSP App Store**|Built-in storefront for the live catalogue at `novabyteteam.github.io/novabyte-os`, with search, category filters, publisher and package details, screenshots, and app icons. Shows signature-verification badges for trusted publishers. Before installing or updating, downloads the `.novaapp`, verifies its signature against the trust store, and checks its declared integrity hash (BLAKE3, SHA-256, or SHA-512); revoked signatures and hash mismatches block the operation. Install, Update, and Uninstall actions stay in sync with App Manager's installed state. The Store checks for app updates at startup and on a configurable interval, notifies users when updates are available, and offers a manual **Check now** action. Runs via the unrestricted gate as a trusted system app — no permission prompts.|

#### Hidden apps and system services

In **App Manager**, user-facing built-in apps remain visible by default. The **Show hidden apps** toggle also reveals the eight developer tools, the built-in Launcher, fourteen headless system services, and the Shell UI package. Developer Mode must be enabled in Settings to use the developer tools; trying to open one while it is off explains how to enable it. The Launcher, Shell UI package, and services are OS-managed and cannot be opened from App Manager. Services also cannot be disabled or uninstalled individually.

|App|What it actually does|
|:--|:--------------------|
|🖥️ **NBOSP Console**|Evaluate arbitrary JavaScript in the full OS context with no sandboxing. Live REPL with input history. **Extremely dangerous in the wrong hands — this is not a toy.**|
|🔍 **NBOSP Inspector**|Inspect registered apps and open windows. View app state, force-close arbitrary windows, export app state. **Can terminate any app without confirmation.**|
|📦 **NBOSP Packages**|Sign and verify `.novaapp` packages. Inspect package manifests, signatures, and permissions. **Can install unsigned or unverified packages and add locally-generated keys to the trust store for the current session.**|
|📊 **NBOSP Perf Monitor**|Live FPS, memory usage, DOM node count, and long-task tracking. Per-window DOM breakdowns. **For debugging performance regressions only.**|
|🔐 **NBOSP Permissions**|Review, grant, and revoke permissions across all registered apps. Bulk operations supported. **Can grant or revoke any permission for any app without user consent.**|
|🧩 **NBOSP Modules**|Hot-reload OS JS modules without restarting NovaByte OS. Live module inspection and dynamic import. **Can execute arbitrary module paths at runtime.**|
|🌐 **NBOSP System Access**|Inspect network proxy/SSRF configuration and browse the virtual filesystem. **Can read internal VFS paths and probe network settings.**|
|📋 **NBOSP Events**|Unified event timeline showing console output, permission events, and package events in one filtered view. Search, severity filter, export. **For debugging OS-level activity only.**|

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

-----

## 🔐 Security

- Uses **HTTPS** with self-signed certificates locally
- **CSRF protection** and **rate limiting** are active on all API routes
- `.novaapp` packages are signed (Ed25519) and checked against a built-in trust store (`trust-store.js`) on install; unsigned or unrecognized signatures show an explicit warning dialog rather than installing silently
  - The "Verified" badge means the package was signed with NovaByte's own private signing key — the only key `trust-store.js` currently trusts. That key is held offline by NovaByte and is not distributed to developers.
  - Before signing, submitted apps are reviewed manually (permissions, code, local malware/AV scanning) by NovaByte on a local machine that never touches the network — there is no automated review queue or scanning service yet. This is a manual process today, not an enforced pipeline in code.
  - Anyone can self-sign their own `.novaapp` for local testing with their own keypair; self-signed packages will always show as **Unverified**, since no key but NovaByte's is in the trust store.
- **Scanner** (`NBOSP/js/apps/scanner/service.js`, loaded from the trusted system-service package) is a lightweight client-side heuristic, not a full antivirus. It checks files imported through the desktop/Files vault and files inside `.novaapp` packages before installation for disguised executables and active content in rendered formats. A flagged package is blocked from installation. The scanner is a first line of defense, not a substitute for security review; it runs in the client and can be bypassed by someone with DevTools access, and it does not unpack archives or provide comprehensive malware detection.

If you discover a security vulnerability, please **open a private issue** or contact the maintainer directly rather than filing a public bug report.

-----

## 🗂 Repository Structure

```
novabyte-os/
├── NBOSP/                    # NovaByte Open Source Project (free, no rules)
│  ├── index.html              # Single entry point (nonce injection target)
│  ├── style.css               # Global styles
│  ├── ui-init.js              # UI initialization hooks
│  ├── client.js               # Minimal ~11-line entry point stub
│  ├── vitest.config.js        # Vitest test configuration
│  ├── test/                   # Vitest test suite
│  │  ├── setup.js
│  │  ├── client/              # Client-side tests
│  │  └── server/              # Server-side tests
│  ├── server/                 # Backend modules
│  │  ├── core/                # Core server modules (nested)
│  │  │  ├── index.js          # Main Express entry point (330 lines)
│  │  │  ├── middleware.js     # Helmet CSP, CORS, rate limiting, CSRF, sessions (250 lines)
│  │  │  ├── ssl.js            # HTTPS/HTTP server factory with graceful fallback (50 lines)
│  │  │  ├── env.js            # Environment validation with fallback secrets (50 lines)
│  │  │  ├── events-routes.js  # SSE endpoint exposing ServerEventLog to the client
│  │  │  └── server-event-log.js # Server-side event log (SSRF blocks, proxy errors)
│  │  ├── security/            # Local admin-mode state (separate from security/ at repo root)
│  │  │  └── admin-state.js    # Local admin-flag store backing req.user.role and admin:* gates
│  │  ├── routes.js            # Sub-router composition and mounting
│  │  ├── favicons.js          # Favicon proxy with SSRF protection, DB caching (400 lines)
│  │  └── proxies.js           # Email image proxy (500 lines)
│  ├── scripts/                # Launcher modules
│  │  ├── startup.js           # NW.js app initialization, window spawn, logging streams
│  │  ├── env.js               # Platform-specific environment validation, secret generation
│  │  ├── certs.js             # HTTPS certificate generation and validation
│  │  ├── ca-trust.js          # Local CA trust (Windows certutil, macOS security, Linux NSS)
│  │  ├── bootstrap.js         # Dependency auto-install, first-run setup, self-healing config
│  │  ├── logger.js            # Centralized logging and output capture
│  │  └── utils.js             # Shared utilities for platform-specific operations
│  ├── security/               # Security modules
│  │  ├── routes.js            # Security API endpoints
│  │  └── middleware.js        # CSRF validation, IP blocking, request validation
│  ├── email/                  # Email modules
│  │  ├── index.js             # Route definitions and account management
│  │  ├── controller.js        # Request handlers and business logic
│  │  ├── credentials.js       # Encrypted credential storage and retrieval
│  │  ├── helpers.js           # Email HTML processing: image proxying, sanitization
│  │  └── protocols/           # Email protocol implementations
│  │    ├── imapClient.js      # IMAP connection and message fetching
│  │    ├── pop3Client.js      # POP3 connection and message fetching
│  │    └── ewsClient.js       # Exchange Web Services (EWS) client
│  ├── js/
│  │  ├── core/                # Core system modules (nested by domain)
│  │  │  ├── core/             # Kernel & boot layer
│  │  │  │  ├── boot.js        # Boot sequence and startup orchestration
│  │  │  │  ├── init.js        # Security & initialization
│  │  │  │  └── kernel.js      # Kernel loop
│  │  │  ├── events/           # Event-related core modules
│  │  │  ├── services/         # Core OS services
│  │  │  │  ├── fs.js          # Virtual filesystem API
│  │  │  │  ├── system-service-loader.js # Loads trusted system packages before OS boot
│  │  │  │  └── workers.js     # Multi-threaded worker management
│  │  │  └── utils/            # Shared utilities
│  │  │    ├── base-utils.js   # Base utility functions
│  │  │    └── debug-overlay.js # Runtime diagnostics overlay
│  │  ├── platform/            # Platform framework modules (nested by concern)
│  │  │  ├── security/         # Security modules
│  │  │  │  ├── frame-security.js        # NW.js frame security validation
│  │  │  │  ├── app-sandbox.js           # App sandbox enforcement
│  │  │  │  ├── app-permission-manager.js # Permission system
│  │  │  │  ├── app-permissions-bootstrap.js # Permission bootstrap
│  │  │  │  ├── app-scheduler.js         # Tier-1 background wake scheduler (system:background)
│  │  │  │  ├── trust-store.js           # Built-in trust store for .novaapp signatures
│  │  │  │  └── revoked-signatures.json  # Revoked signature blocklist
│  │  │  ├── core/             # Core platform modules
│  │  │  │  ├── app-registry.js          # Full app registry
│  │  │  │  ├── app-package.js           # App package management
│  │  │  │  └── nova-app-package-store.js # Installed .novaapp store
│  │  │  └── ui/              # Platform UI modules
│  │  │    ├── my-apps-manager.js        # User app management
│  │  │    └── web-app-manager.js        # Web app management
│  │  └── apps/               # One source directory per built-in app or service
│  │     ├── <app-dir>/manifest.json, app source files, and assets
│  │     ├── shell-ui/         # Trusted host UI: window manager, menus, modals, desktop
│  │     ├── service packages use service.js instead of an app window entry
│  │     ├── novaapp-manifest.json       # Trusted built-in package allowlist
│  │     └── system-service-manifest.json # Ordered system-package startup list
│  ├── data/                   # Gitignored — generated at runtime, not part of the repo
│  │  ├── favicons.db          # Persistent SQLite favicon cache
│  │  ├── sessions.db          # Express session store (backs admin:users session list/revoke)
│  │  └── admin-state.json     # Local admin-mode flag (Settings → Privacy & Security → Admin Access)
│  └── assets/
├── .gitignore
├── LICENSE
├── logo.svg
└── README.md
```

-----

## 📄 License

<div align="center">

### 📜 Repository License Breakdown

|Directory|License Type|Terms & Permissions|
|:--------|:-----------|:------------------|
|📁 `NBOSP/`|**Apache 2.0 License**|Free to copy, modify, fork, sell, and redistribute. Attribution required — preserve copyright notices and the license text.|

*See `LICENSE` for the complete Apache 2.0 legal text governing the open-source base.*

-----

</div>