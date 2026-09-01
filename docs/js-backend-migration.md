# JS-only workflow backend: migration notes

Status: **in progress** (Phase 1 done, e2e-verified). This doc tracks design
decisions and progress for the JS-alternative workflow backend so another
agent can resume without re-deriving the research. Update it after every
phase.

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
- **WIT record/variant field and case names cross into JS as snake_case, not
  camelCase.** Only function/interface names get kebab-to-camelCase (per the
  docs). Confirmed from two independent, already-working code paths in this
  repo: `activity/config-discover.js` (a deployed activity) returns
  `{max_steps, mcp_servers, webhook_url}` for the WIT record
  `{max-steps, mcp-servers, webhook-url}`; and `scripts/e2e-json.js` reads
  `json()?.ok?.shell_output` / `record.turn_index` / `record.duration_milliseconds`
  off raw `obelisk execution result -j` output. session.js's session-event
  construction (`{shell_output: {...turn_index...}}` etc.) follows this and
  is now e2e-verified end to end (see Phase 1 checklist entry below).
- **JS workflow join sets are ergonomic, not the raw WIT resource API.**
  `obelisk.createJoinSet({name})` returns a plain object with `.submit()`,
  `.joinNext()` (blocks, returns the *decoded* ok value directly and sets
  `.lastId`, throws `obelisk.ChildError` on any failure), `.joinNextTry()`,
  `.close()`. Generated `-obelisk-ext` imports (`xSubmit(joinSet, ...args)`,
  `xAwaitNext(joinSet)`) exist for statically-known FFQNs; for a
  **heterogeneous** join set (session.js's "user" set holds both an
  `injection` child and each turn's `completion` child) use the typed
  `xSubmit` to submit but the low-level `joinSet.joinNext()` to await and
  `joinSet.lastId` to dispatch — the runtime decodes the value according to
  whichever function actually produced it, so (unlike the Rust port) there is
  no need for a separate typed `-get` call after the generic await.
- **`Date.now()` is already the deterministic Obelisk clock inside a
  workflow** (no `sleep(now)` trick needed, unlike the Rust port).
  `obelisk.sleep({milliseconds})` is the durable delay; it throws on
  cancellation, which session.js swallows the same way session.rs's
  `host_sleep_ms` does.
- **`result<T, E>` JS exports signal Err by `throw`ing the err value** (a
  plain string for `result<_, string>`), not by returning `{err: ...}` —
  confirmed against `activity/config-discover.js`'s `throw` sites and
  `obelisk/crates/wasm-workers/src/activity/activity_js_worker.rs`'s
  typecheck tests. `obelisk.call(ffqn, args)` (dynamic FFQN) and generated
  static imports both throw `obelisk.ChildError` on a child failure, with the
  **already-decoded** value on `e.value` — no manual JSON-parsing needed the
  way `support.rs`'s `decode_string_or_raw` needs in Rust.
- A pre-existing `[[workflow_js]]` block already lived in this deployment.toml
  before this project (`obelisk-control:tools/native.call`,
  `packs/obelisk-control/native-call.js`) — real proof-in-production of static
  imports (`import * as webapi from 'obelisk-agent:tools/webapi'`) and
  `obelisk.ChildError` usage, and confirms **no `wit = "..."` field is needed**
  on a `[[workflow_js]]` block for its static imports to resolve (resolution
  is dynamic against the deployment's function registry, not a WIT-file
  lookup) — the earlier plan's assumption that `wit = "wit"` might be needed
  for `session.js`'s stub/llm imports was wrong; it isn't required.
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

## Directory layout (actual)

- `apps/workflow-agent/vendor/just-bash/src/` — hand-written plain-JS
  interpreter, ESM, relative imports only, no `package.json`/build step:
  `fs.js` (VFS), `arithmetic.js`, `brace.js`, `glob.js`, `parser.js`
  (scanner-integrated recursive-descent parser producing a plain-object AST),
  `expansion.js` (parameter/command-sub/arithmetic expansion, IFS field
  splitting, glob application), `interpreter.js` (tree-walking executor, I/O
  binding/redirection/dup routing, control flow), `commands/{core,fsutil,
  index}.js` (builtins), `bash.js` (public `Bash` class, mirrors
  `just-bash-rs::Bash`), `index.js` (barrel). `bash.test.js` covers it
  end-to-end via `node --test` (29 cases).
- `apps/workflow-agent/workflow/workflow-js/src/` — `session.js` (host-facing
  orchestration: WIT imports, `Notifications` self-stub class, the
  `agentLoop`/`callLlmWithUser` port of `session.rs`/`agent.rs`) and
  `session-logic.js` (every pure helper with no `obelisk` global and no WIT
  imports — event/error-text builders, `containsBackgroundStatement`,
  `shellResultOf`, tool-result encoding — pulled out so it's unit-testable;
  see `session-logic.test.js`, matching this repo's existing
  `shared/session-state.js` split).
- No root `package.json`/`pnpm-workspace.yaml`/`Justfile` `install`/`build-js`
  targets — there is nothing to build. `just verify` compiles/links/verifies
  both backends together; `just test-js` runs the new `node --test` suites;
  `scripts/test-e2e-agent-workflow-js.sh` (wired into `just test-e2e` and
  `.github/workflows/check.yml`) is a real end-to-end smoke test against an
  isolated live `obelisk server`.
- No `boa-polyfills.js`/`node-zlib-shim.js` needed: Phase 1's interpreter has
  no `TextEncoder`/`crypto.subtle.digest`/gzip dependency yet (those land, if
  at all, with `hash`/`textutil2` command parity in Phase 2 — `just-bash-rs`
  doesn't implement gzip/gunzip/zcat either, so those are simply out of
  scope, matching the old JS version's `WORKFLOW_UNAVAILABLE_COMMANDS`).

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
- [x] Phase 0c: one-time TS→JS type-stripping of `/workspace/just-bash` as
      reference material — recipe below; ended up **not needed** in practice.
      The hand-written interpreter was written directly against
      `vendor/just-bash-rs`'s behavior/structure instead (closer to the
      actual command-parity target, and Rust reads more directly as a porting
      source than detyped TS with a different module layout). The recipe is
      kept below in case Phase 2's command porting finds it useful for a
      specific tricky command (e.g. `printf`/`sed` edge cases).
- [x] Phase 1: interpreter core (lexer/parser/AST/interpreter/VFS, hand-written
      dependency-free, `vendor/just-bash/`) + core session loop
      (`workflow/workflow-js/src/session.js` + `session-logic.js`):
      bash-per-session, turn loop, step-budget nudge/limit (kept in scope,
      cheap), injection racing on a heterogeneous "user" join set, `llm/chat`
      completion via `-obelisk-ext`, session-events via self-stub on a
      "session-events" join set. Deliberately **not yet ported**: programs/
      MCP/mounts (no `obelisk`/`mcp`/program commands registered — no
      `[a-zA-Z0-9_-]*` external commands beyond the interpreter's own
      builtins), `chat` peer sessions, session rename, `ask-user`,
      per-script watch/timeout (`shell-started` events are not emitted;
      `dispatch_bash`/direct-shell-input run straight through `bash.exec`
      with no watchdog or interrupt-offer arming).
      **Command coverage**: a working core subset (see table below), not yet
      full `just-bash-rs` parity — that's Phase 2.
      **Verification**: `node --test` (29 interpreter cases + 9 session-logic
      cases, all passing) plus a **real e2e run against an isolated live
      `obelisk server`**
      (`scripts/test-e2e-agent-workflow-js.sh`, wired into `just test-e2e`
      and CI): a direct shell turn through the idle input offer runs a real
      script (`sleep`/`which`/`echo`) and its `shell_output` event projects
      correctly through the existing `webhook/lib/responses.js`/`runs.js`
      (proving the snake_case event-shape assumption end to end), and a
      prompt-driven turn reaches `obelisk-agent:llm/chat.completion`, races
      it against the injection join-set entry, and surfaces the recoverable
      `AGENT_MODELS must be a non-empty JSON array` config error as an
      `agent_error`, returning to idle — this is the single highest-risk part
      of the whole design (heterogeneous join-set racing in JS) and it now
      has a real passing regression test, not just a `just verify` compile
      check. This pulls a slice of Phase 6 ("test parity") forward
      deliberately, since a live e2e run was the only way to actually
      retire the snake_case-field-naming and join-set-decoding assumptions.
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
| awk | `commands/awk.rs` | not started (largest remaining file, 2886 lines) |
| sed | `commands/sed.rs` | **done** (`commands/sed.js`) — s///, addressing, d/p/q/r |
| grep/egrep/fgrep | `commands/grep.rs` | **done** (`commands/grep.js`) — full flag set incl. -A/-B/-C/-r/-f/-o |
| jq | `commands/jq.rs` | not started (2351 lines; likely a deliberately-scoped subset, not full jq) |
| diff | `commands/diff.rs` | **done** (`commands/diff.js`) |
| find | `commands/find.rs` | **done** (`commands/find.js`) |
| fsutil (ls/cp/mv/rm/mkdir/...) | `commands/fsutil.rs` | **done** in Phase 1 (`commands/fsutil.js`) |
| sort/uniq | `commands/sort_uniq.rs` | **done** (`commands/sort_uniq.js`) — -k/-t/-c, uniq -c/-d/-u/-i |
| hash (base64/md5sum/sha256sum) | `commands/hash.rs` | **done** (`commands/hash.js` + `utf8.js`) |
| timeutil (date/time/timeout formatting) | `commands/timeutil.rs` | not started — `date`/`sleep` have a minimal version in `commands/core.js` (epoch/strftime-lite only, no full GNU date parsing/arithmetic) |
| xargs | `commands/xargs.rs` | **done** (`commands/xargs.js`) |
| misc (chmod/readlink/ln/file/du/tree/alias/comm/join/...) | `commands/misc.rs` | partial — seq/tee/which/env/printenv/whoami/hostname/help/clear done in Phase 1 (`commands/core.js`/`fsutil.js`); alias/unalias and the rest not started |
| text (cut/tr/wc/head/tail/printf/basename/dirname) | `commands/text.rs` | **done** — cut/tr in `commands/text.js`, wc/head/tail/basename/dirname/printf in Phase 1's `core.js`/`fsutil.js` |
| textutil2 (comm/join/nl/od/rev/fold/expand/unexpand/column/paste/strings/split) | `commands/textutil2.rs` | not started |

Also fixed along the way (both grep and sed depend on it):
`vendor/just-bash/src/regex-bre.js` translates POSIX BRE to JS RegExp syntax
and expands `[:class:]` POSIX bracket classes (JS RegExp has neither
natively); its bracket-expression scanner correctly skips nested
`[:class:]`/`[.collating.]`/`[=equiv=]` sub-forms so `[[:alpha:]]`-style
patterns parse right (a bug caught by grep's own POSIX-class test).

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
