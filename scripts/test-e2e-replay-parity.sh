#!/usr/bin/env bash
# Proves the Rust and JS workflow backends are replay-compatible, not just
# individually correct: both export the identical
# obelisk-agent:workflow/workflow.run-cancellable FFQN (deployment.toml vs
# deployment.js.toml), so a running session's executor can be handed to the
# other implementation mid-flight via `obelisk deployment apply` and must
# keep making progress - the strongest evidence of behavioral parity between
# the two ports (a mismatch surfaces as a NonDeterminismError that would
# leave the session stuck, not just as a subtly different but "working"
# outcome). Round-trips rs -> js -> rs so both directions are checked.
#
# EXPECTED-RED as of Obelisk 0.41.5, turn 2 (rs -> js): not a workflow-agent
# bug. Every session notification (session.js's Notifications::notify) goes
# through a `*-await-next` typed extension import; Obelisk's JS workflow
# runtime proxies all such imports to the same generic `join-next` host call
# and never records `requested_ffqn` in history
# (`create_ext_await_next_proxy`, obelisk's crates/workflow-js-runtime),
# while Rust's wit-bindgen-generated bindings make a genuinely distinct typed
# call the executor's replay matcher compares `requested_ffqn` against
# (crates/wasm-workers/src/workflow/event_history.rs). A session that ran at
# least one turn under Rust therefore cannot replay under JS until Obelisk's
# JS runtime gains equivalent typed join-next-child tracking - kept running
# (non-blocking in CI, see .github/workflows/check.yml) so it starts passing
# automatically once that lands. See docs/js-backend-migration.md.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
source "$ROOT/scripts/e2e-lib.sh"

e2e_init "replay-parity-e2e" 28020 28096 "e2e-replay-parity-token"
export OBELISK_API_URL="$E2E_API_URL"
export OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:28020"
# server.toml's [secrets] requires every named var to exist; empty is fine.
export MCP_SERVER_TOKEN=""
export GITHUB_TOKEN=""
export AGENT_MODELS="[]"

e2e_select_backend "rs"
DEPLOY="$ROOT/.e2e-replay-parity-deployment.toml"
e2e_patch_workflow_manifest "$DEPLOY"
e2e_start_server "$DEPLOY"

RUN_FFQN="obelisk-agent:workflow/workflow.run-cancellable"
UI_BASE="http://127.0.0.1:28096"
run_detail() {
    curl --fail --silent --show-error "$UI_BASE/api/runs/$1" 2>&1
}

# Waits for SESSION_ID's next input offer, submits SCRIPT as a direct shell
# turn under it, waits for its record-output notification, and leaves the
# notification's stdout in SHELL_STDOUT. Identical to the helper in
# test-e2e-agent-workflow.sh; kept local since e2e scripts in this repo are
# self-contained (only e2e-lib.sh's server/deployment plumbing is shared).
run_shell_turn() {
    local shell_id="$1" script="$2"
    SECONDS=0
    local session_projection injection_id
    while true; do
        if session_projection="$(run_detail "$SESSION_ID")"; then
            injection_id="$(node scripts/e2e-json.js input-offer-id <<<"$session_projection")"
            [[ -n "$injection_id" ]] && break
        fi
        [[ $SECONDS -ge 60 ]] && { echo "session did not publish an input offer: $session_projection" >&2; exit 1; }
        sleep 1
    done
    curl --fail --silent --show-error \
        -H 'content-type: application/json' \
        -d "{\"offer_id\":\"$injection_id\",\"input\":{\"shell\":{\"id\":\"$shell_id\",\"script\":$(printf '%s' "$script" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))'),\"stdin\":\"\"}}}" \
        "$UI_BASE/api/input/$SESSION_ID" >/dev/null

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
        [[ $SECONDS -ge 60 ]] && { echo "shell turn $shell_id did not complete: $session_executions" >&2; exit 1; }
        sleep 1
    done
    SHELL_STDOUT="$(node scripts/e2e-json.js shell-stdout <<<"$notification")"
}

expect_stdout() {
    local label="$1" expected="$2"
    local actual
    actual="$(printf '%s' "$SHELL_STDOUT" | tr -d '[:space:]')"
    [[ "$actual" == "$expected" ]] || {
        echo ">>> E2E FAIL: $label expected stdout '$expected', got '$SHELL_STDOUT'" >&2
        exit 1
    }
}

ORIG_ID="$("$OBELISK" deployment active -a "$E2E_API_URL")"
echo ">>> starting under the Rust backend (active deployment: ${ORIG_ID})"

SESSION_ID="$("$OBELISK" generate execution-id)"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$SESSION_ID" "$RUN_FFQN" \
    '["", null, null, null, null]'
run_shell_turn "shell-replay-1" "echo turn1-rs"
expect_stdout "turn 1 (rs)" "turn1-rs"
echo ">>> turn 1 E2E PASS: ran under the Rust backend"

echo ">>> switching the active deployment to the JS backend (same FFQN, no rebuild)"
"$OBELISK" deployment apply "$ROOT/deployment.js.toml" -a "$E2E_API_URL"
JS_ID="$("$OBELISK" deployment active -a "$E2E_API_URL")"
[[ "$JS_ID" != "$ORIG_ID" ]] || { echo "deployment apply did not switch the active deployment" >&2; exit 1; }

run_shell_turn "shell-replay-2" "echo turn2-js"
expect_stdout "turn 2 (js, post-switch)" "turn2-js"
echo ">>> turn 2 E2E PASS: the session begun under Rust replayed and continued under the JS backend"

echo ">>> switching back to the original Rust deployment"
"$OBELISK" deployment apply "$ORIG_ID" -a "$E2E_API_URL"
BACK_ID="$("$OBELISK" deployment active -a "$E2E_API_URL")"
[[ "$BACK_ID" == "$ORIG_ID" ]] || { echo "deployment apply did not switch back to $ORIG_ID (got $BACK_ID)" >&2; exit 1; }

run_shell_turn "shell-replay-3" "echo turn3-rs-again"
expect_stdout "turn 3 (rs, post-switch-back)" "turn3-rs-again"
echo ">>> turn 3 E2E PASS: the same session replayed and continued back under the Rust backend"

"$OBELISK" execution cancel -a "$E2E_API_URL" "$SESSION_ID" >/dev/null || true
echo ">>> E2E PASS: one session ran turns across rs -> js -> rs deployment switches without a replay error"
