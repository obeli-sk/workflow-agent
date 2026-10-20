# workflow-agent

> [!NOTE]
> **Preview only.** APIs and design are unstable and subject to change.

A coding agent that runs as a durable [Obelisk](https://obeli.sk) workflow. Each
chat session has a persistent virtual filesystem and a single tool, `bash`, through
which the agent explores, builds and deploys Obelisk apps. You can use the same
shell yourself by prefixing a message with `$ `, e.g. `$ ls /workspace`.

Sessions survive restarts. A session waiting for you or for the model costs
nothing but a database row, and it resumes exactly where it left off.

![workflow-agent web UI](docs/workflow-agent.png)

## Quick start

```sh
nix develop                                # pinned Obelisk and toolchain
export LLM_BASE_URL=http://127.0.0.1:9190  # any OpenAI- or Anthropic-compatible endpoint
just serve-js # or just serve-rs
```

Open http://localhost:9090. Then:

- type a prompt to start a session with the agent,
- or start with `$ ` to open a session straight in the shell (`$ help` lists the commands).

You can send messages while the agent is working. A message is queued for the
agent's next step, and a `$ ` command runs right away. A session with no input
for 7 days ends on its own.

`serve-js` and `serve-rs` run the same agent, implemented in JavaScript or Rust.
Sessions carry over when you switch between them.

## Configuration

Runtime settings use environment variables read at server start. Self API and
Web UI addresses are internal public-env sources declared in `app.toml`:

| Variable | Source | Purpose |
| --- | --- | --- |
| `OBELISK_API_URL` | API listener URL | The agent's own instance for UI polling and session control. |
| `OBELISK_UI_URL` | Web UI listener URL | Browser links; ObeliskNet sets the public URL. |

### LLM

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_BASE_URL` | `http://127.0.0.1:9190` | Endpoint origin, without a path. |
| `LLM_API_PREFIX` | empty | Path before `/v1/...` on gateways that need one, e.g. `/api` for OpenRouter. Models are discovered from `GET <LLM_BASE_URL><LLM_API_PREFIX>/v1/models`. |
| `LLM_API_KEY` | unset | Bearer token, if the endpoint needs one. |
| `AGENT_MODELS` | unset | Fallback model catalog (JSON), used when discovery is unavailable. |

The default endpoint is
[agent-backed-llm-server](https://github.com/obeli-sk/agent-backed-llm-server),
which serves Claude and Codex subscriptions locally. Two ready-made catalogs ship
for other endpoints, used as `AGENT_MODELS="$(cat models.openrouter.json)"`:

- `models.openrouter.json`: [OpenRouter](https://openrouter.ai), with
  `LLM_BASE_URL=https://openrouter.ai`, `LLM_API_PREFIX=/api` and `LLM_API_KEY`.
  OpenRouter's discovery works too, so the catalog is optional there.
- `models.exe-integration.json`: the keyless exe.dev LLM integration at
  `https://llm.int.exe.xyz`. From outside exe.dev, use the reverse proxy in
  [`examples/exe-llm-proxy.conf`](examples/exe-llm-proxy.conf) over an SSH tunnel.

### Apps in the cloud

The agent controls apps in a cloud through `obelisk cloud ...`. Without an
ObeliskNet token (below), the cloud holds a single app: the *target* Obelisk
instance, named by the `app_name` its `/v1/info` reports. That app is fixed:
the agent can inspect and redeploy it, but cannot create, reconfigure, start,
stop or delete apps. By default the target is the instance the agent itself runs on.

| Variable | Purpose |
| --- | --- |
| `TARGET_OBELISK_API_URL` | Target API, e.g. `http://127.0.0.1:5205`. |
| `TARGET_OBELISK_TOKEN` | API token for the target (required). |
| `TARGET_OBELISK_WEBHOOK_URL` | Target's webhook listener, reachable by the shell's `curl`. Default `http://127.0.0.1:9290`. |

To run a separate local target:

```sh
export TARGET_OBELISK_API_URL=http://127.0.0.1:5205
export TARGET_OBELISK_TOKEN=$(obelisk generate token)
just serve-target
```

> [!WARNING]
> Letting the agent deploy to its own instance is fine for experiments, but a bad
> deployment can remove the agent itself. Use a separate target for real work.
> To target the agent's own instance, set `OBELISK_API_TOKEN` to the same value
> as `TARGET_OBELISK_TOKEN`.

### ObeliskNet

With an ObeliskNet account token, the cloud is ObeliskNet instead, and the agent
can manage hosted apps the same way the `obelisk cloud` CLI does:

```sh
export OBELISK_CLOUD_API_URL=https://...   # the ObeliskNet API
export OBELISK_CLOUD_API_TOKEN=...
```

The agent is then told about your apps and can run, for example:

```sh
obelisk cloud apps list
obelisk cloud app deploy                    # create or update the app from ./app.toml and deploy
obelisk cloud app --app NAME executions list
obelisk cloud app --app NAME secrets set API_KEY --stdin
```

Hosted API and webhook access defaults to `https://*.obelisk.works` on port
443, including `dev.obelisk.works`. For another domain, set
`OBELISK_CLOUD_APP_API_PATTERN` and `OBELISK_CLOUD_APP_WEBHOOK_PATTERN` to its
allowed-host patterns. The webhook grant is GET-only and carries no API token.
Find the webhook URL with `obelisk cloud app --app NAME endpoint webhook`.

Interactive and account-level commands (`--fill`, `token new|revoke`) are not
available from the session. See [`docs/obelisk-cloud.md`](docs/obelisk-cloud.md).

### Docs and example apps

The agent reads the Obelisk documentation from https://obeli.sk.
`OBELISK_VERSION` pins it to a release (default `latest`), and `DOCS_URLS_JSON`
replaces the URL list.

Example apps from the [app catalog](https://obeli.sk/docs/latest/apps/) are
mounted read-only under `/workspace/apps`. Override the list with `APPS_JSON`:

```sh
export APPS_JSON='[{"name":"demo-playwright","repo":"demo-playwright","ref":"main"}]'
```

Each entry is `{name, repo}` plus optional `owner` (default `obeli-sk`), `ref`
(default `main`) and a short `description`. Set `GITHUB_MOUNT_TOKEN` (e.g.
`gh auth token`) to avoid GitHub's anonymous rate limit, and `GITHUB_MOUNT_OWNER`
when mounting repos outside `obeli-sk`.

## The shell

`help` lists the commands, which cover the usual file, text and search tools.
Besides those, the shell provides:

- `obelisk cloud app --app NAME deployment pull DIRECTORY`: an editable snapshot
  of the active deployment; source files load when first read.
- `obelisk cloud ...`: the apps in the cloud (see above).
- `curl`: GET-only, limited to the Obelisk docs and the apps' webhooks.
- `mcp` and `/workspace/mcp`: configured MCP servers.
- `chat`: other sessions (see below).
- `mount`: what is mounted where.

To have the agent stop and ask you something mid-task, it runs
`obelisk call obelisk-agent:stub/stub.ask-user '["Which deployment?"]'`, and the
question appears in the UI as a form.

Background jobs (`&`, `jobs`, `wait`) are not supported.

## Sessions talking to each other: `chat`

```sh
chat models                          # available models
chat list                            # sessions, newest first
chat read E_...                      # transcript (--tail N, --turn N, --json)
chat state E_...                     # whether a session is working or waiting
chat send E_... please re-check X    # message another session
chat create --model claude "prompt"  # start a child session, prints its id
chat create '$ ls -la'               # start a child session in the shell
chat create --name research "..."    # named child session
chat create --top-level "..."        # independent session
chat current                         # this session's id and name
chat rename my-session               # rename this session
```

Child sessions start with an empty history, so put everything they need in
the prompt. They are cancelled together with their parent and are listed under
it in the sidebar.

## MCP servers

A sample MCP server is preconfigured. Start it with `just sample-mcp-server`,
then in a new session:

```sh
mcp list
obelisk-local tools add --a 2 --b 3
obelisk-local prompt greeting --name world
find /workspace/mcp/obelisk-local -type f
```

See [`docs/mcp.md`](docs/mcp.md) for adding your own.

## Development

```sh
just test-js
just test-rs
just test        # including end-to-end tests
```

Design notes live in [`docs/`](docs/).

## License

Apache-2.0. The vendored just-bash port keeps its own LICENSE/NOTICE under
`vendor/just-bash-rs`.
