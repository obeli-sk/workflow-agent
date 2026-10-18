// Canned OpenAI-compatible chat/completions endpoint for the interrupt E2E,
// serving two distinct model ids (both under the one LLM_BASE_URL origin, as
// AGENT_MODELS always is) so each scenario gets deterministic behavior without
// its own server process:
//   "fake"      - the first request emits one bash tool call whose timeout
//                 beats its sleep; every later request ends the turn so the
//                 model visibly reacts to the interrupted tool result.
//   "fake-loop" - the first request emits a short bash tool call; every later
//                 one is held open until POST /release, so an interrupt sent
//                 after the first tool result always lands mid-completion.

import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 28095);
let timeoutCalls = 0;
let loopCalls = 0;
const held = [];

createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
            object: "list",
            data: ["fake", "fake-loop"].map((id) => ({ id, object: "model" })),
        }));
        return;
    }
    if (req.method === "POST" && req.url === "/release") {
        for (const pending of held.splice(0)) respond(pending, { role: "assistant", content: "released" });
        res.writeHead(204);
        res.end();
        return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
        let model = "";
        try { model = JSON.parse(body || "{}").model || ""; } catch (_) { /* fall through below */ }
        if (model === "fake-loop") {
            loopCalls += 1;
            if (loopCalls === 1) respond(res, loopMessage());
            else held.push(res);
            return;
        }
        timeoutCalls += 1;
        respond(res, timeoutMessage(timeoutCalls));
    });
}).listen(port, "127.0.0.1", () => console.log(`fake llm listening on ${port}`));

function respond(res, message) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        choices: [{
            finish_reason: message.tool_calls ? "tool_calls" : "stop",
            message,
        }],
    }));
}

function timeoutMessage(calls) {
    if (calls === 1) {
        return {
            role: "assistant",
            content: "",
            tool_calls: [{
                id: "call-timeout-1",
                type: "function",
                function: {
                    name: "bash",
                    arguments: JSON.stringify({
                        script: "echo began; sleep 30; echo unreachable",
                        timeout: "2s",
                    }),
                },
            }],
        };
    }
    return { role: "assistant", content: "timeout scenario complete" };
}

function loopMessage() {
    return {
        role: "assistant",
        content: "",
        tool_calls: [{
            id: "call-loop",
            type: "function",
            function: {
                name: "bash",
                arguments: JSON.stringify({ script: "echo step" }),
            },
        }],
    };
}
