#!/usr/bin/env bash
# Exercises the session-workflow protocol (ask-user lifecycle, a direct shell
# turn, the obelisk/mount custom commands, at-creation rename, a
# self-referential `chat create` child submit, and a prompt-driven turn
# reaching the LLM endpoint) against whichever implementation backs
# obelisk-agent:workflow/workflow.run-cancellable.
# Usage: test-e2e-agent-workflow.sh [rs|js]  (default rs)

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
source "$ROOT/scripts/e2e-lib.sh"

BACKEND="${1:-rs}"
e2e_init "agent-workflow-e2e-$BACKEND" 28016 28091 "e2e-agent-workflow-token"
export OBELISK_API_URL="$E2E_API_URL"
export OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:28016"
# server.toml's [secrets] requires every named var to exist; empty is fine.
export MCP_SERVER_TOKEN=""
export GITHUB_TOKEN="${GITHUB_TOKEN:-}"
export AGENT_MODELS="[]"

e2e_select_backend "$BACKEND"
export APPS_JSON='[{"name":"components","repo":"components","description":"E2E GitHub mount"}]'
DEPLOY="$ROOT/.e2e-agent-deployment.toml"
e2e_patch_workflow_manifest "$DEPLOY"
e2e_start_server "$DEPLOY"

RUN_FFQN="obelisk-agent:workflow/workflow.run-cancellable"
run_detail() {
    curl --fail --silent --show-error "http://127.0.0.1:28091/api/runs/$1" 2>&1
}

# Waits for SESSION_ID's next input offer, submits SCRIPT as a direct shell
# turn under it, waits for its record-output notification, and leaves the
# notification's stdout in SHELL_STDOUT.
run_shell_turn() {
    local shell_id="$1" script="$2"
    SECONDS=0
    local session_projection injection_id
    while true; do
        if session_projection="$(run_detail "$SESSION_ID")"; then
            injection_id="$(node scripts/e2e-json.js input-offer-id <<<"$session_projection")"
            [[ -n "$injection_id" ]] && break
        fi
        [[ $SECONDS -ge 30 ]] && { echo "session did not publish an input offer: $session_projection" >&2; exit 1; }
        sleep 1
    done
    curl --fail --silent --show-error \
        -H 'content-type: application/json' \
        -d "{\"offer_id\":\"$injection_id\",\"input\":{\"shell\":{\"id\":\"$shell_id\",\"script\":$(printf '%s' "$script" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))'),\"stdin\":\"\"}}}" \
        "http://127.0.0.1:28091/api/input/$SESSION_ID" >/dev/null

    SECONDS=0
    local notification=""
    while true; do
        local session_executions
        session_executions="$("$OBELISK" execution list -j -a "$E2E_API_URL" -e "$SESSION_ID" --show-derived --limit 100)"
        while IFS= read -r record_id; do
            [[ -n "$record_id" ]] || continue
            local candidate
            candidate="$("$OBELISK" execution result -j -a "$E2E_API_URL" "$record_id" 2>/dev/null)" || continue
            if node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8'))?.ok?.shell_output; process.exit(r?.id===process.argv[1]?0:1)" "$shell_id" <<<"$candidate" 2>/dev/null; then
                notification="$candidate"
                break
            fi
        done < <(node scripts/e2e-json.js execution-ids "obelisk-agent:stub/stub.record-output" <<<"$session_executions")
        [[ -n "$notification" ]] && break
        [[ $SECONDS -ge 30 ]] && { echo "shell turn $shell_id did not complete: $session_executions" >&2; exit 1; }
        sleep 1
    done
    SHELL_STDOUT="$(node scripts/e2e-json.js shell-stdout <<<"$notification")"
}

echo ">>> checking ask-user lifecycle through the session projection"
ASK_SESSION_ID="$("$OBELISK" generate execution-id)"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$ASK_SESSION_ID" "$RUN_FFQN" \
    '["", null, null, null, null]'

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

# The next input_offer is published after the record-output stub, so poll until it settles.
SECONDS=0
while true; do
    SHELL_PROJECTION="$(curl --fail --silent \
        "http://127.0.0.1:28091/api/runs/$SESSION_ID?workflow_id=$SESSION_ID&response_cursor=$RESPONSE_CURSOR")"
    node scripts/e2e-json.js check-shell-projection <<<"$SHELL_PROJECTION" 2>/dev/null && break
    [[ $SECONDS -ge 30 ]] && { node scripts/e2e-json.js check-shell-projection <<<"$SHELL_PROJECTION"; exit 1; }
    sleep 1
done
echo ">>> shell-only E2E PASS: curl was registered and invoked without starting the agent"

echo ">>> running the obelisk/mount custom commands"
run_shell_turn "shell-e2e-2" "mount && cat /workspace/apps/components/README.md && echo --- && obelisk functions list --help"
if [[ "$SHELL_STDOUT" != *"Network-backed mounts"* ]]; then
    echo "mount command did not print the expected header: $SHELL_STDOUT" >&2
    exit 1
fi
if [[ ! "$SHELL_STDOUT" =~ obeli-sk/components@[0-9a-f]{40} ]]; then
    echo "mount command did not show the resolved components commit: $SHELL_STDOUT" >&2
    exit 1
fi
if [[ "$SHELL_STDOUT" != *"# Obelisk Components"* ]]; then
    echo "GitHub components mount did not read README.md: $SHELL_STDOUT" >&2
    exit 1
fi
if [[ "$SHELL_STDOUT" != *"Usage: obelisk functions"* ]]; then
    echo "obelisk functions --help did not print its usage: $SHELL_STDOUT" >&2
    exit 1
fi
echo ">>> obelisk/mount E2E PASS"
"$OBELISK" execution cancel -a "$E2E_API_URL" "$SESSION_ID" >/dev/null || true

echo ">>> creating a session with an initial name"
NAMED_SESSION_ID="$("$OBELISK" generate execution-id)"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$NAMED_SESSION_ID" "$RUN_FFQN" \
    '["", null, null, null, "e2e-rename-check"]'
SECONDS=0
while true; do
    NAME_PROJECTION="$(run_detail "$NAMED_SESSION_ID" || true)"
    if node -e "process.exit(JSON.parse(require('fs').readFileSync(0,'utf8')||'{}')?.name==='e2e-rename-check'?0:1)" <<<"$NAME_PROJECTION" 2>/dev/null; then
        break
    fi
    [[ $SECONDS -ge 30 ]] && { echo "session did not report its initial name: $NAME_PROJECTION" >&2; exit 1; }
    sleep 1
done
echo ">>> rename E2E PASS: the session-name join set published the at-creation name"
"$OBELISK" execution cancel -a "$E2E_API_URL" "$NAMED_SESSION_ID" >/dev/null || true

echo ">>> exercising 'chat create' (self-referential child submit)"
SESSION_ID="$("$OBELISK" generate execution-id)"
CHAT_SESSION_ID="$SESSION_ID"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$CHAT_SESSION_ID" "$RUN_FFQN" \
    '["", null, null, null, null]'
run_shell_turn "shell-e2e-3" "chat create --name e2e-chat-child hello from the e2e test"
CHILD_ID="$(printf '%s' "$SHELL_STDOUT" | tr -d '[:space:]')"
if [[ -z "$CHILD_ID" ]]; then
    echo "chat create did not print a child execution id: $SHELL_STDOUT" >&2
    exit 1
fi
echo ">>> chat create returned child execution id: $CHILD_ID"
SECONDS=0
while true; do
    if CHILD_PROJECTION="$(run_detail "$CHILD_ID")" && node -e "process.exit(JSON.parse(require('fs').readFileSync(0,'utf8')||'{}')?.name==='e2e-chat-child'?0:1)" <<<"$CHILD_PROJECTION" 2>/dev/null; then
        break
    fi
    [[ $SECONDS -ge 30 ]] && { echo "child session did not start or report its --name: $CHILD_PROJECTION" >&2; exit 1; }
    sleep 1
done
echo ">>> chat create E2E PASS: the self-referential child submit works and reports its --name"
"$OBELISK" execution cancel -a "$E2E_API_URL" "$CHILD_ID" >/dev/null || true
"$OBELISK" execution cancel -a "$E2E_API_URL" "$CHAT_SESSION_ID" >/dev/null || true

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
echo ">>> E2E PASS: the session surfaced the LLM configuration error and returned to idle"
"$OBELISK" execution cancel -a "$E2E_API_URL" "$EXEC_ID" >/dev/null || true
