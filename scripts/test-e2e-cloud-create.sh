#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
source "$ROOT/scripts/e2e-lib.sh"
e2e_init "cloud-create-e2e" 28116 28191 "e2e-cloud-create-token"
export OBELISK_CLOUD_API_TOKEN="e2e-cloud-token"
export OBELISK_CLOUD_API_URL="http://127.0.0.1:28195/api"
export OBELISK_API_URL="$E2E_API_URL"

node --input-type=module > "$E2E_TMP/cloud.log" 2>&1 <<'JS' &
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const commands = new Map();
let attempts = 0;
createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/stats') {
        response.end(JSON.stringify({ attempts, creations: commands.size }));
    } else if (request.method === 'POST' && request.url === '/api/v1/apps') {
        assert.equal(request.headers.authorization, 'Bearer e2e-cloud-token');
        let body = '';
        for await (const part of request) body += part;
        const id = request.headers['idempotency-key'];
        assert.match(id, /^E_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
        assert.equal(JSON.parse(body).env.MODE, 'prod');
        attempts++;
        if (!commands.has(id)) {
            commands.set(id, body);
            request.socket.destroy();
        } else {
            assert.equal(body, commands.get(id));
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ app_name: 'demo', status: 'running', execution_id: id }));
        }
    } else {
        response.writeHead(404).end('{}');
    }
}).listen(28195, '127.0.0.1');
JS
E2E_CLOUD_PID=$!
trap 'kill "$E2E_CLOUD_PID" 2>/dev/null || true; e2e_cleanup' EXIT

cloud_ready() { curl --fail --silent http://127.0.0.1:28195/stats >/dev/null; }
e2e_wait_until cloud_ready
e2e_start_server

command_id="$("$OBELISK" generate execution-id)"
params="$(jq -cn --arg id "$command_id" '[({app_toml:"app_name = \"demo\"\n",env:{MODE:"prod"},secrets:{}} | tojson), $id]')"
"$OBELISK" execution submit --follow -j --api-url "$E2E_API_URL" \
    obelisk-agent:tools/cloud.create "$params" > "$E2E_TMP/result.json"
jq -e --arg id "$command_id" '.. | objects | select(.status? == 200 and .body?) | .body | fromjson | select(.app_name == "demo" and .execution_id == $id)' "$E2E_TMP/result.json"
curl --fail --silent http://127.0.0.1:28195/stats | jq -e '.attempts == 2 and .creations == 1'
