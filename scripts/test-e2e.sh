#!/usr/bin/env bash
#
# End-to-end test for the Rust bash workflow component.
#
# Builds `workflow/bash-rs` (wasm32-unknown-unknown), starts an ISOLATED Obelisk
# server (own sqlite dir under a temp path, non-default ports, webui off) so it
# never collides with the user's running instance or touches the user's sqlite
# directory, submits `just-bash:agent/bash.run-bash`, and asserts the returned
# stdout. The server and temp dir are cleaned up on exit.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

# The flake pins the matching obelisk on PATH (see README); override with
# $OBELISK to point at a local build.
OBELISK="${OBELISK:-obelisk}"
API_PORT=28015
EXTERNAL_PORT=28090
API_URL="http://127.0.0.1:${API_PORT}"
FFQN="just-bash:agent/bash.run-bash"
EXPECT="rust-2"

export OBELISK__API__TOKEN="e2e-bash-workflow-token"

TMP="$(mktemp -d -t bash-workflow-e2e-XXXXXX)"
# Deployment manifests reject absolute local paths, so the manifest lives at the
# repo root (obelisk runs with the root as CWD) and uses a root-relative path.
DEPLOY="$ROOT/.e2e-deployment.toml"
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

echo ">>> building workflow/bash-rs (wasm32-unknown-unknown)"
( cd "$ROOT/workflow/bash-rs" && cargo build --release )

# Ask cargo where the artifact really is. This is a workspace, so a build from
# the crate dir writes to the workspace-root target/ by default (not the crate's
# own), or to a CARGO_TARGET_DIR override (relative, resolved from the crate dir,
# as the sandbox's target-sandbox is). Deriving the path by hand got this wrong.
TARGET_DIR="$(cd "$ROOT/workflow/bash-rs" && cargo metadata --no-deps --format-version=1 \
    | tr ',' '\n' | sed -n 's/.*"target_directory":"\(.*\)"/\1/p' | head -1)"
WASM="$TARGET_DIR/wasm32-unknown-unknown/release/bash_workflow.wasm"
[[ -f "$WASM" ]] || { echo "wasm not found at $WASM" >&2; exit 1; }
REL_WASM="$(realpath --relative-to="$ROOT" "$WASM")"

cat > "$TMP/server.toml" <<EOF
api.listening_addr = "127.0.0.1:${API_PORT}"
api.token = "\${OBELISK__API__TOKEN}"
webui.enabled = false
external.listening_addr = "127.0.0.1:${EXTERNAL_PORT}"
database.sqlite.directory = "${TMP}/obelisk-sqlite"

[secrets]
LLM_API_KEY = { env = "LLM_API_KEY" }

[log.console]
level = "warn"
EOF

cat > "$DEPLOY" <<EOF
[[workflow_wasm]]
name = "bash_workflow"
location = "${REL_WASM}"
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
    [[ $SECONDS -ge 60 ]] && { echo "timeout waiting for server" >&2; cat "$TMP/server.log" >&2; exit 1; }
    sleep 1
done

# Exercise command substitution, `if` with a `test`, and a `for` loop end-to-end:
# capture a value with `$(...)`, gate on it, then iterate. The script's double
# quotes are escaped for the embedded JSON literal.
SCRIPT_JSON='"name=$(echo rust); if [ -n \"$name\" ]; then for i in 1 2; do echo \"$name-$i\"; done; fi"'
EXEC_ID="$("$OBELISK" generate execution-id)"
echo ">>> submitting $FFQN as $EXEC_ID"
"$OBELISK" execution submit -a "$API_URL" -e "$EXEC_ID" "$FFQN" \
    -- "$SCRIPT_JSON" '""'

echo ">>> fetching result"
RESULT="$("$OBELISK" execution result --follow -j -a "$API_URL" "$EXEC_ID")"
echo "$RESULT"

if grep -q "$EXPECT" <<<"$RESULT"; then
    echo ">>> E2E PASS: workflow returned expected stdout"
else
    echo ">>> E2E FAIL: expected '$EXPECT' in result" >&2
    exit 1
fi
