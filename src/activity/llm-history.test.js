import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMessages } from "./llm-history.js";

const msg = (text) => ({ role: "user", content: [{ type: "text", text }] });
const reply = (text) => [{ type: "text", text }];

function child(id, delta, content) {
    return {
        execution_id: id,
        created: { version: 0, event: { created: { params: ["system", JSON.stringify(delta), "[]", "model", "", []] } } },
        finished: { version: 2, event: { finished: { retval: { ok: { value: { reply: { content_json: JSON.stringify(content) } } } } } } },
    };
}

test("reconstructs history from one batch request in call order", async () => {
    const calls = [];
    const rows = new Map([
        ["a", child("a", [msg("first")], reply("one"))],
        ["b", child("b", [msg("second")], reply("two"))],
    ]);
    const fetchJson = async (path, body) => {
        calls.push({ path, body });
        return body.execution_ids.map((id) => rows.get(id));
    };

    const messages = await loadMessages(["a", "b"], JSON.stringify([msg("third")]), fetchJson);
    assert.deepEqual(messages, [
        msg("first"), { role: "assistant", content: reply("one") },
        msg("second"), { role: "assistant", content: reply("two") },
        msg("third"),
    ]);
    assert.deepEqual(calls, [{ path: "/v1/executions/events/batch", body: { execution_ids: ["a", "b"] } }]);
});

test("rejects a batch response that does not match the requested order", async () => {
    const fetchJson = async () => [child("b", [], reply("two")), child("a", [], reply("one"))];
    await assert.rejects(() => loadMessages(["a", "b"], "[]", fetchJson), /out of order at 0/);
});

test("first call uses only its delta", async () => {
    const messages = await loadMessages([], JSON.stringify([msg("hello")]), () => {
        throw new Error("unexpected fetch");
    });
    assert.deepEqual(messages, [msg("hello")]);
});
