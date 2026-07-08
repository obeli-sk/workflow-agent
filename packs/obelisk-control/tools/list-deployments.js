// obelisk-agent:tools/webapi.list-deployments:
//   func(cursor-from: string, including-cursor: bool, length: u32)
//     -> result<string, string>
export default async function list_deployments(cursorFrom, includingCursor, length) {
    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    const params = [];
    if (cursorFrom) params.push(`cursor_from=${encodeURIComponent(cursorFrom)}`);
    if (includingCursor) params.push("including_cursor=true");
    if (length > 0) params.push(`length=${encodeURIComponent(String(length))}`);
    const qs = params.length ? `?${params.join("&")}` : "";
    const resp = await fetch(`${base}/v1/deployments${qs}`, {
        headers: { accept: "application/json" },
    });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
