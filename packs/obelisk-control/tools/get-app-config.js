// obelisk-agent:tools/webapi.get-app-config:
//   func() -> result<option<string>, string>
export default async function get_app_config() {
    const base = process.env["TARGET_OBELISK_API_URL"];
    if (!base) throw "TARGET_OBELISK_API_URL is not configured";
    const resp = await fetch(`${base}/v1/app-config`, { headers: { accept: "application/json", authorization: `Bearer ${process.env["TARGET_OBELISK_TOKEN"]}` } });
    if (resp.status === 404) return null;
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    const { policy } = await resp.json();
    return `${JSON.stringify(policy, null, 2)}\n`;
}
