import { test } from "node:test";
import assert from "node:assert/strict";
import { Bash } from "../bash.js";

function fresh() {
    return new Bash({ cwd: "/workspace" });
}

test("finds matching lines", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test.txt", "hello world\nfoo bar\nhello again\n");
    const r = bash.exec("grep hello /test.txt");
    assert.equal(r.stdout, "hello world\nhello again\n");
    assert.equal(r.exitCode, 0);
});

test("no match exits 1", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test.txt", "hello world\n");
    const r = bash.exec("grep missing /test.txt");
    assert.equal(r.stdout, "");
    assert.equal(r.exitCode, 1);
});

test("-i ignores case", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test.txt", "Hello\nhello\nHELLO\n");
    assert.equal(bash.exec("grep -i hello /test.txt").stdout, "Hello\nhello\nHELLO\n");
});

test("-n shows line numbers", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test.txt", "aaa\nbbb\naaa\n");
    assert.equal(bash.exec("grep -n aaa /test.txt").stdout, "1:aaa\n3:aaa\n");
});

test("-v inverts the match", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test.txt", "keep\nremove\nkeep\n");
    assert.equal(bash.exec("grep -v remove /test.txt").stdout, "keep\nkeep\n");
});

test("-c counts matches", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test.txt", "a\nb\na\na\n");
    assert.equal(bash.exec("grep -c a /test.txt").stdout, "3\n");
});

test("-l lists only files with matches", () => {
    const bash = fresh();
    bash.vfs.writeFile("/a.txt", "found here\n");
    bash.vfs.writeFile("/b.txt", "nothing\n");
    assert.equal(bash.exec("grep -l found /a.txt /b.txt").stdout, "/a.txt\n");
});

test("-r recurses into directories, skipping dotfiles", () => {
    const bash = fresh();
    bash.vfs.writeFile("/dir/root.txt", "needle here\n");
    bash.vfs.writeFile("/dir/sub/file.txt", "another needle\n");
    bash.vfs.writeFile("/dir/.hidden.txt", "needle in dotfile\n");
    const r = bash.exec("grep -r needle /dir");
    assert.match(r.stdout, /\/dir\/root.txt:needle here/);
    assert.match(r.stdout, /\/dir\/sub\/file.txt:another needle/);
    assert.doesNotMatch(r.stdout, /hidden/);
});

test("-w matches whole words only", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test.txt", "cat\ncats\ncat dog\ncaterpillar\n");
    assert.equal(bash.exec("grep -w cat /test.txt").stdout, "cat\ncat dog\n");
});

test("-E enables alternation", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test.txt", "cat\ndog\nbird\n");
    assert.equal(bash.exec('grep -E "cat|dog" /test.txt').stdout, "cat\ndog\n");
});

test("basic-regex * is a quantifier after a character", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test.txt", "ac\nabc\nabbc\nabbbc\n");
    assert.equal(bash.exec('grep "ab*c" /test.txt').stdout, "ac\nabc\nabbc\nabbbc\n");
});

test("basic-regex anchors", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test.txt", "hello world\nworld hello\n");
    assert.equal(bash.exec('grep "^hello" /test.txt').stdout, "hello world\n");
});

test("character class and negation", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test.txt", "cat\nbat\nrat\nhat\n");
    assert.equal(bash.exec('grep "[cbr]at" /test.txt').stdout, "cat\nbat\nrat\n");
    assert.equal(bash.exec('grep "[^cbr]at" /test.txt').stdout, "hat\n");
});

test("missing pattern errors", () => {
    const r = fresh().exec("grep");
    assert.equal(r.stderr, "grep: missing pattern\n");
    assert.equal(r.exitCode, 2);
});

test("missing file is exit code 2", () => {
    const r = fresh().exec("grep pattern /missing.txt");
    assert.equal(r.stderr, "grep: /missing.txt: No such file or directory\n");
    assert.equal(r.exitCode, 2);
});

test("a directory without -r errors but is not fatal", () => {
    const bash = fresh();
    bash.vfs.writeFile("/dir/file.txt", "content\n");
    const r = bash.exec("grep pattern /dir");
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "grep: /dir: Is a directory\n");
});

test("POSIX class inside -E", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test.txt", "abc\n123\na1b\n");
    assert.equal(bash.exec("grep -E '^[[:alpha:]]+$' /test.txt").stdout, "abc\n");
});

test("- reads stdin", () => {
    const r = fresh().exec("printf 'hello world\\nbye\\n' | grep hello -");
    assert.equal(r.stdout, "hello world\n");
    assert.equal(r.exitCode, 0);
});

test("-L exits 0 even though it prints nothing when everything matches", () => {
    const bash = fresh();
    bash.vfs.writeFile("/a.txt", "needle\n");
    const r = bash.exec("grep -L needle /a.txt");
    assert.equal(r.stdout, "");
    assert.equal(r.exitCode, 0);
});

test("-f reads patterns from a file and ORs them", () => {
    const bash = fresh();
    bash.vfs.writeFile("/pat.txt", "apple\nbanana\n");
    bash.vfs.writeFile("/hay.txt", "apple pie\ncherry\nbanana split\n");
    const r = bash.exec("grep -f /pat.txt /hay.txt");
    assert.equal(r.stdout, "apple pie\nbanana split\n");
});

test("-x with -f anchors every alternative", () => {
    const bash = fresh();
    bash.vfs.writeFile("/pat.txt", "foo\nbar\n");
    bash.vfs.writeFile("/data.txt", "foo\nbar\nfoobar\n");
    assert.equal(bash.exec("grep -x -f /pat.txt /data.txt").stdout, "foo\nbar\n");
});

test("-A/-B/-C add context lines, using - vs : to mark non-matches", () => {
    const bash = fresh();
    bash.vfs.writeFile("/t.txt", "1\n2\n3\nMATCH\n5\n6\n7\n");
    const r = bash.exec("grep -n -C 1 MATCH /t.txt");
    assert.equal(r.stdout, "3-3\n4:MATCH\n5-5\n");
});

test("-A/-B/-C insert -- between non-adjacent context blocks", () => {
    const bash = fresh();
    bash.vfs.writeFile("/t.txt", "MATCH\n2\n3\n4\n5\n6\nMATCH\n");
    const r = bash.exec("grep -A 1 MATCH /t.txt");
    assert.equal(r.stdout, "MATCH\n2\n--\nMATCH\n");
});

test("-o prints only the matched text", () => {
    const bash = fresh();
    bash.vfs.writeFile("/t.txt", "foo123bar456\n");
    assert.equal(bash.exec('grep -oE "[0-9]+" /t.txt').stdout, "123\n456\n");
});
