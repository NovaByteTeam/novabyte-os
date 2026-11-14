# NovaByte OS — `.novaapp` Documentation

This directory is the rewritten `.novaapp` documentation set. It replaces the
former single-file guide (`NOVAAPP.md` at the repository root, which is now a
short pointer to this directory).

**Everything in these files is derived from the source code of this repository**
at commit `ccc4305` ("Merge pull request #39 from NovaByteTeam/gl-debug").
Every API, manifest field, permission, limit, default, and error string was
checked against the implementation, and the behavior is cited with
`path:line` references. Where something could not be established from source
alone it is marked with an **Unverified** blockquote and collected in
[`../UNVERIFIED.md`](../UNVERIFIED.md). The full list of discrepancies between
the previous guide and the code — plus every suspected bug and security
concern found during the audit — is in [`../AUDIT.md`](../AUDIT.md).

## Document map

| File | Audience | What it covers |
|---|---|---|
| [`guide.md`](guide.md) | App developers | The journey end to end: first project, manifest reference, build/sign/verify, install, runtime model, permissions in brief, background execution, data lifecycle (update/uninstall), dev & debug workflow, trust/verification, publishing, limits & defaults, compatibility, glossary |
| [`permissions.md`](permissions.md) | App developers | All 52 permissions: what each unlocks, how to request it, a working example, what the user sees, what happens on denial, limits, overlap guidance, legacy `vfs:*` aliases |
| [`api-reference.md`](api-reference.md) | App developers | Every guest-reachable `nova:*` IPC channel, the complete `window.nova` (v1) and `window.novaOS` (v2) facades, pushed events, rate limits & quotas, error codes, legacy compatibility |
| [`examples.md`](examples.md) | App developers | Working examples, from the verified hello world through storage, files, notifications, networking, alarms, background execution, push, app-to-app IPC, share targets, secrets, registry, default apps, and the dev workflow |
| [`internals.md`](internals.md) | OS contributors | How the OS actually works: boot sequence, local server, sandbox engine, MAC policy, permission manager, registry, background services, the Linux image, testing architecture, known internals gaps |

## Where to start

- **"I want to build my first app"** → [`guide.md`](guide.md) §3 (a verified,
  build-it-now hello world) then [`examples.md`](examples.md).
- **"What does permission X unlock?"** → [`permissions.md`](permissions.md).
- **"What is the payload/response of channel Y?"** → [`api-reference.md`](api-reference.md) §5.
- **"Show me working code for Z"** → [`examples.md`](examples.md).
- **"How does the OS implement this?"** → [`internals.md`](internals.md).
- **"Why does the doc say something different from the old NOVAAPP.md?"** →
  [`../AUDIT.md`](../AUDIT.md) lists every correction with doc-line and
  code-line references.

## Conventions

- **Citations.** Bare `:NNNN` line references point at
  `NBOSP/js/platform/security/app-sandbox.js` (the sandbox/IPC engine, ~15k
  lines). All other references are repo-relative `path:line`. They reflect the
  audited commit; line numbers drift as the code changes.
- **Unverified content.** Anything that could not be established from the
  source alone is marked inline as `> **Unverified:** …` and listed in
  [`../UNVERIFIED.md`](../UNVERIFIED.md). Nothing in this set is guessed.
- **No history.** Changelog and history material is intentionally excluded
  from the guides; the git history of this repository is the record.
- **The code is the source of truth.** These documents describe the code as
  audited. If code and docs disagree after further development, the code wins
  and the docs need updating.

## Companion files (repository root)

| File | Contents |
|---|---|
| [`../AUDIT.md`](../AUDIT.md) | Documentation-vs-code audit report: 96 security concerns and suspected bugs, all 42 wrong / 2 outdated / 6 doc-only claims in the previous guide, 70 undocumented behaviors, registry-table diffs, test execution results — each with `file:line` references |
| [`../UNVERIFIED.md`](../UNVERIFIED.md) | Everything that could not be determined from the source alone, why, and what would settle it |
