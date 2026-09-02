import { test } from "node:test";
import assert from "node:assert/strict";
import { Bash } from "../bash.js";

function run(script) {
    return new Bash({ cwd: "/workspace" }).exec(script);
}

test("base64 roundtrip", () => {
    assert.equal(run("echo -n hello | base64").stdout, "aGVsbG8=\n");
    assert.equal(run("echo -n aGVsbG8= | base64 -d").stdout, "hello");
});

test("base64 wrap 0 disables wrapping", () => {
    const r = run("echo -n 'a very long string that would normally wrap' | base64 -w 0");
    assert.equal((r.stdout.match(/\n/g) ?? []).length, 0);
});

test("md5sum known vectors", () => {
    assert.match(run("printf '' | md5sum").stdout, /^d41d8cd98f00b204e9800998ecf8427e/);
    assert.match(run("printf abc | md5sum").stdout, /^900150983cd24fb0d6963f7d28e17f72/);
});

test("md5sum file operand", () => {
    const bash = new Bash({ cwd: "/workspace" });
    bash.exec("printf abc > /f.txt");
    assert.equal(bash.exec("md5sum /f.txt").stdout, "900150983cd24fb0d6963f7d28e17f72  /f.txt\n");
});

test("md5sum missing file errors", () => {
    const r = run("md5sum /missing.txt");
    assert.match(r.stdout, /No such file or directory/);
    assert.equal(r.exitCode, 1);
});

test("md5sum check mode", () => {
    const bash = new Bash({ cwd: "/workspace" });
    bash.exec("printf abc > /f.txt");
    bash.exec("printf '900150983cd24fb0d6963f7d28e17f72  /f.txt\\n' > /sums.txt");
    const r = bash.exec("md5sum -c /sums.txt");
    assert.equal(r.stdout, "/f.txt: OK\n");
    assert.equal(r.exitCode, 0);
});

test("sha256sum known vectors and local file", () => {
    assert.equal(
        run("printf abc | sha256sum").stdout,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  -\n",
    );
    const bash = new Bash({ cwd: "/workspace" });
    bash.exec("printf abc > /f.txt");
    assert.equal(
        bash.exec("sha256sum /f.txt").stdout,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  /f.txt\n",
    );
});
