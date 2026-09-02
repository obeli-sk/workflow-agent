// PORT: vendor/just-bash-rs/src/obelisk_mcp.rs
//
// Command adapters for stateless MCP servers.
//
// Each configured MCP server is one deployed activity with the uniform
// stateless-transport contract:
//
//   func(method: string, params-json: string) -> result<string, string>
//
// The function name is the operator-chosen server name. The session
// registers one just-bash command per server (`<server> tools|call|prompts|
// prompt|info`) plus a global `mcp` registry command. Every live MCP request
// bottoms out in one `host.callJson` to the server's activity, which
// performs the JSON-RPC-over-HTTP POST (`activity/mcp.js`); this module only
// translates shell subcommands into `(method, params-json)` and renders the
// result.
//
// `host` is duck-typed as `{ callJson(ffqn, paramsJson) -> string|null }`
// (throws on error), matching workflow-rs's `ObeliskHost` trait so this
// module is host-implementation-agnostic and testable with a plain fake (see
// obelisk-mcp.test.js) - no `obelisk` global required here. Custom-command
// handlers receive the full argv including argv[0] (see interpreter.js's
// `invoke`), unlike workflow-rs's `CustomCommandHandler` (argv[0] already
// stripped) - `args.slice(1)` below accounts for that, same as
// obelisk-program.js.
//
// See `apps/workflow-agent/docs/mcp.md` for the design.

import { utf8Decode } from "./utf8.js";

// Pseudo-method served inline by the transport activity (no HTTP): reports
// the configured endpoint URL and whether a bearer token is set, so
// `mcp list` can describe each server without reaching the network.
const CONFIG_METHOD = "client/config";

// A "server" is just a plain `{ name, ffqn }` object; a "registry" is a
// plain mutable array of them. Unlike workflow-rs's `Rc<RefCell<Vec<Server>>>`
// no extra indirection is needed - JS arrays are already reference types, so
// pushing to the array a caller handed to `registryCommandHandler` is
// visible on the next invocation.

// ===== resources: an MCP server's files, mounted lazily into the VFS ======
//
// A server that exposes files does so through the standard MCP resource
// methods: `resources/list` enumerates them (cheap, metadata only), and
// `resources/read` returns one resource's bytes on demand. This mirrors what
// the obelisk-control pack does with `deployment-checkout` (one listing)
// plus `deployment-read-blob` (lazy per-file fetch), so an MCP server can
// back the session VFS with no pack-specific host calls.
//
// The conventions this layer adds on top of the base spec:
//
//   * A resource's content digest travels in `_meta` under
//     RESOURCE_DIGEST_META_KEY, because `resources/list` has a standard
//     `size` field but no digest. The digest is the file's content identity,
//     used exactly as `deployment-checkout` digests are: the lazy-fetch/dedup
//     key and (later) submit re-pinning.
//   * The resource's VFS path is its `name` (the spec's logical/programmatic
//     name), so `uri` stays fully opaque: a stateless server is free to
//     encode the digest in the `uri` and answer `resources/read` in one call
//     without re-listing. A server that omits `name` falls back to a path
//     derived from the `uri`. The loader passes `uri` through verbatim and
//     keeps a digest -> uri map from the listing; the VFS itself only ever
//     sees the path and the sha256 digest it already understands, never a
//     uri.

// `_meta` key carrying a resource's `sha256:<hex>` content digest in
// `resources/list` output. `_meta` keys are namespaced (reverse-DNS prefix
// before the `/`); this is obeli.sk's. Change here and in the webhook
// together.
export const RESOURCE_DIGEST_META_KEY = "sk.obeli/content-digest";

// Guard against a server that never stops paginating `resources/list`.
const MAX_RESOURCE_PAGES = 1000;

// Enumerate a server's resources, following `nextCursor` across pages. Each
// entry must carry `size` and the RESOURCE_DIGEST_META_KEY digest, matching
// what `deployment-checkout` file entries provide today. Throws (a string)
// on any malformed page.
export function listResources(host, ffqn) {
    const out = [];
    let cursor;
    for (let page = 0; page < MAX_RESOURCE_PAGES; page++) {
        const params = cursor !== undefined ? { cursor } : {};
        const result = rpc(host, ffqn, "resources/list", params);
        const resources = result?.resources;
        if (!Array.isArray(resources)) throw "resources/list returned no resources array";
        for (const resource of resources) out.push(parseResource(resource));
        const next = result?.nextCursor;
        if (typeof next === "string" && next !== "") {
            cursor = next;
        } else {
            return out;
        }
    }
    throw "resources/list exceeded the maximum page count";
}

function parseResource(resource) {
    const uri = resource?.uri;
    if (typeof uri !== "string") throw "resource entry has no uri";
    const size = resource?.size;
    if (typeof size !== "number") throw `resource ${uri} has no size`;
    const digest = resource?._meta?.[RESOURCE_DIGEST_META_KEY];
    if (typeof digest !== "string") throw `resource ${uri} has no ${RESOURCE_DIGEST_META_KEY} in _meta`;
    if (!validSha256Digest(digest)) throw `resource ${uri} has an invalid sha256 digest`;
    const name = resource?.name;
    let path;
    if (typeof name === "string") {
        const trimmed = name.replace(/^\/+/, "");
        path = trimmed !== "" ? trimmed : uriToPath(uri);
    } else {
        path = uriToPath(uri);
    }
    if (path === "" || path.split("/").some((part) => part === "." || part === "..")) {
        throw `resource ${uri} has an unsafe VFS path`;
    }
    return { uri, path, digest, size };
}

function validSha256Digest(digest) {
    if (!digest.startsWith("sha256:")) return false;
    const hex = digest.slice("sha256:".length);
    return hex.length === 64 && /^[0-9a-fA-F]+$/.test(hex);
}

// The VFS-relative path for a resource URI: everything after
// `scheme://authority`, with any leading slash removed. `file:///a/b.toml`
// -> `a/b.toml`; `obelisk://host/components/w.wasm` -> `components/w.wasm`;
// a URI with no `://` is taken verbatim (leading slash trimmed).
function uriToPath(uri) {
    const schemeIdx = uri.indexOf("://");
    let afterScheme;
    if (schemeIdx === -1) {
        afterScheme = uri;
    } else {
        const rest = uri.slice(schemeIdx + 3);
        const slashIdx = rest.indexOf("/");
        afterScheme = slashIdx === -1 ? "" : rest.slice(slashIdx + 1);
    }
    return afterScheme.replace(/^\/+/, "");
}

// Mount a server's resources into `fs` under `mountDir`, lazily: list them
// once, register each as a pending VFS entry keyed by its sha256 digest, and
// install a loader that fetches a bounded file's bytes via `resources/read`
// on first access. `listHost` drives the listing; `loaderHost` is owned by
// the installed loader (a fetch-on-read closure, like the CAS loader).
// Returns the mounted refs.
export function mountResources(fs, listHost, loaderHost, ffqn, mountDir) {
    const refs = listResources(listHost, ffqn);
    const dir = mountDir.replace(/\/+$/, "");
    const loader = resourceLoader(loaderHost, ffqn, refs);
    for (const ref of refs) {
        fs.registerLazyWithLoader(`${dir}/${ref.path}`, ref.digest, ref.size, loader);
    }
    return refs;
}

// Register a server's resources as a *deferred* mount: the `resources/list`
// call (and lazy-read loader) run only when the session first references a
// path under `mountDir`, so a session that never opens this MCP tree never
// lists it. `listHost` drives the eventual listing; `loaderHost` is owned by
// the installed loader. A failed listing records the reason in
// `<mountDir>/.mcp-error`. Mirrors obelisk-pack.js's deferred-mount pattern.
export function registerDeferredMount(fs, listHost, loaderHost, ffqn, mountDir) {
    const root = mountDir.replace(/\/+$/, "");
    const populate = (vfs) => {
        try {
            mountResources(vfs, listHost, loaderHost, ffqn, root);
        } catch (err) {
            try {
                vfs.writeFile(`${root}/.mcp-error`, `resources not mounted: ${errorMessage(err)}`);
            } catch {
                // Best effort; nothing else to do if even the error file fails.
            }
        }
    };
    fs.registerDeferredMount(root, populate);
}

// The VFS blob loader for a resource-backed mount: read a file's bytes via
// `resources/read`, resolving the digest the VFS holds back to the URI the
// listing paired it with. Two resources with identical content share a
// digest and thus one URI, which is fine (the bytes are identical). Returns
// a `(digest) -> content` function, matching fs.js's loader contract
// (registerLazyWithLoader); the same function is shared (not recreated)
// across every resource, mirroring workflow-rs's `Rc<dyn BlobLoader>`.
function resourceLoader(host, ffqn, refs) {
    const uriByDigest = new Map(refs.map((ref) => [ref.digest, ref.uri]));
    return (digest) => {
        const uri = uriByDigest.get(digest);
        if (uri === undefined) throw `no MCP resource for digest ${digest}`;
        const result = rpc(host, ffqn, "resources/read", { uri });
        return resourceBytes(result);
    };
}

// Decode the first content item of a `resources/read` result to fs.js's
// string content convention: a `text` item is used verbatim; a `blob` item
// is base64 (RFC 4648) decoded to bytes and then UTF-8 decoded to a string,
// the same two-step base64/utf8 split `commands/hash.js`'s `base64 -d` uses
// (this dependency-free runtime has no Buffer/TextDecoder).
function resourceBytes(result) {
    const contents = result?.contents;
    const first = Array.isArray(contents) ? contents[0] : undefined;
    if (first === undefined) throw "resources/read returned no contents";
    if (typeof first.text === "string") return first.text;
    if (typeof first.blob === "string") return utf8Decode(base64Decode(first.blob));
    throw "resources/read content has neither text nor blob";
}

// Standard base64 decode (RFC 4648), skipping padding and any whitespace. No
// base64 crate/util is in the dependency set here and blob resources are the
// only caller.
function base64Decode(input) {
    function sextet(byte) {
        if (byte >= 0x41 && byte <= 0x5a) return byte - 0x41; // A-Z
        if (byte >= 0x61 && byte <= 0x7a) return byte - 0x61 + 26; // a-z
        if (byte >= 0x30 && byte <= 0x39) return byte - 0x30 + 52; // 0-9
        if (byte === 0x2b) return 62; // +
        if (byte === 0x2f) return 63; // /
        return undefined;
    }
    const out = [];
    let acc = 0;
    let bits = 0;
    for (let i = 0; i < input.length; i++) {
        const byte = input.charCodeAt(i);
        if (byte === 0x3d /* = */ || /\s/.test(input[i])) continue;
        const value = sextet(byte);
        if (value === undefined) throw `invalid base64 byte 0x${byte.toString(16)}`;
        acc = (acc << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((acc >> bits) & 0xff);
        }
    }
    return out;
}

// ===== server commands: `<server> tools|call|prompts|prompt|info` ========

// Adapt one configured server to a just-bash command:
// `<server> tools|call|prompts|prompt|info`.
export function serverCommandHandler(server, ffqn, host) {
    return (_interp, args, stdin) => {
        try {
            return runServer(server, ffqn, args.slice(1), stdin, host);
        } catch (err) {
            return fail(`${server}: ${errorMessage(err)}\n`);
        }
    };
}

function runServer(server, ffqn, args, stdin, host) {
    const sub = args[0] ?? "";
    const rest = args.slice(1);
    switch (sub) {
        case "":
        case "--help":
        case "help":
            return ok(serverHelp(server));
        case "tools":
            return runTools(server, ffqn, rest, stdin, host);
        case "call": {
            if (rest.length === 1 && rest[0] === "--help") return ok(callHelp(server));
            const tool = required(rest[0], "tool name");
            if (rest[1] === "--help") return ok(toolHelpFor(server, "call", tool, ffqn, host));
            return callTool(ffqn, tool, rest.slice(1), stdin, host);
        }
        case "prompts":
            return runPrompts(server, ffqn, rest, host);
        case "prompt": {
            if (rest.length === 1 && rest[0] === "--help") return ok(promptCollectionHelp(server, "prompt"));
            const name = required(rest[0], "prompt name");
            if (rest[1] === "--help") return ok(promptHelpFor(server, "prompt", name, ffqn, host));
            const argumentsValue = promptArguments(rest.slice(1));
            const result = rpc(host, ffqn, "prompts/get", { name, arguments: argumentsValue });
            return ok(renderPrompt(result));
        }
        case "info": {
            if (rest.length === 1 && rest[0] === "--help") {
                return ok(`Usage: ${server} info\n\nShow server metadata and capabilities.\n`);
            }
            const result = rpc(host, ffqn, "server/discover", {});
            return ok(ensureNewline(pretty(result)));
        }
        default:
            return fail(`${server}: unknown subcommand '${sub}'\n${serverHelp(server)}`);
    }
}

function runTools(server, ffqn, args, stdin, host) {
    if (args.length === 1 && args[0] === "--help") return ok(toolsHelp(server));
    const tool = args[0];
    if (tool === undefined) {
        const result = rpc(host, ffqn, "tools/list", {});
        return ok(prettyList(result, "tools"));
    }
    if (args[1] === "--help") return ok(toolHelpFor(server, "tools", tool, ffqn, host));
    return callTool(ffqn, tool, args.slice(1), stdin, host);
}

function callTool(ffqn, tool, args, stdin, host) {
    const argumentsValue = toolArguments(args, stdin);
    const result = rpc(host, ffqn, "tools/call", { name: tool, arguments: argumentsValue });
    return renderToolResult(result);
}

function runPrompts(server, ffqn, args, host) {
    if (args.length === 1 && args[0] === "--help") return ok(promptCollectionHelp(server, "prompts"));
    const name = args[0];
    if (name === undefined) {
        const result = rpc(host, ffqn, "prompts/list", {});
        return ok(prettyList(result, "prompts"));
    }
    if (args[1] === "--help") return ok(promptHelpFor(server, "prompts", name, ffqn, host));
    const argumentsValue = promptArguments(args.slice(1));
    const result = rpc(host, ffqn, "prompts/get", { name, arguments: argumentsValue });
    return ok(renderPrompt(result));
}

// ===== registry command: `mcp`/`mcp list`/`mcp tools` =====================

// Build the global `mcp` registry command: `mcp`/`mcp list` describes every
// registered server, `mcp tools` fans `tools/list` across all of them.
// `registry` is a plain array of `{ name, ffqn }`, read fresh on every
// invocation so servers registered after this handler is built are picked
// up.
export function registryCommandHandler(registry, host) {
    return (_interp, args, _stdin) => {
        try {
            return runRegistry(registry, args.slice(1), host);
        } catch (err) {
            return fail(`mcp: ${errorMessage(err)}\n`);
        }
    };
}

function runRegistry(registry, args, host) {
    const action = args[0] ?? "";
    const servers = registry.slice();
    if (action === "--help" || action === "help") return ok(registryHelp());
    if (action === "list" && args[1] === "--help") {
        return ok("Usage: mcp list\n\nList configured MCP servers with URL and auth status.\n");
    }
    if (action === "" || action === "list") {
        if (servers.length === 0) return ok("No MCP servers are configured.\n");
        let out = "";
        for (const server of servers) {
            // `client/config` is served inline by the transport (no HTTP), so
            // listing never reaches the network even when a server is down.
            let url = "";
            let auth = false;
            try {
                const cfg = rpc(host, server.ffqn, CONFIG_METHOD, {});
                url = typeof cfg?.url === "string" ? cfg.url : "";
                auth = cfg?.auth === true;
            } catch {
                url = "";
                auth = false;
            }
            const displayUrl = url === "" ? "<unset>" : url;
            out += `${server.name}  url=${displayUrl}  auth=${auth ? "yes" : "no"}\n`;
        }
        return ok(out);
    }
    if (action === "tools" && args[1] === "--help") {
        return ok("Usage: mcp tools\n\nList tools across all configured servers.\n");
    }
    if (action === "tools") {
        let out = "";
        for (const server of servers) {
            out += `## ${server.name}\n`;
            try {
                const result = rpc(host, server.ffqn, "tools/list", {});
                out += prettyList(result, "tools");
            } catch (err) {
                out += `error: ${errorMessage(err)}\n`;
            }
        }
        if (out === "") out = "No MCP servers are configured.\n";
        return ok(out);
    }
    return fail(`mcp: unknown subcommand '${action}'\n${registryHelp()}`);
}

// ===== transport =============================================================

// One MCP call: hand `(method, params-json)` to the server's transport
// activity and peel the JSON-RPC `result` back out. The activity's ok arm is
// a JSON string (the stringified result); `host.callJson` returns that
// string's JSON text, so it arrives quoted and is parsed once more here.
function rpc(host, ffqn, method, params) {
    const args = JSON.stringify([method, JSON.stringify(params)]);
    let raw;
    try {
        raw = host.callJson(ffqn, args);
    } catch (err) {
        throw errorMessage(err);
    }
    if (raw === null || raw === undefined) return null;
    let outer;
    try {
        outer = JSON.parse(raw);
    } catch (err) {
        throw `invalid mcp response JSON: ${err.message}`;
    }
    if (typeof outer === "string") {
        try {
            return JSON.parse(outer);
        } catch (err) {
            throw `invalid mcp result JSON: ${err.message}`;
        }
    }
    return outer;
}

function errorMessage(err) {
    if (typeof err === "string") return err;
    if (err && typeof err.message === "string") return err.message;
    return String(err);
}

// ===== rendering ============================================================

// A `tools/list` / `prompts/list` result: print the named array pretty when
// present, otherwise the whole result.
function prettyList(result, key) {
    const isRecord = result !== null && typeof result === "object" && !Array.isArray(result);
    if (isRecord && key in result) return ensureNewline(pretty(result[key]));
    return ensureNewline(pretty(result));
}

// A `tools/call` result (MCP `CallToolResult`): concatenate its text content
// to stdout; an `isError` result goes to stderr with a non-zero exit.
// Non-text content falls back to the raw JSON.
function renderToolResult(result) {
    const isError = result?.isError === true;
    const text = contentText(result?.content);
    const body = text === "" ? ensureNewline(pretty(result)) : ensureNewline(text);
    return isError ? fail(body) : ok(body);
}

// A `prompts/get` result (MCP `GetPromptResult`): render each message as
// `[role] text` to stdout. Prompts are user-initiated templates, surfaced for
// the user (or model) to paste into the conversation.
function renderPrompt(result) {
    const messages = result?.messages;
    if (!Array.isArray(messages)) return ensureNewline(pretty(result));
    let out = "";
    const desc = result?.description;
    if (typeof desc === "string" && desc !== "") out += `# ${desc}\n\n`;
    for (const message of messages) {
        const role = typeof message?.role === "string" ? message.role : "user";
        const text = contentText(message?.content);
        out += `[${role}] ${text}\n`;
    }
    return out;
}

// Extract concatenated `text` from an MCP content value, which is either a
// single content object or an array of them (`{ type: "text", text }`).
function contentText(content) {
    if (Array.isArray(content)) {
        return content.map((item) => (typeof item?.text === "string" ? item.text : "")).join("");
    }
    if (content !== null && typeof content === "object") {
        return typeof content.text === "string" ? content.text : "";
    }
    return "";
}

// ===== argument parsing ====================================================

// Accept one JSON object, `--arg key=value`, or ordinary `--key value` flags.
function toolArguments(args, stdin) {
    if (args[0] === "") {
        throw "call: arguments argument is empty (a shell expansion likely produced nothing); pass a JSON object such as {} explicitly";
    }
    if (args.length > 0 && !args[0].startsWith("--")) {
        if (args.length !== 1) throw "call: JSON arguments must be a single positional value";
        return parseArgumentObject(args[0]);
    }
    if (args.length === 0) {
        const text = stdin.trim();
        return text === "" ? {} : parseArgumentObject(text);
    }
    return flagArguments(args, "call", true);
}

function parseArgumentObject(text) {
    let value;
    try {
        value = JSON.parse(text);
    } catch (err) {
        throw `call: arguments is not valid JSON: ${err.message}`;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
    throw "call: arguments must be a JSON object";
}

// Prompt arguments are strings in MCP, but accept both generic and named
// flags.
function promptArguments(args) {
    return flagArguments(args, "prompt", false);
}

function flagArguments(args, command, parseJsonValues) {
    const map = {};
    let i = 0;
    while (i < args.length) {
        if (args[i] === "--arg") {
            const pair = args[i + 1];
            if (pair === undefined) throw `${command}: --arg requires a k=v value`;
            const eq = pair.indexOf("=");
            if (eq === -1) throw `${command}: --arg value '${pair}' is not k=v`;
            insertFlagValue(map, pair.slice(0, eq), pair.slice(eq + 1), parseJsonValues);
            i += 2;
        } else if (args[i].startsWith("--")) {
            const flag = args[i].slice(2);
            if (flag === "") throw `${command}: invalid argument '--'`;
            const eq = flag.indexOf("=");
            if (eq !== -1) {
                insertFlagValue(map, flag.slice(0, eq), flag.slice(eq + 1), parseJsonValues);
                i += 1;
            } else {
                const value = args[i + 1];
                if (value === undefined) throw `${command}: --${flag} requires a value`;
                insertFlagValue(map, flag, value, parseJsonValues);
                i += 2;
            }
        } else {
            throw `${command}: unexpected argument '${args[i]}'`;
        }
    }
    return map;
}

function insertFlagValue(map, key, value, parseJsonValue) {
    if (key === "") throw "argument name cannot be empty";
    let v = value;
    if (parseJsonValue) {
        try {
            v = JSON.parse(value);
        } catch {
            v = value;
        }
    }
    map[key] = v;
}

function required(value, label) {
    if (value !== undefined && value !== "") return value;
    throw `${label} is required`;
}

function pretty(value) {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function ensureNewline(text) {
    return text.endsWith("\n") ? text : `${text}\n`;
}

function ok(stdout) {
    return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr) {
    return { stdout: "", stderr, exitCode: 1 };
}

// ===== help text ============================================================

function toolHelpFor(server, command, name, ffqn, host) {
    const result = rpc(host, ffqn, "tools/list", {});
    const tool = namedEntry(result, "tools", name);
    if (!tool) throw `tool '${name}' was not found`;
    let out = `Usage: ${server} ${command} ${name} [OPTIONS]\n`;
    if (typeof tool.description === "string") out += `\n${tool.description}\n`;
    out += "\nOptions:\n";
    const schema = tool.inputSchema ?? tool.input_schema;
    const properties =
        schema && typeof schema.properties === "object" && !Array.isArray(schema.properties)
            ? schema.properties
            : undefined;
    const requiredNames = Array.isArray(schema?.required) ? schema.required : undefined;
    if (properties) {
        for (const [key, property] of Object.entries(properties)) {
            const kind = typeof property?.type === "string" ? property.type : "value";
            const marker = requiredNames?.includes(key) ? " (required)" : "";
            const description = typeof property?.description === "string" ? `  ${property.description}` : "";
            out += `  --${key} <${kind}>${marker}${description}\n`;
        }
    }
    out += "  --arg KEY=VALUE       Generic argument form; repeatable\n";
    out += "  --help                Show this help\n";
    out += "\nA JSON object can also be passed as one positional argument.\n";
    return out;
}

function promptHelpFor(server, command, name, ffqn, host) {
    const result = rpc(host, ffqn, "prompts/list", {});
    const prompt = namedEntry(result, "prompts", name);
    if (!prompt) throw `prompt '${name}' was not found`;
    let out = `Usage: ${server} ${command} ${name} [OPTIONS]\n`;
    if (typeof prompt.description === "string") out += `\n${prompt.description}\n`;
    out += "\nOptions:\n";
    if (Array.isArray(prompt.arguments)) {
        for (const argument of prompt.arguments) {
            const key = argument?.name;
            if (typeof key !== "string") continue;
            const marker = argument?.required === true ? " (required)" : "";
            const description = typeof argument?.description === "string" ? `  ${argument.description}` : "";
            out += `  --${key} <string>${marker}${description}\n`;
        }
    }
    out += "  --arg KEY=VALUE       Generic argument form; repeatable\n";
    out += "  --help                Show this help\n";
    return out;
}

function namedEntry(result, collection, name) {
    const list = result?.[collection];
    if (!Array.isArray(list)) return undefined;
    return list.find((entry) => entry?.name === name);
}

function toolsHelp(server) {
    return `Usage: ${server} tools [TOOL [OPTIONS]]\n\nList tools, or invoke TOOL directly.\n\nExamples:\n  ${server} tools\n  ${server} tools TOOL --help\n  ${server} tools TOOL --arg key=value\n  ${server} tools TOOL --key value\n`;
}

function callHelp(server) {
    return `Usage: ${server} call TOOL [OPTIONS|JSON-ARGS]\n\nCall a tool. Run \`${server} call TOOL --help\` for its schema.\n`;
}

function promptCollectionHelp(server, command) {
    return `Usage: ${server} ${command} [NAME [OPTIONS]]\n\nList prompts when NAME is omitted, or render one by name.\nRun \`${server} ${command} NAME --help\` for its arguments.\n`;
}

function serverHelp(server) {
    return `Usage: ${server} <subcommand>\n\nSubcommands:\n  tools [TOOL [OPTIONS]]    List tools or invoke one directly\n  call TOOL [OPTIONS|JSON]  Call a tool; args from stdin if omitted\n  prompts [NAME [OPTIONS]]  List prompts or render one directly\n  prompt NAME [OPTIONS]     Render a prompt to stdout\n  info                      Show server metadata (server/discover)\n`;
}

function registryHelp() {
    return "Usage: mcp <subcommand>\n\nSubcommands:\n  list        List configured MCP servers with URL and auth status (default)\n  tools       List tools across all configured servers\n";
}
