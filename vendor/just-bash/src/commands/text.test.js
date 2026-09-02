import { test } from "node:test";
import assert from "node:assert/strict";
import { Bash } from "../bash.js";

function run(script, stdin) {
    return new Bash({ cwd: "/workspace" }).exec(script, { stdin });
}

test("cut -f selects fields by delimiter", () => {
    const r = run("printf 'a:b:c\\nd:e:f\\n' | cut -d: -f2,3");
    assert.equal(r.stdout, "b:c\ne:f\n");
});

test("cut -c selects characters and supports open ranges", () => {
    const r = run("echo -n abcdef | cut -c2-4");
    assert.equal(r.stdout, "bcd\n");
    const r2 = run("echo -n abcdef | cut -c3-");
    assert.equal(r2.stdout, "cdef\n");
});

test("cut -s suppresses lines without the delimiter", () => {
    const r = run("printf 'a:b\\nnodelim\\n' | cut -d: -f1 -s");
    assert.equal(r.stdout, "a\n");
});

test("tr translates SET1 to SET2", () => {
    const r = run("echo -n abc | tr a-c A-C");
    assert.equal(r.stdout, "ABC");
});

test("tr -d deletes characters in SET1", () => {
    const r = run("echo -n 'hello world' | tr -d aeiou");
    assert.equal(r.stdout, "hll wrld");
});

test("tr -s squeezes repeats", () => {
    const r = run("echo -n 'aaabbbccc' | tr -s ab");
    assert.equal(r.stdout, "abccc");
});

test("tr posix class [:digit:]", () => {
    const r = run("echo -n 'a1b2c3' | tr -d '[:digit:]'");
    assert.equal(r.stdout, "abc");
});
