// obelisk-agent:tools/webapi.deployment-checkout:
//   func(deployment-id: option<string>) -> result<string, string>
//
// Fetch a deployment to be edited as a virtual working copy. Returns
//   { deployment_id, active_deployment_id, config_json }
// where config_json is the FULL canonical config including inline source bodies
// (unlike webapi.get-deployment, which strips them). The workflow externalizes
// those bodies into editable files, mirroring `obelisk deployment get`.
//
// When deployment-id is omitted the currently active deployment is checked out.
export default async function deployment_checkout(deploymentId) {
    const base = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    // /v1/deployment-id returns the active ID as a JSON string under Accept:
    // application/json, so parse it rather than reading the quoted text.
    const active = String(await getJson(`${base}/v1/deployment-id`)).trim();
    const wanted = (typeof deploymentId === "string" && deploymentId.trim()) ? deploymentId.trim() : active;
    if (!wanted) throw "there is no active deployment to check out; pass a deployment-id";
    const record = await getJson(`${base}/v1/deployments/${encodeURIComponent(wanted)}`);
    if (typeof record.config_json !== "string") {
        throw `deployment ${wanted} has no config_json`;
    }
    return JSON.stringify({
        deployment_id: wanted,
        active_deployment_id: active,
        config_json: record.config_json,
    });
}

async function getJson(url) {
    const resp = await fetch(url, { headers: { accept: "application/json" } });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.json();
}
