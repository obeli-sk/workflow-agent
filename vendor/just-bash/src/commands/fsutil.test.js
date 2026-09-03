// Tests for the six fsutil.js commands ported after the other ls/cat/cp/mv/
// etc. builtins: chmod/readlink/ln/file/du/tree, plus a few cp cases (that
// group otherwise has no dedicated test file). See fsutil.js's doc comments
// for exactly how each is simplified against a VFS with no permission bits,
// no symlinks, and no mtime. Cases mirror
// vendor/just-bash-rs/src/commands/fsutil.rs's own `#[cfg(test)] mod tests`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Bash } from "../bash.js";

function fresh() {
    return new Bash({ cwd: "/workspace" });
}

test("chmod validates mode syntax and target existence", () => {
    const bash = fresh();
    bash.vfs.writeFile("/f.txt", "x");
    const r = bash.exec("chmod 755 /f.txt");
    assert.equal(r.exitCode, 0);
    const r2 = bash.exec("chmod 755 /missing.txt");
    assert.match(r2.stderr, /No such file or directory/);
    const r3 = bash.exec("chmod not-a-mode /f.txt");
    assert.match(r3.stderr, /invalid mode/);
});

test("chmod symbolic mode with -v reports the change", () => {
    const bash = fresh();
    bash.vfs.writeFile("/f.txt", "x");
    const r = bash.exec("chmod -v u+x /f.txt");
    assert.match(r.stdout, /mode of '\/f\.txt' changed to/);
});

test("readlink -f canonicalizes a path that need not exist", () => {
    const bash = fresh();
    const r = bash.exec("mkdir -p /a/b; cd /a/b; readlink -f ../c");
    assert.equal(r.stdout, "/a/c\n");
});

test("readlink without -f fails on a non-symlink", () => {
    const bash = fresh();
    bash.vfs.writeFile("/f.txt", "x");
    const r = bash.exec("readlink /f.txt");
    assert.equal(r.exitCode, 1);
});

test("ln creates a hard link by copying content", () => {
    const bash = fresh();
    bash.vfs.writeFile("/a.txt", "hello");
    const r = bash.exec("ln /a.txt /b.txt");
    assert.equal(r.exitCode, 0);
    assert.equal(bash.vfs.readFile("/b.txt"), "hello");
});

test("cp of a directory without -r is refused", () => {
    const bash = fresh();
    bash.vfs.mkdirp("/dir");
    const r = bash.exec("cp /dir /dest");
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /-r not specified/);
});

test("cp -r copies a directory tree", () => {
    const bash = fresh();
    bash.vfs.writeFile("/dir/a.txt", "a");
    bash.vfs.writeFile("/dir/sub/b.txt", "b");
    const r = bash.exec("cp -r /dir /dest");
    assert.equal(r.exitCode, 0);
    assert.equal(bash.vfs.readFile("/dest/a.txt"), "a");
    assert.equal(bash.vfs.readFile("/dest/sub/b.txt"), "b");
});

test("cp -a (archive) implies recursive", () => {
    const bash = fresh();
    bash.vfs.writeFile("/dir/a.txt", "a");
    bash.vfs.writeFile("/dir/sub/b.txt", "b");
    const r = bash.exec("cp -a /dir /dest");
    assert.equal(r.exitCode, 0);
    assert.equal(bash.vfs.readFile("/dest/a.txt"), "a");
    assert.equal(bash.vfs.readFile("/dest/sub/b.txt"), "b");
});

test("ln on a missing target errors", () => {
    const bash = fresh();
    const r = bash.exec("ln /missing.txt /b.txt");
    assert.match(r.stderr, /No such file or directory/);
});

test("ln -s is rejected (no symlink support)", () => {
    const bash = fresh();
    bash.vfs.writeFile("/a.txt", "hello");
    const r = bash.exec("ln -s /a.txt /b.txt");
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /not supported/);
});

test("file detects directories and empty files", () => {
    const bash = fresh();
    bash.vfs.mkdirp("/dir");
    bash.vfs.writeFile("/empty.txt", "");
    const r = bash.exec("file /dir /empty.txt");
    assert.match(r.stdout, /\/dir: directory/);
    assert.match(r.stdout, /\/empty\.txt: empty/);
});

test("file detects shebang scripts and extensions", () => {
    const bash = fresh();
    bash.vfs.writeFile("/script.sh", "#!/bin/bash\necho hi\n");
    bash.vfs.writeFile("/data.json", "{}");
    const r = bash.exec("file /script.sh /data.json");
    assert.match(r.stdout, /shell script/);
    assert.match(r.stdout, /JSON data/);
});

test("file on a missing path errors", () => {
    const bash = fresh();
    const r = bash.exec("file /missing.txt");
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /cannot open/);
});

test("du -s reports the total size in 1K blocks", () => {
    const bash = fresh();
    bash.vfs.writeFile("/dir/a.txt", "12345");
    bash.vfs.writeFile("/dir/b.txt", "1234567890");
    const r = bash.exec("du -s /dir");
    assert.equal(r.stdout, "1\t/dir\n");
});

test("du -a lists every file as well as the directory total", () => {
    const bash = fresh();
    bash.vfs.writeFile("/dir/a.txt", "x");
    const r = bash.exec("du -a /dir");
    assert.match(r.stdout, /\/dir\/a\.txt/);
    assert.match(r.stdout, /\/dir\n$/);
});

test("du on a missing path errors", () => {
    const bash = fresh();
    const r = bash.exec("du /missing");
    assert.match(r.stderr, /No such file or directory/);
    assert.equal(r.exitCode, 1);
});

test("tree lists a directory structure with dir/file counts", () => {
    const bash = fresh();
    bash.vfs.writeFile("/proj/a.txt", "a");
    bash.vfs.writeFile("/proj/sub/b.txt", "b");
    const r = bash.exec("tree /proj");
    assert.ok(r.stdout.includes("|-- a.txt") || r.stdout.includes("`-- a.txt"));
    assert.match(r.stdout, /sub/);
    assert.match(r.stdout, /director/);
});

test("tree -d lists directories only", () => {
    const bash = fresh();
    bash.vfs.writeFile("/proj/a.txt", "a");
    bash.vfs.mkdirp("/proj/sub");
    const r = bash.exec("tree -d /proj");
    assert.ok(!r.stdout.includes("a.txt"));
    assert.match(r.stdout, /sub/);
});

test("tree on a missing path errors", () => {
    const bash = fresh();
    const r = bash.exec("tree /missing");
    assert.match(r.stderr, /No such file or directory/);
    assert.equal(r.exitCode, 1);
});
