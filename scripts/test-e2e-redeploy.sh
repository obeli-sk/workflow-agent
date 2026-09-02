#!/usr/bin/env bash
# Usage: test-e2e-redeploy.sh [rs|js]  (default rs)

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
source "$ROOT/scripts/e2e-lib.sh"

BACKEND="${1:-rs}"
e2e_init "redeploy-e2e-$BACKEND" 28017 28092 "e2e-redeploy-token"
export OBELISK_API_URL="$E2E_API_URL"
export OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:28017"
# server.toml's [secrets] requires every named var to exist; empty is fine.
export MCP_SERVER_TOKEN=""
export GITHUB_TOKEN=""
export AGENT_MODELS="[]"

e2e_select_backend "$BACKEND"
DEPLOY="$ROOT/.e2e-redeploy-deployment.toml"
e2e_patch_workflow_manifest "$DEPLOY"
e2e_start_server "$DEPLOY"

ORIG_ID="$("$OBELISK" deployment active -a "$E2E_API_URL")"
echo ">>> active deployment: ${ORIG_ID}"
"$OBELISK" deployment show -a "$E2E_API_URL" "$ORIG_ID" > "$E2E_TMP/manifest.toml"
[[ -s "$E2E_TMP/manifest.toml" ]] || { echo "empty manifest from deployment show" >&2; exit 1; }

node scripts/e2e-json.js redeploy-params "$E2E_TMP/manifest.toml" > "$E2E_TMP/params.json"
EXEC_ID="$("$OBELISK" generate execution-id)"
SUBMIT_FFQN="obelisk-agent:tools/webapi.deployment-submit"
echo ">>> redeploying via ${SUBMIT_FFQN} as ${EXEC_ID} (no attachments)"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$EXEC_ID" "$SUBMIT_FFQN" @"$E2E_TMP/params.json"

echo ">>> fetching result"
RESULT="$("$OBELISK" execution result --follow -j -a "$E2E_API_URL" "$EXEC_ID")"

if ! grep -q '"ok"' <<<"$RESULT"; then
    echo ">>> E2E FAIL: redeploy did not return an ok deployment id" >&2
    echo "$RESULT" >&2
    exit 1
fi

NEW_ID="$(node scripts/e2e-json.js deployment-id <<<"$RESULT")"
echo ">>> redeployed as new inactive deployment: ${NEW_ID}"
if [[ -z "$NEW_ID" || "$NEW_ID" == "null" || "$NEW_ID" == "$ORIG_ID" ]]; then
    echo ">>> E2E FAIL: redeploy did not create a new deployment" >&2
    exit 1
fi

echo ">>> E2E PASS: redeployed from the content-addressed store (${ORIG_ID} -> ${NEW_ID})"

UI_BASE="http://127.0.0.1:28092"
RUN_FFQN="obelisk-agent:workflow/workflow.run-cancellable"
AUTHORED_ID="$("$OBELISK" generate deployment-id)"
AUTHOR_DIR="/workspace/deployment/$AUTHORED_ID"
AUTHOR_SCRIPT="$(printf '%s\n' \
    "mkdir -p $AUTHOR_DIR/src $AUTHOR_DIR/wit" \
    "printf '%s\\n' '[[activity_js]]' 'name = \"generated\"' 'ffqn = \"test:generated/api.run\"' 'wit = \"wit\"' 'location = \"src/index.js\"' > $AUTHOR_DIR/deployment.toml" \
    "printf '%s\\n' 'import { value } from \"./lib.js\"; export default function run() { return value; }' > $AUTHOR_DIR/src/index.js" \
    "printf '%s\\n' 'export const value = { ok: \"ok\" };' > $AUTHOR_DIR/src/lib.js" \
    "printf '%s\\n' 'package test:generated; interface api { run: func() -> result<string>; } world impl { export api; }' > $AUTHOR_DIR/wit/world.wit" \
    "obelisk deployment submit --allow-missing-runtime-config $AUTHOR_DIR")"
SESSION_ID="$("$OBELISK" generate execution-id)"
PARAMS="$(node -e 'process.stdout.write(JSON.stringify(["$" + process.argv[1], null, null, null, null]))' "$AUTHOR_SCRIPT")"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$SESSION_ID" "$RUN_FFQN" "$PARAMS"
SECONDS=0
while true; do
    PROJECTION="$(curl --fail --silent "$UI_BASE/api/runs/$SESSION_ID" || true)"
    if node scripts/e2e-json.js check-shell-event-done shell-opened-0 <<<"$PROJECTION" 2>/dev/null; then
        break
    fi
    [[ $SECONDS -ge 60 ]] && { echo "authored submit did not finish: $PROJECTION" >&2; exit 1; }
    sleep 1
done
OUTPUT="$(node scripts/e2e-json.js shell-event-stdout shell-opened-0 <<<"$PROJECTION")"
[[ "$OUTPUT" == *"$AUTHORED_ID"* ]] || { echo "authored submit failed: $PROJECTION" >&2; exit 1; }
"$OBELISK" execution cancel -a "$E2E_API_URL" "$SESSION_ID" >/dev/null || true
echo ">>> E2E PASS: the session submitted an authored WIT plus a multi-file JS graph"
