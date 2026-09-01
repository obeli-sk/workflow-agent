# just-bash-rs

A Rust port of [just-bash](https://github.com/vercel-labs/just-bash) (see
`NOTICE`), used as the virtual bash interpreter for `apps/workflow-agent`
sessions. It's a usage-driven port: only the surface the session loop and its
coreutils actually need, not full upstream fidelity. Each module names the
upstream TypeScript source(s) it was derived from in a `//! PORT:` header
comment.

## Upstream sync point

Last cross-checked against upstream `vercel-labs/just-bash` commit
`63cd01319691db61d4f239335c58940257c1f864` (`origin/main`, 2026-08-25,
"feat(network): replace bespoke secureFetch with guarded-fetch 0.1.3 (#380)"),
checked out at `/workspace/just-bash`.

To find what's landed upstream since: `cd /workspace/just-bash && git fetch
&& git log 63cd01319691db61d4f239335c58940257c1f864..origin/main`, then cross-
reference each commit's touched files against this crate's `//! PORT:`
headers to see what's in scope. Update the commit id above once a session
does that cross-check again, whether or not it ports anything.

Deliberately out of scope regardless of upstream changes (no analogous
surface in this port): `python3`/`sqlite3`/JS component execution, real
filesystem access (`ReadWriteFs`; this port is in-memory `Vfs` only),
`secureFetch`/network, and the website/security-review-only changes upstream
sometimes ships alongside interpreter fixes.

Known gaps as of the sync point above (present upstream, not in this port):
`{varname}>file` dynamic file-descriptor allocation and the `read`/`exec N<`
numeric-fd table it depends on (no `read` builtin exists here at all yet);
the delimiter-matching-across-backslash-continuation refinement for heredocs
(unterminated-heredoc completion and the common escape cases are ported;
this is a rarer edge case); pass-original-command-to-custom-overrides (the
override model differs here, see `custom_command.rs`).
