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
run_detail() {
    curl --fail --silent --show-error "http://127.0.0.1:28091/api/runs/$1" 2>&1
}

echo ">>> checking ask-user lifecycle through the session projection"
ASK_SESSION_ID="$("$OBELISK" generate execution-id)"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$ASK_SESSION_ID" "$RUN_FFQN" \
    '["", null, null, null]'

SECONDS=0
while true; do
    if ! ASK_PROJECTION="$(run_detail "$ASK_SESSION_ID")"; then
        [[ $SECONDS -ge 30 ]] && { echo "ask-user session detail unavailable: $ASK_PROJECTION" >&2; exit 1; }
        sleep 1
        continue
    fi
    ASK_OFFER_ID="$(node scripts/e2e-json.js input-offer-id <<<"$ASK_PROJECTION")"
    [[ -n "$ASK_OFFER_ID" ]] && break
    [[ $SECONDS -ge 30 ]] && { echo "ask-user session did not publish its input offer: $ASK_PROJECTION" >&2; exit 1; }
    sleep 1
done
ASK_SCRIPT="obelisk call obelisk-agent:stub/stub.ask-user '[\"Continue?\"]'"
ASK_BODY="$(node scripts/e2e-json.js shell-input "$ASK_OFFER_ID" shell-e2e-ask "$ASK_SCRIPT")"
curl --fail --silent --show-error \
    -H 'content-type: application/json' \
    -d "$ASK_BODY" \
    "http://127.0.0.1:28091/api/input/$ASK_SESSION_ID" >/dev/null

SECONDS=0
while true; do
    if ! ASK_PROJECTION="$(run_detail "$ASK_SESSION_ID")"; then
        [[ $SECONDS -ge 30 ]] && { echo "ask-user request detail unavailable: $ASK_PROJECTION" >&2; exit 1; }
        sleep 1
        continue
    fi
    if node scripts/e2e-json.js check-human-input-request <<<"$ASK_PROJECTION" 2>/dev/null; then
        break
    fi
    [[ $SECONDS -ge 30 ]] && { echo "ask-user request was not projected: $ASK_PROJECTION" >&2; exit 1; }
    sleep 1
done
ASK_ID="$(node scripts/e2e-json.js pending-ask-id <<<"$ASK_PROJECTION")"
curl --fail --silent --show-error \
    -H 'content-type: application/json' \
    -d '{"answer":"yes"}' \
    "http://127.0.0.1:28091/api/answer/$ASK_ID" >/dev/null

SECONDS=0
while true; do
    if ! ASK_PROJECTION="$(run_detail "$ASK_SESSION_ID")"; then
        [[ $SECONDS -ge 30 ]] && { echo "ask-user resolution detail unavailable: $ASK_PROJECTION" >&2; exit 1; }
        sleep 1
        continue
    fi
    if node scripts/e2e-json.js check-human-input-resolved <<<"$ASK_PROJECTION" 2>/dev/null; then
        break
    fi
    [[ $SECONDS -ge 30 ]] && { echo "ask-user resolution was not projected: $ASK_PROJECTION" >&2; exit 1; }
    sleep 1
done
echo ">>> ask-user projection E2E PASS"
"$OBELISK" execution cancel -a "$E2E_API_URL" "$ASK_SESSION_ID" >/dev/null || true

echo ">>> creating an empty session and running one direct shell turn"
SESSION_ID="$("$OBELISK" generate execution-id)"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$SESSION_ID" "$RUN_FFQN" \
    '["", null, null, null]'

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
    -d "{\"offer_id\":\"$INJECTION_ID\",\"input\":{\"shell\":{\"id\":\"shell-e2e-1\",\"script\":\"which curl && curl --version\",\"stdin\":\"\"}}}" \
    "http://127.0.0.1:28091/api/input/$SESSION_ID" >/dev/null

# The session emits one `record-output` stub per event of any kind
# (session_started, input_offered, shell_output, ...), so we cannot pick the
# shell turn's notification by list order: the next turn's input_offered record
# often lands first. Poll until the specific `shell_output` record for
# shell-e2e-1 is present, matching each record-output result in turn.
SECONDS=0
SHELL_NOTIFICATION=""
while true; do
    SESSION_EXECUTIONS="$("$OBELISK" execution list -j -a "$E2E_API_URL" \
        -e "$SESSION_ID" --show-derived --limit 100)"
    if node scripts/e2e-json.js check-shell-session <<<"$SESSION_EXECUTIONS"; then
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
    fi
    [[ $SECONDS -ge 30 ]] && { echo "shell turn did not complete correctly: $SESSION_EXECUTIONS" >&2; exit 1; }
    sleep 1
done
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
echo ">>> E2E PASS: the session surfaced the LLM configuration error and returned to idle"
"$OBELISK" execution cancel -a "$E2E_API_URL" "$EXEC_ID" >/dev/null || true
