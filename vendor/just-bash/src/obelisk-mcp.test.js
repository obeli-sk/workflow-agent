import { test } from "node:test";
import assert from "node:assert/strict";
import { Vfs } from "./fs.js";
import {
    RESOURCE_DIGEST_META_KEY,
    listResources,
    mountResources,
    registerDeferredMount,
    registryCommandHandler,
    serverCommandHandler,
} from "./obelisk-mcp.js";

// A host keyed by ffqn: each fixture is either a canned `callJson` return
// value or an `Error` to throw. Records every `(ffqn, paramsJson)` call pair,
// mirroring the Rust tests' `host.calls[n]` assertions.
function fakeHost(fixtures) {
    const calls = [];
    return {
        calls,
        callJson(ffqn, paramsJson) {
            calls.push([ffqn, paramsJson]);
            const response = fixtures[ffqn];
            if (response === undefined) throw `no fixture for ${ffqn}`;
            if (response instanceof Error) throw response.message;
            return response;
        },
    };
}

// A host that routes by MCP method (and, for reads, by resource uri) so one
// fake can answer `resources/list` pages and `resources/read` calls, mirroring
// the Rust tests' `ResourceHost`.
function resourceHost({ pages = [], reads = {} } = {}) {
    const calls = [];
    return {
        calls,
        callJson(ffqn, paramsJson) {
            calls.push([ffqn, paramsJson]);
            const [method, paramsText] = JSON.parse(paramsJson);
            const inner = JSON.parse(paramsText);
            if (method === "resources/list") {
                const idx = typeof inner.cursor === "string" ? Number(inner.cursor.replace(/^p/, "")) || 0 : 0;
                const page = pages[idx];
                if (page === undefined) throw `no page ${idx}`;
                return page;
            }
            if (method === "resources/read") {
                const uri = inner.uri;
                if (!(uri in reads)) throw `no read fixture for ${uri}`;
                return reads[uri];
            }
            throw `unexpected method ${method}`;
        },
    };
}

// The activity's ok arm is a JSON string; `callJson` returns that string's
// JSON text (i.e. quoted), so a fixture must double-encode the payload -
// mirrors the Rust tests' `ok_arm`.
function okArm(payload) {
    return JSON.stringify(JSON.stringify(payload));
}

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;

// ===== server commands ======================================================

test("tools forwards method and prints the tool array", () => {
    const ffqn = "obelisk-agent:mcp/server.demo";
    const host = fakeHost({ [ffqn]: okArm({ tools: [{ name: "calculate", description: "adds" }] }) });
    const handler = serverCommandHandler("demo", ffqn, host);
    const out = handler(null, ["demo", "tools"], "");

    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /"calculate"/);
    assert.deepEqual(host.calls[0], [ffqn, JSON.stringify(["tools/list", "{}"])]);
});

test("tool help is generated from its discovered input schema", () => {
    const ffqn = "obelisk-agent:mcp/server.demo";
    const host = fakeHost({
        [ffqn]: okArm({
            tools: [
                {
                    name: "add",
                    description: "Add two numbers",
                    inputSchema: {
                        type: "object",
                        properties: {
                            a: { type: "number", description: "First number" },
                            b: { type: "number" },
                        },
                        required: ["a"],
                    },
                },
            ],
        }),
    });
    const handler = serverCommandHandler("demo", ffqn, host);
    const out = handler(null, ["demo", "tools", "add", "--help"], "");

    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /Usage: demo tools add \[OPTIONS\]/);
    assert.match(out.stdout, /--a <number> \(required\)  First number/);
    assert.match(out.stdout, /--b <number>\n/);
    assert.match(out.stdout, /--arg KEY=VALUE/);
    assert.equal(host.calls[0][1], JSON.stringify(["tools/list", "{}"]));
});

test("a missing tool for --help fails with a not-found error", () => {
    const ffqn = "obelisk-agent:mcp/server.demo";
    const host = fakeHost({ [ffqn]: okArm({ tools: [] }) });
    const handler = serverCommandHandler("demo", ffqn, host);
    const out = handler(null, ["demo", "tools", "missing", "--help"], "");

    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /tool 'missing' was not found/);
});

test("tools invokes a named tool with a mix of --arg and bare typed flags", () => {
    const ffqn = "obelisk-agent:mcp/server.demo";
    const host = fakeHost({ [ffqn]: okArm({ content: [{ type: "text", text: "4" }] }) });
    const handler = serverCommandHandler("demo", ffqn, host);
    const out = handler(null, ["demo", "tools", "add", "--arg", "a=1", "--b", "3"], "");

    assert.equal(out.stdout, "4\n");
    assert.equal(
        host.calls[0][1],
        JSON.stringify(["tools/call", JSON.stringify({ name: "add", arguments: { a: 1, b: 3 } })]),
    );
});

test("call forwards the tool name and a JSON positional, and renders text content", () => {
    const ffqn = "obelisk-agent:mcp/server.demo";
    const host = fakeHost({ [ffqn]: okArm({ content: [{ type: "text", text: "42" }] }) });
    const handler = serverCommandHandler("demo", ffqn, host);
    const out = handler(null, ["demo", "call", "calculate", '{"a":1}'], "");

    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "42\n");
    assert.equal(
        host.calls[0][1],
        JSON.stringify(["tools/call", JSON.stringify({ name: "calculate", arguments: { a: 1 } })]),
    );
});

test("call reads arguments from stdin when the positional is omitted", () => {
    const ffqn = "obelisk-agent:mcp/server.demo";
    const host = fakeHost({ [ffqn]: okArm({ content: [{ type: "text", text: "ok" }] }) });
    const handler = serverCommandHandler("demo", ffqn, host);
    handler(null, ["demo", "call", "t"], '{"b":2}');

    assert.equal(
        host.calls[0][1],
        JSON.stringify(["tools/call", JSON.stringify({ name: "t", arguments: { b: 2 } })]),
    );
});

test("call rejects an explicitly empty arguments positional before calling the host", () => {
    const ffqn = "obelisk-agent:mcp/server.demo";
    const host = fakeHost({ [ffqn]: okArm({}) });
    const handler = serverCommandHandler("demo", ffqn, host);
    const out = handler(null, ["demo", "call", "t", ""], "");

    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /arguments argument is empty/);
    assert.equal(host.calls.length, 0);
});

test("call rejects arguments that are not valid JSON, or not a JSON object", () => {
    const ffqn = "obelisk-agent:mcp/server.demo";
    const host = fakeHost({ [ffqn]: okArm({}) });
    const handler = serverCommandHandler("demo", ffqn, host);

    const badJson = handler(null, ["demo", "call", "t", "{not json"], "");
    assert.equal(badJson.exitCode, 1);
    assert.match(badJson.stderr, /arguments is not valid JSON/);

    const notObject = handler(null, ["demo", "call", "t", "[1,2]"], "");
    assert.equal(notObject.exitCode, 1);
    assert.match(notObject.stderr, /arguments must be a JSON object/);

    assert.equal(host.calls.length, 0);
});

test("an isError tool result goes to stderr with a nonzero exit code", () => {
    const ffqn = "obelisk-agent:mcp/server.demo";
    const host = fakeHost({
        [ffqn]: okArm({ isError: true, content: [{ type: "text", text: "boom" }] }),
    });
    const handler = serverCommandHandler("demo", ffqn, host);
    const out = handler(null, ["demo", "call", "t", "{}"], "");

    assert.equal(out.exitCode, 1);
    assert.equal(out.stderr, "boom\n");
});

test("prompt collects --arg pairs and renders role-prefixed messages", () => {
    const ffqn = "obelisk-agent:mcp/server.demo";
    const host = fakeHost({
        [ffqn]: okArm({
            description: "next tool",
            messages: [{ role: "user", content: { type: "text", text: "design it" } }],
        }),
    });
    const handler = serverCommandHandler("demo", ffqn, host);
    const out = handler(null, ["demo", "prompt", "design-next-tool", "--arg", "topic=math"], "");

    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /# next tool/);
    assert.match(out.stdout, /\[user\] design it/);
    assert.equal(
        host.calls[0][1],
        JSON.stringify(["prompts/get", JSON.stringify({ name: "design-next-tool", arguments: { topic: "math" } })]),
    );
});

test("prompt help and named flags use the discovered prompt arguments", () => {
    const ffqn = "obelisk-agent:mcp/server.demo";
    const listing = okArm({
        prompts: [
            {
                name: "greeting",
                description: "Greet someone",
                arguments: [{ name: "name", description: "Who to greet", required: true }],
            },
        ],
    });

    const helpHost = fakeHost({ [ffqn]: listing });
    const help = serverCommandHandler("demo", ffqn, helpHost)(null, ["demo", "prompt", "greeting", "--help"], "");
    assert.match(help.stdout, /Usage: demo prompt greeting \[OPTIONS\]/);
    assert.match(help.stdout, /--name <string> \(required\)  Who to greet/);

    const callHost = fakeHost({
        [ffqn]: okArm({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] }),
    });
    serverCommandHandler("demo", ffqn, callHost)(null, ["demo", "prompt", "greeting", "--name", "foo"], "");
    assert.equal(
        callHost.calls[0][1],
        JSON.stringify(["prompts/get", JSON.stringify({ name: "greeting", arguments: { name: "foo" } })]),
    );
});

test("prompt argument parsing rejects a malformed --arg pair", () => {
    const ffqn = "obelisk-agent:mcp/server.demo";
    const host = fakeHost({ [ffqn]: okArm({}) });
    const handler = serverCommandHandler("demo", ffqn, host);
    const out = handler(null, ["demo", "prompt", "greeting", "--arg", "notkv"], "");

    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /not k=v/);
    assert.equal(host.calls.length, 0);
});

test("info forwards to server/discover and pretty-prints the result", () => {
    const ffqn = "obelisk-agent:mcp/server.demo";
    const host = fakeHost({ [ffqn]: okArm({ name: "demo", version: "1.0" }) });
    const handler = serverCommandHandler("demo", ffqn, host);
    const out = handler(null, ["demo", "info"], "");

    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /"version": "1.0"/);
    assert.equal(host.calls[0][1], JSON.stringify(["server/discover", "{}"]));
});

test("a host error becomes a command failure prefixed with the command name", () => {
    const ffqn = "obelisk-agent:mcp/server.demo";
    const host = fakeHost({ [ffqn]: new Error("tool exploded") });
    const handler = serverCommandHandler("demo", ffqn, host);
    const out = handler(null, ["demo", "tools"], "");

    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /^demo: tool exploded\n$/);
});

test("an unknown subcommand reports the server help on stderr", () => {
    const ffqn = "obelisk-agent:mcp/server.demo";
    const handler = serverCommandHandler("demo", ffqn, fakeHost({}));
    const out = handler(null, ["demo", "bogus"], "");

    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /unknown subcommand 'bogus'/);
    assert.match(out.stderr, /Usage: demo/);
});

test("--help / help variants print usage text with no host call", () => {
    const ffqn = "obelisk-agent:mcp/server.demo";
    const host = fakeHost({});
    const handler = serverCommandHandler("demo", ffqn, host);

    assert.match(handler(null, ["demo"], "").stdout, /Usage: demo <subcommand>/);
    assert.match(handler(null, ["demo", "--help"], "").stdout, /Usage: demo <subcommand>/);
    assert.match(handler(null, ["demo", "tools", "--help"], "").stdout, /Usage: demo tools \[TOOL/);
    assert.match(handler(null, ["demo", "call", "--help"], "").stdout, /Usage: demo call TOOL/);
    assert.match(handler(null, ["demo", "prompts", "--help"], "").stdout, /Usage: demo prompts \[NAME/);
    assert.match(handler(null, ["demo", "prompt", "--help"], "").stdout, /Usage: demo prompt \[NAME/);
    assert.match(handler(null, ["demo", "info", "--help"], "").stdout, /Usage: demo info/);
    assert.equal(host.calls.length, 0);
});

// ===== registry command =====================================================

test("registry list reports url and auth from the client/config probe", () => {
    const ffqn = "obelisk-agent:mcp/server.demo";
    const registry = [{ name: "demo", ffqn }];
    const host = fakeHost({ [ffqn]: okArm({ url: "http://127.0.0.1:1071/mcp", auth: true }) });
    const handler = registryCommandHandler(registry, host);
    const out = handler(null, ["mcp"], "");

    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "demo  url=http://127.0.0.1:1071/mcp  auth=yes\n");
    assert.deepEqual(host.calls[0], [ffqn, JSON.stringify(["client/config", "{}"])]);
});

test("registry list reports 'no servers configured' and makes no host call", () => {
    const host = fakeHost({});
    const handler = registryCommandHandler([], host);
    const out = handler(null, ["mcp", "list"], "");

    assert.equal(out.stdout, "No MCP servers are configured.\n");
    assert.equal(host.calls.length, 0);
});

test("a down server's client/config probe never fails mcp list", () => {
    const upFfqn = "obelisk-agent:mcp/server.up";
    const downFfqn = "obelisk-agent:mcp/server.down";
    const registry = [
        { name: "up", ffqn: upFfqn },
        { name: "down", ffqn: downFfqn },
    ];
    const host = fakeHost({
        [upFfqn]: okArm({ url: "http://up/mcp", auth: false }),
        [downFfqn]: new Error("connection refused"),
    });
    const handler = registryCommandHandler(registry, host);
    const out = handler(null, ["mcp"], "");

    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "up  url=http://up/mcp  auth=no\ndown  url=<unset>  auth=no\n");
});

test("registry tools fans tools/list out across every configured server", () => {
    const aFfqn = "obelisk-agent:mcp/server.a";
    const bFfqn = "obelisk-agent:mcp/server.b";
    const registry = [
        { name: "a", ffqn: aFfqn },
        { name: "b", ffqn: bFfqn },
    ];
    const host = fakeHost({
        [aFfqn]: okArm({ tools: [{ name: "one" }] }),
        [bFfqn]: okArm({ tools: [{ name: "two" }] }),
    });
    const handler = registryCommandHandler(registry, host);
    const out = handler(null, ["mcp", "tools"], "");

    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /## a\n[\s\S]*"one"/);
    assert.match(out.stdout, /## b\n[\s\S]*"two"/);
});

test("registry tools reports 'no servers configured' with an empty registry", () => {
    const handler = registryCommandHandler([], fakeHost({}));
    const out = handler(null, ["mcp", "tools"], "");
    assert.equal(out.stdout, "No MCP servers are configured.\n");
});

test("registry mutations after handler construction are visible on the next call", () => {
    const ffqn = "obelisk-agent:mcp/server.late";
    const registry = [];
    const host = fakeHost({ [ffqn]: okArm({ url: "http://late/mcp", auth: false }) });
    const handler = registryCommandHandler(registry, host);

    assert.equal(handler(null, ["mcp"], "").stdout, "No MCP servers are configured.\n");
    registry.push({ name: "late", ffqn });
    assert.equal(handler(null, ["mcp"], "").stdout, "late  url=http://late/mcp  auth=no\n");
});

test("an unknown mcp subcommand reports the registry help on stderr", () => {
    const out = registryCommandHandler([], fakeHost({}))(null, ["mcp", "bogus"], "");
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /unknown subcommand 'bogus'/);
    assert.match(out.stderr, /Usage: mcp/);
});

// ===== resources: listing, uri->path mapping, and lazy read-by-uri =========

test("listResources reads size and _meta digest, and prefers name over the uri fallback", () => {
    assert.equal(RESOURCE_DIGEST_META_KEY, "sk.obeli/content-digest");
    const ffqn = "obelisk-agent:mcp/server.obelisk";
    const host = resourceHost({
        pages: [
            okArm({
                resources: [
                    // Opaque digest-encoded uri with a logical `name` path.
                    { uri: "obelisk-blob:sha256:aa", name: "deployment.toml", size: 12, _meta: { [RESOURCE_DIGEST_META_KEY]: DIGEST_A } },
                    // No `name`: the path falls back to the uri.
                    { uri: "obelisk://srv/components/w.wasm", size: 3_000_000, _meta: { [RESOURCE_DIGEST_META_KEY]: DIGEST_B } },
                ],
            }),
        ],
    });

    const refs = listResources(host, ffqn);
    assert.deepEqual(refs, [
        { uri: "obelisk-blob:sha256:aa", path: "deployment.toml", digest: DIGEST_A, size: 12 },
        { uri: "obelisk://srv/components/w.wasm", path: "components/w.wasm", digest: DIGEST_B, size: 3_000_000 },
    ]);
    assert.equal(host.calls[0][1], JSON.stringify(["resources/list", "{}"]));
});

test("listResources follows nextCursor across pages", () => {
    const ffqn = "obelisk-agent:mcp/server.obelisk";
    const host = resourceHost({
        pages: [
            okArm({ resources: [{ uri: "file:///a", size: 1, _meta: { [RESOURCE_DIGEST_META_KEY]: DIGEST_A } }], nextCursor: "p1" }),
            okArm({ resources: [{ uri: "file:///b", size: 1, _meta: { [RESOURCE_DIGEST_META_KEY]: DIGEST_B } }] }),
        ],
    });

    const refs = listResources(host, ffqn);
    assert.deepEqual(refs.map((r) => r.path), ["a", "b"]);
    assert.equal(host.calls.length, 2);
    assert.match(host.calls[1][1], /cursor/);
    assert.match(host.calls[1][1], /p1/);
});

test("a resource missing size, or missing the digest meta key, fails the listing", () => {
    const ffqn = "obelisk-agent:mcp/server.obelisk";
    const noSize = resourceHost({
        pages: [okArm({ resources: [{ uri: "file:///a", _meta: { [RESOURCE_DIGEST_META_KEY]: DIGEST_A } }] })],
    });
    assert.throws(() => listResources(noSize, ffqn), /no size/);

    const noDigest = resourceHost({ pages: [okArm({ resources: [{ uri: "file:///a", size: 1 }] })] });
    assert.throws(() => listResources(noDigest, ffqn), /sk\.obeli\/content-digest/);
});

test("an unsafe VFS path (../) is rejected", () => {
    const ffqn = "obelisk-agent:mcp/server.obelisk";
    const host = resourceHost({
        pages: [
            okArm({
                resources: [
                    {
                        uri: "sample://files/escape",
                        name: "../../escape",
                        size: 1,
                        _meta: { [RESOURCE_DIGEST_META_KEY]: DIGEST_A },
                    },
                ],
            }),
        ],
    });
    assert.throws(() => listResources(host, ffqn), /unsafe VFS path/);
});

test("mountResources registers lazy entries without fetching, then reads text and blob content on demand", () => {
    const ffqn = "obelisk-agent:mcp/server.obelisk";
    const listHost = resourceHost({
        pages: [
            okArm({
                resources: [
                    { uri: "file:///deployment.toml", size: 5, _meta: { [RESOURCE_DIGEST_META_KEY]: DIGEST_C } },
                    { uri: "file:///x.bin", size: 3, _meta: { [RESOURCE_DIGEST_META_KEY]: DIGEST_B } },
                ],
            }),
        ],
    });
    const loaderHost = resourceHost({
        reads: {
            "file:///deployment.toml": okArm({ contents: [{ uri: "file:///deployment.toml", text: "hello" }] }),
            // base64 "AAEC" -> bytes 0x00 0x01 0x02.
            "file:///x.bin": okArm({ contents: [{ uri: "file:///x.bin", blob: "AAEC" }] }),
        },
    });

    const fs = new Vfs();
    const refs = mountResources(fs, listHost, loaderHost, ffqn, "/workspace/deployment/current");
    assert.equal(refs.length, 2);

    // Listing registers structure without fetching any body.
    assert.equal(fs.isFile("/workspace/deployment/current/deployment.toml"), true);
    assert.equal(fs.isPending("/workspace/deployment/current/deployment.toml"), true);
    assert.equal(loaderHost.calls.length, 0, "no resources/read before an actual file read");

    assert.equal(fs.readFile("/workspace/deployment/current/deployment.toml"), "hello");
    assert.equal(fs.readFile("/workspace/deployment/current/x.bin"), "\u0000\u0001\u0002");
    assert.equal(loaderHost.calls.length, 2);
});

test("registerDeferredMount defers resources/list until first access and fires exactly once", () => {
    const ffqn = "obelisk-agent:mcp/server.srv";
    const page = okArm({
        resources: [{ uri: "file:///README.md", size: 5, _meta: { [RESOURCE_DIGEST_META_KEY]: DIGEST_A } }],
    });
    const listCalls = [];
    const listHost = {
        callJson(ffqnArg, params) {
            listCalls.push([ffqnArg, params]);
            return page;
        },
    };
    const loaderHost = {
        callJson() {
            throw "loader should not be reached in this test";
        },
    };

    const fs = new Vfs();
    registerDeferredMount(fs, listHost, loaderHost, ffqn, "/workspace/mcp/srv");

    // The root pre-exists (so it lists under its parent) but nothing fired yet.
    assert.equal(fs.isDir("/workspace/mcp/srv"), true);
    assert.equal(listCalls.length, 0);

    // A path outside the root does not fire it.
    fs.ensureMountedFor("/workspace/other");
    assert.equal(listCalls.length, 0);

    // The first matching access fires it exactly once; further accesses are no-ops.
    fs.ensureMountedFor("/workspace/mcp/srv/README.md");
    fs.ensureMountedFor("/workspace/mcp/srv");
    assert.equal(listCalls.length, 1);
    
});

test("a failed deferred-mount listing records the reason in .mcp-error, not a thrown error", () => {
    const ffqn = "obelisk-agent:mcp/server.srv";
    const listHost = {
        callJson() {
            throw "connection refused";
        },
    };
    const loaderHost = { callJson: () => "" };

    const fs = new Vfs();
    registerDeferredMount(fs, listHost, loaderHost, ffqn, "/workspace/mcp/srv");
    fs.ensureMountedFor("/workspace/mcp/srv/anything");

    assert.match(fs.readFile("/workspace/mcp/srv/.mcp-error"), /resources not mounted: connection refused/);
});
