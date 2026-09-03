import { test } from "node:test";
import assert from "node:assert/strict";
import {
    appendShellExchange,
    containsBackgroundStatement,
    hasUserVisibleText,
    openingShellScript,
    parseDurationMs,
    parseToolTimeout,
    renderAppHelp,
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
    assert.ok(text.includes("- `curl`: fetch a URL\n"));
    assert.ok(text.includes("- `jira`\n"));
});

test("renderAppHelp omits the section when there are no apps", () => {
    assert.equal(renderAppHelp([]), "");
    assert.equal(renderAppHelp(undefined), "");
});

test("renderAppHelp lists each app as a markdown bullet, with or without a description", () => {
    const text = renderAppHelp([
        { name: "components", owner: "obeli-sk", repo: "components", ref: "main", description: "reusable Rust activities" },
        { name: "webui", owner: "obeli-sk", repo: "webui", ref: "main", description: "" },
    ]);
    assert.ok(text.includes("# Example apps"));
    assert.ok(text.includes("- `components` (obeli-sk/components@main) - reusable Rust activities\n"));
    assert.ok(text.includes("- `webui` (obeli-sk/webui@main)\n"));
});

test("renderSystemPrompt composes the base prompt, shell help, apps, and the prompt tail in order", () => {
    const promptTail =
        "# User input\n\nask-user stuff\n\n" +
        "# Subagents\n\nchat create [--name slug] stuff\n\n" +
        "# Deployment authoring\n\npack stuff\n\n" +
        "# This session\n\nself section text\n";
    const text = renderSystemPrompt(
        "Base instructions.",
        [{ name: "curl", ffqn: "x", description: "fetch" }],
        [{ name: "components", owner: "obeli-sk", repo: "components", ref: "main", description: "reusable Rust activities" }],
        "Network-backed mounts\n  /workspace/apps/components  example app, read-only (obeli-sk/components@0123456789abcdef0123456789abcdef01234567)\n",
        promptTail,
    );
    const baseAt = text.indexOf("Base instructions.");
    const shellAt = text.indexOf("# Shell");
    const helpAt = text.indexOf("registers these external commands");
    const appsAt = text.indexOf("# Example apps");
    const appEntryAt = text.indexOf("- `components` (obeli-sk/components@main) - reusable Rust activities");
    const mountsAt = text.indexOf("# Mounts at session start");
    const pinnedMountAt = text.indexOf("components@0123456789abcdef0123456789abcdef01234567");
    const userInputAt = text.indexOf("# User input");
    const askUserAt = text.indexOf("ask-user");
    const subagentsAt = text.indexOf("# Subagents");
    const chatCreateAt = text.indexOf("chat create [--name slug]");
    const packAt = text.indexOf("# Deployment authoring");
    const selfAt = text.indexOf("# This session");
    const selfTextAt = text.indexOf("self section text");
    assert.ok(
        baseAt < shellAt && shellAt < helpAt && helpAt < appsAt && appsAt < appEntryAt &&
        appEntryAt < mountsAt && mountsAt < pinnedMountAt && pinnedMountAt < userInputAt && userInputAt < askUserAt &&
        askUserAt < subagentsAt && subagentsAt < chatCreateAt && chatCreateAt < packAt &&
        packAt < selfAt && selfAt < selfTextAt,
        text,
    );
});

test("renderMount lists apps and the webhook URL only when configured, and probes each MCP server", () => {
    const apps = [{ name: "components", owner: "obeli-sk", repo: "components", ref: "main" }];
    const servers = [
        { name: "up", ffqn: "obelisk-agent:mcp/server.up" },
        { name: "down", ffqn: "obelisk-agent:mcp/server.down" },
    ];
    const probe = (ffqn) => (ffqn.endsWith(".down") ? "connection refused\nextra detail" : null);

    const withWebhook = renderMount(apps, servers, "http://target:8080", probe);
    assert.ok(withWebhook.includes("/workspace/apps/components  "));
    assert.ok(withWebhook.includes("(obeli-sk/components@main)"));
    assert.ok(withWebhook.includes("http://target:8080  target Obelisk webhooks"));
    assert.ok(withWebhook.includes("/workspace/mcp/up  MCP server, read-only (responding)"));
    assert.ok(withWebhook.includes("/workspace/mcp/down  MCP server, read-only (not responding: connection refused)"));

    const withoutWebhook = renderMount([], [], "", probe);
    assert.ok(!withoutWebhook.includes("target Obelisk webhooks"));
});

test("renderMount shows the pinned commit once an app's mount has resolved one", () => {
    const apps = [{ name: "components", owner: "obeli-sk", repo: "components", ref: "main" }];
    const out = renderMount(apps, [], "", () => null);
    assert.ok(out.includes("(obeli-sk/components@main)"), out);

    apps[0].resolvedRef = "0123456789abcdef0123456789abcdef01234567";
    const pinned = renderMount(apps, [], "", () => null);
    assert.ok(pinned.includes("(obeli-sk/components@0123456789abcdef0123456789abcdef01234567)"), pinned);
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

test("parseDurationMs accepts sleep-style forms and composites", () => {
    assert.equal(parseDurationMs("30s"), 30_000);
    assert.equal(parseDurationMs("500ms"), 500);
    assert.equal(parseDurationMs("5m"), 300_000);
    assert.equal(parseDurationMs("2h"), 7_200_000);
    assert.equal(parseDurationMs("1m30s"), 90_000);
    assert.equal(parseDurationMs("5"), 5_000);
    assert.throws(() => parseDurationMs(""));
    assert.throws(() => parseDurationMs("abc"));
    assert.throws(() => parseDurationMs("5x"));
});

test("parseToolTimeout treats an absent or blank value as no watchdog", () => {
    assert.equal(parseToolTimeout(undefined), null);
    assert.equal(parseToolTimeout(null), null);
    assert.equal(parseToolTimeout(""), null);
    assert.equal(parseToolTimeout("  "), null);
    assert.equal(parseToolTimeout("30s"), 30_000);
    assert.throws(() => parseToolTimeout(5));
    assert.throws(() => parseToolTimeout("0s"));
});
