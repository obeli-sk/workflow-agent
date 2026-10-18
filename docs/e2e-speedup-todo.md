# E2E speedup TODO

Open follow-ups from timing the parallel `just test-e2e` harness
(`scripts/e2e/*.test.mjs`) after making each suite's rs/js pair run
concurrently. None of these are started.

## 1. Pre-build the rs wasm once before the harness runs

Every suite independently calls `e2e_build_component` (`cargo build --release`)
for its `rs` variant, and again mid-test for any `e2e_verify_replay_parity`
swap. With 9 suites now running concurrently, that's up to ~9+ simultaneous
`cargo build` invocations against the same target directory; cargo serializes
these through its own lock file, so they queue even when nothing needs
recompiling after the first one finishes. Cheap individually, but the
lock-wait adds up across the whole run.

Fix: build `workflow/workflow-rs` once (e.g. a `build-rs` prerequisite on the
Justfile's `test-e2e` recipe) before invoking `node --test scripts/e2e/*.test.mjs`.

## 2. Tighten polling loops in agent-workflow.sh / chat.sh

These are the two slowest non-network suites (48-51s and ~44s) purely from
sequential scenario count, not any single slow operation: nearly every wait
loop polls with a flat `sleep 1` even though the underlying event usually
resolves in well under a second. Multiply a handful of polls per scenario by
7+ scenarios and the wait time dominates real work. Shortening the poll
interval (e.g. 200ms, maybe with backoff for the longer-budget loops) should
cut a meaningful chunk of both suites' wall-clock without weakening what they
assert.

## 3. `obelisk deployment submit` should fetch mount-backed files in parallel

Core-engine change (obelisk, not workflow-agent): when a manifest references
files behind a mount point, `deployment submit` currently appears to fetch
them one at a time. Fetching concurrently would speed up every suite that
submits a multi-file manifest through a mount, including
github-mount-deploy (one mock contents-API round trip per file, sequential).
