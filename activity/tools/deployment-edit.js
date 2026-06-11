// Durable I/O boundary for a workflow-local deployment draft.
//
// The workflow owns and mutates the draft deterministically. This activity
// gives every edit operation a visible child execution and performs the WebAPI
// reads/writes needed at transaction boundaries.
export default async function deployment_edit(operation, payloadJson) {
    let payload;
    try { payload = JSON.parse(payloadJson || "{}"); }
    catch (e) { throw `payload-json must be valid JSON: ${e.message}`; }

    const base = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    switch (operation) {
        case "begin": {
            const activeDeploymentId = await getJson(`${base}/v1/deployment-id`);
            const deploymentId = payload.deployment_id || activeDeploymentId;
            if (typeof deploymentId !== "string" || !deploymentId) {
                throw "there is no active deployment";
            }
            const deployment = await getJson(
                `${base}/v1/deployments/${encodeURIComponent(deploymentId)}`,
            );
            return JSON.stringify({
                active_deployment_id: activeDeploymentId,
                deployment,
            });
        }
        case "record":
            return JSON.stringify(payload);
        case "show":
            if (typeof payload.config_json !== "string") throw "config-json is required";
            return payload.config_json;
        case "submit": {
            if (typeof payload.active_deployment_id !== "string" || !payload.active_deployment_id) {
                throw "active-deployment-id is required";
            }
            if (typeof payload.config_json !== "string") throw "config-json is required";
            const activeId = await getJson(`${base}/v1/deployment-id`);
            if (activeId !== payload.active_deployment_id) {
                throw `active deployment changed from ${payload.active_deployment_id} to ${activeId}`;
            }
            const resp = await fetch(`${base}/v1/deployments`, {
                method: "POST",
                headers: { accept: "application/json", "content-type": "application/json" },
                body: JSON.stringify({
                    config_json: payload.config_json,
                    verify: Boolean(payload.verify),
                }),
            });
            if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
            const body = await resp.text();
            try {
                const parsed = JSON.parse(body);
                if (typeof parsed === "string") return JSON.stringify(parsed);
                if (parsed && typeof parsed.ok === "string") return JSON.stringify(parsed.ok);
            } catch (_) {}
            throw `deployment submit returned an invalid response: ${body}`;
        }
        default:
            throw `unknown deployment edit operation: ${operation}`;
    }
}

async function getJson(url) {
    const resp = await fetch(url, { headers: { accept: "application/json" } });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.json();
}
