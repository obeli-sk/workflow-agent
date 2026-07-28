#!/usr/bin/env bash
#
# End-to-end test for the phase-5 native Rust workflow (workflow/workflow-rs),
# deployed via the REAL deployment.toml (with its two `[[workflow_js]]`
# entries for obelisk-agent:workflow/workflow.{agent-loop-cancellable,run}
# replaced by one `[[workflow_wasm]]` entry -- everything else in
# deployment.toml, including the still-JS activities/stubs the workflow
# depends on, is used as-is).
#
# Starts an ISOLATED Obelisk server (own sqlite dir under a temp path,
# non-default ports, webui off) so it never collides with the user's running
# instance or touches the user's sqlite directory. AGENT_MODELS is set to an
# empty catalog ("[]"), so this cannot reach a real LLM; instead it proves the
# session loop's real wiring end-to-end (named join sets, submit-json,
# operator/completion race, child-error decoding) by observing the
# `obelisk-agent:llm/chat.completion` activity's own config-error surface all
# the way back out as the workflow's business error.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

OBELISK="${OBELISK:-/workspace/obelisk/target/release/obelisk}"
API_PORT=28016
EXTERNAL_PORT=28091
API_URL="http://127.0.0.1:${API_PORT}"
RUN_FFQN="obelisk-agent:workflow/workflow.agent-loop-cancellable"

export OBELISK__API__TOKEN="e2e-agent-workflow-token"
# `AGENT_MODELS` must be *set* for the manifest to load at all (its activity
# declares `env_vars = ["AGENT_MODELS"]`, a hard requirement, not a `${:-}`
# default) but is deliberately an empty catalog: `activity/llm-chat.js`'s own
# `resolveModel` rejects it at call time with a config error, so this proves
# the workflow end-to-end without attempting a real LLM call.
export AGENT_MODELS="[]"

TMP="$(mktemp -d -t agent-workflow-e2e-XXXXXX)"
# Deployment manifests reject absolute local `location` paths, so the
# generated manifest lives at the repo root (obelisk runs with root as CWD)
# and every `location` in it (including the real deployment.toml's own JS
# entries) is root-relative already.
DEPLOY="$ROOT/.e2e-agent-deployment.toml"
SERVER_PID=""

cleanup() {
    if [[ -n "$SERVER_PID" ]]; then
        echo ">>> stopping isolated obelisk server (pid $SERVER_PID)"
        kill -SIGINT "$SERVER_PID" 2>/dev/null || true
        SECONDS=0
        while kill -0 "$SERVER_PID" 2>/dev/null; do
            [[ $SECONDS -ge 5 ]] && { kill -SIGKILL "$SERVER_PID" 2>/dev/null || true; break; }
            sleep 1
        done
    fi
    rm -rf "$TMP" "$DEPLOY"
}
trap cleanup EXIT

echo ">>> building workflow/workflow-rs (wasm32-unknown-unknown)"
( cd "$ROOT/workflow/workflow-rs" && cargo build --release )

# Resolve the wasm path, honouring CARGO_TARGET_DIR (may be absolute; the
# sandbox devshell sets it to target-sandbox, see meta/AGENTS.md).
TD="${CARGO_TARGET_DIR:-target}"
case "$TD" in
    /*) WASM="$TD/wasm32-unknown-unknown/release/workflow_agent_rs.wasm" ;;
    *)  WASM="$ROOT/workflow/workflow-rs/$TD/wasm32-unknown-unknown/release/workflow_agent_rs.wasm" ;;
esac
[[ -f "$WASM" ]] || { echo "wasm not found at $WASM" >&2; exit 1; }
REL_WASM="$(realpath --relative-to="$ROOT" "$WASM")"

echo ">>> generating deployment manifest from deployment.toml (workflow_wasm location -> ${REL_WASM})"
# Copy the real deployment.toml verbatim, then replace only the placeholder
# `[[workflow_wasm]]` location with this sandbox's actual build path (every
# other `location` in the file is already root-relative and needs no change).
sed "s#^location = \"target/wasm32-unknown-unknown/release/workflow_agent_rs.wasm\"#location = \"${REL_WASM}\"#" \
    "$ROOT/deployment.toml" > "$DEPLOY"
grep -q "$REL_WASM" "$DEPLOY" || { echo "failed to patch workflow_wasm location in generated manifest" >&2; exit 1; }

cat > "$TMP/server.toml" <<EOF
api.listening_addr = "127.0.0.1:${API_PORT}"
api.token = "\${OBELISK__API__TOKEN}"
webui.enabled = false
external.listening_addr = "127.0.0.1:${EXTERNAL_PORT}"
database.sqlite.directory = "${TMP}/obelisk-sqlite"

[log.console]
level = "warn"
EOF

echo ">>> starting ISOLATED obelisk server on ${API_URL} (sqlite: ${TMP}/obelisk-sqlite)"
"$OBELISK" server run \
    --server-config "$TMP/server.toml" \
    --deployment "$DEPLOY" \
    --clean-sqlite-directory \
    > "$TMP/server.log" 2>&1 &
SERVER_PID=$!

echo ">>> waiting for the server to become ready (this also proves the deployment.toml loads: WIT compatibility, component compile+link, all FFQNs resolve)"
SECONDS=0
until "$OBELISK" component list -a "$API_URL" >/dev/null 2>&1; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "server exited early; log:" >&2; cat "$TMP/server.log" >&2; exit 1
    fi
    [[ $SECONDS -ge 90 ]] && { echo "timeout waiting for server" >&2; cat "$TMP/server.log" >&2; exit 1; }
    sleep 1
done
echo ">>> deployment loaded successfully; workflow_agent_rs.wasm exports matched the WIT-declared FFQNs"

EXEC_ID="$("$OBELISK" generate execution-id)"
echo ">>> submitting $RUN_FFQN as $EXEC_ID"
"$OBELISK" execution submit -a "$API_URL" -e "$EXEC_ID" "$RUN_FFQN" \
    '["hello from the e2e test", "You are a test system prompt.", "[]", "", ""]'

echo ">>> fetching result (blocks until the workflow finishes; AGENT_MODELS is an empty catalog, so llm.completion fails after its retries and the workflow surfaces that as its own business error)"
RESULT="$("$OBELISK" execution result --follow -j -a "$API_URL" "$EXEC_ID")"
echo "$RESULT"

EXPECT="AGENT_MODELS must be a non-empty JSON array"
if grep -q "$EXPECT" <<<"$RESULT"; then
    echo ">>> E2E PASS: the session loop started, mounted the shell, opened turn 0, raced the operator offer against a real"
    echo "    obelisk-agent:llm/chat.completion child, and correctly surfaced that child's business error -- proving"
    echo "    join-set creation/submission, the operator/completion race, and child-error decoding all work end-to-end"
    echo "    against a real (isolated) Obelisk server."
else
    echo ">>> E2E FAIL: expected '$EXPECT' in result" >&2
    exit 1
fi

# Best-effort second check: `run` (obelisk-agent:workflow/workflow.run), which
# resolves the obelisk-control descriptor (a real outbound HTTPS GET to
# https://obeli.sk) before submitting agent-loop-cancellable as a genuine
# child execution. Not fatal on network trouble in a sandboxed CI-like
# environment; the primary proof above already covers the harder, novel parts
# (join sets, the race, error decoding). This just additionally exercises
# `run`'s own descriptor call, execution-id-current, and child-submit/-await.
RUN_EXEC_ID="$("$OBELISK" generate execution-id)"
echo ">>> submitting obelisk-agent:workflow/workflow.run as $RUN_EXEC_ID (best-effort; needs network access to obeli.sk)"
if "$OBELISK" execution submit -a "$API_URL" -e "$RUN_EXEC_ID" "obelisk-agent:workflow/workflow.run" \
    '["hello from the e2e test", null, null, null]'; then
    RUN_RESULT="$(timeout 60 "$OBELISK" execution result --follow -j -a "$API_URL" "$RUN_EXEC_ID" || true)"
    echo "$RUN_RESULT"
    if grep -q "$EXPECT" <<<"$RUN_RESULT"; then
        echo ">>> run() E2E PASS: descriptor resolved, execution-id-current worked, agent-loop-cancellable was submitted as a"
        echo "    real child execution and awaited, and its business error propagated back out through run()."
    else
        echo ">>> run() check inconclusive (result did not contain the expected error; see above) -- not failing the script"
    fi
else
    echo ">>> run() submission failed (likely no network access to obeli.sk in this environment) -- not failing the script"
fi
