# Snapshottable bash-VM execution (design)

Status: proposed, not started. Rust backend only (`workflow-rs`, `bash-rs`,
`vendor/just-bash-rs`); JS backend (`workflow-js`, `vendor/just-bash`) is not
addressed here and will diverge until ported later, consistent with other
in-flight Rust-first work in this repo.

## Problem

The just-bash interpreter (`Bash`, holding the VFS, cwd, env, and shell
state) is constructed once per chat session and lives in-process for the
session's entire lifetime, threaded by reference through every turn's
tool-call loop:

- `workflow/workflow-rs/src/session.rs:638-650` — `Bash::new(...)` at the top
  of `agent_loop`, threaded as `&mut Bash` through every turn.
- `dispatch_bash` (`session.rs:1054`) → `exec_shell` (`session.rs:1204`) →
  `bash.exec(...)` (`vendor/just-bash-rs/src/bash.rs:107-172`), which mutates
  `cwd`/`env`/`fs`/`shell_options`/`positional` in place and hands them back
  to the same long-lived `Bash` at the end of the call
  (`bash.rs:146-152`).

Obelisk workflows are deterministic: a resumed execution is replayed from
scratch, with only host-import results (LLM completions, activity calls,
sleeps) memoized from the durable log. Bash execution today is plain
in-workflow computation — it never crosses a host-call boundary — so **every
bash command ever run in a session is re-executed on every replay**. Replay
cost grows unboundedly with session length.

There is also no existing snapshot/serialization mechanism to build on top
of. `Vfs` is deliberately not `Serialize`
(`vendor/just-bash-rs/src/fs.rs:100-139`: several fields hold trait-object
loaders/mounts — `loader`, `mounted_loaders`, `mounts: Vec<WebMount>`,
`deferred: Vec<(String, DeferredMount)>` — that can't be serialized as-is),
and no WIT interface models "a VM" as a resource; the bash tool is purely an
LLM tool-call convention matched by string name
(`BASH_TOOLS_JSON`/`dispatch_bash`, `session.rs:77,1054`).

## Prerequisite (separate, independently shippable): pointer-ify git mounts

Deployment/CAS-mounted files already avoid eager content copies via a lazy
pointer: `LazyFileRef{digest, size}` registered through `Vfs::register_lazy`
(`vendor/just-bash-rs/src/fs.rs:57-116`), populated from real
`sha256:...` CAS digests in `obelisk_pack.rs::refresh_deployment_mount`
(lines 89-151). MCP resource mounts follow the same pattern via
`register_lazy_with_loader` (`obelisk_mcp.rs::mount_resources`, lines
176-195).

Git/GitHub mounts (`obelisk_web.rs`'s `GithubMount`, wired from
`session.rs:822-865` for `APPS_JSON`-configured apps) are already lazy at the
directory-listing and file-byte level (`Vfs::ensure_expanded`,
`fs.rs:262-289`; `Vfs::read_web_file`, `fs.rs:292-333`) — no eager `Vec<u8>`
copy into `Vfs::files` happens. But they are a structurally separate path
from the CAS pointer mechanism: bytes are cached in a `WebState.cache`
overlay, not registered via `register_lazy`/`pending`, and no real content
digest is carried through at all. The GitHub Contents API's blob `sha` is
fetched but discarded at the activity boundary
(`activity/github-contents.js::list()`, lines 50-61 return only
`{name, type, size}`); `WebEntryKind::File` (`fs.rs:47-51`) and
`obelisk_web.rs::parse_entry` (lines 95-112) likewise carry only a size, no
digest field exists.

To make git-mounted trees pointer-friendly for snapshotting (see below):

- `activity/github-contents.js::list()` — include the Contents API's `sha`
  per entry in the emitted JSON.
- `obelisk_web.rs::parse_entry` / `fs.rs::WebEntryKind::File` — carry a
  `digest` alongside `size`.
- `fs.rs::ensure_expanded` — register each discovered file via
  `register_lazy_with_loader` (mirroring `obelisk_mcp::mount_resources`)
  instead of (or in addition to) `WebState.files`.
- `fs.rs::read_web_file` — can then be retired/merged into the existing
  `pending`/`lazy_cache` read path (`register_lazy_inner`, `fs.rs:360-389`).

The one structural wrinkle: git mounts discover their tree shape
incrementally (`list()` per directory, on first `ls` under that directory),
unlike deployment/MCP mounts which fetch one full file index up front.
`register_lazy_with_loader` already registers one file at a time, so this is
additive at the `ensure_expanded`/`parse_entry` layer, not a redesign of the
core lazy-registration primitives in `fs.rs`.

This task stands on its own — it shrinks snapshot size for any session that
touches a git-mounted app/repo regardless of which VM-execution model below
is chosen, and should be done first.

## Core design

### 1. Bash execution becomes an activity call

Shape: `{script, vm-state-in} -> {result, vm-state-out}`, where `vm-state` is
a full snapshot (VFS diff + cwd + env; see format below). Moving execution
across the activity boundary means Obelisk memoizes each call's result —
replay never re-runs the interpreter, only re-fetches the recorded response,
which resolves the core problem above.

A useful side effect: every tool-call boundary now has a complete,
addressable VM snapshot. This is a natural "Fork" point for the UI — start a
new session seeded from any historical snapshot, e.g. when the model goes
off the rails and the user wants to explore a different path from an earlier
point.

### 2. The growth problem this introduces

Memoization solves *replay cost* but not *log size*: each activity call's
snapshot still rides in the *caller's* own execution log. If the parent
session workflow calls the bash-exec activity directly for every tool call,
the parent's log grows by one (potentially large) snapshot per tool call,
forever, for the life of the session — replaying the session still means
walking that whole chain of recorded responses, and the responses themselves
accumulate without bound.

### 3. Bounded-batch child workflow

Instead of the parent calling the bash-exec activity directly, it delegates
a bounded window of commands (~10-20, tunable) to a child *workflow*. That
child loops, calling the same bash-exec activity once per command (fed one
at a time by the parent — see routing below), carrying the snapshot forward
in its own memory between calls, and finishes by returning a single
collapsed snapshot to the parent.

Effect: the parent's own log grows O(1) per batch instead of O(1) per tool
call — a 10-20x reduction for typical batch sizes. Each batch child's own
log (bounded to the batch size) is only ever replayed if that specific child
itself needs to resume; it's irrelevant to the parent's replay once the
child has finished and returned its collapsed result.

True multi-level nesting (batches of batches, capping parent-visible history
at a constant regardless of total session length) is worth naming as future
work but is explicitly out of scope for the initial implementation —
single-level collapsing is the practical win and keeps the mechanism simple.

### 4. Routing commands and interrupts into the open batch child

The parent's LLM/tool-call loop decides scripts one at a time, based on
prior results, and needs to feed each one into whichever batch child is
currently open. Obelisk's child-execution primitives — `join-set-create`,
`submit-json`, `join-next`, `stub-json`
(`workflow/workflow-rs/wit/deps/obelisk_workflow@6.0.0/obelisk_workflow@6.0.0.wit:87-176`)
— are submit-once/await-once: there is no primitive for sending a second
message into an already-running child execution.

The existing in-repo answer to this is the **stub-RPC oneshot-pair /
mailbox pattern**, already used for user injection and cross-session chat
notifications: `session.rs::open_session`/`call_llm_with_user` (named join
sets + a rearmed injection stub, lines 1293-1404, 1441-1469) and
`Notifications::notify` (self-fulfilled stub, lines 520-542). Documented
generally at `website/content/docs/latest/patterns/stub-rpc.md` and
`.../patterns/stub-mailbox.md`, and explicitly named as workflow-agent's own
reference implementation in the latter. Each command exchange is a fresh
oneshot request/response stub pair (a "reply-to" execution id embedded in
the request), not a persistent channel.

Research finding worth keeping in mind for the implementation: this costs
the same order of durable-log writes per round trip (~4: submit, stub,
finish-target, join-next-consume) as a plain child submit/await pair — it is
**not cheaper in event count** than the parent calling the bash-exec
activity directly every time. The only win over direct per-call activity
calls is payload size: the VM snapshot doesn't cross the parent↔batch-child
boundary on every command, only once when the batch closes.

Interrupt/pause needs the same routing: signal the open batch child (via the
same mailbox mechanism, or by cancelling its in-flight activity call), which
then immediately finishes with the last fully-completed command's snapshot.
This bounds interrupt loss to at most one in-flight command, not a whole
batch — an improvement on a naive "snapshot only at batch end" design, and
no worse than today's in-process model (which can also lose a
currently-running script on interrupt).

### 5. Snapshot format

Files need content + sha256 for anything genuinely modified or created
during the session, but must stay pointer-only (digest + size, no bytes) for
content-addressed/immutable mounts — the deployment/CAS mount already works
this way (`LazyFileRef{digest,size}`, §Prerequisite), and git/GitHub mounts
should be brought in line with the same representation as a prerequisite to
this work. cwd and env are small scalars/maps and can always be carried in
full, in and out of every call — no diffing needed there (this generalizes
the earlier "make CWD an input and output, box in UI" framing: an explicit
value threaded through calls, not implicit state).

## Consequences / trade-offs

- Parent log growth: O(1) per batch (~10-20 commands) instead of O(1) per
  tool call today — bounded improvement, not unbounded, unless multi-level
  nesting is added later.
- Mailbox routing cost is not cheaper in event count than direct activity
  calls; its value is purely in keeping large VM-state payloads off the
  parent↔batch-child boundary except at batch close.
- UI "Fork" granularity differs by location: forking from a parent-visible
  checkpoint (a batch boundary, or an un-batched call) only needs the
  parent's own log. Forking from a point *inside* an already-closed batch
  would require reading into that specific batch child's own execution log
  to extract an interior snapshot — Obelisk retains full history for
  finished executions, so this is possible, but is not resolved by this
  design and is left as future work.

## Explicitly out of scope / open questions

- Multi-level batch nesting (batches of batches) to bound parent-visible
  history at a constant regardless of total session length.
- Exact batch-close policy: pure command-count threshold vs. count-or-
  turn-boundary (whichever comes first). Count-based is the simplest and is
  assumed above; turn-alignment is a reasonable complementary rule to
  evaluate during implementation, not decided here.
- Batch-interior fork UI support (see Consequences above).
- JS backend (`workflow-js`, `vendor/just-bash`) parity — not addressed;
  will diverge until ported later.
