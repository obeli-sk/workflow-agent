#!/usr/bin/env bash

e2e_init() {
    local suite="$1"
    local api_port="$2"
    local external_port="$3"
    local token="$4"

    OBELISK="${OBELISK:-obelisk}"
    E2E_TMP="$(mktemp -d -t "${suite}-XXXXXX")"
    E2E_API_URL="http://127.0.0.1:${api_port}"
    E2E_SERVER_PID=""
    E2E_TARGET_SERVER_PID=""
    E2E_DEPLOYMENTS=()

    export OBELISK_API_TOKEN="$token"
    # Control/deploy tools + the deployment mount target this same isolated
    # instance (self-host default; matches OBELISK_API_URL below).
    export TARGET_OBELISK_TOKEN="$token"
    export TARGET_OBELISK_API_URL="$E2E_API_URL"
    export TARGET_OBELISK_API_URL_REGEX="http://127\\.0\\.0\\.1:${api_port}"
    export OBELISK__API__LISTENING_ADDR="127.0.0.1:${api_port}"
    export OBELISK__EXTERNAL__LISTENING_ADDR="127.0.0.1:${external_port}"
    export OBELISK__WEBUI__ENABLED=false
    export OBELISK__DATABASE__SQLITE__DIRECTORY="${E2E_TMP}/obelisk-sqlite"
    export LLM_API_KEY="${LLM_API_KEY:-e2e-unused-llm-key}"
    # Keep default E2E startup hermetic and tokenless; a dedicated suite overrides this.
    export APPS_JSON="[]"

    trap e2e_cleanup EXIT
}

e2e_cleanup() {
    if [[ -n "$E2E_SERVER_PID" ]]; then
        echo ">>> stopping isolated obelisk server (pid $E2E_SERVER_PID)"
        kill -SIGINT "$E2E_SERVER_PID" 2>/dev/null || true
        local waited=0
        while kill -0 "$E2E_SERVER_PID" 2>/dev/null; do
            if [[ $waited -ge 5 ]]; then
                kill -SIGKILL "$E2E_SERVER_PID" 2>/dev/null || true
                break
            fi
            sleep 1
            ((waited += 1)) || true
        done
    fi
    if [[ -n "$E2E_TARGET_SERVER_PID" ]]; then
        echo ">>> stopping isolated target obelisk server (pid $E2E_TARGET_SERVER_PID)"
        kill -SIGINT "$E2E_TARGET_SERVER_PID" 2>/dev/null || true
        local waited=0
        while kill -0 "$E2E_TARGET_SERVER_PID" 2>/dev/null; do
            if [[ $waited -ge 5 ]]; then
                kill -SIGKILL "$E2E_TARGET_SERVER_PID" 2>/dev/null || true
                break
            fi
            sleep 1
            ((waited += 1)) || true
        done
    fi
    if ((${#E2E_DEPLOYMENTS[@]})); then
        rm -f -- "${E2E_DEPLOYMENTS[@]}"
    fi
    echo ">>> preserved isolated sqlite state at ${E2E_TMP}/obelisk-sqlite"
}

# Selects which session-workflow implementation an e2e suite deploys: "rs"
# (default, workflow/workflow-rs -> deployment.rs.toml) or "js"
# (workflow/workflow-js -> deployment.js.toml). Both export the identical
# obelisk-agent:workflow/workflow.run-cancellable FFQN (see
# docs/js-backend-migration.md), so callers never need to vary RUN_FFQN by
# backend. Sets E2E_DEPLOY_SRC for e2e_patch_workflow_manifest; the JS side
# has no build artifact to patch a location for.
e2e_select_backend() {
    local backend="${1:-rs}"
    case "$backend" in
        rs)
            e2e_build_component "workflow/workflow-rs" "workflow_agent_rs.wasm"
            E2E_DEPLOY_SRC="$ROOT/deployment.rs.toml"
            ;;
        js)
            E2E_REL_WASM=""
            E2E_DEPLOY_SRC="$ROOT/deployment.js.toml"
            ;;
        *)
            echo "unknown backend '$backend' (expected rs|js)" >&2
            return 1
            ;;
    esac
}

e2e_build_component() {
    local crate="$1"
    local artifact="$2"
    local features="${3:-}"

    echo ">>> building ${crate} (wasm32-unknown-unknown)"
    if [[ -n "$features" ]]; then
        (cd "$ROOT/$crate" && cargo build --release --features "$features")
    else
        (cd "$ROOT/$crate" && cargo build --release)
    fi

    local target_dir
    target_dir="$(cd "$ROOT/$crate" && cargo metadata --no-deps --format-version=1 \
        | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')"
    local wasm="${target_dir}/wasm32-unknown-unknown/release/${artifact}"
    [[ -f "$wasm" ]] || { echo "wasm not found at $wasm" >&2; return 1; }
    E2E_REL_WASM="$(realpath --relative-to="$ROOT" "$wasm")"
}

e2e_patch_workflow_manifest() {
    local output="$1"
    local src="${E2E_DEPLOY_SRC:-$ROOT/deployment.rs.toml}"
    E2E_DEPLOYMENTS+=("$output")
    if [[ -n "${E2E_REL_WASM:-}" ]]; then
        sed "s#^location = \"target/wasm32-unknown-unknown/release/workflow_agent_rs.wasm\"#location = \"${E2E_REL_WASM}\"#" \
            "$src" > "$output"
        grep -q "$E2E_REL_WASM" "$output" || {
            echo "failed to patch workflow_wasm location in generated manifest" >&2
            return 1
        }
    else
        cp "$src" "$output"
    fi
}

e2e_start_server() {
    local deployment="$1"
    local timeout_seconds="${2:-90}"

    echo ">>> starting ISOLATED obelisk server on ${E2E_API_URL} (sqlite: ${E2E_TMP}/obelisk-sqlite)"
    "$OBELISK" server run \
        --server-config "${E2E_SERVER_CONFIG:-$ROOT/server.toml}" \
        --deployment "$deployment" \
        > "$E2E_TMP/server.log" 2>&1 &
    E2E_SERVER_PID=$!

    echo ">>> waiting for the server to become ready"
    local waited=0
    until "$OBELISK" component list -a "$E2E_API_URL" >/dev/null 2>&1; do
        if ! kill -0 "$E2E_SERVER_PID" 2>/dev/null; then
            echo "server exited early; log:" >&2
            sed -n '1,300p' "$E2E_TMP/server.log" >&2
            return 1
        fi
        if [[ $waited -ge $timeout_seconds ]]; then
            echo "timeout waiting for server; log:" >&2
            sed -n '1,300p' "$E2E_TMP/server.log" >&2
            return 1
        fi
        sleep 1
        ((waited += 1)) || true
    done
}

# Starts a second, genuinely separate obelisk instance for suites that need
# to prove a redeploy against a real *target* rather than self-hosting (see
# scripts/test-e2e-target-deploy.sh): `--empty --no-auth`, no server config
# (the target has no secrets/outbound_http needs of its own for a plain
# generated JS activity). Sets E2E_TARGET_API_URL; caller wires
# TARGET_OBELISK_* env vars to point the source session's `obelisk` command
# and deployment mount at it before starting the source server.
e2e_start_target_server() {
    local api_port="$1"
    local external_port="$2"
    local timeout_seconds="${3:-90}"

    E2E_TARGET_API_URL="http://127.0.0.1:${api_port}"
    echo ">>> starting ISOLATED EMPTY target obelisk server on ${E2E_TARGET_API_URL} (sqlite: ${E2E_TMP}/target-obelisk-sqlite)"
    # --no-auth refuses to start if a token is set; unset the source
    # server's exported token for this one subprocess only.
    env -u OBELISK_API_TOKEN \
    OBELISK__API__LISTENING_ADDR="127.0.0.1:${api_port}" \
    OBELISK__EXTERNAL__LISTENING_ADDR="127.0.0.1:${external_port}" \
    OBELISK__WEBUI__ENABLED=false \
    OBELISK__DATABASE__SQLITE__DIRECTORY="${E2E_TMP}/target-obelisk-sqlite" \
        "$OBELISK" server run --empty --no-auth \
        > "$E2E_TMP/target-server.log" 2>&1 &
    E2E_TARGET_SERVER_PID=$!

    echo ">>> waiting for the target server to become ready"
    local waited=0
    until "$OBELISK" component list -a "$E2E_TARGET_API_URL" >/dev/null 2>&1; do
        if ! kill -0 "$E2E_TARGET_SERVER_PID" 2>/dev/null; then
            echo "target server exited early; log:" >&2
            sed -n '1,300p' "$E2E_TMP/target-server.log" >&2
            return 1
        fi
        if [[ $waited -ge $timeout_seconds ]]; then
            echo "timeout waiting for target server; log:" >&2
            sed -n '1,300p' "$E2E_TMP/target-server.log" >&2
            return 1
        fi
        sleep 1
        ((waited += 1)) || true
    done
}
