// HTTP Chat Completions client. POSTs the durable message history + tool schemas
// to a standard OpenAI-compatible endpoint (LLM_BASE_URL) and returns the
// assistant turn. The endpoint may be the agent-llm-server (claude/codex in
// docker) or any provider (OpenRouter, OpenAI, vLLM, ...). This is the only way
// the agent talks to a model; there are no exec activities.
//
// obelisk-agent:llm/chat.completion:
//   func(messages-json: string, tools-json: string, model: string)
//     -> result<variant {
//          reply(record { content: string,
//                         tool-calls: list<record { id: string, name: string, arguments-json: string }>,
//                         finish-reason: string }),
//          rate-limited(record { retry-after-seconds: u32, message: string }),
//        }, string>
//
// A throw becomes the err arm (hard failure); Obelisk retries per max_retries.
// A 429 is returned in-band as `rate-limited` so the workflow can durably sleep.

export default async function completion(messagesJson, toolsJson, model) {
    const base = process.env["LLM_BASE_URL"];
    if (!base) throw "LLM_BASE_URL is not configured";
    const url = base.replace(/\/$/, "") + "/v1/chat/completions";

    let messages;
    try { messages = JSON.parse(messagesJson); }
    catch (e) { throw `messages-json is not valid JSON: ${String(e)}`; }
    let tools = [];
    if (toolsJson) {
        try { tools = JSON.parse(toolsJson); }
        catch (e) { throw `tools-json is not valid JSON: ${String(e)}`; }
    }

    const body = { model: model || process.env["LLM_MODEL"] || "claude", messages };
    if (Array.isArray(tools) && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = "auto";
    }

    const headers = { "content-type": "application/json", accept: "application/json" };
    // Optional bearer key (unused for the subscription CLI backend). For a real
    // key-based provider, move LLM_API_KEY to allowed_host.secrets so the JS only
    // ever sees a short-lived placeholder.
    const key = process.env["LLM_API_KEY"];
    if (key) headers.authorization = "Bearer " + key;

    let resp;
    try { resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) }); }
    catch (e) { throw `LLM request failed: ${String(e)}`; }   // network error -> transient retry

    if (resp.status === 429) {
        const text = await safeText(resp);
        return { rate_limited: { retry_after_seconds: retryAfterSeconds(resp), message: text.slice(0, 500) } };
    }
    const text = await safeText(resp);
    if (!resp.ok) throw `LLM HTTP ${resp.status}: ${text.slice(0, 1000)}`;

    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw `LLM returned non-JSON: ${text.slice(0, 500)}`; }
    const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
    const msg = choice ? choice.message : null;
    if (!msg) throw `LLM response had no choices: ${text.slice(0, 500)}`;

    const toolCalls = Array.isArray(msg.tool_calls)
        ? msg.tool_calls.map((tc, i) => ({
            id: (tc && tc.id) || ("call_" + i),
            name: (tc && tc.function && tc.function.name) || "",
            arguments_json: (tc && tc.function && tc.function.arguments) || "{}",
        }))
        : [];

    return {
        reply: {
            content: typeof msg.content === "string" ? msg.content : "",
            tool_calls: toolCalls,
            finish_reason: (choice && choice.finish_reason) || "",
        },
    };
}

function retryAfterSeconds(resp) {
    let raw = "";
    try { raw = resp.headers && resp.headers.get ? (resp.headers.get("retry-after") || "") : ""; } catch (_) {}
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 60;
}
async function safeText(resp) {
    try { return await resp.text(); } catch (_) { return ""; }
}
