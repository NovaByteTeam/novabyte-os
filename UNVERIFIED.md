# Unverified Items

Everything the audit could **not** determine from the source code alone, why,
and what would settle it. Items marked "finding" in [`AUDIT.md`](AUDIT.md) are
*not* listed here — those were established (positively or negatively) against
the code. This list covers only genuine unknowns.

Audit scope: `NovaByteTeam/novabyte-os` @ `ccc4305` (main). Everything else in
the documentation set is cited to `path:line` in that tree.

---

## 1. NovaByte Studio (external tool)

NovaByte Studio (`github.com/NovaByteOfficial/novapack-studio`) is referenced
by the README as the tool for creating and testing `.novaapp` packages, but
its repository is **not part of this repo** and was not audited.

| # | Item | Why it cannot be determined from this repo | What would settle it |
|---|---|---|---|
| U-01 | Studio's actual UI/workflow (project templates, the "Build" button behavior, packaging options) | Only a 5-line pointer exists in `README.md:96-101`; no Studio code here | Auditing the novapack-studio repository |
| U-02 | Studio's native/C++ build steps (`emcc`, `module.cpp`) mentioned by the old guide | Zero references in this repo (`emcc`/`module.cpp` grep: only `NOVAAPP.md`) | Studio repo; also whether the feature still ships |
| U-03 | Studio-side manifest/permission validation (the old guide claimed Studio validates before build) | No code in this repo; in this repo validation is install-time only (`app-package.js:780-1001`) | Studio repo |
| U-04 | "Studio v1.1.80+ defaults new projects to integrity `none`" | Sourced only from a code comment in `app-package.js:538-543` | Studio repo / release notes |
| U-05 | Whether Studio accepts `novaapp.json` as a manifest name | The old guide claimed the OS accepts it; no code path in this repo does (grep-verified). Whether *Studio* accepts it is unknown | Studio repo |

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
