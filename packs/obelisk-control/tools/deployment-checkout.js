// obelisk-agent:tools/webapi.deployment-checkout:
//   func(deployment-id: option<string>)
//     -> result<record { deployment-id: string, active-deployment-id: string,
//          deployment-toml: string,
//          files: list<record { path: string, digest: string, size: u64 }> },
//        variant { permanent-error(string), transient-error(string), execution-failed }>
//
// Fetch a deployment to be edited as a virtual working copy. Returns
//   { deployment_id, active_deployment_id, deployment_toml, files }
// where deployment_toml is the verbatim stored manifest. Deployment-owned
// files carry their deployment-relative path, content digest, and byte size;
// their bytes live in the CAS and are fetched on demand with
// webapi.deployment-read-blob.
//
// When deployment-id is omitted the currently active deployment is checked out.
export default async function deployment_checkout(deploymentId) {
    try { return await deployment_checkout_impl(deploymentId); }
    catch (error) { throw classifyActivityError(error); }
}

async function deployment_checkout_impl(deploymentId) {
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
    return {
        deployment_id: wanted,
        active_deployment_id: active,
        deployment_toml: record.deployment_toml,
        files: record.files,
    };
}

function classifyActivityError(error) {
    if (error?.permanent_error || error?.transient_error) return error;
    const message = error instanceof Error ? error.message : String(error);
    const status = Number(/\bHTTP (\d+)/.exec(message)?.[1]);
    const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
    return permanent || (!status && !(error instanceof Error))
        ? { permanent_error: message } : { transient_error: message };
}

async function getJson(url) {
    const resp = await fetch(url, { headers: { accept: "application/json", authorization: `Bearer ${process.env["OBELISK__API__TOKEN"]}` } });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.json();
}
