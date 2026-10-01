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
    const controlPlane = createControlPlane(webapi, { ChildError }, null);
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

test("callTarget reports accepted execution errors with the execution id and no WIT recap", () => {
    const webapi = {
        callTarget: () => JSON.stringify({
            execution_id: "E_accepted",
            result: JSON.stringify({ err: "not a callable function" }),
        }),
        getFunctionWit: () => { throw new Error("must not fetch WIT"); },
    };
    const controlPlane = createControlPlane(webapi, {}, null);
    assert.throws(
        () => controlPlane.callTarget("textkit:demo/pipeline.summarize-batch", "[[]]"),
        (error) => error === "execution E_accepted finished with Err: not a callable function",
    );
});

test("callTarget reports submission rejections with the server reason and WIT recap", () => {
    const webapi = {
        callTarget: () => JSON.stringify({ submission_rejected: "HTTP 400: bad parameters" }),
        getFunctionWit: () => "interface pipeline { summarize-batch: func(); }",
    };
    const controlPlane = createControlPlane(webapi, {}, null);
    assert.throws(
        () => controlPlane.callTarget("textkit:demo/pipeline.summarize-batch", "[]"),
        (error) => error.includes("HTTP 400: bad parameters")
            && error.includes("WIT for textkit:demo/pipeline.summarize-batch:")
            && error.includes("interface pipeline"),
    );
});
