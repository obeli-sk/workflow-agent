// obelisk-agent:tools/webapi.get-events:
//   func(execution-id: string, cursor-kind: string, cursor: u32,
//        including-cursor: bool, length: u32) -> result<string, string>
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
    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    const resp = await fetch(
        `${base}/v1/executions/${encodeURIComponent(executionId)}/events?${params.join("&")}`,
        { headers: { accept: "application/json" } },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
