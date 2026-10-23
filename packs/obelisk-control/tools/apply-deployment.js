// cloud.tenant operation apply-deployment:
//   func(deployment-id: string) -> result<string, string>
//
// Trigger a hot redeploy by PUT-ing /v1/deployments/{id}/switch with apply=true.
import { targetBase, targetToken } from "./target.js";

export default async function apply_deployment(deploymentId) {
    if (!deploymentId) throw "deployment-id is required";
    const base = targetBase();
    const resp = await fetch(
        `${base}/v1/deployments/${encodeURIComponent(deploymentId)}/switch`,
        {
            method: "PUT",
            headers: { accept: "application/json", authorization: `Bearer ${targetToken()}`, "content-type": "application/json" },
            body: JSON.stringify({ apply: true }),
        },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return (await resp.text()).trim() || "switched";
}
