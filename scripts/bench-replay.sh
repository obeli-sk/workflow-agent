#!/usr/bin/env bash
# Usage: OBELISK=/path/to/obelisk nix develop -c bash scripts/bench-replay.sh OUTPUT_DIR
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
source "$ROOT/scripts/e2e-lib.sh"

OUTPUT_DIR="$(realpath -m "${1:-/tmp/workflow-agent-replay-benchmark}")"
mkdir -p "$OUTPUT_DIR"
e2e_init replay-benchmark "${BENCH_API_PORT:-15005}" "${BENCH_EXTERNAL_PORT:-19090}" replay-benchmark
export OBELISK_API_URL="$E2E_API_URL"
export OBELISK_API_URL_REGEX="$TARGET_OBELISK_API_URL_REGEX"
export AGENT_MODELS='[]' DOCS_URLS_JSON='[]' MCP_SERVERS_JSON='[]' PROGRAMS_JSON='[]'
export OBELISK_JS_RUNTIME=v8
unset MCP_SERVER_TOKEN
e2e_select_backend js
JS_DEPLOY="$ROOT/.replay-benchmark-js.toml"
e2e_patch_workflow_manifest "$JS_DEPLOY"
e2e_start_server "$JS_DEPLOY"
SESSION_ID="$("$OBELISK" generate execution-id)"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$SESSION_ID" \
    obelisk-agent:workflow/workflow.run-cancellable '["", null, null, null, null]'
EXTERNAL_URL="http://127.0.0.1:${BENCH_EXTERNAL_PORT:-19090}"

detail() {
    curl --fail --silent --show-error "$EXTERNAL_URL/api/runs/$SESSION_ID"
}

wait_for_offer() {
    local deadline=$((SECONDS + 60)) projection
    while true; do
        projection="$(detail)"
        OFFER_ID="$(node scripts/e2e-json.js input-offer-id <<<"$projection")"
        [[ -n "$OFFER_ID" ]] && break
        [[ $SECONDS -lt $deadline ]] || { echo 'Input offer timed out' >&2; exit 1; }
        sleep 0.2
    done
}

for turn in $(seq 1 "${BENCH_TURNS:-24}"); do
    wait_for_offer
    SCRIPT="$(cat <<'BASH'
set -e
mkdir -p /workspace/bench
help > /workspace/bench/commands.txt
seq 1 2000 | awk '{print "{\"n\":"$1"}"}' > /workspace/bench/rows.jsonl
cat /workspace/bench/rows.jsonl | jq -s 'map(.n) | add' > /workspace/bench/total.txt
grep '"n":1' /workspace/bench/rows.jsonl | sort | uniq | wc -l > /workspace/bench/matches.txt
bash -c 'cat /workspace/bench/total.txt; cat /workspace/bench/matches.txt'
cat /workspace/bench/total.txt >> /workspace/bench/history.txt
cat /workspace/bench/history.txt | wc -l
BASH
    )"
    SHELL_ID="bench-$turn"
    jq -n --arg offer "$OFFER_ID" --arg id "$SHELL_ID" --arg script "$SCRIPT" \
        '{offer_id:$offer,input:{shell:{id:$id,script:$script,stdin:""}}}' \
        | curl --fail --silent --show-error -H 'content-type: application/json' \
            --data-binary @- "$EXTERNAL_URL/api/input/$SESSION_ID" >/dev/null
    deadline=$((SECONDS + 60))
    while true; do
        projection="$(detail)"
        if node scripts/e2e-json.js check-shell-event-done "$SHELL_ID" <<<"$projection"; then
            jq -e --arg id "$SHELL_ID" '.transcript.shell_events[] | select(.id==$id) | .result.exit_code==0' <<<"$projection" >/dev/null
            stdout="$(node scripts/e2e-json.js shell-event-stdout "$SHELL_ID" <<<"$projection")"
            [[ "$stdout" == "2001000"$'\n'"1111"$'\n'"$turn" ]] || {
                echo "Unexpected shell output: $stdout" >&2; exit 1;
            }
            break
        fi
        [[ $SECONDS -lt $deadline ]] || { echo "Shell turn $turn timed out" >&2; exit 1; }
        sleep 0.2
    done
    echo ">>> local shell turn $turn complete"
done
wait_for_offer
"$OBELISK" execution pause -a "$E2E_API_URL" "$SESSION_ID"

stop_server() {
    kill -SIGINT "$E2E_SERVER_PID"
    wait "$E2E_SERVER_PID" || true
    E2E_SERVER_PID=''
}

measure() {
    local label="$1" output="$2" response sample
    : > "$output"
    if [[ -n "${REPLAY_SAMPLER:-}" ]]; then
        bash "$REPLAY_SAMPLER" "$label" "$E2E_API_URL" "$SESSION_ID" > "$output"
    else
        for sample in {0..9}; do
            response="$(curl --fail-with-body --silent --show-error --max-time 120 \
                -X PUT -H "Authorization: Bearer $OBELISK_API_TOKEN" \
                "$E2E_API_URL/v1/executions/$SESSION_ID/replay")"
            jq -e '.type=="blocked"' <<<"$response" >/dev/null
            if ((sample > 0)); then
                jq -c --arg runtime "$label" --arg execution_id "$SESSION_ID" --argjson sample "$sample" \
                    '{runtime:$runtime,execution_id:$execution_id,sample:$sample,outcome:.type,replayed_event_count,replay_version,replay_duration_ms}' \
                    <<<"$response" >> "$output"
            fi
        done
    fi
}

measure v8 "$OUTPUT_DIR/v8-corrected.jsonl"
stop_server
export OBELISK_JS_RUNTIME=boa-wasm
e2e_start_server "$JS_DEPLOY"
measure boa-wasm "$OUTPUT_DIR/boa-corrected.jsonl"
stop_server
export OBELISK_JS_RUNTIME=v8
e2e_select_backend rs
RS_DEPLOY="$ROOT/.replay-benchmark-rs.toml"
e2e_swap_workflow_manifest "$JS_DEPLOY" "$RS_DEPLOY"
e2e_start_server "$RS_DEPLOY"
measure rust-wasm "$OUTPUT_DIR/rust-corrected.jsonl"
jq -s -e 'map([.execution_id,.replayed_event_count,.replay_version]) | unique | length==1' \
    "$OUTPUT_DIR/v8-corrected.jsonl" "$OUTPUT_DIR/boa-corrected.jsonl" "$OUTPUT_DIR/rust-corrected.jsonl" >/dev/null
jq -n --arg execution_id "$SESSION_ID" --arg revision "$(git rev-parse HEAD)" \
    --arg sqlite "$E2E_TMP/obelisk-sqlite" --arg workflow_sha256 "$(sha256sum "$ROOT/$E2E_REL_WASM" | cut -d ' ' -f 1)" \
    --arg obelisk_version "$("$OBELISK" --version)" --argjson turns "${BENCH_TURNS:-24}" \
    --argjson replay "$(head -1 "$OUTPUT_DIR/v8-corrected.jsonl")" \
    '{execution_id:$execution_id,workflow_revision:$revision,sqlite_directory:$sqlite,
      rust_workflow_sha256:$workflow_sha256,obelisk_version:$obelisk_version,turns:$turns,
      replayed_event_count:$replay.replayed_event_count,replay_version:$replay.replay_version,
      workload:"Local Bash/VFS shell turns: 2000 JSON rows, awk, jq summation, grep/sort/uniq, nested bash, persistent history; no LLM or external tool calls"}' \
    > "$OUTPUT_DIR/corrected-metadata.json"
echo ">>> benchmark results: $OUTPUT_DIR"
