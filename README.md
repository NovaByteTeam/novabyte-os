<div align="center">

<div><img src="./logo.svg" width="120" height="120" alt="NovaByte OS Logo" /></div>

<div><img src="https://img.shields.io/badge/NovaByte_OS-v3.x.x_Current-22c55e?style=for-the-badge" alt="NovaByte OS"/></div>

# NovaByte OS

**A browser-based operating system with multi-version support,**
**Nova Core Services, and an independent security update pipeline.**

<br>

[![v1.x.x](https://img.shields.io/badge/v1.x.x-End_of_Life-ef4444?style=flat-square)](https://github.com/NovaByteTeam/novabyte-os)
[![v2.x.x](https://img.shields.io/badge/v2.x.x-Maintenance-f59e0b?style=flat-square)](https://github.com/NovaByteTeam/novabyte-os)
[![v3.x.x](https://img.shields.io/badge/v3.x.x-Current-22c55e?style=flat-square)](https://github.com/NovaByteTeam/novabyte-os)
[![Node](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-Private-6b7280?style=flat-square)](https://github.com/NovaByteTeam/novabyte-os)

<br>

[**Close-Source Notice**](#-close-source-announcement--23052026) · [**BuildScript**](#-nbosp-buildscript--close-source-your-own-project) · [**Download v3**](#-download) · [**NBOSP**](#-nbosp--novabyte-open-source-project) · [**NovaByte Services**](#-novabyte-services--licensing) · [**Update System**](#-update-system) · [**Nova Core Services**](#-nova-core-services) · [**Security**](#-security) · [**Versions**](#-versions)

</div>

---

## 🔏 Close-Source Announcement — 23/05/2026

> [!IMPORTANT]
> **After a long time of waiting and planning, we finally closed the source of NovaByte OS on 23 May 2026.**

We've wanted to do this for a while, and we finally made it happen. Here's what that means technically and what you should know before poking around the release files:

### How We Did It

We closed the source using a combination of three layers of protection:

- **JavaScript obfuscation** — all JS logic has been heavily obfuscated before packaging
- **NW.js (Node-Webkit)** — the app is packaged as a native desktop executable via NW.js, keeping the runtime internals away from plain browser inspection
- **V8 bytecode compilation** — source files have been compiled to V8 bytecode, meaning what ships is pre-compiled engine output, not readable JavaScript

On top of that, **the full git commit history has been wiped.** There is no history to browse, diff, or trace.

### app.bin

All core OS logic lives in **`app.bin`**. This file is compiled machine-level bytecode — it is completely unreadable as source code and is not practically reversible. **Do not attempt to reverse engineer or deobfuscate `app.bin`.** It is not possible to recover meaningful source from it, and attempting to do so is a violation of our terms.

### index.html

**`index.html` is a shell. That's it.** It's an entry point with no meaningful logic inside it. Don't get excited about it — inspecting or redistributing it serves no purpose, and doing so with intent to bypass the close-source protections is against our policy.

### HTML File Encoding

We've also run our HTML files through a **base64 + gzip pipeline** — they're compressed and base64-encoded, which makes them mostly unreadable to non-technical users and adds a small extra step for anyone trying to read them. It doesn't provide real protection on its own, but we recommend doing the same on your own project for that extra friction layer. See the BuildScript below for how we did it.

---

## 📦 NBOSP BuildScript — Close Source Your Own Project

If you want to close source your own NBOSP-based project the same way we did, we've uploaded our **build script** to this repo's Releases under the tag:

> **`BuildScript`**

**→ [Download the BuildScript from Releases](https://github.com/NovaByteTeam/novabyte-os/releases/tag/BuildScript)**

It handles the full pipeline: JS obfuscation, V8 bytecode compilation, NW.js packaging, and the base64+gzip HTML encoding step. Use it as a starting point for your own close-source build.

---

## ⬇️ Download

> [!IMPORTANT]
> **v1, v2, and v3 source code is fully closed source and has been removed from this repository.**
> The compiled v3 executable is available via GitHub Releases.

**→ [Download NovaByte OS v3 (Latest Release)](https://github.com/NovaByteTeam/novabyte-os/releases/latest)**

Download the `.zip`, extract it, and run the exe. No installation required.

---

## 🆓 NBOSP — NovaByte Open Source Project

The `NBOSP/` folder in this repo is the **free, open, no-strings-attached base of NovaByte**.

- Do whatever you want with it — copy it, fork it, sell it, modify it, redistribute it
- No rules, no attribution required, no license restrictions
- This is pure NovaByte.
- Core Apps: **NBOSP Files, NBOSP Notes, NBOSP Terminal, NBOSP Browser, NBOSP Calendar, NBOSP Email, NBOSP Gallery, NBOSP Downloads, NBOSP Contacts, NBOSP Search, NBOSP Music, NBOSP Clock, NBOSP Settings, NBOSP Calculator and NBOSP App Manager**
- Basic security (rate limiting, CSRF protection, security headers) is built in
- No edition system, no update pipeline, and no telemetry
- The "NBOSP" apps are stock versions that come preinstalled — pure NovaByte apps that we replaced with our own feature-heavy versions in v3. The OS is fully customisable, clean, and lightweight. We took NBOSP and built on top of it with an update system and many more features.
- We maintain two separate app lines: NBOSP apps and our own full-featured apps.
- The NBOSP apps are in maintenance mode — we are not adding new features or making interface changes, but we continue to deliver compatibility, bug, and security fixes.
- Apps are included because NBOSP is meant to be functional out of the box. As a desktop OS, it can browse, play music, manage files, install `.novaapp` packages, and more.
- All listed apps are built specifically for the NovaByte Open Source Project and are free to use, customise, or modify however you like.

> **Want the full-featured NovaByte OS?** Download the compiled v3 from [Releases](https://github.com/NovaByteTeam/novabyte-os/releases/latest). NBOSP is just the foundation — the base code you build on.

### 🔄 NBOSP App Updates

NBOSP does **not** use the built-in System Updates app. Updates to NBOSP apps depend entirely on your **forker or maintainer**.

If NovaByte fixes or improves something in the NBOSP source, that fix lives in the upstream repo. Your fork does not receive it automatically. Your forker or maintainer has to pull the change, repackage it, and release their own updated build.

| Update type | How you get it |
|-------------|---------------|
| NBOSP app fix from upstream NovaByte | Forker/maintainer repackages → you re-clone their release |
| NBOSP app fix from your own fork maintainer | Forker/maintainer releases → you re-clone |
| v3 built-in app fix | System Updates app → click Update → done |

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
- ✅ Everything "just works" out of the box

#### New Features in NBOSP Browser (Last feature update for the stock app)

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

Running `npm start` in the NBOSP folder now automatically opens the OS window. No manual browser navigation needed.

---

## 🔑 NovaByte Services — Licensing

> [!CAUTION]
> **NovaByte Services are not free to bundle. They require explicit permission and a license from us.**

NovaByte Services includes:

- **Nova Core Services** — the independent security update pipeline
- **NovaBridge** — REST/WebSocket transport, OAuth flows, and real-time sync
- **Sentinel Security System** — the full security runtime, privacy engine, and threat detection
- **System Updates app** — the built-in app update pipeline
- **NovaByte Edition System** — edition management and feature sets
- **Any other service, API, or system component developed by NovaByte** that is not part of NBOSP

### How to Get a License

If you want to bundle NovaByte Services into your own app or OS:

1. **Contact us** — reach out and describe what you want to use and what for
2. **We review your request** — we decide whether to grant permission
3. **If approved**, we issue a license with specific terms for your use case
4. **You must comply** with all conditions set in your license

**No permission = no bundling. There are no exceptions.**

> We built these services from the ground up. If you want them in your product, ask us. We're not unreasonable — but permission is required before you ship anything with our services in it.

---

## 🔒 Repository Notice — v1, v2, and v3

> [!CAUTION]
> **NovaByte OS v1, v2, and v3 source code is fully closed source.**
> **It has been completely removed from this repository.**
> **Git commit history has been wiped. There is no history to inspect.**
> The source is not available. The compiled v3 executable is available via [GitHub Releases](https://github.com/NovaByteTeam/novabyte-os/releases/latest).

The close-source build uses JavaScript obfuscation, V8 bytecode compilation, and NW.js packaging. All OS logic is compiled into **`app.bin`** — do not attempt to reverse engineer or deobfuscate it. **`index.html`** is a shell entry point only. See the [Close-Source Announcement](#-close-source-announcement--23052026) section for full details.

You are **not permitted** to:

- fork and redistribute them,
- modify and ship derivatives,
- create custom builds from them,
- or use them as a base for another OS

without explicit permission from the NovaByte team.

If you want a freely buildable base, use `NBOSP/` instead.

---

## ⚠️ Deprecation Notice: NovaByte OS 1.x.x

> [!WARNING]
> **NovaByte OS 1.x.x has reached End of Life and is no longer supported.**
>
> | | Status |
> |---|---|
> | OS security patches | ❌ No further patches |
> | New features | ❌ No backports |
> | OS-level vulnerabilities | ❌ Devices are exposed and unpatched |
> | Nova Core Services | ✅ Partial service-level patches continue |
>
> **→ Upgrade to NovaByte OS 3.x.x:** download from [Releases](https://github.com/NovaByteTeam/novabyte-os/releases/latest)

---

## 📋 Versions

| Version | Status | Last OS Patch | Core Services | Notes |
|---------|:------:|:-------------:|:-------------:|-------|
| **v1.8.21** | 🔴 End of Life | 2026-04-01 | ✅ Active | Final 1.x release, deprecated |
| **v2.x.x** | 🟡 Maintenance | Active | ✅ Active | Stable, receiving security patches |
| **v3.x.x** | 🟢 Current | Active | ✅ Active | Latest version, recommended — includes built-in **System Updates** app |

---



## 🚀 Getting Started

### Running NBOSP

```bash
git clone https://github.com/NovaByteTeam/novabyte-os.git
cd novabyte-os/NBOSP
npm install
npm start
```

The window opens automatically — no manual browser navigation needed.

### Running v3

Download the compiled exe from [Releases](https://github.com/NovaByteTeam/novabyte-os/releases/latest), extract the zip, and run it. No Node.js or cloning required.

---

## 🗂 Repository Structure

```
novabyte-os/
├── NBOSP/                           # NovaByte Open Source Project (free, no rules)
│   ├── index.html
│   ├── server.js
│   ├── client.js
│   ├── js/
│   ├── assets/
│   └── LICENSE
├── .gitignore
├── logo.svg
└── README.md
```

> v1/, v2/, and v3/ are closed source and not included in this repository.

---

## 🔄 Update System

### v3 Update Instructions

v3 is closed source. Update instructions for v3 have been removed from this document.

### Setting Up Your Own Update System (NBOSP)

NBOSP has no built-in update pipeline — if you build on top of it, you're responsible for shipping updates to your users. The simplest approach is a GitHub-based pipeline:

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

If a newer tag exists, prompt the user to download the new release. That's the whole system — no server required.

### Nova Core Services Updates (v2 / v3 — internal)

```
1. Edit Core Services files only
2. Tag: git tag cs-v2.1.0 && git push --tags
3. Create a GitHub Release with your cs- tag and publish
```

---

## 🛡 Nova Core Services

Nova Core Services is NovaByte's **independent security update pipeline** — separate from the main OS update system. Even when a version stops receiving OS-level patches, Nova Core Services continues pushing security fixes.

> [!CAUTION]
> **Want Nova Core Services in your own app or OS? You need a license from us. See [NovaByte Services — Licensing](#-novabyte-services--licensing).**

### v3.x.x — v2.x.x (Current / Maintenance)

| Component | Files | Description |
|-----------|-------|-------------|
| 🔐 Security Runtime | `nova-security-api.js`, `app-sandbox.js` | Patch enforcement, iframe sandboxing, CSP, privilege brokering |
| 🛡 Privacy Engine | `app-permission-manager.js` | Permission types, consent UI, grant/revoke enforcement |
| 📦 Package Integrity | `app-package.js` | `.novaapp` creation, signing, verification, installation |
| ⚡ App Runtime | `app-registry.js`, `web-app-manager.js`, `my-apps-manager.js` | App lifecycle, registry, web app management |
| 💾 Session Manager | `session-manager.js`, `app-session-handlers.js` | Auto-save, crash recovery, per-app state persistence |
| 🌐 NovaBridge | `api-client.js`, `socket-client.js`, `oauth-handler.js`, `novamail-integration.js` | REST/WebSocket transport, OAuth flows, real-time sync |
| 🚀 Performance Services | `sw.js` | Caching, offline support, push notifications |
| 🔌 Driver Services | `driver-manager-ui.js` | Hardware driver installation and management |
| ⚙️ System Shell | `user-power-menu.js` | Lock, log off, restart, shutdown with GPO enforcement |

### v1.x.x (End of Life — limited coverage)

| Component | Files | Description |
|-----------|-------|-------------|
| ⚡ App Runtime | `web-app-manager.js` | Web app management |
| 💾 Session Manager | `session-manager.js`, `app-session-handlers.js` | Auto-save, crash recovery |
| 🌐 NovaBridge | `api-client.js`, `socket-client.js`, `oauth-handler.js`, `novamail-integration.js` | Transport, OAuth, sync |
| 🚀 Performance Services | `sw.js` | Caching, offline support |
| ⚙️ System Shell | `user-power-menu.js` | Power menu with GPO enforcement |




## 🔐 Security

- All versions use **HTTPS** with self-signed certificates locally
- **CSRF protection** and **rate limiting** are active on all API routes
- Nova Core Services routes are excluded from CSRF to allow the independent patch pipeline to function

If you discover a security vulnerability, please **open a private issue** or contact the maintainer directly rather than filing a public bug report.

---

## 🔒 May 2026 Security Bulletin — v3 Only

NovaByte OS v3 received a **sweeping security overhaul** in May 2026.

| Fix | What it means |
|-----|--------------|
| `unsafe-inline` removed from CSP — replaced with per-request nonces | Inline script execution is now actually locked down |
| SHA-384 SRI on both pdf.js CDN files | A compromised CDN gets hard-blocked |
| Referrer-Policy + Permissions-Policy added to Helmet | Headers that were aspirational are now real |
| Security bulletin API origin validation | The API that verifies security was itself unvalidated. Fixed. |
| postMessage `'*'` → `event.origin` in bulletin API | No longer broadcasting responses to any origin |
| CVE-NB-2026-001 through CVE-NB-2026-009 fully resolved | Nine CVEs. All closed. |

> [!WARNING]
> **v2 users:** everything in that table — you don't have any of it. Your CSP is `unsafe-inline`. Your pdf.js CDN is trusted unconditionally. Upgrade link is at the top of this file.

> [!CAUTION]
> **v1 users:** there's no CSP, no nonces, no SRI, no Helmet, no CSRF protection on half the routes. Running v1 in 2026 is a bold lifestyle choice. The upgrade path is [right here](https://github.com/NovaByteTeam/novabyte-os/releases/latest).

---

## 📄 License

<div align="center">

### 📜 Repository License Breakdown

| Directory | License Type | Terms & Permissions |
| :--- | :--- | :--- |
| 📁 `NBOSP/` | **Apache 2.0 License** | Free to copy, modify, fork, sell, and redistribute. No attribution required. |
| 📁 `v1/`, `v2/`, `v3/` | **All Rights Reserved** | Closed source. Source not included in this repo. Compiled exe available via Releases. |

*See `NBOSP/LICENSE` for the complete Apache 2.0 legal text governing the open-source base.*

---

*NovaByte OS is a passion project. Built with care.*

*v3 users: you're in good hands. Everyone else: you know where to find us.*