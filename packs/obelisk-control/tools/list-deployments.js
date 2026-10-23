// cloud.tenant operation list-deployments:
//   func(cursor-from: string, including-cursor: bool, length: u32)
//     -> result<string, string>
import { targetBase, targetToken } from "./target.js";

export default async function list_deployments(cursorFrom, includingCursor, length) {
    const base = targetBase();
    const params = [];
    if (cursorFrom) params.push(`cursor_from=${encodeURIComponent(cursorFrom)}`);
    if (includingCursor) params.push("including_cursor=true");
    if (length > 0) params.push(`length=${encodeURIComponent(String(length))}`);
    const qs = params.length ? `?${params.join("&")}` : "";
    const resp = await fetch(`${base}/v1/deployments${qs}`, {
        headers: { accept: "application/json", authorization: `Bearer ${targetToken()}` },
    });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
