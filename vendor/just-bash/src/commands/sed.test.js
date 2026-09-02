import { test } from "node:test";
import assert from "node:assert/strict";
import { Bash } from "../bash.js";

function fresh() {
    return new Bash({ cwd: "/test" });
}

function withFixtures() {
    const bash = fresh();
    bash.vfs.writeFile("/test/file.txt", "hello world\nhello universe\ngoodbye world\n");
    bash.vfs.writeFile("/test/numbers.txt", "line 1\nline 2\nline 3\nline 4\nline 5\n");
    return bash;
}

test("replace first occurrence per line", () => {
    const r = withFixtures().exec("sed 's/hello/hi/' /test/file.txt");
    assert.equal(r.stdout, "hi world\nhi universe\ngoodbye world\n");
    assert.equal(r.exitCode, 0);
});

test("g flag replaces every occurrence", () => {
    const r = withFixtures().exec("sed 's/l/L/g' /test/file.txt");
    assert.equal(r.stdout, "heLLo worLd\nheLLo universe\ngoodbye worLd\n");
});

test("-n with Np prints only that line", () => {
    const r = withFixtures().exec("sed -n '3p' /test/numbers.txt");
    assert.equal(r.stdout, "line 3\n");
});

test("-n with a range prints only that range", () => {
    const r = withFixtures().exec("sed -n '2,4p' /test/numbers.txt");
    assert.equal(r.stdout, "line 2\nline 3\nline 4\n");
});

test("/regex/d deletes matching lines", () => {
    const r = withFixtures().exec("sed '/hello/d' /test/file.txt");
    assert.equal(r.stdout, "goodbye world\n");
});

test("delete by line number and range", () => {
    assert.equal(withFixtures().exec("sed '2d' /test/numbers.txt").stdout, "line 1\nline 3\nline 4\nline 5\n");
    assert.equal(withFixtures().exec("sed '2,4d' /test/numbers.txt").stdout, "line 1\nline 5\n");
});

test("reads from stdin when no file operand", () => {
    const r = fresh().exec("echo 'foo bar' | sed 's/bar/baz/'");
    assert.equal(r.stdout, "foo baz\n");
});

test("custom delimiter", () => {
    const r = fresh().exec("echo '/path/to/file' | sed 's#/path#/newpath#'");
    assert.equal(r.stdout, "/newpath/to/file\n");
});

test("bracket expression regex", () => {
    const r = withFixtures().exec("sed 's/[0-9]/X/' /test/numbers.txt");
    assert.equal(r.stdout, "line X\nline X\nline X\nline X\nline X\n");
});

test("missing file errors", () => {
    const r = withFixtures().exec("sed 's/a/b/' /test/nonexistent.txt");
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "sed: /test/nonexistent.txt: No such file or directory\n");
    assert.equal(r.exitCode, 1);
});

test("empty replacement deletes the match", () => {
    const r = withFixtures().exec("sed 's/world//' /test/file.txt");
    assert.equal(r.stdout, "hello \nhello universe\ngoodbye \n");
});

test("i flag ignores case", () => {
    const r = withFixtures().exec("sed 's/HELLO/hi/i' /test/file.txt");
    assert.equal(r.stdout, "hi world\nhi universe\ngoodbye world\n");
});

test("combined gi flags", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test.txt", "Hello HELLO hello\n");
    assert.equal(bash.exec("sed 's/hello/hi/gi' /test.txt").stdout, "hi hi hi\n");
});

test("substitute scoped by line/last/range address", () => {
    assert.equal(withFixtures().exec("sed '1s/line/LINE/' /test/numbers.txt").stdout, "LINE 1\nline 2\nline 3\nline 4\nline 5\n");
    assert.equal(withFixtures().exec("sed '$ s/line/LINE/' /test/numbers.txt").stdout, "line 1\nline 2\nline 3\nline 4\nLINE 5\n");
    assert.equal(withFixtures().exec("sed '2,4s/line/LINE/' /test/numbers.txt").stdout, "line 1\nLINE 2\nLINE 3\nLINE 4\nline 5\n");
});

test("$ address deletes the last line", () => {
    assert.equal(withFixtures().exec("sed '$ d' /test/numbers.txt").stdout, "line 1\nline 2\nline 3\nline 4\n");
    assert.equal(withFixtures().exec("sed '$d' /test/numbers.txt").stdout, "line 1\nline 2\nline 3\nline 4\n");
});

test("multiple -e expressions apply in order", () => {
    const r = withFixtures().exec("sed -e 's/hello/hi/' -e 's/world/there/' /test/file.txt");
    assert.equal(r.stdout, "hi there\nhi universe\ngoodbye there\n");
});

test("& in the replacement is the whole match", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test.txt", "hello\n");
    assert.equal(bash.exec("sed 's/hello/[&]/' /test.txt").stdout, "[hello]\n");
    const bash2 = fresh();
    bash2.vfs.writeFile("/test.txt", "world\n");
    assert.equal(bash2.exec("sed 's/world/&-&-&/' /test.txt").stdout, "world-world-world\n");
});

test("-i edits the file in place", () => {
    const bash = fresh();
    bash.vfs.writeFile("/t.txt", "hello world\n");
    const r = bash.exec("sed -i 's/hello/hi/' /t.txt");
    assert.equal(r.stdout, "");
    assert.equal(r.exitCode, 0);
    assert.equal(bash.exec("cat /t.txt").stdout, "hi world\n");
});

test("q quits after the given line", () => {
    const bash = fresh();
    bash.vfs.writeFile("/t.txt", "1\n2\n3\n4\n5\n");
    assert.equal(bash.exec("sed '3q' /t.txt").stdout, "1\n2\n3\n");
});

test("-E treats parens/plus as regex metacharacters", () => {
    const bash = fresh();
    bash.vfs.writeFile("/t.txt", "const x = require('foo');\n");
    const r = bash.exec(`sed -E "s/const x = require\\('foo'\\);/import x from 'foo';/g" /t.txt`);
    assert.equal(r.stdout, "import x from 'foo';\n");
});

test("semicolons inside pattern/replacement do not split statements", () => {
    const bash = fresh();
    bash.vfs.writeFile("/t.txt", "a;b;c\n");
    assert.equal(bash.exec("sed 's/a;b/x;y/' /t.txt").stdout, "x;y;c\n");
});

test("regex address gates delete and nested substitute", () => {
    const bash = fresh();
    bash.vfs.writeFile("/t.txt", "foo\nbar\nbaz\n");
    assert.equal(bash.exec("sed '/bar/d' /t.txt").stdout, "foo\nbaz\n");
    const bash2 = fresh();
    bash2.vfs.writeFile("/t.txt", "apple\nbanana\napricot\n");
    assert.equal(bash2.exec("sed '/^a/s/a/A/g' /t.txt").stdout, "Apple\nbanana\nApricot\n");
});

test("r queues a file's contents after the matching line", () => {
    const bash = withFixtures();
    bash.vfs.writeFile("/test/block.txt", "INSERTED A\nINSERTED B\n");
    const r = bash.exec("sed '2r /test/block.txt' /test/numbers.txt");
    assert.equal(r.stdout, "line 1\nline 2\nINSERTED A\nINSERTED B\nline 3\nline 4\nline 5\n");
});

test("r is not suppressed by -n", () => {
    const bash = withFixtures();
    bash.vfs.writeFile("/test/note.txt", "NOTE\n");
    assert.equal(bash.exec("sed -n '2r /test/note.txt' /test/numbers.txt").stdout, "NOTE\n");
});

test("r on a missing file is silent", () => {
    const bash = withFixtures();
    const r = bash.exec("sed '2r /test/nope.txt' /test/numbers.txt");
    assert.equal(r.stdout, "line 1\nline 2\nline 3\nline 4\nline 5\n");
    assert.equal(r.stderr, "");
    assert.equal(r.exitCode, 0);
});

test("a appends text after the matching line", () => {
    const r = withFixtures().exec("sed '2a\\\ninserted' /test/numbers.txt");
    assert.equal(r.stdout, "line 1\nline 2\ninserted\nline 3\nline 4\nline 5\n");
});

test("a one-liner (GNU extension, no backslash-newline) appends text", () => {
    const r = withFixtures().exec("sed '2a inserted' /test/numbers.txt");
    assert.equal(r.stdout, "line 1\nline 2\ninserted\nline 3\nline 4\nline 5\n");
});

test("a with a multi-line backslash-continued block", () => {
    const r = withFixtures().exec("sed '2a\\\nfirst\\\nsecond' /test/numbers.txt");
    assert.equal(r.stdout, "line 1\nline 2\nfirst\nsecond\nline 3\nline 4\nline 5\n");
});

test("a is not suppressed by -n", () => {
    const r = withFixtures().exec("sed -n '2a\\\ninserted' /test/numbers.txt");
    assert.equal(r.stdout, "inserted\n");
});

test("i inserts text before the matching line", () => {
    const r = withFixtures().exec("sed '2i\\\ninserted' /test/numbers.txt");
    assert.equal(r.stdout, "line 1\ninserted\nline 2\nline 3\nline 4\nline 5\n");
});

test("c replaces the matching line with text", () => {
    const r = withFixtures().exec("sed '2c\\\nchanged' /test/numbers.txt");
    assert.equal(r.stdout, "line 1\nchanged\nline 3\nline 4\nline 5\n");
});

test("c on a two-address range prints its text once, at the range's end", () => {
    const r = withFixtures().exec("sed '2,4c\\\nchanged' /test/numbers.txt");
    assert.equal(r.stdout, "line 1\nchanged\nline 5\n");
});

test("Nth-occurrence substitution", () => {
    const bash = fresh();
    bash.vfs.writeFile("/t.txt", "foo bar foo baz foo\n");
    assert.equal(bash.exec("sed 's/foo/XXX/2' /t.txt").stdout, "foo bar XXX baz foo\n");
});
