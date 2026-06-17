// obelisk-agent:tools/webapi.deployment-switch:
//   func(deployment-id: string, verify: bool) -> result<string, string>
//
// Enqueue a deployment so it becomes active on the next server restart
// (hot_redeploy = false). Unlike a hot redeploy, a non-hot switch does not tear
// down the executor running this activity, so it is safe to call synchronously.
// A hot redeploy must instead go through webapi.apply-deployment, which performs
// the switch out of process to avoid deadlocking the executor.
export default async function deployment_switch(deploymentId, verify) {
    if (!deploymentId) throw "deployment-id is required";
    const base = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    const resp = await fetch(
        `${base}/v1/deployments/${encodeURIComponent(deploymentId)}/switch`,
        {
            method: "PUT",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify({ hot_redeploy: false, verify: Boolean(verify) }),
        },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return (await resp.text()).trim() || "enqueued";
}
