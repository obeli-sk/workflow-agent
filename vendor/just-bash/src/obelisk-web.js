// PORT: vendor/just-bash-rs/src/obelisk_web.rs
//
// Lazily-mounted remote directory tree (e.g. a GitHub repo browsed over the
// network), surfaced as an ordinary VFS folder via `fs.registerWebMount`
// (vendor/just-bash/src/fs.js). One deployed activity backs every mount
// (uniform stateless-transport signature, shared with obelisk-mcp.js):
//
//   func(method: string, params-json: string) -> result<string, string>
//
// Which repo a given mount browses is carried in params-json (`repo`, below),
// not baked into the activity, so a session can mount as many repos as its
// APPS_JSON registry lists:
//
//   "resolve-ref" -> params {owner, repo, ref}, result the commit SHA `ref`
//             resolves to (a plain string result).
//   "list" -> params {owner, repo, ref, path: remotePath}, result a JSON
//             array of {name, type: "file"|"dir", sha, size} entries.
//   "read" -> params {owner, repo, ref, path: remotePath}, result the file's
//             raw text body (not JSON - a plain string result).
//
// `repo.ref` is a requested ref (usually a branch), which can move
// mid-session. The first `list`/`read` call resolves it to a commit SHA via
// `resolve-ref` and caches it onto `repo.resolvedRef`, freezing every later
// call (and anything reading the same `repo` object, e.g. the `mount`
// listing) at that commit for the rest of the session.
//
// `host` is duck-typed as `{ callJson(ffqn, paramsJson) -> string|null }`
// (throws on error); see obelisk-program.js's header comment for why.

// `repo` is `{owner, repo, ref}` (extra fields are ignored), the fixed extra
// params sent alongside `path` on every list/read call; mutated in place with
// `resolvedRef` once the ref pins to a commit, so callers holding the same
// object (e.g. the app registry backing the `mount` listing) see it too.
export function mount(fs, host, ffqn, mountDir, repo) {
    const provider = {
        list(remotePath) {
            const body = call(host, ffqn, "list", remotePath, repo);
            let entries;
            try {
                entries = JSON.parse(body);
            } catch (error) {
                throw `list did not return JSON: ${error.message}`;
            }
            if (!Array.isArray(entries)) throw "list did not return a JSON array";
            return entries.map(parseEntry);
        },
        read(remotePath) {
            return call(host, ffqn, "read", remotePath, repo);
        },
    };
    fs.registerWebMount(mountDir.replace(/\/+$/, ""), "", provider);
}

// One transport call: hand `(method, {owner, repo, ref, path: remote})` to the
// activity and return the string it produced. `host.callJson`'s result is
// already the activity's JSON-text return value (a `string` WIT type), so it
// arrives quoted; peeling that single layer yields the activity's own string
// (a JSON array's text for "list", a raw file body for "read").
function call(host, ffqn, method, remotePath, repo) {
    const gitRef = pinnedRef(host, ffqn, repo);
    const params = JSON.stringify({
        owner: repo.owner,
        repo: repo.repo,
        ref: gitRef,
        path: remotePath,
    });
    const args = JSON.stringify([method, params]);
    const raw = host.callJson(ffqn, args);
    if (raw === null) return "";
    try {
        const parsed = JSON.parse(raw);
        return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    } catch {
        return raw;
    }
}

// Resolve `repo.ref` to a commit SHA on first use, caching it onto
// `repo.resolvedRef` so this mount stays frozen at that commit for the rest
// of the session.
function pinnedRef(host, ffqn, repo) {
    if (repo.resolvedRef) return repo.resolvedRef;
    const params = JSON.stringify({ owner: repo.owner, repo: repo.repo, ref: repo.ref });
    const args = JSON.stringify(["resolve-ref", params]);
    const raw = host.callJson(ffqn, args);
    let sha;
    try {
        sha = JSON.parse(raw ?? "null");
    } catch (e) {
        throw `could not decode commit for ${repo.owner}/${repo.repo}@${repo.ref}: ${String(e)}`;
    }
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) {
        throw `could not resolve ${repo.owner}/${repo.repo}@${repo.ref} to a commit SHA`;
    }
    repo.resolvedRef = sha;
    return sha;
}

function parseEntry(entry) {
    const name = entry?.name;
    if (typeof name !== "string" || !name || name.includes("/")) {
        throw "mount entry has no usable name";
    }
    if (entry?.type === "dir") return { name, kind: "dir" };
    if (entry?.type === "file") {
        const size = typeof entry.size === "number" ? entry.size : 0;
        if (typeof entry.sha !== "string" || !entry.sha) throw `mount file ${name} has no content digest`;
        return { name, kind: "file", digest: entry.sha, size };
    }
    throw `mount entry ${name} has unknown type ${JSON.stringify(entry?.type)}`;
}
