// Web UI for the obelisk-agent.
//
// Server side: small JSON API plus one HTML shell page that boots the SPA.
// Routes:
//   GET  /                          static shell (HTML + inline JS)
//   GET  /api/runs                  list runs (sidebar)
//   GET  /api/runs/:id              one run, normalised into turns
//   GET  /api/logs/:id              logs from the run and all derived executions
//   POST /api/submit                body: {prompt} -> {execution_id}
//   POST /api/answer/:childId       body: {answer} -> {ok: true}
//
// The SPA polls the run list every 10s and active open runs every 3s, so
// refreshes happen without page reloads. Terminal runs stop polling. Layout is
// two-pane: sidebar = "new conversation" button + run list; right pane =
// chat-style transcript with a persistent composer pinned at the bottom (creates
// a run, or steers/replies to the selected one) and an "agent is working"
// indicator directly above it.

import * as webapi from "obelisk-agent:tools/webapi";

const WORKFLOW_FFQN = "obelisk-agent:workflow/workflow.run";
const AGENT_LOOP_FFQN = "obelisk-agent:workflow/workflow.agent-loop";
const ASK_USER_FFQN = "obelisk-agent:tools/input.ask-user";
const CONFIRM_FFQN = "obelisk-agent:tools/deploy.confirm-apply";
const INJECTION_FFQN = "obelisk-agent:agent/session.injection";

export default async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
        const query = parseQuery(request.url);
        if (method === "GET" && path === "/") return htmlShell();
        if (method === "GET" && path === "/api/models") return jsonResponse(loadModels());
        if (method === "GET" && path === "/api/runs") return jsonResponse(await listRuns());
        if (method === "GET" && path.startsWith("/api/runs/")) {
            const id = decodeURIComponent(path.substring("/api/runs/".length));
            if (!id) return jsonError(400, "missing run id");
            return jsonResponse(await detailRun(id, {
                agentLoopId: query.agent_loop_id || "",
                responseCursor: nonNegativeInteger(query.response_cursor),
                historyVersion: nonNegativeInteger(query.history_version),
            }));
        }
        if (method === "GET" && path.startsWith("/api/logs/")) {
            const id = decodeURIComponent(path.substring("/api/logs/".length));
            if (!id) return jsonError(400, "missing run id");
            return jsonResponse(await loadExecutionTreeLogs(id, query.cursor || ""));
        }
        if (method === "POST" && path === "/api/submit") return await submit(request);
        if (method === "POST" && path.startsWith("/api/pause/")) {
            return await pauseExecution(decodeURIComponent(path.substring("/api/pause/".length)), false);
        }
        if (method === "POST" && path.startsWith("/api/unpause/")) {
            return await pauseExecution(decodeURIComponent(path.substring("/api/unpause/".length)), true);
        }
        if (method === "POST" && path.startsWith("/api/say/")) {
            return await sayToAgent(request, decodeURIComponent(path.substring("/api/say/".length)));
        }
        if (method === "POST" && path.startsWith("/api/answer/")) {
            const childId = decodeURIComponent(path.substring("/api/answer/".length));
            return await answerStub(request, childId);
        }
        if (method === "POST" && path.startsWith("/api/confirm/")) {
            const childId = decodeURIComponent(path.substring("/api/confirm/".length));
            return await confirmDeploy(request, childId);
        }
    } catch (e) {
        return jsonError(500, String(e));
    }
    return jsonError(404, "not found");
}

// ----- helpers ----------------------------------------------------------

function activityJson(label, text) {
    try { return JSON.parse(text); }
    catch (e) { throw new Error(`${label}: non-JSON activity result: ${e.message}`); }
}

// Read-only API access. The UI polls statuses, responses and logs every few
// seconds; routing every read through a child activity (one execution per call)
// flooded the server with thousands of short executions. A webhook can speak to
// the Obelisk REST API directly, so these GETs run as plain fetches. Mutations
// (pause/unpause/cancel/stub/submit) stay as durable activities below.
const API_BASE = (process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005").replace(/\/$/, "");

async function apiGet(label, path, accept = "application/json") {
    let resp;
    try {
        resp = await fetch(`${API_BASE}${path}`, { headers: { accept } });
    } catch (e) {
        throw new Error(`${label}: ${String(e)}`);
    }
    const text = await resp.text();
    if (!resp.ok) throw new Error(`${label}: HTTP ${resp.status}: ${text}`);
    return text;
}

async function apiGetJson(label, path) {
    return activityJson(label, await apiGet(label, path));
}

async function listExecutions(
    ffqnPrefix,
    executionIdPrefix,
    showDerived,
    hideFinished,
    length,
) {
    const params = [];
    if (ffqnPrefix) params.push(`ffqn_prefix=${encodeURIComponent(ffqnPrefix)}`);
    if (executionIdPrefix) params.push(`execution_id_prefix=${encodeURIComponent(executionIdPrefix)}`);
    if (showDerived) params.push("show_derived=true");
    if (hideFinished) params.push("hide_finished=true");
    params.push(`length=${encodeURIComponent(String(length || 20))}`);
    return apiGetJson("list-executions", `/v1/executions?${params.join("&")}`);
}

async function getExecutionStatus(id) {
    return apiGetJson(`get-execution ${id}`, `/v1/executions/${encodeURIComponent(id)}/status`);
}

async function getExecutionRecord(id) {
    return apiGetJson(`get-execution-record ${id}`, `/v1/executions/${encodeURIComponent(id)}`);
}

async function getExecutionEvents(id, cursorKind, cursor, includingCursor, length) {
    const kind = cursorKind === "version_from" ? "version_from" : "version";
    const version = Number.isFinite(cursor) && cursor > 0 ? Math.trunc(cursor) : 0;
    const params = [
        `${kind}=${encodeURIComponent(String(version))}`,
        `including_cursor=${includingCursor ? "true" : "false"}`,
        `length=${encodeURIComponent(String(length || 200))}`,
    ];
    return apiGetJson(`get-events ${id}`, `/v1/executions/${encodeURIComponent(id)}/events?${params.join("&")}`);
}

async function getExecutionResponses(id, cursor, includingCursor, length) {
    const current = Number.isFinite(cursor) && cursor > 0 ? Math.trunc(cursor) : 0;
    const params = [
        `cursor=${encodeURIComponent(String(current))}`,
        `including_cursor=${includingCursor ? "true" : "false"}`,
        `length=${encodeURIComponent(String(length || 200))}`,
    ];
    return apiGetJson(`get-responses ${id}`, `/v1/executions/${encodeURIComponent(id)}/responses?${params.join("&")}`);
}

async function getExecutionLogs(id, showDerived, cursor, includingCursor, length) {
    const params = [
        `show_derived=${showDerived ? "true" : "false"}`,
        "show_logs=true",
        "show_streams=true",
    ];
    if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
    params.push("direction=newer");
    if (includingCursor) params.push("including_cursor=true");
    params.push(`length=${encodeURIComponent(String(length || 200))}`);
    return apiGetJson(`get-logs ${id}`, `/v1/executions/${encodeURIComponent(id)}/logs?${params.join("&")}`);
}

async function getDeployment(id) {
    return apiGetJson(`get-deployment ${id}`, `/v1/deployments/${encodeURIComponent(id)}`);
}

async function currentDeploymentId() {
    return apiGetJson("current-deployment-id", "/v1/deployment-id");
}

async function readBlob(digest) {
    return apiGet(`read-blob ${digest}`, `/v1/files/${encodeURIComponent(digest)}`, "text/plain");
}

function pauseObeliskExecution(id) {
    return activityJson(`pause-execution ${id}`, webapi.pauseExecution(id));
}

function unpauseObeliskExecution(id) {
    return activityJson(`unpause-execution ${id}`, webapi.unpauseExecution(id));
}

function stubObeliskExecution(id, result) {
    return activityJson(`stub-execution ${id}`, webapi.stubExecution(id, JSON.stringify(result)));
}

function submitWorkflowExecution(id, prompt, backend, effort) {
    return activityJson(`submit-workflow-execution ${id}`, webapi.submitWorkflowExecution(id, prompt, backend, effort));
}

function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}

function jsonError(status, message) {
    return jsonResponse({ error: message }, status);
}

function parseQuery(rawUrl) {
    const query = Object.create(null);
    const queryStart = rawUrl.indexOf("?");
    if (queryStart < 0) return query;

    const fragmentStart = rawUrl.indexOf("#", queryStart);
    const queryString = rawUrl.substring(
        queryStart + 1,
        fragmentStart < 0 ? rawUrl.length : fragmentStart,
    );
    for (const part of queryString.split("&")) {
        if (!part) continue;
        const separator = part.indexOf("=");
        const rawKey = separator < 0 ? part : part.substring(0, separator);
        const rawValue = separator < 0 ? "" : part.substring(separator + 1);
        const key = decodeQueryComponent(rawKey);
        if (!(key in query)) query[key] = decodeQueryComponent(rawValue);
    }
    return query;
}

function decodeQueryComponent(value) {
    return decodeURIComponent(value.replace(/\+/g, " "));
}

function nonNegativeInteger(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

// ----- models -----------------------------------------------------------

// The configurable model catalog (deployment.toml AGENT_MODELS). The UI renders
// these in the model dropdown; the selected id is passed to the workflow as the
// `backend`/model hint, and the llm activity routes it to the right wire API.
function loadModels() {
    const raw = process.env["AGENT_MODELS"];
    let catalog = [];
    if (raw) { try { catalog = JSON.parse(raw); } catch (_) { catalog = []; } }
    const models = Array.isArray(catalog)
        ? catalog.filter((m) => m && m.id).map((m) => ({ id: m.id, label: m.label || m.id, api_type: m.api_type || "" }))
        : [];
    return { models };
}

// ----- list -------------------------------------------------------------

// The run's live phase lives on the agent-loop *child*, not the top-level
// workflow.run. The parent spends the whole run blocked on its "session" join
// set (waiting for the child), so its join_name never tells "working" apart
// from "waiting for the operator". While the parent is still delegating, report
// the child's pending_state; once the parent reaches a terminal/paused state it
// is authoritative for the whole run.
function pickRunState(parentStatus, childStatus) {
    const parent = parentStatus?.pending_state || null;
    const phase = parent?.status;
    const parentAuthoritative = !childStatus
        || phase === "finished" || phase === "paused"
        || (typeof phase === "string" && phase.startsWith("permanently"));
    const ps = parentAuthoritative ? parent : (childStatus.pending_state || parent);
    return {
        status: ps?.status || "unknown",
        result_kind: ps?.result_kind ?? null,
        join_name: parseJoinName(ps?.join_set_id),
    };
}

async function listRuns() {
    const executions = await listExecutions(WORKFLOW_FFQN, "", false, false, 50);
    const runs = await Promise.all(executions.map(async (e) => {
        const id = e.execution_id;
        const [childId, prompt_preview] = await Promise.all([
            loadAgentLoopExecution(id),
            loadPromptPreview(id),
        ]);
        const childStatus = childId ? await loadStatus(childId) : null;
        return {
            id,
            created_at: e.created_at || "",
            ...pickRunState(e, childStatus),
            prompt_preview,
        };
    }));
    return { runs };
}

async function loadPromptPreview(execId) {
    const p = (await loadPrompt(execId)) || "";
    return p.length > 120 ? p.substring(0, 120) + "..." : p;
}

// ----- detail -----------------------------------------------------------

async function detailRun(id, cursorState) {
    const agentLoopId = await loadAgentLoopExecution(id);
    const resetTranscript = !agentLoopId || cursorState.agentLoopId !== agentLoopId;
    const responseCursor = resetTranscript ? 0 : cursorState.responseCursor;
    const historyVersion = resetTranscript ? 0 : cursorState.historyVersion;
    const [status, childStatus, created, walk, sent, finalResult, pendingAsks, pendingConfirms, pendingInjection] = await Promise.all([
        loadStatus(id),
        agentLoopId ? loadStatus(agentLoopId) : Promise.resolve(null),
        loadCreated(id),
        loadResponses(agentLoopId || id, responseCursor),
        loadSentResults(agentLoopId || id, historyVersion),
        loadFinalResult(id),
        loadPendingAsks(id),
        loadPendingConfirms(id),
        loadPendingInjection(id),
    ]);
    return {
        id,
        ...pickRunState(status, childStatus),
        created_at: status?.created_at || "",
        prompt: created?.prompt ?? null,
        backend: created?.backend ?? null,
        effort: created?.effort ?? null,
        transcript: {
            reset: resetTranscript,
            agent_loop_id: agentLoopId,
            replies: walk.replies,
            tool_children: walk.toolChildren,
            sent_results: sent.results,
            operator_messages: sent.operatorMessages,
            response_cursor: walk.cursor,
            history_version: sent.version,
        },
        final_result: finalResult,
        pending_asks: pendingAsks,
        pending_confirms: pendingConfirms,
        pending_injection: pendingInjection,
    };
}

async function loadAgentLoopExecution(workflowId) {
    let candidates;
    try {
        candidates = await listExecutions(AGENT_LOOP_FFQN, workflowId, true, false, 10);
    } catch (_) { return null; }
    const mine = candidates.filter((e) => typeof e.execution_id === "string"
        && e.execution_id.startsWith(workflowId + "."));
    return mine.length > 0 ? mine[mine.length - 1].execution_id : null;
}

async function loadStatus(id) {
    try { return await getExecutionStatus(id); }
    catch (_) { return null; }
}

// The workflow.run creation params are [prompt, model, descriptor-ffqn, effort].
// version 0 is the `created` event; without including_cursor=true the server
// skips it and returns the `locked` event at version 1, which has no params.
async function loadCreated(id) {
    try {
        const payload = await getExecutionEvents(id, "version_from", 0, true, 1);
        const params = payload.events?.[0]?.event?.created?.params;
        if (!Array.isArray(params)) return null;
        return {
            prompt: typeof params[0] === "string" ? params[0] : null,
            backend: typeof params[1] === "string" ? params[1] : null,
            effort: typeof params[3] === "string" ? params[3] : null,
        };
    } catch (_) { return null; }
}

async function loadPrompt(id) {
    return (await loadCreated(id))?.prompt ?? null;
}

async function loadFinalResult(id) {
    try {
        const status = await getExecutionStatus(id);
        if (status?.pending_state?.status !== "finished") return null;
        return await getExecutionRecord(id);
    } catch (e) { return { error: String(e) }; }
}

// Logs are loaded lazily from a separate endpoint because a run can have many
// derived executions. Include unfinished children so the currently streaming
// recv activity is visible while the model is working.
async function loadExecutionTreeLogs(workflowId, startCursor) {
    const logs = [];
    let cursor = startCursor || "1970-01-01T00:00:00Z";
    let including = !startCursor;
    while (true) {
        let page;
        try {
            page = await getExecutionLogs(workflowId, true, cursor, including, 200);
        } catch (_) { break; }
        if (!Array.isArray(page) || page.length === 0) break;
        logs.push(...page);
        const next = page[page.length - 1]?.cursor;
        if (typeof next !== "string" || !next || next <= cursor) break;
        cursor = next;
        including = false;
        if (page.length < 200) break;
    }
    return { logs, cursor: startCursor && logs.length === 0 ? startCursor : cursor };
}

async function loadPendingAsks(workflowId) {
    let candidates;
    try {
        candidates = await listExecutions(ASK_USER_FFQN, "", true, true, 50);
    } catch (_) { return []; }
    const mine = candidates.filter((e) => typeof e.execution_id === "string"
        && e.execution_id.startsWith(workflowId + "."));
    return await Promise.all(mine.map(async (e) => {
        let question = null;
        try {
            const evs = await getExecutionEvents(e.execution_id, "version_from", 0, true, 1);
            const p = evs.events?.[0]?.event?.created?.params;
            if (Array.isArray(p) && typeof p[0] === "string") question = p[0];
        } catch (_) { }
        return { id: e.execution_id, question };
    }));
}

async function loadPendingInjection(workflowId) {
    let candidates;
    try {
        candidates = await listExecutions(INJECTION_FFQN, workflowId, true, true, 10);
    } catch (_) { return null; }
    const mine = candidates.filter((e) => e?.ffqn === INJECTION_FFQN
        && typeof e.execution_id === "string"
        && e.execution_id.startsWith(workflowId + "."));
    if (mine.length === 0) return null;
    return { id: mine[mine.length - 1].execution_id };
}

// Pending hot-reload confirmations: confirm-apply stub children of this
// workflow that are still unanswered. For each, read its created params
// ([deployment_id, summary]) and build a source diff of the proposed
// deployment against the currently active one so the operator can see exactly
// what the fix changes before approving.
async function loadPendingConfirms(workflowId) {
    let candidates;
    try {
        candidates = await listExecutions(CONFIRM_FFQN, "", true, true, 50);
    } catch (_) { return []; }
    const mine = candidates.filter((e) => typeof e.execution_id === "string"
        && e.execution_id.startsWith(workflowId + "."));
    if (mine.length === 0) return [];

    // The active deployment is shared across all pending confirms; fetch once.
    const currentSources = await loadCurrentSources();

    return await Promise.all(mine.map(async (e) => {
        let deploymentId = null;
        let summary = "";
        try {
            const evs = await getExecutionEvents(e.execution_id, "version_from", 0, true, 1);
            const p = evs.events?.[0]?.event?.created?.params;
            if (Array.isArray(p)) {
                if (typeof p[0] === "string") deploymentId = p[0];
                if (typeof p[1] === "string") summary = p[1];
            }
        } catch (_) { }

        let diff = null;
        if (deploymentId) {
            try {
                const dep = await getDeployment(deploymentId);
                diff = diffSources(currentSources, await collectSources(dep.deployment_toml));
            } catch (err) { diff = { error: String(err) }; }
        }
        return { id: e.execution_id, deployment_id: deploymentId, summary, diff };
    }));
}

// Sources of the currently active deployment, keyed by location. Returns {} if
// there is no current deployment or it cannot be read. /v1/deployment-id returns
// the active id as a JSON string; its manifest lives in the per-id GET.
async function loadCurrentSources() {
    try {
        const id = await currentDeploymentId();
        if (!id || typeof id !== "string") return {};
        const dep = await getDeployment(id);
        return await collectSources(dep.deployment_toml);
    } catch (_) { return {}; }
}

// Extract { location -> source } for a deployment's owned JS/exec components. The
// manifest references each owned source by `location` + `content_digest`; the
// body is read from the content-addressed store.
async function collectSources(deploymentToml) {
    const out = {};
    if (typeof deploymentToml !== "string") return out;
    for (const ref of ownedScriptRefs(deploymentToml)) {
        try {
            out[ref.location] = await readBlob(ref.digest);
        } catch (_) { /* skip an unreadable blob */ }
    }
    return out;
}

// Scan top-level component blocks for owned sources: a non-oci `location` paired
// with a `content_digest` in the same main table.
function ownedScriptRefs(toml) {
    const refs = [];
    let location = null;
    let digest = null;
    let inTable = false;
    const flush = () => {
        if (location && digest && !location.startsWith("oci://")) refs.push({ location, digest });
        location = null;
        digest = null;
    };
    for (const line of toml.split("\n")) {
        const t = line.trim();
        if (t.startsWith("[[") && !t.includes(".")) { flush(); inTable = true; continue; }
        if (t.startsWith("[")) { inTable = false; continue; }   // sub-table: skip its keys
        if (!inTable) continue;
        const loc = tomlString(t, "location");
        if (loc !== null) location = loc;
        const dig = tomlString(t, "content_digest");
        if (dig !== null) digest = dig;
    }
    flush();
    return refs;
}

function tomlString(line, key) {
    if (!line.startsWith(key)) return null;
    const rest = line.slice(key.length).trim();
    if (!rest.startsWith("=")) return null;
    const v = rest.slice(1).trim();
    if (v.length < 2 || v[0] !== '"' || v[v.length - 1] !== '"') return null;
    return v.slice(1, -1);
}

// Compare two { fileName -> source } maps. Added and removed entries include
// their complete source so the approval card always shows the actual change.
function diffSources(oldMap, newMap) {
    const oldKeys = new Set(Object.keys(oldMap));
    const newKeys = new Set(Object.keys(newMap));
    const added = [...newKeys].filter((k) => !oldKeys.has(k)).sort()
        .map((file) => ({ file, lines: lineDiff("", newMap[file]).filter((line) => line.tag === "+") }));
    const removed = [...oldKeys].filter((k) => !newKeys.has(k)).sort()
        .map((file) => ({ file, lines: lineDiff(oldMap[file], "").filter((line) => line.tag === "-") }));
    const changed = [];
    for (const k of [...newKeys].filter((x) => oldKeys.has(x)).sort()) {
        if (oldMap[k] !== newMap[k]) {
            changed.push({ file: k, lines: lineDiff(oldMap[k], newMap[k]) });
        }
    }
    return { added, removed, changed };
}

// Minimal line-level diff via an LCS table. Returns a list of
// { tag: " "|"-"|"+", text } rows, like a unified diff body.
function lineDiff(oldText, newText) {
    const a = String(oldText).split("\n");
    const b = String(newText).split("\n");
    const n = a.length, m = b.length;
    const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1
                : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    const rows = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { rows.push({ tag: " ", text: a[i] }); i += 1; j += 1; }
        else if (lcs[i + 1][j] >= lcs[i][j + 1]) { rows.push({ tag: "-", text: a[i] }); i += 1; }
        else { rows.push({ tag: "+", text: b[j] }); j += 1; }
    }
    while (i < n) { rows.push({ tag: "-", text: a[i] }); i += 1; }
    while (j < m) { rows.push({ tag: "+", text: b[j] }); j += 1; }
    return rows;
}

// Walk the workflow's responses and split them into:
//   - replies: the typed agent-reply emitted by each completed turn, in order
//     ({ final } | { tool_calls: [{ name, arguments_json }] })
//   - toolChildren: per-tool-call child execution records, in dispatch order
// The workflow's join_set_id encodes the activity it dispatched (the function
// name: `load-system-prompt`, `start`, `send`, `recv`, `cleanup`). We treat those as infrastructure
// and everything else as a workflow-visible tool call. The `recv` activity now
// returns a typed turn-outcome, so there is no LLM JSON left to parse here.
const INFRA_NAMES = new Set([
    "load-system-prompt", "completion", "inject", "injection",
]);

async function loadResponses(execId, startCursor = 0) {
    const replies = [];
    const toolChildren = [];
    let cursor = startCursor;
    let including = startCursor === 0;
    while (true) {
        let payload;
        try {
            payload = await getExecutionResponses(execId, cursor, including, 200);
        } catch (_) { break; }
        const responses = payload.responses || [];
        for (const r of responses) {
            const wrapped = r.event?.event;
            const ev = wrapped?.event;
            if (!ev || ev.type !== "child_execution_finished") continue;
            const joinName = parseJoinName(wrapped.join_set_id);

            if (joinName === "completion") {
                // llm.completion ok = { reply: { content_json, stop_reason } } or
                // { rate_limited: {...} } (skipped). content_json is a neutral
                // block array; map to the UI reply shape:
                // { tool_calls: [{ name, arguments_json }] } | { response }.
                const value = ev.result?.ok?.value ?? ev.result?.ok;
                const rep = value && typeof value === "object" ? value.reply : null;
                if (rep && typeof rep === "object" && typeof rep.content_json === "string") {
                    let blocks = [];
                    try { blocks = JSON.parse(rep.content_json); } catch (_) { blocks = []; }
                    if (!Array.isArray(blocks)) blocks = [];
                    const toolUses = blocks.filter((b) => b && b.type === "tool_use");
                    const text = blocks.filter((b) => b && b.type === "text").map((b) => b.text || "").join("");
                    const reply = toolUses.length > 0
                        ? { tool_calls: toolUses.map((b) => ({ name: b.name, arguments_json: JSON.stringify(b.input || {}) })) }
                        : { response: text };
                    replies.push({
                        reply,
                        presentation: "",
                        blocks: [],
                        narration: "",
                        created_at: r.event?.created_at || "",
                    });
                }
            } else if (joinName && !INFRA_NAMES.has(joinName)) {
                toolChildren.push({
                    id: ev.child_execution_id,
                    result: unwrapTypedResult(ev.result),
                });
            }
        }
        if (responses.length === 0) break;
        const next = responses[responses.length - 1]?.cursor;
        if (typeof next !== "number" || next <= cursor) break;
        cursor = next;
        including = false;
        if (responses.length < 200) break;
    }
    return { replies, toolChildren, cursor };
}

async function loadRecvPresentation(executionId) {
    try {
        const logs = await getExecutionLogs(executionId, false, "", false, 200);
        let finalMessage = "";
        for (const entry of logs) {
            if (entry?.type !== "stream" || entry.stream_type !== "stderr") continue;
            let text;
            try {
                const bytes = Uint8Array.from(atob(entry.payload || ""), (char) => char.charCodeAt(0));
                text = new TextDecoder().decode(bytes);
            } catch (_) { continue; }
            for (const line of text.split("\n")) {
                if (!line.startsWith("[raw] ")) continue;
                try {
                    const event = JSON.parse(line.substring(6));
                    if (event?.type === "item.completed" && event.item?.type === "agent_message"
                        && typeof event.item.text === "string") {
                        finalMessage = event.item.text;
                    }
                } catch (_) { }
            }
        }
        return stripActionEnvelopes(finalMessage);
    } catch (_) {
        return "";
    }
}

function stripActionEnvelopes(text) {
    let output = "";
    let cursor = 0;
    while (cursor < text.length) {
        if (text[cursor] !== "{") {
            output += text[cursor];
            cursor += 1;
            continue;
        }
        const end = findMatchingBrace(text, cursor);
        if (end === -1) {
            output += text.slice(cursor);
            break;
        }
        const slice = text.slice(cursor, end + 1);
        let isEnvelope = false;
        try {
            const value = JSON.parse(slice);
            isEnvelope = value && typeof value === "object"
                && (Array.isArray(value.tool_calls) || typeof value.response === "string" || typeof value.final === "string"
                    || typeof value.error === "string");
        } catch (_) { }
        if (!isEnvelope) output += slice;
        cursor = end + 1;
    }
    return output.replace(/```(?:json)?\s*```/g, "").trim();
}

function findMatchingBrace(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
        const char = text[i];
        if (escaped) { escaped = false; continue; }
        if (char === "\\") { escaped = true; continue; }
        if (char === "\"") { inString = !inString; continue; }
        if (inString) continue;
        if (char === "{") depth += 1;
        else if (char === "}") {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

// The tool responses *as the model received them* are the `tool_result` blocks
// in the message history passed to each llm.completion. Those are not in
// /responses when dispatch fails before a child execution is started, so read
// the completion request params and flatten them in dispatch order.
async function loadSentResults(execId, startVersion = 0) {
    const sent = [];
    const operatorMessages = [];
    const seenToolResults = new Set();
    let version = startVersion;
    let including = startVersion === 0;
    while (true) {
        let payload;
        try {
            payload = await getExecutionEvents(execId, "version", version, including, 200);
        } catch (_) { break; }
        const events = payload.events || [];
        for (const e of events) {
            const he = e.event?.history_event?.event;
            if (!he || he.type !== "join_set_request") continue;
            const joinName = parseJoinName(he.join_set_id);
            if (joinName === "completion") {
                const messages = parseMessagesParam(he.request?.params?.[1]);
                for (const msg of messages) {
                    for (const block of Array.isArray(msg?.content) ? msg.content : []) {
                        if (!block || block.type !== "tool_result") continue;
                        const id = String(block.tool_use_id || "");
                        if (id && seenToolResults.has(id)) continue;
                        if (id) seenToolResults.add(id);
                        sent.push(normalizeToolResultBlock(block));
                    }
                }
            } else if (joinName === "send") {
                // backcompat: pre-agent-loop rewrite stored sent tool results in
                // a session.send request instead of the completion history.
                const input = he.request?.params?.[1];
                if (input && Array.isArray(input.tool_results)) {
                    for (const tr of input.tool_results) sent.push(normalizeSent(tr));
                }
                const messages = he.request?.params?.[2];
                if (Array.isArray(messages)) {
                    for (const text of messages) {
                        if (typeof text === "string" && text.trim()) {
                            operatorMessages.push({
                                text: text.trim(),
                                created_at: e.created_at || "",
                            });
                        }
                    }
                }
            }
        }
        if (events.length === 0) break;
        const next = events[events.length - 1]?.version;
        if (typeof next !== "number" || next <= version) break;
        version = next;
        including = false;
        if (events.length < 200) break;
    }
    return { results: sent, operatorMessages, version };
}

function parseMessagesParam(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string" || !value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
}

function normalizeToolResultBlock(block) {
    const out = { id: String(block.tool_use_id || "") };
    const content = String(block.content ?? "");
    if (block.is_error) {
        out.err = content.replace(/^Error:\s*/, "");
    } else {
        try { out.ok = JSON.parse(content); }
        catch (_) { out.ok = content; }
    }
    return out;
}

// A sent tool_result entry is { name, outcome: { ok|err } } where ok is the
// activity's JSON string. Normalise to { ok }/{ err }, JSON-parsing ok so the
// UI can pretty-print (mirrors unwrapTypedResult).
function normalizeSent(entry) {
    const o = entry && entry.outcome;
    if (o && "ok" in o) {
        let v = o.ok;
        if (typeof v === "string") { try { v = JSON.parse(v); } catch (_) { /* keep string */ } }
        return { ok: v };
    }
    if (o && "err" in o) return { err: o.err };
    return null;
}

function parseJoinName(joinSetId) {
    // One-off join sets use "o:<ordinal>-<name>"; explicitly named join sets
    // use "n:<name>".
    if (typeof joinSetId !== "string") return "";
    if (joinSetId.startsWith("n:")) return joinSetId.substring(2);
    const dash = joinSetId.indexOf("-");
    return dash === -1 ? "" : joinSetId.substring(dash + 1);
}

// Activity results arrive as { ok: { type, value } } or { err: ... }. We
// normalise to {ok: ...} or {err: "..."}. For string-typed ok values we try
// to JSON-parse so the UI can pretty-print.
function unwrapTypedResult(result) {
    if (!result || typeof result !== "object") return null;
    if ("ok" in result) {
        let value = result.ok;
        if (value && typeof value === "object" && "value" in value) value = value.value;
        if (typeof value === "string") {
            try { return { ok: JSON.parse(value) }; }
            catch { return { ok: value }; }
        }
        return { ok: value };
    }
    if ("err" in result) {
        const e = result.err;
        return { err: typeof e === "string" ? e : (e?.value ?? JSON.stringify(e)) };
    }
    return null;
}

// ----- mutations --------------------------------------------------------

async function submit(request) {
    let body;
    try { body = await request.text(); }
    catch (e) { return jsonError(400, `cannot read body: ${String(e)}`); }
    let payload;
    try { payload = JSON.parse(body); }
    catch (e) { return jsonError(400, `body must be JSON: ${e.message}`); }
    const prompt = payload?.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) {
        return jsonError(400, "prompt is required");
    }
    // backend is the workflow's option<string>: null => claude.
    const backend = (typeof payload?.backend === "string" && payload.backend) ? payload.backend : null;
    // effort is the reasoning level (option<string>): null => provider default.
    const effort = (typeof payload?.effort === "string" && payload.effort) ? payload.effort : null;
    const execId = obelisk.executionIdGenerate();
    try { submitWorkflowExecution(execId, prompt, backend, effort); }
    catch (e) { return jsonError(502, `schedule failed: ${String(e)}`); }
    return jsonResponse({ execution_id: execId });
}

// Pause or unpause a run via the native execution endpoints. A paused execution
// reports pending_state.status == "paused". Obelisk pauses a single execution,
// but the agent loop runs in a nested child workflow (the `n:session_1`
// `workflow.agent-loop` execution), so pausing only the root leaves the session
// running. Pause/unpause every non-terminal workflow in the run as well.
async function pauseExecution(id, unpause) {
    if (!id) return jsonError(400, "missing run id");
    const verb = unpause ? "unpause" : "pause";
    const targets = [id, ...await childWorkflowIds(id)];
    const failures = [];
    for (const target of targets) {
        try {
            if (unpause) unpauseObeliskExecution(target);
            else pauseObeliskExecution(target);
        } catch (e) {
            failures.push(`${target}: ${String(e)}`);
        }
    }
    if (failures.length) {
        return jsonError(502, `${verb} failed: ${failures.join("; ")}`);
    }
    return jsonResponse({ ok: true, paused: targets });
}

// Non-terminal nested workflow executions of a run (e.g. the agent-loop session
// child). Excludes the run itself; activities/stubs are not paused.
async function childWorkflowIds(runId) {
    let executions;
    try {
        executions = await listExecutions("", runId, true, true, 200);
    } catch (_) { return []; }
    return executions
        .filter((e) => e?.execution_id !== runId && e?.component_type === "workflow")
        .map((e) => e.execution_id);
}

// Fulfil the concrete pending injection stub owned by this workflow. The
// workflow consumes the response and includes it in its next session.send call.
async function sayToAgent(request, runId) {
    if (!runId) return jsonError(400, "missing run id");
    let payload;
    try { payload = JSON.parse(await request.text()); }
    catch (e) { return jsonError(400, `body must be JSON: ${e.message}`); }
    const text = payload?.text;
    if (typeof text !== "string" || !text.trim()) return jsonError(400, "text is required");
    const injection = await loadPendingInjection(runId);
    if (!injection) return jsonError(409, "agent is not currently accepting an injected message");
    try { stubObeliskExecution(injection.id, { ok: text.trim() }); }
    catch (e) { return jsonError(502, `injection fulfil failed: ${String(e)}`); }
    return jsonResponse({ child_execution_id: injection.id });
}

async function answerStub(request, childId) {
    if (!childId) return jsonError(400, "missing child id");
    let body;
    try { body = await request.text(); }
    catch (e) { return jsonError(400, `cannot read body: ${String(e)}`); }
    let payload;
    try { payload = JSON.parse(body); }
    catch (e) { return jsonError(400, `body must be JSON: ${e.message}`); }
    const answer = payload?.answer;
    if (typeof answer !== "string" || !answer) {
        return jsonError(400, "answer is required");
    }
    try { stubObeliskExecution(childId, { ok: answer }); }
    catch (e) { return jsonError(502, `stub fulfil failed: ${String(e)}`); }
    return jsonResponse({ ok: true });
}

// Approve or reject a pending hot-reload confirmation. Fulfils the confirm-apply
// stub with its `ok` arm (approve => the workflow proceeds to switch) or its
// `err` arm (reject => the workflow returns an err tool_result to the agent).
async function confirmDeploy(request, childId) {
    if (!childId) return jsonError(400, "missing child id");
    let body;
    try { body = await request.text(); }
    catch (e) { return jsonError(400, `cannot read body: ${String(e)}`); }
    let payload;
    try { payload = JSON.parse(body); }
    catch (e) { return jsonError(400, `body must be JSON: ${e.message}`); }
    const approve = Boolean(payload?.approve);
    const stubResult = approve
        ? { ok: null }
        : { err: "operator cancelled" };
    try { stubObeliskExecution(childId, stubResult); }
    catch (e) { return jsonError(502, `stub fulfil failed: ${String(e)}`); }
    return jsonResponse({ ok: true });
}

// ----- SPA shell --------------------------------------------------------

function htmlShell() {
    const uiUrl = (process.env["OBELISK_UI_URL"] || "http://localhost:8080").replace(/\/$/, "");
    const html = SHELL_HTML.replace("__OBELISK_UI_URL__", uiUrl);
    return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
    });
}

const SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>obelisk-agent</title>
<style>
  :root {
    --bg: #fafafa; --panel: #fff; --line: #e5e5e5; --muted: #777;
    --accent: #2868c8; --accent-bg: #eef3fb;
    --ok: #2a7a3a; --ok-bg: #ebf6ee;
    --err: #b32626; --err-bg: #fcecec;
    --warn: #965c00;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { font: 14px/1.45 -apple-system, system-ui, sans-serif; color: #1d1d1f; background: var(--bg); display: flex; }
  aside { width: 300px; border-right: 1px solid var(--line); background: var(--panel); display: flex; flex-direction: column; }
  main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  #detail { flex: 1; overflow-y: auto; padding: 1.5rem 2rem; }
  aside header { padding: 1rem; border-bottom: 1px solid var(--line); }
  aside header h1 { margin: 0 0 0.6rem; font-size: 1rem; font-weight: 600; }
  #new-convo { width: 100%; padding: 0.55em 0.9em; font: inherit; font-weight: 600; cursor: pointer; border: 1px solid var(--accent); background: var(--accent); color: white; border-radius: 4px; }
  #new-convo:hover { background: #1f57ad; }
  #composer { border-top: 1px solid var(--line); background: var(--panel); padding: 0.7rem 2rem 1rem; }
  #composer form textarea { width: 100%; resize: vertical; min-height: 3em; max-height: 40vh; padding: 0.5em 0.7em; border: 1px solid var(--line); border-radius: 6px; font: inherit; }
  #composer form textarea:disabled { background: #f4f4f4; }
  .composer-row { display: flex; gap: 0.5em; align-items: center; margin-top: 0.5em; }
  .composer-selects { display: flex; gap: 0.5em; flex: 1; flex-wrap: wrap; min-width: 0; }
  #composer select { padding: 0.4em; border: 1px solid var(--line); border-radius: 4px; font: inherit; background: var(--panel); max-width: 100%; }
  #composer-send { margin-left: auto; padding: 0.5em 1.3em; font: inherit; font-weight: 600; cursor: pointer; border: 1px solid var(--accent); background: var(--accent); color: white; border-radius: 6px; }
  #composer-send:disabled { opacity: 0.5; cursor: not-allowed; }
  .working { display: flex; align-items: center; gap: 0.5em; margin-bottom: 0.5em; color: var(--warn); font-size: 0.85em; font-weight: 600; }
  .working[hidden] { display: none; }
  .working .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--warn); animation: workpulse 1s ease-in-out infinite; }
  @keyframes workpulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.3; transform: scale(0.7); } }
  .runs { flex: 1; overflow-y: auto; }
  .run-item { display: block; padding: 0.7rem 1rem; border-bottom: 1px solid var(--line); cursor: pointer; text-decoration: none; color: inherit; }
  .run-item:hover { background: #f4f4f4; }
  .run-item.active { background: var(--accent-bg); border-left: 3px solid var(--accent); padding-left: calc(1rem - 3px); }
  .run-prompt { font-weight: 500; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .run-meta { color: var(--muted); font-size: 0.8em; margin-top: 0.2em; display: flex; justify-content: space-between; }
  .run-meta .status { font-weight: 600; }
  .run-meta .status.finished { color: var(--ok); }
  .run-meta .status.pending_now, .run-meta .status.locked, .run-meta .status.unfinished { color: var(--warn); }
  .run-meta .status.paused, .meta .status.paused { color: var(--accent); }
  .run-meta .status.working, .meta .status.working { color: var(--warn); }
  .run-meta .status.awaiting, .meta .status.awaiting { color: var(--accent); font-weight: 700; }
  .run-meta .status.timeout, .run-meta .status.permanently_failed, .run-meta .status.permanently_timed_out, .run-meta .status.err { color: var(--err); }
  main .empty { color: var(--muted); margin-top: 4rem; text-align: center; }
  main h2 { margin: 0 0 0.5rem; font-size: 1.05rem; font-weight: 600; }
  .meta { color: var(--muted); font-size: 0.85em; margin-bottom: 1.5rem; }
  .meta code { font-size: 1em; }
  .bubble { padding: 0.8em 1em; border-radius: 8px; margin: 0.6em 0; max-width: 720px; }
  .bubble.user { background: var(--accent-bg); border: 1px solid #d0deef; }
  .bubble.final { background: var(--ok-bg); border: 1px solid #c6e0ce; }
  .bubble.error { background: var(--err-bg); border: 1px solid #e5b8b8; color: var(--err); }
  .bubble.thinking { background: #faf7ff; border: 1px solid #e0d6f0; color: #4a4458; }
  .bubble.thinking .label { color: #7a5ea8; }
  .bubble pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; }
  .bubble.markdown { background: var(--panel); border: 1px solid var(--line); }
  .rendered-markdown > :first-child { margin-top: 0; }
  .rendered-markdown > :last-child { margin-bottom: 0; }
  .rendered-markdown pre { padding: 0.6em; background: #f7f7f7; border-radius: 4px; overflow-x: auto; font: 12px/1.45 ui-monospace, monospace; }
  .rendered-markdown code { font-family: ui-monospace, monospace; }
  .bubble.mermaid-block { max-width: 960px; overflow-x: auto; background: white; border: 1px solid var(--line); }
  .bubble.mermaid-block svg { max-width: 100%; height: auto; }
  .bubble.mermaid-block .render-error { color: var(--err); white-space: pre-wrap; }
  .label { font-size: 0.75em; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.25em; }
  .turn { margin: 1em 0; }
  .turn-header { font-weight: 600; color: var(--muted); font-size: 0.85em; margin-bottom: 0.3em; }
  .calls { display: flex; flex-direction: column; gap: 0.4em; }
  .call { border: 1px solid var(--line); border-radius: 6px; background: white; }
  .call summary { padding: 0.5em 0.8em; cursor: pointer; display: flex; gap: 0.5em; align-items: baseline; }
  .call summary code { font-weight: 600; color: var(--accent); }
  .call summary .child-link { font: 11px/1 ui-monospace, monospace; color: var(--muted); text-decoration: none; padding: 0.1em 0.4em; border-radius: 3px; background: #f0f0f0; }
  .call summary .child-link:hover { background: #e3e3e3; color: var(--accent); }
  .meta a { color: var(--accent); text-decoration: none; }
  .meta a:hover { text-decoration: underline; }
  .meta button { border: 0; background: none; color: var(--accent); cursor: pointer; padding: 0; font: inherit; }
  .meta button:hover { text-decoration: underline; }
  .call summary .status-pill { margin-left: auto; font-size: 0.8em; padding: 0.05em 0.5em; border-radius: 3px; }
  .call summary .status-pill.ok { background: var(--ok-bg); color: var(--ok); }
  .call summary .status-pill.err { background: var(--err-bg); color: var(--err); }
  .call summary .status-pill.pending { background: #f0f0f0; color: var(--muted); }
  .call .args, .call .result { padding: 0 0.8em 0.6em; }
  .call pre { margin: 0; padding: 0.5em 0.8em; background: #f7f7f7; border-radius: 4px; font: 12px/1.4 ui-monospace, monospace; white-space: pre-wrap; word-break: break-word; max-height: 14em; overflow-y: auto; }
  .call .args .key, .call .result .key { color: var(--muted); font-size: 0.8em; margin: 0.5em 0 0.2em; }
  form.ask { background: #fffaf2; border: 1px solid #f0d8a8; border-radius: 6px; padding: 0.8em 1em; margin: 1.4em 0; max-width: 720px; }
  form.ask p { margin: 0 0 0.5em; font-weight: 600; }
  form.ask .ask-question { margin-bottom: 0.6em; font-weight: 600; }
  form.ask textarea { width: 100%; min-height: 4em; padding: 0.4em; border: 1px solid var(--line); border-radius: 4px; font: inherit; }
  form.ask button { margin-top: 0.4em; }
  .confirm { background: #fff7ed; border: 1px solid #f0c98a; border-radius: 6px; padding: 0.8em 1em; margin: 1em 0; }
  .confirm .label { color: var(--warn); }
  .confirm h3 { margin: 0.1em 0 0.4em; font-size: 0.95rem; }
  .confirm .dep-id { font: 12px/1 ui-monospace, monospace; color: var(--muted); }
  .confirm .summary { margin: 0.4em 0 0.6em; white-space: pre-wrap; }
  .confirm .diff { border: 1px solid var(--line); border-radius: 4px; background: white; margin: 0.5em 0; }
  .confirm .diff > summary { padding: 0.4em 0.7em; cursor: pointer; font-weight: 600; }
  .confirm .diff pre { margin: 0; padding: 0.4em 0; background: #fbfbfb; font: 12px/1.4 ui-monospace, monospace; white-space: pre-wrap; word-break: break-word; max-height: 22em; overflow-y: auto; }
  .confirm .diff .dl { display: block; padding: 0 0.7em; }
  .confirm .diff .dl.add { background: var(--ok-bg); color: var(--ok); }
  .confirm .diff .dl.del { background: var(--err-bg); color: var(--err); }
  .confirm .diff .fname { display: block; padding: 0.3em 0.7em; font-weight: 600; background: #f2f2f2; border-top: 1px solid var(--line); }
  .confirm .changes { color: var(--muted); font-size: 0.85em; margin: 0.3em 0; }
  .confirm .buttons { display: flex; gap: 0.5em; margin-top: 0.6em; }
  .confirm button.approve { border: 1px solid var(--ok); background: var(--ok); color: white; border-radius: 4px; padding: 0.4em 0.9em; cursor: pointer; font: inherit; }
  .confirm button.reject { border: 1px solid var(--err); background: white; color: var(--err); border-radius: 4px; padding: 0.4em 0.9em; cursor: pointer; font: inherit; }
  .logs { max-width: 960px; border: 1px solid var(--line); border-radius: 6px; background: #111; color: #ddd; margin: 0.8em 0 1.2em; }
  .logs .logs-head { padding: 0.5em 0.8em; border-bottom: 1px solid #333; display: flex; justify-content: space-between; }
  .logs .logs-head button { color: #9cc2ff; border: 0; background: none; cursor: pointer; }
  .logs pre { margin: 0; padding: 0.8em; max-height: 32em; overflow: auto; white-space: pre-wrap; word-break: break-word; font: 12px/1.45 ui-monospace, monospace; }
  .logs .source { color: #8eaccf; }
  .logs .level-error { color: #ff9b9b; }
  .logs .level-warn { color: #ffd27d; }
  .meta #pause-btn, .meta #unpause-btn { border: 0; background: none; color: var(--accent); cursor: pointer; padding: 0; font: inherit; }
  .meta #pause-btn:hover, .meta #unpause-btn:hover { text-decoration: underline; }
  .err-box { background: var(--err-bg); border: 1px solid #f4c0c0; color: var(--err); padding: 0.6em 0.9em; border-radius: 4px; margin: 1em 0; }
  .ago { color: var(--muted); font-size: 0.8em; }
</style>
<script src="https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.min.js"></script>
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.12.0/dist/mermaid.esm.min.mjs";
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  window.renderMermaidBlocks = async (nodes) => {
    await mermaid.run({ nodes, suppressErrors: false });
  };
</script>
</head>
<body>
<aside>
  <header>
    <h1>obelisk-agent</h1>
    <button type="button" id="new-convo">+ New conversation</button>
  </header>
  <div class="runs" id="runs"></div>
</aside>
<main>
  <div id="detail" class="transcript">
    <p class="empty">Start a new conversation below, or pick a run from the sidebar.</p>
  </div>
  <div id="composer">
    <div id="working" class="working" hidden><span class="dot"></span><span id="working-label">Agent is working…</span></div>
    <form id="composer-form">
      <textarea id="composer-input" placeholder="Ask the agent..." rows="3"></textarea>
      <div class="composer-row">
        <div class="composer-selects" id="composer-selects">
          <select id="new-backend" title="model"></select>
          <select id="new-effort" title="reasoning effort">
            <option value="">effort: default</option>
            <option value="off">off</option>
            <option value="minimal">minimal</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
          </select>
        </div>
        <button type="submit" id="composer-send">Send</button>
      </div>
    </form>
  </div>
</main>
<script>
const OBELISK_UI_URL = "__OBELISK_UI_URL__";
const state = {
  selected: null,
  runs: [],
  detail: null,
  // Accumulated records plus the last server positions already fetched.
  transcript: null,
  lastSig: null,
  logs: null,
  logsCursor: '',
  logsOpen: false,
};
const SIDEBAR_POLL_MS = 10000;
const DETAIL_POLL_MS = 3000;
let sidebarTimer = null;
let detailTimer = null;
let sidebarRequest = null;
let detailRequest = null;
let detailAbort = null;
let logsRequest = null;

function execLink(id) {
  return OBELISK_UI_URL + '/execution/' + encodeURIComponent(id);
}

function esc(s) {
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function ago(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

function statusLabel(status, result_kind) {
  if (status !== 'finished') return status.replaceAll('_', ' ');
  if (typeof result_kind === 'string') return result_kind;
  if (result_kind && typeof result_kind === 'object') {
    if (result_kind.ok !== undefined || result_kind.Ok !== undefined) return 'ok';
    if (result_kind.err !== undefined || result_kind.Err !== undefined) return 'err';
  }
  return 'finished';
}

// A blocked run is waiting on a join set whose name suffix is the function it
// dispatched (e.g. "o:20-ask-user"). Translate that into a specific label + a
// css class so the sidebar/detail say what the run is actually doing.
const JOIN_LABELS = {
  'ask-user': ['awaiting reply', 'awaiting'],
  'confirm-apply': ['awaiting approval', 'awaiting'],
  'completion': ['thinking', 'working'],
  'operator': ['your turn', 'awaiting'],
};
function describeStatus(status, result_kind, joinName) {
  if (status === 'blocked_by_join_set') {
    const hit = JOIN_LABELS[joinName];
    if (hit) return { label: hit[0], cls: hit[1] };
    if (joinName) return { label: joinName.replaceAll('-', ' '), cls: 'working' };
    return { label: 'blocked', cls: 'working' };
  }
  const label = statusLabel(status, result_kind);
  return { label, cls: label.replaceAll(' ', '_') };
}

function readSelectedFromUrl() {
  const m = window.location.search.match(/[?&]run=([^&]+)/);
  state.selected = m ? decodeURIComponent(m[1]) : null;
}

function setSelected(id) {
  if (id !== state.selected && detailAbort) detailAbort.abort();
  state.selected = id;
  state.detail = null;
  state.transcript = null;
  state.lastSig = null;
  state.logs = null;
  state.logsCursor = '';
  state.logsOpen = false;
  clearTimeout(detailTimer);
  const u = new URL(window.location.href);
  if (id) u.searchParams.set('run', id); else u.searchParams.delete('run');
  window.history.replaceState({}, '', u.toString());
  renderSidebar();
  refreshDetail();
}

function scheduleSidebarRefresh() {
  clearTimeout(sidebarTimer);
  if (document.hidden) return;
  sidebarTimer = setTimeout(refreshSidebar, SIDEBAR_POLL_MS);
}

function refreshSidebar() {
  if (sidebarRequest) return sidebarRequest;
  clearTimeout(sidebarTimer);
  sidebarRequest = (async () => {
    try {
      const r = await fetch('/api/runs', { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      const data = await r.json();
      state.runs = data.runs || [];
      renderSidebar();
    } catch (_) {
    } finally {
      sidebarRequest = null;
      scheduleSidebarRefresh();
    }
  })();
  return sidebarRequest;
}

function renderSidebar() {
  const box = document.getElementById('runs');
  if (state.runs.length === 0) {
    box.innerHTML = '<p style="padding: 1rem; color: var(--muted)">No runs yet.</p>';
    return;
  }
  box.innerHTML = state.runs.map((r) => {
    const { label, cls } = describeStatus(r.status, r.result_kind, r.join_name);
    return '<a class="run-item' + (r.id === state.selected ? ' active' : '') + '" href="?run=' + encodeURIComponent(r.id) + '" data-id="' + esc(r.id) + '">'
      + '<div class="run-prompt">' + esc(r.prompt_preview || '(no prompt)') + '</div>'
      + '<div class="run-meta"><span class="status ' + esc(cls) + '">' + esc(label) + '</span><span class="ago">' + esc(ago(r.created_at)) + '</span></div>'
      + '</a>';
  }).join('');
  for (const a of box.querySelectorAll('.run-item')) {
    a.addEventListener('click', (ev) => { ev.preventDefault(); setSelected(a.dataset.id); });
  }
}

function scheduleDetailRefresh() {
  clearTimeout(detailTimer);
  if (document.hidden || !state.selected || runPhase(state.detail?.status) === 'terminal') return;
  detailTimer = setTimeout(refreshDetail, DETAIL_POLL_MS);
}

function refreshDetail() {
  const main = document.getElementById('detail');
  if (!state.selected) {
    main.innerHTML = '<p class="empty">Start a new conversation below, or pick a run from the sidebar.</p>';
    state.detail = null;
    renderComposer();
    return Promise.resolve();
  }
  const selected = state.selected;
  if (detailRequest) {
    if (detailRequest.id === selected) return detailRequest.promise;
    detailAbort?.abort();
  }
  clearTimeout(detailTimer);
  const controller = new AbortController();
  detailAbort = controller;
  const promise = (async () => {
    try {
      const query = new URLSearchParams();
      if (state.transcript?.agent_loop_id) {
        query.set('agent_loop_id', state.transcript.agent_loop_id);
        query.set('response_cursor', String(state.transcript.response_cursor || 0));
        query.set('history_version', String(state.transcript.history_version || 0));
      }
      const suffix = query.toString() ? '?' + query.toString() : '';
      const r = await fetch('/api/runs/' + encodeURIComponent(selected) + suffix, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (selected !== state.selected) return;
      if (!r.ok) {
        main.innerHTML = '<div class="err-box">Failed to load run: HTTP ' + r.status + '</div>';
        return;
      }
      const detail = await r.json();
      mergeTranscript(detail.transcript);
      detail.turns = buildCachedTurns();
      delete detail.transcript;
      state.detail = detail;
      if (selected === state.selected) {
        renderDetail();
        if (state.logsOpen) refreshLogs();
      }
    } catch (e) {
      if (e.name !== 'AbortError' && selected === state.selected) {
        main.innerHTML = '<div class="err-box">' + esc(String(e)) + '</div>';
      }
    } finally {
      if (detailRequest?.promise === promise) {
        detailRequest = null;
        detailAbort = null;
        scheduleDetailRefresh();
      }
    }
  })();
  detailRequest = { id: selected, promise };
  return promise;
}

function mergeTranscript(delta) {
  if (!delta) return;
  const reset = delta.reset || !state.transcript
    || state.transcript.agent_loop_id !== delta.agent_loop_id;
  if (reset) {
    state.transcript = {
      agent_loop_id: delta.agent_loop_id || '',
      replies: [],
      tool_children: [],
      sent_results: [],
      operator_messages: [],
      response_cursor: 0,
      history_version: 0,
    };
  }
  state.transcript.replies.push(...(delta.replies || []));
  state.transcript.tool_children.push(...(delta.tool_children || []));
  mergeSentResults(state.transcript.sent_results, delta.sent_results || []);
  state.transcript.operator_messages.push(...(delta.operator_messages || []));
  state.transcript.response_cursor = delta.response_cursor || state.transcript.response_cursor;
  state.transcript.history_version = delta.history_version || state.transcript.history_version;
}

function mergeSentResults(target, incoming) {
  const seen = new Set(target.map((item) => item && item.id).filter(Boolean));
  for (const item of incoming) {
    if (!item) continue;
    if (item.id && seen.has(item.id)) continue;
    if (item.id) seen.add(item.id);
    target.push(item);
  }
}

function buildCachedTurns() {
  const cached = state.transcript;
  if (!cached) return [];
  const turns = [];
  let toolCursor = 0;
  let sequence = 0;
  for (const item of cached.replies) {
    const reply = item && item.reply;
    const blocks = normalizeCachedBlocks(
      item?.blocks,
      typeof item?.presentation === 'string' ? item.presentation : '',
      typeof item?.narration === 'string' ? item.narration : '',
      reply,
    );
    if (!reply || typeof reply !== 'object') continue;
    const responseText = typeof reply.response === 'string' ? reply.response : reply.final;
    if (typeof responseText === 'string') {
      turns.push({ kind: 'assistant_response', text: responseText, blocks, created_at: item.created_at, sequence: sequence++ });
    } else if (typeof reply.error === 'string') {
      turns.push({ kind: 'error', text: reply.error, blocks, created_at: item.created_at, sequence: sequence++ });
    } else if (Array.isArray(reply.tool_calls)) {
      const calls = reply.tool_calls.map((call) => {
        const child = cached.tool_children[toolCursor];
        const sent = cached.sent_results[toolCursor];
        toolCursor += 1;
        const rendered = {
          name: call?.name,
          args: parseCachedArgs(call?.arguments_json),
          child_id: child?.id ?? null,
        };
        const result = sent || child?.result;
        if (result && 'ok' in result) rendered.ok = result.ok;
        else if (result && 'err' in result) rendered.err = result.err;
        return rendered;
      });
      turns.push({ kind: 'tool_calls', calls, blocks, created_at: item.created_at, sequence: sequence++ });
    }
  }
  for (const message of cached.operator_messages || []) {
    if (typeof message?.text !== 'string' || !message.text.trim()) continue;
    turns.push({
      kind: 'operator_message',
      text: message.text,
      created_at: message.created_at || '',
      sequence: sequence++,
    });
  }
  turns.sort((a, b) => {
    if (a.created_at && b.created_at && a.created_at !== b.created_at) {
      return a.created_at.localeCompare(b.created_at);
    }
    return a.sequence - b.sequence;
  });
  return turns;
}

function parseCachedArgs(json) {
  if (typeof json !== 'string' || !json) return {};
  try { return JSON.parse(json); } catch (_) { return { raw: json }; }
}

function normalizeCachedBlocks(blocks, presentation, narration, reply) {
  const out = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const kind = block?.kind === 'mermaid'
      ? 'mermaid' : (block?.kind === 'thinking' ? 'thinking' : 'markdown');
    if (typeof block?.content === 'string' && block.content.trim()) {
      out.push({ kind, content: block.content });
    }
  }
  if (presentation.trim()) out.push(...splitCachedMermaid(presentation, 'markdown'));
  if (narration.trim()) out.push(...splitCachedMermaid(narration, 'thinking'));
  const responseText = typeof reply?.response === 'string' ? reply.response : reply?.final;
  if (out.length === 0 && typeof responseText === 'string') {
    out.push(...splitCachedMermaid(responseText, 'markdown'));
  }
  return out;
}

function splitCachedMermaid(text, proseKind) {
  const source = String(text || '').replace(
    /\`\`\`markdown\\s*\\n([\\s\\S]*?)\\nmermaid\\s*\\n([\\s\\S]*?)\`\`\`/gi,
    (_, prose, diagram) => prose.trim() + '\\n\\n\`\`\`mermaid\\n' + diagram.trim() + '\\n\`\`\`',
  );
  const blocks = [];
  const pattern = /\`\`\`mermaid\\s*\\n([\\s\\S]*?)\`\`\`/gi;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const prose = source.slice(cursor, match.index).trim();
    if (prose) blocks.push({ kind: proseKind, content: prose });
    const diagram = match[1].trim();
    if (diagram) blocks.push({ kind: 'mermaid', content: diagram });
    cursor = pattern.lastIndex;
  }
  const tail = source.slice(cursor).trim();
  if (tail) blocks.push({ kind: proseKind, content: tail });
  return blocks;
}

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  const main = document.getElementById('detail');

  // The composer (new-prompt / steer box) + working indicator live outside the
  // transcript and reflect the live status every poll, even when the transcript
  // itself is unchanged.
  renderComposer();

  // Skip rendering when nothing changed - otherwise the 2 s poll trashes any
  // <details> the user opened.
  const sig = JSON.stringify({
    id: d.id, status: d.status, result_kind: d.result_kind, join_name: d.join_name,
    prompt: d.prompt, backend: d.backend, effort: d.effort, turns: d.turns, final_result: d.final_result,
    pending_asks: d.pending_asks, pending_confirms: d.pending_confirms,
    pending_injection: d.pending_injection,
  });
  if (sig === state.lastSig) return;

  // Capture which call cards are currently open so we can restore them.
  const openKeys = new Set();
  for (const el of main.querySelectorAll('details.call[open]')) {
    if (el.dataset.key) openKeys.add(el.dataset.key);
  }

  state.lastSig = sig;

  const phase = runPhase(d.status);
  const { label, cls: statusCls } = describeStatus(d.status, d.result_kind, d.join_name);
  const turnsHtml = d.turns.length === 0
    ? '<p style="color: var(--muted)">Agent is starting up...</p>'
    : d.turns.map((t, i) => renderTurn(t, i)).join('');

  const asksHtml = (d.pending_asks && d.pending_asks.length) ? d.pending_asks.map((a) =>
    '<form class="ask" data-child="' + esc(a.id) + '">'
    + renderedMarkdownHtml('ask-question', a.question || '(no question)')
    + '<textarea name="answer" required></textarea>'
    + '<button type="submit">Answer</button>'
    + '</form>'
  ).join('') : '';

  const confirmsHtml = (d.pending_confirms && d.pending_confirms.length)
    ? d.pending_confirms.map(renderConfirm).join('') : '';

  const finalHtml = renderFinal(d);
  const pauseBtn = phase === 'active'
    ? ' &middot; <button type="button" id="pause-btn">pause</button>'
    : (phase === 'paused' ? ' &middot; <button type="button" id="unpause-btn">unpause</button>' : '');

  main.innerHTML = ''
    + '<h2>' + esc(d.prompt ? truncate(d.prompt, 80) : 'Run') + '</h2>'
    + '<div class="meta">'
    +   '<a href="' + esc(execLink(d.id)) + '" target="_blank" rel="noopener"><code>' + esc(d.id) + '</code></a>'
    +   ' &middot; <span class="status ' + esc(statusCls) + '">' + esc(label) + '</span>'
    +   ' &middot; ' + esc(ago(d.created_at))
    +   (d.backend ? ' &middot; <code>' + esc(d.backend) + '</code>' : '')
    +   (d.effort ? ' &middot; <code>effort: ' + esc(d.effort) + '</code>' : '')
    +   ' &middot; <button type="button" id="logs-toggle">logs (including nested)</button>'
    +   pauseBtn
    + '</div>'
    + '<div id="logs-slot">' + renderLogs() + '</div>'
    + (d.prompt ? '<div class="bubble user"><div class="label">prompt</div><pre>' + esc(d.prompt) + '</pre></div>' : '')
    + confirmsHtml
    + turnsHtml
    + finalHtml
    + asksHtml;

  hydrateDisplayBlocks(main);

  for (const el of main.querySelectorAll('details.call')) {
    if (el.dataset.key && openKeys.has(el.dataset.key)) el.open = true;
  }

  for (const f of main.querySelectorAll('form.ask')) {
    f.addEventListener('submit', (ev) => {
      ev.preventDefault();
      submitAnswer(f.dataset.child, f.querySelector('textarea').value);
    });
  }

  for (const card of main.querySelectorAll('.confirm')) {
    const child = card.dataset.child;
    card.querySelector('button.approve')?.addEventListener('click', () => sendConfirm(child, true));
    card.querySelector('button.reject')?.addEventListener('click', () => sendConfirm(child, false));
  }
  main.querySelector('#logs-toggle')?.addEventListener('click', toggleLogs);
  main.querySelector('#pause-btn')?.addEventListener('click', () => setPaused(state.selected, false));
  main.querySelector('#unpause-btn')?.addEventListener('click', () => setPaused(state.selected, true));
}

// Status -> control phase. Active runs can expose the live "send to agent" box.
function runPhase(status) {
  if (status === 'finished' || /^permanently/.test(status)) return 'terminal';
  if (status === 'paused') return 'paused';
  return 'active';
}

// The persistent composer at the bottom of the right pane is context-sensitive:
//   - no run / terminal run  -> "new conversation": create a run (model+effort).
//   - active or paused run   -> "say": steer/reply to the running agent.
// A pending ask/confirm gate owns its own inline input, so the composer defers.
function hasHumanGate(d) {
  return Boolean(d && ((d.pending_asks && d.pending_asks.length) || (d.pending_confirms && d.pending_confirms.length)));
}
function isWorking(d) {
  if (!d || runPhase(d.status) !== 'active') return false;
  // describeStatus tags "your turn" / human gates as 'awaiting'; everything else
  // active (thinking, running a tool, locked) means the agent is busy.
  return describeStatus(d.status, d.result_kind, d.join_name).cls !== 'awaiting';
}
function composerMode() {
  const d = state.detail;
  if (!state.selected || !d || runPhase(d.status) === 'terminal') return 'new';
  return 'say';
}
function renderComposer() {
  const d = state.detail;
  const mode = composerMode();
  const gate = hasHumanGate(d);
  const working = isWorking(d);
  const input = document.getElementById('composer-input');
  const send = document.getElementById('composer-send');
  const selects = document.getElementById('composer-selects');
  const workingEl = document.getElementById('working');
  if (!input) return;

  workingEl.hidden = !working;
  selects.style.display = mode === 'new' ? 'flex' : 'none';

  if (gate) {
    input.placeholder = 'Respond to the request above...';
    input.disabled = true;
    send.disabled = true;
  } else {
    input.disabled = false;
    send.disabled = false;
    input.placeholder = mode === 'say'
      ? (working ? 'Steer the agent... (delivered next turn)' : 'Reply to the agent...')
      : 'Ask the agent...';
  }
}

// One pending hot-reload confirmation: agent summary, target deployment, the
// source diff vs the active deployment, and OK/Cancel controls.
function renderConfirm(c) {
  const diff = c.diff;
  let diffHtml;
  if (!diff) {
    diffHtml = '<p class="changes">(no diff available)</p>';
  } else if (diff.error) {
    diffHtml = '<p class="changes">Could not build diff: ' + esc(diff.error) + '</p>';
  } else {
    const counts = [];
    if (diff.added.length) counts.push(diff.added.length + ' added');
    if (diff.removed.length) counts.push(diff.removed.length + ' removed');
    if (diff.changed.length) counts.push(diff.changed.length + ' changed');
    const summary = counts.length ? counts.join(', ') : 'no source changes';
    let body = '';
    for (const f of diff.added) {
      body += '<span class="fname">+ ' + esc(f.file) + ' (new file)</span><pre>' + renderDiffLines(f.lines) + '</pre>';
    }
    for (const f of diff.removed) {
      body += '<span class="fname">- ' + esc(f.file) + ' (removed)</span><pre>' + renderDiffLines(f.lines) + '</pre>';
    }
    for (const ch of diff.changed) {
      body += '<span class="fname">~ ' + esc(ch.file) + '</span><pre>' + renderDiffLines(ch.lines) + '</pre>';
    }
    diffHtml = '<details class="diff"' + (diff.changed.length || diff.added.length ? ' open' : '') + '>'
      + '<summary>Source diff vs active deployment (' + esc(summary) + ')</summary>'
      + body + '</details>';
  }
  return '<div class="confirm" data-child="' + esc(c.id) + '">'
    + '<div class="label">hot reload pending approval</div>'
    + '<h3>Apply deployment?</h3>'
    + (c.deployment_id ? '<div class="dep-id">' + esc(c.deployment_id) + '</div>' : '')
    + (c.summary ? '<div class="summary">' + esc(c.summary) + '</div>' : '')
    + diffHtml
    + '<div class="buttons">'
    +   '<button type="button" class="approve">OK</button>'
    +   '<button type="button" class="reject">Cancel</button>'
    + '</div>'
    + '</div>';
}

function renderLogs() {
  if (!state.logsOpen) return '';
  if (!state.logs) {
    return '<div class="logs"><div class="logs-head"><span>execution logs</span></div><pre>Loading...</pre></div>';
  }
  const rows = state.logs.map((entry) => {
    const source = shortChildId(entry.execution_id || '') + ' ' + shortFfqn(entry.ffqn || '');
    const text = entry.type === 'stream' ? decodeStream(entry.payload) : String(entry.message || '');
    const level = entry.level ? ' level-' + esc(entry.level) : '';
    return '<span class="source">[' + esc(source.trim()) + ']</span> '
      + '<span class="' + level.trim() + '">' + esc(text.replace(/\\n$/, '')) + '</span>';
  });
  return '<div class="logs"><div class="logs-head"><span>execution logs · ' + rows.length
    + ' entries</span><button type="button" id="logs-refresh">refresh</button></div><pre>'
    + (rows.join('\\n') || '(no logs yet)') + '</pre></div>';
}

function shortFfqn(ffqn) {
  const slash = ffqn.lastIndexOf('/');
  return slash === -1 ? ffqn : ffqn.substring(slash + 1);
}

function decodeStream(payload) {
  try {
    const bytes = Uint8Array.from(atob(payload || ''), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch (_) { return String(payload || ''); }
}

async function toggleLogs() {
  state.logsOpen = !state.logsOpen;
  updateLogsSlot();
  if (state.logsOpen) await refreshLogs();
}

function updateLogsSlot() {
  const slot = document.getElementById('logs-slot');
  if (!slot) return;
  slot.innerHTML = renderLogs();
  slot.querySelector('#logs-refresh')?.addEventListener('click', refreshLogs);
}

async function refreshLogs() {
  if (!state.selected) return;
  if (logsRequest) return logsRequest;
  const selected = state.selected;
  const cursor = state.logsCursor;
  logsRequest = (async () => {
    try {
      const suffix = cursor ? '?cursor=' + encodeURIComponent(cursor) : '';
      const r = await fetch('/api/logs/' + encodeURIComponent(selected) + suffix, {
        headers: { accept: 'application/json' },
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      if (selected !== state.selected) return;
      if (!state.logs) state.logs = [];
      state.logs.push(...(data.logs || []));
      state.logsCursor = data.cursor || state.logsCursor;
    } catch (e) {
      if (selected !== state.selected) return;
      if (!state.logs) state.logs = [];
      state.logs.push({ execution_id: selected, ffqn: '', level: 'error', message: String(e) });
    } finally {
      logsRequest = null;
      if (selected === state.selected) updateLogsSlot();
    }
  })();
  return logsRequest;
}

function renderDiffLines(lines) {
  return (lines || []).map((l) => {
    const cls = l.tag === '+' ? 'dl add' : (l.tag === '-' ? 'dl del' : 'dl');
    return '<span class="' + cls + '">' + esc(l.tag + ' ' + l.text) + '</span>';
  }).join('');
}

function displayBlocksHtml(blocks) {
  return (blocks || []).map((block) => {
    if (block.kind === 'thinking') {
      return '<div class="bubble thinking"><div class="label">thinking</div>'
        + renderedMarkdownHtml('', block.content || '') + '</div>';
    }
    if (block.kind === 'mermaid') {
      return '<div class="bubble mermaid-block"><div class="label">diagram</div>'
        + '<div class="mermaid-source" data-source="' + sourceData(block.content || '') + '"></div></div>';
    }
    return renderedMarkdownHtml('bubble markdown', block.content || '');
  }).join('');
}

function sourceData(source) {
  return esc(encodeURIComponent(source));
}

function renderedMarkdownHtml(classes, source) {
  const cls = classes ? classes + ' rendered-markdown' : 'rendered-markdown';
  return '<div class="' + esc(cls) + '" data-source="' + sourceData(source) + '"></div>';
}

function hydrateDisplayBlocks(root, attempt = 0) {
  let retryMarkdown = false;
  for (const el of root.querySelectorAll('.rendered-markdown[data-source]')) {
    const source = decodeURIComponent(el.dataset.source || '');
    if (window.marked && window.DOMPurify) {
      el.innerHTML = window.DOMPurify.sanitize(window.marked.parse(source));
      el.removeAttribute('data-source');
    } else {
      el.innerHTML = '<pre>' + esc(source) + '</pre>';
      retryMarkdown = true;
    }
  }
  if (retryMarkdown && attempt < 50) setTimeout(() => hydrateDisplayBlocks(root, attempt + 1), 100);

  const diagrams = [];
  for (const el of root.querySelectorAll('.mermaid-source[data-source]')) {
    el.textContent = decodeURIComponent(el.dataset.source || '');
    el.classList.add('mermaid');
    el.removeAttribute('data-source');
    diagrams.push(el);
  }
  if (diagrams.length) renderMermaidWhenReady(diagrams, 0);
}

function renderMermaidWhenReady(nodes, attempt) {
  if (typeof window.renderMermaidBlocks === 'function') {
    window.renderMermaidBlocks(nodes).catch((error) => {
      for (const el of nodes) {
        if (!el.querySelector('svg')) {
          el.className = 'render-error';
          el.textContent = 'Mermaid render failed: ' + String(error);
        }
      }
    });
  } else if (attempt < 20) {
    setTimeout(() => renderMermaidWhenReady(nodes, attempt + 1), 100);
  }
}

function renderTurn(t, i) {
  if (t.kind === 'operator_message') {
    return '<div class="bubble user"><div class="label">operator</div><pre>' + esc(t.text) + '</pre></div>';
  }
  if (t.kind === 'assistant_response' || t.kind === 'final') return displayBlocksHtml(t.blocks);
  if (t.kind === 'error') {
    return displayBlocksHtml(t.blocks)
      + '<div class="bubble error"><div class="label">error</div><pre>' + esc(t.text) + '</pre></div>';
  }
  if (t.kind !== 'tool_calls') return '';

  // Turn numbering = index among tool_calls turns + 1.
  let turnNo = 0;
  for (let j = 0; j <= i; j += 1) {
    if (state.detail.turns[j].kind === 'tool_calls') turnNo += 1;
  }
  const items = t.calls.map((c, k) => renderCall(c, i, k)).join('');
  return '<div class="turn">'
    + '<div class="turn-header">Turn ' + turnNo + ' &middot; ' + t.calls.length + ' tool call' + (t.calls.length === 1 ? '' : 's') + '</div>'
    + displayBlocksHtml(t.blocks)
    + '<div class="calls">' + items + '</div>'
    + '</div>';
}

function renderCall(call, turnIndex, callIndex) {
  const name = call && typeof call.name === 'string' ? call.name : '?';
  const argsJson = call && call.args !== undefined ? JSON.stringify(call.args, null, 2) : '{}';
  const key = call.child_id || (name + '#' + turnIndex + ':' + callIndex);
  const childLink = call.child_id
    ? ' <a class="child-link" href="' + esc(execLink(call.child_id)) + '" target="_blank" rel="noopener" title="open in obelisk web UI">' + esc(shortChildId(call.child_id)) + '</a>'
    : '';

  let pill, resultBlock;
  if ('ok' in call) {
    pill = '<span class="status-pill ok">ok</span>';
    const out = typeof call.ok === 'string' ? call.ok : JSON.stringify(call.ok, null, 2);
    resultBlock = '<div class="result"><div class="key">ok</div><pre>' + esc(out) + '</pre></div>';
  } else if ('err' in call) {
    pill = '<span class="status-pill err">err</span>';
    resultBlock = '<div class="result"><div class="key">err</div><pre>' + esc(String(call.err)) + '</pre></div>';
  } else {
    pill = '<span class="status-pill pending">pending</span>';
    resultBlock = '';
  }

  return '<details class="call" data-key="' + esc(key) + '">'
    + '<summary><code>' + esc(name) + '</code>' + childLink + pill + '</summary>'
    + '<div class="args"><div class="key">args</div><pre>' + esc(argsJson) + '</pre></div>'
    + resultBlock
    + '</details>';
}

function shortChildId(id) {
  // Render the join_set tail (e.g. "o:7-get_1") for compactness.
  const dot = id.indexOf('.');
  return dot === -1 ? id : id.substring(dot + 1);
}

function renderFinal(d) {
  // Model-emitted responses are rendered with their turn. Fall back to the
  // workflow result only for old executions with no persisted response turn.
  const responseTurn = [...d.turns].reverse().find((t) => t.kind === 'assistant_response' || t.kind === 'final');
  if (responseTurn) return '';
  if (d.status !== 'finished') return '';
  const r = d.final_result;
  if (!r) return '';
  if (r.error) return '<div class="err-box">' + esc(r.error) + '</div>';
  if (typeof r.ok === 'string') return '<div class="bubble final"><div class="label">final</div><pre>' + esc(r.ok) + '</pre></div>';
  if (r.err !== undefined) return '<div class="err-box">Workflow err: ' + esc(String(r.err)) + '</div>';
  if (r.execution_error !== undefined) return '<div class="err-box">Execution error: ' + esc(JSON.stringify(r.execution_error)) + '</div>';
  return '';
}

function truncate(s, n) {
  return s.length > n ? s.substring(0, n) + '...' : s;
}

async function submitPrompt(prompt) {
  const btn = document.getElementById('composer-send');
  const backend = document.getElementById('new-backend')?.value || null;
  const effort = document.getElementById('new-effort')?.value || '';
  btn.disabled = true;
  try {
    const r = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, backend, effort }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    document.getElementById('composer-input').value = '';
    await refreshSidebar();
    setSelected(data.execution_id);
  } catch (e) {
    alert('Submit failed: ' + String(e));
  } finally {
    btn.disabled = false;
  }
}

async function submitAnswer(childId, answer) {
  try {
    const r = await fetch('/api/answer/' + encodeURIComponent(childId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || ('HTTP ' + r.status));
    }
    await refreshDetail();
  } catch (e) {
    alert('Answer failed: ' + String(e));
  }
}

async function sendConfirm(childId, approve) {
  try {
    const r = await fetch('/api/confirm/' + encodeURIComponent(childId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approve }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || ('HTTP ' + r.status));
    }
    state.lastSig = null;
    await refreshDetail();
  } catch (e) {
    alert((approve ? 'Approve' : 'Reject') + ' failed: ' + String(e));
  }
}

async function setPaused(runId, unpause) {
  try {
    const r = await fetch('/api/' + (unpause ? 'unpause' : 'pause') + '/' + encodeURIComponent(runId), { method: 'POST' });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || ('HTTP ' + r.status));
    }
    state.lastSig = null;
    await refreshDetail();
    await refreshSidebar();
  } catch (e) {
    alert((unpause ? 'Unpause' : 'Pause') + ' failed: ' + String(e));
  }
}

async function sendToAgent(runId, text) {
  const t = (text || '').trim();
  if (!t) return;
  try {
    const r = await fetch('/api/say/' + encodeURIComponent(runId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: t }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    const box = document.getElementById('composer-input');
    if (box) box.value = '';
    if (state.detail) state.detail.pending_injection = null;
    state.lastSig = null;
    renderDetail();
  } catch (e) {
    alert('Send failed: ' + String(e));
  }
}

function sendComposer() {
  const input = document.getElementById('composer-input');
  const text = input.value.trim();
  if (!text) return;
  if (composerMode() === 'say') sendToAgent(state.selected, text);
  else submitPrompt(text);
}

document.getElementById('composer-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  sendComposer();
});

// Enter sends; Shift+Enter inserts a newline (chat-composer convention).
document.getElementById('composer-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    sendComposer();
  }
});

document.getElementById('new-convo').addEventListener('click', () => {
  setSelected(null);
  document.getElementById('composer-input').focus();
});

async function loadModels() {
  const sel = document.getElementById('new-backend');
  if (!sel) return;
  try {
    const r = await fetch('/api/models', { headers: { accept: 'application/json' } });
    if (!r.ok) return;
    const data = await r.json();
    const models = Array.isArray(data.models) ? data.models : [];
    sel.innerHTML = models.map((m) =>
      '<option value="' + esc(m.id) + '">' + esc(m.label || m.id) + '</option>').join('');
  } catch (_) { /* leave the select empty; submit sends no backend override */ }
}

readSelectedFromUrl();
loadModels();
refreshSidebar();
refreshDetail();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(sidebarTimer);
    clearTimeout(detailTimer);
    return;
  }
  refreshSidebar();
  refreshDetail();
});
</script>
</body>
</html>`;
