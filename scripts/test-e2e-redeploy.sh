#!/usr/bin/env bash

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
source "$ROOT/scripts/e2e-lib.sh"

e2e_init "redeploy-e2e" 28017 28092 "e2e-redeploy-token"
export OBELISK_API_URL="$E2E_API_URL"
export OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:28017"
export AGENT_MODELS="[]"

e2e_build_component "workflow/workflow-rs" "workflow_agent_rs.wasm"
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
echo ">>> redeploying via ${SUBMIT_FFQN} as ${EXEC_ID} (empty edited-files list)"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$EXEC_ID" "$SUBMIT_FFQN" @"$E2E_TMP/params.json"

echo ">>> fetching result"
RESULT="$("$OBELISK" execution result --follow -j -a "$E2E_API_URL" "$EXEC_ID")"

if ! grep -q '"ok"' <<<"$RESULT" || ! grep -q "deployment_id" <<<"$RESULT"; then
    echo ">>> E2E FAIL: redeploy did not return an ok deployment_id" >&2
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
