// Read a deployment's owned JS/exec sources from the content-addressed store and
// diff two source sets, so the operator can see what a proposed hot-reload
// changes before approving it.

import { currentDeploymentId, getDeployment, readBlob } from "./obelisk-api.js";

// Sources of the currently active deployment, keyed by location. Returns {} if
// there is no current deployment or it cannot be read. /v1/deployment-id returns
// the active id as a JSON string; its manifest lives in the per-id GET.
export async function loadCurrentSources() {
    try {
        const id = await currentDeploymentId();
        if (!id || typeof id !== "string") return {};
        const dep = await getDeployment(id);
        return await collectSources(dep.deployment_toml);
    } catch (_) { return {}; }
}

// Extract { location -> source } for a deployment's owned JS/exec components. The
// manifest references each owned source by `location` + `content_digest`; the
// body is read from the content-addressed store.
export async function collectSources(deploymentToml) {
    const out = {};
    if (typeof deploymentToml !== "string") return out;
    for (const ref of ownedScriptRefs(deploymentToml)) {
        try {
            out[ref.location] = await readBlob(ref.digest);
        } catch (_) { /* skip an unreadable blob */ }
    }
    return out;
}

// Scan top-level component blocks for owned sources: a non-oci `location` paired
// with a `content_digest` in the same main table.
function ownedScriptRefs(toml) {
    const refs = [];
    let location = null;
    let digest = null;
    let inTable = false;
    const flush = () => {
        if (location && digest && !location.startsWith("oci://")) refs.push({ location, digest });
        location = null;
        digest = null;
    };
    for (const line of toml.split("\n")) {
        const t = line.trim();
        if (t.startsWith("[[") && !t.includes(".")) { flush(); inTable = true; continue; }
        if (t.startsWith("[")) { inTable = false; continue; }   // sub-table: skip its keys
        if (!inTable) continue;
        const loc = tomlString(t, "location");
        if (loc !== null) location = loc;
        const dig = tomlString(t, "content_digest");
        if (dig !== null) digest = dig;
    }
    flush();
    return refs;
}

function tomlString(line, key) {
    if (!line.startsWith(key)) return null;
    const rest = line.slice(key.length).trim();
    if (!rest.startsWith("=")) return null;
    const v = rest.slice(1).trim();
    if (v.length < 2 || v[0] !== '"' || v[v.length - 1] !== '"') return null;
    return v.slice(1, -1);
}

// Compare two { fileName -> source } maps. Added and removed entries include
// their complete source so the approval card always shows the actual change.
export function diffSources(oldMap, newMap) {
    const oldKeys = new Set(Object.keys(oldMap));
    const newKeys = new Set(Object.keys(newMap));
    const added = [...newKeys].filter((k) => !oldKeys.has(k)).sort()
        .map((file) => ({ file, lines: lineDiff("", newMap[file]).filter((line) => line.tag === "+") }));
    const removed = [...oldKeys].filter((k) => !newKeys.has(k)).sort()
        .map((file) => ({ file, lines: lineDiff(oldMap[file], "").filter((line) => line.tag === "-") }));
    const changed = [];
    for (const k of [...newKeys].filter((x) => oldKeys.has(x)).sort()) {
        if (oldMap[k] !== newMap[k]) {
            changed.push({ file: k, lines: lineDiff(oldMap[k], newMap[k]) });
        }
    }
    return { added, removed, changed };
}

// Minimal line-level diff via an LCS table. Returns a list of
// { tag: " "|"-"|"+", text } rows, like a unified diff body.
function lineDiff(oldText, newText) {
    const a = String(oldText).split("\n");
    const b = String(newText).split("\n");
    const n = a.length, m = b.length;
    const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1
                : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    const rows = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { rows.push({ tag: " ", text: a[i] }); i += 1; j += 1; }
        else if (lcs[i + 1][j] >= lcs[i][j + 1]) { rows.push({ tag: "-", text: a[i] }); i += 1; }
        else { rows.push({ tag: "+", text: b[j] }); j += 1; }
    }
    while (i < n) { rows.push({ tag: "-", text: a[i] }); i += 1; }
    while (j < m) { rows.push({ tag: "+", text: b[j] }); j += 1; }
    return rows;
}
