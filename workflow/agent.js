// Public supervisor workflow. It resolves a pack descriptor (system prompt +
// tool catalog), then delegates to the generic agent-loop. The descriptor FFQN
// selects the use case; the core is otherwise pack-agnostic.
// There is no container to own: the agent talks to an LLM endpoint over HTTP.

import { agentLoopCancellable } from "obelisk-agent:workflow/workflow";

const DEFAULT_DESCRIPTOR_FFQN = "obelisk-control:agent/pack.describe";

export default function run(prompt, model, descriptorFfqn, effort) {
    if (typeof prompt !== "string" || !prompt.trim()) {
        throw "prompt is required";
    }
    // `model` selects an entry in the LLM catalog (AGENT_MODELS); empty => the
    // catalog default. `effort` is a reasoning level (off/minimal/low/medium/
    // high/xhigh); empty => the provider default.
    const modelId = (typeof model === "string" && model) ? model : "";
    const effortLevel = (typeof effort === "string" && effort) ? effort : "";
    const descriptor = (typeof descriptorFfqn === "string" && descriptorFfqn) ? descriptorFfqn : DEFAULT_DESCRIPTOR_FFQN;

    const executionId = obelisk.executionIdCurrent();
    const described = obelisk.call(descriptor, []);   // { prompt, tools_json }
    if (!described || typeof described.prompt !== "string" || typeof described.tools_json !== "string") {
        throw `descriptor ${descriptor} did not return { prompt, tools-json }`;
    }
    const systemPrompt = `${described.prompt}

# This execution

Your own workflow execution id is \`${executionId}\`. Pass it to
obelisk.get_execution / obelisk.get_logs to inspect your own run.`;

    return agentLoopCancellable(prompt, systemPrompt, described.tools_json, modelId, effortLevel);
}
