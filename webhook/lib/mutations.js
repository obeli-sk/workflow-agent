// Mutating routes: schedule/cancel runs, pause/unpause, inject user input,
// and fulfil pending ask-user stub children.
// These stay durable native calls (`webapi`, workflow schedule), unlike the
// read-only polling GETs.

import { runCancellableSchedule } from "obelisk-agent:workflow-obelisk-schedule/workflow";
import { jsonError, jsonResponse } from "./http.js";
import {
    cancelObeliskExecution,
    listExecutions,
    pauseObeliskExecution,
    stubObeliskExecution,
    unpauseObeliskExecution,
} from "./obelisk-api.js";

export async function submit(request) {
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
    let execId;
    try { execId = runCancellableSchedule(null, prompt, backend, null, effort, null); }
    catch (e) { return jsonError(502, `schedule failed: ${String(e)}`); }
    return jsonResponse({ execution_id: execId });
}

export async function createSession(request) {
    let payload = {};
    try {
        const text = await request.text();
        if (text) payload = JSON.parse(text);
    } catch (e) {
        return jsonError(400, `body must be JSON: ${e.message}`);
    }
    const backend = typeof payload.backend === "string" && payload.backend ? payload.backend : null;
    const effort = typeof payload.effort === "string" && payload.effort ? payload.effort : null;
    let execId;
    try { execId = runCancellableSchedule(null, "", backend, null, effort, null); }
    catch (e) { return jsonError(502, `schedule failed: ${String(e)}`); }
    return jsonResponse({ execution_id: execId });
}

// Pause or unpause a run via the native execution endpoints. A paused execution
// reports pending_state.status == "paused". Obelisk pauses a single execution,
// Pause/unpause every non-terminal workflow in the run as well, since programs
// invoked by the agent may themselves be workflows.
export async function pauseExecution(id, unpause) {
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

// Non-terminal nested workflow executions of a run. Excludes the run itself;
// activities and stubs are not paused.
async function childWorkflowIds(runId) {
    let executions;
    try {
        executions = await listExecutions("", runId, true, true, 200);
    } catch (_) { return []; }
    return executions
        .filter((e) => e?.execution_id !== runId && e?.component_type === "workflow")
        .map((e) => e.execution_id);
}

// Cancel a run and any nested cancellable workflows.
export async function cancelRun(id) {
    if (!id) return jsonError(400, "missing run id");
    let executions;
    try {
        executions = await listExecutions("", id, true, true, 200);
    } catch (e) { return jsonError(502, `cancel failed: ${String(e)}`); }
    const targets = executions
        .filter((e) => e?.component_type === "workflow"
            && typeof e?.ffqn === "string" && e.ffqn.endsWith("-cancellable"))
        .map((e) => e.execution_id);
    if (targets.length === 0) {
        return jsonError(409, "no cancellable execution for this run (needs a redeploy on the -cancellable agent loop)");
    }
    const failures = [];
    for (const target of targets) {
        try { cancelObeliskExecution(target); }
        catch (e) { failures.push(`${target}: ${String(e)}`); }
    }
    if (failures.length) return jsonError(502, `cancel failed: ${failures.join("; ")}`);
    return jsonResponse({ ok: true, cancelled: targets });
}

// Fulfil the concrete input offer advertised by the session notification feed.
export async function submitSessionInput(request, runId) {
    if (!runId) return jsonError(400, "missing run id");
    let payload;
    try { payload = JSON.parse(await request.text()); }
    catch (e) { return jsonError(400, `body must be JSON: ${e.message}`); }
    const offerId = payload?.offer_id;
    if (typeof offerId !== "string" || !offerId.startsWith(runId + ".")) {
        return jsonError(400, "offer_id must identify an input offer for this run");
    }
    const event = normalizeSessionInput(payload?.input);
    if (!event) return jsonError(400, "input must contain a valid prompt or shell command");
    try { stubObeliskExecution(offerId, { ok: event }); }
    catch (e) { return jsonError(502, `input fulfil failed: ${String(e)}`); }
    return jsonResponse({
        child_execution_id: offerId,
        event_id: (event.prompt || event.shell).id,
    });
}

function normalizeSessionInput(input) {
    if (!input || typeof input !== "object") return null;
    if (input.prompt) {
        const { id, text } = input.prompt;
        if (typeof id !== "string" || !id || typeof text !== "string" || !text.trim()) return null;
        return { prompt: { id, text: text.trim() } };
    }
    if (input.shell) {
        const { id, script } = input.shell;
        if (typeof id !== "string" || !id || typeof script !== "string" || !script.trim()) return null;
        return { shell: {
            id,
            script,
            stdin: typeof input.shell.stdin === "string" ? input.shell.stdin : "",
        } };
    }
    return null;
}

export async function answerStub(request, childId) {
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
