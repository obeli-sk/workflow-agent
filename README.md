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
programs. The same shell is driven by the LLM and, directly, by the operator:
type a command with a `$ ` prefix in the UI to run it yourself, e.g. `$ pwd`.

Programs are just Obelisk executions, so the agent can write and deploy its own.
The one that ships, a GET-only `curl`, is an Obelisk activity.

![workflow-agent web UI](docs/workflow-agent.png)

## Run

Build the component, pick an LLM catalog, and start the server:

```sh
just build
ln -sf models.local.json models.json      # pick a catalog
export AGENT_MODELS="$(cat models.json)"   # or use direnv (.envrc-example)
export LLM_BASE_URL=http://127.0.0.1:9190  # match the catalog's endpoint
just serve                                 # obelisk server run -d deployment.toml
```

Everything is pinned by the flake, so `nix develop` provides the matching
Obelisk and Rust (wasm32) toolchain. The workflow is a native Rust component
(`workflow/workflow-rs`); no special Obelisk build is required.

Then open http://localhost:9090. Create an empty session to use the shell
directly, or submit a prompt and inspect the same filesystem afterward. The
operator input stays live while a completion is pending, so `$ ` commands can
edit the session VFS mid-turn; a prompt sent during the wait is queued for the
next model turn.

## LLM endpoint

One endpoint serves the whole catalog, configured by three env vars: the
catalog JSON `AGENT_MODELS` (required), the origin `LLM_BASE_URL` (default
`http://127.0.0.1:9190`), and the bearer `LLM_API_KEY` (unset for keyless).
Each catalog entry points a model at an OpenAI- or Anthropic-shaped route under
that origin. Three catalogs ship:

- `models.local.json` (keyless) : the sibling
  [`agent-backed-llm-server`](https://github.com/obeli-sk/agent-backed-llm-server),
  a Claude/Codex subscription in docker on `:9190`.
- `models.exe-gateway.json` (`LLM_API_KEY`) : the exe.dev LLM gateway. Forward
  it first: `ssh -L 7070:169.254.169.254:80 <yourinstance>.exe.xyz`.
- `models.openrouter.json` (`LLM_API_KEY`) : [OpenRouter](https://openrouter.ai).
  The key is injected into the outbound header at the edge, never seen by the JS.

Any other compatible endpoint (Anthropic/OpenAI directly, vLLM, Ollama) works:
point `LLM_BASE_URL` at it and add catalog entries.

## The shell

The core registers a broad command catalog ported from just-bash (file, path,
text, search, checksum, encoding, and inspection tools; no `gzip`/`gunzip`/
`zcat`). Run `help` to list built-ins and discovered programs, or `which NAME`.

The deployment mount under `/workspace/deployment` is lazy: the tree lists
immediately from digests and byte sizes, and bounded file bodies are fetched
from the content-addressed store on first read. Files over 1 MiB stay
digest-only and read as a placeholder (see
`meta/designs/workflow-agent-lazy-deployment-mount.md`).

Interactive job control is not available: `jobs`, `wait`, `fg`, `bg`, signals,
and durable background execution with `&` are unsupported (a trailing `&` is
rejected rather than run in the foreground). Packs use Obelisk child executions
for durable external work instead.

## Stateless MCP sample

A dependency-free sample server exposes tools, a prompt, and two resources.
Start it with `just sample-mcp-server`, uncomment the `mcp_obelisk_local`
activity in `deployment.toml` and the keyless outbound host block in
`server.toml`, then build and run as above. In a new empty session:

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
