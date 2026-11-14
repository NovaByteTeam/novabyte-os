# NovaByte OS Internals (NBOSP)

This document describes how the NovaByte OS runtime itself works: the NW.js host page, the local HTTPS server, the app sandbox engine (`app-sandbox.js`), the JS-side mandatory-access-control (NB-MAC) engine, the permission manager and trust store, the registry, background execution, the Buildroot Linux image, and the test architecture. It is written for people who want to **understand, audit, or modify the OS internals** — kernel-style overviews, enforcement chains, limits, and known gaps, with `path:line` citations into the repo (`NBOSP/...`, relative to repo root `novabyte-os/`).

**Who this is for:** OS contributors, security reviewers, and toolchain maintainers. It is **not** an app-development guide: the `.novaapp` manifest format, permission catalog (user-facing), JS API surface, and packaging instructions are documented separately and are only referenced here.

## 1. Where app developers should look instead

| Topic | Document |
|---|---|
| Building/packaging `.novaapp` bundles, manifest fields | `guide.md` |
| Permission catalog from the app's perspective, prompts, runtime requests | `permissions.md` |
| `window.nova` / `window.novaOS` API reference (channels, payloads) | `api-reference.md` |

---

## 2. Architecture overview

NovaByte OS ("NBOSP") is a single NW.js (Chromium + Node) desktop application that plays the role of an operating system shell. There is exactly one privileged renderer process — the **OS host page** (`NBOSP/index.html`) — plus one Node child process running a local Express server. Every third-party app runs inside a `<webview>` element owned by the host page; all OS capabilities are reached only through an IPC bridge that the host mediates. On the shipped Linux image the whole tree runs as the single unprivileged `nbosp` user (UID 1000) — there is **no per-app OS-level isolation** (see §10).

Runtime model at a glance:

| Component | What it is | Where |
|---|---|---|
| OS host page | NW.js window loading `NBOSP/index.html`; ~35 `defer` scripts define the kernel singleton `window.OS`, `FS`, `AppSandbox`, `AppPermissionManager`, `NovaRegistry`, etc. | `NBOSP/index.html:225-303` |
| Kernel singleton | `window.OS` (there is no `window.Kernel`) — version/settings/events/windows/apps | `NBOSP/js/core/core/kernel.js:234,237` |
| Local server | Express child process, always HTTPS, default `https://localhost:3003`, loopback bind | `NBOSP/server/core/index.js:643-644`; spawned by `NBOSP/scripts/startup.js:86-95` |
| App sandbox | `AppSandbox` IIFE singleton; per-app `<webview>` records in `activeSandboxes` | `NBOSP/js/platform/security/app-sandbox.js:12,14881` |
| Trusted host tier | System-signed `.novaapp` packages whose `unrestrictedEntry` script is injected straight into the OS page (no webview) | `NBOSP/js/platform/security/app-sandbox.js:14037-14131` |
| Root tier | `system:root` apps executing in the host page, audited, backed by passwordless sudo | `NBOSP/js/platform/security/app-sandbox.js:14135-14184`; `NBOSP/js/platform/security/root-broker.js` |
| System services | 26 headless first-party service bundles injected as `<script>` into the host page before `boot()` | `NBOSP/js/core/services/system-service-loader.js:132-151`; `NBOSP/js/apps/system-service-manifest.json` |

```text
 Buildroot ISO / installed ext4 root (Linux 7.3.4, BusyBox init)
   |
   |- S99nbosp (root) -> labwc (Wayland, zero keybinds)
   |                      `- NW.js "NovaByte" as nbosp (UID 1000), X11 client via XWayland
   |                          |
   |                          |- OS host page  (NBOSP/index.html, Node context enabled)
   |                          |    |- core scripts: init, kernel(OS), fs, registry, permissions,
   |                          |    |  trust store, root broker, scheduler, boot
   |                          |    |- 26 injected system services (shell-ui/WM, Notify, EventLog,
   |                          |    |  SessionManager, LockScreenService, registry, tray, ...)
   |                          |    |- bundled launcher + unrestricted system apps (host tier)
   |                          |    `- <webview> per sandboxed app (nodeintegration=false,
   |                          |       partition persist:app_<id>, isolated-world IPC bridge)
   |                          |
   |                          `- Express child process (NBOSP/server, https://localhost:3003)
   |                               |- sessions.db / users.db (SQLite, WAL)
   |                               |- /api/apps/serve/*  (sandbox content origin)
   |                               |- /api/proxy, /api/frame-check, /api/email-* (SSRF-guarded egress)
   |                               |- /api/events/stream (SSE), /api/push/* (SSE per device)
   |                               `- email IMAP/SMTP family
   |
   `- privilege boundary: sudoers "nbosp ALL=(ALL) NOPASSWD: ALL" (NovaRoot broker)
      + two setuid helpers (nbosp-power, nbosp-install)
```

### 2.1 Host-page globals (what runs in the trusted realm)

Core/platform scripts create, in load order (`NBOSP/index.html:225-303`):

| Global | Origin | Ref |
|---|---|---|
| `NovaFrameSecurity`, `NovaUserScope`, system-fetch patch, `AppSandbox` (+ custom elements `NovaNestedWebview`, `NovaBrowserView`), `DOMPurify`, `NovaConnectivity`, `NovaFactoryReset`, `NovaRecovery` | platform/security + core pre-boot scripts | `NBOSP/js/core/core/init.js:197`; `NBOSP/js/platform/core/user-scope.js:159-161`; `app-sandbox.js:12450,12670,14881` |
| `MultiUserMigration`, base-utils helpers, `createWorker` + worker code constants | migration/utilities | `NBOSP/js/core/services/multiuser-migration.js:616-618`; `NBOSP/js/core/utils/base-utils.js:1089-1133` |
| **`OS`** (kernel singleton: version 3.0.2 / securityPatch 2026-11-12, settings, events, logger, windows, apps) — there is **no `window.Kernel`** | `NBOSP/js/core/core/kernel.js:37-38,234,237` | |
| `FS` (backend-tagged: `linux-native` or `virtual`), `AppPackage`, `TrustStore`, `UnrestrictedGate`, `NovaAppPackageStore`, `buildNovaAppConfig`, `NovaAppIdAliases`, `AppRegistry` + `APP_REGISTRY`, `NovaRegistry`/`NovaRegFile`/`NovaRegCli`, shims (`NovaSettingsShim`, `RegistryPrefs`, `RegistrySystemState`, `RegistryBootState`), `AppConfig` | core services + registry stack | `NBOSP/js/core/services/fs.js:573,1211-1219`; `NBOSP/index.html:259-296` |
| `AppPermissionManager`, `AppSecrets`, `NovaRoot` (root broker), `AppPermissionsBootstrap`, `AppScheduler` | platform/security | `NBOSP/index.html:297-301` |
| `boot`, `Boot`, `window.__NOVA_ACTIVE_HOME_APP_ID__`, `window.__NB_RUNTIME` | `NBOSP/js/core/core/boot.js:115-118,745,1458-1459` | |
| `SystemServiceLoader` (frozen) | `NBOSP/js/core/services/system-service-loader.js:257-269` | |

System services then add the shell surface (in manifest load order): `AppLoaderOptimizer`, `NovaByteSystem`, `WM` + shell-ui helpers, `EventLog`, `DownloadsHistory`, `SearchIndex`, `MediaStore`, `NetworkActivityLog`, `Notify`, `StoreUpdates`, `Scanner`, `SystemDialogs`, registry service (`APP_REGISTRY`, `WebAppManager`, `DefaultApps`), `BackgroundApps`, `ServerEventsBridge`, `CalendarNotifier`, `WallpaperService`, `SystemWebview`, `Tray`, `Screenshots`, `SessionManager` (frozen), `LockScreenService` (frozen), `DebugOverlay` (`NBOSP/js/apps/system-service-manifest.json`; §9.2).

Key structural facts:

- The host page does **not** start the server; `scripts/startup.js` spawns it and shares a per-launch HMAC secret (`NBOSP_SYSTEM_API_RATE_LIMIT_SECRET`, 32-byte hex) via env (`NBOSP/scripts/startup.js:16-31,86-95`). Host-page `/api/` fetches are transparently HMAC-signed by `system-fetch.js` so OS traffic skips per-IP rate limits (`NBOSP/js/platform/security/system-fetch.js:1-14,33-53`).
- Guests never receive the session bearer; `X-Nova-Session` is host-memory only ("never handed to webviews", `NBOSP/js/apps/session/service.js:8-11,32-33`).
- NW.js `node-remote` is `"https://localhost:*"` — Node context is granted to any page served from localhost HTTPS on any port, including the third-party app-serve surface (`NBOSP/package.json:32`).

---

## 3. Boot sequence (desktop)

### 3.1 Process-level prelude

| # | Step | Ref |
|---|---|---|
| 1 | NW.js entry `client.js`; `prestart` runs `scripts/bootstrap.js` + `build-apps-on-start.js` (builds `.novaapp` bundles into `js/apps/`) | `NBOSP/package.json:8-11` |
| 2 | `scripts/startup.js` spawns the Express server as a child (sharing the per-launch rate-limit secret), waits for readiness, opens the NW window on `https://localhost:<port>` | `NBOSP/scripts/startup.js:17-27,47-55,158-171` |
| 3 | Kiosk image rewrites `package.json` window flags (frameless/fullscreen/kiosk) and chromium-args (incl. `--disable-devtools`) | `NBOSP/os/package/nbosp-kiosk/prepare-kiosk.mjs:20-57` |

### 3.2 Page load order and early guards

Script load order on the OS page (all `defer`): `frame-security.js` → `user-scope.js` → `system-fetch.js` → `app-sandbox.js` → `purify.min.js` → `ui-init.js` → `connectivity.js` → `factory-reset.js` → `init.js` → `multiuser-migration.js` → `base-utils.js` → `workers.js` → `kernel.js` (defines `OS`) → `fs.js` → packaging/trust (`app-package.js`, `trust-store.js`, `unrestricted-gate.js`, `nova-app-package-store.js`, `nova-app-launcher.js`) → registry stack (`nova-registry.js`, `nova-reg-file.js`, `nova-reg-cli.js`, shims) → `app-permission-manager.js` → `app-secrets.js` → `root-broker.js` → `app-permissions-bootstrap.js` → `app-scheduler.js` → `boot.js` → `system-service-loader.js` (`NBOSP/index.html:225-303`).

`init.js` runs before everything else OS-y (`NBOSP/js/core/core/init.js`):

| Guard | Behavior | Ref |
|---|---|---|
| Frame busting | `window.top.location = self.location`; cross-origin failure hides body (CVE-NB-2026-009-H1 fix) | `init.js:5-14` |
| localStorage polyfill | write-fallback Map when storage is blocked | `init.js:18-70` |
| Secret-write guard | `setItem` monkey-patched to throw on keys matching `/password\|private.?key\|secret.?key\|apikey\|api_key\|credential/i` | `init.js:78-89` |
| Console mute | log/info/warn/... → noop unless `window.__NOVA_DEBUG__` | `init.js:108-115` |
| Recovery guard | `isNbospLinux()` check; `requestRecovery()` writes `/home/nbosp/.config/novabyte/recovery-request` then `execFile('/usr/bin/nbosp-power', ['restart'])`; syntax errors under `/js/apps/` disable the app (HKNU/apps/disabled), core errors trigger recovery; second watchdog: 2 s interval, 15 s timeout without `os-booted` body class | `init.js:125-268` |

### 3.3 SystemServiceLoader (services load **before** `boot()`)

`system-service-loader.js` self-invokes `load()` at parse (`:271`): fetch `system-service-manifest.json` (26 entries, `cache:'no-store'`) and `novaapp-manifest.json`; for each service validate `system===true && systemService===true` and entry match, build a trusted runtime record `{...pkg, system:true, verified:true, signer:'NovaByte System', source:'system-bundle'}`, pass it through `UnrestrictedGate.checkUnrestrictedApp`, inject each script via base64-decoded `<script textContent>` with runtime-error capture, and register via `AppRegistry.registerSystemService` (`NBOSP/js/core/services/system-service-loader.js:97-175`). Only **then** does it `await window.boot()` (`:241-242`); `boot.js` never self-invokes (`NBOSP/js/core/core/boot.js:1458`). Load failures surface as a dismissible banner after boot (`system-service-loader.js:177-192,251`). Service order = manifest array order; session and lock-screen services load late enough to exist before `boot()` needs them (`NBOSP/js/apps/system-service-manifest.json`; `boot.js:567,607,612`).

### 3.4 `boot()` step by step (`boot.js:436-636`)

| # | Step | Ref |
|---|---|---|
| 0 | Registry open: `NovaRegistry.init` + `ensureDefaults(BOOT_DEFAULTS)`, fail-soft | `boot.js:442-447,326-338` |
| 0.5 | Multi-user migration (`MultiUserMigration.run()`) before any hive mount / owner stamping; failure ⇒ continue single-user | `boot.js:449-461` |
| 1 | Watchdog: 15 s `BOOT_TIMEOUT_MS` timeout ⇒ `forceRecovery` + reload | `boot.js:125-151,463-465` |
| 2 | Recovery routing: manual/show/force flags ⇒ `requestSystemRecovery` and return | `boot.js:467-474,1438-1445` |
| 3 | Attempt tracking: ≥5 attempts (`BOOT_THRESHOLD`) ⇒ recovery `repeated_boot_failure`; attempts cleared on subsystem success | `boot.js:476-496,518-522` |
| 4 | Safe mode flag (registry or `/home/nbosp/.config/novabyte/safe-mode` file) ⇒ banner, `OS._safeModeActive` | `boot.js:498-503,1436,1449-1455` |
| 6 | `Boot.initSubsystems(isSafeMode)`; throw ⇒ `triggerRecovery('worker_init_failed')` | `boot.js:508-516,1394-1413` |
| 6a | `migrateLegacyAppIds()` (NovaAppIdAliases over settings + localStorage) | `boot.js:518,261-267` |
| 7 | Settings & UI: `applyOSVars` (username, `idleTimeout=(autoLock\|\|10)*60000`, lockPin, dnd), theme/wallpaper/accessibility/cursor, `configureTaskbar`, `startServices` (`WM.init()`, badge, 1 s clock) | `boot.js:530-538,273-428` |
| 8 | NovaApp reconciliation: `reconcileBundledNovaApps()` then `loadInstalledNovaApps()`; stale legacy ids uninstalled | `boot.js:540-559` |
| 8b | Multi-user gate: active session or single-user ⇒ home app + taskbar + desktop icons + launchpad + autostart; picker phase ⇒ taskbar only | `boot.js:561-588` |
| 8c | `AppScheduler.start()` | `boot.js:590-592` |
| 9 | Fade boot screen; `markBootSuccess()` (clears attempts, body `os-booted`) | `boot.js:594-600,492-496` |
| 9b | Login/lock gate: multi-user ⇒ login picker; single-user lockPin ⇒ lock screen; else render desktop | `boot.js:602-615` |
| 11 | DevMode ⇒ `DebugOverlay.enable()` | `boot.js:620-626` |

`initSubsystems` (`boot.js:190-259`): fs/search/crypto workers created (`workers.js` blob workers); on linux-native the fs worker is terminated after init because the native FS backend takes over (`:253-256`); settings load with `volatile = isSafeMode`; `OPFS.init`, `FS.init`, `AppDirs.bootstrap`. Live-boot check reads `/proc/cmdline` (`!root=` ⇒ live) and pins an "Install NovaByte" desktop shortcut (`boot.js:227-252`).

App reconcile details: bundled-system apps missing from `novaapp-manifest.json` are force-uninstalled — "deleting/moving a .novaapp actually matters" (`boot.js:816-842`); installed apps re-verify trust at every boot (bundled: provenance + integrity; signed: `AppPackage.verifyAgainstTrustStore` + revocation) (`boot.js:937-1024`); post-install revocation re-scan shows sequential non-backdrop-dismissable Remove dialogs (`boot.js:1082-1241`).

### 3.5 Home app and the sandbox instantiation point

- Home app selected via `DefaultApps.getDefault('home')` else `com.nbosp.launcher`, guarded by a 5 s `HOME_START_TIMEOUT_MS` marker (`boot.js:718,730,734-742`).
- **Bundled launcher runs in the trusted host**: gate = `UnrestrictedGate.checkUnrestrictedApp`; package HTML injected with `innerHTML`, entry script as inline `<script>` with `//# sourceURL=novaapp:<id>/<entry>`; must expose `renderLaunchpad/toggleLaunchpad/renderDesktopIcons/updateTaskbar` (`boot.js:643-701`).
- Non-bundled Home: `system:root` holders go root-tier; others `AppSandbox.launchHome(app, root)` under timeout, falling back to the bundled launcher (`boot.js:753-782`). Default-Apps home change ⇒ `location.reload()` (`boot.js:786-790`).
- Regular apps: `AppSandbox.launch(...)` re-runs the package security gate every launch (`app-sandbox.js:14255-14266`). There is **no `NovaAppSandbox` symbol** — the module is `AppSandbox` (see §13 Glossary).

### 3.6 Session model

- Multi-user is the default: `NovaUserScope.enabled()` is true unless `localStorage.nova_multi_user === '0'` (`NBOSP/js/platform/core/user-scope.js:47-55`). Machine-level scope state (`nova_active_uid`, `nova_active_uname`, `nova_legacy_owner`, `nova_active_role`) is deliberately pre-registry localStorage (`user-scope.js:19-22,108-116`).
- `SessionManager` state machine `loggedout|active|locked|suspended|guest`; bearer token/csrf host-memory only (`NBOSP/js/apps/session/service.js:26-39`). `mountUserScope` is the only mount path: flush hives → discard guest apps → `MultiUserMigration.upgradeUserLayout` → set scope → `NovaRegistry.mountUserHives(segment,{volatile})` → `FS.setUserRoot(uid)` re-root → re-apply theme/taskbar via Boot → `AppPermissionManager.reloadForUser()` → `Boot.reloadUserNovaApps()` → desktop mount (`session/service.js:175-286`).
- Logout/suspend fully unmount: `teardownDesktop()` closes all windows (forceKill), `FS.setUserRoot(null)` back to machine tree (`session/service.js:399-433,505-537`). Lock keeps the desktop mounted (gate only) (`session/service.js:458-467`).
- Legacy single-user lock screen is client-side PBKDF2 via the crypto worker with a wrong-PIN ladder (3→30 s, 6→150 s, ≥10→"security wipe") (`NBOSP/js/apps/lock-screen/service.js:205-255,243-254`); see §12 for why that wipe is ineffective.
- User data strata (linux-native): account root `~/users/<username>/`, app data `~/users/<username>/.apps/<appId>/`, per-user registry hives `~/.config/novabyte/users/<username>/registry/{HKNU,HKNA,HKND}.json`, shared box `~/.local/share/novabyte/shared` (VFS `/Shared`, owner `__shared__`), volatile guest trees (`NBOSP/js/core/services/fs.js:589-645`; `NBOSP/js/core/services/multiuser-migration.js:273-278`).

### 3.7 First-run setup and one-time migration

- First-run setup (`com.nbosp.setup`) is a signed system `.novaapp` running in the trusted host; the lock screen launches it full-screen when no accounts exist, with a rapid-close counter (≥2 closes <8 s ⇒ stop relaunching). Steps: Welcome(keyboard) → Network(skippable) → Date&Region → Data&Privacy → **Owner account** → Appearance → All set; owner = display name + username `/^[a-z0-9][a-z0-9._-]{2,31}$/` + PIN 4–6 digits + optional passphrase ≥8 chars (no security questions, no email); `SessionManager.setupOwner` → `POST /api/auth/setup` which enables multi-user, mounts the owner scope, emits `session:changed {via:'setup'}` (`NBOSP/js/apps/setup/app.js:111-126,378-449,576`; `NBOSP/js/apps/lock-screen/service.js:545-556,793-862`; `NBOSP/js/apps/session/service.js:377-393`). Default pending `guestAccess: true` (`setup/app.js:111-126`).
- `multiuser-migration.js` runs once (marker `HKNS/system/migration/v1`) in boot step 0.5: reads legacy single-user state (HKNU/settings/username, HKNS/security lockPin/pinSalt/biometricCredentialId), adopts the first server account as owner or `POST /api/auth/migrate-legacy` with the legacy PBKDF2 hash (server re-hashes to scrypt on first verify), moves hives/AppDirs/home-tree into `~/users/<segment>/`, renames webview partitions `app_<id>` → `u<owner>_app_<id>`, deletes the legacy credential keys, and sets `HKNS/system/features/multiUser=true` (`NBOSP/js/core/services/multiuser-migration.js:79-223,247-326`). Login-time `upgradeUserLayout` additionally sweeps visible machine-home entries into the signing-in account (never clobbering on collision) (`multiuser-migration.js:396-471,544-612`).
- Guest mode: policy-gated tile; `guestLogin` mounts a **volatile** tree + hives (`volatile:true` ⇒ never persisted; guest package files purged on next mount); guest FS owner `guest_<ts>` per session; guests get `[home, .apps]` roots — **no /Shared** — and the worker excludes `__shared__` rows from guests (`NBOSP/js/apps/session/service.js:117-125,436-452`; `NBOSP/js/core/services/fs.js:39-59,633`; `NBOSP/js/core/services/workers.js:94-96`).

---

## 4. The local server

### 4.1 Bootstrap, TLS, environment

| Item | Value | Ref |
|---|---|---|
| Port / bind | `PORT\|\|3003`, `HOST\|\|'127.0.0.1'` (loopback default) | `NBOSP/server/core/index.js:643-644,686` |
| TLS | **Always** `https.createServer`; throws if cert missing; no plain-HTTP listener; plain-HTTP-on-TLS-port gets a raw-socket 400 | `NBOSP/server/core/ssl.js:31-108` |
| Certificates | Self-signed CA (`CN=NovaByte Local CA`, RSA-2048/SHA-256, 10 y) + server cert `CN=localhost` (SAN `DNS:localhost, IP:127.0.0.1`); written atomically, key 0600; CA auto-installed into OS trust stores (certutil / security / NSS + update-ca-certificates) | `NBOSP/scripts/certs.js:89-194`; `NBOSP/scripts/ca-trust.js:9-124` |
| Env secrets | `SESSION_SECRET` (64 B hex) and `NBOSP_CRED_KEY` (32 B hex) generated if missing, atomic write 0600; two validators with different minimums (see §12) | `NBOSP/scripts/env.js:130-144`; `NBOSP/server/core/env.js:9-36` |
| Body limit | `BODY_SIZE_LIMIT` default 10 MB on `express.json/urlencoded` | `NBOSP/server/middleware.js:107,333-334` |

### 4.2 Middleware chain and CORS

| # | Middleware | Ref |
|---|---|---|
| 1 | `Origin-Agent-Cluster: ?1` | `NBOSP/server/middleware.js:112-115` |
| 2 | helmet (CSP/COOP/etc.) | `middleware.js:118-184` |
| 3 | COOP override `unsafe-none` for `/api/apps/serve` | `middleware.js:197-200` |
| 4 | cors (localhost defaults) | `middleware.js:209-220` |
| 5 | rate limiters (10 instances) | `middleware.js:239-331` |
| 6 | `express.json/urlencoded` (10 MB) | `middleware.js:107,333-334` |
| 7 | `cookieParser` | `middleware.js:335` |
| 8 | **X-Nova-Session bearer→cookie rewrite** (header sid signed into `connect.sid` form before express-session — how user switching works with a single-slot cookie jar) | `middleware.js:337-362` |
| 9 | express-session (SQLite store) | `middleware.js:365-392` |
| 10 | identity middleware (`req.user`) | `middleware.js:408-436` |
| 11 | security middleware chain (excl. `/bare/`) | `middleware.js:443-471` |
| 12 | nosniff / X-XSS / CORP | `middleware.js:474-481` |

- CORS defaults to `https://localhost:3003` / `https://127.0.0.1:3003`, credentials true, and allows the `X-Nova-Session`, `X-CSRF-Token`, `X-Nova-System-*` headers (`NBOSP/server/middleware.js:206-220`).
- Sessions: `connect.sid` cookie (`secure`, `httpOnly`, `sameSite:'lax'`, 24 h) in `better-sqlite3-session-store` on `<dataDir>/data/sessions.db`, WAL, 15-min expired sweep — **sessions survive server restart** (`NBOSP/server/middleware.js:365-392`).
- Identity: authenticated session ⇒ `req.user {id,uid,role,uname,...}`; anonymous ⇒ `role: legacyAdminAllowed() ? 'admin':'user'` — legacy admin-mode grants admin to every anonymous request only while zero accounts exist (`NBOSP/server/middleware.js:408-436,400-424`).

### 4.3 CSRF and the trusted-system HMAC

- CSRF: 32-byte hex token per session, force-saved even for anonymous requests; delivered via `<meta name="csrf-token">` on `GET /` and `GET /api/email/csrf-token`; enforced `timingSafeEqual` on all non-GET/HEAD/OPTIONS via header/body/query (`NBOSP/security/middleware.js:215-331`; `NBOSP/server/core/index.js:149-150`).
- CSRF-exempt: `/health`, `/api/health`, `/api/info`, `/api/security/strip-tracking`, `/api/apps/serve` (prefix), `/api/push/subscribe`, `/api/email` (prefix — **entire email family**), `/bare/`, `/api/auth/login`, `/api/auth/setup`, `/api/auth/reverify`, `/api/auth/webauthn/login/{options,finish}` (`NBOSP/server/middleware.js:39-59`; `NBOSP/server/security/auth-routes.js:53-68`).
- Trusted system requests: HMAC-SHA256(`${timestamp}\n${appId}`) over the per-launch secret in `X-Nova-System-App/-Time/-Signature` (±30 s skew). Grants **rate-limit skip only**, not auth bypass; also used as the auth gate for push stream/subscribe (`NBOSP/server/rate-limit-auth.js:5-36`).

### 4.4 Route inventory (grouped)

Audit total: **95 HTTP routes** plus 10 `express-rate-limit` instances and 3 custom throttle/lockout mechanisms (`NBOSP/server/**` audit header). Current registration counts per file (verified by grep in tree):

| Family (file) | Routes | Highlights | Ref |
|---|---|---|---|
| Root/static + stubs + app-serve (`server/core/index.js`) | 25 | `GET /` (CSRF meta + signing JWK meta injection), static mounts, `/health`, `POST /api/os/log` (serial mirror, ≤50 lines), 11 stub endpoints, app-serve register/heartbeat/unregister + `GET /api/apps/serve/:sandboxId/{*file}` (relaxed per-app CSP, `no-store`) | `server/core/index.js:85-614` |
| Favicons | 2 | `/api/favicon` SSRF-guarded fetch chain (private-host blocklist, DNS resolve, IP-pinned undici agent, ≤5 redirects, 4 s, 1 MB) | `NBOSP/server/favicons.js:308-385` |
| Proxies | 3 | `/api/frame-check` (60/min), `POST /api/proxy` (app network egress, 300/min, body ≤6 MB, resp ≤10 MB), `/api/email-image` (500/min, image/*, ≤5 MB) — all share the SSRF posture: multi-address DNS validation, per-request IP pinning, manual redirects revalidated per hop | `NBOSP/server/proxies.js:163-785,231-430` |
| Events | 1 (mounted twice; second mount dead) | `GET /api/events/stream` SSE: replays the full 500-entry ring to **unauthenticated** clients, 25 s heartbeat | `NBOSP/server/core/events-routes.js:9-49`; duplicate mount `server/core/index.js:180` + `NBOSP/server/routes.js:21` |
| Push | 3 | `POST /api/push/subscribe` + `GET /api/push/stream` (system-HMAC gated), `POST /api/push/publish` (untrusted by design: `nps_` token possession is the capability; CSRF conflict — §12) | `NBOSP/server/core/push-routes.js:36-130` |
| Security (`security/routes.js`) | 14 | admin-mode get/post, audit query/export, sessions list/delete, suspicious-activity report, settings get/put, blocked-ips get/post/delete, suspicious get/patch (stub) | `NBOSP/security/routes.js:141-993` |
| Auth (`server/security/auth-routes.js`) | 38 | public family (users/policies/session/login/setup/migrate-legacy/logout/lock/suspend/reverify/change-pin/change-passphrase), WebAuthn register/login/options/finish/credentials, 18 admin account verbs + policies/events/usage/wipe (owner-only) | `server/security/auth-routes.js:159-1033` |
| Email (`email/controller.js`) | 13 | csrf-token, restore/startup probes, connect (TLS mandatory, creds AES-GCM-SIV onto session), folders/messages/message, disconnect, batch, send, search, preview + `GET /preview/:token` (strict CSP) | `NBOSP/email/controller.js:96-449` |

Email credential storage: creds encrypted with AES-**GCM-SIV** (nonce-misuse-resistant; key = SHA-256 of `NBOSP_CRED_KEY`) onto `session.emailCredsEncrypted` (⇒ persisted in sessions.db); plaintext only in `req.emailCreds` + a capped (1000) in-memory map with 24 h expiry; TLS mandatory for connect; SMTP `rejectUnauthorized:true` (`NBOSP/email/credentials.js:46-77,95-169`; `NBOSP/email/controller.js:127-190,279-376`). Admin state lives in `admin-state.json` in the data dir (atomic writes, in-memory cache); in the multi-user era, once users.db has rows, anonymous sessions are standard users regardless of the flag (`NBOSP/server/security/admin-state.js:43-63`; `NBOSP/server/middleware.js:394-407`).

Auth internals: login failures return **HTTP 200 + `success:false`** (monitoring must parse bodies); `establishSession` regenerates the sid (fixation defense) and returns a **bearer sessionId** usable via `X-Nova-Session`; scrypt hashing (N=32768, r=8, p=1, 16-byte salt, constant-time compare) with transparent PBKDF2→scrypt upgrade; lockout ladder 3→30 s, 6→150 s, 10→hard lock, in-memory per uid (`NBOSP/server/security/auth-routes.js:91-122,210-243`; `NBOSP/server/security/users-db.js:29-171`). Roles: `owner`/`admin`/`standard`; owner unique, undeletable, role-frozen (`users-db.js:483-495,556-577`).

### 4.5 Header posture (COOP/CSP and friends)

| Header | Value | Ref |
|---|---|---|
| Main-page CSP | `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net` (+cdn script-src-elem, styles, `connect-src 'self' wss: https: ws: http:`, `frame-src 'self' blob: data: https:`, `frame-ancestors 'self'`) | `NBOSP/server/middleware.js:118-141` |
| App-serve CSP (relaxed, HTML only) | `default-src 'self' blob: data: 'unsafe-inline'; script-src 'self' blob: 'unsafe-inline' 'wasm-unsafe-eval'; ...; connect-src 'self' blob:` — **`unsafe-eval` deliberately removed**; `frame-src http: https:` added only when `entry.allowExternalFrames` | `NBOSP/server/core/index.js:553-593` |
| COOP | helmet `same-origin-allow-popups` globally; **overridden `unsafe-none`** on `/api/apps/serve` (documented OAuth popup relay tradeoff) | `NBOSP/server/middleware.js:183,197-200` |
| COEP | not configured (helmet default = disabled) | `NBOSP/server/middleware.js:118-184` |
| CORP | helmet CORP disabled; custom middleware sets `cross-origin` if absent | `NBOSP/server/middleware.js:142,477-479` |
| XFO / nosniff / XSS / Referrer / Permissions-Policy | `SAMEORIGIN`; `nosniff`; `1; mode=block`; `strict-origin-when-cross-origin`; `geolocation=(self), microphone=(self), camera=(self), payment=(), usb=()` | `NBOSP/security/middleware.js:524-547` |
| HSTS | not explicitly set anywhere; helmet default (`max-age=15552000; includeSubDomains`) applies | — |
| Cache-Control | all `/api/*` ⇒ `no-store, no-cache, must-revalidate, proxy-revalidate` | `NBOSP/security/middleware.js:555-558` |

Rate-limit architecture: 10 express-rate-limit instances (global `/api` 100/15 min per IP with skip-lists; auth 30/1 min; email connect/read/write 120/60/20 per min; favicon 60/min; events-stream 30/min; frame-check 60/min; app-proxy 300/min; email-image 500/min), all keyed by IP with trusted-HMAC skip (`NBOSP/server/middleware.js:239-331`; `NBOSP/server/proxies.js:80-87,432-439,753-760`). Non-`/api/*` paths have no rate limit at all; the global limiter double-counts email & push paths.

---

## 5. The app sandbox engine

File: `NBOSP/js/platform/security/app-sandbox.js` (14,895 lines; IIFE, `window.AppSandbox` global + CommonJS export for tests) (`:12-13,14880-14895`). Loaded at `NBOSP/index.html:238`.

### 5.1 Launch flow: from user click to sandbox

User surfaces all funnel into `WM.createWindow(app.id)` (launchpad grid/context menu, desktop `.lnk` shortcuts, App Manager, My Apps Manager; web apps via `openWebApp`) (`NBOSP/js/apps/launcher/app.js:257,1395-1399`; `NBOSP/js/apps/appmanager/app.js:2168`). `WM.createWindow` (`NBOSP/js/apps/shell-ui/wm.js:89-410`): canonicalize appId → disabled-app block (HKNU/apps/disabled) → devOnly gate (`!devMode && app.devOnly ⇒ null`) → geometry from manifest + Shell Bags restore → in-window chrome (titlebar, 8 resize handles; **all in-window DOM, not nw.Window**) → background reattach-first (a live backgrounded sandbox moves into the new window instead of double-launching) → `app.init(...)` which for sandboxed apps is the shim into `AppRegistry.launchApp`. Window flags: phishing combo guard — `frame:false && transparent:true && alwaysOnTop` clamps to zIndex 1000 below system chrome (`wm.js:665-688,673-679`).

`AppRegistry.launchApp` (`NBOSP/js/platform/core/app-registry.js:623-731`) runs the permission gate (§7.3), records usage (feeds the 30-day sweep), then calls `AppSandbox.launch`. The launcher-side config builder `buildNovaAppConfig` (`NBOSP/js/platform/core/nova-app-launcher.js:729-1233`) maps manifest → config and preserves trust metadata; a legacy fallback path (used only if `AppSandbox` failed to load) re-verifies integrity at every launch, registers files at `/api/apps/serve/register`, and falls back to blob-URL serving when registration fails.

### 5.2 Launch tier decision and `createSandbox` pipeline

`AppSandbox.launch` (`:14255-14348`) decides the execution tier:

1. `hasRootExecutionGrant(app)` (`system:root` grant + `devMode` + `rootAccessEnabled`) → `launchRootApp` (host page, audited) (`:14135-14184`).
2. `ensureExecutionPartitionClean(app.id)` — refuses launch while a required partition wipe is pending/failed (fail-closed) (`:14370-14385`).
3. `UnrestrictedGate.checkUnrestrictedApp(app)` re-run **every launch** (never cached) → `launchUnrestrictedHostApp` (no webview) (`:14263-14281`).
4. Else `createSandbox(...)` + `loadAppContent` after a deliberate 250 ms delay (mitigates the `addContentScripts` registration race, nwjs#7597) (`:14307-14334`).

`createSandbox` (`:13722-14011`) builds the `<webview>`:

| Aspect | Behavior | Ref |
|---|---|---|
| Node access | `nodeintegration="false"`, `nodeintegrationsubframes="false"` (popup webviews too) | `:13727-13728,13653` |
| Partition | multi-user `persist:u<uid>_app_<appId>`; guest volatile `guest_app_<appId>`; fallback `persist:app_<appId>` — apps never choose their uid dimension | `:13749-13765`; `NBOSP/js/platform/core/user-scope.js:1-14` |
| `sandbox` attr | `sanitizeSandboxAttr` (`:13392-13508`): recognized tokens only (`allow-scripts/allow-forms/allow-popups/allow-popups-to-escape-sandbox/allow-modals` from manifest sandbox config; exotic tokens dropped); `allow-same-origin` only if manifest `sandbox.allowSameOrigin===true` **and** live grant `sandbox:same-origin`; `allow-downloads` always added; fully-unrestricted apps get the attr removed | `:13392-13508,13796-13803` |
| IPC transport | isolated-world content script registered via `addContentScripts` `run_at:'document_start'`, scoped to this sandbox's two serve paths only (`/api/apps/serve/<sandboxId>/*` and the stable alias `/api/apps/serve/sandbox_<appId>/*`) — matching the bare origin would inject every app's transport into every other app's webview | `:13805-13857` |
| Content serving | `POST /api/apps/serve/register` (base64 file map under `sandbox_<appId>_<unique>`, stable alias if `APP_SERVE_APP_ID_PATTERN` matches — relaunch-stable URL for OAuth callbacks); heartbeat every 5 min while alive; server prunes at 30 min idle | `:1113-1135,13921-13929`; `NBOSP/server/core/index.js:410-515` |
| Record | `sandboxRecord` in `activeSandboxes`: `{appId, iframe/webview, wsConnections, appIpcEndpoints, ipcBroadcastActions, nestedWebviewOptedIn, openFile, homeSurface, pickedFileIds, wantsBackgroundLive, cleanup}` | `:13948-13964,2221,2904` |
| App CSP | `RELAXED_CSP_META` `default-src 'self' blob: data: 'unsafe-inline'; script-src 'self' blob: 'unsafe-inline' 'wasm-unsafe-eval'; ...; connect-src 'self' blob:` (`unsafe-eval` removed; eval attempts are audited instead) | `:13071,9278-9289` |

### 5.3 Guest bridge protocol

Two-realm design: an **isolated world** (content script) and the **main world** (app page + capability shim). The guest has no embedder reference (`window.parent === window`), so host→guest delivery is `webview.executeScript` pushing into an isolated-world inbox (`:1611-1649`).

1. **Port handshake.** The shim (main world, guaranteed first script) posts `{__novaBridge:'__NOVA_BRIDGE__', kind:'claim-port'}` to its origin; the isolated transport (armed at `document_start`) creates a `MessageChannel`, keeps port1, transfers port2 back with `claim-port-ack`. One-shot on both ends; **possession of the port is the credential** — this replaced forgeable tagged `postMessage` (a past guest-XSS could fake responses for its own in-flight requestIds) (`:10029,10050-10078,10206-10230,11083-11100`).
2. **Guest→host.** Isolated script parks the payload at `window.__novaOutboxPull[requestId]` and `console.log('__NOVA_IPC__:' + JSON.stringify({type, requestId}))`. Host listens per-webview on `consolemessage`, then pulls the payload with an isolated-world `executeScript` — only the marker pair crosses the visible console stream, so secrets (API keys, file bytes) never land in logs (`:9693-9781,10129-10130`).
3. **Host→guest.** `respond()` base64-JSON-pushes `{type: '<type>:response', requestId, result, error}` into `window.__novaInbox` (isolated world). Payload spliced as `JSON.stringify(b64)` to prevent template-literal breakout; `__directResponder` fast path for tests (`:1642-1704`).
4. **Ready handshake.** The shim auto-fires `ipc('nova:ready', {})`; the host responds with `{success, appId, permissions, optionalPermissions, osVersion, securityPatch, username}` (username only for `app.system===true`), then immediately flushes queued one-shot alarms, inbound shares, and push messages (`:8711-8771,8743-8770,11879-11881`).
5. **Dispatch pipeline** for every guest call (`handleAPICall`, `:9569-9614`): legacy `vfs:*` alias translate (translate-then-enforce, `:9492-9564`) → `GUEST_FORBIDDEN_IPC_APIS` reject (`PERMISSION_DENIED / 'This system capability is only available through trusted OS UI'`, `:9317-9336,9577-9579`) → `API_HANDLERS` lookup (`UNKNOWN_API`) → **MAC front door** (§6) → handler. Handler inventory: 80 handler bodies start in lines 1–5100 of the file — 57 guest-reachable (registered in `API_HANDLERS`) + 23 host-only (no `API_HANDLERS` entry; dead code for IPC) (`:9338-9463,9317-9336`).
6. **Isolated processes** (Tier-2 background, no webview) get `dispatchIsolatedProcessRequest` with a narrower allowlist `ISOLATED_PROCESS_API_TYPES` (ready, app:info, fs core, storage, alarms, secrets, settings, notifications, clipboard, net:fetch, mail/calendar/contacts, badge...; registry channels deliberately excluded); 30 s timeout (`:9465-9490,9627-9678,3087-3089`).

### 5.4 Filesystem ownership model (path-derived "logical UID")

Because kernel per-app UIDs cannot exist in a single browser process, ownership is derived from paths at this bridge ("the 'logical UID' layer... per-app isolation is enforced where every app call already funnels through: this bridge"; "accounting counters are best-effort telemetry, NOT security boundaries") (`:233-251`).

- Scoped roots: `appdata:<p>` → caller's own `/data/<appId>/` (even `appdata:/otherApp/x` is rewritten into the caller subtree); `shared:`/`media:` → shared tree, refused if they resolve into `/data` (`:1773-1797`).
- `ownerAppIdForPath` = first `/data/<segment>`; `resolveFile` by id **and** by path both enforce ownership (raw-`id` resolution used to skip the check — fixed); `canReadFileContents`/`canMutateFile`/`canReadMetadata` ladders; `ensureOwnAppDataAncestors` mkdir-p only inside the caller's subtree; fs:move dest-parent re-check ("an app moving its own file into another app's /data/<otherAppId>/ would otherwise be able to plant files there") (`:1707-1961,2648-2692`).
- Aliases: `appDataSegment` canonicalizes via `NovaAppIdAliases` first (a legacy id owns the canonical app's subtree) (`:1438-1444`).

### 5.5 StorageLedger (budgets/accounting)

Per-app record `{created, lastActive, bytesWritten, bytesRead, requestCount, budgets}` persisted to localStorage `novaOS_storage_ledger` (debounced 400 ms); access ring 500 entries (`:252-331`).

| Budget | Default | Clamp | Ref |
|---|---|---|---|
| `storageQuotaBytes` | 256 MB | 1 MB – 2 GB | `:263-274` |
| `ipcPayloadBytes` | 256 KB | 1 KB – 8 MB | `:263-274` |
| `httpBodyBytes` | 16 MiB | 64 KB – 64 MiB | `:263-274` |
| `requestTimeoutMs` | 60 s | 5 s – 10 min | `:263-274` |

App K-V storage lives in the host-shell IndexedDB keyed `[appId, key]`; keys `STORAGE_KEY_REGEX = /^[\w\-. ]+$/` (no slashes/colons — prevents cross-namespace key injection), values ≤5 MB (`:207-213`); `clearAppPartition` wipes only the webview partition, `storageClear` only the host IndexedDB — uninstall needs both (`:14762-14770`).

### 5.6 URL/IP classification for network egress

| Check | Behavior | Ref |
|---|---|---|
| `resolveAndClassifyUrl` | resolves against `window.location.origin` (kills `//evil.com`), http/https only, hard-denies cloud metadata hosts (`169.254.169.254`, `fd00:ec2::254`), returns `{valid,url,isInternal}` | `:1247-1288,1258` |
| `resolveAndClassifyWebSocketUrl` | absolute ws/wss only, no credentials in URL, metadata denied; internal DNS suffixes (`.localhost .local .lan .internal .home.arpa .test`) + single-label hosts count internal | `:1299-1326` |
| `isPrivateIPv4` | 127/8, 10/8, 172.16-31, 192.168/16, 169.254/16, 0/8 ("Linux resolves any 0.x.x.x to loopback"), 100.64/10 (CGNAT) | `:1356-1366` |
| `isPrivateIPv6` | `::1`, `::`, fc00::/7, fe80::/10, IPv4-mapped/compatible classified by embedded IPv4 | `:1372-1386` |
| `isInternalHost` | INTERNAL_HOSTS (`localhost`, `api.novabyte.internal`) → private v4 → private v6 | `:1388-1401` |

The handler then requires `net:internal` for internal destinations, `net:external` otherwise (the MAC row is ANY-of the two so the front door does not preempt the per-destination check) (`:272-279` in the seed table comments; handler `:6393+`).

### 5.7 Frame security (`frame-security.js`, iframe posture)

`NovaFrameSecurity` covers **`<iframe>` elements only** (not `<webview>` navigation); threat model: NW.js grants Node to iframes from trusted origins, so an escaped sandboxed page must not reach `parent.document` and strip its own sandbox (`NBOSP/js/platform/security/frame-security.js:9-19`). Enforcements: node-frame eligibility allowlist (`https://localhost(:\d+)?` / `127.0.0.1`), always-normal schemes (blob/data/javascript/file can never be node frames), `nwdisable` inheritance across the **full** ancestor chain, node frames must not carry `sandbox`, iframes with src must carry `sandbox` (`nwdisable` alone insufficient), `allow-same-origin`+`allow-scripts` flagged and deleted, `sandbox=""` recognized via `hasAttribute` (DOMTokenList length-0 pitfall), MutationObserver watches added iframes **and attribute changes** (closes the swap-src-after-audit hole), API frozen, 100-entry recent-issues ring (`frame-security.js:65-250,298-312,629-662,708-724`). `NORMAL_SANDBOX_TOKENS = 'allow-scripts allow-forms allow-modals allow-popups'` (`:80`). Note: the observer is effectively **audit-only** in production (see §12.2). Webview-scope behaviors (popup policy, downloads, external protocols, device permission gate, nested-webview navigation gate) live in app-sandbox/system-webview instead (`app-sandbox.js:13530-13715,9886-9951`; `NBOSP/js/apps/system-webview/service.js:336-502`).

### 5.8 The three sandbox capability permissions

| Permission | Opt-in | Consent | Effect | Ref |
|---|---|---|---|---|
| `sandbox:same-origin` | manifest `sandbox.allowSameOrigin===true` | live grant at createSandbox | adds `allow-same-origin` token (guest gets real cookies/localStorage on the shared origin); revocation closes windows + queues partition wipe | `app-sandbox.js:13394-13401,14399-14419` |
| `sandbox:escape-popups` | **top-level** `allowPopupsToEscapeSandbox` field (not the permissions list) | checked per popup at `newwindow` | popup runs unsandboxed (OAuth origin postMessage); token without grant ⇒ popup silently discarded, fail-closed | `app-sandbox.js:9988-9992,13583-13599` |
| `sandbox:nested-webview` | `allowNestedWebview===true` or declared | re-checked on every host op | enables `nova:nested-webview` mediated child webviews, host context menus, overlays; revocation destroys nested views + overlays | `app-sandbox.js:9968-10005,3301-3306,14390-14398` |

### 5.9 Partition lifecycle and wipes

- Partition naming is user-scoped (see §5.2); guest partitions are volatile by name (`guest_app_<id>`) (`:13749-13765`).
- `clearAppPartition`/`clearAppPartitions` wipe the webview `persist:` partition with `CLEAR_PARTITION_TIMEOUT_MS = 4000`; a failed/queued wipe sets the `partitionCleanupRequired` marker and **blocks future launches** of that app (fail-closed) (`:44-49,231,14350-14385`).
- `destroy(sandboxId)` (`:14425-14509`): reentrancy-guarded delete → cancel pending app-IPC → run collected teardown (bridge listener, event subs, WebSockets closed with `1000,'sandbox closed'`, file dialogs restored, popups, nested views, heartbeat) → remove element (prevents background-host renderer leak) → `DELETE /api/apps/serve/unregister/<sandboxId>` → partition wipe decision (wipe if the webview did not carry `allow-same-origin` and no sibling window of the same app remains).
- Permission revocation of `sandbox:same-origin` force-closes windows and queues a partition wipe (`:14399-14419`); root-revocation triggers a full OS reload to evict partially-executed root code (`:183-202`).

---

## 6. MAC policy engine (NB-MAC)

A JS-side SELinux analog inside `app-sandbox.js` (`:470-1032`), motivated explicitly: "The kernel route for per-app mandatory access control is a dead end in this architecture... so the SELinux model is reimplemented in JS" (`:471-475`). Mapping: domain ← `subjects` pinning else `untrusted_app`; type = IPC endpoint family; allow = `endpointGrants` rows; neverallow = `verifyPolicy` rejects weakening; avc audit = rate-limited denial ring; permissive mode per domain (`:477-486`).

**Enforcement contract:** grant rows exist ONLY for handlers whose permission check is "unconditional and context-free" (mirroring the MATRIX table in `NBOSP/tests/integration/ipc-matrix.suite.js`); path-dependent rules stay handler-level as advisory rows. "MAC is the uniform front door, the handlers are defense in depth" (`:488-497`).

| Concept | Detail | Ref |
|---|---|---|
| Domains | `untrusted_app` (enforcing), `platform_module` (permissive); `subjects` map pins appIds to domains (seapp_contexts analog; empty by default — every sandboxed app starts untrusted) | `:522-524,697-719` |
| `endpointGrants` | 88 seed rows: 67 grant-coupled (array = **ANY-of** the listed permissions) + 21 advisory (`null`). E.g. `'nova:notifications:show': ['device:notifications']`, `'nova:app:launch': ['system:app-launch','system:apps']`, `'nova:net:fetch': ['net:internal','net:external']` | `:534-681` |
| Advisory rows | `null` rows pass the front door; the handler is the boundary. Covers all `nova:fs:*` (path-dependent), `nova:home:apps:launch` (Home-caller checks), `nova:locale:get` (ungated on purpose), cleanup/passive forms (`nova:app:info`, `nova:net:ws:send/close`, `nova:events:subscribe`, `nova:background:wake-done`, ...) | `:534-681` |
| Advisory families | 20 families with no grant-coupled endpoints (`nova:fs`, `nova:storage`, `nova:window`, `nova:appearance`, `nova:ready`, `nova:dialog`, `nova:sysdialog`, `nova:overlay`, `nova:context-menu`, `nova:share`, `nova:files`, `nova:email`, `nova:open-url`, `nova:open-with`, `nova:download`, `nova:wallpaper`, `nova:request-permission`, `nova:permission-rate-limited`, `nova:audit`, `nova:locale`) | `:683-695` |
| neverallow | `SEED_NEVERALLOW = [{target:'nova:admin', requireGrant:true, reason:'admin endpoints must stay grant-coupled'}]` — `verifyPolicy` errors if a neverallow family/endpoint is advisory or missing grants | `:697-719,880-940` |
| `checkIpc` | exact endpoint row wins → family advisory → default-deny with avc `reason=no_policy_row` for enforcing domains; denial string `avc: denied { call } for app=<id> endpoint=<type> domain=<domain> mode=<mode> required=<perms>` | `:824-876` |
| Permissive mode | domain in permissive ⇒ `{allowed:true, wouldDeny:true}` (audited, not enforced) | `:858-860,971-978` |
| Audit ring | localStorage `novaOS_mac_audit`, 300 entries, 400 ms debounce; **audit writes** rate-limited 60/min/app but "denial decisions themselves are never rate-limited — a denied call is always denied" | `:513-520,745-801` |
| Policy ops | `verifyPolicy` (schema + neverallow), `applyPolicy` (verify first, throws `Invalid MAC policy: <errors>`), `verifyCoverage` (a dropped row is stricter, not a violation, but a coverage gap), `getPolicyInfo` snapshot | `:880-1031` |

A dropped grant row is not a neverallow violation (no rule ⇒ deny) but is flagged by `verifyCoverage` (`:697-702`).

---

## 7. Permission manager internals

File: `NBOSP/js/platform/security/app-permission-manager.js` ("apm"), with `unrestricted-gate.js`, `trust-store.js`, `app-permissions-bootstrap.js`.

### 7.1 Catalog

Single source: `PERMISSION_TYPES` + `PERMISSION_CATEGORIES` — **52 permissions, 11 categories, 4 risk tiers** (low 10 / medium 16 / high 15 / critical 11), mirrored as `KNOWN_PERMISSIONS` in `app-registry.js` (install-time strip of unknown names) (`apm:15-139,141-245`; `NBOSP/js/platform/core/app-registry.js:30-50,315-324`). Category counts: filesystem 6, network 3, email 4, calendar 3, contacts 3, device 6, data 3, system 16, apps 1, admin 4, sandbox 3 (`apm:141-245`). Notable grant rules:

| Class | Rule | Ref |
|---|---|---|
| `fs:access` (critical) | `specialAccess: true` — apps can never prompt; Settings toggle only | `apm:142,778` |
| `system:root` (critical) | prompt only when `devMode && rootAccessEnabled`; `grantPermission` throws ("must be granted through its explicit confirmation prompt"); never swept by the 30-day expiry | `apm:198,779,935-937,469-472` |
| `admin:*` (4) | grant additionally requires an admin-role session when multi-user is on; **single-user machines return `isAdminSessionActive()===true` for everyone** | `apm:647-649,672-676` |
| Low-risk | `autoGrantLowRisk()` auto-grants all `risk:'low'` unless explicitly denied | `apm:941-951` |
| Legacy aliases | `vfs:*` → `fs:*` translated at install AND at runtime `requestPermission` ("can never widen an old app's access silently") | `apm:251-257,776`; `app-registry.js:60-81,296-313` |
| Settings identity exemption | `com.nbosp.settings` (System-signer triple) passes every `isGranted` check; identity re-checked live on every call | `NBOSP/js/platform/security/unrestricted-gate.js:54-78`; `apm:629-642` |

### 7.2 Grants persistence and evaluation layers

- Storage: registry-first — `HKNS/security/appPermissions` (REG_JSON, machine-wide), switched to **`HKNU/security/appPermissions` when multi-user is on** ("each account consents for itself"); localStorage `nova_app_permissions` fail-soft fallback; sweep stamp `HKNS/security/meta/lastSweep` (`apm:421-451,259-262`; `NBOSP/js/platform/core/registry-system-state.js:39-67,256-278`).
- Grant record `{appId, permission, granted, grantedAt, grantedBy, permanent, expiresAt, reason, lastUsed}`, keyed `${appId}:${permission}`; appId must contain no colons; integrity is structural only — "HMAC against localStorage tampering is security theatre here" (`apm:371-395,886-909`).
- `isGranted` layers: admin-session check for `admin:*` → machine policy `HKNS/security/policy/appPolicy/<appId>` (`deny` list hard-blocks; `pin` list **force-grants regardless of consent**) → per-key grant table (non-permanent grants expire after 1 day; lazily deleted) (`apm:641-669,896-898`).
- Grants are keyed by appId only — **not** version or signature; reinstall/update under the same id inherits all consents (only `system:root` has a restore-time re-check for non-system signers) (`NBOSP/js/platform/core/app-registry.js:171-185,278-284`).

### 7.3 Prompt queue, dialog, rate limiter, sweep

- Prompts happen at **launch** (never install): low-risk auto-granted; only missing required medium/high/critical queued via `requestAll()`; **denial never blocks launch** ("Launch continuing in restricted mode", `__deniedPermissionsAtLaunch` recorded) (`app-registry.js:623-731`). Runtime requests arrive via `nova:request-permission` IPC with a caller-supplied reason (`app-sandbox.js:3592-3606`).
- `requestAll` is a sequential pager ("Permission {current} of {total}"); previously-denied still re-prompt on the runtime path — the rate limiter is the actual defense (`apm:858-882,782-791`).
- Dialog: `z-index:100000`, DOM built with `createElement/textContent` only (appName/reason untrusted), root requests add the UNVERIFIED PUBLISHER banner + mandatory acknowledgement checkbox ("This app will run inside the OS, not in its sandbox."), **Enter = Allow**, Escape = Deny, no timeout (`apm:1026-1032,1149-1280`).
- Rate limiter (anti prompt-bombing): `RATE_MAX_BURST=3` per `${appId}:${permission}` per 60 s; violation ⇒ silent auto-deny + cooldown `5 s * 2^denialStreak` capped 15 min; denial streak cap 20 (`apm:264-277,727-767`).
- 30-day sweep: granted perms deleted when `lastUsed`/`grantedAt` older than 30 days (notification per app); denial records never swept; `system:root` never swept; runs ≤1×/day, deferred 5 s after boot (`apm:457-530`).
- Bootstrap: the built-in permission map is intentionally **empty** — first-party trusted apps run host-tier with no permission list; only third-party/web-app gating actively bootstraps (web apps: auto-grant `net:external`+`net:websocket`, prompt camera/mic/geolocation; 2 s poll for 300 s) (`NBOSP/js/platform/security/app-permissions-bootstrap.js:35-39,233-291`).

### 7.4 Trust store and the unrestricted gate chain

- Anchors: 'NovaByte Trusted Signing' (Ed25519, general "Verified" tier) and 'NovaByte System' — default **public TEST key** (private half committed at `NBOSP/keys/test-system-key.json`, "like AOSP's platform.pk8"), swappable to a release JWK via env `NBOSP_SYSTEM_SIGNING_PUBLIC_JWK` → server-injected `<meta>`; `systemSignatureTier()` returns `'test-keys'`/`'release-keys'` (shown in Settings→About) (`NBOSP/js/platform/security/trust-store.js:90-211,353-364`).
- Revocation: `revoked-signatures.json` (currently `[]`), keyed by exact signature string ("the only safe revocation key"), per-machine persistence, O(1) index, EventLog'd (`trust-store.js:55-71,245-488`).
- `UnrestrictedGate.checkUnrestrictedApp` requires all six, fail-closed: `system===true` ∧ `verified===true` ∧ `signer==='NovaByte System'` ∧ `source==='system-bundle'` (provenance only boot can mint) ∧ `manifest.system===true` ∧ id in build-time `js/apps/novaapp-manifest.json` (fail-closed to empty set on fetch error) ∧ integrity record present and re-verified at call time (`NBOSP/js/platform/security/unrestricted-gate.js:141-176,84-127`). The gate is identity-based and reads no permission state; the sandbox-tier `system:root` check is separate and adds the grant + both device toggles (`unrestricted-gate.js:12-41,129-139`; `app-sandbox.js:14135-14143`).

---

## 8. Registry internals

### 8.1 Engine (`NBOSP/js/platform/core/nova-registry.js`)

| Hive | Meaning | Scope |
|---|---|---|
| HKNS | NovaSystem — OS/machine config (shell, wallpaper, security policy) | machine-wide |
| HKNU | NovaUser — per-user prefs | mounted per account |
| HKNA | NovaApps — per-app config under `HKNA/<appId>/` | mounted per account |
| HKND | NovaDev — dev scratch ("wiped in production builds") | mounted per account |
| HKCU | alias → HKNU (HKEY_CURRENT_USER analogue) | — |

(`nova-registry.js:7-71,383-384`.) Path rules: `/` or `\` separators, hive case-insensitive, segments case-sensitive ≤64 chars, ≤16 deep, no `.`/`..`; last segment names a value; every key implicitly owns `(default)` (`:372-399,835-851`). Value types: `REG_SZ`, `REG_EXPAND_SZ` (expanded against `HKNS/env/*`, single pass), `REG_MULTI_SZ`, `REG_BOOL`, `REG_DWORD`, `REG_QWORD`, `REG_JSON`, `REG_BINARY` (`:73-75,501-580`). LINK keys (`REG_LINK`-flavored): cross-hive links readable, write-through refused (`LINK_CROSS_HIVE`), loops capped at 4 hops (`:459-486,1004-1005`).

File layout & atomicity (Linux): HKNS at `~/.config/novabyte/registry/HKNS.json`; mounted user hives at `~/.config/novabyte/users/<username>/registry/<HIVE>.json`; AUDIT + SNAPSHOTS pseudo-hive docs in the same dir; `mkdir 0700` → `<file>.<pid>.tmp` 0600 → `rename`; corrupt JSON quarantined to `<file>.corrupt` and the engine starts fresh (`:243-274,346-360`). Web/test fallback: localStorage keys `nova_registry_hive_<HIVE>` / `nova_registry_hive_u_<user>_<HIVE>` (`:279-282`).

Quotas and invariants: value ≤256 KiB, hive ≤2 MiB, ≤4096 nodes/hive, import ≤2048 values, audit ring ≤500, snapshots ≤3/hive, ACL ≤32 entries (`:83-96`). Every mutation is **clone → validate → swap** (`commitMutation` — a rejected write can never half-apply) (`:584-610`). Sealed phase: after `unmountUserHives()` writes to user hives throw `NOT_READY` so a picker-phase write cannot land in machine docs (`:585-592,1504-1511`); volatile (guest) mounts apply in memory only (`:606,1480`).

Audit ring: every mutation appends `{ts, actor, action, path, before, after}` (≤200-char previews; actor = explicit → appId → seed/shell/system) (`:625-679`). Snapshots: 3 full copies per hive + one boot auto-snapshot; `batch()` is all-or-nothing cross-hive with rollback (`:1164-1197,1221-1278,1410-1421`). ACLs: `{id, rights:['read','write'], inherit}`, deepest-wins, `*` wildcard, **no ACL ⇒ granted**, actor `system` always granted — evaluation lives in the engine, enforcement in the sandbox (`:811-823`).

Satellite stores (same engine): `registry-boot-state.js` (`HKNS/system/boot/*`, dual-writes registry + legacy localStorage for the pre-boot init.js handoff), `registry-prefs.js` (`HKNU/apps/{disabled,boot,showHidden}`, `HKNU/shell/*`), `registry-system-state.js` (`HKNS/apps/*`, `HKNS/security/appPermissions`; per-user splits `HKNU/apps/installed`, `HKNU/security/appPermissions`, `HKNU/apps/webapps`), `settings-shim.js` (OS.settings ↔ registry; `SETTINGS_KEY_TO_PATH` maps e.g. `devMode → HKNS/system/devMode`, `rootAccessEnabled → HKNS/security/rootAccessEnabled`; reverse sync live-applies external registry edits to settings) (`NBOSP/js/platform/core/registry-boot-state.js:41-49`; `registry-prefs.js:29-38`; `registry-system-state.js:38-51,181,265-268,346`; `settings-shim.js:121-221`; `nova-registry.js:116-161`). `.nvreg` text format (`nova-reg-file.js`) and the `reg` CLI (11 commands, devconsole-hosted, actor `devconsole:reg`) (`NBOSP/js/platform/core/nova-reg-file.js:9-30`; `nova-reg-cli.js:384-402`).

### 8.2 Sandbox access rules (`nova:reg:*`)

Flat grants: get/list/export ← `registry.read`; set/delete/import ← `registry.write` (`app-sandbox.js:658-680`). Per-hive rules without `registry.system` (`:3095-3179`): HKNA writes only own `HKNA/<appId>/**`; HKNS writes need `app.system===true` and never `HKNS/security`; HKNU writes need a matching `registryScopes.write` prefix (default third-party scope `HKNU/software/<appId>`); HKND additionally needs devMode. Reads: plain `registry.read` reads **every hive except `HKNS/security`** — including other apps' HKNA subtrees and all of HKNU; per-key ACLs are the only, opt-in, confidentiality control. Registry channels are excluded from isolated/background processes (`:3087-3089`).

### 8.3 App secrets (`NBOSP/js/platform/security/app-secrets.js`)

- AES-256-GCM per value (random 12-byte IV, auth tag); `decrypt` returns null on tamper; ciphertext-only on disk (`:140-161`).
- Master key: 32 random bytes at `<rootDir>/app-secrets.key` (0600, dir 0700), `rootDir = NOVA_SECRETS_DIR || process.cwd()/root`; no passphrase derivation — the key is a file. Refusal to persist ⇒ ephemeral in-memory key (secrets vanish on reboot) (`:46-89`).
- Store: `<rootDir>/app-secrets.json` `{version:1, apps:{<ns>:{<key>:{iv,tag,data,ts}}}}` 0600; namespace = `<ownerUid>/<appId>` when multi-user (pre-login writes land in the legacy owner's namespace); same machine key for all users — per-user wrapping admitted as future work (`:99-138`).
- Budgets: 64 secrets/app, 8 KB/value, 128-char keys (`:38-40,91-97`). Sandbox handlers force the caller's appId namespace (an app can never address another app's namespace) and secrets are excluded from backup/export envelopes (`app-sandbox.js:8120-8162`).

### 8.4 Root broker (`NBOSP/js/platform/security/root-broker.js`, `window.NovaRoot`)

| Command | Execution | Ref |
|---|---|---|
| `status()` / `requestSession({appId?,reason?})` | OS-rendered consent modal (z 2147483600, **no password** — "NovaByte account passwords live in NovaByte, not Linux, so a sudo password would be theater") | `:445-453,327-364,7-11` |
| `run({argv, inputB64?, timeoutMs?, maxBuffer?})` | `sudo -n -- <argv…>` — **arbitrary argv, no command allowlist** ("no shell, nothing to inject"); returns `{code, stdoutB64, stderrB64}` | `:25-27,222-224,366-410` |
| `rm` / `cp` / `mkdirp` / `readFile` | `['rm','-f','--',path]` etc.; `readFile` = `cat --` | `:415-436` |
| `writeFile(dst,content)` | user-owned random-named tmp in os.tmpdir + `mkdirp` + `cp` (avoids root-owned temp) | `:419-431` |
| `endSession()` | `sudo -k` (clears the cached sudo timestamp) | `:438-443` |

Caller gate re-checked every call: `rootModeEnabled()` (devMode ∧ rootAccessEnabled; multi-user additionally requires an admin session) → live `system:root` grant (revocation is instant) → caller identity via `novaapp:<id>/` sourceURL markers / `window.__novaUnrestrictedPackage` / focused-root-window attribution → sudo present (`:13-20,117-153,155-177,327-353`). Session cached polkit-style: 15-min soft TTL is display-only; **the real TTL is sudo's own timestamp** (`:57,323-325`). Every grant/denial/operation → EventLog `{app:'NovaRoot', category:'security', data:{appId, argv}}` (`:179-191`). Reachability: `window.NovaRoot` exists only in the host page; sandboxed webviews never see it (`:44-51`). Backing sudoers rule: `nbosp ALL=(ALL) NOPASSWD: ALL` (§10).

---

## 9. Background execution and services

### 9.1 Three tiers (permission-grant driven; no `service:` manifest field for third parties)

| Tier | Grant | Meaning | Budget | Ref |
|---|---|---|---|---|
| 1 scheduled wake | `system:background` | OS wakes a closed app ~every 15 min into a hidden 1×1 px sandbox | 10 s hard deadline per wake | `NBOSP/js/platform/security/app-scheduler.js:46,58` |
| 2 stay-alive | `system:background:live` | webview survives window close (reparented to hidden `#background-app-host`) | unbounded (OS-page lifetime); pinned non-dismissible Terminate notification is the kill switch | `app-sandbox.js:14539-14573`; `NBOSP/js/apps/notifications/service.js:654-675` |
| 3 autostart | `system:autostart` + user boot-list entry (HKNU/apps/boot, written only by App Manager) | launches at OS boot, visible window; suppressed while locked | — | `NBOSP/js/core/core/boot.js:1140-1189` |

A separate mechanism exists for first-party code: `systemService: true` + `unrestrictedEntry` manifests ("privileged OS code, not sandboxed third-party execution") — 26 headless services injected at boot (§3.3); service lifetime = OS-page lifetime, no restart (runtime error ⇒ banner), no CPU/memory budgets anywhere (`NBOSP/js/core/services/system-service-loader.js:132-151,240-252`).

### 9.2 Service inventory (load order = manifest array order)

| # | Service id | Purpose |
|---|---|---|
| 1 | com.nbosp.service.app-loader-optimiser | Preloads/caches .novaapp packages (IndexedDB `NovaByte_AppLoaderOptimizer`); special-cased first so later loads hit the cache |
| 2 | com.nbosp.service.novabyte-system | Hardware/system bridge (network, power, developer.setMode/setRootAccess) |
| 3 | com.nbosp.shell-ui | Window manager + menu + modals + desktop (only multi-script service: wm.js, menu.js, modals.js, desktop.js) |
| 4 | com.nbosp.service.event-log | Central in-OS event/log ring (§9.6) |
| 5 | com.nbosp.service.downloads-history | Download history ring (500) + chrome.downloads bridge |
| 6 | com.nbosp.service.search-index | Search indexing |
| 7 | com.nbosp.service.media-store | Media store |
| 8 | com.nbosp.service.network-activity-log | Network activity log |
| 9 | com.nbosp.service.notifications | Notify service (§9.5) |
| 10 | com.nbosp.service.store-updates | Store update checker |
| 11 | com.nbosp.service.scanner | Malware-heuristic scanner used at install |
| 12 | com.nbosp.service.system-dialogs | System modal dialogs (save dialogs, etc.) |
| 13 | com.nbosp.service.registry | `APP_REGISTRY` + `WebAppManager` + web-app windows + `OS.openUrl`/mailto + global link interception |
| 14 | com.nbosp.service.default-apps | Default app/handler resolution |
| 15 | com.nbosp.service.background-apps | Clock + email background singletons on `window.__NBOSP_BG` (§9.4) |
| 16 | com.nbosp.service.server-events-bridge | SSE → EventLog bridge |
| 17 | com.nbosp.service.calendar-notifier | 30 s calendar reminder poller (10 min lead) |
| 18 | com.nbosp.service.wallpaper | Wallpaper presets/application |
| 19 | com.nbosp.service.system-webview | Trusted webview guests + nested-webview mediator (`NovaSystemWebview`) |
| 20 | com.nbosp.service.easter-egg | Easter egg |
| 21 | com.nbosp.service.tray | Tray UI (§9.6) |
| 22 | com.nbosp.service.screenshots | PrintScreen shortcuts capture |
| 23 | com.nbosp.service.session | SessionManager (login/logout/per-account mounts) |
| 24 | com.nbosp.service.lock-screen | Lock screen/login picker |
| 25 | com.nbosp.service.debug-overlay | F3 dev HUD (devMode-gated inside `enable()`) |
| 26 | com.nbosp.service.system-events | Shell wiring: notif panel, global keyboard shortcuts, resize, email bootstrap |

(`NBOSP/js/apps/system-service-manifest.json:1-107`.) None of the service manifests declare `permissions` — they run unrestricted in the OS page by construction; dependencies are implicit via load order only (`NBOSP/js/core/services/system-service-loader.js:152-173,194-210`). 26 of the entries in `novaapp-manifest.json` carry `systemService: true` (verified in tree; the background audit counted 26 of 49 entries, the current manifest has 55 entries).

### 9.3 AppScheduler (`NBOSP/js/platform/security/app-scheduler.js`)

- Sweep every 15 min (`WAKE_INTERVAL_MS`, Android WorkManager parity floor), **no jitter**; eligibility = installed ∧ not disabled (HKNU/apps/disabled) ∧ `system:background` granted — mirrors the boot autostart tri-check; missing AppPermissionManager ⇒ fail-closed (no apps eligible, warn once) (`:36-58,129-154`).
- Wake cycle: piggyback a live Tier-2 sandbox if present (never kill it — "Tier 1 doesn't get to kill a Tier-2 process"); else launch a fresh headless sandbox into a 1×1 px hidden wrapper; `dispatchBackgroundWake(sandboxId, {wokeAt, deadlineMs})`; dedupe guard; deadline teardown only if scheduler-owned; per-app try/catch so one bad app can't cost others their wake (`:176-261,298-317`).
- Protocol: host push `nova:background:wake` → app `nova:background:wake-done` (advisory MAC row — the scheduler already verified the grant; the handler only flips a flag) (`app-sandbox.js:2861-2875,633`). `requestWake(appId)` for push delivery re-checks eligibility and returns an honest boolean (`app-scheduler.js:319-354`).
- Module is stateless by design — "a browser refresh naturally clears all of it, which is correct" (`:33-36`).

### 9.4 background-apps service (Clock + Email poller)

`NBOSP/js/apps/background-apps/service.js` runs two singletons on `window.__NBOSP_BG` ("Keeps clock alarms and email notifications active while their apps are closed"):

- **Clock**: 250 ms interval ticking `timerMs()` + `alarmTick()`; state via NovaAppConfig (HKNA/com.nbosp.clock/state) with localStorage fallback; alarms at HKNA/com.nbosp.clock/alarms; top-of-minute guard (fires only when `getSeconds()===0 && ms<=1400`), per-minute dedupe, 3-note chime, `Notify.show({category:'alarm', appId:'com.nbosp.clock'})`, one-shot auto-disable (`service.js:47-324`).
- **Email**: per-account `setInterval` pollers (interval = `acct.syncInterval` minutes); `syncAccount` POSTs credentials to `/api/email/connect` then reads INBOX and notifies on unread growth (`service.js:327-483`) — see §12.2 for the plaintext-credentials observation.
- Host-only `nova:clock:*` handlers are backed by this service (14 channels; poll 20×50 ms else throw 'Clock background service unavailable') (`app-sandbox.js:4375-4382`).

Named alarms (`system:schedule`): 32/app, ≥15 min period, name ≤64 (`^[\w.:\-]+$`), ≤1 yr horizon, undelivered queue 8; persisted at `HKNS/apps/alarms` and rebuilt at module load (periodic skip forward, missed one-shots queued); **alarms never wake a closed app** — they fire into a live sandbox or flush after the next `nova:ready` (`app-sandbox.js:7891-8177`).

### 9.5 Notifications service (`NBOSP/js/apps/notifications/service.js`)

Channel model (Android-style v2): 32 channels/app, importance locked at creation (`none` reachable only by user mute), user overrides per `appId|channelId`, persisted in `HKNU/shell/notifications/*` (`:21-144,433-449`). Host-side gates: `device:notifications` for every channel; new posts 10/min/app, tag updates 60/min; title/body/label 120/500/40; 3 actions/notification with pull-queue delivery (`nova:notifications:consumeActions`, 20 pending/app); 100 stored / 50 rendered; icon allowlist validated "before it ever reaches innerHTML"; function-typed actions dropped outright ("coercion here is exactly how a sandbox escape would sneak through") (`app-sandbox.js:1040-1074,1453-1489,2700-2860`; `notifications/service.js:26-35,572`). Pinned background-app entries sort first, survive clearAll and the 100-cap, removable only via `unpin(pinId)` (`notifications/service.js:404-411,599-614,637-696`).

### 9.6 Tray, EventLog, workers

- Tray is **first-party only — there is no app-facing tray API**; the service hardcodes WiFi/volume/calendar/battery/power widgets and exposes only `window.TrayService = {applyVolumeToWebviews}`. The app-facing analogue is the taskbar badge (`system:badge`): count 0–999 or text ≤4 chars, 30 updates/min, session-only (`NBOSP/js/apps/tray/service.js:413`; `app-sandbox.js:7516-7596`).
- EventLog: in-OS structured ring (500 entries, localStorage `novaOS_eventlog`), 9-category allowlist; `patchConsole()` wraps console globally — any app can flood it (see §12) (`NBOSP/js/apps/event-log/service.js:26-155`). Server events arrive via `server-events-bridge` (SSE → `EventLog.ingestRemote`, reconnect 1 s→30 s) (`NBOSP/js/apps/server-events-bridge/service.js:16-75`).
- Workers: three inline-blob workers (FS over IndexedDB `NovaByte_FS` v2 with owner scoping and `__shared__` drop box; SEARCH term index; CRYPTO PBKDF2 100k/SHA-256) (`NBOSP/js/core/services/workers.js:3-324`).

---

## 10. The Linux OS image

### 10.1 Build and boot chain

| Stage | Detail | Ref |
|---|---|---|
| Build | Buildroot **2026.08.1** external tree (`NBOSP/os/`), kernel **Linux 7.3.4** x86_64 (stock defconfig + `linux.fragment`), `grub-mkrescue` BIOS+EFI hybrid ISO | `NBOSP/os/build-iso.sh:5`; `NBOSP/os/configs/nbosp_x86_64_defconfig:104` |
| ISO layout | `boot/vmlinuz`, `boot/initrd` (=rootfs.cpio.gz), `boot/grub/grub.cfg` (4 live entries, timeout 5, **no GRUB password**; variants add `NBOSP_GL_DEBUG` / `nbosp.recovery=1`), plus `nbosp/rootfs.tar.gz` for the installer | `NBOSP/os/board/nbosp/post-image.sh:20-27`; `NBOSP/os/board/nbosp/grub.cfg:1-22` |
| Init | BusyBox: `inittab` → `rcS` runs `S[0-9][0-9]*` in glob order — S01mounts (proc/sysfs/devpts; `/tmp`,`/dev/shm` tmpfs 1777 nosuid nodev) → S10vmtoolsd → S11vmware-fuse → S40bluetoothd/S45NetworkManager/S50polkitd → S41network (resolv seed 1.1.1.1/8.8.8.8, udhcpc fallback) → **S99nbosp** | `NBOSP/os/board/nbosp/rootfs-overlay/etc/inittab:1-5`; `.../init.d/rcS:6-9`; `.../S01mounts:13-23`; `.../S41network:19-52` |
| Kiosk session | S99nbosp (root): recovery intercept (request file or `nbosp.recovery=1` ⇒ nbosp-recovery on VT1); waits ≤30 s for seatd + DRM (vmwgfx-bound card required); seeds Chromium prefs; writes session scripts; `su nbosp` runs labwc (zero compositor keybinds) → NW.js as an **X11 client through XWayland** with fresh D-Bus, output mirrored to ttyS0; restart loop max 5 | `NBOSP/os/board/nbosp/S99nbosp:64-76,255-261,281-332,406-441`; `rootfs-overlay/etc/labwc/rc.xml:31-53` |
| Users | Single kiosk account `nbosp` UID/GID 1000, password locked (`!`), groups video,input,seat,render,nbosp-wayland (GID 62001 — a dangling leftover of the removed per-app design) | `NBOSP/os/board/nbosp/users.table:1-3` |

### 10.2 Kiosk prep (`NBOSP/os/package/nbosp-kiosk/prepare-kiosk.mjs`)

Validates the built NW.js bundle, deletes every non-linux-x64 `.node` prebuild, **replaces** (does not merge) `manifest.window` (frame:false, fullscreen:true, kiosk:true) and rewrites `chromium-args` wholesale: adds `--no-first-run --disable-devtools --allow-insecure-localhost --class=com.novabyte.os --ozone-platform=x11 --use-gl=angle --use-angle=gl --disable-features=Vulkan,Translate,AutofillServerCommunication --deny-permission-prompts --password-store=basic --user-data-dir=/home/nbosp/.config/novabyte` etc. — no remote-debugging port, no `--disable-web-security` (`prepare-kiosk.mjs:18-63`). The dev `NBOSP/package.json` by contrast ships `--remote-debugging-port=9222 --auto-open-devtools-for-tabs --disable-web-security --allow-file-access-from-files` and `"dev_tools": true` (`NBOSP/package.json:26-31`) — see §12.

### 10.3 What isolation exists TODAY (explicit status)

**There is no per-app Linux UID isolation, no seccomp, no cgroups, no firewall, no SELinux in this image.** All per-app isolation is JS-level inside the NW.js process (`NBOSP/os/README.md:5-12`: "The newer per-app Linux UID supervisor, process launcher, and associated seccomp, cgroup, and firewall isolation are not part of this image"). Evidence:

| Mechanism | Status | Ref |
|---|---|---|
| per-app launch wrapper (`nwjs-per-app`) | Absent | `NBOSP/os/README.md:8-10` |
| seccomp / prctl / bpf | 0 hits in `NBOSP/os` | `NBOSP/os/README.md:9` |
| cgroup limits | none | grep 0 hits |
| Network egress restriction | **Kernel excludes netfilter entirely** (asserted absent: `SELINUX\|AUDIT\|NETFILTER\|IP_NF\|IP6_NF`) | `NBOSP/os/package/nbosp-kiosk/test-labwc-kiosk.mjs:124-136` |
| SELinux / LSM | removed (build actively cleans cached Weston/refpolicy output); kernel runs with default (no) LSM | `NBOSP/os/build-iso.sh:66-70` |
| /proc masking, noexec tmpfs | none (plain proc; tmpfs hardening is nosuid/nodev only) | `.../S01mounts:14-19` |
| Chromium sandbox | production session does not pass `--no-sandbox` (CI smoke test does, under Xvfb); relies on unprivileged user namespaces from the stock defconfig — unpinned/implicit | `test-nw-node.mjs:75` vs `S99nbosp:413` |

The word "newer" in `os/README.md:8` ("The newer per-app Linux UID supervisor …") is accurate: git history confirms the isolation stack was described in the README at `99a6c44` (2026-10-25) and removed at `2d24c6e` (2026-10-28). Whether the supervisor code was complete before removal is not established — only README and config evidence survives.

The kernel-route rationale is documented on the JS side: "The 'logical UID' layer. Kernel per-app UIDs don't fit this architecture (single browser process, single-user OS, webview renderers can't carry distinct kernel identities)" (`app-sandbox.js:234-237`). Privilege boundary kiosk-user → root: (a) setuid helpers `nbosp-power` (restart/poweroff only) and `nbosp-install`; (b) blanket sudoers `nbosp ALL=(ALL) NOPASSWD: ALL` backing NovaRoot (`NBOSP/os/board/nbosp/rootfs-overlay/etc/sudoers.d/nbosp:1`; enforced at build and pinned by `NBOSP/tests/system/os-kiosk-config.test.js:40-76`).

### 10.4 Installer and recovery

- `nbosp-install` (setuid 4755): argv device-name whitelist + typed `ERASE:<device>` confirmation + fixed environment before exec'ing the root script; root script refuses mounted disks, verifies rootfs size/gzip/tar integrity (**no signature/hash verification**), GPT-partitions (BIOS boot + EFI + ext4 root, no swap, no LUKS), installs **unsigned** GRUB (Secure Boot must be disabled), removes the installer app from the installed system (`NBOSP/os/package/nbosp-install/nbosp-install.c:22-85`; `nbosp-install-system:45-196`).
- `nbosp-recovery` (root, VT1, reachable unauthenticated via GRUB): continue / safe mode / clear caches / reset settings / backup `/home/nbosp` / restore (tar-list path filter, root `tar -xzf -C /`) / fsck / logs / **option 9 root shell** / `f` factory reset (`find /home/nbosp -mindepth 1 -maxdepth 1 -exec rm -rf {} \;`) / restart/poweroff (`NBOSP/os/board/nbosp/nbosp-recovery:54-57,195-204,272-277,286`).
- Desktop-side factory reset: `NBOSP/js/core/services/factory-reset.js` wipes `/home/nbosp` (symlink/realpath-guarded) and keeps `/opt/nbosp` — but Settings calls a nonexistent `window.performFactoryReset()` (§12) (`factory-reset.js:4-59`; `NBOSP/js/apps/settings/app.js:1613-1627`).
- CI: `workflow_dispatch` only, checks out **`ref: gl-debug`**, runs `node build.mjs linux`, prepare-kiosk, Xvfb NW.js+better-sqlite3 smoke test, then `build-iso.sh` (~200 assertions: sudoers modes/rules in tar and cpio, setuid bits, kernel options, udev rules, fonts/GRUB modules) (`.github/workflows/nbosp-os-iso.yml:17,43-93`).

### 10.5 Live ISO vs installed disk

| | Live ISO | Installed |
|---|---|---|
| rootfs | initramfs (in-memory, ephemeral — user data lost at shutdown) | ext4, rw, persistent `/home/nbosp` |
| kernel root | none (initrd) | `root=PARTUUID=… rootwait rw` |
| bootloader | grub-mkrescue hybrid (BIOS+EFI) | GRUB i386-pc + EFI removable fallback, unsigned |
| installer app | present | removed from `/opt/nbosp/package.nw` + manifest |
| recovery | GRUB entry `nbosp.recovery=1` | GRUB entry + request file (same S99nbosp path) |
| disk layout | n/a | GPT: BIOS-boot 1 MiB / EFI 512 MiB / ext4 root; no swap, no LUKS |

(`NBOSP/os/package/nbosp-install/nbosp-install-system:111-196`; `NBOSP/os/README.md:81-103`.) No migration from a live session to an installed system (`NBOSP/os/README.md:101-103`); factory reset wipes only `/home/nbosp`, preserves `/opt/nbosp` (`NBOSP/os/README.md:113-117`).

Kernel fragment highlights (`NBOSP/os/board/nbosp/linux.fragment`, 83 lines): stock `x86_64` defconfig base + initramfs/DEVTMPFS/TMPFS, DRM + **VMWGFX** (the kiosk aborts unless a vmwgfx-bound DRM card exists), HDA audio, E1000/E1000E/VMXNET3 + full wireless/BT stack, FUSE, virtio, EXT4/ISO9660/GPT, EFI stub. **Namespaces/seccomp/cgroups are not pinned** — whatever stock defconfig yields; no `USER_NS` pinning despite the Chromium sandbox depending on it; explicitly absent (and asserted absent): `NETFILTER*`, `SELINUX`, `AUDIT`; no hardening fragment, no module signing/lockdown. `spec_rstack_overflow=safe-ret` on every cmdline (`linux.fragment:1-83`; `NBOSP/os/package/nbosp-kiosk/test-labwc-kiosk.mjs:124-136`; `NBOSP/os/board/nbosp/grub.cfg:5`).

---

## 11. Testing architecture

Two layers under `NBOSP/tests/`:

| Layer | Runner | How to run | Scope |
|---|---|---|---|
| Unit/behavior (vitest) | `vitest.config.js` (globals, node env, `setupFiles: ['tests/setup.js']`, include `tests/**/*.test.js`) | `npm test` → `npx vitest run --reporter=verbose` (`NBOSP/package.json` scripts) | platform/security, platform/core, apps, server, scripts, email, system (~100 files) |
| Integration (plain Node) | `tests/integration/run-all.js` spawns each `*.suite.js` sequentially, cwd=NBOSP root, exit-code based, PASS/FAIL summary | `npm run test:integration` → `node tests/integration/run-all.js` | 9 suites |

Integration suites (`NBOSP/tests/integration/`):

| Suite | Asserts |
|---|---|
| `guest-bridge.suite.js` (2311 lines, ~327 checks) | two-realm real guest runtime — real `injectCapabilityShim` + isolated-world transport + MessagePort handshake + real `handleAPICall`; pins the full `nova.*`/`novaOS.*` facade surface |
| `ipc-matrix.suite.js` (731 lines) | **every** `API_HANDLERS` entry × P0–P5: one-response-per-request (`DOUBLE_RESPONSE`/`NO_RESPONSE` sentinels), requestId echo, malformed-payload no-crash, guest-forbidden rejection, full permission matrix denied/granted parity, storage/notifications budgets, ipc register/invoke/broadcast abuse, net URL policy, events sensitivity tiers, concurrent burst rate limiting; mirrors the MAC seed table "row for row" |
| `mac-policy.suite.js` | NB-MAC: seed policy, grant-coupled enforcement, advisory passthrough, default-deny, permissive mode (audited not enforced), subject pinning (seapp_contexts analog), `verifyPolicy`/neverallow, audit ring/rate-limit/snapshot/cleanup; denial prefix "Blocked by system security policy" |
| `storage-ledger.suite.js` | budgets/clamps/accounting/audit/cleanup; 256 MB storage, 256 KB IPC payload, 16 MiB HTTP body; scoped roots `appdata:`/`shared:`/`media:`; uninstall wipes ledger |
| `real-use.suite.js` (1474 lines) | end-to-end lifecycle: fresh boot → install → first-run prompts; denial → re-prompt → rate-limit → reset; mid-session revocation + revoke-all; two apps via ipc (R1–R7) |
| `legacy-vfs-compat.suite.js` | `vfs:*` aliases (incl. the `vfs:metedata` typo) resolve to `nova:fs:*` with identical enforcement |
| `package-signature-encoding.suite.js` | signature encoding contract (base64url emit; base64url/base64/legacy hex accept; tamper fails closed) |
| `picker-contract.suite.js`, `recipe-box-compat.suite.js` | picker MIME/ext contracts; exact boot + IPC sequence of a real 2.1.0 app |

Harness (`NBOSP/tests/helpers/`): `env.js` (377 lines) shared integration harness running the **real** app-sandbox over fakes — `fake-idb.js` (memory IndexedDB keyed `[ownerUid,appId,key]` with cursor chains), `fake-fs.js` (contract-faithful in-memory FS), `guest.js` (two-realm guest runtime); `app-harness.js` loads window/service apps into real JSDOM with common stubs (AppDirs, `nova.ipc` recorder, nw, fetch 404) (`tests/helpers/env.js`; `tests/helpers/app-harness.js`). `tests/setup.js` stubs crypto/TextEncoder/storage/window/navigator/rAF/fetch for vitest (note: `crypto.subtle.digest` is *not* stubbed there; the data-portability test installs its own real sha256) (`NBOSP/tests/setup.js`).

Behavioral ground truth pinned by tests (selected): launch rate 30/min then `RATE_LIMITED`; per-value cap 5 MB (`STORAGE_FULL`); AppSecrets 64/app, 8 KB, 128-char keys; registry MAX_DEPTH 16 / value 256 KB / audit 500 / snapshots 3; sandbox-serve idle TTL 30 min; scheduler 15 min / 10 s; wallpaper presets ground truth; error-code vocabulary (`PERMISSION_DENIED`, `INVALID_ARGS`, `RATE_LIMITED`, `PROTECTED_LOCATION`, `POLICY_BLOCKED`, ...). No skipped/TODO tests anywhere; several tests pin documented source quirks as-is (`NBOSP/tests/` audit).

Known coverage gaps (from the test audit): `nova:auth:*` sandbox bridge channels are only generically probed (server equivalents covered in `auth-routes.test.js`); `nova:background:alarm` and `nova:fs:changed` push channels, bare umbrella channel forms, `nova:audit:eval`, and `nova:push:message`/`nova:share:inbound` channel strings lack dedicated tests (their facades are covered); no dedicated test for the `device:notifications` gate on `nova:notifications:show` beyond the generic matrix.

---

## 12. Known internals gaps & hardening backlog

Grouped from the audit notes. Severity tags are the auditors'. Every item keeps its citation.

### 12.1 Trust model & identity

| Item | Ref |
|---|---|
| CRITICAL — Test-key system signer collapses identity gates on default builds: the 'NovaByte System' anchor's private half ships in-repo; anyone with repo access can mint `verified:true, signer:'NovaByte System'` packages that pass `checkUnrestrictedApp` and even the Settings identity exemption. Mitigations (tier labeling, first-party manifest allowlist, integrity record) are all satisfiable by a test-key attacker | `NBOSP/js/platform/security/trust-store.js:102-137`; `unrestricted-gate.js:141-176`; `NBOSP/keys/test-system-key.json` |
| HIGH — Host-only handlers (`nova:system:permissions:set` = arbitrary permission grant; `nova:system:data:backup` = full localStorage dump) have no permission checks; their only barrier is the `GUEST_FORBIDDEN_IPC_APIS` dispatch rejection; a stale comment claims they are registered in `API_HANDLERS` (they are not) — removing/typoing one set entry exposes them | `app-sandbox.js:9313-9336,4852-4858,4875,4918` |
| HIGH — Settings/Permissions-app can silently grant any non-root permission for any app ("a real bypass of the normal consent flow"); the dialog flow is UX, not a security boundary, for anything the user can reach | `NBOSP/js/apps/settings/app.js:2219`; `NBOSP/js/apps/permissions/app.js:340-354` |
| MEDIUM — Machine policy `pin` force-grants permissions over user denials and is writable by any `registry.system` holder (one consented grant can pin arbitrary further permissions machine-wide) | `app-permission-manager.js:650-657`; `app-sandbox.js:3154-3159` |
| MEDIUM — Grants survive signature change / unverified reinstall under the same appId; core uninstall paths don't revoke grants (30-day sweep is the cleanup) | `NBOSP/js/platform/core/app-registry.js:278-284,601-613` |
| MEDIUM — `registry.system` ⇒ root chain: write `HKNS/system/devMode` + `HKNS/security/rootAccessEnabled`; the settings shim live-applies both with no extra gate | `app-sandbox.js:3154-3159`; `settings-shim.js:214-221`; `root-broker.js:155-169` |
| HIGH — Factory reset is dead code in the UI: Settings calls `window.performFactoryReset()` which exists nowhere; `NovaFactoryReset.performLinuxFactoryReset` has zero runtime callers | `NBOSP/js/apps/settings/app.js:1613-1627`; `NBOSP/js/core/services/factory-reset.js:44-59` |
| HIGH — Legacy "security wipe" (≥10 wrong PINs, single-user) only clears localStorage/sessionStorage; on linux-native all disk state (`~/users/*`, registry, `.local/share/novabyte`, nwjs-data) survives; the "All data has been wiped" notice is misleading | `NBOSP/js/apps/lock-screen/service.js:931-957` |
| HIGH — Legacy brute-force ladder is resettable: wrong-PIN counters are in-memory only and plain F5 is allowed ⇒ unlimited offline brute force of a 4–6 digit PIN (multi-user path is server-side and safe) | `lock-screen/service.js:206-254`; `NBOSP/ui-init.js:51-65` |
| MEDIUM — Legacy client-side biometric unlock verifies nothing (assertion presence only, no signature verification); multi-user WebAuthn does verify server-side | `lock-screen/service.js:415-435`; `NBOSP/js/apps/session/service.js:324-374` |

### 12.2 Sandbox escape surfaces & enforcement gaps

| Item | Ref |
|---|---|
| HIGH (bug) — `installRootApiAudit` returns inside the namespace loop, so only `window.OS` is ever instrumented; FS/WM/Notify/AppRegistry/AppPermissionManager/DefaultApps/Boot/Kernel root-call audit never happens | `app-sandbox.js:170-181` |
| MEDIUM — `confirmSharedFileChange` only prompts for `delete`/`overwrite`; callers pass `modify`/`rename`/`move`, which return true un-prompted — shared-file modify/rename/move of user-picked files never asks; the "User confirmation is required to modify a shared file" branches are unreachable | `app-sandbox.js:1875-1880,2438-2441` |
| MEDIUM (by design, flagged) — Unpermissioned surfaces: `nova:open-url`, `nova:share` (Copy action writes clipboard without `clipboard:write`), `nova:download` (no size cap; native save dialog is the control) | `app-sandbox.js:3792-3879,4057,4103` |
| MEDIUM — `nova:clipboard:read` falls back to `OS.clipboard` (last host-written value) when the async clipboard API fails — ambient channel with `clipboard:read` granted | `app-sandbox.js:3721-3729` |
| MEDIUM — Wallpaper keys bypass `system:settings` (Android parity); `customWallpaper` only string-checked (any URL) | `app-sandbox.js:2990-3037` |
| MEDIUM — `registry.read` grants near-global read (all hives but `HKNS/security`, incl. other apps' HKNA and all HKNU); HKND readable without devMode; ACLs opt-in (no ACL ⇒ granted) | `app-sandbox.js:3095-3101`; `nova-registry.js:811-823` |
| MEDIUM — Terminal's Linux path is an un-gated real host shell (`spawn('/bin/sh')` inheriting `process.env`) — no devMode/devOnly/`system:root` gate; the inherited env hands over `NBOSP_SYSTEM_API_RATE_LIMIT_SECRET` (trusted-HMAC forgery) | `NBOSP/js/apps/terminal/app.js:1448-1454,1520-1524` |
| MEDIUM — devconsole = devMode-gated `eval()` with full OS-context privileges (can drive NovaRoot, AppSecrets, registry directly) | `NBOSP/js/apps/devconsole/app.js:11-15,259` |
| MEDIUM — `MyAppsManager.installFromFile/Url` skips the App Manager install gates (no Scanner sweep, no impersonation dialog); `installFromUrl` fetches arbitrary URLs host-side with no scheme/credential check | `NBOSP/js/platform/ui/my-apps-manager.js:209-271,249-256` |

> **Unverified:** whether any product surface actually invokes `MyAppsManager.showInstallUI` — the audit found no in-repo caller shipping that UI (`my-apps-manager.js:283-384`).

| Item | Ref |
|---|---|
| MEDIUM — FrameSecurity observer is effectively audit-only (detect+EventLog, no auto-fix) in production: `_autoSecurify=true` initializer vs `startObserver({autoSecurify=false})` default; nothing passes `true`; also iframe-posture only, not webviews | `NBOSP/js/platform/security/frame-security.js:467,610,695-704` |
| LOW — TOCTOU between ownership checks and awaited FS mutations (write/move/delete) — node-id anchoring limits exposure | `app-sandbox.js:2465-2479,2693-2697` |
| LOW — Metadata enumeration: any single media grant or `fs:metadata` can enumerate shared-tree folder structure (folders always pass `resolveFile`) | `app-sandbox.js:2336-2357,2542-2552` |
| LOW — UI spoof surface: app-defined context menus at unclamped host-screen coordinates; overlay iframes are DOMPurify+CSP'd (no scripts) but context menu/overlay both render above app content | `app-sandbox.js:3375,3394,3414-3471` |
| LOW — Root-caller identification is stack-string matching (`novaapp:<appId>/`), spoofable by already-root apps; audit-integrity issue only | `app-sandbox.js:108-114`; `root-broker.js:117-153` |
| LOW — Ledger/audit stores are plain localStorage (unencrypted, tamperable by host-realm code); NovaRoot audit log itself is same-origin and root apps may alter it | `app-sandbox.js:249-251`; `NBOSP/js/apps/settings/app.js:3073-3078` |
| LOW — Registry audit ring stores plaintext value previews (≤200 chars) for every write | `nova-registry.js:638-673` |
| LOW — AppSecrets master key sits next to the ciphertext (same dir, 0600 both); `root/app-secrets.json` is committed to the repo despite a comment claiming root/ is untracked | `app-secrets.js:46-48,99-138`; `NBOSP/root/app-secrets.json` |
| LOW — App-id alias table is an implicit cross-app data-sharing trust boundary (`appDataSegment` canonicalization) | `app-sandbox.js:1438-1444` |
| LOW — Boot flags dual-write to localStorage (`nova_safe_mode` etc.) — same-origin code can force safe-mode/recovery boots (DoS-of-self) | `NBOSP/js/platform/core/registry-boot-state.js:28-30,145-160` |
| LOW — EventLog console capture is an unpermissioned, unbounded-rate disk-write channel (500-entry ring, persist per entry) | `NBOSP/js/apps/event-log/service.js:81,122-155` |
| LOW — `init.js` secret-write guard is name-based and bypassable by capturing the original localStorage reference; `lockPin` (PBKDF2 hash) doesn't match the regex | `NBOSP/js/core/core/init.js:78-89`; `NBOSP/js/core/core/kernel.js:112-120` |
| LOW — No CPU/memory budget anywhere in background execution (Tier-1 is time-bounded; Tier-2 and system services are not); fixed 15-min sweep with zero jitter; Tier-1 wake push can race page load with no re-delivery | `NBOSP/js/platform/security/app-scheduler.js:46,197-203,363`; `app-sandbox.js:14529-14573` |
| LOW — background-apps email poller stores IMAP credentials in a localStorage/registry-backed store (`nbosp_email_accts_v2`) and POSTs user/pass to `/api/email/connect` on every sync — plaintext credentials on each poll, in contrast to the AES-GCM app-secrets store that exists for exactly this | `NBOSP/js/apps/background-apps/service.js:338-359,375-385` |

### 12.3 Local server issues

| Item | Ref |
|---|---|
| CRITICAL (dev posture) — Dev `package.json` ships `--disable-web-security --allow-file-access-from-files --remote-debugging-port=9222` + `node-remote https://localhost:*`; CDP on 9222 is a full-takeover channel for any local process; kiosk build strips these, but any non-kiosk run is exposed | `NBOSP/package.json:26-32`; `NBOSP/os/package/nbosp-kiosk/prepare-kiosk.mjs:35-62` |
| MEDIUM — F12/Ctrl+Shift+I unconditionally opens DevTools on the Node host page (no devMode gate; only kiosk `--disable-devtools` neutralizes it) | `NBOSP/ui-init.js:58-61` |
| HIGH — Unauthenticated SSE log mirror: `GET /api/events/stream` replays the full 500-entry ServerEventLog (email usernames/hosts, blocked proxy hostnames, client IPs/UAs) to any local client | `NBOSP/server/core/events-routes.js:9-29`; `NBOSP/email/controller.js:172-177` |
| MEDIUM — Push publish vs CSRF contradiction: designed untrusted/token-authenticated, but not CSRF-exempt — external backends get 403 in the real chain; tests never exercise it through the CSRF middleware | `NBOSP/server/core/push-routes.js:91-130`; `NBOSP/security/middleware.js:39-59` |
| MEDIUM — Input "sanitization" HTML-escapes every request body except three prefixes — email passwords/passphrases with `&<>"'` are silently mutated (auth-breaker for real IMAP/SMTP creds) | `NBOSP/security/middleware.js:336-401` |
| MEDIUM — Non-admin audit scoping is a no-op on Express 5 (`req.query.userId = ...` assignment is inert) ⇒ non-admin sessions receive the entire ring via `GET /api/security/audit` | `NBOSP/security/routes.js:316-327,364` |
| MEDIUM — `PUT /api/security/settings` allowlist never applies (`_meta.editable` never set ⇒ empty allowlist ⇒ arbitrary-key merge into security settings); admin-only | `NBOSP/security/routes.js:694-734` |
| MEDIUM — Legacy hard-coded `sessions.db` path ignores `NBOSP_DATA_DIR` — sessions list/revoke read the wrong DB with a custom data dir | `NBOSP/security/routes.js:223` |
| MEDIUM — First-boot takeover window: `/api/auth/setup` and `/api/auth/migrate-legacy` are unauthenticated+CSRF-exempt while users.db is empty; migrate-legacy installs an attacker-chosen legacy pin hash as owner (loopback-only unless `HOST` overridden) | `NBOSP/server/security/auth-routes.js:247-303` |
| MEDIUM — Sessions persist across restarts + bearer sids: the raw sessionId is a CORS-allowed bearer header equivalent to the cookie; no server-side short-lived cap or rotation on privilege change (regenerate only at login) | `NBOSP/server/middleware.js:337-362`; `auth-routes.js:115-119` |
| LOW — Global limiter is per-IP on an all-localhost server (one 100/15-min bucket for all unsigned local traffic; trusted-HMAC requests bypass all limiters); non-`/api` paths unrated; `csrfTokenMiddleware` force-saves a session per request (storage growth) | `NBOSP/server/middleware.js:239-249,59-82`; `NBOSP/security/middleware.js:308-331` |
| LOW — Main-page CSP allows `unsafe-eval`+`unsafe-inline` and open `connect-src`/`frame-src` (the app-serve surface is stricter than the shell); `POST /api/security/report` feeds client-supplied IPs into the blocklist; WebAuthn verification skips rpIdHash/UV/UP checks and trusts client-supplied keys (attestation `none`); two env validators disagree on secret minimums; `/api/events` router mounted twice (dead second mount) | `NBOSP/server/middleware.js:122-137`; `NBOSP/security/routes.js:568-578`; `auth-routes.js:711-717`; `NBOSP/scripts/env.js:98-105` vs `NBOSP/server/core/env.js:9-36` |

### 12.4 OS image issues

| Item | Ref |
|---|---|
| CRITICAL — Full passwordless root for the kiosk user (`nbosp ALL=(ALL) NOPASSWD: ALL`) deliberately wired to NovaRoot; any NW.js/renderer compromise = trivial root; the narrow setuid helpers are not the real boundary; build enforces the rule's presence and tests pin it | `NBOSP/os/board/nbosp/rootfs-overlay/etc/sudoers.d/nbosp:1`; `NBOSP/os/build-iso.sh:306-330`; `NBOSP/tests/system/os-kiosk-config.test.js:55` |
| CRITICAL — Unauthenticated root consoles: tty2 getty with Buildroot default empty root password (no `BR2_TARGET_GENERIC_ROOT_PASSWD` / root-login disable anywhere), and recovery menu option 9 = root shell, reachable from the passwordless GRUB menu (no SSH daemon shipped mitigates remote only) | `NBOSP/os/board/nbosp/rootfs-overlay/etc/inittab:4`; `NBOSP/os/board/nbosp/nbosp-recovery:272-277`; `NBOSP/os/configs/nbosp_x86_64_defconfig` |
| HIGH (documented) — No per-app kernel isolation at all: one NW.js process tree as UID 1000 for OS + every `.novaapp`; no seccomp/cgroup/uid/firewall layer (see §10.3); `nbosp-wayland` GID is a dangling leftover | `NBOSP/os/README.md:5-12,269-271` |
| MEDIUM — Unrestricted network egress, no firewall even possible (kernel asserts no NETFILTER); public DNS fallbacks baked into resolv seed and both NM profiles | `NBOSP/os/package/nbosp-kiosk/test-labwc-kiosk.mjs:132`; `.../S41network:28` |
| MEDIUM — `/opt/nbosp` chowned to the kiosk user at boot (`chown nbosp:nbosp /opt/nbosp` — "prepare writable runtime state") — the root-installed bundle directory is user-writable, invalidating the "root-owned bundle" claim for the directory itself | `NBOSP/os/board/nbosp/S99nbosp:362` |
| MEDIUM — Device nodes owned by the kiosk user (udev rules: renderD*/sound OWNER=nbosp; `video` group membership gives direct `/dev/dri/card*`), bypassing seatd arbitration for card nodes | `.../udev/rules.d/70-nbosp-device-groups.rules:1-3` |
| MEDIUM — Installer has no authenticity check (gzip CRC + tar listing only); GRUB unsigned (Secure Boot must be disabled); installed root unencrypted ext4, `rw`, no LUKS | `NBOSP/os/package/nbosp-install/nbosp-install-system:102-109,193-196` |
| MEDIUM — Recovery restore: root `tar -xzf -C /` from arbitrary user-supplied media; the path filter blocks non-`home/nbosp` and `..` entries but a symlink-following archive may attempt escape | `NBOSP/os/board/nbosp/nbosp-recovery:195-208` |

> **Unverified:** the tar symlink-escape in recovery restore is medium-confidence and busybox-tar behavior dependent (`NBOSP/os/board/nbosp/nbosp-recovery:195-208`).

| Item | Ref |
|---|---|
| LOW — Crash-loop DoS: 5 restarts then the kiosk sits dead on VT1 with the root debug console available; the "boot watchdog → recovery" routing is mentioned but not implemented in S99nbosp itself | `NBOSP/os/board/nbosp/S99nbosp:61-62,438-441` |
| LOW — Info disclosure to serial console (kiosk + GL debug output incl. `/proc/<pid>/environ` dumps mirrored to ttyS0) — fine for a VMware dev kiosk, unwise for production hardware | `NBOSP/os/board/nbosp/S99nbosp:145-146,249` |
| LOW — CI builds the ISO from the `gl-debug` branch (not main) and force-pushes a commit to it | `.github/workflows/nbosp-os-iso.yml:17,43-72` |
| LOW — Duplicate wired NM profiles (overlay + package, both autoconnect-priority 100); GL debug tooling (strace, mesa-demos, wayland-utils) shipped in the production image | `NBOSP/os/README.md`; `nbosp_x86_64_defconfig:69-71` |

---

## 13. Glossary of internal terms

| Term | Meaning |
|---|---|
| **AppSandbox** | The sandbox engine module, `NBOSP/js/platform/security/app-sandbox.js`, exported as `window.AppSandbox` (plus a CommonJS export for Node test runners). There is **no `NovaAppSandbox` symbol anywhere** — older docs that say "NovaAppSandbox" mean this module (`app-sandbox.js:12-13,14880-14895`). |
| **OS host page / trusted host** | The NW.js renderer running `NBOSP/index.html`; has Node access; injects system services, the bundled launcher, and unrestricted host apps. |
| **Guest / isolated world / main world** | A sandboxed app page. The *isolated world* is the content-script realm owning `__novaInbox`/`__novaOutboxPull` and the MessagePort; the *main world* is the app's own JS with the capability shim (`window.nova`/`window.novaOS`). |
| **Bridge markers** | `IPC_MARKER = '__NOVA_IPC__:'` (guest→host console channel) and `BRIDGE_MARKER = '__NOVA_BRIDGE__'` (one-shot MessagePort handshake; possession of the port is the credential) (`app-sandbox.js:9693,10029`). |
| **Execution tiers** | sandboxed `<webview>` (default) → unrestricted host tier (`system-bundle` system apps, via `UnrestrictedGate`) → root tier (`system:root` grant + devMode + rootAccessEnabled, audited, sudo-backed). |
| **NB-MAC** | The JS-side mandatory-access-control engine in `app-sandbox.js:470-1032` (domains, `endpointGrants`, advisory rows/families, neverallow, avc audit ring, permissive mode). |
| **MAC domains** | `untrusted_app` (enforcing, default for every sandboxed app) and `platform_module` (permissive); appIds can be pinned to domains via the `subjects` map (seapp_contexts analog). |
| **Grant-coupled vs advisory rows** | MAC `endpointGrants` values: a string array = enforced ANY-of at the front door; `null` = advisory (handler-level checks are the boundary). |
| **`GUEST_FORBIDDEN_IPC_APIS`** | Host-only channel set rejected at dispatch (`PERMISSION_DENIED / 'This system capability is only available through trusted OS UI'`) — Settings/Clock/auth machinery (`app-sandbox.js:9317-9336`). |
| **HKNS / HKNU / HKNA / HKND** | Registry hives: NovaSystem (machine), NovaUser (per-account), NovaApps (`HKNA/<appId>/`), NovaDev (dev scratch). HKCU is an alias for HKNU. |
| **system-bundle** | The `source` provenance value only boot reconciliation can mint for bundled system `.novaapp` packages; required (with the System-signer triple) by the unrestricted gate. |
| **System-signer triple** | `verified===true && signer==='NovaByte System' && manifest.system===true` — what makes `config.system`/trust metadata authoritative; raw `manifest.system` alone is never trusted. |
| **test-keys / release-keys** | `TrustStore.systemSignatureTier()` labels (AOSP `ro.build.tags` analogue): the default committed test system key vs a release JWK injected via `NBOSP_SYSTEM_SIGNING_PUBLIC_JWK`. |
| **StorageLedger** | The per-app budgets/accounting layer ("logical UID") in `app-sandbox.js:233-468` — 256 MB storage / 256 KB IPC / 16 MiB HTTP / 60 s defaults; explicitly "best-effort telemetry, NOT security boundaries". |
| **Webview partition** | The Chromium storage partition per app: `persist:app_<id>` (or `persist:u<uid>_app_<id>` multi-user; `guest_app_<id>` volatile); wiped fail-closed by `clearAppPartition`. |
| **Stable serve alias** | `/api/apps/serve/sandbox_<appId>` — relaunch-stable serving URL (alias-eligible appIds only) enabling pre-registered OAuth/redirect callbacks (`app-sandbox.js:1113-1135`). |
| **Headless system service** | First-party `.novaapp` with `system:true && systemService:true`, injected as a script into the host page by SystemServiceLoader before `boot()` (26 in `system-service-manifest.json`). |
| **Tier 1 / 2 / 3 (background)** | `system:background` scheduled wakes (15 min sweep, 10 s deadline) / `system:background:live` stay-alive / `system:autostart` boot launch. |
| **Shell Bags** | Per-app-id window geometry memory restored by WM at launch (`NBOSP/js/apps/shell-ui/wm.js:124-135`). |
| **`__shared__`** | Synthetic ownerUid for the machine-wide `/Shared` drop box; visible to all non-guest accounts, creator-stamped sidecar for write rules (`NBOSP/js/core/services/workers.js:80-116`; `NBOSP/js/core/services/fs.js:94-131`). |
| **NovaRoot** | `window.NovaRoot`, the root broker: consent modal + `sudo -n -- <argv>` + EventLog audit; host-page only. |
| **NBOSP** | The product tree (`novabyte-os/NBOSP/`) — server/, js/, os/, scripts/, tests/, and the NW.js app all live under it; the terms "NBOSP" and "the OS" are used interchangeably in sources. |
