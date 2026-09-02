#!/usr/bin/env bash
# Smoke-tests the JS workflow backend (workflow/workflow-js) against the same
# session protocol the Rust backend's test-e2e-agent-workflow.sh exercises:
# direct shell turns through the idle input offer (including the Phase 3
# obelisk/mount custom commands), session rename at creation, a `chat create`
# self-referential child submit (Phase 5), and a prompt-driven turn that
# reaches obelisk-agent:llm/chat.completion and surfaces its recoverable
# config error. Phase 4's ask-user has no JS coverage yet (see
# docs/js-backend-migration.md), so this is still a subset of the Rust
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

# Waits for SESSION_ID's next input offer, submits SCRIPT as a direct shell
# turn under that offer, waits for its record-output notification, and
# leaves the notification's stdout in SHELL_STDOUT (stderr/nonzero exit
# print to this process's stderr via `shell-stdout`, so a script bug is
# visible in the log rather than silently swallowed).
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
    # Cursor position *before* this turn's events, so the projection fetched
    # after the turn completes can diff against it (matches how the caller
    # queries /api/runs/...&response_cursor=...).
    RESPONSE_CURSOR="$(node scripts/e2e-json.js response-cursor <<<"$session_projection")"

    curl --fail --silent --show-error \
        -H 'content-type: application/json' \
        -d "{\"offer_id\":\"$injection_id\",\"input\":{\"shell\":{\"id\":\"$shell_id\",\"script\":$(printf '%s' "$script" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))'),\"stdin\":\"\"}}}" \
        "http://127.0.0.1:28092/api/input/$SESSION_ID" >/dev/null

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

echo ">>> creating an empty JS-backend session"
SESSION_ID="$("$OBELISK" generate execution-id)"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$SESSION_ID" "$RUN_FFQN" \
    '["", null, null, null, null]'

echo ">>> running a direct shell turn"
run_shell_turn "shell-e2e-1" "sleep 0.05 && which grep && echo shell-ok"
SHELL_PROJECTION="$(curl --fail --silent \
    "http://127.0.0.1:28092/api/runs/$SESSION_ID?workflow_id=$SESSION_ID&response_cursor=$RESPONSE_CURSOR")"
node scripts/e2e-json.js check-shell-projection <<<"$SHELL_PROJECTION"
echo ">>> shell-only E2E PASS: the JS interpreter ran a real script through the session protocol"

echo ">>> running the Phase 3 obelisk/mount custom commands"
run_shell_turn "shell-e2e-2" "mount && echo --- && obelisk functions list --help"
if [[ "$SHELL_STDOUT" != *"Network-backed mounts"* ]]; then
    echo "mount command did not print the expected header: $SHELL_STDOUT" >&2
    exit 1
fi
if [[ "$SHELL_STDOUT" != *"/workspace/components"* ]]; then
    echo "mount command did not list the components mount: $SHELL_STDOUT" >&2
    exit 1
fi
if [[ "$SHELL_STDOUT" != *"Usage: obelisk functions"* ]]; then
    echo "obelisk functions --help did not print its usage: $SHELL_STDOUT" >&2
    exit 1
fi
echo ">>> obelisk/mount E2E PASS: the ported obelisk-pack.js command runs for real inside Boa"
"$OBELISK" execution cancel -a "$E2E_API_URL" "$SESSION_ID" >/dev/null || true

echo ">>> creating a JS-backend session with an initial name"
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

echo ">>> creating a JS-backend session to exercise 'chat create' (self-referential child submit)"
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
echo ">>> chat create E2E PASS: the child session runs under the JS backend and reports its --name"
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
echo ">>> E2E PASS: the JS backend's LLM-completion racing surfaced the config error and returned to idle"
"$OBELISK" execution cancel -a "$E2E_API_URL" "$EXEC_ID" >/dev/null || true
