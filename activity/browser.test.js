import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import browser from "./browser.js";

test("browser session lifecycle and step errors through HTTP", async (t) => {
    const requests = [];
    const server = createServer(async (req, res) => {
        let text = "";
        for await (const chunk of req) text += chunk;
        requests.push({ path: req.url, method: req.method, headers: req.headers, body: text && JSON.parse(text) });
        res.setHeader("content-type", "application/json");
        if (req.url === "/v1/sessions") {
            res.writeHead(201).end(JSON.stringify({ id: "abc123", expires_at: "2026-11-16T12:00:00Z" }));
        } else if (req.url.endsWith("/steps")) {
            res.end(JSON.stringify({ results: [{ op: "click", error: "No element matches the locator" }], denied_hosts: ["cdn.example.com"] }));
        } else if (req.url === "/v1/sessions/expired") {
            res.writeHead(410).end(JSON.stringify({ error: "Session ended", end_reason: "ttl" }));
        } else {
            res.end(JSON.stringify({ id: "abc123", expires_at: "2026-11-16T12:00:00Z" }));
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const original = process.env.BROWSER_URL;
    t.after(() => {
        if (original === undefined) delete process.env.BROWSER_URL;
        else process.env.BROWSER_URL = original;
    });
    process.env.BROWSER_URL = `http://127.0.0.1:${server.address().port}/`;

    const created = await browser("", ["session", "create", "--ttl", "600"]);
    assert.deepEqual(created, { stdout: "abc123\n", stderr: "", exit_code: 0 });
    assert.deepEqual(requests[0].body, { ttl_s: 600 });
    assert.equal(requests[0].method, "POST");

    const status = await browser("", ["session", "status", created.stdout.trim()]);
    assert.equal(JSON.parse(status.stdout).expires_at, "2026-11-16T12:00:00Z");
    assert.equal(requests[1].method, "GET");

    const batch = { steps: [{ op: "click", locator: { role: "button", name: "Submit" } }] };
    const failed = await browser(JSON.stringify(batch), ["steps", "abc123", "--idempotency-key", "batch-1"]);
    assert.equal(failed.exit_code, 1);
    assert.deepEqual(JSON.parse(failed.stdout).denied_hosts, ["cdn.example.com"]);
    assert.match(failed.stderr, /step batch failed/);
    assert.equal(requests[2].headers["idempotency-key"], "batch-1");
    assert.deepEqual(requests[2].body, batch);
    assert.equal(requests.length, 3);

    await browser(JSON.stringify(batch), ["steps", "abc123"]);
    assert.ok(requests[3].headers["idempotency-key"]);
    await browser("", ["session", "close", "abc123"]);
    assert.equal(requests[4].method, "DELETE");
    const expired = await browser("", ["session", "status", "expired"]);
    assert.equal(expired.exit_code, 1);
    assert.match(expired.stderr, /410.*ttl/);
    assert.equal(requests.length, 6);

    for (const [stdin, args] of [
        ["", ["session", "create", "--ttl", "0"]],
        ["", ["session", "status", "../sessions"]],
        ["broken", ["steps", "abc123"]],
        ['{"steps":[],"other":true}', ["steps", "abc123"]],
        ["{}", ["steps", "abc123"]],
    ]) {
        assert.equal((await browser(stdin, args)).exit_code, 2);
    }
    assert.equal(requests.length, 6);
    delete process.env.BROWSER_URL;
    assert.match((await browser("", ["session", "create"])).stderr, /disabled/);
    assert.equal((await browser("", ["--help"])).exit_code, 0);
    assert.equal(requests.length, 6);
});
