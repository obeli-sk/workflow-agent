# obelisk-agent

An Obelisk app that runs an LLM CLI (`claude-code` or `codex`) as a
long-running external resource and drives it from a durable workflow.

The structure follows `apps/fio`: each workflow execution spawns a docker
container that owns a Unix socket; short activities open the socket to send a
prompt, drain stream-json output, and finally stop the container.

## Layout

```
agent-server/        Docker image: node + claude-code + server.js (normalizer)
activity/
  agent-start.js     spawn the docker container, wait for the socket (claude.start)
  agent-send.js      send one agent-input (prompt | tool-results) (session.send)
  agent-recv.js      drain one turn; return a typed turn-outcome (session.recv)
  agent-cleanup.js   shut the server down, docker rm (session.cleanup)
workflow/
  agent.js           start -> send(prompt) -> recv(reply) -> cleanup
deployment.toml      FFQNs, common agent schema, and lock_expiry per activity
```

## Common agent schema

Talking to an agent is fully typed and provider-agnostic. The provider-specific
piece is only the **start** activity (`claude.start`, with `codex.start` etc. to
come); `session.{send,recv,cleanup}` are shared. The backend's native output is
normalized **inside the container's `server.js`**, so the workflow and the UI
never parse LLM JSON.

```
agent-input  (workflow -> agent)   variant { prompt(string),
                                             tool-results(list<{name, outcome}>) }
agent-reply  (agent -> workflow)   variant { final(string),
                                             tool-calls(list<{name, arguments-json}>) }
turn-outcome (recv ok)             variant { working, reply(agent-reply) }
agent-error  (recv err)            variant { permanent-rate-limited({retry-after-seconds, message}),
                                             permanent-agent-exited(string),
                                             permanent-error(string),
                                             transient-error(string),
                                             execution-failed }
```

`arguments-json` and `tool-results[].outcome` stay JSON-string-encoded (tool
args/results are inherently dynamic); everything else is a real variant/record.

## Why activities are short

The LLM lives inside the docker container as a persistent process; activities
just speak to it over a socket. `session.send` renders one `agent-input` line
and returns. `session.recv` stays alive for a complete turn, polls the container
internally, and streams native events to its persisted stderr. It returns
`reply` once the backend emits its terminal event, so Obelisk records one recv
execution per turn while live progress remains available in logs.

## stream-json protocol (claude backend)

`agent-server/server.js` spawns `claude -p --input-format stream-json
--output-format stream-json --verbose --model "$AGENT_MODEL"
--append-system-prompt …` and is the **normalizer**: it renders `agent-input`
into claude user messages, and translates claude's stream-json into the common
`turn-outcome` / `agent-reply` / `agent-error` shapes (envelope extraction,
session-limit detection, exit detection all live here). The raw stream-json is
echoed to each activity's stderr for debugging but never appears in the typed
return. Adding codex means branching on `AGENT_BACKEND` in `server.js` plus a
`codex.start` activity. The system prompt still instructs claude to emit the
`{"final": …}` / `{"tool_calls": […]}` envelope, which `server.js` parses.

## Agent loop (in the workflow)

The workflow, not claude, is the agent. Each turn:

1. `session.send` sends the next `agent-input` (`{prompt}` on the first turn, or
   `{tool_results}` from the previous turn).
2. `session.recv` polls until the `turn-outcome` is a `reply`.
3. If the reply is `final`, return it.
4. If the reply is `tool-calls`, dispatch each call to its activity and send the
   aggregated `tool-results` back as the next input.

No JSON parsing happens in the workflow: `server.js` already produced the typed
`agent-reply`.

## Session limit handling

claude (subscription mode) eventually emits a stream-json `result` event with
`is_error: true` and `api_error_status: 429`, e.g. `You've hit your session
limit · resets 3:50pm (UTC)`. `server.js` detects that shape and `session.recv`
returns the `permanent-rate-limited` arm of `agent-error`, carrying
`retry-after-seconds` parsed from the reset time (one hour fallback if the time
cannot be parsed). The `permanent-` prefix tells Obelisk not to retry the
activity.

The workflow catches that variant, durably `obelisk.sleep`s until the limit
resets, then re-sends the same input and continues. The sleep is persistent, so
it survives server restarts. An operator can cancel the sleep (which throws
inside the workflow); the workflow catches the cancellation and resumes
immediately instead of failing the run.

Tools exposed to the LLM (each is a real Obelisk activity, fully durable and
inspectable):

| Tool                       | FFQN                                             |
|----------------------------|--------------------------------------------------|
| `obelisk.list_functions`   | `obelisk-agent:tools/webapi.list-functions`      |
| `obelisk.get_function_wit` | `obelisk-agent:tools/webapi.get-function-wit`    |
| `obelisk.list_executions`  | `obelisk-agent:tools/webapi.list-executions`     |
| `obelisk.get_execution`    | `obelisk-agent:tools/webapi.get-execution`       |
| `obelisk.get_logs`         | `obelisk-agent:tools/webapi.get-logs`            |
| `obelisk.submit`           | `obelisk-agent:tools/webapi.submit-json`         |
| `obelisk.get_result`       | `obelisk-agent:tools/webapi.get-result-json`     |
| `obelisk.deployment_edit_*`| `obelisk-agent:tools/webapi.deployment-edit`     |
| `http.get`                 | `obelisk-agent:tools/http.get`                   |
| `input.ask_user`           | `obelisk-agent:tools/input.ask-user` *(stub)*    |

Execution and deployment list tools expose the REST API pagination cursors.
`obelisk.get_logs` also supports nested executions, log/stream filters, and
cursor pagination.

`input.ask_user` is configured as `activity_stub`: it parks the workflow and
waits for an operator to PUT a response. The web UI surfaces pending asks on
the detail page with an inline form. To answer from the shell instead:

```sh
curl -X PUT http://127.0.0.1:5005/v1/executions/<child-id>/stub \
  -H content-type:application/json -d '{"ok": "the answer text"}'
```

Cancelling the stub child surfaces as an err tool_result; the LLM can react
or emit `{"final": "Cancelled by user."}`.

## Deployment edit transactions

Component changes use one workflow-local draft instead of sending the full
deployment through the model on every edit:

1. `obelisk.deployment_edit_begin` captures the active deployment, or an
   explicitly selected base deployment.
2. Any number of idempotent JS activity, workflow, or webhook upserts and
   component deletes mutate that durable draft in order.
3. `obelisk.deployment_edit_show` stores the complete canonical draft in its
   child execution result for UI inspection, returns compact metadata to the
   model, and marks its current revision as reviewed.
4. `obelisk.deployment_edit_submit` creates one inactive deployment. It refuses
   unreviewed changes and detects an active-deployment change since begin.
5. `obelisk.apply_deployment` presents the source diff and waits for OK/Cancel.

`obelisk.deployment_edit_abort` discards the draft without creating a
deployment. Repeating an identical upsert returns `unchanged`; deleting a
missing component returns `already_absent`.

## Build the image

```sh
just build
```

Tags `ghcr.io/obeli-sk/obelisk-agent-server:latest`. The image name is wired
into `agent-start.js` through the `AGENT_IMAGE` env var (defaulted in
`deployment.toml`). The system prompt is deployment-owned: the
`agent/prompt.load-system-prompt` JS activity supplies it to `agent.start`,
which writes it beside the session socket for the container to read. Prompt
changes therefore do not require an image rebuild.

## Authenticate claude-code

The activity bind-mounts your host's claude-code config dir into the container,
so the container uses your existing Claude subscription. Log in once on the
host:

```sh
claude   # follow the OAuth flow
```

This populates `~/.claude/`. `agent-start.js` reads `AGENT_HOST_CLAUDE_DIR`
(defaults to `$HOME/.claude`) and mounts it at `/claude-config` with
`CLAUDE_CONFIG_DIR=/claude-config` inside the container. The mount is
read-write so claude can refresh tokens.

## Start the server

```sh
just serve
```

Optional env vars (defaults set per backend in `deployment.toml`):

- `AGENT_IMAGE` - override the docker image tag
- `AGENT_MODEL` - claude default `claude-opus-4-7`
- `AGENT_CODEX_MODEL` - codex default `gpt-5.5` (a ChatGPT-account-supported model)
- `AGENT_EXTRA_ARGS` / `AGENT_CODEX_EXTRA_ARGS` - extra CLI args inside the container
- `AGENT_HOST_CLAUDE_DIR` - host claude config to mount, default `$HOME/.claude`
- `AGENT_HOST_CODEX_DIR` - host codex config to mount, default `$HOME/.codex`

## Submit a one-shot prompt

From the CLI (claude is the default backend; `run-codex` selects codex):

```sh
just run 'Summarise the latest commits on main.'
just run-codex 'Summarise the latest commits on main.'
```

To submit paused:

```sh
OBELISK_SUBMIT_FLAGS=--paused just run 'prompt here'
```

Or use the web UI (the new-prompt form has a `claude`/`codex` selector).

## Web UI

`webhook/ui.js` is registered as `webhook_endpoint_js` and serves three routes
on whatever port the Obelisk server has configured for webhooks (default
`8080`):

- `GET  /`              list recent `workflow.run` executions, with a form to
                        submit a new prompt
- `POST /submit`        accepts the form, schedules a new run, redirects to
                        the detail page
- `GET  /e/<exec-id>`   shows one run: the prompt, every stream-json event
                        from claude (user, assistant, tool_use, tool_result,
                        result), and the final return value

The detail page reconstructs the conversation from `/v1/executions/<id>/responses`
by reading the typed `turn-outcome` returned by each `session.recv` child
execution (the `reply` outcomes), so no extra storage is needed and no LLM JSON
is parsed in the UI. Its logs control loads workflow, stdout, and stderr entries
from the root execution and every nested execution, including an active recv.

## Inspecting a run

Each turn is a separate activity execution. Beyond the UI, you can use the
standard Obelisk WebAPI / CLI to inspect them: `claude.start`, `session.send`,
one `session.recv` per turn, tool activities, and `session.cleanup`. The typed
`agent-reply` is captured as the `recv` result; native events stream to that
activity's stderr.

## Backends

The backend is chosen by the workflow's `backend` param (`null`/absent =>
claude, `"codex"` => codex). The common agent schema is the seam: only the start
activity and `server.js` are provider-specific.

| | claude | codex |
|---|---|---|
| start activity | `obelisk-agent:agent/claude.start` | `obelisk-agent:agent/codex.start` |
| auth | `~/.claude` -> `CLAUDE_CONFIG_DIR` | `~/.codex` -> `CODEX_HOME` (`auth.json` + `config.toml`) |
| default model | `claude-opus-4-7` | `gpt-5.5` (ChatGPT-account-supported) |
| process model | one persistent `claude -p --input-format stream-json` | `codex exec --json` per turn, continued with `codex exec resume <thread_id>` |
| turn ends at | `result` event | `turn.completed` / `turn.failed` |

Both run their full internal tool loop (FS, shell, web) within a turn and
surface durable actions through the `{"tool_calls": …}` envelope. `server.js`
normalizes each into the common `turn-outcome` / `agent-reply` / `agent-error`
shapes, so the workflow and UI are backend-agnostic.

codex specifics: it has no `--append-system-prompt`, so the system prompt rides
along in the first turn's user message; the first turn uses
`--dangerously-bypass-approvals-and-sandbox` (the container is the sandbox) and
resume inherits it. The codex session is persisted under the host-mounted
`~/.codex/sessions`, so the conversation survives a container restart (automatic
restart-and-resume on container death is not yet wired). `server.js` waits for
each `codex exec` process to fully close before the next `resume`, so the
session file is flushed first.

Authenticate codex once on the host (`codex login`), which populates `~/.codex`.

To add a third backend, follow the same seam: a new `<backend>.start` activity +
a branch in `server.js` that maps its native events to the common shapes.
