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
PORT_OFFSET=$(e2e_backend_port_offset "$BACKEND")
API_PORT=$((28016 + PORT_OFFSET))
EXTERNAL_PORT=$((28091 + PORT_OFFSET))
e2e_init "agent-workflow-e2e-$BACKEND" "$API_PORT" "$EXTERNAL_PORT" "e2e-agent-workflow-token"
export OBELISK_API_URL="$E2E_API_URL"
export OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:${API_PORT}"
unset MCP_SERVER_TOKEN
export AGENT_MODELS="[]"
export LLM_BASE_URL="http://127.0.0.1:${EXTERNAL_PORT}"

e2e_select_backend "$BACKEND"
export APPS_JSON='[{"name":"components","repo":"components","description":"E2E GitHub mount"}]'
e2e_start_github_mock "obeli-sk/components=$ROOT/scripts/e2e-fixtures/components"
DEPLOY="$ROOT/.e2e-agent-deployment-$BACKEND.toml"
e2e_patch_workflow_manifest "$DEPLOY"
e2e_start_server "$DEPLOY"

RUN_FFQN="obelisk-agent:workflow/workflow.run-cancellable"
run_detail() {
    curl --fail --silent --show-error "http://127.0.0.1:${EXTERNAL_PORT}/api/runs/$1" 2>&1
}

# Waits for SESSION_ID to publish a fresh input offer. run_shell_turn's own
# completion only proves the shell's record-output stub is written (visible
# to any reader the instant record_output_stub self-answers it, ahead of the
# workflow's own await-next) - not that the workflow has actually finished
# advancing and parked on its new turn's join set. Swapping the deployment
# before that settles can preempt the workflow mid-flush, which is not a
# clean, replayable state under any backend. Callers that need to know the
# session is truly idle (e.g. before a live backend swap) must wait here too.
wait_for_input_offer() {
    e2e_wait_offer "$SESSION_ID"
}

# Finds the record-output stub with the shell id's shell_output (records batch events).
shell_notification() {
    local shell_id="$1" record_id candidate
    SESSION_EXECUTIONS="$("$OBELISK" execution list -j -a "$E2E_API_URL" -e "$SESSION_ID" --show-derived --limit 100)" || return 1
    while IFS= read -r record_id; do
        if [[ -n "$record_id" ]] \
            && candidate="$("$OBELISK" execution result -j -a "$E2E_API_URL" "$record_id" 2>/dev/null)" \
            && node -e "const list=JSON.parse(require('fs').readFileSync(0,'utf8'))?.ok??[]; const r=list.find((e)=>e?.shell_output)?.shell_output; process.exit(r?.id===process.argv[1]?0:1)" "$shell_id" <<<"$candidate" 2>/dev/null; then
            NOTIFICATION="$candidate"
            return 0
        fi
    done < <(node scripts/e2e-json.js execution-ids "obelisk-agent:stub/stub.record-output" <<<"$SESSION_EXECUTIONS")
    return 1
}

# Runs SCRIPT as a direct shell turn on the next offer; its stdout lands in SHELL_STDOUT.
run_shell_turn() {
    local shell_id="$1" script="$2" injection_id
    injection_id="$(e2e_take_offer "$SESSION_ID")"
    curl --fail --silent --show-error \
        -H 'content-type: application/json' \
        -d "{\"offer_id\":\"$injection_id\",\"input\":{\"shell\":{\"id\":\"$shell_id\",\"script\":$(printf '%s' "$script" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))'),\"stdin\":\"\"}}}" \
        "http://127.0.0.1:${EXTERNAL_PORT}/api/input/$SESSION_ID" >/dev/null

    e2e_wait_until shell_notification "$shell_id" \
        || { echo "shell turn $shell_id did not complete: $SESSION_EXECUTIONS" >&2; exit 1; }
    SHELL_STDOUT="$(node scripts/e2e-json.js shell-stdout <<<"$NOTIFICATION")"
    SHELL_STDERR="$(node scripts/e2e-json.js shell-stderr <<<"$NOTIFICATION")"
}

# Fetches a run's projection into PROJECTION and pipes it to an e2e-json.js check.
projection_check() {
    local session_id="$1"
    shift
    PROJECTION="$(run_detail "$session_id")" \
        && node scripts/e2e-json.js "$@" <<<"$PROJECTION" >/dev/null 2>&1
}

# Waits until a run's projection reports the given name.
projection_named() {
    PROJECTION="$(run_detail "$1")" \
        && node -e "process.exit(JSON.parse(require('fs').readFileSync(0,'utf8')||'{}')?.name===process.argv[1]?0:1)" "$2" <<<"$PROJECTION" 2>/dev/null
}

echo ">>> checking ask-user lifecycle through the session projection"
ASK_SESSION_ID="$("$OBELISK" generate execution-id)"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$ASK_SESSION_ID" "$RUN_FFQN" \
    '["", null, null, null, null]'

ASK_OFFER_ID="$(e2e_take_offer "$ASK_SESSION_ID")"
ASK_SCRIPT="obelisk call obelisk-agent:stub/stub.ask-user '[\"Continue?\"]'"
ASK_BODY="$(node scripts/e2e-json.js shell-input "$ASK_OFFER_ID" shell-e2e-ask "$ASK_SCRIPT")"
curl --fail --silent --show-error \
    -H 'content-type: application/json' \
    -d "$ASK_BODY" \
    "http://127.0.0.1:${EXTERNAL_PORT}/api/input/$ASK_SESSION_ID" >/dev/null

e2e_wait_until projection_check "$ASK_SESSION_ID" check-human-input-request \
    || { echo "ask-user request was not projected: $PROJECTION" >&2; exit 1; }
ASK_ID="$(node scripts/e2e-json.js pending-ask-id <<<"$PROJECTION")"
curl --fail --silent --show-error \
    -H 'content-type: application/json' \
    -d '{"answer":"yes"}' \
    "http://127.0.0.1:${EXTERNAL_PORT}/api/answer/$ASK_ID" >/dev/null

e2e_wait_until projection_check "$ASK_SESSION_ID" check-human-input-resolved \
    || { echo "ask-user resolution was not projected: $PROJECTION" >&2; exit 1; }
echo ">>> ask-user projection E2E PASS"
"$OBELISK" execution cancel -a "$E2E_API_URL" "$ASK_SESSION_ID" >/dev/null || true

echo ">>> creating an empty session and running one direct shell turn"
SESSION_ID="$("$OBELISK" generate execution-id)"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$SESSION_ID" "$RUN_FFQN" \
    '["", null, null, null, null]'

e2e_take_offer "$SESSION_ID" >/dev/null
INJECTION_ID="$E2E_OFFER"
RESPONSE_CURSOR="$(node scripts/e2e-json.js response-cursor <<<"$PROJECTION")"

curl --fail --silent --show-error \
    -H 'content-type: application/json' \
    -d "{\"offer_id\":\"$INJECTION_ID\",\"input\":{\"shell\":{\"id\":\"shell-e2e-1\",\"script\":\"which curl && curl --version\",\"stdin\":\"\"}}}" \
    "http://127.0.0.1:${EXTERNAL_PORT}/api/input/$SESSION_ID" >/dev/null

# The session batches several events (session_started, input_offered,
# shell_output, ...) into each `record-output` stub, so we cannot pick the
# shell turn's notification by list order: the next turn's input_offered
# record often lands first (or bundled alongside a later batch). Poll until
# the specific `shell_output` record for shell-e2e-1 is present, matching
# each record-output result in turn.
shell_session_done() {
    shell_notification shell-e2e-1 \
        && node scripts/e2e-json.js check-shell-session <<<"$SESSION_EXECUTIONS"
}
e2e_wait_until shell_session_done \
    || { echo "shell turn did not complete correctly: $SESSION_EXECUTIONS" >&2; exit 1; }
node scripts/e2e-json.js check-shell-notification <<<"$NOTIFICATION"

# The next input_offer is published after the record-output stub, so poll until it settles.
shell_projection() {
    SHELL_PROJECTION="$(curl --fail --silent \
        "http://127.0.0.1:${EXTERNAL_PORT}/api/runs/$SESSION_ID?workflow_id=$SESSION_ID&response_cursor=$RESPONSE_CURSOR")" \
        && node scripts/e2e-json.js check-shell-projection <<<"$SHELL_PROJECTION" 2>/dev/null
}
e2e_wait_until shell_projection \
    || { node scripts/e2e-json.js check-shell-projection <<<"$SHELL_PROJECTION"; exit 1; }
echo ">>> shell-only E2E PASS: curl was registered and invoked without starting the agent"

echo ">>> running the obelisk/mount custom commands"
# The components mount's ref resolves lazily, on its first ls/cat, not at
# `mount` time: the first `mount` (before anything touches the tree) shows
# the requested ref (@main); only the second, after the `cat`, shows the
# commit it pinned to.
run_shell_turn "shell-e2e-2" "mount && cat /workspace/apps/components/README.md && mount && echo --- && obelisk cloud app functions list --help"
if [[ "$SHELL_STDOUT" != *"Network-backed mounts"* ]]; then
    echo "mount command did not print the expected header: $SHELL_STDOUT" >&2
    exit 1
fi
if [[ "$SHELL_STDOUT" != *"obeli-sk/components@main"* ]]; then
    echo "mount command did not show the unresolved ref before first access: $SHELL_STDOUT" >&2
    exit 1
fi
if [[ ! "$SHELL_STDOUT" =~ obeli-sk/components@[0-9a-f]{40} ]]; then
    echo "mount command did not show the resolved components commit after first access: $SHELL_STDOUT" >&2
    exit 1
fi
if [[ "$SHELL_STDOUT" != *"# Obelisk Components"* ]]; then
    echo "GitHub components mount did not read README.md: $SHELL_STDOUT" >&2
    exit 1
fi
if [[ "$SHELL_STDOUT" != *"Usage: obelisk cloud app [--app NAME] functions"* ]]; then
    echo "obelisk cloud app functions --help did not print its usage: $SHELL_STDOUT" >&2
    exit 1
fi
echo ">>> obelisk/mount E2E PASS"

echo ">>> checking replay-stable ls formatting and collation"
run_shell_turn "shell-e2e-ls" "touch b A a B && ls -la"
LS_ORDER="$(printf '%s\n' "$SHELL_STDOUT" | sed -n 's/^[-d][^ ]* 1 user user [ ]*[0-9][0-9]* Jan  1 00:00 //p' | paste -sd ' ' -)"
if [[ "$LS_ORDER" != ". .. a A apps b B cloud mcp" ]]; then
    echo "ls -la output did not use the replay-stable format/order: $SHELL_STDOUT" >&2
    exit 1
fi

echo ">>> live-swapping the blocked session to the other workflow backend"
# Let the workflow finish advancing past the ls turn and settle on its new
# join set before swapping - see wait_for_input_offer's comment.
wait_for_input_offer
case "$BACKEND" in
    rs) SWAP_BACKEND="js" ;;
    js) SWAP_BACKEND="rs" ;;
esac
e2e_select_backend "$SWAP_BACKEND"
SWAP_DEPLOY="$ROOT/.e2e-agent-live-swap-${SWAP_BACKEND}.toml"
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
    echo "the live swap resumed without recording a successful auto-upgrade: $UPGRADE_EVENTS" >&2
    exit 1
fi
"$OBELISK" deployment apply "$DEPLOY" -a "$E2E_API_URL" >/dev/null
e2e_select_backend "$BACKEND"
echo ">>> live-swap auto-upgrade E2E PASS"

run_shell_turn "shell-e2e-submit-error" "cd cloud/workflow-agent/deployment/current && sed 's/GITHUB_MOUNT_TOKEN/REPLAY_MISSING_SECRET/g' deployment.toml > replay-invalid.toml && obelisk cloud app deployment submit replay-invalid.toml"
if [[ "$SHELL_STDERR" != *"REPLAY_MISSING_SECRET"* ]]; then
    echo "deployment submit did not surface its typed server error: $SHELL_STDERR" >&2
    exit 1
fi
run_shell_turn "shell-e2e-submit-help" "obelisk cloud app deployment submit --help"
if [[ "$SHELL_STDOUT" != *"any filename -- not just"* ]]; then
    echo "deployment submit help did not match the Rust backend: $SHELL_STDOUT" >&2
    exit 1
fi
e2e_verify_replay_parity "$BACKEND" "$DEPLOY" "$SESSION_ID"
echo ">>> ls replay-parity E2E PASS"
"$OBELISK" execution cancel -a "$E2E_API_URL" "$SESSION_ID" >/dev/null || true

echo ">>> creating a session with an initial name"
NAMED_SESSION_ID="$("$OBELISK" generate execution-id)"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$NAMED_SESSION_ID" "$RUN_FFQN" \
    '["", null, null, null, "e2e-rename-check"]'
e2e_wait_until projection_named "$NAMED_SESSION_ID" e2e-rename-check \
    || { echo "session did not report its initial name: $PROJECTION" >&2; exit 1; }
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
e2e_wait_until projection_named "$CHILD_ID" e2e-chat-child \
    || { echo "child session did not start or report its --name: $PROJECTION" >&2; exit 1; }
echo ">>> chat create E2E PASS: the self-referential child submit works and reports its --name"
"$OBELISK" execution cancel -a "$E2E_API_URL" "$CHILD_ID" >/dev/null || true
"$OBELISK" execution cancel -a "$E2E_API_URL" "$CHAT_SESSION_ID" >/dev/null || true

EXEC_ID="$("$OBELISK" generate execution-id)"
echo ">>> submitting $RUN_FFQN as $EXEC_ID"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$EXEC_ID" "$RUN_FFQN" \
    '["hello from the e2e test", null, null, null, null]'

EXPECT="No models available from discovery or AGENT_MODELS"
echo ">>> waiting for the recoverable LLM configuration error"
e2e_wait_until projection_check "$EXEC_ID" check-agent-error "$EXPECT" \
    || { echo "agent error was not projected or the session did not recover: $PROJECTION" >&2; exit 1; }
echo ">>> E2E PASS: the session surfaced the LLM configuration error and returned to idle"

e2e_verify_replay_parity "$BACKEND" "$DEPLOY" "$EXEC_ID"

"$OBELISK" execution cancel -a "$E2E_API_URL" "$EXEC_ID" >/dev/null || true

# The web UI creates sessions through its statically imported
# run-cancellable-schedule; the session must start and publish an input offer.
UI_CREATED="$(curl --fail --silent --show-error -X POST -H 'content-type: application/json' \
    -d '{}' "http://127.0.0.1:${EXTERNAL_PORT}/api/sessions")"
SESSION_ID="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).execution_id ?? '')" <<<"$UI_CREATED")"
[[ "$SESSION_ID" == E_* ]] || { echo "UI session create returned no execution id: $UI_CREATED" >&2; exit 1; }
wait_for_input_offer
echo ">>> UI session create E2E PASS: $SESSION_ID started and is waiting for input"
"$OBELISK" execution cancel -a "$E2E_API_URL" "$SESSION_ID" >/dev/null || true
