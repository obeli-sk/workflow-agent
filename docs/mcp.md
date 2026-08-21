# Stateless MCP servers

The workflow-agent can expose remote [MCP](https://modelcontextprotocol.io)
servers to the session as shell commands and a lazily mounted resource tree. The
integration is stateless: one shell action is one MCP request, and nothing is
remembered across invocations (see `activity/mcp.js`).

## Pieces

- **Transport activity** (`activity/mcp.js`), one deployed block per server, with
  the uniform contract
  `func(method: string, params-json: string) -> result<string, string>` and the
  FFQN `obelisk-agent:mcp/server.<name>`. It performs the JSON-RPC-over-HTTP POST
  and returns the `result`. A fixed env var `MCP_SERVER_URL` sets the endpoint;
  an authenticated server also exposes the fixed secret `MCP_SERVER_TOKEN`.
- **Registry activity** (`activity/mcp-discover.js`), FFQN
  `obelisk-agent:mcp/registry.discover`, returns the configured servers as a
  WIT-typed `result<list<record { name: string, ffqn: string }>, string>` parsed
  from the operator-owned `MCP_SERVERS_JSON` env var. The WIT return type
  structurally enforces the shape.
- **The workflow** calls `registry.discover` once at session start and, for each
  returned server, registers a `<name>` shell command, lists it in the global
  `mcp` command, and registers a deferred mount at `/workspace/mcp/<name>`.

Because the workflow reads the server list at runtime, **adding a server needs no
workflow rebuild**: edit `deployment.toml` alone.

## Configuring a server

1. Add a transport block (copy the `mcp_obelisk_local` sample in
   `deployment.toml`), rename the server, and point `MCP_SERVER_URL` at it.
2. Add the matching outbound-host grant in `server.toml`.
3. Register it in the discovery registry by appending `{ name, ffqn }` to
   `MCP_SERVERS_JSON` (the `mcp_discover` block's env var, overridable from the
   host env).

Auth is a v1 limitation: `server.toml` can name only one `MCP_SERVER_TOKEN`, so
at most one authenticated server. Keyless servers omit the secret entirely.

## Using it from the session

```
mcp                       # list configured servers (url, auth)
<server> info             # server/discover metadata
<server> tools            # tools/list
<server> tools <t> --help # schema-driven usage for one tool
<server> tools <t> --arg k=v ...   # tools/call
<server> prompts          # prompts/list
<server> prompt <p> --name v ...   # prompts/get, rendered
ls /workspace/mcp/<server>         # resources/list (lazy, on first access)
cat /workspace/mcp/<server>/<path> # resources/read (lazy)
```

The resource tree is mounted lazily: its `resources/list` runs only when the
session first touches `/workspace/mcp/<server>`, and each file's bytes fetch via
`resources/read` on first read. So a server that is not running never breaks a
session: a bash-only session makes no MCP call, and touching a down server fails
only that command (after the usual activity retries). Run `mount` to see all
network-backed mounts; it live-probes each MCP server (a `tools/list`
round-trip) and reports whether it is responding. Avoid `tree`/`find`/recursive
`grep` across a mount; navigate with targeted `ls` and `cat`.

## Sample server and E2E

`examples/stateless-mcp-server.mjs` is a self-contained sample server
(`just sample-mcp-server`). `scripts/test-e2e-mcp.sh` runs it in a container,
deploys a keyless block pointed at it (overriding `MCP_SERVERS_JSON` to wire only
that server), and drives the command surface and lazy resources over real HTTP.
It needs docker or podman and SKIPs when neither is present.
