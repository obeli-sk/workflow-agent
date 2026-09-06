# Investigating cross-backend replay-parity failures

Status: methodology write-up, current as of the 2026-09-06 stdout/stderr
chunk-order fix (commit `9ed8fc4`), which followed the `which`/help-text
indentation fixes (commits `726b6d5`, `d89ae15`). Read this before touching
`e2e_verify_replay_parity`, a live-swap auto-upgrade failure, or anything in
`crates/wasm-workers/src/workflow/{event_history,replay_advance}.rs` in the
Obelisk checkout — the instinct to blame Obelisk-core's replay engine is
usually wrong, and chasing it burns a lot of time.

## Symptom

`obelisk execution replay --json` (or a live deployment swap, which uses the same
mechanism) fails with:

```
NondeterminismDetected { detail: "key does not match event stored at
version N: key: JoinNext(n:user-{turn} closing), event: Stub(...
n:session-events_M)" }
```

This looks like a join-set bug: the replaying backend appears to decide to
*close* the current turn's `n:user-{turn}` join set at a point where
production did a plain, non-closing wait. **It almost never is one.** See
"What it actually is" below before spending time on join-set semantics,
`advance_turn`/`take_user_event` ordering, or Obelisk's `replay_advance.rs`
finalize path — all three were dead ends the first time through this.

## What it actually is

`session.rs`/`session.js` batch every published event (`shell_output`,
`agent_status`, help text, etc.) into one `record-output` self-stub call:
submit a child to itself, immediately stub its own result, then await it —
all in the *same* tick, so the durable log records `Submit → Stub → Await`
back to back. The `Stub` event's identity includes a hash of the value being
stubbed.

If the **content** of that value differs between the Rust and JS backends —
even by one byte, e.g. a help string missing two leading spaces, or `which`
printing `curl` instead of `/usr/bin/curl` — the retval hash differs too.
Replaying one backend's history under the other then fails to match that
`Stub` event, and the failure surfaces as a *generic* `NondeterminismDetected`
several events later, at the *next* thing the replaying code tries to do
(typically the next turn's join-set wait) — which is why the error message
points at an unrelated-looking `JoinNext` close instead of at the actual
diverging value.

**In short: find the shell output (or any self-stubbed value) that differs
byte-for-byte between backends. That's the bug, not the join-set close.**

Three confirmed root causes so far, all output-divergence bugs, not replay-
engine bugs:

1. `which` (`vendor/just-bash/src/commands/core.js` vs
   `vendor/just-bash-rs/src/commands/misc.rs`): JS echoed the bare command
   name; Rust simulates `PATH` resolution and prints `/usr/bin/<name>`.
2. Help text indentation (`vendor/just-bash/src/obelisk-pack.js` vs
   `vendor/just-bash-rs/src/obelisk_pack.rs`, and the same pattern again in
   `vendor/just-bash/src/obelisk-mcp.js` vs `vendor/just-bash-rs/src/obelisk_mcp.rs`'s
   `server_help`/`registry_help`, fixed in `1905eaa`): Rust's multi-line
   string literals use a trailing `\` to continue onto the next source line —
   **which silently strips *all* leading whitespace on that next line**, a
   real Rust language quirk, not a formatting choice. Visually-indented
   subcommand lists in the `.rs` source (`  list ...`, `  wit ...`) actually
   compile to unindented strings. JS's literals don't have this quirk, so
   they kept their source indentation and diverged. Any other `*_help()`-style
   function using this backslash-continuation trick in Rust is a candidate;
   grep the `.rs` file for lines ending in `\` to find them all in one pass.
3. stdout/stderr chunk order (`vendor/just-bash/src/interpreter.js`'s
   `runSimple` vs `vendor/just-bash-rs/src/interpreter.rs`'s
   `run_pipeline`): not a content divergence at all, a *structural* one.
   A command's `CommandOutput` carries stdout/stderr as two monolithic
   strings with no real interleaving info once both are non-empty (true of
   most custom commands, e.g. `chat watch`'s loop, which accumulates stderr
   notes throughout and only builds the final stdout string at the very
   end). JS delivered stdout before stderr; Rust delivers stderr before
   stdout. Both are internally consistent but disagree with each other, so
   a command emitting non-empty output on *both* streams produced
   differently-ordered `output` chunk arrays for byte-identical content —
   the WIT `output-chunk` list order is part of what gets hashed into the
   self-stubbed `shell_output` event. Found via `chat watch --timeout`
   (`scripts/test-e2e-chat.sh`), fixed in `9ed8fc4` by swapping the two
   `deliver()` calls in `runSimple` to match Rust's order.

Any other place where a bash builtin, a `--help` string, an error message,
or `ls`-style formatting can differ between the two interpreters is a
candidate for the same bug class (this is also documented, from an earlier
round, for `ls -la` collation/permissions formatting and
`permanent-error`/`transient-error` decoding — see git log for
`feat: align ls output across workflow backends` /
`feat: align workflow command replay output`).

## Step 1: build a minimal, fast repro — don't debug the real session

A 500+-event production session and a 6-line minimal repro hit the *same*
bug with the *same* error signature. Build the minimal one first:

```bash
# scripts/test-e2e-minimal-swap-repro.sh — already checked in.
# Empty session, ONE direct shell turn, then a live swap. ~15s, deterministic.
nix develop -c bash scripts/test-e2e-minimal-swap-repro.sh rs   # rs -> js
nix develop -c bash scripts/test-e2e-minimal-swap-repro.sh js   # js -> rs
```

Edit the hardcoded script string in that file (`"which curl && curl
--version"`) to whatever command you suspect, re-run, and see if it still
reproduces. If your suspect script does NOT reproduce, the bug is somewhere
else in the sequence — bisect by adding commands one at a time.

## Step 2: use `obelisk execution replay --json`, not a live swap

A full live swap is slow (rebuild, apply deployment, wait for the executor to
pick it up, wait for it to fail). `obelisk execution replay` does the same
non-destructive replay check directly against a specific execution, in
milliseconds, against a server whose *active* deployment is just the other
language:

```bash
# Start a server pointed at the SAME preserved sqlite dir the failing test
# left behind, with the deployment set to the OTHER backend, then:
obelisk execution replay --json -a http://127.0.0.1:PORT --api-token TOKEN <EXECUTION_ID>
```

This returns the exact same `NondeterminismDetected` detail message
instantly, and you can re-run it repeatedly against the same DB without
re-driving the whole session. `e2e_verify_replay_parity` in `e2e-lib.sh`
already wraps this for the tail of every e2e script.

Preserved sqlite dirs are printed by every e2e script on exit:
`>>> preserved isolated sqlite state at /tmp/nix-shell.XXX/.../obelisk-sqlite`.
Point a fresh `obelisk server run --database.sqlite.directory <that path>`
at it (see any `e2e_start_server` call for the full env-var list — token,
`TARGET_OBELISK_*`, `AGENT_MODELS`, etc. all need to be set even for a
read-only query server, or the workflow component fails to link).

## Step 3: get resolved backtraces for the last-matched call

`obelisk execution persist-backtraces <execution_id>` replays the execution
under the *currently active* component and durably records a WASM backtrace
for every successfully-matched call, up to (but not including) the one that
fails to match. That last matched call's backtrace tells you exactly where
production's own logic was, right before the divergence — which is usually
the `flush()`/self-stub call whose *value* is the actual culprit, not its
control flow.

Run `persist-backtraces` first, then find the version to look at:

```bash
obelisk execution persist-backtraces -a http://127.0.0.1:PORT --api-token TOKEN <EXECUTION_ID>
obelisk execution events --json -a http://127.0.0.1:PORT --api-token TOKEN <EXECUTION_ID>
```

The failing replay's error detail already names the version
(`NondeterminismDetected`'s "key does not match event stored at version N"),
but `events --json` is how you read the surrounding history to see what
*should* be there and pick the version right before the mismatch — that's
the one whose backtrace you want, i.e. the last call that matched.

Then fetch the backtrace for that version directly over HTTP — this is a
real endpoint, just not yet wrapped by the `obelisk` CLI:

```bash
curl -H "Authorization: Bearer TOKEN" \
  "http://127.0.0.1:PORT/v1/executions/<EXECUTION_ID>/backtrace?version=<N>"
```

(Querying `t_execution_backtrace`/`t_wasm_backtrace` directly in sqlite also
works and is useful for scanning a whole range at once, but the HTTP
endpoint is the normal path and needs no direct DB access.)

**Rust backtraces are unresolved (`<wasm function N>`, no file/line) unless
the component was built with debug info.** The workspace's release profile
sets `strip = "symbols"`, which removes it. Don't switch to a `cargo build`
dev profile for this (different optimization level, slower, and it's easy to
forget which artifact a deployment.toml is pointing at) — instead add to
`workflow/workflow-rs`'s (or the workspace) `[profile.release]`:

```toml
[profile.release]
debug = "line-tables-only"
strip = "none"
```

This keeps the release optimization level (matching what actually runs in
production) while retaining enough debug info for `file`/`line` to resolve.
Rebuild, redeploy, reproduce, then revert the profile change before
committing anything else — it's a diagnostic-only setting.

### Get both sides without swapping — run two executions, not one

Don't reuse a single execution's sqlite rows and flip the active deployment
back and forth to collect backtraces "from both sides" — it's fiddly (stale
rows from an earlier `persist-backtraces` run block a re-run against a
different component build, since `t_execution_backtrace` is keyed by
`(execution_id, version range)`, not by component digest, so you have to
`DELETE FROM t_execution_backtrace WHERE execution_id = '...'` between
attempts) and it's unnecessary. Simplest: submit the **same script** as two
independent executions, one against each backend's deployment, and run
`persist-backtraces` + the HTTP endpoint on each one against its own
(matching, no swap needed) active component. Two clean executions, two
straightforward backtrace fetches, nothing to delete or swap.

This only breaks down if the session has genuine external side effects that
could differ between the two independent runs (a GitHub API response, a
timestamp, anything not purely a function of the script text) — in that
case the two executions' histories could diverge for reasons unrelated to
the bug you're chasing, and you'd want the *exact same* recorded history
replayed under both languages instead. The clean way to do that is copying
one execution's db rows to a fresh execution ID and running
`persist-backtraces` against it under the other language's active
deployment — **that copy tooling doesn't exist yet**, so for now this path
only matters when you've confirmed external effects actually differ; for
anything driven purely by shell/bash builtins (which covers both bugs found
so far) two independent same-script executions are equivalent and much
simpler.

Whichever way you get there, confirm the two backtraces point at the *same*
logical call site in each language's source (e.g.
`session.js:161`/`takeUserEvent`/`session.js:504` paired with
`session.rs:573`/`take_user_event`/`session.rs:1600`). If they match, the
control flow is correct on both sides up to that point — which tells you to
stop looking at control flow and start looking at *values*.

## Step 4: diff the actual shell output between backends

Once you know which shell command precedes the divergence, run it on each
backend standalone (no swap) and diff the raw output byte-for-byte — don't
trust a terminal render, extract via `--json` and `repr()`/`JSON.stringify`
so leading whitespace and control characters are visible:

```bash
# Fetch the live transcript for a running session:
curl -H "Authorization: Bearer TOKEN" http://host:port/api/runs/<ID> \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['transcript']['shell_events'])"

# Or pull one record-output stub's value directly:
obelisk execution result --json -a URL --api-token TOKEN <ID>.n:session-events_N
```

A test's own golden-value assertion (e.g. `test-e2e-agent-workflow.sh`'s
`ls -la` collation check) only proves *one* backend's output matches what
that backend has always produced — it says nothing about whether the *other*
backend produces the identical string. Always diff both sides directly.

For a systemic class of bug (like the help-text indentation one, which hit
five different functions), don't fix pairs one at a time — dump every
candidate string from both languages in one pass and diff programmatically.
For the Rust side, extract the string-returning functions into a standalone
`rustc`-compiled snippet (no crate deps needed for pure string literals) and
`println!("{:?}", fn())` each one; for JS, regex out each `const … = "…";`
and `eval()` it. See the fix commits for both scripts.

## Common pitfalls (things that looked like fixes and weren't)

- **Rearming the injection join set at a different point in the turn loop.**
  Looked plausible (a join set with a pending, unawaited child getting
  closed), had a whole passing test suite, and made zero difference to the
  failure signature (byte-identical error, just a shifted version number).
  If a "fix" doesn't change the *version number* or *key* in the error
  detail at all, it isn't touching the actual cause.
- **An unclosed anonymous join set in JS's `askUser`** (JS has no `Drop`, so
  a `finally { joinSet.close() }` was missing). Real hygiene issue, matches
  Rust's resource-cleanup discipline, but harmless for replay: by the time
  the function returns normally the join set has no pending children left
  to reconcile, so leaving it open can't affect determinism. Worth fixing
  for its own sake, not because it explains a `NondeterminismDetected`.
- **Assuming it's `crates/wasm-workers/src/workflow/replay_advance.rs`'s
  finalize path** (an actual, once-suspected, since-retracted diagnosis —
  see `docs/js-backend-migration.md`'s "New known-red" / "Update,
  replay-finalize gap resolved" entries). It reads exactly like a host bug
  from the error message alone. It wasn't, both times.
- **Testing with `usize::MAX` step/event limits in a synthetic Obelisk-repo
  unit test.** If you're trying to reproduce this class of bug with a
  from-scratch WIT test workflow, matching the *shape* (interleaved named
  join sets, a reused self-stub join set, a blocking wait) will replay fine
  every time, because the actual trigger is a value divergence in a real
  bash-interpreter builtin or help string that a synthetic stub-activity
  can't reproduce. Don't invest in an isolated repro at the Obelisk-core
  level for this bug class — the fast repro belongs at the workflow-agent
  e2e level (Step 1).

## After fixing a divergence

1. Re-run the minimal repro (Step 1) in both directions.
2. Re-run `just test-js` and `just test-rs` — an output-format fix has no
   reason to break existing unit tests, but confirm anyway.
3. Re-run the full e2e suite (`just test-e2e`, or the individual
   `scripts/test-e2e-*.sh {rs,js}` pairs) with `GITHUB_TOKEN` exported
   (`GITHUB_TOKEN="$GH_TOKEN"` if only `gh`'s token is present in the
   sandbox) — several suites' replay-parity checks share this bug class and
   will newly pass once the divergence they hit is fixed.
4. If a *different* divergence surfaces further into a longer test now that
   an earlier one is fixed (this will happen — tests run further before
   hitting the next unfixed byte-mismatch), that's expected. Go back to
   Step 3/4 for the new one; don't assume the mechanism has changed.
