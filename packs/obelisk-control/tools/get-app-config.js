// obelisk-agent:tools/webapi.get-app-config:
//   func() -> result<option<string>, string>
// Reads the running app policy (GET /v1/app-policy) as TOML.
import { targetBase, targetToken } from "./target.js";

export default async function get_app_config() {
    const base = targetBase();
    if (!base) throw "TARGET_OBELISK_API_URL is not configured";
    const resp = await fetch(`${base}/v1/app-policy`, { headers: { accept: "application/toml", authorization: `Bearer ${targetToken()}` } });
    if (resp.status === 404) return null;
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
