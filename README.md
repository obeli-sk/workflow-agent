# workflow-agent

> [!WARNING]
> **Vibe coded**: This codebase was generated using an agent (partially by workflow-agent itself), testing the limits of this approach.


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
  agent.js                 workflow.run: load prompt/tools, run agent-loop
  agent-loop.js            workflow.agent-loop: durable messages[] + tool loop
  push-deployment.js       GitHub export orchestrator
webhook/
  ui-api.js                web UI + JSON API
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

Tools exposed to the LLM (each a real Obelisk activity, durable and inspectable),
grouped by family:

| Family              | Tools                                                                                     |
|---------------------|-------------------------------------------------------------------------------------------|
| Discover / inspect  | `list_functions`, `get_function_wit`, `list_executions`, `get_execution`, `get_logs`, `get_result` |
| Native execution    | `call`, `submit`, `join_set_create` / `_submit` / `_delay` / `_join_next` / `_join_next_try` / `_close` |
| Deployment inspect  | `list_deployments`, `current_deployment_id`, `get_deployment`, `get_component_source`      |
| Deployment editing  | `deployment_checkout` / `_list_components` / `_read_component` / `_put_component` / `_remove_component` / `_submit` / `_activate` |
| Operator            | `input.ask_user` *(stub)*                                                                  |

`obelisk.call` and the `join_set_*` tools run as native workflow calls; the rest
are real Obelisk activities. `input.ask_user` is an `activity_stub`: it parks the
workflow until an operator PUTs a response (via the web UI, or
`curl -X PUT .../stub`). `TOOL_SCHEMAS` in `activity/agent-system-prompt.js` is the
single source of truth for the full tool set and argument schemas.

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

## Operator controls (injection stub)

`agent/session.injection` is one generic operator-message offer owned by
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
- `GET /api/runs`, `GET /api/runs/:id` — run list / one run as a transcript
- `GET /api/logs/:id` — execution logs
- `POST /api/submit` — schedule a run
- `POST /api/say/:id`, `/api/pause/:id`, `/api/unpause/:id`, `/api/fork/:id`
- `POST /api/answer/:child`, `/api/confirm/:child` — fulfil `ask_user` / apply-gate stubs

The detail page reconstructs the conversation from `/v1/executions/<id>/responses`:
each `llm.completion` child yields one assistant turn (final or tool_calls) and the
tool activity children provide the tool results. No LLM JSON is parsed in the UI.

## Inspecting a run

Each turn is a separate `obelisk-agent:llm/chat.completion` activity execution;
each tool call is its own activity execution. Use the standard Obelisk WebAPI / CLI
to inspect them, or the web UI.
