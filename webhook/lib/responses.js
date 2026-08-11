// Walk the session notification stream into the transcript and live UI state.

import { getExecutionResponses, getLatestExecutionResponses } from "./obelisk-api.js";

export async function loadResponses(execId, startCursor = 0) {
    const replies = [];
    const toolResults = [];
    const userMessages = [];
    const shellEvents = [];
    const turnStarts = [];
    const humanInputEvents = [];
    let sessionStarted;
    let inputOffer;
    let agentWorking;
    let cursor = startCursor;
    let including = startCursor === 0;
    while (true) {
        let payload;
        try {
            payload = await getExecutionResponses(execId, "session-events", cursor, including, 200);
        } catch (_) { break; }
        const responses = payload.responses || [];
        for (const r of responses) {
            const wrapped = r.event?.event;
            const ev = wrapped?.event;
            if (!ev || ev.type !== "child_execution_finished") continue;
            const projection = {
                replies,
                toolResults,
                userMessages,
                shellEvents,
                turnStarts,
                humanInputEvents,
                sessionStarted,
                inputOffer,
                agentWorking,
            };
            appendSessionEvent(projection, ev.result?.ok?.value ?? ev.result?.ok, r);
            inputOffer = projection.inputOffer;
            agentWorking = projection.agentWorking;
            sessionStarted = projection.sessionStarted;
        }
        const next = payload.scan_cursor;
        if (typeof next !== "number" || next <= cursor) break;
        cursor = next;
        including = false;
        if (typeof payload.max_cursor === "number" && cursor >= payload.max_cursor) break;
    }
    return {
        replies,
        toolResults,
        userMessages,
        shellEvents,
        turnStarts,
        humanInputEvents,
        sessionStarted,
        inputOffer,
        agentWorking,
        cursor,
    };
}

export async function loadLatestAgentStatus(execId) {
    let payload;
    try { payload = await getLatestExecutionResponses(execId, "session-events", 100); }
    catch (_) { return false; }
    const responses = payload.responses || [];
    for (let i = responses.length - 1; i >= 0; i -= 1) {
        const wrapped = responses[i]?.event?.event;
        const value = wrapped?.event?.result?.ok?.value ?? wrapped?.event?.result?.ok;
        if (typeof value?.agent_status?.working === "boolean") {
            return value.agent_status.working;
        }
    }
    return false;
}

function appendSessionEvent(target, event, response) {
    if (!event || typeof event !== "object") return;
    const createdAt = response.event?.created_at || "";
    if (event.session_started) {
        const started = event.session_started;
        target.sessionStarted = {
            protocol_version: started.protocol_version,
            prompt: typeof started.prompt === "string" ? started.prompt : "",
            backend: typeof started.backend === "string" ? started.backend : "",
            effort: typeof started.effort === "string" ? started.effort : "",
        };
    } else if (event.input_offered) {
        const offer = event.input_offered;
        target.inputOffer = {
            id: typeof offer.execution_id === "string" ? offer.execution_id : "",
            turn_index: Number.isInteger(offer.turn_index) ? offer.turn_index : null,
        };
    } else if (event.agent_status) {
        target.agentWorking = event.agent_status.working === true;
    } else if (event.human_input_requested) {
        const requested = event.human_input_requested;
        target.humanInputEvents.push({
            kind: "requested",
            id: typeof requested.execution_id === "string" ? requested.execution_id : "",
            question: typeof requested.question === "string" ? requested.question : "",
            turn_index: Number.isInteger(requested.turn_index) ? requested.turn_index : null,
        });
    } else if (event.human_input_resolved) {
        const resolved = event.human_input_resolved;
        target.humanInputEvents.push({
            kind: "resolved",
            id: typeof resolved.execution_id === "string" ? resolved.execution_id : "",
            turn_index: Number.isInteger(resolved.turn_index) ? resolved.turn_index : null,
        });
    } else if (event.user_message) {
        const message = event.user_message;
        target.turnStarts.push({
            id: message.id || "",
            kind: "prompt",
            created_at: createdAt,
        });
        target.userMessages.push({
            id: message.id || "",
            text: message.text || "",
            created_at: createdAt,
            turn_index: Number.isInteger(message.turn_index) ? message.turn_index : null,
        });
    } else if (event.assistant_reply) {
        const reply = event.assistant_reply;
        appendAssistantReply(target.replies, reply, createdAt);
    } else if (event.agent_error) {
        const error = event.agent_error;
        target.replies.push({
            reply: { error: error.text },
            created_at: createdAt,
            turn_index: Number.isInteger(error.turn_index) ? error.turn_index : null,
            turn_complete: true,
        });
    } else if (event.tool_result) {
        target.toolResults.push(normalizeSessionToolResult(event.tool_result, createdAt));
    } else if (event.shell_output) {
        const output = event.shell_output;
        target.turnStarts.push({
            id: output.id || "",
            kind: "shell",
            created_at: subtractMilliseconds(createdAt, output.duration_milliseconds),
        });
        target.shellEvents.push({
            kind: "shell_output",
            id: output.id || "",
            script: output.script || "",
            result: output.result || {},
            created_at: createdAt,
            turn_index: Number.isInteger(output.turn_index) ? output.turn_index : null,
            duration_milliseconds: output.duration_milliseconds,
            turn_complete: output.turn_complete === true,
        });
    }
}

function subtractMilliseconds(timestamp, duration) {
    let end = Date.parse(timestamp);
    if (!Number.isFinite(end) && typeof timestamp === "string") {
        end = Date.parse(timestamp.replace(/(\.\d{3})\d+(?=Z$|[+-]\d{2}:\d{2}$)/, "$1"));
    }
    if (!Number.isFinite(end) || !Number.isFinite(duration)) return timestamp;
    return new Date(end - Math.max(0, duration)).toISOString();
}

function appendAssistantReply(replies, rep, createdAt) {
    if (!rep || typeof rep.content_json !== "string") return;
    let blocks = [];
    try { blocks = JSON.parse(rep.content_json); } catch (_) { blocks = []; }
    if (!Array.isArray(blocks)) blocks = [];
    const toolUses = blocks.filter((b) => b && b.type === "tool_use");
    const text = blocks.filter((b) => b && b.type === "text").map((b) => b.text || "").join("");
    const reply = toolUses.length > 0
        ? { tool_calls: toolUses.map((b) => ({
            id: typeof b.id === "string" ? b.id : "",
            name: b.name,
            args: b.input || {},
        })) }
        : { response: text };
    replies.push({
        reply,
        narration: toolUses.length > 0 ? text : "",
        created_at: createdAt,
        turn_index: Number.isInteger(rep.turn_index) ? rep.turn_index : null,
        duration_milliseconds: rep.duration_milliseconds,
        turn_complete: rep.turn_complete === true,
    });
}

function normalizeSessionToolResult(result, createdAt) {
    const out = { id: String(result.id || ""), created_at: createdAt };
    if (result.output && "ok" in result.output) out.ok = result.output.ok;
    else if (result.output && "error" in result.output) out.err = result.output.error;
    out.duration_milliseconds = result.duration_milliseconds;
    if (Number.isInteger(result.turn_index)) out.turn_index = result.turn_index;
    return out;
}

export function parseJoinName(joinSetId) {
    // One-off join sets use "o:<ordinal>-<name>"; explicitly named join sets
    // use "n:<name>".
    if (typeof joinSetId !== "string") return "";
    const name = rawJoinName(joinSetId);
    return /^user-\d+$/.test(name) ? "user" : name;
}

function rawJoinName(joinSetId) {
    if (typeof joinSetId !== "string") return "";
    if (joinSetId.startsWith("n:")) return joinSetId.substring(2);
    const dash = joinSetId.indexOf("-");
    return dash === -1 ? "" : joinSetId.substring(dash + 1);
}
