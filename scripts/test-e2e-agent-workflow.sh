#!/usr/bin/env bash

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
source "$ROOT/scripts/e2e-lib.sh"

e2e_init "agent-workflow-e2e" 28016 28091 "e2e-agent-workflow-token"
export OBELISK_API_URL="$E2E_API_URL"
export OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:28016"
export AGENT_MODELS="[]"

e2e_build_component "workflow/workflow-rs" "workflow_agent_rs.wasm"
DEPLOY="$ROOT/.e2e-agent-deployment.toml"
e2e_patch_workflow_manifest "$DEPLOY"
e2e_start_server "$DEPLOY"

RUN_FFQN="obelisk-agent:workflow/workflow.run-cancellable"
echo ">>> creating an empty session and running one direct shell turn"
SESSION_ID="$("$OBELISK" generate execution-id)"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$SESSION_ID" "$RUN_FFQN" \
    '["", null, null, null]'

SECONDS=0
while true; do
    SESSION_PROJECTION="$(curl --fail --silent "http://127.0.0.1:28091/api/runs/$SESSION_ID")"
    INJECTION_ID="$(node scripts/e2e-json.js input-offer-id <<<"$SESSION_PROJECTION")"
    [[ -n "$INJECTION_ID" ]] && break
    [[ $SECONDS -ge 30 ]] && { echo "empty session did not publish its input offer: $SESSION_PROJECTION" >&2; exit 1; }
    sleep 1
done
RESPONSE_CURSOR="$(node scripts/e2e-json.js response-cursor <<<"$SESSION_PROJECTION")"

curl --fail --silent --show-error \
    -H 'content-type: application/json' \
    -d "{\"offer_id\":\"$INJECTION_ID\",\"input\":{\"shell\":{\"id\":\"shell-e2e-1\",\"script\":\"which curl && curl --version\",\"stdin\":\"\"}}}" \
    "http://127.0.0.1:28091/api/input/$SESSION_ID" >/dev/null

SECONDS=0
while true; do
    SESSION_EXECUTIONS="$("$OBELISK" execution list -j -a "$E2E_API_URL" \
        -e "$SESSION_ID" --show-derived --limit 100)"
    if node scripts/e2e-json.js has-execution \
        "obelisk-agent:agent/session.record-output" <<<"$SESSION_EXECUTIONS" \
        && node scripts/e2e-json.js check-shell-session <<<"$SESSION_EXECUTIONS"; then
        break
    fi
    [[ $SECONDS -ge 30 ]] && { echo "shell turn did not complete correctly: $SESSION_EXECUTIONS" >&2; exit 1; }
    sleep 1
done
SHELL_OUTPUT_ID="$(node scripts/e2e-json.js execution-id \
    "obelisk-agent:agent/session.record-output" <<<"$SESSION_EXECUTIONS")"
SHELL_NOTIFICATION="$("$OBELISK" execution result -j -a "$E2E_API_URL" "$SHELL_OUTPUT_ID")"
node scripts/e2e-json.js check-shell-notification <<<"$SHELL_NOTIFICATION"
SHELL_PROJECTION="$(curl --fail --silent \
    "http://127.0.0.1:28091/api/runs/$SESSION_ID?workflow_id=$SESSION_ID&response_cursor=$RESPONSE_CURSOR")"
node scripts/e2e-json.js check-shell-projection <<<"$SHELL_PROJECTION"
echo ">>> shell-only E2E PASS: curl was discovered and invoked without starting the agent"
"$OBELISK" execution cancel -a "$E2E_API_URL" "$SESSION_ID" >/dev/null || true

EXEC_ID="$("$OBELISK" generate execution-id)"
echo ">>> submitting $RUN_FFQN as $EXEC_ID"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$EXEC_ID" "$RUN_FFQN" \
    '["hello from the e2e test", null, null, null]'

echo ">>> fetching result"
RESULT="$("$OBELISK" execution result --follow -j -a "$E2E_API_URL" "$EXEC_ID")"
echo "$RESULT"

EXPECT="AGENT_MODELS must be a non-empty JSON array"
if grep -q "$EXPECT" <<<"$RESULT"; then
    echo ">>> E2E PASS: the workflow surfaced the LLM activity's expected configuration error"
else
    echo ">>> E2E FAIL: expected '$EXPECT' in result" >&2
    exit 1
fi
