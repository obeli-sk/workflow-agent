import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeChildErrorValue } from "./host.js";

test("child activity errors match Rust's string-or-variant decoding", () => {
    assert.equal(decodeChildErrorValue("bad input"), "bad input");
    assert.equal(decodeChildErrorValue({ permanent_error: "bad input" }), "bad input");
    assert.equal(decodeChildErrorValue({ transient_error: "try again" }), "try again");
    assert.equal(decodeChildErrorValue({ other: "detail" }), '{"other":"detail"}');
});
