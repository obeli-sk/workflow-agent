// Unit tests for the watch stream's SSE parsing and upstream event mapping.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSseParser, pumpSse } from "./sse.js";
import { translate, watchIds } from "./watch-events.js";

test("parser joins blocks split across chunks and keeps comments", () => {
    const parse = createSseParser();
    assert.deepEqual(parse("event: responses\nid: 3\nda"), []);
    assert.deepEqual(parse("ta: {\"a\":1}\n\n:heartbeat\n\nevent: x\r\ndata: 1\r\ndata: 2\r\n\r\n"), [
        { event: "responses", data: "{\"a\":1}" },
        { comment: "heartbeat" },
        { event: "x", data: "1\n2" },
    ]);
});

test("pumpSse decodes multi-byte characters split between chunks", async () => {
    const bytes = new TextEncoder().encode("data: č\n\n");
    const chunks = [bytes.subarray(0, 7), bytes.subarray(7)];
    const reader = {
        read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }),
    };
    const blocks = [];
    await pumpSse(reader, (block) => blocks.push(block));
    assert.deepEqual(blocks, [{ event: "message", data: "č" }]);
});

test("statuses are reduced to id, status and max_version", () => {
    const data = JSON.stringify([{
        execution_id: "E_1",
        ffqn: "a:b/c.d",
        pending_state: { status: "locked" },
        max_version: 7,
    }]);
    assert.equal(
        translate("statuses", { event: "statuses", data }),
        "event: statuses\ndata: [{\"id\":\"E_1\",\"status\":\"locked\",\"max_version\":7}]\n\n",
    );
});

test("only non-empty response pages signal the run", () => {
    assert.equal(translate("run", { event: "responses", data: "{\"responses\":[{}]}" }), "event: run\ndata: {}\n\n");
    assert.equal(translate("run", { event: "responses", data: "{\"responses\":[]}" }), ": heartbeat\n\n");
    assert.equal(translate("run", { event: "other", data: "{}" }), ": heartbeat\n\n");
});

test("watched ids put the open run first and drop duplicates", () => {
    assert.deepEqual(watchIds("E_2", ["E_1", "E_2", ""]), ["E_2", "E_1"]);
    assert.deepEqual(watchIds("", []), []);
    assert.equal(watchIds("E_0", Array.from({ length: 300 }, (_, i) => "E_" + (i + 1))).length, 200);
});
