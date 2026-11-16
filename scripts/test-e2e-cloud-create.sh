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
let draft = null;
const draftAttempts = { open: 0, config: 0, env: 0 };
createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/stats') {
        response.end(JSON.stringify({ attempts, creations: commands.size, draftAttempts }));
    } else if (request.method === 'GET' && request.url === '/api/v1/apps/demo') {
        response.end(JSON.stringify({ app_name: 'demo', applied_revision: 7, status: 'running' }));
    } else if (request.method === 'GET' && request.url === '/api/v1/apps/demo/drafts/default') {
        if (draft) response.end(JSON.stringify(draft));
        else response.writeHead(404).end('{}');
    } else if (request.method === 'POST' && request.url === '/api/v1/apps/demo/drafts/default') {
        let body = '';
        for await (const part of request) body += part;
        assert.deepEqual(JSON.parse(body), { parent_revision: 7, reuse: true });
        draftAttempts.open++;
        draft = { draft_id: 42, key: 'default', parent_revision: 7, revision: 8, env: {}, values: {}, summary: { changed: true } };
        request.socket.destroy();
    } else if (request.method === 'PUT' && request.url.startsWith('/api/v1/apps/demo/drafts/default/')) {
        assert.equal(request.headers['if-match'], '"draft-42"');
        let body = '';
        for await (const part of request) body += part;
        const section = request.url.endsWith('/config') ? 'config' : 'env';
        draftAttempts[section]++;
        if (section === 'config') draft.app_toml = body;
        else draft.env.MODE = JSON.parse(body).value;
        if (draftAttempts[section] === 1) request.socket.destroy();
        else response.end(JSON.stringify(draft));
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

script=$(cat <<'SHELL'
cat > app.toml <<'TOML'
app_name = "demo"
[public_env]
MODE = {}
TOML
obelisk cloud app stage --env MODE=prod --json
SHELL
)
session_id="$("$OBELISK" generate execution-id)"
params="$(jq -cn --arg script "$script" '["$ " + $script, null, null, null, null]')"
"$OBELISK" execution submit --api-url "$E2E_API_URL" -e "$session_id" \
    obelisk-agent:workflow/workflow.run-cancellable "$params" >/dev/null
e2e_wait_until e2e_opened_shell_done http://127.0.0.1:28191 "$session_id"
node scripts/e2e-json.js check-shell-script "$script" <<<"$PROJECTION"
node scripts/e2e-json.js shell-event-stdout shell-opened-0 <<<"$PROJECTION" | jq -e '.draft_id == 42 and .env.MODE == "prod" and .parent_revision == 7'
curl --fail --silent http://127.0.0.1:28195/stats | jq -e '.draftAttempts == {open:1,config:2,env:2}'
"$OBELISK" execution cancel --api-url "$E2E_API_URL" "$session_id" >/dev/null
