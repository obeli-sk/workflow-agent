import { test } from "node:test";
import assert from "node:assert/strict";
import discover from "./config-discover.js";

// Isolate each test from whatever the real environment (or a prior test)
// left behind; config-discover.js reads these lazily on every call.
const ENV_KEYS = ["MAX_STEPS", "PROGRAMS_JSON", "MCP_SERVERS_JSON", "APPS_JSON", "TARGET_OBELISK_WEBHOOK_URL"];

function withEnv(overrides, fn) {
    const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, overrides);
    try {
        return fn();
    } finally {
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    }
}

test("discover defaults MAX_STEPS and the built-in registries when unset", async () => {
    const config = await withEnv({}, () => discover("E_01XYZ", "", "", null));
    assert.equal(config.max_steps, 10);
    assert.deepEqual(config.programs, []);
    assert.deepEqual(config.mcp_servers, []);
    assert.deepEqual(config.apps, []);
    assert.equal(config.webhook_url, "");
});

test("discover parses PROGRAMS_JSON/MCP_SERVERS_JSON/APPS_JSON", async () => {
    const config = await withEnv(
        {
            PROGRAMS_JSON: JSON.stringify([{ name: "curl", ffqn: "ns:programs/program.curl", description: "fetch" }]),
            MCP_SERVERS_JSON: JSON.stringify([{ name: "srv", ffqn: "ns:mcp/server.srv" }]),
            APPS_JSON: JSON.stringify([{ name: "components", repo: "components" }]),
        },
        () => discover("E_01XYZ", "", "", null),
    );
    assert.deepEqual(config.programs, [{ name: "curl", ffqn: "ns:programs/program.curl", description: "fetch" }]);
    assert.deepEqual(config.mcp_servers, [{ name: "srv", ffqn: "ns:mcp/server.srv" }]);
    assert.deepEqual(config.apps, [
        { name: "components", owner: "obeli-sk", repo: "components", ref: "main", description: "" },
    ]);
});

test("discover's prompt_tail renders the static sections then This session, with identity and parent", async () => {
    const config = await withEnv({}, () => discover("E_01ABC.n:research_1", "claude", "low", "research"));
    const tail = config.prompt_tail;

    // Static sections come first, in order, followed by the per-session one.
    const userInputAt = tail.indexOf("# User input");
    const subagentsAt = tail.indexOf("# Subagents");
    const deployAt = tail.indexOf("# Deployment authoring");
    const mountsAt = tail.indexOf("# Mounts and network access");
    const sessionAt = tail.indexOf("# This session");
    assert.ok(
        userInputAt !== -1 && userInputAt < subagentsAt && subagentsAt < deployAt &&
        deployAt < mountsAt && mountsAt < sessionAt,
        tail,
    );

    assert.ok(tail.includes('"execution_id":"E_01ABC.n:research_1"'));
    assert.ok(tail.includes('"backend":"claude"'));
    assert.ok(tail.includes('"effort":"low"'));
    assert.ok(tail.includes('"name":"research"'));
    assert.ok(tail.includes('"parent_id":"E_01ABC"'));
    assert.ok(tail.includes("chat read E_01ABC.n:research_1"));
    assert.ok(tail.includes("chat read E_01ABC"));
});

test("discover's prompt_tail carries no parent section for a top-level session", async () => {
    const config = await withEnv({}, () => discover("E_01XYZ", "", "", null));
    const tail = config.prompt_tail;
    assert.ok(tail.includes('"name":null'));
    assert.ok(tail.includes('"parent_id":null'));
    assert.ok(!tail.includes("child session by"));
});

test("discover rejects invalid MAX_STEPS", async () => {
    await assert.rejects(withEnv({ MAX_STEPS: "0" }, () => discover("E_01XYZ", "", "", null)));
    await assert.rejects(withEnv({ MAX_STEPS: "not-a-number" }, () => discover("E_01XYZ", "", "", null)));
});

test("discover rejects malformed registries", async () => {
    await assert.rejects(withEnv({ PROGRAMS_JSON: "not json" }, () => discover("E_01XYZ", "", "", null)));
    await assert.rejects(withEnv({ APPS_JSON: JSON.stringify([{ owner: "o" }]) }, () => discover("E_01XYZ", "", "", null)));
});
