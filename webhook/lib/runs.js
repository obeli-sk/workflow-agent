// Run listing (sidebar) and per-run detail assembly: normalise an execution and
// its derived children into the transcript, status, and pending human-gate shape
// the UI renders.

import {
    getDeployment,
    getExecutionEvents,
    getExecutionLogs,
    getExecutionRecord,
    getExecutionStatus,
    listExecutions,
} from "./obelisk-api.js";
import { loadResponses, parseJoinName } from "./responses.js";
import { collectSources, diffSources, loadCurrentSources } from "./sources.js";

const WORKFLOW_FFQN = "obelisk-agent:workflow/workflow.run-cancellable";
const ASK_USER_FFQN = "obelisk-agent:tools/input.ask-user";
const CONFIRM_FFQN = "obelisk-agent:tools/deploy.confirm-apply";
const INJECTION_FFQN = "obelisk-agent:agent/session.injection";
const COMPLETION_FFQN = "obelisk-agent:llm/chat.completion";

function pickRunState(workflowStatus) {
    const ps = workflowStatus?.pending_state || null;
    return {
        status: ps?.status || "unknown",
        result_kind: ps?.result_kind ?? null,
        join_name: parseJoinName(ps?.join_set_id),
    };
}

export async function listRuns() {
    const executions = await listExecutions(WORKFLOW_FFQN, "", false, false, 50);
    const runs = await Promise.all(executions.map(async (e) => {
        const id = e.execution_id;
        const prompt_preview = await loadPromptPreview(id);
        const runState = pickRunState(e);
        // A run blocked on the shared operator set is either awaiting the operator
        // ("your turn") or mid-completion ("thinking"); the join name cannot tell
        // them apart, so consult the pending completion child (only for such runs).
        const working = runState.status === "blocked_by_join_set" && runState.join_name === "operator"
            ? Boolean(await loadPendingCompletion(id))
            : false;
        return {
            id,
            created_at: e.created_at || "",
            ...runState,
            working,
            prompt_preview,
        };
    }));
    return { runs };
}

async function loadPromptPreview(execId) {
    const p = (await loadPrompt(execId)) || "";
    return p.length > 120 ? p.substring(0, 120) + "..." : p;
}

export async function detailRun(id, cursorState) {
    const resetTranscript = cursorState.workflowId !== id;
    const responseCursor = resetTranscript ? 0 : cursorState.responseCursor;
    const [status, created, walk, finalResult, pendingAsks, pendingConfirms, pendingInjection, pendingCompletion] = await Promise.all([
        loadStatus(id),
        loadCreated(id),
        loadResponses(id, responseCursor),
        loadFinalResult(id),
        loadPendingAsks(id),
        loadPendingConfirms(id),
        loadPendingInjection(id),
        loadPendingCompletion(id),
    ]);
    return {
        id,
        ...pickRunState(status),
        created_at: status?.created_at || "",
        prompt: created?.prompt ?? null,
        backend: created?.backend ?? null,
        effort: created?.effort ?? null,
        transcript: {
            reset: resetTranscript,
            workflow_id: id,
            replies: walk.replies,
            operator_messages: walk.operatorMessages,
            shell_events: walk.shellEvents,
            turn_starts: walk.turnStarts,
            sent_results: walk.toolResults,
            response_cursor: walk.cursor,
        },
        final_result: finalResult,
        pending_asks: pendingAsks,
        pending_confirms: pendingConfirms,
        pending_injection: pendingInjection,
        pending_completion: pendingCompletion,
    };
}

async function loadStatus(id) {
    try { return await getExecutionStatus(id); }
    catch (_) { return null; }
}

// The workflow.run-cancellable creation params are [prompt, model, descriptor-ffqn, effort].
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
export async function loadExecutionTreeLogs(workflowId, startCursor) {
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

export async function loadPendingInjection(workflowId) {
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

async function loadPendingCompletion(workflowId) {
    let candidates;
    try {
        candidates = await listExecutions(COMPLETION_FFQN, workflowId, true, true, 10);
    } catch (_) { return null; }
    const mine = candidates.filter((e) => e?.ffqn === COMPLETION_FFQN
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
