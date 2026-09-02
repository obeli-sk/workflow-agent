import { test } from "node:test";
import assert from "node:assert/strict";
import { joinSetNameFor, ScriptWatchGuard } from "./script-watch-logic.js";

test("joinSetNameFor passes through an already-safe scriptId unchanged", () => {
    assert.equal(joinSetNameFor("shell-e2e-1"), "script-watch-shell-e2e-1");
});

test("joinSetNameFor replaces underscores from an LLM tool_use id", () => {
    assert.equal(
        joinSetNameFor("toolu_01XvLBgPHGY5Hk8ro1srgL9C"),
        "script-watch-toolu-01XvLBgPHGY5Hk8ro1srgL9C",
    );
});

// A fake `obelisk.createJoinSet()`-shaped object: `.submitDelay()` models a
// delay that resolves on its own, in submission order, via `.complete()`'s
// queue (matching a real delay eventually firing) -- tests that want
// something else to win the race call `.complete(id)` *before* the guard
// method under test submits its own delay, so it is already queued ahead of
// it. `.joinNextTry()`/`.joinNext()` set `.lastId` before throwing, matching
// the real runtime (the id of whatever just completed is still readable
// after a throw).
class FakeJoinSet {
    constructor() {
        this.queue = [];
        this.lastId = undefined;
        this.delaySeq = 0;
        this.closed = 0;
    }
    complete(id, { err } = {}) {
        this.queue.push({ id, err });
    }
    submitDelay() {
        this.delaySeq += 1;
        const id = `delay-${this.delaySeq}`;
        this.queue.push({ id });
        return id;
    }
    _take(blocking) {
        if (this.queue.length === 0) {
            if (blocking) throw new Error("nothing pending");
            return undefined;
        }
        const { id, err } = this.queue.shift();
        this.lastId = id;
        if (err) throw new Error(err);
        return null;
    }
    joinNextTry() { return this._take(false); }
    joinNext() { return this._take(true); }
    close() { this.closed += 1; }
}

test("constructor exposes offerExecutionId and defaults watchdogDelayId to null", () => {
    const guard = new ScriptWatchGuard(new FakeJoinSet(), "offer-42");
    assert.equal(guard.offerExecutionId, "offer-42");
    assert.equal(guard.watchdogDelayId, null);
});

test("classify recognizes the offer id as operator and the watchdog id as timeout", () => {
    const guard = new ScriptWatchGuard(new FakeJoinSet(), "offer-1", "delay-1");
    assert.equal(guard.classify("offer-1"), "operator");
    assert.equal(guard.classify("delay-1"), "timeout");
    assert.equal(guard.classify("something-else"), null);
});

test("classify never matches when no watchdog was armed", () => {
    const guard = new ScriptWatchGuard(new FakeJoinSet(), "offer-1", null);
    assert.equal(guard.classify(null), null);
    assert.equal(guard.classify(undefined), null);
});

test("poll: null when nothing has completed yet", () => {
    const guard = new ScriptWatchGuard(new FakeJoinSet(), "offer-1", "delay-1");
    assert.equal(guard.poll(), null);
});

test("poll: operator when the offer completes", () => {
    const joinSet = new FakeJoinSet();
    joinSet.complete("offer-1");
    const guard = new ScriptWatchGuard(joinSet, "offer-1", "delay-1");
    assert.equal(guard.poll(), "operator");
});

test("poll: timeout when the watchdog delay completes", () => {
    const joinSet = new FakeJoinSet();
    const watchdogDelayId = joinSet.submitDelay({ milliseconds: 5000 }); // auto-queues its own completion
    const guard = new ScriptWatchGuard(joinSet, "offer-1", watchdogDelayId);
    assert.equal(guard.poll(), "timeout");
});

test("poll: an offer completing with its own error is still an operator signal", () => {
    const joinSet = new FakeJoinSet();
    joinSet.complete("offer-1", { err: "boom" });
    const guard = new ScriptWatchGuard(joinSet, "offer-1", "delay-1");
    assert.equal(guard.poll(), "operator");
});

test("poll: drains an unrecognized completion and keeps looking", () => {
    const joinSet = new FakeJoinSet();
    joinSet.complete("some-other-child");
    joinSet.complete("offer-1");
    const guard = new ScriptWatchGuard(joinSet, "offer-1", "delay-1");
    assert.equal(guard.poll(), "operator");
});

test("poll: an exhausted join set (nothing pending) is not a signal", () => {
    const guard = new ScriptWatchGuard(new FakeJoinSet(), "offer-1", "delay-1");
    assert.equal(guard.poll(), null);
});

test("sleep: ms<=0 returns immediately without submitting a delay", () => {
    const joinSet = new FakeJoinSet();
    const guard = new ScriptWatchGuard(joinSet, "offer-1", null);
    assert.deepEqual(guard.sleep(0), { interrupted: null });
    assert.equal(joinSet.delaySeq, 0);
});

test("sleep: not interrupted when its own delay wins the race", () => {
    const guard = new ScriptWatchGuard(new FakeJoinSet(), "offer-1", null);
    assert.deepEqual(guard.sleep(1000), { interrupted: null });
});

test("sleep: wakes early with operator when the offer completes first", () => {
    const joinSet = new FakeJoinSet();
    joinSet.complete("offer-1"); // queued before sleep()'s own delay
    const guard = new ScriptWatchGuard(joinSet, "offer-1", null);
    assert.deepEqual(guard.sleep(5000), { interrupted: "operator" });
});

test("sleep: wakes early with timeout when the watchdog completes first", () => {
    const joinSet = new FakeJoinSet();
    const watchdogDelayId = joinSet.submitDelay({ milliseconds: 100 });
    const guard = new ScriptWatchGuard(joinSet, "offer-1", watchdogDelayId);
    assert.deepEqual(guard.sleep(5000), { interrupted: "timeout" });
});

test("sleep: an unrecognized failure is treated as an ordinary elapsed sleep, not fabricated", () => {
    const joinSet = new FakeJoinSet();
    joinSet.complete("some-other-child", { err: "boom" });
    const guard = new ScriptWatchGuard(joinSet, "offer-1", null);
    assert.deepEqual(guard.sleep(1000), { interrupted: null });
});

test("close closes the underlying join set", () => {
    const joinSet = new FakeJoinSet();
    const guard = new ScriptWatchGuard(joinSet, "offer-1", null);
    guard.close();
    assert.equal(joinSet.closed, 1);
});

test("watcher exposes poll/sleep delegating to the guard, matching watch.js's duck contract", () => {
    const joinSet = new FakeJoinSet();
    joinSet.complete("offer-1");
    const guard = new ScriptWatchGuard(joinSet, "offer-1", null);
    const watcher = guard.watcher();
    assert.equal(typeof watcher.poll, "function");
    assert.equal(typeof watcher.sleep, "function");
    assert.equal(watcher.poll(), "operator");
});
