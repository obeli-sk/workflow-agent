// obelisk-agent:tools/webapi.deployment-submit:
//   func(config-json: string, description: string, verify: bool,
//        deployment-id: string) -> result<string, string>
//
// Submit a reassembled canonical config as a new **inactive** deployment and
// return the new deployment ID. Activation (enqueue / hot redeploy) is a
// separate step. An empty deployment-id means "let the server allocate one";
// a non-empty value requests an idempotent submission under that ID.
export default async function deployment_submit(configJson, description, verify, deploymentId) {
    if (!configJson) throw "config-json is required";
    let config;
    try { config = JSON.parse(configJson); }
    catch (e) { throw `config-json must be valid JSON: ${e.message}`; }

    const body = { config_json: JSON.stringify(config), verify: Boolean(verify) };
    if (typeof description === "string" && description.trim()) body.description = description.trim();
    if (typeof deploymentId === "string" && deploymentId.trim()) body.deployment_id = deploymentId.trim();

    const base = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    const resp = await fetch(`${base}/v1/deployments`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return parseId(await resp.text());
}

// The submit endpoint returns the new deployment ID. Depending on the accept
// negotiation it may arrive bare or JSON-quoted; tolerate both.
function parseId(text) {
    const trimmed = text.trim();
    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "string") return parsed;
        if (parsed && typeof parsed.ok === "string") return parsed.ok;
    } catch (_) { /* bare string */ }
    return trimmed;
}
