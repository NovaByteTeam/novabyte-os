# How to Make Nova Core Services Updates

This document provides comprehensive instructions for creating and publishing **Nova Core Services updates** — the independent update pipeline for NovaByte OS's JS-layer runtime modules.

---

## Table of Contents

1. [Overview](#overview)
2. [Differences from OS Updates](#differences-from-os-updates)
3. [Writable File Allowlist](#writable-file-allowlist)
4. [Creating a Core Services Update](#creating-a-core-services-update)
5. [Publishing an Update](#publishing-an-update)
6. [Managing Channels](#managing-channels)
7. [Retracting a Release](#retracting-a-release)
8. [Client Behavior](#client-behavior)
9. [Server Integration](#server-integration)
10. [API Endpoints Reference](#api-endpoints-reference)
11. [File Locations Reference](#file-locations-reference)
12. [Troubleshooting](#troubleshooting)

---

## Overview

Nova Core Services is an **independent update pipeline** for the JavaScript runtime modules that power NovaByte OS. It operates separately from the main OS updater and is designed to deliver rapid fixes to the `/js/` layer — security APIs, session management, networking, and app runtime — without requiring a full OS release.

Updates are distributed via **GitHub Releases** using the `cs-` tag prefix. The update system fetches the unified diff between the user's installed CS version and the latest `cs-` release using the GitHub Compare API, then applies only files listed in `cs-manifest.json`. No server is required to receive updates.

### System Components

| Component | File | Purpose |
|-----------|------|---------|
| CS Routes | `nova-core-services-routes.js` | GitHub API proxy for check, diff, and package endpoints |
| Fork Config | `nova-custom.json` | Per-fork upstream repo and protected file settings |
| File Whitelist | `cs-manifest.json` | Defines which files a CS update is permitted to touch |
| Version Tracking | `version.json` | Stores `coreServicesVersion` independently from `osVersion` |

### Updatable Components

The six logical components that a Core Services update may address:

- Security Runtime
- Network Services
- Package Integrity
- App Runtime APIs
- Privacy Engine
- Performance Services

---

## Differences from OS Updates

| Aspect | OS Updates | Core Services |
|--------|-----------|---------------|
| **Tag format** | `v2026.05.3` | `cs-v2.1.0` |
| **File scope** | Any file in the OS allowlist | Only files listed in `cs-manifest.json` |
| **Patch mechanism** | Unified diffs via GitHub compare API | Unified diffs via GitHub compare API |
| **Version format** | Date-based (`YYYY.MM.build`) | Semantic (`MAJOR.MINOR.PATCH`) |
| **Version field** | `osVersion` in `version.json` | `coreServicesVersion` in `version.json` |
| **Server routes** | `/api/updates/` | `/api/coreservices/` |
| **Channels** | GitHub release / prerelease flag | GitHub release / prerelease flag |
| **Publishing** | `git tag v... && GitHub Release` | `git tag cs-v... && GitHub Release` |

Both pipelines use the same GitHub API, the same compare-based diff mechanism, and the same existing patch application, backup, and rollback logic on the client.

---

## Writable File Allowlist

Core Services updates may only touch files listed in `cs-manifest.json` in the version folder root. Any file in the GitHub diff that is not on this list is silently skipped — it will never be applied to the user's installation regardless of what changed between tags.

Current default allowlist:

| File | Component |
|------|-----------|
| `js/nova-security-api.js` | Security Runtime |
| `js/nova-core-services.js` | Security Runtime / core |
| `js/session-manager.js` | Security Runtime |
| `js/update-service.js` | Package Integrity |
| `js/user-power-menu.js` | App Runtime APIs |
| `js/web-app-manager.js` | App Runtime APIs |
| `js/app-session-handlers.js` | App Runtime APIs |
| `js/api-client.js` | Network Services |
| `js/socket-client.js` | Network Services |
| `js/sw.js` | Performance Services |
| `js/oauth-handler.js` | Privacy Engine |

To allow a new file, add its relative path to `cs-manifest.json` and commit before tagging the release. The manifest is committed to the repo so forks inherit the correct list automatically.

```json
{
  "version": "2.1.0",
  "files": [
    "js/nova-security-api.js",
    "js/session-manager.js"
  ]
}
```

> **Note:** The allowlist is enforced on the client at install time, not on the server. Any file in the GitHub diff not on this list is skipped regardless of content.

---

## Creating a Core Services Update

### Step 1: Edit the target JS files

Make your changes directly to the relevant files in the `/js/` folder. Only edit files that are listed in `cs-manifest.json` — changes to any other file will be ignored by the CS updater even if they appear in the diff.

### Step 2: Decide on a version string

CS versions use standard semantic versioning (`MAJOR.MINOR.PATCH`). Check the latest `cs-` release on GitHub to know what to increment:

- Patch fix → increment PATCH (e.g., `2.0.1` → `2.0.2`)
- New capability → increment MINOR (e.g., `2.0.1` → `2.1.0`)
- Breaking change → increment MAJOR

### Step 3: Commit your changes

```bash
git add js/nova-security-api.js js/session-manager.js
git commit -m "cs: patch timing vulnerability in security API and session manager"
```

### Step 4: Tag the release

```bash
git tag cs-v2.1.0
git push --tags
```

The tag must start with `cs-` — this is how the update system distinguishes CS releases from OS releases when scanning GitHub Releases.

### Step 5: Create the GitHub Release

Go to [github.com/NovaByteOfficial/novabyte-os/releases/new](https://github.com/NovaByteOfficial/novabyte-os/releases/new):

1. Select your `cs-v2.1.0` tag
2. Set the release title (e.g., `Nova Core Services 2.1.0`)
3. Write the changelog in the release notes — this is shown verbatim to users before they install
4. Leave "Set as a pre-release" unchecked for stable, check it for beta
5. Click **Publish release**

That's the entire publish step.

### Changelog format

The release notes become the changelog shown in the update prompt. Format them consistently:

```
2.1.0 — Security hardening

- [Security] Patched timing vulnerability in nova-security-api
- [Security] Hardened session token rotation in session-manager
- [Fix] Corrected edge case in oauth-handler token refresh
```

---

## Publishing an Update

Publishing is just tagging and creating a GitHub Release. No CLI tool, no server, no admin token required.

```bash
# 1. Edit your CS files and commit
git add js/nova-security-api.js
git commit -m "cs: security fix"

# 2. Tag with cs- prefix
git tag cs-v2.1.0
git push --tags

# 3. Create the GitHub Release at:
# github.com/NovaByteOfficial/novabyte-os/releases/new
```

When the release is published, any user who clicks "Check for Updates" in the Nova Core Services tab will see the new version. The update system automatically computes the diff between their installed CS version and the new tag using the GitHub Compare API — no package JSON to build, no signing step, no push script.

> **Note:** `push-core-services.js` is deprecated and kept only for reference. Do not use it for new releases.

---

## Managing Channels

Channels are controlled by the **Pre-release** checkbox on the GitHub Release form.

| GitHub Release type | CS channel |
|--------------------|------------|
| Regular release | `stable` |
| Pre-release | `beta` |

The update system fetches all releases, filters by the `cs-` tag prefix, then returns the latest regular release for stable users and the latest pre-release for beta users.

### Staged rollout

To test a CS release on beta before promoting to stable:

1. Create the GitHub Release with **Pre-release checked** → beta users receive it
2. When satisfied, edit the release and **uncheck Pre-release** → it becomes the new stable

No re-tagging or re-publishing required — editing the release is enough.

---

## Retracting a Release

To pull a CS release before users install it:

1. Go to the release on GitHub
2. Click **Edit**
3. Either delete the release entirely, or convert it back to a draft

Clients that have already installed the update are unaffected. Clients that haven't yet will see no update available on their next check.

> There is no equivalent of the old `coreservices:update:retracted` Socket.IO event in the GitHub-based system. Users simply won't see the update the next time they check.

---

## Client Behavior

The Core Services update flow:

1. User opens **Settings → Updates → Nova Core Services** and clicks **Check for Updates**
2. The client reads `nova-custom.json` to find the upstream repo and `cs-` tag prefix
3. Fetches all GitHub Releases from `api.github.com/repos/{upstream}/releases` and finds the latest `cs-` tagged release
4. Compares the release `tag_name` version against `OS.coreServicesVersion` (loaded from `version.json` / localStorage)
5. If newer, shows a prompt with the release notes as changelog and Install / Cancel buttons
6. On Install: fetches the diff from `api.github.com/repos/{upstream}/compare/cs-v{old}...cs-v{new}`
7. For each file in the diff, checks `cs-manifest.json` — skips anything not on the list, skips files in `nova-custom.json` `protected` array
8. Passes remaining file patches to the existing patch application pipeline (backup → pre-flight → apply → verify)
9. On success, writes `coreServicesVersion: "2.1.0"` to `version.json` and localStorage

The existing patch application, backup, and rollback logic is untouched — only the source of the diff data has changed.

---

## Server Integration

The server-side routes (`nova-core-services-routes.js`) now act as a GitHub API proxy rather than reading from local disk. The legacy endpoint paths are preserved for backward compatibility.

### Mount the router

In `server.js`:

```javascript
const coreServicesRoutes = require('./nova-core-services-routes');
app.use('/api/coreservices', coreServicesRoutes);
```

### Static files

Ensure `nova-custom.json`, `cs-manifest.json`, and `version.json` are served statically so the frontend can fetch them directly:

```javascript
app.use(express.static('.', { index: false }));
```

### Optional: GitHub token

Add to `.env` to increase the GitHub API rate limit from 60 to 5,000 requests/hour:

```
GITHUB_TOKEN=ghp_yourtoken
```

This is only necessary for high-traffic deployments. The system works without it.

### Socket.IO

The publish endpoint no longer broadcasts Socket.IO events since publishing happens on GitHub, not the server. If you want to notify connected clients of a new CS release, you would need a webhook from GitHub → your server → `global.io.emit('coreservices:update:available', ...)`. This is optional and not required for the update system to function.

---

## API Endpoints Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/coreservices/check` | GET | Fetches latest `cs-` release from GitHub, returns version/changelog metadata. Query: `?repo=owner/repo` |
| `/api/coreservices/diff` | GET | Returns unified diff between two CS tags via GitHub compare. Query: `?from=cs-v2.0.0&to=cs-v2.1.0&repo=owner/repo` |
| `/api/coreservices/package` | GET | Returns latest release assets (legacy compatibility). Query: `?repo=owner/repo` |

### `/check` Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `available` | boolean | `true` if the GitHub version is newer than the client's installed version |
| `version` | string | Latest CS version string (e.g., `"2.1.0"`) |
| `tag` | string | Full GitHub tag (e.g., `"cs-v2.1.0"`) |
| `patchDate` | string | ISO date the release was published |
| `channel` | string | `"stable"` or `"beta"` |
| `description` | string | Release title |
| `changelog` | string | Release notes body |
| `repo` | string | GitHub repo the data was fetched from |

---

## File Locations Reference

| Purpose | Path |
|---------|------|
| GitHub API proxy routes | `nova-core-services-routes.js` |
| File whitelist | `cs-manifest.json` |
| Fork configuration | `nova-custom.json` |
| Version tracking | `version.json` |
| Deprecated push CLI | `push-core-services.js` |

---

## Troubleshooting

### "No core services release found"

No GitHub Release with a `cs-` prefixed tag exists in the configured upstream repo.

**Solution:** Create a GitHub Release at `github.com/NovaByteOfficial/novabyte-os/releases/new` with a tag starting with `cs-` (e.g., `cs-v2.1.0`).

### "GitHub API unreachable"

The client cannot reach `api.github.com`.

**Solution:** Check network connectivity. If the server proxy is running, confirm `nova-core-services-routes.js` is mounted correctly in `server.js`. The client falls back to direct GitHub API calls if the server proxy fails.

### "Update available but no files applied"

The diff between the two CS tags contained no files listed in `cs-manifest.json`.

**Solution:** Confirm that the files you edited are in `cs-manifest.json`. If you added a new CS file, add it to the manifest and commit before tagging.

### "coreServicesVersion not updating after install"

The install succeeded but `version.json` was not written back.

**Solution:** Confirm the install handler writes to `coreServicesVersion` in `version.json`, not `osVersion`. The `POST /api/update/version` endpoint on the server handles this — confirm it is mounted in `server.js`.

### Users on a fork receiving wrong updates

The fork's `nova-custom.json` still points `upstreamCoreServices` at `NovaByteOfficial/novabyte-os`.

**Solution:** The fork maintainer should update `nova-custom.json`:
```json
{
  "upstreamCoreServices": "TheirOrg/their-fork"
}
```

### Rate limit errors from GitHub API

The unauthenticated rate limit (60 requests/hour) has been exceeded.

**Solution:** Add `GITHUB_TOKEN=ghp_yourtoken` to `.env` to raise the limit to 5,000 requests/hour.

---

*Last updated: 2026-05-10 — Migrated from push-core-services.js / local disk storage to GitHub Releases API. Full-file replacement packages replaced with GitHub compare unified diffs. cs-manifest.json introduced as the file whitelist. version.json introduced for independent CS version tracking.*
*Nova Core Services Update System v2.0*