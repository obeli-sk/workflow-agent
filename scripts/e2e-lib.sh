#!/usr/bin/env bash

# Upper bound for any single wait; only reached when something is actually broken.
E2E_WAIT_SECONDS="${E2E_WAIT_SECONDS:-180}"
E2E_POLL_SECONDS="${E2E_POLL_SECONDS:-0.5}"

# Retries a command until it succeeds or E2E_WAIT_SECONDS pass (status 1).
e2e_wait_until() {
    local deadline=$((SECONDS + E2E_WAIT_SECONDS))
    until "$@"; do
        (( SECONDS < deadline )) || return 1
        sleep "$E2E_POLL_SECONDS"
    done
}

# Wait check: SESSION shows an input offer not yet taken; sets PROJECTION and E2E_OFFER.
e2e_fresh_offer() {
    PROJECTION="$(run_detail "$1")" || return 1
    E2E_OFFER="$(node "$ROOT/scripts/e2e-json.js" input-offer-id <<<"$PROJECTION" 2>/dev/null)" || return 1
    [[ -n "$E2E_OFFER" ]] && ! grep -qxF -- "$E2E_OFFER" "$E2E_TMP/used-offers" 2>/dev/null
}

e2e_wait_offer() {
    e2e_wait_until e2e_fresh_offer "$1" \
        || { echo "no fresh input offer for $1: $PROJECTION" >&2; return 1; }
}

# Prints SESSION's next fresh offer and records it as used on disk.
e2e_take_offer() {
    e2e_wait_offer "$1" || return 1
    printf '%s\n' "$E2E_OFFER" >> "$E2E_TMP/used-offers"
    printf '%s\n' "$E2E_OFFER"
}

# Wait check: SESSION's opening shell script (shell-opened-0) finished; sets PROJECTION.
e2e_opened_shell_done() {
    PROJECTION="$(curl --fail --silent "$1/api/runs/$2")" \
        && node "$ROOT/scripts/e2e-json.js" check-shell-event-done shell-opened-0 <<<"$PROJECTION" 2>/dev/null
}

e2e_init() {
    local suite="$1"
    local api_port="$2"
    local external_port="$3"
    local token="$4"

    OBELISK="${OBELISK:-obelisk}"
    E2E_TMP="$(mktemp -d -t "${suite}-XXXXXX")"
    E2E_API_URL="http://127.0.0.1:${api_port}"
    E2E_SERVER_PID=""
    E2E_GITHUB_PID=""
    E2E_DEPLOYMENTS=()

    export OBELISK_API_TOKEN="$token"
    # No provisioner, so `obelisk cloud` stays out of the prompt.
    unset OBELISK_CLOUD_API_TOKEN
    export OBELISK__API__LISTENING_ADDR="127.0.0.1:${api_port}"
    export OBELISK__EXTERNAL__LISTENING_ADDR="127.0.0.1:${external_port}"
    # OBELISK_UI_URL is a required internal webui-url source, so the Web UI must listen.
    export OBELISK__WEBUI__LISTENING_ADDR="127.0.0.1:$((api_port + 200))"
    export OBELISK__DATABASE__SQLITE__DIRECTORY="${E2E_TMP}/obelisk-sqlite"
    # Keep default E2E startup hermetic and tokenless; a dedicated suite overrides this.
    export APPS_JSON="[]"
    # Closed port, so no suite reaches a real LLM on the 9190 default; interrupt sets its own fake.
    export LLM_BASE_URL="http://127.0.0.1:9"
    # Closed port, so no suite reaches the real GitHub API; mount suites start their own mock.
    export GITHUB_API_URL="http://127.0.0.1:9"
    # No live docs fetch at session start; the system prompt keeps its placeholder.
    export DOCS_URLS_JSON="[]"

    trap e2e_cleanup EXIT
    # A runner timeout or Ctrl-C must still stop the isolated servers.
    trap 'exit 130' INT TERM
}

e2e_github_listening() {
    E2E_GITHUB_PORT="$(sed -n 's/^fake github listening on //p' "$E2E_TMP/github.log")"
    [[ -n "$E2E_GITHUB_PORT" ]]
}

# Serves each owner/repo=DIR through scripts/e2e-github-server.mjs and points the mount activity at it.
e2e_start_github_mock() {
    node "$ROOT/scripts/e2e-github-server.mjs" "$@" > "$E2E_TMP/github.log" 2>&1 &
    E2E_GITHUB_PID=$!
    e2e_wait_until e2e_github_listening || { echo "fake github did not start: $(cat "$E2E_TMP/github.log")" >&2; return 1; }
    export GITHUB_API_URL="http://127.0.0.1:${E2E_GITHUB_PORT}"
}

e2e_cleanup() {
    [[ -z "$E2E_GITHUB_PID" ]] || kill "$E2E_GITHUB_PID" 2>/dev/null || true
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

# Done waiting once the API answers or the server process has exited.
e2e_server_settled() {
    "$OBELISK" component list -a "$1" >/dev/null 2>&1 || ! kill -0 "$2" 2>/dev/null
}

e2e_start_server() {
    local deployment="${1:-$ROOT/deployment.toml}"

    echo ">>> starting ISOLATED obelisk server on ${E2E_API_URL} (sqlite: ${E2E_TMP}/obelisk-sqlite)"
    "$OBELISK" server run \
        --server-config "${E2E_SERVER_CONFIG:-$ROOT/server.toml}" \
        --app-config "${E2E_APP_CONFIG:-$ROOT/app.toml}" \
        --deployment "$deployment" \
        > "$E2E_TMP/server.log" 2>&1 &
    E2E_SERVER_PID=$!

    echo ">>> waiting for the server to become ready"
    if ! e2e_wait_until e2e_server_settled "$E2E_API_URL" "$E2E_SERVER_PID" || ! kill -0 "$E2E_SERVER_PID" 2>/dev/null; then
        echo "server did not become ready; log:" >&2
        sed -n '1,300p' "$E2E_TMP/server.log" >&2
        return 1
    fi
}
