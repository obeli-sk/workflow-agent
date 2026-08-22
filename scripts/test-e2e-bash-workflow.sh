#!/usr/bin/env bash

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
source "$ROOT/scripts/e2e-lib.sh"

e2e_init "bash-workflow-e2e" 28015 28090 "e2e-bash-workflow-token"
e2e_build_component "workflow/bash-rs" "bash_workflow.wasm"

DEPLOY="$ROOT/.e2e-deployment.toml"
E2E_DEPLOYMENTS+=("$DEPLOY")
cat > "$DEPLOY" <<EOF
[[workflow_wasm]]
name = "bash_workflow"
location = "${E2E_REL_WASM}"
EOF

e2e_start_server "$DEPLOY" 60

FFQN="just-bash:agent/bash.run-bash"
SCRIPT_JSON='"name=$(echo rust); if [ -n \"$name\" ]; then for i in 1 2; do echo \"$name-$i\"; done; fi"'
EXEC_ID="$("$OBELISK" generate execution-id)"
echo ">>> submitting $FFQN as $EXEC_ID"
"$OBELISK" execution submit -a "$E2E_API_URL" -e "$EXEC_ID" "$FFQN" \
    -- "$SCRIPT_JSON" '""'

echo ">>> fetching result"
RESULT="$("$OBELISK" execution result --follow -j -a "$E2E_API_URL" "$EXEC_ID")"
echo "$RESULT"

if grep -q "rust-2" <<<"$RESULT"; then
    echo ">>> E2E PASS: workflow returned expected stdout"
else
    echo ">>> E2E FAIL: expected 'rust-2' in result" >&2
    exit 1
fi
