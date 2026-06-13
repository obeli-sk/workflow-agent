// obelisk-agent:tools/webapi.get-component-source:
//   func(deployment-id: string, component: string,
//        offset: u32, length: u32) -> result<string, string>
//
// One component's source, sliced server-side and paginated by character offset
// (length 0 => default page). Doing the slice here keeps the durable
// child-execution result (and the UI) equal to the page the model receives,
// instead of the whole deployment. Returns
//   { kind, component_id, ffqn, file_name, source_bytes, offset, length,
//     next_offset, raw_body }
// where raw_body is the page; server.js renders it to the model verbatim.
const MAX_PAGE = 32 * 1024;
const JS_COMPONENTS = [
    { kind: "js_activity", key: "activities_js", componentType: "activity" },
    { kind: "js_workflow", key: "workflows_js", componentType: "workflow" },
    { kind: "js_webhook", key: "webhooks_js", componentType: "webhook_endpoint" },
];

export default async function get_component_source(deploymentId, component, offset, length) {
    if (!deploymentId) throw "deployment-id is required";
    if (!component) throw "component is required";

    const base = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    const [deploymentResp, componentsResp] = await Promise.all([
        fetch(
            `${base}/v1/deployments/${encodeURIComponent(deploymentId)}`,
            { headers: { accept: "application/json" } },
        ),
        fetch(
            `${base}/v1/components?deployment_id=${encodeURIComponent(deploymentId)}`,
            { headers: { accept: "application/json" } },
        ),
    ]);
    if (!deploymentResp.ok) {
        throw `deployment HTTP ${deploymentResp.status}: ${await deploymentResp.text()}`;
    }
    if (!componentsResp.ok) {
        throw `components HTTP ${componentsResp.status}: ${await componentsResp.text()}`;
    }
    const config = JSON.parse(JSON.parse(await deploymentResp.text()).config_json);
    const componentRecords = JSON.parse(await componentsResp.text());
    if (!Array.isArray(componentRecords)) throw "invalid components response";
    const candidates = JS_COMPONENTS.flatMap(({ kind, key, componentType }) => {
        const list = Array.isArray(config[key]) ? config[key] : [];
        return list.map((item) => {
            const record = componentRecords.find(({ component_id: id }) =>
                id?.component_type === componentType && id?.name === item?.name);
            const componentId = record?.component_id || null;
            return {
                kind,
                item,
                componentId,
                componentIdString: componentId
                    ? `${componentId.component_type}:${componentId.name}:${componentId.component_digest}`
                    : null,
            };
        });
    });
    const componentIdMatches = candidates.filter(
        (candidate) => candidate.componentIdString === component,
    );
    const ffqnMatches = candidates.filter(({ item }) => item?.ffqn === component);
    const matches = componentIdMatches.length > 0
        ? componentIdMatches
        : (ffqnMatches.length > 0
            ? ffqnMatches
            : candidates.filter(({ item }) => item?.name === component));
    if (matches.length === 0) {
        throw `no JS component with ComponentId, FFQN, or name ${component} in ${deploymentId}`;
    }
    if (matches.length > 1) {
        const choices = matches.map(({ kind, item }) => `${kind}:${item.ffqn || item.name}`);
        throw `ambiguous component selector ${component}; use an FFQN: ${choices.join(", ")}`;
    }
    const { kind, item, componentId } = matches[0];
    const content = item.location && item.location.content && item.location.content.content;
    if (typeof content !== "string") throw `${kind} ${item.name} has no inline source`;

    const total = content.length;
    let off = Number.isFinite(offset) ? Math.trunc(offset) : 0;
    if (off < 0) off = 0;
    if (off > total) off = total;
    let len = Number.isFinite(length) && length > 0 ? Math.trunc(length) : MAX_PAGE;
    if (len > MAX_PAGE) len = MAX_PAGE;
    const slice = content.slice(off, off + len);
    const nextOffset = off + slice.length;
    return JSON.stringify({
        kind,
        component_id: componentId,
        ffqn: item.ffqn || null,
        file_name: item.location.content.file_name,
        source_bytes: total,
        offset: off,
        length: slice.length,
        next_offset: nextOffset < total ? nextOffset : null,
        raw_body: slice,
    });
}
