// cloud.tenant operation get-responses:
//   func(execution-id: string, cursor: u32, including-cursor: bool,
//        length: u32) -> result<string, string>
import { targetBase, targetToken } from "./target.js";

export default async function get_responses(executionId, cursor, includingCursor, length) {
    if (!executionId) throw "execution-id is required";
    const current = Number.isFinite(cursor) && cursor > 0 ? Math.trunc(cursor) : 0;
    const pageLength = Number.isFinite(length) && length > 0 ? Math.trunc(length) : 200;
    const params = [
        `cursor=${encodeURIComponent(String(current))}`,
        `including_cursor=${includingCursor ? "true" : "false"}`,
        `length=${encodeURIComponent(String(pageLength))}`,
    ];
    const base = targetBase();
    const resp = await fetch(
        `${base}/v1/executions/${encodeURIComponent(executionId)}/responses?${params.join("&")}`,
        { headers: { accept: "application/json", authorization: `Bearer ${targetToken()}` } },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
