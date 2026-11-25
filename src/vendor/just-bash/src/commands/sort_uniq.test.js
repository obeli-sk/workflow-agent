import { test } from "node:test";
import assert from "node:assert/strict";
import { Bash } from "../bash.js";

function run(script) {
    return new Bash({ cwd: "/workspace" }).exec(script);
}

test("default sort is lexical", () => {
    assert.equal(run("printf 'banana\\napple\\ncherry\\n' | sort").stdout, "apple\nbanana\ncherry\n");
});

test("-n sorts numerically", () => {
    assert.equal(run("printf '10\\n2\\n1\\n' | sort -n").stdout, "1\n2\n10\n");
});

test("-r reverses the order", () => {
    assert.equal(run("printf 'a\\nc\\nb\\n' | sort -r").stdout, "c\nb\na\n");
});

test("-u drops duplicate lines", () => {
    assert.equal(run("printf 'b\\na\\nb\\n' | sort -u").stdout, "a\nb\n");
});

test("-k sorts by a field", () => {
    const r = run("printf '3 c\\n1 a\\n2 b\\n' | sort -k1,1n");
    assert.equal(r.stdout, "1 a\n2 b\n3 c\n");
});

test("-t sets the field delimiter", () => {
    const r = run("printf 'z:1\\na:2\\n' | sort -t: -k1,1");
    assert.equal(r.stdout, "a:2\nz:1\n");
});

test("-c reports the first out-of-order line", () => {
    const r = run("printf 'a\\nc\\nb\\n' | sort -c");
    assert.match(r.stderr, /disorder: b/);
    assert.equal(r.exitCode, 1);
});

test("uniq collapses adjacent duplicates", () => {
    assert.equal(run("printf 'a\\na\\nb\\na\\n' | uniq").stdout, "a\nb\na\n");
});

test("uniq -c counts occurrences", () => {
    assert.equal(run("printf 'a\\na\\nb\\n' | uniq -c").stdout, "   2 a\n   1 b\n");
});

test("uniq -d shows only repeated lines", () => {
    assert.equal(run("printf 'a\\na\\nb\\nc\\nc\\n' | uniq -d").stdout, "a\nc\n");
});

test("uniq -u shows only unique lines", () => {
    assert.equal(run("printf 'a\\na\\nb\\n' | uniq -u").stdout, "b\n");
});
