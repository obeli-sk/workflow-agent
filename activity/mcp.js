// obelisk-agent:mcp/server.<name>:
//   func(method: string, params-json: string)
//     -> result<string, string>
//
// Stateless MCP transport over Streamable HTTP (2026-07-28 spec). One activity
// invocation is one MCP request: build a self-describing JSON-RPC request
// (protocol version, client info and capabilities travel in `_meta` on every
// call, with `Mcp-Method`/`Mcp-Name` routing headers), POST it, and return the
// JSON-RPC `result` as a JSON string. A JSON-RPC error or transport failure
// becomes the err arm (a throw); Obelisk retries per max_retries.
//
// A single mcp.js is reused by every server block; each block sets fixed env
// vars MCP_SERVER_URL (the full endpoint) and, optionally, MCP_SERVER_TOKEN (a
// placeholder bearer the runtime swaps for the real secret in the outbound
// header). The `client/config` pseudo-method reports those without any HTTP so
// the shell `mcp` registry can list servers even when one is down.
//
// Legacy fallback: 2025-era stateless servers that still expect the
// initialize/initialized handshake get it inline in the same invocation (worst
// case two POSTs), then the real call is retried with any Mcp-Session-Id the
// server handed back. Nothing is remembered across invocations.

const PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "workflow-agent", version: "1" };

export default async function mcpServer(method, paramsJson) {
    const m = typeof method === "string" ? method.trim() : "";
    if (!m) throw "method is required";
    const params = parseParams(paramsJson);

    if (m === "client/config") return JSON.stringify(config());

    const url = endpoint();
    const result = await call(url, m, params);
    return JSON.stringify(result === undefined ? null : result);
}

// ----- configuration ----------------------------------------------------------

function endpoint() {
    const url = process.env["MCP_SERVER_URL"];
    if (!url) throw "MCP_SERVER_URL is not configured";
    return String(url);
}

function config() {
    return { url: process.env["MCP_SERVER_URL"] || "", auth: !!process.env["MCP_SERVER_TOKEN"] };
}

function authHeader(headers) {
    const token = process.env["MCP_SERVER_TOKEN"];
    if (token) headers["authorization"] = `Bearer ${token}`;
}

// ----- JSON-RPC over Streamable HTTP ------------------------------------------

// The whole call: a stateless request first, then the legacy initialize
// handshake only if the server signals it needs a session. Returns the
// JSON-RPC `result`, or throws its `error`.
async function call(url, method, params) {
    let response = await rpc(url, 1, method, params, null);
    if (response.needsSession) {
        const sessionId = await handshake(url);
        response = await rpc(url, 1, method, params, sessionId);
    }
    if (response.error) throw rpcErrorMessage(response.error);
    return response.result;
}

// One JSON-RPC request. `{ result }` / `{ error }` on a parsed response, or
// `{ needsSession: true }` when the server wants an initialize handshake first.
async function rpc(url, id, method, params, sessionId) {
    const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
        "mcp-method": method,
    };
    if (typeof params.name === "string" && params.name) headers["mcp-name"] = params.name;
    if (sessionId) headers["mcp-session-id"] = sessionId;
    authHeader(headers);

    const body = { jsonrpc: "2.0", id, method, params: withMeta(params) };

    let resp;
    try {
        resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e) {
        throw `MCP request failed: ${String(e)}`;
    }

    const text = await safeText(resp);
    if (!resp.ok) {
        if (!sessionId && needsSessionStatus(resp.status)) return { needsSession: true };
        throw `MCP HTTP ${resp.status}: ${text.slice(0, 1000)}`;
    }

    const message = parseRpc(text, resp, id);
    if (!message) throw `MCP returned no JSON-RPC message: ${text.slice(0, 500)}`;
    if (message.error && !sessionId && needsSessionError(message.error)) return { needsSession: true };
    return { result: message.result, error: message.error };
}

// Inline initialize + initialized for a legacy server, returning any session id
// it assigned. The initialized notification is best-effort (some servers do not
// require it); a failure there does not abort the real call.
async function handshake(url) {
    const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": LEGACY_PROTOCOL_VERSION,
    };
    authHeader(headers);
    const body = {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
    };

    let resp;
    try {
        resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e) {
        throw `MCP initialize failed: ${String(e)}`;
    }
    const text = await safeText(resp);
    if (!resp.ok) throw `MCP initialize HTTP ${resp.status}: ${text.slice(0, 500)}`;
    const message = parseRpc(text, resp, 0);
    if (message && message.error) throw rpcErrorMessage(message.error);

    const sessionId = headerOf(resp, "mcp-session-id");
    const notifyHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": LEGACY_PROTOCOL_VERSION };
    if (sessionId) notifyHeaders["mcp-session-id"] = sessionId;
    authHeader(notifyHeaders);
    try {
        await fetch(url, { method: "POST", headers: notifyHeaders, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    } catch (_) { /* best-effort */ }
    return sessionId;
}

// Every call is self-describing: protocol version, client info and capabilities
// travel in `_meta` (SEP-2575). Params are always an object here.
function withMeta(params) {
    return {
        ...params,
        _meta: {
            "io.modelcontextprotocol/protocol-version": PROTOCOL_VERSION,
            clientInfo: CLIENT_INFO,
            capabilities: {},
        },
    };
}

// A Streamable HTTP response is either a single JSON object or an SSE stream of
// `data: {json}` events; in either case pick the JSON-RPC message for our id
// (falling back to any message carrying a result or error).
function parseRpc(text, resp, id) {
    const contentType = (headerOf(resp, "content-type") || "").toLowerCase();
    if (contentType.includes("text/event-stream")) {
        let fallback = null;
        for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let evt;
            try { evt = JSON.parse(payload); } catch (_) { continue; }
            if (evt && evt.jsonrpc && evt.id === id) return evt;
            if (evt && (evt.result !== undefined || evt.error !== undefined)) fallback = evt;
        }
        return fallback;
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { throw `MCP returned non-JSON: ${text.slice(0, 500)}`; }
}

// A 404/409 (or a 400 without a session) is how legacy servers say "initialize
// first". A generic 400 with a session already tried is a real error.
function needsSessionStatus(status) {
    return status === 400 || status === 404 || status === 409;
}
function needsSessionError(error) {
    const code = error && typeof error.code === "number" ? error.code : 0;
    const text = error && error.message ? String(error.message) : "";
    return code === -32600 || code === -32000 || /session|initiali/i.test(text);
}

function rpcErrorMessage(error) {
    if (!error) return "MCP error";
    const code = typeof error.code === "number" ? error.code : "";
    const msg = error.message ? String(error.message) : "MCP error";
    const data = error.data !== undefined ? ` (${JSON.stringify(error.data).slice(0, 300)})` : "";
    return code === "" ? `${msg}${data}` : `MCP error ${code}: ${msg}${data}`;
}

// ----- helpers ----------------------------------------------------------------

// Params arrive as a JSON string from the workflow; normalize to an object so
// `_meta` and routing headers can be attached uniformly.
function parseParams(paramsJson) {
    if (paramsJson === undefined || paramsJson === null || paramsJson === "") return {};
    let parsed;
    try { parsed = JSON.parse(paramsJson); }
    catch (e) { throw `params-json is not valid JSON: ${String(e)}`; }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    throw "params-json must be a JSON object";
}

function headerOf(resp, name) {
    try { return resp.headers && resp.headers.get ? resp.headers.get(name) : null; }
    catch (_) { return null; }
}
async function safeText(resp) {
    try { return await resp.text(); } catch (_) { return ""; }
}
