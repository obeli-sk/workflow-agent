#!/usr/bin/env bash

# End-to-end coverage for per-script interrupts and the composer's turn stop:
#   1. an operator stop through the webhook API on a direct-shell script
#      (exit 130, interrupted=operator), with the session taking further
#      input afterward;
#   2. a model-supplied timeout unwound by the watchdog through a canned LLM
#      endpoint (exit 124, interrupted=timeout), with the model reacting in a
#      final response;
#   3. an operator stop of the agent loop itself (composer's stop control)
#      while the model is mid-turn against a canned LLM that never ends the
#      turn on its own, verifying the turn ends deterministically and the
#      session takes further input afterward.
# Each suite runs against its own isolated, throwaway obelisk server.
# Usage: test-e2e-interrupt.sh [rs|js]  (default rs)

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
source "$ROOT/scripts/e2e-lib.sh"

BACKEND="${1:-rs}"
PORT_OFFSET=$(e2e_backend_port_offset "$BACKEND")
API_PORT=$((28019 + PORT_OFFSET))
EXTERNAL_PORT=$((28094 + PORT_OFFSET))
LLM_PORT=$((28095 + PORT_OFFSET))
e2e_init "interrupt-e2e-$BACKEND" "$API_PORT" "$EXTERNAL_PORT" "e2e-interrupt-token"
export OBELISK_API_URL="$E2E_API_URL"
export OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:${API_PORT}"
unset MCP_SERVER_TOKEN
export AGENT_MODELS='[{"id":"fake","label":"Fake","api_type":"openai-chat-completions"},{"id":"fake-loop","label":"Fake Loop","api_type":"openai-chat-completions"}]'
export LLM_BASE_URL="http://127.0.0.1:${LLM_PORT}"

node scripts/e2e-llm-server.mjs "$LLM_PORT" >"$E2E_TMP/llm.log" 2>&1 &
E2E_LLM_PID=$!
cleanup() {
    kill "$E2E_LLM_PID" 2>/dev/null || true
    e2e_cleanup
}
trap cleanup EXIT
llm_listening() { grep -q "fake llm listening" "$E2E_TMP/llm.log"; }
e2e_wait_until llm_listening || { echo "fake llm did not start: $(cat "$E2E_TMP/llm.log")" >&2; exit 1; }

e2e_select_backend "$BACKEND"
DEPLOY="$ROOT/.e2e-interrupt-deployment-$BACKEND.toml"
e2e_patch_workflow_manifest "$DEPLOY"
e2e_start_server "$DEPLOY"

RUN_FFQN="obelisk-agent:workflow/workflow.run-cancellable"
UI_BASE="http://127.0.0.1:${EXTERNAL_PORT}"
run_detail() {
    curl --fail --silent --show-error "$UI_BASE/api/runs/$1" 2>&1
}

# Fetches a run's projection into PROJECTION and pipes it to an e2e-json.js check.
projection_check() {
    local session_id="$1"
    shift
    PROJECTION="$(run_detail "$session_id")" \
        && node scripts/e2e-json.js "$@" <<<"$PROJECTION" >/dev/null 2>&1
}

# Polls SUBJECT_ID's projection until the checker passes; PROJECTION keeps that snapshot.
wait_for() {
    local description="$1"
    shift
    e2e_wait_until projection_check "$SUBJECT_ID" "$@" || {
        echo "$description was not projected in time: $PROJECTION" >&2
        exit 1
    }
}

echo ">>> scenario 1: operator interrupt on a direct-shell script"
SESSION_ID="$("$OBELISK" generate execution-id)"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$SESSION_ID" "$RUN_FFQN" \
    '["", null, null, null, null]'
INJECTION_ID="$(e2e_take_offer "$SESSION_ID")"

curl --fail --silent --show-error \
    -H 'content-type: application/json' \
    -d "$(node scripts/e2e-json.js shell-input "$INJECTION_ID" shell-int-1 \
        'echo before-stop; sleep 30; echo unreachable')" \
    "$UI_BASE/api/input/$SESSION_ID" >/dev/null

SUBJECT_ID="$SESSION_ID"
wait_for "interrupt offer" check-interrupt-offer shell-int-1
INTERRUPT_OFFER="$(node scripts/e2e-json.js interrupt-offer shell-int-1 <<<"$PROJECTION")"

curl --fail --silent --show-error \
    -H 'content-type: application/json' \
    -d "{\"offer_id\":\"$INTERRUPT_OFFER\"}" \
    "$UI_BASE/api/interrupt/$SESSION_ID" >/dev/null

wait_for "operator interrupt outcome" \
    check-shell-interrupted shell-int-1 130 operator
echo ">>> operator interrupt E2E PASS: script stopped at exit 130 with output preserved"

# The session itself survived: it takes and completes another command.
INJECTION_ID="$(e2e_take_offer "$SESSION_ID")"
curl --fail --silent --show-error \
    -H 'content-type: application/json' \
    -d "$(node scripts/e2e-json.js shell-input "$INJECTION_ID" shell-int-2 'echo still-alive')" \
    "$UI_BASE/api/input/$SESSION_ID" >/dev/null
wait_for "follow-up command completion" check-shell-event-done shell-int-2
ALIVE_OUT="$(node scripts/e2e-json.js shell-event-stdout shell-int-2 <<<"$PROJECTION")"
[[ "$ALIVE_OUT" == "still-alive" ]] || {
    echo "follow-up output wrong: $ALIVE_OUT" >&2
    exit 1
}
"$OBELISK" execution cancel -a "$E2E_API_URL" "$SESSION_ID" >/dev/null || true
echo ">>> session survival E2E PASS"

echo ">>> scenario 2: model-supplied timeout through the canned LLM"
TIMEOUT_SESSION="$("$OBELISK" generate execution-id)"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$TIMEOUT_SESSION" "$RUN_FFQN" \
    '["please test timeouts", "fake", null, null, null]'
SUBJECT_ID="$TIMEOUT_SESSION"
wait_for "watchdog timeout tool result" \
    check-tool-result-interrupted call-timeout-1 124 timeout
wait_for "model reaction after the timeout" \
    check-final-reply "timeout scenario complete"
"$OBELISK" execution cancel -a "$E2E_API_URL" "$TIMEOUT_SESSION" >/dev/null || true
echo ">>> watchdog timeout E2E PASS: exit 124 surfaced to the model, turn ended cleanly"

echo ">>> scenario 3: composer stop of the agent loop mid-turn"
LOOP_SESSION="$("$OBELISK" generate execution-id)"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$LOOP_SESSION" "$RUN_FFQN" \
    '["please loop", "fake-loop", null, null, null]'
LOOP_OFFER="$(e2e_take_offer "$LOOP_SESSION")"
SUBJECT_ID="$LOOP_SESSION"
wait_for "first loop tool result" check-tool-result-ok call-loop

# Fake-loop holds every later completion, so this interrupt lands while one is in flight.
curl --fail --silent --show-error \
    -H 'content-type: application/json' \
    -d "{\"offer_id\":\"$LOOP_OFFER\",\"input\":{\"interrupt\":{\"id\":\"interrupt-e2e-1\"}}}" \
    "$UI_BASE/api/input/$LOOP_SESSION" >/dev/null

wait_for "operator turn stop outcome" \
    check-agent-error "Turn stopped by user request"
curl --fail --silent --show-error -X POST "$LLM_BASE_URL/release"
echo ">>> composer stop E2E PASS: the agent-loop turn stopped mid-iteration"

# The session survived: it takes and completes another command afterward.
FOLLOWUP_OFFER="$(e2e_take_offer "$LOOP_SESSION")"
curl --fail --silent --show-error \
    -H 'content-type: application/json' \
    -d "$(node scripts/e2e-json.js shell-input "$FOLLOWUP_OFFER" shell-loop-followup 'echo still-alive-loop')" \
    "$UI_BASE/api/input/$LOOP_SESSION" >/dev/null
wait_for "follow-up command completion after stop" check-shell-event-done shell-loop-followup
FOLLOWUP_OUT="$(node scripts/e2e-json.js shell-event-stdout shell-loop-followup <<<"$PROJECTION")"
[[ "$FOLLOWUP_OUT" == "still-alive-loop" ]] || {
    echo "follow-up output wrong after composer stop: $FOLLOWUP_OUT" >&2
    exit 1
}
e2e_verify_replay_parity "$BACKEND" "$DEPLOY" "$LOOP_SESSION"

"$OBELISK" execution cancel -a "$E2E_API_URL" "$LOOP_SESSION" >/dev/null || true
echo ">>> session survival after composer stop E2E PASS"

echo ">>> interrupt E2E SUITE PASS"
