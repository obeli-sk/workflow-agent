// cloud.tenant operation get-events:
//   func(execution-id: string, cursor-kind: string, cursor: u32,
//        including-cursor: bool, length: u32) -> result<string, string>
import { targetBase, targetToken } from "./target.js";

export default async function get_events(
    executionId,
    cursorKind,
    cursor,
    includingCursor,
    length,
) {
    if (!executionId) throw "execution-id is required";
    const kind = cursorKind === "version_from" ? "version_from" : "version";
    const version = Number.isFinite(cursor) && cursor > 0 ? Math.trunc(cursor) : 0;
    const pageLength = Number.isFinite(length) && length > 0 ? Math.trunc(length) : 200;
    const params = [
        `${kind}=${encodeURIComponent(String(version))}`,
        `including_cursor=${includingCursor ? "true" : "false"}`,
        `length=${encodeURIComponent(String(pageLength))}`,
    ];
    const base = targetBase();
    const resp = await fetch(
        `${base}/v1/executions/${encodeURIComponent(executionId)}/events?${params.join("&")}`,
        { headers: { accept: "application/json", authorization: `Bearer ${targetToken()}` } },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
