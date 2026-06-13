import * as claude from "obelisk-agent:agent/claude";
import * as codex from "obelisk-agent:agent/codex";
import * as agentPrompt from "obelisk-agent:agent/prompt";
import * as session from "obelisk-agent:agent/session";

const AGENT_LOOP_FFQN = "obelisk-agent:workflow/workflow.agent-loop";
const TEARDOWN_SIGNAL_FFQN = "obelisk-agent:agent/session.teardown-signal";
const STARTERS = { claude: claude.start, codex: codex.start };

export default function run(prompt, backend) {
    if (typeof prompt !== "string" || !prompt.trim()) {
        throw "prompt is required";
    }
    const which = (typeof backend === "string" && backend) ? backend : "claude";
    const start = STARTERS[which];
    if (!start) throw `unknown backend: ${which} (expected claude or codex)`;

    const executionId = obelisk.executionIdCurrent();
    const sessionId = sanitize(executionId);
    const containerName = `obelisk-agent-${sessionId}`;
    const socketPath = `/tmp/obelisk-agent/${sessionId}.sock`;

    let outcome = null;
    let workflowError = null;
    let race = null;
    try {
        const systemPrompt = `${agentPrompt.loadSystemPrompt()}

# This execution

Your own workflow execution id is \`${executionId}\`. Pass it to
obelisk.get_execution / obelisk.get_logs to inspect your own run.`;
        const startInfo = start(containerName, socketPath, systemPrompt);
        console.log(`Started ${which} agent ${startInfo.container} from ${startInfo.image}`);

        race = obelisk.createJoinSet({ name: "session" });
        const childId = race.submit(AGENT_LOOP_FFQN, [prompt, socketPath]);
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
        try {
            session.cleanup(containerName, socketPath);
            console.log(`Cleaned up ${containerName}`);
        } catch (error) {
            console.log(`Cleanup failed for ${containerName}: ${String(error)}`);
            if (workflowError === null) workflowError = error;
        }
        if (race !== null) {
            try { race.close(); }
            catch (error) { console.log(`Session race close failed: ${String(error)}`); }
        }
    }

    if (workflowError !== null) throw workflowError;
    return outcome;
}

function sanitize(value) {
    return String(value).replace(/[^A-Za-z0-9_.-]/g, "-");
}
