# NovaByte OS — `.novaapp` Documentation

This directory is the `.novaapp` documentation set for NovaByte OS.

**Everything in these files is derived from the source code** — this
repository at commit `ccc4305` ("Merge pull request #39 from NovaByteTeam/gl-debug").
Every API, manifest field, permission, limit, default, and error string is
documented against the implementation.

## Document map

| File | Audience | What it covers |
|---|---|---|
| [`guide.md`](guide.md) | App developers | The journey end to end: first project, manifest reference, build/sign/verify, install, runtime model, permissions in brief, background execution, data lifecycle (update/uninstall), dev & debug workflow, trust/verification, publishing, limits & defaults, compatibility, glossary |
| [`permissions.md`](permissions.md) | App developers | All 53 permissions: what each unlocks, how to request it, a working example, what the user sees, what happens on denial, limits, overlap guidance, legacy `vfs:*` aliases |
| [`api-reference.md`](api-reference.md) | App developers | Every guest-reachable `nova:*` IPC channel, the complete `window.nova` (v1) and `window.novaOS` (v2) facades, pushed events, rate limits & quotas, error codes, legacy compatibility |
| [`examples.md`](examples.md) | App developers | Working examples, from the verified hello world through storage, files, notifications, networking, alarms, background execution, push, app-to-app IPC, share targets, secrets, registry, default apps, and the dev workflow |

## Where to start

- **"I want to build my first app"** → [`guide.md`](guide.md) §3 (a verified,
  build-it-now hello world) then [`examples.md`](examples.md).
- **"What does permission X unlock?"** → [`permissions.md`](permissions.md).
- **"What is the payload/response of channel Y?"** → [`api-reference.md`](api-reference.md) §5.
- **"Show me working code for Z"** → [`examples.md`](examples.md).
## Conventions
- **No history.** Changelog and history material is intentionally excluded
  from the guides; the git history of this repository is the record.
- **The code is the source of truth.** These documents describe the code as
  audited. If code and docs disagree after further development, the code wins
  and the docs need updating.
