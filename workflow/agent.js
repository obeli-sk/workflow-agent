// Public supervisor workflow. It resolves a pack descriptor (system prompt +
// tool catalog), then runs the generic agent-loop and returns its result. The
// descriptor FFQN selects the use case; the core is otherwise pack-agnostic.
// There is no container to own: the agent talks to an LLM endpoint over HTTP.

const AGENT_LOOP_FFQN = "obelisk-agent:workflow/workflow.agent-loop";
const DEFAULT_DESCRIPTOR_FFQN = "obelisk-control:agent/pack.describe";

export default function run(prompt, model, descriptorFfqn) {
    if (typeof prompt !== "string" || !prompt.trim()) {
        throw "prompt is required";
    }
    // `model` selects an entry in the LLM catalog (AGENT_MODELS); empty => the
    // catalog default.
    const modelId = (typeof model === "string" && model) ? model : "";
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

    const session = obelisk.createJoinSet({ name: "session" });
    const childId = session.submit(AGENT_LOOP_FFQN, [prompt, systemPrompt, described.tools_json, modelId]);
    session.joinNext();
    return obelisk.getResult(childId);
}
