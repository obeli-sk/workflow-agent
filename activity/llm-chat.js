// Multi-provider LLM client. Speaks a provider-neutral message model (see below)
// and routes each request to the correct wire API based on the model catalog in
// the AGENT_MODELS env var. There are no exec activities; the model always lives
// behind an HTTP endpoint.
//
// obelisk-agent:llm/chat.completion:
//   func(system: string, messages-json: string, tools-json: string, model: string, effort: string)
//     -> result<variant {
//          reply(record { content-json: string, stop-reason: string }),
//          rate-limited(record { retry-after-seconds: u32, message: string }),
//        }, string>
//
// Neutral wire types (JSON):
//   message      = { role: "user"|"assistant", content: [block] }
//   block(text)  = { type: "text", text }
//   block(use)   = { type: "tool_use", id, name, input }          // input: object
//   block(result)= { type: "tool_result", tool_use_id, content, is_error? }
//   tool         = { name, description, input_schema }            // input_schema: JSON Schema
//   reply.content-json = JSON array of assistant blocks (text + tool_use)
//   stop-reason  = "end_turn" | "tool_use" | "max_tokens" | "other"
//
// A throw becomes the err arm (hard failure; Obelisk retries per max_retries).
// A 429 is returned in-band as `rate-limited` so the workflow can durably sleep.

const DEFAULT_MAX_TOKENS = 8192;

export default async function completion(system, messagesJson, toolsJson, model, effort) {
    const messages = parseJson(messagesJson, 'messages-json', []);
    const tools = parseJson(toolsJson, 'tools-json', []);
    const cfg = resolveModel(model);
    const level = resolveEffort(effort);
    const toolNames = buildToolNames(tools);

    let result;
    if (cfg.api_type === 'anthropic-messages') result = await callAnthropic(cfg, system, messages, tools, toolNames, level);
    else if (cfg.api_type === 'openai-chat-completions') result = await callOpenAIChat(cfg, system, messages, tools, toolNames, level);
    else if (cfg.api_type === 'openai-responses') result = await callOpenAIResponses(cfg, system, messages, tools, toolNames, level);
    else throw `unknown api_type '${cfg.api_type}' for model '${cfg.id}'`;

    if (result.rate_limited) return { rate_limited: result.rate_limited };
    return { reply: { content_json: JSON.stringify(result.content), stop_reason: result.stop_reason } };
}

// ----- model catalog ----------------------------------------------------------

// AGENT_MODELS is a JSON array of { id, label, api_type, base_url, wire_model,
// auth_header?, auth_value?, max_tokens? }. The requested model id selects one
// entry; an empty id selects the first. base_url is the origin (+ provider path);
// each adapter appends its route.
function resolveModel(model) {
    const raw = process.env['AGENT_MODELS'];
    if (!raw) throw 'AGENT_MODELS is not configured';
    let catalog;
    try { catalog = JSON.parse(raw); }
    catch (e) { throw `AGENT_MODELS is not valid JSON: ${String(e)}`; }
    if (!Array.isArray(catalog) || catalog.length === 0) throw 'AGENT_MODELS must be a non-empty JSON array';
    const id = typeof model === 'string' ? model.trim() : '';
    const cfg = id ? catalog.find((m) => m && m.id === id) : catalog[0];
    if (!cfg) throw `model '${id}' is not in AGENT_MODELS`;
    if (!cfg.api_type || !cfg.base_url) throw `model '${cfg.id || id}' is missing api_type or base_url`;
    return cfg;
}

function baseOf(cfg) { return String(cfg.base_url).replace(/\/$/, ''); }
function wireModel(cfg) { return cfg.wire_model || cfg.id; }
function maxTokens(cfg) { return Number.isFinite(cfg.max_tokens) && cfg.max_tokens > 0 ? Math.trunc(cfg.max_tokens) : DEFAULT_MAX_TOKENS; }

// Auth is configured per model: send header `auth_header` with `auth_value`.
// auth_value may embed ${ENV_VAR} references; each is replaced with that env
// var's value, which under Obelisk is a short-lived placeholder the runtime swaps
// for the real secret in the outbound header (allowed_host.secrets). A literal
// value (e.g. the exe.dev gateway's public "implicit" token) needs no env var or
// secret. Omit both => no auth header (keyless endpoint, e.g. the local backend).
function applyAuth(cfg, headers) {
    if (!cfg.auth_header || cfg.auth_value == null) return;
    headers[String(cfg.auth_header).toLowerCase()] =
        String(cfg.auth_value).replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
}

// ----- reasoning effort -------------------------------------------------------

// `effort` is a user-facing reasoning level (shelley vocabulary). One of
// minimal|low|medium|high|xhigh enables extended thinking; anything else (empty,
// "off", "default", unknown) omits the field so the provider uses its own
// default. Each adapter maps the resolved level onto its own wire shape.
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
function resolveEffort(effort) {
    const e = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
    return EFFORTS.has(e) ? e : '';
}
// Anthropic budget_tokens per level (legacy non-adaptive models); xhigh clamps to
// the high budget since budget-style APIs have no xhigh tier.
const ANTHROPIC_BUDGET = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 16384 };
// Claude Opus 4.7+ / Sonnet 5 / Fable 5 require adaptive thinking (output_config
// effort) instead of a token budget. Match on '-'/'.'-delimited tokens so dated
// snapshots ("claude-opus-4-8-20260115") and provider-qualified names
// ("us.anthropic.claude-opus-4-8-v1:0") are covered without false positives.
const ADAPTIVE_MODELS = ['claude-fable-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7'];
function useAdaptiveThinking(model) {
    const m = '-' + String(model).replace(/\./g, '-') + '-';
    return ADAPTIVE_MODELS.some((name) => m.includes('-' + name + '-'));
}
// Set extended-thinking fields for the requested level. Adaptive models take
// output_config.effort; budget models take thinking.budget_tokens and require
// max_tokens > budget_tokens, so bump max_tokens if needed.
function applyAnthropicThinking(body, model, level) {
    if (!level) return;
    if (useAdaptiveThinking(model)) {
        body.thinking = { type: 'adaptive' };
        body.output_config = { effort: level };
        return;
    }
    const budget = ANTHROPIC_BUDGET[level];
    if (body.max_tokens <= budget) body.max_tokens = budget + 1024;
    body.thinking = { type: 'enabled', budget_tokens: budget };
}
// chat/completions reasoning_effort accepts low|medium|high on many backends;
// clamp the finer levels the other APIs allow.
function chatEffort(level) {
    if (level === 'minimal') return 'low';
    if (level === 'xhigh') return 'high';
    return level;
}

// ----- anthropic messages -----------------------------------------------------

async function callAnthropic(cfg, system, messages, tools, toolNames, level) {
    const body = {
        model: wireModel(cfg),
        max_tokens: maxTokens(cfg),
        messages: encodeMessages(messages, toolNames),
    };
    applyAnthropicThinking(body, wireModel(cfg), level);
    if (system) body.system = system;
    if (tools.length > 0) body.tools = tools.map((t) => ({ name: toolNames.encode(t.name), description: t.description, input_schema: t.input_schema }));

    const headers = { 'content-type': 'application/json', accept: 'application/json', 'anthropic-version': '2023-06-01' };
    applyAuth(cfg, headers);

    const { data, rate_limited } = await post(`${baseOf(cfg)}/v1/messages`, headers, body);
    if (rate_limited) return { rate_limited };

    const content = [];
    for (const block of arr(data.content)) {
        if (block.type === 'text') content.push({ type: 'text', text: String(block.text || '') });
        else if (block.type === 'tool_use') content.push({ type: 'tool_use', id: block.id, name: toolNames.decode(block.name), input: block.input || {} });
    }
    return { content, stop_reason: normalizeStop(data.stop_reason) };
}

// ----- openai chat completions ------------------------------------------------

async function callOpenAIChat(cfg, system, messages, tools, toolNames, level) {
    const wire = [];
    if (system) wire.push({ role: 'system', content: system });
    for (const msg of messages) {
        if (msg.role === 'assistant') {
            const text = textOf(msg);
            const toolCalls = blocks(msg, 'tool_use').map((b) => ({
                id: b.id, type: 'function', function: { name: toolNames.encode(b.name), arguments: JSON.stringify(b.input || {}) },
            }));
            const out = { role: 'assistant', content: text || null };
            if (toolCalls.length > 0) out.tool_calls = toolCalls;
            wire.push(out);
        } else {
            // A user message may carry text and/or tool_result blocks. Tool results
            // become separate role:"tool" messages in chat completions.
            const text = textOf(msg);
            if (text) wire.push({ role: 'user', content: text });
            for (const b of blocks(msg, 'tool_result')) {
                wire.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content || '') });
            }
        }
    }

    const body = { model: wireModel(cfg), messages: wire };
    if (level) body.reasoning_effort = chatEffort(level);
    if (tools.length > 0) {
        body.tools = tools.map((t) => ({ type: 'function', function: { name: toolNames.encode(t.name), description: t.description, parameters: t.input_schema } }));
        body.tool_choice = 'auto';
    }

    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    applyAuth(cfg, headers);

    const { data, rate_limited } = await post(`${baseOf(cfg)}/v1/chat/completions`, headers, body);
    if (rate_limited) return { rate_limited };

    const choice = arr(data.choices)[0];
    const message = choice ? choice.message : null;
    if (!message) throw `chat response had no choices: ${JSON.stringify(data).slice(0, 500)}`;
    const content = [];
    if (typeof message.content === 'string' && message.content) content.push({ type: 'text', text: message.content });
    for (const tc of arr(message.tool_calls)) {
        content.push({ type: 'tool_use', id: tc.id || '', name: toolNames.decode(tc.function?.name || ''), input: parseArgs(tc.function?.arguments) });
    }
    return { content, stop_reason: normalizeStop(choice?.finish_reason) };
}

// ----- openai responses -------------------------------------------------------

async function callOpenAIResponses(cfg, system, messages, tools, toolNames, level) {
    const input = [];
    for (const msg of messages) {
        const text = textOf(msg);
        if (msg.role === 'assistant') {
            if (text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
            for (const b of blocks(msg, 'tool_use')) {
                input.push({ type: 'function_call', call_id: b.id, name: toolNames.encode(b.name), arguments: JSON.stringify(b.input || {}) });
            }
        } else {
            if (text) input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
            for (const b of blocks(msg, 'tool_result')) {
                input.push({ type: 'function_call_output', call_id: b.tool_use_id, output: String(b.content || '') });
            }
        }
    }

    const body = { model: wireModel(cfg), input };
    if (level) {
        // gpt-5.x-codex rejects reasoning.effort="minimal" (HTTP 400); clamp to low.
        const effort = level === 'minimal' && /codex/.test(wireModel(cfg)) ? 'low' : level;
        body.reasoning = { effort };
    }
    if (system) body.instructions = system;
    if (tools.length > 0) {
        body.tools = tools.map((t) => ({ type: 'function', name: toolNames.encode(t.name), description: t.description, parameters: t.input_schema }));
        body.tool_choice = 'auto';
    }

    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    applyAuth(cfg, headers);

    const { data, rate_limited } = await post(`${baseOf(cfg)}/v1/responses`, headers, body);
    if (rate_limited) return { rate_limited };

    const content = [];
    let sawToolCall = false;
    for (const item of arr(data.output)) {
        if (item.type === 'function_call') {
            sawToolCall = true;
            content.push({ type: 'tool_use', id: item.call_id || item.id || '', name: toolNames.decode(item.name || ''), input: parseArgs(item.arguments) });
        } else if (item.type === 'message') {
            for (const c of arr(item.content)) {
                if (c.type === 'output_text' && c.text) content.push({ type: 'text', text: String(c.text) });
            }
        }
    }
    const stop = sawToolCall ? 'tool_use' : (data.status === 'incomplete' ? 'max_tokens' : 'end_turn');
    return { content, stop_reason: stop };
}

// ----- http + helpers ---------------------------------------------------------

async function post(url, headers, body) {
    let resp;
    console.debug(`Fetching from ${url}`);
    try { resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }); }
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
    return { data };
}

function parseJson(text, label, fallback) {
    if (!text) return fallback;
    try { return JSON.parse(text); }
    catch (e) { throw `${label} is not valid JSON: ${String(e)}`; }
}
function parseArgs(text) {
    if (typeof text !== 'string' || !text) return {};
    try { return JSON.parse(text); } catch (_) { return {}; }
}
function arr(v) { return Array.isArray(v) ? v : []; }
function blocks(msg, type) { return arr(msg && msg.content).filter((b) => b && b.type === type); }
function textOf(msg) { return blocks(msg, 'text').map((b) => String(b.text || '')).join(''); }
function encodeMessages(messages, toolNames) {
    return arr(messages).map((msg) => ({
        ...msg,
        content: arr(msg.content).map((block) => {
            if (!block || block.type !== 'tool_use') return block;
            return { ...block, name: toolNames.encode(block.name) };
        }),
    }));
}
function buildToolNames(tools) {
    const originalToWire = new Map();
    const aliasCandidates = new Map();
    const aliases = new Map();
    const used = new Set();

    for (const tool of arr(tools)) {
        const original = String(tool?.name || '');
        if (!original) continue;
        let wire = safeToolName(original);
        let n = 2;
        while (used.has(wire)) {
            const suffix = '_' + n++;
            wire = safeToolName(original, suffix);
        }
        used.add(wire);
        originalToWire.set(original, wire);
        addAlias(aliasCandidates, original, original);
        addAlias(aliasCandidates, wire, original);
        const tail = original.split('.').pop();
        addAlias(aliasCandidates, tail, original);
        addAlias(aliasCandidates, safeToolName(tail), original);
    }

    for (const [alias, originals] of aliasCandidates) {
        if (originals.size === 1) aliases.set(alias, Array.from(originals)[0]);
    }

    return {
        encode(name) { return originalToWire.get(String(name || '')) || safeToolName(String(name || '')); },
        decode(name) { return aliases.get(String(name || '')) || String(name || ''); },
    };
}
function addAlias(map, alias, original) {
    if (!alias) return;
    let originals = map.get(alias);
    if (!originals) {
        originals = new Set();
        map.set(alias, originals);
    }
    originals.add(original);
}
function safeToolName(name, suffix = '') {
    let base = String(name || '').replace(/[^A-Za-z0-9_-]/g, '_');
    if (!base) base = 'tool';
    const maxBase = 64 - suffix.length;
    if (base.length > maxBase) base = base.slice(0, Math.max(1, maxBase));
    return base + suffix;
}
function normalizeStop(reason) {
    switch (reason) {
        case 'tool_use': case 'tool_calls': return 'tool_use';
        case 'end_turn': case 'stop': return 'end_turn';
        case 'max_tokens': case 'length': return 'max_tokens';
        default: return 'other';
    }
}
function retryAfterSeconds(resp) {
    let raw = '';
    try { raw = resp.headers && resp.headers.get ? (resp.headers.get('retry-after') || '') : ''; } catch (_) { }
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 60;
}
async function safeText(resp) {
    try { return await resp.text(); } catch (_) { return ''; }
}
