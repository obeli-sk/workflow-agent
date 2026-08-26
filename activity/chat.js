// obelisk-agent:programs/program.chat:
//   func(stdin: string, args: list<string>)
//     -> result<record { stdout: string, stderr: string, exit-code: u32 }, string>
//
// Discover, inspect, message, and create peer workflow-agent sessions on this
// Obelisk instance (OBELISK_API_URL, the agent's own instance, never the
// target). Errors are returned as nonzero exits rather than thrown, so the
// command is deterministic under replay and never retried into double-sends.
//
// `current`, `rename`, and (by default) `create` are intercepted by the session
// workflow itself, which knows things this activity cannot: which session is
// calling, its slug, and how to schedule child executions. This file still
// documents them in the help output and implements the --top-level create
// fallback.

const RUN_FFQN = "obelisk-agent:workflow/workflow.run-cancellable";
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 200;
const RESPONSE_PAGE = 200;
const MAX_RESPONSE_PAGES = 10;
const LATEST_WINDOW = 100;
const SEND_ATTEMPTS = 4;
const SEND_RETRY_MS = 500;
const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const BLOCK_CHAR_LIMIT = 4000;

// Distinguishes caller mistakes (exit 2, like curl's argument errors) from
// runtime failures (exit 1).
class UsageError extends Error {}

export default async function chat(stdin, args) {
    try {
        return await dispatch(
            typeof stdin === "string" ? stdin : "",
            Array.isArray(args) ? args.map(String) : [],
        );
    } catch (error) {
        if (error instanceof UsageError) return usage(message(error));
        return fail(1, `chat: ${message(error)}\n`);
    }
}

async function dispatch(stdin, args) {
    const [sub, rest] = [args[0], args.slice(1)];
    if (!sub || sub === "--help" || sub === "-h") return ok(help());
    if (rest.includes("--help") || rest.includes("-h")) return ok(commandHelp(sub));
    switch (sub) {
        case "models": return cmdModels(rest);
        case "list": return cmdList(rest);
        case "read": return cmdRead(rest);
        case "state": return cmdState(rest);
        case "send": return cmdSend(stdin, rest);
        case "create": return cmdCreate(stdin, rest);
        // Answered by the session workflow wrapper (see session.rs); reaching
        // this activity means there is no wrapping session to report or rename.
        case "current":
        case "rename":
            return fail(2, `chat: '${sub}' is answered by the session workflow and is unavailable here\n`);
        default: return usage(`unknown command '${sub}'`);
    }
}

// ----- subcommands ------------------------------------------------------------

function cmdModels(args) {
    const parsed = parseFlags(args);
    if (parsed.positional.length > 0) throw new UsageError("'models' takes no arguments");
    const catalog = loadCatalog();
    if (parsed.json) return ok(JSON.stringify(catalog, null, 2) + "\n");
    const lines = catalog.map((m) => `${m.id}\t${m.label}\t${m.api_type}`);
    return ok(lines.join("\n") + (lines.length ? "\n" : ""));
}

async function cmdList(args) {
    const parsed = parseFlags(args);
    if (parsed.positional.length > 0) throw new UsageError("'list' takes no positional arguments");
    if (parsed.all && parsed.limit !== null) {
        throw new UsageError("--limit and --all are mutually exclusive");
    }
    const length = parsed.all ? MAX_LIST_LIMIT : parsed.limit ?? DEFAULT_LIST_LIMIT;
    const executions = await apiJson(
        "GET",
        `/v1/executions?ffqn_prefix=${encodeURIComponent(RUN_FFQN)}&show_derived=true&length=${length}`,
    );
    // The activity runtime services outbound requests one at a time; every
    // fetch in this program is awaited sequentially.
    const rows = [];
    for (const exec of executions ?? []) rows.push(await describeRun(exec));
    if (parsed.json) return ok(JSON.stringify(rows, null, 2) + "\n");
    const lines = rows.map((r) => [
        r.id,
        r.created_at,
        r.status + (r.working ? "/working" : ""),
        r.name ?? "-",
        r.prompt_preview || "-",
    ].join("  "));
    return ok(lines.join("\n") + (lines.length ? "\n" : ""));
}

function cmdRead(args) {
    const parsed = parseFlags(args);
    if (parsed.positional.length < 1) throw new UsageError("session id is required");
    if (parsed.positional.length > 1) throw new UsageError("exactly one session id is expected");
    if (Number.isInteger(parsed.tail) && Number.isInteger(parsed.turn)) {
        throw new UsageError("--tail and --turn are mutually exclusive");
    }
    return cmdReadBody(parsed.positional[0], parsed.tail, parsed.turn, parsed.json, parsed.system);
}

async function cmdReadBody(id, tail, turn, json, system) {
    const walked = await walkResponses(id);
    const status = await fetchStatus(id);
    let events = walked.events;
    if (Number.isInteger(turn)) {
        // Just that turn's events: what `chat state`'s last_reply points at.
        events = events.filter((ev) => ev.turn_index === turn);
    } else {
        const maxTurn = events.reduce((acc, ev) => Math.max(acc, ev.turn_index ?? -1), -1);
        if (maxTurn >= 0 && Number.isInteger(tail)) {
            const floor = maxTurn - tail + 1;
            events = events.filter((ev) => ev.turn_index === null || ev.turn_index >= floor);
        }
    }
    const started = walked.sessionStarted ?? {};
    if (json) {
        const projection = {
            id,
            status: status?.pending_state?.status ?? "unknown",
            working: walked.working === true,
            backend: started.backend ?? null,
            effort: started.effort ?? null,
            name: walked.name ?? null,
            prompt: started.prompt ?? null,
            events,
        };
        if (system) projection.system_prompt = started.system_prompt ?? null;
        return ok(JSON.stringify(projection, null, 2) + "\n");
    }
    const head = [
        `run ${id}`,
        `state ${status?.pending_state?.status ?? "unknown"}`
            + `, working ${walked.working ? "yes" : "no"}`
            + (started.backend ? `, backend ${started.backend}` : "")
            + (started.effort ? `, effort ${started.effort}` : "")
            + (walked.name ? `, name ${walked.name}` : ""),
    ];
    if (started.prompt) head.push(`prompt ${truncate(started.prompt, 400)}`);
    if (system && started.system_prompt) head.push(`system prompt ${block(started.system_prompt)}`);
    const body = events.map((ev) => renderEvent(ev)).filter(Boolean).join("\n");
    return ok(head.join("\n") + "\n\n" + body + (body ? "\n" : ""));
}

function cmdState(args) {
    const parsed = parseFlags(args);
    if (parsed.positional.length !== 1) throw new UsageError("exactly one session id is required");
    return cmdStateBody(parsed.positional[0], parsed.json);
}

async function cmdStateBody(id, json) {
    const walked = await walkResponses(id);
    const status = await fetchStatus(id);
    const started = walked.sessionStarted ?? {};
    const replyTurn = lastReplyTurn(walked.events);
    const state = {
        id,
        status: status?.pending_state?.status ?? "unknown",
        join_name: joinName(status?.pending_state?.join_set_id),
        working: walked.working === true,
        turn_index: latestTurnIndex(walked.events),
        // Sessions stay parked on an input offer after their final answer, so
        // this says whether a finished assistant message was actually written
        // and where; `chat read ID --turn N` prints just that message.
        last_reply: replyTurn === null ? null : { turn: replyTurn },
        pending_offer_id: walked.inputOffer?.id ?? null,
        backend: started.backend ?? null,
        effort: started.effort ?? null,
        name: walked.name ?? null,
    };
    return ok(json ? JSON.stringify(state, null, 2) + "\n" : JSON.stringify(state) + "\n");
}

async function cmdSend(stdin, args) {
    const parsed = parseFlags(args);
    if (parsed.positional.length < 1) throw new UsageError("session id is required");
    if (parsed.positional.length < 2 && !stdin.trim()) {
        throw new UsageError("message text is required (as arguments or on stdin)");
    }
    const [id, ...words] = parsed.positional;
    const text = (words.length > 0 ? words.join(" ") : stdin).trim();

    let staleRetries = 0;
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
        const offerId = await findOpenOffer(id);
        if (!offerId) {
            // Offers rotate every turn; a just-finished turn leaves a short gap.
            if (attempt < SEND_ATTEMPTS) { await sleepMs(SEND_RETRY_MS); continue; }
            return fail(1, `chat: no open input offer for ${id}; `
                + "the session may be between turns, retry shortly\n");
        }
        const outcome = await putStub(offerId, { ok: { prompt: { id: uniqueId(), text } } });
        if (outcome === "ok") return ok(`sent to ${id} (offer ${offerId})\n`);
        if (outcome === "stale" && ++staleRetries >= 2) break;
        await sleepMs(SEND_RETRY_MS);
    }
    return fail(1, `chat: could not deliver to ${id}; the session is mid-turn `
        + "or between offers, retry shortly\n");
}

async function cmdCreate(stdin, args) {
    const parsed = parseFlags(args);
    const prompt = (parsed.positional.length > 0 ? parsed.positional.join(" ") : stdin).trim();
    let effort = parsed.effort;
    if (effort !== null) {
        effort = effort.trim();
        if (!EFFORTS.includes(effort)) {
            throw new UsageError(`--effort must be one of: ${EFFORTS.join("|")}`);
        }
    }
    if (parsed.name !== null && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(parsed.name)) {
        throw new UsageError("--name must be a slug: lowercase letters, digits, inner dashes");
    }
    // Only reached outside a wrapping session (or for --top-level): the
    // workflow intercepts create to schedule child sessions durably.
    const params = [prompt, parsed.model, null, effort, parsed.name];
    const body = (await apiText("POST", "/v1/executions", { ffqn: RUN_FFQN, params })).trim();
    let execId = body;
    try {
        const parsed = JSON.parse(body);
        // With an Accept: application/json header the server wraps the id.
        if (parsed && typeof parsed === "object" && typeof parsed.ok === "string") execId = parsed.ok;
    } catch (_) { /* plain-text body */ }
    return ok(`${execId}\n`);
}

// ----- session projection -----------------------------------------------------

async function describeRun(exec) {
    const id = exec.execution_id;
    const status = exec.pending_state?.status ?? "unknown";
    const join = joinName(exec.pending_state?.join_set_id);
    let working = false;
    let prompt_preview = "";
    try {
        const latest = await latestResponses(id);
        const created = await createdParams(id);
        let needWorking = true;
        scanBackward(latest, (value) => {
            if (needWorking && typeof value.agent_status?.working === "boolean") {
                working = value.agent_status.working;
                needWorking = false;
            }
            return !needWorking;
        });
        const prompt = created?.prompt ?? "";
        prompt_preview = prompt.length > 120 ? prompt.substring(0, 120) + "..." : prompt;
    } catch (_) {
        // A run whose children were reaped still lists, minus extras.
    }
    const name = await latestSessionName(id);
    // The user join set races input against completion, so being parked there
    // does not distinguish waiting from thinking; agent_status does.
    const effectiveWorking = status === "blocked_by_join_set" && join === "user" && working;
    return { id, created_at: exec.created_at ?? "", status, join_name: join, working: effectiveWorking, name, prompt_preview };
}

// Walks the whole session-events stream forward, bounded by MAX_RESPONSE_PAGES;
// projects it like webhook/lib/responses.js.
async function walkResponses(executionId) {
    const events = [];
    let sessionStarted;
    let inputOffer;
    let working = false;
    let name = null;
    let cursor = 0;
    let including = true;
    for (let page = 0; page < MAX_RESPONSE_PAGES; page++) {
        const payload = await apiJson(
            "GET",
            `/v1/executions/${encodeURIComponent(executionId)}/responses`
            + `?join_set=session-events&cursor=${cursor}&including_cursor=${including}`
            + `&length=${RESPONSE_PAGE}`,
        );
        for (const r of payload.responses ?? []) {
            const value = responseValue(r);
            if (!value) continue;
            if (value.session_started) sessionStarted = projectSessionStarted(value.session_started);
            else if (value.input_offered) {
                inputOffer = {
                    id: strOr(value.input_offered.execution_id),
                    turn_index: intOrNull(value.input_offered.turn_index),
                };
            } else if (value.agent_status) working = value.agent_status.working === true;
            else if (value.session_renamed) name = strOr(value.session_renamed.name);
            const event = projectEvent(value, createdAtOf(r));
            if (event) events.push(event);
        }
        const next = payload.scan_cursor;
        if (typeof next !== "number" || next <= cursor) break;
        cursor = next;
        including = false;
        if (typeof payload.max_cursor === "number" && cursor >= payload.max_cursor) break;
    }
    // Renames publish on their own join set now; the in-stream variant only
    // exists on pre-protocol-7 sessions.
    name = (await latestSessionName(executionId)) ?? name;
    return { events, sessionStarted, inputOffer, working, name };
}

// The current slug straight off the dedicated rename join set; renames are
// rare, so the newest-first read covers it with one response (pagination
// applies after the join-set filter).
async function latestSessionName(executionId) {
    try {
        const payload = await apiJson(
            "GET",
            `/v1/executions/${encodeURIComponent(executionId)}/responses`
            + `?join_set=session-name&direction=older&length=1`,
        );
        const value = responseValue(payload.responses?.[0]);
        if (typeof value?.name === "string") return value.name;
        if (typeof value?.session_renamed?.name === "string") {
            return value.session_renamed.name;
        }
    } catch (_) { /* fall through */ }
    return null;
}

// Newest-first single window over the tail of the stream.
async function latestResponses(executionId) {
    return apiJson(
        "GET",
        `/v1/executions/${encodeURIComponent(executionId)}/responses`
        + `?join_set=session-events&direction=older&length=${LATEST_WINDOW}`,
    );
}

// Invokes onValue for each event payload newest-first until it returns true.
function scanBackward(payload, onValue) {
    const responses = payload.responses ?? [];
    for (let i = responses.length - 1; i >= 0; i--) {
        const value = responseValue(responses[i]);
        if (value && onValue(value)) break;
    }
}

async function findOpenOffer(runId) {
    try {
        const payload = await latestResponses(runId);
        let offer = null;
        scanBackward(payload, (value) => {
            if (value.input_offered) {
                offer = strOr(value.input_offered.execution_id);
                return true;
            }
            return false;
        });
        if (!offer || !offer.startsWith(runId + ".")) return null;
        return offer;
    } catch (_) {
        return null;
    }
}

// Returns "ok", "stale" (the offer was fulfilled concurrently), or an error
// description.
async function putStub(offerId, result) {
    let resp;
    try {
        resp = await fetch(apiBase() + `/v1/executions/${encodeURIComponent(offerId)}/stub`, {
            method: "PUT",
            headers: authHeaders({ "content-type": "application/json" }),
            body: JSON.stringify(result),
        });
    } catch (error) {
        return message(error);
    }
    if (resp.ok) return "ok";
    const text = await safeText(resp);
    if (resp.status === 400 || resp.status === 409 || resp.status === 422) return "stale";
    return `HTTP ${resp.status}: ${truncate(text, 300)}`;
}

async function fetchStatus(executionId) {
    try {
        return await apiJson(
            "GET",
            `/v1/executions/${encodeURIComponent(executionId)}/status`,
        );
    } catch (_) {
        return null;
    }
}

async function createdParams(executionId) {
    try {
        const payload = await apiJson(
            "GET",
            `/v1/executions/${encodeURIComponent(executionId)}/events`
            + "?cursor_kind=version_from&cursor=0&including_cursor=true&length=1",
        );
        const params = payload.events?.[0]?.event?.created?.params;
        if (!Array.isArray(params)) return null;
        return {
            prompt: typeof params[0] === "string" ? params[0] : "",
            backend: typeof params[1] === "string" ? params[1] : null,
            effort: typeof params[3] === "string" ? params[3] : null,
        };
    } catch (_) {
        return null;
    }
}

function loadCatalog() {
    const raw = process.env["AGENT_MODELS"];
    if (!raw || !raw.trim()) throw new Error("AGENT_MODELS is not configured");
    let parsed;
    try { parsed = JSON.parse(raw); } catch (error) {
        throw new Error(`AGENT_MODELS is not valid JSON: ${message(error)}`);
    }
    if (!Array.isArray(parsed)) throw new Error("AGENT_MODELS must be a JSON array");
    return parsed.map((entry, index) => {
        if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id) {
            throw new Error(`AGENT_MODELS[${index}] has no string id`);
        }
        return {
            id: entry.id,
            label: typeof entry.label === "string" && entry.label ? entry.label : entry.id,
            api_type: typeof entry.api_type === "string" ? entry.api_type : "",
        };
    });
}

// ----- response-stream plumbing ----------------------------------------------

// Payload of one recorded notification: the record-output stub's SessionEvent
// variant, found at .event.event.result.ok(.value)? per webhook/lib/responses.js.
function responseValue(response) {
    const ev = response?.event?.event?.event;
    if (!ev || ev.type !== "child_execution_finished") return null;
    return ev.result?.ok?.value ?? ev.result?.ok ?? null;
}

function createdAtOf(response) {
    return response?.event?.created_at ?? "";
}

function projectSessionStarted(started) {
    return {
        protocol_version: started.protocol_version,
        prompt: strOr(started.prompt),
        backend: strOr(started.backend),
        effort: strOr(started.effort),
        system_prompt: strOr(started.system_prompt),
    };
}

// Projects one SessionEvent variant into the normalized event list; unknown
// cases (newer protocol) are dropped so readers never see half-known shapes.
function projectEvent(value, createdAt) {
    if (value.user_message) {
        const m = value.user_message;
        return { kind: "user_message", id: str(m.id), text: str(m.text), turn_index: intOrNull(m.turn_index), created_at: createdAt };
    }
    if (value.assistant_reply) {
        const rep = value.assistant_reply;
        let blocks = [];
        try { blocks = JSON.parse(rep.content_json); } catch (_) { blocks = []; }
        if (!Array.isArray(blocks)) blocks = [];
        const toolCalls = blocks.filter((b) => b && b.type === "tool_use")
            .map((b) => ({ id: str(b.id), name: b.name, input: b.input ?? {} }));
        const text = blocks.filter((b) => b && b.type === "text").map((b) => b.text ?? "").join("");
        return {
            kind: "assistant_reply",
            text,
            tool_calls: toolCalls,
            turn_index: intOrNull(rep.turn_index),
            duration_milliseconds: rep.duration_milliseconds ?? null,
            turn_complete: rep.turn_complete === true,
            created_at: createdAt,
        };
    }
    if (value.agent_error) {
        const e = value.agent_error;
        return { kind: "agent_error", text: str(e.text), turn_index: intOrNull(e.turn_index), created_at: createdAt };
    }
    if (value.tool_result) {
        const t = value.tool_result;
        const event = { kind: "tool_result", id: str(t.id), turn_index: intOrNull(t.turn_index), duration_milliseconds: t.duration_milliseconds ?? null };
        if (t.output && "ok" in t.output) {
            event.ok = true;
            event.exit_code = t.output.ok?.exit_code ?? null;
        } else if (t.output && "error" in t.output) {
            event.error = str(t.output.error);
        }
        return event;
    }
    if (value.shell_output) {
        const s = value.shell_output;
        return {
            kind: "shell_output",
            id: str(s.id),
            script: str(s.script),
            stdout: chunks(s.result?.output, "stdout"),
            stderr: chunks(s.result?.output, "stderr"),
            exit_code: s.result?.exit_code ?? null,
            turn_index: intOrNull(s.turn_index),
            duration_milliseconds: s.duration_milliseconds ?? null,
            turn_complete: s.turn_complete === true,
            created_at: createdAt,
        };
    }
    if (value.human_input_requested) {
        const h = value.human_input_requested;
        return { kind: "ask_user", question: str(h.question), turn_index: intOrNull(h.turn_index), created_at: createdAt };
    }
    return null;
}

function renderEvent(ev) {
    const turn = ev.turn_index === null ? "" : `[turn ${ev.turn_index}] `;
    switch (ev.kind) {
        case "user_message":
            return `${turn}user: ${block(ev.text)}`;
        case "assistant_reply": {
            const parts = [];
            if (ev.text) parts.push(`${turn}assistant: ${block(ev.text)}`);
            for (const call of ev.tool_calls) {
                parts.push(`${turn}tool ${call.name}(${truncate(JSON.stringify(call.input), 400)})`);
            }
            if (parts.length === 0) parts.push(`${turn}assistant: (empty reply)`);
            return parts.join("\n");
        }
        case "agent_error":
            return `${turn}error: ${block(ev.text)}`;
        case "tool_result":
            if (ev.ok) return `${turn}tool result ${ev.id}: ok`;
            return `${turn}tool result ${ev.id}: error ${truncate(ev.error ?? "", 800)}`;
        case "shell_output": {
            const lines = [`${turn}$ ${ev.script}`];
            if (ev.stdout) lines.push(block(truncate(ev.stdout, BLOCK_CHAR_LIMIT)));
            if (ev.stderr) lines.push("[stderr] " + block(truncate(ev.stderr, BLOCK_CHAR_LIMIT)));
            lines.push(`(exit ${ev.exit_code})`);
            return lines.join("\n");
        }
        case "ask_user":
            return `${turn}ask-user: ${block(ev.question)}`;
        default:
            return "";
    }
}

function latestTurnIndex(events) {
    return events.reduce((acc, ev) => Math.max(acc, ev.turn_index ?? -1), -1);
}

// The newest assistant message that actually finished a turn with visible
// text (not a mid-step tool-call reply); null when none was written.
function lastReplyTurn(events) {
    for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (ev.kind === "assistant_reply" && ev.turn_complete && ev.text) return ev.turn_index;
    }
    return null;
}

// ----- HTTP -------------------------------------------------------------------

function apiBase() {
    const base = process.env["OBELISK_API_URL"];
    if (!base) throw new Error("OBELISK_API_URL is not configured");
    return base.replace(/\/$/, "");
}

function authHeaders(extra) {
    const headers = { accept: "application/json", ...extra };
    const token = process.env["OBELISK__API__TOKEN"];
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
}

async function apiJson(method, path, body) {
    try {
        return JSON.parse(await apiText(method, path, body));
    } catch (error) {
        if (/^HTTP /.test(message(error))) throw error;
        throw new Error(`invalid JSON from ${path}: ${message(error)}`);
    }
}

async function apiText(method, path, body) {
    let resp;
    try {
        resp = await fetch(apiBase() + path, {
            method,
            headers: body !== undefined ? authHeaders({ "content-type": "application/json" }) : authHeaders(),
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
    } catch (error) {
        throw new Error(`request failed: ${message(error)}`);
    }
    const text = await safeText(resp);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${truncate(text, 300)}`);
    return text;
}

async function safeText(resp) {
    try { return await resp.text(); } catch (_) { return ""; }
}

async function sleepMs(ms) {
    if (typeof setTimeout !== "function") return;
    await new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueId() {
    return "chat-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

// ----- arg/format helpers -----------------------------------------------------

// Shared option parser: booleans --json/--system/--all/--top-level, valued
// --limit/--tail/--model/--effort (both "--x v" and "--x=v"); everything else
// is positional. Unknown options throw.
function parseFlags(args) {
    const parsed = {
        positional: [], json: false, system: false, all: false, "top-level": false,
        limit: null, tail: null, turn: null, model: null, effort: null, name: null,
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const take = () => {
            if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
            i += 1;
            if (i >= args.length) throw new UsageError(`option requires a value: ${arg}`);
            return args[i];
        };
        switch (arg.split("=")[0]) {
            case "--json": parsed.json = true; continue;
            case "--system": parsed.system = true; continue;
            case "--all": parsed.all = true; continue;
            case "--top-level": parsed["top-level"] = true; continue;
            case "--limit": {
                const value = Number(take());
                if (!Number.isInteger(value) || value <= 0) {
                    throw new UsageError("--limit expects a positive integer");
                }
                parsed.limit = value;
                continue;
            }
            case "--tail": {
                const value = Number(take());
                if (!Number.isInteger(value) || value <= 0) {
                    throw new UsageError("--tail expects a positive integer");
                }
                parsed.tail = value;
                continue;
            }
            case "--turn": {
                const value = Number(take());
                if (!Number.isInteger(value) || value < 0) {
                    throw new UsageError("--turn expects a non-negative integer");
                }
                parsed.turn = value;
                continue;
            }
            case "--model": parsed.model = take(); continue;
            case "--name": parsed.name = take(); continue;
            case "--effort": parsed.effort = take(); continue;
        }
        if (arg.startsWith("-")) throw new UsageError(`unsupported option: ${arg}`);
        parsed.positional.push(arg);
    }
    return parsed;
}

function joinName(joinSetId) {
    // One-off join sets use "o:<ordinal>-<name>"; named ones use "n:<name>".
    if (typeof joinSetId !== "string") return "";
    let name = joinSetId;
    if (name.startsWith("n:")) name = name.substring(2);
    else {
        const dash = name.indexOf("-");
        name = dash === -1 ? "" : name.substring(dash + 1);
    }
    return /^user-\d+$/.test(name) ? "user" : name;
}

function indent(text) {
    return String(text ?? "").split("\n").map((line) => "  " + line).join("\n");
}

// Multi-line content reads better indented under its label; single lines
// would only gain stray double spaces.
function block(text) {
    const s = String(text ?? "");
    return s.includes("\n") ? indent(s) : s;
}

function truncate(text, max) {
    const s = String(text ?? "");
    return s.length > max ? s.slice(0, max) + "..." : s;
}

function chunks(output, stream) {
    if (!Array.isArray(output)) return "";
    return output.map((c) => c?.[stream]).filter((t) => typeof t === "string").join("");
}

function str(value) { return typeof value === "string" ? value : ""; }
function strOr(value) { return typeof value === "string" ? value : null; }
function intOrNull(value) { return Number.isInteger(value) ? value : null; }

function message(error) {
    return error instanceof Error ? error.message : String(error);
}

function usage(detail) {
    return fail(2, `chat: ${detail}\nTry 'chat --help' for more information.\n`);
}

function ok(stdout) {
    return { stdout, stderr: "", exit_code: 0 };
}

function fail(exitCode, stderr) {
    return { stdout: "", stderr, exit_code: exitCode };
}

// ----- help -------------------------------------------------------------------

function commandHelp(sub) {
    switch (sub) {
        case "models":
            return [
                "Usage: chat models [--json]",
                "",
                "List the LLM catalog from AGENT_MODELS: one line per model with",
                "id, label, and api type.",
                "",
            ].join("\n");
        case "list":
            return [
                "Usage: chat list [--limit N] [--all] [--json]",
                "",
                "List sessions, newest first. Default scope covers every session",
                `(top-level and child); --limit defaults to ${DEFAULT_LIST_LIMIT}, --all caps at ${MAX_LIST_LIMIT}.`,
                "Columns: id, created at, state, name (- if unnamed), prompt preview.",
                "",
            ].join("\n");
        case "read":
            return [
                "Usage: chat read ID [--tail N | --turn N] [--json] [--system]",
                "",
                "Print a normalized transcript: session metadata, then turns with",
                "user messages, assistant replies, narration, tool calls, shell",
                "outputs, and errors. --tail keeps only the last N turns; --turn N",
                "prints only turn N (the way to read just a finished message that",
                "'chat state' points at). --system includes the system prompt (it",
                "is huge).",
                "",
            ].join("\n");
        case "state":
            return [
                "Usage: chat state ID [--json]",
                "",
                "One JSON object describing a session: run state, working yes/no,",
                "current turn index, last_reply ({turn} when a finished assistant",
                "message exists; sessions stay pending for follow-ups even after",
                "one), pending input-offer id when parked on user input, backend,",
                "effort, and slug name.",
                "",
            ].join("\n");
        case "send":
            return [
                "Usage: chat send ID TEXT...   (or pipe TEXT on stdin)",
                "",
                "Inject a user prompt into a session. While it is thinking the",
                "prompt queues for its next turn; while idle it is delivered",
                "immediately. The open input offer rotates every turn and is",
                "looked up fresh here; never invent offer ids.",
                "",
            ].join("\n");
        case "create":
            return [
                "Usage: chat create [--model M] [--effort E] [--name SLUG]",
                "                   [--top-level] [PROMPT...]",
                "",
                "Start a new session and print its execution id. Model ids come",
                "from 'chat models'; effort is one of: " + EFFORTS.join("|") + ".",
                "By default the session is scheduled durably as a child of this",
                "session (it dies with this session's cancellation); --top-level",
                "submits an independent execution instead. A PROMPT starting",
                "with '$' runs directly in the new session's shell. --name labels",
                "the child with a slug (also visible in its execution id); pass",
                "all context the child needs in its PROMPT, it starts fresh.",
                "",
            ].join("\n");
        case "current":
            return [
                "Usage: chat current [--json]",
                "",
                "Print this session's identity as JSON: own execution id, backend,",
                "effort, slug name, and parent session when derived. Answered by",
                "the session workflow itself.",
                "",
            ].join("\n");
        case "rename":
            return [
                "Usage: chat rename NAME",
                "",
                "Rename this session to NAME, a slug of lowercase letters, digits,",
                "and inner dashes (max 64 chars). Answered by the session workflow",
                "itself; peers see the new name via chat list/state/read.",
                "",
            ].join("\n");
        default:
            break;
    }
    throw new UsageError(`unknown command '${sub}'`);
}

function help() {
    return [
        "Usage: chat COMMAND [options] [ARGS]...",
        "",
        "Discover, inspect, message, and create peer workflow-agent sessions",
        "on this Obelisk instance.",
        "",
        "Commands:",
        "  models          List the LLM catalog: id, label, api type",
        "  list [--limit N] [--all] [--json]",
        "                  List sessions, newest first (--all caps at " + MAX_LIST_LIMIT + ")",
        "  read ID [--tail N | --turn N] [--json] [--system]",
        "                  Print a session transcript (--turn reads just one turn;",
        "                  --system adds the potentially huge system prompt)",
        "  state ID        Machine-readable state: includes last_reply {turn} when a",
        "                  finished assistant message exists (read it with --turn)",
        "  send ID TEXT... Queue a user prompt for a session: delivered while idle,",
        "                  queued while busy. Never guess IDs; find them with list.",
        "  create [--model M] [--effort E] [--name SLUG] [--top-level] [PROMPT...]",
        "                  Start a new session and print its id; effort is one of "
            + EFFORTS.join("|") + ". By default the new session is scheduled as a",
        "                  child of this session; --top-level makes it independent.",
        "                  A PROMPT starting with '$' opens it straight in bash;",
        "                  --name slugs it (and shows in its execution id).",
        "  current         This session's identity as JSON (workflow-served)",
        "  rename NAME     Rename this session to a slug ([a-z0-9-]; workflow-served)",
        "",
        "Exit codes: 0 success, 1 failure, 2 usage.",
        "",
    ].join("\n");
}
