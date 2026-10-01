// Tests for the WIT-touching half of chat.js. Its two WIT imports resolve to
// fake modules that forward to `runtime`, which each test swaps in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const runtime = { obelisk: undefined, submit: undefined };
globalThis.__chatTestRuntime = runtime;
const fakeModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const FAKE_MODULES = {
    "obelisk:workflow@1.0.0": fakeModule(`
        export const createJoinSet = (...args) => globalThis.__chatTestRuntime.obelisk.createJoinSet(...args);
        export const sleep = (...args) => globalThis.__chatTestRuntime.obelisk.sleep(...args);`),
    "obelisk-agent:workflow-obelisk-ext/workflow": fakeModule(`
        export const runCancellableSubmit = (...args) => globalThis.__chatTestRuntime.submit(...args);`),
};
registerHooks({
    resolve(specifier, context, nextResolve) {
        const url = FAKE_MODULES[specifier];
        return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
    },
});
const { ChatSelf, attachFinal, commandHandler, createChild, rename, watchCommand, watchLoop } = await import("./chat.js");

function mustNotSubmit() {
    throw "runCancellableSubmit must not be called";
}

// `submit(joinSet, prompt, model, descriptorFfqn, effort, name)` mirrors runCancellableSubmit.
function withFakeObelisk(fake, fn, submit = mustNotSubmit) {
    runtime.obelisk = fake;
    runtime.submit = submit;
    try {
        return fn(fake);
    } finally {
        runtime.obelisk = undefined;
        runtime.submit = undefined;
    }
}

function fakeJoinSet(name) {
    return { name };
}

function noSleepObelisk() {
    let joinSetCount = 0;
    return {
        createJoinSet({ name }) {
            joinSetCount += 1;
            return fakeJoinSet(name);
        },
        sleep() {
            // Instant no-op: tests use tiny timeouts/intervals so watchLoop's
            // own wall-clock deadline check still terminates promptly.
        },
        get joinSetCount() {
            return joinSetCount;
        },
    };
}

function fakeDelegate(responses) {
    const calls = [];
    return {
        calls,
        handler(interp, args, stdin) {
            calls.push(args);
            const key = args.slice(1).join(" ");
            const response = responses[key];
            if (!response) throw `no fixture for delegate call: ${JSON.stringify(args)}`;
            return response;
        },
    };
}

function fakeNotifications() {
    const renamed = [];
    return {
        renamed,
        sessionRenamed(name) {
            renamed.push(name);
        },
    };
}

function own(executionId = "E_top", extra = {}) {
    return new ChatSelf(executionId, "claude", "low", extra.name ?? null);
}

// ----- commandHandler dispatch --------------------------------------------

test("commandHandler dispatches 'current' to currentOutput and never reaches delegate", () => {
    const delegate = fakeDelegate({});
    const handler = commandHandler(delegate.handler, own("E_1"), fakeNotifications(), () => "E_child");
    const out = handler(null, ["chat", "current"], "");
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /"execution_id":"E_1"/);
    assert.equal(delegate.calls.length, 0);
});

test("commandHandler dispatches 'rename' and updates own.name", () => {
    const delegate = fakeDelegate({});
    const notifications = fakeNotifications();
    const session = own("E_1");
    const handler = commandHandler(delegate.handler, session, notifications, () => "E_child");
    const out = handler(null, ["chat", "rename", "deploy-triage"], "");
    assert.equal(out.exitCode, 0);
    assert.equal(session.name, "deploy-triage");
    assert.deepEqual(notifications.renamed, ["deploy-triage"]);
});

test("commandHandler dispatches 'create' to createChild (own submit, not delegate)", () => {
    const delegate = fakeDelegate({});
    const submitted = [];
    const submit = (joinSet, prompt, model, descriptorFfqn, effort, name) => {
        submitted.push({ joinSet, prompt, model, descriptorFfqn, effort, name });
        return "E_child_1";
    };
    withFakeObelisk(noSleepObelisk(), () => {
        const handler = commandHandler(delegate.handler, own("E_1"), fakeNotifications());
        const out = handler(null, ["chat", "create", "look", "into", "it"], "");
        assert.equal(out.exitCode, 0);
        assert.equal(out.stdout, "E_child_1\n");
        assert.equal(submitted.length, 1);
        assert.equal(submitted[0].prompt, "look into it");
        assert.equal(submitted[0].descriptorFfqn, null);
    }, submit);
});

test("commandHandler passes 'create --top-level' straight through to delegate", () => {
    const delegate = fakeDelegate({ "create --top-level go": { stdout: "top\n", stderr: "", exitCode: 0 } });
    const handler = commandHandler(delegate.handler, own("E_1"), fakeNotifications());
    const out = handler(null, ["chat", "create", "--top-level", "go"], "");
    assert.equal(out.stdout, "top\n");
    assert.equal(delegate.calls.length, 1);
});

test("commandHandler passes a help-flagged subcommand straight through to delegate", () => {
    const delegate = fakeDelegate({
        "create --help": { stdout: "help text\n", stderr: "", exitCode: 0 },
        "rename --help": { stdout: "help text\n", stderr: "", exitCode: 0 },
        "current --help": { stdout: "help text\n", stderr: "", exitCode: 0 },
        "watch --help": { stdout: "help text\n", stderr: "", exitCode: 0 },
    });
    const handler = commandHandler(delegate.handler, own("E_1"), fakeNotifications());
    for (const sub of ["create", "rename", "current", "watch"]) {
        const out = handler(null, ["chat", sub, "--help"], "");
        assert.equal(out.stdout, "help text\n", `${sub} --help should pass through`);
    }
    assert.equal(delegate.calls.length, 4);
});

test("commandHandler dispatches 'watch' through watchLoop via delegate", () => {
    const delegate = fakeDelegate({
        "state E_x": { stdout: JSON.stringify({ id: "E_x", state: "finished-ok" }), stderr: "", exitCode: 0 },
        "read E_x --final": { stdout: "all done\n", stderr: "", exitCode: 0 },
    });
    withFakeObelisk(noSleepObelisk(), () => {
        const handler = commandHandler(delegate.handler, own("E_1"), fakeNotifications());
        const out = handler(null, ["chat", "watch", "E_x"], "");
        assert.equal(out.exitCode, 0);
        const payload = JSON.parse(out.stdout);
        assert.equal(payload.state, "finished-ok");
        assert.equal(payload.final, "all done");
    });
});

test("commandHandler passes every other subcommand straight through to delegate unchanged", () => {
    const delegate = fakeDelegate({ "list": { stdout: "[]\n", stderr: "", exitCode: 0 } });
    const handler = commandHandler(delegate.handler, own("E_1"), fakeNotifications());
    const out = handler(null, ["chat", "list"], "");
    assert.equal(out.stdout, "[]\n");
    assert.deepEqual(delegate.calls[0], ["chat", "list"]);
});

// ----- rename ---------------------------------------------------------

test("rename validates the slug, updates own.name, and notifies", () => {
    const notifications = fakeNotifications();
    const session = own("E_1");
    const out = rename(["rename", "deploy-triage"], session, notifications);
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "renamed to deploy-triage\n");
    assert.equal(session.name, "deploy-triage");
    assert.deepEqual(notifications.renamed, ["deploy-triage"]);
});

test("rename rejects an invalid slug without notifying", () => {
    const notifications = fakeNotifications();
    const session = own("E_1", { name: "old" });
    const out = rename(["rename", "Bad_Name"], session, notifications);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /chat: slug allows lowercase/);
    assert.equal(session.name, "old");
    assert.deepEqual(notifications.renamed, []);
});

test("rename requires exactly one argument", () => {
    const notifications = fakeNotifications();
    const session = own("E_1");
    assert.equal(rename(["rename"], session, notifications).exitCode, 2);
    assert.equal(rename(["rename", "a", "b"], session, notifications).exitCode, 2);
    assert.deepEqual(notifications.renamed, []);
});

test("rename surfaces a notifications failure without updating own.name", () => {
    const session = own("E_1", { name: "old" });
    const notifications = { sessionRenamed: () => { throw "name already taken"; } };
    const out = rename(["rename", "taken"], session, notifications);
    assert.equal(out.exitCode, 1);
    assert.equal(out.stderr, "chat: name already taken\n");
    assert.equal(session.name, "old");
});

// ----- createChild ------------------------------------------------------

test("createChild reuses the default 'peers' join set across unnamed children", () => {
    withFakeObelisk(noSleepObelisk(), (fake) => {
        const session = own("E_1");
        const delegate = fakeDelegate({});
        createChild(session, ["hello"], delegate.handler, null);
        createChild(session, ["again"], delegate.handler, null);
        assert.equal(fake.joinSetCount, 1);
        assert.deepEqual([...session.peers.keys()], ["peers"]);
    }, (joinSet) => `E_child_${joinSet.name}`);
});

test("createChild gives a --name'd child its own join set keyed by slug", () => {
    withFakeObelisk(noSleepObelisk(), (fake) => {
        const session = own("E_1");
        const delegate = fakeDelegate({});
        const out1 = createChild(session, ["--name=research", "look"], delegate.handler, null);
        const out2 = createChild(session, ["other"], delegate.handler, null);
        assert.equal(out1.stdout, "E_research\n");
        assert.equal(out2.stdout, "E_peers\n");
        assert.equal(fake.joinSetCount, 2);
        assert.deepEqual([...session.peers.keys()].sort(), ["peers", "research"]);
    }, (joinSet) => `E_${joinSet.name}`);
});

test("createChild with --watch triggers watchLoop instead of returning the id immediately", () => {
    withFakeObelisk(noSleepObelisk(), () => {
        const session = own("E_1");
        const delegate = fakeDelegate({
            "state E_child": { stdout: JSON.stringify({ id: "E_child", state: "finished-ok" }), stderr: "", exitCode: 0 },
            "read E_child --final": { stdout: "done\n", stderr: "", exitCode: 0 },
        });
        const out = createChild(session, ["--watch", "go"], delegate.handler, null);
        assert.equal(out.exitCode, 0);
        const payload = JSON.parse(out.stdout);
        assert.equal(payload.state, "finished-ok");
        assert.equal(payload.final, "done");
    }, () => "E_child");
});

test("createChild surfaces parseCreateArgs rejections as usage errors", () => {
    const session = own("E_1");
    const out = createChild(session, ["--effort", "maximum"], fakeDelegate({}).handler, null);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /--effort must be one of/);
});

test("createChild surfaces a submit failure", () => {
    withFakeObelisk(noSleepObelisk(), () => {
        const out = createChild(own("E_1"), ["go"], fakeDelegate({}).handler, null);
        assert.equal(out.exitCode, 1);
        assert.equal(out.stderr, "chat: child submit: no such function\n");
    }, () => { throw "no such function"; });
});

// ----- watchLoop / attachFinal ------------------------------------------

test("attachFinal embeds the read --final text on success", () => {
    const delegate = fakeDelegate({ "read E_x --final": { stdout: "run just deploy\n", stderr: "", exitCode: 0 } });
    const payload = { id: "E_x", state: "final-response" };
    attachFinal(delegate.handler, null, "E_x", payload);
    assert.equal(payload.final, "run just deploy");
});

test("attachFinal leaves the field absent on a failed read", () => {
    const delegate = fakeDelegate({ "read E_x --final": { stdout: "", stderr: "chat: unknown session\n", exitCode: 1 } });
    const payload = { id: "E_x", state: "unknown" };
    attachFinal(delegate.handler, null, "E_x", payload);
    assert.equal(payload.final, undefined);
});

test("watchLoop wakes immediately on a wake state and embeds final", () => {
    withFakeObelisk(noSleepObelisk(), () => {
        const delegate = fakeDelegate({
            "state E_x": { stdout: JSON.stringify({ id: "E_x", state: "awaiting-answer" }), stderr: "", exitCode: 0 },
            "read E_x --final": { stdout: "what next?\n", stderr: "", exitCode: 0 },
        });
        const out = watchLoop(delegate.handler, null, { id: "E_x", timeoutMs: 60_000, intervalMs: 10 });
        assert.equal(out.exitCode, 0);
        const payload = JSON.parse(out.stdout);
        assert.equal(payload.state, "awaiting-answer");
        assert.equal(payload.timed_out, false);
        assert.equal(payload.final, "what next?");
    });
});

test("watchLoop does not wake on a non-wake state and keeps polling until timeout", () => {
    withFakeObelisk(noSleepObelisk(), () => {
        const delegate = fakeDelegate({
            "state E_x": { stdout: JSON.stringify({ id: "E_x", state: "thinking" }), stderr: "", exitCode: 0 },
            "read E_x --final": { stdout: "", stderr: "not final yet\n", exitCode: 1 },
        });
        // A tiny timeout keeps this test fast: watchLoop's own deadline check
        // uses the real wall clock (Date.now()), but with obelisk.sleep
        // faked as an instant no-op, a 5ms timeout elapses within a handful
        // of fast synchronous polls.
        const out = watchLoop(delegate.handler, null, { id: "E_x", timeoutMs: 5, intervalMs: 1 });
        assert.equal(out.exitCode, 1);
        const payload = JSON.parse(out.stdout);
        assert.equal(payload.state, "thinking");
        assert.equal(payload.timed_out, true);
        assert.equal(payload.final, undefined);
        assert.match(out.stderr, /chat watch: gave up after \d+ ms waiting for E_x \(state: thinking\)/);
    });
});

test("watchLoop notes a failed state poll in stderr and keeps going", () => {
    withFakeObelisk(noSleepObelisk(), () => {
        const delegate = fakeDelegate({
            "state E_x": { stdout: "", stderr: "chat: unknown session\n", exitCode: 1 },
            "read E_x --final": { stdout: "", stderr: "chat: unknown session\n", exitCode: 1 },
        });
        const out = watchLoop(delegate.handler, null, { id: "E_x", timeoutMs: 5, intervalMs: 1 });
        assert.equal(out.exitCode, 1);
        assert.match(out.stderr, /chat watch: state read failed: chat: unknown session/);
        assert.match(out.stderr, /chat watch: gave up after \d+ ms waiting for E_x/);
    });
});

test("watchCommand parses args and delegates to watchLoop", () => {
    withFakeObelisk(noSleepObelisk(), () => {
        const delegate = fakeDelegate({
            "state E_x": { stdout: JSON.stringify({ id: "E_x", state: "cancelled" }), stderr: "", exitCode: 0 },
            "read E_x --final": { stdout: "cancelled by user\n", stderr: "", exitCode: 0 },
        });
        const out = watchCommand(delegate.handler, null, ["--interval=1", "E_x"]);
        assert.equal(out.exitCode, 0);
        assert.match(out.stdout, /"state":"cancelled"/);
    });
});

test("watchCommand surfaces parseWatchArgs rejections as usage errors", () => {
    const out = watchCommand(fakeDelegate({}).handler, null, []);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /exactly one session id is required/);
});
