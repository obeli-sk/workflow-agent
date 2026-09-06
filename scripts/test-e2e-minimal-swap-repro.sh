#!/usr/bin/env bash
# Minimal reproduction of the cross-backend live-swap NondeterminismDetected
# bug: an empty session, ONE direct shell turn ("which curl && curl
# --version"), then a live deployment swap to the other workflow backend.
# The auto-upgrade fails every time with "nondeterminism detected" - no
# ask-user, mount, ls, or LLM turn is needed, and no long session history:
# the mismatch is already present by durable-log version ~37 (see
# `obelisk execution events -j --from 0 --limit 100 $SESSION_ID` after this
# script fails, and look at the "n:user-1" / "n:session-events" join sets
# around there).
# Usage: test-e2e-minimal-swap-repro.sh [rs|js]  (default rs; swaps to the
# other backend)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
source "$ROOT/scripts/e2e-lib.sh"

BACKEND="${1:-rs}"
e2e_init "minimal-swap-repro-$BACKEND" 28022 28094 "minimal-swap-repro-token"
export OBELISK_API_URL="$E2E_API_URL"
export OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:28022"
# server.toml's [secrets] requires every named var to exist; empty is fine.
export MCP_SERVER_TOKEN=""
export GITHUB_TOKEN="${GITHUB_TOKEN:-}"
export AGENT_MODELS="[]"

e2e_select_backend "$BACKEND"
export APPS_JSON='[]'
DEPLOY="$ROOT/.minimal-swap-repro-deployment.toml"
e2e_patch_workflow_manifest "$DEPLOY"
e2e_start_server "$DEPLOY"

RUN_FFQN="obelisk-agent:workflow/workflow.run-cancellable"
run_detail() {
    curl --fail --silent --show-error "http://127.0.0.1:28094/api/runs/$1" 2>&1
}

wait_for_input_offer() {
    SECONDS=0
    local session_projection
    while true; do
        if session_projection="$(run_detail "$SESSION_ID")"; then
            CURRENT_INJECTION_ID="$(node scripts/e2e-json.js input-offer-id <<<"$session_projection")"
            [[ -n "$CURRENT_INJECTION_ID" ]] && break
        fi
        [[ $SECONDS -ge 30 ]] && { echo "session did not settle on a fresh input offer: $session_projection" >&2; exit 1; }
        sleep 1
    done
}

run_shell_turn() {
    local shell_id="$1" script="$2"
    wait_for_input_offer
    curl --fail --silent --show-error \
        -H 'content-type: application/json' \
        -d "{\"offer_id\":\"$CURRENT_INJECTION_ID\",\"input\":{\"shell\":{\"id\":\"$shell_id\",\"script\":$(printf '%s' "$script" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))'),\"stdin\":\"\"}}}" \
        "http://127.0.0.1:28094/api/input/$SESSION_ID" >/dev/null

    SECONDS=0
    local notification=""
    while true; do
        local session_executions
        session_executions="$("$OBELISK" execution list -j -a "$E2E_API_URL" -e "$SESSION_ID" --show-derived --limit 100)"
        while IFS= read -r record_id; do
            [[ -n "$record_id" ]] || continue
            local candidate
            candidate="$("$OBELISK" execution result -j -a "$E2E_API_URL" "$record_id" 2>/dev/null)" || continue
            if node -e "const list=JSON.parse(require('fs').readFileSync(0,'utf8'))?.ok??[]; const r=list.find((e)=>e?.shell_output)?.shell_output; process.exit(r?.id===process.argv[1]?0:1)" "$shell_id" <<<"$candidate" 2>/dev/null; then
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

echo ">>> creating an empty session ($BACKEND)"
SESSION_ID="$("$OBELISK" generate execution-id)"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$SESSION_ID" "$RUN_FFQN" \
    '["", null, null, null, null]'

run_shell_turn "shell-e2e-1" "which curl && curl --version"
echo ">>> first shell turn PASS"

echo ">>> live-swapping the blocked session to the other workflow backend"
wait_for_input_offer
case "$BACKEND" in
    rs) SWAP_BACKEND="js" ;;
    js) SWAP_BACKEND="rs" ;;
esac
e2e_select_backend "$SWAP_BACKEND"
SWAP_DEPLOY="$ROOT/.minimal-swap-repro-live-swap-${SWAP_BACKEND}.toml"
e2e_swap_workflow_manifest "$DEPLOY" "$SWAP_DEPLOY"
"$OBELISK" deployment apply "$SWAP_DEPLOY" -a "$E2E_API_URL" >/dev/null
run_shell_turn "shell-e2e-after-swap" "echo auto-upgrade-ran"
if [[ "$SHELL_STDOUT" != "auto-upgrade-ran" ]]; then
    echo "the swapped backend did not resume the session: $SHELL_STDOUT" >&2
    exit 1
fi
UPGRADE_EVENTS="$("$OBELISK" execution events -j -a "$E2E_API_URL" --from 0 --limit 500 "$SESSION_ID")"
if ! node -e '
    const events = JSON.parse(require("fs").readFileSync(0, "utf8")).events || [];
    const upgraded = events.some(({ event }) => {
        const outcome = event?.component_upgrade_finished?.outcome;
        return outcome?.type === "success" && outcome?.reason?.type === "auto";
    });
    process.exit(upgraded ? 0 : 1);
' <<<"$UPGRADE_EVENTS"; then
    echo "the live swap resumed without recording a successful auto-upgrade (this is the bug - see component_upgrade_finished events above): $UPGRADE_EVENTS" >&2
    exit 1
fi
echo ">>> MINIMAL LIVE-SWAP REPRO PASS (backend=$BACKEND -> $SWAP_BACKEND) -- if you see this, the bug is fixed"
