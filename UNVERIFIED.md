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

| # | Item | Why | What would settle it |
|---|---|---|---|
| U-06 | Live contents of the static catalog (`src/apps.json`) | The file in-tree was an empty array `[]` at audit time; the deployed GitHub Pages site may serve a different file | Fetching the deployed catalog URL |
| U-07 | Operational status of the publisher portal (Supabase project, review queue, signing keys) | Edge Function code exists (`supabase/functions/publisher-api/`) but the deployment, its secrets, and its data are not in the repo | Live portal access |
| U-08 | Whether the reviewer-side template-signing workflow is in active use | `supabase/README.md:181-188` describes local signing before upload; no evidence of usage | Maintainer confirmation |
| U-09 | The production (release) signing key and its rotation state | By design not in the repo; default builds run `test-keys` (`trust-store.js:96-137`) | Maintainer confirmation |

## 3. Runtime-only behaviors (need a live NW.js session)

The audit executed the full vitest suite (1,757 tests) and the integration
suites, but NW.js itself does not run in the audit environment. Behaviors
below are code-verified but were not observed live.

| # | Item | Why | What would settle it |
|---|---|---|---|
| U-10 | Visual/dialog UX as actually rendered (grant dialogs, picker dialogs, system-impersonation warning, Terminate notification) | Dialog construction is code-verified (text strings cited); rendering/ergonomics were not observed | Manual run of the OS (`NBOSP: npm start`) |
| U-11 | Popup escape behavior under real NW.js window management (opaque-origin popups, `allow-popups-to-escape-sandbox` interaction) | Code path verified (`app-sandbox.js:13583-13599`) and test-asserted; live behavior not observed | Manual run with a test app |
| U-12 | Nested-webview `permissionrequest` no-op `allow`/`deny` callbacks (`app-sandbox.js:11184-11185`) — observed impact on real nested content | Code-verified as no-ops; real-world effect depends on what nested pages request | Manual run |
| U-13 | The 250 ms content-script registration delay (`app-sandbox.js:14307-14334`, NW.js race mitigation) — whether it is still needed on current NW.js | Comment cites nwjs/nw.js#7597 | Testing on target NW.js versions |
| U-14 | Actual CPU/memory profile of Tier-2 background apps (no budgets exist in code — `wm.js:430-501`) | No enforcement code to read; needs measurement | Profiling on target hardware |

## 4. Historical questions

| # | Item | Why | What would settle it |
|---|---|---|---|
| U-15 | Whether per-app-UID/seccomp/cgroup/SELinux NBOSP images ever existed and were removed | `NBOSP/os/README.md:8-10` says the supervisor/isolation stack is "not part of this image"; the build actively wipes SELinux traces (`os/build-iso.sh:66-70`) — but no history of a shipping isolated image is in this tree | Repository history / maintainer confirmation |
| U-16 | Which OS version each capability/permission first appeared in | The code carries no per-version capability history (no changelog mapping); the old guide's compatibility table was unverifiable | Maintainer-maintained release notes |
| U-17 | Whether the `nova:clock:*` host-only handler family (14 channels, `app-sandbox.js` in 1-5100 range) was ever guest-reachable | Handlers exist but are dead for IPC (not in `API_HANDLERS`, blocked at dispatch) — purpose/history unclear | Repository history |

## 5. Payload/response detail gaps

Code-verified surfaces where some payload detail could not be fully
established from the audit notes:

| # | Item | Why | What would settle it |
|---|---|---|---|
| U-18 | Per-day push publish volume limits (none exist in code — only field caps + the global API rate limit; the old guide's absence-of-limit claim matches) | Established as "no dedicated limit found", but absence is hard to prove exhaustively | Reading `server/core/push-routes.js` end to end |
| U-19 | `system:autostart` enrollment UX (grant mechanics are verified; the Settings/App Manager screen that toggles it was not fully captured) | Grant + boot-list behavior is verified; the exact UI flow was not | Reading `js/apps/settings/app.js` autostart section |

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

| # | Item | Why | What would settle it |
|---|---|---|---|
| U-20 | Behavior on Windows/macOS hosts (the OS ships dev-run on any host via NW.js; path handling is written to be cross-platform but only Linux + Node 24 were exercised by the audit's test runs) | Test execution in the audit environment covered the Linux/Node path | Running the suite on Windows/macOS |
| U-21 | VMware-specific behaviors (the ISO targets x86_64 VMware; e.g. `S11vmware-fuse` behavior, guest tools interactions) | No hypervisor in the audit environment | Booting the ISO in VMware |
