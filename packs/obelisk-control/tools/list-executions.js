// obelisk-agent:tools/webapi.list-executions:
//   func(ffqn-prefix: string, execution-id-prefix: string, show-derived: bool,
//        hide-finished: bool, component-digest: string, deployment-id: string,
//        cursor: string, direction: string, including-cursor: bool, length: u32)
//     -> result<string, string>
export default async function list_executions(
    ffqnPrefix,
    executionIdPrefix,
    showDerived,
    hideFinished,
    componentDigest,
    deploymentId,
    cursor,
    direction,
    includingCursor,
    length,
) {
    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    // The activity JS runtime has no URLSearchParams; build the query manually.
    const params = [];
    if (ffqnPrefix) params.push(`ffqn_prefix=${encodeURIComponent(ffqnPrefix)}`);
    if (executionIdPrefix) {
        params.push(`execution_id_prefix=${encodeURIComponent(executionIdPrefix)}`);
    }
    if (showDerived) params.push("show_derived=true");
    if (hideFinished) params.push("hide_finished=true");
    if (componentDigest) params.push(`component_digest=${encodeURIComponent(componentDigest)}`);
    if (deploymentId) params.push(`deployment_id=${encodeURIComponent(deploymentId)}`);
    if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
    if (direction) params.push(`direction=${encodeURIComponent(direction)}`);
    if (includingCursor) params.push("including_cursor=true");
    if (length > 0) params.push(`length=${encodeURIComponent(String(length))}`);
    const qs = params.length ? `?${params.join("&")}` : "";
    const resp = await fetch(`${base}/v1/executions${qs}`, { headers: { accept: "application/json" } });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
