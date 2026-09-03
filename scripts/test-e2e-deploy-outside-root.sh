#!/usr/bin/env bash
# Proves `obelisk deployment submit` works from a manifest that does NOT
# live under /workspace/deployment/<id> - e.g. a manifest checked out
# straight from a source repo - and that the resulting deployment genuinely
# activates and serves on the target.
#
# Regression coverage for two bugs found in the same DEPLOYMENT_ROOT-shaped
# assumption:
#   - PATH resolution used to only accept a path literally named
#     "deployment.toml", or a directory (looking for "deployment.toml"
#     inside it); any other manifest filename or a plain source-tree
#     location was rejected or silently mishandled.
#   - deployment_id was derived from the manifest's parent directory's
#     basename (empty only when literally "current"), a convention that
#     only holds for DEPLOYMENT_ROOT/<id> checkouts. Submitting from
#     anywhere else sent that unrelated directory's basename as the
#     deployment_id and the server rejected it with "invalid deployment_id:
#     wrong prefix" (E_01M1MG45ERCAGDE47WQX2GTAEY) instead of letting it
#     assign a fresh one.
#
# Mirrors test-e2e-target-deploy.sh's shape (separate target instance,
# verified independently against the target's own API) but authors the
# manifest under a plain scratch directory instead of
# /workspace/deployment/<id>, with a filename that isn't literally
# "deployment.toml" either, so both bugs are exercised at once.
#
# Runs for both rs and js SOURCE backends (the agent side); the target is
# backend-agnostic, a plain generated JS activity.
# Usage: test-e2e-deploy-outside-root.sh [rs|js]  (default rs)

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
source "$ROOT/scripts/e2e-lib.sh"

BACKEND="${1:-rs}"
e2e_init "deploy-outside-root-e2e-$BACKEND" 28030 28098 "e2e-deploy-outside-root-token"
export OBELISK_API_URL="$E2E_API_URL"
export OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:28030"
# server.toml's [secrets] requires every named var to exist; empty is fine.
export MCP_SERVER_TOKEN=""
export GITHUB_TOKEN=""
export AGENT_MODELS="[]"

TARGET_API_PORT=28031
TARGET_EXTERNAL_PORT=28099
# Point the source session's `obelisk` command + deployment mount at the
# separate target server started below (not the self-host default e2e_init
# set up), keyless since the target runs with --no-auth.
export TARGET_OBELISK_TOKEN=""
export TARGET_OBELISK_API_URL="http://127.0.0.1:${TARGET_API_PORT}"
export TARGET_OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:${TARGET_API_PORT}"

e2e_start_target_server "$TARGET_API_PORT" "$TARGET_EXTERNAL_PORT"

e2e_select_backend "$BACKEND"
DEPLOY="$ROOT/.e2e-deploy-outside-root-deployment.toml"
e2e_patch_workflow_manifest "$DEPLOY"
e2e_start_server "$DEPLOY"

RUN_FFQN="obelisk-agent:workflow/workflow.run-cancellable"
UI_BASE="http://127.0.0.1:28098"

TARGET_ORIG_ID="$("$OBELISK" deployment active -a "$E2E_TARGET_API_URL")"
echo ">>> target starts empty: ${TARGET_ORIG_ID}"

# Deliberately outside DEPLOYMENT_ROOT (/workspace/deployment), and named
# unlike the literal "deployment.toml", to exercise both fixed bugs: PATH
# resolution and deployment_id derivation must both cope with a manifest
# that looks nothing like a DEPLOYMENT_ROOT/<id> checkout.
AUTHOR_DIR="/workspace/outside-deployment-root"
MANIFEST_NAME="my-app.toml"
AUTHOR_SCRIPT="$(printf '%s\n' \
    "mkdir -p $AUTHOR_DIR/src $AUTHOR_DIR/wit" \
    "printf '%s\\n' '[[activity_js]]' 'name = \"generated\"' 'ffqn = \"test:generated/api.run\"' 'wit = \"wit\"' 'location = \"src/index.js\"' > $AUTHOR_DIR/$MANIFEST_NAME" \
    "printf '%s\\n' 'import { value } from \"./lib.js\"; export default function run() { return value; }' > $AUTHOR_DIR/src/index.js" \
    "printf '%s\\n' 'export const value = \"outside-root-deploy-ok\";' > $AUTHOR_DIR/src/lib.js" \
    "printf '%s\\n' 'package test:generated; interface api { run: func() -> result<string>; } world impl { export api; }' > $AUTHOR_DIR/wit/world.wit" \
    "NEW_ID=\$(obelisk deployment submit --allow-missing-runtime-config $AUTHOR_DIR/$MANIFEST_NAME | jq -r .deployment_id)" \
    "obelisk deployment apply \"\$NEW_ID\"" \
    "echo APPLIED:\$NEW_ID")"

# A `$`-prefixed opening prompt runs immediately as a direct shell script,
# recorded as shell event id "shell-opened-0" (session.rs/session.js).
SESSION_ID="$("$OBELISK" generate execution-id)"
PARAMS="$(node -e 'process.stdout.write(JSON.stringify(["$" + process.argv[1], null, null, null, null]))' "$AUTHOR_SCRIPT")"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$SESSION_ID" "$RUN_FFQN" "$PARAMS"

SECONDS=0
PROJECTION=""
while true; do
    PROJECTION="$(curl --fail --silent "$UI_BASE/api/runs/$SESSION_ID" || true)"
    if node scripts/e2e-json.js check-shell-event-done shell-opened-0 <<<"$PROJECTION" 2>/dev/null; then
        break
    fi
    [[ $SECONDS -ge 60 ]] && { echo "author+submit+apply did not finish: $PROJECTION" >&2; exit 1; }
    sleep 1
done
OUTPUT="$(node scripts/e2e-json.js shell-event-stdout shell-opened-0 <<<"$PROJECTION")"
AUTHORED_ID="$(printf '%s' "$OUTPUT" | sed -n 's/^APPLIED://p' | tr -d '[:space:]')"
[[ -n "$AUTHORED_ID" ]] || { echo "did not capture a server-assigned deployment id: $PROJECTION" >&2; exit 1; }
echo ">>> agent session E2E PASS: authored outside DEPLOYMENT_ROOT, submitted, and applied (id: ${AUTHORED_ID})"

# Verify independently against the target's own API - not the agent's
# report - that the new deployment is really active and really serving.
TARGET_NOW_ID="$("$OBELISK" deployment active -a "$E2E_TARGET_API_URL")"
[[ "$TARGET_NOW_ID" == "$AUTHORED_ID" ]] || {
    echo "target's active deployment is ${TARGET_NOW_ID}, expected ${AUTHORED_ID}" >&2
    exit 1
}
CHECK_EXEC_ID="$("$OBELISK" generate execution-id)"
"$OBELISK" execution submit -a "$E2E_TARGET_API_URL" -e "$CHECK_EXEC_ID" test:generated/api.run '[]' >/dev/null
RESULT="$("$OBELISK" execution result --follow -j -a "$E2E_TARGET_API_URL" "$CHECK_EXEC_ID")"
[[ "$(printf '%s' "$RESULT" | tr -d '[:space:]')" == '{"ok":"outside-root-deploy-ok"}' ]] || {
    echo "target's newly deployed function returned unexpected output: $RESULT" >&2
    exit 1
}
echo ">>> target E2E PASS: the target now serves the authored function (${RESULT})"

"$OBELISK" execution cancel -a "$E2E_API_URL" "$SESSION_ID" >/dev/null || true
echo ">>> E2E PASS: the agent (${BACKEND}) submitted+applied a manifest from outside DEPLOYMENT_ROOT and the target ended up with a working deployment"
