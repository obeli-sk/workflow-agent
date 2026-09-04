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

## Core design

### 0. The exec unit must be a workflow, not a plain activity

An earlier version of this design called the per-command exec unit an
"activity call". That doesn't work: several bash builtins already reach
through the interpreter's host seams into `obelisk:workflow/workflow-support`
primitives that are workflow-only and unavailable to activities. Confirmed
both by the public docs and by the concrete WIT/wiring in this repo:

- **Docs are explicit.** `website/content/docs/latest/concepts/runtime-support.md:13-15`:
  "Activities and webhook endpoints have access to logging support
  functions, but _not_ to the other workflow-specific functions." Join sets
  (the mechanism behind child executions and delays) are documented as "a
  core mechanism for handling structured concurrency ... in Obelisk
  workflows" (`.../concepts/workflows/join-sets.md:6-7`), and persistent
  sleep the same way (`.../concepts/workflows/persistent-sleep.md:1-7`).
  Activities have no join-set or sleep capability at all.
- **`sleep` (and `date`'s clock read)** go through `host_sleep_ms`/
  `host_now_ms`, both thin wrappers over `workflow_support::sleep`
  (`workflow/workflow-rs/src/session.rs:56-69`, wired in at `:687`) — the
  durable, resume-after-restart primitive, not a busy-wait.
- **`curl` and every other Obelisk-backed "program"** are registered as bash
  custom commands (`session.rs:724-732`) whose handler
  (`vendor/just-bash-rs/src/obelisk_program.rs:27-40`) calls
  `host.call_json(ffqn, params)`. `RealHost::call_json`
  (`workflow/workflow-rs/src/host.rs:85-101`) forwards to
  `workflow_support::call_json`, documented in WIT as "Equivalent to
  join-set-create + submit-json + join-next + join-set-close"
  (`workflow-rs/wit/deps/obelisk_workflow@6.0.0/obelisk_workflow@6.0.0.wit:162-163`)
  — a real child execution, not an in-process HTTP client.
- **The `obelisk` command and target-Obelisk RPCs** (`obelisk functions`,
  `executions`, `call`, `deployment`, and the `obelisk-control:tools/*`
  programs that read `TARGET_OBELISK_API_URL`/`_TOKEN`, see `README.md:58-90`)
  all bottom out in the same `call_json` seam via
  `obelisk-control:tools/native.call` (`vendor/just-bash-rs/src/obelisk_pack.rs:1018-1024`).
  `ask-user` additionally calls `workflow_support::join_set_create`/
  `submit_json`/`join_next` directly (`host.rs:38-46`).
- **The component wiring reflects this.** `workflow-rs`'s only WIT world
  (`workflow/workflow-rs/wit/impl.wit:1-13`) imports
  `obelisk:workflow/workflow-support@6.0.0`; that's what `RealHost` and
  `host_sleep_ms` close over. `bash-rs`'s standalone world
  (`workflow/bash-rs/wit/world.wit:1-13`), scaffolded as a plain
  `func(script, stdin) -> result<...>` export with *no imports at all*, has
  no way to obtain that capability — it is shaped like an activity precisely
  because it predates this concern.

Net effect: the exec unit can't be an opaque `{script, vm-state-in} ->
{result, vm-state-out}` activity, because a script can suspend mid-execution
on a durable sleep, or spawn/await a child execution (a program call, a
target-Obelisk RPC, an ask-user round trip) that needs join-set primitives
only a workflow-typed component can import. The unit has to be a **child
workflow** call instead — Obelisk memoizes child workflow results in the
caller's log the same way it memoizes activity results, so the fix below
still holds; only the WIT shape of the callee changes (a workflow export
importing `workflow-support`, not an activity export importing nothing).

### 1. Bash execution becomes a child workflow call

Shape: `{script, vm-state-in} -> {result, vm-state-out}`, where `vm-state` is
a full snapshot (VFS diff + cwd + env; see format below), same as before —
only the callee's WIT shape changes from an activity export to a workflow
export that itself imports `obelisk:workflow/workflow-support@6.0.0`, so
`sleep`/`curl`/`obelisk`/ask-user builtins keep working unmodified inside it.
Moving execution across this child-execution boundary means Obelisk memoizes
each call's result — replay never re-runs the interpreter, only re-fetches
the recorded response, which resolves the core problem above.

No concrete WIT has been drafted yet for either the call signature or the
`vm-state` record's fields (see the Snapshot format gap in §5 below) — the
shape above is still prose-level, not a reviewed interface.

A useful side effect: every tool-call boundary now has a complete,
addressable VM snapshot. This is a natural "Fork" point for the UI — start a
new session seeded from any historical snapshot, e.g. when the model goes
off the rails and the user wants to explore a different path from an earlier
point.

### 2. The growth problem this introduces

Memoization solves *replay cost* but not *log size*: each child workflow
call's snapshot still rides in the *caller's* own execution log. If the
parent session workflow calls the bash-exec child workflow directly for
every tool call, the parent's log grows by one (potentially large) snapshot
per tool call, forever, for the life of the session — replaying the session
still means walking that whole chain of recorded responses, and the
responses themselves accumulate without bound.

### 3. Bounded-batch child workflow

Instead of the parent calling the bash-exec child workflow directly, it
delegates a bounded window of commands (~10-20, tunable) to a child
*workflow*. That child loops, calling the same bash-exec child workflow once
per command (fed one at a time by the parent — see routing below), carrying
the snapshot forward in its own memory between calls, and finishes by
returning a single collapsed snapshot to the parent.

Effect: the parent's own log grows O(1) per batch instead of O(1) per tool
call — a 10-20x reduction for typical batch sizes. Each batch child's own
log (bounded to the batch size) is only ever replayed if that specific child
itself needs to resume; it's irrelevant to the parent's replay once the
child has finished and returned its collapsed result.

True multi-level nesting (batches of batches, capping parent-visible history
at a constant regardless of total session length) is worth naming as future
work but is explicitly out of scope for the initial implementation —
single-level collapsing is the practical win and keeps the mechanism simple.

Open question worth resolving during implementation: the batch child is
*itself* already a workflow with direct `workflow-support` access (§0), so
it doesn't strictly need a further nested child-workflow call per command —
it could just interpret each command inline in its own body, the same way
the single long-lived session does today, and rely on the batch boundary
alone for memoization. That's simpler and avoids doubling the
child-execution layers (see the event-count note in §4), at the cost of
losing the per-command Fork snapshot and per-command replay-memoization
*within* an in-progress batch (if the batch child itself crashes and
resumes mid-batch, it re-interprets from the top of the batch instead of
re-fetching each prior command's memoized result). Given the batch size is
bounded (~10-20 commands), that worst case is still bounded, not unbounded —
so inlining may be the better default unless per-command Fork granularity is
a hard requirement. This decision determines whether a separate "bash-exec
child workflow" WIT export is needed at all, so it should be settled before
implementation starts.

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
**not cheaper in event count** than the parent calling the bash-exec child
workflow directly every time. The only win over direct per-call child
workflow calls is payload size: the VM snapshot doesn't cross the
parent↔batch-child boundary on every command, only once when the batch
closes.

Interrupt/pause needs the same routing: signal the open batch child (via the
same mailbox mechanism, or by cancelling its in-flight child execution),
which then immediately finishes with the last fully-completed command's
snapshot. This bounds interrupt loss to at most one in-flight command, not a
whole batch — an improvement on a naive "snapshot only at batch end" design,
and no worse than today's in-process model (which can also lose a
currently-running script on interrupt).

### 5. Snapshot format

Files need content + sha256 for anything genuinely modified or created
during the session, but must stay pointer-only (digest + size, no bytes) for
content-addressed/immutable mounts — deployment/CAS and git/GitHub mounts
already use this representation (`LazyFileRef{digest,size}`). cwd and env are
small scalars/maps and can always be carried in
full, in and out of every call — no diffing needed there (this generalizes
the earlier "make CWD an input and output, box in UI" framing: an explicit
value threaded through calls, not implicit state).

This states policy, not mechanism, and the mechanism is the hard part: `Vfs`
is deliberately not `Serialize` (Problem section above,
`vendor/just-bash-rs/src/fs.rs:100-139`) because of its trait-object
loaders/mounts. Unresolved:

- Is the "diff" a full walk of the overlay on every call (simple, but
  potentially re-serializes unchanged files every snapshot), or a true
  incremental diff against the specific `vm-state-in` that was passed in
  (needs a way to tell "changed since that snapshot" apart from "changed
  since session start")?
- How does the callee reconstruct a working `Vfs` — with its live
  loaders/mounts reattached — from `vm-state-in` plus the session's static
  mount config, before applying the diff on top?

Neither is decided; both need answering before `vm-state`'s WIT shape (§1)
can be drafted.

## Consequences / trade-offs

- Parent log growth: O(1) per batch (~10-20 commands) instead of O(1) per
  tool call today — bounded improvement, not unbounded, unless multi-level
  nesting is added later.
- Mailbox routing cost is not cheaper in event count than direct
  child-workflow calls; its value is purely in keeping large VM-state
  payloads off the parent↔batch-child boundary except at batch close.
- UI "Fork" granularity differs by location: forking from a parent-visible
  checkpoint (a batch boundary, or an un-batched call) only needs the
  parent's own log. Forking from a point *inside* an already-closed batch
  would require reading into that specific batch child's own execution log
  to extract an interior snapshot — Obelisk retains full history for
  finished executions, so this is possible, but is not resolved by this
  design and is left as future work.

## Explicitly out of scope / open questions

Roughly in the order they'd need resolving before implementation can start
(the first two are load-bearing architecture decisions; the rest can be
decided or deferred during implementation without blocking a first cut):

- Whether the per-command exec unit inside a batch is a further nested
  child workflow call or inline interpretation in the batch child's own body
  (§3) — undecided, and determines whether a separate "bash-exec child
  workflow" WIT export exists at all.
- VFS snapshot mechanics: full-walk-per-call vs. incremental diff, and how a
  working `Vfs` gets reconstructed from a snapshot plus static mount config
  (§5) — undecided; blocks drafting `vm-state`'s WIT shape.
- Concrete WIT for the child-workflow call signature and the `vm-state`
  record's fields (§1) — not drafted yet, only described in prose.
- Multi-level batch nesting (batches of batches) to bound parent-visible
  history at a constant regardless of total session length.
- Exact batch-close policy: pure command-count threshold vs. count-or-
  turn-boundary (whichever comes first). Count-based is the simplest and is
  assumed above; turn-alignment is a reasonable complementary rule to
  evaluate during implementation, not decided here.
- Batch-interior fork UI support (see Consequences above).
- JS backend (`workflow-js`, `vendor/just-bash`) parity — not addressed;
  will diverge until ported later.
