// Unit tests for the GET-only curl program (activity/curl.js). fetch is stubbed
// with a canned response factory so no network is involved; assertions cover
// argument parsing, -w/--write-out expansion, -I, -v and error paths.

import { test } from "node:test";
import assert from "node:assert/strict";
import curl from "./curl.js";

function jsonResponse({
    status = 200,
    body = "hello",
    headers = {},
} = {}) {
    const allHeaders = { "content-type": "text/plain", ...headers };
    const headerEntries = Object.entries(allHeaders);
    return {
        status,
        headers: {
            get: (name) => allHeaders[String(name).toLowerCase()] ?? null,
            entries: () => headerEntries,
        },
        text: async () => body,
    };
}

async function run(args, { status = 200, body = "hello", headers, responses } = {}) {
    const calls = [];
    let n = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (href, init) => {
        calls.push({ href, init });
        if (responses) return responses[n++]();
        return jsonResponse({ status, body, headers });
    };
    try {
        const result = await curl("", args);
        return { result, calls };
    } finally {
        globalThis.fetch = originalFetch;
    }
}

test("plain GET returns the body", async () => {
    const { result, calls } = await run(["http://example.test/x"]);
    assert.deepEqual(result, { stdout: "hello", stderr: "", exit_code: 0 });
    assert.equal(calls[0].init.method, "GET");
});

test("-w expands %{http_code} after the body", async () => {
    const { result } = await run(["-w", "%{http_code}\\n", "http://example.test/x"], { status: 201 });
    assert.equal(result.stdout, "hello201\n");
    assert.equal(result.exit_code, 0);
});

test("-w attached form -w'%{http_code}' works", async () => {
    const { result } = await run(["-w%{http_code}", "http://example.test/x"]);
    assert.equal(result.stdout, "hello200");
});

test("-w --write-out= form works", async () => {
    const { result } = await run(["--write-out=%{size_download}", "http://example.test/x"], { body: "abcde" });
    assert.equal(result.stdout, "abcde5");
});

test("-w expands every supported variable", async () => {
    const fmt = "%{http_code}|%{content_type}|%{url_effective}|%{num_redirects}";
    const { result } = await run(["-w", fmt, "http://example.test/x"], {
        headers: { "content-type": "application/json" },
    });
    assert.equal(result.stdout, "hello200|application/json|http://example.test/x|0");
});

test("-w leaves unknown %{vars} verbatim and expands escapes", async () => {
    const { result } = await run(["-w", "%{unknown} %A %%\\n", "http://example.test/x"]);
    assert.equal(result.stdout, "hello%{unknown} %A %\n");
});

test("-i includes status line and headers before the body", async () => {
    const { result } = await run(["-i", "http://example.test/x"], {
        headers: { "x-tracing": "1" },
    });
    assert.match(result.stdout, /^HTTP 200\ncontent-type: text\/plain\nx-tracing: 1\n\n/);
    assert.ok(result.stdout.endsWith("hello"));
});

test("-f maps HTTP errors to exit 22 and empty stdout", async () => {
    const { result } = await run(["-f", "http://example.test/x"], { status: 404 });
    assert.equal(result.exit_code, 22);
    assert.equal(result.stdout, "");
});

test("-f keeps write-out on failures like real curl", async () => {
    const { result } = await run(["-sf", "-w", "%{http_code}", "http://example.test/x"], { status: 500 });
    assert.equal(result.exit_code, 22);
    assert.equal(result.stdout, "500");
});

test("-I suppresses the body but keeps headers", async () => {
    const { result, calls } = await run(["-I", "http://example.test/x"]);
    assert.equal(calls[0].init.method, "GET");
    assert.match(result.stdout, /^HTTP 200\n/);
    assert.ok(!result.stdout.includes("hello"));
});

test("-L follows redirects; only the final response is printed (-I stays body-less)", async () => {
    const { result, calls } = await run(
        ["-sSIL", "http://example.test/a", "-w", "%{http_code}|%{num_redirects}"],
        {
            responses: [
                () => jsonResponse({ status: 301, headers: { location: "/b" }, body: "moved" }),
                () => jsonResponse({ status: 200, body: "found" }),
            ],
        },
    );
    assert.equal(calls.length, 2);
    assert.match(calls[1].href, /\/b$/);
    assert.equal(result.exit_code, 0);
    // Intermediate hops are not echoed (use -v to trace them); write-out vars
    // describe the last hop.
    assert.equal(result.stdout, "HTTP 200\ncontent-type: text/plain\n\n200|1");
});

test("-v traces request and response on stderr", async () => {
    const { result } = await run(["-v", "http://example.test/p?q=1"]);
    assert.match(result.stderr, /> GET \/p\?q=1\n/);
    assert.match(result.stderr, /< HTTP 200\n/);
    assert.match(result.stderr, /< content-type: text\/plain\n/);
    assert.equal(result.exit_code, 0);
});

test("--compressed is accepted silently", async () => {
    const { result } = await run(["--compressed", "http://example.test/x"]);
    assert.deepEqual(result, { stdout: "hello", stderr: "", exit_code: 0 });
});

test("-o/--output is rejected with a clear message", async () => {
    for (const arg of ["-o", "--output"]) {
        const { result } = await run([arg, "/tmp/f", "http://example.test/x"]);
        assert.equal(result.exit_code, 2);
        assert.match(result.stderr, /-o\/--output is not supported/);
    }
});

test("--max-time rejects invalid values", async () => {
    for (const value of ["0", "-1", "soon", undefined]) {
        const args = value === undefined ? ["-m"] : ["-m", value, "http://example.test/x"];
        const { result } = await run(args);
        assert.equal(result.exit_code, 2, `value: ${value}`);
        assert.match(result.stderr, /invalid max-time|requires an argument/);
    }
});

test("non-GET methods stay rejected", async () => {
    const { result } = await run(["-X", "POST", "http://example.test/x"]);
    assert.equal(result.exit_code, 2);
    assert.match(result.stderr, /only GET requests are supported/);
});

test("missing URL still fails with usage", async () => {
    const { result } = await run([]);
    assert.equal(result.exit_code, 2);
    assert.match(result.stderr, /URL is required/);
});

test("--help documents the new options", async () => {
    const { result } = await run(["--help"]);
    for (const needle of ["--write-out", "--max-time", "-I, --head", "-v, --verbose"]) {
        assert.ok(result.stdout.includes(needle), needle);
    }
});
