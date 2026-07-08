// obelisk-agent:tools/webapi.get-deployment:
//   func(deployment-id: string, component-type: option<string>,
//        offset: option<u32>, length: option<u32>,
//        max-bytes: option<u32>) -> result<string, string>
//
// Returns the deployment record with its verbatim `deployment_toml` manifest.
// Deployment-owned script/exec sources are referenced by `location` +
// `content_digest`; fetch their bodies with webapi.get-component-source.
//
// The manifest is returned whole when it fits in the byte budget. For a large
// manifest, pass `offset`/`length` to page a byte window of `deployment_toml`
// (the `component-type` selector is accepted for compatibility but ignored).
const MAX_RESULT_BYTES = 96 * 1024;

export default async function get_deployment(deploymentId, componentType, offset, length, maxBytes) {
    if (!deploymentId) throw "deployment-id is required";
    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    const resp = await fetch(
        `${base}/v1/deployments/${encodeURIComponent(deploymentId)}`,
        { headers: { accept: "application/json" } },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    const record = JSON.parse(await resp.text());

    const budget = byteBudget(maxBytes);
    const toml = typeof record.deployment_toml === "string" ? record.deployment_toml : "";
    const total = toml.length;
    const off = clampOffset(offset, total);
    const requested = positiveInt(length);
    const windowEnd = requested > 0 ? Math.min(off + requested, total) : total;
    let slice = toml.slice(off, windowEnd);

    // Reserve room for the surrounding record metadata, then trim the manifest
    // window to fit the budget rather than failing outright.
    record.deployment_toml = "";
    let overhead = encodedBytes(record);
    if (slice.length + overhead > budget) {
        slice = slice.slice(0, Math.max(0, budget - overhead));
    }
    record.deployment_toml = slice;
    const returnedEnd = off + slice.length;
    record.manifest_window = {
        offset: off,
        returned: slice.length,
        total,
        next_offset: returnedEnd < total ? returnedEnd : null,
    };
    return JSON.stringify(record);
}

function encodedBytes(record) {
    return JSON.stringify(JSON.stringify(record)).length;
}

function byteBudget(value) {
    const requested = positiveInt(value);
    return requested > 0 ? Math.min(requested, MAX_RESULT_BYTES) : MAX_RESULT_BYTES;
}

function positiveInt(value) {
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function clampOffset(value, total) {
    const off = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
    return Math.min(off, total);
}
