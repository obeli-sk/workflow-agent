// obelisk-agent:tools/webapi.get-responses:
//   func(execution-id: string, cursor: u32, including-cursor: bool,
//        length: u32) -> result<string, string>
export default async function get_responses(executionId, cursor, includingCursor, length) {
    if (!executionId) throw "execution-id is required";
    const current = Number.isFinite(cursor) && cursor > 0 ? Math.trunc(cursor) : 0;
    const pageLength = Number.isFinite(length) && length > 0 ? Math.trunc(length) : 200;
    const params = [
        `cursor=${encodeURIComponent(String(current))}`,
        `including_cursor=${includingCursor ? "true" : "false"}`,
        `length=${encodeURIComponent(String(pageLength))}`,
    ];
    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    const resp = await fetch(
        `${base}/v1/executions/${encodeURIComponent(executionId)}/responses?${params.join("&")}`,
        { headers: { accept: "application/json" } },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
