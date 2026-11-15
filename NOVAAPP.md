# `.novaapp` App Development Guide

This guide has been rewritten as a multi-file documentation set and now lives
under [`docs/`](./docs/). Start at [`docs/README.md`](./docs/README.md).

| File | Contents |
|---|---|
| [`docs/guide.md`](./docs/guide.md) | The developer journey end to end: first app, manifest reference, build/sign/verify, install, runtime model, background execution, data lifecycle, dev workflow, trust & publishing, limits, compatibility, glossary |
| [`docs/permissions.md`](./docs/permissions.md) | All 52 permissions: what each unlocks, how to request, working examples, what the user sees, denial behavior, overlap guidance |
| [`docs/api-reference.md`](./docs/api-reference.md) | Every `nova:*` IPC channel, the complete `window.nova` (v1) and `window.novaOS` (v2) facades, pushed events, rate limits, quotas, error codes |
| [`docs/examples.md`](./docs/examples.md) | Working examples, from a verified hello world to push, IPC, share targets, and the dev workflow |
| [`docs/internals.md`](./docs/internals.md) | OS contributor documentation: boot, local server, sandbox engine, MAC policy, registry, services, the Linux image, testing |
| [`AUDIT.md`](./AUDIT.md) | The documentation-vs-code audit this rewrite is based on: every discrepancy, undocumented behavior, and suspected bug found, with file:line references |
| [`UNVERIFIED.md`](./UNVERIFIED.md) | Items that could not be verified from source alone, and why |

Every statement in the new documentation is derived from the source code and
cited with `path:line` references; the previous revision of this file remains
available in git history.
