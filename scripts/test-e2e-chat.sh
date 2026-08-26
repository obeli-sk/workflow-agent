#!/usr/bin/env bash

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
source "$ROOT/scripts/e2e-lib.sh"

e2e_init "chat-e2e" 28018 28093 "e2e-chat-token"
export OBELISK_API_URL="$E2E_API_URL"
export OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:28018"
export AGENT_MODELS='[{"id":"fake","label":"Fake","api_type":"openai-chat-completions","wire_model":"fake"}]'
# server.toml's [secrets] requires every named var to exist; empty is fine.
export MCP_SERVER_TOKEN=""

e2e_build_component "workflow/workflow-rs" "workflow_agent_rs.wasm"
DEPLOY="$ROOT/.e2e-chat-deployment.toml"
e2e_patch_workflow_manifest "$DEPLOY"
e2e_start_server "$DEPLOY"

RUN_FFQN="obelisk-agent:workflow/workflow.run-cancellable"
CHAT_FFQN="obelisk-agent:programs/program.chat"
run_detail() {
    curl --fail --silent --show-error "http://127.0.0.1:28093/api/runs/$1" 2>&1
}

# Invoke the chat program directly (one activity execution) and print its
# stdout. Polls while the activity is pending; a finished nonzero exit or err
# result is terminal for the caller.
chat_direct() {
    local params="$1"
    local exec_id result
    exec_id="$("$OBELISK" generate execution-id)"
    "$OBELISK" execution submit -a "$E2E_API_URL" -e "$exec_id" "$CHAT_FFQN" "$params" >/dev/null
    SECONDS=0
    while true; do
        if result="$("$OBELISK" execution result -j -a "$E2E_API_URL" "$exec_id" 2>/dev/null)"; then
            if node scripts/e2e-json.js program-stdout <<<"$result"; then
                return 0
            fi
            node scripts/e2e-json.js program-stderr <<<"$result" >&2 || true
            return 1
        fi
        [[ $SECONDS -ge 30 ]] && { echo "chat direct call did not finish: $params" >&2; return 1; }
        sleep 1
    done
}

# Run one shell turn in a live session and print the shell command's stdout.
shell_turn() {
    local session_id="$1" turn_id="$2" script="$3"
    local offer projection
    SECONDS=0
    while true; do
        if projection="$(run_detail "$session_id")"; then
            offer="$(node scripts/e2e-json.js input-offer-id <<<"$projection")"
            [[ -n "$offer" ]] && break
        fi
        [[ $SECONDS -ge 30 ]] && { echo "no input offer for $session_id" >&2; return 1; }
        sleep 1
    done
    curl --fail --silent --show-error \
        -H 'content-type: application/json' \
        -d "{\"offer_id\":\"$offer\",\"input\":{\"shell\":{\"id\":\"$turn_id\",\"script\":\"$script\",\"stdin\":\"\"}}}" \
        "http://127.0.0.1:28093/api/input/$session_id" >/dev/null
    SECONDS=0
    while true; do
        if projection="$(run_detail "$session_id")"; then
            if node scripts/e2e-json.js check-shell-event-done "$turn_id" <<<"$projection" 2>/dev/null; then
                node scripts/e2e-json.js shell-event-stdout "$turn_id" <<<"$projection"
                return 0
            fi
        fi
        [[ $SECONDS -ge 30 ]] && { echo "shell turn $turn_id did not complete: $projection" >&2; return 1; }
        sleep 1
    done
}

echo ">>> chat models lists the fake catalog"
MODELS_OUT="$(chat_direct '["",["models"]]')"
grep -q $'fake\tFake\topenai-chat-completions' <<<"$MODELS_OUT"

echo ">>> chat --help covers the subcommands"
chat_direct '["",["--help"]]' | grep -q "Usage: chat COMMAND"

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
SECONDS=0
while true; do
    if RUNS="$(curl --fail --silent "http://127.0.0.1:28093/api/runs")" \
        && node scripts/e2e-json.js check-runs-name e2e-slug <<<"$RUNS"; then
        break
    fi
    [[ $SECONDS -ge 30 ]] && { echo "renamed run not listed: $RUNS" >&2; exit 1; }
    sleep 1
done

echo ">>> chat create outside a session falls back to a top-level execution"
TOPLEVEL_ID="$(chat_direct '["",["create","--model","fake"]]')"
[[ "$TOPLEVEL_ID" == E_* ]] || { echo "unexpected create output: $TOPLEVEL_ID" >&2; exit 1; }

echo ">>> chat create inside a session schedules a child of it"
CREATE_OUT="$(shell_turn "$PARENT_ID" "shell-chat-create" 'chat create --model fake')"
CHILD_ID="$(head -n 1 <<<"$CREATE_OUT")"
[[ "$CHILD_ID" == E_* ]] || { echo "unexpected child create output: $CREATE_OUT" >&2; exit 1; }
if "$OBELISK" execution list -j -a "$E2E_API_URL" --limit 200 | grep -q "\"$CHILD_ID\""; then
    echo "child session was listed without --show-derived" >&2
    exit 1
fi
"$OBELISK" execution list -j -a "$E2E_API_URL" --show-derived --limit 200 | grep -q "$CHILD_ID"

echo ">>> chat create --name with a \$-prefixed prompt opens a labeled child in bash"
SHELL_OUT="$(shell_turn "$PARENT_ID" "shell-chat-create-bash" 'chat create --model fake --name e2e-child $ echo opened-in-bash')"
BASH_CHILD_ID="$(head -n 1 <<<"$SHELL_OUT")"
[[ "$BASH_CHILD_ID" == E_* ]] || { echo "unexpected bash-child create output: $SHELL_OUT" >&2; exit 1; }
grep -q ".n:e2e-child_" <<<"$BASH_CHILD_ID" \
    || { echo "named child id does not carry the slug: $BASH_CHILD_ID" >&2; exit 1; }
SECONDS=0
while true; do
    if BASH_DETAIL="$(run_detail "$BASH_CHILD_ID")" \
        && node scripts/e2e-json.js check-shell-script 'echo opened-in-bash' 'opened-in-bash' <<<"$BASH_DETAIL"; then
        break
    fi
    [[ $SECONDS -ge 30 ]] && { echo "bash-first child never ran its script: $BASH_DETAIL" >&2; exit 1; }
    sleep 1
done

echo ">>> the named child knows its slug and its parent"
STATE_NAMED="$(chat_direct "[\"\",[\"state\",\"$BASH_CHILD_ID\"]]")"
node scripts/e2e-json.js check-state-name e2e-child <<<"$STATE_NAMED"
READ_SYS="$(chat_direct "[\"\",[\"read\",\"$BASH_CHILD_ID\",\"--system\"]]")"
grep -q "# This session" <<<"$READ_SYS"
grep -q "child session by $PARENT_ID" <<<"$READ_SYS"

echo ">>> the startup name reaches /api/runs without any rename turn"
SECONDS=0
while true; do
    if RUNS="$(curl --fail --silent http://127.0.0.1:28093/api/runs)" \
        && node scripts/e2e-json.js check-runs-name e2e-child <<<"$RUNS"; then
        break
    fi
    [[ $SECONDS -ge 30 ]] && { echo "startup-named child not listed by name: $RUNS" >&2; exit 1; }
    sleep 1
done

echo ">>> /api/runs nests children under their parent"
RUNS="$(curl --fail --silent http://127.0.0.1:28093/api/runs)"
node scripts/e2e-json.js check-runs-parent "$PARENT_ID" "$CHILD_ID" <<<"$RUNS"
node scripts/e2e-json.js check-runs-parent "$PARENT_ID" "$BASH_CHILD_ID" <<<"$RUNS"

echo ">>> chat list shows both sessions"
LIST_OUT="$(chat_direct '["",["list","--json"]]')"
grep -q "$CHILD_ID" <<<"$LIST_OUT"
grep -q "e2e-slug" <<<"$LIST_OUT"

echo ">>> chat state reports an idle child with a fresh offer"
SECONDS=0
while true; do
    if STATE_OUT="$(chat_direct "[\"\",[\"state\",\"$CHILD_ID\"]]")" \
        && node scripts/e2e-json.js check-pending-offer "$CHILD_ID" <<<"$STATE_OUT"; then
        break
    fi
    [[ $SECONDS -ge 30 ]] && { echo "child state never settled: $STATE_OUT" >&2; exit 1; }
    sleep 1
done

echo ">>> chat send queues a prompt for the child"
SEND_OUT="$(chat_direct "[\"\",[\"send\",\"$CHILD_ID\",\"hello from e2e\"]]")"
grep -q "sent to $CHILD_ID" <<<"$SEND_OUT"
SECONDS=0
while true; do
    if CHILD_DETAIL="$(run_detail "$CHILD_ID")" \
        && node scripts/e2e-json.js check-user-message "hello from e2e" <<<"$CHILD_DETAIL"; then
        break
    fi
    [[ $SECONDS -ge 30 ]] && { echo "injected message was not projected: $CHILD_DETAIL" >&2; exit 1; }
    sleep 1
done

echo ">>> chat read renders the injected turn"
READ_OUT="$(chat_direct "[\"\",[\"read\",\"$CHILD_ID\"]]")"
grep -q "\[turn 0\] user: hello from e2e" <<<"$READ_OUT"
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

echo ">>> chat watch times out on an idle parked child"
WATCH_OUT="$(shell_turn "$PARENT_ID" "shell-chat-watch-timeout" \
    "chat watch $CHILD_ID --timeout 5s --interval 1s")"
grep -q '"timed_out":true' <<<"$WATCH_OUT" \
    || { echo "watch did not time out: $WATCH_OUT" >&2; exit 1; }

echo ">>> cleaning up sessions"
"$OBELISK" execution cancel -a "$E2E_API_URL" "$PARENT_ID" >/dev/null || true
"$OBELISK" execution cancel -a "$E2E_API_URL" "$TOPLEVEL_ID" >/dev/null || true
"$OBELISK" execution cancel -a "$E2E_API_URL" "$CHILD_ID" >/dev/null || true
"$OBELISK" execution cancel -a "$E2E_API_URL" "$BASH_CHILD_ID" >/dev/null || true
echo ">>> chat E2E PASS"
