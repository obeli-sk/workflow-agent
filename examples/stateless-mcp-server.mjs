#!/usr/bin/env node

import { createHash } from "node:crypto";
import http from "node:http";

const port = Number(process.env.PORT || 1071);

const tools = [
    { name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
    { name: "echo", description: "Echo the given text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
];

const prompts = [
    { name: "greeting", description: "Greet someone by name", arguments: [{ name: "name", description: "Who to greet", required: true }] },
];

const resourceBodies = new Map([
    ["sample://files/README.md", "# Stateless MCP sample\n\nThis file was fetched lazily from an MCP resource.\n"],
    ["sample://files/config/settings.json", '{"mode":"stateless","answer":42}\n'],
]);

const resources = [
    resource("sample://files/README.md", "README.md", "Sample documentation", "text/markdown"),
    resource("sample://files/config/settings.json", "config/settings.json", "Sample configuration", "application/json"),
];

function resource(uri, name, description, mimeType) {
    const body = resourceBodies.get(uri);
    return {
        uri,
        name,
        description,
        mimeType,
        size: Buffer.byteLength(body),
        _meta: { "sk.obeli/content-digest": `sha256:${createHash("sha256").update(body).digest("hex")}` },
    };
}

function textResult(text) {
    return { content: [{ type: "text", text: String(text) }] };
}

function dispatch(method, params = {}) {
    switch (method) {
        case "server/discover":
            return { serverInfo: { name: "workflow-agent-stateless-sample", version: "1" }, capabilities: { tools: {}, prompts: {}, resources: {} } };
        case "tools/list":
            return { tools };
        case "prompts/list":
            return { prompts };
        case "resources/list":
            return { resources };
        case "resources/read": {
            const text = resourceBodies.get(params.uri);
            if (text === undefined) return rpcError(-32602, `unknown resource: ${params.uri}`);
            return { contents: [{ uri: params.uri, mimeType: resources.find((item) => item.uri === params.uri)?.mimeType, text }] };
        }
        case "tools/call":
            if (params.name === "add") return textResult(Number(params.arguments?.a) + Number(params.arguments?.b));
            if (params.name === "echo") return textResult(`echo: ${params.arguments?.text}`);
            return rpcError(-32602, `unknown tool: ${params.name}`);
        case "prompts/get":
            if (params.name === "greeting") {
                return { description: "A greeting", messages: [{ role: "user", content: { type: "text", text: `Hello, ${params.arguments?.name}!` } }] };
            }
            return rpcError(-32602, `unknown prompt: ${params.name}`);
        case "initialize":
            return { protocolVersion: "2026-07-28", capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: "workflow-agent-stateless-sample", version: "1" } };
        default:
            return rpcError(-32601, `method not found: ${method}`);
    }
}

function rpcError(code, message) {
    return { rpcError: { code, message } };
}

const server = http.createServer((req, res) => {
    if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok\n");
        return;
    }
    if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
        let message;
        try { message = JSON.parse(body); } catch (_) { message = {}; }
        const id = message.id ?? null;
        if (id === null && String(message.method).startsWith("notifications/")) {
            res.writeHead(202).end();
            return;
        }
        const outcome = dispatch(message.method, message.params);
        const envelope = outcome.rpcError
            ? { jsonrpc: "2.0", id, error: outcome.rpcError }
            : { jsonrpc: "2.0", id, result: outcome };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(envelope));
    });
});

server.listen(port, "0.0.0.0", () => {
    process.stdout.write(`stateless MCP sample listening on http://127.0.0.1:${port}/mcp\n`);
});
