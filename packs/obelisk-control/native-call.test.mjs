import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const webapi = {};
globalThis.__nativeCallWebapi = webapi;
globalThis.obelisk = { ChildError: class ChildError extends Error {} };

const nativeSource = (await readFile(new URL("./native-call.js", import.meta.url), "utf8"))
    .replace("import * as webapi from 'obelisk-agent:tools/webapi';", "const webapi = globalThis.__nativeCallWebapi;");
const { default: nativeCall } = await import(
    `data:text/javascript;base64,${Buffer.from(nativeSource).toString("base64")}`
);
const callTargetSource = await readFile(new URL("./tools/call-target.js", import.meta.url), "utf8");
const { default: callTarget } = await import(
    `data:text/javascript;base64,${Buffer.from(callTargetSource).toString("base64")}`
);

test("accepted execution errors include the execution id without a WIT recap", () => {
    webapi.callTarget = () => JSON.stringify({
        execution_id: "E_accepted",
        result: JSON.stringify({ err: "not a callable function" }),
    });
    webapi.getFunctionWit = () => { throw new Error("must not fetch WIT"); };

    assert.throws(
        () => nativeCall("textkit:demo/pipeline.summarize-batch", "[[]]"),
        (error) => error === "execution E_accepted finished with Err: not a callable function",
    );
});

test("submission rejections include the server reason and WIT recap", () => {
    webapi.callTarget = () => JSON.stringify({ submission_rejected: "HTTP 400: bad parameters" });
    webapi.getFunctionWit = () => "interface pipeline { summarize-batch: func(); }";

    assert.throws(
        () => nativeCall("textkit:demo/pipeline.summarize-batch", "[]"),
        (error) => error.includes("HTTP 400: bad parameters")
            && error.includes("WIT for textkit:demo/pipeline.summarize-batch:")
            && error.includes("interface pipeline"),
    );
});

test("call-target submits first and follows the accepted execution by id", async () => {
    process.env.TARGET_OBELISK_API_URL = "http://target.test";
    process.env.TARGET_OBELISK_TOKEN = "secret";
    const requests = [];
    globalThis.fetch = async (url, init) => {
        requests.push({ url, init });
        if (requests.length === 1) {
            return new Response(JSON.stringify({ ok: "E_target" }), { status: 201 });
        }
        return new Response(JSON.stringify({ err: "not a callable function" }), { status: 200 });
    };

    const result = JSON.parse(await callTarget("textkit:demo/pipeline.summarize-batch", "[[]]"));
    assert.deepEqual(result, {
        execution_id: "E_target",
        result: JSON.stringify({ err: "not a callable function" }),
    });
    assert.equal(requests[0].url, "http://target.test/v1/executions");
    assert.equal(requests[0].init.method, "POST");
    assert.equal(requests[1].url, "http://target.test/v1/executions/E_target?follow=true");
});

test("call-target reports an HTTP submission rejection without following", async () => {
    process.env.TARGET_OBELISK_API_URL = "http://target.test";
    const requests = [];
    globalThis.fetch = async (url, init) => {
        requests.push({ url, init });
        return new Response(JSON.stringify({ err: "parameter 0 has the wrong type" }), { status: 400 });
    };

    const result = JSON.parse(await callTarget("textkit:demo/pipeline.summarize-batch", "[1]"));
    assert.deepEqual(result, { submission_rejected: "HTTP 400: parameter 0 has the wrong type" });
    assert.equal(requests.length, 1);
});
