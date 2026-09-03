// obelisk-agent:mounts/apps.request:
//   func(method: string, params-json: string) -> result<string, string>
//
// The transport behind every lazily-mounted GitHub repo tree in the session
// VFS (see vendor/just-bash-rs/src/obelisk_web.rs). One activity invocation
// issues one or more GitHub contents-API requests against the repo named in
// params. Two methods:
//
//   list  params { owner, repo, ref, path } -> JSON array of { name, type: "file"|"dir", sha, size }
//   read  params { owner, repo, ref, path } -> the file's raw text body
//   resolve-ref  params { owner, repo, ref } -> the commit SHA for ref
//
// `owner`/`repo` are required; `ref` defaults to "main". These come from the
// session's APPS_JSON registry (activity/config-discover.js), not from fixed
// per-block env vars, so one deployed activity backs every mounted repo.
//
// Symlinks are resolved here. The contents API reports a link as
// {"type":"symlink","target"} and never follows one: any path passing through
// a link is a plain 404, so a repo alias (e.g. a `latest -> vX.Y` directory
// link) would be invisible without rewriting. Listings surface symlinked
// directories like ordinary "dir" entries (the mounted repos only ever link
// directories); `list` and `read` then follow links until they reach a real
// tree or blob.
//
// The deployment's allowed_host grants GET on the GitHub contents API scoped
// to one operator-configured owner (GH_OWNER in deployment.rs.toml's
// request_url_regex); GITHUB_TOKEN is an optional secret the runtime swaps
// into the Authorization header for a private repo or a higher rate limit.
// Any HTTP or transport failure becomes the err arm (a throw).

const API_BASE = "https://api.github.com";
const JSON_ACCEPT = "application/vnd.github+json";
const RAW_ACCEPT = "application/vnd.github.raw";
// Cycle guard for chains such as a -> b -> a.
const MAX_LINK_HOPS = 10;

export default async function githubContents(method, paramsJson) {
    const m = typeof method === "string" ? method.trim() : "";
    if (m !== "list" && m !== "read" && m !== "resolve-ref") throw `unknown method '${m}'`;
    const params = parseParams(paramsJson);
    const repo = {
        owner: requiredParam(params, "owner"),
        repo: requiredParam(params, "repo"),
        ref: typeof params.ref === "string" && params.ref ? params.ref : "main",
    };
    if (m === "resolve-ref") return await resolveRef(repo);
    const path = typeof params.path === "string" ? normalize(params.path) : "";
    if (m === "list") return JSON.stringify(await list(repo, path));
    return await read(repo, path);
}

async function resolveRef(repo) {
    const url = `${API_BASE}/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(repo.ref)}`;
    const res = await requestUrl(url, JSON_ACCEPT);
    if (!res.ok) throw httpError(res.status, `commit ${repo.ref}`, res.text);
    let body;
    try {
        body = JSON.parse(res.text);
    } catch (e) {
        throw `commit response is not JSON: ${String(e)}`;
    }
    const sha = body?.sha;
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) {
        throw `commit response for ${repo.ref} has no commit SHA`;
    }
    return sha;
}

async function list(repo, path) {
    const found = await resolveEntry(repo, path, "dir");
    return found.listing
        .filter((entry) => entry && typeof entry.name === "string" && entry.name)
        .map((entry) => {
            if (entry.type === "file")
                return {
                    name: String(entry.name),
                    type: "file",
                    sha: typeof entry.sha === "string" ? entry.sha : "",
                    size: Number(entry.size) || 0,
                };
            // Real trees and symlinks alike surface as directories; reads and
            // listings through the link resolve because both follow links.
            return { name: String(entry.name), type: "dir", size: 0 };
        });
}

async function read(repo, path) {
    if (!path) throw "read requires a file path";
    // Fast path for an unbroken path: one request. The VFS never asks to read
    // a final component that is itself a link (listings label those as dirs),
    // so a 404 here means some prefix needs rewriting.
    const direct = await fetchBody(repo, path, RAW_ACCEPT);
    if (direct !== null) return direct;
    const found = await resolveEntry(repo, path, "file");
    const body = await fetchBody(repo, found.path, RAW_ACCEPT);
    if (body === null) throw `${found.path} not found`;
    return body;
}

// Locate `path`'s real entry by following symlinks. Returns
// { path } for want="file" or { path, listing } for want="dir".
async function resolveEntry(repo, path, want) {
    let current = path;
    let hops = 0;
    for (;;) {
        const probe = await metaOrNull(repo, current);
        if (probe !== null && !Array.isArray(probe)) {
            if (probe.type === "symlink" && typeof probe.target === "string") {
                current = joinFrom(dirname(current), probe.target);
                hops += 1;
            } else if (want === "file") {
                return { path: current };
            } else {
                throw `${current || "/"} is not a directory`;
            }
        } else if (Array.isArray(probe)) {
            if (want === "dir") return { path: current, listing: probe };
            throw `${current} is a directory`;
        } else {
            // 404: some component along the way is a symlinked directory
            // pointing elsewhere; rewrite the whole path against the real tree.
            const rewritten = await rewriteComponents(repo, current);
            if (rewritten === null) throw notFound(path);
            current = rewritten;
            hops += 1;
        }
        if (hops > MAX_LINK_HOPS) throw `${path || "/"}: too many symlink hops`;
    }
}

// Walk `path` component by component from the repo root, replacing each
// symlinked component with its target. Returns the rewritten path, or null
// when a component genuinely does not exist.
async function rewriteComponents(repo, path) {
    let base = "";
    for (const segment of path.split("/")) {
        if (!segment) continue;
        const candidate = base ? `${base}/${segment}` : segment;
        const probe = await metaOrNull(repo, candidate);
        if (probe === null) return null;
        base =
            !Array.isArray(probe) && probe.type === "symlink" && typeof probe.target === "string"
                ? joinFrom(base, probe.target)
                : candidate;
    }
    return base;
}

// GET a contents path as JSON metadata; null on 404 so callers can fall back
// to resolution. Any other non-OK status throws.
async function metaOrNull(repo, path) {
    const res = await request(repo, path, JSON_ACCEPT);
    if (res.status === 404) return null;
    if (!res.ok) throw httpError(res.status, path, res.text);
    try {
        return JSON.parse(res.text);
    } catch (e) {
        throw `contents response is not JSON: ${String(e)}`;
    }
}

// GET a contents path expecting a raw body; null on 404.
async function fetchBody(repo, path, accept) {
    const res = await request(repo, path, accept);
    if (res.status === 404) return null;
    if (!res.ok) throw httpError(res.status, path, res.text);
    return res.text;
}

async function request(repo, path, accept) {
    const encoded = encodePath(path);
    const suffix = encoded ? `/${encoded}` : "";
    const url = `${API_BASE}/repos/${repo.owner}/${repo.repo}/contents${suffix}?ref=${encodeURIComponent(repo.ref)}`;
    return await requestUrl(url, accept);
}

async function requestUrl(url, accept) {
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
    let text = "";
    try {
        text = await resp.text();
    } catch (_) {}
    return { ok: resp.ok, status: resp.status, text };
}

function httpError(status, path, text) {
    return `GitHub HTTP ${status} for ${path || "/"}: ${text.slice(0, 500)}`;
}

function notFound(path) {
    return `${path || "/"} not found`;
}

// Directory of `path`; "" when the path has no separator (repo-root level).
function dirname(path) {
    const cut = path.lastIndexOf("/");
    return cut === -1 ? "" : path.slice(0, cut);
}

// Join a symlink target onto its link's directory. Absolute targets ("/x/y")
// are repo-root-relative, matching how these repos use them; trailing slashes
// and "." / ".." segments collapse away.
function joinFrom(dir, target) {
    return normalize(`${dir}/${target}`);
}

function normalize(path) {
    const out = [];
    for (const segment of String(path).split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") out.pop();
        else out.push(segment);
    }
    return out.join("/");
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

function requiredParam(params, name) {
    const value = params[name];
    if (typeof value !== "string" || !value) throw `params-json has no ${name}`;
    return value;
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
