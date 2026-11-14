# NovaByte OS — Documentation-vs-Code Audit Report (Task 8-AUDIT)

**Repo state audited:** `NovaByteTeam/novabyte-os` @ `ccc4305` (`ccc430599a6d54bacf236139a6b584e39de848f0`, "Merge pull request #39 from NovaByteTeam/gl-debug"), main branch.
**Subject doc:** `NOVAAPP.md` (2,315 lines) — the legacy `.novaapp` App Development Guide now being replaced.
**Method:** full read of `NBOSP/js/platform/security/app-sandbox.js` (14,895 lines) plus all platform, server, and OS-image files via the audited subsystem notes (Appendix B); 1,139 doc claims extracted and checked claim-by-claim (verdicts-1…4); test suites executed (vitest: 1,757 tests; integration: 9 suites). Every reference below was re-verified against the tree at `ccc4305`.

**Path aliases used throughout** (all repo-relative, under `NBOSP/` unless noted):
`AS` = `js/platform/security/app-sandbox.js` · `APM` = `js/platform/security/app-permission-manager.js` · `AR` = `js/platform/core/app-registry.js` · `AP` = `js/platform/core/app-package.js` · `NAL` = `js/platform/core/nova-app-launcher.js` · `NREG` = `js/platform/core/nova-registry.js` · `MED` = `js/apps/media-store/service.js` · `PR` = `server/core/push-routes.js`.
Doc references are `NOVAAPP.md:<line>`. Items are marked **[confirmed]** (read in code) or **[suspected]** (inferred; needs runtime confirmation).

---

## 1. Executive summary

| Metric | Count |
|---|---|
| Doc claims checked (incl. worked examples) | **1,139** |
| — CORRECT | 1,083 (95.1%) |
| — WRONG | **42** (Part II) |
| — OUTDATED | **2** (Part III) |
| — DOC-ONLY | **6** (Part III; brief tally said 5 — verdicts-2 contains one extra; all 6 listed) |
| — UNVERIFIABLE | **6** (Part VI) |
| Security concerns & suspected bugs (Part I) | **96** (5 Critical, 12 High, 30 Medium, 49 Low) |
| Undocumented behaviors (Part IV) | **70** |
| Phantom registry/table entries (Part V) | 3 (1 legacy permission, 1 facade method, 1 limit) |
| Omitted registry/table entries (Part V) | 21 channels, 9 facade methods, 8 events, 8 error codes, ~20 limits |
| Documented events with no emitter | 14 of 18 allowlisted names (12 of them are doc-table rows) |
| Tests executed | vitest 1,757/1,757 pass; integration 5/9 pass (harness bug, Part VII) |

Verdict distribution by claims file (doc-line ranges):

| Claims file | Doc lines | Claims | CORRECT | WRONG | OUTDATED | DOC-ONLY | UNVERIFIABLE |
|---|---|---|---|---|---|---|---|
| verdicts-1 | 1-555 | 287 | 274 | 7 | 0 | 1 | 5 |
| verdicts-2 | 557-1155 | 284 | 275 | 7 | 1 | 1 | 0 |
| verdicts-3 | 1157-1764 | 247 | 241 | 5 | 1 | 0 | 0 |
| verdicts-4 | 1766-2316 | 321 | 293 | 23 | 0 | 4 | 1 |
| **Total** | | **1,139** | **1,083** | **42** | **2** | **6** | **6** |

The old guide is ~95% accurate — the wrong 5% concentrates in security narrative, event names, error-code semantics, and edge-case consent behavior. Reading guide: Part I is about the **code** (what to fix regardless of docs); Parts II-V are about the **doc** (what the replacement must say differently); Part VII is about the **test evidence** backing both.

**The 10 findings that most affect developers:**

1. **The committed test signing key includes its private half** — on every default/test-tier build, anyone with repo read can mint "NovaByte System" packages that pass all identity gates and run unrestricted in the OS page (`keys/test-system-key.json:5`, `trust-store.js:102-137`). SEC-01.
2. **The default dev manifest disables web security and opens CDP port 9222**, and F12 is not devMode-gated — the entire sandbox model is bypassable on any non-kiosk launch (`NBOSP/package.json:29-30`, `ui-init.js:58-61`). SEC-02.
3. **The shipped OS image grants blanket NOPASSWD sudo and unauthenticated root consoles** (tty2 empty-password root; recovery root shell from unauthenticated GRUB) — contradicting `os/README.md:110-112`. SEC-03/SEC-04.
4. **Shared-file consent does not exist for modify/rename/move** — the doc's picker story (`NOVAAPP.md:1163`, `:1201`) promises confirmations that only fire for delete/overwrite (`AS:1875-1880`); an app can silently mutate a user-picked shared file. SEC-19.
5. **14 of 18 allowlisted event names have no emitter** — every documented `system:*`, `app:*`, and `mail:*` event (and `calendar:reminder`) subscribes successfully but never fires; the events that do fire (`app:opened/closed/focused`, `os:volumeChanged`, `fs:*`) are not subscribable and not documented (`AS:6021-6065`). Part II / Part V.
6. **`window.nova.resetPermission` is a phantom API** — the doc tells apps to call it; the only real reset path is host-only and GUEST_FORBIDDEN (`AS:9317-9336`).
7. **Error-code semantics are misdocumented** — `UNVERIFIED`/`UNTRUSTED` are swapped (`AS:5942` vs `:5969`), `TIMEOUT` never carries `.code` on interactive flows (`AS:11133`), and over-budget app-IPC rejects `INVALID_ARGS`, not `PAYLOAD_TOO_LARGE` (`AS:6222-6224`).
8. **The v2 facade does not cover every v1 family** — `nova:appearance:*`, context-menu, overlay, download, home, wallpaper, app-ipc, nested-webview, and raw `nova:net:fetch` remain v1-only (`AS:10361-11033`). Part II.
9. **`registry.read` is near-global and auto-granted** — any app that declares it reads other apps' `HKNA` config, the whole HKNU hive, and HKND (`AS:3095-3101`); it is Low-risk and auto-granted at launch (`APM:242`, `AR:672-674`). SEC-11.
10. **The Store installs unverified packages with no warning dialog** (`store/app.js:544-566`) and its update service ignores the community catalog entirely (`store-updates/service.js:4-5`) — Store trust UX is weaker than a manual install. SEC-13/SEC-25.

---

## Part I — Security concerns & suspected bugs

Issues in the **code**, independent of the docs. Duplicates across subsystem notes are merged (e.g. the test-key trust model appears in the permissions, packaging, store, and verdicts notes — one entry). Severity rubric: **Critical** = direct sandbox escape / host compromise / credential exposure on default builds; **High** = privilege escalation needing user grant, data leak across apps, trust-model breaks; **Medium** = weakened isolation, UX-based security, fail-open paths; **Low** = hardening gaps, inconsistencies, dead code.

Severity distribution by subsystem (counts of Part I findings):

| Subsystem | Crit | High | Med | Low |
|---|---|---|---|---|
| Sandbox / app runtime (`app-sandbox.js`, launcher) | 1 | 1 | 7 | 22 |
| Trust & packaging (keys, store, installer) | 1 | 2 | 6 | 8 |
| OS image (Buildroot, sudoers, boot) | 2 | 1 | 2 | 6 |
| Server (`server/core/*`) | 0 | 1 | 7 | 8 |
| Permissions & identity (`APM`, registry, root broker) | 0 | 4 | 5 | 3 |
| Boot / session / lock / FS | 1 | 2 | 1 | 2 |
| Docs-as-security-input (NOVAAPP.md wrong claims) | 0 | 0 | 1 | 0 |
| Test infrastructure | 0 | 0 | 0 | 1 |

### Critical

**SEC-01 — Committed test private key forges the "NovaByte System" identity on default builds** **[confirmed]**
The committed "test pair" ships the Ed25519 **private** half (`keys/test-system-key.json:5`, field `d`); the trust store anchors the System signer to its public half (`trust-store.js:102-137`, `:129-137`), and the default builder signs with it (`build-apps.mjs:228-273`). Anyone with repo read can mint packages with `verified:true, signer:'NovaByte System', manifest.system:true`. Because `registerApp` only downgrades system claims when the System-signer triple *fails* (`AR:422-443`), a test-key package claiming `source:'system-bundle'` passes `checkUnrestrictedApp` (`unrestricted-gate.js:141-176`) and runs host-tier; a test-key package with id `com.nbosp.settings` + `system:true` passes `isTrustedSettingsAppById` (`unrestricted-gate.js:68-78`), after which **every `isGranted` check returns true** (`APM:642`). Documented AOSP-style trade-off (`keys/README.md:19-25`) with tier labeling (`trust-store.js:361-364`), but on a default build the attacker satisfies every mitigation. This collapses all identity-derived gates (System badge, host-tier execution, Settings-app exemption).
*Fix:* ship only the public half in-repo; source the private key from an untracked path or CI secret; treat test-tier System verification as non-authoritative for host-tier execution.

**SEC-02 — Default manifest disables web security, opens CDP 9222; F12 not devMode-gated** **[confirmed]**
`NBOSP/package.json:29-30` (window block) ships `dev_tools: true` and `chromium-args` containing `--remote-debugging-port=9222 --auto-open-devtools-for-tabs --disable-web-security --allow-file-access-from-files`, plus `node-remote: "https://localhost:*"` (`package.json:32`). Any non-kiosk `nw .` launch runs the Node-enabled host with same-origin policy disabled and a CDP port open: any local process that reaches 9222 fully drives the NW.js context (Node access to all localhost pages, including the third-party app-serve surface on :3003). Separately, `ui-init.js:58-61` binds F12/Ctrl+Shift+I to DevTools on the trusted host page with **no devMode check** (every app-side devOnly gate is enforced elsewhere), and plain F5 reload is deliberately allowed (`ui-init.js:62-65`, relevant to SEC-06). The kiosk image strips these (`os/package/nbosp-kiosk/prepare-kiosk.mjs:26-63`), but the repo default is dangerous for anyone shipping `package.json` unmodified.
*Fix:* move the insecure flags behind an env/`--dev` gate; gate F12 on devMode; never ship `--disable-web-security` in the default manifest.

**SEC-03 — Blanket NOPASSWD sudo for the kiosk user in the shipped image** **[confirmed]**
`os/board/nbosp/rootfs-overlay/etc/sudoers.d/nbosp:1` = `nbosp ALL=(ALL) NOPASSWD: ALL`, deliberately wired to the in-app NovaRoot broker (`root-broker.js:20-30`, `sudo -n -- <argv>`). Any NW.js/renderer compromise on the image = trivial root. The narrow setuid helpers (`nbosp-power`, `nbosp-install`) are not the actual boundary; `os/README.md:110-112`'s "no general root command execution" claim is contradicted by this rule. The build even enforces the rule's presence (`os/build-iso.sh:309-315`) and pins it in tests (`tests/system/os-kiosk-config.test.js:55`).
*Fix:* replace with a narrow sudoers allowlist of the specific argv shapes the broker needs, or a polkit/pid-checking helper; align `os/README.md`.

**SEC-04 — Unauthenticated physical root: tty2 root console (empty password) + recovery root shell** **[confirmed]**
(a) `rootfs-overlay/etc/inittab:4` spawns a tty2 getty while Buildroot's default root login has an **empty root password** — no `BR2_TARGET_GENERIC_ROOT_PASSWD` / `BR2_TARGET_ENABLE_ROOT_LOGIN=n` anywhere in `os/configs/nbosp_x86_64_defconfig`. (b) Recovery menu option 9 is a root shell (`os/board/nbosp/nbosp-recovery:272-277`), reachable from the unauthenticated GRUB menu (timeout=5, no password). No SSH daemon shipped (mitigates remote), but anyone at the console owns the box.
*Fix:* lock the root account, remove the tty2 getty, require auth before the recovery shell.

**SEC-05 — Factory reset is dead code: "Wipe All Data" leaves all account data intact** **[confirmed]**
Settings' only wipe path calls `window.performFactoryReset()` (`js/apps/settings/app.js:1622`), which is defined nowhere; `NovaFactoryReset.performLinuxFactoryReset` (`js/platform/ui/factory-reset.js:44-59`) has zero runtime callers. A user relying on "Wipe All Data" before disposal/sharing leaves every account's `/home/nbosp` data intact, with only a failure toast. (The underlying path checks — symlink/realpath/approved-scope — are correct; they are simply never wired.)
*Fix:* wire the Settings action to `NovaFactoryReset`, or remove the button.

### High

**SEC-06 — Legacy PIN lock: brute-force bypass via page reload (single-user mode)** **[confirmed]**
`OS.wrongPinCount`/`OS.lockoutUntil` are in-memory only (`js/core/core/kernel.js:54-55`; `js/apps/lock-screen/service.js:206-254`), and plain F5 reload is deliberately allowed (`ui-init.js:62-65` blocks only Ctrl+F5). Nine wrong PINs + F5 resets the counter → unlimited offline brute force of a 4-6 digit PIN. Multi-user mode is safe (server-side ladder; unlock via `/api/auth/reverify`). *Fix:* persist the ladder in the registry (like other boot state), or block reload while locked.

**SEC-07 — Legacy "security wipe" after 10 wrong PINs wipes almost nothing** **[confirmed]**
`triggerSecurityWipe` runs `localStorage.clear(); sessionStorage.clear(); reload()` (`lock-screen/service.js:947-948`). On linux-native, real user data lives on disk (`~/users/*`, `~/.config/novabyte/registry`, `~/.local/share/novabyte`, `nwjs-data`) — all untouched — while the user is shown "All data has been wiped". Misleading disposal-grade claim. *Fix:* route to the (currently dead) factory-reset path, or relabel.

**SEC-08 — `system-bundle` provenance branch mints verified System packages with no crypto** **[confirmed]**
`AP:563-569`: any caller passing `options.source === 'system-bundle'` with `manifest.system === true` and *any truthy id* gets `verified = true; signer = 'NovaByte System'` with no signature check. The comment (`AP:559-562`) claims the exception is "narrow to the Settings id" — no id allowlist exists. `my-apps-manager.installFromFile/FromUrl` spreads caller-supplied options into it (`js/platform/ui/my-apps-manager.js:224-230`, `:253-259`), so any privileged shell-context caller (compromised built-in, devconsole) can mint a system app. Legit caller: `boot.js:884` only. *Fix:* verify the id against the first-party manifest inside the branch, or require a boot-minted token.

**SEC-09 — Policy `pin` escalation: one `registry.system` grant force-grants any permission machine-wide** **[confirmed]**
`appPolicyFor()` reads `HKNS/security/policy/appPolicy/<appId>`; a `pin` array makes `isGranted` return true **even over explicit user denial** (`APM:650-657`). Policy lives in the registry; `registry.system` (Critical) grants write everywhere including `HKNS/security` (`APM:129-135`, `:244`). Chain: user grants `registry.system` → app writes a policy pinning `mail:read`, `clipboard:read`, … → grants pass forever with no further prompt. *Fix:* exclude `HKNS/security/policy` from app-writable paths even for `registry.system`, or require admin-mode for policy writes.

**SEC-10 — Grants keyed by appId only: signature-change/reinstall inheritance + replace downgrade** **[confirmed]**
Grants are keyed `${appId}:${permission}` (`APM:371-373`); `registerApp(force)` never touches the grant table (`AR:278-284`) and core `uninstallApp` does not revoke grants (`AR:601-613`; only App Manager's path calls `revokeAllPermissions`, `appmanager/app.js:2752-2756`). Replacing a trusted app with an unverified one of the same id inherits all prior consents; only `system:root` has a restore-time re-check (`AR:171-185`). Compounding: the two interactive replace paths perform **no version comparison** (`AP:620-627`; `appmanager/app.js:2548-2566`) — a social-engineered "Replace" installs an older version while grants survive (rollback primitive). *Fix:* key grants by (appId, signer fingerprint); refuse downgrades.

**SEC-11 — `registry.read` is near-global and auto-granted at launch** **[confirmed]**
Any app holding plain `registry.read` reads every hive except `HKNS/security` (`AS:3095-3101`): other apps' `HKNA/<appId>` config, the entire HKNU user hive, and HKND (console history — devMode gates HKND *writes* only, `AS:3155`, `:3174-3176`). Per-key ACLs are the only defense and are opt-in (no ACL → granted; `NREG:811-823`). `registry.read` is **Low-risk and auto-granted at launch when declared** (`APM:242`; `AR:672-674`) — this is a cross-app config/data leak for the price of a manifest declaration. *Fix:* default-deny cross-app HKNA reads; require an explicit per-app ACL or a higher-risk permission.

**SEC-12 — `registry.system` → devMode/rootAccess write chain** **[confirmed]**
An app holding `registry.system` can write `HKNS/system/devMode` and `HKNS/security/rootAccessEnabled` (`AS:3154-3159` returns null for registry.system); the settings shim live-applies those writes into `OS.settings` (`js/platform/core/settings-shim.js:214-221`), which then satisfies `rootModeEnabled()` (`root-broker.js:155-169`) for any root-granted app. DevMode/Root-Access flips require no re-auth beyond the original `registry.system` consent. *Fix:* treat these two keys as admin-mode-gated regardless of holder; require a Settings-UI confirmation for privilege flips.

**SEC-13 — Store installs unverified packages with no warning dialog** **[confirmed]**
The Store's `installApp` only blocks *revoked* packages; unsigned/untrusted-signer installs proceed, recorded `verified:false` (`js/apps/store/app.js:544-566`; `:549-551` revoked-only). It bypasses `AppPackage.installPackage`'s `allowUnverified` gate (`AP:587-593`) by assembling `appData` itself and calling the verification-free `NovaAppPackageStore.installApp` (`nova-app-package-store.js:157-209`). Pinned by test: "unsigned package installs unverified" (`tests/apps/store.test.js:174`). Users get no prompt — only badge *absence* — while every manual install path warns. The doc's "same trust machinery" (`NOVAAPP.md:2241`) holds for verification but not for consent. *Fix:* route Store installs through the same untrusted-package dialog as App Manager.

**SEC-14 — Unauthenticated SSE log mirror leaks the server event log** **[confirmed]**
`GET /api/events/stream` (`server/core/events-routes.js:9-29`) requires no session and no CSRF. Any local client receives the full 500-entry `ServerEventLog` (`server/core/server-event-log.js:5`), including email account usernames+hosts (`email/controller.js:172-177`), blocked proxy hostnames, client IPs/UAs, and security-event metadata. Compounded by SEC-34 (audit scoping no-op). *Fix:* require an authenticated session for the stream.

**SEC-15 — Terminal spawns an un-gated host shell inheriting `process.env`** **[confirmed]**
`js/apps/terminal/app.js:1448-1454` (and `:1520-1524`) runs `spawn('/bin/sh', [], {env: {...process.env}})` with no devMode / `system:root` / devOnly gate. It runs as the OS user, not root, but fully bypasses the app permission model, and because `process.env` is inherited (`:1451`) a shell user can read `NBOSP_SYSTEM_API_RATE_LIMIT_SECRET` and forge the trusted-system-app HMAC headers (`system-fetch.js:38-49`) — defeating the server-side rate-limit trust bucket from inside the terminal. *Fix:* gate the Linux path on devMode (matching devconsole/NovaReg), or scrub the environment.

**SEC-16 — Files app "Run Linux executable": host binary execution outside the trust model** **[confirmed]**
`js/apps/files/app.js:1879-1905` (menu `:1612-1614`, executable branch `:1591`) spawns arbitrary host-disk binaries via `childProcess.spawn(filePath, [], {env: process.env, detached: true})` behind one confirmation modal. This executes binaries as the `nbosp` user, entirely outside the scanner/sandbox/trust-store machinery built for `.novaapp` packages — the widest single capability on this surface (same env-inheritance issue as SEC-15). *Fix:* require devMode; do not pass `process.env`.

**SEC-17 — `/opt/nbosp` chowned to the kiosk user at boot** **[confirmed]**
`os/board/nbosp/S99nbosp:362` runs `chown nbosp:nbosp /opt/nbosp` ("prepare writable runtime state"). The directory holding the root-installed NW.js bundle becomes user-writable, so `nbosp` can replace/rename `/opt/nbosp/NovaByte` for persistence at next boot; `os/README.md:145`'s "bundle remains root-owned" holds only for inner files. Independently invalidating the root-owned-bundle claim (moot only when combined with SEC-03). *Fix:* chown only the writable runtime subdirectories, not the bundle root.

### Medium

**SEC-18 — Unguarded host-only `nova:system:*` handlers; single dispatch-list defense** **[confirmed]**
`nova:system:permissions:set` (arbitrary permission grant, `AS:4875-4893`), `nova:system:admin-mode:set` (immediately applies `!!payload.enabled`, `AS:5429-5439`), and `nova:system:data:backup` (full localStorage dump, `AS:4918-4934`) exist as handlers with **no permission gate of their own** and are not in `API_HANDLERS` (`AS:9338-9463`); their only protection is the dispatch-time `GUEST_FORBIDDEN_IPC_APIS` rejection (`AS:9317-9336`, `:9577-9579`). A comment claims they are "in API_HANDLERS for completeness" (`AS:4852-4858`) — false. Removing or typoing one list entry exposes arbitrary permission grants / admin-mode flips to any sandboxed app. *Fix:* add in-handler identity checks (Settings-app triple) as defense in depth; fix the comment.

**SEC-19 — Shared-file modify/rename/move never prompt; unreachable consent branches** **[confirmed]**
`confirmSharedFileChange` returns `true` un-prompted for any action other than `'delete'`/`'overwrite'` (`AS:1875-1880`). All `nova:fs:write` paths pass `'modify'` (`AS:2438`, `:2468`); rename/move pass `'rename'`/`'move'` (`AS:2654`, `:2673`). Only deletion and picker-save overwrite (`AS:9126-9128`, `:9254-9257`) ever confirm; the `UNAVAILABLE` "User confirmation is required to modify/rename/move a shared file" branches (`AS:2440`, `:2656`, `:2675`) are unreachable dead code. A user granting one file via the picker implicitly grants silent mutation of it. The doc promises the opposite (`NOVAAPP.md:1163`, `:1201`, `:1153` — Part II). *Fix:* prompt for all four actions or delete the dead branches and fix the doc.

**SEC-20 — `nova:net:fetch`: no response cap/timeout, literal-hostname classification, no TLS floor** **[confirmed]**
(a) Request bodies are budgeted (`httpBodyBytes` 16 MiB, `AS:6438-6441`) but responses are returned whole with no cap, no ledger byte accounting (object bodies bypass even request accounting, `AS:6449-6450`), and no in-handler timeout (`AS:6452-6506`) — unbounded egress/memory pull through both the direct and proxy branches. (b) Internal/external is decided from the URL hostname literal only (`AS:1267-1288`): a public DNS name resolving to 127.0.0.1/10.x is classified *external* and fetch is handed to the server-side proxy; fetch also lacks the WebSocket-only local-DNS-suffix protection (`AS:1323-1324`), so `http://router.local` is external while `ws://router.local` is internal. (c) `http:` fetch (`AS:218`) and `ws://` websockets (`AS:1309-1311`) are permitted — no TLS floor anywhere in net:* (only mail refuses plaintext, `AS:5504-5507`). *Fix:* cap/timeout responses; resolve DNS before classification; share the internal-DNS-suffix list; optionally enforce https/wss.

**SEC-21 — `nova:storage:get` fails open; `STORAGE_FULL` mislabels all write failures** **[confirmed]**
IndexedDB errors are converted to `{success:true, value:null}` ("rather than crashing the IPC call", `AS:6885-6889`) — a storage outage is indistinguishable from missing data (fail-open). `handleStorageSet` labels *every* write failure `STORAGE_FULL` (`AS:6927-6931`), masking real errors (quota at `AS:6778-6781` is only one cause). *Fix:* propagate a distinct `STORAGE_ERROR`; fail closed on read errors.

**SEC-22 — Event allowlist is the only wiretap guard for `settings:changed`** **[confirmed]**
`settings:changed` fires for password/PIN updates from system code and would be a recon channel if subscribable (`AS:6013-6020`); `ALLOWED_EVENT_NAMES` (`AS:6021-6065`) is the only thing blocking it. The appearance:subscribe handler does listen to `settings:changed` globally but forwards only the 5 public keys (`AS:8694-8696`) — correct today, fragile if the filter list drifts. *Fix:* redact sensitive keys at the emitter, not only at the forwarder.

**SEC-23 — Uninstall residue: secrets, alarms, defaultApps registrations survive** **[confirmed]**
`AppSecrets` has no `removeApp` (`js/platform/security/app-secrets.js` — none); named alarms persist in `HKNS/apps/alarms`; defaultApps registrations persist. A same-id reinstall silently re-inherits secrets; stale alarms may fire into a reinstalled (possibly attacker-published, see SEC-10) app id. Uninstall clears notification/default-apps rate limits (`AS:5864-5872`) but not `appIpcRateLimits` (`AS:37`, `:6133`), `badgeRateLimits` (`AS:7515`), `appearanceSetRateLimits` (`AS:8627`), or `fsWatchPushLog` (`AS:7610`). *Fix:* add uninstall hooks for secrets/alarms/defaultApps; sweep the rate-limit maps.

**SEC-24 — Username leak inconsistency between `nova:system:info` and `nova:ready`** **[confirmed]**
`nova:ready` hides `username` from non-system apps (`AS:8733`), but `nova:system:info` returns `OS.username` (plus `uptime`) to **any** app holding `system:info` — a Medium, user-grantable permission (`AS:7446-7454`). The ready-handshake restriction is bypassable via a weaker grant; the doc's response shape omits these fields entirely (Part II). *Fix:* align the two surfaces (drop username from system:info or gate it on `app.system`).

**SEC-25 — Store Update Service ignores the community catalog** **[confirmed]**
`js/apps/store-updates/service.js:4-5` reads only the static GitHub Pages catalog, while the Store merges in Supabase community apps (`store/app.js:484-511`). Community-published apps get no update checks or notifications; dehosted community apps silently vanish from updates with no revocation signal to devices (installed copies keep running). *Fix:* point the checker at the merged catalog or both sources.

**SEC-26 — No remote revocation feed** **[confirmed]**
Revocation lists are repo/site-shipped JSON (`src/revoked-signatures.json` = `[]`, `src/logic.js:96-99`) or a local file next to `trust-store.js` (`trust-store.js:245`, `:278-305`); in-memory revocation in sandboxed contexts doesn't survive restart (`trust-store.js:418-429`); documented multi-writer race caveat (`trust-store.js:326-337`). A compromised signed package can only be revoked by shipping a new OS/site release — no runtime CRL fetch from the publisher backend. *Fix:* fetch a signed revocation manifest at boot/Store-open.

**SEC-27 — Admin-mode enforcement is client-side and true-for-all on single-user installs** **[confirmed]**
`isAdminSessionActive()` returns `true` for everyone when multi-user is off (`APM:673-676`), so on default installs client-side `admin:*` enforcement reduces to "user granted it". `admin:apps` additionally has no server 403 to lean on — admin-mode is inferred client-side from fields in `GET /api/security/settings` (`AS:4845-4851`); only `admin:audit/system/users` get real server 403s (`admin:users` also needs an admin-role session, `AS:4710-4715`). *Fix:* honor the server admin-mode flag for all four families.

**SEC-28 — NovaRoot: arbitrary argv by design; caller attribution spoofable** **[confirmed]**
`NovaRoot.run()` executes any argv as root with no command allowlist (`root-broker.js:25-27`, `:366-411`); mitigations are the caller gate (devMode + rootAccessEnabled + live `system:root` grant + admin session), one OS-side prompt, and argv-array execution. Caller attribution is heuristic: `focusedRootAppId()` attributes unmarked calls to the focused root-granted app (`root-broker.js:133-143`, `:145-153`) and identity relies on `Error().stack` sourceURL markers (`:117-123`) — an unrestricted host app can embed `//# sourceURL=novaapp:<otherRootApp>/x` to misattribute root requests in the audit log. Audit-integrity issue, not a boundary break (unrestricted apps already have host access, `AS:14031-14037`). Also: `writeFile` stages a temp in `os.tmpdir()` then `cp`s as root (`root-broker.js:419-431`) — random-name race, low risk. *Fix:* prompt with the resolved argv on every `run`; attribute via a broker-minted handle instead of stack strings.

**SEC-29 — AppSecrets master key co-located with ciphertext; store file committed to repo** **[confirmed]**
Master key `root/app-secrets.key` (0600) sits beside `root/app-secrets.json` (0600) under `process.cwd()/root` (`app-secrets.js:46-48`, `:67`, `:131`); no per-user key wrapping (admitted `:99-103`); pre-login writes namespace into the legacy owner's record (`user-scope.js:123-128`). Threat model honestly documented as app-isolation hygiene, not a vault (`:10-15`); sandbox handlers force the caller's namespace (`AS:8134-8161`) and secrets are excluded from export/backup (`AS:8120-8125`). Additionally `root/app-secrets.json` **is committed** (currently empty) while the module comment claims root/ is "untracked, never shipped" (`app-secrets.js:43-45`) — if a dev's real store gets committed, ciphertext leaks. *Fix:* gitignore `root/`; wrap the key per-user (OS keychain) if a stronger model is wanted.

**SEC-30 — devMode-gated host-page RCE surfaces: devconsole, Modules, NovaReg** **[confirmed]**
devconsole is `eval()` with full OS-context privileges in the host page (`js/apps/devconsole/app.js:11-15`, `:259`) — it can drive NovaRoot, AppSecrets, and the registry directly; only gates are devOnly + devMode (`:8`, `:23-27`). The Modules app is an intentional RCE surface (full module-tree reload, `js/apps/modules/app.js:11-14`, `:301-339`), double-gated dev-only+devMode. NovaReg has direct engine access (`js/apps/novareg/app.js:3-7`). Nothing technical stops a devMode-enabled kiosk user. *Fix:* require a typed confirmation (like tamper-install) for devconsole eval; consider removing these apps from kiosk images.

**SEC-31 — Legacy launcher fallback mints unsandboxed webviews on AppSandbox load failure** **[confirmed]**
`NAL:884-1231` (duplicated in `appmanager/app.js:740+`) is a full legacy launch path used only if `AppSandbox` is undefined: `window.parent.postMessage` bridge, `window.__novaPrivateStore` localStorage shim (`NAL:891-903`, `:1074`, `:1175`), blob-URL content fallback, and — for `legacyHostTier` packages (verified + System signer + `manifest.system`) — **no sandbox attribute** (`NAL:926-928`, `:1119-1121`, `:1205-1207`). Untrusted apps on that path get only `'allow-scripts allow-forms allow-modals allow-popups'` (`NAL:1120`). An escape hatch keyed on a script-load failure; contradicts the doc's "no postMessage / no `__novaPrivateStore`" claims (Part II, `NOVAAPP.md:553`, `:714`). *Fix:* delete the fallback, or reduce it to a hard error.

**SEC-32 — MyAppsManager install path skips scanner and impersonation dialog; arbitrary-URL host fetch** **[confirmed]**
`my-apps-manager.js:209-271` calls `AppPackage.installPackage` with trust store + revocation but **no Scanner sweep and no system-impersonation dialog** (compare `appmanager/app.js:2416-2515`). `installFromUrl` fetches arbitrary URLs in the trusted host with no scheme/credential check (`:249-256`) — inconsistent with the platform's own URL validators; an internal/credential-bearing URL would be fetched host-side. No in-repo product surface currently ships this UI (library), but the asymmetry is real. *Fix:* reuse the App Manager gate sequence; validate URLs with `resolveAndClassifyUrl`.

**SEC-33 — Server input "sanitization" HTML-escapes credentials** **[confirmed]**
`sanitizeObject` HTML-escapes `&<>"'` in **every** request body except `/api/repair/`, `/api/backups/`, `/api/proxy` (`server/core/security/middleware.js:336-401`). Email passwords (`POST /api/email/connect`) and account passphrases containing those characters are silently stored/sent as `&amp;` etc. — consistent for auth (both sides escaped) but a real IMAP/SMTP auth-breaker for special-char passwords, and it silently shrinks the effective passphrase charset. *Fix:* exclude credential fields/paths from sanitization.

**SEC-34 — Non-admin audit scoping is a no-op: standard users receive the entire audit ring** **[confirmed]**
`req.query.userId = req.user?.id` (`server/core/security/routes.js:364`) does nothing on Express 5 — the file's own comment (`routes.js:316-327`) proves the team knows query assignment is inert. Non-admin sessions get the full ring buffer via `GET /api/security/audit`. *Fix:* pass the filter into the query service.

**SEC-35 — `PUT /api/security/settings` allowlist never applies** **[confirmed]**
`securitySettings._meta?.editable` is undefined (`_meta` is built ad-hoc only in the GET handler), so `editableFields=[]` and every key in the body merges into `securitySettings` (`server/core/security/routes.js:694-703`; `validateRequest` ignores undeclared fields). Admin-only, but arbitrary-key injection into the config object that later gates `enableIPBlocking` etc. *Fix:* persist the editable list or hard-code it server-side.

**SEC-36 — Push publish vs CSRF contradiction** **[confirmed]**
`POST /api/push/publish` is designed as an untrusted, token-authenticated endpoint (`PR:9-14`), but it is not CSRF-exempt in the production chain (`security/middleware.js:39-59`) — an external backend without session+CSRF token gets 403. Tests never exercise it through the CSRF chain (`tests/server/push.test.js`). *Fix:* exempt the publish route (token is the capability) and add a CSRF-chain test.

**SEC-37 — First-boot takeover window** **[confirmed]**
`/api/auth/setup` and `/api/auth/migrate-legacy` are unauthenticated + CSRF-exempt while users.db is empty (`server/core/auth-routes.js:247-303`); migrate-legacy accepts an **attacker-chosen** `legacyPinHash`/salt and installs it as the owner. On the default loopback bind this is local-process-only, but with `HOST` overridden (`server/core/index.js:644`) a network peer racing a fresh machine becomes owner. *Fix:* bind setup to loopback regardless of HOST; require physical-presence proof.

**SEC-38 — Bearer session IDs persisted across restarts, no rotation on privilege change** **[confirmed]**
The login response hands out the raw sessionId; presenting it in `X-Nova-Session` (CORS-allowed header) is equivalent to the cookie (`security/middleware.js:14-41`, `:337-362`; `auth-routes.js:115-119`). SQLite persistence keeps these bearer tokens live across reboots until 24h cookie expiry; no server-side short-lived cap or rotation on privilege change (sid regenerated only at login). *Fix:* rotate on privilege change; cap bearer-token lifetime.

**SEC-39 — Installer performs no authenticity check of the rootfs archive** **[confirmed]**
`nbosp-install-system` validates the rootfs archive only by gzip/tar readability (`os/package/nbosp-install/nbosp-install-system:102-109`) — no signature, hash list, or measured boot; GRUB is unsigned (`os/README.md:96`, Secure Boot disabled). Installed root is unencrypted ext4, `rw` in every entry. *Fix:* sign the archive and verify before extraction.

**SEC-40 — No per-app kernel isolation, no firewall; SELinux/NETFILTER absent from the image** **[confirmed]**
One NW.js process tree as UID 1000 runs OS + every third-party `.novaapp`; no seccomp/cgroup/UID layer (`os/README.md:8-10`, documented). App-to-app isolation exists only in JS (`AS:234-238`). The kernel fragment asserts **no** NETFILTER (no firewall possible, `os/test-labwc-kiosk.mjs:132`) and SELinux is absent — unrestricted network egress; public DNS fallbacks `1.1.1.1`/`8.8.8.8` baked in (`S41network:28`, both nmconnection profiles). Documented design limitation, listed here because every JS-layer finding above is the only thing standing behind it. *Fix (long-term):* per-app UID supervisor or seccomp broker; enable NETFILTER in the fragment.

**SEC-41 — `nova:app:list` exposes the full app inventory** **[confirmed]**
Any app holding `system:apps` (Medium) receives names, versions, categories, signer, verified, source, and devOnly flags for every installed app (`AS:5726-5757`; manifest properly reduced to `{system}`, `AS:5751`); no rate limit on the channel. Recon surface the doc explicitly denies exists (`NOVAAPP.md:981` — Part II). *Fix:* require admin-mode or strip signer/verified from third-party-visible records.

**SEC-42 — `nova:system:preferences:get` dumps the whole settings cache** **[confirmed]**
`all: {...(OS.settings._cache || {})}` is returned to any app holding `system:settings` (`AS:5441-5450`). The set side blocks only `devMode`/`rootAccessEnabled` (`AS:5460-5462`); the read side has **no allowlist** (contrast NovaByteSystem's `readableKeys`, `js/apps/novabyte-system/service.js:24-30`, `:76-81`). *Fix:* apply the readable-key allowlist to the `all` dump.

**SEC-43 — Background email poller stores IMAP credentials in localStorage/registry** **[confirmed]**
`js/apps/background-apps/service.js:338-359` keeps accounts (user/pass) in `nbosp_email_accts_v2` (localStorage/registry-backed) and POSTs `user/pass` to `/api/email/connect` on every sync (`:375-385`) — plaintext credentials in a localStorage-backed store on each poll, in contrast with the AES-GCM `secrets:store` that exists precisely for credentials (`AS:8119-8162`). *Fix:* move credentials to AppSecrets; keep only session references.

**SEC-44 — Server email credentials live in plaintext memory keyed by session id** **[confirmed]**
Decrypted creds sit in a process-global in-memory Map (1000-session cap) readable by anything with access to the Node process (`server/email/credentials.js:23-24`, `:70-76`). Ciphertext-at-rest depends entirely on `NBOSP_CRED_KEY` being set and secret; documented as not multi-instance safe (`:43-45`). *Fix:* derive per-session keys; document the env requirement loudly.

**SEC-45 — Publisher backend: single-admin catalog control with hardcoded email** **[confirmed]**
All review/publish/dehost power is one account, `dirazmuhammad400@gmail.com` (`supabase/functions/publisher/publisher.ts:19`, `:222-226`; `publishing-config.js:5`). Compromise of that mailbox = full catalog control (publish arbitrary signed packages). No second reviewer, no MFA hint, no reviewer/signer role separation for apps; community template signing keys must be available on the reviewer's machine outside the Edge Function (`README:181-188`; `publishing.js:2451-2454`). CORS `*` + `verify_jwt=false` reachable cross-origin, though every action validates the Supabase token server-side (`publisher.ts:32-37`, `:206-220`). *Fix:* second reviewer, MFA, server-only signing for templates.

**SEC-46 — NOVAAPP.md's security narrative contradicts the code** **[confirmed]** (doc-side; full list in Part II)
The most security-relevant wrong claims:
- Shared-file confirmations that don't exist (`NOVAAPP.md:1153`, `:1163`, `:1201`)
- "No package-enumeration API" (`:981`)
- Wallpaper "payload budget" that never applies (`:1126`)
- "v2 covers every v1 family" (`:854`)
- 12 documented events with no emitter (`:1867-1878`)
- `UNVERIFIED`/`UNTRUSTED` semantics swapped (`:2035`)
- Phantom `window.nova.resetPermission` (Part V B1)
- Fictional 32-entry `registryScopes` cap (`:1813`)
- HKNU write rule understated (`:1773`)
- "MAC and ledger both enforced before handlers" (`:2072`)

Developers following the doc get false security assumptions. *Fix:* the replacement doc must be generated from the corrected claims in Parts II-V.

**SEC-47 — Calendar/Contacts are unsandboxed shared stores readable wholesale** **[confirmed]**
Any app with `calendar:read`/`contacts:read` reads **all** events/contacts — no per-record ownership or app attribution (`calendar_events_v2`/`nova_contacts`, `AS:7314`, `:7379`; writes sanitize shape only `AS:7292-7305`, `:7410-7416`). By design (Android-style shared providers) but a data-aggregation surface the doc never frames as such. *Fix:* document as shared-provider semantics, or add per-record origin fields.

### Low

Hardening gaps, inconsistencies, dead code, and fragility notes. All **[confirmed]** by code read unless marked suspected. Format: issue — refs — *fix*.

- **SEC-48 — Push register hands the app its own publish endpoint + bearer token** (self-push notifications while closed) — `AS:8585-8594`; bounded only by the 10/min notification budget `AS:8332`; doc frames publishing as backend-only. *Fix:* hand the endpoint to the backend only, or gate self-publish behind an additional consent.*
- **SEC-49 — WebSocket data plane unbounded** — no socket-count/frame-size/send-rate caps; frames mirrored to the global bus, per-subscriber isolation depends on one `appId` filter — `AS:6543-6546`, `:6575-6603`, `:6557`, `:6366`. *Fix: per-app socket cap + send budget.*
- **SEC-50 — Browser-level media gate is OR-semantics** (either camera or mic grant authorizes a request carrying either type) — `AS:9935-9942` vs per-constraint wrapper `:11788-11796`. *Fix: match requested types to grants.*
- **SEC-51 — Permission dialog binds Enter = Allow** (default-to-grant keybinding on an app-triggerable dialog; Escape = Deny) — `APM:1268-1278`. *Fix: default focus to Deny.*
- **SEC-52 — Share sheet Copy writes `OS.clipboard` + 30-entry history with no `clipboard:write` grant** — `AS:4197-4204`, `:3772-3777`. *Fix: document as user-mediated write or require the grant.*
- **SEC-53 — `nova:clipboard:read` falls back to `OS.clipboard` (last host-written value) even without focus** — `AS:3721-3729`. *Fix: drop the ambient fallback or expire it.*
- **SEC-54 — Context menus placed at unclamped host-screen coordinates** (host-UI spoof/clickjacking surface; requires `sandbox:nested-webview`) — `AS:3375`, `:3394`. *Fix: clamp to the calling webview's bounds.*
- **SEC-55 — `storage:estimate` PowerShell fallback runs `powershell.exe -ExecutionPolicy Bypass`** with escaped drive letter — child_process sink in a host-only handler — `AS:5105-5113`; guest-forbidden `AS:9322`. *Fix: keep guest-forbidden; prefer Node APIs.*
- **SEC-56 — TOCTOU in `writePickedHostFile` on platforms without `O_NOFOLLOW`** (lstat-then-open symlink-swap race; path from trusted picker) — `AS:9064-9067`, `:9079-9084`. *Fix: open with O_NOFOLLOW always or use a fd-based check.*
- **SEC-57 — TOCTOU between ownership checks and awaited FS mutations** (concurrent move/rename can shift path-derived ownership; node-id anchoring limits exposure) — `AS:2465-2479`, `:2693-2697`, `:2520-2532`. *Fix: re-verify ownership after the await.*
- **SEC-58 — `installRootApiAudit` returns inside the namespace loop** — only `window.OS` is ever instrumented; FS/WM/Notify/AppRegistry/APM/DefaultApps/Boot/Kernel root-execution audit silently never happens — `AS:170-181`. **[suspected bug]** (early return confirmed; coverage gap confirmed by inspection). *Fix: move the return outside the loop.*
- **SEC-59 — Rate-limit maps grow without bound across uninstall/reinstall cycles** (only notification/default-apps limits cleared) — `AS:5864-5872`; `:37`, `:6133`, `:7515`, `:8627`, `:7610`. *Fix: sweep all per-app maps on uninstall.*
- **SEC-60 — `nova:background:wake-done` unauthenticated by design** — safe only while sandboxId is taken from the caller's own webview dataset — `AS:2861-2875`. *Fix: assert the synthetic sandbox is scheduler-owned.*
- **SEC-61 — Tier-1 wake push races app page load; silently lost, no redelivery** — `app-scheduler.js:197-203`. *Fix: buffer until the ready handshake.*
- **SEC-62 — Registry service impersonates a system caller** via literal `{id:'com.nbosp.service.registry', system:true}` object for trusted-guest creation — one copy-paste from abuse — `js/apps/registry/service.js:77-98`. *Fix: pass a broker-issued capability instead of a literal.*
- **SEC-63 — App-id alias table is an implicit cross-app data-sharing boundary** (alias id owns another app's `/data` subtree) — `AS:1438-1444` (`NovaAppIdAliases`). *Fix: document the alias table as a trust boundary; freeze it.*
- **SEC-64 — `nova:ipc:broadcast:unsubscribe` and `nova:events:unsubscribe` have no permission gates** (asymmetric with subscribe; only mutate caller's own records today) — `AS:6306-6310`, `:6380-6389`. *Fix: mirror the subscribe gates.*
- **SEC-65 — Picker `accept` string form (≤512 chars) passes through unvalidated** (arrays strictly validated) — `AS:8815-8823`. *Fix: normalize strings to arrays before validation.*
- **SEC-66 — Ledger accounting keys inconsistent** (`owner~appId` for set vs plain `app.id` for delete/backup/import — usage stats fragment on multi-user) — `AS:6922-6925` vs `:6942`, `:7092-7093`, `:7103`. *Fix: stamp owner uniformly.*
- **SEC-67 — fs:watch silently coalesces (drops) change events when rate-limited**; snapshot advances before the push check — `AS:7688-7690`. *Fix: document; optionally flag dropped events.*
- **SEC-68 — eval audit wrapper is dead code** (CSP blocks eval first); `new Function` was never audited — `AS:12319-12338`, `:9291-9305`. *Fix: keep or remove deliberately; audit `new Function` too if CSP ever relaxes.*
- **SEC-69 — CSP split-brain** — `RELAXED_CSP_META` and the authoritative server header must be edited in lockstep or wasm policy silently diverges — `AS:13056-13076`; `server/core/index.js:581-593`. *Fix: single source of truth consumed by both.*
- **SEC-70 — `window.nova` is mutable/never frozen** (`nova.browser` bolted on later) while `novaOS` is frozen — `AS:11550`, `:12911` vs `:10361`. *Fix: freeze after bolt-on.*
- **SEC-71 — FrameSecurity observer is audit-only by default** (detect, never remediate) — `js/platform/security/frame-security.js:467`, `:610`, `:695`. *Fix: enable autoSecurify in kiosk builds.*
- **SEC-72 — mailto/webcal default-app settings are decorative** — `OS.openMailto` hardcodes `com.nbosp.email`; nothing handles `webcal:` — `js/apps/default-apps/service.js:102-103`; `js/apps/registry/service.js:205-208`, `:221-225`. *Fix: route through DefaultApps or drop the settings.*
- **SEC-73 — Web-app bootstrap auto-grants `net:external`/`net:websocket`** and wraps wa_/webapp_ apps; the new-web-app watcher runs only 5 minutes after boot — `app-permissions-bootstrap.js:105-141`, `:252-253`, `:265-291`. *Fix: persistent watcher or install-time gating.*
- **SEC-74 — init.js localStorage secret-guard is name-based** (regex on key names) and patchable by capturing the original reference; values unfiltered; `lockPin` hash doesn't match the regex — `js/core/core/init.js:79`. *Fix: seal the storage interface at boot.*
- **SEC-75 — `/Shared` pre-scoping entries stay writable by anyone "for compat"**; single-user sessions treated as admin — `js/core/services/fs.js:1004`; `user-scope.js:143-147`. *Fix: migration to scoped entries.*
- **SEC-76 — fs native jail loads ≤4 MiB file contents into node objects on listing** (host memory exhaustion via folder of ~4 MB files) — `fs.js:714-716`. *Fix: metadata-only listing.*
- **SEC-77 — Scanner gaps** — `.js/.css/.json` skip active-content checks by design; manual install path fails open on scanner exceptions (IPC path fails closed); entropy/base64 caps mean oversized payloads scan only their head — `js/apps/scanner/service.js:296-299`, `:208-209`; `appmanager/app.js:2429-2432` vs `AS:5926-5933`. *Fix: fail closed everywhere; document the skips.*
- **SEC-78 — Default-apps id validation accepts any non-empty string ≤200 chars**; any registered app with overlapping `handles` appears in every Open-With dialog — `default-apps/service.js:129-131`. *Fix: require reverse-domain shape.*
- **SEC-79 — NetworkLog is mutable** (not frozen); unrestricted apps can push forged entries or steal `_renderFn`; entries include full URLs (query-string secrets) — `js/apps/network-activity-log/service.js:3`; `js/apps/browser/app.js:3437-3453`. *Fix: freeze; redact query strings.*
- **SEC-80 — Search prefetches DuckDuckGo on raw ≥3-char keystrokes before commit; search activation bypasses DefaultApps entirely** (hardcoded gallery/music/textedit) — `js/apps/search/app.js:491-496`, `:409-416`. *Fix: prefetch on commit; route through DefaultApps.*
- **SEC-81 — Legacy hard-coded `sessions.db` path ignores `NBOSP_DATA_DIR`** — with a custom data dir, `/api/security/sessions` reads/revokes the wrong DB — `server/core/security/routes.js:223`; called out at `auth-routes.js:26-29`. *Fix: use runtime-data-dir.js.*
- **SEC-82 — `requestSizeLimit` checks only the `Content-Length` header** (bypassable via chunked); real cap is express.json 10 MB — `security/middleware.js:614-633`. *Fix: stream-aware accounting.*
- **SEC-83 — `csrfTokenMiddleware` force-saves a session for every request** (incl. static assets) — session-row growth per anonymous client — `security/middleware.js:308-331`. *Fix: skip non-/api paths.*
- **SEC-84 — Login/reverify/change-* return HTTP 200 with `success:false` on bad credentials** — monitoring must parse bodies — `auth-routes.js:226-229`, `:368-375`, `:410-414`. *Fix: 401s (deliberate console-noise fix; revisit).*
- **SEC-85 — Hand-rolled WebAuthn never verifies `authenticatorData` rpIdHash or UV/UP flags; registration trusts a client-supplied key** (attestation `none`) — `auth-routes.js:711-717`. *Fix: add rpIdHash/flag checks.*
- **SEC-86 — `POST /api/security/report` uses client-supplied `ipAddress` to drive IP blocking** — logged-in page can blocklist arbitrary IPs — `security/routes.js:568-578`. *Fix: derive IP server-side.*
- **SEC-87 — Duplicate `/api/events` mount (dead second mount); two env validators with different minimums** (hand-written .env passes server check, fails client schema) — `server/core/index.js:180` + `routes.js:21`; `core/env.js` vs `scripts/env.js`. *Fix: remove dead mount; unify validators.*
- **SEC-88 — Email routes entirely CSRF-exempt (SameSite=lax only); suspended/locked sessions refused only on admin routes**, not on change-pin etc. — `security/middleware.js:56-59`; `auth-routes.js` (`requireAdminRole` only). *Fix: enforce session state on all auth routes.*
- **SEC-89 — Kiosk serial console mirrors debug output incl. `/proc/<pid>/environ` dumps to ttyS0** — `S99nbosp:145-146`, `:249`. *Fix: disable in production images.*
- **SEC-90 — Kiosk device nodes owned by the kiosk user** (renderD*, sound; video group on /dev/dri/card*) — bypasses seatd arbitration — `rootfs-overlay/etc/udev/rules.d/70-nbosp-device-groups.rules:1-3`. *Fix: group ownership only.*
- **SEC-91 — Kiosk session crash-loop: 5 restarts then dead VT1 with root debug console available; "boot watchdog" routing mentioned but not implemented in S99nbosp** — `S99nbosp:441`, `:61-62`. *Fix: implement the watchdog route to Recovery.*
- **SEC-92 — Recovery restore extracts root `tar -xzf -C /` from arbitrary media**; path filter blocks `..`/non-home but symlink-then-file entries may escape — `nbosp-recovery:201-204`. **[suspected]** (busybox-tar dependent). *Fix: `--no-same-permissions` + symlink refusal, or use a hardened extractor.*
- **SEC-93 — Store client fetch has no size cap** (JSON-parses whatever `app.file` returns; compromised catalog row could point anywhere https); website integrity check weaker than OS (`method:'none'` → true) — `store/app.js:203-218`; `src/logic.js:144` vs `AP:361`. *Fix: cap fetch size; fail closed on the website.*
- **SEC-94 — Publisher: automated-review failure does not reject a submission** (`status:'pending'` anyway; README/DB describe a harder gate the code no longer applies); community entries override the static catalog client-side by id — `supabase/functions/index.ts:205-223`; `publishing.js:48-50`; `store/app.js:527-536`. *Fix: enforce or fix the docs/DB.*
- **SEC-95 — Reserved-ID shadowing** — a package signed by the *general* trusted-signing (community CA) key with id `com.nbosp.settings` passes the reserved-id gate; only `manifest.system:true` claimants get the impersonation dialog — `AR:286-288`; `appmanager/app.js:176-184`. *Fix: require System signer for reserved ids.*
- **SEC-96 — Test infrastructure** — fake-idb comparator throws on array-vs-scalar keys used by the production storage layer (4/9 integration suites red on Node 24); `app-package.test.js` contains two near-duplicate describe blocks (same assertions twice) — `tests/helpers/fake-idb.js:25`; `AS:6694`, `:6723`, `:6788`; `tests/platform/core/app-package.test.js:12` vs `:380`. *Fix: order array/scalar keys per the IndexedDB spec; dedupe the test blocks.* (Part VII.)

**Fix-first order (highest leverage):** SEC-01 (test key) → SEC-02 (dev flags/F12) → SEC-03+SEC-04 (image root exposure) → SEC-19 (shared-file consent) → SEC-96 (fake-idb, restores CI signal) → SEC-05 (factory reset) → SEC-06 (PIN brute force) → SEC-10/SEC-11 (grant + registry read models) → SEC-13 (Store consent) → SEC-14 (SSE leak).

### Positive security findings (what is solid)

For balance and to protect these properties during remediation — the following were verified as correctly implemented:

| Property | Refs |
|---|---|
| Two-realm IPC hardening: forgeable tagged postMessage replaced by a one-shot MessageChannel port handshake ("possession of the port is the credential"); inbox/pull globals moved out of guest reach; host `respond()` targets the isolated world with base64-encoded payloads | `AS:10050-10078`, `:10206-10230`, `:11083-11100`, `:1631-1648` |
| fetch/XHR/WebSocket lockdown non-writable/non-configurable; native `WebSocket` constructor override closes the zero-permission raw-socket gap | `AS:12302-12308`, `:12218-12297` |
| App-IPC invoke hardening: caller AND target need `apps:communicate`; endpoints must be manifest-declared; target must be live; payloads clamped both directions; replies bound to target sandbox; sandbox closure cancels pending calls; broadcast re-checks the receiver's live grant | `AS:6195-6286`, `:6288-6339` |
| Cross-owner storage isolation enforced at stamp time (guest cannot construct a cross-owner address); 2 GB per-user ceiling; data envelopes appId-pinned and sha256-checksummed, cross-app restore `POLICY_BLOCKED` | `AS:6628-6634`, `:6752-6768`, `:7064-7067` |
| NB-MAC: default-deny for uncovered endpoints, neverallow anchors on `nova:admin:*`, policy/coverage linter, permissive rollout mode, rate-limited avc audit ring | `AS:697-940`, `:980-1008` |
| Registry engine: atomic tmp+rename persistence (0600/0700), clone-validate-swap (rejected writes never half-apply), sealed-phase guard after logout, boot snapshots, corrupt-hive quarantine | `NREG:266-274`, `:584-610` |
| Permission-prompt hardening: dialog text via textContent only (appName/reason untrusted), appId colon guard, own-property reason lookup (blocks `constructor` probes), 500-char reason cap, dialogs force-close as denial on teardown | `APM:1026-1032`, `:375-386`, `:305-317`, `:1241-1288` |
| Launch-option injection escaped (`</script>`, `&`, U+2028/2029 → `\uXXXX`) | `AS:13150-13160` |
| CSP: `unsafe-eval` removed (wasm-only remains), server header authoritative over the meta tag | `AS:13071`; `server/core/index.js:581-593` |
| IPC install path fails closed on scanner errors (manual path does not — SEC-77) | `AS:5926-5933` |
| Boot re-verification: bundled packages re-verified (signature/integrity/payloadHash) every boot; stale trust flags repaired; revoked packages re-prompted with a non-dismissable dialog | `boot.js:933-1032`, `:1082-1390` |
| UnrestrictedGate 6-check deny ladder, fail-closed when AppPackage is missing | `unrestricted-gate.js:141-176` |
| Email preview hardening: allowlist sanitizer + SSRF-safe image proxy with DNS pinning and per-hop re-validation; preview under `script-src 'none'` | `email/helpers.js:243-253`; `email/proxies.js:690-751`; `email/controller.js:421-448` |
| Session token discipline: `X-Nova-Session` never handed to webviews; account switch fully unmounts the previous tree | `session/service.js:8-11`, `:414-423` |
| Partition cleanup fail-closed (failed wipes block relaunch until they succeed); escape-popup consent re-checked per popup, fail-closed | `AS:14362-14385`, `:13583-13599` |
| Legacy aliasing is translate-then-enforce — never weakens MAC or handler gates | `AS:9501-9554` |
| Push tokens CSPRNG fail-closed; appId derived from the trusted host mapping, never from the publisher | `AS:8269-8279`; `push-bus.js:53-60` |
| Cloud-metadata literals (169.254.169.254, fd00:ec2::254) blocked before classification; protocol-relative and credential-bearing URLs rejected | `AS:1258-1266`, `:1312-1318` |
| Publisher backend: server-side token validation on every action, admin email re-check, signed 1-hour single-file download URLs, atomic publish RPC with row locks, submission quota, orphan-upload cleanup | `publisher.ts:206-220`, `:222-226`, `:328`; `index.ts:247-252`; SQL `:125-194` |

---

## Part II — Wrong claims in the old doc (42 WRONG verdicts)

All 42 WRONG verdicts from verdicts-1…4, grouped by doc section. Security-relevant claims first (marked **[sec]**). Each row: claim [doc-line] vs reality [code-line].

### Security-relevant wrong claims (14)

| # | Doc line | Claim | Reality | Code ref |
|---|---|---|---|---|
| 1 [sec] | NOVAAPP.md:1153 | Picked file id usable via `nova:fs:*` "with a confirmation for shared-file changes" | Only delete/overwrite ever prompt; write/rename/move mutate silently | `AS:1875-1880`; call sites `AS:2438`, `:2468`, `:2654`, `:2673` |
| 2 [sec] | NOVAAPP.md:1163 | "modifying, renaming, moving, or deleting [a picked file] asks the user to confirm" | Only deletion (and picker-save overwrite) confirm | `AS:1875-1880` |
| 3 [sec] | NOVAAPP.md:1201 | "destructive changes through nova:fs require a separate confirmation" | Same — modify/rename/move never confirm; "confirmation required" branches unreachable | `AS:1875-1880`, `:2440`, `:2656`, `:2675` |
| 4 [sec] | NOVAAPP.md:981 | "There is no package-enumeration API through this broker" | `nova:app:list` (only `system:apps`) returns full inventory incl. signer/verified/devOnly | `AS:5726-5757` |
| 5 [sec] | NOVAAPP.md:1126 | Wallpaper writes bounded by IPC payload budget; "handle PAYLOAD_TOO_LARGE" | `ipcPayloadBytes` applies to app-ipc only; `customWallpaper` is string-checked and excluded from the 256 KB registry quota — no cap of any kind; `PAYLOAD_TOO_LARGE` fires only for net:fetch bodies | `AS:6122`, `:3003-3006`, `:6440`; `NREG:166-167` |
| 6 [sec] | NOVAAPP.md:2035 | `UNVERIFIED` — "nova:app:install rejected an unsigned or trust-store-unverified package" | `UNVERIFIED` = missing integrity record only; unsigned/untrusted-signer rejections use `UNTRUSTED` | `AS:5942` vs `:5969` |
| 7 [sec] | NOVAAPP.md:2044 | `PAYLOAD_TOO_LARGE` — IPC payloads over the app's `ipcPayloadBytes` budget | Over-budget app-IPC rejects `INVALID_ARGS` ('IPC payload exceeds the N KB limit'); `PAYLOAD_TOO_LARGE` is net:fetch binary bodies only | `AS:6222-6224` vs `:6440` |
| 8 [sec] | NOVAAPP.md:1773 | HKNU table row "writer: registry.system only" | `registryScopes.write` prefixes and the default `HKNU/software/<appId>` scope unlock HKNU writes with plain `registry.write` | `AS:3170-3172`, `:3119-3124` |
| 9 [sec] | NOVAAPP.md:1813 | `registryScopes` is "a bounded list (32 entries max)" | No 32-entry cap exists anywhere; only ACL entries are capped at 32 | `AS:3104-3141`; `NREG:93` |
| 10 [sec] | NOVAAPP.md:2072 | MAC and storage ledger "are enforced host-side before any handler runs" | Only MAC runs pre-handler; ledger budgets are enforced in-handler and are "best-effort telemetry, NOT security boundaries" | `AS:9584-9596`, `:247-250` |
| 11 [sec] | NOVAAPP.md:1938 | Tier-2 Terminate notification is "the only way the process stops short of the app exiting" | App Manager Force Stop / disable / uninstall also `forceKill` background sandboxes | `js/apps/shell-ui/wm.js:443-450`; `appmanager/app.js:2097-2111` |
| 12 [sec] | NOVAAPP.md:1944 | Autostart apps behind a lock screen "wait until the user unlocks" | Locked-at-boot skips the pass entirely — apps never launch that boot | `js/core/core/boot.js:1141-1145` |
| 13 [sec] | NOVAAPP.md:300 | "If the nested-webview grant is absent, `window.nova.browser` is not available" | Availability keys on the manifest opt-in; with opt-in but no grant the API exists and every host call fails `PERMISSION_DENIED` | `AS:12911`, `:11026-11027`; test `app-sandbox.test.js:1237` |
| 14 [sec] | NOVAAPP.md:854 | v2 facade "covers every v1 channel family in full — nothing … is left facade-less" | 10 families have no v2 facade: `nova:appearance:*`, context-menu, overlay, download, home, `nova:wallpaper:set`, app-ipc (`nova:ipc:*`), nested-webview, raw `nova:net:fetch` | `AS:10361-11033` |

### Events (12 documented event names with no emitter)

| # | Doc line | Claim | Reality | Code ref |
|---|---|---|---|---|
| 15 | NOVAAPP.md:1867 | `system:notification` fires on system notifications | No emitter anywhere in production code; subscribing is a silent no-op | `AS:6021-6065` (allowlist only) |
| 16 | NOVAAPP.md:1868 | `system:volumeChanged` | No emitter; tray emits `os:volumeChanged`, which is *not* subscribable | `js/apps/tray/service.js:147` |
| 17 | NOVAAPP.md:1869 | `system:themeChanged` | No emitter (theme changes emit `settings:changed`, not subscribable) | `settings-shim.js:167` |
| 18 | NOVAAPP.md:1870 | `system:workspaceChanged` | No emitter | — |
| 19 | NOVAAPP.md:1871 | `system:power` | No emitter | — |
| 20 | NOVAAPP.md:1872 | `system:network` | No emitter | — |
| 21 | NOVAAPP.md:1873 | `app:installed` | No emitter (AppRegistry uses callbacks + EventLog) | — |
| 22 | NOVAAPP.md:1874 | `app:uninstalled` | No emitter | — |
| 23 | NOVAAPP.md:1875 | `app:launched` | No emitter; wm.js emits `app:opened/closed/focused` — not allowlisted | `wm.js:406/516/759` |
| 24 | NOVAAPP.md:1876 | `mail:new` | No emitter; code comment: "subscribing today is a no-op" | `AS:6025-6037` |
| 25 | NOVAAPP.md:1877 | `mail:updated` | No emitter | `AS:6025-6037` |
| 26 | NOVAAPP.md:1878 | `calendar:reminder` | No emitter (calendar-notifier posts a notification, never the bus event) | — |

### Manifest, build, and default apps (6)

| # | Doc line | Claim | Reality | Code ref |
|---|---|---|---|---|
| 27 | NOVAAPP.md:3 | Studio setup/templates/builds "covered in the NovaByte Studio README" | Repo README has a 5-line section linking out to the external novapack-studio repo; no such coverage | `README.md:96-101` |
| 28 | NOVAAPP.md:74 | `icon` defaults to `"box"` | Default is `/assets/no_app_icon.svg` | `AR:446`; `NAL:50-53` |
| 29 | NOVAAPP.md:75 | `type` defaults to `"blank"` | Defaults are `'webapp'` (registry) / `'package'` (launcher) | `AR:446`; `NAL:751` |
| 30 | NOVAAPP.md:86 | `categories` defaults to `[]` | Registry default is `['other']` | `AR:451` |
| 31 | NOVAAPP.md:149 | openWith success resolves `{ cancelled: false, success, appId, windowId, defaultSaved }` | Success shape has **no** `cancelled` key (only cancel paths set it) | `js/apps/shell-ui/desktop.js:1882-1887` |
| 32 | NOVAAPP.md:170 | Build "reads and validates manifest.json (or novaapp.json)" | In-repo builder reads `manifest.json` only and performs no validation (validation is install-time); `novaapp.json` accepted nowhere | `build-apps.mjs:473-483`; `AP:780-1001` |

### Permissions, storage, IPC (3)

| # | Doc line | Claim | Reality | Code ref |
|---|---|---|---|---|
| 33 | NOVAAPP.md:639 | "Optional sensitive permissions are not prompted at launch" | True only for the registry/desktop path; the App Manager launch gate prompts required **and** optional together | `appmanager/app.js:818-827` vs `AR:676-687` |
| 34 | NOVAAPP.md:714 | "There is no `window.__novaPrivateStore` object" | The legacy web-app bridge defines a working, localStorage-backed `__novaPrivateStore` | `NAL:891-903`, `:1074`, `:1175` |
| 35 | NOVAAPP.md:898-937 | Example `dialog.pickSave({ defaultName: 'out.txt' })` | No handler reads `defaultName`; pickers take `suggestedName` or `filename` — silently ignored | `AS:9106-9107`, `:9227`; facade `:10607-10612` |

### Filesystem, mail, system info, ready, errors, compatibility (7)

| # | Doc line | Claim | Reality | Code ref |
|---|---|---|---|---|
| 36 | NOVAAPP.md:1191 | mkdir: "omit path for app root" | Omitted path resolves the parent to the filesystem **root** `/` and fails `PERMISSION_DENIED` without fs:access; in-code comment's intent doesn't match implementation | `AS:2613-2629` |
| 37 | NOVAAPP.md:1562 | `smtpHost` **and** `smtpPort` mandatory for send | Only `smtpHost` required; port defaults (server: `|| sess?.smtpPort || 587`) | `AS:5647-5648`; `email/controller.js:298` |
| 38 | NOVAAPP.md:1584 | `nova:system:info` returns `{ osVersion, securityPatch, platform, … }` | Actual: `{ success, os: { version, securityPatch, username, uptime } }` — no top-level `osVersion`/`platform`; `username`+`uptime` undisclosed (see SEC-24) | `AS:7446-7454` |
| 39 | NOVAAPP.md:1833 | `ready.get()` "only reads" — not a re-handshake | `ready.get()` rides `handleReady`, which re-runs the queued-alarm/inbound-share/push flushes after responding | `AS:8743-8770` |
| 40 | NOVAAPP.md:2032 | `TIMEOUT` — "an interactive flow (save dialog, share sheet) timed out" | `TIMEOUT` is thrown only by the nova:download save dialog and isolated-process dispatch; interactive timeouts are client-side codeless `TypeError`s (no `.code`) | `AS:3855`, `:9655`, `:11133` |
| 41 | NOVAAPP.md:2039 | `INVALID_CONTACT` — "contact write malformed (needs an id and a name)" | Only a name is required; id is optional and auto-generated | `AS:7408` |
| 42 | NOVAAPP.md:2291 | Permissions table: `vfs:meteded` (typo) translated to `fs:metadata` | Only a *channel* alias; as a permission it is stripped as unknown (5 legacy aliases only) | `AR:75-81`; `AS:9548-9552`; `app-registry.test.js:181` |

Verification: the 42 rows above map 1:1 to the verdict files' WRONG tallies — verdicts-1 (7): doc lines 3, 74, 75, 86, 149, 170, 300 → rows 27, 28, 29, 30, 31, 32, 13 · verdicts-2 (7): 639, 714, 854, 898-937, 981, 1126, 1153 → rows 33, 34, 14, 35, 4, 5, 1 · verdicts-3 (5): 1163, 1191, 1201, 1562, 1584 → rows 2, 36, 3, 37, 38 · verdicts-4 (23): 1773, 1813, 1833, 1867, 1868, 1869, 1870, 1871, 1872, 1873, 1874, 1875, 1876, 1877, 1878, 1938, 1944, 2032, 2035, 2039, 2044, 2072, 2291 → rows 8, 9, 39, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 11, 12, 40, 6, 41, 7, 10, 42.

### WRONG claims by doc section (where the doc is weakest)

| NOVAAPP.md section | Lines | WRONG | Rows |
|---|---|---|---|
| Title & intro | 1-3 | 1 | 27 |
| Manifest format | 5-163 | 3 | 28, 29, 30 |
| Build process | 166-200 | 1 | 32 |
| App runtime (launch, sandbox, OAuth, browser apps) | 202-556 | 2 | 13, 31 |
| Permissions | 559-706 | 1 | 33 |
| Storage & data portability | 714-848 | 1 | 34 |
| Platform API v2 | 854-939 | 2 | 14, 35 |
| Inter-app communication | 981-1030 | 1 | 4 |
| Desktop wallpaper | 1098-1127 | 1 | 5 |
| Picker-scoped files | 1131-1155 | 1 | 1 |
| Filesystem & path rewriting | 1157-1235 | 3 | 2, 3, 36 |
| Mail | 1535-1578 | 1 | 37 |
| System info / locale / badge | 1580-1616 | 1 | 38 |
| NovaByte Registry | 1766-1821 | 2 | 8, 9 |
| Ready snapshot | 1823-1833 | 1 | 39 |
| **Event bus** | 1835-1886 | **12** | 15-26 |
| Background execution | 1888-1944 | 2 | 11, 12 |
| Error codes | 2015-2049 | 4 | 6, 7, 40, 41 |
| Security model | 2054-2122 | 1 | 10 |
| Compatibility | 2265-2316 | 1 | 42 |
| All other sections (OAuth URLs, appearance, share, notifications, clipboard, window, net, ws, geolocation, camera, calendar, contacts, app mgmt, admin, share-target, secrets, alarms, push, settings, pickers, scanner, package format, signatures, integrity, distribution) | — | 0 | — |

The event-bus table is the single worst section (12 of its 18 rows are phantom); error-code semantics and the manifest/runtime defaults follow.

### CORRECT claims with caveats the replacement doc should absorb

Verdicted CORRECT, but the notes flagged qualifications that change what the new doc should say:

| Doc line | Claim | Caveat | Refs |
|---|---|---|---|
| NOVAAPP.md:96 | "A package cannot gain [system] by setting `system: true`" | True only as strong as the test-key reality (SEC-01) — the gate is crypto on release builds, convention on test-key builds | `AR:422-443`; `keys/README.md:19-25` |
| NOVAAPP.md:189 | Default builds sign with the "committed public test pair" | "Public" is a misnomer — the committed file includes the private half | `keys/test-system-key.json:5` |
| NOVAAPP.md:149 | openWith result consumed via truthiness | Works, but the success shape has no `cancelled:false` key (WRONG #31 covers the shape) | `desktop.js:1882-1887` |
| NOVAAPP.md:214 | Auto-grant set = "public internet, WebSockets, clipboard writing, notifications" | Subset — six more low-risk perms also auto-grant (fs:watch, system:app-launch, data:*, registry.read, system:badge) | `APM:151-173`; `AR:672-674` |
| NOVAAPP.md:108-114 | App-id validity list | `webapp_` prefix bypasses the id regex entirely (real, used by web shortcuts) | `AP:828-831`; `js/apps/registry/service.js:117,130` |
| NOVAAPP.md:208 | Install "checks the signature, prompting the user if it fails" | System-impersonation claims hard-block with no override | `appmanager/app.js:2512-2515` |
| NOVAAPP.md:883 | ready snapshot includes `username` | Returned only for system-bundled apps; third-party gets null | `AS:8733`, `:10778` |
| NOVAAPP.md:1471 | `app.getInfo()` returns "info about this app" | Payload is ignored entirely — always the calling app's record | `AS:4358-4372` |
| NOVAAPP.md:2112 | "Every file inside a .novaapp package is run through window.Scanner" | App Manager/Files/IPC paths only — Packages/Store/my-apps skip it (U-59) | `scanner/service.js:13-16`; `packaging.md §3.3` |
| NOVAAPP.md:2183 | "Unverified … the OS shows a clear warning first" | App Manager only — the Store shows no warning (SEC-13) | `store/app.js:544-566` |
| NOVAAPP.md:2226 | Drag-and-drop install | Scanner exceptions fail open on this path (IPC path fails closed) | `appmanager/app.js:2429-2432` |
| NOVAAPP.md:572 | Full permission list mirrors the catalog | Code exact; the Settings UI label map drifts (missing contacts:delete, system:root, registry.*, sandbox:*) | `settings/app.js:144-161`, `:2176` |
| NOVAAPP.md:1420 | Mail "SSL is mandatory (plaintext rejected)" | Mail is the *only* surface that enforces it — net:* permits plaintext (SEC-20) | `AS:5504-5507` vs `:218` |

### Doc-line fix checklist (for the replacement guide)

Lines in NOVAAPP.md whose content must change or be dropped in the successor doc:

```text
3        Studio coverage claim → link out explicitly, don't claim coverage
74       icon default → /assets/no_app_icon.svg (or "no default; fallback asset")
75       type default → 'webapp'/'package'
86       categories default → ['other']
149      openWith success shape → no cancelled key
170      build step → manifest.json only; validation is install-time
300      nova.browser availability → manifest opt-in gates availability; grant gates calls
639      optional-permission prompting → differs by launch path (App Manager prompts both)
714      __novaPrivateStore → exists in the legacy fallback bridge
854      v2 coverage → list the 10 v1-only families
898-937  pickSave example → suggestedName (defaultName is ignored)
981      package enumeration → nova:app:list exists (system:apps)
1126     wallpaper cap → no host-side cap; drop PAYLOAD_TOO_LARGE mention
1153     shared-file confirmation → delete/overwrite only
1163     shared-file confirmation → delete/overwrite only
1191     mkdir path → always pass '/data/'; omitted path fails
1201     destructive-change confirmation → delete/overwrite only
1562     smtpPort → optional (defaults 587 / session value)
1584     system:info shape → { os: { version, securityPatch, username, uptime } }
1773     HKNU row → writable via scopes + default HKNU/software/<appId>
1813     registryScopes 32-cap → remove (no cap; ACL entries capped at 32)
1833     ready.get() → re-runs queue flushes (not read-only)
1867-78  event table → only ws:*, reg:changed, calendar:updated, contacts:updated fire
1938     Terminate-only → Force Stop/disable/uninstall also kill
1944     autostart-while-locked → skipped, not deferred
2032     TIMEOUT → download + isolated dispatch only; interactive = codeless TypeError
2035     UNVERIFIED → missing integrity record; UNTRUSTED = signer failure
2039     INVALID_CONTACT → name only
2044     PAYLOAD_TOO_LARGE → net:fetch bodies only; app-IPC = INVALID_ARGS
2072     pre-handler enforcement → MAC only; ledger is in-handler telemetry
2291     vfs:meteded → channel alias only, not a permission alias
```

---

## Part III — Outdated and DOC-ONLY claims

### OUTDATED (2)

| Doc line | Claim | Current reality | Code ref | Action |
|---|---|---|---|---|
| NOVAAPP.md:559 | "Grants persist across sessions in localStorage (validated structurally on load)" | Grants persist registry-first (`HKNS` or per-account `HKNU` `security/appPermissions`); localStorage is only the pre-registry/fail-soft fallback. Hides per-account scoping on multi-user installs and the host-realm-readable legacy store | `APM:421-451`; `registry-system-state.js:265-268` | Reword: registry-first persistence, per-account on multi-user |
| NOVAAPP.md:1525-1528 | admin usersList/usersRevoke: "sessions means active browser/app sessions, not accounts — this OS is single-user" | Session verbs still work, but a multi-user layer now exists: `isAdminSession()` + 18 `accounts.*` verbs against `/api/auth/admin/*` (create/disable/lock/delete/setPin/webauthn…), plus per-user storage/mounts | `AS:4710-4739`, `:4761-4769` | Update: describe both session and account verbs; drop "single-user" |

### DOC-ONLY (6; brief tally 5 — verdicts-2 contains one additional, all listed)

Handling: DOC-ONLY items are not false — they are claims about nothing in this codebase (advice, history, or external-tool behavior). The replacement doc should either keep them clearly marked as such (advice/policy) or move them to the artifact they describe (Studio README).

| Doc line | Claim | Status | Refs | Action |
|---|---|---|---|---|
| NOVAAPP.md:7 | "`novaapp.json` is also accepted" [as manifest name] | No code path accepts it (builder, installer, store, app manager all `manifest.json`-only); could only be true of the external Studio tool | `build-apps.mjs:473-483`; repo grep | Drop, or mark Studio-only |
| NOVAAPP.md:740 | "the initial v2 capability is `storage.v2`" | `storage.v2` is a supported capability; nothing in code marks which shipped first — doc history framing, uncontradicted | `AS:10261` | Keep as history note or drop "initial" |
| NOVAAPP.md:2108 | "Add `defer` as well if you also run the page outside NovaByte OS" | Advice only; consistent with defer normalization (existing defer attr stripped and re-added) | `AS:13046-13049` | Keep (portability advice) |
| NOVAAPP.md:2122 | "None of this [scanner] affects `vendor/` libraries bundled at Build time" | No `vendor` special-casing exists in scanner or builder (0 grep hits); a high-entropy minified vendor file **would** be flagged | `scanner/service.js`; `build-apps.mjs` | Drop or document the real behavior |
| NOVAAPP.md:2277 | "Runtime APIs and permissions can differ between hosts and forks" | Advisory statement; fork surface unverifiable from this repo | — | Keep as advisory |
| NOVAAPP.md:2281 | "Removal [of capabilities] is not a thing … at most they stop being documented as recommended" | Forward-looking policy; no removal code exists to verify against | `AS:10259-10260` | Keep as policy statement |

---

## Part IV — Undocumented behaviors (70 U-items, deduped)

Behaviors the code exhibits and NOVAAPP.md never mentions. Deduped across verdicts-1…4 (e.g. `window.nova` mutability appears in three verdict files — one row; `__novaPrivateStore` from verdicts-1 U3 and verdicts-2 U18 merged). All **[confirmed]**.

### Sandbox, bridge, and CSP (source: verdicts-1 U1-U12, verdicts-2 U1/U9/U15, verdicts-3 U5-U6, verdicts-4 U1/U2/U5-U7/U15)

| # | Behavior | Refs |
|---|---|---|
| U-01 | NB-MAC front door: every guest IPC call checked against `MacPolicy.checkIpc` (grant-coupled/advisory rows, default-deny) before any handler; avc-style denial ring `novaOS_mac_audit` in localStorage | `AS:534-681`, `:838-876`, `:9584-9596` |
| U-02 | `window.nova` is mutable/never frozen (`nova.browser` bolted on later by mutation); `window.novaOS` is `Object.freeze`d | `AS:11550`, `:12911` vs `:10361` |
| U-03 | Manifest `sandbox` object accepts more tokens than documented: `allowScripts`, `allowForms`, `allowPopups`, `allowModals` map to sandbox-attr tokens; `allow-downloads` always added | `AS:13461-13485` |
| U-04 | `webapp_*` (web shortcut) apps get **no** capability shim — no `window.nova`/`novaOS` at all | `AS:13176-13188`, `:13834-13836` |
| U-05 | Every sandbox launch inserts a 250 ms pre-navigation delay (NW.js addContentScripts race, nwjs#7597); `removeContentScripts` is never called anywhere | `AS:14328` |
| U-06 | `deferPackagedScripts` also strips `async` and forces `defer` on every packaged external script — apps cannot opt into async startup | `AS:13041-13050` |
| U-07 | `fetch`/`XMLHttpRequest`/`WebSocket` overrides installed non-writable/non-configurable (`delete window.fetch` cannot un-shadow); native `WebSocket` constructor is replaced and mediated through `nova:net:websocket` | `AS:12302-12308`, `:12218-12297` |
| U-08 | `navigator.sendBeacon` overridden to fire-and-forget through `nova:net:fetch`; returns `true` unconditionally (permission outcome dropped) | `AS:12344-12352` |
| U-09 | `<a download>` clicks in the app's own webview are intercepted and routed through the `nova:download` OS save dialog; `allow-downloads` always granted | `AS:11405-11458`, `:13477-13485` |
| U-10 | Webview partitions are user-scoped: `persist:u<uid>_app_<id>` on multi-user, volatile `guest_app_<id>` for guests (doc only ever names `persist:app_<appId>`) | `AS:13749-13765` |
| U-11 | Partition wipe on close keys off the *effective sandbox attribute*, not the grant (grant-without-manifest-flag still wiped) | `AS:14481-14487` |
| U-12 | NovaBrowserView exposes an undocumented annotation/freeze API (8 methods — see Part V B2) | `AS:12731-12909` |
| U-13 | Nested-webview `permissionrequest` shim hands apps `allow`/`deny` callbacks that are empty no-ops (real decisions host-side) | `AS:11181-11188` |
| U-14 | Guest-realm prototype patches (innerHTML/outerHTML/createElement) are `configurable: true` — re-patchable by guest code (MutationObserver is the real enforcement) | `AS:12598-12668`, `:12964-13029` |
| U-15 | Human-dialog channels (dialog/sysdialog/files, download, share, open-with, context-menu, clock:alarm:dialog) get a 10-minute timeout instead of the default 60 s | `AS:11040-11053` |
| U-16 | Shim client-side timeout rejects with a codeless `TypeError('IPC request timed out: …')` — escapes the documented `.code`/`.message` error contract | `AS:11133` |
| U-17 | App-IPC payloads over the `ipcPayloadBytes` budget reject `INVALID_ARGS`, not `PAYLOAD_TOO_LARGE` | `AS:6222-6224` |
| U-18 | Every resolved IPC value carries result fields both flattened and under `.result` (compat hack) | `AS:11358-11361` |
| U-19 | Background/isolated worker processes restricted to `ISOLATED_PROCESS_API_TYPES` allowlist (no dialogs, events, app-ipc, websockets, registry, app management) | `AS:9465-9490` |

### Filesystem & storage (source: verdicts-2 U2-U4/U12-U14/U17, verdicts-3 U8/U10-U11/U15-U18)

| # | Behavior | Refs |
|---|---|---|
| U-20 | `nova:storage:get` fails open — IndexedDB errors return `{success:true, value:null}`, indistinguishable from a missing key (SEC-21) | `AS:6885-6889` |
| U-21 | Hard per-user storage ceiling of 2 GB (beyond the per-app budget) → `STORAGE_FULL` | `AS:6778-6781` |
| U-22 | `nova:data:export` key lists capped at 1000 entries | `AS:7145-7146` |
| U-23 | `nova:clipboard:write` keeps a host-side 30-entry history (`OS.clipboardHistory`) | `AS:3772-3777`, `:214` |
| U-24 | Any single media grant (or `fs:metadata`) enumerates shared-tree folder structure via `nova:fs:read`/`list` (folders always pass `resolveFile`; only file rows metadata-gated) | `AS:2343-2346`, `:2549-2552` |
| U-25 | Undocumented window limits: `setTitle` caps 200 chars; `resize` clamps min 100 px, defaults 800×600 on invalid input | `AS:3661`, `:3675-3676`, `:226-228` |
| U-26 | Picker `accept` string form (≤512 chars) passes through unvalidated (arrays strictly validated) | `AS:8815-8823` |
| U-27 | `nova:sysdialog:open` multi-select capped at 25 files (`LIMIT_REACHED`) | `AS:8829`, `:8950-8952` |
| U-28 | Files-app install handoff caps packages at 32 MiB — the only install path with a size cap | `js/apps/files/app.js:1667-1671` |
| U-29 | fs:watch budgets: 8 watchers/app, 60 pushes/min, 2 s poll + 300 ms debounce; rate-limited events silently coalesced | `AS:7609-7612`, `:7688-7690` |
| U-30 | fs:watch `watcherId` is caller-suppliable (`^w_[a-z0-9_]{4,64}$`); re-registering your own id replaces without burning budget; foreign ids never hijacked | `AS:7739-7760` |
| U-31 | Media index caps: 5000 files indexed, query limit default 100 / hard cap 500, refresh at most every 30 s | `MED:9-10`, `:79`, `:90` |
| U-32 | `nova:app:info` ignores its payload entirely — always answers with the calling app's own record (doc example's `appId` arg is a no-op) | `AS:4358-4372` |

### Network (source: verdicts-1 U9, verdicts-2 U16, verdicts-3 U2-U4/U7, sandbox-b §26)

| # | Behavior | Refs |
|---|---|---|
| U-33 | `nova:net:fetch` has no response-size cap, no response byte accounting, no in-handler timeout; object request bodies bypass byte accounting (SEC-20) | `AS:6452-6506`, `:6449-6450` |
| U-34 | Plaintext transports allowed: `http:` fetch and `ws://` websockets pass classification (no TLS floor; only mail refuses plaintext) | `AS:218`, `:1309-1311`, `:5504-5507` |
| U-35 | Fetch/WS classification asymmetry: local-DNS suffixes (`.local`, `.lan`, `.internal`, `.home.arpa`, `.test`, single-label) exist only in the WebSocket classifier — `http://router.local` is *external*, `ws://router.local` is *internal* | `AS:1286`, `:1323-1324` |
| U-36 | net:fetch transparently base64-encodes non-textual responses (`bodyEncoding:'base64'` on both branches) — apps must decode binary themselves | `AS:6476-6477`, `:6495-6496` |
| U-37 | WebSocket data plane unbounded: no socket-count/frame-size/send-rate caps (SEC-49) | `AS:6543-6546`, `:6575-6603` |

### Permissions & consent (source: verdicts-2 U5-U8/U10-U11, verdicts-3 U14)

| # | Behavior | Refs |
|---|---|---|
| U-38 | Permission dialogs bind Enter = Allow, Escape = Deny at document level | `APM:1268-1278` |
| U-39 | Launch-time prompt queues skip already-denied permissions (denial only re-prompted via runtime request or Settings) | `AR:681-684`; `appmanager/app.js:824` |
| U-40 | Non-permanent grants (`permanent:false`) expire after 1 day, lazily deleted on check | `APM:896-898`, `:660-668` |
| U-41 | Grant persistence is registry-first and per-account on multi-user installs; localStorage only as fallback | `APM:421-451`; `registry-system-state.js:265-268` |
| U-42 | Share sheet Copy writes `OS.clipboard` + history with no `clipboard:write` grant; sheet shows max 6 targets | `AS:4197-4204`, `:4231`, `:7800` |
| U-43 | Browser-level media gate is OR-semantics (either grant authorizes either type) — stricter app-level check is the real boundary | `AS:9935-9942` |
| U-44 | `nova:download`, `nova:open-url`, and `nova:share` are unpermissioned by design (consent = save dialog / browser window / share sheet) | `AS:3792-3804`, `:4057`, `:4103` |
| U-45 | Web-app bootstrap auto-grants `net:external`/`net:websocket` for wa_/webapp_ apps; the new-web-app watcher polls only 5 min after boot | `app-permissions-bootstrap.js:105-141`, `:252-253`, `:265-291` |

### Registry, secrets, identity (source: verdicts-1 U7-U8, verdicts-4 U8-U10/U17)

| # | Behavior | Refs |
|---|---|---|
| U-46 | HKND is readable by any `registry.read` holder — Developer Mode gates HKND *writes* only (console history readable without devMode) | `AS:3095-3101`, `:3155`, `:3174-3176` |
| U-47 | Registry errors `INVALID_LINK` (broken link target) and `NOT_READY` (sealed user-hive phase after logout) exist but are absent from the doc's error list | `NREG:456`, `:585-592` |
| U-48 | `nova:system:info` returns the OS username to any grant holder, bypassing `nova:ready`'s system-apps-only rule (SEC-24) | `AS:7451` vs `:8733` |
| U-49 | Committed test keypair includes the private half (SEC-01); doc calls it a "committed public test pair" | `keys/test-system-key.json:5`; `trust-store.js:102-137` |
| U-50 | `system-bundle` provenance branch mints verified/System without crypto (SEC-08) | `AP:563-569` |

### Events, push, background (source: verdicts-3 U12-U13, verdicts-4 U3-U4/U12-U14, background.md)

| # | Behavior | Refs |
|---|---|---|
| U-51 | 14/18 allowlisted event names have no emitter (12 of them documented in the doc's event table — Part II); the events that actually fire on the OS bus (`app:opened/closed/focused`, `os:volumeChanged`, `fs:created/updated/moved/deleted`, `settings:changed`) are **not** app-subscribable and not documented | `AS:6021-6065`; `wm.js:406/516/759`; `tray/service.js:147`; `fs.js:357-521`; `settings-shim.js:167` |
| U-52 | `nova:push:register` hands the app its own publish endpoint + bearer token (self-push, SEC-48); publish accepts an optional `id` (≤64 chars) for idempotency | `AS:8585-8594`; `PR:102-104` |
| U-53 | Push SSE loop routes frames purely by server-supplied `evt.appId`; grant/disabled re-checked every message | `AS:8536-8537`, `:8348-8355` |
| U-54 | Tier-1 wake pushes can race ahead of app page load and be silently lost (no redelivery) | `app-scheduler.js:197-203` |
| U-55 | Named alarms never wake a closed app: periodic alarms skip missed cycles; one-shot queue bounded at 8, drop-oldest | `AS:7897-7902`, `:8021-8043` |
| U-56 | Notification `tag` capped at 64 chars; shape-invalid `channelId` silently normalized to `'general'` before the unknown-channel check | `AS:1070`, `:1589-1592`, `:2785-2789` |
| U-57 | Notification actions are pull-only (`consumeActions`); there is no action-click push channel to apps | `AS:10566`, `:2858` |
| U-58 | `EventLog.patchConsole()` captures every `console.log/warn/error` from any in-OS app into the 500-entry ring, with a localStorage write per entry, zero permission gate | `js/apps/event-log/service.js:10-16`, `:81`, `:122-155` |

### Install, packaging, distribution (source: verdicts-1 U15-U16, verdicts-4 U11-U12/U16)

| # | Behavior | Refs |
|---|---|---|
| U-59 | Content scanner skipped on Packages-app installs, Store installs, and my-apps-manager installs — only App Manager / Files / IPC paths scan | `packaging.md §3.3`; `js/apps/packages/app.js:686-816` |
| U-60 | Boot self-healing: bundled system packages force-reinstall whenever signature/version/compiled_at/payloadHash differ; the shipped version always wins (including older ones) | `js/core/core/boot.js:842-899` |
| U-61 | Uninstall residue: secrets, named alarms, defaultApps registrations survive; same-id reinstall re-inherits secrets (SEC-23) | `app-secrets.js` (no removeApp); `HKNS/apps/alarms` |
| U-62 | Store installs unverified packages with no dialog (SEC-13) | `store/app.js:544-566` |
| U-63 | Store Update Service checks only the static catalog (SEC-25) | `store-updates/service.js:4-5` |
| U-64 | MyAppsManager install path skips scanner + impersonation dialog; `installFromUrl` fetches arbitrary URLs host-side (SEC-32) | `my-apps-manager.js:209-271`, `:249-256` |

### Shell, launcher, OS surfaces (source: verdicts-1 U1-U3/U5-U6/U13-U14/U17-U20, launcher.md, apps.md)

| # | Behavior | Refs |
|---|---|---|
| U-65 | Legacy launcher fallback: entire secondary launch path (postMessage bridge, `__novaPrivateStore`, blob-URL fallback, unsandboxed host-tier webviews) exists solely for AppSandbox-load-failure (SEC-31) | `NAL:884-1231`; `appmanager/app.js:740+` |
| U-66 | Stable serving alias (OAuth callback URL) exists only for reverse-domain or `webapp_*` ids; other ids degrade to session-only serving | `AS:1124`; `server/core/index.js:358` |
| U-67 | Dev manifest ships `--disable-web-security`/CDP 9222/`dev_tools:true`, and F12 opens DevTools ungated (SEC-02) | `NBOSP/package.json:29-30`; `ui-init.js:58-61` |
| U-68 | Unclamped context-menu host-screen coordinates (SEC-54) | `AS:3375`, `:3394` |
| U-69 | mailto/webcal default-app settings are decorative (SEC-72) | `default-apps/service.js:102-103`; `registry/service.js:205-208` |
| U-70 | `getStoredApps` displays any leftover `OS.apps` entry as a "System App" in App Manager (display-only; uninstall still blocked on `app.system`) | `appmanager/app.js:1333-1346` |

**Documentation impact:** the replacement guide should either fold these into the relevant sections or ship an explicit "Platform behaviors" appendix. Highest developer impact: U-04 (web shortcuts get no bridge at all), U-15/U-16 (10-minute interactive timeouts and the codeless timeout error), U-33/U-35/U-36 (network egress accounting, classification asymmetry, base64 binary responses), and U-51 (the event-bus reality — subscribe succeeds, nothing fires). U-01 (NB-MAC) deserves its own section: it is the actual enforcement layer the doc's permission tables only describe indirectly.

---

## Part V — Registry / table consistency diffs

Doc tables vs code inventories (verdicts-4 Registries A/B; sandbox-c2 counts).

### Permissions (52 + 6 legacy claimed)

| Table | Phantom (doc has, code lacks) | Omitted (code has, doc lacks) |
|---|---|---|
| Current 52 permissions / 11 categories | **0** — exact 1:1 with `PERMISSION_TYPES`/`PERMISSION_CATEGORIES` (`APM:15-245`) | **0** |
| Legacy names (6 claimed) | **1** — `vfs:meteded` as a *permission* alias (only 5 real aliases; typo stripped as unknown, `app-registry.test.js:181`) | 0 |
| Negative claims (`fs:read`/`fs:write`/`fs:delete`/`handles:*` are not permissions) | Hold — verified absent | — |

### IPC channel names

| Metric | Count |
|---|---|
| Phantom channels | **0** — every doc-named channel exists (incl. `nova:net:ws:message:response` transport form `AS:1660-1668`, `nova:audit:eval` `AS:9291`, all vfs aliases `AS:9531-9555`) |
| Omitted from the doc (guest-reachable, never named) | **21** |

The 21 omitted channels, with their effective gates:

| Channel | Gate |
|---|---|
| `nova:appearance:get` / `:set` / `:subscribe` / `:unsubscribe` | none (set rate-limited 10/min) — `AS:8624-8701` |
| `nova:nested-webview` | `sandbox:nested-webview` + manifest opt-in — `AS:3301-3306` |
| `nova:context-menu:show` / `:hide` | `sandbox:nested-webview` + opt-in — `AS:3328-3336` |
| `nova:overlay:show` / `:hide` | `sandbox:nested-webview` — `AS:3414-3417` |
| `nova:wallpaper:set` | none (policy `prohibitWallpaperChange` only) — `AS:3020-3052` |
| `nova:home:apps:list` / `nova:home:apps:launch` | selected-Home-app only — `AS:3963-4011` |
| `nova:home:openDefaultAppsSettings` | selected-Home-app only — `AS:4330-4346` |
| `nova:ipc:register` / `:unregister` / `:invoke` / `:reply` | `apps:communicate` both sides + manifest declarations — `AS:6160-6286` |
| `nova:ipc:broadcast` / `:broadcast:subscribe` / `:broadcast:unsubscribe` | `apps:communicate` + manifest receives — `AS:6288-6339` |
| `nova:fs:changed` (push) | fs:watch ownership — `AS:7691-7698` |

### Facade methods (B1-B4)

Zero-diff confirmations: B5 channel names — no phantoms beyond the omissions listed above; B7 capability names — the 28 claimed names match `NOVAOS_SUPPORTED_CAPABILITIES` exactly (`AS:10255-10299`), 0 phantom / 0 omitted. Diffs were computed by enumerating the doc tables against code inventories (`AS:11506-11868`, `:12670-12909`, `:10235-11010`, `:10361`).

| Surface | Phantom | Omitted |
|---|---|---|
| B1 `window.nova` v1 (71 claimed) | **1** — `window.nova.resetPermission` does not exist in the shim; the only real reset is host-only (`nova:system:permissions:reset` is GUEST_FORBIDDEN, `AS:9317-9336`; host-side `APM:4905`) | 0 (other 70 verified) |
| B2 BrowserView members (19 claimed) | 0 | **8** — `refreshState`, `setOverlayActive`, `setAnnotationLayer`, `updateAnnotationLayer`, `setAnnotationActive`, `clearAnnotationLayer`, `undoAnnotationLayer`, `exportAnnotationLayer` (`AS:12731-12909`; annotation API never mentioned in the doc) |
| B3 `window.novaOS` v2 (~95 claimed) | 0 | **1** — `fs.appdata.remove` (`AS:10480-10482`; covered only implicitly by the `appdata.*` shorthand at NOVAAPP.md:869) |
| B4 Host/internal APIs (19 claimed) | 0 | 0 |

### Event names

| Metric | Count | Detail |
|---|---|---|
| Phantom (allowlist-level) | 0 | All 18 `ALLOWED_EVENT_NAMES` exist as strings (`AS:6021-6065`) |
| Names with **no emitter** | **14 of 18** (verdicts-4 U4 tally; 12 of them are rows in the doc's event table — Part II #15-26) | Only `nova:net:ws:message/error/close` (`AS:6557`), `nova:reg:changed` (`NREG:612-623`), `calendar:updated` (`AS:7321`), `contacts:updated` (`AS:7392`) ever fire |
| Events that fire but are not app-subscribable and not documented | **8** | `app:opened`, `app:closed`, `app:focused` (`wm.js:406/516/759`), `os:volumeChanged` (`tray/service.js:147`), `fs:created/updated/moved/deleted` (`fs.js:357-521`) (plus `settings:changed`, emitted `settings-shim.js:167`, deliberately not subscribable) |

### Error codes (46 claimed)

| Metric | Count | Detail |
|---|---|---|
| Phantom | **0** | All 46 exist verbatim |
| Omitted (IPC-reachable, never in doc) | **8** | `SCAN_FAILED` (`AS:5932`), `UNINSTALL_FAILED` (`AS:5815`), `WIPE_ERROR` (`AS:5247`), `ERROR` (generic, e.g. `AS:6945`), `TRANSPORT_ERROR` (shim, `AS:10135`), `APP_UNAVAILABLE` (isolated dispatch, `AS:9636-9644`), `INVALID_LINK` (`NREG:456`), `NOT_READY` (`NREG:585-592`) |
| Semantics wrong (not phantom, but misdocumented) | 3 | `TIMEOUT` (NOVAAPP.md:2032), `UNVERIFIED` (:2035), `PAYLOAD_TOO_LARGE` (:2044) — Part II |

### Limits

| Metric | Detail |
|---|---|
| Phantom limit | **1** — `registryScopes` "32 entries max" (NOVAAPP.md:1813): no cap exists (`AS:3104-3141`); only ACL *entries* are capped at 32 (`NREG:93`) |

Omitted limits (enforced in code, absent from the doc):

| Limit | Value | Ref |
|---|---|---|
| Per-user storage ceiling | 2 GB | `AS:6778-6781` |
| Per-value storage cap | 5 MB | `AS:6917-6918` |
| Media index / query / refresh | 5000 files / 500 per query / 30 s | `MED:9-10`, `:79`, `:90` |
| Multi-select picker cap | 25 files | `AS:8829` |
| Share targets per sheet | 6 | `AS:7800` |
| data:export key list | 1000 entries | `AS:7145-7146` |
| Notification tag length | 64 chars | `AS:1070` |
| Picker accept string form | 512 chars | `AS:8815-8823` |
| Interactive-channel timeout | 10 min (vs 60 s default) | `AS:11040-11053` |
| Files-app install size cap | 32 MiB | `files/app.js:1667-1671` |
| IPC reply error truncation | 500 chars | `AS:6280` |
| Notification replay cap | 100 | `notifications/service.js:355` |
| Pending notification actions | 20/app | `notifications/service.js:28` |
| Share inbound queue / alarm queue | 8 each (drop-oldest) | `AS:7845-7851`, `:8021` |
| Push backlog | 16 messages / 24 h (in-memory) | `server/core/push-bus.js:25-26` |
| EventLog ring / registry audit ring / server event log | 500 each | `event-log/service.js:28`; `NREG:94`; `server-event-log.js:5` |
| Downloads history | 500 | `downloads-history/service.js:4` |
| Sandbox serving idle TTL | 30 min | `server/core/index.js` (tests `index.test.js:246`) |
| Scheduler sweep / wake deadline | 15 min / 10 s | `app-scheduler.js:46`, `:58` |
| Account quota (Users app) | 2 GB/account | `js/apps/users/app.js:372` |
| Annotation export payload | 2,000,000 chars | `AS` (freeze tests `app-sandbox.freeze.test.js:317`) |

---

## Part VI — Unverifiable claims (6)

| Doc line | Claim | What would be needed |
|---|---|---|
| NOVAAPP.md:106 | "Studio's manifest validation enforces [reverse-domain ids] at Build time" | Review the external `novapack-studio` repo (in-repo builder performs no id validation; enforcement is install-time, `AP:828-831`) |
| NOVAAPP.md:171 | Build "validates the app ID format and all declared permissions against the known permission list" | Studio repo review (in-repo: id format is install-time error; unknown permissions are warnings only, `AP:925-930`) |
| NOVAAPP.md:172 | C/C++ sources compiled with `emcc` to `module.js` + `module.wasm` | Studio repo review; no emcc/module.cpp/native-cpp code anywhere in this repo (NBOSP supports the wasm output via CSP `'wasm-unsafe-eval'`, `AS:13071`) |
| NOVAAPP.md:172 | "Build button turns purple when C/C++ sources are detected" | Studio UI review (external) |
| NOVAAPP.md:172 | "Requires `emcc` on your PATH" | Studio build-step review (no in-repo code shells out to emcc) |
| NOVAAPP.md:2070 | "Earlier NBOSP images experimented with a per-app Linux UID supervisor and SELinux boot integration; removed from the image" | Git history / old-image archaeology — no code trace either way in the tree |

---

## Part VII — Test execution results

### vitest (unit + platform + apps + server)

**1,757 tests executed, 1,757 passed, 0 failed, 0 skipped** (`npm test` → `npx vitest run --reporter=verbose`). No `it.skip`/`todo`/`.only`/FIXME markers exist anywhere under `NBOSP/tests/`.

Breakdown of the individually-itemized suites (counts from the test-inventory pass; `≈` = the notes' approximate tally; the remaining suites — core/services (system-service-loader, workers, tray, system-events, calendar-notifier, event-log, server-events-bridge, downloads-history, debug-overlay, app-loader-optimiser, …) plus remaining apps/server files — make up the balance of the 1,757 total):

| Area | Files | Tests (itemized) | Largest suites |
|---|---|---|---|
| tests/platform/security | 15 | ≈310 | app-sandbox 110; app-permission-manager ≈40; frame-security 25; novareg-sandbox 24; unrestricted-gate 13; trust-store 13; app-secrets 15; app-scheduler 15; data-portability 10; system-fetch 10; bootstrap 10; data-root 7; freeze 7; facade 3; root-broker 4 |
| tests/platform/core | 16 | ≈270 | app-package ≈45; app-registry ≈45; nova-registry ≈40; nova-app-package-store 17; settings-shim ≈15; installed-apps-per-account 14; user-scope 14; nova-registry-user-hives 11; nova-app-launcher 12; registry-system-state 10; app-config 9; registry-boot-state 7; nova-reg-cli 6; registry-prefs 6; nova-reg-file 5; app-id-aliases 2 |
| tests/apps | 16 | ≈170 | terminal ≈20; notifications ≈17; appmanager 12; background-apps 12; permissions 12; store 11; devconsole 11; registry ≈14; store-updates 8; sysaccess 9; system-webview 9; launcher 10; packages 10; default-apps 6; novareg 5; install-nbosp 3 |
| tests/server | 6 | ≈55 | auth-routes ≈18; push 12; index 10; middleware-rate-limit 5; rate-limit-auth 4; events-routes 4 |

Key exact values pinned by the passing suites (ground truth for the replacement doc):

- Rate limits: `nova:app:launch` 30/min then RATE_LIMITED; permission prompts 3/60 s burst, cooldown 5 s → 15 min, denial streak cap 20; notifications 10/min new + 60/min tag updates; badge 30/min; appearance 10/min; share 5/min; app-ipc 20/min per app per type; default-apps settings 12/min.
- Budgets: storage quota 256 MB default (clamp 1 MB-2 GB); IPC payload 256 KB; HTTP body 16 MiB; per-value storage 5 MB; secrets 64/app, 8 KB/value, 128-char keys.
- Registry: depth 16, name 64, value 256 KB, audit ring 500, snapshots 3/hive.
- Sandbox serving: 30-min idle TTL, heartbeat-kept; stable alias for reverse-domain/`webapp_*` ids only.
- Scheduler: 15-min sweep, 10-s wake deadline; alarms 32/app, ≥15-min period, queue 8.
- Trust store: 2 built-in signers, tier `test-keys` default / `release-keys` with `NBOSP_SYSTEM_SIGNING_PUBLIC_JWK` meta injection.
- Wallpaper presets: stock-blue/dark/light/green/purple/red/gray/teal.

### Integration suites (plain node scripts, `tests/integration/run-all.js`)

| Suite | Scope | Result |
|---|---|---|
| guest-bridge.suite.js | Two-realm real guest runtime; pins the full NOVAAPP.md facade surface (~327 checks) | **FAIL** (harness) |
| ipc-matrix.suite.js | Every API_HANDLERS handler × malformed payloads, forbidden channels, permission matrix, budgets, abuse | **FAIL** (harness) |
| real-use.suite.js | End-to-end app lifecycle: boot → install → prompts → revocation → multi-app flows | **FAIL** (harness) |
| storage-ledger.suite.js | Logical-UID storage ledger: budgets, accounting, scoped fs roots, uninstall wipe | **FAIL** (harness) |
| legacy-vfs-compat.suite.js | Legacy `nova:vfs:*` + typo channel aliases resolve to fs:* (translate-then-enforce) | PASS |
| mac-policy.suite.js | NB-MAC: seed policy, grant-coupling, default-deny, permissive mode, neverallow, audit ring | PASS |
| package-signature-encoding.suite.js | Signature encodings: base64url/base64/legacy hex; trust-store end-to-end; tamper fail-closed | PASS |
| picker-contract.suite.js | Mixed MIME + .ext accept lists; multi-select + array accept | PASS |
| recipe-box-compat.suite.js | Exact boot + headline IPC sequence of a real third-party app (2.1.0) | PASS |

**Result: 5 of 9 pass; 4 fail on Node 24.**

**Root cause (harness bug, not a product regression):** `tests/helpers/fake-idb.js:25` throws `fake-idb: mixed array/scalar key` from its key comparator whenever it compares an array key against a scalar key. The production storage layer uses **array** IDB index keys — `storageAppRange` builds `IDBKeyRange.bound([owner, appId, ''], [owner, appId, '\uffff'])` (`AS:6694`; likewise `AS:6723`, `AS:6788`) — while the fake harness seeds/holds scalar keys in the same store. All four failing suites mount the real `app-sandbox.js` over the fake IDB (`tests/helpers/env.js`: "real app-sandbox over fake FS/IDB"), so the first storage operation with the production key shape trips the comparator. The five passing suites do not exercise that path. Real IndexedDB (and hence production) supports array keys; the comparator is the defect.

**What this means for CI:** the four red suites are invalid signals on Node 24 — they fail before product logic runs, so genuine regressions in the guest bridge, IPC matrix, end-to-end app lifecycle, and storage ledger would be masked. Fix `fake-idb.compareKeys` to order array-vs-scalar deterministically (per the IndexedDB key-ordering spec, e.g. arrays after scalars) or seed harness keys as arrays, then re-run `run-all.js`. Until then, treat those four suites as not-running, not failing.

**Secondary test-hygiene finding:** `tests/platform/core/app-package.test.js` contains **two near-duplicate describe blocks** (legacy block at `:12`, current at `:380`) asserting the same behaviors twice — every assertion in the file runs twice, inflating the vitest count and doubling maintenance. Deduplicate (SEC-96).

### Test coverage gaps (passing suites notwithstanding)

Channels and surfaces with no dedicated test (only generic ipc-matrix probing at best), from the test inventory:

- `nova:auth:*` sandbox bridge channels (lock/login/logout/resume/reverify/setup/suspend/switch/unlock — 9 channels): server-side equivalents are covered in `auth-routes.test.js`, but the sandbox bridge channels are only generically probed.
- `nova:background:alarm` push channel: wake dispatch is covered via AppScheduler tests; the alarm channel itself is not directly tested.
- `nova:context-menu` bare channel (only `:show`/`:hide` have dedicated tests).
- Bare umbrella legacy aliases (`nova:dialog`, `nova:sysdialog`, `nova:files`, `nova:fs`, `nova:storage`, `nova:overlay`, `nova:wallpaper`, `nova:window`, `nova:appearance`, `nova:locale`, `nova:email`, `nova:audit`) — only generically probed.
- Push channel strings `nova:fs:changed`, `nova:share:inbound`, `nova:push:message` (the v2 facades that consume them are covered in guest-bridge — which is currently red, see above).
- No dedicated test for the `device:notifications` gate on `nova:notifications:show` beyond the generic permission matrix.

The four harness-broken suites (guest-bridge, ipc-matrix, real-use, storage-ledger) are exactly the ones that pin the end-to-end facade surface, the full permission matrix, app lifecycle flows, and ledger budgets — until the fake-idb fix lands, those properties are verified only by the vitest unit layer.

---

## Appendix A — Audit method

1. **Subsystem reads.** Every platform/server/OS file was read in full and documented in per-subsystem notes (Appendix B). `app-sandbox.js` (14,895 lines) was covered in five sequential passes (lines 1-5100; endpoint inventory 5100-9300; dispatch/bridge 9300-12300; webview/popup construction 12300-14100; lifecycle/exports 14100-14895) recorded in sandbox-a/a2/b/c/c2.
2. **Claim extraction.** All 2,315 lines of `NOVAAPP.md` were decomposed into 1,139 discrete checkable claims (including worked examples) in doc-claims 1-4.
3. **Claim resolution.** Each claim was verdicted against the code with doc-line and code-line evidence (verdicts-1…4), using the rubric: CORRECT (code matches), WRONG (code contradicts), OUTDATED (was true; superseded), DOC-ONLY (statement about nothing in the codebase — advice, history, or external-tool claims that are consistent but unverifiable in-repo), UNVERIFIABLE (requires artifacts outside this repo). Security-relevant wrongness, undocumented behaviors (U-items), and per-subsystem SECURITY OBSERVATIONS were collected alongside.
4. **Test execution.** `npm test` (vitest, 1,757 tests) and `npm run test:integration` (9 suites) were executed; failures were root-caused to the harness (Part VII).
5. **Cross-verification.** All file:line references cited in this report were re-checked against the working tree at `ccc4305` (e.g. `NBOSP/package.json:29-30` flags, `tests/helpers/fake-idb.js:25` comparator, `AS:1875-1880` consent gate, `AS:6694` array key range).

**Limitations / scope exclusions:**

- The external `novapack-studio` repo was not audited — the six UNVERIFIABLE claims (Part VI) all trace to it.
- Findings are from static code reads plus executed tests; no runtime instrumentation or penetration testing was performed. Items dependent on dynamic behavior are marked **[suspected]** (SEC-92).
- The OS image was audited from its build configuration (Buildroot defconfig, overlay scripts, sudoers, inittab, recovery script); the image was not booted.
- The publisher/website backend (`src/`, `supabase/`) findings derive from the store.md note's read of those trees; no live Supabase deployment was tested.
- The four harness-broken integration suites mean the behaviors they pin are currently evidenced only by the vitest unit layer (Part VII).

Confirmed-by-code vs suspected: every Part I-V item is confirmed by direct code read except where explicitly marked **[suspected]** (SEC-92 recovery-tar symlink escape). SEC-58 is a confirmed early-return bug whose effect on audit coverage is confirmed by inspection.

## Appendix B — File inventory examined

| Subsystem | Files (lines) | Notes file |
|---|---|---|
| App sandbox / bridge / MAC / ledger | `NBOSP/js/platform/security/app-sandbox.js` (14,895) | sandbox-a.md, sandbox-a2.md, sandbox-b.md, sandbox-c.md, sandbox-c2.md |
| Permission manager & dialogs | `js/platform/security/app-permission-manager.js`, `app-permissions-bootstrap.js`, `unrestricted-gate.js` | permissions.md |
| Packaging & trust | `js/platform/core/app-package.js` (1,017), `build-apps.mjs` (617), `trust-store.js` (494), `nova-app-package-store.js` (317), `app-registry.js` (808), `app-config.js`, `app-id-aliases.js`, `js/apps/packages/*`, `keys/*` | packaging.md |
| Registry, secrets, privileged apps | `nova-registry.js`, `nova-reg-cli.js`, `nova-reg-file.js`, `settings-shim.js`, `registry-system-state.js`, `registry-boot-state.js`, `registry-prefs.js`, `app-secrets.js`, `root-broker.js`, `js/apps/novareg/*`, `js/apps/sysaccess/*`, `js/apps/terminal/*`, `js/apps/devconsole/*` | registry.md |
| Launcher, window manager, app manager | `nova-app-launcher.js`, `js/apps/shell-ui/wm.js`, `desktop.js`, `js/apps/appmanager/app.js`, `js/apps/system-webview/service.js`, `frame-security.js`, `user-scope.js`, `my-apps-manager.js` | launcher.md |
| Store & distribution | `js/apps/store/app.js`, `js/apps/store-updates/service.js`, `src/` (website/publisher), `supabase/functions/*` | store.md |
| Background & scheduling | `app-scheduler.js`, `js/apps/background-apps/service.js`, `notifications/service.js`, `event-log/service.js`, `server-events-bridge/service.js`, `system-service-loader.js`, `workers.js` | background.md |
| Server core | `server/core/index.js`, `ssl.js`, `auth-routes.js`, `events-routes.js`, `push-routes.js`, `push-bus.js`, `security/middleware.js`, `security/routes.js`, `email/*` | server.md |
| Boot, session, lock, FS | `js/core/core/boot.js`, `kernel.js`, `init.js`, `js/apps/lock-screen/service.js`, `js/apps/session/service.js`, `factory-reset.js`, `js/core/services/fs.js` | boot.md |
| First-party apps & services | default-apps, files, browser, search, modules, scanner, mail app, media-store, calendar/contacts, tray, system-events, novaapp-manifest.json | apps.md |
| OS image (Buildroot) | `os/README.md`, `build-iso.sh`, `configs/nbosp_x86_64_defconfig`, `board/nbosp/*` (S99nbosp, grub.cfg, inittab, sudoers.d/nbosp, nbosp-recovery, users.table, udev rules, nmconnections), `package/{labwc,nbosp-install,nbosp-kiosk,nbosp-power}/*`, `.github/workflows/nbosp-os-iso.yml` | os.md |
| Tests | `NBOSP/tests/**` (platform, core, apps, server, integration, helpers) | tests.md |
| Doc claims & verdicts | `NOVAAPP.md` (2,315), `README.md` | doc-claims.md, doc-claims2-4.md, verdicts-1.md … verdicts-4.md |

## Appendix C — Remediation tracker

Suggested sequencing by owner. "Effort" is a rough S/M/L from the fix descriptions in Part I.

| Priority | SEC | Fix | Owner | Effort |
|---|---|---|---|---|
| P0 | SEC-01 | Remove private half of committed test key; gate test-tier System verification | packaging/CI | S |
| P0 | SEC-02 | Strip `--disable-web-security`/CDP 9222 from default manifest; gate F12 on devMode | platform | S |
| P0 | SEC-03 | Replace blanket NOPASSWD sudo with narrow rules | OS image | M |
| P0 | SEC-04 | Lock root account; remove tty2 getty; auth-gate recovery shell | OS image | S |
| P0 | SEC-05 | Wire Settings factory-reset to `NovaFactoryReset` | boot/UI | S |
| P0 | SEC-06 | Persist PIN lockout ladder in registry | boot/lock-screen | S |
| P1 | SEC-19 | Prompt for shared-file modify/rename/move (or remove dead branches) | sandbox | S |
| P1 | SEC-96 | Fix fake-idb array/scalar key ordering; dedupe app-package test blocks | tests | S |
| P1 | SEC-10 | Key grants by (appId, signer); refuse replace downgrades | permissions/packaging | M |
| P1 | SEC-11 | Default-deny cross-app HKNA reads for plain `registry.read` | sandbox/registry | M |
| P1 | SEC-13 | Route Store installs through the untrusted-package dialog | store | S |
| P1 | SEC-14 | Require auth for `/api/events/stream` | server | S |
| P1 | SEC-08 | Id-allowlist (or boot token) inside the system-bundle branch | packaging | S |
| P1 | SEC-09/SEC-12 | Protect `HKNS/security/policy`, `HKNS/system/devMode`, `HKNS/security/rootAccessEnabled` from registry.system writes | registry | M |
| P2 | SEC-15/SEC-16 | Gate terminal Linux path and Files "Run Linux executable" on devMode; scrub env | apps | S |
| P2 | SEC-17 | Chown only runtime subdirs under /opt/nbosp | OS image | S |
| P2 | SEC-18 | In-handler identity checks on `nova:system:*` host handlers | sandbox | S |
| P2 | SEC-20 | Response cap + timeout on net:fetch; shared DNS-suffix classification; TLS floor decision | sandbox | M |
| P2 | SEC-21 | Distinct `STORAGE_ERROR`; fail closed on storage reads | sandbox | S |
| P2 | SEC-23 | Uninstall hooks for secrets/alarms/defaultApps; rate-limit map sweep | sandbox/secrets | M |
| P2 | SEC-25/SEC-26 | Update checker over merged catalog; signed remote revocation manifest | store/publisher | M |
| P2 | SEC-33/SEC-34/SEC-35 | Credential-path sanitization exemption; audit scoping fix; editable-fields allowlist | server | S |
| P2 | SEC-36/SEC-37/SEC-38 | Push CSRF exemption + test; setup loopback bind; session rotation | server | M |
| P2 | SEC-39 | Sign + verify rootfs archive in installer | OS image | M |
| P3 | SEC-07 | Route security-wipe to factory reset or relabel | lock-screen | S |
| P3 | SEC-24/SEC-41/SEC-42 | Align username exposure; trim app:list fields; allowlist preferences:get | sandbox | S |
| P3 | SEC-27/SEC-28 | Server-side admin-mode for all admin:*; argv prompt + broker-minted attribution | sandbox/root-broker | M |
| P3 | SEC-29/SEC-30/SEC-31/SEC-32 | gitignore root/; dev-tool confirmations; delete legacy launcher fallback; MyApps gates | various | M |
| P3 | SEC-40/SEC-43/SEC-44/SEC-45/SEC-47 | Long-term: kernel isolation, credential stores, publisher hardening, provider semantics | various | L |
| P3 | SEC-48…SEC-95 | Low items — batch as hardening backlog | various | S each |
| Docs | Part II/III/V | Regenerate affected sections of the guide from the corrected claims (doc-line checklist above) | docs | M |

*End of report.*
