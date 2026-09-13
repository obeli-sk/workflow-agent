import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, decodeChildErrorValue } from "./host.js";

test("child activity errors match Rust's string-or-variant decoding", () => {
    assert.equal(decodeChildErrorValue("bad input"), "bad input");
    assert.equal(decodeChildErrorValue({ permanent_error: "bad input" }), "bad input");
    assert.equal(decodeChildErrorValue({ transient_error: "try again" }), "try again");
    assert.equal(decodeChildErrorValue({ other: "detail" }), '{"other":"detail"}');
});

test("createHost preserves typed child errors without a global obelisk object", () => {
    class ChildError extends Error {
        constructor(value) {
            super("child failed");
            this.value = value;
        }
    }
    const dynamic = {
        call() {
            throw new ChildError({ permanent_missing_files: [{ path: "app.js", digest: "sha256:1" }] });
        },
    };
    const host = createHost(dynamic, { ChildError });
    assert.throws(
        () => host.callJson("test:pkg/ifc.fn", "[]"),
        (error) => error === '{"permanent_missing_files":[{"path":"app.js","digest":"sha256:1"}]}',
    );
});
