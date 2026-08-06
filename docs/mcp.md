# Stateless MCP support

Status: implemented. Discovery, per-server commands, and the `mcp`
registry live in `vendor/just-bash-rs/src/obelisk_mcp.rs`, wired into the
session loop in `workflow/workflow-rs/src/session.rs`; the transport is
`activity/mcp.js`; a commented server block ships in `deployment.toml` /
`server.toml`. The one deviation from the sketch below: a single reusable
`activity/mcp.js` reads fixed env vars `MCP_SERVER_URL` and `MCP_SERVER_TOKEN`
(rather than per-server env-var names), so each block sets those; one
`server.toml` can name only one `MCP_SERVER_TOKEN`, making more than one
authenticated server a v1 limitation.

This document specifies how workflow-agent talks to external
[Model Context Protocol](https://modelcontextprotocol.io) servers. The scope is
**stateless** MCP over Streamable HTTP only. Stateful servers (persistent
`Mcp-Session-Id`, long-lived SSE, server-to-client requests) are out of scope
and do not fit the execution model below.

## Why stateless, and why it fits

The agent is the workflow. The LLM sees exactly one tool, `bash`
(`session.rs`, `BASH_TOOLS_JSON`); every capability is a shell command in the
in-workflow just-bash interpreter, and the only path to the outside world is the
durable `RealHost.call_json` -> `workflow_support::call_json` seam, i.e. a
recorded child activity call.

A workflow is deterministic and replay-driven, so it cannot do HTTP directly.
The unit that can is an activity: one activity invocation is one HTTP request,
retryable, with nothing remembered between calls. That is exactly the shape of a
stateless MCP call.

The 2026-07-28 MCP spec makes this clean. It removes the `initialize`/
`initialized` lifecycle handshake (SEP-2575) and the `Mcp-Session-Id` session
(SEP-2567). Each request is self-describing: protocol version, client info, and
capabilities travel in `_meta` on every call, two routing headers (`Mcp-Method`,
`Mcp-Name`) are added, and capability discovery is a plain `server/discover`
method. So every MCP call is one independent POST with no cross-call state.

For older stateless servers (2025-era: TypeScript SDK stateless mode, FastMCP
`stateless_http=True`) that still expect a handshake, the fallback stays fully
stateless: the transport activity does `initialize` plus the real call inline in
the same invocation and discards it. Worst case is two POSTs inside one
activity, never any state held across activities.

## Where the code lives: activity for I/O, workflow for wiring

Split along the seam the codebase already uses for the shipped `curl` program:

- **Transport = activity.** The JSON-RPC-over-HTTP call is an activity, one per
  configured server, pinned to that server's URL and auth secret. This is the
  durable, retryable, non-deterministic boundary, identical in role to
  `activity/curl.js` and `activity/llm-chat.js`.
- **Registration and dispatch = workflow.** The bash interpreter lives in the
  workflow, so a command can only be injected there. This is one additional
  discover/register block in `session.rs` and a new `obelisk_mcp` module in
  `just-bash-rs`, mirroring `obelisk_program` (`vendor/just-bash-rs/src/
  obelisk_program.rs`).

MCP tools cannot be modeled as static `program.*` WIT exports, because they are
discovered from the server at runtime and are not known at deploy time. Hence
the small, unavoidable workflow addition. It is deliberately kept minimal.

## Command surface: one command per server, `mcp` as the registry

Each configured MCP server registers a bash command named by the server, with
MCP primitives as subcommands:

```
obelisk-local tools
obelisk-local tools <tool> --help
obelisk-local tools <tool> --arg k=v
obelisk-local call <tool> '<json-args>'       # compatibility form
obelisk-local prompts
obelisk-local prompt <name> --help
obelisk-local prompt <name> --arg k=v
obelisk-local info                       # server/discover metadata
```

A global `mcp` command is the registry: `mcp` (or `mcp list`) enumerates the
registered server commands with their configured URL and whether auth is set.
The URL/auth come from a `client/config` pseudo-method the transport answers
inline (no HTTP, reading `MCP_SERVER_URL`/`MCP_SERVER_TOKEN`), so listing works
even when a server is down. `mcp tools` fans `tools/list` across all servers.

Rationale (name collisions): server names are operator-chosen in
`deployment.toml`, and there are few of them, so the collision surface is small
and controllable. Tool names, which are arbitrary and may repeat across servers
(two servers each exposing `fetch`), never reach the top level: they are always
`<server> tools <tool>`. Naming a server `obelisk-local` also sidesteps the
existing `obelisk` builtin. A server whose name would shadow a builtin or the
`obelisk` command is skipped, and the reason recorded (mirroring how program and
mount errors are written to `/workspace/.program-error` /
`/workspace/.mount-error` today).

### Startup network calls

Server commands are registered from cheap function-list metadata. Opening a
session calls `resources/list` on each server so its resource tree can be
mounted. Tool, prompt, and resource body requests remain on demand. A server
whose resource listing fails still gets its shell command, and the mount error
is recorded in `/workspace/.mcp-error`.

## Prompts: discoverable, not auto-fed

MCP prompts are user-initiated templates by design (tools are model-initiated,
prompts are user-initiated). They are surfaced as on-demand shell output:
`<server> prompt <name> [--arg k=v]` renders the prompt messages to stdout. The
user pipes or pastes the result into the conversation; the model may also invoke
it via `bash` if the system prompt directs it to. They are **not** appended to
the system prompt at startup: auto-feeding every server's prompts bloats context
and inverts the user-controlled semantics. This matches the "everything is a
program that writes to stdout" model the shell already uses.

## Resources: lazy VFS mounts

Resources are mounted under `/workspace/mcp/<server-name>`. The session follows
`resources/list` pagination and registers the tree from metadata only. Reading
a bounded file issues `resources/read` once and caches the returned text or
base64 blob in the session VFS.

The resource `name` is its relative VFS path; when absent, a path is derived
from its URI. Each listing entry must include its byte `size` and a
`sha256:<hex>` digest in `_meta["sk.obeli/content-digest"]`. This extension lets
the VFS list and inspect metadata without downloading content, retain the 1 MiB
lazy-read limit, and route each file to the correct server-specific loader.

## Configuration (deployment.toml + server.toml)

A server is one activity block plus one outbound-host grant, mirroring the
single-LLM-endpoint precedent. The fixed interface `mcp/server` groups servers;
the function name is the server name, so discovery lists
`obelisk-agent:mcp/server.*` (the way `obelisk_program` lists
`obelisk-agent:programs/program.*`) and strips the prefix to get each command
name.

The activity reads the fixed env var `MCP_SERVER_URL` (the full endpoint it
POSTs to) and the fixed placeholder secret `MCP_SERVER_TOKEN`. Each block sets
`MCP_SERVER_URL` to its own value; an authenticated server sources
`MCP_SERVER_TOKEN` from any host env var in `server.toml`.

```toml
# deployment.toml
[[activity_js]]                            # or activity_wasm; see "Transport language"
name = "mcp_obelisk_local"
ffqn = "obelisk-agent:mcp/server.obelisk-local"
params = [
  { name = "method",      type = "string" },
  { name = "params-json", type = "string" },
]
return_type = "result<string, string>"
location = "activity/mcp.js"
env_vars = [{ key = "MCP_SERVER_URL", value = "${MCP_OBELISK_LOCAL_URL:-http://127.0.0.1:1071/mcp}" }]
[[activity_js.allowed_host]]
pattern = "${MCP_OBELISK_LOCAL_URL:-http://127.0.0.1:1071}"
methods = ["POST"]
secrets = ["MCP_SERVER_TOKEN"]             # optional bearer; omit for keyless
replace_in = ["headers"]
```

```toml
# server.toml
[secrets]
MCP_SERVER_TOKEN = { env = "MCP_OBELISK_LOCAL_TOKEN" }

[[outbound_http.allowed_host]]
pattern = "${MCP_OBELISK_LOCAL_URL:-http://127.0.0.1:1071}"
methods = ["POST"]
secrets = ["MCP_SERVER_TOKEN"]
replace_in = ["headers"]
```

Adding a server is a deployment edit: one activity block, one host grant, and it
appears as a command automatically on the next session (or mid-session on
redeploy, via the same deployment-change re-registration path programs use).

## Transport language

The stateless JSON-RPC surface is thin (build request with `_meta` and the two
headers, POST, parse the result, with an inline handshake fallback for
legacy servers), so v1 is a **JS activity** (`activity/mcp.js`), matching
`curl.js` / `llm-chat.js` and avoiding a WASI-HTTP problem: rmcp's HTTP
transport is reqwest-based (`transport-streamable-http-client-reqwest`) and does
not run in an Obelisk WASI activity, which does outbound HTTP through
`wasi:http`. An rmcp-backed WASM activity remains an option later (reuse rmcp's
protocol/types, bridge its transport onto `wasi:http`); the activity boundary is
generic (`(method, params-json) -> result<string, string>`), so swapping the
implementation touches nothing else.

## Testing

- **Integration target: `example-mcp-stateless` (yigitkonur).** An
  everything-style stateless server (fresh instance per request; tools
  `calculate`, `describe_stateless_limits`; a prompt `design-next-tool`;
  resources), served at `http://127.0.0.1:1071/mcp` with Docker and a health
  endpoint. Exercises tools and prompts together.
- **Conformance oracle: `mcp-explorer` (Simon Willison).** A client CLI
  (`pip install mcp-explorer`, defaults to stateless MCP 2). Point it and the
  new transport activity at the same server and diff `list` / `call` / `prompts`
  output.
- **In-ecosystem alternative:** rmcp `examples/servers/src/
  counter_streamhttp.rs` (Rust, stateless by default on `2026-07-28`).
- **Local sample:** `examples/stateless-mcp-server.mjs`, started with
  `just sample-mcp-server`, covers tools, prompts, and lazy resources without
  third-party dependencies.

## Scope

- Tools and prompts. Per-server command with `tools`, `call`, `prompts`,
  `prompt`, `info` subcommands; global `mcp` registry command.
- Prompts discoverable (render to stdout), not auto-fed.
- Transport as a JS activity, swappable to an rmcp-backed WASM activity later.
- Resources mounted lazily into the session VFS.

## References

- SEP-2575: Make MCP Stateless <https://modelcontextprotocol.io/seps/2575-stateless-mcp>
- SEP-2567: Sessionless MCP <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2567-sessionless-mcp.md>
- 2026-07-28 spec release candidate <https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/>
- rmcp (Rust SDK) <https://github.com/modelcontextprotocol/rust-sdk>
- example-mcp-stateless <https://github.com/yigitkonur/example-mcp-server-http-stateless>
