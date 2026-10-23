#!/usr/bin/env bash
#
# End-to-end test for stateless MCP support (docs/mcp.md). Runs the self-contained
# sample server (examples/stateless-mcp-server.mjs) with local node,
# deploys one MCP activity block pointed at it, opens a session, and drives the
# shell command surface and lazily mounted resources through one user shell
# turn, asserting the rendered output.
#
# Requires node, provided by the dev shell.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

source "$ROOT/scripts/e2e-lib.sh"

API_PORT=28116
EXTERNAL_PORT=28191
MCP_PORT="${MCP_PORT:-1071}"
MCP_PID=""
MCP_URL="http://127.0.0.1:${MCP_PORT}/mcp"
SERVER_NAME="obelisk-e2e"

e2e_init "mcp-e2e" "$API_PORT" "$EXTERNAL_PORT" "e2e-mcp-token"
export OBELISK_API_URL="$E2E_API_URL"
export AGENT_MODELS="[]"
# The workflow discovers MCP servers from MCP_SERVERS_JSON (the config_discover
# activity), overriding the manifest default so this run wires only the injected
# obelisk-e2e server. Unset MCP_SERVER_TOKEN keeps the manifest's sample
# obelisk-local block keyless so it deploys without a real secret (it is never
# invoked here, since discovery does not return it).
export MCP_SERVERS_JSON="[{\"name\":\"${SERVER_NAME}\",\"ffqn\":\"obelisk-agent:mcp/server.${SERVER_NAME}\"}]"
unset MCP_SERVER_TOKEN

# Extend the library cleanup to also stop the MCP server.
mcp_cleanup() {
    if [[ -n "$MCP_PID" ]]; then
        kill "$MCP_PID" 2>/dev/null || true
        wait "$MCP_PID" 2>/dev/null || true
    fi
    e2e_cleanup
}
trap mcp_cleanup EXIT

echo ">>> starting stateless MCP server (local node) on :${MCP_PORT}"
PORT="$MCP_PORT" node "$ROOT/examples/stateless-mcp-server.mjs" >"$E2E_TMP/mcp-server.log" 2>&1 &
MCP_PID=$!

# The nix devshell ships node but not curl, so probe readiness with node.
http_ok() {
    node -e 'const http=require("http");const r=http.get(process.argv[1],s=>{s.resume();process.exit(s.statusCode===200?0:1)});r.on("error",()=>process.exit(1))' "$1"
}
echo ">>> waiting for the MCP server to become ready"
if ! e2e_wait_until http_ok "http://127.0.0.1:${MCP_PORT}/" 2>/dev/null; then
    echo "MCP server did not become ready; log:" >&2
    sed -n '1,120p' "$E2E_TMP/mcp-server.log" >&2 || true
    exit 1
fi

# --- deployment: real manifest + one MCP block, keyless -----------------------
DEPLOY="$ROOT/.e2e-mcp-deployment.toml"
E2E_DEPLOYMENTS+=("$DEPLOY")
cp "$ROOT/deployment.toml" "$DEPLOY"
cat >> "$DEPLOY" <<EOF

# Injected by scripts/test-e2e-mcp.sh: one keyless stateless MCP server.
[[activity_js]]
name = "mcp_${SERVER_NAME//-/_}"
ffqn = "obelisk-agent:mcp/server.${SERVER_NAME}"
params = [
  { name = "method",      type = "string" },
  { name = "params-json", type = "string" },
]
return_type = "result<string, string>"
location = "activity/mcp.js"
env_vars = [{ key = "MCP_SERVER_URL", value = "${MCP_URL}" }]
[[activity_js.allowed_host]]
pattern = "http://127.0.0.1:${MCP_PORT}"
methods = ["POST"]
EOF

# app.toml needs the matching outbound-host grant (keyless).
APP_CFG="$ROOT/.e2e-mcp-app.toml"
E2E_DEPLOYMENTS+=("$APP_CFG")
cp "$ROOT/app.toml" "$APP_CFG"
cat >> "$APP_CFG" <<EOF

# Injected by scripts/test-e2e-mcp.sh: keyless outbound grant for the MCP server.
[[outbound_http.allowed_host]]
pattern = "http://127.0.0.1:${MCP_PORT}"
methods = ["POST"]
EOF
export E2E_APP_CONFIG="$APP_CFG"

e2e_start_server "$DEPLOY"

# --- open a session and drive one MCP shell turn ------------------------------
RUN_FFQN="obelisk-agent:workflow/workflow.run-cancellable"
SESSION_ID="$("$OBELISK" generate execution-id)"
echo ">>> creating an empty session as $SESSION_ID"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$SESSION_ID" "$RUN_FFQN" \
    '["", null, null, null, null]'

echo ">>> waiting for the session input offer"
injection_offered() {
    SESSION_EXECUTIONS="$("$OBELISK" execution list -j -a "$E2E_API_URL" \
        -e "$SESSION_ID" --show-derived --limit 100)" || return 1
    INJECTION_ID="$(node scripts/e2e-json.js execution-id \
        "obelisk-agent:stub/stub.injection" <<<"$SESSION_EXECUTIONS")"
    [[ -n "$INJECTION_ID" ]]
}
e2e_wait_until injection_offered \
    || { echo "session did not expose its input offer: $SESSION_EXECUTIONS" >&2; exit 1; }

TURN_SCRIPT="$E2E_TMP/mcp-turn.sh"
cat > "$TURN_SCRIPT" <<EOF
echo '### mcp list'
mcp list
echo '### server help'
${SERVER_NAME} --help
echo '### info'
${SERVER_NAME} info
echo '### tools'
${SERVER_NAME} tools
echo '### tool help'
${SERVER_NAME} tools add --help
echo '### call add'
${SERVER_NAME} tools add --arg a=2 --b 3
echo '### call echo'
${SERVER_NAME} tools echo --text 'hi there'
echo '### prompts'
${SERVER_NAME} prompts
echo '### prompt help'
${SERVER_NAME} prompt greeting --help
echo '### prompt'
${SERVER_NAME} prompt greeting --name world
echo '### resources'
find /workspace/mcp/${SERVER_NAME} -type f
cat /workspace/mcp/${SERVER_NAME}/README.md
cat /workspace/mcp/${SERVER_NAME}/config/settings.json
EOF

echo ">>> stubbing the input offer with the MCP shell turn"
STUB="$(node scripts/e2e-json.js shell-event "mcp-e2e-1" "$TURN_SCRIPT")"
"$OBELISK" execution stub -a "$E2E_API_URL" "$INJECTION_ID" "$STUB"

echo ">>> waiting for the shell output to be recorded"
# Records batch several events, so check each for the shell turn's stdout.
shell_recorded() {
    local record_id record_result
    SESSION_EXECUTIONS="$("$OBELISK" execution list -j -a "$E2E_API_URL" \
        -e "$SESSION_ID" --show-derived --limit 100)" || return 1
    while IFS= read -r record_id; do
        if [[ -n "$record_id" ]] \
            && record_result="$("$OBELISK" execution result -j -a "$E2E_API_URL" "$record_id" 2>/dev/null)" \
            && STDOUT="$(node scripts/e2e-json.js shell-stdout <<<"$record_result" 2>/dev/null)" \
            && [[ -n "$STDOUT" ]]; then
            return 0
        fi
    done < <(node scripts/e2e-json.js execution-ids \
        "obelisk-agent:stub/stub.record-output" <<<"$SESSION_EXECUTIONS")
    return 1
}
e2e_wait_until shell_recorded \
    || { echo "shell turn did not record output: $SESSION_EXECUTIONS" >&2; exit 1; }


"$OBELISK" execution cancel -a "$E2E_API_URL" "$SESSION_ID" >/dev/null 2>&1 || true

echo ">>> shell turn output:"
echo "$STDOUT"

fail=0
require() {
    if ! grep -qF -- "$1" <<<"$STDOUT"; then
        echo ">>> MCP E2E FAIL: expected to find: $1" >&2
        fail=1
    fi
}
require "${SERVER_NAME}  url=${MCP_URL}  auth=no"   # mcp list registry
require "workflow-agent-stateless-sample"            # info -> server/discover
require "\"add\""                                    # tools/list
require "\"echo\""                                   # tools/list
require "Usage: ${SERVER_NAME} tools add [OPTIONS]"    # schema-driven help
require "--a <number> (required)"                    # tool input schema
require "echo: hi there"                             # tools/call echo
require "greeting"                                   # prompts/list
require "--name <string> (required)"                 # prompt arguments
require "[user] Hello, world!"                       # prompts/get render
require "/workspace/mcp/${SERVER_NAME}/README.md"    # resources/list -> VFS
require "This file was fetched lazily"               # resources/read text
require '"mode":"stateless","answer":42'           # nested resource path
if ! grep -qx "5" <<<"$STDOUT"; then                 # tools/call add
    echo ">>> MCP E2E FAIL: expected 'add' tool to return 5" >&2
    fail=1
fi

if [[ $fail -ne 0 ]]; then
    echo ">>> server log tail:" >&2
    sed -n '1,80p' "$E2E_TMP/server.log" >&2 || true
    exit 1
fi
echo ">>> MCP E2E PASS: registry, tools, prompts, and lazy VFS resources worked over real HTTP"
