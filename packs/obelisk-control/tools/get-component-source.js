// obelisk-agent:tools/webapi.get-component-source:
//   func(deployment-id: string, component: string,
//        offset: u32, length: u32) -> result<string, string>
//
// One component's owned script/exec source, fetched from the content-addressed
// store and sliced by character offset (length 0 => default page). Doing the
// slice here keeps the durable child-execution result (and the UI) equal to the
// page the model receives. The component is selected by FFQN (preferred) or
// name. Returns
//   { section, ffqn, name, location, content_digest, source_bytes, offset,
//     length, next_offset, raw_body }
const MAX_PAGE = 32 * 1024;

export default async function get_component_source(deploymentId, component, offset, length) {
    if (!deploymentId) throw "deployment-id is required";
    if (!component) throw "component is required";

    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    const resp = await fetch(
        `${base}/v1/deployments/${encodeURIComponent(deploymentId)}`,
        { headers: { accept: "application/json" } },
    );
    if (!resp.ok) throw `deployment HTTP ${resp.status}: ${await resp.text()}`;
    const record = JSON.parse(await resp.text());
    if (typeof record.deployment_toml !== "string") {
        throw `deployment ${deploymentId} has no deployment_toml`;
    }

    const match = findComponent(record.deployment_toml, component);
    if (!match) throw `no component with FFQN or name ${component} in ${deploymentId}`;
    if (!match.contentDigest) {
        throw `${match.section} ${match.ffqn || match.name} has no owned source (it is referenced by OCI/WASM, not a deployment file)`;
    }

    const blobResp = await fetch(`${base}/v1/files/${encodeURIComponent(match.contentDigest)}`);
    if (blobResp.status === 404) throw `no blob for digest ${match.contentDigest}`;
    if (!blobResp.ok) throw `file HTTP ${blobResp.status}: ${await blobResp.text()}`;
    const content = await blobResp.text();

    const total = content.length;
    let off = Number.isFinite(offset) ? Math.trunc(offset) : 0;
    if (off < 0) off = 0;
    if (off > total) off = total;
    let len = Number.isFinite(length) && length > 0 ? Math.trunc(length) : MAX_PAGE;
    if (len > MAX_PAGE) len = MAX_PAGE;
    const slice = content.slice(off, off + len);
    const nextOffset = off + slice.length;
    return JSON.stringify({
        section: match.section,
        ffqn: match.ffqn || null,
        name: match.name || null,
        location: match.location || null,
        content_digest: match.contentDigest,
        source_bytes: total,
        offset: off,
        length: slice.length,
        next_offset: nextOffset < total ? nextOffset : null,
        raw_body: slice,
    });
}

// Scan the manifest's top-level component blocks and return the first whose
// `ffqn` or `name` equals the selector, with its location/content_digest.
function findComponent(toml, selector) {
    const lines = toml.split("\n");
    let current = null;
    let found = null;
    const finish = () => {
        if (current && (current.ffqn === selector || current.name === selector)) {
            found = found || current;
        }
    };
    for (const line of lines) {
        const header = line.trim();
        if (header.startsWith("[[") && !header.includes(".")) {
            finish();
            current = { section: header.slice(2, header.indexOf("]")), ffqn: null, name: null, location: null, contentDigest: null };
            continue;
        }
        if (header.startsWith("[")) continue; // sub-table; keep accumulating into current
        if (!current) continue;
        const ffqn = keyStringValue(line, "ffqn");
        if (ffqn !== null) current.ffqn = ffqn;
        const name = keyStringValue(line, "name");
        if (name !== null) current.name = name;
        const location = keyStringValue(line, "location");
        if (location !== null) current.location = location;
        const digest = keyStringValue(line, "content_digest");
        if (digest !== null) current.contentDigest = digest;
    }
    finish();
    return found;
}

function keyStringValue(line, key) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(key)) return null;
    const rest = trimmed.slice(key.length).trim();
    if (!rest.startsWith("=")) return null;
    const value = rest.slice(1).trim();
    if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') return null;
    return value.slice(1, -1);
}
