// Canned OpenAI-compatible chat/completions endpoint for the interrupt E2E,
// serving two distinct model ids (both under the one LLM_BASE_URL origin, as
// AGENT_MODELS always is) so each scenario gets deterministic behavior without
// its own server process:
//   "fake"      - the first request emits one bash tool call whose timeout
//                 beats its sleep; every later request ends the turn so the
//                 model visibly reacts to the interrupted tool result.
//   "fake-loop" - every request emits the same short bash tool call and never
//                 ends the turn on its own, each response held back by a
//                 fixed delay so a test has a window to interrupt the turn
//                 while a completion is in flight.

import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 28095);
const loopDelayMs = Number(process.argv[3] ?? 1200);
let timeoutCalls = 0;

createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
        let model = "";
        try { model = JSON.parse(body || "{}").model || ""; } catch (_) { /* fall through below */ }
        if (model === "fake-loop") {
            setTimeout(() => respond(res, loopMessage()), loopDelayMs);
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
