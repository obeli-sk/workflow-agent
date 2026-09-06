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

## 2. Stop forcing github-mount-deploy's rs/js pair to run concurrently

It's the one suite making a real, cold GitHub API fetch of this app's entire
`deployment.js.toml` tree (one API call per file, by design - see the script's
own docstring). Running `rs` and `js` at once means two processes hitting
GitHub's API for the same repo/ref simultaneously on one token, which likely
explains why `js` (135s) was slower than `rs` (113s) rather than matching it,
and it blew past its own 180s internal timeout once during verification.
Concurrency here is net-negative: revert `scripts/e2e/github-mount-deploy.test.mjs`
to two independent `test()`s instead of a `concurrency: true` `describe`
(unless #3 below makes this moot).

## 3. Write a mock GitHub Content API server for github-mount-deploy

The suite only needs the current repo's tree/blob content, not the real
GitHub API - a small local mock server serving this app's own checked-out
files (or a fixed fixture) would remove the network dependency, the
rate-limiting risk, and most of the suite's ~113-135s runtime, since the
mount would resolve against localhost instead of a real round trip per file.

Trade-off to resolve before doing this: the suite's whole reason for existing
is being "the most faithful reproduction of the actual failure" against a
*real* GitHub round trip (see its docstring - it's the regression test for
E_01M1MFSEK7GXAJWFN4N3GGAZRN/E_01M1MG45ERCAGDE47WQX2GTAEY). Mocking the
transport keeps the VFS/mount logic under test but loses coverage of the real
GitHub API's actual response shapes/quirks. Consider keeping a real-network
variant for manual/periodic runs and using the mock version as the default
fast path in `just test-e2e`/CI.

## 4. Tighten polling loops in agent-workflow.sh / chat.sh

These are the two slowest non-network suites (48-51s and ~44s) purely from
sequential scenario count, not any single slow operation: nearly every wait
loop polls with a flat `sleep 1` even though the underlying event usually
resolves in well under a second. Multiply a handful of polls per scenario by
7+ scenarios and the wait time dominates real work. Shortening the poll
interval (e.g. 200ms, maybe with backoff for the longer-budget loops) should
cut a meaningful chunk of both suites' wall-clock without weakening what they
assert.

## 5. `obelisk deployment submit` should fetch mount-backed files in parallel

Core-engine change (obelisk, not workflow-agent): when a manifest references
files behind a mount point, `deployment submit` currently appears to fetch
them one at a time. Fetching concurrently would speed up every suite that
submits a multi-file manifest through a mount, and directly attacks
github-mount-deploy's dominant cost (one GitHub API round trip per file,
sequential) independently of #3.
