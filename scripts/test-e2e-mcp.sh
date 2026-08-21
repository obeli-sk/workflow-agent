#!/usr/bin/env bash
#
# End-to-end test for stateless MCP support (docs/mcp.md). Runs the self-contained
# sample server (examples/stateless-mcp-server.mjs) in a stock node container,
# deploys one MCP activity block pointed at it, opens a session, and drives the
# shell command surface and lazily mounted resources through one user shell
# turn, asserting the rendered output.
#
# Requires docker or podman. When neither is present the test SKIPs (exit 0) so
# environments without a container runtime stay green; the skip is logged.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

# --- container runtime --------------------------------------------------------
CRT=""
for candidate in docker podman; do
    if command -v "$candidate" >/dev/null 2>&1; then
        CRT="$candidate"
        break
    fi
done
if [[ -z "$CRT" ]]; then
    echo ">>> MCP E2E SKIP: no docker/podman on PATH (container runtime required)" >&2
    exit 0
fi

source "$ROOT/scripts/e2e-lib.sh"

MCP_PORT="${MCP_PORT:-1071}"
MCP_IMAGE="${MCP_NODE_IMAGE:-node:22-alpine}"
MCP_CONTAINER="wfa-e2e-mcp-$$"
MCP_URL="http://127.0.0.1:${MCP_PORT}/mcp"
SERVER_NAME="obelisk-e2e"

e2e_init "mcp-e2e" 28116 28191 "e2e-mcp-token"
export OBELISK_API_URL="$E2E_API_URL"
export OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:28116"
export AGENT_MODELS="[]"
# The workflow discovers MCP servers from MCP_SERVERS_JSON (the mcp_discover
# activity), overriding the manifest default so this run wires only the injected
# obelisk-e2e server. Empty MCP_SERVER_TOKEN keeps the manifest's sample
# obelisk-local block keyless so it deploys without a real secret (it is never
# invoked here, since discovery does not return it).
export MCP_SERVERS_JSON="[{\"name\":\"${SERVER_NAME}\",\"ffqn\":\"obelisk-agent:mcp/server.${SERVER_NAME}\"}]"
export MCP_SERVER_TOKEN=""

# Extend the library cleanup to also remove the MCP container.
mcp_cleanup() {
    "$CRT" logs "$MCP_CONTAINER" >"$E2E_TMP/mcp-server.log" 2>&1 || true
    "$CRT" rm -f "$MCP_CONTAINER" >/dev/null 2>&1 || true
    e2e_cleanup
}
trap mcp_cleanup EXIT

echo ">>> starting stateless MCP server ($MCP_IMAGE) on :${MCP_PORT}"
"$CRT" run -d --name "$MCP_CONTAINER" \
    -p "127.0.0.1:${MCP_PORT}:${MCP_PORT}" \
    -e "PORT=${MCP_PORT}" \
    -v "$ROOT/examples/stateless-mcp-server.mjs:/srv/server.mjs:ro" \
    "$MCP_IMAGE" node /srv/server.mjs >/dev/null

# The nix devshell ships node but not curl, so probe readiness with node.
http_ok() {
    node -e 'const http=require("http");const r=http.get(process.argv[1],s=>{s.resume();process.exit(s.statusCode===200?0:1)});r.on("error",()=>process.exit(1))' "$1"
}
echo ">>> waiting for the MCP server to become ready"
waited=0
until http_ok "http://127.0.0.1:${MCP_PORT}/" 2>/dev/null; do
    if [[ $waited -ge 30 ]]; then
        echo "MCP server did not become ready; container log:" >&2
        "$CRT" logs "$MCP_CONTAINER" >&2 || true
        exit 1
    fi
    sleep 1
    ((waited += 1)) || true
done

# --- deployment: real manifest + one MCP block, keyless -----------------------
e2e_build_component "workflow/workflow-rs" "workflow_agent_rs.wasm"
DEPLOY="$ROOT/.e2e-mcp-deployment.toml"
e2e_patch_workflow_manifest "$DEPLOY"
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
max_retries = 0
env_vars = [{ key = "MCP_SERVER_URL", value = "${MCP_URL}" }]
[[activity_js.allowed_host]]
pattern = "http://127.0.0.1:${MCP_PORT}"
methods = ["POST"]
EOF

# server.toml needs the matching outbound-host grant (keyless).
SERVER_CFG="$ROOT/.e2e-mcp-server.toml"
E2E_DEPLOYMENTS+=("$SERVER_CFG")
cp "$ROOT/server.toml" "$SERVER_CFG"
cat >> "$SERVER_CFG" <<EOF

# Injected by scripts/test-e2e-mcp.sh: keyless outbound grant for the MCP server.
[[outbound_http.allowed_host]]
pattern = "http://127.0.0.1:${MCP_PORT}"
methods = ["POST"]
EOF
export E2E_SERVER_CONFIG="$SERVER_CFG"

e2e_start_server "$DEPLOY"

# --- open a session and drive one MCP shell turn ------------------------------
RUN_FFQN="obelisk-agent:workflow/workflow.run-cancellable"
SESSION_ID="$("$OBELISK" generate execution-id)"
echo ">>> creating an empty session as $SESSION_ID"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$SESSION_ID" "$RUN_FFQN" \
    '["", null, null, null]'

echo ">>> waiting for the session input offer"
SECONDS=0
while true; do
    SESSION_EXECUTIONS="$("$OBELISK" execution list -j -a "$E2E_API_URL" \
        -e "$SESSION_ID" --show-derived --limit 100)"
    INJECTION_ID="$(node scripts/e2e-json.js execution-id \
        "obelisk-agent:stub/stub.injection" <<<"$SESSION_EXECUTIONS")"
    [[ -n "$INJECTION_ID" ]] && break
    [[ $SECONDS -ge 30 ]] && { echo "session did not expose its input offer: $SESSION_EXECUTIONS" >&2; exit 1; }
    sleep 1
done

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
SECONDS=0
STDOUT=""
while true; do
    SESSION_EXECUTIONS="$("$OBELISK" execution list -j -a "$E2E_API_URL" \
        -e "$SESSION_ID" --show-derived --limit 100)"
    if node scripts/e2e-json.js has-execution \
        "obelisk-agent:stub/stub.record-output" <<<"$SESSION_EXECUTIONS"; then
        while IFS= read -r RECORD_ID; do
            [[ -n "$RECORD_ID" ]] || continue
            RECORD_RESULT="$("$OBELISK" execution result -j -a "$E2E_API_URL" "$RECORD_ID" 2>/dev/null || true)"
            if [[ -n "$RECORD_RESULT" ]]; then
                STDOUT="$(node scripts/e2e-json.js shell-stdout <<<"$RECORD_RESULT" 2>/dev/null || true)"
                [[ -n "$STDOUT" ]] && break 2
            fi
        done < <(node scripts/e2e-json.js execution-ids \
            "obelisk-agent:stub/stub.record-output" <<<"$SESSION_EXECUTIONS")
    fi
    [[ $SECONDS -ge 30 ]] && { echo "shell turn did not record output: $SESSION_EXECUTIONS" >&2; exit 1; }
    sleep 1
done

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
