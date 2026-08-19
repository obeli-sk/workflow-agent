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
    E2E_DEPLOYMENTS=()

    export OBELISK__API__TOKEN="$token"
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
    if ((${#E2E_DEPLOYMENTS[@]})); then
        rm -f -- "${E2E_DEPLOYMENTS[@]}"
    fi
    echo ">>> preserved isolated sqlite state at ${E2E_TMP}/obelisk-sqlite"
}

e2e_build_component() {
    local crate="$1"
    local artifact="$2"

    echo ">>> building ${crate} (wasm32-unknown-unknown)"
    (cd "$ROOT/$crate" && cargo build --release)

    local target_dir
    target_dir="$(cd "$ROOT/$crate" && cargo metadata --no-deps --format-version=1 \
        | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')"
    local wasm="${target_dir}/wasm32-unknown-unknown/release/${artifact}"
    [[ -f "$wasm" ]] || { echo "wasm not found at $wasm" >&2; return 1; }
    E2E_REL_WASM="$(realpath --relative-to="$ROOT" "$wasm")"
}

e2e_patch_workflow_manifest() {
    local output="$1"
    E2E_DEPLOYMENTS+=("$output")
    sed "s#^location = \"target/wasm32-unknown-unknown/release/workflow_agent_rs.wasm\"#location = \"${E2E_REL_WASM}\"#" \
        "$ROOT/deployment.toml" > "$output"
    grep -q "$E2E_REL_WASM" "$output" || {
        echo "failed to patch workflow_wasm location in generated manifest" >&2
        return 1
    }
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
