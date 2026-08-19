// obelisk-agent:tools/webapi.get-function-wit:
//   func(ffqn: string) -> result<string, string>
export default async function get_function_wit(ffqn) {
    if (!ffqn) throw "ffqn is required";
    const base = process.env["TARGET_OBELISK_API_URL"];
    if (!base) throw "TARGET_OBELISK_API_URL is not configured";
    const resp = await fetch(
        `${base}/v1/functions/wit?ffqn=${encodeURIComponent(ffqn)}`,
        { headers: { accept: "text/plain", authorization: `Bearer ${process.env["TARGET_OBELISK_TOKEN"]}` } },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
