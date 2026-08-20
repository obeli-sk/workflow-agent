// obelisk-agent:mounts/<name>.request:
//   func(method: string, params-json: string) -> result<string, string>
//
// The transport behind a lazily-mounted GitHub repo tree in the session VFS
// (see vendor/just-bash-rs/src/obelisk_web.rs). One activity invocation is one
// GitHub contents-API request. Two methods:
//
//   list  params { path } -> JSON array of { name, type: "file"|"dir", size }
//   read  params { path } -> the file's raw text body
//
// A single github-contents.js is reused by every mount block; each block sets
// the fixed env vars GH_OWNER, GH_REPO, GH_REF and, for a private repo, exposes
// the placeholder secret GITHUB_TOKEN the runtime swaps into the Authorization
// header. Any HTTP or transport failure becomes the err arm (a throw).

const API_BASE = "https://api.github.com";

export default async function githubContents(method, paramsJson) {
    const m = typeof method === "string" ? method.trim() : "";
    const params = parseParams(paramsJson);
    const path = typeof params.path === "string" ? params.path : "";
    if (m === "list") return JSON.stringify(await list(path));
    if (m === "read") return await read(path);
    throw `unknown method '${m}'`;
}

async function list(path) {
    const body = await fetchContents(path, "application/vnd.github+json");
    let parsed;
    try {
        parsed = JSON.parse(body);
    } catch (e) {
        throw `contents response is not JSON: ${String(e)}`;
    }
    if (!Array.isArray(parsed)) throw `${path || "/"} is not a directory`;
    return parsed
        .filter((entry) => entry && (entry.type === "file" || entry.type === "dir"))
        .map((entry) => ({
            name: String(entry.name),
            type: entry.type,
            size: entry.type === "file" ? Number(entry.size) || 0 : 0,
        }));
}

async function read(path) {
    if (!path) throw "read requires a file path";
    return await fetchContents(path, "application/vnd.github.raw");
}

async function fetchContents(path, accept) {
    const owner = required("GH_OWNER");
    const repo = required("GH_REPO");
    const ref = process.env["GH_REF"] || "main";
    const encoded = encodePath(path);
    const suffix = encoded ? `/${encoded}` : "";
    const url = `${API_BASE}/repos/${owner}/${repo}/contents${suffix}?ref=${encodeURIComponent(ref)}`;
    const headers = {
        accept,
        "user-agent": "workflow-agent",
        "x-github-api-version": "2022-11-28",
    };
    const token = process.env["GITHUB_TOKEN"];
    if (token) headers["authorization"] = `Bearer ${token}`;

    let resp;
    try {
        resp = await fetch(url, { method: "GET", headers });
    } catch (e) {
        throw `GitHub request failed: ${String(e)}`;
    }
    const text = await safeText(resp);
    if (!resp.ok) throw `GitHub HTTP ${resp.status} for ${path || "/"}: ${text.slice(0, 500)}`;
    return text;
}

// Encode a repo-relative path segment-by-segment so `/` stays a separator while
// each name is URL-safe. An empty path lists the repo root.
function encodePath(path) {
    return String(path)
        .split("/")
        .filter((segment) => segment.length > 0)
        .map(encodeURIComponent)
        .join("/");
}

function required(name) {
    const value = process.env[name];
    if (!value) throw `${name} is not configured`;
    return String(value);
}

function parseParams(paramsJson) {
    if (paramsJson === undefined || paramsJson === null || paramsJson === "") return {};
    let parsed;
    try {
        parsed = JSON.parse(paramsJson);
    } catch (e) {
        throw `params-json is not valid JSON: ${String(e)}`;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    throw "params-json must be a JSON object";
}

async function safeText(resp) {
    try {
        return await resp.text();
    } catch (_) {
        return "";
    }
}
