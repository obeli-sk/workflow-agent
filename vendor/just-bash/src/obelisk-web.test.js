import { test } from "node:test";
import assert from "node:assert/strict";
import { Vfs } from "./fs.js";
import { mount } from "./obelisk-web.js";

function fakeHost(fixtures) {
    const calls = [];
    return {
        calls,
        callJson(ffqn, paramsJson) {
            calls.push([ffqn, paramsJson]);
            if (!(paramsJson in fixtures)) throw `no fixture for ${paramsJson}`;
            return fixtures[paramsJson];
        },
    };
}

function args(method, path) {
    return JSON.stringify([method, JSON.stringify({ path })]);
}

test("lists and reads through the transport, lazily", () => {
    const ffqn = "obelisk-agent:mounts/components.request";
    const host = fakeHost({
        [args("list", "")]: JSON.stringify(
            JSON.stringify([
                { name: "obelisk", type: "dir" },
                { name: "README.md", type: "file", size: 5 },
            ]),
        ),
        // "read"'s ok arm is the raw file body (a plain string result), so the
        // fixture is single-JSON-encoded, not double; deliberately not valid
        // JSON itself to guard the regression where the transport re-parsed it.
        [args("read", "README.md")]: JSON.stringify("# Components\nnot json {"),
    });
    const fs = new Vfs();
    mount(fs, host, ffqn, "/workspace/components");

    assert.equal(host.calls.length, 0, "mounting itself makes no network call");
    assert.deepEqual(fs.readdir("/workspace/components"), ["README.md", "obelisk"]);
    assert.equal(fs.readFile("/workspace/components/README.md"), "# Components\nnot json {");
});

test("an unknown entry type fails the listing silently, like any other list() error", () => {
    // fs.js's _ensureExpanded swallows a throwing provider.list() (marks the
    // directory expanded with no children, never retries) rather than
    // propagating - matching fs.rs's `if let Ok(entries) = entries`. The
    // directory lists empty rather than raising through readdir.
    const ffqn = "obelisk-agent:mounts/components.request";
    const host = fakeHost({
        [args("list", "")]: JSON.stringify(JSON.stringify([{ name: "weird", type: "symlink" }])),
    });
    const fs = new Vfs();
    mount(fs, host, ffqn, "/workspace/components");
    assert.deepEqual(fs.readdir("/workspace/components"), []);
});
