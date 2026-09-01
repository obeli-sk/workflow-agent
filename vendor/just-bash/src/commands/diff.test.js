import { test } from "node:test";
import assert from "node:assert/strict";
import { Bash } from "../bash.js";

function withFiles(pairs) {
    const bash = new Bash({ cwd: "/workspace" });
    for (const [path, content] of pairs) bash.vfs.writeFile(path, content);
    return bash;
}

test("identical files are silent", () => {
    const r = withFiles([["/a.txt", "line1\nline2\nline3\n"], ["/b.txt", "line1\nline2\nline3\n"]]).exec("diff /a.txt /b.txt");
    assert.equal(r.stdout, "");
    assert.equal(r.exitCode, 0);
});

test("different files show a unified diff", () => {
    const r = withFiles([["/a.txt", "hello\n"], ["/b.txt", "world\n"]]).exec("diff /a.txt /b.txt");
    assert.match(r.stdout, /---/);
    assert.match(r.stdout, /\+\+\+/);
    assert.match(r.stdout, /-hello/);
    assert.match(r.stdout, /\+world/);
    assert.equal(r.exitCode, 1);
});

test("-q reports only that files differ", () => {
    const r = withFiles([["/a.txt", "aaa\n"], ["/b.txt", "bbb\n"]]).exec("diff -q /a.txt /b.txt");
    assert.equal(r.stdout, "Files /a.txt and /b.txt differ\n");
    assert.equal(r.exitCode, 1);
});

test("-s reports identical files", () => {
    const r = withFiles([["/a.txt", "same\n"], ["/b.txt", "same\n"]]).exec("diff -s /a.txt /b.txt");
    assert.equal(r.stdout, "Files /a.txt and /b.txt are identical\n");
});

test("-i ignores case", () => {
    const r = withFiles([["/a.txt", "Hello World\n"], ["/b.txt", "hello world\n"]]).exec("diff -i /a.txt /b.txt");
    assert.equal(r.stdout, "");
    assert.equal(r.exitCode, 0);
});

test("a single-line change gets a @@ hunk with context", () => {
    const r = withFiles([["/a.txt", "1\n2\n3\n4\n5\n"], ["/b.txt", "1\n2\nX\n4\n5\n"]]).exec("diff /a.txt /b.txt");
    assert.match(r.stdout, /@@/);
    assert.equal(r.exitCode, 1);
});

test("missing file errors with exit 2", () => {
    const r = withFiles([["/exists.txt", "content\n"]]).exec("diff /missing.txt /exists.txt");
    assert.equal(r.stderr, "diff: /missing.txt: No such file or directory\n");
    assert.equal(r.exitCode, 2);
});

test("missing operand errors", () => {
    const r = withFiles([]).exec("diff /a.txt");
    assert.match(r.stderr, /missing operand/);
    assert.equal(r.exitCode, 2);
});

test("stdin as the first file via -", () => {
    const r = withFiles([["/b.txt", "from file\n"]]).exec('echo "from stdin" | diff - /b.txt');
    assert.match(r.stdout, /-from stdin/);
    assert.match(r.stdout, /\+from file/);
});
