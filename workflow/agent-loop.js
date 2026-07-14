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
export default function agentLoop(prompt, systemPrompt, toolsJson, model, effort) {
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
    // One long-lived operator channel for the whole run: a single named join set
    // holding exactly one outstanding injection offer at any time. Reusing one
    // join set (rather than opening a fresh 'operator' set each round) is required
    // because a named join set's name is unique for the execution's entire history
    // -- recreating it raises JoinSetCreateError::Conflict. The UI keys "your turn"
    // off the constant join name 'operator', so this needs no UI change.
    const operator = openOperator();
    try {
        let turn = 0;
        while (true) {
            if (turn >= MAX_TURNS) throw `exceeded MAX_TURNS=${MAX_TURNS} without yielding an assistant response`;
            console.log(`--- turn ${turn} ---`);
            // Non-blocking: fold in an operator message that arrived while working.
            const injected = tryTakeInjection(operator);
            if (injected !== null) {
                messages.push(userText(`[Operator message]: ${injected}`));
                turn = 0;
            }

            const reply = callLlm(system, messages, llmToolsJson, model, effort);
            turn += 1;
            messages.push({ role: 'assistant', content: reply.content });

            const calls = reply.content
                .filter((b) => b && b.type === 'tool_use')
                .map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));
            if (calls.length > 0) {
                console.log(`dispatching ${calls.length} tool call(s)`);
                const resultBlocks = calls.map((call) => {
                    const block = dispatch(call, toolsByName);
                    const status = block.is_error ? `err=${block.content.replace(/^Error:\s*/, '')}` : 'ok';
                    console.log(`  ${call.name}: ${status}`);
                    return block;
                });
                messages.push({ role: 'user', content: resultBlocks });
                continue;
            }
            console.log(`assistant response after ${turn} turns; waiting for operator input`);
            // Blocking: the run parks on the 'operator' join set -> UI shows "your turn".
            const text = takeInjection(operator);
            messages.push(userText(`[Operator message]: ${text}`));
            turn = 0;
        }
    } finally {
        try { operator.joinSet.close(); }
        catch (error) { console.log(`operator channel close failed: ${String(error)}`); }
    }
}

// One LLM call, retrying durably through an endpoint rate limit. Returns the
// assistant turn as neutral content blocks: { content: [block], stop_reason }.
function callLlm(system, messages, toolsJson, model, effort) {
    while (true) {
        const res = llm.completion(system, JSON.stringify(messages), toolsJson || '[]', model || '', effort || '');
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
    if (!tool) return toolError(call.id, `unknown tool: ${name}`);
    let params;
    try { params = encodeParams(tool.params, call.input); }
    catch (e) { return toolError(call.id, String(e)); }
    try {
        const out = obelisk.call(tool.ffqn, params);
        const s = out === undefined || out === null ? 'null' : (typeof out === 'string' ? out : JSON.stringify(out));
        return toolOk(call.id, s);
    } catch (e) { return toolError(call.id, callErrorMessage(e)); }
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
function toolOk(id, jsonString) {
    const s = typeof jsonString === 'string' ? jsonString : JSON.stringify(jsonString);
    const encoded = JSON.stringify(s).length;
    if (encoded > MAX_TOOL_RESULT_BYTES) return toolError(id, `result too large (~${encoded} encoded bytes); narrow the request with pagination or a more specific selector`);
    return { type: 'tool_result', tool_use_id: id, content: s, is_error: false };
}
function toolError(id, message) {
    return { type: 'tool_result', tool_use_id: id, content: `Error: ${message}`, is_error: true };
}

// ----- operator injection (the one built-in capability) -----------------------
// A single 'operator' join set holds one outstanding injection offer (an
// INJECTION_FFQN stub the web UI fulfils). After each message is consumed we
// re-arm a fresh offer in the SAME join set, so the workflow never recreates the
// named set (which would conflict) yet always has an offer the UI can fulfil.

function openOperator() {
    // Named so the UI can tell "waiting for the operator" (join name "operator")
    // apart from the agent actively working (completion / tool join sets).
    const joinSet = obelisk.createJoinSet({ name: 'operator' });
    const executionId = joinSet.submit(INJECTION_FFQN, []);
    console.log(`opened operator channel ${executionId}`);
    return { joinSet, executionId };
}
// Submit the next offer into the same join set after one has been taken.
function rearmOperator(operator) {
    operator.executionId = operator.joinSet.submit(INJECTION_FFQN, []);
    console.log(`re-armed operator offer ${operator.executionId}`);
}
// Non-blocking: return the injected text (re-arming the offer) or null if none.
// joinNextTry is undefined while pending, otherwise the stub's already-unwrapped
// result<string,string> ok string.
function tryTakeInjection(operator) {
    const text = operator.joinSet.joinNextTry();
    if (text === undefined) return null;
    if (typeof text !== 'string' || !text.trim()) throw 'injection text must be a non-empty string';
    console.log(`consumed operator injection from ${operator.executionId}`);
    rearmOperator(operator);
    return text.trim();
}
// Blocking: wait for the operator, return the text (re-arming the offer).
function takeInjection(operator) {
    const text = operator.joinSet.joinNext();
    if (typeof text !== 'string' || !text.trim()) throw 'injection text must be a non-empty string';
    console.log(`consumed operator injection from ${operator.executionId}`);
    rearmOperator(operator);
    return text.trim();
}

function callErrorMessage(e) {
    if (e instanceof obelisk.ChildExecutionError) {
        if (e.value !== undefined) return typeof e.value === 'string' ? e.value : JSON.stringify(e.value);
        return e.message;
    }
    return String(e);
}
