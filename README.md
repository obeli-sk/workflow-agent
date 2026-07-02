# workflow-agent

An Obelisk app in which **the workflow is the agent**. It drives an LLM over the
standard OpenAI **Chat Completions** wire (`POST /v1/chat/completions`), dispatches
the model's tool calls to real Obelisk activities, and feeds the results back,
all as durable, replayable workflow state.

There are **no exec activities and no docker here**. The model lives behind an
HTTP endpoint (`LLM_BASE_URL`): point it at the sibling
[`agent-backed-llm-server`](https://github.com/obeli-sk/agent-backed-llm-server)
app (a Claude/Codex subscription in docker) or straight at OpenRouter, OpenAI,
vLLM, Ollama, or anything OpenAI-compatible.

## Layout

```
activity/
  agent-system-prompt.js   load-system-prompt: system prompt + OpenAI tool schemas (one source of truth)
  llm-chat.js              chat.completion: POST messages + tools to LLM_BASE_URL
  tools/*                  the workflow-visible tools (each a real Obelisk activity)
  github/*                 GitHub export activities
workflow/
  agent.js                 workflow.run: load prompt/tools, race agent-loop vs teardown
  agent-loop.js            workflow.agent-loop: durable messages[] + tool loop
  push-deployment.js       GitHub export orchestrator
webhook/
  ui-api.js, ui.js         web UI + JSON API
deployment.toml            FFQNs, tool activities, stubs, and the LLM allow-list
```

## The agent loop

`workflow.agent-loop` holds the full chat-completions `messages[]` in durable
workflow state. Each turn:

1. Consume any pending operator injection (appended as a `user` message).
2. `llm.completion(messages, tools, model)` POSTs the history to the endpoint and
   returns the assistant turn: `content` + `tool_calls` (+ `finish_reason`), or a
   `rate-limited` signal.
3. On `rate-limited`, durably `obelisk.sleep` for the retry window and re-POST.
4. Append the assistant message verbatim (so the next request and the backend's
   history pairing see an identical, growing history).
5. If there are `tool_calls`, dispatch each to its Obelisk activity, append one
   `tool` message per result, and loop. Otherwise the assistant `content` is the
   final answer.

Tool calls are **native**: the agent sends OpenAI `tools` (function schemas built
from `TOOL_SCHEMAS` in `agent-system-prompt.js`) and the model replies with
`tool_calls`; a final answer is an assistant message with no `tool_calls`. No JSON
envelope is parsed in the workflow. Each turn is one `llm.completion` activity
whose result is persisted, so the loop is fully replayable.

Tools exposed to the LLM (each a real Obelisk activity, durable and inspectable):

| Tool                       | FFQN                                             |
|----------------------------|--------------------------------------------------|
| `obelisk.list_functions`   | `obelisk-agent:tools/webapi.list-functions`      |
| `obelisk.get_function_wit` | `obelisk-agent:tools/webapi.get-function-wit`    |
| `obelisk.list_executions`  | `obelisk-agent:tools/webapi.list-executions`     |
| `obelisk.get_execution`    | `obelisk-agent:tools/webapi.get-execution`       |
| `obelisk.get_logs`         | `obelisk-agent:tools/webapi.get-logs`            |
| `obelisk.call` / `obelisk.submit` | native call / join-set submit             |
| `obelisk.get_result`       | `obelisk-agent:tools/webapi.get-result-json`     |
| `obelisk.deployment_checkout` / `_read_component` / `_put_component` / `_submit` / `_activate` | deployment editing |
| `input.ask_user`           | `obelisk-agent:tools/input.ask-user` *(stub)*    |

`input.ask_user` is an `activity_stub`: it parks the workflow until an operator
PUTs a response (via the web UI, or `curl -X PUT .../stub`). The full tool set and
argument schemas live in `activity/agent-system-prompt.js`.

## Editing a deployment: checkout -> change one component -> submit -> activate

The stored `deployment.toml` is the source of truth. The workflow holds a working
copy split into per-component TOML blocks and changes one component per
intermediate deployment, so the server validates small diffs.

1. `obelisk.deployment_checkout` fetches a deployment (active by default) and
   splits its verbatim `deployment_toml` into component blocks. `from_scratch`
   starts empty.
2. `obelisk.deployment_read_component` returns one block (+ script for owned JS);
   `obelisk.deployment_put_component` adds/replaces one; `_remove_component` drops
   one. Only one component may change per deployment.
3. `obelisk.deployment_submit` assembles the manifest, fills `content_digest` for
   changed sources, and submits it as a new **inactive** deployment (JSON preflight,
   then multipart with only the missing sources on a 409).
4. `obelisk.deployment_activate` makes it live: `enqueue` (next restart) or `apply`
   (hot redeploy now, after the `deploy.confirm-apply` operator gate). `apply` is
   terminal and must be the final tool call.

## Operator controls (teardown and injection stubs)

Two `activity_stub`s let an operator steer a live run from the web UI:

- `agent/session.teardown-signal` is a supervisor control child. `workflow.run`
  races it against the whole nested `agent-loop`. Cancelling it (UI `POST
  /api/cleanup`) wins the race, so the run returns instead of continuing. (There is
  no container to stop anymore; teardown just ends the loop.)
- `agent/session.injection` is one generic operator-message offer owned by
  `agent-loop`. The UI fulfils it (`POST /api/say`) while it is pending; the
  workflow includes the text as the next `user` message and opens a fresh offer.

## Configure the LLM endpoint

`llm-chat.js` reads:

- `LLM_BASE_URL` — endpoint base (default `http://127.0.0.1:9190`, the local
  `agent-backed-llm-server` webhook). Set `LLM_BASE_URL_REGEX` to the regex-escaped
  form when pointing elsewhere so the `allowed_host` matches.
- `LLM_MODEL` — default model / backend hint (default `claude`).
- `LLM_API_KEY` — optional bearer token (unused for the subscription CLI backend;
  for a real key-based provider, move it to `allowed_host.secrets`).

The `workflow.run` `backend` param (`claude` / `codex` / a model id) is passed
through as the per-request model hint.

## Run

```sh
just serve    # obelisk server run -d deployment.toml
```

Submit a prompt from the web UI (webhook port, default `8080`) or the API:

```sh
curl -X POST http://127.0.0.1:8080/api/submit \
  -H content-type:application/json -d '{"prompt":"Summarise recent executions.","backend":"claude"}'
```

For a Claude/Codex subscription backend, run
[`agent-backed-llm-server`](https://github.com/obeli-sk/agent-backed-llm-server)
alongside and leave `LLM_BASE_URL` at its default.

## Web UI

`webhook/ui-api.js` serves an SPA plus a JSON API on the webhook port:

- `GET /` — run list + new-prompt form
- `POST /api/submit` — schedule a run
- `GET /api/runs/:id` — one run as a transcript
- `POST /api/say/:id`, `/api/cleanup/:id`, `/api/answer/:child`, `/api/confirm/:child`

The detail page reconstructs the conversation from `/v1/executions/<id>/responses`:
each `llm.completion` child yields one assistant turn (final or tool_calls) and the
tool activity children provide the tool results. No LLM JSON is parsed in the UI.

## Inspecting a run

Each turn is a separate `obelisk-agent:llm/chat.completion` activity execution;
each tool call is its own activity execution. Use the standard Obelisk WebAPI / CLI
to inspect them, or the web UI.
