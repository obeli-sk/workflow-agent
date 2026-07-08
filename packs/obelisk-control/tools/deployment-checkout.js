// obelisk-agent:tools/webapi.deployment-checkout:
//   func(deployment-id: option<string>) -> result<string, string>
//
// Fetch a deployment to be edited as a virtual working copy. Returns
//   { deployment_id, active_deployment_id, deployment_toml }
// where deployment_toml is the verbatim stored manifest. Deployment-owned
// script/exec files are referenced by deployment-relative `location` +
// `content_digest`; their bytes live in the CAS and are fetched on demand with
// webapi.deployment-read-blob. The workflow splits this TOML into per-component
// blocks for editing.
//
// When deployment-id is omitted the currently active deployment is checked out.
export default async function deployment_checkout(deploymentId) {
    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    // /v1/deployment-id returns the active ID as a JSON string under Accept:
    // application/json, so parse it rather than reading the quoted text.
    const active = String(await getJson(`${base}/v1/deployment-id`)).trim();
    const wanted = (typeof deploymentId === "string" && deploymentId.trim()) ? deploymentId.trim() : active;
    if (!wanted) throw "there is no active deployment to check out; pass a deployment-id";
    const record = await getJson(`${base}/v1/deployments/${encodeURIComponent(wanted)}`);
    if (typeof record.deployment_toml !== "string") {
        throw `deployment ${wanted} has no deployment_toml`;
    }
    return JSON.stringify({
        deployment_id: wanted,
        active_deployment_id: active,
        deployment_toml: record.deployment_toml,
    });
}

async function getJson(url) {
    const resp = await fetch(url, { headers: { accept: "application/json" } });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.json();
}
