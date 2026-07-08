// obelisk-agent:tools/webapi.apply-deployment:
//   func(deployment-id: string) -> result<string, string>
//
// Trigger a hot redeploy by PUT-ing /v1/deployments/{id}/switch with
// hot_redeploy=true. Simple JS activity, parallel to deployment-switch.
export default async function apply_deployment(deploymentId) {
    if (!deploymentId) throw "deployment-id is required";
    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    const resp = await fetch(
        `${base}/v1/deployments/${encodeURIComponent(deploymentId)}/switch`,
        {
            method: "PUT",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify({ hot_redeploy: true }),
        },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return (await resp.text()).trim() || "switched";
}
