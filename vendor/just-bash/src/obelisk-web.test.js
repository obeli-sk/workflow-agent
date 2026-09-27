import { test } from "node:test";
import assert from "node:assert/strict";
import { Vfs } from "./fs.js";
import { mount } from "./obelisk-web.js";

// A fake `apps.request` serving fixtures keyed by `[method, paramsJson]`.
function fakeGithub(fixtures) {
    const calls = [];
    const githubContents = (method, paramsJson) => {
        const key = JSON.stringify([method, paramsJson]);
        calls.push(key);
        if (!(key in fixtures)) throw `no fixture for ${key}`;
        return fixtures[key];
    };
    return { calls, githubContents };
}

const RESOLVED_SHA = "0123456789abcdef0123456789abcdef01234567";

function testRepo() {
    // A fresh object per test: `mount` mutates `resolvedRef` onto it in
    // place, so tests must not share one across cases.
    return { owner: "obeli-sk", repo: "components", ref: "main" };
}

function resolveArgs() {
    return JSON.stringify(["resolve-ref", JSON.stringify({ owner: "obeli-sk", repo: "components", ref: "main" })]);
}

function args(method, path) {
    return JSON.stringify([
        method,
        JSON.stringify({ owner: "obeli-sk", repo: "components", ref: RESOLVED_SHA, path }),
    ]);
}

test("lists and reads through the transport, lazily, pinning the ref on first use", () => {
    const github = fakeGithub({
        [resolveArgs()]: RESOLVED_SHA,
        [args("list", "")]: JSON.stringify([
            { name: "obelisk", type: "dir" },
            { name: "README.md", type: "file", sha: "git:readme", size: 5 },
        ]),
        // Deliberately not valid JSON to guard the regression where the
        // transport re-parsed the body.
        [args("read", "README.md")]: "# Components\nnot json {",
    });
    const fs = new Vfs();
    const repo = testRepo();
    mount(fs, github.githubContents, "/workspace/components", repo);

    assert.equal(github.calls.length, 0, "mounting itself makes no network call");
    assert.equal(repo.resolvedRef, undefined, "mounting itself must not resolve the ref");

    assert.deepEqual(fs.readdir("/workspace/components"), ["README.md", "obelisk"]);
    assert.equal(repo.resolvedRef, RESOLVED_SHA, "the ref pins onto the shared repo object");
    assert.deepEqual(fs.lazyFileRef("/workspace/components/README.md"), {
        digest: "git:readme",
        size: 5,
    });
    assert.equal(fs.readFile("/workspace/components/README.md"), "# Components\nnot json {");

    // The ref resolves exactly once, even across the list and the read.
    const resolveCalls = github.calls.filter((key) => key.startsWith('["resolve-ref"'));
    assert.equal(resolveCalls.length, 1);
});

test("an unknown entry type fails the listing silently, like any other list() error", () => {
    // fs.js's _ensureExpanded swallows a throwing provider.list() (marks the
    // directory expanded with no children, never retries) rather than
    // propagating - matching fs.rs's `if let Ok(entries) = entries`. The
    // directory lists empty rather than raising through readdir.
    const github = fakeGithub({
        [resolveArgs()]: RESOLVED_SHA,
        [args("list", "")]: JSON.stringify([{ name: "weird", type: "symlink" }]),
    });
    const fs = new Vfs();
    mount(fs, github.githubContents, "/workspace/components", testRepo());
    assert.deepEqual(fs.readdir("/workspace/components"), []);
});
