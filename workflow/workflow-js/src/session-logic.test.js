import { test } from "node:test";
import assert from "node:assert/strict";
import {
    appendShellExchange,
    containsBackgroundStatement,
    hasUserVisibleText,
    openingShellScript,
    shellResultOf,
    stepWarningThreshold,
    toolError,
    toolOk,
    toolResultMessageValue,
    MAX_TOOL_RESULT_BYTES,
} from "./session-logic.js";

test("openingShellScript recognizes a $-prefixed prompt", () => {
    assert.equal(openingShellScript("$ ls -la"), "ls -la");
    assert.equal(openingShellScript("$pwd"), "pwd");
    assert.equal(openingShellScript("$"), null);
    assert.equal(openingShellScript("$ "), null);
    assert.equal(openingShellScript("hello"), null);
    assert.equal(openingShellScript("costs $5"), null);
});

test("hasUserVisibleText ignores blank, thinking, and tool-only blocks", () => {
    assert.equal(hasUserVisibleText([]), false);
    assert.equal(hasUserVisibleText([{ type: "thinking", thinking: "hmm" }, { type: "tool_use" }]), false);
    assert.equal(hasUserVisibleText([{ type: "text", text: "  \n" }]), false);
    assert.equal(hasUserVisibleText([{ type: "text", text: "done" }]), true);
});

test("containsBackgroundStatement rejects trailing &", () => {
    assert.equal(containsBackgroundStatement("sleep 1 &"), true);
    assert.equal(containsBackgroundStatement("echo hi"), false);
    assert.equal(containsBackgroundStatement("if true; then sleep 1 & fi"), true);
});

test("containsBackgroundStatement is false on a parse error, not a crash", () => {
    assert.equal(containsBackgroundStatement("if true; then"), false);
});

test("stepWarningThreshold matches session.rs's 75%-rounded-down rule", () => {
    assert.equal(stepWarningThreshold(20), 15);
    assert.equal(stepWarningThreshold(4), 3);
    assert.equal(stepWarningThreshold(3), 0);
});

test("toolOk truncates oversized results", () => {
    const big = "x".repeat(MAX_TOOL_RESULT_BYTES);
    const result = toolOk("id1", { output: [{ stdout: big }], exit_code: 0, interrupted: null });
    assert.equal(result.ok, false);
    assert.match(result.message, /result too large/);
});

test("toolResultMessageValue encodes ok and error shapes", () => {
    const ok = toolResultMessageValue(toolOk("t1", { exit_code: 0 }));
    assert.equal(ok.is_error, false);
    assert.equal(ok.tool_use_id, "t1");
    const err = toolResultMessageValue(toolError("t2", "boom"));
    assert.equal(err.is_error, true);
    assert.match(err.content, /boom/);
});

test("shellResultOf maps interpreter output chunks to the WIT output-chunk shape", () => {
    const mapped = shellResultOf({
        output: [{ fd: "stdout", text: "hi\n" }, { fd: "stderr", text: "warn\n" }],
        exitCode: 0,
        interrupted: null,
    });
    assert.deepEqual(mapped.output, [{ stdout: "hi\n" }, { stderr: "warn\n" }]);
    assert.equal(mapped.exit_code, 0);
    assert.equal(mapped.interrupted, null);
});

test("appendShellExchange records a tool_use/tool_result pair", () => {
    const messages = [];
    appendShellExchange(messages, { id: "s1", script: "echo hi", result: { exit_code: 0, output: [], interrupted: null } }, "");
    assert.equal(messages.length, 2);
    assert.equal(messages[0].content[0].type, "tool_use");
    assert.equal(messages[0].content[0].input.script, "echo hi");
    assert.equal(messages[1].content[0].type, "tool_result");
});
