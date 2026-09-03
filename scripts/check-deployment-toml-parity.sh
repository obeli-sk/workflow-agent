#!/usr/bin/env bash
# deployment.rs.toml (Rust workflow backend) and deployment.js.toml (JS backend)
# export the same canonical FFQN and must be identical everywhere except their
# marked workflow block (see docs/js-backend-migration.md and the "Workflow
# (implementation-specific...)" comment in either file). This catches drift
# where an edit lands in one file's activities/webhook/stub blocks but not
# the other's.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

strip_workflow_block() {
    # Drop everything from the "# --- Workflow (implementation-specific"
    # marker through its matching "# --- End workflow" marker, inclusive.
    awk '
        /^# --- Workflow \(implementation-specific/ { skipping = 1; next }
        /^# --- End workflow/ { skipping = 0; next }
        !skipping { print }
    ' "$1"
}

RS_STRIPPED="$(mktemp)"
JS_STRIPPED="$(mktemp)"
trap 'rm -f "$RS_STRIPPED" "$JS_STRIPPED"' EXIT

strip_workflow_block "$ROOT/deployment.rs.toml" > "$RS_STRIPPED"
strip_workflow_block "$ROOT/deployment.js.toml" > "$JS_STRIPPED"

if ! diff -u "$RS_STRIPPED" "$JS_STRIPPED"; then
    echo ">>> deployment.rs.toml and deployment.js.toml diverged outside their workflow block (see diff above)" >&2
    exit 1
fi
echo ">>> deployment.rs.toml and deployment.js.toml are in sync outside their workflow block"
