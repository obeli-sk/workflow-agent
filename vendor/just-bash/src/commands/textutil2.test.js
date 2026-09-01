import { test } from "node:test";
import assert from "node:assert/strict";
import { Bash } from "../bash.js";
import {
    commCommand, joinCommand, nlCommand, odCommand, foldCommand,
    expandCommand, unexpandCommand, columnCommand, pasteCommand, stringsCommand, splitCommand,
} from "./textutil2.js";

// These commands aren't wired into commands/index.js yet (another process
// integrates the parallel command ports centrally), so tests register them
// as custom commands the same way a host embedding just-bash would.
function freshBash() {
    const bash = new Bash({ cwd: "/workspace" });
    bash.registerCommand("comm", commCommand);
    bash.registerCommand("join", joinCommand);
    bash.registerCommand("nl", nlCommand);
    bash.registerCommand("od", odCommand);
    bash.registerCommand("fold", foldCommand);
    bash.registerCommand("expand", expandCommand);
    bash.registerCommand("unexpand", unexpandCommand);
    bash.registerCommand("column", columnCommand);
    bash.registerCommand("paste", pasteCommand);
    bash.registerCommand("strings", stringsCommand);
    bash.registerCommand("split", splitCommand);
    return bash;
}

function run(script, opts) {
    return freshBash().exec(script, opts);
}

test("comm: three columns with no suppression", () => {
    const bash = freshBash();
    bash.vfs.writeFile("/a.txt", "apple\nbanana\ncherry\n");
    bash.vfs.writeFile("/b.txt", "banana\ncherry\ndate\n");
    const r = bash.exec("comm /a.txt /b.txt");
    assert.equal(r.stdout, "apple\n\t\tbanana\n\t\tcherry\n\tdate\n");
});

test("comm -12 suppresses columns 1 and 2, leaving only common lines", () => {
    const bash = freshBash();
    bash.vfs.writeFile("/a.txt", "a\nb\n");
    bash.vfs.writeFile("/b.txt", "b\nc\n");
    const r = bash.exec("comm -12 /a.txt /b.txt");
    assert.equal(r.stdout, "b\n");
});

test("join: default field-1 join", () => {
    const bash = freshBash();
    bash.vfs.writeFile("/a.txt", "1 apple\n2 banana\n");
    bash.vfs.writeFile("/b.txt", "1 red\n2 yellow\n");
    const r = bash.exec("join /a.txt /b.txt");
    assert.equal(r.stdout, "1 apple red\n2 banana yellow\n");
});

test("join -a 1 keeps unpairable lines from file 1", () => {
    const bash = freshBash();
    bash.vfs.writeFile("/a.txt", "1 apple\n3 cherry\n");
    bash.vfs.writeFile("/b.txt", "1 red\n");
    const r = bash.exec("join -a 1 /a.txt /b.txt");
    assert.equal(r.stdout, "1 apple red\n3 cherry\n");
});

test("nl: default style skips numbering blank lines but keeps their padding", () => {
    const r = run("printf 'one\\n\\ntwo\\n' | nl");
    assert.equal(r.stdout, "     1\tone\n      \t\n     2\ttwo\n");
});

test("nl -ba numbers every line including blanks", () => {
    const r = run("printf 'one\\n\\ntwo\\n' | nl -ba");
    assert.equal(r.stdout, "     1\tone\n     2\t\n     3\ttwo\n");
});

test("od: default octal dump has an address, byte octal codes, and a total", () => {
    const r = run("printf 'AB' | od");
    assert.ok(r.stdout.startsWith("0000000"));
    assert.ok(r.stdout.includes("101")); // 'A' == 0o101
    assert.ok(r.stdout.trim().endsWith("0000002"));
});

test("fold -w wraps at a fixed column width", () => {
    const r = run("printf '1234567890' | fold -w 4");
    assert.equal(r.stdout, "1234\n5678\n90");
});

test("fold -sw breaks at spaces, keeping the trailing space on the wrapped line", () => {
    assert.equal(run("echo 'abc defgh' | fold -sw 6").stdout, "abc \ndefgh\n");
    assert.equal(run("echo 'hello world foo bar' | fold -sw 10").stdout, "hello \nworld foo \nbar\n");
});

test("expand: default 8-column tab stops", () => {
    const r = run("printf 'a\\tb\\n' | expand");
    assert.equal(r.stdout, "a       b\n");
});

test("expand -t sets a custom tab width", () => {
    const r = run("printf 'a\\tb\\n' | expand -t 4");
    assert.equal(r.stdout, "a   b\n");
});

test("unexpand: converts leading spaces back to tabs", () => {
    const r = run("printf '        x\\n' | unexpand");
    assert.equal(r.stdout, "\tx\n");
});

test("column -c: fill mode packs items into rows under the given width", () => {
    const r = run("printf 'a\\nb\\nc\\n' | column -c 10");
    assert.equal(r.stdout, "a  b  c\n");
});

test("column -t: table mode aligns fields into padded columns", () => {
    const r = run("printf 'a 1\\nbb 22\\n' | column -t");
    assert.equal(r.stdout, "a   1\nbb  22\n");
});

test("paste: merges corresponding lines with a tab", () => {
    const bash = freshBash();
    bash.vfs.writeFile("/a.txt", "1\n2\n3\n");
    bash.vfs.writeFile("/b.txt", "a\nb\nc\n");
    const r = bash.exec("paste /a.txt /b.txt");
    assert.equal(r.stdout, "1\ta\n2\tb\n3\tc\n");
});

test("paste -s: serializes one file's lines onto a single row", () => {
    const bash = freshBash();
    bash.vfs.writeFile("/a.txt", "1\n2\n3\n");
    const r = bash.exec("paste -s /a.txt");
    assert.equal(r.stdout, "1\t2\t3\n");
});

test("strings -n: extracts printable runs at least N bytes long", () => {
    const r = run(String.raw`printf 'ab\001cdef\002gh' | strings -n 3`);
    assert.equal(r.stdout, "cdef\n");
});

test("split -l: splits a file into N-line chunks with alphabetic suffixes", () => {
    const bash = freshBash();
    bash.vfs.writeFile("/f.txt", "1\n2\n3\n4\n");
    const r = bash.exec("split -l 2 /f.txt /prefix");
    assert.equal(r.exitCode, 0);
    assert.equal(bash.vfs.readFile("/prefixaa"), "1\n2\n");
    assert.equal(bash.vfs.readFile("/prefixab"), "3\n4\n");
});

test("split -d: numeric suffixes instead of alphabetic", () => {
    const bash = freshBash();
    bash.vfs.writeFile("/f.txt", "1\n2\n3\n");
    bash.exec("split -l 1 -d /f.txt /p");
    assert.equal(bash.vfs.readFile("/p00"), "1\n");
    assert.equal(bash.vfs.readFile("/p01"), "2\n");
    assert.equal(bash.vfs.readFile("/p02"), "3\n");
});
