// obelisk-agent:tools/webapi.get-logs:
//   func(execution-id: string, show-derived: bool, show-logs: bool,
//        show-streams: bool, levels: list<string>, stream-types: list<string>,
//        cursor: string, direction: string, including-cursor: bool, length: u32)
//     -> result<string, string>
export default async function get_logs(
    executionId,
    showDerived,
    showLogs,
    showStreams,
    levels,
    streamTypes,
    cursor,
    direction,
    includingCursor,
    length,
) {
    if (!executionId) throw "execution-id is required";
    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    const params = [
        `show_derived=${showDerived ? "true" : "false"}`,
        `show_logs=${showLogs ? "true" : "false"}`,
        `show_streams=${showStreams ? "true" : "false"}`,
    ];
    for (const level of levels || []) params.push(`level=${encodeURIComponent(level)}`);
    for (const streamType of streamTypes || []) {
        params.push(`stream_type=${encodeURIComponent(streamType)}`);
    }
    if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
    if (direction) params.push(`direction=${encodeURIComponent(direction)}`);
    if (includingCursor) params.push("including_cursor=true");
    if (length > 0) params.push(`length=${encodeURIComponent(String(length))}`);
    const resp = await fetch(
        `${base}/v1/executions/${encodeURIComponent(executionId)}/logs?${params.join("&")}`,
        { headers: { accept: "application/json" } },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
