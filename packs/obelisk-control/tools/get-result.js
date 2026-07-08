// obelisk-agent:tools/webapi.get-result-json:
//   func(execution-id: string) -> result<string, string>
export default async function get_result_json(executionId) {
    if (!executionId) throw "execution-id is required";
    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    const resp = await fetch(
        `${base}/v1/executions/${encodeURIComponent(executionId)}?follow=true`,
        { headers: { accept: "application/json" } },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
