# workflow-agent

> [!WARNING]
> **Vibe coded**: This codebase was generated using an agent (partially by workflow-agent itself), testing the limits of this approach.

An Obelisk app in which **the workflow is the agent**. It holds a
provider-neutral chat history, drives an LLM over one of three wire APIs
(**Anthropic Messages**, **OpenAI Chat Completions**, **OpenAI Responses**),
dispatches the model's tool calls to real Obelisk activities, and feeds the
results back, all as durable, replayable workflow state.

The core (agent loop + LLM router + web UI) is generic; a runtime **pack**
supplies the use case (system prompt + tools). This repo ships one pack,
`obelisk-control`, which inspects and modifies the Obelisk instance it runs on.

## Requirements

- **Obelisk** — the runtime that serves this deployment. Use `nix develop` for
  the pinned toolchain.
- **An LLM endpoint.** The model lives behind an HTTP endpoint chosen from the
  `AGENT_MODELS` catalog. The built-in default points at the sibling
  [`agent-backed-llm-server`](https://github.com/obeli-sk/agent-backed-llm-server)
  (a Claude/Codex subscription in docker, keyless on `:9190`). Any
  OpenAI- or Anthropic-shaped endpoint works: the exe.dev gateway, Anthropic or
  OpenAI directly, OpenRouter, vLLM, Ollama, etc. Override the catalog by
  exporting `AGENT_MODELS` in `.envrc` (copy `.envrc-example`).

## Run

```sh
just serve    # obelisk server run -d deployment.toml
```

Then open the web UI on the webhook port (default `8080`), or submit via the API:

```sh
curl -X POST http://127.0.0.1:8080/api/submit \
  -H content-type:application/json -d '{"prompt":"Summarise recent executions.","backend":"claude"}'
```

`backend` is the model `id` from the catalog (empty selects the first entry).
Each turn is a separate `llm.completion` activity and each tool call its own
child execution, so a run is fully durable and replayable; inspect it with the
web UI or the standard Obelisk WebAPI / CLI.
