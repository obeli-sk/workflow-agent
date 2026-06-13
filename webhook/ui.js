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
//   POST /api/cleanup/:id           stop and remove an active run's container
//
// The SPA polls the run list every 10s and active open runs every 3s, so
// refreshes happen without page reloads. Terminal runs stop polling. Layout is
// two-pane: sidebar = prompt list + new-prompt form, right pane = chat-style
// transcript.

const WORKFLOW_FFQN = "obelisk-agent:workflow/workflow.run";
const AGENT_LOOP_FFQN = "obelisk-agent:workflow/workflow.agent-loop";
const ASK_USER_FFQN = "obelisk-agent:tools/input.ask-user";
const CONFIRM_FFQN = "obelisk-agent:tools/deploy.confirm-apply";
const INJECTION_FFQN = "obelisk-agent:agent/session.injection";
const TEARDOWN_SIGNAL_FFQN = "obelisk-agent:agent/session.teardown-signal";

export default async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
        if (method === "GET" && path === "/") return htmlShell();
        if (method === "GET" && path === "/api/runs") return jsonResponse(await listRuns());
        if (method === "GET" && path.startsWith("/api/runs/")) {
            const id = decodeURIComponent(path.substring("/api/runs/".length));
            if (!id) return jsonError(400, "missing run id");
            return jsonResponse(await detailRun(id));
        }
        if (method === "GET" && path.startsWith("/api/logs/")) {
            const id = decodeURIComponent(path.substring("/api/logs/".length));
            if (!id) return jsonError(400, "missing run id");
            return jsonResponse(await loadExecutionTreeLogs(id));
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
        if (method === "POST" && path.startsWith("/api/cleanup/")) {
            return await cleanupSession(decodeURIComponent(path.substring("/api/cleanup/".length)));
        }
        if (method === "POST" && path.startsWith("/api/fork/")) {
            return await forkRun(request, decodeURIComponent(path.substring("/api/fork/".length)));
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

function apiBase() {
    return process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
}

async function obeliskJson(path, init) {
    const resp = await fetch(`${apiBase()}${path}`, {
        ...init,
        headers: { accept: "application/json", ...(init?.headers ?? {}) },
    });
    if (!resp.ok) {
        throw new Error(`${path}: HTTP ${resp.status} ${await resp.text()}`);
    }
    return await resp.json();
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

// ----- list -------------------------------------------------------------

async function listRuns() {
    const executions = await obeliskJson(
        `/v1/executions?ffqn_prefix=${encodeURIComponent(WORKFLOW_FFQN)}&length=50`,
    );
    const runs = await Promise.all(executions.map(async (e) => ({
        id: e.execution_id,
        created_at: e.created_at || "",
        status: e.pending_state?.status || "unknown",
        result_kind: e.pending_state?.result_kind ?? null,
        join_name: parseJoinName(e.pending_state?.join_set_id),
        prompt_preview: await loadPromptPreview(e.execution_id),
    })));
    return { runs };
}

async function loadPromptPreview(execId) {
    const p = (await loadPrompt(execId)) || "";
    return p.length > 120 ? p.substring(0, 120) + "..." : p;
}

// ----- detail -----------------------------------------------------------

async function detailRun(id) {
    const agentLoopId = await loadAgentLoopExecution(id);
    const [status, created, walk, sentResults, finalResult, pendingAsks, pendingConfirms, pendingInjection, teardownSignalId] = await Promise.all([
        loadStatus(id),
        loadCreated(id),
        loadResponses(agentLoopId || id),
        loadSentResults(agentLoopId || id),
        loadFinalResult(id),
        loadPendingAsks(id),
        loadPendingConfirms(id),
        loadPendingInjection(id),
        loadTeardownSignal(id),
    ]);
    return {
        id,
        status: status?.pending_state?.status || "unknown",
        result_kind: status?.pending_state?.result_kind ?? null,
        join_name: parseJoinName(status?.pending_state?.join_set_id),
        created_at: status?.created_at || "",
        prompt: created?.prompt ?? null,
        backend: created?.backend ?? null,
        turns: buildTurns(walk.replies, walk.toolChildren, sentResults),
        final_result: finalResult,
        pending_asks: pendingAsks,
        pending_confirms: pendingConfirms,
        pending_injection: pendingInjection,
        teardown_signal_id: teardownSignalId,
    };
}

async function loadAgentLoopExecution(workflowId) {
    let candidates;
    try {
        candidates = await obeliskJson(
            `/v1/executions?ffqn_prefix=${encodeURIComponent(AGENT_LOOP_FFQN)}`
            + `&execution_id_prefix=${encodeURIComponent(workflowId)}&show_derived=true&length=10`,
        );
    } catch (_) { return null; }
    const mine = candidates.filter((e) => typeof e.execution_id === "string"
        && e.execution_id.startsWith(workflowId + "."));
    return mine.length > 0 ? mine[mine.length - 1].execution_id : null;
}

async function loadStatus(id) {
    try { return await obeliskJson(`/v1/executions/${encodeURIComponent(id)}/status`); }
    catch (_) { return null; }
}

// The workflow.run creation params are [prompt, backend]. version 0 is the
// `created` event; without including_cursor=true the server skips it and returns
// the `locked` event at version 1, which has no params.
async function loadCreated(id) {
    try {
        const payload = await obeliskJson(
            `/v1/executions/${encodeURIComponent(id)}/events?version_from=0&including_cursor=true&length=1`,
        );
        const params = payload.events?.[0]?.event?.created?.params;
        if (!Array.isArray(params)) return null;
        return {
            prompt: typeof params[0] === "string" ? params[0] : null,
            backend: typeof params[1] === "string" ? params[1] : null,
        };
    } catch (_) { return null; }
}

async function loadPrompt(id) {
    return (await loadCreated(id))?.prompt ?? null;
}

async function loadFinalResult(id) {
    try {
        const status = await obeliskJson(`/v1/executions/${encodeURIComponent(id)}/status`);
        if (status?.pending_state?.status !== "finished") return null;
        return await obeliskJson(`/v1/executions/${encodeURIComponent(id)}`);
    } catch (e) { return { error: String(e) }; }
}

// Logs are loaded lazily from a separate endpoint because a run can have many
// derived executions. Include unfinished children so the currently streaming
// recv activity is visible while the model is working.
async function loadExecutionTreeLogs(workflowId) {
    let executions;
    try {
        executions = await obeliskJson("/v1/executions?show_derived=true&length=200");
    } catch (_) {
        executions = [];
    }
    const tree = executions.filter((e) => e?.execution_id === workflowId
        || (typeof e?.execution_id === "string" && e.execution_id.startsWith(workflowId + ".")));
    if (!tree.some((e) => e.execution_id === workflowId)) {
        tree.push({ execution_id: workflowId, ffqn: WORKFLOW_FFQN });
    }

    const batches = await Promise.all(tree.map(async (execution) => {
        try {
            const logs = await obeliskJson(
                `/v1/executions/${encodeURIComponent(execution.execution_id)}/logs`,
            );
            return logs.map((entry) => ({
                ...entry,
                execution_id: execution.execution_id,
                ffqn: execution.ffqn || "",
            }));
        } catch (_) { return []; }
    }));
    const logs = batches.flat();
    logs.sort((a, b) => String(a.created_at || a.cursor || "")
        .localeCompare(String(b.created_at || b.cursor || "")));
    return { logs };
}

async function loadPendingAsks(workflowId) {
    let candidates;
    try {
        candidates = await obeliskJson(
            `/v1/executions?ffqn_prefix=${encodeURIComponent(ASK_USER_FFQN)}&show_derived=true&hide_finished=true&length=50`,
        );
    } catch (_) { return []; }
    const mine = candidates.filter((e) => typeof e.execution_id === "string"
        && e.execution_id.startsWith(workflowId + "."));
    return await Promise.all(mine.map(async (e) => {
        let question = null;
        try {
            const evs = await obeliskJson(
                `/v1/executions/${encodeURIComponent(e.execution_id)}/events?version_from=0&including_cursor=true&length=1`,
            );
            const p = evs.events?.[0]?.event?.created?.params;
            if (Array.isArray(p) && typeof p[0] === "string") question = p[0];
        } catch (_) {}
        return { id: e.execution_id, question };
    }));
}

async function loadTeardownSignal(workflowId) {
    let candidates;
    try {
        candidates = await obeliskJson(
            `/v1/executions?ffqn_prefix=${encodeURIComponent(TEARDOWN_SIGNAL_FFQN)}`
            + `&execution_id_prefix=${encodeURIComponent(workflowId)}`
            + "&show_derived=true&hide_finished=true&length=10",
        );
    } catch (_) { return null; }
    const mine = candidates.filter((e) => typeof e.execution_id === "string"
        && e.execution_id.startsWith(workflowId + "."));
    return mine.length > 0 ? mine[mine.length - 1].execution_id : null;
}

async function loadPendingInjection(workflowId) {
    let candidates;
    try {
        candidates = await obeliskJson(
            `/v1/executions?ffqn_prefix=${encodeURIComponent(INJECTION_FFQN)}`
            + `&execution_id_prefix=${encodeURIComponent(workflowId)}`
            + "&show_derived=true&hide_finished=true&length=10",
        );
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
        candidates = await obeliskJson(
            `/v1/executions?ffqn_prefix=${encodeURIComponent(CONFIRM_FFQN)}&show_derived=true&hide_finished=true&length=50`,
        );
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
            const evs = await obeliskJson(
                `/v1/executions/${encodeURIComponent(e.execution_id)}/events?version_from=0&including_cursor=true&length=1`,
            );
            const p = evs.events?.[0]?.event?.created?.params;
            if (Array.isArray(p)) {
                if (typeof p[0] === "string") deploymentId = p[0];
                if (typeof p[1] === "string") summary = p[1];
            }
        } catch (_) {}

        let diff = null;
        if (deploymentId) {
            try {
                const dep = await obeliskJson(`/v1/deployments/${encodeURIComponent(deploymentId)}`);
                diff = diffSources(currentSources, collectSources(dep.config_json));
            } catch (err) { diff = { error: String(err) }; }
        }
        return { id: e.execution_id, deployment_id: deploymentId, summary, diff };
    }));
}

// Sources of the currently active deployment, keyed by file name. Returns {}
// if there is no current deployment or it cannot be read. /v1/deployment-id
// returns the active id as a JSON string; its config lives in the per-id GET.
async function loadCurrentSources() {
    try {
        const id = await obeliskJson(`/v1/deployment-id`);
        if (!id || typeof id !== "string") return {};
        const dep = await obeliskJson(`/v1/deployments/${encodeURIComponent(id)}`);
        return collectSources(dep.config_json);
    } catch (_) { return {}; }
}

// Extract { fileName -> source } from a deployment's config_json. JS components
// live under the *_js arrays; each carries its source either inline at the top
// level (`content`) or under `location.content.{file_name, content}`.
function collectSources(configJson) {
    const out = {};
    let cfg;
    try { cfg = typeof configJson === "string" ? JSON.parse(configJson) : configJson; }
    catch (_) { return out; }
    if (!cfg || typeof cfg !== "object") return out;
    for (const [key, value] of Object.entries(cfg)) {
        if (!key.endsWith("_js") || !Array.isArray(value)) continue;
        for (const comp of value) {
            if (!comp || typeof comp !== "object") continue;
            const inline = comp.location?.content;
            const name = (inline && typeof inline.file_name === "string" && inline.file_name)
                || comp.name || comp.ffqn || `${key}[?]`;
            const src = (inline && typeof inline.content === "string") ? inline.content
                : (typeof comp.content === "string" ? comp.content : null);
            if (typeof src === "string") out[String(name)] = src;
        }
    }
    return out;
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
const INFRA_NAMES = new Set(["load-system-prompt", "start", "send", "recv", "cleanup"]);

async function loadResponses(execId) {
    const replies = [];
    const toolChildren = [];
    let cursor = 0;
    let including = true;
    while (true) {
        let payload;
        try {
            payload = await obeliskJson(
                `/v1/executions/${encodeURIComponent(execId)}/responses?cursor=${cursor}&including_cursor=${including}&length=200`,
            );
        } catch (_) { break; }
        const responses = payload.responses || [];
        for (const r of responses) {
            const wrapped = r.event?.event;
            const ev = wrapped?.event;
            if (!ev || ev.type !== "child_execution_finished") continue;
            const joinName = parseJoinName(wrapped.join_set_id);

            if (joinName === "recv") {
                // turn-outcome: "working" (string) or
                // { reply: { reply, presentation, blocks, narration } }.
                // Tolerate the old shape where reply was the bare agent-reply.
                const value = ev.result?.ok?.value ?? ev.result?.ok;
                if (value && typeof value === "object" && value.reply) {
                    const r = value.reply;
                    if (r && typeof r === "object" && "reply" in r) {
                        let presentation = typeof r.presentation === "string" ? r.presentation : "";
                        if (!presentation && Array.isArray(r.reply?.tool_calls)) {
                            presentation = await loadRecvPresentation(ev.child_execution_id);
                        }
                        replies.push({
                            reply: r.reply,
                            presentation,
                            blocks: Array.isArray(r.blocks) ? r.blocks : [],
                            narration: typeof r.narration === "string" ? r.narration : "",
                        });
                    } else {
                        replies.push({ reply: r, presentation: "", blocks: [], narration: "" });
                    }
                }
            } else if (!INFRA_NAMES.has(joinName)) {
                toolChildren.push({
                    id: ev.child_execution_id,
                    result: unwrapTypedResult(ev.result),
                });
            }
        }
        const max = payload.max_cursor;
        if (typeof max !== "number" || responses.length === 0 || max <= cursor) break;
        cursor = max;
        including = false;
    }
    return { replies, toolChildren };
}

async function loadRecvPresentation(executionId) {
    try {
        const logs = await obeliskJson(`/v1/executions/${encodeURIComponent(executionId)}/logs`);
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
                } catch (_) {}
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
                && (Array.isArray(value.tool_calls) || typeof value.final === "string"
                    || typeof value.error === "string");
        } catch (_) {}
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

// The tool responses *as the model received them* are the `tool_results` the
// workflow passed to each session.send. Those are not in /responses (which only
// has child results); they live in the workflow history as the params of the
// send join_set_request. Reading them here means the UI shows what was actually
// sent to the LLM (post any workflow processing), not the upstream tool child's
// raw result. Flattened in dispatch order to align 1:1 with the tool calls.
async function loadSentResults(execId) {
    const sent = [];
    let version = 0;
    let including = true;
    while (true) {
        let payload;
        try {
            payload = await obeliskJson(
                `/v1/executions/${encodeURIComponent(execId)}/events?version=${version}&including_cursor=${including}&length=200`,
            );
        } catch (_) { break; }
        const events = payload.events || [];
        for (const e of events) {
            const he = e.event?.history_event?.event;
            if (!he || he.type !== "join_set_request") continue;
            if (parseJoinName(he.join_set_id) !== "send") continue;
            const input = he.request?.params?.[1];
            if (input && Array.isArray(input.tool_results)) {
                for (const tr of input.tool_results) sent.push(normalizeSent(tr));
            }
        }
        const max = payload.max_version;
        if (typeof max !== "number" || events.length === 0 || max <= version) break;
        version = max;
        including = false;
    }
    return sent;
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

// Build a clean turn list from the typed agent-replies. We emit:
//   { kind: "tool_calls", blocks, calls: [{name, args, child_id?, ok?|err?}] }
//   { kind: "final", blocks, text }
//   { kind: "error", blocks, text }
//
// Tool calls, child executions, and sent tool_results are all in dispatch order,
// so a single cursor aligns them 1:1. The displayed response is what was sent to
// the LLM (`sentResults`); we fall back to the child execution result when the
// send isn't recorded (e.g. an in-flight turn, or apply_deployment which is
// terminal and never sends results back). `child_id` always links to the child.
function buildTurns(replies, toolChildren, sentResults) {
    const turns = [];
    let toolCursor = 0;
    for (const item of replies) {
        const reply = item && item.reply;
        const narration = (item && typeof item.narration === "string") ? item.narration : "";
        const presentation = (item && typeof item.presentation === "string") ? item.presentation : "";
        const blocks = normalizeBlocks(item?.blocks, presentation, narration, reply);
        if (!reply || typeof reply !== "object") continue;
        if (typeof reply.final === "string") {
            turns.push({ kind: "final", text: reply.final, blocks });
        } else if (typeof reply.error === "string") {
            turns.push({ kind: "error", text: reply.error, blocks });
        } else if (Array.isArray(reply.tool_calls)) {
            const calls = reply.tool_calls.map((c) => {
                const child = toolChildren[toolCursor];
                const sent = sentResults[toolCursor];
                toolCursor += 1;
                const base = {
                    name: c?.name,
                    args: parseArgs(c?.arguments_json),
                    child_id: child?.id ?? null,
                };
                const src = sent || (child && child.result);
                if (src) {
                    if ("ok" in src) base.ok = src.ok;
                    else if ("err" in src) base.err = src.err;
                }
                return base;
            });
            turns.push({ kind: "tool_calls", calls, blocks });
        }
    }
    return turns;
}

function normalizeBlocks(blocks, presentation, narration, reply) {
    const out = [];
    if (Array.isArray(blocks)) {
        for (const block of blocks) {
            const kind = block?.kind === "mermaid"
                ? "mermaid"
                : (block?.kind === "thinking" ? "thinking" : "markdown");
            if (typeof block?.content === "string" && block.content.trim()) {
                out.push({ kind, content: block.content });
            }
        }
    }
    if (presentation.trim()) {
        out.push(...splitMermaidBlocks(presentation, "markdown"));
    }
    if (narration.trim()) {
        out.push(...splitMermaidBlocks(narration, "thinking"));
    }
    // Backward compatibility for final executions persisted before display
    // fields were introduced.
    if (out.length === 0 && typeof reply?.final === "string") {
        out.push(...splitMermaidBlocks(reply.final, "markdown"));
    }
    return out;
}

function splitMermaidBlocks(text, proseKind) {
    const source = String(text || "").replace(
        /```markdown\s*\n([\s\S]*?)\nmermaid\s*\n([\s\S]*?)```/gi,
        (_, prose, diagram) => `${prose.trim()}\n\n\`\`\`mermaid\n${diagram.trim()}\n\`\`\``,
    );
    const blocks = [];
    const pattern = /```mermaid\s*\n([\s\S]*?)```/gi;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
        const prose = source.slice(cursor, match.index).trim();
        if (prose) blocks.push({ kind: proseKind, content: prose });
        const diagram = match[1].trim();
        if (diagram) blocks.push({ kind: "mermaid", content: diagram });
        cursor = pattern.lastIndex;
    }
    const tail = source.slice(cursor).trim();
    if (tail) blocks.push({ kind: proseKind, content: tail });
    return blocks;
}

function parseArgs(json) {
    if (typeof json !== "string") return json ?? {};
    try { return JSON.parse(json); } catch { return json; }
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
    const execId = obelisk.executionIdGenerate();
    try { obelisk.schedule(execId, WORKFLOW_FFQN, [prompt, backend]); }
    catch (e) { return jsonError(502, `schedule failed: ${String(e)}`); }
    return jsonResponse({ execution_id: execId });
}

// Pause or unpause a run via the native execution endpoints. A paused execution
// reports pending_state.status == "paused".
async function pauseExecution(id, unpause) {
    if (!id) return jsonError(400, "missing run id");
    const verb = unpause ? "unpause" : "pause";
    const resp = await fetch(
        `${apiBase()}/v1/executions/${encodeURIComponent(id)}/${verb}`,
        { method: "PUT" },
    );
    if (!resp.ok) {
        return jsonError(502, `${verb} failed: HTTP ${resp.status} ${await resp.text()}`);
    }
    return jsonResponse({ ok: true });
}

function isTerminalStatus(status) {
    return status === "finished" || /^permanently/.test(status || "");
}

// Cancel the supervisor-owned teardown stub. The supervisor races this child
// against the complete nested agent workflow, then closes the child branch and
// cleans up its container.
async function cleanupSession(runId) {
    if (!runId) return jsonError(400, "missing run id");
    const status = await loadStatus(runId);
    if (!status) return jsonError(404, "run not found");
    const executionStatus = status.pending_state?.status || "unknown";
    if (isTerminalStatus(executionStatus)) {
        return jsonError(409, "run is already finished");
    }

    const signalId = await loadTeardownSignal(runId);
    if (!signalId) return jsonError(409, "teardown signal is not ready");
    const resp = await fetch(
        `${apiBase()}/v1/executions/${encodeURIComponent(signalId)}/cancel`,
        { method: "PUT" },
    );
    if (!resp.ok) {
        return jsonError(502, `teardown signal failed: HTTP ${resp.status} ${await resp.text()}`);
    }
    if (executionStatus === "paused") {
        const unpause = await fetch(
            `${apiBase()}/v1/executions/${encodeURIComponent(runId)}/unpause`,
            { method: "PUT" },
        );
        if (!unpause.ok) {
            return jsonError(502, `teardown signalled but unpause failed: HTTP ${unpause.status} ${await unpause.text()}`);
        }
    }

    // Obelisk closes a join set by cancelling activities and delays, but it
    // waits for child workflows. Wait until the supervisor has run container
    // cleanup and entered join-set closing, then cancel pending leaf activities
    // so the nested workflow can unwind instead of remaining on a human stub.
    await waitForSupervisorClosing(runId);
    const cancelled = await cancelPendingDescendants(runId, signalId);
    return jsonResponse({ ok: true, signal_execution_id: signalId, cancelled });
}

async function waitForSupervisorClosing(runId) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const status = await loadStatus(runId);
        const pending = status?.pending_state;
        if (isTerminalStatus(pending?.status) || pending?.closing === true) return;
    }
}

async function cancelPendingDescendants(runId, signalId) {
    let executions;
    try {
        executions = await obeliskJson(
            `/v1/executions?execution_id_prefix=${encodeURIComponent(runId)}`
            + "&show_derived=true&hide_finished=true&length=200",
        );
    } catch (_) { return []; }

    const cancellable = executions.filter((execution) => {
        if (execution?.execution_id === signalId) return false;
        if (execution?.ffqn === "obelisk-agent:agent/session.cleanup") return false;
        return execution?.component_type === "activity"
            || execution?.component_type === "activity_stub";
    });
    const cancelled = [];
    for (const execution of cancellable) {
        const id = execution.execution_id;
        const response = await fetch(
            `${apiBase()}/v1/executions/${encodeURIComponent(id)}/cancel`,
            { method: "PUT" },
        );
        if (response.ok) cancelled.push(id);
    }
    return cancelled;
}

// Fulfil the concrete pending injection stub owned by this workflow. The
// workflow consumes the response at its next send boundary and performs the
// socket write as a derived activity.
async function sayToAgent(request, runId) {
    if (!runId) return jsonError(400, "missing run id");
    let payload;
    try { payload = JSON.parse(await request.text()); }
    catch (e) { return jsonError(400, `body must be JSON: ${e.message}`); }
    const text = payload?.text;
    if (typeof text !== "string" || !text.trim()) return jsonError(400, "text is required");
    const injection = await loadPendingInjection(runId);
    if (!injection) return jsonError(409, "agent is not currently accepting an injected message");
    const resp = await fetch(
        `${apiBase()}/v1/executions/${encodeURIComponent(injection.id)}/stub`,
        {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ok: text.trim() }),
        },
    );
    if (!resp.ok) {
        return jsonError(502, `injection fulfil failed: HTTP ${resp.status} ${await resp.text()}`);
    }
    return jsonResponse({ child_execution_id: injection.id });
}

// Fork a finished run into a fresh session. The new run's prompt instructs the
// agent to read the original run's prompt + result (via its own tools), then
// continue with the operator's new instruction.
async function forkRun(request, runId) {
    if (!runId) return jsonError(400, "missing run id");
    let payload;
    try { payload = JSON.parse(await request.text()); }
    catch (e) { return jsonError(400, `body must be JSON: ${e.message}`); }
    const text = typeof payload?.text === "string" ? payload.text.trim() : "";
    const created = await loadCreated(runId);
    // Prefer an explicitly chosen backend, else inherit the original run's.
    const chosen = (typeof payload?.backend === "string" && payload.backend) ? payload.backend : null;
    const backend = chosen || ((typeof created?.backend === "string" && created.backend) ? created.backend : null);
    const prompt = [
        `You are continuing from a previous agent run ${runId}.`,
        `First call obelisk.get_execution and obelisk.get_result with execution_id "${runId}"`,
        `to read its original prompt and final result.`,
        text ? `Then: ${text}` : `Then continue that work.`,
    ].join(" ");
    const execId = obelisk.executionIdGenerate();
    try { obelisk.schedule(execId, WORKFLOW_FFQN, [prompt, backend]); }
    catch (e) { return jsonError(502, `fork schedule failed: ${String(e)}`); }
    return jsonResponse({ execution_id: execId });
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
    const resp = await fetch(
        `${apiBase()}/v1/executions/${encodeURIComponent(childId)}/stub`,
        {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ok: answer }),
        },
    );
    if (!resp.ok) {
        return jsonError(502, `stub fulfil failed: HTTP ${resp.status} ${await resp.text()}`);
    }
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
    const resp = await fetch(
        `${apiBase()}/v1/executions/${encodeURIComponent(childId)}/stub`,
        {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(stubResult),
        },
    );
    if (!resp.ok) {
        return jsonError(502, `stub fulfil failed: HTTP ${resp.status} ${await resp.text()}`);
    }
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
  aside { width: 320px; border-right: 1px solid var(--line); background: var(--panel); display: flex; flex-direction: column; }
  main { flex: 1; overflow-y: auto; padding: 1.5rem 2rem; }
  aside header { padding: 1rem; border-bottom: 1px solid var(--line); }
  aside header h1 { margin: 0 0 0.5rem; font-size: 1rem; font-weight: 600; }
  aside header form textarea { width: 100%; resize: vertical; min-height: 3.5em; padding: 0.4em 0.6em; border: 1px solid var(--line); border-radius: 4px; font: inherit; }
  aside header form button { margin-top: 0.4em; padding: 0.4em 0.9em; font: inherit; cursor: pointer; border: 1px solid var(--accent); background: var(--accent); color: white; border-radius: 4px; }
  aside header form button:disabled { opacity: 0.5; cursor: wait; }
  aside header form .new-row { display: flex; gap: 0.4em; align-items: center; }
  aside header form .new-row button { margin-top: 0; }
  aside header form select { padding: 0.4em; border: 1px solid var(--line); border-radius: 4px; font: inherit; background: var(--panel); }
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
  .interact { max-width: 720px; margin: 1.4em 0; padding: 0.8em 1em; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .interact.fork { background: #f6f8fc; border-color: #d0deef; }
  .interact textarea { width: 100%; resize: vertical; min-height: 3em; padding: 0.4em 0.6em; border: 1px solid var(--line); border-radius: 4px; font: inherit; }
  .interact button { margin-top: 0.4em; padding: 0.4em 0.9em; font: inherit; cursor: pointer; border: 1px solid var(--accent); background: var(--accent); color: white; border-radius: 4px; }
  .interact .fork-row { display: flex; gap: 0.4em; align-items: center; margin-top: 0.4em; }
  .interact .fork-row button { margin-top: 0; }
  .interact select { padding: 0.4em; border: 1px solid var(--line); border-radius: 4px; font: inherit; background: var(--panel); }
  .meta #pause-btn, .meta #unpause-btn { border: 0; background: none; color: var(--accent); cursor: pointer; padding: 0; font: inherit; }
  .meta #pause-btn:hover, .meta #unpause-btn:hover { text-decoration: underline; }
  .meta #cleanup-btn { color: var(--err); }
  .meta #cleanup-btn.confirming { font-weight: 600; text-decoration: underline; }
  .meta #cleanup-btn:disabled { color: var(--muted); cursor: wait; text-decoration: none; }
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
    <form id="new-form">
      <textarea id="new-prompt" placeholder="Ask the agent..." required></textarea>
      <div class="new-row">
        <select id="new-backend" title="agent backend">
          <option value="claude">claude</option>
          <option value="codex">codex</option>
        </select>
        <button type="submit" id="new-submit">Send</button>
      </div>
    </form>
  </header>
  <div class="runs" id="runs"></div>
</aside>
<main id="detail">
  <p class="empty">Pick a run from the sidebar, or submit a new prompt.</p>
</main>
<script>
const OBELISK_UI_URL = "__OBELISK_UI_URL__";
const state = { selected: null, runs: [], detail: null, lastSig: null, logs: null, logsOpen: false };
const SIDEBAR_POLL_MS = 10000;
const DETAIL_POLL_MS = 3000;
let sidebarTimer = null;
let detailTimer = null;
let sidebarRequest = null;
let detailRequest = null;
let detailAbort = null;

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
  'recv': ['thinking', 'working'],
  'start': ['starting', 'working'],
  'send': ['sending', 'working'],
  'cleanup': ['finishing', 'working'],
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
  state.lastSig = null;
  state.logs = null;
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
    main.innerHTML = '<p class="empty">Pick a run from the sidebar, or submit a new prompt.</p>';
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
      const r = await fetch('/api/runs/' + encodeURIComponent(selected), {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (selected !== state.selected) return;
      if (!r.ok) {
        main.innerHTML = '<div class="err-box">Failed to load run: HTTP ' + r.status + '</div>';
        return;
      }
      state.detail = await r.json();
      if (selected === state.selected) renderDetail();
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

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  const main = document.getElementById('detail');

  // Skip rendering when nothing changed - otherwise the 2 s poll trashes any
  // <details> the user opened.
  const sig = JSON.stringify({
    id: d.id, status: d.status, result_kind: d.result_kind, join_name: d.join_name,
    prompt: d.prompt, backend: d.backend, turns: d.turns, final_result: d.final_result,
    pending_asks: d.pending_asks, pending_confirms: d.pending_confirms,
    pending_injection: d.pending_injection,
    teardown_signal_id: d.teardown_signal_id,
  });
  if (sig === state.lastSig) return;

  // Capture which call cards are currently open so we can restore them.
  const openKeys = new Set();
  for (const el of main.querySelectorAll('details.call[open]')) {
    if (el.dataset.key) openKeys.add(el.dataset.key);
  }
  // Preserve in-progress text in the say/fork boxes across the poll re-render.
  const sayDraft = main.querySelector('#say-input')?.value || '';
  const forkDraft = main.querySelector('#fork-input')?.value || '';

  state.lastSig = sig;

  const phase = runPhase(d.status);
  const { label, cls: statusCls } = describeStatus(d.status, d.result_kind, d.join_name);
  const turnsHtml = d.turns.length === 0
    ? '<p style="color: var(--muted)">Agent is starting up...</p>'
    : d.turns.map((t, i) => renderTurn(t, i)).join('');

  const asksHtml = (d.pending_asks && d.pending_asks.length) ? d.pending_asks.map((a) =>
    '<form class="ask" data-child="' + esc(a.id) + '">'
    + '<p>' + esc(a.question || '(no question)') + '</p>'
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
  const cleanupBtn = phase !== 'terminal' && d.teardown_signal_id
    ? ' &middot; <button type="button" id="cleanup-btn">tear down</button>'
    : '';

  main.innerHTML = ''
    + '<h2>' + esc(d.prompt ? truncate(d.prompt, 80) : 'Run') + '</h2>'
    + '<div class="meta">'
    +   '<a href="' + esc(execLink(d.id)) + '" target="_blank" rel="noopener"><code>' + esc(d.id) + '</code></a>'
    +   ' &middot; <span class="status ' + esc(statusCls) + '">' + esc(label) + '</span>'
    +   ' &middot; ' + esc(ago(d.created_at))
    +   ' &middot; <button type="button" id="logs-toggle">logs (including nested)</button>'
    +   pauseBtn
    +   cleanupBtn
    + '</div>'
    + '<div id="logs-slot">' + renderLogs() + '</div>'
    + (d.prompt ? '<div class="bubble user"><div class="label">prompt</div><pre>' + esc(d.prompt) + '</pre></div>' : '')
    + confirmsHtml
    + turnsHtml
    + finalHtml
    + asksHtml
    + renderInteraction(
      phase,
      d.pending_injection,
      Boolean((d.pending_asks && d.pending_asks.length)
        || (d.pending_confirms && d.pending_confirms.length)),
    );

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
  main.querySelector('#cleanup-btn')?.addEventListener('click', (event) => {
    const btn = event.currentTarget;
    if (!btn.classList.contains('confirming')) {
      btn.classList.add('confirming');
      btn.textContent = 'confirm tear down';
      return;
    }
    cleanupAgentSession(state.selected, btn);
  });

  const say = main.querySelector('#say-form');
  if (say) {
    say.querySelector('#say-input').value = sayDraft;
    say.addEventListener('submit', (ev) => {
      ev.preventDefault();
      sendToAgent(state.selected, say.querySelector('#say-input').value);
    });
  }
  const fork = main.querySelector('#fork-form');
  if (fork) {
    fork.querySelector('#fork-input').value = forkDraft;
    fork.addEventListener('submit', (ev) => {
      ev.preventDefault();
      forkSession(state.selected, fork.querySelector('#fork-input').value, fork.querySelector('#fork-backend')?.value);
    });
  }
}

// Status -> control phase. Terminal runs offer Fork; paused/active runs offer
// pause/unpause and the live "send to agent" box.
function runPhase(status) {
  if (status === 'finished' || /^permanently/.test(status)) return 'terminal';
  if (status === 'paused') return 'paused';
  return 'active';
}

// Bottom-of-transcript controls: a chat box to steer a running agent, or a fork
// box to continue a finished run in a fresh session. The live box exists only
// while the workflow has a concrete pending injection stub. Explicit ask/confirm
// gates own the input UI and suppress generic steering.
function renderInteraction(phase, pendingInjection, hasHumanGate) {
  if (phase === 'terminal') {
    const orig = state.detail && state.detail.backend === 'codex' ? 'codex' : 'claude';
    const opt = (v) => '<option value="' + v + '"' + (v === orig ? ' selected' : '') + '>' + v + '</option>';
    return '<form id="fork-form" class="interact fork">'
      + '<div class="label">fork to new session</div>'
      + '<textarea id="fork-input" placeholder="Continue from this run with... (optional)"></textarea>'
      + '<div class="fork-row">'
      +   '<select id="fork-backend" title="agent backend">' + opt('claude') + opt('codex') + '</select>'
      +   '<button type="submit">Fork to new session</button>'
      + '</div>'
      + '</form>';
  }
  if (hasHumanGate || !pendingInjection) return '';
  return '<form id="say-form" class="interact say">'
    + '<div class="label">' + (phase === 'paused' ? 'send to agent (queued until unpaused)' : 'send to agent') + '</div>'
    + '<textarea id="say-input" placeholder="Steer or interrupt the agent... (delivered next turn)" required></textarea>'
    + '<button type="submit">Send to agent</button>'
    + '</form>';
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
  try {
    const r = await fetch('/api/logs/' + encodeURIComponent(state.selected), {
      headers: { accept: 'application/json' },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    state.logs = data.logs || [];
  } catch (e) {
    state.logs = [{ execution_id: state.selected, ffqn: '', level: 'error', message: String(e) }];
  }
  updateLogsSlot();
}

function renderDiffLines(lines) {
  return (lines || []).map((l) => {
    const cls = l.tag === '+' ? 'dl add' : (l.tag === '-' ? 'dl del' : 'dl');
    return '<span class="' + cls + '">' + esc(l.tag + ' ' + l.text) + '</span>';
  }).join('');
}

function displayBlocksHtml(blocks) {
  return (blocks || []).map((block) => {
    const source = encodeURIComponent(block.content || '');
    if (block.kind === 'thinking') {
      return '<div class="bubble thinking"><div class="label">thinking</div>'
        + '<div class="rendered-markdown" data-source="' + esc(source) + '"></div></div>';
    }
    if (block.kind === 'mermaid') {
      return '<div class="bubble mermaid-block"><div class="label">diagram</div>'
        + '<div class="mermaid-source" data-source="' + esc(source) + '"></div></div>';
    }
    return '<div class="bubble markdown rendered-markdown" data-source="' + esc(source) + '"></div>';
  }).join('');
}

function hydrateDisplayBlocks(root) {
  for (const el of root.querySelectorAll('.rendered-markdown[data-source]')) {
    const source = decodeURIComponent(el.dataset.source || '');
    if (window.marked && window.DOMPurify) {
      el.innerHTML = window.DOMPurify.sanitize(window.marked.parse(source));
    } else {
      el.innerHTML = '<pre>' + esc(source) + '</pre>';
    }
    el.removeAttribute('data-source');
  }
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
  if (t.kind === 'final') return displayBlocksHtml(t.blocks);
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
  // Model-emitted final blocks are rendered with their turn. Fall back to the
  // workflow result only for old executions with no persisted final turn.
  const finalTurn = [...d.turns].reverse().find((t) => t.kind === 'final');
  if (finalTurn) return '';
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
  const btn = document.getElementById('new-submit');
  const sel = document.getElementById('new-backend');
  const backend = sel ? sel.value : 'claude';
  btn.disabled = true;
  try {
    const r = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, backend }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    document.getElementById('new-prompt').value = '';
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

async function cleanupAgentSession(runId, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'tearing down...';
  }
  try {
    const r = await fetch('/api/cleanup/' + encodeURIComponent(runId), { method: 'POST' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    state.lastSig = null;
    await refreshDetail();
    await refreshSidebar();
  } catch (e) {
    alert('Tear down failed: ' + String(e));
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('confirming');
      btn.textContent = 'tear down';
    }
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
    const box = document.getElementById('say-input');
    if (box) box.value = '';
    if (state.detail) state.detail.pending_injection = null;
    state.lastSig = null;
    renderDetail();
  } catch (e) {
    alert('Send failed: ' + String(e));
  }
}

async function forkSession(runId, text, backend) {
  try {
    const r = await fetch('/api/fork/' + encodeURIComponent(runId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: text || '', backend: backend || undefined }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    await refreshSidebar();
    setSelected(data.execution_id);
  } catch (e) {
    alert('Fork failed: ' + String(e));
  }
}

document.getElementById('new-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const t = document.getElementById('new-prompt').value.trim();
  if (t) submitPrompt(t);
});

readSelectedFromUrl();
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
