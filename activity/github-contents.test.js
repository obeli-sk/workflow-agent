// Unit tests for the GitHub contents mount transport. The activity resolves
// repo symlinks itself (the contents API never follows them), so these tests
// stub global fetch with scripted responses and assert both the resulting
// listings/bodies and the request sequence that produced them.

import { test } from "node:test";
import assert from "node:assert/strict";
import githubContents from "./github-contents.js";

process.env.GH_OWNER = "acme";
process.env.GH_REPO = "tree";
delete process.env.GH_REF;

const API = "https://api.github.com/repos/acme/tree/contents";

const JSON_ACCEPT = "application/vnd.github+json";
const RAW_ACCEPT = "application/vnd.github.raw";

function jsonResponse(status, body) {
    return { ok: status >= 200 && status < 300, status, text: async () => body };
}

const jsonOk = (body) => jsonResponse(200, JSON.stringify(body));
const notFound = () => jsonResponse(404, '{"message":"Not Found"}');

// Mirror the activity's URL construction so routes key on exact requests.
function url(path) {
    const encoded = String(path)
        .split("/")
        .filter(Boolean)
        .map(encodeURIComponent)
        .join("/");
    return encoded ? `${API}/${encoded}?ref=main` : `${API}?ref=main`;
}

// Install a routing-table fetch. Values are response objects or functions of
// the request headers (so one URL can answer its JSON metadata probe and its
// raw fetch differently). `calls` records { url, accept } per request.
async function withRoutes(routes, fn) {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (reqUrl, init) => {
        const respond = routes.get(reqUrl);
        calls.push({ url: reqUrl, accept: init?.headers?.accept });
        if (!respond) throw new Error(`unexpected fetch: ${reqUrl}`);
        return typeof respond === "function" ? respond(init) : respond;
    };
    try {
        await fn(calls);
    } finally {
        globalThis.fetch = original;
    }
}

const call = (method, path) => githubContents(method, JSON.stringify({ path }));

test("reads a plain file with a single raw request", async () => {
    await withRoutes(
        new Map([[url("README.md"), jsonResponse(200, "# hello")]]),
        async (calls) => {
            const body = await call("read", "README.md");
            assert.equal(body, "# hello");
            assert.deepEqual(calls, [{ url: url("README.md"), accept: RAW_ACCEPT }]);
        },
    );
});

test("lists a directory and maps entry types", async () => {
    await withRoutes(
        new Map([
            [
                url("content/js"),
                jsonOk([
                    { name: "index.md", type: "file", size: 12 },
                    { name: "examples", type: "dir" },
                    // Symlinks surface as directories; the listing payload
                    // carries no target text.
                    { name: "latest", type: "symlink", size: 7, target: null },
                    // Entries without a usable name are dropped rather than
                    // failing the whole listing downstream.
                    { type: "file", size: 1 },
                ]),
            ],
        ]),
        async (calls) => {
            const listing = JSON.parse(await call("list", "content/js"));
            assert.deepEqual(listing, [
                { name: "index.md", type: "file", size: 12 },
                { name: "examples", type: "dir", size: 0 },
                { name: "latest", type: "dir", size: 0 },
            ]);
            assert.equal(calls.length, 1);
        },
    );
});

test("listing the symlink path itself follows to the target directory", async () => {
    await withRoutes(
        new Map([
            [url("content/docs/latest"), jsonOk({ type: "symlink", target: "v0.41.3" })],
            [
                url("content/docs/v0.41.3"),
                jsonOk([{ name: "_index.md", type: "file", size: 64 }]),
            ],
        ]),
        async (calls) => {
            const listing = JSON.parse(await call("list", "content/docs/latest"));
            assert.deepEqual(listing, [{ name: "_index.md", type: "file", size: 64 }]);
            assert.deepEqual(
                calls.map((c) => c.url),
                [url("content/docs/latest"), url("content/docs/v0.41.3")],
            );
        },
    );
});

test("listing through a symlinked component rewrites the path", async () => {
    await withRoutes(
        new Map([
            [url("content/docs/latest/concepts"), notFound()],
            [url("content"), jsonOk([])],
            [url("content/docs"), jsonOk([])],
            [url("content/docs/latest"), jsonOk({ type: "symlink", target: "v0.41.3" })],
            [
                url("content/docs/v0.41.3/concepts"),
                jsonOk([{ name: "executions.md", type: "file", size: 9 }]),
            ],
        ]),
        async (calls) => {
            const listing = JSON.parse(await call("list", "content/docs/latest/concepts"));
            assert.deepEqual(listing, [{ name: "executions.md", type: "file", size: 9 }]);
            // Full-path miss, then component probes from the root, then the
            // confirming listing of the rewritten directory.
            assert.equal(calls.length, 6);
            assert.equal(calls[0].url, url("content/docs/latest/concepts"));
            assert.equal(calls[calls.length - 1].url, url("content/docs/v0.41.3/concepts"));
        },
    );
});

test("reading through a symlinked prefix fetches the resolved file", async () => {
    await withRoutes(
        new Map([
            [url("content/docs/latest/cli.md"), notFound()],
            [url("content"), jsonOk([])],
            [url("content/docs"), jsonOk([])],
            [url("content/docs/latest"), jsonOk({ type: "symlink", target: "v0.41.3/" })],
            [
                url("content/docs/v0.41.3/cli.md"),
                (init) =>
                    init.headers.accept === RAW_ACCEPT
                        ? jsonResponse(200, "# CLI")
                        : jsonOk({ type: "file", size: 6 }),
            ],
        ]),
        async (calls) => {
            const body = await call("read", "content/docs/latest/cli.md");
            assert.equal(body, "# CLI");
            // Raw fast-path miss, a metadata miss on the full path, four
            // component probes from the root, a confirming metadata probe of
            // the rewritten path, then the raw fetch of the resolved file.
            assert.equal(calls.length, 8);
            assert.equal(calls[0].accept, RAW_ACCEPT);
            assert.equal(calls[calls.length - 1].url, url("content/docs/v0.41.3/cli.md"));
            assert.equal(calls[calls.length - 1].accept, RAW_ACCEPT);
        },
    );
});

test("a relative dot-dot symlink target resolves from the link directory", async () => {
    await withRoutes(
        new Map([
            [url("docs/alias/intro.md"), notFound()],
            [url("docs"), jsonOk([])],
            [url("docs/alias"), jsonOk({ type: "symlink", target: "../real" })],
            [
                url("real/intro.md"),
                (init) =>
                    init.headers.accept === RAW_ACCEPT
                        ? jsonResponse(200, "# Real")
                        : jsonOk({ type: "file", size: 6 }),
            ],
        ]),
        async () => {
            const body = await call("read", "docs/alias/intro.md");
            assert.equal(body, "# Real");
        },
    );
});

test("reading a missing file reports not found", async () => {
    await withRoutes(new Map([[url("missing.md"), notFound()]]), async () => {
        await assert.rejects(call("read", "missing.md"), /missing\.md not found/);
    });
});

test("symlink cycles are cut off instead of hanging", async () => {
    await withRoutes(
        new Map([
            [url("d/link"), jsonOk({ type: "symlink", target: "other" })],
            [url("d/other"), jsonOk({ type: "symlink", target: "link" })],
        ]),
        async () => {
            await assert.rejects(call("list", "d/link"), /too many symlink hops/);
        },
    );
});

test("unknown methods throw", async () => {
    await assert.rejects(githubContents("write", "{}"), /unknown method 'write'/);
});
