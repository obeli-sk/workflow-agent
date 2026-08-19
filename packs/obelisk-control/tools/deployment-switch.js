// obelisk-agent:tools/webapi.deployment-switch:
//   func(deployment-id: string, allow-missing-runtime-config: bool)
//        -> result<string, string>
//
// Enqueue a deployment so it becomes active on the next server restart
// (hot_redeploy = false). Unlike a hot redeploy, a non-hot switch does not tear
// down the executor running this activity, so it is safe to call synchronously.
// A hot redeploy must instead go through webapi.apply-deployment, which performs
// the switch out of process to avoid deadlocking the executor.
//
// allow-missing-runtime-config tolerates absent environment variables / secrets
// during the pre-enqueue verification (activation may still fail later).
export default async function deployment_switch(deploymentId, allowMissing) {
    if (!deploymentId) throw "deployment-id is required";
    const base = process.env["TARGET_OBELISK_API_URL"];
    if (!base) throw "TARGET_OBELISK_API_URL is not configured";
    const resp = await fetch(
        `${base}/v1/deployments/${encodeURIComponent(deploymentId)}/switch`,
        {
            method: "PUT",
            headers: { accept: "application/json", authorization: `Bearer ${process.env["TARGET_OBELISK_TOKEN"]}`, "content-type": "application/json" },
            body: JSON.stringify({ hot_redeploy: false, allow_unavailable_runtime_config: Boolean(allowMissing) }),
        },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return (await resp.text()).trim() || "enqueued";
}
