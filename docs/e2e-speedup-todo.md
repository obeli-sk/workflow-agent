# E2E speedup TODO

Open follow-ups from timing the parallel `just test-e2e` harness
(`scripts/e2e/*.test.mjs`). None of these are started.

## 1. Tighten polling loops in agent-workflow.sh / chat.sh

These are the two slowest non-network suites (48-51s and ~44s) purely from
sequential scenario count, not any single slow operation: nearly every wait
loop polls with a flat `sleep 1` even though the underlying event usually
resolves in well under a second. Multiply a handful of polls per scenario by
7+ scenarios and the wait time dominates real work. Shortening the poll
interval (e.g. 200ms, maybe with backoff for the longer-budget loops) should
cut a meaningful chunk of both suites' wall-clock without weakening what they
assert.

## 2. `obelisk deployment submit` should fetch mount-backed files in parallel

Core-engine change (obelisk, not workflow-agent): when a manifest references
files behind a mount point, `deployment submit` currently appears to fetch
them one at a time. Fetching concurrently would speed up every suite that
submits a multi-file manifest through a mount, including
github-mount-deploy (one mock contents-API round trip per file, sequential).
