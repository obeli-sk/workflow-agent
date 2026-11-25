// Local stand-in for the GitHub contents API used by activity/github-contents.js.
// Usage: node e2e-github-server.mjs owner/repo=DIR...
// Serves DIR's git-tracked files (working-tree content) as that repo at every ref.
// Listens on a free port and prints it.
//   GET /repos/:owner/:repo/commits/:ref     -> { sha } (stable per repo and ref)
//   GET /repos/:owner/:repo/contents/:path   -> listing, file metadata or raw body
// Like GitHub, symlinks are reported as {type:"symlink",target} and never followed.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

// Untracked files (.env and the like) stay invisible.
function tracked(root) {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
    const children = new Map([["", new Set()]]);
    for (const file of files) {
        const parts = file.split("/");
        for (let i = 1; i <= parts.length; i++) {
            const parent = parts.slice(0, i - 1).join("/");
            if (!children.has(parent)) children.set(parent, new Set());
            children.get(parent).add(parts[i - 1]);
        }
    }
    return { root, files: new Set(files), children };
}

const repos = new Map(process.argv.slice(2).map((spec) => {
    const at = spec.indexOf("=");
    return [spec.slice(0, at), tracked(spec.slice(at + 1))];
}));

const sha1 = (data) => createHash("sha1").update(data).digest("hex");
const blobSha = (body) => sha1(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]));

function send(res, status, body, type = "application/json") {
    res.writeHead(status, { "content-type": type });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function entry(root, path) {
    const full = join(root, path);
    const stat = lstatSync(full);
    const name = path.split("/").pop() ?? "";
    if (stat.isSymbolicLink()) return { name, path, type: "symlink", target: readlinkSync(full), sha: sha1(path), size: 0 };
    if (stat.isDirectory()) return { name, path, type: "dir", sha: sha1(path), size: 0 };
    return { name, path, type: "file", sha: blobSha(readFileSync(full)), size: stat.size };
}

function contents(res, repo, segments, raw) {
    const { root, files, children } = repo;
    const path = segments.join("/");
    if (!files.has(path) && !children.has(path)) return send(res, 404, { message: "Not Found" });
    // A link anywhere before the last segment is a plain 404, as on GitHub.
    let meta;
    for (let i = 1; i <= segments.length; i++) {
        meta = entry(root, segments.slice(0, i).join("/"));
        if (meta.type === "symlink" && i < segments.length) return send(res, 404, { message: "Not Found" });
    }
    if (!meta || meta.type === "dir") {
        const names = [...children.get(path)].sort();
        return send(res, 200, names.map((n) => entry(root, path ? `${path}/${n}` : n)));
    }
    if (meta.type === "symlink") return raw ? send(res, 404, { message: "Not Found" }) : send(res, 200, meta);
    const body = readFileSync(join(root, path));
    if (raw) return send(res, 200, body, "application/vnd.github.raw");
    return send(res, 200, { ...meta, encoding: "base64", content: body.toString("base64") });
}

function route(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const repo = repos.get(`${parts[1]}/${parts[2]}`);
    if (req.method !== "GET" || parts[0] !== "repos" || repo === undefined) return send(res, 404, { message: "Not Found" });
    if (parts[3] === "commits" && parts.length === 5) return send(res, 200, { sha: sha1(`${parts[1]}/${parts[2]}@${parts[4]}`) });
    if (parts[3] === "contents") return contents(res, repo, parts.slice(4), (req.headers.accept ?? "").includes("raw"));
    send(res, 404, { message: "Not Found" });
}

const server = createServer((req, res) => {
    try {
        route(req, res);
    } catch (e) {
        console.error(`${req.url}: ${e}`);
        send(res, 500, { message: String(e) });
    }
});
server.listen(0, "127.0.0.1", () => console.log(`fake github listening on ${server.address().port}`));
