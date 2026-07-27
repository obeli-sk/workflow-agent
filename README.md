# workflow-agent

> [!WARNING]
> **Vibe coded**: This codebase was generated using an agent (partially by workflow-agent itself), testing the limits of this approach.

An Obelisk app in which **the workflow is the agent**. It holds a
provider-neutral chat history, a persistent just-bash virtual filesystem, and
one model-facing `bash` tool. Pack executables run inside the same workflow and
call real Obelisk activities for external operations.

The core owns the agent loop, Bash session, LLM router, and web UI. A compiled
**pack** supplies commands, system guidance, and virtual files. This repo ships
one pack, `obelisk-control`, which mounts the active deployment under
`/workspace/deployment` and provides an `obelisk` executable.

![workflow-agent web UI](docs/workflow-agent.png)

## Requirements

- **Obelisk**: the runtime that serves this deployment. The just-bash workflow
  requires the deterministic Promise-draining change in the sibling Obelisk
  source tree. Until that runtime is published, build Obelisk with
  `--features workflow-js-local` and run that binary.
- **pnpm**: installs the workflow bundler and the dependencies of the just-bash
  source vendored at `vendor/just-bash`. The vendored package starts at upstream
  revision `6df692f236ca108c888552a67557998156ac845b` and includes the embedding
  changes required by this application.
- **`AGENT_MODELS`**: the model catalog, **required**: a JSON array pointing each
  model at an OpenAI- or Anthropic-shaped HTTP endpoint. Two ready-made catalogs
  ship:
  - `models.local.json`: the sibling
    [`agent-backed-llm-server`](https://github.com/obeli-sk/agent-backed-llm-server)
    (a Claude/Codex subscription in docker, keyless on `:9190`).
  - `models.exe-gateway.json`: the exe.dev LLM gateway (Anthropic + OpenAI +
    Fireworks). Requires an exe.dev account; the entries point at
    `http://localhost:7070`, so forward the gateway to that local port first:
    ```sh
    ssh -L 7070:169.254.169.254:80 <yourinstance>.exe.xyz
    ```
  - `models.openrouter.json`: [OpenRouter](https://openrouter.ai) (Claude, GPT,
    DeepSeek, and a free Qwen3 Coder model). Needs an API key; the key stays
    secret (injected into the outbound header at the edge, never seen by the JS):
    ```sh
    export OPENROUTER_API_KEY=sk-or-...
    ```

  Any other compatible endpoint (Anthropic/OpenAI directly, vLLM, Ollama, …)
  works too. Add an entry pointing at it.

## Run

Build the workflow bundle and set the required catalog:

```sh
just install
just build
ln -sf models.local.json models.json      # pick a catalog
export AGENT_MODELS="$(cat models.json)"   # or use direnv (.envrc-example)
```

With a published Promise-capable runtime, `just serve` starts the app. For local
development against the sibling Obelisk source:

```sh
cd ../../obelisk
nix develop -c cargo build -p obelisk --features workflow-js-local
cd ../apps/workflow-agent
../../obelisk/target/debug/obelisk server run -d deployment.toml
```

Then navigate to http://localhost:9090. Create an empty session to use the shell
directly, or submit a prompt and inspect the same filesystem afterward. The
operator input offer remains live while an LLM completion is pending, so shell
commands can inspect and edit the session VFS during the model wait. A prompt
sent during that wait is queued for the next model turn.

The core registers just-bash's full browser command catalog, except `gzip`,
`gunzip`, and `zcat`, which require Node zlib. This includes the standard file,
path, text-processing, search, shell, checksum, encoding, and inspection tools.
Network access is not a direct `curl` command: external I/O is supplied by
durable pack executables such as `obelisk`. Python, Node.js, tar, yq, xan, and
SQLite also require runtimes that workflow JavaScript does not provide.

Interactive job control is not available. `jobs`, `wait`, `fg`, `bg`, signals,
and durable background execution with `&` are not supported. The session
rejects statements terminated by `&` instead of silently running them in the
foreground. Packs use Obelisk child executions for durable external work.

If an empty session finishes immediately, inspect its execution result and
logs. A server without returned-Promise support is one possible cause.
Hot-redeploying this application does not replace that runtime; restart Obelisk
with the `workflow-js-local` build above.
