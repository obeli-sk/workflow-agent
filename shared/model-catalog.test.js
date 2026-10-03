import assert from "node:assert/strict";
import test from "node:test";
import { loadModelCatalog, resolveModel } from "./model-catalog.js";
import completion from "../activity/llm-chat.js";
import { loadModels } from "../webhook/lib/models.js";

async function withEndpoint(catalog, fetcher, run) {
    const keys = ["AGENT_MODELS", "LLM_BASE_URL", "LLM_API_KEY"];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const previousFetch = globalThis.fetch;
    process.env.AGENT_MODELS = catalog;
    process.env.LLM_BASE_URL = "http://llm.test/";
    process.env.LLM_API_KEY = "test-key";
    globalThis.fetch = fetcher;
    try { await run(); }
    finally {
        globalThis.fetch = previousFetch;
        for (const key of keys) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
    }
}

const response = (body, status = 200) => ({
    status,
    ok: status < 400,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
});

test("discovery works without a configured catalog and supplies the picker and LLM request", async () => {
    const calls = [];
    await withEndpoint("[]", async (url, options) => {
        calls.push({ url, options });
        assert.equal(options.headers.authorization, "Bearer test-key");
        if (url.endsWith("/v1/models")) {
            return response({ data: [{ id: "codex/discovered", display_name: "Discovered", is_default: true }] });
        }
        assert.equal(url, "http://llm.test/v1/chat/completions");
        assert.equal(JSON.parse(options.body).model, "codex/discovered");
        return response({ choices: [{ message: { content: "hello" }, finish_reason: "stop" }] });
    }, async () => {
        assert.deepEqual((await loadModels()).models, [{ id: "codex/discovered", label: "Discovered", api_type: "openai-chat-completions" }]);
        const result = await completion("", JSON.stringify([{ role: "user", content: [{ type: "text", text: "hi" }] }]), "[]", "codex/discovered", "", []);
        assert.equal(JSON.parse(result.reply.content_json)[0].text, "hello");
        assert.equal(calls[0].url, "http://llm.test/v1/models");
    });
});

test("discovery preserves configured wire adapters and aliases, and prefers advertised defaults", async () => {
    const configured = [{ id: "legacy", wire_model: "provider/model", api_type: "openai-responses", path: "/gateway", max_tokens: 100 }];
    await withEndpoint(JSON.stringify(configured), async () => response({ data: [
        { id: "other/model" }, { id: "provider/model", display_name: "Provider model", is_default: true },
    ] }), async () => {
        const catalog = await loadModelCatalog();
        assert.equal(catalog[0].id, "legacy");
        const config = await resolveModel("provider/model");
        assert.equal(config.api_type, "openai-responses");
        assert.equal(config.path, "/gateway");
        assert.equal(config.max_tokens, 100);
        assert.equal((await resolveModel("legacy")).wire_model, "provider/model");
    });
});

test("unavailable, empty, or malformed discovery falls back to the configured catalog", async () => {
    const configured = [{ id: "configured", api_type: "anthropic-messages", wire_model: "claude-model" }];
    const failures = [
        async () => response("", 404),
        async () => response({ data: [] }, 503),
        async () => { throw new Error("connection refused"); },
        async () => response("not JSON"),
        async () => response({ data: [] }),
        async () => response({ data: [{ id: null }] }),
    ];
    for (const fetcher of failures) {
        await withEndpoint(JSON.stringify(configured), fetcher, async () => {
            assert.equal((await loadModelCatalog())[0].id, "configured");
            assert.equal((await resolveModel("configured")).api_type, "anthropic-messages");
        });
    }
});

test("existing session aliases remain usable when the discovered list contains only explicit models", async () => {
    await withEndpoint(JSON.stringify([{ id: "codex", api_type: "openai-chat-completions" }]), async () => response({ data: [{ id: "codex/new-model" }] }), async () => {
        assert.equal((await loadModelCatalog())[0].id, "codex/new-model");
        assert.equal((await resolveModel("codex")).id, "codex");
    });
});

test("a discovered catalog is usable even when the configured fallback is invalid", async () => {
    await withEndpoint("not JSON", async () => response({ data: [{ id: "discovered" }] }), async () => {
        assert.equal((await resolveModel("discovered")).id, "discovered");
    });
});

test("LLM activity returns a string error when neither catalog has the selected model", async () => {
    await withEndpoint("[]", async () => response("", 404), async () => {
        await assert.rejects(
            completion("", "[]", "[]", "missing", "", []),
            (error) => typeof error === "string" && error.includes("not in the model catalog"),
        );
    });
});
