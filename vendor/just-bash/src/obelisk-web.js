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
//   "list" -> params {owner, repo, ref, path: remotePath}, result a JSON
//             array of {name, type: "file"|"dir", size} entries.
//   "read" -> params {owner, repo, ref, path: remotePath}, result the file's
//             raw text body (not JSON - a plain string result).
//
// `host` is duck-typed as `{ callJson(ffqn, paramsJson) -> string|null }`
// (throws on error); see obelisk-program.js's header comment for why.

// `repo` is `{owner, repo, ref}`, the fixed extra params sent alongside `path`
// on every list/read call.
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
    const params = JSON.stringify({
        owner: repo.owner,
        repo: repo.repo,
        ref: repo.ref,
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

function parseEntry(entry) {
    const name = entry?.name;
    if (typeof name !== "string" || !name || name.includes("/")) {
        throw "mount entry has no usable name";
    }
    if (entry?.type === "dir") return { name, kind: "dir" };
    if (entry?.type === "file") {
        const size = typeof entry.size === "number" ? entry.size : 0;
        return { name, kind: "file", size };
    }
    throw `mount entry ${name} has unknown type ${JSON.stringify(entry?.type)}`;
}
