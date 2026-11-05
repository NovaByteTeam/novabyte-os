# How to Make Updates for NovaByte OS

This document provides comprehensive instructions for creating, signing, and distributing software updates for NovaByte OS.

---

## Table of Contents

1. [Overview](#overview)
2. [Package Format](#package-format)
3. [Creating an Update Package](#creating-an-update-package)
4. [Signing the Package](#signing-the-package)
5. [Installing Updates](#installing-updates)
6. [Security Features](#security-features)
7. [Rollback Procedures](#rollback-procedures)
8. [Best Practices](#best-practices)
9. [Troubleshooting](#troubleshooting)
10. [API Endpoints Reference](#api-endpoints-reference)
11. [Auto-Update System](#auto-update-system)
12. [File Locations Reference](#file-locations-reference)

---

## Overview

NovaByte OS uses a **cryptographically signed, search-and-replace patch system** for updates. Instead of replacing entire files, updates specify:
- The file path to modify
- A `search` string that must exist in the file
- A `replace` string to replace it with

This approach:
- Minimizes the risk of update failures
- Allows partial file updates
- Makes it easy to verify changes before applying

### Update System Components

| Component | File | Purpose |
|-----------|------|---------|
| Update Service (Client) | `js/update-service.js` | Browser-side UI and installation logic |
| Update Routes (Server) | `update-routes.js` | Server-side validation and file patching |
| Package Signer | `updates/sign-package.js` | CLI tool to sign update packages |
| Key Storage | `.update-keys/` | Stores Ed25519 keypairs |

---

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
      "search": "exact string to find in the file",
      "replace": "exact string to replace it with"
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
| `files[].search` | string | Exact string to find in the file |
| `files[].replace` | string | Exact string to replace it with |

> **Note:** Omitting both `files[].search` and `files[].replace` together signals a **full file replacement**. The signer will warn but not error. A missing `search` with a present `replace` (or vice versa) is still an error.

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

### Step 1: Analyze the Changes

Before creating an update, identify:
1. Which files need to be modified
2. The exact `search` string (must be unique and present in the file)
3. The `replace` string with your changes

### Step 2: Always Include a Version Bump

**Every package must include a patch that updates `OS.version` in `index.html`.** This keeps the OS version number in sync with what was last installed and is how the update history and rollback system tracks state.

Find the current version string in `index.html`:

```javascript
version: '1.8.2',
```

Add a patch to bump it to the new version:

```json
{
  "path": "index.html",
  "description": "Bump OS version to 1.9.0",
  "search": "version: '1.8.2',",
  "replace": "version: '1.9.0',"
}
```

> ⚠️ Always put the version bump patch **last** in the `files` array. If an earlier patch fails, the version number won't be bumped on an incomplete install.

### Step 3: Create the JSON File

Create a new JSON file (e.g., `update-v1.9.0.json`):

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
      "search": "// Show taskbar clock toggle\n      const clockToggle = createEl('div', { className: 'nook-row' });",
      "replace": "// Show dark mode toggle\n      const darkModeToggle = createEl('div', { className: 'nook-row' });\n      ...\n\n      // Show taskbar clock toggle\n      const clockToggle = createEl('div', { className: 'nook-row' });"
    },
    {
      "path": "index.html",
      "description": "Bump OS version to 1.9.0",
      "search": "version: '1.8.2',",
      "replace": "version: '1.9.0',"
    }
  ]
}
```

### Important Rules for Search/Replace

1. **Exact Match Required**: The `search` string must exactly match the content in the file, including:
   - Whitespace (spaces, tabs, newlines)
   - Line breaks (`\n` or actual newlines)
   - Comment formatting

2. **⚠️ Line Endings Must Match the Target File**: This is the most common cause of silent patch failures. The update system does a byte-exact string match, so `\n` (LF) and `\r\n` (CRLF) are not interchangeable.

   - **`index.html` uses CRLF** — always use `\r\n` for multi-line patches against it
   - **Windows-edited files** typically use CRLF — your JSON must use `\r\n` between lines
   - **Unix/Mac-edited files** typically use LF — your JSON uses `\n`

   Check a file's line endings before writing patches:
   ```bash
   python3 -c "d=open('index.html','rb').read(); print('CRLF' if b'\r\n' in d else 'LF')"
   ```

   Fix an existing patch JSON to match CRLF files:
   ```python
   import json
   with open('update.json') as f: pkg = json.load(f)
   def to_crlf(s): return s.replace('\r\n', '\n').replace('\n', '\r\n')
   for p in pkg['files']:
       p['search'] = to_crlf(p['search'])
       p['replace'] = to_crlf(p['replace'])
   with open('update-fixed.json', 'w') as f: json.dump(pkg, f, indent=2)
   ```

   > **Important:** Apply the same line-ending fix to both `search` **and** `replace` — a mismatched `replace` will corrupt the file's line endings after patching.

3. **Use Unique Context**: Include enough surrounding code to ensure uniqueness:
   ```json
   {
     "search": "// Custom wallpaper\n      const wallpaperGroup = createEl('div', { className: 'nook-group' });",
     "replace": "// Custom wallpaper\n      const wallpaperGroup = createEl('div', { className: 'nook-group' });\n      wallpaperGroup.appendChild(...);"
   }
   ```

4. **Patch Ordering Matters**: Patches are applied sequentially. If two patches target overlapping regions of a file, put the one that appears earlier in the file first — otherwise the second patch's `search` string may no longer exist after the first patch has modified that area.

5. **No Overlapping Changes**: Each file modification should be self-contained.

6. **Version Bump Goes Last**: Always put the `OS.version` bump patch at the end of the `files` array.

### Step 4: Verify the Search String Exists

Before signing, verify all search strings exist locally — this is faster and doesn't require a running server:

```python
# validate-patch.py — run before signing
import json

pkg   = json.load(open('update-v1.9.0.json'))
files = {}

for patch in pkg['files']:
    fpath = patch['path']
    if fpath not in files:
        files[fpath] = open(fpath, 'rb').read().decode('utf-8')
    found = patch['search'] in files[fpath]
    print(f"{'✅' if found else '❌'} {patch['description']}")
```

```bash
python3 validate-patch.py
```

Or use the server's `check-searches` endpoint (requires running server):

```bash
curl -X POST http://localhost:3001/api/update/check-searches \
  -H "Content-Type: application/json" \
  -d '{
    "files": [
      { "path": "index.html", "search": "your search string" }
    ]
  }'
```

The endpoint returns per-patch results including:

| Field | Description |
|-------|-------------|
| `found` | Whether the search string exists in the file |
| `alreadyApplied` | Whether the replace string is already present (patch was previously installed) |
| `lineNumber` | Approximate 1-based line number of the first match |
| `occurrences` | How many times the search string appears (>1 means ambiguous) |
| `multipleMatches` | `true` if the patch target is ambiguous |

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
| All `files[].path`, `files[].search`, `files[].replace` present | ❌ Error — exits |
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
| **Patches** | Per-patch diff view with syntax highlighting — red (−) shows removed lines with real file line numbers, green (+) shows added lines with estimated insertion line numbers |
| **Threats** | Results of the server-side threat scan across all patch content |
| **Simulate** | Dry-run preview of what the file will look like after each patch is applied |
| **Backups** | Available rollback points for each file in the package |
| **Raw** | The raw signed JSON for manual inspection |
| **Assistant** | AI chat (powered by MiniMax M2.5 via NVIDIA) that knows the full package and can explain any patch |

### Method 2: Via API (Development)

```bash
# 1. Validate the package (dry run — no files written)
curl -X POST http://localhost:3001/api/update/validate \
  -H "Content-Type: application/json" \
  -d @patch-v1.9.0.signed.json

# 2. Get a CSRF token (required for write operations, 10-minute TTL)
TOKEN=$(curl -s http://localhost:3001/api/update/csrf-token | jq -r .token)

# 3. Apply a single patch
curl -X POST http://localhost:3001/api/update/write-file \
  -H "Content-Type: application/json" \
  -H "X-Update-CSRF-Token: $TOKEN" \
  -d '{
    "path":    "index.html",
    "search":  "exact search string",
    "replace": "replacement string",
    "version": "1.9.0"
  }'

# 4. Confirm the nonce to prevent replay
curl -X POST http://localhost:3001/api/update/confirm-nonce \
  -H "Content-Type: application/json" \
  -d '{"nonce": "...", "version": "1.9.0"}'

# 5. Confirm successful boot (clears the pending-update safety flag)
curl -X POST http://localhost:3001/api/update/confirm-boot
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

Both the signer (pre-sign scan) and the server (`/validate` endpoint) scan all patch content. The server's list is more comprehensive:

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
| MEDIUM | `setTimeout(string)` | String-eval via timer |
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
curl -X POST http://localhost:3001/api/update/keys/add-community \
  -H "Content-Type: application/json" \
  -d '{
    "keyId":     "my-publisher-2026",
    "publisher": "My Publisher Name",
    "publicKey": "-----BEGIN PUBLIC KEY-----\n..."
  }'
```

To revoke a key or a specific package checksum:

```bash
curl -X POST http://localhost:3001/api/update/keys/revoke \
  -H "Content-Type: application/json" \
  -d '{
    "keyId":  "compromised-key-2026",
    "reason": "Private key leaked"
  }'
```

### Writable Path Allowlist

Only files listed in `WRITABLE_PATHS` in `update-routes.js` can be patched. Anything else is rejected. Current allowlist covers:

- **Root:** `index.html`, `server.js`, `update-routes.js`, all `*-routes.js` and `*-service.js` files
- **Config:** `.env`, `providers.json`, `package.json`, `package-lock.json`
- **Certs:** `cert.crt`, `cert.key`
- **`js/`:** all client JS modules
- **`public/`:** HTML utility pages
- **`sentinel/`:** all security module subdirectories
- **`plans/`:** markdown documentation files
- **`updates/`:** `sign-package.js`
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
TOKEN=$(curl -s http://localhost:3001/api/update/csrf-token | jq -r .token)

curl -X POST http://localhost:3001/api/update/rollback \
  -H "Content-Type: application/json" \
  -H "X-Update-CSRF-Token: $TOKEN" \
  -d '{"version": "1.9.0"}'
```

### Manual Single-File Rollback

```bash
curl -X POST http://localhost:3001/api/update/rollback-file \
  -H "Content-Type: application/json" \
  -d '{"path": "index.html", "version": "1.9.0"}'
```

### View Available Backups

```bash
curl http://localhost:3001/api/update/backups
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

Every package must end with a version bump patch. This is how the system tracks which version is currently installed and how rollbacks know what to restore. Always put it last:

```json
{
  "path": "index.html",
  "description": "Bump OS version to X.Y.Z",
  "search": "version: 'CURRENT',",
  "replace": "version: 'NEW',"
}
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

### 5. Search String Selection

✅ **Good** — Include enough unique surrounding context:
```json
{
  "search": "// Custom wallpaper\n      const wallpaperGroup = createEl('div', { className: 'nook-group' });",
  "replace": "// Custom wallpaper\n      const wallpaperGroup = createEl('div', { className: 'nook-group' });\n      wallpaperGroup.appendChild(...);"
}
```

❌ **Bad** — Too short and generic; will likely match in multiple places:
```json
{
  "search": "const wallpaperGroup",
  "replace": "..."
}
```

### 6. Testing Checklist

1. **Check line endings** — Confirm your JSON line endings match the target file (`CRLF` for `index.html`)
2. **Local pre-validation** — Run `validate-patch.py` to verify all search strings match before touching the server
3. **Dry run** — Use `--dry-run` with the signer to catch structural errors before writing any file
4. **check-searches** — Use `/api/update/check-searches` as a final pre-install confirmation
5. **Simulate tab** — Use the Simulate tab in the installer UI to preview the patched file content
6. **Verify version bump** — Confirm the `OS.version` patch is last and correct
7. **Incremental install test** — Confirm that installing from intermediate versions also works

### 7. Security Considerations

- Never include credentials, API keys, or secrets in patch content
- Avoid HIGH-severity threat patterns — they are flagged prominently in the installer
- Review every patch in the diff viewer before signing and distributing
- Use the `beta` channel for testing before promoting to `stable`
- Re-sign the package if the JSON is edited after signing — any change breaks the checksum

---

## Troubleshooting

### "Search string not found"

The search string doesn't exactly match the file content. **The most common cause is a line ending mismatch** — all patches fail silently when the JSON uses `\n` but the target file uses `\r\n` (or vice versa).

**Solutions:**

1. **Check line endings first** (catches ~90% of cases):
   ```bash
   python3 -c "d=open('index.html','rb').read(); print('CRLF' if b'\r\n' in d else 'LF')"
   ```

2. **Run the local validation script** to pinpoint exactly which patches fail.

3. **Check indentation** — tabs vs spaces look identical in most editors:
   ```bash
   cat -A index.html | grep "your search text"   # ^I = tab, $ = line ending
   ```

4. **Check for Unicode** — invisible characters (zero-width spaces, smart quotes) can sneak in from copy-pasting. Use `xxd` to confirm.

5. **Use `check-searches` endpoint** to diagnose server-side after the above steps pass.

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
| `/api/update/write-file` | POST | CSRF token | Apply a single search-replace patch to a file. Automatically backs up the file first |
| `/api/update/rollback` | POST | CSRF token | Rollback all files for a given version from backup |
| `/api/update/rollback-file` | POST | *(disabled for testing)* | Rollback a single file to a backed-up version |
| `/api/update/check-searches` | POST | None | Verify search strings exist in target files (read-only pre-flight check) |
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

# Auto-diff index.html (generates patch automatically)
node updates/push-update.js --auto-diff --version 2.3.0 --description "Bug fixes"

# Check what's published on all channels
node updates/push-update.js --status

# Retract a bad release
node updates/push-update.js --retract --channel stable
```

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
UPDATE_SERVER_URL=https://localhost:3001
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

*Last updated: 2026-04-14 — added auto-update system documentation, push-update CLI usage, Socket.IO broadcast integration, and client banner behavior*
*NovaByte OS Update System v2.0*