// Public supervisor workflow. It loads the system prompt + tool schemas, then
// races the nested agent-loop workflow against an operator teardown signal.
// There is no container to own anymore: the agent talks to an LLM endpoint over
// HTTP (the llm/chat.completion activity), so this workflow holds no exec
// activities and needs no cleanup step.

import * as agentPrompt from "obelisk-agent:agent/prompt";

const AGENT_LOOP_FFQN = "obelisk-agent:workflow/workflow.agent-loop";
const TEARDOWN_SIGNAL_FFQN = "obelisk-agent:agent/session.teardown-signal";

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

    let outcome = null;
    let workflowError = null;
    let race = null;
    try {
        race = obelisk.createJoinSet({ name: "session" });
        const childId = race.submit(AGENT_LOOP_FFQN, [prompt, systemPrompt, loaded.tools_json, model]);
        const teardownSignalId = race.submit(TEARDOWN_SIGNAL_FFQN, []);
        const completed = race.joinNext();

        if (completed.id === teardownSignalId) {
            outcome = "Session torn down by operator.";
            console.log("operator requested session teardown");
        } else if (completed.id === childId) {
            outcome = obelisk.getResult(childId);
        } else {
            throw `unexpected session child completed: ${completed.id}`;
        }
    } catch (error) {
        workflowError = error;
    } finally {
        if (race !== null) {
            try { race.close(); }
            catch (error) { console.log(`Session race close failed: ${String(error)}`); }
        }
    }

    if (workflowError !== null) throw workflowError;
    return outcome;
}
