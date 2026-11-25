import { test } from "node:test";
import assert from "node:assert/strict";
import { Bash } from "../bash.js";

function run(script) {
    return new Bash({ cwd: "/workspace" }).exec(script);
}

test("default echo joins args", () => {
    assert.equal(run("printf 'a\\nb\\nc\\n' | xargs echo").stdout, "a b c\n");
});

test("-n batches arguments", () => {
    assert.equal(run("printf 'a\\nb\\nc\\nd\\n' | xargs -n 2 echo").stdout, "a b\nc d\n");
});

test("-I replaces the placeholder", () => {
    assert.equal(run('printf \'a\\nb\\n\' | xargs -I {} echo "[{}]"').stdout, "[a]\n[b]\n");
});

test("no command defaults to echo", () => {
    assert.equal(run("echo hi | xargs").stdout, "hi\n");
});

test("-0 splits on NUL", () => {
    assert.equal(run('printf "a\\0b\\0" | xargs -0 echo').stdout, "a b\n");
});
