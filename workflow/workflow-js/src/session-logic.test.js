import { test } from "node:test";
import assert from "node:assert/strict";
import {
    appendShellExchange,
    containsBackgroundStatement,
    hasUserVisibleText,
    openingShellScript,
    renderMount,
    renderProgramHelp,
    renderSystemPrompt,
    validateSlug,
    shellResultOf,
    stepWarningThreshold,
    toolError,
    toolOk,
    toolResultMessageValue,
    MAX_TOOL_RESULT_BYTES,
    PACK_SYSTEM_PROMPT,
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

test("renderProgramHelp omits the registered-commands block when there are none", () => {
    const text = renderProgramHelp([]);
    assert.ok(text.includes("Run `help` to list every command"));
    assert.ok(!text.includes("registers these external commands"));
});

test("renderProgramHelp lists each program, with or without a description", () => {
    const text = renderProgramHelp([
        { name: "curl", ffqn: "obelisk-agent:programs/program.curl", description: "fetch a URL" },
        { name: "jira", ffqn: "obelisk-agent:programs/program.jira", description: "" },
    ]);
    assert.ok(text.includes("registers these external commands"));
    assert.ok(text.includes("  curl  fetch a URL\n"));
    assert.ok(text.includes("  jira\n"));
});

test("renderSystemPrompt composes the base prompt, shell help, user-input section, and pack prompt in order", () => {
    const text = renderSystemPrompt("Base instructions.", [{ name: "curl", ffqn: "x", description: "fetch" }]);
    const baseAt = text.indexOf("Base instructions.");
    const shellAt = text.indexOf("# Shell");
    const helpAt = text.indexOf("registers these external commands");
    const userInputAt = text.indexOf("# User input");
    const askUserAt = text.indexOf("ask-user");
    const packAt = text.indexOf(PACK_SYSTEM_PROMPT);
    assert.ok(
        baseAt < shellAt && shellAt < helpAt && helpAt < userInputAt && userInputAt < askUserAt && askUserAt < packAt,
        text,
    );
});

test("renderMount lists the webhook URL only when configured and probes each MCP server", () => {
    const servers = [
        { name: "up", ffqn: "obelisk-agent:mcp/server.up" },
        { name: "down", ffqn: "obelisk-agent:mcp/server.down" },
    ];
    const probe = (ffqn) => (ffqn.endsWith(".down") ? "connection refused\nextra detail" : null);

    const withWebhook = renderMount(servers, "http://target:8080", probe);
    assert.ok(withWebhook.includes("http://target:8080  target Obelisk webhooks"));
    assert.ok(withWebhook.includes("/workspace/mcp/up  MCP server, read-only (responding)"));
    assert.ok(withWebhook.includes("/workspace/mcp/down  MCP server, read-only (not responding: connection refused)"));

    const withoutWebhook = renderMount([], "", probe);
    assert.ok(!withoutWebhook.includes("target Obelisk webhooks"));
});

test("validateSlug enforces the kebab-case shape", () => {
    assert.equal(validateSlug("deploy-triage"), null);
    assert.equal(validateSlug("a"), null);
    assert.equal(validateSlug("a-1"), null);
    assert.notEqual(validateSlug(""), null);
    assert.notEqual(validateSlug("-lead"), null);
    assert.notEqual(validateSlug("trail-"), null);
    assert.notEqual(validateSlug("dou--ble"), null);
    assert.notEqual(validateSlug("Upper"), null);
    assert.notEqual(validateSlug("under_score"), null);
    assert.notEqual(validateSlug("x".repeat(65)), null);
});
