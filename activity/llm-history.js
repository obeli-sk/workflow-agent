// Rebuilds the conversation from accepted LLM executions: each one's Created
// params carry the delta it was sent, its Finished retval the assistant reply.
export async function loadMessages(historyIds, deltaJson, fetchJson) {
    const delta = parseMessages(deltaJson, "delta-json");
    if (historyIds.length === 0) return delta;

    const response = await fetchJson("/v1/executions/events/batch", { execution_ids: historyIds });
    if (!Array.isArray(response)) throw "Obelisk batch history response must be an array";
    if (response.length !== historyIds.length) throw "Obelisk batch history response has the wrong length";

    const messages = [];
    response.forEach((row, index) => {
        if (row?.execution_id !== historyIds[index]) throw `Obelisk batch history response is out of order at ${index}`;
        const entry = parseLlmExecution(row.execution_id, row.created?.event?.created, row.finished?.event?.finished);
        messages.push(...entry.delta);
        messages.push({ role: "assistant", content: entry.content });
    });
    messages.push(...delta);
    return messages;
}

function parseLlmExecution(id, created, finished) {
    if (!created || !finished) throw `LLM history execution ${id} has no Created or Finished event`;
    const params = created.params;
    const reply = finished.retval?.ok?.value?.reply;
    if (!Array.isArray(params) || params.length < 2 || !reply) throw `LLM history execution ${id} has no accepted reply`;
    return {
        delta: parseMessages(params[1], `delta of ${id}`),
        content: parseMessages(reply.content_json, `reply of ${id}`),
    };
}

function parseMessages(json, label) {
    let value;
    try { value = JSON.parse(json); }
    catch (e) { throw `${label} is not valid JSON: ${String(e)}`; }
    if (!Array.isArray(value)) throw `${label} must be an array`;
    return value;
}

export function obeliskApi() {
    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    return async (path, body) => {
        const response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
            method: "POST",
            headers: {
                accept: "application/json",
                authorization: `Bearer ${process.env["OBELISK_API_TOKEN"]}`,
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        });
        if (!response.ok) throw `Obelisk history ${path}: HTTP ${response.status}: ${await response.text()}`;
        return response.json();
    };
}
