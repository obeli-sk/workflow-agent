// cloud.tenant operation current-deployment-id:
//   func() -> result<string, string>
import { targetBase, targetToken } from "./target.js";

export default async function current_deployment_id() {
    const base = targetBase();
    const resp = await fetch(`${base}/v1/deployment-id`, { headers: { accept: "application/json", authorization: `Bearer ${targetToken()}` } });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
