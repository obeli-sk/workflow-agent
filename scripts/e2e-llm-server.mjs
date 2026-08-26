// Canned OpenAI-compatible chat/completions endpoint for the interrupt E2E:
// the first request emits one bash tool call whose timeout beats its sleep;
// every later request ends the turn so the model visibly reacts to the
// interrupted tool result.

import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 28095);
let calls = 0;

createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
        calls += 1;
        const message = calls === 1
            ? {
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
            }
            : { role: "assistant", content: "timeout scenario complete" };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
            choices: [{
                finish_reason: message.tool_calls ? "tool_calls" : "stop",
                message,
            }],
        }));
    });
}).listen(port, "127.0.0.1", () => console.log(`fake llm listening on ${port}`));
