#!/usr/bin/env bash
# Proves the agent can redeploy a *separate* target Obelisk instance: author
# a small deployment.toml from inside the agent's own bash session, submit
# it, and apply it live against a fresh, empty target server, then verify
# independently (against the target's own API, not the agent's report) that
# the new component is really serving there - all without ever touching the
# agent's own driving deployment.
#
# This replaces the former same-instance rs<->js replay-parity design: that
# test hot-swapped a *running* session's own component between two different
# language implementations of itself via `deployment apply` on its own
# server. Any hot redeploy where source and target are the same instance is
# risky by construction - the driving FFQN (or the deployment-apply tooling
# itself) might not even exist in the swapped-in manifest - and it is not
# how workflow-agent is meant to operate: it always redeploys a separate
# TARGET_OBELISK instance, never itself (see README.md's "Target instance"
# section and this repo's TARGET_OBELISK_* env vars). The old test happened
# to also surface a real
# Obelisk-core gap (the JS workflow runtime's generic `join-next` doesn't
# track `requested_ffqn` the way Rust's typed extension bindings do, so an
# in-flight auto-upgrade replay under JS fails nondeterminism-detected and
# strands the session - see git history / obelisk's
# crates/workflow-js-runtime for that limitation), but that gap is about
# auto-upgrading a *live* execution, an unsafe operation this suite no
# longer exercises, so it's no longer this repo's concern to keep red for.
#
# Runs for both rs and js SOURCE backends (the agent side); the target is
# backend-agnostic, a plain generated JS activity.
# Usage: test-e2e-target-deploy.sh [rs|js]  (default rs)

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
source "$ROOT/scripts/e2e-lib.sh"

BACKEND="${1:-rs}"
e2e_init "target-deploy-e2e-$BACKEND" 28020 28096 "e2e-target-deploy-token"
export OBELISK_API_URL="$E2E_API_URL"
export OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:28020"
# server.toml's [secrets] requires every named var to exist; empty is fine.
export MCP_SERVER_TOKEN=""
export GITHUB_TOKEN=""
export AGENT_MODELS="[]"

TARGET_API_PORT=28021
TARGET_EXTERNAL_PORT=28097
# Point the source session's `obelisk` command + deployment mount at the
# separate target server started below (not the self-host default e2e_init
# set up), keyless since the target runs with --no-auth.
export TARGET_OBELISK_TOKEN=""
export TARGET_OBELISK_API_URL="http://127.0.0.1:${TARGET_API_PORT}"
export TARGET_OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:${TARGET_API_PORT}"

e2e_start_target_server "$TARGET_API_PORT" "$TARGET_EXTERNAL_PORT"

e2e_select_backend "$BACKEND"
DEPLOY="$ROOT/.e2e-target-deploy-deployment.toml"
e2e_patch_workflow_manifest "$DEPLOY"
e2e_start_server "$DEPLOY"

RUN_FFQN="obelisk-agent:workflow/workflow.run-cancellable"
UI_BASE="http://127.0.0.1:28096"

ORIG_ID="$("$OBELISK" deployment active -a "$E2E_API_URL")"
echo ">>> source (${BACKEND}) active deployment: ${ORIG_ID}"
TARGET_ORIG_ID="$("$OBELISK" deployment active -a "$E2E_TARGET_API_URL")"
echo ">>> target starts empty: ${TARGET_ORIG_ID}"

AUTHORED_ID="$("$OBELISK" generate deployment-id)"
AUTHOR_DIR="/workspace/deployment/$AUTHORED_ID"
AUTHOR_SCRIPT="$(printf '%s\n' \
    "mkdir -p $AUTHOR_DIR/src $AUTHOR_DIR/wit" \
    "printf '%s\\n' '[[activity_js]]' 'name = \"generated\"' 'ffqn = \"test:generated/api.run\"' 'wit = \"wit\"' 'location = \"src/index.js\"' > $AUTHOR_DIR/deployment.toml" \
    "printf '%s\\n' 'import { value } from \"./lib.js\"; export default function run() { return value; }' > $AUTHOR_DIR/src/index.js" \
    "printf '%s\\n' 'export const value = \"target-deploy-ok\";' > $AUTHOR_DIR/src/lib.js" \
    "printf '%s\\n' 'package test:generated; interface api { run: func() -> result<string>; } world impl { export api; }' > $AUTHOR_DIR/wit/world.wit" \
    "obelisk deployment submit --allow-missing-runtime-config $AUTHOR_DIR" \
    "obelisk deployment apply $AUTHORED_ID")"

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
    [[ $SECONDS -ge 60 ]] && { echo "authored submit+apply did not finish: $PROJECTION" >&2; exit 1; }
    sleep 1
done
OUTPUT="$(node scripts/e2e-json.js shell-event-stdout shell-opened-0 <<<"$PROJECTION")"
[[ "$OUTPUT" == *"$AUTHORED_ID"* ]] || { echo "authored submit+apply script output unexpected: $PROJECTION" >&2; exit 1; }
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
[[ "$(printf '%s' "$RESULT" | tr -d '[:space:]')" == '{"ok":"target-deploy-ok"}' ]] || {
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
echo ">>> source E2E PASS: the agent's own (${BACKEND}) deployment was never touched"

"$OBELISK" execution cancel -a "$E2E_API_URL" "$SESSION_ID" >/dev/null || true
echo ">>> E2E PASS: the agent (${BACKEND}) safely redeployed a separate target instance"
