import { test } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_PEERS_JOIN_SET,
    EFFORTS,
    WATCH_DEFAULT_INTERVAL_MS,
    WATCH_DEFAULT_TIMEOUT_MS,
    WATCH_WAKE_STATES,
    currentOutput,
    currentPayload,
    failure,
    hasHelpFlag,
    parentOf,
    parseCreateArgs,
    parseWatchArgs,
    stampWatchFields,
    usage,
} from "./chat-logic.js";

// PORT: chat.rs's `parent_of_derives_from_derived_execution_ids`.
test("parentOf derives from derived execution ids", () => {
    assert.equal(parentOf("E_01ABC.n:research_2"), "E_01ABC");
    // A grandchild's parent is the intermediate session, not the root.
    assert.equal(parentOf("E_01ABC.n:a_1.n:b_1"), "E_01ABC.n:a_1");
    assert.equal(parentOf("E_01ABC"), null);
});

test("currentPayload/currentOutput shape identity as JSON", () => {
    const own = { executionId: "E_01ABC.n:research_1", backend: "claude", effort: "low", name: "research" };
    const payload = currentPayload(own);
    assert.deepEqual(payload, {
        execution_id: "E_01ABC.n:research_1",
        backend: "claude",
        effort: "low",
        name: "research",
        parent_id: "E_01ABC",
    });
    const output = currentOutput(own);
    assert.equal(output.stdout, `${JSON.stringify(payload)}\n`);
    assert.equal(output.stderr, "");
    assert.equal(output.exitCode, 0);
});

test("currentPayload defaults name/parent_id to explicit JSON null", () => {
    const own = { executionId: "E_01XYZ", backend: "", effort: "" };
    const payload = currentPayload(own);
    assert.equal(payload.name, null);
    assert.equal(payload.parent_id, null);
    assert.ok(JSON.stringify(payload).includes('"name":null'));
    assert.ok(JSON.stringify(payload).includes('"parent_id":null'));
});

test("hasHelpFlag recognizes --help and -h anywhere in the args", () => {
    assert.equal(hasHelpFlag([]), false);
    assert.equal(hasHelpFlag(["foo", "bar"]), false);
    assert.equal(hasHelpFlag(["foo", "--help"]), true);
    assert.equal(hasHelpFlag(["-h"]), true);
});

test("usage and failure prefix and shape CommandOutput consistently", () => {
    const u = usage("rename expects a slug name");
    assert.equal(u.stdout, "");
    assert.equal(u.stderr, "chat: rename expects a slug name\nTry 'chat --help' for more information.\n");
    assert.equal(u.exitCode, 2);

    const f = failure("boom");
    assert.equal(f.stdout, "");
    assert.equal(f.stderr, "chat: boom\n");
    assert.equal(f.exitCode, 1);
});

// PORT: chat.rs's `parse_create_args_reads_flags_and_prompt_words`.
test("parseCreateArgs reads flags and prompt words", () => {
    const parsed = parseCreateArgs(["--model", "fake", "check", "--effort=low", "the deploy"]);
    assert.equal(parsed.prompt, "check the deploy");
    assert.equal(parsed.model, "fake");
    assert.equal(parsed.effort, "low");
    assert.equal(parsed.name, null);

    const named = parseCreateArgs(["--name=research", "$", "ls"]);
    assert.equal(named.name, "research");
    assert.equal(named.prompt, "$ ls");

    const bare = parseCreateArgs([]);
    assert.equal(bare.prompt, "");
    assert.equal(bare.model, null);
    assert.equal(bare.effort, null);
    assert.equal(bare.name, null);
    assert.equal(bare.watch, false);
});

test("parseCreateArgs reads --watch", () => {
    assert.equal(parseCreateArgs(["--watch"]).watch, true);
    assert.equal(parseCreateArgs(["--watch=anything"]).watch, true);
});

// PORT: chat.rs's `parse_create_args_rejects_bad_input`.
test("parseCreateArgs rejects bad input", () => {
    assert.throws(() => parseCreateArgs(["--effort", "maximum"]));
    assert.throws(() => parseCreateArgs(["--wat"]));
    assert.throws(() => parseCreateArgs(["--model"]));
    assert.throws(() => parseCreateArgs(["--model", "a", "--model=b"]));
    assert.throws(() => parseCreateArgs(["--name", "Bad_Name"]));
    assert.throws(() => parseCreateArgs(["--name", "one", "--name=two"]));
});

test("parseCreateArgs rejects empty option values", () => {
    assert.throws(() => parseCreateArgs(["--model="]));
    assert.throws(() => parseCreateArgs(["--model", ""]));
});

test("EFFORTS is the fixed six-value list", () => {
    assert.deepEqual(EFFORTS, ["off", "minimal", "low", "medium", "high", "xhigh"]);
});

test("DEFAULT_PEERS_JOIN_SET is 'peers'", () => {
    assert.equal(DEFAULT_PEERS_JOIN_SET, "peers");
});

// PORT: chat.rs's `parse_watch_args_reads_flags_and_id`.
test("parseWatchArgs reads flags and id", () => {
    const parsed = parseWatchArgs(["--timeout=30s", "E_child", "--interval", "500ms"]);
    assert.equal(parsed.id, "E_child");
    assert.equal(parsed.timeoutMs, 30_000);
    assert.equal(parsed.intervalMs, 500);

    const bare = parseWatchArgs(["E_x"]);
    assert.equal(bare.timeoutMs, WATCH_DEFAULT_TIMEOUT_MS);
    assert.equal(bare.intervalMs, WATCH_DEFAULT_INTERVAL_MS);

    assert.throws(() => parseWatchArgs([]));
    assert.throws(() => parseWatchArgs(["a", "b"]));
    assert.throws(() => parseWatchArgs(["--wat", "E_x"]));
    assert.throws(() => parseWatchArgs(["--timeout", "E_x"]), "missing option value");
});

// PORT: chat.rs's `watch_wake_states_cover_progress_stops_and_terminals`.
test("WATCH_WAKE_STATES covers progress stops and terminals", () => {
    for (const state of ["final-response", "step-limit", "awaiting-answer", "shell-only", "finished-ok", "cancelled", "failed"]) {
        assert.ok(WATCH_WAKE_STATES.includes(state), `${state} should wake`);
    }
    for (const state of ["thinking", "working", "awaiting-user", "paused", "unknown"]) {
        assert.ok(!WATCH_WAKE_STATES.includes(state), `${state} must not wake`);
    }
});

// PORT: chat.rs's `stamp_watch_fields_adds_timeout_and_waited`.
test("stampWatchFields adds timeout and waited", () => {
    let payload = JSON.parse('{"id":"E_x","state":"thinking"}');
    payload = stampWatchFields(payload, false, 1234);
    assert.equal(payload.timed_out, false);
    assert.equal(payload.waited_ms, 1234);
    assert.equal(payload.state, "thinking");

    let empty = null;
    empty = stampWatchFields(empty, true, 5);
    assert.equal(empty.timed_out, true);
    assert.equal(empty.waited_ms, 5);
});

test("stampWatchFields coerces a non-object payload (array, primitive) to {}", () => {
    assert.deepEqual(stampWatchFields([1, 2, 3], false, 0), { timed_out: false, waited_ms: 0 });
    assert.deepEqual(stampWatchFields("oops", true, 9), { timed_out: true, waited_ms: 9 });
    assert.deepEqual(stampWatchFields(undefined, false, 1), { timed_out: false, waited_ms: 1 });
});
