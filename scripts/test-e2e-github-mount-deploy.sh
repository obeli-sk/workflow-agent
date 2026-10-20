#!/usr/bin/env bash
# Proves the actual real-world regression end to end: `obelisk cloud app deployment
# submit` on this app's own deployment.js.toml, fetched cold through the
# GitHub-backed apps/<name> mount (obelisk-agent:mounts/apps.request),
# with zero prior ls/readdir anywhere in the tree - exactly reproducing
# E_01M1MFSEK7GXAJWFN4N3GGAZRN / E_01M1MG45ERCAGDE47WQX2GTAEY, where a
# multi-level-deep file (packs/obelisk-control/descriptor.js, then
# activity/config-discover.js) always misreported "No such file or
# directory" until every intermediate directory had been listed by hand.
#
# The other two deploy e2e suites are deliberately hermetic
# (test-e2e-target-deploy.sh, test-e2e-deploy-outside-root.sh: APPS_JSON=[])
# and never touch the GitHub web-mount overlay at all; the ensure_expanded
# regression itself is unit-tested with a fake DirProvider in
# fs.test.js/fs.rs (hermetic, no network - see 26faa0b). This suite is the
# one place that proves the fix through the real
# obelisk-agent:mounts/apps.request activity and its HTTP round trips,
# submitting this app's OWN unmodified deployment.js.toml to the target,
# fetched entirely through the mount.
#
# Unlike the other two suites, this one deliberately stops at *submit*, not
# apply/activate. The real app's deployment.js.toml has real runtime
# requirements (5 secrets, 31 outbound_http destinations - LLM, GitHub, the
# target's own control-plane calls, etc.); hot-*activating* it against a
# bare `--empty --no-auth` target with no app policy grants does not work
# (verified: switch_deployment retries its config-warning check in a loop
# and never completes) and would need a large amount of unrelated
# config-matching work, none of which is what this suite exists to prove.
# A successful `submit` already re-verifies the whole manifest and
# type-checks every referenced component server-side, which is exactly
# where all three fixed bugs (PATH resolution, deployment_id, cold
# multi-level VFS access) actually manifested - "the target has a working
# deployment" is checked by independently listing it back from the
# target's own API afterward.
#
# The GitHub contents API is served by scripts/e2e-github-server.mjs from this
# checkout's working tree, so the run is hermetic and needs no token or push.
#
# Usage: test-e2e-github-mount-deploy.sh [rs|js]  (default rs)

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

source "$ROOT/scripts/e2e-lib.sh"

BACKEND="${1:-rs}"
PORT_OFFSET=$(e2e_backend_port_offset "$BACKEND")
API_PORT=$((28040 + PORT_OFFSET))
EXTERNAL_PORT=$((28100 + PORT_OFFSET))
e2e_init "github-mount-deploy-e2e-$BACKEND" "$API_PORT" "$EXTERNAL_PORT" "e2e-github-mount-deploy-token"
export OBELISK_API_URL="$E2E_API_URL"
export OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:${API_PORT}"
unset MCP_SERVER_TOKEN
export AGENT_MODELS="[]"
# Mounts this checkout at /workspace/apps/workflow-agent, matching the real-world failure.
e2e_start_github_mock "obeli-sk/workflow-agent=$ROOT"
export APPS_JSON='[{"name":"workflow-agent","repo":"workflow-agent"}]'

TARGET_API_PORT=$((28041 + PORT_OFFSET))
TARGET_EXTERNAL_PORT=$((28101 + PORT_OFFSET))
# Point the source session's `obelisk` command + deployment mount at the
# separate target server started below (not the self-host default e2e_init
# set up), keyless since the target runs with --no-auth.
export TARGET_OBELISK_TOKEN=""
export TARGET_OBELISK_API_URL="http://127.0.0.1:${TARGET_API_PORT}"
export TARGET_OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:${TARGET_API_PORT}"

e2e_start_target_server "$TARGET_API_PORT" "$TARGET_EXTERNAL_PORT"

e2e_select_backend "$BACKEND"
DEPLOY="$ROOT/.e2e-github-mount-deploy-deployment-$BACKEND.toml"
e2e_patch_workflow_manifest "$DEPLOY"
e2e_start_server "$DEPLOY"

RUN_FFQN="obelisk-agent:workflow/workflow.run-cancellable"
UI_BASE="http://127.0.0.1:${EXTERNAL_PORT}"

# Cold: no ls/readdir anywhere first, exactly like the real failure.
# Submits this app's own real deployment.js.toml, fetched entirely through
# the GitHub mount. --allow-missing-runtime-config tolerates the target
# having none of the real app's outbound_http/secrets configured (storage
# still fully re-verifies and type-checks every component).
AUTHOR_SCRIPT="$(printf '%s\n' \
    "SUBMIT_OUT=\$(obelisk cloud app deployment submit --allow-missing-runtime-config /workspace/apps/workflow-agent/deployment.js.toml)" \
    "SUBMIT_CODE=\$?" \
    "echo SUBMIT_OUTPUT:\$SUBMIT_OUT" \
    "if [ \$SUBMIT_CODE -ne 0 ]; then echo SUBMIT_FAILED; exit 1; fi" \
    "NEW_ID=\$(echo \"\$SUBMIT_OUT\" | jq -r .deployment_id)" \
    "echo SUBMITTED:\$NEW_ID")"

# A `$`-prefixed opening prompt runs immediately as a direct shell script,
# recorded as shell event id "shell-opened-0" (session.rs/session.js).
SESSION_ID="$("$OBELISK" generate execution-id)"
PARAMS="$(node -e 'process.stdout.write(JSON.stringify(["$" + process.argv[1], null, null, null, null]))' "$AUTHOR_SCRIPT")"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$SESSION_ID" "$RUN_FFQN" "$PARAMS"

e2e_wait_until e2e_opened_shell_done "$UI_BASE" "$SESSION_ID" \
    || { echo "cold GitHub-mounted submit did not finish: $PROJECTION" >&2; exit 1; }
OUTPUT="$(node scripts/e2e-json.js shell-event-stdout shell-opened-0 <<<"$PROJECTION")"
AUTHORED_ID="$(printf '%s' "$OUTPUT" | sed -n 's/^SUBMITTED://p' | tr -d '[:space:]')"
[[ -n "$AUTHORED_ID" ]] || { echo "did not capture a server-assigned deployment id: $PROJECTION" >&2; echo "shell output: $OUTPUT" >&2; exit 1; }
echo ">>> agent session E2E PASS: cold GitHub-mounted submit of the real deployment.js.toml (id: ${AUTHORED_ID})"

# Verify independently against the target's own API - not the agent's
# report - that the deployment was really stored there: `deployment list`
# re-reads it back from the target's own database.
TARGET_LIST="$("$OBELISK" deployment list --json -a "$E2E_TARGET_API_URL")"
[[ "$TARGET_LIST" == *"$AUTHORED_ID"* ]] || {
    echo "target does not list ${AUTHORED_ID} among its deployments: $TARGET_LIST" >&2
    exit 1
}
echo ">>> target E2E PASS: the target genuinely stored the GitHub-mounted deployment (${AUTHORED_ID})"

e2e_verify_replay_parity "$BACKEND" "$DEPLOY" "$SESSION_ID"

"$OBELISK" execution cancel -a "$E2E_API_URL" "$SESSION_ID" >/dev/null || true
echo ">>> E2E PASS: the agent (${BACKEND}) submitted this app's own real deployment.js.toml, fetched cold through the GitHub apps mount, and the target has a working stored deployment"
