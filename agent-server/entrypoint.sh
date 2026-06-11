#!/usr/bin/env bash
set -euo pipefail

# entrypoint.sh socket-path
#
# Auth: each backend reads credentials from its host config dir, bind-mounted by
# the start activity. No API key is required (subscription/ChatGPT login).
#
# Optional env:
#   AGENT_BACKEND               "claude" (default) or "codex"
#   AGENT_MODEL                 model id (empty => backend/config default)
#   AGENT_WORKDIR               cwd for the LLM CLI, default /tmp/work
#   AGENT_EXTRA_ARGS            extra args appended to the CLI invocation
#   AGENT_SYSTEM_PROMPT_PATH    deployment-provided prompt file
#   AGENT_HOST_CLAUDE_DIR       claude config mount (default /host-claude)
#   AGENT_HOST_CODEX_DIR        codex config mount (default /host-codex)

SOCKET_PATH="${1:?socket path is required}"
BACKEND="${AGENT_BACKEND:-claude}"

if [ "$BACKEND" = "codex" ]; then
  # codex reads auth.json + config.toml (and writes sessions) under CODEX_HOME.
  # Point it straight at the bind-mounted host ~/.codex.
  export CODEX_HOME="${AGENT_HOST_CODEX_DIR:-/host-codex}"
  echo "[entrypoint] codex backend, CODEX_HOME=$CODEX_HOME" >&2
else
  # Build a minimal CLAUDE_CONFIG_DIR with only the auth files we want. The host
  # ~/.claude usually contains plugins, skills, agents, and marketplaces that
  # register synthetic tools - those get sent to the Anthropic API and reject
  # the request with malformed input_schema errors.
  HOST_DIR="${AGENT_HOST_CLAUDE_DIR:-/host-claude}"
  CONFIG_DIR=/tmp/claude-config
  mkdir -p "$CONFIG_DIR"
  for f in .credentials.json .claude.json; do
    if [ -e "$HOST_DIR/$f" ]; then
      ln -sfn "$HOST_DIR/$f" "$CONFIG_DIR/$f"
    fi
  done
  export CLAUDE_CONFIG_DIR="$CONFIG_DIR"
fi

# Inline the Obelisk llms.txt into the system prompt so the model has a
# concrete reference without spending a tool call on it. The fetch failing
# leaves the static prompt as-is (functional, just less Obelisk-aware).
PROMPT_BASE="${AGENT_SYSTEM_PROMPT_PATH:?system prompt path is required}"
PROMPT_OUT=/tmp/system-prompt.md
LLMS_URL="${AGENT_LLMS_TXT_URL:-https://obeli.sk/docs/latest/llms.txt}"
cp "$PROMPT_BASE" "$PROMPT_OUT"
if curl -fsSL --max-time 5 "$LLMS_URL" -o /tmp/llms.txt; then
  {
    printf '\n# Obelisk reference (from %s)\n' "$LLMS_URL"
    cat /tmp/llms.txt
  } >> "$PROMPT_OUT"
  echo "[entrypoint] appended $(wc -c < /tmp/llms.txt)B of $LLMS_URL to system prompt" >&2
else
  echo "[entrypoint] llms.txt fetch failed; continuing with static prompt" >&2
fi
export AGENT_SYSTEM_PROMPT_PATH="$PROMPT_OUT"

mkdir -p "${AGENT_WORKDIR:-/tmp/work}"
cd "${AGENT_WORKDIR:-/tmp/work}"

exec node /app/server.js "$SOCKET_PATH"
