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

// AGENT_MODELS is a JSON array of { id, label, api_type, path?, wire_model,
// max_tokens? }. The requested model id selects one entry; an empty id selects
// the first. The endpoint origin is shared across the whole catalog and comes
// from LLM_BASE_URL; each model's optional `path` is a provider prefix appended
// to it (e.g. "/gateway/llm/anthropic"), and each adapter appends its own route
// (/v1/messages, /v1/chat/completions, /v1/responses).
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
    if (!cfg.api_type) throw `model '${cfg.id || id}' is missing api_type`;
    return cfg;
}

// The endpoint origin, shared by every model in the catalog. A single catalog
// targets a single endpoint (gateway, OpenRouter, or the local backend); switch
// endpoints by switching both AGENT_MODELS and LLM_BASE_URL together.
function endpointBase() {
    const base = process.env['LLM_BASE_URL'];
    if (!base) throw 'LLM_BASE_URL is not configured';
    return String(base).replace(/\/$/, '');
}
function pathOf(cfg) {
    const p = cfg.path ? String(cfg.path).trim() : '';
    if (!p) return '';
    return (p.startsWith('/') ? p : '/' + p).replace(/\/$/, '');
}
function baseOf(cfg) { return endpointBase() + pathOf(cfg); }
function wireModel(cfg) { return cfg.wire_model || cfg.id; }
function maxTokens(cfg) { return Number.isFinite(cfg.max_tokens) && cfg.max_tokens > 0 ? Math.trunc(cfg.max_tokens) : DEFAULT_MAX_TOKENS; }

// Auth is one shared bearer token for the whole endpoint: send
// `Authorization: Bearer ${LLM_API_KEY}`. Under Obelisk LLM_API_KEY is a
// short-lived placeholder the runtime swaps for the real secret in the outbound
// header (allowed_host.secrets). Unset => no auth header (keyless local backend).
function applyAuth(headers) {
    const key = process.env['LLM_API_KEY'];
    if (key) headers['authorization'] = `Bearer ${key}`;
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
    applyAuth(headers);

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
    applyAuth(headers);

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

    // store:false keeps the call stateless (we resend the full input each turn and
    // never fetch a stored response); stream:true returns the answer as SSE, which
    // some gateways require. Both are rejected as HTTP 400 otherwise on exe.dev.
    const body = { model: wireModel(cfg), input, store: false, stream: true };
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

    const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
    applyAuth(headers);

    const { data, rate_limited } = await postResponsesStream(`${baseOf(cfg)}/v1/responses`, headers, body);
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

// Fetch and return the raw response body text, or `rate_limited` on 429. A
// non-2xx status other than 429 is a hard error (Obelisk retries per max_retries).
async function postRaw(url, headers, body) {
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
    return { text };
}

async function post(url, headers, body) {
    const { text, rate_limited } = await postRaw(url, headers, body);
    if (rate_limited) return { rate_limited };
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw `LLM returned non-JSON: ${text.slice(0, 500)}`; }
    return { data };
}

// The Responses API is called with stream:true, so the body is an SSE stream of
// `data: {json}` lines. Every response.* lifecycle event carries the full
// response object under `.response`; the terminal one (response.completed /
// .incomplete / .failed) has the final output array and status, so return the
// last such object for the non-streaming parser above to read.
async function postResponsesStream(url, headers, body) {
    const { text, rate_limited } = await postRaw(url, headers, body);
    if (rate_limited) return { rate_limited };
    let data = null;
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(payload); } catch (_) { continue; }
        if (evt && evt.response && typeof evt.type === 'string' && evt.type.startsWith('response.')) data = evt.response;
    }
    if (!data) throw `LLM stream had no response event: ${text.slice(0, 500)}`;
    if (data.status === 'failed') throw `LLM stream failed: ${JSON.stringify(data.error || {}).slice(0, 500)}`;
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
