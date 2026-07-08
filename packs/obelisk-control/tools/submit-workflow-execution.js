// obelisk-agent:tools/webapi.submit-workflow-execution:
//   func(execution-id: string, prompt: string, backend: option<string>)
//     -> result<string, string>
const WORKFLOW_FFQN = "obelisk-agent:workflow/workflow.run";

export default async function submit_workflow_execution(executionId, prompt, backend) {
    if (!executionId) throw "execution-id is required";
    if (typeof prompt !== "string" || !prompt.trim()) throw "prompt is required";
    // workflow.run params: [prompt, model, descriptor-ffqn]. backend is the
    // model id; descriptor is left null so the run uses the default pack.
    const modelId = typeof backend === "string" && backend ? backend : null;
    const body = {
        ffqn: WORKFLOW_FFQN,
        params: [prompt, modelId, null],
    };

    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    const resp = await fetch(
        `${base}/v1/executions/${encodeURIComponent(executionId)}`,
        {
            method: "PUT",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify(body),
        },
    );
    if (resp.ok) return JSON.stringify({ execution_id: executionId });

    if (resp.status === 409 && await executionExists(base, executionId)) {
        return JSON.stringify({ execution_id: executionId, already: true });
    }
    throw `HTTP ${resp.status}: ${await resp.text()}`;
}

async function executionExists(base, executionId) {
    try {
        const resp = await fetch(
            `${base}/v1/executions/${encodeURIComponent(executionId)}/status`,
            { headers: { accept: "application/json" } },
        );
        return resp.ok;
    } catch (_) {
        return false;
    }
}
