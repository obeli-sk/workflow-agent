#!/usr/bin/env bash
# Usage: test-e2e-chat.sh [rs|js]  (default rs)

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
source "$ROOT/scripts/e2e-lib.sh"

BACKEND="${1:-rs}"
PORT_OFFSET=$(e2e_backend_port_offset "$BACKEND")
API_PORT=$((28018 + PORT_OFFSET))
EXTERNAL_PORT=$((28093 + PORT_OFFSET))
e2e_init "chat-e2e-$BACKEND" "$API_PORT" "$EXTERNAL_PORT" "e2e-chat-token"
export OBELISK_API_URL="$E2E_API_URL"
export AGENT_MODELS='[{"id":"fake","label":"Fake","api_type":"openai-chat-completions","wire_model":"fake"}]'
unset MCP_SERVER_TOKEN

e2e_select_backend "$BACKEND"
DEPLOY="$ROOT/.e2e-chat-deployment-$BACKEND.toml"
e2e_patch_workflow_manifest "$DEPLOY"
e2e_start_server "$DEPLOY"

RUN_FFQN="obelisk-agent:workflow/workflow.run-cancellable"
CHAT_FFQN="obelisk-agent:programs/program.chat"
run_detail() {
    local detail
    detail="$(curl --fail --silent "http://127.0.0.1:${EXTERNAL_PORT}/api/runs/$1")" || return 1
    node -e 'JSON.parse(require("fs").readFileSync(0, "utf8"))' <<<"$detail" >/dev/null 2>&1 || return 1
    printf '%s\n' "$detail"
}

chat_finished() {
    CHAT_RESULT="$("$OBELISK" execution result -j -a "$E2E_API_URL" "$1" 2>/dev/null)"
}

# Invoke the chat program directly (one activity execution) and print its
# stdout. Polls while the activity is pending; a finished nonzero exit or err
# result is terminal for the caller.
chat_direct() {
    local params="$1" exec_id
    exec_id="$("$OBELISK" generate execution-id)"
    "$OBELISK" execution submit -a "$E2E_API_URL" -e "$exec_id" "$CHAT_FFQN" "$params" >/dev/null
    e2e_wait_until chat_finished "$exec_id" \
        || { echo "chat direct call did not finish: $params" >&2; return 1; }
    node scripts/e2e-json.js program-stdout <<<"$CHAT_RESULT" && return 0
    node scripts/e2e-json.js program-stderr <<<"$CHAT_RESULT" >&2 || true
    return 1
}

# Runs a read-only chat command into CHAT_OUT and pipes it to the check command.
chat_check() {
    local params="$1"
    shift
    CHAT_OUT="$(chat_direct "$params")" && "$@" <<<"$CHAT_OUT"
}

# Polls a read-only chat command until its output passes the check, then prints it.
chat_until() {
    e2e_wait_until chat_check "$@" \
        || { echo "chat $1 never passed ${*:2}: $CHAT_OUT" >&2; return 1; }
    printf '%s\n' "$CHAT_OUT"
}

# Fetches a run's projection into PROJECTION and pipes it to an e2e-json.js check.
projection_check() {
    local session_id="$1"
    shift
    PROJECTION="$(run_detail "$session_id")" \
        && node scripts/e2e-json.js "$@" <<<"$PROJECTION" >/dev/null 2>&1
}

# Same for the /api/runs listing, into RUNS.
runs_check() {
    RUNS="$(curl --fail --silent "http://127.0.0.1:${EXTERNAL_PORT}/api/runs")" \
        && node scripts/e2e-json.js "$@" <<<"$RUNS" >/dev/null 2>&1
}

# Run one shell turn in a live session and print the shell command's stdout.
shell_turn() {
    local session_id="$1" turn_id="$2" script="$3" offer
    offer="$(e2e_take_offer "$session_id")" || return 1
    curl --fail --silent --show-error \
        -H 'content-type: application/json' \
        -d "{\"offer_id\":\"$offer\",\"input\":{\"shell\":{\"id\":\"$turn_id\",\"script\":\"$script\",\"stdin\":\"\"}}}" \
        "http://127.0.0.1:${EXTERNAL_PORT}/api/input/$session_id" >/dev/null
    e2e_wait_until projection_check "$session_id" check-shell-event-done "$turn_id" \
        || { echo "shell turn $turn_id did not complete: $PROJECTION" >&2; return 1; }
    node scripts/e2e-json.js shell-event-stdout "$turn_id" <<<"$PROJECTION"
}

echo ">>> chat models lists the fake catalog"
MODELS_OUT="$(chat_direct '["",["models"]]')"
grep -q $'fake\tFake\topenai-chat-completions' <<<"$MODELS_OUT"

echo ">>> chat --help covers the subcommands"
HELP_OUT="$(chat_direct '["",["--help"]]')"
grep -q "Usage: chat COMMAND" <<<"$HELP_OUT"

echo ">>> creating a parent session and running chat current in it"
PARENT_ID="$("$OBELISK" generate execution-id)"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$PARENT_ID" "$RUN_FFQN" \
    '["", null, null, null, null]'
CURRENT_OUT="$(shell_turn "$PARENT_ID" "shell-chat-current" 'chat current')"
node scripts/e2e-json.js check-current-id "$PARENT_ID" <<<"$CURRENT_OUT"

echo ">>> renaming the parent via chat rename and seeing it on /api/runs"
shell_turn "$PARENT_ID" "shell-chat-rename" 'chat rename e2e-slug' >/dev/null
RENAME_OUT="$(shell_turn "$PARENT_ID" "shell-chat-current-2" 'chat current')"
node scripts/e2e-json.js check-current-id "$PARENT_ID" --name e2e-slug <<<"$RENAME_OUT"
e2e_wait_until runs_check check-runs-name e2e-slug \
    || { echo "renamed run not listed: $RUNS" >&2; exit 1; }

echo ">>> chat create outside a session falls back to a top-level execution"
TOPLEVEL_ID="$(chat_direct '["",["create","--model","fake"]]')"
[[ "$TOPLEVEL_ID" == E_* ]] || { echo "unexpected create output: $TOPLEVEL_ID" >&2; exit 1; }

echo ">>> chat create inside a session schedules a child of it"
CREATE_OUT="$(shell_turn "$PARENT_ID" "shell-chat-create" 'chat create --model fake')"
CHILD_ID="$(head -n 1 <<<"$CREATE_OUT")"
[[ "$CHILD_ID" == E_* ]] || { echo "unexpected child create output: $CREATE_OUT" >&2; exit 1; }
# Captured, not piped into grep -q: an early-exiting grep breaks obelisk's stdout.
TOP_LEVEL_LIST="$("$OBELISK" execution list -j -a "$E2E_API_URL" --limit 200)"
if grep -q "\"$CHILD_ID\"" <<<"$TOP_LEVEL_LIST"; then
    echo "child session was listed without --show-derived" >&2
    exit 1
fi
DERIVED_LIST="$("$OBELISK" execution list -j -a "$E2E_API_URL" --show-derived --limit 200)"
grep -q "$CHILD_ID" <<<"$DERIVED_LIST"

echo ">>> chat create --name with a \$-prefixed prompt opens a labeled child in bash"
SHELL_OUT="$(shell_turn "$PARENT_ID" "shell-chat-create-bash" 'chat create --model fake --name e2e-child $ echo opened-in-bash')"
BASH_CHILD_ID="$(head -n 1 <<<"$SHELL_OUT")"
[[ "$BASH_CHILD_ID" == E_* ]] || { echo "unexpected bash-child create output: $SHELL_OUT" >&2; exit 1; }
grep -q ".n:e2e-child_" <<<"$BASH_CHILD_ID" \
    || { echo "named child id does not carry the slug: $BASH_CHILD_ID" >&2; exit 1; }
e2e_wait_until projection_check "$BASH_CHILD_ID" check-shell-script 'echo opened-in-bash' 'opened-in-bash' \
    || { echo "bash-first child never ran its script: $PROJECTION" >&2; exit 1; }

echo ">>> the named child knows its slug and its parent"
chat_until "[\"\",[\"state\",\"$BASH_CHILD_ID\"]]" node scripts/e2e-json.js check-state-name e2e-child >/dev/null
READ_SYS="$(chat_until "[\"\",[\"read\",\"$BASH_CHILD_ID\",\"--system\"]]" grep -q "# This session")"
grep -q "child session by $PARENT_ID" <<<"$READ_SYS"

echo ">>> the startup name reaches /api/runs without any rename turn"
e2e_wait_until runs_check check-runs-name e2e-child \
    || { echo "startup-named child not listed by name: $RUNS" >&2; exit 1; }

echo ">>> /api/runs nests children under their parent"
e2e_wait_until runs_check check-runs-parent "$PARENT_ID" "$CHILD_ID" \
    || { echo "child not nested under its parent: $RUNS" >&2; exit 1; }
e2e_wait_until runs_check check-runs-parent "$PARENT_ID" "$BASH_CHILD_ID" \
    || { echo "bash child not nested under its parent: $RUNS" >&2; exit 1; }

echo ">>> chat list shows both sessions"
LIST_OUT="$(chat_until '["",["list","--json"]]' grep -q "$CHILD_ID")"
grep -q "e2e-slug" <<<"$LIST_OUT"

echo ">>> chat state reports an idle child with a fresh offer"
chat_until "[\"\",[\"state\",\"$CHILD_ID\"]]" node scripts/e2e-json.js check-pending-offer "$CHILD_ID" >/dev/null

echo ">>> chat watch times out on an idle parked child"
WATCH_OUT="$(shell_turn "$PARENT_ID" "shell-chat-watch-timeout" \
    "chat watch $CHILD_ID --timeout 5s --interval 1s")"
grep -q '"timed_out":true' <<<"$WATCH_OUT" \
    || { echo "watch did not time out: $WATCH_OUT" >&2; exit 1; }

echo ">>> chat send queues a prompt for the child"
SEND_OUT="$(chat_direct "[\"\",[\"send\",\"$CHILD_ID\",\"hello from e2e\"]]")"
grep -q "sent to $CHILD_ID" <<<"$SEND_OUT"
e2e_wait_until projection_check "$CHILD_ID" check-user-message "hello from e2e" \
    || { echo "injected message was not projected: $PROJECTION" >&2; exit 1; }

echo ">>> chat read renders the injected turn"
READ_OUT="$(chat_until "[\"\",[\"read\",\"$CHILD_ID\"]]" grep -q "\[turn 0\] user: hello from e2e")"
grep -q "backend fake" <<<"$READ_OUT"

echo ">>> chat send to a bogus session fails cleanly"
if BOGUS="$(chat_direct '["",["send","E_bogus000000000000000000000000001","hi"]]')"; then
    echo "send to a nonexistent session unexpectedly succeeded: $BOGUS" >&2
    exit 1
fi

echo ">>> chat create --watch blocks until the scripted child stops progressing"
WATCH_OUT="$(shell_turn "$PARENT_ID" "shell-chat-create-watch" \
    'chat create --model fake --name watched $ echo hi --watch')"
grep -q '"state":"shell-only"' <<<"$WATCH_OUT" \
    || { echo "create --watch did not report shell-only: $WATCH_OUT" >&2; exit 1; }
grep -q '"timed_out":false' <<<"$WATCH_OUT" \
    || { echo "create --watch woke as a timeout: $WATCH_OUT" >&2; exit 1; }

echo ">>> chat watch wakes immediately on a cancelled session"
"$OBELISK" execution cancel -a "$E2E_API_URL" "$TOPLEVEL_ID" >/dev/null || true
WATCH_OUT="$(shell_turn "$PARENT_ID" "shell-chat-watch-cancelled" \
    "chat watch $TOPLEVEL_ID --timeout 60s")"
grep -q '"state":"cancelled"' <<<"$WATCH_OUT" \
    || { echo "watch did not report cancelled: $WATCH_OUT" >&2; exit 1; }

# KNOWN-RED: an Obelisk-core replay-finalize gap, not a workflow-agent bug -
# see the KNOWN-RED note on e2e_verify_replay_parity in e2e-lib.sh.
e2e_verify_replay_parity "$BACKEND" "$DEPLOY" "$PARENT_ID"

echo ">>> cleaning up sessions"
"$OBELISK" execution cancel -a "$E2E_API_URL" "$PARENT_ID" >/dev/null || true
"$OBELISK" execution cancel -a "$E2E_API_URL" "$TOPLEVEL_ID" >/dev/null || true
"$OBELISK" execution cancel -a "$E2E_API_URL" "$CHILD_ID" >/dev/null || true
"$OBELISK" execution cancel -a "$E2E_API_URL" "$BASH_CHILD_ID" >/dev/null || true
echo ">>> chat E2E PASS"
