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
// The SPA polls /api/runs every 3s and the open run every 2s, so refreshes
// happen without page reloads. Layout is two-pane: sidebar = prompt list +
// new-prompt form, right pane = chat-style transcript.

const WORKFLOW_FFQN = "obelisk-agent:workflow/workflow.run";
const ASK_USER_FFQN = "obelisk-agent:tools/input.ask-user";
const CONFIRM_FFQN = "obelisk-agent:tools/deploy.confirm-apply";

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
    const [status, prompt, walk, finalResult, pendingAsks, pendingConfirms] = await Promise.all([
        loadStatus(id),
        loadPrompt(id),
        loadResponses(id),
        loadFinalResult(id),
        loadPendingAsks(id),
        loadPendingConfirms(id),
    ]);
    return {
        id,
        status: status?.pending_state?.status || "unknown",
        result_kind: status?.pending_state?.result_kind ?? null,
        created_at: status?.created_at || "",
        prompt,
        turns: buildTurns(walk.replies, walk.toolChildren),
        final_result: finalResult,
        pending_asks: pendingAsks,
        pending_confirms: pendingConfirms,
    };
}

async function loadStatus(id) {
    try { return await obeliskJson(`/v1/executions/${encodeURIComponent(id)}/status`); }
    catch (_) { return null; }
}

async function loadPrompt(id) {
    try {
        // version 0 is the `created` event; without including_cursor=true the
        // server skips it and returns the `locked` event at version 1, which
        // has no params.
        const payload = await obeliskJson(
            `/v1/executions/${encodeURIComponent(id)}/events?version_from=0&including_cursor=true&length=1`,
        );
        const params = payload.events?.[0]?.event?.created?.params;
        return Array.isArray(params) && typeof params[0] === "string" ? params[0] : null;
    } catch (_) { return null; }
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
                // turn-outcome: "working" (string) or { reply: agent-reply }.
                const value = ev.result?.ok?.value ?? ev.result?.ok;
                if (value && typeof value === "object" && value.reply) {
                    replies.push(value.reply);
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

function parseJoinName(joinSetId) {
    // join_set_id format: "o:<ordinal>-<name>"
    if (typeof joinSetId !== "string") return "";
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
//   { kind: "tool_calls", calls: [{name, args, child_id?, ok?|err?}] }
//   { kind: "final", text }
//
// Tool calls are paired with the next N entries in `toolChildren` (collected
// from the workflow's response stream in dispatch order).
function buildTurns(replies, toolChildren) {
    const turns = [];
    let toolCursor = 0;
    for (const reply of replies) {
        if (!reply || typeof reply !== "object") continue;
        if (typeof reply.final === "string") {
            turns.push({ kind: "final", text: reply.final });
        } else if (Array.isArray(reply.tool_calls)) {
            const calls = reply.tool_calls.map((c) => {
                const child = toolChildren[toolCursor++];
                const base = {
                    name: c?.name,
                    args: parseArgs(c?.arguments_json),
                    child_id: child?.id ?? null,
                };
                if (child && child.result) {
                    if ("ok" in child.result) base.ok = child.result.ok;
                    else if ("err" in child.result) base.err = child.result.err;
                }
                return base;
            });
            turns.push({ kind: "tool_calls", calls });
        }
    }
    return turns;
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
  .run-meta .status.timeout, .run-meta .status.permanently_failed, .run-meta .status.permanently_timed_out, .run-meta .status.err { color: var(--err); }
  main .empty { color: var(--muted); margin-top: 4rem; text-align: center; }
  main h2 { margin: 0 0 0.5rem; font-size: 1.05rem; font-weight: 600; }
  .meta { color: var(--muted); font-size: 0.85em; margin-bottom: 1.5rem; }
  .meta code { font-size: 1em; }
  .bubble { padding: 0.8em 1em; border-radius: 8px; margin: 0.6em 0; max-width: 720px; }
  .bubble.user { background: var(--accent-bg); border: 1px solid #d0deef; }
  .bubble.final { background: var(--ok-bg); border: 1px solid #c6e0ce; }
  .bubble pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; }
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
  form.ask { background: #fffaf2; border: 1px solid #f0d8a8; border-radius: 6px; padding: 0.8em 1em; margin: 1em 0; }
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
  .err-box { background: var(--err-bg); border: 1px solid #f4c0c0; color: var(--err); padding: 0.6em 0.9em; border-radius: 4px; margin: 1em 0; }
  .ago { color: var(--muted); font-size: 0.8em; }
</style>
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

function readSelectedFromUrl() {
  const m = window.location.search.match(/[?&]run=([^&]+)/);
  state.selected = m ? decodeURIComponent(m[1]) : null;
}

function setSelected(id) {
  state.selected = id;
  state.lastSig = null;
  state.logs = null;
  state.logsOpen = false;
  const u = new URL(window.location.href);
  if (id) u.searchParams.set('run', id); else u.searchParams.delete('run');
  window.history.replaceState({}, '', u.toString());
  renderSidebar();
  refreshDetail();
}

async function refreshSidebar() {
  try {
    const r = await fetch('/api/runs', { headers: { accept: 'application/json' } });
    if (!r.ok) return;
    const data = await r.json();
    state.runs = data.runs || [];
    renderSidebar();
  } catch (_) {}
}

function renderSidebar() {
  const box = document.getElementById('runs');
  if (state.runs.length === 0) {
    box.innerHTML = '<p style="padding: 1rem; color: var(--muted)">No runs yet.</p>';
    return;
  }
  box.innerHTML = state.runs.map((r) => {
    const label = statusLabel(r.status, r.result_kind);
    const cls = label.replaceAll(' ', '_');
    return '<a class="run-item' + (r.id === state.selected ? ' active' : '') + '" href="?run=' + encodeURIComponent(r.id) + '" data-id="' + esc(r.id) + '">'
      + '<div class="run-prompt">' + esc(r.prompt_preview || '(no prompt)') + '</div>'
      + '<div class="run-meta"><span class="status ' + esc(cls) + '">' + esc(label) + '</span><span class="ago">' + esc(ago(r.created_at)) + '</span></div>'
      + '</a>';
  }).join('');
  for (const a of box.querySelectorAll('.run-item')) {
    a.addEventListener('click', (ev) => { ev.preventDefault(); setSelected(a.dataset.id); });
  }
}

async function refreshDetail() {
  const main = document.getElementById('detail');
  if (!state.selected) {
    main.innerHTML = '<p class="empty">Pick a run from the sidebar, or submit a new prompt.</p>';
    return;
  }
  try {
    const r = await fetch('/api/runs/' + encodeURIComponent(state.selected), { headers: { accept: 'application/json' } });
    if (!r.ok) {
      main.innerHTML = '<div class="err-box">Failed to load run: HTTP ' + r.status + '</div>';
      return;
    }
    state.detail = await r.json();
    renderDetail();
  } catch (e) {
    main.innerHTML = '<div class="err-box">' + esc(String(e)) + '</div>';
  }
}

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  const main = document.getElementById('detail');

  // Skip rendering when nothing changed - otherwise the 2 s poll trashes any
  // <details> the user opened.
  const sig = JSON.stringify({
    id: d.id, status: d.status, result_kind: d.result_kind,
    prompt: d.prompt, turns: d.turns, final_result: d.final_result,
    pending_asks: d.pending_asks, pending_confirms: d.pending_confirms,
  });
  if (sig === state.lastSig) return;

  // Capture which call cards are currently open so we can restore them.
  const openKeys = new Set();
  for (const el of main.querySelectorAll('details.call[open]')) {
    if (el.dataset.key) openKeys.add(el.dataset.key);
  }

  state.lastSig = sig;

  const label = statusLabel(d.status, d.result_kind);
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

  main.innerHTML = ''
    + '<h2>' + esc(d.prompt ? truncate(d.prompt, 80) : 'Run') + '</h2>'
    + '<div class="meta">'
    +   '<a href="' + esc(execLink(d.id)) + '" target="_blank" rel="noopener"><code>' + esc(d.id) + '</code></a>'
    +   ' &middot; <span class="status ' + esc(label.replaceAll(' ', '_')) + '">' + esc(label) + '</span>'
    +   ' &middot; ' + esc(ago(d.created_at))
    +   ' &middot; <button type="button" id="logs-toggle">logs (including nested)</button>'
    + '</div>'
    + '<div id="logs-slot">' + renderLogs() + '</div>'
    + (d.prompt ? '<div class="bubble user"><div class="label">prompt</div><pre>' + esc(d.prompt) + '</pre></div>' : '')
    + confirmsHtml
    + asksHtml
    + turnsHtml
    + finalHtml;

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
      + '<span class="' + level.trim() + '">' + esc(text.replace(/\n$/, '')) + '</span>';
  });
  return '<div class="logs"><div class="logs-head"><span>execution logs · ' + rows.length
    + ' entries</span><button type="button" id="logs-refresh">refresh</button></div><pre>'
    + (rows.join('\n') || '(no logs yet)') + '</pre></div>';
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

function renderTurn(t, i) {
  if (t.kind === 'final') return ''; // rendered separately at the bottom
  if (t.kind !== 'tool_calls') return '';

  // Turn numbering = index among tool_calls turns + 1.
  let turnNo = 0;
  for (let j = 0; j <= i; j += 1) {
    if (state.detail.turns[j].kind === 'tool_calls') turnNo += 1;
  }
  const items = t.calls.map((c, k) => renderCall(c, i, k)).join('');
  return '<div class="turn">'
    + '<div class="turn-header">Turn ' + turnNo + ' &middot; ' + t.calls.length + ' tool call' + (t.calls.length === 1 ? '' : 's') + '</div>'
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
  // Prefer the model's emitted final turn, fall back to the workflow result.
  const finalTurn = [...d.turns].reverse().find((t) => t.kind === 'final');
  if (finalTurn) {
    return '<div class="bubble final"><div class="label">final</div><pre>' + esc(finalTurn.text) + '</pre></div>';
  }
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

document.getElementById('new-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const t = document.getElementById('new-prompt').value.trim();
  if (t) submitPrompt(t);
});

readSelectedFromUrl();
refreshSidebar();
refreshDetail();
setInterval(refreshSidebar, 3000);
setInterval(refreshDetail, 2000);
</script>
</body>
</html>`;
