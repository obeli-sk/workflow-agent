import { test } from "node:test";
import assert from "node:assert/strict";
import inputAcceptedAt from "./input-accepted-at.js";

test("returns the injection stub's durable finish time in milliseconds", async () => {
    process.env.OBELISK_API_URL = "http://obelisk.test/";
    process.env.OBELISK_API_TOKEN = "token";
    globalThis.fetch = async (url) => {
        assert.equal(url, "http://obelisk.test/v1/executions/E_input/status");
        return new Response(JSON.stringify({
            pending_state: { status: "finished", finished_at: "2026-09-20T18:23:29.919847223Z" },
        }));
    };
    assert.equal(await inputAcceptedAt("E_input"), 1789928609919);
});

test("rejects a status without a durable finish time", async () => {
    process.env.OBELISK_API_URL = "http://obelisk.test";
    globalThis.fetch = async () => new Response(JSON.stringify({
        pending_state: { status: "pending_at" },
    }));
    await assert.rejects(() => inputAcceptedAt("E_input"), /no valid finished_at timestamp/);
});
