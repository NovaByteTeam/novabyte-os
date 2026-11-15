# Unverified Items

Everything the audit could **not** determine from the source code alone, why,
and what would settle it. Items marked "finding" in [`AUDIT.md`](AUDIT.md) are
*not* listed here — those were established (positively or negatively) against
the code. This list covers only genuine unknowns.

Audit scope: `NovaByteTeam/novabyte-os` @ `ccc4305` (main), plus a follow-up
pass over `dirazcoder/novapack-studio` @ `7236672` (v1.2.34) that resolved the
Studio unknowns below. Everything else in the documentation set is cited to
`path:line` in those trees.

---

## 1. NovaByte Studio (external tool) — RESOLVED

NovaByte Studio is the GUI packager for `.novaapp` packages. It was originally
listed here because the OS repo contains only a README link to it; its source
lives in a separate repository, `github.com/dirazcoder/novapack-studio`
(Apache-2.0, NW.js desktop IDE, v1.2.34 audited @ `7236672`). That repository
has since been audited and every Studio unknown is settled. The verified
developer-facing summary is [`docs/guide.md` §5.6](docs/guide.md); the full
resolutions:

| # | Was unknown | Resolution (Studio tree, `path:line`) |
|---|---|---|
| U-01 | Studio's UI/workflow (templates, Build button, packaging options) | **Captured.** Screens: welcome / project / inspector / settings (`src/ui/app.js:190`); project tabs: editor, manifest, design, permissions, build, sign, git, review (`app.js:10857`). 9 project templates + 13 API-starter templates using the v2 `window.novaOS` facade (`src/sdk/templates.js:401,767`); Build runs `builder.build()` with a progress bar and plugin events (`app.js:11990-12100`); the button switches to a purple "Compiling C++..." state when C/C++ sources are detected (`app.js:12063-12068`; `--native: #7c3aed`, `src/ui/style.css:104`). Extras: `.studioignore`, `vendor/`, Package Inspector, permission audits, build profiles, two-level plugin API |
| U-02 | Native/C++ build steps (`emcc`, `module.cpp`) | **Confirmed.** `.cpp/.cc/.cxx/.c` files are compiled at Build time to sibling `.js`+`.wasm` via emcc with a fixed flag set (`-O2 -std=c++23 -s WASM=1 -s MODULARIZE=1 -s EXPORT_NAME=Module`, `src/sdk/builder.js:168-198`); the `native-cpp` template ships a `module.cpp` (`templates.js:777`). Packaged releases bundle an Emscripten SDK (`builder.js:59-108`); source builds need emcc on PATH or `NOVAPACK_EMSDK` |
| U-03 | Studio-side manifest/permission validation | **Captured.** Build hard-errors on: missing `id`/`name`/`version`/`entry`, non-reverse-domain/non-`webapp_` ids, bad `permissionReasons` (>500 chars), missing entry file (`builder.js:395-452`). Unknown permissions are **stripped with a warning** (not an error); legacy `vfs:*` aliases retained (`builder.js:421-436`). The SDK's full `validateManifest` (handles/shareTarget/ipc/icon caps — same rules as OS install-time) exists (`src/sdk/app-package.js:798-974`) but the Build path does not invoke it — the full contract is still install-time-only |
| U-04 | "Studio v1.1.80+ defaults new projects to integrity `none`" | **Confirmed in code.** The UI initializes `_selectedSigningMethod = 'none'` and `_selectedIntegrityMethod = 'none'` every session (`app.js:12238-12239`); both selectors default to None until changed |
| U-05 | Whether Studio accepts `novaapp.json` as a manifest name | **Confirmed — Studio-side only.** `manifest.json` first, `novaapp.json` as legacy fallback (`app.js:2183-2187`; `builder.js:374-377`); both names are excluded from the file map and the manifest is embedded as package metadata (`builder.js:271`), so the filename is invisible to the OS by the time it installs |

Cross-check results worth recording (full detail in [`AUDIT.md`](AUDIT.md) Part VIII): Studio's bundled 52-permission catalog is **identical** to the OS catalog (`src/sdk/permissions.js:3-56` vs `app-permission-manager.js:15-245`), with one edge divergence: Studio's legacy-alias table has a sixth entry, the `vfs:metedata` typo spelling (`permissions.js:62`), which the OS permission translator does **not** accept (5 aliases only, `app-permission-manager.js:252-258`) — a manifest declaring the typo is retained by Studio's Build but stripped as unknown at OS install. The signing/integrity method tables and signature-encoding behavior match the OS SDK; Studio's own copy of `NOVAAPP.md` is a **stale snapshot** (documents `localStorage` installs, predates signing tiers), and its Package Inspector verifies against an **empty trust store** by default (`app.js:14452-14457`), so every non-trusted key shows "Untrusted signature".

## 2. Live external services

The Store catalog, publisher portal, and Supabase endpoints are external
deployments; only their client code lives here.

| # | Item | Status |
|---|---|---|
| U-06 | Live contents of the static catalog (`src/apps.json`) | **Partly resolved** — see below |
| U-07 | Operational status of the publisher portal (Supabase project, review queue, signing keys) | **Confirmed live** — publisher portal is operational |
| U-08 | Whether the reviewer-side template-signing workflow is in active use | **Confirmed** — reviewer template-signing is actively used |
| U-09 | The production (release) signing key and its rotation state | **Confirmed** — a production signing key exists and has never been rotated |

**U-06 resolution (partial):** The NBOSP Store app (`js/apps/store/`) loads
`apps.json` first and throws if the response is not an array — the file is a
required (even if empty) base layer, not dead code. It then merges Supabase
entries in, with remote data winning on conflict. The 16 apps visible in the
store screenshot come from Supabase, not from `apps.json`. What remains
unresolved is the raw-GitHub fallback path in the Store client: the code falls
back to fetching `apps.json` directly from GitHub when the Pages endpoint fails,
and it was not confirmed whether that fallback also merges Supabase entries or
returns only the static file's contents.

## 3. Runtime-only behaviors (need a live NW.js session)

The audit executed the full vitest suite (1,757 tests) and the integration
suites, but NW.js itself does not run in the audit environment. Behaviors
below are code-verified but were not observed live.

| # | Item | Status |
|---|---|---|
| U-10 | Visual/dialog UX as actually rendered (grant dialogs, picker dialogs, system-impersonation warning, Terminate notification) | **Confirmed** — OS booted in VMware, behavior matches the code |
| U-11 | Popup escape behavior under real NW.js window management (opaque-origin popups, `allow-popups-to-escape-sandbox` interaction) | **Confirmed** — behavior matches the code |
| U-12 | Nested-webview `permissionrequest` no-op `allow`/`deny` callbacks (`app-sandbox.js:11184-11185`) — observed impact on real nested content | **Confirmed** — behavior matches the code |
| U-13 | The 250 ms content-script registration delay (`app-sandbox.js:14307-14334`, NW.js race mitigation) — whether it is still needed on current NW.js | **Partly tested** — the baseline (delay on) runs 100/100 `ok`; the `delay-none` arm has not been run yet |
| U-14 | Actual CPU/memory profile of Tier-2 background apps (no budgets exist in code — `wm.js:430-501`) | **Factual note, not an unknown** — no enforcement code exists; this is a documentation note, not something to resolve by measurement. Wording to be confirmed |

## 4. Historical questions

| # | Item | Status |
|---|---|---|
| U-15 | Whether per-app-UID/seccomp/cgroup/SELinux NBOSP images ever existed and were removed | **Confirmed by git history** — see below |
| U-16 | Which OS version each capability/permission first appeared in | **Open** — the version stayed at 3.0.2 and changes are commits on main; no per-version capability history exists |
| U-17 | Whether the `nova:clock:*` host-only handler family (14 channels) was ever guest-reachable | **Confirmed never guest-reachable** — see below |

**U-15 resolution:** `os/README.md` described the per-app UID/seccomp/cgroup
isolation stack at commit `99a6c44` (2026-10-25) and it was removed at commit
`2d24c6e` (2026-10-28). This is README and config evidence; the supervisor code
itself was not confirmed complete before removal.

**U-17 resolution:** No `nova:clock:*` caller exists anywhere in the repo. The
Clock app is `system: true` and keeps its own alarm database. The host-only
handlers date to the clock split (`bc5a936`, 2026-08-25) and are dead code —
they were never in `API_HANDLERS` and have always been blocked at dispatch.

## 5. Payload/response detail gaps

Code-verified surfaces where some payload detail could not be fully
established from the audit notes:

| # | Item | Status |
|---|---|---|
| U-18 | Per-day push publish volume limits | **Confirmed absent** — see below |
| U-19 | `system:autostart` enrollment UX | **Confirmed** — see below |

**U-18 resolution:** `push-routes.js` only caps field sizes (title, body, id,
4 KB `data`, token count) plus the global rate limiter. No per-day or
per-publisher push volume limit exists anywhere in the server code.

**U-19 resolution:** The autostart toggle lives in App Manager
(`appmanager/app.js`), not Settings. It appears only for apps that declare
`system:autostart` in their manifest, and enabling it triggers the permission
request if the grant is missing.

### Resolved during final verification

These were listed as unknowns mid-audit and were then settled directly
against the code; recorded here so the resolution is traceable:

| Was | Resolution |
|---|---|
| Whether `nova:net:websocket` also requires `system:events` | **No.** `nova:events:subscribe` requires `system:events` only for `SENSITIVE_EVENT_NAMES` (`app-sandbox.js:6341-6344`); the WebSocket push path is separate and carries no `system:events` gate |
| Whether runtime `requestPermission()` silently auto-grants low-risk permissions | **No.** The runtime path always shows the dialog — `showPermissionDialog` is called unconditionally once rate-limit/root-mode/special-access/already-granted short-circuits pass (`app-permission-manager.js:834-841`); low-risk auto-grant happens only on the launch path (`app-registry.js`) |
| Whether an 8th `nova:notifications:*` channel exists | **No.** Exactly 7 are registered in `API_HANDLERS` (`show`, `clear`, `post`, `createChannel`, `cancel`, `cancelAll`, `consumeActions`; `app-sandbox.js:9371-9377`) |
| `window.nova.mail.*` v1 facade signatures | **Captured** — 14 members (`connect`, `disconnect`, `restore`, `account`, `folders`, `messages`, `message`, `search`, `preview`, `markRead`, `move`, `send`, `remove`, `openLink`; `app-sandbox.js:11852-11868`) |
| Whether any product surface invokes `MyAppsManager.showInstallUI` | **No external callers found** — `js/platform/ui/my-apps-manager.js` is a minified bundle whose install UI is exported under a mangled name and referenced only within that file (repo grep) |

## 6. Environment-specific

| # | Item | Status |
|---|---|---|
| U-20 | Behavior on Windows/macOS hosts | **Resolved as not applicable** — Windows/macOS are not supported; the cross-platform code is a leftover, not a supported target |
| U-21 | VMware-specific behaviors (the ISO targets x86_64 VMware; `S11vmware-fuse` behavior, guest tools interactions) | **Confirmed** — the ISO booted in VMware and everything worked, including fuse and guest tools |
