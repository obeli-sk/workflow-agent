// Walk an execution's response stream into the transcript pieces the UI renders:
// assistant replies, tool results, operator messages, shell output, and the
// operator turn boundaries.

import { getExecutionResponses } from "./obelisk-api.js";

export async function loadResponses(execId, startCursor = 0) {
    const replies = [];
    const toolResults = [];
    const operatorMessages = [];
    const shellEvents = [];
    const turnStarts = [];
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

            if (joinName === "session-events") {
                appendSessionEvent(
                    { replies, toolResults, operatorMessages, shellEvents },
                    ev.result?.ok?.value ?? ev.result?.ok,
                    r,
                );
            } else if (joinName === "operator") {
                const value = ev.result?.ok?.value ?? ev.result?.ok;
                const event = parseSessionInput(value);
                if (event) {
                    turnStarts.push({
                        id: event.id || "",
                        kind: event.kind,
                        created_at: r.event?.created_at || "",
                    });
                }
            }
        }
        if (responses.length === 0) break;
        const next = responses[responses.length - 1]?.cursor;
        if (typeof next !== "number" || next <= cursor) break;
        cursor = next;
        including = false;
        if (responses.length < 200) break;
    }
    return {
        replies,
        toolResults,
        operatorMessages,
        shellEvents,
        turnStarts,
        cursor,
    };
}

function appendSessionEvent(target, event, response) {
    if (!event || typeof event !== "object") return;
    const createdAt = response.event?.created_at || "";
    if (event.operator_message) {
        const message = event.operator_message;
        target.operatorMessages.push({
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

function parseSessionInput(value) {
    if (!value || typeof value !== "object") return null;
    if (value.shell) return { kind: "shell", ...value.shell };
    if (value.prompt) return { kind: "prompt", ...value.prompt };
    return null;
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
    // use "n:<name>". Each workflow loop opens an "operator-<loop>" set;
    // collapse the suffix so callers key off the stable name "operator".
    if (typeof joinSetId !== "string") return "";
    const name = rawJoinName(joinSetId);
    return /^operator-\d+$/.test(name) ? "operator" : name;
}

function rawJoinName(joinSetId) {
    if (typeof joinSetId !== "string") return "";
    if (joinSetId.startsWith("n:")) return joinSetId.substring(2);
    const dash = joinSetId.indexOf("-");
    return dash === -1 ? "" : joinSetId.substring(dash + 1);
}
