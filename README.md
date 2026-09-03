# workflow-agent

> [!NOTE]
> **Preview only.** APIs and design are unstable and subject to change.

A durable [Obelisk](https://obeli.sk) workflow that *is* an agent loop. It holds
a provider-neutral chat history and a persistent virtual filesystem, and exposes
exactly one tool to the model: `bash`.

The shell is a Rust rewrite of [just-bash](https://justbash.dev), vendored at
`vendor/just-bash-rs`. On top of it the workflow adds a VFS that mounts the
active Obelisk deployment and any stateless MCP servers, so their resources show
up as files. Obelisk functions and MCP tools are surfaced as ordinary bash
programs. The same shell is driven by the LLM and, directly, by the user:
type a command with a `$ ` prefix in the UI to run it yourself, e.g. `$ pwd`.

External programs are Obelisk executions the workflow discovers at session start
from an operator-owned registry (`PROGRAMS_JSON`), so adding one is a
`deployment.rs.toml` edit with no workflow rebuild; each entry's description is
surfaced in the system prompt. The one that ships, a GET-only `curl`, is an
Obelisk activity. The per-turn model invocation limit comes out of the same
registry read: `MAX_STEPS`, defaulting to `20`.

![workflow-agent web UI](docs/workflow-agent.png)

## Run

Build the component, pick an LLM catalog, and start the server:

```sh
just build
ln -sf models.local.json models.json      # pick a catalog
export AGENT_MODELS="$(cat models.json)"   # or use direnv (.envrc-example)
export LLM_BASE_URL=http://127.0.0.1:9190  # match the catalog's endpoint
just serve                                 # obelisk server run -d deployment.rs.toml
```

Everything is pinned by the flake, so `nix develop` provides the matching
Obelisk and Rust (wasm32) toolchain. The workflow is a native Rust component
(`workflow/workflow-rs`); no special Obelisk build is required.

There is a full-parity JS alternative (`workflow/workflow-js`, a hand-written,
dependency-free `just-bash` interpreter that ships as its own readable
source, no compile/bundle step) behind `deployment.js.toml`. It exports the
exact same FFQN as the Rust workflow in `deployment.rs.toml`
(`obelisk-agent:workflow/workflow.run-cancellable`), so which one runs is a
deployment choice, not a per-request switch: only one of the two files is
ever the active deployment. Rust is the default (`just serve`, an alias for
`just serve-rs`); run `just serve-js` to start the server on the JS
deployment instead. Switching a server between them with `obelisk deployment
apply` is safe for new sessions (both sides start from a clean slate), but
**not** for a session already in flight: hot-swapping a *running* execution's
own component between two different language implementations of itself is
inherently risky (Obelisk's JS workflow runtime doesn't yet track
`requested_ffqn` on generic `join-next` calls the way Rust's typed bindings
do, so an in-flight auto-upgrade replay under JS fails nondeterminism-checked
and strands the session), and is not how workflow-agent redeploys in general
anyway - it always targets a separate `TARGET_OBELISK` instance, never
itself (see `scripts/test-e2e-target-deploy.sh`, and "Target instance"
below). See [`docs/js-backend-migration.md`](docs/js-backend-migration.md)
for why the JS backend exists and its current status.

Then open http://localhost:9090 (the external/webhook listener; `server.toml`
keeps the built-in default). Create an empty session to use the shell directly,
or submit a prompt and inspect the same filesystem afterward. The user input
stays live while a completion is pending, so `$ ` commands can edit the session
VFS mid-turn; a prompt sent during the wait is queued for the next model turn.

## Target instance

There are two Obelisk instances in play:

- The **agent instance** the workflow-agent runs on. Its own session runs, logs,
  and the UI's pause/cancel/answer buttons live here, authenticated with
  `OBELISK__API__TOKEN` (and `OBELISK_UI_URL` for links).
- The **target instance** the agent inspects and deploys to. Every control/deploy
  tool (`obelisk functions|executions|call|deployment ...`) and the
  `/workspace/deployment` mount talk to it, configured by three vars that default
  to the agent instance:

  ```sh
  export TARGET_OBELISK_API_URL=http://127.0.0.1:5205
  export TARGET_OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:5205"
  export TARGET_OBELISK_TOKEN="$OBELISK__API__TOKEN"
  ```

  A fourth var, `TARGET_OBELISK_WEBHOOK_URL` (default
  `http://127.0.0.1:9290`, matching `server-target.toml`), is the target's
  webhook (external) listener. The shell's GET-only curl is granted access to
  it, so deployed webhook endpoints can be smoke-tested directly, and `mount`
  prints it for discovery.

Point these at a separate Obelisk to deploy somewhere other than the agent's own
instance.

> [!WARNING]
> The default targets the agent's **own** instance, which is recursive and risky.
> A deployment the agent applies to itself can remove the agent, or worse remove
> the very `deployment submit`/`switch` activity that is still running: a
> deployment switch closes all executors *before* it acknowledges, so the
> in-flight control execution is left Pending. Re-activating the previous
> deployment then immediately switches back to the broken one and re-Pends it. Use
> a separate target instance for anything beyond local experimentation.

## LLM endpoint

One endpoint serves the whole catalog, configured by three env vars: the
catalog JSON `AGENT_MODELS` (required), the origin `LLM_BASE_URL` (default
`http://127.0.0.1:9190`), and the bearer `LLM_API_KEY` (unset for keyless).
Each catalog entry points a model at an OpenAI- or Anthropic-shaped route under
that origin. Three catalogs ship:

- `models.local.json` (keyless) : the sibling
  [`agent-backed-llm-server`](https://github.com/obeli-sk/agent-backed-llm-server),
  a Claude/Codex subscription in docker on `:9190`.
- `models.exe-integration.json` (keyless) : the exe.dev LLM integration —
  `LLM_BASE_URL=https://llm.int.exe.xyz`. Inside an attached exe.dev VM, exe.dev
  authenticates at the network edge and plain OpenAI-compatible requests just
  work, no key:

  ```sh
  curl -X POST https://llm.int.exe.xyz/v1/chat/completions \
    -H content-type:application/json \
    -d '{"model":"...","messages":[{"role":"user","content":"hi"}]}'
  ```

  From **outside** exe.dev the hostname resolves to a link-local address only
  exe infra routes, and the https endpoint routes on the Host header, so run an
  nginx reverse proxy on an attached VM
  ([`examples/exe-llm-proxy.conf`](examples/exe-llm-proxy.conf)) that fixes the
  header, and tunnel to it:

  ```sh
  # on <yourinstance>.exe.xyz:
  mkdir -p /tmp/exe-llm-proxy/{logs,tmp/body}
  nginx -c $(pwd)/examples/exe-llm-proxy.conf   # plain HTTP on 127.0.0.1:7071

  # on your machine:
  ssh -L 7070:127.0.0.1:7071 <yourinstance>.exe.xyz
  export LLM_BASE_URL=http://localhost:7070     # plain http, no custom CA
  ```

- `models.openrouter.json` (`LLM_API_KEY`) : [OpenRouter](https://openrouter.ai).
  The key is injected into the outbound header at the edge, never seen by the JS.

Regenerate the exe.dev catalog from the published model list with
`node scripts/update-exe-models.mjs`. Leave `LLM_API_KEY` unset.

Any other compatible endpoint (Anthropic/OpenAI directly, vLLM, Ollama) works:
point `LLM_BASE_URL` at it and add catalog entries.

## Documentation

The agent reads the Obelisk docs from the rendered site, not a GitHub mount.
The `pack.describe` activity inlines each URL in `DOCS_URLS_JSON` into the
system prompt as a pointer (never the index body, so the prompt stays slim);
the model fetches the indexes and detail pages itself through the GET-only
`curl` program, whose allowlist covers `https://obeli.sk`:

```sh
curl https://obeli.sk/docs/latest/js/js-workflows/
```

`OBELISK_VERSION` pins the doc set to the target runtime's version
(`https://obeli.sk/docs/v${OBELISK_VERSION}/llms.txt/`); empty means `latest`.
Override the whole list with `DOCS_URLS_JSON` (a JSON array of URLs). No GitHub
credential is involved; the former `/workspace/docs` mount is gone.

## Example app mounts

`APPS_JSON` lists GitHub repos the session mounts read-only and lazily-listed
under `/workspace/apps/<name>`, sourced from the GitHub contents API
(`activity/github-contents.js`) through the single `mount_apps` activity
(one deployed activity backs every mount; which repo each one browses travels
in the request, not a fixed env var). A directory lists on first `ls` and a
file's bytes fetch on first `cat`, one recorded activity call each. The
default list mounts a handful of `obeli-sk` repos (`components`,
`agent-backed-llm-server`, `demo-stargazers`, `demo-tutorial`,
`obelisk-version-monitor`, and `workflow-agent` itself) at `main`, curated
for authoring value: a JS repo is directly copy-and-adapt, a Rust one only
makes the cut when it publishes reusable OCI components (`components`) or
demonstrates a pattern worth rewriting to JS (`demo-stargazers`); override
it to mount a different set, private forks, or pinned refs:

```sh
export APPS_JSON='[{"name":"components","repo":"components","ref":"v0.3.0"}]'
```

Each entry is `{name, repo}` plus optional `owner` (default `obeli-sk`),
`ref` (default `main`), and `description` (default empty). The system
prompt's "Example apps" section renders each entry as a one-line Markdown
bullet (`- \`name\` - description`), so keep `description` to a short
"Lang: what it's for" phrase; a repo's own README.md is the place for
detail. `GH_OWNER` (default `obeli-sk`) scopes the deployed
activity's `allowed_host` boundary to one GitHub org/user; every mounted
repo's `owner` must fall within it. `GITHUB_TOKEN` is optional: unset, the
mount shares GitHub's 60 req/h anonymous IP rate limit; set it (e.g. `gh auth
token`) to raise that to 5000 req/h, which matters once multiple sessions
share an egress IP.

## The shell

The core registers a broad command catalog ported from just-bash (file, path,
text, search, checksum, encoding, and inspection tools; no `gzip`/`gunzip`/
`zcat`). Run `help` to list commands, or `which NAME`.

`ask-user` is deliberately not a general model tool or shell program. It is a
UI-coordinated shell operation for answers needed before the current task can
continue:

```sh
obelisk call obelisk-agent:stub/stub.ask-user '["Which deployment?"]'
```

The command blocks until the user answers in the UI, then returns that
answer to the agent in the same turn. A normal Markdown response ends the turn
and is still the right way to ask a non-blocking conversational question.

The deployment mount under `/workspace/deployment` is lazy: the tree lists
immediately from digests and byte sizes, and bounded file bodies are fetched
from the content-addressed store on first read. Files over 1 MiB stay
digest-only and read as a placeholder.

Interactive job control is not available: `jobs`, `wait`, `fg`, `bg`, signals,
and durable background execution with `&` are unsupported (a trailing `&` is
rejected rather than run in the foreground). Packs use Obelisk child executions
for durable external work instead.

## Peer sessions: the `chat` command

Sessions on the same Obelisk instance can talk to each other. The `chat`
program (available to the agent as a shell command and to you with the `$ `
prefix) discovers, inspects, messages, and creates peer sessions:

```sh
chat models                          # LLM catalog: id, label, api type
chat list                            # sessions, newest first
chat read E_...                      # normalized transcript (--tail N, --json)
chat state E_...                     # one JSON line: state, working, offer id
chat send E_... please re-check X    # queue a user prompt for a peer
chat create --model claude "prompt"  # new session; prints its execution id
chat create '$ ls -la'               # new session opened straight in bash
chat create --name research "..."    # slug-labeled child (visible in its id)
chat current                         # this session's identity (JSON)
chat rename my-session               # slug-name this session ([a-z0-9-])
```

Notes:

- `chat` talks to the agent's **own** instance (`OBELISK_API_URL`), unlike the
  obelisk-control tools which target `TARGET_OBELISK_API_URL`.
- `send` looks up the peer's open input offer on every call (offers rotate each
  turn); while the peer is thinking the message queues for its next turn, when
  idle it is delivered immediately. Never invent or reuse offer ids.
- `current`, `rename`, and `create` are answered by the session workflow
  itself, not the HTTP activity: only a session knows its own identity, and by
  default `create` schedules the new session durably as a child of the caller
  (it is cancelled together with its parent). Use `create --top-level` for an
  independent session.
- A rename is recorded on its own `session-name` join set (via the dedicated
  `stub.session-renamed` stub), so readers fetch a session's current slug with
  one small request; the UI sidebar shows the name, falling back to the
  execution id.
- A prompt starting with `$` runs directly in that session's shell instead of
  reaching the model, in `chat create` and the composer alike (the space after
  `$` is optional).
- `create --name SLUG` labels the child at birth (published as its session
  name) and names its join set, so the child's execution id carries the slug
  (`E_<parent>.n:<slug>_1`). Child sessions start with empty history: pass all
  context they need in the prompt; a child can read its creator with
  `chat read <parent>` (its own system prompt names the parent).
- `chat state` reports `last_reply` (`{"turn": N}`) when a finished assistant
  message exists; sessions stay pending on an input offer even after a final
  answer, so this distinguishes "answered" from "still open". Read exactly that
  message with `chat read ID --turn N`.
- In the web UI, child sessions are listed indented below their parent.

## Stateless MCP sample

A dependency-free sample server exposes tools, a prompt, and two resources.
Start it with `just sample-mcp-server`; the sample's transport block in
`deployment.rs.toml`, its outbound-host grant in `server.toml`, and its
`MCP_SERVERS_JSON` entry are already shipped and enabled, so just build and run
as above. In a new empty session:

```sh
mcp list
obelisk-local --help
obelisk-local tools add --a 2 --b 3
obelisk-local prompt greeting --name world
find /workspace/mcp/obelisk-local -type f
```

Resources are listed when the session mounts the server and fetched through
`resources/read` only on first read of their VFS path. See `docs/mcp.md`.

## License

Apache-2.0. The vendored just-bash port keeps its own LICENSE/NOTICE under
`vendor/just-bash-rs`.
