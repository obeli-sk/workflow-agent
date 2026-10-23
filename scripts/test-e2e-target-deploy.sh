#!/usr/bin/env bash
# Proves the agent can redeploy a *separate* target Obelisk instance: author
# a small deployment.toml from inside the agent's own bash session, submit
# it, and apply it live against a fresh, empty target server, then verify
# independently (against the target's own API, not the agent's report) that
# the new component is really serving there - all without ever touching the
# agent's own driving deployment.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
source "$ROOT/scripts/e2e-lib.sh"

API_PORT=28020
EXTERNAL_PORT=28096
e2e_init "target-deploy-e2e" "$API_PORT" "$EXTERNAL_PORT" "e2e-target-deploy-token"
export OBELISK_API_URL="$E2E_API_URL"
unset MCP_SERVER_TOKEN
export AGENT_MODELS="[]"

TARGET_API_PORT=28021
TARGET_EXTERNAL_PORT=28097
# Point the source session's `obelisk` command + deployment mount at the
# separate target server started below (not the self-host default e2e_init
# set up), keyless since the target runs with --no-auth.
export TARGET_OBELISK_TOKEN=""
export TARGET_OBELISK_API_URL="http://127.0.0.1:${TARGET_API_PORT}"

e2e_start_target_server "$TARGET_API_PORT" "$TARGET_EXTERNAL_PORT"

e2e_start_server

RUN_FFQN="obelisk-agent:workflow/workflow.run-cancellable"
UI_BASE="http://127.0.0.1:${EXTERNAL_PORT}"

ORIG_ID="$("$OBELISK" deployment active -a "$E2E_API_URL")"
echo ">>> source active deployment: ${ORIG_ID}"
TARGET_ORIG_ID="$("$OBELISK" deployment active -a "$E2E_TARGET_API_URL")"
echo ">>> target starts empty: ${TARGET_ORIG_ID}"

AUTHOR_DIR="/workspace/authored-target"
AUTHOR_SCRIPT="$(printf '%s\n' \
    "mkdir -p $AUTHOR_DIR/src $AUTHOR_DIR/wit" \
    "printf '%s\\n' '[[activity_js]]' 'name = \"generated\"' 'ffqn = \"test:generated/api.run\"' 'wit = \"wit\"' 'location = \"src/index.js\"' > $AUTHOR_DIR/deployment.toml" \
    "printf '%s\\n' 'import { value } from \"./lib.js\"; export default function run() { return value; }' > $AUTHOR_DIR/src/index.js" \
    "printf '%s\\n' 'export const value = \"target-deploy-ok\";' > $AUTHOR_DIR/src/lib.js" \
    "printf '%s\\n' 'package test:generated; interface api { run: func() -> result<string>; } world impl { export api; }' > $AUTHOR_DIR/wit/world.wit" \
    "NEW_ID=\$(obelisk cloud app deployment submit --allow-missing-runtime-config $AUTHOR_DIR/deployment.toml | jq -r .deployment_id)" \
    'obelisk cloud app deployment apply "$NEW_ID"' \
    'obelisk cloud app deployment pull /workspace/pulled-target' \
    'grep -o obelisk-app-config-v1 /workspace/pulled-target/app.toml' \
    'cat /workspace/pulled-target/src/lib.js' \
    'obelisk cloud app endpoint webhook' \
    'printf "%s\n" '\''export const value = "pulled-deploy-ok";'\'' > /workspace/pulled-target/src/lib.js' \
    'NEW_ID=$(obelisk cloud app deployment submit --allow-missing-runtime-config /workspace/pulled-target/deployment.toml | jq -r .deployment_id)' \
    'obelisk cloud app deployment apply "$NEW_ID"' \
    'printf "APPLIED:%s\n" "$NEW_ID"')"

# A `$`-prefixed opening prompt runs immediately as a direct shell script,
# recorded as shell event id "shell-opened-0" (session.js).
SESSION_ID="$("$OBELISK" generate execution-id)"
PARAMS="$(node -e 'process.stdout.write(JSON.stringify(["$" + process.argv[1], null, null, null, null]))' "$AUTHOR_SCRIPT")"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$SESSION_ID" "$RUN_FFQN" "$PARAMS"

e2e_wait_until e2e_opened_shell_done "$UI_BASE" "$SESSION_ID" \
    || { echo "authored submit+apply did not finish: $PROJECTION" >&2; exit 1; }
OUTPUT="$(node scripts/e2e-json.js shell-event-stdout shell-opened-0 <<<"$PROJECTION")"
AUTHORED_ID="$(printf '%s' "$OUTPUT" | sed -n 's/^APPLIED://p' | tr -d '[:space:]')"
[[ -n "$AUTHORED_ID" ]] || { echo "authored submit+apply script output unexpected: $PROJECTION" >&2; exit 1; }
[[ "$OUTPUT" == *obelisk-app-config-v1* ]] || { echo "the target's app policy was not pulled: $PROJECTION" >&2; exit 1; }
[[ "$OUTPUT" == *'export const value = "target-deploy-ok";'* ]] || { echo "pulled source did not load: $PROJECTION" >&2; exit 1; }
echo ">>> agent session E2E PASS: authored, submitted, and applied a deployment against the target"

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
[[ "$(printf '%s' "$RESULT" | tr -d '[:space:]')" == '{"ok":"pulled-deploy-ok"}' ]] || {
    echo "target's newly deployed function returned unexpected output: $RESULT" >&2
    exit 1
}
echo ">>> target E2E PASS: the target now serves the authored function (${RESULT})"

# The agent's own driving deployment was never touched.
SOURCE_NOW_ID="$("$OBELISK" deployment active -a "$E2E_API_URL")"
[[ "$SOURCE_NOW_ID" == "$ORIG_ID" ]] || {
    echo "source's own active deployment changed from ${ORIG_ID} to ${SOURCE_NOW_ID} - it should never redeploy itself" >&2
    exit 1
}
echo ">>> source E2E PASS: the agent's own deployment was never touched"

# KNOWN-RED: an Obelisk-core replay-finalize gap, not a workflow-agent bug -

"$OBELISK" execution cancel -a "$E2E_API_URL" "$SESSION_ID" >/dev/null || true
echo ">>> E2E PASS: the agent safely redeployed a separate target instance"
