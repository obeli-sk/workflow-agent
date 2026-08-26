// Run listing (sidebar) and per-run detail assembly: normalise an execution and
// its derived children into the transcript, status, and pending human-gate shape
// the UI renders.

import {
    getExecutionLogs,
    getExecutionRecord,
    getExecutionStatus,
    listExecutions,
} from "./obelisk-api.js";
import {
    loadLatestAgentState,
    loadLatestSessionName,
    loadResponses,
    parseJoinName,
} from "./responses.js";
import { SESSION_STATE_LABELS, emptyMarkers, projectSessionState } from "../../shared/session-state.js";

const WORKFLOW_FFQN = "obelisk-agent:workflow/workflow.run-cancellable";
function pickRunState(workflowStatus) {
    const ps = workflowStatus?.pending_state || null;
    return {
        status: ps?.status || "unknown",
        result_kind: ps?.result_kind ?? null,
        join_name: parseJoinName(ps?.join_set_id),
    };
}

// The one place raw execution facts become a session state; consumers render
// label/cls straight from SESSION_STATE_LABELS.
function projectRun(runState, working, markers) {
    const state = projectSessionState({
        status: runState.status,
        resultKind: runState.result_kind,
        joinName: runState.join_name,
        working,
        markers,
    });
    const [label, cls] = SESSION_STATE_LABELS[state];
    return { state, label, cls };
}

export async function listRuns() {
    // Derived executions are included so child sessions created via
    // `chat create` appear nested under their parent (the FFQN prefix filters
    // out every other derived child kind).
    const executions = await listExecutions(WORKFLOW_FFQN, "", true, false, 100);
    const runs = await Promise.all(executions.map(async (e) => {
        const id = e.execution_id;
        const runState = pickRunState(e);
        const [latest, name] = await Promise.all([
            loadLatestAgentState(id),
            loadLatestSessionName(id),
        ]);
        const working = runState.status === "blocked_by_join_set" && runState.join_name === "user"
            && latest.working;
        return {
            id,
            created_at: e.created_at || "",
            ...runState,
            working,
            ...projectRun(runState, latest.working, latest.markers || emptyMarkers()),
            name,
        };
    }));
    return { runs: nestChildren(runs) };
}

// Child sessions (derived executions: `<parent-id>.<join-set-ref>`) render
// indented below their parent when the parent row is on the same page;
// orphans whose parent fell out of the listing window stay top-level.
function nestChildren(runs) {
    const byId = new Map(runs.map((run) => [run.id, run]));
    for (const run of runs) {
        const dot = run.id.lastIndexOf(".");
        const parent = dot > 0 ? byId.get(run.id.slice(0, dot)) : undefined;
        run.parent_id = parent ? parent.id : null;
    }
    const childrenOf = new Map();
    const roots = [];
    for (const run of runs) {
        if (run.parent_id) {
            if (!childrenOf.has(run.parent_id)) childrenOf.set(run.parent_id, []);
            childrenOf.get(run.parent_id).push(run);
        } else {
            roots.push(run);
        }
    }
    for (const children of childrenOf.values()) {
        children.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    }
    const nested = [];
    for (const root of roots) {
        nested.push(root);
        nested.push(...(childrenOf.get(root.id) ?? []));
    }
    return nested;
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
    const runState = pickRunState(status);
    // Exact markers from the full event walk (the sidebar scan is bounded).
    const markers = {
        lastReplyTurn: null,
        stepLimitTurn: null,
        lastShellTurn: null,
        hasShellEvents: walk.shellEvents.length > 0,
    };
    for (const reply of walk.replies) {
        if (!reply.turn_complete) continue;
        const turn = Number.isInteger(reply.turn_index) ? reply.turn_index : -1;
        if (typeof reply.reply?.response === "string" && reply.reply.response) {
            markers.lastReplyTurn = Math.max(markers.lastReplyTurn ?? -1, turn);
        }
    }
    for (const shell of walk.shellEvents) {
        if (!shell.turn_complete) continue;
        const turn = Number.isInteger(shell.turn_index) ? shell.turn_index : -1;
        if (turn >= 0) markers.lastShellTurn = Math.max(markers.lastShellTurn ?? -1, turn);
    }
    for (const error of walk.agentErrors) {
        if (error.id.startsWith("step-limit-")) {
            markers.stepLimitTurn = Math.max(
                markers.stepLimitTurn ?? -1,
                Number.isInteger(error.turn_index) ? error.turn_index : -1,
            );
        }
    }
    return {
        id,
        ...runState,
        ...projectRun(runState, walk.agentWorking === true, markers),
        created_at: status?.created_at || "",
        prompt: started?.prompt || null,
        backend: started?.backend || null,
        effort: started?.effort || null,
        name: walk.sessionName ?? null,
        system_prompt: started?.system_prompt || null,
        transcript: {
            reset: resetTranscript,
            workflow_id: id,
            replies: walk.replies,
            user_messages: walk.userMessages,
            shell_events: walk.shellEvents,
            turn_starts: walk.turnStarts,
            human_input_events: walk.humanInputEvents,
            agent_errors: walk.agentErrors,
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
