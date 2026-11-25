import { test } from "node:test";
import assert from "node:assert/strict";
import { TIMEOUT, OPERATOR, exitCodeForInterrupt } from "./watch.js";

test("exitCodeForInterrupt follows GNU conventions", () => {
    assert.equal(exitCodeForInterrupt(TIMEOUT), 124);
    assert.equal(exitCodeForInterrupt(OPERATOR), 130);
});

test("exitCodeForInterrupt rejects an unknown kind", () => {
    assert.throws(() => exitCodeForInterrupt("nope"), /unknown interrupt kind/);
});
