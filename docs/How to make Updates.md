# How to Make Updates for NovaByte OS (GitHub Edition)

**Updated: May 2026 — GitHub API Migration**

This document provides comprehensive instructions for creating and distributing software updates for NovaByte OS using the **GitHub-based update system** (zero server infrastructure required).

---

## Quick Start — Publishing an Update

1. **Edit files** in your branch
2. **Commit and tag:**
   ```bash
   git tag v2026.05.3
   git push --tags
   ```
3. **Create GitHub Release:**
   - Go to `github.com/NovaByteOfficial/novabyte-os/releases/new`
   - Select your tag
   - Write release notes (shown as changelog to users)
   - Click **Publish**
4. **Done!** All clients polling `/api/updates/check` will see the new version within their next poll interval

For **Nova Core Services**, use the same process but tag with the `cs-` prefix:
```bash
git tag cs-v2026.05.3
git push --tags
```

---

## Table of Contents

1. [GitHub-Based System Overview](#github-based-system-overview)
2. [Environment Setup](#environment-setup)
3. [Publishing Updates](#publishing-updates)
4. [Fork Configuration](#fork-configuration)
5. [Security & Authentication](#security--authentication)
6. [Client-Side Flow](#client-side-flow)
7. [Troubleshooting](#troubleshooting)
8. [Legacy Patch Format (Still Supported)](#legacy-patch-format-still-supported)

---

## GitHub-Based System Overview

The NovaByte OS update system now uses **GitHub Releases** as the single source of truth. No server infrastructure is required to publish updates.

### How It Works

**Version Checking (Client → GitHub):**
```
GET /api/updates/check?currentVersion=2.3.8&repo=owner/repo&channel=stable
↓ (server proxies to GitHub)
GET https://api.github.com/repos/owner/repo/releases
→ returns latest release metadata (<2 KB response)
```

**Fetching Changes (Client → GitHub):**
```
GET /api/updates/diff?from=v2.3.8&to=v2.3.9&repo=owner/repo
↓ (server proxies to GitHub)
GET https://api.github.com/repos/owner/repo/compare/v2.3.8...v2.3.9
→ returns unified diffs for each changed file
```

**Why GitHub Releases?**
- ✅ No JSON files to maintain on the server
- ✅ No push scripts to run
- ✅ Release notes become the changelog automatically
- ✅ Works for forks — each fork points to their own repo
- ✅ Clients can check without authentication (GitHub's 60 req/hr limit is sufficient for polling)
- ✅ Private repos supported via `GITHUB_TOKEN` in `.env`

---

## Environment Setup

### For the Official NovaByte OS Repository

1. **Ensure `.env` has `GITHUB_TOKEN`** (optional but recommended for private repos):
   ```bash
   GITHUB_TOKEN=ghp_your_token_here
   ```
   
   - Generates a token at: https://github.com/settings/tokens
   - Scope needed: **Contents** (read-only)
   - Select: **All repositories** (works for any fork globally)
   - Without token: 60 API requests/hour (fine for polling)
   - With token: 5000 API requests/hour (handles high-traffic deployments)

2. **Create `nova-custom.json`** in project root:
   ```json
   {
     "protected": [],
     "upstream": "YourGitHubUsername/novabyte-os",
     "upstreamCoreServices": "YourGitHubUsername/novabyte-os",
     "coreServicesTagPrefix": "cs-"
   }
   ```

3. **Restart server** — changes to `GITHUB_TOKEN` and `nova-custom.json` take effect immediately on next check.

---

## Publishing Updates

### For NovaByte OS (Stable Release)

```bash
# 1. Make your changes and commit
git add .
git commit -m "Feature: Add dark mode support"

# 2. Tag the release (use semantic versioning)
git tag v2026.05.3
git push --tags

# 3. Create GitHub Release
#    - Go to: github.com/YOUR-REPO/novabyte-os/releases
#    - Click "Create a new release"
#    - Select tag: v2026.05.3
#    - Title: "NovaByte OS v2026.05.3"
#    - Description: (your changelog — markdown supported)
#    - Click "Publish release"

# 4. All clients will detect this within their next poll interval (~5 min default)
```

### For Nova Core Services (Always Prefixed)

```bash
# Same process, but use cs- prefix
git tag cs-v2026.05.3
git push --tags

# Then create the release with tag: cs-v2026.05.3
```

### Pre-Release / Beta Channel

To mark a release as beta (appears only to users with `updateChannel: 'beta'`):
1. In GitHub Release UI, check **"This is a pre-release"**
2. Or use GitHub CLI: `gh release create cs-v2.0.0-beta --prerelease`

---

## Fork Configuration

Any fork of NovaByte OS can customize:
- Where updates come from (their own repo instead of official)
- Which files never get overwritten (protected files)

**Edit `nova-custom.json`:**

```json
{
  "protected": [
    "custom-plugin.js",
    "my-custom-theme.css",
    "fork-specific-config.json"
  ],
  "upstream": "MyUsername/novabyte-os-fork",
  "upstreamCoreServices": "MyUsername/novabyte-os-fork",
  "coreServicesTagPrefix": "cs-"
}
```

Then create releases in your fork's repo. When clients check for updates, they use YOUR repo and skip YOUR protected files.

---

## Security & Authentication

### GitHub Token Security

- Store `GITHUB_TOKEN` in `.env` (never in `.env.example` or git history)
- `.env` is in `.gitignore` — it stays local
- Create a new token for each environment (dev, staging, prod)
- Rotate tokens regularly (GitHub allows expiration dates)

### HTTPS & API Calls

- All calls to `api.github.com` are over HTTPS
- Browser calls use your same `GITHUB_TOKEN` from server (user never sees it)
- Private repos accessible only with valid token
- Public repos work without token (60 req/hr shared limit across unauthenticated clients)

### Protected Files

Listed in `nova-custom.json`, these files are **never** overwritten by patches:
```javascript
// During update install, for each changed file:
if (protectedFiles.includes(file.filename)) {
  console.log('Skipping protected:', file.filename);
  continue; // Don't apply patch
}
```

This lets forks receive upstream OS updates without losing their custom code.

---

## Client-Side Flow

### Update Check (Every 5 minutes or on-demand)

```
1. Browser loads page, index.html initializes
2. Reads nova-custom.json to get upstream repo
3. Polls /api/updates/check?repo=...&channel=stable
4. Server proxies to GitHub, gets latest release
5. Compares version with localStorage.osVersion
6. If newer: shows notification "Update available"
7. User clicks install or auto-install (if enabled)
```

### Update Install

```
1. User clicks "Install"
2. Fetches /api/updates/diff?from=v2.3.8&to=v2.3.9
3. Server fetches unified diffs from GitHub
4. Browser applies patches in order using UpdateService.install()
5. Reads protectedFiles list, skips those files
6. Backs up original files before modifying
7. Validates patches (line numbers, context)
8. On success: updates localStorage, shows "Up to date"
9. On failure: rollback to backup, shows error
```

The existing patch application logic in `index.html` (UpdateService, backup, rollback) remains unchanged — only the source of the diff data changed (GitHub API instead of local server).

---

## Troubleshooting

### "No releases found"

**Cause:** Repository has no releases published yet.

**Fix:**
1. Make sure you pushed tags: `git push --tags`
2. Go to GitHub Releases page and create a release
3. Verify tag appears in the GitHub UI
4. Check for correct tag prefix (`v...` for OS, `cs-...` for Core Services)

### "Server error 403"

**Cause:** Sentinel middleware blocking unauthenticated update requests.

**Fix:** Already applied in v2+ — update routes are exempted from Zero Trust. If still seeing this:
1. Check server logs for `[Sentinel] Zero Trust blocked`
2. Verify `/api/updates/` and `/api/coreservices/` are in security exclusions in `server.js`
3. Restart server

### "GitHub API error 404"

**Cause:** Repo is private and `GITHUB_TOKEN` not provided, OR repo doesn't exist.

**Fix:**
1. Verify repo name in `nova-custom.json` matches GitHub
2. Check `GITHUB_TOKEN` is set in `.env` (not `.env.example`)
3. Test token: `curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user` (should return user info)
4. Ensure token scope includes **Contents** (read-only)

### "Check failed: Error: GitHub API error X"

**Cause:** Network issue or GitHub API rate limit exceeded.

**Fix:**
- Rate limited without token? Clients share 60 requests/hour. Add `GITHUB_TOKEN` to increase to 5000/hour.
- Network blocked? Use server proxy routes (`/api/updates/check` instead of direct GitHub API calls).
- GitHub API down? Check https://www.githubstatus.com/

---

## Legacy Patch Format (Still Supported)

The old unified diff patch system is still supported for backwards compatibility. This documentation now focuses on the GitHub Release approach, but existing update packages in the old format will still install.

See the legacy section in the original docs for details on `.diff`, `.snippet`, and `.search`/`.replace` formats.

---

### Update System Components (Reference)

| Component | File | Purpose |
|-----------|------|---------|
| Update Service (Client) | `js/update-service.js` | Browser-side patch application logic |
| Update Routes (Server) | `auto-update-routes.js` | GitHub API proxy for clients |
| Core Services Routes (Server) | `nova-core-services-routes.js` | GitHub API proxy for CS updates |
| Config File | `nova-custom.json` | Fork-specific repo & protected file settings |



## Package Format

### Basic Structure

```json
{
  "package": {
    "name": "NovaByte OS — Feature Update",
    "version": "1.9.0",
    "description": "Short description shown to users before installation.",
    "changelog": "v1.9.0 — Feature Update\n- Added X\n- Fixed Y",
    "channel": "stable",
    "minRequiredVersion": "1.0.0",
    "releaseDate": "2026-04-12",
    "tags": ["Feature", "UI"]
  },
  "files": [
    {
      "path": "index.html",
      "description": "What this file change does",
      "diff": "--- index.html\n+++ index.html\n@@ -142,6 +142,10 @@\n       // context line\n+      // new line added\n+      const newThing = createEl('div');\n       // more context"
    }
  ]
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `package.name` | string | Human-readable name of the update |
| `package.version` | string | Semantic version (MAJOR.MINOR.PATCH, e.g., `"1.9.0"`) |
| `files` | array | Array of file modifications |
| `files[].path` | string | Relative path to the file (must be in the writable allowlist) |
| `files[].diff` | string | Unified diff string describing the changes *(preferred)* |
| `files[].snippet` | string | Replacement code for a **semantic patch** — acts as both the anchor and the direct replacement |
| `files[].instruction` | string | Optional plain-English description for a semantic patch — enables AI-assisted apply when present |

Three patch entry formats are accepted — **exactly one** must be present per file entry:

| Format | Fields required | When to use |
|--------|----------------|-------------|
| **Unified diff** *(recommended)* | `diff` | Generated with `diff -u` or `git diff` — precise, line-number-pinned |
| **Semantic** | `snippet` (+ optional `instruction`) | Paste the replacement code block; add `instruction` to get AI-assisted apply, omit it for direct splice |
| **Legacy search/replace** | `search` + `replace` | Still supported for backward compatibility |

> **Full file replacement:** Omitting all three formats signals a **full file replacement** when a `content` field is present. The signer will warn but not error.

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `package.description` | string | `""` | Short description for the UI — signer **warns** if missing |
| `package.changelog` | string | `""` | Detailed changelog shown in the installer — signer **warns** if missing |
| `package.channel` | string | `"stable"` | Release channel: `stable`, `beta`, or `nightly` |
| `package.minRequiredVersion` | string | none | Minimum OS version required to install |
| `package.releaseDate` | string | `""` | Human-readable release date (e.g., `"2026-04-12"`) |
| `package.tags` | string[] | `[]` | Colored category tags shown in the installer header |
| `files[].description` | string | `""` | Description of what this individual patch does |

### Tags

Tags are displayed as colored pill badges in the installer modal header. Recognized values and their colors:

| Tag | Color |
|-----|-------|
| `Security` | Red |
| `Performance` | Green |
| `Feature` | Blue |
| `UI` | Purple |
| `Fix` | Yellow |
| `Stable` | Green |
| `Beta` | Blue |
| `Experimental` | Purple |

Any unrecognized string shows in gray. A package can carry multiple tags:

```json
"tags": ["Security", "Fix"]
```

---

## Creating an Update Package

### Step 1: Make Your Changes to the File

Edit the target file (e.g., `index.html`) directly as you normally would. Do not copy code into JSON yet — you will generate the diff automatically in the next step.

### Step 2: Generate the Unified Diff

Once your edits are saved, generate the patch with a single command. You need two copies of the file: the original (before your edit) and the modified version. If you are working with Git:

```bash
# If the original is tracked in git:
git diff index.html > patch-v1.9.0.patch
```

If you are not using Git, keep a copy of the original file alongside the modified one:

```bash
diff -u index.html.orig index.html > patch-v1.9.0.patch
```

The output looks like this:

```diff
--- index.html
+++ index.html
@@ -142,6 +142,10 @@
       // Show taskbar clock toggle
+      // Show dark mode toggle
+      const darkModeToggle = createEl('div', { className: 'nook-row' });
+      darkModeToggle.appendChild(createDarkModeToggle());
+
       const clockToggle = createEl('div', { className: 'nook-row' });
```

Each `@@` block is called a **hunk**. A single diff can contain multiple hunks targeting different parts of the same file.

### Step 3: Always Include a Version Bump

**Every package must include a patch that updates `OS.version` in `index.html`.** This keeps the OS version number in sync with what was last installed and is how the update history and rollback system tracks state.

Generate the version bump diff the same way — edit the version string in the file, then run `diff -u`. The resulting diff hunk will look something like:

```diff
--- index.html
+++ index.html
@@ -10,7 +10,7 @@
   const OS = {
-    version: '1.8.2',
+    version: '1.9.0',
     name: 'NovaByte',
```

> ⚠️ Always put the version bump patch **last** in the `files` array. If an earlier patch fails, the version number won't be bumped on an incomplete install.

### Step 4: Create the JSON File

Create a new JSON file (e.g., `update-v1.9.0.json`) and paste the diff strings into the `diff` fields. Use `\n` for newlines when embedding in JSON:

```json
{
  "package": {
    "name": "NovaByte OS — Feature Update",
    "version": "1.9.0",
    "description": "Adds dark mode support.",
    "changelog": "v1.9.0 — Feature Update\n- [Feature] New Dark Mode toggle in Settings > Desktop\n- [Fix] Persists across sessions",
    "channel": "stable",
    "minRequiredVersion": "1.0.0",
    "releaseDate": "2026-04-12",
    "tags": ["Feature", "UI"]
  },
  "files": [
    {
      "path": "index.html",
      "description": "Add dark mode toggle in Desktop settings",
      "diff": "--- index.html\n+++ index.html\n@@ -142,6 +142,10 @@\n       // Show taskbar clock toggle\n+      // Show dark mode toggle\n+      const darkModeToggle = createEl('div', { className: 'nook-row' });\n+      darkModeToggle.appendChild(createDarkModeToggle());\n+\n       const clockToggle = createEl('div', { className: 'nook-row' });"
    },
    {
      "path": "index.html",
      "description": "Bump OS version to 1.9.0",
      "diff": "--- index.html\n+++ index.html\n@@ -10,7 +10,7 @@\n   const OS = {\n-    version: '1.8.2',\n+    version: '1.9.0',\n     name: 'NovaByte',"
    }
  ]
}
```

### Patch Authoring Rules

1. **Let the tool generate it** — do not hand-write diffs. Run `diff -u` or `git diff` and copy the output. Hand-written diffs with off-by-one line numbers will fail.

2. **Patch ordering matters** — patches are applied sequentially. If two patches target different regions of the same file, put the one that appears earlier in the file first. Line numbers in later hunks become stale once earlier patches have shifted the file.

3. **Version bump goes last** — always put the `OS.version` bump patch at the end of the `files` array.

4. **No overlapping hunks** — each patch entry should target a non-overlapping region of a file. If two changes are adjacent, combine them into a single diff with one hunk rather than two separate entries.

### Step 5: Pre-flight Check

Before signing, do a dry-run apply to confirm all patches apply cleanly. Use the server's `check-searches` endpoint:

```bash
curl -X POST http://localhost:3002/api/update/check-searches \
  -H "Content-Type: application/json" \
  -d @update-v1.9.0.json
```

Or for a quick local sanity check using the standard `patch` tool:

```bash
# Test apply without modifying files
patch --dry-run index.html < patch-v1.9.0.patch
```

The `check-searches` endpoint returns per-patch results:

| Field | Description |
|-------|-------------|
| `found` | Whether the diff applies cleanly to the current file |
| `alreadyApplied` | Whether the patch has already been applied (idempotency check) |
| `lineNumber` | Approximate 1-based line number of the first hunk |
| `occurrences` | Always 1 for diff-based patches (no ambiguity) |

---

## Semantic Patches

Semantic is a third patch format alongside unified diff and search/replace. Instead of specifying exact line numbers or exact text, you paste the **replacement code block** and the system locates where it belongs by scoring every line in the file against your snippet.

### How It Works

1. **Anchor scoring** — every line in the file is scored against the significant lines in your snippet (lines longer than 10 chars). The highest-scoring line becomes the anchor.
2. **Range pinning** — the system then searches near the anchor for the snippet's first and last significant lines to pin the exact start and end of the region to replace.
3. **Splice** — the matched region is cut out and your snippet is written in verbatim.

If AI is enabled (an `instruction` field is present and the NVIDIA API key is configured), the server instead feeds ±120 lines around the anchor to Qwen3-Coder-480B and asks it to apply the instruction intelligently. If the AI call fails for any reason, it falls back to the direct splice automatically.

### When to Use Semantic

| Situation | Recommended format |
|-----------|-------------------|
| Hand-authoring JSON packages | **Unified diff** |
| AI Package Creator generating patches | **Semantic** (AI handles the snippet) |
| Small isolated text swap | **Search/replace** |
| Replacing a known block without tracking line numbers | **Semantic (no-AI)** |

> Semantic is **most reliable when the snippet is the complete replacement block** — a whole function, a clearly delimited section, or a block between two unique surrounding lines. It is less suited to changes scattered across a file.

### Snippet Authoring Rules

The snippet is both the **locator** and the **verbatim replacement**. Whatever you put in the snippet ends up in the file.

- **Include enough context to be unique** — at least 2–3 surrounding lines that exist only once in the file
- **Do not over-include context** — context lines in the snippet are written into the file too; excess context creates duplicates
- **The snippet replaces the matched range exactly** — it is not merged or diffed, it is spliced in wholesale

**Example — replacing a function:**

Original file contains:
```js
function renderClock() {
  return el('div', {}, '12:00');
}
```

Snippet (complete replacement including surrounding anchor lines):
```js
// Clock widget
function renderClock() {
  const now = new Date();
  return el('div', { className: 'clock' }, now.toLocaleTimeString());
}
```

The anchor matches `function renderClock()`, the range is pinned from `// Clock widget` to the closing `}`, and the snippet replaces that region exactly.

### JSON Format

**Snippet-only (no AI required):**
```json
{
  "path": "index.html",
  "description": "Replace renderClock with live time display",
  "snippet": "// Clock widget\nfunction renderClock() {\n  const now = new Date();\n  return el('div', { className: 'clock' }, now.toLocaleTimeString());\n}"
}
```

**With instruction (AI-assisted when available, falls back to direct splice):**
```json
{
  "path": "index.html",
  "description": "Replace renderClock with live time display",
  "instruction": "Replace the renderClock function to show the live time using toLocaleTimeString instead of a hardcoded string",
  "snippet": "// Clock widget\nfunction renderClock() {\n  const now = new Date();\n  return el('div', { className: 'clock' }, now.toLocaleTimeString());\n}"
}
```

### Previewing Before You Package

Use the `/api/update/semantic-apply` endpoint to dry-run a semantic patch and see a unified diff of what it would do — without writing anything to disk:

```bash
# Preview with AI (instruction required)
curl -X POST http://localhost:3002/api/update/semantic-apply \
  -H "Content-Type: application/json" \
  -d '{
    "path": "index.html",
    "instruction": "Replace renderClock with live time display",
    "snippet": "function renderClock() {\n  return el(\"div\", {}, new Date().toLocaleTimeString());\n}"
  }'

# Preview without AI (snippet only)
curl -X POST http://localhost:3002/api/update/semantic-apply \
  -H "Content-Type: application/json" \
  -d '{
    "path": "index.html",
    "snippet": "function renderClock() {\n  return el(\"div\", {}, new Date().toLocaleTimeString());\n}",
    "noAI": true
  }'
```

Response:
```json
{
  "success": true,
  "preview": "--- index.html\n+++ index.html\n@@ -142,3 +142,3 @@\n ...",
  "addedLines": 3,
  "removedLines": 2,
  "aiUsed": false
}
```

The Package Creator UI exposes this as two buttons: **🔍 Preview Result** (tries AI, falls back automatically) and **⚡ Preview (no AI)** (direct splice only, no instruction needed).

### Pre-flight Check Behaviour

The `check-searches` endpoint treats semantic patches as always passing the pre-flight check — it cannot verify the splice location without running the full apply. Use `semantic-apply` for a proper dry run instead.

---

## Signing the Package

### Prerequisites

1. The NovaByte server must have been run at least once — it auto-generates the official Ed25519 keypair in `.update-keys/official.json` on first boot
2. The signer locates the key by walking up the directory tree from its own location — no manual path configuration needed

### Using the Signer Tool

```bash
node sign-package.js <input.json> [output.json] [options]
```

If `output.json` is omitted, the signed file is written to the same directory as the input with `.signed.json` appended automatically.

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--channel` | Release channel (`stable`, `beta`, `nightly`) | `stable` |
| `--expires` | Days until the package expires (1–730) | `90` |
| `--min-version` | Override `minRequiredVersion` in the package | none |
| `--dry-run` | Validate and print what would be signed — no file written | `false` |

### Examples

**Basic signing:**
```bash
node sign-package.js update-v1.9.0.json
```

**Beta channel, 30-day expiry:**
```bash
node sign-package.js update-v1.9.0.json patch-v1.9.0.signed.json --channel=beta --expires=30
```

**Dry run (validation only, no output file):**
```bash
node sign-package.js update-v1.9.0.json --dry-run
```

**Override minimum version at sign time:**
```bash
node sign-package.js update-v1.9.0.json --min-version=1.8.0
```

### Signer Validation

The signer validates the package before signing and will **exit with an error** if any of these are invalid:

| Check | Behavior |
|-------|----------|
| `package.version` present and matches `MAJOR.MINOR.PATCH` | ❌ Error — exits |
| `package.name` present | ❌ Error — exits |
| All `files[].path` present, and each entry has `diff`, `snippet`, or `search`+`replace` | ❌ Error — exits |
| `--channel` is one of `stable`, `beta`, `nightly` | ❌ Error — exits |
| `--expires` is between 1 and 730 | ❌ Error — exits |
| `package.description` present | ⚠ Warning — continues |
| `package.changelog` present | ⚠ Warning — continues |

### What the Signer Does

1. Strips any previous `signature`, `checksum`, `issuedAt`, `expiresAt`, and `nonce` fields from the input
2. Applies `--channel` and `--min-version` overrides
3. Embeds `issuedAt` (current timestamp) and `expiresAt` (now + expiry days)
4. Generates a 48-character cryptographic nonce (prevents replay attacks)
5. Computes a SHA-256 checksum using **deterministic stringify** (all object keys sorted alphabetically — must match the server and client implementations exactly)
6. Signs the checksummed payload with Ed25519 using the private key
7. Runs a pre-sign threat scan across all patch content and prints any findings
8. Writes the signed JSON to the output file

### Signed Package Output

```json
{
  "package": {
    "name": "NovaByte OS — Feature Update",
    "version": "1.9.0",
    "channel": "stable",
    "tags": ["Feature", "UI"]
  },
  "files": [...],
  "issuedAt":  "2026-04-12T12:00:00.000Z",
  "expiresAt": "2026-07-11T12:00:00.000Z",
  "nonce":     "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6",
  "checksum":  "sha256-hex...",
  "signature": {
    "algorithm": "Ed25519",
    "keyId":     "novabyte-official-2026",
    "publisher": "NovaByte Official",
    "value":     "base64-encoded-signature..."
  }
}
```

---

## Installing Updates

### Method 1: Via Settings UI

1. Open the **Settings** app
2. Navigate to the **Software Update** tab
3. Click **Import Package**
4. Select your `.signed.json` file
5. Review the update details across all tabs in the installer dialog
6. Click **↓ Install Update**
7. The OS reloads automatically after all patches are applied

### Installer Tabs Explained

| Tab | What It Shows |
|-----|--------------|
| **Summary** | Package name, version, tags, description, changelog (min 180px / max 400px box), metadata table, and validity window |
| **Security** | Signature trust level, checksum result, nonce status, expiry, and revocation check |
| **Patches** | Per-patch diff view with syntax highlighting — `@@` headers in blue, added lines (+) in green, removed lines (−) in red with real file line numbers |
| **Threats** | Results of the server-side threat scan across all patch content |
| **Simulate** | Dry-run preview of what the file will look like after each patch is applied |
| **Backups** | Available rollback points for each file in the package |
| **Raw** | The raw signed JSON for manual inspection |
| **Assistant** | AI chat (powered by MiniMax M2.5 via NVIDIA) that knows the full package and can explain any patch |

### Method 2: Via API (Development)

```bash
# 1. Validate the package (dry run — no files written)
curl -X POST http://localhost:3002/api/update/validate \
  -H "Content-Type: application/json" \
  -d @patch-v1.9.0.signed.json

# 2. Get a CSRF token (required for write operations, 10-minute TTL)
TOKEN=$(curl -s http://localhost:3002/api/update/csrf-token | jq -r .token)

# 3. Apply a single patch using unified diff
curl -X POST http://localhost:3002/api/update/write-file \
  -H "Content-Type: application/json" \
  -H "X-Update-CSRF-Token: $TOKEN" \
  -d '{
    "path": "index.html",
    "diff":  "--- index.html\n+++ index.html\n@@ -10,7 +10,7 @@\n...",
    "version": "1.9.0"
  }'

# 4. Confirm the nonce to prevent replay
curl -X POST http://localhost:3002/api/update/confirm-nonce \
  -H "Content-Type: application/json" \
  -d '{"nonce": "...", "version": "1.9.0"}'

# 5. Confirm successful boot (clears the pending-update safety flag)
curl -X POST http://localhost:3002/api/update/confirm-boot
```

---

## Security Features

### Cryptographic Protection

| Feature | Description |
|---------|-------------|
| **Ed25519 Signatures** | All packages must be signed with the official private key from `.update-keys/official.json` |
| **SHA-256 Checksums** | Detects any tampering with package content after signing |
| **Deterministic Stringify** | All object keys sorted alphabetically before hashing — prevents JSON key-reordering attacks. Must be identical in the signer, server, and client |
| **Nonce Replay Protection** | Each nonce can only be used once; persisted in `.update-backups/used-nonces.json` (survives server restarts, retains last 2000 nonces) |
| **Package Expiry** | Packages expire after the configured period (default 90 days); server rejects expired packages |
| **issuedAt Validation** | Packages issued more than 24h in the future are rejected (prevents backdating attacks) |
| **CSRF Tokens** | Write operations require a single-use token from `/api/update/csrf-token` (10-minute TTL, in-memory) |
| **Revocation Blacklist** | Key IDs and package checksums can be permanently blacklisted in `data/revocation-blacklist.json` |
| **Audit Log** | Every install attempt, validation, rollback, and key operation is logged with IP, User-Agent, and timestamp to `.update-backups/audit.log` |
| **Integrity Re-baseline** | After every write or rollback, `sentinel/integrity/tamper-detect.js` re-measures files to update the integrity baseline |
| **Writable Path Allowlist** | Only files explicitly listed in `WRITABLE_PATHS` in `update-routes.js` can be modified |

### Threat Detection

Both the signer (pre-sign scan) and the server (`/validate` endpoint) scan all patch content. For unified diff patches, only the **added lines** (lines beginning with `+`) are scanned — removed lines cannot introduce new threats. The server's list is more comprehensive:

| Severity | Pattern | Reason |
|----------|---------|--------|
| HIGH | `eval()` | Arbitrary code execution |
| HIGH | `new Function()` | Dynamic code construction |
| HIGH | `fetch()` to external domain | Data exfiltration |
| HIGH | `document.cookie` | Session hijacking |
| HIGH | `navigator.sendBeacon` | Silent data exfiltration |
| HIGH | `localStorage.clear()` | User data destruction |
| HIGH | `indexedDB.deleteDatabase()` | User data destruction |
| HIGH | `boot =` | Overrides OS boot function |
| HIGH | `OS.settings =` | Overrides settings object |
| HIGH | `WM =` | Overrides window manager |
| HIGH | `require()` | Node.js in browser context |
| HIGH | `process.env/exit/argv` | Node.js process access |
| HIGH | External `window.location` redirect | Phishing redirect |
| HIGH | `Object.defineProperty(window,…)` | Window property tampering |
| HIGH | `.__proto__ =` | Prototype pollution |
| HIGH | `constructor['constructor']` | Function access via constructor chain |
| MEDIUM | `setInterval(string)` | String-eval via timer |
| MEDIUM | `new XMLHttpRequest` | Network request |
| MEDIUM | `atob()` | Base64 decode (obfuscation) |
| MEDIUM | `String.fromCharCode()` | Character-code obfuscation |
| MEDIUM | `document.write()` | DOM injection |
| MEDIUM | `innerHTML =` | HTML injection |
| LOW | 200+ char base64-like string | Possible encoded payload |

The server also checks for **Critical Markers** — strings indicating a patch touches the boot system, recovery system, or safe mode. These trigger prominent warnings in the installer UI but do not block installation:

```
function boot(    completeBoot         showRecoveryScreen    BOOT_ATTEMPT_KEY
BOOT_TIMEOUT      nova_force_recovery  nova_boot_attempts    recovery-screen
BOOT_THRESHOLD    SAFE_MODE_KEY        nova_manual_recovery  nova_safe_mode
boot-screen
```

The server also performs a **VirusTotal hash lookup** if the `sentinel/threats/virustotal.js` module is available. New patch content not yet submitted to VirusTotal returns "not found" — this is expected and does not block installation.

### Trust Levels

| Level | Badge | canInstall (strict mode) |
|-------|-------|--------------------------|
| `official` | ✦ NovaByte Official | ✅ Yes |
| `community` | ◈ Community Publisher | ✅ Yes |
| `unknown_key` | ◇ Key Not Trusted | ❌ No |
| `invalid` | ✕ Signature Invalid | ❌ No |
| `unsigned` | ○ No Signature | ❌ No |

Strict mode is on by default (`UPDATE_STRICT_TRUST=true`). Set `UPDATE_STRICT_TRUST=false` in `.env` to allow unsigned packages (development only).

### Community Keys

Third-party publishers can register an Ed25519 public key to get the `community` trust level:

```bash
curl -X POST http://localhost:3002/api/update/keys/add-community \
  -H "Content-Type: application/json" \
  -d '{
    "keyId":     "my-publisher-2026",
    "publisher": "My Publisher Name",
    "publicKey": "-----BEGIN PUBLIC KEY-----\n..."
  }'
```

To revoke a key or a specific package checksum:

```bash
curl -X POST http://localhost:3002/api/update/keys/revoke \
  -H "Content-Type: application/json" \
  -d '{
    "keyId":  "compromised-key-2026",
    "reason": "Private key leaked"
  }'
```

### Writable Path Allowlist

Only files listed in `WRITABLE_PATHS` in `update-routes.js` can be patched. Anything else is rejected. Current allowlist covers:

- **Root:** `index.html`, `server.js`, `update-routes.js`, `auto-update-routes.js`, and all named service/route files: `account-service.js`, `ai-routes.js`, `ai-service.js`, `audit-service.js`, `auth-routes.js`, `auth-service.js`, `calendar-routes.js`, `calendar-service.js`, `client-crypto.js`, `contacts-routes.js`, `contacts-service.js`, `crypto-service.js`, `permission-service.js`, `proxy-routes.js`, `security-middleware.js`, `security-routes.js`, `mail-service.js`, `fix-patch.js`, `horizon-cdp.js`, `horizon-render.js`, `uv-bare.js`
- **Config:** `.env`, `providers.json`, `package.json`, `package-lock.json`
- **Certs:** `cert.crt`, `cert.key`
- **`js/`:** `api-client.js`, `app-session-handlers.js`, `novamail-integration.js`, `oauth-handler.js`, `session-manager.js`, `socket-client.js`, `sw.js`, `update-service.js`, `user-power-menu.js`, `web-app-manager.js`
- **`public/`:** `auto-update-service.js`, `malicious-test.html`, `oauth-callback.html`, `sentinel-test.html`, `setup.html`, `socket.io.js`
- **`public/uv/`:** all Ultraviolet service-worker proxy files (`bare-mux.js`, `baremux-transport.js`, `baremux-worker.js`, `frame.html`, `sw.js`, `uv.bundle.js`, `uv.client.js`, `uv.config.js`, `uv.handler.js`, `uv.sw.js`)
- **`sentinel/`:** all security module subdirectories (`ai/`, `auth/`, `crypto/`, `dashboard/`, `integrity/`, `isolation/`, `modes/`, `privacy/`, `response/`, `threats/`, `vault/`) plus core files (`index.js`, `boot-guard.js`, `sentinel-middleware.js`, `sentinel-service-worker.js`)
- **`plans/`:** named markdown documentation files
- **`updates/`:** `sign-package.js`, `push-update.js`
- **`data/`:** `accounts.json`, `revocation-blacklist.json`

To allow a new file, add its relative path to `WRITABLE_PATHS` in `update-routes.js` and restart the server.

---

## Rollback Procedures

### Automatic Rollback

If the OS fails to boot after an update:
1. The recovery screen appears automatically after 3 consecutive failed boot attempts
2. Click **Rollback Update vX.X.X**
3. All files are restored from their pre-install backups

### Manual Full Rollback (All Files for a Version)

```bash
TOKEN=$(curl -s http://localhost:3002/api/update/csrf-token | jq -r .token)

curl -X POST http://localhost:3002/api/update/rollback \
  -H "Content-Type: application/json" \
  -H "X-Update-CSRF-Token: $TOKEN" \
  -d '{"version": "1.9.0"}'
```

### Manual Single-File Rollback

```bash
curl -X POST http://localhost:3002/api/update/rollback-file \
  -H "Content-Type: application/json" \
  -d '{"path": "index.html", "version": "1.9.0"}'
```

### View Available Backups

```bash
curl http://localhost:3002/api/update/backups
```

Backups are stored in `.update-backups/` as `filename.vVERSION.TIMESTAMP.bak` and tracked in `.update-backups/manifest.json`. Rolling back removes that version and all newer entries from the manifest.

---

## Best Practices

### 1. Version Numbering

Follow semantic versioning (MAJOR.MINOR.PATCH):
- **MAJOR**: Incompatible API changes or major rewrites
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes (backward compatible)

### 2. Always Bump `OS.version`

Every package must end with a version bump patch. This is how the system tracks which version is currently installed and how rollbacks know what to restore. Generate it the same way as any other patch — edit the version string, then `diff -u`. Always put it last:

```diff
--- index.html
+++ index.html
@@ -10,7 +10,7 @@
   const OS = {
-    version: '1.8.2',
+    version: '1.9.0',
```

### 3. Tag Your Packages

Use `tags` so users can see at a glance what kind of update they are installing:

```json
"tags": ["Security", "Fix"]
```

### 4. Write Good Changelogs

Format changelogs consistently — they render in a `min-height:180px` / `max-height:400px` scrollable box in the installer:

```
v1.9.0 — Brief Title
- [Feature] Added X
- [Fix] Fixed Y in Z
- [Security] Patched CVE-XXXX-XXXX
- [Performance] Improved W
```

### 5. Generating Clean Diffs

✅ **Good** — Generate with `diff -u` or `git diff` after editing the real file:
```bash
# Copy original, make your edit, then diff
cp index.html index.html.orig
# ... make your edits ...
diff -u index.html.orig index.html
```

❌ **Bad** — Hand-writing diffs in JSON. Off-by-one line numbers, wrong context lines, or typos in the hunk header `@@ -N,M +N,M @@` will all cause the patch to fail.

### 6. Testing Checklist

1. **Generate diff cleanly** — use `diff -u` or `git diff`, never hand-write
2. **Dry run** — run `patch --dry-run index.html < your.patch` locally before packaging
3. **Dry run the signer** — use `--dry-run` to catch structural errors before writing any file
4. **check-searches** — use `/api/update/check-searches` as a final pre-install server-side confirmation
5. **Simulate tab** — use the Simulate tab in the installer UI to preview the patched file content
6. **Verify version bump** — confirm the `OS.version` patch is last and correct
7. **Incremental install test** — confirm that installing from intermediate versions also works

### 7. Security Considerations

- Never include credentials, API keys, or secrets in patch content
- Avoid HIGH-severity threat patterns — they are flagged prominently in the installer
- Review every patch in the diff viewer before signing and distributing
- Use the `beta` channel for testing before promoting to `stable`
- Re-sign the package if the JSON is edited after signing — any change breaks the checksum

---

## Troubleshooting

### "Patch did not apply" / "Hunk failed"

The unified diff could not find a matching location in the file. This is the new equivalent of "search string not found" but with much more useful output.

**Solutions:**

1. **Check which hunk failed** — the server reports the exact hunk header (`@@ -N,M +N,M @@`) that could not be applied, so you know exactly which change is the problem.

2. **Regenerate the diff** — if the file has changed significantly since the diff was generated, regenerate it against the current version of the file:
   ```bash
   diff -u index.html.orig index.html > patch-v1.9.0-new.patch
   ```

3. **Check patch ordering** — if a previous patch in the same package shifted line numbers significantly, hunks in later patches may miss. Reorder so patches earlier in the file come first.

4. **Check if already applied** — use `check-searches` to see if `alreadyApplied: true` is returned. If so, the patch was already installed and running it again is safe to skip.

5. **Dry run locally** first:
   ```bash
   patch --dry-run index.html < patch-v1.9.0.patch
   ```
   If it passes locally but fails on the server, the server's copy of the file may differ from your local copy.

### "Path not in write allowlist"

The target file path is not in `WRITABLE_PATHS` in `update-routes.js`.

**Solutions:**
1. Add the path to `WRITABLE_PATHS` in `update-routes.js`
2. Restart the server
3. Re-sign your package (the file list is part of the signed payload)

### "Checksum mismatch"

The package was modified after signing.

**Solutions:**
1. Re-sign the package — any edit after signing invalidates the checksum
2. Ensure no editor auto-formatted or re-encoded the JSON after signing

### "Replay attack detected"

The package nonce was already used.

**Solutions:**
1. Re-sign the package to generate a fresh nonce
2. Used nonces live in `.update-backups/used-nonces.json` (retains last 2000)

### "Package expired"

The package is past its `expiresAt` date.

**Solutions:**
```bash
node sign-package.js update.json --expires=90
```

### "Signature invalid"

The signature doesn't verify against any trusted key.

**Solutions:**
1. Ensure you are using the correct key from `.update-keys/official.json`
2. Note that keys are per-installation — a package signed on one server cannot be verified on another unless the public key is explicitly shared
3. Confirm the JSON was not modified after signing

### "Package issuedAt is in the future"

The signing machine's clock is more than 24 hours ahead of the server.

**Solutions:**
1. Sync the system clock on the signing machine and re-sign

### "Package or key is on the revocation blacklist"

**Solutions:**
1. Inspect `data/revocation-blacklist.json` to understand why it was added
2. Remove the entry if it was added in error and restart the server
3. Otherwise re-sign with a new key obtained from the server

---

## API Endpoints Reference

| Endpoint | Method | Auth Required | Description |
|----------|--------|--------------|-------------|
| `/api/update/validate` | POST | None | Full validation: checksum, signature, nonce, timing, threat scan. Does not write files |
| `/api/update/write-file` | POST | CSRF token | Apply a unified diff patch to a file. Automatically backs up the file first. Also accepts legacy `search`/`replace` fields and semantic `snippet` field |
| `/api/update/semantic-apply` | POST | None | Dry-run preview of a semantic patch — returns a unified diff without writing to disk. Body: `{ path, snippet, instruction?, noAI? }`. Returns `{ preview, addedLines, removedLines, aiUsed }` |
| `/api/update/rollback` | POST | CSRF token | Rollback all files for a given version from backup |
| `/api/update/rollback-file` | POST | *(disabled for testing)* | Rollback a single file to a backed-up version |
| `/api/update/check-searches` | POST | None | Verify patches apply cleanly to target files (read-only pre-flight check). Accepts `diff` field or legacy `search` field |
| `/api/update/confirm-nonce` | POST | None | Record a used nonce server-side after a successful install |
| `/api/update/confirm-boot` | POST | None | Mark boot as successful, clears the pending-update safety flag |
| `/api/update/csrf-token` | GET | None | Issue a single-use CSRF token (10-minute TTL) |
| `/api/update/public-key` | GET | None | Get the installation's official Ed25519 public key (never the private key) |
| `/api/update/backups` | GET | None | List available backup files from the manifest |
| `/api/update/history` | GET | None | Get the audit log tail (`?count=N`, max 200, returned newest-first) |
| `/api/update/keys/add-community` | POST | None | Register a community publisher Ed25519 public key |
| `/api/update/keys/revoke` | POST | None | Add a key ID or package checksum to the revocation blacklist |
| `/api/update/ai-chat` | POST | None | SSE streaming proxy to NVIDIA/MiniMax for the Package Assistant AI tab |
| `/api/update/package-creator/read-file` | POST | None | Read a project file for the Package Creator AI Assistant |
| `/api/update/package-creator/files` | GET | None | List all browsable project files for the Package Creator file browser |

---

## Auto-Update System

NovaByte OS includes an **auto-update channel system** that enables push-style updates. When you publish an update, all connected clients are notified instantly via Socket.IO and see a glassmorphic banner in the bottom-right corner.

### How It Works

1. **Developer runs** `node updates/push-update.js --pkg update.json` — signs and publishes the package
2. **Server stores** the package and broadcasts via Socket.IO to all connected clients
3. **Clients poll** `GET /api/autoupdate/check` every 30 minutes (or receive instant push)
4. **User sees** a banner with version, changelog preview, and Install/Later buttons
5. **On Install** — downloads the full package and passes it to the existing UpdateService.install()

### Components

| Component | File | Purpose |
|-----------|------|---------|
| Auto-Update Routes (Server) | `auto-update-routes.js` | Server-side endpoints for check, package download, publish |
| Push Update CLI | `updates/push-update.js` | Developer tool to sign and publish update packages |
| Auto-Update Service (Client) | `public/auto-update-service.js` | Browser-side polling and banner UI |

### Push Update CLI Usage

```bash
# Push a signed package to stable channel
node updates/push-update.js --pkg updates/novabyte-os-v2.2.0.json

# Push to beta channel
node updates/push-update.js --pkg updates/novabyte-os-v2.2.0.json --channel beta

# Auto-diff index.html — generates a real unified diff automatically and packages it
node updates/push-update.js --auto-diff --version 2.3.0 --description "Bug fixes"

# Check what's published on all channels
node updates/push-update.js --status

# Retract a bad release
node updates/push-update.js --retract --channel stable
```

> **`--auto-diff` note:** This flag compares the current `index.html` against the last published version, generates a unified diff automatically using the `diff` npm package, and bundles it into a signed package. No manual diff authoring required.

### Auto-Update API Endpoints

| Endpoint | Method | Auth Required | Description |
|----------|--------|--------------|-------------|
| `/api/autoupdate/check` | GET | None | Lightweight poll — returns metadata only (<2 KB), never the full package |
| `/api/autoupdate/package` | GET | None | Returns full signed package JSON (only after user confirms install) |
| `/api/autoupdate/publish` | POST | Admin token | Admin-only: store a signed update and broadcast to all clients |
| `/api/autoupdate/retract` | POST | Admin token | Admin-only: pull a bad release from a channel |
| `/api/autoupdate/status` | GET | Admin token | Admin dashboard: see what's published on all channels |

### Client Banner Behavior

The auto-update service (`public/auto-update-service.js`):
- Polls every 30 minutes (configurable)
- Listens for Socket.IO `update:available` event for instant notifications
- Shows a glassmorphic banner in the bottom-right with:
  - Version number and channel badge (stable/beta/nightly)
  - Trust badge (official/community/unsigned)
  - Changelog preview
  - Download size estimate
- "Later" button snoozes for 2 hours
- "Install" button downloads and verifies checksum, then calls UpdateService.install()

### Configuration

Required in `.env`:
```
UPDATE_ADMIN_TOKEN=<your-secret-token>
```

Generate a token:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Optional:
```
UPDATE_CHANNEL=stable  # default channel (stable|beta|nightly)
UPDATE_SERVER_URL=https://localhost:3002
```

### Server Integration

In `server.js`, ensure:
```javascript
const autoUpdateRoutes = require('./auto-update-routes');
app.use('/api/autoupdate', autoUpdateRoutes);

// For Socket.IO push broadcasts
const { Server } = require('socket.io');
const io = new Server(httpServer);
global.io = io;  // Expose globally for auto-update routes
```

---

## File Locations Reference

| Purpose | Path |
|---------|------|
| Update service (client UI) | `js/update-service.js` |
| Update routes (server) | `update-routes.js` |
| Package signer CLI | `updates/sign-package.js` |
| Auto-update routes (server) | `auto-update-routes.js` |
| Push update CLI | `updates/push-update.js` |
| Auto-update service (client) | `public/auto-update-service.js` |
| Official keypair | `.update-keys/official.json` |
| Community keys | `.update-keys/community.json` |
| Backup directory | `.update-backups/` |
| Backup manifest | `.update-backups/manifest.json` |
| Pending update flag | `.update-backups/pending.json` |
| Used nonces | `.update-backups/used-nonces.json` |
| Audit log | `.update-backups/audit.log` |
| Revocation blacklist | `data/revocation-blacklist.json` |
| Auto-update channels | `.update-backups/channels/` |

---

*Last updated: 2026-05-08 — semantic patch format revised: `instruction` is now optional; `snippet` alone is sufficient for no-AI direct splice mode. Added full [Semantic Patches](#semantic-patches) section with authoring rules, JSON examples, and `/api/update/semantic-apply` preview usage. Updated required fields table, patch formats table, signer validation table, and API endpoints table accordingly.*  
*NovaByte OS Update System v3.2*