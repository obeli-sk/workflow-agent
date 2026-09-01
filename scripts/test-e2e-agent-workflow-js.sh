#!/usr/bin/env bash
# Smoke-tests the JS workflow backend (workflow/workflow-js) against the same
# session protocol the Rust backend's test-e2e-agent-workflow.sh exercises:
# a direct shell turn through the idle input offer, and a prompt-driven turn
# that reaches obelisk-agent:llm/chat.completion and surfaces its recoverable
# config error. Phase 1 has no ask-user/programs/mounts yet (see
# docs/js-backend-migration.md), so this is a strict subset of the Rust
# suite's coverage, not a replacement for it.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
source "$ROOT/scripts/e2e-lib.sh"

e2e_init "agent-workflow-js-e2e" 28017 28092 "e2e-agent-workflow-js-token"
export OBELISK_API_URL="$E2E_API_URL"
export OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:28017"
export MCP_SERVER_TOKEN=""
export GITHUB_TOKEN=""
export AGENT_MODELS="[]"

e2e_build_component "workflow/workflow-rs" "workflow_agent_rs.wasm"
DEPLOY="$ROOT/.e2e-agent-js-deployment.toml"
e2e_patch_workflow_manifest "$DEPLOY"
e2e_start_server "$DEPLOY"

RUN_FFQN="obelisk-agent:workflow-js/workflow.run-cancellable"
run_detail() {
    curl --fail --silent --show-error "http://127.0.0.1:28092/api/runs/$1" 2>&1
}

echo ">>> creating an empty JS-backend session and running one direct shell turn"
SESSION_ID="$("$OBELISK" generate execution-id)"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$SESSION_ID" "$RUN_FFQN" \
    '["", null, null, null, null]'

SECONDS=0
while true; do
    if ! SESSION_PROJECTION="$(run_detail "$SESSION_ID")"; then
        [[ $SECONDS -ge 30 ]] && { echo "empty session detail unavailable: $SESSION_PROJECTION" >&2; exit 1; }
        sleep 1
        continue
    fi
    INJECTION_ID="$(node scripts/e2e-json.js input-offer-id <<<"$SESSION_PROJECTION")"
    [[ -n "$INJECTION_ID" ]] && break
    [[ $SECONDS -ge 30 ]] && { echo "empty session did not publish its input offer: $SESSION_PROJECTION" >&2; exit 1; }
    sleep 1
done
RESPONSE_CURSOR="$(node scripts/e2e-json.js response-cursor <<<"$SESSION_PROJECTION")"

curl --fail --silent --show-error \
    -H 'content-type: application/json' \
    -d "{\"offer_id\":\"$INJECTION_ID\",\"input\":{\"shell\":{\"id\":\"shell-e2e-1\",\"script\":\"sleep 0.05 && which grep && echo shell-ok\",\"stdin\":\"\"}}}" \
    "http://127.0.0.1:28092/api/input/$SESSION_ID" >/dev/null

SECONDS=0
SHELL_NOTIFICATION=""
while true; do
    SESSION_EXECUTIONS="$("$OBELISK" execution list -j -a "$E2E_API_URL" \
        -e "$SESSION_ID" --show-derived --limit 100)"
    while IFS= read -r RECORD_ID; do
        [[ -n "$RECORD_ID" ]] || continue
        CANDIDATE="$("$OBELISK" execution result -j -a "$E2E_API_URL" "$RECORD_ID" 2>/dev/null)" || continue
        if node scripts/e2e-json.js check-shell-notification <<<"$CANDIDATE" 2>/dev/null; then
            SHELL_NOTIFICATION="$CANDIDATE"
            break
        fi
    done < <(node scripts/e2e-json.js execution-ids \
        "obelisk-agent:stub/stub.record-output" <<<"$SESSION_EXECUTIONS")
    [[ -n "$SHELL_NOTIFICATION" ]] && break
    [[ $SECONDS -ge 30 ]] && { echo "shell turn did not complete correctly: $SESSION_EXECUTIONS" >&2; exit 1; }
    sleep 1
done
node scripts/e2e-json.js check-shell-notification <<<"$SHELL_NOTIFICATION"
SHELL_PROJECTION="$(curl --fail --silent \
    "http://127.0.0.1:28092/api/runs/$SESSION_ID?workflow_id=$SESSION_ID&response_cursor=$RESPONSE_CURSOR")"
node scripts/e2e-json.js check-shell-projection <<<"$SHELL_PROJECTION"
echo ">>> shell-only E2E PASS: the JS interpreter ran a real script through the session protocol"
"$OBELISK" execution cancel -a "$E2E_API_URL" "$SESSION_ID" >/dev/null || true

EXEC_ID="$("$OBELISK" generate execution-id)"
echo ">>> submitting $RUN_FFQN as $EXEC_ID"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$EXEC_ID" "$RUN_FFQN" \
    '["hello from the e2e test", null, null, null, null]'

EXPECT="AGENT_MODELS must be a non-empty JSON array"
echo ">>> waiting for the recoverable LLM configuration error"
SECONDS=0
while true; do
    if ! ERROR_PROJECTION="$(run_detail "$EXEC_ID")"; then
        [[ $SECONDS -ge 30 ]] && { echo "agent error detail unavailable: $ERROR_PROJECTION" >&2; exit 1; }
        sleep 1
        continue
    fi
    if node scripts/e2e-json.js check-agent-error "$EXPECT" <<<"$ERROR_PROJECTION" 2>/dev/null; then
        break
    fi
    [[ $SECONDS -ge 30 ]] && { echo "agent error was not projected or the session did not recover: $ERROR_PROJECTION" >&2; exit 1; }
    sleep 1
done
echo ">>> E2E PASS: the JS backend's LLM-completion racing surfaced the config error and returned to idle"
"$OBELISK" execution cancel -a "$E2E_API_URL" "$EXEC_ID" >/dev/null || true
