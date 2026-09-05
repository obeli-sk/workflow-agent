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
    E2E_BACKEND="$backend"
}

# Verifies that SESSION_ID's full execution history, recorded under
# ORIGINAL_BACKEND, replays cleanly under the *other* language backend's
# component, without ever driving the session live under it. Both
# deployment.rs.toml and deployment.js.toml pin their session workflow's
# `exec.locking_strategy` to `by_component_digest` (not the workflow default
# `auto`), so an in-flight execution only ever gets locked by an executor for
# the exact digest that created it - switching the server's active deployment
# here cannot affect SESSION_ID's own progress the way a plain `deployment
# apply` + continued-driving hot-swap could (see docs/js-backend-migration.md).
# The actual cross-language check is the non-destructive `PUT
# /v1/executions/{id}/replay` RPC (`obelisk execution replay`): it replays the
# persisted history against whichever component is currently registered for
# the FFQN and reports Advanceable/Finished/Blocked/ReplayFailed without
# persisting anything, so a mismatch is a clean assertion failure, not a
# stranded session. Restores ORIGINAL_DEPLOY as the active deployment before
# returning (even on failure), so callers can keep driving SESSION_ID
# afterward if they need to.
#
# KNOWN-RED on some callers (test-e2e-chat.sh, test-e2e-target-deploy.sh,
# test-e2e-deploy-outside-root.sh), an Obelisk-core gap, not a
# session.rs/session.js bug: each language's own native execution trace is
# byte-for-byte identical for these scenarios (verified by diffing
# t_execution_log directly), but replaying under the other language
# nondeterminism-fails at an `n:user-{turn}` join-set close, right after the
# turn's trailing `session-events` notify(es). The replay trace
# (`OBELISK__LOG__CONSOLE__LEVEL=info,obeli_sk_wasm_workers::workflow::
# event_history=trace`) shows the mismatching close is emitted from an
# `execution_replay:finalize` span, not the normal
# `execution_replay:apply_inner` matching loop that produced everything
# else correctly - a replay-finalize bug, not a control-flow divergence.
# Reproduces on both the simple `test-e2e-redeploy.sh`-shaped one-turn
# scripts that call `obelisk deployment apply` and the many-turn
# `test-e2e-chat.sh` (no `apply` involved at all), so it is not specific to
# either; `test-e2e-redeploy.sh` (submit only) and `test-e2e-interrupt.sh`
# (several turns, real interrupts) both pass, so the trigger is still
# unscoped. Needs investigation in Obelisk-core's
# crates/wasm-workers/src/workflow/replay_advance.rs /
# workflow_js_worker.rs, not attempted here.
#
# KNOWN-RED, two more callers, a *different* gap from the one above (later
# session): `test-e2e-mcp.sh` and `test-e2e-github-mount-deploy.sh` both fail
# too, but neither is the `n:user-{turn}`/`session-events` finalize bug -
# confirmed unrelated because rebuilding `obelisk` from the (unreleased)
# `codex/typed-js-await-next` branch, which fixes exactly that gap (verified:
# `test-e2e-agent-workflow.sh` now passes replay-parity clean on that build,
# where it previously hit the same `n:user-{turn}` signature), leaves both of
# these failing byte-for-byte identically. `test-e2e-mcp.sh` fails rs->js with
# `nondeterminism_detected: found unprocessed request stored at version 8:
# event: JoinSetCreate(o:3-obelisk-e2e)` - a "OneOff" join set, auto-numbered
# per target function name by `WorkflowCtx::call_json`'s
# `next_join_set_one_off_named` (every MCP call, regardless of JSON-RPC
# method, goes through the same activity ffqn, so repeated calls share one
# counter). `test-e2e-github-mount-deploy.sh` fails rs->js with `key does not
# match event stored at version 118: key: JoinNext(g:1 closing), event:
# JoinSetRequest(ChildExecutionRequest(...o:32-request_1,
# obelisk-agent:mounts/apps.request, ...))` - a "Generated" (anonymous)
# join set's closing drain colliding with an unrelated one-off join set's
# child request. Three isolated reduction attempts in Obelisk-core (repeated
# `call_json` calls to one activity; the same wrapped in an anonymous
# `ScriptWatchGuard`-shaped join set that closes; the same checked while
# `Blocked` rather than `Finished`, matching what these e2e suites actually
# observe) all replayed cleanly - the real trigger needs an ingredient not
# yet isolated, possibly scale (the real trace reaches `o:32`; the reductions
# only reached `o:4`) or a named/typed-await-next join set alongside the
# one-off ones. Not attempted further here; these two E_* execution ids and
# error strings are the reference reproduction until a synthetic Obelisk-core
# repro is found.
e2e_verify_replay_parity() {
    local original_backend="$1"
    local original_deploy="$2"
    local session_id="$3"

    local other_backend
    case "$original_backend" in
        rs) other_backend="js" ;;
        js) other_backend="rs" ;;
        *)
            echo "unknown backend '$original_backend' (expected rs|js)" >&2
            return 1
            ;;
    esac

    echo ">>> replay parity: switching active deployment to '$other_backend' to replay $session_id"
    e2e_select_backend "$other_backend"
    # Relative component `location`s (e.g. packs/.../descriptor.js) resolve
    # against the manifest's own directory, so this must live next to
    # deployment.rs.toml/deployment.js.toml under $ROOT, not under $E2E_TMP,
    # matching e2e_patch_workflow_manifest's other callers.
    local other_deploy="$ROOT/$(basename "$original_deploy" .toml)-replay-parity-${other_backend}.toml"
    e2e_patch_workflow_manifest "$other_deploy"
    "$OBELISK" deployment apply "$other_deploy" -a "$E2E_API_URL" >/dev/null

    local replay_json outcome
    replay_json="$("$OBELISK" execution replay -j -a "$E2E_API_URL" "$session_id")"
    outcome="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).type)' <<<"$replay_json")"

    "$OBELISK" deployment apply "$original_deploy" -a "$E2E_API_URL" >/dev/null

    if [[ "$outcome" == "replay_failed" ]]; then
        echo ">>> E2E FAIL: $session_id ($original_backend) did not replay under '$other_backend': $replay_json" >&2
        return 1
    fi
    echo ">>> replay parity E2E PASS: $session_id ($original_backend) replays cleanly under '$other_backend' (outcome: $outcome)"
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
