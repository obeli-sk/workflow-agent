// Public supervisor workflow. It loads the system prompt + tool schemas, then
// runs the nested agent-loop workflow and returns its result. There is no
// container to own: the agent talks to an LLM endpoint over HTTP (the
// llm/chat.completion activity), so this workflow holds no exec activities.

import * as agentPrompt from "obelisk-agent:agent/prompt";

const AGENT_LOOP_FFQN = "obelisk-agent:workflow/workflow.agent-loop";

export default function run(prompt, backend) {
    if (typeof prompt !== "string" || !prompt.trim()) {
        throw "prompt is required";
    }
    // `backend` is a model hint for the endpoint ("claude" / "codex" / a model
    // id); the endpoint decides how to serve it. Empty => the endpoint default.
    const model = (typeof backend === "string" && backend) ? backend : "";

    const executionId = obelisk.executionIdCurrent();
    const loaded = agentPrompt.loadSystemPrompt();   // { prompt, tools_json }
    const systemPrompt = `${loaded.prompt}

# This execution

Your own workflow execution id is \`${executionId}\`. Pass it to
obelisk.get_execution / obelisk.get_logs to inspect your own run.`;

    const session = obelisk.createJoinSet({ name: "session" });
    const childId = session.submit(AGENT_LOOP_FFQN, [prompt, systemPrompt, loaded.tools_json, model]);
    session.joinNext();
    return obelisk.getResult(childId);
}
