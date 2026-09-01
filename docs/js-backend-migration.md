# JS-only workflow backend: migration notes

Status: **in progress** (Phase 0). This doc tracks design decisions and
progress for the JS-alternative workflow backend so another agent can resume
without re-deriving the research. Update it after every phase.

## Why

`apps/workflow-agent` originally shipped a JS-only agent-loop workflow (Boa JS
runtime + vendored `just-bash`), replaced by a native Rust workflow
(`workflow/workflow-rs` + `vendor/just-bash-rs`) in `f0e5439`/`eac1dd2`. We are
restoring a JS backend as a **permanent second option**, full feature parity
with the Rust workflow, Rust remaining the default, switchable via one env
var with no rebuild.

**The reason this matters beyond "having a choice of language": a plain,
unbundled, dependency-free JS component is something the agent itself can
author.** The agent's own `packs/obelisk-control` tools already let it
`deployment-checkout` / edit / `deployment-submit` / `apply-deployment`
components onto the *target* Obelisk instance it controls, entirely from
inside its own bash session — but only for source it can read and rewrite as
plain text. It has no Rust toolchain in that sandbox. A JS workflow whose
deployed artifact **is** its readable source (no compile/bundle step) is
something the agent can genuinely read, modify, and redeploy — to itself or to
a target instance — the same way it already edits JS activities. A bundled/
minified esbuild artifact, or TypeScript requiring `tsc`, would defeat this;
so would vendoring `/workspace/just-bash`'s TypeScript or its commands that
pull bare npm packages (`diff`, `minimatch`, `sprintf-js`, ... — no
`node_modules` exists at deploy time, only the files Obelisk deploys).

Consequence: the JS bash interpreter is a **hand-written, dependency-free
plain-JS port**, algorithmically informed by `/workspace/just-bash` (the
upstream TS reference) and by `vendor/just-bash-rs` (today's fidelity
baseline, itself dependency-free for the same reason, per `port-findings.md`),
not a copy-and-build of either. Command scope target: **full parity with
`vendor/just-bash-rs`'s command set** (confirmed with the user), not just the
core subset session.rs exercises day to day.

## Key technical facts (from research, still valid)

- **Workflows cannot read env vars.** Only activities/webhooks can. The
  Rust-vs-JS backend switch therefore lives in the JS *callers* that schedule/
  list the workflow (`webhook/lib/mutations.js`, `webhook/lib/runs.js`,
  `activity/chat.js`), not inside the workflow itself.
- **`obelisk.schedule(execId, ffqnString, argsArray, scheduleAt?)`** (webhook
  JS) takes a plain runtime-string FFQN — no static import/WIT plumbing needed
  to make the schedule call switchable by env var.
- **`deployment.toml` `location` has no env-var interpolation** — both the
  Rust (`[[workflow_wasm]]`) and JS (`[[workflow_js]]`) workflow components
  must be registered simultaneously under two distinct FFQNs; the env var only
  picks which one new sessions are scheduled against.
- **`[[workflow_js]]` blocks declare params/return_type inline in the TOML**
  (like `activity_js`), no separate `.wit` file needed for the export itself.
  `wit = "wit"` (existing top-level dir) is still needed for the JS side's
  imports of `obelisk-agent:stub/stub`, `obelisk-agent:llm/chat`,
  `obelisk-agent:tools/webapi`.
- **Multi-file ESM works natively, no bundler**: Obelisk's JS runtimes load a
  closed module graph (`boa-common::graph::register_source_modules`) and
  resolve relative `./`/`../` imports against sibling deployment files — this
  is how e.g. `activity/chat.js` already imports `../shared/session-state.js`
  today with zero build step. Bare npm-package imports (non-relative,
  non-`obelisk:`/FFQN specifiers) do **not** resolve — there is no
  `node_modules` in a deployment — hence the hand-port requirement above.
- **Boa's workflow runtime still has no `fetch`, `TextEncoder`/`TextDecoder`,
  or `crypto.subtle.digest`** (only webhook's runtime got HMAC-only
  `crypto.subtle`). The old `boa-polyfills.js` hand-rolled shims (UTF-8
  codec, base64, SHA-256/SHA-1) are still required, essentially unchanged.
- FFQN naming chosen: JS workflow exports
  `obelisk-agent:workflow-js/workflow.run-cancellable` (same params/return
  type as the Rust `obelisk-agent:workflow/workflow.run-cancellable`),
  `[[workflow_js]] name = "workflow_agent_js"` (component names: `[a-zA-Z0-9_]`
  only, package names in the FFQN may use hyphens like existing
  `workflow-obelisk-ext`).
- Switch env var: `WORKFLOW_FFQN`, default = the Rust FFQN. Listing
  (`runs.js` sidebar, `chat list`) merges **both** known FFQNs so switching
  never hides sessions started under the other backend; only *scheduling new
  sessions* honors the single active value. A session's own `chat create`
  always schedules its own kind (self-referential, no env needed).

## Directory layout (target)

- `apps/workflow-agent/vendor/just-bash/` — hand-written plain-JS interpreter
  (lexer/parser/AST/interpreter/VFS/commands), ESM, relative imports only, no
  `package.json`/build step. Mirrors `vendor/just-bash-rs`'s module
  breakdown where sensible (same command coverage target) rather than mapping
  file-for-file to the TS reference.
- `apps/workflow-agent/workflow/workflow-js/` — the session/agent-loop source
  (mirrors `workflow/workflow-rs/src/{lib,agent,host,session,support,chat}.rs`
  → `.js` siblings), plus resurrected `boa-polyfills.js` (no `node-zlib-shim.js`
  needed since we no longer bundle — just don't import `node:zlib` at all: no
  gzip/gunzip/zcat command, matching `WORKFLOW_UNAVAILABLE_COMMANDS` from the
  old JS version and `just-bash-rs`'s command set never including them
  either).
- No root `package.json`/`pnpm-workspace.yaml`/`Justfile` `install`/`build-js`
  targets — there is nothing to build. `just verify` (already present) is the
  only check needed pre-deploy; add a `test-js-workflow` Justfile target once
  unit tests exist (plain `node --test`, matching the rest of the repo).

## Phase checklist

- [x] Phase 0a: migration doc (this file).
- [x] Phase 0b: directory skeleton (`workflow/workflow-js/src/session.js`) +
      trivial `[[workflow_js]]` export at
      `obelisk-agent:workflow-js/workflow.run-cancellable` (`name =
      "workflow_agent_js"`), deployed alongside the Rust workflow.
      `nix develop -c just verify` passes with **both** `workflow_agent_rs`
      and `workflow_agent_js` registered (`deployment_compile_link: Obelisk
      configuration was verified`) — confirms two workflow components under
      distinct FFQN packages coexist cleanly in one deployment.toml. Branch:
      `js-backend`.
- [ ] Phase 0c: one-time TS→JS type-stripping of `/workspace/just-bash` as
      reference material for Phase 1/2 (see "De-typing recipe" below) — not
      committed, regenerate on demand.
- [ ] Phase 1: interpreter core (lexer/parser/AST/interpreter/VFS) + core
      session loop (bash-per-session, turn loop, injection racing, llm/chat,
      session-events). No programs/MCP/mounts/interrupt/step-budget/chat yet.
- [ ] Phase 2: full command-set parity with `vendor/just-bash-rs/src/commands/`
      (awk, sed, grep, jq, diff, sort/uniq, hash, timeutil, find, fsutil,
      xargs, misc, text/textutil2). Track per-command status in a table below
      as they land.
- [ ] Phase 3: `obelisk` pack command + deferred mounts (port of
      `obelisk_pack.rs`), programs registry (`obelisk_program.rs`), MCP
      (`obelisk_mcp.rs`), GitHub components mount (`obelisk_web.rs`), `mount`
      command. Apply `port-findings.md` §B1-B6 fixes as needed.
- [ ] Phase 4: step-budget nudge, per-script interrupt/timeout
      (`script_watch.rs` port), session rename, `ask-user`.
- [ ] Phase 5: `chat` peer-sessions workflow-side wrapper (`chat.rs` port).
- [ ] Phase 6: `WORKFLOW_FFQN` switch wiring (`mutations.js`, `runs.js`,
      `activity/chat.js`, `deployment.toml` env_vars), README/docs.
- [ ] Phase 7: test parity (`node --test` unit tests, e2e suites against both
      backends, CI).

## Command parity tracker (Phase 2)

Fill in as commands land; source of truth for scope is
`vendor/just-bash-rs/src/commands/*.rs`.

| Command family | just-bash-rs file | JS status |
|---|---|---|
| awk | `commands/awk.rs` | not started |
| sed | `commands/sed.rs` | not started |
| grep | `commands/grep.rs` | not started |
| jq | `commands/jq.rs` | not started |
| diff | `commands/diff.rs` | not started |
| find | `commands/find.rs` | not started |
| fsutil (ls/cp/mv/rm/mkdir/...) | `commands/fsutil.rs` | not started |
| sort/uniq | `commands/sort_uniq.rs` | not started |
| hash | `commands/hash.rs` | not started |
| timeutil | `commands/timeutil.rs` | not started |
| xargs | `commands/xargs.rs` | not started |
| misc | `commands/misc.rs` | not started |
| text | `commands/text.rs` | not started |
| textutil2 | `commands/textutil2.rs` | not started |

## De-typing recipe (Phase 1/2 prep)

`/workspace/just-bash` is TypeScript; we can't vendor it as-is (no build step
allowed in the deployed component) or hand-retype ~120K lines from scratch.
Use a one-time, no-bundle esbuild pass to strip types only (preserves the
relative-import module graph 1:1, since the TS source already writes
`import ... from "./foo.js"` NodeNext-style — the output `.js` files land at
matching paths). This is an authoring aid only, never run at deploy time:

```bash
cd /workspace/just-bash/packages/just-bash/src
FILES=$(find . -name "*.ts" -not -name "*.test.ts" -not -name "*.security.test.ts" \
  -not -path "./commands/python3/*" -not -path "./commands/sqlite3/*" -not -path "./commands/js-exec/*" \
  -not -path "./network/*" -not -path "./cli/*" -not -path "./security/*" -not -path "./comparison-tests/*" \
  -not -path "./spec-tests/*" -not -path "./agent-examples/*" -not -path "./sandbox/*" -not -path "./transform/*" \
  -not -path "./shell/*")
nix run nixpkgs#esbuild -- $FILES --outdir=<scratch>/out --outbase=. --format=esm --target=es2022
```

321 files, ~122K lines detyped cleanly (no errors). This is **raw reference
material**, not something to commit verbatim: it includes ~90 single-purpose
command dirs (`cat`, `wc`, `tr`, `nl`, `od`, `paste`, ...) where
`vendor/just-bash-rs` consolidates many commands per file
(`text.rs`/`textutil2.rs`/`fsutil.rs`/`misc.rs`), plus commands outside
`just-bash-rs`'s scope entirely (`tar`, `yq`, `html-to-markdown`, `xan`,
`query-engine`, `search-engine`, `rg`, `gzip`, `compression`, `curl`,
`worker-bridge`) that should be **dropped**, not ported. Phase 2 needs an
explicit file-by-file mapping from `vendor/just-bash-rs/src/commands/*.rs` to
which TS command dir(s) it corresponds to before adapting; don't just copy the
detyped tree wholesale. Three known friction spots (bare npm deps even in
scope): `commands/ls/ls.ts` (`minimatch`), `commands/diff/diff.ts` (`diff`
package), `commands/printf/printf.ts` (`sprintf-js`) — reimplement these
natively (small algorithms) rather than vendoring the npm package's source.

## Open questions / gotchas to revisit

- Whether to keep `vendor/just-bash-rs`-style single-file-per-command-family
  layout, or split further for readability — decide during Phase 1/2, not
  load-bearing.
- `port-findings.md` documents bugs the *original* JS `just-bash` had that the
  Rust port fixed (script execution, `2>&1`, sort order, `set`/pipefail,
  positional params). Since this is a fresh hand-port (not a copy of the old
  JS), write it correct the first time per `just-bash-rs`'s current behavior;
  no need to "re-break then fix."
