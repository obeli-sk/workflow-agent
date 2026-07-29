#!/usr/bin/env bash
#
# End-to-end test for a no-op redeploy of the *current* deployment.
#
# Starts an ISOLATED Obelisk server (own sqlite dir under a temp path,
# non-default ports, webui off) from the real deployment.toml, then redeploys
# that same deployment through the very tool the agent uses:
# `obelisk-agent:tools/webapi.deployment-submit` with an empty edited-files
# list. This proves the content-addressed submit path: the manifest already
# carries every `content_digest` and every blob is in the CAS, so the submit
# preflight stores a new inactive deployment WITHOUT the agent re-uploading a
# single source or WASM blob (the bug this guards against fetched every
# component back out of the CAS and, for `backtrace.sources`, failed outright).
#
# The isolated server never collides with the user's running instance or
# touches the user's sqlite directory. It is cleaned up on exit.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

# The flake pins the matching obelisk on PATH (see README); override with
# $OBELISK to point at a local build.
OBELISK="${OBELISK:-obelisk}"
API_PORT=28017
EXTERNAL_PORT=28092
API_URL="http://127.0.0.1:${API_PORT}"
SUBMIT_FFQN="obelisk-agent:tools/webapi.deployment-submit"

export OBELISK__API__TOKEN="e2e-redeploy-token"
# The webapi activities target the server through OBELISK_API_URL; point them at
# this isolated port (and its regex-escaped form for the allowed_host guard)
# instead of the manifest's :5005 default so the redeploy hits *this* server.
export OBELISK_API_URL="${API_URL}"
export OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:${API_PORT}"
# Required for the manifest to load at all (the llm activity declares it a hard
# env requirement); an empty catalog is fine, this test never calls an LLM.
export AGENT_MODELS="[]"

TMP="$(mktemp -d -t redeploy-e2e-XXXXXX)"
# Deployment manifests reject absolute local `location` paths, so the generated
# manifest lives at the repo root (obelisk runs with root as CWD) and every
# `location` in it is root-relative.
DEPLOY="$ROOT/.e2e-redeploy-deployment.toml"
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

# Ask cargo where the artifact really is (workspace vs CARGO_TARGET_DIR); see
# the sibling e2e scripts for why hand-deriving this path is wrong.
TARGET_DIR="$(cd "$ROOT/workflow/workflow-rs" && cargo metadata --no-deps --format-version=1 \
    | tr ',' '\n' | sed -n 's/.*"target_directory":"\(.*\)"/\1/p' | head -1)"
WASM="$TARGET_DIR/wasm32-unknown-unknown/release/workflow_agent_rs.wasm"
[[ -f "$WASM" ]] || { echo "wasm not found at $WASM" >&2; exit 1; }
REL_WASM="$(realpath --relative-to="$ROOT" "$WASM")"

echo ">>> generating deployment manifest from deployment.toml (workflow_wasm location -> ${REL_WASM})"
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

echo ">>> waiting for the server to become ready"
SECONDS=0
until "$OBELISK" component list -a "$API_URL" >/dev/null 2>&1; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "server exited early; log:" >&2; cat "$TMP/server.log" >&2; exit 1
    fi
    [[ $SECONDS -ge 90 ]] && { echo "timeout waiting for server" >&2; cat "$TMP/server.log" >&2; exit 1; }
    sleep 1
done

ORIG_ID="$("$OBELISK" deployment active -a "$API_URL")"
echo ">>> active deployment: ${ORIG_ID}"

# The stored manifest carries a content_digest for every owned file; that is
# exactly what the submit tool needs when no source was edited.
echo ">>> fetching the stored manifest (verbatim, with digests)"
"$OBELISK" deployment show -a "$API_URL" "$ORIG_ID" > "$TMP/manifest.toml"
[[ -s "$TMP/manifest.toml" ]] || { echo "empty manifest from deployment show" >&2; exit 1; }

# deployment-submit(deployment-toml, edited-files-json, description,
#                   allow-missing-runtime-config, deployment-id). No edited
# files: a pure redeploy that must upload nothing. python3 (from the devshell)
# JSON-encodes the manifest so this needs no jq/node on PATH.
python3 -c 'import json,sys; toml=open(sys.argv[1]).read(); sys.stdout.write(json.dumps([toml, "[]", "e2e no-op redeploy", False, ""]))' \
    "$TMP/manifest.toml" > "$TMP/params.json"

EXEC_ID="$("$OBELISK" generate execution-id)"
echo ">>> redeploying via ${SUBMIT_FFQN} as ${EXEC_ID} (empty edited-files list)"
"$OBELISK" execution submit -a "$API_URL" -e "$EXEC_ID" "$SUBMIT_FFQN" @"$TMP/params.json"

echo ">>> fetching result"
RESULT="$("$OBELISK" execution result --follow -j -a "$API_URL" "$EXEC_ID")"
echo "$RESULT"

# The tool returns result<string, string>; success is {"ok": "<json>"} whose
# inner json carries the new deployment_id. A failure ({"err": ...}) or the
# old "no component with location ..." regression fails the grep below.
if ! grep -q '"ok"' <<<"$RESULT" || ! grep -q "deployment_id" <<<"$RESULT"; then
    echo ">>> E2E FAIL: redeploy did not return an ok deployment_id" >&2
    exit 1
fi

NEW_ID="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.loads(d["ok"])["deployment_id"])' <<<"$RESULT")"
echo ">>> redeployed as new inactive deployment: ${NEW_ID}"
if [[ -z "$NEW_ID" || "$NEW_ID" == "null" ]]; then
    echo ">>> E2E FAIL: no deployment_id in redeploy result" >&2
    exit 1
fi
if [[ "$NEW_ID" == "$ORIG_ID" ]]; then
    echo ">>> E2E FAIL: redeploy returned the original deployment id (no new deployment stored)" >&2
    exit 1
fi

echo ">>> E2E PASS: redeployed the current deployment with no source uploads; server stored a new"
echo "    inactive deployment (${ORIG_ID} -> ${NEW_ID}) purely from the content-addressed store."
