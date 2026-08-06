#!/usr/bin/env node
//
// Minimal stateless MCP server for the MCP end-to-end test (scripts/
// test-e2e-mcp.sh). Deliberately self-contained (node stdlib only, no deps) so
// the test controls the exact tool/prompt schema and its assertions are exact,
// rather than depending on a drifting third-party image.
//
// Stateless Streamable HTTP (2026-07-28 spec): every POST is one independent
// JSON-RPC request handled with no cross-request state, which is exactly the
// contract activity/mcp.js speaks. GET is a readiness probe. The methods below
// are only the ones the shell command surface issues (obelisk_mcp.rs): tools/
// list, tools/call, prompts/list, prompts/get, server/discover.

import http from "node:http";

const PORT = Number(process.env.PORT || 1071);

const TOOLS = [
    { name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
    { name: "echo", description: "Echo the given text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
];

const PROMPTS = [
    { name: "greeting", description: "Greet someone by name", arguments: [{ name: "name", description: "who to greet", required: true }] },
];

function textResult(text) {
    return { content: [{ type: "text", text: String(text) }] };
}

function dispatch(method, params) {
    switch (method) {
        case "server/discover":
            return { serverInfo: { name: "e2e-mcp-stateless", version: "1" }, capabilities: { tools: {}, prompts: {} } };
        case "tools/list":
            return { tools: TOOLS };
        case "prompts/list":
            return { prompts: PROMPTS };
        case "tools/call": {
            const name = params && params.name;
            const args = (params && params.arguments) || {};
            if (name === "add") return textResult(Number(args.a) + Number(args.b));
            if (name === "echo") return textResult(`echo: ${args.text}`);
            return { rpcError: { code: -32602, message: `unknown tool: ${name}` } };
        }
        case "prompts/get": {
            const name = params && params.name;
            const args = (params && params.arguments) || {};
            if (name === "greeting") {
                return {
                    description: "a greeting",
                    messages: [{ role: "user", content: { type: "text", text: `Hello, ${args.name}!` } }],
                };
            }
            return { rpcError: { code: -32602, message: `unknown prompt: ${name}` } };
        }
        // A stateless-native client never sends these, but tolerate them so a
        // legacy-handshake fallback would also succeed against this server.
        case "initialize":
            return { protocolVersion: "2026-07-28", capabilities: { tools: {}, prompts: {} }, serverInfo: { name: "e2e-mcp-stateless", version: "1" } };
        default:
            return { rpcError: { code: -32601, message: `method not found: ${method}` } };
    }
}

const server = http.createServer((req, res) => {
    if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
    }
    if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
        let message;
        try { message = JSON.parse(body); } catch (_) { message = {}; }
        const id = message && message.id !== undefined ? message.id : null;
        // Notifications (no id, e.g. notifications/initialized) get a bare 202.
        if (id === null && message && typeof message.method === "string" && message.method.startsWith("notifications/")) {
            res.writeHead(202);
            res.end();
            return;
        }
        const outcome = dispatch(message && message.method, message && message.params);
        const envelope = outcome && outcome.rpcError
            ? { jsonrpc: "2.0", id, error: outcome.rpcError }
            : { jsonrpc: "2.0", id, result: outcome };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(envelope));
    });
});

server.listen(PORT, () => {
    process.stdout.write(`e2e-mcp-server listening on :${PORT}\n`);
});
