// Run listing (sidebar) and per-run detail assembly: normalise an execution and
// its derived children into the transcript, status, and pending human-gate shape
// the UI renders.

import {
    getExecutionEvents,
    getExecutionLogs,
    getExecutionRecord,
    getExecutionStatus,
    listExecutions,
} from "./obelisk-api.js";
import { loadLatestAgentStatus, loadResponses, parseJoinName } from "./responses.js";

const WORKFLOW_FFQN = "obelisk-agent:workflow/workflow.run-cancellable";
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
        // The shared operator set races input against completion, so its join
        // name alone cannot distinguish "your turn" from "thinking".
        const working = runState.status === "blocked_by_join_set" && runState.join_name === "operator"
            ? await loadLatestAgentStatus(id)
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
    const [status, walk, finalResult] = await Promise.all([
        loadStatus(id),
        loadResponses(id, responseCursor),
        loadFinalResult(id),
    ]);
    const started = walk.sessionStarted;
    return {
        id,
        ...pickRunState(status),
        created_at: status?.created_at || "",
        prompt: started?.prompt || null,
        backend: started?.backend || null,
        effort: started?.effort || null,
        transcript: {
            reset: resetTranscript,
            workflow_id: id,
            replies: walk.replies,
            operator_messages: walk.operatorMessages,
            shell_events: walk.shellEvents,
            turn_starts: walk.turnStarts,
            human_input_events: walk.humanInputEvents,
            session_started: walk.sessionStarted,
            sent_results: walk.toolResults,
            input_offer: walk.inputOffer,
            agent_working: walk.agentWorking,
            response_cursor: walk.cursor,
        },
        final_result: finalResult,
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
