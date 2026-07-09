# workflow-agent

> [!WARNING]
> **Vibe coded**: This codebase was generated using an agent (partially by workflow-agent itself), testing the limits of this approach.


An Obelisk app in which **the workflow is the agent**. It holds a
provider-neutral chat history, drives an LLM over one of three wire APIs
(**Anthropic Messages**, **OpenAI Chat Completions**, **OpenAI Responses**),
dispatches the model's tool calls to real Obelisk activities, and feeds the
results back, all as durable, replayable workflow state.

There are **no exec activities and no docker here**. The model lives behind an
HTTP endpoint. A configurable **model catalog** (`AGENT_MODELS`) maps each model
to its wire API + endpoint, and each entry declares its own auth (`auth_header` +
`auth_value`). By default it points at the sibling
[`agent-backed-llm-server`](https://github.com/obeli-sk/agent-backed-llm-server)
app (a Claude/Codex subscription in docker, keyless on `:9190`), but an entry can
point anywhere OpenAI- or Anthropic-shaped: a local **exe.dev LLM gateway**
(`http://localhost:7070`, one origin proxying Anthropic / OpenAI / Fireworks),
Anthropic/OpenAI directly, OpenRouter, vLLM, Ollama, or anything compatible.

## Layout

The **core** is generic (an agent loop + LLM router + UI); it knows nothing about
any specific tool. A **pack** supplies the use case (system prompt + tools) and is
discovered at runtime by FFQN. This repo ships one pack, `obelisk-control`
(inspect/modify this Obelisk instance).

```
activity/
  llm-chat.js              CORE  chat.completion: adapt neutral history to the model's wire API + POST
workflow/
  agent.js                 CORE  workflow.run: resolve the pack descriptor, run agent-loop
  agent-loop.js            CORE  workflow.agent-loop: durable neutral messages[] + generic dispatch
webhook/
  ui-api.js                CORE  web UI + JSON API (+ GET /api/models, HITL cards)
packs/obelisk-control/
  descriptor.js            PACK  pack.describe: system prompt + tool catalog (name, ffqn, WIT params)
  native-call.js           PACK  native.call: run any deployed function chosen at runtime
  tools/*                  PACK  the leaf tool activities (each a real Obelisk activity)
  github/*, push-deployment.js   PACK  GitHub export of the live deployment
deployment.toml            core + provider allow-lists + the obelisk-control pack
```

## The pack contract (tools are just FFQNs)

`workflow.run(prompt, model, descriptor-ffqn?)` calls the **descriptor** FFQN
(default `obelisk-control:agent/pack.describe`) once. It returns the system prompt
and a tool catalog:

```
{ prompt, tools: [{ name, description, ffqn, params: [{ name, type, default? }] }] }
```

Each tool is an ordinary deployed Obelisk function. The core exposes the tools to
the model (building each JSON schema from the WIT `params`) and dispatches a tool
call by encoding the model's arguments into positional WIT params and running
`obelisk.call(ffqn, params)`; Obelisk decodes the WIT result back to JSON for the
model. The core never names a tool. Point `descriptor-ffqn` at a different
descriptor to host a different use case.

## The agent loop

`workflow.agent-loop` holds a **provider-neutral** `messages[]` (content blocks:
`text` / `tool_use` / `tool_result`) in durable workflow state; the system prompt
is passed separately. Each turn:

1. Consume any pending operator injection (appended as a `user` text message).
2. `llm.completion(system, messages, tools, model)` resolves `model` in the
   `AGENT_MODELS` catalog, adapts the neutral history to that wire API, POSTs it,
   and returns the assistant turn as neutral blocks (`content-json` +
   `stop-reason`), or a `rate-limited` signal.
3. On `rate-limited`, durably `obelisk.sleep` for the retry window and re-POST.
4. Append the assistant message verbatim (identical, growing history across turns
   and providers).
5. If the assistant emitted `tool_use` blocks, dispatch each via
   `obelisk.call(ffqn, ...)` and append one `user` message carrying all
   `tool_result` blocks, then loop. Otherwise show the assistant text and wait for
   the operator's next message in the same session.

Each turn is one `llm.completion` activity and each tool call its own child
execution, so the loop is fully durable and replayable.

## Human in the loop

HITL is a **core** capability: any pack tool whose FFQN is an `activity_stub`
parks the workflow when called (via `obelisk.call`) until the UI fulfils it. The
`obelisk-control` pack uses two:

- `input.ask_user(question)` — the UI renders a text card and `PUT`s the answer.
- `obelisk.deployment_confirm_apply(deployment_id, summary)` — the UI renders an
  approve/reject card (with a source diff) before a hot redeploy.

## obelisk-control tools

The pack's tool catalog (single source of truth: `packs/obelisk-control/descriptor.js`):

| Family              | Tools                                                                                     |
|---------------------|-------------------------------------------------------------------------------------------|
| Discover / inspect  | `list_functions`, `get_function_wit`, `list_executions`, `get_execution`, `get_logs`, `get_result` |
| Native execution    | `call` (run any deployed FFQN, via `native.call`)                                          |
| Deployment inspect  | `list_deployments`, `current_deployment_id`, `get_deployment`, `get_component_source`      |
| Deployment editing  | `deployment_checkout`, `deployment_read_blob`, `deployment_submit`, `deployment_switch`, `deployment_confirm_apply`, `deployment_apply` |
| Operator            | `input.ask_user` *(stub)*                                                                  |

## Editing a deployment (stateless): read -> edit toml -> submit -> activate

The stored `deployment.toml` is the source of truth. Editing is stateless: the
model holds the working copy in its own context and submits a complete manifest.

1. `obelisk.deployment_checkout` returns the verbatim `deployment_toml` (active by
   default). Owned JS/exec sources are referenced by `location` + `content_digest`;
   fetch their bytes with `obelisk.deployment_read_blob`.
2. The model edits the TOML text and collects changed owned sources as
   `{ path, content }` entries.
3. `obelisk.deployment_submit` validates and stores the **complete** manifest
   (`edited_files_json` carries the changed sources; the server fills
   `content_digest`) as a new **inactive** deployment.
4. Activate: `obelisk.deployment_switch` (next restart), or
   `obelisk.deployment_confirm_apply` (operator gate) followed by
   `obelisk.deployment_apply` (hot redeploy now).

## Operator controls (injection stub)

`agent/session.injection` is one generic operator-message offer owned by
`agent-loop`. The UI fulfils it (`POST /api/say`) while it is pending; the
workflow includes the text as the next `user` message. When the model replies
without tool calls, the workflow waits on that same offer instead of finishing.

## Configure the LLM endpoint

The model catalog lives in the `AGENT_MODELS` env var (read by both `llm-chat.js`
and the web UI). The built-in default in `deployment.toml` is the local
`agent-backed-llm-server` (keyless, `:9190`). To use a different set, export
`AGENT_MODELS` in `.envrc` (copy `.envrc-example`); direnv loads it and it
overrides the default. It is a JSON array; each entry routes one model to a wire
API + endpoint and declares its own auth:

```json
[
  { "id": "claude-opus-4.8", "label": "claude-opus-4.8", "api_type": "anthropic-messages",
    "base_url": "http://localhost:7070/gateway/llm/anthropic", "wire_model": "claude-opus-4-8",
    "auth_header": "x-api-key", "auth_value": "implicit", "max_tokens": 8192 },
  { "id": "kimi-k2", "label": "Kimi K2 (OpenRouter)", "api_type": "openai-chat-completions",
    "base_url": "https://openrouter.ai/api", "wire_model": "moonshotai/kimi-k2",
    "auth_header": "authorization", "auth_value": "Bearer ${OPENROUTER_API_KEY}" },
  { "id": "local", "label": "local backend", "api_type": "openai-chat-completions",
    "base_url": "http://127.0.0.1:9190", "wire_model": "claude" }
]
```

- `api_type` — `anthropic-messages`, `openai-chat-completions`, or
  `openai-responses`. The llm activity adapts the neutral history to that wire.
- `base_url` — the origin + provider path; each adapter appends its route
  (`/v1/messages`, `/v1/responses`, `/v1/chat/completions`).
- `wire_model` — the exact id the provider expects, which may differ from the
  friendly `id`/`label` shown in the UI (e.g. `claude-opus-4.8` → `claude-opus-4-8`,
  or `accounts/fireworks/models/glm-5p2`).
- `auth_header` / `auth_value` — the auth header to send and its value; omit both
  for a keyless endpoint. `auth_value` may embed `${ENV_VAR}`. For a **real key**,
  make `ENV_VAR` an `allowed_host.secrets` entry in `deployment.toml`: Obelisk
  hands the JS a placeholder and swaps in the real value at the network edge, so
  the key never enters the workflow. For the exe.dev gateway the token is the
  literal public string `implicit` (creds are injected at the gateway), so it is
  written inline and needs no secret.
- Every origin a model points at needs a matching `allowed_host` in
  `deployment.toml`. Blocks for the local backend and the gateway ship active; an
  OpenRouter block (with its `allowed_host.secrets`) ships commented as a template.

Two ready-made catalogs ship as JSON files, loaded via `.envrc`:

- `models.local.json` — the two `agent-backed-llm-server` models (`:9190`, keyless).
  Same as the `deployment.toml` default.
- `models.exe-gateway.json` — the full **exe.dev gateway** set (Anthropic `claude-*`,
  OpenAI `gpt-*` via the responses API, Fireworks `*-fireworks`).

`.envrc-example` shows loading either (`export AGENT_MODELS="$(cat models.exe-gateway.json)"`),
the `ln -sf` symlink pattern (a canonical `models.json`), and a keyed **OpenRouter**
entry. The `workflow.run` `model` param (the `backend` field of `POST /api/submit`)
is the model `id`; empty selects the first catalog entry. The UI dropdown is
populated from `GET /api/models`.

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
- `GET /api/models` — the configurable model catalog (drives the dropdown)
- `GET /api/runs`, `GET /api/runs/:id` — run list / one run as a transcript
- `GET /api/logs/:id` — execution logs
- `POST /api/submit` — schedule a run
- `POST /api/say/:id`, `/api/pause/:id`, `/api/unpause/:id`
- `POST /api/answer/:child`, `/api/confirm/:child` — fulfil `ask_user` / apply-gate stubs

The detail page reconstructs the conversation from `/v1/executions/<id>/responses`:
each `llm.completion` child yields one assistant turn (response or tool_calls) and the
tool activity children provide the tool results. No LLM JSON is parsed in the UI.

## Inspecting a run

Each turn is a separate `obelisk-agent:llm/chat.completion` activity execution;
each tool call is its own activity execution. Use the standard Obelisk WebAPI / CLI
to inspect them, or the web UI.
