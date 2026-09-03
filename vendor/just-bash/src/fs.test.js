// Tests for fs.js's mount surface: symlinks, lazy/pending files, deferred
// mounts, and web mounts. Mirrors the contracts exercised by
// vendor/just-bash-rs/src/fs.rs's own `#[cfg(test)] mod tests`, adapted to
// this port's string-content, exception-throwing conventions. The plain
// read/write/readdir/remove/rename/copyFile behavior already has coverage
// via bash.test.js and commands/fsutil.test.js; these cases focus on the
// non-obvious parts of the new surface (fetched exactly once, pending
// survives a read but not a write, one-shot deferred mounts, lazy web
// listing).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Vfs, FsError, MAX_LAZY_FETCH_BYTES } from "./fs.js";

test("symlink is transparent to reads, writes, and readdir", () => {
    const fs = new Vfs();
    fs.writeFile("/deployment/abc/deployment.toml", "hi");
    fs.symlink("/deployment/abc", "/deployment/current");

    assert.equal(fs.isDir("/deployment/current"), true);
    assert.equal(fs.readFile("/deployment/current/deployment.toml"), "hi");
    assert.deepEqual(fs.readdir("/deployment/current"), ["deployment.toml"]);

    fs.writeFile("/deployment/current/new.txt", "added");
    assert.equal(fs.readFile("/deployment/abc/new.txt"), "added");
});

test("readdir lists a symlink entry alongside real ones", () => {
    const fs = new Vfs();
    fs.writeFile("/deployment/abc/deployment.toml", "hi");
    fs.symlink("/deployment/abc", "/deployment/current");
    assert.deepEqual(fs.readdir("/deployment"), ["abc", "current"]);
});

test("removing a symlink removes the link, not the target", () => {
    const fs = new Vfs();
    fs.writeFile("/deployment/abc/f", "old");
    fs.writeFile("/deployment/def/f", "new");
    fs.symlink("/deployment/abc", "/deployment/current");

    fs.remove("/deployment/current", { recursive: true });
    assert.equal(fs.isDir("/deployment/abc"), true);
    assert.equal(fs.readFile("/deployment/abc/f"), "old");
    assert.equal(fs.isSymlink("/deployment/current"), false);

    fs.symlink("/deployment/def", "/deployment/current");
    assert.equal(fs.readFile("/deployment/current/f"), "new");
});

function countingLoader(blobs) {
    const loads = [];
    const fn = (digest) => {
        loads.push(digest);
        if (!(digest in blobs)) throw new Error(`no blob for ${digest}`);
        return blobs[digest];
    };
    fn.loads = loads;
    return fn;
}

test("lazy file lists before read and fetches exactly once across two reads", () => {
    const fs = new Vfs();
    const loader = countingLoader({ "sha256:a": "hello" });
    fs.setBlobLoader(loader);
    fs.registerLazy("/dep/a.txt", "sha256:a", 5);

    // Listed and typed as a file with no fetch yet.
    assert.equal(fs.exists("/dep/a.txt"), true);
    assert.equal(fs.isFile("/dep/a.txt"), true);
    assert.deepEqual(fs.readdir("/dep"), ["a.txt"]);
    assert.equal(loader.loads.length, 0);

    // First read fetches; second read is served from cache.
    assert.equal(fs.readFile("/dep/a.txt"), "hello");
    assert.equal(fs.readFile("/dep/a.txt"), "hello");
    assert.deepEqual(loader.loads, ["sha256:a"]);
});

test("pending survives a read but is cleared by a write", () => {
    const fs = new Vfs();
    const loader = countingLoader({ "sha256:a": "remote" });
    fs.setBlobLoader(loader);
    fs.registerLazy("/dep/a.txt", "sha256:a", 6);

    assert.equal(fs.isPending("/dep/a.txt"), true);
    fs.readFile("/dep/a.txt");
    assert.equal(fs.isPending("/dep/a.txt"), true, "a mere read must not clear pending");

    fs.writeFile("/dep/a.txt", "local");
    assert.equal(fs.isPending("/dep/a.txt"), false, "a local write must clear pending");
    assert.equal(fs.readFile("/dep/a.txt"), "local");
});

test("mount-specific loader coexists with the default loader", () => {
    const fs = new Vfs();
    const deploymentLoader = countingLoader({ "sha256:deployment": "deployment" });
    const mcpLoader = countingLoader({ "sha256:mcp": "resource" });
    fs.setBlobLoader(deploymentLoader);
    fs.registerLazy("/deployment/file", "sha256:deployment", 10);
    fs.registerLazyWithLoader("/mcp/file", "sha256:mcp", 8, mcpLoader);

    assert.equal(fs.readFile("/deployment/file"), "deployment");
    assert.equal(fs.readFile("/mcp/file"), "resource");
    assert.deepEqual(deploymentLoader.loads, ["sha256:deployment"]);
    assert.deepEqual(mcpLoader.loads, ["sha256:mcp"]);
});

test("appendFile materializes a pending file's bytes before appending, then clears pending", () => {
    const fs = new Vfs();
    const loader = countingLoader({ "sha256:log": "one\n" });
    fs.setBlobLoader(loader);
    fs.registerLazy("/log", "sha256:log", 4);

    fs.appendFile("/log", "two\n");
    assert.equal(fs.readFile("/log"), "one\ntwo\n");
    assert.equal(fs.isPending("/log"), false);
    assert.deepEqual(loader.loads, ["sha256:log"]);
});

test("copyFile of a lazy file copies the reference without fetching", () => {
    const fs = new Vfs();
    const loader = countingLoader({ "sha256:a": "hello" });
    fs.setBlobLoader(loader);
    fs.registerLazy("/dep/a.txt", "sha256:a", 5);

    fs.copyFile("/dep/a.txt", "/dep/b.txt");
    assert.equal(loader.loads.length, 0, "copy must not fetch the source");
    assert.equal(fs.isPending("/dep/b.txt"), true);
    assert.deepEqual(fs.lazyFileRef("/dep/b.txt"), { digest: "sha256:a", size: 5 });

    assert.equal(fs.readFile("/dep/b.txt"), "hello");
    assert.deepEqual(loader.loads, ["sha256:a"]);
});

test("copying a lazy file carries over its cached digest and bytes", () => {
    // Regression: a `cp` of a git/web-mounted file whose real sha256 and
    // fetched bytes were already established for the SOURCE path (e.g. by an
    // earlier sha256sum or deployment-submit call) must not force the copy to
    // refetch and rehash from scratch - the content is guaranteed identical.
    const provider = fakeProvider({
        listings: { "": [{ name: "AGENTS.md", kind: "file", digest: "git:a", size: 3 }] },
        files: { "AGENTS.md": "abc" },
    });
    const fs = new Vfs();
    fs.registerWebMount("/workspace/components", "", provider);
    fs.readdir("/workspace/components");

    fs.readFile("/workspace/components/AGENTS.md");
    fs.cacheContentDigest("/workspace/components/AGENTS.md", "sha256:abc123");
    assert.deepEqual(provider.reads, ["AGENTS.md"]);

    fs.copyFile("/workspace/components/AGENTS.md", "/AGENTS.md");
    assert.equal(fs.isPending("/AGENTS.md"), true);
    assert.equal(fs.cachedContentDigest("/AGENTS.md"), "sha256:abc123");
    assert.equal(fs.readFile("/AGENTS.md"), "abc");
    assert.deepEqual(
        provider.reads,
        ["AGENTS.md"],
        "the copy must not refetch bytes already cached for the source",
    );
});

test("content digest cache is invalidated by a write or a remove", () => {
    const fs = new Vfs();
    fs.writeFile("/a.txt", "hello");
    assert.equal(fs.cachedContentDigest("/a.txt"), null);

    fs.cacheContentDigest("/a.txt", "sha256:1");
    assert.equal(fs.cachedContentDigest("/a.txt"), "sha256:1");

    // A write to the same path (new content) must drop the stale entry.
    fs.writeFile("/a.txt", "changed");
    assert.equal(fs.cachedContentDigest("/a.txt"), null);

    fs.cacheContentDigest("/a.txt", "sha256:2");
    assert.equal(fs.cachedContentDigest("/a.txt"), "sha256:2");
    fs.remove("/a.txt");
    fs.writeFile("/a.txt", "changed");
    assert.equal(fs.cachedContentDigest("/a.txt"), null);
});

test("oversized lazy file reports TOO_LARGE without ever calling the loader", () => {
    const fs = new Vfs();
    const loader = countingLoader({ "sha256:big": "x".repeat(8) });
    fs.setBlobLoader(loader);
    fs.registerLazy("/dep/component.wasm", "sha256:big", MAX_LAZY_FETCH_BYTES + 1);

    assert.throws(
        () => fs.readFile("/dep/component.wasm"),
        (err) => err instanceof FsError && err.code === "TOO_LARGE",
    );
    assert.equal(loader.loads.length, 0);
    assert.equal(fs.isPending("/dep/component.wasm"), true, "a failed read must not clear pending");
});

test("a missing loader or a failed fetch surfaces as READ_UNAVAILABLE", () => {
    const fs = new Vfs();
    fs.registerLazy("/dep/a.txt", "sha256:a", 1);
    // Listed, but unreadable without a loader.
    assert.equal(fs.isFile("/dep/a.txt"), true);
    assert.throws(
        () => fs.readFile("/dep/a.txt"),
        (err) => err instanceof FsError && err.code === "READ_UNAVAILABLE",
    );
});

function fakeProvider({ listings, files }) {
    const lists = [];
    const reads = [];
    return {
        lists,
        reads,
        list(remotePath) {
            lists.push(remotePath);
            if (!(remotePath in listings)) throw new Error(`no listing for ${remotePath}`);
            return listings[remotePath];
        },
        read(remotePath) {
            reads.push(remotePath);
            if (!(remotePath in files)) throw new Error(`no file for ${remotePath}`);
            return files[remotePath];
        },
    };
}

test("deferred mount fires exactly once, only on a matching path", () => {
    const fs = new Vfs();
    let fired = 0;
    fs.registerDeferredMount("/workspace/deployment", (vfs) => {
        fired += 1;
        vfs.writeFile("/workspace/deployment/current/deployment.toml", "toml");
    });

    // The root pre-exists (so it lists under its parent) but nothing fired.
    assert.equal(fs.isDir("/workspace/deployment"), true);
    assert.equal(fired, 0);

    // A path outside the root does not fire it.
    fs.ensureMountedFor("/workspace/other");
    assert.equal(fired, 0);

    // The first matching access fires it; further accesses are no-ops.
    fs.ensureMountedFor("/workspace/deployment/current/deployment.toml");
    fs.ensureMountedFor("/workspace/deployment");
    assert.equal(fired, 1);
    assert.equal(fs.readFile("/workspace/deployment/current/deployment.toml"), "toml");
});

test("clearing a deferred mount stops it from firing", () => {
    const fs = new Vfs();
    let fired = 0;
    fs.registerDeferredMount("/workspace/deployment", () => {
        fired += 1;
    });
    fs.clearDeferredMount("/workspace/deployment");
    fs.ensureMountedFor("/workspace/deployment/current");
    assert.equal(fired, 0);
});

test("web mount lists a directory lazily, calling list() once across repeated access", () => {
    const provider = fakeProvider({
        listings: {
            "": [
                { name: "obelisk", kind: "dir" },
                { name: "README.md", kind: "file", digest: "git:readme", size: 5 },
            ],
            obelisk: [{ name: "deployment.toml", kind: "file", digest: "git:deployment", size: 3 }],
        },
        files: {
            "README.md": "hello",
            "obelisk/deployment.toml": "abc",
        },
    });
    const fs = new Vfs();
    fs.registerWebMount("/workspace/components", "", provider);

    // The mount root shows up under its parent without any fetch.
    assert.equal(fs.isDir("/workspace/components"), true);
    assert.deepEqual(fs.readdir("/workspace"), ["components"]);
    assert.equal(provider.lists.length, 0);

    // Listing the root expands it once; the subdir stays unexpanded.
    assert.deepEqual(fs.readdir("/workspace/components"), ["README.md", "obelisk"]);
    assert.deepEqual(provider.lists, [""]);
    assert.equal(fs.isDir("/workspace/components/obelisk"), true);
    assert.equal(fs.isFile("/workspace/components/README.md"), true);
    assert.deepEqual(fs.lazyFileRef("/workspace/components/README.md"), {
        digest: "git:readme",
        size: 5,
    });

    // Repeated access to the already-expanded root does not list again.
    fs.readdir("/workspace/components");
    fs.isFile("/workspace/components/README.md");
    assert.deepEqual(provider.lists, [""]);

    // Descending fetches the child listing exactly once.
    assert.deepEqual(fs.readdir("/workspace/components/obelisk"), ["deployment.toml"]);
    fs.readdir("/workspace/components/obelisk");
    assert.deepEqual(provider.lists, ["", "obelisk"]);

    // File bytes fetch once on read, then serve from cache.
    assert.equal(fs.readFile("/workspace/components/obelisk/deployment.toml"), "abc");
    assert.equal(fs.readFile("/workspace/components/obelisk/deployment.toml"), "abc");
    assert.deepEqual(provider.reads, ["obelisk/deployment.toml"]);
});

test("writing over a web-mounted file shadows the remote copy with no fetch", () => {
    const provider = fakeProvider({
        listings: { "": [{ name: "notes.md", kind: "file", digest: "git:notes", size: 6 }] },
        files: { "notes.md": "remote" },
    });
    const fs = new Vfs();
    fs.registerWebMount("/workspace/docs", "", provider);
    fs.readdir("/workspace/docs");
    fs.writeFile("/workspace/docs/notes.md", "local");
    assert.equal(fs.readFile("/workspace/docs/notes.md"), "local");
    assert.equal(provider.reads.length, 0, "a local edit must win with no fetch");
});

test("oversized web file reports TOO_LARGE without ever calling read()", () => {
    const provider = fakeProvider({
        listings: { "": [{ name: "big.bin", kind: "file", digest: "git:big", size: MAX_LAZY_FETCH_BYTES + 1 }] },
        files: {},
    });
    const fs = new Vfs();
    fs.registerWebMount("/workspace/components", "", provider);
    fs.readdir("/workspace/components");
    assert.throws(
        () => fs.readFile("/workspace/components/big.bin"),
        (err) => err instanceof FsError && err.code === "TOO_LARGE",
    );
    assert.equal(provider.reads.length, 0);
});

test("executable bit is resolved through symlinks and follows rename", () => {
    const fs = new Vfs();
    fs.writeFile("/bin/tool", "#!/bin/sh");
    assert.equal(fs.isExecutable("/bin/tool"), false);
    fs.setExecutable("/bin/tool", true);
    assert.equal(fs.isExecutable("/bin/tool"), true);

    fs.symlink("/bin", "/usr/bin");
    assert.equal(fs.isExecutable("/usr/bin/tool"), true);

    fs.rename("/bin/tool", "/bin/tool2");
    assert.equal(fs.isExecutable("/bin/tool2"), true);
    assert.equal(fs.isExecutable("/bin/tool"), false);
});
