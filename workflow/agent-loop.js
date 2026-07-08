import * as llm from 'obelisk-agent:llm/chat';

const MAX_TURNS = 30;
const MAX_TOOL_RESULT_BYTES = 96 * 1024;
const INJECTION_FFQN = 'obelisk-agent:agent/session.injection';

// The generic agent loop. It knows nothing about any specific tool: the tool
// catalog + system prompt come from a pack descriptor (resolved by the caller
// and passed in as `toolsJson`). Each tool is an ordinary deployed Obelisk
// function; the loop dispatches a tool call by encoding the model's arguments
// into positional WIT params and running obelisk.call(ffqn, params). Durable
// state is the provider-neutral message history; operator injection is the only
// built-in capability.
//
// toolsJson is a JSON array of tools:
//   { name, description, ffqn, params: [{ name, type, default? }] }
export default function agentLoop(prompt, systemPrompt, toolsJson, model) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw 'prompt is required';
    if (typeof systemPrompt !== 'string' || !systemPrompt) throw 'system prompt is required';

    let tools;
    try { tools = JSON.parse(toolsJson || '[]'); }
    catch (e) { throw `tools-json is not valid JSON: ${String(e)}`; }
    if (!Array.isArray(tools)) throw 'tools-json must be a JSON array of tools';
    const toolsByName = new Map(tools.map((t) => [t.name, t]));
    // The model-facing tool schemas, derived from each tool's WIT param specs.
    const llmToolsJson = JSON.stringify(tools.map((t) => ({
        name: t.name, description: t.description, input_schema: buildSchema(t.params),
    })));

    const system = systemPrompt;
    const messages = [userText(prompt)];
    let injection = null;
    try {
        let turn = 0;
        while (true) {
            if (turn >= MAX_TURNS) throw `exceeded MAX_TURNS=${MAX_TURNS} without yielding an assistant response`;
            console.log(`--- turn ${turn} ---`);
            const prepared = prepareInjection(injection);
            injection = prepared.injection;
            for (const text of prepared.operatorMessages) {
                messages.push(userText(`[Operator message]: ${text}`));
                turn = 0;
            }

            const reply = callLlm(system, messages, llmToolsJson, model);
            turn += 1;
            messages.push({ role: 'assistant', content: reply.content });

            const calls = reply.content
                .filter((b) => b && b.type === 'tool_use')
                .map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));
            if (calls.length > 0) {
                console.log(`dispatching ${calls.length} tool call(s)`);
                const resultBlocks = calls.map((call) => {
                    const result = dispatch(call, toolsByName);
                    console.log(`  ${call.name}: ${'ok' in result.outcome ? 'ok' : `err=${result.outcome.err}`}`);
                    return toolResultBlock(call.id, result);
                });
                messages.push({ role: 'user', content: resultBlocks });
                continue;
            }
            console.log(`assistant response after ${turn} turns; waiting for operator input`);
            const text = waitForOperatorMessage(injection);
            injection = null;
            messages.push(userText(`[Operator message]: ${text}`));
            turn = 0;
        }
    } finally {
        closeInjection(injection);
    }
}

// One LLM call, retrying durably through an endpoint rate limit. Returns the
// assistant turn as neutral content blocks: { content: [block], stop_reason }.
function callLlm(system, messages, toolsJson, model) {
    while (true) {
        const res = llm.completion(system, JSON.stringify(messages), toolsJson || '[]', model || '');
        if (res && res.rate_limited) {
            const seconds = res.rate_limited.retry_after_seconds > 0 ? res.rate_limited.retry_after_seconds : 1;
            console.log(`rate limited (${res.rate_limited.message}); sleeping ${seconds}s`);
            obelisk.sleep({ seconds });
            continue;
        }
        if (res && res.reply) {
            let content;
            try { content = JSON.parse(res.reply.content_json); }
            catch (e) { throw `llm reply content_json is not valid JSON: ${String(e)}`; }
            if (!Array.isArray(content)) throw 'llm reply content must be a JSON array of blocks';
            return { content, stop_reason: res.reply.stop_reason };
        }
        throw `unexpected llm.completion result: ${JSON.stringify(res)}`;
    }
}

// ----- generic tool dispatch --------------------------------------------------

// Run one tool call: encode the model's arguments into positional WIT params
// from the tool's declared spec and obelisk.call the tool's ffqn. The decoded
// WIT result is stringified for the model.
function dispatch(call, toolsByName) {
    const name = call.name;
    const tool = toolsByName.get(name);
    if (!tool) return err(name, `unknown tool: ${name}`);
    let params;
    try { params = encodeParams(tool.params, call.input); }
    catch (e) { return err(name, String(e)); }
    try {
        const out = obelisk.call(tool.ffqn, params);
        const s = out === undefined || out === null ? 'null' : (typeof out === 'string' ? out : JSON.stringify(out));
        return ok(name, s);
    } catch (e) { return err(name, String(e)); }
}

// Build the positional WIT param array from the model's argument object.
function encodeParams(specs, input) {
    const obj = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
    return (specs || []).map((spec) => {
        const has = Object.prototype.hasOwnProperty.call(obj, spec.name);
        const value = has ? obj[spec.name] : spec.default;
        return coerce(spec.type, value);
    });
}

// Coerce a JSON value to the shape Obelisk expects for a WIT type.
function coerce(type, v) {
    if (type.startsWith('option<')) {
        if (v === undefined || v === null) return null;
        return coerce(type.slice(7, -1), v);
    }
    if (type.startsWith('list<')) {
        const inner = type.slice(5, -1);
        return Array.isArray(v) ? v.map((x) => coerce(inner, x)) : [];
    }
    switch (type) {
        case 'bool': return Boolean(v);
        case 'u32': case 'u64': case 's32': case 's64': return intOr(v, 0);
        case 'f32': case 'f64': { const n = Number(v); return Number.isFinite(n) ? n : 0; }
        case 'string': return v === undefined || v === null ? '' : String(v);
        default: return (v && typeof v === 'object') ? v : (v === undefined ? null : v); // record / other
    }
}
function intOr(v, d) { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : d; }

// Build a JSON Schema (for the model) from the tool's WIT param specs. A param
// is required when it is not option<> and carries no default.
function buildSchema(specs) {
    const properties = {};
    const required = [];
    for (const spec of specs || []) {
        properties[spec.name] = { type: jsonType(spec.type) };
        const optional = spec.type.startsWith('option<') || spec.default !== undefined;
        if (!optional) required.push(spec.name);
    }
    return { type: 'object', properties, required };
}
function jsonType(t) {
    if (t.startsWith('option<')) return jsonType(t.slice(7, -1));
    if (t.startsWith('list<')) return 'array';
    if (t === 'bool') return 'boolean';
    if (t === 'u32' || t === 'u64' || t === 's32' || t === 's64') return 'integer';
    if (t === 'f32' || t === 'f64') return 'number';
    if (t === 'string') return 'string';
    return 'object';
}

// ----- messages ---------------------------------------------------------------

function userText(text) {
    return { role: 'user', content: [{ type: 'text', text }] };
}
function toolResultBlock(id, result) {
    const isOk = 'ok' in result.outcome;
    return { type: 'tool_result', tool_use_id: id, content: isOk ? result.outcome.ok : `Error: ${result.outcome.err}`, is_error: !isOk };
}
function ok(name, jsonString) {
    const s = typeof jsonString === 'string' ? jsonString : JSON.stringify(jsonString);
    const encoded = JSON.stringify(s).length;
    if (encoded > MAX_TOOL_RESULT_BYTES) return err(name, `result too large (~${encoded} encoded bytes); narrow the request with pagination or a more specific selector`);
    return { name, outcome: { ok: s } };
}
function err(name, message) { return { name, outcome: { err: message } }; }

// ----- operator injection (the one built-in capability) -----------------------

function prepareInjection(injection) {
    let current = injection || openInjection();
    // joinNextTry is non-blocking: undefined while pending, otherwise the child's
    // already-unwrapped return value (here the result<string,string> ok string).
    const text = current.joinSet.joinNextTry();
    if (text === undefined) return { injection: current, operatorMessages: [] };
    if (typeof text !== 'string' || !text.trim()) throw 'injection text must be a non-empty string';
    console.log(`consumed operator injection from ${current.executionId}`);
    current.joinSet.close();
    current = openInjection();
    return { injection: current, operatorMessages: [text.trim()] };
}
function openInjection() {
    const joinSet = obelisk.createJoinSet();
    const executionId = joinSet.submit(INJECTION_FFQN, []);
    console.log(`opened operator injection ${executionId}`);
    return { joinSet, executionId };
}
function closeInjection(injection) {
    if (injection === null) return;
    try { injection.joinSet.close(); }
    catch (error) { console.log(`injection close failed: ${String(error)}`); }
}
function waitForOperatorMessage(injection) {
    if (injection === null) throw 'operator injection is not open';
    // joinNext blocks and returns a response descriptor { type, id, ok }, NOT the
    // value (unlike joinNextTry). Fetch the unwrapped string with getResult.
    injection.joinSet.joinNext();
    const text = obelisk.getResult(injection.executionId);
    if (typeof text !== 'string' || !text.trim()) throw 'injection text must be a non-empty string';
    console.log(`consumed operator injection from ${injection.executionId}`);
    injection.joinSet.close();
    return text.trim();
}
