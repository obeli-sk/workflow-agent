import { test } from "node:test";
import assert from "node:assert/strict";
import { createControlPlane, decodeChildErrorValue } from "./host.js";

test("child activity errors match Rust's string-or-variant decoding", () => {
    assert.equal(decodeChildErrorValue("bad input"), "bad input");
    assert.equal(decodeChildErrorValue({ permanent_error: "bad input" }), "bad input");
    assert.equal(decodeChildErrorValue({ transient_error: "try again" }), "try again");
    assert.equal(decodeChildErrorValue({ other: "detail" }), '{"other":"detail"}');
});

test("deploymentSubmit surfaces the missing-files arm and flattens other child errors", () => {
    class ChildError extends Error {
        constructor(value) {
            super("child failed");
            this.value = value;
        }
    }
    const missing = [{ path: "app.js", digest: "sha256:1" }];
    let failure = new ChildError({ permanent_missing_files: missing });
    const webapi = {
        deploymentSubmit() {
            throw failure;
        },
    };
    const controlPlane = createControlPlane(webapi, null, { ChildError }, null);
    assert.throws(
        () => controlPlane.deploymentSubmit("", [], "", false, ""),
        (error) => JSON.stringify(error) === JSON.stringify({ missingFiles: missing }),
    );
    failure = new ChildError({ permanent_error: "bad manifest" });
    assert.throws(
        () => controlPlane.deploymentSubmit("", [], "", false, ""),
        (error) => error === "bad manifest",
    );
});
