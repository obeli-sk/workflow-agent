// Unit tests for the peer-session chat program (activity/chat.js). fetch is
// stubbed with a canned route table so no network is involved; assertions cover
// catalog rendering, run listing/projection, send's offer lookup, create, and
// usage errors.

import { test } from "node:test";
import assert from "node:assert/strict";
import chat from "./chat.js";

const RUN_ID = "E_run0000000000000000000000001";
const OFFER_ID = RUN_ID + ".01Joffer";

function jsonResponse(status, body) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { status, ok: status < 400, text: async () => text };
}

// serve([[method, urlIncludes, responder], ...]) routes by method plus
// substring match, in order; unmatched calls return 404 and are recorded.
async function run(args, routes = [], stdin = "", env = {}) {
    const calls = [];
    const table = routes.map(([method, match, respond]) => ({ method, match, respond }));
    const originalFetch = globalThis.fetch;
    const originalEnv = {};
    for (const key of ["OBELISK_API_URL", "OBELISK__API__TOKEN", "AGENT_MODELS"]) {
        originalEnv[key] = process.env[key];
    }
    process.env.OBELISK_API_URL = "http://127.0.0.1:5005";
    process.env.OBELISK__API__TOKEN = "test-token";
    process.env.AGENT_MODELS = '[{"id":"fake","label":"Fake","api_type":"openai-chat-completions"}]';
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    globalThis.fetch = async (href, init) => {
        const url = String(href);
        const method = init?.method ?? "GET";
        calls.push({ method, url, init });
        for (const route of table) {
            if (route.method === method && url.includes(route.match)) {
                return await route.respond(url, init);
            }
        }
        return jsonResponse(404, "not found");
    };
    try {
        const result = await chat(stdin, args);
        return { result, calls };
    } finally {
        globalThis.fetch = originalFetch;
        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

// One GET /responses row; the record-output stub's result hides three levels
// deep (see webhook/lib/responses.js).
function sessionEvent(value) {
    return {
        event: {
            created_at: "2026-08-25T00:00:00Z",
            event: {
                join_set_id: "n:session-events",
                event: {
                    type: "child_execution_finished",
                    result: { ok: { value } },
                },
            },
        },
    };
}

function responsesPayload(values, scanCursor = values.length, maxCursor = scanCursor) {
    return {
        responses: values.map(sessionEvent),
        scan_cursor: scanCursor,
        max_cursor: maxCursor,
    };
}

test("models lists id, label, api type", async () => {
    const { result } = await run(["models"]);
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, "fake\tFake\topenai-chat-completions\n");
});

test("models reports an unusable catalog on stderr", async () => {
    const empty = await run(["models"], [], "", { AGENT_MODELS: "[]" });
    assert.equal(empty.result.exit_code, 0);
    assert.equal(empty.result.stdout, "");
    const broken = await run(["models"], [], "", { AGENT_MODELS: "not-json" });
    assert.equal(broken.result.exit_code, 1);
    assert.match(broken.result.stderr, /AGENT_MODELS is not valid JSON/);
    const missing = await run(["models"], [], "", { AGENT_MODELS: undefined });
    assert.equal(missing.result.exit_code, 1);
    assert.match(missing.result.stderr, /AGENT_MODELS is not configured/);
});

test("list queries sessions with derived included and renders rows", async () => {
    const { result, calls } = await run(["list"], [
        ["GET", "join_set=session-name", () => jsonResponse(200, responsesPayload([
            { name: "my-slug" },
        ]))],
        ["GET", "/v1/executions?", (url) => {
            assert.ok(url.includes("ffqn_prefix=obelisk-agent%3Aworkflow%2Fworkflow.run-cancellable"));
            assert.ok(url.includes("show_derived=true"));
            assert.ok(url.includes("length=20"));
            return jsonResponse(200, [{
                execution_id: RUN_ID,
                created_at: "2026-08-25T01:02:03Z",
                pending_state: { status: "blocked_by_join_set", join_set_id: "n:user" },
            }]);
        }],
        ["GET", `/executions/${RUN_ID}/responses`, () => jsonResponse(200, responsesPayload([
            { agent_status: { working: true, turn_index: 0 } },
        ]))],
        ["GET", `/executions/${RUN_ID}/events`, () => jsonResponse(200, {
            events: [{ event: { created: { params: ["do things", "fake", null, "low"] } } }],
        })],
    ]);
    assert.equal(result.exit_code, 0);
    // Parked on the user join set while working: listed as working.
    assert.match(result.stdout, new RegExp(`${RUN_ID}.*blocked_by_join_set/working.*my-slug.*do things`));
    assert.equal(calls.length, 4);
});

test("list ignores a stale working flag from an older turn", async () => {
    const { result } = await run(["list"], [
        ["GET", "join_set=session-name", () => jsonResponse(200, responsesPayload([]))],
        ["GET", "ffqn_prefix", () => jsonResponse(200, [{
            execution_id: RUN_ID,
            created_at: "2026-08-25T01:02:03Z",
            pending_state: { status: "blocked_by_join_set", join_set_id: "n:user" },
        }])],
        ["GET", `/executions/${RUN_ID}/responses`, () => jsonResponse(200, responsesPayload([
            // Oldest-first: the model worked during turn 0, then parked.
            { agent_status: { working: true, turn_index: 0 } },
            { agent_status: { working: false, turn_index: 0 } },
        ]))],
    ]);
    assert.equal(result.exit_code, 0);
    assert.ok(!result.stdout.includes("/working"), result.stdout);
});

test("names come off the dedicated session-name join set", async () => {
    const { result } = await run(["list"], [
        ["GET", "join_set=session-name", (url) => {
            // Newest-first filtered page: one response is enough. The page
            // comes back oldest-to-newest even in the older direction.
            assert.ok(url.includes("direction=older"));
            assert.ok(url.includes("length=1"));
            return jsonResponse(200, responsesPayload([{ name: "dedicated-slug" }]));
        }],
        ["GET", "ffqn_prefix", () => jsonResponse(200, [{
            execution_id: RUN_ID,
            created_at: "2026-08-25T01:02:03Z",
            pending_state: { status: "blocked_by_join_set", join_set_id: "n:user" },
        }])],
    ]);
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout, /dedicated-slug/);
});

test("state emits one JSON line with offer, backend, and name", async () => {
    const { result } = await run(["state", RUN_ID], [
        ["GET", "/status", () => jsonResponse(200, {
            pending_state: { status: "blocked_by_join_set", join_set_id: "n:user" },
        })],
        ["GET", "/responses", () => jsonResponse(200, responsesPayload([
            { input_offered: { execution_id: OFFER_ID, turn_index: 1 } },
            { session_started: { protocol_version: 6, prompt: "p", backend: "fake", effort: "", system_prompt: "big" } },
            { session_renamed: { name: "renamed-slug" } },
        ]))],
    ]);
    assert.equal(result.exit_code, 0);
    const state = JSON.parse(result.stdout);
    assert.equal(state.status, "blocked_by_join_set");
    assert.equal(state.pending_offer_id, OFFER_ID);
    assert.equal(state.backend, "fake");
    assert.equal(state.name, "renamed-slug");
    // Parked with the newest offer armed for turn 1: the counter sits at 2.
    assert.equal(state.turn_index, 2);
    assert.equal(state.last_reply, null);
    assert.ok(!result.stdout.includes("big"), "system prompt must not leak through state");
});

test("state counts a mid-flight model turn as its own index", async () => {
    const { result } = await run(["state", RUN_ID], [
        ["GET", "/status", () => jsonResponse(200, {
            pending_state: { status: "blocked_by_join_set", join_set_id: "n:user" },
        })],
        ["GET", "/responses", () => jsonResponse(200, responsesPayload([
            { agent_status: { working: true, turn_index: 3 } },
            { assistant_reply: { content_json: JSON.stringify([
                { type: "text", text: "running..." }, { type: "tool_use", id: "t", name: "bash", input: {} },
            ]), turn_index: 3, turn_complete: false } },
            { tool_result: { id: "t", output: { ok: { output: [{ stdout: "" }], exit_code: 0 } }, turn_index: 3 } },
            { input_offered: { execution_id: OFFER_ID, turn_index: 3 } },
        ]))],
    ]);
    const state = JSON.parse(result.stdout);
    assert.equal(state.working, true);
    assert.equal(state.state, "thinking");
    assert.equal(state.turn_index, 3);
});

test("state reports the next turn after shell-only exchanges", async () => {
    // Mirrors a session driven purely by `$ composer` commands: no working
    // flag since startup, two completed shell turns, offer armed for turn 1.
    const { result } = await run(["state", RUN_ID], [
        ["GET", "/status", () => jsonResponse(200, {
            pending_state: { status: "blocked_by_join_set", join_set_id: "n:user" },
        })],
        ["GET", "/responses", () => jsonResponse(200, responsesPayload([
            { agent_status: { working: false, turn_index: 0 } },
            { shell_output: { id: "s1", script: "pwd", result: { output: [{ stdout: "/w\n" }], exit_code: 0 }, turn_index: 0, turn_complete: true } },
            { shell_output: { id: "s2", script: "ls", result: { output: [], exit_code: 0 }, turn_index: 1, turn_complete: true } },
            { input_offered: { execution_id: OFFER_ID, turn_index: 1 } },
        ]))],
    ]);
    const state = JSON.parse(result.stdout);
    assert.equal(state.state, "shell-only");
    assert.equal(state.turn_index, 2);
});

test("a composer command after the reply supersedes final response", async () => {
    // Mirrors E_01M0YQJ2PKF: answered at turns 0 and 1, then `$ pwd` ran at
    // turn 2; the stale reply must not keep the final-response label.
    const reply = (turn) => ({
        assistant_reply: {
            content_json: JSON.stringify([{ type: "text", text: "answer " + turn }]),
            turn_index: turn,
            turn_complete: true,
        },
    });
    const { result } = await run(["state", RUN_ID], [
        ["GET", "/status", () => jsonResponse(200, {
            pending_state: { status: "blocked_by_join_set", join_set_id: "n:user" },
        })],
        ["GET", "/responses", () => jsonResponse(200, responsesPayload([
            { agent_status: { working: false, turn_index: 1 } },
            reply(1),
            { input_offered: { execution_id: OFFER_ID, turn_index: 2 } },
            { shell_output: { id: "s3", script: "pwd", result: { output: [], exit_code: 0 }, turn_index: 2, turn_complete: true } },
        ]))],
    ]);
    const state = JSON.parse(result.stdout);
    assert.equal(state.state, "shell-only");
    assert.equal(state.label, "shell");
    assert.deepEqual(state.last_reply, { turn: 1 });
    assert.equal(state.turn_index, 3);
});

test("state points at the newest finished assistant message", async () => {
    const reply = (text, turn, complete) => ({
        assistant_reply: {
            content_json: JSON.stringify([{ type: "text", text }]),
            turn_index: turn,
            turn_complete: complete,
        },
    });
    const { result } = await run(["state", RUN_ID], [
        ["GET", "/status", () => jsonResponse(200, { pending_state: { status: "finished" } })],
        ["GET", "/responses", () => jsonResponse(200, responsesPayload([
            reply("final answer v1", 1, true),
            // A mid-step tool-call reply does not hide the newer final answer.
            reply("working on it", 3, false),
            reply("final answer v2", 3, true),
        ]))],
    ]);
    const state = JSON.parse(result.stdout);
    assert.deepEqual(state.last_reply, { turn: 3 });
});

test("read renders turns and --system gates the system prompt", async () => {
    const routes = [
        ["GET", "/status", () => jsonResponse(200, { pending_state: { status: "finished" } })],
        ["GET", "/responses", () => jsonResponse(200, responsesPayload([
            { user_message: { id: "m1", text: "hello there", turn_index: 0 } },
            { assistant_reply: { content_json: JSON.stringify([
                { type: "text", text: "let me check" },
                { type: "tool_use", name: "bash", input: { script: "echo hi" }, id: "t1" },
            ]), turn_index: 0, duration_milliseconds: 12, turn_complete: false } },
            { shell_output: { id: "s1", script: "echo hi", result: {
                output: [{ stdout: "hi\n" }, { stderr: "" }], exit_code: 0,
            }, turn_index: 0, duration_milliseconds: 3, turn_complete: true } },
            { assistant_reply: { content_json: JSON.stringify([
                { type: "text", text: "done" },
            ]), turn_index: 0, duration_milliseconds: 4, turn_complete: true } },
            { session_started: { protocol_version: 6, prompt: "p", backend: "fake", effort: "high", system_prompt: "SECRET-SYSTEM" } },
        ]))],
    ];
    const plain = await run(["read", RUN_ID], routes);
    assert.equal(plain.result.exit_code, 0);
    assert.ok(plain.result.stdout.includes("[turn 0] user: hello there"));
    assert.ok(plain.result.stdout.includes("assistant: let me check"));
    assert.ok(plain.result.stdout.includes("tool bash("));
    assert.ok(plain.result.stdout.includes("$ echo hi"));
    assert.ok(!plain.result.stdout.includes("SECRET-SYSTEM"));

    const withSystem = await run(["read", RUN_ID, "--system"], routes);
    assert.ok(withSystem.result.stdout.includes("SECRET-SYSTEM"));

    const asJson = await run(["read", RUN_ID, "--json"], routes);
    const projection = JSON.parse(asJson.result.stdout);
    assert.equal(projection.events.length, 4);
    assert.equal(projection.backend, "fake");
    assert.ok(!("system_prompt" in projection));
});

test("read --tail keeps only the last turns", async () => {
    const values = [];
    for (let turn = 0; turn < 3; turn++) {
        values.push({ user_message: { id: "u" + turn, text: "msg " + turn, turn_index: turn } });
    }
    const { result } = await run(["read", RUN_ID, "--tail", "1"], [
        ["GET", "/status", () => jsonResponse(200, { pending_state: { status: "finished" } })],
        ["GET", "/responses", () => jsonResponse(200, responsesPayload(values))],
    ]);
    assert.ok(result.stdout.includes("msg 2"));
    assert.ok(!result.stdout.includes("msg 1"));
});

test("read --turn prints just that turn's events", async () => {
    const reply = (text, turn, complete) => ({
        assistant_reply: {
            content_json: JSON.stringify([{ type: "text", text }]),
            turn_index: turn,
            turn_complete: complete,
        },
    });
    const routes = [
        ["GET", "/status", () => jsonResponse(200, { pending_state: { status: "finished" } })],
        ["GET", "/responses", () => jsonResponse(200, responsesPayload([
            reply("the final message", 4, true),
            { user_message: { id: "u4", text: "question four", turn_index: 4 } },
            reply("earlier message", 2, true),
            { user_message: { id: "u2", text: "question two", turn_index: 2 } },
        ]))],
    ];
    const { result } = await run(["read", RUN_ID, "--turn", "4"], routes);
    assert.equal(result.exit_code, 0);
    assert.ok(result.stdout.includes("[turn 4] user: question four"));
    assert.ok(result.stdout.includes("assistant: the final message"));
    assert.ok(!result.stdout.includes("earlier message"));
    assert.ok(!result.stdout.includes("question two"));

    const clash = await run(["read", RUN_ID, "--tail", "2", "--turn", "0"]);
    assert.equal(clash.result.exit_code, 2);
    assert.match(clash.result.stderr, /mutually exclusive/);
});

test("read --final prints just the finished reply, not the transcript", async () => {
    const routes = [
        ["GET", "/status", () => jsonResponse(200, {
            pending_state: { status: "blocked_by_join_set", join_set_id: "n:user" },
        })],
        ["GET", "/responses", () => jsonResponse(200, responsesPayload([
            { agent_status: { working: false, turn_index: 1 } },
            { user_message: { id: "u1", text: "how do I deploy?", turn_index: 1 } },
            { assistant_reply: {
                content_json: JSON.stringify([{ type: "text", text: "run just deploy" }]),
                turn_index: 1, turn_complete: true,
            } },
            { input_offered: { execution_id: OFFER_ID, turn_index: 2 } },
        ]))],
    ];
    const plain = await run(["read", RUN_ID, "--final"], routes);
    assert.equal(plain.result.exit_code, 0);
    assert.equal(plain.result.stdout, "run just deploy\n");
    assert.ok(!plain.result.stdout.includes("how do I deploy"), "no transcript, just the outcome");

    const asJson = await run(["read", RUN_ID, "--final", "--json"], routes);
    const outcome = JSON.parse(asJson.result.stdout);
    assert.equal(outcome.state, "final-response");
    assert.equal(outcome.kind, "reply");
    assert.equal(outcome.text, "run just deploy");
});

test("read --final reports the step-limit reason as an error", async () => {
    const { result } = await run(["read", RUN_ID, "--final"], [
        ["GET", "/status", () => jsonResponse(200, {
            pending_state: { status: "blocked_by_join_set", join_set_id: "n:user" },
        })],
        ["GET", "/responses", () => jsonResponse(200, responsesPayload([
            { agent_status: { working: false, turn_index: 6 } },
            { agent_error: { id: "step-limit-6", text: "exceeded MAX_STEPS=25", turn_index: 6 } },
            { input_offered: { execution_id: OFFER_ID, turn_index: 6 } },
        ]))],
    ]);
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, "exceeded MAX_STEPS=25\n");
});

test("read --final reports an execution failure with its kind", async () => {
    const { result } = await run(["read", RUN_ID, "--final", "--json"], [
        ["GET", "/status", () => jsonResponse(200, {
            pending_state: { status: "finished", result_kind: { err: { execution_failure: "timed_out" } } },
        })],
        ["GET", "/responses", () => jsonResponse(200, responsesPayload([]))],
    ]);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.state, "failed");
    assert.equal(outcome.kind, "error");
    assert.equal(outcome.text, "execution failure: timed_out");
});

test("read --final reports the pending ask-user question", async () => {
    const { result } = await run(["read", RUN_ID, "--final"], [
        ["GET", "/status", () => jsonResponse(200, {
            pending_state: { status: "blocked_by_join_set", join_set_id: "o:1-ask-user" },
        })],
        ["GET", "/responses", () => jsonResponse(200, responsesPayload([
            { human_input_requested: { question: "which region?", turn_index: 2 } },
        ]))],
    ]);
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, "which region?\n");
});

test("read --final says so when nothing final has happened yet", async () => {
    const { result } = await run(["read", RUN_ID, "--final"], [
        ["GET", "/status", () => jsonResponse(200, {
            pending_state: { status: "running" },
        })],
        ["GET", "/responses", () => jsonResponse(200, responsesPayload([]))],
    ]);
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout, /no final result yet.*working/);
});

test("read --final rejects combination with --tail/--turn/--system", async () => {
    const withTail = await run(["read", RUN_ID, "--final", "--tail", "1"]);
    assert.equal(withTail.result.exit_code, 2);
    assert.match(withTail.result.stderr, /--final cannot be combined/);

    const withTurn = await run(["read", RUN_ID, "--final", "--turn", "0"]);
    assert.equal(withTurn.result.exit_code, 2);

    const withSystem = await run(["read", RUN_ID, "--final", "--system"]);
    assert.equal(withSystem.result.exit_code, 2);
});

test("send looks up the open offer and stubs a prompt", async () => {
    const { result, calls } = await run(["send", RUN_ID, "please", "check"], [
        ["GET", `/executions/${RUN_ID}/responses`, () => jsonResponse(200, responsesPayload([
            { input_offered: { execution_id: OFFER_ID, turn_index: 2 } },
        ]))],
        ["PUT", "/stub", (url, init) => {
            const body = JSON.parse(init.body);
            assert.deepEqual(body.ok.prompt.text, "please check");
            assert.match(body.ok.prompt.id, /^chat-/);
            return jsonResponse(200, {});
        }],
    ]);
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout, new RegExp(`sent to ${RUN_ID}`));
    const put = calls.find((c) => c.method === "PUT");
    assert.ok(put.url.includes(`/executions/${encodeURIComponent(OFFER_ID)}/stub`));
    assert.equal(put.init.headers.authorization, "Bearer test-token");
});

test("send fails clearly when no offer is outstanding", async () => {
    const { result, calls } = await run(["send", RUN_ID, "hi"], [
        ["GET", `/executions/${RUN_ID}/responses`, () => jsonResponse(200, responsesPayload([]))],
    ]);
    assert.equal(result.exit_code, 1);
    assert.match(result.stderr, /no open input offer/);
    // One probe per attempt, no PUTs.
    assert.equal(calls.filter((c) => c.method === "GET").length, 4);
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
});

test("send retries once when the offer went stale mid-send", async () => {
    let probes = 0;
    const offers = [[OFFER_ID + ".old"], [OFFER_ID]];
    const { result, calls } = await run(["send", RUN_ID, "hi"], [
        ["GET", `/executions/${RUN_ID}/responses`, () => jsonResponse(200, responsesPayload(
            offers[Math.min(probes++, 1)].map((id) => ({ input_offered: { execution_id: id, turn_index: 0 } })),
        ))],
        ["PUT", "/stub", () => jsonResponse(409, "conflict")],
    ]);
    // Both attempts raced stale offers; the final error names the last one.
    assert.equal(result.exit_code, 1);
    assert.match(result.stderr, /could not deliver/);
    assert.equal(probes >= 2, true);
    assert.equal(calls.filter((c) => c.method === "PUT").length, 2);
});

test("interrupt arms the live script offer", async () => {
    const OFFER = RUN_ID + ".o:7_1";
    const { result, calls } = await run(["interrupt", RUN_ID], [
        ["GET", `/executions/${RUN_ID}/responses`, () => jsonResponse(200, responsesPayload([
            // Oldest first; the started event outranks any older completion.
            { shell_output: { id: "shell-0", script: "ls", result: { output: [], exit_code: 0 } } },
            { agent_status: { working: true, turn_index: 1 } },
            { shell_started: { id: "shell-live", offer_id: OFFER, turn_index: 1 } },
        ]))],
        ["PUT", "/stub", (url, init) => {
            assert.equal(JSON.parse(init.body).ok, "peer-interrupt");
            return jsonResponse(200, {});
        }],
    ]);
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout, new RegExp(`interrupt sent to ${RUN_ID} \\(offer ${OFFER}\\)`));
    const put = calls.find((c) => c.method === "PUT");
    assert.ok(put.url.includes(`/executions/${encodeURIComponent(OFFER)}/stub`));
});

test("interrupt refuses when the newest script already finished or none ran", async () => {
    // Newest event is a completion: nothing is running.
    let { result, calls } = await run(["interrupt", RUN_ID], [
        ["GET", `/executions/${RUN_ID}/responses`, () => jsonResponse(200, responsesPayload([
            { shell_started: { id: "shell-1", offer_id: RUN_ID + ".o:7_1", turn_index: 0 } },
            { tool_result: { id: "bash_x", output: { ok: { output: [], exit_code: 0 } }, turn_index: 0, duration_milliseconds: 5 } },
        ]))],
    ]);
    assert.equal(result.exit_code, 1);
    assert.match(result.stderr, /no running script found/);
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0);

    // A stale offer (the script finished between lookup and write) reads clearly.
    ({ result } = await run(["interrupt", RUN_ID], [
        ["GET", `/executions/${RUN_ID}/responses`, () => jsonResponse(200, responsesPayload([
            { shell_started: { id: "shell-2", offer_id: RUN_ID + ".o:8_1", turn_index: 0 } },
        ]))],
        ["PUT", "/stub", () => jsonResponse(409, "conflict")],
    ]));
    assert.equal(result.exit_code, 1);
    assert.match(result.stderr, /already finished/);

    // Usage: exactly one session id.
    ({ result } = await run(["interrupt"], []));
    assert.equal(result.exit_code, 2);
});

test("create POSTs params and prints the generated id", async () => {
    const { result, calls } = await run(["create", "--model", "fake", "--effort", "low", "go", "north"], [
        ["POST", "/v1/executions", (url, init) => {
            assert.deepEqual(JSON.parse(init.body), {
                ffqn: "obelisk-agent:workflow/workflow.run-cancellable",
                params: ["go north", "fake", null, "low", null],
            });
            // The server wraps the id when the request accepts JSON.
            return jsonResponse(201, { ok: "E_new000000000000000000000000002" });
        }],
    ]);
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, "E_new000000000000000000000000002\n");
    assert.equal(calls[0].init.headers.authorization, "Bearer test-token");

    const plain = await run(["create"], [
        ["POST", "/v1/executions", (url, init) => {
            assert.deepEqual(JSON.parse(init.body).params, ["", null, null, null, null]);
            return jsonResponse(201, "E_plain00000000000000000000000003");
        }],
    ]);
    assert.equal(plain.result.exit_code, 0);
    assert.equal(plain.result.stdout, "E_plain00000000000000000000000003\n");
});

test("create passes a valid --name and rejects bad slugs", async () => {
    const named = await run(["create", "--name", "research", "$", "ls"], [
        ["POST", "/v1/executions", (url, init) => {
            const body = JSON.parse(init.body);
            assert.deepEqual(body.params, ["$ ls", null, null, null, "research"]);
            return jsonResponse(201, { ok: "E_named00000000000000000000000004" });
        }],
    ]);
    assert.equal(named.result.exit_code, 0);

    for (const bad of ["Bad_Name", "", "dou--ble"]) {
        const rejected = await run(bad === ""
            ? ["create", "--name"]
            : ["create", "--name", bad]);
        assert.equal(rejected.result.exit_code, 2, `expected exit 2 for name ${JSON.stringify(bad)}`);
        assert.match(rejected.result.stderr, /--name/);
    }
});

test("create rejects unknown effort levels", async () => {
    const { result, calls } = await run(["create", "--effort", "maximum"]);
    assert.equal(result.exit_code, 2);
    assert.match(result.stderr, /--effort must be one of/);
    assert.equal(calls.length, 0);
});

test("usage errors exit 2 and point at help", async () => {
    for (const args of [["bogus"], ["send", RUN_ID], ["read"], ["list", "extra"]]) {
        const { result } = await run(args);
        assert.equal(result.exit_code, 2, `expected exit 2 for: ${args.join(" ")}`);
        assert.match(result.stderr, /Try 'chat --help'/);
    }
});

test("--help covers every subcommand", async () => {
    const top = await run(["--help"]);
    for (const sub of ["models", "list", "read", "state", "send", "create", "current", "rename"]) {
        assert.ok(top.result.stdout.includes(`  ${sub}`), `top-level help mentions ${sub}`);
        const per = await run([sub, "--help"]);
        assert.equal(per.result.exit_code, 0);
        assert.ok(per.result.stdout.includes("Usage: chat " + sub));
    }
});
